// 「システムを見る」：小さな Linux のいまの状態（プロセス、fd 表、ファイル、マウント）と、直前のコマンドのシステムコール・出来事を見せる部品。
// 2 か所で使う：章のページの下のパネル（上部の「システムを見る」で開く）と、実験場（いつも開いている）。
//   LNXVIEW.mount(host, { getSys, tabsEl, big }) → { update(run), select(id), el }
//       getSys() はいまの機械、run は { events, trace }（直前のコマンド。LNXUI.mergeRuns の形）
//   LNXVIEW.openPanel()      下のパネルを開く
//   LNXVIEW.sections         タブの一覧。部品（mm、sched など）を足した人は、ここに足せば表示が増える：
//       LNXVIEW.sections.push({ id: 'mem', title: 'メモリ',
//         render(ctx) → HTML,            ctx = { sys, run, state（このタブ用の入れ物）, esc, fmtN, redraw() }
//         changed(ctx) → 真なら、タブに「変わった」印を付ける（省略可）
//         bind(el, ctx)                  描いた後に、クリックなどをつなぐ（省略可） })
//       LNXVIEW.procCols.push({ head: 'RSS', cls: 'num', cell: (p, sys) => … })   プロセスの表に列を足す
//   第 2 段階のタブ（メモリ、スケジューラ、ページキャッシュ、ネットワーク、コンテナ、サービス）は lnxview-adv.js が足す。
(() => {
  const LNX = window.LNX, UI = window.LNXUI;
  if (!LNX || !UI) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const { esc, fmtN, store } = UI;

  const STATE_JA = { R: '実行できる', S: '待っている', D: 'ディスク待ち', T: '停止中', Z: 'ゾンビ' };
  const TYPE_JA = { f: '通常のファイル', d: 'ディレクトリ', l: 'シンボリックリンク', c: 'キャラクタデバイス', b: 'ブロックデバイス', p: 'パイプ', s: 'ソケット' };
  const OP_JA = { create: '作った', mkdir: 'ディレクトリを作った', rmdir: 'ディレクトリを消した', unlink: '名前を消した', link: 'リンクを足した', symlink: 'シンボリックリンクを作った', rename: '名前を変えた', chmod: '権限を変えた', chown: '持ち主を変えた', mknod: 'デバイスを作った' };
  const size = (n) => (n < 1024 ? String(n) : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + 'K' : (n / 1048576).toFixed(1) + 'M');
  const date = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const empty = (t) => `<p class="dbv-pad muted">${t}</p>`;

  // ---------------------------------------------------------------- プロセス
  // プロセスの表に足す列。cell(p, sys)。VSZ / RSS は sys.vm(pid)（mm.js）から、NI は sys.ps() の nice
  const vmOf = (p, sys) => (p._vm !== undefined ? p._vm : (p._vm = (sys.vm && p.state !== 'Z' && sys.vm(p.pid)) || null));
  const procCols = [
    { head: 'NI', cls: 'num', title: 'nice（大きいほど、CPU をゆずる）', show: (ps, sys) => !!sys.sched || ps.some((p) => p.nice), cell: (p) => p.nice },
    { head: 'VSZ', cls: 'num', title: '仮想メモリの大きさ（kB）', show: (ps, sys) => !!sys.vm, cell: (p, sys) => (vmOf(p, sys) ? fmtN(vmOf(p, sys).vsz) : '') },
    { head: 'RSS', cls: 'num', title: '実際にメモリにある分（kB）', show: (ps, sys) => !!sys.vm, cell: (p, sys) => (vmOf(p, sys) ? fmtN(vmOf(p, sys).rss) : '') },
  ];
  function procOrder(ps) {
    const kids = new Map(), ids = new Set(ps.map((p) => p.pid));
    ps.forEach((p) => { if (ids.has(p.ppid)) (kids.get(p.ppid) || kids.set(p.ppid, []).get(p.ppid)).push(p); });
    const out = [];
    const walk = (p, d) => { out.push({ p, d }); (kids.get(p.pid) || []).forEach((c) => walk(c, d + 1)); };
    ps.filter((p) => !ids.has(p.ppid)).forEach((p) => walk(p, 0));
    return out;
  }
  function fdHTML(sys, p) {
    const fds = sys.fdTable(p.pid);
    if (!fds) return empty('このプロセスは、もうありません。');
    if (!fds.length) return empty(p.state === 'Z' ? 'ゾンビは、ファイルディスクリプタを持っていません（終了のときに全部閉じられます）。' : '開いているファイルディスクリプタはありません。');
    // 同じファイル記述（open file description）を指す fd には、同じ色を付ける
    const count = {};
    fds.forEach((f) => { count[f.ofd] = (count[f.ofd] || 0) + 1; });
    const tint = {};
    let k = 0;
    fds.forEach((f) => { if ((count[f.ofd] > 1 || f.refs > 1) && tint[f.ofd] === undefined) tint[f.ofd] = k++ % 4; });
    const rows = fds.map((f) => {
      const i = f.inode || {};
      const to = f.pipe
        ? `<span class="fd-path">${esc(f.path)}</span><span class="fd-sub">パイプの${f.pipe.end === 'r' ? '読む側' : '書く側'}・たまっている ${fmtN(f.pipe.buffered)} / ${fmtN(f.pipe.cap)} バイト・読み手 ${f.pipe.readers}・書き手 ${f.pipe.writers}</span>`
        : `<span class="fd-path">${esc(f.path)}</span><span class="fd-sub">inode ${i.ino}（${esc(i.fs || '')}）・${esc(TYPE_JA[i.type] || i.type || '')}・<code>${esc(i.modeStr || '')}</code>・リンク ${i.nlink}・${fmtN(i.size || 0)} バイト</span>`;
      const t = tint[f.ofd];
      return `<tr><td class="num fd-n">${f.fd}</td><td class="fd-ar">→</td><td><span class="fd-ofd${t === undefined ? '' : ' is-t' + t}">#${f.ofd}</span><span class="fd-sub"><code>${esc(f.flags)}</code>・位置 ${fmtN(f.pos)}・参照 ${f.refs}${f.refs > 1 ? '（共有）' : ''}${f.cloexec ? '・exec で閉じる' : ''}</span></td><td class="fd-ar">→</td><td>${to}</td></tr>`;
    }).join('');
    return `<div class="dbv-grid lv-fd"><table><thead><tr><th class="num">fd</th><th></th><th>ファイル記述（open file description）</th><th></th><th>その先（inode、パイプ）</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  const procSection = {
    id: 'proc', title: 'プロセス',
    changed: (ctx) => (ctx.run ? ctx.run.events.some((e) => e.type === 'fork' || e.type === 'exit') : false),
    render(ctx) {
      const { sys, run, state } = ctx;
      const ps = sys.ps(), t = sys.time();
      const born = new Set((run ? run.events : []).filter((e) => e.type === 'fork').map((e) => e.pid));
      if (!ps.some((p) => p.pid === state.pid)) state.pid = (ps.find((p) => p.session && p.user !== 'root') || ps.find((p) => p.session) || ps[0]).pid;
      const cols = procCols.filter((c) => !c.show || c.show(ps, sys));
      const rows = procOrder(ps).map(({ p, d }) => `<tr class="${p.pid === state.pid ? 'is-sel' : ''}${born.has(p.pid) ? ' is-add' : ''}" data-pid="${p.pid}"><td class="num"><button type="button" class="lv-pid" aria-pressed="${p.pid === state.pid}" title="このプロセスの fd 表を見る">${p.pid}</button></td><td class="num">${p.ppid}</td><td><span class="ps-st is-${p.state}" title="${STATE_JA[p.state] || ''}">${p.state}</span><span class="ps-stj">${STATE_JA[p.state] || ''}${p.waiting && p.state === 'S' && p.waiting[0] !== '_' ? `（${esc(p.waiting)}）` : ''}</span></td><td>${esc(p.user)}<span class="lv-dim">（${p.uid}）</span></td>${cols.map((c) => `<td class="${c.cls || ''}">${esc(c.cell(p, sys))}</td>`).join('')}<td class="ps-cmd">${d ? `<span class="ps-ind">${'　'.repeat(d - 1)}└ </span>` : ''}${esc(p.cmdline || p.comm)}</td></tr>`).join('');
      // 直前のコマンドの間に生まれて、もう終わったプロセス
      const gone = [];
      if (run) {
        const name = {};
        run.events.forEach((e) => {
          if (e.type === 'fork') name[e.pid] = name[e.pid] || e.comm;
          else if (e.type === 'exec') name[e.pid] = (e.argv || [e.path]).join(' ');
          else if (e.type === 'exit') gone.push({ pid: e.pid, name: name[e.pid] || '', sig: e.sig, code: e.code });
        });
      }
      const goneHTML = gone.length
        ? `<div class="lv-gone"><span class="lv-cap">直前のコマンドの間に終わったプロセス</span>${gone.slice(0, 40).map((g) => `<span class="lv-chip${g.sig || g.code ? ' is-bad' : ''}">PID ${g.pid} <b>${esc(g.name)}</b> ${g.sig ? `シグナル ${g.sig}（${esc(LNX.SIGNAME && LNX.SIGNAME[g.sig] ? 'SIG' + LNX.SIGNAME[g.sig] : '')}）` : `終了 ${g.code}`}</span>`).join('')}${gone.length > 40 ? `<span class="lv-dim">ほか ${gone.length - 40} 個</span>` : ''}</div>` : '';
      const sel = ps.find((p) => p.pid === state.pid);
      return `<div class="lv-facts"><span>仮想時間 <b>${fmtN(t.ticks)}</b> ミリ秒</span><span>時刻 <b>${esc(t.date)}</b></span><span>プロセス <b>${ps.length}</b> 個</span><span>負荷平均 <b>${t.load.map((x) => Number(x).toFixed(2)).join(' ')}</b></span></div>
      <div class="lv-two"><section><h4>プロセスの木<span class="lv-dim">（PID を押すと、そのプロセスのファイルディスクリプタの表が出ます）</span></h4><div class="dbv-grid lv-ps"><table><thead><tr><th class="num">PID</th><th class="num">PPID</th><th>状態</th><th>ユーザー</th>${cols.map((c) => `<th class="${c.cls || ''}"${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.head)}</th>`).join('')}<th>コマンド</th></tr></thead><tbody>${rows}</tbody></table></div>${goneHTML}</section>
      <section><h4>PID ${sel.pid}（${esc(sel.comm)}）のファイルディスクリプタの表</h4>${fdHTML(sys, sel)}</section></div>`;
    },
    bind(el, ctx) {
      $$('.lv-ps tbody tr', el).forEach((tr) => tr.addEventListener('click', () => { ctx.state.pid = +tr.dataset.pid; ctx.redraw(); }));
    },
  };

  // ---------------------------------------------------------------- ファイル
  function inodeHTML(sys, path) {
    const i = sys.inode(path, true);
    if (!i) return empty('このファイルは、もうありません。');
    const row = (k, v) => `<div class="in-r"><dt>${k}</dt><dd>${v}</dd></div>`;
    let h = row('inode 番号', `<b>${i.ino}</b><span class="lv-dim">（${esc(i.fs)}）</span>`) + row('種類', esc(TYPE_JA[i.type] || i.type)) +
      row('権限', `<code>${esc(i.modeStr)}</code>（${esc(i.octal)}）`) + row('持ち主', `${esc(i.user)}（${i.uid}）: ${esc(i.group)}（${i.gid}）`) +
      row('リンク数', `<b>${i.nlink}</b>`) + row('大きさ', `${fmtN(i.size)} バイト`);
    if (i.blocks && i.blocks.length) h += row('ブロック', `<code>${i.blocks.slice(0, 12).join(', ')}${i.blocks.length > 12 ? ` …（${i.blocks.length} 個）` : ''}</code>`);
    if (i.target !== undefined) h += row('リンク先', `<code>${esc(i.target)}</code>`);
    if (i.rdev !== undefined && i.type === 'c') h += row('デバイス番号', `<code>${esc(i.rdev)}</code>`);
    h += row('変更（mtime）', esc(date(i.mtime))) + row('状態の変更（ctime）', esc(date(i.ctime)));
    if (i.opens) h += row('開いている数', String(i.opens));
    if (i.entries) h += `<div class="in-ents"><div class="lv-cap">ディレクトリの中身（名前 → inode 番号）</div><div class="in-entl">${i.entries.slice(0, 60).map((e) => `<span><code>${esc(e.name)}</code> → ${e.ino}</span>`).join('')}${i.entries.length > 60 ? `<span class="lv-dim">ほか ${i.entries.length - 60} 個</span>` : ''}</div></div>`;
    return `<dl class="in-list">${h}</dl>`;
  }
  const fileSection = {
    id: 'files', title: 'ファイル',
    changed: (ctx) => (ctx.run ? ctx.run.events.some((e) => e.type === 'fs') : false),
    render(ctx) {
      const { sys, run, state } = ctx;
      const tree = sys.tree('/', { depth: 16, max: 4000 });
      if (!state.open) state.open = new Set(['/', '/home', sys.cwd()]);
      // 直前に変わったものが見えるように、その親を開く
      const mark = (n) => { let any = false; (n.children || []).forEach((c) => { if (mark(c) || c.changed) any = true; }); if (any) state.open.add(n.path); return any; };
      if (state.seen !== run) { mark(tree); state.seen = run; }
      const rows = [];
      const walk = (n, d) => {
        const dir = n.type === 'd', open = dir && state.open.has(n.path), kids = n.children || [];
        const canOpen = dir && (kids.length > 0 || n.collapsed);
        rows.push(`<tr class="${n.changed ? 'is-chg' : ''}${state.sel === n.path ? ' is-sel' : ''}" data-path="${esc(n.path)}"><td class="ft-name"><span class="ft-ind" style="--d:${d}"></span>${
          canOpen && !n.collapsed ? `<button type="button" class="ft-tw" aria-expanded="${open}" aria-label="${open ? '閉じる' : '開く'}">${open ? '▾' : '▸'}</button>` : '<span class="ft-tw"></span>'
        }<button type="button" class="ft-n is-${n.type}">${esc(n.name || '/')}${dir && n.path !== '/' ? '/' : ''}</button>${n.target !== undefined ? `<span class="lv-dim"> → ${esc(n.target)}</span>` : ''}${n.mount ? `<span class="dbv-tag">${esc(n.mount)}</span>` : ''}</td><td class="num">${n.ino}</td><td><code>${esc(n.modeStr)}</code></td><td class="num">${n.nlink}</td><td>${esc(n.user)}</td><td class="num">${size(n.size)}</td></tr>`);
        if (open) kids.forEach((c) => walk(c, d + 1));
      };
      walk(tree, 0);
      const ops = (run ? run.events : []).filter((e) => e.type === 'fs');
      const opsHTML = ops.length
        ? `<div class="lv-gone"><span class="lv-cap">直前のコマンドがしたこと</span>${ops.slice(0, 30).map((e) => `<span class="lv-chip${/unlink|rmdir/.test(e.op) ? ' is-bad' : ''}">${esc(OP_JA[e.op] || e.op)} <b>${esc(e.from ? e.from + ' → ' + e.path : e.path)}</b>${e.nlink !== undefined ? `（リンク数 ${e.nlink}）` : ''}</span>`).join('')}${ops.length > 30 ? `<span class="lv-dim">ほか ${ops.length - 30} 個</span>` : ''}</div>` : '';
      return `<div class="lv-two is-files"><section><h4>ファイルの木<span class="lv-dim">（名前を押すと、右に inode が出ます。色は直前のコマンドで変わったもの）</span></h4>${opsHTML}<div class="dbv-grid lv-ft"><table><thead><tr><th>名前</th><th class="num">inode</th><th>権限</th><th class="num">リンク</th><th>持ち主</th><th class="num">大きさ</th></tr></thead><tbody>${rows.join('')}</tbody></table></div></section>
      <section><h4>${state.sel ? `<code>${esc(state.sel)}</code> の inode` : 'inode'}</h4>${state.sel ? inodeHTML(sys, state.sel) : empty('左の木でファイルの名前を押すと、その inode の中身（番号、権限、リンク数、ブロック）が出ます。')}</section></div>`;
    },
    bind(el, ctx) {
      $$('.lv-ft tbody tr', el).forEach((tr) => {
        const p = tr.dataset.path;
        const tw = $('button.ft-tw', tr);
        if (tw) tw.addEventListener('click', (e) => { e.stopPropagation(); ctx.state.open.has(p) ? ctx.state.open.delete(p) : ctx.state.open.add(p); ctx.redraw(); });
        $('.ft-n', tr).addEventListener('click', () => { ctx.state.sel = p; if (tw && !ctx.state.open.has(p)) ctx.state.open.add(p); ctx.redraw(); });
      });
    },
  };

  // ---------------------------------------------------------------- マウント
  const mountSection = {
    id: 'mounts', title: 'マウント',
    changed: (ctx) => (ctx.run ? ctx.run.events.some((e) => e.type === 'mount' || e.type === 'umount') : false),
    render(ctx) {
      const ms = ctx.sys.mounts();
      return `<div class="dbv-grid lv-pad"><table><thead><tr><th>どこに（マウントポイント）</th><th>何を</th><th>種類</th><th class="num">使用 / 全体（ブロック）</th><th class="num">inode</th><th>オプション</th></tr></thead><tbody>${ms.map((m) => `<tr><td><code>${esc(m.target)}</code></td><td>${esc(m.source)}</td><td>${esc(m.type)}</td><td class="num">${m.blocks ? `${fmtN(m.used)} / ${fmtN(m.blocks)}` : '—'}</td><td class="num">${m.inodes ? fmtN(m.inodes) : '—'}</td><td class="lv-dim">${esc(m.opts)}</td></tr>`).join('')}</tbody></table></div>`;
    },
  };

  // ---------------------------------------------------------------- システムコール
  const sysSection = {
    id: 'sys', title: 'システムコール',
    changed: (ctx) => !!(ctx.run && ctx.run.trace.length),
    render(ctx) {
      const run = ctx.run;
      if (!run) return empty('コマンドを実行すると、そのコマンドが呼んだシステムコールが、呼んだ順にここに出ます。');
      const calls = run.trace.filter((t) => !t.sep);
      if (!calls.length) return empty('直前のコマンドは、新しいプログラムを起動しませんでした（シェルの組み込みコマンドだけで済みました）。ここには、起動されたプログラム（execve の後）のシステムコールが出ます。');
      const by = {};
      calls.forEach((t) => { by[t.name] = (by[t.name] || 0) + 1; });
      const chips = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([n, c]) => `<span class="lv-chip" title="${esc((LNX.SYSJA && LNX.SYSJA[n]) || '')}"><b>${esc(n)}</b> ${c}</span>`).join('');
      const MAX = 1500;
      const body = run.trace.slice(0, MAX).map((l) => (l.sep ? `<div class="ts-l ts-sep">${esc(l.line)}</div>` : `<div class="ts-l" title="${esc((LNX.SYSJA && LNX.SYSJA[l.name]) || '')}">${UI.traceLine(l)}</div>`)).join('');
      return `<div class="lv-gone"><span class="lv-cap">${fmtN(calls.length)} 回（名前にカーソルを置くと説明が出ます）</span>${chips}</div><div class="tm-trace lv-trace">${body}${run.trace.length > MAX ? `<div class="ts-l ts-x">…（残りは省略）</div>` : ''}</div>`;
    },
  };

  // ---------------------------------------------------------------- 出来事（events そのまま。後の段階で fault / switch などが増える）
  const eventSection = {
    id: 'events', title: '出来事',
    render(ctx) {
      if (!ctx.run) return empty('コマンドを実行すると、その間にカーネルの中で起きたこと（fork、exec、open、終了など）が、起きた順にここに出ます。');
      if (!ctx.run.events.length) return empty('直前のコマンドの間に、記録された出来事はありません。');
      return `<div class="lv-gone"><span class="lv-cap">${fmtN(ctx.run.events.length)} 件。左の数字は、起動してからの仮想時間（ミリ秒）</span></div><div class="lv-pad">${UI.eventsTable(ctx.run.events)}</div>`;
    },
  };

  const sections = [procSection, fileSection, mountSection, sysSection, eventSection];

  // ---------------------------------------------------------------- 取り付け
  function mount(host, opts = {}) {
    const getSys = opts.getSys || UI.machine;
    host.innerHTML = `<div class="lv${opts.big ? ' is-big' : ''}">${opts.tabsEl ? '' : '<div class="dbv-tabs lv-tabs" role="tablist" aria-label="見るもの"></div>'}<div class="lv-b" role="tabpanel"></div></div>`;
    const tabsEl = opts.tabsEl || $('.lv-tabs', host), body = $('.lv-b', host);
    const states = {};
    let cur = store.get('view-tab', 'proc'), run = null;
    const ctxOf = (s) => ({ sys: getSys(), run, state: states[s.id] || (states[s.id] = {}), esc, fmtN, redraw: draw });
    function draw() {
      if (!sections.some((s) => s.id === cur)) cur = sections[0].id;
      let sys;
      try { sys = getSys(); } catch (e) { tabsEl.innerHTML = ''; body.innerHTML = UI.errBox('起動できませんでした', [String(e.message || e)]); return; }
      tabsEl.innerHTML = sections.map((s) => {
        let chg = false;
        try { chg = !!(s.changed && s.changed(ctxOf(s))); } catch (e) {}
        return `<button type="button" role="tab" data-id="${s.id}" aria-selected="${s.id === cur}" class="${chg ? 'is-chg' : ''}">${esc(s.title)}</button>`;
      }).join('');
      const s = sections.find((x) => x.id === cur), ctx = ctxOf(s);
      const top = body.scrollTop;
      try { body.innerHTML = s.render(ctx); if (s.bind) s.bind(body, ctx); } catch (e) { body.innerHTML = UI.errBox('表示できませんでした', [String(e.message || e)]); }
      body.scrollTop = top;
      void sys;
    }
    tabsEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-id]');
      if (!b) return;
      cur = b.dataset.id;
      store.set('view-tab', cur);
      body.scrollTop = 0;
      draw();
    });
    const api = { el: host, update(r) { if (r !== undefined) run = r; draw(); }, select(id) { cur = id; draw(); }, get tab() { return cur; }, get run() { return run; } };
    draw();
    return api;
  }

  // ---------------------------------------------------------------- 画面の下のパネル
  const panel = document.getElementById('lnxv');
  const openBtn = document.querySelector('.db-view');
  let view = null;
  let openPanel = () => {};
  if (panel && openBtn) {
    const body = $('.dbv-b', panel);
    const root = document.documentElement;
    const clampH = (h) => Math.round(Math.max(160, Math.min(window.innerHeight * 0.85, h)));
    let height = store.get('view-h', 0);
    const applyH = () => root.style.setProperty('--dbv-h', clampH(height || window.innerHeight * (window.innerWidth <= 900 ? 0.5 : 0.42)) + 'px');
    const lastRun = () => (UI.lastRun ? UI.lastRun.run : null);
    const setOpen = (on) => {
      panel.hidden = !on;
      openBtn.setAttribute('aria-pressed', String(on));
      document.body.classList.toggle('dbv-open', on);
      if (!on) return;
      applyH();
      if (!view) view = mount(body, { tabsEl: $('.dbv-tabs', panel) });
      view.update(lastRun());
    };
    openPanel = () => setOpen(true);
    openBtn.addEventListener('click', () => setOpen(panel.hidden));
    $('.dbv-close', panel).addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden && panel.contains(document.activeElement)) { setOpen(false); openBtn.focus(); } });
    window.addEventListener('lnx-ran', (e) => { if (!panel.hidden && view) view.update(e.detail.run); });
    window.addEventListener('lnx-reset', () => { if (!panel.hidden && view) view.update(null); });
    const grip = $('.dbv-grip', panel);
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      document.body.classList.add('dbv-resizing');
      const move = (ev) => { height = clampH(window.innerHeight - ev.clientY); applyH(); };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        document.body.classList.remove('dbv-resizing');
        store.set('view-h', height);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      height = clampH((height || panel.offsetHeight) + (e.key === 'ArrowUp' ? 24 : -24));
      applyH();
      store.set('view-h', height);
    });
    window.addEventListener('resize', () => { if (!panel.hidden) applyH(); });
  }

  window.LNXVIEW = { mount, openPanel: () => openPanel(), sections, procCols, get panelView() { return view; } };
})();
