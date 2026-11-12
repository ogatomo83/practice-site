// 図解 PostgreSQL — 静的サイトビルド
// 原稿: src/chapters/*.md（軽量マークダウン + 図フェンス + 実行できる SQL） → site/*.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { highlight, dedent, esc, SQLHL } from './lib/highlight.mjs';
import { renderFig } from './lib/diagrams.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, '..', 'site');
const CH_DIR = path.join(ROOT, 'chapters');
const DATASETS = Object.fromEntries(
  fs.readdirSync(path.join(ROOT, 'datasets')).filter((f) => f.endsWith('.sql')).map((f) => [f.replace(/\.sql$/, ''), fs.readFileSync(path.join(ROOT, 'datasets', f), 'utf8')])
);
const BRAND = '図解 PostgreSQL';

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

const PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z"/></svg>';

function runBlock(body, attrs, flags, ctx) {
  ctx.runs++;
  const raw = dedent(body).join('\n');
  const hl = SQLHL.highlightLines(raw).join('\n');
  const title = attrs.title ? `<span class="code-file">${esc(attrs.title)}</span>` : '<span class="code-file is-lang">SQL</span>';
  const badge = flags.has('error') ? '<span class="code-badge is-fail">エラーになる</span>' : '';
  return `<div class="code sqlrun${flags.has('error') ? ' is-fail' : ''}"><div class="code-h">${title}${badge}<span class="run-key" title="Ctrl または ⌘ + Enter でも実行できます">⌘↵</span><button type="button" class="undo" hidden>元に戻す</button><button type="button" class="copy" aria-label="SQL をコピー">コピー</button><button type="button" class="run-btn">${PLAY}<span>実行</span></button></div><div class="ed"><pre class="ed-hl" aria-hidden="true"><code>${hl}\n</code></pre><textarea class="ed-ta" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" aria-label="SQL を編集して実行できます" rows="${raw.split('\n').length}">${esc(raw)}</textarea></div><div class="out" hidden aria-live="polite"></div></div>`;
}

function codeBlock(lang, info, body, ctx) {
  const { flags, attrs } = parseInfo(info);
  if (lang === 'sql' && flags.has('run')) return runBlock(body, attrs, flags, ctx);
  if (lang === 'sql' && flags.has('setup')) {
    ctx.setup.push(dedent(body).join('\n'));
    const hl = highlight(body, 'sql');
    return `<details class="deep setup"><summary><span class="deep-k">準備</span>${inline(attrs.title || 'この節で使うテーブルを作る SQL（実行ボタンを押すと自動で流れます）')}</summary><div class="deep-b"><div class="code"><pre><code>${hl}</code></pre></div></div></details>`;
  }
  const label = { sql: 'SQL', console: 'ターミナル', psql: 'psql', text: '', json: 'JSON', conf: '設定ファイル' }[lang] ?? lang;
  let badge = '';
  if (flags.has('error')) badge = '<span class="code-badge is-fail">エラーになる</span>';
  else if (flags.has('norun')) badge = '<span class="code-badge">ここでは実行できない例</span>';
  else if (flags.has('ok')) badge = '<span class="code-badge is-ok">成功する</span>';
  const file = attrs.title ? `<span class="code-file">${esc(attrs.title)}</span>` : `<span class="code-file is-lang">${label}</span>`;
  const hl = highlight(body, lang);
  const cls = `code ${lang === 'console' || lang === 'psql' ? 'is-console' : ''} ${flags.has('error') ? 'is-fail' : ''}`;
  return `<div class="${cls}"><div class="code-h">${file}${badge}<button type="button" class="copy" aria-label="コードをコピー">コピー</button></div><pre><code>${hl}</code></pre></div>`;
}

