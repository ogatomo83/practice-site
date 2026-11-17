// 図解 LinuC — 静的サイトビルド（LinuC レベル2 の対策。練習問題、苦手の復習、模擬試験）
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
const BRAND = '図解 LinuC レベル2';
const PREFIX = 'zv-'; // localStorage の接頭辞（assets の各スクリプトも同じものを使う）
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
    attrs.stdin !== undefined ? `<span class="code-badge" title="最初のコマンドに、キーボードからこう打ったものとして渡します（⏎ は Enter）">入力：${esc(attrs.stdin.replace(/\\n/g, ' ⏎ ').replace(/\\t/g, '⇥').trim())}</span>` : '',
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

// ---------------------------------------------------------------- 出題範囲（LinuC レベル2 Version 10.0、LPI-Japan の公開している出題範囲と重要度）
const T = (id, title, weight, exam) => ({ id, title, weight, exam, sub: weight > 0, ch: 'ch' + id.slice(2, 4) });
export const TOPICS = [
  T('2.01', 'システムの起動とLinuxカーネル', 0, '201'),
  T('2.01.1', 'ブートプロセスとGRUB', 4, '201'), T('2.01.2', 'システム起動のカスタマイズ', 3, '201'), T('2.01.3', 'Linux カーネルの構成要素', 2, '201'), T('2.01.4', 'Linuxカーネルのコンパイル', 2, '201'), T('2.01.5', 'カーネル実行時における管理とトラブルシューティング', 3, '201'),
  T('2.02', 'ファイルシステムとストレージ管理', 0, '201'),
  T('2.02.1', 'ファイルシステムの設定とマウント', 3, '201'), T('2.02.2', 'ファイルシステムの管理', 4, '201'), T('2.02.3', '論理ボリュームマネージャの設定と管理', 3, '201'),
  T('2.03', 'ネットワーク構成', 0, '201'),
  T('2.03.1', '基本的なネットワーク構成', 3, '201'), T('2.03.2', '高度なネットワーク構成', 3, '201'), T('2.03.3', 'ネットワークの問題解決', 3, '201'),
  T('2.04', 'システムの保守と運用管理', 0, '201'),
  T('2.04.1', 'makeによるソースコードからのビルドとインストール', 3, '201'), T('2.04.2', 'バックアップとリストア', 3, '201'), T('2.04.3', 'ユーザへの通知', 1, '201'), T('2.04.4', 'リソース使用状況の把握', 3, '201'), T('2.04.5', '死活監視、リソース監視、運用監視ツール', 2, '201'), T('2.04.6', 'システム構成ツール', 4, '201'),
  T('2.05', '仮想化サーバー', 0, '201'),
  T('2.05.1', '仮想マシンの仕組みとKVM', 3, '201'), T('2.05.2', '仮想マシンの作成と管理', 3, '201'),
  T('2.06', 'コンテナ', 0, '201'),
  T('2.06.1', 'コンテナの仕組み', 2, '201'), T('2.06.2', 'Dockerコンテナとコンテナイメージの管理', 3, '201'),
  T('2.07', 'ネットワーククライアントの管理', 0, '202'),
  T('2.07.1', 'DHCPサーバーの設定と管理', 2, '202'), T('2.07.2', 'PAM認証', 3, '202'), T('2.07.3', 'LDAPクライアントの利用方法', 2, '202'), T('2.07.4', 'OpenLDAPサーバーの設定', 2, '202'),
  T('2.08', 'ドメインネームサーバー', 0, '202'),
  T('2.08.1', 'BINDの設定と管理', 3, '202'), T('2.08.2', 'ゾーン情報の管理', 2, '202'), T('2.08.3', 'セキュアなDNSサーバーの実現', 2, '202'),
  T('2.09', 'HTTPサーバーとプロキシサーバー', 0, '202'),
  T('2.09.1', 'Apache HTTPサーバーの設定と管理', 3, '202'), T('2.09.2', 'OpenSSLとHTTPSの設定', 3, '202'), T('2.09.3', 'nginxの設定と管理', 3, '202'), T('2.09.4', 'Squidの設定と管理', 2, '202'),
  T('2.10', '電子メールサービス', 0, '202'),
  T('2.10.1', 'Postfixの設定と管理', 3, '202'), T('2.10.2', 'Dovecotの設定と管理', 2, '202'),
  T('2.11', 'ファイル共有サービス', 0, '202'),
  T('2.11.1', 'Sambaの設定と管理', 4, '202'), T('2.11.2', 'NFSサーバーの設定と管理', 3, '202'),
  T('2.12', 'システムのセキュリティ', 0, '202'),
  T('2.12.1', 'iptables や firewalld によるパケットフィルタリング', 3, '202'), T('2.12.2', 'OpenSSH サーバーの設定と管理', 4, '202'), T('2.12.3', 'OpenVPNの設定と管理', 2, '202'), T('2.12.4', 'セキュリティ業務', 3, '202'),
  T('2.13', 'システムアーキテクチャ', 0, '202'),
  T('2.13.1', '高可用システムの実現方式', 2, '202'), T('2.13.2', 'キャパシティプランニングとスケーラビリティの確保', 2, '202'), T('2.13.3', 'クラウドサービス上のシステム構成', 2, '202'), T('2.13.4', '典型的なシステムアーキテクチャ', 3, '202'),
];
const QBANK = [];

