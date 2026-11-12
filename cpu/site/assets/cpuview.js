// 「CPU を見る」：プログラムを 1 命令ずつ進めて、レジスタ・命令のビット・メモリ・画面・コンソールを見せる部品。
// 3 か所で使う：画面の下のパネル（直前に実行したブロック）、step の印のブロックの出力欄、実験場。
//   CPUVIEW.mount(host, { box, src, info, big }) → 操作用のオブジェクト
//   CPUVIEW.openPanel({ box, src, info })         下のパネルを開いて読み込む
(() => {
  const RV = window.RV, GRADE = window.GRADE, UI = window.CPUUI;
  if (!RV || !UI) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const { esc, hex, fmtN } = UI;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const HISTORY = 300; // 「戻る」ために溜めておく状態の数（1 つ約 70 KB）
  const DATA = RV.MAP.DATA_BASE, TOP = RV.MAP.STACK_TOP;
  const FIELD_JA = { opcode: '命令の種類', rd: '結果の入れ先', rs1: '読むレジスタ 1', rs2: '読むレジスタ 2', funct3: '細かい種類', funct7: '細かい種類', imm: '即値', shamt: 'シフト量', csr: 'CSR' };

  // step() の戻り値を、日本語の 1 行にする
  function describe(st, prog) {
    const at = (a) => { const l = prog.labelAt(a); return l ? `${l}（${hex(a, 4)}）` : hex(a, 4); };
    const parts = [];
    if (st.trap) parts.push(`例外「${st.trap.causeName}」が起きて、ハンドラ（${hex(st.trap.handler, 4)}）へ飛んだ`);
    st.mem.forEach((a) => {
      if (a.region === 'io') return;
      if (a.region === 'screen') { if (a.rw === 'r') parts.push(`画面のメモリ ${hex(a.addr, 5)} を読んだ（値 ${a.value}）`); return; }
      parts.push(a.rw === 'r' ? `メモリ ${hex(a.addr, 4)} 番地から ${a.width} バイト読んだ（値 ${a.value}）` : `メモリ ${hex(a.addr, 4)} 番地に ${a.width} バイト書いた（値 ${a.value}）`);
    });
    st.io.forEach((io) => {
      if (io.type === 'console') parts.push(`コンソールに ${JSON.stringify(io.text)} を出した`);
      else if (io.type === 'screen') parts.push(`画面の (${io.x}, ${io.y}) に色 ${io.color}（${RV.PALETTE_NAMES[io.color & 15]}）を置いた`);
      else if (io.type === 'frame') parts.push('1 フレームぶんの絵を描き終えた');
      else if (io.type === 'key') parts.push(io.code ? `キーボードからコード ${io.code} を読んだ` : 'キーボードを読んだ（押されていない）');
      else if (io.type === 'random') parts.push('乱数を読んだ');
      else if (io.type === 'cycle') parts.push('命令数のカウンタを読んだ');
    });
    st.writes.forEach((w) => parts.push(`${w.name} ← ${w.after}（${hex(w.after)}）`));
    if (st.branch && !st.trap) {
      if (st.cls === 'branch') parts.push(st.branch.taken ? `条件が成り立ったので ${at(st.branch.target)} へ分岐した` : '条件が成り立たないので、次の命令へ進んだ');
      else parts.push(`${at(st.branch.target)} へジャンプした`);
    }
    if (st.reason && st.result) parts.push(st.reason === 'error' ? `エラー：${st.result.message}` : st.result.message);
    return parts.length ? parts.join('、') : '何も変えなかった';
  }

  // step() の戻り値の alu と control を、第 16 章のデータパス図・制御信号の表と同じ名前で見せる
  const ALU_OP = { '-': '−', '==': '−', '!=': '−', '<u': '<（符号なし）', '>=': '≥', '>=u': '≥（符号なし）', '>>u': '>>（論理）', '>>': '>>（算術）', '*': '×', '*h': '×（上位 32 ビット）', '*hsu': '×（上位 32 ビット）', '*hu': '×（上位 32 ビット・符号なし）', '/': '÷', '/u': '÷（符号なし）', '%': '余り', '%u': '余り（符号なし）', '&': 'AND', '|': 'OR', '^': 'XOR' };
  const CTL = [['regWrite', 'RegWrite'], ['aluSrc', 'ALUSrc'], ['memRead', 'MemRead'], ['memWrite', 'MemWrite'], ['memToReg', 'MemToReg'], ['branch', 'Branch']];
  function datapathHTML(st) {
    if (!st || st.summary || (!st.alu && !st.control)) return '';
    const c = st.control, al = st.alu;
    let h = '';
    if (al) {
      // 番地を扱う命令（ロード・ストア・ジャンプ・lui・auipc）は 16 進、それ以外は 10 進
      const addrLike = st.cls === 'load' || st.cls === 'store' || st.cls === 'jump' || st.name === 'lui' || st.name === 'auipc';
      const num = (v) => (addrLike && (v > 9 || v < 0) ? '0x' + (v >>> 0).toString(16) : String(v));
      const r1 = st.name === 'auipc' || st.name === 'jal' ? 'PC' : st.reads[0] ? st.reads[0].name : '';
      const r2 = c && c.aluSrc === 'rs2' ? (st.reads[1] ? st.reads[1].name : '') : '即値';
      const val = (v, from) => `${num(v)}${from ? `<span class="cv-from">（${from}）</span>` : ''}`;
      const opTxt = ALU_OP[al.op] || al.op;
      let body, extra = '', noteTxt = '';
      if (st.name === 'lui') body = `即値 ${num(al.b)} をそのまま通す`;
      else if (st.name === 'beq' || st.name === 'bne') {
        // rv.js は「成立なら 1」を返すが、図は「引き算をして zero を見る」なので、図のほうに合わせて見せる
        const diff = (al.a - al.b) | 0, z = diff === 0 ? 1 : 0;
        body = `${val(al.a, r1)} − ${val(al.b, r2)} = ${diff}`;
        extra = `<span class="cs${z ? ' is-1' : ''}">zero ${z}</span>`;
        noteTxt = st.name === 'beq' ? `引き算の結果が 0 のとき zero が 1 になる。beq は zero が 1 なら分岐する（今回は${al.result ? '分岐する' : '分岐しない'}）` : `bne は beq の逆で、zero が 0 なら分岐する（今回は${al.result ? '分岐する' : '分岐しない'}）`;
      } else if (st.cls === 'branch') {
        body = `${val(al.a, r1)} ${opTxt} ${val(al.b, r2)}`;
        extra = `<span class="cs${al.result ? ' is-1' : ''}">比較の結果 ${al.result}</span>`;
        noteTxt = `${st.name} は、zero の代わりにこの比較の結果を使う（1 なら分岐する）`;
      } else {
        body = `${val(al.a, r1)} ${opTxt} ${val(al.b, r2)}${al.result === null ? '' : ` = ${num(al.result)}`}`;
        if (al.result === null) noteTxt = '結果の入れ先が zero なので、結果は捨てられる';
        else if (st.cls === 'load' || st.cls === 'store') noteTxt = 'ALU の結果は、読み書きする番地';
        else if (st.name === 'jal') noteTxt = 'jal の飛び先は、ALU ではなく分岐先用の加算器（PC + 即値）が作る';
        else if (st.name === 'jalr') noteTxt = 'ALU の結果が飛び先。レジスタには PC + 4 を書く';
      }
      const head = st.name === 'jal' ? '加算器' : 'ALU';
      h += `<div class="cv-dpr"><span class="cv-k">${head}</span><code class="cv-alu">${body}</code>${st.name === 'jal' || st.name === 'lui' ? '' : `<span class="cs is-op">ALUOp ${esc(st.cls === 'branch' && opTxt !== '−' ? '比較' : opTxt.replace(/（.*$/, ''))}</span>`}${extra}</div>`;
      if (noteTxt) h += `<p class="cv-dpn">${esc(noteTxt)}</p>`;
    }
    if (c) {
      const bit = (k) => (k === 'aluSrc' ? (c.aluSrc === 'imm' ? 1 : 0) : c[k] ? 1 : 0);
      const list = CTL.map(([k, n]) => [n, bit(k)]);
      if (c.jump) list.push(['Jump', 1]);
      h += `<div class="cv-dpr"><span class="cv-k">制御信号</span><span class="cs-list">${list.map(([n, v]) => `<span class="cs${v ? ' is-1' : ''}">${n} ${v}</span>`).join('')}</span></div>`;
    }
    return `<div class="cv-dp" aria-label="直前の命令の ALU と制御信号">${h}</div>`;
  }

  function mount(host, opts = {}) {
    const big = !!opts.big;
    host.innerHTML = `<div class="cv${big ? ' is-big' : ''}">
      <div class="cv-bar">
        <div class="cv-btns" role="group" aria-label="ステップ実行">
          <button type="button" class="dbv-btn" data-a="reset" title="最初の状態に戻す">最初から</button>
          <button type="button" class="dbv-btn" data-a="back" title="1 命令ぶん戻す">戻る</button>
          <button type="button" class="dbv-btn is-main" data-a="step" title="次の 1 命令だけ実行する">1 命令進む</button>
          <button type="button" class="dbv-btn" data-a="end" title="終わるまで（画面を使うプログラムは 1 フレーム描くまで）実行する">最後まで</button>
        </div>
        <span class="cv-pos"></span>
        <button type="button" class="dbv-btn cv-base" title="レジスタの値を 10 進 / 16 進で切り替える"></button>
      </div>
      <div class="cv-msg" hidden></div>
      <div class="cv-grid">
        <section class="cv-sec cv-ins"></section>
        <section class="cv-sec cv-regs"><h4>レジスタ</h4><div class="rc-grid"></div></section>
        <section class="cv-sec cv-mem"><h4>メモリ</h4><div class="cv-memb"></div></section>
        <section class="cv-sec cv-io"><div class="cv-scr" hidden><h4>画面</h4><div class="scr-wrap" tabindex="0" aria-label="画面。ここをクリックするとキー入力を受け取ります"><canvas class="scr" width="32" height="32"></canvas></div></div><div class="cv-con" hidden><h4>コンソール</h4><pre class="out-console"></pre></div></section>
      </div>
    </div>`;
    const el = $('.cv', host);
    const insEl = $('.cv-ins', el), regsEl = $('.rc-grid', el), memEl = $('.cv-memb', el), posEl = $('.cv-pos', el), msgEl = $('.cv-msg', el);
    const scrBox = $('.cv-scr', el), canvas = $('canvas', el), conBox = $('.cv-con', el), conPre = $('.cv-con pre', el), baseBtn = $('.cv-base', el);
    const btn = (a) => $(`[data-a="${a}"]`, el);
    let base = store.get('zc-cv-base', 'dec');
    let box = opts.box || null, src = '', info = 'asm run';
    let prog = null, m = null, hist = [], last = null, note = '', raf = 0, running = false;

    const marksOK = () => box && $('.ed-ta', box).value === src;
    function markSource() {
      if (!marksOK()) return;
      const cur = m && !m.halted ? prog.lineOf(m.pc) : 0;
      UI.paint(box, { cur, prev: last && last.line ? last.line : 0, err: m && m.halted && m.halted.reason === 'error' && m.halted.error.line ? [m.halted.error.line] : [] });
      // 長いプログラムでは、いまの行がエディタの中で見えるようにする
      const ed = $('.ed', box);
      const line = cur ? $(`.ed-hl .el:nth-child(${cur})`, box) : null;
      if (line && ed.scrollHeight > ed.clientHeight + 4) {
        const t = line.offsetTop, h = line.offsetHeight;
        if (t < ed.scrollTop + 8 || t + h > ed.scrollTop + ed.clientHeight - 8) ed.scrollTop = Math.max(0, t - ed.clientHeight / 2);
      }
    }

    function insHTML() {
      let h = '';
      if (m.halted) {
        const r = m.halted;
        h += `<h4>終わり</h4><p class="cv-halt is-${r.reason === 'error' ? 'bad' : 'ok'}">${esc(r.message)}</p>`;
      } else {
        const pc = m.pc, word = m.read32(pc);
        const d = RV.decode(word === null ? 0 : word, pc);
        const line = prog.lineOf(pc);
        const asm = RV.disasm(d.word, pc, { symbols: prog.symbols });
        h += `<h4>次に実行する命令</h4><div class="cv-now"><span class="cv-pc">pc <b>${hex(pc)}</b></span><code class="cv-asm">${HLasm(asm)}</code>${line ? `<span class="cv-line">${line} 行目</span>` : ''}</div>`;
        h += `<div class="bf-row" aria-label="機械語 ${d.hex}">${d.fields.map((f) => `<span class="bf bf-${f.kind}" title="${esc(FIELD_JA[f.kind] || f.kind)}"><span class="bf-b">${f.bits}</span><span class="bf-n">${esc(f.name)}</span><span class="bf-v">${esc(f.text || String(f.value))}</span></span>`).join('')}</div>`;
        h += `<div class="cv-word">機械語 <code>${d.hex}</code>${d.format ? `・${d.format} 形式` : ''}</div>`;
      }
      const did = last ? (last.summary ? last.summary : `<code>${esc(last.asm)}</code>：${esc(describe(last, prog))}`) : 'まだ 1 命令も実行していません。「1 命令進む」を押してください。';
      h += `<h4>直前の命令がしたこと</h4><p class="cv-did">${did}</p>`;
      h += datapathHTML(last);
      return h;
    }
    const HLasm = (s) => window.HL.asmLine(s);

    function regsHTML() {
      const w = new Set(), r = new Set();
      if (last && last.writes) { last.writes.forEach((x) => w.add(x.reg)); last.reads.forEach((x) => r.add(x.reg)); }
      let h = '';
      for (let i = 0; i < 32; i++) {
        const v = m.regs[i];
        h += `<div class="rc${w.has(i) ? ' is-w' : r.has(i) ? ' is-r' : ''}${v ? '' : ' is-z'}" title="x${i}"><span class="rn">${RV.REG_NAMES[i]}</span><span class="rv">${base === 'hex' ? hex(v).slice(2) : v}</span></div>`;
      }
      return h;
    }

    function memHTML() {
      const marks = new Map();
      const hits = [];
      if (last && last.mem) last.mem.forEach((a) => { if (a.region !== 'ram') return; hits.push(a.addr); for (let k = 0; k < a.width; k++) marks.set(a.addr + k, a.rw); });
      const wins = [];
      const dlen = Math.max(32, Math.min(128, Math.ceil((prog.dataEnd - DATA) / 16) * 16));
      wins.push({ cap: `.data（${hex(DATA, 4)} から）`, a: DATA, n: dlen });
      const sp = m.regs[2] >>> 0;
      let sa = TOP - 32;
      if (sp <= TOP && sp >= TOP - 4096) sa = Math.min(sa, Math.max(sp & ~15, TOP - 128));
      wins.push({ cap: `スタック（sp = ${hex(sp, 5)}）`, a: sa, n: TOP - sa });
      const inWin = (a) => wins.some((w) => a >= w.a && a < w.a + w.n);
      const far = hits.find((a) => !inWin(a));
      if (far !== undefined) { const a = Math.min(far & ~15, m.mem.length - 32); wins.push({ cap: `直前に読み書きした所（${hex(far, 4)}）`, a, n: 32 }); }
      // 欄が狭いとき（下のパネルの 3 列目、幅の狭い画面）は 1 行 8 バイトにして、右端で切れないようにする
      const per = memEl.clientWidth >= 580 ? 16 : 8;
      return wins.map((w) => `<div class="cv-cap">${w.cap}</div><div class="mem">${UI.memRows(w.a, m.mem.slice(w.a, w.a + w.n), marks, per)}</div>`).join('');
    }

    function render() {
      if (!m) return;
      insEl.innerHTML = insHTML();
      regsEl.innerHTML = regsHTML();
      memEl.innerHTML = memHTML();
      const showScr = big || m.screenUsed;
      scrBox.hidden = !showScr;
      if (showScr) UI.drawScreen(canvas, m.screen);
      const showCon = big || !!m.console;
      conBox.hidden = !showCon;
      if (showCon && conPre.textContent !== m.console) { conPre.textContent = m.console; conPre.scrollTop = conPre.scrollHeight; }
      posEl.textContent = `${fmtN(m.steps)} 命令を実行${note ? '・' + note : ''}`;
      baseBtn.textContent = base === 'hex' ? '10 進で表示' : '16 進で表示';
      btn('back').disabled = !hist.length || running;
      btn('step').disabled = !!m.halted || running;
      btn('end').disabled = !!m.halted || running;
      btn('reset').disabled = running;
      markSource();
      if (opts.onChange) opts.onChange(api);
    }

    function load(o = {}) {
      stop();
      if (o.box !== undefined) box = o.box;
      src = o.src !== undefined ? o.src : box ? $('.ed-ta', box).value : src;
      info = o.info || info;
      prog = RV.assemble(src);
      hist = []; last = null; note = '';
      if (!prog.ok) {
        m = null;
        el.classList.add('is-error');
        msgEl.hidden = false;
        msgEl.innerHTML = UI.errBox('アセンブルエラー', prog.errors.map((e) => e.text));
        if (marksOK()) UI.paint(box, { err: prog.errors.map((e) => e.line) });
        if (opts.onChange) opts.onChange(api);
        return false;
      }
      el.classList.remove('is-error');
      msgEl.hidden = true;
      const mo = GRADE.machineOpts(GRADE.parseInfo(info));
      m = RV.machine({ seed: mo.seed, maxSteps: mo.maxSteps });
      m.load(prog);
      render();
      return true;
    }
    const push = () => { hist.push({ s: m.snapshot(), last, note }); if (hist.length > HISTORY) hist.shift(); };
    function step() {
      if (!m || m.halted) return;
      push();
      last = m.step();
      note = '';
      render();
    }
    function back() {
      const h = hist.pop();
      if (!h) return;
      m.restore(h.s);
      last = h.last; note = h.note;
      render();
    }
    function toEnd() {
      if (!m || m.halted) return;
      push();
      const before = m.steps;
      const r = m.run({ until: 'frame' });
      last = { summary: `${fmtN(m.steps - before)} 命令をまとめて実行しました。${esc(r.reason === 'frame' ? '1 フレーム描いたところで止めています。' : r.message)}` };
      note = '';
      render();
    }
    function reset() { if (prog && prog.ok) { stop(); m.load(prog); hist = []; last = null; note = ''; render(); } }

    // 連続実行（実験場）。speed = 1 フレームあたりの命令数
    function stop() {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf);
      el.classList.remove('is-running');
      if (m) render();
    }
    function run(getSpeed) {
      if (!m || m.halted || running) return;
      running = true;
      el.classList.add('is-running');
      hist = [];
      let lastT = 0;
      const tick = (now) => {
        if (!running) return;
        raf = requestAnimationFrame(tick);
        if (now - lastT < 15) return;
        lastT = now;
        const speed = Math.max(1, getSpeed());
        if (speed === 1) { last = m.step(); }
        else {
          const before = m.steps;
          const r = m.run({ until: 'frame', limit: speed });
          last = { summary: `連続実行中（このフレームで ${fmtN(m.steps - before)} 命令）` };
          if (r.reason !== 'frame' && r.reason !== 'limit') last = { summary: esc(r.message) };
        }
        if (m.halted) { stop(); return; }
        render();
      };
      render();
      raf = requestAnimationFrame(tick);
    }

    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b || b.disabled) return;
      ({ reset, back, step, end: toEnd })[b.dataset.a]();
    });
    baseBtn.addEventListener('click', () => { base = base === 'hex' ? 'dec' : 'hex'; store.set('zc-cv-base', base); render(); });
    UI.bindKeys($('.scr-wrap', el), () => m);

    const api = {
      load, step, back, toEnd, reset, run, stop,
      get machine() { return m; }, get prog() { return prog; }, get running() { return running; }, get ok() { return !!m; }, get box() { return box; }, get src() { return src; },
      el,
    };
    if (opts.src !== undefined || opts.box) load({ src: opts.src, info: opts.info });
    return api;
  }

  // ---------------------------------------------------------------- 画面の下のパネル
  const panel = document.getElementById('cpuv');
  const openBtn = document.querySelector('.db-view');
  let view = null, lastRun = null;
  let openPanel = () => {};
  if (panel && openBtn) {
    const body = $('.dbv-b', panel), titleEl = $('.cv-title', panel);
    const root = document.documentElement;
    const clampH = (h) => Math.round(Math.max(160, Math.min(window.innerHeight * 0.85, h)));
    let height = store.get('zc-cv-h', 0);
    const applyH = () => root.style.setProperty('--dbv-h', clampH(height || window.innerHeight * (window.innerWidth <= 900 ? 0.5 : 0.42)) + 'px');
    const titleOf = (o) => {
      const t = o.box && $('.code-file', o.box);
      return t && !t.classList.contains('is-lang') ? t.textContent : 'プログラム';
    };
    const show = (o) => {
      if (!o) {
        const first = $$('.cpurun[data-lang="asm"]').find((b) => !/\berror\b/.test(b.dataset.info || ''));
        if (first) o = { box: first, src: $('.ed-ta', first).value, info: first.dataset.info };
      }
      if (!o) { body.innerHTML = '<p class="dbv-pad muted">このページには、実行できるアセンブリのプログラムがありません。</p>'; titleEl.textContent = ''; return; }
      titleEl.textContent = titleOf(o);
      if (!view) { body.innerHTML = '<div class="cv-host"></div>'; view = mount($('.cv-host', body), {}); }
      view.load(o);
    };
    const setOpen = (on, o) => {
      panel.hidden = !on;
      openBtn.setAttribute('aria-pressed', String(on));
      document.body.classList.toggle('dbv-open', on);
      if (on) { applyH(); show(o || lastRun); }
      else if (view && view.box) { view.stop(); UI.paint(view.box, null); }
    };
    openPanel = (o) => setOpen(true, o);
    openBtn.addEventListener('click', () => setOpen(panel.hidden));
    $('.dbv-close', panel).addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden && panel.contains(document.activeElement)) { setOpen(false); openBtn.focus(); } });
    window.addEventListener('cpu-ran', (e) => {
      const d = e.detail;
      if (d.lang !== 'asm' || !d.result.asm.machine) return;
      if (d.box.closest('#cpuv') || d.box.classList.contains('no-panel')) return;
      lastRun = { box: d.box, src: d.src, info: d.info };
      // step の印のブロックは、出力欄にステップ実行が出るので下のパネルは動かさない
      if (!panel.hidden && !/\bstep\b/.test(d.info)) {
        if (view && view.box && view.box !== d.box) UI.paint(view.box, null);
        show(lastRun);
      }
    });
    const grip = $('.dbv-grip', panel);
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      document.body.classList.add('dbv-resizing');
      const move = (ev) => { height = clampH(window.innerHeight - ev.clientY); applyH(); };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        document.body.classList.remove('dbv-resizing');
        store.set('zc-cv-h', height);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      height = clampH((height || panel.offsetHeight) + (e.key === 'ArrowUp' ? 24 : -24));
      applyH();
      store.set('zc-cv-h', height);
    });
    window.addEventListener('resize', () => { if (!panel.hidden) applyH(); });
  }

  window.CPUVIEW = { mount, openPanel: (o) => openPanel(o), describe, datapathHTML };
})();
