// 確認問題の答え合わせ。
// 判定は grade.js の GRADE.quiz（模範解答と読者のコマンドを、それぞれ「ページの初期状態（setup 済み）の clone + 問題の準備」で実行して比べる）。
// ページの初期状態の機械は、本文の機械とは別に持つ（LNXUI.baseMachine()）。毎回 clone するので、何度でも試せて、本文のブロックにも影響しない。
(() => {
  const GRADE = window.GRADE, UI = window.LNXUI;
  if (!GRADE || !UI) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const { esc, store } = UI;
  const solved = new Set(store.get('quiz', []));
  const quizzes = $$('.qz');
  if (!quizzes.length) return;
  const MAX = 200; // 並べて見せる行数

  const mark = (q) => { $('.qz-mark', q).hidden = !solved.has(q.dataset.qid); };
  quizzes.forEach(mark);
  const verdict = (kind, label, msg) => `<div class="qz-v is-${kind}"><span class="qz-vk">${label}</span><span class="qz-vm">${msg}</span></div>`;

  const linesOf = (s) => { const t = GRADE.norm(s); return t === '' ? [] : t.split('\n'); };
  // 期待と結果を並べる。違う行に色を付ける（unordered なら「相手にない行」に色）
  function compareHTML(exp, got, unordered, capE, capG) {
    const a = linesOf(exp), b = linesOf(got);
    let badA, badB;
    if (unordered) {
      const count = (xs) => { const m = new Map(); xs.forEach((x) => m.set(x, (m.get(x) || 0) + 1)); return m; };
      const ca = count(a), cb = count(b);
      badA = a.map((l) => { const n = cb.get(l) || 0; if (n) { cb.set(l, n - 1); return false; } return true; });
      badB = b.map((l) => { const n = ca.get(l) || 0; if (n) { ca.set(l, n - 1); return false; } return true; });
    } else {
      badA = a.map((l, i) => l !== b[i]);
      badB = b.map((l, i) => l !== a[i]);
    }
    const col = (cap, ls, bad, cls) => `<div class="qc-col"><div class="qc-cap">${cap}</div><div class="qc-box">${
      ls.length ? ls.slice(0, MAX).map((l, i) => `<div class="qc-l${bad[i] ? ' ' + cls : ''}">${esc(l) || ' '}</div>`).join('') + (ls.length > MAX ? `<div class="qc-l qc-x">…（残り ${ls.length - MAX} 行は省略）</div>` : '') : '<div class="qc-l qc-x">（何も出力されていません）</div>'
    }</div></div>`;
    return `<div class="qc">${col(capE, a, badA, 'is-miss')}${col(capG, b, badB, 'is-diff')}</div>`;
  }
  const oneHTML = (cap, text) => { const ls = linesOf(text); return `<div class="qc is-one"><div class="qc-col"><div class="qc-cap">${cap}</div><div class="qc-box">${ls.length ? ls.slice(0, MAX).map((l) => `<div class="qc-l">${esc(l) || ' '}</div>`).join('') : '<div class="qc-l qc-x">（何も出力されていません）</div>'}</div></div></div>`; };
  // 読者のコマンドが stderr に出したものと、0 以外の終了ステータス
  function extraHTML(got, d, p) {
    if (!got) return '';
    let h = '';
    if (got.stderr && got.stderr.trim()) h += `<div class="qc is-one"><div class="qc-col"><div class="qc-cap">あなたのコマンドのエラー出力（stderr）</div><div class="qc-box">${linesOf(got.stderr).slice(0, 40).map((l) => `<div class="qc-l is-err">${esc(l) || ' '}</div>`).join('')}</div></div></div>`;
    if (got.exit && (got.stderr || p.flags.has('exit'))) h += `<div class="qc-st">${UI.exitHTML(got.exit)}</div>`;
    return h;
  }

  function grade(q) {
    const ta = $('.ed-ta', q), out = $('.qz-res', q);
    const d = JSON.parse($('.qz-data', q).textContent);
    const p = GRADE.parseInfo(d.info || 'sh answer');
    out.hidden = false;
    let r;
    try { r = GRADE.quiz(d, ta.value, UI.baseMachine()); } catch (e) { r = { verdict: 'error', msg: String((e && e.message) || e) }; }
    q.dataset.verdict = r.verdict;
    if (r.verdict === 'empty') { out.innerHTML = verdict('wait', '未入力', esc(r.msg)); return r; }
    if (r.verdict === 'error') { out.innerHTML = verdict('ng', 'エラー', esc(r.msg)); return r; }
    const un = p.flags.has('unordered');
    const what = d.check ? '確かめのコマンドの出力' : '標準出力';
    const pick = (o) => (o ? (d.check ? o.check : o.stdout) : '');
    if (r.verdict === 'ok') {
      solved.add(q.dataset.qid);
      store.set('quiz', [...solved]);
      mark(q);
      out.innerHTML = verdict('ok', '正解', esc(r.msg)) + oneHTML(`あなたの結果（${what}）`, pick(r.got));
    } else {
      const note = r.variant > 0 ? '<p class="qc-note">最初のデータでは合っていましたが、準備のデータを少し変えると結果が違いました。下は、変えたデータでの結果です。答えの値を直接書かずに、データから求めるコマンドにしてください。</p>' : '';
      const cmp = r.exp && r.got && r.got.stdout !== undefined ? compareHTML(pick(r.exp), pick(r.got), un, `期待される結果（${what}）`, `あなたの結果（${what}）`) : '';
      out.innerHTML = verdict('ng', '不正解', esc(r.msg)) + note + cmp + extraHTML(r.got, d, p);
    }
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
  window.LNXQUIZ = { grade };
})();
