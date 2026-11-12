// ハイライタ：RISC-V アセンブリ（asm）、回路記述（logic）、C。
// ブラウザ（window.HL）とビルド（globalThis.HL）の両方から使う。DOM は使わない。
//   HL.highlightLines(src, lang) → 行ごとの HTML の配列
//   HL.editorHTML(src, lang, marks) → エディタの下敷き用の HTML（1 行 = <span class="el">）。
//       marks = { err: [行番号…], cur: 行番号, prev: 行番号 }（行番号は 1 始まり）
(function (root) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const span = (cls, t) => (cls ? `<span class="${cls}">${esc(t)}</span>` : esc(t));

  // ---------------------------------------------------------------- asm
  const ABI = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
    's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6', 'fp'];
  const REGS = new Set(ABI);
  for (let i = 0; i < 32; i++) REGS.add('x' + i);
  const CSRS = new Set(['mstatus', 'mtvec', 'mepc', 'mcause', 'mtval', 'mscratch', 'mie', 'mip']);

  // クラス：k 命令 / t レジスタ / mc ディレクティブ / lt ラベル / n 数 / s 文字・文字列 / c コメント / o 記号 / at %hi %lo
  function asmLine(line) {
    let out = '', i = 0, first = true; // first：まだ命令（かディレクティブ）を見ていない
    const n = line.length;
    while (i < n) {
      const rest = line.slice(i);
      const ch = line[i];
      let m;
      if (ch === '#' || (ch === '/' && line[i + 1] === '/')) { out += span('c', rest); break; }
      if ((m = rest.match(/^\s+/))) { out += m[0]; i += m[0].length; continue; }
      if (ch === '"') {
        let j = i + 1;
        while (j < n && line[j] !== '"') j += line[j] === '\\' ? 2 : 1;
        j = Math.min(n, j + 1);
        out += span('s', line.slice(i, j)); i = j; continue;
      }
      if ((m = rest.match(/^'(\\x[0-9a-fA-F]{1,2}|\\.|[^\\'])'/))) { out += span('s', m[0]); i += m[0].length; continue; }
      if (first && (m = rest.match(/^([A-Za-z_.$][\w.$]*|\d+)\s*:/))) { out += span('lt', m[0]); i += m[0].length; continue; }
      if ((m = rest.match(/^\.[A-Za-z_]\w*/)) && first) { out += span('mc', m[0]); i += m[0].length; first = false; continue; }
      if ((m = rest.match(/^%(hi|lo)\b/))) { out += span('at', m[0]); i += m[0].length; continue; }
      if ((m = rest.match(/^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d+[bf]\b|\d+)/))) { out += span('n', m[0]); i += m[0].length; continue; }
      if ((m = rest.match(/^[A-Za-z_.$][\w.$]*/))) {
        const w = m[0], lw = w.toLowerCase();
        let cls = '';
        if (first) {
          // 「名前 = 値」は定数の定義
          cls = /^\s*=/.test(line.slice(i + w.length)) ? 'lt' : 'k';
          first = false;
        } else if (REGS.has(lw)) cls = 't';
        else if (CSRS.has(lw)) cls = 'at';
        out += span(cls, w); i += w.length; continue;
      }
      if ((m = rest.match(/^[-+*/&|^~<>=(),:]+/))) { out += span('o', m[0]); i += m[0].length; continue; }
      out += esc(ch); i++;
    }
    return out;
  }

  // ---------------------------------------------------------------- logic
  const L_KW = new Set(['in', 'out', 'wire', 'reg', 'def', 'test', 'step', 'clock', 'init']);
  const L_OP = new Set(['and', 'or', 'not', 'xor', 'nand', 'nor', 'xnor', 'mux']);
  function logicLine(line) {
    let out = '', i = 0;
    const n = line.length;
    while (i < n) {
      const rest = line.slice(i);
      const ch = line[i];
      let m;
      if (ch === '#' || (ch === '/' && line[i + 1] === '/')) { out += span('c', rest); break; }
      if ((m = rest.match(/^\s+/))) { out += m[0]; i += m[0].length; continue; }
      if ((m = rest.match(/^(0[xX][0-9a-fA-F]+|0[bB][01]+|\d+)/))) { out += span('n', m[0]); i += m[0].length; continue; }
      if ((m = rest.match(/^[A-Za-z_]\w*/))) {
        const w = m[0], lw = w.toLowerCase();
        const call = /^\s*\(/.test(line.slice(i + w.length));
        out += span(L_KW.has(lw) ? 'k' : L_OP.has(lw) ? 't' : call ? 'f' : '', w);
        i += w.length; continue;
      }
      if ((m = rest.match(/^(->|==|[-+&|^~!=,;:{}()\[\]])/))) { out += span('o', m[0]); i += m[0].length; continue; }
      out += esc(ch); i++;
    }
    return out;
  }

  // ---------------------------------------------------------------- C
  const C_KW = new Set(`auto break case const continue default do else enum extern for goto if inline register restrict return
    sizeof static struct switch typedef union volatile while`.split(/\s+/));
  const C_TY = new Set(`void char short int long float double signed unsigned bool size_t int8_t int16_t int32_t int64_t
    uint8_t uint16_t uint32_t uint64_t`.split(/\s+/));
  function cLines(src) {
    const lines = [''];
    const add = (cls, t) => {
      t.split('\n').forEach((p, k) => {
        if (k) lines.push('');
        if (p) lines[lines.length - 1] += span(cls, p);
      });
    };
    let i = 0;
    const n = src.length;
    let bol = true; // 行の先頭（空白を除く）か
    while (i < n) {
      const rest = src.slice(i);
      const ch = src[i];
      let m;
      if (ch === '\n') { add('', ch); i++; bol = true; continue; }
      if ((m = rest.match(/^[ \t]+/))) { add('', m[0]); i += m[0].length; continue; }
      if (ch === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); const j = e < 0 ? n : e; add('c', src.slice(i, j)); i = j; continue; }
      if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const j = e < 0 ? n : e + 2; add('c', src.slice(i, j)); i = j; bol = false; continue; }
      if (bol && ch === '#') { const e = src.indexOf('\n', i); const j = e < 0 ? n : e; add('mc', src.slice(i, j)); i = j; continue; }
      bol = false;
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < n && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        j = Math.min(n, j + 1);
        add('s', src.slice(i, j)); i = j; continue;
      }
      if ((m = rest.match(/^(0[xX][0-9a-fA-F]+|0[bB][01]+|\d+(\.\d+)?)[uUlLfF]*/))) { add('n', m[0]); i += m[0].length; continue; }
      if ((m = rest.match(/^[A-Za-z_]\w*/))) {
        const w = m[0];
        const call = /^\s*\(/.test(src.slice(i + w.length));
        add(C_KW.has(w) ? 'k' : C_TY.has(w) ? 't' : call ? 'f' : '', w);
        i += w.length; continue;
      }
      if ((m = rest.match(/^[-+*/%&|^~!<>=?:;,.(){}\[\]]+/))) { add('o', m[0]); i += m[0].length; continue; }
      add('', ch); i++;
    }
    return lines;
  }

  function highlightLines(src, lang) {
    src = String(src);
    if (lang === 'asm') return src.split('\n').map(asmLine);
    if (lang === 'logic') return src.split('\n').map(logicLine);
    if (lang === 'c') return cLines(src);
    return src.split('\n').map(esc);
  }

  function editorHTML(src, lang, marks) {
    const err = new Set((marks && marks.err) || []);
    const cur = marks && marks.cur, prev = marks && marks.prev;
    return highlightLines(src, lang)
      .map((h, i) => {
        const n = i + 1;
        const cls = (err.has(n) ? ' is-err' : '') + (n === cur ? ' is-cur' : n === prev ? ' is-prev' : '');
        return `<span class="el${cls}">${h}</span>`;
      })
      .join('');
  }

  root.HL = { highlightLines, editorHTML, esc, asmLine, logicLine };
})(typeof window !== 'undefined' ? window : globalThis);
