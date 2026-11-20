/*! nvim-nav.js v0.1.0 — Neovim 風のキーボード操作 (NORMAL / INSERT) を静的ページに足す部品。
 * 依存なし・外部読み込みなし・file:// で動く。CSS はこのファイルに同梱 (<style id="nvim-nav-style"> を 1 回だけ入れる)。
 *
 * 入れ方:  <script src="nvim-nav.js" defer></script>   (body の最後でもよい。2 回読んでも 1 回しか動かない)
 *
 * キー (NORMAL = 入力欄の外 / INSERT = 入力欄の中)
 *   NORMAL  j / k   少し下 / 上にスクロール (step px、既定 60)
 *           } / {   半画面下 / 上 (half、既定 0.5 画面)
 *           i       画面に見えている一番上の入力欄に入る (INSERT へ)
 *           ?       キー一覧を開く / 閉じる (開いている間は ? / Ctrl-N / Esc で閉じる)
 *   INSERT  Ctrl-N  入力欄から抜けて NORMAL へ。それ以外のキーは全部ふつうに入力欄へ (Ctrl-C も奪わない)
 *   - Cmd / Ctrl / Alt 付きのキーは NORMAL では一切扱わない (ブラウザの操作を邪魔しない)
 *   - 日本語入力の変換中 (isComposing / keyCode 229) のキーは扱わない
 *   - ページ側が先に preventDefault したキーは扱わない (ページの j / k が勝つ)
 *
 * ページ側の設定 (どれも任意)
 *   読み込む前に window.NVIM_NAV_CONFIG = { step: 80, half: 0.5, keys: { j: null }, ... } を置く
 *   読み込んだ後は NvimNav.configure({...})
 *     step       j / k の量 (px)                       既定 60
 *     half       } / { の量 (画面の高さに対する比)        既定 0.5
 *     exitKey    INSERT を抜けるキー ('C-n' の形)         既定 'C-n'
 *     keys       { キー: 動作名 | 関数 | null }  null で無効。動作名: down up halfDown halfUp insert help
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
    insert: { label: '画面内の一番上の入力欄に入る', run: () => enterInsert() },
    help: { label: 'キー一覧 (もう一度 ? で閉じる)', run: () => help() },
  };
  const DEFAULT_KEYS = { j: 'down', k: 'up', '}': 'halfDown', '{': 'halfUp', i: 'insert', '?': 'help' };
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
  let bar = null, helpEl = null, msgTimer = 0;

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
      out.push({ el, top: r.top, left: r.left });
    }
    out.sort((a, b) => a.top - b.top || a.left - b.left);
    return out.map((o) => o.el);
  }
  function enterInsert() {
    const el = visibleInputs()[0];
    if (!el) { flash('画面内に入力欄がありません'); return; }
    if (bar) { clearTimeout(msgTimer); bar.querySelector('.nvn-msg').hidden = true; }
    el.focus({ preventScroll: true });
    if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
      try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* number 等は不可 */ }
    } else if (el.isContentEditable) {
      const sel = window.getSelection(), rg = document.createRange();
      rg.selectNodeContents(el); rg.collapse(false); sel.removeAllRanges(); sel.addRange(rg);
    }
    setMode(isEditable(document.activeElement) ? 'INSERT' : 'NORMAL');
  }
  function leaveInsert() {
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
      if (k === cfg.exitKey) { e.preventDefault(); e.stopPropagation(); leaveInsert(); }
      return; // INSERT では他のキーは全部ページ (入力欄) のもの
    }
    if (mode !== 'NORMAL') setMode('NORMAL');
    if (e.ctrlKey || e.metaKey || e.altKey) return; // ブラウザの操作
    if (e.target && e.target.closest && e.target.closest('[data-nvim-nav-ignore]')) return;
    const b = binding(k);
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
  function flash(text) {
    if (!bar) return;
    const m = bar.querySelector('.nvn-msg');
    m.textContent = text; m.hidden = false;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { m.hidden = true; }, 1600);
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
.nvn-help{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(10,12,16,.35)}
.nvn-help[hidden]{display:none}
.nvn-card{width:min(440px,100%);max-height:calc(100vh - 32px);overflow:auto;background:var(--nvn-panel);color:var(--nvn-fg);border:1px solid var(--nvn-line);border-radius:10px;box-shadow:var(--nvn-shadow);padding:16px 18px;font:14px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
.nvn-card h2{margin:0 0 4px;font-size:15px}
.nvn-card h3{margin:14px 0 4px;font-size:12px;color:var(--nvn-sub);font-weight:600}
.nvn-card table{width:100%;border-collapse:collapse}
.nvn-card td{padding:4px 0;border-top:1px solid var(--nvn-line);vertical-align:top}
.nvn-card td:first-child{width:96px;white-space:nowrap}
.nvn-card kbd{display:inline-block;min-width:22px;padding:0 6px;margin-right:2px;border:1px solid var(--nvn-line);border-radius:4px;background:var(--nvn-kbd);font:12px/20px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:center}
.nvn-card p{margin:12px 0 0;font-size:12px;color:var(--nvn-sub)}
@media (max-width:480px){.nvn-bar{left:var(--nvn-left,8px);bottom:var(--nvn-bottom,8px);height:20px;font-size:10px;line-height:20px}.nvn-mode{padding:0 7px}.nvn-hint{display:none}.nvn-msg{padding:0 7px}}
@media print{.nvn-ui{display:none!important}}`;

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function renderHelp() {
    const keys = Object.assign({}, DEFAULT_KEYS, cfg.keys);
    const rows = [];
    for (const k of Object.keys(keys)) {
      if (custom[k]) continue;
      const b = binding(k);
      if (b) rows.push([k, b.label || '(ページ独自)']);
    }
    for (const k of Object.keys(custom)) rows.push([k, custom[k].label || '(ページ独自)']);
    const ex = cfg.exitKey;
    const exLabel = /^C-./.test(ex) ? 'Ctrl-' + ex.slice(2).toUpperCase() : ex;
    helpEl.querySelector('.nvn-card').innerHTML =
      `<h2 id="nvn-help-title">キー操作</h2>` +
      `<h3>NORMAL (入力欄の外)</h3><table>${rows.map(([k, l]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(l)}</td></tr>`).join('')}</table>` +
      `<h3>INSERT (入力欄の中)</h3><table><tr><td><kbd>${esc(exLabel)}</kbd></td><td>入力欄から抜けて NORMAL へ</td></tr><tr><td>そのほか</td><td>ふつうに入力欄へ (Ctrl-C も含む)</td></tr></table>` +
      `<p>入力欄をクリックすると INSERT、外をクリックすると NORMAL。Cmd / Ctrl / Alt 付きのキーはブラウザのまま。閉じる: <kbd>?</kbd> <kbd>${esc(exLabel)}</kbd> <kbd>Esc</kbd></p>`;
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
  }

  // ------------------------------------------------------------ 公開
  const api = {
    version: '0.1.0',
    get mode() { return mode; },
    get enabled() { return enabled; },
    configure,
    enable() { enabled = true; if (bar) bar.hidden = cfg.statusline === false; syncFocus(); return api; },
    disable() { enabled = false; if (bar) bar.hidden = true; if (helpEl) helpEl.hidden = true; return api; },
    map(key, fn, label) { custom[key] = { run: fn, label: label || '' }; return api; },
    unmap(key) { delete custom[key]; cfg.keys[key] = null; return api; },
    help,
    _visibleInputs: visibleInputs,
  };
  window.NvimNav = api;
  configure(window.NVIM_NAV_CONFIG);

  // bubble 段で受ける: ページ (入力欄・端末) のハンドラが先に動き、preventDefault したキーは扱わない
  window.addEventListener('keydown', onKey);
  document.addEventListener('focusin', () => { if (enabled) syncFocus(); });
  document.addEventListener('focusout', () => { if (enabled) setTimeout(syncFocus, 0); });
  // 入力欄の外をクリックした時: ブラウザはふつうフォーカスを外すが、外さない要素 (tabindex の箱など) もあるので見直す
  document.addEventListener('mousedown', () => { if (enabled) setTimeout(syncFocus, 0); }, true);

  function init() { ensureUI(); syncFocus(); }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
