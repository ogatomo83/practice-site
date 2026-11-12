// 実験場（playground.html）。アセンブリ：エディタ + いつも開いている「CPU を見る」+ 連続実行。回路：エディタ + 真理値表・波形。
(() => {
  const UI = window.CPUUI, VIEW = window.CPUVIEW, S = window.CPU_SAMPLES;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const asmBox = $('#play-asm'), logicBox = $('#play-logic');
  if (!asmBox || !UI || !VIEW || !S) return;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  // ---------------------------------------------------------------- タブ
  const tabs = $$('.play-tabs [role="tab"]');
  const selectTab = (id) => {
    tabs.forEach((t) => {
      const on = t.id === id;
      t.setAttribute('aria-selected', String(on));
      $('#' + t.getAttribute('aria-controls')).hidden = !on;
    });
    store.set('zc-play-tab', id);
    if (id !== 'tab-asm') view.stop();
  };
  tabs.forEach((t) => t.addEventListener('click', () => selectTab(t.id)));

  // ---------------------------------------------------------------- アセンブリ
  const sel = $('#play-sample'), speedSel = $('#play-speed'), go = $('#play-go'), stopBtn = $('#play-stop'), loadBtn = $('#play-load');
  const ta = $('.ed-ta', asmBox);
  const SPEEDS = [[1, '1 命令ずつ（ゆっくり）'], [10, '10 命令'], [100, '100 命令'], [1000, '1,000 命令'], [10000, '1 万命令'], [100000, '10 万命令'], [1000000, '100 万命令（最速）']];
  speedSel.innerHTML = SPEEDS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  sel.innerHTML = S.asm.map((s) => `<option value="${s.id}">${UI.esc(s.title)}</option>`).join('');

  const sync = () => {
    const run = view.running, m = view.machine;
    go.disabled = run;
    stopBtn.disabled = !run;
    asmBox.classList.toggle('is-anim', run);
    $('span', go).textContent = m && m.steps > 0 && !m.halted && !run ? '続ける' : '実行';
  };
  const view = VIEW.mount($('#play-view'), { big: true, onChange: () => sync() });
  const load = () => { const ok = view.load({ box: asmBox, src: ta.value, info: 'asm run' }); sync(); return ok; };
  const start = () => {
    // ソースを書き換えていたら、読み込み直してから実行する。終わっていたら最初から
    if (!view.ok || view.src !== ta.value || (view.machine && view.machine.halted)) { if (!load()) return; }
    view.run(() => +speedSel.value);
    sync();
    if (S.asm.some((s) => s.anim && s.id === sel.value)) $('.scr-wrap', view.el).focus({ preventScroll: true });
  };
  const pick = (id) => {
    const s = S.asm.find((x) => x.id === id) || S.asm[0];
    sel.value = s.id;
    speedSel.value = String(s.speed || 100000);
    UI.setSource(asmBox, s.src);
    load();
  };
  sel.addEventListener('change', () => pick(sel.value));
  go.addEventListener('click', start);
  stopBtn.addEventListener('click', () => { view.stop(); sync(); });
  loadBtn.addEventListener('click', load);
  // エディタの ⌘↵ は、cpu-run.js の通常の実行ではなく、ここの連続実行にする。見出しの実行ボタンは使わない
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopImmediatePropagation(); start(); } }, true);
  $('.code-h .run-btn', asmBox).hidden = true;
  $('.code-h .undo', asmBox).classList.add('is-off');

  // ---------------------------------------------------------------- 回路
  const lsel = $('#play-lsample');
  lsel.innerHTML = S.logic.map((s) => `<option value="${s.id}">${UI.esc(s.title)}</option>`).join('');
  const pickLogic = (id) => {
    const s = S.logic.find((x) => x.id === id) || S.logic[0];
    lsel.value = s.id;
    UI.setSource(logicBox, s.src);
    UI.runBox(logicBox);
  };
  lsel.addEventListener('change', () => pickLogic(lsel.value));
  $('.code-h .undo', logicBox).classList.add('is-off');

  pick(S.asm[0].id);
  pickLogic(S.logic[0].id);
  selectTab(store.get('zc-play-tab', 'tab-asm') === 'tab-logic' ? 'tab-logic' : 'tab-asm');
  window.PLAY = { view, pick, pickLogic, start, load, selectTab };
})();
