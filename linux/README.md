# 図解 Linux

シェルの使い方から、プロセス・ファイルディスクリプタ・システムコール・ファイルシステム・仮想メモリ・スケジューラ・コンテナの仕組みまで、ブラウザの中で動く「小さな Linux」（教育用に作ったカーネルのシミュレータ + シェル + コマンド群。JavaScript）を動かしながら学ぶ学習サイト。序章 + 20 章 + 付録。設計は `DESIGN.md`。

## 読む

`site/index.html` をブラウザで開く。サーバは不要で、実行環境は自作なので読み込むものもない（フォントだけ Google Fonts）。

- 本文のコマンド（` ```sh run `）は「実行」ボタン（Ctrl / ⌘ + Enter）でその場で実行でき、書き換えもできる。「元に戻す」で最初の内容に戻る
- 1 ページに 1 台の Linux。ブロックは上から順に積み上がる（前のブロックで作ったファイルを、後のブロックが使う）。前のブロックを飛ばして実行すると「前を順に実行」が出る（最初の状態に戻してから、上からそのブロックまでを順に実行する）。上部の「リセット」で、そのページの Linux を最初の状態（章の準備 ` ```sh setup ` を流した直後）に戻す
- 出力欄は端末風：プロンプト + コマンド + 出力。stderr は色が変わる。0 以外の終了ステータスは小さく出る（127 や 130 には意味も添える）。長い出力は折りたたまれる（「すべて表示」）。strace の印のブロックは、システムコールの列も出る
- 上部の「システムを見る」で、画面の下にパネルを出す（出力欄の「システムを見る」からも開ける）。タブ：
  - **プロセス** … プロセスの木（PID、PPID、状態、ユーザー、コマンド）。PID を押すと、そのプロセスのファイルディスクリプタの表（fd → ファイル記述（フラグ、位置、参照数。共有しているものは同じ色）→ inode またはパイプ）。直前のコマンドの間に生まれて終わったプロセスも出る
  - **ファイル** … ファイルの木（inode 番号、権限、リンク数、持ち主、大きさ。直前のコマンドで変わったものに色）。名前を押すと、その inode の中身（ブロック番号、時刻、ディレクトリならエントリの表）
  - **マウント** … マウントの表
  - **システムコール** … 直前のコマンド（ブロック）が呼んだシステムコールの列と、名前ごとの回数
  - **出来事** … 直前のコマンドの間にカーネルで起きたこと（fork、exec、open、exit …）
- 各章の最後に「確認問題」。コマンドを書いて「答え合わせ」を押すと、模範解答と同じ結果か（標準出力、または「確かめ方」のコマンドの出力）を判定する。毎回、章の最初の状態の Linux を複製して実行するので、何度でも試せて、本文のブロックにも影響しない。不正解のときは、期待される結果と自分の結果が並び、違う行に色が付く。正解した問題はブラウザに記録され「正解済み」になる
- `site/playground.html` は実験場。端末（履歴 ↑↓、Tab 補完、Ctrl-C / Ctrl-Z / Ctrl-D、Ctrl-L、続きの行は `> `）+ いつも開いている「システムを見る」+ サンプル。`sleep` は実時間で待つ。`/home/you` はブラウザの IndexedDB に保存される（「リセット」で消える。保存できない環境では、メモリだけで動く）

## 編集・ビルド

```console
$ node src/build.mjs    # docs/linux で実行
```

| パス | 内容 |
| --- | --- |
| `src/chapters/chNN.md` | 原稿（軽量マークダウン + 図のフェンス + 実行できるシェルのブロック）。ある章だけでビルドされる |
| `src/build.mjs` | 静的サイト生成器 |
| `src/lib/diagrams.mjs` | SVG 図エンジン（`fdtable` `pagetable` `gantt` を追加） |
| `src/lib/highlight.mjs` | ビルド時のハイライタ（中身は `hl.js`） |
| `src/lib/lnx-files.mjs` | 小さな Linux のファイルと読み込み順。`build.mjs` の `<script>` と Node の検査スクリプトが同じ一覧を使う。部品を足したらここに足す |
| `src/assets/kernel.js` `shell.js` `bin.js` `bin-sys.js` `rootfs.js` ほか | 小さな Linux の本体（`LNX`）。DOM を使わない。API は `kernel.js` の先頭コメント |
| `src/assets/grade.js` | 実行ブロックと確認問題の「意味」（`GRADE.boot`、`GRADE.runBlock`、`GRADE.quiz`）。画面と Node の検査が同じものを使う |
| `src/assets/hl.js` | シェルと C のハイライタ（ブラウザとビルドで共用） |
| `src/assets/lnx-run.js` | 実行ブロックのランナー（ページの機械、積み上げ、リセット）と、端末風の出力の部品（`LNXUI`） |
| `src/assets/lnxview.js` | 「システムを見る」（下のパネルと実験場で共用。`LNXVIEW.sections` にタブを足せる） |
| `src/assets/quiz.js` | 確認問題の画面 |
| `src/assets/samples.js`、`play.js` | 実験場のサンプルと端末 |
| `src/assets/app.js`、`style.css` | テーマ、検索、読了、図のステップ切替など。localStorage の接頭辞は `zl-` |
| `site/` | 生成物 |