// ---------------------------------------------------------------- 練習問題（:::q ID 種類）
//   :::q 1.03.2-01 single        single（1 つ選ぶ）/ multi（複数選ぶ）/ fill（入力）
//   問題文（段落、コードブロック）
//   - [ ] まちがいの選択肢
//   - [x] 正解の選択肢
//   = 入力の正解（fill。何行でも。どれか 1 つに合えば正解）
//   :::why
//   解説
//   :::
//   :::
function qBlock(title, body, ctx) {
  const [id, type0] = title.trim().split(/\s+/);
  const type = type0 || 'single';
  const m = id.match(/^(\d\.\d\d\.\d)-\d+$/);
  if (!m) throw new Error(`${ctx.file}: 問題の ID は「1.03.2-01」の形にする：${id}`);
  const topic = m[1];
  const t = TOPICS.find((x) => x.id === topic);
  if (!t) throw new Error(`${ctx.file}: 出題範囲にない主題：${topic}`);
  if (QBANK.some((q) => q.id === id)) throw new Error(`${ctx.file}: 問題の ID が重なっている：${id}`);
  const stem = [], choices = [], ans = [], fill = [], why = [];
  let inWhy = false, depth = 0, inCode = false;
  for (const l of body) {
    if (inWhy) {
      if (/^:::\w/.test(l)) depth++;
      if (/^:::\s*$/.test(l)) { if (!depth) { inWhy = false; continue; } depth--; }
      why.push(l); continue;
    }
    if (l.startsWith('```')) inCode = !inCode;
    if (!inCode && /^:::why\s*$/.test(l)) { inWhy = true; depth = 0; continue; }
    const cm = !inCode && l.match(/^- \[( |x)\] (.*)$/);
    if (cm) { if (cm[1] === 'x') ans.push(choices.length); choices.push(inline(cm[2])); continue; }
    const fm = !inCode && l.match(/^= (.*)$/);
    if (fm) { fill.push(fm[1].trim()); continue; }
    stem.push(l);
  }
  if (type === 'fill' ? !fill.length : choices.length < 2 || !ans.length) throw new Error(`${ctx.file}: ${id} の選択肢か正解がない`);
  if (type === 'single' && ans.length !== 1) throw new Error(`${ctx.file}: ${id} は single なのに正解が ${ans.length} 個`);
  if (!why.length) throw new Error(`${ctx.file}: ${id} に解説（:::why）がない`);
  const q = { id, topic, exam: t.exam, type, stem: parseBlocks(stem, ctx), choices, ans, fill, why: parseBlocks(why, ctx), ch: ctx.slug, chTitle: ctx.title || '' };
  QBANK.push(q);
  ctx.qs = (ctx.qs || 0) + 1;
  const inputs = type === 'fill'
    ? `<div class="lq-fill"><input class="lq-in" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="答えを入力"></div>`
    : `<ol class="lq-cs">${choices.map((c, k) => `<li><label class="lq-ch"><input class="lq-c" type="${type === 'multi' ? 'checkbox' : 'radio'}" name="${id}" value="${k}"><span class="lq-mk">${'ABCDEFGH'[k]}</span><span class="lq-ct">${c}</span></label></li>`).join('')}</ol>`;
  return `<div class="lq" data-qid="${id}" id="q-${id.replace(/\./g, '')}"><div class="lq-h"><span class="lq-no">${esc(id)}</span>${type === 'multi' ? '<span class="lq-kind">複数選択</span>' : type === 'fill' ? '<span class="lq-kind">入力</span>' : ''}<span class="lq-st"></span></div><div class="lq-stem">${q.stem}</div>${inputs}<div class="lq-act"><button type="button" class="btn primary lq-go">答える</button></div><div class="lq-res" hidden></div></div>`;
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
      if (type === 'q') { html += qBlock(title, body, ctx); continue; }
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
  const ctx = { file, num: meta.num, numLabel: meta.numbered !== 'false', slug, title: meta.title, secs: [], subs: 0, fig: 0, runs: 0, quiz: 0, setups: [] };
  const body = parseBlocks(raw.slice(fm[0].length).split('\n'), ctx);
  return { ...meta, slug, body, secs: ctx.secs, figs: ctx.fig, runs: ctx.runs, quiz: ctx.quiz, qs: ctx.qs || 0, setups: ctx.setups };
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
    .join('')}<a class="nav-c nav-play${active === 'review' ? ' is-active' : ''}" href="review.html"><span class="nav-no">✎</span><span class="nav-t">苦手を解く</span></a><a class="nav-c nav-play${active === 'mock' ? ' is-active' : ''}" href="mock.html"><span class="nav-no">◷</span><span class="nav-t">模擬試験</span></a><a class="nav-c nav-play${active === 'playground' ? ' is-active' : ''}" href="playground.html"><span class="nav-no">${ICON.term}</span><span class="nav-t">実験場（小さな Linux）</span></a></nav>`;
}

const DESC = 'LinuC レベル2（201 / 202 試験）に合格するための、図解 LinuC（レベル1）の続きの学習書。出題範囲の主題ごとの解説、本番の形の練習問題、苦手の復習、模擬試験';
const SIDE_FOOT = '練習問題の記録は、このブラウザに残ります。本文のコマンドは、図解 Linux と同じ「小さな Linux」が実行します。問題はこのサイトのオリジナルで、本番の問題ではありません。';

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
<script src="assets/qbank.js"></script>
<script src="assets/qa.js"></script>
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
    ${c.secs.length > 1 ? `<div class="ch-meta"><span>${c.secs.length} 節</span><span>図 ${c.figs} 点</span>${runs}${c.quiz ? `<a href="#quiz">確認問題 ${c.quiz} 問</a>` : ''}${c.qs ? `<a href="#practice">練習問題 ${c.qs} 問</a>` : ''}${c.time ? `<span>目安 ${esc(c.time)}</span>` : ''}</div>` : ''}
  </header>
  ${c.body}
  ${pager}
</article>`;
  const runner = c.runs > 0 || c.quiz > 0;
  return shell({ title: `${c.title} — ${BRAND}`, body, active: c.slug, desc: c.lead, toc, runner, quiz: c.quiz > 0, setups: c.setups });
}

