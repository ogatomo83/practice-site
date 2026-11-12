# 図解 PostgreSQL

PostgreSQL と SQL を、歴史・SQL・内部構造・運用まで、ブラウザの中で動く PostgreSQL 18（PGlite）で実行しながら学ぶ学習サイト。全 20 章と付録。

## 読む

`site/index.html` をブラウザで開く。サーバは不要。

- 本文の SQL は「実行」ボタン（Ctrl / ⌘ + Enter）でその場で実行でき、書き換えもできる
- 初回の実行時に PGlite（約 7 MB）を CDN（jsDelivr）から読み込むので、インターネット接続が必要
- データベースはページごとに 1 つ。上部の「リセット」で初期状態に戻る
- 上部の「DB を見る」で、画面の下にいまのデータベースの中身を表で出す。テーブルはタブで切り替え、「構造」で列・インデックス・制約を見る。SQL を実行するたびに、直前の SQL が変えたテーブルを自動で開き、追加・変更・削除された行に色を付ける。上端をドラッグして高さを変えられる
- 章の中の SQL は上から順に積み上げる作り。前の SQL を飛ばしてエラーになったときは、前の SQL をまとめて実行するボタンが出る
- 各章の最後に「確認問題」（全 64 問）。自分で SQL を書いて「答え合わせ」を押すと、模範解答と出力が同じかを判定する（列名・行の順番・列の順番・`2000` と `2000.00` の違いは問わない。順番を指定した問題だけ並び順も見る）。採点は本文とは別の PostgreSQL で、毎回トランザクションの中で実行して取り消す。正解した問題はブラウザに記録され「正解済み」になる
- `site/playground.html` は自由に SQL を試せる実験場

## 編集・ビルド

```console
$ node src/build.mjs    # docs/postgresql で実行
```

| パス | 内容 |
| --- | --- |
| `src/chapters/chNN.md` | 原稿（軽量マークダウン + 図のフェンス + 実行できる SQL） |
| `src/datasets/shop.sql` | 全章共通のサンプルデータベース（文具店「つばめ文具」） |
| `src/lib/diagrams.mjs` | SVG 図エンジン（図解 Rust から流用し、年表 `timeline` を追加） |
| `src/lib/highlight.mjs` | SQL / psql / シェルのハイライタ |
| `src/assets/sqlhl.js` | SQL のトークナイザ・ハイライタ・文の分割（ブラウザとビルドで共用） |
| `src/assets/sql.js` | PGlite を読み込み、SQL ブロックを実行するランナー |
| `src/assets/dbview.js` | 「DB を見る」パネル |
| `src/assets/quiz.js` | 確認問題の答え合わせ（採点用 DB、出力の比較） |
| `site/` | 生成物 |

原稿の記法（図解 Rust と共通のものに加えて）：

- ` ```sql run ` … 実行できる SQL。`error` を付けるとエラーになる例（「エラーになる」印）。`title="..."` で見出し
- ` ```sql setup ` … その章の準備 SQL。最初の実行時に自動で流れる（本文には折りたたみで表示）
- ` ```sql norun ` / ` ```psql ` / ` ```conf ` … 実行しない例
- front matter の `db:` … 使うデータセット（既定 `shop`、`none` で空）
- `:::pgerr SQLSTATE メッセージ` … エラー解説のカード、`:::hist` … 歴史のコラム
- ` ```fig timeline キャプション ` … 年表（`items: [{ at, label, sub, hl, kind }]`）
- `:::quiz 見出し` … 確認問題。中に問題文と次のブロックを書く
  - ` ```sql answer ` … 模範解答（必須）。`ordered` を付けると行の並び順も判定する
  - ` ```sql check ` … INSERT / UPDATE / DDL の問題で、実行後の状態を調べる SELECT。読者の出力ではなく、これの結果を比べる
  - ` ```sql prep ` … その問題だけの準備 SQL（答え合わせのたびに最初に流れる）
  - ` ```sql starter ` … 入力欄に最初から入れておく SQL
  - `:::hint` … ヒント（折りたたみ）
  - 採点用 DB には補助関数 `try_sql(sql text)` がある。文を実行して、成功なら `ok`（SELECT ならその値）、失敗なら SQLSTATE を返すので、制約の問題の check で使う
  - 採点は模範解答と読者の SQL を同じ状態から実行して比べるので、`now()` や xmin のように実行ごとに変わる値を答えにしない

## 検査

すべての SQL ブロックは、ヘッドレス Chrome で file:// から開いたページ上で実行し、「エラーになる」印の有無と結果が一致することを確かめている（379 ブロック）。

PGlite の制約：接続は 1 つだけ（2 セッションの競合は図と実行しない例で説明）、並列クエリなし、ファイルを扱う COPY は不可。

UI は unslop（Damir Sokolovsky, CC BY 4.0, https://github.com/heydamir/unslop）のチェックリストに沿って調整。
