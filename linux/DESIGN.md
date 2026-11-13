# 図解 Linux — 設計

シェルの使い方から、プロセス・ファイルディスクリプタ・システムコール・ファイルシステム・仮想メモリ・スケジューラ・コンテナの仕組みまで、ブラウザの中で動く「小さな Linux」（自作のカーネルのシミュレータ + シェル + コマンド群）を動かしながら学ぶ学習サイト。`docs/rust`、`docs/postgresql`、`docs/cpu` と同じ作り。作り方・粒度・検査の基準は `docs/.claude/skills/zukai-site/`（SKILL.md、references/granularity.md、references/runtime.md、references/notation.md）に従う。進め方の手本は `docs/cpu/`（DESIGN.md、`grade.js` に判定を集約、章の検査スクリプト）。

- サイト名（BRAND）：`図解 Linux`
- localStorage の接頭辞：`zl-`
- 置き場所：`docs/linux/`。ビルドは `node src/build.mjs`（`docs/linux` で実行）。外部依存なし（Google Fonts のみ）

## 実行環境の方針（なぜ本物の Linux を動かさないか）

本物の Linux カーネルをブラウザで動かす方法（v86 などの x86 エミュレータ、WasmLinux、WALI を使う BrowserPod など）は、どれも数十 MB の読み込みと起動待ちがある。それに、カーネルの中は見えない。この本の目的は「カーネルの中で何が起きているか」を見せることなので、**教育用に作った小さな Linux（JavaScript のシミュレータ）**を使う。

- 本物と同じ名前・同じ意味のシステムコール（fork、execve、wait4、open、read、write、pipe、dup2、kill など）と、本物に近いコマンドの出力を持つ。
- その代わりに、プロセス表、ファイルディスクリプタ表、inode、ページ表、スケジューラの判断、システムコールの列を、そのまま画面に出せる。
- 時間は仮想時間（tick）で進むので、毎回同じ結果になる。これで採点ができる。
- 本物との違いは、各章で「このサイトの Linux では」と書き分ける。付録に違いの一覧を載せる。

## 章立て（序 + 20 章 + 付録）

