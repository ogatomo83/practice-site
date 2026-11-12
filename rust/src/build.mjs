// 図解 Rust — 静的サイトビルド
// 原稿: src/chapters/*.md（軽量マークダウン + 図フェンス） → docs/*.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { highlight, esc } from './lib/highlight.mjs';
import { renderFig } from './lib/diagrams.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, '..', 'site');
const CH_DIR = path.join(ROOT, 'chapters');

// ---------------------------------------------------------------- inline
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}"${/^https?:/.test(u) ? ' target="_blank" rel="noopener"' : ''}>${t}</a>`)
    .replace(/\[\[([^\]]+)\]\]/g, '<kbd>$1</kbd>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
}

// ---------------------------------------------------------------- block parser
function parseInfo(info) {
  const out = { flags: new Set(), attrs: {} };
  const re = /(\w+)="([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(info))) {
    if (m[1]) out.attrs[m[1]] = m[2];
    else out.flags.add(m[3]);
  }
  return out;
}

function codeBlock(lang, info, body) {
  const { flags, attrs } = parseInfo(info);
  const label = { rust: 'Rust', toml: 'TOML', console: 'ターミナル', text: '', html: 'HTML' }[lang] ?? lang;
  let badge = '';
  if (flags.has('fail')) badge = '<span class="code-badge is-fail">コンパイルエラーになる</span>';
  else if (flags.has('panic')) badge = '<span class="code-badge is-panic">実行時にパニックする</span>';
  else if (flags.has('ok')) badge = '<span class="code-badge is-ok">コンパイルできる</span>';
  const file = attrs.file ? `<span class="code-file">${esc(attrs.file)}</span>` : `<span class="code-file is-lang">${label}</span>`;
  const hl = highlight(body, lang === 'html' ? 'text' : lang);
  const cls = `code ${lang === 'console' ? 'is-console' : ''} ${flags.has('fail') ? 'is-fail' : ''} ${flags.has('panic') ? 'is-panic' : ''}`;
  return `<div class="${cls}"><div class="code-h">${file}${badge}<button type="button" class="copy" aria-label="コードをコピー">コピー</button></div><pre><code>${hl}</code></pre></div>`;
}

const CALLOUT_LABEL = { note: 'メモ', tip: 'コツ', warn: '注意', deep: '深掘り', key: '要点' };

