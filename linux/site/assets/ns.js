// 図解 Linux の名前空間・cgroups・chroot（19 章）。net.js の後に読み込む。API は kernel.js の先頭コメントを見る。
//
// ■ chroot(パス)：そのプロセスの「/」を変える（p.root）。root だけ。.. で外には出られない。開いたままの fd や cwd は外を指したまま（chroot コマンドは chdir("/") もする）。
// ■ 名前空間：プロセスは p.ns = { uts, mnt, pid, net, ipc, cgroup, user } を持つ。fork では親と同じものを指す。
//   unshare(flags)（root だけ。flags は LNX.CLONE の NEWNS | NEWUTS | NEWPID | NEWNET | NEWIPC | NEWCGROUP の和）で、自分だけ新しい名前空間に移る。
//     UTS   ホスト名が別になる（sethostname しても外は変わらない）
//     マウント マウントの表を複製して持つ。中で mount / umount しても外には見えない
//     PID   unshare した本人は移らず、その後に fork した子から新しい名前空間に入る（最初の子が PID 1）。中からは外のプロセスが見えず、kill もできない。
//           外からは、ふつうの PID で全部見える。中の PID 1 が終わると、中の残りは全部 SIGKILL され、その名前空間ではもう fork できない（ENOMEM）。
//           親を失ったプロセスは、中の PID 1 が引き取る。/proc は「マウントしたときの PID 名前空間」を見せるので、中で mount -t proc proc /proc し直すまで ps は外を映す。
//     ネット  lo だけの別のネットワーク（ポートも別）
//   setns(fd, 種類)：/proc/PID/ns/* を開いた fd の名前空間に入る（nsenter が使う）。pivot_root は未対応（ENOSYS）。
//   /proc/PID/ns/{cgroup,ipc,mnt,net,pid,pid_for_children,user,uts} は 'mnt:[4026531841]' の形のリンク。同じ番号なら同じ名前空間。
// ■ cgroups v2：/sys/fs/cgroup（種類 cgroup2）。mkdir でグループを作り、rmdir で消す（プロセスや子グループがいると EBUSY）。ほかのファイルは作れない（EPERM）。
//     cgroup.procs          読む：そのグループのプロセスの PID。書く：その PID（0 = 自分）をこのグループに移す。fork した子は親と同じグループに入る
//     cgroup.controllers / cgroup.subtree_control   "memory pids"（いつも両方が有効。本物のように子に委譲する手続きは要らない）
//     cgroup.events         populated 0 | 1         cgroup.kill   1 を書くと中のプロセス全部に SIGKILL
//     pids.max / pids.current / pids.peak / pids.events     数の上限（"max" = なし）。超える fork は EAGAIN（sh: fork: retry: Resource temporarily unavailable）
//     memory.max / memory.current / memory.peak / memory.events   匿名ページの上限（バイト。4096 の倍数に切り捨て。K / M / G も書ける）。
//                           超えると、そのグループの中で RSS がいちばん大きいプロセスを OOM killer が殺す（dmesg に Memory cgroup out of memory）
//     ルートのグループには pids.* と memory.* がない。CPU（cpu.weight / cpu.max）は未対応。ページキャッシュは課金しない。
//   /proc/PID/cgroup は '0::/パス'。
// ■ /sys（sysfs）：/sys/fs/cgroup、/sys/class/net/{lo,eth0}/{address,mtu,operstate}、/sys/block/sda/size、/sys/devices/system/cpu/online、/sys/kernel/mm/transparent_hugepage/enabled。
//   /run は tmpfs（再起動で消える）。
// ■ コマンド：chroot、unshare（-m -u -i -n -p -f --mount-proc[=dir] -R dir）、nsenter（-t PID -m -u -n -p -i -a）、lsns、busybox。
//   /srv/rootfs に、コンテナ用の最小のルート（bin/busybox とそのリンク、etc、proc、dev、tmp、root）がある。
// ■ 観察：sys.cgroups() → [{ path, procs: [pid…], pidsMax, pidsCurrent, memMax, memCurrent（バイト）, oomKill, children: [...] }]（木）、
//   sys.namespaces() → [{ type, id, pids: [...] }]。sys.ps() の各行に ns（{ pid: 番号, mnt, uts, net }）、vpid（その名前空間の中での PID）、cgroup、root が増える。
// ■ events（いつも出る）：{ type: 'ns', op: 'unshare' | 'setns' | 'chroot', pid, kinds: ['pid', 'mnt', …], path }、
//   { type: 'cgroup', op: 'mkdir' | 'rmdir' | 'move' | 'set' | 'deny', path, pid, key, value }（deny = pids.max で fork を断った）
(function (root) {
  'use strict';
  const LNX = root.LNX, E = LNX.ERRNO, sys = LNX.sys, U = LNX.util, O = LNX.O, SIG = LNX.SIG, strerror = LNX.strerror, SC = LNX.kernel.SC, TIO = LNX.TIO;
  const { P, isErr, lines } = LNX.binutil;
  const enc = U.enc, dec = U.dec;
  const CLONE = { NEWNS: 0x20000, NEWCGROUP: 0x2000000, NEWUTS: 0x4000000, NEWIPC: 0x8000000, NEWUSER: 0x10000000, NEWPID: 0x20000000, NEWNET: 0x40000000 };
  const KINDS = [['mnt', CLONE.NEWNS], ['uts', CLONE.NEWUTS], ['ipc', CLONE.NEWIPC], ['net', CLONE.NEWNET], ['pid', CLONE.NEWPID], ['cgroup', CLONE.NEWCGROUP], ['user', CLONE.NEWUSER]];
  const BASEID = { time: 4026531834, cgroup: 4026531835, pid: 4026531836, user: 4026531837, uts: 4026531838, ipc: 4026531839, net: 4026531840, mnt: 4026531841 };
  const PGSZ = 4096;

  LNX.kernel.plugin('ns', (k) => {
    const st = { nextId: 4026532254, CLONE };
    const n0 = k.ns0;
    n0.uts.id = BASEID.uts; n0.mnt.id = BASEID.mnt; n0.pid.id = BASEID.pid; n0.pid.parent = null;
    if (n0.net) n0.net.nsid = BASEID.net;
    n0.ipc = { id: BASEID.ipc }; n0.cgroup = { id: BASEID.cgroup }; n0.user = { id: BASEID.user };
    const nsId = (p, kind) => { const ns = p.ns; if (kind === 'net') return ns.net ? ns.net.nsid : BASEID.net; if (kind === 'pid_for_children') return (ns.pidKids || ns.pid).id; if (kind === 'time_for_children') return BASEID.time; return ns[kind] ? ns[kind].id : BASEID[kind]; };

    // ── PID 名前空間 ──
    const inNs = (p, view) => { let x = p.ns.pid; while (x && x.level > view.level) x = x.parent; return x === view; };
    k.vpid = (p, view) => (!view || !view.level ? p.pid : inNs(p, view) ? p.vpids[view.level] : 0);
    k.procsIn = (view) => (!view || !view.level ? Array.from(k.procs.values()) : Array.from(view.map.values()));
    k.procByVpid = (view, n) => (!view || !view.level ? k.procs.get(n) || null : view.map.get(n) || null);
    k.vnum = (view, pid) => { if (!view || !view.level || pid <= 0) return pid; const q = k.procs.get(pid); return q ? k.vpid(q, view) : 0; };
    k.findPid = (p, n) => k.procByVpid(p.ns.pid, n);
    k.gpid = (p, n) => { if (!p.ns.pid.level || n <= 0) return n; const q = p.ns.pid.map.get(n); return q ? q.pid : -1; };
    const newPidns = (parent) => ({ id: st.nextId++, level: parent.level + 1, parent, map: new Map(), next: 1, init: null, dead: false });
    k.on('canFork', (p) => { const t = p.ns.pidKids || p.ns.pid; if (t.dead) return -E.ENOMEM; return 0; });
    k.on('fork', (parent, child) => {
      if (parent.ns.pidKids) { child.ns = Object.assign({}, parent.ns, { pid: parent.ns.pidKids }); delete child.ns.pidKids; }
      let ns = child.ns.pid;
      if (ns.level) { child.vpids = []; for (; ns.level; ns = ns.parent) { const v = ns.next++; ns.map.set(v, child); child.vpids[ns.level] = v; if (!ns.init) ns.init = child; } }
    });
    k.on('reap', (p) => { if (p.vpids) for (let ns = p.ns.pid; ns && ns.level; ns = ns.parent) ns.map.delete(p.vpids[ns.level]); });
    k.on('exit', (p) => {
      const ns = p.ns.pid;
      if (ns.level && ns.init === p) {
        ns.dead = true;   // 名前空間の PID 1 が終わった：中の残りを全部殺す
        for (const q of Array.from(ns.map.values())) if (q !== p && q.state !== 'Z') k.sendSig(q, SIG.KILL, null);
      }
    });
    k.reaper = (p) => { for (let ns = p.ns.pid; ns && ns.level; ns = ns.parent) if (ns.init && ns.init !== p && ns.init.state !== 'Z') return ns.init; return k.procs.get(1); };
    // PID を扱うシステムコール：名前空間の中にいるプロセスには、中の番号で見せる
    const wrap = (name, f) => k.wrapsys(name, (o, k2, p, a, req) => (p.ns.pid.level ? f(o, p, a, req) : o(k2, p, a, req)));
    const V = (p, g) => k.vnum(p.ns.pid, g);
    wrap('getpid', (o, p) => p.vpids[p.ns.pid.level]);
    wrap('getppid', (o, p) => { const q = k.procs.get(p.ppid); return q ? k.vpid(q, p.ns.pid) : 0; });
    wrap('clone', (o, p, a, req) => { const r = o(k, p, a, req); return typeof r === 'number' && r > 0 ? V(p, r) : r; });
    wrap('wait4', (o, p, a, req) => {
      let pid = a[0] === undefined ? -1 : a[0] | 0;
      if (pid > 0) { pid = k.gpid(p, pid); if (pid < 0) return -E.ECHILD; } else if (pid < -1) { pid = k.gpid(p, -pid); if (pid < 0) return -E.ECHILD; pid = -pid; }
      const r = o(k, p, [pid, a[1]], req);
      return r && typeof r === 'object' ? { pid: k.lastReaped && k.lastReaped.pid === r.pid ? k.vpid(k.lastReaped, p.ns.pid) : V(p, r.pid), status: r.status } : r;   // 回収した直後は表から消えているので、覚えておいた本人から番号を引く
    });
    wrap('kill', (o, p, a, req) => {
      const pid = a[0] | 0, view = p.ns.pid;
      if (pid > 0) {
        const q = view.map.get(pid); if (!q) return -E.ESRCH;
        // 名前空間の PID 1 は、中からのシグナルではハンドラを登録したものしか受け取らない（SIGKILL でも死なない）
        if (q === view.init && a[1] && !(q.sig.act[a[1] | 0] && typeof q.sig.act[a[1] | 0] === 'object')) return 0;
        return o(k, p, [q.pid, a[1]], req);
      }
      if (pid === 0) return o(k, p, a, req);
      if (pid === -1) { let ok = 0; for (const q of Array.from(view.map.values())) if (q !== p && q !== view.init && q.state !== 'Z' && o(k, p, [q.pid, a[1]], req) === 0) ok++; return ok ? 0 : -E.ESRCH; }
      const l = view.map.get(-pid);
      return l ? o(k, p, [-l.pid, a[1]], req) : -E.ESRCH;
    });
    wrap('setpgid', (o, p, a, req) => { const x = k.gpid(p, a[0] | 0), y = k.gpid(p, a[1] | 0); return x < 0 || y < 0 ? -E.ESRCH : o(k, p, [x, y], req); });
    wrap('getpgid', (o, p, a, req) => { const x = k.gpid(p, a[0] | 0); if (x < 0) return -E.ESRCH; const r = o(k, p, [x], req); return r > 0 ? V(p, r) : r; });
    wrap('getsid', (o, p, a, req) => { const x = k.gpid(p, a[0] | 0); if (x < 0) return -E.ESRCH; const r = o(k, p, [x], req); return r > 0 ? V(p, r) : r; });
    wrap('setsid', (o, p, a, req) => { const r = o(k, p, a, req); return r > 0 ? V(p, r) : r; });
    wrap('ioctl', (o, p, a, req) => {
      if (a[1] === TIO.TIOCSPGRP) { const g = k.gpid(p, a[2] | 0); return g < 0 ? -E.ESRCH : o(k, p, [a[0], a[1], g], req); }
      const r = o(k, p, a, req);
      return a[1] === TIO.TIOCGPGRP && r > 0 ? V(p, r) : r;
    });

    // ── unshare / setns / chroot ──
    const copyMnt = (m) => { const map = new Map(), list = m.list.map((x) => { const y = Object.assign({}, x); map.set(x, y); return y; }), covered = new Map(); for (const [ino, x] of m.covered) covered.set(ino, map.get(x)); return { id: st.nextId++, list, covered }; };
    k.defsys('unshare', (k2, p, a) => {
      const fl = a[0] | 0;
      if (p.euid !== 0) return -E.EPERM;
      if (fl & CLONE.NEWUSER) return -E.EINVAL;
      const ns = Object.assign({}, p.ns), kinds = [];
      if (fl & CLONE.NEWNS) { ns.mnt = copyMnt(p.ns.mnt); kinds.push('mnt'); }
      if (fl & CLONE.NEWUTS) { ns.uts = { hostname: p.ns.uts.hostname, domainname: p.ns.uts.domainname, id: st.nextId++ }; kinds.push('uts'); }
      if (fl & CLONE.NEWIPC) { ns.ipc = { id: st.nextId++ }; kinds.push('ipc'); }
      if (fl & CLONE.NEWNET) { if (!k.sub.net) return -E.EINVAL; ns.net = k.sub.net.mkNetns(); ns.net.nsid = st.nextId++; kinds.push('net'); }
      if (fl & CLONE.NEWPID) { ns.pidKids = newPidns(p.ns.pidKids || p.ns.pid); kinds.push('pid'); }
      if (fl & CLONE.NEWCGROUP) { ns.cgroup = { id: st.nextId++ }; kinds.push('cgroup'); }
      p.ns = ns;
      k.ev('ns', { op: 'unshare', pid: p.pid, kinds });
      return 0;
    }, (a) => KINDS.slice().sort((x, y) => x[1] - y[1]).filter((x) => (a[0] | 0) & x[1]).map((x) => 'CLONE_NEW' + (x[0] === 'mnt' ? 'NS' : x[0].toUpperCase())).join('|') || '0');
    k.defsys('setns', (k2, p, a) => {
      const e = p.fds[a[0]]; if (!e) return -E.EBADF;
      const ref = e.ofd.inode.node && e.ofd.inode.node.nsref;
      if (!ref) return -E.EINVAL;
      if (p.euid !== 0) return -E.EPERM;
      const want = a[1] | 0, kd = ref.kind, flag = (KINDS.find((x) => x[0] === kd) || [0, 0])[1];
      if (want && want !== flag) return -E.EINVAL;
      const ns = Object.assign({}, p.ns);
      if (kd === 'pid') { let x = ref.ns; while (x && x.level > p.ns.pid.level) x = x.parent; if (x !== p.ns.pid) return -E.EINVAL; if (ref.ns === p.ns.pid) delete ns.pidKids; else ns.pidKids = ref.ns; } else if (kd === 'mnt') { ns.mnt = ref.ns; p.root = ref.root; p.cwd = ref.root; } else ns[kd] = ref.ns;
      p.ns = ns;
      k.ev('ns', { op: 'setns', pid: p.pid, kinds: [kd] });
      return 0;
    }, (a) => a[0] + ', ' + ((KINDS.find((x) => x[1] === (a[1] | 0)) || [''])[0] ? 'CLONE_NEW' + (KINDS.find((x) => x[1] === (a[1] | 0))[0] === 'mnt' ? 'NS' : KINDS.find((x) => x[1] === (a[1] | 0))[0].toUpperCase()) : '0'));
    k.defsys('chroot', (k2, p, a) => {
      const i = k.namei(p, String(a[0]), true); if (typeof i === 'number') return i;
      if (i.type !== 'd') return -E.ENOTDIR;
      if (p.euid !== 0) return -E.EPERM;
      k.ev('ns', { op: 'chroot', pid: p.pid, kinds: [], path: dec(k.pathOf(p, i) || String(a[0])) });
      p.root = i;
      return 0;
    }, (a) => U.quote(String(a[0]), 4096));
    // /proc/PID/ns
    const nsfs = k.mkSynth('nsfs', 'nsfs');
    const nsObj = (p, kind) => (kind === 'pid_for_children' ? p.ns.pidKids || p.ns.pid : kind === 'net' ? p.ns.net : p.ns[kind]);
    const NSNAMES = ['cgroup', 'ipc', 'mnt', 'net', 'pid', 'pid_for_children', 'time', 'time_for_children', 'user', 'uts'];
    k.procfs.pidFiles.ns = (p) => ({ type: 'd', mode: 0o511, list: () => NSNAMES.slice(),
      get: (k2, q, name) => {
        if (NSNAMES.indexOf(name) < 0) return null;
        const kind = name === 'pid_for_children' ? 'pid' : name === 'time_for_children' ? 'time' : name, label = () => kind + ':[' + nsId(p, name) + ']';
        return { type: 'l', uid: p.euid, gid: p.egid, mode: 0o777, target: label,
          magic: () => ({ inode: k.synthInode(nsfs, { type: 'f', read: () => '', nsref: { kind, ns: nsObj(p, name), root: p.root } }, label(), nsfs.root, label()), path: label() }) };
      } });
    k.procfs.pidFiles.cgroup = (p) => ({ read: () => '0::' + (p.cg ? p.cg.path : '/') + '\n' });
    const status0 = k.procfs.pidFiles.status;
    k.procfs.pidFiles.status = (p, view) => { const nd = status0(p, view), rd = nd.read; nd.read = () => {
      const from = view ? view.level : 0, lv = p.ns.pid.level;
      const chain = (g) => { const out = []; const q = k.procs.get(g); for (let i = from; i <= lv; i++) out.push(!q ? 0 : i === 0 ? q.pid : (q.vpids && q.ns.pid.level >= i && (i === q.ns.pid.level || true) ? (k.vpid(q, nsAt(p, i)) || 0) : 0)); return out.join('\t'); };
      return rd().replace(/\n(Vm|Threads:)/, '\nNStgid:\t' + chain(p.pid) + '\nNSpid:\t' + chain(p.pid) + '\nNSpgid:\t' + chain(p.pgid) + '\nNSsid:\t' + chain(p.sid) + '\n$1');
    }; return nd; };
    const nsAt = (p, level) => { let x = p.ns.pid; while (x && x.level > level) x = x.parent; return x; };

    // ── /sys と cgroup2、/run ──
    const sysfs = k.mkSynth('sysfs', 'sysfs');
    sysfs.reg('fs/cgroup', { type: 'd', kids: {}, pin: true });
    sysfs.reg('kernel/mm/transparent_hugepage/enabled', { read: () => 'always madvise [never]\n' });
    sysfs.reg('devices/system/cpu/online', { read: () => '0\n' });
    sysfs.reg('devices/system/cpu/possible', { read: () => '0\n' });
    sysfs.reg('block/sda/size', { read: () => k.rootfs.blocksTotal * 8 + '\n' });
    sysfs.reg('block/sda/queue/rotational', { read: () => '1\n' });
    const ifs = () => (k.ns0.net ? k.ns0.net.ifaces : []);
    sysfs.reg('class/net', { type: 'd', kids: {}, list: () => ifs().map((i) => i.name), get: (k2, p, name) => { const i = ifs().find((x) => x.name === name); return i ? { type: 'd', kids: { address: { type: 'f', read: () => i.mac + '\n' }, mtu: { type: 'f', read: () => i.mtu + '\n' }, operstate: { type: 'f', read: () => i.state.toLowerCase() + '\n' } } } : null; } });
    const R = k.rootfs.root.ents;
    k.doMount(n0, sysfs, R.get('sys'), '/sys', { opts: 'rw,nosuid,nodev,noexec,relatime' });
    const cgfs = k.mkfs('cgroup2', 'cgroup2', { blocks: 0, mode: 0o755, inodes: 4096 });
    const T0 = k.epoch - 9000;
    const mkCg = (parent, name, dir, uid) => {
      const cg = { name, parent, path: parent ? (parent.path === '/' ? '' : parent.path) + '/' + name : '/', kids: new Map(), dir, nr: 0, pidsMax: Infinity, pidsPeak: 0, pidsEv: 0, memMax: Infinity, memCur: 0, memPeak: 0, oom: 0, oomKill: 0, failcnt: 0 };
      dir.cg = cg;
      if (parent) parent.kids.set(name, cg);
      const file = (fname, mode, dyn) => { const i = k.newInode(cgfs, 'f', mode, uid | 0, uid | 0); i.dyn = dyn; i.cgFile = true; k.dirAdd(dir, fname, i); i.mtime = i.ctime = i.atime = dir.mtime; };
      const members = () => Array.from(k.procs.values()).filter((p) => p.cg === cg);
      const lim = (v) => (v === Infinity ? 'max' : String(v));
      const num = (d, bytes) => { const s = d.trim(); if (s === 'max') return Infinity; const m = bytes ? /^(\d+)([KMG]?)$/i.exec(s) : /^(\d+)$/.exec(s); if (!m) return -1; return +m[1] * (bytes ? ({ k: 1024, m: 1048576, g: 1073741824 }[(m[2] || '').toLowerCase()] || 1) : 1); };
      file('cgroup.controllers', 0o444, { read: () => 'memory pids\n' });
      file('cgroup.subtree_control', 0o644, { read: () => 'memory pids\n', write: () => undefined });
      file('cgroup.procs', 0o644, {
        read: (k2, p) => members().map((q) => k.vpid(q, p && p.ns ? p.ns.pid : null)).filter((v) => v > 0).sort((a, b) => a - b).map((v) => v + '\n').join(''),
        write: (k2, p, d) => {
          const n = parseInt(d, 10); if (isNaN(n) || n < 0) return -E.EINVAL;
          const q = n === 0 ? p : k.findPid(p, n);
          if (!q || q.state === 'Z') return -E.ESRCH;
          if (p.euid !== 0 && p.euid !== q.uid) return -E.EACCES;
          if (q.cg === cg) return undefined;
          for (let x = cg; x; x = x.parent) if (x.nr + 1 > x.pidsMax && !(q.cg && isUnder(q.cg, x))) return -E.EAGAIN;
          move(q, cg);
          k.ev('cgroup', { op: 'move', path: cg.path, pid: q.pid });
          return undefined;
        } });
      if (parent) {
        file('cgroup.events', 0o444, { read: () => 'populated ' + (cg.nr > 0 ? 1 : 0) + '\nfrozen 0\n' });
        file('cgroup.kill', 0o200, { write: (k2, p, d) => { if (d.trim() !== '1') return -E.EINVAL; for (const q of Array.from(k.procs.values())) if (q.cg && isUnder(q.cg, cg) && q.state !== 'Z') k.sendSig(q, SIG.KILL, p); return undefined; } });
        file('memory.current', 0o444, { read: () => cg.memCur * PGSZ + '\n' });
        file('memory.events', 0o444, { read: () => 'low 0\nhigh 0\nmax ' + cg.oom + '\noom ' + cg.oom + '\noom_kill ' + cg.oomKill + '\noom_group_kill 0\n' });
        file('memory.max', 0o644, { read: () => (cg.memMax === Infinity ? 'max' : cg.memMax * PGSZ) + '\n', write: (k2, p, d) => { const v = num(d, true); if (v < 0) return -E.EINVAL; cg.memMax = v === Infinity ? v : Math.floor(v / PGSZ); k.ev('cgroup', { op: 'set', path: cg.path, pid: p.pid, key: 'memory.max', value: v === Infinity ? 'max' : cg.memMax * PGSZ }); return undefined; } });
        file('memory.peak', 0o444, { read: () => cg.memPeak * PGSZ + '\n' });
        file('pids.current', 0o444, { read: () => cg.nr + '\n' });
        file('pids.events', 0o444, { read: () => 'max ' + cg.pidsEv + '\n' });
        file('pids.max', 0o644, { read: () => lim(cg.pidsMax) + '\n', write: (k2, p, d) => { const v = num(d, false); if (v < 0) return -E.EINVAL; cg.pidsMax = v; k.ev('cgroup', { op: 'set', path: cg.path, pid: p.pid, key: 'pids.max', value: lim(v) }); return undefined; } });
        file('pids.peak', 0o444, { read: () => cg.pidsPeak + '\n' });
      }
      return cg;
    };
    const isUnder = (g, top) => { for (let x = g; x; x = x.parent) if (x === top) return true; return false; };
    const adj = (g, d) => { for (let x = g; x; x = x.parent) { x.nr += d; if (x.nr > x.pidsPeak) x.pidsPeak = x.nr; } };
    const move = (q, cg) => { if (q.cg) adj(q.cg, -1); q.cg = cg; adj(cg, 1); };
    cgfs.root.mtime = cgfs.root.ctime = cgfs.root.atime = T0;
    const rootCg = st.rootCg = mkCg(null, '', cgfs.root, 0);
    cgfs.ops = {
      mkdir(k2, p, parent, name, ino) { mkCg(parent.cg, name, ino, p.euid); k.ev('cgroup', { op: 'mkdir', path: ino.cg.path, pid: p.pid }); },
      rmdir(k2, p, d) {
        const cg = d.cg;
        if (!cg || !cg.parent) return -E.EBUSY;
        if (cg.nr > 0 || cg.kids.size) return -E.EBUSY;
        for (const name of Array.from(d.ents.keys())) k.dirRemove(d, name);
        cg.parent.kids.delete(cg.name);
        k.ev('cgroup', { op: 'rmdir', path: cg.path, pid: p.pid });
        return 0;
      },
    };
    k.doMount(n0, cgfs, k.namei(k.kcred, '/sys/fs/cgroup'), '/sys/fs/cgroup', { opts: 'rw,nosuid,nodev,noexec,relatime' });
    k.fstypes.cgroup2 = () => cgfs;
    k.fstypes.sysfs = () => sysfs;
    const runfs = k.fstypes.tmpfs(k, 'tmpfs', 'size=1M');
    runfs.root.mode = 0o755; runfs.root.mtime = runfs.root.ctime = runfs.root.atime = T0;
    k.doMount(n0, runfs, R.get('run'), '/run', { opts: 'rw,nosuid,nodev,relatime,size=1024k,mode=755' });
    k.on('exec', (p) => { if (!p.cg) { p.cg = rootCg; adj(rootCg, 1); } });
    k.on('fork', (parent, child) => { child.cg = parent.cg || rootCg; adj(child.cg, 1); });
    k.on('reap', (p) => { if (p.cg) { adj(p.cg, -1); p.cg = null; } });
    k.on('canFork', (p) => {
      for (let x = p.cg; x; x = x.parent) if (x.nr + 1 > x.pidsMax) { x.pidsEv++; k.printk('cgroup: fork rejected by pids controller in ' + x.path, 6); k.ev('cgroup', { op: 'deny', path: x.path, pid: p.pid, key: 'pids.max', value: x.pidsMax }); return -E.EAGAIN; }
      return 0;
    });
    st.cgfs = cgfs; st.sysfs = sysfs; st.nsId = nsId;

    // ── コンテナ用の最小のルート ──
    if (!k.reused) {
      const t = k.epoch - 86400000 * 12, B = '/srv/rootfs';
      const bb = k.namei(k.kcred, '/usr/bin/busybox');
      const dir = k.mkdirp(B + '/bin');
      if (typeof bb !== 'number') { const f = k.writeFile(B + '/bin/busybox', bb.data, 0o755, 0, 0, t); void f; }
      for (const a of APPLETS) k.mkSymlink('busybox', B + '/bin/' + a, t);
      void dir;
      k.writeFile(B + '/etc/passwd', 'root:x:0:0:root:/root:/bin/sh\nnobody:x:65534:65534:nobody:/:/bin/false\n', 0o644, 0, 0, t);
      k.writeFile(B + '/etc/group', 'root:x:0:\nnobody:x:65534:\n', 0o644, 0, 0, t);
      k.writeFile(B + '/etc/hostname', 'box\n', 0o644, 0, 0, t);
      k.writeFile(B + '/etc/hosts', '127.0.0.1\tlocalhost\n', 0o644, 0, 0, t);
      k.writeFile(B + '/etc/os-release', 'NAME="Zukai Container Base"\nID=zukai-base\nVERSION_ID=1.0\nPRETTY_NAME="Zukai Container Base 1.0"\n', 0o644, 0, 0, t);
      k.writeFile(B + '/root/hello.txt', enc('コンテナの中のファイルです。\n'), 0o644, 0, 0, t);
      for (const d of ['proc', 'sys', 'dev', 'home', 'mnt']) k.mkdirp(B + '/' + d);
      k.mkdirp(B + '/tmp').mode = 0o1777;
      k.namei(k.kcred, B + '/root').mode = 0o700;
      k.mkDev(B + '/dev/null', 1, 3, 0o666); k.mkDev(B + '/dev/zero', 1, 5, 0o666); k.mkDev(B + '/dev/urandom', 1, 9, 0o666); k.mkDev(B + '/dev/tty', 5, 0, 0o666);
      const fix = (d) => { d.mtime = d.ctime = d.atime = t; for (const i of d.ents.values()) { i.mtime = i.ctime = i.atime = t; if (i.type === 'd') fix(i); } };
      fix(k.namei(k.kcred, B));
      k.namei(k.kcred, '/srv').mtime = t;
    }
    return st;
  });
  LNX.CLONE = CLONE;
  const APPLETS = ['sh', 'ls', 'cat', 'echo', 'ps', 'hostname', 'mkdir', 'rmdir', 'mount', 'umount', 'sleep', 'id', 'pwd', 'uname', 'env', 'grep', 'head', 'tail', 'wc', 'kill', 'touch', 'rm', 'cp', 'mv', 'ln', 'true', 'false', 'test', 'whoami', 'df', 'free', 'top', 'pstree', 'stat', 'readlink', 'seq', 'sort', 'date', 'uptime', 'nc', 'ip', 'ss', 'spin', 'burn', 'memtouch', 'memhog'];

  // ── 観察 ──
  const M = LNX.kernel.M;
  M.cgroups = function () {
    const k = this.k, st = k.sub.ns;
    const rec = (cg) => ({ path: cg.path, name: cg.name, procs: Array.from(k.procs.values()).filter((p) => p.cg === cg).map((p) => p.pid).sort((a, b) => a - b), pidsMax: cg.pidsMax === Infinity ? 'max' : cg.pidsMax, pidsCurrent: cg.nr, memMax: cg.memMax === Infinity ? 'max' : cg.memMax * PGSZ, memCurrent: cg.memCur * PGSZ, oomKill: cg.oomKill, denied: cg.pidsEv, children: Array.from(cg.kids.values()).map(rec) });
    return rec(st.rootCg);
  };
  M.namespaces = function () {
    const k = this.k, st = k.sub.ns, out = new Map();
    for (const p of k.procs.values()) for (const kind of ['mnt', 'uts', 'ipc', 'net', 'pid', 'cgroup', 'user']) { const id = st.nsId(p, kind), key = kind + id; if (!out.has(key)) out.set(key, { type: kind, id, pids: [] }); out.get(key).pids.push(p.pid); }
    return Array.from(out.values()).sort((a, b) => a.id - b.id);
  };
  const ps0 = M.ps;
  M.ps = function () {
    const k = this.k, st = k.sub.ns, rows = ps0.call(this);
    for (const r of rows) { const p = k.procs.get(r.pid); if (!p) continue; r.vpid = p.ns.pid.level ? p.vpids[p.ns.pid.level] : p.pid; r.ns = { pid: st.nsId(p, 'pid'), mnt: st.nsId(p, 'mnt'), uts: st.nsId(p, 'uts'), net: st.nsId(p, 'net') }; r.cgroup = p.cg ? p.cg.path : '/'; r.root = p.root && p.root !== k.rootfs.root ? dec(k.pathOf(k.kcred, p.root) || '/') : '/'; r.hostname = p.ns.uts.hostname; }
    return rows;
  };

  // ── コマンド ──
  const L = { late: true };
  P('chroot', 'ルートディレクトリを変えてコマンドを実行する（root だけ）', 'chroot ディレクトリ [コマンド [引数…]]   例：chroot /srv/rootfs /bin/sh', function* (c) {
    const av = c.argv.slice(1);
    if (!av.length || av[0][0] === '-') { c.err("chroot: missing operand\nTry 'chroot --help' for more information.\n"); return 125; }
    const dir = av[0], cmd = av.length > 1 ? av.slice(1) : [c.env.SHELL || '/bin/sh', '-i'];
    let r = yield sys.chroot(dir);
    if (r < 0) { c.err('chroot: cannot change root directory to ' + q(dir) + ': ' + strerror(r) + '\n'); return 125; }
    r = yield sys.chdir('/');
    if (r < 0) { c.err('chroot: cannot chdir to root directory: ' + strerror(r) + '\n'); return 125; }
    const path = yield* c.which(cmd[0]);
    const e = path ? yield sys.execve(path, cmd, c.env) : -E.ENOENT;
    c.err('chroot: failed to run command ' + "'" + cmd[0] + "'" + ': ' + strerror(e) + '\n');
    return e === -E.ENOENT ? 127 : 126;
  }, L);
  const q = (s) => "'" + s + "'";
  P('unshare', '新しい名前空間を作って、その中でコマンドを実行する（root だけ）', 'unshare [-m] [-u] [-i] [-n] [-p] [-f] [--mount-proc[=ディレクトリ]] [-R ディレクトリ] [コマンド [引数…]]   例：unshare -p -f --mount-proc sh', function* (c) {
    const av = c.argv.slice(1);
    let fl = 0, fork = false, mproc = null, rootDir = null, wd = null, i = 0;
    const LONG = { '--mount': 'm', '--uts': 'u', '--ipc': 'i', '--net': 'n', '--pid': 'p', '--fork': 'f', '--cgroup': 'C', '--user': 'U' };
    for (; i < av.length; i++) {
      const a = av[i];
      if (a === '--') { i++; break; }
      if (a[0] !== '-') break;
      if (a === '--mount-proc') { mproc = '/proc'; fl |= CLONE.NEWNS; continue; }
      if (/^--mount-proc=/.test(a)) { mproc = a.slice(13); fl |= CLONE.NEWNS; continue; }
      if (a === '-R' || a === '--root') { rootDir = av[++i]; continue; }
      if (/^--root=/.test(a)) { rootDir = a.slice(7); continue; }
      if (a === '-w' || a === '--wd') { wd = av[++i]; continue; }
      const fs = a.slice(0, 2) === '--' ? (LONG[a] ? [LONG[a]] : null) : a.slice(1).split('');
      if (!fs) { c.err("unshare: unrecognized option '" + a + "'\nTry 'unshare --help' for more information.\n"); return 1; }
      for (const f of fs) {
        if (f === 'm') fl |= CLONE.NEWNS; else if (f === 'u') fl |= CLONE.NEWUTS; else if (f === 'i') fl |= CLONE.NEWIPC; else if (f === 'n') fl |= CLONE.NEWNET; else if (f === 'p') fl |= CLONE.NEWPID; else if (f === 'C') fl |= CLONE.NEWCGROUP; else if (f === 'f') fork = true;
        else if (f === 'U' || f === 'r') { c.err(enc('unshare: この Linux にはユーザー名前空間（-U / -r）がありません\n')); return 1; } else { c.err("unshare: invalid option -- '" + f + "'\nTry 'unshare --help' for more information.\n"); return 1; }
      }
    }
    const cmd = i < av.length ? av.slice(i) : [c.env.SHELL || '/bin/sh'];
    const r = yield sys.unshare(fl);
    if (r < 0) { c.err('unshare: unshare failed: ' + strerror(r) + '\n'); return 1; }
    const env = c.env;
    const inner = function* (c2) {
      if (mproc) { const m = yield sys.mount('proc', mproc, 'proc', 0, ''); if (m < 0) { c2.err('unshare: mount ' + mproc + ' failed: ' + strerror(m) + '\n'); return 1; } }
      if (rootDir) { let x = yield sys.chroot(rootDir); if (x < 0) { c2.err("unshare: cannot change root directory to '" + rootDir + "': " + strerror(x) + '\n'); return 1; } x = yield sys.chdir('/'); }
      if (wd) { const x = yield sys.chdir(wd); if (x < 0) { c2.err("unshare: cannot change directory to '" + wd + "': " + strerror(x) + '\n'); return 1; } }
      const path = yield* c2.which(cmd[0]);
      const e = path ? yield sys.execve(path, cmd, env) : -E.ENOENT;
      c2.err('unshare: failed to execute ' + cmd[0] + ': ' + strerror(e) + '\n');
      return e === -E.ENOENT ? 127 : 126;
    };
    if (!fork) return yield* inner(c);
    yield* c.flush();
    const pid = yield sys.fork(inner);
    if (pid < 0) { c.err('unshare: fork failed: ' + strerror(pid) + '\n'); return 1; }
    // 端末の前景をそのままにして、子が終わるのを待つ
    for (;;) { const w = yield sys.wait4(pid, 0); if (w === -E.EINTR) continue; if (typeof w === 'number') return 1; if (w.status & 0x7f) { yield sys.kill(yield sys.getpid(), w.status & 0x7f); return 128 + (w.status & 0x7f); } return (w.status >> 8) & 0xff; }
  }, L);
  P('nsenter', 'ほかのプロセスの名前空間に入って、コマンドを実行する（root だけ）', 'nsenter -t PID [-m] [-u] [-i] [-n] [-p] [-a] [コマンド [引数…]]   例：nsenter -t 123 -p -m ps', function* (c) {
    const g = c.getopt('t:muinpaCr', { '--target': 't', '--mount': 'm', '--uts': 'u', '--ipc': 'i', '--net': 'n', '--pid': 'p', '--all': 'a' }, true); if (!g) return 1;
    const o = g.o;
    if (o.t === undefined) { c.err(o.a ? 'nsenter: no target PID specified for --all\n' : 'nsenter: no namespace specified\n'); return 1; }
    const kinds = [];
    for (const [f, kd] of [['u', 'uts'], ['i', 'ipc'], ['n', 'net'], ['p', 'pid'], ['m', 'mnt']]) if (o[f] || o.a) kinds.push(kd);
    if (!kinds.length) { c.err('nsenter: no namespace specified\n'); return 1; }
    const fds = [];
    for (const kd of kinds) { const path = '/proc/' + o.t + '/ns/' + kd, fd = yield sys.open(path, O.RDONLY); if (fd < 0) { c.err('nsenter: cannot open ' + path + ': ' + strerror(fd) + '\n'); return 1; } fds.push([kd, fd]); }
    for (const [kd, fd] of fds) { const r = yield sys.setns(fd, 0); if (r < 0) { c.err("nsenter: reassociate to namespace 'ns/" + kd + "' failed: " + strerror(r) + '\n'); return 1; } yield sys.close(fd); }
    const cmd = g.args.length ? g.args : [c.env.SHELL || '/bin/sh'], env = c.env;
    const inner = function* (c2) { const path = yield* c2.which(cmd[0]); const e = path ? yield sys.execve(path, cmd, env) : -E.ENOENT; c2.err("nsenter: failed to execute " + cmd[0] + ': ' + strerror(e) + '\n'); return e === -E.ENOENT ? 127 : 126; };
    if (kinds.indexOf('pid') < 0) return yield* inner(c);
    const pid = yield sys.fork(inner);
    if (pid < 0) { c.err('nsenter: fork failed: ' + strerror(pid) + '\n'); return 1; }
    for (;;) { const w = yield sys.wait4(pid, 0); if (w === -E.EINTR) continue; if (typeof w === 'number') return 1; return (w.status & 0x7f) ? 128 + (w.status & 0x7f) : (w.status >> 8) & 0xff; }
  }, L);
  P('lsns', '名前空間の一覧を表示する', 'lsns [-t 種類]', function* (c) {
    const g = c.getopt('t:n', { '--type': 't' }); if (!g) return 1;
    const ents = yield* c.readDir('/proc');
    if (isErr(ents)) return 1;
    const pw = yield* c.passwd(), found = new Map();
    for (const e of ents.filter((x) => /^\d+$/.test(x.name)).sort((a, b) => +a.name - +b.name)) {
      const st = yield* c.slurp('/proc/' + e.name + '/status'), cl = yield* c.slurp('/proc/' + e.name + '/cmdline');
      if (typeof st !== 'string') continue;
      const um = /^Uid:\t(\d+)/m.exec(st), uid = um ? +um[1] : 0, u = pw.find((x) => x.uid === uid);
      for (const kind of ['time', 'cgroup', 'pid', 'user', 'uts', 'ipc', 'net', 'mnt']) {
        const t = yield sys.readlink('/proc/' + e.name + '/ns/' + kind);
        const m = typeof t === 'string' && /\[(\d+)\]/.exec(t);
        if (!m) continue;
        const key = kind + m[1];
        if (!found.has(key)) found.set(key, { ns: m[1], type: kind, n: 0, pid: e.name, user: u ? u.name : String(uid), cmd: typeof cl === 'string' && cl ? cl.replace(/\0$/, '').split('\0').join(' ') : '' });
        found.get(key).n++;
      }
    }
    const rows = Array.from(found.values()).filter((r) => !g.o.t || r.type === g.o.t).sort((a, b) => +a.ns - +b.ns);
    if (!rows.length) return 0;
    const wn = Math.max(6, ...rows.map((r) => String(r.n).length)), wp = Math.max(3, ...rows.map((r) => r.pid.length)), wu = Math.max(4, ...rows.map((r) => r.user.length)), wt = Math.max(4, ...rows.map((r) => r.type.length));
    if (!g.o.n) c.out('NS'.padStart(10) + ' ' + 'TYPE'.padEnd(wt) + ' ' + 'NPROCS'.padStart(wn) + ' ' + 'PID'.padStart(wp) + ' ' + 'USER'.padEnd(wu) + ' COMMAND\n');
    for (const r of rows) c.out(r.ns.padStart(10) + ' ' + r.type.padEnd(wt) + ' ' + String(r.n).padStart(wn) + ' ' + r.pid.padStart(wp) + ' ' + r.user.padEnd(wu) + ' ' + r.cmd + '\n');
    return 0;
  }, L);
  // たくさんのコマンドを 1 つの実行ファイルにまとめたもの。呼ばれた名前（argv[0]）で動作が決まる
  P('busybox', 'たくさんのコマンドを 1 つの実行ファイルにまとめたもの（呼ばれた名前のコマンドとして動く。コンテナ用の小さなルートで使う）', 'busybox コマンド名 [引数…]', function* (c) {
    let name = c.name;
    if (name === 'busybox') {
      if (c.argv.length < 2 || c.argv[1] === '--list' || c.argv[1] === '--help') {
        if (c.argv[1] === '--list') { c.out(APPLETS.slice().sort().join('\n') + '\n'); return 0; }
        c.out('BusyBox v1.36.1 (zukai) multi-call binary.\n\nUsage: busybox [function [arguments]...]\n   or: function [arguments]...\n\nCurrently defined functions:\n\t' + APPLETS.slice().sort().join(', ') + '\n'); return 0;
      }
      c.argv = c.argv.slice(1); name = c.name = U.basename(c.argv[0]).replace(/^-/, '');
    }
    const pr = APPLETS.indexOf(name) >= 0 && LNX.bin[name];
    if (!pr) { c.err(name + ': applet not found\n'); return 127; }
    return yield* (pr.main || pr)(c);
  }, L);
  Object.assign(LNX.SYSJA, { unshare: '新しい名前空間に移る', setns: '既存の名前空間に入る', chroot: 'ルートディレクトリを変える' });
  void lines;
})(typeof window !== 'undefined' ? window : globalThis);