| 章 | タイトル | 主な内容 |
| --- | --- | --- |
| 0 | はじめに | このサイトの使い方。最初のコマンド。「システムを見る」パネルでプロセスとファイルが見える |
| 1 | Unix と Linux の歴史 | Multics、Unix（トンプソンとリッチー）、C 言語、BSD、GNU、Linux（1991）、ディストリビューション、POSIX、Android やサーバでの広がり |
| 2 | シェルとコマンドの基本 | プロンプト、コマンドと引数とオプション、`ls` `cd` `pwd` `echo` `cat`、補完の考え方、`man` の代わりの `help`、終了ステータス |
| 3 | ファイルとディレクトリ | ディレクトリの木、絶対パスと相対パス、`.` と `..`、`mkdir` `touch` `cp` `mv` `rm`、ワイルドカード、標準的なディレクトリ（/etc /home /tmp /proc /dev） |
| 4 | ユーザーと権限 | uid と gid、`id`、rwx と 8 進表記、`chmod` `chown`、root、`su`、ディレクトリの x、umask |
| 5 | テキスト処理とパイプ | `grep` `sort` `uniq` `wc` `head` `tail` `cut` `tr` `tee`、パイプ、リダイレクト（> >> < 2>）、小さなツールを組み合わせる考え方 |
| 6 | シェルスクリプト | 変数、引用符、`$?`、`&&` `||`、`if` `test`、`for` `while`、関数、コマンド置換、スクリプトファイルと `#!`、実行権限 |
| 7 | プロセス | プログラムとプロセス、PID と PPID、`ps`、プロセスの木、`fork` → `execve` → `wait`、ゾンビと孤児、/proc/PID |
| 8 | シグナルとジョブ | `kill` とシグナルの番号、SIGINT・SIGTERM・SIGKILL・SIGCHLD・SIGSTOP、`&`、`jobs` `fg` `bg`、`trap` |
| 9 | ファイルディスクリプタ | fd 0・1・2、open と fd 表、ファイル記述（オフセットの共有）、`dup2` とリダイレクトの正体、`pipe` とパイプの正体、/proc/PID/fd |
| 10 | システムコール | ユーザーモードとカーネルモード、ライブラリ関数とシステムコール、`strace` で `cat` を追う、エラー番号（ENOENT・EACCES など）と `errno` |
| 11 | ファイルシステムの中身 | inode、ディレクトリはエントリの表、ハードリンクとシンボリックリンク、リンク数、`stat`、ブロックとファイルの大きさ、削除とは「リンクを外す」こと |
| 12 | VFS とマウント | すべてはファイル、VFS の層、`mount`、/proc と /dev と tmpfs、/dev/null・/dev/zero・/dev/random |
| 13 | 仮想メモリ | アドレス空間（text・data・heap・stack・mmap）、ページとページ表、ページフォルト、遅延割り当て、コピーオンライト（fork）、/proc/PID/maps、`free`、OOM |
| 14 | スケジューラ | 実行可能と待ち、タイムスライス、ラウンドロビン、優先度と `nice`、CFS の考え方（仮想実行時間）、`top`、負荷平均 |
| 15 | ページキャッシュと I/O | 読み書きはキャッシュ経由、ダーティページと書き戻し、`sync` と `fsync`、`free` の buff/cache、電源断で何が失われるか |
| 16 | ネットワークとソケット | ソケットは fd、TCP の接続（3 ウェイハンドシェイク、状態）、ポート、ループバック、`nc` で会話、`ss` |
| 17 | 起動と init | 電源から PID 1 まで（図中心）、init と systemd、サービスと unit、ログ、ランレベル / ターゲット |
| 18 | プログラムが動くまで | ELF、`#!` と execve、PATH、動的リンクと共有ライブラリ（図中心）、環境変数、`exec` |
| 19 | コンテナの仕組み | chroot、名前空間（PID・マウント・UTS）、cgroups（pids.max）、「コンテナはプロセス」、`unshare` で自分で作る |
| 20 | 観察と調査 | `/proc` を読む、`ps` `top` `lsof` `strace` `df` `du` `free`、ログ、困ったときの調べ方（応答しない、ディスクが一杯、メモリ不足） |
| 21 | 付録：早見表と用語集 | コマンド表、システムコール表、シグナル表、errno 表、パーミッション表、このサイトの Linux と本物の違い、用語集 |

## 実行環境：小さな Linux（`src/assets/kernel.js` ほか）

DOM を使わない中心部分（`window.LNX` / Node の `globalThis.LNX`）と、画面部分を分ける。Node の検査スクリプトから読み込めること。1 ファイルが大きくなりすぎるなら、`kernel.js`（カーネル）、`shell.js`（シェル）、`bin.js`（コマンド群）に分けてよい（読み込み順を先頭コメントに書く）。

