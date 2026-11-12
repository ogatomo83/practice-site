// 確認問題の答え合わせ。
// 判定は grade.js の GRADE.quiz（模範解答と読者のコードを、それぞれ新しい機械・新しい回路で実行して比べる）。
// 毎回まっさらな状態から実行するので、何度でも試せて、本文のブロックにも影響しない。採点は同期で終わる。
(() => {
  const GRADE = window.GRADE, UI = window.CPUUI, RV = window.RV;
  if (!GRADE || !UI) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const { esc, hex } = UI;
  const store = {
    get() { try { return JSON.parse(localStorage.getItem('zc-quiz') || '[]'); } catch (e) { return []; } },
    set(v) { try { localStorage.setItem('zc-quiz', JSON.stringify(v)); } catch (e) {} },
  };
  const solved = new Set(store.get());
  const quizzes = $$('.qz');
  if (!quizzes.length) return;

  const mark = (q) => { $('.qz-mark', q).hidden = !solved.has(q.dataset.qid); };
  quizzes.forEach(mark);
  const verdict = (kind, label, msg) => `<div class="qz-v is-${kind}"><span class="qz-vk">${label}</span><span class="qz-vm">${msg}</span></div>`;

  // exp / got（GRADE.quiz の表示用データ）を HTML にする
  function snapHTML(s, d) {
    if (!s) return '';
    if (s.logic) return s.logic.ok ? UI.logicHTML(s.logic, { plain: true, cap: s.logic.kind === 'timing' ? 'タイミング表' : '真理値表' }) : '';
    const p = GRADE.parseInfo(d.info || 'asm answer');
    const useConsole = p.flags.has('console') || !(p.attrs.regs || p.attrs.mem || p.flags.has('screen'));
    let h = '';
    if (s.screen) h += `<div class="out-sec"><div class="out-cap">画面</div><div class="scr-wrap">${UI.screenHTML(s.screen)}</div></div>`;
    if (useConsole || s.console) h += s.console === '' || s.console === undefined ? (useConsole ? '<div class="out-sec"><div class="out-cap">コンソール</div><p class="out-none">（何も出力されていません）</p></div>' : '') : UI.consoleHTML(s.console);
    if (s.regs) h += UI.regsHTML(s.regs);
    if (s.mem) h += UI.memHTML(s.mem.addr, s.mem.bytes, `メモリ（${hex(s.mem.addr)} から ${s.mem.bytes.length} バイト）`);
    if (p.flags.has('exit') && s.exitCode !== undefined) h += `<div class="out-sec"><div class="out-cap">終了コード</div><p class="out-none">${s.exitCode === null ? 'なし（ecall 93 で終わっていません）' : s.exitCode}</p></div>`;
    return h;
  }

  function grade(q) {
    const ta = $('.ed-ta', q), out = $('.qz-res', q);
    const d = JSON.parse($('.qz-data', q).textContent);
    const src = ta.value;
    out.hidden = false;
    let r;
    try { r = GRADE.quiz(d, src); } catch (e) { r = { verdict: 'error', msg: String(e.message || e) }; }
    q.dataset.verdict = r.verdict;
    UI.paint(q, null);
    if (r.verdict === 'empty') { out.innerHTML = verdict('wait', '未入力', esc(r.msg)); return r; }
    if (r.verdict === 'error') { out.innerHTML = verdict('ng', 'エラー', esc(r.msg)); return r; }
    const expBox = r.exp ? `<details class="qz-exp"><summary>期待される出力を見る</summary>${snapHTML(r.exp, d)}</details>` : '';
    if (r.verdict === 'ok') {
      solved.add(q.dataset.qid);
      store.set([...solved]);
      mark(q);
      out.innerHTML = verdict('ok', '正解', esc(r.msg)) + `<div class="qz-cap">あなたの結果</div>` + snapHTML(r.got, d);
    } else {
      let err = '';
      const lines = [];
      if (r.error) {
        // アセンブルエラーは行番号つき。読者のコードより後ろの行（連結された given）は、そう書き添える
        const n = src.split('\n').length;
        const list = r.errors && r.errors.length ? r.errors.map((e) => {
          if (e.line && e.line <= n) { lines.push(e.line); return e.text; }
          return e.line ? `後ろに連結されるコードの ${e.line - n - 1} 行目：${e.msg}（あなたのコードで定義するはずのラベルが足りないのかもしれません）` : e.text || e.msg;
        }) : String(r.error).split('\n');
        if (d.lang === 'logic') (r.got && r.got.logic && r.got.logic.errors || []).forEach((e) => { if (e.line) lines.push(e.line); });
        const rl = r.run && r.run.asm && r.run.asm.result && r.run.asm.result.error && r.run.asm.result.error.line;
        if (rl && rl <= n) lines.push(rl);
        err = UI.errBox(d.lang === 'logic' ? '回路のエラー' : r.errors && r.errors.length ? 'アセンブルエラー' : '実行時エラー', list);
      }
      if (lines.length) UI.paint(q, { err: lines });
      const got = r.got && !(r.got.logic && !r.got.logic.ok) ? `<div class="qz-cap">あなたの結果</div>` + snapHTML(r.got, d) : '';
      out.innerHTML = verdict('ng', '不正解', esc(r.msg)) + err + got + expBox;
    }
    UI.hydrate(out);
    return r;
  }

  quizzes.forEach((q) => {
    const ta = $('.ed-ta', q);
    UI.bindEditor(q, () => grade(q));
    ta.addEventListener('input', () => q.classList.add('is-edited'));
    // 最初の入力欄（コメントだけ）は、クリックしたら選択して打ち替えやすくする
    ta.addEventListener('focus', () => { if (!q.classList.contains('is-edited') && /^#[^\n]*\n?$/.test(ta.value)) ta.select(); });
    $('.qz-check', q).addEventListener('click', () => grade(q));
  });
  window.CPUQUIZ = { grade };
})();
