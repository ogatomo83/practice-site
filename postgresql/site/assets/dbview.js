// 「DB を見る」パネル（画面の下に出る）。いまのデータベースの中身を、テーブル 1 つずつ表の形で見せる。
// SQL を実行するたびに読み直し、直前の SQL が変えたテーブルを自動で開いて、追加・変更された行に色を付ける。
(() => {
  const panel = document.getElementById('dbv');
  const btn = document.querySelector('.db-view');
  if (!panel || !btn || !window.PG) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const tabsEl = $('.dbv-tabs', panel), sumEl = $('.dbv-sum', panel), body = $('.dbv-b', panel);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  const KIND = { p: '親テーブル', v: 'ビュー', m: 'マテビュー', f: '外部テーブル' };
  const ROWS = 200;        // 表に出す行数の上限
  const DIFF_MAX = 1000;   // これ以下の行数のテーブルは毎回すべて読み、実行前後の行を比べる
  const NUM = new Set([20, 21, 23, 26, 700, 701, 1700, 790, 28, 5069]);
  const OTHER = '__other';
  // 型を変換せずテキストのまま受け取る設定なので、boolean は 't' / 'f' で届く
  const T = (v) => v === true || v === 't';
  const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB` : `${(n / 1048576).toFixed(1)} MB`);

  let view = store.get('zp-dbv-view', 'data');
  let sysCols = store.get('zp-dbv-sys', false);
  let sel = null;          // 選んでいるテーブルの key（schema.table）
  let snap = null;         // 最後に読んだ内容
  let base = null;         // 直前の実行の前の状態 { fp: {key: 指紋}, rows: {key: 行の索引}, names: {key: 表示名} }
  let diff = {};           // key → { isNew, added:Set, changed:Set, deleted:[行], cols }
  let changedKeys = new Set();
  let dropped = [];
  let busy = false, queued = null;

  // ---------------------------------------------------------------- 読み取り
  // ユーザーがトランザクションの途中なら、セーブポイントの中で読み、最後にそこまで巻き戻す。
  // 読み取りの失敗でユーザーのトランザクションを壊さず、読み取りで取ったロックも残らない（第 17 章の pg_locks が変わらない）。
  async function snapshot() {
    const db = await PG.getDb();
    return PG.serial(async () => {
      const inTx = db.isInTransaction();
      const out = { inTx, aborted: false, rels: [], others: {}, user: '' };
      if (inTx) {
        try { await db.exec('savepoint zp_view'); } catch (e) { out.aborted = true; return out; }
      }
      const q = async (sql, opts) => {
        try { return await db.query(sql, [], opts); } catch (e) {
          if (inTx) await db.exec('rollback to savepoint zp_view');
          throw e;
        }
      };
      try { return await read(q, out); } finally {
        if (inTx) await db.exec('rollback to savepoint zp_view; release savepoint zp_view');
      }
    });
  }

  async function read(q, out) {
    const head = await q(`select current_user as u, (select string_agg(extname, ', ' order by extname) from pg_extension where extname <> 'plpgsql') as ext`);
    out.user = head.rows[0].u;
    out.others.ext = head.rows[0].ext ? head.rows[0].ext.split(', ') : [];
    const rels = await q(`
      select c0.oid::int as oid, n.nspname as s, c0.relname as t, c0.relkind as k, c0.relispartition as part, c0.relpersistence as pers,
             pg_relation_size(c0.oid)::int8::text as heap, pg_total_relation_size(c0.oid)::int8::text as total,
             (select string_agg(a.attname, ',' order by k.ord) from pg_constraint c cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
              where c.conrelid = c0.oid and c.contype = 'p') as pk
      from pg_class c0 join pg_namespace n on n.oid = c0.relnamespace
      where c0.relkind in ('r','p','v','m','f')
        and ((n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_(toast|temp)') or n.oid = pg_my_temp_schema())
        and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c0.oid and d.deptype = 'e')
      order by coalesce((select pi.inhparent::regclass::text from pg_inherits pi where pi.inhrelid = c0.oid limit 1), c0.relname::text), c0.relispartition, n.nspname, c0.relname`);
    for (const r of rels.rows) {
      const name = (r.s === 'public' ? '' : r.s.startsWith('pg_temp') ? 'pg_temp.' : r.s + '.') + r.t;
      const rel = { ...r, part: T(r.part), name, key: r.s + '.' + r.t, fq: qi(r.s) + '.' + qi(r.t), rows: null, bytes: +r.total, heap: +r.heap, pk: r.pk ? r.pk.split(',') : [] };
      // 指紋: 行数と、いちばん新しい xmin。UPDATE / INSERT / DELETE のどれでも変わる
      if ('rpm'.includes(rel.k)) {
        try {
          const f = (await q(`select count(*)::int8::text as n, coalesce(max(xmin::text::int8), 0)::text as x from ${rel.fq}`)).rows[0];
          rel.rows = +f.n; rel.fp = `${f.n}/${f.x}/${rel.bytes}`;
        } catch (e) { rel.err = e.message; rel.fp = 'err'; }
      } else rel.fp = rel.k === 'f' ? '' : null;
      out.rels.push(rel);
    }
    out.sel = pickDefault(out.rels);
    for (const rel of out.rels) {
      const want = rel.key === out.sel || ('rpm'.includes(rel.k) && rel.rows !== null && rel.rows <= DIFF_MAX);
      if (!want) continue;
      try { rel.data = await rowsOf(q, rel, rel.key === out.sel ? Math.max(ROWS, DIFF_MAX) : DIFF_MAX); } catch (e) { rel.dataErr = e.message; }
      if (rel.key === out.sel && view === 'struct') {
        try { rel.struct = await structOf(q, rel); } catch (e) { rel.structErr = e.message; }
      }
    }
    const others = await q(`
      select 'seq' as k, c.oid::regclass::text as v from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'S' and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
          and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype in ('a','i','e'))
      union all
      select 'fn', p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_'
          and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
      union all
      select 'trg', t.tgname || ' (' || t.tgrelid::regclass::text || ')' from pg_trigger t where not t.tgisinternal
      union all
      select 'type', t.typname || ' (' || case t.typtype when 'e' then '列挙' when 'd' then 'ドメイン' else '複合' end || ')'
        from pg_type t join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' and (t.typtype in ('e','d') or (t.typtype = 'c' and (select relkind from pg_class where oid = t.typrelid) = 'c'))
          and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e')
      union all
      select 'pol', p.polname || ' (' || p.polrelid::regclass::text || ')' from pg_policy p
      union all
      select 'role', r.rolname from pg_roles r where r.rolname !~ '^pg_' and r.rolname <> 'postgres'
      order by 1, 2`);
    for (const r of others.rows) (out.others[r.k] ||= []).push(r.v);
    return out;
  }

  // 物理的な並び順（ctid 順）で読む。ctid・xmin・xmax は常に読み、表示するかどうかはあとで決める
  async function rowsOf(q, rel, limit) {
    const tries = rel.k === 'v' || rel.k === 'f'
      ? [`select * from ${rel.fq} limit ${limit}`]
      : [`select ctid, xmin, xmax, * from ${rel.fq} order by ${rel.k === 'p' ? 'tableoid, ' : ''}ctid limit ${limit}`, `select * from ${rel.fq} limit ${limit}`];
    let last;
    for (const sql of tries) {
      try {
        const r = await q(sql, { rowMode: 'array' });
        const nsys = sql.includes('ctid, xmin, xmax') ? 3 : 0;
        return { fields: r.fields, rows: r.rows, nsys };
      } catch (e) { last = e; }
    }
    throw last;
  }

  async function structOf(q, rel) {
    const d = {};
    d.cols = (await q(`
      select a.attname as n, format_type(a.atttypid, a.atttypmod) as t, a.attnotnull as nn,
             pg_get_expr(ad.adbin, ad.adrelid) as def, a.attidentity as ident, a.attgenerated as gen,
             a.attstorage as st, a.attlen as len
      from pg_attribute a left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
      where a.attrelid = ${rel.oid} and a.attnum > 0 and not a.attisdropped order by a.attnum`)).rows.map((c) => ({ ...c, nn: T(c.nn), pk: rel.pk.includes(c.n) }));
    d.idx = (await q(`select i.indexrelid::regclass::text as n, pg_get_indexdef(i.indexrelid) as def, pg_relation_size(i.indexrelid)::int8::text as sz
      from pg_index i where i.indrelid = ${rel.oid} order by 1`)).rows;
    d.cons = (await q(`select conname as n, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = ${rel.oid} and contype in ('f','c','u','x') order by contype, conname`)).rows;
    if (rel.k === 'v' || rel.k === 'm') d.viewdef = (await q(`select pg_get_viewdef(${rel.oid}, true) as d`)).rows[0].d;
    return d;
  }

  // ---------------------------------------------------------------- 実行前後の比較
  // 行の索引: 主キーがあれば主キーで、なければ行の中身そのもので行を見分ける
  function indexRows(rel) {
    const d = rel.data;
    if (!d) return null;
    const user = d.fields.slice(d.nsys);
    const pkIdx = rel.pk.map((c) => user.findIndex((f) => f.name === c)).filter((i) => i >= 0);
    const usePk = pkIdx.length && pkIdx.length === rel.pk.length;
    const map = new Map();
    const seen = {};
    d.rows.forEach((row) => {
      const vals = row.slice(d.nsys);
      const sig = JSON.stringify(vals);
      let key = usePk ? JSON.stringify(pkIdx.map((i) => vals[i])) : sig;
      if (!usePk) { seen[sig] = (seen[sig] || 0) + 1; key += '#' + seen[sig]; }
      map.set(key, { sig, row });
    });
    return { cols: user.map((f) => f.name).join(','), complete: rel.rows !== null && d.rows.length >= rel.rows, map };
  }

  function computeDiff(cur) {
    diff = {}; changedKeys = new Set(); dropped = [];
    if (!base) return;
    for (const rel of cur.rels) {
      const was = base.fp[rel.key];
      if (was === undefined) { changedKeys.add(rel.key); diff[rel.key] = { isNew: true }; continue; }
      if (rel.fp === was) continue;
      changedKeys.add(rel.key);
      const now = indexRows(rel), before = base.rows[rel.key];
      if (!now || !before || !now.complete || !before.complete) { diff[rel.key] = { unknown: true }; continue; }
      if (now.cols !== before.cols) { diff[rel.key] = { cols: true }; continue; }
      const added = new Set(), changed = new Set(), deleted = [];
      for (const [k, v] of now.map) {
        const b = before.map.get(k);
        if (!b) added.add(k); else if (b.sig !== v.sig) changed.add(k);
      }
      for (const [k, v] of before.map) if (!now.map.has(k)) deleted.push(v.row);
      diff[rel.key] = { added, changed, deleted, beforeFields: rel.data.fields };
    }
    dropped = Object.keys(base.fp).filter((k) => !cur.rels.some((r) => r.key === k)).map((k) => base.names[k]);
  }

  function makeBase(cur) {
    const b = { fp: {}, rows: {}, names: {} };
    for (const rel of cur.rels) {
      b.fp[rel.key] = rel.fp;
      b.names[rel.key] = rel.name;
      const ix = indexRows(rel);
      if (ix) b.rows[rel.key] = ix;
    }
    return b;
  }

  // ---------------------------------------------------------------- どのテーブルを開くか
  function pickDefault(rels) {
    if (sel === OTHER) return OTHER;
    if (sel && rels.some((r) => r.key === sel)) return sel;
    return rels[0] ? rels[0].key : OTHER;
  }
  // 直前の SQL に出てくる順で、変わったテーブル → 名前が出てくるテーブル の順に選ぶ
  function follow(cur, sql) {
    const text = (sql || '').toLowerCase().replace(/--.*$/gm, ' ');
    const pos = (rel) => {
      const m = new RegExp(`(^|[^a-z0-9_."])${rel.t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_"])`).exec(text);
      return m ? m.index : Infinity;
    };
    const byPos = (xs) => xs.map((r) => [pos(r), r]).sort((a, b) => a[0] - b[0]);
    const changed = cur.rels.filter((r) => changedKeys.has(r.key));
    if (changed.length) return byPos(changed)[0][1].key;
    const mentioned = byPos(cur.rels).filter(([p]) => p !== Infinity);
    if (mentioned.length) return mentioned[0][1].key;
    return null;
  }

  // ---------------------------------------------------------------- 描画
  function cell(v, num) {
    if (v === null || v === undefined) return '<td class="null">NULL</td>';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `<td${num ? ' class="num"' : ''}>${esc(s.length > 120 ? s.slice(0, 120) + '…' : s)}</td>`;
  }

  function gridHTML(rel) {
    const d = rel.data, df = diff[rel.key] || {};
    const from = sysCols ? 0 : d.nsys;
    const fields = d.fields.slice(from);
    const isNum = fields.map((f) => NUM.has(f.dataTypeID));
    const ix = indexRows(rel);
    const keyOf = new Map();
    if (ix) for (const [k, v] of ix.map) keyOf.set(v.row, k);
    const head = `<tr><th class="dbv-mk"></th>${fields.map((f, i) => `<th class="${i < d.nsys - from ? 'is-sys' : ''}${isNum[i] ? ' num' : ''}">${esc(f.name)}${rel.pk.includes(f.name) ? '<span class="dbv-pk">PK</span>' : ''}</th>`).join('')}</tr>`;
    const shown = d.rows.slice(0, ROWS);
    const rowsH = shown.map((row) => {
      const k = keyOf.get(row);
      const cls = df.added && df.added.has(k) ? 'is-add' : df.changed && df.changed.has(k) ? 'is-chg' : '';
      const mark = cls === 'is-add' ? '+' : cls === 'is-chg' ? '~' : '';
      return `<tr class="${cls}"><td class="dbv-mk">${mark}</td>${row.slice(from).map((v, i) => cell(v, isNum[i])).join('')}</tr>`;
    }).join('');
    const del = (df.deleted || []).slice(0, 50).map((row) => `<tr class="is-del"><td class="dbv-mk">−</td>${row.slice(from).map((v, i) => cell(v, isNum[i])).join('')}</tr>`).join('');
    const empty = !d.rows.length && !del ? `<tr><td class="dbv-mk"></td><td colspan="${fields.length}" class="dbv-empty">行はありません</td></tr>` : '';
    return `<div class="dbv-grid"><table><thead>${head}</thead><tbody>${rowsH}${del}${empty}</tbody></table></div>`;
  }

  function structHTML(rel) {
    if (rel.structErr) return `<p class="dbv-err">${esc(rel.structErr)}</p>`;
    const d = rel.struct;
    if (!d) return '<p class="muted">読み込み中…</p>';
    const cols = d.cols.map((c) => {
      const tags = [c.pk ? 'PK' : '', c.nn && !c.pk ? 'NOT NULL' : '', c.ident ? 'IDENTITY' : '', c.gen ? '生成列' : ''].filter(Boolean);
      return `<li><code>${esc(c.n)}</code><span class="dbv-ty">${esc(c.t)}</span>${tags.map((t) => `<span class="dbv-tag">${t}</span>`).join('')}${c.def && !c.ident ? `<span class="dbv-def" title="${esc(c.def)}">default ${esc(c.def)}</span>` : ''}</li>`;
    }).join('');
    const idx = d.idx.length ? d.idx.map((i) => `<li><code>${esc(i.n)}</code><span class="dbv-ty">${fmtBytes(+i.sz)}</span><div class="dbv-defl">${esc(i.def.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, (m, u) => (u ? 'UNIQUE ' : '')))}</div></li>`).join('') : '<li class="muted">なし</li>';
    const cons = d.cons.length ? d.cons.map((c) => `<li><code>${esc(c.n)}</code><div class="dbv-defl">${esc(c.def)}</div></li>`).join('') : '<li class="muted">なし</li>';
    const vd = d.viewdef ? `<section><h4>定義</h4><pre class="dbv-pre">${esc(d.viewdef.trim())}</pre></section>` : '';
    return `<div class="dbv-struct"><section><h4>列</h4><ul class="dbv-cols">${cols}</ul></section>${vd}<section><h4>インデックス</h4><ul class="dbv-list">${idx}</ul></section><section><h4>制約（主キー以外）</h4><ul class="dbv-list">${cons}</ul></section></div>`;
  }

  function othersHTML(o) {
    const group = (label, xs) => `<section><h4>${label}</h4>${xs && xs.length ? `<div class="dbv-chips">${xs.map((x) => `<code>${esc(x)}</code>`).join('')}</div>` : '<p class="muted">なし</p>'}</section>`;
    return `<div class="dbv-struct">${group('独立したシーケンス', o.seq)}${group('関数', o.fn)}${group('トリガ', o.trg)}${group('型', o.type)}${group('行セキュリティのポリシー', o.pol)}${group('ロール', o.role)}${group('拡張機能', o.ext)}</div>`;
  }

  function summaryHTML(rel, s) {
    const who = `<span class="dbv-who">ユーザー ${esc(s.user)}${s.inTx ? ' · <b>トランザクション中</b>' : ''}</span>`;
    if (!rel) return `<span>${dropped.length ? dropDesc() : ''}</span>${who}`;
    const parts = [];
    if (rel.rows !== null) parts.push(`${rel.rows.toLocaleString()} 行`);
    if ('rm'.includes(rel.k)) parts.push(`${rel.heap / 8192} ページ（本体 ${fmtBytes(rel.heap)}、インデックスなどを含めて ${fmtBytes(rel.bytes)}）`);
    if (rel.data && rel.data.rows.length > ROWS && view === 'data') parts.push(`物理的な並び順で先頭 ${ROWS} 行を表示`);
    const df = diff[rel.key];
    let ch = '';
    if (df) {
      if (df.isNew) ch = '直前の実行で作られました';
      else if (df.cols) ch = '直前の実行で列が変わりました';
      else if (df.unknown) ch = '直前の実行で変わりました';
      else {
        const xs = [df.added.size ? `<span class="c-add">追加 ${df.added.size} 行</span>` : '', df.changed.size ? `<span class="c-chg">変更 ${df.changed.size} 行</span>` : '', df.deleted.length ? `<span class="c-del">削除 ${df.deleted.length} 行</span>` : ''].filter(Boolean);
        ch = xs.length ? '直前の実行: ' + xs.join(' ') : '直前の実行で中の位置や版が変わりました（見える行は同じ）';
      }
    }
    return `<span class="dbv-facts">${ch ? `<span class="dbv-chgline">${ch}</span>` : ''}<span>${parts.join(' · ')}</span>${dropped.length ? dropDesc() : ''}</span>${who}`;
  }
  const dropDesc = () => `<span class="dbv-dropped">なくなったもの: ${dropped.map((n) => `<code>${esc(n)}</code>`).join(' ')}</span>`;

  function draw() {
    const s = snap;
    if (!s) return;
    if (s.aborted) {
      tabsEl.innerHTML = '';
      sumEl.innerHTML = '';
      body.innerHTML = `<div class="dbv-warn">トランザクションがエラーで止まっています。<code>rollback;</code> を実行すると元に戻ります。止まっている間は中身を読めません。</div>`;
      return;
    }
    tabsEl.innerHTML = s.rels.map((r) => {
      const meta = r.rows !== null ? r.rows.toLocaleString() : KIND[r.k] || '';
      return `<button type="button" role="tab" data-k="${esc(r.key)}" aria-selected="${r.key === sel}" class="${r.part ? 'is-part' : ''}${changedKeys.has(r.key) ? ' is-chg' : ''}" title="${esc(r.name)}${KIND[r.k] ? '（' + KIND[r.k] + '）' : ''}${r.part ? '（パーティション）' : ''}${r.pers === 't' ? '（一時）' : r.pers === 'u' ? '（UNLOGGED）' : ''}"><span class="dbv-tn">${esc(r.name)}</span><span class="dbv-tc">${esc(meta)}</span></button>`;
    }).join('') + `<button type="button" role="tab" data-k="${OTHER}" aria-selected="${sel === OTHER}" class="dbv-tab-other"><span class="dbv-tn">その他</span></button>`;
    const cur = $('[aria-selected="true"]', tabsEl);
    if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    $$('.dbv-seg button', panel).forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.v === view)); b.disabled = sel === OTHER; });
    $('.dbv-sys', panel).checked = sysCols;
    $('.dbv-opt', panel).hidden = view !== 'data' || sel === OTHER;
    const rel = s.rels.find((r) => r.key === sel);
    sumEl.innerHTML = summaryHTML(sel === OTHER ? null : rel, s);
    if (sel === OTHER) body.innerHTML = othersHTML(s.others);
    else if (!rel) body.innerHTML = '<p class="dbv-pad muted">テーブルはありません</p>';
    else if (view === 'struct') body.innerHTML = structHTML(rel);
    else if (rel.dataErr || rel.err) body.innerHTML = `<p class="dbv-pad dbv-err">${esc(rel.dataErr || rel.err)}</p>`;
    else if (!rel.data) body.innerHTML = '<p class="dbv-pad muted">読み込み中…</p>';
    else body.innerHTML = gridHTML(rel);
  }

  // reason: 'run'（SQL を実行した）/ 'reset' / 'ui'（タブの切り替えなど。比較の基準は動かさない）
  async function refresh(reason = 'ui', sql = '') {
    if (panel.hidden && reason === 'ui') return;
    if (busy) { if (reason !== 'ui' || !queued) queued = { reason, sql }; return; }
    busy = true;
    if (!PG.isBooted() && !snap) body.innerHTML = '<p class="dbv-pad muted">PostgreSQL を起動しています。初回だけ数秒かかります…</p>';
    try {
      if (reason === 'reset') { base = null; diff = {}; changedKeys = new Set(); dropped = []; }
      let s = await snapshot();
      if (!s.aborted) {
        if (reason === 'run') {
          computeDiff(s);
          const f = follow(s, sql);
          if (f && f !== sel) {
            sel = f;
            // 選んだテーブルを読んでいなければ（大きなテーブルなど）、読み直す
            const r = s.rels.find((x) => x.key === sel);
            if (r && (!r.data || (view === 'struct' && !r.struct))) { s = await snapshot(); computeDiff(s); }
          }
          base = makeBase(s);
        } else if (!base) base = makeBase(s);
        if (!(sel === OTHER || s.rels.some((r) => r.key === sel))) sel = s.sel;
      }
      snap = s;
      const keep = body.scrollTop;
      draw();
      if (reason !== 'run') body.scrollTop = keep;
      // UPDATE した行は新しい版として末尾に移るので、変わった最初の行が見えるところまで表を送る
      if (reason === 'run') {
        const row = $('.dbv-grid tr.is-add, .dbv-grid tr.is-chg, .dbv-grid tr.is-del', body);
        const headH = ($('.dbv-grid thead', body) || { offsetHeight: 0 }).offsetHeight;
        body.scrollTop = row ? row.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - headH - 8 : 0;
      }
    } catch (e) {
      body.innerHTML = `<p class="dbv-pad dbv-err">読み込めませんでした: ${esc(e.message || e)}</p>`;
    } finally {
      busy = false;
      if (queued) { const q = queued; queued = null; refresh(q.reason, q.sql); }
    }
  }

  // ---------------------------------------------------------------- 開閉・高さ・操作
  const root = document.documentElement;
  const clampH = (h) => Math.round(Math.max(140, Math.min(window.innerHeight * 0.8, h)));
  let height = store.get('zp-dbv-h', 0);
  const applyH = () => {
    const h = clampH(height || window.innerHeight * (window.innerWidth <= 900 ? 0.45 : 0.36));
    root.style.setProperty('--dbv-h', h + 'px');
    return h;
  };

  function setOpen(on) {
    panel.hidden = !on;
    btn.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('dbv-open', on);
    store.set('zp-dbv-open', on);
    if (on) { applyH(); refresh('ui'); }
  }
  btn.addEventListener('click', () => setOpen(panel.hidden));
  $('.dbv-close', panel).addEventListener('click', () => setOpen(false));
  $('.dbv-refresh', panel).addEventListener('click', () => refresh('ui'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden && panel.contains(document.activeElement)) { setOpen(false); btn.focus(); } });

  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b || b.dataset.k === sel) return;
    sel = b.dataset.k;
    const rel = snap && snap.rels.find((r) => r.key === sel);
    if (sel === OTHER || (rel && rel.data && (view !== 'struct' || rel.struct))) draw();
    else { draw(); refresh('ui'); }
  });
  tabsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const bs = $$('button', tabsEl), i = bs.indexOf(document.activeElement);
    if (i < 0) return;
    const n = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length];
    n.focus(); n.click();
    e.preventDefault();
  });
  $$('.dbv-seg button', panel).forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.v;
    store.set('zp-dbv-view', view);
    draw();
    const rel = snap && snap.rels.find((r) => r.key === sel);
    if (view === 'struct' && rel && !rel.struct) refresh('ui');
  }));
  $('.dbv-sys', panel).addEventListener('change', (e) => {
    sysCols = e.target.checked;
    store.set('zp-dbv-sys', sysCols);
    draw();
  });

  // 上端をドラッグして高さを変える
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
      store.set('zp-dbv-h', height);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    height = clampH(applyH() + (e.key === 'ArrowUp' ? 32 : -32));
    applyH();
    store.set('zp-dbv-h', height);
  });
  window.addEventListener('resize', () => { if (!panel.hidden) applyH(); });

  // 閉じている間は何も読まない。開いたときの状態が、次の実行と比べる基準になる
  window.addEventListener('pg-ran', (e) => { if (!panel.hidden) refresh('run', e.detail && e.detail.sql); else base = null; });
  window.addEventListener('pg-ready', () => { if (!panel.hidden) refresh('ui'); });
  window.addEventListener('pg-reset', () => { if (!panel.hidden) refresh('reset'); else base = null; });

  if (store.get('zp-dbv-open', false)) setOpen(true);
})();