### 機械（カーネル）
- **時間**：仮想時間（tick）。`sleep` や I/O 待ちで進む。日付は固定の起点から。乱数は固定シード。
- **ユーザー**：root（0）と `you`（1000、既定のログインユーザー）、`alice`（1001）など少数。/etc/passwd と /etc/group を持つ。
- **VFS**：inode（番号、種類（通常・ディレクトリ・シンボリックリンク・キャラクタデバイス・FIFO・ソケット）、mode、uid、gid、nlink、size、時刻、ブロック番号の一覧）、ディレクトリエントリ、マウント表。ファイルシステムの種類は ramfs（ext4 風に見せる。/）、procfs（/proc。プロセスの状態から動的に作る：/proc/PID/status、cmdline、fd/、maps、/proc/meminfo、/proc/mounts、/proc/loadavg）、devfs（/dev/null、zero、random、tty）、tmpfs（/tmp）。パスの解決（`.` `..`、シンボリックリンク、権限の検査（x のないディレクトリは通れない））。
- **初期のファイル**：/etc（passwd、group、hostname、os-release）、/home/you（いくつかの練習用ファイル。英語と日本語のテキスト、CSV など）、/usr/bin（コマンドの実体。中身は「ELF」風の短い印。`#!` スクリプトも置ける）、/var/log。
- **プロセス**：PID、PPID、状態（R 実行中 / S 待ち / T 停止 / Z ゾンビ）、uid / gid、cwd、umask、環境変数、fd 表（open file description（オフセット・フラグ・参照数）を指す）、シグナル（保留・ハンドラ・マスク）、終了ステータス、名前空間、cgroup、アドレス空間。PID 1 は init。
- **ユーザー空間のプログラム**：JavaScript のジェネレータ関数で書き、`yield` でシステムコールを呼ぶ（`const fd = yield sys.open(path, flags)` のような形）。これでカーネルがプロセスを切り替えられ、パイプの待ちや `&` が本当に並行に動く。コマンドとシェルはすべてこの形で書く。
- **システムコール**（本物の名前と errno）：`fork`（または `clone`）、`execve`、`exit`、`wait4`、`getpid` `getppid` `getuid`、`kill`、`sigaction`、`open`（`openat`）、`read`、`write`、`close`、`lseek`、`dup` `dup2`、`pipe`、`stat` `lstat` `fstat`、`getdents`、`mkdir` `rmdir` `unlink` `link` `symlink` `readlink` `rename`、`chmod` `chown` `umask`、`chdir` `getcwd`、`mount` `umount`、`brk` `mmap` `munmap`、`nanosleep`、`sched_yield`、`setpriority`（nice）、`socket` `bind` `listen` `accept` `connect`、`unshare` `chroot` `sethostname`、`fsync` `sync`。エラーは `-ENOENT` のような負の数で返し、ユーザー空間の小さなライブラリで errno に変える。
- **strace**：システムコールの列を、本物の strace に近い書式（`openat(AT_FDCWD, "/etc/hostname", O_RDONLY) = 3`）で記録できる。プロセスごとに有効にできる。
- **スケジューラ**（14 章）：既定はラウンドロビン（タイムスライス N tick）。nice の重みと CFS 風の仮想実行時間のモードも選べる。切り替えの記録（どの tick にどのプロセスが走ったか）を返す。
- **仮想メモリ**（13 章）：ページ 4 KiB、プロセスごとのページ表（仮想ページ → 物理フレーム、存在ビット、書き込み、コピーオンライト）、物理フレームの数は小さめ（たとえば 256）、ページフォルトの回数（major / minor）、遅延割り当て（mmap や brk しただけでは割り当てない）、fork のコピーオンライト、/proc/PID/maps、メモリを使い切ると OOM で一番大きいプロセスを殺す。メモリに触るデモ用のコマンド（例：`memtouch`、`forkbomb` の安全版）を用意する。
- **ページキャッシュ**（15 章）：ファイルの読み書きはページキャッシュを通す。ダーティページ、一定時間後の書き戻し、`sync`、`fsync`、「電源断」のシミュレーション（書き戻されていない変更が消える）、`free` の buff/cache、`echo 3 > /proc/sys/vm/drop_caches`。
- **ネットワーク**（16 章）：ループバック（127.0.0.1）だけ。TCP 風の状態遷移（LISTEN、SYN_SENT、ESTABLISHED、FIN_WAIT、TIME_WAIT など）、ポート、`nc -l` と `nc`、`ss -t`。パケットの列を記録できる。
- **名前空間と cgroups**（19 章）：PID 名前空間（中では PID 1 から）、マウント名前空間、UTS 名前空間（hostname）、`chroot`、cgroup の pids.max と memory.max（/sys/fs/cgroup 風）。
- **init / サービス**（17 章）：PID 1 が /etc/init の簡単な定義からサービス（常駐プロセス）を起こす。`systemctl status / start / stop` 風のコマンドと、ログ（`journalctl` 風）。ブートの段階のログを返す。
- **状態の保存**：`snapshot()` / `restore()` または `clone()`（採点で「同じ初期状態から 2 回」実行するため）。

