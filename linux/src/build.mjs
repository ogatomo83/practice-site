// 図解 Linux — 静的サイトビルド
// 原稿: src/chapters/*.md（軽量マークダウン + 図フェンス + 実行できるシェルのブロック） → site/*.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { highlight, dedent, esc, HL } from './lib/highlight.mjs';
import { renderFig } from './lib/diagrams.mjs';
import { LNX_FILES } from './lib/lnx-files.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, '..', 'site');
const CH_DIR = path.join(ROOT, 'chapters');
const BRAND = '図解 Linux';
const PREFIX = 'zl-'; // localStorage の接頭辞（assets の各スクリプトも同じものを使う）
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
const LANG_LABEL = { sh: 'シェル', c: 'C', console: 'ターミナル', text: '' };
// 実行ブロックに書ける属性（意味は src/assets/grade.js）。知らないものはビルド時に知らせる
const RUN_FLAGS = new Set(['run', 'error', 'root', 'strace', 'limit']);
const RUN_ATTRS = new Set(['title', 'user', 'strace', 'stdin', 'keys', 'maxticks', 'trace']);
const QUIZ_FLAGS = new Set(['answer', 'unordered', 'exit', 'root']);
const QUIZ_ATTRS = new Set(['user', 'forbid', 'require']);
const TRACE_JA = { sched: 'スケジューラ', mem: 'メモリ', net: 'ネットワーク', pagecache: 'ページキャッシュ' };
function checkInfo(what, { flags, attrs }, okFlags, okAttrs, ctx) {
  const bad = [...flags].filter((f) => !okFlags.has(f)).concat(Object.keys(attrs).filter((a) => !okAttrs.has(a)));
  if (bad.length) console.warn(`  注意 ${ctx.file}: ${what} に知らない属性 ${bad.join(', ')}`);
}

const editor = (raw, lang, label, minRows = 1) =>
  `<div class="ed"><pre class="ed-hl" aria-hidden="true"><code>${HL.editorHTML(raw, lang)}</code></pre><textarea class="ed-ta" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" aria-label="${attr(label)}" rows="${Math.max(minRows, raw.split('\n').length)}">${esc(raw)}</textarea></div>`;

// ```sh run：その場で書き換えて実行できるブロック。info はフェンスの info 文字列（lang から）
function runBlock(body, info, ctx) {
  const { flags, attrs } = parseInfo(info.replace(/^\S+\s*/, ''));
  checkInfo('sh run', { flags, attrs }, RUN_FLAGS, RUN_ATTRS, ctx);
  ctx.runs++;
  const raw = dedent(body).join('\n');
  const title = attrs.title ? `<span class="code-file">${esc(attrs.title)}</span>` : `<span class="code-file is-lang">${LANG_LABEL.sh}</span>`;
  const who = attrs.user || (flags.has('root') ? 'root' : '');
  // keys（途中で Ctrl-C / Ctrl-Z を押す例）は、終了ステータスが 130 / 148 になるので error の印が付くが、「エラーになる例」ではなく「止める例」として見せる
  const keyNames = attrs.keys ? [...new Set(attrs.keys.split(',').map((k) => k.split('@')[0].trim().replace(/^\^(.)$/, 'Ctrl-$1')))] : [];
  const stopKeys = keyNames.filter((k) => /^Ctrl-[CZ\\]$/.test(k));
  const isFail = flags.has('error') && !stopKeys.length;
  const badges = [
    isFail ? '<span class="code-badge is-fail">エラーになる</span>' : '',
    stopKeys.length ? `<span class="code-badge">${esc(stopKeys.join('、'))} で止める例</span>` : keyNames.length ? `<span class="code-badge">途中で ${esc(keyNames.join('、'))}</span>` : '',
    who ? `<span class="code-badge">${esc(who)} で実行</span>` : '',
    flags.has('strace') || attrs.strace ? '<span class="code-badge">strace：システムコールも表示</span>' : '',
    attrs.trace ? `<span class="code-badge">${esc(attrs.trace.split(/[|,\s]+/).filter(Boolean).map((t) => TRACE_JA[t] || t).join('・'))}を観察</span>` : '',
    attrs.stdin !== undefined ? '<span class="code-badge">入力つき</span>' : '',
    flags.has('limit') ? '<span class="code-badge">上限で打ち切られる</span>' : '',
  ].join('');
  return `<div class="code lnxrun${isFail ? ' is-fail' : ''}" data-lang="sh" data-info="${attr(info)}"><div class="code-h">${title}${badges}<span class="run-key" title="Ctrl または ⌘ + Enter でも実行できます">⌘↵</span><button type="button" class="undo" hidden>元に戻す</button><button type="button" class="copy" aria-label="コマンドをコピー">コピー</button><button type="button" class="run-btn">${PLAY}<span>実行</span></button></div>${editor(raw, 'sh', 'コマンドを編集して実行できます')}<div class="out" hidden aria-live="polite"></div></div>`;
}