// 確認問題（:::quiz）。本文・ヒント・模範解答などを取り分けて、答え合わせのできる枠にする
//   ```sql answer [ordered]  模範解答（必須）。ordered を付けると行の並び順も比べる
//   ```sql check             変更系の問題で、実行後の状態を確かめる SELECT（両方の実行後に流して比べる）
//   ```sql prep              その問題だけで使う準備 SQL（毎回の答え合わせの最初に流れる）
//   ```sql starter           入力欄に最初から入れておく SQL
//   :::hint ... :::          ヒント（折りたたみ）
function quizBlock(title, body, ctx) {
  const parts = { answer: '', check: '', prep: '', starter: '', ordered: false };
  const rest = [], hints = [];
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    const fm = l.match(/^```sql\s+(answer|check|prep|starter)\b(.*)$/);
    if (fm) {
      const b = [];
      i++;
      while (i < body.length && !body[i].startsWith('```')) b.push(body[i++]);
      parts[fm[1]] = dedent(b.join('\n')).join('\n').trim();
      if (fm[1] === 'answer' && /\bordered\b/.test(fm[2])) parts.ordered = true;
      continue;
    }
    if (/^:::hint\b/.test(l)) {
      const b = [];
      let depth = 1;
      i++;
      while (i < body.length) {
        if (/^:::\w/.test(body[i])) depth++;
        else if (/^:::\s*$/.test(body[i])) { depth--; if (!depth) break; }
        b.push(body[i++]);
      }
      hints.push(b);
      continue;
    }
    rest.push(l);
  }
  if (!parts.answer) throw new Error(`${ctx.file}: 確認問題「${title}」に sql answer がない`);
  const n = ++ctx.quiz;
  const starter = parts.starter || '-- ここに SQL を書いて「答え合わせ」（Ctrl / ⌘ + Enter）\n';
  const hl = SQLHL.highlightLines(starter).join('\n');
  const data = JSON.stringify({ a: parts.answer, c: parts.check, p: parts.prep, o: parts.ordered }).replace(/</g, '\\u003c');
  const hintHTML = hints
    .map((h, k) => `<details class="qz-fold"><summary>ヒント${hints.length > 1 ? ` ${k + 1}` : ''}</summary><div class="qz-fold-b">${parseBlocks(h, ctx)}</div></details>`)
    .join('');
  const ansHTML = `<details class="qz-fold qz-ans"><summary>模範解答</summary><div class="qz-fold-b"><div class="code"><pre><code>${highlight(parts.answer, 'sql')}</code></pre></div>${
    parts.check ? `<p class="qz-note">答え合わせでは、実行したあとに次の SQL で中身を調べて比べています。</p><div class="code"><pre><code>${highlight(parts.check, 'sql')}</code></pre></div>` : ''
  }</div></details>`;
  return `<section class="qz" data-qid="${ctx.slug}-${n}"><div class="qz-h"><span class="qz-no">問 ${n}</span><h3 class="qz-t">${inline(title)}</h3><span class="qz-mark" hidden>正解済み</span></div><div class="qz-q">${parseBlocks(rest, ctx)}</div><div class="code qz-box"><div class="ed"><pre class="ed-hl" aria-hidden="true"><code>${hl}\n</code></pre><textarea class="ed-ta" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" aria-label="問 ${n} の答えの SQL" rows="${Math.max(3, starter.split('\n').length)}">${esc(starter)}</textarea></div><div class="qz-bar"><button type="button" class="run-btn qz-check">${PLAY}<span>答え合わせ</span></button><span class="run-key" title="Ctrl または ⌘ + Enter でも答え合わせできます">⌘↵</span><span class="qz-rule">${parts.check ? '実行後のテーブルの中身で判定' : parts.ordered ? '出力の値と並び順で判定' : '出力の値で判定（行の順番と列名は問わない）'}</span></div><div class="qz-res" hidden aria-live="polite"></div></div><div class="qz-more">${hintHTML}${ansHTML}</div><script type="application/json" class="qz-data">${data}</script></section>`;
}

const CALLOUT_LABEL ={ note: 'メモ', tip: 'コツ', warn: '注意', deep: '深掘り', key: '要点', hist: '歴史' };

