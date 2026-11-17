// 図解 Linux のコマンド群（その 1：ファイル操作、権限、テキスト処理）。kernel.js・shell.js の後に読み込む。API は kernel.js の先頭コメントを見る。
// どのコマンドも function*(c) の形で、yield でシステムコールを呼ぶ。c は LNX.Ctx（argv、env、out()、err()、…）。
(function (root) {
  'use strict';
  const LNX = root.LNX, sys = LNX.sys, E = LNX.ERRNO, O = LNX.O, U = LNX.util, strerror = LNX.strerror, SH = LNX.sh;
  const dec = U.dec, enc = U.enc, basename = U.basename, dirname = U.dirname;
  const HI = /[^\x00-\x7f]/;
  const IFMT = 0o170000, IFDIR = 0o040000, IFREG = 0o100000, IFLNK = 0o120000, IFCHR = 0o020000, IFIFO = 0o010000;
  const isDir = (st) => typeof st === 'object' && (st.mode & IFMT) === IFDIR;
  const isErr = (r) => typeof r === 'number' && r < 0;
  const typeCh = (st) => U.BITSTYPE[st.mode & IFMT] || 'f';

  // 登録：P('名前', '1 行の説明', '使い方', function*(c) {…}, { suid, sbin })
  function P(name, help, usage, main, extra) { LNX.bin[name] = Object.assign({ main, help, usage }, extra || {}); }
  const lines = (d) => { const a = d.split('\n'); if (a[a.length - 1] === '') a.pop(); return a; };
  const join = (a, b) => (a === '/' ? '/' + b : a.replace(/\/+$/, '') + '/' + b);
  function human(n) {
    if (n < 1024) return String(n);
    const units = 'KMGTP';
    let u = -1, v = n;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    if (v < 10) { const r = Math.ceil(v * 10) / 10; if (r < 10) return r.toFixed(1) + units[u]; v = r; }
    v = Math.ceil(v);
    if (v >= 1024 && u < units.length - 1) return '1.0' + units[u + 1];
    return v + units[u];
  }
  // 画面での幅（全角は 2）
  function dispWidth(b) {
    if (!HI.test(b)) return b.length;
    let w = 0;
    for (const ch of dec(b)) { const cp = ch.codePointAt(0); w += cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x20000) ? 2 : 1; }
    return w;
  }
  const lsTime = (ms, now) => (ms > now - 15778476000 && ms <= now + 3600000 ? U.strftime('%b %e %H:%M', ms) : U.strftime('%b %e  %Y', ms));
  const cmpBytes = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  // PATH から探す
  Object.assign(LNX.Ctx.prototype, {
    *which(name, pathVar) {
      if (name.indexOf('/') >= 0) return name;
      for (const d of (pathVar || this.env.PATH || '/usr/bin:/bin').split(':')) {
        const p = (d || '.') + '/' + name, st = yield sys.stat(p);
        if (typeof st === 'object' && (st.mode & IFMT) === IFREG && (st.mode & 0o111)) return p;
      }
      return null;
    },
    // 子プロセスでコマンドを実行して待つ。終了ステータス
    *spawn(argv, env, quiet) {
      yield* this.flush();
      const path = yield* this.which(argv[0]);
      const name = this.name;
      if (!path) { if (!quiet) this.err(name + ': ' + argv[0] + ': No such file or directory\n'); return 127; }
      const pid = yield sys.fork(function* (c2) {
        const r = yield sys.execve(path, argv, env);
        if (r === -E.ENOEXEC) yield sys.execve('/bin/sh', ['sh', path].concat(argv.slice(1)), env);
        c2.err(name + ': ' + argv[0] + ': ' + strerror(r) + '\n');
        return r === -E.ENOENT ? 127 : 126;
      });
      if (pid < 0) { this.err(name + ': fork: ' + strerror(pid) + '\n'); return 126; }
      for (;;) { const w = yield sys.wait4(pid, 0); if (w === -E.EINTR) continue; if (typeof w === 'number') return 126; return (w.status & 0x7f) ? 128 + (w.status & 0x7f) : (w.status >> 8) & 0xff; }
    },
    *readDir(path) {
      const fd = yield sys.open(path, O.RDONLY | O.DIRECTORY);
      if (fd < 0) return fd;
      const ents = yield sys.getdents(fd);
      yield sys.close(fd);
      return ents;
    },
    *isatty(fd) { return !((yield sys.ioctl(fd, LNX.TIO.TCGETS)) < 0); },
  });

  // ════════════════════════ 基本 ════════════════════════
  P('true', '何もせず、成功（0）で終わる', 'true', function* () { return 0; });
  P('false', '何もせず、失敗（1）で終わる', 'false', function* () { return 1; });
  P('echo', '引数をそのまま表示する', 'echo [-n] [-e] 文字列…', function* (c) { c.out(SH.echo(c.argv.slice(1))); return 0; });
  P('printf', '書式を指定して表示する', 'printf 書式 [引数…]', function* (c) {
    const r = SH.printf(c.argv.slice(1), 'printf');
    c.out(r.out);
    for (const e of r.err) c.err(e + '\n');
    return r.st;
  });
  P('pwd', 'いまいるディレクトリを表示する', 'pwd', function* (c) {
    const g = c.argv[1] !== '-P' && c.env.PWD ? c.env.PWD : yield sys.getcwd();
    if (typeof g !== 'string') return c.perr('.', g);
    c.out(g + '\n'); return 0;
  });
  P('cat', 'ファイルの中身を表示する（つなげて表示する）', 'cat [-n] [ファイル…]', function* (c) {
    const g = c.getopt('nbAEsuT'); if (!g) return 1;
    const files = g.args.length ? g.args : ['-'];
    let rc = 0, ln = 0;
    for (const f of files) {
      const fd = f === '-' ? 0 : yield sys.open(f, O.RDONLY);
      if (fd < 0) { rc = c.perr(f, fd); continue; }
      // GNU cat：読むファイルと書く先が同じ普通のファイルで、まだ読む中身があるなら断る（cat f >> f が終わらなくなるので）
      if (yield sys._samefile(fd, 1)) { c.err('cat: ' + f + ': input file is output file\n'); rc = 1; if (fd > 0) yield sys.close(fd); continue; }
      let pend = '';
      for (;;) {
        const r = yield sys.read(fd, 4096);
        if (r === -E.EINTR) continue;
        if (typeof r === 'number') { yield* c.flush(); rc = c.perr(f, r); break; }
        if (r === '') break;
        if (g.o.n || g.o.b || g.o.A || g.o.E) {
          const d = pend + r, ls = d.split('\n');
          pend = ls.pop();
          for (const l of ls) c.out(((g.o.n && !g.o.b) || (g.o.b && l !== '') ? String(++ln).padStart(6) + '\t' : '') + l + (g.o.A || g.o.E ? '$' : '') + '\n');
          yield* c.flush();
        } else { const w = yield* c.writeAll(1, r); if (w < 0) { if (w !== -E.EPIPE) c.err('cat: write error: ' + strerror(w) + '\n'); return 1; } }
      }
      if (pend !== '') c.out((g.o.n || g.o.b ? String(++ln).padStart(6) + '\t' : '') + pend);
      if (fd > 0) yield sys.close(fd);
    }
    return rc;
  });
  LNX.bin.more = Object.assign({}, LNX.bin.cat, { help: 'ファイルの中身を表示する（この Linux では cat と同じ）', usage: 'more ファイル' });
  LNX.bin.less = Object.assign({}, LNX.bin.cat, { help: 'ファイルの中身を表示する（この Linux では cat と同じ）', usage: 'less ファイル' });
  P('tac', '行を逆の順番で表示する', 'tac [ファイル…]', function* (c) {
    for (const f of c.argv.length > 1 ? c.argv.slice(1) : ['-']) { const d = yield* c.cat(f); if (d !== null) c.out(lines(d).reverse().map((l) => l + '\n').join('')); }
    return c.rc | 0;
  });
  P('rev', '各行の文字を逆の順番にする', 'rev [ファイル…]', function* (c) {
    for (const f of c.argv.length > 1 ? c.argv.slice(1) : ['-']) { const d = yield* c.cat(f); if (d !== null) c.out(lines(d).map((l) => enc(Array.from(dec(l)).reverse().join('')) + '\n').join('')); }
    return c.rc | 0;
  });
  P('nl', '行番号をつけて表示する', 'nl [ファイル…]', function* (c) {
    let n = 0;
    for (const f of c.argv.length > 1 ? c.argv.slice(1) : ['-']) { const d = yield* c.cat(f); if (d !== null) c.out(lines(d).map((l) => (l === '' ? '       \n' : String(++n).padStart(6) + '\t' + l + '\n')).join('')); }
    return c.rc | 0;
  });
  P('basename', 'パスから最後の名前だけを取り出す', 'basename パス [接尾辞]', function* (c) {
    if (c.argv.length < 2) return c.fail('missing operand');
    let b = basename(c.argv[1]);
    if (c.argv[2] && b.endsWith(c.argv[2]) && b !== c.argv[2]) b = b.slice(0, -c.argv[2].length);
    c.out(b + '\n'); return 0;
  });
  P('dirname', 'パスからディレクトリの部分を取り出す', 'dirname パス', function* (c) {
    if (c.argv.length < 2) return c.fail('missing operand');
    for (const a of c.argv.slice(1)) c.out(dirname(a) + '\n');
    return 0;
  });
  P('seq', '連続した数を表示する', 'seq [最初 [増分]] 最後', function* (c) {
    const g = { o: {}, args: [] };
    for (let i = 1; i < c.argv.length; i++) { const x = c.argv[i]; if (x === '-w') g.o.w = 1; else if (x === '-s') g.o.s = c.argv[++i]; else if (/^-s./.test(x)) g.o.s = x.slice(2); else if (x[0] === '-' && !/^-\.?\d/.test(x)) { c.err("seq: invalid option -- '" + x.slice(1) + "'\n"); return 1; } else g.args.push(x); }
    const a = g.args.map(Number);
    if (!a.length) return c.fail('missing operand');
    for (let i = 0; i < a.length; i++) if (isNaN(a[i])) return c.fail("invalid floating point argument: '" + g.args[i] + "'");
    const first = a.length > 1 ? a[0] : 1, inc = a.length > 2 ? a[1] : 1, last = a[a.length - 1];
    if (inc === 0) return c.fail("invalid Zero increment value: '" + g.args[1] + "'");
    const sep = g.o.s === undefined ? '\n' : g.o.s;
    const prec = Math.max(...g.args.slice(0, a.length > 1 ? a.length - (a.length > 2 ? 1 : 1) : 0).concat(a.length > 2 ? [g.args[1]] : []).map((s) => (String(s).split('.')[1] || '').length), 0);
    const w = g.o.w ? Math.max(first.toFixed(prec).length, last.toFixed(prec).length) : 0;
    let buf = '', n = 0;
    for (let i = 0; ; i++) {
      const v = first + i * inc;
      if (inc > 0 ? v > last + 1e-9 : v < last - 1e-9) break;
      let s = prec ? v.toFixed(prec) : String(v);
      if (w) s = (s[0] === '-' ? '-' + s.slice(1).padStart(w - 1, '0') : s.padStart(w, '0'));
      buf += (n++ ? sep : '') + s;
      if (buf.length >= 4096) { yield* c.put(buf); buf = ''; }
    }
    c.out(buf + (n ? '\n' : ''));
    return 0;
  });
  P('yes', '同じ文字列を止められるまで出し続ける', 'yes [文字列]', function* (c) {
    const s = (c.argv.length > 1 ? c.argv.slice(1).join(' ') : 'y') + '\n';
    const chunk = s.repeat(Math.max(1, Math.floor(4096 / s.length)));
    for (;;) { const r = yield sys.write(1, chunk); if (r < 0 && r !== -E.EINTR) { if (r !== -E.EPIPE) c.err('yes: standard output: ' + strerror(r) + '\n'); return 1; } }
  });
  P('sleep', '指定した秒数だけ待つ', 'sleep 秒数', function* (c) {
    if (c.argv.length < 2) return c.fail('missing operand');
    let ms = 0;
    for (const a of c.argv.slice(1)) {
      const m = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(a);
      if (!m) return c.fail("invalid time interval '" + a + "'");
      ms += parseFloat(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]] * 1000;
    }
    yield sys.nanosleep(ms);
    return 0;
  });
  const testMain = function* (c) {
    let args = c.argv.slice(1);
    if (c.name === '[') { if (args[args.length - 1] !== ']') { c.err("[: missing `]'\n"); return 2; } args = args.slice(0, -1); }
    const r = yield* SH.testEval(args);
    if (r.err) c.err(c.name + ': ' + r.err + '\n');
    return r.st;
  };
  P('test', '条件を調べて、終了ステータスで答える', 'test 式   または   [ 式 ]', testMain);
  P('[', '条件を調べて、終了ステータスで答える（test と同じ）', '[ 式 ]', testMain);
  P('env', '環境変数を表示する。環境変数を変えてコマンドを実行する', 'env [名前=値…] [コマンド [引数…]]', function* (c) {
    let env = Object.assign({}, c.env), i = 1;
    for (; i < c.argv.length; i++) {
      const a = c.argv[i];
      if (a === '-i' || a === '-') env = {}; else if (a === '-u') delete env[c.argv[++i]]; else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { const e = a.indexOf('='); env[a.slice(0, e)] = a.slice(e + 1); } else break;
    }
    if (i >= c.argv.length) { for (const k in env) c.out(k + '=' + env[k] + '\n'); return 0; }
    const argv = c.argv.slice(i), path = yield* c.which(argv[0], env.PATH || c.env.PATH);
    if (!path) { c.err('env: ' + "'" + argv[0] + "'" + ': No such file or directory\n'); return 127; }
    const r = yield sys.execve(path, argv, env);
    c.err('env: ' + argv[0] + ': ' + strerror(r) + '\n');
    return 126;
  });
  P('printenv', '環境変数を表示する', 'printenv [名前…]', function* (c) {
    if (c.argv.length < 2) { for (const k in c.env) c.out(k + '=' + c.env[k] + '\n'); return 0; }
    let rc = 0;
    for (const n of c.argv.slice(1)) { if (c.env[n] === undefined) rc = 1; else c.out(c.env[n] + '\n'); }
    return rc;
  });
  P('which', 'コマンドの実体がどこにあるかを表示する', 'which コマンド…', function* (c) {
    let rc = 0;
    for (const n of c.argv.slice(1)) { if (n[0] === '-') continue; const p = yield* c.which(n); if (p && p.indexOf('/') >= 0 && (yield sys.access(p, 1)) === 0) c.out(p + '\n'); else rc = 1; }
    return rc;
  });
  P('clear', '画面を消す（この Linux では何もしない）', 'clear', function* () { return 0; });
  P('tty', '標準入力につながっている端末の名前を表示する', 'tty', function* (c) {
    const t = yield sys.readlink('/proc/self/fd/0');
    if (typeof t !== 'string' || !(yield* c.isatty(0))) { c.out('not a tty\n'); return 1; }
    c.out(t + '\n'); return 0;
  });

  // ════════════════════════ ls / stat ════════════════════════
  P('ls', 'ファイルやディレクトリの一覧を表示する', 'ls [-l] [-a] [-i] [-R] [-d] [-h] [-F] [-t] [-r] [-S] [-1] [パス…]', function* (c) {
    const g = c.getopt('laAiRdhF1trSnps', { '--size': 's', '--all': 'a', '--human-readable': 'h', '--inode': 'i', '--recursive': 'R', '--directory': 'd', '--classify': 'F', '--reverse': 'r' }); if (!g) return 2;
    const o = g.o;
    if (o.n) o.l = 1;
    const now = o.l ? yield sys.time() : 0;
    const isTty = yield* c.isatty(1);
    const tty = !o.l && !o['1'] && isTty;
    // 端末に出すときは、空白や記号を含む名前を引用符で囲む（GNU ls の shell-escape）
    const qn = (n) => {
      if (!isTty) return n;
      if (/[\x00-\x1f\x7f]/.test(n)) { let r = '', cur = ''; for (const ch of n) { if (/[\x00-\x1f\x7f]/.test(ch)) { if (cur !== '') { r += "'" + cur + "'"; cur = ''; } const cc = ch.charCodeAt(0); r += "$'" + ({ 9: '\\t', 10: '\\n', 13: '\\r' }[cc] || '\\' + U.oct(cc, 3)) + "'"; } else cur += ch === "'" ? "'\\''" : ch; } if (cur !== '') r += "'" + cur + "'"; return r === '' ? "''" : r; }
      if (n === '' ) return "''";
      if (!/[ !"#$&'()*;<=>?\[\\\]^`{|}]/.test(n) && n[0] !== '~') return n;
      if (n.indexOf("'") < 0) return "'" + n + "'";
      if (!/["$`\\]/.test(n)) return '"' + n + '"';
      return "'" + n.replace(/'/g, "'\\''") + "'";
    };
    const qpad = (list) => { const any = list.some((n) => qn(n) !== n); return (n) => { const x = qn(n); return any && x === n ? ' ' + n : x; }; };
    let cols = 80;
    if (tty) { const ws = yield sys.ioctl(1, LNX.TIO.TIOCGWINSZ); if (ws && ws.cols) cols = ws.cols; }
    const pw = o.l && !o.n ? yield* c.passwd() : null, gr = o.l && !o.n ? yield* c.group() : null;
    const uname = (u) => { const x = pw && pw.find((y) => y.uid === u); return x ? x.name : String(u); };
    const gname = (u) => { const x = gr && gr.find((y) => y.gid === u); return x ? x.name : String(u); };
    let rc = 0;
    const needStat = o.l || o.F || o.t || o.S || o.i || o.p || o.s;
    const sorter = (a, b) => { let r = 0; if (o.t) r = b.st.mtime - a.st.mtime; else if (o.S) r = b.st.size - a.st.size; if (!r) r = cmpBytes(a.name, b.name); return o.r ? -r : r; };
    const suffix = (e) => { if (!e.st || !(o.F || o.p)) return ''; const t = typeCh(e.st); return t === 'd' ? '/' : !o.F ? '' : t === 'l' ? '@' : t === 'p' ? '|' : t === 's' ? '=' : t === 'f' && (e.st.mode & 0o111) ? '*' : ''; };
    function* show(ents) {
      ents.sort(sorter);
      const Q = qpad(ents.map((e) => e.name));
      if (o.l) {
        const rows = [];
        for (const e of ents) {
          if (e.bad) { rows.push(['?', ({ d: 'd', l: 'l', c: 'c', b: 'b', p: 'p', s: 's' }[e.type] || '-') + '?????????', '?', '?', '?', '?', '           ?', Q(e.name), '?']); continue; }
          const st = e.st, t = typeCh(st);
          let name = Q(e.name) + (t === 'l' ? '' : suffix(e));
          if (t === 'l') { const tg = yield sys.readlink(e.path); name += ' -> ' + (typeof tg === 'string' ? tg : '?'); }
          rows.push([o.i ? String(st.ino) : '', U.modeStr(t, st.mode & 0o7777), String(st.nlink), uname(st.uid), gname(st.gid), t === 'c' || t === 'b' ? (st.rdev >> 8) + ', ' + (st.rdev & 255) : o.h ? human(st.size) : String(st.size), lsTime(st.mtime, now), name]);
        }
        const w = [0, 0, 0, 0, 0, 0];
        for (const r of rows) for (let i = 0; i < 6; i++) w[i] = Math.max(w[i], r[i].length);
        for (const r of rows) c.out((o.i ? r[0].padStart(w[0]) + ' ' : '') + r[1] + ' ' + r[2].padStart(w[2]) + ' ' + r[3].padEnd(w[3]) + ' ' + r[4].padEnd(w[4]) + ' ' + r[5].padStart(w[5]) + ' ' + r[6] + ' ' + r[7] + '\n');
        return;
      }
      const names = ents.map((e) => (o.i ? (e.st ? e.st.ino : '?') + ' ' : '') + (o.s ? (e.st ? e.st.blocks / 2 : '?') + ' ' : '') + Q(e.name) + suffix(e));
      if (!tty) { for (const n of names) c.out(n + '\n'); return; }
      if (!names.length) return;
      const wd = names.map(dispWidth), n = names.length;
      let best = 1, bw = null;
      for (let nc = Math.min(n, Math.floor(cols / 3) || 1); nc >= 1; nc--) {
        const nr = Math.ceil(n / nc), cw = [];
        let total = 0;
        for (let ci = 0; ci * nr < n; ci++) { let m = 0; for (let r = 0; r < nr && ci * nr + r < n; r++) m = Math.max(m, wd[ci * nr + r]); cw.push(m + 2); total += m + 2; }
        if (total - 2 <= cols || nc === 1) { best = nr; bw = cw; break; }
      }
      for (let r = 0; r < best; r++) {
        let line = '';
        for (let ci = 0; ci < bw.length; ci++) { const i = ci * best + r; if (i >= n) break; const lastc = i + best >= n; line += names[i] + (lastc ? '' : ' '.repeat(bw[ci] - wd[i])); }
        c.out(line + '\n');
      }
    }
    function* listDir(path, header, first) {
      const dfd = yield sys.open(path, O.RDONLY | O.DIRECTORY);
      if (dfd < 0) { c.err("ls: cannot open directory '" + path + "': " + strerror(dfd) + '\n'); rc = 2; return; }
      const ents = yield sys.getdents(dfd);
      if (isErr(ents)) { yield sys.close(dfd); c.err("ls: reading directory '" + path + "': " + strerror(ents) + '\n'); rc = 2; return; }
      if (header) c.out((first ? '' : '\n') + path + ':\n');
      const list = [];
      let blocks = 0;
      for (const e of ents) {
        if (e.name[0] === '.' && !o.a && !(o.A && e.name !== '.' && e.name !== '..')) continue;
        const it = { name: e.name, path: join(path, e.name), st: null, type: e.type };
        if (needStat) { const st = yield sys.lstat(it.path); if (isErr(st)) { c.err("ls: cannot access '" + it.path + "': " + strerror(st) + '\n'); rc = 1; it.bad = true; it.st = { mode: 0, mtime: 0, size: 0, ino: 0, nlink: 0, blocks: 0, uid: 0, gid: 0 }; list.push(it); continue; } it.st = st; blocks += st.blocks; }
        list.push(it);
      }
      if (o.l || o.s) c.out('total ' + (o.h ? human(blocks * 512) : blocks / 2) + '\n');
      yield* show(list);
      yield sys.close(dfd);
      if (o.R) for (const it of list.slice().sort(sorter)) { if (it.name === '.' || it.name === '..') continue; if (it.st ? typeCh(it.st) === 'd' : it.type === 'd') yield* listDir(it.path, true, false); }
    }
    const args = g.args.length ? g.args : ['.'];
    const files = [], dirs = [];
    for (const a of args) {
      const st = o.l || o.d || o.F ? yield sys.lstat(a) : yield sys.stat(a);
      let st2 = st;
      if (!isErr(st) && typeCh(st) === 'l' && !o.l && !o.d) st2 = yield sys.stat(a);
      if (isErr(st)) { c.err("ls: cannot access '" + a + "': " + strerror(st) + '\n'); rc = 2; continue; }
      if (isDir(st2) && !o.d && !(o.l && typeCh(st) === 'l' && !a.endsWith('/'))) dirs.push(a); else files.push({ name: a, path: a, st });
    }
    if (files.length) yield* show(files);
    dirs.sort(cmpBytes);
    if (o.r) dirs.reverse();
    let first = !files.length;
    for (const d of dirs) { yield* listDir(d, args.length > 1 || o.R, first); first = false; }
    return rc;
  });

  const FTYPE = { f: 'regular file', d: 'directory', l: 'symbolic link', c: 'character special file', b: 'block special file', p: 'fifo', s: 'socket' };
  P('stat', 'ファイルの inode の情報（大きさ、権限、リンク数、時刻）を表示する', 'stat [-L] [-f] [-c 書式] ファイル…', function* (c) {
    const g = c.getopt('c:Lf', { '--format': 'c', '--dereference': 'L', '--file-system': 'f' }); if (!g) return 1;
    if (!g.args.length) return c.fail('missing operand');
    let rc = 0;
    if (g.o.f) {
      const TN = { ext4: 'ext2/ext3', devtmpfs: 'tmpfs', cgroup2: 'cgroup2fs', overlay: 'overlayfs' }, MAGIC = { ext4: 'ef53', tmpfs: '1021994', devtmpfs: '1021994', proc: '9fa0', sysfs: '62656572', cgroup2: '63677270', overlay: '794c7630' };
      for (const f of g.args) {
        const s2 = yield sys.statfs(f), st = yield sys.stat(f);
        if (isErr(s2)) { c.err("stat: cannot read file system information for '" + f + "': " + strerror(s2) + '\n'); rc = 1; continue; }
        const id = (((st.dev >> 8) << 8) | (st.dev & 255)).toString(16).padStart(8, '0') + '00000000', tn = TN[s2.type] || s2.type;
        if (g.o.c !== undefined) {
          c.out(SH.unescape(g.o.c).s.replace(/%([a-zA-Z%])/g, (m, k) => ({ n: f, i: id, l: '255', t: MAGIC[s2.type] || '0', T: tn, b: String(s2.blocks), f: String(s2.bfree), a: String(s2.bavail), s: String(s2.bsize), S: String(s2.bsize), c: String(s2.files), d: String(s2.ffree), '%': '%' })[k] || m) + '\n');
          continue;
        }
        c.out('  File: "' + f + '"\n    ID: ' + id.padEnd(8) + ' Namelen: ' + '255'.padEnd(7) + ' Type: ' + tn + '\nBlock size: ' + String(s2.bsize).padEnd(10) + ' Fundamental block size: ' + s2.bsize + '\nBlocks: Total: ' + String(s2.blocks).padEnd(10) + ' Free: ' + String(s2.bfree).padEnd(10) + ' Available: ' + s2.bavail + '\nInodes: Total: ' + String(s2.files).padEnd(10) + ' Free: ' + s2.ffree + '\n');
      }
      return rc;
    }
    const ts = (ms) => U.strftime('%Y-%m-%d %H:%M:%S.%N %z', ms);
    for (const f of g.args) {
      const st = g.o.L ? yield sys.stat(f) : yield sys.lstat(f);
      if (isErr(st)) { c.err("stat: cannot statx '" + f + "': " + strerror(st) + '\n'); rc = 1; continue; }
      const t = typeCh(st), ms = U.modeStr(t, st.mode & 0o7777), un = yield* c.uname(st.uid), gn = yield* c.gname(st.gid);
      const tg = t === 'l' ? yield sys.readlink(f) : null;
      const tname = t === 'f' && st.size === 0 ? 'regular empty file' : FTYPE[t];
      if (g.o.c !== undefined) {
        c.out(SH.unescape(g.o.c).s.replace(/%([a-zA-Z%])/g, (m, k) => {
          switch (k) {
            case 'n': return f; case 'N': return "'" + f + "'" + (tg !== null ? " -> '" + tg + "'" : ''); case 's': return String(st.size); case 'a': return U.oct(st.mode & 0o7777); case 'A': return ms;
            case 'U': return un; case 'G': return gn; case 'u': return String(st.uid); case 'g': return String(st.gid); case 'i': return String(st.ino); case 'h': return String(st.nlink);
            case 'F': return tname; case 'b': return String(st.blocks); case 'B': return '512'; case 'o': return String(st.blksize); case 'd': return String(st.dev); case 'f': return st.mode.toString(16);
            case 'y': return ts(st.mtime); case 'x': return ts(st.atime); case 'z': return ts(st.ctime); case 'Y': return String(Math.floor(st.mtime / 1000)); case 'X': return String(Math.floor(st.atime / 1000)); case 'Z': return String(Math.floor(st.ctime / 1000));
            case 't': return (st.rdev >> 8).toString(16); case 'T': return (st.rdev & 255).toString(16); case '%': return '%';
          }
          return m;
        }) + '\n');
        continue;
      }
      c.out('  File: ' + f + (tg !== null ? ' -> ' + tg : '') + '\n');
      c.out('  Size: ' + String(st.size).padEnd(10) + '\tBlocks: ' + String(st.blocks).padEnd(10) + ' IO Block: ' + String(st.blksize).padEnd(6) + ' ' + tname + '\n');
      c.out('Device: ' + (st.dev >> 8) + ',' + (st.dev & 255) + '\tInode: ' + String(st.ino).padEnd(10) + '  Links: ' + (t === 'c' || t === 'b' ? String(st.nlink).padEnd(5) + ' Device type: ' + (st.rdev >> 8) + ',' + (st.rdev & 255) : String(st.nlink)) + '\n');
      c.out('Access: (' + U.oct(st.mode & 0o7777, 4) + '/' + ms + ')  Uid: (' + String(st.uid).padStart(5) + '/' + un.padStart(8) + ')   Gid: (' + String(st.gid).padStart(5) + '/' + gn.padStart(8) + ')\n');
      c.out('Access: ' + ts(st.atime) + '\nModify: ' + ts(st.mtime) + '\nChange: ' + ts(st.ctime) + '\n Birth: -\n');
    }
    return rc;
  });
  P('readlink', 'シンボリックリンクの指す先を表示する', 'readlink [-f] リンク', function* (c) {
    const g = c.getopt('fn'); if (!g) return 1;
    let rc = 0;
    for (const f of g.args) {
      if (g.o.f) { const r = yield* realpath(c, f); if (r === null) rc = 1; else c.out(r + '\n'); continue; }
      const t = yield sys.readlink(f);
      if (typeof t !== 'string') rc = 1; else c.out(t + (g.o.n ? '' : '\n'));
    }
    return rc;
  });
  function* realpath(c, f) {
    let p = f[0] === '/' ? f : join(yield sys.getcwd(), f);
    for (let depth = 0; depth < 40; depth++) {
      const parts = U.normpath(p).split('/').filter(Boolean);
      let cur = '', changed = false;
      for (let i = 0; i < parts.length; i++) {
        const nxt = cur + '/' + parts[i], st = yield sys.lstat(nxt);
        if (isErr(st)) { if (i === parts.length - 1) { cur = nxt; break; } return null; }
        if (typeCh(st) === 'l') { const t = yield sys.readlink(nxt); p = (t[0] === '/' ? t : (cur || '/') + '/' + t) + '/' + parts.slice(i + 1).join('/'); changed = true; break; }
        cur = nxt;
      }
      if (!changed) return cur || '/';
    }
    return null;
  }
  P('realpath', 'シンボリックリンクや .. を解決した絶対パスを表示する', 'realpath パス…', function* (c) {
    let rc = 0;
    for (const f of c.argv.slice(1)) { const r = yield* realpath(c, f); if (r === null || isErr(yield sys.lstat(r))) { c.perr(f, -E.ENOENT); rc = 1; } else c.out(r + '\n'); }
    return rc;
  });

  // ════════════════════════ ファイル操作 ════════════════════════
  P('touch', '空のファイルを作る。あれば更新時刻をいまにする', 'touch [-c] ファイル…', function* (c) {
    const g = c.getopt('cam'); if (!g) return 1;
    if (!g.args.length) return c.fail('missing file operand');
    let rc = 0;
    for (const f of g.args) {
      let r = yield sys.utimensat(f, null);
      if (r === -E.ENOENT && !g.o.c) { r = yield sys.open(f, O.WRONLY | O.CREAT | O.NOCTTY | O.NONBLOCK, 0o666); if (r >= 0) { yield sys.close(r); r = 0; } } else if (r === -E.ENOENT) r = 0;
      if (r < 0) { c.err("touch: cannot touch '" + f + "': " + strerror(r) + '\n'); rc = 1; }
    }
    return rc;
  });
  function parseMode(spec, old, isdir, umask) {
    if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8);
    let mode = old;
    for (const cl of spec.split(',')) {
      const m = /^([ugoa]*)((?:[-+=](?:[rwxXst]*|[ugo]))+)$/.exec(cl);
      if (!m) return -1;
      let who = 0;
      for (const w of m[1]) who |= w === 'u' ? 0o4700 : w === 'g' ? 0o2070 : w === 'o' ? 0o1007 : 0o7777;
      const all = m[1] === '';
      if (all) who = 0o7777;
      const re = /([-+=])([rwxXst]*|[ugo])/g;
      let a;
      while ((a = re.exec(m[2]))) {
        let bits = 0;
        const pm = a[2];
        if (/^[ugo]$/.test(pm)) { const src = pm === 'u' ? (mode >> 6) & 7 : pm === 'g' ? (mode >> 3) & 7 : mode & 7; bits = (src << 6) | (src << 3) | src; } else for (const ch of pm) {
          if (ch === 'r') bits |= 0o444; else if (ch === 'w') bits |= 0o222; else if (ch === 'x') bits |= 0o111; else if (ch === 'X') { if (isdir || (mode & 0o111)) bits |= 0o111; } else if (ch === 's') bits |= 0o6000; else if (ch === 't') bits |= 0o1000;
        }
        bits &= who;
        if (all) bits &= ~umask | 0o7000;
        if (a[1] === '+') mode |= bits; else if (a[1] === '-') mode &= ~bits; else mode = (mode & ~(who & (all ? 0o777 : 0o7777))) | bits;
      }
    }
    return mode;
  }
  function* walkTree(c, path, fn, post) {
    const st = yield sys.lstat(path);
    if (isErr(st)) return yield* fn(path, st);
    if (!post) yield* fn(path, st);
    if (isDir(st)) {
      const ents = yield* c.readDir(path);
      if (isErr(ents)) { c.err(c.name + ": cannot read directory '" + path + "': " + strerror(ents) + '\n'); c.rc = 1; } else for (const e of ents) if (e.name !== '.' && e.name !== '..') yield* walkTree(c, join(path, e.name), fn, post);
    }
    if (post) yield* fn(path, st);
  }
  P('mkdir', 'ディレクトリを作る', 'mkdir [-p] [-m モード] ディレクトリ…', function* (c) {
    const g = c.getopt('pm:v', { '--parents': 'p', '--mode': 'm' }); if (!g) return 1;
    if (!g.args.length) return c.fail('missing operand');
    let rc = 0;
    const um = yield sys.umask(0); yield sys.umask(um);
    const mode = g.o.m !== undefined ? parseMode(g.o.m, 0o777, true, um) : 0o777;
    if (mode < 0) return c.fail("invalid mode '" + g.o.m + "'");
    for (const d of g.args) {
      if (g.o.p) {
        const parts = d.split('/');
        let cur = d[0] === '/' ? '/' : '', err = 0;
        for (let i = 0; i < parts.length; i++) {
          if (parts[i] === '') continue;
          cur += (cur && !cur.endsWith('/') ? '/' : '') + parts[i];
          const r = yield sys.mkdir(cur, 0o777);
          if (r < 0 && !(r === -E.EEXIST && isDir(yield sys.stat(cur)))) { err = r; break; }
        }
        if (err) { c.err("mkdir: cannot create directory '" + d + "': " + strerror(err) + '\n'); rc = 1; } else if (g.o.m !== undefined) yield sys.chmod(d, mode);
        continue;
      }
      const r = yield sys.mkdir(d, mode);
      if (r < 0) { c.err("mkdir: cannot create directory '" + d + "': " + strerror(r) + '\n'); rc = 1; } else if (g.o.m !== undefined) yield sys.chmod(d, mode);
    }
    return rc;
  });
  P('rmdir', '空のディレクトリを消す', 'rmdir ディレクトリ…', function* (c) {
    const g = c.getopt('p'); if (!g) return 1;
    if (!g.args.length) return c.fail('missing operand');
    let rc = 0;
    for (let d of g.args) {
      for (;;) {
        const r = yield sys.rmdir(d);
        if (r < 0) { c.err("rmdir: failed to remove '" + d + "': " + strerror(r) + '\n'); rc = 1; break; }
        if (!g.o.p) break;
        d = dirname(d);
        if (d === '.' || d === '/') break;
      }
    }
    return rc;
  });
  P('rm', 'ファイルを消す（ディレクトリは -r）', 'rm [-r] [-f] [-i] [-v] ファイル…', function* (c) {
    const g = c.getopt('rRfviP', { '--recursive': 'r', '--force': 'f', '--no-preserve-root': 'P', '--preserve-root': 'Q', '--interactive': 'i' }); if (!g) return 1;
    { const fl = c.argv.slice(1).filter((a) => /^-[^-]/.test(a)).join('').replace(/[^fi]/g, ''); if (fl) { if (fl[fl.length - 1] === 'f') delete g.o.i; else delete g.o.f; } }
    const rec = g.o.r || g.o.R;
    // GNU rm は rm -r / を断る（--no-preserve-root をつけない限り）
    if (rec && !g.o.P) { const keep = []; for (const a of g.args) { if (U.normpath(a[0] === '/' ? a : '/x/' + a) === '/' && a[0] === '/') { c.err("rm: it is dangerous to operate recursively on '" + a + "'\nrm: use --no-preserve-root to override this failsafe\n"); c.rc = 1; } else keep.push(a); } if (keep.length !== g.args.length) { g.args = keep; if (!keep.length) return 1; } }
    if (!g.args.length) { if (g.o.f) return 0; return c.fail('missing operand'); }
    let rc = 0;
    // GNU rm の問い合わせ：-i は 1 つずつ、-f がなく端末から打っていて書き込めないファイルは「write-protected」
    const tty = !g.o.f && (yield* c.isatty(0));
    const kind = (st) => { const t = typeCh(st); return t === 'd' ? 'directory' : t === 'l' ? 'symbolic link' : t === 'p' ? 'fifo' : t === 'c' ? 'character special file' : t === 'b' ? 'block special file' : t === 's' ? 'socket' : st.size ? 'regular file' : 'regular empty file'; };
    function* ok(p, st, what) {
      const wp = typeCh(st) !== 'l' && (yield sys.access(p, 2)) < 0;
      if (g.o.i || (wp && tty && !g.o.f)) return yield* c.ask('rm: ' + (what || 'remove ' + (wp ? 'write-protected ' : '') + kind(st)) + " '" + p + "'? ");
      return true;
    }
    function* rm(p) {
      const st = yield sys.lstat(p);
      if (isErr(st)) { if (!(g.o.f && st === -E.ENOENT)) { c.err("rm: cannot remove '" + p + "': " + strerror(st) + '\n'); rc = 1; } return; }
      if (isDir(st)) {
        if (!rec) { c.err("rm: cannot remove '" + p + "': Is a directory\n"); rc = 1; return; }
        const ents = yield* c.readDir(p);
        if (isErr(ents)) { c.err("rm: cannot remove '" + p + "': " + strerror(ents) + '\n'); rc = 1; return; }
        const kids = ents.filter((e) => e.name !== '.' && e.name !== '..');
        if (kids.length && g.o.i && !(yield* c.ask("rm: descend into directory '" + p + "'? "))) return;
        for (const e of kids) yield* rm(join(p, e.name));
        if (!(yield* ok(p, st))) return;
        const r = yield sys.rmdir(p);
        if (r < 0) { c.err("rm: cannot remove '" + p + "': " + strerror(r) + '\n'); rc = 1; } else if (g.o.v) c.out("removed directory '" + p + "'\n");
        return;
      }
      if (!(yield* ok(p, st))) return;
      const r = yield sys.unlink(p);
      if (r < 0) { c.err("rm: cannot remove '" + p + "': " + strerror(r) + '\n'); rc = 1; } else if (g.o.v) c.out("removed '" + p + "'\n");
    }
    for (const f of g.args) {
      if (/(^|\/)\.\.?\/*$/.test(f)) { c.err("rm: refusing to remove '.' or '..' directory: skipping '" + f + "'\n"); rc = 1; continue; }
      yield* rm(f);
    }
    return rc;
  });
  function* copyFile(c, src, dst, st, preserve) {
    const t = typeCh(st);
    if (t === 'l') { const tg = yield sys.readlink(src); yield sys.unlink(dst); const r = yield sys.symlink(tg, dst); if (r < 0) { c.err(c.name + ": cannot create symbolic link '" + dst + "': " + strerror(r) + '\n'); return 1; } return 0; }
    const dstSt = yield sys.stat(dst);
    if (typeof dstSt === 'object' && dstSt.ino === st.ino && dstSt.dev === st.dev) { c.err(c.name + ": '" + src + "' and '" + dst + "' are the same file\n"); return 1; }
    const sfd = yield sys.open(src, O.RDONLY);
    if (sfd < 0) { c.err(c.name + ": cannot open '" + src + "' for reading: " + strerror(sfd) + '\n'); return 1; }
    const dfd = yield sys.open(dst, O.WRONLY | O.CREAT | O.TRUNC, st.mode & 0o777);
    if (dfd < 0) { yield sys.close(sfd); c.err(c.name + ": cannot create regular file '" + dst + "': " + strerror(dfd) + '\n'); return 1; }
    let rc = 0;
    for (;;) {
      const d = yield sys.read(sfd, 4096);
      if (typeof d === 'number') { if (d === -E.EINTR) continue; c.err(c.name + ": error reading '" + src + "': " + strerror(d) + '\n'); rc = 1; break; }
      if (d === '') break;
      const w = yield* c.writeAll(dfd, d);
      if (w < 0) { c.err(c.name + ": error writing '" + dst + "': " + strerror(w) + '\n'); rc = 1; break; }
    }
    yield sys.close(sfd); yield sys.close(dfd);
    if (preserve && !rc) { yield sys.chmod(dst, st.mode & 0o7777); yield sys.utimensat(dst, { atime: st.atime, mtime: st.mtime }); yield sys.chown(dst, st.uid, st.gid); }
    return rc;
  }
  function* copyTree(c, src, dst, o) {
    const st = o.P ? yield sys.lstat(src) : yield sys.stat(src);
    if (isErr(st)) { c.err(c.name + ": cannot stat '" + src + "': " + strerror(st) + '\n'); return 1; }
    if (!isDir(st)) { const r = yield* copyFile(c, src, dst, st, o.p); if (!r && o.v) c.out("'" + src + "' -> '" + dst + "'\n"); return r; }
    if (!o.r) { c.err(c.name + ": -r not specified; omitting directory '" + src + "'\n"); return 1; }
    const dreal = yield* realpath(c, dst), sreal = yield* realpath(c, src);
    if (dreal && sreal && (dreal === sreal || dreal.startsWith(sreal + '/'))) { c.err(c.name + ": cannot copy a directory, '" + src + "', into itself, '" + dst + "'\n"); return 1; }
    const r = yield sys.mkdir(dst, st.mode & 0o777);
    if (r < 0 && !(r === -E.EEXIST && isDir(yield sys.stat(dst)))) { c.err(c.name + ": cannot create directory '" + dst + "': " + strerror(r) + '\n'); return 1; }
    if (o.v) c.out("'" + src + "' -> '" + dst + "'\n");
    const ents = yield* c.readDir(src);
    if (isErr(ents)) { c.err(c.name + ": cannot access '" + src + "': " + strerror(ents) + '\n'); return 1; }
    let rc = 0;
    for (const e of ents) if (e.name !== '.' && e.name !== '..') rc |= yield* copyTree(c, join(src, e.name), join(dst, e.name), Object.assign({}, o, { P: true }));
    if (o.p) { yield sys.chmod(dst, st.mode & 0o7777); yield sys.utimensat(dst, { atime: st.atime, mtime: st.mtime }); }
    return rc;
  }
  P('cp', 'ファイルをコピーする（ディレクトリは -r）', 'cp [-r] [-p] [-i] [-v] コピー元… コピー先', function* (c) {
    const g = c.getopt('rRpavfi', { '--recursive': 'r' }); if (!g) return 1;
    const o = { r: g.o.r || g.o.R || g.o.a, p: g.o.p || g.o.a, v: g.o.v, P: !!g.o.a };
    if (!g.args.length) return c.fail('missing file operand');
    if (g.args.length < 2) return c.fail("missing destination file operand after '" + g.args[0] + "'");
    const dst = g.args[g.args.length - 1], srcs = g.args.slice(0, -1), dd = isDir(yield sys.stat(dst));
    if (srcs.length > 1 && !dd) return c.fail("target '" + dst + "' is not a directory");
    let rc = 0;
    for (const s of srcs) {
      const to = dd ? join(dst, basename(s)) : dst;
      if (!dd && /\/$/.test(to) && !isErr(yield sys.lstat(s)) && !isDir(yield sys.stat(s))) { c.err("cp: cannot create regular file '" + to + "': Not a directory\n"); rc = 1; continue; }
      if (g.o.i && !g.o.f && !isErr(yield sys.lstat(to)) && !isDir(yield sys.stat(s)) && !(yield* c.ask("cp: overwrite '" + to + "'? "))) continue;
      rc |= yield* copyTree(c, s, to, o);
    }
    return rc;
  });
  P('mv', 'ファイルを移動する・名前を変える', 'mv [-i] [-n] [-v] 移動元… 移動先', function* (c) {
    const g = c.getopt('fivn'); if (!g) return 1;
    const fl = c.argv.slice(1).filter((a) => /^-[^-]/.test(a)).join('').replace(/[^fin]/g, ''), mi = fl[fl.length - 1] === 'i';
    if (!g.args.length) return c.fail('missing file operand');
    if (g.args.length < 2) return c.fail("missing destination file operand after '" + g.args[0] + "'");
    const dst = g.args[g.args.length - 1], srcs = g.args.slice(0, -1), dd = isDir(yield sys.stat(dst));
    if (srcs.length > 1 && !dd) return c.fail("target '" + dst + "' is not a directory");
    let rc = 0;
    for (const s of srcs) {
      const to = dd ? join(dst, basename(s)) : dst;
      const st = yield sys.lstat(s);
      if (isErr(st)) { c.err("mv: cannot stat '" + s + "': " + strerror(st) + '\n'); rc = 1; continue; }
      if (!isErr(yield sys.lstat(to))) {
        if (g.o.n) continue;
        if (mi && !(yield* c.ask("mv: overwrite '" + to + "'? "))) continue;
      }
      let r = yield sys.rename(s, to);
      if (r === -E.EXDEV) {
        r = yield* copyTree(c, s, to, { r: true, p: true, P: true });
        if (!r) { const a = c.argv; c.argv = ['rm', '-rf', s]; const nm = c.name; c.name = 'mv'; yield* LNX.bin.rm.main(c); c.argv = a; c.name = nm; }
        rc |= r; continue;
      }
      if (r < 0) { c.err(r === -E.EINVAL ? "mv: cannot move '" + s + "' to a subdirectory of itself, '" + to + "'\n" : "mv: cannot move '" + s + "' to '" + to + "': " + strerror(r) + '\n'); rc = 1; } else if (g.o.v) c.out("renamed '" + s + "' -> '" + to + "'\n");
    }
    return rc;
  });
  P('ln', 'リンクを作る（-s でシンボリックリンク、なしでハードリンク）', 'ln [-s] [-f] 元のファイル [リンクの名前]', function* (c) {
    const g = c.getopt('sfvn', { '--symbolic': 's', '--force': 'f' }); if (!g) return 1;
    if (!g.args.length) return c.fail('missing file operand');
    let targets = g.args.slice(0, -1), dst = g.args[g.args.length - 1];
    if (g.args.length === 1) { targets = [g.args[0]]; dst = '.'; }
    const dd = isDir(yield sys.stat(dst));
    if (targets.length > 1 && !dd) return c.fail("target '" + dst + "' is not a directory");
    let rc = 0;
    for (const t of targets) {
      const name = dd ? join(dst, basename(t)) : dst;
      if (g.o.f) yield sys.unlink(name);
      const r = g.o.s ? yield sys.symlink(t, name) : yield sys.link(t, name);
      if (r < 0) {
        if (!g.o.s && r === -E.EPERM && isDir(yield sys.stat(t))) c.err('ln: ' + t + ': hard link not allowed for directory\n');
        else if (!g.o.s && r === -E.ENOENT && isErr(yield sys.lstat(t))) c.err("ln: failed to access '" + t + "': " + strerror(r) + '\n');
        else c.err('ln: failed to create ' + (g.o.s ? 'symbolic' : 'hard') + " link '" + name + "'" + (g.o.s ? '' : " => '" + t + "'") + ': ' + strerror(r) + '\n');
        rc = 1;
      } else if (g.o.v) c.out("'" + name + "' " + (g.o.s ? '->' : '=>') + " '" + t + "'\n");
    }
    return rc;
  });
  P('mkfifo', '名前つきパイプ（FIFO）を作る', 'mkfifo 名前…', function* (c) {
    let rc = 0;
    for (const f of c.argv.slice(1)) { const r = yield sys.mknod(f, IFIFO | 0o666, 0); if (r < 0) { c.err("mkfifo: cannot create fifo '" + f + "': " + strerror(r) + '\n'); rc = 1; } }
    return rc;
  });

  // ════════════════════════ 権限とユーザー ════════════════════════
  P('chmod', 'ファイルの権限（rwx）を変える', 'chmod [-R] モード ファイル…   モードは 644 や u+x の形', function* (c) {
    const av = c.argv.slice(1);
    let rec = false, verbose = false;
    while (av.length && /^-[Rvcf]+$/.test(av[0])) { const f = av.shift(); if (f.indexOf('R') >= 0) rec = true; if (f.indexOf('v') >= 0) verbose = true; }
    if (av[0] === '--') av.shift();
    if (!av.length) return c.fail('missing operand');
    if (av.length < 2) return c.fail("missing operand after '" + av[0] + "'");
    const spec = av[0];
    const um = yield sys.umask(0); yield sys.umask(um);
    if (parseMode(spec, 0, false, um) < 0) return c.fail("invalid mode: '" + spec + "'");
    let rc = 0;
    function* one(p, st) {
      if (isErr(st)) { c.err("chmod: cannot access '" + p + "': " + strerror(st) + '\n'); rc = 1; return; }
      if (typeCh(st) === 'l') return;
      const m = parseMode(spec, st.mode & 0o7777, isDir(st), um);
      const r = yield sys.chmod(p, m);
      if (r < 0) { c.err("chmod: changing permissions of '" + p + "': " + strerror(r) + '\n'); rc = 1; } else if (verbose) c.out("mode of '" + p + "' changed from " + U.oct(st.mode & 0o7777, 4) + ' to ' + U.oct(m, 4) + '\n');
    }
    for (const f of av.slice(1)) { if (rec) yield* walkTree(c, f, one, false); else yield* one(f, yield sys.stat(f)); }
    return rc || (c.rc | 0);
  });
  const chownMain = function* (c) {
    const av = c.argv.slice(1), grpOnly = c.name === 'chgrp';
    let rec = false;
    while (av.length && /^-[Rvhcf]+$/.test(av[0])) { if (av.shift().indexOf('R') >= 0) rec = true; }
    if (!av.length) return c.fail('missing operand');
    if (av.length < 2) return c.fail("missing operand after '" + av[0] + "'");
    let us = av[0], gs = null;
    if (grpOnly) { gs = us; us = ''; } else { const m = /^([^:.]*)[:.](.*)$/.exec(us); if (m) { us = m[1]; gs = m[2]; } }
    let uid = -1, gid = -1;
    if (us !== '') { const u = (yield* c.passwd()).find((x) => x.name === us); if (u) { uid = u.uid; if (gs === '') gid = u.gid; } else if (/^\d+$/.test(us)) uid = +us; else return c.fail("invalid user: '" + av[0] + "'"); }
    if (gs) { const gr = (yield* c.group()).find((x) => x.name === gs); if (gr) gid = gr.gid; else if (/^\d+$/.test(gs)) gid = +gs; else return c.fail("invalid group: '" + (grpOnly ? gs : av[0]) + "'"); }
    let rc = 0;
    function* one(p, st) {
      if (isErr(st)) { c.err(c.name + ": cannot access '" + p + "': " + strerror(st) + '\n'); rc = 1; return; }
      const r = yield sys.lchown(p, uid, gid);
      if (r < 0) { c.err(c.name + ': changing ' + (grpOnly ? 'group' : 'ownership') + " of '" + p + "': " + strerror(r) + '\n'); rc = 1; }
    }
    for (const f of av.slice(1)) {
      if (rec) yield* walkTree(c, f, one, false); else { const st = yield sys.stat(f); if (isErr(st)) yield* one(f, st); else { const r = yield sys.chown(f, uid, gid); if (r < 0) { c.err(c.name + ': changing ' + (grpOnly ? 'group' : 'ownership') + " of '" + f + "': " + strerror(r) + '\n'); rc = 1; } } }
    }
    return rc;
  };
  P('chown', 'ファイルの持ち主（とグループ）を変える', 'chown [-R] ユーザー[:グループ] ファイル…', chownMain);
  P('chgrp', 'ファイルのグループを変える', 'chgrp [-R] グループ ファイル…', chownMain);
  P('id', 'ユーザー ID とグループ ID を表示する', 'id [-u] [-g] [-G] [-n] [ユーザー]', function* (c) {
    const g = c.getopt('ugGnr'); if (!g) return 1;
    const pw = yield* c.passwd(), gr = yield* c.group();
    let uid, gid, groups, ruid, rgid;
    if (g.args.length) {
      const u = pw.find((x) => x.name === g.args[0]);
      if (!u) { c.err("id: '" + g.args[0] + "': no such user\n"); return 1; }
      uid = u.uid; gid = u.gid; groups = [gid].concat(gr.filter((x) => x.members.indexOf(u.name) >= 0 && x.gid !== gid).map((x) => x.gid));
    } else { ruid = yield sys.getuid(); rgid = yield sys.getgid(); uid = yield sys.geteuid(); gid = yield sys.getegid(); const gs = yield sys.getgroups(); groups = [rgid].concat(gs.filter((x) => x !== rgid)); }
    if (ruid === undefined) { ruid = uid; rgid = gid; }
    if (g.o.r) { uid = ruid; gid = rgid; }
    const un = (u) => { const x = pw.find((y) => y.uid === u); return x ? x.name : null; }, gn = (i) => { const x = gr.find((y) => y.gid === i); return x ? x.name : null; };
    if (g.o.u) c.out((g.o.n ? un(uid) || uid : uid) + '\n');
    else if (g.o.g) c.out((g.o.n ? gn(gid) || gid : gid) + '\n');
    else if (g.o.G) c.out(groups.map((x) => (g.o.n ? gn(x) || x : x)).join(' ') + '\n');
    else c.out('uid=' + ruid + (un(ruid) ? '(' + un(ruid) + ')' : '') + ' gid=' + rgid + (gn(rgid) ? '(' + gn(rgid) + ')' : '') + (uid !== ruid ? ' euid=' + uid + (un(uid) ? '(' + un(uid) + ')' : '') : '') + (gid !== rgid ? ' egid=' + gid + (gn(gid) ? '(' + gn(gid) + ')' : '') : '') + ' groups=' + groups.map((x) => x + (gn(x) ? '(' + gn(x) + ')' : '')).join(',') + '\n');
    return 0;
  });
  P('whoami', 'いまのユーザー名を表示する', 'whoami', function* (c) { c.out((yield* c.uname(yield sys.geteuid())) + '\n'); return 0; });
  P('groups', '入っているグループを表示する', 'groups [ユーザー]', function* (c) {
    const gr = yield* c.group();
    let ids;
    if (c.argv[1]) { const u = (yield* c.passwd()).find((x) => x.name === c.argv[1]); if (!u) { c.err("groups: '" + c.argv[1] + "': no such user\n"); return 1; } ids = [u.gid].concat(gr.filter((x) => x.members.indexOf(u.name) >= 0 && x.gid !== u.gid).map((x) => x.gid)); } else { const gid = yield sys.getegid(); ids = [gid].concat((yield sys.getgroups()).filter((x) => x !== gid)); }
    c.out((c.argv[1] ? c.argv[1] + ' : ' : '') + ids.map((i) => { const x = gr.find((y) => y.gid === i); return x ? x.name : i; }).join(' ') + '\n');
    return 0;
  });
  function* become(c, u, login) {
    const gr = yield* c.group();
    const groups = [u.gid].concat(gr.filter((x) => x.members.indexOf(u.name) >= 0 && x.gid !== u.gid).map((x) => x.gid)).sort((a, b) => a - b);
    let r = yield sys.setgroups(groups);
    if (r >= 0) r = yield sys.setgid(u.gid);
    if (r >= 0) r = yield sys.setuid(u.uid);
    if (r < 0) return r;
    const env = Object.assign({}, c.env, { HOME: u.home, USER: u.name, LOGNAME: u.name, SHELL: u.shell || '/bin/sh' });
    if (u.uid === 0) env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'; else if (login) env.PATH = '/usr/local/bin:/usr/bin:/bin';
    if (login) { if ((yield sys.chdir(u.home)) >= 0) env.PWD = u.home; else { yield sys.chdir('/'); env.PWD = '/'; } }
    return env;
  }
  // ── パスワード（/etc/shadow）──
  function* shadowRead(c) {
    const d = yield* c.slurp('/etc/shadow');
    return typeof d === 'string' ? d.split('\n').filter(Boolean).map((l) => l.split(':')) : [];
  }
  // 端末から 1 行読む（本物は端末の表示（エコー）を止めて読むので、打った文字は画面に出ない）。EOF なら null
  function* readPw(c, prompt) {
    yield* c.flush();
    yield sys.write(2, prompt);
    let l = '', got = false;
    for (;;) { const r = yield sys.read(0, 1); if (typeof r === 'number') { if (r === -E.EINTR) continue; break; } if (r === '') break; got = true; if (r === '\n') break; l += r; }
    yield sys.write(2, '\n');
    return got ? l : null;
  }
  function* checkPw(c, user, prompt) {
    const e = (yield* shadowRead(c)).find((f) => f[0] === user);
    const pw = yield* readPw(c, prompt);
    if (!e || pw === null) return false;
    if (e[1] === '') return true;
    if (!/^\$/.test(e[1])) return false;   // * や ! で始まる：ロックされている
    return U.crypt(pw, e[1].split('$')[3]) === e[1];
  }
  P('passwd', 'パスワードを変える（-S で状態を表示する）', 'passwd [-S] [-l] [-u] [-d] [ユーザー]', function* (c) {
    const g = c.getopt('Slud', { '--status': 'S', '--lock': 'l', '--unlock': 'u', '--delete': 'd' }); if (!g) return 2;
    const ruid = yield sys.getuid(), pw = yield* c.passwd(), me = pw.find((x) => x.uid === ruid);
    const name = g.args[0] || (me ? me.name : String(ruid));
    if (!pw.find((x) => x.name === name)) { c.err("passwd: user '" + name + "' does not exist\n"); return 1; }
    if (ruid !== 0 && (name !== (me && me.name) || g.o.l || g.o.u || g.o.d)) { c.err('passwd: You may not view or modify password information for ' + name + '.\n'); return 1; }
    const rows = yield* shadowRead(c), e = rows.find((f) => f[0] === name);
    if (!e) { c.err('passwd: cannot find ' + name + ' in /etc/shadow\n'); return 1; }
    const today = Math.floor((yield sys.time()) / 86400000);
    const save = function* () {
      const fd = yield sys.open('/etc/shadow', O.WRONLY | O.TRUNC);
      if (fd < 0) return fd;
      yield* c.writeAll(fd, rows.map((f) => f.join(':')).join('\n') + '\n');
      yield sys.close(fd);
      return 0;
    };
    if (g.o.S) { const st = e[1] === '' ? 'NP' : /^[!*]/.test(e[1]) ? 'L' : 'P'; c.out(name + ' ' + st + ' ' + U.strftime('%Y-%m-%d', (+e[2] || 0) * 86400000) + ' ' + (e[3] || 0) + ' ' + (e[4] || 99999) + ' ' + (e[5] || 7) + ' ' + (e[6] === '' || e[6] === undefined ? -1 : e[6]) + '\n'); return 0; }
    if (g.o.l || g.o.u || g.o.d) {
      if (g.o.l && e[1][0] !== '!') e[1] = '!' + e[1];
      if (g.o.u) { if (e[1] === '!' ) { c.err('passwd: unlocking the password would result in a passwordless account.\n'); return 3; } e[1] = e[1].replace(/^!/, ''); }
      if (g.o.d) e[1] = '';
      const r = yield* save(); if (r < 0) return c.perr('/etc/shadow', r);
      c.out('passwd: password changed.\n'); return 0;
    }
    const unchanged = (msg) => { c.err((msg ? msg + '\n' : '') + 'passwd: Authentication token manipulation error\npasswd: password unchanged\n'); return 10; };
    if (ruid !== 0) {
      c.out('Changing password for ' + name + '.\n');
      if (!(yield* checkPw(c, name, 'Current password: '))) { yield sys.nanosleep(2000); return unchanged(); }
    }
    const p1 = yield* readPw(c, 'New password: ');
    if (p1 === null || p1 === '') return unchanged('No password has been supplied.');
    const p2 = yield* readPw(c, 'Retype new password: ');
    if (p1 !== p2) return unchanged('Sorry, passwords do not match.');
    e[1] = U.crypt(p1, U.saltOf(name + today + p1.length)); e[2] = String(today);
    const r = yield* save(); if (r < 0) return c.perr('/etc/shadow', r);
    c.out('passwd: password updated successfully\n');
    return 0;
  }, { suid: true, late: true });
  P('su', '別のユーザー（指定しなければ root）になってシェルを始める', 'su [-] [ユーザー] [-c コマンド]', function* (c) {
    let login = false, user = 'root', cmd = null;
    for (let i = 1; i < c.argv.length; i++) { const a = c.argv[i]; if (a === '-' || a === '-l' || a === '--login') login = true; else if (a === '-c') cmd = c.argv[++i]; else if (a[0] === '-') return c.fail("invalid option -- '" + a.slice(1) + "'"); else user = a; }
    const u = (yield* c.passwd()).find((x) => x.name === user);
    if (!u) { c.err('su: user ' + user + ' does not exist or the user entry does not contain all the required fields\n'); return 1; }
    // root 以外が使うときは、なる相手のパスワードをたずねる（PAM と同じく、間違えたら 2 秒待たせてから断る）
    if ((yield sys.getuid()) !== 0 && !(yield* checkPw(c, user, 'Password: '))) { yield sys.nanosleep(2000); c.err('su: Authentication failure\n'); return 1; }
    const env = yield* become(c, u, login);
    if (typeof env === 'number') { c.err('su: Authentication failure\n'); return 1; }
    const sh = /nologin$/.test(u.shell || '') ? u.shell : '/bin/sh';
    const r = yield sys.execve(sh, cmd !== null ? ['sh', '-c', cmd] : ['sh'], env);
    return c.perr(sh, r);
  }, { suid: true });
  P('sudo', 'コマンドを root（または -u で指定したユーザー）として実行する', 'sudo [-u ユーザー] コマンド [引数…]', function* (c) {
    let user = 'root', i = 1, shell = false, login = false;
    for (; i < c.argv.length; i++) { const a = c.argv[i]; if (a === '-u') user = c.argv[++i]; else if (a === '-i') { shell = true; login = true; } else if (a === '-s') shell = true; else if (a === '-l' && c.argv.length === 2) break; else if (a === '--') { i++; break; } else if (a[0] === '-') return c.fail("invalid option -- '" + a.slice(1) + "'"); else break; }
    const pw = yield* c.passwd(), ruid = yield sys.getuid(), me = pw.find((x) => x.uid === ruid);
    if (c.argv.length === 1) { c.err('usage: sudo [-u user] command\n'); return 1; }
    const sg = (yield* c.group()).find((x) => x.name === 'sudo');
    const allowed = ruid === 0 || (sg && me && sg.members.indexOf(me.name) >= 0);
    const host = String((yield sys.uname()).nodename || 'localhost');
    // 許されていない人には、まず本人のパスワードをたずねる（/etc/sudoers の NOPASSWD は sudo グループにだけ効く）
    if (!allowed) {
      let ok = false;
      for (let t = 0; t < 3 && !ok; t++) { const r = yield* checkPw(c, me ? me.name : String(ruid), '[sudo] password for ' + (me ? me.name : ruid) + ': '); if (r) ok = true; else { yield sys.nanosleep(2000); if (t < 2) c.err('Sorry, try again.\n'); } yield* c.flush(); }
      if (!ok) { c.err('sudo: 3 incorrect password attempts\n'); return 1; }
      c.err(c.argv[1] === '-l' ? 'Sorry, user ' + (me ? me.name : ruid) + ' may not run sudo on ' + host + '.\n' : (me ? me.name : ruid) + ' is not in the sudoers file.\n');
      return 1;
    }
    if (c.argv[1] === '-l') {
      c.out('Matching Defaults entries for ' + (me ? me.name : ruid) + ' on ' + host + ':\n    env_reset, mail_badpass, secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin\\:/sbin\\:/bin, use_pty\n\nUser ' + (me ? me.name : ruid) + ' may run the following commands on ' + host + ':\n    (ALL : ALL) NOPASSWD: ALL\n');
      return 0;
    }
    const u = pw.find((x) => x.name === user);
    if (!u) { c.err('sudo: unknown user ' + user + '\n'); return 1; }
    const env = yield* become(c, u, login);
    if (typeof env === 'number') { c.err('sudo: unable to change to ' + user + ': ' + strerror(env) + '\n'); return 1; }
    env.SUDO_USER = me ? me.name : String(ruid); env.SUDO_UID = String(ruid); env.SUDO_COMMAND = c.argv.slice(i).join(' ');
    env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    const argv = shell ? ['sh'].concat(i < c.argv.length ? ['-c', c.argv.slice(i).join(' ')] : []) : c.argv.slice(i);
    if (!argv.length) { c.err('usage: sudo [-u user] command\n'); return 1; }
    const path = shell ? '/bin/sh' : yield* c.which(argv[0], env.PATH);
    if (!path) { c.err('sudo: ' + argv[0] + ': command not found\n'); return 1; }
    const r = yield sys.execve(path, argv, env);
    if (r === -E.ENOEXEC) yield sys.execve('/bin/sh', ['sh', path].concat(argv.slice(1)), env);
    c.err('sudo: ' + argv[0] + ': ' + strerror(r) + '\n');
    return 1;
  }, { suid: true });

  // ════════════════════════ 正規表現（POSIX の BRE / ERE → JavaScript）════════════════════════
  const CLS = { alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', cntrl: '\\x00-\\x1f\\x7f', print: ' -~', graph: '!-~' };
  function posixRe(pat, ere) {
    let o = '', i = 0;
    const n = pat.length;
    let atStart = true;
    while (i < n) {
      const ch = pat[i];
      if (ch === '\\' && i + 1 < n) {
        const d = pat[++i];
        if (!ere && '(){}|+?'.indexOf(d) >= 0) { o += d; atStart = d === '(' || d === '|'; i++; continue; }
        if (d === '<' || d === '>') o += '\\b'; else if ('wWsSbBdD'.indexOf(d) >= 0 || (d >= '1' && d <= '9')) o += '\\' + d; else if (d === 'n') o += '\\n'; else if (d === 't') o += '\\t'; else o += /[\^$.*+?()[\]{}|\\\/-]/.test(d) ? '\\' + d : d;
        i++; atStart = false; continue;
      }
      if (ch === '[') {
        let j = i + 1, cls = '', neg = false;
        if (pat[j] === '^') { neg = true; j++; }
        let first = true, ok = false;
        for (; j < n; j++) {
          const d = pat[j];
          if (d === ']' && !first) { ok = true; break; }
          first = false;
          if (d === '[' && pat[j + 1] === ':') { const e = pat.indexOf(':]', j + 2); if (e > 0 && CLS[pat.slice(j + 2, e)]) { cls += CLS[pat.slice(j + 2, e)]; j = e + 1; continue; } }
          cls += d === '\\' || d === ']' || d === '[' || d === '^' ? '\\' + d : d;
        }
        if (!ok) throw new Error('Unmatched [, [^, [:, [., or [=');
        o += '[' + (neg ? '^' : '') + cls + ']'; i = j + 1; atStart = false; continue;
      }
      if (!ere && '(){}|+?'.indexOf(ch) >= 0) { o += '\\' + ch; i++; atStart = false; continue; }
      if (ch === '*' && atStart) { o += '\\*'; i++; atStart = false; continue; }
      if (ch === '^' && !ere && !atStart) { o += '\\^'; i++; continue; }
      if (ch === '$' && !ere && i + 1 < n && !(pat[i + 1] === '\\' && (pat[i + 2] === ')' || pat[i + 2] === '|'))) { o += '\\$'; i++; continue; }
      if (ch === '{' && ere && !/^\{\d+(,\d*)?\}/.test(pat.slice(i))) { o += '\\{'; i++; continue; }
      if (ch === '}' && ere && !/\{\d+(,\d*)?$/.test(pat.slice(0, i))) { o += '\\}'; i++; continue; }
      if (ch === '/') { o += '\\/'; i++; atStart = false; continue; }
      o += ch; i++;
      atStart = ch === '^' || (ere && (ch === '(' || ch === '|'));
    }
    return o;
  }
  const fixedRe = (s) => s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
  // パターン（バイト列）→ { test(line), exec… }。マルチバイトを含むときは UTF-16 に直して照合する
  function mkMatcher(pats, o) {
    const hi = pats.some((p) => HI.test(p));
    let src = pats.map((p) => { const q = hi ? dec(p) : p; return o.F ? fixedRe(q) : posixRe(q, o.E); }).join('|');
    if (o.w) src = '(?<![A-Za-z0-9_])(?:' + src + ')(?![A-Za-z0-9_])';
    if (o.x) src = '^(?:' + src + ')$';
    const mk = (u, g) => new RegExp(src, (o.i ? 'i' : '') + (u ? 'u' : '') + (g ? 'g' : ''));
    const re = mk(hi, false);
    let reU = hi ? re : null;
    return {
      test(l) { if (!hi && !HI.test(l)) return re.test(l); if (!reU) reU = mk(true, false); return reU.test(dec(l)); },
      all(l) { const u = hi || HI.test(l), r = mk(u, true), s = u ? dec(l) : l, out = []; let m; while ((m = r.exec(s))) { if (m[0] === '') { r.lastIndex++; continue; } out.push(u ? enc(m[0]) : m[0]); } return out; },
      replace(l, rep, global, nth) {
        const u = hi || HI.test(l) || HI.test(rep), r = mk(u, true), s = u ? dec(l) : l, rp = u ? dec(rep) : rep;
        let k = 0, hit = false;
        const res = s.replace(r, (...m) => {
          k++;
          if (!(global ? k >= (nth || 1) : k === (nth || 1))) return m[0];
          hit = true;
          return rp.replace(/\\([0-9&n\\])|&/g, (x, d) => (x === '&' ? m[0] : d === '&' ? '&' : d === 'n' ? '\n' : d === '\\' ? '\\' : m[+d] === undefined ? '' : d === '0' ? m[0] : m[+d]));
        });
        return { s: u ? enc(res) : res, hit };
      },
    };
  }

  // ════════════════════════ テキスト処理 ════════════════════════
  P('grep', 'パターンに合う行を探して表示する', 'grep [-i] [-v] [-c] [-n] [-E] [-F] [-r] [-l] [-o] [-w] [-q] パターン [ファイル…]', function* (c) {
    const g = c.getopt('ivcnEFrRlLqowxhHse:A:B:C:m:', { '--ignore-case': 'i', '--invert-match': 'v', '--count': 'c', '--line-number': 'n', '--extended-regexp': 'E', '--fixed-strings': 'F', '--recursive': 'r', '--quiet': 'q', '--only-matching': 'o', '--regexp': 'e' }); if (!g) return 2;
    const o = g.o, args = g.args.slice();
    if (c.name === 'egrep') o.E = 1; if (c.name === 'fgrep') o.F = 1;
    // -e は何回でも書ける（どれかに合えばよい）
    const es = []; for (let i = 1; i < c.argv.length; i++) { const x = c.argv[i]; if (x === '--') break; if (x === '-e' || x === '--regexp') { if (c.argv[i + 1] !== undefined) es.push(c.argv[++i]); } else if (/^--regexp=/.test(x)) es.push(x.slice(9)); else if (/^-[A-Za-z]*e/.test(x) && x[1] !== '-') { const k = x.indexOf('e'); if (!/[ABCm]/.test(x.slice(1, k))) { if (k + 1 < x.length) es.push(x.slice(k + 1)); else if (c.argv[i + 1] !== undefined) es.push(c.argv[++i]); } } else if (/^-[ABCm]$/.test(x)) i++; }
    let pats = o.e !== undefined ? (es.length ? [].concat(...es.map((e) => e.split('\n'))) : [o.e]) : null;
    if (!pats) { if (!args.length) { c.err('Usage: grep [OPTION]... PATTERNS [FILE]...\n'); return 2; } pats = args.shift().split('\n'); }
    const rec = o.r || o.R;
    let m;
    try { m = mkMatcher(pats, o); } catch (e) { c.err('grep: ' + (e.message || 'invalid regular expression').replace(/^Invalid regular expression: /, '') + '\n'); return 2; }
    const files = args.length ? args : [rec ? '.' : '-'];
    let showName = (files.length > 1 || rec) && !o.h;
    if (o.H) showName = true;
    let found = false, rc = 0;
    const after = +(o.A !== undefined ? o.A : o.C) || 0, before = +(o.B !== undefined ? o.B : o.C) || 0, max = o.m !== undefined ? +o.m : Infinity;
    function* one(f, label) {
      const d = yield* c.slurp(f);
      if (typeof d === 'number') { if (!o.s) c.err('grep: ' + f + ': ' + strerror(d) + '\n'); rc = 2; return; }
      const ls = lines(d);
      let cnt = 0, lastOut = -1, aft = 0;
      const pre = (i, sep) => (showName ? label + sep : '') + (o.n ? i + 1 + sep : '');
      for (let i = 0; i < ls.length; i++) {
        const hit = m.test(ls[i]) !== !!o.v;
        if (hit) {
          cnt++; found = true;
          if (o.q) return true;
          if (!o.c && !o.l && !o.L) {
            if (before || after) { if (lastOut >= 0 && i - before > lastOut + 1) c.out('--\n'); for (let j = Math.max(lastOut + 1, i - before); j < i; j++) c.out(pre(j, '-') + ls[j] + '\n'); }
            if (o.o && !o.v) for (const x of m.all(ls[i])) c.out(pre(i, ':') + x + '\n'); else c.out(pre(i, ':') + ls[i] + '\n');
            lastOut = i; aft = after;
          }
          if (cnt >= max) break;
        } else if (aft > 0 && !o.c && !o.l && !o.L) { c.out(pre(i, '-') + ls[i] + '\n'); lastOut = i; aft--; }
        if (c.qn >= 4096) yield* c.flush(true);
      }
      if (o.c) c.out((showName ? label + ':' : '') + cnt + '\n');
      if (o.l && cnt) c.out(label + '\n');
      if (o.L && !cnt) c.out(label + '\n');
      return false;
    }
    function* walk(p) {
      const st = yield sys.stat(p);
      if (isErr(st)) { if (!o.s) c.err('grep: ' + p + ': ' + strerror(st) + '\n'); rc = 2; return false; }
      if (isDir(st)) {
        if (!rec) { if (!o.s) c.err('grep: ' + p + ': Is a directory\n'); return false; }
        const ents = yield* c.readDir(p);
        if (isErr(ents)) { if (!o.s) c.err('grep: ' + p + ': ' + strerror(ents) + '\n'); rc = 2; return false; }
        for (const e of ents.filter((x) => x.name !== '.' && x.name !== '..').sort((a, b) => cmpBytes(a.name, b.name))) if (yield* walk(p === '.' && files[0] === '.' && !args.length ? e.name : join(p, e.name))) return true;
        return false;
      }
      if ((st.mode & IFMT) !== IFREG && rec) return false;
      return yield* one(p, p);
    }
    for (const f of files) { if (f === '-') { if (yield* one('-', '(standard input)')) break; } else if (yield* walk(f)) break; }
    return found ? 0 : rc || 1;
  });
  LNX.bin.egrep = Object.assign({}, LNX.bin.grep, { help: 'grep -E と同じ（拡張正規表現）', usage: 'egrep パターン [ファイル…]' });
  P('sed', '行ごとに置き換えや削除をする（s/古い/新しい/、p、d だけ）', "sed [-n] [-E] 's/正規表現/置き換え/[g]' [ファイル…]", function* (c) {
    let inplace = null;
    c.argv = c.argv.filter((a, i) => { if (i === 0) return true; let m; if ((m = /^-i(.*)$/.exec(a)) && !/^-i?[nEr]+$/.test(a) || (m = /^--in-place(?:=(.*))?$/.exec(a))) { inplace = m[1] || ''; return false; } return true; });
    const g = c.getopt('nEre:s'); if (!g) return 1;
    const args = g.args.slice(), ere = g.o.E || g.o.r;
    const script = g.o.e !== undefined ? g.o.e : args.shift();
    if (script === undefined) { c.err('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n'); return 1; }
    const cmds = [];
    try {
      let s = script, i = 0;
      const addr = () => {
        if (/\d/.test(s[i])) { const m = /^\d+/.exec(s.slice(i)); i += m[0].length; return { n: +m[0] }; }
        if (s[i] === '$') { i++; return { last: true }; }
        if (s[i] === '/') { let j = i + 1, p = ''; for (; j < s.length && s[j] !== '/'; j++) { if (s[j] === '\\' && s[j + 1] === '/') { p += '/'; j++; } else p += s[j]; } i = j + 1; return { re: mkMatcher([p], { E: ere }) }; }
        return null;
      };
      while (i < s.length) {
        while (i < s.length && /[\s;]/.test(s[i])) i++;
        if (i >= s.length) break;
        const cmd = { a1: addr(), a2: null };
        if (cmd.a1 && s[i] === ',') { i++; cmd.a2 = addr(); }
        while (s[i] === ' ') i++;
        if (s[i] === '!') { cmd.neg = true; i++; }
        const ch = s[i++];
        cmd.c = ch;
        if (ch === 's') {
          const dl = s[i++], part = () => { let p = ''; for (; i < s.length && s[i] !== dl; i++) { if (s[i] === '\\' && s[i + 1] === dl) { p += dl; i++; } else if (s[i] === '\\' && (s[i + 1] === 't' || s[i + 1] === 'n')) { p += s[i + 1] === 't' ? '\t' : '\n'; i++; } else if (s[i] === '\\' && i + 1 < s.length) { p += s[i] + s[i + 1]; i++; } else p += s[i]; } if (i >= s.length) throw new Error("unterminated `s' command"); i++; return p; };
          const pat = part(), rep = part();
          const fl = /^[gpiI0-9]*/.exec(s.slice(i))[0]; i += fl.length;
          cmd.re = mkMatcher([pat], { E: ere, i: /[iI]/.test(fl) }); cmd.rep = rep; cmd.g = fl.indexOf('g') >= 0; cmd.p = fl.indexOf('p') >= 0; cmd.nth = +(/\d+/.exec(fl) || [0])[0];
        } else if (ch === 'y') {
          const dl = s[i++], e1 = s.indexOf(dl, i), e2 = s.indexOf(dl, e1 + 1);
          if (e1 < 0 || e2 < 0) throw new Error("unterminated `y' command");
          cmd.from = s.slice(i, e1); cmd.to = s.slice(e1 + 1, e2); i = e2 + 1;
        } else if ('pdq='.indexOf(ch) < 0) throw new Error("unknown command: `" + ch + "'");
        cmds.push(cmd);
      }
    } catch (e) { c.err('sed: -e expression #1, char ' + script.length + ': ' + e.message + '\n'); return 1; }
    let all = [];
    let out = (t) => c.out(t);
    const run = function* () {
    const hit = (a, l, n) => (a.n !== undefined ? a.n === n : a.last ? n === all.length : a.re.test(l));
    for (const cm of cmds) cm.on = false;
    for (let n = 1; n <= all.length; n++) {
      let l = all[n - 1], del = false, quit = false;
      for (const cm of cmds) {
        let sel = true;
        if (cm.a1 && cm.a2) { if (cm.on) { sel = true; if (cm.a2.n !== undefined ? n >= cm.a2.n : hit(cm.a2, l, n)) cm.on = false; } else if (hit(cm.a1, l, n)) { sel = true; cm.on = !(cm.a2.n !== undefined && cm.a2.n <= n); } else sel = false; } else if (cm.a1) sel = hit(cm.a1, l, n);
        if (sel === !!cm.neg) continue;
        if (cm.c === 's') { const r = cm.re.replace(l, cm.rep, cm.g, cm.nth); l = r.s; if (r.hit && cm.p) out(l + '\n'); } else if (cm.c === 'y') l = l.split('').map((ch) => { const k = cm.from.indexOf(ch); return k >= 0 ? cm.to[k] || ch : ch; }).join('');
        else if (cm.c === 'p') out(l + '\n'); else if (cm.c === '=') out(n + '\n'); else if (cm.c === 'd') { del = true; break; } else if (cm.c === 'q') { quit = true; break; }
      }
      if (!del && !g.o.n) out(l + '\n');
      if (quit) break;
      if (c.qn >= 4096) yield* c.flush(true);
    }
    };
    if (inplace === null) { for (const f of args.length ? args : ['-']) { const d = yield* c.cat(f); if (d !== null) for (const l of lines(d)) all.push(l); } yield* run(); } else {
      // -i：ファイルごとに処理して、結果でそのファイルを書き換える
      if (!args.length) { c.err('sed: no input files\n'); return 1; }
      for (const f of args) {
        const d = yield* c.slurp(f);
        if (typeof d !== 'string') { c.err("sed: can't read " + f + ': ' + strerror(d) + '\n'); c.rc = 2; continue; }
        if (inplace) { const bfd = yield sys.open(f + inplace, O.WRONLY | O.CREAT | O.TRUNC, 0o644); if (bfd >= 0) { yield* c.writeAll(bfd, d); yield sys.close(bfd); } }
        all = lines(d);
        let buf = '';
        out = (t) => { buf += t; };
        yield* run();
        const fd = yield sys.open(f, O.WRONLY | O.TRUNC);
        if (fd < 0) { c.err("sed: couldn't open file " + f + ': ' + strerror(fd) + '\n'); c.rc = 4; continue; }
        yield* c.writeAll(fd, buf); yield sys.close(fd);
      }
    }
    return c.rc | 0;
  });
  P('sort', '行を並べ替える', 'sort [-n] [-r] [-u] [-f] [-k 列] [-t 区切り] [ファイル…]', function* (c) {
    const av = c.argv.slice(1), files = [], keys = [];
    const o = {};
    let sep = null;
    const parseKey = (s) => { const m = /^(\d+)(?:\.(\d+))?([a-zA-Z]*)(?:,(\d+)(?:\.(\d+))?([a-zA-Z]*))?$/.exec(s); if (!m) return null; return { f1: +m[1], c1: +(m[2] || 1), f2: m[4] ? +m[4] : 0, c2: +(m[5] || 0), fl: m[3] + (m[6] || '') }; };
    for (let i = 0; i < av.length; i++) {
      const a = av[i];
      if (a === '--') { files.push(...av.slice(i + 1)); break; }
      if (a[0] !== '-' || a === '-') { files.push(a); continue; }
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (f === 'k' || f === 't' || f === 'o') {
          const v = j + 1 < a.length ? a.slice(j + 1) : av[++i];
          if (v === undefined) return c.fail("option requires an argument -- '" + f + "'") + 1;
          if (f === 'k') { const k = parseKey(v); if (!k) { c.err("sort: invalid number at field start: invalid count at start of '" + v + "'\n"); return 2; } keys.push(k); } else if (f === 't') sep = SH.unescape(v).s; else o.o = v;
          break;
        }
        if ('nrufbsVhMdi'.indexOf(f) < 0) { c.err("sort: invalid option -- '" + f + "'\n"); return 2; }
        o[f] = true;
      }
    }
    let all = [];
    for (const f of files.length ? files : ['-']) { const d = yield* c.slurp(f); if (typeof d === 'number') { c.err('sort: cannot read: ' + f + ': ' + strerror(d) + '\n'); return 2; } const ls = lines(d); all = all.length ? all.concat(ls) : ls; }
    const num = (s) => { const m = /^\s*(-?\d*\.?\d+|-?\d+\.?)/.exec(s); return m ? parseFloat(m[1]) : 0; };
    const hnum = (s) => { const m = /^\s*(-?\d*\.?\d+)([KMGTkmgt]?)/.exec(s); return m ? parseFloat(m[1]) * Math.pow(1024, ' KMGT'.indexOf(m[2].toUpperCase()) > 0 ? ' KMGT'.indexOf(m[2].toUpperCase()) : 0) : 0; };
    const fieldsOf = (l) => {
      if (sep !== null) return l.split(sep);
      const out = [], re = /[ \t]*[^ \t]+/g;
      let m;
      while ((m = re.exec(l))) out.push(m[0]);
      return out;
    };
    const keyOf = (l, k) => {
      const fs = fieldsOf(l);
      if (k.f1 > fs.length) return '';
      const j = sep !== null ? sep : '';
      let parts = fs.slice(k.f1 - 1, k.f2 ? k.f2 : fs.length);
      if (!parts.length) return '';
      let s = parts.join(j);
      if (sep === null && (o.b || k.fl.indexOf('b') >= 0 || true)) s = s.replace(/^[ \t]+/, '');
      if (k.c1 > 1) s = s.slice(k.c1 - 1);
      return s;
    };
    const cmp1 = (a, b, fl) => {
      const n = o.n || fl.indexOf('n') >= 0, h = o.h || fl.indexOf('h') >= 0, f = o.f || fl.indexOf('f') >= 0;
      let r;
      if (n) r = num(a) - num(b); else if (h) r = hnum(a) - hnum(b); else if (o.V || fl.indexOf('V') >= 0) r = a.localeCompare(b, 'en', { numeric: true }); else { if (f) { a = a.toUpperCase(); b = b.toUpperCase(); } r = cmpBytes(a, b); }
      return (fl.indexOf('r') >= 0 && !o.r) ? -r : r;
    };
    const keyCmp = (a, b) => {
      if (!keys.length) return cmp1(a, b, '');
      for (const k of keys) { const r = cmp1(keyOf(a, k), keyOf(b, k), k.fl); if (r) return r; }
      return 0;
    };
    const cmp = (a, b) => { let r = keyCmp(a, b); if (!r && !o.s && !o.u) r = cmpBytes(a, b); return o.r ? -r : r; };
    all.sort(cmp);
    if (o.u) all = all.filter((l, i) => i === 0 || keyCmp(all[i - 1], l) !== 0);
    const text = all.length ? all.join('\n') + '\n' : '';
    if (o.o) { const fd = yield sys.open(o.o, O.WRONLY | O.CREAT | O.TRUNC, 0o666); if (fd < 0) { c.err('sort: open failed: ' + o.o + ': ' + strerror(fd) + '\n'); return 2; } yield* c.writeAll(fd, text); yield sys.close(fd); } else c.out(text);
    return 0;
  });
  P('uniq', '隣り合う同じ行を 1 つにまとめる', 'uniq [-c] [-d] [-u] [-i] [ファイル]', function* (c) {
    const g = c.getopt('cdui'); if (!g) return 1;
    if (g.args.length > 2) return c.fail("extra operand '" + g.args[2] + "'");
    const d = yield* c.cat(g.args[0] || '-');
    if (d === null) return 1;
    const ls = lines(d), key = (l) => (g.o.i ? l.toLowerCase() : l);
    for (let i = 0; i < ls.length;) {
      let j = i + 1;
      while (j < ls.length && key(ls[j]) === key(ls[i])) j++;
      const n = j - i;
      if (!(g.o.d && n < 2) && !(g.o.u && n > 1)) c.out((g.o.c ? String(n).padStart(7) + ' ' : '') + ls[i] + '\n');
      i = j;
    }
    return 0;
  });
  P('wc', '行数・単語数・バイト数を数える', 'wc [-l] [-w] [-c] [-m] [ファイル…]', function* (c) {
    const g = c.getopt('lwcmL', { '--lines': 'l', '--words': 'w', '--bytes': 'c', '--chars': 'm' }); if (!g) return 1;
    const o = g.o;
    if (!o.l && !o.w && !o.c && !o.m && !o.L) o.l = o.w = o.c = 1;
    const files = g.args.length ? g.args : ['-'], rows = [];
    let rc = 0, anyPipe = false;
    const tot = [0, 0, 0, 0, 0];
    for (const f of files) {
      if (f === '-') anyPipe = true;
      const d = yield* c.slurp(f);
      if (typeof d === 'number') { rows.push({ err: 'wc: ' + f + ': ' + strerror(d) + '\n' }); rc = 1; continue; }
      let nl = 0;
      for (let i = d.indexOf('\n'); i >= 0; i = d.indexOf('\n', i + 1)) nl++;
      const words = (d.match(/[^\s]+/g) || []).length;
      const v = [nl, words, o.m ? Array.from(dec(d)).length : 0, d.length, o.L ? Math.max(0, ...d.split('\n').map((l) => dec(l).length)) : 0];
      for (let i = 0; i < 4; i++) tot[i] += v[i];
      tot[4] = Math.max(tot[4], v[4]);
      rows.push({ v, name: f === '-' && !g.args.length ? '' : f });
    }
    if (files.length > 1) rows.push({ v: tot, name: 'total' });
    const cols = [o.l, o.w, o.m, o.c, o.L].map(Boolean), ncol = cols.filter(Boolean).length;
    let w = 1;
    if (ncol > 1 || files.length > 1) { w = anyPipe ? 7 : String(Math.max(tot[3], 1)).length; if (!o.c && !anyPipe) w = Math.max(w, String(Math.max(...tot)).length); }
    for (const r of rows) {
      if (r.err) { yield* c.flush(); c.err(r.err); continue; }
      c.out(r.v.filter((x, i) => cols[i]).map((x) => String(x).padStart(w)).join(' ') + (r.name ? ' ' + r.name : '') + '\n');
    }
    return rc;
  });
  const headTail = function* (c) {
    const isHead = c.name === 'head', av = c.argv.slice(1), files = [];
    let n = 10, bytes = false, from = false, quiet = false, follow = false, neg = false;
    for (let i = 0; i < av.length; i++) {
      const a = av[i];
      let m;
      if (a === '--') { files.push(...av.slice(i + 1)); break; }
      if ((m = /^-(\d+)$/.exec(a))) n = +m[1];
      else if ((m = /^-([nc])(.*)$/.exec(a)) || (m = /^--(lines|bytes)=(.*)$/.exec(a))) {
        let v = m[2] !== '' ? m[2] : av[++i];
        bytes = m[1] === 'c' || m[1] === 'bytes';
        if (v === undefined) return c.fail("option requires an argument -- '" + m[1] + "'");
        if (v[0] === '+' && !isHead) { from = true; v = v.slice(1); } else if (v[0] === '-') { if (isHead) neg = true; v = v.slice(1); }
        if (!/^\d+$/.test(v)) return c.fail('invalid number of ' + (bytes ? 'bytes' : 'lines') + ": '" + v + "'");
        n = +v;
      } else if (a === '-q') quiet = true; else if ((a === '-f' || a === '-F' || a === '--follow') && !isHead) follow = true; else if (a[0] === '-' && a !== '-') return c.fail("invalid option -- '" + a.slice(1) + "'"); else files.push(a);
    }
    if (!files.length) files.push('-');
    let rc = 0, first = true;
    for (const f of files) {
      const fd = f === '-' ? 0 : yield sys.open(f, O.RDONLY);
      if (fd < 0) { c.err(c.name + ": cannot open '" + f + "' for reading: " + strerror(fd) + '\n'); rc = 1; continue; }
      if (files.length > 1 && !quiet) { c.out((first ? '' : '\n') + '==> ' + (f === '-' ? 'standard input' : f) + ' <==\n'); }
      first = false;
      if (isHead && neg) {
        // head -n -N：最後の N 行（バイト）を除いた全部
        const d = yield* c.readAll(fd);
        if (typeof d === 'number') { c.err("head: error reading '" + f + "': " + strerror(d) + '\n'); rc = 1; } else if (bytes) c.out(d.slice(0, Math.max(0, d.length - n))); else { const ls = lines(d), sel = ls.slice(0, Math.max(0, ls.length - n)); if (sel.length) c.out(sel.join('\n') + '\n'); }
      } else if (isHead) {
        let left = n, err = 0;
        while (left > 0) {
          const d = yield sys.read(fd, 4096);
          if (typeof d === 'number') { if (d === -E.EINTR) continue; err = d; break; }
          if (d === '') break;
          if (bytes) { c.out(d.slice(0, left)); left -= d.length; continue; }
          let p = 0;
          while (left > 0) { const i = d.indexOf('\n', p); if (i < 0) break; p = i + 1; left--; }
          c.out(left > 0 ? d : d.slice(0, p));
        }
        if (err) { c.err('head: error reading ' + "'" + f + "': " + strerror(err) + '\n'); rc = 1; }
      } else {
        const d = yield* c.readAll(fd);
        if (typeof d === 'number') { c.err('tail: error reading ' + "'" + f + "': " + strerror(d) + '\n'); rc = 1; } else if (bytes) c.out(from ? d.slice(Math.max(0, n - 1)) : n ? d.slice(-n) : '');
        else { const ls = lines(d), sel = from ? ls.slice(Math.max(0, n - 1)) : n ? ls.slice(-n) : []; if (sel.length) c.out(sel.join('\n') + (d.endsWith('\n') ? '\n' : '')); }
      }
      if (follow && fd > 0 && f === files[files.length - 1]) {
        // tail -f：ファイルに足された分を表示し続ける（止められるまで終わらない）
        yield* c.flush();
        for (;;) {
          const d = yield sys.read(fd, 4096);
          if (typeof d === 'string' && d !== '') { const w = yield* c.writeAll(1, d); if (w < 0) return 1; continue; }
          const st = yield sys.fstat(fd), pos = yield sys.lseek(fd, 0, 1);
          if (typeof st === 'object' && st.size < pos) { yield* c.writeAll(2, 'tail: ' + f + ': file truncated\n'); yield sys.lseek(fd, 0, 0); continue; }
          yield sys.nanosleep(200);
        }
      }
      if (fd > 0) yield sys.close(fd);
    }
    return rc;
  };
  P('head', '最初の数行だけを表示する', 'head [-n 行数] [ファイル…]', headTail);
  P('tail', '最後の数行だけを表示する。-f なら、足された行を表示し続ける', 'tail [-n 行数] [-f] [ファイル…]   -n +3 は 3 行目から', headTail);
  function parseList(s) {
    const rs = [];
    for (const p of s.split(',')) {
      const m = /^(\d*)(-?)(\d*)$/.exec(p);
      if (!m || (m[1] === '' && m[3] === '')) return null;
      const a = m[1] === '' ? 1 : +m[1], b = m[2] ? (m[3] === '' ? Infinity : +m[3]) : a;
      if (a < 1 || b < a) return null;
      rs.push([a, b]);
    }
    return rs;
  }
  P('cut', '各行から、指定した列や文字だけを取り出す', 'cut -d 区切り -f 列 [ファイル…]   または   cut -c 文字の位置', function* (c) {
    const g = c.getopt('d:f:c:b:s', { '--delimiter': 'd', '--fields': 'f', '--characters': 'c' }); if (!g) return 1;
    const spec = g.o.f !== undefined ? g.o.f : g.o.c !== undefined ? g.o.c : g.o.b;
    if (spec === undefined) return c.fail('you must specify a list of bytes, characters, or fields');
    const rs = parseList(spec);
    if (!rs) return c.fail('invalid field value ' + "'" + spec + "'");
    const dl = g.o.d === undefined ? '\t' : g.o.d;
    if (dl.length !== 1 && !(HI.test(dl) && Array.from(dec(dl)).length === 1)) return c.fail('the delimiter must be a single character');
    const pick = (arr) => arr.filter((x, i) => rs.some((r) => i + 1 >= r[0] && i + 1 <= r[1]));
    for (const f of g.args.length ? g.args : ['-']) {
      const d = yield* c.cat(f);
      if (d === null) continue;
      for (const l of lines(d)) {
        if (g.o.f !== undefined) { if (l.indexOf(dl) < 0) { if (!g.o.s) c.out(l + '\n'); continue; } c.out(pick(l.split(dl)).join(dl) + '\n'); } else if (g.o.c !== undefined && HI.test(l)) c.out(enc(pick(Array.from(dec(l))).join('')) + '\n');
        else c.out(pick(l.split('')).join('') + '\n');
      }
      if (c.qn >= 4096) yield* c.flush(true);
    }
    return c.rc | 0;
  });
  function trSet(s) {
    const out = [];
    const u = SH.unescape(s).s;
    for (let i = 0; i < u.length; i++) {
      if (u[i] === '[' && u[i + 1] === ':') {
        const e = u.indexOf(':]', i + 2), nm = e > 0 ? u.slice(i + 2, e) : '';
        if (CLS[nm]) { for (let ch = 0; ch < 128; ch++) if (new RegExp('[' + CLS[nm] + ']').test(String.fromCharCode(ch))) out.push(String.fromCharCode(ch)); i = e + 1; continue; }
      }
      if (u[i + 1] === '-' && i + 2 < u.length) { const a = u.charCodeAt(i), b = u.charCodeAt(i + 2); if (b >= a) { for (let ch = a; ch <= b; ch++) out.push(String.fromCharCode(ch)); i += 2; continue; } }
      out.push(u[i]);
    }
    return out;
  }
  P('tr', '文字を置き換える・消す', "tr [-d] [-s] [-c] 文字の集合1 [文字の集合2]   例：tr a-z A-Z", function* (c) {
    const g = c.getopt('dscC'); if (!g) return 1;
    if (!g.args.length) return c.fail('missing operand');
    let s1 = trSet(g.args[0]);
    const s2 = g.args[1] !== undefined ? trSet(g.args[1]) : null;
    if (g.o.c || g.o.C) { const inv = []; const has = new Set(s1); for (let ch = 0; ch < 256; ch++) if (!has.has(String.fromCharCode(ch))) inv.push(String.fromCharCode(ch)); s1 = inv; }
    if (!g.o.d && !s2 && !g.o.s) return c.fail("missing operand after '" + g.args[0] + "'\nTwo strings must be given when translating.");
    const map = new Map();
    if (!g.o.d && s2 && s2.length) s1.forEach((ch, i) => map.set(ch, s2[Math.min(i, s2.length - 1)]));
    const del = g.o.d ? new Set(s1) : null;
    const sq = g.o.s ? new Set(g.o.d ? s2 || [] : s2 || s1) : null;
    let last = '';
    for (;;) {
      const d = yield sys.read(0, 4096);
      if (typeof d === 'number') { if (d === -E.EINTR) continue; break; }
      if (d === '') break;
      let o = '';
      for (let i = 0; i < d.length; i++) {
        let ch = d[i];
        if (del && del.has(ch)) continue;
        if (map.size) { const m = map.get(ch); if (m !== undefined) ch = m; }
        if (sq && ch === last && sq.has(ch)) continue;
        o += ch; last = ch;
      }
      yield* c.put(o);
    }
    return 0;
  });
  P('tee', '標準入力を、標準出力とファイルの両方に書く', 'tee [-a] ファイル…', function* (c) {
    const g = c.getopt('ai'); if (!g) return 1;
    const fds = [];
    let rc = 0;
    for (const f of g.args) { const fd = yield sys.open(f, O.WRONLY | O.CREAT | (g.o.a ? O.APPEND : O.TRUNC), 0o666); if (fd < 0) { c.err('tee: ' + f + ': ' + strerror(fd) + '\n'); rc = 1; } else fds.push(fd); }
    yield* c.flush();
    for (;;) {
      const d = yield sys.read(0, 4096);
      if (typeof d === 'number') { if (d === -E.EINTR) continue; break; }
      if (d === '') break;
      yield* c.writeAll(1, d);
      for (const fd of fds) yield* c.writeAll(fd, d);
    }
    for (const fd of fds) yield sys.close(fd);
    return rc;
  });
  P('expr', '式を計算して表示する', 'expr 数 演算子 数   例：expr 3 + 4', function* (c) {
    const a = c.argv.slice(1);
    if (!a.length) return c.fail('missing operand') + 1;
    let i = 0;
    const isInt = (s) => /^-?\d+$/.test(s);
    const prim = () => { const t = a[i++]; if (t === undefined) throw new Error('syntax error: missing argument after ' + "'" + a[i - 2] + "'"); if (t === '(') { const v = or(); if (a[i++] !== ')') throw new Error('syntax error: expecting ) after ' + "'" + a[i - 2] + "'"); return v; } if (t === 'length') return String(a[i++].length); return t; };
    const match = () => { let l = prim(); while (a[i] === ':') { i++; const r = prim(); const m = new RegExp('^(?:' + posixRe(r, false) + ')').exec(l); l = m ? (m.length > 1 ? m[1] || '' : String(m[0].length)) : (/\\\(/.test(r) ? '' : '0'); } return l; };
    const arith2 = (ops, next) => () => { let l = next(); while (ops.indexOf(a[i]) >= 0) { const op = a[i++], r = next(); if (!isInt(l) || !isInt(r)) throw new Error('non-integer argument'); const x = parseInt(l, 10), y = parseInt(r, 10); if ((op === '/' || op === '%') && y === 0) throw new Error('division by zero'); l = String(op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '/' ? Math.trunc(x / y) : x % y); } return l; };
    const mul = arith2(['*', '/', '%'], match), add = arith2(['+', '-'], mul);
    const cmp = () => { let l = add(); while (['=', '==', '!=', '<', '<=', '>', '>='].indexOf(a[i]) >= 0) { const op = a[i++], r = add(); const n = isInt(l) && isInt(r), x = n ? parseInt(l, 10) : l, y = n ? parseInt(r, 10) : r; l = (op === '=' || op === '==' ? x === y : op === '!=' ? x !== y : op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y) ? '1' : '0'; } return l; };
    const and = () => { let l = cmp(); while (a[i] === '&') { i++; const r = cmp(); l = l !== '' && l !== '0' && r !== '' && r !== '0' ? l : '0'; } return l; };
    function or() { let l = and(); while (a[i] === '|') { i++; const r = and(); l = l !== '' && l !== '0' ? l : r !== '' && r !== '0' ? r : '0'; } return l; }
    try { const v = or(); if (i < a.length) throw new Error('syntax error: unexpected argument ' + "'" + a[i] + "'"); c.out(v + '\n'); return v === '' || v === '0' ? 1 : 0; } catch (e) { c.err('expr: ' + e.message + '\n'); return 2; }
  });
  P('xargs', '標準入力の単語を引数にして、コマンドを実行する', 'xargs [-n 個数] [-I 置き換え文字列] [コマンド [引数…]]', function* (c) {
    const g = c.getopt('n:I:0rtd:L:', null, true); if (!g) return 1;
    const d = yield* c.readAll(0);
    let items;
    if (g.o['0']) items = d.split('\0').filter((x) => x !== '');
    else if (g.o.d !== undefined) items = lines(d.split(SH.unescape(g.o.d).s).join('\n'));
    else if (g.o.I !== undefined || g.o.L !== undefined) items = lines(d).filter((l) => l.trim() !== '').map((l) => l.replace(/^\s+/, ''));
    else { items = []; const re = /"([^"]*)"|'([^']*)'|((?:\\.|[^\s"'\\])+)/g; let m; while ((m = re.exec(d))) items.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3].replace(/\\(.)/g, '$1')); }
    const cmd = g.args.length ? g.args : ['echo'];
    let rc = 0;
    const run = function* (argv) {
      if (g.o.t) c.err(argv.join(' ') + '\n');
      const st = yield* c.spawn(argv, c.env);
      if (st === 127 || st === 126) rc = st; else if (st === 255) rc = 124; else if (st && rc < 123) rc = 123;
    };
    if (g.o.I !== undefined) { for (const it of items) yield* run(cmd.map((a) => a.split(g.o.I).join(it))); return rc; }
    const n = g.o.n !== undefined ? Math.max(1, +g.o.n) : g.o.L !== undefined ? Math.max(1, +g.o.L) : 5000;
    if (!items.length) { if (!g.o.r) yield* run(cmd); return rc; }
    for (let i = 0; i < items.length; i += n) yield* run(cmd.concat(items.slice(i, i + n)));
    return rc;
  });

  // ════════════════════════ find / du ════════════════════════
  P('find', '条件に合うファイルを、ディレクトリの中から探す', 'find [場所…] [-name パターン] [-type f|d|l] [-maxdepth 数] [-size ±数] [-newer ファイル] [-inum 番号] [-samefile ファイル] [-exec コマンド {} \\;]', function* (c) {
    const av = c.argv.slice(1), paths = [];
    let i = 0;
    while (i < av.length && av[i][0] !== '-' && av[i] !== '!' && av[i] !== '(') paths.push(av[i++]);
    if (!paths.length) paths.push('.');
    let maxd = Infinity, mind = 0, rc = 0, hasAction = false;
    const now = yield sys.time();
    // 式を木にする
    const need = (name) => { if (i >= av.length) throw new Error("missing argument to `" + name + "'"); return av[i++]; };
    function* prim() {
      const t = av[i++];
      switch (t) {
        case '(': { const e = yield* orE(); if (av[i++] !== ')') throw new Error("invalid expression; I was expecting to find a ')' somewhere but did not see one."); return e; }
        case '!': case '-not': { const e = yield* prim(); return { not: e }; }
        case '-name': case '-iname': case '-path': { const p = need(t); return { t, pat: t === '-iname' ? p.toLowerCase() : p }; }
        case '-type': { const v = need(t); if (!/^[fdlcbps]$/.test(v)) throw new Error('Unknown argument to -type: ' + v); return { t, v }; }
        case '-maxdepth': maxd = +need(t); return { t: '-true' };
        case '-mindepth': mind = +need(t); return { t: '-true' };
        case '-size': { const m = /^([+-]?)(\d+)([ckMGbw]?)$/.exec(need(t)); if (!m) throw new Error('Invalid argument to -size'); return { t, sign: m[1], n: +m[2], unit: { c: 1, w: 2, b: 512, '': 512, k: 1024, M: 1048576, G: 1073741824 }[m[3]] }; }
        case '-newer': { const f = need(t), st = yield sys.stat(f); if (isErr(st)) throw new Error("'" + f + "'" + ': ' + strerror(st)); return { t, m: st.mtime }; }
        case '-mtime': case '-mmin': { const m = /^([+-]?)(\d+)$/.exec(need(t)); if (!m) throw new Error('invalid argument to ' + t); return { t, sign: m[1], n: +m[2] }; }
        case '-user': { const n = need(t), u = (yield* c.passwd()).find((x) => x.name === n); if (!u && !/^\d+$/.test(n)) throw new Error("'" + n + "'" + ' is not the name of a known user'); return { t, uid: u ? u.uid : +n }; }
        case '-group': { const n = need(t), u = (yield* c.group()).find((x) => x.name === n); if (!u && !/^\d+$/.test(n)) throw new Error("'" + n + "'" + ' is not the name of an existing group'); return { t, gid: u ? u.gid : +n }; }
        case '-perm': { const v = need(t), m = /^([-\/]?)([0-7]+)$/.exec(v); if (!m) throw new Error('invalid mode ' + "'" + v + "'"); return { t, how: m[1], mode: parseInt(m[2], 8) }; }
        case '-inum': case '-links': { const m = /^([+-]?)(\d+)$/.exec(need(t)); if (!m) throw new Error('invalid argument ' + "`" + av[i - 1] + "' to `" + t + "'"); return { t, sign: m[1], n: +m[2] }; }
        case '-samefile': { const f = need(t), st = yield sys.stat(f); if (isErr(st)) throw new Error("'" + f + "'" + ': ' + strerror(st)); return { t, ino: st.ino, dev: st.dev }; }
        case '-empty': case '-true': case '-false': return { t };
        case '-print': case '-print0': case '-delete': case '-ls': hasAction = true; return { t };
        case '-exec': case '-ok': { const cmd = []; for (;;) { if (i >= av.length) throw new Error("missing argument to `-exec'"); const a = av[i++]; if (a === ';' || (a === '+' && cmd[cmd.length - 1] === '{}')) break; cmd.push(a); } hasAction = true; return { t: '-exec', cmd }; }
        default: throw new Error(t && t[0] === '-' ? 'unknown predicate `' + t + "'" : 'paths must precede expression: `' + t + "'");
      }
    }
    function* andE() { let l = yield* prim(); while (i < av.length && av[i] !== '-o' && av[i] !== '-or' && av[i] !== ')') { if (av[i] === '-a' || av[i] === '-and') i++; const r = yield* prim(); l = { and: [l, r] }; } return l; }
    function* orE() { let l = yield* andE(); while (av[i] === '-o' || av[i] === '-or') { i++; const r = yield* andE(); l = { or: [l, r] }; } return l; }
    let expr = { t: '-true' };
    try { if (i < av.length) { expr = yield* orE(); if (i < av.length) throw new Error('paths must precede expression: `' + av[i] + "'"); } } catch (e) { c.err('find: ' + e.message + '\n'); return 1; }
    if (!hasAction) expr = { and: [expr, { t: '-print' }] };
    const cmpN = (v, sign, n) => (sign === '+' ? v > n : sign === '-' ? v < n : v === n);
    function* ev(e, p, st) {
      if (e.not) return !(yield* ev(e.not, p, st));
      if (e.and) return (yield* ev(e.and[0], p, st)) && (yield* ev(e.and[1], p, st));
      if (e.or) return (yield* ev(e.or[0], p, st)) || (yield* ev(e.or[1], p, st));
      switch (e.t) {
        case '-true': return true; case '-false': return false;
        case '-name': return SH.globMatch(e.pat, basename(p));
        case '-iname': return SH.globMatch(e.pat, basename(p).toLowerCase());
        case '-path': return SH.globMatch(e.pat, p);
        case '-type': return typeCh(st) === e.v;
        case '-size': return cmpN(Math.ceil(st.size / e.unit), e.sign, e.n);
        case '-newer': return st.mtime > e.m;
        case '-mtime': return cmpN(Math.floor((now - st.mtime) / 86400000), e.sign, e.n);
        case '-mmin': return cmpN(Math.floor((now - st.mtime) / 60000), e.sign, e.n);
        case '-user': return st.uid === e.uid; case '-group': return st.gid === e.gid;
        case '-inum': return cmpN(st.ino, e.sign, e.n); case '-links': return cmpN(st.nlink, e.sign, e.n);
        case '-samefile': return st.ino === e.ino && st.dev === e.dev;
        case '-perm': { const m = st.mode & 0o7777; return e.how === '-' ? (m & e.mode) === e.mode : e.how === '/' ? (m & e.mode) !== 0 : m === e.mode; }
        case '-empty': { if (isDir(st)) { const en = yield* c.readDir(p); return !isErr(en) && en.length <= 2; } return typeCh(st) === 'f' && st.size === 0; }
        case '-print': c.out(p + '\n'); if (c.qn >= 4096) yield* c.flush(true); return true;
        case '-print0': c.out(p + '\0'); return true;
        case '-ls': c.out(String(st.ino).padStart(9) + ' ' + String(st.blocks / 2).padStart(6) + ' ' + U.modeStr(typeCh(st), st.mode & 0o7777) + ' ' + String(st.nlink).padStart(3) + ' ' + (yield* c.uname(st.uid)).padEnd(8) + ' ' + (yield* c.gname(st.gid)).padEnd(8) + ' ' + String(st.size).padStart(8) + ' ' + lsTime(st.mtime, now) + ' ' + p + '\n'); return true;
        case '-delete': { const r = isDir(st) ? yield sys.rmdir(p) : yield sys.unlink(p); if (r < 0) { c.err("find: cannot delete '" + p + "': " + strerror(r) + '\n'); rc = 1; return false; } return true; }
        case '-exec': { const st2 = yield* c.spawn(e.cmd.map((a) => a.split('{}').join(p)), c.env); return st2 === 0; }
      }
      return false;
    }
    const depthFirst = JSON.stringify(expr).indexOf('"-delete"') >= 0;
    function* visit(p, depth) {
      const st = yield sys.lstat(p);
      if (isErr(st)) { c.err("find: '" + p + "': " + strerror(st) + '\n'); rc = 1; return; }
      if (!depthFirst && depth >= mind) yield* ev(expr, p, st);
      if (isDir(st) && depth < maxd) {
        const ents = yield* c.readDir(p);
        if (isErr(ents)) { yield* c.flush(); c.err("find: '" + p + "': " + strerror(ents) + '\n'); rc = 1; } else for (const e of ents) if (e.name !== '.' && e.name !== '..') yield* visit(join(p, e.name), depth + 1);
      }
      if (depthFirst && depth >= mind) yield* ev(expr, p, st);
    }
    for (const p of paths) yield* visit(p, 0);
    return rc;
  });
  P('du', 'ディレクトリやファイルが使っているディスクの量を表示する', 'du [-s] [-h] [-a] [パス…]', function* (c) {
    const g = c.getopt('shakbcd:', { '--summarize': 's', '--human-readable': 'h', '--all': 'a', '--max-depth': 'd' }); if (!g) return 1;
    const o = g.o, maxd = o.s ? 0 : o.d !== undefined ? +o.d : Infinity, seen = new Set();
    let rc = 0, grand = 0;
    const fmt = (blocks) => (o.h ? human(blocks * 512) : o.b ? String(blocks * 512) : String(Math.ceil(blocks / 2)));
    function* visit(p, depth) {
      const st = yield sys.lstat(p);
      if (isErr(st)) { c.err("du: cannot access '" + p + "': " + strerror(st) + '\n'); rc = 1; return 0; }
      const key = st.dev + ':' + st.ino;
      if (!isDir(st) && st.nlink > 1) { if (seen.has(key)) return 0; seen.add(key); }
      let total = st.blocks;
      if (isDir(st)) {
        const ents = yield* c.readDir(p);
        if (isErr(ents)) { c.err("du: cannot read directory '" + p + "': " + strerror(ents) + '\n'); rc = 1; } else for (const e of ents) if (e.name !== '.' && e.name !== '..') total += yield* visit(join(p, e.name), depth + 1);
      }
      if (depth <= maxd && (isDir(st) || o.a || depth === 0)) c.out(fmt(total) + '\t' + p + '\n');
      return total;
    }
    for (const p of g.args.length ? g.args : ['.']) grand += yield* visit(p, 0);
    if (o.c) c.out(fmt(grand) + '\ttotal\n');
    return rc;
  });

  // ════════════════════════ 中身を調べる ════════════════════════
  P('file', 'ファイルの種類を調べて表示する', 'file ファイル…', function* (c) {
    let rc = 0;
    const files = c.argv.slice(1).filter((a) => a[0] !== '-' || a === '-'), wname = Math.max(0, ...files.map((x) => x.length)) + 1;
    const out0 = c.out.bind(c);
    c = Object.create(c); c.out = (t) => { const i = t.indexOf(': '); out0(i < 0 ? t : (t.slice(0, i + 1)).padEnd(wname) + t.slice(i + 1)); };
    if (!files.length) { c.err('Usage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]\n            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]\n            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]\n            <file> ...\n'); return 1; }
    for (const f of files) {
      const st = yield sys.lstat(f);
      let d;
      if (isErr(st)) { c.out(f + ': cannot open `' + f + "' (" + strerror(st) + ')\n'); continue; }
      const t = typeCh(st);
      if (t === 'd') d = 'directory';
      else if (t === 'l') { const tg = yield sys.readlink(f); d = (isErr(yield sys.stat(f)) ? 'broken symbolic link to ' : 'symbolic link to ') + tg; } else if (t === 'c') d = 'character special (' + (st.rdev >> 8) + '/' + (st.rdev & 255) + ')';
      else if (t === 'p') d = 'fifo (named pipe)'; else if (t === 's') d = 'socket';
      else if (st.size === 0) d = 'empty';
      else {
        const fd = yield sys.open(f, O.RDONLY);
        if (fd < 0) { c.out(f + ': regular file, no read permission\n'); continue; }
        const h = yield sys.read(fd, 4096);
        yield sys.close(fd);
        const s = typeof h === 'string' ? h : '';
        const x = st.mode & 0o111 ? ' executable' : '';
        if (s.startsWith('\x7fELF')) d = /zukai:/.test(s) ? 'ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, for GNU/Linux 3.2.0, stripped' : 'ELF 64-bit LSB shared object, x86-64, version 1 (SYSV), dynamically linked, stripped';
        else if (s.startsWith('\x1f\x8b')) d = 'gzip compressed data';
        else if (/[\x00-\x08\x0e-\x1a\x1c-\x1f]/.test(s)) d = 'data';
        else {
          let enc8 = 'ASCII text';
          if (HI.test(s)) { let ok = true; try { new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s.slice(0, s.lastIndexOf('\n') + 1 || s.length), (ch) => ch.charCodeAt(0))); } catch (e) { ok = false; } enc8 = ok ? 'Unicode text, UTF-8 text' : 'ISO-8859 text'; }
          const m = /^#!\s*(\S+)/.exec(s);
          if (m) d = (/\/(ba|da)?sh$/.test(m[1]) ? 'POSIX shell script' : 'a ' + m[1] + ' script') + ', ' + enc8 + ' executable';
          else if (/\.csv$/.test(f) && s.indexOf(',') >= 0) d = 'CSV ' + enc8.replace('Unicode text, UTF-8 text', 'Unicode text, UTF-8 text');
          else d = enc8;
          if (s.indexOf('\n') < 0) d += ', with no line terminators';
        }
      }
      c.out(f + ': ' + d + '\n');
    }
    return rc;
  });
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  P('hexdump', 'ファイルの中身をバイト単位の 16 進数で表示する', 'hexdump [-C] [-n バイト数] [ファイル]', function* (c) {
    const g = c.getopt('Cn:s:v'); if (!g) return 1;
    let d = yield* c.cat(g.args[0] || '-');
    if (d === null) return 1;
    const skip = +g.o.s || 0;
    d = d.slice(skip, g.o.n !== undefined ? skip + +g.o.n : undefined);
    let prev = null, star = false;
    for (let off = 0; off < d.length; off += 16) {
      const ch = d.slice(off, off + 16);
      if (!g.o.v && ch === prev && ch.length === 16) { if (!star) { c.out('*\n'); star = true; } continue; }
      prev = ch; star = false;
      if (g.o.C) {
        let h = '';
        for (let i = 0; i < 16; i++) h += (i < ch.length ? hex2(ch.charCodeAt(i)) : '  ') + ' ' + (i === 7 ? ' ' : '');
        c.out((skip + off).toString(16).padStart(8, '0') + '  ' + h + ' |' + ch.replace(/[^\x20-\x7e]/g, '.') + '|\n');
      } else {
        const ws = [];
        for (let i = 0; i < ch.length; i += 2) ws.push(hex2(i + 1 < ch.length ? ch.charCodeAt(i + 1) : 0) + hex2(ch.charCodeAt(i)));
        c.out((skip + off).toString(16).padStart(7, '0') + ' ' + ws.join(' ') + (ws.length < 8 ? ' '.repeat((8 - ws.length) * 5) : '') + '\n');
      }
      if (c.qn >= 4096) yield* c.flush(true);
    }
    if (d.length) c.out((skip + d.length).toString(16).padStart(g.o.C ? 8 : 7, '0') + '\n');
    return 0;
  });
  P('od', 'ファイルの中身を 8 進数などで表示する', 'od [-c] [-x] [-b] [-A x] [-t x1] [ファイル]', function* (c) {
    const g = c.getopt('cxbdA:t:N:v'); if (!g) return 1;
    let d = yield* c.cat(g.args[0] || '-');
    if (d === null) return 1;
    if (g.o.N !== undefined) d = d.slice(0, +g.o.N);
    const radix = { x: 16, d: 10, o: 8, n: 0 }[g.o.A || 'o'];
    const addr = (n) => (radix === 0 ? '' : n.toString(radix).padStart(radix === 16 ? 6 : 7, '0'));
    const t = g.o.t || (g.o.c ? 'c' : g.o.x ? 'x2' : g.o.b ? 'o1' : g.o.d ? 'u2' : 'o2');
    const ESC = { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };
    let prev = null, star = false;
    for (let off = 0; off < d.length; off += 16) {
      const ch = d.slice(off, off + 16);
      if (!g.o.v && ch === prev && ch.length === 16) { if (!star) { c.out('*\n'); star = true; } continue; }
      prev = ch; star = false;
      let line = addr(off);
      if (t === 'c') for (let i = 0; i < ch.length; i++) { const b = ch.charCodeAt(i); line += (ESC[b] || (b >= 32 && b < 127 ? ch[i] : U.oct(b, 3))).padStart(4); } else {
        const size = +(t.slice(1).replace(/z$/, '')) || 2, base = t[0] === 'x' ? 16 : t[0] === 'o' ? 8 : 10;
        const w = { 16: size * 2, 8: size === 1 ? 3 : size === 2 ? 6 : 11, 10: size === 1 ? 3 : size === 2 ? 5 : 10 }[base];
        for (let i = 0; i < ch.length; i += size) { let v = 0; for (let k = size - 1; k >= 0; k--) v = v * 256 + (i + k < ch.length ? ch.charCodeAt(i + k) : 0); line += ' ' + (base === 10 ? String(v).padStart(w) : v.toString(base).padStart(w, '0')); }
        if (/z$/.test(t)) line = line.padEnd(addr(off).length + (16 / size) * (w + 1)) + '  >' + ch.replace(/[^\x20-\x7e]/g, '.') + '<';
      }
      c.out(line + '\n');
      if (c.qn >= 4096) yield* c.flush(true);
    }
    if (radix) c.out(addr(d.length) + '\n');
    return 0;
  });

  LNX.binutil = { P, lines, join, human, dispWidth, lsTime, cmpBytes, isDir, isErr, typeCh, parseMode, posixRe, mkMatcher, realpath, walkTree };
})(typeof window !== 'undefined' ? window : globalThis);
