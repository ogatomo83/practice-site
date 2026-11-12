// 図解 CPU — 静的サイトビルド
// 原稿: src/chapters/*.md（軽量マークダウン + 図フェンス + 実行できるアセンブリ・回路） → site/*.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { highlight, dedent, esc, HL } from './lib/highlight.mjs';
import { renderFig } from './lib/diagrams.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, '..', 'site');
const CH_DIR = path.join(ROOT, 'chapters');
const BRAND = '図解 CPU';
const attr = (s) => esc(s).replace(/"/g, '&quot;');

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
const LANG_LABEL = { asm: 'アセンブリ', logic: '回路', c: 'C', console: 'ターミナル', text: '' };
// 実行ブロックに書ける属性（意味は src/assets/grade.js）。知らないものはビルド時に知らせる
const RUN_FLAGS = new Set(['run', 'error', 'anim', 'step', 'pipeline', 'limit', 'break']);
const RUN_ATTRS = new Set(['title', 'regs', 'mem', 'maxsteps', 'seed', 'pipeline', 'predict', 'cache']);
const QUIZ_FLAGS = new Set(['answer', 'screen', 'console', 'exit']);
const QUIZ_ATTRS = new Set(['regs', 'mem', 'maxsteps', 'seed', 'only', 'maxgates']);
function checkInfo(what, { flags, attrs }, okFlags, okAttrs, ctx) {
  const bad = [...flags].filter((f) => !okFlags.has(f)).concat(Object.keys(attrs).filter((a) => !okAttrs.has(a)));
  if (bad.length) console.warn(`  注意 ${ctx.file}: ${what} に知らない属性 ${bad.join(', ')}`);
}

const editor = (raw, lang, label, minRows = 1) =>
  `<div class="ed"><pre class="ed-hl" aria-hidden="true"><code>${HL.editorHTML(raw, lang)}</code></pre><textarea class="ed-ta" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" aria-label="${attr(label)}" rows="${Math.max(minRows, raw.split('\n').length)}">${esc(raw)}</textarea></div>`;

// ```asm run / ```logic run：その場で書き換えて実行できるブロック。info はフェンスの info 文字列（lang から）
function runBlock(lang, body, info, ctx) {
  const { flags, attrs } = parseInfo(info.replace(/^\S+\s*/, ''));
  checkInfo(`${lang} run`, { flags, attrs }, RUN_FLAGS, RUN_ATTRS, ctx);
  ctx.runs++;
  ctx.runsBy[lang] = (ctx.runsBy[lang] || 0) + 1;
  const raw = dedent(body).join('\n');
  const title = attrs.title ? `<span class="code-file">${esc(attrs.title)}</span>` : `<span class="code-file is-lang">${LANG_LABEL[lang]}</span>`;
  const badges = [
    flags.has('error') ? '<span class="code-badge is-fail">エラーになる</span>' : '',
    flags.has('anim') ? '<span class="code-badge">動き続ける</span>' : '',
    flags.has('limit') ? '<span class="code-badge">上限で打ち切られる</span>' : '',
    flags.has('break') ? '<span class="code-badge">ebreak で止まる</span>' : '',
    flags.has('step') ? '<span class="code-badge">ステップ実行</span>' : '',
    flags.has('pipeline') || attrs.pipeline || attrs.predict ? '<span class="code-badge">パイプライン計測</span>' : '',
    attrs.cache ? '<span class="code-badge">キャッシュ計測</span>' : '',
  ].join('');
  const what = lang === 'logic' ? '回路' : 'プログラム';
  return `<div class="code cpurun is-${lang}${flags.has('error') ? ' is-fail' : ''}" data-lang="${lang}" data-info="${attr(info)}"><div class="code-h">${title}${badges}<span class="run-key" title="Ctrl または ⌘ + Enter でも実行できます">⌘↵</span><button type="button" class="undo" hidden>元に戻す</button><button type="button" class="copy" aria-label="${what}をコピー">コピー</button><button type="button" class="run-btn">${PLAY}<span>実行</span></button></div>${editor(raw, lang, `${what}を編集して実行できます`)}<div class="out" hidden aria-live="polite"></div></div>`;
}

function codeBlock(lang, info, body, ctx) {
  const { flags, attrs } = parseInfo(info);
  if ((lang === 'asm' || lang === 'logic') && flags.has('run')) return runBlock(lang, body, `${lang} ${info}`, ctx);
  const label = LANG_LABEL[lang] ?? lang;
  let badge = '';
  if (flags.has('error')) badge = '<span class="code-badge is-fail">エラーになる</span>';
  else if (flags.has('norun')) badge = '<span class="code-badge">ここでは実行しない例</span>';
  const file = attrs.title ? `<span class="code-file">${esc(attrs.title)}</span>` : `<span class="code-file is-lang">${label}</span>`;
  const hl = highlight(body, lang);
  const cls = `code ${lang === 'console' ? 'is-console' : ''} ${flags.has('error') ? 'is-fail' : ''}`;
  return `<div class="${cls}"><div class="code-h">${file}${badge}<button type="button" class="copy" aria-label="コードをコピー">コピー</button></div><pre><code>${hl}</code></pre></div>`;
}

// 確認問題（:::quiz）。本文・ヒント・模範解答などを取り分けて、答え合わせのできる枠にする。判定は src/assets/grade.js の GRADE.quiz
//   ```asm answer [regs="a0"] [mem="0x8000,16"] [screen] [console] [exit]   模範解答（必須）。属性で「何を比べるか」を決める
//   ```logic answer [only="nand"] [maxgates="5"]                             回路の問題
//   ```asm given      読者のコードの後ろに連結されるコード（関数だけ書かせる問題の main、テスト用の .data）
//   ```asm starter    入力欄に最初から入れておくコード
//   :::hint ... :::   ヒント（折りたたみ）
function quizRule(lang, p) {
  if (lang === 'logic') {
    const lim = [p.attrs.only ? `使えるゲートは ${p.attrs.only.split(',').map((s) => s.trim().toUpperCase()).join('・')} だけ` : '', p.attrs.maxgates ? `ゲートは ${p.attrs.maxgates} 個まで` : ''].filter(Boolean);
    return `出力の表で判定${lim.length ? `（${lim.join('、')}）` : ''}`;
  }
  const what = [];
  const useConsole = p.flags.has('console') || !(p.attrs.regs || p.attrs.mem || p.flags.has('screen'));
  if (useConsole) what.push('コンソールの出力');
  if (p.attrs.regs) what.push(`レジスタ ${p.attrs.regs.split(',').map((s) => s.trim()).join('・')} の値`);
  if (p.attrs.mem) { const [a, n] = p.attrs.mem.split(',').map((s) => s.trim()); what.push(`メモリ ${a} 番地から ${n} バイト`); }
  if (p.flags.has('screen')) what.push('画面');
  if (p.flags.has('exit')) what.push('終了コード');
  return `${what.join('と')}で判定`;
}

function quizBlock(title, body, ctx) {
  const parts = { answer: '', given: '', starter: '' };
  let lang = '', info = '';
  const rest = [], hints = [];
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    const fm = l.match(/^```(asm|logic)\s+(.*)$/);
    const kind = fm && ['answer', 'given', 'starter'].find((k) => new RegExp(`(^|\\s)${k}(\\s|$)`).test(fm[2]));
    if (kind) {
      const b = [];
      i++;
      while (i < body.length && !body[i].startsWith('```')) b.push(body[i++]);
      parts[kind] = dedent(b.join('\n')).join('\n').replace(/\s+$/, '');
      if (kind === 'answer') { lang = fm[1]; info = `${fm[1]} ${fm[2].trim()}`; }
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
  if (!parts.answer) throw new Error(`${ctx.file}: 確認問題「${title}」に asm answer / logic answer がない`);
  const p = parseInfo(info.replace(/^\S+\s*/, ''));
  checkInfo(`確認問題「${title}」の answer`, p, QUIZ_FLAGS, QUIZ_ATTRS, ctx);
  const n = ++ctx.quiz;
  const what = lang === 'logic' ? '回路' : 'プログラム';
  const starter = parts.starter ? parts.starter + '\n' : `# ここに${what}を書いて「答え合わせ」（Ctrl / ⌘ + Enter）\n`;
  const data = JSON.stringify({ lang, answer: parts.answer, given: parts.given, info }).replace(/</g, '\\u003c');
  const hintHTML = hints
    .map((h, k) => `<details class="qz-fold"><summary>ヒント${hints.length > 1 ? ` ${k + 1}` : ''}</summary><div class="qz-fold-b">${parseBlocks(h, ctx)}</div></details>`)
    .join('');
  const givenHTML = parts.given
    ? `<div class="code qz-given"><div class="code-h"><span class="code-file is-lang">あなたのコードの後ろに、このコードがつながります</span></div><pre><code>${highlight(parts.given, lang)}</code></pre></div>`
    : '';
  const ansHTML = `<details class="qz-fold qz-ans"><summary>模範解答</summary><div class="qz-fold-b"><div class="code"><pre><code>${highlight(parts.answer, lang)}</code></pre></div></div></details>`;
  return `<section class="qz" data-qid="${ctx.slug}-${n}" data-lang="${lang}"><div class="qz-h"><span class="qz-no">問 ${n}</span><h3 class="qz-t">${inline(title)}</h3><span class="qz-mark" hidden>正解済み</span></div><div class="qz-q">${parseBlocks(rest, ctx)}${givenHTML}</div><div class="code qz-box">${editor(starter, lang, `問 ${n} の答えの${what}`, 3)}<div class="qz-bar"><button type="button" class="run-btn qz-check">${PLAY}<span>答え合わせ</span></button><span class="run-key" title="Ctrl または ⌘ + Enter でも答え合わせできます">⌘↵</span><span class="qz-rule">${esc(quizRule(lang, p))}</span></div><div class="qz-res" hidden aria-live="polite"></div></div><div class="qz-more">${hintHTML}${ansHTML}</div><script type="application/json" class="qz-data">${data}</script></section>`;
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
      if (type === 'err') {
        html += `<aside class="pgerr"><div class="pgerr-h"><span class="pgerr-sev">エラー</span><span class="pgerr-msg">${inline(title)}</span></div><div class="pgerr-b">${inner}</div></aside>`;
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
  const ctx = { file, num: meta.num, numLabel: meta.numbered !== 'false', slug, secs: [], subs: 0, fig: 0, runs: 0, runsBy: {}, quiz: 0 };
  const body = parseBlocks(raw.slice(fm[0].length).split('\n'), ctx);
  return { ...meta, slug, body, secs: ctx.secs, figs: ctx.fig, runs: ctx.runs, runsBy: ctx.runsBy, quiz: ctx.quiz };
}

const files = fs.existsSync(CH_DIR) ? fs.readdirSync(CH_DIR).filter((f) => /^ch\d+\.md$/.test(f)).sort() : [];
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
  term: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/></svg>',
};

// 署名：チップ（四角い石と、その中の小さな核）を思わせるマーク
const MARK = `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6"/><path d="M7.5 7.5h9v9h-9z" class="mark-l"/><circle cx="12" cy="12" r="2" class="mark-d"/></svg>`;

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
    .join('')}<a class="nav-c nav-play${active === 'playground' ? ' is-active' : ''}" href="playground.html"><span class="nav-no">${ICON.term}</span><span class="nav-t">実験場（自由に試す）</span></a></nav>`;
}

const DESC = 'CPU とコンピュータの仕組みを、ブラウザの中で動く小さな RISC-V の CPU と論理回路シミュレータで試しながら学ぶ日本語の学習書';

function shell({ title, body, active, desc, toc = '', runner = false, quiz = false, panel = false, play = false }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${attr(desc || DESC)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+JP:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/style.css">
<script>try{var t=localStorage.getItem('zc-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body${toc ? '' : ' class="no-toc"'}>
<header class="top">
  <button type="button" class="icon-btn menu-btn" aria-label="目次を開く">${ICON.menu}</button>
  <a class="brand" href="index.html">${MARK}<span>${BRAND}</span></a>
  <div class="search">
    ${ICON.search}
    <input type="search" id="q" placeholder="検索" autocomplete="off" aria-label="章と節を検索">
    <kbd class="kc">/</kbd>
    <div class="search-res" hidden></div>
  </div>
  ${panel ? '<div class="db-state"><button type="button" class="db-view" aria-pressed="false" aria-controls="cpuv" title="直前に実行したプログラムを、1 命令ずつ進めながらレジスタやメモリを見ます">CPU を見る</button></div>' : ''}
  <button type="button" class="icon-btn theme-btn" aria-label="テーマを切り替え"><span class="i-sun">${ICON.sun}</span><span class="i-moon">${ICON.moon}</span></button>
</header>
<div class="layout">
  <aside class="side">${sidebar(active)}<div class="side-foot">プログラムと回路は、このサイトのために作った小さな RISC-V（RV32IM）エミュレータと論理回路シミュレータが、ブラウザの中で実行します。読み込むものはなく、すぐ動きます。</div></aside>
  <main class="main">${body}</main>
  ${toc}
</div>
<script src="assets/search-index.js"></script>
<script src="assets/app.js"></script>
${runner ? `${panel ? `<aside class="dbv" id="cpuv" hidden aria-label="CPU の中身">
  <div class="dbv-grip" role="separator" aria-orientation="horizontal" aria-label="パネルの高さを変える（上下の矢印キーでも変えられます）" tabindex="0"></div>
  <div class="dbv-h">
    <div class="cv-head"><span class="cv-head-k">CPU を見る</span><span class="cv-title"></span></div>
    <div class="dbv-ctl"><button type="button" class="icon-btn dbv-close" aria-label="閉じる">${ICON.close}</button></div>
  </div>
  <div class="dbv-b"></div>
</aside>` : ''}
<script src="assets/hl.js"></script>
<script src="assets/rv.js"></script>
<script src="assets/logic.js"></script>
<script src="assets/grade.js"></script>
<script src="assets/cpu-run.js"></script>
<script src="assets/cpuview.js"></script>` : ''}
${quiz ? '<script src="assets/quiz.js"></script>' : ''}
${play ? '<script src="assets/samples.js"></script>\n<script src="assets/play.js"></script>' : ''}
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
  const runs = [c.runsBy.asm ? `実行できるプログラム ${c.runsBy.asm} 個` : '', c.runsBy.logic ? `実行できる回路 ${c.runsBy.logic} 個` : ''].filter(Boolean).map((t) => `<span>${t}</span>`).join('');
  const body = `<article class="doc">
  <header class="ch-head">
    <div class="ch-eyebrow">${c.num === '0' ? 'はじめに' : c.appendix === 'true' ? '付録' : `第 ${c.num} 章`}</div>
    <h1>${esc(c.title)}</h1>
    ${c.lead ? `<p class="lead">${inline(c.lead)}</p>` : ''}
    ${c.secs.length > 1 ? `<div class="ch-meta"><span>${c.secs.length} 節</span><span>図 ${c.figs} 点</span>${runs}${c.quiz ? `<a href="#quiz">確認問題 ${c.quiz} 問</a>` : ''}${c.time ? `<span>目安 ${esc(c.time)}</span>` : ''}</div>` : ''}
  </header>
  ${c.body}
  ${pager}
</article>`;
  const runner = c.runs > 0 || c.quiz > 0;
  return shell({ title: `${c.title} — ${BRAND}`, body, active: c.slug, desc: c.lead, toc, runner, panel: runner && (c.runsBy.asm > 0 || c.quiz > 0), quiz: c.quiz > 0 });
}

// ---------------------------------------------------------------- トップページ
function homePage() {
  const total = chapters.reduce((a, c) => a + c.secs.length, 0);
  const figs = chapters.reduce((a, c) => a + c.figs, 0);
  const runs = chapters.reduce((a, c) => a + c.runs, 0);
  const byNum = Object.fromEntries(chapters.map((c) => [c.num, c]));
  const nm = (n) => (byNum[n] ? `${n} ${byNum[n].short || byNum[n].title}` : String(n));
  // 1〜20 章を 5 列で折り返して並べる。色は題材のまとまり
  const kindOf = (n) => (n <= 3 ? 'plain' : n <= 7 ? 'stack' : n <= 15 ? 'crate' : n <= 19 ? 'ext' : 'accent');
  const pos = (n) => { const k = n - 1, row = Math.floor(k / 5), col = k % 5; return { x: row % 2 ? 4 - col : col, y: row }; };
  const roadmap = renderFig(
    'graph',
    {
      col: 172,
      row: 84,
      minW: 124,
      nodes: Array.from({ length: 20 }, (_, k) => ({ id: `p${k + 1}`, label: nm(String(k + 1)), ...pos(k + 1), kind: kindOf(k + 1), mono: false })),
      edges: Array.from({ length: 19 }, (_, k) => ({ from: `p${k + 1}`, to: `p${k + 2}`, style: 'muted' })),
      groups: [],
      label: '章の学習ルート',
    },
    '章どうしのつながり。1〜3 章が歴史と数の表し方、青い 4〜7 章が論理回路、琥珀色の 8〜15 章がアセンブリ、緑の 16〜19 章が CPU の中身、最後の 20 章で C とつなぎます',
    '0'
  );
  const cards = chapters
    .map(
      (c) => `<a class="ch-card" href="${c.slug}.html"><span class="ch-card-no">${chLabel(c)}</span><span class="ch-card-t">${esc(c.title)}</span><span class="ch-card-d">${inline(c.lead || '')}</span><span class="ch-card-m"><span>${c.secs.length} 節</span><span>図 ${c.figs}</span>${c.runs ? `<span>実行 ${c.runs}</span>` : ''}${c.quiz ? `<span>問題 ${c.quiz}</span>` : ''}<span class="nav-prog" data-ch="${c.slug}" data-total="${c.secs.length}"></span></span></a>`
    )
    .join('');
  const tryIt = runBlock(
    'asm',
    `# このボタンで、ブラウザの中の CPU がこのプログラムを実行します
main:
  li   t0, 0x10000    # 画面（32 × 32）の先頭の番地
  li   t1, 0          # t1 = 何番目のピクセルか
  li   t2, 1024
loop:
  srli t3, t1, 5      # t3 = y
  xor  t3, t3, t1     # x と y を混ぜて
  srli t3, t3, 1
  andi t3, t3, 15     # 色番号 0〜15 にする
  add  t4, t0, t1
  sb   t3, 0(t4)      # そのピクセルに色を置く
  addi t1, t1, 1
  blt  t1, t2, loop`,
    'asm run title="まず 1 回、実行してみる"',
    { runs: 0, runsBy: {}, file: 'index' }
  );
  const first = chapters[0];
  const body = `<div class="home">
  <section class="hero">
    <div class="hero-text">
      <div class="ch-eyebrow">小さな RISC-V の CPU をブラウザで動かしながら読む</div>
      <h1>0 と 1 から、ゲームが動くところまで</h1>
      <p class="lead">2 進数と論理ゲートから始めて、足し算の回路、メモリ、機械語とアセンブリ、関数とスタック、入出力、そしてパイプラインとキャッシュまで。コンピュータの仕組みを日本語で一から説明します。本文のプログラムと回路はすべて、その場で書き換えて実行でき、1 命令ずつ進めてレジスタやメモリの動きを追えます。</p>
      <div class="hero-act">${first ? `<a class="btn primary" href="${first.slug}.html">${first.num === '0' ? '序章から読む' : '最初の章から読む'}</a>` : ''}<a class="btn" href="playground.html">実験場で自由に試す</a><a class="btn" id="resume" href="${(chapters[1] || first || { slug: 'playground' }).slug}.html" hidden>続きから</a></div>
      <dl class="hero-stats"><div><dt>章</dt><dd>${chapters.length}</dd></div><div><dt>節</dt><dd>${total}</dd></div><div><dt>図</dt><dd>${figs}</dd></div><div><dt>実行できる例</dt><dd>${runs}</dd></div><div><dt>読了</dt><dd><span id="done-count">0</span><span class="of"> / ${total}</span></dd></div></dl>
    </div>
    <div class="hero-visual">${heroFig()}${tryIt}</div>
  </section>
  <section class="home-sec"><h2 class="home-h">学習ルート</h2>${roadmap}</section>
  <section class="home-sec"><h2 class="home-h">すべての章</h2><div class="ch-grid">${cards}<a class="ch-card is-play" href="playground.html"><span class="ch-card-no">実験場</span><span class="ch-card-t">自由に試す</span><span class="ch-card-d">アセンブリのプログラムと論理回路を、好きなだけ書いて動かせるページです。ライフゲームや、矢印キーで動かす小さなゲームのサンプルつき。</span><span class="ch-card-m"><span>RISC-V</span><span>論理回路</span></span></a></div></section>
</div>`;
  return shell({ title: `${BRAND} — コンピュータの仕組みを、動く CPU で学ぶ`, body, active: '', runner: true, panel: true });
}

// CPU の簡略データパス。1 つの命令が通る 5 つの段階を、ボタンで順に光らせる
function heroFig() {
  const N = [
    ['pc', 'PC', '次の命令の番地', 0, 0],
    ['im', '命令メモリ', '機械語が並ぶ', 1, 0],
    ['reg', 'レジスタ', 'x0〜x31', 1, 1],
    ['alu', 'ALU', '計算する', 1, 2],
    ['dm', 'データメモリ', '読み書きする', 0, 2],
  ];
  const E = [['pc', 'im'], ['im', 'reg'], ['reg', 'alu'], ['alu', 'dm'], ['dm', 'reg']];
  const KIND = { pc: 'stack', im: 'crate', reg: 'stack', alu: 'ext', dm: 'crate' };
  const step = (title, say, on, edgesOn) => ({
    title,
    say,
    nodes: N.map(([id, label, sub, x, y]) => ({ id, label, sub, x, y, kind: on.includes(id) ? 'accent' : KIND[id], mono: false })),
    edges: E.map(([from, to], k) => ({ from, to, style: edgesOn.includes(k) ? 'accent' : 'muted' })),
  });
  return renderFig(
    'graph',
    {
      col: 176,
      row: 84,
      minW: 128,
      label: 'CPU の簡略データパス',
      steps: [
        step('取り出す', '<b>取り出す（フェッチ）</b> — PC が指す番地から、次の命令（32 ビットの機械語）を取り出す', ['pc', 'im'], [0]),
        step('解読', '<b>解読する（デコード）</b> — 命令のビットを読み解き、使うレジスタの値を取り出す', ['im', 'reg'], [1]),
        step('実行', '<b>実行</b> — ALU が足し算や比較をする。分岐するかどうかも、ここで決まる', ['reg', 'alu'], [2]),
        step('メモリ', '<b>メモリ</b> — <code>lw</code> や <code>sw</code> なら、ALU が計算した番地でデータメモリを読み書きする', ['alu', 'dm'], [3]),
        step('書く', '<b>書き戻す</b> — 結果をレジスタに入れる。これで 1 命令。CPU はこの繰り返しだけで動く', ['dm', 'reg'], [4]),
      ],
    },
    '1 つの命令が CPU の中を通る道すじ。ボタンで段階を切り替えられます（第 16 章）',
    '0-1'
  );
}

// ---------------------------------------------------------------- 実験場
function playgroundPage() {
  const ctx = { runs: 0, runsBy: {}, file: 'playground' };
  const asmBox = runBlock('asm', '# サンプルを選ぶか、ここにプログラムを書いてください\n', 'asm run title="playground.s"', ctx)
    .replace('class="code cpurun is-asm"', 'class="code cpurun is-asm is-big no-panel" id="play-asm"');
  const logicBox = runBlock('logic', '# サンプルを選ぶか、ここに回路を書いてください\n', 'logic run title="playground.logic"', ctx)
    .replace('class="code cpurun is-logic"', 'class="code cpurun is-logic is-big" id="play-logic"');
  const body = `<article class="doc play">
  <header class="ch-head">
    <div class="ch-eyebrow">実験場</div>
    <h1>自由に試す</h1>
    <p class="lead">アセンブリのプログラムと論理回路を、好きなだけ書いて動かせます。書いたものは保存されません。残したいときはコピーしてください。</p>
  </header>
  <div class="play-tabs" role="tablist" aria-label="実験場の種類"><button type="button" role="tab" id="tab-asm" aria-controls="pane-asm" aria-selected="true">アセンブリ（CPU）</button><button type="button" role="tab" id="tab-logic" aria-controls="pane-logic" aria-selected="false">論理回路</button></div>
  <section class="play-pane" id="pane-asm" role="tabpanel" aria-labelledby="tab-asm">
    <div class="play-bar">
      <label>サンプル <select id="play-sample"></select></label>
      <label>速さ <select id="play-speed" title="1 フレーム（1/60 秒）あたりに実行する命令の数"></select></label>
      <span class="play-run"><button type="button" class="run-btn" id="play-go">${PLAY}<span>実行</span></button><button type="button" class="dbv-btn" id="play-stop" disabled>停止</button><button type="button" class="dbv-btn" id="play-load" title="プログラムを読み込み直して、最初の状態にする">読み込む</button></span>
    </div>
    <div class="play-grid">
      <div class="play-main">${asmBox}</div>
      <div class="play-view" id="play-view"></div>
    </div>
  </section>
  <section class="play-pane" id="pane-logic" role="tabpanel" aria-labelledby="tab-logic" hidden>
    <div class="play-bar"><label>サンプル <select id="play-lsample"></select></label></div>
    ${logicBox}
  </section>
</article>`;
  return shell({ title: `実験場 — ${BRAND}`, body, active: 'playground', runner: true, play: true });
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
idx.push({ t: '実験場（アセンブリと論理回路を自由に試す）', u: 'playground.html', c: '実験場' });
fs.writeFileSync(path.join(OUT, 'assets', 'search-index.js'), `window.ZR_INDEX=${JSON.stringify(idx)};window.ZR_TOTAL=${chapters.reduce((a, c) => a + c.secs.length, 0)};`);

const sum = (f) => chapters.reduce((a, c) => a + f(c), 0);
console.log(`built ${chapters.length} chapters, ${sum((c) => c.figs)} figures, ${sum((c) => c.runs)} runnable blocks (asm ${sum((c) => c.runsBy.asm || 0)}, logic ${sum((c) => c.runsBy.logic || 0)}), ${sum((c) => c.quiz)} quizzes → site/`);
