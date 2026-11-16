// 本文の実行ブロック（```sh run）を動かすランナーと、画面の部品（GCPUI）。判定は grade.js の GRADE.runBlock（Node の検査と同じ）。
// ページに 1 台の機械（GRADE.boot(章の setup)）。ブロックは上から順に積み上がる。実行は 1 つずつ順番に（serial）。
//   GCPUI.machine() → Promise<sys>       GCPUI.baseMachine() → Promise<sys>（確認問題が clone して使う、触らない機械）
//   GCPUI.reset()  GCPUI.runBox(box)  GCPUI.termHTML(steps)  GCPUI.serial(fn)
// 実行のたびに window に 'gcp-ran'（detail: { box, result, sys }）、リセットで 'gcp-reset' を送る（「クラウドを見る」が受け取る）。
(() => {
  const GCP = window.GCP, GRADE = window.GRADE, HL = window.HL;
  if (!GCP || !GRADE || !HL) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtN = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const PREFIX = 'zg-';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(PREFIX + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(PREFIX + k); } catch (e) {} },
  };
  const FOLD_LINES = 28, MAX_LINES = 2000;
  const ERR_LINE = /^(ERROR|WARNING|E: |W: |psql:|curl: \(|Error|BigQuery error|FATAL|-bash:|.*(Error|error|ERROR)[:(]|.*: (cannot|No such)|\s+at |Node\.js v|\s*\^|LINE \d|DETAIL|HINT|Deployment failed|X |  X )/;

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
      if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); box._marks = null; paint(box); }
    });
    const undo = $('.undo', box);
    if (undo) undo.addEventListener('click', () => { ta.value = ta.defaultValue; paint(box, null); ta.focus(); });
  }
  const setSource = (box, src) => { $('.ed-ta', box).value = src; paint(box, null); };

  // ---------------------------------------------------------------- 順番に実行する
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  // ---------------------------------------------------------------- 機械
  let setups = [];
  try { setups = JSON.parse(($('#gcp-setup') || {}).textContent || '[]'); } catch (e) { setups = []; }
  let sysP = null, baseP = null;
  const machine = () => sysP || (sysP = GRADE.boot(setups));
  const baseMachine = () => baseP || (baseP = GRADE.boot(setups));
  // BigQuery と Cloud SQL のエンジンは、使いそうなページで先に読み込んでおく
  const pageText = document.body.textContent || '';
  const warm = () => {
    if (/\bbq\s+(query|mk|load|head|show|ls)\b/.test(pageText) && GCP.DUCK) GCP.DUCK().catch(() => {});
    if (/gcloud sql connect/.test(pageText) && GCP.PG) GCP.PG().catch(() => {});
  };
  document.addEventListener('focusin', (e) => { if (e.target.closest && e.target.closest('.gcprun, .qz')) warm(); }, { once: true });
  document.addEventListener('pointerover', (e) => { if (e.target.closest && e.target.closest('.gcprun .run-btn, .qz-check')) warm(); }, { once: true });

  // ---------------------------------------------------------------- 端末風の表示
  function exitNote(code) { if (code === 127) return 'コマンドが見つからない'; if (code === 2) return '使い方の誤り'; return ''; }
  const exitHTML = (code) => { const n = exitNote(code); return `<div class="tm-st">終了ステータス ${code}${n ? `<span>${esc(n)}</span>` : ''}</div>`; };
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
      // stderr は、エラーの行だけを赤に。gcloud の進み具合などの知らせ（stderr に出る）は控えめな色に
      html += c.s === 'err' ? t.split(/(?<=\n)/).map((l) => `<span class="${ERR_LINE.test(l) ? 'tm-e' : 'tm-n'}">${esc(l)}</span>`).join('') : esc(t);
    }
    if (!html) return '';
    const long = lines > FOLD_LINES;
    return `<div class="tm-out${long ? ' is-long' : ''}">${html}</div>${long ? `<button type="button" class="tm-more" aria-expanded="false" data-n="${Math.min(lines, MAX_LINES)}">すべて表示（${fmtN(Math.min(lines, MAX_LINES))} 行）</button>` : ''}`;
  }
  function termHTML(steps) {
    return steps.map((s) => {
      const lead = (s.lead || '').split('\n').filter((l) => l.trim()).map((l) => `<div class="tm-lead">${esc(l)}</div>`).join('');
      const cmd = HL.highlightLines(s.cmd, 'sh').join('\n<span class="tm-pr">&gt; </span>');
      const r = s.r;
      return `<div class="tm-step">${lead}<div class="tm-cmd"><span class="tm-pr">${esc(s.prompt)}</span>${cmd}</div>${outHTML(r.out)}${r.exit !== 0 ? exitHTML(r.exit) : ''}</div>`;
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
  const boxes = $$('.gcprun');
  const ran = new Set();
  const unrunBefore = (box) => (boxes.includes(box) ? boxes.slice(0, boxes.indexOf(box)).filter((b) => !ran.has(b)) : []);
  const hasPanel = () => !!document.getElementById('gcpv');
  let lastRun = null;
  const needsEngine = (src) => (/\bbq\s+(query|mk\s+--view|load)\b|INSERT INTO|CREATE TABLE/i.test(src) && GCP.DUCK) || (/gcloud sql connect|\bpsql\b/.test(src) && GCP.PG);

  function runBox(box, quiet) {
    return serial(async () => {
      const ta = $('.ed-ta', box), out = $('.out', box);
      const info = box.dataset.info || 'sh run';
      const src = ta.value;
      out.hidden = false;
      box.classList.add('is-running');
      const first = !sysP;
      out.innerHTML = `<div class="out-meta"><span class="st is-wait">${first ? 'このページの小さな GCP を起動しています…' : needsEngine(src) ? '実行しています（初回は、BigQuery / Cloud SQL のエンジンの読み込みに数秒かかります）…' : '実行しています…'}</span></div>`;
      let r, m;
      try { m = await machine(); r = await GRADE.runBlock(m, src, info); }
      catch (e) {
        box.classList.remove('is-running');
        box.dataset.result = 'crash';
        out.innerHTML = errBox('実行できませんでした', [String((e && e.message) || e), '上の「リセット」で、最初の状態に戻せます。']);
        return null;
      }
      box.classList.remove('is-running');
      const before = unrunBefore(box);
      ran.add(box);
      box.dataset.result = r.ok ? 'ok' : 'ng';
      box.dataset.failed = String(r.failed);
      const kind = r.ok ? (r.failed ? 'warn' : 'ok') : r.failed ? 'bad' : 'warn';
      const text = r.ok ? (r.failed ? 'エラーで終わりました（この例では、それが正しい結果です）' : '終わりました') : (r.failed ? 'エラーで終わりました' : 'エラーになるはずの例ですが、エラーになりませんでした');
      const ms = r.steps.reduce((a, s) => a + s.r.ms, 0);
      const prev = before.length ? `<div class="out-prev"><span>この章のコマンドは、上から順に積み上がります（前のブロックで作ったバケットや VM を、後のブロックが使います）。このブロックより前に、まだ実行していないブロックが ${before.length} 個あります。「前を順に実行」を押すと、最初の状態に戻してから、上からこのブロックまでを順に実行します。</span><button type="button" class="dbv-btn out-prev-run">前を順に実行</button></div>` : '';
      out.innerHTML = `${prev}<div class="tm">${termHTML(r.steps)}</div><div class="out-meta"><span class="st is-${kind}">${esc(text)}</span><span>${r.steps.length} コマンド</span><span title="クラウドの中で流れた時間（仮想の時計）。VM の作成やデプロイは、本物と同じくらいの時間が進みます">仮想時間 ${fmtDur(ms)}</span>${hasPanel() ? '<button type="button" class="dbv-btn out-step">クラウドを見る</button>' : ''}</div>`;
      const pb = $('.out-prev-run', out);
      if (pb) pb.addEventListener('click', async () => {
        const upto = boxes.slice(0, boxes.indexOf(box) + 1);
        reset();
        for (const b of upto) await runBox(b, b !== box);
      });
      const sb = $('.out-step', out);
      if (sb) sb.addEventListener('click', () => window.GCPVIEW && window.GCPVIEW.openPanel());
      lastRun = { box, src, info, result: r, sys: m };
      if (!quiet) window.dispatchEvent(new CustomEvent('gcp-ran', { detail: lastRun }));
      return r;
    });
  }
  const fmtDur = (ms) => (ms < 1000 ? `${ms} ミリ秒` : ms < 60000 ? `${(ms / 1000).toFixed(1)} 秒` : ms < 3600000 ? `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒` : ms < 86400000 * 2 ? `${(ms / 3600000).toFixed(1)} 時間` : `${(ms / 86400000).toFixed(1)} 日`);
  function reset() {
    sysP = null;
    ran.clear();
    lastRun = null;
    boxes.forEach((b) => { const o = $('.out', b); o.hidden = true; o.innerHTML = ''; delete b.dataset.result; delete b.dataset.failed; });
    window.dispatchEvent(new CustomEvent('gcp-reset'));
  }
  boxes.forEach((box) => {
    bindEditor(box, () => runBox(box));
    $('.run-btn', box).addEventListener('click', () => runBox(box));
  });
  const resetBtn = $('.db-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => { serial(async () => reset()); resetBtn.textContent = '戻しました'; setTimeout(() => { resetBtn.textContent = 'リセット'; }, 1200); });

  window.GCPUI = { esc, fmtN, fmtDur, store, PREFIX, paint, bindEditor, setSource, machine, baseMachine, reset, runBox, serial, termHTML, outHTML, exitHTML, errBox, get setups() { return setups; }, get lastRun() { return lastRun; }, get boxes() { return boxes; } };
})();
