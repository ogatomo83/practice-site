// 実験場：Cloud Shell 風の端末。Enter で実行（引用符やヒアドキュメントが閉じていなければ改行）、↑↓ で履歴。横に「クラウドを見る」。
(() => {
  const GCP = window.GCP, GRADE = window.GRADE, UI = window.GCPUI, VIEW = window.GCPVIEW, HL = window.HL;
  const $ = (s) => document.querySelector(s);
  const term = $('#play-term');
  if (!term || !GCP || !UI || !VIEW) return;
  const out = $('#play-out'), inp = $('#play-in'), pr = $('#play-pr'), scroll = $('#play-scroll');
  let sysP = GRADE.boot([]);
  const hist = UI.store.get('play-hist', []);
  let hi = hist.length;
  const view = VIEW.mount($('#play-view'), { getSys: () => sysP });
  const setPrompt = async () => { const s = await sysP; pr.textContent = s.prompt(); };
  const print = (html) => { out.insertAdjacentHTML('beforeend', html); scroll.scrollTop = scroll.scrollHeight; };
  const fit = () => { inp.rows = Math.max(1, inp.value.split('\n').length); };
  print('<div class="tm-note">図解 GCP の Cloud Shell（ブラウザの中の小さな GCP）です。gcloud、bq、curl、node などが使えます。本物の Google Cloud にはつながりません。</div>');
  setPrompt();
  async function run(src) {
    const s = await sysP;
    const prompt = s.prompt();
    inp.disabled = true;
    try {
      const r = await UI.serial(() => s.run(src + '\n'));
      print(`<div class="tm">${UI.termHTML([{ cmd: src, lead: '', prompt, r }])}</div>`);
    } catch (e) { print(UI.errBox('実行できませんでした', [String(e.message || e)])); }
    inp.disabled = false;
    inp.focus();
    await setPrompt();
    view.update();
  }
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const src = inp.value;
      if (!src.trim()) { e.preventDefault(); return; }
      if (GCP.sh.parse(src + '\n').incomplete) return;   // 閉じていない：改行を入れる
      e.preventDefault();
      hist.push(src); if (hist.length > 200) hist.shift(); hi = hist.length; UI.store.set('play-hist', hist);
      inp.value = ''; fit();
      run(src);
      return;
    }
    if (e.key === 'ArrowUp' && !inp.value.includes('\n') && hi > 0) { e.preventDefault(); inp.value = hist[--hi]; fit(); return; }
    if (e.key === 'ArrowDown' && !inp.value.includes('\n')) { e.preventDefault(); hi = Math.min(hist.length, hi + 1); inp.value = hist[hi] || ''; fit(); }
  });
  inp.addEventListener('input', fit);
  term.addEventListener('click', (e) => { if (!e.target.closest('button, a, textarea') && !window.getSelection().toString()) inp.focus(); });
  $('#play-clear').addEventListener('click', () => { out.innerHTML = ''; inp.focus(); });
  $('#play-reset').addEventListener('click', async () => { sysP = GRADE.boot([]); out.innerHTML = ''; await setPrompt(); view.update(); inp.focus(); });
  // サンプル（選ぶと入力欄に入る）
  const SAMPLES = [
    ['いまの設定とプロジェクト', 'gcloud config list\ngcloud projects list'],
    ['プロジェクトの祖先（階層）', 'gcloud projects get-ancestors tsubame-shop'],
    ['だれが何のロールを持つか', 'gcloud projects get-iam-policy tsubame-shop --flatten="bindings[].members" --format="table(bindings.role, bindings.members)"'],
    ['バケットを作って公開する', 'gcloud storage buckets create gs://tsubame-play-$RANDOM --location=asia-northeast1'],
    ['Cloud Run にデプロイ', 'gcloud services enable run.googleapis.com\ngcloud run deploy hello --image=us-docker.pkg.dev/cloudrun/container/hello --region=asia-northeast1 --allow-unauthenticated'],
    ['BigQuery：カテゴリ別の売上', "bq query --use_legacy_sql=false 'SELECT category, SUM(quantity * unit_price) AS sales FROM `tsubame-public.bungu.orders` JOIN `tsubame-public.bungu.products` USING (product_id) GROUP BY category ORDER BY sales DESC'"],
  ];
  const sel = $('#play-sample');
  sel.innerHTML = '<option value="">選ぶ…</option>' + SAMPLES.map((x, k) => `<option value="${k}">${UI.esc(x[0])}</option>`).join('');
  sel.addEventListener('change', () => { if (sel.value === '') return; inp.value = SAMPLES[Number(sel.value)][1]; fit(); inp.focus(); sel.value = ''; });
  void HL;
})();
