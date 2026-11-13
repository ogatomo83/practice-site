# docs/ — 「図解」学習サイト集

日本語の学習サイトを題材ごとに置いている。`index.html` が入口（各サイトへのカード）。

- `rust/` — 図解 Rust（図が中心、コードは読むだけ）
- `postgresql/` — 図解 PostgreSQL（本文の SQL をブラウザ内の PostgreSQL 18 / PGlite で実行、章末に自動採点の確認問題）
- `cpu/` — 図解 CPU（自作の RISC-V エミュレータ `rv.js` と論理回路シミュレータ `logic.js` で、本文のアセンブリと回路を実行。判定は `grade.js` に集約。設計は `cpu/DESIGN.md`）
- `linux/` — 図解 Linux（自作の教育用カーネル「小さな Linux」（`src/assets/kernel.js` ほか。読み込み順は `src/lib/lnx-files.mjs`）で、本文のシェルのコマンドを実行。判定は `grade.js` に集約。設計と記法は `linux/DESIGN.md`）

新しいサイトを作る・章や確認問題を足す・実行環境を作る・検査するときは、**`zukai-site` スキル**の手順に従う（`.claude/skills/zukai-site/`。粒度は `references/granularity.md`、実行環境は `references/runtime.md`）。

## 編集の決まり

- 編集するのは `src/` だけ。`site/` は生成物なので手で直さない。直したら各サイトのディレクトリで `node src/build.mjs` を実行する
- 原稿は `src/chapters/chNN.md`。記法は各サイトの README.md と、スキルの `references/notation.md` を見る
- 見出しの `{#id}` は変えない（読了の記録、リンク、確認問題の ID が依存している）
- localStorage のキーの接頭辞はサイトごとに別にする（rust: `zr-`、postgresql: `zp-`、cpu: `zc-`、linux: `zl-`）
- 本文に書く数値や挙動は、実際に動かして確かめたものだけにする。PGlite の制約（接続は 1 つ、並列クエリなし、ファイルを使う COPY は不可）に当たる内容は、図と実行しない例で説明する
- 確認問題は「出力が合えば正解」。誤答でも同じ出力になる問題、`now()` や xmin のように実行ごとに変わる値を答えにする問題は作らない
- git リポジトリ（https://github.com/ogatomo83/practice-site、このディレクトリがルート）。`site/` も生成物としてコミットする。main を push すると GitHub Pages（https://ogatomo83.github.io/practice-site/ ）に公開される。`.nojekyll` は消さない（消すと原稿の front matter を Jekyll が処理してビルドが失敗する）。原稿を書き換えたら `node src/build.mjs` で再ビルドしてから一緒にコミットする
- 変更したら、実行ブロックと確認問題を検査してから終える（手順はスキルの「検査」）
- 章数、図の数、実行できる SQL の数が変わったら、`index.html` のカードと README の数字も直す
