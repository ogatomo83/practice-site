// 図解 Linux のスケジューラ（14 章）：CFS 風（仮想実行時間 vruntime、nice → 重み）。rootfs.js の後に読み込む。API は kernel.js の先頭コメントを見る。
//   k.sched を差し替える。CPU は 1 つ。実行できるプロセスのうち vruntime がいちばん小さいものを選び、
//   「目標の周期（24 tick）× 自分の重み ÷ 重みの合計」（最低 3 tick）だけ走らせる。走った分 vruntime が 使った tick × 1024 ÷ 重み だけ増える。
//   眠っていたプロセスは、起きたとき vruntime を「いちばん小さい値 − 12」まで引き上げる（眠っていた分をためこめない。でも少し優先される）。
//   システムコール：setpriority(which, who, nice)、getpriority(which, who) → 20 − nice（本物の生のシステムコールと同じ。負の数はエラーなので）
//   コマンド：nice、renice、burn（CPU を使い続けて、もらえた CPU 時間を報告する練習用）
//   観察：sys.sched() / events（run の opts.trace に 'sched'）：
//     { type: 'run', pid, comm, start, dur, nice, vruntime, weight }   pid が start から dur tick 走った（ガントチャート用。t は走り終わった時刻）
//     { type: 'switch', from, to, comm, vruntime, nr }                  CPU を from から to に渡した（from は直前に走っていた pid。0 = だれも走っていなかった）
//     { type: 'wakeup', pid, comm, vruntime }                           眠っていたプロセスが実行可能になった
//     { type: 'nice', pid, nice, old }
(function (root) {
  'use strict';
  const LNX = root.LNX, E = LNX.ERRNO, sys = LNX.sys, U = LNX.util, strerror = LNX.strerror;
  const { P } = LNX.binutil;
  const enc = U.enc;
  // 本物の kernel/sched/core.c の sched_prio_to_weight（nice −20 … 19）
  const WEIGHT = [88761, 71755, 56483, 46273, 36291, 29154, 23254, 18705, 14949, 11916, 9548, 7620, 6100, 4904, 3906, 3121, 2501, 1991, 1586, 1277,
    1024, 820, 655, 526, 423, 335, 272, 215, 172, 137, 110, 87, 70, 56, 45, 36, 29, 23, 18, 15];
  const weightOf = (nice) => WEIGHT[Math.max(-20, Math.min(19, nice | 0)) + 20];
  const r2 = (x) => Math.round(x * 100) / 100;

  function CFS(k) { this.k = k; this.name = 'cfs'; this.latency = 24; this.minGran = 3; this.q = []; this.minVr = 0; this.seq = 0; this.last = 0; }
  CFS.prototype = {
    enqueue(p) {
      if (p.onq) return;
      if (p.vr === undefined) p.vr = this.minVr;
      else if (p.slept) { const floor = this.minVr - this.latency / 2; if (p.vr < floor) p.vr = floor; }
      p.slept = false;
      p.onq = true; p.qseq = this.seq++;
      this.q.push(p);
    },
    dequeue(p) { if (p.onq) { p.onq = false; const i = this.q.indexOf(p); if (i >= 0) this.q.splice(i, 1); } },
    pick() {
      const q = this.q, n = q.length;
      if (!n) return null;
      let bi = 0, b = q[0];
      for (let i = 1; i < n; i++) { const x = q[i]; if (x.vr < b.vr || (x.vr === b.vr && x.qseq < b.qseq)) { b = x; bi = i; } }
      q.splice(bi, 1);
      b.onq = false;
      if (b.vr > this.minVr) this.minVr = b.vr;
      return b;
    },
    quantum(p) {
      const q = this.q, n = q.length;
      if (!n) return this.latency;
      let tot = weightOf(p.nice);
      for (let i = 0; i < n; i++) tot += weightOf(q[i].nice);
      const period = Math.max(this.latency, (n + 1) * this.minGran);
      return Math.max(this.minGran, Math.round((period * weightOf(p.nice)) / tot));
    },
    account(p, used) {
      if (used <= 0) return;
      p.vr = (p.vr || 0) + (used * 1024) / weightOf(p.nice);
      const k = this.k;
      if (k.tracing('sched')) k.tev('sched', 'run', { pid: p.pid, comm: U.dec(p.comm), start: k.clock - used, dur: used, nice: p.nice, vruntime: r2(p.vr), weight: weightOf(p.nice) });
      this.last = p.state === 'R' ? p.pid : 0;
    },
    nr() { return this.q.length; },
  };

  LNX.kernel.plugin('sched', (k) => {
    const cfs = new CFS(k);
    // すでに待ち行列にいるもの（まだいないはず）を移す
    const old = k.sched;
    k.sched = cfs;
    if (old && old.q) for (const p of old.q.slice()) { old.dequeue(p); cfs.enqueue(p); }
    k.on('fork', (parent, child) => { child.vr = Math.max(parent.vr || 0, cfs.minVr); });
    k.on('state', (p, o, n) => {
      if (n === 'R' && (o === 'S' || o === 'D')) { p.slept = true; if (k.tracing('sched')) k.tev('sched', 'wakeup', { pid: p.pid, comm: U.dec(p.comm), vruntime: r2(Math.max(p.vr || 0, cfs.minVr - cfs.latency / 2)) }); }
    });
    let prev = 0;
    k.on('switch', (p) => {
      if (p.pid !== prev && k.tracing('sched')) k.tev('sched', 'switch', { from: cfs.last === prev ? prev : 0, to: p.pid, comm: U.dec(p.comm), vruntime: r2(p.vr || 0), nr: cfs.q.length + 1 });
      prev = p.pid;
    });
    k.procfs.pidFiles.sched = (p) => ({ read: () => p.comm + ' (' + p.pid + ', #threads: 1)\n-------------------------------------------------------------------\n' +
      'se.vruntime                                  :' + (p.vr || 0).toFixed(6).padStart(21) + '\n' +
      'se.sum_exec_runtime                          :' + (p.utime + p.stime).toFixed(6).padStart(21) + '\n' +
      'se.load.weight                               :' + String(weightOf(p.nice)).padStart(21) + '\n' +
      'nr_switches                                  :' + String(p.nvcsw + p.nivcsw).padStart(21) + '\n' +
      'nr_voluntary_switches                        :' + String(p.nvcsw).padStart(21) + '\n' +
      'nr_involuntary_switches                      :' + String(p.nivcsw).padStart(21) + '\n' +
      'policy                                       :' + '0'.padStart(21) + '\n' +
      'prio                                         :' + String(120 + p.nice).padStart(21) + '\n' });
    k.procfs.reg('sys/kernel/sched_latency_ns', { read: () => cfs.latency * 1000000 + '\n', write: (k2, p, d) => { if (p.euid !== 0) return -E.EACCES; const n = Math.round(+d / 1000000); if (!(n >= 1)) return -E.EINVAL; cfs.latency = n; } });
    k.procfs.reg('sys/kernel/sched_min_granularity_ns', { read: () => cfs.minGran * 1000000 + '\n', write: (k2, p, d) => { if (p.euid !== 0) return -E.EACCES; const n = Math.round(+d / 1000000); if (!(n >= 1)) return -E.EINVAL; cfs.minGran = n; } });
    return cfs;
  });

  const find = (k, p, n) => (n === 0 ? p : k.findPid ? k.findPid(p, n) : k.procs.get(n) || null);
  const targets = (k, p, which, who) => {
    if (which === 0) { const q = find(k, p, who); return q && q.state !== 'Z' ? [q] : []; }
    if (which === 1) { const pg = who === 0 ? p.pgid : (k.gpid ? k.gpid(p, who) : who); return Array.from(k.procs.values()).filter((q) => q.pgid === pg && q.state !== 'Z'); }
    if (which === 2) { const uid = who === 0 ? p.uid : who; return Array.from(k.procs.values()).filter((q) => q.uid === uid && q.state !== 'Z'); }
    return null;
  };
  const WHICH = ['PRIO_PROCESS', 'PRIO_PGRP', 'PRIO_USER'];
  LNX.kernel.syscall('setpriority', (k, p, a) => {
    const ts = targets(k, p, a[0] | 0, a[1] | 0);
    if (!ts) return -E.EINVAL;
    if (!ts.length) return -E.ESRCH;
    const nice = Math.max(-20, Math.min(19, a[2] | 0));
    let err = 0, ok = 0;
    for (const q of ts) {
      if (p.euid !== 0 && p.euid !== q.uid && p.uid !== q.uid) { err = -E.EPERM; continue; }
      if (p.euid !== 0 && nice < q.nice) { err = -E.EACCES; continue; }   // ふつうのユーザーは nice 値を下げられない（優先度を上げられない）
      const old = q.nice;
      q.nice = nice; ok++;
      if (k.tracing('sched')) k.tev('sched', 'nice', { pid: q.pid, nice, old });
    }
    return ok ? 0 : err;
  }, (a) => (WHICH[a[0] | 0] || a[0]) + ', ' + (a[1] | 0) + ', ' + (a[2] | 0));
  LNX.kernel.syscall('getpriority', (k, p, a) => {
    const ts = targets(k, p, a[0] | 0, a[1] | 0);
    if (!ts) return -E.EINVAL;
    if (!ts.length) return -E.ESRCH;
    return 20 - Math.min(...ts.map((q) => q.nice));
  }, (a) => (WHICH[a[0] | 0] || a[0]) + ', ' + (a[1] | 0));
  sys.nice = (who) => ({ n: 'getpriority', a: [0, who | 0] });

  LNX.kernel.M.sched = function () {
    const k = this.k, s = k.sched;
    const row = (p) => ({ pid: p.pid, comm: U.dec(p.comm), nice: p.nice, weight: weightOf(p.nice), vruntime: r2(p.vr || 0), state: p.state, cpu: p.utime + p.stime });
    return { name: s.name, latency: s.latency, minGranularity: s.minGran, minVruntime: r2(s.minVr || 0), weights: WEIGHT.slice(),
      queue: (s.q || []).slice().sort((a, b) => a.vr - b.vr || a.qseq - b.qseq).map(row), procs: Array.from(k.procs.values()).filter((p) => p.state !== 'Z').map(row) };
  };
  LNX.sched = { WEIGHT, weightOf };

  // ── コマンド ──
  const L = { late: true };
  P('nice', 'nice 値（優先度の遠慮の度合い）を変えてコマンドを実行する。引数なしなら、いまの nice 値を表示する', 'nice [-n 値] [コマンド [引数…]]   例：nice -n 10 burn 3', function* (c) {
    const av = c.argv;
    let i = 1, adj = 10, given = false;
    while (i < av.length) {
      const a = av[i];
      if (a === '-n') { if (av[i + 1] === undefined) { c.err("nice: option requires an argument -- 'n'\nTry 'nice --help' for more information.\n"); return 125; } adj = av[i + 1]; i += 2; given = true; } else if (/^-n-?\d+$/.test(a)) { adj = a.slice(2); i++; given = true; } else if (/^--adjustment=/.test(a)) { adj = a.slice(13); i++; given = true; } else if (/^-\d+$/.test(a)) { adj = a.slice(1); i++; given = true; } else if (a === '--') { i++; break; } else break;
    }
    if (!/^[-+]?\d+$/.test(String(adj))) { c.err('nice: invalid adjustment ' + "'" + adj + "'" + '\n'); return 125; }
    const cur = 20 - (yield sys.getpriority(0, 0));
    if (i >= av.length) {
      if (given) { c.err('nice: a command must be given with an adjustment\nTry \'nice --help\' for more information.\n'); return 125; }
      c.out(cur + '\n'); return 0;
    }
    const r = yield sys.setpriority(0, 0, cur + (+adj));
    if (r < 0) c.err('nice: cannot set niceness: ' + strerror(r) + '\n');
    yield* c.flush();
    const path = yield* c.which(av[i]);
    const e = path ? yield sys.execve(path, av.slice(i), c.env) : -E.ENOENT;
    c.err('nice: ' + "'" + av[i] + "'" + ': ' + strerror(e) + '\n');
    return e === -E.ENOENT ? 127 : 126;
  }, L);
  P('renice', '動いているプロセスの nice 値を変える', 'renice [-n] 値 [-p] PID…   例：renice -n 5 -p 123', function* (c) {
    const av = c.argv.slice(1);
    let prio = null, which = 0, rc = 0, n = 0, rel = false;
    if (av[0] === '-n' || av[0] === '--priority') { av.shift(); rel = false; }
    if (av[0] === undefined || !/^[-+]?\d+$/.test(av[0])) { c.err(av[0] === undefined ? 'renice: not enough arguments\n' : 'renice: invalid priority \'' + av[0] + '\'\n'); c.err("Try 'renice --help' for more information.\n"); return 1; }
    prio = +av.shift(); void rel;
    for (const a of av) {
      if (a === '-p' || a === '--pid') { which = 0; continue; }
      if (a === '-g' || a === '--pgrp') { which = 1; continue; }
      if (a === '-u' || a === '--user') { which = 2; continue; }
      let who = +a;
      const kind = ['process ID', 'process group ID', 'user ID'][which];
      if (which === 2 && !/^\d+$/.test(a)) { const u = (yield* c.passwd()).find((x) => x.name === a); if (!u) { c.err('renice: unknown user: ' + a + '\n'); rc = 1; continue; } who = u.uid; } else if (!/^\d+$/.test(a)) { c.err('renice: bad ' + kind + ' value: ' + a + '\n'); rc = 1; continue; }
      n++;
      const old = yield sys.getpriority(which, who);
      if (old < 0) { c.err('renice: failed to get priority for ' + who + ' (' + kind + '): ' + strerror(old) + '\n'); rc = 1; continue; }
      const r = yield sys.setpriority(which, who, prio);
      if (r < 0) { c.err('renice: failed to set priority for ' + who + ' (' + kind + '): ' + strerror(r) + '\n'); rc = 1; continue; }
      const now = 20 - (yield sys.getpriority(which, who));
      c.out(who + ' (' + kind + ') old priority ' + (20 - old) + ', new priority ' + now + '\n');
    }
    if (!n && !rc) { c.err('renice: not enough arguments\n'); return 1; }
    return rc;
  }, L);
  P('burn', 'CPU を使い続けて、最後に「もらえた CPU 時間」を報告する（スケジューラの練習用）', 'burn [秒数]   例：burn 3 & nice -n 10 burn 3 & wait', function* (c) {
    const sec = c.argv[1] !== undefined ? parseFloat(c.argv[1]) : 3;
    if (isNaN(sec) || sec < 0) return c.fail("invalid number '" + c.argv[1] + "'");
    const t0 = yield sys.time(), end = t0 + sec * 1000;
    for (;;) {
      const now = yield sys.time();
      if (now >= end) break;
      yield sys.cpu(Math.max(1, Math.min(50, end - now - 1)));
    }
    const ru = yield sys.getrusage(0), nice = 20 - (yield sys.getpriority(0, 0)), el = (yield sys.time()) - t0, cpu = ru.utime + ru.stime;
    c.out('burn: pid ' + (yield sys.getpid()) + ' nice ' + nice + ': cpu ' + cpu + ' ms / ' + el + ' ms (' + ((100 * cpu) / Math.max(1, el)).toFixed(1) + '%)\n');
    return 0;
  }, L);
  Object.assign(LNX.SYSJA, { setpriority: 'nice 値を変える', getpriority: 'nice 値を調べる（20 − nice が返る）' });
})(typeof window !== 'undefined' ? window : globalThis);
