// gcloud の出力の形：--format（json / yaml / value / table / csv / list / none / flattened）、--filter、--flatten、--sort-by、--limit。
//   GCP.fmt.print(data, formatStr, defaultFmt, opts) → 文字列     data は 1 件（object）か一覧（array）
//   GCP.fmt.filter(list, expr) → 合う物だけ
//   GCP.fmt.flatten(list, keys) → --flatten の展開
(function (root) {
  'use strict';
  const G = root.GCP = root.GCP || {};

  // ---------------------------------------------------------------- キー（a.b[0].c、bindings.members）
  function parseKey(s) {
    const out = [];
    for (const part of s.split('.')) {
      const m = part.match(/^([^[\]]*)((?:\[\d*\])*)$/);
      if (!m) { out.push(part); continue; }
      if (m[1]) out.push(m[1]);
      for (const ix of m[2].match(/\[(\d*)\]/g) || []) out.push(ix === '[]' ? '[]' : Number(ix.slice(1, -1)));
    }
    return out;
  }
  function get(obj, key) {
    let v = obj;
    for (const k of typeof key === 'string' ? parseKey(key) : key) {
      if (v === undefined || v === null) return undefined;
      if (k === '[]') continue;
      if (Array.isArray(v) && typeof k === 'string') { v = v.map((x) => (x == null ? undefined : x[k])).filter((x) => x !== undefined); continue; }
      v = v[k];
    }
    return v;
  }
  G.fmtGet = get;

  // ---------------------------------------------------------------- 値の変換（.basename() など）
  const TRANSFORMS = {
    basename: (v) => (v == null ? v : Array.isArray(v) ? v.map((x) => G.basename(x)) : G.basename(v)),
    len: (v) => (v == null ? 0 : v.length !== undefined ? v.length : Object.keys(v).length),
    yesno: (v, a) => {
      // yesno("*", "") と yesno(yes="…", no="…") の両方の書き方
      let yes = a[0], no = a[1];
      for (const x of a) { const m = String(x).match(/^(yes|no)=["']?(.*?)["']?$/); if (m) { if (m[1] === 'yes') yes = m[2]; else no = m[2]; if (a.length === 1) { if (m[1] === 'no') yes = undefined; else no = undefined; } } }
      if (a.length === 1 && /^no=/.test(a[0])) return v && (!Array.isArray(v) || v.length) ? (typeof v === 'object' ? JSON.stringify(v) : String(v)) : no;
      return v && (!Array.isArray(v) || v.length) ? (yes !== undefined ? yes : 'Yes') : (no !== undefined ? no : 'No');
    },
    date: (v, a) => { if (!v) return v; const d = new Date(v); if (isNaN(d)) return v; const f = a[0] || '%Y-%m-%dT%H:%M:%S'; const p = (n) => String(n).padStart(2, '0'); return f.replace(/%Y/g, d.getUTCFullYear()).replace(/%m/g, p(d.getUTCMonth() + 1)).replace(/%d/g, p(d.getUTCDate())).replace(/%H/g, p(d.getUTCHours())).replace(/%M/g, p(d.getUTCMinutes())).replace(/%S/g, p(d.getUTCSeconds())); },
    join: (v, a) => (Array.isArray(v) ? v.join(a[0] === undefined ? ',' : a[0]) : v),
    list: (v) => (Array.isArray(v) ? v.join(',') : v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}=${x}`).join(',') : v),
    lower: (v) => (v == null ? v : String(v).toLowerCase()),
    upper: (v) => (v == null ? v : String(v).toUpperCase()),
    size: (v) => { const n = Number(v) || 0; if (n < 1024) return n + ' B'; const u = ['KiB', 'MiB', 'GiB', 'TiB']; let x = n, k = -1; while (x >= 1024 && k < 3) { x /= 1024; k++; } return (Math.round(x * 10) / 10) + ' ' + u[k]; },
    'segment': (v, a) => (v == null ? v : String(v).split('/').slice(Number(a[0] || -1))[0]),
    firstof: (v) => v,
    'flatten': (v) => (Array.isArray(v) ? v.join(';') : v),
    'map': (v) => v,
    'scope': (v) => (v == null ? v : G.basename(v)),
    'decode': (v, a) => (a[0] === 'base64' && v ? G.b64dec(v) : v),
  };

  // ---------------------------------------------------------------- 書式の文字列を読む
  // 'table[box,no-heading](name.basename():label=NAME, status)' → { kind, attrs, cols:[{ key, tr:[[name,args]], label, sort }] }
  function parseFormat(s) {
    s = String(s || '').trim();
    const m = s.match(/^([a-z-]+)(\[[^\]]*\])?(?:\(([\s\S]*)\))?(\[[^\]]*\])?\s*$/);
    if (!m) return { kind: s, attrs: {}, cols: null };
    const attrs = {};
    for (const a of [m[2], m[4]]) if (a) for (const x of splitTop(a.slice(1, -1), ',')) { const [k, v] = x.split('='); if (k.trim()) attrs[k.trim()] = v === undefined ? true : v.replace(/^["']|["']$/g, ''); }
    const cols = m[3] !== undefined ? splitTop(m[3], ',').map((c) => parseCol(c.trim())).filter((c) => c.key) : null;
    return { kind: m[1], attrs, cols };
  }
  function splitTop(s, sep) {
    const out = []; let depth = 0, cur = '', q = null;
    for (const c of s) {
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '(' || c === '[') depth++;
      if (c === ')' || c === ']') depth--;
      if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }
  function parseCol(s) {
    const col = { key: '', tr: [], label: null, sort: null, reverse: false };
    // ラベルなどの属性 :label=X :sort=1 :reverse
    const parts = splitTop(s, ':');
    let expr = parts[0].trim();
    for (const a of parts.slice(1)) {
      const [k, v] = a.split('=');
      if (k.trim() === 'label') col.label = (v || '').replace(/^["']|["']$/g, '');
      else if (k.trim() === 'sort') col.sort = Number(v);
      else if (k.trim() === 'reverse') col.reverse = true;
    }
    // 変換 .name(args)
    const re = /\.([a-z_]+)\(([^)]*)\)/g;
    let m, first = expr.search(/\.[a-z_]+\(/);
    if (first >= 0) {
      const tail = expr.slice(first);
      expr = expr.slice(0, first);
      while ((m = re.exec(tail))) col.tr.push([m[1], m[2] ? splitTop(m[2], ',').map((x) => x.trim().replace(/^["']|["']$/g, '')) : []]);
    }
    // 関数の形 basename(name)
    const fm = expr.match(/^([a-z_]+)\((.*)\)$/);
    if (fm && TRANSFORMS[fm[1]]) { col.tr.unshift([fm[1], []]); expr = fm[2]; }
    col.key = expr.trim();
    return col;
  }
  const colVal = (row, c) => { let v = get(row, c.key); for (const [n, a] of c.tr) if (TRANSFORMS[n]) v = TRANSFORMS[n](v, a); return v; };
  const headOf = (c) => (c.label !== null ? c.label : parseKey(c.key).filter((k) => typeof k === 'string' && k !== '[]').pop().replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());

  // ---------------------------------------------------------------- 値を文字列にする
  const scalar = (v, sep = ';') => {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return v.map((x) => scalar(x, sep)).join(sep);
    if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}=${scalar(x)}`).join(sep);
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    return String(v);
  };

  // ---------------------------------------------------------------- JSON と YAML
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = sortKeys(v[k]); return o; }
    return v;
  };
  const toJSON = (v) => JSON.stringify(sortKeys(v), null, 2);
  // PyYAML の safe_dump に近い引用符の付け方
  function yScalar(s) {
    if (s === null || s === undefined) return 'null';
    if (typeof s === 'boolean') return s ? 'true' : 'false';
    if (typeof s === 'number') return String(s);
    s = String(s);
    if (s === '') return "''";
    if (s.includes('\n')) return null;   // ブロックで書く
    const looksSpecial = /^(true|false|yes|no|on|off|null|~|y|n)$/i.test(s)
      || /^[-+]?(\d[\d_]*)(\.\d*)?([eE][-+]?\d+)?$/.test(s) || /^[-+]?\.\d+$/.test(s) || /^0[xo][0-9a-f]+$/i.test(s)
      || /^\d{4}-\d\d?-\d\d?([Tt ]|$)/.test(s)
      || /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(s) || /[\s]$/.test(s) || /: |:$| #/.test(s) || /^- /.test(s);
    if (!looksSpecial) return s;
    return "'" + s.replace(/'/g, "''") + "'";
  }
  function toYAML(v, ind = '') {
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      return v.map((x) => {
        if (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length) {
          const body = toYAML(x, ind + '  ');
          return ind + '- ' + body.slice(ind.length + 2);
        }
        return ind + '- ' + inlineY(x, ind + '  ');
      }).join('\n');
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
      if (!keys.length) return ind + '{}';
      return keys.map((k) => {
        const x = v[k];
        const kk = yScalar(k);
        if (Array.isArray(x)) return x.length ? `${ind}${kk}:\n${toYAML(x, ind)}` : `${ind}${kk}: []`;
        if (x && typeof x === 'object') return Object.keys(x).length ? `${ind}${kk}:\n${toYAML(x, ind + '  ')}` : `${ind}${kk}: {}`;
        return `${ind}${kk}: ${inlineY(x, ind + '  ')}`;
      }).join('\n');
    }
    return ind + inlineY(v, ind);
  }
  function inlineY(x, ind) {
    if (x && typeof x === 'object') return Array.isArray(x) ? (x.length ? '\n' + toYAML(x, ind) : '[]') : (Object.keys(x).length ? '\n' + toYAML(x, ind) : '{}');
    const s = yScalar(x);
    if (s !== null) return s;
    const str = String(x);
    return (str.endsWith('\n') ? '|' : '|-') + '\n' + str.replace(/\n$/, '').split('\n').map((l) => (l ? ind + l : '')).join('\n');
  }
  G.toYAML = (v) => toYAML(v);
  G.toJSON = toJSON;

  // ---------------------------------------------------------------- 表
  function table(rows, cols, attrs) {
    const head = cols.map(headOf);
    const body = rows.map((r) => cols.map((c) => scalar(colVal(r, c), attrs.box ? ',' : ',')));
    const all = attrs['no-heading'] ? body : [head].concat(body);
    if (!all.length) return '';
    const wid = cols.map((_, j) => Math.max(...all.map((r) => [...r[j]].reduce((n, ch) => n + (/[　-￿]/.test(ch) ? 2 : 1), 0))));
    const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((k, ch) => k + (/[　-￿]/.test(ch) ? 2 : 1), 0)));
    if (attrs.box) {
      const line = (l, m, r) => l + wid.map((n) => '─'.repeat(n + 2)).join(m) + r;
      const row = (r) => '│ ' + r.map((s, j) => pad(s, wid[j])).join(' │ ') + ' │';
      const center = (s, n) => { const w = [...s].length; const left = Math.floor((n - w) / 2); return ' '.repeat(left) + s + ' '.repeat(n - w - left); };
      const out = [line('┌', '┬', '┐')];
      if (!attrs['no-heading']) { out.push('│ ' + head.map((s, j) => center(s, wid[j])).join(' │ ') + ' │'); out.push(line('├', '┼', '┤')); }
      for (const r of body) out.push(row(r));
      out.push(line('└', '┴', '┘'));
      return out.join('\n') + '\n';
    }
    return all.map((r) => r.map((s, j) => (j === r.length - 1 ? s : pad(s, wid[j]))).join('  ').replace(/\s+$/, '')).join('\n') + '\n';
  }

  // ---------------------------------------------------------------- --flatten
  function flatten(list, keys0) {
    let rows = list;
    // 'bindings[].members' は、bindings を展開してから bindings.members を展開する
    const keys = [];
    for (const k0 of keys0) { const segs = k0.split('[]'); let acc = ''; for (let j = 0; j < segs.length; j++) { acc += segs[j]; if (acc && (j < segs.length - 1 || segs[j] !== '')) keys.push(acc.replace(/^\./, '')); } }
    for (const key of keys) {
      const path = parseKey(key.replace(/\[\]$/, ''));
      const out = [];
      for (const r of rows) {
        const arr = get(r, path);
        if (!Array.isArray(arr) || !arr.length) { out.push(r); continue; }
        for (const x of arr) {
          const c = G.clone(r);
          let o = c;
          for (let j = 0; j < path.length - 1; j++) o = o[path[j]];
          o[path[path.length - 1]] = x;
          out.push(c);
        }
      }
      rows = out;
    }
    return rows;
  }

  // ---------------------------------------------------------------- --filter
  // 項：key=値 key!=値 key:値 key~正規表現 key<値 key>値 key:*（ある）  否定：-項 / NOT 項  結合：AND OR ( )
  function tokFilter(s) {
    const out = []; let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '(' || c === ')') { out.push(c); i++; continue; }
      if (c === '"' || c === "'") { const e = s.indexOf(c, i + 1); out.push({ q: s.slice(i + 1, e < 0 ? s.length : e) }); i = e < 0 ? s.length : e + 1; continue; }
      const m = s.slice(i).match(/^(!=|<=|>=|=|:|~|<|>)/);
      if (m) {
        out.push({ op: m[1] }); i += m[1].length;
        // 演算子の後ろの値は、空白か ) までをそのまま（group:a@b のように : を含んでもよい）
        while (s[i] === ' ') i++;
        if (s[i] && s[i] !== '"' && s[i] !== "'" && s[i] !== '(') { let j = i; while (j < s.length && !/[\s)]/.test(s[j])) j++; out.push({ q: s.slice(i, j) }); i = j; }
        continue;
      }
      let j = i; while (j < s.length && !/[\s()=:~<>!"']/.test(s[j])) j++;
      if (j === i) { if (s[i] === '!') { out.push({ op: '!' }); i++; continue; } j = i + 1; }
      out.push(s.slice(i, j)); i = j;
    }
    return out;
  }
  let SUBSTR = false;
  function compileFilter(expr) {
    const t = tokFilter(expr);
    let k = 0;
    const word = (x) => (x && typeof x === 'object' && 'q' in x ? x.q : x);
    function orE() { let l = andE(); while (t[k] === 'OR') { k++; const r = andE(); const a = l; l = (o) => a(o) || r(o); } return l; }
    function andE() {
      let l = notE();
      while (k < t.length && t[k] !== ')' && t[k] !== 'OR') { if (t[k] === 'AND') k++; const r = notE(); const a = l; l = (o) => a(o) && r(o); }
      return l;
    }
    function notE() {
      if (t[k] === 'NOT') { k++; const f = notE(); return (o) => !f(o); }
      if (typeof t[k] === 'string' && t[k].startsWith('-') && t[k].length > 1) { t[k] = t[k].slice(1); const f = term(); return (o) => !f(o); }
      return term();
    }
    function term() {
      if (t[k] === '(') { k++; const f = orE(); if (t[k] === ')') k++; return f; }
      const key = word(t[k++]);
      const op = t[k] && t[k].op;
      if (!op) { const v = String(key).toLowerCase(); return (o) => JSON.stringify(o).toLowerCase().includes(v); }
      k++;
      let val;
      if (t[k] === '(') { k++; val = []; while (k < t.length && t[k] !== ')') { if (t[k] !== 'OR') val.push(word(t[k])); k++; } k++; }
      else val = word(t[k++]);
      return (o) => test(get(o, key), op, val);
    }
    const f = orE();
    return f;
  }
  function test(v, op, val) {
    if (Array.isArray(val)) return val.some((x) => test(v, op, x));
    if (Array.isArray(v)) return op === '!=' ? !v.some((x) => test(x, '=', val)) : v.some((x) => test(x, op, val));
    if (v && typeof v === 'object' && op === ':') return Object.keys(v).some((k) => test(k, ':', val)) || Object.values(v).some((x) => test(x, ':', val));
    if (op === ':' && val === '*') return v !== undefined && v !== null && v !== '';
    const s = v === undefined || v === null ? '' : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
    const sv = String(val);
    switch (op) {
      case '=': return s.toLowerCase() === sv.toLowerCase() || (!isNaN(+s) && !isNaN(+sv) && s !== '' && +s === +sv);
      case '!=': return !(s.toLowerCase() === sv.toLowerCase());
      case ':': {
        if (SUBSTR) return s.toLowerCase().includes(sv.toLowerCase().replace(/\*/g, ''));
        // 「含む」：語の先頭から（* は何でも）。大文字と小文字を区別しない
        const re = new RegExp('(^|[^a-z0-9])' + sv.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), 'i');
        return re.test(s) || s.toLowerCase() === sv.toLowerCase();
      }
      case '~': try { return new RegExp(sv).test(s); } catch (e) { return false; }
      case '<': return cmp(s, sv) < 0;
      case '>': return cmp(s, sv) > 0;
      case '<=': return cmp(s, sv) <= 0;
      case '>=': return cmp(s, sv) >= 0;
    }
    return false;
  }
  const cmp = (a, b) => (!isNaN(+a) && !isNaN(+b) && a !== '' && b !== '' ? +a - +b : a < b ? -1 : a > b ? 1 : 0);
  function filter(list, expr, opts) {
    if (!expr) return list;
    SUBSTR = !!(opts && opts.substr);
    try {
      const f = compileFilter(expr);
      return list.filter((o) => { try { return f(o); } catch (e) { return false; } });
    } finally { SUBSTR = false; }
  }

  // ---------------------------------------------------------------- 表示
  // def：コマンドの既定の書式（'table(...)' や 'yaml'）。fmtStr：--format の値
  function print(data, fmtStr, def, opts = {}) {
    const isList = Array.isArray(data);
    let rows = isList ? data : [data];
    if (opts.flatten && opts.flatten.length) rows = flatten(rows, opts.flatten);
    if (opts.filter) rows = filter(rows, opts.filter);
    if (opts.sortBy) {
      const keys = opts.sortBy.split(',').map((x) => x.trim());
      rows = rows.slice().sort((a, b) => {
        for (const k of keys) { const r = k.startsWith('~'); const kk = r ? k.slice(1) : k; const c = cmp(scalar(get(a, kk)), scalar(get(b, kk))); if (c) return r ? -c : c; }
        return 0;
      });
    }
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);
    const f = parseFormat(fmtStr || def || 'yaml');
    // 書式の名前だけ（table）で列がないときは、既定の書式の列を使う
    if (!f.cols && def) { const d = parseFormat(def); if (d.kind === f.kind || (f.kind === 'table' && d.cols)) f.cols = d.cols; }
    switch (f.kind) {
      case 'none': return '';
      case 'json': {
        const v = f.cols ? rows.map((r) => projectObj(r, f.cols)) : rows;
        return toJSON(isList ? v : v[0]) + '\n';
      }
      case 'yaml': {
        const v = f.cols ? rows.map((r) => projectObj(r, f.cols)) : rows;
        return v.map((x) => toYAML(x)).join('\n---\n') + (v.length ? '\n' : '');
      }
      case 'value': case 'csv': case 'get': {
        const cols = f.cols || [{ key: '', tr: [] }];
        const sep = f.kind === 'csv' ? ',' : f.attrs.separator !== undefined ? f.attrs.separator : '\t';
        const lines = rows.map((r) => cols.map((c) => (c.key ? scalar(colVal(r, c), f.attrs.delimiter || ';') : scalar(r))).join(sep));
        if (f.kind === 'csv' && !f.attrs['no-heading']) lines.unshift(cols.map((c) => (c.label !== null ? c.label : c.key)).join(','));
        return lines.length ? lines.join('\n') + '\n' : '';
      }
      case 'table': {
        if (!f.cols) return rows.map((r) => toYAML(r)).join('\n---\n') + '\n';
        if (!rows.length) return '';
        return table(rows, f.cols, f.attrs);
      }
      case 'list': return rows.map((r) => ' - ' + (f.cols ? f.cols.map((c) => scalar(colVal(r, c))).join(' ') : scalar(r))).join('\n') + (rows.length ? '\n' : '');
      case 'flattened': return rows.map((r) => flat(r).map(([k, v]) => `${k}: ${v}`).join('\n')).join('\n---\n') + (rows.length ? '\n' : '');
      case 'text': return rows.map((r) => flat(r).map(([k, v]) => `${k}: ${v}`).join('\n')).join('\n') + (rows.length ? '\n' : '');
      default: throw G.E.plain(`Format must be one of config, csv, default, diff, disable, flattened, get, json, list, multi, none, object, table, text, value, yaml; received [${f.kind}].`);
    }
  }
  function projectObj(r, cols) {
    const o = {};
    for (const c of cols) {
      const v = colVal(r, c);
      const path = parseKey(c.key).filter((k) => k !== '[]');
      let t = o;
      for (let j = 0; j < path.length - 1; j++) t = t[path[j]] = t[path[j]] || (typeof path[j + 1] === 'number' ? [] : {});
      t[path[path.length - 1]] = v;
    }
    return o;
  }
  function flat(o, pre = '') {
    const out = [];
    if (Array.isArray(o)) o.forEach((x, j) => out.push(...flat(x, `${pre}[${j}]`)));
    else if (o && typeof o === 'object') for (const k of Object.keys(o).sort()) out.push(...flat(o[k], pre ? `${pre}.${k}` : k));
    else out.push([pre, o === undefined || o === null ? '' : typeof o === 'boolean' ? (o ? 'true' : 'false') : String(o)]);
    return out.map(([k, v]) => [k, v]);
  }
  G.fmt = { print, filter, flatten, parseFormat, get, scalar, toYAML, toJSON, table };
})(typeof window !== 'undefined' ? window : globalThis);
