// Cloud Shell の小さなシェル：変数、引用符、$( )、パイプ、&& || ;、ヒアドキュメント、for、リダイレクト、手元のファイル。
// コマンドは GCP.CMDS[名前] = async (sh, args, io) => 終了ステータス。io = { stdin, out(s), err(s) }
//
//   GCP.sh.parse(src) → { list, incomplete }   incomplete：引用符や for が閉じていない（次の行とつなげる）
//   GCP.sh.run(sys, src, io) → 終了ステータス
(function (root) {
  'use strict';
  const G = root.GCP = root.GCP || {};
  G.CMDS = G.CMDS || {};
  const C = G.CMDS;

  // ---------------------------------------------------------------- 字句
  // 単語は「部分」の並び：{ q: 0|1|2（なし・'・"）, t: 文字列 } または { sub: ソース }（$( )） または { v: 名前 }
  function lex(src) {
    const toks = [];
    let i = 0;
    const n = src.length;
    let word = null;
    const push = (part) => {
      if (!word) word = { parts: [] };
      const last = word.parts[word.parts.length - 1];
      if (last && part.t !== undefined && last.t !== undefined && last.q === part.q && part.q === 0) last.t += part.t;
      else word.parts.push(part);
    };
    const endWord = () => { if (word) { toks.push({ w: word }); word = null; } };
    const heredocs = [];
    while (i < n) {
      const c = src[i];
      if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
      if (c === ' ' || c === '\t') { endWord(); i++; continue; }
      if (c === '\n') {
        endWord(); toks.push({ op: '\n' }); i++;
        // ヒアドキュメントの本文を読む
        while (heredocs.length) {
          const h = heredocs.shift();
          const lines = [];
          let found = false;
          while (i < n) {
            let e = src.indexOf('\n', i); if (e < 0) e = n;
            let line = src.slice(i, e);
            i = e + 1;
            if (h.strip) line = line.replace(/^\t+/, '');
            if (line === h.delim) { found = true; break; }
            lines.push(line);
          }
          if (!found) return { incomplete: true };
          h.tok.body = lines.join('\n') + (lines.length ? '\n' : '');
        }
        continue;
      }
      if (c === '#' && !word) { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === "'") {
        const e = src.indexOf("'", i + 1);
        if (e < 0) return { incomplete: true };
        push({ q: 1, t: src.slice(i + 1, e) }); i = e + 1; continue;
      }
      if (c === '"') {
        i++;
        let buf = '';
        let closed = false;
        while (i < n) {
          const d = src[i];
          if (d === '"') { closed = true; i++; break; }
          if (d === '\\' && /["\\$`\n]/.test(src[i + 1])) { if (src[i + 1] !== '\n') buf += src[i + 1]; i += 2; continue; }
          if (d === '$') {
            const r = dollar(src, i);
            if (r === null) return { incomplete: true };
            if (r) { if (buf) push({ q: 2, t: buf }); buf = ''; r.part.q = 2; push(r.part); i = r.end; continue; }
          }
          buf += d; i++;
        }
        if (!closed) return { incomplete: true };
        push({ q: 2, t: buf });
        continue;
      }
      if (c === '$') {
        const r = dollar(src, i);
        if (r === null) return { incomplete: true };
        if (r) { push(r.part); i = r.end; continue; }
      }
      if (c === '\\') { push({ q: 1, t: src[i + 1] || '' }); i += 2; continue; }
      // 演算子
      const two = src.slice(i, i + 2), three = src.slice(i, i + 3);
      if (three === '<<-' || two === '<<') {
        endWord();
        const strip = three === '<<-';
        i += strip ? 3 : 2;
        while (src[i] === ' ') i++;
        let m = src.slice(i).match(/^(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
        if (!m) return { error: 'syntax error near unexpected token `newline\'' };
        const tok = { op: '<<', quoted: !!m[1], body: '' };
        heredocs.push({ delim: m[2], strip, tok });
        toks.push(tok);
        i += m[0].length;
        continue;
      }
      if (/^(2>&1|&>|2>>|2>|>>|&&|\|\||;;)/.test(src.slice(i))) {
        const m = src.slice(i).match(/^(2>&1|&>|2>>|2>|>>|&&|\|\||;;)/)[0];
        endWord(); toks.push({ op: m }); i += m.length; continue;
      }
      if ('|;&<>()'.includes(c)) { endWord(); toks.push({ op: c }); i++; continue; }
      push({ q: 0, t: c }); i++;
    }
    endWord();
    if (heredocs.length) return { incomplete: true };
    return { toks };
  }
  // $名前、${名前}、$(コマンド)、$?。閉じていなければ null、$ だけなら false
  function dollar(src, i) {
    const nx = src[i + 1];
    if (nx === '(') {
      let depth = 0, j = i + 1, q = null;
      for (; j < src.length; j++) {
        const d = src[j];
        if (q) { if (d === q) q = null; else if (d === '\\' && q === '"') j++; continue; }
        if (d === "'" || d === '"') { q = d; continue; }
        if (d === '(') depth++;
        else if (d === ')') { depth--; if (!depth) break; }
      }
      if (j >= src.length) return null;
      return { part: { sub: src.slice(i + 2, j) }, end: j + 1 };
    }
    if (nx === '{') {
      const e = src.indexOf('}', i);
      if (e < 0) return null;
      return { part: { v: src.slice(i + 2, e) }, end: e + 1 };
    }
    const m = src.slice(i + 1).match(/^([A-Za-z_][A-Za-z0-9_]*|[?$#@0-9])/);
    if (!m) return false;
    return { part: { v: m[1] }, end: i + 1 + m[1].length };
  }

  // ---------------------------------------------------------------- 構文
  // list = [{ and: [{ op: '&&'|'||'|null, pipe: [cmd…] }] }]
  // cmd = { words:[word], assigns:[{name, word}], redirs:[{op, word|body}] } または { for: name, items:[word], body: list }
  function parse(src) {
    const lx = lex(src);
    if (lx.incomplete) return { incomplete: true };
    if (lx.error) return { error: lx.error };
    const toks = lx.toks;
    let k = 0;
    const peek = () => toks[k];
    const isWord = (t, s) => t && t.w && t.w.parts.length === 1 && t.w.parts[0].q === 0 && wordText(t.w) === s;
    const skipNl = () => { while (peek() && (peek().op === '\n' || peek().op === ';')) k++; };
    function parseList(stop) {
      const list = [];
      skipNl();
      while (k < toks.length) {
        if (stop && stop.some((s) => isWord(peek(), s))) break;
        const andor = [];
        let op = null;
        for (;;) {
          const pipe = [];
          for (;;) {
            const c = parseCmd();
            if (c.incomplete) return c;
            if (c.error) return c;
            pipe.push(c);
            if (peek() && peek().op === '|') { k++; while (peek() && peek().op === '\n') k++; continue; }
            break;
          }
          andor.push({ op, pipe });
          if (peek() && (peek().op === '&&' || peek().op === '||')) {
            op = peek().op; k++;
            while (peek() && peek().op === '\n') k++;
            if (!peek()) return { incomplete: true };
            continue;
          }
          break;
        }
        list.push(andor);
        if (peek() && peek().op === '&') { k++; }
        if (peek() && (peek().op === ';' || peek().op === '\n')) { skipNl(); continue; }
        if (!peek()) break;
        if (stop && stop.some((s) => isWord(peek(), s))) break;
        if (peek().op) return { error: `syntax error near unexpected token \`${peek().op}'` };
      }
      return list;
    }
    function parseCmd() {
      const t = peek();
      if (!t) return { incomplete: true };
      if (isWord(t, 'for')) {
        k++;
        const nm = peek(); if (!nm || !nm.w) return { incomplete: true };
        const name = wordText(nm.w); k++;
        const items = [];
        if (isWord(peek(), 'in')) { k++; while (peek() && peek().w) { items.push(peek().w); k++; } }
        skipNl();
        if (!peek()) return { incomplete: true };
        if (!isWord(peek(), 'do')) return { error: "syntax error near unexpected token `" + (peek().op || wordText(peek().w)) + "'" };
        k++;
        const body = parseList(['done']);
        if (body.incomplete || body.error) return body;
        if (!isWord(peek(), 'done')) return { incomplete: true };
        k++;
        return { for: name, items, body, redirs: [] };
      }
      if (isWord(t, 'if')) {
        k++;
        const cond = parseList(['then']); if (cond.incomplete || cond.error) return cond;
        if (!isWord(peek(), 'then')) return { incomplete: true };
        k++;
        const then = parseList(['else', 'fi']); if (then.incomplete || then.error) return then;
        let els = null;
        if (isWord(peek(), 'else')) { k++; els = parseList(['fi']); if (els.incomplete || els.error) return els; }
        if (!isWord(peek(), 'fi')) return { incomplete: true };
        k++;
        return { if: cond, then, else: els, redirs: [] };
      }
      const cmd = { words: [], assigns: [], redirs: [] };
      while (peek()) {
        const u = peek();
        if (u.w) {
          const txt = u.w.parts[0].q === 0 ? u.w.parts[0].t : '';
          const m = !cmd.words.length && u.w.parts[0].q === 0 && /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(wordText({ parts: [u.w.parts[0]] }));
          if (m && txt !== undefined) {
            const first = u.w.parts[0];
            const rest = { parts: [{ q: 0, t: first.t.slice(m[0].length) }].concat(u.w.parts.slice(1)) };
            cmd.assigns.push({ name: m[1], word: rest });
            k++; continue;
          }
          cmd.words.push(u.w); k++; continue;
        }
        if (u.op === '<<') { cmd.redirs.push({ op: '<<', body: u.body, quoted: u.quoted }); k++; continue; }
        if (['>', '>>', '<', '2>', '2>>', '&>'].includes(u.op)) {
          k++;
          const f = peek();
          if (!f || !f.w) return f ? { error: `syntax error near unexpected token \`${f.op === '\n' ? 'newline' : f.op}'` } : { error: "syntax error near unexpected token `newline'" };
          cmd.redirs.push({ op: u.op, word: f.w }); k++; continue;
        }
        if (u.op === '2>&1') { cmd.redirs.push({ op: '2>&1' }); k++; continue; }
        break;
      }
      if (!cmd.words.length && !cmd.assigns.length && !cmd.redirs.length) {
        const u = peek();
        return { error: `syntax error near unexpected token \`${u.op === '\n' ? 'newline' : u.op || wordText(u.w)}'` };
      }
      return cmd;
    }
    const list = parseList(null);
    if (list.incomplete || list.error) return list;
    return { list };
  }
  function wordText(w) { return w.parts.map((p) => p.t || '').join(''); }

  // ---------------------------------------------------------------- 展開
  async function expand(sys, w, opts = {}) {
    // 戻り値は単語の配列（引用符のない展開は空白で分ける）
    const out = [];
    let cur = '', any = false, quotedAny = false;
    for (const p of w.parts) {
      let val, split = false;
      if (p.sub !== undefined) { val = (await capture(sys, p.sub)).replace(/\n+$/, ''); split = !p.q; }
      else if (p.v !== undefined) { val = getVar(sys, p.v); split = !p.q; }
      else { val = p.t; if (p.q) quotedAny = true; }
      if (split && !opts.noSplit) {
        const parts = val.split(/[ \t\n]+/);
        for (let j = 0; j < parts.length; j++) {
          if (j > 0) { if (cur || any) out.push(cur); cur = ''; any = false; }
          cur += parts[j];
          if (parts[j]) any = true;
        }
        continue;
      }
      cur += val; any = true;
    }
    if (cur || quotedAny || (any && cur)) out.push(cur);
    return out;
  }
  const expandOne = async (sys, w) => (await expand(sys, w, { noSplit: true })).join(' ');
  function getVar(sys, name) {
    const sh = sys.sh;
    if (name === '?') return String(sh.status);
    if (name === '$') return '1042';
    if (name === 'HOME') return '/home/you';
    if (name === 'PWD') return sh.cwd;
    if (name === 'GOOGLE_CLOUD_PROJECT' || name === 'DEVSHELL_PROJECT_ID') { const p = G.cfgGet(sys.w, 'core/project'); return p || ''; }
    if (name === 'USER') return 'you';
    if (name === 'RANDOM') return String(G.hash('rnd' + G.seq(sys.w, 'rnd')) % 32768);
    const pm = name.match(/^([A-Za-z_][A-Za-z0-9_]*)(##|#|%%|%)(.*)$/);
    if (pm) {
      const v = sh.vars[pm[1]] || '';
      const re = pm[3].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.').replace(/\*/g, pm[2].length === 2 ? '.*' : '.*?');
      if (pm[2][0] === '#') return v.replace(new RegExp('^' + re), '');
      const re2 = pm[3].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.').replace(/\*/g, pm[2].length === 2 ? '.*' : '.*?');
      return v.replace(new RegExp(pm[2].length === 2 ? '^(.*?)' + re2 + '$' : '^(.*)' + re2 + '$'), '$1');
    }
    const m = name.match(/^([A-Za-z_][A-Za-z0-9_]*):-(.*)$/);
    if (m) { const v = sh.vars[m[1]]; return v === undefined || v === '' ? m[2] : v; }
    return sh.vars[name] !== undefined ? sh.vars[name] : '';
  }
  async function expandHere(sys, body) {
    // ヒアドキュメント（引用符なし）：$VAR と $( ) を展開する
    let out = '', i = 0;
    while (i < body.length) {
      if (body[i] === '\\' && /[$\\`]/.test(body[i + 1])) { out += body[i + 1]; i += 2; continue; }
      if (body[i] === '$') {
        const r = dollar(body, i);
        if (r) { out += r.part.sub !== undefined ? (await capture(sys, r.part.sub)).replace(/\n+$/, '') : getVar(sys, r.part.v); i = r.end; continue; }
      }
      out += body[i++];
    }
    return out;
  }
  async function capture(sys, src) {
    let buf = '';
    const saveVars = sys.sh;
    await runSrc(sys, src, { stdin: '', out: (s) => { buf += s; }, err: (s) => sys.io.err(s) });
    return buf;
  }

  // ---------------------------------------------------------------- 手元のファイル（/home/you）
  G.fs = {
    norm(sys, p) {
      if (!p) return sys.sh.cwd;
      if (p === '~' || p.startsWith('~/')) p = '/home/you' + p.slice(1);
      if (!p.startsWith('/')) p = sys.sh.cwd.replace(/\/$/, '') + '/' + p;
      const parts = [];
      for (const s of p.split('/')) { if (!s || s === '.') continue; if (s === '..') parts.pop(); else parts.push(s); }
      return '/' + parts.join('/');
    },
    read(sys, p) { if (p === '/dev/null') return ''; const f = sys.sh.files[G.fs.norm(sys, p)]; return f === undefined ? null : f; },
    write(sys, p, s) {
      if (p === '/dev/null') return true;
      const n = G.fs.norm(sys, p);
      const dir = n.replace(/\/[^/]*$/, '') || '/';
      if (!G.fs.isDir(sys, dir)) return false;
      if (sys.sh.dirs.includes(n)) return 'dir';
      sys.sh.files[n] = s; return true;
    },
    isDir(sys, p) { const n = G.fs.norm(sys, p); return n === '/' || sys.sh.dirs.includes(n); },
    mkdir(sys, p) { const n = G.fs.norm(sys, p); if (!sys.sh.dirs.includes(n)) sys.sh.dirs.push(n); },
    list(sys, dir) {
      const n = G.fs.norm(sys, dir).replace(/\/$/, '');
      const pre = n + '/';
      const names = new Set();
      for (const f of Object.keys(sys.sh.files).concat(sys.sh.dirs)) if (f.startsWith(pre)) names.add(f.slice(pre.length).split('/')[0]);
      return [...names].sort();
    },
    // dir の下のファイルを全部（相対パス → 中身）
    tree(sys, dir) {
      const n = G.fs.norm(sys, dir).replace(/\/$/, '');
      const out = {};
      for (const [f, s] of Object.entries(sys.sh.files)) if (f.startsWith(n + '/')) out[f.slice(n.length + 1)] = s;
      return out;
    },
  };
  const FS = G.fs;

  // ---------------------------------------------------------------- 実行
  async function runSrc(sys, src, io) {
    const pr = parse(src);
    if (pr.incomplete) { io.err("-bash: syntax error: unexpected end of file\n"); return 2; }
    if (pr.error) { io.err(`-bash: ${pr.error}\n`); return 2; }
    return runList(sys, pr.list, io);
  }
  async function runList(sys, list, io) {
    let st = 0;
    for (const andor of list) {
      for (const part of andor) {
        if (part.op === '&&' && st !== 0) continue;
        if (part.op === '||' && st === 0) continue;
        st = await runPipe(sys, part.pipe, io);
        sys.sh.status = st;
        if (sys.sh.exited) return st;
      }
    }
    return st;
  }
  async function runPipe(sys, pipe, io) {
    let input = io.stdin;
    let st = 0;
    for (let j = 0; j < pipe.length; j++) {
      const last = j === pipe.length - 1;
      let buf = '';
      const sub = { stdin: input, out: last ? io.out : (s) => { buf += s; }, err: io.err };
      st = await runCmd(sys, pipe[j], sub);
      input = buf;
    }
    return st;
  }
  async function runCmd(sys, cmd, io) {
    // リダイレクト
    let stdin = io.stdin, outFile = null, outAppend = false, errFile = null, errToOut = false, both = false;
    for (const r of cmd.redirs) {
      if (r.op === '<<') stdin = r.quoted ? r.body : await expandHere(sys, r.body);
      else if (r.op === '<') {
        const f = await expandOne(sys, r.word);
        const s = FS.read(sys, f);
        if (s === null) { io.err(`-bash: ${f}: No such file or directory\n`); return 1; }
        stdin = s;
      } else if (r.op === '>' || r.op === '>>') { outFile = await expandOne(sys, r.word); outAppend = r.op === '>>'; }
      else if (r.op === '&>') { outFile = await expandOne(sys, r.word); both = true; }
      else if (r.op === '2>' || r.op === '2>>') errFile = await expandOne(sys, r.word);
      else if (r.op === '2>&1') errToOut = true;
    }
    let obuf = '', ebuf = '';
    const out = outFile !== null ? (s) => { obuf += s; } : io.out;
    const err = both ? out : errToOut ? out : errFile !== null ? (s) => { ebuf += s; } : io.err;
    const sub = { stdin, out, err };
    let st;
    if (cmd.for) {
      const items = [];
      for (const w of cmd.items) items.push(...(await expand(sys, w)));
      st = 0;
      for (const it of items) { sys.sh.vars[cmd.for] = it; st = await runList(sys, cmd.body, sub); if (sys.sh.exited) break; }
    } else if (cmd.if) {
      const c = await runList(sys, cmd.if, sub);
      if (c === 0) st = await runList(sys, cmd.then, sub);
      else st = cmd.else ? await runList(sys, cmd.else, sub) : 0;
    } else {
      const words = [];
      for (const w of cmd.words) words.push(...(await expand(sys, w)));
      if (!words.length) {
        for (const a of cmd.assigns) sys.sh.vars[a.name] = await expandOne(sys, a.word);
        st = 0;
      } else {
        const name = words[0];
        const f = C[name];
        sys.sys_xtrace && io.err('+ ' + words.join(' ') + '\n');
        if (!f) { err(`-bash: ${name}: command not found\n`); st = 127; }
        else {
          const saved = {};
          for (const a of cmd.assigns) { saved[a.name] = sys.sh.vars[a.name]; sys.sh.vars[a.name] = await expandOne(sys, a.word); }
          try { st = await f(sys, words.slice(1), sub, name); }
          catch (e) {
            if (e && e.shExit !== undefined) { sys.sh.exited = true; st = e.shExit; }
            else if (e instanceof G.Err) { err(G.errText(e, name) + '\n'); st = 1; }
            else throw e;
          }
          for (const a of cmd.assigns) { if (saved[a.name] === undefined) delete sys.sh.vars[a.name]; else sys.sh.vars[a.name] = saved[a.name]; }
        }
      }
    }
    if (outFile !== null) {
      const prev = outAppend ? FS.read(sys, outFile) || '' : '';
      const r = FS.write(sys, outFile, prev + obuf);
      if (r !== true) { io.err(`-bash: ${outFile}: ${r === 'dir' ? 'Is a directory' : 'No such file or directory'}\n`); return 1; }
    }
    if (errFile !== null && errFile !== '/dev/null') FS.write(sys, errFile, ebuf);
    return st;
  }
  G.errText = (e, name) => `${name}: ${e.message}`;

  G.sh = {
    parse, lex, run: runSrc, expand, expandOne,
    newState: () => ({
      cwd: '/home/you', vars: {}, status: 0, exited: false,
      dirs: ['/home', '/home/you'],
      files: { '/home/you/README-cloudshell.txt': 'Your Cloud Shell machine comes with many tools pre-installed: gcloud, bq, kubectl, docker, node, python3 …\nType "gcloud help" to get help on using Cloud SDK.\n' },
    }),
  };

  // ---------------------------------------------------------------- ふつうのコマンド
  const usage = (io, name, s) => { io.err(`${name}: ${s}\n`); return 2; };
  C.echo = async (sys, a, io) => {
    let nl = true, e = false;
    while (a[0] && /^-[ne]+$/.test(a[0])) { if (a[0].includes('n')) nl = false; if (a[0].includes('e')) e = true; a = a.slice(1); }
    let s = a.join(' ');
    if (e) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    io.out(s + (nl ? '\n' : ''));
    return 0;
  };
  C.printf = async (sys, a, io) => {
    if (!a.length) return usage(io, 'printf', 'usage: printf [-v var] format [arguments]');
    let fmt = a[0].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    const args = a.slice(1);
    let k = 0;
    const one = () => fmt.replace(/%(-?\d*)([sd%])/g, (m, w, c) => { if (c === '%') return '%'; let v = args[k++] ?? ''; if (c === 'd') v = String(parseInt(v, 10) || 0); const n = parseInt(w, 10) || 0; return n < 0 || w.startsWith('-') ? v.padEnd(Math.abs(n)) : v.padStart(n); });
    let s = one();
    while (k < args.length && /%[sd]/.test(fmt)) s += one();
    io.out(s);
    return 0;
  };
  // test と [（文字列、数、ファイルの比べ）
  C.test = C['['] = async (sys, a, io, name) => {
    if (name === '[') { if (a[a.length - 1] !== ']') { io.err("-bash: [: missing `]'\n"); return 2; } a = a.slice(0, -1); }
    const ev = (x) => {
      if (x[0] === '!') return !ev(x.slice(1));
      const k = x.indexOf('-a'); if (k > 0) return ev(x.slice(0, k)) && ev(x.slice(k + 1));
      const o = x.indexOf('-o'); if (o > 0) return ev(x.slice(0, o)) || ev(x.slice(o + 1));
      if (x.length === 0) return false;
      if (x.length === 1) return x[0] !== '';
      if (x.length === 2) { const [op, v] = x; if (op === '-z') return v === ''; if (op === '-n') return v !== ''; if (op === '-f') return G.fs.read(sys, v) !== null; if (op === '-d') return G.fs.isDir(sys, v); if (op === '-e') return G.fs.read(sys, v) !== null || G.fs.isDir(sys, v); return false; }
      const [l, op, r] = x;
      switch (op) { case '=': case '==': return l === r; case '!=': return l !== r; case '-eq': return +l === +r; case '-ne': return +l !== +r; case '-lt': return +l < +r; case '-le': return +l <= +r; case '-gt': return +l > +r; case '-ge': return +l >= +r; }
      return false;
    };
    return ev(a) ? 0 : 1;
  };
  C.true = async () => 0;
  C.false = async () => 1;
  C.exit = async (sys, a) => { throw { shExit: Number(a[0] || sys.sh.status) || 0 }; };
  C.export = async (sys, a) => { for (const x of a) { const m = x.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s); if (m) sys.sh.vars[m[1]] = m[2]; } return 0; };
  C.unset = async (sys, a) => { for (const x of a) delete sys.sh.vars[x]; return 0; };
  C.pwd = async (sys, a, io) => { io.out(sys.sh.cwd + '\n'); return 0; };
  C.cd = async (sys, a, io) => {
    const d = FS.norm(sys, a[0] || '~');
    if (!FS.isDir(sys, d)) { io.err(`-bash: cd: ${a[0]}: No such file or directory\n`); return 1; }
    sys.sh.cwd = d; return 0;
  };
  C.mkdir = async (sys, a, io) => {
    const p = a.includes('-p');
    for (const x of a.filter((s) => !s.startsWith('-'))) {
      const n = FS.norm(sys, x);
      if (FS.isDir(sys, n)) { if (!p) { io.err(`mkdir: cannot create directory '${x}': File exists\n`); return 1; } continue; }
      const parent = n.replace(/\/[^/]*$/, '') || '/';
      if (!FS.isDir(sys, parent)) {
        if (!p) { io.err(`mkdir: cannot create directory '${x}': No such file or directory\n`); return 1; }
        const parts = n.split('/').filter(Boolean);
        for (let j = 1; j <= parts.length; j++) FS.mkdir(sys, '/' + parts.slice(0, j).join('/'));
      } else FS.mkdir(sys, n);
    }
    return 0;
  };
  C.ls = async (sys, a, io) => {
    const targets = a.filter((s) => !s.startsWith('-'));
    if (!targets.length) targets.push('.');
    let st = 0;
    for (const t of targets) {
      if (FS.isDir(sys, t)) { const l = FS.list(sys, t); if (targets.length > 1) io.out(t + ':\n'); if (l.length) io.out(l.join('  ') + '\n'); }
      else if (FS.read(sys, t) !== null) io.out(t + '\n');
      else { io.err(`ls: cannot access '${t}': No such file or directory\n`); st = 2; }
    }
    return st;
  };
  C.cat = async (sys, a, io) => {
    if (!a.length || (a.length === 1 && a[0] === '-')) { io.out(io.stdin || ''); return 0; }
    let st = 0;
    for (const f of a) {
      if (FS.isDir(sys, f)) { io.err(`cat: ${f}: Is a directory\n`); st = 1; continue; }
      const s = FS.read(sys, f);
      if (s === null) { io.err(`cat: ${f}: No such file or directory\n`); st = 1; continue; }
      io.out(s);
    }
    return st;
  };
  C.rm = async (sys, a, io) => {
    const force = a.some((s) => /^-\w*f/.test(s)), rec = a.some((s) => /^-\w*r/i.test(s));
    let st = 0;
    for (const f of a.filter((s) => !s.startsWith('-'))) {
      const n = FS.norm(sys, f);
      if (FS.isDir(sys, n)) {
        if (!rec) { io.err(`rm: cannot remove '${f}': Is a directory\n`); st = 1; continue; }
        for (const k of Object.keys(sys.sh.files)) if (k.startsWith(n + '/')) delete sys.sh.files[k];
        sys.sh.dirs = sys.sh.dirs.filter((d) => d !== n && !d.startsWith(n + '/'));
        continue;
      }
      if (sys.sh.files[n] === undefined) { if (!force) { io.err(`rm: cannot remove '${f}': No such file or directory\n`); st = 1; } continue; }
      delete sys.sh.files[n];
    }
    return st;
  };
  C.touch = async (sys, a, io) => { for (const f of a) if (FS.read(sys, f) === null && !FS.write(sys, f, '')) { io.err(`touch: cannot touch '${f}': No such file or directory\n`); return 1; } return 0; };
  C.sleep = async (sys, a) => { const n = parseFloat(a[0]) || 0; const ms = /m$/.test(a[0]) ? n * 60000 : n * 1000; G.advance(sys.w, ms); return 0; };
  C.date = async (sys, a, io) => {
    const d = new Date(G.T0 + sys.w.t);
    if (a[0] === '-u' || a[0] === '--utc') a = a.slice(1);
    if (a[0] && a[0].startsWith('+')) {
      const p2 = (n) => String(n).padStart(2, '0');
      io.out(a[0].slice(1).replace(/%Y/g, d.getUTCFullYear()).replace(/%m/g, p2(d.getUTCMonth() + 1)).replace(/%d/g, p2(d.getUTCDate())).replace(/%H/g, p2(d.getUTCHours())).replace(/%M/g, p2(d.getUTCMinutes())).replace(/%S/g, p2(d.getUTCSeconds())).replace(/%s/g, Math.floor(d / 1000)) + '\n');
      return 0;
    }
    io.out(d.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, (m, wd, dd, mo, y, hms) => `${wd} ${mo} ${String(+dd).padStart(2)} ${hms} UTC ${y}`) + '\n');
    return 0;
  };
  // テキストの道具（入力はファイルか標準入力）
  const inputOf = (sys, files, io) => {
    if (!files.length) return io.stdin || '';
    let s = '';
    for (const f of files) { const t = FS.read(sys, f); if (t === null) { io.err(`${f}: No such file or directory\n`); continue; } s += t; }
    return s;
  };
  const lines = (s) => { const l = s.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };
  C.grep = async (sys, a, io) => {
    let inv = false, ic = false, cnt = false, ere = false, only = false, pat = null;
    const files = [];
    for (let j = 0; j < a.length; j++) {
      const x = a[j];
      if (x === '-e') { pat = a[++j]; continue; }
      if (/^-[a-zA-Z]+$/.test(x)) { for (const c of x.slice(1)) { if (c === 'v') inv = true; else if (c === 'i') ic = true; else if (c === 'c') cnt = true; else if (c === 'E') ere = true; else if (c === 'o') only = true; } continue; }
      if (pat === null) pat = x; else files.push(x);
    }
    if (pat === null) return usage(io, 'Usage', "grep [OPTION]... PATTERNS [FILE]...");
    let re;
    try { re = new RegExp(ere ? pat : pat.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\|/g, '|').replace(/[+?(){}|]/g, (c) => '\\' + c).replace(/\\\\([+?(){}|])/g, '$1'), ic ? 'gi' : 'g'); }
    catch (e) { io.err('grep: Invalid regular expression\n'); return 2; }
    const hit = lines(inputOf(sys, files, io)).filter((l) => { re.lastIndex = 0; return re.test(l) !== inv; });
    if (cnt) io.out(hit.length + '\n');
    else if (only) for (const l of hit) { const m = l.match(re) || []; for (const x of m) io.out(x + '\n'); }
    else if (hit.length) io.out(hit.join('\n') + '\n');
    return hit.length ? 0 : 1;
  };
  const numOpt = (a, def) => { let n = def; const files = []; for (let j = 0; j < a.length; j++) { if (a[j] === '-n') n = a[++j]; else if (/^-n?\d+$/.test(a[j])) n = a[j].replace(/^-n?/, ''); else files.push(a[j]); } return { n: String(n), files }; };
  C.head = async (sys, a, io) => { const o = numOpt(a, 10); const l = lines(inputOf(sys, o.files, io)); const n = +o.n; const r = n < 0 ? l.slice(0, n) : l.slice(0, n); if (r.length) io.out(r.join('\n') + '\n'); return 0; };
  C.tail = async (sys, a, io) => { const o = numOpt(a, 10); const l = lines(inputOf(sys, o.files, io)); const r = o.n.startsWith('+') ? l.slice(+o.n.slice(1) - 1) : l.slice(-(+o.n) || l.length); if (r.length && +o.n !== 0) io.out(r.join('\n') + '\n'); return 0; };
  C.wc = async (sys, a, io) => {
    const fl = a.filter((s) => s.startsWith('-')).join(''), files = a.filter((s) => !s.startsWith('-'));
    const s = inputOf(sys, files, io);
    const L = (s.match(/\n/g) || []).length, W = s.split(/\s+/).filter(Boolean).length, B = new TextEncoder().encode(s).length;
    const vals = fl.includes('l') ? [L] : fl.includes('w') ? [W] : fl.includes('c') ? [B] : [L, W, B];
    io.out((vals.length === 1 && !files.length ? String(vals[0]) : vals.map((v) => String(v).padStart(files.length ? 1 : 7)).join(' ')) + (files.length ? ' ' + files.join(' ') : '') + '\n');
    return 0;
  };
  C.sort = async (sys, a, io) => {
    const fl = a.filter((s) => s.startsWith('-')).join(''), files = a.filter((s) => !s.startsWith('-'));
    let l = lines(inputOf(sys, files, io));
    if (fl.includes('n')) l.sort((x, y) => parseFloat(x) - parseFloat(y) || (x < y ? -1 : x > y ? 1 : 0));
    else l.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    if (fl.includes('r')) l.reverse();
    if (fl.includes('u')) l = l.filter((x, j) => j === 0 || x !== l[j - 1]);
    if (l.length) io.out(l.join('\n') + '\n');
    return 0;
  };
  C.uniq = async (sys, a, io) => {
    const c = a.includes('-c');
    const l = lines(inputOf(sys, a.filter((s) => !s.startsWith('-')), io));
    const out = [];
    for (const x of l) { if (out.length && out[out.length - 1].s === x) out[out.length - 1].n++; else out.push({ s: x, n: 1 }); }
    if (out.length) io.out(out.map((o) => (c ? String(o.n).padStart(7) + ' ' + o.s : o.s)).join('\n') + '\n');
    return 0;
  };
  C.cut = async (sys, a, io) => {
    let d = '\t', f = null;
    const files = [];
    for (let j = 0; j < a.length; j++) {
      if (a[j] === '-c') { f = 'c' + a[++j]; continue; } if (/^-c\d/.test(a[j])) { f = 'c' + a[j].slice(2); continue; }
      if (a[j] === '-d') d = a[++j]; else if (a[j].startsWith('-d')) d = a[j].slice(2);
      else if (a[j] === '-f') f = a[++j]; else if (a[j].startsWith('-f')) f = a[j].slice(2);
      else files.push(a[j]);
    }
    if (!f) return usage(io, 'cut', 'you must specify a list of bytes, characters, or fields');
    if (f.startsWith('c')) {
      const [lo, hi] = f.slice(1).split('-');
      const l = lines(inputOf(sys, files, io)).map((x) => [...x].slice((+lo || 1) - 1, hi === undefined ? +lo : hi === '' ? undefined : +hi).join(''));
      if (l.length) io.out(l.join('\n') + '\n');
      return 0;
    }
    const idx = [];
    for (const r of f.split(',')) { const m = r.match(/^(\d*)-(\d*)$/); if (m) { for (let k = +(m[1] || 1); k <= +(m[2] || 99); k++) idx.push(k); } else idx.push(+r); }
    const l = lines(inputOf(sys, files, io)).map((x) => { if (!x.includes(d)) return x; const p = x.split(d); return idx.filter((k) => k <= p.length).map((k) => p[k - 1]).join(d); });
    if (l.length) io.out(l.join('\n') + '\n');
    return 0;
  };
  C.tr = async (sys, a, io) => {
    const del = a[0] === '-d';
    const s = io.stdin || '';
    const exp = (x) => x.replace(/\\n/g, '\n').replace(/([a-zA-Z0-9])-([a-zA-Z0-9])/g, (m, p, q) => { let r = ''; for (let c = p.charCodeAt(0); c <= q.charCodeAt(0); c++) r += String.fromCharCode(c); return r; });
    if (del) { const set = exp(a[1] || ''); io.out([...s].filter((c) => !set.includes(c)).join('')); return 0; }
    const A = exp(a[0] || ''), B = exp(a[1] || '');
    io.out([...s].map((c) => { const k = A.indexOf(c); return k < 0 ? c : B[Math.min(k, B.length - 1)]; }).join(''));
    return 0;
  };
  C.seq = async (sys, a, io) => { const [x, y] = a.length === 1 ? [1, +a[0]] : [+a[0], +a[1]]; let s = ''; for (let k = x; k <= y; k++) s += k + '\n'; io.out(s); return 0; };
  C.base64 = async (sys, a, io) => {
    const files = a.filter((s) => !s.startsWith('-'));
    const s = inputOf(sys, files, io);
    if (a.includes('-d') || a.includes('--decode')) { io.out(G.b64dec(s.trim())); return 0; }
    io.out(G.b64enc(s) + '\n'); return 0;
  };
  G.b64enc = (s) => { const b = new TextEncoder().encode(s); let bin = ''; for (const x of b) bin += String.fromCharCode(x); return (typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64')); };
  G.b64dec = (s) => { const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary'); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); };
  C.whoami = async (sys, a, io) => { io.out('you\n'); return 0; };
  C.clear = async () => 0;
  C.history = async () => 0;

  // 仮想時間を進める（時間のかかる操作の完了、Pub/Sub の再配信など）。各サービスは G.TIMERS に「時刻が来たら呼ぶ」ものを登録する
  G.TIMERS = G.TIMERS || [];
  G.advance = (w, ms) => {
    const from = w.t;
    const end = w.t + ms;
    for (;;) {
      // いちばん近い予定
      let next = null;
      for (const tm of w.timers || []) if (tm.at <= end && (!next || tm.at < next.at)) next = tm;
      if (!next) break;
      w.t = Math.max(w.t, next.at);
      w.timers = w.timers.filter((x) => x !== next);
      const f = G.TIMER_FN[next.fn];
      if (f) f(w, next.arg);
    }
    w.t = end;
    for (const h of G.TICK_HOOKS || []) h(w, from, end);
  };
  G.TICK_HOOKS = G.TICK_HOOKS || [];
  G.TIMER_FN = G.TIMER_FN || {};
  G.later = (w, ms, fn, arg) => { (w.timers = w.timers || []).push({ at: w.t + ms, fn, arg }); };
})(typeof window !== 'undefined' ? window : globalThis);
