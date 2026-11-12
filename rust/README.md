# 図解 Rust

The Rust Programming Language（日本語版）の全 20 章と付録を、図を中心に日本語で書き直した学習サイト。

## 読む

`site/index.html` をブラウザで開く。サーバは不要。

## 編集・ビルド

```console
$ node src/build.mjs    # docs/rust で実行
```

| パス | 内容 |
| --- | --- |
| `src/chapters/chNN.md` | 原稿（軽量マークダウン + 図のフェンス） |
| `src/lib/diagrams.mjs` | SVG 図エンジン（mem / graph / tree / life / seq / bars / layout） |
| `src/lib/highlight.mjs` | Rust / TOML / ターミナルのハイライタ |
| `src/assets/` | スタイルとスクリプト |
| `site/` | 生成物 |

原稿の記法：

- ` ```rust fail ` / `panic` / `ok`、`file="src/main.rs"` でコードブロックにラベル
- 行頭 `@@` で変更行を強調
- ` ```fig mem キャプション ` の後に JS オブジェクトで図を記述。`steps: [...]` で段階切替
- `:::note` / `:::key` / `:::warn` / `:::tip` / `:::deep` / `:::try` / `:::rustc E0382 メッセージ` でコールアウト

UI は unslop（Damir Sokolovsky, CC BY 4.0, https://github.com/heydamir/unslop）のチェックリストに沿って調整。
