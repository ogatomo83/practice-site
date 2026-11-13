// 図解 Linux の起動と init（17 章）。ns.js の後に読み込む。API は kernel.js の先頭コメントを見る。
//
// ■ 起動の流れ：ファームウェア → ブートローダ（GRUB）→ カーネル → initramfs → /sbin/init（PID 1）。
//   カーネルが出したログは dmesg で読める（/dev/kmsg）。時刻は「カーネルが動き始めてからの秒」で、PID 1 が動き出すのが 1.000000 秒のところ。毎回同じ内容になる。
//   sys.bootlog() → [{ stage: 'firmware' | 'bootloader' | 'kernel' | 'initramfs' | 'init', t（秒）, text }]（ファームウェアとブートローダの行は dmesg には出ない。図用）
//   sys.dmesg() → [{ t（秒）, level, text }]
// ■ init（PID 1）は systemd 風：unit ファイル（/usr/lib/systemd/system/*.service と /etc/systemd/system/*.service。同じ名前なら /etc が勝つ）を読み、
//   サービスを fork + execve して見張る。プロセスの名前は init のまま（本物の systemd も /sbin/init として起動される）。
//   unit ファイルで使えるキー：[Unit] Description=  [Service] ExecStart=  Restart=no | always | on-failure  RestartSec=（秒。既定 0.1）  User=  WorkingDirectory=
//   Environment=名前=値  Type=simple | oneshot  RemainAfterExit=yes  [Install] WantedBy=multi-user.target
//   サービスごとに：新しいセッション（setsid）、標準入力は /dev/null、標準出力とエラーはパイプで init が読んでジャーナルに書く、
//   cgroup は /sys/fs/cgroup/system.slice/名前.service。
//   サービスが死んだら Restart= に従って起動し直す（10 秒に 5 回を超えると「Start request repeated too quickly」であきらめる）。
//   止めるときは SIGTERM、5 秒たっても終わらなければ SIGKILL。親を失ったプロセスを引き取って回収するのも init。
//   起動時に自動で始まるのは /etc/systemd/system/multi-user.target.wants/ にリンクのある unit（systemctl enable が作る）。最初はどれも enable されていない。
//   用意してある unit：httpd.service（Web サーバ。ポート 80）、ticker.service（10 秒ごとに 1 行書く。Restart=always）。
// ■ ジャーナル：/var/log/journal/system.journal（1 行 1 件のテキスト。root と adm グループだけが読める）。journalctl で読む。再起動しても残る。
// ■ コマンド：systemctl（start stop restart status enable disable is-active is-enabled list-units list-unit-files daemon-reload cat show get-default
//   reboot poweroff）、journalctl（-u -n -k -b -f -r -p -o cat --no-pager --list-boots）、dmesg（-T -l -c）、shutdown、reboot、poweroff、halt、runlevel、ticker。
//   systemctl は UNIX ドメインソケット /run/systemd/private で init と話す。start / stop / enable などは root だけ。
// ■ 再起動：reboot（systemctl reboot）は「サービスを止める → sync → reboot システムコール」。reboot -f は sync してすぐ、reboot -ff は sync もしない（電源断と同じ）。
//   echo b > /proc/sysrq-trigger も sync なしの再起動。再起動すると、ディスク（/）の中身は残り、プロセス・メモリ・/tmp・/run は消える。時刻は進み続け、uptime は 0 に戻る。
//   sys.run の結果は reason: 'reboot' | 'poweroff'（電源を切った場合も、次の run のために起動し直してある）。sys.powerCut() は外から電源を切る。
//   reboot(方法) システムコール：'restart' | 'poweroff' | 'halt'（root だけ。sync はしない）。
// ■ 観察：sys.units() → [{ name, description, load, active, sub, enabled, mainPid, restarts, since, path, result }]、sys.journal({ unit, n }) → [{ t, time, unit, ident, pid, prio, msg, boot }]
(function (root) {
  'use strict';
  const LNX = root.LNX, E = LNX.ERRNO, sys = LNX.sys, U = LNX.util, O = LNX.O, SIG = LNX.SIG, W = LNX.W, F = LNX.F, strerror = LNX.strerror;
  const { P, isErr, lines } = LNX.binutil;
  const enc = U.enc, dec = U.dec;
  const BOOT_MS = 1000;   // カーネルが動き始めてから PID 1 が動き出すまで
  const SOCK = '/run/systemd/private', JOURNAL = '/var/log/journal/system.journal';
  const UNIT_DIRS = ['/usr/lib/systemd/system', '/etc/systemd/system'], WANTS = '/etc/systemd/system/multi-user.target.wants';

  LNX.kernel.plugin('init', (k) => {
    const st = { shared: {}, boots: (k.o.boots | 0) };
    const mm = k.sub.mm;
    const kb = (t, msg, lvl) => k.klog.push({ t: t - BOOT_MS, lvl: lvl === undefined ? 6 : lvl, msg });
    const early = k.klog.splice(0);
    kb(0, 'Linux version ' + k.uname.release + ' (zukai@build) (gcc 13.2.0, GNU ld 2.42) ' + k.uname.version, 5);
    kb(0, 'Command line: BOOT_IMAGE=/boot/vmlinuz-' + k.uname.release + ' root=/dev/sda1 ro quiet');
    kb(0, 'BIOS-provided physical RAM map:');
    kb(0, 'BIOS-e820: [mem 0x0000000000000000-0x0000000003ffffff] usable');
    kb(0, 'DMI: Zukai Virtual Machine, BIOS 1.0 04/01/2026');
    kb(4, 'Hypervisor detected: ZUKAI');
    kb(12, 'Memory: ' + (mm ? (mm.total - mm.reserved) * 4 + 'K/' + mm.total * 4 + 'K' : '59392K/65536K') + ' available (' + (mm ? mm.reserved * 4 : 6144) + 'K kernel code and data)');
    kb(20, 'smp: Brought up 1 node, 1 CPU');
    kb(45, 'devtmpfs: initialized');
    kb(88, 'clocksource: Switched to clocksource tsc');
    kb(130, 'NET: Registered PF_INET protocol family');
    kb(135, 'NET: Registered PF_UNIX/PF_LOCAL protocol family');
    kb(210, 'Trying to unpack rootfs image as initramfs...');
    kb(380, 'Freeing initrd memory: 4096K');
    kb(420, 'scsi 0:0:0:0: Direct-Access     ZUKAI    VIRTUAL DISK     1.0  PQ: 0 ANSI: 5');
    kb(455, 'sd 0:0:0:0: [sda] ' + k.rootfs.blocksTotal * 8 + ' 512-byte logical blocks: (' + ((k.rootfs.blocksTotal * 4096) / 1e6).toFixed(1) + ' MB/' + ((k.rootfs.blocksTotal * 4096) / 1048576).toFixed(1) + ' MiB)');
    kb(470, ' sda: sda1');
    kb(520, 'Freeing unused kernel image (initmem) memory: 2048K');
    kb(530, 'Run /init as init process');
    if (k.o.crash) { kb(690, 'EXT4-fs (sda1): INFO: recovering journal', 6); kb(740, 'EXT4-fs (sda1): recovery complete', 6); }
    kb(760, 'EXT4-fs (sda1): mounted filesystem with ordered data mode. Quota mode: none.');
    kb(905, 'EXT4-fs (sda1): re-mounted. Quota mode: none.');
    kb(960, 'cgroup: Unified hierarchy (cgroup v2) mounted at /sys/fs/cgroup');
    for (const e of early) k.klog.push(e);
    st.bootMs = BOOT_MS;
    // /dev/kmsg：1 回の read で 1 件「優先度,通し番号,マイクロ秒,-;本文」。書くとログに足される
    k.devs.set('1:11', {
      read(k2, p, ofd) { const i = ofd.kpos | 0; if (i >= k.klog.length) return ''; ofd.kpos = i + 1; const e = k.klog[i]; return e.lvl + ',' + i + ',' + (e.t + BOOT_MS) * 1000 + ',-;' + e.msg + '\n'; },
      write(k2, p, ofd, d) { let m = d.replace(/\n+$/, ''), lvl = 4; const r = /^<(\d)>/.exec(m); if (r) { lvl = +r[1]; m = m.slice(3); } for (const l of m.split('\n')) k.printk(l, lvl); return d.length; },
      ioctl(k2, p, ofd, req) { if (req === 'clear') { if (p.euid !== 0) return -E.EPERM; k.klog.length = 0; return 0; } return -E.ENOTTY; },
    });
    { const ki = k.mkDev('/dev/kmsg', 1, 11, 0o644); ki.ino = 3 + 1000; k.devfs.nextIno--; }   // /dev/pts/0 などの inode 番号を変えないよう、番号は離れたところから取る
    k.namei(k.kcred, '/dev/kmsg').mtime = k.namei(k.kcred, '/dev/kmsg').ctime = k.namei(k.kcred, '/dev/kmsg').atime = k.epoch - 9000;
    k.defsys('reboot', (k2, p, a) => {
      if (p.euid !== 0) return -E.EPERM;
      const mode = a[0] === 'poweroff' || a[0] === 'halt' ? a[0] : a[0] === 'restart' || a[0] === undefined ? 'restart' : null;
      if (!mode) return -E.EINVAL;
      k.printk(mode === 'restart' ? 'reboot: Restarting system' : mode === 'halt' ? 'reboot: System halted' : 'reboot: Power down', 0);
      k.rebootReq = { mode, crash: !!a[1] };
      k.setState(p, 'S');   // もう何も実行されない
      return 0;
    }, (a) => 'LINUX_REBOOT_MAGIC1, LINUX_REBOOT_MAGIC2, LINUX_REBOOT_CMD_' + (a[0] === 'poweroff' ? 'POWER_OFF' : a[0] === 'halt' ? 'HALT' : 'RESTART') + ', NULL');
    k.procfs.reg('sysrq-trigger', { mode: 0o200, read: () => '', write: (k2, p, d) => {
      if (p.euid !== 0) return -E.EACCES;
      const ch = d.trim()[0];
      if (ch === 'b') { k.printk('sysrq: Resetting', 6); k.rebootReq = { mode: 'restart', crash: true }; if (p.pid) k.setState(p, 'S'); } else if (ch === 's') { k.printk('sysrq: Emergency Sync', 6); k.emit('sync', null); } else if (ch === 'o') { k.printk('sysrq: Power Off', 6); k.rebootReq = { mode: 'poweroff', crash: true }; if (p.pid) k.setState(p, 'S'); } else return -E.EINVAL;
      return undefined;
    } });
    k.on('shutdown', (req) => { if (req) k.o.crash = !!req.crash; });
    k.defsys('_init', (k2, p) => (p.pid === 1 ? st.shared : -E.EPERM));
    // 接続してきた相手（SO_PEERCRED）
    k.wrapsys('connect', (o, k2, p, a, req) => { const r = o(k2, p, a, req); if (r === 0) { const e = p.fds[a[0]], s = e && e.ofd.inode.sock; if (s && s.peer && !s.peer.cred) s.peer.cred = { pid: p.pid, uid: p.euid, gid: p.egid }; } return r; });
    k.wrapsys('getsockopt', (o, k2, p, a, req) => { if (a[1] === 'SO_PEERCRED') { const e = p.fds[a[0]], s = e && e.ofd.inode.sock; return s && s.cred ? Object.assign({}, s.cred) : -E.ENOTCONN; } return o(k2, p, a, req); });
    if (!k.reused) {
      const t = k.epoch - 86400000 * 20;
      k.writeFile('/usr/lib/systemd/system/httpd.service', enc('[Unit]\nDescription=Zukai HTTP server\nAfter=network.target\n\n[Service]\nExecStart=/usr/bin/httpd -p 80 -d /var/www/html\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n'), 0o644, 0, 0, t);
      k.writeFile('/usr/lib/systemd/system/ticker.service', enc('[Unit]\nDescription=Write a line every 10 seconds\n\n[Service]\nExecStart=/usr/bin/ticker 10\nRestart=always\nRestartSec=1\n\n[Install]\nWantedBy=multi-user.target\n'), 0o644, 0, 0, t);
      k.mkdirp('/etc/systemd/system'); k.mkdirp(WANTS);
      const jd = k.mkdirp('/var/log/journal'); jd.gid = 4; jd.mode = 0o2755;
      k.writeFile(JOURNAL, '', 0o640, 0, 4, k.epoch - 2000);
      for (const d of ['/usr/lib/systemd', '/usr/lib/systemd/system', '/etc/systemd', '/etc/systemd/system', WANTS, '/var/log/journal']) { const i = k.namei(k.kcred, d); i.mtime = i.ctime = i.atime = t; }
    }
    // /etc/hostname をホスト名にする（本物では init の仕事。ここでは起動前に済ませる）
    if (k.reused) { const i = k.namei(k.kcred, '/etc/hostname'); if (typeof i !== 'number' && i.type === 'f') { const h = i.data.split('\n')[0].trim(); if (h && h.length <= 64) k.ns0.uts.hostname = h; } }
    return st;
  });

  // ── 観察 ──
  const M = LNX.kernel.M;
  const stamp = (ms) => { const s = Math.floor(ms / 1000), us = (ms % 1000) * 1000; return '[' + String(s).padStart(5) + '.' + String(us).padStart(6, '0') + ']'; };
  M.dmesg = function () { return this.k.klog.map((e) => ({ t: (e.t + BOOT_MS) / 1000, level: e.lvl, text: dec(e.msg) })); };
  M.bootlog = function () {
    const out = [
      { stage: 'firmware', t: -3.2, text: 'Power on. UEFI firmware: POST (power-on self test)' },
      { stage: 'firmware', t: -2.6, text: 'UEFI: found boot device: disk 0 (sda), EFI System Partition' },
      { stage: 'bootloader', t: -2.1, text: 'GRUB loading.' },
      { stage: 'bootloader', t: -1.4, text: "Loading Linux " + this.k.uname.release + ' ...' },
      { stage: 'bootloader', t: -0.6, text: 'Loading initial ramdisk ...' },
      { stage: 'bootloader', t: -0.1, text: 'Booting the kernel (root=/dev/sda1 ro quiet)' },
    ];
    let stage = 'kernel';
    for (const e of this.k.klog) {
      if (e.t >= 0) stage = 'init'; else if (/^Run \/init/.test(e.msg)) stage = 'initramfs';
      out.push({ stage: e.t >= 0 ? 'init' : stage, t: (e.t + BOOT_MS) / 1000, text: dec(e.msg) });
      if (/re-mounted/.test(e.msg)) stage = 'kernel';
    }
    return out;
  };
  M.units = function () {
    const sh = this.k.sub.init.shared, us = sh.units ? Array.from(sh.units.values()) : [];
    return us.map((u) => ({ name: u.name, description: dec(u.desc), load: 'loaded', active: u.active, sub: u.sub, enabled: !!u.enabled, mainPid: u.pid || 0, restarts: u.restarts, since: u.since, path: u.path, result: u.result })).sort((a, b) => (a.name < b.name ? -1 : 1));
  };
  const parseJournal = (text) => lines(text).map((l) => { const f = l.split('\t'); return { t: +f[0], prio: +f[1], unit: f[2], ident: f[3], pid: +f[4], msg: f.slice(6).join('\t'), boot: +f[5] }; }).filter((e) => !isNaN(e.t));
  M.journal = function (o) {
    o = o || {};
    const k = this.k, i = k.namei(k.kcred, JOURNAL);
    let es = typeof i === 'number' ? [] : parseJournal(i.data).map((e) => Object.assign(e, { msg: dec(e.msg), time: U.strftime('%Y-%m-%d %H:%M:%S', e.t) }));
    if (o.unit) { const u = /\./.test(o.unit) ? o.unit : o.unit + '.service'; es = es.filter((e) => e.unit === u); }
    if (o.n) es = es.slice(-o.n);
    return es;
  };

  // ── PID 1 ──
  const words = (s) => { const out = []; const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g; let m; while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]); return out; };
  function parseUnit(text) {
    const u = { desc: '', exec: '', restart: 'no', restartSec: 100, user: '', wd: '', env: {}, type: 'simple', remain: false, wantedBy: [] };
    let sec = '';
    for (const raw of text.split('\n')) {
      const l = raw.trim();
      if (!l || l[0] === '#' || l[0] === ';') continue;
      const s = /^\[(\w+)\]$/.exec(l);
      if (s) { sec = s[1]; continue; }
      const eq = l.indexOf('='); if (eq < 0) continue;
      const key = l.slice(0, eq).trim(), v = l.slice(eq + 1).trim();
      if (sec === 'Unit' && key === 'Description') u.desc = v;
      else if (sec === 'Service') {
        if (key === 'ExecStart') u.exec = v; else if (key === 'Restart') u.restart = v; else if (key === 'RestartSec') { const n = parseFloat(v); if (!isNaN(n)) u.restartSec = Math.round(n * (/ms$/.test(v) ? 1 : 1000)); } else if (key === 'User') u.user = v; else if (key === 'WorkingDirectory') u.wd = v;
        else if (key === 'Type') u.type = v; else if (key === 'RemainAfterExit') u.remain = /^(yes|true|1|on)$/i.test(v); else if (key === 'Environment') for (const w of words(v)) { const i = w.indexOf('='); if (i > 0) u.env[w.slice(0, i)] = w.slice(i + 1); }
      } else if (sec === 'Install' && key === 'WantedBy') u.wantedBy = v.split(/\s+/);
    }
    return u;
  }
  const svc = (n) => (/\.(service|target)$/.test(n) ? n : n + '.service');
  const sigName = (s) => LNX.SIGNAME[s] || String(s);
  const EXITNAME = { 0: 'SUCCESS', 1: 'FAILURE', 2: 'INVALIDARGUMENT', 126: 'n/a', 127: 'n/a', 203: 'EXEC', 217: 'USER', 200: 'CHDIR' };

  LNX.bin.init.help = 'PID 1。すべてのプロセスの先祖。サービスを起動して見張り（systemd 風）、親をなくしたプロセスを引き取る';
  LNX.bin.init.main = function* (c) {
    const shared = yield sys._init();
    if (typeof shared !== 'object') { c.err(enc('init: PID 1 として起動されていません。サービスの操作は systemctl を使ってください\n')); return 1; }
    const S = { units: new Map(), conns: new Set(), pipes: new Map(), timers: [], boot: 0, shutting: false };
    shared.units = S.units;
    const host = (yield sys.uname()).nodename;
    let jfd = -1;
    const cloexec = function* (fd) { if (fd >= 0) yield sys.fcntl(fd, F.SETFD, 1); return fd; };
    // 子が終わったら、自分あてのパイプに 1 バイト書いて poll を起こす（self-pipe）
    const sp = yield sys.pipe(O.NONBLOCK | O.CLOEXEC);
    yield sys.sigaction(SIG.CHLD, function* () { yield sys.write(sp[1], '!'); }, { restart: true });
    for (const s of [SIG.TERM, SIG.INT, SIG.HUP, SIG.PIPE]) yield sys.sigaction(s, 'SIG_IGN');
    const jlog = function* (unit, ident, pid, msg, prio) {
      const now = yield sys.time();
      const u = S.units.get(unit);
      if (u) { u.tail.push({ t: now, ident, pid, msg }); if (u.tail.length > 10) u.tail.shift(); }
      if (jfd >= 0) yield sys.write(jfd, now + '\t' + (prio === undefined ? 6 : prio) + '\t' + unit + '\t' + ident + '\t' + pid + '\t' + S.boot + '\t' + msg.replace(/\n/g, ' ') + '\n');
    };
    const ilog = (unit, msg, prio) => jlog(unit, 'init', 1, msg, prio);
    const kmsg = function* (msg) { const fd = yield sys.open('/dev/kmsg', O.WRONLY); if (fd >= 0) { yield sys.write(fd, '<6>init[1]: ' + msg + '\n'); yield sys.close(fd); } };
    const label = (u) => u.name + (u.desc ? ' - ' + u.desc : '');
    const after = (ms, fn) => { const t = { at: 0, ms, fn }; S.timers.push(t); return t; };

    // unit ファイルを読む
    const loadUnits = function* () {
      const found = new Map();
      for (const d of UNIT_DIRS) {
        const ents = yield* c.readDir(d);
        if (isErr(ents)) continue;
        for (const e of ents) if (/\.service$/.test(e.name) && e.type !== 'd') found.set(e.name, d + '/' + e.name);
      }
      const wants = yield* c.readDir(WANTS), en = new Set(isErr(wants) ? [] : wants.map((e) => e.name));
      for (const [name, path] of found) {
        const text = yield* c.slurp(path);
        if (typeof text !== 'string') continue;
        const def = parseUnit(text);
        let u = S.units.get(name);
        if (!u) { u = { name, active: 'inactive', sub: 'dead', pid: 0, since: 0, restarts: 0, starts: [], tail: [], waiters: [], result: 'success', code: null, rfd: -1, stopping: false }; S.units.set(name, u); }
        Object.assign(u, def, { path, enabled: en.has(name) });
      }
      for (const [name, u] of Array.from(S.units)) if (!found.has(name) && u.active === 'inactive') S.units.delete(name); else if (!found.has(name)) u.gone = true;
    };
    const cgPath = (u) => '/sys/fs/cgroup/system.slice/' + u.name;
    const startUnit = function* (u, why) {
      if (u.active === 'active' || u.sub === 'start') return 0;
      if (!u.exec) { yield* ilog(u.name, u.name + ': Service has no ExecStart= setting. Refusing.', 3); u.active = 'failed'; u.sub = 'failed'; u.result = 'resources'; return 1; }
      const argv = words(u.exec.replace(/^[-@+!]+/, ''));
      const pr = yield sys.pipe(O.CLOEXEC);
      if (!Array.isArray(pr)) return 1;
      yield sys.mkdir('/sys/fs/cgroup/system.slice', 0o755);
      yield sys.mkdir(cgPath(u), 0o755);
      const env = Object.assign({ PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', INVOCATION_ID: u.name }, u.env);
      let uid = -1, gid = -1, home = '/';
      if (u.user) { const pw = (yield* c.passwd()).find((x) => x.name === u.user || String(x.uid) === u.user); if (pw) { uid = pw.uid; gid = pw.gid; home = pw.home; env.USER = env.LOGNAME = pw.name; env.HOME = home; } else uid = -2; }
      const cg = cgPath(u) + '/cgroup.procs';
      const pid = yield sys.fork(function* (c2) {
        yield sys.setsid();
        for (const s of [SIG.TERM, SIG.INT, SIG.HUP, SIG.PIPE, SIG.CHLD]) yield sys.sigaction(s, 'SIG_DFL');
        const nul = yield sys.open('/dev/null', O.RDONLY);
        yield sys.dup2(nul, 0); yield sys.dup2(pr[1], 1); yield sys.dup2(pr[1], 2);
        if (nul > 2) yield sys.close(nul);
        const cf = yield sys.open(cg, O.WRONLY);
        if (cf >= 0) { yield sys.write(cf, '0\n'); yield sys.close(cf); }
        if (uid === -2) { c2.err(u.name + ': Failed to determine user credentials: No such process\n'); return 217; }
        if (uid >= 0) { yield sys.setgroups([gid]); yield sys.setgid(gid); yield sys.setuid(uid); }
        if (u.wd) { const r = yield sys.chdir(u.wd); if (r < 0) { c2.err(u.name + ': Changing to the requested working directory failed: ' + strerror(r) + '\n'); return 200; } } else yield sys.chdir('/');
        const r = yield sys.execve(argv[0], argv, env);
        c2.err(u.name + ': Failed to execute ' + argv[0] + ': ' + strerror(r) + '\n');
        return 203;
      });
      yield sys.close(pr[1]);
      if (pid < 0) { yield sys.close(pr[0]); yield* ilog(u.name, u.name + ': Failed to fork: ' + strerror(pid), 3); u.active = 'failed'; u.sub = 'failed'; u.result = 'resources'; return 1; }
      u.pid = pid; u.rfd = pr[0]; u.comm = U.basename(argv[0]); u.active = 'active'; u.sub = 'running'; u.since = yield sys.time(); u.stopping = false; u.result = 'success'; u.code = null; u.buf = '';
      S.pipes.set(pr[0], u);
      yield* ilog(u.name, 'Started ' + label(u) + '.');
      void why;
      return 0;
    };
    const finishWaiters = function* (u, rc, text) { for (const fd of u.waiters.splice(0)) yield* reply(fd, rc, '', text || ''); };
    const cleanup = function* (u) {
      if (u.rfd >= 0) { yield* drain(u, true); S.pipes.delete(u.rfd); yield sys.close(u.rfd); u.rfd = -1; }
      const kf = yield sys.open(cgPath(u) + '/cgroup.kill', O.WRONLY);
      if (kf >= 0) { yield sys.write(kf, '1\n'); yield sys.close(kf); }
      yield sys.rmdir(cgPath(u));
    };
    const onExit = function* (pid, status) {
      let u = null;
      for (const x of S.units.values()) if (x.pid === pid) u = x;
      if (!u) return;   // 引き取った孤児
      const sig = status & 0x7f, code = (status >> 8) & 0xff, now = yield sys.time();
      u.pid = 0; u.code = sig ? { sig } : { code };
      yield* cleanup(u);
      if (u.stopTimer) { S.timers.splice(S.timers.indexOf(u.stopTimer), 1); u.stopTimer = null; }
      const ok = !sig && code === 0, bySig = !!sig && (u.stopping && (sig === SIG.TERM || sig === SIG.KILL));
      if (u.stopping) {
        u.active = 'inactive'; u.sub = 'dead'; u.since = now; u.stopping = false;
        yield* ilog(u.name, u.name + ': Deactivated successfully.');
        yield* ilog(u.name, 'Stopped ' + label(u) + '.');
        yield* finishWaiters(u, 0);
        if (u.restartAfterStop) { u.restartAfterStop = false; yield* startUnit(u); }
        return;
      }
      void bySig;
      if (ok) {
        yield* ilog(u.name, u.name + ': Deactivated successfully.');
        if (u.type === 'oneshot' && u.remain) { u.active = 'active'; u.sub = 'exited'; } else { u.active = 'inactive'; u.sub = 'dead'; u.since = now; }
      } else {
        yield* ilog(u.name, u.name + ': Main process exited, code=' + (sig ? 'killed, status=' + sig + '/' + sigName(sig) : 'exited, status=' + code + '/' + (EXITNAME[code] || 'n/a')), 5);
        u.result = sig ? 'signal' : 'exit-code';
        yield* ilog(u.name, u.name + ": Failed with result '" + u.result + "'.", 4);
        u.active = 'failed'; u.sub = 'failed'; u.since = now;
      }
      if (S.shutting) return;
      if (u.restart === 'always' || (u.restart === 'on-failure' && !ok)) {
        u.starts = u.starts.filter((t) => now - t < 10000);
        if (u.starts.length >= 5) {
          yield* ilog(u.name, u.name + ': Start request repeated too quickly.', 4);
          yield* ilog(u.name, u.name + ": Failed with result '" + (ok ? 'start-limit-hit' : u.result) + "'.", 4);
          yield* ilog(u.name, 'Failed to start ' + label(u) + '.', 3);
          u.active = 'failed'; u.sub = 'failed'; if (ok) u.result = 'start-limit-hit';
          return;
        }
        u.starts.push(now);
        u.active = 'activating'; u.sub = 'auto-restart';
        u.restartTimer = after(u.restartSec, function* () {
          u.restartTimer = null;
          if (u.sub !== 'auto-restart') return;
          u.restarts++;
          yield* ilog(u.name, u.name + ': Scheduled restart job, restart counter is at ' + u.restarts + '.');
          u.active = 'inactive'; u.sub = 'dead';
          yield* startUnit(u);
        });
      }
    };
    const stopUnit = function* (u, fd) {
      if (u.restartTimer) { S.timers.splice(S.timers.indexOf(u.restartTimer), 1); u.restartTimer = null; }
      if (!u.pid) { if (u.sub === 'auto-restart' || u.sub === 'exited') { u.active = 'inactive'; u.sub = 'dead'; yield* ilog(u.name, 'Stopped ' + label(u) + '.'); } if (fd >= 0) yield* reply(fd, 0, '', ''); return; }
      if (fd >= 0) u.waiters.push(fd);
      if (u.stopping) return;
      u.stopping = true; u.active = 'deactivating'; u.sub = 'stop-sigterm';
      yield* ilog(u.name, 'Stopping ' + label(u) + '...');
      yield sys.kill(u.pid, SIG.TERM);
      u.stopTimer = after(5000, function* () { u.stopTimer = null; if (u.pid) { yield* ilog(u.name, u.name + ': State \'stop-sigterm\' timed out. Killing.', 4); yield sys.kill(u.pid, SIG.KILL); } });
    };
    // サービスの出力をジャーナルへ
    const drain = function* (u, all) {
      for (;;) {
        const r = all ? yield sys.poll([{ fd: u.rfd, events: 'r' }], 0) : null;
        if (all && (!Array.isArray(r) || !r.length || !(r[0].r))) break;
        const d = yield sys.read(u.rfd, 4096);
        if (typeof d !== 'string' || d === '') { if (u.buf) { yield* jlog(u.name, u.comm, u.lastPid || 0, u.buf); u.buf = ''; } return false; }
        u.buf += d;
        let i;
        while ((i = u.buf.indexOf('\n')) >= 0) { const l = u.buf.slice(0, i); u.buf = u.buf.slice(i + 1); yield* jlog(u.name, u.comm, u.pid || u.lastPid || 0, l); }
        if (u.pid) u.lastPid = u.pid;
        if (!all) break;
      }
      return true;
    };
    const reply = function* (fd, rc, out, err) { yield* c.writeAll(fd, rc + '\n' + (out || '') + '\0' + (err || '')); yield sys.close(fd); S.conns.delete(fd); };
    const fmtSince = (ms, now) => { const d = Math.max(0, Math.floor((now - ms) / 1000)); const ago = d < 60 ? d + 's' : d < 3600 ? Math.floor(d / 60) + 'min' + (d % 60 ? ' ' + (d % 60) + 's' : '') : Math.floor(d / 3600) + 'h ' + Math.floor(d / 60) % 60 + 'min'; return U.strftime('%a %Y-%m-%d %H:%M:%S %Z', ms) + '; ' + ago + ' ago'; };
    const jline = (e) => U.strftime('%b %d %H:%M:%S', e.t) + ' ' + host + ' ' + e.ident + '[' + e.pid + ']: ' + e.msg;
    const statusText = function* (u) {
      const now = yield sys.time();
      const dot = u.active === 'active' ? enc('●') : u.active === 'failed' ? enc('×') : enc('○');
      let o = dot + ' ' + label(u) + '\n     Loaded: loaded (' + u.path + '; ' + (u.enabled ? 'enabled' : 'disabled') + '; preset: enabled)\n';
      const res = u.code ? (u.code.sig ? '(Result: signal)' : u.code.code ? '(Result: exit-code)' : '') : '';
      if (u.active === 'active') o += '     Active: active (' + u.sub + ') since ' + fmtSince(u.since, now) + '\n';
      else if (u.active === 'failed') o += '     Active: failed ' + res + ' since ' + fmtSince(u.since, now) + '\n';
      else if (u.active === 'activating') o += '     Active: activating (auto-restart) ' + res + ' since ' + fmtSince(u.since, now) + '\n';
      else o += '     Active: inactive (dead)' + (u.since ? ' since ' + fmtSince(u.since, now) : '') + '\n';
      if (u.pid) {
        o += '   Main PID: ' + u.pid + ' (' + u.comm + ')\n';
        const procs = yield* c.slurp(cgPath(u) + '/cgroup.procs'), mem = yield* c.slurp(cgPath(u) + '/memory.current');
        const pids = typeof procs === 'string' ? lines(procs) : [];
        o += '      Tasks: ' + pids.length + ' (limit: 256)\n';
        if (typeof mem === 'string') { const b = +mem; o += '     Memory: ' + (b >= 1048576 ? (b / 1048576).toFixed(1) + 'M' : (b / 1024).toFixed(1) + 'K') + '\n'; }
        const ru = yield* c.slurp('/proc/' + u.pid + '/schedstat');
        if (typeof ru === 'string') { const f = ru.split(' '); o += '        CPU: ' + (+f[0] + +f[1]) + 'ms\n'; }
        o += '     CGroup: /system.slice/' + u.name + '\n';
        for (let i = 0; i < pids.length; i++) { const cl = yield* c.slurp('/proc/' + pids[i] + '/cmdline'); o += '             ' + enc(i === pids.length - 1 ? '└─' : '├─') + pids[i] + ' ' + (typeof cl === 'string' ? cl.replace(/\0$/, '').split('\0').join(' ') : '') + '\n'; }
      } else if (u.code && u.lastPid) o += '    Process: ' + u.lastPid + ' ExecStart=' + u.exec + ' (code=' + (u.code.sig ? 'killed, signal=' + sigName(u.code.sig) : 'exited, status=' + u.code.code + '/' + (EXITNAME[u.code.code] || 'n/a')) + ')\n   Main PID: ' + u.lastPid + ' (code=' + (u.code.sig ? 'killed, signal=' + sigName(u.code.sig) : 'exited, status=' + u.code.code + '/' + (EXITNAME[u.code.code] || 'n/a')) + ')\n';
      if (u.tail.length) o += '\n' + u.tail.map(jline).join('\n') + '\n';
      return o;
    };
    const wl = (v) => dec(v).length;
    const table = (rows, heads) => { const w = heads.map((h, i) => Math.max(wl(h), ...rows.map((r) => wl(r[i])))); return [heads].concat(rows).map((r) => r.map((v, i) => (i === r.length - 1 ? v : v + ' '.repeat(w[i] - wl(v)))).join(' ')).join('\n') + '\n'; };
    const shutdown = function* (mode) {
      if (S.shutting) return;
      S.shutting = true;
      yield* ilog('init.scope', mode === 'restart' ? 'Reached target reboot.target - System Reboot.' : 'Reached target poweroff.target - System Power Off.');
      for (const u of S.units.values()) if (u.pid) yield* stopUnit(u, -1);
      S.finalAt = (yield sys.time()) + 5500; S.finalMode = mode;
    };
    const handle = function* (fd, line, cred) {
      const av = line.trim().split(/\s+/), verb = av[0], rootOnly = ['start', 'stop', 'restart', 'enable', 'disable', 'daemon-reload', 'reboot', 'poweroff', 'halt', 'kill', 'try-restart', 'reload-or-restart'];
      const names = av.slice(1).filter((a) => a[0] !== '-').map(svc), flags = av.slice(1).filter((a) => a[0] === '-');
      if (rootOnly.indexOf(verb) >= 0 && cred.uid !== 0) {
        const what = verb === 'reboot' || verb === 'poweroff' || verb === 'halt' ? 'Call to ' + (verb === 'reboot' ? 'Reboot' : verb === 'halt' ? 'Halt' : 'PowerOff') + ' failed: Interactive authentication required.\n' : verb === 'daemon-reload' ? 'Failed to reload daemon: Interactive authentication required.\n' : 'Failed to ' + verb + ' ' + (names[0] || '') + ': Interactive authentication required.\nSee system logs and \'systemctl status ' + (names[0] || '') + "' for details.\n";
        return yield* reply(fd, 1, '', what);
      }
      const need = function* () { const out = []; for (const n of names) { const u = S.units.get(n); if (!u) { yield* reply(fd, verb === 'status' ? 4 : 5, '', verb === 'status' ? 'Unit ' + n + ' could not be found.\n' : 'Failed to ' + verb + ' ' + n + ': Unit ' + n + ' not found.\n'); return null; } out.push(u); } if (!out.length) { yield* reply(fd, 1, '', 'Too few arguments.\n'); return null; } return out; };
      switch (verb) {
        case 'start': { const us = yield* need(); if (!us) return; let rc = 0; for (const u of us) { u.starts = []; if (u.restartTimer) { S.timers.splice(S.timers.indexOf(u.restartTimer), 1); u.restartTimer = null; u.active = 'inactive'; u.sub = 'dead'; } if (yield* startUnit(u)) rc = 1; } return yield* reply(fd, rc, '', rc ? 'Job for ' + us[0].name + ' failed because the control process exited with error code.\nSee "systemctl status ' + us[0].name + '" and "journalctl -xeu ' + us[0].name + '" for details.\n' : ''); }
        case 'stop': { const us = yield* need(); if (!us) return; for (let i = 0; i < us.length; i++) yield* stopUnit(us[i], i === us.length - 1 ? fd : -1); return; }
        case 'restart': case 'try-restart': case 'reload-or-restart': { const us = yield* need(); if (!us) return; for (const u of us) { u.starts = []; if (u.pid) { u.restartAfterStop = true; yield* stopUnit(u, -1); } else { if (u.restartTimer) { S.timers.splice(S.timers.indexOf(u.restartTimer), 1); u.restartTimer = null; } u.active = 'inactive'; u.sub = 'dead'; yield* startUnit(u); } } return yield* reply(fd, 0, '', ''); }
        case 'kill': { const us = yield* need(); if (!us) return; const sg = (flags.find((f) => /^--signal=|^-s/.test(f)) || '').replace(/^--signal=|^-s/, ''); const n = /^\d+$/.test(sg) ? +sg : SIG[sg.replace(/^SIG/, '')] || SIG.TERM; for (const u of us) if (u.pid) yield sys.kill(u.pid, n); return yield* reply(fd, 0, '', ''); }
        case 'status': {
          if (!names.length) { const now = yield sys.time(); void now; const failed = Array.from(S.units.values()).filter((u) => u.active === 'failed').length; return yield* reply(fd, 0, enc('● ') + host + '\n    State: ' + (failed ? 'degraded' : 'running') + '\n    Units: ' + (S.units.size + 1) + ' loaded (incl. loaded aliases)\n     Jobs: 0 queued\n   Failed: ' + failed + ' units\n    Since: ' + U.strftime('%a %Y-%m-%d %H:%M:%S %Z', shared.bootAt) + '\n   CGroup: /\n', ''); }
          const us = yield* need(); if (!us) return;
          let o = '', rc = 0;
          for (const u of us) { o += (o ? '\n' : '') + (yield* statusText(u)); if (u.active !== 'active') rc = 3; }
          return yield* reply(fd, rc, o, '');
        }
        case 'is-active': { let o = '', rc = 3; for (const n of names) { const u = S.units.get(n); o += (u ? u.active : 'inactive') + '\n'; if (u && u.active === 'active') rc = 0; } return yield* reply(fd, names.length ? rc : 1, o, ''); }
        case 'is-enabled': { let o = '', rc = 1, er = ''; for (const n of names) { const u = S.units.get(n); if (!u) { er += 'Failed to get unit file state for ' + n + ': No such file or directory\n'; continue; } o += (u.enabled ? 'enabled' : 'disabled') + '\n'; if (u.enabled) rc = 0; } return yield* reply(fd, rc, o, er); }
        case 'is-failed': { let o = '', rc = 1; for (const n of names) { const u = S.units.get(n); o += (u ? u.active : 'inactive') + '\n'; if (u && u.active === 'failed') rc = 0; } return yield* reply(fd, rc, o, ''); }
        case 'enable': case 'disable': {
          const us = yield* need(); if (!us) return;
          let er = '';
          for (const u of us) {
            const link = WANTS + '/' + u.name;
            if (verb === 'enable') { if (!u.wantedBy.length) { er += 'The unit files have no installation config (WantedBy=, RequiredBy=, UpheldBy=,\nAlso=, or Alias= settings in the [Install] section, and DefaultInstance= for\ntemplate units). This means they are not meant to be enabled or disabled using systemctl.\n'; continue; } yield sys.mkdir(WANTS, 0o755); const r = yield sys.symlink(u.path, link); if (r === 0) er += 'Created symlink ' + link + enc(' → ') + u.path + '.\n'; u.enabled = true; } else { const r = yield sys.unlink(link); if (r === 0) er += 'Removed "' + link + '".\n'; u.enabled = false; }
            if (flags.indexOf('--now') >= 0) { if (verb === 'enable') { u.starts = []; yield* startUnit(u); } else if (u.pid) yield* stopUnit(u, -1); }
          }
          return yield* reply(fd, 0, '', er);
        }
        case 'daemon-reload': yield* loadUnits(); return yield* reply(fd, 0, '', '');
        case 'list-units': {
          const all = flags.indexOf('--all') >= 0 || flags.indexOf('-a') >= 0, type = (flags.find((f) => /^--type=|^-t/.test(f)) || '').replace(/^--type=|^-t/, '');
          const rows = [];
          for (const u of Array.from(S.units.values()).sort((a, b) => (a.name < b.name ? -1 : 1))) if (all || u.active !== 'inactive') rows.push([(u.active === 'failed' ? enc('● ') : '  ') + u.name, 'loaded', u.active, u.sub, u.desc]);
          if (!type || type === 'target') rows.push(['  multi-user.target', 'loaded', 'active', 'active', 'Multi-User System']);
          const body = table(rows, ['  UNIT', 'LOAD', 'ACTIVE', 'SUB', 'DESCRIPTION']);
          return yield* reply(fd, 0, body + '\nLegend: LOAD   ' + enc('→') + ' Reflects whether the unit definition was properly loaded.\n        ACTIVE ' + enc('→') + ' The high-level unit activation state, i.e. generalization of SUB.\n        SUB    ' + enc('→') + ' The low-level unit activation state, values depend on unit type.\n\n' + rows.length + ' loaded units listed.' + (all ? '' : ' Pass --all to see loaded but inactive units, too.') + "\nTo show all installed unit files use 'systemctl list-unit-files'.\n", '');
        }
        case 'list-unit-files': { const rows = Array.from(S.units.values()).sort((a, b) => (a.name < b.name ? -1 : 1)).map((u) => [u.name, u.enabled ? 'enabled' : u.wantedBy.length ? 'disabled' : 'static', u.wantedBy.length ? 'enabled' : '-']); return yield* reply(fd, 0, table(rows, ['UNIT FILE', 'STATE', 'PRESET']) + '\n' + rows.length + ' unit files listed.\n', ''); }
        case 'cat': { const us = yield* need(); if (!us) return; let o = ''; for (const u of us) { const t = yield* c.slurp(u.path); o += (o ? '\n' : '') + '# ' + u.path + '\n' + (typeof t === 'string' ? t : ''); } return yield* reply(fd, 0, o, ''); }
        case 'show': { const us = yield* need(); if (!us) return; let o = ''; for (const u of us) o += 'Id=' + u.name + '\nDescription=' + u.desc + '\nLoadState=loaded\nActiveState=' + u.active + '\nSubState=' + u.sub + '\nMainPID=' + u.pid + '\nExecStart=' + u.exec + '\nRestart=' + u.restart + '\nNRestarts=' + u.restarts + '\nUnitFileState=' + (u.enabled ? 'enabled' : 'disabled') + '\nFragmentPath=' + u.path + '\n'; return yield* reply(fd, 0, o, ''); }
        case 'get-default': return yield* reply(fd, 0, 'multi-user.target\n', '');
        case 'reboot': case 'poweroff': case 'halt': S.conns.delete(fd); yield* shutdown(verb === 'reboot' ? 'restart' : verb); return;   // 返事はしない（機械が止まるまで相手は待つ）
        default: return yield* reply(fd, 1, '', 'Unknown command verb ' + verb + '.\n');
      }
    };

    // ── 起動 ──
    jfd = yield* cloexec(yield sys.open(JOURNAL, O.WRONLY | O.APPEND | O.CREAT, 0o640));
    shared.bootAt = yield sys.time();
    // 何回目の起動か（ジャーナルの最後の行から）
    { const st = yield sys.stat(JOURNAL); if (!isErr(st) && st.size > 0) { const d = yield* c.slurp(JOURNAL); if (typeof d === 'string') { const ls = lines(d), f = ls.length ? ls[ls.length - 1].split('\t') : []; S.boot = (+f[5] || 0) + 1; } } }
    yield sys.mkdir('/run/systemd', 0o755);
    const lfd = yield* cloexec(yield sys.socket('unix', 'stream'));
    yield sys.bind(lfd, { path: SOCK });
    yield sys.chmod(SOCK, 0o666);
    yield sys.listen(lfd, 16);
    yield* loadUnits();
    yield* kmsg('Zukai init 1.0 running in system mode (systemd-like unit files)');
    yield* kmsg('Hostname set to <' + host + '>.');
    yield* ilog('init.scope', 'Zukai init 1.0 running in system mode. Boot #' + (S.boot + 1) + '.');
    for (const u of Array.from(S.units.values()).sort((a, b) => (a.name < b.name ? -1 : 1))) if (u.enabled) yield* startUnit(u, 'boot');
    yield* ilog('init.scope', 'Reached target multi-user.target - Multi-User System.');
    yield* kmsg('Reached target multi-user.target - Multi-User System.');
    yield* ilog('init.scope', 'Startup finished in ' + (BOOT_MS / 1000).toFixed(3) + 's (kernel) + ' + (((yield sys.time()) - shared.bootAt) / 1000).toFixed(3) + 's (userspace).');

    for (;;) {
      for (;;) { const w = yield sys.wait4(-1, W.NOHANG); if (!w || typeof w === 'number') break; yield* onExit(w.pid, w.status); }
      const now = yield sys.time();
      let tmo = -1;
      for (const t of S.timers.slice()) { if (!t.at) t.at = now + t.ms; if (t.at <= now) { S.timers.splice(S.timers.indexOf(t), 1); yield* t.fn(); } }
      for (const t of S.timers) { if (!t.at) t.at = now + t.ms; tmo = tmo < 0 ? Math.max(1, t.at - now) : Math.min(tmo, Math.max(1, t.at - now)); }
      if (S.shutting) {
        const alive = Array.from(S.units.values()).some((u) => u.pid);
        if (!alive || now >= S.finalAt) {
          yield* ilog('init.scope', 'Shutting down.');
          yield sys.sync();
          yield sys.reboot(S.finalMode);
        }
        tmo = tmo < 0 ? 100 : Math.min(tmo, 100);
      }
      const fds = [{ fd: sp[0], events: 'r' }, { fd: lfd, events: 'r' }];
      for (const fd of S.conns) fds.push({ fd, events: 'r' });
      for (const fd of S.pipes.keys()) fds.push({ fd, events: 'r' });
      const r = yield sys.poll(fds, tmo);
      if (!Array.isArray(r)) continue;
      for (const f of r) {
        if (f.fd === sp[0]) { yield sys.read(sp[0], 64); continue; }
        if (f.fd === lfd) { const cfd = yield sys.accept(lfd); if (cfd >= 0) { yield sys.fcntl(cfd, F.SETFD, 1); S.conns.add(cfd); } continue; }
        if (S.conns.has(f.fd)) {
          const d = yield sys.read(f.fd, 4096);
          if (typeof d !== 'string' || d === '') { yield sys.close(f.fd); S.conns.delete(f.fd); for (const u of S.units.values()) { const i = u.waiters.indexOf(f.fd); if (i >= 0) u.waiters.splice(i, 1); } continue; }
          const cred = yield sys.getsockopt(f.fd, 'SO_PEERCRED');
          S.conns.delete(f.fd);
          yield* handle(f.fd, d, typeof cred === 'object' ? cred : { uid: 65534, pid: 0 });
          continue;
        }
        const u = S.pipes.get(f.fd);
        if (u) { const more = yield* drain(u, false); if (!more && !u.pid) { S.pipes.delete(f.fd); yield sys.close(f.fd); u.rfd = -1; } else if (!more) { S.pipes.delete(f.fd); yield sys.close(f.fd); u.rfd = -1; } }
      }
    }
  };

  // ── コマンド ──
  const L = { late: true };
  function* ask(c, line) {
    const fd = yield sys.socket('unix', 'stream');
    const r = yield sys.connect(fd, { path: SOCK });
    if (r < 0) { yield sys.close(fd); return { rc: 1, out: '', err: 'Failed to connect to bus: ' + strerror(r) + '\n' }; }
    yield* c.writeAll(fd, line + '\n');
    const d = yield* c.readAll(fd);
    yield sys.close(fd);
    if (typeof d !== 'string' || d === '') return { rc: 1, out: '', err: '' };
    const nl = d.indexOf('\n'), z = d.indexOf('\0');
    return { rc: +d.slice(0, nl) || 0, out: d.slice(nl + 1, z < 0 ? undefined : z), err: z < 0 ? '' : d.slice(z + 1) };
  }
  P('systemctl', 'サービス（unit）を操作する・状態を見る', 'systemctl start | stop | restart | status | enable | disable | is-active | list-units | list-unit-files | daemon-reload | cat [unit…]', function* (c) {
    const av = c.argv.slice(1).filter((a) => a !== '--no-pager' && a !== '--no-legend' && a !== '-l' && a !== '--full' && a !== '-q' && a !== '--quiet');
    const quiet = c.argv.indexOf('-q') >= 0 || c.argv.indexOf('--quiet') >= 0;
    const verb = av.find((a) => a[0] !== '-') || 'list-units';
    const rest = av.filter((a) => a !== verb);
    if (verb === '--version' || av[0] === '--version') { c.out('systemd 255 (zukai init 1.0)\n'); return 0; }
    const r = yield* ask(c, [verb].concat(rest).join(' '));
    if (!quiet || verb === 'status') c.out(r.out);
    c.err(r.err);
    return r.rc;
  }, L);
  const PRIO = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
  P('journalctl', 'ジャーナル（サービスとカーネルのログ）を読む', 'journalctl [-u unit] [-n 行数] [-k] [-b] [-r] [-f] [-p 優先度] [-o cat] [--no-pager] [--list-boots]', function* (c) {
    const g = c.getopt('u:n:kbrfp:o:xeqaLH', { '--unit': 'u', '--lines': 'n', '--dmesg': 'k', '--boot': 'b', '--reverse': 'r', '--follow': 'f', '--priority': 'p', '--output': 'o', '--no-pager': 'a', '--quiet': 'q', '--list-boots': 'L', '--no-hostname': 'H' });
    if (!g) return 1;
    const o = g.o, listBoots = !!o.L;
    const host = (yield sys.uname()).nodename;
    const d = yield* c.slurp(JOURNAL);
    const kmsg = function* () { const fd = yield sys.open('/dev/kmsg', O.RDONLY); const out = []; if (fd < 0) return out; for (;;) { const r = yield sys.read(fd, 4096); if (typeof r !== 'string' || r === '') break; const m = /^(\d+),(\d+),(\d+),[^;]*;(.*)\n$/.exec(r); if (m) out.push({ prio: +m[1], us: +m[3], msg: m[4] }); } yield sys.close(fd); return out; };
    let es = [];
    if (typeof d !== 'string') {
      if (!o.q) c.err("Hint: You are currently not seeing messages from other users and the system.\n      Users in groups 'adm', 'systemd-journal' can see all messages.\n      Pass -q to turn off this notice.\n");
      if (!o.k) { c.out('-- No entries --\n'); return 0; }
    } else es = parseJournal(d);
    const curBoot = es.length ? es[es.length - 1].boot : 0;
    if (listBoots) {
      const boots = new Map();
      for (const e of es) { if (!boots.has(e.boot)) boots.set(e.boot, [e.t, e.t]); boots.get(e.boot)[1] = e.t; }
      const ids = Array.from(boots.keys());
      c.out('IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY\n');
      for (const b of ids) { let h = (b + 1) * 2654435761 >>> 0; const id = Array.from({ length: 4 }, () => { h = (Math.imul(h, 1103515245) + 12345) >>> 0; return h.toString(16).padStart(8, '0'); }).join(''); c.out(String(b - curBoot).padStart(3) + ' ' + id + ' ' + U.strftime('%a %Y-%m-%d %H:%M:%S %Z', boots.get(b)[0]) + ' ' + U.strftime('%a %Y-%m-%d %H:%M:%S %Z', boots.get(b)[1]) + '\n'); }
      return 0;
    }
    // カーネルのログ（いまの起動の分）を混ぜる
    const st = yield* c.slurp('/proc/stat'), bm = /^btime (\d+)/m.exec(typeof st === 'string' ? st : ''), up = yield* c.slurp('/proc/uptime');
    const bootT = (yield sys.time()) - Math.round(parseFloat(typeof up === 'string' ? up : '0') * 1000);
    void bm;
    if (o.k || o.u === undefined) for (const e of yield* kmsg()) es.push({ t: bootT + Math.floor(e.us / 1000) - BOOT_MS, prio: e.prio, unit: 'kernel', ident: 'kernel', pid: 0, msg: e.msg, boot: curBoot, k: true });
    es.sort((a, b) => a.boot - b.boot || a.t - b.t || (a.k ? -1 : 0) - (b.k ? -1 : 0));
    if (o.k) es = es.filter((e) => e.k);
    if (o.b || o.k) es = es.filter((e) => e.boot === curBoot);
    if (o.u !== undefined) { const u = svc(o.u); es = es.filter((e) => e.unit === u); }
    if (o.p !== undefined) { const lv = /^\d$/.test(o.p) ? +o.p : PRIO.indexOf(o.p); if (lv < 0) { c.err('Unknown log level ' + o.p + '\n'); return 1; } es = es.filter((e) => e.prio <= lv); }
    if (o.n !== undefined) { const n = parseInt(o.n, 10); if (isNaN(n)) { c.err("Failed to parse lines '" + o.n + "'\n"); return 1; } es = n === 0 ? [] : es.slice(-n); } else if (o.e) es = es.slice(-1000); else if (o.f) es = es.slice(-10);
    if (o.r) es.reverse();
    const fmt = (e) => (o.o === 'cat' ? e.msg : U.strftime('%b %d %H:%M:%S', e.t) + ' ' + host + ' ' + (e.k ? 'kernel: ' : e.ident + '[' + e.pid + ']: ') + e.msg) + '\n';
    if (!es.length && !o.f) { c.out('-- No entries --\n'); return 0; }
    let last = -1;
    for (const e of es) { if (last >= 0 && e.boot !== last && o.o !== 'cat') { let h = (e.boot + 1) * 2654435761 >>> 0; const id = Array.from({ length: 4 }, () => { h = (Math.imul(h, 1103515245) + 12345) >>> 0; return h.toString(16).padStart(8, '0'); }).join(''); yield* c.put('-- Boot ' + id + ' --\n'); } last = e.boot; yield* c.put(fmt(e)); }
    if (o.f && typeof d === 'string') {
      // 追いかける：新しい行が足されるたびに表示する（止めるまで続く）
      yield* c.flush();
      let pos = d.length;
      for (;;) {
        yield sys.nanosleep(250);
        const fd = yield sys.open(JOURNAL, O.RDONLY); if (fd < 0) break;
        yield sys.lseek(fd, pos, 0);
        const more = yield* c.readAll(fd); yield sys.close(fd);
        if (typeof more === 'string' && more) { pos += more.length; for (const e of parseJournal(more)) if (o.u === undefined || e.unit === svc(o.u)) c.out(fmt(e)); yield* c.flush(); }
      }
    }
    return 0;
  }, L);
  P('dmesg', 'カーネルのログ（起動時のメッセージなど）を表示する', 'dmesg [-T] [-l レベル] [-c]', function* (c) {
    const g = c.getopt('THl:cCwkxt', { '--ctime': 'T', '--level': 'l', '--clear': 'C', '--notime': 't' }); if (!g) return 1;
    const fd = yield sys.open('/dev/kmsg', O.RDONLY);
    if (fd < 0) { c.err('dmesg: read kernel buffer failed: ' + strerror(fd) + '\n'); return 1; }
    const lv = g.o.l !== undefined ? g.o.l.split(',').map((x) => PRIO.indexOf(x)) : null;
    if (lv && lv.some((x) => x < 0)) { c.err('dmesg: unknown level \'' + g.o.l + "'\n"); return 1; }
    const up = yield* c.slurp('/proc/uptime'), bootT = (yield sys.time()) - Math.round(parseFloat(typeof up === 'string' ? up : '0') * 1000) - BOOT_MS;
    if (!g.o.C) for (;;) {
      const r = yield sys.read(fd, 4096);
      if (typeof r !== 'string' || r === '') break;
      const m = /^(\d+),(\d+),(\d+),[^;]*;(.*)\n$/.exec(r); if (!m) continue;
      if (lv && lv.indexOf(+m[1]) < 0) continue;
      const ms = Math.floor(+m[3] / 1000);
      yield* c.put((g.o.t ? '' : g.o.T ? '[' + U.strftime('%a %b %e %H:%M:%S %Y', bootT + ms) + '] ' : stamp(ms) + ' ') + m[4] + '\n');
    }
    if (g.o.c || g.o.C) { const r = yield sys.ioctl(fd, 'clear'); if (r < 0) { c.err('dmesg: klogctl failed: Operation not permitted\n'); return 1; } }
    yield sys.close(fd);
    return 0;
  }, L);
  function* power(c, mode, force) {
    if (force >= 1) {
      if ((yield sys.geteuid()) !== 0) { c.err('Failed to ' + (mode === 'restart' ? 'reboot' : mode) + ': Operation not permitted\n'); return 1; }
      if (force === 1) yield sys.sync();
      const r = yield sys.reboot(mode, force >= 2);
      if (r < 0) { c.err('Failed to ' + (mode === 'restart' ? 'reboot' : mode) + ': ' + strerror(r) + '\n'); return 1; }
      return 0;
    }
    const r = yield* ask(c, mode === 'restart' ? 'reboot' : mode);
    c.err(r.err);
    return r.rc;
  }
  const powerCmd = (mode) => function* (c) { const g = c.getopt('fpnwdh', { '--force': 'f', '--poweroff': 'p', '--reboot': 'R', '--halt': 'h' }); if (!g) return 1; return yield* power(c, g.o.p ? 'poweroff' : mode, g.o.f | 0); };
  P('reboot', '再起動する（root だけ）。-f はサービスを止めずにすぐ、-ff は sync もせずに再起動する（電源断と同じ）', 'reboot [-f] [-ff]', powerCmd('restart'), Object.assign({ sbin: true }, L));
  P('poweroff', '電源を切る（root だけ）', 'poweroff [-f]', powerCmd('poweroff'), Object.assign({ sbin: true }, L));
  P('halt', 'システムを止める（root だけ）', 'halt [-f]', powerCmd('halt'), Object.assign({ sbin: true }, L));
  P('shutdown', 'システムを止める・再起動する（root だけ）', 'shutdown [-r | -h | -P] [now | +分]   例：shutdown -r now', function* (c) {
    const g = c.getopt('rhPHck', { '--reboot': 'r', '--halt': 'H', '--poweroff': 'P' }); if (!g) return 1;
    const when = g.args[0] || '+1', mode = g.o.r ? 'restart' : g.o.H ? 'halt' : 'poweroff';
    if (g.o.c) return 0;
    let mins = 0;
    if (when !== 'now') { const m = /^\+?(\d+)$/.exec(when); if (!m) { c.err('Failed to parse time specification: ' + when + '\n'); return 1; } mins = +m[1]; }
    if ((yield sys.geteuid()) !== 0) { c.err('Failed to set wall message, ignoring: Interactive authentication required.\nFailed to call ScheduleShutdown in logind, proceeding with immediate shutdown: Interactive authentication required.\nCall to ' + (mode === 'restart' ? 'Reboot' : mode === 'halt' ? 'Halt' : 'PowerOff') + ' failed: Interactive authentication required.\n'); return 1; }
    if (mins > 0) { c.err((mode === 'restart' ? 'Reboot' : 'Shutdown') + ' scheduled for ' + U.strftime('%a %Y-%m-%d %H:%M:%S %Z', (yield sys.time()) + mins * 60000) + ", use 'shutdown -c' to cancel.\n"); yield* c.flush(); yield sys.nanosleep(mins * 60000); }
    return yield* power(c, mode, 0);
  }, Object.assign({ sbin: true }, L));
  P('runlevel', '前といまのランレベルを表示する（systemd では multi-user.target = 3）', 'runlevel', function* (c) { c.out('N 3\n'); return 0; }, Object.assign({ sbin: true }, L));
  P('ticker', '一定の間隔で 1 行ずつ書き続ける（サービスの練習用）', 'ticker [秒数] [回数]', function* (c) {
    const iv = c.argv[1] !== undefined ? parseFloat(c.argv[1]) : 10, max = c.argv[2] !== undefined ? +c.argv[2] : Infinity;
    if (isNaN(iv) || iv <= 0) return c.fail("invalid interval '" + c.argv[1] + "'");
    for (let i = 1; i <= max; i++) { c.out('tick ' + i + '\n'); yield* c.flush(); yield sys.nanosleep(iv * 1000); }
    return 0;
  }, L);
  LNX.SYSJA.reboot = '再起動・停止（sync はしない）';
})(typeof window !== 'undefined' ? window : globalThis);
