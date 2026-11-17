// 図解 Linux の中心部品：ブラウザで動く教育用の小さな Linux（カーネルのシミュレータ）。DOM を使わない。
// ブラウザでは <script> で window.LNX、Node では import すると globalThis.LNX ができる。
//
// ■ 読み込み順（この順。どれも LNX に足していく。一覧は src/lib/lnx-files.mjs の LNX_FILES）
//   kernel.js   カーネル（時間、VFS、プロセス、シグナル、パイプ、システムコール、strace）と、機械の API（LNX.boot）
//   shell.js    シェル sh（LNX.bin.sh、LNX.sh）
//   bin.js      コマンド（ファイル操作、権限、テキスト処理）
//   bin-sys.js  コマンド（プロセス、システムの観察、init、help、練習用の spin / zombie / orphan / sigwait）
//   rootfs.js   最初のファイル一式（/etc、/home/you の練習用ファイル、/usr/bin …）と procfs（LNX.rootfs）
//   ── 第 2 段階の部品（rootfs.js の後に、この順で読み込む。くわしい説明・events の形式・本物との違いは、それぞれのファイルの先頭コメント）──
//   sched.js      スケジューラ（14 章）：CFS 風（vruntime、nice の重み）、setpriority / getpriority、nice、renice、burn、sys.sched()
//   mm.js         仮想メモリ（13 章）：アドレス空間、ページ表、デマンドページング、コピーオンライト、brk / mmap / munmap / mprotect、OOM killer、
//                 /proc/PID/maps、meminfo、memtouch、memfork、memhog、mmapcat、pmap、/usr/bin/time、sys.mem() / sys.vm(pid) / sys.frames()
//   pagecache.js  ページキャッシュと遅いディスク（15 章）：hit / miss、ダーティページ、書き戻し、drop_caches、電源断、dd、fincore、sys.pagecache() / sys.powerCut()
//   net.js        ネットワーク（16 章）：TCP（ループバック）と UNIX ドメインソケット、socket / bind / listen / accept / connect / shutdown …、
//                 nc、ss、curl、httpd、ip、ping、tc、getent、hostname -I、sys.net()
//   ns.js         名前空間・cgroups・chroot（19 章）：unshare / setns / chroot、/sys/fs/cgroup、/srv/rootfs、chroot、unshare、nsenter、lsns、busybox、
//                 sys.cgroups() / sys.namespaces()
//   init.js       起動と init（17 章）：dmesg、systemd 風の PID 1（unit、Restart=、ジャーナル）、systemctl、journalctl、reboot / poweroff / shutdown、
//                 sys.dmesg() / sys.bootlog() / sys.units() / sys.journal()
//   bin-adv.js    コマンド：awk（簡易版）、paste、pgrep、pkill、nohup、setsid、truncate
//   Node：const { LNX_FILES } = await import('../src/lib/lnx-files.mjs');  for (const f of LNX_FILES) await import(dir + f);  const LNX = globalThis.LNX;
//
// ═════════════════════════════ 機械の API ═════════════════════════════
//
//   const sys = LNX.boot({ seed: 1, user: 'you', hostname: 'zukai', maxTicks: 200000, maxTime: 3600000, maxOutput: 262144, diskBlocks: 16384, maxProcs: 256 })
//     起動済みの機械を返す（PID 1 = init、PID 2 = user のログインシェル。cwd は /home/you）。引数はどれも省略できる。
//     時刻は 2026-04-01 09:00:00 JST から。1 tick = 1 ミリ秒の仮想時間。乱数は seed で決まる。同じ操作の列は、必ず同じ結果・同じ tick になる。
//
// ■ 実行
//   const r = sys.run(cmd, opts)      ログインシェルで cmd（複数行でもよい）を実行して、終わるまで進める。
//     同じ機械を使い続ける（cd、変数、関数、alias、バックグラウンドのジョブは次の run に持ち越す）。ユーザーごとに別のシェル。
//     opts.user     'root' などを指定すると、そのユーザーのログインシェルで実行する（最初に使ったときに作る）
//     opts.strace   true = 実行したコマンド（execve 以降）のシステムコールを記録、'all' = シェル自身のもの（fork、dup2、wait4 …）も記録
//     opts.stdin    端末から入力したことにする文字列（指定しなければ、端末を読むコマンドはすぐ EOF を受け取る）
//     opts.keys     [{ at: 500, key: '^C' }]  実行開始から at ミリ秒（仮想時間）後にキーを押す。'^C' = SIGINT、'^Z' = SIGTSTP、'^\\' = SIGQUIT、
//                   '^D' = EOF、それ以外の文字列は端末への入力
//     opts.maxTicks 使ってよい CPU 時間（tick）の上限。opts.maxTime は仮想時間（待ちも含む）の上限、opts.maxOutput は出力のバイト数の上限
//     opts.xtrace   true なら set -x と同じ（実行する行を + つきで stderr に出す）
//     opts.trace    'mem' | 'sched' | 'pagecache' | 'net'（複数なら 'mem,sched' か配列、'all' で全部）。その種類の観察用イベントを r.events に足す
//                   （各イベントに cat: 種類 がつく。最大 8000 個で、ふつうのイベントの上限 4000 個とは別に数える。形式は各部品のファイルの先頭コメント）
//     r = {
//       stdout, stderr,        文字列（UTF-8 として解釈したもの）
//       out,                   [{ s: 'out' | 'err', text }]  端末に出た順（表示用。stdout と stderr が混ざった順番のまま）
//       exit,                  最後のコマンドの終了ステータス（$?）
//       ticks,                 進んだ仮想時間（ミリ秒。sleep の待ちも含む）
//       steps,                 使った CPU 時間（tick。システムコール 1 回 = 1 tick）
//       reason,                'exit'（ふつうに終わった）'logout'（シェルが exit した。新しいログインシェルを作り直す）
//                              'limit'（maxTicks で打ち切り）'output'（出力が多すぎ）'timeout'（maxTime）'blocked'（だれも進めなくなった）
//                              'reboot' / 'poweroff'（コマンドが機械を再起動した・電源を切った。どちらも新しく起動し直してある。logout も true。init.js）
//       cut,                   打ち切ったら true。message に日本語の 1 文。打ち切ると前景のプロセスを SIGKILL して、シェルはプロンプトに戻る（exit は 130）
//       trace,                 opts.strace のとき [{ pid, name, text, line }]（最大 4000 行）。text は 'openat(AT_FDCWD, "/etc/hostname", O_RDONLY) = 3' の形、
//                              line は複数のプロセスが出てきた後は '[pid 12] ' が頭につく（strace -f と同じ）
//       traceText,             line を改行でつないだもの
//       events,                [{ t, type, … }]  起きたことの列（画面の「システムを見る」用。最大 4000 個）
//                              type: 'fork' { pid, ppid, comm } / 'exec' { pid, path, argv } / 'exit' { pid, status, code, sig } / 'reap' { pid, by } /
//                                    'reparent' { pid, ppid } / 'signal' { pid, sig, name, from } / 'stop' { pid, sig } / 'open' { pid, fd, path, ino } /
//                                    'close' { pid, fd } / 'dup' { pid, from, fd } / 'pipe' { pid, r, w, id } / 'chdir' { pid, path } /
//                                    'fs' { op: 'create'|'mkdir'|'rmdir'|'unlink'|'link'|'symlink'|'rename'|'chmod'|'chown'|'mknod', path, ino, pid } / 'mount' / 'umount'
//       logout,                シェルが終わって作り直したら true
//     }
//   少しずつ進める（実験場の端末用。出力を途中で表示し、Ctrl-C や入力を受けつける）
//     const h = sys.start(cmd, opts)      opts.interactive: true なら、端末を読むコマンドは入力が来るまで待つ
//     const r = h.step(100)               仮想時間で最大 100 ミリ秒ぶん進める。終わったら run と同じ結果、まだなら null。
//                                         h.waiting === 'input' なら端末の入力待ち。h.sleeping が true なら全員がタイマー待ち（sleep 中）なので、
//                                         画面は実時間に合わせて間を置くとよい（そうでなければ、すぐ次の step を呼んでよい）
//     h.take()                            前回の take から後に端末へ出た分 [{ s, text }]（終わった後に呼べば、最後の step で出た残りを返す）
//     sys.interrupt('INT')                前景のプロセスグループにシグナルを送る（Ctrl-C）。'TSTP' なら Ctrl-Z
//     sys.input('text\n') / sys.eof()     端末への入力 / Ctrl-D
//     h.done, h.result                    終わったか、その結果。前のコマンドが終わる前に run / start すると例外
//   sys.advance(ms)                       コマンドなしで仮想時間だけ進める（バックグラウンドのジョブが動く）。その間に端末へ出た分を返す：
//                                         { out: [{ s, text, user }], stdout, stderr }
//
// ■ 同じ状態からやり直す（採点用）
//   sys.clone()                 同じ状態の別の機械（独立）。中身は「起動して、これまでの操作を再生」なので、履歴が長いほど時間がかかる（30 コマンドで約 2 ms）
//   const s = sys.snapshot()    いまの状態（= 起動の設定と操作の記録。JSON にできる）
//   sys.restore(s)              その状態に戻す。別の機械に渡してもよい
//   sys.reset()                 起動直後に戻す
//
// ■ 観察（機械の状態は変えない。どれも「いま」の値）
//   sys.ps()            [{ pid, ppid, pgid, sid, state: 'R'|'S'|'D'（ディスク待ち）|'T'|'Z', uid, euid, gid, user, comm, args: [..], cmdline, cwd, tty, utime, stime, start, nice,
//                          nfd, exit（ゾンビなら wait の status）, stopped, waiting（待っているシステムコールの名前。なければ null）, session（ログインシェルか）}]
//   sys.fdTable(pid)    [{ fd, ofd（open file description の番号。同じなら共有）, path, flags: 'O_WRONLY|O_CREAT', access: 'r'|'w'|'rw', pos, refs, cloexec,
//                          inode: { ino, dev, fs, type, mode, modeStr, nlink, size, opens }, pipe: { id, buffered, cap, readers, writers, end } | null }]  なければ null
//                          名前のないパイプの pipe.id は、path の 'pipe:[番号]'（inode 番号）と同じ。名前つきパイプ（FIFO）は 100001 から
//   sys.inode(path, nofollow)   { path, ino, dev, fs: 'ext4'…, type: 'f'|'d'|'l'|'c'|'p', mode, modeStr: '-rw-r--r--', octal: '0644', uid, gid, user, group, nlink, size,
//                          blocks: [ブロック番号…], atime, mtime, ctime（ミリ秒）, opens, changed, target（リンク）, rdev, entries: [{ name, ino, type }]（ディレクトリ）}  なければ null
//   sys.tree(path, { depth, max, synth })   { name, path, ino, type, modeStr, nlink, user, size, changed（直前の run で変わった）, target, mount, children: [...] }
//                          /proc の中は synth: true を渡したときだけ入る
//   sys.mounts()        [{ source, target, type, opts, blocks, used, inodes }]
//   sys.cwd(user) / sys.prompt(user)   '/home/you' / 'you@zukai:~$ '
//   sys.users()         /etc/passwd の中身 [{ name, uid, gid, gecos, home, shell }]
//   sys.time()          { ticks, steps, now（ミリ秒の時刻）, date: '2026-04-01 09:00:00', load: [1 分, 5 分, 15 分] }
//   sys.complete(line, user)   Tab 補完 { start, word, candidates: [...] }（行の最後の単語について。最初の単語ならコマンド名、それ以外はパス）
//   sys.kernel          カーネルの本体（下の「部品を足す」用。画面からは使わない）
//
// ■ ファイルの出し入れ
//   sys.fs.read(path)            ファイルの中身（文字列）。なければ null
//   sys.fs.exists(path)
//   sys.fs.write(path, text, { mode: 0o644, user: 'you' })   ファイルを置く（途中のディレクトリも作る）
//   sys.fs.export('/home/you')   そのディレクトリ以下を、JSON にできる形で取り出す（実験場の IndexedDB 保存用）
//   sys.fs.import(data)          export したものを戻す（そのディレクトリを空にしてから置く）
//
// ■ そのほか
//   LNX.sh.parse(src)   → { ok, incomplete, error }   構文だけ調べる。incomplete なら「続きの行が要る」（if の途中、閉じていない引用符）
//   LNX.sh.builtins     組み込みコマンドの名前
//   LNX.bin             { 名前: { main, help: '1 行の説明', usage: '使い方' } }   /usr/bin に置かれるコマンド（help コマンドと同じ文）
//   LNX.ERRNO { ENOENT: 2, … } / LNX.ERRMSG { 2: 'No such file or directory' } / LNX.ERRJA { ENOENT: '日本語の説明' } / LNX.strerror(n)
//   LNX.SIG { INT: 2, … } / LNX.SIGNAME[2] = 'INT' / LNX.SIGDESC[2] = 'Interrupt' / LNX.SIGJA { INT: '日本語の説明' } / LNX.sigDefault(n) → 'term'|'core'|'ign'|'stop'|'cont'
//   LNX.SYSJA { openat: '日本語の説明', … }   システムコールの一覧（この段階で ENOSYS のものも含む）
//
// ═════════════════════════════ 機械の中身（章を書く人向け）═════════════════════════════
//
// ■ ユーザー：root(0)、you(1000。sudo・staff・users グループ)、alice(1001。staff・users)、bob(1002。users)。su と sudo はパスワードを聞かない。
// ■ ファイルシステム：/ は ext4 風（/dev/sda1、64 MiB、ブロック 4 KiB、inode にブロック番号の一覧）、/proc（procfs）、/dev（devtmpfs）、/tmp（tmpfs 8 MiB）。
//   /bin → usr/bin。/home/you に memo.txt（日本語）fruits.txt poem.txt scores.csv numbers.txt hello.sh notes/{todo,ideas}.txt .profile。
//   /home/alice に diary.txt（600）public.txt shared.txt（664、staff）。/home/bob は 750。/var/log に syslog auth.log access.log。
// ■ システムコール（本物と同じ名前。エラーは負の errno）：clone(fork) execve exit_group wait4 getpid getppid getuid geteuid getgid getegid getgroups
//   getpgid setpgid getsid setsid setuid setgid setgroups kill rt_sigaction rt_sigprocmask pause openat read write close lseek dup dup2 fcntl pipe
//   stat lstat fstat access getdents64 mkdir rmdir unlink link symlink readlink rename chmod fchmod chown lchown umask truncate ftruncate utimensat mknod
//   chdir fchdir getcwd mount umount2 statfs nanosleep sched_yield fsync sync ioctl uname sethostname clock_gettime getrandom ptrace(TRACEME だけ)。
//   poll(fds, タイムアウト) times getrusage。第 2 段階の部品が足すもの：brk mmap munmap mprotect mincore（mm / pagecache）、setpriority getpriority（sched）、
//   socket bind listen accept connect shutdown getsockname getpeername setsockopt getsockopt（net）、unshare setns chroot（ns）、reboot（init）。
//   pivot_root だけ ENOSYS のまま。
// ■ シグナル：1〜31。ハンドラ、無視、マスク、保留。SIGKILL と SIGSTOP は捕まえられない。終了時は親に SIGCHLD。ゾンビは親が wait4 するまで残り、
//   親が先に終われば PID 1 が引き取って回収する。読み手のいないパイプに書くと SIGPIPE。パイプの容量は 64 KiB（一杯なら書き手が待つ）。
// ■ スケジューラ：CPU は 1 つ。システムコール 1 回 = 1 tick。だれも走れないときは、次のタイマーまで時間が飛ぶ。
//   kernel.js だけならラウンドロビン（タイムスライス 10 tick）、sched.js を読み込むと CFS 風（nice の重みつき）になる。
// ■ シェル：sh は POSIX sh + bash の一部（local、${x/a/b}、${x:1:2}、<<<、&>、$'…'、{a,b} と {1..3}、function、予約語 time、set -e、sh -n）。
//   対応していないもの：配列、[[ ]]、(( ))、select、coproc、プロセス置換。セッションのシェルで exit すると logout になり、新しいログインシェルに替わる。
// ■ 本物との違い（主なもの）：スレッドがない。fork は「子で実行する関数」を渡す形（下）。stdout は端末でも行バッファにせず、4096 バイトたまるか終了時に書く。
//   時間はコマンドを実行している間だけ進む。/proc/PID/schedstat は独自の形式。ほかは、このコメントの最後の「本物との違い」。
//
// ═════════════════════════════ ユーザー空間のプログラムの書き方 ═════════════════════════════
//
//   LNX.bin.hello = { help: '挨拶する', usage: 'hello [名前]', main: function* (c) {
//     const fd = yield LNX.sys.open('/etc/hostname', LNX.O.RDONLY);        // システムコールは yield する。エラーは負の数（-LNX.ERRNO.ENOENT など）
//     if (fd < 0) return c.perr('/etc/hostname', fd);                      // 「hello: /etc/hostname: No such file or directory」を stderr に出して 1 を返す
//     const data = yield LNX.sys.read(fd, 4096);                           // 読んだバイト列（文字列。1 文字 = 1 バイト）。EOF は ''
//     yield LNX.sys.close(fd);
//     c.out('hello, ' + (c.argv[1] || 'world') + ' from ' + data);         // stdout にためる（終了時か yield* c.flush() で write される）
//     return 0;                                                            // 終了ステータス
//   } };
//   boot より前に登録すれば /usr/bin/hello として置かれる（{ sbin: true } なら /usr/sbin、{ suid: true } なら setuid root）。
//   機械の中の文字列はすべて「バイト列」（UTF-8 の 1 バイトを 1 文字で持つ）。日本語を出すときは LNX.util.enc('日本語')、読むときは LNX.util.dec(bytes)。
//   c（LNX.Ctx）：c.argv、c.env、c.name、c.out(s)、c.err(s)、yield* c.put(s)（4096 バイトたまったら書く）、yield* c.flush()、c.fail(msg)、c.perr(what, errno)、
//     yield* c.slurp(path)（全体を読む。'-' は標準入力。エラーは負の数）、yield* c.cat(path)（エラー文も出して null）、yield* c.readAll(fd)、c.reader(fd).line()、
//     c.getopt('ab:c', { '--long': 'a' })（{ o, args } か null）、yield* c.passwd() / c.group() / c.uname(uid) / c.gname(gid)、
//     yield* c.which(name)、yield* c.spawn(argv, env)（fork + execve + wait4 して終了ステータス）、yield* c.readDir(path)、yield* c.isatty(fd)
//   fork：const pid = yield LNX.sys.fork(function* (c2) { …子の中身…; return 終了ステータス; });   JavaScript のジェネレータは複製できないので、
//     「fork が 0 を返した側」の処理を関数で渡す。子は親の fd 表・cwd・環境などの複製を持つ。子の中で execve すれば、ふつうの fork + exec になる。
//   戻り値が数でないシステムコール：read → 文字列、pipe → [読む fd, 書く fd]、stat 系 → { dev, ino, mode, nlink, uid, gid, rdev, size, blksize, blocks, atime, mtime, ctime }、
//     getdents → [{ ino, name, type }]（1 回目に全部、2 回目は []）、wait4 → { pid, status }（WNOHANG でいなければ 0）、getcwd / readlink → 文字列、
//     getgroups → [gid…]、uname → { sysname, nodename, release, version, machine }、clock_gettime → ミリ秒、statfs → { type, bsize, blocks, bfree, bavail, files, ffree }
//   sigaction：yield LNX.sys.sigaction(LNX.SIG.USR1, (sig) => { … }, { restart: false })。ハンドラは関数（ジェネレータ関数なら中でシステムコールを呼べる）。
//     'SIG_IGN' / 'SIG_DFL' も渡せる。restart: false なら、待っていたシステムコールは -EINTR で戻る（既定は read / write / wait4 をやり直す）。
//   CPU を使う（システムコールなしの計算）：yield LNX.sys.cpu(100)   100 tick ぶん CPU を使う（途中で切り替えが起きる）
//
// ═════════════════════════════ 部品を足す（次の段階の担当向け）═════════════════════════════
//
//   LNX.kernel.plugin('mm', (k) => { …; return 状態; })   起動のたびに呼ばれる（rootfs と procfs を作った後、PID 1 を作る前）。戻り値は k.sub.mm に入る。
//     clone / snapshot は「起動して操作を再生」なので、部品の状態を保存・複製するコードは要らない（決定的でさえあればよい。Math.random と Date は使わない。乱数は k.rand()）。
//   LNX.kernel.syscall('mmap', fn(k, p, a, req), fmt(a, r, p, req), ret(r))   システムコールを足す・ENOSYS のものを差し替える。LNX.sys.mmap(...) もできる。
//     ★ plugin の中（機械ごとの状態を使う実装）では、代わりに k.defsys('mmap', fn, fmt, ret) を使う。実装が機械ごとの表（k.sc）に入るので、
//       複数の機械（clone など）が同時にあっても混ざらない。すでにあるシステムコールを包むのは k.wrapsys('getpid', (orig, k, p, a, req) => …)。
//     遅い装置を待たせる：k.delay(p, ms)（いまのシステムコールが終わった後、p を状態 D で ms だけ眠らせる。起動中は何もしない）。
//     観察用のイベント：k.tev(種類, type, { … })（run の opts.trace で選ばれた種類だけ記録される。作る前に k.tracing(種類) で調べると無駄がない）。
//     カーネルのログ：k.printk(文, レベル)（dmesg に出る）。裏方のタイマー：k.timer(時刻, fn, true)（これしか残っていなければ「することがない」とみなす）。
//     ファイルシステムごとの操作：fs.ops = { mkdir(k, p, 親, 名前, inode), rmdir(k, p, inode) }（あると、mkdir / rmdir 以外の作成・削除は EPERM。cgroup2）。
//     中身をそのつど作るファイル：inode.dyn = { read(k, p), write(k, p, data) }。
//     fn は結果（負の errno か値）を返す。待つときは return k.block(p, 待ち行列の配列)（起こすのは k.wake(待ち行列)。起きたら fn がもう一度呼ばれる。
//     req は呼び出しごとのオブジェクトなので、途中の状態は req に置く）。fmt は strace の引数の文字列、ret は戻り値の文字列（省略すると数）。
//   フック k.on(名前, fn)：
//     'boot'(k)  'fork'(parent, child, flags)  'exec'(p)  'exit'(p, status)  'reap'(p)  'state'(p, old, new)  'switch'(p)（p に CPU を渡す直前）
//     'canFork'(p) → 負の errno を返すと fork が失敗する（cgroup の pids.max 用）
//     'truncate'(inode)  'inodeFree'(inode)  'release'(ofd)  'fsync'(inode, p)  'sync'(p)
//   どこに足すか：
//     mm（13 章）       プロセスごとの p.mm を 'fork'（コピーオンライト）・'exec'（作り直し）・'exit'（解放）で管理。brk / mmap / munmap を syscall で差し替え。
//                       /proc/PID/maps は k.procfs.pidFiles.maps = (p) => ({ read: () => 文字列 })、/proc/meminfo は k.procfs.reg('meminfo', { read })、
//                       ps の VSZ / RSS は pidFiles.stat の 23・24 番目（バイトとページ数）。OOM は k.sendSig(p, LNX.SIG.KILL, null)。
//     sched（14 章）    k.sched を差し替える：{ name, enqueue(p), dequeue(p), pick() → p | null（待ち行列から外して返す）, quantum(p) → tick 数, account(p, 使った tick), nr() }。
//                       p.nice は fork で引き継ぐ。setpriority / getpriority を syscall で。切り替えの記録は 'switch' フックか account で取る。負荷平均は k.load。
//     pagecache（15 章）通常ファイルの読み書きは必ず k.fileRead(inode, pos, n, p) と k.fileWrite(inode, pos, data, p) を通る（この 2 つを差し替える。
//                       inode.data が「ディスクの中身」）。'fsync' 'sync' 'truncate' 'inodeFree' フック、時間で起きる書き戻しは k.timer(k.clock + ms, fn)。
//     net（16 章）      socket などを syscall で。ソケットの inode は k.newInode(k.pipefs, 's', 0o777, uid, gid) で作り、k.openInode(p, inode, flags, 'socket:[..]') と
//                       k.fdAlloc(p, ofd) で fd にする。読み書きは k.ofdRead / k.ofdWrite の type 's' の分岐を足す（いまは EINVAL）。閉じたときは 'release' フック。
//     ns（19 章）       プロセスは p.ns = { uts: { hostname }, mnt: { list, covered }, pid: { level } } を持ち、fork で同じものを指す（k.ns0 が最初の名前空間）。
//                       パスの解決は p.root と p.ns.mnt だけを見るので、chroot は p.root を変える、マウント名前空間は p.ns.mnt を複製する、で動く。
//                       hostname は p.ns.uts。PID 名前空間は、/proc の一覧（k.procfs.tree.list / get）と getpid 系・kill の見え方を差し替える。孤児の引き取り先は k.reaper(p)。
//     init（17 章）     LNX.bin.init.main を差し替える（/etc/init を読んでサービスを fork + execve する）。いまの init は wait4 で孤児を回収するだけ。
//     /proc と /sys     k.procfs.reg('sys/vm/drop_caches', { read(k, p), write(k, p, data) })。/sys は k.mkSynth('sysfs', 'sysfs') で作って
//                       k.doMount(k.ns0, fs, k.namei(k.kcred, '/sys'), '/sys') でマウントする（節の形は procfs と同じ：{ type: 'f', read, write } / { type: 'd', kids, list, get } / { type: 'l', target }）。
//     デバイス          k.devs.set('メジャー:マイナー', { read(k, p, ofd, n), write(k, p, ofd, data), ioctl }) と k.mkDev('/dev/名前', メジャー, マイナー, 0o666)。
//     ファイルシステム  k.fstypes.名前 = (k, source, data, p) => fs（mount -t 名前 で使える）。fs は k.mkfs(種類, source, { blocks, mode })。
//   カーネルの主なデータ：k.procs（Map pid → p）、k.clock（tick）、k.now()（ミリ秒の時刻）、k.rand()、k.timer(at, fn)、k.ev(type, obj)（events に出す）。
//     p = { pid, ppid, pgid, sid, state, uid, euid, gid, egid, groups, cwd, root, umask, fds: [{ ofd, cloexec }], sig: { pending, mask, act }, comm, argv, env, exe,
//           children, tty, ns, nice, utime, stime, start, … }。ofd = { id, inode, pos, flags, refs, path }。
//     inode = { ino, fs, type, mode, uid, gid, nlink, size, atime, mtime, ctime, blocks, opens, data（通常ファイルとリンク）, ents（ディレクトリ：Map 名前 → inode）, pipe, rdev }。
//
// ═════════════════════════════ 本物の Linux との違い（付録の材料）═════════════════════════════
//
// ■ 全体
//   ・カーネルは JavaScript のシミュレータ。機械語は実行しない。プログラムは JavaScript のジェネレータで、システムコールごとに 1 tick（1 ms）進む（本物はずっと速い）。
//   ・CPU は 1 つ。スレッド、プリエンプションの細かい規則、割り込み、カーネルスレッド（kthreadd、kworker …）はない。時間はコマンドを実行している間だけ進む。
//   ・fork は「子で実行する関数」を渡す形。execve で読み込むのは /usr/bin の「ELF 風の印」だけ（動的リンクはしない）。
//   ・ロケールは C を基準にする（エラー文の引用符は '…'、並び順はバイト順）。ただしファイル名の日本語はそのまま表示する。
// ■ 仮想メモリ（mm.js）
//   ・物理メモリは 64 MiB 固定。スワップ、ページの回収の細かい方針（LRU の 2 リスト、kswapd）、巨大ページ、NUMA はない。
//   ・番地は毎回同じ（ASLR なし）。text / rodata / data / heap / libc / vdso / stack の 9 領域だけ（本物の cat は 20 前後）。VSZ・RSS は本物より 1 桁小さい。
//   ・読むだけのページフォルトでも、匿名ページにはフレームを割り当てる（本物は共有のゼロページを写す）。ページフォルトは時間を使わない（major だけディスクを待つ）。
//   ・「メモリに触る」のは sys.touch / wtouch / peek / poke（本物では機械語のロード・ストア命令）。プログラムの変数はページに載っていない。
//   ・overcommit は「1 回の要求が物理メモリ全体より大きければ断る」だけ。OOM killer は RSS 最大のプロセスを選ぶ（oom_score_adj は加味）。殺されるのは即時。
// ■ スケジューラ（sched.js）
//   ・CFS の簡略版（周期 24 tick、最小 3 tick、赤黒木ではなく線形探索）。起床時のプリエンプション、グループスケジューリング（cpu.weight）、
//     リアルタイムのクラス（SCHED_FIFO / RR）、CPU アフィニティ、EEVDF（6.6 以降の本物）はない。load average は 5 秒ごとの指数移動平均で、D 状態も数える（本物と同じ）。
// ■ ページキャッシュ（pagecache.js）
//   ・ディスクは「1 ページ 5 ms、順番に 1 つずつ」。先読み、I/O スケジューラ、バッファキャッシュ（Buffers はいつも 0）はない。
//   ・書き戻しはファイル単位で、終わるまで原子的（途中で電源が切れれば、そのファイルの今回の分は全部失われる）。メタデータ（作成・削除・名前・切り詰め）はすぐ書かれる扱い。
//   ・起動時に /usr/bin・/usr/sbin・/usr/lib は読み込み済みとする。tmpfs のページは物理フレームを消費しない（meminfo の数字にだけ出る）。
//   ・sed -i は本物のように「別のファイルに書いて rename」ではなく、同じ inode を書き換える。
// ■ ネットワーク（net.js）
//   ・IPv4 の TCP（自分あてだけ）と UNIX ドメインの stream だけ。UDP、IPv6、ICMP（ping は表示だけ）、ARP、ルーティング、DNS、ファイアウォールはない。
//   ・TCP は状態遷移と番号だけ：再送（SYN の送り直しを除く）、ウィンドウ、輻輳制御、MSS、Nagle、keepalive、パケットの喪失はない。パケットは 1 回の write が 1 個。
//   ・ポートの自動割り当ては 32768 から順（本物はランダム）。ss の Send-Q は「相手にまだ届いていないバイト数」。
// ■ 名前空間・cgroups（ns.js）
//   ・ユーザー名前空間、pivot_root、マウントの伝播（shared / private）、capabilities、seccomp、overlayfs はない。unshare は root だけ。
//   ・cgroup v2 は pids と memory（匿名ページだけ課金）だけ。subtree_control の委譲は要らない（いつも有効）。CPU・I/O の制限、freezer はない。
//   ・名前空間の PID 1 へのシグナルの保護は kill システムコールだけ（端末からの Ctrl-C は届く）。/proc/mounts の道は chroot しても元のまま。
// ■ 起動と init（init.js）
//   ・ファームウェア、ブートローダ、initramfs は「ログの行」としてだけある（実際には動かない）。PID 1 は systemd そのものではなく、unit ファイルの一部
//     （ExecStart、Restart、RestartSec、User、WorkingDirectory、Environment、Type、WantedBy）だけを読む小さな init。target は multi-user.target だけ、依存関係（After= など）は読まない。
//   ・systemctl と init の通信は D-Bus ではなく、UNIX ドメインソケットに 1 行のテキスト。ジャーナルはバイナリではなくテキストのファイル。
//   ・再起動しても時刻は 2 秒進むだけ。電源を切った（poweroff）後も、次のコマンドのためにすぐ起動し直す。
(function (root) {
  'use strict';

  // ════════════════════════ 定数 ════════════════════════
  const ERRNO = {
    EPERM: 1, ENOENT: 2, ESRCH: 3, EINTR: 4, EIO: 5, ENXIO: 6, E2BIG: 7, ENOEXEC: 8, EBADF: 9, ECHILD: 10,
    EAGAIN: 11, ENOMEM: 12, EACCES: 13, EFAULT: 14, EBUSY: 16, EEXIST: 17, EXDEV: 18, ENODEV: 19, ENOTDIR: 20,
    EISDIR: 21, EINVAL: 22, ENFILE: 23, EMFILE: 24, ENOTTY: 25, ETXTBSY: 26, EFBIG: 27, ENOSPC: 28, ESPIPE: 29,
    EROFS: 30, EMLINK: 31, EPIPE: 32, EDOM: 33, ERANGE: 34, EDEADLK: 35, ENAMETOOLONG: 36, ENOSYS: 38,
    ENOTEMPTY: 39, ELOOP: 40, ENOTSOCK: 88, EPROTONOSUPPORT: 93, EOPNOTSUPP: 95, EAFNOSUPPORT: 97,
    EADDRINUSE: 98, EADDRNOTAVAIL: 99, ENETUNREACH: 101, ECONNABORTED: 103, ECONNRESET: 104, EISCONN: 106,
    ENOTCONN: 107, ETIMEDOUT: 110, ECONNREFUSED: 111,
  };
  const ERRMSG = {
    1: 'Operation not permitted', 2: 'No such file or directory', 3: 'No such process', 4: 'Interrupted system call',
    5: 'Input/output error', 6: 'No such device or address', 7: 'Argument list too long', 8: 'Exec format error',
    9: 'Bad file descriptor', 10: 'No child processes', 11: 'Resource temporarily unavailable', 12: 'Cannot allocate memory',
    13: 'Permission denied', 14: 'Bad address', 16: 'Device or resource busy', 17: 'File exists',
    18: 'Invalid cross-device link', 19: 'No such device', 20: 'Not a directory', 21: 'Is a directory',
    22: 'Invalid argument', 23: 'Too many open files in system', 24: 'Too many open files',
    25: 'Inappropriate ioctl for device', 26: 'Text file busy', 27: 'File too large', 28: 'No space left on device',
    29: 'Illegal seek', 30: 'Read-only file system', 31: 'Too many links', 32: 'Broken pipe',
    33: 'Numerical argument out of domain', 34: 'Numerical result out of range', 35: 'Resource deadlock avoided',
    36: 'File name too long', 38: 'Function not implemented', 39: 'Directory not empty',
    40: 'Too many levels of symbolic links', 88: 'Socket operation on non-socket', 93: 'Protocol not supported',
    95: 'Operation not supported', 97: 'Address family not supported by protocol', 98: 'Address already in use',
    99: 'Cannot assign requested address', 101: 'Network is unreachable', 103: 'Software caused connection abort',
    104: 'Connection reset by peer', 106: 'Transport endpoint is already connected',
    107: 'Transport endpoint is not connected', 110: 'Connection timed out', 111: 'Connection refused',
  };
  const ENAME = {};
  for (const n in ERRNO) ENAME[ERRNO[n]] = n;
  const E = ERRNO;
  const strerror = (e) => ERRMSG[Math.abs(e)] || 'Unknown error ' + Math.abs(e);
  const isErr = (r) => typeof r === 'number' && r < 0;

  const SIG = {
    HUP: 1, INT: 2, QUIT: 3, ILL: 4, TRAP: 5, ABRT: 6, BUS: 7, FPE: 8, KILL: 9, USR1: 10, SEGV: 11, USR2: 12,
    PIPE: 13, ALRM: 14, TERM: 15, STKFLT: 16, CHLD: 17, CONT: 18, STOP: 19, TSTP: 20, TTIN: 21, TTOU: 22,
    URG: 23, XCPU: 24, XFSZ: 25, VTALRM: 26, PROF: 27, WINCH: 28, IO: 29, PWR: 30, SYS: 31,
  };
  const SIGNAME = [];
  for (const n in SIG) SIGNAME[SIG[n]] = n;
  const SIGDESC = [
    '', 'Hangup', 'Interrupt', 'Quit', 'Illegal instruction', 'Trace/breakpoint trap', 'Aborted', 'Bus error',
    'Floating point exception', 'Killed', 'User defined signal 1', 'Segmentation fault', 'User defined signal 2',
    'Broken pipe', 'Alarm clock', 'Terminated', 'Stack fault', 'Child exited', 'Continued', 'Stopped (signal)',
    'Stopped', 'Stopped (tty input)', 'Stopped (tty output)', 'Urgent I/O condition', 'CPU time limit exceeded',
    'File size limit exceeded', 'Virtual timer expired', 'Profiling timer expired', 'Window changed', 'I/O possible',
    'Power failure', 'Bad system call',
  ];
  const sigDefault = (s) => (s === 17 || s === 23 || s === 28 ? 'ign' : s >= 19 && s <= 22 ? 'stop' : s === 18 ? 'cont'
    : [3, 4, 5, 6, 7, 8, 11, 24, 25, 31].includes(s) ? 'core' : 'term');
  const UNBLOCKABLE = (1 << 9) | (1 << 19);

  const O = {
    RDONLY: 0, WRONLY: 1, RDWR: 2, ACCMODE: 3, CREAT: 0o100, EXCL: 0o200, NOCTTY: 0o400, TRUNC: 0o1000,
    APPEND: 0o2000, NONBLOCK: 0o4000, DIRECTORY: 0o200000, NOFOLLOW: 0o400000, CLOEXEC: 0o2000000,
  };
  const S = { IFMT: 0o170000, IFSOCK: 0o140000, IFLNK: 0o120000, IFREG: 0o100000, IFBLK: 0o060000, IFDIR: 0o040000, IFCHR: 0o020000, IFIFO: 0o010000 };
  const TYPEBITS = { f: S.IFREG, d: S.IFDIR, l: S.IFLNK, c: S.IFCHR, b: S.IFBLK, p: S.IFIFO, s: S.IFSOCK };
  const BITSTYPE = {};
  for (const t in TYPEBITS) BITSTYPE[TYPEBITS[t]] = t;
  const W = { NOHANG: 1, UNTRACED: 2, CONTINUED: 8 };
  const F = { DUPFD: 0, GETFD: 1, SETFD: 2, GETFL: 3, SETFL: 4, DUPFD_CLOEXEC: 1030 };
  const AT_FDCWD = -100;
  const TIO = { TCGETS: 0x5401, TIOCGPGRP: 0x540f, TIOCSPGRP: 0x5410, TIOCGWINSZ: 0x5413 };
  const BLOCK = { block: true };
  const PIPE_CAP = 65536, PIPE_BUF = 4096, BS = 4096;

  // ════════════════════════ 文字列（バイト列）════════════════════════
  // 機械の中では、文字列はすべて「1 文字 = 1 バイト」のバイト列（UTF-8 を 0〜255 の文字で持つ）。外との境目で enc / dec する。
  const HI = /[^\x00-\x7f]/;
  const TE = new TextEncoder(), TD = new TextDecoder('utf-8');
  function enc(s) {
    s = String(s);
    if (!HI.test(s)) return s;
    const u = TE.encode(s);
    let o = '';
    for (let i = 0; i < u.length; i += 8192) o += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
    return o;
  }
  function dec(b) {
    if (!HI.test(b)) return b;
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return TD.decode(u);
  }

  // ════════════════════════ 小道具 ════════════════════════
  const basename = (p) => { const s = p.replace(/\/+$/, ''); if (s === '') return p ? '/' : ''; return s.slice(s.lastIndexOf('/') + 1); };
  const dirname = (p) => { const s = p.replace(/\/+$/, ''); const i = s.lastIndexOf('/'); if (i < 0) return '.'; const d = s.slice(0, i).replace(/\/+$/, ''); return d === '' ? '/' : d; };
  function normpath(p) {
    const abs = p[0] === '/', out = [];
    for (const c of p.split('/')) {
      if (c === '' || c === '.') continue;
      if (c === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); } else out.push(c);
    }
    return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
  }
  function modeStr(type, mode) {
    const t = { f: '-', d: 'd', l: 'l', c: 'c', b: 'b', p: 'p', s: 's' }[type] || '?';
    const b = (n, c) => (mode & n ? c : '-');
    let u = b(0o400, 'r') + b(0o200, 'w') + (mode & 0o4000 ? (mode & 0o100 ? 's' : 'S') : b(0o100, 'x'));
    let g = b(0o040, 'r') + b(0o020, 'w') + (mode & 0o2000 ? (mode & 0o010 ? 's' : 'S') : b(0o010, 'x'));
    let o = b(0o004, 'r') + b(0o002, 'w') + (mode & 0o1000 ? (mode & 0o001 ? 't' : 'T') : b(0o001, 'x'));
    return t + u + g + o;
  }
  const oct = (n, w) => n.toString(8).padStart(w || 0, '0');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const TZ = { name: 'JST', off: 9 * 3600 };
  function tm(ms) {
    const d = new Date(ms + TZ.off * 1000);
    const y = d.getUTCFullYear();
    return { Y: y, M: d.getUTCMonth(), D: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(), wd: d.getUTCDay(), yday: Math.floor((Date.UTC(y, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(y, 0, 1)) / 86400000) };
  }
  const p2 = (n) => String(n).padStart(2, '0');
  // /etc/shadow のパスワードのハッシュ（本物の yescrypt「$y$j9T$塩$ハッシュ」と同じ形。中身は教育用の簡単な関数で、暗号としては使えない）
  const B64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  function crypt(pw, salt) {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ salt.length, out = '';
    const src = salt + '$' + pw;
    for (let r = 0; r < 64; r++) for (let i = 0; i < src.length; i++) { h1 = Math.imul(h1 ^ src.charCodeAt(i), 16777619) >>> 0; h2 = Math.imul(h2 + h1 + r, 2246822519) >>> 0; }
    for (let i = 0; i < 43; i++) { h1 = Math.imul(h1 ^ (h2 >>> 7), 16777619) >>> 0; h2 = Math.imul(h2 ^ h1, 2654435761) >>> 0; out += B64[(h1 ^ h2) & 63]; }
    return '$y$j9T$' + salt + '$' + out;
  }
  const saltOf = (name) => crypt(name, 'salt').slice(-22);
  function strftime(fmt, ms) {
    const t = tm(ms);
    return fmt.replace(/%([-_0]?)([a-zA-Z%+])/g, (m, fl, c) => {
      const n2 = (n, w) => (fl === '-' ? String(n) : String(n).padStart(w || 2, fl === '_' ? ' ' : '0'));
      switch (c) {
        case 'Y': return String(t.Y); case 'y': return p2(t.Y % 100); case 'C': return p2(Math.floor(t.Y / 100));
        case 'm': return n2(t.M + 1); case 'd': return n2(t.D); case 'e': return fl === '-' ? String(t.D) : String(t.D).padStart(2, ' ');
        case 'H': return n2(t.h); case 'I': return n2(t.h % 12 || 12); case 'M': return n2(t.m); case 'S': return n2(t.s);
        case 'p': return t.h < 12 ? 'AM' : 'PM'; case 'N': return String(t.ms).padStart(3, '0') + '000000';
        case 'a': return WDAY[t.wd]; case 'A': return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][t.wd];
        case 'b': case 'h': return MON[t.M]; case 'B': return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][t.M];
        case 'j': return n2(t.yday + 1, 3); case 'u': return String(t.wd || 7); case 'w': return String(t.wd);
        case 'Z': return TZ.name; case 'z': return '+0900'; case 's': return String(Math.floor(ms / 1000));
        case 'F': return t.Y + '-' + p2(t.M + 1) + '-' + p2(t.D); case 'T': return p2(t.h) + ':' + p2(t.m) + ':' + p2(t.s);
        case 'R': return p2(t.h) + ':' + p2(t.m); case 'D': return p2(t.M + 1) + '/' + p2(t.D) + '/' + p2(t.Y % 100);
        case 'c': return WDAY[t.wd] + ' ' + MON[t.M] + ' ' + String(t.D).padStart(2, ' ') + ' ' + p2(t.h) + ':' + p2(t.m) + ':' + p2(t.s) + ' ' + t.Y;
        case 'n': return '\n'; case 't': return '\t'; case '%': return '%';
        case 'x': return p2(t.M + 1) + '/' + p2(t.D) + '/' + p2(t.Y % 100); case 'X': return p2(t.h) + ':' + p2(t.m) + ':' + p2(t.s);
        case 'r': return p2(t.h % 12 || 12) + ':' + p2(t.m) + ':' + p2(t.s) + ' ' + (t.h < 12 ? 'AM' : 'PM');
        case 'k': return String(t.h).padStart(2, ' '); case 'l': return String(t.h % 12 || 12).padStart(2, ' '); case 'P': return t.h < 12 ? 'am' : 'pm';
        default: return m;
      }
    });
  }
  // strace 風の文字列（32 バイトで切る）
  function quote(s, max) {
    max = max === undefined ? 32 : max;
    const cut = s.length > max;
    if (cut) s = s.slice(0, max);
    let o = '"';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 10) o += '\\n'; else if (c === 9) o += '\\t'; else if (c === 13) o += '\\r'; else if (c === 34) o += '\\"'; else if (c === 92) o += '\\\\';
      else if (c >= 32 && c < 127) o += s[i];
      else { const nx = s.charCodeAt(i + 1); o += '\\' + (nx >= 48 && nx <= 57 ? oct(c, 3) : oct(c)); }
    }
    return o + '"' + (cut ? '...' : '');
  }

  // ════════════════════════ ユーザー空間：システムコールの呼び出し口と小さな libc ════════════════════════
  const sys = {};
  const SYSCALL_NAMES = ['clone', 'execve', 'exit_group', 'wait4', 'getpid', 'getppid', 'getuid', 'geteuid', 'getgid', 'getegid', 'getgroups',
    'getpgid', 'setpgid', 'getsid', 'setsid', 'setuid', 'setgid', 'setgroups', 'kill', 'rt_sigaction', 'rt_sigprocmask', 'pause',
    'openat', 'read', 'write', 'close', 'lseek', 'dup', 'dup2', 'fcntl', 'pipe', 'stat', 'lstat', 'fstat', 'access', 'getdents64',
    'mkdir', 'rmdir', 'unlink', 'link', 'symlink', 'readlink', 'rename', 'chmod', 'fchmod', 'chown', 'lchown', 'umask', 'truncate', 'ftruncate',
    'utimensat', 'mknod', 'chdir', 'fchdir', 'getcwd', 'mount', 'umount2', 'statfs', 'nanosleep', 'sched_yield', 'fsync', 'sync', 'ioctl',
    'uname', 'sethostname', 'clock_gettime', 'getrandom', 'ptrace',
    'brk', 'mmap', 'munmap', 'mprotect', 'setpriority', 'getpriority', 'socket', 'bind', 'listen', 'accept', 'connect', 'shutdown',
    'getsockname', 'getpeername', 'unshare', 'setns', 'chroot', 'pivot_root', 'reboot', 'poll', 'times', 'getrusage', 'prlimit64', '_prompt', '_cpu', '_samefile'];
  for (const n of SYSCALL_NAMES) sys[n] = (...a) => ({ n, a });
  // 本物の libc と同じ「いつもの名前」
  sys.fork = (fn) => ({ n: 'clone', a: [fn, 0] });
  sys.exit = (code) => ({ n: 'exit_group', a: [code] });
  sys.open = (path, flags, mode) => ({ n: 'openat', a: [AT_FDCWD, path, flags | 0, mode] });
  sys.sigaction = sys.rt_sigaction;
  sys.sigprocmask = sys.rt_sigprocmask;
  sys.getdents = sys.getdents64;
  sys.umount = (t) => ({ n: 'umount2', a: [t, 0] });
  sys.cpu = (n) => ({ n: '_cpu', a: [n] });
  sys.time = () => ({ n: 'clock_gettime', a: [] });
  sys.waitpid = (pid, opt) => ({ n: 'wait4', a: [pid, opt | 0] });

  function Ctx(argv, env) {
    this.argv = argv; this.env = env; this.name = basename(argv[0] || '').replace(/^-/, '');
    this.q = []; this.qn = 0; this.sys = sys;
  }
  Ctx.prototype = {
    fork() { const c = new Ctx(this.argv.slice(), Object.assign({}, this.env)); c.name = this.name; return c; },
    out(s) { if (s === '') return; const q = this.q, l = q.length; if (l && q[l - 1][0] === 1) q[l - 1][1] += s; else q.push([1, s]); this.qn += s.length; },
    err(s) { if (s === '') return; this.q.push([2, s]); this.qn += s.length; },
    // GNU のコマンドは、使い方の誤りのときに「Try 'x --help' …」も出す
    fail(msg) { this.err(this.name + ': ' + msg + '\n' + (/^(missing (file |destination file )?operand|extra operand|invalid mode: |invalid time interval|invalid floating point argument|invalid adjustment|unrecognized operand|a command must be given)/.test(msg) ? "Try '" + this.name + " --help' for more information.\n" : '')); return 1; },
    tryHelp() { return "Try '" + this.name + " --help' for more information.\n"; },
    perr(what, e) { this.err(this.name + ': ' + what + ': ' + strerror(e) + '\n'); return 1; },
    *writeAll(fd, s) {
      let off = 0;
      while (off < s.length) {
        const r = yield sys.write(fd, off === 0 && s.length <= BS ? s : s.substr(off, BS));
        if (r < 0) { if (r === -E.EINTR) continue; return r; }
        off += r;
      }
      return s.length;
    },
    *flush(keepTail) {
      const q = this.q; this.q = []; this.qn = 0;
      for (let i = 0; i < q.length; i++) {
        let [fd, s] = q[i];
        if (keepTail && i === q.length - 1 && fd === 1) { const rem = s.length % BS; if (rem) { this.q.push([1, s.slice(s.length - rem)]); this.qn = rem; s = s.slice(0, s.length - rem); } }
        if (s !== '') { const r = yield* this.writeAll(fd, s); if (r < 0 && fd === 1) this.werr = r; }
      }
    },
    *put(s) { this.out(s); if (this.qn >= BS) yield* this.flush(true); },
    *eput(s) { this.err(s); yield* this.flush(); },
    *readAll(fd) {
      const parts = [];
      for (;;) {
        const r = yield sys.read(fd, BS);
        if (typeof r === 'number') { if (r === -E.EINTR) continue; return r; }
        if (r === '') break;
        parts.push(r);
      }
      return parts.join('');
    },
    // ファイル全体を読む。'-' は標準入力。エラーなら負の errno
    *slurp(path) {
      if (path === '-') return yield* this.readAll(0);
      const fd = yield sys.open(path, O.RDONLY);
      if (fd < 0) return fd;
      const d = yield* this.readAll(fd);
      yield sys.close(fd);
      return d;
    },
    // エラー文も出して null を返す版
    *cat(path) {
      const d = yield* this.slurp(path);
      if (typeof d === 'number') { this.perr(path, d); this.rc = 1; return null; }
      return d;
    },
    reader(fd) { return new Reader(fd); },
    // 「rm: remove …? 」のように標準エラー出力にたずねて、標準入力から 1 行読む。y か Y で始まれば true
    *ask(prompt) {
      yield* this.flush();
      yield sys.write(2, prompt);
      let l = '';
      for (;;) { const r = yield sys.read(0, 1); if (typeof r === 'number') { if (r === -E.EINTR) continue; break; } if (r === '' || r === '\n') break; l += r; }
      return /^[yY]/.test(l);
    },
    *passwd() {
      if (this._pw) return this._pw;
      const d = yield* this.slurp('/etc/passwd');
      this._pw = (typeof d === 'string' ? d : '').split('\n').filter(Boolean).map((l) => { const f = l.split(':'); return { name: f[0], uid: +f[2], gid: +f[3], gecos: f[4], home: f[5], shell: f[6] }; });
      return this._pw;
    },
    *group() {
      if (this._gr) return this._gr;
      const d = yield* this.slurp('/etc/group');
      this._gr = (typeof d === 'string' ? d : '').split('\n').filter(Boolean).map((l) => { const f = l.split(':'); return { name: f[0], gid: +f[2], members: f[3] ? f[3].split(',') : [] }; });
      return this._gr;
    },
    *uname(uid) { const u = (yield* this.passwd()).find((x) => x.uid === uid); return u ? u.name : String(uid); },
    *gname(gid) { const g = (yield* this.group()).find((x) => x.gid === gid); return g ? g.name : String(gid); },
    // オプションの解釈。spec は 'ab:c' の形（: は値つき）。longs は { '--name': 'n' }。{ o, args } か、エラーなら null（文は出す）
    getopt(spec, longs, stopAtArg) {
      const o = {}, args = [], av = this.argv;
      let i = 1;
      for (; i < av.length; i++) {
        const a = av[i];
        if (a === '--') { i++; break; }
        if (a[0] !== '-' || a === '-') { if (stopAtArg) break; args.push(a); continue; }
        if (a[1] === '-') {
          const eq = a.indexOf('='), nm = eq < 0 ? a : a.slice(0, eq), k = longs && longs[nm];
          if (!k) { this.err(this.name + ": unrecognized option '" + a + "'\n" + this.tryHelp()); return null; }
          const idx = spec.indexOf(k);
          if (spec[idx + 1] === ':') { if (eq >= 0) o[k] = a.slice(eq + 1); else if (i + 1 < av.length) o[k] = av[++i]; else { this.err(this.name + ": option '" + nm + "' requires an argument\n" + this.tryHelp()); return null; } } else o[k] = true;
          continue;
        }
        for (let j = 1; j < a.length; j++) {
          const k = a[j], idx = spec.indexOf(k);
          if (idx < 0 || k === ':') { this.err(this.name + ": invalid option -- '" + k + "'\n" + this.tryHelp()); return null; }
          if (spec[idx + 1] === ':') {
            if (j + 1 < a.length) o[k] = a.slice(j + 1); else if (i + 1 < av.length) o[k] = av[++i]; else { this.err(this.name + ": option requires an argument -- '" + k + "'\n" + this.tryHelp()); return null; }
            break;
          }
          o[k] = (o[k] | 0) + 1;
        }
      }
      for (; i < av.length; i++) args.push(av[i]);
      return { o, args };
    },
  };
  function Reader(fd) { this.fd = fd; this.buf = ''; this.pos = 0; this.eof = false; this.error = 0; }
  Reader.prototype = {
    *fill() {
      for (;;) {
        const r = yield sys.read(this.fd, BS);
        if (typeof r === 'number') { if (r === -E.EINTR) continue; this.error = r; this.eof = true; return false; }
        if (r === '') { this.eof = true; return false; }
        this.buf = this.pos ? this.buf.slice(this.pos) + r : this.buf + r; this.pos = 0;
        return true;
      }
    },
    // 1 行（改行は含まない）。EOF なら null。this.nl は改行で終わっていたか
    *line() {
      for (;;) {
        const i = this.buf.indexOf('\n', this.pos);
        if (i >= 0) { const l = this.buf.slice(this.pos, i); this.pos = i + 1; this.nl = true; return l; }
        if (this.eof) { if (this.pos < this.buf.length) { const l = this.buf.slice(this.pos); this.pos = this.buf.length; this.nl = false; return l; } return null; }
        yield* this.fill();
      }
    },
  };
  // プログラムの入口（C の _start に当たる）。main の戻り値で exit する
  const NOHELP = { echo: 1, printf: 1, test: 1, '[': 1, true: 1, false: 1, sh: 1, init: 1, busybox: 1, expr: 1 };
  function* crt(main, c, prog) {
    let code;
    // どのコマンドも --help で使い方を表示する（help コマンドと同じ文）
    if (prog && prog.usage && c.argv.length === 2 && c.argv[1] === '--help' && !NOHELP[c.name]) { c.out(enc('使い方：' + prog.usage + '\n' + (prog.help || '') + '\n')); yield* c.flush(); yield sys.exit(0); return; }
    try { code = yield* main(c); } catch (e) { if (e && e.lnxAbort) throw e; if (e && e.lnxExit !== undefined) code = e.lnxExit; else throw e; }
    yield* c.flush();
    // 標準出力に書けなかった（ディスクが一杯など）：GNU のコマンドと同じく「write error」を出して 1 で終わる
    if (c.werr && c.werr !== -E.EPIPE && !c.noWerr) { yield sys.write(2, c.name + ': write error: ' + strerror(c.werr) + '\n'); if (!code && !c.rc) code = 1; }
    yield sys.exit(code === undefined ? (c.rc | 0) : code | 0);
  }

  // ════════════════════════ スケジューラ（ラウンドロビン）════════════════════════
  function RoundRobin(k) { this.k = k; this.name = 'rr'; this.slice = 10; this.q = []; }
  RoundRobin.prototype = {
    enqueue(p) { if (!p.onq) { p.onq = true; this.q.push(p); } },
    dequeue(p) { if (p.onq) { p.onq = false; const i = this.q.indexOf(p); if (i >= 0) this.q.splice(i, 1); } },
    pick() { const p = this.q.shift(); if (p) p.onq = false; return p || null; },
    quantum() { return this.slice; },
    account() {},
    nr() { return this.q.length; },
  };

  // ════════════════════════ カーネル ════════════════════════
  const SC = {};   // システムコール表  名前 → { fn(k, p, a, req), fmt(a, r, p, req), ret(r) }
  const PLUGINS = [];
  function def(name, fn, fmt, ret) { SC[name] = { fn, fmt: fmt || (() => ''), ret }; }

  function Kernel(o) {
    this.o = o;
    this.clock = 0; this.steps = 0; this.epoch = o.epoch;
    this.rngState = (o.seed >>> 0) || 0x2545f491;
    this.procs = new Map(); this.nextPid = 1; this.pidMax = 32768; this.maxProcs = o.maxProcs || 256;
    this.timers = []; this.tseq = 0;
    this.handlers = {}; this.sub = {};
    this.devs = new Map(); this.fstypes = {}; this.nextDev = 0x20;
    this.ofdSeq = 0; this.pipeSeq = 0;
    this.evlog = null; this.evmax = 4000; this.evn = 0; this.tevn = 0; this.tevmax = 8000; this.evcat = null;
    this.nD = 0; this.klog = []; this.rebootReq = null;
    this.ttys = []; this.sessions = new Map();
    this.load = [0, 0, 0]; this.loadAt = 0;
    this.sched = new RoundRobin(this);
    this.ns0 = { uts: { hostname: o.hostname, domainname: '(none)' }, mnt: { list: [], covered: new Map() }, pid: { level: 0 } };
    this.cur = null;
    this.stat = { forks: 0, syscalls: 0, ctxsw: 0 };
    this.kcred = { pid: 0, euid: 0, egid: 0, uid: 0, gid: 0, groups: [], umask: 0, ns: this.ns0 };
    this.uname = { sysname: 'Linux', release: '6.8.0-zukai', version: '#1 SMP PREEMPT_DYNAMIC Wed Apr  1 00:00:00 UTC 2026', machine: 'x86_64' };
  }
  const K = Kernel.prototype;

  K.now = function () { return this.epoch + this.clock; };
  K.rand = function () { let x = this.rngState; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; this.rngState = x; return x; };
  K.on = function (name, fn) { (this.handlers[name] || (this.handlers[name] = [])).push(fn); };
  K.emit = function (name, a, b, c) { const h = this.handlers[name]; if (h) for (let i = 0; i < h.length; i++) h[i](a, b, c); };
  K.ev = function (type, o) { const l = this.evlog; if (l && this.evn < this.evmax) { this.evn++; o.type = type; o.t = this.clock; l.push(o); } };
  // 観察用のイベント（run の opts.trace で選んだ種類だけ記録する。種類 cat = 'mem' | 'sched' | 'pagecache' | 'net'）。数の上限は ev とは別
  K.tracing = function (cat) { return !!(this.evlog && this.evcat && this.evcat[cat] && this.tevn < this.tevmax); };
  K.tev = function (cat, type, o) { if (this.evlog && this.evcat && this.evcat[cat] && this.tevn < this.tevmax) { this.tevn++; o.type = type; o.cat = cat; o.t = this.clock; this.evlog.push(o); } };
  // カーネルのログ（dmesg）。t は起動からのミリ秒
  K.printk = function (msg, lvl) { if (this.klog.length < 4000) this.klog.push({ t: this.clock, lvl: lvl === undefined ? 6 : lvl, msg }); };

  // ── 時間とタイマー ──
  // bg = true は「カーネルの裏方のタイマー」（書き戻しの見回りなど）。これしか残っていなければ、機械は「することがない」とみなす
  K.timer = function (at, fn, bg) {
    const t = { at, fn, seq: this.tseq++, bg: !!bg }, ts = this.timers;
    let i = ts.length;
    while (i > 0 && ts[i - 1].at > at) i--;
    ts.splice(i, 0, t);
    return t;
  };
  K.cancelTimer = function (t) { const i = this.timers.indexOf(t); if (i >= 0) this.timers.splice(i, 1); };
  K.advance = function (n) {
    this.clock += n; this.steps += n;
    if (this.timers.length && this.timers[0].at <= this.clock) this.fireTimers();
    if (this.clock - this.loadAt >= 5000) this.updateLoad();
  };
  K.fireTimers = function () { const ts = this.timers; while (ts.length && ts[0].at <= this.clock) ts.shift().fn(); };
  K.updateLoad = function () {
    const n = Math.floor((this.clock - this.loadAt) / 5000);
    this.loadAt += n * 5000;
    const run = this.sched.nr() + (this.cur && this.cur.state === 'R' ? 1 : 0) + this.nD;   // 本物と同じく、ディスク待ち（D）も数える
    [60, 300, 900].forEach((T, i) => { const e = Math.exp(-5 * n / T); this.load[i] = this.load[i] * e + run * (1 - e); });
  };

  // ── 待ち行列 ──
  K.block = function (p, wq) { if (wq.indexOf(p) < 0) { wq.push(p); p.wq.push(wq); } this.setState(p, 'S'); return BLOCK; };
  K.unqueue = function (p) { for (const q of p.wq) { const i = q.indexOf(p); if (i >= 0) q.splice(i, 1); } p.wq.length = 0; };
  K.wake = function (wq) { if (!wq.length) return; for (const p of wq.splice(0)) { const i = p.wq.indexOf(wq); if (i >= 0) p.wq.splice(i, 1); this.unqueue(p); if (p.state === 'S') this.setState(p, 'R'); } };
  K.wakeProc = function (p) { this.unqueue(p); if (p.state === 'S') this.setState(p, 'R'); };
  K.setState = function (p, st) {
    if (p.state === st) return;
    const old = p.state; p.state = st;
    if (st === 'R') this.sched.enqueue(p); else if (old === 'R') this.sched.dequeue(p);
    this.emit('state', p, old, st);
  };

  // ディスクなどの遅い装置を待つ：いまのシステムコールが終わった後、ms ミリ秒のあいだ p を眠らせる（状態 D。シグナルでは起きない）
  K.delay = function (p, ms) {
    if (!(ms > 0) || !p || !p.pid || this.booting) return;
    let at = this.clock + ms;
    if (p.state === 'D' && p.dtimer) { at = p.dtimer.at + ms; this.cancelTimer(p.dtimer); } else { if (p !== this.cur || p.state !== 'R') return; this.setState(p, 'D'); this.nD++; }
    p.iowait = (p.iowait || 0) + ms;
    p.dtimer = this.timer(at, () => { p.dtimer = null; if (p.state === 'D') { this.nD--; this.setState(p, 'R'); } });
  };

  // ════════════ VFS ════════════
  K.mkfs = function (type, source, o) {
    o = o || {};
    const fs = { dev: o.dev || this.nextDev++, type, source, nextIno: o.firstIno || 1, ninodes: 0, inodesTotal: o.inodes || 65536, blocksTotal: o.blocks === undefined ? 4096 : o.blocks, blocksUsed: 0, freeList: [], nextBlock: o.firstBlock || 1, synth: false, dirSize: o.dirSize || 0 };
    fs.root = this.newInode(fs, 'd', o.mode === undefined ? 0o755 : o.mode, 0, 0);
    fs.root.nlink = 2; fs.root.parent = fs.root; fs.root.name = '';
    return fs;
  };
  K.newInode = function (fs, type, mode, uid, gid) {
    const now = this.now();
    const ino = { ino: fs.nextIno++, fs, type, mode: mode & 0o7777, uid, gid, nlink: 0, size: 0, atime: now, mtime: now, ctime: now, blocks: [], opens: 0 };
    fs.ninodes++;
    if (type === 'd') { ino.ents = new Map(); ino.size = fs.dirSize || 40; if (fs.dirSize) this.allocBlocks(ino, 1); } else if (type === 'f' || type === 'l') ino.data = '';
    else if (type === 'p') ino.pipe = this.newPipe();
    return ino;
  };
  K.newPipe = function () { return { id: 100000 + ++this.pipeSeq, buf: '', cap: PIPE_CAP, readers: 0, writers: 0, rwait: [], wwait: [], hadReader: false, hadWriter: false }; };
  K.allocBlocks = function (ino, need) {
    const fs = ino.fs, have = ino.blocks.length;
    if (need > have) {
      if (fs.blocksUsed + need - have > fs.blocksTotal) return -E.ENOSPC;
      for (let i = have; i < need; i++) ino.blocks.push(fs.freeList.length ? fs.freeList.pop() : fs.nextBlock++);
      fs.blocksUsed += need - have;
    } else if (need < have) { while (ino.blocks.length > need) fs.freeList.push(ino.blocks.pop()); fs.blocksUsed -= have - need; }
    return 0;
  };
  // ino.holes：まだ一度も書いていないページ（穴）の番号。穴にはブロックを割り当てない（スパースファイル）
  K.setData = function (ino, data) {
    const pages = Math.ceil(data.length / BS);
    if (ino.holes) { for (const h of Array.from(ino.holes)) if (h >= pages) ino.holes.delete(h); if (!ino.holes.size) ino.holes = null; }
    const r = this.allocBlocks(ino, pages - (ino.holes ? ino.holes.size : 0));
    if (r < 0) return r;
    ino.data = data; ino.size = data.length;
    return 0;
  };
  // ページキャッシュの担当はこの 2 つを差し替える（通常ファイルの読み書きは必ずここを通る）
  // ino.dyn = { read(k, p), write(k, p, data) } があれば、中身はそのつど作る（cgroup のファイルなど）
  K.fileRead = function (ino, pos, n, p) { if (ino.dyn) { const s = ino.dyn.read ? ino.dyn.read(this, p) : ''; return pos >= s.length ? '' : s.substr(pos, n); } return pos >= ino.size ? '' : ino.data.substr(pos, n); };
  K.fileWrite = function (ino, pos, data, p) {
    if (ino.dyn) { const r = ino.dyn.write ? ino.dyn.write(this, p, data) : -E.EACCES; return r === undefined ? data.length : r; }
    const d = ino.data;
    // 末尾より先に書く（lseek で飛んでから write）と、間のページは穴になる。書いたページは穴でなくなる
    if (pos > d.length) { for (let i = Math.ceil(d.length / BS); i < Math.floor(pos / BS); i++) (ino.holes || (ino.holes = new Set())).add(i); }
    if (ino.holes && data.length) { for (let i = Math.floor(pos / BS); i <= Math.floor((pos + data.length - 1) / BS); i++) ino.holes.delete(i); }
    let nd;
    if (pos === d.length) nd = d + data;
    else if (pos > d.length) nd = d + '\0'.repeat(pos - d.length) + data;
    else nd = d.slice(0, pos) + data + d.slice(pos + data.length);
    const r = this.setData(ino, nd);
    if (r < 0) return r;
    ino.mtime = ino.ctime = this.now();
    return data.length;
  };
  K.maybeFree = function (ino) {
    if (ino.nlink > 0 || ino.opens > 0 || ino.freed) return;
    ino.freed = true;
    if (ino.blocks.length) this.allocBlocks(ino, 0);
    ino.fs.ninodes--;
    this.emit('inodeFree', ino);
  };
  K.dirAdd = function (dir, name, ino) {
    dir.ents.set(name, ino); ino.nlink++;
    if (ino.type === 'd') { ino.parent = dir; ino.name = name; ino.nlink = 2 + this.subdirs(ino); dir.nlink++; }
    if (!dir.fs.dirSize) dir.size = 40 + 20 * dir.ents.size;
    dir.mtime = dir.ctime = ino.ctime = this.now();
  };
  K.subdirs = function (d) { let n = 0; for (const e of d.ents.values()) if (e.type === 'd') n++; return n; };
  K.dirRemove = function (dir, name) {
    const ino = dir.ents.get(name);
    dir.ents.delete(name); ino.nlink--;
    if (ino.type === 'd') { ino.nlink = 0; dir.nlink--; }
    if (!dir.fs.dirSize) dir.size = 40 + 20 * dir.ents.size;
    dir.mtime = dir.ctime = ino.ctime = this.now();
    this.maybeFree(ino);
  };

  // ── 合成ファイルシステム（procfs など。中身を読むたびに作る）──
  K.mkSynth = function (type, source) {
    const fs = { dev: this.nextDev++, type, source, nextIno: 1, ninodes: 0, inodesTotal: 0, blocksTotal: 0, blocksUsed: 0, freeList: [], nextBlock: 1, synth: true, inoOf: new Map(), tree: { type: 'd', kids: {} } };
    fs.root = this.synthInode(fs, fs.tree, '', null, '');
    fs.root.parent = fs.root;
    // 節を足す。path は 'sys/kernel/hostname' の形。node = { type:'f', read(k, p), write(k, p, data), mode } | { type:'d', kids, list(k,p), get(k,p,name) } | { type:'l', target(k,p) }
    fs.reg = (path, node) => {
      const parts = path.split('/').filter(Boolean);
      let d = fs.tree;
      for (let i = 0; i < parts.length - 1; i++) { if (!d.kids) d.kids = {}; d = d.kids[parts[i]] || (d.kids[parts[i]] = { type: 'd', kids: {} }); }
      if (!d.kids) d.kids = {};
      if (!node.type) node.type = 'f';
      d.kids[parts[parts.length - 1]] = node;
      return node;
    };
    return fs;
  };
  K.synthInode = function (fs, node, key, parent, name) {
    if (node.pin && node.pinned) return node.pinned;   // マウント先にできる節（inode を使い回す）
    let n = fs.inoOf.get(key);
    if (!n) { n = fs.nextIno++; fs.inoOf.set(key, n); }
    const t = node.time || this.epoch;
    if (node.pin) return (node.pinned = { ino: n, fs, type: 'd', mode: 0o555, uid: 0, gid: 0, nlink: 2, size: 0, atime: t, mtime: t, ctime: t, blocks: [], opens: 0, node, key, parent, name });
    const dm = node.type === 'd' ? 0o555 : node.type === 'l' ? 0o777 : node.write ? 0o644 : 0o444;
    return { ino: n, fs, type: node.type, mode: node.mode === undefined ? dm : node.mode, uid: node.uid || 0, gid: node.gid || 0, nlink: node.type === 'd' ? 2 : 1, size: 0, atime: t, mtime: t, ctime: t, blocks: [], opens: 0, node, key, parent, name };
  };
  K.dirNames = function (p, dir) {
    if (!dir.fs.synth) return Array.from(dir.ents.keys());
    const nd = dir.node;
    let names = nd.kids ? Object.keys(nd.kids) : [];
    if (nd.list) names = names.concat(nd.list(this, p, dir));
    return names;
  };
  K.lookup = function (p, dir, name) {
    if (!dir.fs.synth) return dir.ents.get(name) || null;
    const nd = dir.node;
    const ch = (nd.kids && Object.prototype.hasOwnProperty.call(nd.kids, name) && nd.kids[name]) || (nd.get && nd.get(this, p, name, dir));
    return ch ? this.synthInode(dir.fs, ch, dir.key + '/' + name, dir, name) : null;
  };
  K.linkTarget = function (p, ino) { return ino.fs.synth ? ino.node.target(this, p, ino) : ino.data; };

  // ── 権限 ──
  K.inGroup = function (p, gid) { return p.egid === gid || p.groups.indexOf(gid) >= 0; };
  K.may = function (p, ino, mask) {
    if (p.euid === 0) return !(mask & 1) || ino.type === 'd' || (ino.mode & 0o111) !== 0;
    const m = ino.mode, bits = p.euid === ino.uid ? (m >> 6) & 7 : this.inGroup(p, ino.gid) ? (m >> 3) & 7 : m & 7;
    return (bits & mask) === mask;
  };

  // ── マウント ──
  // fs の根がどこにマウントされているか（バインドマウントは根がちがうので数えない）
  K.mountOf = function (ns, fs) { const l = ns.mnt.list; for (let i = l.length - 1; i >= 0; i--) if (l[i].fs === fs && !l[i].root) return l[i]; return null; };
  K.doMount = function (ns, fs, covered, target, o) {
    const m = { fs, covered, source: fs.source, type: fs.type, target, opts: (o && o.opts) || 'rw,relatime', pinned: !!(o && o.pinned) };
    ns.mnt.list.push(m);
    if (covered) ns.mnt.covered.set(covered, m);
    return m;
  };
  K.cross = function (p, ino) { const cv = p.ns.mnt.covered; let m; while (cv.size && (m = cv.get(ino))) ino = m.root || m.fs.root; return ino; };
  // cross と同じだが、最後に通ったマウントも返す
  K.crossM = function (p, ino) { const cv = p.ns.mnt.covered; let m, last = null; const via = ino; while (cv.size && (m = cv.get(ino))) { ino = m.root || m.fs.root; last = m; } return { ino, m: last, via: last ? via : null }; };
  // inode を含むマウント（パスを知らないときの推定：同じファイルシステムの、いちばん新しいマウント）
  K.mntOfIno = function (p, ino) { return this.mountOf(p.ns, ino.fs); };
  K.dotdot = function (p, cur) {
    for (let g = 0; g < 64; g++) {
      if (cur === p.root) return cur;
      if (cur !== cur.fs.root) return cur.parent;
      const m = this.mountOf(p.ns, cur.fs);
      if (!m || !m.covered) return cur;
      cur = m.covered;
    }
    return cur;
  };
  // いまいるディレクトリの絶対パス。chdir でたどった道を覚えていれば、それを使う（バインドマウントの中でも、入ってきた側の名前になる）
  K.cwdPath = function (p) {
    const st = p.cwdStack;
    if (!st || st[st.length - 1].ino !== p.cwd || st[0].ino !== p.root) return this.pathOf(p, p.cwd);
    if (p.cwd.nlink === 0 && !p.cwd.fs.synth) return null;
    const parts = [];
    for (let i = 1; i < st.length; i++) { const e = st[i], n = (e.via || e.ino); if (n.nlink === 0 && !n.fs.synth && n.type === 'd') return null; parts.push(n.name); }
    return '/' + parts.join('/');
  };
  // ディレクトリの inode → 絶対パス（p から見た）
  K.pathOf = function (p, ino) {
    const parts = [];
    let cur = ino;
    for (let g = 0; g < 4096 && cur !== p.root; g++) {
      if (cur === cur.fs.root) { const m = this.mountOf(p.ns, cur.fs); if (!m || !m.covered) break; cur = m.covered; continue; }
      if (p.ns.mnt.binds && p.ns.mnt.binds.has(cur) && cur.nlink === 0) return null;
      if (cur.nlink === 0 && !cur.fs.synth) return null;
      parts.push(cur.name); cur = cur.parent;
    }
    return '/' + parts.reverse().join('/');
  };

  // ── パスの解決 ──  { inode, parent, name } か 負の errno。inode が null なら「最後の名前だけ無い」
  K.walk = function (p, path, follow, base) {
    if (typeof path !== 'string' || path === '') return -E.ENOENT;
    if (path.length > 4095) return -E.ENAMETOOLONG;
    const start = (ino) => [{ ino, mnt: this.mntOfIno(p, ino), via: null }];
    const cs = p.cwdStack;
    let st = path.charCodeAt(0) === 47 ? start(p.root) : base ? start(base) : cs && cs[cs.length - 1].ino === p.cwd ? cs.slice() : start(p.cwd);
    let cur = st[st.length - 1].ino;
    const todo = path.split('/').reverse();
    const trailing = path.charCodeAt(path.length - 1) === 47;
    let depth = 0, via = null;
    const done = (r) => { if (typeof r === 'number') return r; r.mnt = r.mnt || st[st.length - 1].mnt; this.lastMnt = r.mnt; return r; };
    while (todo.length) {
      const name = todo.pop();
      if (name === '' || name === '.') continue;
      if (cur.type !== 'd') return -E.ENOTDIR;
      if (!this.may(p, cur, 1)) return -E.EACCES;
      let last = true;
      for (let i = todo.length - 1; i >= 0; i--) if (todo[i] !== '' && todo[i] !== '.') { last = false; break; }
      if (name === '..') {
        if (cur === p.root) continue;
        if (st.length > 1) { st.pop(); cur = st[st.length - 1].ino; } else { cur = this.dotdot(p, cur); st = start(cur); }
        continue;
      }
      if (name.length > 255) return -E.ENAMETOOLONG;
      let next = this.lookup(p, cur, name);
      if (!next) return done(last ? { inode: null, parent: cur, name, trailing } : -E.ENOENT);
      const cm = this.crossM(p, next);
      next = cm.ino;
      if (next.type === 'l' && next.node && next.node.magic && (!last || follow || trailing)) {
        // /proc/PID/fd/N：名前をたどり直さず、開いているファイルそのものへ飛ぶ
        via = next.node.magic();
        if (!via) return -E.ENOENT;
        next = via.inode;
        if (last) return done({ inode: next, parent: cur, name, via, mnt: via.mnt || this.mntOfIno(p, next) });
        cur = next; st = start(cur);
        continue;
      }
      if (next.type === 'l' && (!last || follow || trailing)) {
        if (++depth > 40) return -E.ELOOP;
        const t = this.linkTarget(p, next);
        if (t === '') return -E.ENOENT;
        if (t.charCodeAt(0) === 47) { cur = p.root; st = start(cur); }
        const comps = t.split('/');
        for (let i = comps.length - 1; i >= 0; i--) todo.push(comps[i]);
        continue;
      }
      if (last) {
        if (trailing && next.type !== 'd') return -E.ENOTDIR;
        const r = { inode: next, parent: cur, name, mnt: cm.m || st[st.length - 1].mnt };
        if (next.type === 'd') { st.push({ ino: next, mnt: r.mnt, via: cm.via }); r.stack = st; }
        return done(r);
      }
      st.push({ ino: next, mnt: cm.m || st[st.length - 1].mnt, via: cm.via });
      cur = next;
    }
    if (cur.type !== 'd') return -E.ENOTDIR;
    return done({ inode: cur, parent: null, name: null, stack: st });
  };
  // 書き込みを断るマウント（mount -o ro）を通ったか
  K.roMnt = function (w) { const m = w && typeof w === 'object' ? w.mnt : this.lastMnt; return !!(m && m.ro); };
  K.namei = function (p, path, follow) { const r = this.walk(p, path, follow !== false); if (typeof r === 'number') return r; return r.inode || -E.ENOENT; };
  K.fullPath = function (p, w) { if (!w.parent) return this.pathOf(p, w.inode) || '?'; const d = this.pathOf(p, w.parent) || '?'; return (d === '/' ? '' : d) + '/' + w.name; };

  // ── open file description と fd ──
  K.openInode = function (p, ino, flags, path) {
    const ofd = { id: ++this.ofdSeq, inode: ino, pos: 0, flags: flags & ~O.CLOEXEC, refs: 0, path };
    ino.opens++;
    if (ino.type === 'p') { const acc = flags & 3, pp = ino.pipe; if (acc !== O.WRONLY) { pp.readers++; pp.hadReader = true; ofd.pr = true; this.wake(pp.wwait); } if (acc !== O.RDONLY) { pp.writers++; pp.hadWriter = true; ofd.pw = true; this.wake(pp.rwait); } }
    if (ino.fs.synth && ino.type === 'f') ofd.snap = (flags & 3) === O.WRONLY ? '' : ino.node.read ? ino.node.read(this, p) : '';
    return ofd;
  };
  K.ofdPut = function (ofd) {
    if (--ofd.refs > 0) return;
    const ino = ofd.inode;
    if (ino.type === 'p') { const pp = ino.pipe; if (ofd.pr) pp.readers--; if (ofd.pw) pp.writers--; this.wake(pp.rwait); this.wake(pp.wwait); }
    this.emit('release', ofd);
    ino.opens--;
    if (!ino.fs.synth) this.maybeFree(ino);
  };
  K.fdAlloc = function (p, ofd, min, cloexec) {
    let fd = min || 0;
    while (p.fds[fd]) fd++;
    if (fd >= (p.rlim ? p.rlim.nofile[0] : 1024)) return -E.EMFILE;
    p.fds[fd] = { ofd, cloexec: !!cloexec }; ofd.refs++;
    return fd;
  };
  K.fdClose = function (p, fd) {
    const e = p.fds[fd];
    if (!e) return -E.EBADF;
    p.fds[fd] = undefined;
    while (p.fds.length && !p.fds[p.fds.length - 1]) p.fds.pop();
    this.ofdPut(e.ofd);
    return 0;
  };
  K.devOf = function (ino) { return this.devs.get(ino.rdev[0] + ':' + ino.rdev[1]) || this.devs.get(ino.rdev[0] + ':*'); };

  K.ofdRead = function (p, ofd, n) {
    const ino = ofd.inode;
    if ((ofd.flags & 3) === O.WRONLY) return -E.EBADF;
    switch (ino.type) {
      case 'd': return -E.EISDIR;
      case 'f': {
        let d;
        if (ofd.snap !== undefined) d = ofd.snap.substr(ofd.pos, n); else { d = this.fileRead(ino, ofd.pos, n, p); if (typeof d !== 'string') return d; }
        ofd.pos += d.length;
        // relatime：読んだら atime を更新する。ただし「atime が mtime・ctime より新しく、最後の更新から 24 時間たっていない」ときは書かない（ディスクへの書き込みを減らすため）
        if (!ino.fs.synth && !ino.dyn && !(ofd.mnt && ofd.mnt.ro)) { const now = this.now(); if (ino.atime <= ino.mtime || ino.atime <= ino.ctime || now - ino.atime >= 86400000) ino.atime = now; }
        return d;
      }
      case 'p': {
        const pp = ino.pipe;
        if (pp.buf.length) { const d = pp.buf.length <= n ? pp.buf : pp.buf.slice(0, n); pp.buf = pp.buf.length <= n ? '' : pp.buf.slice(n); this.wake(pp.wwait); return d; }
        if (pp.writers === 0 && (pp.hadWriter || !ino.nlink)) return '';
        if (ofd.flags & O.NONBLOCK) return -E.EAGAIN;
        return this.block(p, pp.rwait);
      }
      case 'c': { const dv = this.devOf(ino); return dv ? dv.read(this, p, ofd, n, ino) : -E.ENXIO; }
      default: return -E.EINVAL;
    }
  };
  K.ofdWrite = function (p, ofd, data) {
    const ino = ofd.inode;
    if ((ofd.flags & 3) === O.RDONLY) return -E.EBADF;
    switch (ino.type) {
      case 'f': {
        if (ofd.snap !== undefined) { const r = ino.node.write ? ino.node.write(this, p, data) : -E.EACCES; return r === undefined ? data.length : r; }
        if (ofd.flags & O.APPEND) ofd.pos = ino.size;
        const r = this.fileWrite(ino, ofd.pos, data, p);
        if (r > 0) ofd.pos += r;
        return r;
      }
      case 'p': {
        const pp = ino.pipe;
        if (pp.readers === 0) {
          if (!pp.hadReader && ino.nlink) return this.block(p, pp.wwait);   // 名前つきパイプ：読み手が来るまで待つ
          this.sendSig(p, SIG.PIPE, p);
          return -E.EPIPE;
        }
        const space = pp.cap - pp.buf.length;
        if (space <= 0 || (data.length <= PIPE_BUF && space < data.length)) { if (ofd.flags & O.NONBLOCK) return -E.EAGAIN; return this.block(p, pp.wwait); }
        const n = Math.min(space, data.length);
        pp.buf += n === data.length ? data : data.slice(0, n);
        this.wake(pp.rwait);
        return n;
      }
      case 'c': { const dv = this.devOf(ino); return dv ? dv.write(this, p, ofd, data, ino) : -E.ENXIO; }
      case 'd': return -E.EISDIR;
      default: return -E.EINVAL;
    }
  };
  // カーネルの中から書く（strace の出力など）。待たない
  K.kwrite = function (ofd, data) {
    const ino = ofd.inode;
    if (ino.type === 'p') { ino.pipe.buf += data; this.wake(ino.pipe.rwait); return; }
    this.ofdWrite(this.kcred, ofd, data);
  };

  // ════════════ プロセス ════════════
  K.allocPid = function () {
    for (let i = 0; i < this.pidMax; i++) {
      const pid = this.nextPid++;
      if (this.nextPid >= this.pidMax) this.nextPid = 300;
      if (!this.procs.has(pid)) return pid;
    }
    return -E.EAGAIN;
  };
  K.newProc = function (parent) {
    const pid = this.allocPid();
    if (pid < 0) return pid;
    const p = {
      pid, ppid: parent ? parent.pid : 0, pgid: parent ? parent.pgid : pid, sid: parent ? parent.sid : pid,
      state: 'S', uid: 0, euid: 0, gid: 0, egid: 0, groups: [], cwd: null, root: null, umask: 0o022,
      fds: [], sig: { pending: 0, mask: 0, act: {} }, frames: [], gen: null, ret: undefined, sc: null, burn: 0,
      ctx: null, comm: '', argv: [], env: {}, exe: '', children: new Set(), cwait: [], wq: [], tty: null, ns: this.ns0,
      start: this.clock, utime: 0, stime: 0, cutime: 0, cstime: 0, nice: 0, trace: null, onq: false, exitStatus: 0, nvcsw: 0, nivcsw: 0,
      minflt: 0, majflt: 0, cminflt: 0, cmajflt: 0, maxrss: 0, cmaxrss: 0, inblock: 0, oublock: 0, cinblock: 0, coublock: 0, cnvcsw: 0, cnivcsw: 0,
      // 資源の上限 [soft, hard]（Infinity = unlimited）。Debian の既定に合わせる：core は 0（core を残さない）、開けるファイルは 1024
      rlim: { core: [0, Infinity], nofile: [1024, 1048576], stack: [8388608, Infinity], nproc: [Infinity, Infinity], fsize: [Infinity, Infinity], cpu: [Infinity, Infinity], data: [Infinity, Infinity], as: [Infinity, Infinity], memlock: [8388608, 8388608] },
    };
    if (parent) {
      p.rlim = {}; for (const r in parent.rlim) p.rlim[r] = parent.rlim[r].slice();
      p.uid = parent.uid; p.euid = parent.euid; p.gid = parent.gid; p.egid = parent.egid; p.groups = parent.groups.slice();
      p.cwd = parent.cwd; p.cwdStack = parent.cwdStack; p.root = parent.root; p.umask = parent.umask; p.tty = parent.tty; p.ns = parent.ns; p.nice = parent.nice;
      p.comm = parent.comm; p.argv = parent.argv; p.env = parent.env; p.exe = parent.exe;
      p.sig.mask = parent.sig.mask; p.sig.act = Object.assign({}, parent.sig.act);
      for (let fd = 0; fd < parent.fds.length; fd++) { const e = parent.fds[fd]; if (e) { p.fds[fd] = { ofd: e.ofd, cloexec: e.cloexec }; e.ofd.refs++; } }
      parent.children.add(p);
    }
    this.procs.set(pid, p);
    return p;
  };
  // プログラムを読み込む（execve の本体）。0 か負の errno
  K.loadProg = function (p, path, argv, env, depth) {
    const w = this.walk(p, path, true);
    if (typeof w === 'number') return w;
    const ino = w.inode;
    if (!ino) return -E.ENOENT;
    if (ino.type === 'd') return -E.EACCES;
    if (ino.type !== 'f' || !this.may(p, ino, 1)) return -E.EACCES;
    const head = ino.fs.synth ? '' : this.fileRead(ino, 0, 256, p);
    if (head.startsWith('#!')) {
      if ((depth | 0) >= 4) return -E.ELOOP;
      const line = head.slice(2).split('\n')[0].trim();
      const m = /^(\S+)(?:\s+(.*))?$/.exec(line);
      if (!m) return -E.ENOEXEC;
      const r = this.loadProg(p, m[1], [m[1]].concat(m[2] ? [m[2]] : [], [path], argv.slice(1)), env, (depth | 0) + 1);
      if (r === 0 && !depth) p.comm = basename(path).slice(0, 15);
      return r;
    }
    const m = head.startsWith('\x7fELF') && /zukai:([^\n]+)\n/.exec(head);
    const prog = m && LNX.bin[m[1]];
    if (!prog) return -E.ENOEXEC;
    if (ino.mode & 0o4000) p.euid = ino.uid;
    if (ino.mode & 0o2000) p.egid = ino.gid;
    for (let fd = 0; fd < p.fds.length; fd++) if (p.fds[fd] && p.fds[fd].cloexec) this.fdClose(p, fd);
    for (const s in p.sig.act) if (p.sig.act[s] !== 'ign') delete p.sig.act[s];
    p.frames = []; p.sc = null; p.burn = 0;
    p.comm = basename(path).slice(0, 15); p.argv = argv.slice(); p.env = env; p.exe = this.fullPath(p, w);
    p.ctx = new Ctx(argv.slice(), Object.assign({}, env));
    p.gen = crt(prog.main || prog, p.ctx, prog);
    this.emit('exec', p);
    this.ev('exec', { pid: p.pid, path: p.exe, argv: p.argv.map(dec) });
    return 0;
  };
  K.reaper = function () { return this.procs.get(1); };
  K.exit = function (p, status) {
    if (p.state === 'Z') return;
    if (p.trace && p.trace.live) { this.traceEmit(p, 'exit', (status & 0x7f) ? '+++ killed by SIG' + SIGNAME[status & 0x7f] + (status & 0x80 ? ' (core dumped)' : '') + ' +++' : '+++ exited with ' + ((status >> 8) & 0xff) + ' +++'); }
    if (p.trace) { const sk = p.trace.sink; if (--sk.users <= 0 && sk.ofd) { this.ofdPut(sk.ofd); sk.ofd = null; } p.trace = null; }
    this.unqueue(p);
    if (p.dtimer) { this.cancelTimer(p.dtimer); p.dtimer = null; if (p.state === 'D') this.nD--; }
    for (let fd = p.fds.length - 1; fd >= 0; fd--) if (p.fds[fd]) this.fdClose(p, fd);
    if (p.sc && p.sc.timer) this.cancelTimer(p.sc.timer);
    p.sc = null; p.frames = []; p.gen = null; p.sig.pending = 0;
    this.emit('exit', p, status);
    this.setState(p, 'Z');
    p.exitStatus = status; p.end = this.clock;
    const init = this.reaper(p);
    if (p.children.size && init && init !== p) {
      let z = false;
      for (const c of p.children) { c.ppid = init.pid; init.children.add(c); if (c.state === 'Z') z = true; this.ev('reparent', { pid: c.pid, ppid: init.pid }); }
      p.children.clear();
      if (z) { this.sendSig(init, SIG.CHLD, p); this.wake(init.cwait); }
    }
    this.ev('exit', { pid: p.pid, status, code: (status >> 8) & 0xff, sig: status & 0x7f });
    const parent = this.procs.get(p.ppid);
    if (!parent || parent.state === 'Z') this.reap(p);
    else if (parent.sig.act[SIG.CHLD] === 'ign') this.reap(p);
    else { this.sendSig(parent, SIG.CHLD, p); this.wake(parent.cwait); }
  };
  K.reap = function (p) {
    const parent = this.procs.get(p.ppid);
    if (parent) {
      parent.children.delete(p); parent.cutime += p.utime + p.cutime; parent.cstime += p.stime + p.cstime;
      parent.cminflt += p.minflt + p.cminflt; parent.cmajflt += p.majflt + p.cmajflt; parent.cmaxrss = Math.max(parent.cmaxrss, p.maxrss, p.cmaxrss);
      parent.cinblock += p.inblock + p.cinblock; parent.coublock += p.oublock + p.coublock; parent.cnvcsw += p.nvcsw + p.cnvcsw; parent.cnivcsw += p.nivcsw + p.cnivcsw;
    }
    this.procs.delete(p.pid);
    this.lastReaped = p;
    this.emit('reap', p);
    this.ev('reap', { pid: p.pid, by: p.ppid });
  };

  // ── シグナル ──
  K.sendSig = function (p, sig, from) {
    if (p.state === 'Z' || sig <= 0) return;
    const s = p.sig, bit = 1 << sig;
    this.ev('signal', { pid: p.pid, sig, name: 'SIG' + SIGNAME[sig], from: from ? from.pid : 0 });
    if (sig === SIG.CONT) {
      s.pending &= ~((1 << 19) | (1 << 20) | (1 << 21) | (1 << 22));
      if (p.state === 'T') { this.setState(p, 'R'); p.contNotify = true; p.stopNotify = false; const par = this.procs.get(p.ppid); if (par) this.wake(par.cwait); }
    } else if (sig >= 19 && sig <= 22) s.pending &= ~(1 << 18);
    const act = s.act[sig];
    p.siginfo = p.siginfo || {}; p.siginfo[sig] = from ? { pid: from.pid, uid: from.uid } : null;
    if (sig === SIG.CHLD && from && from.ppid === p.pid) { const st = from.exitStatus | 0; p.siginfo[sig].chld = from.state === 'Z' ? ((st & 0x7f) ? [(st & 0x80) ? 'CLD_DUMPED' : 'CLD_KILLED', 'SIG' + SIGNAME[st & 0x7f]] : ['CLD_EXITED', (st >> 8) & 0xff]) : from.state === 'T' ? ['CLD_STOPPED', 'SIG' + SIGNAME[from.stopSig || 19]] : ['CLD_CONTINUED', 'SIGCONT']; }
    if (sig !== SIG.KILL && sig !== SIG.STOP && (act === 'ign' || (!act && sigDefault(sig) === 'ign') || (!act && sig === SIG.CONT))) {
      // 既定で無視するシグナル（SIGCHLD など）も、strace には届いたことが出る
      if (!act && sig === SIG.CHLD && p.trace && p.trace.live) { const info = p.siginfo[sig]; this.traceEmit(p, 'signal', '--- SIGCHLD {si_signo=SIGCHLD' + (info && info.chld ? ', si_code=' + info.chld[0] + ', si_pid=' + info.pid + ', si_uid=' + info.uid + ', si_status=' + info.chld[1] + ', si_utime=0, si_stime=0' : ', si_code=SI_USER') + '} ---'); }
      return;
    }
    s.pending |= bit;
    if (sig === SIG.KILL && p.state === 'T') { this.setState(p, 'R'); return; }
    if (p.state === 'S' && (!(s.mask & bit) || (bit & UNBLOCKABLE))) this.wakeProc(p);
  };
  K.killpg = function (pgid, sig, from) { let n = 0; for (const q of Array.from(this.procs.values())) if (q.pgid === pgid && q.state !== 'Z') { this.sendSig(q, sig, from); n++; } return n; };
  K.deliver = function (p) {
    const s = p.sig, bits = s.pending & ~(s.mask & ~UNBLOCKABLE);
    const sig = bits & (1 << 9) ? 9 : 31 - Math.clz32(bits & -bits);
    s.pending &= ~(1 << sig);
    const act = s.act[sig], info = p.siginfo && p.siginfo[sig];
    if (p.trace && p.trace.live) this.traceEmit(p, 'signal', '--- SIG' + SIGNAME[sig] + ' {si_signo=SIG' + SIGNAME[sig] + (info && info.chld ? ', si_code=' + info.chld[0] + ', si_pid=' + info.pid + ', si_uid=' + info.uid + ', si_status=' + info.chld[1] + ', si_utime=0, si_stime=0' : info ? ', si_code=SI_USER, si_pid=' + info.pid + ', si_uid=' + info.uid : ', si_code=SI_KERNEL') + '} ---');
    if (act && typeof act === 'object' && sig !== SIG.KILL && sig !== SIG.STOP) {
      let sc = null;
      if (p.sc) {
        const it = p.sc; p.sc = null; this.unqueue(p);
        if (it.timer) { this.cancelTimer(it.timer); it.timer = null; }
        if (act.restart && (it.n === 'read' || it.n === 'write' || it.n === 'wait4' || it.n === 'openat')) sc = it;
        else { p.ret = -E.EINTR; if (p.trace && p.trace.live) this.traceCall(p, it, -E.EINTR); }
      }
      let r;
      try { r = act.fn(sig); } catch (e) { this.crash(p, e); return; }
      if (r && typeof r.next === 'function') { p.frames.push({ gen: r, ret: p.ret, mask: s.mask, sc }); s.mask |= 1 << sig; p.ret = undefined; } else if (sc) p.sc = sc;
      return;
    }
    const d = sigDefault(sig);
    if (act === 'ign' || d === 'ign' || d === 'cont') return;
    if (d === 'stop') {
      this.unqueue(p); this.setState(p, 'T'); p.stopSig = sig; p.stopNotify = true; p.contNotify = false;
      const par = this.procs.get(p.ppid);
      if (par) { this.sendSig(par, SIG.CHLD, p); this.wake(par.cwait); }
      this.ev('stop', { pid: p.pid, sig });
      return;
    }
    this.exit(p, sig | (d === 'core' && p.rlim && p.rlim.core[0] > 0 ? 0x80 : 0));
  };
  K.crash = function (p, e) {
    const msg = (p.comm || '?') + ': internal error: ' + (e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : String(e)) + '\n';
    this.lastCrash = msg;
    const f2 = p.fds[2];
    if (f2) this.kwrite(f2.ofd, enc(msg));
    this.exit(p, SIG.SEGV | 0x80);
  };

  // ── 1 プロセスを 1 歩（最大 q tick）進める ──
  K.stepProc = function (p, q) {
    const s = p.sig;
    if (s.pending && (s.pending & ~(s.mask & ~UNBLOCKABLE))) { this.deliver(p); if (p.state !== 'R') { this.advance(1); return 1; } }
    let req = p.sc;
    if (!req) {
      if (p.burn > 0) { const n = Math.min(p.burn, q); p.burn -= n; p.utime += n; this.advance(n); return n; }
      const top = p.frames.length ? p.frames[p.frames.length - 1] : null;
      let it;
      try {
        if (p.abort && !top) { const a = p.abort; p.abort = null; it = p.gen.throw(a); } else it = (top ? top.gen : p.gen).next(p.ret);
      } catch (e) { this.crash(p, e); this.advance(1); return 1; }
      if (it.done) {
        if (top) {
          p.frames.pop(); s.mask = top.mask; p.ret = top.ret; if (top.sc) p.sc = top.sc;
          if (p.trace && p.trace.live) this.traceEmit(p, 'rt_sigreturn', 'rt_sigreturn({mask=[]})'.padEnd(39) + ' = 0');
        } else this.exit(p, ((it.value | 0) & 0xff) << 8);
        p.utime++; this.advance(1); return 1;
      }
      req = it.value;
      if (!req || typeof req.n !== 'string') { this.crash(p, new Error('bad yield from user program')); this.advance(1); return 1; }
      if (req.n === '_cpu') { p.burn = Math.max(0, req.a[0] | 0); p.ret = 0; if (p.burn === 0) { this.advance(1); return 1; } return this.stepProc(p, q); }
    }
    const d = SC[req.n];
    this.stat.syscalls++;
    const w = this.scw && this.scw[req.n];
    const r = !d ? -E.ENOSYS : w ? w(d.fn, this, p, req.a, req) : d.fn(this, p, req.a, req);
    p.stime++;
    if (r === BLOCK) { p.sc = req; p.nvcsw++; this.advance(1); return 1; }
    p.sc = null; p.ret = r;
    if (p.trace && p.trace.live && req.n.charCodeAt(0) !== 95) this.traceCall(p, req, r);
    this.advance(1);
    return 1;
  };
  // ── 1 回の割り当て（実行できるものがなければ次のタイマーまで時間を飛ばす）。何もすることがなければ false ──
  K.quantum = function (maxClock) {
    const p = this.sched.pick();
    if (!p) {
      if (!this.timers.length) return false;
      let at = this.timers[0].at;
      if (maxClock !== undefined && at > maxClock) at = maxClock;
      if (at > this.clock) { this.idle = (this.idle || 0) + at - this.clock; this.clock = at; }
      if (this.clock - this.loadAt >= 5000) this.updateLoad();
      this.fireTimers();
      return true;
    }
    this.cur = p; this.stat.ctxsw++;
    this.emit('switch', p);
    let q = this.sched.quantum(p);
    const q0 = q;
    p.yielded = false;
    while (q > 0 && p.state === 'R' && !p.yielded) q -= this.stepProc(p, q);
    this.sched.account(p, q0 - q);
    this.cur = null;
    if (p.state === 'R') { p.nivcsw++; this.sched.enqueue(p); }
    return true;
  };

  // ── strace ──
  K.traceEmit = function (p, name, text) {
    const t = p.trace, sk = t.sink;
    if (sk.count) return;
    if (sk.filter && name !== 'exit' && name !== 'signal' && !sk.filter.has(name)) return;
    sk.pids.add(p.pid);
    const line = (sk.pids.size > 1 ? '[pid ' + p.pid + '] ' : '') + text;
    if (sk.lines) { if (sk.lines.length < 4000) sk.lines.push({ pid: p.pid, name, text, line, t: this.clock }); } else if (sk.ofd) this.kwrite(sk.ofd, line + '\n');
  };
  K.traceCall = function (p, req, r) {
    const d = SC[req.n];
    // strace -c：1 行ずつは出さず、名前ごとに回数とエラーの数を数える（1 回 1 ミリ秒として時間も足す）
    const ck = p.trace.sink.count;
    if (ck) { if (p.trace.sink.filter && !p.trace.sink.filter.has(req.n)) return; const c = ck[req.n] || (ck[req.n] = { calls: 0, errors: 0, ms: 0 }); c.calls++; c.ms += 1; if (typeof r === 'number' && r < 0) c.errors++; return; }
    let args;
    try { args = d ? d.fmt(req.a, r, p, req) : ''; } catch (e) { args = '...'; }
    let rs;
    if (typeof r === 'number' && r < 0) rs = '-1 ' + (ENAME[-r] || 'E' + -r) + ' (' + strerror(r) + ')';
    else if (d && d.ret) rs = d.ret(r, req.a, p);
    else rs = typeof r === 'number' ? String(r) : typeof r === 'string' ? String(r.length) : '0';
    this.traceEmit(p, req.n, (req.n + '(' + args + ')').padEnd(39) + ' = ' + rs);   // 本物の strace と同じく、= を 40 桁目にそろえる
  };
  K.setTrace = function (p, sink, o) { if (p.trace) p.trace.sink.users--; p.trace = { sink, live: !!o.live, follow: !!o.follow, onExec: !!o.onExec }; sink.users++; };

  // ════════════ システムコール ════════════
  const ADDR = '0x7ffd3c2a1b40';
  const flagStr = (f) => { const a = [['O_RDONLY', 'O_WRONLY', 'O_RDWR'][f & 3]]; for (const n of ['CREAT', 'EXCL', 'NOCTTY', 'TRUNC', 'APPEND', 'NONBLOCK', 'DIRECTORY', 'NOFOLLOW', 'CLOEXEC']) if (f & O[n]) a.push('O_' + n); return a.join('|'); };
  const statStr = (st) => '{st_mode=' + { f: 'S_IFREG', d: 'S_IFDIR', l: 'S_IFLNK', c: 'S_IFCHR', b: 'S_IFBLK', p: 'S_IFIFO', s: 'S_IFSOCK' }[BITSTYPE[st.mode & S.IFMT]] + '|0' + oct(st.mode & 0o7777, 3) + (st.rdev ? ', st_rdev=makedev(0x' + (st.rdev >> 8).toString(16) + ', 0x' + (st.rdev & 255).toString(16) + ')' : ', st_size=' + st.size) + ', ...}';
  const sigStr = (n) => (SIGNAME[n] ? 'SIG' + SIGNAME[n] : String(n));
  const statusStr = (st) => ((st & 0x7f) === 0 ? '[{WIFEXITED(s) && WEXITSTATUS(s) == ' + ((st >> 8) & 255) + '}]' : (st & 0xff) === 0x7f ? '[{WIFSTOPPED(s) && WSTOPSIG(s) == ' + sigStr((st >> 8) & 255) + '}]' : st === 0xffff ? '[{WIFCONTINUED(s)}]' : '[{WIFSIGNALED(s) && WTERMSIG(s) == ' + sigStr(st & 0x7f) + (st & 0x80 ? ' && WCOREDUMP(s)' : '') + '}]');
  const dirfdStr = (d) => (d === AT_FDCWD ? 'AT_FDCWD' : String(d));
  const tsStr = (ms) => '{tv_sec=' + Math.floor(ms / 1000) + ', tv_nsec=' + (ms % 1000) * 1000000 + '}';
  const pstr = (a) => quote(String(a[0]), 4096);
  const getOfd = (p, fd) => { const e = p.fds[fd]; return e ? e.ofd : null; };

  def('clone', (k, p, a) => {
    if (typeof a[0] !== 'function') return -E.EINVAL;
    if (k.procs.size >= k.maxProcs) return -E.EAGAIN;
    const r = k.emitCheck('canFork', p);
    if (r < 0) return r;
    const c = k.newProc(p);
    if (typeof c === 'number') return c;
    k.stat.forks++;
    c.ctx = p.ctx ? p.ctx.fork() : new Ctx([], {});
    c.gen = crt(a[0], c.ctx);
    if ((a[1] | 0) & 1) { for (const s in c.sig.act) if (c.sig.act[s] !== 'ign') delete c.sig.act[s]; for (const s of a[2] || []) delete c.sig.act[s]; }
    if (p.trace && p.trace.follow) k.setTrace(c, p.trace.sink, p.trace);
    k.emit('fork', p, c, a[1] | 0);
    k.ev('fork', { pid: c.pid, ppid: p.pid, comm: dec(c.comm) });
    k.setState(c, 'R');
    return c.pid;
  }, () => 'child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f3a5c0e8a10');
  // 部品がシステムコールを足す・包むときは、カーネル（機械）ごとの表に置く（複数の機械が同時にあっても混ざらないように）
  //   k.defsys('mmap', fn(k, p, a, req), fmt, ret)        この機械での実装を登録する
  //   k.wrapsys('getpid', (orig, k, p, a, req) => …)      すでにあるシステムコールを包む（orig(k, p, a, req) で元を呼ぶ）
  K.defsys = function (name, fn, fmt, ret) {
    (this.sc || (this.sc = {}))[name] = fn;
    def(name, (k, p, a, req) => { const f = k.sc && k.sc[name]; return f ? f(k, p, a, req) : -E.ENOSYS; }, fmt, ret);
    if (!sys[name]) sys[name] = (...a) => ({ n: name, a });
  };
  K.wrapsys = function (name, f) { const t = this.scw || (this.scw = {}), prev = t[name]; t[name] = prev ? (o, k, p, a, req) => f((k2, p2, a2, r2) => prev(o, k2, p2, a2, r2), k, p, a, req) : f; };
  K.emitCheck = function (name, a, b) { const h = this.handlers[name]; if (h) for (const f of h) { const r = f(a, b); if (typeof r === 'number' && r < 0) return r; } return 0; };

  def('execve', (k, p, a) => {
    const argv = (a[1] || []).map(String), env = a[2] || {};
    const r = k.loadProg(p, String(a[0]), argv.length ? argv : [String(a[0])], Object.assign({}, env));
    if (r === 0 && p.trace && p.trace.onExec) p.trace.live = true;
    return r;
  }, (a) => quote(String(a[0]), 4096) + ', [' + (a[1] || []).map((s) => quote(String(s))).join(', ') + '], ' + ADDR + ' /* ' + Object.keys(a[2] || {}).length + ' vars */');

  def('exit_group', (k, p, a) => {
    const code = (a[0] | 0) & 0xff;
    if (p.trace && p.trace.live) k.traceEmit(p, 'exit_group', ('exit_group(' + code + ')').padEnd(39) + ' = ?');
    k.exit(p, code << 8);
    return 0;
  });
  SC.exit_group.notrace = true;

  def('wait4', (k, p, a) => {
    const pid = a[0] === undefined ? -1 : a[0] | 0, opt = a[1] | 0;
    let any = false;
    for (const c of p.children) {
      if (!(pid === -1 || (pid > 0 && c.pid === pid) || (pid === 0 && c.pgid === p.pgid) || (pid < -1 && c.pgid === -pid))) continue;
      any = true;
      if (c.state === 'Z') { const st = c.exitStatus; k.reap(c); return { pid: c.pid, status: st }; }
      if (c.state === 'T' && c.stopNotify && (opt & W.UNTRACED)) { c.stopNotify = false; return { pid: c.pid, status: (c.stopSig << 8) | 0x7f }; }
      if (c.contNotify && (opt & W.CONTINUED)) { c.contNotify = false; return { pid: c.pid, status: 0xffff }; }
    }
    if (!any) return -E.ECHILD;
    if (opt & W.NOHANG) return 0;
    return k.block(p, p.cwait);
  }, (a, r) => (a[0] === undefined ? -1 : a[0]) + ', ' + (r && typeof r === 'object' ? statusStr(r.status) : ADDR) + ', ' + ([a[1] & 1 ? 'WNOHANG' : '', a[1] & 2 ? 'WUNTRACED' : '', a[1] & 8 ? 'WCONTINUED' : ''].filter(Boolean).join('|') || '0') + ', NULL',
  (r) => (r && typeof r === 'object' ? String(r.pid) : '0'));

  def('getpid', (k, p) => p.pid);
  def('getppid', (k, p) => p.ppid);
  // prlimit64(pid, 資源, 新しい [soft, hard] か null) → 前の [soft, hard]。資源は 'core' 'nofile' 'stack' 'nproc' 'fsize' 'cpu' 'data' 'as' 'memlock'
  const RLIMNAME = { core: 'RLIMIT_CORE', nofile: 'RLIMIT_NOFILE', stack: 'RLIMIT_STACK', nproc: 'RLIMIT_NPROC', fsize: 'RLIMIT_FSIZE', cpu: 'RLIMIT_CPU', data: 'RLIMIT_DATA', as: 'RLIMIT_AS', memlock: 'RLIMIT_MEMLOCK' };
  const rlimStr = (l) => '{rlim_cur=' + (l[0] === Infinity ? 'RLIM64_INFINITY' : l[0]) + ', rlim_max=' + (l[1] === Infinity ? 'RLIM64_INFINITY' : l[1]) + '}';
  def('prlimit64', (k, p, a) => {
    const q = a[0] ? k.procs.get(a[0]) : p; if (!q) return -E.ESRCH;
    const cur = q.rlim[a[1]]; if (!cur) return -E.EINVAL;
    const old = cur.slice(), nl = a[2];
    if (nl) {
      if (nl[0] > nl[1]) return -E.EINVAL;
      if (nl[1] > cur[1] && p.euid !== 0) return -E.EPERM;
      if (a[1] === 'nofile' && nl[1] > 1048576) return -E.EPERM;
      q.rlim[a[1]] = [nl[0], nl[1]];
    }
    return old;
  }, (a, r) => (a[0] | 0) + ', ' + (RLIMNAME[a[1]] || a[1]) + ', ' + (a[2] ? rlimStr(a[2]) : 'NULL') + ', ' + (Array.isArray(r) ? rlimStr(r) : ADDR), () => '0');
  def('getuid', (k, p) => p.uid);
  def('geteuid', (k, p) => p.euid);
  def('getgid', (k, p) => p.gid);
  def('getegid', (k, p) => p.egid);
  def('getgroups', (k, p) => p.groups.slice(), (a, r) => r.length + ', [' + r.join(', ') + ']', (r) => String(r.length));
  def('getpgid', (k, p, a) => { const q = a[0] ? k.procs.get(a[0]) : p; return q ? q.pgid : -E.ESRCH; }, (a) => String(a[0] | 0));
  def('getsid', (k, p, a) => { const q = a[0] ? k.procs.get(a[0]) : p; return q ? q.sid : -E.ESRCH; }, (a) => String(a[0] | 0));
  def('setpgid', (k, p, a) => {
    const q = a[0] ? k.procs.get(a[0]) : p;
    if (!q || (q !== p && q.ppid !== p.pid)) return -E.ESRCH;
    if (q.pid === q.sid) return -E.EPERM;
    q.pgid = a[1] || q.pid;
    return 0;
  }, (a) => (a[0] | 0) + ', ' + (a[1] | 0));
  def('setsid', (k, p) => { if (p.pgid === p.pid) return -E.EPERM; p.sid = p.pgid = p.pid; p.tty = null; return p.pid; });
  def('setuid', (k, p, a) => { const u = a[0] | 0; if (p.euid !== 0 && u !== p.uid) return -E.EPERM; if (p.euid === 0) p.uid = u; p.euid = u; return 0; }, (a) => String(a[0]));
  def('setgid', (k, p, a) => { const g = a[0] | 0; if (p.euid !== 0 && g !== p.gid) return -E.EPERM; if (p.euid === 0) p.gid = g; p.egid = g; return 0; }, (a) => String(a[0]));
  def('setgroups', (k, p, a) => { if (p.euid !== 0) return -E.EPERM; p.groups = (a[0] || []).slice(); return 0; }, (a) => (a[0] || []).length + ', [' + (a[0] || []).join(', ') + ']');

  def('kill', (k, p, a) => {
    const pid = a[0] | 0, sig = a[1] | 0;
    if (sig < 0 || sig > 31) return -E.EINVAL;
    const can = (q) => p.euid === 0 || p.uid === q.uid || p.euid === q.uid;
    let targets;
    if (pid > 0) { const q = k.procs.get(pid); if (!q) return -E.ESRCH; targets = [q]; } else {
      const pg = pid === 0 ? p.pgid : pid === -1 ? 0 : -pid;
      targets = Array.from(k.procs.values()).filter((q) => (pg ? q.pgid === pg : q.pid !== 1 && q !== p));
      if (!targets.length) return -E.ESRCH;
    }
    let ok = 0;
    for (const q of targets) if (can(q)) { ok++; if (sig) { k.sendSig(q, sig, p); if (q !== p) p.yielded = true; } }   // 相手がすぐ受け取れるように CPU を譲る
    return ok ? 0 : -E.EPERM;
  }, (a) => a[0] + ', ' + (a[1] ? sigStr(a[1]) : '0'));

  def('rt_sigaction', (k, p, a) => {
    const sig = a[0] | 0, h = a[1], o = a[2] || {};
    if (sig < 1 || sig > 31 || sig === SIG.KILL || sig === SIG.STOP) return -E.EINVAL;
    if (h === undefined || h === null) return 0;
    if (h === 'SIG_DFL' || h === 0) delete p.sig.act[sig];
    else if (h === 'SIG_IGN' || h === 1) { p.sig.act[sig] = 'ign'; p.sig.pending &= ~(1 << sig); } else if (typeof h === 'function') p.sig.act[sig] = { fn: h, restart: o.restart !== false };
    else return -E.EINVAL;
    return 0;
  }, (a) => sigStr(a[0]) + ', ' + (typeof a[1] === 'function' ? '{sa_handler=0x55d0c3a2f6b0, sa_mask=[], sa_flags=SA_RESTORER' + ((a[2] || {}).restart === false ? '' : '|SA_RESTART') + ', sa_restorer=0x7f3a5be42520}' : a[1] === 'SIG_IGN' || a[1] === 1 ? '{sa_handler=SIG_IGN, sa_mask=[], sa_flags=SA_RESTORER, sa_restorer=0x7f3a5be42520}' : a[1] == null ? 'NULL' : '{sa_handler=SIG_DFL, sa_mask=[], sa_flags=SA_RESTORER, sa_restorer=0x7f3a5be42520}') + ', NULL, 8');
  def('rt_sigprocmask', (k, p, a) => {
    const old = []; for (let i = 1; i < 32; i++) if (p.sig.mask & (1 << i)) old.push(i);
    let m = 0; for (const s of a[1] || []) m |= 1 << s;
    m &= ~UNBLOCKABLE;
    if (a[1]) { if (a[0] === 0) p.sig.mask |= m; else if (a[0] === 1) p.sig.mask &= ~m; else p.sig.mask = m; }
    return old;
  }, (a) => ['SIG_BLOCK', 'SIG_UNBLOCK', 'SIG_SETMASK'][a[0] | 0] + ', ' + (a[1] ? '[' + a[1].map((s) => SIGNAME[s]).join(' ') + ']' : 'NULL') + ', [], 8', () => '0');
  def('pause', (k, p) => k.block(p, p.pwait || (p.pwait = [])));

  // ── ファイル ──
  K.doOpen = function (p, dirfd, path, flags, mode) {
    let base = null;
    if (dirfd !== AT_FDCWD && dirfd !== undefined && path[0] !== '/') { const o = getOfd(p, dirfd); if (!o) return -E.EBADF; if (o.inode.type !== 'd') return -E.ENOTDIR; base = o.inode; }
    const acc = flags & 3;
    const w = this.walk(p, path, !(flags & O.NOFOLLOW) && !((flags & O.CREAT) && (flags & O.EXCL)), base);
    if (typeof w === 'number') return w;
    let ino = w.inode, created = false;
    if (!ino) {
      if (!(flags & O.CREAT)) return -E.ENOENT;
      if (w.trailing) return -E.EISDIR;
      if (this.roMnt(w)) return -E.EROFS;
      if (w.parent.fs.synth) return -E.ENOENT;
      if (w.parent.fs.ops) return -E.EPERM;
      if (!this.may(p, w.parent, 3)) return -E.EACCES;
      if (w.parent.fs.ninodes >= w.parent.fs.inodesTotal) return -E.ENOSPC;
      ino = this.newInode(w.parent.fs, 'f', (mode === undefined ? 0o666 : mode) & ~p.umask, p.euid, (w.parent.mode & 0o2000) ? w.parent.gid : p.egid);
      this.dirAdd(w.parent, w.name, ino);
      created = true;
      this.ev('fs', { op: 'create', path: this.fullPath(p, w), ino: ino.ino, pid: p.pid });
    } else {
      if ((flags & O.CREAT) && (flags & O.EXCL)) return -E.EEXIST;
      if (ino.type === 'l') return -E.ELOOP;
      if ((flags & O.DIRECTORY) && ino.type !== 'd') return -E.ENOTDIR;
      if (ino.type === 'd' && (acc !== O.RDONLY || (flags & O.CREAT))) return -E.EISDIR;
      if (acc !== O.RDONLY && (ino.type === 'f' || ino.type === 'd') && this.roMnt(w)) return -E.EROFS;
      if (!this.may(p, ino, acc === O.RDONLY ? 4 : acc === O.WRONLY ? 2 : 6)) return -E.EACCES;
      if (ino.type === 's') return -E.ENXIO;
    }
    if ((flags & O.TRUNC) && acc !== O.RDONLY && ino.type === 'f' && !created && !ino.fs.synth && !ino.dyn) { if (ino.size) { this.setData(ino, ''); this.emit('truncate', ino); } ino.mtime = ino.ctime = this.now(); }
    const full = w.via ? w.via.path : this.fullPath(p, w.inode ? w : { parent: w.parent, name: w.name });
    const ofd = this.openInode(p, ino, flags, full);
    ofd.mnt = w.mnt;
    if (ino.type === 'c') { const dv = this.devOf(ino); if (dv && dv.open) dv.open(this, p, ofd, ino); }
    if (w.via) { if (w.via.err) ofd.err = true; if (w.via.tty) ofd.tty = w.via.tty; }
    const fd = this.fdAlloc(p, ofd, 0, flags & O.CLOEXEC);
    if (fd < 0) { ofd.refs = 1; this.ofdPut(ofd); return fd; }
    this.ev('open', { pid: p.pid, fd, path: dec(full), ino: ino.ino });
    return fd;
  };
  def('openat', (k, p, a) => k.doOpen(p, a[0], String(a[1]), a[2] | 0, a[3]), (a) => dirfdStr(a[0]) + ', ' + quote(String(a[1]), 4096) + ', ' + flagStr(a[2] | 0) + ((a[2] & O.CREAT) ? ', 0' + oct(a[3] === undefined ? 0o666 : a[3], 3) : ''));
  def('read', (k, p, a) => { const o = getOfd(p, a[0]); if (!o) return -E.EBADF; return k.ofdRead(p, o, a[1] === undefined ? BS : a[1] | 0); },
    (a, r) => a[0] + ', ' + (typeof r === 'string' ? quote(r) : ADDR) + ', ' + (a[1] === undefined ? BS : a[1]));
  def('write', (k, p, a) => { const o = getOfd(p, a[0]); if (!o) return -E.EBADF; const d = String(a[1]); if (d === '') return 0; return k.ofdWrite(p, o, d); },
    (a) => a[0] + ', ' + quote(String(a[1])) + ', ' + String(a[1]).length);
  def('close', (k, p, a) => { const r = k.fdClose(p, a[0]); if (r === 0) k.ev('close', { pid: p.pid, fd: a[0] }); return r; }, (a) => String(a[0]));
  def('lseek', (k, p, a) => {
    const o = getOfd(p, a[0]); if (!o) return -E.EBADF;
    if (o.inode.type === 'p' || o.inode.type === 's') return -E.ESPIPE;
    const base = a[2] === 1 ? o.pos : a[2] === 2 ? o.inode.size : 0, np = base + (a[1] | 0);
    if (np < 0) return -E.EINVAL;
    o.pos = np; return np;
  }, (a) => a[0] + ', ' + a[1] + ', ' + ['SEEK_SET', 'SEEK_CUR', 'SEEK_END'][a[2] | 0]);
  def('dup', (k, p, a) => { const o = getOfd(p, a[0]); if (!o) return -E.EBADF; const fd = k.fdAlloc(p, o, 0); if (fd >= 0) k.ev('dup', { pid: p.pid, from: a[0], fd }); return fd; }, (a) => String(a[0]));
  def('dup2', (k, p, a) => {
    const o = getOfd(p, a[0]), nf = a[1] | 0; if (!o) return -E.EBADF;
    if (nf < 0 || nf >= 1024) return -E.EBADF;
    if (nf === a[0]) return nf;
    if (p.fds[nf]) k.fdClose(p, nf);
    p.fds[nf] = { ofd: o, cloexec: false }; o.refs++;
    k.ev('dup', { pid: p.pid, from: a[0], fd: nf });
    return nf;
  }, (a) => a[0] + ', ' + a[1]);
  def('fcntl', (k, p, a) => {
    const e = p.fds[a[0]]; if (!e) return -E.EBADF;
    switch (a[1]) {
      case F.DUPFD: case F.DUPFD_CLOEXEC: { const fd = k.fdAlloc(p, e.ofd, a[2] | 0, a[1] === F.DUPFD_CLOEXEC); if (fd >= 0) k.ev('dup', { pid: p.pid, from: a[0], fd }); return fd; }
      case F.GETFD: return e.cloexec ? 1 : 0;
      case F.SETFD: e.cloexec = !!(a[2] & 1); return 0;
      case F.GETFL: return e.ofd.flags;
      case F.SETFL: e.ofd.flags = (e.ofd.flags & ~(O.APPEND | O.NONBLOCK)) | (a[2] & (O.APPEND | O.NONBLOCK)); return 0;
      default: return -E.EINVAL;
    }
  }, (a) => a[0] + ', ' + ({ 0: 'F_DUPFD', 1: 'F_GETFD', 2: 'F_SETFD', 3: 'F_GETFL', 4: 'F_SETFL', 1030: 'F_DUPFD_CLOEXEC' }[a[1]] || a[1]) + (a[2] === undefined ? '' : ', ' + (a[1] === F.SETFD ? (a[2] ? 'FD_CLOEXEC' : '0') : a[1] === F.SETFL ? flagStr(a[2]) : a[2])));
  def('pipe', (k, p, a) => {
    const fs = k.pipefs, ino = k.newInode(fs, 'p', 0o600, p.euid, p.egid);
    ino.pipe.id = ino.ino;   // 名前のないパイプの id は inode 番号と同じ（/proc/PID/fd の pipe:[番号] と一致する）
    const fl = (a[0] | 0);
    const ro = k.openInode(p, ino, O.RDONLY | (fl & O.NONBLOCK), 'pipe:[' + ino.ino + ']'), wo = k.openInode(p, ino, O.WRONLY | (fl & O.NONBLOCK), 'pipe:[' + ino.ino + ']');
    const r = k.fdAlloc(p, ro, 0, fl & O.CLOEXEC);
    if (r < 0) { ro.refs = 1; wo.refs = 1; k.ofdPut(ro); k.ofdPut(wo); return r; }
    const w = k.fdAlloc(p, wo, 0, fl & O.CLOEXEC);
    if (w < 0) { k.fdClose(p, r); wo.refs = 1; k.ofdPut(wo); return w; }
    k.ev('pipe', { pid: p.pid, r, w, id: ino.pipe.id });
    return [r, w];
  }, (a, r) => (Array.isArray(r) ? '[' + r[0] + ', ' + r[1] + ']' : ADDR), () => '0');

  K.statOf = function (ino) {
    return { dev: ino.fs.dev, ino: ino.ino, mode: TYPEBITS[ino.type] | ino.mode, nlink: ino.nlink, uid: ino.uid, gid: ino.gid, rdev: ino.rdev ? (ino.rdev[0] << 8) | ino.rdev[1] : 0,
      size: ino.type === 'p' ? 0 : ino.size, blksize: BS, blocks: ino.blocks.length * 8, atime: ino.atime, mtime: ino.mtime, ctime: ino.ctime };
  };
  def('stat', (k, p, a) => { const i = k.namei(p, String(a[0]), true); return typeof i === 'number' ? i : k.statOf(i); }, (a, r) => pstr(a) + ', ' + (typeof r === 'object' ? statStr(r) : ADDR), () => '0');
  def('lstat', (k, p, a) => { const i = k.namei(p, String(a[0]), false); return typeof i === 'number' ? i : k.statOf(i); }, (a, r) => pstr(a) + ', ' + (typeof r === 'object' ? statStr(r) : ADDR), () => '0');
  def('fstat', (k, p, a) => { const o = getOfd(p, a[0]); return o ? k.statOf(o.inode) : -E.EBADF; }, (a, r) => a[0] + ', ' + (typeof r === 'object' ? statStr(r) : ADDR), () => '0');
  def('access', (k, p, a) => {
    const i = k.namei(p, String(a[0]), true); if (typeof i === 'number') return i;
    const m = a[1] | 0; if (!m) return 0;
    const fake = { euid: p.uid, egid: p.gid, groups: p.groups };
    return k.may(fake, i, m) ? 0 : -E.EACCES;
  }, (a) => pstr(a) + ', ' + ([a[1] & 4 ? 'R_OK' : '', a[1] & 2 ? 'W_OK' : '', a[1] & 1 ? 'X_OK' : ''].filter(Boolean).join('|') || 'F_OK'));
  def('getdents64', (k, p, a) => {
    const o = getOfd(p, a[0]); if (!o) return -E.EBADF;
    const d = o.inode; if (d.type !== 'd') return -E.ENOTDIR;
    if (o.pos > 0) return [];
    o.pos = 1; d.atime = k.now();
    const out = [{ ino: d.ino, name: '.', type: 'd' }, { ino: k.dotdot(p, d).ino, name: '..', type: 'd' }];
    for (const name of k.dirNames(p, d)) { const c = k.lookup(p, d, name); if (c) out.push({ ino: c.ino, name, type: c.type }); }
    return out;
  }, (a, r) => a[0] + ', 0x55d0c4b1e2c0 /* ' + (Array.isArray(r) ? r.length : 0) + ' entries */, 32768', (r) => String(r.reduce((s, e) => s + 24 + ((e.name.length + 8) & ~7), 0)));

  // 作る・消す前の共通の検査
  K.preCreate = function (p, path, kind) {
    const w = this.walk(p, path, false);
    if (typeof w === 'number') return w;
    if (w.inode) return -E.EEXIST;
    if (this.roMnt(w)) return -E.EROFS;
    if (w.parent.fs.synth) return -E.ENOENT;
    if (w.parent.fs.ops && kind !== 'mkdir') return -E.EPERM;   // cgroup2 など：mkdir だけできる
    if (!this.may(p, w.parent, 3)) return -E.EACCES;
    if (w.parent.fs.ninodes >= w.parent.fs.inodesTotal) return -E.ENOSPC;
    return w;
  };
  K.sticky = function (p, dir, ino) { return (dir.mode & 0o1000) && p.euid !== 0 && p.euid !== ino.uid && p.euid !== dir.uid; };
  K.preRemove = function (p, path, kind) {
    const w = this.walk(p, path, false);
    if (typeof w === 'number') return w;
    if (!w.inode) return -E.ENOENT;
    if (!w.parent) return w.inode === p.root || w.inode.fs.root === w.inode ? -E.EBUSY : -E.EINVAL;
    if (this.roMnt(w)) return -E.EROFS;
    if (w.parent.fs.synth) return -E.EPERM;
    if (w.parent.fs.ops && kind !== 'rmdir') return -E.EPERM;
    if (w.inode.fs !== w.parent.fs) return -E.EBUSY;
    if (!this.may(p, w.parent, 3)) return -E.EACCES;
    if (this.sticky(p, w.parent, w.inode)) return -E.EPERM;
    return w;
  };
  def('mkdir', (k, p, a) => {
    const w = k.preCreate(p, String(a[0]), 'mkdir'); if (typeof w === 'number') return w;
    const ino = k.newInode(w.parent.fs, 'd', ((a[1] === undefined ? 0o777 : a[1]) & ~p.umask) | (w.parent.mode & 0o2000), p.euid, (w.parent.mode & 0o2000) ? w.parent.gid : p.egid);
    if (ino.fs.dirSize && ino.blocks.length === 0) { ino.fs.ninodes--; return -E.ENOSPC; }
    k.dirAdd(w.parent, w.name, ino);
    if (ino.fs.ops && ino.fs.ops.mkdir) ino.fs.ops.mkdir(k, p, w.parent, w.name, ino);
    k.ev('fs', { op: 'mkdir', path: k.fullPath(p, w), ino: ino.ino, pid: p.pid });
    return 0;
  }, (a) => pstr(a) + ', 0' + oct(a[1] === undefined ? 0o777 : a[1], 3));
  def('rmdir', (k, p, a) => {
    if (/(^|\/)\.\/*$/.test(String(a[0]))) return -E.EINVAL;
    const w = k.preRemove(p, String(a[0]).replace(/\/+$/, '') || '/', 'rmdir'); if (typeof w === 'number') return w;
    const d = w.inode;
    if (d.type !== 'd') return -E.ENOTDIR;
    if (d.fs.ops && d.fs.ops.rmdir) { const r = d.fs.ops.rmdir(k, p, d); if (r < 0) return r; }
    if (d.ents.size) return -E.ENOTEMPTY;
    if (p.ns.mnt.covered.has(d)) return -E.EBUSY;
    k.dirRemove(w.parent, w.name);
    k.ev('fs', { op: 'rmdir', path: k.fullPath(p, w), ino: d.ino, pid: p.pid });
    return 0;
  }, pstr);
  def('unlink', (k, p, a) => {
    const w = k.preRemove(p, String(a[0])); if (typeof w === 'number') return w;
    if (w.inode.type === 'd') return -E.EISDIR;
    k.dirRemove(w.parent, w.name);
    k.ev('fs', { op: 'unlink', path: k.fullPath(p, w), ino: w.inode.ino, nlink: w.inode.nlink, pid: p.pid });
    return 0;
  }, pstr);
  def('link', (k, p, a) => {
    const src = k.walk(p, String(a[0]), false); if (typeof src === 'number') return src;
    if (!src.inode) return -E.ENOENT;
    if (src.inode.type === 'd') return -E.EPERM;
    const w = k.preCreate(p, String(a[1])); if (typeof w === 'number') return w;
    if (w.parent.fs !== src.inode.fs) return -E.EXDEV;
    k.dirAdd(w.parent, w.name, src.inode);
    k.ev('fs', { op: 'link', path: k.fullPath(p, w), ino: src.inode.ino, nlink: src.inode.nlink, pid: p.pid });
    return 0;
  }, (a) => quote(String(a[0]), 4096) + ', ' + quote(String(a[1]), 4096));
  def('symlink', (k, p, a) => {
    const w = k.preCreate(p, String(a[1])); if (typeof w === 'number') return w;
    const ino = k.newInode(w.parent.fs, 'l', 0o777, p.euid, p.egid);
    ino.data = String(a[0]); ino.size = ino.data.length;
    k.dirAdd(w.parent, w.name, ino);
    k.ev('fs', { op: 'symlink', path: k.fullPath(p, w), ino: ino.ino, pid: p.pid });
    return 0;
  }, (a) => quote(String(a[0]), 4096) + ', ' + quote(String(a[1]), 4096));
  def('readlink', (k, p, a) => {
    const i = k.namei(p, String(a[0]), false); if (typeof i === 'number') return i;
    if (i.type !== 'l') return -E.EINVAL;
    return k.linkTarget(p, i);
  }, (a, r) => pstr(a) + ', ' + (typeof r === 'string' ? quote(r, 64) : ADDR) + ', 4096');
  def('rename', (k, p, a) => {
    const from = k.preRemove(p, String(a[0]).replace(/(.)\/+$/, '$1')); if (typeof from === 'number') return from;
    const to = k.walk(p, String(a[1]).replace(/(.)\/+$/, '$1'), false); if (typeof to === 'number') return to;
    if (!to.parent) return -E.EBUSY;
    if (k.roMnt(to)) return -E.EROFS;
    if (to.mnt !== from.mnt && from.mnt && to.mnt && (from.mnt.root || to.mnt.root)) return -E.EXDEV;
    if (to.parent.fs.synth) return -E.EPERM;
    if (to.parent.fs !== from.inode.fs) return -E.EXDEV;
    if (!k.may(p, to.parent, 3)) return -E.EACCES;
    const src = from.inode, dst = to.inode;
    if (src.type !== 'd' && (/[^/]\/+$/.test(String(a[0])) || /[^/]\/+$/.test(String(a[1])))) return -E.ENOTDIR;
    if (src === dst) return 0;
    if (src.type === 'd') { for (let d = to.parent; ; d = d.parent) { if (d === src) return -E.EINVAL; if (d === d.parent) break; } }
    if (dst) {
      if (src.type === 'd') { if (dst.type !== 'd') return -E.ENOTDIR; if (dst.ents.size) return -E.ENOTEMPTY; } else if (dst.type === 'd') return -E.EISDIR;
      if (k.sticky(p, to.parent, dst)) return -E.EPERM;
      if (p.ns.mnt.covered.has(dst)) return -E.EBUSY;
      k.dirRemove(to.parent, to.name);
    }
    from.parent.ents.delete(from.name); src.nlink--;
    if (src.type === 'd') from.parent.nlink--;
    if (!from.parent.fs.dirSize) from.parent.size = 40 + 20 * from.parent.ents.size;
    from.parent.mtime = from.parent.ctime = k.now();
    k.dirAdd(to.parent, to.name, src);
    k.ev('fs', { op: 'rename', path: k.fullPath(p, to), from: k.fullPath(p, from), ino: src.ino, pid: p.pid });
    return 0;
  }, (a) => quote(String(a[0]), 4096) + ', ' + quote(String(a[1]), 4096));
  K.doChmod = function (p, i, mode) {
    if (i.fs.synth) return -E.EPERM;
    if (p.euid !== 0 && p.euid !== i.uid) return -E.EPERM;
    i.mode = mode & 0o7777; i.ctime = this.now();
    return 0;
  };
  def('chmod', (k, p, a) => { const i = k.namei(p, String(a[0]), true); if (typeof i === 'number') return i; if (k.roMnt()) return -E.EROFS; const r = k.doChmod(p, i, a[1] | 0); if (r === 0) k.ev('fs', { op: 'chmod', path: dec(String(a[0])), ino: i.ino, pid: p.pid }); return r; }, (a) => pstr(a) + ', 0' + oct(a[1] | 0, 3));
  def('fchmod', (k, p, a) => { const o = getOfd(p, a[0]); return o ? k.doChmod(p, o.inode, a[1] | 0) : -E.EBADF; }, (a) => a[0] + ', 0' + oct(a[1] | 0, 3));
  K.doChown = function (p, i, uid, gid) {
    if (i.fs.synth) return -E.EPERM;
    uid = uid === undefined || uid === null ? -1 : uid | 0; gid = gid === undefined || gid === null ? -1 : gid | 0;
    if (p.euid !== 0) {
      if (uid !== -1 && uid !== i.uid) return -E.EPERM;
      if (p.euid !== i.uid) return -E.EPERM;
      if (gid !== -1 && !this.inGroup(p, gid)) return -E.EPERM;
    }
    if (uid !== -1) i.uid = uid;
    if (gid !== -1) i.gid = gid;
    if (i.type === 'f' && p.euid !== 0) i.mode &= ~0o6000;
    i.ctime = this.now();
    return 0;
  };
  def('chown', (k, p, a) => { const i = k.namei(p, String(a[0]), true); if (typeof i === 'number') return i; if (k.roMnt()) return -E.EROFS; const r = k.doChown(p, i, a[1], a[2]); if (r === 0) k.ev('fs', { op: 'chown', path: dec(String(a[0])), ino: i.ino, pid: p.pid }); return r; }, (a) => pstr(a) + ', ' + a[1] + ', ' + a[2]);
  def('lchown', (k, p, a) => { const i = k.namei(p, String(a[0]), false); return typeof i === 'number' ? i : k.roMnt() ? -E.EROFS : k.doChown(p, i, a[1], a[2]); }, (a) => pstr(a) + ', ' + a[1] + ', ' + a[2]);
  def('umask', (k, p, a) => { const o = p.umask; p.umask = a[0] & 0o777; return o; }, (a) => '0' + oct(a[0] | 0, 3), (r) => '0' + oct(r, 3));
  K.doTruncate = function (p, i, len) {
    if (i.type === 'd') return -E.EISDIR;
    if (i.type !== 'f' || i.fs.synth) return -E.EINVAL;
    len = Math.max(0, len | 0);
    const d = i.data;
    if (len > d.length) for (let j = Math.ceil(d.length / BS); j < Math.ceil(len / BS); j++) (i.holes || (i.holes = new Set())).add(j);   // 伸ばした部分は穴
    const r = this.setData(i, len <= d.length ? d.slice(0, len) : d + '\0'.repeat(len - d.length));
    if (r < 0) return r;
    this.emit('truncate', i);
    i.mtime = i.ctime = this.now();
    return 0;
  };
  def('truncate', (k, p, a) => { const i = k.namei(p, String(a[0]), true); if (typeof i === 'number') return i; if (k.roMnt()) return -E.EROFS; if (!k.may(p, i, 2)) return -E.EACCES; return k.doTruncate(p, i, a[1]); }, (a) => pstr(a) + ', ' + a[1]);
  def('ftruncate', (k, p, a) => { const o = getOfd(p, a[0]); if (!o) return -E.EBADF; if ((o.flags & 3) === O.RDONLY) return -E.EINVAL; return k.doTruncate(p, o.inode, a[1]); }, (a) => a[0] + ', ' + a[1]);
  def('utimensat', (k, p, a) => {
    const i = k.namei(p, String(a[0]), true); if (typeof i === 'number') return i;
    if (k.roMnt()) return -E.EROFS;
    if (i.fs.synth) return -E.EPERM;
    const t = a[1];
    if (p.euid !== 0 && p.euid !== i.uid && (t || !k.may(p, i, 2))) return t ? -E.EPERM : -E.EACCES;
    const now = k.now();
    i.atime = t && t.atime !== undefined ? t.atime : now; i.mtime = t && t.mtime !== undefined ? t.mtime : now; i.ctime = now;
    return 0;
  }, (a) => 'AT_FDCWD, ' + pstr(a) + ', ' + (a[1] ? '[' + tsStr(a[1].atime || 0) + ', ' + tsStr(a[1].mtime || 0) + ']' : 'NULL') + ', 0');
  def('mknod', (k, p, a) => {
    const mode = a[1] | 0, t = BITSTYPE[mode & S.IFMT] || 'f';
    if (t !== 'p' && t !== 'f' && p.euid !== 0) return -E.EPERM;
    if (t === 'd' || t === 'l') return -E.EINVAL;
    const w = k.preCreate(p, String(a[0])); if (typeof w === 'number') return w;
    const ino = k.newInode(w.parent.fs, t, (mode & 0o7777) & ~p.umask, p.euid, p.egid);
    if (t === 'c' || t === 'b') ino.rdev = [(a[2] >> 8) & 0xfff, a[2] & 0xff];
    k.dirAdd(w.parent, w.name, ino);
    k.ev('fs', { op: 'mknod', path: k.fullPath(p, w), ino: ino.ino, pid: p.pid });
    return 0;
  }, (a) => pstr(a) + ', ' + ({ p: 'S_IFIFO', c: 'S_IFCHR', b: 'S_IFBLK', f: 'S_IFREG', s: 'S_IFSOCK' }[BITSTYPE[a[1] & S.IFMT] || 'f']) + '|0' + oct(a[1] & 0o7777, 3) + (a[2] ? ', makedev(' + (a[2] >> 8) + ', ' + (a[2] & 255) + ')' : ''));
  def('chdir', (k, p, a) => {
    const w = k.walk(p, String(a[0]), true); if (typeof w === 'number') return w;
    const i = w.inode; if (!i) return -E.ENOENT;
    if (i.type !== 'd') return -E.ENOTDIR;
    if (!k.may(p, i, 1)) return -E.EACCES;
    p.cwd = i; p.cwdStack = w.stack && w.stack[0].ino === p.root ? w.stack : null;
    k.ev('chdir', { pid: p.pid, path: dec(k.pathOf(p, i) || '') });
    return 0;
  }, pstr);
  def('fchdir', (k, p, a) => { const o = getOfd(p, a[0]); if (!o) return -E.EBADF; if (o.inode.type !== 'd') return -E.ENOTDIR; if (!k.may(p, o.inode, 1)) return -E.EACCES; p.cwd = o.inode; p.cwdStack = null; return 0; }, (a) => String(a[0]));
  def('getcwd', (k, p) => k.cwdPath(p) || -E.ENOENT, (a, r) => (typeof r === 'string' ? quote(r, 4096) : ADDR) + ', 4096', (r) => String(r.length + 1));

  def('mount', (k, p, a) => {
    if (p.euid !== 0) return -E.EPERM;
    const w = k.walk(p, String(a[1]), true); if (typeof w === 'number') return w;
    if (!w.inode) return -E.ENOENT;
    const fl = a[3] | 0, MS_RDONLY = 1, MS_REMOUNT = 32, MS_BIND = 4096;
    const data = String(a[4] || '').split(',').filter((o) => o && o !== 'ro' && o !== 'rw' && o !== 'remount' && o !== 'bind').join(',');
    if (fl & MS_REMOUNT) {
      // 付け直し：ro / rw を切り替える（バインドマウントなら、そのマウントだけ）
      const m = w.mnt;
      if (!m || (m.root || m.fs.root) !== w.inode) return -E.EINVAL;
      m.ro = !!(fl & MS_RDONLY);
      m.opts = (m.ro ? 'ro' : 'rw') + m.opts.replace(/^r[ow]/, '');
      k.ev('mount', { pid: p.pid, target: String(a[1]), fstype: m.type, remount: true });
      return 0;
    }
    if (fl & MS_BIND) {
      // バインドマウント：すでに木の中にあるディレクトリを、別の場所にも見せる（中身は同じ inode）
      const src = k.walk(p, String(a[0]), true); if (typeof src === 'number') return src;
      if (!src.inode) return -E.ENOENT;
      if ((src.inode.type === 'd') !== (w.inode.type === 'd')) return -E.ENOTDIR;
      if (w.inode.type !== 'd') return -E.ENOTDIR;
      const sm = src.mnt, m = k.doMount(p.ns, src.inode.fs, w.inode, k.cwdPathOf(p, String(a[1])), { opts: (sm ? sm.opts : 'rw,relatime') });
      m.root = src.inode; m.source = sm ? sm.source : src.inode.fs.source; m.bindFrom = k.fullPath(p, src);
      (p.ns.mnt.binds || (p.ns.mnt.binds = new Set())).add(src.inode);
      k.ev('mount', { pid: p.pid, target: String(a[1]), fstype: m.type, bind: true });
      return 0;
    }
    if (w.inode.type !== 'd') return -E.ENOTDIR;
    const type = String(a[2] || ''), mk = k.fstypes[type];
    if (!mk) return -E.ENODEV;
    const fs = mk(k, String(a[0] || type), data, p);
    if (typeof fs === 'number') return fs;
    let covered = w.inode;
    if (covered === covered.fs.root) { const m = k.mountOf(p.ns, covered.fs); if (m && m.covered) { /* 重ねてマウント：いまの根を覆う */ } }
    if (covered.fs.synth && covered !== covered.fs.root && !(covered.node && covered.node.pin)) return -E.EINVAL;
    const m = k.doMount(p.ns, fs, covered, k.cwdPathOf(p, String(a[1])) || k.pathOf(p, covered) || String(a[1]), { opts: (fl & MS_RDONLY ? 'ro' : 'rw') + ',relatime' + (fs.mopts ? ',' + fs.mopts : data ? ',' + data : '') });
    if (fl & MS_RDONLY) m.ro = true;
    k.ev('mount', { pid: p.pid, target: String(a[1]), fstype: type });
    return 0;
  }, (a) => quote(String(a[0] || '')) + ', ' + quote(String(a[1])) + ', ' + (a[2] ? quote(String(a[2])) : 'NULL') + ', ' + (['MS_RDONLY', 'MS_REMOUNT', 'MS_BIND'].filter((n, i) => (a[3] | 0) & [1, 32, 4096][i]).join('|') || '0') + ', ' + (a[4] ? quote(String(a[4])) : 'NULL'));
  // パスの文字列 → そのディレクトリの絶対パス（たどった道で）
  K.cwdPathOf = function (p, path) { const w = this.walk(p, path, true); if (typeof w !== 'object' || !w.stack || w.stack[0].ino !== p.root) return null; return '/' + w.stack.slice(1).map((e) => (e.via || e.ino).name).join('/'); };
  def('umount2', (k, p, a) => {
    if (p.euid !== 0) return -E.EPERM;
    const w = k.walk(p, String(a[0]), true); if (typeof w === 'number') return w;
    const i = w.inode; if (!i) return -E.ENOENT;
    const m = w.mnt;
    if (!m || (m.root || m.fs.root) !== i) return -E.EINVAL;
    if (!m.covered || m.pinned) return -E.EBUSY;   // / と、起動時からの proc・sys・dev は外せない
    const inM = (ino, mm) => (mm ? mm === m : !m.root && ino.fs === i.fs);
    for (const q of k.procs.values()) {
      if (q.ns.mnt !== p.ns.mnt) continue;
      const cs = q.cwdStack && q.cwdStack[q.cwdStack.length - 1].ino === q.cwd ? q.cwdStack : null;
      if (q.cwd && (cs ? cs.some((e) => e.mnt === m) : inM(q.cwd, null))) return -E.EBUSY;
      for (const e of q.fds) if (e && inM(e.ofd.inode, e.ofd.mnt)) return -E.EBUSY;
    }
    for (const m2 of p.ns.mnt.list) if (m2 !== m && m2.covered && (m.root ? false : m2.covered.fs === i.fs)) return -E.EBUSY;
    p.ns.mnt.list.splice(p.ns.mnt.list.indexOf(m), 1);
    p.ns.mnt.covered.delete(m.covered);
    if (m.root && p.ns.mnt.binds) p.ns.mnt.binds.delete(m.root);
    // 同じ場所に重ねていた下のマウントがあれば、それがまた見える
    for (let j = p.ns.mnt.list.length - 1; j >= 0; j--) if (p.ns.mnt.list[j].covered === m.covered) { p.ns.mnt.covered.set(m.covered, p.ns.mnt.list[j]); break; }
    k.ev('umount', { pid: p.pid, target: String(a[0]) });
    return 0;
  }, (a) => pstr(a) + ', 0');
  def('statfs', (k, p, a) => {
    const i = k.namei(p, String(a[0]), true); if (typeof i === 'number') return i;
    const fs = i.fs;
    return { type: fs.type, bsize: BS, blocks: fs.blocksTotal, bfree: fs.blocksTotal - fs.blocksUsed, bavail: fs.blocksTotal - fs.blocksUsed, files: fs.inodesTotal, ffree: Math.max(0, fs.inodesTotal - fs.ninodes) };
  }, (a, r) => pstr(a) + ', ' + (typeof r === 'object' ? '{f_type=' + r.type.toUpperCase() + '_SUPER_MAGIC, f_bsize=4096, f_blocks=' + r.blocks + ', f_bfree=' + r.bfree + ', ...}' : ADDR), () => '0');

  def('nanosleep', (k, p, a, req) => {
    if (req.done) return 0;
    if (!req.armed) { req.armed = true; const ms = Math.max(0, Math.round(+a[0] || 0)); if (ms === 0) return 0; req.timer = k.timer(k.clock + ms, () => { req.done = true; req.timer = null; if (p.sc === req) k.wakeProc(p); }); }
    return k.block(p, p.swait || (p.swait = []));
  }, (a) => tsStr(Math.round(+a[0] || 0)) + ', NULL');
  def('sched_yield', (k, p) => { p.yielded = true; return 0; });
  def('fsync', (k, p, a) => { const o = getOfd(p, a[0]); if (!o) return -E.EBADF; k.emit('fsync', o.inode, p); return 0; }, (a) => String(a[0]));
  def('sync', (k, p) => { k.emit('sync', p); return 0; });
  def('ioctl', (k, p, a) => {
    const o = getOfd(p, a[0]); if (!o) return -E.EBADF;
    const ino = o.inode, dv = ino.type === 'c' ? k.devOf(ino) : null;
    if (!dv || !dv.ioctl) return -E.ENOTTY;
    return dv.ioctl(k, p, o, a[1], a[2], ino);
  }, (a, r) => a[0] + ', ' + ({ 0x5401: 'TCGETS', 0x540f: 'TIOCGPGRP', 0x5410: 'TIOCSPGRP', 0x5413: 'TIOCGWINSZ' }[a[1]] || '0x' + (a[1] | 0).toString(16)) + ', ' + (a[1] === TIO.TIOCSPGRP ? '[' + a[2] + ']' : a[1] === TIO.TIOCGPGRP && typeof r === 'number' && r >= 0 ? '[' + r + ']' : a[1] === TIO.TIOCGWINSZ && r && typeof r === 'object' ? '{ws_row=' + r.rows + ', ws_col=' + r.cols + ', ws_xpixel=0, ws_ypixel=0}' : a[1] === TIO.TCGETS && !(r < 0) ? '{B38400 opost isig icanon echo ...}' : ADDR), () => '0');
  def('uname', (k, p) => Object.assign({ nodename: p.ns.uts.hostname }, k.uname), (a, r) => '{sysname="Linux", nodename=' + quote(r.nodename) + ', ...}', () => '0');
  def('sethostname', (k, p, a) => { if (p.euid !== 0) return -E.EPERM; const n = String(a[0]); if (n.length > 64 || !n) return -E.EINVAL; p.ns.uts.hostname = n; return 0; }, (a) => pstr(a) + ', ' + String(a[0]).length);
  def('clock_gettime', (k) => k.now(), (a, r) => 'CLOCK_REALTIME, ' + tsStr(r), () => '0');
  def('getrandom', (k, p, a) => { let s = ''; for (let i = 0; i < (a[0] | 0); i++) s += String.fromCharCode(k.rand() & 255); return s; }, (a, r) => quote(r, 16) + ', ' + a[0] + ', 0');
  def('ptrace', (k, p, a) => {
    if (a[0] !== 'PTRACE_TRACEME') return -E.EINVAL;
    const o = a[1] || {}, e = p.fds[o.fd === undefined ? 2 : o.fd];
    if (!e) return -E.EBADF;
    const sink = { ofd: e.ofd, pids: new Set(), users: 0, filter: o.filter ? new Set(o.filter) : null, count: o.count || null };
    e.ofd.refs++;
    k.setTrace(p, sink, { live: false, follow: !!o.follow, onExec: true });
    return 0;
  }, () => 'PTRACE_TRACEME');
  // 複数の fd を同時に待つ。fds = [{ fd, events: 'r' | 'w' | 'rw' }]、timeout はミリ秒（-1 か省略でずっと待つ）。準備のできたものの配列 [{ fd, r, w, hup, err, nval }] を返す
  K.pollOfd = function (p, ofd) {
    const ino = ofd.inode;
    switch (ino.type) {
      case 'p': { const pp = ino.pipe, eof = pp.writers === 0 && (pp.hadWriter || !ino.nlink); return { r: pp.buf.length > 0 || eof, w: pp.readers === 0 || pp.buf.length < pp.cap, hup: eof && !!ofd.pr, rq: pp.rwait, wq: pp.wwait }; }
      case 'c': { const dv = this.devOf(ino); return dv && dv.poll ? dv.poll(this, p, ofd, ino) : { r: true, w: true }; }
      case 's': return this.sockPoll ? this.sockPoll(p, ofd) : { r: true, w: true, err: true };
      default: return { r: true, w: true };
    }
  };
  def('poll', (k, p, a, req) => {
    const fds = a[0] || [], out = [], st = [];
    for (const f of fds) {
      const o = getOfd(p, f.fd), ev = f.events || 'r';
      if (!o) { out.push({ fd: f.fd, r: false, w: false, hup: false, err: false, nval: true }); continue; }
      const s = k.pollOfd(p, o), r = !!s.r && ev.indexOf('r') >= 0, w = !!s.w && ev.indexOf('w') >= 0;
      if (r || w || s.hup || s.err) out.push({ fd: f.fd, r, w, hup: !!s.hup, err: !!s.err, nval: false });
      st.push([s, ev]);
    }
    if (out.length || req.timedOut) { if (req.timer) { k.cancelTimer(req.timer); req.timer = null; } return out; }
    const tmo = a[1] === undefined || a[1] === null ? -1 : a[1] | 0;
    if (tmo === 0) return out;
    if (tmo > 0 && !req.timer) req.timer = k.timer(k.clock + tmo, () => { req.timedOut = true; req.timer = null; if (p.sc === req) k.wakeProc(p); });
    let any = false;
    for (const [s, ev] of st) { if (ev.indexOf('r') >= 0 && s.rq) { k.block(p, s.rq); any = true; } if (ev.indexOf('w') >= 0 && s.wq) { k.block(p, s.wq); any = true; } }
    if (!any) k.block(p, p.swait || (p.swait = []));
    return BLOCK;
  }, (a, r) => { const ev = (e) => (e === 'w' ? 'POLLOUT' : e === 'rw' ? 'POLLIN|POLLOUT' : 'POLLIN'); return '[' + (a[0] || []).map((f) => '{fd=' + f.fd + ', events=' + ev(f.events) + '}').join(', ') + '], ' + (a[0] || []).length + ', ' + (a[1] === undefined || a[1] === null ? -1 : a[1]); },
  (r) => (r.length ? r.length + ' ([' + r.map((f) => '{fd=' + f.fd + ', revents=' + ([f.r ? 'POLLIN' : '', f.w ? 'POLLOUT' : '', f.err ? 'POLLERR' : '', f.hup ? 'POLLHUP' : '', f.nval ? 'POLLNVAL' : ''].filter(Boolean).join('|')) + '}').join(', ') + '])' : '0 (Timeout)'));
  // CPU 時間（ミリ秒）。times → { utime, stime, cutime, cstime }、getrusage(0 = 自分 | -1 = 回収した子) → { utime, stime, maxrss（kB）, minflt, majflt, inblock, oublock, nvcsw, nivcsw }
  def('times', (k, p) => ({ utime: p.utime, stime: p.stime, cutime: p.cutime, cstime: p.cstime }),
    (a, r) => '{tms_utime=' + Math.floor(r.utime / 10) + ', tms_stime=' + Math.floor(r.stime / 10) + ', tms_cutime=' + Math.floor(r.cutime / 10) + ', tms_cstime=' + Math.floor(r.cstime / 10) + '}', (r, a, p) => String(1718000000 + Math.floor((p.start + p.utime + p.stime) / 10)));
  def('getrusage', (k, p, a) => ((a[0] | 0) === -1
    ? { utime: p.cutime, stime: p.cstime, maxrss: p.cmaxrss, minflt: p.cminflt, majflt: p.cmajflt, inblock: p.cinblock, oublock: p.coublock, nvcsw: p.cnvcsw, nivcsw: p.cnivcsw }
    : { utime: p.utime, stime: p.stime, maxrss: p.maxrss, minflt: p.minflt, majflt: p.majflt, inblock: p.inblock, oublock: p.oublock, nvcsw: p.nvcsw, nivcsw: p.nivcsw }),
  (a, r) => ((a[0] | 0) === -1 ? 'RUSAGE_CHILDREN' : 'RUSAGE_SELF') + ', {ru_utime={tv_sec=' + Math.floor(r.utime / 1000) + ', tv_usec=' + (r.utime % 1000) * 1000 + '}, ru_stime={tv_sec=' + Math.floor(r.stime / 1000) + ', tv_usec=' + (r.stime % 1000) * 1000 + '}, ...}', () => '0');
  for (const n of ['brk', 'mmap', 'munmap', 'mprotect', 'setpriority', 'getpriority', 'socket', 'bind', 'listen', 'accept', 'connect', 'shutdown', 'getsockname', 'getpeername', 'unshare', 'setns', 'chroot', 'pivot_root', 'reboot']) def(n, () => -E.ENOSYS, (a) => a.map((x) => (typeof x === 'string' ? quote(x) : typeof x === 'number' ? String(x) : '...')).join(', '));
  // シミュレータ専用（strace には出ない）：セッションのシェルが次のコマンド行を待つ
  // 本物の cat が fstat(1) と fstat(3) で確かめること（入力と出力が同じ普通のファイルか）を、strace に出さずに調べる
  def('_samefile', (k, p, a) => { const x = getOfd(p, a[0]), y = getOfd(p, a[1]); return !!(x && y && x.inode === y.inode && x.inode.type === 'f' && x.inode.size > 0); });
  def('_prompt', (k, p, a) => {
    const ses = p.ses; if (!ses) return -E.ENOSYS;
    if (ses.pending) { const j = ses.pending; ses.pending = null; ses.idle = false; return j; }
    ses.idle = true; ses.status = a[0] | 0;
    return k.block(p, ses.wq);
  });

  // ════════════ 起動 ════════════
  K.mkdirp = function (path, mode, uid, gid) {
    let cur = this.rootfs.root;
    for (const name of path.split('/').filter(Boolean)) {
      cur = this.cross(this.kcred, cur);
      let n = cur.ents.get(name);
      if (!n) { n = this.newInode(cur.fs, 'd', mode === undefined ? 0o755 : mode, uid | 0, gid | 0); this.dirAdd(cur, name, n); }
      cur = n;
    }
    return this.cross(this.kcred, cur);
  };
  K.writeFile = function (path, data, mode, uid, gid, mtime) {
    const dir = this.mkdirp(dirname(path)), name = basename(path);
    let ino = dir.ents.get(name);
    if (!ino) { ino = this.newInode(dir.fs, 'f', mode === undefined ? 0o644 : mode, uid | 0, gid | 0); this.dirAdd(dir, name, ino); }
    this.setData(ino, data);
    if (mtime !== undefined) ino.mtime = ino.atime = ino.ctime = mtime;
    return ino;
  };
  K.mkSymlink = function (target, path, mtime) {
    const dir = this.mkdirp(dirname(path)), ino = this.newInode(dir.fs, 'l', 0o777, 0, 0);
    ino.data = target; ino.size = target.length;
    this.dirAdd(dir, basename(path), ino);
    if (mtime !== undefined) ino.mtime = ino.atime = ino.ctime = mtime;
    return ino;
  };
  K.mkDev = function (path, major, minor, mode, uid, gid) {
    const dir = this.mkdirp(dirname(path)), ino = this.newInode(dir.fs, 'c', mode, uid | 0, gid | 0);
    ino.rdev = [major, minor];
    this.dirAdd(dir, basename(path), ino);
    return ino;
  };
  K.mkTty = function () {
    const n = this.ttys.length, tty = { n, name: 'pts/' + n, inbuf: '', eof: false, interactive: false, fg: 0, sid: 0, out: null, outBytes: 0, rwait: [], rows: 24, cols: 80 };
    this.ttys.push(tty);
    return tty;
  };
  K.initDevs = function () {
    const k = this;
    const nul = { read: () => '', write: (k2, p, o, d) => d.length };
    this.devs.set('1:3', nul);
    this.devs.set('1:5', { read: (k2, p, o, n) => '\0'.repeat(n), write: (k2, p, o, d) => d.length });
    this.devs.set('1:7', { read: (k2, p, o, n) => '\0'.repeat(n), write: () => -E.ENOSPC });
    const rnd = { read: (k2, p, o, n) => { let s = ''; n = Math.min(n, 65536); for (let i = 0; i < n; i++) s += String.fromCharCode(k.rand() & 255); return s; }, write: (k2, p, o, d) => d.length };
    this.devs.set('1:8', rnd); this.devs.set('1:9', rnd);
    const ttyOf = (p, ino, ofd) => (ofd && ofd.tty) || (ino.rdev[0] === 136 ? k.ttys[ino.rdev[1]] : p.tty);
    const tdev = {
      open(k2, p, ofd, ino) { ofd.tty = ttyOf(p, ino, null); },
      read(k2, p, ofd, n, ino) {
        const t = ttyOf(p, ino, ofd); if (!t) return -E.ENXIO;
        // 端末の前景にいないプロセスグループが読もうとした：SIGTTIN でグループごと止める（無視・ブロックしていれば EIO）
        if (t.sid && p.sid === t.sid && t.fg && p.pgid !== t.fg) {
          const bit = 1 << SIG.TTIN;
          if (p.sig.act[SIG.TTIN] === 'ign' || (p.sig.mask & bit)) return -E.EIO;
          k.killpg(p.pgid, SIG.TTIN, null);
          return -E.EINTR;
        }
        if (t.inbuf.length) { let i = t.inbuf.indexOf('\n'); i = i < 0 ? t.inbuf.length : i + 1; if (i > n) i = n; const d = t.inbuf.slice(0, i); t.inbuf = t.inbuf.slice(i); return d; }
        if (t.eof) { t.eof = false; return ''; }
        if (!t.interactive) return '';
        return k.block(p, t.rwait);
      },
      write(k2, p, ofd, d, ino) {
        const t = ttyOf(p, ino, ofd); if (!t) return -E.ENXIO;
        if (t.out) { const s = ofd.err ? 'err' : 'out', l = t.out.length; if (l && t.out[l - 1].s === s) t.out[l - 1].text += d; else t.out.push({ s, text: d }); t.outBytes += d.length; }
        return d.length;
      },
      // 後ろ（前景でないプロセスグループ）からの poll は、打たれた文字があるときだけ「読める」（読めば SIGTTIN で止まる）
      poll(k2, p, ofd, ino) { const t = ttyOf(p, ino, ofd); if (t && t.sid && p.sid === t.sid && t.fg && p.pgid !== t.fg) return { r: t.inbuf.length > 0, w: true, rq: t.rwait }; return t ? { r: t.inbuf.length > 0 || t.eof || !t.interactive, w: true, rq: t.rwait } : { r: true, w: true }; },
      ioctl(k2, p, ofd, req, arg, ino) {
        const t = ttyOf(p, ino, ofd); if (!t) return -E.ENOTTY;
        if (req === TIO.TCGETS) return 0;
        if (req === TIO.TIOCGPGRP) return t.fg;
        if (req === TIO.TIOCSPGRP) { t.fg = arg | 0; return 0; }
        if (req === TIO.TIOCGWINSZ) return { rows: t.rows, cols: t.cols };
        return -E.EINVAL;
      },
    };
    this.devs.set('5:0', tdev); this.devs.set('5:1', tdev); this.devs.set('136:*', tdev);
  };

  K.boot = function () {
    const k = this, o = this.o;
    this.initDevs();
    // 根（ext4 風）
    // o.disk があれば、そのディスク（前の起動の / の中身）をそのまま使う（再起動）
    const rootfs = this.rootfs = o.disk || this.mkfs('ext4', '/dev/sda1', { dev: 0x801, firstIno: 2, blocks: o.diskBlocks || 16384, firstBlock: 1057, dirSize: 4096, inodes: 16384 });
    this.reused = !!o.disk;
    this.pipefs = this.mkfs('pipefs', 'pipefs', { dev: 0xd, blocks: 0 });
    this.doMount(this.ns0, rootfs, null, '/', { opts: 'rw,relatime' });
    this.kcred.root = this.kcred.cwd = rootfs.root;
    this.fstypes.tmpfs = (k2, src, data) => {
      let blocks = 2048; const m = /size=(\d+)([kKmMgG]?)/.exec(data || ''); if (m) blocks = Math.ceil(+m[1] * ({ k: 1024, m: 1048576, g: 1073741824 }[m[2].toLowerCase()] || 1) / BS);
      const ni = /nr_inodes=(\d+)([kKmM]?)/.exec(data || ''), inodes = ni ? +ni[1] * ({ k: 1024, m: 1048576 }[ni[2].toLowerCase()] || 1) : 7424;   // 本物の既定は「メモリのページ数の半分」
      const fs = k2.mkfs('tmpfs', src || 'tmpfs', { blocks, mode: 0o1777, inodes });
      const md = /mode=([0-7]+)/.exec(data || ''); if (md) fs.root.mode = parseInt(md[1], 8);
      fs.mopts = 'size=' + blocks * 4 + 'k' + (ni ? ',nr_inodes=' + inodes : '') + (md ? ',mode=' + md[1] : '');
      return fs;
    };
    this.fstypes.ramfs = (k2, src) => k2.mkfs('ramfs', src || 'ramfs', { blocks: 1 << 20, mode: 0o755 });
    this.fstypes.proc = (k2, src, data, p) => (p && p.ns && p.ns.pid && p.ns.pid.level > 0 && k.mkProcfs ? k.mkProcfs(p.ns.pid) : k.procfs);
    this.fstypes.devtmpfs = () => k.devfs;
    this.procfs = this.mkSynth('proc', 'proc');
    this.devfs = this.mkfs('devtmpfs', 'udev', { blocks: 1024, mode: 0o755 });
    LNX.rootfs(this);
    for (const pl of PLUGINS) this.sub[pl.name] = pl.init(this) || {};
    this.emit('boot', this);
    // PID 1
    const init = this.newProc(null);
    init.cwd = init.root = rootfs.root; init.sid = init.pgid = 1;
    const nul = this.namei(this.kcred, '/dev/null');
    const o0 = this.openInode(init, nul, O.RDWR, '/dev/null');
    this.fdAlloc(init, o0, 0); this.fdAlloc(init, o0, 1); this.fdAlloc(init, o0, 2);
    const r = this.loadProg(init, '/usr/sbin/init', ['/sbin/init'], { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/', TERM: 'linux' });
    if (r < 0) throw new Error('init を起動できません: ' + ENAME[-r]);
    init.exe = '/usr/sbin/init';
    this.setState(init, 'R');
  };
  // ログインしたシェル（セッション）を作る
  K.newSession = function (user) {
    const pw = this.users().find((u) => u.name === user);
    if (!pw) throw new Error('そのユーザーはいません: ' + user);
    const old = this.sessions.get(user);
    const init = this.procs.get(1), p = this.newProc(init), tty = old ? old.tty : this.mkTty();
    if (!this.devfs.root.ents.get('pts').ents.has(String(tty.n))) this.mkDev('/dev/pts/' + tty.n, 136, tty.n, 0o620, pw.uid, 5);
    p.uid = p.euid = pw.uid; p.gid = p.egid = pw.gid;
    p.groups = this.groupsOf(user, pw.gid);
    p.sid = p.pgid = p.pid; p.tty = tty; tty.fg = p.pid; tty.sid = p.pid;
    for (let fd = p.fds.length - 1; fd >= 0; fd--) if (p.fds[fd]) this.fdClose(p, fd);
    const ino = this.namei(this.kcred, '/dev/pts/' + tty.n);
    const o1 = this.openInode(p, ino, O.RDWR, '/dev/pts/' + tty.n), o2 = this.openInode(p, ino, O.RDWR, '/dev/pts/' + tty.n);
    o1.tty = o2.tty = tty; o2.err = true;
    this.fdAlloc(p, o1, 0); this.fdAlloc(p, o1, 1); this.fdAlloc(p, o2, 2);
    const home = this.namei(this.kcred, pw.home);
    p.cwd = typeof home === 'number' ? this.rootfs.root : home;
    p.sig.act = {}; p.sig.mask = 0;
    const env = { HOME: pw.home, USER: user, LOGNAME: user, SHELL: '/bin/sh', PATH: (pw.uid === 0 ? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' : '/usr/local/bin:/usr/bin:/bin'), TERM: 'xterm-256color', LANG: 'ja_JP.UTF-8', PWD: typeof home === 'number' ? '/' : pw.home };
    const ses = { user, uid: pw.uid, proc: p, tty, pending: null, idle: false, status: 0, wq: [] };
    p.ses = ses;
    const r = this.loadProg(p, '/usr/bin/sh', ['-sh'], env);
    if (r < 0) throw new Error('sh を起動できません: ' + ENAME[-r]);
    this.sessions.set(user, ses);
    this.ev('fork', { pid: p.pid, ppid: 1, comm: 'sh' });
    this.setState(p, 'R');
    return ses;
  };
  K.users = function () {
    const i = this.namei(this.kcred, '/etc/passwd');
    return (typeof i === 'number' ? '' : i.data).split('\n').filter(Boolean).map((l) => { const f = l.split(':'); return { name: f[0], uid: +f[2], gid: +f[3], gecos: f[4], home: f[5], shell: f[6] }; });
  };
  K.groups = function () {
    const i = this.namei(this.kcred, '/etc/group');
    return (typeof i === 'number' ? '' : i.data).split('\n').filter(Boolean).map((l) => { const f = l.split(':'); return { name: f[0], gid: +f[2], members: f[3] ? f[3].split(',') : [] }; });
  };
  K.groupsOf = function (user, gid) { const g = [gid]; for (const x of this.groups()) if (x.members.indexOf(user) >= 0 && g.indexOf(x.gid) < 0) g.push(x.gid); return g.sort((a, b) => a - b); };

  // ════════════════════════ 機械（外から使う API）════════════════════════
  function Machine(opts) {
    this.opts = Object.assign({ seed: 1, user: 'you', hostname: 'zukai', epoch: Date.UTC(2026, 3, 1, 0, 0, 0), maxTicks: 200000, maxTime: 3600000, maxOutput: 1 << 18 }, opts || {});
    this.log = [];
    this.fs = new FsApi(this);
    this._boot();
  }
  const M = Machine.prototype;
  M._boot = function () {
    const k = this.k = new Kernel(this.opts);
    this.kernel = k;
    this.cur = null; this.lastRunAt = k.now();
    k.booting = true;
    k.boot();
    k.newSession(this.opts.user);
    this._settle();
    k.booting = false;
    this.bootTicks = k.clock;
  };
  M._settle = function () {
    const k = this.k;
    for (let g = 0; g < 200000; g++) {
      let busy = false;
      for (const s of k.sessions.values()) if (!s.idle) busy = true;
      if (!busy && !k.sched.nr()) return;
      if (!busy && g > 2000) return;
      if (!k.quantum(k.clock)) return;
    }
  };
  M._session = function (user) {
    user = user || this.opts.user;
    let s = this.k.sessions.get(user);
    if (!s || s.proc.state === 'Z' || !this.k.procs.has(s.proc.pid)) { s = this.k.newSession(user); this._settle(); }
    return s;
  };
  const KEYSIG = { '^C': SIG.INT, '^Z': SIG.TSTP, '^\\': SIG.QUIT };
  // 実行を始める。返すハンドルの step(n) で少しずつ進める（画面用）。run はこれを最後まで回す
  M.start = function (cmd, opts) {
    if (this.cur && !this.cur.done) throw new Error('前のコマンドがまだ終わっていません');
    opts = Object.assign({}, opts || {});
    const k = this.k, ses = this._session(opts.user), tty = ses.tty, m = this;
    const h = { cmd, opts, ses, done: false, waiting: null, t0: k.clock, s0: k.steps, reason: null, result: null, ev: [], sent: 0,
      maxTicks: opts.maxTicks || this.opts.maxTicks, maxTime: opts.maxTime || this.opts.maxTime, maxOutput: opts.maxOutput || this.opts.maxOutput };
    h.keys = (opts.keys || []).slice().sort((a, b) => (a.at | 0) - (b.at | 0));
    h.replay = opts._ev ? opts._ev.slice() : null;
    tty.out = []; tty.outBytes = 0; tty.inbuf = opts.stdin ? enc(opts.stdin) : ''; tty.eof = false; tty.interactive = !!opts.interactive;
    k.evlog = []; k.evn = 0; k.tevn = 0; this.lastRunAt = k.now();
    k.evcat = null;
    if (opts.trace) { k.evcat = {}; for (const c of (Array.isArray(opts.trace) ? opts.trace : String(opts.trace).split(/[,\s]+/))) if (c) k.evcat[c] = true; if (k.evcat.all) for (const c of ['mem', 'sched', 'pagecache', 'net']) k.evcat[c] = true; }
    h.sink = null;
    if (opts.strace) { h.sink = { lines: [], pids: new Set(), users: 0, filter: null }; k.setTrace(ses.proc, h.sink, { live: opts.strace === 'all', follow: true, onExec: true }); }
    ses.pending = { src: enc(cmd), opts: { xtrace: !!opts.xtrace } }; ses.idle = false;
    k.wake(ses.wq);
    h.step = (n) => m._drive(h, n === undefined ? 100 : n);
    h.take = () => { if (h.done) { const o = (h._out || []).slice(h.sent); h.sent = (h._out || []).length; return o.filter((c) => c.text !== '').map((c) => ({ s: c.s, text: dec(c.text) })); } const o = tty.out ? tty.out.slice(h.sent) : []; if (tty.out) { h.sent = tty.out.length; if (h.sent) { const last = tty.out[h.sent - 1]; tty.out.push({ s: last.s, text: '' }); h.sent = tty.out.length - 1; } } return o.filter((c) => c.text !== '').map((c) => ({ s: c.s, text: dec(c.text) })); };
    this.cur = h;
    return h;
  };
  M._apply = function (h, e, record) {
    const k = this.k, tty = h.ses.tty;
    if (record) h.ev.push({ step: k.steps - h.s0, at: k.clock - h.t0, type: e.type, sig: e.sig, text: e.text });
    if (e.type === 'sig') k.killpg(tty.fg, e.sig, null);
    else if (e.type === 'input') { tty.inbuf += enc(e.text); k.wake(tty.rwait); } else if (e.type === 'eof') { tty.eof = true; k.wake(tty.rwait); }
  };
  M._key = function (key) { if (KEYSIG[key]) return { type: 'sig', sig: KEYSIG[key] }; if (key === '^D') return { type: 'eof' }; return { type: 'input', text: key }; };
  M._alive = function (h) { const s = h.ses; return !s.idle && s.proc.state !== 'Z' && this.k.procs.get(s.proc.pid) === s.proc; };
  M._drive = function (h, budget) {
    if (h.done) return h.result;
    const k = this.k, endClock = k.clock + budget;
    h.waiting = null; h.sleeping = false;
    while (this._alive(h)) {
      if (k.rebootReq) return this._reboot(h);
      while (h.replay && h.replay.length && k.steps - h.s0 >= h.replay[0].step && k.clock - h.t0 >= h.replay[0].at) this._apply(h, h.replay.shift(), true);
      while (h.keys.length && k.clock - h.t0 >= (h.keys[0].at | 0)) this._apply(h, this._key(h.keys.shift().key), false);
      if (k.steps - h.s0 >= h.maxTicks) { this._abort(h, 'limit'); break; }
      if (h.ses.tty.outBytes > h.maxOutput) { this._abort(h, 'output'); break; }
      if (k.clock - h.t0 > h.maxTime) { this._abort(h, 'timeout'); break; }
      if (k.clock >= endClock) return null;
      let lim = Math.min(endClock, h.t0 + h.maxTime + 1);
      if (h.keys.length) lim = Math.min(lim, h.t0 + (h.keys[0].at | 0));
      if (h.replay && h.replay.length && k.steps - h.s0 >= h.replay[0].step) lim = Math.min(lim, h.t0 + h.replay[0].at);
      const before = k.steps;
      if ((!k.sched.nr() && !k.nD && !k.timers.some((t) => !t.bg)) || !k.quantum(lim)) {
        if (h.keys.length) { k.clock = Math.max(k.clock, h.t0 + (h.keys[0].at | 0)); continue; }
        if (h.replay && h.replay.length) { const e = h.replay.shift(); k.clock = Math.max(k.clock, h.t0 + e.at); this._apply(h, e, true); continue; }
        if (h.ses.tty.interactive && h.ses.tty.rwait.length) { h.waiting = 'input'; return null; }
        this._abort(h, 'blocked'); break;
      }
      h.sleeping = k.steps === before;
    }
    h.sleeping = false;
    if (k.rebootReq) return this._reboot(h);
    // シェルがプロンプトに戻った後、バックグラウンドのプロセスが落ち着くまで少しだけ進める（fork した子が execve するところまで）
    //（ディスクを待っているプロセスがいれば、その分の時間も進める）
    if (!h.reason && h.ses.idle) for (let g = 0; g < 80 && (k.sched.nr() || k.nD); g++) k.quantum(k.sched.nr() ? k.clock : k.clock + 200);
    if (k.rebootReq) return this._reboot(h);
    return this._finish(h);
  };
  // 再起動・停止（reboot システムコールの後）。ディスク（/ の中身）は引き継ぎ、プロセスとメモリは消える。新しいカーネルで起動し直す
  M._reboot = function (h) {
    const old = this.k, req = old.rebootReq;
    old.rebootReq = null;
    old.emit('shutdown', req);
    for (const p of old.procs.values()) for (const e of p.fds) if (e && e.ofd.inode.opens > 0) e.ofd.inode.opens = 0;
    const o = Object.assign({}, old.o, { epoch: old.epoch + old.clock + 2000, disk: old.rootfs, boots: (old.o.boots | 0) + 1, lastShutdown: req.mode });
    let r = null;
    if (h) {
      const out = h.ses.tty.out || [];
      let so = '', se = '';
      for (const c of out) if (c.s === 'out') so += c.text; else se += c.text;
      const trace = h.sink ? h.sink.lines : [];
      r = { stdout: dec(so), stderr: dec(se), out: out.filter((c) => c.text !== '').map((c) => ({ s: c.s, text: dec(c.text) })), exit: 0,
        ticks: old.clock - h.t0, steps: old.steps - h.s0, reason: req.mode === 'restart' ? 'reboot' : 'poweroff', cut: false,
        message: req.mode === 'restart' ? '再起動しました。' : '電源を切りました。次のコマンドのために、起動し直してあります。',
        trace: trace.map((l) => ({ pid: l.pid, name: l.name, text: dec(l.text), line: dec(l.line) })), events: old.evlog || [], logout: true };
      r.traceText = r.trace.map((l) => l.line).join('\n');
      h.done = true; h.result = r;
      const lo = Object.assign({}, h.opts); delete lo._ev;
      if (h.ev.length) lo._ev = h.ev;
      this.log.push({ t: 'run', cmd: h.cmd, opts: lo });
      this.cur = null;
    }
    const k = this.k = this.kernel = new Kernel(o);
    this.lastRunAt = k.now();
    k.booting = true;
    k.boot();
    k.newSession(this.opts.user);
    this._settle();
    k.booting = false;
    this.bootTicks = k.clock;
    return r;
  };
  M._abort = function (h, reason) {
    const k = this.k, ses = h.ses, sh = ses.proc, tty = ses.tty;
    h.reason = reason;
    const killFg = () => { for (const q of Array.from(k.procs.values())) if (q !== sh && q.sid === sh.sid && q.state !== 'Z' && (q.pgid === tty.fg || q.pgid === sh.pgid)) k.sendSig(q, SIG.KILL, null); };
    killFg();
    sh.abort = { lnxAbort: true, reason };
    if (sh.state === 'T') k.setState(sh, 'R'); else k.wakeProc(sh);
    if (sh.sc) { if (sh.sc.timer) k.cancelTimer(sh.sc.timer); sh.sc = null; }
    tty.interactive = false;
    for (let g = 0; g < 200000 && this._alive(h); g++) { if (g % 500 === 499) killFg(); if (!k.quantum(k.clock + 1)) break; }
    if (this._alive(h)) throw new Error('シェルを止められませんでした（' + reason + '）');
  };
  const REASON_MSG = {
    limit: '実行が長すぎるので打ち切りました（tick の上限）。', output: '出力が多すぎるので打ち切りました。', timeout: '仮想時間の上限に達したので打ち切りました。',
    blocked: '入力やほかのプロセスを待ったまま進まなくなったので打ち切りました。',
  };
  M._finish = function (h) {
    const k = this.k, ses = h.ses, tty = ses.tty;
    let logout = false;
    if (!ses.idle) { logout = true; h.exit = (ses.proc.exitStatus & 0x7f) ? 128 + (ses.proc.exitStatus & 0x7f) : (ses.proc.exitStatus >> 8) & 0xff; k.newSession(ses.user); this._settle(); } else h.exit = ses.status;
    const out = tty.out || [];
    let so = '', se = '';
    for (const c of out) if (c.s === 'out') so += c.text; else se += c.text;
    const trace = h.sink ? h.sink.lines : [];
    if (h.sink) for (const p of k.procs.values()) if (p.trace && p.trace.sink === h.sink) p.trace = null;
    const r = {
      stdout: dec(so), stderr: dec(se), out: out.filter((c) => c.text !== '').map((c) => ({ s: c.s, text: dec(c.text) })), exit: h.exit,
      ticks: k.clock - h.t0, steps: k.steps - h.s0, reason: h.reason || (logout ? 'logout' : 'exit'), cut: !!h.reason, message: h.reason ? REASON_MSG[h.reason] : '',
      trace: trace.map((l) => ({ pid: l.pid, name: l.name, text: dec(l.text), line: dec(l.line) })), events: k.evlog || [], logout,
    };
    r.traceText = r.trace.map((l) => l.line).join('\n');
    h._out = out;
    tty.out = null; tty.inbuf = ''; tty.interactive = false; k.evlog = null;
    h.done = true; h.result = r;
    const lo = Object.assign({}, h.opts); delete lo._ev;
    if (h.ev.length) lo._ev = h.ev;
    this.log.push({ t: 'run', cmd: h.cmd, opts: lo });
    this.cur = null;
    return r;
  };
  M.run = function (cmd, opts) {
    const h = this.start(cmd, opts);
    let r = null;
    for (let g = 0; g < 1e6 && !r; g++) { r = h.step(1e9); if (!r && h.waiting) { this._apply(h, { type: 'eof' }, true); } }
    return r;
  };
  // 実行中のコマンドへ：Ctrl-C など / 端末への入力 / Ctrl-D
  M.interrupt = function (sig) { const h = this.cur; if (!h || h.done) return false; this._apply(h, { type: 'sig', sig: typeof sig === 'number' ? sig : SIG[String(sig || 'INT').replace(/^SIG/, '')] || SIG.INT }, true); return true; };
  M.input = function (text) { const h = this.cur; if (!h || h.done) return false; this._apply(h, { type: 'input', text }, true); return true; };
  M.eof = function () { const h = this.cur; if (!h || h.done) return false; this._apply(h, { type: 'eof' }, true); return true; };
  // コマンドなしで時間だけ進める（バックグラウンドのジョブが動く）
  M.advance = function (ms) {
    const k = this.k, end = k.clock + ms;
    let g = 0;
    const ttys = [];
    if (!this.cur || this.cur.done) for (const s of k.sessions.values()) if (!s.tty.out) { s.tty.out = []; s.tty.outBytes = 0; ttys.push(s); }
    const collect = () => { const out = []; for (const s of ttys) { for (const c of s.tty.out || []) if (c.text !== '') out.push({ s: c.s, text: dec(c.text), user: s.user }); s.tty.out = null; } return { out, stdout: out.filter((c) => c.s === 'out').map((c) => c.text).join(''), stderr: out.filter((c) => c.s === 'err').map((c) => c.text).join('') }; };
    while (k.clock < end && g++ < 5e6) { if (k.rebootReq) break; if (!k.quantum(end)) { k.clock = end; k.fireTimers(); break; } }
    this.log.push({ t: 'advance', ms });
    const res = collect();
    if (k.rebootReq) this._reboot(null);
    return res;
  };
  M._replay = function (log) {
    for (const e of log) {
      if (e.t === 'run') this.run(e.cmd, e.opts);
      else if (e.t === 'advance') this.advance(e.ms);
      else if (e.t === 'import') this.fs.import(e.data, e.opts);
      else if (e.t === 'write') this.fs.write(e.path, e.text, e.opts);
    }
  };
  M.clone = function () { const m = new Machine(this.opts); m._replay(this.log); return m; };
  M.snapshot = function () { return { opts: Object.assign({}, this.opts), log: this.log.slice() }; };
  M.restore = function (s) { this.opts = Object.assign({}, s.opts); this.log = []; this._boot(); this._replay(s.log); return this; };
  M.reset = function () { this.log = []; this._boot(); return this; };

  // ── 観察（画面の「システムを見る」用。機械の状態は変えない）──
  M.ps = function () {
    const k = this.k, us = k.users(), out = [];
    const un = (u) => { const x = us.find((y) => y.uid === u); return x ? x.name : String(u); };
    for (const p of k.procs.values()) {
      out.push({ pid: p.pid, ppid: p.ppid, pgid: p.pgid, sid: p.sid, state: p.state, uid: p.uid, euid: p.euid, gid: p.gid, user: un(p.euid), comm: dec(p.comm), args: p.argv.map(dec), cmdline: p.argv.map(dec).join(' '),
        cwd: p.cwd ? dec(k.pathOf(p, p.cwd) || '') : '', tty: p.tty ? p.tty.name : '?', utime: p.utime, stime: p.stime, start: p.start, nice: p.nice, nfd: p.fds.filter(Boolean).length,
        exit: p.state === 'Z' ? p.exitStatus : null, stopped: p.state === 'T', waiting: p.sc ? p.sc.n : null, session: !!p.ses });
    }
    return out.sort((a, b) => a.pid - b.pid);
  };
  M.fdTable = function (pid) {
    const k = this.k, p = k.procs.get(pid);
    if (!p) return null;
    const out = [];
    p.fds.forEach((e, fd) => {
      if (!e) return;
      const o = e.ofd, i = o.inode;
      out.push({ fd, ofd: o.id, path: dec(o.path) + (i.nlink === 0 && i.type === 'f' && !i.fs.synth ? ' (deleted)' : ''), flags: flagStr(o.flags), access: ['r', 'w', 'rw'][o.flags & 3], pos: o.pos, refs: o.refs, cloexec: e.cloexec,
        inode: { ino: i.ino, dev: i.fs.dev, fs: i.fs.type, type: i.type, mode: i.mode, modeStr: modeStr(i.type, i.mode), nlink: i.nlink, size: i.size, opens: i.opens },
        pipe: i.type === 'p' ? { id: i.pipe.id, buffered: i.pipe.buf.length, cap: i.pipe.cap, readers: i.pipe.readers, writers: i.pipe.writers, end: o.pr && o.pw ? 'rw' : o.pr ? 'r' : 'w' } : null });
    });
    return out;
  };
  M._inodeInfo = function (i, path) {
    const k = this.k, us = k.users(), gs = k.groups();
    const u = us.find((y) => y.uid === i.uid), g = gs.find((y) => y.gid === i.gid);
    const o = { path, ino: i.ino, dev: i.fs.dev, fs: i.fs.type, type: i.type, mode: i.mode, modeStr: modeStr(i.type, i.mode), octal: oct(i.mode, 4), uid: i.uid, gid: i.gid, user: u ? u.name : String(i.uid), group: g ? g.name : String(i.gid),
      nlink: i.nlink, size: i.size, blocks: i.blocks.slice(), atime: i.atime, mtime: i.mtime, ctime: i.ctime, opens: i.opens, changed: i.ctime >= this.lastRunAt || i.mtime >= this.lastRunAt };
    if (i.type === 'l') o.target = dec(k.linkTarget(k.kcred, i));
    if (i.type === 'c') o.rdev = i.rdev.slice();
    return o;
  };
  M.inode = function (path, nofollow) {
    const k = this.k, i = k.namei(k.kcred, enc(path), !nofollow);
    if (typeof i === 'number') return null;
    const o = this._inodeInfo(i, path);
    if (i.type === 'd') o.entries = k.dirNames(k.kcred, i).map((n) => { const c = k.lookup(k.kcred, i, n); return { name: dec(n), ino: c ? c.ino : 0, type: c ? c.type : '?' }; });
    return o;
  };
  M.tree = function (path, opts) {
    opts = Object.assign({ depth: 99, max: 3000, synth: false }, opts || {});
    const k = this.k, m = this;
    let count = 0;
    const root = k.namei(k.kcred, enc(path || '/'), true);
    if (typeof root === 'number') return null;
    const rec = (i, pth, name, depth) => {
      const o = m._inodeInfo(i, pth); o.name = name; delete o.blocks;
      if (i.type === 'd') {
        o.children = [];
        const real = k.cross(k.kcred, i);
        if (real !== i) { o.mount = real.fs.type; }
        if (depth < opts.depth && (opts.synth || !real.fs.synth)) {
          const names = k.dirNames(k.kcred, real).sort();
          for (const n of names) { if (++count > opts.max) { o.truncated = true; break; } const c = k.lookup(k.kcred, real, n); if (c) o.children.push(rec(c, (pth === '/' ? '' : pth) + '/' + dec(n), dec(n), depth + 1)); }
        } else if (k.dirNames(k.kcred, real).length) o.collapsed = true;
      }
      return o;
    };
    return rec(root, path || '/', path === '/' || !path ? '/' : basename(path), 0);
  };
  M.mounts = function () { return this.k.ns0.mnt.list.map((m) => ({ source: m.source, target: m.target, type: m.type, opts: m.opts, blocks: m.fs.blocksTotal, used: m.fs.blocksUsed, inodes: m.fs.ninodes })); };
  M.cwd = function (user) { const s = this._session(user); return dec(this.k.pathOf(s.proc, s.proc.cwd) || '/'); };
  M.prompt = function (user) {
    const s = this._session(user), k = this.k, pw = k.users().find((u) => u.name === s.user);
    let cwd = dec(k.pathOf(s.proc, s.proc.cwd) || '/');
    if (pw && (cwd === pw.home || cwd.startsWith(pw.home + '/'))) cwd = '~' + cwd.slice(pw.home.length);
    return s.user + '@' + k.ns0.uts.hostname + ':' + cwd + (s.uid === 0 ? '# ' : '$ ');
  };
  M.users = function () { return this.k.users(); };
  M.time = function () { return { ticks: this.k.clock, steps: this.k.steps, now: this.k.now(), date: strftime('%Y-%m-%d %H:%M:%S', this.k.now()), load: this.k.load.slice() }; };
  // Tab 補完の候補
  M.complete = function (line, user) {
    const k = this.k, s = this._session(user), p = s.proc;
    const m = /(?:^|[\s;|&(<>])([^\s;|&(<>]*)$/.exec(line), word = m ? m[1] : '';
    const start = line.length - word.length;
    const first = /^\s*$/.test(line.slice(0, start)) || /[;|&(]\s*$/.test(line.slice(0, start));
    let cands = [];
    if (first && word.indexOf('/') < 0) {
      const set = new Set(LNX.sh && LNX.sh.builtins ? LNX.sh.builtins : []);
      for (const d of (p.env.PATH || '/usr/bin').split(':')) { const i = k.namei(p, d, true); if (typeof i !== 'number' && i.type === 'd') for (const n of k.dirNames(p, i)) set.add(dec(n)); }
      cands = Array.from(set).filter((n) => n.startsWith(word)).sort();
    } else {
      const sl = word.lastIndexOf('/'), dir = sl < 0 ? '.' : word.slice(0, sl + 1), pre = word.slice(sl + 1);
      let dpath = dir;
      if (dpath[0] === '~') dpath = (p.env.HOME || '/') + dpath.slice(1);
      const i = k.namei(p, enc(dpath), true);
      if (typeof i !== 'number' && i.type === 'd' && k.may(p, i, 4)) {
        for (const n0 of k.dirNames(p, i)) { const n = dec(n0); if (!n.startsWith(pre) || (n[0] === '.' && pre[0] !== '.')) continue; const c = k.cross(p, k.lookup(p, i, n0)); const t = c.type === 'l' ? k.namei(p, enc(dpath + '/' + n), true) : c; cands.push((sl < 0 ? '' : dir) + n + (t && t.type === 'd' ? '/' : '')); }
        cands.sort();
      }
    }
    return { start, word, candidates: cands };
  };

  // ── ファイルの出し入れ ──
  function FsApi(m) { this.m = m; }
  FsApi.prototype = {
    read(path) { const k = this.m.k, i = k.namei(k.kcred, enc(path), true); if (typeof i === 'number' || i.type !== 'f') return null; return dec(i.fs.synth ? (i.node.read ? i.node.read(k, k.kcred) : '') : i.data); },
    exists(path) { const k = this.m.k; return typeof k.namei(k.kcred, enc(path), false) !== 'number'; },
    // ファイルを置く。opts = { mode, user }（機械の状態を変えるので記録に残る）
    write(path, text, opts) {
      const k = this.m.k; opts = opts || {};
      const pw = k.users().find((u) => u.name === (opts.user || 'root')) || { uid: 0, gid: 0 };
      const ino = k.writeFile(enc(path), enc(text), opts.mode === undefined ? 0o644 : opts.mode, pw.uid, pw.gid);
      ino.uid = pw.uid; ino.gid = pw.gid; if (opts.mode !== undefined) ino.mode = opts.mode;
      this.m.log.push({ t: 'write', path, text, opts });
    },
    // path 以下を JSON にできる形で取り出す（中身はバイト列を 1 文字 1 バイトで持つ文字列）
    export(path) {
      const k = this.m.k, root = k.namei(k.kcred, enc(path), true);
      if (typeof root === 'number' || root.type !== 'd') return null;
      const ents = [], seen = new Map();
      const rec = (d, rel) => {
        for (const [name, i] of d.ents) {
          if (k.ns0.mnt.covered.has(i)) continue;
          const r = rel ? rel + '/' + name : name, e = { p: r, t: i.type, m: i.mode, u: i.uid, g: i.gid, mt: i.mtime };
          if (i.type === 'f') { if (i.nlink > 1 && seen.has(i)) { e.h = seen.get(i); } else { seen.set(i, r); e.d = i.data; } } else if (i.type === 'l') e.d = i.data; else if (i.type !== 'd') continue;
          ents.push(e);
          if (i.type === 'd') rec(i, r);
        }
      };
      rec(root, '');
      return { v: 1, path, mode: root.mode, entries: ents };
    },
    // export したものを戻す。path 以下を空にしてから置く
    import(data, opts) {
      const k = this.m.k, root = k.mkdirp(enc(data.path));
      const clear = (d) => { for (const [name, i] of Array.from(d.ents)) { if (k.ns0.mnt.covered.has(i)) continue; if (i.type === 'd') clear(i); if (i.type !== 'd' || !i.ents.size) k.dirRemove(d, name); } };
      clear(root);
      const base = enc(data.path).replace(/\/+$/, '');
      for (const e of data.entries) {
        const full = base + '/' + e.p;
        let i;
        if (e.t === 'd') i = k.mkdirp(full, e.m, e.u, e.g);
        else if (e.t === 'l') i = k.mkSymlink(e.d, full);
        else if (e.h !== undefined) { const src = k.namei(k.kcred, base + '/' + e.h, false); if (typeof src === 'number') continue; k.dirAdd(k.mkdirp(dirname(full)), basename(full), src); continue; } else i = k.writeFile(full, e.d, e.m, e.u, e.g);
        i.mode = e.m; i.uid = e.u; i.gid = e.g;
        if (e.mt) i.mtime = e.mt;
      }
      this.m.log.push({ t: 'import', data, opts });
    },
  };

  // ════════════════════════ 早見表（付録と画面の補足用）════════════════════════
  const ERRJA = {
    EPERM: 'その操作は許されていない', ENOENT: 'そのファイルやディレクトリはない', ESRCH: 'そのプロセスはない', EINTR: 'システムコールがシグナルで中断された',
    EIO: '入出力エラー', ENXIO: 'そのデバイスはない', E2BIG: '引数が長すぎる', ENOEXEC: '実行できる形式ではない', EBADF: 'そのファイルディスクリプタは開いていない',
    ECHILD: '待つ子プロセスがいない', EAGAIN: 'いまはできない（資源が足りない）', ENOMEM: 'メモリが足りない', EACCES: '権限がない', EFAULT: '不正な番地',
    EBUSY: '使用中', EEXIST: 'すでにある', EXDEV: '別のファイルシステムをまたぐリンクは作れない', ENODEV: 'その種類のデバイス（ファイルシステム）はない',
    ENOTDIR: 'ディレクトリではない', EISDIR: 'ディレクトリである', EINVAL: '引数が正しくない', ENFILE: 'システム全体で開けるファイルが多すぎる',
    EMFILE: 'このプロセスが開いているファイルが多すぎる', ENOTTY: '端末ではない', ETXTBSY: '実行中のファイルには書けない', EFBIG: 'ファイルが大きすぎる',
    ENOSPC: 'ディスクに空きがない', ESPIPE: 'パイプでは位置を動かせない', EROFS: '読み取り専用のファイルシステム', EMLINK: 'リンクが多すぎる',
    EPIPE: '読み手のいないパイプに書いた', ENAMETOOLONG: '名前が長すぎる', ENOSYS: 'そのシステムコールは実装されていない', ENOTEMPTY: 'ディレクトリが空ではない',
    ELOOP: 'シンボリックリンクをたどりすぎた（輪になっている）', ENOTSOCK: 'ソケットではない', EADDRINUSE: 'そのアドレス（ポート）は使用中', ECONNREFUSED: '接続を断られた',
    ECONNRESET: '相手が接続を切った', ENOTCONN: '接続されていない', EISCONN: 'すでに接続されている', ETIMEDOUT: '時間切れ',
  };
  const SIGJA = {
    HUP: '端末が切れた', INT: '割り込み（Ctrl-C）', QUIT: '終了（Ctrl-\\）。コアダンプを残す', ILL: '不正な命令', ABRT: '異常終了（abort）', FPE: '算術エラー（0 で割ったなど）',
    KILL: '強制終了。捕まえることも無視することもできない', USR1: 'ユーザー定義 1', SEGV: '不正なメモリアクセス', USR2: 'ユーザー定義 2', PIPE: '読み手のいないパイプに書いた',
    ALRM: 'タイマー', TERM: '終了の依頼（kill の既定）', CHLD: '子プロセスが終わった・止まった', CONT: '止まっているプロセスを再開する', STOP: '一時停止。捕まえることも無視することもできない',
    TSTP: '端末からの一時停止（Ctrl-Z）', TTIN: 'バックグラウンドで端末から読もうとした', TTOU: 'バックグラウンドで端末に書こうとした', WINCH: '端末の大きさが変わった',
  };
  const SYSJA = {
    clone: 'プロセスを複製する（fork）', execve: 'いまのプロセスを別のプログラムに置き換える', exit_group: 'プロセスを終わる', wait4: '子プロセスの終了を待って回収する',
    getpid: '自分の PID', getppid: '親の PID', getuid: '実ユーザー ID', geteuid: '実効ユーザー ID', getgid: '実グループ ID', getegid: '実効グループ ID', getgroups: '補助グループの一覧',
    getpgid: 'プロセスグループ ID', setpgid: 'プロセスグループを変える', getsid: 'セッション ID', setsid: '新しいセッションを作る', setuid: 'ユーザー ID を変える', setgid: 'グループ ID を変える', setgroups: '補助グループを変える',
    kill: 'シグナルを送る', rt_sigaction: 'シグナルを受け取ったときの動作を決める', rt_sigprocmask: 'シグナルを一時的に止める（マスク）', pause: 'シグナルが来るまで待つ',
    openat: 'ファイルを開いて fd を得る', read: 'fd から読む', write: 'fd に書く', close: 'fd を閉じる', lseek: '読み書きの位置（オフセット）を動かす', dup: 'fd を複製する', dup2: 'fd を、指定した番号に複製する',
    fcntl: 'fd の設定を調べる・変える', pipe: 'パイプを作る（読む側と書く側の fd）', stat: 'ファイルの情報（inode）を得る', lstat: 'stat と同じ。シンボリックリンクはたどらない', fstat: 'fd から stat する',
    access: '読める・書ける・実行できるかを調べる', getdents64: 'ディレクトリのエントリを読む', mkdir: 'ディレクトリを作る', rmdir: '空のディレクトリを消す', unlink: '名前（リンク）を 1 つ外す',
    link: 'ハードリンクを作る', symlink: 'シンボリックリンクを作る', readlink: 'シンボリックリンクの中身を読む', rename: '名前を変える・移動する', chmod: '権限を変える', fchmod: 'fd で権限を変える',
    chown: '持ち主を変える', lchown: 'chown と同じ。シンボリックリンクはたどらない', umask: '新しいファイルの権限から落とすビットを決める', truncate: 'ファイルの大きさを変える', ftruncate: 'fd でファイルの大きさを変える',
    utimensat: 'ファイルの時刻を変える', mknod: '特殊ファイル（FIFO、デバイス）を作る', chdir: 'カレントディレクトリを変える', fchdir: 'fd でカレントディレクトリを変える', getcwd: 'カレントディレクトリのパスを得る',
    mount: 'ファイルシステムをマウントする', umount2: 'マウントを外す', statfs: 'ファイルシステムの空きを調べる', nanosleep: '指定した時間だけ眠る', sched_yield: 'CPU をほかのプロセスに譲る',
    fsync: 'そのファイルの変更をディスクに書き出す', sync: 'すべての変更をディスクに書き出す', ioctl: 'デバイス固有の操作（端末の設定など）', uname: 'カーネルの名前とバージョン', sethostname: 'ホスト名を変える',
    clock_gettime: 'いまの時刻', getrandom: '乱数を得る', ptrace: 'ほかのプロセスを追跡する（strace が使う）',
    poll: '複数の fd のどれかが読める・書けるようになるまで待つ', times: 'このプロセスと子が使った CPU 時間', getrusage: '使った資源（CPU 時間、ページフォルトの回数など）', prlimit64: '資源の上限（開けるファイルの数、core の大きさなど）を読む・変える',
    brk: 'ヒープの終わりを動かす', mmap: 'メモリの領域を割り当てる・ファイルを写す', munmap: 'mmap した領域を返す', mprotect: 'メモリの保護を変える', setpriority: 'nice 値を変える', getpriority: 'nice 値を調べる',
    socket: 'ソケットを作る', bind: 'ソケットに番地（ポート）をつける', listen: '接続を待ち受ける', accept: '接続を受け入れる', connect: '接続する', shutdown: '接続の片側を閉じる',
    getsockname: '自分側の番地', getpeername: '相手側の番地', unshare: '新しい名前空間に移る', setns: '既存の名前空間に入る', chroot: 'ルートディレクトリを変える', pivot_root: 'ルートのマウントを入れ替える', reboot: '再起動・停止',
  };

  // ════════════════════════ 公開 ════════════════════════
  const LNX = {
    version: 1,
    boot: (opts) => new Machine(opts),
    bin: {},            // 名前 → { main: function*(c), help, usage }（bin.js / shell.js が登録する）
    files: [],          // rootfs に足すファイル（bin.js が登録する）
    sys, Ctx, Reader,
    ERRNO, ERRMSG, ENAME, SIG, SIGNAME, SIGDESC, O, S, W, F, TIO, AT_FDCWD, PIPE_CAP, PIPE_BUF,
    strerror, isErr, sigDefault, ERRJA, SIGJA, SYSJA, SYSCALL_ORDER: SYSCALL_NAMES,
    util: { crypt, saltOf, enc, dec, basename, dirname, normpath, modeStr, oct, strftime, tm, quote, MON, WDAY, TZ, TYPEBITS, BITSTYPE },
    kernel: {
      Kernel, K, SC, BLOCK, RoundRobin, Machine, M, crt, getOfd,
      // 部品を足す：LNX.kernel.plugin('mm', (k) => { …; return 部品の状態; })。起動のたびに、rootfs を作った後・PID 1 を作る前に呼ばれる
      plugin(name, init) { const i = PLUGINS.findIndex((p) => p.name === name); if (i >= 0) PLUGINS[i] = { name, init }; else PLUGINS.push({ name, init }); },
      // システムコールを足す・差し替える：LNX.kernel.syscall('mmap', fn(k, p, a, req), fmt(a, r, p, req), ret(r))
      syscall(name, fn, fmt, ret) { def(name, fn, fmt, ret); if (!sys[name]) sys[name] = (...a) => ({ n: name, a }); },
      fmt: { flagStr, statStr, sigStr, statusStr, tsStr, quote, ADDR },
    },
    formatTrace: (trace) => trace.map((l) => l.line).join('\n'),
  };
  root.LNX = LNX;
  if (typeof module !== 'undefined' && module.exports) module.exports = LNX;
})(typeof window !== 'undefined' ? window : globalThis);
