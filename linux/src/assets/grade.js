// 本文の実行ブロックと確認問題の「意味」を 1 か所に決める（DOM を使わない）。
// 画面（ブラウザ）と、章の検査スクリプト（Node）が同じものを使うので、判定が食い違わない。
// 必要なもの：LNX（kernel.js ほか）が先に読み込まれていること。
//
// ■ フェンスの info 文字列を opts にする
//   GRADE.parseInfo('sh run title="..." error root strace') → { lang, flags:Set, attrs:{} }
//
// ■ ページの機械
//   GRADE.boot(setupSrcs?) → sys     起動して、章の ```sh setup``` を順に流した機械（ページの初期状態）。setup が失敗したら例外
//
// ■ 実行ブロック 1 つ（```sh run```）を実行する
//   GRADE.split(src) → [コマンド…]   ブロックを「端末に 1 回で打つ単位」に分ける（if や for の途中、閉じていない引用符は次の行とつなげる）。
//                                     空行とコメントだけの行は前のコマンドにつける（表示用に残す）
//   GRADE.runBlock(sys, src, info) → { ok, failed, steps:[{ cmd, user, prompt, r }], message }
//     sys の上で順に実行する（ページの機械は積み上がる）。r は sys.run の結果。
//     属性：root（root のシェルで）、user="alice"、strace（= sys.run の strace: true）、strace="all"、
//           stdin="..."（\n が使える。最初のコマンドに渡す）、keys="^C@500,^Z@800"（最初のコマンドで、仮想時間の何ミリ秒後に押すか）、
//           maxticks="N"、limit（打ち切られるのが正しい例。無限ループ、ブロックする例）
//     failed = どれかのコマンドの終了ステータスが 0 以外か、打ち切られた（limit の印があれば打ち切りは数えない）
//     ok     = error の印があれば failed、なければ !failed（「印のとおりに終わった」）
//
// ■ 確認問題を採点する
//   GRADE.quiz(q, userSrc, base) → { verdict: 'ok'|'ng'|'error'|'empty', msg, exp, got, run }
//     q = { answer, info, check?, prep?, vary?:[…] }   info は answer のフェンスの info 文字列
//     base = GRADE.boot(章の setup) の機械（clone して使うので変わらない）
//     模範解答と読者のコマンドを、それぞれ base の clone + prep で実行して、標準出力を比べる。
//       check があれば、それぞれの実行の後に check を実行した標準出力を比べる（ファイルを作る・権限を変える問題）。
//       vary があれば、base + prep + vary（1 つずつ）でもう一度両方を実行して比べる（答えの数字を直接書いただけでは通らないように）。
//     比べ方：行末の空白と最後の空行は無視。unordered の印なら行の順番を問わない。exit の印なら終了ステータスも比べる。
//     forbid="sort,uniq"：読者の実行でそのコマンドが exec されたら不正解。require="grep"：exec されなければ不正解。
//     root / user="..." の属性：模範解答と読者のコマンドをそのユーザーで実行する。
//   exp / got は表示用：{ stdout, stderr, exit, check }
(function (root) {
  'use strict';
  const LNX = () => root.LNX;

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

  // ---------------------------------------------------------------- 分ける
  const blankOrComment = (l) => /^\s*(#.*)?$/.test(l);
  function split(src) {
    const lines = String(src || '').replace(/\n+$/, '').split('\n');
    const cmds = [];
    let cur = [], lead = [];
    for (const l of lines) {
      if (!cur.length && blankOrComment(l)) { lead.push(l); continue; }
      cur.push(l);
      const pr = LNX().sh.parse(cur.join('\n'));
      if (pr.incomplete || /\\$/.test(l)) continue;
      cmds.push({ cmd: cur.join('\n'), lead: lead.join('\n') });
      cur = []; lead = [];
    }
    if (cur.length) cmds.push({ cmd: cur.join('\n'), lead: lead.join('\n') });
    return cmds;
  }

  // ---------------------------------------------------------------- 実行
  function userOf(p) { return p.attrs.user || (p.flags.has('root') ? 'root' : undefined); }

  function runOpts(p, first) {
    const o = {};
    const u = userOf(p);
    if (u) o.user = u;
    if (p.flags.has('strace')) o.strace = true;
    if (p.attrs.strace) o.strace = p.attrs.strace === 'all' ? 'all' : true;
    if (p.attrs.maxticks) o.maxTicks = Number(p.attrs.maxticks);
    if (p.attrs.trace) o.trace = p.attrs.trace;
    if (first && p.attrs.stdin !== undefined) o.stdin = unesc(p.attrs.stdin);
    if (first && p.attrs.keys) {
      o.keys = p.attrs.keys.split(',').map((s) => { const [key, at] = s.trim().split('@'); return { key, at: Number(at) || 0 }; });
    }
    return o;
  }

  function runBlock(sys, src, info) {
    const p = P(info);
    const steps = [];
    let failed = false, msg = '';
    split(src).forEach((c, i) => {
      const o = runOpts(p, i === 0);
      const prompt = sys.prompt(o.user);
      const r = sys.run(c.cmd, o);
      steps.push({ cmd: c.cmd, lead: c.lead, user: o.user, prompt, r });
      if (r.cut && !p.flags.has('limit')) { failed = true; msg = msg || r.message; }
      else if (!r.cut && r.exit !== 0) { failed = true; msg = msg || `終了ステータス ${r.exit}：${c.cmd.split('\n')[0]}`; }
    });
    const ok = p.flags.has('error') ? failed : !failed;
    return { ok, failed, steps, message: msg };
  }

  function boot(setups, opts) {
    const sys = LNX().boot(Object.assign({ seed: 1 }, opts || {}));
    for (const s of setups || []) {
      const src = typeof s === 'string' ? s : s.src;
      const info = typeof s === 'string' ? 'sh setup' : s.info || 'sh setup';
      const r = runBlock(sys, src, info);
      if (r.failed) throw new Error('setup が失敗しました：' + r.message);
    }
    return sys;
  }

  // ---------------------------------------------------------------- 採点
  const isEmpty = (s) => !String(s || '').split('\n').some((l) => !blankOrComment(l));
  const norm = (s) => String(s || '').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');

  // 1 回分：base の clone + prep + extra（vary）の上で cmd を実行し、check も実行する
  function attempt(base, q, p, cmd, extra) {
    const sys = base.clone();
    const asUser = userOf(p);
    for (const pre of [q.prep, extra]) {
      if (!pre) continue;
      const r = runBlock(sys, pre, 'sh setup');
      if (r.failed) return { setupError: r.message };
    }
    const r = sys.run(cmd, asUser ? { user: asUser } : {});
    const execs = (r.events || []).filter((e) => e.type === 'exec').map((e) => String(e.path).split('/').pop());
    const out = { stdout: r.stdout, stderr: r.stderr, exit: r.exit, cut: r.cut, message: r.message, execs, r };
    if (q.check && !r.cut) {
      const c = sys.run(q.check, { user: 'root' });
      out.check = c.stdout;
      out.checkErr = c.stderr;
    }
    return out;
  }

  function lines(s, unordered) {
    const a = norm(s).split('\n');
    return unordered ? a.slice().sort() : a;
  }
  function diff(e, g, unordered, what) {
    const a = lines(e, unordered), b = lines(g, unordered);
    if (a.join('\n') === b.join('\n')) return null;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    if (unordered) return `${what}の行が違います（並べ替えて比べています）。`;
    return `${what}が違います（${i + 1} 行目から）。`;
  }

  function compare(exp, got, q, p) {
    const un = p.flags.has('unordered');
    if (q.check) {
      const d = diff(exp.check, got.check, un, '確かめのコマンドの出力');
      if (d) return d;
    } else {
      const d = diff(exp.stdout, got.stdout, un, '標準出力');
      if (d) return d;
    }
    if (p.flags.has('exit') && exp.exit !== got.exit) return `終了ステータスが違います（期待 ${exp.exit}、あなたの結果 ${got.exit}）。`;
    return null;
  }

  const pick = (o) => o && { stdout: o.stdout, stderr: o.stderr, exit: o.exit, check: o.check };

  function quiz(q, userSrc, base) {
    if (isEmpty(userSrc)) return { verdict: 'empty', msg: 'コマンドを書いてから「答え合わせ」を押してください。' };
    const p = parseInfo(q.info || 'sh answer');
    const variants = [null].concat(q.vary || []);
    const forbid = (p.attrs.forbid || '').split(',').map((s) => s.trim()).filter(Boolean);
    const require = (p.attrs.require || '').split(',').map((s) => s.trim()).filter(Boolean);
    let first = null;
    for (let k = 0; k < variants.length; k++) {
      const exp = attempt(base, q, p, q.answer, variants[k]);
      if (exp.setupError) return { verdict: 'error', msg: `問題の準備に失敗しました（${exp.setupError}）` };
      if (exp.cut) return { verdict: 'error', msg: `模範解答が打ち切られました（${exp.message}）` };
      const got = attempt(base, q, p, userSrc, variants[k]);
      const res = { exp: pick(exp), got: pick(got), run: got.r, variant: k };
      if (!first) first = res;
      if (got.cut) return Object.assign(res, { verdict: 'ng', msg: got.message || '打ち切られました。終わらないコマンドがないか確かめてください。' });
      const bad = forbid.find((c) => got.execs.includes(c));
      if (bad) return Object.assign(res, { verdict: 'ng', msg: `この問題では ${bad} を使わずに書いてください。` });
      const miss = require.find((c) => !got.execs.includes(c));
      if (miss) return Object.assign(res, { verdict: 'ng', msg: `この問題では ${miss} を使って書いてください。` });
      const why = compare(exp, got, q, p);
      if (why) {
        const note = k > 0 ? '（準備のデータを少し変えて試したところ）' : '';
        return Object.assign(res, { verdict: 'ng', msg: note + why });
      }
    }
    return Object.assign(first, { verdict: 'ok', msg: '出力が模範解答と一致しました。' });
  }

  root.GRADE = { parseInfo, split, runBlock, boot, quiz, norm };
})(typeof window !== 'undefined' ? window : globalThis);
