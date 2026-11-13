# 図解シリーズ（学習サイト）

図を中心に、日本語で書いた学習サイト集。各サイトは静的 HTML で、`site/index.html` をブラウザで開けば読める（サーバ不要）。入口は `index.html`。

| サイト | 内容 |
| --- | --- |
| [図解 Rust](rust/) | The Rust Programming Language（日本語版）の全章を図中心に書き直したもの |
| [図解 PostgreSQL](postgresql/) | 歴史・SQL・内部構造・運用。本文の SQL をブラウザ内の PostgreSQL 18（PGlite）で実行でき、章末に自動採点の確認問題がある |
| [図解 CPU](cpu/) | 論理ゲートから RISC-V の CPU、パイプライン、キャッシュまで。自作のエミュレータと回路シミュレータで本文を実行できる |
| [図解 Linux](linux/) | シェルからカーネルの内部（プロセス、システムコール、VFS、仮想メモリ、スケジューラ、ネットワーク、コンテナ）まで。ブラウザで動く教育用の小さな Linux（自作）で本文のコマンドを実行できる |

ビルドは各サイトのディレクトリで `node src/build.mjs`（依存パッケージなし）。作り方と粒度の基準は `.claude/skills/zukai-site/`、編集の決まりは `CLAUDE.md`。
