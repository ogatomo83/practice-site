// 本文の実行ブロック（```sh run）を動かすランナーと、画面の部品（LNXUI）。
// 実行と判定は grade.js の GRADE.runBlock に任せる（Node の検査スクリプトと同じ結果になる）。
// 必要なもの：hl.js、小さな Linux（lib/lnx-files.mjs の一覧。最後が grade.js）が先に読み込まれていること。
//
// ページに 1 台の機械（GRADE.boot(章の setup)）。ブロックは上から順に積み上がる。
//   LNXUI.machine()       ページの機械（最初に使うときに起動する）
//   LNXUI.baseMachine()   ページの初期状態（setup 済み）のまま触らない機械。確認問題が clone して使う
//   LNXUI.reset()         ページの機械を最初の状態に戻し、出力欄を消す
//   LNXUI.runBox(box)     ブロックの残りを「お手本のコマンド」で実行して端末に出す。GRADE.runBlock と同じ形の戻り値を返す
//   LNXUI.submit(box, line)   入力行に line を打って Enter したのと同じ（学習者の操作）
//   LNXUI.runPrev(box)    「前を順に実行」：最初の状態に戻し、box より前のブロックをお手本で実行する
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

  // ---------------------------------------------------------------- 打って実行する
  // ブロックには「お手本」（読むだけ）と、端末風の入力行がある。学習者がお手本を見て打ち、Enter で 1 コマンドずつ実行する。
  // お手本は「端末に 1 回で打つ単位」（GRADE.split と同じ分け方）に分け、次に打つものに印を付ける。
  // 打ったものは、そのまま実行する（打ち間違いも学び）。お手本と同じなら次の単位へ進み、違えば違いを控えめに出して、同じ単位に留まる。
  // 全部の単位をお手本どおりに実行したら、そのブロックは「済み」。積み上げと「前を順に実行」は、この「済み」で数える。
  // 「前を順に実行」と LNXUI.runBox は、お手本のコマンドで実行する。
  const boxes = $$('.lnxrun');
  const ran = new Set();   // お手本どおりに最後まで実行したブロック
  const unrunBefore = (box) => (boxes.includes(box) ? boxes.slice(0, boxes.indexOf(box)).filter((b) => !ran.has(b)) : []);
  const hasPanel = () => !!document.getElementById('lnxv');
  const userOfInfo = (info) => { const p = GRADE.parseInfo(info || 'sh run'); return p.attrs.user || (p.flags.has('root') ? 'root' : undefined); };

  // お手本を単位に分け、各単位が何行目から何行目までかも返す（コメントと空行は、どの単位にも入れない）
  function stepsOf(src) {
    const lines = String(src || '').replace(/\n+$/, '').split('\n');
    const steps = [];
    let cur = [], from = -1;
    lines.forEach((l, i) => {
      if (!cur.length && /^\s*(#.*)?$/.test(l)) return;
      if (!cur.length) from = i;
      cur.push(l);
      const pr = LNX.sh.parse(cur.join('\n'));
      if (pr.incomplete || /\\$/.test(l)) return;
      steps.push({ cmd: cur.join('\n'), from, to: i });
      cur = [];
    });
    if (cur.length) steps.push({ cmd: cur.join('\n'), from, to: lines.length - 1 });
    return { lines, steps };
  }

  // 比べるときは、空白の数、行末のコメント、空行を問わない
  const norm = (s) => String(s || '').split('\n').map((l) => l.replace(/\s+#[^'"`]*$/, '').trim().replace(/\s+/g, ' ')).filter(Boolean).join('\n');
  const tokens = (s) => norm(s).split('\n').flatMap((l, i) => (i ? ['\n'] : []).concat(l.split(' ')));
  // 2 つの語の列の、共通の部分（LCS）に入る語に印を付ける
  function common(a, b) {
    const n = a.length, m = b.length;
    const ka = a.map(() => false), kb = b.map(() => false);
    if (n * m > 400000) return [ka, kb];
    const d = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) d[i][j] = a[i] === b[j] ? d[i + 1][j + 1] + 1 : Math.max(d[i + 1][j], d[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ka[i] = kb[j] = true; i++; j++; } else if (d[i + 1][j] >= d[i][j + 1]) i++; else j++;
    }
    return [ka, kb];
  }
  function diffLines(toks, keep) {
    const out = [{ html: [], changed: false }];
    toks.forEach((t, i) => {
      if (t === '\n') { out.push({ html: [], changed: false }); return; }
      const line = out[out.length - 1];
      if (keep[i]) line.html.push(esc(t));
      else { line.html.push(`<mark class="lr-dx">${esc(t)}</mark>`); line.changed = true; }
    });
    return out.map((l) => ({ html: l.html.join(' '), changed: l.changed }));
  }
  function diffHTML(model, typed) {
    const a = tokens(model), b = tokens(typed);
    const [ka, kb] = common(a, b);
    // 長いお手本（ヒアドキュメントなど）は、違う行だけを出す
    const pick = (ls) => { const ch = ls.filter((l) => l.changed); const list = ls.length > 3 ? (ch.length ? ch.slice(0, 4) : ls.slice(0, 1)) : ls; return list.map((l) => l.html || ' ').join('\n'); };
    return `<div class="lr-diff"><div class="lr-diff-h">お手本と違うコマンドでした（打ったとおりに実行しています）。お手本のとおりに打つと、次へ進みます。</div><div class="lr-diff-r"><span class="lr-diff-k">お手本</span><code>${pick(diffLines(a, ka))}</code></div><div class="lr-diff-r"><span class="lr-diff-k">打ったもの</span><code>${pick(diffLines(b, kb))}</code></div></div>`;
  }

  const st = (box) => box._lr;
  function initState(box) {
    const { lines, steps } = stepsOf(box.dataset.src || '');
    box._lr = { lines, steps, pos: 0, buf: '', results: [], used: false };
    delete box.dataset.result; delete box.dataset.failed;
  }

  // お手本の表示：済んだ単位は薄く、次に打つ単位に印
  function paintModel(box) {
    const s = st(box), code = $('.lr-model code', box);
    if (!code) return;
    const owner = [];
    s.steps.forEach((x, k) => { for (let i = x.from; i <= x.to; i++) owner[i] = k; });
    const hl = HL.highlightLines(s.lines.join('\n'), 'sh');
    code.innerHTML = hl.map((h, i) => {
      const k = owner[i];
      const cls = k === undefined ? '' : k < s.pos ? ' is-done' : k === s.pos ? ' is-next' : '';
      return `<span class="ln${cls}">${h}</span>`;
    }).join('');
  }

  // 下の行：進み具合、終わったときの判定、「お手本を入れる」
  function paintFoot(box) {
    const s = st(box), foot = $('.lr-foot', box);
    if (!foot) return;
    const p = GRADE.parseInfo(box.dataset.info || 'sh run');
    const n = s.steps.length, left = n - s.pos;
    let html;
    if (left <= 0) {
      const failed = s.results.some((r) => r.failed);
      const ok = p.flags.has('error') ? failed : !failed;
      const kind = ok ? (failed ? 'warn' : 'ok') : failed ? 'bad' : 'warn';
      const text = ok
        ? (failed ? (p.attrs.keys && /\^[CZ\\]/.test(p.attrs.keys) ? 'キーで止めました（この例では、それが正しい結果です）' : p.flags.has('limit') && !s.results.some((r) => r.steps.some((x) => !x.r.cut && x.r.exit !== 0)) ? '打ち切られました（この例では、それが正しい結果です）' : 'エラーで終わりました（この例では、それが正しい結果です）') : 'お手本のとおりに実行しました')
        : (failed ? 'エラーで終わりました' : 'エラーになるはずの例ですが、エラーになりませんでした');
      const ticks = s.results.reduce((a, r) => a + r.steps.reduce((b, x) => b + x.r.ticks, 0), 0);
      box.dataset.result = ok ? 'ok' : 'ng';
      box.dataset.failed = String(failed);
      html = `<span class="st is-${kind}">${esc(text)}</span><span>${n} コマンド</span><span>仮想時間 ${fmtN(ticks)} ミリ秒</span>`;
    } else {
      const next = s.steps[s.pos];
      const long = next && next.cmd.split('\n').length >= 4;
      const keys = s.pos === 0 && p.attrs.keys ? `（実行すると、${p.attrs.keys.split(',').map((k) => { const [key, at] = k.trim().split('@'); return `${Number(at) / 1000} 秒後に ${key.replace(/^\^(.)$/, 'Ctrl-$1')}`; }).join('、')} を押します）` : '';
      html = `<span class="lr-st">${s.pos === 0 ? `お手本を打って Enter${n > 1 ? `（${n} コマンド。1 つずつ）` : ''}` : `あと ${left} コマンド`}${esc(keys)}${long ? '。長いので「お手本を入れる」を使ってもかまいません' : ''}</span><button type="button" class="lr-fill">お手本を入れる</button>`;
    }
    if (s.used && hasPanel()) html += '<button type="button" class="dbv-btn out-step">システムを見る</button>';
    foot.innerHTML = html;
  }

  function paintPrev(box) {
    const s = st(box), el = $('.lr-prev', box);
    if (!el) return;
    const before = s.used ? unrunBefore(box) : [];
    el.hidden = !before.length;
    el.innerHTML = before.length ? `<div class="out-prev"><span>この章のコマンドは、上から順に積み上がります（前のブロックで作ったファイルなどを、後のブロックが使います）。このブロックより前に、まだお手本どおりに実行していないブロックが ${before.length} 個あります。「前を順に実行」を押すと、最初の状態に戻してから、前のブロックをお手本のコマンドで順に実行します（このブロックは、打ち直しになります）。</span><button type="button" class="dbv-btn out-prev-run">前を順に実行</button></div>` : '';
  }

  // sys.prompt / sys.complete は、そのユーザーのシェルがまだなければ作ってしまう（PID が進み、本文の出力と変わる）。シェルがあるときだけ使う
  const hasSession = (m, user) => {
    try { const s = m.k.sessions.get(user || m.opts.user); return !!s && s.proc.state !== 'Z' && m.k.procs.has(s.proc.pid); } catch (e) { return false; }
  };
  const livePrompt = (box) => { const u = userOfInfo(box.dataset.info); return sys && hasSession(sys, u) ? sys.prompt(u) : box._pr0; };
  const promptOf = (box) => (st(box).buf ? '> ' : livePrompt(box));
  function paintPrompts() { boxes.forEach((b) => { const el = $('.lr-pr', b); if (el) el.textContent = promptOf(b); }); }
  function paintPend(box) {
    const s = st(box);
    let el = $('.lr-pend', box);
    if (!el) { el = document.createElement('div'); el.className = 'tm lr-pend'; $('.lr-line', box).before(el); }
    el.hidden = !s.buf;
    el.innerHTML = s.buf ? `<div class="tm-cmd"><span class="tm-pr">${esc(livePrompt(box))}</span>${HL.highlightLines(s.buf, 'sh').join('\n<span class="tm-pr">&gt; </span>')}</div>` : '';
    const pr = $('.lr-pr', box);
    if (pr) pr.textContent = promptOf(box);
  }
  const log = (box, html) => { const l = $('.lr-log', box); l.insertAdjacentHTML('beforeend', html); l.hidden = false; };

  // 1 コマンドを実行して、端末に出す。model：お手本のコマンドとして実行する（「前を順に実行」など）
  function execute(box, cmd, quiet) {
    const s = st(box);
    const info = box.dataset.info || 'sh run';
    const p = GRADE.parseInfo(info);
    // 「システムを見る」に出すため、システムコールはいつも記録する（結果も tick も変わらない）。本文に出すのは strace の印があるときだけ
    const show = p.flags.has('strace') || !!p.attrs.strace;
    const q = GRADE.parseInfo(info);
    if (!q.attrs.strace) q.flags.add('strace');
    const trace = traceKinds(p.attrs.trace);
    if (trace) q.attrs.trace = trace.join(',');   // 原稿は trace="sched|mem" とも書ける。機械には 'sched,mem' の形で渡す
    const want = s.pos < s.steps.length ? s.steps[s.pos] : null;
    // stdin と keys は、ブロックの最初のコマンドにだけ渡す
    if (s.pos !== 0 || !want) { delete q.attrs.stdin; delete q.attrs.keys; }
    let r, m;
    try {
      m = machine();
      r = GRADE.runBlock(m, cmd, q);
    } catch (e) {
      log(box, errBox('実行できませんでした', [String((e && e.message) || e), '上の「リセット」で、最初の状態に戻せます。']));
      return null;
    }
    s.used = true;
    const match = !!want && norm(cmd) === norm(want.cmd);
    if (match) { s.results.push(r); s.pos++; }
    log(box, termHTML(r.steps, { strace: show ? 'open' : false, trace }) + (want && !match ? diffHTML(want.cmd, cmd) : ''));
    if (s.pos >= s.steps.length && match) ran.add(box);
    paintModel(box);
    paintFoot(box);
    boxes.forEach((b) => { if (st(b).used) paintPrev(b); });
    paintPrompts();
    lastRun = { box, src: cmd, info, result: r, sys: m, run: mergeRuns(r.steps), last: r.steps.length ? r.steps[r.steps.length - 1].r : null };
    if (!quiet) window.dispatchEvent(new CustomEvent('lnx-ran', { detail: lastRun }));
    return r;
  }

  // お手本の残りを、お手本のコマンドで実行する。戻り値は GRADE.runBlock と同じ形（ブロック全体）
  function runBox(box, quiet) {
    const s = st(box);
    s.buf = '';
    paintPend(box);
    while (s.pos < s.steps.length) {
      const pos = s.pos;
      if (!execute(box, s.steps[pos].cmd, true) || s.pos === pos) break;
    }
    if (!quiet && lastRun) window.dispatchEvent(new CustomEvent('lnx-ran', { detail: lastRun }));
    const failed = s.results.some((r) => r.failed);
    const p = GRADE.parseInfo(box.dataset.info || 'sh run');
    return { ok: p.flags.has('error') ? failed : !failed, failed, steps: s.results.flatMap((r) => r.steps), message: (s.results.find((r) => r.failed) || {}).message || '' };
  }
  function runPrev(box) {
    const upto = boxes.slice(0, boxes.indexOf(box));
    reset();
    upto.forEach((b) => runBox(b, true));
    if (lastRun) window.dispatchEvent(new CustomEvent('lnx-ran', { detail: lastRun }));
    const ta = $('.lr-in', box);
    if (ta) ta.focus({ preventScroll: true });
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

  function clearBox(box) {
    initState(box);
    const l = $('.lr-log', box);
    if (l) l.innerHTML = '';
    const ta = $('.lr-in', box);
    if (ta) { ta.value = ''; ta.style.height = ''; }
    paintModel(box); paintFoot(box); paintPrev(box); paintPend(box);
  }
  function reset() {
    sys = null;
    ran.clear();
    lastRun = null;
    boxes.forEach(clearBox);
    paintPrompts();
    window.dispatchEvent(new CustomEvent('lnx-reset'));
  }

  // ---------------------------------------------------------------- 入力（実験場の端末と同じ操作：履歴 ↑↓、Tab 補完、Ctrl-C、Ctrl-L、続きの行は > ）
  const hist = [];
  let histPos = 0, histDraft = '', histBox = null;
  const fit = (ta) => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  function submit(box, line) {
    const s = st(box);
    const cmd = s.buf ? s.buf + '\n' + line : line;
    if (line.trim() && hist[hist.length - 1] !== line) hist.push(line);
    histPos = hist.length; histDraft = '';
    if (!cmd.trim()) { s.buf = ''; paintPend(box); return; }
    // コメントだけの行は、本物のシェルと同じく何も実行しない（プロセスも作らない）
    if (!s.buf && /^\s*#/.test(line)) { log(box, `<div class="tm-step"><div class="tm-cmd"><span class="tm-pr">${esc(promptOf(box))}</span>${HL.highlightLines(line, 'sh').join('')}</div></div>`); return; }
    const pr = LNX.sh.parse(cmd);
    if (pr.incomplete || /\\$/.test(line)) { s.buf = cmd; paintPend(box); return; }
    s.buf = '';
    paintPend(box);
    execute(box, cmd);
  }
  function complete(box, ta) {
    const pos = ta.selectionStart, head = ta.value.slice(0, pos), tail = ta.value.slice(pos);
    let c;
    const u = userOfInfo(box.dataset.info), m = machine();
    try { c = (hasSession(m, u) ? m : m.clone()).complete(head, u); } catch (e) { return; }
    if (!c || !c.candidates.length) return;
    const put = (w) => { ta.value = head.slice(0, c.start) + w + tail; const p = c.start + w.length; ta.setSelectionRange(p, p); };
    if (c.candidates.length === 1) { const w = c.candidates[0]; put(w + (w.endsWith('/') ? '' : ' ')); return; }
    let pre = c.candidates[0];
    for (const w of c.candidates) { let i = 0; while (i < pre.length && pre[i] === w[i]) i++; pre = pre.slice(0, i); }
    if (pre.length > c.word.length) { put(pre); return; }
    log(box, `<div class="tm-step"><div class="tm-cmd"><span class="tm-pr">${esc(promptOf(box))}</span>${esc(ta.value)}</div><div class="tm-cand">${esc(c.candidates.slice(0, 120).join('  ') + (c.candidates.length > 120 ? '  …' : ''))}</div></div>`);
  }
  function bindBox(box) {
    const ta = $('.lr-in', box);
    box._pr0 = ($('.lr-pr', box) || {}).textContent || '';
    initState(box);
    paintModel(box);
    paintFoot(box);
    if (!ta) return;
    ta.addEventListener('input', () => fit(ta));
    ta.addEventListener('focus', () => { if (histBox !== box) { histBox = box; histPos = hist.length; histDraft = ''; } });
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return; // 日本語入力の変換中
      const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
      const k = e.key;
      if (k === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const v = ta.value;
        ta.value = '';
        v.split('\n').forEach((l, i, a) => { if (i === 0 || l !== '' || i < a.length - 1) submit(box, l); });
        fit(ta);
        return;
      }
      if (k === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); complete(box, ta); fit(ta); return; }
      if ((k === 'ArrowUp' || k === 'ArrowDown') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !ta.value.includes('\n')) {
        e.preventDefault();
        if (histPos === hist.length) histDraft = ta.value;
        histPos = Math.max(0, Math.min(hist.length, histPos + (k === 'ArrowUp' ? -1 : 1)));
        ta.value = histPos === hist.length ? histDraft : hist[histPos];
        ta.setSelectionRange(ta.value.length, ta.value.length);
        fit(ta);
        return;
      }
      if (ctrl && k.toLowerCase() === 'c' && ta.selectionStart === ta.selectionEnd) {
        e.preventDefault();
        const s = st(box);
        log(box, `<div class="tm-step"><div class="tm-cmd"><span class="tm-pr">${esc(promptOf(box))}</span>${esc(ta.value)}^C</div></div>`);
        ta.value = ''; s.buf = ''; histPos = hist.length;
        paintPend(box); fit(ta);
        return;
      }
      if (ctrl && k.toLowerCase() === 'l') { e.preventDefault(); $('.lr-log', box).innerHTML = ''; }
    });
    const term = $('.lr-term', box);
    term.addEventListener('click', (e) => { if (!e.target.closest('button, a, summary') && String(window.getSelection()) === '') ta.focus({ preventScroll: true }); });
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !box.contains(b)) return;
      if (b.classList.contains('lr-fill')) {
        const s = st(box);
        const want = s.steps[s.pos];
        if (!want) return;
        s.buf = '';
        paintPend(box);
        ta.value = want.cmd;
        fit(ta);
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(ta.value.length, ta.value.length);
      } else if (b.classList.contains('out-prev-run')) runPrev(box);
      else if (b.classList.contains('out-step')) { if (window.LNXVIEW) window.LNXVIEW.openPanel(); }
    });
  }

  boxes.forEach(bindBox);
  const resetBtn = $('.db-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    reset();
    resetBtn.textContent = '戻しました';
    setTimeout(() => { resetBtn.textContent = 'リセット'; }, 1200);
  });

  window.LNXUI = {
    esc, fmtN, store, PREFIX, paint, bindEditor, setSource, machine, baseMachine, reset, runBox, runPrev, submit, stepsOf, norm, mergeRuns,
    termHTML, outHTML, straceHTML, traceBody, traceLine, exitHTML, exitNote, errBox, eventsTable, traceViews, traceEvents, traceKinds, TRACE_TYPES, TRACE_JA,
    get setups() { return setups; }, get lastRun() { return lastRun; }, get boxes() { return boxes; },
  };
})();
