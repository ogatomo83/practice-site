# 原稿の記法（src/chapters/chNN.md）

正は各サイトの `src/build.mjs`（`parseBlocks` / `codeBlock` / `quizBlock`）と `src/lib/diagrams.mjs`。記法を足したら README にも書く。

## front matter

```yaml
---
num: 3                    # 章番号。0 は「序」と表示
title: SELECT の基本
short: SELECT             # サイドバーに出す短い名前
lead: この章で何を学ぶかを 1〜2 文で。
time: 60 分               # 目安の時間（付録は「必要なときに」）
appendix: true            # 付録のみ
numbered: false           # 節番号を付けない章のみ
db: shop                  # postgresql のみ。使うデータセット（none で空）
---
```

## 見出し・本文

- `## 見出し {#id}` が節になる。目次、サイドバー、検索、読了ボタンに使われる。`###`、`####` は小見出し
- 段落、`- ` 箇条書き、`1. ` 番号付き、`|` 表、`> ` 引用、`` `code` ``、`**強調**`、`[リンク](url)`

## コードブロック

| フェンス | 意味 |
| --- | --- |
| ` ```sql run ` | その場で実行できる SQL（postgresql）。`title="..."` で見出し、`error` で「エラーになる」 |
| ` ```sql setup ` | 章の準備 SQL。最初の実行時に自動で流れ、本文には折りたたみで出る |
| ` ```sql norun ` / ` ```psql ` / ` ```conf ` / ` ```console ` | 実行しない例 |
| ` ```rust fail ` / `panic` / `ok` | rust：コンパイルエラー / パニック / 成功の印。`file="src/main.rs"` でラベル。行頭 `@@` で変更行を強調 |

## コールアウト（`:::種類 タイトル` 〜 `:::`、入れ子可）

`note`（メモ）、`tip`（コツ）、`warn`（注意）、`key`（要点・章末のまとめ）、`hist`（歴史）、`deep`（深掘り。折りたたみ）、`try`（やってみよう）、`cols` と `col 見出し`（横並び）、`pgerr SQLSTATE メッセージ`、`rustc E0382 メッセージ`（エラー解説カード）。

## 図（` ```fig 種類 キャプション ` の中に JS オブジェクト）

| 種類 | spec |
| --- | --- |
| `graph` | `{ nodes:[{id,label,sub,x,y,w,kind}], edges:[{from,to,label,style,curve,both}], groups:[{label,nodes,kind}], col, row }`。x と y はグリッド座標、label の `\n` で改行 |
| `mem` | `{ stack:[{frame, vars:[…]}], heap:[…], statics:[…] }`。値が `'→id'` ならポインタ |
| `tree` | `{ root:{label, kind, note, children:[…]}, title }` |
| `seq` | `{ actors:[{id,label,kind}], msgs:[{from,to,label,style} \| {note,at,span} \| {self,label} \| {gap}] }` |
| `life` | `{ code:[行], spans:[{label,from,to,style}], marks:[{line,text,style}] }` |
| `bars` | `{ items:[{label,value,hl}], unit, max }` |
| `layout` | `{ rows:[{label, cells:[{t,w,kind}], note}], unit }`（バイト列） |
| `timeline` | `{ items:[{at,label,sub,hl,kind}], axisLabel }`（年表） |

- どの図も `steps:[{title, say, …差分}]` を付けると、段階を切り替えられる図になる
- `kind` と `style` の色の名前（accent / ink / muted / steel / sage / dashed / bad、stack / ext など）は diagrams.mjs の該当箇所を見る
- 文字幅は `tw()` で概算される。全角は 1em。長いラベルは `\n` で折る

## 確認問題

````
## 確認問題 {#quiz}

この章の内容を、自分で SQL を書いて確かめます。…（導入 1〜2 文）

:::quiz 見出し
問題文（何を、どの列で、どの順に出すかを明記する）

```sql prep
-- この問題だけの準備（任意）
```

```sql starter
-- 入力欄の初期値（任意）
```

```sql answer ordered
select …;   -- 模範解答（必須）。ordered は並び順も判定する
```

```sql check
select try_sql($$insert into members values (1, 'a@x')$$) as 重複;  -- 書き換えの問題で、実行後の状態を調べる（任意）
```

:::hint
ヒント（任意）
:::
:::
````

- 問題の ID は `chNN-n`（章内の通し番号）で自動的に付く
- `check` があるときは、読者の出力ではなく `check` の結果を比べる