// ```sh setup：章の準備。ページの機械を起動した直後に自動で流れる。本文には折りたたみで出す
function setupBlock(body, info, ctx) {
  const raw = dedent(body).join('\n');
  ctx.setups.push({ src: raw, info });
  return `<details class="setup-fold"><summary><span class="setup-k">この章の準備</span>最初の実行のときに、自動で流れるコマンド</summary><div class="code"><pre><code>${highlight(raw, 'sh')}</code></pre></div></details>`;
}

function codeBlock(lang, info, body, ctx) {
  const { flags, attrs } = parseInfo(info);
  if (lang === 'sh' && flags.has('run')) return runBlock(body, `sh ${info}`, ctx);
  if (lang === 'sh' && flags.has('setup')) return setupBlock(body, `sh ${info}`, ctx);
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
//   ```sh answer [unordered] [exit] [root] [user="alice"] [forbid="sort,uniq"] [require="grep"]   模範解答（必須）
//   ```sh check     あれば、実行の後に root でこれを実行した標準出力を比べる（ファイルを作る・権限を変える問題）
//   ```sh prep      その問題だけの準備
//   ```sh vary      準備のデータを変える追加の準備（何個でも）。base + prep + vary でもう一度比べる
//   ```sh starter   入力欄に最初から入れておくコマンド
//   :::hint ... :::   ヒント（折りたたみ）
function quizRule(p, parts) {
  const what = [parts.check ? '実行した後の状態（下の「確かめ方」のコマンドの出力）' : '標準出力'];
  if (p.flags.has('exit')) what.push('終了ステータス');
  const notes = [];
  if (!parts.check || p.flags.has('unordered')) notes.push(p.flags.has('unordered') ? '行の順番は問わない' : '行の順番も見る');
  const who = p.attrs.user || (p.flags.has('root') ? 'root' : '');
  if (who) notes.push(`${who} として実行`);
  if (p.attrs.forbid) notes.push(`${p.attrs.forbid.split(',').map((s) => s.trim()).join('・')} は使わない`);
  if (p.attrs.require) notes.push(`${p.attrs.require.split(',').map((s) => s.trim()).join('・')} を使う`);
  return `${what.join('と')}で判定${notes.length ? `（${notes.join('、')}）` : ''}`;
}

function quizBlock(title, body, ctx) {
  const parts = { answer: '', check: '', prep: '', starter: '' };
  const vary = [];
  let info = '';
  const rest = [], hints = [];
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    const fm = l.match(/^```sh\s+(.*)$/);
    const kind = fm && ['answer', 'check', 'prep', 'vary', 'starter'].find((k) => new RegExp(`(^|\\s)${k}(\\s|$)`).test(fm[1]));
    if (kind) {
      const b = [];
      i++;
      while (i < body.length && !body[i].startsWith('```')) b.push(body[i++]);
      const src = dedent(b.join('\n')).join('\n').replace(/\s+$/, '');
      if (kind === 'vary') vary.push(src); else parts[kind] = src;
      if (kind === 'answer') info = `sh ${fm[1].trim()}`;
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
  if (!parts.answer) throw new Error(`${ctx.file}: 確認問題「${title}」に sh answer がない`);
  const p = parseInfo(info.replace(/^\S+\s*/, ''));
  checkInfo(`確認問題「${title}」の answer`, p, QUIZ_FLAGS, QUIZ_ATTRS, ctx);
  const n = ++ctx.quiz;
  const starter = parts.starter ? parts.starter + '\n' : '# ここにコマンドを書いて「答え合わせ」（Ctrl / ⌘ + Enter）\n';
  const data = JSON.stringify({ answer: parts.answer, info, check: parts.check || undefined, prep: parts.prep || undefined, vary: vary.length ? vary : undefined }).replace(/</g, '\\u003c');
  const fold = (cls, label, inner) => `<details class="qz-fold${cls}"><summary>${label}</summary><div class="qz-fold-b">${inner}</div></details>`;
  const shCode = (src) => `<div class="code"><pre><code>${highlight(src, 'sh')}</code></pre></div>`;
  const hintHTML = hints.map((h, k) => fold('', `ヒント${hints.length > 1 ? ` ${k + 1}` : ''}`, parseBlocks(h, ctx))).join('');
  const prepHTML = parts.prep ? fold('', 'この問題の準備', `<p class="qz-note">答え合わせのたびに、章の最初の状態にこの準備をしてから、あなたのコマンドを実行します。</p>${shCode(parts.prep)}`) : '';
  const checkHTML = parts.check ? fold('', '確かめ方', `<p class="qz-note">あなたのコマンドを実行した後に、root でこのコマンドを実行して、その出力を模範解答のときと比べます。</p>${shCode(parts.check)}`) : '';
  const ansHTML = fold(' qz-ans', '模範解答', shCode(parts.answer));
  return `<section class="qz" data-qid="${ctx.slug}-${n}" data-lang="sh"><div class="qz-h"><span class="qz-no">問 ${n}</span><h3 class="qz-t">${inline(title)}</h3><span class="qz-mark" hidden>正解済み</span></div><div class="qz-q">${parseBlocks(rest, ctx)}</div><div class="code qz-box">${editor(starter, 'sh', `問 ${n} の答えのコマンド`, 3)}<div class="qz-bar"><button type="button" class="run-btn qz-check">${PLAY}<span>答え合わせ</span></button><span class="run-key" title="Ctrl または ⌘ + Enter でも答え合わせできます">⌘↵</span><span class="qz-rule">${esc(quizRule(p, parts))}</span></div><div class="qz-res" hidden aria-live="polite"></div></div><div class="qz-more">${hintHTML}${prepHTML}${checkHTML}${ansHTML}</div><script type="application/json" class="qz-data">${data}</script></section>`;
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
  const ctx = { file, num: meta.num, numLabel: meta.numbered !== 'false', slug, secs: [], subs: 0, fig: 0, runs: 0, quiz: 0, setups: [] };
  const body = parseBlocks(raw.slice(fm[0].length).split('\n'), ctx);
  return { ...meta, slug, body, secs: ctx.secs, figs: ctx.fig, runs: ctx.runs, quiz: ctx.quiz, setups: ctx.setups };
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

// 署名：端末のプロンプト（> と、その横のカーソル）
const MARK = `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6"/><path d="M6.5 8l4 4-4 4" class="mark-l"/><path d="M13 16.2h4.5" class="mark-l"/></svg>`;

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

const DESC = 'Linux の使い方と仕組みを、ブラウザの中で動く小さな Linux（教育用に作ったカーネルのシミュレータとシェル）で試しながら学ぶ日本語の学習書';
const SIDE_FOOT = 'コマンドは、このサイトのために作った小さな Linux（JavaScript で書いたカーネルのシミュレータ、シェル、コマンド群）が、ブラウザの中で実行します。読み込むものはなく、すぐ動きます。';

// runner: 小さな Linux と実行ブロックのスクリプトを読み込む / setups: 章の ```sh setup```（ページの機械の初期状態）
function shell({ title, body, active, desc, toc = '', runner = false, quiz = false, play = false, setups = [] }) {
  const panel = runner && !play;
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
<script>try{var t=localStorage.getItem('${PREFIX}theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
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
  ${panel ? '<div class="db-state"><button type="button" class="db-view" aria-pressed="false" aria-controls="lnxv" title="いまのプロセス、ファイルディスクリプタ、ファイル、マウント、直前のコマンドのシステムコールを見ます">システムを見る</button><button type="button" class="db-reset" title="このページの Linux を最初の状態に戻します">リセット</button></div>' : ''}
  <button type="button" class="icon-btn theme-btn" aria-label="テーマを切り替え"><span class="i-sun">${ICON.sun}</span><span class="i-moon">${ICON.moon}</span></button>
</header>
<div class="layout">
  <aside class="side">${sidebar(active)}<div class="side-foot">${SIDE_FOOT}</div></aside>
  <main class="main">${body}</main>
  ${toc}
</div>
<script src="assets/search-index.js"></script>
<script src="assets/app.js"></script>
${runner ? `${panel ? `<aside class="dbv" id="lnxv" hidden aria-label="システムの中身">
  <div class="dbv-grip" role="separator" aria-orientation="horizontal" aria-label="パネルの高さを変える（上下の矢印キーでも変えられます）" tabindex="0"></div>
  <div class="dbv-h">
    <div class="cv-head"><span class="cv-head-k">システムを見る</span></div>
    <div class="dbv-tabs" role="tablist" aria-label="見るもの"></div>
    <div class="dbv-ctl"><button type="button" class="icon-btn dbv-close" aria-label="閉じる">${ICON.close}</button></div>
  </div>
  <div class="dbv-b"></div>
</aside>` : ''}
<script type="application/json" id="lnx-setup">${JSON.stringify(setups).replace(/</g, '\\u003c')}</script>
<script src="assets/hl.js"></script>
${LNX_FILES.map((f) => `<script src="assets/${f}"></script>`).join('\n')}
<script src="assets/lnx-run.js"></script>
<script src="assets/lnx-trace.js"></script>
<script src="assets/lnxview.js"></script>
<script src="assets/lnxview-adv.js"></script>` : ''}
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
  const runs = c.runs ? `<span>実行できる例 ${c.runs} 個</span>` : '';
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
  return shell({ title: `${c.title} — ${BRAND}`, body, active: c.slug, desc: c.lead, toc, runner, quiz: c.quiz > 0, setups: c.setups });
}

// ---------------------------------------------------------------- トップページ
// 章立て（DESIGN.md）。原稿がまだない章も、学習ルートの図には名前を出す
const PLAN = ['はじめに', '歴史', 'シェルの基本', 'ファイルとディレクトリ', 'ユーザーと権限', 'テキスト処理とパイプ', 'シェルスクリプト', 'プロセス', 'シグナルとジョブ', 'ファイルディスクリプタ', 'システムコール',
  'ファイルシステム', 'VFS とマウント', '仮想メモリ', 'スケジューラ', 'ページキャッシュ', 'ネットワーク', '起動と init', 'プログラムが動くまで', 'コンテナ', '観察と調査'];

function homePage() {
  const total = chapters.reduce((a, c) => a + c.secs.length, 0);
  const figs = chapters.reduce((a, c) => a + c.figs, 0);
  const runs = chapters.reduce((a, c) => a + c.runs, 0);
  const byNum = Object.fromEntries(chapters.map((c) => [c.num, c]));
  const nm = (n) => `${n} ${byNum[n] ? byNum[n].short || byNum[n].title : PLAN[n]}`;
  // 1〜20 章を 5 列で折り返して並べる。色は題材のまとまり
  const kindOf = (n) => (n <= 1 ? 'plain' : n <= 6 ? 'stack' : n <= 12 ? 'crate' : n <= 16 ? 'ext' : 'accent');
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
    '章どうしのつながり。1 章が歴史、青い 2〜6 章がシェルの使い方、琥珀色の 7〜12 章がプロセスとファイルの仕組み、緑の 13〜16 章がカーネルの中（メモリ、スケジューラ、キャッシュ、ネットワーク）、最後の 17〜20 章で起動からコンテナ、調べ方までをつなぎます',
    '0'
  );
  const cards = chapters
    .map(
      (c) => `<a class="ch-card" href="${c.slug}.html"><span class="ch-card-no">${chLabel(c)}</span><span class="ch-card-t">${esc(c.title)}</span><span class="ch-card-d">${inline(c.lead || '')}</span><span class="ch-card-m"><span>${c.secs.length} 節</span><span>図 ${c.figs}</span>${c.runs ? `<span>実行 ${c.runs}</span>` : ''}${c.quiz ? `<span>問題 ${c.quiz}</span>` : ''}<span class="nav-prog" data-ch="${c.slug}" data-total="${c.secs.length}"></span></span></a>`
    )
    .join('');
  const tryIt = runBlock(
    `# このボタンで、ブラウザの中の小さな Linux がコマンドを実行します
whoami
ls -l
sort fruits.txt | uniq -c | sort -rn | head -3`,
    'sh run title="まず 1 回、実行してみる"',
    { runs: 0, file: 'index' }
  );
  const first = chapters[0];
  const body = `<div class="home">
  <section class="hero">
    <div class="hero-text">
      <div class="ch-eyebrow">小さな Linux をブラウザで動かしながら読む</div>
      <h1>コマンドの使い方から、カーネルの中まで</h1>
      <p class="lead">シェルとコマンド、ファイルと権限、パイプとシェルスクリプトから始めて、プロセス、ファイルディスクリプタ、システムコール、ファイルシステム、仮想メモリ、スケジューラ、そしてコンテナの仕組みまで。Linux を日本語で一から説明します。本文のコマンドはすべて、その場で書き換えて実行でき、プロセスの木やファイルディスクリプタの表、システムコールの列を、動かしながら見られます。</p>
      <div class="hero-act">${first ? `<a class="btn primary" href="${first.slug}.html">${first.num === '0' ? '序章から読む' : '最初の章から読む'}</a>` : ''}<a class="btn" href="playground.html">実験場で自由に試す</a><a class="btn" id="resume" href="${(chapters[1] || first || { slug: 'playground' }).slug}.html" hidden>続きから</a></div>
      <dl class="hero-stats"><div><dt>章</dt><dd>${chapters.length}</dd></div><div><dt>節</dt><dd>${total}</dd></div><div><dt>図</dt><dd>${figs}</dd></div><div><dt>実行できる例</dt><dd>${runs}</dd></div><div><dt>読了</dt><dd><span id="done-count">0</span><span class="of"> / ${total}</span></dd></div></dl>
    </div>
    <div class="hero-visual">${heroFig()}${tryIt}</div>
  </section>
  <section class="home-sec"><h2 class="home-h">学習ルート</h2>${roadmap}</section>
  <section class="home-sec"><h2 class="home-h">すべての章</h2><div class="ch-grid">${cards}<a class="ch-card is-play" href="playground.html"><span class="ch-card-no">実験場</span><span class="ch-card-t">自由に試す</span><span class="ch-card-d">端末にコマンドを好きなだけ打てるページです。横には、プロセスやファイルの様子がいつも出ています。ホームディレクトリに作ったファイルは、ブラウザに保存されます。</span><span class="ch-card-m"><span>端末</span><span>システムを見る</span></span></a></div></section>
</div>`;
  return shell({ title: `${BRAND} — 使い方と仕組みを、動く Linux で学ぶ`, body, active: '', runner: true });
}

// コマンド 1 つの裏側。シェルが ls を実行するまでを、ボタンで順に光らせる
function heroFig() {
  const N = [
    ['tty', '端末', 'キーボードと画面', 0, 0],
    ['sh', 'シェル sh', 'PID 2', 1, 0],
    ['ls', '子プロセス ls', 'PID 3', 2, 0],
    ['k', 'カーネル', 'システムコールを受ける', 1, 1],
    ['fs', 'ファイルシステム', 'inode とディレクトリ', 2, 1],
  ];
  const E = [['tty', 'sh'], ['sh', 'ls'], ['ls', 'k'], ['k', 'fs'], ['k', 'tty'], ['sh', 'k']];
  const KIND = { tty: 'plain', sh: 'stack', ls: 'stack', k: 'ext', fs: 'crate' };
  const step = (title, say, on, edgesOn) => ({
    title,
    say,
    nodes: N.map(([id, label, sub, x, y]) => ({ id, label, sub, x, y, kind: on.includes(id) ? 'accent' : KIND[id], mono: false })),
    edges: E.map(([from, to], k) => ({ from, to, style: edgesOn.includes(k) ? 'accent' : 'muted' })),
  });
  return renderFig(
    'graph',
    {
      col: 190,
      row: 96,
      minW: 136,
      label: 'コマンド 1 つの裏側',
      steps: [
        step('打つ', '<b>打つ</b> — 端末に <code>ls</code> と打って Enter。シェルがその 1 行を読む', ['tty', 'sh'], [0]),
        step('fork', '<b>fork</b> — シェルは自分の複製（子プロセス）を作ってもらう。プロセスを作れるのはカーネルだけ', ['sh', 'k', 'ls'], [5, 1]),
        step('execve', '<b>execve</b> — 子プロセスが、自分の中身を <code>/usr/bin/ls</code> のプログラムに入れ替える', ['ls', 'k'], [2]),
        step('読む', '<b>読む</b> — <code>ls</code> はシステムコールでディレクトリの中身をたずね、カーネルがファイルシステムから答える', ['ls', 'k', 'fs'], [2, 3]),
        step('書く', '<b>書く</b> — 結果を <code>write</code> で端末に書いて終わる。シェルは <code>wait</code> で終わりを受け取り、次のプロンプトを出す', ['k', 'tty', 'sh'], [4, 5]),
      ],
    },
    '<code>ls</code> と打ってから結果が出るまで。ボタンで段階を切り替えられます（第 7 章、第 10 章）',
    '0-1'
  );
}

// ---------------------------------------------------------------- 実験場
function playgroundPage() {
  const body = `<article class="doc play">
  <header class="ch-head">
    <div class="ch-eyebrow">実験場</div>
    <h1>自由に試す</h1>
    <p class="lead">端末にコマンドを好きなだけ打てます。横の「システムを見る」には、プロセス、ファイルディスクリプタ、ファイル、直前のコマンドのシステムコールがいつも出ています。ホームディレクトリ（<code>/home/you</code>）に作ったファイルは、このブラウザに保存されます。</p>
  </header>
  <div class="play-bar">
    <label>サンプル <select id="play-sample"></select></label>
    <span class="play-keys"><kbd>Tab</kbd> 補完　<kbd>↑</kbd><kbd>↓</kbd> 履歴　<kbd>Ctrl</kbd>+<kbd>C</kbd> 止める　<kbd>Ctrl</kbd>+<kbd>Z</kbd> 一時停止　<kbd>Ctrl</kbd>+<kbd>D</kbd> 入力の終わり</span>
    <span class="play-run"><span class="play-save" id="play-save" aria-live="polite"></span><button type="button" class="dbv-btn" id="play-clear" title="画面の文字だけを消します（Ctrl + L）">画面を消す</button><button type="button" class="dbv-btn" id="play-reset" title="小さな Linux を最初の状態に戻します。保存したファイルも消えます">リセット</button></span>
  </div>
  <div class="play-grid">
    <div class="play-main">
      <div class="term" id="play-term" aria-label="端末">
        <div class="term-scroll" id="play-scroll" tabindex="-1"><div class="term-out" id="play-out" aria-live="polite"></div><div class="term-line"><span class="term-pr" id="play-pr"></span><span class="term-in-wrap"><textarea id="play-in" class="term-in" rows="1" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" aria-label="コマンドを入力"></textarea></span></div></div>
        <div class="term-pad" aria-label="キーの代わりのボタン"><button type="button" data-k="Tab">Tab</button><button type="button" data-k="ArrowUp" aria-label="前の履歴">↑</button><button type="button" data-k="ArrowDown" aria-label="次の履歴">↓</button><button type="button" data-k="c">Ctrl-C</button><button type="button" data-k="z">Ctrl-Z</button><button type="button" data-k="d">Ctrl-D</button></div>
      </div>
    </div>
    <div class="play-view" id="play-view"></div>
  </div>
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
idx.push({ t: '実験場（端末でコマンドを自由に試す）', u: 'playground.html', c: '実験場' });
fs.writeFileSync(path.join(OUT, 'assets', 'search-index.js'), `window.ZR_INDEX=${JSON.stringify(idx)};window.ZR_TOTAL=${chapters.reduce((a, c) => a + c.secs.length, 0)};`);

const sum = (f) => chapters.reduce((a, c) => a + f(c), 0);
console.log(`built ${chapters.length} chapters, ${sum((c) => c.figs)} figures, ${sum((c) => c.runs)} runnable blocks, ${sum((c) => c.quiz)} quizzes → site/`);