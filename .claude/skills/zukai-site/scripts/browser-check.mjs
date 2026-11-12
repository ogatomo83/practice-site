import puppeteer from 'puppeteer-core';
const SITE = process.argv[2];
const OUT = process.argv[3];
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

async function answer(qid, sql) {
  const sel = `.qz[data-qid="${qid}"]`;
  await page.$eval(`${sel} .ed-ta`, (ta, v) => { ta.value = v; ta.dispatchEvent(new Event('input')); }, sql);
  await page.click(`${sel} .qz-check`);
  await page.waitForFunction((s) => { const r = document.querySelector(s + ' .qz-res'); return r && !r.hidden && r.querySelector('.qz-v') && !document.querySelector(s).classList.contains('is-running'); }, { timeout: 60000 }, sel);
  return page.$eval(`${sel} .qz-res`, (r) => r.querySelector('.qz-v').innerText.replace(/\s+/g, ' '));
}

await page.goto(`file://${SITE}/ch03.html`);
console.log('ch03-1 correct :', await answer('ch03-1', 'select name, price from products where price between 1000 and 5000 order by price desc'));
console.log('ch03-1 order   :', await answer('ch03-1', 'select name, price from products where price between 1000 and 5000 order by price'));
console.log('ch03-2 error   :', await answer('ch03-2', 'select nam from products'));
console.log('ch03-2 tx      :', await answer('ch03-2', 'begin;\nselect name from products where name like \'%ノート%\';\ncommit;'));
console.log('ch03-2 empty   :', await answer('ch03-2', '-- まだ'));
console.log('ch03-4 wrong   :', await answer('ch03-4', 'select name, stock from products'));
console.log('mark ch03-1    :', await page.$eval('.qz[data-qid="ch03-1"] .qz-mark', (m) => !m.hidden));
// 本文の DB に影響していないか（本文の DB はまだ起動していないはず）
console.log('main db booted :', await page.evaluate(() => window.PG.isBooted()));
await page.$eval('.qz[data-qid="ch03-1"]', (e) => e.scrollIntoView({ block: 'start' }));
await page.evaluate(() => window.scrollBy(0, -70));
await page.screenshot({ path: `${OUT}/ch03-quiz.png` });

await page.goto(`file://${SITE}/ch06.html`);
console.log('ch06-2 correct :', await answer('ch06-2', "delete from order_items where order_id in (select id from orders where status = 'cancelled')"));
console.log('ch06-2 again   :', await answer('ch06-2', "delete from order_items where order_id in (select id from orders where status = 'cancelled')"));
// 本文の DB を起動して、確認問題の削除が影響していないことを見る
const n = await page.evaluate(async () => { const r = await window.PG.run('select count(*) from order_items'); return r.results[0].res.rows[0][0]; });
console.log('main order_items count (expect 35):', n);
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await page.$eval('.qz[data-qid="ch06-1"]', (e) => e.scrollIntoView({ block: 'start' }));
console.log('ch06-1 wrong   :', await answer('ch06-1', "update products set price = price * 1.1 where name like '%ノート%'"));
await page.$eval('.qz[data-qid="ch06-1"] .qz-exp', (d) => (d.open = true));
await page.$eval('.qz[data-qid="ch06-1"] .qz-fold', (d) => (d.open = true));
await page.$eval('.qz[data-qid="ch06-1"]', (e) => e.scrollIntoView({ block: 'start' }));
await page.evaluate(() => window.scrollBy(0, -70));
await page.screenshot({ path: `${OUT}/ch06-dark.png` });

await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await page.goto(`file://${SITE}/ch14.html#quiz`);
const t0 = Date.now();
console.log('ch14-1 correct :', await answer('ch14-1', 'create index on members (lower(email))'), `${Date.now() - t0}ms (boot含む)`);
await page.$eval('.qz[data-qid="ch14-1"]', (e) => e.scrollIntoView({ block: 'start' }));
await page.evaluate(() => window.scrollBy(0, -60));
await page.screenshot({ path: `${OUT}/ch14-mobile.png` });
const hscroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log('mobile horizontal scroll:', hscroll);
console.log('page errors:', errs.length ? errs : 'none');
await browser.close();