## 原稿の記法（確定版は `DESIGN.md` の「記法（確定）」。意味の正は `grade.js`）

図解 Rust / PostgreSQL / CPU と共通のもの（front matter、`## 見出し {#id}`、`:::note` `tip` `warn` `key` `hist` `deep` `try` `cols`、`:::err メッセージ`、` ```fig 種類 キャプション `）に加えて：

- ` ```sh run [属性] ` … 実行できるブロック。「端末に 1 回で打つ単位」に分けて 1 つずつ実行する
  - `title="..."` 見出し / `error` どれかのコマンドが 0 以外で終わるのが正しい例 / `limit` 打ち切られるのが正しい例 / `maxticks="N"`
  - `root` / `user="alice"` そのユーザーのシェルで実行
  - `strace` / `strace="all"` システムコールの列も出す（all はシェル自身のものも）
  - `stdin="1\n2\n"` 最初のコマンドへの端末入力 / `keys="^C@500,^Z@800"` 仮想時間の何ミリ秒後にキーを押すか（`^C` `^Z` の例は、画面では「エラーになる」ではなく「Ctrl-C で止める例」と出る）
  - `trace="sched|mem|net|pagecache"` その観察を出す（events のうち関係するもの。専用の表示は `LNXUI.traceViews.名前` に登録する）
- ` ```sh setup ` … 章の準備。ページの機械を起動した直後に自動で流れる。本文には折りたたみで出る。確認問題の初期状態にも入る
- ` ```sh ` / ` ```console ` / ` ```c ` / ` ```text ` … 実行しない例（ハイライトだけ）。console は `$ ` `# ` `you@zukai:~$ ` で始まる行をプロンプトとコマンドに色分けする
- ` ```fig fdtable|pagetable|gantt … ` … fd 表とファイル記述と inode の 3 段の図、ページ表の図、スケジューラのガントチャート（下）
- `:::quiz 見出し` … 確認問題。中に問題文と次のブロックを書く。ID は `chNN-n`
  - ` ```sh answer [unordered] [exit] [root] [user="..."] [forbid="sort,uniq"] [require="grep"] ` … 模範解答（必須）。既定は標準出力をそのまま比べる
  - ` ```sh check ` … あれば、実行の後に root でこれを実行した出力を比べる
  - ` ```sh prep ` その問題だけの準備 / ` ```sh vary ` データを変える追加の準備（何個でも）/ ` ```sh starter ` 入力欄の初期値
  - `:::hint` … ヒント（折りたたみ）
- 知らない属性を書くと、ビルド時に「注意」が出る

### 図の spec（Linux で足した 3 種類。全部の項目は `diagrams.mjs` のコメント）

````
```fig fdtable リダイレクトのあと。fd 1 だけが別のファイル記述を指す
{
  procs: [ { label: 'ls（PID 3）', fds: [ { fd: 0, to: 'tty' }, { fd: 1, to: 'out', hl: true }, { fd: 2, to: 'tty' } ] } ],
  files: [ { id: 'tty', flags: 'O_RDWR', pos: 0, to: 'pts' }, { id: 'out', flags: 'O_WRONLY|O_CREAT|O_TRUNC', pos: 0, to: 'f1', hl: true } ],
  inodes: [ { id: 'pts', label: '/dev/pts/0', sub: 'inode 14・端末' }, { id: 'f1', label: '/home/you/out.txt', sub: 'inode 151', hl: true } ],
}
```

