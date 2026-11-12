// 確認問題の答え合わせ。
// 本文の SQL とは別の PostgreSQL（採点用）を 1 つ立て、模範解答と読者の SQL を
// それぞれトランザクションの中で実行して ROLLBACK する。毎回同じ状態から始まるので、
// 何度でも試せて、本文のデータベースにも影響しない。
// 判定は「出力の値が同じか」。列名・行の順番（ordered の問題を除く）・列の順番・数値の書き方（2000 と 2000.00）は問わない。
// 採点の中心（QZCORE）は DOM を使わないので、Node の検査スクリプトからも読み込める。
(function (root) {
  // トランザクションを終わらせる文は、採点の仕組みを壊すので受け付けない
  const TX = /^(begin|start\s+transaction|commit|end|abort|rollback(?!\s+(work\s+|transaction\s+)?to\b)|prepare\s+transaction)\b/i;
  const lead = (s) => s.replace(/^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*/, '');
  const txStmt = (stmts) => stmts.find((s) => TX.test(lead(s)));

  const text = (v) => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return '{' + v.map((x) => (x === null ? 'NULL' : text(x))).join(',') + '}';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  // 2000 と 2000.00、1.5 と 1.50 は同じ値として扱う
  const norm = (v) => {
    const t = text(v);
    if (t === null) return '\u0000NULL';
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t.trim())) return 'n:' + Number(t);
    return 's:' + t;
  };
  const rowKey = (row, perm) => JSON.stringify((perm ? perm.map((j) => row[j]) : row).map(norm));
  const empty = { fields: [], rows: [] };

  async function attempt(db, split, { prep, sql, check }) {
    const stmts = split(sql || '');
    if (!stmts.length) return { empty: true };
    await db.exec('begin');
    try {
      await db.exec(`set local statement_timeout = '10s'`);
      for (const s of split(prep || '')) await db.exec(s);
      let last = null, lastAny = null;
      for (const s of stmts) {
        let r;
        try { r = await db.exec(s, { rowMode: 'array' }); } catch (e) { return { err: e, sql: s }; }
        const x = r[r.length - 1];
        if (x) { lastAny = x; if (x.fields && x.fields.length) last = x; }
      }
      const own = last || lastAny || empty;
      if (check) {
        try {
          const r = await db.exec(check, { rowMode: 'array' });
          return { res: r[r.length - 1] || empty, own };
        } catch (e) {
          return { err: e, sql: check, inCheck: true };
        }
      }
      return { res: own };
    } finally {
      try { await db.exec('rollback'); } catch (e) { /* もう終わっている */ }
    }
  }

  // 列の順番が違っていても、列ごとの値の集まりが一致すれば並べ替えて比べる
  function matchColumns(exp, got) {
    const n = exp.fields.length;
    const sig = (res, j) => res.rows.map((r) => norm(r[j])).sort().join('\u0001');
    const gs = got.fields.map((_, j) => sig(got, j));
    const used = new Set();
    const perm = [];
    for (let i = 0; i < n; i++) {
      const s = sig(exp, i);
      const j = gs.findIndex((g, k) => !used.has(k) && g === s);
      if (j < 0) return null;
      used.add(j);
      perm.push(j);
    }
    return perm.every((j, i) => j === i) ? null : perm;
  }

  function compare(exp, got, ordered) {
    const ef = (exp.fields || []).length, gf = (got.fields || []).length;
    if (!gf) return { ok: false, why: 'noresult' };
    if (ef !== gf) return { ok: false, why: 'cols', e: ef, g: gf };
    if (exp.rows.length !== got.rows.length) return { ok: false, why: 'rows', e: exp.rows.length, g: got.rows.length };
    const tryPerm = (perm) => {
      const er = exp.rows.map((r) => rowKey(r));
      const gr = got.rows.map((r) => rowKey(r, perm));
      if (er.every((k, i) => k === gr[i])) return { ok: true };
      const es = [...er].sort(), gsr = [...gr].sort();
      if (es.every((k, i) => k === gsr[i])) return ordered ? { ok: false, why: 'order' } : { ok: true };
      const bag = new Map();
      er.forEach((k) => bag.set(k, (bag.get(k) || 0) + 1));
      let diff = 0;
      gr.forEach((k) => { const c = bag.get(k); if (c) bag.set(k, c - 1); else diff++; });
      return { ok: false, why: 'values', n: diff };
    };
    const r = tryPerm(null);
    if (r.ok || r.why === 'order') return r;
    const perm = matchColumns(exp, got);
    if (perm) {
      const r2 = tryPerm(perm);
      if (r2.ok || r2.why === 'order') return { ...r2, colOrder: true };
    }
    return r;
  }

  // 採点用のデータベースにだけ入れておく補助関数。制約やトリガの問題の check で、
  // 「この文は通るか、どのエラーで止まるか」を 1 行の表にして比べるために使う。
  // 成功したら 'ok'（SELECT ならその値）、失敗したら SQLSTATE を返す。
  const HELPER = `create function try_sql(sql text) returns text language plpgsql as $f$
declare r text;
begin
  if sql ~* '^\\s*(select|with|values|table)\\M' then
    execute sql into r;
    return coalesce(r, 'NULL');
  end if;
  execute sql;
  return 'ok';
exception when others then
  return sqlstate;
end $f$`;

  root.QZCORE = { attempt, compare, txStmt, HELPER };
  if (typeof document === 'undefined') return;

  // ---------------------------------------------------------------- 画面
  const PG = root.PG, H = root.SQLHL;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const store = {
    get() { try { return JSON.parse(localStorage.getItem('zp-quiz') || '[]'); } catch (e) { return []; } },
    set(v) { try { localStorage.setItem('zp-quiz', JSON.stringify(v)); } catch (e) {} },
  };
  const solved = new Set(store.get());
  const quizzes = $$('.qz');
  if (!quizzes.length || !PG) return;

  let qdb = null;
  const getQdb = () => (qdb ||= PG.makeDb(PG.pageSetup() + '\n;\n' + HELPER).catch((e) => { qdb = null; throw e; }));
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const expected = new Map();

  const mark = (q) => { $('.qz-mark', q).hidden = !solved.has(q.dataset.qid); };
  quizzes.forEach(mark);

  const verdict = (kind, label, msg) => `<div class="qz-v is-${kind}"><span class="qz-vk">${label}</span><span class="qz-vm">${msg}</span></div>`;
  const table = (cap, res) => `<div class="qz-cap">${cap}</div>${PG.tableHTML(res)}`;
  const WHY = {
    noresult: () => '結果の表が返っていません。最後に SELECT（または RETURNING）で結果を出してください。',
    cols: (r) => `列の数が違います（期待 ${r.e} 列、あなたの出力 ${r.g} 列）。`,
    rows: (r) => `行数が違います（期待 ${r.e} 行、あなたの出力 ${r.g} 行）。`,
    order: () => '値は合っていますが、行の並び順が違います。この問題は順番も判定します。',
    values: (r) => `値が違う行が ${r.n} 行あります。`,
  };

  async function grade(q) {
    const ta = $('.ed-ta', q), out = $('.qz-res', q), btn = $('.qz-check', q);
    if (btn.disabled) return;
    const d = JSON.parse($('.qz-data', q).textContent);
    const sql = ta.value;
    out.hidden = false;
    const stmts = H.split(sql);
    if (!stmts.length) { out.innerHTML = verdict('wait', '未入力', 'SQL を書いてから「答え合わせ」を押してください。'); return; }
    const tx = PG && txStmt(stmts);
    if (tx) {
      out.innerHTML = verdict('ng', 'やり直し', `答え合わせは毎回トランザクションの中で行い、最後に取り消しています。<code>${esc(lead(tx).split(/\s+/)[0])}</code> などのトランザクションを始める・終える文は書かずに答えてください。`);
      return;
    }
    btn.disabled = true;
    q.classList.add('is-running');
    if (!qdb) out.innerHTML = '<div class="out-wait">採点用の PostgreSQL を起動しています。初回だけ数秒かかります…</div>';
    try {
      const db = await getQdb();
      const { exp, got } = await serial(async () => {
        let exp = expected.get(q);
        if (!exp) {
          const r = await attempt(db, H.split, { prep: d.p, sql: d.a, check: d.c });
          if (r.err) throw new Error(`模範解答の実行に失敗しました（${r.err.message}）`);
          exp = r.res;
          expected.set(q, exp);
        }
        return { exp, got: await attempt(db, H.split, { prep: d.p, sql, check: d.c }) };
      });
      const expBox = `<details class="qz-exp"><summary>期待される出力を見る</summary>${PG.tableHTML(exp)}</details>`;
      if (got.err) {
        const what = got.inCheck ? '実行後の中身を調べる SQL がエラーになりました。作るはずのテーブルや列ができているか確かめてください。' : 'SQL がエラーになりました。';
        out.innerHTML = verdict('ng', '不正解', what) + PG.errHTML(got.err, got.sql) + expBox;
      } else {
        const r = compare(exp, got.res, d.o);
        const cap = d.c ? '実行後の中身' : 'あなたの出力';
        if (r.ok) {
          solved.add(q.dataset.qid);
          store.set([...solved]);
          mark(q);
          const note = r.colOrder ? '（列の並びは模範解答と違いますが、値は同じです）' : '';
          out.innerHTML = verdict('ok', '正解', `出力が模範解答と一致しました${note}。`) + table(cap, got.res);
        } else {
          out.innerHTML = verdict('ng', '不正解', WHY[r.why](r)) + table(cap, got.res) + expBox;
        }
      }
    } catch (e) {
      out.innerHTML = verdict('ng', 'エラー', esc(e.message || e));
    } finally {
      btn.disabled = false;
      q.classList.remove('is-running');
    }
  }

  quizzes.forEach((q) => {
    const ta = $('.ed-ta', q);
    const paint = () => { $('.ed-hl code', q).innerHTML = H.highlightLines(ta.value).join('\n') + '\n'; };
    ta.addEventListener('input', () => { paint(); q.classList.add('is-edited'); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); grade(q); return; }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
        paint();
      }
    });
    // 最初の入力欄（コメントだけ）は、クリックしたら選択して打ち替えやすくする
    ta.addEventListener('focus', () => { PG.warm(); if (!q.classList.contains('is-edited') && /^--[^\n]*\n?$/.test(ta.value)) ta.select(); });
    $('.qz-check', q).addEventListener('click', () => grade(q));
  });
})(typeof window !== 'undefined' ? window : globalThis);
