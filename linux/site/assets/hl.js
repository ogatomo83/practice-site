// ハイライタ：シェル（sh）と C。
// ブラウザ（window.HL）とビルド（globalThis.HL）の両方から使う。DOM は使わない。
//   HL.highlightLines(src, lang) → 行ごとの HTML の配列
//   HL.editorHTML(src, lang, marks) → エディタの下敷き用の HTML（1 行 = <span class="el">）。
//       marks = { err: [行番号…] }（行番号は 1 始まり）
(function (root) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const span = (cls, t) => (cls ? `<span class="${cls}">${esc(t)}</span>` : esc(t));

  // ---------------------------------------------------------------- sh
  // クラス：k 予約語 / f コマンド名 / t オプション（-l）/ s 文字列 / at 変数・展開 / n 数 / c コメント / o 記号（| > && ; など）
  const SH_KW = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'function', '{', '}', '!', 'time']);
  // この語の後ろは、また「コマンドの位置」になる
  const SH_CMDPOS = new Set(['then', 'else', 'elif', 'do', 'if', 'while', 'until', '{', '!', 'time']);
  function shLines(src) {
    const lines = [''];
    const add = (cls, t) => {
      t.split('\n').forEach((p, k) => {
        if (k) lines.push('');
        if (p) lines[lines.length - 1] += span(cls, p);
      });
    };
    const n = src.length;
    let i = 0;
    let cmd = true;      // 次の語はコマンド名か
    let caseIn = false;  // case … in の「in」を待っている
    let caseDepth = 0, pat = false; // case の中か、いまパターン（a|b) の部分）を読んでいるか
    const heredocs = []; // 行末の後に読む、ヒアドキュメントの終わりの印
    // $… の展開を 1 つ読む（i は $ の位置）。読んだ長さを返す
    const expansion = (at) => {
      const r = src.slice(at);
      let m;
      if ((m = r.match(/^\$\(\(/))) { let d = 0, j = at; while (j < n) { if (src[j] === '(') d++; else if (src[j] === ')') { d--; if (!d) { j++; break; } } j++; } return j - at; }
      if (r[1] === '(') return 2; // $( は中をふつうに色づけする（閉じ括弧は記号として出る）
      if (r[1] === '{') { const e = src.indexOf('}', at); return (e < 0 ? n : e + 1) - at; }
      if ((m = r.match(/^\$([A-Za-z_]\w*|[0-9?$!#@*-])/))) return m[0].length;
      return 0;
    };
    const dquote = (at) => { // " … "。中の $x は変数の色
      let j = at + 1, seg = at;
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '$') { const L = expansion(j); if (L > 2 || (L === 2 && src[j + 1] !== '(')) { add('s', src.slice(seg, j)); add('at', src.slice(j, j + L)); j += L; seg = j; continue; } }
        j++;
      }
      j = Math.min(n, j + 1);
      add('s', src.slice(seg, j));
      return j;
    };
    while (i < n) {
      const rest = src.slice(i);
      const ch = src[i];
      let m;
      if (ch === '\n') {
        add('', ch); i++; cmd = true;
        while (heredocs.length) { // ヒアドキュメントの本文
          const h = heredocs.shift();
          let j = i;
          for (;;) {
            const e = src.indexOf('\n', j), line = src.slice(j, e < 0 ? n : e);
            const end = (h.strip ? line.replace(/^\t+/, '') : line) === h.word;
            if (end) { add('s', src.slice(i, j)); add('o', line); j = e < 0 ? n : e; break; }
            if (e < 0) { add('s', src.slice(i)); j = n; break; }
            j = e + 1;
          }
          i = j;
        }
        continue;
      }
      if ((m = rest.match(/^[ \t]+/))) { add('', m[0]); i += m[0].length; continue; }
      if (ch === '\\' && src[i + 1] === '\n') { add('o', '\\'); i++; add('', '\n'); i++; continue; }
      if (ch === '#' && (i === 0 || /[\s;|&(]/.test(src[i - 1]))) { const e = src.indexOf('\n', i); const j = e < 0 ? n : e; add('c', src.slice(i, j)); i = j; continue; }
      if (ch === "'") { const e = src.indexOf("'", i + 1); const j = e < 0 ? n : e + 1; add('s', src.slice(i, j)); i = j; cmd = false; continue; }
      if (ch === '"') { i = dquote(i); cmd = false; continue; }
      if (ch === '$' && src[i + 1] === "'") { let j = i + 2; while (j < n && src[j] !== "'") j += src[j] === '\\' ? 2 : 1; j = Math.min(n, j + 1); add('s', src.slice(i, j)); i = j; cmd = false; continue; }
      if (ch === '$') {
        const L = expansion(i);
        if (L) { add('at', src.slice(i, i + L)); i += L; if (src.slice(i - 2, i) === '$(') cmd = true; else cmd = false; continue; }
      }
      if (ch === '`') { add('at', ch); i++; cmd = true; continue; }
      if ((m = rest.match(/^<<(-?)\s*(['"]?)([\w.-]+)\2/))) { heredocs.push({ word: m[3], strip: !!m[1] }); add('o', m[0]); i += m[0].length; continue; }
      if ((m = rest.match(/^(\d*(>>|>&|<&|<<<|&>|>\||<>|>|<)\d*-?|&&|\|\||;;|[|&;()])/))) {
        add('o', m[0]); i += m[0].length;
        if (pat) { if (m[0] === ')') { pat = false; cmd = true; } continue; }
        if (/^(&&|\|\||;;|[|&;(])$/.test(m[0])) cmd = true;
        if (m[0] === ';;' && caseDepth) pat = true;
        continue;
      }
      // 語
      if ((m = rest.match(/^(\\.|[^\s;|&()<>"'`$\\])+/))) {
        const w = m[0];
        let cls = '';
        if (caseIn && w === 'in') { cls = 'k'; caseIn = false; cmd = false; pat = true; }
        else if (pat && w === 'esac') { cls = 'k'; pat = false; caseDepth--; cmd = false; }
        else if (pat) cls = '';
        else if (cmd && SH_KW.has(w)) { cls = 'k'; cmd = SH_CMDPOS.has(w); if (w === 'case') { caseIn = true; caseDepth++; } if (w === 'esac') caseDepth = Math.max(0, caseDepth - 1); if (w === 'for') cmd = false; }
        else if (!cmd && (w === 'in' || w === 'do' || w === 'then') && /(^|[\s;])$/.test(src.slice(Math.max(0, i - 1), i))) { cls = 'k'; cmd = w !== 'in'; }
        else if (cmd && /^[A-Za-z_]\w*=/.test(w)) { const eq = w.indexOf('='); add('at', w.slice(0, eq)); add('o', '='); add('', w.slice(eq + 1)); i += w.length; continue; } // 代入。次の語がまだコマンド名
        else if (cmd) { cls = 'f'; cmd = false; }
        else if (/^--?[A-Za-z]/.test(w)) cls = 't';
        else if (/^-?\d+(\.\d+)?$/.test(w)) cls = 'n';
        add(cls, w); i += w.length; continue;
      }
      add('', ch); i++;
    }
    return lines;
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
    if (lang === 'sh') return shLines(src);
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

  root.HL = { highlightLines, editorHTML, esc };
})(typeof window !== 'undefined' ? window : globalThis);
