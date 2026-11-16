// 本文の実行ブロックと確認問題の「意味」を 1 か所に決める（DOM を使わない）。画面（ブラウザ）と章の検査スクリプト（Node）が同じものを使う。
// 必要なもの：GCP（core.js ほか、lib/gcp-files.mjs の順）が先に読み込まれていること。どれも Promise を返す（BigQuery と Cloud SQL のエンジンが非同期のため）。
//
// ■ GRADE.parseInfo('sh run title="..." error stdin="y\n"') → { lang, flags:Set, attrs:{} }
// ■ GRADE.boot(setups) → Promise<sys>        起動して、章の ```sh setup``` を順に流した機械。setup が失敗したら例外
// ■ GRADE.split(src) → [{ cmd, lead }]       ブロックを「端末に 1 回で打つ単位」に分ける（ヒアドキュメント、for、閉じていない引用符は次の行とつなげる）
// ■ GRADE.runBlock(sys, src, info) → Promise<{ ok, failed, steps:[{ cmd, lead, prompt, r }], message }>
//     属性：error（どれかのコマンドが 0 以外で終わるのが正しい例）、stdin="..."（\n が使える。最初のコマンドの標準入力）
//     ok = error の印があれば failed、なければ !failed
// ■ GRADE.quiz(q, userSrc, base) → Promise<{ verdict: 'ok'|'ng'|'error'|'empty', msg, exp, got, variant }>
//     q = { answer, info, check?, prep?, vary?:[…] }。base は GRADE.boot(章の setup) の機械（clone して使うので変わらない）
//     模範解答と読者のコマンドを、それぞれ base の clone + prep（+ vary）で実行して、標準出力を比べる。check があれば、実行の後の check の標準出力を比べる。
//     比べ方：行末の空白と最後の空行は無視。unordered なら行の順番を問わない。exit なら終了ステータスも比べる。
//     forbid="a,b"：読者のコマンドにその単語があれば不正解。require="a"：なければ不正解。
(function (root) {
  'use strict';
  const G = () => root.GCP;

  function parseInfo(info) {
    const out = { lang: '', flags: new Set(), attrs: {} };
    const re = /(\w+)="([^"]*)"|(\S+)/g;
    let m, first = true;
    while ((m = re.exec(info || ''))) {
      if (first && !m[1]) { out.lang = m[3]; first = false; continue; }
      first = false;
      if (m[1]) out.attrs[m[1]] = m[2];
      else out.flags.add(m[3]);
    }
    return out;
  }
  const P = (info) => (typeof info === 'string' ? parseInfo(info) : info || parseInfo('sh'));
  const unesc = (s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

  const blankOrComment = (l) => /^\s*(#.*)?$/.test(l);
  function split(src) {
    const lines = String(src || '').replace(/\n+$/, '').split('\n');
    const cmds = [];
    let cur = [], lead = [];
    for (const l of lines) {
      if (!cur.length && blankOrComment(l)) { lead.push(l); continue; }
      cur.push(l);
      const pr = G().sh.parse(cur.join('\n') + '\n');
      if (pr.incomplete || /\\$/.test(l)) continue;
      cmds.push({ cmd: cur.join('\n'), lead: lead.join('\n') });
      cur = []; lead = [];
    }
    if (cur.length) cmds.push({ cmd: cur.join('\n'), lead: lead.join('\n') });
    return cmds;
  }

  async function runBlock(sys, src, info) {
    const p = P(info);
    const steps = [];
    let failed = false, msg = '';
    const list = split(src);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const prompt = sys.prompt();
      const o = {};
      if (i === 0 && p.attrs.stdin !== undefined) o.stdin = unesc(p.attrs.stdin);
      const r = await sys.run(c.cmd + '\n', o);
      steps.push({ cmd: c.cmd, lead: c.lead, prompt, r });
      if (r.exit !== 0) { failed = true; msg = msg || `終了ステータス ${r.exit}：${c.cmd.split('\n')[0]}`; }
    }
    const ok = p.flags.has('error') ? failed : !failed;
    return { ok, failed, steps, message: msg };
  }

  async function boot(setups) {
    const sys = G().boot();
    for (const s of setups || []) {
      const src = typeof s === 'string' ? s : s.src;
      const r = await runBlock(sys, src, 'sh setup');
      if (r.failed) throw new Error('setup が失敗しました：' + r.message + '\n' + r.steps.map((x) => x.r.stderr).join('').slice(0, 600));
    }
    return sys;
  }

  const isEmpty = (s) => !String(s || '').split('\n').some((l) => !blankOrComment(l));
  const norm = (s) => String(s || '').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');

  async function attempt(base, q, p, cmd, extra) {
    const sys = base.clone();
    for (const pre of [q.prep, extra]) {
      if (!pre) continue;
      const r = await runBlock(sys, pre, 'sh setup');
      if (r.failed) return { setupError: r.message };
    }
    const r = await sys.run(cmd + '\n', {});
    const out = { stdout: r.stdout, stderr: r.stderr, exit: r.exit, r };
    if (q.check) { const k = await sys.run(q.check + '\n', {}); out.check = k.stdout; out.checkErr = k.stderr; }
    return out;
  }
  function same(p, q, a, b) {
    const pick = (o) => norm(q.check ? o.check : o.stdout);
    let x = pick(a), y = pick(b);
    if (p.flags.has('unordered')) { x = x.split('\n').sort().join('\n'); y = y.split('\n').sort().join('\n'); }
    if (x !== y) return false;
    if (p.flags.has('exit') && a.exit !== b.exit) return false;
    return true;
  }
  const words = (src) => String(src).replace(/#.*$/gm, '').split(/[\s|;&()$`'"=]+/).filter(Boolean);
  async function quiz(q, userSrc, base) {
    if (isEmpty(userSrc)) return { verdict: 'empty', msg: 'コマンドを書いてから「答え合わせ」を押してください。' };
    const p = P(q.info || 'sh answer');
    const ws = words(userSrc);
    if (p.attrs.forbid) { const bad = p.attrs.forbid.split(',').map((s) => s.trim()).find((x) => ws.includes(x)); if (bad) return { verdict: 'ng', msg: `この問題では ${bad} を使わずに書いてください。` }; }
    if (p.attrs.require) { const miss = p.attrs.require.split(',').map((s) => s.trim()).find((x) => !ws.includes(x)); if (miss) return { verdict: 'ng', msg: `この問題では ${miss} を使ってください。` }; }
    const variants = [null].concat(q.vary || []);
    for (let v = 0; v < variants.length; v++) {
      const exp = await attempt(base, q, p, q.answer, variants[v]);
      if (exp.setupError) return { verdict: 'error', msg: '問題の準備が失敗しました（サイトの不具合です）：' + exp.setupError };
      const got = await attempt(base, q, p, userSrc, variants[v]);
      if (got.setupError) return { verdict: 'error', msg: '問題の準備が失敗しました：' + got.setupError };
      if (!same(p, q, exp, got)) {
        let msg = q.check ? '実行した後の状態が、期待と違います。' : '出力が、期待と違います。';
        if (p.flags.has('exit') && exp.exit !== got.exit && norm(exp.stdout) === norm(got.stdout)) msg = `終了ステータスが違います（期待 ${exp.exit}、あなた ${got.exit}）。`;
        if (got.exit === 127) msg += '（見つからないコマンドがあります）';
        return { verdict: 'ng', msg, exp, got, variant: v };
      }
      if (v === variants.length - 1) return { verdict: 'ok', msg: variants.length > 1 ? `データを ${variants.length - 1} 通り変えても、同じ結果になりました。` : '期待どおりの結果です。', exp, got };
    }
    return { verdict: 'error', msg: '判定できませんでした' };
  }

  root.GRADE = { parseInfo, split, runBlock, boot, quiz, norm, isEmpty };
})(typeof window !== 'undefined' ? window : globalThis);