function parseBlocks(lines, ctx) {
  let html = '';
  let i = 0;
  const isBlockStart = (l) => /^(```|:::|#{2,4} |\||- |\d+\. |<|> )/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

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
        html += codeBlock(lang || 'text', rest.join(' '), body.join('\n'), ctx);
      }
      continue;
    }

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
      if (type === 'quiz') { html += quizBlock(title, body, ctx); continue; }
      const inner = parseBlocks(body, ctx);
      if (type === 'pgerr') {
        const [code, ...msg] = title.split(' ');
        html += `<aside class="pgerr"><div class="pgerr-h"><span class="pgerr-sev">ERROR</span><span class="pgerr-msg">${inline(msg.join(' '))}</span><span class="pgerr-code" title="SQLSTATE">${esc(code)}</span></div><div class="pgerr-b">${inner}</div></aside>`;
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

    if (line.startsWith('<')) {
      const body = [];
      while (i < lines.length && lines[i].trim()) body.push(lines[i++]);
      html += body.join('\n');
      continue;
    }

    if (line.startsWith('> ')) {
      const body = [];
      while (i < lines.length && lines[i].startsWith('> ')) body.push(lines[i++].slice(2));
      html += `<blockquote>${inline(body.join(' '))}</blockquote>`;
      continue;
    }

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
  if (!fm) throw new Error(`${file}: front matter がない`);
  const meta = {};
  fm[1].split('\n').forEach((l) => {
    const m = l.match(/^(\w+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2];
  });
  const slug = file.replace(/\.md$/, '');
  const ctx = { file, num: meta.num, numLabel: meta.numbered !== 'false', slug, secs: [], subs: 0, fig: 0, runs: 0, quiz: 0, setup: [] };
  const body = parseBlocks(raw.slice(fm[0].length).split('\n'), ctx);
  const db = meta.db === undefined ? 'shop' : meta.db;
  if (db && db !== 'none' && !DATASETS[db]) throw new Error(`${file}: データセット ${db} がない`);
  const setup = [db && db !== 'none' ? DATASETS[db] : '', ...ctx.setup].filter(Boolean).join('\n;\n');
  return { ...meta, slug, body, secs: ctx.secs, figs: ctx.fig, runs: ctx.runs, quiz: ctx.quiz, setup, db };
}

const files = fs.readdirSync(CH_DIR).filter((f) => f.endsWith('.md')).sort();
const chapters = files.map(loadChapter);
const LAST = chapters[chapters.length - 1];

// ---------------------------------------------------------------- テンプレート
const ICON = {
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.1A8.5 8.5 0 0 1 9.9 3.5a8.5 8.5 0 1 0 10.6 10.6z"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  term: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M12 15h5"/></svg>',
};

// 署名：台帳の 1 ページ（8 KB ページ）を思わせるマーク
const MARK = `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6"/><path d="M6.5 7h11M6.5 10.5h11M6.5 14h6" class="mark-l"/><circle cx="16.5" cy="16.5" r="2" class="mark-d"/></svg>`;

const chLabel = (c) => (c.num === '0' ? '序' : c === LAST && c.appendix === 'true' ? '付録' : `${c.num}章`);
const navNo = (c) => (c.num === '0' ? '序' : c.appendix === 'true' ? 'A' : c.num);

function sidebar(active) {
  return `<nav class="side-nav" aria-label="目次">${chapters
    .map((c) => {
      const on = c.slug === active;
      return `<div class="nav-ch${on ? ' is-open' : ''}"><a class="nav-c${on ? ' is-active' : ''}" href="${c.slug}.html"><span class="nav-no">${navNo(c)}</span><span class="nav-t">${esc(c.short || c.title)}</span><span class="nav-prog" data-ch="${c.slug}" data-total="${c.secs.length}"></span></a>${
        on
          ? `<ul class="nav-secs">${c.secs
              .map((s, i) => `<li><a href="#${s.id}" data-key="${c.slug}#${s.id}"><span class="nav-sno">${c.numbered === 'false' ? '' : `${c.num}.${i + 1}`}</span><span>${inline(s.title)}</span></a></li>`)
              .join('')}</ul>`
          : ''
      }</div>`;
    })
    .join('')}<a class="nav-c nav-play${active === 'playground' ? ' is-active' : ''}" href="playground.html"><span class="nav-no">${ICON.term}</span><span class="nav-t">SQL を自由に試す</span></a></nav>`;
}

function shell({ title, body, active, desc, toc = '', setup = null, runner = false, quiz = false }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc || 'PostgreSQL と SQL を、ブラウザの中で動くデータベースで試しながら学ぶ日本語の学習書')}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+JP:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/style.css">
<script>try{var t=localStorage.getItem('zp-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body>
<header class="top">
  <button type="button" class="icon-btn menu-btn" aria-label="目次を開く">${ICON.menu}</button>
  <a class="brand" href="index.html">${MARK}<span>${BRAND}</span></a>
  <div class="search">
    ${ICON.search}
    <input type="search" id="q" placeholder="検索" autocomplete="off" aria-label="章と節を検索">
    <kbd class="kc">/</kbd>
    <div class="search-res" hidden></div>
  </div>
  <div class="db-state" hidden><span class="db-dot"></span><span class="db-text">DB 停止中</span><button type="button" class="db-view" aria-pressed="false" aria-controls="dbv" title="いまのデータベースの中身（テーブル、行、インデックス）を横に表示します">DB を見る</button><button type="button" class="db-reset" title="この章のデータベースを最初の状態に戻します">リセット</button></div>
  <button type="button" class="icon-btn theme-btn" aria-label="テーマを切り替え"><span class="i-sun">${ICON.sun}</span><span class="i-moon">${ICON.moon}</span></button>
</header>
<div class="layout">
  <aside class="side">${sidebar(active)}<div class="side-foot">SQL は <a href="https://pglite.dev/" target="_blank" rel="noopener">PGlite</a>（WebAssembly 版の PostgreSQL 18）でブラウザの中で実行します。初回の実行時に約 7 MB を読み込みます。</div></aside>
  <main class="main">${body}</main>
  ${toc}
</div>
${setup !== null ? `<script type="application/json" id="pg-setup">${JSON.stringify({ sql: setup }).replace(/</g, '\\u003c')}</script>` : ''}
<script src="assets/search-index.js"></script>
<script src="assets/sqlhl.js"></script>
<script src="assets/app.js"></script>
${runner ? `<aside class="dbv" id="dbv" hidden aria-label="データベースの中身">
  <div class="dbv-grip" role="separator" aria-orientation="horizontal" aria-label="パネルの高さを変える（上下の矢印キーでも変えられます）" tabindex="0"></div>
  <div class="dbv-h">
    <div class="dbv-tabs" role="tablist" aria-label="テーブル"></div>
    <div class="dbv-ctl">
      <div class="dbv-seg" role="group" aria-label="表示"><button type="button" data-v="data" aria-pressed="true">データ</button><button type="button" data-v="struct" aria-pressed="false">構造</button></div>
      <label class="dbv-opt" title="ctid（行の物理的な位置）と xmin・xmax（行を作った／消したトランザクション）を列に加えます"><input type="checkbox" class="dbv-sys"> ctid・xmin・xmax</label>
      <button type="button" class="dbv-btn dbv-refresh" title="読み直す">更新</button>
      <button type="button" class="icon-btn dbv-close" aria-label="閉じる">${ICON.close}</button>
    </div>
  </div>
  <div class="dbv-sum"></div>
  <div class="dbv-b"></div>
</aside>
<script src="assets/sql.js"></script>
<script src="assets/dbview.js"></script>` : ''}
${quiz ? '<script src="assets/quiz.js"></script>' : ''}
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
    <div class="ch-eyebrow">${c.num === '0' ? 'はじめに' : c.appendix === 'true' ? '付録' : `第 ${c.num} 章`}</div>
    <h1>${esc(c.title)}</h1>
    ${c.lead ? `<p class="lead">${inline(c.lead)}</p>` : ''}
    ${c.secs.length > 1 ? `<div class="ch-meta"><span>${c.secs.length} 節</span><span>図 ${c.figs} 点</span>${c.runs ? `<span>実行できる SQL ${c.runs} 個</span>` : ''}${c.quiz ? `<a href="#quiz">確認問題 ${c.quiz} 問</a>` : ''}${c.time ? `<span>目安 ${esc(c.time)}</span>` : ''}</div>` : ''}
  </header>
  ${c.body}
  ${pager}
</article>`;
  return shell({ title: `${c.title} — ${BRAND}`, body, active: c.slug, desc: c.lead, toc, setup: c.runs || c.quiz ? c.setup : null, runner: c.runs > 0 || c.quiz > 0, quiz: c.quiz > 0 });
}

// ---------------------------------------------------------------- トップページ
function homePage() {
  const total = chapters.reduce((a, c) => a + c.secs.length, 0);
  const figs = chapters.reduce((a, c) => a + c.figs, 0);
  const runs = chapters.reduce((a, c) => a + c.runs, 0);
  const byNum = Object.fromEntries(chapters.map((c) => [c.num, c]));
  const nm = (n, fallback) => (byNum[n] ? `${n} ${byNum[n].short || byNum[n].title}` : fallback);
  const roadmap = renderFig(
    'graph',
    {
      col: 150,
      row: 84,
      minW: 112,
      nodes: [
        { id: 'p1', label: nm('1', '1'), x: 0, y: 0, kind: 'plain', mono: false },
        { id: 'p2', label: nm('2', '2'), x: 1, y: 0, kind: 'plain', mono: false },
        { id: 'p3', label: nm('3', '3'), x: 2, y: 0, kind: 'accent', mono: false },
        { id: 'p4', label: nm('4', '4'), x: 3, y: 0, kind: 'plain', mono: false },
        { id: 'p5', label: nm('5', '5'), x: 4, y: 0, kind: 'plain', mono: false },
        { id: 'p6', label: nm('6', '6'), x: 5, y: 0, kind: 'plain', mono: false },
        { id: 'p7', label: nm('7', '7'), x: 5, y: 1, kind: 'accent', mono: false },
        { id: 'p8', label: nm('8', '8'), x: 4, y: 1, kind: 'plain', mono: false },
        { id: 'p9', label: nm('9', '9'), x: 3, y: 1, kind: 'plain', mono: false },
        { id: 'p10', label: nm('10', '10'), x: 2, y: 1, kind: 'plain', mono: false },
        { id: 'p11', label: nm('11', '11'), x: 1, y: 1, kind: 'plain', mono: false },
        { id: 'p12', label: nm('12', '12'), x: 0, y: 2, kind: 'stack', mono: false },
        { id: 'p13', label: nm('13', '13'), x: 1, y: 2, kind: 'stack', mono: false },
        { id: 'p14', label: nm('14', '14'), x: 2, y: 2, kind: 'stack', mono: false },
        { id: 'p15', label: nm('15', '15'), x: 3, y: 2, kind: 'stack', mono: false },
        { id: 'p16', label: nm('16', '16'), x: 4, y: 2, kind: 'stack', mono: false },
        { id: 'p17', label: nm('17', '17'), x: 5, y: 2, kind: 'stack', mono: false },
        { id: 'p18', label: nm('18', '18'), x: 5, y: 3, kind: 'ext', mono: false },
        { id: 'p19', label: nm('19', '19'), x: 4, y: 3, kind: 'ext', mono: false },
        { id: 'p20', label: nm('20', '20'), x: 3, y: 3, kind: 'ext', mono: false },
      ],
      edges: [
        ['p1', 'p2'], ['p2', 'p3'], ['p3', 'p4'], ['p4', 'p5'], ['p5', 'p6'], ['p6', 'p7'], ['p7', 'p8'], ['p8', 'p9'], ['p9', 'p10'], ['p10', 'p11'],
        ['p11', 'p12'], ['p12', 'p13'], ['p13', 'p14'], ['p14', 'p15'], ['p15', 'p16'], ['p16', 'p17'], ['p17', 'p18'], ['p18', 'p19'], ['p19', 'p20'],
      ].map(([from, to]) => ({ from, to, style: 'muted' })),
      groups: [],
      label: '章の学習ルート',
    },
    '章どうしのつながり。1〜11 章が歴史・SQL・設計、青い 12〜17 章がデータベースの内部、緑の 18〜20 章が応用と運用です。枠の濃い 2 つの章（SELECT と JOIN）が SQL の山場です',
    '0'
  );
  const cards = chapters
    .map(
      (c) => `<a class="ch-card" href="${c.slug}.html"><span class="ch-card-no">${chLabel(c)}</span><span class="ch-card-t">${esc(c.title)}</span><span class="ch-card-d">${inline(c.lead || '')}</span><span class="ch-card-m"><span>${c.secs.length} 節</span><span>図 ${c.figs}</span>${c.runs ? `<span>SQL ${c.runs}</span>` : ''}<span class="nav-prog" data-ch="${c.slug}" data-total="${c.secs.length}"></span></span></a>`
    )
    .join('');
  const tryIt = runBlock(
    `-- このボタンで、ブラウザの中の PostgreSQL がこの SQL を実行します
select name, price
from products
where price >= 2000
order by price desc;`,
    { title: 'まず 1 回、実行してみる' },
    new Set(),
    { runs: 0 }
  );
  const body = `<div class="home">
  <section class="hero">
    <div class="hero-text">
      <div class="ch-eyebrow">PostgreSQL 18 をブラウザで動かしながら読む</div>
      <h1>SQL を書いて、ページとタプルの中まで覗く</h1>
      <p class="lead">リレーショナルモデルの誕生から SQL の書き方、8 KB のページに行が詰まる仕組み、MVCC、インデックス、WAL までを日本語で一から説明します。本文の SQL はすべて、その場で書き換えて実行できます。</p>
      <div class="hero-act"><a class="btn primary" href="${chapters[0].slug}.html">序章から読む</a><a class="btn" href="playground.html">SQL を自由に試す</a><a class="btn" id="resume" href="${(chapters[1] || chapters[0]).slug}.html" hidden>続きから</a></div>
      <dl class="hero-stats"><div><dt>章</dt><dd>${chapters.length}</dd></div><div><dt>節</dt><dd>${total}</dd></div><div><dt>図</dt><dd>${figs}</dd></div><div><dt>実行できる SQL</dt><dd>${runs}</dd></div><div><dt>読了</dt><dd><span id="done-count">0</span><span class="of"> / ${total}</span></dd></div></dl>
    </div>
    <div class="hero-visual">${heroFig()}${tryIt}</div>
  </section>
  <section class="home-sec"><h2 class="home-h">学習ルート</h2>${roadmap}</section>
  <section class="home-sec"><h2 class="home-h">すべての章</h2><div class="ch-grid">${cards}<a class="ch-card is-play" href="playground.html"><span class="ch-card-no">実験場</span><span class="ch-card-t">SQL を自由に試す</span><span class="ch-card-d">サンプルの文具店データベースが入った PostgreSQL を、好きなだけ触れるページです。テーブルの一覧と実行履歴つき。</span><span class="ch-card-m"><span>PGlite</span></span></a></div></section>
</div>`;
  return shell({ title: `${BRAND} — SQL とデータベースの中身をブラウザで学ぶ`, body, active: '', setup: DATASETS.shop, runner: true });
}

function heroFig() {
  const cell = (t, w, kind) => ({ t, w, kind });
  return renderFig(
    'layout',
    {
      unit: 30,
      steps: [
        {
          title: 'INSERT',
          rows: [
            { label: 'ページ 0', cells: [cell('ヘッダ', 3, 'stack'), cell('1', 1, 'accent'), cell('', 9, 'empty'), cell('行 1', 4, 'heap')], scale: ['0', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '8 KB'], note: '' },
          ],
          say: '<code>INSERT</code> — 行（タプル）はページの末尾から詰められ、先頭側には行の位置を指す番号（行ポインタ）が並ぶ',
        },
        {
          title: 'INSERT ×3',
          rows: [
            { label: 'ページ 0', cells: [cell('ヘッダ', 3, 'stack'), cell('1', 1, 'accent'), cell('2', 1, 'accent'), cell('3', 1, 'accent'), cell('', 3, 'empty'), cell('行 3', 3, 'heap'), cell('行 2', 3, 'heap'), cell('行 1', 3, 'heap')], scale: ['0', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '8 KB'] },
          ],
          say: '行ポインタは前から、行は後ろから。真ん中の空きが無くなるとページは満杯になる',
        },
        {
          title: 'UPDATE 行 1',
          rows: [
            { label: 'ページ 0', cells: [cell('ヘッダ', 3, 'stack'), cell('1', 1, 'pad'), cell('2', 1, 'accent'), cell('3', 1, 'accent'), cell('4', 1, 'accent'), cell('', 1, 'empty'), cell("行 1'", 3, 'heap'), cell('行 3', 3, 'heap'), cell('行 2', 3, 'heap'), cell('行 1', 3, 'pad')], scale: ['0', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '8 KB'] },
          ],
          say: '<code>UPDATE</code> は上書きしない。新しい版の行を足し、古い版は「もう見えない」印を付けて残す（第 13 章の MVCC）',
        },
      ],
    },
    '8 KB のページに行が入っていく様子。ボタンで段階を切り替えられます（第 12 章）',
    '0-1'
  );
}

// ---------------------------------------------------------------- 実験場
function playgroundPage() {
  const start = `-- 好きな SQL を書いて「実行」（Ctrl / ⌘ + Enter）
-- 複数の文はセミコロンで区切ると順に実行されます
select c.name as 顧客, count(distinct o.id) as 注文数, sum(oi.quantity * oi.unit_price) as 購入額
from customers c
left join orders o on o.customer_id = c.id and o.status <> 'cancelled'
left join order_items oi on oi.order_id = o.id
group by c.id, c.name
order by 購入額 desc nulls last;`;
  const body = `<article class="doc play">
  <header class="ch-head">
    <div class="ch-eyebrow">実験場</div>
    <h1>SQL を自由に試す</h1>
    <p class="lead">ブラウザの中で PostgreSQL 18 が動いています。テーブルを作っても壊しても、上の「リセット」で最初の状態に戻せます。内容はページを閉じると消えます。</p>
  </header>
  <div class="play-grid">
    <div class="play-main">
      <div class="play-bar">
        <label>初期データ <select id="play-db"><option value="shop">文具店（6 テーブル）</option><option value="none">空のデータベース</option></select></label>
      </div>
      ${runBlock(start, { title: 'playground.sql' }, new Set(), { runs: 0 }).replace('class="code sqlrun"', 'class="code sqlrun is-big"')}
    </div>
    <aside class="play-side">
      <div class="play-h">テーブル</div>
      <div id="play-schema" class="play-schema"><p class="muted">最初の実行のあとに表示されます</p></div>
      <div class="play-h">履歴</div>
      <ol id="play-hist" class="play-hist"></ol>
    </aside>
  </div>
</article>`;
  const ds = JSON.stringify(Object.fromEntries(Object.entries(DATASETS))).replace(/</g, '\\u003c');
  return shell({ title: `SQL を自由に試す — ${BRAND}`, body: body + `<script type="application/json" id="pg-datasets">${ds}</script>`, active: 'playground', setup: DATASETS.shop, runner: true });
}

// ---------------------------------------------------------------- 出力
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'assets'))) fs.copyFileSync(path.join(ROOT, 'assets', f), path.join(OUT, 'assets', f));
chapters.forEach((c, i) => fs.writeFileSync(path.join(OUT, `${c.slug}.html`), chapterPage(c, i)));
fs.writeFileSync(path.join(OUT, 'index.html'), homePage());
fs.writeFileSync(path.join(OUT, 'playground.html'), playgroundPage());

const strip = (s) => s.replace(/`/g, '').replace(/\*\*/g, '');
const idx = [];
chapters.forEach((c) => {
  idx.push({ t: strip(c.title), u: `${c.slug}.html`, c: chLabel(c) });
  c.secs.forEach((s, k) => {
    idx.push({ t: strip(s.title), u: `${c.slug}.html#${s.id}`, c: c.numbered === 'false' ? chLabel(c) : `${c.num}.${k + 1}` });
    (s.subs || []).forEach((ss) => idx.push({ t: strip(ss.title), u: `${c.slug}.html#${ss.id}`, c: `${c.num}.${k + 1}` }));
  });
});
idx.push({ t: 'SQL を自由に試す（実験場）', u: 'playground.html', c: '実験場' });
fs.writeFileSync(path.join(OUT, 'assets', 'search-index.js'), `window.ZR_INDEX=${JSON.stringify(idx)};window.ZR_TOTAL=${chapters.reduce((a, c) => a + c.secs.length, 0)};`);

console.log(`built ${chapters.length} chapters, ${chapters.reduce((a, c) => a + c.figs, 0)} figures, ${chapters.reduce((a, c) => a + c.runs, 0)} runnable SQL, ${chapters.reduce((a, c) => a + c.quiz, 0)} quizzes → site/`);
