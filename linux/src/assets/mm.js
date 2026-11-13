// 図解 Linux の仮想メモリ（13 章）。sched.js の後に読み込む。API は kernel.js の先頭コメントを見る。
//
// ■ 物理メモリ：64 MiB = 16384 フレーム（1 フレーム = 4 KiB）。先頭の 1536 フレーム（6 MiB）はカーネル用で、残り 14848 フレーム（MemTotal 59392 kB）を
//   プロセスの匿名ページ（anon）とページキャッシュ（cache。pagecache.js）が使う。空きがなくなると、まずきれいなキャッシュを捨て、それでも足りなければ OOM killer が
//   RSS のいちばん大きいプロセスを SIGKILL する（dmesg に記録）。スワップはない。
// ■ アドレス空間：プロセスごとに p.mm = { vmas, pt, brk, … }。execve のたびに作り直す（番地は毎回同じ。ASLR はない）。
//     555555554000  プログラムの text（r-xp）/ rodata（r--p）/ data（rw-p）   … 実行ファイルを写したもの
//     その直後       [heap]（brk で伸びる。最初は 132 KiB）
//     7ffff7d8a000  libc.so.6 の text / rodata / data。mmap した領域はこの下に、上から順に置く
//     7ffff7fc1000  [vdso]
//     7ffffffde000  [stack]（132 KiB。下に伸びる。最大 8 MiB）
//   ページ表 pt は Map（仮想ページ番号 → PTE）。PTE = フレーム番号 × 8 + 印（1 = 書ける、2 = コピーオンライト、4 = ページキャッシュのフレーム）。
//   mmap / brk しただけではフレームを割り当てない。最初に触ったとき（ページフォルト）に割り当てる（minor。ディスクから読むなら major）。
//   fork はページ表だけを複製して、書けるページを両方とも「読み取り専用 + コピーオンライト」にする。書いた側がフォルトして、そのページだけ複製する。
// ■ システムコール：brk(番地 | 0) → 新しい brk、mmap(番地, 長さ, prot, flags, fd, オフセット) → 番地、munmap(番地, 長さ)、mprotect(番地, 長さ, prot)。
//   定数は LNX.MM（PROT_READ = 1、PROT_WRITE = 2、PROT_EXEC = 4、MAP_SHARED = 1、MAP_PRIVATE = 2、MAP_FIXED = 0x10、MAP_ANONYMOUS = 0x20）。
//   プログラムがメモリに触る（本物では機械語の命令。ここではシステムコールの形だが strace には出ない）：
//     yield sys.touch(番地, 長さ)   読む。       yield sys.wtouch(番地, 長さ)   書く。   → 起きたページフォルトの回数。領域の外なら SIGSEGV
//     yield sys.peek(番地, n) → バイト列      yield sys.poke(番地, バイト列)        中身を読み書きする（ファイルを写した領域ならファイルの中身）
// ■ 見えるもの：/proc/PID/maps、/proc/PID/status の Vm* と Rss*、/proc/PID/stat の 23・24 番目（ps の VSZ / RSS）、/proc/meminfo、/proc/PID/oom_score、
//   /proc/sys/vm/overcommit_memory（0 のみ）。コマンド：free、memtouch、memfork、memhog、mmapcat、pmap、time（/usr/bin/time -v でページフォルトの回数）。
//   sys.mem() → { totalFrames, reserved, free, anon, cache, kB: {…} }、sys.vm(pid) → { vmas: [...], pages: [...], vsz, rss, minflt, majflt, brk }
// ■ events（run の opts.trace に 'mem'）：
//     { type: 'fault', pid, addr, vpn, kind: 'minor' | 'major', write, area: '[heap]'…, frame, file }   ページフォルトでフレームを割り当てた・写した
//     { type: 'cow',   pid, addr, vpn, from, frame, copied }      コピーオンライト（copied = false なら、共有相手がもういなかったので複製せず書けるようにしただけ）
//     { type: 'alloc', pid, op: 'mmap' | 'brk' | 'exec', addr, len, area }     仮想メモリの領域が増えた（フレームはまだ割り当てない）
//     { type: 'free',  pid, op: 'munmap' | 'brk' | 'exit' | 'exec', pages, frames }   領域を返した（frames = 実際に空いたフレームの数）
//     { type: 'forkmm', pid, child, pages }                       fork でページ表を複製した（pages 枚がコピーオンライトになった）
//     { type: 'oom', pid, comm, rss, by, cgroup }                 OOM killer が pid を殺した（これは trace がなくても events に出る）
(function (root) {
  'use strict';
  const LNX = root.LNX, E = LNX.ERRNO, sys = LNX.sys, U = LNX.util, SIG = LNX.SIG, O = LNX.O, strerror = LNX.strerror;
  const { P, isErr } = LNX.binutil;
  const enc = U.enc, dec = U.dec;
  const PG = 4096, TOTAL = 16384, RESERVED = 1536;
  const FREE = 0, ANON = 1, CACHE = 2, KERN = 3;
  const PW = 1, PCOW = 2, PFILE = 4;
  const MM = { PROT_NONE: 0, PROT_READ: 1, PROT_WRITE: 2, PROT_EXEC: 4, MAP_SHARED: 1, MAP_PRIVATE: 2, MAP_FIXED: 0x10, MAP_ANONYMOUS: 0x20, PAGE: PG };
  const TEXT_BASE = 0x555555554000, LIBC_BASE = 0x7ffff7d8a000, VDSO = 0x7ffff7fc1000, STACK_TOP = 0x7ffffffff000, STACK_PAGES = 33, STACK_MAX = 2048, HEAP_PAGES = 33;
  const hex = (n) => n.toString(16);
  const hx = (n) => '0x' + n.toString(16);
  const pages = (len) => Math.ceil(len / PG);
  const ZERO = '\0'.repeat(PG);

  function findVma(mm, addr) { const v = mm.vmas; for (let i = 0; i < v.length; i++) if (addr >= v[i].start && addr < v[i].end) return v[i]; return null; }
  function addVma(mm, vma) { const v = mm.vmas; let i = 0; while (i < v.length && v[i].start < vma.start) i++; v.splice(i, 0, vma); return vma; }
  const permStr = (v) => (v.prot & 1 ? 'r' : '-') + (v.prot & 2 ? 'w' : '-') + (v.prot & 4 ? 'x' : '-') + (v.shared ? 's' : 'p');
  const vsize = (mm) => { let n = 0; for (const v of mm.vmas) n += v.end - v.start; return n; };

  LNX.kernel.plugin('mm', (k) => {
    const st = { total: TOTAL, reserved: RESERVED, next: RESERVED, freeList: [], anon: 0, cache: 0, kind: new Uint8Array(TOTAL), ref: new Uint16Array(TOTAL), data: new Map(), fcg: new Map(), shrinkers: [], oomKills: 0, MM };
    st.kind.fill(KERN, 0, RESERVED);
    st.nfree = () => TOTAL - st.next + st.freeList.length;
    const pc = () => k.sub.pagecache;

    // ── フレーム ──
    function oom(p, cg) {
      let victim = null, best = -1;
      for (const q of k.procs.values()) {
        if (q.pid === 1 || !q.mm || q.state === 'Z') continue;
        if (cg) { let g = q.cg, inside = false; for (; g; g = g.parent) if (g === cg) { inside = true; break; } if (!inside) continue; }
        const score = q.mm.rss + (q.oomAdj || 0) * (TOTAL - RESERVED) / 1000;
        if ((q.oomAdj || 0) <= -1000) continue;
        if (score > best) { best = score; victim = q; }
      }
      if (!victim) return false;
      const m = victim.mm, kb = (n) => n * 4;
      k.printk((p ? p.comm : 'kswapd0') + ' invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=' + ((p && p.oomAdj) || 0), 4);
      if (cg) k.printk('memory: usage ' + kb(cg.memCur) + 'kB, limit ' + (cg.memMax === Infinity ? 'max' : kb(cg.memMax) + 'kB') + ', failcnt ' + (++cg.failcnt), 6);
      else k.printk('Mem-Info: free:' + st.nfree() + ' anon:' + st.anon + ' file:' + st.cache + ' (pages)', 4);
      k.printk((cg ? 'Memory cgroup out of memory' : 'Out of memory') + ': Killed process ' + victim.pid + ' (' + victim.comm + ') total-vm:' + vsize(m) / 1024 + 'kB, anon-rss:' + kb(m.rssAnon) + 'kB, file-rss:' + kb(m.rss - m.rssAnon) + 'kB, shmem-rss:0kB, UID:' + victim.uid + ' pgtables:' + kb(Math.ceil(m.pt.size / 512) + 3) + 'kB oom_score_adj:' + (victim.oomAdj || 0), 3);
      st.oomKills++;
      if (cg) { for (let g = cg; g; g = g.parent) g.oomKill = (g.oomKill || 0) + 1; cg.oom = (cg.oom || 0) + 1; }
      k.ev('oom', { pid: victim.pid, comm: dec(victim.comm), rss: kb(m.rss), by: p ? p.pid : 0, cgroup: cg ? cg.path : null });
      k.ev('signal', { pid: victim.pid, sig: SIG.KILL, name: 'SIGKILL', from: 0 });
      k.exit(victim, SIG.KILL);
      return true;
    }
    function allocFrame(kind, p) {
      for (let tries = 0; tries < 4096; tries++) {
        let f = -1;
        if (st.freeList.length) f = st.freeList.pop(); else if (st.next < TOTAL) f = st.next++;
        if (f >= 0) { st.kind[f] = kind; st.ref[f] = 0; if (kind === ANON) st.anon++; else st.cache++; return f; }
        let got = 0;
        for (const s of st.shrinkers) got += s(64);
        if (got) continue;
        if (!oom(p, null)) return -1;
        if (p && p.state === 'Z') return -2;
      }
      return -1;
    }
    function freeFrame(f) {
      if (st.kind[f] === ANON) { st.anon--; const g = st.fcg.get(f); if (g) { st.fcg.delete(f); for (let x = g; x; x = x.parent) x.memCur--; } } else if (st.kind[f] === CACHE) st.cache--;
      st.kind[f] = FREE; st.ref[f] = 0;
      if (st.data.size) st.data.delete(f);
      st.freeList.push(f);
    }
    // 匿名ページ用のフレーム（cgroup の memory.max も調べる）。-1 = メモリがない、-2 = 自分が OOM で殺された
    function allocAnon(p) {
      const cg0 = p && p.cg;
      if (cg0) {
        for (let tries = 0; tries < 4096; tries++) {
          let over = null;
          for (let x = cg0; x; x = x.parent) if (x.memCur + 1 > x.memMax) { over = x; break; }
          if (!over) break;
          if (!oom(p, over)) return -1;
          if (p.state === 'Z') return -2;
        }
      }
      const f = allocFrame(ANON, p);
      if (f >= 0 && cg0) { st.fcg.set(f, cg0); for (let x = cg0; x; x = x.parent) { x.memCur++; if (x.memCur > (x.memPeak || 0)) x.memPeak = x.memCur; } }
      return f;
    }
    st.allocFrame = allocFrame; st.freeFrame = freeFrame; st.oom = oom;

    // ── アドレス空間 ──
    const newMm = () => ({ vmas: [], pt: new Map(), brk: 0, brk0: 0, mmapTop: LIBC_BASE, rss: 0, rssAnon: 0, peakVm: 0, peakRss: 0 });
    function dropPte(mm, vpn, pte) {
      const f = Math.floor(pte / 8);
      mm.rss--;
      if (pte & PFILE) { if (st.ref[f] > 0) st.ref[f]--; return 0; }
      mm.rssAnon--;
      if (--st.ref[f] <= 0) { freeFrame(f); return 1; }
      return 0;
    }
    function unmapRange(mm, start, end) {
      let freed = 0;
      const n = (end - start) / PG;
      if (n > mm.pt.size) { for (const [vpn, pte] of Array.from(mm.pt)) { const a = vpn * PG; if (a >= start && a < end) { mm.pt.delete(vpn); freed += dropPte(mm, vpn, pte); } } } else for (let a = start; a < end; a += PG) { const vpn = a / PG, pte = mm.pt.get(vpn); if (pte !== undefined) { mm.pt.delete(vpn); freed += dropPte(mm, vpn, pte); } }
      return freed;
    }
    function putVma(v) { if (v.ino) { v.ino.opens--; k.maybeFree(v.ino); } }
    function release(p, op) {
      const mm = p.mm;
      if (!mm) return;
      const pagesN = vsize(mm) / PG;
      let freed = 0;
      for (const [vpn, pte] of mm.pt) freed += dropPte(mm, vpn, pte);
      mm.pt.clear();
      for (const v of mm.vmas) putVma(v);
      p.mm = null;
      if (k.tracing('mem')) k.tev('mem', 'free', { pid: p.pid, op, pages: pagesN, frames: freed });
    }
    function note(p) { const mm = p.mm, vs = vsize(mm); if (vs > mm.peakVm) mm.peakVm = vs; if (mm.rss > mm.peakRss) { mm.peakRss = mm.rss; if (mm.rss * 4 > p.maxrss) p.maxrss = mm.rss * 4; } }
    // 領域 [start, end) を切り出す（境界で VMA を分ける）。その範囲の VMA の配列を返す
    function carve(mm, start, end) {
      const out = [];
      for (let i = 0; i < mm.vmas.length; i++) {
        const v = mm.vmas[i];
        if (v.end <= start || v.start >= end) continue;
        if (v.start < start) { const left = Object.assign({}, v, { end: start }); if (v.ino) v.ino.opens++; mm.vmas.splice(i, 0, left); i++; if (v.ino) v.off += start - v.start; v.start = start; }
        if (v.end > end) { const right = Object.assign({}, v, { start: end, off: v.ino ? v.off + (end - v.start) : 0 }); if (v.ino) v.ino.opens++; mm.vmas.splice(i + 1, 0, right); v.end = end; }
        out.push(v);
      }
      return out;
    }
    function doMunmap(p, start, end, op) {
      const mm = p.mm, vs = carve(mm, start, end);
      if (!vs.length) return 0;
      let n = 0;
      for (const v of vs) { n += (v.end - v.start) / PG; mm.vmas.splice(mm.vmas.indexOf(v), 1); putVma(v); }
      const freed = unmapRange(mm, start, end);
      if (k.tracing('mem')) k.tev('mem', 'free', { pid: p.pid, op, addr: hx(start), pages: n, frames: freed });
      return n;
    }
    function fileOf(p, path) { const i = k.namei(p, path, true); return typeof i === 'number' || i.type !== 'f' || i.fs.synth || i.dyn ? null : i; }
    function mapFile(mm, base, ino, name, lay) {
      // lay = [[ページ数, prot], …] を順に並べる
      let a = base, off = 0;
      for (const [n, prot] of lay) { if (n > 0) { ino.opens++; addVma(mm, { start: a, end: a + n * PG, prot, shared: false, ino, off, name }); a += n * PG; off += n * PG; } }
      return a;
    }
    function build(p) {
      const mm = p.mm = newMm();
      const exe = fileOf(p, p.exe);
      let end = TEXT_BASE;
      if (exe) { const n = Math.max(3, pages(exe.size)); end = mapFile(mm, TEXT_BASE, exe, p.exe, [[n - 2, 5], [1, 1], [1, 3]]); } else { addVma(mm, { start: TEXT_BASE, end: TEXT_BASE + 3 * PG, prot: 5, shared: false, ino: null, off: 0, name: '' }); end = TEXT_BASE + 3 * PG; }
      mm.brk0 = end; mm.brk = end + HEAP_PAGES * PG;
      addVma(mm, { start: end, end: mm.brk, prot: 3, shared: false, ino: null, off: 0, name: '[heap]' });
      const libc = fileOf(p, '/usr/lib/libc.so.6');
      if (libc) { const n = Math.max(3, pages(libc.size)); mapFile(mm, LIBC_BASE, libc, '/usr/lib/libc.so.6', [[n - 2, 5], [1, 1], [1, 3]]); }
      addVma(mm, { start: VDSO, end: VDSO + 2 * PG, prot: 5, shared: false, ino: null, off: 0, name: '[vdso]' });
      addVma(mm, { start: STACK_TOP - STACK_PAGES * PG, end: STACK_TOP, prot: 3, shared: false, ino: null, off: 0, name: '[stack]', stack: true });
      if (k.tracing('mem')) k.tev('mem', 'alloc', { pid: p.pid, op: 'exec', addr: hx(TEXT_BASE), len: vsize(mm), area: dec(p.comm) });
      // 起動時に触るページ（text の先頭、data、libc、ヒープ、スタック）
      const quiet = true;
      const tn = exe ? Math.min(3, Math.max(3, pages(exe.size)) - 2) : 1;
      for (let i = 0; i < tn; i++) fault(p, TEXT_BASE + i * PG, false, quiet);
      fault(p, end - 2 * PG, false, quiet); fault(p, end - PG, true, quiet);
      if (libc) { const n = Math.max(3, pages(libc.size)); for (let i = 0; i < 4 && i < n - 2; i++) fault(p, LIBC_BASE + i * PG, false, quiet); fault(p, LIBC_BASE + (n - 1) * PG, true, quiet); }
      fault(p, end, true, quiet);
      fault(p, STACK_TOP - PG, true, quiet); fault(p, STACK_TOP - 2 * PG, true, quiet);
      note(p);
    }
    const pageData = (v, addr) => (v && v.ino ? v.ino.data.substr(v.off + (addr - v.start), PG) : '');
    // ページフォルト。0 = 済んだ、-1 = 不正なアクセス（SIGSEGV）、-2 = OOM で自分が死んだ、-3 = メモリがない
    function fault(p, addr, write, quiet) {
      const mm = p.mm, vpn = Math.floor(addr / PG);
      addr = vpn * PG;
      let pte = mm.pt.get(vpn), v = findVma(mm, addr);
      if (!v) {
        // スタックは下に伸びる
        const sv = mm.vmas.find((x) => x.stack);
        if (sv && addr < sv.start && addr >= STACK_TOP - STACK_MAX * PG) { sv.start = addr; v = sv; } else return -1;
      }
      if (write ? !(v.prot & 2) : !(v.prot & 1)) return -1;
      const tr = !quiet && k.tracing('mem');
      if (pte === undefined) {
        let f, kind = 'minor', flags = 0, file = false;
        const cache = pc(), inFile = v.ino && v.off + (addr - v.start) < v.ino.size;
        if (inFile && cache && !(write && !v.shared)) {
          const r = cache.getPage(v.ino, (v.off + (addr - v.start)) / PG, p);
          if (r.frame < 0) return r.frame === -2 ? -2 : -3;
          f = r.frame; flags = PFILE | (v.shared && (v.prot & 2) && write ? PW : 0); file = true;
          if (r.miss) kind = 'major';
          if (write && v.shared) cache.markDirty(v.ino, (v.off + (addr - v.start)) / PG, p);
          st.ref[f]++;
        } else {
          let miss = false;
          if (inFile && cache) { const r = cache.getPage(v.ino, (v.off + (addr - v.start)) / PG, p); if (r.frame < 0) return r.frame === -2 ? -2 : -3; miss = r.miss; }
          f = allocAnon(p);
          if (f < 0) return f === -2 ? -2 : -3;
          if (inFile) { const d = pageData(v, addr); if (d.replace(/\0+$/, '') !== '') st.data.set(f, d); if (miss) kind = 'major'; }
          st.ref[f] = 1; flags = (v.prot & 2) ? PW : 0; mm.rssAnon++;
        }
        mm.pt.set(vpn, f * 8 + flags); mm.rss++;
        if (kind === 'major') p.majflt++; else p.minflt++;
        if (mm.rss > mm.peakRss) note(p);
        if (tr) k.tev('mem', 'fault', { pid: p.pid, addr: hx(addr), vpn, kind, write: !!write, area: v.name ? dec(v.name) : '', frame: f, file });
        return 0;
      }
      if (!write || (pte & PW)) return 0;
      // 書き込み禁止のページに書いた：コピーオンライト
      const f0 = Math.floor(pte / 8);
      if (pte & PFILE) {
        if (v.shared) { const cache = pc(); if (cache) cache.markDirty(v.ino, (v.off + (addr - v.start)) / PG, p); mm.pt.set(vpn, f0 * 8 + PFILE + PW); p.minflt++; return 0; }
        const f = allocAnon(p);
        if (f < 0) return f === -2 ? -2 : -3;
        const d = pageData(v, addr); if (d.replace(/\0+$/, '') !== '') st.data.set(f, d);
        if (st.ref[f0] > 0) st.ref[f0]--;
        st.ref[f] = 1; mm.rssAnon++;
        mm.pt.set(vpn, f * 8 + PW); p.minflt++;
        if (tr) k.tev('mem', 'cow', { pid: p.pid, addr: hx(addr), vpn, from: f0, frame: f, copied: true, file: true });
        return 0;
      }
      if (st.ref[f0] > 1) {
        const f = allocAnon(p);
        if (f < 0) return f === -2 ? -2 : -3;
        const d = st.data.get(f0); if (d !== undefined) st.data.set(f, d);
        st.ref[f0]--; st.ref[f] = 1;
        mm.pt.set(vpn, f * 8 + PW); p.minflt++;
        // 複製したフレームは、書いたプロセスの cgroup に付け替え済み（allocAnon）
        if (tr) k.tev('mem', 'cow', { pid: p.pid, addr: hx(addr), vpn, from: f0, frame: f, copied: true });
      } else {
        mm.pt.set(vpn, f0 * 8 + PW); p.minflt++;
        if (tr) k.tev('mem', 'cow', { pid: p.pid, addr: hx(addr), vpn, from: f0, frame: f0, copied: false });
      }
      return 0;
    }
    function segv(p, addr, write) {
      k.printk(p.comm + '[' + p.pid + ']: segfault at ' + hex(addr) + ' ip ' + hex(TEXT_BASE + 0x1131).padStart(16, '0') + ' sp ' + hex(STACK_TOP - 0x1e40).padStart(16, '0') + ' error ' + (write ? 6 : 4) + ' in ' + p.comm + '[' + hex(TEXT_BASE) + '+3000]', 6);
      k.sendSig(p, SIG.SEGV, null);
      return -E.EFAULT;
    }
    st.fault = fault; st.findVma = findVma; st.vsize = vsize;

    k.on('exec', (p) => { if (p.mm) release(p, 'exec'); build(p); });
    k.on('exit', (p) => { if (p.mm) release(p, 'exit'); });
    k.on('fork', (parent, child) => {
      const pm = parent.mm;
      if (!pm) return;
      const mm = child.mm = newMm();
      mm.brk = pm.brk; mm.brk0 = pm.brk0; mm.mmapTop = pm.mmapTop; mm.rss = pm.rss; mm.rssAnon = pm.rssAnon; mm.peakVm = pm.peakVm; mm.peakRss = pm.rss;
      for (const v of pm.vmas) { if (v.ino) v.ino.opens++; mm.vmas.push(Object.assign({}, v)); }
      let n = 0;
      const shared = pm.vmas.some((v) => v.shared);
      for (const [vpn, pte0] of pm.pt) {
        let pte = pte0;
        if ((pte & PW) && !(shared && findVma(pm, vpn * PG).shared)) { pte = (pte & ~PW) | PCOW; pm.pt.set(vpn, pte); n++; } else if (!(pte & PFILE) && !(pte & PCOW) && !shared) { pte |= PCOW; pm.pt.set(vpn, pte); }
        mm.pt.set(vpn, pte);
        st.ref[Math.floor(pte / 8)]++;
      }
      child.oomAdj = parent.oomAdj;
      if (k.tracing('mem')) k.tev('mem', 'forkmm', { pid: parent.pid, child: child.pid, pages: n });
    });

    // ── システムコール ──
    const align = (n) => Math.ceil(n / PG) * PG;
    const limitOk = (len) => len <= (TOTAL - RESERVED) * PG;   // 1 回の要求が物理メモリ全体より大きければ断る（overcommit のヒューリスティック）
    k.defsys('brk', (k2, p, a) => {
      const mm = p.mm; if (!mm) return -E.ENOMEM;
      const want = +a[0] || 0;
      if (!want || want < mm.brk0) return mm.brk;
      const nb = align(want), heap = mm.vmas.find((v) => v.name === '[heap]');
      if (nb === mm.brk) return mm.brk;
      if (nb > mm.brk) {
        if (!limitOk(nb - mm.brk)) return mm.brk;
        const next = mm.vmas.find((v) => v.start >= mm.brk && v !== heap);
        if (next && nb > next.start) return mm.brk;
        if (heap) heap.end = nb; else addVma(mm, { start: mm.brk0, end: nb, prot: 3, shared: false, ino: null, off: 0, name: '[heap]' });
        if (k.tracing('mem')) k.tev('mem', 'alloc', { pid: p.pid, op: 'brk', addr: hx(mm.brk), len: nb - mm.brk, area: '[heap]' });
      } else {
        const freed = unmapRange(mm, nb, mm.brk);
        if (heap) { if (nb <= heap.start) mm.vmas.splice(mm.vmas.indexOf(heap), 1); else heap.end = nb; }
        if (k.tracing('mem')) k.tev('mem', 'free', { pid: p.pid, op: 'brk', addr: hx(nb), pages: (mm.brk - nb) / PG, frames: freed });
      }
      mm.brk = nb; note(p);
      return nb;
    }, (a) => (a[0] ? hx(+a[0]) : 'NULL'), (r) => hx(r));
    k.defsys('mmap', (k2, p, a) => {
      const mm = p.mm; if (!mm) return -E.ENOMEM;
      let addr = +a[0] || 0;
      const len = align(+a[1] || 0), prot = a[2] === undefined ? 3 : a[2] | 0, flags = a[3] === undefined ? (MM.MAP_PRIVATE | MM.MAP_ANONYMOUS) : a[3] | 0, off = +a[5] || 0;
      if (len <= 0 || (off % PG) || !(flags & 3) || (flags & 3) === 3) return -E.EINVAL;
      let ino = null, name = '';
      if (!(flags & MM.MAP_ANONYMOUS)) {
        const e = p.fds[a[4]]; if (!e) return -E.EBADF;
        ino = e.ofd.inode;
        if (ino.type !== 'f' || ino.fs.synth || ino.dyn) return -E.ENODEV;
        if ((e.ofd.flags & 3) === O.WRONLY) return -E.EACCES;
        if ((flags & MM.MAP_SHARED) && (prot & 2) && (e.ofd.flags & 3) !== O.RDWR) return -E.EACCES;
        name = e.ofd.path;
      }
      if (!limitOk(len)) return -E.ENOMEM;
      if (flags & MM.MAP_FIXED) { if (addr % PG) return -E.EINVAL; doMunmap(p, addr, addr + len, 'munmap'); } else {
        addr = mm.mmapTop - len;
        for (let g = 0; g < 1000 && mm.vmas.some((v) => v.start < addr + len && v.end > addr); g++) addr -= PG * 16;
        if (addr < mm.brk + PG) return -E.ENOMEM;
        mm.mmapTop = addr;
      }
      if (ino) ino.opens++;
      addVma(mm, { start: addr, end: addr + len, prot, shared: !!(flags & MM.MAP_SHARED), ino, off, name });
      note(p);
      if (k.tracing('mem')) k.tev('mem', 'alloc', { pid: p.pid, op: 'mmap', addr: hx(addr), len, area: name ? dec(name) : '' });
      return addr;
    }, (a) => (a[0] ? hx(+a[0]) : 'NULL') + ', ' + (+a[1] || 0) + ', ' + protStr(a[2] === undefined ? 3 : a[2]) + ', ' + mapStr(a[3] === undefined ? 0x22 : a[3]) + ', ' + ((a[3] === undefined || (a[3] & 0x20)) ? -1 : a[4]) + ', ' + (a[5] ? hx(+a[5]) : '0'), (r) => hx(r));
    const protStr = (pr) => ([pr & 1 ? 'PROT_READ' : '', pr & 2 ? 'PROT_WRITE' : '', pr & 4 ? 'PROT_EXEC' : ''].filter(Boolean).join('|') || 'PROT_NONE');
    const mapStr = (f) => [f & 1 ? 'MAP_SHARED' : '', f & 2 ? 'MAP_PRIVATE' : '', f & 0x10 ? 'MAP_FIXED' : '', f & 0x20 ? 'MAP_ANONYMOUS' : ''].filter(Boolean).join('|');
    k.defsys('munmap', (k2, p, a) => {
      const mm = p.mm, addr = +a[0] || 0, len = align(+a[1] || 0);
      if (!mm || addr % PG || len <= 0) return -E.EINVAL;
      doMunmap(p, addr, addr + len, 'munmap');
      return 0;
    }, (a) => hx(+a[0] || 0) + ', ' + (+a[1] || 0));
    k.defsys('mprotect', (k2, p, a) => {
      const mm = p.mm, addr = +a[0] || 0, len = align(+a[1] || 0), prot = a[2] | 0;
      if (!mm || addr % PG) return -E.EINVAL;
      if (len === 0) return 0;
      let covered = 0;
      for (const v of mm.vmas) if (v.end > addr && v.start < addr + len) covered += Math.min(v.end, addr + len) - Math.max(v.start, addr);
      if (covered < len) return -E.ENOMEM;
      for (const v of carve(mm, addr, addr + len)) {
        if (v.ino && v.shared && (prot & 2) && !(v.prot & 2)) return -E.EACCES;
        v.prot = prot;
      }
      if (!(prot & 2)) for (let x = addr; x < addr + len; x += PG) { const vpn = x / PG, pte = mm.pt.get(vpn); if (pte !== undefined && (pte & PW)) mm.pt.set(vpn, pte & ~PW); }
      return 0;
    }, (a) => hx(+a[0] || 0) + ', ' + (+a[1] || 0) + ', ' + protStr(a[2] | 0));
    // メモリに触る（op = 'r' | 'w' | 'peek' | 'poke'）
    k.defsys('_mem', (k2, p, a) => {
      const mm = p.mm, op = a[0], addr = +a[1] || 0;
      if (!mm) return -E.EFAULT;
      const write = op === 'w' || op === 'poke', len = op === 'poke' ? String(a[2]).length : Math.max(0, +a[2] || 0);
      if (len === 0) return op === 'peek' ? '' : 0;
      const f0 = p.minflt + p.majflt;
      let out = '';
      for (let pg = Math.floor(addr / PG) * PG; pg < addr + len; pg += PG) {
        const r = fault(p, pg, write);
        if (r === -1) return segv(p, pg < addr ? addr : pg, write);
        if (r === -2) return -E.ENOMEM;
        if (r === -3) { k.sendSig(p, SIG.KILL, null); return -E.ENOMEM; }
        if (op === 'peek' || op === 'poke') {
          const pte = mm.pt.get(pg / PG), f = Math.floor(pte / 8), lo = Math.max(addr, pg) - pg, hi = Math.min(addr + len, pg + PG) - pg;
          const v = findVma(mm, pg);
          if (op === 'peek') { const d = (pte & PFILE) ? pageData(v, pg) : st.data.get(f) || ''; out += (d.length < hi ? d + ZERO.slice(d.length) : d).slice(lo, hi); } else {
            const chunk = String(a[2]).substr(Math.max(addr, pg) - addr, hi - lo);
            if (pte & PFILE) { const fo = v.off + (pg - v.start) + lo; if (fo < v.ino.size) k.fileWrite(v.ino, fo, chunk.slice(0, v.ino.size - fo), p); } else { let d = st.data.get(f) || ''; if (d.length < hi) d += ZERO.slice(d.length, hi); st.data.set(f, d.slice(0, lo) + chunk + d.slice(hi)); }
          }
        }
      }
      return op === 'peek' ? out : op === 'poke' ? len : p.minflt + p.majflt - f0;
    });

    // ── /proc ──
    const fs = k.procfs;
    const devStr = (ino) => (ino ? ((ino.fs.dev >> 8) & 0xff).toString(16).padStart(2, '0') + ':' + (ino.fs.dev & 0xff).toString(16).padStart(2, '0') : '00:00');
    fs.pidFiles.maps = (p) => ({ read: () => {
      if (!p.mm) return '';
      let o = '';
      for (const v of p.mm.vmas) {
        const l = hex(v.start).padStart(8, '0') + '-' + hex(v.end).padStart(8, '0') + ' ' + permStr(v) + ' ' + hex(v.ino ? v.off : 0).padStart(8, '0') + ' ' + devStr(v.ino) + ' ' + (v.ino ? v.ino.ino : 0) + ' ';
        o += (v.name ? l.padEnd(73) + v.name : l) + '\n';
      }
      return o;
    } });
    const kbl = (label, n) => label + ':\t' + String(n).padStart(8) + ' kB\n';
    const st0 = fs.pidFiles.status, stat0 = fs.pidFiles.stat;
    const part = (mm, f) => { let n = 0; for (const v of mm.vmas) if (f(v)) n += v.end - v.start; return n / 1024; };
    fs.pidFiles.status = (p, view) => { const nd = st0(p, view), rd = nd.read; nd.read = () => {
      const s = rd(), mm = p.mm;
      if (!mm) return s;
      const vm = kbl('VmPeak', Math.max(mm.peakVm, vsize(mm)) / 1024) + kbl('VmSize', vsize(mm) / 1024) + kbl('VmLck', 0) + kbl('VmPin', 0) + kbl('VmHWM', Math.max(mm.peakRss, mm.rss) * 4) + kbl('VmRSS', mm.rss * 4) +
        kbl('RssAnon', mm.rssAnon * 4) + kbl('RssFile', (mm.rss - mm.rssAnon) * 4) + kbl('RssShmem', 0) +
        kbl('VmData', part(mm, (v) => !v.stack && (v.prot & 2) && !v.shared)) + kbl('VmStk', part(mm, (v) => v.stack)) + kbl('VmExe', part(mm, (v) => (v.prot & 4) && v.ino && v.start < LIBC_BASE)) + kbl('VmLib', part(mm, (v) => (v.prot & 4) && v.ino && v.start >= LIBC_BASE)) +
        kbl('VmPTE', (Math.ceil(mm.pt.size / 512) + 3) * 4) + kbl('VmSwap', 0);
      return s.replace('\nThreads:', '\n' + vm + 'Threads:');
    }; return nd; };
    fs.pidFiles.stat = (p, view) => { const nd = stat0(p, view), rd = nd.read; nd.read = () => { const s = rd(); if (!p.mm) return s; const f = s.replace(/\n$/, '').split(' '); f[f.length - 2] = String(vsize(p.mm)); f[f.length - 1] = String(p.mm.rss); return f.join(' ') + '\n'; }; return nd; };
    fs.pidFiles.statm = (p) => ({ read: () => (p.mm ? [vsize(p.mm) / PG, p.mm.rss, p.mm.rss - p.mm.rssAnon, part(p.mm, (v) => (v.prot & 4) && v.ino) / 4, 0, part(p.mm, (v) => (v.prot & 2) && !v.shared) / 4, 0].join(' ') : '0 0 0 0 0 0 0') + '\n' });
    fs.pidFiles.oom_score = (p) => ({ read: () => (p.mm ? Math.max(0, Math.round((1000 * p.mm.rss) / (TOTAL - RESERVED)) + (p.oomAdj || 0)) : 0) + '\n' });
    fs.pidFiles.oom_score_adj = (p) => ({ read: () => (p.oomAdj || 0) + '\n', write: (k2, q, d) => { const n = parseInt(d, 10); if (isNaN(n) || n < -1000 || n > 1000) return -E.EINVAL; if (q.euid !== 0 && (q.euid !== p.euid || n < (p.oomAdj || 0))) return -E.EACCES; p.oomAdj = n; } });
    const info = () => {
      const c = pc(), cs = c ? c.stats() : { cached: 0, dirty: 0, writeback: 0, mapped: 0 };
      let shmem = 0;
      for (const m of k.ns0.mnt.list) if (m.fs.type === 'tmpfs') shmem += m.fs.blocksUsed;
      let pt = 0, mapped = 0;
      for (const p of k.procs.values()) if (p.mm) { pt += Math.ceil(p.mm.pt.size / 512) + 3; }
      for (let f = RESERVED; f < st.next; f++) if (st.kind[f] === CACHE && st.ref[f] > 0) mapped++;
      const free = Math.max(0, st.nfree() - shmem), total = TOTAL - RESERVED;
      return { MemTotal: total * 4, MemFree: free * 4, MemAvailable: (free + cs.cached - cs.dirty - cs.writeback) * 4, Buffers: 0, Cached: (cs.cached + shmem) * 4, SwapCached: 0,
        Active: (st.anon + Math.ceil(cs.cached / 2)) * 4, Inactive: Math.floor(cs.cached / 2) * 4, SwapTotal: 0, SwapFree: 0, Dirty: cs.dirty * 4, Writeback: cs.writeback * 4,
        AnonPages: st.anon * 4, Mapped: mapped * 4, Shmem: shmem * 4, PageTables: pt * 4, CommitLimit: total * 2, Committed_AS: Math.round(Array.from(k.procs.values()).reduce((s, p) => s + (p.mm ? part(p.mm, (v) => (v.prot & 2) && !v.shared) : 0), 0)) };
    };
    st.info = info;
    fs.reg('meminfo', { read: () => { const m = info(); return Object.keys(m).map((n) => (n + ':').padEnd(16) + String(m[n]).padStart(8) + ' kB\n').join(''); } });
    fs.reg('sys/vm/overcommit_memory', { read: () => '0\n', write: (k2, p, d) => (p.euid !== 0 ? -E.EACCES : d.trim() === '0' ? undefined : -E.EINVAL) });
    fs.reg('sys/vm/swappiness', { read: () => '60\n' });
    fs.reg('sys/vm/min_free_kbytes', { read: () => '0\n' });
    return st;
  });

  sys.touch = (addr, len) => ({ n: '_mem', a: ['r', addr, len === undefined ? 1 : len] });
  sys.wtouch = (addr, len) => ({ n: '_mem', a: ['w', addr, len === undefined ? 1 : len] });
  sys.peek = (addr, len) => ({ n: '_mem', a: ['peek', addr, len] });
  sys.poke = (addr, data) => ({ n: '_mem', a: ['poke', addr, data] });
  LNX.MM = MM;

  // ── 観察 ──
  const M = LNX.kernel.M;
  M.mem = function () {
    const st = this.k.sub.mm, i = st.info();
    return { totalFrames: TOTAL, reserved: RESERVED, free: st.nfree(), anon: st.anon, cache: st.cache, oomKills: st.oomKills, kB: i };
  };
  // フレームの使われ方（0 = 空き、1 = 匿名、2 = ページキャッシュ、3 = カーネル）と参照数
  M.frames = function () { const st = this.k.sub.mm; return { kind: Array.from(st.kind), ref: Array.from(st.ref), next: st.next }; };
  M.vm = function (pid) {
    const k = this.k, st = k.sub.mm, p = k.procs.get(pid);
    if (!p || !p.mm) return null;
    const mm = p.mm;
    const vmas = mm.vmas.map((v) => { let rss = 0; for (let a = v.start; a < v.end && (v.end - v.start) / PG <= 65536; a += PG) if (mm.pt.has(a / PG)) rss++; return { start: v.start, end: v.end, startHex: hex(v.start), endHex: hex(v.end), perms: permStr(v), offset: v.ino ? v.off : 0, ino: v.ino ? v.ino.ino : 0, name: v.name ? dec(v.name) : '', pages: (v.end - v.start) / PG, rss }; });
    const pgs = Array.from(mm.pt.keys()).sort((a, b) => a - b).map((vpn) => { const pte = mm.pt.get(vpn), f = Math.floor(pte / 8), v = findVma(mm, vpn * PG); return { vpn, addr: hx(vpn * PG), frame: f, w: !!(pte & PW), cow: !!(pte & PCOW) && !(pte & PW), file: !!(pte & PFILE), refs: st.ref[f], area: v && v.name ? dec(v.name) : '' }; });
    return { pid, comm: dec(p.comm), vmas, pages: pgs, vsz: vsize(mm) / 1024, rss: mm.rss * 4, rssAnon: mm.rssAnon * 4, rssFile: (mm.rss - mm.rssAnon) * 4, minflt: p.minflt, majflt: p.majflt, brk: hx(mm.brk), brk0: hx(mm.brk0) };
  };

  // ── コマンド ──
  const L = { late: true };
  const parseSize = (s) => { const m = /^(\d+(?:\.\d+)?)([kKmMgG]?)(?:i?[bB])?$/.exec(s || ''); if (!m) return NaN; return Math.round(+m[1] * ({ k: 1024, m: 1048576, g: 1073741824 }[m[2].toLowerCase()] || 1)); };
  const szStr = (n) => (n >= 1048576 && n % 1048576 === 0 ? n / 1048576 + ' MiB' : n >= 1024 ? Math.round(n / 1024) + ' KiB' : n + ' B');
  function* vmLine(c) { const s = yield* c.slurp('/proc/self/status'); const g = (n) => { const m = new RegExp('^' + n + ':\\s+(\\d+)', 'm').exec(typeof s === 'string' ? s : ''); return m ? +m[1] : 0; }; return { size: g('VmSize'), rss: g('VmRSS'), anon: g('RssAnon') }; }
  P('memtouch', 'メモリを確保して、全部のページに書き込む（仮想メモリの練習用）。-n なら確保だけして触らない', 'memtouch [-n] [-r] 大きさ [秒数]   例：memtouch 8M、memtouch -n 8M 30 &', function* (c) {
    const g = c.getopt('nr'); if (!g) return 1;
    const size = parseSize(g.args[0]);
    if (isNaN(size) || size <= 0) { c.err(enc('使い方：memtouch [-n] [-r] 大きさ [秒数]   例：memtouch 8M\n')); return 1; }
    const hold = g.args[1] !== undefined ? parseFloat(g.args[1]) : 0;
    const v0 = yield* vmLine(c);
    const addr = yield sys.mmap(0, size, 3, 0x22, -1, 0);
    if (addr < 0) { c.err('memtouch: mmap: ' + strerror(addr) + '\n'); return 1; }
    const n = Math.ceil(size / PG);
    c.out(enc('確保  ' + szStr(n * PG) + '（' + n + ' ページ）を mmap した: ' + hex(addr) + '-' + hex(addr + n * PG) + '\n'));
    const v1 = yield* vmLine(c);
    c.out(enc('      VmSize ' + v0.size + ' → ' + v1.size + ' kB、VmRSS ' + v0.rss + ' → ' + v1.rss + ' kB（まだフレームは割り当てられていない）\n'));
    if (!g.o.n) {
      const f = g.o.r ? yield sys.touch(addr, n * PG) : yield sys.wtouch(addr, n * PG);
      if (f < 0) return 1;
      const v2 = yield* vmLine(c);
      c.out(enc((g.o.r ? '読む  ' : '書く  ') + n + ' ページに触った: ページフォルト ' + f + ' 回\n      VmSize ' + v2.size + ' kB、VmRSS ' + v1.rss + ' → ' + v2.rss + ' kB\n'));
    }
    yield* c.flush();
    if (hold > 0) yield sys.nanosleep(hold * 1000);
    return 0;
  }, L);
  P('memfork', 'メモリに書いてから fork し、子が一部だけ書き換える（コピーオンライトの練習用）', 'memfork [大きさ] [子が書くページ数]   例：memfork 4M 16', function* (c) {
    const size = c.argv[1] !== undefined ? parseSize(c.argv[1]) : 1048576, wr = c.argv[2] !== undefined ? +c.argv[2] : 4;
    if (isNaN(size) || size <= 0 || isNaN(wr)) { c.err(enc('使い方：memfork [大きさ] [子が書くページ数]\n')); return 1; }
    const n = Math.ceil(size / PG);
    const free = function* () { const s = yield* c.slurp('/proc/meminfo'); const m = /^MemFree:\s+(\d+)/m.exec(typeof s === 'string' ? s : ''); return m ? +m[1] : 0; };
    const addr = yield sys.mmap(0, size, 3, 0x22, -1, 0);
    if (addr < 0) { c.err('memfork: mmap: ' + strerror(addr) + '\n'); return 1; }
    yield sys.wtouch(addr, n * PG);
    yield sys.poke(addr, 'parent');
    const f0 = yield* free();
    c.out(enc('親    ' + szStr(n * PG) + '（' + n + ' ページ）に書いた。先頭の中身は "parent"。空きメモリ ' + f0 + ' kB\n'));
    yield* c.flush();
    const pid = yield sys.fork(function* (c2) {
      const f1 = yield* free();
      c2.out(enc('子    fork の直後: 先頭の中身は "' + (yield sys.peek(addr, 6)) + '"。空きメモリ ' + f1 + ' kB（ページは複製されていない）\n'));
      const r0 = yield sys.getrusage(0);
      yield sys.poke(addr, 'child!');
      if (wr > 1) yield sys.wtouch(addr + PG, Math.min(wr - 1, n - 1) * PG);
      const r1 = yield sys.getrusage(0), f2 = yield* free();
      c2.out(enc('子    ' + Math.min(Math.max(wr, 1), n) + ' ページに書いた: ページフォルト ' + (r1.minflt - r0.minflt) + ' 回。先頭の中身は "' + (yield sys.peek(addr, 6)) + '"。空きメモリ ' + f2 + ' kB\n'));
      return 0;
    });
    if (pid < 0) return c.perr('fork', pid);
    yield sys.wait4(pid, 0);
    c.out(enc('親    子が終わった後: 先頭の中身は "' + (yield sys.peek(addr, 6)) + '"（子の書き込みは見えない）\n'));
    return 0;
  }, L);
  P('memhog', 'メモリを少しずつ確保して書き込み続ける（OOM killer の練習用）。止められるか、殺されるまで続く', 'memhog [1 回の大きさ] [間隔の秒数]   例：memhog 4M', function* (c) {
    const step = c.argv[1] !== undefined ? parseSize(c.argv[1]) : 4 * 1048576, gap = c.argv[2] !== undefined ? parseFloat(c.argv[2]) : 0.1;
    if (isNaN(step) || step <= 0) { c.err(enc('使い方：memhog [1 回の大きさ] [間隔の秒数]\n')); return 1; }
    let total = 0;
    for (;;) {
      const addr = yield sys.mmap(0, step, 3, 0x22, -1, 0);
      if (addr < 0) { c.err('memhog: mmap: ' + strerror(addr) + '\n'); return 1; }
      const r = yield sys.wtouch(addr, step);
      if (r < 0) return 1;
      total += step;
      c.out('memhog: ' + szStr(total) + '\n');
      yield* c.flush();
      if (gap > 0) yield sys.nanosleep(gap * 1000);
    }
  }, L);
  P('mmapcat', 'ファイルを mmap で写して、メモリから読んで表示する（練習用）。-w 文字列 なら先頭に書き込む（MAP_SHARED）', 'mmapcat [-w 文字列] ファイル', function* (c) {
    const g = c.getopt('w:'); if (!g) return 1;
    if (!g.args.length) { c.err(enc('使い方：mmapcat [-w 文字列] ファイル\n')); return 1; }
    const wr = g.o.w !== undefined;
    const fd = yield sys.open(g.args[0], wr ? O.RDWR : O.RDONLY);
    if (fd < 0) return c.perr(g.args[0], fd);
    const st = yield sys.fstat(fd);
    if (st.size === 0) { yield sys.close(fd); return 0; }
    const addr = yield sys.mmap(0, st.size, wr ? 3 : 1, wr ? 1 : 2, fd, 0);
    yield sys.close(fd);
    if (addr < 0) { c.err('mmapcat: mmap: ' + strerror(addr) + '\n'); return 1; }
    if (wr) yield sys.poke(addr, g.o.w.slice(0, st.size));
    for (let off = 0; off < st.size; off += 65536) { const d = yield sys.peek(addr + off, Math.min(65536, st.size - off)); if (typeof d !== 'string') return 1; yield* c.put(d); }
    yield sys.munmap(addr, st.size);
    return 0;
  }, L);
  P('pmap', 'プロセスのアドレス空間（メモリの領域の一覧）を表示する', 'pmap [-x] PID…', function* (c) {
    const g = c.getopt('xq'); if (!g) return 1;
    if (!g.args.length) { c.err('\nUsage:\n pmap [options] PID [PID ...]\n'); return 1; }
    let rc = 0;
    for (const a of g.args) {
      const maps = yield* c.slurp('/proc/' + a + '/maps'), cl = yield* c.slurp('/proc/' + a + '/cmdline');
      if (typeof maps !== 'string' || !/^\d+$/.test(a)) { rc = 42; continue; }
      c.out(a + ':   ' + (typeof cl === 'string' ? cl.replace(/\0$/, '').split('\0').join(' ') : '') + '\n');
      let total = 0;
      for (const l of maps.split('\n').filter(Boolean)) {
        const m = /^([0-9a-f]+)-([0-9a-f]+) (\S+) \S+ \S+ \d+\s*(.*)$/.exec(l); if (!m) continue;
        const s = parseInt(m[1], 16), e = parseInt(m[2], 16), kb = (e - s) / 1024;
        total += kb;
        const nm = m[4] === '' ? '  [ anon ]' : m[4] === '[stack]' ? '  [ stack ]' : m[4][0] === '[' ? '  [ anon ]' : U.basename(m[4]);
        c.out(m[1].padStart(16, '0') + String(kb).padStart(7) + 'K ' + m[3].slice(0, 3) + '-- ' + nm + '\n');
      }
      c.out(' total' + String(total).padStart(17) + 'K\n');
    }
    return rc;
  }, L);
  // GNU time（/usr/bin/time）。シェルの予約語 time とは別物なので、/usr/bin/time か \time と書いて呼ぶ
  P('time', 'コマンドを実行して、かかった時間と使った資源（ページフォルトの回数など）を表示する。シェルの time とは別の /usr/bin/time', '/usr/bin/time [-v] [-p] コマンド [引数…]', function* (c) {
    const g = c.getopt('vpo:', { '--verbose': 'v', '--portability': 'p' }, true); if (!g) return 125;
    if (!g.args.length) { c.err(c.argv[0] + ": missing program to run\nTry '" + c.argv[0] + " --help' for more information.\n"); return 125; }
    const t0 = yield sys.time();
    const path = yield* c.which(g.args[0]);
    const argv = g.args, env = c.env, me = c.argv[0];
    const pid = yield sys.fork(function* (c2) {
      const r = path ? yield sys.execve(path, argv, env) : -E.ENOENT;
      c2.err(me + ': cannot run ' + argv[0] + ': ' + strerror(r) + '\n');
      return r === -E.ENOENT ? 127 : 126;
    });
    if (pid < 0) return c.perr('fork', pid);
    let w;
    for (;;) { w = yield sys.wait4(pid, 0); if (w !== -E.EINTR) break; }
    const el = (yield sys.time()) - t0, ru = yield sys.getrusage(-1);
    const st = typeof w === 'object' ? w.status : 0, code = (st & 0x7f) ? 128 + (st & 0x7f) : (st >> 8) & 0xff;
    const s2 = (ms) => (ms / 1000).toFixed(2), pcpu = el > 0 ? Math.floor((100 * (ru.utime + ru.stime)) / el) + '%' : '?%';
    const hm = (ms) => { const s = ms / 1000; return s >= 3600 ? Math.floor(s / 3600) + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0') : Math.floor(s / 60) + ':' + (s % 60).toFixed(2).padStart(5, '0'); };
    let o = '';
    if ((st & 0x7f)) o += 'Command terminated by signal ' + (st & 0x7f) + '\n'; else if (code && !g.o.v) o += 'Command exited with non-zero status ' + code + '\n';
    if (g.o.p) o += 'real ' + s2(el) + '\nuser ' + s2(ru.utime) + '\nsys ' + s2(ru.stime) + '\n';
    else if (g.o.v) {
      o += '\tCommand being timed: "' + argv.join(' ') + '"\n\tUser time (seconds): ' + s2(ru.utime) + '\n\tSystem time (seconds): ' + s2(ru.stime) + '\n\tPercent of CPU this job got: ' + pcpu + '\n\tElapsed (wall clock) time (h:mm:ss or m:ss): ' + hm(el) + '\n' +
        '\tAverage shared text size (kbytes): 0\n\tAverage unshared data size (kbytes): 0\n\tAverage stack size (kbytes): 0\n\tAverage total size (kbytes): 0\n\tMaximum resident set size (kbytes): ' + ru.maxrss + '\n\tAverage resident set size (kbytes): 0\n' +
        '\tMajor (requiring I/O) page faults: ' + ru.majflt + '\n\tMinor (reclaiming a frame) page faults: ' + ru.minflt + '\n\tVoluntary context switches: ' + ru.nvcsw + '\n\tInvoluntary context switches: ' + ru.nivcsw + '\n\tSwaps: 0\n' +
        '\tFile system inputs: ' + ru.inblock + '\n\tFile system outputs: ' + ru.oublock + '\n\tSocket messages sent: 0\n\tSocket messages received: 0\n\tSignals delivered: 0\n\tPage size (bytes): 4096\n\tExit status: ' + code + '\n';
    } else o += s2(ru.utime) + 'user ' + s2(ru.stime) + 'system ' + hm(el) + 'elapsed ' + pcpu + 'CPU (0avgtext+0avgdata ' + ru.maxrss + 'maxresident)k\n' + ru.inblock + 'inputs+' + ru.oublock + 'outputs (' + ru.majflt + 'major+' + ru.minflt + 'minor)pagefaults 0swaps\n';
    if (g.o.o !== undefined) { const fd = yield sys.open(g.o.o, O.WRONLY | O.CREAT | O.TRUNC, 0o666); if (fd < 0) return c.perr(g.o.o, fd); yield* c.writeAll(fd, o); yield sys.close(fd); } else c.err(o);
    return code;
  }, L);
  Object.assign(LNX.SYSJA, { brk: 'ヒープの終わりを動かす', mmap: 'メモリの領域を割り当てる・ファイルを写す', munmap: 'mmap した領域を返す', mprotect: 'メモリの保護を変える' });
  void isErr;
})(typeof window !== 'undefined' ? window : globalThis);
