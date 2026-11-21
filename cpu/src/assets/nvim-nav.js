/*! nvim-nav.js v0.3.0 — Neovim 風のキーボード操作 (NORMAL / INSERT) を静的ページに足す部品。
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
 *           Space f 目次検索: このページの目次 (サイドバーのリンク) と見出しを絞り込んで飛ぶ (Space の後 1 秒以内に f)。
 *                   開いている間は Ctrl-J / Ctrl-K で候補を移る、Enter で飛ぶ、Esc / Ctrl-N で閉じる。
 *                   NORMAL の Space 単体 (ページのスクロール) は止める。Space の後に f 以外が来たら何もしない
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
 *     finder     Space f の候補の取り方 { links: CSS, headings: CSS, exclude: CSS }。links はリンクを探す箱
 *                (既定: nav / aside / .side / .sidebar / .toc / [role=navigation] の中の a[href]。article の中の箱は除く)、
 *                headings は見出し (既定 h1, h2, h3)、exclude は候補から外す要素。'' で その種類を出さない
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
 *   .find(show?)             目次検索の開閉
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
    find: { label: '目次検索: このページの目次と見出しを絞り込んで飛ぶ', run: () => find(true) },
    // both: INSERT 中でも効く
    nextInput: { label: '次の入力欄へ (画面内、端で折り返す)', both: true, run: () => moveInput(1) },
    prevInput: { label: '前の入力欄へ (画面内、端で折り返す)', both: true, run: () => moveInput(-1) },
  };
  const DEFAULT_KEYS = { j: 'down', k: 'up', '}': 'halfDown', '{': 'halfUp', i: 'insert', '?': 'help', 'Space f': 'find', 'C-j': 'nextInput', 'C-k': 'prevInput' };
  const LEADER = 'Space', LEADER_MS = 1000;
  const FINDER_LINKS = 'nav, aside, .side, .sidebar, .toc, [role=navigation]';
  const FINDER_HEADINGS = 'h1, h2, h3';
  // Space をブラウザのまま押させる要素 (ボタンを押す・チェックを切り替える)
  const NATIVE_SPACE = 'button, summary, select, input, [role=button], [role=checkbox], [role=switch], [role=radio], [role=tab], [role=menuitem], [role=option]';
  const BASE_INPUTS = [
    'input:not([type])',
    'input[type=text]', 'input[type=search]', 'input[type=email]', 'input[type=url]', 'input[type=tel]',
    'input[type=password]', 'input[type=number]', 'input[type=date]', 'input[type=datetime-local]',
    'input[type=month]', 'input[type=week]', 'input[type=time]',
    'textarea', 'select', '[contenteditable]:not([contenteditable=false])',
  ];

  const cfg = { step: 60, half: 0.5, exitKey: 'C-n', keys: {}, inputs: '', scroller: null, statusline: true, finder: {} };
  const custom = {}; // map() で足したもの: key -> { run, label }
  let enabled = true;
  let mode = 'NORMAL';
  let bar = null, helpEl = null, ring = null, ringFor = null, msgTimer = 0, ringTimer = 0;
  let leader = false, leaderTimer = 0; // Space を押して次のキーを待っている間
  let findEl = null, findItems = [], findShown = [], findSel = 0;

  function configure(o) {
    if (!o) return api;
    for (const k of Object.keys(o)) {
      if (k === 'keys') Object.assign(cfg.keys, o.keys);
      else if (k === 'finder') Object.assign(cfg.finder, o.finder);
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
    let k = e.key === ' ' ? 'Space' : e.key;
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
    if (findEl && !findEl.hidden) { // 目次検索の画面: キーは画面の入力欄が受ける (onFindKey)。外にフォーカスが出た時だけここで閉じる
      if (k === 'Escape' || k === cfg.exitKey) { e.preventDefault(); find(false); }
      return;
    }
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
    if (leader) { // Space の次のキー: 割り当てがあれば動かし、無ければ何もしない (どちらもページには渡さない)
      if (/^(Shift|Control|Alt|Meta|CapsLock)$/.test(e.key)) return;
      endLeader();
      e.preventDefault();
      const lb = binding(LEADER + ' ' + k);
      if (lb) lb.run(e);
      return;
    }
    if (k === LEADER && !e.shiftKey && hasLeader() && !(a && a !== document.body && a.matches && a.matches(NATIVE_SPACE))) {
      e.preventDefault(); // Space 単体のページスクロールは止める
      leader = true;
      clearTimeout(leaderTimer);
      leaderTimer = setTimeout(endLeader, LEADER_MS);
      flash('Space …', LEADER_MS);
      return;
    }
    const b = binding(k); // 修飾キー付きは割り当てたもの (既定は C-j / C-k) だけ。Cmd-F などはブラウザのまま
    if (!b) return;
    if (b.run(e) === false) return;
    e.preventDefault();
  }

  function endLeader() {
    leader = false; clearTimeout(leaderTimer);
    if (bar && bar.querySelector('.nvn-msg').textContent === 'Space …') { clearTimeout(msgTimer); bar.querySelector('.nvn-msg').hidden = true; }
  }
  function hasLeader() {
    const p = LEADER + ' ';
    const keys = Object.keys(DEFAULT_KEYS).concat(Object.keys(cfg.keys), Object.keys(custom));
    return keys.some((k) => k.startsWith(p) && binding(k));
  }

  // ------------------------------------------------------------ 目次検索 (Space f)
  // 候補 = サイドバーらしき箱のリンク (他のページへのリンクも) + このページの見出し。
  // 絞り込みは日本語の部分一致 (空白で区切ると AND、全角半角・大小・カタカナとひらがなを同一視)。
  // 部分一致が 1 つも無い時だけ、文字が順に現れる物 (fuzzy) を出す。変換中は確定まで絞り込まない。
  const fsel = (k, d) => (cfg.finder && cfg.finder[k] != null ? cfg.finder[k] : d);
  function norm(s) {
    return String(s).normalize('NFKC').toLowerCase().replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }
  // 要素の文字 (ボタン・アイコン・aria-hidden は除く)。子要素の境目は空白にする (「3」「基本の概念」→「3 基本の概念」)
  function textOf(el) {
    const parts = [];
    const walk = (n) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) parts.push(c.nodeValue);
        else if (c.nodeType === 1) {
          if (c.matches('button, svg, script, style, [aria-hidden="true"], .nvn-ui')) continue;
          parts.push(' '); walk(c); parts.push(' ');
        }
      }
    };
    walk(el);
    return parts.join('').replace(/\s+/g, ' ').trim();
  }
  const safeMatches = (el, sel) => { try { return el.matches(sel); } catch (e) { return false; } };
  const pageUrl = (u) => String(u).split('#')[0];
  function samePageTarget(a) {
    if (pageUrl(a.href) !== pageUrl(location.href)) return null;
    const h = a.hash ? decodeURIComponent(a.hash.slice(1)) : '';
    return h ? document.getElementById(h) : null;
  }
  function excluded(el) {
    if (el.closest('.nvn-ui')) return true;
    const ex = fsel('exclude', '');
    try { return !!(ex && el.closest(ex)); } catch (e) { return false; }
  }
  // リンクの階層: 箱の中で、自分より前にある「親の見出し」(外側の箱の最初のリンク・summary・見出し) を拾う。
  // 兄弟 (同じ種類の子 = li と li) の最初のリンクは親ではない
  function linkPath(a, box) {
    const path = [];
    let child = a;
    for (let n = a.parentElement; n && n !== box.parentElement && path.length < 3; child = n, n = n.parentElement) {
      const f = n.querySelector(':scope > a[href], :scope > summary, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > * > a[href]');
      if (!f || f === a || f.contains(a) || !(f.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      let fb = f; while (fb.parentElement !== n) fb = fb.parentElement;
      if (fb === child || fb.tagName === child.tagName) continue;
      const t = textOf(f);
      if (t) path.unshift(t);
    }
    return path;
  }
  function collect() {
    const items = [], seen = new Set(), targeted = new Set();
    const boxSel = fsel('links', FINDER_LINKS), hSel = fsel('headings', FINDER_HEADINGS);
    if (boxSel) {
      let boxes = [];
      try { boxes = [...document.querySelectorAll(boxSel)]; } catch (e) { boxes = []; }
      // 箱の中の箱は外側に任せる。本文 (article) の中の箱 (コールアウト・前後の章へのリンク) は除く (links を指定した時は除かない)
      boxes = boxes.filter((b) => !boxes.some((o) => o !== b && o.contains(b)) && (cfg.finder.links != null || !b.closest('article')));
      for (const box of boxes) {
        for (const a of box.querySelectorAll('a[href]')) {
          if (excluded(a)) continue;
          const href = a.href;
          if (!href || /^(javascript|mailto|tel):/i.test(href) || seen.has(href)) continue;
          const label = textOf(a);
          if (!label) continue;
          seen.add(href);
          const target = samePageTarget(a);
          if (target) targeted.add(target);
          if (target && hSel && !safeMatches(target, hSel)) { // #section を指すリンク: その箱の最初の見出しも同じ飛び先とみなす
            let fh = null; try { fh = target.querySelector(hSel); } catch (e) { /* 不正なセレクタ */ }
            if (fh) targeted.add(fh);
          }
          const current = !target && pageUrl(href) === pageUrl(location.href);
          items.push({ kind: '目次', label, path: linkPath(a, box), el: a, target, other: !target && pageUrl(href) !== pageUrl(location.href), current: current || a.getAttribute('aria-current') === 'page' || a.classList.contains('is-active') });
        }
      }
    }
    if (hSel) {
      let hs = [];
      try { hs = [...document.querySelectorAll(hSel)]; } catch (e) { hs = []; }
      const stack = []; // [level, label]
      for (const h of hs) {
        // 表示されていない見出し (閉じた details の中・display none など) は飛べないので出さない
        if (excluded(h) || !h.getClientRects().length || (h.checkVisibility && !h.checkVisibility({ visibilityProperty: true })) || h.closest('details:not([open]) > :not(summary)')) continue;
        const label = textOf(h);
        if (!label) continue;
        const lv = /^H[1-6]$/.test(h.tagName) ? +h.tagName[1] : 4;
        while (stack.length && stack[stack.length - 1][0] >= lv) stack.pop();
        const path = stack.map((x) => x[1]);
        stack.push([lv, label]);
        if (targeted.has(h)) { // 目次のリンクが同じ見出し (または見出しを含む箱) を指していれば、見出しの方は出さない (階層だけ目次に足りなければ足す)
          const it = items.find((x) => x.target === h || (x.target && x.target.contains(h)));
          if (it && !it.path.length && path.length) it.path = path.slice(-2);
          continue;
        }
        items.push({ kind: '見出し', label, path: path.slice(-2), el: h, target: h, other: false, current: false });
      }
    }
    for (const it of items) { it.n = norm(it.label); it.np = norm(it.path.join(' ')); }
    return items;
  }
  // 開いた時に選んでおく候補: 画面の上の方に見えている (または通り過ぎた) 一番下の見出し → 今のページのリンク → 先頭
  function nearIndex(list) {
    const line = Math.min(viewH() * 0.3, 160);
    let best = null, bestTop = -Infinity;
    for (const it of list) {
      if (!it.target || inFixed(it.target)) continue; // ヘッダーの中の見出しは常に上に見えているので数えない
      const t = it.target.getBoundingClientRect().top;
      if (t <= line && t > bestTop) { best = it; bestTop = t; }
    }
    if (best) return list.indexOf(best);
    const cur = list.findIndex((x) => x.current);
    return cur >= 0 ? cur : 0;
  }
  function match(q) {
    const terms = norm(q).split(/\s+/).filter(Boolean);
    if (!terms.length) return findItems.map((it) => ({ it, hits: [] }));
    const res = [];
    findItems.forEach((it, i) => {
      let score = 0; const hits = [];
      for (const t of terms) {
        const at = it.n.indexOf(t);
        if (at === 0) score += 0; else if (at > 0) score += 1; else if (it.np.includes(t)) score += 3; else return;
        if (at >= 0) hits.push([at, at + t.length]);
      }
      res.push({ it, hits, score: score * 1000 + i });
    });
    if (!res.length) { // fuzzy: 打った文字が見出しの中に順に現れる物 (間が詰まっているほど上)
      const qs = terms.join('');
      findItems.forEach((it, i) => {
        let p = -1, first = -1; const hits = [];
        for (const c of qs) { p = it.n.indexOf(c, p + 1); if (p < 0) return; if (first < 0) first = p; hits.push([p, p + 1]); }
        res.push({ it, hits, score: (p - first) * 1000 + i });
      });
    }
    return res.sort((a, b) => a.score - b.score);
  }
  function hl(label, hits) {
    if (!hits.length || norm(label).length !== label.length) return esc(label);
    const on = new Array(label.length).fill(false);
    for (const [a, b] of hits) for (let i = a; i < b; i++) on[i] = true;
    let out = '', open = false;
    for (let i = 0; i < label.length; i++) {
      if (on[i] !== open) { out += on[i] ? '<mark>' : '</mark>'; open = on[i]; }
      out += esc(label[i]);
    }
    return out + (open ? '</mark>' : '');
  }
  function renderFind(keepNear) {
    const inp = findEl.querySelector('.nvn-finput');
    const q = inp.value;
    findShown = match(q);
    findSel = keepNear && !q.trim() ? nearIndex(findShown.map((r) => r.it)) : 0;
    const ul = findEl.querySelector('.nvn-flist');
    ul.innerHTML = findShown.map((r, i) => {
      const it = r.it;
      const path = it.path.length ? `<span class="nvn-fpath">${esc(it.path.join(' › '))}</span>` : '';
      const tag = it.other ? '<span class="nvn-ftag">別ページ</span>' : (it.current ? '<span class="nvn-ftag">このページ</span>' : '');
      return `<li class="nvn-fitem" role="option" id="nvn-f-${i}" data-i="${i}" aria-selected="false"><span class="nvn-fkind" data-kind="${it.kind === '目次' ? 'toc' : 'h'}">${it.kind}</span><span class="nvn-fmain"><span class="nvn-flabel">${hl(it.label, r.hits)}</span>${path}</span>${tag}</li>`;
    }).join('') || '<li class="nvn-fnone">一致する候補がありません</li>';
    findEl.querySelector('.nvn-fcount').textContent = `${findShown.length}/${findItems.length}`;
    select(findSel);
  }
  function select(i) {
    const n = findShown.length;
    if (!n) return;
    findSel = (i + n) % n;
    const ul = findEl.querySelector('.nvn-flist');
    ul.querySelectorAll('.nvn-fitem[aria-selected="true"]').forEach((li) => li.setAttribute('aria-selected', 'false'));
    const li = ul.querySelector(`[data-i="${findSel}"]`);
    if (li) {
      li.setAttribute('aria-selected', 'true');
      findEl.querySelector('.nvn-finput').setAttribute('aria-activedescendant', li.id);
      const lr = li.getBoundingClientRect(), ur = ul.getBoundingClientRect();
      if (lr.top < ur.top) ul.scrollTop -= ur.top - lr.top; else if (lr.bottom > ur.bottom) ul.scrollTop += lr.bottom - ur.bottom;
    }
  }
  function go(i) {
    const r = findShown[i];
    if (!r) return;
    const it = r.it;
    find(false);
    if (it.target) {
      it.target.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' }); // ページの scroll-margin-top が効く
      uncover(it.target); // それでも sticky / fixed のヘッダーに隠れていたら、その分戻す
      if (it.target.id && location.hash !== '#' + it.target.id) { try { history.pushState(null, '', '#' + encodeURIComponent(it.target.id)); } catch (e) { /* file:// の一部 */ } }
      showRing(it.target);
      flash(it.label.length > 24 ? it.label.slice(0, 23) + '…' : it.label, 1000);
    } else if (it.el && it.el.isConnected) it.el.click(); // ページのリンクの動き (target・クリックの処理) をそのまま使う
    else location.href = it.el.href;
  }
  function onFindKey(e) {
    if (e.isComposing || e.keyCode === 229) return; // 変換中の Enter などは IME のもの
    const k = keyName(e);
    let done = true;
    if (k === 'Escape' || k === cfg.exitKey) find(false);
    else if (k === 'C-j' || k === 'ArrowDown') select(findSel + 1);
    else if (k === 'C-k' || k === 'ArrowUp') select(findSel - 1);
    else if (k === 'Enter') go(findSel);
    else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  }
  function find(show) {
    ensureUI();
    const open = show === undefined ? findEl.hidden : !!show;
    if (open) {
      if (helpEl) helpEl.hidden = true;
      findItems = collect();
      const inp = findEl.querySelector('.nvn-finput');
      inp.value = '';
      findEl.hidden = false;
      renderFind(true);
      inp.focus({ preventScroll: true });
    } else if (!findEl.hidden) {
      findEl.hidden = true;
      const a = document.activeElement;
      if (a && findEl.contains(a)) a.blur();
      syncFocus();
    }
    return api;
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
.nvn-find{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 16px;background:rgba(10,12,16,.35)}
.nvn-find[hidden]{display:none}
.nvn-fcard{width:min(560px,100%);max-height:calc(100vh - 12vh - 16px);display:flex;flex-direction:column;background:var(--nvn-panel);color:var(--nvn-fg);border:1px solid var(--nvn-line);border-radius:10px;box-shadow:var(--nvn-shadow);font:14px/1.5 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;overflow:hidden}
.nvn-fhead{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--nvn-line)}
.nvn-fhead label{font-size:12px;font-weight:600;color:var(--nvn-sub);white-space:nowrap}
.nvn-finput{flex:1;min-width:0;font:inherit;font-size:15px;padding:6px 10px;color:var(--nvn-fg);background:var(--nvn-bg);border:1px solid var(--nvn-line);border-radius:6px;outline:none}
.nvn-finput:focus{border-color:var(--nvn-normal)}
.nvn-fcount{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--nvn-sub);white-space:nowrap}
.nvn-flist{list-style:none;margin:0;padding:4px;overflow:auto;flex:1;min-height:0}
.nvn-fitem{display:flex;align-items:baseline;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer}
.nvn-fitem[aria-selected="true"]{background:color-mix(in srgb,var(--nvn-normal) 16%,transparent);box-shadow:inset 3px 0 0 var(--nvn-normal)}
.nvn-fkind{flex:none;font-size:11px;line-height:18px;padding:0 6px;border-radius:4px;border:1px solid var(--nvn-line);color:var(--nvn-sub);background:var(--nvn-kbd)}
.nvn-fkind[data-kind="h"]{color:var(--nvn-insert)}
.nvn-fmain{flex:1;min-width:0;display:flex;flex-direction:column}
.nvn-flabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nvn-flabel mark{background:none;color:var(--nvn-normal);font-weight:700}
.nvn-fpath{font-size:12px;color:var(--nvn-sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nvn-ftag{flex:none;font-size:11px;color:var(--nvn-sub)}
.nvn-fnone{padding:12px;color:var(--nvn-sub);font-size:13px}
.nvn-ffoot{padding:6px 12px;border-top:1px solid var(--nvn-line);font-size:12px;color:var(--nvn-sub)}
.nvn-ffoot kbd{display:inline-block;padding:0 5px;margin:0 2px;border:1px solid var(--nvn-line);border-radius:4px;background:var(--nvn-kbd);font:11px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (max-width:480px){.nvn-find{padding:8px}.nvn-fcard{max-height:calc(100vh - 16px)}.nvn-fhead label{display:none}.nvn-ffoot{display:none}}
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
    const kb = (k) => k.split(' ').map((x) => `<kbd>${esc(keyLabel(x))}</kbd>`).join('');
    const tr = ([k, l]) => `<tr><td>${kb(k)}</td><td>${esc(l)}</td></tr>`;
    helpEl.querySelector('.nvn-card').innerHTML =
      `<h2 id="nvn-help-title">キー操作</h2>` +
      `<h3>NORMAL (入力欄の外)</h3><table>${rows.map(tr).join('')}</table>` +
      `<h3>INSERT (入力欄の中)</h3><table><tr><td><kbd>${esc(exLabel)}</kbd></td><td>入力欄から抜けて NORMAL へ</td></tr><tr><td>そのほか</td><td>ふつうに入力欄へ (Ctrl-C も含む)</td></tr></table>` +
      (both.length ? `<h3>どちらのモードでも (NORMAL で押すと INSERT に入る)</h3><table>${both.map(tr).join('')}</table>` : '') +
      (binding('Space f') ? `<h3>目次検索 (Space f で開いた画面)</h3><table>${[['C-j', '次の候補へ'], ['C-k', '前の候補へ'], ['Enter', '飛ぶ (リンクは移動、見出しはスクロール)'], ['Esc', '閉じる (' + exLabel + ' でも)']].map(tr).join('')}</table>` : '') +
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
    if (!findEl) {
      findEl = document.createElement('div');
      findEl.className = 'nvn-ui nvn-find';
      findEl.hidden = true;
      findEl.setAttribute('role', 'dialog');
      findEl.setAttribute('aria-modal', 'true');
      findEl.setAttribute('aria-label', '目次検索');
      findEl.innerHTML = '<div class="nvn-fcard"><div class="nvn-fhead"><label for="nvn-finput">目次検索</label>' +
        '<input id="nvn-finput" class="nvn-finput" type="text" autocomplete="off" spellcheck="false" placeholder="目次と見出しを絞り込む" role="combobox" aria-expanded="true" aria-controls="nvn-flist">' +
        '<span class="nvn-fcount"></span></div><ul class="nvn-flist" id="nvn-flist" role="listbox"></ul>' +
        '<div class="nvn-ffoot"><kbd>Ctrl-J</kbd><kbd>Ctrl-K</kbd> 移る　<kbd>Enter</kbd> 飛ぶ　<kbd>Esc</kbd> 閉じる</div></div>';
      const inp = findEl.querySelector('.nvn-finput');
      inp.addEventListener('keydown', onFindKey);
      inp.addEventListener('input', (e) => { if (!e.isComposing) renderFind(false); });
      inp.addEventListener('compositionend', () => renderFind(false));
      const ul = findEl.querySelector('.nvn-flist');
      ul.addEventListener('mousedown', (e) => e.preventDefault()); // 入力欄のフォーカスを保つ
      ul.addEventListener('click', (e) => { const li = e.target.closest('.nvn-fitem'); if (li) go(+li.dataset.i); });
      ul.addEventListener('mousemove', (e) => { const li = e.target.closest('.nvn-fitem'); if (li && +li.dataset.i !== findSel) select(+li.dataset.i); });
      findEl.addEventListener('click', (e) => { if (e.target === findEl) find(false); });
      document.body.appendChild(findEl);
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
    version: '0.3.0',
    get mode() { return mode; },
    get enabled() { return enabled; },
    configure,
    enable() { enabled = true; if (bar) bar.hidden = cfg.statusline === false; syncFocus(); return api; },
    disable() { enabled = false; endLeader(); if (bar) bar.hidden = true; if (helpEl) helpEl.hidden = true; if (findEl) find(false); return api; },
    map(key, fn, label) { custom[key] = { run: fn, label: label || '' }; return api; },
    unmap(key) { delete custom[key]; cfg.keys[key] = null; return api; },
    help,
    find,
    _finderItems: () => collect().map((it) => ({ kind: it.kind, label: it.label, path: it.path, other: it.other, current: it.current, id: it.target ? it.target.id : '', top: it.target && !inFixed(it.target) ? it.target.getBoundingClientRect().top : null })),
    _visibleInputs: visibleInputs,
    _insertTarget: insertTarget,
  };
  window.NvimNav = api;
  configure(window.NVIM_NAV_CONFIG);

  // bubble 段で受ける: ページ (入力欄・端末) のハンドラが先に動き、preventDefault したキーは扱わない
  window.addEventListener('keydown', onKey);
  // 入力欄の枠はフォーカスが外れたら消す (目次検索で飛んだ見出しの枠は 1 秒で消えるのに任せる)
  const ringOff = () => ringFor && isEditable(ringFor) && document.activeElement !== ringFor;
  document.addEventListener('focusin', () => { if (enabled) syncFocus(); if (ringOff()) hideRing(); });
  document.addEventListener('focusout', () => { if (enabled) setTimeout(() => { syncFocus(); if (ringOff()) hideRing(); }, 0); });
  // 入力欄の外をクリックした時: ブラウザはふつうフォーカスを外すが、外さない要素 (tabindex の箱など) もあるので見直す
  document.addEventListener('mousedown', () => { if (enabled) setTimeout(syncFocus, 0); }, true);
  // 移った先の枠は画面に固定で重ねているので、スクロールしたら付いていく
  window.addEventListener('scroll', placeRing, { capture: true, passive: true });

  function init() { ensureUI(); syncFocus(); }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