```fig pagetable fork の直後。親と子が同じ物理フレームを指す
{
  tables: [
    { label: '親', pages: [ { vpn: '0x00400', name: 'text', frame: 3, flags: 'r-x' }, { vpn: '0x00601', name: 'data', frame: 7, flags: 'r--', state: 'cow' }, { vpn: '0x00800', name: 'heap', state: 'none' } ] },
    { label: '子', pages: [ { vpn: '0x00400', name: 'text', frame: 3, flags: 'r-x' }, { vpn: '0x00601', name: 'data', frame: 7, flags: 'r--', state: 'cow' } ] },
  ],
  frames: [ { n: 3, label: 'プログラム' }, { n: 7, label: 'データ' }, { n: 8 } ],
}
```

```fig gantt ラウンドロビン
{
  rows: [
    { label: 'A', spans: [ { from: 0, to: 10 }, { from: 10, to: 20, kind: 'ready' }, { from: 20, to: 30 }, { from: 30, to: 60, kind: 'wait', label: 'sleep' } ] },
    { label: 'B', spans: [ { from: 10, to: 20 }, { from: 30, to: 40 } ] },
  ],
  switches: true, cpu: true, marks: [ { at: 30, label: 'A が sleep する' } ],
}
```
````

- `fdtable`：`procs[].fds[].to` → `files[].id`、`files[].to` → `inodes[].id`。`hl` で強調、`closed` で閉じた fd、`kind: 'pipe'` でパイプの色。`refs` を省くと、指している fd の数になる
- `pagetable`：ページ表は 2 つまで（1 つなら `pages: [...]` と書ける）。`state: 'cow'`（CoW の印）、`state: 'none'`（未割り当て）。`frames` は配列か数。どこからも指されていないフレームは「空き」、2 つ以上から指されると共有の色
- `gantt`：`rows`（`spans` の `kind` は なし = 実行 / `'ready'` = 順番待ち / `'wait'` = 待ち）か、`runs: [['A', 0, 10], …]`。`switches` `cpu` `marks` `end` `tick` `unit` `width`
- どの図も `steps: [{ title, say, …差分 }]` でステップ切り替えにできる

## 画面を拡張する（mm、sched などの部品を足した人向け）

- 「システムを見る」にタブを足す：`LNXVIEW.sections.push({ id, title, render(ctx) → HTML, changed(ctx), bind(el, ctx) })`。`ctx = { sys, run: { events, trace }, state, esc, fmtN, redraw }`
- プロセスの表に列を足す：`LNXVIEW.procCols.push({ head: 'RSS', cls: 'num', show: (ps) => …, cell: (p) => … })`（`sys.ps()` に `vsz` / `rss` / `nice` が入れば、何もしなくても列が出る）
- `trace="mem"` などの観察の出し方：`LNXUI.traceViews.mem = (events, r) => HTML`。登録がなければ、events のうち type が関係するもの（`lnx-run.js` の `TRACE_TYPES`）を 1 行ずつ出す
- 読み込むスクリプトは `src/lib/lnx-files.mjs` に足す

## 検査

スクリプトと `node_modules` はスクラッチパッドに置く（サイトの中には入れない）。

- `check-chapter.mjs chNN …` … Node だけで章を検査（setup、実行ブロックの error の印、図、確認問題の模範解答・再現性・別解・誤答）
- `browser-check.mjs [chNN …] [--shots]` … ヘッドレス Chrome で file:// から開き、全実行ブロックを上から順に実行（印のとおりに終わる、別の機械で `GRADE.runBlock` した結果と一致）、飛ばして実行 →「前を順に実行」→「リセット」、「システムを見る」パネル（全タブ、fd 表、inode）、確認問題（未入力・不正解・正解・正解済み）、実験場（`ls -l`、`sleep 2 &` と `jobs`、Ctrl-C / Ctrl-Z / Ctrl-D、Tab 補完、続きの行、履歴、保存、全サンプル）、ページのエラー 0 件、幅 390px で横スクロールなし、を確かめる。`--shots` でライト / ダーク × 幅 1280 / 390 のスクリーンショットを撮る

小さな Linux の制約（本物との違い）は `kernel.js` の先頭コメントと付録の章を見る。時間は仮想時間（1 tick = 1 ミリ秒）で、コマンドを実行している間だけ進む（実験場だけは、バックグラウンドのジョブがある間、実時間に合わせて進める）。

UI は unslop（Damir Sokolovsky, CC BY 4.0, https://github.com/heydamir/unslop）のチェックリストに沿って調整。