### シェル（`sh`）
- POSIX sh の主要な部分：単純コマンド、パイプ `|`、`;` `&&` `||`、`&`、リダイレクト（`>` `>>` `<` `2>` `2>&1` `&>`、ヒアドキュメント `<<EOF`）、変数と `export`、`$?` `$$` `$!` `$#` `$@` `$1`、引用符（' と " と \）、展開（変数、`$(...)`、算術 `$((...))`、ワイルドカード `*` `?` `[...]`、`~`）、`if` / `elif` / `else`、`for` / `while` / `until`、`case`、関数、`return`、`exit`、組み込み（`cd` `pwd` `echo` `printf` `export` `unset` `read` `test` / `[` `true` `false` `exit` `jobs` `fg` `bg` `wait` `kill` `trap` `type` `alias`（簡単）`source` / `.` `exec` `umask` `help`）。
- 外部コマンドは本物と同じく fork + execve で起動する（strace で見える）。
- エラーは本物の bash に近い文（`sh: foo: command not found`、`cat: nofile: No such file or directory`）を出し、終了ステータス（127、1、126 など）を返す。日本語の補足は画面側で出す。

### コマンド（/usr/bin。本物の GNU coreutils / procps 等に近い出力。オプションは主要なものだけ）
`ls`（-l -a -i -R -d -h）、`cat`、`echo`、`printf`、`touch`、`mkdir`（-p）、`rmdir`、`rm`（-r -f）、`cp`（-r）、`mv`、`ln`（-s）、`chmod`（8 進と u+x 形式）、`chown`、`stat`、`id`、`whoami`、`su`（パスワードなしで切り替え）、`sudo`（簡単）、`grep`（-i -v -c -n -E -r、正規表現）、`sort`（-n -r -k -t -u）、`uniq`（-c）、`wc`（-l -w -c）、`head` / `tail`（-n）、`cut`（-d -f）、`tr`、`tee`、`seq`、`yes`、`sleep`、`true`、`false`、`test`、`basename`、`dirname`、`find`（-name -type -maxdepth）、`xargs`、`env`、`which`、`ps`（既定、-ef、aux、-o）、`pstree`、`kill`、`top`（1 回だけの表示）、`nice`、`renice`、`uptime`、`free`、`df`、`du`、`mount`、`umount`、`date`、`hostname`、`uname`、`strace`（-f）、`lsof`（簡単）、`nc`、`ss`、`unshare`、`chroot`、`systemctl`、`journalctl`、`sync`、`file`、`hexdump`（-C）、`od`、デモ用の `memtouch`・`spin`（CPU を使い続ける）など。

### IndexedDB の扱い（採用）
- **実験場だけ**、/home/you をブラウザの IndexedDB に保存する。ページを再読み込みしても、作ったファイルが残る（「リセット」で初期状態に戻す）。本文の実行ブロックと確認問題は、毎回決まった初期状態から始める（採点と説明の再現性のため）。
- 保存できないとき（プライベートウィンドウなど）は、黙ってメモリだけで動く。

