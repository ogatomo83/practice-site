// アセンブリ / 回路記述 / C / ターミナルのハイライタ（ビルド時に静的 span を出力）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ブラウザと同じトークナイザを読み込む
const HERE = path.dirname(fileURLToPath(import.meta.url));
new Function(fs.readFileSync(path.join(HERE, '..', 'assets', 'hl.js'), 'utf8'))();
export const HL = globalThis.HL;

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function hlConsole(line) {
  if (/^\$ /.test(line)) return `<span class="pr">$</span> <span class="cmd">${esc(line.slice(2))}</span>`;
  if (/^(エラー|error|Error)[:：]/.test(line)) return `<span class="er">${esc(line)}</span>`;
  return esc(line);
}

export function dedent(code) {
  let lines = code.replace(/\t/g, '    ').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return [''];
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(ind));
}

// 行頭の @@ は「変更した行」の印
export function highlight(code, lang) {
  let lines = dedent(code);
  const marks = lines.map((l) => (l.startsWith('@@') ? 'add' : null));
  lines = lines.map((l, i) => (marks[i] ? l.slice(2) : l));
  let htmlLines;
  if (lang === 'asm' || lang === 'logic' || lang === 'c') htmlLines = HL.highlightLines(lines.join('\n'), lang);
  else if (lang === 'console') htmlLines = lines.map(hlConsole);
  else htmlLines = lines.map(esc);
  return htmlLines.map((h, i) => `<span class="ln${marks[i] ? ' ' + marks[i] : ''}">${h || ' '}</span>`).join('');
}
