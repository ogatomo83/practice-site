# 図解 GCP — 設計

Google Cloud（GCP）の「入れ物と人」（組織・フォルダ・プロジェクト、リージョン、請求先、アカウントの種類、IAM）を先に固め、主要サービス（Cloud Storage、Compute Engine、VPC、Cloud Run、Cloud Run functions、Pub/Sub、Firestore、Cloud SQL、BigQuery、Cloud Logging / Monitoring）に絞って学ぶ学習サイト。ブラウザの中で動く「小さな GCP」（Cloud Shell と gcloud・bq・curl・node、各サービスの模型）で、本文のコマンドをその場で実行できる。`docs/rust`、`docs/postgresql`、`docs/cpu`、`docs/linux` と同じ作りで、作り方・粒度・検査の基準は `docs/.claude/skills/zukai-site/` に従う。

- サイト名（BRAND）：`図解 GCP`
- localStorage の接頭辞：`zg-`
- 置き場所：`docs/gcp/`。ビルドは `node src/build.mjs`（`docs/gcp` で実行）
- 外部から読み込むもの：Google Fonts、DuckDB-Wasm（`@duckdb/duckdb-wasm@1.32.0`、BigQuery の SQL）、PGlite（`@electric-sql/pglite@0.5.12`、Cloud SQL の PostgreSQL）。どちらも使うときに jsDelivr から読む

## 実行環境の方針（なぜ本物の GCP を使わないか）

GCP 全体をまねる無料の模型はない（AWS の LocalStack にあたるものがない）。Pub/Sub や Firestore の公式エミュレータ、fake-gcs-server、bigquery-emulator はあるが、どれもブラウザでは動かず、組織・プロジェクト・IAM・請求先といった「入れ物」はどれにもない。この本でいちばん見せたいのはその入れ物なので、**模型を自作する**。

- コマンドの名前、フラグ、出力の形、エラーの文は、本物の gcloud / bq / psql / curl / Node.js に合わせる。照合できなかった出力は、公式ドキュメントの例と知識に基づく。付録に違いの一覧を載せる
- 権限の判定は、組織 → フォルダ → プロジェクト → リソースの順に IAM ポリシーをたどる（`GCP.check`）。どの API 呼び出しも `GCP.api` を通り、「API が有効か」「請求先があるか」「権限があるか」を調べ、監査ログに残す
- BigQuery の SQL は DuckDB に書き換えて実行する（`bq.js` の `translate`）。料金にあたる「処理したバイト数」は、参照した列と、パーティションで絞った行から、本物と同じ数え方（INT64 は 8 バイト、STRING は 2 + UTF-8 のバイト数…）で計算する
- Cloud SQL は PGlite（本物の PostgreSQL 18）で実行する。world には成功した書き換えの SQL の列だけを持ち、エンジンは流し直して作る
- 時間は仮想時間。2026-11-16T09:00:00Z から始まり、コマンドごとに少し、VM の作成やデプロイでは本物と同じくらい進む。乱数は使わず、ID はハッシュで決める。だから毎回同じ結果になり、採点できる

## 章立て（序 + 17 章 + 付録）

| 章 | タイトル | 主な内容 |
| --- | --- | --- |
| 0 | はじめに | このサイトの使い方。最初の gcloud。小さな GCP、リセット、「クラウドを見る」、確認問題、実験場 |
| 1 | Google Cloud の全体像 | クラウドとは（オンプレミス、IaaS / PaaS / サーバーレス）、歴史（App Engine 2008 → Compute Engine → BigQuery → Google Cloud）、サービスの地図とこの本の範囲、操作の 3 つの道（コンソール、gcloud、API）、`--log-http` と curl で API を見る、gcloud の文法と `--format` `--filter` `--flatten`、無料トライアルと無料枠 |
| 2 | リソースの階層 | 組織、フォルダ、プロジェクト（ID・名前・番号）、ID の決まりと世界で 1 つ、作成、ラベル、削除と 30 日の猶予と undelete、get-ancestors、move、組織がない場合、フォルダの設計 |
| 3 | リージョン、ゾーン、API | リージョン・ゾーン・マルチリージョン、障害の範囲、データの所在地、`gcloud config`（compute/region、configurations で切り替え）、API の有効化（services list / enable、無効のときのエラー、依存） |
| 4 | 請求先アカウントと料金 | 請求先アカウントとプロジェクト、請求先がないとき（サンドボックス、有効化のエラー）、link / unlink、従量課金と無料枠、予算とアラート（予算は止めない）、費用を止める方法 |
| 5 | アカウントの種類 | 個人の Google アカウント、管理されたアカウント（Workspace / Cloud Identity）、組織とドメイン、グループ、サービスアカウント（自作・既定・サービスエージェント）、鍵と借用（impersonation）、allUsers / allAuthenticatedUsers、gcloud auth、ADC |
| 6 | IAM の基本 | プリンシパル・ロール・権限・ポリシー、基本 / 事前定義 / カスタムロール、add / remove-iam-policy-binding、継承（許可の和）、リソースの IAM、条件、最小権限、組織のポリシー（ドメイン制限）、「Permission denied」の読み方 |
| 7 | Cloud Storage | バケットとオブジェクト、名前空間、場所とストレージクラス、cp / ls / cat / rm、フォルダはない、公開と公開アクセス防止、均一なバケットレベルのアクセス、バージョニング、ライフサイクル、curl で読む |
| 8 | Compute Engine | VM、マシンタイプ、イメージ、ディスク、作成と ssh、startup-script、メタデータサーバ、サービスアカウントとアクセススコープ、停止と外部 IP、静的 IP、スナップショット、Spot VM、無料枠 |
| 9 | VPC ネットワーク | グローバルな VPC とリージョンのサブネット、default ネットワーク、カスタムモード、ファイアウォール（暗黙の拒否、タグ、優先度）、外部 IP と内部 IP、Cloud NAT、限定公開の Google アクセス、IAP 経由の SSH |
| 10 | Cloud Run | コンテナ、デプロイと URL、認証（allUsers と ID トークン）、リビジョンと環境変数、トラフィック分割とタグ、ソースからのデプロイ（Cloud Build、Artifact Registry）、PORT、スケール（0 まで、コールドスタート、同時実行）、サービスアカウント、ログ |
| 11 | Cloud Run functions | 関数、Functions Framework、HTTP 関数、デプロイと呼び出し、イベント関数（Pub/Sub、Cloud Storage）と CloudEvent、ログ、Cloud Run との関係 |
| 12 | Pub/Sub | 非同期の連携、トピックとサブスクリプション、publish / pull / ack、確認応答の期限と再配信（少なくとも 1 回）、ファンアウト、フィルタ、push、デッドレター、Node の SDK |
| 13 | Firestore | ドキュメントとコレクション、ネイティブ / Datastore モード、データベースの作成、SDK で読み書き、クエリ、インデックス（単一は自動、複合は作る）、トランザクションとバッチ、料金は読み書きの回数 |
| 14 | Cloud SQL | マネージドの PostgreSQL、エディションとティア、データベースとユーザー、gcloud sql connect、接続の方法（承認済みネットワーク、Auth Proxy、プライベート IP、Cloud Run から）、バックアップと復元、止めて料金を抑える |
| 15 | BigQuery | 列指向のデータウェアハウス、データセットとテーブル、公開データセット、bq query、標準 SQL とレガシー SQL、処理したバイト数と dry run、パーティションとクラスタ、キャッシュ、load、CTAS とビュー、DML、INFORMATION_SCHEMA.JOBS、権限とサンドボックス |
| 16 | Cloud Logging と Monitoring | ログエントリ、監査ログの種類、logging read とクエリ、構造化ログ、保持期間、シンク（BigQuery へ）、ログベースの指標、アラートポリシー、稼働時間チェック |
| 17 | まとめ：つばめ文具を載せる | フォルダとプロジェクトの設計、グループに IAM、Cloud Run の注文 API と Firestore、Pub/Sub と関数で BigQuery へ、ログとアラート、予算、片付け。Terraform の紹介 |
| 付録 | 早見表と違いの一覧 | gcloud / bq の早見表、用語集、このサイトの GCP と本物の違い |

