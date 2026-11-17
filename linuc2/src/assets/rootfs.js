// 図解 Linux の最初のファイル一式と procfs（/proc の中身）。kernel.js・shell.js・bin.js の後に読み込む。API は kernel.js の先頭コメントを見る。
// LNX.rootfs(k) を登録する（起動のたびにカーネルが呼ぶ）。
(function (root) {
  'use strict';
  const LNX = root.LNX, U = LNX.util, enc = U.enc, SIGNAME = LNX.SIGNAME;
  const DAY = 86400000;

  // ── 練習用のファイル ──
  const HOME = {
    'memo.txt': '買い物のメモ\nりんご 3 個\n牛乳 1 本\nパン\n',
    'fruits.txt': 'apple\nbanana\ncherry\napple\norange\nbanana\napple\ngrape\nmelon\n',
    'poem.txt': 'The quick brown fox\njumps over the lazy dog.\nA journey of a thousand miles\nbegins with a single step.\nThe fox sleeps at night.\n',
    'scores.csv': 'name,subject,score\nsato,math,82\nsuzuki,math,67\ntanaka,math,91\nsato,english,74\nsuzuki,english,88\ntanaka,english,59\n',
    'numbers.txt': '10\n5\n23\n8\n100\n42\n7\n',
    'hello.sh': '#!/bin/sh\n# はじめてのシェルスクリプト\necho "Hello, $(whoami)!"\n',
    'notes/todo.txt': '[ ] シェルの基本を読む\n[ ] パイプを試す\n[x] ls を使ってみる\n',
    'notes/ideas.txt': 'プロセスの木を図にする\nパイプでログを集計する\n',
    '.profile': '# ~/.profile：ログインしたシェルが最初に読むファイル\n',
  };
  const ACCESS_LOG = [
    '192.168.1.10 - - [01/Apr/2026:08:55:01 +0900] "GET /index.html HTTP/1.1" 200 5120',
    '192.168.1.11 - - [01/Apr/2026:08:55:03 +0900] "GET /about.html HTTP/1.1" 200 2048',
    '192.168.1.10 - - [01/Apr/2026:08:55:09 +0900] "GET /style.css HTTP/1.1" 200 1024',
    '192.168.1.12 - - [01/Apr/2026:08:56:12 +0900] "GET /index.html HTTP/1.1" 200 5120',
    '192.168.1.13 - - [01/Apr/2026:08:56:40 +0900] "GET /missing.html HTTP/1.1" 404 512',
    '192.168.1.10 - - [01/Apr/2026:08:57:02 +0900] "POST /login HTTP/1.1" 302 0',
    '192.168.1.11 - - [01/Apr/2026:08:57:30 +0900] "GET /index.html HTTP/1.1" 200 5120',
    '192.168.1.14 - - [01/Apr/2026:08:58:11 +0900] "GET /admin HTTP/1.1" 403 256',
    '192.168.1.10 - - [01/Apr/2026:08:58:45 +0900] "GET /logo.png HTTP/1.1" 200 20480',
    '192.168.1.12 - - [01/Apr/2026:08:59:03 +0900] "GET /about.html HTTP/1.1" 200 2048',
    '192.168.1.13 - - [01/Apr/2026:08:59:20 +0900] "GET /missing.html HTTP/1.1" 404 512',
    '192.168.1.10 - - [01/Apr/2026:08:59:58 +0900] "GET /index.html HTTP/1.1" 200 5120',
  ].join('\n') + '\n';
  const SYSLOG = [
    'Apr  1 08:59:50 zukai kernel: Linux version 6.8.0-zukai (図解 Linux の小さなカーネル)',
    'Apr  1 08:59:50 zukai kernel: Command line: BOOT_IMAGE=/boot/vmlinuz-6.8.0-zukai root=/dev/sda1 ro quiet',
    'Apr  1 08:59:51 zukai kernel: Memory: 59392K/65536K available',
    'Apr  1 08:59:52 zukai kernel: EXT4-fs (sda1): mounted filesystem with ordered data mode',
    'Apr  1 08:59:53 zukai kernel: Run /sbin/init as init process',
    'Apr  1 08:59:54 zukai init: mounted /proc, /dev, /tmp',
    'Apr  1 08:59:55 zukai init: hostname set to zukai',
    'Apr  1 08:59:58 zukai login: session opened for user you',
  ].join('\n') + '\n';
  const WORDS = 'apple\nbanana\nbook\ncat\ncomputer\ndog\nfile\nfox\nkernel\nlinux\npipe\nprocess\nshell\nsignal\nsystem\nterminal\nunix\nuser\nwindow\nzebra\n';

  function elf(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    const size = 14000 + (h % 52000);
    const head = '\x7fELF\x02\x01\x01\0\0\0\0\0\0\0\0\0\x03\0\x3e\0\x01\0\0\0' + '\0'.repeat(40) + '/lib64/ld-linux-x86-64.so.2\0' + 'zukai:' + name + '\n\0GNU\0libc.so.6\0';
    return head + ELFPAD.slice(0, size - head.length);
  }
  const ELFPAD = '\0'.repeat(70000);

  function rootfs(k) {
    const fresh = !k.reused;
    const T0 = k.o.epoch0 || k.epoch;
    const at = (days, h, m) => T0 - days * DAY + ((h - 9) * 60 + m) * 60000;
    const tOld = at(22, 14, 2);
    if (fresh) {
      for (const d of ['boot', 'dev', 'etc', 'home', 'media', 'mnt', 'opt', 'proc', 'run', 'srv', 'sys', 'tmp', 'usr/bin', 'usr/sbin', 'usr/lib', 'usr/local/bin', 'usr/share/dict', 'var/log', 'var/tmp', 'var/lib', 'etc/init']) k.mkdirp('/' + d);
      k.mkdirp('/root', 0o700);
      k.mkdirp('/var/tmp').mode = 0o1777;
      k.mkSymlink('usr/bin', '/bin', tOld); k.mkSymlink('usr/sbin', '/sbin', tOld); k.mkSymlink('usr/lib', '/lib', tOld);
    } else {
      // 再起動：ディスクに残った「開いている数」やパイプの中身を片づける
      const seen = new Set();
      const clean = (d) => { for (const i of d.ents.values()) { if (seen.has(i)) continue; seen.add(i); i.opens = 0; if (i.type === 'p') i.pipe = k.newPipe(); if (i.type === 's') i.sock = null; if (i.type === 'd') clean(i); } };
      clean(k.rootfs.root);
      for (const d of ['proc', 'dev', 'tmp', 'run', 'sys']) k.mkdirp('/' + d);
    }
    // マウント
    const R = k.rootfs.root.ents;
    k.doMount(k.ns0, k.procfs, R.get('proc'), '/proc', { opts: 'rw,nosuid,nodev,noexec,relatime', pinned: true });
    k.doMount(k.ns0, k.devfs, R.get('dev'), '/dev', { opts: 'rw,nosuid,relatime,size=4096k,nr_inodes=14848,mode=755', pinned: true });
    k.devfs.inodesTotal = 14848;
    const tmpfs = k.fstypes.tmpfs(k, 'tmpfs', 'size=8M');
    k.doMount(k.ns0, tmpfs, R.get('tmp'), '/tmp', { opts: 'rw,nosuid,nodev,relatime,size=8192k' });
    // /dev
    k.mkDev('/dev/null', 1, 3, 0o666); k.mkDev('/dev/zero', 1, 5, 0o666); k.mkDev('/dev/full', 1, 7, 0o666);
    k.mkDev('/dev/random', 1, 8, 0o666); k.mkDev('/dev/urandom', 1, 9, 0o666);
    k.mkDev('/dev/tty', 5, 0, 0o666, 0, 5); k.mkDev('/dev/console', 5, 1, 0o600, 0, 5);
    k.mkdirp('/dev/pts');
    k.mkSymlink('/proc/self/fd', '/dev/fd'); k.mkSymlink('/proc/self/fd/0', '/dev/stdin'); k.mkSymlink('/proc/self/fd/1', '/dev/stdout'); k.mkSymlink('/proc/self/fd/2', '/dev/stderr');
    for (const i of k.devfs.root.ents.values()) i.mtime = i.ctime = i.atime = k.epoch - 9000;
    k.devfs.root.mtime = k.devfs.root.ctime = k.devfs.root.atime = k.epoch - 9000;
    tmpfs.root.mtime = tmpfs.root.ctime = tmpfs.root.atime = k.epoch - 9000;
    if (!fresh) { procfs(k); return; }
    // /etc
    const etc = {
      passwd: 'root:x:0:0:root:/root:/bin/sh\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\nyou:x:1000:1000:You:/home/you:/bin/sh\nalice:x:1001:1001:Alice:/home/alice:/bin/sh\nbob:x:1002:1002:Bob:/home/bob:/bin/sh\n',
      group: 'root:x:0:\ndaemon:x:1:\ntty:x:5:\nsudo:x:27:you\nshadow:x:42:\nstaff:x:50:you,alice\nusers:x:100:you,alice,bob\nyou:x:1000:\nalice:x:1001:\nbob:x:1002:\nnogroup:x:65534:\n',
      hostname: k.o.hostname + '\n',
      'os-release': 'PRETTY_NAME="Zukai Linux 1.0"\nNAME="Zukai Linux"\nVERSION_ID="1.0"\nVERSION="1.0 (図解)"\nID=zukai\nHOME_URL="https://ogatomo83.github.io/practice-site/"\n',
      hosts: '127.0.0.1\tlocalhost\n127.0.1.1\t' + k.o.hostname + '\n192.168.1.5\t' + k.o.hostname + '.example.jp\n',
      fstab: '# <file system> <mount point> <type> <options> <dump> <pass>\n/dev/sda1\t/\text4\tdefaults\t0\t1\nproc\t/proc\tproc\tdefaults\t0\t0\ntmpfs\t/tmp\ttmpfs\tsize=8M\t0\t0\n',
      shells: '/bin/sh\n/usr/bin/sh\n',
      motd: '図解 Linux へようこそ。help と打つと、使えるコマンドの一覧が出ます。\n',
      issue: 'Zukai Linux 1.0 \\n \\l\n',
      services: '# Network services, Internet style\necho\t\t7/tcp\nssh\t\t22/tcp\nsmtp\t\t25/tcp\ndomain\t\t53/tcp\ndomain\t\t53/udp\nhttp\t\t80/tcp\t\twww\nhttps\t\t443/tcp\nmysql\t\t3306/tcp\npostgresql\t5432/tcp\nhttp-alt\t8080/tcp\twebcache\n',
      profile: '# /etc/profile\n',
    };
    for (const n in etc) k.writeFile('/etc/' + n, enc(etc[n]), 0o644, 0, 0, at(22, 14, 2 + n.length));
    // 練習用のパスワードは、ユーザー名と同じ（you は you、alice は alice）。root はロック（*）されていて、パスワードではなれない
    const U = LNX.util, sh = (n) => n + ':' + U.crypt(n, U.saltOf(n)) + ':20000:0:99999:7:::\n';
    k.writeFile('/etc/shadow', 'root:*:20000:0:99999:7:::\n' + sh('you') + sh('alice') + sh('bob'), 0o640, 0, 42, tOld);
    k.writeFile('/etc/sudoers', enc('Defaults\tenv_reset\nDefaults\tmail_badpass\nDefaults\tsecure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\nDefaults\tuse_pty\n\n# sudo グループの人は、どのコマンドも root として実行できる（NOPASSWD：パスワードをたずねない）\n%sudo\tALL=(ALL:ALL) NOPASSWD: ALL\n'), 0o440, 0, 0, tOld);
    // /usr/bin
    const tBin = at(40, 11, 30);
    // late の印のあるコマンド（後の段階で足したもの）は最後に置く（それまでのファイルの inode 番号を変えないため）
    const putBin = (name) => { const pr = LNX.bin[name]; k.writeFile((pr.sbin ? '/usr/sbin/' : '/usr/bin/') + name, elf(name), pr.suid ? 0o4755 : 0o755, 0, 0, tBin); };
    for (const name of Object.keys(LNX.bin).sort()) if (!LNX.bin[name].late) putBin(name);
    k.writeFile('/usr/sbin/nologin', '#!/bin/sh\necho "This account is currently not available."\nexit 1\n', 0o755, 0, 0, tBin);
    k.writeFile('/usr/lib/libc.so.6', '\x7fELF\x02\x01\x01\0' + ELFPAD.slice(0, 60000), 0o755, 0, 0, tBin);
    k.writeFile('/usr/share/dict/words', WORDS, 0o644, 0, 0, tBin);
    k.writeFile('/boot/vmlinuz-6.8.0-zukai', '\x1f\x8b\x08\0' + ELFPAD.slice(0, 40000), 0o600, 0, 0, tBin);
    // /var/log
    k.writeFile('/var/log/syslog', enc(SYSLOG), 0o640, 0, 4, T0 - 2000);
    k.writeFile('/var/log/auth.log', 'Apr  1 08:59:58 zukai login: pam_unix(login:session): session opened for user you(uid=1000) by (uid=0)\n', 0o640, 0, 4, T0 - 2000);
    k.writeFile('/var/log/access.log', ACCESS_LOG, 0o644, 0, 0, T0 - 2000);
    // ホーム
    const home = (user, uid, files, tbase) => {
      const h = k.mkdirp('/home/' + user);
      h.uid = uid; h.gid = uid;
      let n = 0;
      for (const f in files) {
        const p = '/home/' + user + '/' + f;
        if (f.indexOf('/') >= 0) { const d = k.mkdirp(U.dirname(p)); d.uid = uid; d.gid = uid; d.mtime = d.ctime = d.atime = tbase; }
        const v = files[f], ino = k.writeFile(p, enc(typeof v === 'string' ? v : v[0]), typeof v === 'string' ? 0o644 : v[1], uid, uid, tbase + (n++) * 754000);
        ino.uid = uid; ino.gid = uid;
      }
      h.mtime = h.ctime = h.atime = tbase + n * 754000;
      for (const i of h.ents.values()) if (i.type === 'd') i.mtime = i.ctime = i.atime = Math.max(...Array.from(i.ents.values()).map((x) => x.mtime));
    };
    home('you', 1000, HOME, at(4, 10, 15));
    home('alice', 1001, { 'diary.txt': ['今日は Linux の勉強をした。\nパイプが面白い。\n', 0o600], 'public.txt': 'alice の公開メモ：だれでも読めます。\n', 'shared.txt': ['staff グループで共有するメモ。\n', 0o664] }, at(9, 16, 40));
    k.namei(k.kcred, '/home/alice/shared.txt').gid = 50;
    home('bob', 1002, { 'readme.txt': 'bob のホームディレクトリ。\n' }, at(15, 9, 5));
    k.namei(k.kcred, '/home/bob').mode = 0o750;
    k.writeFile('/root/.profile', '# ~/.profile\n', 0o644, 0, 0, tOld);
    // ディレクトリの時刻をそろえる
    const fix = (d, t) => { d.mtime = d.ctime = d.atime = Math.max(t, ...Array.from(d.ents.values()).filter((i) => i.type !== 'd').map((i) => i.mtime)); for (const i of d.ents.values()) if (i.type === 'd' && !/^(you|alice|bob|notes)$/.test(i.name)) fix(i, t); };
    fix(k.rootfs.root, tOld);
    for (const name of Object.keys(LNX.bin).sort()) if (LNX.bin[name].late) putBin(name);
    k.namei(k.kcred, '/usr/bin').mtime = tOld; k.namei(k.kcred, '/usr/sbin').mtime = tOld;
    procfs(k);
  }

  // ════════════════════════ procfs ════════════════════════
  const STATE_NAME = { R: 'R (running)', S: 'S (sleeping)', D: 'D (disk sleep)', T: 'T (stopped)', Z: 'Z (zombie)' };
  function procfs(k) {
    const fs = k.procfs;
    // PID 名前空間（ns.js が差し替える）。view = その /proc が見せる名前空間。何もなければ全部そのまま見える
    if (!k.vpid) { k.vpid = (p) => p.pid; k.procsIn = () => Array.from(k.procs.values()); k.procByVpid = (view, n) => k.procs.get(n) || null; k.vnum = (view, pid) => pid; }
    const par = (p, view) => { const q = k.procs.get(p.ppid); return q ? k.vpid(q, view) : 0; };
    const hex16 = (n) => (n >>> 0).toString(16).padStart(16, '0');
    const sigSets = (p) => { let ign = 0, cgt = 0; for (const s in p.sig.act) { if (p.sig.act[s] === 'ign') ign |= 1 << (s - 1); else cgt |= 1 << (s - 1); } return { ign, cgt, pnd: p.sig.pending >>> 1, blk: p.sig.mask >>> 1 }; };
    const ttyNr = (p) => (p.tty ? (136 << 8) | p.tty.n : 0);
    // /proc/PID の中のファイル。ほかの部品は k.procfs.pidFiles.名前 = (p) => 節 で足せる
    fs.pidFiles = {
      status: (p, view) => ({ read: () => {
        const s = sigSets(p);
        return 'Name:\t' + p.comm + '\nUmask:\t' + U.oct(p.umask, 4) + '\nState:\t' + STATE_NAME[p.state] + '\nTgid:\t' + k.vpid(p, view) + '\nPid:\t' + k.vpid(p, view) + '\nPPid:\t' + par(p, view) +
          '\nUid:\t' + [p.uid, p.euid, p.euid, p.euid].join('\t') + '\nGid:\t' + [p.gid, p.egid, p.egid, p.egid].join('\t') + '\nFDSize:\t64\nGroups:\t' + p.groups.join(' ') +
          '\nThreads:\t1\nSigPnd:\t' + hex16(s.pnd) + '\nSigBlk:\t' + hex16(s.blk) + '\nSigIgn:\t' + hex16(s.ign) + '\nSigCgt:\t' + hex16(s.cgt) +
          '\nvoluntary_ctxt_switches:\t' + p.nvcsw + '\nnonvoluntary_ctxt_switches:\t' + p.nivcsw + '\n';
      } }),
      stat: (p, view) => ({ read: () => [k.vpid(p, view), '(' + p.comm + ')', p.state, par(p, view), k.vnum(view, p.pgid), k.vnum(view, p.sid), ttyNr(p), p.tty ? k.vnum(view, p.tty.fg) : -1, 4194304, p.minflt, p.cminflt, p.majflt, p.cmajflt,
        Math.floor(p.utime / 10), Math.floor(p.stime / 10), Math.floor(p.cutime / 10), Math.floor(p.cstime / 10), 20 + p.nice, p.nice, 1, 0, Math.floor(p.start / 10), 0, 0].join(' ') + '\n' }),
      // シミュレータ独自：tick 単位の時間など（ps と top が使う）
      schedstat: (p) => ({ read: () => p.utime + ' ' + p.stime + ' ' + p.start + ' ' + (p.sc ? p.sc.n : '-') + '\n' }),
      cmdline: (p) => ({ read: () => (p.state === 'Z' ? '' : p.argv.join('\0') + (p.argv.length ? '\0' : '')) }),
      comm: (p) => ({ read: () => p.comm + '\n' }),
      environ: (p) => ({ mode: 0o400, read: () => Object.keys(p.env).map((n) => n + '=' + p.env[n]).join('\0') + '\0' }),
      maps: () => ({ read: () => '' }),
      mounts: (p) => ({ read: () => mountsText(p) }),
      cwd: (p) => ({ type: 'l', target: () => (p.cwd ? k.pathOf(p, p.cwd) || '/' : '/') }),
      root: (p) => ({ type: 'l', target: (k2, q) => (p.root && q && q.root ? k.pathOf(q, p.root) || '/' : '/') }),
      exe: (p) => ({ type: 'l', target: () => p.exe || '' }),
      fd: (p) => ({ type: 'd', mode: 0o500,
        list: () => p.fds.map((e, i) => (e ? String(i) : null)).filter(Boolean),
        get: (k2, q, name) => { const e = /^\d+$/.test(name) && p.fds[+name]; if (!e) return null; const o = e.ofd; return { type: 'l', uid: p.euid, gid: p.egid, mode: [0o500, 0o300, 0o700][o.flags & 3] || 0o700, magic: () => (p.fds[+name] ? p.fds[+name].ofd : null), target: () => o.path + (o.inode.nlink === 0 && o.inode.type === 'f' && !o.inode.fs.synth ? ' (deleted)' : '') }; } }),
      fdinfo: (p) => ({ type: 'd', mode: 0o500,
        list: () => p.fds.map((e, i) => (e ? String(i) : null)).filter(Boolean),
        get: (k2, q, name) => { const e = /^\d+$/.test(name) && p.fds[+name]; if (!e) return null; const o = e.ofd; return { type: 'f', uid: p.euid, gid: p.egid, mode: 0o400, read: () => 'pos:\t' + o.pos + '\nflags:\t0' + U.oct(o.flags | (e.cloexec ? LNX.O.CLOEXEC : 0)) + '\nmnt_id:\t' + o.inode.fs.dev + '\nino:\t' + o.inode.ino + '\nofd:\t' + o.id + '\nrefs:\t' + o.refs + '\n' }; } }),
    };
    const pidNode = (p, view) => ({ type: 'd', uid: p.euid, gid: p.egid, time: k.epoch + p.start,
      list: () => Object.keys(fs.pidFiles),
      get: (k2, q, name) => { const mk = fs.pidFiles[name]; if (!mk) return null; const nd = mk(p, view); if (!nd.type) nd.type = 'f'; if (nd.uid === undefined) nd.uid = p.euid; if (nd.gid === undefined) nd.gid = p.egid; return nd; } });
    const viewOf = (dir) => (dir && dir.fs.pidns) || null;
    fs.tree.list = (k2, q, dir) => k.procsIn(viewOf(dir)).map((p) => String(k.vpid(p, viewOf(dir))));
    fs.tree.get = (k2, q, name, dir) => { if (!/^\d+$/.test(name)) return null; const p = k.procByVpid(viewOf(dir), +name); return p ? pidNode(p, viewOf(dir)) : null; };
    // 別の PID 名前空間用の /proc を作る（mount -t proc。中身は同じ木で、プロセスの見え方だけが違う）
    k.mkProcfs = (pidns) => { const f2 = k.mkSynth('proc', 'proc'); f2.tree = fs.tree; f2.root.node = fs.tree; f2.pidns = pidns; f2.reg = fs.reg; f2.pidFiles = fs.pidFiles; return f2; };
    const mountsText = (p) => p.ns.mnt.list.map((m) => m.source + ' ' + m.target + ' ' + m.type + ' ' + m.opts + ' 0 0').join('\n') + '\n';
    fs.reg('self', { type: 'l', target: (k2, p, ino) => (p.pid ? String(k.vpid(p, (ino && ino.fs.pidns) || null) || '') : '1') });
    fs.reg('mounts', { type: 'l', target: () => 'self/mounts' });
    fs.reg('uptime', { read: () => (k.clock / 1000).toFixed(2) + ' ' + ((k.idle || 0) / 1000).toFixed(2) + '\n' });
    fs.reg('loadavg', { read: () => { let run = 0; for (const p of k.procs.values()) if (p.state === 'R') run++; if (k.cur && k.cur.state === 'R') run = Math.max(1, run); return k.load.map((l) => l.toFixed(2)).join(' ') + ' ' + run + '/' + k.procs.size + ' ' + (k.nextPid - 1) + '\n'; } });
    fs.reg('meminfo', { read: () => 'MemTotal:           1024 kB\nMemFree:             512 kB\nMemAvailable:        512 kB\nBuffers:               0 kB\nCached:                0 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n' });
    fs.reg('version', { read: () => 'Linux version ' + k.uname.release + ' (zukai@build) (gcc 13.2.0) ' + k.uname.version + '\n' });
    fs.reg('cmdline', { read: () => 'BOOT_IMAGE=/boot/vmlinuz-6.8.0-zukai root=/dev/sda1 ro quiet\n' });
    fs.reg('cpuinfo', { read: () => 'processor\t: 0\nvendor_id\t: ZukaiVirtual\nmodel name\t: Zukai Virtual CPU @ 1000Hz\ncpu MHz\t\t: 1.000\ncache size\t: 0 KB\ncpu cores\t: 1\nflags\t\t: fpu\nbogomips\t: 2.00\n\n' });
    fs.reg('filesystems', { read: () => 'nodev\tproc\nnodev\ttmpfs\nnodev\tdevtmpfs\nnodev\tramfs\nnodev\tpipefs\n\text4\n' });
    fs.reg('stat', { read: () => { let u = 0, s = 0, run = 0; for (const p of k.procs.values()) { u += p.utime; s += p.stime; if (p.state === 'R') run++; } return 'cpu  ' + Math.floor(u / 10) + ' 0 ' + Math.floor(s / 10) + ' ' + Math.floor((k.idle || 0) / 10) + ' 0 0 0 0 0 0\nctxt ' + k.stat.ctxsw + '\nbtime ' + Math.floor(k.epoch / 1000) + '\nprocesses ' + (k.stat.forks + 2) + '\nprocs_running ' + run + '\nprocs_blocked 0\n'; } });
    fs.reg('sys/kernel/hostname', { read: (k2, p) => (p.ns || k.ns0).uts.hostname + '\n', write: (k2, p, d) => { if (p.euid !== 0) return -LNX.ERRNO.EACCES; (p.ns || k.ns0).uts.hostname = d.replace(/\n+$/, ''); } });
    fs.reg('sys/kernel/ostype', { read: () => 'Linux\n' });
    fs.reg('sys/kernel/osrelease', { read: () => k.uname.release + '\n' });
    fs.reg('sys/kernel/pid_max', { read: () => k.pidMax + '\n' });
    fs.reg('sys/vm', { type: 'd', kids: {} });
  }
  void SIGNAME;
  LNX.rootfs = rootfs;
})(typeof window !== 'undefined' ? window : globalThis);