function parseBlocks(lines, ctx) {
  let html = '';
  let i = 0;
  const isBlockStart = (l) => /^(```|:::|#{2,4} |\||- |\d+\. |<|> )/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // フェンス
    if (line.startsWith('```')) {
      const info = line.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      const [lang, ...rest] = info.split(/\s+/);
      if (lang === 'fig') {
        const [type, ...cap] = rest;
        let spec;
        try {
          spec = new Function(`return (${body.join('\n')})`)();
        } catch (e) {
          throw new Error(`${ctx.file}: fig parse error near "${cap.join(' ')}": ${e.message}`);
        }
        ctx.fig++;
        html += renderFig(type, spec, inline(cap.join(' ')), `${ctx.num}-${ctx.fig}`);
      } else {
        html += codeBlock(lang || 'text', rest.join(' '), body.join('\n'));
      }
      continue;
    }

    // コールアウト
    if (line.startsWith(':::')) {
      const m = line.match(/^:::(\w+)\s*(.*)$/);
      const type = m[1], title = m[2];
      const body = [];
      let depth = 1;
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (/^:::\w/.test(l)) depth++;
        else if (/^:::\s*$/.test(l)) { depth--; if (!depth) break; }
        body.push(l);
        i++;
      }
      i++;
      const inner = parseBlocks(body, ctx);
      if (type === 'rustc') {
        const [code, ...msg] = title.split(' ');
        html += `<aside class="rustc"><div class="rustc-h"><span class="rustc-code">error${code ? `[${esc(code)}]` : ''}</span><span class="rustc-msg">${inline(msg.join(' '))}</span></div><div class="rustc-b">${inner}</div></aside>`;
      } else if (type === 'deep') {
        html += `<details class="deep"><summary><span class="deep-k">深掘り</span>${inline(title)}</summary><div class="deep-b">${inner}</div></details>`;
      } else if (type === 'cols') {
        html += `<div class="cols">${inner}</div>`;
      } else if (type === 'col') {
        html += `<div class="col">${title ? `<div class="col-h">${inline(title)}</div>` : ''}${inner}</div>`;
      } else if (type === 'try') {
        html += `<aside class="try"><div class="try-h">やってみよう${title ? `<span>${inline(title)}</span>` : ''}</div>${inner}</aside>`;
      } else {
        html += `<aside class="callout is-${type}"><div class="callout-h">${CALLOUT_LABEL[type] || type}${title ? `<span>${inline(title)}</span>` : ''}</div>${inner}</aside>`;
      }
      continue;
    }

    // 見出し
    const hm = line.match(/^(#{2,4}) (.+?)(?:\s*\{#([\w-]+)\})?\s*$/);
    if (hm) {
      const lv = hm[1].length;
      const id = hm[3] || `s-${ctx.secs.length + ctx.subs + 1}`;
      if (lv === 2) {
        ctx.secs.push({ id, title: hm[2] });
        ctx.subs = 0;
        const no = `${ctx.num}.${ctx.secs.length}`;
        html += `<h2 id="${id}" data-sec="${ctx.slug}#${id}"><span class="h-no">${ctx.numLabel ? no : ''}</span>${inline(hm[2])}<button type="button" class="done-btn" data-key="${ctx.slug}#${id}" aria-pressed="false" title="読了にする"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg><span>読了</span></button></h2>`;
      } else {
        ctx.subs++;
        const sid = hm[3] || `${ctx.secs.length ? ctx.secs[ctx.secs.length - 1].id : 'top'}-${ctx.subs}`;
        if (lv === 3) ctx.secs.length && (ctx.secs[ctx.secs.length - 1].subs ||= []).push({ id: sid, title: hm[2] });
        html += `<h${lv} id="${sid}">${inline(hm[2])}</h${lv}>`;
      }
      i++;
      continue;
    }

    // 表
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|\s*$/g, '').split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, '|')));
      const head = cells(rows[0]);
      const bodyRows = rows.slice(2).map(cells);
      html += `<div class="table"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${bodyRows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>`;
      continue;
    }

    // リスト
    const lm = line.match(/^(- |\d+\. )/);
    if (lm) {
      const ordered = lm[1] !== '- ';
      const items = [];
      while (i < lines.length && (/^(- |\d+\. )/.test(lines[i]) || (/^ {2,}\S/.test(lines[i]) && items.length))) {
        if (/^(- |\d+\. )/.test(lines[i])) items.push(lines[i].replace(/^(- |\d+\. )/, ''));
        else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`;
      continue;
    }

    // 生 HTML
    if (line.startsWith('<')) {
      const body = [];
      while (i < lines.length && lines[i].trim()) body.push(lines[i++]);
      html += body.join('\n');
      continue;
    }

    // 引用
    if (line.startsWith('> ')) {
      const body = [];
      while (i < lines.length && lines[i].startsWith('> ')) body.push(lines[i++].slice(2));
      html += `<blockquote>${inline(body.join(' '))}</blockquote>`;
      continue;
    }

    // 段落
    const para = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i]))) para.push(lines[i++]);
    html += `<p>${inline(para.join(''))}</p>`;
  }
  return html;
}

// ---------------------------------------------------------------- 章の読み込み
function loadChapter(file) {
  const raw = fs.readFileSync(path.join(CH_DIR, file), 'utf8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const meta = {};
  fm[1].split('\n').forEach((l) => {
    const m = l.match(/^(\w+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2];
  });
  const slug = file.replace(/\.md$/, '');
  const ctx = { file, num: meta.num, numLabel: meta.numbered !== 'false', slug, secs: [], subs: 0, fig: 0 };
  const body = parseBlocks(raw.slice(fm[0].length).split('\n'), ctx);
  return { ...meta, slug, body, secs: ctx.secs, figs: ctx.fig };
}

const files = fs.readdirSync(CH_DIR).filter((f) => f.endsWith('.md')).sort();
const chapters = files.map(loadChapter);

// ---------------------------------------------------------------- テンプレート
const ICON = {
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.1A8.5 8.5 0 0 1 9.9 3.5a8.5 8.5 0 1 0 10.6 10.6z"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
};

const MARK = `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6"/><text x="12" y="12.5" text-anchor="middle" dominant-baseline="central">&amp;</text></svg>`;

const chLabel = (c) => (c.num === '0' ? '序' : c.num === '21' ? '付録' : `${c.num}章`);

function sidebar(active) {
  return `<nav class="side-nav" aria-label="目次">${chapters
    .map((c) => {
      const on = c.slug === active;
      return `<div class="nav-ch${on ? ' is-open' : ''}"><a class="nav-c${on ? ' is-active' : ''}" href="${c.slug}.html"><span class="nav-no">${c.num === '0' ? '序' : c.num === '21' ? 'A' : c.num}</span><span class="nav-t">${esc(c.short || c.title)}</span><span class="nav-prog" data-ch="${c.slug}" data-total="${c.secs.length}"></span></a>${
        on
          ? `<ul class="nav-secs">${c.secs
              .map((s, i) => `<li><a href="#${s.id}" data-key="${c.slug}#${s.id}"><span class="nav-sno">${c.numbered === 'false' ? '' : `${c.num}.${i + 1}`}</span><span>${inline(s.title)}</span></a></li>`)
              .join('')}</ul>`
          : ''
      }</div>`;
    })
    .join('')}</nav>`;
}

function shell({ title, body, active, desc, toc = '' }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc || 'The Rust Programming Language を図で読み解く日本語の学習書')}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+JP:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/style.css">
<script>try{var t=localStorage.getItem('zr-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body>
<header class="top">
  <button type="button" class="icon-btn menu-btn" aria-label="目次を開く">${ICON.menu}</button>
  <a class="brand" href="index.html">${MARK}<span>図解 Rust</span></a>
  <div class="search">
    ${ICON.search}
    <input type="search" id="q" placeholder="検索" autocomplete="off" aria-label="章と節を検索">
    <kbd class="kc">/</kbd>
    <div class="search-res" hidden></div>
  </div>
  <button type="button" class="icon-btn theme-btn" aria-label="テーマを切り替え"><span class="i-sun">${ICON.sun}</span><span class="i-moon">${ICON.moon}</span></button>
</header>
<div class="layout">
  <aside class="side">${sidebar(active)}<div class="side-foot">原典 <a href="https://doc.rust-jp.rs/book-ja/" target="_blank" rel="noopener">The Rust Programming Language 日本語版</a> を再構成</div></aside>
  <main class="main">${body}</main>
  ${toc}
</div>
<script src="assets/search-index.js"></script>
<script src="assets/app.js"></script>
</body>
</html>`;
}

function chapterPage(c, i) {
  const prev = chapters[i - 1], next = chapters[i + 1];
  const toc = `<aside class="toc"><div class="toc-h">この章</div><ol>${c.secs
    .map((s, k) => `<li><a href="#${s.id}"><span class="toc-no">${c.numbered === 'false' ? '' : `${c.num}.${k + 1}`}</span>${inline(s.title)}</a></li>`)
    .join('')}</ol></aside>`;
  const pager = `<nav class="pager">${prev ? `<a class="pg prev" href="${prev.slug}.html"><span class="pg-k">${ICON.left}前へ</span><span class="pg-t">${chLabel(prev)}　${esc(prev.title)}</span></a>` : '<span></span>'}${
    next ? `<a class="pg next" href="${next.slug}.html"><span class="pg-k">次へ${ICON.right}</span><span class="pg-t">${chLabel(next)}　${esc(next.title)}</span></a>` : '<span></span>'
  }</nav>`;
  const body = `<article class="doc">
  <header class="ch-head">
    <div class="ch-eyebrow">${c.num === '0' ? 'はじめに' : c.num === '21' ? '付録' : `第 ${c.num} 章`}</div>
    <h1>${esc(c.title)}</h1>
    ${c.lead ? `<p class="lead">${inline(c.lead)}</p>` : ''}
    ${c.secs.length > 1 ? `<div class="ch-meta"><span>${c.secs.length} 節</span><span>図 ${c.figs} 点</span>${c.time ? `<span>目安 ${esc(c.time)}</span>` : ''}</div>` : ''}
  </header>
  ${c.body}
  ${pager}
</article>`;
  return shell({ title: `${c.title} — 図解 Rust`, body, active: c.slug, desc: c.lead, toc });
}

// ---------------------------------------------------------------- トップページ
function homePage() {
  const total = chapters.reduce((a, c) => a + c.secs.length, 0);
  const figs = chapters.reduce((a, c) => a + c.figs, 0);
  const roadmap = renderFig(
    'graph',
    {
      col: 150,
      row: 84,
      minW: 112,
      nodes: [
        { id: 'c1', label: '1 環境構築', x: 0, y: 0, kind: 'plain', mono: false },
        { id: 'c2', label: '2 数当てゲーム', x: 1, y: 0, kind: 'plain', mono: false },
        { id: 'c3', label: '3 基本の概念', x: 2, y: 0, kind: 'plain', mono: false },
        { id: 'c4', label: '4 所有権', x: 3, y: 0, kind: 'accent', mono: false },
        { id: 'c5', label: '5 構造体', x: 2, y: 1, kind: 'plain', mono: false },
        { id: 'c6', label: '6 enum と match', x: 3, y: 1, kind: 'plain', mono: false },
        { id: 'c7', label: '7 モジュール', x: 4, y: 1, kind: 'plain', mono: false },
        { id: 'c8', label: '8 コレクション', x: 4, y: 0, kind: 'plain', mono: false },
        { id: 'c9', label: '9 エラー処理', x: 5, y: 0, kind: 'plain', mono: false },
        { id: 'c10', label: '10 ジェネリクス\nトレイト・ライフタイム', x: 5, y: 1, kind: 'accent', mono: false },
        { id: 'c11', label: '11 テスト', x: 6, y: 1, kind: 'plain', mono: false },
        { id: 'c12', label: '12 CLI を作る', x: 6, y: 2, kind: 'crate', mono: false },
        { id: 'c13', label: '13 クロージャ\nイテレータ', x: 5, y: 2, kind: 'plain', mono: false },
        { id: 'c14', label: '14 Cargo', x: 4, y: 2, kind: 'plain', mono: false },
        { id: 'c15', label: '15 スマートポインタ', x: 3, y: 2, kind: 'accent', mono: false },
        { id: 'c16', label: '16 並行性', x: 2, y: 2, kind: 'plain', mono: false },
        { id: 'c17', label: '17 OOP', x: 1, y: 2, kind: 'plain', mono: false },
        { id: 'c18', label: '18 パターン', x: 1, y: 3, kind: 'plain', mono: false },
        { id: 'c19', label: '19 高度な機能', x: 2, y: 3, kind: 'plain', mono: false },
        { id: 'c20', label: '20 Web サーバ', x: 3, y: 3, kind: 'crate', mono: false },
      ],
      edges: [
        ['c1', 'c2'], ['c2', 'c3'], ['c3', 'c4'], ['c4', 'c5'], ['c5', 'c6'], ['c6', 'c7'], ['c4', 'c8'], ['c8', 'c9'],
        ['c9', 'c10'], ['c10', 'c11'], ['c11', 'c12'], ['c12', 'c13'], ['c13', 'c14'], ['c14', 'c15'], ['c15', 'c16'], ['c16', 'c17'],
        ['c17', 'c18'], ['c18', 'c19'], ['c19', 'c20'],
      ].map(([from, to]) => ({ from, to, style: 'muted' })),
      label: '章の学習ルート',
    },
    '章どうしのつながり。色の付いた 3 つの章（所有権・ライフタイム・スマートポインタ）が Rust 特有の山場で、図を最も多く入れています',
    '0'
  );
  const cards = chapters
    .map(
      (c) => `<a class="ch-card" href="${c.slug}.html"><span class="ch-card-no">${chLabel(c)}</span><span class="ch-card-t">${esc(c.title)}</span><span class="ch-card-d">${inline(c.lead || '')}</span><span class="ch-card-m"><span>${c.secs.length} 節</span><span>図 ${c.figs}</span><span class="nav-prog" data-ch="${c.slug}" data-total="${c.secs.length}"></span></span></a>`
    )
    .join('');
  const body = `<div class="home">
  <section class="hero">
    <div class="hero-text">
      <div class="ch-eyebrow">The Rust Programming Language を図で読む</div>
      <h1>Rust を、メモリの絵と一緒に覚える</h1>
      <p class="lead">公式ドキュメント「The Rust Programming Language」の全 20 章と付録を、日本語で一から書き直しました。所有権の移動、借用の範囲、モジュールの木、スレッド間のやりとりを、文章より先に図で示します。</p>
      <div class="hero-act"><a class="btn primary" href="${chapters[0].slug}.html">序章から読む</a><a class="btn" id="resume" href="${chapters[1].slug}.html" hidden>続きから</a></div>
      <dl class="hero-stats"><div><dt>章</dt><dd>${chapters.length}</dd></div><div><dt>節</dt><dd>${total}</dd></div><div><dt>図</dt><dd>${figs}</dd></div><div><dt>読了</dt><dd><span id="done-count">0</span><span class="of"> / ${total}</span></dd></div></dl>
    </div>
    <div class="hero-visual">${heroFig()}</div>
  </section>
  <section class="home-sec"><h2 class="home-h">学習ルート</h2>${roadmap}</section>
  <section class="home-sec"><h2 class="home-h">すべての章</h2><div class="ch-grid">${cards}</div></section>
</div>`;
  return shell({ title: '図解 Rust — The Rust Programming Language を図で読む', body, active: '' });
}

function heroFig() {
  return renderFig(
    'mem',
    {
      steps: [
        {
          title: 'let s1',
          stack: [{ name: 's1', fields: [['ptr', '→h'], ['len', '5'], ['cap', '5']] }],
          heap: [{ id: 'h', cells: ['h', 'e', 'l', 'l', 'o'], idx: true }],
          say: '<code>let s1 = String::from("hello");</code> — 文字列本体はヒープに、長さと容量とポインタはスタックに置かれる',
        },
        {
          title: 'let s2 = s1',
          stack: [
            { name: 's1', state: 'moved', fields: [['ptr', '→h'], ['len', '5'], ['cap', '5']] },
            { name: 's2', fields: [['ptr', '→h'], ['len', '5'], ['cap', '5']] },
          ],
          heap: [{ id: 'h', cells: ['h', 'e', 'l', 'l', 'o'], idx: true }],
          say: '<code>let s2 = s1;</code> — スタックの 3 つの値だけがコピーされ、所有権は s2 に移る。s1 はもう使えない',
        },
        {
          title: '}',
          stack: [
            { name: 's1', state: 'dead', fields: [['ptr', '→h'], ['len', '5'], ['cap', '5']] },
            { name: 's2', state: 'dead', fields: [['ptr', '→h'], ['len', '5'], ['cap', '5']] },
          ],
          heap: [{ id: 'h', cells: ['h', 'e', 'l', 'l', 'o'], idx: true, state: 'freed', freedLabel: 'drop で 1 回だけ解放' }],
          say: 'スコープの終わり — 所有者 s2 が drop され、ヒープは 1 度だけ解放される。二重解放は起こらない',
        },
      ],
    },
    '所有権の移動。ボタンで段階を切り替えられます（第 4 章）',
    '0-1'
  );
}

// ---------------------------------------------------------------- 出力
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'assets'))) fs.copyFileSync(path.join(ROOT, 'assets', f), path.join(OUT, 'assets', f));
chapters.forEach((c, i) => fs.writeFileSync(path.join(OUT, `${c.slug}.html`), chapterPage(c, i)));
fs.writeFileSync(path.join(OUT, 'index.html'), homePage());

const strip = (s) => s.replace(/`/g, '').replace(/\*\*/g, '');
const idx = [];
chapters.forEach((c) => {
  idx.push({ t: strip(c.title), u: `${c.slug}.html`, c: chLabel(c) });
  c.secs.forEach((s, k) => {
    idx.push({ t: strip(s.title), u: `${c.slug}.html#${s.id}`, c: c.numbered === 'false' ? chLabel(c) : `${c.num}.${k + 1}` });
    (s.subs || []).forEach((ss) => idx.push({ t: strip(ss.title), u: `${c.slug}.html#${ss.id}`, c: `${c.num}.${k + 1}` }));
  });
});
fs.writeFileSync(path.join(OUT, 'assets', 'search-index.js'), `window.ZR_INDEX=${JSON.stringify(idx)};window.ZR_TOTAL=${chapters.reduce((a, c) => a + c.secs.length, 0)};`);

console.log(`built ${chapters.length} chapters, ${chapters.reduce((a, c) => a + c.figs, 0)} figures → site/`);
