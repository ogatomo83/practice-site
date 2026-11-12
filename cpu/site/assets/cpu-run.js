// 本文の実行ブロック（```asm run / ```logic run）を動かすランナーと、画面の部品（CPUUI）。
// 実行と判定は grade.js の GRADE.runBlock に任せる（Node の検査スクリプトと同じ結果になる）。
// 必要なもの：hl.js、rv.js、logic.js、grade.js が先に読み込まれていること。
(() => {
  const RV = window.RV, LOGIC = window.LOGIC, GRADE = window.GRADE, HL = window.HL;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const hex = (v, n = 8) => '0x' + (v >>> 0).toString(16).padStart(n, '0');
  const fmtN = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const MAX_CONSOLE = 20000;

  // ---------------------------------------------------------------- エディタ
  const langOf = (box) => box.dataset.lang || 'asm';
  function paint(box, marks) {
    if (marks !== undefined) box._marks = marks;
    const ta = $('.ed-ta', box);
    $('.ed-hl code', box).innerHTML = HL.editorHTML(ta.value, langOf(box), box._marks);
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

  // ---------------------------------------------------------------- 画面（32 × 32）
  const PAL = RV.PALETTE.map((c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]);
  function drawScreen(canvas, screen) {
    const ctx = canvas.getContext('2d');
    const img = canvas._img || (canvas._img = ctx.createImageData(32, 32));
    const d = img.data;
    for (let i = 0; i < 1024; i++) {
      const c = PAL[screen[i] & 15];
      d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  // HTML の文字列の中に画面を埋め込む（あとで hydrate が描く）
  const screenHTML = (screen, cls = '') => `<canvas class="scr ${cls}" width="32" height="32" data-px="${Array.from(screen, (v) => (v & 15).toString(16)).join('')}" role="img" aria-label="32 × 32 ピクセルの画面"></canvas>`;
  function hydrate(root) {
    $$('canvas[data-px]', root).forEach((c) => {
      drawScreen(c, Uint8Array.from(c.dataset.px, (ch) => parseInt(ch, 16)));
      c.removeAttribute('data-px');
    });
  }

  // ---------------------------------------------------------------- 表示の部品
  const consoleHTML = (text, cap = 'コンソール') => {
    const cut = text.length > MAX_CONSOLE;
    return `<div class="out-sec"><div class="out-cap">${cap}</div><pre class="out-console">${esc(cut ? text.slice(0, MAX_CONSOLE) : text.replace(/\n$/, ''))}${cut ? '\n…（長いので省略）' : ''}</pre></div>`;
  };
  // list = [[名前, 値]]
  const regsHTML = (list, cap = 'レジスタ') =>
    `<div class="out-sec"><div class="out-cap">${cap}</div><div class="rg-list">${list
      .map(([n, v]) => `<span class="rg"><b>${esc(n)}</b><span class="rg-d">${v | 0}</span><span class="rg-x">${hex(v)}</span></span>`)
      .join('')}</div></div>`;
  // marks: Map(番地 → 'r' | 'w')
  function memRows(addr, bytes, marks, per = 16) {
    let h = '';
    for (let o = 0; o < bytes.length; o += per) {
      const row = Array.from(bytes.slice(o, o + per));
      const cells = row.map((b, k) => {
        const mk = marks && marks.get(addr + o + k);
        return `<span class="mb${mk ? ' is-' + mk : ''}${b ? '' : ' is-z'}">${b.toString(16).padStart(2, '0')}</span>${k === per / 2 - 1 ? '<span class="mb-gap"></span>' : ''}`;
      }).join('');
      const asc = row.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
      h += `<div class="mr"><span class="ma">${hex(addr + o)}</span><span class="mbs">${cells}</span><span class="mc-a">${esc(asc)}</span></div>`;
    }
    return h;
  }
  const memHTML = (addr, bytes, cap = 'メモリ', marks) =>
    `<div class="out-sec"><div class="out-cap">${cap}</div><div class="mem">${memRows(addr, bytes, marks)}</div></div>`;

  // ---- 回路：真理値表・タイミング表・波形
  let waveSeq = 0;
  function waveSVG(wave) {
    const id = 'wv' + ++waveSeq;
    const PAD = 14, CW = 40, RH = 34, AMP = 18;
    const N = Math.max(1, ...wave.map((s) => (s.values ? s.values.length : 0)));
    const nameW = Math.max(...wave.map((s) => s.name.length)) * 7.9 + 14;
    const X0 = PAD + nameW, Y0 = PAD + 18, bottom = Y0 + wave.length * RH;
    const t = (x, y, s, cls, anchor = 'middle') => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}" dominant-baseline="central">${esc(s)}</text>`;
    let b = `<defs><pattern id="${id}-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="d-hatch"/></pattern></defs>`;
    for (let i = 0; i <= N; i++) b += `<line x1="${X0 + i * CW}" y1="${Y0 - 2}" x2="${X0 + i * CW}" y2="${bottom - 4}" class="d-wave-grid"/>`;
    for (let i = 0; i < N; i++) b += t(X0 + i * CW + CW / 2, PAD + 4, String(i), 'd-mono d-tiny d-muted');
    wave.forEach((s, r) => {
      const yc = Y0 + r * RH + RH / 2 - 2, hi = yc - AMP / 2, lo = yc + AMP / 2;
      b += t(X0 - 12, yc, s.name, `d-mono d-wave-name${s.kind === 'out' ? ' d-accent-t' : ''}`, 'end');
      const vals = s.values || [];
      if (s.kind === 'clock') {
        let d = `M${X0} ${lo}`;
        for (let i = 0; i < N; i++) { const x = X0 + i * CW; d += ` L${x} ${hi} L${x + CW / 2} ${hi} L${x + CW / 2} ${lo} L${x + CW} ${lo}`; }
        b += `<path d="${d}" class="d-wave-line d-wave-clk"/>`;
      } else if ((s.width || 1) > 1) {
        const SL = 4;
        for (let i = 0; i < N;) {
          const v = i < vals.length ? vals[i] : null;
          let j = i + 1;
          while (j < N && (j < vals.length ? vals[j] : null) === v) j++;
          const x0 = X0 + i * CW, x1 = X0 + j * CW, l = i === 0 ? x0 : x0 + SL, rr = j === N ? x1 : x1 - SL;
          const d = `M${x0} ${i === 0 ? hi : yc} ${i === 0 ? '' : `L${l} ${hi}`} L${rr} ${hi} ${j === N ? `L${x1} ${lo}` : `L${x1} ${yc} L${rr} ${lo}`} L${l} ${lo} Z`;
          b += `<path d="${d}" class="d-wave-bus${v === null ? ' is-x' : ''}"/>`;
          if (v === null) b += `<path d="${d}" fill="url(#${id}-hatch)" class="d-wave-xfill"/>`;
          else if (String(v).length * 7.2 < x1 - x0 - 4) b += t((x0 + x1) / 2, yc, String(v), 'd-mono d-small d-wave-val');
          i = j;
        }
      } else {
        let d = '', prev;
        for (let i = 0; i < N; i++) {
          const v = i < vals.length ? vals[i] : null, x = X0 + i * CW;
          if (v === null) {
            b += `<rect x="${x}" y="${hi}" width="${CW}" height="${AMP}" class="d-wave-bus is-x"/><rect x="${x}" y="${hi}" width="${CW}" height="${AMP}" fill="url(#${id}-hatch)" class="d-wave-xfill"/>`;
            prev = undefined;
            continue;
          }
          const y = v ? hi : lo;
          d += (prev === undefined ? ` M${x} ${y}` : ` L${x} ${y}`) + ` L${x + CW} ${y}`;
          prev = v;
        }
        if (d) b += `<path d="${d.trim()}" class="d-wave-line${s.kind === 'out' ? ' is-hl' : ''}"/>`;
      }
    });
    const W = X0 + N * CW + PAD, H = bottom + PAD - 6;
    return `<svg class="dg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="波形" xmlns="http://www.w3.org/2000/svg">${b}</svg>`;
  }

  function logicTable(r) {
    const cols = [
      ...r.inputs.map((c, i) => ({ ...c, get: (row) => row.in[i], cls: 'ci' })),
      ...r.wires.map((c, i) => ({ ...c, get: (row) => row.wire[i], cls: 'cw' })),
      ...r.outputs.map((c, i) => ({ ...c, get: (row) => row.out[i], cls: 'co' })),
    ];
    const timing = r.kind === 'timing';
    const hasPass = r.rows.some((row) => row.pass !== undefined);
    const cell = (c, v) => {
      if (v === null || v === undefined) return `<td class="${c.cls} is-q">?</td>`;
      if (c.width > 1) return `<td class="${c.cls} is-bus"><span class="vd">${LOGIC.fmt(v, c.width)}</span><span class="vb">${LOGIC.fmt(v, c.width, 'bin')}</span></td>`;
      return `<td class="${c.cls}${v ? ' is-1' : ''}">${v}</td>`;
    };
    const head = `<tr>${timing ? `<th class="cn">${r.clocked ? '周期' : '#'}</th>` : ''}${cols
      .map((c, i) => `<th class="${c.cls}${i && cols[i - 1].cls !== c.cls ? ' is-sep' : ''}">${esc(c.name)}${c.width > 1 ? `<span class="tw">[${c.width}]</span>` : ''}</th>`)
      .join('')}${hasPass ? '<th class="cp"></th>' : ''}</tr>`;
    const body = r.rows
      .map((row, k) => `<tr class="${row.unstable ? 'is-unstable' : ''}${row.pass === false ? ' is-ng' : ''}">${timing ? `<td class="cn">${k}</td>` : ''}${cols
        .map((c, i) => cell(c, c.get(row)).replace('class="', `class="${i && cols[i - 1].cls !== c.cls ? 'is-sep ' : ''}`))
        .join('')}${hasPass ? `<td class="cp">${row.pass === undefined ? '' : row.pass ? '<span class="ok">✓</span>' : '<span class="ng">✗</span>'}</td>` : ''}</tr>`)
      .join('');
    return `<div class="tt-wrap"><table class="tt">${`<thead>${head}</thead><tbody>${body}</tbody>`}</table></div>`;
  }
  const KIND_JA = { and: 'AND', or: 'OR', not: 'NOT', xor: 'XOR', nand: 'NAND', nor: 'NOR', xnor: 'XNOR', mux: 'MUX', add: '加算', sub: '減算', eq: '比較' };
  function gatesText(g) {
    if (!g) return '';
    const parts = Object.entries(g.byKind).map(([k, n]) => `${KIND_JA[k] || k} ${n}`);
    return `ゲート ${g.total} 個${parts.length ? `（${parts.join('、')}）` : ''}${g.ff ? `、フリップフロップ ${g.ff} 個` : ''}`;
  }
  // r は LOGIC.run の結果（成功）。opts.cap で見出し、opts.plain で操作ボタンと数の行を省く
  function logicHTML(r, opts = {}) {
    if (!r || !r.ok) return '';
    const hasBus = [...r.inputs, ...r.outputs, ...r.wires].some((c) => c.width > 1);
    const tools = [
      hasBus ? '<button type="button" class="dbv-btn tt-bin" aria-pressed="false">2 進で表示</button>' : '',
      r.wires.length ? '<button type="button" class="dbv-btn tt-wires" aria-pressed="false">途中の線も表示</button>' : '',
    ].join('');
    const cap = opts.cap || (r.kind === 'timing' ? 'タイミング表' : '真理値表');
    const checks = (r.checks || []).filter((c) => !c.ok);
    return `<div class="out-sec lg${opts.plain ? ' is-plain' : ''}">${
      r.kind === 'timing' && r.wave && !opts.plain ? `<div class="out-cap">波形</div><div class="wave-wrap">${waveSVG(r.wave)}</div>` : ''
    }<div class="out-cap">${cap}<span class="tt-tools">${tools}</span></div>${logicTable(r)}${
      checks.length ? `<div class="out-warn">${checks.map((c) => esc(c.msg)).join('<br>')}</div>` : ''
    }${(r.warnings || []).length && !opts.plain ? `<div class="out-warn">${r.warnings.map((w) => esc(w.msg)).join('<br>')}</div>` : ''}</div>`;
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.tt-bin, .tt-wires');
    if (!b) return;
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    b.closest('.lg').classList.toggle(b.classList.contains('tt-bin') ? 'is-bin' : 'show-wires', on);
  });

  // ---- パイプラインとキャッシュ
  const PRED_JA = { none: '常に「成立しない」と予測', taken: '常に「成立する」と予測', '1bit': '1 ビット予測', '2bit': '2 ビット予測' };
  // [見出し, 値, クラス, 補足]
  const facts = (list) => `<div class="facts">${list.filter(Boolean).map(([k, v, cls, sub]) => `<div class="fact${cls ? ' ' + cls : ''}"><b>${v}</b><span>${k}</span>${sub ? `<small>${sub}</small>` : ''}</div>`).join('')}</div>`;
  function pipelineHTML(m) {
    const p = m.pipeline;
    if (!p) return '';
    const s = p.stats;
    const SHOW = 16;
    const rows = p.rows.slice(0, SHOW);
    const maxC = Math.max(1, ...rows.map((r) => Math.max(0, ...r.cells.map((c) => c.c))));
    const head = `<tr><th class="pl">命令</th>${Array.from({ length: maxC }, (_, i) => `<th>${i + 1}</th>`).join('')}</tr>`;
    const body = rows.map((r) => {
      const by = {};
      r.cells.forEach((c) => { by[c.c] = c; });
      let tds = '';
      for (let c = 1; c <= maxC; c++) {
        const x = by[c];
        tds += x ? `<td class="ps ps-${x.s}${x.wait ? ' is-wait' : ''}${r.squashed ? ' is-sq' : ''}">${x.wait ? '—' : x.s}</td>` : '<td></td>';
      }
      const note = r.squashed ? '捨てた' : r.stall ? `${r.stallKind === 'loadUse' ? 'ロード待ち' : r.stallReg + ' 待ち'} ${r.stall}` : r.mispredict ? '予測外れ' : '';
      return `<tr class="${r.squashed ? 'is-sq' : ''}"><th class="pl" title="${esc(hex(r.pc))}"><code>${esc(r.squashed && !r.word ? '（命令なし）' : r.asm)}</code>${note ? `<span class="pn">${esc(note)}</span>` : ''}</th>${tds}</tr>`;
    }).join('');
    return `<div class="out-sec"><div class="out-cap">パイプライン（${s.forwarding ? 'フォワーディングあり' : 'フォワーディングなし'}、${PRED_JA[s.predictor] || s.predictor}）</div>${facts([
      ['命令', fmtN(s.instructions)],
      ['サイクル', fmtN(s.cycles)],
      ['CPI', s.cpi.toFixed(2), 'is-hl'],
      ['停止したサイクル', fmtN(s.stalls.total), '', `ロード使用 ${fmtN(s.stalls.loadUse)}・データ待ち ${fmtN(s.stalls.data)}`],
      ['捨てたサイクル', fmtN(s.flushCycles), '', `分岐 ${fmtN(s.branches)} 回のうち予測外れ ${fmtN(s.mispredicts)} 回、ジャンプ ${fmtN(s.jumps)} 回`],
    ])}<div class="pp-wrap"><table class="pp"><thead>${head}</thead><tbody>${body}</tbody></table></div>${
      p.rows.length > SHOW || s.instructions > rows.filter((r) => !r.squashed).length ? `<div class="out-foot">最初の ${rows.filter((r) => !r.squashed).length} 命令だけ図にしています。— は停止、取り消し線は捨てられた命令です。</div>` : '<div class="out-foot">— は停止、取り消し線は捨てられた命令です。</div>'
    }</div>`;
  }
  function cacheHTML(m) {
    const c = m.cache;
    if (!c) return '';
    const s = c.stats, SHOW = 200;
    const hist = c.history.slice(0, SHOW);
    const body = hist.map((h) => `<tr class="${h.hit ? 'is-hit' : 'is-miss'}"><td class="num">${h.n}</td><td>${hex(h.addr, 4)}</td><td>${h.write ? '書く' : '読む'}</td><td class="num">${h.set}</td><td>${hex(h.tag, 2)}</td><td class="hm">${h.hit ? 'ヒット' : 'ミス'}</td><td>${h.evicted === null || h.evicted === undefined ? '' : hex(h.evicted, 4) + ' を追い出す'}</td></tr>`).join('');
    const t = m.timing;
    return `<div class="out-sec"><div class="out-cap">キャッシュ（容量 ${s.size} バイト、ブロック ${s.block} バイト、${s.ways === 1 ? 'ダイレクトマップ' : s.ways + ' ウェイ'}、${s.sets} セット）</div>${facts([
      ['アクセス', fmtN(s.accesses)],
      ['ヒット', fmtN(s.hits)],
      ['ミス', fmtN(s.misses)],
      ['ヒット率', (s.hitRate * 100).toFixed(1) + '%', 'is-hl'],
      ['ミスで待ったサイクル', fmtN(s.penalty), '', `ミス 1 回につき ${s.missPenalty} サイクル`],
      ['合計のサイクル', fmtN(t.cycles), '', `CPI ${t.cpi.toFixed(2)}`],
    ])}${hist.length ? `<details class="ch-fold"><summary>アクセスの履歴（${c.history.length > SHOW ? `最初の ${SHOW} 件` : `${hist.length} 件`}）</summary><div class="tt-wrap"><table class="tt ch"><thead><tr><th class="num">#</th><th>番地</th><th></th><th class="num">セット</th><th>タグ</th><th></th><th></th></tr></thead><tbody>${body}</tbody></table></div></details>` : ''}</div>`;
  }

  // ---- エラー
  const errBox = (kind, lines) => `<div class="out-err"><div class="err-h"><span class="err-sev">${kind}</span></div>${lines.map((l) => `<div class="err-l">${esc(l)}</div>`).join('')}</div>`;

  // ---------------------------------------------------------------- 実行
  const initialRegs = (prog) => RV.machine().load(prog).regs.slice();
  function changedRegs(m, prog) {
    const init = initialRegs(prog), out = [];
    for (let i = 1; i < 32; i++) if (m.regs[i] !== init[i]) out.push([RV.REG_NAMES[i], m.regs[i]]);
    return out;
  }
  // 実行の結果（アニメーション以外）を HTML にする。r は GRADE.runBlock の戻り値
  function asmResultHTML(r, p, opts = {}) {
    if (!r.asm.machine) return errBox('アセンブルエラー', r.asm.errors.map((e) => e.text));
    const m = r.asm.machine, res = r.asm.result;
    let h = '';
    if (m.screenUsed && !opts.noScreen) h += `<div class="out-sec"><div class="out-cap">画面</div><div class="scr-wrap">${screenHTML(m.screen)}</div></div>`;
    if (m.console) h += consoleHTML(m.console);
    if (r.failed) h += errBox('実行時エラー', [res.message]);
    if (p.attrs.regs) {
      h += regsHTML(p.attrs.regs.split(',').map((s) => s.trim()).filter((n) => RV.regIndex(n) >= 0).map((n) => [n, m.regs[RV.regIndex(n)]]));
    } else {
      const ch = changedRegs(m, r.asm.prog);
      if (ch.length) h += regsHTML(ch, '変化したレジスタ');
    }
    if (p.attrs.mem) {
      const [a, n] = p.attrs.mem.split(',').map((s) => Number(s.trim()));
      if (a >= 0 && n > 0 && a + n <= m.mem.length) h += memHTML(a, m.mem.slice(a, a + n), `メモリ（${hex(a)} から ${n} バイト）`);
    }
    h += pipelineHTML(m) + cacheHTML(m);
    return h;
  }
  const metaHTML = (r, extra = '') => {
    const m = r.asm.machine;
    const kind = r.failed ? 'bad' : r.ok ? 'ok' : 'warn';
    return `<div class="out-meta"><span class="st is-${kind}">${esc(r.failed && !m ? 'アセンブルできませんでした' : r.failed ? 'エラーで止まりました' : r.message)}</span>${m ? `<span>${fmtN(m.steps)} 命令</span>` : ''}${extra}</div>`;
  };

  function stopAnim(box) {
    const a = box._anim;
    if (!a) return;
    cancelAnimationFrame(a.raf);
    a.running = false;
    box.classList.remove('is-anim');
  }
  let animBox = null;

  function startAnim(box, r, p) {
    const out = $('.out', box), m = r.asm.machine;
    out.innerHTML = `<div class="out-sec anim"><div class="scr-wrap is-live" tabindex="0" aria-label="画面。ここをクリックするとキー入力を受け取ります">${'<canvas class="scr" width="32" height="32"></canvas>'}</div><div class="anim-side"><div class="anim-ctl"><button type="button" class="dbv-btn anim-stop">停止</button><span class="anim-n"></span></div><div class="pad" aria-label="方向キー"><button type="button" data-k="ArrowUp" aria-label="上">↑</button><button type="button" data-k="ArrowLeft" aria-label="左">←</button><button type="button" data-k="ArrowDown" aria-label="下">↓</button><button type="button" data-k="ArrowRight" aria-label="右">→</button></div><p class="anim-hint">画面をクリックすると、キーボードの入力がプログラムに届きます。</p></div></div><div class="anim-con"></div><div class="anim-end"></div>`;
    const canvas = $('canvas', out), wrap = $('.scr-wrap', out), nEl = $('.anim-n', out), stopBtn = $('.anim-stop', out), con = $('.anim-con', out), end = $('.anim-end', out);
    if (animBox && animBox !== box) stopAnim(animBox);
    animBox = box;
    const a = (box._anim = { m, raf: 0, running: true, last: 0 });
    let conLen = -1;
    const show = (res) => {
      drawScreen(canvas, m.screen);
      nEl.textContent = `${fmtN(m.frames)} フレーム・${fmtN(m.steps)} 命令`;
      if (m.console.length !== conLen) { conLen = m.console.length; con.innerHTML = m.console ? consoleHTML(m.console.length > 4000 ? '…' + m.console.slice(-4000) : m.console) : ''; }
      if (res && res.reason !== 'frame' && res.reason !== 'limit') {
        a.running = false;
        box.classList.remove('is-anim');
        stopBtn.hidden = true;
        const failed = res.reason === 'error';
        box.dataset.result = failed ? 'error' : 'ok';
        if (failed && res.error && res.error.line) paint(box, { err: [res.error.line] });
        end.innerHTML = (failed ? errBox('実行時エラー', [res.message]) : '') + `<div class="out-meta"><span class="st is-${failed ? 'bad' : 'ok'}">${esc(failed ? 'エラーで止まりました' : res.message)}</span><span>${fmtN(m.steps)} 命令</span></div>`;
      }
    };
    const tick = (now) => {
      if (!a.running) return;
      a.raf = requestAnimationFrame(tick);
      if (now - a.last < 15) return; // 1 秒に 60 フレームまで
      a.last = now;
      show(m.run({ until: 'frame' }));
    };
    const setRun = (on) => {
      a.running = on;
      box.classList.toggle('is-anim', on);
      stopBtn.textContent = on ? '停止' : '再開';
      cancelAnimationFrame(a.raf);
      if (on) { if (animBox && animBox !== box) stopAnim(animBox); animBox = box; a.raf = requestAnimationFrame(tick); }
    };
    a.setRun = setRun;
    stopBtn.addEventListener('click', () => setRun(!a.running));
    bindKeys(wrap, () => m);
    $$('.pad button', out).forEach((b) => {
      const code = RV.keyCode(b.dataset.k);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); m.keyDown(code); });
      const up = () => m.keyUp(code);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointerleave', up);
      b.addEventListener('pointercancel', up);
    });
    show(r.asm.result);
    if (a.running) { box.classList.add('is-anim'); a.raf = requestAnimationFrame(tick); }
    return a;
  }
  // 画面の枠にフォーカスがある間、キー入力を機械に渡す
  function bindKeys(wrap, getMachine) {
    wrap.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const code = RV.keyCode(e.key), m = getMachine();
      if (!code || !m) return;
      e.preventDefault();
      if (!e.repeat) m.keyDown(code);
    });
    wrap.addEventListener('keyup', (e) => {
      const code = RV.keyCode(e.key), m = getMachine();
      if (code && m) m.keyUp(code);
    });
  }

  function runBox(box) {
    const ta = $('.ed-ta', box), out = $('.out', box);
    const lang = langOf(box), info = box.dataset.info || `${lang} run`;
    const p = GRADE.parseInfo(info);
    const src = ta.value;
    stopAnim(box);
    box._anim = null;
    out.hidden = false;
    if (lang === 'logic') {
      const r = GRADE.runBlock('logic', src, p);
      box.dataset.result = r.failed ? 'error' : 'ok';
      if (r.failed) {
        const errs = r.logic.result.errors;
        paint(box, { err: errs.map((e) => e.line).filter(Boolean) });
        out.innerHTML = errBox('回路のエラー', errs.map((e) => e.msg));
      } else {
        paint(box, null);
        out.innerHTML = logicHTML(r.logic.result) + `<div class="out-meta"><span class="st is-ok">${esc(gatesText(r.logic.result.gates))}</span><span>${r.logic.result.rows.length} 行</span></div>`;
      }
      window.dispatchEvent(new CustomEvent('cpu-ran', { detail: { box, lang, src, info, result: r } }));
      return r;
    }
    const anim = p.flags.has('anim');
    const r = GRADE.runBlock('asm', src, p, anim ? { until: 'frame' } : undefined);
    box.dataset.result = r.failed ? 'error' : r.ok ? 'ok' : 'unfinished';
    const errLines = !r.asm.machine ? r.asm.errors.map((e) => e.line) : r.failed && r.asm.result.error && r.asm.result.error.line ? [r.asm.result.error.line] : [];
    paint(box, errLines.length ? { err: errLines } : null);
    const canStep = !!r.asm.machine && !!window.CPUVIEW;
    if (anim && r.asm.machine && !r.failed) {
      startAnim(box, r, p);
    } else if (p.flags.has('step') && canStep) {
      out.innerHTML = '<div class="cv-inline"></div>';
      window.CPUVIEW.mount($('.cv-inline', out), { box, src, info });
    } else {
      out.innerHTML = asmResultHTML(r, p) + metaHTML(r, canStep ? '<button type="button" class="dbv-btn out-step">ステップ実行で見る</button>' : '');
      hydrate(out);
      const sb = $('.out-step', out);
      if (sb) sb.addEventListener('click', () => window.CPUVIEW.openPanel({ box, src: ta.value, info }));
    }
    window.dispatchEvent(new CustomEvent('cpu-ran', { detail: { box, lang, src, info, result: r } }));
    return r;
  }

  $$('.cpurun').forEach((box) => {
    bindEditor(box, () => runBox(box));
    $('.run-btn', box).addEventListener('click', () => runBox(box));
  });
  // ページを離れている間はアニメーションを止める（戻ったら続きから）
  document.addEventListener('visibilitychange', () => {
    const a = animBox && animBox._anim;
    if (a && a.setRun && document.hidden && a.running) { a.setRun(false); a.auto = true; }
    else if (a && a.setRun && !document.hidden && a.auto) { a.auto = false; a.setRun(true); }
  });

  window.CPUUI = {
    esc, hex, fmtN, paint, bindEditor, setSource, drawScreen, screenHTML, hydrate, consoleHTML, regsHTML, memRows, memHTML,
    logicHTML, logicTable, waveSVG, gatesText, pipelineHTML, cacheHTML, errBox, asmResultHTML, changedRegs, initialRegs, bindKeys, runBox, stopAnim,
  };
})();
