// 図解 Linux のコマンド群（その 2：プロセス、システムの観察、init）。bin.js の後に読み込む。API は kernel.js の先頭コメントを見る。
(function (root) {
  'use strict';
  const LNX = root.LNX, sys = LNX.sys, E = LNX.ERRNO, O = LNX.O, U = LNX.util, strerror = LNX.strerror, SIG = LNX.SIG, SIGNAME = LNX.SIGNAME;
  const { P, lines, human, isErr, cmpBytes } = LNX.binutil;
  const dec = U.dec, enc = U.enc;
  const p2 = (n) => String(n).padStart(2, '0');

  // ── PID 1 ──  孤児を引き取って回収し続ける。サービスの起動は次の段階で足す（LNX.bin.init.main を差し替える）
  P('init', 'PID 1。すべてのプロセスの先祖で、親をなくしたプロセスを引き取る', 'init', function* () {
    yield sys.sigaction(SIG.CHLD, () => {}, { restart: false });
    for (;;) { const r = yield sys.wait4(-1, 0); if (r === -E.ECHILD) yield sys.pause(); }
  }, { sbin: true });

  // ── /proc を読む ──
  function* readProcs(c) {
    const ents = yield* c.readDir('/proc');
    const out = [];
    if (isErr(ents)) return out;
    for (const e of ents) {
      if (!/^\d+$/.test(e.name)) continue;
      const base = '/proc/' + e.name + '/';
      const st = yield* c.slurp(base + 'stat');
      if (typeof st !== 'string') continue;
      const rp = st.lastIndexOf(')'), f = st.slice(rp + 2).trim().split(' ');
      const p = { pid: +e.name, comm: st.slice(st.indexOf('(') + 1, rp), state: f[0], ppid: +f[1], pgid: +f[2], sid: +f[3], ttyNr: +f[4], tpgid: +f[5], nice: +f[16], vsz: Math.floor(+f[20] / 1024), rss: +f[21] * 4, uid: 0, euid: 0, utime: 0, stime: 0, start: 0, args: [] };
      const ss = yield* c.slurp(base + 'schedstat');
      if (typeof ss === 'string') { const s = ss.trim().split(' '); p.utime = +s[0]; p.stime = +s[1]; p.start = +s[2]; p.wait = s[3]; }
      const status = yield* c.slurp(base + 'status');
      if (typeof status === 'string') { const m = /^Uid:\t(\d+)\t(\d+)/m.exec(status); if (m) { p.uid = +m[1]; p.euid = +m[2]; } }
      const cl = yield* c.slurp(base + 'cmdline');
      if (typeof cl === 'string' && cl !== '') p.args = cl.replace(/\0$/, '').split('\0');
      p.tty = p.ttyNr ? ((p.ttyNr >> 8) === 136 ? 'pts/' + (p.ttyNr & 255) : 'tty' + (p.ttyNr & 255)) : '?';
      p.cpu = p.utime + p.stime;
      out.push(p);
    }
    return out.sort((a, b) => a.pid - b.pid);
  }
  function* sysTimes(c) {
    const up = yield* c.slurp('/proc/uptime'), st = yield* c.slurp('/proc/stat');
    const m = /^btime (\d+)/m.exec(typeof st === 'string' ? st : '');
    return { uptime: typeof up === 'string' ? Math.round(parseFloat(up) * 1000) : 0, btime: m ? +m[1] * 1000 : 0 };
  }
  const hms = (ms) => { const s = Math.floor(ms / 1000); return p2(Math.floor(s / 3600)) + ':' + p2(Math.floor(s / 60) % 60) + ':' + p2(s % 60); };
  const cmdOf = (p, full) => (p.state === 'Z' ? (full ? '[' + p.comm + '] <defunct>' : p.comm + ' <defunct>') : full ? (p.args.length ? p.args.join(' ') : '[' + p.comm + ']') : p.comm);
  const statOf = (p) => p.state + (p.nice < 0 ? '<' : p.nice > 0 ? 'N' : '') + (p.sid === p.pid ? 's' : '') + (p.ttyNr && p.tpgid === p.pgid ? '+' : '');

  P('ps', 'いま動いているプロセスの一覧を表示する', 'ps [-e] [-f] [aux] [-o 列,…] [-p PID] [-u ユーザー]', function* (c) {
    const av = c.argv.slice(1);
    let all = false, tty = false, notty = false, full = false, user = false, fmt = null, pids = null, uname = null, forest = false, long = false;
    for (let i = 0; i < av.length; i++) {
      const a = av[i];
      if (a === '--forest') { forest = true; continue; }
      if (a[0] === '-') {
        for (let j = 1; j < a.length; j++) {
          const f = a[j];
          if (f === 'e' || f === 'A') all = true; else if (f === 'f') full = true; else if (f === 'l') long = true; else if (f === 'H') forest = true; else if (f === 'a') { tty = true; } else if (f === 'x') notty = true;
          else if (f === 'o' || f === 'p' || f === 'u' || f === 'U') { const v = j + 1 < a.length ? a.slice(j + 1) : av[++i]; if (v === undefined) { c.err('ps: option requires an argument -- ' + f + '\n'); return 1; } if (f === 'o') fmt = (fmt || []).concat(v.split(/[,\s]+/).filter(Boolean)); else if (f === 'p') pids = v.split(/[,\s]+/).map(Number); else uname = v; break; } else { c.err("error: unsupported SysV option\n\nUsage:\n ps [options]\n\n Try 'ps --help <simple|list|output|threads|misc|all>'\n  or 'ps --help <s|l|o|t|m|a>'\n for additional help text.\n\nFor more details see ps(1).\n"); return 1; }
        }
      } else if (/^\d+(,\d+)*$/.test(a)) pids = a.split(',').map(Number);
      else for (const f of a) { if (f === 'a') tty = true; else if (f === 'x') notty = true; else if (f === 'u') user = true; else if (f === 'f') forest = true; else if (f === 'e') { /* 環境変数は出さない */ } else if (f === 'o') { fmt = (av[++i] || '').split(/[,\s]+/).filter(Boolean); break; } else { c.err('error: unsupported option (BSD syntax)\n'); return 1; } }
    }
    if ((yield sys.readlink('/proc/self')) !== String(yield sys.getpid())) { c.err('fatal library error, lookup self\n'); return 1; }   // /proc が別の PID 名前空間のもの
    const procs = yield* readProcs(c), t = yield* sysTimes(c), pw = yield* c.passwd();
    const myPid = yield sys.getpid(), me = procs.find((p) => p.pid === myPid) || { ttyNr: 0, euid: yield sys.geteuid() };
    const un = (u) => { const x = pw.find((y) => y.uid === u); return x ? x.name : String(u); };
    let sel;
    if (pids) sel = procs.filter((p) => pids.indexOf(p.pid) >= 0);
    else if (uname !== null) { const u = pw.find((x) => x.name === uname); const id = u ? u.uid : +uname; sel = procs.filter((p) => p.euid === id); } else if (all || (tty && notty)) sel = procs;
    else if (tty) sel = procs.filter((p) => p.ttyNr);
    else if (notty) sel = procs.filter((p) => p.euid === me.euid);
    else sel = procs.filter((p) => p.ttyNr === me.ttyNr && p.euid === me.euid);
    const pcpu = (p) => Math.min(99.9, (p.cpu / Math.max(1, t.uptime - p.start)) * 100);
    const mi = user || (fmt && fmt.some((f) => /mem/i.test(f))) ? yield* meminfo(c) : {};
    const pmem = (p) => (mi.MemTotal ? Math.min(99.9, (100 * p.rss) / mi.MemTotal) : 0).toFixed(1);
    const stime = (p) => U.strftime('%H:%M', t.btime + p.start);
    const mmss = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + p2(s % 60); };
    // 木の形に並べ替えて、枝をつける
    const prefix = new Map();
    if (forest) {
      const ids = new Set(sel.map((p) => p.pid)), kids = new Map();
      for (const p of sel) { const k = ids.has(p.ppid) ? p.ppid : 0; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(p); }
      const out = [];
      const rec = (p, pre, depth) => { prefix.set(p.pid, depth ? pre + ' \\_ ' : ''); out.push(p); const ks = kids.get(p.pid) || []; ks.forEach((k, i) => rec(k, depth ? pre + (i < ks.length ? '    ' : '    ') : '', depth + 1)); };
      for (const p of kids.get(0) || []) rec(p, '', 0);
      sel = out;
    }
    const COLS = {
      pid: ['PID', 5, 'r', (p) => p.pid], ppid: ['PPID', 5, 'r', (p) => p.ppid], pgid: ['PGID', 5, 'r', (p) => p.pgid], pgrp: ['PGRP', 5, 'r', (p) => p.pgid], sid: ['SID', 5, 'r', (p) => p.sid], sess: ['SESS', 5, 'r', (p) => p.sid], tpgid: ['TPGID', 5, 'r', (p) => (p.ttyNr ? p.tpgid : -1)],
      uid: ['UID', 5, 'r', (p) => p.euid], user: ['USER', 8, 'l', (p) => un(p.euid)], euser: ['EUSER', 8, 'l', (p) => un(p.euid)], ruser: ['RUSER', 8, 'l', (p) => un(p.uid)],
      stat: ['STAT', 4, 'l', statOf], s: ['S', 1, 'l', (p) => p.state], state: ['S', 1, 'l', (p) => p.state], tty: ['TT', 8, 'l', (p) => p.tty], tt: ['TT', 8, 'l', (p) => p.tty], tname: ['TTY', 8, 'l', (p) => p.tty],
      time: ['TIME', 8, 'r', (p) => hms(p.cpu)], cputime: ['TIME', 8, 'r', (p) => hms(p.cpu)], etime: ['ELAPSED', 11, 'r', (p) => { const s = Math.floor((t.uptime - p.start) / 1000); return (s >= 3600 ? p2(Math.floor(s / 3600)) + ':' : '') + p2(Math.floor(s / 60) % 60) + ':' + p2(s % 60); }],
      comm: ['COMMAND', 15, 'l', (p) => cmdOf(p, false)], ucmd: ['CMD', 15, 'l', (p) => cmdOf(p, false)], cmd: ['CMD', 27, 'l', (p) => (prefix.get(p.pid) || '') + cmdOf(p, true)], args: ['COMMAND', 27, 'l', (p) => (prefix.get(p.pid) || '') + cmdOf(p, true)], command: ['COMMAND', 27, 'l', (p) => (prefix.get(p.pid) || '') + cmdOf(p, true)],
      ni: ['NI', 3, 'r', (p) => p.nice], nice: ['NI', 3, 'r', (p) => p.nice], pri: ['PRI', 3, 'r', (p) => 19 - p.nice], pcpu: ['%CPU', 4, 'r', (p) => pcpu(p).toFixed(1)], '%cpu': ['%CPU', 4, 'r', (p) => pcpu(p).toFixed(1)], pmem: ['%MEM', 4, 'r', (p) => pmem(p)], '%mem': ['%MEM', 4, 'r', (p) => pmem(p)],
      vsz: ['VSZ', 6, 'r', (p) => p.vsz], rss: ['RSS', 5, 'r', (p) => p.rss], stime: ['STIME', 5, 'l', stime], start: ['STARTED', 8, 'r', (p) => U.strftime('%H:%M:%S', t.btime + p.start)], lstart: ['STARTED', 24, 'r', (p) => U.strftime('%c', t.btime + p.start)], wchan: ['WCHAN', 10, 'l', (p) => p.wait || '-'],
    };
    if (fmt) {
      const cols = [];
      for (const f of fmt) { const eq = f.indexOf('='), nm = (eq < 0 ? f : f.slice(0, eq)).toLowerCase(), cd = COLS[nm]; if (!cd) { c.err('error: unknown user-defined format specifier "' + nm + '"\n'); return 1; } cols.push(eq < 0 ? cd : [f.slice(eq + 1), cd[1], cd[2], cd[3]]); }
      const row = (vals) => vals.map((v, i) => { const cd = cols[i], s = String(v); return i === cols.length - 1 && cd[2] === 'l' ? s : cd[2] === 'r' ? s.padStart(cd[1]) : s.padEnd(cd[1]); }).join(' ').replace(/\s+$/, '');
      if (cols.some((cd) => cd[0] !== '')) c.out(row(cols.map((cd) => cd[0])) + '\n');
      for (const p of sel) c.out(row(cols.map((cd) => cd[3](p))) + '\n');
    } else if (user) {
      c.out('USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n');
      for (const p of sel) c.out(un(p.euid).padEnd(8) + ' ' + String(p.pid).padStart(5) + ' ' + pcpu(p).toFixed(1).padStart(4) + ' ' + pmem(p).padStart(4) + ' ' + String(p.vsz).padStart(6) + ' ' + String(p.rss).padStart(5) + ' ' + p.tty.padEnd(8) + ' ' + statOf(p).padEnd(4) + ' ' + stime(p) + ' ' + mmss(p.cpu).padStart(6) + ' ' + (prefix.get(p.pid) || '') + cmdOf(p, true) + '\n');
    } else if (full) {
      c.out('UID        PID  PPID  C STIME TTY          TIME CMD\n');
      for (const p of sel) c.out(un(p.euid).padEnd(8) + ' ' + String(p.pid).padStart(5) + ' ' + String(p.ppid).padStart(5) + ' ' + String(Math.min(99, Math.round(pcpu(p)))).padStart(2) + ' ' + stime(p) + ' ' + p.tty.padEnd(8) + ' ' + hms(p.cpu) + ' ' + (prefix.get(p.pid) || '') + cmdOf(p, true) + '\n');
    } else if (long) {
      c.out('F S   UID   PID  PPID  C PRI  NI ADDR SZ WCHAN  TTY          TIME CMD\n');
      for (const p of sel) c.out('0 ' + p.state + ' ' + String(p.euid).padStart(5) + ' ' + String(p.pid).padStart(5) + ' ' + String(p.ppid).padStart(5) + ' ' + String(Math.min(99, Math.round(pcpu(p)))).padStart(2) + ' ' + String(80 + p.nice).padStart(3) + ' ' + String(p.nice).padStart(3) + ' - ' + String(p.vsz >> 2).padStart(5) + ' ' + (p.state === 'S' ? (p.wait || '-').slice(0, 6) : '-').padEnd(6) + ' ' + p.tty.padEnd(8) + ' ' + hms(p.cpu) + ' ' + cmdOf(p, false) + '\n');
    } else {
      c.out('  PID TTY          TIME CMD\n');
      for (const p of sel) c.out(String(p.pid).padStart(5) + ' ' + p.tty.padEnd(8) + ' ' + hms(p.cpu) + ' ' + (prefix.get(p.pid) || '') + cmdOf(p, false) + '\n');
    }
    return sel.length ? 0 : 1;
  });
  P('pstree', 'プロセスの親子関係を木の形で表示する', 'pstree [-p] [PID]', function* (c) {
    const g = c.getopt('pauA'); if (!g) return 1;
    const procs = yield* readProcs(c), kids = new Map();
    for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
    const ascii = g.o.A;
    const H = ascii ? '-' : enc('─'), T = ascii ? '+' : enc('┬'), V = ascii ? '|' : enc('│'), L = ascii ? '`' : enc('└'), M = ascii ? '|' : enc('├');
    const label = (p) => p.comm + (g.o.p ? '(' + p.pid + ')' : '');
    const out = [];
    const rec = (p, first, rest) => {
      const lb = label(p), ks = kids.get(p.pid) || [];
      if (!ks.length) { out.push(first + lb); return; }
      const w = U.dec(first).length + lb.length;
      ks.forEach((k, i) => {
        const one = ks.length === 1, lastK = i === ks.length - 1;
        const f = i === 0 ? first + lb + H + (one ? H : T) + H : rest + ' '.repeat(lb.length) + ' ' + (lastK ? L : M) + H;
        const r = rest + ' '.repeat(lb.length) + ' ' + (lastK ? ' ' : V) + ' ';
        void w;
        rec(k, f, r);
      });
    };
    const rootPid = g.args[0] ? +g.args[0] : 1, rp = procs.find((p) => p.pid === rootPid);
    if (!rp) { c.err('pstree: no such process\n'); return 1; }
    rec(rp, '', '');
    c.out(out.join('\n') + '\n');
    return 0;
  });
  const sigNum = (s) => { if (/^\d+$/.test(s)) return +s; const n = SIG[s.toUpperCase().replace(/^SIG/, '')]; return n === undefined ? -1 : n; };
  P('kill', 'プロセスにシグナルを送る（指定しなければ SIGTERM）', 'kill [-シグナル] PID…   例：kill -9 123、kill -STOP 123、kill -l', function* (c) {
    const av = c.argv;
    let i = 1, sig = SIG.TERM;
    if (av[1] === '-l' || av[1] === '-L') {
      if (av[2] !== undefined) { const n = +av[2]; const v = isNaN(n) ? sigNum(av[2]) : SIGNAME[n > 128 ? n - 128 : n]; if (v === undefined || v === -1) { c.err('kill: unknown signal: ' + av[2] + '\n'); return 1; } c.out(v + '\n'); return 0; }
      let o = '';
      for (let s = 1; s <= 31; s++) o += String(s).padStart(2) + ') SIG' + SIGNAME[s] + (s % 5 === 0 || s === 31 ? '\n' : '\t');
      c.out(o); return 0;
    }
    if (av[1] === '-s' || av[1] === '-n') { sig = sigNum(av[2] || ''); i = 3; } else if (av[1] && av[1][0] === '-' && av[1] !== '--') { sig = sigNum(av[1].slice(1)); i = 2; }
    if (av[i] === '--') i++;
    if (sig < 0 || sig > 31) { c.err('kill: unknown signal: ' + (av[i - 1] || '').replace(/^-/, '') + '\n'); return 1; }
    if (i >= av.length) { c.err('kill: not enough arguments\n'); return 1; }
    let rc = 0;
    for (; i < av.length; i++) {
      if (!/^-?\d+$/.test(av[i])) { c.err("kill: failed to parse argument: '" + av[i] + "'\n"); rc = 1; continue; }
      const r = yield sys.kill(+av[i], sig);
      if (r < 0) { c.err('kill: sending signal to ' + av[i] + ' failed: ' + strerror(r) + '\n'); rc = 1; }
    }
    return rc;
  });
  const upStr = (ms) => { const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor(m / 60) % 24; return (d ? d + (d > 1 ? ' days, ' : ' day, ') : '') + (h ? String(h).padStart(2) + ':' + p2(m % 60) : (m % 60) + ' min'); };
  function* headline(c) {
    const t = yield* sysTimes(c), la = yield* c.slurp('/proc/loadavg'), procs = yield* readProcs(c);
    const users = new Set(procs.filter((p) => p.sid === p.pid && p.ttyNr).map((p) => p.ttyNr)).size;
    const l = (typeof la === 'string' ? la : '0.00 0.00 0.00').split(' ');
    return { text: ' ' + U.strftime('%H:%M:%S', t.btime + t.uptime) + ' up ' + upStr(t.uptime) + ',  ' + users + (users === 1 ? ' user' : ' users') + ',  load average: ' + l[0] + ', ' + l[1] + ', ' + l[2], t, procs };
  }
  P('uptime', '起動してからの時間と、負荷平均を表示する', 'uptime', function* (c) { c.out((yield* headline(c)).text + '\n'); return 0; });
  function* meminfo(c) {
    const d = yield* c.slurp('/proc/meminfo'), m = {};
    if (typeof d === 'string') for (const l of lines(d)) { const r = /^(\w+):\s+(\d+)/.exec(l); if (r) m[r[1]] = +r[2]; }
    return m;
  }
  P('top', 'CPU を使っている順にプロセスを表示する（この Linux では 1 回だけ表示して終わる）', 'top [-n 1] [-b]', function* (c) {
    const h = yield* headline(c), procs = h.procs, t = h.t, pw = yield* c.passwd(), mi = yield* meminfo(c);
    const un = (u) => { const x = pw.find((y) => y.uid === u); return x ? x.name : String(u); };
    const cnt = (s) => procs.filter((p) => p.state === s).length;
    const st = yield* c.slurp('/proc/stat'), m = /^cpu\s+(\d+) (\d+) (\d+) (\d+)/m.exec(typeof st === 'string' ? st : '') || [0, 0, 0, 0, 1];
    const tot = Math.max(1, +m[1] + +m[2] + +m[3] + +m[4]), pc = (v) => ((100 * v) / tot).toFixed(1).padStart(5);
    const mib = (kb) => ((kb || 0) / 1024).toFixed(1).padStart(8);
    c.out('top -' + h.text + '\n');
    c.out('Tasks:' + String(procs.length).padStart(4) + ' total,' + String(cnt('R')).padStart(4) + ' running,' + String(cnt('S')).padStart(4) + ' sleeping,' + String(cnt('T')).padStart(4) + ' stopped,' + String(cnt('Z')).padStart(4) + ' zombie\n');
    c.out('%Cpu(s):' + pc(+m[1]) + ' us,' + pc(+m[3]) + ' sy,' + pc(+m[2]) + ' ni,' + pc(+m[4]) + ' id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st\n');
    c.out('MiB Mem :' + mib(mi.MemTotal) + ' total,' + mib(mi.MemFree) + ' free,' + mib((mi.MemTotal || 0) - (mi.MemFree || 0) - (mi.Buffers || 0) - (mi.Cached || 0)) + ' used,' + mib((mi.Buffers || 0) + (mi.Cached || 0)) + ' buff/cache\n');
    c.out('MiB Swap:' + mib(mi.SwapTotal) + ' total,' + mib(mi.SwapFree) + ' free,' + mib((mi.SwapTotal || 0) - (mi.SwapFree || 0)) + ' used.' + mib(mi.MemAvailable) + ' avail Mem\n\n');
    c.out('  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n');
    const pcpu = (p) => Math.min(99.9, (p.cpu / Math.max(1, t.uptime - p.start)) * 100);
    const tp = (ms) => Math.floor(ms / 60000) + ':' + p2(Math.floor(ms / 1000) % 60) + '.' + p2(Math.floor(ms / 10) % 100);
    for (const p of procs.slice().sort((a, b) => pcpu(b) - pcpu(a) || a.pid - b.pid)) c.out(String(p.pid).padStart(5) + ' ' + un(p.euid).padEnd(8) + ' ' + String(20 + p.nice).padStart(3) + ' ' + String(p.nice).padStart(3) + ' ' + String(p.vsz).padStart(7) + ' ' + String(p.rss).padStart(6) + ' ' + '0'.padStart(6) + ' ' + p.state + ' ' + pcpu(p).toFixed(1).padStart(5) + ' ' + (mi.MemTotal ? (100 * p.rss / mi.MemTotal).toFixed(1) : '0.0').padStart(5) + ' ' + tp(p.cpu).padStart(9) + ' ' + p.comm + '\n');
    return 0;
  });
  P('free', 'メモリの使用量を表示する', 'free [-h] [-m] [-k]', function* (c) {
    const g = c.getopt('hmkb'); if (!g) return 1;
    const m = yield* meminfo(c);
    const f = (kb) => (g.o.h ? (kb ? human((kb || 0) * 1024).replace(/([KMG])$/, '$1i') : '0B') : g.o.m ? String(Math.floor((kb || 0) / 1024)) : g.o.b ? String((kb || 0) * 1024) : String(kb || 0)).padStart(11);
    const bc = (m.Buffers || 0) + (m.Cached || 0);
    c.out('               total        used        free      shared  buff/cache   available\n');
    c.out('Mem:    ' + f(m.MemTotal) + ' ' + f((m.MemTotal || 0) - (m.MemFree || 0) - bc) + ' ' + f(m.MemFree) + ' ' + f(m.Shmem) + ' ' + f(bc) + ' ' + f(m.MemAvailable) + '\n');
    c.out('Swap:   ' + f(m.SwapTotal) + ' ' + f((m.SwapTotal || 0) - (m.SwapFree || 0)) + ' ' + f(m.SwapFree) + '\n');
    return 0;
  });
  function* mountList(c) {
    const d = yield* c.slurp('/proc/mounts');
    return (typeof d === 'string' ? lines(d) : []).map((l) => { const f = l.split(' '); return { source: f[0], target: f[1], type: f[2], opts: f[3] }; });
  }
  P('df', 'ファイルシステムごとの、ディスクの空きを表示する', 'df [-h] [-T] [-a] [パス…]', function* (c) {
    const g = c.getopt('hTaki', { '--human-readable': 'h' }); if (!g) return 1;
    let ms = yield* mountList(c);
    const rows = [];
    let rc = 0;
    if (g.args.length) {
      const pick = [];
      for (const a of g.args) {
        const st = yield sys.stat(a);
        if (isErr(st)) { c.err('df: ' + a + ': ' + strerror(st) + '\n'); rc = 1; continue; }
        let best = null;
        for (const m of ms) { const ms2 = yield sys.stat(m.target); if (!isErr(ms2) && ms2.dev === st.dev) best = m; }
        if (best) pick.push(best);
      }
      ms = pick;
    }
    for (const m of ms) {
      const s = yield sys.statfs(m.target);
      if (isErr(s) || (!s.blocks && !g.o.a && !g.args.length)) continue;
      if (g.o.i) { const used = s.files - s.ffree; rows.push([m.source, m.type, String(s.files), String(used), String(s.ffree), s.files ? Math.ceil((100 * used) / s.files) + '%' : '-', m.target]); continue; }
      const k = (b) => (g.o.h ? human(b * 4096) : String(b * 4)), used = s.blocks - s.bfree;
      rows.push([m.source, m.type, k(s.blocks), k(used), k(s.bavail), s.blocks ? Math.ceil((100 * used) / (used + s.bavail)) + '%' : '-', m.target]);
    }
    const head = ['Filesystem', 'Type', g.o.i ? 'Inodes' : g.o.h ? 'Size' : '1K-blocks', g.o.i ? 'IUsed' : 'Used', g.o.i ? 'IFree' : g.o.h ? 'Avail' : 'Available', g.o.i ? 'IUse%' : 'Use%', 'Mounted on'];
    const all = [head].concat(rows), w = head.map((h, i) => Math.max(...all.map((r) => r[i].length)));
    w[0] = Math.max(w[0], 14); w[1] = Math.max(w[1], 4); for (const i of [2, 3, 4]) w[i] = Math.max(w[i], 5); w[5] = Math.max(w[5], 4);
    for (const r of all) c.out(r[0].padEnd(w[0]) + ' ' + (g.o.T ? r[1].padEnd(w[1]) + ' ' : '') + r[2].padStart(w[2]) + ' ' + r[3].padStart(w[3]) + ' ' + r[4].padStart(w[4]) + ' ' + r[5].padStart(w[5]) + ' ' + r[6] + '\n');
    return rc;
  });
  P('mount', 'ファイルシステムをマウントする。引数なしならマウントの一覧を表示する', 'mount [-t 種類] [-o オプション] 元 マウント先', function* (c) {
    const g = c.getopt('t:o:al'); if (!g) return 1;
    if (!g.args.length) { for (const m of yield* mountList(c)) if (!g.o.t || g.o.t === m.type) c.out(m.source + ' on ' + m.target + ' type ' + m.type + ' (' + m.opts + ')\n'); return 0; }
    if (g.args.length < 2) { c.err("mount: " + g.args[0] + ": can't find in /etc/fstab.\n"); return 1; }
    const src = g.args[0], tgt = g.args[1], type = g.o.t || (src === 'proc' || src === 'tmpfs' ? src : '');
    if (!type) { c.err('mount: ' + tgt + ': you must specify the filesystem type.\n'); return 32; }
    const r = yield sys.mount(src, tgt, type, 0, g.o.o || '');
    if (r === -E.EPERM) { c.err('mount: ' + tgt + ': must be superuser to use mount.\n'); return 1; }
    if (r === -E.ENOENT) { c.err('mount: ' + tgt + ': mount point does not exist.\n'); return 32; }
    if (r === -E.ENOTDIR) { c.err('mount: ' + tgt + ': mount point is not a directory.\n'); return 32; }
    if (r === -E.ENODEV) { c.err("mount: " + tgt + ": unknown filesystem type '" + type + "'.\n"); return 32; }
    if (r < 0) { c.err('mount: ' + tgt + ': mount failed: ' + strerror(r) + '.\n'); return 32; }
    return 0;
  });
  P('umount', 'マウントを外す', 'umount マウント先', function* (c) {
    if (c.argv.length < 2) { c.err('umount: bad usage\n'); return 1; }
    let rc = 0;
    for (const t of c.argv.slice(1)) {
      const r = yield sys.umount(t);
      if (r === -E.EPERM) { c.err('umount: ' + t + ': must be superuser to unmount.\n'); rc = 32; } else if (r === -E.EINVAL) { c.err('umount: ' + t + ': not mounted.\n'); rc = 32; } else if (r === -E.EBUSY) { c.err('umount: ' + t + ': target is busy.\n'); rc = 32; } else if (r === -E.ENOENT) { c.err('umount: ' + t + ': no mount point specified.\n'); rc = 32; } else if (r < 0) { c.err('umount: ' + t + ': ' + strerror(r) + '.\n'); rc = 32; }
    }
    return rc;
  });
  P('date', '日付と時刻を表示する', 'date [+書式]   例：date +%Y-%m-%d', function* (c) {
    let now = yield sys.time(), fmt = null, utc = false;
    const av = c.argv.slice(1);
    const parse = (str) => {
      const d = str.trim();
      let m;
      if (d === 'now' || d === '') return now;
      if ((m = /^@(-?\d+)$/.exec(d))) return +m[1] * 1000;
      if (d === 'today') return now; if (d === 'tomorrow') return now + 86400000; if (d === 'yesterday') return now - 86400000;
      if ((m = /^([+-]?\d+) (second|minute|hour|day|week)s?( ago)?$/.exec(d))) return now + (m[3] ? -1 : 1) * +m[1] * { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 }[m[2]];
      if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(d))) { const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - U.TZ.off * 1000; return isNaN(t) || +m[2] > 12 || +m[3] > 31 ? null : t; }
      if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(d))) { const t = U.tm(now); return Date.UTC(t.Y, t.M, t.D, +m[1], +m[2], +(m[3] || 0)) - U.TZ.off * 1000; }
      return null;
    };
    for (let i = 0; i < av.length; i++) {
      const a = av[i];
      if (a === '-d' || a === '--date' || /^--date=/.test(a) || (/^-d./.test(a))) { const v = a === '-d' || a === '--date' ? av[++i] : a.replace(/^--date=|^-d/, ''); if (v === undefined) { c.err("date: option requires an argument -- 'd'\nTry 'date --help' for more information.\n"); return 1; } const t = parse(v); if (t === null) { c.err("date: invalid date '" + v + "'\n"); return 1; } now = t; } else if (a === '-u' || a === '--utc' || a === '--universal') utc = true;
      else if (a === '-R' || a === '--rfc-email') fmt = '%a, %d %b %Y %H:%M:%S %z'; else if (a === '-I' || a === '--iso-8601') fmt = '%Y-%m-%d';
      else if (a[0] === '+') fmt = a.slice(1);
      else if (a[0] === '-' && a.length > 1) { c.err(a[1] === '-' ? "date: unrecognized option '" + a + "'\n" : "date: invalid option -- '" + a[1] + "'\n"); c.err("Try 'date --help' for more information.\n"); return 1; } else { c.err("date: invalid date '" + a + "'\n"); return 1; }
    }
    if (utc) { c.out(U.strftime((fmt || '%a %b %e %H:%M:%S UTC %Y').replace(/%Z/g, 'UTC').replace(/%z/g, '+0000'), now - U.TZ.off * 1000) + '\n'); return 0; }
    c.out(U.strftime(fmt || '%a %b %e %H:%M:%S %Z %Y', now) + '\n');
    return 0;
  });
  P('hostname', 'この機械の名前を表示する（root なら変えられる）', 'hostname [新しい名前]', function* (c) {
    if (c.argv[1] !== undefined && c.argv[1][0] !== '-') { const r = yield sys.sethostname(c.argv[1]); if (r < 0) { c.err('hostname: you must be root to change the host name\n'); return 1; } return 0; }
    c.out((yield sys.uname()).nodename + '\n'); return 0;
  });
  P('uname', 'カーネルの名前やバージョンを表示する', 'uname [-a] [-s] [-n] [-r] [-v] [-m] [-o]', function* (c) {
    const g = c.getopt('asnrvmopi'); if (!g) return 1;
    const u = yield sys.uname(), o = g.o, out = [];
    if (o.a || o.s || !Object.keys(o).length) out.push(u.sysname);
    if (o.a || o.n) out.push(u.nodename);
    if (o.a || o.r) out.push(u.release);
    if (o.a || o.v) out.push(u.version);
    if (o.a || o.m) out.push(u.machine);
    if (o.p) out.push(u.machine); if (o.i) out.push(u.machine);
    if (o.a || o.o) out.push('GNU/Linux');
    c.out(out.join(' ') + '\n'); return 0;
  });
  P('arch', 'CPU の種類を表示する', 'arch', function* (c) { c.out((yield sys.uname()).machine + '\n'); return 0; });
  P('nproc', '使える CPU の数を表示する', 'nproc', function* (c) { c.out('1\n'); return 0; });
  P('sync', 'まだディスクに書かれていないデータを書き出す', 'sync', function* () { yield sys.sync(); return 0; });
  P('strace', 'コマンドが呼ぶシステムコールを 1 行ずつ表示する', 'strace [-f] [-e trace=名前,…] [-o ファイル] コマンド [引数…]', function* (c) {
    const g = c.getopt('fe:o:ttTcqs:p:', null, true); if (!g) return 1;
    if (!g.args.length) { c.err('strace: must have PROG [ARGS] or -p PID\n'); return 1; }
    const path = yield* c.which(g.args[0]);
    if (!path || (g.args[0].indexOf('/') >= 0 && isErr(yield sys.stat(path)))) { c.err("strace: Can't stat '" + g.args[0] + "': No such file or directory\n"); return 1; }
    let fd = 2;
    if (g.o.o !== undefined) { fd = yield sys.open(g.o.o, O.WRONLY | O.CREAT | O.TRUNC, 0o666); if (fd < 0) { c.err("strace: Can't fopen '" + g.o.o + "': " + strerror(fd) + '\n'); return 1; } }
    let filter = null;
    if (g.o.e !== undefined) { const ALIAS = { network: 'socket,bind,listen,accept,connect,shutdown,getsockname,getpeername,setsockopt,getsockopt', memory: 'brk,mmap,munmap,mprotect', open: 'openat', exit: 'exit_group', fork: 'clone', sigaction: 'rt_sigaction', getdents: 'getdents64', file: 'openat,stat,lstat,access,unlink,mkdir,rmdir,rename,chmod,chown,readlink,symlink,link,chdir,execve,getcwd', process: 'clone,execve,exit_group,wait4,kill', desc: 'openat,read,write,close,dup,dup2,pipe,lseek,fstat,fcntl,getdents64,ioctl', signal: 'kill,rt_sigaction,rt_sigprocmask,pause' }; filter = []; for (const n of g.o.e.replace(/^trace=/, '').split(',')) for (const x of (ALIAS[n] || n).split(',')) filter.push(x); }
    const argv = g.args, env = c.env, follow = !!g.o.f;
    const pid = yield sys.fork(function* (c2) {
      yield sys.ptrace('PTRACE_TRACEME', { fd, follow, filter });
      if (fd !== 2) yield sys.close(fd);
      const r = yield sys.execve(path, argv, env);
      c2.err('strace: exec: ' + strerror(r) + '\n');
      return 1;
    });
    if (fd !== 2) yield sys.close(fd);
    if (pid < 0) return c.perr('fork', pid);
    for (;;) { const w = yield sys.wait4(pid, 0); if (w === -E.EINTR) continue; if (typeof w === 'number') return 1; return (w.status & 0x7f) ? 128 + (w.status & 0x7f) : (w.status >> 8) & 0xff; }
  });
  P('lsof', 'プロセスが開いているファイルの一覧を表示する', 'lsof [-p PID]', function* (c) {
    const g = c.getopt('p:u:c:'); if (!g) return 1;
    const procs = yield* readProcs(c), pw = yield* c.passwd();
    const want = g.o.p !== undefined ? g.o.p.split(',').map(Number) : null;
    const rows = [['COMMAND', 'PID', 'USER', 'FD', 'TYPE', 'DEVICE', 'SIZE/OFF', 'NODE', 'NAME']];
    const TY = { f: 'REG', d: 'DIR', c: 'CHR', p: 'FIFO', l: 'LINK', s: 'sock', b: 'BLK' };
    for (const p of procs) {
      if (want && want.indexOf(p.pid) < 0) continue;
      const u = pw.find((x) => x.uid === p.euid), un = u ? u.name : String(p.euid);
      if (g.o.u !== undefined && g.o.u !== un) continue;
      if (g.o.c !== undefined && !p.comm.startsWith(g.o.c)) continue;
      const base = '/proc/' + p.pid + '/';
      const add = function* (fdName, link, mode) {
        const t = yield sys.readlink(link);
        if (typeof t !== 'string') return;
        const st = yield sys.stat(link);
        const ok = typeof st === 'object';
        rows.push([p.comm.slice(0, 9), String(p.pid), un, fdName + mode, ok ? TY[LNX.binutil.typeCh(st)] : 'unknown', ok ? (st.rdev ? (st.rdev >> 8) + ',' + (st.rdev & 255) : (st.dev >> 8) + ',' + (st.dev & 255)) : '', ok ? ((st.mode & 0o170000) === 0o020000 || (st.mode & 0o170000) === 0o010000 ? '0t0' : String(st.size)) : '', ok ? String(st.ino) : '', /^pipe:/.test(t) ? 'pipe' : t]);
      };
      yield* add('cwd', base + 'cwd', ''); yield* add('rtd', base + 'root', ''); yield* add('txt', base + 'exe', '');
      const fds = yield* c.readDir(base + 'fd');
      if (isErr(fds)) continue;
      for (const e of fds.filter((x) => /^\d+$/.test(x.name)).sort((a, b) => +a.name - +b.name)) {
        const info = yield* c.slurp(base + 'fdinfo/' + e.name), m = /flags:\t0(\d+)/.exec(typeof info === 'string' ? info : '');
        const acc = m ? parseInt(m[1], 8) & 3 : 2;
        yield* add(e.name, base + 'fd/' + e.name, 'rwu'[acc]);
      }
    }
    const w = rows[0].map((h, i) => Math.max(...rows.map((r) => r[i].length)));
    for (const r of rows) c.out(r[0].padEnd(w[0]) + ' ' + r[1].padStart(w[1]) + ' ' + r[2].padEnd(w[2]) + ' ' + r[3].padStart(w[3]) + ' ' + r[4].padStart(w[4]) + ' ' + r[5].padStart(w[5]) + ' ' + r[6].padStart(w[6]) + ' ' + r[7].padStart(w[7]) + ' ' + r[8] + '\n');
    return rows.length > 1 ? 0 : 1;
  });

  // ── 練習用のプログラム ──
  P('spin', 'CPU を使い続ける（練習用）。引数は使う時間（秒）。なければ止められるまで', 'spin [秒数]', function* (c) {
    const sec = c.argv[1] !== undefined ? parseFloat(c.argv[1]) : Infinity;
    if (isNaN(sec)) return c.fail("invalid number '" + c.argv[1] + "'");
    let left = sec * 1000;
    while (left > 0) { const n = Math.min(left, 1000); yield sys.cpu(n); left -= n; }
    return 0;
  });
  P('zombie', '子プロセスを作り、回収しないまま待つ（ゾンビを観察する練習用）', 'zombie [秒数]', function* (c) {
    const sec = c.argv[1] !== undefined ? parseFloat(c.argv[1]) : 10;
    const pid = yield sys.fork(function* () { return 0; });
    c.out(enc('子プロセス ' + pid + ' は終わりましたが、親は wait しません\n'));
    yield* c.flush();
    yield sys.nanosleep(sec * 1000);
    return 0;
  });
  P('orphan', '子プロセスを残して親が先に終わる（孤児を観察する練習用）', 'orphan [秒数]', function* (c) {
    const sec = c.argv[1] !== undefined ? parseFloat(c.argv[1]) : 10;
    const pid = yield sys.fork(function* () { yield sys.nanosleep(sec * 1000); return 0; });
    c.out(enc('子プロセス ' + pid + ' を残して、親は終わります\n'));
    return 0;
  });
  P('sigwait', 'シグナルを受け取るたびに名前を表示する（練習用）。SIGTERM で終わる', 'sigwait', function* (c) {
    const got = [];
    for (const s of [SIG.INT, SIG.USR1, SIG.USR2, SIG.HUP, SIG.TERM]) yield sys.sigaction(s, (n) => { got.push(n); }, { restart: false });
    c.out('pid ' + (yield sys.getpid()) + '\n'); yield* c.flush();
    for (;;) {
      yield sys.pause();
      while (got.length) { const s = got.shift(); c.out('got SIG' + SIGNAME[s] + '\n'); yield* c.flush(); if (s === SIG.TERM) return 0; }
    }
  });

  // ── help ──
  const BUILTIN_HELP = {
    cd: ['いまいるディレクトリを変える', 'cd [ディレクトリ]   引数なしならホームへ。cd - で 1 つ前へ'], pwd: ['いまいるディレクトリを表示する', 'pwd'], echo: ['引数をそのまま表示する', 'echo [-n] [-e] 文字列…'],
    printf: ['書式を指定して表示する', 'printf 書式 [引数…]'], export: ['変数を環境変数にする（子プロセスに渡る）', 'export 名前[=値]…'], unset: ['変数や関数を消す', 'unset 名前…'],
    read: ['標準入力から 1 行読んで変数に入れる', 'read [-r] [-p プロンプト] 変数…'], test: ['条件を調べて、終了ステータスで答える', 'test 式   または   [ 式 ]'], exit: ['シェルを終わる', 'exit [終了ステータス]'],
    jobs: ['バックグラウンドのジョブの一覧を表示する', 'jobs [-l]'], fg: ['ジョブを前面（フォアグラウンド）に戻す', 'fg [%ジョブ番号]'], bg: ['止まっているジョブを、バックグラウンドで再開する', 'bg [%ジョブ番号]'],
    wait: ['子プロセスが終わるのを待つ', 'wait [PID | %ジョブ番号]…'], kill: ['プロセスやジョブにシグナルを送る', 'kill [-シグナル] PID | %ジョブ番号'], trap: ['シグナルを受け取ったときに実行するコマンドを決める', "trap 'コマンド' シグナル…   trap - シグナル で元に戻す"],
    type: ['名前がコマンドとしてどう解釈されるかを表示する', 'type 名前…'], alias: ['コマンドに別名をつける', "alias 名前='コマンド'"], source: ['ファイルを、いまのシェルの中で実行する（. と同じ）', 'source ファイル'],
    exec: ['シェル自身を、指定したコマンドに置き換える', 'exec コマンド [引数…]'], umask: ['新しく作るファイルの権限から落とすビットを表示・設定する', 'umask [8 進数]'], set: ['シェルの設定や位置パラメータを変える', 'set [-x] [-u] [--] [引数…]'],
    shift: ['位置パラメータ（$1 $2 …）を 1 つずらす', 'shift [数]'], return: ['関数を終わる', 'return [終了ステータス]'], eval: ['引数をつなげて、コマンドとして実行する', 'eval 文字列…'], local: ['関数の中だけの変数を作る', 'local 名前[=値]…'],
    true: ['何もせず、成功（0）で終わる', 'true'], false: ['何もせず、失敗（1）で終わる', 'false'], command: ['関数や別名を無視してコマンドを実行する。-v で場所を表示する', 'command [-v] 名前'], readonly: ['変数を書き換えられないようにする', 'readonly 名前[=値]…'],
    break: ['ループを抜ける', 'break [数]'], continue: ['ループの次の回へ進む', 'continue [数]'], getopts: ['スクリプトのオプションを解釈する', 'getopts 書式 変数'], unalias: ['別名を消す', 'unalias 名前'], hash: ['コマンドの場所の記憶を消す', 'hash -r'],
  };
  P('help', '使えるコマンドの一覧と、使い方を表示する', 'help [コマンド名]', function* (c) {
    const name = c.argv[1];
    if (name) {
      const b = BUILTIN_HELP[name], p = LNX.bin[name];
      if (!b && !p) { c.err(enc('help: ' + name + ' というコマンドの説明はありません\n')); return 1; }
      if (b) c.out(enc(name + '（シェルの組み込みコマンド）：' + b[0] + '\n  使い方：' + b[1] + '\n'));
      else c.out(enc(name + '：' + p.help + '\n  使い方：' + p.usage + '\n'));
      return 0;
    }
    let o = 'シェルの組み込みコマンド（シェル自身が実行する）\n';
    for (const n of Object.keys(BUILTIN_HELP).sort()) o += '  ' + n.padEnd(10) + BUILTIN_HELP[n][0] + '\n';
    o += '\nコマンド（/usr/bin にあるプログラム）\n';
    for (const n of Object.keys(LNX.bin).sort()) if (LNX.bin[n].help) o += '  ' + n.padEnd(10) + LNX.bin[n].help + '\n';
    o += '\nhelp コマンド名 で、そのコマンドの使い方を表示します。\n';
    c.out(enc(o));
    return 0;
  });
  P('man', 'マニュアルを表示する（この Linux では help と同じ）', 'man コマンド名', function* (c) {
    if (!c.argv[1]) { c.err('What manual page do you want?\nFor example, try \'man man\'.\n'); return 1; }
    return yield* LNX.bin.help.main(c);
  });
  void cmpBytes; void dec;
})(typeof window !== 'undefined' ? window : globalThis);