// ---------------------------------------------------------------- トップページ
// 章立て（DESIGN.md）。原稿がまだない章も、学習ルートの図には名前を出す
const PLAN = ['はじめに', 'インストールと起動', 'ファイル管理', 'GNU と Unix のコマンド', 'パッケージ管理', 'ディスクとファイルシステム', 'シェルとスクリプト', 'ネットワーク', 'システム管理', 'システムサービス', 'セキュリティ', 'オープンソース'];

function homePage() {
  const total = QBANK.length;
  const cards = chapters
    .map((c) => `<a class="ch-card" href="${c.slug}.html"><span class="ch-card-no">${chLabel(c)}</span><span class="ch-card-t">${esc(c.title)}</span><span class="ch-card-d">${inline(c.lead || '')}</span><span class="ch-card-m">${c.exam ? `<span>${esc(c.exam)} 試験</span>` : ''}<span>${c.secs.length} 節</span>${c.qs ? `<span>問題 ${c.qs}</span>` : ''}<span class="nav-prog" data-ch="${c.slug}" data-total="${c.secs.length}"></span></span></a>`)
    .join('');
  const step = (title, say, on) => ({ title, say, nodes: [['diag', '1. 診断', '模試で、いまの力を測る', 0], ['learn', '2. 学ぶ', '章を読む・小さな Linux で試す', 1], ['drill', '3. 解く', '練習問題と苦手の復習', 2], ['mock', '4. 模試', '80% を 3 回続ける', 3]].map(([id, label, sub, x]) => ({ id, label, sub, x, y: 0, kind: on.includes(id) ? 'accent' : 'plain', mono: false })), edges: [{ from: 'diag', to: 'learn' }, { from: 'learn', to: 'drill' }, { from: 'drill', to: 'mock' }, { from: 'mock', to: 'learn', label: '苦手の主題へ戻る', curve: 1, style: 'muted' }] });
  const method = renderFig('graph', { col: 190, row: 96, minW: 150, label: '合格メソッド', steps: [
    step('診断', '<b>1. 診断</b> — 最初に模擬試験を 1 回。点数より、主題ごとの正答率を見る', ['diag']),
    step('学ぶ', '<b>2. 学ぶ</b> — 正答率の低い主題から章を読む。図解 Linux で学んだ所は、対応の節へのリンクで復習する', ['learn']),
    step('解く', '<b>3. 解く</b> — 章末の練習問題を解き、「苦手を解く」でまちがえた問題だけを繰り返す', ['drill']),
    step('模試', '<b>4. 模試</b> — 80% 以上を 3 回続けて取れたら、本番を予約する', ['mock']),
  ] }, '合格メソッドの 4 段階。ボタンで切り替えられます（序章）', '0');
  const body = `<div class="home">
  <section class="hero">
    <div class="hero-text">
      <div class="ch-eyebrow">LinuC レベル2 Version 10.0（201 / 202 試験）</div>
      <h1>レベル1 の次は、サーバーを任される力</h1>
      <p class="lead">レベル1 で学んだコマンドと設定を土台に、LinuC レベル2 の出題範囲を主題ごとに埋めていきます。カーネルとブート、LVM とファイルシステムの管理、Ansible、KVM と Docker（201）、DHCP・LDAP・DNS・Apache・nginx・Squid・Postfix・Samba・NFS・ファイアウォール・SSH・高可用の設計（202）。サーバーの設定ファイルは Docker で実際に動かして確かめたものを載せています。各章の終わりに本番の形の練習問題があり、仕上げは重要度どおりに出題する 60 問・90 分の模擬試験です。</p>
      <div class="hero-act"><a class="btn primary" href="ch00.html">序章から読む</a><a class="btn" href="mock.html">模擬試験で診断する</a><a class="btn" href="review.html">苦手を解く</a></div>
      <dl class="hero-stats"><div><dt>章</dt><dd>${chapters.length}</dd></div><div><dt>練習問題</dt><dd>${total}</dd></div><div><dt>出題範囲の主題</dt><dd>${TOPICS.filter((t) => t.sub).length}</dd></div><div><dt>読了</dt><dd><span id="done-count">0</span><span class="of"> / ${chapters.reduce((a, c) => a + c.secs.length, 0)}</span></dd></div></dl>
    </div>
    <div class="hero-visual">${method}</div>
  </section>
  <section class="home-sec"><h2 class="home-h">いまの進み具合</h2><div id="lq-home-dash"></div></section>
  <section class="home-sec"><h2 class="home-h">すべての章</h2><div class="ch-grid">${cards}</div></section>
</div>`;
  return shell({ title: `${BRAND} — LinuC レベル2 に合格するための学習書`, body, active: '', runner: true });
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

// ---------------------------------------------------------------- 苦手を解く / 模擬試験
function reviewPage() {
  const body = `<article class="doc">
  <header class="ch-head"><div class="ch-eyebrow">復習</div><h1>苦手を解く</h1><p class="lead">解いた記録から、前回まちがえた問題、まだ解いていない問題を集めて出します。主題ごとの正答率も見られます。正答率が 70% に届かない主題には色が付きます。記録はこのブラウザに残ります。</p></header>
  <div id="lq-drill" class="lq-modes">
    <button type="button" class="btn primary" data-mode="weak">前回まちがえた問題（20 問）</button>
    <button type="button" class="btn" data-mode="new">まだ解いていない問題（20 問）</button>
    <button type="button" class="btn" data-mode="mix" data-exam="201">201 からランダム</button>
    <button type="button" class="btn" data-mode="mix" data-exam="202">202 からランダム</button>
  </div>
  <div id="lq-dash"></div>
  <div id="lq-area"></div>
</article>`;
  return shell({ title: `苦手を解く — ${BRAND}`, body, active: 'review', desc: 'LinuC レベル2 の練習問題を、前回まちがえたものとまだ解いていないものから出す復習のページ' });
}
function mockPage() {
  const body = `<article class="doc">
  <header class="ch-head"><div class="ch-eyebrow">模擬試験</div><h1>模擬試験</h1><p class="lead">本番と同じく、1 回 60 問・90 分です。出題範囲の重要度の数だけ、主題ごとに問題を選びます（まだ解いていない問題が先）。採点すると、主題ごとの正答率と、全部の問題の解説が出ます。本番の合格点は公表されていないので、この模試で 80% 以上を続けて取れることを目標にしてください。</p></header>
  <div id="lq-mock" class="lq-modes">
    <button type="button" class="btn primary" data-exam="201">201 試験を始める（問題の数 <span data-count="201"></span>）</button>
    <button type="button" class="btn primary" data-exam="202">202 試験を始める（問題の数 <span data-count="202"></span>）</button>
  </div>
  <div id="lq-mock-area"></div>
</article>`;
  return shell({ title: `模擬試験 — ${BRAND}`, body, active: 'mock', desc: 'LinuC レベル2 の 201 / 202 試験の模擬試験（60 問・90 分、重要度に合わせた出題）' });
}

// ---------------------------------------------------------------- 出力
// ZV_CHECK=1 なら、原稿を読んで形を確かめるだけで、site/ には書かない（検査を同時に走らせるため）
const CHECK = !!process.env.ZV_CHECK;
if (CHECK) { for (const c of chapters) void c; console.log(`checked ${chapters.length} chapters, ${QBANK.length} questions`); process.exit(0); }
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'assets'))) fs.copyFileSync(path.join(ROOT, 'assets', f), path.join(OUT, 'assets', f));
chapters.forEach((c, i) => fs.writeFileSync(path.join(OUT, `${c.slug}.html`), chapterPage(c, i)));
fs.writeFileSync(path.join(OUT, 'index.html'), homePage());
fs.writeFileSync(path.join(OUT, 'playground.html'), playgroundPage());
fs.writeFileSync(path.join(OUT, 'assets', 'qbank.js'), `window.QTOPICS=${JSON.stringify(TOPICS)};\nwindow.QBANK=${JSON.stringify(QBANK).replace(/</g, '\\u003c')};`);
fs.writeFileSync(path.join(OUT, 'review.html'), reviewPage());
fs.writeFileSync(path.join(OUT, 'mock.html'), mockPage());

