// trace="sched|mem|pagecache|net" の専用表示（LNXUI.traceViews に登録する）。lnx-run.js の後、lnxview.js の前に読み込む。
// どれも (events, r) → HTML。events はその種類の観察用イベント（形式は sched.js / mm.js / pagecache.js / net.js の先頭コメント）、r は sys.run の結果。
//   sched      ガントチャート（run { pid, comm, start, dur, nice, vruntime } から。見た目は diagrams.mjs の gantt と同じ）+ プロセスごとの CPU 時間
//   mem        ページフォルト・コピーオンライト・OOM の数と、起きた順の一覧（同じ種類が続いたら 1 行にまとめる）
//   pagecache  hit / miss / dirty / 書き戻しの数、「プロセス ↔ ページキャッシュ ↔ ディスク」の流れの図、起きた順の一覧
//   net        パケットのシーケンス図（接続ごとに 2 本の縦線。SYN、SYN,ACK、ACK … の矢印と、その時点の TCP の状態）+ 状態の変化の表
// 「システムを見る」（lnxview-adv.js）も同じ表示を使う。図の部品は LNXUI.svg に置く（gantt など）。
(() => {
  const LNX = window.LNX, UI = window.LNXUI;
  if (!LNX || !UI) return;
  const { esc, fmtN } = UI;
  const r1 = (n) => Math.round(n * 10) / 10;
  const dec = (s) => { try { return LNX.util.dec(s); } catch (e) { return s; } };

  // ---------------------------------------------------------------- SVG の部品（src/lib/diagrams.mjs と同じクラスを使う）
  function tw(s, fs = 13, mono = false) {
    let w = 0;
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      if (c > 0x2e7f || (c >= 0x2000 && c <= 0x206f && c !== 0x2192)) w += fs;
      else if (c === 0x2192 || c === 0x2190) w += fs * 0.9;
      else w += fs * (mono ? 0.6 : 0.56);
    }
    return w;
  }
  const text = (x, y, s, cls = '', anchor = 'start') => `<text x="${r1(x)}" y="${r1(y)}" class="${cls}" text-anchor="${anchor}" dominant-baseline="central">${esc(String(s))}</text>`;
  let seq = 0;
  // 図を包む。幅が足りなければ横にスクロールする（縮めると字が読めなくなるので）
  function wrap(w, h, body, label) {
    const id = 'tv' + (++seq);
    const mk = (k, cls) => `<marker id="${id}-${k}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1.2 L9 5 L1 8.8 Z" class="${cls}"/></marker>`;
    return `<div class="tv-svg"><svg class="dg" viewBox="0 0 ${r1(w)} ${r1(h)}" width="${r1(w)}" height="${r1(h)}" role="img" aria-label="${esc(label || '図')}" xmlns="http://www.w3.org/2000/svg"><defs>${mk('a', 'd-mk-accent')}${mk('n', 'd-mk-ink')}${mk('m', 'd-mk-muted')}</defs>${body.replace(/url\(#@-/g, `url(#${id}-`)}</svg></div>`;
  }

  // ガントチャート。spec は diagrams.mjs の gantt と同じ（rows: [{ label, spans: [{ from, to, kind, hl, label }], note }]、cpu、switches、marks、end、start、tick、unit、width）
  function gantt(spec) {
    const PAD = 14, RH = 26, GAPY = 10, FS = 13;
    const rows = spec.rows || [];
    const all = rows.flatMap((r) => r.spans);
    const t0 = spec.start ?? 0, t1 = spec.end ?? Math.max(1, ...all.map((s) => s.to));
    const CW = spec.width || 520, sc = CW / Math.max(1, t1 - t0);
    const labW = Math.max(spec.cpu ? tw('CPU', FS) : 0, ...rows.map((r) => tw(r.label || '', FS))) + 14;
    const X0 = PAD + labW, Y0 = PAD + (spec.marks && spec.marks.some((m) => m.label) ? 18 : 0);
    const X = (t) => X0 + (t - t0) * sc;
    const nRows = rows.length + (spec.cpu ? 1 : 0);
    const bottom = Y0 + nRows * (RH + GAPY) - GAPY;
    let step = spec.tick;
    if (!step) { const raw = (t1 - t0) / 8; step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000, 50000].find((v) => v >= raw) || Math.ceil(raw); }
    let body = '';
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      body += `<line x1="${r1(X(t))}" y1="${Y0 - 2}" x2="${r1(X(t))}" y2="${bottom + 4}" class="d-gt-grid"/>` + text(X(t), bottom + 14, fmtN(t), 'd-mono d-tiny d-muted', 'middle');
    }
    const unit = spec.unit || 'tick';
    body += text(X(t1) + 10, bottom + 14, unit, 'd-tiny d-muted');
    const isRun = (s) => !s.kind || s.kind === 'run';
    if (spec.switches) {
      const cuts = new Set();
      all.filter(isRun).forEach((s) => { cuts.add(s.from); cuts.add(s.to); });
      cuts.forEach((t) => { if (t > t0 && t < t1) body += `<line x1="${r1(X(t))}" y1="${Y0 - 2}" x2="${r1(X(t))}" y2="${bottom + 2}" class="d-gt-sw"/>`; });
    }
    let maxX = X(t1) + 10 + tw(unit, 10.5);
    const bar = (s, y, ci, lab) => {
      const x = X(Math.max(s.from, t0)), w = Math.max(1.5, X(Math.min(s.to, t1)) - x);
      const cls = s.kind === 'wait' ? 'd-gt-wait' : s.kind === 'ready' ? 'd-gt-ready' : `d-gt-run d-gt-c${ci % 4}${s.hl ? ' d-gt-hl' : ''}`;
      let h = `<rect x="${r1(x)}" y="${y}" width="${r1(w)}" height="${RH}" rx="${w < 6 ? 1 : 4}" class="${cls}"><title>${fmtN(s.from)}〜${fmtN(s.to)} ${esc(unit)}（${fmtN(s.to - s.from)}）</title></rect>`;
      if (lab && tw(lab, 11.5) + 6 <= w) h += text(x + w / 2, y + RH / 2, lab, `d-small ${s.kind === 'wait' || s.kind === 'ready' ? 'd-muted' : 'd-val'}`, 'middle');
      return h;
    };
    rows.forEach((r, i) => {
      const y = Y0 + i * (RH + GAPY);
      body += text(X0 - 12, y + RH / 2, r.label || '', 'd-val', 'end');
      body += `<rect x="${X0}" y="${y}" width="${CW}" height="${RH}" rx="4" class="d-gt-track"/>`;
      r.spans.forEach((s) => { if (s.to > t0 && s.from < t1) body += bar(s, y, r.color ?? i, s.label); });
      if (r.note) { body += text(X(t1) + 10, y + RH / 2, r.note, 'd-small d-muted'); maxX = Math.max(maxX, X(t1) + 10 + tw(r.note, 11.5)); }
    });
    if (spec.cpu) {
      const y = Y0 + rows.length * (RH + GAPY);
      body += text(X0 - 12, y + RH / 2, 'CPU', 'd-val', 'end');
      body += `<rect x="${X0}" y="${y}" width="${CW}" height="${RH}" rx="4" class="d-gt-track"/>`;
      rows.forEach((r, i) => r.spans.filter(isRun).forEach((s) => { if (s.to > t0 && s.from < t1) body += bar(s, y, r.color ?? i, r.short || ''); }));
    }
    (spec.marks || []).forEach((m) => {
      body += `<line x1="${r1(X(m.at))}" y1="${Y0 - 6}" x2="${r1(X(m.at))}" y2="${bottom + 4}" class="d-gt-mark"/>`;
      if (m.label) { body += text(X(m.at), Y0 - 14, m.label, 'd-small d-accent-t', 'middle'); maxX = Math.max(maxX, X(m.at) + tw(m.label, 11.5) / 2); }
    });
    return wrap(maxX + PAD, bottom + 22 + PAD - 6, body, spec.label || 'スケジューラのガントチャート');
  }

  // ---------------------------------------------------------------- 共通
  const stat = (n, label, cls) => `<span class="tv-stat${cls ? ' ' + cls : ''}"><b>${typeof n === 'number' ? fmtN(n) : esc(n)}</b>${esc(label)}</span>`;
  const stats = (list) => `<div class="tv-stats">${list.filter(Boolean).join('')}</div>`;
  const note = (t) => `<p class="tv-note">${t}</p>`;
  const tag = (t, cls) => `<span class="tv-tag${cls ? ' is-' + cls : ''}">${esc(t)}</span>`;
  // pid → コマンドの名前（fork / exec の記録から。なければ空）
  function names(r) {
    const m = new Map();
    for (const e of (r && r.events) || []) {
      if (e.type === 'fork' && !m.has(e.pid)) m.set(e.pid, e.comm || '');
      else if (e.type === 'exec') m.set(e.pid, String((e.argv && e.argv[0]) || e.path || '').replace(/^.*\//, ''));
      else if (e.comm && e.pid && !m.has(e.pid)) m.set(e.pid, e.comm);
    }
    return m;
  }
  const who = (nm, pid) => (pid ? `PID ${pid}${nm.get(pid) ? ` <b>${esc(nm.get(pid))}</b>` : ''}` : 'カーネル');
  const base = (evs, r) => { const a = (r && r.events && r.events.length ? r.events : evs); return a.length ? a.reduce((m, e) => Math.min(m, e.t), Infinity) : 0; };
  // 起きた順の一覧。rows = [{ t, tag: HTML, body: HTML }]
  function timeline(rows, max = 400) {
    return `<div class="ev-list tv-tl">${rows.slice(0, max).map((x) => `<div class="ev-l"><span class="ev-t">+${fmtN(x.t)}</span>${x.tag}<span class="ev-r">${x.body}</span></div>`).join('')}${
      rows.length > max ? `<div class="ev-l ts-x">…（残り ${fmtN(rows.length - max)} 行は省略）</div>` : ''}</div>`;
  }
  // 続いている同じ種類の出来事を 1 つにまとめる。key(e) が同じ間は同じ組
  function groups(evs, key) {
    const out = [];
    let last = null;
    for (const e of evs) {
      const k = key(e);
      if (last && last.key === k) last.list.push(e);
      else out.push(last = { key: k, list: [e] });
    }
    return out;
  }
  // [0,1,2,5,6] → '0〜2、5〜6'
  function ranges(ns, max = 4) {
    const a = Array.from(new Set(ns)).sort((x, y) => x - y), out = [];
    for (let i = 0; i < a.length; i++) { let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++; out.push(j > i ? `${a[i]}〜${a[j]}` : String(a[i])); i = j; }
    return out.length > max ? out.slice(0, max).join('、') + ' ほか' : out.join('、');
  }
  const table = (heads, rows, cls) => `<div class="dbv-grid tv-grid${cls ? ' ' + cls : ''}"><table><thead><tr>${heads.map((h) => `<th${h[1] ? ` class="${h[1]}"` : ''}>${esc(h[0])}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const share = (x, total) => `<span class="tv-bar"><i style="width:${total ? r1((100 * x) / total) : 0}%"></i></span>${total ? ((100 * x) / total).toFixed(1) : '0.0'}%`;

  // ---------------------------------------------------------------- sched：ガントチャート
  const MAX_SPANS = 90, MAX_ROWS = 10;
  function schedView(evs) {
    const runs = evs.filter((e) => e.type === 'run' && e.dur > 0).sort((a, b) => a.start - b.start);
    if (!runs.length) return '';
    const t0 = runs[0].start, tEnd = Math.max(...runs.map((e) => e.start + e.dur));
    const by = new Map();
    for (const e of runs) {
      let p = by.get(e.pid);
      if (!p) by.set(e.pid, p = { pid: e.pid, cpu: 0, n: 0, spans: [], first: e.start });
      p.comm = e.comm; p.nice = e.nice; p.weight = e.weight; p.vr = e.vruntime; p.cpu += e.dur; p.n++;
      const from = e.start - t0, to = from + e.dur, last = p.spans[p.spans.length - 1];
      if (last && last.to === from) last.to = to; else p.spans.push({ from, to });
    }
    const procs = Array.from(by.values());
    const total = procs.reduce((a, p) => a + p.cpu, 0), elapsed = tEnd - t0;
    // 図に出す行（多すぎるときは、CPU を多く使った順に MAX_ROWS 個）と、時間の範囲（区間が多すぎるときは、最初の MAX_SPANS 個が入るところまで）
    const shown = procs.length > MAX_ROWS ? procs.slice().sort((a, b) => b.cpu - a.cpu).slice(0, MAX_ROWS).sort((a, b) => a.first - b.first) : procs;
    const spans = shown.flatMap((p) => p.spans).sort((a, b) => a.from - b.from);
    const end = spans.length > MAX_SPANS ? spans[MAX_SPANS - 1].to : elapsed;
    const inWin = spans.filter((s) => s.from < end).length;
    const anyNice = procs.some((p) => p.nice);
    const marks = evs.filter((e) => e.type === 'nice' && e.t - t0 > 0 && e.t - t0 < end).slice(0, 3).map((e) => ({ at: e.t - t0, label: `PID ${e.pid} を nice ${e.nice} に` }));
    const svg = gantt({
      rows: shown.map((p) => ({ label: `${p.comm}（PID ${p.pid}）`, short: String(p.pid), spans: p.spans, note: anyNice ? `nice ${p.nice}` : '' })),
      cpu: shown.length > 1, switches: inWin <= 40, marks, end, unit: 'ミリ秒', width: 540,
    });
    const nSw = evs.filter((e) => e.type === 'switch').length;
    const rows = procs.map((p) => `<tr><td class="num">${p.pid}</td><td>${esc(p.comm)}</td><td class="num">${p.nice}</td><td class="num">${fmtN(p.weight ?? '')}</td><td class="num">${fmtN(p.n)}</td><td class="num">${fmtN(p.cpu)}</td><td class="num tv-share">${share(p.cpu, total)}</td><td class="num">${fmtN(Math.round(p.vr * 100) / 100)}</td></tr>`);
    return stats([stat(elapsed, ' ミリ秒の間'), stat(total, ' ミリ秒 CPU が使われた'), stat(procs.length, ' 個のプロセスが走った'), stat(nSw, ' 回の切り替え')]) +
      svg +
      note(`横軸は、最初のプロセスが走り始めてからの仮想時間（ミリ秒）。色のついた区間が、そのプロセスが CPU を使っていた時間です。${
        end < elapsed ? `切り替えが多いので、最初の ${fmtN(end)} ミリ秒だけを描いています（全体は ${fmtN(elapsed)} ミリ秒）。` : ''}${
        procs.length > shown.length ? `プロセスが多いので、CPU を多く使った ${shown.length} 個だけを描いています。` : ''}`) +
      table([['PID', 'num'], ['コマンド'], ['nice', 'num'], ['重み', 'num'], ['走った回数', 'num'], ['CPU 時間（ミリ秒）', 'num'], ['割合', 'num'], ['最後の vruntime', 'num']], rows);
  }

  // ---------------------------------------------------------------- mem：ページフォルト、コピーオンライト、OOM
  const kib = (bytes) => (bytes >= 1048576 && bytes % 1048576 === 0 ? `${bytes / 1048576} MiB` : `${fmtN(Math.round(bytes / 1024))} KiB`);
  const areaName = (a) => (a ? esc(a) : '名前のない領域（mmap）');
  function memView(evs, r) {
    if (!evs.length) return '';
    const nm = names(r), b = base(evs, r);
    const c = { minor: 0, major: 0, cow: 0, copied: 0, oom: 0, alloc: 0 };
    const per = new Map();
    const P = (pid) => per.get(pid) || per.set(pid, { pid, minor: 0, major: 0, cow: 0, alloc: 0 }).get(pid);
    for (const e of evs) {
      if (e.type === 'fault') { c[e.kind === 'major' ? 'major' : 'minor']++; P(e.pid)[e.kind === 'major' ? 'major' : 'minor']++; }
      else if (e.type === 'cow') { c.cow++; if (e.copied !== false) c.copied++; P(e.pid).cow++; }
      else if (e.type === 'oom') c.oom++;
      else if (e.type === 'alloc' && e.op !== 'exec') { c.alloc += e.len || 0; P(e.pid).alloc += e.len || 0; }
    }
    const gs = groups(evs, (e) => [e.type, e.pid, e.kind, e.write, e.area, e.op, e.copied].join('|'));
    const tl = gs.map((g) => {
      const e = g.list[0], n = g.list.length, x = n > 1 ? ` ×${fmtN(n)}` : '';
      const span = () => (n > 1 ? `${esc(e.addr)}〜${esc(g.list[n - 1].addr)}` : esc(e.addr));
      let tg, body;
      if (e.type === 'fault') {
        tg = tag(`ページフォルト${x}`, e.kind === 'major' ? 'warn' : 'steel');
        body = `${who(nm, e.pid)}　${e.kind === 'major' ? 'major（ディスクから読んだ）' : 'minor'}・${e.write ? '書き込み' : '読み込み'}・${areaName(e.area)}・${span()} → フレーム ${n > 1 ? `${e.frame} ほか` : e.frame}`;
      } else if (e.type === 'cow') {
        tg = tag(`コピーオンライト${x}`, 'heap');
        body = `${who(nm, e.pid)}　${span()}：${e.copied === false ? '共有していた相手がもういないので、複製せずに書けるようにした' : `フレーム ${e.from} を複製して、フレーム ${e.frame} に書いた${n > 1 ? '（ほか）' : ''}`}`;
      } else if (e.type === 'alloc') {
        const len = g.list.reduce((a, v) => a + (v.len || 0), 0);
        tg = tag(e.op === 'exec' ? 'アドレス空間を作る' : `領域を確保（${e.op}）${x}`, 'muted');
        body = `${who(nm, e.pid)}　${esc(e.addr)} から ${kib(len)}${e.area ? `・${esc(e.area)}` : ''}（フレームは、触るまで割り当てない）`;
      } else if (e.type === 'free') {
        const pages = g.list.reduce((a, v) => a + (v.pages || 0), 0), fr = g.list.reduce((a, v) => a + (v.frames || 0), 0);
        tg = tag(`領域を返す（${e.op}）${x}`, 'muted');
        body = `${who(nm, e.pid)}　${fmtN(pages)} ページ（空いたフレーム ${fmtN(fr)} 個）`;
      } else if (e.type === 'forkmm') {
        tg = tag('fork：ページ表を複製', 'sage');
        body = `${who(nm, e.pid)} → 子 PID ${e.child}　${fmtN(e.pages)} ページをコピーオンライトにした（フレームは複製していない）`;
      } else if (e.type === 'oom') {
        tg = tag('OOM killer', 'bad');
        body = `PID ${e.pid} <b>${esc(e.comm || '')}</b> を SIGKILL した（RSS ${fmtN(e.rss)} kB）${e.cgroup && e.cgroup !== '/' ? `・cgroup ${esc(e.cgroup)} の上限` : '・メモリが足りない'}`;
      } else { tg = tag(e.type, 'muted'); body = esc(JSON.stringify(e)); }
      return { t: e.t - b, tag: tg, body };
    });
    const rows = Array.from(per.values()).filter((p) => p.minor || p.major || p.cow || p.alloc).map((p) => `<tr><td class="num">${p.pid}</td><td>${esc(nm.get(p.pid) || '')}</td><td class="num">${fmtN(p.minor)}</td><td class="num">${fmtN(p.major)}</td><td class="num">${fmtN(p.cow)}</td><td class="num">${p.alloc ? kib(p.alloc) : '—'}</td></tr>`);
    return stats([stat(c.minor + c.major, ` 回のページフォルト（minor ${fmtN(c.minor)}・major ${fmtN(c.major)}）`), stat(c.cow, ` 回のコピーオンライト${c.cow ? `（複製 ${fmtN(c.copied)} ページ）` : ''}`), stat(c.oom, ' 回の OOM', c.oom ? 'is-bad' : ''), c.alloc ? stat(kib(c.alloc), ' を確保（mmap / brk）') : '']) +
      (rows.length ? table([['PID', 'num'], ['コマンド'], ['minor', 'num'], ['major', 'num'], ['コピーオンライト', 'num'], ['確保した領域', 'num']], rows) : '') +
      note('下は起きた順。左の数字は、コマンドを始めてからの仮想時間（ミリ秒）。同じ種類が続いたところは 1 行にまとめています。') + timeline(tl);
  }

  // ---------------------------------------------------------------- pagecache：hit / miss / dirty / 書き戻し
  const REASON = { sync: 'sync', fsync: 'fsync', expire: '時間切れ（見回り）', reclaim: 'メモリ不足', drop_caches: 'drop_caches', truncate: 'ファイルを切り詰めた' };
  function flowSvg(c) {
    const BW = 132, BH = 46, GAP = 150, PAD = 14, Y = 58;
    const xs = [PAD, PAD + BW + GAP, PAD + 2 * (BW + GAP)];
    const box = (i, label, sub, kind) => `<g class="d-node d-node-${kind}"><rect x="${xs[i]}" y="${Y}" width="${BW}" height="${BH}" rx="9" class="d-nrect"/>${text(xs[i] + BW / 2, Y + (sub ? 16 : BH / 2), label, 'd-nlabel', 'middle')}${sub ? text(xs[i] + BW / 2, Y + 33, sub, 'd-tiny', 'middle') : ''}</g>`;
    // 上の矢印（読む：右 → 左）、下の矢印（書く：左 → 右）
    const arrow = (i, up, label, sub, on) => {
      const x0 = xs[i] + BW + 4, x1 = xs[i + 1] - 4, y = up ? Y + 12 : Y + BH - 12, ty = up ? Y - 12 : Y + BH + 14;
      const d = up ? `M${x1} ${y} L${x0 + 4} ${y}` : `M${x0} ${y} L${x1 - 4} ${y}`;
      return `<path d="${d}" class="d-edge d-edge-${on ? (up ? 'steel' : 'accent') : 'dashed'}" marker-end="url(#@-${on ? (up ? 'n' : 'a') : 'm'})"/>` +
        text((x0 + x1) / 2, ty, label, `d-small ${on ? 'd-val' : 'd-muted'}`, 'middle') + (sub ? text((x0 + x1) / 2, ty + (up ? -15 : 15), sub, 'd-tiny d-muted', 'middle') : '');
    };
    const body = box(0, 'プロセス', 'read / write', 'stack') + box(1, 'ページキャッシュ', 'メモリの中', 'ext') + box(2, 'ディスク', '遅い（1 ページ 5 ms）', 'crate') +
      arrow(0, true, `hit ${fmtN(c.hit)} ページ`, 'キャッシュにあった（速い）', c.hit > 0) + arrow(1, true, `miss ${fmtN(c.miss)} ページ`, c.missMs ? `ディスクから読んだ（${fmtN(c.missMs)} ms 待った）` : 'ディスクから読む', c.miss > 0) +
      arrow(0, false, `dirty ${fmtN(c.dirty)} ページ`, 'キャッシュに書いただけ', c.dirty > 0) + arrow(1, false, `書き戻し ${fmtN(c.wb)} ページ`, c.wbMs ? `ディスクに書いた（${fmtN(c.wbMs)} ms）` : 'ディスクに書く', c.wb > 0);
    return wrap(xs[2] + BW + PAD, Y + BH + 44, body, 'プロセスとページキャッシュとディスクの間の流れ');
  }
  function pagecacheView(evs, r) {
    if (!evs.length) return '';
    const nm = names(r), b = base(evs, r);
    const c = { hit: 0, miss: 0, missMs: 0, dirty: 0, wb: 0, wbMs: 0, clean: 0, drop: 0, lost: 0 };
    const per = new Map();
    const F = (e) => per.get(e.path || e.ino) || per.set(e.path || e.ino, { path: e.path || `inode ${e.ino}`, hit: 0, miss: 0, dirty: 0, wb: 0 }).get(e.path || e.ino);
    for (const e of evs) {
      if (e.type === 'hit') { c.hit++; F(e).hit++; }
      else if (e.type === 'miss') { c.miss++; c.missMs += e.ms || 0; F(e).miss++; }
      else if (e.type === 'dirty') { c.dirty++; F(e).dirty++; }
      else if (e.type === 'writeback') { c.wb += e.pages || 0; c.wbMs += e.ms || 0; F(e).wb += e.pages || 0; }
      else if (e.type === 'clean') c.clean += e.pages || 0;
      else if (e.type === 'drop') c.drop += e.pages || 0;
      else if (e.type === 'lost') c.lost++;
    }
    const gs = groups(evs, (e) => (e.type === 'hit' || e.type === 'miss' || e.type === 'dirty' ? [e.type, e.pid, e.ino].join('|') : Math.random()));
    const path = (e) => `<code>${esc(e.path || `inode ${e.ino}`)}</code>`;
    const tl = gs.map((g) => {
      const e = g.list[0], n = g.list.length, x = n > 1 ? ` ×${fmtN(n)}` : '', pages = `ページ ${ranges(g.list.map((v) => v.page))}`;
      let tg, body;
      if (e.type === 'hit') { tg = tag(`hit${x}`, 'sage'); body = `${path(e)} ${pages}　${who(nm, e.pid)}：キャッシュにあった`; }
      else if (e.type === 'miss') { tg = tag(`miss${x}`, 'warn'); body = `${path(e)} ${pages}　${who(nm, e.pid)}：ディスクから読んだ（${fmtN(g.list.reduce((a, v) => a + (v.ms || 0), 0))} ms 待つ）`; }
      else if (e.type === 'dirty') { tg = tag(`dirty${x}`, 'heap'); body = `${path(e)} ${pages}　${who(nm, e.pid)}：キャッシュに書いた（ディスクにはまだ）`; }
      else if (e.type === 'writeback') { tg = tag('書き戻し', 'accent'); body = `${path(e)} ${fmtN(e.pages)} ページをディスクに書き始めた（きっかけ：${esc(REASON[e.reason] || e.reason)}・${fmtN(e.ms)} ms かかる）`; }
      else if (e.type === 'clean') { tg = tag('書き戻し完了', 'muted'); body = `${path(e)} ${fmtN(e.pages)} ページがきれいになった（ディスクと同じ）`; }
      else if (e.type === 'drop') { tg = tag('捨てた', 'muted'); body = `${fmtN(e.pages)} ページをキャッシュから捨てた（${esc(REASON[e.reason] || e.reason)}）`; }
      else if (e.type === 'lost') { tg = tag('失われた', 'bad'); body = `${path(e)} の書き戻していない ${fmtN(e.bytes)} バイトが、電源断で消えた`; }
      else { tg = tag(e.type, 'muted'); body = esc(JSON.stringify(e)); }
      return { t: e.t - b, tag: tg, body };
    });
    const files = Array.from(per.values()).sort((x, y) => (y.miss + y.dirty + y.wb) - (x.miss + x.dirty + x.wb) || y.hit - x.hit);
    const rows = files.slice(0, 12).map((f) => `<tr><td><code>${esc(f.path)}</code></td><td class="num">${fmtN(f.hit)}</td><td class="num">${fmtN(f.miss)}</td><td class="num">${fmtN(f.dirty)}</td><td class="num">${fmtN(f.wb)}</td></tr>`);
    const reads = c.hit + c.miss;
    return stats([stat(c.hit, ' hit'), stat(c.miss, ' miss', c.miss ? 'is-warn' : ''), reads ? stat(((100 * c.hit) / reads).toFixed(1) + '%', ' がキャッシュで済んだ') : '', stat(c.dirty, ' ページが dirty に'), stat(c.wb, ' ページを書き戻し'), c.drop ? stat(c.drop, ' ページを捨てた') : '', c.lost ? stat(c.lost, ' 個のファイルで変更が消えた', 'is-bad') : '']) +
      flowSvg(c) +
      table([['ファイル'], ['hit', 'num'], ['miss', 'num'], ['dirty', 'num'], ['書き戻し', 'num']], rows) + (files.length > 12 ? note(`ほか ${files.length - 12} 個のファイル（プログラムの実行ファイルやライブラリを読むのも、ページキャッシュを通ります）。`) : '') +
      note('下は起きた順。左の数字は、コマンドを始めてからの仮想時間（ミリ秒）。') + timeline(tl);
  }

  // ---------------------------------------------------------------- net：シーケンス図と TCP の状態
  const STATE_JA = { CLOSED: '閉じている', LISTEN: '待ち受け中', SYN_SENT: 'SYN を送った', SYN_RECV: 'SYN を受けた', ESTABLISHED: 'つながった', FIN_WAIT1: 'FIN を送った', FIN_WAIT2: '相手の FIN を待つ',
    CLOSE_WAIT: '相手が閉じた', LAST_ACK: '最後の ACK を待つ', CLOSING: '同時に閉じた', TIME_WAIT: 'しばらく待つ' };
  const MAX_CONN = 3, MAX_PKT = 40;
  const port = (ep) => String(ep).replace(/^.*:/, '');
  function connSvg(conn, tcp, b) {
    const PAD = 12, TW_ = 46, SW = 104, GAP = 270, HEAD = 42;
    const xL = PAD + TW_ + SW + 10, xR = xL + GAP;
    const pill = (side, y, s) => {
      const w = tw(s, 10, true) + 14, x = side === 'L' ? xL - 10 - w : xR + 10;
      return `<rect x="${r1(x)}" y="${y - 9}" width="${r1(w)}" height="18" rx="9" class="d-snote${s === 'ESTABLISHED' ? ' is-accent' : ''}"/>${text(x + w / 2, y, s, 'd-mono d-tiny d-sn', 'middle')}`;
    };
    // パケットと状態の変化を、起きた順に並べる
    const items = [];
    conn.pkts.slice(0, MAX_PKT).forEach((e) => items.push({ k: 'pkt', e, i: e._i }));
    const tLast = conn.pkts.length > MAX_PKT ? conn.pkts[MAX_PKT - 1]._i : Infinity;
    tcp.forEach((e) => { const side = conn.sideOf(e); if (side && e._i <= tLast) items.push({ k: 'tcp', e, i: e._i, side }); });
    items.sort((x, y) => x.i - y.i);
    let y = PAD + HEAD + 14, body = '';
    let pend = { L: [], R: [] };
    const flush = (yRow) => {   // 待っている状態を置く。yRow があれば、左右それぞれ最後の 1 つをその行に置く
      for (const side of ['L', 'R']) {
        const list = pend[side];
        const keep = yRow !== undefined && list.length ? list.pop() : null;
        list.forEach((s, k) => { body += pill(side, y + k * 22, s); });
        pend[side]._h = list.length * 22;
        pend[side]._keep = keep;
      }
      y += Math.max(pend.L._h, pend.R._h);
      const k = { L: pend.L._keep, R: pend.R._keep };
      pend = { L: [], R: [] };
      return k;
    };
    for (const it of items) {
      if (it.k === 'tcp') { pend[it.side].push(it.e.state); continue; }
      const e = it.e, fromL = e.src === conn.client, data = e.len ? dec(e.data || '').split(/\r?\n/)[0].slice(0, 44) : '';
      const k = flush(0);
      y += 20;
      const ya = y, x0 = fromL ? xL : xR, x1 = fromL ? xR : xL, dir = fromL ? 1 : -1;
      const slow = e.arrive > e.t, y1 = ya + (slow ? 14 : 0);
      const style = /RST/.test(e.flags) ? 'bad' : /SYN|FIN/.test(e.flags) ? 'accent' : 'ink';
      body += text(PAD + TW_ - 6, ya, '+' + fmtN(e.t - b), 'd-mono d-tiny d-muted', 'end');
      body += `<path d="M${x0 + dir * 3} ${ya} L${x1 - dir * 5} ${y1}" class="d-edge d-edge-${style}" marker-end="url(#@-${style === 'ink' ? 'n' : 'a'})"/>`;
      const lab = `${e.flags}  seq=${e.rseq}${/ACK/.test(e.flags) ? ` ack=${e.rack}` : ''}${e.len ? ` len=${e.len}` : ''}`;
      body += text((xL + xR) / 2, ya - 9, lab, `d-mono d-small ${style === 'ink' ? 'd-elabel' : 'd-accent-t'}`, 'middle');
      if (data) body += text((xL + xR) / 2, ya + 11 + (slow ? 8 : 0), `"${data}${e.len > data.length ? '…' : ''}"`, 'd-mono d-tiny d-muted', 'middle');
      if (slow) body += text(fromL ? xR + 6 : xL - 6, y1 + 12, `${fmtN(e.arrive - e.t)} ms 後に届く`, 'd-tiny d-muted', fromL ? 'start' : 'end');
      if (k.L) body += pill('L', ya, k.L);
      if (k.R) body += pill('R', ya, k.R);
      y += 16 + (data ? 12 : 0) + (slow ? 20 : 0);
    }
    y += 6; flush(); y += 14;
    const head = (x, label, sub) => { const w = Math.max(tw(label, 12, true), tw(sub, 10)) + 22; return `<g class="d-node d-node-plain"><rect x="${r1(x - w / 2)}" y="${PAD}" width="${r1(w)}" height="${HEAD}" rx="9" class="d-nrect"/>${text(x, PAD + 14, label, 'd-mono d-small d-nlabel', 'middle')}${text(x, PAD + 30, sub, 'd-tiny d-muted', 'middle')}</g>`; };
    const life = (x) => `<line x1="${x}" y1="${PAD + HEAD}" x2="${x}" y2="${y}" class="d-lifeline"/>`;
    return wrap(xR + 10 + SW + PAD, y + PAD, life(xL) + life(xR) + body + head(xL, conn.client, conn.clientName ? `つなぐ側（${conn.clientName}）` : 'つなぐ側') + head(xR, conn.server, conn.serverName ? `待ち受ける側（${conn.serverName}）` : '待ち受ける側'),
      `${conn.client} と ${conn.server} の間のパケット`);
  }
  function netView(evs, r) {
    if (!evs.length) return '';
    const nm = names(r), b = base(evs, r);
    evs.forEach((e, i) => { e._i = i; });
    const pkts = evs.filter((e) => e.type === 'pkt'), tcp = evs.filter((e) => e.type === 'tcp'), socks = evs.filter((e) => e.type === 'sock'), drops = evs.filter((e) => e.type === 'drop');
    // 接続ごとに分ける（番地の組が同じもの。最初に送った側が「つなぐ側」）
    const conns = new Map();
    for (const e of pkts) {
      const key = [e.src, e.dst].sort().join(' ');
      let c = conns.get(key);
      if (!c) conns.set(key, c = { client: e.src, server: e.dst, pkts: [], socks: { L: new Set(), R: new Set() } });
      c.pkts.push(e);
      if (e.from) c.socks[e.src === c.client ? 'L' : 'R'].add(e.from);
      if (e.to) c.socks[e.src === c.client ? 'R' : 'L'].add(e.to);
    }
    const sockPid = new Map();
    socks.forEach((e) => { if (e.pid && !sockPid.has(e.sock)) sockPid.set(e.sock, e.pid); });
    const list = Array.from(conns.values());
    list.forEach((c) => {
      // 待ち受けのソケット（LISTEN）は、同じポートで待つ側に入れる
      tcp.forEach((e) => { if (!e.peer && port(e.local) === port(c.server) && (e.state === 'LISTEN' || e.old === 'LISTEN')) c.listen = e.sock; });
      c.sideOf = (e) => (c.socks.L.has(e.sock) ? 'L' : c.socks.R.has(e.sock) ? 'R' : e.local === c.client && e.peer === c.server ? 'L' : e.local === c.server && e.peer === c.client ? 'R' : null);
      const name = (set, extra) => { for (const s of [...set, extra]) { const n = nm.get(sockPid.get(s)); if (n) return n; } return ''; };
      c.clientName = name(c.socks.L); c.serverName = name(c.socks.R, c.listen);
    });
    const n = (re) => pkts.filter((e) => re.test(e.flags)).length;
    const bytes = pkts.reduce((a, e) => a + (e.len || 0), 0);
    let h = stats([stat(pkts.length, ' 個のパケット'), stat(list.length, ' 本の接続'), stat(n(/^SYN$/), ' SYN'), stat(n(/FIN/), ' FIN'), n(/RST/) ? stat(n(/RST/), ' RST', 'is-bad') : '', stat(bytes, ' バイトのデータ'), drops.length ? stat(drops.length, ' 個の SYN を捨てた（backlog が一杯）', 'is-bad') : '']);
    list.slice(0, MAX_CONN).forEach((c) => {
      h += connSvg(c, tcp, b);
      if (c.pkts.length > MAX_PKT) h += note(`この接続のパケットは ${fmtN(c.pkts.length)} 個あります。最初の ${MAX_PKT} 個だけを描いています。`);
    });
    if (list.length > MAX_CONN) h += note(`接続が ${list.length} 本あります。最初の ${MAX_CONN} 本だけを描いています。`);
    if (list.length) h += note('縦の線が、それぞれの側のソケット。矢印がパケット（上から下へ時間が進む。左の数字は、コマンドを始めてからのミリ秒）。seq と ack は、接続ごとに 0 から数えた番号です。線の外側の丸い札は、そのときの TCP の状態。');
    if (tcp.length) {
      const role = (e) => { for (const c of list) { if (c.listen === e.sock) return '待ち受け'; const s = c.sideOf(e); if (s) return s === 'L' ? 'つなぐ側' : '待ち受ける側'; } return e.peer ? '' : '待ち受け'; };
      const rows = tcp.slice(0, 80).map((e) => `<tr><td class="num">+${fmtN(e.t - b)}</td><td class="num">${e.sock}</td><td>${esc(role(e))}</td><td>${esc(e.local || '—')}</td><td>${esc(e.peer || '—')}</td><td><span class="tv-st">${esc(e.old)}</span> → <span class="tv-st is-${esc(e.state)}">${esc(e.state)}</span><span class="lv-dim">　${esc(STATE_JA[e.state] || '')}</span></td></tr>`);
      h += `<div class="tv-cap">TCP の状態の変化（${fmtN(tcp.length)} 回）</div>` + table([['時刻', 'num'], ['ソケット', 'num'], ['役割'], ['自分の番地'], ['相手の番地'], ['状態']], rows) + (tcp.length > 80 ? note(`残り ${tcp.length - 80} 回は省略。`) : '');
    }
    if (!list.length && !tcp.length && socks.length) {
      const OP = { socket: 'ソケットを作った', bind: '番地を付けた', listen: '待ち受けを始めた', accept: '接続を受け取った', connect: 'つないだ', shutdown: '片側を閉じた', close: '閉じた' };
      h += timeline(socks.map((e) => ({ t: e.t - b, tag: tag(e.op, 'steel'), body: `${who(nm, e.pid)}　${esc(OP[e.op] || e.op)}（${esc(e.family)}${e.path ? `・${esc(e.path)}` : ''}${e.local ? `・${esc(e.local)}` : ''}${e.peer ? ` → ${esc(e.peer)}` : ''}）` })));
    }
    return h;
  }

  Object.assign(UI.traceViews, { sched: schedView, mem: memView, pagecache: pagecacheView, net: netView });
  UI.svg = { gantt, wrap, text, tw };
  UI.tv = { stat, stats, note, tag, table, names, share };
})();
