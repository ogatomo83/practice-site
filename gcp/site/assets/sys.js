// 1 台の「Cloud Shell + 小さな GCP」。ページに 1 つ、確認問題では clone して使う。
//   GCP.boot() → sys
//   sys.run(src, { stdin }) → Promise<{ out:[{s:'out'|'err', text}], stdout, stderr, exit, ms }>
//   sys.clone() → 同じ状態の別の sys（世界も手元のファイルも、深くコピーする）
//   sys.prompt() → 'you@cloudshell:~ (tsubame-shop)$ '
(function (root) {
  'use strict';
  const G = root.GCP = root.GCP || {};

  function initialWorld() {
    const w = G.newWorld();
    w.creds = ['you@tsubame.example'];
    // 最初からあるプロジェクト：つばめ文具の本番の店（請求先つき）
    const p = G.makeProject(w, 'tsubame-shop', { name: 'つばめ文具 オンライン店', creator: 'you@tsubame.example' });
    p.createTime = '2025-04-08T01:22:10.512Z';
    p.billing = G.BILLING_ID;
    p.labels = { env: 'prod' };
    p.services.push('iam.googleapis.com', 'iamcredentials.googleapis.com');
    w.cfg.configurations.default.core.project = 'tsubame-shop';
    if (G.ON_BOOT) for (const f of G.ON_BOOT) f(w);
    return w;
  }
  G.ON_BOOT = G.ON_BOOT || [];

  class Sys {
    constructor(w, sh) { this.w = w; this.sh = sh; }
    prompt() { return G.prompt(this); }
    clone() { return new Sys(G.clone(this.w), G.clone(this.sh)); }
    async run(src, opts = {}) {
      const out = [];
      const add = (s, text) => { if (!text) return; const last = out[out.length - 1]; if (last && last.s === s) last.text += text; else out.push({ s, text }); };
      const io = { stdin: opts.stdin || '', out: (t) => add('out', t), err: (t) => add('err', t) };
      this.io = io;
      const t0 = this.w.t;
      let exit;
      this.sh.exited = false;
      try { exit = await G.sh.run(this, src, io); if (G.drain && !this.vm) await G.drain(this); }
      catch (e) { add('err', `内部エラー：${(e && e.stack) || e}\n`); exit = 70; }
      G.tick(this.w, 0);
      return {
        out, exit,
        stdout: out.filter((x) => x.s === 'out').map((x) => x.text).join(''),
        stderr: out.filter((x) => x.s === 'err').map((x) => x.text).join(''),
        ms: this.w.t - t0,
      };
    }
  }
  G.boot = () => new Sys(initialWorld(), G.sh.newState());
  G.Sys = Sys;
})(typeof window !== 'undefined' ? window : globalThis);
