// 図解 Linux のページキャッシュとディスク I/O（15 章）。mm.js の後に読み込む。API は kernel.js の先頭コメントを見る。
//
// ■ ディスク（/dev/sda1 = / の ext4）は遅い装置：1 ページ（4 KiB）読むのに 5 ms、書くのに 5 ms かかる（仮想時間）。待つあいだプロセスは状態 D（ディスク待ち）になる。
//   /tmp などの tmpfs、/proc、/dev はディスクを使わない（いつも速い）。
// ■ 通常ファイルの読み書きはページキャッシュを通る（k.fileRead / k.fileWrite を差し替えている）。
//   読む：キャッシュにあれば速い（hit）。なければディスクから読んでキャッシュに入れる（miss。ページあたり 5 ms 待つ）。
//   書く：キャッシュのページを書き換えて「ダーティ」の印をつけるだけで、すぐ戻る。ディスクには後で書く（書き戻し）。
//   書き戻しが起きるとき：sync（全部）、fsync(fd)（そのファイル）、ダーティになってから 30 秒たった後の 5 秒ごとの見回り（/proc/sys/vm/dirty_expire_centisecs と
//   dirty_writeback_centisecs で変えられる）、メモリが足りなくなったとき。sync と fsync は、書き終わるまで呼んだプロセスを待たせる。
//   キャッシュのフレームは物理メモリ（mm.js）から取る。メモリが足りなくなると、きれいな（ダーティでない）ページから捨てる。
//   echo 1 > /proc/sys/vm/drop_caches（3 でも同じ）で、きれいなページを全部捨てる（ダーティなページは捨てられない。先に sync する）。
// ■ 電源断：reboot -f -f（または echo b > /proc/sysrq-trigger）は sync せずに再起動する。まだ書き戻していないデータは消える。
//   ファイルの名前・作成・削除・大きさを 0 にする操作（メタデータ）はすぐディスクに書かれる扱い。新しく作って書いたファイルは、電源断の後「空のファイル」として残る。
// ■ 見えるもの：/proc/meminfo の Cached / Dirty / Writeback、free の buff/cache、/usr/bin/time -v の File system inputs / outputs と Major page faults、
//   ps の STAT の D、コマンド dd、fincore（ファイルのうちキャッシュにあるページ数）、sync。sys.pagecache() → { cached, dirty, writeback, files: [{ ino, path, size, pages, cached, dirty, writeback }] }
// ■ events（run の opts.trace に 'pagecache'）：
//     { type: 'hit',  pid, ino, path, page }            キャッシュにあった
//     { type: 'miss', pid, ino, path, page, ms }        なかったのでディスクから読んだ（ms だけ待つ）
//     { type: 'dirty', pid, ino, path, page }           キャッシュのページに書いた（まだディスクには書いていない）
//     { type: 'writeback', ino, path, pages, reason: 'sync' | 'fsync' | 'expire' | 'reclaim', ms }   書き戻しを始めた（ms 後に終わる）
//     { type: 'clean', ino, path, pages }               書き戻しが終わった
//     { type: 'drop', pages, reason: 'drop_caches' | 'reclaim' | 'truncate' }   キャッシュから捨てた
//     { type: 'lost', ino, path, bytes }                電源断で、書き戻していない変更が消えた（これは trace がなくても events には出ないので、dmesg を見る）
(function (root) {
  'use strict';
  const LNX = root.LNX, E = LNX.ERRNO, sys = LNX.sys, U = LNX.util, O = LNX.O, strerror = LNX.strerror;
  const { P } = LNX.binutil;
  const dec = U.dec, enc = U.enc;
  const PG = 4096, CACHE = 2;

  LNX.kernel.plugin('pagecache', (k) => {
    const mm = k.sub.mm;
    const pc = { cfg: { readMs: 5, writeMs: 5, expire: 30000, interval: 5000 }, cached: 0, dirty: 0, writeback: 0, lru: new Map(), inodes: new Set(), busyUntil: 0, hits: 0, misses: 0 };
    const backed = (ino) => ino.fs === k.rootfs && !ino.dyn;
    const st = (ino) => ino.pc || (ino.pc = { pages: new Map(), dirty: new Set(), disk: undefined, flushing: null, timer: null });
    const nameOf = (ino) => (ino.pcName ? dec(ino.pcName) : '');
    const tr = () => k.tracing('pagecache');
    const openInode0 = k.openInode;
    k.openInode = function (p, ino, flags, path) { if (ino.type === 'f' && ino.fs === k.rootfs && path) ino.pcName = path; return openInode0.call(this, p, ino, flags, path); };

    function insert(ino, s, idx, p) {
      const f = mm ? mm.allocFrame(CACHE, p) : -1;
      if (f < 0) return f;
      s.pages.set(idx, f); pc.cached++; pc.lru.set(f, { ino, idx }); pc.inodes.add(ino);
      return f;
    }
    function evict(ino, s, idx) {
      const f = s.pages.get(idx);
      if (f === undefined) return;
      s.pages.delete(idx); pc.lru.delete(f); pc.cached--;
      if (s.dirty.delete(idx)) pc.dirty--;
      if (mm) { if (mm.ref[f] > 0) { for (const q of k.procs.values()) if (q.mm) for (const [vpn, pte] of q.mm.pt) if ((pte & 4) && Math.floor(pte / 8) === f) { q.mm.pt.delete(vpn); q.mm.rss--; } } mm.freeFrame(f); }
      if (!s.pages.size && s.disk === undefined && !s.flushing) pc.inodes.delete(ino);
    }
    // ページを用意する（なければディスクから読む）。{ frame, miss }
    function getPage(ino, idx, p) {
      const s = st(ino);
      let f = s.pages.get(idx);
      if (f !== undefined) { pc.hits++; pc.lru.delete(f); pc.lru.set(f, { ino, idx }); if (tr()) k.tev('pagecache', 'hit', { pid: p ? p.pid : 0, ino: ino.ino, path: nameOf(ino), page: idx }); return { frame: f, miss: false }; }
      f = insert(ino, s, idx, p);
      pc.misses++;
      if (p && p.pid) { p.inblock += 8; k.delay(p, pc.cfg.readMs); }
      if (tr()) k.tev('pagecache', 'miss', { pid: p ? p.pid : 0, ino: ino.ino, path: nameOf(ino), page: idx, ms: pc.cfg.readMs });
      return { frame: f, miss: true };
    }
    function arm(ino, s) {
      if (s.timer || !s.dirty.size) return;
      const iv = pc.cfg.interval, at = Math.ceil((k.clock + pc.cfg.expire) / iv) * iv;
      s.timer = k.timer(at, () => { s.timer = null; if (s.dirty.size) flush(ino, 'expire', null); }, true);
    }
    function markDirty(ino, idx, p) {
      const s = st(ino);
      if (s.disk === undefined && !s.flushing && !s.dirty.size) s.disk = ino.data;
      if (!s.pages.has(idx)) insert(ino, s, idx, p);
      if (s.pages.has(idx) && !s.dirty.has(idx)) { s.dirty.add(idx); pc.dirty++; pc.inodes.add(ino); if (p && p.pid) p.oublock += 8; }
      if (tr()) k.tev('pagecache', 'dirty', { pid: p ? p.pid : 0, ino: ino.ino, path: nameOf(ino), page: idx });
      arm(ino, s);
    }
    // 書き戻し。終わる時刻を返す（ディスクは 1 つなので順番に書く）
    function flush(ino, reason, p, now) {
      const s = ino.pc;
      if (!s || !s.dirty.size) return s && s.flushing ? s.flushing.end : k.clock;
      const n = s.dirty.size;
      s.dirty.clear(); pc.dirty -= n;
      if (s.timer) { k.cancelTimer(s.timer); s.timer = null; }
      const done = (fl) => {
        if (fl) { pc.writeback -= fl.n; s.flushing = null; }
        s.disk = !s.dirty.size && ino.data === (fl ? fl.snap : ino.data) ? undefined : (fl ? fl.snap : ino.data);
        if (s.disk === undefined && !s.pages.size) pc.inodes.delete(ino);
        if (tr()) k.tev('pagecache', 'clean', { ino: ino.ino, path: nameOf(ino), pages: n });
      };
      if (now) { if (tr()) k.tev('pagecache', 'writeback', { ino: ino.ino, path: nameOf(ino), pages: n, reason, ms: 0 }); if (s.flushing) { k.cancelTimer(s.flushing.timer); pc.writeback -= s.flushing.n; s.flushing = null; } done(null); return k.clock; }
      const start = Math.max(k.clock, pc.busyUntil, s.flushing ? s.flushing.end : 0), end = start + n * pc.cfg.writeMs;
      pc.busyUntil = end; pc.writeback += n;
      if (s.flushing) { k.cancelTimer(s.flushing.timer); pc.writeback -= s.flushing.n; }
      const fl = s.flushing = { snap: ino.data, n, end, timer: null };
      fl.timer = k.timer(end, () => done(fl), true);
      if (tr()) k.tev('pagecache', 'writeback', { ino: ino.ino, path: nameOf(ino), pages: n, reason, ms: end - k.clock });
      return end;
    }
    function flushAll(reason, p, now) { let end = k.clock; for (const ino of Array.from(pc.inodes)) { const s = ino.pc; if (s && (s.dirty.size || s.flushing)) end = Math.max(end, flush(ino, reason, p, now)); } return end; }

    const read0 = k.fileRead, write0 = k.fileWrite;
    k.fileRead = function (ino, pos, n, p) {
      const d = read0.call(this, ino, pos, n, p);
      if (typeof d !== 'string' || d === '' || !backed(ino)) return d;
      const s = st(ino), a = Math.floor(pos / PG), b = Math.floor((pos + d.length - 1) / PG);
      let miss = 0;
      const t = tr();
      for (let i = a; i <= b; i++) {
        const f = s.pages.get(i);
        if (f !== undefined) { pc.hits++; if (a === b) { pc.lru.delete(f); pc.lru.set(f, { ino, idx: i }); } if (t) k.tev('pagecache', 'hit', { pid: p ? p.pid : 0, ino: ino.ino, path: nameOf(ino), page: i }); } else { insert(ino, s, i, p); miss++; pc.misses++; if (t) k.tev('pagecache', 'miss', { pid: p ? p.pid : 0, ino: ino.ino, path: nameOf(ino), page: i, ms: pc.cfg.readMs }); }
      }
      if (miss && p && p.pid) { p.inblock += 8 * miss; k.delay(p, miss * pc.cfg.readMs); }
      return d;
    };
    k.fileWrite = function (ino, pos, data, p) {
      if (!backed(ino)) return write0.call(this, ino, pos, data, p);
      const s = st(ino), old = ino.size;
      if (s.disk === undefined && !s.flushing && !s.dirty.size) s.disk = ino.data;
      const r = write0.call(this, ino, pos, data, p);
      if (!(r > 0)) { if (!s.dirty.size && !s.flushing && s.disk === ino.data) s.disk = undefined; return r; }
      const a = Math.floor(pos / PG), b = Math.floor((pos + r - 1) / PG);
      let miss = 0;
      for (let i = a; i <= b; i++) {
        // ページの一部だけを書き換えるときは、先に元の中身を読む必要がある
        if (!s.pages.has(i) && i * PG < old && (pos > i * PG || pos + r < Math.min(old, (i + 1) * PG))) { miss++; pc.misses++; if (tr()) k.tev('pagecache', 'miss', { pid: p ? p.pid : 0, ino: ino.ino, path: nameOf(ino), page: i, ms: pc.cfg.readMs }); }
        markDirty(ino, i, p);
      }
      if (miss && p && p.pid) { p.inblock += 8 * miss; k.delay(p, miss * pc.cfg.readMs); }
      return r;
    };
    k.on('truncate', (ino) => {
      const s = ino.pc; if (!s) return;
      const keep = Math.ceil(ino.size / PG);
      let n = 0;
      for (const idx of Array.from(s.pages.keys())) if (idx >= keep) { evict(ino, s, idx); n++; }
      if (s.disk !== undefined) s.disk = s.disk.length > ino.size ? s.disk.slice(0, ino.size) : s.disk;   // 大きさを縮めるのはメタデータなので、すぐディスクに反映される
      if (s.flushing && s.flushing.snap.length > ino.size) s.flushing.snap = s.flushing.snap.slice(0, ino.size);
      if (n && tr()) k.tev('pagecache', 'drop', { pages: n, reason: 'truncate', ino: ino.ino, path: nameOf(ino) });
    });
    k.on('inodeFree', (ino) => {
      const s = ino.pc; if (!s) return;
      for (const idx of Array.from(s.pages.keys())) evict(ino, s, idx);
      if (s.timer) k.cancelTimer(s.timer);
      if (s.flushing) { k.cancelTimer(s.flushing.timer); pc.writeback -= s.flushing.n; }
      pc.inodes.delete(ino); ino.pc = null;
    });
    k.on('fsync', (ino, p) => { if (!backed(ino)) return; const end = flush(ino, 'fsync', p); if (p && end > k.clock) k.delay(p, end - k.clock); });
    k.on('sync', (p) => { const end = flushAll('sync', p); if (p && end > k.clock) k.delay(p, end - k.clock); });
    // きれいで、どのプロセスにも写されていないページを古い順に捨てる
    function dropClean(max, reason) {
      let n = 0;
      for (const [f, e] of Array.from(pc.lru)) {
        if (n >= max) break;
        const s = e.ino.pc;
        if (!s || s.dirty.has(e.idx) || (mm && mm.ref[f] > 0)) continue;
        evict(e.ino, s, e.idx); n++;
      }
      if (n && tr()) k.tev('pagecache', 'drop', { pages: n, reason });
      return n;
    }
    if (mm) mm.shrinkers.push((n) => { let got = dropClean(n, 'reclaim'); if (!got && pc.dirty) { flushAll('reclaim', null, true); got = dropClean(n, 'reclaim'); } return got; });
    // 電源断・再起動：書き戻していない変更は消える
    k.on('shutdown', () => {
      let lost = 0;
      for (const ino of Array.from(pc.inodes)) {
        const s = ino.pc;
        if (s && s.disk !== undefined && ino.nlink > 0 && s.disk !== ino.data) { lost++; k.setData(ino, s.disk); }
        ino.pc = null;
      }
      pc.lost = lost;
    });
    // 起動時に、/usr/bin・/usr/sbin・/usr/lib のファイルは読み込み済みとする（先読み）。コマンドの最初の実行でディスクを待たない。
    // drop_caches で捨てれば、次の実行はディスクから読み直す（/usr/bin/time -v の Major page faults と File system inputs で見える）
    for (const d of ['/usr/bin', '/usr/sbin', '/usr/lib']) { const dir = k.namei(k.kcred, d); if (typeof dir === 'number' || !dir.ents) continue; for (const [name, ino] of dir.ents) if (ino.type === 'f') { ino.pcName = d + '/' + name; const s = st(ino), n = Math.ceil(ino.size / PG); for (let i = 0; i < n; i++) if (!s.pages.has(i)) insert(ino, s, i, null); } }
    pc.getPage = getPage; pc.markDirty = markDirty; pc.flushAll = flushAll; pc.dropClean = dropClean;
    pc.stats = () => ({ cached: pc.cached, dirty: pc.dirty, writeback: pc.writeback });
    pc.info = (ino) => { const s = ino.pc; return { pages: Math.ceil(ino.size / PG), cached: s ? s.pages.size : 0, dirty: s ? s.dirty.size : 0, writeback: s && s.flushing ? s.flushing.n : 0, list: s ? Array.from(s.pages.keys()).sort((a, b) => a - b) : [] }; };
    const root0 = (p) => (p.euid === 0 ? 0 : -E.EACCES);
    k.procfs.reg('sys/vm/drop_caches', { mode: 0o200, read: () => '0\n', write: (k2, p, d) => { if (p.euid !== 0) return -E.EACCES; const v = d.trim(); if (!/^[123]$/.test(v)) return -E.EINVAL; if (v !== '2') { const n = dropClean(Infinity, 'drop_caches'); k.printk((p.comm || 'sh') + ' (' + p.pid + '): drop_caches: ' + v, 6); void n; } } });
    k.procfs.reg('sys/vm/dirty_expire_centisecs', { read: () => pc.cfg.expire / 10 + '\n', write: (k2, p, d) => { const r = root0(p); if (r < 0) return r; const n = parseInt(d, 10); if (!(n >= 0)) return -E.EINVAL; pc.cfg.expire = n * 10; } });
    k.procfs.reg('sys/vm/dirty_writeback_centisecs', { read: () => pc.cfg.interval / 10 + '\n', write: (k2, p, d) => { const r = root0(p); if (r < 0) return r; const n = parseInt(d, 10); if (!(n >= 1)) return -E.EINVAL; pc.cfg.interval = n * 10; } });
    // mincore(番地, 長さ) → 各ページがメモリにあるか（0 / 1 の配列）。fincore が使う
    k.defsys('mincore', (k2, p, a) => {
      const m = p.mm, addr = +a[0] || 0, len = +a[1] || 0, out = [];
      if (!m || addr % PG) return -E.EINVAL;
      for (let x = addr; x < addr + len; x += PG) {
        const v = mm.findVma(m, x);
        if (!v) return -E.ENOMEM;
        out.push(v.ino ? (v.ino.pc && v.ino.pc.pages.has((v.off + (x - v.start)) / PG) ? 1 : 0) : (m.pt.has(x / PG) ? 1 : 0));
      }
      return out;
    }, (a) => '0x' + (+a[0]).toString(16) + ', ' + a[1] + ', [...]', () => '0');
    return pc;
  });

  LNX.kernel.M.pagecache = function () {
    const k = this.k, pc = k.sub.pagecache, files = [];
    for (const ino of pc.inodes) { const i = pc.info(ino); files.push({ ino: ino.ino, path: ino.pcName ? dec(ino.pcName) : '', size: ino.size, pages: i.pages, cached: i.cached, dirty: i.dirty, writeback: i.writeback, list: i.list }); }
    files.sort((a, b) => a.ino - b.ino);
    return { cached: pc.cached, dirty: pc.dirty, writeback: pc.writeback, hits: pc.hits, misses: pc.misses, readMs: pc.cfg.readMs, writeMs: pc.cfg.writeMs, expire: pc.cfg.expire, interval: pc.cfg.interval, files };
  };
  // 電源を突然切る（sync しない）。書き戻していないデータは消える。機械は起動し直す
  LNX.kernel.M.powerCut = function () { this.k.rebootReq = { mode: 'restart', crash: true }; this._reboot(null); this.log.push({ t: 'powercut' }); };
  const replay0 = LNX.kernel.M._replay;
  LNX.kernel.M._replay = function (log) { for (const e of log) { if (e.t === 'powercut') { this.k.rebootReq = { mode: 'restart', crash: true }; this._reboot(null); this.log.push(e); } else replay0.call(this, [e]); } };

  // ── コマンド ──
  const L = { late: true };
  const parseN = (s) => { const m = /^(\d+)([a-zA-Z]*)$/.exec(s || ''); if (!m) return NaN; const u = { '': 1, c: 1, w: 2, b: 512, k: 1024, K: 1024, kB: 1000, KB: 1000, KiB: 1024, M: 1048576, MB: 1000000, MiB: 1048576, G: 1073741824, GB: 1e9, GiB: 1073741824 }[m[2]]; return u ? +m[1] * u : NaN; };
  // GNU dd と同じ「16 kB, 16 KiB」の形
  const siStr = (n, base, units) => { let i = 0, v = n; while (v >= base && i < units.length - 1) { v /= base; i++; } if (i === 0) return null; return (v < 9.95 ? (Math.round(v * 10) / 10).toFixed(1) : String(Math.round(v))) + ' ' + units[i]; };
  const ddHuman = (n) => { const a = siStr(n, 1000, ['B', 'kB', 'MB', 'GB']), b = siStr(n, 1024, ['B', 'KiB', 'MiB', 'GiB']); return n + (n === 1 ? ' byte' : ' bytes') + (a ? ' (' + a + (b && n >= 1024 ? ', ' + b : '') + ')' : ''); };
  const gfmt = (x) => { if (x === 0) return '0'; const e = Math.floor(Math.log10(Math.abs(x))); if (e < -4 || e >= 6) { const [m, ex] = x.toExponential(5).split('e'); return m.replace(/\.?0+$/, '') + 'e' + (ex[0] === '-' ? '-' : '+') + ex.slice(1).padStart(2, '0'); } return String(Number(x.toPrecision(6))); };
  const rate = (bps) => { const u = ['B/s', 'kB/s', 'MB/s', 'GB/s']; let i = 0; while (bps >= 1000 && i < 3) { bps /= 1000; i++; } return (i === 0 || bps >= 10 ? String(Math.round(bps)) : (Math.round(bps * 10) / 10).toFixed(1)) + ' ' + u[i]; };
  P('dd', 'ブロック単位でデータを写す。終わると、写した量とかかった時間を標準エラーに表示する', 'dd [if=入力] [of=出力] [bs=大きさ] [count=回数] [skip=N] [seek=N] [conv=fsync,notrunc] [oflag=sync,append] [status=none]', function* (c) {
    const o = { bs: 512 };
    for (const a of c.argv.slice(1)) {
      const eq = a.indexOf('='), kk = eq < 0 ? a : a.slice(0, eq), v = eq < 0 ? '' : a.slice(eq + 1);
      if (['if', 'of', 'conv', 'oflag', 'iflag', 'status'].includes(kk) && eq >= 0) o[kk] = v;
      else if (['bs', 'ibs', 'obs', 'count', 'skip', 'seek'].includes(kk) && eq >= 0) { const n = parseN(v); if (isNaN(n) || (kk.endsWith('bs') && n === 0)) { c.err('dd: invalid number: ' + "'" + v + "'" + '\n'); return 1; } o[kk === 'ibs' || kk === 'obs' ? 'bs' : kk] = n; } else { c.err('dd: unrecognized operand ' + "'" + a + "'" + "\nTry 'dd --help' for more information.\n"); return 1; }
    }
    const conv = (o.conv || '').split(',').filter(Boolean), oflag = (o.oflag || '').split(',').filter(Boolean);
    let ifd = 0, ofd = 1;
    if (o.if !== undefined) { ifd = yield sys.open(o.if, O.RDONLY); if (ifd < 0) { c.err('dd: failed to open ' + "'" + o.if + "'" + ': ' + strerror(ifd) + '\n'); return 1; } }
    if (o.of !== undefined) { ofd = yield sys.open(o.of, O.WRONLY | O.CREAT | (conv.includes('notrunc') || o.seek || oflag.includes('append') ? 0 : O.TRUNC) | (oflag.includes('append') ? O.APPEND : 0), 0o666); if (ofd < 0) { c.err('dd: failed to open ' + "'" + o.of + "'" + ': ' + strerror(ofd) + '\n'); return 1; } }
    const t0 = yield sys.time();
    if (o.skip) { const r = yield sys.lseek(ifd, o.skip * o.bs, 0); if (r < 0) { let left = o.skip * o.bs; while (left > 0) { const d = yield sys.read(ifd, Math.min(left, o.bs)); if (typeof d !== 'string' || d === '') break; left -= d.length; } } }
    if (o.seek) yield sys.lseek(ofd, o.seek * o.bs, 0);
    let fin = 0, pin = 0, fout = 0, pout = 0, bytes = 0, rc = 0;
    for (let i = 0; o.count === undefined || i < o.count; i++) {
      const d = yield sys.read(ifd, o.bs);
      if (typeof d === 'number') { if (d === -E.EINTR) { i--; continue; } c.err('dd: error reading ' + "'" + (o.if || 'standard input') + "'" + ': ' + strerror(d) + '\n'); rc = 1; break; }
      if (d === '') break;
      if (d.length === o.bs) fin++; else pin++;
      let off = 0, bad = 0;
      while (off < d.length) { const w = yield sys.write(ofd, off ? d.slice(off) : d); if (w < 0) { if (w === -E.EINTR) continue; bad = w; break; } off += w; }
      bytes += off;
      if (bad) { c.err('dd: error writing ' + "'" + (o.of || 'standard output') + "'" + ': ' + strerror(bad) + '\n'); rc = 1; if (off) pout++; break; }
      if (d.length === o.bs) fout++; else pout++;
      if (oflag.includes('sync') || oflag.includes('dsync')) yield sys.fsync(ofd);
    }
    if (conv.includes('fsync') || conv.includes('fdatasync')) yield sys.fsync(ofd);
    const el = (yield sys.time()) - t0;
    if (o.status !== 'none') {
      c.err(fin + '+' + pin + ' records in\n' + fout + '+' + pout + ' records out\n');
      if (o.status !== 'noxfer') c.err(ddHuman(bytes) + ' copied, ' + gfmt(el / 1000) + ' s, ' + (el > 0 ? rate((bytes * 1000) / el) : 'Infinity B/s') + '\n');
    }
    return rc;
  }, L);
  P('fincore', 'ファイルのうち、いまページキャッシュに載っている量を表示する', 'fincore ファイル…', function* (c) {
    const files = c.argv.slice(1).filter((a) => a[0] !== '-');
    if (!files.length) { c.err('fincore: no file specified\n'); return 1; }
    const rows = [];
    let rc = 0;
    const hs = (n) => (n === 0 ? '0B' : LNX.binutil.human(n) + (n < 1024 ? 'B' : ''));
    for (const f of files) {
      const fd = yield sys.open(f, O.RDONLY);
      if (fd < 0) { c.err('fincore: failed to open: ' + f + ': ' + strerror(fd) + '\n'); rc = 1; continue; }
      const st = yield sys.fstat(fd);
      let n = 0;
      if (st.size > 0) { const addr = yield sys.mmap(0, st.size, 1, 1, fd, 0); if (addr > 0) { const v = yield sys.mincore(addr, st.size); if (Array.isArray(v)) n = v.reduce((s, x) => s + x, 0); yield sys.munmap(addr, st.size); } }
      yield sys.close(fd);
      rows.push([hs(n * PG), String(n), hs(st.size), f]);
    }
    if (rows.length) { const w = [0, 1, 2].map((i) => Math.max(['RES', 'PAGES', 'SIZE'][i].length, ...rows.map((r) => r[i].length))); for (const r of [['RES', 'PAGES', 'SIZE', 'FILE']].concat(rows)) c.out(r[0].padStart(w[0]) + ' ' + r[1].padStart(w[1]) + ' ' + r[2].padStart(w[2]) + ' ' + r[3] + '\n'); }
    return rc;
  }, L);
  LNX.SYSJA.mincore = 'メモリの領域の各ページが、物理メモリに載っているかを調べる';
})(typeof window !== 'undefined' ? window : globalThis);
