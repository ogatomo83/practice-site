// 確認問題の検査：各章の採点用 DB を作り、模範解答が通ること・出力が安定していること・
// 別解が正解に、誤答が不正解になることを確かめる。
// 使い方: node verify.mjs <site ディレクトリ> [章の slug ...]
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const SITE = process.argv[2];
const only = process.argv.slice(3);
await import(path.resolve(SITE, 'assets/sqlhl.js'));
await import(path.resolve(SITE, 'assets/quiz.js'));
const { split } = globalThis.SQLHL;
const { attempt, compare, HELPER } = globalThis.QZCORE;

const EXT = ['pageinspect', 'pg_walinspect', 'pg_visibility', 'pg_freespacemap', 'pg_buffercache', 'pg_trgm', 'pgcrypto', 'hstore'];
const exts = {};
for (const e of EXT) { try { exts[e] = (await import(`@electric-sql/pglite/contrib/${e}`))[e]; } catch (err) { console.log('no ext', e); } }
const raw = {};
for (let i = 1; i < 8000; i++) raw[i] = (x) => x;

const unesc = (s) => s.replace(/\\u003c/g, '<');
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// 別解（正解になるべき）と誤答（不正解になるべき）
const ALT = JSON.parse(fs.readFileSync(new URL('./alts.json', import.meta.url), 'utf8'));

let fail = 0;
const files = fs.readdirSync(SITE).filter((f) => /^ch\d+\.html$/.test(f)).sort();
for (const f of files) {
  const slug = f.replace('.html', '');
  if (only.length && !only.includes(slug)) continue;
  const html = fs.readFileSync(path.join(SITE, f), 'utf8');
  const qs = [...html.matchAll(/<section class="qz" data-qid="([^"]+)">[\s\S]*?<script type="application\/json" class="qz-data">([\s\S]*?)<\/script>/g)];
  if (!qs.length) continue;
  const setup = JSON.parse(unesc(html.match(/<script type="application\/json" id="pg-setup">([\s\S]*?)<\/script>/)[1])).sql;
  const t0 = Date.now();
  const db = await PGlite.create({ extensions: exts, parsers: raw });
  await db.exec(`set timezone = 'Asia/Tokyo'; set datestyle = 'ISO, YMD'; set stats_fetch_consistency = none;`);
  for (const s of split(setup + '\n;\n' + HELPER)) await db.exec(s);
  console.log(`\n=== ${slug} (${qs.length} 問, 起動 ${Date.now() - t0} ms)`);
  for (const [, qid, json] of qs) {
    const d = JSON.parse(unesc(json));
    const t1 = Date.now();
    const a = await attempt(db, split, { prep: d.p, sql: d.a, check: d.c });
    if (a.err) { fail++; console.log(`  ✗ ${qid} 模範解答がエラー: ${a.err.message}\n    ${a.sql}`); continue; }
    const b = await attempt(db, split, { prep: d.p, sql: d.a, check: d.c });
    const same = compare(a.res, b.res, d.o);
    const rows = a.res.rows || [];
    const preview = rows.slice(0, 4).map((r) => r.map((v) => (v === null ? 'NULL' : String(v))).join(' | ')).join(' / ');
    const flag = !same.ok ? '✗ 2 回目と出力が違う' : !rows.length ? '⚠ 0 行' : '✓';
    if (!same.ok) fail++;
    console.log(`  ${flag} ${qid} ${rows.length}行×${(a.res.fields || []).length}列 ${Date.now() - t1}ms  ${preview.slice(0, 140)}`);
    const alt = ALT[qid] || {};
    for (const [kind, list] of [['ok', alt.ok || []], ['ng', alt.ng || []]]) {
      for (const sql of list) {
        const g = await attempt(db, split, { prep: d.p, sql, check: d.c });
        const r = g.err ? { ok: false, why: 'error: ' + g.err.message } : compare(a.res, g.res, d.o);
        const good = kind === 'ok' ? r.ok : !r.ok;
        if (!good) fail++;
        console.log(`      ${good ? '·' : '✗'} ${kind === 'ok' ? '別解' : '誤答'} → ${r.ok ? '正解' : '不正解(' + r.why + ')'}${r.colOrder ? ' 列順違い' : ''}  ${sql.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  }
  await db.close();
}
console.log(fail ? `\n${fail} 件の問題あり` : '\nすべて OK');
process.exit(fail ? 1 : 0);
