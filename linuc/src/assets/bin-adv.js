// 図解 Linux のコマンド群（その 3：awk、paste、pgrep / pkill、nohup、setsid、truncate）。init.js の後に読み込む。API は kernel.js の先頭コメントを見る。
// awk は簡易版：BEGIN / END、パターン（/正規表現/、式）、print / printf、変数、$1…、NR NF FS OFS ORS FILENAME、-F、-v、算術と文字列の連結、比較、~ と !~、
//   && || !、++ -- += -= *= /=、if / else、while、for (;;)、for (k in 配列)、連想配列と delete、next、exit、
//   関数 length substr index split sub gsub match toupper tolower sprintf int。getline、ユーザー定義関数、範囲パターン（/a/,/b/）、出力のリダイレクトとパイプはない。
(function (root) {
  'use strict';
  const LNX = root.LNX, E = LNX.ERRNO, sys = LNX.sys, U = LNX.util, O = LNX.O, SIG = LNX.SIG, strerror = LNX.strerror;
  const { P, isErr, lines, posixRe } = LNX.binutil;
  const L = { late: true };

  // ════════════ awk ════════════
  function awkLex(src) {
    const toks = [];
    let i = 0;
    const n = src.length;
    const prevVal = () => { const t = toks[toks.length - 1]; return t && (t.t === 'num' || t.t === 'str' || t.t === 'name' || t.t === 'func' || (t.t === 'op' && (t.v === ')' || t.v === ']' || t.v === '$'))) && !(t.t === 'name' && KW[t.v]); };
    while (i < n) {
      const ch = src[i];
      if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
      if (ch === '\\' && src[i + 1] === '\n') { i += 2; continue; }
      if (ch === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      if (ch === '\n') { toks.push({ t: 'nl' }); i++; continue; }
      if (ch === '"') { let s = ''; i++; while (i < n && src[i] !== '"') { if (src[i] === '\\') { i++; const e = src[i]; s += { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '/': '/' }[e] !== undefined ? { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '/': '/' }[e] : '\\' + e; i++; } else s += src[i++]; } if (i >= n) throw new Error('non-terminated string'); i++; toks.push({ t: 'str', v: s }); continue; }
      if (ch === '/' && !prevVal()) { let s = ''; i++; while (i < n && src[i] !== '/') { if (src[i] === '\\' && src[i + 1] === '/') { s += '/'; i += 2; } else { if (src[i] === '\n') throw new Error('newline in regex'); s += src[i++]; } } if (i >= n) throw new Error('non-terminated regular expression'); i++; toks.push({ t: 're', v: s }); continue; }
      let m;
      if ((m = /^(\d+\.?\d*([eE][-+]?\d+)?|\.\d+)/.exec(src.slice(i, i + 40)))) { toks.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
      if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 80)))) { const nm = m[0]; i += nm.length; toks.push(FUNCS[nm] && !KW[nm] ? { t: 'func', v: nm } : { t: 'name', v: nm }); continue; }
      const three = src.substr(i, 3), two = src.substr(i, 2);
      if (two === '&&' || two === '||' || two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '!~' || two === '++' || two === '--' || two === '+=' || two === '-=' || two === '*=' || two === '/=' || two === '%=' || two === '^=') { toks.push({ t: 'op', v: two }); i += 2; continue; }
      void three;
      if ('{}()[];,+-*/%^!<>=~?:$'.indexOf(ch) >= 0) { toks.push({ t: 'op', v: ch }); i++; continue; }
      throw new Error("syntax error at source line 1\n context is\n\t>>> " + ch + ' <<<');
    }
    toks.push({ t: 'eof' });
    return toks;
  }
  const KW = { BEGIN: 1, END: 1, if: 1, else: 1, while: 1, for: 1, in: 1, print: 1, printf: 1, next: 1, exit: 1, delete: 1, do: 1, break: 1, continue: 1, function: 1, getline: 1, return: 1 };
  const FUNCS = { length: 1, substr: 1, index: 1, split: 1, sub: 1, gsub: 1, match: 1, toupper: 1, tolower: 1, sprintf: 1, int: 1, sqrt: 1, log: 1, exp: 1, sin: 1, cos: 1, rand: 1, srand: 1, system: 1 };
  function awkParse(src) {
    const tk = awkLex(src);
    let p = 0;
    const peek = () => tk[p], isOp = (v) => tk[p].t === 'op' && tk[p].v === v, isKw = (v) => tk[p].t === 'name' && tk[p].v === v;
    const eat = (v) => { if (!isOp(v)) throw new Error('syntax error near ' + (tk[p].v === undefined ? 'end of program' : tk[p].v)); p++; };
    const skipNl = () => { while (tk[p].t === 'nl' || isOp(';')) p++; };
    const optNl = () => { while (tk[p].t === 'nl') p++; };
    function primary() {
      const t = tk[p];
      if (t.t === 'num') { p++; return { k: 'num', v: t.v }; }
      if (t.t === 'str') { p++; return { k: 'str', v: t.v }; }
      if (t.t === 're') { p++; return { k: 'rematch', re: t.v }; }
      if (isOp('$')) { p++; return { k: 'field', e: unaryHigh() }; }
      if (isOp('(')) { p++; const e = expr(); if (isOp(',')) { const list = [e]; while (isOp(',')) { p++; list.push(expr()); } eat(')'); if (isKw('in')) { p++; const nm = tk[p++].v; return { k: 'in', key: list, arr: nm }; } throw new Error('syntax error'); } eat(')'); return { k: 'grp', e }; }
      if (isOp('-')) { p++; return { k: 'neg', e: unaryHigh() }; }
      if (isOp('+')) { p++; return { k: 'pos', e: unaryHigh() }; }
      if (isOp('!')) { p++; return { k: 'not', e: unaryHigh() }; }
      if (isOp('++') || isOp('--')) { const op = t.v; p++; const lv = primary(); return { k: 'pre', op, lv }; }
      if (t.t === 'func') { p++; const args = []; if (isOp('(')) { p++; if (!isOp(')')) { args.push(expr()); while (isOp(',')) { p++; args.push(expr()); } } eat(')'); } return { k: 'call', f: t.v, args }; }
      if (t.t === 'name' && !KW[t.v]) { p++; if (isOp('[')) { p++; const key = [expr()]; while (isOp(',')) { p++; key.push(expr()); } eat(']'); return { k: 'idx', n: t.v, key }; } return { k: 'var', n: t.v }; }
      throw new Error('syntax error near ' + (t.v === undefined ? 'end of program' : t.v));
    }
    function postfix() { const e = primary(); if ((isOp('++') || isOp('--')) && (e.k === 'var' || e.k === 'idx' || e.k === 'field')) { const op = tk[p].v; p++; return { k: 'post', op, lv: e }; } return e; }
    function unaryHigh() { return postfix(); }
    function power() { const a = postfix(); if (isOp('^')) { p++; return { k: 'bin', op: '^', a, b: powerU() }; } return a; }
    function powerU() { if (isOp('-')) { p++; return { k: 'neg', e: powerU() }; } return power(); }
    function mul() { let a = power(); while (isOp('*') || isOp('/') || isOp('%')) { const op = tk[p].v; p++; a = { k: 'bin', op, a, b: power() }; } return a; }
    function add() { let a = mul(); while (isOp('+') || isOp('-')) { const op = tk[p].v; p++; a = { k: 'bin', op, a, b: mul() }; } return a; }
    const startsVal = () => { const t = tk[p]; return t.t === 'num' || t.t === 'str' || t.t === 'func' || (t.t === 'name' && !KW[t.v]) || (t.t === 'op' && (t.v === '$' || t.v === '(' || t.v === '!' || t.v === '-' || t.v === '+' || t.v === '++' || t.v === '--')); };
    function concat() { let a = add(); while (startsVal() && !(tk[p].t === 'op' && (tk[p].v === '!' && tk[p + 1].t === 'op' && tk[p + 1].v === '~'))) { if (tk[p].t === 'op' && (tk[p].v === '-' || tk[p].v === '+' || tk[p].v === '!')) break; a = { k: 'cat', a, b: add() }; } return a; }
    let noGt = 0;
    function cmp() { let a = concat(); for (;;) { const t = tk[p]; if (t.t === 'op' && (t.v === '<' || t.v === '<=' || t.v === '==' || t.v === '!=' || t.v === '>=' || (t.v === '>' && !noGt))) { p++; a = { k: 'cmp', op: t.v, a, b: concat() }; } else break; } return a; }
    function match() { let a = cmp(); while (isOp('~') || isOp('!~')) { const neg = tk[p].v === '!~'; p++; const b = cmp(); a = { k: 'match', neg, a, b }; } return a; }
    function inop() { let a = match(); while (isKw('in')) { p++; const nm = tk[p++].v; a = { k: 'in', key: [a], arr: nm }; } return a; }
    function and() { let a = inop(); while (isOp('&&')) { p++; optNl(); a = { k: 'and', a, b: inop() }; } return a; }
    function or() { let a = and(); while (isOp('||')) { p++; optNl(); a = { k: 'or', a, b: and() }; } return a; }
    function ternary() { const c = or(); if (isOp('?')) { p++; const a = ternary(); eat(':'); const b = ternary(); return { k: 'cond', c, a, b }; } return c; }
    function expr() {
      const l = ternary();
      const t = tk[p];
      if (t.t === 'op' && (t.v === '=' || t.v === '+=' || t.v === '-=' || t.v === '*=' || t.v === '/=' || t.v === '%=' || t.v === '^=') && (l.k === 'var' || l.k === 'idx' || l.k === 'field')) { p++; return { k: 'assign', op: t.v, lv: l, e: expr() }; }
      return l;
    }
    function simple() {
      if (isKw('print') || isKw('printf')) {
        const kind = tk[p].v; p++;
        const args = [];
        noGt++;
        try { if (!(isOp(';') || isOp('}') || tk[p].t === 'nl' || tk[p].t === 'eof')) { let e = expr(); if (e.k === 'grp' && isOp(',')) e = e.e; args.push(e); while (isOp(',')) { p++; optNl(); args.push(expr()); } } } finally { noGt--; }
        if (isOp('>') || isOp('|')) throw new Error('print > file / print | cmd are not supported in this awk');
        return { k: kind, args };
      }
      if (isKw('next')) { p++; return { k: 'next' }; }
      if (isKw('exit')) { p++; return { k: 'exit', e: isOp(';') || isOp('}') || tk[p].t === 'nl' || tk[p].t === 'eof' ? null : expr() }; }
      if (isKw('break')) { p++; return { k: 'break' }; }
      if (isKw('continue')) { p++; return { k: 'continue' }; }
      if (isKw('delete')) { p++; const nm = tk[p++].v; if (isOp('[')) { p++; const key = [expr()]; while (isOp(',')) { p++; key.push(expr()); } eat(']'); return { k: 'delete', n: nm, key }; } return { k: 'delete', n: nm, key: null }; }
      return { k: 'expr', e: expr() };
    }
    function stmt() {
      skipNl();
      if (isOp('{')) return block();
      if (isKw('if')) { p++; eat('('); const c = expr(); eat(')'); optNl(); const a = stmt(); const save = p; skipNl(); if (isKw('else')) { p++; optNl(); return { k: 'if', c, a, b: stmt() }; } p = save; return { k: 'if', c, a, b: null }; }
      if (isKw('while')) { p++; eat('('); const c = expr(); eat(')'); optNl(); return { k: 'while', c, body: stmt() }; }
      if (isKw('do')) { p++; optNl(); const body = stmt(); skipNl(); if (!isKw('while')) throw new Error('syntax error'); p++; eat('('); const c = expr(); eat(')'); return { k: 'do', c, body }; }
      if (isKw('for')) {
        p++; eat('(');
        if (tk[p].t === 'name' && tk[p + 1].t === 'name' && tk[p + 1].v === 'in' && tk[p + 3].t === 'op' && tk[p + 3].v === ')') { const v = tk[p].v, arr = tk[p + 2].v; p += 4; optNl(); return { k: 'forin', v, arr, body: stmt() }; }
        const init = isOp(';') ? null : simple(); eat(';'); const c = isOp(';') ? null : expr(); eat(';'); const inc = isOp(')') ? null : simple(); eat(')'); optNl();
        return { k: 'for', init, c, inc, body: stmt() };
      }
      if (isOp(';')) { p++; return { k: 'empty' }; }
      const s = simple();
      if (!(isOp(';') || isOp('}') || tk[p].t === 'nl' || tk[p].t === 'eof')) throw new Error('syntax error near ' + (tk[p].v === undefined ? 'end of program' : tk[p].v));
      return s;
    }
    function block() { eat('{'); const list = []; for (;;) { skipNl(); if (isOp('}')) { p++; break; } if (tk[p].t === 'eof') throw new Error('unexpected end of program (missing })'); list.push(stmt()); } return { k: 'block', list }; }
    const rules = [];
    for (;;) {
      skipNl();
      if (peek().t === 'eof') break;
      let pat = null, kind = 'main';
      if (isKw('BEGIN')) { p++; kind = 'begin'; } else if (isKw('END')) { p++; kind = 'end'; } else if (isKw('function')) throw new Error('user-defined functions are not supported in this awk');
      else if (!isOp('{')) { pat = expr(); if (isOp(',')) throw new Error('range patterns are not supported in this awk'); }
      let body = null;
      if (isOp('{')) body = block(); else if (kind !== 'main') throw new Error('BEGIN/END requires an action');
      rules.push({ kind, pat, body });
    }
    return rules;
  }
  const looksNum = (s) => /^[ \t\n]*[-+]?(\d+\.?\d*([eE][-+]?\d+)?|\.\d+)[ \t\n]*$/.test(s);
  const numStr = (n) => { if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n); if (!isFinite(n)) return n > 0 ? 'inf' : n < 0 ? '-inf' : 'nan'; const e = Math.floor(Math.log10(Math.abs(n))); if (e < -4 || e >= 6) { const [m, x] = n.toExponential(5).split('e'); return m.replace(/\.?0+$/, '') + 'e' + x[0] + x.slice(1).padStart(2, '0'); } return String(Number(n.toPrecision(6))); };
  function awkFormat(fmt, args) {
    let i = 0;
    return fmt.replace(/%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?([a-zA-Z%])/g, (m, fl, w, pr, cv) => {
      if (cv === '%') return '%';
      if (w === '*') w = String(toNum(args[i++])); if (pr === '*') pr = String(toNum(args[i++]));
      const a = args[i++];
      let s;
      switch (cv) {
        case 'd': case 'i': s = String(Math.trunc(toNum(a === undefined ? 0 : a))); if (pr !== undefined) s = (s[0] === '-' ? '-' : '') + s.replace('-', '').padStart(+pr, '0'); break;
        case 'f': case 'F': s = toNum(a === undefined ? 0 : a).toFixed(pr === undefined ? 6 : +pr); break;
        case 'e': case 'E': { s = toNum(a === undefined ? 0 : a).toExponential(pr === undefined ? 6 : +pr).replace(/e([-+])(\d)$/, 'e$10$2'); if (cv === 'E') s = s.toUpperCase(); break; }
        case 'g': case 'G': s = numStr(toNum(a === undefined ? 0 : a)); break;
        case 'x': s = Math.trunc(toNum(a)).toString(16); break; case 'X': s = Math.trunc(toNum(a)).toString(16).toUpperCase(); break; case 'o': s = Math.trunc(toNum(a)).toString(8); break;
        case 'c': s = typeof a === 'number' ? String.fromCharCode(a) : toStr(a === undefined ? '' : a).slice(0, 1); break;
        case 's': s = toStr(a === undefined ? '' : a); if (pr !== undefined) s = s.slice(0, +pr); break;
        default: return m;
      }
      if (fl.indexOf('+') >= 0 && 'dief'.indexOf(cv) >= 0 && s[0] !== '-') s = '+' + s;
      if (w !== undefined) s = fl.indexOf('-') >= 0 ? s.padEnd(+w) : fl.indexOf('0') >= 0 && 'dixXofFeE'.indexOf(cv) >= 0 ? (s[0] === '-' || s[0] === '+' ? s[0] + s.slice(1).padStart(+w - 1, '0') : s.padStart(+w, '0')) : s.padStart(+w);
      return s;
    });
  }
  const toNum = (v) => { if (typeof v === 'number') return v; if (v && v.sn !== undefined) v = v.sn; const m = /^[ \t\n]*[-+]?(\d+\.?\d*([eE][-+]?\d+)?|\.\d+)/.exec(v); return m ? parseFloat(m[0]) : 0; };
  const toStr = (v) => (typeof v === 'number' ? numStr(v) : v && v.sn !== undefined ? v.sn : v);
  const toBool = (v) => (typeof v === 'number' ? v !== 0 : v && v.sn !== undefined ? (looksNum(v.sn) ? parseFloat(v.sn) !== 0 : v.sn !== '') : v !== '');
  function awkRun(rules, opt) {
    // opt = { vars, readLine: function*() → 行 | null, out(s), filename() }。ジェネレータ（入力を読むため）。戻り値は終了ステータス
    const V = Object.assign({ FS: ' ', OFS: ' ', ORS: '\n', NR: 0, NF: 0, FNR: 0, RS: '\n', SUBSEP: '\x1c', RSTART: 0, RLENGTH: -1, FILENAME: '' }, opt.vars || {});
    const A = {};
    let fields = [''], steps = 0;
    const reCache = new Map();
    const mkRe = (src) => { let r = reCache.get(src); if (!r) { try { r = new RegExp(posixRe(src, true)); } catch (e) { throw new Error('regular expression compile failed (' + src + ')'); } reCache.set(src, r); } return r; };
    const split = (s) => { const fs = toStr(V.FS); if (fs === ' ') { const t = s.replace(/^[ \t\n]+|[ \t\n]+$/g, ''); return t === '' ? [] : t.split(/[ \t\n]+/); } if (s === '') return []; if (fs.length === 1 && fs !== '\\') return s.split(fs); return s.split(mkRe(fs)); };
    const setRec = (s) => { const f = split(s); fields = [s].concat(f); V.NF = f.length; };
    const rebuild = () => { fields[0] = fields.slice(1).join(toStr(V.OFS)); };
    const sv = (s) => ({ sn: s });   // 入力から来た文字列（数に見えれば数として比べる）
    const getField = (i) => { if (i < 0) throw new Error('trying to access out of range field ' + i); return i < fields.length ? sv(fields[i]) : sv(''); };
    const setField = (i, v) => { const s = toStr(v); if (i === 0) setRec(s); else { while (fields.length <= i) fields.push(''); fields[i] = s; V.NF = fields.length - 1; rebuild(); } };
    const keyOf = (key) => key.map((e) => toStr(ev(e))).join(toStr(V.SUBSEP));
    const getLv = (lv) => (lv.k === 'var' ? (V[lv.n] === undefined ? sv('') : V[lv.n]) : lv.k === 'field' ? getField(Math.trunc(toNum(ev(lv.e)))) : ((A[lv.n] || (A[lv.n] = new Map())).has(keyOf(lv.key)) ? A[lv.n].get(keyOf(lv.key)) : (A[lv.n].set(keyOf(lv.key), sv('')), sv(''))));
    const setLv = (lv, v) => { if (lv.k === 'var') { V[lv.n] = v; if (lv.n === 'NF') { const n = Math.trunc(toNum(v)); fields.length = n + 1; for (let i = 1; i <= n; i++) if (fields[i] === undefined) fields[i] = ''; rebuild(); } } else if (lv.k === 'field') setField(Math.trunc(toNum(ev(lv.e))), v); else (A[lv.n] || (A[lv.n] = new Map())).set(keyOf(lv.key), v); };
    const isNumV = (v) => typeof v === 'number' || (v && v.sn !== undefined && looksNum(v.sn));
    const subst = (args, global) => {
      const re = args[0].k === 'rematch' ? mkRe(args[0].re) : mkRe(toStr(ev(args[0]))), rep = toStr(ev(args[1])), lv = args[2] || { k: 'field', e: { k: 'num', v: 0 } };
      const src = toStr(getLv(lv));
      let n = 0;
      const g = new RegExp(re.source, global ? 'g' : '');
      const out = src.replace(g, (m) => { n++; return rep.replace(/\\&|&|\\\\/g, (x) => (x === '&' ? m : x === '\\&' ? '&' : '\\')); });
      if (n) setLv(lv, out);
      return n;
    };
    function ev(e) {
      if (++steps > 5e6) throw new Error('program ran too long');
      switch (e.k) {
        case 'num': return e.v; case 'str': return e.v; case 'grp': return ev(e.e);
        case 'rematch': return mkRe(e.re).test(fields[0]) ? 1 : 0;
        case 'field': return getField(Math.trunc(toNum(ev(e.e))));
        case 'var': return V[e.n] === undefined ? sv('') : V[e.n];
        case 'idx': return getLv(e);
        case 'neg': return -toNum(ev(e.e)); case 'pos': return toNum(ev(e.e)); case 'not': return toBool(ev(e.e)) ? 0 : 1;
        case 'bin': { const a = toNum(ev(e.a)), b = toNum(ev(e.b)); switch (e.op) { case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': if (b === 0) throw new Error('division by zero'); return a / b; case '%': if (b === 0) throw new Error('division by zero in %'); return a % b; default: return Math.pow(a, b); } }
        case 'cat': return toStr(ev(e.a)) + toStr(ev(e.b));
        case 'cmp': { const a = ev(e.a), b = ev(e.b); let r; if (isNumV(a) && isNumV(b)) { const x = toNum(a), y = toNum(b); r = x < y ? -1 : x > y ? 1 : 0; } else { const x = toStr(a), y = toStr(b); r = x < y ? -1 : x > y ? 1 : 0; } return ({ '<': r < 0, '<=': r <= 0, '==': r === 0, '!=': r !== 0, '>': r > 0, '>=': r >= 0 }[e.op]) ? 1 : 0; }
        case 'match': { const s = toStr(ev(e.a)), re = e.b.k === 'rematch' ? mkRe(e.b.re) : mkRe(toStr(ev(e.b))); return re.test(s) !== e.neg ? 1 : 0; }
        case 'and': return toBool(ev(e.a)) && toBool(ev(e.b)) ? 1 : 0;
        case 'or': return toBool(ev(e.a)) || toBool(ev(e.b)) ? 1 : 0;
        case 'cond': return toBool(ev(e.c)) ? ev(e.a) : ev(e.b);
        case 'in': return A[e.arr] && A[e.arr].has(keyOf(e.key)) ? 1 : 0;
        case 'assign': { let v = ev(e.e); if (e.op !== '=') { const a = toNum(getLv(e.lv)), b = toNum(v); v = e.op === '+=' ? a + b : e.op === '-=' ? a - b : e.op === '*=' ? a * b : e.op === '/=' ? a / b : e.op === '%=' ? a % b : Math.pow(a, b); } else if (v && v.sn !== undefined) v = sv(v.sn); setLv(e.lv, v); return v; }
        case 'pre': { const v = toNum(getLv(e.lv)) + (e.op === '++' ? 1 : -1); setLv(e.lv, v); return v; }
        case 'post': { const v = toNum(getLv(e.lv)); setLv(e.lv, v + (e.op === '++' ? 1 : -1)); return v; }
        case 'call': {
          const a = e.args;
          switch (e.f) {
            case 'length': if (a.length && a[0].k === 'var' && A[a[0].n]) return A[a[0].n].size; return U.dec(toStr(a.length ? ev(a[0]) : sv(fields[0]))).length;
            case 'substr': { const s = toStr(ev(a[0])); let m = Math.round(toNum(ev(a[1]))), len = a.length > 2 ? Math.round(toNum(ev(a[2]))) : Infinity; if (m < 1) { len += m - 1; m = 1; } return len <= 0 ? '' : s.substr(m - 1, len === Infinity ? undefined : len); }
            case 'index': return toStr(ev(a[0])).indexOf(toStr(ev(a[1]))) + 1;
            case 'split': { const s = toStr(ev(a[0])), nm = a[1].n, oldFs = V.FS; let parts; if (a.length > 2) { const sep = a[2].k === 'rematch' ? a[2].re : toStr(ev(a[2])); V.FS = sep; parts = split(s); V.FS = oldFs; } else parts = split(s); const mp = A[nm] = new Map(); parts.forEach((x, i) => mp.set(String(i + 1), sv(x))); return parts.length; }
            case 'sub': return subst(a, false); case 'gsub': return subst(a, true);
            case 'match': { const s = toStr(ev(a[0])), re = a[1].k === 'rematch' ? mkRe(a[1].re) : mkRe(toStr(ev(a[1]))), m = re.exec(s); V.RSTART = m ? m.index + 1 : 0; V.RLENGTH = m ? m[0].length : -1; return V.RSTART; }
            case 'toupper': return toStr(ev(a[0])).toUpperCase(); case 'tolower': return toStr(ev(a[0])).toLowerCase();
            case 'sprintf': return awkFormat(toStr(ev(a[0])), a.slice(1).map(ev));
            case 'int': return Math.trunc(toNum(ev(a[0]))); case 'sqrt': return Math.sqrt(toNum(ev(a[0]))); case 'log': return Math.log(toNum(ev(a[0]))); case 'exp': return Math.exp(toNum(ev(a[0]))); case 'sin': return Math.sin(toNum(ev(a[0]))); case 'cos': return Math.cos(toNum(ev(a[0])));
            case 'rand': return 0.5; case 'srand': return 0;
            default: throw new Error('function ' + e.f + ' is not supported in this awk');
          }
        }
        default: throw new Error('bad expression');
      }
    }
    function ex(s) {
      if (++steps > 5e6) throw new Error('program ran too long');
      switch (s.k) {
        case 'block': for (const x of s.list) ex(x); return;
        case 'expr': ev(s.e); return; case 'empty': return;
        case 'print': opt.out((s.args.length ? s.args.map((a) => toStr(ev(a))).join(toStr(V.OFS)) : fields[0]) + toStr(V.ORS)); return;
        case 'printf': { if (!s.args.length) throw new Error('printf: no format'); opt.out(awkFormat(toStr(ev(s.args[0])), s.args.slice(1).map(ev))); return; }
        case 'if': if (toBool(ev(s.c))) ex(s.a); else if (s.b) ex(s.b); return;
        case 'while': while (toBool(ev(s.c))) { try { ex(s.body); } catch (e) { if (e === BRK) break; if (e !== CONT) throw e; } } return;
        case 'do': do { try { ex(s.body); } catch (e) { if (e === BRK) break; if (e !== CONT) throw e; } } while (toBool(ev(s.c))); return;
        case 'for': if (s.init) ex(s.init); while (!s.c || toBool(ev(s.c))) { try { ex(s.body); } catch (e) { if (e === BRK) break; if (e !== CONT) throw e; } if (s.inc) ex(s.inc); } return;
        case 'forin': for (const key of Array.from((A[s.arr] || new Map()).keys())) { V[s.v] = sv(key); try { ex(s.body); } catch (e) { if (e === BRK) break; if (e !== CONT) throw e; } } return;
        case 'delete': if (s.key) { if (A[s.n]) A[s.n].delete(keyOf(s.key)); } else A[s.n] = new Map(); return;
        case 'next': throw NEXT; case 'break': throw BRK; case 'continue': throw CONT;
        case 'exit': throw { awkExit: s.e ? Math.trunc(toNum(ev(s.e))) : null };
      }
    }
    const NEXT = { next: 1 }, BRK = { brk: 1 }, CONT = { cont: 1 };
    return (function* () {
      let code = 0, exited = false;
      const run = (kind) => { for (const r of rules) if (r.kind === kind) ex(r.body); };
      try {
        try { run('begin'); } catch (e) { if (e && e.awkExit !== undefined) { exited = true; if (e.awkExit !== null) code = e.awkExit; } else throw e; }
        if (!exited && rules.some((r) => r.kind !== 'begin')) {
          for (;;) {
            const l = yield* opt.readLine(V);
            if (l === null) break;
            V.NR = toNum(V.NR) + 1; V.FNR = toNum(V.FNR) + 1;
            setRec(l);
            try { for (const r of rules) { if (r.kind !== 'main') continue; if (r.pat === null || toBool(ev(r.pat))) { if (r.body) ex(r.body); else opt.out(fields[0] + toStr(V.ORS)); } } } catch (e) { if (e === NEXT) continue; if (e && e.awkExit !== undefined) { exited = true; if (e.awkExit !== null) code = e.awkExit; break; } throw e; }
            if (opt.pause) yield* opt.pause();
          }
        }
        try { run('end'); } catch (e) { if (e && e.awkExit !== undefined) { if (e.awkExit !== null) code = e.awkExit; } else throw e; }
      } catch (e) { if (e === NEXT || e === BRK || e === CONT) return code; throw e; }
      return code;
    })();
  }
  P('awk', '行を欄（フィールド）に分けて処理する小さな言語。例：awk \'{print $1}\'、awk -F, \'$3 > 80\'、awk \'{s += $1} END {print s}\'', "awk [-F 区切り] [-v 変数=値] 'プログラム' [ファイル…]", function* (c) {
    const av = c.argv.slice(1), vars = {};
    let prog = null, i = 0;
    const unesc = (s) => s.replace(/\\(.)/g, (m, x) => ({ t: '\t', n: '\n', '\\': '\\' }[x] || m));
    for (; i < av.length; i++) {
      const a = av[i];
      if (a === '--') { i++; break; }
      if (a === '-F') { if (av[i + 1] === undefined) { c.err("awk: option requires an argument -- F\n"); return 2; } vars.FS = unesc(av[++i]); if (vars.FS === 't') vars.FS = '\t'; } else if (a.slice(0, 2) === '-F' && a.length > 2) { vars.FS = unesc(a.slice(2)); if (vars.FS === 't') vars.FS = '\t'; } else if (a === '-v') { const m = /^([A-Za-z_]\w*)=(.*)$/.exec(av[++i] || ''); if (!m) { c.err('awk: invalid -v argument\n'); return 2; } vars[m[1]] = { sn: unesc(m[2]) }; } else if (a === '-f') { const d = yield* c.slurp(av[++i] || ''); if (typeof d !== 'string') { c.err("awk: can't open file " + av[i] + '\n'); return 2; } prog = d; } else if (a[0] === '-' && a.length > 1) { c.err('awk: unknown option ' + a + ' ignored\n'); } else break;
    }
    if (prog === null) { if (i >= av.length) { c.err("usage: awk [-F fs][-v var=value][prog | -f progfile][file ...]\n"); return 2; } prog = av[i++]; }
    let rules;
    try { rules = awkParse(prog); } catch (e) { c.err('awk: cmd. line:1: ' + prog.split('\n')[0] + '\nawk: cmd. line:1: ^ ' + (/^syntax error|unexpected|non-terminated/.test(e.message) ? 'syntax error' : e.message) + '\n'); return 1; }
    const files = av.slice(i);
    let fi = 0, rd = null, rc = 0;
    const next = function* (V) {
      for (;;) {
        if (!rd) {
          if (fi >= Math.max(1, files.length)) return null;
          const f = files.length ? files[fi] : '-';
          fi++;
          const m = /^([A-Za-z_]\w*)=(.*)$/.exec(f);
          if (m && files.length) { V[m[1]] = { sn: unesc(m[2]) }; if (fi >= files.length && !files.some((x) => !/^[A-Za-z_]\w*=/.test(x))) { files.push('-'); } continue; }
          const fd = f === '-' ? 0 : yield sys.open(f, O.RDONLY);
          if (fd < 0) { c.err("awk: fatal: cannot open file `" + f + "' for reading: " + strerror(fd) + '\n'); throw { awkFatal: 2 }; }
          rd = c.reader(fd); rd.name = f; V.FILENAME = f; V.FNR = 0;
        }
        const l = yield* rd.line();
        if (l !== null) return l;
        if (rd.fd !== 0) yield sys.close(rd.fd);
        rd = null;
      }
    };
    try {
      const st = yield* awkRun(rules, { vars, readLine: next, out: (s) => c.out(s), pause: function* () { if (c.qn >= 4096) yield* c.flush(true); } });
      return st || rc;
    } catch (e) { if (e && e.awkFatal) { yield* c.flush(); return e.awkFatal; } if (e instanceof Error) { yield* c.flush(); c.err('awk: cmd. line:1: ' + (/^division by zero/.test(e.message) ? 'error: ' + e.message + ' attempted' : 'fatal: ' + e.message) + '\n'); return 2; } throw e; }
  }, L);
  LNX.awk = { parse: awkParse, run: awkRun };

  // ════════════ paste ════════════
  P('paste', '複数のファイルの同じ行を、タブでつないで横に並べる。-s なら 1 つのファイルの行を横につなぐ', 'paste [-s] [-d 区切り] [ファイル…]', function* (c) {
    const g = c.getopt('sd:', { '--serial': 's', '--delimiters': 'd' }); if (!g) return 1;
    const ds = (g.o.d === undefined ? '\t' : g.o.d.replace(/\\(.)/g, (m, x) => ({ t: '\t', n: '\n', 0: '', '\\': '\\' }[x] !== undefined ? { t: '\t', n: '\n', 0: '', '\\': '\\' }[x] : x))) || '';
    const dl = ds === '' ? [''] : g.o.d === undefined ? ['\t'] : (() => { const out = []; const raw = g.o.d; for (let i = 0; i < raw.length; i++) { if (raw[i] === '\\' && i + 1 < raw.length) { i++; out.push({ t: '\t', n: '\n', 0: '', '\\': '\\' }[raw[i]] !== undefined ? { t: '\t', n: '\n', 0: '', '\\': '\\' }[raw[i]] : raw[i]); } else out.push(raw[i]); } return out; })();
    const files = g.args.length ? g.args : ['-'], data = [];
    let rc = 0, stdin = null;
    for (const f of files) { if (f === '-' && files.filter((x) => x === '-').length > 1 && !g.o.s) { if (stdin === null) { const d = yield* c.slurp('-'); stdin = typeof d === 'string' ? lines(d) : []; } data.push(null); continue; } const d = yield* c.slurp(f); if (typeof d !== 'string') { c.perr(f, d); rc = 1; data.push([]); } else data.push(lines(d)); }
    if (stdin) { const k = data.filter((d) => d === null).length, cols = data.map((d) => (d === null ? [] : d)); let j = 0; stdin.forEach((l, i) => { let seen = 0; for (let x = 0; x < data.length; x++) if (data[x] === null) { if (seen === i % k) { cols[x].push(l); break; } seen++; } void j; }); for (let x = 0; x < data.length; x++) data[x] = cols[x]; }
    if (g.o.s) { for (const ls of data) { let o = ''; ls.forEach((l, i) => { o += (i ? dl[(i - 1) % dl.length] : '') + l; }); yield* c.put(o + '\n'); } return rc; }
    const n = Math.max(0, ...data.map((d) => d.length));
    for (let r = 0; r < n; r++) { let o = ''; data.forEach((d, i) => { o += (i ? dl[(i - 1) % dl.length] : '') + (r < d.length ? d[r] : ''); }); yield* c.put(o + '\n'); }
    return rc;
  }, L);

  // ════════════ pgrep / pkill ════════════
  function* procList(c) {
    const ents = yield* c.readDir('/proc'), out = [];
    if (isErr(ents)) return out;
    for (const e of ents) {
      if (!/^\d+$/.test(e.name)) continue;
      const st = yield* c.slurp('/proc/' + e.name + '/stat'), cl = yield* c.slurp('/proc/' + e.name + '/cmdline'), ss = yield* c.slurp('/proc/' + e.name + '/status');
      if (typeof st !== 'string') continue;
      const rp = st.lastIndexOf(')'), f = st.slice(rp + 2).trim().split(' '), um = /^Uid:\t\d+\t(\d+)/m.exec(typeof ss === 'string' ? ss : '');
      out.push({ pid: +e.name, comm: st.slice(st.indexOf('(') + 1, rp), state: f[0], ppid: +f[1], sid: +f[3], start: +f[19], euid: um ? +um[1] : 0, args: typeof cl === 'string' && cl ? cl.replace(/\0$/, '').split('\0').join(' ') : '' });
    }
    return out.sort((a, b) => a.pid - b.pid);
  }
  const pg = (kill) => function* (c) {
    const av = c.argv.slice(1);
    let sig = SIG.TERM;
    if (kill && av[0] && /^-(\d+|[A-Z]+[0-9]?)$/.test(av[0]) && !/^-[flnoxuPtvc]$/.test(av[0])) { const s = av.shift().slice(1); sig = /^\d+$/.test(s) ? +s : SIG[s.replace(/^SIG/, '')]; if (sig === undefined) { c.err(c.name + ': invalid signal -- ' + s + '\n'); return 2; } }
    c.argv = [c.argv[0]].concat(av);
    const g = c.getopt('flnoxvcau:P:t:d:', { '--full': 'f', '--list-name': 'l', '--list-full': 'a', '--newest': 'n', '--oldest': 'o', '--exact': 'x', '--inverse': 'v', '--count': 'c', '--euid': 'u', '--parent': 'P', '--delimiter': 'd' }); if (!g) return 2;
    const o = g.o;
    if (!g.args.length && o.u === undefined && o.P === undefined) { c.err(c.name + ": no matching criteria specified\nTry `" + c.name + " --help' for more information.\n"); return 2; }
    if (g.args.length > 1) { c.err(c.name + ": only one pattern can be provided\nTry `" + c.name + " --help' for more information.\n"); return 2; }
    let re = null;
    if (g.args.length) { try { re = new RegExp(o.x ? '^(' + posixRe(g.args[0], true) + ')$' : posixRe(g.args[0], true)); } catch (e) { c.err(c.name + ': regex error\n'); return 2; } }
    const me = yield sys.getpid(), pw = yield* c.passwd();
    let uid = null;
    if (o.u !== undefined) { const u = pw.find((x) => x.name === o.u); uid = u ? u.uid : +o.u; if (isNaN(uid)) { c.err(c.name + ': invalid user name: ' + o.u + '\n'); return 2; } }
    let sel = (yield* procList(c)).filter((p) => p.pid !== me && p.state !== 'Z').filter((p) => { let ok = (!re || re.test(o.f ? p.args || p.comm : p.comm)) && (uid === null || p.euid === uid) && (o.P === undefined || o.P.split(',').map(Number).indexOf(p.ppid) >= 0); return o.v ? !ok : ok; });
    if (o.n && sel.length) sel = [sel.reduce((a, b) => (b.start > a.start || (b.start === a.start && b.pid > a.pid) ? b : a))];
    if (o.o && sel.length) sel = [sel.reduce((a, b) => (b.start < a.start || (b.start === a.start && b.pid < a.pid) ? b : a))];
    if (kill) { let rc = sel.length ? 0 : 1; for (const p of sel) { const r = yield sys.kill(p.pid, sig); if (r < 0) { c.err('pkill: killing pid ' + p.pid + ' failed: ' + strerror(r) + '\n'); rc = 3; } } return rc; }
    if (o.c) c.out(sel.length + '\n'); else c.out(sel.map((p) => p.pid + (o.a ? ' ' + (p.args || p.comm) : o.l ? ' ' + p.comm : '')).join(o.d !== undefined ? o.d : '\n') + (sel.length ? '\n' : ''));
    return sel.length ? 0 : 1;
  };
  P('pgrep', '名前でプロセスを探して、PID を表示する', 'pgrep [-f] [-l] [-a] [-n] [-o] [-x] [-u ユーザー] [-P 親の PID] パターン', pg(false), L);
  P('pkill', '名前でプロセスを探して、シグナルを送る（指定しなければ SIGTERM）', 'pkill [-シグナル] [-f] [-n] [-x] [-u ユーザー] パターン', pg(true), L);

  // ════════════ nohup / setsid / truncate ════════════
  P('nohup', 'SIGHUP を無視してコマンドを実行する（端末を閉じても終わらないようにする）。出力が端末なら nohup.out に書く', 'nohup コマンド [引数…]', function* (c) {
    if (c.argv.length < 2) { c.err("nohup: missing operand\nTry 'nohup --help' for more information.\n"); return 125; }
    yield sys.sigaction(SIG.HUP, 'SIG_IGN');
    const tin = yield* c.isatty(0), tout = yield* c.isatty(1), terr = yield* c.isatty(2);
    if (tout) {
      let name = 'nohup.out', fd = yield sys.open(name, O.WRONLY | O.CREAT | O.APPEND, 0o600);
      if (fd < 0) { name = (c.env.HOME || '') + '/nohup.out'; fd = yield sys.open(name, O.WRONLY | O.CREAT | O.APPEND, 0o600); }
      if (fd < 0) { c.err("nohup: failed to open 'nohup.out': " + strerror(fd) + '\n'); return 125; }
      yield* c.eput('nohup: ' + (tin ? 'ignoring input and ' : '') + "appending output to '" + name + "'\n");
      yield sys.dup2(fd, 1); yield sys.close(fd);
    } else if (tin) yield* c.eput('nohup: ignoring input\n');
    if (tin) { const n = yield sys.open('/dev/null', O.WRONLY); if (n >= 0) { yield sys.dup2(n, 0); yield sys.close(n); } }
    if (terr) yield sys.dup2(1, 2);
    const path = yield* c.which(c.argv[1]);
    const e = path ? yield sys.execve(path, c.argv.slice(1), c.env) : -E.ENOENT;
    yield* c.writeAll(2, "nohup: failed to run command '" + c.argv[1] + "': " + strerror(e) + '\n');
    return e === -E.ENOENT ? 127 : 126;
  }, L);
  P('setsid', '新しいセッションでコマンドを実行する（端末から切り離す）', 'setsid コマンド [引数…]', function* (c) {
    const av = c.argv.slice(1).filter((a) => !/^-[fcw]+$/.test(a) && a !== '--fork' && a !== '--wait');
    if (!av.length) { c.err('setsid: no command specified\n'); return 1; }
    const env = c.env;
    const run = function* (c2) { yield sys.setsid(); const path = yield* c2.which(av[0]); const e = path ? yield sys.execve(path, av, env) : -E.ENOENT; c2.err('setsid: failed to execute ' + av[0] + ': ' + strerror(e) + '\n'); return e === -E.ENOENT ? 127 : 126; };
    // プロセスグループのリーダーは setsid できないので、そのときは fork する（本物と同じ）
    if ((yield sys.getpgid(0)) === (yield sys.getpid())) { const pid = yield sys.fork(run); if (pid < 0) return c.perr('fork', pid); if (c.argv.indexOf('-w') >= 0 || c.argv.indexOf('--wait') >= 0) { const w = yield sys.wait4(pid, 0); return typeof w === 'object' ? (w.status >> 8) & 0xff : 1; } return 0; }
    return yield* run(c);
  }, L);
  P('truncate', 'ファイルの大きさを、指定した大きさに縮める・広げる', 'truncate -s 大きさ ファイル…   例：truncate -s 0 log、truncate -s 1M big', function* (c) {
    const g = c.getopt('s:c', { '--size': 's', '--no-create': 'c' }); if (!g) return 1;
    if (g.o.s === undefined) { c.err("truncate: you must specify either '--size' or '--reference'\nTry 'truncate --help' for more information.\n"); return 1; }
    if (!g.args.length) { c.err("truncate: missing file operand\nTry 'truncate --help' for more information.\n"); return 1; }
    const m = /^([-+<>]?)(\d+)([KMG]?)(B|iB)?$/i.exec(g.o.s);
    if (!m) { c.err("truncate: Invalid number: '" + g.o.s + "'\n"); return 1; }
    const n = +m[2] * ({ k: 1024, m: 1048576, g: 1073741824 }[m[3].toLowerCase()] || 1) / (m[4] === 'B' && m[3] ? 1.024 ** { k: 1, m: 2, g: 3 }[m[3].toLowerCase()] : 1);
    let rc = 0;
    for (const f of g.args) {
      const fd = yield sys.open(f, O.WRONLY | (g.o.c ? 0 : O.CREAT), 0o666);
      if (fd < 0) { if (g.o.c && fd === -E.ENOENT) continue; c.err("truncate: cannot open '" + f + "' for writing: " + strerror(fd) + '\n'); rc = 1; continue; }
      let size = Math.round(n);
      if (m[1]) { const st = yield sys.fstat(fd); size = m[1] === '+' ? st.size + size : m[1] === '-' ? Math.max(0, st.size - size) : m[1] === '<' ? Math.min(st.size, size) : Math.max(st.size, size); }
      const r = yield sys.ftruncate(fd, size);
      if (r < 0) { c.err("truncate: failed to truncate '" + f + "' at " + size + ' bytes: ' + strerror(r) + '\n'); rc = 1; }
      yield sys.close(fd);
    }
    return rc;
  }, L);
})(typeof window !== 'undefined' ? window : globalThis);
