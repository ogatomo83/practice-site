// 図解 Linux のシェル sh（POSIX sh の主要部分 + bash の一部）。kernel.js の後に読み込む。API は kernel.js の先頭コメントを見る。
// LNX.bin.sh（/usr/bin/sh の実体）と、LNX.sh = { parse(src), builtins, Parser, arith, globRe, echo, printf, test } を登録する。
(function (root) {
  'use strict';
  const LNX = root.LNX, sys = LNX.sys, E = LNX.ERRNO, SIG = LNX.SIG, SIGNAME = LNX.SIGNAME, O = LNX.O, W = LNX.W, F = LNX.F, TIO = LNX.TIO;
  const U = LNX.util, dec = U.dec, enc = U.enc, strerror = LNX.strerror;
  const HI = /[^\x00-\x7f]/;
  const CPU1 = { n: '_cpu', a: [1] };
  const TTYFD = 255;

  // ════════════════════════ 構文解析 ════════════════════════
  const META = { ' ': 1, '\t': 1, '\n': 1, ';': 1, '&': 1, '|': 1, '<': 1, '>': 1, '(': 1, ')': 1 };
  const RES_END = { then: 1, fi: 1, do: 1, done: 1, elif: 1, else: 1, esac: 1, '}': 1 };
  const KEYWORDS = ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', '{', '}', '!', 'function'];
  function synErr(msg, eof) { return { shSyntax: true, message: msg, eof: !!eof }; }

  function Parser(src, aliases) { this.s = src; this.i = 0; this.n = src.length; this.heredocs = []; this.aliases = aliases || null; this.noAlias = null; }
  const P = Parser.prototype;
  P.lineAt = function (i) { let l = 1; for (let j = 0; j < i && j < this.n; j++) if (this.s.charCodeAt(j) === 10) l++; return l; };
  P.ws = function () {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\r') this.i++;
      else if (c === '\\' && s[this.i + 1] === '\n') this.i += 2;
      else if (c === '#') { while (this.i < this.n && s[this.i] !== '\n') this.i++; } else break;
    }
  };
  P.nl = function () {
    if (this.s[this.i] !== '\n') return false;
    this.i++;
    if (this.heredocs.length) this.readHeredocs();
    return true;
  };
  P.skipNl = function () { for (;;) { this.ws(); if (!this.nl()) break; } };
  P.readHeredocs = function () {
    const s = this.s;
    for (const h of this.heredocs.splice(0)) {
      let body = '';
      for (;;) {
        if (this.i >= this.n) { this.hdOpen = true; break; }
        let end = s.indexOf('\n', this.i);
        if (end < 0) end = this.n;
        let line = s.slice(this.i, end);
        this.i = Math.min(this.n, end + 1);
        if (h.strip) line = line.replace(/^\t+/, '');
        if (line === h.delim) break;
        body += line + '\n';
      }
      h.redir.body = h.quoted ? [{ t: 'q', v: body }] : new Parser(body).dqParts(null, true);
    }
  };
  const OPS = ['&&', '||', ';;', '|', '&', ';', '(', ')', '\n'];
  P.peekOp = function () { const s = this.s, i = this.i; for (const op of OPS) if (s.startsWith(op, i)) return op; return null; };
  P.tokText = function () {
    this.ws();
    if (this.i >= this.n) return 'newline';
    const op = this.peekOp();
    if (op) return op === '\n' ? 'newline' : op;
    const m = /[^\s;&|<>()]+/y; m.lastIndex = this.i;
    const r = m.exec(this.s);
    return r ? r[0] : this.s[this.i];
  };
  P.unexpected = function () {
    this.ws();
    if (this.i >= this.n) return synErr('syntax error: unexpected end of file', true);
    return synErr("syntax error near unexpected token `" + this.tokText() + "'");
  };
  // その位置の「ただの単語」（引用も展開も含まない）。予約語の判定用
  P.peekRes = function () {
    this.ws();
    const m = /[^\s;&|<>()'"\\$`]+/y; m.lastIndex = this.i;
    const r = m.exec(this.s);
    if (!r) return null;
    const c = this.s[this.i + r[0].length];
    return c === undefined || META[c] ? r[0] : null;
  };
  P.expectRes = function (w) { this.skipNl(); if (this.peekRes() !== w) throw this.unexpected(); this.i += w.length; };
  P.expectOp = function (op) { this.skipNl(); if (!this.s.startsWith(op, this.i)) throw this.unexpected(); this.i += op.length; };

  // 1 行ぶん（改行まで）のリストを読む。入力の終わりなら null
  P.next = function () {
    this.skipNl();
    if (this.i >= this.n) return null;
    const items = [];
    for (;;) {
      this.ws();
      if (this.i >= this.n) break;
      if (this.nl()) break;
      const start = this.i, ao = this.andOr();
      let async = false;
      const end = this.i;
      this.ws();
      const op = this.peekOp();
      if (op === '&') { this.i++; async = true; } else if (op === ';') this.i++;
      else if (op !== '\n' && this.i < this.n) throw this.unexpected();
      items.push({ ao, async, text: this.s.slice(start, end).trim() });
    }
    return { t: 'list', items };
  };
  P.program = function () { const items = []; for (;;) { const l = this.next(); if (!l) break; for (const it of l.items) items.push(it); } return { t: 'list', items }; };
  P.atEnd = function () {
    this.ws();
    if (this.i >= this.n) return true;
    const s = this.s, i = this.i;
    if (s[i] === ')' || s.startsWith(';;', i)) return true;
    const w = this.peekRes();
    return !!(w && RES_END[w] === 1);
  };
  P.list = function () {
    const items = [];
    for (;;) {
      this.skipNl();
      if (this.atEnd()) break;
      const start = this.i, ao = this.andOr();
      let async = false;
      const end = this.i;
      this.ws();
      const op = this.peekOp();
      if (op === '&') { this.i++; async = true; } else if (op === ';') this.i++;
      else if (op !== '\n' && op !== ')' && op !== ';;' && this.i < this.n) throw this.unexpected();
      items.push({ ao, async, text: this.s.slice(start, end).trim() });
    }
    return { t: 'list', items };
  };
  P.andOr = function () {
    const first = this.pipeline(), rest = [];
    for (;;) {
      this.ws();
      const op = this.peekOp();
      if (op !== '&&' && op !== '||') break;
      this.i += 2; this.skipNl();
      if (this.i >= this.n) throw synErr('syntax error: unexpected end of file', true);
      rest.push({ op, pl: this.pipeline() });
    }
    return { first, rest };
  };
  P.pipeline = function () {
    let neg = false, time = null;
    if (this.peekRes() === 'time') { const save = this.i; this.ws(); this.i += 4; time = 'bash'; if (this.peekRes() === '-p') { this.ws(); this.i += 2; time = 'posix'; } this.ws(); const ch = this.s[this.i]; if (ch === undefined || ch === '\n' || ch === ';' || ch === '&' || ch === '|' || ch === ')') { if (ch === '|' || ch === '&' || ch === ')') { this.i = save; time = null; } else return { neg: false, time, cmds: [{ t: 'cmd', words: [{ parts: [{ t: 'lit', v: ':' }] }], assigns: [], redirs: [], line: this.lineAt(this.i) }] }; } }
    while (this.peekRes() === '!') { this.i++; neg = !neg; }
    const cmds = [this.command()];
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '|' || this.s[this.i + 1] === '|') break;
      this.i++;
      if (this.s[this.i] === '&') { this.i++; cmds[cmds.length - 1].redirs.push({ fd: 2, op: '>&', word: { parts: [{ t: 'lit', v: '1' }] } }); }
      this.skipNl();
      if (this.i >= this.n) throw synErr('syntax error: unexpected end of file', true);
      cmds.push(this.command());
    }
    return { neg, cmds, time };
  };
  P.redirs = function (node) { for (;;) { const r = this.tryRedir(); if (!r) break; node.redirs.push(r); } return node; };
  P.command = function () {
    this.ws();
    const s = this.s, line = this.lineAt(this.i);
    if (s[this.i] === '(') {
      this.i++;
      const l = this.list(); this.expectOp(')');
      return this.redirs({ t: 'sub', list: l, redirs: [], line });
    }
    const w = this.peekRes();
    if (w === 'if') {
      this.i += 2;
      const clauses = [];
      let els = null;
      let cond = this.list(); this.expectRes('then');
      clauses.push({ cond, body: this.list() });
      for (;;) {
        this.skipNl();
        const r = this.peekRes();
        if (r === 'elif') { this.i += 4; cond = this.list(); this.expectRes('then'); clauses.push({ cond, body: this.list() }); } else if (r === 'else') { this.i += 4; els = this.list(); } else break;
      }
      this.expectRes('fi');
      return this.redirs({ t: 'if', clauses, els, redirs: [], line });
    }
    if (w === 'while' || w === 'until') {
      this.i += 5;
      const cond = this.list(); this.expectRes('do');
      const body = this.list(); this.expectRes('done');
      return this.redirs({ t: 'while', until: w === 'until', cond, body, redirs: [], line });
    }
    if (w === 'for') {
      this.i += 3; this.ws();
      const m = /[A-Za-z_][A-Za-z0-9_]*/y; m.lastIndex = this.i;
      const r = m.exec(s);
      if (!r) throw this.unexpected();
      this.i += r[0].length;
      this.skipNl();
      let words = null;
      if (this.peekRes() === 'in') {
        this.i += 2; words = [];
        for (;;) { this.ws(); const c = s[this.i]; if (c === undefined || META[c]) break; words.push(this.readWord()); }
      }
      this.ws();
      if (s[this.i] === ';') this.i++;
      this.expectRes('do');
      const body = this.list(); this.expectRes('done');
      return this.redirs({ t: 'for', name: r[0], words, body, redirs: [], line });
    }
    if (w === 'case') {
      this.i += 4; this.ws();
      const word = this.readWord();
      if (!word) throw this.unexpected();
      this.expectRes('in');
      const items = [];
      for (;;) {
        this.skipNl();
        if (this.i >= this.n) throw synErr('syntax error: unexpected end of file', true);
        if (this.peekRes() === 'esac') break;
        if (s[this.i] === '(') this.i++;
        const pats = [];
        for (;;) { this.ws(); const pw = this.readWord(); if (!pw) throw this.unexpected(); pats.push(pw); this.ws(); if (s[this.i] === '|') { this.i++; continue; } break; }
        if (s[this.i] !== ')') throw this.unexpected();
        this.i++;
        const body = this.list();
        this.ws();
        let ft = false;
        if (s.startsWith(';;', this.i)) this.i += 2; else if (s.startsWith(';&', this.i)) { this.i += 2; ft = true; }
        items.push({ pats, body, ft });
      }
      this.expectRes('esac');
      return this.redirs({ t: 'case', word, items, redirs: [], line });
    }
    if (w === '{') {
      this.i++;
      const l = this.list(); this.expectRes('}');
      return this.redirs({ t: 'group', list: l, redirs: [], line });
    }
    if (w === 'function') {
      this.i += 8; this.ws();
      const m = /[^\s;&|<>()]+/y; m.lastIndex = this.i;
      const r = m.exec(s);
      if (!r) throw this.unexpected();
      this.i += r[0].length; this.ws();
      if (s[this.i] === '(') { this.i++; this.ws(); if (s[this.i] !== ')') throw this.unexpected(); this.i++; }
      this.skipNl();
      return { t: 'func', name: r[0], body: this.command(), redirs: [], line };
    }
    if (w && RES_END[w]) throw this.unexpected();
    if (w && !/[=]/.test(w) && KEYWORDS.indexOf(w) < 0) {
      const save = this.i;
      this.i += w.length; this.ws();
      if (s[this.i] === '(') {
        let j = this.i + 1;
        while (s[j] === ' ' || s[j] === '\t') j++;
        if (s[j] === ')') { this.i = j + 1; this.skipNl(); return { t: 'func', name: w, body: this.command(), redirs: [], line }; }
      }
      this.i = save;
    }
    return this.simple(line);
  };
  P.tryRedir = function () {
    this.ws();
    const m = /(\d*)(<<<|<<-|<<|>>|<&|>&|<>|>\||&>>|&>|<|>)/y; m.lastIndex = this.i;
    const r = m.exec(this.s);
    if (!r) return null;
    if (r[2][0] === '&' && r[1] !== '') return null;
    this.i += r[0].length; this.ws();
    const rd = { fd: r[1] === '' ? null : +r[1], op: r[2] };
    const w = this.readWord();
    if (!w) throw this.unexpected();
    if (rd.op === '<<' || rd.op === '<<-') {
      let quoted = false, delim = '';
      for (const p of w.parts) { if (p.t === 'lit') delim += p.v; else if (p.t === 'q') { quoted = true; delim += p.v; } else if (p.t === 'dq') { quoted = true; for (const q of p.parts) delim += q.v || ''; } }
      this.heredocs.push({ redir: rd, delim, strip: rd.op === '<<-', quoted });
      rd.op = '<<'; rd.body = [];
    } else rd.word = w;
    return rd;
  };
  P.simple = function (line) {
    const node = { t: 'cmd', assigns: [], words: [], redirs: [], line }, s = this.s;
    for (;;) {
      const r = this.tryRedir();
      if (r) { node.redirs.push(r); continue; }
      const c = s[this.i];
      if (c === undefined || META[c]) break;
      const start = this.i, w = this.readWord();
      if (!node.words.length) {
        const f = w.parts[0];
        if (f.t === 'lit') {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(f.v);
          if (m) {
            const rest = w.parts.slice(1), tail = f.v.slice(m[0].length);
            if (tail) rest.unshift({ t: 'lit', v: tail });
            node.assigns.push({ name: m[1], append: !!m[2], word: { parts: rest } });
            continue;
          }
          if (this.aliases && w.parts.length === 1 && this.aliases.has(f.v) && this.noAlias !== f.v) {
            this.s = s.slice(0, start) + this.aliases.get(f.v) + s.slice(this.i);
            this.n = this.s.length; this.i = start; this.noAlias = f.v;
            const nd = this.simple(line);
            this.noAlias = null;
            nd.assigns = node.assigns.concat(nd.assigns); nd.redirs = node.redirs.concat(nd.redirs);
            return nd;
          }
        }
      }
      node.words.push(w);
    }
    if (!node.assigns.length && !node.words.length && !node.redirs.length) throw this.unexpected();
    return node;
  };
  P.readWord = function () {
    const s = this.s, parts = [];
    let lit = '';
    const flush = () => { if (lit) { parts.push({ t: 'lit', v: lit }); lit = ''; } };
    for (;;) {
      const c = s[this.i];
      if (c === undefined || META[c]) break;
      if (c === '\\') {
        if (s[this.i + 1] === '\n') { this.i += 2; continue; }
        if (this.i + 1 >= this.n) { lit += '\\'; this.i++; continue; }
        flush(); parts.push({ t: 'q', v: s[this.i + 1] }); this.i += 2;
      } else if (c === "'") {
        const j = s.indexOf("'", this.i + 1);
        if (j < 0) throw synErr("unexpected EOF while looking for matching `''", true);
        flush(); parts.push({ t: 'q', v: s.slice(this.i + 1, j) }); this.i = j + 1;
      } else if (c === '"') { this.i++; flush(); parts.push({ t: 'dq', parts: this.dqParts('"') }); } else if (c === '$') {
        if (s[this.i + 1] === "'") {
          let j = this.i + 2, v = '';
          for (; j < this.n && s[j] !== "'"; j++) { if (s[j] === '\\' && j + 1 < this.n) { v += s[j] + s[j + 1]; j++; } else v += s[j]; }
          if (j >= this.n) throw synErr("unexpected EOF while looking for matching `''", true);
          flush(); parts.push({ t: 'q', v: unescape(v, true).s }); this.i = j + 1;
        } else { const p = this.dollar(); if (p) { flush(); parts.push(p); } else { lit += '$'; this.i++; } }
      } else if (c === '`') { flush(); parts.push(this.backtick()); } else { lit += c; this.i++; }
    }
    flush();
    return parts.length ? { parts } : null;
  };
  // " の中（end = '"'）、ヒアドキュメントの本文（end = null, heredoc = true）
  P.dqParts = function (end, heredoc) {
    const s = this.s, parts = [];
    let lit = '';
    const flush = () => { if (lit) { parts.push({ t: 'lit', v: lit }); lit = ''; } };
    for (;;) {
      if (this.i >= this.n) { if (end) throw synErr('unexpected EOF while looking for matching `' + end + "'", true); break; }
      const c = s[this.i];
      if (c === end) { this.i++; break; }
      if (c === '\\') {
        const d = s[this.i + 1];
        if (d === '$' || d === '`' || d === '\\' || (d === '"' && !heredoc)) { flush(); parts.push({ t: 'q', v: d }); this.i += 2; } else if (d === '\n') this.i += 2; else { lit += '\\'; this.i++; }
      } else if (c === '$') { const p = this.dollar(); if (p) { flush(); parts.push(p); } else { lit += '$'; this.i++; } } else if (c === '`') { flush(); parts.push(this.backtick()); } else { lit += c; this.i++; }
    }
    flush();
    return parts;
  };
  P.backtick = function () {
    const s = this.s;
    let j = this.i + 1, src = '';
    for (; j < this.n && s[j] !== '`'; j++) { if (s[j] === '\\' && (s[j + 1] === '`' || s[j + 1] === '\\' || s[j + 1] === '$')) { src += s[j + 1]; j++; } else src += s[j]; }
    if (j >= this.n) throw synErr("unexpected EOF while looking for matching ``'", true);
    this.i = j + 1;
    return { t: 'cs', list: new Parser(src, this.aliases).program() };
  };
  P.dollar = function () {
    const s = this.s, d = s[this.i + 1];
    if (d === '(') {
      if (s[this.i + 2] === '(') {
        let depth = 0, j = this.i + 3, ok = false;
        for (; j < this.n; j++) { const ch = s[j]; if (ch === '(') depth++; else if (ch === ')') { if (depth === 0) { ok = s[j + 1] === ')'; break; } depth--; } }
        if (j >= this.n) throw synErr("unexpected EOF while looking for matching `)'", true);
        if (ok) { const expr = s.slice(this.i + 3, j); this.i = j + 2; return { t: 'arith', parts: new Parser(expr).dqParts(null, true) }; }
      }
      this.i += 2;
      const l = this.list();
      this.skipNl();
      if (s[this.i] !== ')') { if (this.i >= this.n) throw synErr("unexpected EOF while looking for matching `)'", true); throw this.unexpected(); }
      this.i++;
      return { t: 'cs', list: l };
    }
    if (d === '{') return this.braceParam();
    if (d === undefined) return null;
    if (/[A-Za-z_]/.test(d)) { const m = /[A-Za-z_][A-Za-z0-9_]*/y; m.lastIndex = this.i + 1; const r = m.exec(s); this.i += 1 + r[0].length; return { t: 'param', name: r[0] }; }
    if (/[0-9@*#?$!-]/.test(d)) { this.i += 2; return { t: 'param', name: d }; }
    return null;
  };
  P.braceParam = function () {
    const s = this.s;
    const bad = () => synErr('bad substitution');
    this.i += 2;
    let m = /#([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])\}/y; m.lastIndex = this.i;
    let r = m.exec(s);
    if (r) { this.i += r[0].length; return { t: 'param', name: r[1], op: 'len' }; }
    m = /([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])/y; m.lastIndex = this.i;
    r = m.exec(s);
    if (!r) throw bad();
    this.i += r[0].length;
    const node = { t: 'param', name: r[1] };
    if (s[this.i] === '}') { this.i++; return node; }
    m = /(:-|:=|:\?|:\+|-|=|\?|\+|%%|%|##|#|\/\/|\/|:)/y; m.lastIndex = this.i;
    r = m.exec(s);
    if (!r) throw bad();
    this.i += r[0].length; node.op = r[1];
    if (node.op === '/' || node.op === '//') { node.word = this.braceWord(true); node.rep = s[this.i - 1] === '/' ? this.braceWord(false) : { parts: [] }; } else node.word = this.braceWord(false);
    return node;
  };
  P.braceWord = function (slash) {
    const s = this.s, parts = [];
    let lit = '';
    const flush = () => { if (lit) { parts.push({ t: 'lit', v: lit }); lit = ''; } };
    for (;;) {
      if (this.i >= this.n) throw synErr("unexpected EOF while looking for matching `}'", true);
      const c = s[this.i];
      if (c === '}' || (slash && c === '/')) { this.i++; break; }
      if (c === '\\') { flush(); parts.push({ t: 'q', v: s[this.i + 1] || '' }); this.i += 2; } else if (c === "'") {
        const j = s.indexOf("'", this.i + 1);
        if (j < 0) throw synErr("unexpected EOF while looking for matching `''", true);
        flush(); parts.push({ t: 'q', v: s.slice(this.i + 1, j) }); this.i = j + 1;
      } else if (c === '"') { this.i++; flush(); parts.push({ t: 'dq', parts: this.dqParts('"') }); } else if (c === '$') { const p = this.dollar(); if (p) { flush(); parts.push(p); } else { lit += '$'; this.i++; } } else if (c === '`') { flush(); parts.push(this.backtick()); } else { lit += c; this.i++; }
    }
    flush();
    return { parts };
  };

  // ════════════════════════ 小道具：エスケープ、パターン、算術、echo / printf / test ════════════════════════
  // \n などを直す。{ s, stop }（\c で stop）
  function unescape(str, ansi) {
    let o = '';
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c !== '\\' || i + 1 >= str.length) { o += c; continue; }
      const d = str[++i];
      switch (d) {
        case 'n': o += '\n'; break; case 't': o += '\t'; break; case 'r': o += '\r'; break; case 'a': o += '\x07'; break;
        case 'b': o += '\b'; break; case 'f': o += '\f'; break; case 'v': o += '\v'; break; case 'e': case 'E': o += '\x1b'; break;
        case '\\': o += '\\'; break; case "'": o += "'"; break; case '"': o += '"'; break;
        case 'c': if (!ansi) return { s: o, stop: true }; o += '\\c'; break;
        case 'x': { const m = /^[0-9a-fA-F]{1,2}/.exec(str.slice(i + 1)); if (m) { o += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; } else o += '\\x'; break; }
        case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': {
          const m = (d === '0' && !ansi ? /^[0-7]{0,3}/ : /^[0-7]{0,2}/).exec(str.slice(i + 1)), digs = (d === '0' && !ansi ? '' : d) + m[0];
          o += String.fromCharCode(parseInt(digs || '0', 8) & 255); i += m[0].length; break;
        }
        default: o += '\\' + d;
      }
    }
    return { s: o, stop: false };
  }
  const escGlob = (s) => s.replace(/[\\*?[\]]/g, '\\$&');
  const CLASSES = { alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', cntrl: '\\x00-\\x1f\\x7f', print: ' -~', graph: '!-~' };
  // シェルのパターン → 正規表現の文字列
  function globSrc(pat) {
    let o = '';
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i];
      if (c === '\\' && i + 1 < pat.length) { o += pat[++i].replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&'); } else if (c === '*') o += '[^]*'; else if (c === '?') o += '[^]';
      else if (c === '[') {
        let j = i + 1, neg = false;
        if (pat[j] === '!' || pat[j] === '^') { neg = true; j++; }
        let cls = '', first = true, ok = false;
        for (; j < pat.length; j++) {
          const d = pat[j];
          if (d === ']' && !first) { ok = true; break; }
          first = false;
          if (d === '[' && pat[j + 1] === ':') { const e = pat.indexOf(':]', j + 2); if (e > 0 && CLASSES[pat.slice(j + 2, e)]) { cls += CLASSES[pat.slice(j + 2, e)]; j = e + 1; continue; } }
          if (d === '\\' && j + 1 < pat.length) { cls += '\\' + pat[++j]; continue; }
          cls += d === ']' || d === '[' || d === '^' ? '\\' + d : d;
        }
        if (ok) { o += '[' + (neg ? '^' : '') + cls + ']'; i = j; } else o += '\\[';
      } else o += c.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
    }
    return o;
  }
  const reCache = new Map();
  function globRe(pat) {
    let r = reCache.get(pat);
    if (!r) {
      const hi = HI.test(pat);
      try { r = { re: new RegExp('^(?:' + globSrc(hi ? dec(pat) : pat) + ')$', hi ? 'u' : ''), hi }; } catch (e) { r = { re: /^[^]^/, hi: false }; }
      if (reCache.size > 500) reCache.clear();
      reCache.set(pat, r);
    }
    return r;
  }
  function globMatch(pat, str) {
    const r = globRe(pat);
    if (r.hi) return r.re.test(dec(str));
    if (HI.test(str)) { let u = reCache.get('u:' + pat); if (!u) { try { u = new RegExp('^(?:' + globSrc(pat) + ')$', 'u'); } catch (e) { u = /^[^]^/; } reCache.set('u:' + pat, u); } return u.test(dec(str)); }
    return r.re.test(str);
  }
  const hasGlob = (s) => /[*?[]/.test(s);

  // ── 算術 $(( )) ──
  function arith(src, sh, depth) {
    const toks = [];
    const re = /\s*(0[xX][0-9a-fA-F]+|\d+#[0-9a-zA-Z@_]+|\d+|[A-Za-z_][A-Za-z0-9_]*|\*\*|<<=|>>=|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||[-+*\/%&|^]=|[-+*\/%<>&|^!~?:=(),])/y;
    let pos = 0;
    const fail = (msg, tok) => { throw { shErr: src.trim() + ': ' + msg + ' (error token is "' + (tok === undefined ? '' : tok) + '")' }; };
    while (pos < src.length) {
      re.lastIndex = pos;
      const m = re.exec(src);
      if (!m) { if (/^\s*$/.test(src.slice(pos))) break; fail('syntax error: invalid arithmetic operator', src.slice(pos).trim()); }
      toks.push(m[1]); pos = re.lastIndex;
    }
    let i = 0;
    const BIN = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '<=': 7, '>': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, '**': 11 };
    const ASSIGN = { '=': 1, '+=': 1, '-=': 1, '*=': 1, '/=': 1, '%=': 1, '<<=': 1, '>>=': 1, '&=': 1, '|=': 1, '^=': 1 };
    const isName = (t) => t !== undefined && /^[A-Za-z_]/.test(t);
    function primary() {
      const t = toks[i];
      if (t === undefined) fail('syntax error: operand expected', '');
      i++;
      if (t === '(') { const e = comma(); if (toks[i] !== ')') fail("missing `)'", toks[i]); i++; return e; }
      if (t === '+' || t === '-' || t === '!' || t === '~') return { u: t, e: unary() };
      if (t === '++' || t === '--') { const n = toks[i++]; if (!isName(n)) fail('syntax error: operand expected', n); return { pre: t, name: n }; }
      if (isName(t)) { if (toks[i] === '++' || toks[i] === '--') return { post: toks[i++], name: t }; return { name: t }; }
      if (/^\d/.test(t)) {
        if (t.indexOf('#') > 0) { const [b, d] = t.split('#'); const v = parseInt(d, +b); if (isNaN(v)) fail('value too great for base', t); return { num: v }; }
        if (/^0[xX]/.test(t)) return { num: parseInt(t, 16) };
        if (t.length > 1 && t[0] === '0') { if (/[89]/.test(t)) fail('value too great for base', t); return { num: parseInt(t, 8) }; }
        return { num: parseInt(t, 10) };
      }
      fail('syntax error: operand expected', t);
    }
    function unary() { return primary(); }
    function bin(min) {
      let l = unary();
      for (;;) {
        const t = toks[i], pr = BIN[t];
        if (!pr || pr < min) break;
        i++;
        const r = bin(t === '**' ? pr : pr + 1);
        l = { op: t, l, r };
      }
      return l;
    }
    function assign() {
      const c = bin(1);
      if (toks[i] === '?') { i++; const a = assign(); if (toks[i] !== ':') fail("`:' expected for conditional expression", toks[i]); i++; const b = assign(); return { c, a, b }; }
      if (ASSIGN[toks[i]]) { if (!c.name || c.pre || c.post) fail('attempted assignment to non-variable', toks[i]); const op = toks[i++]; return { set: c.name, op, e: assign() }; }
      return c;
    }
    function comma() { let e = assign(); while (toks[i] === ',') { i++; e = { seq: [e, assign()] }; } return e; }
    const getv = (n) => {
      const v = sh.getVar(n);
      if (v === undefined || v === '') return 0;
      if (/^\s*-?\d+\s*$/.test(v) && !/^\s*-?0\d/.test(v)) return parseInt(v, 10);
      if ((depth | 0) > 20) fail('expression recursion level exceeded', v);
      return arith(v, sh, (depth | 0) + 1);
    };
    const op2 = (op, a, b, tok) => {
      switch (op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': if (b === 0) fail('division by 0', tok); return Math.trunc(a / b);
        case '%': if (b === 0) fail('division by 0', tok); return a % b;
        case '**': if (b < 0) fail('exponent less than 0', tok); return Math.pow(a, b);
        case '<<': return a * Math.pow(2, b); case '>>': return Math.floor(a / Math.pow(2, b));
        case '&': return a & b; case '|': return a | b; case '^': return a ^ b;
        case '<': return a < b ? 1 : 0; case '<=': return a <= b ? 1 : 0; case '>': return a > b ? 1 : 0; case '>=': return a >= b ? 1 : 0;
        case '==': return a === b ? 1 : 0; case '!=': return a !== b ? 1 : 0;
      }
      return 0;
    };
    const tokOf = (e) => (e.num !== undefined ? String(e.num) : e.name || '');
    function ev(e) {
      if (e.num !== undefined) return e.num;
      if (e.u) { const v = ev(e.e); return e.u === '-' ? -v : e.u === '!' ? (v ? 0 : 1) : e.u === '~' ? ~v : v; }
      if (e.pre) { const v = getv(e.name) + (e.pre === '++' ? 1 : -1); sh.setVar(e.name, String(v)); return v; }
      if (e.post) { const v = getv(e.name); sh.setVar(e.name, String(v + (e.post === '++' ? 1 : -1))); return v; }
      if (e.name) return getv(e.name);
      if (e.set) { let v = ev(e.e); if (e.op !== '=') v = op2(e.op.slice(0, -1), getv(e.set), v, tokOf(e.e)); sh.setVar(e.set, String(v)); return v; }
      if (e.op === '&&') return ev(e.l) && ev(e.r) ? 1 : 0;
      if (e.op === '||') return ev(e.l) || ev(e.r) ? 1 : 0;
      if (e.op) { const a = ev(e.l), b = ev(e.r); return op2(e.op, a, b, tokOf(e.r)); }
      if (e.c) return ev(e.c) ? ev(e.a) : ev(e.b);
      if (e.seq) { ev(e.seq[0]); return ev(e.seq[1]); }
      return 0;
    }
    if (!toks.length) return 0;
    const tree = comma();
    if (i < toks.length) fail('syntax error in expression', toks.slice(i).join(' '));
    const v = ev(tree);
    return Object.is(v, -0) ? 0 : v;
  }

  function echo(args) {
    let i = 0, nl = true, esc = false;
    for (; i < args.length && /^-[neE]+$/.test(args[i]); i++) for (const f of args[i].slice(1)) { if (f === 'n') nl = false; else if (f === 'e') esc = true; else esc = false; }
    let s = args.slice(i).join(' ');
    if (esc) { const u = unescape(s); s = u.s; if (u.stop) nl = false; }
    return s + (nl ? '\n' : '');
  }
  function fmtNum(conv, n, flags, width, prec) {
    let s;
    const neg = n < 0;
    let a = Math.abs(n);
    if (conv === 'd' || conv === 'i' || conv === 'u') s = String(Math.trunc(a));
    else if (conv === 'x') s = Math.trunc(a).toString(16); else if (conv === 'X') s = Math.trunc(a).toString(16).toUpperCase(); else if (conv === 'o') s = Math.trunc(a).toString(8);
    else if (conv === 'f' || conv === 'F') s = a.toFixed(prec === null ? 6 : prec);
    else if (conv === 'e' || conv === 'E') { s = a.toExponential(prec === null ? 6 : prec).replace(/e([+-])(\d)$/, 'e$10$2'); if (conv === 'E') s = s.toUpperCase(); } else {
      const p = prec === null ? 6 : prec || 1, ex = a === 0 ? 0 : Math.floor(Math.log10(a));
      if (ex < -4 || ex >= p) { s = a.toExponential(p - 1).replace(/e([+-])(\d)$/, 'e$10$2'); if (flags.indexOf('#') < 0) s = s.replace(/\.?0+e/, 'e'); } else { s = a.toFixed(Math.max(0, p - 1 - ex)); if (flags.indexOf('#') < 0 && s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, ''); }
      if (conv === 'G') s = s.toUpperCase();
    }
    if (prec !== null && 'diuxXo'.indexOf(conv) >= 0) s = s.padStart(prec, '0');
    if (flags.indexOf('#') >= 0) { if (conv === 'x' && a) s = '0x' + s; else if (conv === 'X' && a) s = '0X' + s; else if (conv === 'o' && s[0] !== '0') s = '0' + s; }
    const sign = neg ? '-' : flags.indexOf('+') >= 0 ? '+' : flags.indexOf(' ') >= 0 ? ' ' : '';
    if (flags.indexOf('-') >= 0) return (sign + s).padEnd(width);
    if (flags.indexOf('0') >= 0 && (prec === null || 'diuxXo'.indexOf(conv) < 0)) return sign + s.padStart(width - sign.length, '0');
    return (sign + s).padStart(width);
  }
  // printf。{ out, err: [文], st }
  function printf(args, name) {
    if (!args.length) return { out: '', err: [(name || 'printf') + ': usage: printf format [arguments]'], st: 2 };
    const fmt = args[0], rest = args.slice(1), errs = [];
    let out = '', ai = 0, st = 0, stop = false;
    const numArg = (isFloat) => {
      if (ai >= rest.length) return 0;
      const a = rest[ai++];
      if (a === '') return 0;
      if (a[0] === "'" || a[0] === '"') return a.length > 1 ? a.charCodeAt(1) : 0;
      const v = isFloat ? Number(a) : /^[-+]?0[xX][0-9a-fA-F]+$/.test(a) ? parseInt(a, 16) : /^[-+]?0[0-7]+$/.test(a) ? parseInt(a, 8) : /^[-+]?\d+$/.test(a) ? parseInt(a, 10) : NaN;
      if (isNaN(v)) { errs.push((name || 'printf') + ': ' + a + ': invalid number'); st = 1; const m = /^[-+]?\d+/.exec(a); return m ? parseInt(m[0], 10) : 0; }
      return v;
    };
    do {
      const startAi = ai;
      for (let i = 0; i < fmt.length && !stop; i++) {
        const c = fmt[i];
        if (c === '\\') {
          let j = i + 1;
          let seq = '\\' + (fmt[j] || '');
          if (fmt[j] === 'x') { const m = /^[0-9a-fA-F]{1,2}/.exec(fmt.slice(j + 1)); if (m) { seq += m[0]; j += m[0].length; } } else if (fmt[j] >= '0' && fmt[j] <= '7') { const m = /^[0-7]{1,3}/.exec(fmt.slice(j)); seq = '\\0' + m[0]; j += m[0].length - 1; }
          const u = unescape(seq); out += u.s; if (u.stop) stop = true;
          i = j;
          continue;
        }
        if (c !== '%') { out += c; continue; }
        const m = /^%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?([a-zA-Z%])/.exec(fmt.slice(i));
        if (!m) { out += c; continue; }
        i += m[0].length - 1;
        const flags = m[1], conv = m[4];
        let width = m[2] === '*' ? numArg() : m[2] ? +m[2] : 0, prec = m[3] === undefined ? null : m[3] === '*' ? numArg() : +m[3] || 0;
        let fl = flags;
        if (width < 0) { width = -width; fl += '-'; }
        if (conv === '%') { out += '%'; continue; }
        const padS = (s) => (fl.indexOf('-') >= 0 ? s.padEnd(width) : s.padStart(width));
        if (conv === 's') { let s = ai < rest.length ? rest[ai++] : ''; if (prec !== null) s = s.slice(0, prec); out += padS(s); } else if (conv === 'b') { const u = unescape(ai < rest.length ? rest[ai++] : ''); let s = u.s; if (prec !== null) s = s.slice(0, prec); out += padS(s); if (u.stop) stop = true; } else if (conv === 'c') { const s = ai < rest.length ? rest[ai++] : ''; out += padS(s.slice(0, 1)); } else if (conv === 'q') { const s = ai < rest.length ? rest[ai++] : ''; out += padS(shQuote(s)); } else if ('diuxXo'.indexOf(conv) >= 0) out += fmtNum(conv, numArg(false), fl, width, prec);
        else if ('eEfFgG'.indexOf(conv) >= 0) out += fmtNum(conv, numArg(true), fl, width, prec);
        else { errs.push((name || 'printf') + ": `" + conv + "': invalid format character"); return { out, err: errs, st: 1 }; }
      }
      if (ai === startAi) break;
    } while (ai < rest.length && !stop);
    return { out, err: errs, st };
  }
  function shQuote(s) { if (s === '') return "''"; if (/^[A-Za-z0-9_\/.,:=@%+-]+$/.test(s)) return s; return "'" + s.replace(/'/g, "'\\''") + "'"; }

  // test / [ の式。{ st, err }
  const UNARY = 'bcdefgGhkLnOprsStuwxz';
  const BINARY = { '=': 1, '==': 1, '!=': 1, '<': 1, '>': 1, '-eq': 1, '-ne': 1, '-lt': 1, '-le': 1, '-gt': 1, '-ge': 1, '-nt': 1, '-ot': 1, '-ef': 1 };
  function* testEval(args) {
    const isU = (a) => a !== undefined && a.length === 2 && a[0] === '-' && UNARY.indexOf(a[1]) >= 0;
    const int = (a) => { if (!/^\s*[-+]?\d+\s*$/.test(a)) throw { terr: a + ': integer expression expected' }; return parseInt(a, 10); };
    function* un(op, a) {
      const c = op[1];
      if (c === 'z') return a === ''; if (c === 'n') return a !== '';
      if (c === 't') { const r = yield sys.ioctl(parseInt(a, 10) | 0, TIO.TCGETS); return !(r < 0); }
      if (c === 'r' || c === 'w' || c === 'x') return (yield sys.access(a, c === 'r' ? 4 : c === 'w' ? 2 : 1)) === 0;
      const st = c === 'h' || c === 'L' ? yield sys.lstat(a) : yield sys.stat(a);
      if (typeof st === 'number') return false;
      const t = st.mode & 0o170000;
      switch (c) {
        case 'e': return true; case 'f': return t === 0o100000; case 'd': return t === 0o040000; case 'h': case 'L': return t === 0o120000;
        case 'p': return t === 0o010000; case 'S': return t === 0o140000; case 'b': return t === 0o060000; case 'c': return t === 0o020000;
        case 's': return st.size > 0; case 'u': return !!(st.mode & 0o4000); case 'g': return !!(st.mode & 0o2000); case 'k': return !!(st.mode & 0o1000);
        case 'O': return st.uid === (yield sys.geteuid()); case 'G': return st.gid === (yield sys.getegid());
      }
      return false;
    }
    function* bi(a, op, b) {
      switch (op) {
        case '=': case '==': return a === b; case '!=': return a !== b; case '<': return a < b; case '>': return a > b;
        case '-eq': return int(a) === int(b); case '-ne': return int(a) !== int(b); case '-lt': return int(a) < int(b); case '-le': return int(a) <= int(b);
        case '-gt': return int(a) > int(b); case '-ge': return int(a) >= int(b);
      }
      const sa = yield sys.stat(a), sb = yield sys.stat(b);
      const ea = typeof sa === 'object', eb = typeof sb === 'object';
      if (op === '-nt') return ea && (!eb || sa.mtime > sb.mtime);
      if (op === '-ot') return eb && (!ea || sa.mtime < sb.mtime);
      return ea && eb && sa.dev === sb.dev && sa.ino === sb.ino;
    }
    let i = 0;
    function* primary() {
      const a = args[i];
      if (a === undefined) throw { terr: 'argument expected' };
      if (a === '!' && i + 1 < args.length) { i++; return !(yield* primary()); }
      if (a === '(' && i + 1 < args.length) { i++; const v = yield* or(); if (args[i] !== ')') throw { terr: "`)' expected" }; i++; return v; }
      if (BINARY[args[i + 1]] && i + 2 < args.length) { i += 3; return yield* bi(a, args[i - 2], args[i - 1]); }
      if (isU(a) && i + 1 < args.length) { i += 2; return yield* un(a, args[i - 1]); }
      i++;
      return a !== '';
    }
    function* and() { let v = yield* primary(); while (args[i] === '-a') { i++; const r = yield* primary(); v = v && r; } return v; }
    function* or() { let v = yield* and(); while (args[i] === '-o') { i++; const r = yield* and(); v = v || r; } return v; }
    try {
      const n = args.length;
      let v;
      if (n === 0) v = false;
      else if (n === 1) v = args[0] !== '';
      else if (n === 2) { if (args[0] === '!') v = args[1] === ''; else if (isU(args[0])) v = yield* un(args[0], args[1]); else throw { terr: args[0] + ': unary operator expected' }; } else if (n === 3 && BINARY[args[1]]) v = yield* bi(args[0], args[1], args[2]);
      else if (n === 3 && args[0] === '!') { if (isU(args[1])) v = !(yield* un(args[1], args[2])); else throw { terr: args[1] + ': unary operator expected' }; } else if (n === 3 && args[0] === '(' && args[2] === ')') v = args[1] !== '';
      else if (n === 3 && args[1] !== '-a' && args[1] !== '-o') throw { terr: args[1] + ': binary operator expected' };
      else { v = yield* or(); if (i < n) throw { terr: 'too many arguments' }; }
      return { st: v ? 0 : 1 };
    } catch (e) { if (e && e.terr) return { st: 2, err: e.terr }; throw e; }
  }

  // ── ブレース展開（bash の拡張）：a{b,c}d → abd acd、{1..3} → 1 2 3。引用も展開も含まない部分だけを見る ──
  function braceStr(str) {
    for (let i = str.indexOf('{'); i >= 0; i = str.indexOf('{', i + 1)) {
      let depth = 0, j = i, commas = [];
      for (; j < str.length; j++) {
        const ch = str[j];
        if (ch === '{') depth++; else if (ch === '}') { if (--depth === 0) break; } else if (ch === ',' && depth === 1) commas.push(j);
      }
      if (j >= str.length) continue;
      const pre = str.slice(0, i), body = str.slice(i + 1, j), post = braceStr(str.slice(j + 1));
      let alts = null;
      if (commas.length) { alts = []; let p = i + 1; for (const c of commas.concat([j])) { for (const a of braceStr(str.slice(p, c))) alts.push(a); p = c + 1; } } else {
        let m = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body);
        if (m) {
          const a = +m[1], b = +m[2], st = Math.abs(+m[3] || 1) || 1, w = (/^-?0\d/.test(m[1]) || /^-?0\d/.test(m[2])) ? Math.max(m[1].length, m[2].length) : 0;
          alts = [];
          for (let v = a, n = 0; (a <= b ? v <= b : v >= b) && n < 10000; v += a <= b ? st : -st, n++) alts.push(w ? (v < 0 ? '-' + String(-v).padStart(w - 1, '0') : String(v).padStart(w, '0')) : String(v));
        } else if ((m = /^([A-Za-z])\.\.([A-Za-z])$/.exec(body))) {
          const a = m[1].charCodeAt(0), b = m[2].charCodeAt(0);
          alts = [];
          for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? 1 : -1) alts.push(String.fromCharCode(v));
        }
      }
      if (!alts) continue;
      const out = [];
      for (const a of alts) for (const p of post) out.push(pre + a + p);
      return out;
    }
    return [str];
  }
  function braceWords(word) {
    const parts = word.parts;
    for (let k = 0; k < parts.length; k++) {
      if (parts[k].t !== 'lit' || parts[k].v.indexOf('{') < 0) continue;
      const alts = braceStr(parts[k].v);
      if (alts.length === 1 && alts[0] === parts[k].v) continue;
      const out = [];
      for (const a of alts) {
        const np = parts.slice(0, k).concat(a === '' ? [] : [{ t: 'lit', v: a }]);
        for (const rest of braceWords({ parts: parts.slice(k + 1) })) out.push({ parts: np.concat(rest.parts) });
      }
      return out.filter((w) => w.parts.length);
    }
    return [word];
  }

  // ════════════════════════ シェル本体 ════════════════════════
  const decodeStatus = (s) => ((s & 0x7f) ? 128 + (s & 0x7f) : (s >> 8) & 0xff);
  // シェルの fork：親がハンドラを登録しているシグナルは、子では最初から既定の動作に戻す（fork の直後に届いたシグナルを取りこぼさない）
  const shFork = (sh, fn) => ({ n: "clone", a: [fn, 1, Array.from(sh.caught.keys()).filter((s) => sh.traps.get(s) !== "")] });
  function Shell(c) {
    this.c = c;
    this.vars = new Map(); this.funcs = new Map(); this.aliases = new Map();
    this.pos = []; this.name0 = 'sh'; this.st = 0; this.lastBg = 0; this.pid = 0; this.ppid = 0;
    this.opt = { xtrace: false, nounset: false, noglob: false, errexit: false };
    this.interactive = false; this.jc = false; this.pgid = 0;
    this.jobs = []; this.reaped = new Map();
    this.traps = new Map(); this.pending = []; this.caught = new Map(); this.intr = false;
    this.hash = new Map(); this.line = 1; this.fdepth = 0; this.locals = []; this.csStatus = 0; this.direct = false; this.optpos = 0;
    this.parentJc = false; this.parentCaught = [];
  }
  const S = Shell.prototype;
  S.sub = function (c) {
    const s = new Shell(c);
    for (const [k, v] of this.vars) s.vars.set(k, { v: v.v, x: v.x, ro: v.ro });
    s.funcs = new Map(this.funcs); s.aliases = new Map(this.aliases); s.pos = this.pos.slice(); s.name0 = this.name0; s.st = this.st;
    s.lastBg = this.lastBg; s.pid = this.pid; s.ppid = this.ppid; s.opt = Object.assign({}, this.opt); s.hash = new Map(this.hash);
    s.line = this.line; s.fdepth = this.fdepth; s.parentJc = this.jc; s.pfxI = this.interactive || this.pfxI;
    s.parentCaught = Array.from(this.caught.keys());
    for (const [sig, cmd] of this.traps) if (cmd === '') s.traps.set(sig, '');
    return s;
  };
  S.childSetup = function* (pg) {
    if (this.parentJc) yield sys.setpgid(0, pg || 0);
    for (const sig of this.parentCaught) yield sys.sigaction(sig, 'SIG_DFL');
    this.parentCaught = [];
  };
  S.getVar = function (n) { const v = this.vars.get(n); return v ? v.v : undefined; };
  S.setVar = function (n, v, exp) {
    const o = this.vars.get(n);
    if (o) { if (o.ro) throw { shErr: n + ': readonly variable' }; o.v = v; if (exp) o.x = true; } else this.vars.set(n, { v, x: !!exp, ro: false });
    if (n === 'PATH') this.hash.clear();
  };
  S.env = function () { const e = {}; for (const [k, v] of this.vars) if (v.x) e[k] = v.v; return e; };
  S.prefix = function () { return this.interactive || this.pfxI ? 'sh: ' : this.name0 + ': line ' + this.line + ': '; };
  S.puts = function* (s) { if (s !== '') { const r = yield* this.c.writeAll(1, s); if (r < 0 && r !== -E.EPIPE) yield* this.c.writeAll(2, this.prefix() + (this.curBi ? this.curBi + ': ' : '') + 'write error: ' + strerror(r) + '\n'); return r < 0 ? 1 : 0; } return 0; };
  S.eputs = function* (s) { yield* this.c.writeAll(2, s); };
  S.emsg = function* (s) { yield* this.c.writeAll(2, this.prefix() + s + '\n'); };

  // ── 展開 ──
  S.special = function (n) {
    switch (n) {
      case '?': return String(this.st); case '$': return String(this.pid); case '!': return this.lastBg ? String(this.lastBg) : ''; case '#': return String(this.pos.length);
      case '0': return this.name0; case '-': return (this.interactive ? 'i' : '') + (this.opt.xtrace ? 'x' : '') + (this.opt.nounset ? 'u' : '') + (this.opt.errexit ? 'e' : '') + (this.opt.noglob ? 'f' : '') + 'hB';
    }
    if (/^\d+$/.test(n)) return this.pos[+n - 1];
    return this.getVar(n);
  };
  S.ifs = function () { const v = this.getVar('IFS'); return v === undefined ? ' \t\n' : v; };
  // パラメータ展開。{ list:[…] }（$@ $*）か { v: 文字列 } か { parts }（${x:-word} の word をその場で展開）
  S.param = function* (pt, dq) {
    const n = pt.name, op = pt.op;
    const isList = n === '@' || n === '*';
    let val = isList ? null : this.special(n);
    const unset = isList ? this.pos.length === 0 : val === undefined;
    const nul = unset || (isList ? this.pos.join('') === '' && this.pos.length <= 1 : val === '');
    if (!op) {
      if (isList) return { list: this.pos.slice(), star: n === '*' };
      if (unset && this.opt.nounset && n !== '?' && n !== '!') throw { shErr: n + ': unbound variable', fatal: true };
      return { v: val || '' };
    }
    if (op === 'len') { if (isList) return { v: String(this.pos.length) }; const v = val || ''; return { v: String(HI.test(v) ? Array.from(dec(v)).length : v.length) }; }
    const colon = op[0] === ':' && op.length === 2;
    const o = colon ? op[1] : op;
    if (o === '-' && op.length <= 2) { if (unset || (colon && nul)) return { parts: pt.word.parts }; return isList ? { list: this.pos.slice(), star: n === '*' } : { v: val }; }
    if (o === '+' && op.length <= 2) { if (unset || (colon && nul)) return { v: '' }; return { parts: pt.word.parts }; }
    if (o === '=' && op.length <= 2) { if (unset || (colon && nul)) { const v = yield* this.expS(pt.word.parts, false, false); this.setVar(n, v); return { v }; } return { v: val }; }
    if (o === '?' && op.length <= 2) { if (unset || (colon && nul)) { const m = yield* this.expS(pt.word.parts, false, false); throw { shErr: n + ': ' + (m || 'parameter null or not set'), fatal: true }; } return { v: val }; }
    let v = isList ? this.pos.join(' ') : val || '';
    if (op === ':') {
      const spec = yield* this.expS(pt.word.parts, false, false), ci = spec.indexOf(':');
      let off = arith(ci < 0 ? spec : spec.slice(0, ci), this);
      const u = HI.test(v) ? Array.from(dec(v)) : null, L = u ? u.length : v.length;
      if (off < 0) off = Math.max(0, L + off);
      let end = L;
      if (ci >= 0) { const len = arith(spec.slice(ci + 1), this); end = len < 0 ? L + len : off + len; }
      return { v: u ? enc(u.slice(off, Math.max(off, end)).join('')) : v.slice(off, Math.max(off, end)) };
    }
    const pat = yield* this.expS(pt.word.parts, false, true);
    const hi = HI.test(v) || HI.test(pat);
    if (hi) v = dec(v);
    const src = globSrc(hi ? dec(pat) : pat);
    let res = v;
    if (op === '#' || op === '##') { const m = new RegExp('^(?:' + src.replace(/\[\^\]\*/g, op === '#' ? '[^]*?' : '[^]*') + ')', hi ? 'u' : '').exec(v); if (m) res = v.slice(m[0].length); } else if (op === '%' || op === '%%') {
      const re = new RegExp('^(?:' + src + ')$', hi ? 'u' : '');
      if (op === '%') { for (let i = v.length; i >= 0; i--) if (re.test(v.slice(i))) { res = v.slice(0, i); break; } } else { for (let i = 0; i <= v.length; i++) if (re.test(v.slice(i))) { res = v.slice(0, i); break; } }
    } else if (op === '/' || op === '//') {
      const rep = yield* this.expS(pt.rep.parts, false, false);
      let ps = src, fl = (op === '//' ? 'g' : '') + (hi ? 'u' : '');
      if (pat[0] === '#') ps = '^' + globSrc((hi ? dec(pat) : pat).slice(1)); else if (pat[0] === '%') ps = globSrc((hi ? dec(pat) : pat).slice(1)) + '$';
      if (pat !== '') res = v.replace(new RegExp(ps, fl), () => (hi ? dec(rep) : rep));
    }
    return { v: hi ? enc(res) : res };
  };
  // 文字列への展開（分割もワイルドカードもしない）。pat = true なら引用された部分のパターン文字をエスケープ
  S.expS = function* (parts, dq, pat, assign) {
    let o = '';
    for (let i = 0; i < parts.length; i++) {
      const pt = parts[i];
      let v;
      switch (pt.t) {
        case 'lit':
          if (assign && !dq && pt.v.indexOf('~') >= 0) {
            // 代入では、先頭と : の直後の ~ を展開する（PATH=$PATH:~/bin）
            const segs = pt.v.split(':');
            for (let j = 0; j < segs.length; j++) { if (segs[j][0] === '~' && (j > 0 || i === 0) && (j < segs.length - 1 || i === parts.length - 1 || segs[j].indexOf('/') >= 0)) { const t = yield* this.tilde(segs[j]); if (t) segs[j] = t[0] + t[1]; } }
            o += segs.join(':'); break;
          }
          if (!dq && i === 0 && pt.v[0] === '~') { const t = yield* this.tilde(pt.v); if (t) { o += (pat ? escGlob(t[0]) : t[0]) + t[1]; break; } }
          o += dq && pat ? escGlob(pt.v) : pt.v; break;
        case 'q': o += pat ? escGlob(pt.v) : pt.v; break;
        case 'dq': o += yield* this.expS(pt.parts, true, pat); break;
        case 'param': {
          const r = yield* this.param(pt, dq);
          if (r.parts) { o += yield* this.expS(r.parts, dq, pat); break; }
          v = r.list ? r.list.join(r.star ? this.ifs()[0] || '' : ' ') : r.v;
          o += dq && pat ? escGlob(v) : v; break;
        }
        case 'cs': v = yield* this.cmdSubst(pt.list); o += dq && pat ? escGlob(v) : v; break;
        case 'arith': v = String(arith(yield* this.expS(pt.parts, true, false), this)); o += v; break;
      }
    }
    return o;
  };
  S.tilde = function* (lit) {
    const sl = lit.indexOf('/'), pre = sl < 0 ? lit : lit.slice(0, sl), rest = sl < 0 ? '' : lit.slice(sl);
    if (pre === '~') { const h = this.getVar('HOME'); return h === undefined ? null : [h, rest]; }
    if (pre === '~+') return [this.getVar('PWD') || '', rest];
    if (pre === '~-') return [this.getVar('OLDPWD') || '', rest];
    if (!/^~[A-Za-z_][A-Za-z0-9_-]*$/.test(pre)) return null;
    const u = (yield* this.c.passwd()).find((x) => x.name === pre.slice(1));
    return u ? [u.home, rest] : null;
  };
  S.splitInto = function (fields, val, lit) {
    const ifs = this.ifs();
    let cur = fields[fields.length - 1];
    if (ifs === '') { if (val !== '') cur.push({ s: val, q: false }); return; }
    const isWs = (c) => (c === ' ' || c === '\t' || c === '\n') && ifs.indexOf(c) >= 0;
    const n = val.length;
    let i = 0;
    while (i < n && isWs(val[i])) i++;
    if (i > 0 && cur.length) { cur = []; fields.push(cur); }
    while (i < n) {
      let j = i;
      while (j < n && ifs.indexOf(val[j]) < 0) j++;
      cur.push({ s: val.slice(i, j), q: false, e: !lit });
      if (j >= n) break;
      i = j;
      while (i < n && isWs(val[i])) i++;
      if (i < n && ifs.indexOf(val[i]) >= 0 && !isWs(val[i])) { i++; while (i < n && isWs(val[i])) i++; }
      cur = []; fields.push(cur);
    }
  };
  S.expParts = function* (parts, dq, fields, split, inWord) {
    for (let i = 0; i < parts.length; i++) {
      const pt = parts[i], cur = fields[fields.length - 1];
      switch (pt.t) {
        case 'lit':
          if (inWord && !dq && split) { this.splitInto(fields, pt.v, true); break; }
          if (!dq && i === 0 && pt.v[0] === '~' && cur.length === 0) { const t = yield* this.tilde(pt.v); if (t) { cur.push({ s: t[0], q: true }); if (t[1]) cur.push({ s: t[1], q: false }); break; } }
          cur.push({ s: pt.v, q: dq }); break;
        case 'q': cur.push({ s: pt.v, q: true }); break;
        case 'dq': if (!pt.parts.length) cur.push({ s: '', q: true }); else yield* this.expParts(pt.parts, true, fields, split); break;
        case 'param': {
          const r = yield* this.param(pt, dq);
          if (r.parts) { if (dq && !r.parts.length) cur.push({ s: '', q: true }); else yield* this.expParts(r.parts, dq, fields, split, true); break; }
          if (r.list) {
            if (dq && r.star) { cur.push({ s: r.list.join(this.ifs()[0] || ''), q: true }); break; }
            if (!split) { cur.push({ s: r.list.join(' '), q: dq }); break; }
            for (let j = 0; j < r.list.length; j++) {
              if (j > 0) fields.push([]);
              if (dq) fields[fields.length - 1].push({ s: r.list[j], q: true }); else this.splitInto(fields, r.list[j]);
            }
            break;
          }
          if (dq) cur.push({ s: r.v, q: true }); else if (split) this.splitInto(fields, r.v); else cur.push({ s: r.v, q: false });
          break;
        }
        case 'cs': { const v = yield* this.cmdSubst(pt.list); if (dq) cur.push({ s: v, q: true }); else if (split) this.splitInto(fields, v); else cur.push({ s: v, q: false }); break; }
        case 'arith': { const v = String(arith(yield* this.expS(pt.parts, true, false), this)); cur.push({ s: v, q: dq }); break; }
      }
    }
  };
  // 単語 → 引数の並び（分割とワイルドカードあり）
  S.expand = function* (word) {
    const fields = [[]];
    yield* this.expParts(word.parts, false, fields, true);
    const out = [];
    for (const f of fields) {
      if (!f.length) continue;
      let g = false, s = '';
      for (const seg of f) { if (!seg.q && hasGlob(seg.s)) g = true; s += seg.s; }
      if (g && !this.opt.noglob) {
        const m = yield* this.glob(f.map((seg) => (seg.q ? escGlob(seg.s) : seg.e ? seg.s.replace(/\\/g, '\\\\') : seg.s)).join(''));
        if (m.length) { for (const x of m) out.push(x); continue; }
      }
      out.push(s);
    }
    return out;
  };
  S.expWords = function* (words) {
    const out = [];
    for (const w0 of words) for (const w of braceWords(w0)) { const fs = yield* this.expand(w); for (const f of fs) out.push(f); }
    return out;
  };
  S.expStr = function* (word) { return yield* this.expS(word.parts, false, false); };
  S.listDir = function* (path) {
    const fd = yield sys.open(path, O.RDONLY | O.DIRECTORY);
    if (fd < 0) return null;
    const ents = yield sys.getdents(fd);
    yield sys.close(fd);
    return Array.isArray(ents) ? ents.map((e) => e.name) : null;
  };
  S.glob = function* (pat) {
    const abs = pat[0] === '/', segs = pat.split('/');
    let bases = [abs ? '/' : ''], check = false;
    for (let i = abs ? 1 : 0; i < segs.length; i++) {
      const seg = segs[i], last = i === segs.length - 1;
      if (seg === '') { if (last) { const nb = []; for (const b of bases) { const st = yield sys.stat(b); if (typeof st === 'object' && (st.mode & 0o170000) === 0o040000) nb.push(b); } bases = nb; } continue; }
      if (!hasGlob(seg.replace(/\\./g, ''))) { const lit = seg.replace(/\\(.)/g, '$1'); bases = bases.map((b) => b + lit + (last ? '' : '/')); check = true; continue; }
      const nb = [];
      for (const b of bases) {
        const names = yield* this.listDir(b === '' ? '.' : b);
        if (!names) continue;
        names.sort();
        for (const name of names) {
          if (name === '.' || name === '..') continue;
          if (name[0] === '.' && seg[0] !== '.') continue;
          if (globMatch(seg, name)) nb.push(b + name + (last ? '' : '/'));
        }
      }
      bases = nb; check = false;
      if (!bases.length) return [];
    }
    if (check) { const nb = []; for (const b of bases) { const st = yield sys.lstat(b); if (typeof st === 'object') nb.push(b); } bases = nb; }
    return bases;
  };
  S.cmdSubst = function* (list) {
    if (!list.items.length) return '';
    const pr = yield sys.pipe();
    if (!Array.isArray(pr)) throw { shErr: 'cannot make pipe for command substitution: ' + strerror(pr) };
    const self = this;
    const pid = yield shFork(self, function* (c2) {
      const sub = self.sub(c2);
      yield* sub.childSetup(self.pgid);
      yield sys.close(pr[0]);
      if (pr[1] !== 1) { yield sys.dup2(pr[1], 1); yield sys.close(pr[1]); }
      sub.direct = list.items.length === 1 && !list.items[0].async && !list.items[0].ao.rest.length && list.items[0].ao.first.cmds.length === 1 && !list.items[0].ao.first.neg;
      return yield* sub.runSub(list);
    });
    yield sys.close(pr[1]);
    if (pid < 0) { yield sys.close(pr[0]); throw { shErr: 'fork: ' + strerror(pid) }; }
    const out = yield* this.c.readAll(pr[0]);
    yield sys.close(pr[0]);
    const st = yield* this.waitFg([pid], null);
    this.csStatus = st;
    return (typeof out === 'string' ? out : '').replace(/\n+$/, '');
  };

  // ── リダイレクト ──
  S.moveFd = function* (src, tfd, saved) {
    if (saved) { const sv = yield sys.fcntl(tfd, F.DUPFD_CLOEXEC, 10); saved.push({ fd: tfd, sv }); }
    if (src !== tfd) { yield sys.dup2(src, tfd); yield sys.close(src); }
  };
  S.redirect = function* (redirs, save) {
    const saved = save ? [] : null;
    for (const r of redirs) {
      let err = null;
      const op = r.op;
      if (op === '<<' || op === '<<<') {
        const body = op === '<<' ? yield* this.expS(r.body, true, false) : (yield* this.expStr(r.word)) + '\n';
        const pr = yield sys.pipe();
        if (!Array.isArray(pr)) err = 'cannot create pipe: ' + strerror(pr);
        else { yield sys.write(pr[1], body.slice(0, 60000)); yield sys.close(pr[1]); yield* this.moveFd(pr[0], r.fd === null ? 0 : r.fd, saved); }
      } else {
        const fs = yield* this.expand(r.word);
        const target = fs.length === 1 ? fs[0] : null;
        if (target === null) err = (yield* this.expStr(r.word)) + ': ambiguous redirect';
        else if ((op === '<&' || op === '>&') && (target === '-' || /^\d+$/.test(target))) {
          const tfd = r.fd === null ? (op === '<&' ? 0 : 1) : r.fd;
          if (target === '-') { if (saved) { const sv = yield sys.fcntl(tfd, F.DUPFD_CLOEXEC, 10); saved.push({ fd: tfd, sv }); } yield sys.close(tfd); } else {
            const n = +target;
            const chk = yield sys.fcntl(n, F.GETFD);
            if (chk < 0) err = target + ': Bad file descriptor';
            else if (n !== tfd) { if (saved) { const sv = yield sys.fcntl(tfd, F.DUPFD_CLOEXEC, 10); saved.push({ fd: tfd, sv }); } yield sys.dup2(n, tfd); }
          }
        } else if (op === '<&') err = target + ': ambiguous redirect';
        else {
          const both = op === '&>' || op === '&>>' || (op === '>&' && r.fd === null);
          const fl = op === '<' ? O.RDONLY : op === '>>' || op === '&>>' ? O.WRONLY | O.CREAT | O.APPEND : op === '<>' ? O.RDWR | O.CREAT : O.WRONLY | O.CREAT | O.TRUNC;
          const fd = yield sys.open(target, fl, 0o666);
          if (fd < 0) err = target + ': ' + strerror(fd);
          else if (both) { yield* this.moveFd(fd, 1, saved); if (saved) { const sv = yield sys.fcntl(2, F.DUPFD_CLOEXEC, 10); saved.push({ fd: 2, sv }); } yield sys.dup2(1, 2); } else yield* this.moveFd(fd, r.fd === null ? (op === '<' || op === '<>' ? 0 : 1) : r.fd, saved);
        }
      }
      if (err) { if (saved) yield* this.restore(saved); yield* this.emsg(err); return null; }
    }
    return saved || [];
  };
  S.restore = function* (saved) {
    for (let i = saved.length - 1; i >= 0; i--) { const s = saved[i]; if (s.sv >= 0) { yield sys.dup2(s.sv, s.fd); yield sys.close(s.sv); } else yield sys.close(s.fd); }
    saved.length = 0;
  };

  // ── 待つ・ジョブ ──
  S.noteExit = function (pid, status) {
    this.reaped.set(pid, decodeStatus(status));
    if (this.reaped.size > 500) this.reaped.delete(this.reaped.keys().next().value);
    for (const j of this.jobs) {
      const i = j.left.indexOf(pid);
      if (i < 0) continue;
      j.left.splice(i, 1);
      if (pid === j.pids[j.pids.length - 1]) j.status = status;
      if (!j.left.length) { j.state = 'Done'; j.code = decodeStatus(j.status); }
    }
  };
  S.noteStop = function (pid, sig) { for (const j of this.jobs) if (j.left.indexOf(pid) >= 0) { j.state = 'Stopped'; j.stopSig = sig; j.notified = false; } };
  S.addJob = function (pids, pgid, text, state) {
    let id = 1;
    for (const j of this.jobs) if (j.id >= id) id = j.id + 1;
    const j = { id, pids: pids.slice(), left: pids.slice(), pgid, text, state: state || 'Running', status: 0, code: 0 };
    this.jobs.push(j);
    return j;
  };
  // 前景のプロセスたちを待つ。最後のプロセスの終了ステータスを返す
  S.waitFg = function* (pids, job) {
    const left = new Set(pids), last = pids[pids.length - 1];
    let st = 0, sigd = 0;
    while (left.size) {
      const r = yield sys.wait4(-1, this.jc ? W.UNTRACED : 0);
      if (r === -E.EINTR) continue;
      if (typeof r === 'number') break;
      if ((r.status & 0xff) === 0x7f) {
        if (left.has(r.pid)) {
          const sig = (r.status >> 8) & 0xff;
          const j = job && job.id ? job : this.addJob(pids, job ? job.pgid : pids[0], job ? job.text : '', 'Stopped');
          j.left = Array.from(left); j.state = 'Stopped'; j.stopSig = sig; j.notified = true;
          yield* this.eputs('\n' + this.jobLine(j) + '\n');
          return 128 + sig;
        }
        this.noteStop(r.pid, (r.status >> 8) & 0xff);
        continue;
      }
      this.noteExit(r.pid, r.status);
      if (left.has(r.pid)) { left.delete(r.pid); if (r.pid === last) { st = decodeStatus(r.status); sigd = r.status & 0x7f; if (r.status & 0x80) sigd |= 0x80; } }
    }
    if (job && job.id) { const i = this.jobs.indexOf(job); if (i >= 0 && !job.left.length) this.jobs.splice(i, 1); }
    if (sigd && this.interactive) {
      const s = sigd & 0x7f;
      if (s === SIG.INT) { yield* this.eputs('\n'); if (this.traps.get(SIG.INT)) this.pending.push(SIG.INT); else throw { shInt: true }; }
      if (s !== SIG.PIPE) yield* this.eputs(LNX.SIGDESC[s] + (sigd & 0x80 ? ' (core dumped)' : '') + '\n');
    }
    return st;
  };
  S.jobState = function (j) {
    if (j.state === 'Done') { const s = j.status & 0x7f; return s ? LNX.SIGDESC[s] + (j.status & 0x80 ? ' (core dumped)' : '') : j.code ? 'Exit ' + j.code : 'Done'; }
    if (j.state === 'Stopped') return 'Stopped';
    return 'Running';
  };
  S.jobLine = function (j, opt) {
    const n = this.jobs.length, idx = this.jobs.indexOf(j);
    const mark = idx === n - 1 ? '+' : idx === n - 2 ? '-' : ' ';
    return '[' + j.id + ']' + mark + '  ' + (opt === 'l' ? j.pids[0] + ' ' : '') + this.jobState(j).padEnd(24) + j.text + (j.state === 'Running' ? ' &' : '');
  };
  S.reapJobs = function* () {
    for (;;) {
      const r = yield sys.wait4(-1, W.NOHANG | (this.jc ? W.UNTRACED : 0));
      if (typeof r === 'number') break;
      if ((r.status & 0xff) === 0x7f) this.noteStop(r.pid, (r.status >> 8) & 0xff); else this.noteExit(r.pid, r.status);
    }
  };
  S.notifyDone = function* () {
    for (const j of this.jobs.slice()) if (j.state === 'Done') { if (this.interactive) yield* this.eputs(this.jobLine(j) + '\n'); this.jobs.splice(this.jobs.indexOf(j), 1); }
  };
  S.notifyJobs = function* () {
    yield* this.reapJobs();
    for (const j of this.jobs.slice()) {
      if (j.state === 'Done') { if (this.interactive) yield* this.eputs(this.jobLine(j) + '\n'); this.jobs.splice(this.jobs.indexOf(j), 1); } else if (j.state === 'Stopped' && !j.notified) { j.notified = true; if (this.interactive) yield* this.eputs(this.jobLine(j) + '\n'); }
    }
  };
  S.findJob = function (spec) {
    if (spec === undefined || spec === '%%' || spec === '%+' || spec === '%') return this.jobs[this.jobs.length - 1] || null;
    if (spec === '%-') return this.jobs[this.jobs.length - 2] || null;
    const m = /^%?(\d+)$/.exec(spec);
    if (m) return this.jobs.find((j) => j.id === +m[1]) || null;
    if (spec[0] === '%') return this.jobs.find((j) => j.text.startsWith(spec.slice(1))) || null;
    return null;
  };
  S.runTraps = function* () {
    while (this.pending.length) {
      const sig = this.pending.shift(), cmd = this.traps.get(sig);
      if (cmd) { const st = this.st; yield* this.evalStr(cmd); this.st = st; }
    }
  };

  // ── 実行 ──
  S.execList = function* (list) {
    let st = this.st;
    for (const it of list.items) {
      if (it.async) st = yield* this.execAsync(it); else {
        st = yield* this.execAndOr(it.ao, it.text);
        if (st !== 0 && this.opt.errexit && !this.noErr && !this.aoExempt) { this.st = st; throw { lnxExit: st }; }   // set -e
      }
      this.st = st;
    }
    return st;
  };
  S.execAndOr = function* (ao, text) {
    let st, last = ao.first;
    if (ao.rest.length) this.noErr = (this.noErr | 0) + 1;
    try { st = yield* this.execPipeline(ao.first, text); } finally { if (ao.rest.length) this.noErr--; }
    for (let i = 0; i < ao.rest.length; i++) {
      const r = ao.rest[i];
      this.st = st;
      if ((r.op === '&&') === (st === 0)) {
        last = r.pl;
        if (i < ao.rest.length - 1) this.noErr++;
        try { st = yield* this.execPipeline(r.pl, text); } finally { if (i < ao.rest.length - 1) this.noErr--; }
      }
    }
    // set -e で終わらない場合：&& || の途中で止まった、! で否定した
    this.aoExempt = last.neg || (ao.rest.length > 0 && last !== ao.rest[ao.rest.length - 1].pl);
    return st;
  };
  const isSimple1 = (ao) => !ao.rest.length && ao.first.cmds.length === 1 && !ao.first.neg && ao.first.cmds[0].t === 'cmd';
  S.execAsync = function* (it) {
    const self = this;
    const pid = yield shFork(self, function* (c2) {
      const sub = self.sub(c2);
      yield* sub.childSetup(0);
      if (!self.jc) { const fd = yield sys.open('/dev/null', O.RDONLY); if (fd > 0) { yield sys.dup2(fd, 0); yield sys.close(fd); } }
      sub.direct = isSimple1(it.ao);
      return yield* sub.runSub({ t: 'list', items: [{ ao: it.ao, async: false, text: it.text }] });
    });
    if (pid < 0) { yield* this.emsg('fork: ' + strerror(pid)); return 1; }
    if (this.jc) yield sys.setpgid(pid, pid);
    this.lastBg = pid;
    const j = this.addJob([pid], pid, it.text);
    if (this.interactive) yield* this.eputs('[' + j.id + '] ' + pid + '\n');
    return 0;
  };
  // 子プロセス（サブシェル）の中身。終了ステータスを返す（返ると crt が exit する）
  S.runSub = function* (list) {
    let st;
    try { st = yield* this.execList(list); } catch (e) {
      if (e && e.lnxExit !== undefined) st = e.lnxExit; else if (e && (e.brk || e.cont || e.ret !== undefined)) st = e.ret !== undefined ? e.ret : this.st; else if (e && e.shInt) st = 130; else throw e;
    }
    this.st = st;
    yield* this.exitTrap();
    return this.st;
  };
  S.exitTrap = function* () {
    const cmd = this.traps.get(0);
    if (cmd) { this.traps.delete(0); const st = this.st; try { yield* this.evalStr(cmd); } catch (e) { if (!e || e.lnxExit === undefined) throw e; this.st = e.lnxExit; return; } this.st = st; }
  };
  S.tcset = function* (pgid) { if (this.jc) yield sys.ioctl(TTYFD, TIO.TIOCSPGRP, pgid); };
  S.execPipeline = function* (pl, text) {
    if (pl.time && !pl.timing) {
      // 予約語 time：パイプライン全体の実時間と、使った CPU 時間（ユーザー / カーネル）を標準エラーに出す
      const t0 = yield sys.time(), a = yield sys.times();
      pl.timing = true;
      let st0;
      try { st0 = yield* this.execPipeline(pl, text); } finally {
        pl.timing = false;
        const el = (yield sys.time()) - t0, b = yield sys.times();
        const us = b.utime + b.cutime - a.utime - a.cutime, sy = b.stime + b.cstime - a.stime - a.cstime;
        const f = (ms) => Math.floor(ms / 60000) + 'm' + ((ms % 60000) / 1000).toFixed(3) + 's';
        yield* this.eputs(pl.time === 'posix' ? 'real ' + (el / 1000).toFixed(2) + '\nuser ' + (us / 1000).toFixed(2) + '\nsys ' + (sy / 1000).toFixed(2) + '\n' : '\nreal\t' + f(el) + '\nuser\t' + f(us) + '\nsys\t' + f(sy) + '\n');
      }
      return st0;
    }
    let st;
    const n = pl.cmds.length;
    if (n === 1) st = yield* this.execCommand(pl.cmds[0], text);
    else {
      const self = this, pids = [];
      let prev = -1, pgid = 0;
      for (let i = 0; i < n; i++) {
        let pr = null;
        if (i < n - 1) { pr = yield sys.pipe(); if (!Array.isArray(pr)) { yield* this.emsg('pipe: ' + strerror(pr)); break; } }
        const inFd = prev, outFd = pr ? pr[1] : -1, closeFd = pr ? pr[0] : -1, cmd = pl.cmds[i], pg = pgid;
        const pid = yield shFork(self, function* (c2) {
          const sub = self.sub(c2);
          yield* sub.childSetup(pg);
          if (inFd >= 0) { yield sys.dup2(inFd, 0); yield sys.close(inFd); }
          if (outFd >= 0) { yield sys.dup2(outFd, 1); yield sys.close(outFd); }
          if (closeFd >= 0) yield sys.close(closeFd);
          sub.direct = cmd.t === 'cmd';
          return yield* sub.runSub({ t: 'list', items: [{ ao: { first: { neg: false, cmds: [cmd] }, rest: [] }, async: false, text: '' }] });
        });
        if (prev >= 0) yield sys.close(prev);
        if (pr) { yield sys.close(pr[1]); prev = pr[0]; }
        if (pid < 0) { yield* this.emsg('fork: ' + strerror(pid)); if (pr) yield sys.close(pr[0]); break; }
        if (this.jc) { if (!pgid) pgid = pid; yield sys.setpgid(pid, pgid); }
        pids.push(pid);
      }
      if (pids.length) { yield* this.tcset(pgid); try { st = yield* this.waitFg(pids, { pgid, text }); } finally { yield* this.tcset(this.pgid); } } else st = 1;
      if (this.pending.length) yield* this.runTraps();
    }
    if (pl.neg) st = st ? 0 : 1;
    return st;
  };
  S.execCommand = function* (node, text) {
    try {
      switch (node.t) {
        case 'cmd': return yield* this.execSimple(node, text);
        case 'func': this.funcs.set(node.name, node.body); return 0;
        case 'sub': {
          const self = this;
          const pid = yield shFork(self, function* (c2) {
            const sub = self.sub(c2);
            yield* sub.childSetup(0);
            if ((yield* sub.redirect(node.redirs, false)) === null) return 1;
            return yield* sub.runSub(node.list);
          });
          if (pid < 0) { yield* this.emsg('fork: ' + strerror(pid)); return 1; }
          if (this.jc) { yield sys.setpgid(pid, pid); yield* this.tcset(pid); }
          try { return yield* this.waitFg([pid], { pgid: pid, text: text || '' }); } finally { yield* this.tcset(this.pgid); }
        }
      }
      let saved = null;
      if (node.redirs.length) { saved = yield* this.redirect(node.redirs, true); if (saved === null) return 1; }
      try { return yield* this.execCompound(node); } finally { if (saved) yield* this.restore(saved); }
    } catch (e) {
      if (e && e.shErr !== undefined) {
        this.line = node.line || this.line;
        yield* this.emsg(e.shErr);
        if (e.fatal && !this.interactive) throw { lnxExit: e.st || 1 };
        return e.st || 1;
      }
      throw e;
    }
  };
  S.loop = function* (body) {
    try { this.st = yield* this.execList(body); } catch (e) {
      if (e && e.brk) { if (e.brk > 1) { e.brk--; throw e; } return 'b'; }
      if (e && e.cont) { if (e.cont > 1) { e.cont--; throw e; } return 'c'; }
      throw e;
    }
    return '';
  };
  S.execCompound = function* (node) {
    switch (node.t) {
      case 'group': return yield* this.execList(node.list);
      case 'if': {
        for (const cl of node.clauses) { let cv; this.noErr = (this.noErr | 0) + 1; try { cv = yield* this.execList(cl.cond); } finally { this.noErr--; } if (cv === 0) return yield* this.execList(cl.body); }
        if (node.els) return yield* this.execList(node.els);
        return 0;
      }
      case 'while': {
        let st = 0;
        this.loops = (this.loops | 0) + 1;
        try {
          for (;;) {
            yield CPU1;
            if (this.intr) { this.intr = false; throw { shInt: true }; }
            let c; this.noErr = (this.noErr | 0) + 1; try { c = yield* this.execList(node.cond); } finally { this.noErr--; }
            if ((c === 0) === node.until) break;
            const r = yield* this.loop(node.body);
            st = this.st;
            if (r === 'b') break;
          }
        } finally { this.loops--; }
        return st;
      }
      case 'for': {
        const items = node.words ? yield* this.expWords(node.words) : this.pos.slice();
        let st = 0;
        this.loops = (this.loops | 0) + 1;
        try {
          for (const v of items) {
            yield CPU1;
            if (this.intr) { this.intr = false; throw { shInt: true }; }
            this.setVar(node.name, v);
            const r = yield* this.loop(node.body);
            st = this.st;
            if (r === 'b') break;
          }
        } finally { this.loops--; }
        return st;
      }
      case 'case': {
        const w = yield* this.expStr(node.word);
        let ft = false;
        for (const it of node.items) {
          let hit = ft;
          if (!hit) for (const pw of it.pats) { const pat = yield* this.expS(pw.parts, false, true); if (globMatch(pat, w)) { hit = true; break; } }
          if (hit) { const st = yield* this.execList(it.body); if (!it.ft) return it.body.items.length ? st : 0; ft = true; }
        }
        return 0;
      }
    }
    return 0;
  };
  S.callFunc = function* (body, argv) {
    if (this.fdepth >= 100) { yield* this.emsg(argv[0] + ': maximum function nesting level exceeded (100)'); return 1; }
    const savedPos = this.pos, savedLocals = this.locals;
    this.pos = argv.slice(1); this.locals = []; this.fdepth++;
    try { return yield* this.execCommand(body); } catch (e) { if (e && e.ret !== undefined) return e.ret; throw e; } finally {
      for (let i = this.locals.length - 1; i >= 0; i--) { const [n, o] = this.locals[i]; if (o) this.vars.set(n, o); else this.vars.delete(n); }
      this.pos = savedPos; this.locals = savedLocals; this.fdepth--;
    }
  };
  S.findCmd = function* (name, pathOverride) {
    if (name.indexOf('/') >= 0) return name;
    const h = pathOverride === undefined ? this.hash.get(name) : null;
    if (h) return h;
    const path = pathOverride === undefined ? this.getVar('PATH') : pathOverride;
    let denied = null;
    for (const d of (path === undefined ? '/usr/bin:/bin' : path).split(':')) {
      const p = (d === '' ? '.' : d) + '/' + name;
      const st = yield sys.stat(p);
      if (typeof st !== 'object' || (st.mode & 0o170000) !== 0o100000) continue;
      if (st.mode & 0o111) { if (pathOverride === undefined) this.hash.set(name, p); return p; }
      denied = p;
    }
    return denied ? { denied } : null;
  };
  // 外部コマンドを、いまのプロセスで execve する（戻ってきたらエラー。終了ステータスを返す）
  S.execve = function* (path, argv, env) {
    const r = yield sys.execve(path, argv, env);
    if (r === -E.ENOEXEC) { const r2 = yield sys.execve('/bin/sh', ['sh', path].concat(argv.slice(1)), env); yield* this.emsg(argv[0] + ': ' + strerror(r2)); return 126; }
    if (r === -E.EACCES) { const st = yield sys.stat(path); if (typeof st === 'object' && (st.mode & 0o170000) === 0o040000) { yield* this.emsg(argv[0] + ': Is a directory'); return 126; } }
    yield* this.emsg(argv[0] + ': ' + strerror(r));
    return r === -E.ENOENT ? 127 : 126;
  };
  S.execSimple = function* (node, text) {
    yield CPU1;
    if (this.intr) { this.intr = false; throw { shInt: true }; }
    if (this.pending.length) yield* this.runTraps();
    this.line = node.line;
    const direct = this.direct;
    this.direct = false;
    this.csStatus = 0;
    const argv = yield* this.expWords(node.words);
    const assigns = [];
    for (const a of node.assigns) { let v = yield* this.expS(a.word.parts, false, false, true); if (a.append) v = (this.getVar(a.name) || '') + v; assigns.push([a.name, v]); }
    if (this.opt.xtrace) yield* this.eputs('+ ' + assigns.map((a) => a[0] + '=' + shQuote(a[1])).concat(argv.map(shQuote)).join(' ') + '\n');
    if (!argv.length) {
      if (node.redirs.length) { const sv = yield* this.redirect(node.redirs, true); if (sv === null) return 1; yield* this.restore(sv); }
      for (const [n, v] of assigns) this.setVar(n, v);
      return this.csStatus;
    }
    const name = argv[0];
    const fn = this.funcs.get(name), bi = fn ? null : BUILTINS[name];
    if (fn || bi) {
      if (name === 'exec') return yield* this.biExec(node, argv, assigns);
      const saved = yield* this.redirect(node.redirs, true);
      if (saved === null) return 1;
      const old = [];
      try {
        for (const [n, v] of assigns) { const o = this.vars.get(n); old.push([n, o ? { v: o.v, x: o.x, ro: o.ro } : null]); this.setVar(n, v, true); }
        if (fn) return yield* this.callFunc(fn, argv);
        this.curBi = name;
        return yield* bi.call(this, argv, node);
      } finally {
        for (let i = old.length - 1; i >= 0; i--) { const [n, o] = old[i]; if (o) this.vars.set(n, o); else this.vars.delete(n); }
        if (saved.length) yield* this.restore(saved);
      }
    }
    const env = this.env();
    for (const [n, v] of assigns) env[n] = v;
    const pv = assigns.find((a) => a[0] === 'PATH');
    const path = yield* this.findCmd(name, pv ? pv[1] : undefined);
    if (direct) {
      if ((yield* this.redirect(node.redirs, false)) === null) throw { lnxExit: 1 };
      if (!path) { yield* this.emsg(name + ': command not found'); throw { lnxExit: 127 }; }
      if (path.denied) { yield* this.emsg(path.denied + ': Permission denied'); throw { lnxExit: 126 }; }
      throw { lnxExit: yield* this.execve(path, argv, env) };
    }
    if (!path || path.denied) {
      if (node.redirs.length) { const sv = yield* this.redirect(node.redirs, true); if (sv === null) return 1; yield* this.restore(sv); }
      if (!path) { yield* this.emsg(name + ': command not found'); return 127; }
      yield* this.emsg(path.denied + ': Permission denied'); return 126;
    }
    const self = this;
    const pid = yield shFork(self, function* (c2) {
      const sub = self.sub(c2);
      yield* sub.childSetup(0);
      if ((yield* sub.redirect(node.redirs, false)) === null) return 1;
      return yield* sub.execve(path, argv, env);
    });
    if (pid < 0) { yield* this.emsg('fork: retry: ' + strerror(pid)); return 254; }
    if (this.jc) { yield sys.setpgid(pid, pid); yield* this.tcset(pid); }
    let st;
    try { st = yield* this.waitFg([pid], { pgid: pid, text: text || argv.join(' ') }); } finally { yield* this.tcset(this.pgid); }
    if (this.pending.length) yield* this.runTraps();
    return st;
  };
  // 文字列をこのシェルで実行（eval、trap、source、スクリプト全体）
  S.evalStr = function* (src) {
    const ps = new Parser(src, this.aliases);
    let st = this.st;
    for (;;) {
      let node;
      try { node = ps.next(); } catch (e) {
        if (e && e.shSyntax) { this.line = ps.lineAt(ps.i); yield* this.emsg(e.message); this.st = 2; return 2; }
        throw e;
      }
      if (!node) break;
      if (this.opt.noexec) continue;   // sh -n：文法だけ調べる
      st = yield* this.execList(node);
    }
    return st;
  };

  // ════════════════════════ 組み込みコマンド ════════════════════════
  const BUILTINS = {};
  const B = (names, fn) => { for (const n of names.split(' ')) BUILTINS[n] = fn; };
  B(': true', function* () { return 0; });
  B('false', function* () { return 1; });
  B('echo', function* (av) { return yield* this.puts(echo(av.slice(1))); });
  B('printf', function* (av) {
    const r = printf(av.slice(1), 'printf');
    for (const e of r.err) yield* this.emsg(e);
    yield* this.puts(r.out);
    return r.st;
  });
  B('test [', function* (av) {
    let args = av.slice(1);
    if (av[0] === '[') { if (args[args.length - 1] !== ']') { yield* this.emsg("[: missing `]'"); return 2; } args = args.slice(0, -1); }
    const r = yield* testEval(args);
    if (r.err) yield* this.emsg(av[0] + ': ' + r.err);
    return r.st;
  });
  B('cd', function* (av) {
    let arg = av[1], show = false;
    if (arg === '--') arg = av[2];
    if (av.length > (av[1] === '--' ? 3 : 2)) { yield* this.emsg('cd: too many arguments'); return 1; }
    if (arg === undefined) { arg = this.getVar('HOME'); if (arg === undefined) { yield* this.emsg('cd: HOME not set'); return 1; } } else if (arg === '-') { arg = this.getVar('OLDPWD'); if (arg === undefined) { yield* this.emsg('cd: OLDPWD not set'); return 1; } show = true; }
    const pwd = this.getVar('PWD') || '/';
    const logical = U.normpath(arg[0] === '/' ? arg : pwd + '/' + arg);
    let r = yield sys.chdir(arg === '' ? '.' : arg), np = logical;
    if (r < 0) { yield* this.emsg('cd: ' + av[av.length - 1] + ': ' + strerror(r)); return 1; }
    const chk = yield sys.stat(logical), here = yield sys.stat('.');
    if (typeof chk !== 'object' || typeof here !== 'object' || chk.ino !== here.ino || chk.dev !== here.dev) { const g = yield sys.getcwd(); if (typeof g === 'string') np = g; }
    this.setVar('OLDPWD', pwd, true); this.setVar('PWD', np, true);
    if (show) yield* this.puts(np + '\n');
    return 0;
  });
  B('pwd', function* (av) {
    if (av[1] === '-P') { const g = yield sys.getcwd(); if (typeof g !== 'string') { yield* this.emsg('pwd: error retrieving current directory: ' + strerror(g)); return 1; } return yield* this.puts(g + '\n'); }
    return yield* this.puts((this.getVar('PWD') || '/') + '\n');
  });
  const validName = (n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n);
  B('export readonly', function* (av) {
    const ro = av[0] === 'readonly';
    const args = av.slice(1).filter((a) => a !== '-p' && a !== '--');
    if (!args.length) {
      let o = '';
      for (const k of Array.from(this.vars.keys()).sort()) { const v = this.vars.get(k); if (ro ? v.ro : v.x) o += (ro ? 'readonly ' : 'export ') + k + '="' + v.v.replace(/["\\$`]/g, '\\$&') + '"\n'; }
      return yield* this.puts(o);
    }
    let st = 0;
    for (const a of args) {
      const eq = a.indexOf('='), n = eq < 0 ? a : a.slice(0, eq);
      if (!validName(n)) { yield* this.emsg(av[0] + ": `" + a + "': not a valid identifier"); st = 1; continue; }
      if (eq >= 0) this.setVar(n, a.slice(eq + 1));
      let v = this.vars.get(n);
      if (!v) { if (ro) { v = { v: '', x: false, ro: false }; this.vars.set(n, v); } else { this.vars.set(n, v = { v: '', x: false, ro: false, unsetx: true }); } }
      if (ro) v.ro = true; else v.x = true;
    }
    return st;
  });
  B('local', function* (av) {
    if (!this.fdepth) { yield* this.emsg('local: can only be used in a function'); return 1; }
    for (const a of av.slice(1)) {
      const eq = a.indexOf('='), n = eq < 0 ? a : a.slice(0, eq);
      if (!validName(n)) { yield* this.emsg("local: `" + a + "': not a valid identifier"); return 1; }
      const o = this.vars.get(n);
      this.locals.push([n, o ? { v: o.v, x: o.x, ro: o.ro } : null]);
      if (eq >= 0) this.setVar(n, a.slice(eq + 1)); else if (!o) this.setVar(n, '');
    }
    return 0;
  });
  B('unset', function* (av) {
    let fn = false, st = 0;
    for (const a of av.slice(1)) {
      if (a === '-f') { fn = true; continue; } if (a === '-v') { fn = false; continue; }
      if (fn) this.funcs.delete(a); else { const v = this.vars.get(a); if (v && v.ro) { yield* this.emsg('unset: ' + a + ': cannot unset: readonly variable'); st = 1; } else if (v) { this.vars.delete(a); if (a === 'PATH') this.hash.clear(); } else this.funcs.delete(a); }
    }
    return st;
  });
  B('set', function* (av) {
    if (av.length === 1) {
      let o = '';
      for (const k of Array.from(this.vars.keys()).sort()) o += k + '=' + shQuote(this.vars.get(k).v) + '\n';
      return yield* this.puts(o);
    }
    let i = 1;
    for (; i < av.length; i++) {
      const a = av[i];
      if (a === '--') { i++; this.pos = av.slice(i); return 0; }
      if (a === '-' ) { i++; break; }
      if ((a[0] !== '-' && a[0] !== '+') || a.length < 2) break;
      const on = a[0] === '-';
      if (a[1] === 'o') { const o = av[++i]; const k = { xtrace: 'xtrace', nounset: 'nounset', noglob: 'noglob', errexit: 'errexit' }[o]; if (k) this.opt[k] = on; continue; }
      for (const f of a.slice(1)) { const k = { x: 'xtrace', u: 'nounset', f: 'noglob', e: 'errexit' }[f]; if (k) this.opt[k] = on; else if ('habmBCHvn'.indexOf(f) < 0) { yield* this.emsg('set: ' + a[0] + f + ': invalid option'); return 2; } }
    }
    if (i < av.length) this.pos = av.slice(i);
    return 0;
  });
  B('shift', function* (av) {
    const n = av[1] === undefined ? 1 : parseInt(av[1], 10);
    if (isNaN(n) || n < 0) { yield* this.emsg('shift: ' + av[1] + ': numeric argument required'); return 1; }
    if (n > this.pos.length) return 1;
    this.pos = this.pos.slice(n);
    return 0;
  });
  const numArg = function* (sh, av, dflt) {
    if (av[1] === undefined) return dflt;
    if (!/^[-+]?\d+$/.test(av[1])) { yield* sh.emsg(av[0] + ': ' + av[1] + ': numeric argument required'); return 2; }
    return parseInt(av[1], 10);
  };
  B('exit', function* (av) { const n = yield* numArg(this, av, this.st); throw { lnxExit: n & 255 }; });
  B('return', function* (av) {
    if (!this.fdepth && !this.srcDepth) { yield* this.emsg("return: can only `return' from a function or sourced script"); return 1; }
    const n = yield* numArg(this, av, this.st); throw { ret: n & 255 };
  });
  B('break continue', function* (av) {
    const n = yield* numArg(this, av, 1);
    if (!this.loops) { yield* this.emsg(av[0] + ": only meaningful in a `for', `while', or `until' loop"); return 0; }
    if (n < 1) { yield* this.emsg(av[0] + ': ' + av[1] + ': loop count out of range'); return 1; }
    throw av[0] === 'break' ? { brk: n } : { cont: n };
  });
  B('eval', function* (av) { return av.length > 1 ? yield* this.evalStr(av.slice(1).join(' ')) : 0; });
  B('source .', function* (av) {
    if (av.length < 2) { yield* this.emsg(av[0] + ': filename argument required'); return 2; }
    let path = av[1];
    if (path.indexOf('/') < 0) { for (const d of (this.getVar('PATH') || '').split(':')) { const p = (d || '.') + '/' + path; const st = yield sys.stat(p); if (typeof st === 'object' && (st.mode & 0o170000) === 0o100000) { path = p; break; } } }
    const src = yield* this.c.slurp(path);
    if (typeof src === 'number') { yield* this.emsg(av[1] + ': ' + strerror(src)); return 1; }
    const savedPos = this.pos;
    if (av.length > 2) this.pos = av.slice(2);
    this.srcDepth = (this.srcDepth | 0) + 1;
    try { return yield* this.evalStr(src); } catch (e) { if (e && e.ret !== undefined) return e.ret; throw e; } finally { this.srcDepth--; if (av.length > 2) this.pos = savedPos; }
  });
  S.biExec = function* (node, argv, assigns) {
    if ((yield* this.redirect(node.redirs, false)) === null) { if (!this.interactive) throw { lnxExit: 1 }; return 1; }
    if (argv.length === 1) return 0;
    const env = this.env();
    for (const [n, v] of assigns) env[n] = v;
    const path = yield* this.findCmd(argv[1]);
    let st;
    if (!path) { yield* this.emsg('exec: ' + argv[1] + ': not found'); st = 127; } else if (path.denied) { yield* this.emsg(path.denied + ': Permission denied'); st = 126; } else st = yield* this.execve(path, argv.slice(1), env);
    if (!this.interactive) throw { lnxExit: st };
    return st;
  };
  B('exec', function* () { return 0; });
  B('read', function* (av) {
    let raw = false, i = 1, prompt = '';
    for (; i < av.length && av[i][0] === '-' && av[i].length > 1; i++) { if (av[i] === '-r') raw = true; else if (av[i] === '-p') prompt = av[++i] || ''; else if (av[i] === '--') { i++; break; } else { yield* this.emsg('read: ' + av[i] + ': invalid option'); return 2; } }
    const names = av.slice(i);
    for (const n of names) if (!validName(n)) { yield* this.emsg("read: `" + n + "': not a valid identifier"); return 1; }
    if (prompt && !((yield sys.ioctl(0, TIO.TCGETS)) < 0)) yield* this.eputs(prompt);
    let line = '', eof = false;
    for (;;) {
      const r = yield sys.read(0, 1);
      if (r === -E.EINTR) { if (this.pending.length) yield* this.runTraps(); continue; }
      if (typeof r === 'number' || r === '') { eof = true; break; }
      if (r === '\n') break;
      if (r === '\\' && !raw) { const r2 = yield sys.read(0, 1); if (typeof r2 === 'number' || r2 === '') { eof = true; break; } if (r2 !== '\n') line += '\\' + r2; continue; }
      line += r;
    }
    const ifs = this.ifs(), ws = (c) => (c === ' ' || c === '\t' || c === '\n') && ifs.indexOf(c) >= 0;
    const un = (s) => (raw ? s : s.replace(/\\(.)/g, '$1'));
    if (!names.length) { this.setVar('REPLY', un(line)); return eof ? 1 : 0; }
    let p = 0;
    const n = line.length;
    while (p < n && ws(line[p])) p++;
    for (let k = 0; k < names.length; k++) {
      if (k === names.length - 1) { let e = n; while (e > p && ws(line[e - 1]) && (raw || line[e - 2] !== '\\')) e--; this.setVar(names[k], un(line.slice(p, e))); break; }
      let j = p;
      while (j < n && ifs.indexOf(line[j]) < 0) { if (line[j] === '\\' && !raw) j++; j++; }
      this.setVar(names[k], un(line.slice(p, j)));
      p = j;
      while (p < n && ws(line[p])) p++;
      if (p < n && ifs.indexOf(line[p]) >= 0 && !ws(line[p])) { p++; while (p < n && ws(line[p])) p++; }
    }
    return eof ? 1 : 0;
  });
  S.typeOf = function* (n) {
    if (this.aliases.has(n)) return ['alias', n + " is aliased to `" + this.aliases.get(n) + "'"];
    if (KEYWORDS.indexOf(n) >= 0 || n === 'time') return ['keyword', n + ' is a shell keyword'];
    if (this.funcs.has(n)) return ['function', n + ' is a function'];
    if (BUILTINS[n]) return ['builtin', n + ' is a shell builtin'];
    const p = yield* this.findCmd(n);
    if (typeof p === 'string') { if (n.indexOf('/') >= 0) { const r = yield sys.access(n, 1); if (r < 0) return null; } return ['file', n + ' is ' + p, p]; }
    return null;
  };
  B('type', function* (av) {
    let st = 0;
    for (const n of av.slice(1)) { const t = yield* this.typeOf(n); if (t) yield* this.puts(t[1] + '\n'); else { yield* this.emsg('type: ' + n + ': not found'); st = 1; } }
    return st;
  });
  B('command', function* (av, node) {
    if (av[1] === '-v' || av[1] === '-V') {
      let st = 0;
      for (const n of av.slice(2)) { const t = yield* this.typeOf(n); if (!t) { st = 1; continue; } yield* this.puts((av[1] === '-V' ? t[1] : t[0] === 'file' ? t[2] : t[0] === 'alias' ? 'alias ' + n + "='" + this.aliases.get(n) + "'" : n) + '\n'); }
      return st;
    }
    const args = av.slice(av[1] === '--' || av[1] === '-p' ? 2 : 1);
    if (!args.length) return 0;
    if (BUILTINS[args[0]]) return yield* BUILTINS[args[0]].call(this, args, node);
    const path = yield* this.findCmd(args[0]);
    if (!path) { yield* this.emsg(args[0] + ': command not found'); return 127; }
    if (path.denied) { yield* this.emsg(path.denied + ': Permission denied'); return 126; }
    const self = this, env = this.env();
    const pid = yield shFork(self, function* (c2) { const sub = self.sub(c2); yield* sub.childSetup(0); return yield* sub.execve(path, args, env); });
    if (pid < 0) return 254;
    if (this.jc) { yield sys.setpgid(pid, pid); yield* this.tcset(pid); }
    try { return yield* this.waitFg([pid], { pgid: pid, text: args.join(' ') }); } finally { yield* this.tcset(this.pgid); }
  });
  B('builtin', function* (av, node) { if (av.length < 2) return 0; const b = BUILTINS[av[1]]; if (!b) { yield* this.emsg('builtin: ' + av[1] + ': not a shell builtin'); return 1; } return yield* b.call(this, av.slice(1), node); });
  B('alias', function* (av) {
    if (av.length === 1) { let o = ''; for (const k of Array.from(this.aliases.keys()).sort()) o += 'alias ' + k + "='" + this.aliases.get(k).replace(/'/g, "'\\''") + "'\n"; return yield* this.puts(o); }
    let st = 0;
    for (const a of av.slice(1)) {
      const eq = a.indexOf('=');
      if (eq > 0) this.aliases.set(a.slice(0, eq), a.slice(eq + 1));
      else if (this.aliases.has(a)) yield* this.puts('alias ' + a + "='" + this.aliases.get(a) + "'\n"); else { yield* this.emsg('alias: ' + a + ': not found'); st = 1; }
    }
    return st;
  });
  B('unalias', function* (av) { let st = 0; for (const a of av.slice(1)) { if (a === '-a') this.aliases.clear(); else if (!this.aliases.delete(a)) { yield* this.emsg('unalias: ' + a + ': not found'); st = 1; } } return st; });
  B('umask', function* (av) {
    const cur = yield sys.umask(0o022);
    if (av.length === 1 || av[1] === '-S') {
      yield sys.umask(cur);
      if (av[1] === '-S') { const f = (b) => (b & 4 ? '' : 'r') + (b & 2 ? '' : 'w') + (b & 1 ? '' : 'x'); return yield* this.puts('u=' + f(cur >> 6) + ',g=' + f((cur >> 3) & 7) + ',o=' + f(cur & 7) + '\n'); }
      return yield* this.puts(U.oct(cur, 4) + '\n');
    }
    if (!/^[0-7]{1,4}$/.test(av[1])) { yield sys.umask(cur); yield* this.emsg('umask: ' + av[1] + ': octal number out of range'); return 1; }
    yield sys.umask(parseInt(av[1], 8));
    return 0;
  });
  B('hash', function* (av) { if (av[1] === '-r') this.hash.clear(); return 0; });
  B('getopts', function* (av) {
    if (av.length < 3) { yield* this.emsg('getopts: usage: getopts optstring name [arg ...]'); return 2; }
    const spec = av[1], name = av[2], args = av.length > 3 ? av.slice(3) : this.pos;
    let ind = parseInt(this.getVar('OPTIND') || '1', 10) || 1;
    if (ind !== this.optind) this.optpos = 0;
    const silent = spec[0] === ':';
    const done = () => { this.setVar(name, '?'); this.setVar('OPTIND', String(ind)); this.optind = ind; return 1; };
    const a = args[ind - 1];
    if (a === undefined || a[0] !== '-' || a === '-') return done();
    if (a === '--') { ind++; return done(); }
    const pos = this.optpos || 1, ch = a[pos], si = spec.indexOf(ch);
    const adv = () => { if (pos + 1 < a.length) this.optpos = pos + 1; else { this.optpos = 0; ind++; } };
    this.vars.delete('OPTARG');
    if (si < 0 || ch === ':') {
      adv(); this.setVar(name, '?');
      if (silent) this.setVar('OPTARG', ch); else yield* this.emsg('illegal option -- ' + ch);
    } else if (spec[si + 1] === ':') {
      this.optpos = 0;
      if (pos + 1 < a.length) { this.setVar('OPTARG', a.slice(pos + 1)); ind++; this.setVar(name, ch); } else if (args[ind] !== undefined) { this.setVar('OPTARG', args[ind]); ind += 2; this.setVar(name, ch); } else {
        ind++;
        if (silent) { this.setVar(name, ':'); this.setVar('OPTARG', ch); } else { this.setVar(name, '?'); yield* this.emsg('option requires an argument -- ' + ch); }
      }
    } else { adv(); this.setVar(name, ch); }
    this.setVar('OPTIND', String(ind)); this.optind = ind;
    return 0;
  });
  // ── ジョブとシグナル ──
  const sigNum = (s) => { if (/^\d+$/.test(s)) return +s; const n = SIG[s.toUpperCase().replace(/^SIG/, '')]; return n === undefined ? (s.toUpperCase() === 'EXIT' ? 0 : -1) : n; };
  B('jobs', function* (av) {
    yield* this.reapJobs();
    let o = '';
    for (const j of this.jobs.slice()) {
      if (av[1] === '-p') o += j.pgid + '\n'; else o += this.jobLine(j, av[1] === '-l' ? 'l' : '') + '\n';
      if (j.state === 'Done') this.jobs.splice(this.jobs.indexOf(j), 1); else j.notified = true;
    }
    return yield* this.puts(o);
  });
  B('fg bg', function* (av) {
    if (!this.jc) { yield* this.emsg(av[0] + ': no job control'); return 1; }
    yield* this.reapJobs();
    const j = this.findJob(av[1]);
    if (!j || j.state === 'Done') { yield* this.emsg(av[0] + ': ' + (av[1] || 'current') + ': no such job'); return 1; }
    if (av[0] === 'bg') {
      if (j.state === 'Running') { yield* this.emsg('bg: job ' + j.id + ' already in background'); return 0; }
      j.state = 'Running';
      yield* this.eputs('[' + j.id + ']+ ' + j.text + ' &\n');
      yield sys.kill(-j.pgid, SIG.CONT);
      return 0;
    }
    yield* this.puts(j.text + '\n');
    j.state = 'Running';
    yield* this.tcset(j.pgid);
    yield sys.kill(-j.pgid, SIG.CONT);
    try { return yield* this.waitFg(j.left.slice(), j); } finally { yield* this.tcset(this.pgid); }
  });
  B('wait', function* (av) {
    const args = av.slice(1);
    if (!args.length) {
      for (;;) {
        if (!this.jobs.some((j) => j.state === 'Running')) break;
        const r = yield sys.wait4(-1, this.jc ? W.UNTRACED : 0);
        if (r === -E.EINTR) { if (this.pending.length) { const sig = this.pending[0]; yield* this.runTraps(); return 128 + sig; } continue; }
        if (typeof r === 'number') break;
        if ((r.status & 0xff) === 0x7f) this.noteStop(r.pid, (r.status >> 8) & 0xff); else this.noteExit(r.pid, r.status);
      }
      yield* this.notifyDone();
      return 0;
    }
    let st = 0;
    for (const a of args) {
      let pid;
      if (a[0] === '%') { const j = this.findJob(a); if (!j) { yield* this.emsg('wait: ' + a + ': no such job'); st = 127; continue; } pid = j.pids[j.pids.length - 1]; } else if (/^\d+$/.test(a)) pid = +a; else { yield* this.emsg("wait: `" + a + "': not a pid or valid job spec"); st = 2; continue; }
      for (;;) {
        if (this.reaped.has(pid)) { st = this.reaped.get(pid); break; }
        const r = yield sys.wait4(pid, this.jc ? W.UNTRACED : 0);
        if (r === -E.EINTR) { if (this.pending.length) { const sig = this.pending[0]; yield* this.runTraps(); return 128 + sig; } continue; }
        if (typeof r === 'number') { yield* this.emsg('wait: pid ' + pid + ' is not a child of this shell'); st = 127; break; }
        if ((r.status & 0xff) === 0x7f) { this.noteStop(r.pid, (r.status >> 8) & 0xff); st = 128 + ((r.status >> 8) & 0xff); break; }
        this.noteExit(r.pid, r.status);
      }
      yield* this.notifyDone();
    }
    return st;
  });
  B('kill', function* (av) {
    let i = 1, sig = SIG.TERM;
    if (av[1] === '-l' || av[1] === '-L') {
      if (av[2] !== undefined) { const n = +av[2]; const v = isNaN(n) ? sigNum(av[2]) : SIGNAME[n > 128 ? n - 128 : n]; if (v === undefined || v < 0) { yield* this.emsg('kill: ' + av[2] + ': invalid signal specification'); return 1; } return yield* this.puts(v + '\n'); }
      let o = '';
      for (let s = 1; s <= 31; s++) o += String(s).padStart(2) + ') SIG' + SIGNAME[s] + (s % 5 === 0 || s === 31 ? '\n' : '\t');
      return yield* this.puts(o);
    }
    if (av[1] === '-s' || av[1] === '-n') { sig = sigNum(av[2] || ''); i = 3; } else if (av[1] && av[1][0] === '-' && av[1] !== '--') { sig = sigNum(av[1].slice(1)); i = 2; }
    if (av[i] === '--') i++;
    if (sig < 0) { yield* this.emsg('kill: ' + (av[i - 1] || '').replace(/^-/, '') + ': invalid signal specification'); return 1; }
    if (i >= av.length) { yield* this.emsg('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]'); return 2; }
    let st = 0;
    for (; i < av.length; i++) {
      const a = av[i];
      let r;
      if (a[0] === '%') {
        const j = this.findJob(a);
        if (!j) { yield* this.emsg('kill: ' + a + ': no such job'); st = 1; continue; }
        if (this.jc) r = yield sys.kill(-j.pgid, sig); else for (const p of j.left) r = yield sys.kill(p, sig);
        if (this.jc && j.state === 'Stopped' && sig !== SIG.CONT && sig !== SIG.STOP && sig !== SIG.TSTP) yield sys.kill(-j.pgid, SIG.CONT);
        if (sig === SIG.CONT && j.state === 'Stopped') j.state = 'Running';
      } else if (/^-?\d+$/.test(a)) r = yield sys.kill(+a, sig); else { yield* this.emsg('kill: ' + a + ': arguments must be process or job IDs'); st = 1; continue; }
      if (r < 0) { yield* this.emsg('kill: (' + a + ') - ' + strerror(r)); st = 1; }
    }
    return st;
  });
  B('trap', function* (av) {
    let args = av.slice(1);
    if (args[0] === '--') args = args.slice(1);
    if (!args.length || args[0] === '-p') {
      let o = '';
      for (const [s, cmd] of this.traps) o += "trap -- '" + cmd.replace(/'/g, "'\\''") + "' " + (s === 0 ? 'EXIT' : 'SIG' + SIGNAME[s]) + '\n';
      return yield* this.puts(o);
    }
    if (args[0] === '-l') return yield* BUILTINS.kill.call(this, ['kill', '-l']);
    let action = args[0], sigs = args.slice(1);
    if (/^\d+$/.test(action) || (args.length === 1)) { sigs = args; action = '-'; }
    let st = 0;
    for (const sname of sigs) {
      const sig = sigNum(sname);
      if (sig < 0 || sig > 31) { yield* this.emsg('trap: ' + sname + ': invalid signal specification'); st = 1; continue; }
      if (action === '-') {
        this.traps.delete(sig);
        if (sig) { this.caught.delete(sig); if (this.interactive && sig === SIG.INT) { yield* this.installInt(); } else if (this.interactive && (sig === SIG.TERM || sig === SIG.TSTP)) { yield sys.sigaction(sig, 'SIG_IGN'); this.caught.set(sig, 'i'); } else yield sys.sigaction(sig, 'SIG_DFL'); }
        continue;
      }
      this.traps.set(sig, action);
      if (sig === 0 || sig === SIG.KILL || sig === SIG.STOP) continue;
      if (action === '') { yield sys.sigaction(sig, 'SIG_IGN'); this.caught.delete(sig); } else {
        const self = this;
        yield sys.sigaction(sig, (s) => { self.pending.push(s); }, { restart: false });
        this.caught.set(sig, 'h');
      }
    }
    return st;
  });
  S.installInt = function* () {
    const self = this;
    yield sys.sigaction(SIG.INT, () => { self.intr = true; }, { restart: false });
    this.caught.set(SIG.INT, 'h');
  };

  // ════════════════════════ /usr/bin/sh ════════════════════════
  function* shMain(c) {
    const sh = new Shell(c), av = c.argv;
    for (const k in c.env) if (validName(k)) sh.vars.set(k, { v: c.env[k], x: true, ro: false });
    sh.pid = yield sys.getpid();
    sh.ppid = yield sys.getppid();
    sh.vars.set('PPID', { v: String(sh.ppid), x: false, ro: false });
    if (sh.getVar('IFS') === undefined) sh.vars.set('IFS', { v: ' \t\n', x: false, ro: false });
    sh.vars.set('OPTIND', { v: '1', x: false, ro: false });
    if (sh.getVar('PWD') === undefined) { const g = yield sys.getcwd(); sh.setVar('PWD', typeof g === 'string' ? g : '/', true); }
    const finish = function* (st) { sh.st = st; yield* sh.exitTrap(); return sh.st; };
    const run = function* (src) {
      try { return yield* sh.evalStr(src); } catch (e) {
        if (e && e.lnxExit !== undefined) return e.lnxExit;
        if (e && (e.brk || e.cont)) return sh.st;
        if (e && e.ret !== undefined) return e.ret;
        throw e;
      }
    };
    // ── ログインシェル（機械の run が 1 行ずつ渡してくる）──
    if (av[0][0] === '-') {
      sh.interactive = true; sh.jc = true; sh.pgid = sh.pid; sh.name0 = '-sh';
      yield sys.fcntl(0, F.DUPFD_CLOEXEC, TTYFD);
      yield* sh.installInt();
      yield sys.sigaction(SIG.TERM, 'SIG_IGN'); sh.caught.set(SIG.TERM, 'i');
      yield sys.sigaction(SIG.TSTP, 'SIG_IGN'); sh.caught.set(SIG.TSTP, 'i');
      sh.name0 = 'sh';
      const prof = (sh.getVar('HOME') || '') + '/.profile';
      if (typeof (yield sys.stat(prof)) === 'object') { try { yield* BUILTINS.source.call(sh, ['.', prof]); } catch (e) { if (!e || (e.lnxExit === undefined && !e.shInt)) throw e; } }
      let st = 0;
      for (;;) {
        const job = yield sys._prompt(st);
        sh.intr = false; sh.pending.length = 0;
        if (job.opts && job.opts.xtrace) sh.opt.xtrace = true;
        try { st = yield* sh.evalStr(job.src); } catch (e) {
          if (e && e.lnxExit !== undefined) { sh.st = e.lnxExit; yield* sh.exitTrap(); yield* sh.eputs('logout\n'); return sh.st; }
          if (e && e.shInt) st = 130;
          else if (e && e.lnxAbort) {
            st = 130; sh.loops = 0; sh.fdepth = 0; sh.direct = false;
            yield* sh.tcset(sh.pgid);
            yield* sh.reapJobs();
          } else if (e && (e.brk || e.cont || e.ret !== undefined)) st = sh.st;
          else throw e;
        }
        if (job.opts && job.opts.xtrace) sh.opt.xtrace = false;
        sh.st = st;
        yield* sh.notifyJobs();
      }
    }
    let i = 1;
    for (; i < av.length && /^[-+][a-zA-Z]+$/.test(av[i]) && av[i] !== '-c'; i++) {
      if (av[i] === '-s' || av[i] === '-i' || av[i] === '-l') continue;
      for (const f of av[i].slice(1)) { const k = { x: 'xtrace', u: 'nounset', f: 'noglob', e: 'errexit', n: 'noexec' }[f]; if (k) sh.opt[k] = av[i][0] === '-'; }
    }
    if (av[i] === '-c') {
      if (av[i + 1] === undefined) { yield* sh.eputs('sh: -c: option requires an argument\n'); return 2; }
      if (av[i + 2] !== undefined) sh.name0 = av[i + 2];
      sh.pos = av.slice(i + 3);
      return yield* finish(yield* run(av[i + 1]));
    }
    if (av[i] !== undefined) {
      const src = yield* c.slurp(av[i]);
      if (typeof src === 'number') { yield* sh.eputs('sh: ' + av[i] + ': ' + strerror(src) + '\n'); return src === -E.ENOENT ? 127 : 126; }
      sh.name0 = av[i]; sh.pos = av.slice(i + 1);
      return yield* finish(yield* run(src.startsWith('#!') ? src.replace(/^[^\n]*/, '') : src));
    }
    // 標準入力から 1 行ずつ読んで実行する
    const tty = !((yield sys.ioctl(0, TIO.TCGETS)) < 0);
    sh.interactive = tty;
    if (tty) yield* sh.installInt();
    const euid = yield sys.geteuid();
    let buf = '', st = 0, eof = false;
    for (;;) {
      if (tty) yield* sh.eputs(buf ? '> ' : euid === 0 ? '# ' : '$ ');
      let line = '';
      for (;;) {
        const r = yield sys.read(0, 1);
        if (r === -E.EINTR) continue;
        if (typeof r === 'number' || r === '') { eof = true; break; }
        line += r;
        if (r === '\n') break;
      }
      buf += line;
      if (buf !== '') {
        let complete = true;
        if (!eof) { try { const pp = new Parser(buf, sh.aliases); pp.program(); if (pp.hdOpen || pp.heredocs.length) complete = false; } catch (e) { if (e && e.shSyntax && e.eof) complete = false; } }
        if (complete) {
          const src = buf; buf = '';
          sh.intr = false;
          try { st = yield* sh.evalStr(src); } catch (e) {
            if (e && e.lnxExit !== undefined) { if (tty) yield* sh.eputs('exit\n'); return yield* finish(e.lnxExit); }
            if (e && e.shInt) st = 130; else if (e && (e.brk || e.cont || e.ret !== undefined)) st = sh.st; else throw e;
          }
          sh.st = st;
        }
      }
      if (eof) break;
    }
    if (tty) yield* sh.eputs('exit\n');
    return yield* finish(st);
  }

  LNX.bin.sh = { main: shMain, help: 'シェル。コマンドを読んで実行する', usage: 'sh [-x] [-c コマンド | スクリプト [引数…]]' };
  LNX.sh = {
    Parser, Shell, arith, globRe, globMatch, globSrc, echo, printf, testEval, unescape, shQuote, KEYWORDS,
    builtins: Object.keys(BUILTINS).sort(),
    // 構文の検査（画面で「続きの行を待つ」かどうかを決める用）。{ ok, incomplete, error }
    parse(src) {
      try {
        const pp = new Parser(enc(src)); pp.program();
        if (pp.hdOpen || pp.heredocs.length) return { ok: false, incomplete: true, error: 'here-document が閉じていません' };
        return { ok: true, incomplete: false, error: '' };
      } catch (e) {
        if (e && e.shSyntax) return { ok: false, incomplete: !!e.eof, error: e.message };
        throw e;
      }
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
