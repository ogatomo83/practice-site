/*! nvim-nav.js v0.2.0 — Neovim 風のキーボード操作 (NORMAL / INSERT) を静的ページに足す部品。
 * 依存なし・外部読み込みなし・file:// で動く。CSS はこのファイルに同梱 (<style id="nvim-nav-style"> を 1 回だけ入れる)。
 *
 * 入れ方:  <script src="nvim-nav.js" defer></script>   (body の最後でもよい。2 回読んでも 1 回しか動かない)
 *
 * キー (NORMAL = 入力欄の外 / INSERT = 入力欄の中)
 *   NORMAL  j / k   少し下 / 上にスクロール (step px、既定 60)
 *           } / {   半画面下 / 上 (half、既定 0.5 画面)
 *           i       画面に見えている一番上の入力欄に入る (INSERT へ)。本文の入力欄を先に選び、
 *                   position fixed / sticky の中の入力欄 (ヘッダーの検索欄など) は本文に無い時だけ選ぶ
 *           ?       キー一覧を開く / 閉じる (開いている間は ? / Ctrl-N / Esc で閉じる)
 *   INSERT  Ctrl-N  入力欄から抜けて NORMAL へ。それ以外のキーは全部ふつうに入力欄へ (Ctrl-C も奪わない)
 *   両方    Ctrl-J / Ctrl-K  画面に見えている入力欄の次 / 前へ (文書の順、端で折り返す)。NORMAL で押すと INSERT に入る
 *                   (入力欄の Ctrl-K = 行末まで削除 は使えなくなる。keys: { 'C-k': null } で戻せる)
 *   - Cmd / Ctrl / Alt 付きのキーは、割り当てたもの (既定は C-j / C-k) 以外は扱わない (ブラウザの操作を邪魔しない)
 *   - 日本語入力の変換中 (isComposing / keyCode 229) のキーは扱わない
 *   - ページ側が先に preventDefault したキーは扱わない (ページの j / k が勝つ)
 *
 * ページ側の設定 (どれも任意)
 *   読み込む前に window.NVIM_NAV_CONFIG = { step: 80, half: 0.5, keys: { j: null }, ... } を置く
 *   読み込んだ後は NvimNav.configure({...})
 *     step       j / k の量 (px)                       既定 60
 *     half       } / { の量 (画面の高さに対する比)        既定 0.5
 *     exitKey    INSERT を抜けるキー ('C-n' の形)         既定 'C-n'
 *     keys       { キー: 動作名 | 関数 | null }  null で無効。動作名: down up halfDown halfUp insert help nextInput prevInput
 *                修飾キーは 'C-j' (Ctrl) / 'A-j' (Alt) / 'D-j' (Cmd) の形。nextInput / prevInput は INSERT 中でも効く
 *     inputs     入力欄とみなす CSS セレクタ (既定の一覧に足す)
 *     scroller   () => スクロールする要素 (既定 document.scrollingElement)
 *     statusline false でモード表示を出さない
 *   <html data-nvim-nav="off">                  ページ全体で無効 (読み込んでも何もしない)
 *   data-nvim-nav-ignore を付けた要素の中      そこにフォーカス / イベントがある間は NORMAL のキーを扱わない
 *
 * API: window.NvimNav
 *   .mode                    'NORMAL' | 'INSERT'
 *   .enable() / .disable()   一時的に止める (モード表示も隠す)
 *   .configure(opts)
 *   .map(key, fn, label)     NORMAL のキーを足す / 上書き (fn(event) が false を返すと、扱わなかったことにする)
 *   .unmap(key)
 *   .help(show?)             キー一覧の開閉
 *   イベント: document に 'nvimnav:mode' (detail.mode)。<html data-nvim-mode="NORMAL|INSERT"> も付く
 */
