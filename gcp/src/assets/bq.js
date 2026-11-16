// BigQuery：データセット、テーブル（パーティション、クラスタ）、ビュー、bq コマンド、GoogleSQL の実行（DuckDB-Wasm に書き換えて動かす）、
// 処理したバイト数（列ごとの大きさ × 読んだ行）、キャッシュ、ジョブと INFORMATION_SCHEMA.JOBS、サンドボックス（請求先なし）、Node の SDK。
// 状態：w.svc.bq = { ds: { 'proj:ds': { location, created, desc, labels, tables: { 名前: { schema, rows, type, view, part, cluster, created, modified, tok, expire } } } }, jobs: [] }
// エンジン：GCP.DUCK() → Promise<{ db, conn }>（ブラウザは CDN の duckdb-browser-blocking、Node は検査スクリプトが差し込む）
(function (root) {
  'use strict';
  const G = root.GCP = root.GCP || {};
  const E = G.E;
  G.SERVICES_INIT.bq = () => ({ ds: {}, jobs: [], cache: {} });
  const B = (w) => w.svc.bq;
  const SVC = 'bigquery.googleapis.com';
  G.DUCK_VER = '1.32.0';
  if (!G.DUCK) {
    let p = null;
    G.DUCK = () => (p ||= (async () => {
      const base = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${G.DUCK_VER}/dist/`;
      const m = await import(base + 'duckdb-browser-blocking.mjs/+esm');
      const bundles = { mvp: { mainModule: base + 'duckdb-mvp.wasm', mainWorker: base + 'duckdb-browser-mvp.worker.js' }, eh: { mainModule: base + 'duckdb-eh.wasm', mainWorker: base + 'duckdb-browser-eh.worker.js' } };
      const db = await m.createDuckDB(bundles, new m.VoidLogger(), m.BROWSER_RUNTIME);
      await db.instantiate();
      return { db, conn: db.connect() };
    })());
  }
  let uniq = 0;
  const newTok = () => 't' + (++uniq) + '_' + Date.now().toString(36);

  // ---------------------------------------------------------------- 型
  const DUCK_T = { INTEGER: 'BIGINT', INT64: 'BIGINT', FLOAT: 'DOUBLE', FLOAT64: 'DOUBLE', NUMERIC: 'DECIMAL(38,9)', BIGNUMERIC: 'DECIMAL(38,18)', STRING: 'VARCHAR', BOOLEAN: 'BOOLEAN', BOOL: 'BOOLEAN', DATE: 'DATE', TIMESTAMP: 'TIMESTAMP', DATETIME: 'TIMESTAMP', TIME: 'TIME', BYTES: 'BLOB', JSON: 'JSON' };
  const duckType = (f) => { let t = f.type === 'RECORD' || f.type === 'STRUCT' ? `STRUCT(${f.fields.map((x) => `"${x.name}" ${duckType(x)}`).join(', ')})` : DUCK_T[f.type] || 'VARCHAR'; if (f.mode === 'REPEATED') t += '[]'; return t; };
  // DuckDB の型 → BigQuery の型（表示用。bq は古い名前 INTEGER / FLOAT / BOOLEAN / RECORD を使う）
  function bqType(dt) {
    dt = dt.trim();
    if (/\[\]$/.test(dt)) return Object.assign(bqType(dt.slice(0, -2)), { mode: 'REPEATED' });
    if (/^STRUCT\(/i.test(dt)) {
      const inner = dt.slice(7, -1);
      const parts = []; let depth = 0, cur = '';
      for (const ch of inner) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { parts.push(cur); cur = ''; continue; } cur += ch; }
      if (cur.trim()) parts.push(cur);
      return { type: 'RECORD', fields: parts.map((p) => { const m = p.trim().match(/^"?([^"\s]+)"?\s+(.*)$/); return Object.assign({ name: m[1], mode: 'NULLABLE' }, bqType(m[2])); }) };
    }
    if (/^(BIGINT|INTEGER|HUGEINT|SMALLINT|TINYINT|UBIGINT|UINTEGER|INT\d*)$/i.test(dt)) return { type: 'INTEGER' };
    if (/^(DOUBLE|FLOAT|REAL)$/i.test(dt)) return { type: 'FLOAT' };
    if (/^DECIMAL\((\d+),\s*(\d+)\)$/i.test(dt)) return { type: Number(dt.match(/,\s*(\d+)/)[1]) > 9 ? 'BIGNUMERIC' : 'NUMERIC' };
    if (/^BOOLEAN$/i.test(dt)) return { type: 'BOOLEAN' };
    if (/^DATE$/i.test(dt)) return { type: 'DATE' };
    if (/^TIMESTAMP( WITH TIME ZONE)?$/i.test(dt)) return { type: 'TIMESTAMP' };
    if (/^TIME$/i.test(dt)) return { type: 'TIME' };
    if (/^BLOB$/i.test(dt)) return { type: 'BYTES' };
    if (/^JSON$/i.test(dt)) return { type: 'JSON' };
    return { type: 'STRING' };
  }
  // 論理バイト数（BigQuery の料金の数え方）
  function sizeOf(f, v) {
    if (v === null || v === undefined) return 0;
    if (f.mode === 'REPEATED') return (v || []).reduce((n, x) => n + sizeOf(Object.assign({}, f, { mode: 'NULLABLE' }), x), 0);
    switch (f.type) {
      case 'INTEGER': case 'FLOAT': case 'DATE': case 'TIMESTAMP': case 'DATETIME': case 'TIME': return 8;
      case 'NUMERIC': return 16; case 'BIGNUMERIC': return 32; case 'BOOLEAN': return 1;
      case 'RECORD': return f.fields.reduce((n, x) => n + sizeOf(x, v[x.name]), 0);
      default: return 2 + new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v)).length;
    }
  }
  const tableBytes = (t) => t.rows.reduce((n, r) => n + t.schema.reduce((m, f) => m + sizeOf(f, r[f.name]), 0), 0);
  G.bqTableBytes = tableBytes;

  // ---------------------------------------------------------------- SQL の字句と書き換え（GoogleSQL → DuckDB）
  function tokenize(sql) {
    const out = []; let i = 0;
    while (i < sql.length) {
      const ch = sql[i];
      if (/\s/.test(ch)) { let j = i; while (j < sql.length && /\s/.test(sql[j])) j++; out.push({ t: 'ws', v: sql.slice(i, j) }); i = j; continue; }
      if (ch === '-' && sql[i + 1] === '-' || ch === '#') { let j = sql.indexOf('\n', i); if (j < 0) j = sql.length; out.push({ t: 'ws', v: ' ' }); i = j; continue; }
      if (ch === '/' && sql[i + 1] === '*') { let j = sql.indexOf('*/', i + 2); j = j < 0 ? sql.length : j + 2; out.push({ t: 'ws', v: ' ' }); i = j; continue; }
      if (/[rRbB]/.test(ch) && /['"]/.test(sql[i + 1] || '') && !/[\w]/.test(sql[i - 1] || '')) { const q = sql[i + 1]; let j = i + 2; while (j < sql.length && sql[j] !== q) j++; out.push({ t: 'str', v: sql.slice(i + 2, j), raw: true }); i = j + 1; continue; }
      if (ch === "'" || ch === '"') {
        const tri = sql.slice(i, i + 3) === ch.repeat(3);
        const q = tri ? ch.repeat(3) : ch;
        let j = i + q.length, s = '';
        while (j < sql.length && sql.slice(j, j + q.length) !== q) { if (sql[j] === '\\' && !tri) { const n = sql[j + 1]; s += n === 'n' ? '\n' : n === 't' ? '\t' : n; j += 2; continue; } s += sql[j]; j++; }
        if (j >= sql.length) throw bqErr(`Syntax error: Unclosed string literal at [${pos(sql, i)}]`);
        out.push({ t: 'str', v: s }); i = j + q.length; continue;
      }
      if (ch === '`') { const j = sql.indexOf('`', i + 1); if (j < 0) throw bqErr(`Syntax error: Unclosed identifier literal at [${pos(sql, i)}]`); out.push({ t: 'qid', v: sql.slice(i + 1, j), at: i }); i = j + 1; continue; }
      if (/[A-Za-z_]/.test(ch)) { let j = i; while (j < sql.length && /[\w]/.test(sql[j])) j++; out.push({ t: 'id', v: sql.slice(i, j), at: i }); i = j; continue; }
      if (/\d/.test(ch) || (ch === '.' && /\d/.test(sql[i + 1] || ''))) { let j = i; while (j < sql.length && /[\d.eE]/.test(sql[j])) j++; out.push({ t: 'num', v: sql.slice(i, j) }); i = j; continue; }
      const two = sql.slice(i, i + 2);
      if (['<=', '>=', '!=', '<>', '||', '::'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
      out.push({ t: 'op', v: ch, at: i }); i++;
    }
    return out;
  }
  const pos = (sql, i) => { const pre = sql.slice(0, i).split('\n'); return `${pre.length}:${pre[pre.length - 1].length + 1}`; };
  function bqErr(msg, extra) { const e = new G.Err(400, 'BQ', msg); Object.assign(e, extra || {}); return e; }
  G.bqErr = bqErr;
  const qid = (s) => '"' + s.replace(/"/g, '""') + '"';
  // 書き換え。refs に参照したテーブル（'proj:ds.t'）を集める。ctx = { project, now }
  function translate(sql, ctx) {
    const tk = tokenize(sql);
    const refs = [];
    const sig = () => tk.map((x, k) => k).filter((k) => tk[k].t !== 'ws');
    // テーブル名：`p.d.t` / `d.t` / p.d.t（区切りの . をまたぐ）
    const out = [];
    const S = (k) => tk[k] && tk[k].t !== 'ws';
    const nextSig = (k) => { k++; while (tk[k] && tk[k].t === 'ws') k++; return k; };
    const prevSig = (k) => { k--; while (k >= 0 && tk[k].t === 'ws') k--; return k; };
    const lower = (k) => (tk[k] && tk[k].t === 'id' ? tk[k].v.toLowerCase() : '');
    for (let k = 0; k < tk.length; k++) {
      const x = tk[k];
      if (x.t === 'qid') {
        // 連続する `a`.`b`.c をつなぐ
        let parts = x.v.split('.');
        let j = k;
        while (tk[j + 1] && tk[j + 1].t === 'op' && tk[j + 1].v === '.' && tk[j + 2] && (tk[j + 2].t === 'id' || tk[j + 2].t === 'qid')) { parts = parts.concat(tk[j + 2].v.split('.')); j += 2; }
        const pk = prevSig(k);
        const fromish = ['from', 'join', 'into', 'table', 'update', 'exists', 'view'].includes(lower(pk)) || (tk[pk] && tk[pk].t === 'op' && tk[pk].v === ',' && inFrom(tk, k));
        if (fromish && parts.length >= 2) {
          const ref = parts.length === 2 ? [ctx.project, parts[0], parts[1]] : parts.slice(-3);
          if (/^region-/.test(ref[0]) || /^region-/.test(parts[0])) { const reg = parts[0]; refs.push({ info: parts.slice(1).join('.'), region: reg.replace(/^region-/, '') }); out.push(qid('__info') + '.' + qid(reg.replace(/^region-/, '').replace(/-/g, '_') + '__' + parts.slice(1).join('__').toLowerCase())); k = j; continue; }
          if (ref[1] && ref[1].toUpperCase() === 'INFORMATION_SCHEMA') { refs.push({ info: ref[2], dsinfo: ref[0] }); out.push(qid('__info') + '.' + qid('ds__' + ref[0].replace(/-/g, '_') + '__' + ref[2].toLowerCase())); k = j; continue; }
          if (ref[2] && ref[2].toUpperCase() === 'INFORMATION_SCHEMA') {}
          refs.push({ project: ref[0], ds: ref[1], table: ref[2], at: x.at });
          out.push(ref.map(qid).join('.'));
        } else out.push(parts.map(qid).join('.'));
        k = j; continue;
      }
      if (x.t === 'id') {
        const kw = x.v.toLowerCase();
        // 引用符のない d.t（FROM の後）
        const pk = prevSig(k);
        if (['from', 'join', 'into', 'update', 'table', 'view', 'exists'].includes(lower(pk)) && tk[k + 1] && tk[k + 1].v === '.' && tk[k + 2] && (tk[k + 2].t === 'id' || tk[k + 2].t === 'qid')) {
          const parts = [x.v, tk[k + 2].v];
          let j = k + 2;
          if (tk[j + 1] && tk[j + 1].v === '.' && tk[j + 2] && tk[j + 2].t === 'id') { parts.push(tk[j + 2].v); j += 2; }
          const ref = parts.length === 2 ? [ctx.project, parts[0], parts[1]] : parts;
          if (ref[1].toUpperCase() === 'INFORMATION_SCHEMA') { refs.push({ info: ref[2], dsinfo: ref[0] }); out.push(qid('__info') + '.' + qid('ds__' + ref[0].replace(/-/g, '_') + '__' + ref[2].toLowerCase())); k = j; continue; }
          refs.push({ project: ref[0], ds: ref[1], table: ref[2], at: x.at });
          out.push(ref.map(qid).join('.'));
          k = j; continue;
        }
        if (['from', 'join'].includes(lower(pk)) && !(tk[k + 1] && tk[k + 1].v === '.') && !/^(unnest|select)$/i.test(x.v) && !(tk[nextSig(k)] && tk[nextSig(k)].v === '(')) {
          // FROM t（データセットのない名前）：CTE の名前かもしれないので、そのまま。テーブルなら後でエラーにする
          out.push(x.v); continue;
        }
        // 型の名前
        if (DUCK_T[x.v.toUpperCase()] && ['as', '<', ',', '(' ].includes(lower(prevSig(k)) || (tk[prevSig(k)] || {}).v)) {
          const pk2 = tk[prevSig(k)];
          if (pk2 && (lower(prevSig(k)) === 'as' || pk2.t === 'op' || pk2.t === 'id')) { out.push(DUCK_T[x.v.toUpperCase()]); continue; }
        }
        const nk = nextSig(k);
        const isCall = tk[nk] && tk[nk].v === '(';
        if (isCall) {
          const args = callArgs(tk, nk);
          const A = args.list.map((r) => tk.slice(r[0], r[1]));
          const T = (toks) => translateToks(toks, ctx, refs);
          const part = (toks) => toks.filter((y) => y.t !== 'ws').map((y) => y.v).join('').toLowerCase();
          let rep = null;
          switch (kw) {
            case 'countif': rep = `count_if(${T(A[0])})`; break;
            case 'regexp_contains': rep = `regexp_matches(${T(A[0])}, ${T(A[1])})`; break;
            case 'array_length': rep = `len(${T(A[0])})`; break;
            case 'split': rep = `string_split(${T(A[0])}, ${A[1] ? T(A[1]) : "','"})`; break;
            case 'date_trunc': case 'timestamp_trunc': case 'datetime_trunc': rep = `date_trunc('${part(A[1])}', ${T(A[0])})${kw === 'date_trunc' ? '::DATE' : ''}`; break;
            case 'date_diff': case 'timestamp_diff': case 'datetime_diff': rep = `date_diff('${part(A[2])}', ${T(A[1])}, ${T(A[0])})`; break;
            case 'date_add': case 'timestamp_add': case 'datetime_add': rep = `(${T(A[0])} + ${T(A[1])})${kw === 'date_add' ? '::DATE' : ''}`; break;
            case 'date_sub': case 'timestamp_sub': case 'datetime_sub': rep = `(${T(A[0])} - ${T(A[1])})${kw === 'date_sub' ? '::DATE' : ''}`; break;
            case 'current_date': rep = `DATE '${ctx.now.slice(0, 10)}'`; break;
            case 'current_timestamp': case 'current_datetime': rep = `TIMESTAMP '${ctx.now.replace('T', ' ').replace(/\.\d+Z$|Z$/, '')}'`; break;
            case 'safe_cast': rep = `TRY_CAST(${T(A[0])})`; break;
            case 'unnest': {
              // UNNEST(x) AS y → UNNEST(x) AS y(y)
              let j = args.end + 1; let aliasK = null; let m = nextSig(args.end);
              if (lower(m) === 'as') { aliasK = nextSig(m); j = aliasK + 1; }
              else if (tk[m] && tk[m].t === 'id' && !/^(on|where|group|order|limit|join|cross|left|inner|with|qualify|having|window|union)$/i.test(tk[m].v)) { aliasK = m; j = m + 1; }
              if (aliasK !== null && !(tk[aliasK + 1] && tk[aliasK + 1].v === '(')) { const al = tk[aliasK].v; out.push(`UNNEST(${T(A[0])}) AS ${al}(${al})`); k = j - 1; continue; }
              rep = `UNNEST(${T(A[0])})`; break;
            }
            case 'struct': rep = `struct_pack(${A.map((a) => { const s = a.filter((y) => y.t !== 'ws'); const ak = s.findIndex((y) => y.t === 'id' && y.v.toLowerCase() === 'as'); return ak > 0 ? `${s[ak + 1].v} := ${T(a.slice(0, a.indexOf(s[ak])))}` : T(a); }).join(', ')})`; break;
            case 'generate_date_array': rep = `generate_series(${T(A[0])}, ${T(A[1])}, ${A[2] ? T(A[2]) : "INTERVAL 1 DAY"})::DATE[]`; break;
            case 'array': if (A.length === 1 && /^\s*select/i.test(A[0].map((y) => y.v).join(''))) rep = `ARRAY(${T(A[0])})`; break;
          }
          if (rep !== null) { out.push(rep); k = args.end; continue; }
        }
        if (kw === 'except' && tk[prevSig(k)] && tk[prevSig(k)].v === '*') { out.push('EXCLUDE'); continue; }
        if (kw === 'current_date' && !isCall) { out.push(`DATE '${ctx.now.slice(0, 10)}'`); continue; }
        out.push(x.v); continue;
      }
      if (x.t === 'str') { out.push("'" + x.v.replace(/'/g, "''") + "'"); continue; }
      if (x.t === 'op' && x.v === '<' && /^(array|struct)$/i.test((out[out.length - 1] || '').trim())) {
        // ARRAY<T> → T[]、STRUCT<a T> → STRUCT(a T)
        let depth = 1, j = k + 1; const inner = [];
        while (j < tk.length && depth) { if (tk[j].v === '<') depth++; if (tk[j].v === '>') depth--; if (depth) inner.push(tk[j]); j++; }
        const kind = out.pop().trim().toUpperCase();
        const t = translateToks(inner, ctx, refs).replace(/\bSTRUCT\s*</gi, 'STRUCT(');
        out.push(kind === 'ARRAY' ? `${t}[]` : `STRUCT(${t})`);
        k = j - 1; continue;
      }
      out.push(x.v);
    }
    return { sql: out.join(''), refs };
  }
  function translateToks(toks, ctx, refs) { const r = translate(toks.map((y) => (y.t === 'str' ? (y.raw ? "r'" + y.v + "'" : "'" + y.v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'") : y.t === 'qid' ? '`' + y.v + '`' : y.v)).join(''), ctx); refs.push(...r.refs); return r.sql; }
  function callArgs(tk, open) {
    let depth = 0, start = open + 1; const list = [];
    for (let j = open; j < tk.length; j++) {
      const v = tk[j].t === 'op' ? tk[j].v : null;
      if (v === '(') depth++;
      else if (v === ')') { depth--; if (!depth) { if (tk.slice(start, j).some((y) => y.t !== 'ws')) list.push([start, j]); return { list, end: j }; } }
      else if (v === ',' && depth === 1) { list.push([start, j]); start = j + 1; }
    }
    throw bqErr('Syntax error: Expected ")" but got end of script');
  }
  function inFrom(tk, k) {
    for (let j = k - 1; j >= 0; j--) { if (tk[j].t !== 'id') continue; const v = tk[j].v.toLowerCase(); if (v === 'from') return true; if (['select', 'where', 'group', 'order', 'on', 'having', 'set'].includes(v)) return false; }
    return false;
  }
  G.bqTranslate = translate;

  // ---------------------------------------------------------------- エンジンにテーブルを用意する
  let loaded = {};          // 'proj:ds.t' → tok
  let catalogs = new Set();
  let engineReady = null;
  async function duck() {
    const d = await G.DUCK();
    if (!engineReady) {
      engineReady = true;
      d.conn.query(`SET default_null_order='nulls_first_on_asc_last_on_desc'`);
      d.conn.query(`CREATE OR REPLACE TEMP MACRO safe_divide(a, b) AS CASE WHEN b = 0 THEN NULL ELSE a / b END`);
      d.conn.query(`CREATE OR REPLACE TEMP MACRO format_date(f, d) AS strftime(d::DATE, f)`);
      d.conn.query(`CREATE OR REPLACE TEMP MACRO format_timestamp(f, t) AS strftime(t::TIMESTAMP, f)`);
      d.conn.query(`CREATE OR REPLACE TEMP MACRO parse_date(f, s) AS strptime(s, f)::DATE`);
      d.conn.query(`CREATE OR REPLACE TEMP MACRO ifnull2(a, b) AS coalesce(a, b)`);
      d.conn.query(`CREATE OR REPLACE TEMP MACRO safe_divide0(a, b) AS a / b`);
      d.conn.query(`ATTACH ':memory:' AS "__info"`);
    }
    return d;
  }
  let fileSeq = 0;
  async function loadTable(d, key, t) {
    const [proj, rest] = key.split(':');
    const [ds, name] = rest.split('.');
    if (!catalogs.has(proj)) { d.conn.query(`ATTACH ':memory:' AS ${qid(proj)}`); catalogs.add(proj); }
    d.conn.query(`CREATE SCHEMA IF NOT EXISTS ${qid(proj)}.${qid(ds)}`);
    const full = `${qid(proj)}.${qid(ds)}.${qid(name)}`;
    dropAny(d, full);
    if (t.type === 'VIEW') {
      const tr = translate(t.view, { project: proj, now: G.iso(0) });
      d.conn.query(`CREATE VIEW ${full} AS ${tr.sql}`);
      return;
    }
    const cols = t.schema.map((f) => `${qid(f.name)} ${duckType(f)}`).join(', ');
    d.conn.query(`CREATE TABLE ${full} (${cols})`);
    insertRows(d, full, t.schema, t.rows);
  }
  // テーブルでもビューでも、あれば消す（DuckDB は種類が違う DROP をエラーにする）
  function dropAny(d, full) {
    try { d.conn.query(`DROP VIEW IF EXISTS ${full}`); } catch (e) {}
    try { d.conn.query(`DROP TABLE IF EXISTS ${full}`); } catch (e) {}
  }
  async function ensure(w, d, keys) {
    for (const k of keys) {
      const t = tableOf(w, k);
      if (!t) continue;
      if (t.type === 'VIEW') {
        // ビューの先のテーブルも用意する
        const tr = translate(t.view, { project: k.split(':')[0], now: G.iso(0) });
        await ensure(w, d, tr.refs.filter((r) => r.table).map((r) => `${r.project}:${r.ds}.${r.table}`));
      }
      if (loaded[k] !== t.tok) { await loadTable(d, k, t); loaded[k] = t.tok; }
    }
  }
  // 値を SQL の定数にする（JSON の拡張を使わない。ブラウザの同期版の DuckDB では読み込めないため）
  const sqlStr = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  function lit(f, v) {
    if (v === null || v === undefined) return 'NULL';
    if (f.mode === 'REPEATED') return `[${(v || []).map((x) => lit(Object.assign({}, f, { mode: 'NULLABLE' }), x)).join(', ')}]::${duckType(f)}`;
    switch (f.type) {
      case 'INTEGER': case 'FLOAT': case 'NUMERIC': case 'BIGNUMERIC': return isFinite(Number(v)) ? String(Number(v)) : 'NULL';
      case 'BOOLEAN': return v ? 'TRUE' : 'FALSE';
      case 'DATE': return `DATE ${sqlStr(String(v).slice(0, 10))}`;
      case 'TIMESTAMP': case 'DATETIME': return `TIMESTAMP ${sqlStr(String(v).replace('T', ' ').replace(/Z$|\+00:00$| UTC$/, ''))}`;
      case 'RECORD': return `{${f.fields.map((x) => `${sqlStr(x.name)}: ${lit(x, v[x.name])}`).join(', ')}}`;
      case 'JSON': return sqlStr(typeof v === 'string' ? v : JSON.stringify(v));
      default: return sqlStr(typeof v === 'string' ? v : JSON.stringify(v));
    }
  }
  function insertRows(d, full, schema, rows) {
    for (let k = 0; k < rows.length; k += 400) {
      const chunk = rows.slice(k, k + 400);
      d.conn.query(`INSERT INTO ${full} VALUES ${chunk.map((r) => `(${schema.map((f) => lit(f, r[f.name])).join(', ')})`).join(', ')}`);
    }
  }
  // 結果を JavaScript の値で受け取る。DECIMAL / HUGEINT / DATE / TIMESTAMP は文字列にしてから戻す
  const plain = (v) => {
    if (typeof v === 'bigint') return Number(v);
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(plain);
    if (typeof v === 'object') {
      if (typeof v.toArray === 'function' && !(v instanceof Date)) return Array.from(v.toArray()).map(plain);
      if (typeof v.toJSON === 'function' && !(v instanceof Date)) v = v.toJSON();
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      const o = {}; for (const k of Object.keys(v)) o[k] = plain(v[k]); return o;
    }
    return v;
  };
  function fetchRows(d, sql, lim) {
    const desc = d.conn.query(`DESCRIBE ${sql}`).toArray().map((x) => x.toJSON());
    const schema = desc.map((x) => Object.assign({ name: x.column_name, mode: 'NULLABLE' }, bqType(x.column_type)));
    const sel = desc.map((x, j) => (/^(DECIMAL|HUGEINT|UHUGEINT|UBIGINT|DATE|TIMESTAMP|TIME|INTERVAL|UUID|BLOB)/i.test(x.column_type) ? `CAST(__q.${qid(x.column_name)} AS VARCHAR) AS ${qid('c' + j)}` : `__q.${qid(x.column_name)} AS ${qid('c' + j)}`)).join(', ');
    const res = d.conn.query(`SELECT ${sel || '1'} FROM (${sql}) __q${lim ? ` LIMIT ${lim}` : ''}`);
    const rows = res.toArray().map((r) => {
      const o = r.toJSON();
      const out = {};
      schema.forEach((f, j) => {
        let v = plain(o['c' + j]);
        if (v !== null && f.mode !== 'REPEATED') {
          if (f.type === 'INTEGER' || f.type === 'NUMERIC' || f.type === 'BIGNUMERIC' || f.type === 'FLOAT') v = Number(v);
          if (f.type === 'TIMESTAMP') v = String(v).replace(/\.0+$/, '');
        }
        out[f.name] = v;
      });
      return out;
    });
    return { schema, rows };
  }
  const tableOf = (w, key) => { const [proj, rest] = key.split(':'); const [ds, name] = rest.split('.'); const D = B(w).ds[`${proj}:${ds}`]; return D && D.tables[name]; };
  // エンジンの中のテーブルを、world に書き戻す
  async function readBack(w, d, key) {
    const [proj, rest] = key.split(':');
    const [ds, name] = rest.split('.');
    const full = `${qid(proj)}.${qid(ds)}.${qid(name)}`;
    return fetchRows(d, `SELECT * FROM ${full}`);
  }

  // ---------------------------------------------------------------- クエリを実行する（ジョブ）
  const jobId = (w) => `bqjob_r${G.hex('job' + G.seq(w, 'bqjob'), 13)}_${G.hex('jt' + w.t, 16)}_1`;
  // 参照した列（料金の計算用）：テーブルの列名のうち、SQL に識別子として出てくるもの。* は全部の列（EXCEPT した列を除く）
  function usedColumns(sql, t) {
    const toks = tokenize(sql).filter((x) => x.t === 'id' || x.t === 'qid' || x.v === '*');
    const names = new Set(toks.filter((x) => x.t === 'id' || x.t === 'qid').flatMap((x) => x.v.split('.')).map((s) => s.toLowerCase()));
    const star = /select\s+(\w+\.)?\*(?!\s*except)/i.test(sql) || /select\s+(distinct\s+)?\*\s*(from|,)/i.test(sql) || /select\s+(\w+\.)?\*\s*except/i.test(sql);
    const exc = new Set();
    const m = sql.match(/\*\s*except\s*\(([^)]*)\)/i);
    if (m) for (const c of m[1].split(',')) exc.add(c.trim().toLowerCase().replace(/`/g, ''));
    if (star || /count\s*\(\s*\*\s*\)/i.test(sql) && t.schema.every((f) => !names.has(f.name.toLowerCase()))) {
      if (star) return t.schema.filter((f) => !exc.has(f.name.toLowerCase()));
    }
    return t.schema.filter((f) => names.has(f.name.toLowerCase()));
  }
  // パーティションで絞れる行（WHERE に「パーティションの列 と 日付の定数」の比較があるとき）
  function prunedRows(sql, t) {
    if (!t.part) return t.rows;
    const f = t.part.field;
    const conds = [];
    const re = new RegExp(`\\b${f}\\b\\s*(=|>=|<=|>|<)\\s*(?:DATE\\s*)?['"](\\d{4}-\\d\\d-\\d\\d)['"]`, 'gi');
    let m;
    while ((m = re.exec(sql))) conds.push([m[1], m[2]]);
    const bt = new RegExp(`\\b${f}\\b\\s+BETWEEN\\s+(?:DATE\\s*)?['"](\\d{4}-\\d\\d-\\d\\d)['"]\\s+AND\\s+(?:DATE\\s*)?['"](\\d{4}-\\d\\d-\\d\\d)['"]`, 'gi');
    while ((m = bt.exec(sql))) { conds.push(['>=', m[1]]); conds.push(['<=', m[2]]); }
    if (!conds.length) return t.rows;
    const day = (v) => String(v || '').slice(0, t.part.type === 'MONTH' ? 7 : 10);
    return t.rows.filter((r) => conds.every(([op, v]) => {
      const x = day(r[f]); const y = t.part.type === 'MONTH' ? v.slice(0, 7) : v;
      if (op === '=') return x === y; if (op === '>=') return x >= y; if (op === '<=') return x <= y; if (op === '>') return t.part.type === 'MONTH' ? x >= y : x > y; if (op === '<') return t.part.type === 'MONTH' ? x <= y : x < y; return true;
    }));
  }
  function bytesFor(w, sql, refs, per) {
    let total = 0;
    for (const r of refs) {
      if (!r.table) continue;
      const t = tableOf(w, `${r.project}:${r.ds}.${r.table}`);
      if (!t) continue;
      if (t.type === 'VIEW') { const tr = translate(t.view, { project: r.project, now: G.iso(0) }); total += bytesFor(w, t.view + ' ' + sql, tr.refs); continue; }
      const cols = usedColumns(sql, t);
      const rows = prunedRows(sql, t);
      const b = rows.reduce((n, row) => n + cols.reduce((m, f) => m + sizeOf(f, row[f.name]), 0), 0);
      total += b;
      if (per) per.push(b);
    }
    return total;
  }
  // DuckDB のエラー → BigQuery 風
  function mapErr(e, sql, refs, w) {
    let msg = String(e.message || e);
    const lm = msg.match(/LINE (\d+): (.*)\n(\s*)\^/);
    let at = '';
    if (lm) { const col = lm[3].length - (`LINE ${lm[1]}: `).length + 1; at = ` at [${lm[1]}:${Math.max(1, col)}]`; }
    let m;
    if ((m = msg.match(/Referenced column "([^"]+)" not found/))) return bqErr(`Unrecognized name: ${m[1]}${at}`);
    if ((m = msg.match(/Table with name ([^\s]+) does not exist/))) return bqErr(`Table "${m[1]}" must be qualified with a dataset (e.g. dataset.table).`);
    if ((m = msg.match(/Scalar Function with name (\w+) does not exist/i))) return bqErr(`Function not found: ${m[1]}${at}`);
    if ((m = msg.match(/column "([^"]+)" must appear in the GROUP BY clause/))) return bqErr(`SELECT list expression references column ${m[1]} which is neither grouped nor aggregated${at}`);
    if (/Parser Error: syntax error at or near "([^"]*)"/.test(msg)) { const t2 = msg.match(/near "([^"]*)"/)[1]; return bqErr(`Syntax error: Unexpected ${t2 ? `keyword ${t2.toUpperCase()}` : 'end of script'}${at}`); }
    if (/Parser Error: syntax error at end of input/.test(msg)) return bqErr(`Syntax error: Unexpected end of script${at}`);
    if (/Conversion Error|Could not convert/.test(msg)) return bqErr(`Bad ${(msg.match(/to (\w+)/) || [, 'value'])[1].toLowerCase().replace('bigint', 'int64')} value: ${(msg.match(/string "([^"]*)"/) || [, ''])[1]}${at}`);
    if (/Division by zero|division by zero/i.test(msg)) return bqErr('division by zero: 1 / 0');
    if (/No function matches the given name and argument types '(\w+)\(([^)]*)\)'/.test(msg)) { const mm = msg.match(/'(\w+)\(([^)]*)\)'/); return bqErr(`No matching signature for function ${mm[1].toUpperCase()} for argument types: ${mm[2].replace(/VARCHAR/g, 'STRING').replace(/BIGINT|INTEGER/g, 'INT64').replace(/DOUBLE/g, 'FLOAT64')}${at}`); }
    return bqErr(msg.replace(/^[\w ]+Error: /, '').split('\n')[0] + at);
  }
  // 1 つのジョブ（SQL の文 1 つ以上）。戻り値：{ results: [{ schema, rows }], bytes, job }
  async function runQuery(ctx, sqlText, o = {}) {
    const w = ctx.w;
    const pid = ctx.project;
    const p = w.projects[pid];
    const nowIso = G.iso(w.t);
    const stmts = splitStatements(sqlText);
    if (!stmts.length) throw bqErr('Syntax error: Unexpected end of script at [1:1]');
    const job = { id: jobId(w), project: pid, user: ctx.who, created: w.t, query: sqlText, bytes: 0, billed: 0, type: 'QUERY', state: 'DONE', cache: false, statementType: null, location: null, error: null, dry: !!o.dry };
    if (!o.dry) B(w).jobs.push(job);
    // ジョブを作る権限（実行するプロジェクト）
    G.KNOWN.add('bigquery.jobs.create');
    if (!G.check(w, ctx.who, 'bigquery.jobs.create', 'projects/' + pid).ok) throw bqErr(`Access Denied: Project ${pid}: User does not have bigquery.jobs.create permission in project ${pid}.`, { code: 403 });
    if (!p.services.includes(SVC)) throw bqErr(`BigQuery API has not been used in project ${p.projectNumber} before or it is disabled.`, { code: 403 });
    const results = [];
    let bytesTotal = 0;
    const d = await duck();
    const sandbox = !p.billing;
    for (const st of stmts) {
      const tr = translate(st, { project: pid, now: nowIso });
      const kind = (st.trim().match(/^\(*\s*(\w+)/) || [, ''])[1].toUpperCase();
      // 参照しているテーブルがあるか、読む権限があるか
      for (const r of tr.refs) {
        if (r.info || !r.table) continue;
        const D = B(w).ds[`${r.project}:${r.ds}`];
        const creating = kind === 'CREATE' && r === tr.refs.find((x) => x.table);
        if (!D) { throw bqErr(`Not found: Dataset ${r.project}:${r.ds} was not found in location ${o.location || 'US'}`, { code: 404 }); }
        if (!job.location) job.location = D.location;
        else if (job.location !== D.location) throw bqErr(`Not found: Dataset ${r.project}:${r.ds} was not found in location ${job.location}`, { code: 404 });
        const res = `projects/${r.project}/datasets/${r.ds}/tables/${r.table}`;
        const t = D.tables[r.table];
        if (!t && !creating) {
          const dsVisible = G.check(w, ctx.who, 'bigquery.tables.get', `projects/${r.project}/datasets/${r.ds}`).ok;
          if (!dsVisible) throw bqErr(`Access Denied: Table ${r.project}:${r.ds}.${r.table}: User does not have permission to query table ${r.project}:${r.ds}.${r.table}, or perhaps it does not exist.`, { code: 403 });
          throw bqErr(`Not found: Table ${r.project}:${r.ds}.${r.table} was not found in location ${D.location}`, { code: 404 });
        }
        if (t) {
          const perm = /^(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)$/.test(kind) && tr.refs[0] === r ? 'bigquery.tables.updateData' : 'bigquery.tables.getData';
          G.KNOWN.add(perm);
          if (!G.check(w, ctx.who, perm, res).ok) throw bqErr(perm === 'bigquery.tables.getData' ? `Access Denied: Table ${r.project}:${r.ds}.${r.table}: User does not have permission to query table ${r.project}:${r.ds}.${r.table}, or perhaps it does not exist.` : `Access Denied: Table ${r.project}:${r.ds}.${r.table}: Permission bigquery.tables.updateData denied on table ${r.project}:${r.ds}.${r.table} (or it may not exist).`, { code: 403 });
        }
      }
      if (!job.location) job.location = o.location || 'US';
      if (sandbox && /^(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)$/.test(kind)) throw bqErr(`Billing has not been enabled for this project. Enable billing at https://console.cloud.google.com/billing. DML queries are not allowed in the free tier. Set up a billing account to remove this restriction.`, { code: 403 });
      // INFORMATION_SCHEMA を作る
      for (const r of tr.refs.filter((x) => x.info)) await infoSchema(w, d, ctx, r);
      await ensure(w, d, tr.refs.filter((r) => r.table && tableOf(w, `${r.project}:${r.ds}.${r.table}`)).map((r) => `${r.project}:${r.ds}.${r.table}`));
      d.conn.query(catalogs.has(pid) ? `USE ${qid(pid)}` : 'USE memory');
      const per = [];
      const bytes = bytesFor(w, st, tr.refs, per);
      job.per = (job.per || []).concat(per);
      bytesTotal += bytes;
      job.statementType = kind === 'WITH' ? 'SELECT' : kind;
      if (o.dry) continue;
      // キャッシュ（同じ SQL で、テーブルが変わっていなければ 0 バイト）
      const ck = st + '|' + tr.refs.map((r) => (r.table ? (tableOf(w, `${r.project}:${r.ds}.${r.table}`) || {}).tok : 'i' + w.t)).join(',');
      if (/^(SELECT|WITH)$/.test(kind)) {
        let r0;
        if (o.useCache !== false && B(w).cache[ck] && !tr.refs.some((r) => r.info) && !/current_(date|timestamp)/i.test(st)) { r0 = B(w).cache[ck]; job.cache = true; bytesTotal -= bytes; }
        else {
          try {
            r0 = fetchRows(d, tr.sql, o.maxRowsRead || 100000);
          } catch (e) { throw mapErr(e, st, tr.refs, w); }
          B(w).cache[ck] = r0;
        }
        results.push(r0);
        continue;
      }
      // 書き換える文
      try {
        if (/^(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)$/.test(kind)) {
          const tgt = tr.refs[0];
          const key = `${tgt.project}:${tgt.ds}.${tgt.table}`;
          const before = tableOf(w, key).rows.length;
          const res = d.conn.query(tr.sql).toArray().map((x) => x.toJSON());
          const n = res.length ? Number(Object.values(res[0])[0]) : 0;
          const back = await readBack(w, d, key);
          const t = tableOf(w, key);
          t.rows = back.rows; t.modified = w.t; t.tok = newTok(); loaded[key] = t.tok;
          results.push({ dml: kind, n: kind === 'INSERT' ? t.rows.length - before : n, table: key });
          job.affected = (job.affected || 0) + n;
        } else if (/^(CREATE|DROP|ALTER)$/.test(kind)) {
          const m = st.match(/^\s*(CREATE|DROP|ALTER)\s+(OR\s+REPLACE\s+)?(TEMP\s+|TEMPORARY\s+)?(TABLE|VIEW|SCHEMA)\s+(IF\s+(NOT\s+)?EXISTS\s+)?`?([\w.:-]+)`?/i);
          if (!m) throw bqErr(`このサイトの BigQuery では、この文は実行できません：${st.slice(0, 40)}`);
          const verb = m[1].toUpperCase(), what = m[4].toUpperCase();
          const parts = m[7].split('.');
          const ref = parts.length === 2 ? [pid, parts[0], parts[1]] : parts;
          const D = B(w).ds[`${ref[0]}:${ref[1]}`];
          if (what === 'SCHEMA') throw bqErr('データセットは bq mk --dataset で作ってください（このサイトでは CREATE SCHEMA に対応していません）');
          if (!D) throw bqErr(`Not found: Dataset ${ref[0]}:${ref[1]} was not found in location ${job.location}`, { code: 404 });
          const key = `${ref[0]}:${ref[1]}.${ref[2]}`;
          G.KNOWN.add('bigquery.tables.create');
          if (verb !== 'DROP' && !G.check(w, ctx.who, 'bigquery.tables.create', `projects/${ref[0]}/datasets/${ref[1]}`).ok) throw bqErr(`Access Denied: Dataset ${ref[0]}:${ref[1]}: Permission bigquery.tables.create denied on dataset ${ref[0]}:${ref[1]} (or it may not exist).`, { code: 403 });
          if (verb === 'DROP') {
            if (!D.tables[ref[2]]) { if (m[5]) { results.push({ ddl: `DROP_${what}` }); continue; } throw bqErr(`Not found: Table ${key} was not found in location ${job.location}`, { code: 404 }); }
            delete D.tables[ref[2]]; delete loaded[key];
            results.push({ ddl: `DROP_${what}`, table: key });
            continue;
          }
          if (D.tables[ref[2]] && !m[2]) { if (m[5]) { results.push({ ddl: 'SKIP' }); continue; } throw bqErr(`Already Exists: Table ${key}`, { code: 409 }); }
          if (what === 'VIEW') {
            const vq = st.replace(/^[\s\S]*?\bAS\b\s*/i, '');
            dropAny(d, ref.map(qid).join('.')); delete loaded[key];
            D.tables[ref[2]] = { type: 'VIEW', view: vq, schema: [], rows: [], created: w.t, modified: w.t, tok: newTok() };
            try { await ensure(w, d, [key]); const desc = d.conn.query(`DESCRIBE SELECT * FROM ${ref.map(qid).join('.')}`).toArray().map((x) => x.toJSON()); D.tables[ref[2]].schema = desc.map((x) => Object.assign({ name: x.column_name, mode: 'NULLABLE' }, bqType(x.column_type))); }
            catch (e) { delete D.tables[ref[2]]; throw mapErr(e, st, tr.refs, w); }
            results.push({ ddl: 'CREATE_VIEW', table: key });
            continue;
          }
          const full = ref.map(qid).join('.');
          if (!D.tables[ref[2]]) { dropAny(d, full); delete loaded[key]; }
          if (!catalogs.has(ref[0])) { d.conn.query(`ATTACH ':memory:' AS ${qid(ref[0])}`); catalogs.add(ref[0]); }
          d.conn.query(`CREATE SCHEMA IF NOT EXISTS ${qid(ref[0])}.${qid(ref[1])}`);
          // PARTITION BY と CLUSTER BY は、エンジンには渡さずに覚えておく
          let sqlD = tr.sql;
          let part = null, cluster = null;
          const pm = sqlD.match(/\bPARTITION\s+BY\s+(?:DATE\s*\(\s*)?"?(\w+)"?\s*\)?/i);
          if (pm) { part = { field: pm[1], type: 'DAY' }; sqlD = sqlD.replace(pm[0], ' '); }
          const cm = sqlD.match(/\bCLUSTER\s+BY\s+([\w\s,"]+?)(?=\bAS\b|\bOPTIONS\b|$)/i);
          if (cm) { cluster = cm[1].split(',').map((x) => x.trim().replace(/"/g, '')); sqlD = sqlD.replace(cm[0], ' '); }
          sqlD = sqlD.replace(/\bOPTIONS\s*\([^)]*\)/i, ' ');
          sqlD = sqlD.replace(/^\s*CREATE\s+OR\s+REPLACE\s+TABLE/i, 'CREATE OR REPLACE TABLE');
          d.conn.query(sqlD);
          const back = await readBack(w, d, key);
          D.tables[ref[2]] = { type: 'TABLE', schema: back.schema, rows: back.rows, created: w.t, modified: w.t, tok: newTok(), part, cluster, expire: D.defaultExpire ? w.t + D.defaultExpire : null };
          loaded[key] = D.tables[ref[2]].tok;
          results.push({ ddl: m[2] ? 'CREATE_OR_REPLACE_TABLE' : /\bAS\s+SELECT\b|\bAS\s*\(/i.test(st) ? 'CREATE_TABLE_AS_SELECT' : 'CREATE_TABLE', table: key, n: back.rows.length });
        } else throw bqErr(`このサイトの BigQuery では、この文は実行できません：${kind}`);
      } catch (e) { if (e instanceof G.Err) throw e; throw mapErr(e, st, tr.refs, w); }
    }
    job.bytes = bytesTotal;
    // オンデマンドの課金：参照したテーブルごとに最低 10 MB、MB 単位に切り上げ
    job.billed = job.cache || o.dry || !bytesTotal ? 0 : (job.per || []).reduce((n, b) => n + Math.max(10 * 1048576, Math.ceil(b / 1048576) * 1048576), 0);
    if (o.maxBilled !== undefined && job.billed > o.maxBilled) { const need = job.billed; job.billed = 0; job.bytes = 0; job.state = 'DONE'; job.error = 'bytesBilledLimitExceeded'; throw bqErr(`Query exceeded limit for bytes billed: ${o.maxBilled}. ${need} or higher required.`); }
    G.tick(w, 800 + Math.min(4000, bytesTotal / 1000));
    if (!o.dry) G.audit(w, { project: pid, who: ctx.who, method: 'jobservice.jobcompleted', perm: 'bigquery.jobs.create', res: `projects/${pid}/jobs/${job.id}`, svc: SVC, resType: 'bigquery_project', read: true, forceData: true });
    return { results, bytes: bytesTotal, job };
  }
  G.bqQuery = runQuery;
  function splitStatements(s) {
    const out = []; let cur = '', q = null, depth = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) { cur += ch; if (ch === q && s[i - 1] !== '\\') q = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; continue; }
      if (ch === '-' && s[i + 1] === '-') { const e = s.indexOf('\n', i); const end = e < 0 ? s.length : e; cur += s.slice(i, end); i = end - 1; continue; }
      if (ch === '(') depth++; if (ch === ')') depth--;
      if (ch === ';' && !depth) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out.filter((x) => x.replace(/--.*$/gm, '').trim());
  }
  // INFORMATION_SCHEMA（JOBS は自分のプロジェクトのジョブ、TABLES / COLUMNS はデータセットの中）
  async function infoSchema(w, d, ctx, r) {
    if (r.region) {
      const name = r.region.replace(/-/g, '_') + '__' + r.info.split('.').join('__').toLowerCase();
      const jobs = B(w).jobs.filter((j) => j.project === ctx.project && (j.location || 'US').toLowerCase() === r.region.toLowerCase()).map((j) => ({ job_id: j.id, creation_time: G.iso(j.created).replace('T', ' ').replace('Z', ''), user_email: j.user, job_type: j.type, statement_type: j.statementType, state: j.state, query: j.query, total_bytes_processed: j.bytes, total_bytes_billed: j.billed, cache_hit: j.cache, project_id: j.project }));
      if (!/^information_schema__jobs(_by_project)?$/.test(r.info.toLowerCase().replace(/\./g, '__'))) throw bqErr(`このサイトの INFORMATION_SCHEMA は、JOBS（JOBS_BY_PROJECT）だけに対応しています：${r.info}`);
      d.conn.query(`DROP TABLE IF EXISTS "__info".${qid(name)}`);
      d.conn.query(`CREATE TABLE "__info".${qid(name)} (job_id VARCHAR, creation_time TIMESTAMP, user_email VARCHAR, job_type VARCHAR, statement_type VARCHAR, state VARCHAR, query VARCHAR, total_bytes_processed BIGINT, total_bytes_billed BIGINT, cache_hit BOOLEAN, project_id VARCHAR)`);
      const St = (n, t) => ({ name: n, type: t, mode: 'NULLABLE' });
      insertRows(d, `"__info".${qid(name)}`, [St('job_id', 'STRING'), St('creation_time', 'TIMESTAMP'), St('user_email', 'STRING'), St('job_type', 'STRING'), St('statement_type', 'STRING'), St('state', 'STRING'), St('query', 'STRING'), St('total_bytes_processed', 'INTEGER'), St('total_bytes_billed', 'INTEGER'), St('cache_hit', 'BOOLEAN'), St('project_id', 'STRING')], jobs);
      return;
    }
    const D = B(w).ds[`${ctx.project}:${r.dsinfo}`] || Object.entries(B(w).ds).find(([k]) => k.endsWith(':' + r.dsinfo));
    const ds = Array.isArray(D) ? D[1] : D;
    if (!ds) throw bqErr(`Not found: Dataset ${ctx.project}:${r.dsinfo} was not found in location US`, { code: 404 });
    const name = 'ds__' + r.dsinfo.replace(/-/g, '_') + '__' + r.info.toLowerCase();
    let rows, cols;
    if (r.info.toUpperCase() === 'TABLES') { rows = Object.entries(ds.tables).map(([n, t]) => ({ table_name: n, table_type: t.type === 'VIEW' ? 'VIEW' : 'BASE TABLE', creation_time: G.iso(t.created).replace('T', ' ').replace('Z', '') })); cols = { table_name: 'VARCHAR', table_type: 'VARCHAR', creation_time: 'TIMESTAMP' }; }
    else if (r.info.toUpperCase() === 'COLUMNS') { rows = Object.entries(ds.tables).flatMap(([n, t]) => t.schema.map((f, k) => ({ table_name: n, column_name: f.name, ordinal_position: k + 1, data_type: ({ INTEGER: 'INT64', FLOAT: 'FLOAT64', BOOLEAN: 'BOOL', RECORD: 'STRUCT' })[f.type] || f.type, is_partitioning_column: t.part && t.part.field === f.name ? 'YES' : 'NO', clustering_ordinal_position: t.cluster && t.cluster.includes(f.name) ? t.cluster.indexOf(f.name) + 1 : null }))); cols = { table_name: 'VARCHAR', column_name: 'VARCHAR', ordinal_position: 'BIGINT', data_type: 'VARCHAR', is_partitioning_column: 'VARCHAR', clustering_ordinal_position: 'BIGINT' }; }
    else if (r.info.toUpperCase() === 'PARTITIONS') { rows = Object.entries(ds.tables).filter(([, t]) => t.part).flatMap(([n, t]) => { const m = {}; for (const row of t.rows) { const k = String(row[t.part.field]).slice(0, 10).replace(/-/g, ''); m[k] = (m[k] || 0) + 1; } return Object.keys(m).sort().map((k) => ({ table_name: n, partition_id: k, total_rows: m[k] })); }); cols = { table_name: 'VARCHAR', partition_id: 'VARCHAR', total_rows: 'BIGINT' }; }
    else throw bqErr(`このサイトの INFORMATION_SCHEMA は TABLES / COLUMNS / PARTITIONS / JOBS だけです：${r.info}`);
    d.conn.query(`DROP TABLE IF EXISTS "__info".${qid(name)}`);
    d.conn.query(`CREATE TABLE "__info".${qid(name)} (${Object.entries(cols).map(([k, t]) => `${k} ${t}`).join(', ')})`);
    const BT = { VARCHAR: 'STRING', TIMESTAMP: 'TIMESTAMP', BIGINT: 'INTEGER' };
    insertRows(d, `"__info".${qid(name)}`, Object.entries(cols).map(([k, t]) => ({ name: k, type: BT[t], mode: 'NULLABLE' })), rows);
  }

  // ---------------------------------------------------------------- 表示
  const wlen = (s) => [...String(s)].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0);
  const fmtVal = (f, v) => {
    if (v === null || v === undefined) return 'NULL';
    if (f.mode === 'REPEATED' || f.type === 'RECORD') return JSON.stringify(v);
    if (f.type === 'FLOAT') { const n = Number(v); return Number.isInteger(n) ? n.toFixed(1) : String(n); }
    if (f.type === 'NUMERIC' || f.type === 'BIGNUMERIC') return String(v).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    if (f.type === 'TIMESTAMP') return String(v).replace('T', ' ').replace(/(\.\d+)?Z?$/, '') ;
    if (f.type === 'BOOLEAN') return v ? 'true' : 'false';
    return String(v);
  };
  const strVal = (f, v) => (v === null || v === undefined ? null : f.mode === 'REPEATED' || f.type === 'RECORD' ? v : fmtVal(f, v));
  function pretty(r) {
    const cols = r.schema.map((f) => f.name);
    const right = r.schema.map((f) => ['INTEGER', 'FLOAT', 'NUMERIC', 'BIGNUMERIC'].includes(f.type) && f.mode !== 'REPEATED');
    const rows = r.rows.map((row) => r.schema.map((f) => fmtVal(f, row[f.name])));
    const W = cols.map((c, j) => Math.max(wlen(c), ...rows.map((x) => wlen(x[j]))));
    const line = '+' + W.map((n) => '-'.repeat(n + 2)).join('+') + '+';
    const center = (s, n) => { const sp = n - wlen(s); const l = Math.floor(sp / 2); return ' '.repeat(l) + s + ' '.repeat(sp - l); };
    const padL = (s, n) => ' '.repeat(Math.max(0, n - wlen(s))) + s;
    const padR = (s, n) => s + ' '.repeat(Math.max(0, n - wlen(s)));
    const out = [line, '| ' + cols.map((c, j) => center(c, W[j])).join(' | ') + ' |', line];
    for (const x of rows) out.push('| ' + x.map((s, j) => (right[j] ? padL(s, W[j]) : padR(s, W[j]))).join(' | ') + ' |');
    out.push(line);
    return out.join('\n') + '\n';
  }
  function render(r, fmt) {
    fmt = fmt || 'pretty';
    if (fmt === 'none') return '';
    if (fmt === 'json' || fmt === 'prettyjson') {
      const rows = r.rows.map((row) => Object.fromEntries(r.schema.map((f) => [f.name, strVal(f, row[f.name])])));
      return (fmt === 'json' ? JSON.stringify(rows) : JSON.stringify(rows, null, 2)) + '\n';
    }
    if (fmt === 'csv') return [r.schema.map((f) => f.name).join(',')].concat(r.rows.map((row) => r.schema.map((f) => { const s = row[f.name] === null || row[f.name] === undefined ? '' : fmtVal(f, row[f.name]); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(','))).join('\n') + '\n';
    if (fmt === 'sparse') {
      const W = r.schema.map((f) => Math.max(wlen(f.name), ...r.rows.map((row) => wlen(fmtVal(f, row[f.name])))));
      const pad = (s, n) => s + ' '.repeat(Math.max(0, n - wlen(s)));
      return [' ' + r.schema.map((f, j) => pad(f.name, W[j])).join('  '), ' ' + W.map((n) => '-'.repeat(n)).join('  ')].concat(r.rows.map((row) => ' ' + r.schema.map((f, j) => pad(fmtVal(f, row[f.name]), W[j])).join('  '))).join('\n').replace(/[ ]+$/gm, '') + '\n';
    }
    return pretty(r);
  }
  G.bqRender = render;

  // ---------------------------------------------------------------- bq コマンド
  const BQ_GLOBAL = { project_id: 'v', location: 'v', format: 'v', quiet: 'b', q: 'b', headless: 'b', apilog: 'v', dataset_id: 'v', synchronous_mode: 'b', max_rows_per_request: 'v' };
  const BQ = {};
  const bqc = (name, spec) => { BQ[name] = spec; };
  function bqParse(args, spec) {
    const flags = Object.assign({}, BQ_GLOBAL, spec.flags || {});
    const a = {}, p = [];
    for (let i = 0; i < args.length; i++) {
      const x = args[i];
      if (/^--?\w/.test(x)) {
        let [k, v] = x.replace(/^--?/, '').split(/=(.*)/s);
        if (k.length === 1 && spec.short && spec.short[k]) k = spec.short[k];
        let t = flags[k];
        if (!t && k.startsWith('no') && flags[k.slice(2)] === 'b') { a[k.slice(2)] = false; continue; }
        if (!t) throw bqUsage(`FATAL Flags parsing error: Unknown command line flag '${k}'`);
        if (t === 'b') { a[k] = v === undefined ? true : !/^(false|0)$/i.test(v); continue; }
        if (v === undefined) { if (i + 1 >= args.length) throw bqUsage(`FATAL Flags parsing error: flag --${k}: Flag requires a value`); v = args[++i]; }
        if (t === 'v*') (a[k] = a[k] || []).push(v); else a[k] = v;
        continue;
      }
      p.push(x);
    }
    return { a, p };
  }
  const bqUsage = (m) => Object.assign(new Error(m), { bqUsage: true });
  // 'ds' / 'proj:ds' / 'proj.ds' / 'ds.t' / 'proj:ds.t'
  function parseRef(c, s, want) {
    let proj = c.project, rest = s;
    const ci = s.indexOf(':');
    if (ci > 0) { proj = s.slice(0, ci); rest = s.slice(ci + 1); }
    const parts = rest.split('.');
    if (ci < 0 && parts.length === 3) { proj = parts[0]; parts.shift(); }
    if (want === 'ds' && parts.length === 2 && ci < 0 && !c.p2) { /* proj.ds */ }
    return { project: proj, ds: parts[0], table: parts[1] };
  }
  const dsKey = (r) => `${r.project}:${r.ds}`;
  G.CMDS.bq = async (sys, args, io) => {
    const w = sys.w;
    // 先頭の共通フラグ
    let k = 0;
    const lead = [];
    while (args[k] && /^--?\w/.test(args[k]) && BQ_GLOBAL[args[k].replace(/^--?/, '').split('=')[0].replace(/^no/, '')]) { lead.push(args[k]); if (!args[k].includes('=') && BQ_GLOBAL[args[k].replace(/^--?/, '')] === 'v') lead.push(args[++k]); k++; }
    const cmd = args[k];
    if (!cmd || cmd === 'help') { io.out('Python script for interacting with BigQuery.\n\nUSAGE: bq [--global_flags] <command> [--command_flags] [args]\n\nAny of the following commands:\n  cp, extract, head, help, load, ls, mk, query, rm, show, update, version\n'); return 0; }
    if (cmd === 'version') { io.out('This is BigQuery CLI 2.1.25\n'); return 0; }
    const spec = BQ[cmd];
    if (!spec) { io.err(`FATAL Error: Unknown command: ${cmd}\nRun 'bq help' to get help.\n`); return 1; }
    let parsed;
    try { parsed = bqParse(lead.concat(args.slice(k + 1)), spec); }
    catch (e) { if (e.bqUsage) { io.err(e.message + '\nRun \'bq help\' to get help\n'); return 1; } throw e; }
    const who = G.cfgGet(w, 'core/account');
    if (!who || !(w.creds || []).includes(who)) { io.err('You do not have a valid credential. Please run:\n  gcloud auth login\n'); return 1; }
    const c = { sys, w, a: parsed.a, p: parsed.p, out: io.out, err: io.err, stdin: io.stdin, who: sys.vm ? sys.vm.sa : who, project: parsed.a.project_id || G.cfgGet(w, 'core/project') };
    G.advance(w, 600);
    if (!c.project) { io.err('BigQuery error in ' + cmd + ' operation: No project specified. Please set a project with "gcloud config set project PROJECT_ID" or the --project_id flag.\n'); return 1; }
    try { return (await spec.run(c)) || 0; }
    catch (e) {
      if (e instanceof G.Err) {
        const pre = spec.errPrefix ? spec.errPrefix(c) : `BigQuery error in ${cmd} operation: `;
        io.err(pre + e.message + '\n');
        return e.status === 'USAGE' ? 1 : e.exit || (e.code === 404 && cmd !== 'query' ? 2 : 1);
      }
      throw e;
    }
  };
  const needDs = (c, r, perm) => {
    const D = B(c.w).ds[dsKey(r)];
    if (!D) throw new G.Err(404, 'BQ', `Not found: Dataset ${dsKey(r)}`, { code: 404 });
    if (perm) { G.KNOWN.add(perm); if (!G.check(c.w, c.who, perm, `projects/${r.project}/datasets/${r.ds}`).ok) throw new G.Err(403, 'BQ', `Access Denied: Dataset ${dsKey(r)}: Permission ${perm} denied on dataset ${dsKey(r)} (or it may not exist).`, { code: 403 }); }
    return D;
  };
  const needTable = (c, r, perm) => {
    const D = needDs(c, r, null);
    const t = D.tables[r.table];
    const res = `projects/${r.project}/datasets/${r.ds}/tables/${r.table}`;
    if (perm) { G.KNOWN.add(perm); if (!G.check(c.w, c.who, perm, res).ok) throw new G.Err(403, 'BQ', `Access Denied: Table ${dsKey(r)}.${r.table}: Permission ${perm} denied on table ${dsKey(r)}.${r.table} (or it may not exist).`, { code: 403 }); }
    if (!t) throw new G.Err(404, 'BQ', `Not found: Table ${dsKey(r)}.${r.table}`, { code: 404 });
    return t;
  };
  // スキーマ：'name:STRING,price:INTEGER' か、JSON のファイル
  function parseSchema(c, s) {
    if (!s) return null;
    const f = G.fs.read(c.sys, s);
    if (f !== null) { const j = JSON.parse(f); return (Array.isArray(j) ? j : j.fields || j.schema.fields).map(normField); }
    return s.split(',').map((x) => { const [name, type] = x.split(':'); return normField({ name: name.trim(), type: (type || 'STRING').trim() }); });
  }
  const TYPE_ALIAS = { INT64: 'INTEGER', INT: 'INTEGER', FLOAT64: 'FLOAT', BOOL: 'BOOLEAN', STRUCT: 'RECORD', DECIMAL: 'NUMERIC' };
  const normField = (f) => Object.assign({ name: f.name, type: TYPE_ALIAS[String(f.type).toUpperCase()] || String(f.type).toUpperCase(), mode: (f.mode || 'NULLABLE').toUpperCase() }, f.fields ? { fields: f.fields.map(normField) } : {});
  const prettySchema = (schema, ind = '') => schema.flatMap((f) => [`${ind}|- ${f.name}: ${f.type.toLowerCase()}${f.mode === 'REPEATED' ? ' (repeated)' : f.mode === 'REQUIRED' ? ' (required)' : ''}`].concat(f.fields ? prettySchema(f.fields, ind + '|  ') : []));
  const dmy = (t) => { const d = new Date(G.T0 + t); const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; const p = (n) => String(n).padStart(2, '0'); return `${p(d.getUTCDate())} ${M[d.getUTCMonth()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; };
  // bq の表（bq ls、bq show の形）
  function bqTable(heads, rows) {
    const cellLines = (s) => String(s === undefined || s === null ? '' : s).split('\n');
    const W = heads.map((h, j) => Math.max(wlen(h), ...rows.flatMap((r) => cellLines(r[j]).map(wlen))));
    const pad = (s, n) => s + ' '.repeat(Math.max(0, n - wlen(s)));
    const center = (s, n) => { const sp = n - wlen(s); const l = Math.floor(sp / 2); return ' '.repeat(l) + s + ' '.repeat(sp - l); };
    const out = ['  ' + heads.map((h, j) => center(h, W[j])).join('   '), ' ' + W.map((n) => '-'.repeat(n + 2)).join(' ')];
    for (const r of rows) { const h = Math.max(...r.map((x) => cellLines(x).length)); for (let i = 0; i < h; i++) out.push('  ' + r.map((x, j) => pad(cellLines(x)[i] || '', W[j])).join('   ')); }
    return out.map((l) => l.replace(/\s+$/, '')).join('\n') + '\n';
  }
  const waitLine = (c, job, s = 0) => c.err(`Waiting on ${job.id} ... (${s}s) Current status: DONE   \n`);

  bqc('ls', { flags: { a: 'b', all: 'b', j: 'b', jobs: 'b', n: 'v', max_results: 'v', d: 'b', datasets: 'b', p: 'b', projects: 'b' }, short: { j: 'jobs', n: 'max_results', d: 'datasets', p: 'projects', a: 'all' }, run: async (c) => {
    if (c.a.jobs) {
      const jobs = B(c.w).jobs.filter((j) => j.project === c.project).slice(-(Number(c.a.max_results) || 10)).reverse();
      c.out(bqTable(['jobId', 'Job Type', 'State', 'Start Time', 'Duration'], jobs.map((j) => [j.id, j.type === 'QUERY' ? 'query' : j.type.toLowerCase(), 'SUCCESS', dmy(j.created), '0:00:01'])));
      return;
    }
    if (c.a.projects) { c.out(bqTable(['projectId', 'friendlyName'], Object.values(c.w.projects).filter((p) => p.lifecycleState === 'ACTIVE' && G.check(c.w, c.who, 'resourcemanager.projects.get', 'projects/' + p.projectId).ok).map((p) => [p.projectId, p.name]))); return; }
    if (!c.p.length || c.a.datasets || /:$/.test(c.p[0])) {
      const proj = c.p[0] ? c.p[0].replace(/:$/, '') : c.project;
      G.KNOWN.add('bigquery.datasets.get');
      const list = Object.entries(B(c.w).ds).filter(([k]) => k.startsWith(proj + ':')).filter(([k]) => G.check(c.w, c.who, 'bigquery.datasets.get', `projects/${proj}/datasets/${k.split(':')[1]}`).ok || G.check(c.w, c.who, 'bigquery.tables.list', `projects/${proj}/datasets/${k.split(':')[1]}`).ok);
      if (!list.length) { if (proj !== c.project && !G.check(c.w, c.who, 'bigquery.datasets.get', 'projects/' + proj).ok) {} return; }
      c.out(bqTable(['datasetId'], list.map(([k]) => [k.split(':')[1]])));
      return;
    }
    const r = parseRef(c, c.p[0]);
    const D = needDs(c, r, 'bigquery.tables.list');
    const names = Object.keys(D.tables).sort();
    if (!names.length) return;
    c.out(bqTable(['tableId', 'Type', 'Labels', 'Time Partitioning', 'Clustered Fields'], names.map((n) => { const t = D.tables[n]; return [n, t.type === 'VIEW' ? 'VIEW' : 'TABLE', '', t.part ? `${t.part.type} (field: ${t.part.field})` : '', (t.cluster || []).join(', ')]; })));
  } });
  bqc('mk', { flags: { d: 'b', dataset: 'b', t: 'b', table: 'b', location: 'v', description: 'v', schema: 'v', time_partitioning_field: 'v', time_partitioning_type: 'v', clustering_fields: 'v', view: 'v', use_legacy_sql: 'b', default_table_expiration: 'v', expiration: 'v', label: 'v*', f: 'b', force: 'b' }, short: { d: 'dataset', t: 'table', f: 'force' }, run: async (c) => {
    const target = c.p[0];
    if (!target) throw new G.Err(0, 'USAGE', 'Must specify identifier for mk.');
    const r = parseRef(c, target);
    const isTable = c.a.table || c.a.view !== undefined || (!c.a.dataset && r.table);
    if (!isTable) {
      G.KNOWN.add('bigquery.datasets.create');
      if (!G.check(c.w, c.who, 'bigquery.datasets.create', 'projects/' + r.project).ok) throw new G.Err(403, 'BQ', `Access Denied: Project ${r.project}: User does not have bigquery.datasets.create permission in project ${r.project}.`, { code: 403 });
      if (!/^\w{1,1024}$/.test(r.ds)) throw new G.Err(400, 'BQ', `Invalid dataset ID "${r.ds}". Dataset IDs must be alphanumeric (plus underscores) and must be at most 1024 characters long.`);
      if (B(c.w).ds[dsKey(r)]) { if (c.a.force) return; throw new G.Err(409, 'BQ', `Dataset '${dsKey(r)}' already exists.`, { exit: 1 }); }
      const p = c.w.projects[r.project];
      const loc = c.a.location || 'US';
      B(c.w).ds[dsKey(r)] = { location: loc === 'us' ? 'US' : loc === 'eu' ? 'EU' : loc, created: c.w.t, desc: c.a.description || '', labels: {}, tables: {}, defaultExpire: !p.billing ? 60 * 86400 * 1000 : c.a.default_table_expiration ? Number(c.a.default_table_expiration) * 1000 : null };
      c.w.policies[`projects/${r.project}/datasets/${r.ds}`] = { version: 1, etag: 'BwY' + G.alnum('ds' + dsKey(r), 9) + '=', bindings: [] };
      G.audit(c.w, { project: r.project, who: c.who, method: 'google.cloud.bigquery.v2.DatasetService.InsertDataset', perm: 'bigquery.datasets.create', res: `projects/${r.project}/datasets/${r.ds}`, svc: SVC, resType: 'bigquery_dataset' });
      c.out(`Dataset '${dsKey(r)}' successfully created.\n`);
      return;
    }
    const D = needDs(c, r, 'bigquery.tables.create');
    if (D.tables[r.table]) { if (c.a.force) return; throw new G.Err(409, 'BQ', `Table '${dsKey(r)}.${r.table}' could not be created; a table with this name already exists.`, { exit: 1 }); }
    if (c.a.view !== undefined) {
      if (c.a.use_legacy_sql !== false) throw new G.Err(400, 'BQ', `Invalid table name: \`${(c.a.view.match(/`([^`]+)`/) || [, '?'])[1]}\`\n[Try using standard SQL (https://cloud.google.com/bigquery/docs/reference/standard-sql/enabling-standard-sql)].`);
      D.tables[r.table] = { type: 'VIEW', view: c.a.view, schema: [], rows: [], created: c.w.t, modified: c.w.t, tok: newTok() };
      try { const res = await runQuery({ w: c.w, who: c.who, project: c.project }, c.a.view, { dry: true }); } catch (e) { delete D.tables[r.table]; throw e; }
      c.out(`View '${dsKey(r)}.${r.table}' successfully created.\n`);
      return;
    }
    const schema = parseSchema(c, c.a.schema || c.p[1]) || [];
    D.tables[r.table] = { type: 'TABLE', schema, rows: [], created: c.w.t, modified: c.w.t, tok: newTok(), expire: D.defaultExpire ? c.w.t + D.defaultExpire : null, part: c.a.time_partitioning_field || c.a.time_partitioning_type ? { field: c.a.time_partitioning_field || '_PARTITIONTIME', type: (c.a.time_partitioning_type || 'DAY').toUpperCase() } : null, cluster: c.a.clustering_fields ? c.a.clustering_fields.split(',') : null };
    if (c.a.time_partitioning_field && !schema.some((f) => f.name === c.a.time_partitioning_field && /DATE|TIMESTAMP|DATETIME/.test(f.type))) { delete D.tables[r.table]; throw new G.Err(400, 'BQ', `The field specified for partitioning cannot be found in the schema`); }
    c.out(`Table '${dsKey(r)}.${r.table}' successfully created.\n`);
  } });
  bqc('rm', { flags: { r: 'b', recursive: 'b', f: 'b', force: 'b', d: 'b', dataset: 'b', t: 'b', table: 'b' }, short: { r: 'recursive', f: 'force', d: 'dataset', t: 'table' }, run: async (c) => {
    const r = parseRef(c, c.p[0] || '');
    const isDs = c.a.dataset || (!c.a.table && !r.table);
    const label = isDs ? `dataset '${dsKey(r)}'` : `table '${dsKey(r)}.${r.table}'`;
    if (!c.a.force) { const ans = (c.stdin || '').trim().toLowerCase(); c.out(`rm: remove ${label}? (y/N) `); if (ans !== 'y' && ans !== 'yes') { c.out('\n'); return; } c.out('\n'); }
    if (isDs) {
      const D = needDs(c, r, 'bigquery.datasets.delete');
      if (Object.keys(D.tables).length && !c.a.recursive) throw new G.Err(400, 'BQ', `Dataset ${dsKey(r)} is still in use`);
      delete B(c.w).ds[dsKey(r)];
      return;
    }
    needTable(c, r, 'bigquery.tables.delete');
    delete needDs(c, r).tables[r.table];
    delete loaded[`${dsKey(r)}.${r.table}`];
  } });
  bqc('show', { flags: { schema: 'b', j: 'b', job: 'b', d: 'b', dataset: 'b', view: 'b' }, short: { j: 'job', d: 'dataset' }, run: async (c) => {
    const fmt = c.a.format;
    if (c.a.job) {
      const j = B(c.w).jobs.find((x) => x.id === c.p[0] || x.id === (c.p[0] || '').split('.').pop() || `${x.project}:${x.location}.${x.id}` === c.p[0]);
      if (!j) throw new G.Err(404, 'BQ', `Not found: Job ${c.project}:${c.p[0]}`, { code: 404 });
      if (fmt === 'json' || fmt === 'prettyjson') { const o = { jobReference: { jobId: j.id, location: j.location, projectId: j.project }, statistics: { creationTime: String(G.T0 + j.created), query: { cacheHit: j.cache, statementType: j.statementType, totalBytesBilled: String(j.billed), totalBytesProcessed: String(j.bytes) }, totalBytesProcessed: String(j.bytes) }, status: { state: 'DONE' }, user_email: j.user }; c.out((fmt === 'json' ? JSON.stringify(o) : JSON.stringify(o, null, 2)) + '\n'); return; }
      c.out(`Job ${j.project}:${j.id}\n\n` + bqTable(['Job Type', 'State', 'Start Time', 'Duration', 'User Email', 'Bytes Processed', 'Bytes Billed', 'Billing Tier', 'Labels'], [['query', 'SUCCESS', dmy(j.created), '0:00:01', j.user, String(j.bytes), String(j.billed), j.billed ? '1' : '', '']]));
      return;
    }
    const r = parseRef(c, c.p[0] || '');
    if (!r.table || c.a.dataset) {
      const D = needDs(c, r, 'bigquery.datasets.get');
      const pol = c.w.policies[`projects/${r.project}/datasets/${r.ds}`] || { bindings: [] };
      if (fmt === 'json' || fmt === 'prettyjson') { const o = { creationTime: String(G.T0 + D.created), datasetReference: { datasetId: r.ds, projectId: r.project }, defaultTableExpirationMs: D.defaultExpire ? String(D.defaultExpire) : undefined, description: D.desc || undefined, id: dsKey(r), kind: 'bigquery#dataset', location: D.location, access: pol.bindings.flatMap((b) => b.members.map((m) => ({ role: b.role, [m.startsWith('group:') ? 'groupByEmail' : m.startsWith('domain:') ? 'domain' : m === 'allAuthenticatedUsers' ? 'iamMember' : 'userByEmail']: m.replace(/^\w+:/, '') }))) }; c.out((fmt === 'json' ? JSON.stringify(o) : JSON.stringify(o, null, 2)) + '\n'); return; }
      c.out(`Dataset ${dsKey(r)}\n\n` + bqTable(['Last modified', 'ACLs', 'Labels', 'Type', 'Max time travel (Hours)'], [[dmy(D.created), pol.bindings.map((b) => `${b.role.replace('roles/bigquery.data', '').replace('roles/', '')}:\n${b.members.map((m) => '  ' + m.replace(/^\w+:/, '')).join('\n')}`).join('\n') || 'Owners:\n  projectOwners', '', 'DEFAULT', '168']]));
      return;
    }
    const t = needTable(c, r, 'bigquery.tables.get');
    if (c.a.schema) { const s = t.schema.map((f) => Object.assign({}, f)); c.out((fmt === 'prettyjson' ? JSON.stringify(s, null, 2) : JSON.stringify(s)) + '\n'); return; }
    const bytes = tableBytes(t);
    if (fmt === 'json' || fmt === 'prettyjson') { const o = { creationTime: String(G.T0 + t.created), id: `${dsKey(r)}.${r.table}`, kind: 'bigquery#table', lastModifiedTime: String(G.T0 + t.modified), location: needDs(c, r).location, numBytes: String(bytes), numRows: String(t.rows.length), schema: { fields: t.schema }, tableReference: { datasetId: r.ds, projectId: r.project, tableId: r.table }, timePartitioning: t.part ? { field: t.part.field, type: t.part.type } : undefined, clustering: t.cluster ? { fields: t.cluster } : undefined, type: t.type, view: t.type === 'VIEW' ? { query: t.view, useLegacySql: false } : undefined }; c.out((fmt === 'json' ? JSON.stringify(o) : JSON.stringify(o, null, 2)) + '\n'); return; }
    if (t.type === 'VIEW') { c.out(`View ${dsKey(r)}.${r.table}\n\n` + bqTable(['Last modified', 'Schema', 'Type', 'Labels', 'Use Legacy SQL'], [[dmy(t.modified), prettySchema(t.schema).join('\n'), 'VIEW', '', 'False']])); return; }
    c.out(`Table ${dsKey(r)}.${r.table}\n\n` + bqTable(['Last modified', 'Schema', 'Total Rows', 'Total Bytes', 'Expiration', 'Time Partitioning', 'Clustered Fields', 'Total Logical Bytes', 'Labels'], [[dmy(t.modified), prettySchema(t.schema).join('\n'), String(t.rows.length), String(bytes), t.expire ? dmy(t.expire) : '', t.part ? `${t.part.type} (field: ${t.part.field})` : '', (t.cluster || []).join(', '), String(bytes), '']]));
  } });
  bqc('head', { flags: { n: 'v', max_rows: 'v', s: 'v', start_row: 'v', selected_fields: 'v', c: 'v' }, short: { n: 'max_rows', s: 'start_row', c: 'selected_fields' }, run: async (c) => {
    const r = parseRef(c, c.p[0] || '');
    const t = needTable(c, r, 'bigquery.tables.getData');
    if (t.type === 'VIEW') throw new G.Err(400, 'BQ', `Cannot list a table of type VIEW.`);
    const n = Number(c.a.max_rows || 100), s0 = Number(c.a.start_row || 0);
    const sel = c.a.selected_fields ? c.a.selected_fields.split(',') : null;
    const schema = sel ? t.schema.filter((f) => sel.includes(f.name)) : t.schema;
    c.out(render({ schema, rows: t.rows.slice(s0, s0 + n) }, c.a.format));
  } });
  bqc('query', { flags: { use_legacy_sql: 'b', dry_run: 'b', max_rows: 'v', n: 'v', destination_table: 'v', replace: 'b', append_table: 'b', use_cache: 'b', maximum_bytes_billed: 'v', parameter: 'v*', nouse_cache: 'b', batch: 'b' }, short: { n: 'max_rows' }, errPrefix: () => '', run: async (c) => {
    let sql = c.p.join(' ');
    if (!sql.trim()) sql = c.stdin || '';
    if (!sql.trim()) throw new G.Err(0, 'USAGE', 'Must provide a query string.');
    if (c.a.use_legacy_sql !== false) {
      // レガシー SQL（bq の既定）。[project:dataset.table] の形だけを GoogleSQL に読み替えて通す
      if (/`|\bQUALIFY\b|\bEXCEPT\s*\(|\bSAFE_DIVIDE\b|\bCOUNTIF\b|\bUNNEST\b|\bWITH\b/i.test(sql) || /\bFROM\s+[\w-]+\.\w+/i.test(sql)) {
        const bad = (sql.match(/`([^`]+)`/) || sql.match(/\bFROM\s+([\w.-]+)/i) || [, ''])[1];
        throw new G.Err(400, 'BQ', `Error in query string: Error processing job '${c.project}:${jobId(c.w)}': ${/`|FROM\s+[\w-]+\./i.test(sql) ? `Invalid table name: ${/`/.test(sql) ? '`' + bad + '`' : bad}` : 'Encountered " "QUALIFY" "QUALIFY "" at line 1'}\n[Try using standard SQL (https://cloud.google.com/bigquery/docs/reference/standard-sql/enabling-standard-sql)].`);
      }
      sql = sql.replace(/\[([\w-]+):(\w+)\.(\w+)\]/g, '`$1.$2.$3`').replace(/\[(\w+)\.(\w+)\]/g, '$1.$2');
    }
    if (c.a.parameter) {
      for (const p of c.a.parameter) { const [name, type, ...v] = p.split(':'); const val = v.join(':'); sql = sql.replace(new RegExp('@' + name + '\\b', 'g'), /INT|FLOAT|NUMERIC/i.test(type) ? val : `'${val.replace(/'/g, "\\'")}'`); }
    }
    const ctx = { w: c.w, who: c.who, project: c.project };
    let res;
    try { res = await runQuery(ctx, sql, { dry: c.a.dry_run, useCache: c.a.use_cache !== false && !c.a.nouse_cache, maxBilled: c.a.maximum_bytes_billed !== undefined ? Number(c.a.maximum_bytes_billed) : undefined, location: c.a.location }); }
    catch (e) {
      if (!(e instanceof G.Err)) throw e;
      const j = B(c.w).jobs[B(c.w).jobs.length - 1];
      if (/^Error in query string/.test(e.message)) throw e;
      if (e.code === 403 || e.code === 404) throw new G.Err(e.code, 'BQ', `BigQuery error in query operation: Error processing job '${c.project}:${j ? j.id : jobId(c.w)}': ${e.message}`);
      throw new G.Err(400, 'BQ', `Error in query string: Error processing job '${c.project}:${j ? j.id : jobId(c.w)}': ${e.message}`);
    }
    if (c.a.dry_run) { c.out(`Query successfully validated. Assuming the tables are not modified, running this query will process ${res.bytes} bytes of data.\n`); return; }
    waitLine(c, res.job);
    const n = Number(c.a.max_rows || 100);
    for (const r of res.results) {
      if (r.dml) { c.out(`Number of affected rows: ${r.n}\n\n`); continue; }
      if (r.ddl) { if (r.ddl === 'SKIP') continue; const [p2, rest] = (r.table || ':').split(':'); c.out(r.ddl === 'CREATE_VIEW' ? `Created ${p2}.${rest}\n\n` : r.ddl.startsWith('DROP') ? `Dropped ${p2}.${rest}\n\n` : r.ddl === 'CREATE_OR_REPLACE_TABLE' ? `Replaced ${p2}.${rest}\n\n` : `Created ${p2}.${rest}\n\n`); continue; }
      if (c.a.destination_table) {
        const dr = parseRef(c, c.a.destination_table);
        const D = needDs(c, dr, 'bigquery.tables.create');
        if (D.tables[dr.table] && !c.a.replace && !c.a.append_table) throw new G.Err(409, 'BQ', `Already Exists: Table ${dsKey(dr)}.${dr.table}`);
        const prev = D.tables[dr.table];
        D.tables[dr.table] = { type: 'TABLE', schema: r.schema, rows: (c.a.append_table && prev ? prev.rows : []).concat(r.rows), created: prev ? prev.created : c.w.t, modified: c.w.t, tok: newTok(), part: prev ? prev.part : null, cluster: prev ? prev.cluster : null };
        continue;
      }
      c.out(render({ schema: r.schema, rows: r.rows.slice(0, n) }, c.a.format));
    }
  } });
  // CSV / JSON を読み込む
  function parseCsv(text, skip) {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; continue; }
      if (ch === '"') { q = true; continue; }
      if (ch === ',') { row.push(cur); cur = ''; continue; }
      if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; continue; }
      cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.slice(skip || 0);
  }
  const autoType = (vals) => {
    const v = vals.filter((x) => x !== '');
    if (!v.length) return 'STRING';
    if (v.every((x) => /^-?\d+$/.test(x))) return 'INTEGER';
    if (v.every((x) => /^-?\d*\.?\d+([eE][-+]?\d+)?$/.test(x))) return 'FLOAT';
    if (v.every((x) => /^(true|false)$/i.test(x))) return 'BOOLEAN';
    if (v.every((x) => /^\d{4}-\d\d-\d\d$/.test(x))) return 'DATE';
    if (v.every((x) => /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?( ?UTC|Z|[+-]\d\d:\d\d)?$/.test(x))) return 'TIMESTAMP';
    return 'STRING';
  };
  const conv = (f, s) => {
    if (s === '' || s === undefined || s === null) return null;
    switch (f.type) {
      case 'INTEGER': if (!/^-?\d+$/.test(s)) throw new Error(`Could not parse '${s}' as INT64 for field ${f.name}`); return Number(s);
      case 'FLOAT': case 'NUMERIC': if (isNaN(Number(s))) throw new Error(`Could not parse '${s}' as DOUBLE for field ${f.name}`); return Number(s);
      case 'BOOLEAN': return /^true$/i.test(s);
      case 'DATE': if (!/^\d{4}-\d\d-\d\d$/.test(s)) throw new Error(`Could not parse '${s}' as DATE for field ${f.name}`); return s;
      default: return s;
    }
  };
  bqc('load', { flags: { source_format: 'v', skip_leading_rows: 'v', autodetect: 'b', replace: 'b', time_partitioning_field: 'v', time_partitioning_type: 'v', clustering_fields: 'v', schema: 'v', max_bad_records: 'v', field_delimiter: 'v', noreplace: 'b' }, run: async (c) => {
    const [target, src, schemaArg] = c.p;
    if (!target || !src) throw new G.Err(0, 'USAGE', 'Must specify destination and source for load.');
    const r = parseRef(c, target);
    const D = needDs(c, r, 'bigquery.tables.create');
    G.KNOWN.add('bigquery.jobs.create');
    if (!G.check(c.w, c.who, 'bigquery.jobs.create', 'projects/' + c.project).ok) throw new G.Err(403, 'BQ', `Access Denied: Project ${c.project}: User does not have bigquery.jobs.create permission in project ${c.project}.`);
    let text;
    if (/^gs:\/\//.test(src)) {
      const m = src.match(/^gs:\/\/([^/]+)\/(.*)$/);
      const b = G.gcsBucket(c.w, m[1]);
      if (!b) throw new G.Err(404, 'BQ', `Not found: URI ${src}`);
      if (!G.check(c.w, c.who, 'storage.objects.get', `projects/${b.project}/buckets/${m[1]}`).ok) throw new G.Err(403, 'BQ', `Access Denied: File ${src}: Access Denied`);
      const names = m[2].includes('*') ? Object.keys(b.objects).filter((n) => new RegExp('^' + m[2].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(n)) : [m[2]];
      text = names.map((n) => G.gcsGet(c.w, m[1], n)).filter((x) => x !== null).join('');
      if (!names.some((n) => G.gcsGet(c.w, m[1], n) !== null)) throw new G.Err(404, 'BQ', `Not found: URI ${src}`);
    } else {
      text = G.fs.read(c.sys, src);
      if (text === null) throw new G.Err(0, 'USAGE', `Invalid path: ${src}`);
      c.err('Upload complete.\n');
    }
    const fmt = (c.a.source_format || 'CSV').toUpperCase();
    const job = { id: jobId(c.w), project: c.project, user: c.who, created: c.w.t, type: 'LOAD', state: 'DONE', bytes: 0, billed: 0, location: D.location, query: null, statementType: null, cache: false };
    B(c.w).jobs.push(job);
    let rows, schema = parseSchema(c, c.a.schema || schemaArg);
    const prev = D.tables[r.table];
    try {
      if (fmt === 'CSV') {
        const recs = parseCsv(text, Number(c.a.skip_leading_rows || 0));
        if (!schema && prev && !c.a.replace) schema = prev.schema;
        if (!schema) {
          if (!c.a.autodetect) throw new Error('No schema specified on job or table.');
          const all = parseCsv(text, 0);
          const headerish = Number(c.a.skip_leading_rows || 0) > 0 || (all.length > 1 && all[0].every((x) => !/^-?[\d.]+$/.test(x)) && all.slice(1).some((r2) => r2.some((x) => /^-?[\d.]+$/.test(x))));
          const head = headerish ? all[0] : all[0].map((_, j) => `string_field_${j}`);
          const body = headerish ? all.slice(1) : all;
          schema = head.map((h, j) => ({ name: h.trim().replace(/[^\w]/g, '_'), type: autoType(body.map((x) => x[j] || '')), mode: 'NULLABLE' }));
          rows = body.map((x) => Object.fromEntries(schema.map((f, j) => [f.name, conv(f, x[j])])));
        } else rows = recs.map((x, k) => { if (x.length !== schema.length) throw new Error(`Error while reading data, error message: CSV processing encountered too many errors, giving up. Rows: ${k + 1}; errors: 1; max bad records: 0; error: Error detected while parsing row starting at position: 0. Error: Too ${x.length > schema.length ? 'many' : 'few'} columns.`); return Object.fromEntries(schema.map((f, j) => [f.name, conv(f, x[j])])); });
      } else if (fmt === 'NEWLINE_DELIMITED_JSON') {
        const recs = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
        if (!schema && prev && !c.a.replace) schema = prev.schema;
        if (!schema) { if (!c.a.autodetect) throw new Error('No schema specified on job or table.'); const keys = [...new Set(recs.flatMap((o) => Object.keys(o)))]; schema = keys.map((k) => { const vs = recs.map((o) => o[k]).filter((v) => v !== undefined && v !== null); const v = vs[0]; return { name: k, type: Array.isArray(v) ? (typeof v[0] === 'number' ? 'INTEGER' : 'STRING') : typeof v === 'number' ? (vs.every(Number.isInteger) ? 'INTEGER' : 'FLOAT') : typeof v === 'boolean' ? 'BOOLEAN' : typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) ? 'DATE' : 'STRING', mode: Array.isArray(v) ? 'REPEATED' : 'NULLABLE' }; }); }
        rows = recs.map((o) => Object.fromEntries(schema.map((f) => [f.name, o[f.name] === undefined ? null : o[f.name]])));
      } else throw new Error(`このサイトの bq load は CSV と NEWLINE_DELIMITED_JSON だけを読み込めます：${fmt}`);
    } catch (e) {
      waitLine(c, job);
      throw new G.Err(400, 'BQ', `Error processing job '${c.project}:${job.id}': ${e.message}`);
    }
    if (prev && !c.a.replace && JSON.stringify(prev.schema.map((f) => f.name)) !== JSON.stringify(schema.map((f) => f.name))) { waitLine(c, job); throw new G.Err(400, 'BQ', `Error processing job '${c.project}:${job.id}': Provided Schema does not match Table ${dsKey(r)}.${r.table}. Cannot add fields (field: ${schema.map((f) => f.name).find((n) => !prev.schema.some((f) => f.name === n))})`); }
    D.tables[r.table] = { type: 'TABLE', expire: prev ? prev.expire : D.defaultExpire ? c.w.t + D.defaultExpire : null, schema, rows: (prev && !c.a.replace ? prev.rows : []).concat(rows), created: prev ? prev.created : c.w.t, modified: c.w.t, tok: newTok(), part: prev && !c.a.replace ? prev.part : c.a.time_partitioning_field ? { field: c.a.time_partitioning_field, type: (c.a.time_partitioning_type || 'DAY').toUpperCase() } : null, cluster: prev && !c.a.replace ? prev.cluster : c.a.clustering_fields ? c.a.clustering_fields.split(',') : null };
    G.advance(c.w, 3000);
    waitLine(c, job, 1);
  } });
  bqc('cp', { flags: { f: 'b', force: 'b', a: 'b', append_table: 'b', n: 'b', no_clobber: 'b' }, short: { f: 'force', a: 'append_table', n: 'no_clobber' }, run: async (c) => {
    const [s, d] = c.p.map((x) => parseRef(c, x));
    const t = needTable(c, s, 'bigquery.tables.getData');
    const D = needDs(c, d, 'bigquery.tables.create');
    if (D.tables[d.table] && !c.a.force && !c.a.append_table) { const ans = (c.stdin || '').trim().toLowerCase(); c.out(`cp: replace ${dsKey(d)}.${d.table}? (y/N) `); if (ans !== 'y') { c.out('\n'); return; } c.out('\n'); }
    const job = { id: jobId(c.w), project: c.project, user: c.who, created: c.w.t, type: 'COPY', state: 'DONE', bytes: 0, billed: 0, location: D.location };
    B(c.w).jobs.push(job);
    D.tables[d.table] = Object.assign(G.clone(t), { rows: (c.a.append_table && D.tables[d.table] ? D.tables[d.table].rows : []).concat(G.clone(t.rows)), created: c.w.t, modified: c.w.t, tok: newTok() });
    waitLine(c, job);
    c.out(`Table '${dsKey(s)}.${s.table}' successfully copied to '${dsKey(d)}.${d.table}'\n`);
  } });
  bqc('extract', { flags: { destination_format: 'v', print_header: 'b', compression: 'v' }, run: async (c) => {
    const r = parseRef(c, c.p[0]);
    const t = needTable(c, r, 'bigquery.tables.export');
    const m = (c.p[1] || '').match(/^gs:\/\/([^/]+)\/(.*)$/);
    if (!m || !G.gcsBucket(c.w, m[1])) throw new G.Err(404, 'BQ', `Not found: Bucket ${m ? m[1] : c.p[1]}`);
    const fmt = (c.a.destination_format || 'CSV').toUpperCase();
    const body = fmt === 'NEWLINE_DELIMITED_JSON' ? t.rows.map((x) => JSON.stringify(Object.fromEntries(t.schema.map((f) => [f.name, strVal(f, x[f.name])])))).join('\n') + '\n' : render({ schema: t.schema, rows: t.rows }, 'csv').split('\n').slice(c.a.print_header === false ? 1 : 0).join('\n');
    G.gcsPut(c.w, m[1], m[2].replace('*', '000000000000'), body, { ctype: fmt === 'CSV' ? 'text/csv' : 'application/json' });
    const job = { id: jobId(c.w), project: c.project, user: c.who, created: c.w.t, type: 'EXTRACT', state: 'DONE', bytes: 0, billed: 0, location: needDs(c, r).location };
    B(c.w).jobs.push(job);
    waitLine(c, job);
  } });
  bqc('update', { flags: { description: 'v', default_table_expiration: 'v', expiration: 'v', set_label: 'v*', d: 'b', dataset: 'b', t: 'b', table: 'b' }, short: { d: 'dataset', t: 'table' }, run: async (c) => {
    const r = parseRef(c, c.p[0]);
    if (!r.table || c.a.dataset) {
      const D = needDs(c, r, 'bigquery.datasets.update');
      if (c.a.description !== undefined) D.desc = c.a.description;
      if (c.a.default_table_expiration !== undefined) D.defaultExpire = Number(c.a.default_table_expiration) ? Number(c.a.default_table_expiration) * 1000 : null;
      c.out(`Dataset '${dsKey(r)}' successfully updated.\n`);
      return;
    }
    const t = needTable(c, r, 'bigquery.tables.update');
    if (c.a.expiration !== undefined) t.expire = Number(c.a.expiration) ? c.w.t + Number(c.a.expiration) * 1000 : null;
    if (c.a.description !== undefined) t.desc = c.a.description;
    c.out(`Table '${dsKey(r)}.${r.table}' successfully updated.\n`);
  } });
  // データセットの IAM（bq add-iam-policy-binding）
  bqc('add-iam-policy-binding', { flags: { member: 'v', role: 'v' }, run: async (c) => {
    const r = parseRef(c, c.p[0]);
    const res = r.table ? `projects/${r.project}/datasets/${r.ds}/tables/${r.table}` : `projects/${r.project}/datasets/${r.ds}`;
    if (r.table) needTable(c, r, 'bigquery.tables.setIamPolicy'); else needDs(c, r, 'bigquery.datasets.update');
    const gc = { w: c.w };
    const pol = G.addBinding(gc, res, 'dataset', dsKey(r), c.a.member, c.a.role, null);
    if (c.a.format !== 'none') c.out(JSON.stringify(G.policyView(pol), null, 2) + '\n');
  } });
  bqc('remove-iam-policy-binding', { flags: { member: 'v', role: 'v' }, run: async (c) => {
    const r = parseRef(c, c.p[0]);
    const res = r.table ? `projects/${r.project}/datasets/${r.ds}/tables/${r.table}` : `projects/${r.project}/datasets/${r.ds}`;
    needDs(c, r, 'bigquery.datasets.update');
    const pol = c.w.policies[res];
    if (pol) { for (const b of pol.bindings) if (b.role === c.a.role) b.members = b.members.filter((m) => m !== c.a.member); pol.bindings = pol.bindings.filter((b) => b.members.length); }
    c.out(JSON.stringify(G.policyView(pol || { bindings: [], etag: 'ACAB', version: 1 }), null, 2) + '\n');
  } });
  bqc('get-iam-policy', { flags: {}, run: async (c) => {
    const r = parseRef(c, c.p[0]);
    const res = r.table ? `projects/${r.project}/datasets/${r.ds}/tables/${r.table}` : `projects/${r.project}/datasets/${r.ds}`;
    needDs(c, r, 'bigquery.datasets.get');
    c.out(JSON.stringify(G.policyView(c.w.policies[res] || { bindings: [], etag: 'ACAB', version: 1 }), null, 2) + '\n');
  } });

  // ---------------------------------------------------------------- 練習用の公開データセット（tsubame-public.bungu）
  // つばめ文具が「公開」している、架空の販売データ（BigQuery の公開データセットにあたるもの）
  (G.ON_BOOT = G.ON_BOOT || []).push((w) => {
    const pid = 'tsubame-public';
    const p = G.makeProject(w, pid, { name: 'つばめ文具 公開データ', creator: 'admin@tsubame.example', defaultSa: false });
    p.createTime = '2024-06-01T00:00:00.000Z';
    p.billing = G.BILLING_ID;
    p.services.push('bigquery.googleapis.com');
    // 誰でも読める（allAuthenticatedUsers に dataViewer）
    const mk = (ds, desc) => { B(w).ds[`${pid}:${ds}`] = { location: 'asia-northeast1', created: -86400000 * 30, desc, labels: {}, tables: {}, defaultExpire: null }; w.policies[`projects/${pid}/datasets/${ds}`] = { version: 1, etag: 'BwYpub' + ds, bindings: [{ role: 'roles/bigquery.dataViewer', members: ['allAuthenticatedUsers'] }] }; return B(w).ds[`${pid}:${ds}`]; };
    const D = mk('bungu', 'つばめ文具の販売データ（架空）。2026 年 1 月〜10 月の注文');
    let seed = 20260101;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const cats = [['ノート', [['つばめノート A5', 280], ['つばめノート B5', 320], ['方眼ノート A4', 450], ['リングノート', 380]]], ['ペン', [['ボールペン 黒', 120], ['ボールペン 赤', 120], ['ゲルペン 0.5', 180], ['万年筆 青', 3200], ['万年筆 黒', 3200]]], ['紙', [['便箋 罫線', 350], ['封筒 長形3号', 220], ['画用紙 20 枚', 400]]], ['小物', [['クリップ 50 個', 150], ['付箋 青', 200], ['付箋 黄', 200], ['消しゴム', 100], ['定規 15cm', 160]]]];
    const products = [];
    for (const [cat, items] of cats) for (const [name, price] of items) products.push({ product_id: products.length + 1, name, category: cat, price });
    const prefs = ['東京都', '神奈川県', '大阪府', '愛知県', '福岡県', '北海道', '宮城県', '京都府'];
    const family = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤'];
    const given = ['陽', '葵', '蓮', '結衣', '湊', '凛', '樹', '咲', '大和', '芽依'];
    const customers = [];
    for (let k = 1; k <= 60; k++) { const m = 1 + Math.floor(rnd() * 12); customers.push({ customer_id: k, name: family[Math.floor(rnd() * 10)] + ' ' + given[Math.floor(rnd() * 10)], prefecture: prefs[Math.floor(rnd() * rnd() * 8)], joined_on: `${2024 + Math.floor(rnd() * 2)}-${String(m).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}` }); }
    const orders = [];
    const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31];
    let oid = 100000;
    for (let mo = 0; mo < 10; mo++) for (let d = 1; d <= days[mo]; d++) {
      const n = 4 + Math.floor(rnd() * 6) + (mo === 2 || mo === 3 ? 3 : 0);
      for (let k = 0; k < n; k++) {
        const pr = products[Math.floor(rnd() * rnd() * products.length)];
        orders.push({ order_id: ++oid, order_date: `2026-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, customer_id: 1 + Math.floor(rnd() * 60), product_id: pr.product_id, quantity: 1 + Math.floor(rnd() * rnd() * 6), unit_price: pr.price, channel: rnd() < 0.68 ? 'web' : 'store' });
      }
    }
    const S = (n, t) => ({ name: n, type: t, mode: 'NULLABLE' });
    D.tables.products = { type: 'TABLE', schema: [S('product_id', 'INTEGER'), S('name', 'STRING'), S('category', 'STRING'), S('price', 'INTEGER')], rows: products, created: -86400000 * 30, modified: -86400000 * 30, tok: 'pub-products', part: null, cluster: null };
    D.tables.customers = { type: 'TABLE', schema: [S('customer_id', 'INTEGER'), S('name', 'STRING'), S('prefecture', 'STRING'), S('joined_on', 'DATE')], rows: customers, created: -86400000 * 30, modified: -86400000 * 30, tok: 'pub-customers', part: null, cluster: null };
    D.tables.orders = { type: 'TABLE', schema: [S('order_id', 'INTEGER'), S('order_date', 'DATE'), S('customer_id', 'INTEGER'), S('product_id', 'INTEGER'), S('quantity', 'INTEGER'), S('unit_price', 'INTEGER'), S('channel', 'STRING')], rows: orders, created: -86400000 * 30, modified: -86400000 * 30, tok: 'pub-orders', part: { field: 'order_date', type: 'DAY' }, cluster: ['channel'] };
  });

  // ---------------------------------------------------------------- Node の SDK（@google-cloud/bigquery）
  G.NODE_MODULES['@google-cloud/bigquery'] = (env) => {
    const w = env.w;
    const err = (msg, code) => { const e = new Error(msg); e.code = code || 400; e.errors = [{ message: msg, reason: code === 403 ? 'accessDenied' : code === 404 ? 'notFound' : 'invalidQuery' }]; return e; };
    class Table {
      constructor(ds, id) { this.dataset = ds; this.id = id; }
      async insert(rows) {
        const key = `${this.dataset.bq.projectId}:${this.dataset.id}`;
        const D = B(w).ds[key];
        const t = D && D.tables[this.id];
        if (!t) throw err(`Not found: Table ${key}.${this.id}`, 404);
        G.KNOWN.add('bigquery.tables.updateData');
        if (!G.check(w, env.who, 'bigquery.tables.updateData', `projects/${this.dataset.bq.projectId}/datasets/${this.dataset.id}/tables/${this.id}`).ok) throw err(`Access Denied: Table ${key}.${this.id}: Permission bigquery.tables.updateData denied on table ${key}.${this.id} (or it may not exist).`, 403);
        const list = Array.isArray(rows) ? rows : [rows];
        const bad = list.map((r, k) => ({ k, r, extra: Object.keys(r).filter((n) => !t.schema.some((f) => f.name === n)) })).filter((x) => x.extra.length);
        if (bad.length) { const e = new Error('A failure occurred during this request.'); e.name = 'PartialFailureError'; e.errors = bad.map((x) => ({ row: x.r, errors: [{ message: `no such field: ${x.extra[0]}.`, reason: 'invalid' }] })); throw e; }
        for (const r of list) t.rows.push(Object.fromEntries(t.schema.map((f) => [f.name, r[f.name] === undefined ? null : r[f.name] instanceof Date ? r[f.name].toISOString() : r[f.name]])));
        t.modified = w.t; t.tok = newTok();
        return [{ kind: 'bigquery#tableDataInsertAllResponse' }];
      }
      async exists() { const D = B(w).ds[`${this.dataset.bq.projectId}:${this.dataset.id}`]; return [!!(D && D.tables[this.id])]; }
    }
    class Dataset {
      constructor(bq, id) { this.bq = bq; this.id = id; }
      table(id) { return new Table(this, id); }
      async exists() { return [!!B(w).ds[`${this.bq.projectId}:${this.id}`]]; }
    }
    class BigQuery {
      constructor(o = {}) { this.projectId = o.projectId || env.project; }
      dataset(id) { return new Dataset(this, id); }
      async query(o) {
        const sql = typeof o === 'string' ? o : o.query;
        let q = sql;
        if (o && o.params) for (const [k, v] of Object.entries(o.params)) q = q.replace(new RegExp('@' + k + '\\b', 'g'), typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "\\'")}'`);
        let res;
        try { res = await runQuery({ w, who: env.who, project: this.projectId }, q, {}); }
        catch (e) { if (e instanceof G.Err) throw err(e.message, e.code); throw e; }
        const last = res.results[res.results.length - 1] || { rows: [], schema: [] };
        const rows = (last.rows || []).map((r) => Object.fromEntries((last.schema || []).map((f) => [f.name, f.type === 'DATE' && r[f.name] !== null ? { value: r[f.name] } : r[f.name]])));
        return [rows];
      }
    }
    return { BigQuery };
  };
})(typeof window !== 'undefined' ? window : globalThis);
