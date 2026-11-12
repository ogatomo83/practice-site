// Rust / TOML / console の簡易シンタックスハイライタ（ビルド時に静的spanを出力）

export const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const KW = new Set(`as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while union macro_rules`.split(' '));
const PRIM = new Set(`i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str`.split(' '));

const RUST_RE = new RegExp([
  /(\/\/[^\n]*)/.source,                                   // 1 line comment
  /(\/\*[\s\S]*?\*\/)/.source,                             // 2 block comment
  /(b?r#+"[\s\S]*?"#+|b?r"[^"]*"|b?"(?:\\[\s\S]|[^"\\])*")/.source, // 3 string
  /(b?'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^'\\\n])')/.source, // 4 char
  /('[a-zA-Z_]\w*)/.source,                                // 5 lifetime
  /(#!?\[[^\]\n]*\])/.source,                              // 6 attribute
  /(\b0x[0-9a-fA-F_]+\b|\b0b[01_]+\b|\b0o[0-7_]+\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?(?:_?(?:[iu](?:8|16|32|64|128|size)|f32|f64))?\b)/.source, // 7 number
  /(\b[a-z_][a-zA-Z0-9_]*!)/.source,                       // 8 macro
  /(\b[A-Za-z_][A-Za-z0-9_]*\b)/.source,                   // 9 ident
].join('|'), 'g');

function hlRustLine(src) {
  let out = '';
  let last = 0;
  RUST_RE.lastIndex = 0;
  let m;
  while ((m = RUST_RE.exec(src))) {
    if (m.index > last) out += esc(src.slice(last, m.index));
    const t = m[0];
    let cls = null;
    if (m[1] || m[2]) cls = 'c';
    else if (m[3]) cls = 's';
    else if (m[4]) cls = 's';
    else if (m[5]) cls = 'lt';
    else if (m[6]) cls = 'at';
    else if (m[7]) cls = 'n';
    else if (m[8]) cls = 'mc';
    else if (m[9]) {
      if (KW.has(t)) cls = 'k';
      else if (PRIM.has(t)) cls = 't';
      else if (/^[A-Z]/.test(t)) cls = /^[A-Z0-9_]+$/.test(t) && t.length > 1 ? 'n' : 't';
      else if (src[m.index + t.length] === '(' ) cls = 'f';
    }
    out += cls ? `<span class="${cls}">${esc(t)}</span>` : esc(t);
    last = m.index + t.length;
  }
  out += esc(src.slice(last));
  return out;
}

function hlToml(line) {
  if (/^\s*#/.test(line)) return `<span class="c">${esc(line)}</span>`;
  if (/^\s*\[.*\]\s*$/.test(line)) return `<span class="k">${esc(line)}</span>`;
  const m = line.match(/^(\s*[\w.-]+)(\s*=\s*)(.*)$/);
  if (m) {
    const v = m[3]
      .replace(/("(?:\\.|[^"\\])*")/g, '\u0001$1\u0002');
    const vv = esc(v).replace(/\u0001/g, '<span class="s">').replace(/\u0002/g, '</span>');
    return `<span class="t">${esc(m[1])}</span>${esc(m[2])}${vv}`;
  }
  return esc(line);
}

function hlConsole(line) {
  if (/^\$ /.test(line)) return `<span class="pr">$</span> <span class="cmd">${esc(line.slice(2))}</span>`;
  if (/^error/.test(line)) return `<span class="er">${esc(line)}</span>`;
  if (/^warning/.test(line)) return `<span class="wa">${esc(line)}</span>`;
  if (/^\s*(-->|=|\d*\s*\|)/.test(line)) {
    // rustc 診断のガター部分
    const mm = line.match(/^(\s*(?:-->|=|\d*\s*\|))(.*)$/);
    let rest = esc(mm[2]);
    if (/^[\s^\-|_]+.*$/.test(mm[2]) && /[\^\-]{1,}/.test(mm[2]) && !/[a-z]{3,}\s*\(/i.test(mm[2])) {
      rest = rest.replace(/(\^+[^\n]*)/, '<span class="er">$1</span>')
                 .replace(/(-{2,}[^\n]*)/, '<span class="hint">$1</span>');
    }
    return `<span class="gut">${esc(mm[1])}</span>${rest}`;
  }
  if (/^\s*(Compiling|Finished|Running|Updating|Downloaded|Downloading|Installing|Installed|Uploading|Packaging|Verifying|Created|Doc-tests|Replacing|Locking|Adding)\b/.test(line))
    return line.replace(/^(\s*)(\S+)(.*)$/, (_, a, b, c) => `${a}<span class="ok">${esc(b)}</span>${esc(c)}`);
  if (/^test .* ok$/.test(line)) return esc(line).replace(/ok$/, '<span class="ok">ok</span>');
  if (/^test .* FAILED$/.test(line)) return esc(line).replace(/FAILED$/, '<span class="er">FAILED</span>');
  if (/^test result: ok/.test(line)) return esc(line).replace('ok', '<span class="ok">ok</span>');
  if (/^test result: FAILED/.test(line)) return esc(line).replace('FAILED', '<span class="er">FAILED</span>');
  return esc(line);
}

export function highlight(code, lang) {
  // 先頭・末尾の空行を除去し、共通インデントを落とす
  let lines = code.replace(/\t/g, '    ').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  lines = lines.map((l) => l.slice(ind));

  // 複数行コメント対策：Rust は全体でトークナイズしてから行に分割する
  const marks = lines.map((l) => (l.startsWith('@@') ? 'add' : l.startsWith('--') && lang === 'rust' && l.startsWith('-- ') ? 'del' : null));
  lines = lines.map((l, i) => (marks[i] ? l.slice(marks[i] === 'add' ? 2 : 3) : l));

  let htmlLines;
  if (lang === 'rust') {
    // 行単位で処理（ブロックコメントは行内に収まる前提。複数行の /* */ は c を継続）
    let inBlock = false;
    htmlLines = lines.map((l) => {
      if (inBlock) {
        const end = l.indexOf('*/');
        if (end < 0) return `<span class="c">${esc(l)}</span>`;
        inBlock = false;
        return `<span class="c">${esc(l.slice(0, end + 2))}</span>` + hlRustLine(l.slice(end + 2));
      }
      const st = l.indexOf('/*');
      if (st >= 0 && l.indexOf('*/', st) < 0 && !/"[^"]*\/\*/.test(l)) {
        inBlock = true;
        return hlRustLine(l.slice(0, st)) + `<span class="c">${esc(l.slice(st))}</span>`;
      }
      return hlRustLine(l);
    });
  } else if (lang === 'toml') htmlLines = lines.map(hlToml);
  else if (lang === 'console') htmlLines = lines.map(hlConsole);
  else htmlLines = lines.map(esc);

  return htmlLines
    .map((h, i) => `<span class="ln${marks[i] ? ' ' + marks[i] : ''}">${h || ' '}</span>`)
    .join('');
}
