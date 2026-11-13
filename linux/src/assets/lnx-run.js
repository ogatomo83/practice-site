// 本文の実行ブロック（```sh run）を動かすランナーと、画面の部品（LNXUI）。
// 実行と判定は grade.js の GRADE.runBlock に任せる（Node の検査スクリプトと同じ結果になる）。
// 必要なもの：hl.js、小さな Linux（lib/lnx-files.mjs の一覧。最後が grade.js）が先に読み込まれていること。
//
// ページに 1 台の機械（GRADE.boot(章の setup)）。ブロックは上から順に積み上がる。
//   LNXUI.machine()       ページの機械（最初に使うときに起動する）
//   LNXUI.baseMachine()   ページの初期状態（setup 済み）のまま触らない機械。確認問題が clone して使う
//   LNXUI.reset()         ページの機械を最初の状態に戻し、出力欄を消す
//   LNXUI.runBox(box)     ブロックを実行して出力欄に出す。GRADE.runBlock の戻り値を返す
//   LNXUI.termHTML(steps, opts)   [{ cmd, lead, prompt, r }] を端末風の HTML にする
//   LNXUI.traceViews.名前 = (events, r) => HTML   trace="名前" の属性があるブロックの「観察」の出し方（sched / mem / pagecache / net は lnx-trace.js が登録する）
// 実行のたびに window に 'lnx-ran'（detail: { box, src, info, result, sys }）、リセットで 'lnx-reset' を送る（「システムを見る」が受け取る）。
(() => {
  const LNX = window.LNX, GRADE = window.GRADE, HL = window.HL;
  if (!LNX || !GRADE || !HL) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtN = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const PREFIX = 'zl-';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(PREFIX + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(PREFIX + k); } catch (e) {} },
  };
  const FOLD_LINES = 24;      // これより長い出力は折りたたむ
  const MAX_LINES = 2000;     // これより長い出力は、画面には出さない
  const MAX_TRACE = 1500;     // 画面に出すシステムコールの数

  // ---------------------------------------------------------------- エディタ
  function paint(box, marks) {
    if (marks !== undefined) box._marks = marks;
    const ta = $('.ed-ta', box);
    $('.ed-hl code', box).innerHTML = HL.editorHTML(ta.value, box.dataset.lang || 'sh', box._marks);
    const undo = $('.undo', box);
    if (undo) undo.hidden = ta.value === ta.defaultValue;
  }
  function bindEditor(box, onRun) {
    const ta = $('.ed-ta', box);
    ta.addEventListener('input', () => { box._marks = null; paint(box); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onRun(); return; }
      if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
        box._marks = null;
        paint(box);
      }
    });
    const undo = $('.undo', box);
    if (undo) undo.addEventListener('click', () => { ta.value = ta.defaultValue; paint(box, null); ta.focus(); });
  }
  const setSource = (box, src) => { $('.ed-ta', box).value = src; paint(box, null); };

  // ---------------------------------------------------------------- 機械
  let setups = [];
  try { setups = JSON.parse(($('#lnx-setup') || {}).textContent || '[]'); } catch (e) { setups = []; }
  let sys = null, base = null;
  const machine = () => sys || (sys = GRADE.boot(setups));
  const baseMachine = () => base || (base = GRADE.boot(setups));

  // ---------------------------------------------------------------- 端末風の表示
  const sigName = (n) => (LNX.SIGNAME && LNX.SIGNAME[n] ? 'SIG' + LNX.SIGNAME[n] : 'シグナル ' + n);
  function exitNote(code) {
    if (code === 127) return 'コマンドが見つからない';
    if (code === 126) return '見つかったが実行できない';
    if (code > 128 && code < 160) return `${sigName(code - 128)} で終わった`;
    return '';
  }
  const exitHTML = (code) => { const n = exitNote(code); return `<div class="tm-st">終了ステータス ${code}${n ? `<span>${esc(n)}</span>` : ''}</div>`; };

  // 出力のかたまり [{ s: 'out' | 'err', text }] → HTML。長ければ折りたたむ
  function outHTML(chunks) {
    const list = (chunks || []).filter((c) => c.text).map((c) => ({ s: c.s, text: c.text }));
    if (!list.length) return '';
    list[list.length - 1].text = list[list.length - 1].text.replace(/\n$/, '');
    const lines = list.reduce((n, c) => n + c.text.split('\n').length - 1, 1);
    let left = MAX_LINES, html = '';
    for (const c of list) {
      if (left <= 0) break;
      const parts = c.text.split('\n');
      const t = parts.length - 1 >= left ? parts.slice(0, left).join('\n') : c.text;
      left -= parts.length - 1;
      html += c.s === 'err' ? `<span class="tm-e">${esc(t)}</span>` : esc(t);
    }
    if (!html) return '';
    const long = lines > FOLD_LINES;
    return `<div class="tm-out${long ? ' is-long' : ''}">${html}</div>${lines > MAX_LINES ? `<div class="tm-st">長いので、最初の ${fmtN(MAX_LINES)} 行だけを出しています</div>` : ''}${
      long ? `<button type="button" class="tm-more" aria-expanded="false" data-n="${Math.min(lines, MAX_LINES)}">すべて表示（${fmtN(Math.min(lines, MAX_LINES))} 行）</button>` : ''}`;
  }

  // strace の 1 行を色分けする
  function traceLine(l) {
    const m = l.line.match(/^(\[pid +\d+\] )?(\w+)(\(.*)$/);
    if (!m) return `<span class="ts-x">${esc(l.line)}</span>`;
    let rest = m[3], ret = '';
    const k = rest.lastIndexOf(' = ');
    if (k >= 0) { ret = rest.slice(k + 3); rest = rest.slice(0, k); }
    return `${m[1] ? `<span class="ts-p">${esc(m[1])}</span>` : ''}<span class="ts-n">${esc(m[2])}</span>${esc(rest)}${ret ? ` = <span class="${/^-1 /.test(ret) ? 'ts-bad' : 'ts-r'}">${esc(ret)}</span>` : ''}`;
  }
  function traceBody(trace) {
    const list = trace.slice(0, MAX_TRACE);
    return `<div class="tm-trace">${list.map((l) => `<div class="ts-l" title="${esc((LNX.SYSJA && LNX.SYSJA[l.name]) || '')}">${traceLine(l)}</div>`).join('')}${
      trace.length > MAX_TRACE ? `<div class="ts-l ts-x">…（残り ${fmtN(trace.length - MAX_TRACE)} 個は省略）</div>` : ''}</div>`;
  }
  const straceHTML = (trace, open) => (trace && trace.length
    ? `<details class="tm-fold"${open ? ' open' : ''}><summary>システムコールの列（${fmtN(trace.length)} 個）</summary>${traceBody(trace)}</details>` : '');

  // trace="sched|mem|net|pagecache"：events から、その観察のもの（cat がその種類のもの）を出す。
  // 専用の表示は LNXUI.traceViews.mem = (events, r) => HTML のように登録する（lnx-trace.js）。登録がなければ、そのまま 1 行ずつ出す。
  // cat のない events（oom のように、いつも記録されるもの）は、type が下の接頭辞で始まるものを拾う。
  const TRACE_TYPES = {
    sched: ['switch', 'sched', 'wakeup', 'nice', 'preempt'],
    mem: ['fault', 'mmap', 'munmap', 'brk', 'cow', 'oom', 'mm', 'page', 'frame'],
    net: ['net', 'sock', 'tcp', 'packet', 'listen', 'accept', 'connect'],
    pagecache: ['pc', 'pagecache', 'cache', 'dirty', 'writeback', 'sync', 'fsync', 'power'],
  };
  const TRACE_JA = { sched: 'スケジューラ', mem: 'メモリ', net: 'ネットワーク', pagecache: 'ページキャッシュ' };
  const traceViews = {};
  function eventsTable(events) {
    const MAX = 300;
    const rows = events.slice(0, MAX).map((e) => {
      const rest = Object.keys(e).filter((k) => k !== 't' && k !== 'type').map((k) => `<span class="ev-kv"><b>${esc(k)}</b> ${esc(typeof e[k] === 'object' ? JSON.stringify(e[k]) : e[k])}</span>`).join('');
      return `<div class="ev-l"><span class="ev-t">${fmtN(e.t)}</span><span class="ev-ty">${esc(e.type)}</span><span class="ev-r">${rest}</span></div>`;
    }).join('');
    return `<div class="ev-list">${rows}${events.length > MAX ? `<div class="ev-l ts-x">…（残り ${fmtN(events.length - MAX)} 個は省略）</div>` : ''}</div>`;
  }
  const traceKinds = (s) => (s ? String(s).split(/[|,\s]+/).filter(Boolean) : null);
  function traceEvents(kind, events) {
    const pre = TRACE_TYPES[kind] || [kind];
    return (events || []).filter((e) => (e.cat ? e.cat === kind : pre.some((p) => String(e.type).startsWith(p))));
  }
  // quiet：出来事がなければ何も出さない（ブロックの中のほかのコマンドに出来事があるとき）
  function observeHTML(kinds, r, quiet) {
    return kinds.map((kind) => {
      const evs = traceEvents(kind, r.events);
      if (!evs.length && quiet) return '';
      let body = '';
      try { body = traceViews[kind] ? traceViews[kind](evs, r) : ''; } catch (e) { body = ''; }
      if (!body) body = evs.length ? eventsTable(evs) : '<p class="out-none">このコマンドでは、記録された出来事はありません。</p>';
      return `<details class="tm-fold" open><summary>${esc(TRACE_JA[kind] || kind)}の観察（${fmtN(evs.length)} 件）</summary>${body}</details>`;
    }).join('');
  }

  // steps = [{ cmd, lead, prompt, r }]。opts.strace：システムコールの列を出す（'open' なら開いた状態で）、opts.trace：['sched', …]
  function termHTML(steps, opts = {}) {
    const anyEv = !!opts.trace && steps.some((s) => opts.trace.some((k) => traceEvents(k, s.r.events).length));
    return steps.map((s) => {
      const lead = (s.lead || '').split('\n').filter((l) => l.trim()).map((l) => `<div class="tm-lead">${esc(l)}</div>`).join('');
      const cmd = HL.highlightLines(s.cmd, 'sh').join('\n<span class="tm-pr">&gt; </span>');
      const r = s.r;
      return `<div class="tm-step">${lead}<div class="tm-cmd"><span class="tm-pr">${esc(s.prompt)}</span>${cmd}</div>${outHTML(r.out)}${
        r.cut ? `<div class="tm-st is-cut">${esc(r.message)}</div>` : r.exit !== 0 ? exitHTML(r.exit) : ''}${
        opts.strace ? straceHTML(r.trace, opts.strace === 'open') : ''}${opts.trace ? observeHTML(opts.trace, r, anyEv) : ''}</div>`;
    }).join('');
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.tm-more');
    if (!b) return;
    const out = b.parentNode.querySelector('.tm-out.is-long');
    if (!out) return;
    const open = out.classList.toggle('is-open');
    b.setAttribute('aria-expanded', String(open));
    b.textContent = open ? '折りたたむ' : `すべて表示（${fmtN(b.dataset.n)} 行）`;
  });

  const errBox = (kind, lines) => `<div class="out-err"><div class="err-h"><span class="err-sev">${esc(kind)}</span></div>${lines.map((l) => `<div class="err-l">${esc(l)}</div>`).join('')}</div>`;

  // ---------------------------------------------------------------- 実行
  // 章の中のブロックは上から順に積み上がるので、どれを実行したかを覚えておく
  const boxes = $$('.lnxrun');
  const ran = new Set();
  const unrunBefore = (box) => (boxes.includes(box) ? boxes.slice(0, boxes.indexOf(box)).filter((b) => !ran.has(b)) : []);
  const hasPanel = () => !!document.getElementById('lnxv');

  function runBox(box, quiet) {
    const ta = $('.ed-ta', box), out = $('.out', box);
    const info = box.dataset.info || 'sh run';
    const p = GRADE.parseInfo(info);
    const src = ta.value;
    out.hidden = false;
    // 「システムを見る」に出すため、システムコールはいつも記録する（結果も tick も変わらない）。本文に出すのは strace の印があるときだけ
    const show = p.flags.has('strace') || !!p.attrs.strace;
    const q = GRADE.parseInfo(info);
    if (!q.attrs.strace) q.flags.add('strace');
    const trace = traceKinds(p.attrs.trace);
    if (trace) q.attrs.trace = trace.join(',');   // 原稿は trace="sched|mem" とも書ける。機械には 'sched,mem' の形で渡す
    let r, m;
    try {
      m = machine();
      r = GRADE.runBlock(m, src, q);
    } catch (e) {
      box.dataset.result = 'crash';
      out.innerHTML = errBox('実行できませんでした', [String((e && e.message) || e), '上の「リセット」で、最初の状態に戻せます。']);
      return null;
    }
    const before = unrunBefore(box);
    ran.add(box);
    box.dataset.result = r.ok ? 'ok' : 'ng';
    box.dataset.failed = String(r.failed);
    const kind = r.ok ? (r.failed ? 'warn' : 'ok') : r.failed ? 'bad' : 'warn';
    const text = r.ok
      ? (r.failed ? (p.attrs.keys && /\^[CZ\\]/.test(p.attrs.keys) ? 'キーで止めました（この例では、それが正しい結果です）' : p.flags.has('limit') && !r.steps.some((s) => !s.r.cut && s.r.exit !== 0) ? '打ち切られました（この例では、それが正しい結果です）' : 'エラーで終わりました（この例では、それが正しい結果です）') : '終わりました')
      : (r.failed ? 'エラーで終わりました' : 'エラーになるはずの例ですが、エラーになりませんでした');
    const ticks = r.steps.reduce((a, s) => a + s.r.ticks, 0);
    let prev = '';
    if (before.length) {
      prev = `<div class="out-prev"><span>この章のコマンドは、上から順に積み上がります（前のブロックで作ったファイルなどを、後のブロックが使います）。このブロックより前に、まだ実行していないブロックが ${before.length} 個あります。「前を順に実行」を押すと、最初の状態に戻してから、上からこのブロックまでを順に実行します。</span><button type="button" class="dbv-btn out-prev-run">前を順に実行</button></div>`;
    }
    out.innerHTML = `${prev}<div class="tm">${termHTML(r.steps, { strace: show ? 'open' : false, trace })}</div><div class="out-meta"><span class="st is-${kind}">${esc(text)}</span><span>${r.steps.length} コマンド</span><span>仮想時間 ${fmtN(ticks)} ミリ秒</span>${
      hasPanel() ? '<button type="button" class="dbv-btn out-step">システムを見る</button>' : ''}</div>`;
    const pb = $('.out-prev-run', out);
    if (pb) pb.addEventListener('click', () => {
      const upto = boxes.slice(0, boxes.indexOf(box) + 1);
      reset();
      for (const b of upto) runBox(b, b !== box);
    });
    const sb = $('.out-step', out);
    if (sb) sb.addEventListener('click', () => window.LNXVIEW && window.LNXVIEW.openPanel());
    const last = r.steps[r.steps.length - 1];
    lastRun = { box, src, info, result: r, sys: m, run: mergeRuns(r.steps) , last: last && last.r };
    if (!quiet) window.dispatchEvent(new CustomEvent('lnx-ran', { detail: lastRun }));
    return r;
  }
  // ブロックの中の全コマンドの events と trace をつないだもの（「システムを見る」用）
  function mergeRuns(steps) {
    const o = { events: [], trace: [], cmds: [] };
    steps.forEach((s) => {
      o.cmds.push(s.cmd);
      for (const e of s.r.events || []) o.events.push(e);
      if (steps.length > 1 && s.r.trace && s.r.trace.length) o.trace.push({ sep: true, line: s.prompt + s.cmd.split('\n')[0] });
      for (const t of s.r.trace || []) o.trace.push(t);
    });
    return o;
  }
  let lastRun = null;

  function reset() {
    sys = null;
    ran.clear();
    lastRun = null;
    boxes.forEach((b) => { const o = $('.out', b); o.hidden = true; o.innerHTML = ''; delete b.dataset.result; delete b.dataset.failed; });
    window.dispatchEvent(new CustomEvent('lnx-reset'));
  }

  $$('.lnxrun').forEach((box) => {
    bindEditor(box, () => runBox(box));
    $('.run-btn', box).addEventListener('click', () => runBox(box));
  });
  const resetBtn = $('.db-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    reset();
    resetBtn.textContent = '戻しました';
    setTimeout(() => { resetBtn.textContent = 'リセット'; }, 1200);
  });

  window.LNXUI = {
    esc, fmtN, store, PREFIX, paint, bindEditor, setSource, machine, baseMachine, reset, runBox, mergeRuns,
    termHTML, outHTML, straceHTML, traceBody, traceLine, exitHTML, exitNote, errBox, eventsTable, traceViews, traceEvents, traceKinds, TRACE_TYPES, TRACE_JA,
    get setups() { return setups; }, get lastRun() { return lastRun; }, get boxes() { return boxes; },
  };
})();
