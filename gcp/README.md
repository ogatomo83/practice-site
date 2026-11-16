# 図解 GCP

Google Cloud（GCP）の入れ物（組織・フォルダ・プロジェクト）、リージョン、請求先、アカウントの種類、IAM を先に固めてから、主要サービス（Cloud Storage、Compute Engine、VPC、Cloud Run、Cloud Run functions、Pub/Sub、Firestore、Cloud SQL、BigQuery、Cloud Logging / Monitoring）を、ブラウザの中で動く「小さな GCP」（自作の模型。JavaScript）で gcloud と bq を打ちながら学ぶ学習サイト。序章 + 17 章 + 付録。設計は `DESIGN.md`。

## 読む

`site/index.html` をブラウザで開く。サーバは不要。BigQuery の SQL（DuckDB-Wasm）と Cloud SQL（PGlite）を使うブロックでは、初回だけ jsDelivr からエンジンを読み込む。本物の Google Cloud にはつながらず、料金もかからない。

- 本文のコマンド（` ```sh run `）は「実行」ボタン（Ctrl / ⌘ + Enter）でその場で実行でき、書き換えもできる。「元に戻す」で最初の内容に戻る
- 1 ページに 1 つの小さな GCP。ブロックは上から順に積み上がる（前のブロックで作ったバケットや VM を、後のブロックが使う）。前のブロックを飛ばすと「前を順に実行」が出る。上部の「リセット」で、そのページの GCP を最初の状態（章の準備 ` ```sh setup ` を流した直後）に戻す
- 出力欄は Cloud Shell 風：プロンプト（`you@cloudshell:~ (プロジェクト)$`）+ コマンド + 出力。stderr は色が変わる。0 以外の終了ステータスと、そのブロックで進んだ仮想時間が出る
- 上部の「クラウドを見る」で、画面の下にパネルを出す。タブ：
  - **階層と IAM** … 組織 → フォルダ → プロジェクト → リソース（バケット、VM、Cloud Run、トピック、データセット…）の木。行を押すと、そこに効いている IAM の割り当て（直接のものと、上から引き継いだもの。いまの gcloud のアカウントに当たる行に色）。直前のブロックで新しくできたものに緑の印
  - **アカウント** … 人の Google アカウント（管理されたアカウント / 個人）、グループ、サービスアカウント
  - **API と請求** … プロジェクトごとの請求先と、有効な API。予算
  - **監査ログ** … だれが・いつ・何をしたか（許可と拒否）
- 各章の最後に「確認問題」。コマンドを書いて「答え合わせ」を押すと、模範解答と同じ出力かを判定する。毎回、章の最初の状態の GCP を複製して実行するので、何度でも試せて、本文のブロックにも影響しない。準備のデータを変えた版でも比べるので、答えを直接書いただけでは通らない
- `site/playground.html` は実験場。Cloud Shell 風の端末（Enter で実行、閉じていない引用符やヒアドキュメントは改行、↑↓ で履歴）と、いつも開いている「クラウドを見る」

## 編集・ビルド

```console
$ node src/build.mjs    # docs/gcp で実行
```

| パス | 内容 |
| --- | --- |
| `src/chapters/chNN.md` | 原稿 |
| `src/build.mjs` | 静的サイト生成器 |
| `src/lib/gcp-files.mjs` | 小さな GCP のファイルと読み込み順（build.mjs と Node の検査が共有。grade.js は最後） |
| `src/assets/core.js` | 世界の状態（JSON）、ID と仮想時間、リソースの階層、IAM（ロールと権限、`GCP.check`）、API 呼び出しの入口（`GCP.api`）と監査ログ |
| `src/assets/sh.js` | Cloud Shell のシェル（変数、引用符、`$( )`、パイプ、ヒアドキュメント、for、if、リダイレクト）と手元のファイル、ふつうのコマンド |
| `src/assets/format.js` | gcloud の `--format`（json / yaml / value / table / csv …）、`--filter`、`--flatten`、`--sort-by`、`--limit` |
| `src/assets/gcloud.js` | gcloud の骨組み（引数、共通のフラグ、エラーの表示）と、config / auth / projects / organizations / folders / services / billing / iam / org-policies |
| `src/assets/net.js` | HTTP の行き先と `curl` |
| `src/assets/storage.js` `compute.js` `jsrt.js` `run.js` `pubsub.js` `firestore.js` `cloudsql.js` `bq.js` `logging.js` | 各サービス。`jsrt.js` は読者の JavaScript を動かす小さな Node.js（express、Functions Framework、`@google-cloud/*` の SDK の模型、`pg`） |
| `src/assets/sys.js` | 1 台の「Cloud Shell + 小さな GCP」（`GCP.boot`、`sys.run`、`sys.clone`） |
| `src/assets/grade.js` | 実行ブロックと確認問題の意味（`GRADE.boot` / `runBlock` / `quiz`。どれも Promise） |
| `src/assets/gcp-run.js` | 実行ブロックのランナーと端末風の表示（`GCPUI`） |
| `src/assets/gcpview.js` | 「クラウドを見る」（`GCPVIEW.sections` にタブを足せる） |
| `src/assets/quiz.js`、`play.js`、`app.js`、`hl.js`、`style.css` | 確認問題、実験場、テーマ・検索・読了、ハイライタ、見た目。localStorage の接頭辞は `zg-` |
| `site/` | 生成物 |

## 原稿の記法（確定版は `DESIGN.md`）

図解 Rust / PostgreSQL / CPU / Linux と共通のもの（front matter、`## 見出し {#id}`、`:::note` `tip` `warn` `key` `hist` `deep` `try` `cols`、` ```fig 種類 キャプション `）に加えて：

- ` ```sh run [title="..."] [error] [stdin="y\n"] ` … 実行できるブロック。「端末に 1 回で打つ単位」に分けて 1 つずつ実行する
- ` ```sh setup ` … 章の準備（自動で流れる。本文には折りたたみで出る）
- `:::quiz 見出し` … 確認問題。` ```sh answer [unordered] [exit] [forbid="…"] [require="…"] `（必須）、` ```sh check `、` ```sh prep `、` ```sh vary `（何個でも）、` ```sh starter `、`:::hint`

## このサイトの GCP の制約（本物との違いは付録に一覧）

- コンソール（Web の管理画面）はない。`gcloud auth login` はブラウザを開かず、引数のアカウントに切り替える
- `gcloud compute ssh` は `--command` で 1 回実行する使い方だけ。VM の中のシェルは小さく、パッケージは nginx / apache2 など少しだけ
- Cloud Run と関数で動かせるのは Node.js のコードだけ（express、Functions Framework、`@google-cloud/firestore` `pubsub` `bigquery`、`pg` の模型）。Dockerfile は `FROM node:…` か、サンプルのイメージだけを組み立てる
- BigQuery の SQL は DuckDB に書き換えて実行する。よく使う関数（COUNTIF、SAFE_DIVIDE、FORMAT_DATE、DATE_TRUNC、DATE_DIFF、UNNEST、QUALIFY…）は対応しているが、すべてではない
- 時間は仮想。料金は発生しない（本文で「本物ならいくらか」を説明する）

## 検査

スクラッチパッドの `check-chapter.mjs chNN [-v]`（Node で全ブロックと確認問題）と、`shot.mjs chNN`（ヘッドレス Chrome）。依存は `@duckdb/duckdb-wasm`、`@electric-sql/pglite`、`puppeteer-core`（スクラッチパッドに置き、サイトには入れない）。

見た目は unslop（https://github.com/heydamir/unslop, CC BY 4.0）のチェックリストに沿って調整した。