## 登場人物と最初の世界（`sys.js`、`core.js` の `newWorld`）

- 組織 `tsubame.example`（ID `405918273641`、顧客 ID `C03k8x2pq`）。請求先アカウント `01A2B3-C4D5E6-F7A8B9`（つばめ文具 請求先、JPY）
- 人：`you@`（小林 遥、読者。組織の管理者、フォルダ管理者、請求先の利用者）、`alice@`（アプリ開発）、`bob@`（売上分析）、`admin@`（Workspace の特権管理者）、`taro@example.com`（個人の Google アカウント、組織の外）
- グループ：`dev-team@`（alice、you）、`analysts@`（bob）
- プロジェクト：`tsubame-shop`（本番の店。請求先あり。最初から gcloud の既定）、`tsubame-public`（公開データセット `bungu` の products / customers / orders。orders は order_date で日ごとのパーティション、channel でクラスタ）
- `gcloud auth login ACCOUNT` で、ほかの人に切り替えられる（本物はブラウザでログインする）

## 記法（確定。判定は `src/assets/grade.js`、先頭のコメントが正）

小さな GCP のファイルと読み込み順は `src/lib/gcp-files.mjs`（build.mjs と検査スクリプトが共有。grade.js は最後）。

- ` ```sh setup ` … 章の準備。ページの機械を起動した直後に、章の中のすべての setup を順に流す（本文には折りたたみで出す）。確認問題の初期状態にも入る
- ` ```sh run ` … ページの機械で実行（上から積み上がる）。ブロックは「端末に 1 回で打つ単位」に分けて（ヒアドキュメント、for、閉じていない引用符は次の行とつなげる）、1 つずつ実行する。属性：`title="..."`、`error`（どれかのコマンドが 0 以外で終わるのが正しい例）、`stdin="y\n"`（最初のコマンドの標準入力。`\n` が使える）
- 確認問題 `:::quiz タイトル` … `:::` で閉じる。中に：` ```sh answer `（模範解答、必須。属性 `unordered`、`exit`、`forbid="a,b"`、`require="a"`）、` ```sh check `（実行の後にこれを実行した標準出力を比べる）、` ```sh prep `（その問題だけの準備）、` ```sh vary `（準備のデータを変える追加の準備。何個でも。数字や文字列を答えにする問題には必ず付ける）、` ```sh starter `、`:::hint`
- 採点：模範解答と読者のコマンドを、それぞれ「起動 + 章の setup の clone + prep（+ vary）」で実行し、標準出力（check があればその出力）を比べる。行末の空白と最後の空行は無視
- ID やタイムスタンプは「その前に打ったコマンドの数」で変わる。確認問題の答えには、ID・時刻・生成されたメッセージ ID などを出させない（`--format="value(name)"` などで、名前や数を出させる）

## 検査

- 章：`scratchpad/gcp/check-chapter.mjs chNN [-v]`（全ブロックを上から実行、error の印、確認問題の模範解答・2 回の再現・vary・出力の直書きが通らないこと、`alts/chNN.json` の別解と誤答）
- ブラウザ：`scratchpad/gcp/shot.mjs chNN [png]`（ヘッドレス Chrome で全ブロック、エンジン、パネル）、ライト / ダーク、幅 390px