## 図
- 既存の図エンジン（`src/lib/diagrams.mjs`：graph、tree、seq、mem、layout、bars、timeline、wave、pipe、circuit）を使う。足りなければ足してよい：プロセスの木（tree で足りるか確認）、fd 表とファイル記述と inode の 3 段の図（「fdtable」）、ページ表（「pagetable」）、スケジューラのガントチャート（「gantt」）、TCP の状態遷移（graph で）。
- 図解 Linux で足した 3 種類（spec の全部の項目は `src/lib/diagrams.mjs` の各関数の上のコメント。どれも `steps: [{ title, say, …差分 }]` でステップ切り替えにできる）：
  - **`fdtable`**（fd 表 → ファイル記述 → inode の 3 段。同じファイル記述を指す fd は、線が同じ箱に集まる）
    ```
    {
      procs: [ { label: 'sh（PID 2）', fds: [ { fd: 0, to: 'tty' }, { fd: 1, to: 'out', hl: true }, { fd: 3, closed: true, note: '閉じた' } ] } ],
      files: [ { id: 'tty', flags: 'O_RDWR', pos: 0, to: 'pts' }, { id: 'out', flags: 'O_WRONLY|O_CREAT', pos: 120, to: 'f1', hl: true } ],   // refs（参照数）は省略すると、指している fd の数
      inodes: [ { id: 'pts', label: '/dev/pts/0', sub: 'inode 14・端末' }, { id: 'f1', label: '/home/you/out.txt', sub: 'inode 151' }, { id: 'p1', label: 'パイプ', kind: 'pipe' } ],
      heads: ['fd 表', 'ファイル記述', 'inode'],   // 段の見出し（省略可）
    }
    ```
  - **`pagetable`**（仮想ページ → ページ表 → 物理フレーム。ページ表が 2 つなら、物理フレームを真ん中に挟んで左右に置く）
    ```
    {
      tables: [ { label: '親（PID 5）', pages: [
        { vpn: '0x00400', name: 'text', frame: 3, flags: 'r-x' },
        { vpn: '0x00601', name: 'data', frame: 7, flags: 'r--', state: 'cow' },   // CoW の印
        { vpn: '0x00800', name: 'heap', state: 'none' },                          // 未割り当て
        { vpn: '0x7ffff', name: 'stack', frame: 9, flags: 'rw-', hl: true },
      ] }, { label: '子（PID 6）', pages: [ … ] } ],
      frames: [ { n: 3, label: 'プログラム' }, { n: 7 }, { n: 8 }, { n: 9 } ],    // 指されていないフレームは「空き」。frames: 8 と数だけでもよい
    }
    ```
    ページ表が 1 つなら `pages: [...]` を直接書ける。
  - **`gantt`**（スケジューラのガントチャート。横軸 tick、縦にプロセス）
    ```
    {
      rows: [ { label: 'A（PID 3）', spans: [ { from: 0, to: 10 }, { from: 10, to: 30, kind: 'ready' }, { from: 40, to: 60, kind: 'wait', label: 'sleep' } ], note: 'nice 0' } ],
      // または runs: [['A', 0, 10], ['B', 10, 20], …]（だれが、いつからいつまで走ったか。切り替えの記録をそのまま渡せる）
      switches: true,                           // 切り替えの位置に縦の点線
      cpu: true,                                // いちばん下に「CPU」の行
      marks: [ { at: 40, label: 'A が sleep する' } ],
      end: 60, tick: 10, unit: 'tick', width: 520,
    }
    ```
    span の kind：なし = CPU を使っている、`'ready'` = 順番待ち、`'wait'` = 待っている。`hl: true` で強調。

## 画面
- ` ```sh run ` … シェルのセッション。ページごとに 1 台の Linux（章の中で上から順に積み上がる。前のブロックで作ったファイルを後で使う）。出力は端末風（プロンプト `you@zukai:~$` + コマンド + 出力。stderr は色を変える）。終了ステータスが 0 以外なら小さく表示。属性：`title="..."`、`error`（終了ステータスが 0 以外 / エラーで終わる例）、`root`（root のシェルで実行）、`strace`（システムコールの列も出す）、`trace="sched"` / `trace="mem"` / `trace="net"` / `trace="pagecache"`（その観察を出す）。
- ` ```sh setup ` … 章の準備（最初の実行時に自動で流れる。本文には折りたたみ）。
- ` ```sh `、` ```console `、` ```c `、` ```text ` … 実行しない例。
- 前のブロックを飛ばして実行したら「前を順に実行」を出す（postgresql と同じ）。上部に「リセット」。
- **「システムを見る」パネル**（画面の下）：プロセスの木（PID、状態、コマンド、uid）、選んだプロセスの fd 表と、その先のファイル記述と inode、ファイルの木（inode 番号、権限、リンク数、直前に変わったものに色）、マウント表、直前のコマンドのシステムコールの列、メモリ（13 章以降：ページ表とフレーム）。
- **確認問題**（下の「記法（確定）」が正）：` ```sh answer ` と読者のコマンドを、それぞれ「ページの初期状態 + その章の setup + 問題の prep」から始まる新しい Linux（clone）で実行し、**標準出力**を比べる（既定）。` ```sh check ` があれば、両方の実行後にそれを実行した出力を比べる（ファイルを作る・権限を変える問題など）。比べ方は postgresql と同じく「行の順番は既定で問わない」にするか「そのまま比べる」にするかを属性で：既定はそのまま（端末の出力は順番に意味があることが多い）、`unordered` で行の順番を問わない。
- **実験場**（`site/playground.html`）：端末（入力行、履歴、Tab 補完）+ 「システムを見る」を常に表示 + /home/you の IndexedDB 保存 + サンプル（パイプ、スクリプト、プロセスの木、コンテナを作る）。

