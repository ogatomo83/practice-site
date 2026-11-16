// 図解 Linux のネットワーク（16 章）。pagecache.js の後に読み込む。API は kernel.js の先頭コメントを見る。
//
// ■ つながっているもの：lo（127.0.0.1/8。ループバック）と eth0（192.168.1.5/24）。ただし eth0 の先には何もつながっていない。
//   自分自身（127.x.x.x、192.168.1.5、0.0.0.0）への接続だけが成功する。192.168.1.x のほかの番地は 3 秒待って EHOSTUNREACH、それ以外は ENETUNREACH。
//   名前は /etc/hosts だけで引く（DNS はない）。ポートの名前は /etc/services。
// ■ ソケット：AF_INET の SOCK_STREAM（TCP）と、AF_UNIX の SOCK_STREAM。UDP と IPv6 はない。ソケットは fd（inode の種類 's'）で、read / write / close / poll / dup が使える。
//   システムコール（番地は { addr: '127.0.0.1', port: 8080 }、UNIX ドメインは { path: '/run/x.sock' }）：
//     socket('inet' | 'unix', 'stream') → fd    bind(fd, 番地)    listen(fd, backlog)    accept(fd) → 新しい fd    connect(fd, 番地)
//     shutdown(fd, 0 = 読む側 | 1 = 書く側 | 2 = 両方)    getsockname(fd) / getpeername(fd) → 番地    setsockopt(fd, 'SO_REUSEADDR', 1)    getsockopt(fd, 'SO_ERROR')
//     送受信は write / read（sys.send / sys.recv も同じ）。相手が閉じた後に書くと EPIPE（と SIGPIPE）、リセットされたら ECONNRESET。
//   ポート：bind で port: 0 か、bind せずに connect すると、空いている番号（32768〜60999）が順に割り当てられる。1024 未満は root だけ。
//     使用中なら EADDRINUSE（TIME_WAIT が残っているポートも。SO_REUSEADDR をつければ bind できる）。待ち受けがなければ ECONNREFUSED。
// ■ TCP の状態（簡略版。再送・ウィンドウ・輻輳制御はない。パケットは失われない）：
//     CLOSED → (connect) SYN_SENT → ESTABLISHED          LISTEN →（SYN を受けて子ソケット）SYN_RECV → ESTABLISHED →（accept で取り出す）
//     先に閉じる側：ESTABLISHED → FIN_WAIT1 → FIN_WAIT2 → TIME_WAIT（60 秒）→ CLOSED      後から閉じる側：ESTABLISHED → CLOSE_WAIT → LAST_ACK → CLOSED
//     同時に閉じた：FIN_WAIT1 → CLOSING → TIME_WAIT
//   パケットは「送る → 遅延（既定 0 ms）→ 届く」。遅延は tc qdisc add dev lo root netem delay 100ms で変えられる（SYN_SENT などの途中の状態を観察できる）。
//   listen の待ち行列（backlog）が一杯のとき、SYN は捨てられる。connect は 1・2・4 秒後に SYN を送り直し、それでもだめなら ETIMEDOUT。
// ■ コマンド：nc（-l -p -k -v -z -U -N -q -w）、ss（-t -l -a -n -p -x）、curl、httpd、ip（addr / link / route）、hostname -I、ping、tc（netem delay だけ）、getent hosts
//   /var/www/html に index.html と hello.txt。httpd は既定でポート 8080、/var/www/html を配る。
// ■ 名前空間：unshare(CLONE_NEWNET) した中は別のネットワーク（lo だけ。ポートも別）。ns.js。
// ■ 観察：sys.net() → { ifaces, delay, sockets: [{ id, family, state, local, peer, recvQ, backlog, queued, users: [{ pid, comm, fd }], path }] }
// ■ events（run の opts.trace に 'net'）：
//     { type: 'pkt', proto: 'tcp', src: '127.0.0.1:40000', dst: '127.0.0.1:8080', flags: 'SYN' | 'SYN,ACK' | 'ACK' | 'PSH,ACK' | 'FIN,ACK' | 'RST' | 'RST,ACK',
//       seq, ack, len, rseq, rack（接続ごとの相対番号。0 から）, data（先頭 64 バイト）, from, to（ソケットの id。相手がいなければ 0）, arrive（届く時刻）}
//     { type: 'tcp', sock, old, state, local, peer }                 ソケットの状態が変わった
//     { type: 'sock', op: 'socket' | 'bind' | 'listen' | 'accept' | 'connect' | 'shutdown' | 'close', pid, fd, sock, family, local, peer, path }
//     { type: 'drop', reason: 'backlog', dst }                       SYN を捨てた
(function (root) {
  'use strict';
  const LNX = root.LNX, E = LNX.ERRNO, sys = LNX.sys, U = LNX.util, O = LNX.O, SIG = LNX.SIG, strerror = LNX.strerror, BLOCK = LNX.kernel.BLOCK;
  const { P, isErr, lines } = LNX.binutil;
  const enc = U.enc, dec = U.dec, quote = U.quote;
  for (const [n, v, m] of [['EDESTADDRREQ', 89, 'Destination address required'], ['EPROTOTYPE', 91, 'Protocol wrong type for socket'], ['ESOCKTNOSUPPORT', 94, 'Socket type not supported'], ['EHOSTUNREACH', 113, 'No route to host'], ['EALREADY', 114, 'Operation already in progress'], ['EINPROGRESS', 115, 'Operation now in progress']]) { E[n] = v; LNX.ERRMSG[v] = m; LNX.ENAME[v] = n; }
  const NET = { AF_UNIX: 1, AF_INET: 2, SOCK_STREAM: 1, SOCK_DGRAM: 2, SHUT_RD: 0, SHUT_WR: 1, SHUT_RDWR: 2 };
  const RCVBUF = 65536, MSS = 65483, MSL2 = 60000;
  const famOf = (f) => (f === 2 || f === 'inet' || f === 'AF_INET' ? 'inet' : f === 1 || f === 'unix' || f === 'AF_UNIX' || f === 'local' ? 'unix' : null);
  const ep = (a, p) => a + ':' + p;
  const isIp = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every((x) => +x < 256);
  const FLAGS = { S: 'SYN', SA: 'SYN,ACK', A: 'ACK', PA: 'PSH,ACK', FA: 'FIN,ACK', R: 'RST', RA: 'RST,ACK' };

  function mkNetns(k, id, withEth) {
    const ns = { id, ifaces: [{ name: 'lo', index: 1, flags: 'LOOPBACK,UP,LOWER_UP', mtu: 65536, qdisc: 'noqueue', state: 'UNKNOWN', link: 'loopback', mac: '00:00:00:00:00:00', brd: '00:00:00:00:00:00', addr: '127.0.0.1', prefix: 8, scope: 'host', up: true }],
      listeners: new Map(), conns: new Map(), ports: new Map(), socks: new Set(), ephem: 32768 + ((id * 7919) % 1000) * 0, delay: 0, isn: 0x1f2e3d4c ^ (id * 2654435761 >>> 0) };
    if (withEth) ns.ifaces.push({ name: 'eth0', index: 2, flags: 'BROADCAST,MULTICAST,UP,LOWER_UP', mtu: 1500, qdisc: 'fq_codel', state: 'UP', link: 'ether', mac: '52:54:00:12:34:56', brd: 'ff:ff:ff:ff:ff:ff', addr: '192.168.1.5', prefix: 24, bcast: '192.168.1.255', scope: 'global', up: true });
    return ns;
  }

  LNX.kernel.plugin('net', (k) => {
    const net = { seq: 0, nsSeq: 0, NET };
    const ns0 = net.ns0 = k.ns0.net = mkNetns(k, 0, true);
    net.mkNetns = () => mkNetns(k, ++net.nsSeq, false);
    const nsOf = (p) => (p.ns && p.ns.net) || ns0;
    const tr = () => k.tracing('net');
    const isLocal = (ns, a) => a === '0.0.0.0' || /^127\./.test(a) || ns.ifaces.some((i) => i.addr === a);
    const srcFor = (ns, dst) => (/^127\./.test(dst) || dst === '0.0.0.0' ? '127.0.0.1' : dst);
    const L = (s) => (s.family === 'unix' ? (s.path || '') : s.lport ? ep(s.laddr, s.lport) : '');
    const R = (s) => (s.family === 'unix' ? (s.peer && s.peer.path) || '' : s.rport ? ep(s.raddr, s.rport) : '');
    const setState = (s, st) => { if (s.state === st) return; const old = s.state; s.state = st; if (s.family === 'inet' && tr()) k.tev('net', 'tcp', { sock: s.id, old, state: st, local: L(s), peer: R(s) }); };
    const sev = (op, p, fd, s, extra) => { if (tr()) k.tev('net', 'sock', Object.assign({ op, pid: p ? p.pid : 0, fd, sock: s.id, family: s.family, local: L(s), peer: R(s) }, extra || {})); };
    function mkSock(ns, family) {
      const s = { id: ++net.seq, ns, family, state: 'CLOSED', laddr: '0.0.0.0', lport: 0, raddr: '', rport: 0, path: '', bound: false, reuse: false, backlog: 0, acceptq: [], synq: 0, parent: null, peer: null,
        rcv: '', rcvEof: false, pending: 0, err: 0, iss: 0, irs: 0, sndNxt: 0, rcvNxt: 0, shutRd: false, shutWr: false, closed: false, dead: false, rwait: [], wwait: [], await: [], cwait: [], ino: null, timer: null, created: k.clock };
      ns.socks.add(s);
      return s;
    }
    function takePort(ns, s, port) { let set = ns.ports.get(port); if (!set) ns.ports.set(port, set = new Set()); set.add(s); }
    function dropPort(ns, s) { const set = ns.ports.get(s.lport); if (set) { set.delete(s); if (!set.size) ns.ports.delete(s.lport); } }
    function portBusy(ns, s, addr, port) {
      const set = ns.ports.get(port); if (!set) return false;
      for (const o of set) { if (o === s || o.dead) continue; if (o.laddr !== addr && o.laddr !== '0.0.0.0' && addr !== '0.0.0.0') continue; if (o.state === 'LISTEN' || !(o.reuse || o.parent || o.closed) || !s.reuse) return true; }
      return false;
    }
    function ephemeral(ns, s, addr) { for (let i = 0; i < 28232; i++) { const port = ns.ephem; ns.ephem = ns.ephem >= 60999 ? 32768 : ns.ephem + 1; if (!ns.ports.has(port)) return port; } return 0; }
    function destroy(s) {
      if (s.dead) return;
      s.dead = true;
      if (s.timer) { k.cancelTimer(s.timer); s.timer = null; }
      const ns = s.ns;
      if (s.family === 'inet') {
        if (s.state === 'LISTEN') { const l = ns.listeners.get(s.lport); if (l) { const i = l.indexOf(s); if (i >= 0) l.splice(i, 1); if (!l.length) ns.listeners.delete(s.lport); } }
        if (s.rport) ns.conns.delete(ep(s.laddr, s.lport) + '>' + ep(s.raddr, s.rport));
        if (s.lport) dropPort(ns, s);
        setState(s, 'CLOSED');
      } else s.state = 'CLOSED';
      ns.socks.delete(s);
      for (const q of [s.rwait, s.wwait, s.await, s.cwait]) k.wake(q);
    }
    // ── TCP のパケット ──
    function send(s, flags, o) {
      o = o || {};
      const pkt = { from: s, to: o.to || s.peer || null, src: { addr: s.laddr, port: s.lport }, dst: { addr: s.raddr, port: s.rport }, flags, seq: o.seq !== undefined ? o.seq : s.sndNxt, ack: flags.indexOf('A') >= 0 ? s.rcvNxt : 0, data: o.data || '' };
      const ns = s.ns, arrive = k.clock + ns.delay;
      if (tr()) k.tev('net', 'pkt', { proto: 'tcp', src: ep(pkt.src.addr, pkt.src.port), dst: ep(pkt.dst.addr, pkt.dst.port), flags: FLAGS[flags], seq: pkt.seq, ack: pkt.ack, len: pkt.data.length, rseq: (pkt.seq - s.iss) >>> 0, rack: pkt.ack ? (pkt.ack - s.irs) >>> 0 : 0, data: pkt.data ? dec(pkt.data.slice(0, 64)) : '', from: s.id, to: pkt.to ? pkt.to.id : 0, arrive });
      k.timer(arrive, () => recv(ns, pkt));
    }
    function rst(ns, pkt) {
      // 宛先のソケットがない：RST を返す
      if (pkt.flags.indexOf('R') >= 0) return;
      const from = pkt.from, fake = { id: 0, ns, laddr: pkt.dst.addr, lport: pkt.dst.port, raddr: pkt.src.addr, rport: pkt.src.port, sndNxt: pkt.ack || 0, rcvNxt: pkt.seq + pkt.data.length + (pkt.flags[0] === 'S' || pkt.flags[0] === 'F' ? 1 : 0), iss: pkt.ack || 0, irs: pkt.seq, peer: from };
      send(fake, pkt.flags.indexOf('A') >= 0 ? 'R' : 'RA', { to: from });
    }
    function timeWait(s) { setState(s, 'TIME_WAIT'); if (s.timer) k.cancelTimer(s.timer); s.timer = k.timer(k.clock + MSL2, () => { s.timer = null; destroy(s); }, true); }
    function recv(ns, pkt) {
      let s = pkt.to;
      const f = pkt.flags;
      if (s && s.dead) s = null;
      if (!s && f === 'S') {
        const ls = ns.listeners.get(pkt.dst.port), l = ls && ls.find((x) => x.laddr === '0.0.0.0' || x.laddr === pkt.dst.addr);
        if (!l) return rst(ns, pkt);
        if (l.acceptq.length + l.synq >= Math.max(1, l.backlog)) { if (tr()) k.tev('net', 'drop', { reason: 'backlog', dst: ep(pkt.dst.addr, pkt.dst.port) }); return; }
        const c = mkSock(ns, 'inet');
        c.laddr = pkt.dst.addr; c.lport = pkt.dst.port; c.raddr = pkt.src.addr; c.rport = pkt.src.port; c.parent = l; c.peer = pkt.from; c.bound = true;
        c.irs = pkt.seq; c.rcvNxt = pkt.seq + 1; c.iss = (ns.isn = (Math.imul(ns.isn, 1103515245) + 12345) >>> 0) >>> 1; c.sndNxt = c.iss;
        takePort(ns, c, c.lport); ns.conns.set(ep(c.laddr, c.lport) + '>' + ep(c.raddr, c.rport), c);
        l.synq++;
        setState(c, 'SYN_RECV');
        send(c, 'SA'); c.sndNxt++;
        return;
      }
      if (!s) return rst(ns, pkt);
      if (f[0] === 'R') {
        if (s.state === 'SYN_SENT') s.err = E.ECONNREFUSED; else { s.err = E.ECONNRESET; s.rcvEof = true; }
        if (s.parent && s.state === 'SYN_RECV') s.parent.synq--;
        const wq = [s.rwait, s.wwait, s.cwait];
        if (s.closed || s.state === 'SYN_RECV') destroy(s); else { setState(s, 'CLOSED'); s.reset = true; if (s.rport) ns.conns.delete(ep(s.laddr, s.lport) + '>' + ep(s.raddr, s.rport)); for (const q of wq) k.wake(q); }
        return;
      }
      if (f === 'SA') {
        if (s.state !== 'SYN_SENT') return;
        s.irs = pkt.seq; s.rcvNxt = pkt.seq + 1; s.peer = pkt.from;
        if (s.timer) { k.cancelTimer(s.timer); s.timer = null; }
        setState(s, 'ESTABLISHED');
        send(s, 'A');
        k.wake(s.cwait); k.wake(s.wwait);
        return;
      }
      // ACK の処理
      if (f.indexOf('A') >= 0) {
        if (s.state === 'SYN_RECV') { setState(s, 'ESTABLISHED'); const l = s.parent; if (l && !l.dead) { l.synq--; l.acceptq.push(s); k.wake(l.await); } } else if (s.state === 'FIN_WAIT1' && pkt.ack === s.sndNxt) setState(s, 'FIN_WAIT2');
        else if (s.state === 'CLOSING' && pkt.ack === s.sndNxt) timeWait(s);
        else if (s.state === 'LAST_ACK' && pkt.ack === s.sndNxt) { destroy(s); return; }
      }
      if (pkt.data.length) {
        if (s.closed || s.shutRd) { send(s, 'R', { seq: pkt.ack }); if (s.closed) destroy(s); return; }
        s.rcv += pkt.data; s.rcvNxt += pkt.data.length; s.pending -= pkt.data.length;
        send(s, 'A');
        k.wake(s.rwait);
      }
      if (f[0] === 'F') {
        s.rcvNxt++; s.rcvEof = true;
        send(s, 'A');
        if (s.state === 'ESTABLISHED') setState(s, 'CLOSE_WAIT'); else if (s.state === 'FIN_WAIT1') setState(s, 'CLOSING'); else if (s.state === 'FIN_WAIT2') timeWait(s);
        k.wake(s.rwait);
      }
    }
    function sendFin(s) {
      if (s.shutWr) return;
      s.shutWr = true;
      if (s.family === 'unix') { if (s.peer && !s.peer.dead) { s.peer.rcvEof = true; k.wake(s.peer.rwait); } return; }
      if (s.state === 'ESTABLISHED') setState(s, 'FIN_WAIT1'); else if (s.state === 'CLOSE_WAIT') setState(s, 'LAST_ACK'); else return;
      send(s, 'FA'); s.sndNxt++;
    }
    function close(s) {
      if (s.closed) return;
      s.closed = true;
      if (s.family === 'unix') {
        for (const c of s.acceptq) { c.closed = true; if (c.peer) { c.peer.rcvEof = true; c.peer.peerGone = true; k.wake(c.peer.rwait); } destroy(c); }
        if (s.peer && !s.peer.dead) { s.peer.rcvEof = true; s.peer.peerGone = true; k.wake(s.peer.rwait); k.wake(s.peer.wwait); }
        if (s.bindIno && s.bindIno.sock === s) s.bindIno.sock = null;
        destroy(s); return;
      }
      if (s.state === 'LISTEN') { for (const c of s.acceptq.splice(0)) { c.closed = true; send(c, 'RA'); destroy(c); } destroy(s); return; }
      if (s.state === 'CLOSED' || s.state === 'SYN_SENT') { destroy(s); return; }
      if (s.rcv.length) { send(s, 'RA'); destroy(s); return; }   // 読んでいないデータを残して閉じた：リセット
      sendFin(s);
    }
    net.close = close;

    // ── fd の読み書き ──
    function sockRead(p, s, ofd, n) {
      if (s.state === 'LISTEN') return -E.EINVAL;
      if (s.rcv.length) { const d = s.rcv.length <= n ? s.rcv : s.rcv.slice(0, n); s.rcv = s.rcv.length <= n ? '' : s.rcv.slice(n); if (s.peer) k.wake(s.peer.wwait); return d; }
      if (s.err && s.err !== E.EPIPE) { const e = s.err; s.err = 0; return -e; }
      if (s.rcvEof || s.shutRd) return '';
      if (s.state === 'CLOSED' && !s.reset) return -E.ENOTCONN;
      if (ofd.flags & O.NONBLOCK) return -E.EAGAIN;
      return k.block(p, s.rwait);
    }
    function sockWrite(p, s, ofd, data) {
      if (s.err) { const e = s.err; s.err = E.EPIPE; if (e === E.EPIPE) k.sendSig(p, SIG.PIPE, p); return -e; }
      if (s.shutWr || s.reset || s.peerGone) { k.sendSig(p, SIG.PIPE, p); return -E.EPIPE; }
      if (s.state !== 'ESTABLISHED' && s.state !== 'CLOSE_WAIT') return s.state === 'CLOSED' || s.state === 'LISTEN' ? -E.ENOTCONN : -E.EPIPE;
      const peer = s.peer;
      if (!peer || peer.dead) { k.sendSig(p, SIG.PIPE, p); return -E.EPIPE; }
      const space = RCVBUF - peer.rcv.length - peer.pending;
      if (space <= 0) { if (ofd.flags & O.NONBLOCK) return -E.EAGAIN; return k.block(p, s.wwait); }
      const n = Math.min(space, data.length, MSS), d = n === data.length ? data : data.slice(0, n);
      if (s.family === 'unix') { if (peer.shutRd) { k.sendSig(p, SIG.PIPE, p); return -E.EPIPE; } peer.rcv += d; k.wake(peer.rwait); return n; }
      peer.pending += n;
      send(s, 'PA', { data: d }); s.sndNxt += n;
      return n;
    }
    const ofdRead0 = k.ofdRead, ofdWrite0 = k.ofdWrite;
    k.ofdRead = function (p, ofd, n) { const s = ofd.inode.sock; return s && ofd.inode.type === 's' ? sockRead(p, s, ofd, n) : ofdRead0.call(this, p, ofd, n); };
    k.ofdWrite = function (p, ofd, data) { const s = ofd.inode.sock; return s && ofd.inode.type === 's' ? sockWrite(p, s, ofd, data) : ofdWrite0.call(this, p, ofd, data); };
    k.sockPoll = (p, ofd) => {
      const s = ofd.inode.sock; if (!s) return { r: true, w: true, err: true };
      if (s.state === 'LISTEN') return { r: s.acceptq.length > 0, w: false, rq: s.await };
      const conn = s.state === 'ESTABLISHED' || s.state === 'CLOSE_WAIT';
      return { r: s.rcv.length > 0 || s.rcvEof || !!s.err, w: conn && s.peer && RCVBUF - s.peer.rcv.length - s.peer.pending > 0, hup: (s.rcvEof && s.shutWr) || !!s.reset, err: !!s.err && s.err !== E.EPIPE, rq: s.rwait, wq: s.wwait };
    };
    k.on('release', (ofd) => { const i = ofd.inode; if (i.type === 's' && i.sock && i.fs === k.pipefs) { const s = i.sock; if (tr()) k.tev('net', 'sock', { op: 'close', pid: k.cur ? k.cur.pid : 0, fd: -1, sock: s.id, family: s.family, local: L(s), peer: R(s) }); close(s); } });

    // ── システムコール ──
    const sockOf = (p, fd) => { const e = p.fds[fd]; if (!e) return -E.EBADF; const s = e.ofd.inode.type === 's' ? e.ofd.inode.sock : null; return s || -E.ENOTSOCK; };
    const saStr = (a) => (!a ? 'NULL' : a.path !== undefined ? '{sa_family=AF_UNIX, sun_path=' + quote(String(a.path), 108) + '}' : '{sa_family=AF_INET, sin_port=htons(' + (a.port | 0) + '), sin_addr=inet_addr("' + (a.addr || '0.0.0.0') + '")}');
    const saLen = (a) => (!a ? 0 : a.path !== undefined ? String(a.path).length + 3 : 16);
    const install = (p, s, flags) => {
      const ino = k.newInode(k.pipefs, 's', 0o777, p.euid, p.egid);
      ino.sock = s; s.ino = ino;
      const ofd = k.openInode(p, ino, O.RDWR | (flags & O.NONBLOCK), 'socket:[' + ino.ino + ']');
      const fd = k.fdAlloc(p, ofd, 0, flags & O.CLOEXEC);
      if (fd < 0) { ofd.refs = 1; k.ofdPut(ofd); }
      return fd;
    };
    k.defsys('socket', (k2, p, a) => {
      const fam = famOf(a[0]);
      if (!fam) return -E.EAFNOSUPPORT;
      const type = a[1] === undefined || a[1] === 'stream' ? 1 : a[1] === 'dgram' ? 2 : a[1] | 0;
      if ((type & 0xf) !== 1) return (type & 0xf) === 2 ? -E.EPROTONOSUPPORT : -E.ESOCKTNOSUPPORT;
      const s = mkSock(nsOf(p), fam);
      const fd = install(p, s, (type & 0o4000 ? O.NONBLOCK : 0) | (type & 0o2000000 ? O.CLOEXEC : 0));
      if (fd >= 0) sev('socket', p, fd, s);
      return fd;
    }, (a) => (famOf(a[0]) === 'unix' ? 'AF_UNIX' : famOf(a[0]) === 'inet' ? 'AF_INET' : String(a[0])) + ', SOCK_STREAM, ' + (famOf(a[0]) === 'unix' ? '0' : a[2] === 6 ? 'IPPROTO_TCP' : 'IPPROTO_IP'));
    k.defsys('bind', (k2, p, a) => {
      const s = sockOf(p, a[0]); if (typeof s === 'number') return s;
      const ad = a[1] || {};
      if (s.bound) return -E.EINVAL;
      if (s.family === 'unix') {
        if (ad.path === undefined) return -E.EINVAL;
        const w = k.preCreate(p, String(ad.path)); if (typeof w === 'number') return w === -E.EEXIST ? -E.EADDRINUSE : w;
        const ino = k.newInode(w.parent.fs, 's', 0o777 & ~p.umask, p.euid, p.egid);
        k.dirAdd(w.parent, w.name, ino);
        ino.sock = s; s.bindIno = ino; s.path = k.fullPath(p, w); s.bound = true;
        k.ev('fs', { op: 'mknod', path: s.path, ino: ino.ino, pid: p.pid });
        sev('bind', p, a[0], s, { path: dec(s.path) });
        return 0;
      }
      const addr = ad.addr || '0.0.0.0', ns = s.ns;
      let port = ad.port | 0;
      if (!isIp(addr)) return -E.EINVAL;
      if (!isLocal(ns, addr)) return -E.EADDRNOTAVAIL;
      if (port < 0 || port > 65535) return -E.EINVAL;
      if (port && port < 1024 && p.euid !== 0) return -E.EACCES;
      if (port && portBusy(ns, s, addr, port)) return -E.EADDRINUSE;
      if (!port) { port = ephemeral(ns, s, addr); if (!port) return -E.EADDRINUSE; }
      s.laddr = addr; s.lport = port; s.bound = true; takePort(ns, s, port);
      sev('bind', p, a[0], s);
      return 0;
    }, (a) => a[0] + ', ' + saStr(a[1]) + ', ' + saLen(a[1]));
    k.defsys('listen', (k2, p, a) => {
      const s = sockOf(p, a[0]); if (typeof s === 'number') return s;
      if (s.state !== 'CLOSED' && s.state !== 'LISTEN') return -E.EINVAL;
      s.backlog = Math.max(0, Math.min(a[1] === undefined ? 128 : a[1] | 0, 4096));
      if (s.family === 'unix') { if (!s.bound) return -E.EINVAL; s.state = 'LISTEN'; sev('listen', p, a[0], s, { path: dec(s.path) }); return 0; }
      const ns = s.ns;
      if (!s.bound) { const port = ephemeral(ns, s, '0.0.0.0'); if (!port) return -E.EADDRINUSE; s.lport = port; s.bound = true; takePort(ns, s, port); }
      if (s.state !== 'LISTEN') { const l = ns.listeners.get(s.lport) || []; if (l.some((x) => x.laddr === s.laddr || x.laddr === '0.0.0.0' || s.laddr === '0.0.0.0')) return -E.EADDRINUSE; l.push(s); ns.listeners.set(s.lport, l); setState(s, 'LISTEN'); }
      sev('listen', p, a[0], s, { backlog: s.backlog });
      return 0;
    }, (a) => a[0] + ', ' + (a[1] === undefined ? 128 : a[1]));
    k.defsys('accept', (k2, p, a, req) => {
      const e = p.fds[a[0]], s = sockOf(p, a[0]); if (typeof s === 'number') return s;
      if (s.state !== 'LISTEN') return -E.EINVAL;
      const c = s.acceptq.shift();
      if (!c) { if (e.ofd.flags & O.NONBLOCK) return -E.EAGAIN; return k.block(p, s.await); }
      const fd = install(p, c, a[1] | 0);
      if (fd < 0) { close(c); return fd; }
      req.peer = c.family === 'unix' ? { path: '' } : { addr: c.raddr, port: c.rport };
      sev('accept', p, fd, c, { listener: s.id });
      return fd;
    }, (a, r, p, req) => a[0] + ', ' + (req.peer && req.peer.addr ? saStr(req.peer) + ', [16]' : req.peer ? '{sa_family=AF_UNIX}, [2]' : 'NULL, NULL'));
    k.defsys('connect', (k2, p, a, req) => {
      const e = p.fds[a[0]], s = sockOf(p, a[0]); if (typeof s === 'number') return s;
      const ad = a[1] || {};
      if (req.started) {
        if (s.err) { const er = s.err; s.err = 0; if (s.timer) { k.cancelTimer(s.timer); s.timer = null; } if (s.lport) { dropPort(s.ns, s); s.lport = 0; s.bound = false; s.laddr = '0.0.0.0'; } s.raddr = ''; s.rport = 0; s.reset = false; s.rcvEof = false; setState(s, 'CLOSED'); return -er; }
        if (s.state === 'ESTABLISHED' || s.state === 'CLOSE_WAIT') return 0;
        if (req.unreach) { if (req.done) { setState(s, 'CLOSED'); return -E.EHOSTUNREACH; } return k.block(p, s.cwait); }
        return k.block(p, s.cwait);
      }
      if (s.state === 'ESTABLISHED') return -E.EISCONN;
      if (s.state !== 'CLOSED') return s.state === 'SYN_SENT' ? -E.EALREADY : -E.EINVAL;
      if (s.family === 'unix') {
        if (ad.path === undefined) return -E.EINVAL;
        const i = k.namei(p, String(ad.path), true); if (typeof i === 'number') return i;
        if (i.type !== 's') return -E.ECONNREFUSED;
        if (!k.may(p, i, 2)) return -E.EACCES;
        const l = i.sock;
        if (!l || l.dead || l.state !== 'LISTEN') return -E.ECONNREFUSED;
        if (l.acceptq.length >= Math.max(1, l.backlog)) return -E.EAGAIN;
        const c = mkSock(l.ns, 'unix');
        c.path = l.path; c.state = s.state = 'ESTABLISHED'; c.peer = s; s.peer = c; c.parent = l;
        l.acceptq.push(c); k.wake(l.await);
        sev('connect', p, a[0], s, { path: dec(l.path) });
        return 0;
      }
      const ns = s.ns, addr = ad.addr || '', port = ad.port | 0;
      if (!isIp(addr) || !port) return -E.EINVAL;
      if (!isLocal(ns, addr)) {
        const eth = ns.ifaces.find((i) => i.name === 'eth0' && i.up);
        if (!eth || addr.split('.').slice(0, 3).join('.') !== eth.addr.split('.').slice(0, 3).join('.')) return -E.ENETUNREACH;
        req.started = true; req.unreach = true; setState(s, 'SYN_SENT');
        s.timer = k.timer(k.clock + 3000, () => { s.timer = null; req.done = true; k.wake(s.cwait); });
        return k.block(p, s.cwait);
      }
      if (!s.bound) { const lp = ephemeral(ns, s, addr); if (!lp) return -E.EADDRNOTAVAIL; s.laddr = srcFor(ns, addr); s.lport = lp; s.bound = true; takePort(ns, s, lp); } else if (s.laddr === '0.0.0.0') s.laddr = srcFor(ns, addr);
      s.raddr = addr === '0.0.0.0' ? '127.0.0.1' : addr; s.rport = port;
      s.iss = (ns.isn = (Math.imul(ns.isn, 1103515245) + 12345) >>> 0) >>> 1; s.sndNxt = s.iss; s.irs = 0; s.rcvNxt = 0;
      ns.conns.set(ep(s.laddr, s.lport) + '>' + ep(s.raddr, s.rport), s);
      setState(s, 'SYN_SENT');
      sev('connect', p, a[0], s);
      send(s, 'S', { to: null }); s.sndNxt++;
      // SYN が捨てられたとき（backlog が一杯）の送り直し：1・2・4 秒後。それでもだめなら ETIMEDOUT
      let tries = 0;
      const retry = () => { s.timer = null; if (s.state !== 'SYN_SENT' || s.dead) return; if (++tries > 3) { s.err = E.ETIMEDOUT; k.wake(s.cwait); return; } send(s, 'S', { to: null, seq: s.iss }); s.timer = k.timer(k.clock + 1000 * (1 << tries), retry); };
      s.timer = k.timer(k.clock + 1000, retry);
      req.started = true;
      if (e.ofd.flags & O.NONBLOCK) return -E.EINPROGRESS;
      return k.block(p, s.cwait);
    }, (a) => a[0] + ', ' + saStr(a[1]) + ', ' + saLen(a[1]));
    k.defsys('shutdown', (k2, p, a) => {
      const s = sockOf(p, a[0]); if (typeof s === 'number') return s;
      if (s.state === 'CLOSED' || s.state === 'LISTEN' || s.state === 'SYN_SENT') return -E.ENOTCONN;
      const how = a[1] | 0;
      if (how === 0 || how === 2) { s.shutRd = true; k.wake(s.rwait); }
      if (how === 1 || how === 2) sendFin(s);
      sev('shutdown', p, a[0], s, { how: ['SHUT_RD', 'SHUT_WR', 'SHUT_RDWR'][how] });
      return 0;
    }, (a) => a[0] + ', ' + (['SHUT_RD', 'SHUT_WR', 'SHUT_RDWR'][a[1] | 0] || a[1]));
    const retAddr = (r) => '0';
    k.defsys('getsockname', (k2, p, a) => { const s = sockOf(p, a[0]); if (typeof s === 'number') return s; return s.family === 'unix' ? { family: 'unix', path: s.path } : { family: 'inet', addr: s.laddr, port: s.lport }; }, (a, r) => a[0] + ', ' + (typeof r === 'object' ? saStr(r) + ', [' + saLen(r) + ']' : '0x7ffd3c2a1b40, [16]'), retAddr);
    k.defsys('getpeername', (k2, p, a) => { const s = sockOf(p, a[0]); if (typeof s === 'number') return s; if (!s.peer && !s.rport) return -E.ENOTCONN; return s.family === 'unix' ? { family: 'unix', path: (s.peer && s.peer.path) || '' } : { family: 'inet', addr: s.raddr, port: s.rport }; }, (a, r) => a[0] + ', ' + (typeof r === 'object' ? saStr(r) + ', [' + saLen(r) + ']' : '0x7ffd3c2a1b40, [16]'), retAddr);
    k.defsys('setsockopt', (k2, p, a) => { const s = sockOf(p, a[0]); if (typeof s === 'number') return s; if (a[1] === 'SO_REUSEADDR' || a[1] === 'SO_REUSEPORT') s.reuse = !!a[2]; return 0; }, (a) => a[0] + ', SOL_SOCKET, ' + a[1] + ', [' + (a[2] ? 1 : 0) + '], 4');
    k.defsys('getsockopt', (k2, p, a) => { const s = sockOf(p, a[0]); if (typeof s === 'number') return s; if (a[1] === 'SO_ERROR') { const e = s.err; s.err = 0; return e; } if (a[1] === 'SO_REUSEADDR') return s.reuse ? 1 : 0; return 0; }, (a, r) => a[0] + ', SOL_SOCKET, ' + a[1] + ', [' + (typeof r === 'number' && r >= 0 ? r : 0) + '], [4]', () => '0');
    // シミュレータ専用：ss / ip / tc が使う（本物は netlink）
    const users = (p, s, view) => { const out = []; if (!s.ino) return out; for (const q of k.procs.values()) { if (p.euid !== 0 && q.euid !== p.euid) continue; const vp = k.vpid(q, view); if (!vp) continue; q.fds.forEach((e, fd) => { if (e && e.ofd.inode === s.ino) out.push({ pid: vp, comm: q.comm, fd }); }); } return out; };
    net.dump = (p, ns) => Array.from(ns.socks).filter((s) => s.state !== 'CLOSED' || s.bound).sort((a, b) => a.id - b.id).map((s) => ({ id: s.id, family: s.family, state: s.state, laddr: s.laddr, lport: s.lport, raddr: s.raddr, rport: s.rport, path: s.path, recvQ: s.state === 'LISTEN' ? s.acceptq.length : s.rcv.length, sendQ: s.state === 'LISTEN' ? s.backlog : s.peer ? s.peer.pending | 0 : 0, backlog: s.backlog, ino: s.ino ? s.ino.ino : 0, peerIno: s.peer && s.peer.ino ? s.peer.ino.ino : 0, timer: s.timer && s.state === 'TIME_WAIT' ? s.timer.at - k.clock : 0, users: users(p, s, p.ns && p.ns.pid && p.ns.pid.level ? p.ns.pid : null) }));
    k.defsys('_net', (k2, p, a) => {
      const ns = nsOf(p);
      if (a[0] === 'socks') return net.dump(p, ns);
      if (a[0] === 'ifaces') return ns.ifaces.map((i) => Object.assign({}, i, { delay: i.name === 'lo' ? ns.delay : 0 }));
      if (a[0] === 'delay') { if (p.euid !== 0) return -E.EPERM; ns.delay = Math.max(0, Math.min(10000, a[1] | 0)); return 0; }
      if (a[0] === 'local') return isLocal(ns, String(a[1])) ? 1 : 0;
      return -E.EINVAL;
    });
    k.procfs.reg('sys/net/ipv4/ip_local_port_range', { read: () => '32768\t60999\n' });
    k.procfs.reg('sys/net/ipv4/tcp_fin_timeout', { read: () => '60\n' });
    k.procfs.reg('sys/net/core/somaxconn', { read: () => '4096\n' });
    if (!k.reused) {
      k.writeFile('/var/www/html/index.html', enc('<!DOCTYPE html>\n<html>\n<head><title>Zukai Linux</title></head>\n<body>\n<h1>It works!</h1>\n<p>図解 Linux の小さな Web サーバです。</p>\n</body>\n</html>\n'), 0o644, 0, 0, k.epoch - 86400000 * 3);
      k.writeFile('/var/www/html/hello.txt', 'Hello from httpd\n', 0o644, 0, 0, k.epoch - 86400000 * 3);
      for (const d of ['/var/www', '/var/www/html']) { const i = k.namei(k.kcred, d); i.mtime = i.ctime = i.atime = k.epoch - 86400000 * 3; }
    }
    return net;
  });

  sys.send = sys.write; sys.recv = sys.read;
  LNX.NET = NET;
  LNX.kernel.M.net = function () {
    const k = this.k, net = k.sub.net, ns = net.ns0;
    return { ifaces: ns.ifaces.map((i) => ({ name: i.name, addr: i.addr, prefix: i.prefix, mtu: i.mtu, state: i.state, mac: i.mac })), delay: ns.delay,
      sockets: net.dump(k.kcred, ns).map((s) => ({ id: s.id, family: s.family, state: s.state, local: s.family === 'unix' ? dec(s.path) : s.lport ? s.laddr + ':' + s.lport : '', peer: s.rport ? s.raddr + ':' + s.rport : '', recvQ: s.recvQ, backlog: s.backlog, queued: s.state === 'LISTEN' ? s.recvQ : 0, users: s.users.map((u) => ({ pid: u.pid, comm: dec(u.comm), fd: u.fd })), path: dec(s.path), timeWaitLeft: s.timer })) };
  };

  // ── 小さな libc：名前と番地、ポートと名前 ──
  function* hostsFile(c) { const d = yield* c.slurp('/etc/hosts'); const out = []; if (typeof d === 'string') for (const l of lines(d)) { const f = l.replace(/#.*/, '').trim().split(/\s+/); if (f.length >= 2 && isIp(f[0])) out.push({ addr: f[0], names: f.slice(1) }); } return out; }
  function* resolve(c, host) { if (isIp(host)) return host; for (const h of yield* hostsFile(c)) if (h.names.indexOf(host) >= 0) return h.addr; return null; }
  function* revName(c, addr) { for (const h of yield* hostsFile(c)) if (h.addr === addr) return h.names[0]; return null; }
  function* services(c) { const d = yield* c.slurp('/etc/services'); const out = []; if (typeof d === 'string') for (const l of lines(d)) { const f = l.replace(/#.*/, '').trim().split(/\s+/); const m = f[1] && /^(\d+)\/(\w+)$/.exec(f[1]); if (m) out.push({ name: f[0], port: +m[1], proto: m[2], aliases: f.slice(2) }); } return out; }
  function* portOf(c, s) { if (/^\d+$/.test(s)) return +s; const sv = (yield* services(c)).find((x) => x.proto === 'tcp' && (x.name === s || x.aliases.indexOf(s) >= 0)); return sv ? sv.port : -1; }
  LNX.net = { resolve, revName, services, portOf, isIp };

  // ── コマンド ──
  const LATE = { late: true };
  P('nc', 'TCP（や UNIX ドメインソケット）でつないで、標準入力を送り、受け取ったものを表示する。-l で待ち受ける', 'nc [-v] [-z] [-N] 相手 ポート    nc -l [-k] [-v] [-p] ポート    nc -U パス    nc -lU パス', function* (c) {
    const g = c.getopt('lp:vzkUNq:w:n46ud'); if (!g) return 1;
    const o = g.o, args = g.args.slice();
    const usage = () => { c.err('usage: nc [-46CDdFhklNnrStUuvZz] [-I length] [-i interval] [-M ttl]\n\t  [-m minttl] [-O length] [-P proxy_username] [-p source_port]\n\t  [-q seconds] [-s sourceaddr] [-T keyword] [-V rtable] [-W recvlimit]\n\t  [-w timeout] [-X proxy_protocol] [-x proxy_address[:port]]\n\t  [destination] [port]\n'); return 1; };
    if (o.u) { c.err('nc: UDP is not supported on this system\n'); return 1; }
    const pump = function* (fd, noStdin) {
      // 標準入力 → ソケット、ソケット → 標準出力を同時に行う。相手が閉じたら終わる
      let inOpen = !noStdin && !o.d, quitAt = -1;
      for (;;) {
        const fds = [{ fd, events: 'r' }]; if (inOpen) fds.push({ fd: 0, events: 'r' });
        let tmo = -1;
        if (quitAt >= 0) { tmo = Math.max(0, quitAt - (yield sys.time())); }
        const r = yield sys.poll(fds, tmo);
        if (r === -E.EINTR) continue;
        if (!Array.isArray(r)) return 1;
        if (!r.length) return 0;
        for (const f of r) {
          if (f.fd === fd) {
            const d = yield sys.read(fd, 4096);
            if (typeof d === 'number') { if (d === -E.EINTR || d === -E.EAGAIN) continue; return 1; }
            if (d === '') return 0;
            const w = yield* c.writeAll(1, d); if (w < 0) return 1;
          } else if (inOpen) {
            const d = yield sys.read(0, 4096);
            if (typeof d === 'number' && d === -E.EINTR) continue;
            if (typeof d !== 'string' || d === '') { inOpen = false; if (o.N) yield sys.shutdown(fd, 1); if (o.q !== undefined && +o.q >= 0) quitAt = (yield sys.time()) + (+o.q) * 1000; continue; }
            const w = yield* c.writeAll(fd, d); if (w < 0) return 1;
          }
        }
      }
    };
    if (o.l) {
      if (o.U) {
        if (args.length !== 1) return usage();
        const fd = yield sys.socket('unix', 'stream');
        const r = yield sys.bind(fd, { path: args[0] });
        if (r < 0) { c.err('nc: ' + strerror(r) + '\n'); return 1; }
        yield sys.listen(fd, 5);
        for (;;) { const cfd = yield sys.accept(fd); if (cfd === -E.EINTR) continue; if (cfd < 0) { c.err('nc: accept: ' + strerror(cfd) + '\n'); return 1; } yield* pump(cfd); yield sys.close(cfd); if (!o.k) break; }
        return 0;
      }
      let host = '0.0.0.0', ps = o.p;
      if (ps === undefined) { if (args.length === 2) { host = args[0]; ps = args[1]; } else if (args.length === 1) ps = args[0]; else return usage(); } else if (args.length === 1) host = args[0];
      const port = yield* portOf(c, ps), addr = yield* resolve(c, host);
      if (port < 0 || port > 65535) { c.err('nc: port number invalid: ' + ps + '\n'); return 1; }
      if (!addr) { c.err('nc: getaddrinfo: Name or service not known\n'); return 1; }
      const fd = yield sys.socket('inet', 'stream');
      yield sys.setsockopt(fd, 'SO_REUSEADDR', 1);
      const r = yield sys.bind(fd, { addr, port });
      if (r < 0) { c.err('nc: ' + strerror(r) + '\n'); return 1; }
      yield sys.listen(fd, 1);
      const me = yield sys.getsockname(fd);
      if (o.v) { c.err('Listening on ' + (host === '0.0.0.0' ? '0.0.0.0' : host) + ' ' + me.port + '\n'); yield* c.flush(); }
      for (;;) {
        const cfd = yield sys.accept(fd);
        if (cfd === -E.EINTR) continue;
        if (cfd < 0) { c.err('nc: accept: ' + strerror(cfd) + '\n'); return 1; }
        if (o.v) { const pa = yield sys.getpeername(cfd); const nm = o.n ? null : yield* revName(c, pa.addr); c.err('Connection received on ' + (nm || pa.addr) + ' ' + pa.port + '\n'); yield* c.flush(); }
        if (!o.k) yield sys.close(fd);
        yield* pump(cfd);
        yield sys.close(cfd);
        if (!o.k) break;
      }
      return 0;
    }
    if (o.U) {
      if (args.length !== 1) return usage();
      const fd = yield sys.socket('unix', 'stream');
      const r = yield sys.connect(fd, { path: args[0] });
      if (r < 0) { c.err('nc: unix connect failed: ' + strerror(r) + '\n'); if (o.v) c.err('nc: ' + args[0] + ': ' + strerror(r) + '\n'); return 1; }
      return yield* pump(fd);
    }
    if (args.length !== 2) return usage();
    const addr = yield* resolve(c, args[0]), port = yield* portOf(c, args[1]);
    if (!addr) { c.err('nc: getaddrinfo for host "' + args[0] + '" port ' + args[1] + ': Name or service not known\n'); return 1; }
    if (port < 0 || port > 65535) { c.err('nc: port number invalid: ' + args[1] + '\n'); return 1; }
    const fd = yield sys.socket('inet', 'stream');
    if (o.p !== undefined) { const r = yield sys.bind(fd, { addr: '0.0.0.0', port: +o.p }); if (r < 0) { c.err('nc: bind failed: ' + strerror(r) + '\n'); return 1; } }
    let r;
    for (;;) { r = yield sys.connect(fd, { addr, port }); if (r !== -E.EINTR) break; }
    if (r < 0) { if (o.v || !o.z) c.err('nc: connect to ' + args[0] + (args[0] !== addr ? ' (' + addr + ')' : '') + ' port ' + port + ' (tcp) failed: ' + strerror(r) + '\n'); return 1; }
    if (o.v) { const sv = (yield* services(c)).find((x) => x.port === port && x.proto === 'tcp'); c.err('Connection to ' + args[0] + (args[0] !== addr ? ' (' + addr + ')' : '') + ' ' + port + ' port [tcp/' + (sv ? sv.name : '*') + '] succeeded!\n'); yield* c.flush(); }
    if (o.z) { yield sys.close(fd); return 0; }
    return yield* pump(fd);
  }, LATE);

  P('ss', 'ソケットの一覧を表示する（-t TCP、-l 待ち受け中、-a 全部、-n 名前に直さない、-p 使っているプロセス、-x UNIX ドメイン）', 'ss [-t] [-l] [-a] [-n] [-p] [-x]   例：ss -tlnp、ss -tan', function* (c) {
    const g = c.getopt('tlanpxu4eHr'); if (!g) return 255;
    const o = g.o;
    const all = yield sys._net('socks');
    const sv = o.n ? [] : yield* services(c);
    const wantT = o.t || (!o.x && !o.u), wantX = o.x || (!o.t && !o.u);
    const stName = (s) => ({ ESTABLISHED: 'ESTAB', SYN_SENT: 'SYN-SENT', SYN_RECV: 'SYN-RECV', FIN_WAIT1: 'FIN-WAIT-1', FIN_WAIT2: 'FIN-WAIT-2', TIME_WAIT: 'TIME-WAIT', CLOSED: 'UNCONN', CLOSE_WAIT: 'CLOSE-WAIT', LAST_ACK: 'LAST-ACK', LISTEN: 'LISTEN', CLOSING: 'CLOSING' }[s] || s);
    const port = (n) => { if (!n) return '*'; const x = sv.find((y) => y.port === n && y.proto === 'tcp'); return x ? x.name : String(n); };
    const hostName = function* (a) { if (o.n || !o.r) return a; return (yield* revName(c, a)) || a; };
    const rows = [];
    const both = wantT && wantX && !o.t;
    for (const s of all) {
      if (s.family === 'inet' && !wantT) continue;
      if (s.family === 'unix' && !wantX) continue;
      const listening = s.state === 'LISTEN';
      if (o.l ? !listening : !o.a && (listening || s.state === 'CLOSED')) continue;
      const proc = o.p && s.users.length ? 'users:(' + s.users.map((u) => '("' + u.comm + '",pid=' + u.pid + ',fd=' + u.fd + ')').join(',') + ')' : '';
      let la, lp, ra, rp;
      if (s.family === 'unix') { la = s.path && s.state === 'LISTEN' ? s.path : s.path && !s.peerIno ? s.path : '*'; lp = String(s.ino); ra = '*'; rp = String(s.peerIno || 0); if (s.path && s.state !== 'LISTEN' && s.users.length === 0) la = s.path; } else { la = yield* hostName(s.laddr); lp = port(s.lport); ra = s.rport ? yield* hostName(s.raddr) : '0.0.0.0'; rp = s.rport ? port(s.rport) : '*'; }
      const row = [stName(s.state), String(s.recvQ), String(s.sendQ), la + (s.family === 'unix' ? ' ' : ':') + lp, ra + (s.family === 'unix' ? ' ' : ':') + rp, proc];
      if (both || (wantX && !wantT)) row.unshift(s.family === 'unix' ? 'u_str' : 'tcp');
      rows.push(row);
    }
    const netid = both || (wantX && !wantT);
    const head = (netid ? ['Netid'] : []).concat(['State', 'Recv-Q', 'Send-Q', 'Local Address:Port', 'Peer Address:Port', 'Process']);
    // iproute2 の列の幅：各列を中身の最大幅にそろえる（行末の空白も本物と同じに残す）。番地は右寄せ、ポートは左寄せ。
    // Process の列は -p のときだけあり、見出しの前には空白がない（本物の癖）
    const fmt = (rs) => {
      const ai = netid ? 4 : 3;
      const splitA = (v, ri, j) => { if (ri === 0 && !o.H) return j === 0 ? ['Local Address', 'Port'] : ['Peer Address', 'Port']; const i = v.lastIndexOf(netid && v.indexOf(' ') >= 0 && !/:[^ ]*$/.test(v) ? ' ' : ':'); return [v.slice(0, i), v.slice(i + 1)]; };
      const w = [];
      for (let i = 0; i < ai; i++) w[i] = Math.max(...rs.map((r) => r[i].length));
      const wa = [0, 0, 0, 0];
      rs.forEach((r, ri) => { for (let j = 0; j < 2; j++) { const [x, y] = splitA(r[ai + j], ri, j); wa[j * 2] = Math.max(wa[j * 2], x.length); wa[j * 2 + 1] = Math.max(wa[j * 2 + 1], y.length); } });
      const wp = o.p ? Math.max(...rs.map((r, ri) => (ri === 0 && !o.H ? 7 : r[ai + 2] ? r[ai + 2].length + 1 : 0))) : 0;
      return rs.map((r, ri) => {
        let l = '';
        for (let i = 0; i < ai; i++) l += r[i].padEnd(w[i]) + ' ';
        for (let j = 0; j < 2; j++) { const [x, y] = splitA(r[ai + j], ri, j); l += x.padStart(wa[j * 2]) + ':' + y.padEnd(wa[j * 2 + 1]) + (j === 0 ? ' ' : ''); }
        if (o.p) l += (ri === 0 && !o.H ? 'Process' : r[ai + 2] ? ' ' + r[ai + 2] : '').padEnd(wp);
        return l;
      }).join('\n') + '\n';
    };
    c.out(fmt((o.H ? [] : [head]).concat(rows)));
    return 0;
  }, LATE);

  const httpDate = (ms) => U.strftime('%a, %d %b %Y %H:%M:%S GMT', ms - 9 * 3600000);
  const MIME = { html: 'text/html', htm: 'text/html', txt: 'text/plain', css: 'text/css', js: 'text/javascript', json: 'application/json', png: 'image/png', csv: 'text/csv', sh: 'text/x-sh', md: 'text/markdown' };
  const REASON = { 200: 'OK', 301: 'Moved Permanently', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 501: 'Not Implemented' };
  P('httpd', '小さな Web サーバ。指定したディレクトリのファイルを HTTP で配る（既定はポート 8080、/var/www/html）', 'httpd [-p ポート] [-d ディレクトリ] [-b 番地] [-1]   例：httpd -p 8080 &', function* (c) {
    const g = c.getopt('p:d:b:1q'); if (!g) return 1;
    const port = g.o.p !== undefined ? +g.o.p : 8080, dir = (g.o.d || '/var/www/html').replace(/\/+$/, '') || '/', bindAddr = g.o.b || '0.0.0.0';
    if (!(port > 0 && port < 65536)) return c.fail('invalid port: ' + g.o.p);
    const st = yield sys.stat(dir);
    if (isErr(st)) return c.perr(dir, st);
    const fd = yield sys.socket('inet', 'stream');
    yield sys.setsockopt(fd, 'SO_REUSEADDR', 1);
    let r = yield sys.bind(fd, { addr: bindAddr, port });
    if (r < 0) { c.err('httpd: bind ' + bindAddr + ':' + port + ': ' + strerror(r) + '\n'); return 1; }
    r = yield sys.listen(fd, 16);
    if (r < 0) { c.err('httpd: listen: ' + strerror(r) + '\n'); return 1; }
    let stop = false;
    yield sys.sigaction(SIG.TERM, () => { stop = true; }, { restart: false });
    if (!g.o.q) { c.out('httpd: listening on ' + bindAddr + ':' + port + ', serving ' + dir + '\n'); yield* c.flush(); }
    while (!stop) {
      const cfd = yield sys.accept(fd);
      if (cfd < 0) { if (cfd === -E.EINTR) continue; c.err('httpd: accept: ' + strerror(cfd) + '\n'); return 1; }
      const peer = yield sys.getpeername(cfd);
      // リクエストのヘッダ（空行まで）を読む
      let req = '';
      for (;;) { const d = yield sys.read(cfd, 4096); if (typeof d !== 'string' || d === '') break; req += d; if (/\r?\n\r?\n/.test(req) || req.length > 65536) break; }
      const line = req.split(/\r?\n/)[0] || '', m = /^([A-Z]+) (\S+) (HTTP\/1\.[01])$/.exec(line);
      let code = 200, body = '', type = 'text/html', extra = '';
      if (!m) { code = 400; } else if (m[1] !== 'GET' && m[1] !== 'HEAD' && m[1] !== 'POST') code = 501;
      else {
        let path = m[2].replace(/[?#].*$/, '');
        try { path = decodeURIComponent(path); } catch (e) { code = 400; }
        path = U.normpath('/' + enc(path));
        if (code === 200) {
          let full = dir + (path === '/' ? '' : path), s2 = yield sys.stat(full || '/');
          if (!isErr(s2) && (s2.mode & 0o170000) === 0o040000) {
            if (!/\/$/.test(m[2].replace(/[?#].*$/, ''))) { code = 301; extra = 'Location: ' + path + '/\r\n'; } else {
              const ix = yield sys.stat(full + '/index.html');
              if (!isErr(ix)) { full += '/index.html'; s2 = ix; } else {
                const ents = yield* c.readDir(full || '/');
                if (isErr(ents)) code = 403; else { body = '<!DOCTYPE html>\n<html>\n<head><title>Index of ' + path + '</title></head>\n<body>\n<h1>Index of ' + path + '</h1>\n<ul>\n' + ents.map((e) => e.name).filter((n) => n !== '.' && n !== '..').sort().map((n) => '<li><a href="' + n + '">' + n + '</a></li>\n').join('') + '</ul>\n</body>\n</html>\n'; s2 = null; }
              }
            }
          }
          if (code === 200 && s2 !== null) {
            if (isErr(s2)) code = s2 === -E.EACCES ? 403 : 404;
            else { const d = yield* c.slurp(full); if (typeof d !== 'string') code = d === -E.EACCES ? 403 : 404; else { body = d; const ext = /\.([a-z0-9]+)$/i.exec(full); type = (ext && MIME[ext[1].toLowerCase()]) || 'application/octet-stream'; extra = 'Last-Modified: ' + httpDate(s2.mtime) + '\r\n'; } }
          }
        }
      }
      if (code !== 200) { body = code === 301 ? '' : '<!DOCTYPE html>\n<html>\n<head><title>' + code + ' ' + REASON[code] + '</title></head>\n<body>\n<h1>' + code + ' ' + REASON[code] + '</h1>\n</body>\n</html>\n'; type = 'text/html'; }
      const now = yield sys.time();
      const head = 'HTTP/1.0 ' + code + ' ' + REASON[code] + '\r\nServer: zukai-httpd/1.0\r\nDate: ' + httpDate(now) + '\r\nContent-Type: ' + type + (/^text\//.test(type) ? '; charset=utf-8' : '') + '\r\nContent-Length: ' + body.length + '\r\n' + extra + 'Connection: close\r\n\r\n';
      yield* c.writeAll(cfd, head + (m && m[1] === 'HEAD' ? '' : body));
      yield sys.close(cfd);
      if (!g.o.q) { c.out(peer.addr + ' - - [' + U.strftime('%d/%b/%Y:%H:%M:%S %z', now) + '] "' + line + '" ' + code + ' ' + (m && m[1] === 'HEAD' ? 0 : body.length) + '\n'); yield* c.flush(); }
      if (g.o['1']) break;
    }
    yield sys.close(fd);
    return 0;
  }, LATE);

  P('curl', 'URL（http:// だけ）にリクエストを送り、返ってきた本文を表示する', 'curl [-s] [-i] [-I] [-v] [-o ファイル] [-X メソッド] [-d データ] [-H ヘッダ] URL', function* (c) {
    const av = c.argv.slice(1);
    const o = { H: [] };
    let url = null;
    for (let i = 0; i < av.length; i++) {
      const a = av[i];
      if (a === '-o' || a === '--output') o.o = av[++i]; else if (a === '-X' || a === '--request') o.X = av[++i]; else if (a === '-d' || a === '--data') o.d = av[++i]; else if (a === '-H' || a === '--header') o.H.push(av[++i]);
      else if (a === '-m' || a === '--max-time' || a === '--connect-timeout' || a === '-A' || a === '-w') i++;
      else if (a === '--head') o.I = true; else if (a === '--include') o.i = true; else if (a === '--silent') o.s = true; else if (a === '--verbose') o.v = true; else if (a === '--fail') o.f = true; else if (a === '--show-error') o.S = true; else if (a === '--location') o.L = true;
      else if (a[0] === '-' && a.length > 1 && a[1] !== '-') { for (const f of a.slice(1)) { if ('sSiIvfLkO#'.indexOf(f) < 0) { c.err('curl: option -' + f + ': is unknown\ncurl: try \'curl --help\' for more information\n'); return 2; } o[f] = true; } } else if (a.slice(0, 2) === '--') { c.err('curl: option ' + a + ': is unknown\ncurl: try \'curl --help\' for more information\n'); return 2; } else url = a;
    }
    if (!url) { c.err("curl: (2) no URL specified\ncurl: try 'curl --help' or 'curl --manual' for more information\n"); return 2; }
    const m = /^(?:(\w+):\/\/)?([^\/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
    if (!m) { c.err('curl: (3) URL rejected: Malformed input to a URL function\n'); return 3; }
    if (m[1] && m[1] !== 'http') { c.err('curl: (1) Protocol "' + m[1] + '" not supported\n'); return 1; }
    const host = m[2], port = m[3] ? +m[3] : 80, path = m[4] || '/';
    const addr = yield* resolve(c, host);
    if (!addr) { c.err('curl: (6) Could not resolve host: ' + host + '\n'); return 6; }
    const v = function* (s) { if (o.v) { c.err(s); yield* c.flush(); } };
    yield* v('*   Trying ' + addr + ':' + port + '...\n');
    const fd = yield sys.socket('inet', 'stream');
    const t0 = yield sys.time();
    const r = yield sys.connect(fd, { addr, port });
    if (r < 0) {
      const ms = (yield sys.time()) - t0;
      yield* v('* connect to ' + addr + ' port ' + port + ' from 0.0.0.0 port 0 failed: ' + strerror(r) + '\n* Failed to connect to ' + host + ' port ' + port + ' after ' + ms + ' ms: Could not connect to server\n* closing connection #0\n');
      c.err('curl: (7) Failed to connect to ' + host + ' port ' + port + ' after ' + ms + ' ms: Could not connect to server\n'); return 7;
    }
    yield* v('* Connected to ' + host + ' (' + addr + ') port ' + port + '\n');
    const method = o.X || (o.I ? 'HEAD' : o.d !== undefined ? 'POST' : 'GET');
    let req = method + ' ' + path + ' HTTP/1.1\r\nHost: ' + host + (port === 80 ? '' : ':' + port) + '\r\nUser-Agent: curl/8.5.0\r\nAccept: */*\r\n';
    for (const h of o.H) req += h + '\r\n';
    if (o.d !== undefined) req += 'Content-Length: ' + o.d.length + '\r\nContent-Type: application/x-www-form-urlencoded\r\n';
    req += '\r\n';
    yield* v(req.split('\r\n').slice(0, -1).map((l) => '> ' + l + '\n').join(''));
    const w = yield* c.writeAll(fd, req + (o.d !== undefined ? o.d : ''));
    if (w < 0) { c.err('curl: (55) Send failure: ' + strerror(w) + '\n'); return 55; }
    let res = '';
    for (;;) { const d = yield sys.read(fd, 4096); if (typeof d === 'number') { if (d === -E.EINTR) continue; c.err('curl: (56) Recv failure: ' + strerror(d) + '\n'); return 56; } if (d === '') break; res += d; const hm = /\r?\n\r?\n/.exec(res); if (hm) { const cl = /^content-length:\s*(\d+)/im.exec(res.slice(0, hm.index)); if (method === 'HEAD' || (cl && res.length - hm.index - hm[0].length >= +cl[1])) break; } }
    yield sys.close(fd);
    if (res === '') { c.err('curl: (52) Empty reply from server\n'); return 52; }
    const hm = /\r?\n\r?\n/.exec(res), head = hm ? res.slice(0, hm.index) : res, body = hm ? res.slice(hm.index + hm[0].length) : '';
    const sm = /^HTTP\/1\.[01] (\d+)/.exec(head), code = sm ? +sm[1] : 0;
    yield* v((code && /^HTTP\/1\.0/.test(head) ? '* HTTP 1.0, assume close after body\n' : '') + head.split(/\r?\n/).map((l) => '< ' + l + '\n').join('') + '< \n');
    let out = '';
    if (o.i || o.I) out += head + '\r\n\r\n';
    if (!o.I) out += body;
    let rc = 0;
    if (o.f && code >= 400) { c.err('curl: (22) The requested URL returned error: ' + code + '\n'); rc = 22; out = ''; }
    if (o.o !== undefined && rc === 0) { const ofd = yield sys.open(o.o, O.WRONLY | O.CREAT | O.TRUNC, 0o666); if (ofd < 0) { c.err('curl: (23) Failure writing output to destination\n'); return 23; } yield* c.writeAll(ofd, out); yield sys.close(ofd); } else { c.out(out); }
    yield* c.flush();
    yield* v('* Closing connection\n');
    return rc;
  }, LATE);

  P('ip', 'ネットワークのインターフェースと番地、経路を表示する', 'ip [-br] [-4] addr | link | route   例：ip addr、ip -br a、ip route', function* (c) {
    const av = c.argv.slice(1);
    let br = false;
    while (av.length && av[0][0] === '-') { const a = av.shift(); if (a === '-br' || a === '-brief') br = true; else if (a === '-4' || a === '-c' || a === '-color' || a === '-o') { /* 無視 */ } else if (a === '-6') { return 0; } else { c.err('Option "' + a + '" is unknown, try "ip -help".\n'); return 255; } }
    const obj = av.shift() || '';
    const is = (s, full) => s !== '' && full.startsWith(s);
    const ifs = yield sys._net('ifaces');
    let dev = null;
    const rest = av.slice();
    if (rest[0] === 'show' || rest[0] === 'list' || rest[0] === 'ls') rest.shift();
    if (rest[0] === 'dev') rest.shift();
    if (rest.length) { dev = rest[0]; if (!ifs.some((i) => i.name === dev)) { c.err('Device "' + dev + '" does not exist.\n'); return 1; } }
    const sel = ifs.filter((i) => !dev || i.name === dev);
    if (is(obj, 'address')) {
      for (const i of sel) {
        if (br) { c.out(i.name.padEnd(16) + ' ' + i.state.padEnd(14) + ' ' + i.addr + '/' + i.prefix + ' \n'); continue; }
        c.out(i.index + ': ' + i.name + ': <' + i.flags + '> mtu ' + i.mtu + ' qdisc ' + (i.delay ? 'netem' : i.qdisc) + ' state ' + i.state + ' group default qlen 1000\n    link/' + i.link + ' ' + i.mac + ' brd ' + i.brd + '\n    inet ' + i.addr + '/' + i.prefix + (i.bcast ? ' brd ' + i.bcast : '') + ' scope ' + i.scope + ' ' + i.name + '\n       valid_lft forever preferred_lft forever\n');
      }
      return 0;
    }
    if (is(obj, 'link')) {
      for (const i of sel) {
        if (br) { c.out(i.name.padEnd(16) + ' ' + i.state.padEnd(14) + ' ' + i.mac + ' <' + i.flags + '> \n'); continue; }
        c.out(i.index + ': ' + i.name + ': <' + i.flags + '> mtu ' + i.mtu + ' qdisc ' + (i.delay ? 'netem' : i.qdisc) + ' state ' + i.state + ' mode DEFAULT group default qlen 1000\n    link/' + i.link + ' ' + i.mac + ' brd ' + i.brd + '\n');
      }
      return 0;
    }
    if (is(obj, 'route')) { for (const i of ifs) if (i.name !== 'lo') c.out(i.addr.split('.').slice(0, 3).join('.') + '.0/' + i.prefix + ' dev ' + i.name + ' proto kernel scope link src ' + i.addr + ' \n'); return 0; }
    if (obj === '' ) { c.err('Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\nwhere  OBJECT := { address | link | route }\n'); return 255; }
    c.err('Object "' + obj + '" is unknown, try "ip help".\n'); return 1;
  }, LATE);

  P('tc', 'ネットワークの遅延を設定する（この Linux では lo の netem delay だけ）', 'tc qdisc add dev lo root netem delay 100ms    tc qdisc del dev lo root    tc qdisc show', function* (c) {
    const av = c.argv.slice(1);
    if (av[0] !== 'qdisc' && av[0] !== 'q') { c.err('Usage:\ttc [ OPTIONS ] OBJECT { COMMAND | help }\nwhere  OBJECT := { qdisc }\n'); return 1; }
    const cmd = av[1] || 'show';
    const ifs = yield sys._net('ifaces');
    if (cmd === 'show' || cmd === 'ls' || cmd === 'list') { for (const i of ifs) { if (av[2] === 'dev' && av[3] !== i.name) continue; c.out(i.delay ? 'qdisc netem 8001: dev ' + i.name + ' root refcnt 2 limit 1000 delay ' + i.delay + 'ms\n' : 'qdisc ' + i.qdisc + ' 0: dev ' + i.name + ' root refcnt 2 \n'); } return 0; }
    if (av[2] !== 'dev' || av[3] !== 'lo') { c.err(av[2] === 'dev' && !ifs.some((i) => i.name === av[3]) ? 'Cannot find device "' + av[3] + '"\n' : enc('tc: この Linux で設定できるのは dev lo だけです\n')); return 1; }
    if (cmd === 'add' || cmd === 'change' || cmd === 'replace') {
      const di = av.indexOf('delay'), m = di >= 0 && /^(\d+(?:\.\d+)?)(ms|s|us)?$/.exec(av[di + 1] || '');
      if (av[4] !== 'root' || av[5] !== 'netem' || !m) { c.err(enc('tc: 使えるのは「tc qdisc add dev lo root netem delay 100ms」の形だけです\n')); return 1; }
      const ms = Math.round(+m[1] * ({ s: 1000, us: 0.001 }[m[2]] || 1));
      if (cmd === 'add' && ifs.find((i) => i.name === 'lo').delay) { c.err('Error: Exclusivity flag on, cannot modify.\n'); return 2; }
      const r = yield sys._net('delay', ms);
      if (r < 0) { c.err('RTNETLINK answers: Operation not permitted\n'); return 2; }
      return 0;
    }
    if (cmd === 'del' || cmd === 'delete') {
      if (!ifs.find((i) => i.name === 'lo').delay) { c.err('Error: Cannot delete qdisc with handle of zero.\n'); return 2; }
      const r = yield sys._net('delay', 0);
      if (r < 0) { c.err('RTNETLINK answers: Operation not permitted\n'); return 2; }
      return 0;
    }
    c.err('Command "' + cmd + '" is unknown, try "tc qdisc help".\n'); return 1;
  }, LATE);

  P('ping', '相手に届くかを確かめる（ICMP エコー）。この Linux では自分自身の番地にだけ届く', 'ping [-c 回数] [-i 間隔] 相手   例：ping -c 3 127.0.0.1', function* (c) {
    const g = c.getopt('c:i:W:w:nq'); if (!g) return 2;
    if (g.args.length !== 1) { c.err('ping: usage error: Destination address required\n'); return 2; }
    const host = g.args[0], addr = yield* resolve(c, host);
    if (!addr) { c.err('ping: ' + host + ': Name or service not known\n'); return 2; }
    const count = g.o.c !== undefined ? +g.o.c : 4, iv = g.o.i !== undefined ? Math.max(0.2, parseFloat(g.o.i)) : 1;
    const local = yield sys._net('local', addr);
    const ifs = yield sys._net('ifaces'), eth = ifs.find((i) => i.name === 'eth0');
    const onLink = eth && addr.split('.').slice(0, 3).join('.') === eth.addr.split('.').slice(0, 3).join('.');
    if (!local && !onLink) { c.err('ping: connect: Network is unreachable\n'); return 2; }
    const lo = ifs.find((i) => i.name === 'lo'), rtt = lo.delay * 2;
    c.out('PING ' + host + ' (' + addr + ') 56(84) bytes of data.\n'); yield* c.flush();
    let stop = false, sent = 0, got = 0;
    yield sys.sigaction(SIG.INT, () => { stop = true; }, { restart: false });
    const t0 = yield sys.time(), times = [];
    for (let i = 1; i <= count && !stop; i++) {
      sent++;
      if (local) {
        if (rtt) yield sys.nanosleep(rtt);
        const t = rtt + [0.031, 0.045, 0.038, 0.052, 0.041, 0.036][(i - 1) % 6];
        times.push(t); got++;
        c.out('64 bytes from ' + (host !== addr && !g.o.n ? host + ' (' + addr + ')' : addr) + ': icmp_seq=' + i + ' ttl=64 time=' + (t >= 100 ? t.toFixed(0) : t >= 10 ? t.toFixed(1) : t >= 1 ? t.toFixed(2) : t.toFixed(3)) + ' ms\n');
      } else if (i >= 3 && i % 3 === 0) { for (let j = i - 2; j <= i; j++) c.out('From ' + eth.addr + ' icmp_seq=' + j + ' Destination Host Unreachable\n'); }
      yield* c.flush();
      if (i < count && !stop) yield sys.nanosleep(iv * 1000);
    }
    const el = (yield sys.time()) - t0;
    c.out('\n--- ' + host + ' ping statistics ---\n' + sent + ' packets transmitted, ' + got + ' received, ' + (got < sent && !local ? '+' + Math.floor(sent / 3) * 3 + ' errors, ' : '') + Math.round((100 * (sent - got)) / Math.max(1, sent)) + '% packet loss, time ' + el + 'ms\n');
    if (got) { const mn = Math.min(...times), mx = Math.max(...times), av2 = times.reduce((s, x) => s + x, 0) / got, md = Math.sqrt(times.reduce((s, x) => s + (x - av2) * (x - av2), 0) / got); c.out('rtt min/avg/max/mdev = ' + [mn, av2, mx, md].map((x) => x.toFixed(3)).join('/') + ' ms\n'); }
    return got ? 0 : 1;
  }, LATE);

  P('getent', 'システムのデータベース（hosts、passwd、group、services）から項目を引く', 'getent hosts | passwd | group | services [キー]', function* (c) {
    const db = c.argv[1], key = c.argv[2];
    if (!db) { c.err('getent: wrong number of arguments\nTry `getent --help\' or `getent --usage\' for more information.\n'); return 1; }
    if (db === 'hosts') {
      const hs = yield* hostsFile(c);
      if (key === undefined) { for (const h of hs) c.out(h.addr.padEnd(15) + ' ' + h.names.join(' ') + '\n'); return 0; }
      const h = hs.find((x) => x.addr === key || x.names.indexOf(key) >= 0);
      if (!h) { if (isIp(key)) { c.out(key.padEnd(15) + ' ' + '\n'); return 0; } return 2; }
      c.out(h.addr.padEnd(15) + ' ' + h.names.join(' ') + '\n'); return 0;
    }
    if (db === 'services') { const sv = yield* services(c); const out = sv.filter((s) => key === undefined || s.name === key || String(s.port) === key || s.port + '/' + s.proto === key); for (const s of (key === undefined ? out : out.slice(0, 1))) c.out(s.name.padEnd(21) + ' ' + s.port + '/' + s.proto + (s.aliases.length ? ' ' + s.aliases.join(' ') : '') + '\n'); return out.length ? 0 : 2; }
    if (db === 'passwd' || db === 'group') {
      const d = yield* c.slurp('/etc/' + db); if (typeof d !== 'string') return 2;
      const ls = lines(d).filter((l) => { if (key === undefined) return true; const f = l.split(':'); return f[0] === key || f[2] === key; });
      for (const l of ls) c.out(l + '\n');
      return ls.length ? 0 : 2;
    }
    c.err('Unknown database: ' + db + '\nTry `getent --help\' or `getent --usage\' for more information.\n'); return 1;
  }, LATE);

  // hostname に -I（番地の一覧）などを足す
  const hostname0 = LNX.bin.hostname.main;
  LNX.bin.hostname.main = function* (c) {
    const a = c.argv[1];
    if (a === '-I' || a === '--all-ip-addresses') { const ifs = yield sys._net('ifaces'); c.out(ifs.filter((i) => i.name !== 'lo').map((i) => i.addr + ' ').join('') + '\n'); return 0; }
    if (a === '-i' || a === '--ip-address') { const n = (yield sys.uname()).nodename, ad = yield* resolve(c, n); if (!ad) { c.err('hostname: Name or service not known\n'); return 1; } c.out(ad + '\n'); return 0; }
    if (a === '-s' || a === '--short') { c.out((yield sys.uname()).nodename.split('.')[0] + '\n'); return 0; }
    if (a === '-f' || a === '--fqdn') { const n = (yield sys.uname()).nodename, hs = yield* hostsFile(c), h = hs.find((x) => x.names.indexOf(n) >= 0); c.out(((h && h.names.find((x) => x.indexOf('.') >= 0)) || n) + '\n'); return 0; }
    return yield* hostname0(c);
  };
  LNX.bin.hostname.usage = 'hostname [-I] [-i] [-f] [新しい名前]';
  Object.assign(LNX.SYSJA, { socket: 'ソケットを作る', bind: 'ソケットに番地（ポート）をつける', listen: '接続を待ち受ける', accept: '接続を受け入れる', connect: '接続する', shutdown: '接続の片側を閉じる', getsockname: '自分側の番地', getpeername: '相手側の番地', setsockopt: 'ソケットの設定を変える', getsockopt: 'ソケットの設定を調べる' });
  void BLOCK;
})(typeof window !== 'undefined' ? window : globalThis);
