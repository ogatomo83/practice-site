// SQL トークナイザ / ハイライタ / 文の分割。
// ブラウザ（window.SQLHL）とビルド（globalThis.SQLHL）の両方から使う。
(function (root) {
  const KW = new Set(`
    abort absolute access action add admin after aggregate all also alter always analyze and any array as asc assertion
    assignment asymmetric at attach attribute authorization backward before begin between bigint binary bit both breadth by
    cache call called cascade cascaded case cast catalog chain characteristics check checkpoint class close cluster
    coalesce collate collation column columns comment comments commit committed concurrently configuration conflict
    connection constraint constraints content continue conversion copy cost create cross csv cube current current_catalog
    current_date current_role current_schema current_time current_timestamp current_user cursor cycle data database day
    deallocate declare default defaults deferrable deferred definer delete delimiter delimiters depth desc detach
    dictionary disable discard distinct do document domain drop each else enable encoding encrypted end enum escape event
    except exclude excluding exclusive execute exists explain expression extension external extract false family fetch
    filter finalize first following for force foreign format forward freeze from full function functions generated global
    grant granted greatest group grouping groups handler having header hold hour identity if ilike immediate immutable
    implicit import in include including increment index indexes inherit inherits initially inline inner inout input
    insensitive insert instead intersect into invoker is isnull isolation join key label language large last lateral
    leading leakproof least left level like limit listen load local localtime localtimestamp location lock locked logged
    mapping match matched materialized maxvalue merge method minute minvalue mode month move name names natural new next
    nfc nfd nfkc nfkd no none normalize normalized not nothing notify notnull nowait null nullif nulls object of off offset
    oids old on only operator option options or order ordinality others out outer over overlaps overriding owned owner
    parallel parser partial partition passing password placing plans policy preceding prepare prepared preserve primary
    prior privileges procedural procedure procedures program publication quote range read reassign recheck recursive ref
    references referencing refresh reindex relative release rename repeatable replace replica reset restart restrict
    return returning returns revoke right role rollback rollup routine routines row rows rule savepoint schema schemas
    scroll search second security select sequence sequences serializable server session session_user set setof sets share
    show similar simple skip snapshot some sql stable standalone start statement statistics stdin stdout storage stored
    strict strip subscription substring support symmetric sysid system table tables tablesample tablespace temp template
    temporary then ties to trailing transaction transform treat trigger trim true truncate trusted type types uescape
    unbounded uncommitted unencrypted union unique unknown unlisten unlogged until update user using vacuum valid validate
    validator value values variadic verbose version view views volatile when where whitespace window with within without
    work wrapper write xmlattributes year yes zone raise notice exception loop while elsif perform found foreach exit
    declare plpgsql security_barrier`.trim().split(/\s+/));
  const TYPES = new Set(`
    int int2 int4 int8 integer smallint bigint serial bigserial smallserial numeric decimal real float float4 float8
    double precision money text varchar char character bpchar boolean bool date time timetz timestamp timestamptz
    interval json jsonb uuid bytea inet cidr macaddr xml point line lseg box path polygon circle tsvector tsquery
    regclass oid xid xid8 tid int4range int8range numrange tsrange tstzrange daterange record void trigger anyelement
    name pg_lsn bit varbit`.trim().split(/\s+/));

  // トークン列: [cls, text]。cls は k/t/s/n/c/f/p（記号）/'' 。
  function tokenize(src) {
    const out = [];
    let i = 0;
    const n = src.length;
    const push = (cls, t) => out.push([cls, t]);
    while (i < n) {
      const ch = src[i];
      const rest = src.slice(i);
      let m;
      if (ch === '-' && src[i + 1] === '-') {
        const e = src.indexOf('\n', i);
        const j = e < 0 ? n : e;
        push('c', src.slice(i, j)); i = j; continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2);
        const j = e < 0 ? n : e + 2;
        push('c', src.slice(i, j)); i = j; continue;
      }
      if ((m = rest.match(/^\$([A-Za-z_]\w*)?\$/))) {
        const tag = m[0];
        const e = src.indexOf(tag, i + tag.length);
        const j = e < 0 ? n : e + tag.length;
        // 関数本体は中身もハイライトする
        out.push(['s', tag]);
        const body = src.slice(i + tag.length, e < 0 ? n : e);
        tokenize(body).forEach((t) => out.push([t[0], t[1], true]));
        if (e >= 0) out.push(['s', tag]);
        i = j; continue;
      }
      if (ch === "'" || ((ch === 'E' || ch === 'e' || ch === 'B' || ch === 'b' || ch === 'X' || ch === 'x' || ch === 'U' || ch === 'u') && src[i + 1] === "'")) {
        let j = ch === "'" ? i + 1 : i + 2;
        const esc = ch === 'E' || ch === 'e';
        while (j < n) {
          if (esc && src[j] === '\\') { j += 2; continue; }
          if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue; } j++; break; }
          j++;
        }
        push('s', src.slice(i, j)); i = j; continue;
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < n) { if (src[j] === '"') { if (src[j + 1] === '"') { j += 2; continue; } j++; break; } j++; }
        push('', src.slice(i, j)); i = j; continue;
      }
      if ((m = rest.match(/^\d+(\.\d+)?([eE][+-]?\d+)?/)) || (m = rest.match(/^\.\d+/))) {
        const prev = out.length ? out[out.length - 1][1] : '';
        if (!/[A-Za-z_]$/.test(prev)) { push('n', m[0]); i += m[0].length; continue; }
      }
      if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_$]*/))) {
        const w = m[0], lw = w.toLowerCase();
        let j = i + w.length;
        while (src[j] === ' ') j++;
        const call = src[j] === '(';
        const prevSig = (() => { for (let k = out.length - 1; k >= 0; k--) if (out[k][1].trim()) return out[k][1]; return ''; })();
        let cls = '';
        if (prevSig === '::') cls = 't';
        else if (TYPES.has(lw) && !call) cls = 't';
        else if (KW.has(lw) && !(call && !/^(in|exists|values|any|all|some|not|and|or|on|using|over|filter|within|as|row|array|returns|table|from|into|join|where|select|cast|coalesce|nullif|greatest|least|extract|substring|trim|position|overlay|normalize|treat|grouping|insert|update|delete|key|primary|unique|check|references|foreign|default|lateral|values|exclude|include|partition|with)$/.test(lw))) cls = 'k';
        else if (KW.has(lw)) cls = 'k';
        else if (call) cls = 'f';
        push(cls, w); i += w.length; continue;
      }
      if ((m = rest.match(/^(::|->>|->|#>>|#>|@>|<@|\?\||\?&|\|\||<>|!=|<=|>=|@@|&&|<->|[-+*/%<>=~!^|&#?@])/))) {
        push('p', m[0]); i += m[0].length; continue;
      }
      push('', ch); i++;
    }
    return out;
  }

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 行ごとの HTML 配列を返す（トークンが行をまたいでも各行で閉じる）
  function highlightLines(src) {
    const toks = tokenize(src);
    const lines = [''];
    toks.forEach(([cls, t]) => {
      const parts = t.split('\n');
      parts.forEach((p, k) => {
        if (k > 0) lines.push('');
        if (!p) return;
        const c = cls === 'p' ? 'o' : cls;
        lines[lines.length - 1] += c ? `<span class="${c}">${esc(p)}</span>` : esc(p);
      });
    });
    return lines;
  }

  // 文の分割（文字列・識別子・ドル引用・コメントの中のセミコロンは無視）
  function split(src) {
    const stmts = [];
    let cur = '';
    let only = true; // コメントと空白だけか
    tokenize(src).forEach(([cls, t, inBody]) => {
      if ((cls === 'p' || cls === '') && !inBody) {
        if (t === ';') {
          if (!only) stmts.push(cur.trim());
          cur = ''; only = true; return;
        }
      }
      cur += t;
      if (cls !== 'c' && t.trim()) only = false;
    });
    if (!only && cur.trim()) stmts.push(cur.trim());
    return stmts;
  }

  root.SQLHL = { tokenize, highlightLines, split, esc };
})(typeof window !== 'undefined' ? window : globalThis);
