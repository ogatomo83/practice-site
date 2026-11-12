// SQL / psql / シェル / JSON のハイライタ（ビルド時に静的 span を出力）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ブラウザと同じトークナイザを読み込む
const HERE = path.dirname(fileURLToPath(import.meta.url));
new Function(fs.readFileSync(path.join(HERE, '..', 'assets', 'sqlhl.js'), 'utf8'))();
export const SQLHL = globalThis.SQLHL;

export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function hlConsole(line) {
  // シェル
  if (/^\$ /.test(line)) return `<span class="pr">$</span> <span class="cmd">${esc(line.slice(2))}</span>`;
  // psql のプロンプト（例: shop=# select ...）
  const pm = line.match(/^([\w]+[=\-*!(][#>])\s?(.*)$/);
  if (pm) {
    const body = SQLHL.highlightLines(pm[2]).join('');
    return `<span class="pr">${esc(pm[1])}</span> <span class="cmd">${body}</span>`;
  }
  if (/^(ERROR|FATAL|PANIC):/.test(line)) return `<span class="er">${esc(line)}</span>`;
  if (/^(WARNING|NOTICE|INFO|HINT|DETAIL|LOG):/.test(line)) return `<span class="wa">${esc(line)}</span>`;
  if (/^\(\d+ (rows?|行)\)$/.test(line)) return `<span class="gut">${esc(line)}</span>`;
  if (/^[-+]+$/.test(line)) return `<span class="gut">${esc(line)}</span>`;
  return esc(line);
}

function hlJson(line) {
  return esc(line)
    .replace(/(&quot;|")([^"]*)("\s*:)/g, '<span class="t">"$2"</span>:')
    .replace(/:\s*("[^"]*")/g, ': <span class="s">$1</span>')
    .replace(/\b(-?\d+(?:\.\d+)?)\b/g, '<span class="n">$1</span>')
    .replace(/\b(true|false|null)\b/g, '<span class="k">$1</span>');
}

export function dedent(code) {
  let lines = code.replace(/\t/g, '    ').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(ind));
}

export function highlight(code, lang) {
  let lines = dedent(code);
  const marks = lines.map((l) => (l.startsWith('@@') ? 'add' : null));
  lines = lines.map((l, i) => (marks[i] ? l.slice(2) : l));
  let htmlLines;
  if (lang === 'sql') htmlLines = SQLHL.highlightLines(lines.join('\n'));
  else if (lang === 'console' || lang === 'psql') htmlLines = lines.map(hlConsole);
  else if (lang === 'json') htmlLines = lines.map(hlJson);
  else htmlLines = lines.map(esc);
  return htmlLines.map((h, i) => `<span class="ln${marks[i] ? ' ' + marks[i] : ''}">${h || ' '}</span>`).join('');
}
