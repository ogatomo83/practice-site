// 「クラウドを見る」：小さな GCP のいまの状態（組織・フォルダ・プロジェクト・リソースの木と IAM、人とサービスアカウント、API と請求、監査ログ）を見せる。
//   GCPVIEW.mount(host, { getSys, tabsEl }) → { update(), el }      GCPVIEW.openPanel()
//   GCPVIEW.sections.push({ id, title, render(ctx) → HTML, bind?(el, ctx) })   ctx = { sys, state, esc, redraw, added }
(() => {
  const GCP = window.GCP, UI = window.GCPUI;
  if (!GCP || !UI) return;
  const $ = (s, r = document) => r.querySelector(s);
  const { esc, store } = UI;
  const empty = (t) => `<p class="dbv-pad muted">${t}</p>`;
  const short = (m) => m.replace(/^(user|group|serviceAccount|domain):/, '');
  const KIND_JA = { user: 'ユーザー', group: 'グループ', serviceAccount: 'サービスアカウント', domain: 'ドメイン', allUsers: '全員（未認証を含む）', allAuthenticatedUsers: 'ログインした全員', projectOwner: 'プロジェクトの owner', projectEditor: 'プロジェクトの editor', projectViewer: 'プロジェクトの viewer' };
  const kindOf = (m) => (m === 'allUsers' || m === 'allAuthenticatedUsers' ? m : m.split(':')[0]);

  // ---------------------------------------------------------------- 木（組織 → フォルダ → プロジェクト → リソース）
  function tree(w) {
    const nodes = [];
    const add = (id, label, kind, parent, extra) => nodes.push(Object.assign({ id, label, kind, parent }, extra || {}));
    add('organizations/' + w.org.id, w.org.domain, 'org', null, { sub: '組織 ' + w.org.id });
    for (const f of Object.values(w.folders)) if (f.lifecycleState === 'ACTIVE') add('folders/' + f.id, f.displayName, 'folder', f.parent, { sub: 'フォルダ ' + f.id });
    for (const p of Object.values(w.projects)) {
      if (p.lifecycleState === 'DELETED') continue;
      const pid = 'projects/' + p.projectId;
      add(pid, p.projectId, 'project', !p.parent ? null : p.parent.type === 'folder' ? 'folders/' + p.parent.id : 'organizations/' + p.parent.id, { sub: `${p.name} ・ ${p.projectNumber}${p.billing ? ' ・ 請求先あり' : ' ・ 請求先なし'}${p.lifecycleState !== 'ACTIVE' ? ' ・ 削除の予約中' : ''}` });
      const S = w.svc;
      for (const [n, b] of Object.entries(S.storage.buckets)) if (b.project === p.projectId) add(`projects/${p.projectId}/buckets/${n}`, 'gs://' + n, 'bucket', pid, { sub: `${b.location} ・ ${Object.keys(b.objects).length} 個` });
      for (const v of Object.values(S.compute.vms)) if (v.project === p.projectId) add(`projects/${p.projectId}/zones/${v.zone}/instances/${v.name}`, v.name, 'vm', pid, { sub: `VM ・ ${v.zone} ・ ${v.status}${v.natIP ? ' ・ ' + v.natIP : ''}` });
      for (const s of Object.values(S.run.services)) if (s.project === p.projectId) add(`projects/${p.projectId}/locations/${s.region}/services/${s.name}`, s.name, 'run', pid, { sub: `Cloud Run ・ ${s.region} ・ リビジョン ${s.revs.length}` });
      for (const t of Object.values(S.pubsub.topics)) if (t.project === p.projectId) add(`projects/${p.projectId}/topics/${t.name}`, t.name, 'topic', pid, { sub: 'トピック' });
      for (const s of Object.values(S.pubsub.subs)) if (s.project === p.projectId) add(`projects/${p.projectId}/subscriptions/${s.name}`, s.name, 'sub', pid, { sub: `サブスクリプション ・ 未確認 ${s.msgs.length} 件${s.push ? ' ・ push' : ''}` });
      for (const [k, d] of Object.entries(S.firestore.dbs)) if (k.startsWith(p.projectId + '/')) add(`projects/${p.projectId}/databases/${k.split('/')[1]}`, `Firestore ${k.split('/')[1]}`, 'fs', pid, { sub: `${d.location} ・ 文書 ${Object.keys(d.docs).length}` });
      for (const i of Object.values(S.sql.instances)) if (i.project === p.projectId) add(`projects/${p.projectId}/instances/${i.name}`, i.name, 'sql', pid, { sub: `Cloud SQL ・ ${i.version} ・ ${i.activation === 'NEVER' ? 'STOPPED' : i.state}` });
      for (const [k, d] of Object.entries(S.bq.ds)) if (k.startsWith(p.projectId + ':')) add(`projects/${p.projectId}/datasets/${k.split(':')[1]}`, k.split(':')[1], 'ds', pid, { sub: `データセット ・ ${d.location} ・ テーブル ${Object.keys(d.tables).length}` });
      for (const [e, s] of Object.entries(p.sas || {})) if (!s.deleted) add(`projects/${p.projectId}/serviceAccounts/${e}`, e.replace(/@.*/, '@…'), 'sa', pid, { sub: 'サービスアカウント' });
    }
    return nodes;
  }
  const ICON = { org: '◆', folder: '▣', project: '■', bucket: '▤', vm: '▥', run: '▶', topic: '✉', sub: '↳', fs: '⬡', sql: '⛁', ds: '▦', sa: '⚙' };
  function treeHTML(w, sel, added) {
    const nodes = tree(w);
    const kids = {};
    for (const n of nodes) (kids[n.parent] = kids[n.parent] || []).push(n);
    const ownPol = (id) => { const p = w.policies[id]; return p ? p.bindings.reduce((k, b) => k + b.members.length, 0) : 0; };
    const walk = (n, d) => {
      const pol = ownPol(n.id);
      const row = `<button type="button" class="gv-node is-${n.kind}${n.id === sel ? ' is-sel' : ''}${added.has(n.id) ? ' is-add' : ''}" data-id="${esc(n.id)}" style="padding-left:${10 + d * 16}px"><span class="gv-ic">${ICON[n.kind] || '·'}</span><span class="gv-l">${esc(n.label)}</span><span class="gv-s">${esc(n.sub || '')}</span>${pol ? `<span class="gv-pol" title="このリソースに直接付いている IAM の割り当て">IAM ${pol}</span>` : ''}</button>`;
      return row + (kids[n.id] || []).map((k) => walk(k, d + 1)).join('');
    };
    return { html: (kids[null] || []).map((n) => walk(n, 0)).join(''), nodes };
  }
  // 選んだリソースの IAM：直接のものと、上から引き継いだもの
  function iamHTML(w, id, who) {
    const chain = GCP.ancestry(w, id);
    const rows = [];
    chain.forEach((n, depth) => {
      const p = w.policies[n];
      if (!p) return;
      for (const b of p.bindings) for (const m of b.members) rows.push({ m, role: b.role, at: n, own: depth === 0, cond: b.condition });
    });
    if (!rows.length) return empty('この場所と、その上のどこにも、IAM の割り当てはありません。');
    const r2 = rows.map((x) => `<tr class="${x.own ? '' : 'gv-inh'}${GCP.matches(w, who, x.m) ? ' is-me' : ''}"><td>${esc(short(x.m))}<span class="lv-dim">（${esc(KIND_JA[kindOf(x.m)] || kindOf(x.m))}）</span></td><td><code>${esc(x.role)}</code>${x.cond ? `<span class="lv-dim">（条件：${esc(x.cond.title)}）</span>` : ''}</td><td>${x.own ? 'ここに直接' : '上から引き継ぎ：' + esc(x.at)}</td></tr>`).join('');
    return `<div class="dbv-grid"><table><thead><tr><th>だれに（プリンシパル）</th><th>どのロール</th><th>どこで付けたか</th></tr></thead><tbody>${r2}</tbody></table></div><p class="dbv-pad muted">色の付いた行は、いまの gcloud のアカウント（${esc(who || 'なし')}）に当たる割り当てです。上の階層で付けたロールは、下のすべてのリソースに効きます。</p>`;
  }
  let seen = null;
  const hierSection = {
    id: 'tree', title: '階層と IAM',
    render(ctx) {
      const w = ctx.sys.w;
      const who = GCP.cfgGet(w, 'core/account');
      const { html, nodes } = treeHTML(w, ctx.state.sel, ctx.added);
      if (!nodes.some((n) => n.id === ctx.state.sel)) ctx.state.sel = 'projects/' + (GCP.cfgGet(w, 'core/project') || 'tsubame-shop');
      const n = nodes.find((x) => x.id === ctx.state.sel) || nodes[0];
      return `<div class="gv-split"><div class="gv-tree" role="tree">${html}</div><div class="gv-side"><div class="gv-cap"><b>${esc(n.label)}</b><span>${esc(n.id)}</span></div>${iamHTML(w, n.id, who)}</div></div>`;
    },
    bind(el, ctx) { el.querySelectorAll('.gv-node').forEach((b) => b.addEventListener('click', () => { ctx.state.sel = b.dataset.id; ctx.redraw(); })); },
  };
  // ---------------------------------------------------------------- 人とアカウント
  const peopleSection = {
    id: 'who', title: 'アカウント',
    render(ctx) {
      const w = ctx.sys.w;
      const act = GCP.cfgGet(w, 'core/account');
      const ppl = Object.entries(w.people).map(([e, p]) => `<tr class="${e === act ? 'is-me' : ''}"><td>${esc(e)}</td><td>${p.kind === 'managed' ? '組織の管理されたアカウント（Cloud Identity / Workspace）' : '個人の Google アカウント'}</td><td>${esc(p.title)}</td><td>${(w.creds || []).includes(e) ? 'gcloud にログイン済み' : ''}</td></tr>`).join('');
      const grp = Object.entries(w.groups).map(([e, g]) => `<tr><td>${esc(e)}</td><td>${esc(g.displayName)}</td><td>${g.members.map(esc).join('<br>')}</td></tr>`).join('');
      const sas = [];
      for (const p of Object.values(w.projects)) for (const [e, s] of Object.entries(p.sas || {})) if (!s.deleted) sas.push(`<tr><td>${esc(e)}</td><td>${esc(p.projectId)}</td><td>${esc(s.displayName || '')}</td><td>${s.keys.filter((k) => !k.deleted).length ? `鍵 ${s.keys.filter((k) => !k.deleted).length} 個` : ''}${s.disabled ? '・無効' : ''}</td></tr>`);
      return `<div class="dbv-grid"><table><thead><tr><th>Google アカウント</th><th>種類</th><th>役目</th><th></th></tr></thead><tbody>${ppl}</tbody></table></div>
<div class="dbv-grid"><table><thead><tr><th>グループ</th><th>名前</th><th>メンバー</th></tr></thead><tbody>${grp}</tbody></table></div>
<div class="dbv-grid"><table><thead><tr><th>サービスアカウント</th><th>プロジェクト</th><th>表示名</th><th></th></tr></thead><tbody>${sas.join('') || '<tr><td class="dbv-empty" colspan="4">まだありません</td></tr>'}</tbody></table></div>`;
    },
  };
  // ---------------------------------------------------------------- API と請求
  const apiSection = {
    id: 'api', title: 'API と請求',
    render(ctx) {
      const w = ctx.sys.w;
      const rows = Object.values(w.projects).filter((p) => p.lifecycleState !== 'DELETED').map((p) => `<tr><td>${esc(p.projectId)}</td><td>${p.billing ? esc(w.billing[p.billing].displayName) + `<span class="lv-dim">（${esc(p.billing)}）</span>` : '<span class="dbv-empty">なし</span>'}</td><td>${p.services.slice().sort().map((s) => `<code>${esc(s.replace('.googleapis.com', ''))}</code>`).join(' ')}</td></tr>`).join('');
      const bud = Object.values(w.billing).flatMap((b) => b.budgets.map((x) => `<tr><td>${esc(x.displayName)}</td><td>${x.amount.toLocaleString()} ${esc(x.currency)}</td><td>${x.thresholds.map((t) => Math.round(t.percent * 100) + '%').join('、')}</td><td>${x.projects.map(esc).join('、') || 'すべて'}</td></tr>`)).join('');
      return `<div class="dbv-grid"><table><thead><tr><th>プロジェクト</th><th>請求先アカウント</th><th>有効な API</th></tr></thead><tbody>${rows}</tbody></table></div>${bud ? `<div class="dbv-grid"><table><thead><tr><th>予算</th><th>金額</th><th>通知のしきい値</th><th>対象</th></tr></thead><tbody>${bud}</tbody></table></div>` : ''}`;
    },
  };
  // ---------------------------------------------------------------- 監査ログ
  const logSection = {
    id: 'log', title: '監査ログ',
    render(ctx) {
      const w = ctx.sys.w;
      const list = w.logs.filter((e) => e.protoPayload).slice(-60).reverse();
      if (!list.length) return empty('まだ、記録された操作はありません。リソースを作ったり消したりすると、Cloud Audit Logs に「だれが・いつ・何を」が残ります。');
      return `<div class="dbv-grid"><table><thead><tr><th>時刻（UTC）</th><th>だれが</th><th>何を（methodName）</th><th>どこに</th><th>結果</th></tr></thead><tbody>${list.map((e) => { const p = e.protoPayload; const ok = !p.status || !p.status.code; return `<tr class="${ok ? '' : 'is-del'}"><td>${esc(e.timestamp.slice(11, 19))}</td><td>${esc(p.authenticationInfo.principalEmail)}</td><td><code>${esc(p.methodName)}</code></td><td>${esc(p.resourceName || '')}</td><td>${ok ? '許可' : '拒否（' + esc((p.authorizationInfo[0] || {}).permission || '') + '）'}</td></tr>`; }).join('')}</tbody></table></div>`;
    },
  };
  const sections = [hierSection, peopleSection, apiSection, logSection];

  function mount(host, opts = {}) {
    const getSys = opts.getSys || UI.machine;
    host.innerHTML = `<div class="lv">${opts.tabsEl ? '' : '<div class="dbv-tabs lv-tabs" role="tablist" aria-label="見るもの"></div>'}<div class="lv-b" role="tabpanel"></div></div>`;
    const tabsEl = opts.tabsEl || $('.lv-tabs', host), body = $('.lv-b', host);
    const states = {};
    let cur = store.get('view-tab', 'tree');
    let added = new Set();
    async function draw() {
      if (!sections.some((s) => s.id === cur)) cur = sections[0].id;
      let sys;
      try { sys = await getSys(); } catch (e) { tabsEl.innerHTML = ''; body.innerHTML = UI.errBox('起動できませんでした', [String(e.message || e)]); return; }
      const ids = new Set(tree(sys.w).map((n) => n.id));
      if (seen) added = new Set([...ids].filter((x) => !seen.has(x)));
      tabsEl.innerHTML = sections.map((s) => `<button type="button" role="tab" data-id="${s.id}" aria-selected="${s.id === cur}">${esc(s.title)}</button>`).join('');
      const s = sections.find((x) => x.id === cur);
      const ctx = { sys, state: states[s.id] || (states[s.id] = {}), esc, redraw: () => draw(), added };
      const top = body.scrollTop;
      try { body.innerHTML = s.render(ctx); if (s.bind) s.bind(body, ctx); } catch (e) { body.innerHTML = UI.errBox('表示できませんでした', [String(e.message || e)]); }
      body.scrollTop = top;
    }
    tabsEl.addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (!b) return; cur = b.dataset.id; store.set('view-tab', cur); body.scrollTop = 0; draw(); });
    const api = { el: host, update: () => draw(), mark: async () => { const s = await getSys(); seen = new Set(tree(s.w).map((n) => n.id)); } };
    draw();
    return api;
  }

  // 画面の下のパネル
  const panel = document.getElementById('gcpv');
  const openBtn = document.querySelector('.db-view');
  let view = null, openPanel = () => {};
  if (panel && openBtn) {
    const body = $('.dbv-b', panel);
    const root = document.documentElement;
    const clampH = (h) => Math.round(Math.max(160, Math.min(window.innerHeight * 0.85, h)));
    let height = store.get('view-h', 0);
    const applyH = () => root.style.setProperty('--dbv-h', clampH(height || window.innerHeight * (window.innerWidth <= 900 ? 0.5 : 0.42)) + 'px');
    const setOpen = (on) => {
      panel.hidden = !on;
      openBtn.setAttribute('aria-pressed', String(on));
      document.body.classList.toggle('dbv-open', on);
      if (!on) return;
      applyH();
      if (!view) view = mount(body, { tabsEl: $('.dbv-tabs', panel) });
      else view.update();
    };
    openPanel = () => setOpen(true);
    openBtn.addEventListener('click', () => setOpen(panel.hidden));
    $('.dbv-close', panel).addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden && panel.contains(document.activeElement)) { setOpen(false); openBtn.focus(); } });
    // 実行の直前の木を覚えておき、新しくできたものに印を付ける
    window.addEventListener('gcp-ran', () => { if (!panel.hidden && view) view.update(); });
    window.addEventListener('gcp-reset', () => { seen = null; if (!panel.hidden && view) view.update(); });
    document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.gcprun .run-btn') && UI.machine) UI.serial(async () => { try { const s = await UI.machine(); seen = new Set(tree(s.w).map((n) => n.id)); } catch (x) {} }); }, true);
    const grip = $('.dbv-grip', panel);
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      document.body.classList.add('dbv-resizing');
      const move = (ev) => { height = clampH(window.innerHeight - ev.clientY); applyH(); };
      const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); document.body.classList.remove('dbv-resizing'); store.set('view-h', height); };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('keydown', (e) => { if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return; e.preventDefault(); height = clampH((height || panel.offsetHeight) + (e.key === 'ArrowUp' ? 24 : -24)); applyH(); store.set('view-h', height); });
    window.addEventListener('resize', () => { if (!panel.hidden) applyH(); });
  }
  window.GCPVIEW = { mount, openPanel: () => openPanel(), sections, tree };
})();
