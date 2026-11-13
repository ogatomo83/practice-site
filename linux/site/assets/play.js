// 実験場（playground.html）：端末 + いつも開いている「システムを見る」。
// 機械は sys.start + h.step で少しずつ進める（出力を途中で出し、Ctrl-C や入力を受けつける）。全員が sleep 中なら、実時間に合わせて待つ。
// /home/you は IndexedDB に保存する（保存できなければ、黙ってメモリだけで動く）。
(() => {
  const LNX = window.LNX, GRADE = window.GRADE, UI = window.LNXUI, VIEW = window.LNXVIEW, HL = window.HL;
  const $ = (s, r = document) => r.querySelector(s);
  const term = $('#play-term');
  if (!term || !LNX || !UI || !VIEW) return;
  const { esc, store } = UI;
  const out = $('#play-out'), scroll = $('#play-scroll'), prEl = $('#play-pr'), input = $('#play-in'), saveEl = $('#play-save');
  const HOME = '/home/you';
  const LIMITS = { maxTicks: 1e9, maxTime: 1e12, maxOutput: 1e9 };
  const MAX_CHARS = 300000; // 画面に残す文字数

  let sys = GRADE.boot([]);
  let h = null;            // 実行中のコマンド
  let buf = '';            // 続きの行を待っているコマンド（if の途中など）
  let lastRun = null;
  let onIdle = [];         // コマンドが終わったら呼ぶ（サンプルを 1 行ずつ流すため）
  const hist = store.get('play-hist', []);
  let histPos = hist.length, histDraft = '';

  // ---------------------------------------------------------------- 画面
  let chars = 0;
  function print(html, n) {
    out.insertAdjacentHTML('beforeend', html);
    chars += n;
    while (chars > MAX_CHARS && out.firstChild) { chars -= (out.firstChild.textContent || '').length; out.removeChild(out.firstChild); }
    scroll.scrollTop = scroll.scrollHeight;
  }
  const printText = (t, cls) => { if (t) print(`<span${cls ? ` class="${cls}"` : ''}>${esc(t)}</span>`, t.length); };
  const printChunks = (cs) => cs.forEach((c) => printText(c.text, c.s === 'err' ? 'tm-e' : ''));
  const running = () => !!h && !h.done;
  const prompt = () => (running() ? '' : buf ? '> ' : sys.prompt());
  function sync() {
    prEl.textContent = prompt();
    term.classList.toggle('is-running', running());
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
    scroll.scrollTop = scroll.scrollHeight;
  }
  const echo = (line) => print(`<span class="tm-pr">${esc(prompt())}</span>${running() ? esc(line) : HL.highlightLines(line, 'sh').join('\n')}\n`, line.length + 1);

  const view = VIEW.mount($('#play-view'), { big: true, getSys: () => sys });

  // ---------------------------------------------------------------- 保存（IndexedDB）
  let db = null;
  const idb = () => new Promise((res) => {
    try {
      const rq = indexedDB.open('zl-play', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('fs');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = rq.onblocked = () => res(null);
    } catch (e) { res(null); }
    setTimeout(() => res(null), 1500);
  });
  const tx = (mode, fn) => new Promise((res) => {
    if (!db) return res(null);
    try { const t = db.transaction('fs', mode); const rq = fn(t.objectStore('fs')); t.oncomplete = () => res(rq.result); t.onerror = t.onabort = () => res(null); } catch (e) { res(null); }
  });
  let saved = '';
  function save() {
    if (!db) return;
    let data;
    try { data = sys.fs.export(HOME); } catch (e) { return; }
    const s = JSON.stringify(data);
    if (s === saved) return;
    saved = s;
    tx('readwrite', (st) => st.put(data, 'home')).then(() => { saveEl.textContent = `${HOME} を保存しました`; });
  }

  // ---------------------------------------------------------------- 実行
  function finish(r) {
    printChunks(h.take());   // 終わった後の take() は、最後の step で出た残りを返す
    if (out.lastChild && !/\n$/.test(out.lastChild.textContent || '')) print('\n', 1);
    if (r.cut) printText(r.message + '\n', 'tm-note');
    lastRun = { events: r.events || [], trace: r.trace || [] };
    h = null;
    sync();
    view.update(lastRun);
    save();
    const cbs = onIdle; onIdle = [];
    cbs.forEach((f) => f());
  }
  let timer = 0, lastT = 0, lastView = 0;
  function pump() {
    clearTimeout(timer);
    if (!running()) return;
    const now = performance.now();
    const end = now + 10;
    let r = null;
    // 全員が待っている（sleep 中）なら実時間の分だけ、そうでなければ 1 回に使える時間いっぱいまで進める
    let budget = h.sleeping ? Math.max(1, Math.min(250, Math.round(now - lastT))) : 50;
    lastT = now;
    for (;;) {
      try { r = h.step(budget); } catch (e) { printText(`\n実行できませんでした：${e.message || e}\n`, 'tm-note'); h = null; sync(); return; }
      printChunks(h.take());
      if (r || h.waiting || h.sleeping || performance.now() >= end) break;
      budget = 50;
    }
    if (r) return finish(r);
    if (now - lastView > 400) { lastView = now; view.update(); }
    if (h.waiting === 'input') { view.update(); return; } // 入力が来るまで待つ
    timer = setTimeout(pump, h.sleeping ? 30 : 0);
  }
  function start(cmd) {
    // システムコール（最大 4000 行）と、観察用のイベント（メモリ、スケジューラ、ページキャッシュ、ネットワーク）も記録する（「システムを見る」用）
    try { h = sys.start(cmd, Object.assign({ interactive: true, strace: true, trace: 'all' }, LIMITS)); } catch (e) { printText(`実行できませんでした：${e.message || e}\n`, 'tm-note'); h = null; }
    lastT = performance.now();
    sync();
    pump();
  }
  function submit(line) {
    if (running()) { // 実行中のコマンドへの入力
      print(esc(line) + '\n', line.length + 1);
      sys.input(line + '\n');
      pump();
      return;
    }
    echo(line);
    const cmd = buf ? buf + '\n' + line : line;
    if (line.trim() && hist[hist.length - 1] !== line) { hist.push(line); if (hist.length > 200) hist.shift(); store.set('play-hist', hist); }
    histPos = hist.length; histDraft = '';
    if (!cmd.trim()) { buf = ''; sync(); return; }
    const pr = LNX.sh.parse(cmd);
    if (pr.incomplete || /\\$/.test(line)) { buf = cmd; sync(); return; }
    buf = '';
    start(cmd);
  }

  // 何も実行していない間も、バックグラウンドのジョブがあれば時間を進める
  function idleTick() {
    if (running() || document.hidden) return;
    let bg = false;
    try { bg = sys.ps().some((p) => p.pid > 1 && !p.session && p.state !== 'Z' && p.state !== 'T'); } catch (e) { return; }
    if (!bg) return;
    // advance は、その間に端末へ出た分を返す（バックグラウンドのジョブの出力）
    let o = null;
    try { o = sys.advance(250); } catch (e) { return; }
    const me = sys.opts && sys.opts.user ? sys.opts.user : 'you';
    if (o && o.out) printChunks(o.out.filter((c) => c.text && (!c.user || c.user === me)));
    view.update();
  }
  setInterval(idleTick, 250);

  // ---------------------------------------------------------------- 入力
  function complete() {
    const pos = input.selectionStart, head = input.value.slice(0, pos), tail = input.value.slice(pos);
    let c;
    try { c = sys.complete(head); } catch (e) { return; }
    if (!c || !c.candidates.length) return;
    const put = (w) => { input.value = head.slice(0, c.start) + w + tail; const p = c.start + w.length; input.setSelectionRange(p, p); };
    if (c.candidates.length === 1) { const w = c.candidates[0]; put(w + (w.endsWith('/') ? '' : ' ')); return; }
    let pre = c.candidates[0];
    for (const w of c.candidates) { let i = 0; while (i < pre.length && pre[i] === w[i]) i++; pre = pre.slice(0, i); }
    if (pre.length > c.word.length) { put(pre); return; }
    // 候補がいくつもあるときは、bash と同じように一覧を出す
    print(`<span class="tm-pr">${esc(prompt())}</span>${esc(input.value)}\n`, input.value.length + 1);
    printText(c.candidates.slice(0, 120).join('  ') + (c.candidates.length > 120 ? '  …' : '') + '\n', 'tm-cand');
  }
  function key(k, ctrl) {
    if (ctrl && k === 'c') {
      if (running()) { printText('^C\n'); sys.interrupt('INT'); pump(); }
      else { echo(input.value + '^C'); input.value = ''; buf = ''; histPos = hist.length; }
      sync(); return true;
    }
    if (ctrl && k === 'z') { if (running()) { printText('^Z\n'); sys.interrupt('TSTP'); pump(); } return true; }
    if (ctrl && k === 'd') {
      if (running()) { if (input.value === '') { sys.eof(); pump(); } }
      else if (input.value === '') printText('（Ctrl-D は「入力の終わり」です。cat のように入力を待つコマンドを実行している間に押すと、そのコマンドに終わりが伝わります）\n', 'tm-note');
      return true;
    }
    if (ctrl && k === 'l') { out.innerHTML = ''; chars = 0; sync(); return true; }
    if (k === 'Enter') { const v = input.value; input.value = ''; v.split('\n').forEach((l, i, a) => { if (i === 0 || l !== '' || i < a.length - 1) submit(l); }); sync(); return true; }
    if (k === 'Tab') { if (!running()) complete(); sync(); return true; }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      if (running()) return true;
      if (histPos === hist.length) histDraft = input.value;
      histPos = Math.max(0, Math.min(hist.length, histPos + (k === 'ArrowUp' ? -1 : 1)));
      input.value = histPos === hist.length ? histDraft : hist[histPos];
      input.setSelectionRange(input.value.length, input.value.length);
      sync(); return true;
    }
    return false;
  }
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 日本語入力の変換中
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    const k = ctrl ? e.key.toLowerCase() : e.key;
    if (ctrl && k === 'c' && input.selectionStart !== input.selectionEnd) return; // 選択しているときは、ふつうのコピー
    if ((ctrl && 'czdl'.includes(k) && k.length === 1) || (!ctrl && !e.metaKey && !e.altKey && !e.shiftKey && ['Enter', 'Tab', 'ArrowUp', 'ArrowDown'].includes(k))) {
      if (key(k, ctrl)) e.preventDefault();
    }
  });
  input.addEventListener('input', sync);
  term.addEventListener('click', (e) => { if (!e.target.closest('button') && String(window.getSelection()) === '') input.focus({ preventScroll: true }); });
  term.querySelectorAll('.term-pad button').forEach((b) => b.addEventListener('click', () => { const k = b.dataset.k; key(k, k.length === 1); input.focus({ preventScroll: true }); }));

  // ---------------------------------------------------------------- サンプル、リセット
  const S = (window.LNX_SAMPLES || []).filter((s) => !s.when || s.when());
  const sel = $('#play-sample');
  sel.innerHTML = '<option value="">選ぶと、端末に 1 行ずつ打って実行します</option>' + S.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('');
  // lines を 1 行ずつ、前のコマンドが終わってから打つ
  function type(lines) {
    return new Promise((res) => {
      const q = lines.slice();
      const next = () => {
        if (running()) { onIdle.push(next); return; }
        if (!q.length) return res();
        submit(q.shift());
        sync();
        if (running()) onIdle.push(next); else setTimeout(next, 0);
      };
      next();
    });
  }
  sel.addEventListener('change', () => {
    const s = S.find((x) => x.id === sel.value);
    sel.value = '';
    if (!s || running()) return;
    buf = '';
    type(s.lines).then(() => input.focus({ preventScroll: true }));
  });
  const banner = () => printText('図解 Linux の小さな Linux（教育用のシミュレータ）です。help と打つと、使えるコマンドの一覧が出ます。\n\n', 'tm-note');
  function reset() {
    clearTimeout(timer);
    h = null; buf = ''; onIdle = []; lastRun = null;
    sys = GRADE.boot([]);
    out.innerHTML = ''; chars = 0; saved = '';
    tx('readwrite', (st) => st.delete('home'));
    saveEl.textContent = '';
    banner();
    sync();
    view.update(null);
  }
  $('#play-reset').addEventListener('click', reset);
  $('#play-clear').addEventListener('click', () => { key('l', true); input.focus({ preventScroll: true }); });

  // ---------------------------------------------------------------- 始める
  banner();
  sync();
  const ready = idb().then((d) => { db = d; return tx('readonly', (st) => st.get('home')); }).then((data) => {
    if (data && !running() && lastRun === null) {
      try { sys.fs.import(data); saved = JSON.stringify(data); saveEl.textContent = `前回の ${HOME} を読み込みました`; view.update(); } catch (e) {}
    }
  });
  window.PLAY = {
    get sys() { return sys; }, get running() { return running(); }, get handle() { return h; }, get lastRun() { return lastRun; },
    submit: (l) => { submit(l); sync(); }, type, key, reset, view, ready, text: () => out.textContent,
    wait: () => new Promise((res) => { const f = () => (running() ? onIdle.push(f) : res()); f(); }),
  };
})();