const strip = (s) => s.replace(/`/g, '').replace(/\*\*/g, '');
const idx = [];
chapters.forEach((c) => {
  idx.push({ t: strip(c.title), u: `${c.slug}.html`, c: chLabel(c) });
  c.secs.forEach((s, k) => {
    idx.push({ t: strip(s.title), u: `${c.slug}.html#${s.id}`, c: c.numbered === 'false' ? chLabel(c) : `${c.num}.${k + 1}` });
    (s.subs || []).forEach((ss) => idx.push({ t: strip(ss.title), u: `${c.slug}.html#${ss.id}`, c: `${c.num}.${k + 1}` }));
  });
});
idx.push({ t: '実験場（小さな Linux でコマンドを自由に試す）', u: 'playground.html', c: '実験場' });
idx.push({ t: '苦手を解く（練習問題の復習）', u: 'review.html', c: '復習' });
idx.push({ t: '模擬試験（201 / 202、60 問 90 分）', u: 'mock.html', c: '模試' });
fs.writeFileSync(path.join(OUT, 'assets', 'search-index.js'), `window.ZR_INDEX=${JSON.stringify(idx)};window.ZR_TOTAL=${chapters.reduce((a, c) => a + c.secs.length, 0)};`);

const sum = (f) => chapters.reduce((a, c) => a + f(c), 0);
const per = {};
for (const q of QBANK) per[q.topic] = (per[q.topic] || 0) + 1;
const short = TOPICS.filter((t) => t.sub && (per[t.id] || 0) < t.weight * 3).map((t) => `${t.id}:${per[t.id] || 0}/${t.weight * 3}`);
console.log(`built ${chapters.length} chapters, ${sum((c) => c.figs)} figures, ${sum((c) => c.runs)} runnable blocks, ${QBANK.length} questions → site/${short.length ? `\n  問題が少ない主題（重要度 × 3 未満）：${short.join(' ')}` : ''}`);