## 検査
- カーネルとシェルとコマンドは Node の単体テストを持つ（スクラッチパッドに置く）。シェルの文法は bash / dash と同じ結果になるかを、手元の本物の `sh`（macOS の /bin/sh、zsh ではなく bash か dash）と照合できるものは照合する。コマンドの出力形式は GNU 版に合わせる（手元が macOS なので、GNU 版の書式は知識とドキュメントに基づき、確かめられないものは控えめに）。
- 全実行ブロック（章ごとに上から順に）を Node で実行し、error の印と結果の一致。確認問題の模範解答・再現性・別解・誤答（`scratchpad/linux/alts/chNN.json`）。
- ヘッドレス Chrome で全ページ、ライト / ダーク、幅 390px。

## 記法（確定。判定は `src/assets/grade.js` に集約、先頭コメントが正）

小さな Linux のファイルと読み込み順は `src/lib/lnx-files.mjs`（build.mjs と検査スクリプトが共有。部品を足したらここに足す。grade.js は最後）。

- ` ```sh setup ` … 章の準備。ページの機械を起動した直後に、章の中のすべての setup を順に流す（場所はどこでもよい。本文には折りたたみで出す）。確認問題の初期状態にも入る。
- ` ```sh run ` … ページの機械で実行（上から積み上がる）。ブロックは「端末に 1 回で打つ単位」に分けて（`GRADE.split`。if / for の途中や閉じていない引用符は次の行とつなげる。空行とコメント行は次のコマンドの前に付く）、1 つずつ `sys.run` する。表示はプロンプト + コマンド + 出力（stderr は色を変える）、0 以外の終了ステータスは小さく表示。
  - 属性：`title="..."`、`error`（どれかのコマンドが 0 以外で終わる / 打ち切られるのが正しい例）、`root` / `user="alice"`、`strace` / `strace="all"`、`stdin="1\n2\n"`（最初のコマンドへの端末入力）、`keys="^C@500,^Z@800"`（最初のコマンドで、仮想時間の何ミリ秒後に押すか）、`maxticks="N"`、`limit`（打ち切られるのが正しい例。無限ループなど）、`trace="sched|mem|net|pagecache"`（その観察を出す。第 2 段階の events を使う）。
- 確認問題 `:::quiz タイトル` … `:::` で閉じる。中に問題文と次のブロック：
  - ` ```sh answer ` 模範解答（必須）。属性：`unordered`（行の順番を問わない）、`exit`（終了ステータスも比べる）、`root` / `user="..."`（そのユーザーで実行）、`forbid="sort,uniq"`（使ったら不正解）、`require="grep"`（使わなければ不正解）。
  - ` ```sh check ` あれば、実行の後に root でこれを実行した標準出力を比べる（ファイルを作る・権限を変える問題）。なければ答えの標準出力を比べる。
  - ` ```sh prep ` その問題だけの準備。
  - ` ```sh vary `（何個でも）準備のデータを変える追加の準備。base + prep + vary でもう一度両方を実行して比べる。**数字や文字列を答えにする問題には必ず付ける**（答えを直接 echo しただけでは通らないように）。
  - ` ```sh starter ` 入力欄の最初の中身（任意）。
  - 採点：模範解答と読者のコマンドを、それぞれ「起動 + 章の setup（= base）の clone + prep (+ vary)」で実行して比べる。行末の空白と最後の空行は無視。
- 検査：`scratchpad/linux/check-chapter.mjs chNN [-v]`、別解と誤答は `scratchpad/linux/alts/chNN.json`（`{ "ch05-1": { "ok": [...], "ng": [...] } }`）。見本は `scratchpad/linux/example-ch98.md`。