(() => {
  'use strict';
  if (window.NvimNav) return;
  const root = document.documentElement;
  if (root.getAttribute('data-nvim-nav') === 'off') return;

  const ACTIONS = {
    down: { label: '少し下へ', run: () => scroll(cfg.step) },
    up: { label: '少し上へ', run: () => scroll(-cfg.step) },
    halfDown: { label: '半画面下へ', run: () => scroll(viewH() * cfg.half) },
    halfUp: { label: '半画面上へ', run: () => scroll(-viewH() * cfg.half) },
    insert: { label: '画面内の一番上の入力欄へ (本文を先に)', run: () => enterInsert() },
    help: { label: 'キー一覧 (もう一度 ? で閉じる)', run: () => help() },
    // both: INSERT 中でも効く
    nextInput: { label: '次の入力欄へ (画面内、端で折り返す)', both: true, run: () => moveInput(1) },
    prevInput: { label: '前の入力欄へ (画面内、端で折り返す)', both: true, run: () => moveInput(-1) },
  };
  const DEFAULT_KEYS = { j: 'down', k: 'up', '}': 'halfDown', '{': 'halfUp', i: 'insert', '?': 'help', 'C-j': 'nextInput', 'C-k': 'prevInput' };
  const BASE_INPUTS = [
    'input:not([type])',
    'input[type=text]', 'input[type=search]', 'input[type=email]', 'input[type=url]', 'input[type=tel]',
    'input[type=password]', 'input[type=number]', 'input[type=date]', 'input[type=datetime-local]',
    'input[type=month]', 'input[type=week]', 'input[type=time]',
    'textarea', 'select', '[contenteditable]:not([contenteditable=false])',
  ];

  const cfg = { step: 60, half: 0.5, exitKey: 'C-n', keys: {}, inputs: '', scroller: null, statusline: true };
  const custom = {}; // map() で足したもの: key -> { run, label }
  let enabled = true;
  let mode = 'NORMAL';
  let bar = null, helpEl = null, ring = null, ringFor = null, msgTimer = 0, ringTimer = 0;

  function configure(o) {
    if (!o) return api;
    for (const k of Object.keys(o)) {
      if (k === 'keys') Object.assign(cfg.keys, o.keys);
      else if (k in cfg) cfg[k] = o[k];
    }
    if (bar) bar.hidden = !enabled || cfg.statusline === false;
    if (helpEl) renderHelp();
    return api;
  }

  // ------------------------------------------------------------ 判定
  const inputSel = () => BASE_INPUTS.join(',') + (cfg.inputs ? ',' + cfg.inputs : '');
  function isEditable(el) {
    if (!el || el.nodeType !== 1 || el === document.body || el === root) return false;
    if (el.closest('.nvn-ui')) return false;
    if (el.isContentEditable) return true;
    try { return el.matches(inputSel()); } catch (e) { return false; }
  }
  const viewH = () => window.innerHeight || root.clientHeight;
  function scroller() {
    const s = typeof cfg.scroller === 'function' ? cfg.scroller() : cfg.scroller;
    return s || document.scrollingElement || root;
  }
  function scroll(dy) {
    const s = scroller();
    const top = Math.round(dy);
    if (s === document.scrollingElement || s === root || s === document.body) window.scrollBy({ top, left: 0, behavior: 'instant' });
    else s.scrollBy({ top, left: 0, behavior: 'instant' });
  }
  // position fixed / sticky の祖先 (自分を含む) を持つか: ヘッダーの検索欄など、常に画面の上に見えている物
  function inFixed(el) {
    for (let n = el; n && n.nodeType === 1 && n !== root; n = n.parentElement) {
      const p = getComputedStyle(n).position;
      if (p === 'fixed' || p === 'sticky') return true;
    }
    return false;
  }
  // 画面に見えている入力欄を文書の順で返す
  function visibleInputs() {
    const h = viewH(), w = window.innerWidth || root.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll(inputSel())) {
      if (el.disabled || el.closest('.nvn-ui') || el.closest('[hidden],[inert]')) continue;
      if (el.closest('[data-nvim-nav-ignore]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.bottom <= 0 || r.top >= h || r.right <= 0 || r.left >= w) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      out.push(el);
    }
    return out;
  }
  // i の行き先: 本文 (fixed / sticky の外) で一番上 → 無ければ fixed / sticky の中で一番上。
  // 同じ側では、全部見えている欄を、画面の端で切れている欄より先にする (切れた欄は打った時にブラウザがページを動かすため)
  function insertTarget() {
    const h = viewH();
    const list = visibleInputs().map((el) => { const r = el.getBoundingClientRect(); return { el, top: r.top, left: r.left, fixed: inFixed(el), cut: r.top < 0 || r.bottom > h }; });
    list.sort((a, b) => (a.fixed - b.fixed) || (a.cut - b.cut) || a.top - b.top || a.left - b.left);
    return list[0] ? list[0].el : null;
  }
  function enterInsert() {
    const el = insertTarget();
    if (!el) { flash('画面内に入力欄がありません'); return; }
    if (bar) { clearTimeout(msgTimer); bar.querySelector('.nvn-msg').hidden = true; }
    focusInput(el);
  }
  // Ctrl-J / Ctrl-K: 文書の順で次 / 前の入力欄へ。端で折り返す。今の欄が画面外でも文書の位置から次を決める
  function moveInput(dir) {
    const list = visibleInputs();
    if (!list.length) { flash('画面内に入力欄がありません'); return; }
    const a = document.activeElement;
    const cur = isEditable(a) ? a : null;
    let i;
    if (!cur) i = dir > 0 ? 0 : list.length - 1;
    else {
      const at = list.indexOf(cur);
      if (at >= 0) i = (at + dir + list.length) % list.length;
      else if (dir > 0) { i = list.findIndex((el) => cur.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING); if (i < 0) i = 0; }
      else { i = -1; list.forEach((el, j) => { if (cur.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) i = j; }); if (i < 0) i = list.length - 1; }
    }
    const el = list[i];
    focusInput(el);
    showRing(el);
    flash(`入力欄 ${i + 1}/${list.length}${describe(el) ? ': ' + describe(el) : ''}`, 1000);
  }
  function describe(el) {
    let t = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
    if (!t && el.id) { try { const l = document.querySelector('label[for="' + window.CSS.escape(el.id) + '"]'); if (l) t = l.textContent; } catch (e) { /* 古いブラウザ */ } }
    if (!t && el.closest('label')) t = el.closest('label').textContent;
    t = t.replace(/\s+/g, ' ').trim();
    return t.length > 24 ? t.slice(0, 23) + '…' : t;
  }
  // 移った先を 1 秒だけ枠で示す (ページの要素には何も付けない。上に重ねるだけ)
  function placeRing() {
    if (!ring || ring.hidden || !ringFor) return;
    const r = ringFor.getBoundingClientRect();
    Object.assign(ring.style, { left: (r.left - 4) + 'px', top: (r.top - 4) + 'px', width: (r.width + 8) + 'px', height: (r.height + 8) + 'px' });
  }
  function showRing(el) {
    if (!ring) return;
    ringFor = el; ring.hidden = false; placeRing();
    clearTimeout(ringTimer);
    ringTimer = setTimeout(hideRing, 1000);
  }
  // 上端に寄せた欄が sticky / fixed のヘッダーの下に隠れていたら、その分だけ戻す
  function uncover(el) {
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + 8, 0), (window.innerWidth || root.clientWidth) - 1), y = Math.max(r.top + 4, 0);
    const hit = document.elementFromPoint(x, y);
    if (!hit || el.contains(hit)) return;
    for (let n = hit; n && n.nodeType === 1 && n !== root; n = n.parentElement) {
      const p = getComputedStyle(n).position;
      if (p === 'fixed' || p === 'sticky') { const d = n.getBoundingClientRect().bottom - r.top + 8; if (d > 0) window.scrollBy({ top: -d, left: 0, behavior: 'instant' }); return; }
    }
  }
  // フォーカスして caret を置く。欄が画面の端で切れている時は、ここ (i / Ctrl-J を押した時) で画面に入れる。
  // 入れないと、最初の 1 文字を打った時にブラウザが caret を見せようとしてページを動かす (打った j / k でスクロールしたように見える)
  function focusInput(el) {
    el.focus({ preventScroll: true });
    const h = viewH(), r = el.getBoundingClientRect();
    const tall = r.height > h; // 画面より背の高い欄 (コードのエディタなど): 上端を見せ、caret も先頭に置く。それ以外は画面の中ほどへ (打って欄が伸びても端に当たらない)
    if (r.top < 0 || r.bottom > h) {
      try { el.scrollIntoView({ block: tall ? 'start' : 'center', inline: 'nearest', behavior: 'instant' }); } catch (e) { el.scrollIntoView(tall); }
      if (tall && !inFixed(el)) uncover(el);
    }
    const at = (len) => (tall ? 0 : len);
    if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
      try { el.setSelectionRange(at(el.value.length), at(el.value.length)); } catch (e) { /* number 等は不可 */ }
    } else if (el.isContentEditable) {
      const sel = window.getSelection(), rg = document.createRange();
      rg.selectNodeContents(el); rg.collapse(tall); sel.removeAllRanges(); sel.addRange(rg);
    }
    setMode(isEditable(document.activeElement) ? 'INSERT' : 'NORMAL');
  }
  function hideRing() { if (ring) { clearTimeout(ringTimer); ring.hidden = true; ringFor = null; } }
  function leaveInsert() {
    hideRing();
    const a = document.activeElement;
    if (a && a !== document.body && typeof a.blur === 'function') a.blur();
    setMode('NORMAL');
  }

  // ------------------------------------------------------------ キー
  function keyName(e) { // 'j' 'C-n' 'M-x' 'A-x' 'Escape'
    let k = e.key;
    if (k.length === 1 && (e.ctrlKey || e.metaKey || e.altKey)) k = k.toLowerCase();
    return (e.ctrlKey ? 'C-' : '') + (e.metaKey ? 'D-' : '') + (e.altKey ? 'A-' : '') + k;
  }
  function binding(k) {
    if (Object.prototype.hasOwnProperty.call(custom, k)) return custom[k];
    const v = Object.prototype.hasOwnProperty.call(cfg.keys, k) ? cfg.keys[k] : DEFAULT_KEYS[k];
    if (v == null || v === false) return null;
    if (typeof v === 'function') return { run: v, label: '' };
    return ACTIONS[v] || null;
  }
  function onKey(e) {
    if (!enabled || e.isComposing || e.keyCode === 229) return;
    if (e.defaultPrevented) return;
    const k = keyName(e);
    const helpOpen = helpEl && !helpEl.hidden;
    if (helpOpen) {
      if (k === '?' || k === cfg.exitKey || k === 'Escape') { e.preventDefault(); help(false); }
      return;
    }
    const a = document.activeElement;
    if (isEditable(a)) {
      if (mode !== 'INSERT') setMode('INSERT');
      if (k === cfg.exitKey) { e.preventDefault(); e.stopPropagation(); leaveInsert(); return; }
      const bi = binding(k);
      if (bi && bi.both && bi.run(e) !== false) { e.preventDefault(); e.stopPropagation(); return; }
      hideRing(); // 打ち始めたら移った先の枠は要らない (欄の中身が変わって位置もずれる)
      return; // INSERT では他のキーは全部ページ (入力欄) のもの
    }
    if (mode !== 'NORMAL') setMode('NORMAL');
    if (e.target && e.target.closest && e.target.closest('[data-nvim-nav-ignore]')) return;
    const b = binding(k); // 修飾キー付きは割り当てたもの (既定は C-j / C-k) だけ。Cmd-F などはブラウザのまま
    if (!b) return;
    if (b.run(e) === false) return;
    e.preventDefault();
  }

  // ------------------------------------------------------------ モード
  function setMode(m) {
    if (m === mode && root.getAttribute('data-nvim-mode') === m) return;
    mode = m;
    root.setAttribute('data-nvim-mode', m);
    if (bar) {
      bar.dataset.mode = m;
      bar.querySelector('.nvn-mode').textContent = m;
      bar.querySelector('.nvn-hint').textContent = m === 'INSERT' ? 'Ctrl-N で抜ける' : '? キー一覧';
    }
    document.dispatchEvent(new CustomEvent('nvimnav:mode', { detail: { mode: m } }));
  }
  function syncFocus() { setMode(isEditable(document.activeElement) ? 'INSERT' : 'NORMAL'); }
  function flash(text, ms) {
    if (!bar) return;
    const m = bar.querySelector('.nvn-msg');
    m.textContent = text; m.hidden = false;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { m.hidden = true; }, ms || 1600);
  }

  // ------------------------------------------------------------ 画面
  const CSS = `
:root{--nvn-bg:#eef0f4;--nvn-fg:#2a2f3a;--nvn-sub:#5b6372;--nvn-line:rgba(20,24,32,.14);--nvn-normal:#3b6fd4;--nvn-insert:#2f8a4c;--nvn-on:#fff;--nvn-panel:#ffffff;--nvn-kbd:#eef0f4;--nvn-shadow:0 6px 24px rgba(20,24,32,.18)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--nvn-bg:#1f232b;--nvn-fg:#d7dbe3;--nvn-sub:#9aa3b2;--nvn-line:rgba(255,255,255,.12);--nvn-normal:#7aa2f7;--nvn-insert:#9ece6a;--nvn-on:#14161b;--nvn-panel:#1a1d24;--nvn-kbd:#2a2f3a;--nvn-shadow:0 6px 24px rgba(0,0,0,.5)}}
:root[data-theme="dark"]{--nvn-bg:#1f232b;--nvn-fg:#d7dbe3;--nvn-sub:#9aa3b2;--nvn-line:rgba(255,255,255,.12);--nvn-normal:#7aa2f7;--nvn-insert:#9ece6a;--nvn-on:#14161b;--nvn-panel:#1a1d24;--nvn-kbd:#2a2f3a;--nvn-shadow:0 6px 24px rgba(0,0,0,.5)}
.nvn-ui,.nvn-ui *{box-sizing:border-box}
.nvn-bar{position:fixed;left:var(--nvn-left,12px);bottom:var(--nvn-bottom,12px);z-index:2147483000;display:flex;align-items:stretch;height:24px;border-radius:6px;overflow:hidden;font:600 12px/24px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--nvn-bg);color:var(--nvn-sub);border:1px solid var(--nvn-line);box-shadow:0 1px 4px rgba(0,0,0,.12);cursor:pointer;user-select:none;-webkit-user-select:none}
.nvn-bar[hidden]{display:none}
.nvn-mode{padding:0 10px;background:var(--nvn-normal);color:var(--nvn-on);letter-spacing:.04em}
.nvn-bar[data-mode="INSERT"] .nvn-mode{background:var(--nvn-insert)}
.nvn-hint,.nvn-msg{padding:0 10px;font-weight:500;white-space:nowrap}
.nvn-msg{color:var(--nvn-fg);border-left:1px solid var(--nvn-line)}
.nvn-msg[hidden]{display:none}
.nvn-ring{position:fixed;z-index:2147482999;pointer-events:none;border:2px solid var(--nvn-insert);border-radius:6px;box-shadow:0 0 0 3px color-mix(in srgb,var(--nvn-insert) 25%,transparent)}
.nvn-ring[hidden]{display:none}
.nvn-help{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(10,12,16,.35)}
.nvn-help[hidden]{display:none}
.nvn-card{width:min(440px,100%);max-height:calc(100vh - 32px);overflow:auto;background:var(--nvn-panel);color:var(--nvn-fg);border:1px solid var(--nvn-line);border-radius:10px;box-shadow:var(--nvn-shadow);padding:16px 18px;font:14px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
.nvn-card h2{margin:0 0 4px;font-size:15px}
.nvn-card h3{margin:14px 0 4px;font-size:12px;color:var(--nvn-sub);font-weight:600}
.nvn-card table{width:100%;border-collapse:collapse}
.nvn-card td{padding:4px 0;border-top:1px solid var(--nvn-line);vertical-align:top}
.nvn-card td:first-child{width:112px;white-space:nowrap}
.nvn-card kbd{display:inline-block;min-width:22px;padding:0 6px;margin-right:2px;border:1px solid var(--nvn-line);border-radius:4px;background:var(--nvn-kbd);font:12px/20px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:center}
.nvn-card p{margin:12px 0 0;font-size:12px;color:var(--nvn-sub)}
@media (max-width:480px){.nvn-bar{left:var(--nvn-left,8px);bottom:var(--nvn-bottom,8px);height:20px;font-size:10px;line-height:20px}.nvn-mode{padding:0 7px}.nvn-hint{display:none}.nvn-msg{padding:0 7px}}
@media print{.nvn-ui{display:none!important}}`;

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  // 'C-j' → 'Ctrl-J'、'A-x' → 'Alt-X'、'D-x' → 'Cmd-X'
  function keyLabel(k) {
    const m = /^((?:[CDA]-)+)(.+)$/.exec(k);
    if (!m || k.length < 3) return k;
    const mods = m[1].split('-').filter(Boolean).map((c) => ({ C: 'Ctrl', D: 'Cmd', A: 'Alt' })[c]);
    return mods.join('-') + '-' + (m[2].length === 1 ? m[2].toUpperCase() : m[2]);
  }
  function renderHelp() {
    const keys = Object.assign({}, DEFAULT_KEYS, cfg.keys);
    const rows = [], both = [];
    for (const k of Object.keys(keys)) {
      if (custom[k]) continue;
      const b = binding(k);
      if (b) (b.both ? both : rows).push([k, b.label || '(ページ独自)']);
    }
    for (const k of Object.keys(custom)) rows.push([k, custom[k].label || '(ページ独自)']);
    const exLabel = keyLabel(cfg.exitKey);
    const tr = ([k, l]) => `<tr><td><kbd>${esc(keyLabel(k))}</kbd></td><td>${esc(l)}</td></tr>`;
    helpEl.querySelector('.nvn-card').innerHTML =
      `<h2 id="nvn-help-title">キー操作</h2>` +
      `<h3>NORMAL (入力欄の外)</h3><table>${rows.map(tr).join('')}</table>` +
      `<h3>INSERT (入力欄の中)</h3><table><tr><td><kbd>${esc(exLabel)}</kbd></td><td>入力欄から抜けて NORMAL へ</td></tr><tr><td>そのほか</td><td>ふつうに入力欄へ (Ctrl-C も含む)</td></tr></table>` +
      (both.length ? `<h3>どちらのモードでも (NORMAL で押すと INSERT に入る)</h3><table>${both.map(tr).join('')}</table>` : '') +
      `<p>入力欄をクリックすると INSERT、外をクリックすると NORMAL。ここに無い Cmd / Ctrl / Alt 付きのキーはブラウザのまま。閉じる: <kbd>?</kbd> <kbd>${esc(exLabel)}</kbd> <kbd>Esc</kbd></p>`;
  }
  function help(show) {
    ensureUI();
    const open = show === undefined ? helpEl.hidden : !!show;
    if (open) { renderHelp(); helpEl.hidden = false; }
    else helpEl.hidden = true;
    return api;
  }
  function ensureUI() {
    if (!document.getElementById('nvim-nav-style')) {
      const st = document.createElement('style');
      st.id = 'nvim-nav-style';
      st.textContent = CSS;
      (document.head || root).appendChild(st);
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'nvn-ui nvn-bar';
      bar.setAttribute('role', 'status');
      bar.setAttribute('aria-live', 'polite');
      bar.title = 'キー一覧 (?)';
      bar.innerHTML = '<span class="nvn-mode">NORMAL</span><span class="nvn-hint">? キー一覧</span><span class="nvn-msg" hidden></span>';
      bar.dataset.mode = mode;
      bar.hidden = !enabled || cfg.statusline === false;
      bar.addEventListener('mousedown', (e) => e.preventDefault()); // 押してもフォーカスを奪わない
      bar.addEventListener('click', () => help());
      document.body.appendChild(bar);
    }
    if (!helpEl) {
      helpEl = document.createElement('div');
      helpEl.className = 'nvn-ui nvn-help';
      helpEl.hidden = true;
      helpEl.setAttribute('role', 'dialog');
      helpEl.setAttribute('aria-modal', 'true');
      helpEl.setAttribute('aria-labelledby', 'nvn-help-title');
      helpEl.innerHTML = '<div class="nvn-card"></div>';
      helpEl.addEventListener('click', (e) => { if (e.target === helpEl) help(false); });
      document.body.appendChild(helpEl);
    }
    if (!ring) {
      ring = document.createElement('div');
      ring.className = 'nvn-ui nvn-ring';
      ring.hidden = true;
      ring.setAttribute('aria-hidden', 'true');
      document.body.appendChild(ring);
    }
  }

  // ------------------------------------------------------------ 公開
  const api = {
    version: '0.2.0',
    get mode() { return mode; },
    get enabled() { return enabled; },
    configure,
    enable() { enabled = true; if (bar) bar.hidden = cfg.statusline === false; syncFocus(); return api; },
    disable() { enabled = false; if (bar) bar.hidden = true; if (helpEl) helpEl.hidden = true; return api; },
    map(key, fn, label) { custom[key] = { run: fn, label: label || '' }; return api; },
    unmap(key) { delete custom[key]; cfg.keys[key] = null; return api; },
    help,
    _visibleInputs: visibleInputs,
    _insertTarget: insertTarget,
  };
  window.NvimNav = api;
  configure(window.NVIM_NAV_CONFIG);

  // bubble 段で受ける: ページ (入力欄・端末) のハンドラが先に動き、preventDefault したキーは扱わない
  window.addEventListener('keydown', onKey);
  document.addEventListener('focusin', () => { if (enabled) syncFocus(); if (ringFor && document.activeElement !== ringFor) hideRing(); });
  document.addEventListener('focusout', () => { if (enabled) setTimeout(() => { syncFocus(); if (ringFor && document.activeElement !== ringFor) hideRing(); }, 0); });
  // 入力欄の外をクリックした時: ブラウザはふつうフォーカスを外すが、外さない要素 (tabindex の箱など) もあるので見直す
  document.addEventListener('mousedown', () => { if (enabled) setTimeout(syncFocus, 0); }, true);
  // 移った先の枠は画面に固定で重ねているので、スクロールしたら付いていく
  window.addEventListener('scroll', placeRing, { capture: true, passive: true });

  function init() { ensureUI(); syncFocus(); }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
