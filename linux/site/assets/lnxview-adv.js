// 「システムを見る」の第 2 段階のタブ：メモリ、スケジューラ、ページキャッシュ、ネットワーク、コンテナ、サービス。lnxview.js の後に読み込む。
// LNXVIEW.sections に足す（仕組みは lnxview.js の先頭コメント）。機械の観察 API（sys.mem() / vm(pid) / frames() / sched() / pagecache() / net() /
// namespaces() / cgroups() / units() / journal() / bootlog()）を、そのまま表にする。直前のコマンドに観察用のイベントがあれば（trace つきで実行したとき。
// 実験場はいつも）、lnx-trace.js の表示（ガントチャート、シーケンス図など）も下に出す。
(() => {
  const LNX = window.LNX, UI = window.LNXUI, VIEW = window.LNXVIEW;
  if (!LNX || !UI || !VIEW) return;
  const { esc, fmtN } = UI;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const empty = (t) => `<p class="dbv-pad muted">${t}</p>`;
  const facts = (list) => `<div class="lv-facts">${list.filter(Boolean).map(([k, v, u]) => `<span>${esc(k)} <b>${typeof v === 'number' ? fmtN(v) : esc(v)}</b>${u ? ' ' + esc(u) : ''}</span>`).join('')}</div>`;
  const grid = (heads, rows, cls) => `<div class="dbv-grid ${cls || 'lv-pad'}"><table><thead><tr>${heads.map((h) => `<th${h[1] ? ` class="${h[1]}"` : ''}>${esc(h[0])}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const h4 = (t, dim) => `<h4 class="lv-h">${t}${dim ? `<span class="lv-dim">（${dim}）</span>` : ''}</h4>`;
  const evsOf = (ctx, kind) => (ctx.run ? UI.traceEvents(kind, ctx.run.events) : []);
  // 直前のコマンドの観察（lnx-trace.js の表示）
  function lastRun(ctx, kind, title) {
    const evs = evsOf(ctx, kind);
    if (!evs.length || !UI.traceViews[kind]) return '';
    let body = '';
    try { body = UI.traceViews[kind](evs, ctx.run); } catch (e) { body = ''; }
    return body ? `<div class="lv-last">${h4(title, `${fmtN(evs.length)} 件の記録から`)}<div class="lv-lastb">${body}</div></div>` : '';
  }
  const kb = (n) => `${fmtN(n)} kB`;
  const bytes = (n) => (n === 'max' ? 'max（上限なし）' : n >= 1048576 ? `${fmtN(Math.round(n / 104857.6) / 10)} MiB` : n >= 1024 ? `${fmtN(Math.round(n / 1024))} KiB` : `${n} B`);
  const STATE_JA = { R: '実行できる', S: '待っている', D: 'ディスク待ち', T: '停止中', Z: 'ゾンビ' };

  // ---------------------------------------------------------------- メモリ
  const COLS = 256, CELL = 3;
  const memSection = {
    id: 'mem', title: 'メモリ',
    changed: (ctx) => (ctx.run ? ctx.run.events.some((e) => e.cat === 'mem' || e.type === 'oom') : false),
    render(ctx) {
      const { sys, state } = ctx;
      if (!sys.mem || !sys.vm) return empty('この機械には、仮想メモリの部品（mm.js）が入っていません。');
      const m = sys.mem(), k = m.kB;
      const ps = sys.ps().filter((p) => p.state !== 'Z');
      if (!ps.some((p) => p.pid === state.pid)) state.pid = (ps.find((p) => p.session && p.user !== 'root') || ps.find((p) => p.session) || ps[0]).pid;
      const vm = sys.vm(state.pid);
      const used = [['kern', 'カーネル', m.reserved], ['anon', 'プロセスの匿名ページ', m.anon], ['cache', 'ページキャッシュ', m.cache], ['free', '空き', m.free]];
      const bar = `<div class="mm-bar" role="img" aria-label="物理メモリの使われ方">${used.map(([c, , n]) => `<i class="is-${c}" style="flex-grow:${n}"></i>`).join('')}</div>
        <div class="mm-leg">${used.map(([c, label, n]) => `<span><i class="mm-sw is-${c}"></i>${label} <b>${fmtN(n)}</b> フレーム（${kb(n * 4)}）</span>`).join('')}<span><i class="mm-sw is-sel"></i>下で選んだプロセスが使っているフレーム</span></div>`;
      let procHTML = empty('このプロセスには、アドレス空間がありません。');
      if (vm) {
        if (state.vma && !vm.vmas.some((v) => v.startHex === state.vma)) state.vma = null;
        const vrows = vm.vmas.map((v) => `<tr class="${state.vma === v.startHex ? 'is-sel' : ''}" data-vma="${v.startHex}"><td>${v.startHex}-${v.endHex}</td><td>${esc(v.perms)}</td><td class="num">${fmtN(v.pages * 4)}</td><td class="num">${fmtN(v.rss * 4)}</td><td>${v.name ? esc(v.name) : '<span class="lv-dim">名前なし（mmap）</span>'}</td></tr>`);
        const sel = state.vma ? vm.vmas.find((v) => v.startHex === state.vma) : null;
        const pages = sel ? vm.pages.filter((p) => p.vpn * 4096 >= sel.start && p.vpn * 4096 < sel.end) : vm.pages;
        const MAXP = 200;
        const prows = pages.slice(0, MAXP).map((p) => `<tr><td>${esc(p.addr)}</td><td class="fd-ar">→</td><td class="num">${p.frame}</td><td>${p.w ? '<span class="tv-tag is-steel">書ける</span>' : '<span class="tv-tag is-muted">読むだけ</span>'}${p.cow ? '<span class="tv-tag is-heap">CoW</span>' : ''}${p.file ? '<span class="tv-tag is-sage">ファイル</span>' : ''}</td><td class="num">${p.refs > 1 ? `<b>${p.refs}</b>` : p.refs}</td><td>${p.area ? esc(p.area) : '<span class="lv-dim">名前なし</span>'}</td></tr>`);
        procHTML = `<div class="lv-two"><section>${h4(`領域（VMA）`, '行を押すと、右のページ表をその領域だけにします')}${facts([['VmSize', vm.vsz, 'kB'], ['VmRSS', vm.rss, 'kB'], ['うち匿名', vm.rssAnon, 'kB'], ['ファイル', vm.rssFile, 'kB'], ['フォルト minor', vm.minflt], ['major', vm.majflt], ['brk', vm.brk]])}
          ${grid([['番地'], ['権限'], ['大きさ（kB）', 'num'], ['メモリにある分（kB）', 'num'], ['中身']], vrows, 'mm-vma')}</section>
          <section>${h4(`ページ表${sel ? `：<code>${esc(sel.name || sel.startHex)}</code>` : ''}`, `割り当て済みの ${fmtN(pages.length)} ページ。触っていないページは、まだ表にありません`)}
          ${pages.length ? grid([['仮想ページ'], [''], ['フレーム', 'num'], ['印'], ['共有', 'num'], ['領域']], prows, 'mm-pt') + (pages.length > MAXP ? `<p class="dbv-pad muted">残り ${fmtN(pages.length - MAXP)} ページは省略。</p>` : '') : empty('この領域には、まだフレームが割り当てられていません（触ったときに割り当てられます）。')}</section></div>`;
      }
      const opts = ps.map((p) => `<option value="${p.pid}"${p.pid === state.pid ? ' selected' : ''}>PID ${p.pid}　${esc(p.cmdline || p.comm)}</option>`).join('');
      return facts([['MemTotal', k.MemTotal, 'kB'], ['MemFree', k.MemFree, 'kB'], ['MemAvailable', k.MemAvailable, 'kB'], ['Cached', k.Cached, 'kB'], ['Dirty', k.Dirty, 'kB'], ['AnonPages', k.AnonPages, 'kB'], ['OOM killer', m.oomKills, '回']]) +
        `<div class="mm-top">${h4('物理メモリ', `${fmtN(m.totalFrames)} フレーム × 4 KiB = ${fmtN(m.totalFrames * 4 / 1024)} MiB`)}${bar}
        <canvas class="mm-map" width="${COLS * CELL}" height="${Math.ceil(m.totalFrames / COLS) * CELL}" aria-label="物理フレームの地図（1 マス = 1 フレーム）"></canvas>
        <p class="tv-note">1 マスが 1 フレーム（4 KiB）。左上がフレーム 0 で、右へ、下へ進みます。</p></div>
        <div class="mm-pick"><label>プロセス <select class="mm-sel">${opts}</select></label></div>${procHTML}` + lastRun(ctx, 'mem', '直前のコマンドのページフォルト');
    },
    bind(el, ctx) {
      const { sys, state } = ctx;
      const sel = $('.mm-sel', el);
      if (sel) sel.addEventListener('change', () => { state.pid = +sel.value; state.vma = null; ctx.redraw(); });
      $$('.mm-vma tbody tr', el).forEach((tr) => tr.addEventListener('click', () => { state.vma = state.vma === tr.dataset.vma ? null : tr.dataset.vma; ctx.redraw(); }));
      const cv = $('.mm-map', el);
      if (!cv || !sys.frames) return;
      const g = cv.getContext('2d'), cs = getComputedStyle(el), col = (n) => cs.getPropertyValue(n).trim() || '#888';
      const C = [col('--raised'), col('--stack-s'), col('--static-s'), col('--dg-muted')], SEL = col('--accent');
      const fr = sys.frames(), vm = sys.vm(state.pid), mine = new Set(vm ? vm.pages.map((p) => p.frame) : []);
      g.clearRect(0, 0, cv.width, cv.height);
      for (let f = 0; f < fr.kind.length; f++) {
        g.fillStyle = mine.has(f) ? SEL : C[fr.kind[f]] || C[0];
        g.fillRect((f % COLS) * CELL, Math.floor(f / COLS) * CELL, CELL, CELL);
      }
    },
  };

  // ---------------------------------------------------------------- スケジューラ
  const schedSection = {
    id: 'sched', title: 'スケジューラ',
    changed: (ctx) => evsOf(ctx, 'sched').length > 0,
    render(ctx) {
      const { sys } = ctx;
      if (!sys.sched) return empty('この機械には、スケジューラの部品（sched.js）が入っていません。');
      const s = sys.sched();
      const qpos = new Map(s.queue.map((p, i) => [p.pid, i + 1]));
      const procs = s.procs.slice().sort((a, b) => (qpos.get(a.pid) || 1e9) - (qpos.get(b.pid) || 1e9) || a.vruntime - b.vruntime);
      const maxD = Math.max(1, ...procs.map((p) => Math.abs(p.vruntime - s.minVruntime)));
      const rows = procs.map((p) => {
        const d = p.vruntime - s.minVruntime;
        return `<tr class="${qpos.has(p.pid) ? 'is-add' : ''}"><td class="num">${qpos.has(p.pid) ? qpos.get(p.pid) : '<span class="lv-dim">—</span>'}</td><td class="num">${p.pid}</td><td>${esc(p.comm)}</td><td><span class="ps-st is-${p.state}">${p.state}</span><span class="ps-stj">${STATE_JA[p.state] || ''}</span></td><td class="num">${p.nice}</td><td class="num">${fmtN(p.weight)}</td><td class="num">${fmtN(p.vruntime)}</td><td class="num tv-share"><span class="tv-bar"><i style="width:${Math.round((100 * Math.max(0, d)) / maxD)}%"></i></span>${d >= 0 ? '+' : ''}${fmtN(Math.round(d * 100) / 100)}</td><td class="num">${fmtN(p.cpu)}</td></tr>`;
      });
      return facts([['方式', s.name === 'cfs' ? 'CFS 風（vruntime の小さい順）' : s.name], ['目標の周期', s.latency, 'ミリ秒'], ['最低の持ち時間', s.minGranularity, 'ミリ秒'], ['いちばん小さい vruntime', s.minVruntime], ['実行キュー', s.queue.length, '個']]) +
        `<div class="lv-sec">${h4('プロセスと vruntime', '色のついた行が実行キュー（走れるプロセス）。「順番」の 1 が次に CPU をもらう')}
        ${grid([['順番', 'num'], ['PID', 'num'], ['コマンド'], ['状態'], ['nice', 'num'], ['重み', 'num'], ['vruntime', 'num'], ['いちばん小さい値との差', 'num'], ['CPU 時間（ミリ秒）', 'num']], rows)}
        <p class="tv-note">vruntime は「使った CPU 時間 × 1024 ÷ 重み」をためたもの。nice が大きいほど重みが小さく、同じ時間を使っても vruntime が速く増えるので、順番が回ってきにくくなります。${s.queue.length ? '' : 'いまは全員が待っているので、実行キューは空です（<code>burn 5 &amp;</code> のように CPU を使うコマンドを動かすと、ここに並びます）。'}</p></div>` +
        lastRun(ctx, 'sched', '直前のコマンドのガントチャート');
    },
  };

  // ---------------------------------------------------------------- ページキャッシュ
  const STRIP = 48;
  const pcSection = {
    id: 'pcache', title: 'ページキャッシュ',
    changed: (ctx) => evsOf(ctx, 'pagecache').length > 0,
    render(ctx) {
      const { sys, state } = ctx;
      if (!sys.pagecache) return empty('この機械には、ページキャッシュの部品（pagecache.js）が入っていません。');
      const pc = sys.pagecache(), reads = pc.hits + pc.misses;
      const isSys = (f) => /^\/(usr|lib|bin|sbin)\//.test(f.path);
      const all = pc.files.filter((f) => f.cached || f.dirty || f.writeback);
      const files = all.filter((f) => state.all || f.dirty || f.writeback || !isSys(f)).sort((a, b) => (b.dirty + b.writeback) - (a.dirty + a.writeback) || isSys(a) - isSys(b) || a.path.localeCompare(b.path));
      const MAX = 80;
      const rows = files.slice(0, MAX).map((f) => {
        const have = new Set(f.list || []), n = Math.min(f.pages, STRIP);
        let strip = '';
        for (let i = 0; i < n; i++) strip += `<i class="${have.has(i) ? 'is-on' : ''}"></i>`;
        return `<tr class="${f.dirty || f.writeback ? 'is-chg' : ''}"><td><code>${esc(f.path || `inode ${f.ino}`)}</code></td><td class="num">${fmtN(f.size)}</td><td class="num">${fmtN(f.cached)} / ${fmtN(f.pages)}</td><td class="num">${f.dirty ? `<b>${fmtN(f.dirty)}</b>` : 0}</td><td class="num">${f.writeback ? `<b>${fmtN(f.writeback)}</b>` : 0}</td><td><span class="pc-strip${f.dirty ? ' is-dirty' : ''}">${strip}</span>${f.pages > STRIP ? '<span class="lv-dim"> …</span>' : ''}</td></tr>`;
      });
      const hidden = all.length - files.length;
      return facts([['キャッシュ', pc.cached, `ページ（${kb(pc.cached * 4)}）`], ['dirty', pc.dirty, 'ページ'], ['書き戻し中', pc.writeback, 'ページ'], ['hit', pc.hits], ['miss', pc.misses], reads ? ['キャッシュで済んだ割合', ((100 * pc.hits) / reads).toFixed(1) + '%'] : null,
        ['ディスク', `読む ${pc.readMs} ms・書く ${pc.writeMs} ms`, '/ ページ'], ['書き戻しの見回り', `${pc.interval / 1000} 秒ごと・${pc.expire / 1000} 秒たった dirty から`]]) +
        `<div class="lv-sec">${h4('キャッシュにあるファイル', 'dirty = キャッシュには書いたが、まだディスクに書いていないページ。色のついた行')}
        ${rows.length ? grid([['ファイル'], ['大きさ（バイト）', 'num'], ['キャッシュ / 全体（ページ）', 'num'], ['dirty', 'num'], ['書き戻し中', 'num'], ['ページ（■ = キャッシュにある）']], rows) : empty('当てはまるファイルはありません。')}
        ${files.length > MAX ? `<p class="dbv-pad muted">残り ${fmtN(files.length - MAX)} 個は省略。</p>` : ''}
        <p class="tv-note">${state.all ? '全部のファイルを出しています。' : `プログラムとライブラリ（/usr の下）の ${fmtN(hidden)} 個は隠しています。`} <button type="button" class="dbv-btn pc-all">${state.all ? '/usr の下を隠す' : '全部出す'}</button></p></div>` +
        lastRun(ctx, 'pagecache', '直前のコマンドの読み書き');
    },
    bind(el, ctx) {
      const b = $('.pc-all', el);
      if (b) b.addEventListener('click', () => { ctx.state.all = !ctx.state.all; ctx.redraw(); });
    },
  };

  // ---------------------------------------------------------------- ネットワーク
  const netSection = {
    id: 'net', title: 'ネットワーク',
    changed: (ctx) => evsOf(ctx, 'net').length > 0,
    render(ctx) {
      const { sys } = ctx;
      if (!sys.net) return empty('この機械には、ネットワークの部品（net.js）が入っていません。');
      const n = sys.net();
      const ifr = n.ifaces.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.addr)}/${i.prefix}</td><td>${esc(i.state)}</td><td class="num">${fmtN(i.mtu)}</td><td>${esc(i.mac)}</td><td class="lv-dim">${i.name === 'lo' ? 'ループバック（自分自身）' : 'この先には、何もつながっていません'}</td></tr>`);
      const srows = n.sockets.map((s) => `<tr><td class="num">${s.id}</td><td>${s.family === 'unix' ? 'UNIX' : 'TCP'}</td><td><span class="tv-st is-${esc(s.state)}">${esc(s.state)}</span>${s.state === 'TIME_WAIT' && s.timeWaitLeft ? `<span class="lv-dim"> あと ${fmtN(Math.ceil(s.timeWaitLeft / 1000))} 秒</span>` : ''}</td><td>${esc(s.local || '—')}</td><td>${esc(s.peer || '—')}</td><td class="num">${fmtN(s.recvQ)}</td><td class="num">${s.state === 'LISTEN' ? `${s.queued} / ${s.backlog}` : '—'}</td><td>${s.users.length ? s.users.map((u) => `PID ${u.pid} ${esc(u.comm)}（fd ${u.fd}）`).join('、') : '<span class="lv-dim">なし（カーネルが持っている）</span>'}</td></tr>`);
      return facts([['ソケット', n.sockets.length, '個'], ['待ち受け中', n.sockets.filter((s) => s.state === 'LISTEN').length, '個'], ['つながっている', n.sockets.filter((s) => s.state === 'ESTABLISHED').length, '個'], ['lo の遅延', n.delay, 'ミリ秒']]) +
        `<div class="lv-sec">${h4('ソケット', 'ss -a と同じもの。最初の名前空間の分')}${srows.length ? grid([['番号', 'num'], ['種類'], ['状態'], ['自分の番地'], ['相手の番地'], ['読まれていないバイト', 'num'], ['待ち行列', 'num'], ['持っているプロセス']], srows) : empty('ソケットはありません（<code>nc -l 8080 &amp;</code> や <code>httpd &amp;</code> で待ち受けを始めると、ここに出ます）。')}</div>
        <div class="lv-sec">${h4('ネットワークの口（インターフェース）')}${grid([['名前'], ['番地'], ['状態'], ['MTU', 'num'], ['MAC'], ['']], ifr)}</div>` +
        lastRun(ctx, 'net', '直前のコマンドのパケット');
    },
  };

  // ---------------------------------------------------------------- コンテナ（名前空間と cgroup）
  const NS_KINDS = ['pid', 'mnt', 'uts', 'net'];
  const NS_JA = { pid: 'PID', mnt: 'マウント', uts: 'UTS（ホスト名）', net: 'ネット', ipc: 'IPC', cgroup: 'cgroup', user: 'ユーザー' };
  const nsSection = {
    id: 'ns', title: 'コンテナ',
    changed: (ctx) => (ctx.run ? ctx.run.events.some((e) => e.type === 'ns' || e.type === 'cgroup') : false),
    render(ctx) {
      const { sys } = ctx;
      if (!sys.namespaces || !sys.cgroups) return empty('この機械には、名前空間と cgroups の部品（ns.js）が入っていません。');
      const ps = sys.ps(), init = ps.find((p) => p.pid === 1) || ps[0], nss = sys.namespaces();
      const host = (init && init.ns) || {};
      const prow = ps.map((p) => {
        const ns = p.ns || {};
        const inBox = NS_KINDS.some((k) => ns[k] !== host[k]) || (p.root && p.root !== '/') || (p.cgroup && p.cgroup !== '/' && !/^\/system\.slice/.test(p.cgroup));
        return `<tr class="${inBox ? 'is-chg' : ''}"><td class="num">${p.pid}</td><td class="num">${p.vpid !== undefined && p.vpid !== p.pid ? `<b>${p.vpid}</b>` : '<span class="lv-dim">同じ</span>'}</td><td>${esc(p.cmdline || p.comm)}</td>${
          NS_KINDS.map((k) => `<td>${ns[k] === host[k] ? '<span class="lv-dim">ホスト</span>' : `<span class="tv-tag is-accent" title="${k}:[${ns[k]}]">別 …${String(ns[k]).slice(-3)}</span>`}</td>`).join('')}<td>${p.hostname && init && p.hostname !== init.hostname ? `<b>${esc(p.hostname)}</b>` : `<span class="lv-dim">${esc(p.hostname || '')}</span>`}</td><td>${p.root && p.root !== '/' ? `<code>${esc(p.root)}</code>` : '<span class="lv-dim">/</span>'}</td><td>${p.cgroup && p.cgroup !== '/' ? `<code>${esc(p.cgroup)}</code>` : '<span class="lv-dim">/</span>'}</td></tr>`;
      });
      const crow = [];
      const walk = (g, d) => {
        crow.push(`<tr><td><span class="ft-ind" style="--d:${d}"></span><code>${esc(d ? g.name : '/')}</code></td><td>${g.procs.length ? g.procs.join(' ') : '<span class="lv-dim">なし</span>'}</td><td class="num">${d ? `${g.pidsCurrent} / ${g.pidsMax}` : '<span class="lv-dim">—</span>'}</td><td class="num">${d ? `${bytes(g.memCurrent)} / ${bytes(g.memMax)}` : '<span class="lv-dim">—</span>'}</td><td class="num">${g.denied ? `<b>${g.denied}</b>` : 0}</td><td class="num">${g.oomKill ? `<b>${g.oomKill}</b>` : 0}</td></tr>`);
        (g.children || []).forEach((c) => walk(c, d + 1));
      };
      walk(sys.cgroups(), 0);
      const nrow = nss.map((n) => `<tr class="${n.pids.includes(1) ? '' : 'is-chg'}"><td>${esc(NS_JA[n.type] || n.type)}</td><td>${esc(n.type)}:[${n.id}]</td><td>${n.pids.includes(1) ? '<span class="lv-dim">ホスト（PID 1 と同じ）</span>' : '新しく作られたもの'}</td><td>${n.pids.join(' ')}</td></tr>`);
      const boxed = nss.filter((n) => !n.pids.includes(1)).length;
      return facts([['名前空間', nss.length, '個'], ['うち、後から作られたもの', boxed, '個'], ['cgroup', crow.length, '個']]) +
        `<div class="lv-sec">${h4('プロセスと、その入れ物', '色のついた行は、ホストと違う名前空間・ルート・cgroup にいるプロセス。「コンテナ」はこの組み合わせ')}
        ${grid([['PID', 'num'], ['中での PID', 'num'], ['コマンド'], ['PID', ''], ['マウント', ''], ['UTS', ''], ['ネット', ''], ['ホスト名'], ['ルート（chroot）'], ['cgroup']], prow)}</div>
        <div class="lv-sec">${h4('cgroup の木', '/sys/fs/cgroup。数と量の上限')}${grid([['グループ'], ['プロセス'], ['pids（いま / 上限）', 'num'], ['memory（いま / 上限）', 'num'], ['fork を断った', 'num'], ['OOM で殺した', 'num']], crow)}</div>
        <div class="lv-sec">${h4('名前空間の一覧', 'lsns と同じもの。番号が同じなら、同じ名前空間')}${grid([['種類'], ['番号'], [''], ['入っているプロセス（PID）']], nrow)}</div>`;
    },
  };

  // ---------------------------------------------------------------- サービス（init と unit、ジャーナル）
  const ACTIVE_JA = { active: '動いている', inactive: '止まっている', failed: '失敗', activating: '起動中', deactivating: '停止中' };
  const STAGE_JA = { firmware: 'ファームウェア', bootloader: 'ブートローダ', kernel: 'カーネル', initramfs: 'initramfs', init: 'init（PID 1）' };
  const unitSection = {
    id: 'units', title: 'サービス',
    changed: (ctx) => (ctx.run ? ctx.run.events.some((e) => e.type === 'exec' && /\/(systemctl|reboot|poweroff|shutdown|halt)$/.test(e.path || '')) : false),
    render(ctx) {
      const { sys } = ctx;
      if (!sys.units) return empty('この機械には、init の部品（init.js）が入っていません。');
      const us = sys.units(), t = sys.time();
      const rows = us.map((u) => `<tr class="${u.active === 'active' ? 'is-add' : u.active === 'failed' ? 'is-del-soft' : ''}"><td><b>${esc(u.name)}</b></td><td><span class="tv-st is-${esc(u.active)}">${esc(u.active)}</span><span class="lv-dim">（${esc(u.sub)}）${esc(ACTIVE_JA[u.active] || '')}</span></td><td>${u.enabled ? 'enabled<span class="lv-dim">（起動時に始まる）</span>' : '<span class="lv-dim">disabled</span>'}</td><td class="num">${u.mainPid || '<span class="lv-dim">—</span>'}</td><td class="num">${u.restarts}</td><td>${esc(u.result)}</td><td class="lv-wrap">${esc(u.description)}</td><td><code>${esc(u.path)}</code></td></tr>`);
      const js = sys.journal ? sys.journal({ n: 40 }) : [];
      const jl = js.map((e) => `<div class="ts-l${e.prio <= 3 ? ' ts-bad' : ''}"><span class="ts-p">${esc(String(e.time).slice(11))} </span><span class="ts-n">${esc(e.ident)}[${e.pid}]</span>: ${esc(e.msg)}</div>`).join('');
      const boot = sys.bootlog ? sys.bootlog() : [];
      let stage = '';
      const bl = boot.map((e) => { const head = e.stage !== stage ? `<div class="ts-l ts-sep">${esc(STAGE_JA[e.stage] || e.stage)}</div>` : ''; stage = e.stage; return `${head}<div class="ts-l"><span class="ts-p">[${e.t.toFixed(3).padStart(8)}] </span>${esc(e.text)}</div>`; }).join('');
      return facts([['unit', us.length, '個'], ['動いている', us.filter((u) => u.active === 'active').length, '個'], ['起動時に始まる（enabled）', us.filter((u) => u.enabled).length, '個'], ['時刻', t.date]]) +
        `<div class="lv-sec">${h4('サービス（unit）', 'systemctl list-units と同じもの。PID 1 の init が起こして、見張っている')}${rows.length ? grid([['unit'], ['状態'], ['自動起動'], ['PID', 'num'], ['起動し直した回数', 'num'], ['結果'], ['説明'], ['unit ファイル']], rows) : empty('unit はありません。')}</div>
        <div class="lv-sec">${h4('ジャーナル', `journalctl と同じもの。新しい ${js.length} 行`)}${jl ? `<div class="tm-trace lv-trace">${jl}</div>` : empty('まだ何も書かれていません。')}</div>
        ${bl ? `<details class="lv-fold"><summary>起動のログ（電源を入れてから PID 1 が動くまで。${boot.length} 行）</summary><div class="tm-trace lv-trace">${bl}</div></details>` : ''}`;
    },
  };

  // 「システムコール」「出来事」の前に入れる
  const at = VIEW.sections.findIndex((s) => s.id === 'sys');
  VIEW.sections.splice(at < 0 ? VIEW.sections.length : at, 0, memSection, schedSection, pcSection, netSection, nsSection, unitSection);
})();
