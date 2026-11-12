// 本文の実行ブロックと確認問題の「意味」を 1 か所に決める（DOM を使わない）。
// 画面（ブラウザ）と、章の検査スクリプト（Node）が同じものを使うので、判定が食い違わない。
// 必要なもの：RV（rv.js）と LOGIC（logic.js）が先に読み込まれていること。
//
// ■ フェンスの属性（```asm run ...  /  ```logic run ...  の info 文字列）を opts にする
//   GRADE.parseInfo('asm run title="..." error anim regs="a0,t0" mem="0x8000,16" cache="256,16,1"')
//     → { lang, flags:Set, attrs:{} }
//
// ■ 実行ブロック 1 つを実行する
//   GRADE.runBlock(lang, src, info, extra?) → {     extra は画面用（{ until: 'frame' } でアニメーションを 1 フレームずつ進める）。検査では渡さない
//     lang, ok,                     ok = 「エラーにならずに終わった」（asm：exit / end。anim は limit / frame も可）
//     failed,                       アセンブル・実行・回路のエラーがあった（error の印と一致すべきもの）
//     asm:  { prog, machine, result, errors }   lang が asm のとき
//     logic:{ result }                          lang が logic のとき
//     message                       日本語の 1 行
//   }
//   asm の機械の設定は属性から：maxsteps="N"、seed="N"、pipeline（= true）/ pipeline="noforward"、
//   predict="none|taken|1bit|2bit"、cache="容量,ブロック,連想度"。anim の印があるブロックはアニメーション
//   （画面は frame ごとに描く）。limit の印は「命令数の上限で打ち切られる」のが正しい例、break の印は ebreak で止まる例。検査では上限まで回して止まらなくても失敗にしない。
//
// ■ 確認問題を採点する
//   GRADE.quiz(q, userSrc) → { verdict: 'ok'|'ng'|'error'|'empty', msg, exp, got, detail }
//     q = { lang:'asm'|'logic', answer, given, info }    info は answer のフェンスの info 文字列
//   asm：模範解答と読者のプログラム（どちらも後ろに given を連結）を新しい機械で実行し、比べる。
//     比べるもの（answer の属性）：既定はコンソールの出力。regs="a0,a1" / mem="0x8000,16" / screen を書くと
//     それを比べる（console の印を足すとコンソールも）。exit コードは exit の印で比べる。
//   logic：LOGIC.grade。属性 only="nand"、maxgates="5"。
//   exp / got は表示用：{ console, regs:[[名前, 値]], mem:{addr, bytes}, screen:Uint8Array, exitCode, logic }
(function (root) {
  'use strict';
  const RV = root.RV, LOGIC = root.LOGIC;

  function parseInfo(info) {
    const out = { lang: '', flags: new Set(), attrs: {} };
    const re = /(\w+)="([^"]*)"|(\S+)/g;
    let m, first = true;
    while ((m = re.exec(info || ''))) {
      if (first && !m[1]) { out.lang = m[3]; first = false; continue; }
      first = false;
      if (m[1]) out.attrs[m[1]] = m[2];
      else out.flags.add(m[3]);
    }
    return out;
  }

  const num = (s) => (s === undefined ? undefined : Number(s));

  function machineOpts(p) {
    const a = p.attrs, f = p.flags, o = {};
    if (a.maxsteps) o.maxSteps = num(a.maxsteps);
    if (a.seed) o.seed = num(a.seed);
    if (f.has('pipeline') || a.pipeline || a.predict) {
      o.pipeline = { forwarding: a.pipeline !== 'noforward' };
      if (a.predict) o.pipeline.predictor = a.predict;
    }
    if (a.cache) o.cache = a.cache;
    return o;
  }

  function runAsm(src, p, extra) {
    const anim = p.flags.has('anim');
    const r = RV.run(src, extra ? Object.assign(machineOpts(p), extra) : machineOpts(p));
    if (!r.prog || !r.prog.ok) {
      return { lang: 'asm', ok: false, failed: true, asm: { prog: r.prog, machine: null, result: null, errors: r.errors }, message: (r.prog && r.prog.errorText) || 'アセンブルできませんでした' };
    }
    const res = r.result;
    const failed = res.reason === 'error';
    const finished = res.reason === 'exit' || res.reason === 'end';
    // limit の印：命令数の上限で打ち切られるのが正しい例（無限ループの体験）。break の印：ebreak で止まる例
    const ok = !failed && (finished || (anim && (res.reason === 'limit' || res.reason === 'frame')) || (p.flags.has('limit') && res.reason === 'limit') || (p.flags.has('break') && res.reason === 'break'));
    return { lang: 'asm', ok, failed, asm: { prog: r.prog, machine: r.machine, result: res, errors: [] }, message: res.message };
  }

  function runLogic(src) {
    const r = LOGIC.run(src);
    if (!r.ok) return { lang: 'logic', ok: false, failed: true, logic: { result: r }, message: r.errors.map((e) => e.msg).join('\n') };
    return { lang: 'logic', ok: true, failed: false, logic: { result: r }, message: '' };
  }

  function runBlock(lang, src, info, extra) {
    const p = typeof info === 'string' ? parseInfo(info) : info || parseInfo(lang);
    return lang === 'logic' ? runLogic(src) : runAsm(src, p, extra);
  }

  // ---------------------------------------------------------------- 採点
  const lead = (s) => s.replace(/^(\s|#[^\n]*|\/\/[^\n]*)*/, '');
  const isEmpty = (s) => !lead(String(s || '')).trim();

  function snapshotAsm(r, p) {
    const out = { reason: r.asm.result ? r.asm.result.reason : null };
    const m = r.asm.machine;
    if (!m) return out;
    out.console = m.console;
    out.exitCode = r.asm.result.exitCode;
    if (p.attrs.regs) out.regs = p.attrs.regs.split(',').map((s) => s.trim()).filter(Boolean).map((n) => [n, m.regs[RV.regIndex(n)] | 0]);
    if (p.attrs.mem) {
      const [a, n] = p.attrs.mem.split(',').map((s) => Number(s.trim()));
      out.mem = { addr: a, bytes: Array.from(m.mem.slice(a, a + n)) };
    }
    if (p.flags.has('screen')) out.screen = Uint8Array.from(m.screen);
    return out;
  }

  const hex = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');

  function compareAsm(exp, got, p) {
    const what = [];
    const useConsole = p.flags.has('console') || !(p.attrs.regs || p.attrs.mem || p.flags.has('screen'));
    if (useConsole && exp.console !== got.console) {
      const e = exp.console.split('\n'), g = got.console.split('\n');
      let i = 0;
      while (i < e.length && e[i] === g[i]) i++;
      return `コンソールの出力が違います（${i + 1} 行目から）。`;
    }
    if (exp.regs) {
      for (let i = 0; i < exp.regs.length; i++) {
        const [n, v] = exp.regs[i], gv = got.regs[i][1];
        if (v !== gv) return `レジスタ ${n} の値が違います（期待 ${v}、あなたの結果 ${gv}）。`;
      }
    }
    if (exp.mem) {
      const k = exp.mem.bytes.findIndex((b, i) => b !== got.mem.bytes[i]);
      if (k >= 0) return `メモリ ${hex(exp.mem.addr + k)} 番地のバイトが違います（期待 ${exp.mem.bytes[k]}、あなたの結果 ${got.mem.bytes[k]}）。`;
    }
    if (exp.screen) {
      let n = 0;
      for (let i = 0; i < exp.screen.length; i++) if (exp.screen[i] !== got.screen[i]) n++;
      if (n) return `画面のピクセルが ${n} 個違います。`;
    }
    if (p.flags.has('exit') && exp.exitCode !== got.exitCode) return `終了コードが違います（期待 ${exp.exitCode}、あなたの結果 ${got.exitCode}）。`;
    return what.length ? what.join('') : null;
  }

  function joinGiven(src, given) {
    return given ? `${src}\n.text\n${given}\n` : src;
  }

  function quizAsm(q, userSrc) {
    const p = parseInfo(q.info || 'asm answer');
    const a = runAsm(joinGiven(q.answer, q.given), p);
    if (!a.ok) return { verdict: 'error', msg: `模範解答の実行に失敗しました（${a.message}）`, exp: null, got: null };
    const exp = snapshotAsm(a, p);
    const g = runAsm(joinGiven(userSrc, q.given), p);
    if (g.failed) {
      const where = g.asm.machine ? '実行中にエラーになりました。' : 'アセンブルできませんでした。';
      return { verdict: 'ng', msg: where, error: g.message, errors: g.asm.errors, exp, got: g.asm.machine ? snapshotAsm(g, p) : null, run: g };
    }
    const got = snapshotAsm(g, p);
    if (g.asm.result.reason === 'limit') return { verdict: 'ng', msg: '命令数の上限まで実行しても終わりませんでした。ループの終わる条件を確かめてください。', exp, got, run: g };
    const why = compareAsm(exp, got, p);
    if (why) return { verdict: 'ng', msg: why, exp, got, run: g };
    return { verdict: 'ok', msg: '結果が模範解答と一致しました。', exp, got, run: g };
  }

  function quizLogic(q, userSrc) {
    const p = parseInfo(q.info || 'logic answer');
    const lim = {};
    if (p.attrs.only) lim.only = p.attrs.only;
    if (p.attrs.maxgates) lim.maxgates = Number(p.attrs.maxgates);
    const r = LOGIC.grade(q.answer, userSrc, lim);
    const exp = { logic: r.exp }, got = { logic: r.got };
    if (r.reason === 'answer-error') return { verdict: 'error', msg: `模範解答の回路にエラーがあります（${r.msg}）`, exp, got };
    if (r.ok) return { verdict: 'ok', msg: '出力の表が模範解答と一致しました。', exp, got };
    if (r.reason === 'error') return { verdict: 'ng', msg: '回路にエラーがあります。', error: r.msg, exp, got };
    return { verdict: 'ng', msg: r.msg, exp, got };
  }

  function quiz(q, userSrc) {
    if (isEmpty(userSrc)) return { verdict: 'empty', msg: 'コードを書いてから「答え合わせ」を押してください。' };
    return q.lang === 'logic' ? quizLogic(q, userSrc) : quizAsm(q, userSrc);
  }

  root.GRADE = { parseInfo, machineOpts, runBlock, quiz, joinGiven };
})(typeof window !== 'undefined' ? window : globalThis);
