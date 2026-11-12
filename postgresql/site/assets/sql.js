// ブラウザの中で PostgreSQL（PGlite = WebAssembly 版 PostgreSQL）を動かし、
// ページ内の SQL ブロックを実行する。file:// で開いても動くよう、クラシックスクリプト + 動的 import で読み込む。
(() => {
  const VER = '0.5.12';
  const BASE = `https://cdn.jsdelivr.net/npm/@electric-sql/pglite@${VER}/dist/`;
  // 内部構造の章で使う拡張機能（CREATE EXTENSION したときに読み込まれる）
  const EXT = ['pageinspect', 'pg_walinspect', 'pg_visibility', 'pg_freespacemap', 'pg_buffercache', 'pg_trgm', 'pgcrypto', 'hstore'];
  const MAX_ROWS = 200;
  const H = window.SQLHL;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const stateBox = $('.db-state');
  const setState = (kind, text) => {
    if (!stateBox) return;
    stateBox.hidden = false;
    stateBox.dataset.state = kind;
    $('.db-text', stateBox).textContent = text;
  };

  const readSetup = () => {
    try { return JSON.parse($('#pg-setup')?.textContent || '{"sql":""}').sql; } catch (e) { return ''; }
  };
  let setupSQL = readSetup();

  // すべての型をテキストのまま受け取る（psql と同じ表示にするため）
  const raw = {};
  for (let i = 1; i < 8000; i++) raw[i] = (x) => x;

  let dbPromise = null;
  // ページの SQL と「DB を見る」パネルの問い合わせが混ざらないよう、順番に 1 つずつ実行する
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
  let modPromise = null;
  const loadMods = () =>
    (modPromise ||= (async () => {
      const core = await import(BASE + 'index.js');
      const exts = {};
      await Promise.all(
        EXT.map(async (e) => {
          try {
            const m = await import(BASE + `contrib/${e}.js`);
            exts[e] = m[e];
          } catch (err) { /* 拡張がなくても本体は動かす */ }
        })
      );
      return { PGlite: core.PGlite, exts };
    })());

  // 独立した PostgreSQL を 1 つ作る（本文用と、確認問題の採点用で別々に使う）
  async function makeDb(setup, onSetup) {
    const { PGlite, exts } = await loadMods();
    const db = await PGlite.create({ extensions: exts, parsers: raw });
    await db.exec(`set timezone = 'Asia/Tokyo'; set datestyle = 'ISO, YMD'; set stats_fetch_consistency = none;`);
    if (setup.trim()) {
      onSetup && onSetup();
      for (const s of H.split(setup)) await db.exec(s);
    }
    return db;
  }

  async function boot() {
    setState('boot', 'PostgreSQL を起動中…');
    const t0 = performance.now();
    const db = await makeDb(setupSQL, () => setState('boot', 'サンプルデータを準備中…'));
    const v = (await db.query('show server_version')).rows[0].server_version;
    setState('ready', `PostgreSQL ${v} 稼働中`);
    window.dispatchEvent(new CustomEvent('pg-ready', { detail: { ms: performance.now() - t0 } }));
    return db;
  }
  const getDb = () =>
    (dbPromise ||= boot().catch((e) => {
      dbPromise = null;
      setState('error', '起動に失敗');
      throw e;
    }));

  async function resetDb(newSetup) {
    if (newSetup !== undefined) setupSQL = newSetup;
    const old = dbPromise;
    dbPromise = null;
    if (old) { try { (await old).close(); } catch (e) {} }
    $$('.sqlrun .out').forEach((o) => { o.hidden = true; o.innerHTML = ''; });
    ran.clear();
    await getDb();
    window.dispatchEvent(new Event('pg-reset'));
  }
  window.PG = {
    getDb, resetDb, serial, isBooted: () => !!dbPromise, run: (sql) => execAll(sql), tableHTML: (res) => tableHTML(res),
    // 確認問題（quiz.js）から使う
    makeDb: (setup) => makeDb(setup), pageSetup: readSetup, warm: () => loadMods().catch(() => {}),
    errHTML: (e, sql) => errHTML(e, sql), fmt: (v) => fmt(v),
  };

  // ---------------------------------------------------------------- 実行
  const fmt = (v) => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return '{' + v.map((x) => (x === null ? 'NULL' : Array.isArray(x) ? fmt(x) : /[,{}"\s]/.test(String(x)) || x === '' ? `"${String(x).replace(/"/g, '\\"')}"` : String(x))).join(',') + '}';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  const NUM_TYPES = new Set([20, 21, 23, 26, 700, 701, 1700, 790, 28, 5069]);

  async function execAll(sql) {
    const db = await getDb();
    return serial(() => execStmts(db, sql));
  }
  async function execStmts(db, sql) {
    const stmts = H.split(sql);
    const results = [];
    for (const s of stmts) {
      const notices = [];
      const t0 = performance.now();
      try {
        const r = await db.exec(s, { rowMode: 'array', onNotice: (n) => notices.push(n) });
        const last = r[r.length - 1] || { rows: [], fields: [] };
        results.push({ sql: s, ok: true, res: last, ms: performance.now() - t0, notices });
      } catch (e) {
        results.push({ sql: s, ok: false, err: e, ms: performance.now() - t0, notices });
        break; // psql の ON_ERROR_STOP と同じく、エラーが出たら止める
      }
    }
    return { results, total: stmts.length };
  }

  function tableHTML(res) {
    const fields = res.fields || [];
    const rows = res.rows || [];
    const plan = fields.length === 1 && fields[0].name === 'QUERY PLAN';
    if (plan) return `<pre class="out-plan">${esc(rows.map((r) => r[0]).join('\n'))}</pre>`;
    const isNum = fields.map((f) => NUM_TYPES.has(f.dataTypeID));
    const shown = rows.slice(0, MAX_ROWS);
    const head = `<tr>${fields.map((f, i) => `<th${isNum[i] ? ' class="num"' : ''}>${esc(f.name)}</th>`).join('')}</tr>`;
    const body = shown
      .map((r) => `<tr>${r.map((v, i) => { const t = fmt(v); return t === null ? '<td class="null">NULL</td>' : `<td${isNum[i] ? ' class="num"' : ''}>${esc(t)}</td>`; }).join('')}</tr>`)
      .join('');
    const more = rows.length > MAX_ROWS ? `（先頭 ${MAX_ROWS} 行だけ表示）` : '';
    return `<div class="out-table"><table><thead>${head}</thead><tbody>${body}</tbody></table></div><div class="out-foot">(${rows.length} 行)${more}</div>`;
  }

  function tagOf(r) {
    const cmd = (r.res.command || r.sql.trim().split(/\s+/).slice(0, 2).join(' ')).toUpperCase();
    const n = r.res.affectedRows;
    if (/^(INSERT|UPDATE|DELETE|MERGE|COPY)/.test(cmd)) return `${cmd} ${n ?? 0}`;
    return cmd;
  }

  function errHTML(e, sql) {
    const pos = e.position ? +e.position : 0;
    let where = '';
    if (pos) {
      const before = sql.slice(0, pos - 1);
      const lineNo = before.split('\n').length;
      const line = sql.split('\n')[lineNo - 1] || '';
      const col = before.length - before.lastIndexOf('\n') - 1;
      where = `<pre class="err-where">LINE ${lineNo}: ${esc(line)}\n${' '.repeat(String(lineNo).length + 7 + col)}^</pre>`;
    }
    return `<div class="out-err"><div class="err-h"><span class="err-sev">${esc(e.severity || 'ERROR')}</span><span class="err-msg">${esc(e.message)}</span>${e.code ? `<span class="err-code" title="SQLSTATE">${esc(e.code)}</span>` : ''}</div>${where}${e.detail ? `<div class="err-x"><b>DETAIL</b> ${esc(e.detail)}</div>` : ''}${e.hint ? `<div class="err-x"><b>HINT</b> ${esc(e.hint)}</div>` : ''}${e.where ? `<div class="err-x"><b>CONTEXT</b> ${esc(e.where)}</div>` : ''}</div>`;
  }

  function render(out, { results, total }) {
    const parts = results.map((r, i) => {
      const multi = total > 1;
      const head = multi ? `<div class="out-stmt"><span class="out-no">${i + 1}</span><code>${esc(r.sql.split('\n').find((l) => l.trim() && !l.trim().startsWith('--')) || r.sql).slice(0, 80)}</code></div>` : '';
      const notes = r.notices.map((n) => `<div class="out-notice"><b>${esc(n.severity || 'NOTICE')}</b> ${esc(n.message)}</div>`).join('');
      if (!r.ok) return `<div class="out-part">${head}${notes}${errHTML(r.err, r.sql)}</div>`;
      const hasRows = (r.res.fields || []).length > 0;
      const body = hasRows ? tableHTML(r.res) : `<div class="out-tag">${esc(tagOf(r))}</div>`;
      // 複数文のとき、結果のない文は 1 行にまとめる
      return `<div class="out-part${hasRows ? '' : ' is-tag'}">${head}${notes}${body}</div>`;
    });
    const skipped = total - results.length;
    const ms = results.reduce((a, r) => a + r.ms, 0);
    const foot = `<div class="out-meta"><span>${results.length} 文を実行</span>${skipped ? `<span class="warn">エラーのため残り ${skipped} 文は実行していません</span>` : ''}<span>${ms < 1 ? '<1' : ms.toFixed(0)} ms</span></div>`;
    out.innerHTML = parts.join('') + foot;
    out.hidden = false;
  }

  // ---------------------------------------------------------------- エディタ
  // 章の中の SQL は上から順に積み上げる作りなので、どれを実行したかを覚えておく
  const boxes = $$('.sqlrun:not(.is-big)');
  const ran = new Set();
  const unrunBefore = (box) => boxes.slice(0, boxes.indexOf(box)).filter((b) => !ran.has(b));
  function paint(box) {
    const ta = $('.ed-ta', box);
    $('.ed-hl code', box).innerHTML = H.highlightLines(ta.value).join('\n') + '\n';
    $('.undo', box).hidden = ta.value === ta.defaultValue;
  }

  async function runBox(box) {
    const ta = $('.ed-ta', box), out = $('.out', box), btn = $('.run-btn', box);
    if (btn.disabled) return;
    btn.disabled = true;
    box.classList.add('is-running');
    out.hidden = false;
    if (!dbPromise) out.innerHTML = '<div class="out-wait">PostgreSQL を起動しています。初回だけ数秒かかります…</div>';
    try {
      const r = await execAll(ta.value);
      render(out, r);
      if (boxes.includes(box)) ran.add(box);
      const before = r.results.some((x) => !x.ok) && !box.classList.contains('is-fail') ? unrunBefore(box) : [];
      if (before.length) {
        const hint = document.createElement('div');
        hint.className = 'out-prev';
        hint.innerHTML = `<span>この章では、前の SQL で作ったテーブルなどを後の SQL で使います。この SQL より前に、まだ実行していない SQL が ${before.length} 個あります。</span><button type="button" class="dbv-btn">前の SQL を順に実行してから、もう一度実行</button>`;
        $('button', hint).addEventListener('click', async (e) => {
          e.currentTarget.disabled = true;
          for (const b of before) await runBox(b);
          await runBox(box);
        });
        out.prepend(hint);
      }
      window.dispatchEvent(new CustomEvent('pg-ran', { detail: { sql: ta.value, box } }));
    } catch (e) {
      out.innerHTML = `<div class="out-err"><div class="err-h"><span class="err-sev">起動エラー</span><span class="err-msg">PostgreSQL を読み込めませんでした。インターネットに接続しているか確認してください（${esc(e.message || e)}）</span></div></div>`;
    } finally {
      btn.disabled = false;
      box.classList.remove('is-running');
    }
  }

  $$('.sqlrun').forEach((box) => {
    const ta = $('.ed-ta', box);
    ta.addEventListener('input', () => paint(box));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runBox(box); return; }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        ta.setRangeText('  ', s, en, 'end');
        paint(box);
      }
    });
    $('.run-btn', box).addEventListener('click', () => runBox(box));
    $('.undo', box).addEventListener('click', () => { ta.value = ta.defaultValue; paint(box); ta.focus(); });
    // 最初の操作で裏で読み込みを始めておく
    const warm = () => { loadMods().catch(() => {}); };
    ta.addEventListener('focus', warm, { once: true });
    box.addEventListener('pointerenter', warm, { once: true });
  });

  $('.db-reset')?.addEventListener('click', async () => {
    const b = $('.db-reset');
    b.disabled = true;
    try { await resetDb(); } finally { b.disabled = false; }
  });
  if (stateBox) setState('idle', 'DB 未起動');

  // ---------------------------------------------------------------- 実験場
  const schemaBox = $('#play-schema');
  if (schemaBox) {
    const datasets = JSON.parse($('#pg-datasets')?.textContent || '{}');
    const hist = $('#play-hist');
    const store = {
      get() { try { return JSON.parse(localStorage.getItem('zp-hist') || '[]'); } catch (e) { return []; } },
      set(v) { try { localStorage.setItem('zp-hist', JSON.stringify(v)); } catch (e) {} },
    };
    const box = $('.sqlrun.is-big');
    const drawHist = () => {
      const h = store.get();
      const label = (s) => s.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--')).join(' ').replace(/\s+/g, ' ').slice(0, 90) || s.slice(0, 90);
      hist.innerHTML = h.length ? h.map((s, i) => `<li><button type="button" data-i="${i}" title="${esc(s)}">${esc(label(s))}</button></li>`).join('') : '<li class="muted">まだありません</li>';
    };
    hist.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const ta = $('.ed-ta', box);
      ta.value = store.get()[+b.dataset.i];
      paint(box);
      ta.focus();
    });
    const drawSchema = async () => {
      try {
        const db = await getDb();
        const r = await db.query(`select c.relname as t, c.relkind as k,
            string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum) as cols
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
          where n.nspname = 'public' and c.relkind in ('r','v','m','p')
          group by c.relname, c.relkind order by c.relname`);
        schemaBox.innerHTML = r.rows.length
          ? r.rows.map((x) => `<details><summary><code>${esc(x.t)}</code>${x.k !== 'r' ? `<span class="muted">${{ v: 'ビュー', m: 'マテビュー', p: '親' }[x.k] || ''}</span>` : ''}</summary><ul>${(x.cols || '').split(', ').map((c) => { const [n, ...t] = c.split(' '); return `<li><code>${esc(n)}</code><span>${esc(t.join(' '))}</span></li>`; }).join('')}</ul></details>`).join('')
          : '<p class="muted">テーブルはありません</p>';
      } catch (e) { /* 起動前 */ }
    };
    window.addEventListener('pg-ran', (e) => {
      const h = store.get().filter((s) => s !== e.detail.sql);
      h.unshift(e.detail.sql);
      store.set(h.slice(0, 30));
      drawHist();
      drawSchema();
    });
    window.addEventListener('pg-reset', drawSchema);
    window.addEventListener('pg-ready', drawSchema);
    $('#play-db').addEventListener('change', (e) => resetDb(e.target.value === 'none' ? '' : datasets[e.target.value] || ''));
    drawHist();
  }
})();
