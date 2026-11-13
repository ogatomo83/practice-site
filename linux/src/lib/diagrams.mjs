// SVG 図エンジン（図解 Rust から流用 + timeline を追加）：mem（スタック/ヒープ）, graph（依存・フロー）, tree（モジュール木）,
// life（ライフタイム）, seq（シーケンス）, bars（棒グラフ）, layout（バイト列）
// 図解 CPU で追加：circuit（論理回路図）, wave（タイミング図）, pipe（パイプライン図）。spec の形は各関数の上のコメントを見る。
// 図解 Linux で追加：fdtable（fd 表 → ファイル記述 → inode）, pagetable（ページ表）, gantt（スケジューラのガントチャート）。
// 色はすべて CSS クラス経由（ライト/ダーク両対応）。

import { esc } from './highlight.mjs';

let FIG_SEQ = 0;
const FS = 13; // 基本フォントサイズ
const MONO = 'd-mono';

// 文字幅の概算（全角=1em, 半角=0.6em）
export function tw(s, fs = FS, mono = false) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c > 0x2e7f || (c >= 0x2000 && c <= 0x206f && c !== 0x2192)) w += fs;
    else if (c === 0x2192 || c === 0x2190) w += fs * 0.9;
    else w += fs * (mono ? 0.6 : 0.56);
  }
  return w;
}

const r1 = (n) => Math.round(n * 10) / 10;

function defs(pid) {
  const mk = (id, cls) =>
    `<marker id="${pid}-${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1.2 L9 5 L1 8.8 Z" class="${cls}"/></marker>`;
  return `<defs>${mk('a', 'd-mk-accent')}${mk('n', 'd-mk-ink')}${mk('m', 'd-mk-muted')}${mk('s', 'd-mk-steel')}${mk('g', 'd-mk-sage')}
  <pattern id="${pid}-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="d-hatch"/></pattern></defs>`;
}

const markerFor = (style) =>
  ({ accent: 'a', ink: 'n', muted: 'm', dashed: 'm', steel: 's', sage: 'g', bad: 'a' })[style] || 'n';

function text(x, y, s, cls = '', anchor = 'start', extra = '') {
  return `<text x="${r1(x)}" y="${r1(y)}" class="${cls}" text-anchor="${anchor}" dominant-baseline="central"${extra}>${esc(String(s))}</text>`;
}

function svgWrap(pid, w, h, body, label) {
  return `<svg class="dg" viewBox="0 0 ${r1(w)} ${r1(h)}" width="${r1(w)}" style="--w:${r1(w)}px;max-width:${r1(w)}px" role="img" aria-label="${esc(label || '図')}" xmlns="http://www.w3.org/2000/svg">${defs(pid)}${body}</svg>`;
}

// ------------------------------------------------------------------ mem
// spec: { stack: [ {frame:'main', vars:[...]} | var ], heap:[...], statics:[...], width? }
// var: { name, fields:[[k,v],...] | value, state:'moved'|'dead'|'hl', note, id }
//   v が '→id' / '→id:i' / '→var' ならポインタ
// heap: { id, cells:[...], label, state:'freed'|'hl', note, idx:true }
function memSvg(spec, pid) {
  const PAD = 20, ROW = 28, HEAD = 28, GAP_V = 14;
  const frames = (spec.stack || []).map((f) => (f.vars ? f : { frame: null, vars: [f] }));
  // 連続する frame:null をまとめる
  const fr = [];
  for (const f of frames) {
    if (!f.frame && fr.length && !fr[fr.length - 1].frame) fr[fr.length - 1].vars.push(...f.vars);
    else fr.push({ frame: f.frame, vars: [...f.vars] });
  }
  const allVars = fr.flatMap((f) => f.vars);
  allVars.forEach((v) => {
    if (!v.fields) v.fields = [['', v.value === undefined ? '' : v.value]];
  });
  const isPtr = (v) => typeof v === 'string' && v.startsWith('→');
  // 列幅
  let kW = 0, vW = 0, nW = 0;
  allVars.forEach((v) => {
    nW = Math.max(nW, tw(v.name, FS, true) + (v.state === 'moved' ? tw(' ムーブ済み', 11) : 0) + (v.tag || v.deadLabel || v.state ? tw(v.tag || v.deadLabel || 'ムーブ済み', 11.5) + 12 : 0) + (v.fields && v.fields.length === 1 && !v.fields[0][0] ? tw(v.fields[0][1], FS, true) + 16 : 0));
    v.fields.forEach(([k, val]) => {
      kW = Math.max(kW, k ? tw(k, 12, true) : 0);
      vW = Math.max(vW, isPtr(val) ? 24 : tw(val, FS, true));
    });
  });
  const hasK = kW > 0;
  const colK = hasK ? kW + 20 : 0;
  const colV = Math.max(vW + 24, 48);
  const frameLabW = Math.max(0, ...fr.map((f) => (f.frame ? tw(f.frame, 11.5) + 24 - 20 : 0)));
  const SW = Math.max(colK + colV, nW + 24, spec.minStackW || 120, frameLabW);
  const SX = PAD + (spec.leftGutter ?? 28);
  const FRAME_PAD = 10;

  let y = PAD + 22; // 領域見出しの下
  let body = '';
  const anchors = {}; // id -> {x,y,w,h, rows:[{y,cx}]}
  const ptrs = [];
  const hasFrames = fr.some((f) => f.frame);

  fr.forEach((f) => {
    const fy0 = y;
    if (f.frame) y += 24;
    f.vars.forEach((v) => {
      const x = SX + (hasFrames ? FRAME_PAD : 0);
      const w = SW;
      const compact = v.fields.length === 1 && !v.fields[0][0] && !isPtr(v.fields[0][1]);
      const h = compact ? 34 : HEAD + v.fields.length * ROW;
      const st = v.state || '';
      if (compact) {
        let g = `<g class="d-var ${st ? 'is-' + st : ''}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" class="d-stack"/>`;
        g += text(x + 12, y + h / 2, v.name, `${MONO} d-name`);
        const side = st === 'moved' ? 'ムーブ済み' : st === 'dead' ? v.deadLabel || 'スコープ外' : v.tag;
        if (side) g += text(x + 12 + tw(v.name, FS, true) + 8, y + h / 2, side, 'd-small d-muted');
        g += text(x + w - 12, y + h / 2, v.fields[0][1], `${MONO} d-val`, 'end');
        g += '</g>';
        if (v.note) g += text(x + 2, y + h + 12, v.note, 'd-small d-muted');
        body += g;
        anchors[v.id || v.name] = { x, y, w, h, rows: [{ y: y + h / 2 }], kind: 'var' };
        y += h + GAP_V + (v.note ? 16 : 0);
        return;
      }
      const cls = `d-var ${st ? 'is-' + st : ''}`;
      let g = `<g class="${cls}">`;
      g += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" class="d-stack"/>`;
      g += `<line x1="${x}" y1="${y + HEAD}" x2="${x + w}" y2="${y + HEAD}" class="d-sep"/>`;
      g += text(x + 12, y + HEAD / 2, v.name, `${MONO} d-name`);
      if (st === 'moved') g += text(x + w - 10, y + HEAD / 2, 'ムーブ済み', 'd-small d-muted', 'end');
      else if (st === 'dead') g += text(x + w - 10, y + HEAD / 2, v.deadLabel || 'スコープ外', 'd-small d-muted', 'end');
      else if (v.tag) g += text(x + w - 10, y + HEAD / 2, v.tag, 'd-small d-muted', 'end');
      const rows = [];
      v.fields.forEach(([k, val], i) => {
        const ry = y + HEAD + i * ROW;
        if (i > 0) g += `<line x1="${x + 8}" y1="${ry}" x2="${x + w - 8}" y2="${ry}" class="d-sep d-faint"/>`;
        if (hasK) g += text(x + 12, ry + ROW / 2, k, `${MONO} d-key`);
        const vx = hasK ? x + colK + (w - colK) / 2 : x + w / 2;
        if (isPtr(val)) {
          g += `<circle cx="${vx}" cy="${ry + ROW / 2}" r="3.5" class="d-dot ${st ? 'd-dot-dead' : ''}"/>`;
          ptrs.push({ from: { x: vx, y: ry + ROW / 2, right: x + w }, to: val.slice(1), dead: !!st || v.ptrStyle === 'dead', style: v.ptrStyle });
        } else g += text(vx, ry + ROW / 2, val, `${MONO} d-val`, 'middle');
        rows.push({ y: ry + ROW / 2 });
      });
      g += '</g>';
      if (v.note) {
        g += text(x + 2, y + h + 12, v.note, 'd-small d-muted');
      }
      body += g;
      anchors[v.id || v.name] = { x, y, w, h, rows, kind: 'var' };
      y += h + GAP_V + (v.note ? 16 : 0);
    });
    if (f.frame) {
      const fh = y - fy0 - GAP_V + FRAME_PAD;
      body = `<rect x="${SX}" y="${fy0}" width="${SW + FRAME_PAD * 2}" height="${fh}" rx="12" class="d-frame"/>` +
        text(SX + 12, fy0 + 13, f.frame, 'd-small d-muted') + body;
      y += FRAME_PAD + 8;
    }
  });
  const stackBottom = y;
  const stackRight = SX + SW + (hasFrames ? FRAME_PAD * 2 : 0);

  // ヒープ
  const HX = stackRight + (spec.gap || 110);
  const CELL_H = 30;
  let hy = PAD + 22;
  let maxRight = stackRight;
  const placeHeap = (list, regionCls) => {
    list.forEach((hb) => {
      const cells = hb.cells || [];
      const cwf = (c) => (String(c).startsWith('→') ? 30 : tw(c, FS, true) + 16);
      const cw = Math.max(30, ...cells.map(cwf));
      const ws = hb.varw ? cells.map((c) => Math.max(30, cwf(c))) : cells.map(() => cw);
      let w = ws.reduce((a, b) => a + b, 0);
      if (hb.minW && w < hb.minW) { const k = hb.minW / (w || 1); for (let i = 0; i < ws.length; i++) ws[i] *= k; w = hb.minW; }
      if (!cells.length) w = hb.minW || 30;
      const xs = []; { let acc = 0; ws.forEach((v) => { xs.push(acc); acc += v; }); }
      // ポインタ元の高さに揃える
      const src = ptrs.find((p) => p.to.split(':')[0] === hb.id);
      let top = hy + (hb.label ? 18 : 0) + (hb.dy || 0);
      if (src && hb.align !== false) {
        const indexed = src.to.includes(':') && src.from.y - CELL_H - 40 >= top;
        top = Math.max(top, indexed ? src.from.y - CELL_H - 40 : src.from.y - CELL_H / 2);
      }
      const x = HX + (hb.dx || 0);
      const st = hb.state || '';
      let g = `<g class="d-hb ${st ? 'is-' + st : ''}${hb.hl ? ' is-hl' : ''}">`;
      if (hb.label) g += text(x, top - 11, hb.label, 'd-small d-muted');
      g += `<rect x="${x}" y="${top}" width="${w}" height="${CELL_H}" rx="6" class="${regionCls}"/>`;
      if (st === 'freed') g += `<rect x="${x}" y="${top}" width="${w}" height="${CELL_H}" rx="6" fill="url(#${pid}-hatch)" class="d-freedfill"/>`;
      cells.forEach((c, i) => {
        const cx = x + xs[i], cwi = ws[i];
        if (i > 0) g += `<line x1="${cx}" y1="${top + 4}" x2="${cx}" y2="${top + CELL_H - 4}" class="d-sep d-faint"/>`;
        if (typeof c === 'string' && c.startsWith('→')) {
          g += `<circle cx="${cx + cwi / 2}" cy="${top + CELL_H / 2}" r="3.5" class="d-dot${st === 'freed' ? ' d-dot-dead' : ''}"/>`;
          hptrs.push({ x: cx + cwi / 2, y: top + CELL_H / 2, to: c.slice(1), dead: st === 'freed' || hb.weak?.includes(i), weak: hb.weak?.includes(i) });
          return;
        }
        g += text(cx + cwi / 2, top + CELL_H / 2, c, `${MONO} d-val`, 'middle');
        if (hb.idx) g += text(cx + cwi / 2, top + CELL_H + 10, String(i + (hb.idxBase || 0)), 'd-tiny d-muted', 'middle');
      });
      if (st === 'freed') g += text(x + w + 10, top + CELL_H / 2, hb.freedLabel || '解放済み', 'd-small d-accent-t');
      else if (hb.note) g += text(x + w + 10, top + CELL_H / 2, hb.note, 'd-small d-muted');
      g += '</g>';
      body += g;
      anchors[hb.id] = { x, y: top, w, h: CELL_H, xs, ws, kind: 'heap' };
      const noteW = st === 'freed' ? tw(hb.freedLabel || '解放済み', 11) + 10 : hb.note ? tw(hb.note, 11) + 10 : 0;
      maxRight = Math.max(maxRight, x + w + noteW);
      hy = top + CELL_H + (hb.idx ? 22 : 12) + 12;
    });
  };
  const hptrs = [];
  placeHeap(spec.heap || [], 'd-heap');
  if (spec.statics && spec.statics.length) {
    hy += 8;
    placeHeap(spec.statics, 'd-static');
  }

  // 領域見出し
  let heads = text(SX, PAD + 4, spec.stackLabel || 'スタック', 'd-region');
  if ((spec.heap || []).length) heads += text(HX, PAD + 4, spec.heapLabel || 'ヒープ', 'd-region');
  else if ((spec.statics || []).length) heads += text(HX, PAD + 4, spec.staticLabel || '静的領域（バイナリ内）', 'd-region');

  // ポインタ矢印
  let arrows = '';
  ptrs.forEach((p) => {
    const [tid, ti] = p.to.split(':');
    const t = anchors[tid];
    if (!t) return;
    const cls = p.dead ? 'd-arrow d-arrow-dead' : p.style === 'steel' ? 'd-arrow d-arrow-steel' : 'd-arrow';
    const mk = p.dead ? 'm' : p.style === 'steel' ? 's' : 'a';
    if (t.kind === 'heap') {
      let tx, ty, d;
      const sx = p.from.x + 4, sy = p.from.y;
      if (ti !== undefined) {
        tx = t.x + t.xs[+ti] + t.ws[+ti] / 2;
        const below = sy > t.y + t.h / 2 + 4;
        ty = below ? t.y + t.h + 2 : t.y - 2;
        const midx = (sx + tx) / 2;
        d = `M${sx} ${sy} C ${midx} ${sy}, ${tx} ${below ? ty + 50 : ty - 50}, ${tx} ${ty}`;
      } else {
        tx = t.x - 2; ty = t.y + t.h / 2;
        const dx = Math.max(40, (tx - sx) * 0.5);
        d = `M${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
      }
      arrows += `<path d="${d}" class="${cls}" marker-end="url(#${pid}-${mk})"/>`;
    } else {
      // スタック内参照：カードの右側を回って、参照先カードの右端へ
      const sx = p.from.x + 4, sy = p.from.y;
      const ty = t.y + 14;
      const rx = p.from.right + 34;
      const d = `M${sx} ${sy} L ${p.from.right} ${sy} C ${rx} ${sy}, ${rx} ${ty}, ${t.x + t.w + 3} ${ty}`;
      arrows += `<path d="${d}" class="${cls}" marker-end="url(#${pid}-${mk})"/>`;
    }
  });

  hptrs.forEach((p) => {
    const [tid, ti] = p.to.split(':');
    const t = anchors[tid];
    if (!t) return;
    let tx, ty, d;
    const cls = p.weak ? 'd-arrow d-arrow-weak' : p.dead ? 'd-arrow d-arrow-dead' : 'd-arrow';
    const mk = p.dead || p.weak ? 'm' : 'a';
    if (t.kind === 'heap') {
      tx = ti !== undefined ? t.x + t.xs[+ti] + t.ws[+ti] / 2 : t.x + Math.min(t.w / 2, 15);
      if (t.y > p.y + 10) { ty = t.y - 2; d = `M${p.x} ${p.y + 4} C ${p.x} ${p.y + 40}, ${tx} ${ty - 30}, ${tx} ${ty}`; }
      else if (t.y + t.h < p.y - 10) { ty = t.y + t.h + 2; d = `M${p.x} ${p.y - 4} C ${p.x} ${p.y - 40}, ${tx} ${ty + 30}, ${tx} ${ty}`; }
      else { tx = t.x - 2; ty = t.y + t.h / 2; d = `M${p.x} ${p.y} C ${p.x + 40} ${p.y + 40}, ${tx - 40} ${ty + 40}, ${tx} ${ty}`; }
    } else {
      // ヒープ → スタック（まれ）
      tx = t.x + t.w + 3; ty = t.y + 14;
      d = `M${p.x} ${p.y} C ${p.x - 60} ${p.y}, ${tx + 40} ${ty}, ${tx} ${ty}`;
    }
    arrows += `<path d="${d}" class="${cls}" marker-end="url(#${pid}-${mk})"/>`;
  });

  const W = Math.max(maxRight, stackRight) + PAD;
  const H = Math.max(stackBottom, hy) + PAD - 8;
  return { svg: svgWrap(pid, W, H, heads + body + arrows, spec.label), w: W };
}

// ------------------------------------------------------------------ graph
// spec: { nodes:[{id,label,sub,x,y,w,kind}], edges:[{from,to,label,style,curve,both}], groups:[{label,nodes,kind}], col, row }
function graphSvg(spec, pid) {
  let COL = spec.col || 190, ROW = spec.row || 92;
  const PAD = 24;
  const nodes = {};
  // ノード同士が重ならないよう、列幅・行高を自動で広げる
  const pre = spec.nodes.map((n) => {
    const lines = String(n.label).split('\n');
    const lw = Math.max(...lines.map((l) => tw(l, FS, n.mono !== false && /^[\x00-\x7f]+$/.test(l))));
    const sw = n.sub ? tw(n.sub, 11) : 0;
    return { n, w: n.w || Math.max(spec.minW || 96, Math.max(lw, sw) + 32), h: n.h || (lines.length * 18 + (n.sub ? 16 : 0) + 18) };
  });
  for (const a of pre) for (const b of pre) {
    if (a === b) continue;
    const dx = Math.abs(a.n.x - b.n.x), dy = Math.abs(a.n.y - b.n.y);
    if (dy < 0.5 && dx > 0) COL = Math.max(COL, (a.w / 2 + b.w / 2 + 48) / dx);
    if (dx < 0.5 && dy > 0) ROW = Math.max(ROW, (a.h / 2 + b.h / 2 + 36) / dy);
  }
  const preById = Object.fromEntries(pre.map((p) => [p.n.id, p]));
  (spec.edges || []).forEach((e) => {
    const a = preById[e.from], b = preById[e.to];
    if (!a || !b || !e.label || e.curve) return;
    const lw = tw(e.label, 11, /^[\x00-\x7f]+$/.test(e.label)) + 28;
    const dx = Math.abs(a.n.x - b.n.x), dy = Math.abs(a.n.y - b.n.y);
    if (dy < 0.5 && dx > 0) COL = Math.max(COL, (a.w / 2 + b.w / 2 + lw + 24) / dx);
    if (dx < 0.5 && dy > 0) ROW = Math.max(ROW, (a.h / 2 + b.h / 2 + 30) / dy);
  });
  spec.nodes.forEach((n) => {
    const lines = String(n.label).split('\n');
    const lw = Math.max(...lines.map((l) => tw(l, FS, n.mono !== false && /^[\x00-\x7f]+$/.test(l))));
    const sw = n.sub ? tw(n.sub, 11) : 0;
    const w = n.w || Math.max(spec.minW || 96, Math.max(lw, sw) + 32);
    const h = n.h || (lines.length * 18 + (n.sub ? 16 : 0) + 18);
    nodes[n.id] = { ...n, lines, w, h, cx: PAD + n.x * COL, cy: PAD + n.y * ROW };
  });
  // バウンディング
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const all = Object.values(nodes);
  all.forEach((n) => {
    minX = Math.min(minX, n.cx - n.w / 2); maxX = Math.max(maxX, n.cx + n.w / 2);
    minY = Math.min(minY, n.cy - n.h / 2); maxY = Math.max(maxY, n.cy + n.h / 2);
  });
  // グループ
  let gsvg = '';
  const groupBoxes = [];
  (spec.groups || []).forEach((g) => {
    const ns = g.nodes.map((id) => nodes[id]);
    const gp = g.pad || 16;
    let x0 = Math.min(...ns.map((n) => n.cx - n.w / 2)) - gp;
    let x1 = Math.max(...ns.map((n) => n.cx + n.w / 2)) + gp;
    let y0 = Math.min(...ns.map((n) => n.cy - n.h / 2)) - gp - 20;
    let y1 = Math.max(...ns.map((n) => n.cy + n.h / 2)) + gp;
    x1 = Math.max(x1, x0 + tw(g.label, 12) + 24);
    groupBoxes.push({ x0, y0, x1, y1, g });
    minX = Math.min(minX, x0); maxX = Math.max(maxX, x1); minY = Math.min(minY, y0); maxY = Math.max(maxY, y1);
  });
  groupBoxes
    .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))
    .forEach(({ x0, y0, x1, y1, g }) => {
      gsvg += `<rect x="${r1(x0)}" y="${r1(y0)}" width="${r1(x1 - x0)}" height="${r1(y1 - y0)}" rx="14" class="d-group d-group-${g.kind || 'plain'}"/>`;
      gsvg += text(x0 + 12, y0 + 14, g.label, 'd-small d-glabel');
    });

  const clip = (n, tx, ty) => {
    const dx = tx - n.cx, dy = ty - n.cy;
    if (!dx && !dy) return [n.cx, n.cy];
    const t = Math.min(Math.abs((n.w / 2 + 3) / (dx || 1e-9)), Math.abs((n.h / 2 + 3) / (dy || 1e-9)));
    return [n.cx + dx * t, n.cy + dy * t];
  };
  let esvg = '';
  let lsvg = '';
  (spec.edges || []).forEach((e) => {
    const a = nodes[e.from], b = nodes[e.to];
    if (!a || !b) throw new Error(`graph edge ${e.from}->${e.to}`);
    const style = e.style || 'ink';
    const cls = `d-edge d-edge-${style}`;
    const mk = markerFor(style);
    let d, lx, ly;
    if (e.curve) {
      const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
      const dx = b.cx - a.cx, dy = b.cy - a.cy, L = Math.hypot(dx, dy) || 1;
      const cx = mx - (dy / L) * e.curve, cy = my + (dx / L) * e.curve;
      const [sx, sy] = clip(a, cx, cy), [ex, ey] = clip(b, cx, cy);
      d = `M${r1(sx)} ${r1(sy)} Q ${r1(cx)} ${r1(cy)} ${r1(ex)} ${r1(ey)}`;
      lx = (sx + 2 * cx + ex) / 4; ly = (sy + 2 * cy + ey) / 4;
    } else if (e.elbow) {
      // 縦→横→縦 の直交線
      const [sx, sy] = [a.cx, a.cy + (b.cy > a.cy ? a.h / 2 : -a.h / 2)];
      const [ex, ey] = [b.cx, b.cy - (b.cy > a.cy ? b.h / 2 + 3 : -b.h / 2 - 3)];
      const my = (sy + ey) / 2;
      d = `M${r1(sx)} ${r1(sy)} L ${r1(sx)} ${r1(my - 8 * Math.sign(ey - sy))} Q ${r1(sx)} ${r1(my)} ${r1(sx + 8 * Math.sign(ex - sx))} ${r1(my)} L ${r1(ex - 8 * Math.sign(ex - sx))} ${r1(my)} Q ${r1(ex)} ${r1(my)} ${r1(ex)} ${r1(my + 8 * Math.sign(ey - sy))} L ${r1(ex)} ${r1(ey)}`;
      if (sx === ex) d = `M${r1(sx)} ${r1(sy)} L ${r1(ex)} ${r1(ey)}`;
      lx = (sx + ex) / 2; ly = my;
    } else {
      const [sx, sy] = clip(a, b.cx, b.cy), [ex, ey] = clip(b, a.cx, a.cy);
      d = `M${r1(sx)} ${r1(sy)} L ${r1(ex)} ${r1(ey)}`;
      lx = (sx + ex) / 2; ly = (sy + ey) / 2;
    }
    esvg += `<path d="${d}" class="${cls}" marker-end="url(#${pid}-${mk})"${e.both ? ` marker-start="url(#${pid}-${mk})"` : ''}/>`;
    if (e.label) {
      const lw = tw(e.label, 11, /^[\x00-\x7f]+$/.test(e.label)) + 12;
      lx += e.ldx || 0; ly += e.ldy || 0;
      lsvg += `<rect x="${r1(lx - lw / 2)}" y="${r1(ly - 10)}" width="${r1(lw)}" height="20" rx="5" class="d-elabel-bg"/>`;
      lsvg += text(lx, ly, e.label, `d-small ${/^[\x00-\x7f]+$/.test(e.label) ? MONO : ''} d-elabel ${style === 'accent' || style === 'bad' ? 'd-accent-t' : ''}`, 'middle');
    }
  });
  let nsvg = '';
  all.forEach((n) => {
    const k = n.kind || 'plain';
    const x = n.cx - n.w / 2, y = n.cy - n.h / 2;
    nsvg += `<g class="d-node d-node-${k}">`;
    nsvg += `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(n.w)}" height="${r1(n.h)}" rx="${n.round ? n.h / 2 : 9}" class="d-nrect"/>`;
    const total = n.lines.length * 18 + (n.sub ? 16 : 0);
    let ty = n.cy - total / 2 + 9;
    n.lines.forEach((l) => {
      const mono = n.mono !== false && /^[\x00-\x7f]+$/.test(l);
      nsvg += text(n.cx, ty, l, `${mono ? MONO : ''} d-nlabel`, 'middle');
      ty += 18;
    });
    if (n.sub) nsvg += text(n.cx, ty + 1, n.sub, 'd-small d-nsub', 'middle');
    nsvg += '</g>';
  });
  const W = maxX - minX + PAD * 2, H = maxY - minY + PAD * 2;
  const tx = PAD - minX, ty = PAD - minY;
  return {
    svg: svgWrap(pid, W, H, `<g transform="translate(${r1(tx)} ${r1(ty)})">${gsvg}${esvg}${nsvg}${lsvg}</g>`, spec.label),
    w: W,
  };
}

// ------------------------------------------------------------------ tree
// spec: { root:{label, kind, note, children:[...]}, title }
function treeSvg(spec, pid) {
  const ROWH = 32, IND = 26, PAD = 20;
  const rows = [];
  const walk = (n, depth, parentRow, last) => {
    const i = rows.length;
    rows.push({ n, depth, parentRow, last });
    (n.children || []).forEach((c, k) => walk(c, depth + 1, i, k === n.children.length - 1));
  };
  walk(spec.root, 0, -1, true);
  const KIND_W = 56;
  let maxW = 0;
  rows.forEach((r) => {
    const x = PAD + r.depth * IND + 14;
    const kw = r.n.kind ? KIND_W : 0;
    const lw = tw(r.n.label, FS, true);
    r.x = x; r.lx = x + kw;
    r.end = r.lx + lw;
    maxW = Math.max(maxW, r.end);
  });
  const noteX = maxW + 28;
  let body = '';
  rows.forEach((r, i) => {
    const y = PAD + i * ROWH + ROWH / 2;
    r.y = y;
    if (r.parentRow >= 0) {
      const p = rows[r.parentRow];
      const px = p.x + 4;
      body += `<path d="M${px} ${p.y + 9} L ${px} ${y - 6} Q ${px} ${y} ${px + 6} ${y} L ${r.x - 4} ${y}" class="d-tline"/>`;
    }
    const k = r.n.kind;
    const hl = r.n.hl ? ' is-hl' : '';
    const pv = r.n.priv ? ' is-priv' : '';
    if (k) {
      const kwid = tw(k, 11, true) + 12;
      body += `<rect x="${r.x}" y="${y - 10}" width="${kwid}" height="20" rx="5" class="d-kind d-kind-${k.replace(/\s.*/, '')}${pv}"/>`;
      body += text(r.x + kwid / 2, y, k, `${MONO} d-tiny d-kindt`, 'middle');
      r.lx = r.x + Math.max(kwid + 8, KIND_W);
    } else {
      body += `<circle cx="${r.x + 4}" cy="${y}" r="3.5" class="d-tdot"/>`;
      r.lx = r.x + 14;
    }
    body += `<g class="d-trow${hl}${pv}">${text(r.lx, y, r.n.label, `${MONO} d-val`)}</g>`;
    if (r.n.note) body += text(noteX, y, r.n.note, 'd-small d-muted');
  });
  let maxNote = 0;
  rows.forEach((r) => { if (r.n.note) maxNote = Math.max(maxNote, tw(r.n.note, 11) + 10); });
  const maxL = Math.max(...rows.map((r) => r.lx + tw(r.n.label, FS, true)));
  const W = Math.max(maxL, maxNote ? noteX + maxNote : 0) + PAD;
  const H = PAD * 2 + rows.length * ROWH - 8;
  return { svg: svgWrap(pid, W, H, body, spec.label), w: W };
}

// ------------------------------------------------------------------ life (ライフタイム)
// spec: { code:[lines], spans:[{label, from, to, style}], marks:[{line, text, style}] }
function lifeSvg(spec, pid) {
  const LH = 24, PAD = 20, FSZ = 13;
  const codeW = Math.max(...spec.code.map((l) => tw(l, FSZ, true))) + 24;
  const n = spec.code.length;
  let body = `<rect x="${PAD - 8}" y="${PAD - 6}" width="${codeW + 8}" height="${n * LH + 12}" rx="8" class="d-codebg"/>`;
  spec.code.forEach((l, i) => {
    body += `<text x="${PAD + 4}" y="${PAD + i * LH + LH / 2}" class="${MONO} d-code" dominant-baseline="central" xml:space="preserve">${esc(l)}</text>`;
  });
  const sx0 = PAD + codeW + 24;
  let maxX = sx0;
  let curX = sx0;
  (spec.spans || []).forEach((s, k) => {
    const x = curX;
    curX += tw(s.label, 12, true) + 32;
    const y0 = PAD + s.from * LH + 4, y1 = PAD + (s.to + 1) * LH - 4;
    const st = s.style || 'a';
    body += `<g class="d-span d-span-${st}"><path d="M${x + 8} ${y0} L ${x} ${y0} L ${x} ${y1} L ${x + 8} ${y1}" class="d-spanline"/>`;
    body += `<rect x="${x + 6}" y="${(y0 + y1) / 2 - 11}" width="${tw(s.label, 12, true) + 12}" height="22" rx="6" class="d-spanlab"/>`;
    body += text(x + 12, (y0 + y1) / 2, s.label, `${MONO} d-small d-spant`);
    body += '</g>';
    maxX = Math.max(maxX, x + tw(s.label, 12, true) + 24);
  });
  (spec.marks || []).forEach((m) => {
    const x = maxX + 16, y = PAD + m.line * LH + LH / 2;
    body += text(x, y, m.text, `d-small ${m.style === 'bad' ? 'd-accent-t' : 'd-muted'}`);
    maxX = Math.max(maxX, x + tw(m.text, 11.5));
  });
  const W = maxX + PAD + 8, H = PAD * 2 + n * LH;
  return { svg: svgWrap(pid, W, H, body, spec.label), w: W };
}

// ------------------------------------------------------------------ seq
// spec: { actors:[{id,label,kind}], msgs:[{from,to,label,style}|{note, at, span?}|{self, label}|{gap}] }
function seqSvg(spec, pid) {
  const PAD = 24, COLW = spec.colw || 170, STEP = 40, HEADH = 40;
  const idx = {};
  spec.actors.forEach((a, i) => (idx[a.id] = i));
  const ax = (i) => PAD + 70 + i * COLW;
  let y = PAD + HEADH + 24;
  let body = '';
  const lifeTop = PAD + HEADH;
  const steps = [];
  spec.msgs.forEach((s) => {
    if (s.gap) { y += s.gap; return; }
    steps.push({ ...s, y });
    y += s.note ? 34 : s.self ? 46 : STEP;
  });
  const bottom = y + 4;
  let maxX = ax(spec.actors.length - 1) + 70;
  spec.actors.forEach((a, i) => {
    const x = ax(i);
    const w = Math.max(tw(a.label, FS, /^[\x00-\x7f]+$/.test(a.label)) + 28, 100);
    body += `<line x1="${x}" y1="${lifeTop}" x2="${x}" y2="${bottom}" class="d-lifeline"/>`;
    body += `<g class="d-node d-node-${a.kind || 'plain'}"><rect x="${x - w / 2}" y="${PAD}" width="${w}" height="${HEADH}" rx="9" class="d-nrect"/>`;
    body += text(x, PAD + HEADH / 2, a.label, `${/^[\x00-\x7f]+$/.test(a.label) ? MONO : ''} d-nlabel`, 'middle') + '</g>';
    if (a.end) body += `<line x1="${x - 8}" y1="${bottom}" x2="${x + 8}" y2="${bottom}" class="d-edge d-edge-ink"/>`;
  });
  steps.forEach((s) => {
    if (s.note !== undefined) {
      const ids = (Array.isArray(s.at) ? s.at : [s.at]).map((a) => idx[a]);
      const x0 = ax(Math.min(...ids)) - (ids.length > 1 ? 50 : 0), x1 = ax(Math.max(...ids)) + (ids.length > 1 ? 50 : 0);
      const w = Math.max(tw(s.note, 11.5) + 20, x1 - x0);
      const cx = (x0 + x1) / 2;
      body += `<rect x="${cx - w / 2}" y="${s.y - 12}" width="${w}" height="24" rx="6" class="d-snote ${s.style === 'accent' ? 'is-accent' : ''}"/>`;
      body += text(cx, s.y, s.note, 'd-small d-sn', 'middle');
      maxX = Math.max(maxX, cx + w / 2);
      return;
    }
    const style = s.style || 'ink';
    if (s.self) {
      const x = ax(idx[s.self]);
      body += `<path d="M${x} ${s.y - 8} C ${x + 44} ${s.y - 8}, ${x + 44} ${s.y + 16}, ${x + 3} ${s.y + 16}" class="d-edge d-edge-${style}" marker-end="url(#${pid}-${markerFor(style)})"/>`;
      body += text(x + 48, s.y + 4, s.label, 'd-small d-elabel');
      maxX = Math.max(maxX, x + 52 + tw(s.label, 11.5));
      return;
    }
    const x0 = ax(idx[s.from]), x1 = ax(idx[s.to]);
    const dir = Math.sign(x1 - x0);
    body += `<path d="M${x0 + dir * 3} ${s.y + 6} L ${x1 - dir * 4} ${s.y + 6}" class="d-edge d-edge-${style}" marker-end="url(#${pid}-${markerFor(style)})"/>`;
    const lab = s.label || '';
    const mono = /^[\x00-\x7f]+$/.test(lab);
    body += text((x0 + x1) / 2, s.y - 6, lab, `d-small ${mono ? MONO : ''} d-elabel ${style === 'accent' ? 'd-accent-t' : ''}`, 'middle');
  });
  const W = maxX + PAD, H = bottom + PAD;
  return { svg: svgWrap(pid, W, H, body, spec.label), w: W };
}

// ------------------------------------------------------------------ bars
// spec: { items:[{label, value, hl}], unit, max }
function barsSvg(spec, pid) {
  const PAD = 20, ROWH = 34, LABW = Math.max(...spec.items.map((i) => tw(i.label, 12.5, /^[\x00-\x7f]+$/.test(i.label)))) + 16;
  const BW = spec.barW || 360;
  const max = spec.max || Math.max(...spec.items.map((i) => i.value));
  let body = '';
  spec.items.forEach((it, i) => {
    const y = PAD + i * ROWH;
    const w = (it.value / max) * BW;
    body += text(PAD + LABW - 10, y + ROWH / 2, it.label, `${/^[\x00-\x7f]+$/.test(it.label) ? MONO : ''} d-val`, 'end');
    body += `<rect x="${PAD + LABW}" y="${y + 8}" width="${BW}" height="${ROWH - 16}" rx="4" class="d-bartrack"/>`;
    body += `<rect x="${PAD + LABW}" y="${y + 8}" width="${r1(Math.max(w, 2))}" height="${ROWH - 16}" rx="4" class="d-bar ${it.hl ? 'is-hl' : ''}"/>`;
    body += text(PAD + LABW + BW + 10, y + ROWH / 2, `${it.text || it.value}${spec.unit || ''}`, `${MONO} d-small d-muted`);
  });
  const W = PAD * 2 + LABW + BW + 110, H = PAD * 2 + spec.items.length * ROWH;
  return { svg: svgWrap(pid, W, H, body, spec.label), w: W };
}

// ------------------------------------------------------------------ layout（バイト列・メモリレイアウト）
// spec: { rows:[{label, cells:[{t, w, kind}], note}] , unit }
function layoutSvg(spec, pid) {
  const PAD = 20, ROWH = 34, GAPY = 18;
  const LABW = Math.max(...spec.rows.map((r) => tw(r.label, 12.5, /^[\x00-\x7f]+$/.test(r.label)))) + 18;
  const U = spec.unit || 26;
  let body = '';
  let maxX = 0;
  spec.rows.forEach((r, i) => {
    const y = PAD + i * (ROWH + GAPY + (r.scale ? 14 : 0));
    body += text(PAD + LABW - 12, y + ROWH / 2, r.label, `${/^[\x00-\x7f]+$/.test(r.label) ? MONO : ''} d-val`, 'end');
    let x = PAD + LABW;
    r.cells.forEach((c) => {
      const w = (c.w || 1) * U;
      body += `<rect x="${x}" y="${y}" width="${w - 3}" height="${ROWH}" rx="5" class="d-cell d-cell-${c.kind || 'plain'}"/>`;
      if (c.t) body += text(x + (w - 3) / 2, y + ROWH / 2, c.t, `${MONO} d-small d-val`, 'middle');
      x += w;
    });
    if (r.scale) {
      let sx = PAD + LABW;
      r.scale.forEach((s) => {
        body += text(sx + 1, y + ROWH + 10, s, 'd-tiny d-muted');
        sx += U * (r.scaleStep || 1);
      });
    }
    if (r.note) body += text(x + 8, y + ROWH / 2, r.note, 'd-small d-muted');
    maxX = Math.max(maxX, x + (r.note ? tw(r.note, 11.5) + 12 : 0));
  });
  const H = PAD * 2 + spec.rows.reduce((a, r) => a + ROWH + GAPY + (r.scale ? 14 : 0), 0) - GAPY;
  return { svg: svgWrap(pid, maxX + PAD, H, body, spec.label), w: maxX + PAD };
}

// ------------------------------------------------------------------ timeline（年表）
// spec: { items:[{at, label, sub, hl, kind}], axisLabel }
function timelineSvg(spec, pid) {
  const PAD = 20, ROWH = spec.rowH || 46;
  const atW = Math.max(...spec.items.map((it) => tw(it.at, 12.5, true))) + 8;
  const LX = PAD + atW + 18; // 縦線の x
  let body = `<line x1="${LX}" y1="${PAD + 8}" x2="${LX}" y2="${PAD + spec.items.length * ROWH - 14}" class="d-tl-axis"/>`;
  let maxX = 0;
  spec.items.forEach((it, i) => {
    const y = PAD + i * ROWH + ROWH / 2 - 6;
    const k = it.hl ? 'accent' : it.kind || 'plain';
    body += text(PAD + atW, y, it.at, `${MONO} d-small d-tl-at${it.hl ? ' d-accent-t' : ''}`, 'end');
    body += `<circle cx="${LX}" cy="${y}" r="${it.hl ? 6 : 4.5}" class="d-tl-dot d-tl-${k}"/>`;
    body += text(LX + 18, y - (it.sub ? 7 : 0), it.label, `d-tl-label${it.hl ? ' d-accent-t' : ''}`);
    if (it.sub) body += text(LX + 18, y + 11, it.sub, 'd-small d-muted');
    maxX = Math.max(maxX, LX + 18 + Math.max(tw(it.label, 13.5), it.sub ? tw(it.sub, 11.5) : 0));
  });
  const W = maxX + PAD, H = PAD * 2 + spec.items.length * ROWH - 18;
  return { svg: svgWrap(pid, W, H, body, spec.label), w: W };
}

// ------------------------------------------------------------------ circuit（論理回路図）
// 座標はマス目（1 マス = unit px、既定 20）。小数も使える。自動配置はしない。
// spec: {
//   parts: [
//     { id, type:'in',  x, y, label }                 入力端子。(x, y) が線の出る点。ラベルは左（labelPos:'top'|'bottom'|'left'|'right' で変更）
//     { id, type:'out', x, y, label }                 出力端子。(x, y) が線の入る点。ラベルは右
//     { id, type:'and'|'or'|'xor'|'nand'|'nor'|'xnor'|'not'|'buf', x, y, inputs, label }
//         ゲート。(x, y) は左端の中央。入力は .a .b（2 入力なら (x, y-0.5) と (x, y+0.5)。3 入力以上は 0.5 マス間隔で .a .b .c …）、
//         not / buf の入力は .a = (x, y)。出力は .y = (x+3, y)。label は記号の中に小さく書く文字（'AND' など）
//     { id, type:'dff', x, y, label, nq:true, en:true }
//         D フリップフロップ。(x, y) は左端の中央。.d = (x, y-1)、.clk = (x, y+1)、.q = (x+4, y-1)、
//         nq:true なら .nq = (x+4, y+1)、en:true なら .en = (x, y)
//     { id, type:'mux', x, y, inputs:2, labels:['0','1'], sel:'bottom'|'top' }
//         マルチプレクサ（台形）。入力は 1 マス間隔で .in0 .in1 …（.a .b … でも可。2 入力なら (x, y-0.5) と (x, y+0.5)）、
//         出力 .y = (x+3, y)、選択 .s = (x+1.5, y ± ((inputs-1)/2 + 1))（下か上から縦に入る）
//     { id, type:'box', x, y, w:3, h, label, ins:['a','b'], outs:['s','c'], tops:[], bottoms:[] }
//         四角い部品（加算器、ALU、レジスタなど）。(x, y) は左端の中央。入力 .名前 は左に 1 マス間隔（(x, y + …)）、
//         出力は右（x + w + 1）、tops / bottoms は上下の辺（縦に入る）。label の \n で改行
//     { id, type:'dot', x, y }                        分岐点の黒丸（線の中継点としても使える）
//     { type:'text', x, y, text, anchor:'start'|'middle'|'end', muted:true }   自由な文字
//   ],
//   wires: [ 'a -> g1.a',                             文字列なら「元 -> 先」
//            { from:'a', to:'g2.a', mid:2, via:[[x,y],…], hl:true, dashed:true, bus:4, label:'…', straight:true, dot:true } ],
//         線は直角に曲がる。経由点がなければ「横 → 縦 → 横」で、縦線の位置が mid（省略時は中間）。
//         via を書くと、その点を順に通る（各区間は「横 → 縦」、最後の区間は「縦 → 横」）。straight:true なら点を直線で結ぶ（斜め線）。
//         from / to は 'id'（端子・出力が 1 つの部品）、'id.ポート名'、または [x, y]。dot:true で始点に黒丸。
//         同じ元から出る線が分かれる点には、自動で黒丸が付く。黒丸のない交差は「つながっていない」。
//         bus:4 は太線 + 斜線とビット数。
//   hl: ['a', 'g1'],                                  強調する部品の id（その部品と、そこから出る線が強調色になる）。線は 'a->g1.a' でも指定できる
//   vals: { a: 1, s: 0 },                             端子のラベルに値を添える（a = 1）
//   unit: 20,
// }
// 別の元から出た線が重なる・線が部品の中を通る、という書き間違いはエラーにする（mid や via でずらす）。
function circuitSvg(spec, pid) {
  const U = spec.unit || 20, PAD = 18;
  const hlSet = new Set(spec.hl || []);
  const vals = spec.vals || {};
  const P = {};
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const ext = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  const line = (x1, y1, x2, y2, cls = 'd-wire') => `<path d="M${r1(x1)} ${r1(y1)} L${r1(x2)} ${r1(y2)}" class="${cls}"/>`;
  const GATES = { and: ['and', 0], nand: ['and', 1], or: ['or', 0], nor: ['or', 1], xor: ['xor', 0], xnor: ['xor', 1], buf: ['buf', 0], not: ['buf', 1] };
  const LET = 'abcdefgh';
  let partSvg = '';
  const bodies = []; // 線が通ってはいけない四角

  (spec.parts || []).forEach((p, pi) => {
    const X = p.x * U, Y = p.y * U;
    const hl = p.hl || hlSet.has(p.id);
    const ports = {};
    let g = '', defIn = null, defOut = null;
    const type = p.type || 'box';
    if (type === 'in' || type === 'out') {
      const pos = p.labelPos || (type === 'in' ? 'left' : 'right');
      const lab = (p.label ?? p.id ?? '') + (vals[p.id] !== undefined ? ` = ${vals[p.id]}` : '');
      g += `<circle cx="${r1(X)}" cy="${r1(Y)}" r="3.2" class="d-term"/>`;
      const lw = tw(lab, FS, true);
      if (lab) {
        if (pos === 'left') { g += text(X - 9, Y, lab, `${MONO} d-tlabel`, 'end'); ext(X - 9 - lw, Y - 9); }
        else if (pos === 'right') { g += text(X + 9, Y, lab, `${MONO} d-tlabel`); ext(X + 9 + lw, Y + 9); }
        else if (pos === 'top') { g += text(X, Y - 14, lab, `${MONO} d-tlabel`, 'middle'); ext(X - lw / 2, Y - 22); ext(X + lw / 2, Y); }
        else { g += text(X, Y + 14, lab, `${MONO} d-tlabel`, 'middle'); ext(X - lw / 2, Y); ext(X + lw / 2, Y + 22); }
      }
      ext(X - 4, Y - 4); ext(X + 4, Y + 4);
      ports._ = { x: X, y: Y, dir: pos === 'top' || pos === 'bottom' ? 'v' : 'h' };
      defIn = defOut = '_';
    } else if (GATES[type]) {
      const [shape, neg] = GATES[type];
      const n = shape === 'buf' ? 1 : p.inputs || 2;
      const hh = shape === 'buf' ? 0.7 * U : Math.max(1, (n - 1) * 0.25 + 0.5) * U;
      const xl = X + 0.5 * U, w = shape === 'buf' ? 1.4 * U : 2 * U, xr = xl + w;
      const c = 0.6 * U; // OR の背中のふくらみ
      const backX = (dy) => { const t = (dy + hh) / (2 * hh); return xl + 2 * t * (1 - t) * c; };
      const offs = Array.from({ length: n }, (_, i) => (n === 2 ? (i ? 0.5 : -0.5) : (i - (n - 1) / 2) * 0.5) * U);
      offs.forEach((dy, i) => {
        const ex = shape === 'or' || shape === 'xor' ? backX(dy) : xl;
        g += line(X, Y + dy, ex, Y + dy, 'd-wire d-stub');
        ports[LET[i]] = ports['in' + i] = { x: X, y: Y + dy, dir: 'h' };
      });
      const orPath = (x0) => `M${r1(x0)} ${r1(Y - hh)} C${r1(x0 + (xr - x0) * 0.5)} ${r1(Y - hh)} ${r1(x0 + (xr - x0) * 0.84)} ${r1(Y - hh * 0.52)} ${r1(xr)} ${r1(Y)} C${r1(x0 + (xr - x0) * 0.84)} ${r1(Y + hh * 0.52)} ${r1(x0 + (xr - x0) * 0.5)} ${r1(Y + hh)} ${r1(x0)} ${r1(Y + hh)} Q${r1(x0 + c)} ${r1(Y)} ${r1(x0)} ${r1(Y - hh)} Z`;
      if (shape === 'and') g += `<path d="M${r1(xl)} ${r1(Y - hh)} H${r1(xr - hh)} A${r1(hh)} ${r1(hh)} 0 0 1 ${r1(xr - hh)} ${r1(Y + hh)} H${r1(xl)} Z" class="d-gate"/>`;
      else if (shape === 'or') g += `<path d="${orPath(xl)}" class="d-gate"/>`;
      else if (shape === 'xor') {
        g += `<path d="${orPath(xl + 0.28 * U)}" class="d-gate"/>`;
        g += `<path d="M${r1(xl)} ${r1(Y - hh)} Q${r1(xl + c)} ${r1(Y)} ${r1(xl)} ${r1(Y + hh)}" class="d-gate d-gate-open"/>`;
      } else g += `<path d="M${r1(xl)} ${r1(Y - hh)} L${r1(xr)} ${r1(Y)} L${r1(xl)} ${r1(Y + hh)} Z" class="d-gate"/>`;
      const br = 0.2 * U;
      if (neg) g += `<circle cx="${r1(xr + br)}" cy="${r1(Y)}" r="${r1(br)}" class="d-gate"/>`;
      g += line(xr + (neg ? 2 * br : 0), Y, X + 3 * U, Y, 'd-wire d-stub d-stub-out');
      if (p.label) g += text(shape === 'buf' ? xl + w * 0.36 : xl + w * (shape === 'and' ? 0.46 : 0.5), Y, p.label, 'd-tiny d-gname', 'middle');
      ports.y = { x: X + 3 * U, y: Y, dir: 'h' };
      defOut = 'y'; if (n === 1) defIn = 'a';
      ext(X, Y - hh - 1); ext(X + 3 * U, Y + hh + 1);
      bodies.push({ x0: xl, y0: Y - hh, x1: xr, y1: Y + hh, id: p.id || `#${pi}` });
    } else if (type === 'dff') {
      const xl = X + 0.5 * U, xr = X + 3.5 * U, y0 = Y - 1.6 * U, y1 = Y + 1.6 * U;
      g += `<rect x="${r1(xl)}" y="${r1(y0)}" width="${r1(xr - xl)}" height="${r1(y1 - y0)}" rx="3" class="d-gate"/>`;
      const stub = (name, px, py, lab, right) => {
        g += line(px, py, right ? xr : xl, py, `d-wire d-stub${right ? ' d-stub-out' : ''}`);
        ports[name] = { x: px, y: py, dir: 'h' };
        if (lab) g += text(right ? xr - 7 : xl + 7, py, lab, `${MONO} d-small d-plabel`, right ? 'end' : 'start');
      };
      stub('d', X, Y - U, 'D');
      stub('clk', X, Y + U, '');
      g += `<path d="M${r1(xl)} ${r1(Y + U - 5.5)} L${r1(xl + 8)} ${r1(Y + U)} L${r1(xl)} ${r1(Y + U + 5.5)}" class="d-gate d-gate-open"/>`;
      stub('q', X + 4 * U, Y - U, 'Q', true);
      if (p.nq) {
        stub('nq', X + 4 * U, Y + U, 'Q', true);
        g += line(xr - 7 - tw('Q', 11.5, true), Y + U - 8, xr - 7, Y + U - 8, 'd-wire d-overline');
      }
      if (p.en) stub('en', X, Y, 'EN');
      if (p.label) g += text((xl + xr) / 2 + (p.en ? 8 : 0), p.en || !p.nq ? Y + (p.en ? 0 : 0.2 * U) : Y, p.label, `${MONO} d-small d-gname`, 'middle');
      defOut = 'q'; defIn = 'd';
      ext(X, y0 - 1); ext(X + 4 * U, y1 + 1);
      bodies.push({ x0: xl, y0, x1: xr, y1, id: p.id || `#${pi}` });
    } else if (type === 'mux') {
      const n = p.inputs || 2;
      const lh = ((n - 1) / 2 + 0.7) * U, rh = lh - 0.5 * U;
      const xl = X + 0.5 * U, xr = X + 2 * U;
      g += `<path d="M${r1(xl)} ${r1(Y - lh)} L${r1(xr)} ${r1(Y - rh)} L${r1(xr)} ${r1(Y + rh)} L${r1(xl)} ${r1(Y + lh)} Z" class="d-gate"/>`;
      const labels = p.labels || Array.from({ length: n }, (_, i) => String(i));
      for (let i = 0; i < n; i++) {
        const dy = (i - (n - 1) / 2) * U;
        g += line(X, Y + dy, xl, Y + dy, 'd-wire d-stub');
        ports['in' + i] = ports[LET[i]] = { x: X, y: Y + dy, dir: 'h' };
        if (labels[i] !== '') g += text(xl + 5, Y + dy, labels[i], `${MONO} d-tiny d-plabel`);
      }
      g += line(xr, Y, X + 3 * U, Y, 'd-wire d-stub d-stub-out');
      ports.y = { x: X + 3 * U, y: Y, dir: 'h' };
      const sgn = p.sel === 'top' ? -1 : 1;
      const sx = X + 1.5 * U, sy = Y + sgn * ((n - 1) / 2 + 1) * U;
      const edgeY = Y + sgn * (lh - (0.5 * U * (sx - xl)) / (xr - xl));
      g += line(sx, sy, sx, edgeY, 'd-wire d-stub');
      ports.s = { x: sx, y: sy, dir: 'v' };
      if (p.label) g += text((xl + xr) / 2 + 3, Y - sgn * 0, p.label, 'd-tiny d-gname', 'middle');
      defOut = 'y';
      ext(X, Math.min(Y - lh, sy) - 1); ext(X + 3 * U, Math.max(Y + lh, sy) + 1);
      bodies.push({ x0: xl, y0: Y - rh, x1: xr, y1: Y + rh, id: p.id || `#${pi}` });
    } else if (type === 'box') {
      const ins = p.ins || [], outs = p.outs || [], tops = p.tops || [], bottoms = p.bottoms || [];
      const w = (p.w || 3) * U;
      const h = (p.h || Math.max(ins.length, outs.length, 1) + 1) * U;
      const xl = X + 0.5 * U, xr = xl + w, y0 = Y - h / 2, y1 = Y + h / 2;
      g += `<rect x="${r1(xl)}" y="${r1(y0)}" width="${r1(w)}" height="${r1(h)}" rx="4" class="d-gate"/>`;
      ins.forEach((nm, i) => {
        const py = Y + (i - (ins.length - 1) / 2) * U;
        g += line(X, py, xl, py, 'd-wire d-stub');
        ports[nm] = ports['in' + i] = { x: X, y: py, dir: 'h' };
        if (nm && !/^_/.test(nm)) g += text(xl + 6, py, nm, `${MONO} d-tiny d-plabel`);
      });
      outs.forEach((nm, i) => {
        const py = Y + (i - (outs.length - 1) / 2) * U;
        g += line(xr, py, xr + 0.5 * U, py, 'd-wire d-stub d-stub-out');
        ports[nm] = ports['out' + i] = { x: xr + 0.5 * U, y: py, dir: 'h' };
        if (nm && !/^_/.test(nm)) g += text(xr - 6, py, nm, `${MONO} d-tiny d-plabel`, 'end');
      });
      const vert = (list, top) => list.forEach((nm, i) => {
        const px = xl + ((i + 1) * w) / (list.length + 1);
        const py = top ? y0 - 0.5 * U : y1 + 0.5 * U;
        g += line(px, py, px, top ? y0 : y1, 'd-wire d-stub');
        ports[nm] = { x: px, y: py, dir: 'v' };
        if (nm && !/^_/.test(nm)) g += text(px, top ? y0 + 9 : y1 - 9, nm, `${MONO} d-tiny d-plabel`, 'middle');
      });
      vert(tops, true); vert(bottoms, false);
      if (p.label) {
        const ls = String(p.label).split('\n');
        ls.forEach((l, i) => { g += text((xl + xr) / 2, Y + (i - (ls.length - 1) / 2) * 16, l, `${/^[\x00-\x7f]+$/.test(l) ? MONO : ''} d-small d-gname`, 'middle'); });
      }
      if (outs.length === 1) defOut = outs[0];
      if (ins.length === 1) defIn = ins[0];
      ext(X, y0 - (tops.length ? 0.5 * U : 1)); ext(xr + (outs.length ? 0.5 * U : 1), y1 + (bottoms.length ? 0.5 * U : 1));
      bodies.push({ x0: xl, y0, x1: xr, y1, id: p.id || `#${pi}` });
    } else if (type === 'dot') {
      g += `<circle cx="${r1(X)}" cy="${r1(Y)}" r="3" class="d-jdot"/>`;
      ports._ = { x: X, y: Y, dir: null };
      defIn = defOut = '_';
      ext(X - 3, Y - 3); ext(X + 3, Y + 3);
    } else if (type === 'text') {
      const lw = tw(p.text, 11.5, /^[\x00-\x7f]+$/.test(p.text));
      const a = p.anchor || 'start';
      g += text(X, Y, p.text, `d-small ${/^[\x00-\x7f]+$/.test(p.text) ? MONO : ''}${p.muted ? ' d-muted' : ''}`, a);
      const x0 = a === 'start' ? X : a === 'middle' ? X - lw / 2 : X - lw;
      ext(x0, Y - 9); ext(x0 + lw, Y + 9);
    } else throw new Error(`circuit: 部品の type "${type}" はありません`);
    if (p.note) {
      const b = bodies[bodies.length - 1];
      const ny = (b && b.id === (p.id || `#${pi}`) ? Math.max(b.y1, Y + U) : Y) + 13;
      g += text(b ? (b.x0 + b.x1) / 2 : X, ny, p.note, 'd-small d-muted', 'middle');
      const lw = tw(p.note, 11.5); ext((b ? (b.x0 + b.x1) / 2 : X) - lw / 2, ny); ext((b ? (b.x0 + b.x1) / 2 : X) + lw / 2, ny + 9);
    }
    partSvg += `<g class="d-part d-part-${type}${hl ? ' is-hl' : ''}">${g}</g>`;
    if (p.id) {
      if (P[p.id]) throw new Error(`circuit: 部品の id "${p.id}" が 2 回あります`);
      P[p.id] = { ports, defIn, defOut, type };
    }
  });

  const resolve = (ref, role) => {
    if (Array.isArray(ref)) return { x: ref[0] * U, y: ref[1] * U, dir: null, key: null, id: null };
    const [id, port] = String(ref).split('.');
    const part = P[id];
    if (!part) throw new Error(`circuit: 配線の "${ref}" という部品はありません`);
    const pn = port || (role === 'from' ? part.defOut : part.defIn);
    const pt = pn && part.ports[pn];
    if (!pt) throw new Error(`circuit: "${ref}" の${port ? `ポート "${port}" はありません` : 'どのポートにつなぐかを "id.ポート名" で書いてください'}（${Object.keys(part.ports).filter((k) => k !== '_').join(', ')}）`);
    return { ...pt, key: `${id}.${pn}`, id };
  };
  const wires = (spec.wires || []).map((w0, i) => {
    let w = w0;
    if (typeof w0 === 'string') {
      const m = w0.split('->').map((s) => s.trim());
      if (m.length !== 2) throw new Error(`circuit: 配線 "${w0}" は "元 -> 先" の形で書いてください`);
      w = { from: m[0], to: m[1] };
    }
    const a = resolve(w.from, 'from'), b = resolve(w.to, 'to');
    const name = `${Array.isArray(w.from) ? `[${w.from}]` : w.from}->${Array.isArray(w.to) ? `[${w.to}]` : w.to}`;
    let pts = [[a.x, a.y]];
    const via = (w.via || []).map(([x, y]) => [x * U, y * U]);
    if (w.straight) pts.push(...via, [b.x, b.y]);
    else {
      let cur = pts[0];
      via.forEach((v, k) => {
        if (cur[0] !== v[0] && cur[1] !== v[1]) pts.push(k === 0 && a.dir === 'v' ? [cur[0], v[1]] : [v[0], cur[1]]);
        pts.push(v); cur = v;
      });
      if (cur[0] !== b.x && cur[1] !== b.y) {
        if (w.mid !== undefined) pts.push([w.mid * U, cur[1]], [w.mid * U, b.y]);
        else if (b.dir === 'v') pts.push([b.x, cur[1]]);
        else if (via.length || a.dir === 'v') pts.push([cur[0], b.y]);
        else { const mx = Math.round((cur[0] + b.x) / U) * U / 2; pts.push([mx, cur[1]], [mx, b.y]); }
      }
      pts.push([b.x, b.y]);
      // 同じ点・一直線上の点をまとめる
      const out = [];
      for (const q of pts) {
        const l = out[out.length - 1];
        if (l && l[0] === q[0] && l[1] === q[1]) continue;
        const l2 = out[out.length - 2];
        if (l2 && ((l2[0] === l[0] && l[0] === q[0] && Math.sign(l[1] - l2[1]) === Math.sign(q[1] - l[1])) || (l2[1] === l[1] && l[1] === q[1] && Math.sign(l[0] - l2[0]) === Math.sign(q[0] - l[0])))) out[out.length - 1] = q;
        else out.push(q);
      }
      pts = out;
    }
    const hl = w.hl || hlSet.has(w.id) || hlSet.has(name.replace(/\s/g, '')) || (a.id && hlSet.has(a.id)) || (a.key && hlSet.has(a.key));
    pts.forEach(([x, y]) => ext(x, y));
    return { w, a, b, pts, hl, name, src: a.key || `@${a.x},${a.y}` };
  });

  // 書き間違いの検出：別の元から出た線の重なり、部品の中を通る線
  const segs = [];
  wires.forEach((wr, wi) => {
    if (wr.w.straight) return;
    for (let i = 0; i + 1 < wr.pts.length; i++) {
      const [x0, y0] = wr.pts[i], [x1, y1] = wr.pts[i + 1];
      segs.push({ wi, src: wr.src, name: wr.name, v: x0 === x1, c: x0 === x1 ? x0 : y0, lo: x0 === x1 ? Math.min(y0, y1) : Math.min(x0, x1), hi: x0 === x1 ? Math.max(y0, y1) : Math.max(x0, x1) });
      for (const bd of bodies) {
        const ix0 = Math.max(Math.min(x0, x1), bd.x0 + 2), ix1 = Math.min(Math.max(x0, x1), bd.x1 - 2);
        const iy0 = Math.max(Math.min(y0, y1), bd.y0 + 2), iy1 = Math.min(Math.max(y0, y1), bd.y1 - 2);
        if (ix0 <= ix1 && iy0 <= iy1) throw new Error(`circuit: 配線 ${wr.name} が部品 ${bd.id} の中を通っています。mid か via でよけてください`);
      }
    }
  });
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const s = segs[i], t = segs[j];
    if (s.src === t.src || s.v !== t.v || Math.abs(s.c - t.c) > 0.5) continue;
    if (Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo) > 0.5) throw new Error(`circuit: 配線 ${s.name} と ${t.name} が ${s.v ? 'x' : 'y'}=${r1(s.c / U)} で重なっています。mid か via で位置をずらしてください`);
  }

  // 分岐点の黒丸：同じ元から出た 2 本が分かれる点
  const dots = new Map();
  const addDot = (x, y, hl) => { const k = `${r1(x)},${r1(y)}`; const d = dots.get(k); dots.set(k, { x, y, hl: d ? d.hl && hl : hl }); };
  for (let i = 0; i < wires.length; i++) for (let j = i + 1; j < wires.length; j++) {
    const A = wires[i], B = wires[j];
    if (A.src !== B.src || A.w.straight || B.w.straight) continue;
    let ia = 1, ib = 1, cur = A.pts[0];
    for (;;) {
      const pa = A.pts[ia], pb = B.pts[ib];
      if (!pa || !pb) break; // 片方がもう片方の途中で終わる
      const da = [Math.sign(pa[0] - cur[0]), Math.sign(pa[1] - cur[1])], db = [Math.sign(pb[0] - cur[0]), Math.sign(pb[1] - cur[1])];
      if (da[0] !== db[0] || da[1] !== db[1]) { addDot(cur[0], cur[1], A.hl && B.hl); break; }
      const la = Math.abs(pa[0] - cur[0]) + Math.abs(pa[1] - cur[1]), lb = Math.abs(pb[0] - cur[0]) + Math.abs(pb[1] - cur[1]);
      if (la === lb) { cur = pa; ia++; ib++; continue; }
      if (la < lb) { cur = pa; ia++; } else { cur = pb; ib++; }
      // 短いほうの角で分かれる。長いほうはそのまま直進
      if (la < lb ? A.pts[ia] : B.pts[ib]) addDot(cur[0], cur[1], A.hl && B.hl);
      break;
    }
  }
  let wsvg = '', lsvg = '';
  // 強調した線を上に描く
  [...wires].sort((x, y) => (x.hl ? 1 : 0) - (y.hl ? 1 : 0)).forEach((wr) => {
    const { w, pts } = wr;
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${r1(x)} ${r1(y)}`).join(' ');
    wsvg += `<path d="${d}" class="d-wire${w.bus ? ' is-bus' : ''}${w.dashed ? ' is-dashed' : ''}${wr.hl ? ' is-hl' : ''}"/>`;
    if (w.dot) addDot(pts[0][0], pts[0][1], wr.hl);
    // いちばん長い横線
    let best = null;
    for (let i = 0; i + 1 < pts.length; i++) if (pts[i][1] === pts[i + 1][1] && (!best || Math.abs(pts[i + 1][0] - pts[i][0]) > best.len)) best = { len: Math.abs(pts[i + 1][0] - pts[i][0]), x: (pts[i][0] + pts[i + 1][0]) / 2, y: pts[i][1] };
    if (w.bus) {
      // 斜線とビット数：最初の線の中央（横線なら線の下、縦線なら線の右に数）
      const [p0, p1] = pts;
      const horiz = p0[1] === p1[1];
      const bx = (p0[0] + p1[0]) / 2, by = (p0[1] + p1[1]) / 2;
      wsvg += `<path d="M${r1(bx - 4.5)} ${r1(by + 6)} L${r1(bx + 4.5)} ${r1(by - 6)}" class="d-wire${wr.hl ? ' is-hl' : ''}"/>`;
      if (w.bus !== true) {
        lsvg += horiz ? text(bx + 2, by + 13, w.bus, `${MONO} d-tiny d-muted`, 'middle') : text(bx + 9, by, w.bus, `${MONO} d-tiny d-muted`);
        ext(bx + (horiz ? 8 : 9 + tw(w.bus, 10, true)), by + (horiz ? 19 : 6));
      }
    }
    if (w.label) {
      const at = best || { x: (pts[0][0] + pts[1][0]) / 2, y: (pts[0][1] + pts[1][1]) / 2 };
      const mono = /^[\x00-\x7f]+$/.test(w.label);
      lsvg += text(at.x + (w.ldx || 0), at.y - 9 + (w.ldy || 0), w.label, `d-small ${mono ? MONO : ''} ${wr.hl ? 'd-accent-t' : 'd-wlabel'}`, 'middle');
      const lw = tw(w.label, 11.5, mono);
      ext(at.x - lw / 2 + (w.ldx || 0), at.y - 18 + (w.ldy || 0)); ext(at.x + lw / 2 + (w.ldx || 0), at.y);
    }
  });
  let dsvg = '';
  for (const d of dots.values()) dsvg += `<circle cx="${r1(d.x)}" cy="${r1(d.y)}" r="3" class="d-jdot${d.hl ? ' is-hl' : ''}"/>`;
  if (minX === Infinity) { minX = minY = 0; maxX = maxY = 40; }
  const W = maxX - minX + PAD * 2, H = maxY - minY + PAD * 2;
  return {
    svg: svgWrap(pid, W, H, `<g transform="translate(${r1(PAD - minX)} ${r1(PAD - minY)})">${wsvg}${dsvg}${partSvg}${lsvg}</g>`, spec.label),
    w: W,
  };
}

// ------------------------------------------------------------------ wave（タイミング図）
// spec: {
//   signals: [
//     { name:'clk', clock:true },                     クロック。1 マス = 1 周期で、マスの左端で立ち上がる
//     { name:'d', wave:'0110.x' },                    1 ビット。1 文字 = 1 マス。'.' は前と同じ、'x' / '?' は不定（斜線）
//     { name:'d', values:[0,1,1,0] },                 配列でもよい（null は不定）
//     { name:'q', bus:[0,1,2,'?'] },                  バス。同じ値が続くマスは 1 つの六角形にまとめる（width が 2 以上の values もバス扱い）
//     … どれにも hl:true（強調色）、note:'…'（右に小さな注記）を付けられる
//   ],
//   cycles: 8,            マスの数（省略時はいちばん長い信号）
//   ticks: true,          上に時刻の目盛り（0 始まり。false で消す。tick0: 1 で 1 始まり）
//   spans: [{ from:2, to:4, label:'ここで取り込む' }],   強調する区間（マスの番号。to は含まない。to を省くと 1 マス）
//   marks: [3],           マスの左端に縦の点線（立ち上がりの位置を示す）。{ at:3, label:'↑' } でラベル付き
//   cell: 40,             1 マスの幅（px）
// }
// LOGIC.run の結果の wave（{ name, width, kind, values } の配列）は、そのまま signals に渡せる。
function waveSvg(spec, pid) {
  const PAD = 18, CW = spec.cell || 40, RH = 36, AMP = 18;
  const sigs = (spec.signals || []).map((s) => {
    const clock = s.clock || s.kind === 'clock';
    let vals = null, bus = false;
    if (s.bus) { vals = s.bus.slice(); bus = true; }
    else if (s.values) { vals = s.values.slice(); bus = (s.width || 1) > 1; }
    else if (s.wave !== undefined) {
      vals = [];
      for (const ch of String(s.wave)) vals.push(ch === '.' ? (vals.length ? vals[vals.length - 1] : 0) : ch === 'x' || ch === '?' ? null : ch === '1' ? 1 : 0);
    }
    if (vals) vals = vals.map((v) => (v === '?' || v === 'x' || v === undefined ? null : v));
    return { ...s, clock, vals, bus };
  });
  const N = spec.cycles || Math.max(1, ...sigs.map((s) => (s.vals ? s.vals.length : 0)));
  const nameW = Math.max(...sigs.map((s) => tw(s.name, FS, true))) + 14;
  const ticks = spec.ticks !== false;
  const spans = spec.spans || [];
  const hasSpanLabel = spans.some((s) => s.label);
  const X0 = PAD + nameW, Y0 = PAD + (ticks ? 20 : 0) + (hasSpanLabel ? 20 : 0);
  const bottom = Y0 + sigs.length * RH;
  let body = '';
  let maxX = X0 + N * CW;
  spans.forEach((sp) => {
    const to = sp.to === undefined ? sp.from + 1 : sp.to;
    body += `<rect x="${X0 + sp.from * CW}" y="${Y0 - 4}" width="${(to - sp.from) * CW}" height="${bottom - Y0 + 4}" rx="4" class="d-wave-span"/>`;
    if (sp.label) {
      const lw = tw(sp.label, 11.5);
      const cx = Math.max(X0 + lw / 2, X0 + ((sp.from + to) / 2) * CW);
      body += text(cx, Y0 - 14, sp.label, 'd-small d-accent-t', 'middle');
      maxX = Math.max(maxX, cx + lw / 2);
    }
  });
  for (let i = 0; i <= N; i++) body += `<line x1="${X0 + i * CW}" y1="${Y0 - 2}" x2="${X0 + i * CW}" y2="${bottom - 4}" class="d-wave-grid"/>`;
  if (ticks) for (let i = 0; i < N; i++) body += text(X0 + i * CW + CW / 2, PAD + 6, String(i + (spec.tick0 || 0)), `${MONO} d-tiny d-muted`, 'middle');
  (spec.marks || []).forEach((m) => {
    const at = typeof m === 'number' ? m : m.at;
    body += `<line x1="${X0 + at * CW}" y1="${Y0 - 4}" x2="${X0 + at * CW}" y2="${bottom}" class="d-wave-mark"/>`;
    if (m.label) body += text(X0 + at * CW, bottom + 8, m.label, 'd-small d-accent-t', 'middle');
  });
  const hasMarkLabel = (spec.marks || []).some((m) => m.label);
  sigs.forEach((s, r) => {
    const yc = Y0 + r * RH + RH / 2 - 2;
    const hi = yc - AMP / 2, lo = yc + AMP / 2;
    body += text(X0 - 12, yc, s.name, `${MONO} d-wave-name${s.hl ? ' d-accent-t' : ''}`, 'end');
    const cls = s.hl ? ' is-hl' : '';
    if (s.clock) {
      let d = `M${X0} ${lo}`;
      for (let i = 0; i < N; i++) { const x = X0 + i * CW; d += ` L${x} ${hi} L${x + CW / 2} ${hi} L${x + CW / 2} ${lo} L${x + CW} ${lo}`; }
      body += `<path d="${d}" class="d-wave-line d-wave-clk${cls}"/>`;
    } else if (s.bus) {
      const SL = 4;
      let i = 0;
      while (i < N) {
        const v = i < s.vals.length ? s.vals[i] : null;
        let j = i + 1;
        while (j < N && (j < s.vals.length ? s.vals[j] : null) === v) j++;
        const x0 = X0 + i * CW, x1 = X0 + j * CW;
        const l = i === 0 ? x0 : x0 + SL, rr = j === N ? x1 : x1 - SL;
        const d = `M${i === 0 ? x0 : x0} ${i === 0 ? hi : yc} ${i === 0 ? '' : `L${l} ${hi}`} L${rr} ${hi} ${j === N ? `L${x1} ${lo}` : `L${x1} ${yc} L${rr} ${lo}`} L${l} ${lo} Z`;
        body += `<path d="${d}" class="d-wave-bus${v === null ? ' is-x' : ''}${cls}"/>`;
        if (v === null) body += `<path d="${d}" fill="url(#${pid}-hatch)" class="d-wave-xfill"/>`;
        else if (tw(String(v), 11.5, true) < x1 - x0 - 4) body += text((x0 + x1) / 2, yc, String(v), `${MONO} d-small d-wave-val`, 'middle');
        i = j;
      }
    } else if (s.vals) {
      let d = '', prev;
      for (let i = 0; i < N; i++) {
        const v = i < s.vals.length ? s.vals[i] : null;
        const x = X0 + i * CW;
        if (v === null) {
          body += `<rect x="${x}" y="${hi}" width="${CW}" height="${AMP}" class="d-wave-bus is-x"/><rect x="${x}" y="${hi}" width="${CW}" height="${AMP}" fill="url(#${pid}-hatch)" class="d-wave-xfill"/>`;
          prev = undefined;
          continue;
        }
        const y = v ? hi : lo;
        d += prev === undefined ? ` M${x} ${y}` : ` L${x} ${y}`;
        d += ` L${x + CW} ${y}`;
        prev = v;
      }
      if (d) body += `<path d="${d.trim()}" class="d-wave-line${cls}"/>`;
    }
    if (s.note) { body += text(X0 + N * CW + 10, yc, s.note, 'd-small d-muted'); maxX = Math.max(maxX, X0 + N * CW + 10 + tw(s.note, 11.5)); }
  });
  const W = maxX + PAD, H = bottom + PAD - 6 + (hasMarkLabel ? 14 : 0);
  return { svg: svgWrap(pid, W, H, body, spec.label), w: W };
}

// ------------------------------------------------------------------ pipe（パイプライン図）
// 行 = 命令、列 = サイクル。
// spec: {
//   stages: ['IF','ID','EX','MEM','WB'],              段階名（省略時はこの 5 つ）
//   rows: [
//     { label:'add x3, x1, x2' },                     start（最初のサイクル、0 始まり）を省くと「前の行の IF の次のサイクル」から
//     { label:'sub x5, x3, x4', start:1, wait:{ ID:2 } },   wait：その段階のあとで n サイクル止まる（停止のマスは斜線 + —）
//     { label:'beq …', flush:2 },                     flush：最初の n 段階だけ進んで捨てられる（点線のマス）
//     { label:'…', start:2, cells:['IF','ID','-','EX','MEM','WB'] },   マスを直接書く。'-' は停止、'' は空き、'~IF' は捨てられた段階
//     … どれにも note:'…'（右に小さな注記）、hl:true（ラベルを強調色）
//   ],
//   arrows: [{ from:[0,'EX'], to:[1,'EX'], label:'フォワード', style:'accent'|'bad'|'ink', side:'left' }],
//                                                     [行番号, 段階名（その行で最初のマス）かサイクル番号] どうしを矢印で結ぶ。
//                                                     ラベルは行の間、矢印の右（side:'left' で左）に出る。ldx / ldy で微調整
//   hl: [3],              強調するサイクル（列）。0 始まり
//   cycles: 9,            列の数（省略時は必要なだけ）
//   cycle0: 1,            列の見出しの最初の番号（既定 1）
//   head: 'サイクル',     見出しの左に書く文字
// }
function pipeSvg(spec, pid) {
  const PAD = 18, CW = spec.cell || 50, CH = 30, GAPX = 4, HEAD = 26;
  // 行の間は、矢印が見える広さ。矢印にラベルがあれば、ラベルが入る広さ
  const GAPY = (spec.arrows || []).some((a) => a.label) ? 26 : (spec.arrows || []).length ? 16 : 8;
  const stages = spec.stages || ['IF', 'ID', 'EX', 'MEM', 'WB'];
  let prevStart = -1;
  const rows = (spec.rows || []).map((r) => {
    let cells;
    if (r.cells) cells = r.cells.map((c) => (c === '-' || c === '—' ? { stall: true } : c === '' || c === null ? null : String(c).startsWith('~') ? { name: String(c).slice(1), flush: true } : { name: String(c) }));
    else {
      cells = [];
      const n = r.flush !== undefined ? r.flush : stages.length;
      stages.slice(0, n).forEach((st) => {
        cells.push({ name: st, flush: r.flush !== undefined });
        const wn = (r.wait && r.wait[st]) || 0;
        for (let k = 0; k < wn; k++) cells.push({ stall: true });
      });
    }
    const start = r.start !== undefined ? r.start : prevStart + 1;
    // 次の行は、この行の最初の段階（とその停止）が終わった次のサイクルから
    let first = 1;
    while (first < cells.length && cells[first] && cells[first].stall) first++;
    prevStart = start + first - 1;
    return { ...r, cells, start };
  });
  const N = spec.cycles || Math.max(1, ...rows.map((r) => r.start + r.cells.length));
  const labW = Math.max(spec.head ? tw(spec.head, 11.5) : 0, ...rows.map((r) => tw(r.label || '', FS, true))) + 16;
  const X0 = PAD + labW, Y0 = PAD + HEAD;
  const cx = (c) => X0 + c * (CW + GAPX), ry = (r) => Y0 + r * (CH + GAPY);
  const bottom = ry(rows.length) - GAPY;
  let body = '';
  (spec.hl || []).forEach((c) => {
    body += `<rect x="${cx(c) - GAPX / 2}" y="${PAD - 4}" width="${CW + GAPX}" height="${bottom - PAD + 8}" rx="6" class="d-pipe-col"/>`;
  });
  if (spec.head) body += text(X0 - 12, PAD + HEAD / 2 - 4, spec.head, 'd-small d-muted', 'end');
  for (let c = 0; c < N; c++) body += text(cx(c) + CW / 2, PAD + HEAD / 2 - 4, String(c + (spec.cycle0 ?? 1)), `${MONO} d-small ${(spec.hl || []).includes(c) ? 'd-accent-t' : 'd-muted'}`, 'middle');
  let maxX = cx(N) - GAPX;
  rows.forEach((r, i) => {
    const y = ry(i);
    body += text(X0 - 12, y + CH / 2, r.label || '', `${MONO} d-pipe-label${r.hl ? ' d-accent-t' : ''}`, 'end');
    // 使わないマスの薄い下地
    for (let c = 0; c < N; c++) body += `<rect x="${cx(c)}" y="${y}" width="${CW}" height="${CH}" rx="5" class="d-pipe-bg"/>`;
    r.cells.forEach((cell, k) => {
      if (!cell) return;
      const x = cx(r.start + k);
      if (cell.stall) {
        body += `<rect x="${x}" y="${y}" width="${CW}" height="${CH}" rx="5" class="d-pipe-cell d-pipe-stall"/><rect x="${x}" y="${y}" width="${CW}" height="${CH}" rx="5" fill="url(#${pid}-hatch)" class="d-pipe-hatch"/>`;
        body += text(x + CW / 2, y + CH / 2, '—', 'd-small d-pipe-stallt', 'middle');
        return;
      }
      const si = stages.indexOf(cell.name);
      body += `<rect x="${x}" y="${y}" width="${CW}" height="${CH}" rx="5" class="d-pipe-cell ${cell.flush ? 'd-pipe-flush' : `d-pipe-s${si < 0 ? 'x' : si % 5}`}"/>`;
      body += text(x + CW / 2, y + CH / 2, cell.name, `${MONO} d-small ${cell.flush ? 'd-pipe-flusht' : `d-pipe-t${si < 0 ? 'x' : si % 5}`}`, 'middle');
    });
    if (r.note) { const nx = cx(Math.max(N, r.start + r.cells.length)) + 6; body += text(nx, y + CH / 2, r.note, 'd-small d-muted'); maxX = Math.max(maxX, nx + tw(r.note, 11.5)); }
  });
  const cellOf = (ref) => {
    const [ri, st] = ref;
    const r = rows[ri];
    if (!r) throw new Error(`pipe: 矢印の行 ${ri} はありません`);
    let c;
    if (typeof st === 'number') c = st;
    else { const k = r.cells.findIndex((x) => x && x.name === st); if (k < 0) throw new Error(`pipe: 行 ${ri} に段階 ${st} はありません`); c = r.start + k; }
    return { x: cx(c), y: ry(ri), cxm: cx(c) + CW / 2, cym: ry(ri) + CH / 2 };
  };
  let asvg = '';
  (spec.arrows || []).forEach((a) => {
    const A = cellOf(a.from), B = cellOf(a.to);
    const style = a.style || 'accent';
    const down = B.y > A.y, up = B.y < A.y;
    // 元のマスの右寄りの下（上）から、先のマスの左寄りの上（下）へ
    let sx, sy, ex, ey;
    if (down || up) {
      const right = B.x > A.x, left = B.x < A.x;
      sx = A.cxm + (right ? CW / 2 - 8 : left ? -CW / 2 + 8 : 0); sy = down ? A.y + CH : A.y;
      ex = B.cxm + (right ? -CW / 2 + 8 : left ? CW / 2 - 8 : 0); ey = down ? B.y - 3 : B.y + CH + 3;
    } else { sx = A.x + CW; sy = A.cym; ex = B.x - 2; ey = B.cym; }
    asvg += `<path d="M${r1(sx)} ${r1(sy)} L${r1(ex)} ${r1(ey)}" class="d-edge d-edge-${style}" marker-end="url(#${pid}-${markerFor(style)})"/>`;
    if (a.label) {
      const mono = /^[\x00-\x7f]+$/.test(a.label);
      const lw = tw(a.label, 11.5, mono) + 12;
      // ラベルは行の間（矢印の先に近いすきま）に置く。矢印の線にかからないよう右へずらす
      let lx, ly;
      if (down || up) {
        ly = (down ? B.y : B.y + CH + GAPY) - GAPY / 2;
        const t = (ly - sy) / (ey - sy);
        if (Math.abs(ex - sx) > 2 * Math.abs(ey - sy)) lx = sx - Math.sign(ex - sx) * (lw / 2 + 6); // ほぼ横向きの矢印は、根元の外側に
        else lx = sx + (ex - sx) * t + (a.side === 'left' ? -1 : 1) * (lw / 2 + 8);
      } else { lx = (sx + ex) / 2; ly = sy - 14; }
      lx += a.ldx || 0; ly += a.ldy || 0;
      asvg += `<rect x="${r1(lx - lw / 2)}" y="${r1(ly - 10)}" width="${r1(lw)}" height="20" rx="5" class="d-elabel-bg"/>`;
      asvg += text(lx, ly, a.label, `d-small ${mono ? MONO : ''} d-elabel ${style === 'accent' || style === 'bad' ? 'd-accent-t' : ''}`, 'middle');
      maxX = Math.max(maxX, lx + lw / 2);
    }
  });
  const W = maxX + PAD, H = bottom + PAD;
  return { svg: svgWrap(pid, W, H, body + asvg, spec.label), w: W };
}

// ------------------------------------------------------------------ fdtable（fd 表 → ファイル記述 → inode の 3 段）
// spec: {
//   procs: [                                           左の段：プロセスごとの fd 表
//     { label:'sh（PID 2）', fds:[
//         { fd:0, to:'tty' },                          to はファイル記述の id。同じ id を指す fd は、同じファイル記述を共有している
//         { fd:1, to:'out', hl:true },                 hl:true で、その fd と線を強調色に
//         { fd:3, closed:true },                       閉じた fd（点線の枠。線は出ない）。note:'…' で右に小さな注記
//     ] },
//   ],
//   files: [                                           中の段：ファイル記述（open file description）
//     { id:'tty', flags:'O_RDWR', pos:0, refs:3, to:'pts' },     to は inode の id。pos = オフセット、refs = 参照数（省略すると、指している fd の数）
//     { id:'out', flags:'O_WRONLY|O_APPEND', pos:120, to:'f1', hl:true, note:'…' },
//   ],
//   inodes: [                                          右の段：inode（パイプやソケットもここに置く）
//     { id:'pts', label:'/dev/pts/0', sub:'inode 14・端末' },
//     { id:'p1', label:'パイプ', sub:'64 KiB のバッファ', kind:'pipe' },   kind:'pipe' で色を変える
//   ],
//   heads: ['fd 表', 'ファイル記述', 'inode'],         段の見出し（省略時はこの 3 つ）
// }
function fdtableSvg(spec, pid) {
  const PAD = 18, HEAD = 26, FW = 84, FH = 28, OW = 196, OH = 50, IW = 196, IH = 46, GAPX = 76, GAPY = 12, PGAP = 22, PLAB = 22;
  const procs = spec.procs || [], files = spec.files || [], inodes = spec.inodes || [];
  const heads = spec.heads || ['fd 表（プロセスごと）', 'ファイル記述（カーネルに 1 つずつ）', 'inode（ファイルの実体）'];
  const noteW = Math.max(0, ...procs.flatMap((p) => p.fds.map((f) => (f.note ? tw(f.note, 11.5) + 8 : 0))));
  const labW = Math.max(FW, ...procs.map((p) => tw(p.label || '', 12.5)));
  const X1 = PAD, X2 = X1 + Math.max(labW, FW + noteW) + GAPX, X3 = X2 + OW + GAPX;
  const h1 = procs.reduce((a, p) => a + PLAB + p.fds.length * FH + 12, 0) + (procs.length - 1) * PGAP;
  const h2 = files.length * OH + (files.length - 1) * GAPY, h3 = inodes.length * IH + (inodes.length - 1) * GAPY;
  const Hc = Math.max(h1, h2, h3), Y0 = PAD + HEAD;
  let body = '';
  [X1, X2, X3].forEach((x, i) => { body += text(x, PAD + 6, heads[i] || '', 'd-small d-muted'); });
  // ファイル記述と inode の位置を先に決める
  const fpos = {}, ipos = {};
  files.forEach((f, i) => { fpos[f.id] = { x: X2, y: Y0 + (Hc - h2) / 2 + i * (OH + GAPY), f }; });
  inodes.forEach((n, i) => { ipos[n.id] = { x: X3, y: Y0 + (Hc - h3) / 2 + i * (IH + GAPY), n }; });
  const refs = {};
  procs.forEach((p) => p.fds.forEach((f) => { if (f.to !== undefined && !f.closed) refs[f.to] = (refs[f.to] || 0) + 1; }));
  const link = (x1, y1, x2, y2, cls, mk) => { const mx = (x1 + x2) / 2; return `<path d="M${r1(x1)} ${r1(y1)} C${r1(mx)} ${r1(y1)} ${r1(mx)} ${r1(y2)} ${r1(x2 - 2)} ${r1(y2)}" class="d-fd-link ${cls}" marker-end="url(#${pid}-${mk})"/>`; };
  let links = '';
  // 同じ箱に入る線が重ならないよう、入る点を少しずつずらす
  const inCount = {}, inSeen = {};
  procs.forEach((p) => p.fds.forEach((f) => { if (fpos[f.to] && !f.closed) inCount[f.to] = (inCount[f.to] || 0) + 1; }));
  const spread = (key, count, h) => { const k = (inSeen[key] = (inSeen[key] || 0) + 1) - 1; return count <= 1 ? h / 2 : 10 + ((h - 20) * k) / (count - 1); };
  let y = Y0 + (Hc - h1) / 2;
  procs.forEach((p) => {
    const ph = PLAB + p.fds.length * FH + 12;
    body += `<rect x="${X1 - 8}" y="${r1(y)}" width="${r1(Math.max(labW, FW) + 16)}" height="${ph}" rx="8" class="d-fd-frame"/>`;
    body += text(X1, y + PLAB / 2 + 2, p.label || '', 'd-small d-val');
    p.fds.forEach((f, k) => {
      const fy = y + PLAB + k * FH + 2;
      body += `<rect x="${X1}" y="${r1(fy)}" width="${FW}" height="${FH - 4}" rx="5" class="d-fd-cell${f.hl ? ' is-hl' : ''}${f.closed ? ' is-closed' : ''}"/>`;
      body += text(X1 + FW / 2, fy + (FH - 4) / 2, f.label || `fd ${f.fd}`, `${MONO} d-small ${f.closed ? 'd-muted' : f.hl ? 'd-accent-t' : 'd-fd-t-stack'}`, 'middle');
      if (f.note) body += text(X1 + FW + 8, fy + (FH - 4) / 2, f.note, 'd-small d-muted');
      const t = fpos[f.to];
      if (f.to !== undefined && !f.closed) {
        if (!t) throw new Error(`fdtable: fd ${f.fd} が指すファイル記述 ${f.to} がありません`);
        links += link(X1 + FW + (f.note ? tw(f.note, 11.5) + 12 : 0), fy + (FH - 4) / 2, t.x, t.y + spread('f' + f.to, inCount[f.to], OH), f.hl ? 'is-hl' : '', f.hl ? 'a' : 'n');
      }
    });
    y += ph + PGAP;
  });
  const inC2 = {};
  files.forEach((f) => { if (f.to !== undefined) inC2[f.to] = (inC2[f.to] || 0) + 1; });
  let maxX = X3 + IW;
  files.forEach((f) => {
    const { x, y: fy } = fpos[f.id];
    body += `<rect x="${x}" y="${r1(fy)}" width="${OW}" height="${OH}" rx="7" class="d-fd-ofd${f.hl ? ' is-hl' : ''}"/>`;
    body += text(x + 12, fy + 16, f.flags || f.label || '', `${MONO} d-small d-fd-t-static`);
    const n = f.refs !== undefined ? f.refs : refs[f.id] || 0;
    body += text(x + 12, fy + 34, `オフセット ${f.pos ?? 0}　参照数 ${n}`, 'd-small d-fd-t-static');
    if (f.note) body += text(x, fy + OH + 9, f.note, 'd-tiny d-muted');
    if (f.to !== undefined) {
      const t = ipos[f.to];
      if (!t) throw new Error(`fdtable: ファイル記述 ${f.id} が指す inode ${f.to} がありません`);
      links += link(x + OW, fy + OH / 2, t.x, t.y + spread('i' + f.to, inC2[f.to], IH), f.hl ? 'is-hl' : '', f.hl ? 'a' : 'n');
    }
  });
  inodes.forEach((n) => {
    const { x, y: iy } = ipos[n.id];
    body += `<rect x="${x}" y="${r1(iy)}" width="${IW}" height="${IH}" rx="7" class="d-fd-ino${n.kind === 'pipe' ? ' is-pipe' : ''}${n.hl ? ' is-hl' : ''}"/>`;
    const tc = n.kind === 'pipe' ? 'd-fd-t-stack' : 'd-fd-t-heap';
    body += text(x + 12, iy + (n.sub ? 15 : IH / 2), n.label || '', `${/^[\x00-\x7f]+$/.test(n.label || '') ? MONO : ''} d-small ${tc}`);
    if (n.sub) body += text(x + 12, iy + 32, n.sub, `d-tiny ${tc}`);
  });
  const W = maxX + PAD, H = Y0 + Hc + PAD + (files.some((f) => f.note) ? 8 : 0);
  return { svg: svgWrap(pid, W, H, body + links, spec.label), w: W };
}

// ------------------------------------------------------------------ pagetable（仮想ページ → ページ表 → 物理フレーム）
// spec: {
//   tables: [                                          ページ表。1 つなら左、2 つなら左右に置いて、物理フレームを真ん中に挟む（fork とコピーオンライト）
//     { label:'親（PID 5）', pages:[
//         { vpn:'0x00400', name:'text', frame:3, flags:'r-x' },   frame は物理フレームの番号
//         { vpn:'0x00601', name:'data', frame:7, flags:'r--', state:'cow' },   state:'cow' で CoW の印（琥珀色）
//         { vpn:'0x00800', name:'heap', state:'none' },           state:'none' は未割り当て（点線。線は出ない）
//         … どれにも hl:true（強調色の枠と線）
//     ] },
//   ],
//   pages: [...]                                       ページ表が 1 つなら、tables の代わりにこう書ける
//   frames: [ { n:3, label:'ls のコード' }, { n:4, free:true }, … ]   物理フレーム。どのページからも指されていないものは「空き」になる。
//           数だけ書くと（frames: 8）0 番からその数だけ並べる。shared:true / hl:true も書ける（2 つ以上から指されていれば自動で共有の色）
//   heads: { vpn:'仮想ページ', pte:'ページ表', frame:'物理フレーム' }
// }
function pagetableSvg(spec, pid) {
  const PAD = 18, HEAD = 24, RH = 30, VW = 116, PW = 100, FRW = 138, GAPX = 52, LAB = 22;
  const tables = spec.tables || [{ label: spec.title || '', pages: spec.pages || [] }];
  if (tables.length > 2) throw new Error('pagetable: ページ表は 2 つまでです');
  const used = {};
  tables.forEach((t) => t.pages.forEach((p) => { if (p.frame !== undefined && p.state !== 'none') used[p.frame] = (used[p.frame] || 0) + 1; }));
  let frames = spec.frames;
  if (typeof frames === 'number') frames = Array.from({ length: frames }, (_, n) => ({ n }));
  if (!frames) frames = Object.keys(used).map(Number).sort((a, b) => a - b).map((n) => ({ n }));
  const TW = VW + PW;
  const two = tables.length === 2;
  const XL = PAD, XF = XL + TW + GAPX, XR = XF + FRW + GAPX;
  const hT = (t) => LAB + t.pages.length * RH, hF = frames.length * RH;
  const Hc = Math.max(hF + LAB, ...tables.map(hT)), Y0 = PAD + HEAD;
  const hd = Object.assign({ vpn: '仮想ページ', pte: 'ページ表の中身', frame: '物理フレーム' }, spec.heads || {});
  let body = '', links = '';
  const fy = (n) => { const i = frames.findIndex((f) => f.n === n); if (i < 0) throw new Error(`pagetable: フレーム ${n} が frames にありません`); return Y0 + (Hc - hF - LAB) / 2 + LAB + i * RH; };
  body += text(XF, PAD + 6, hd.frame, 'd-small d-muted');
  frames.forEach((f) => {
    const y = fy(f.n), free = f.free !== undefined ? f.free : !used[f.n], shared = f.shared !== undefined ? f.shared : used[f.n] > 1;
    body += `<rect x="${XF}" y="${r1(y + 2)}" width="${FRW}" height="${RH - 4}" rx="5" class="d-pt-frame${free ? ' is-free' : ''}${shared ? ' is-shared' : ''}${f.hl ? ' is-hl' : ''}"/>`;
    body += text(XF + 10, y + RH / 2, `${f.n}`, `${MONO} d-small ${free ? 'd-muted' : 'd-val'}`);
    body += text(XF + 36, y + RH / 2, f.label || (free ? '空き' : ''), `d-small ${free ? 'd-muted' : 'd-val'}`);
  });
  tables.forEach((t, ti) => {
    const right = two && ti === 1;
    const x = right ? XR : XL;
    const y0 = Y0 + (Hc - hT(t)) / 2;
    body += text(x, PAD + 6, right ? `${hd.pte}・${hd.vpn}` : `${hd.vpn}・${hd.pte}`, 'd-small d-muted');
    if (t.label) body += text(x, y0 + LAB / 2 - 2, t.label, 'd-small d-val');
    t.pages.forEach((p, k) => {
      const y = y0 + LAB + k * RH;
      const none = p.state === 'none', cow = p.state === 'cow';
      const vx = right ? x + PW : x, px = right ? x : x + VW;
      const cls = `d-pt-row${none ? ' is-none' : ''}${cow ? ' is-cow' : ''}${p.hl ? ' is-hl' : ''}`;
      body += `<rect x="${vx}" y="${r1(y + 2)}" width="${VW - 3}" height="${RH - 4}" rx="5" class="${cls}"/>`;
      body += text(vx + 8, y + RH / 2, p.vpn ?? '', `${MONO} d-small ${none ? 'd-muted' : 'd-val'}`);
      if (p.name) body += text(vx + VW - 11, y + RH / 2, p.name, `d-tiny ${none ? 'd-muted' : 'd-val'}`, 'end');
      body += `<rect x="${px}" y="${r1(y + 2)}" width="${PW - 3}" height="${RH - 4}" rx="5" class="${cls}"/>`;
      if (none) body += text(px + (PW - 3) / 2, y + RH / 2, p.note || '未割り当て', 'd-tiny d-muted', 'middle');
      else {
        body += text(px + 8, y + RH / 2, `→ ${p.frame}`, `${MONO} d-small d-val`);
        if (cow) {
          body += `<rect x="${px + PW - 3 - 62}" y="${r1(y + 7)}" width="26" height="${RH - 14}" rx="4" class="d-pt-tag"/>` + text(px + PW - 3 - 49, y + RH / 2, 'CoW', 'd-tiny d-pt-tagt', 'middle');
        }
        if (p.flags) body += text(px + PW - 11, y + RH / 2, p.flags, `${MONO} d-tiny d-val`, 'end');
        const sx = right ? x : x + TW - 3, ex = right ? XF + FRW + 2 : XF, ty = fy(p.frame) + RH / 2, mx = (sx + ex) / 2;
        links += `<path d="M${r1(sx)} ${r1(y + RH / 2)} C${r1(mx)} ${r1(y + RH / 2)} ${r1(mx)} ${r1(ty)} ${r1(right ? ex : ex - 2)} ${r1(ty)}" class="d-fd-link${p.hl ? ' is-hl' : cow ? ' is-muted' : ''}" marker-end="url(#${pid}-${p.hl ? 'a' : cow ? 'm' : 'n'})"/>`;
      }
    });
  });
  const W = (two ? XR + TW : XF + FRW) + PAD, H = Y0 + Hc + PAD - 6;
  return { svg: svgWrap(pid, W, H, body + links, spec.label), w: W };
}

// ------------------------------------------------------------------ gantt（スケジューラのガントチャート）
// 横軸 = 時間（tick）、縦 = プロセス。
// spec: {
//   rows: [                                            プロセスごとの行
//     { label:'A（PID 3）', spans:[
//         { from:0, to:10 },                           CPU を使っている区間（to は含まない）
//         { from:10, to:30, kind:'wait', label:'sleep' },   kind:'wait' = 待っている（点線の枠）、'ready' = 実行できるが順番待ち（薄い灰色）
//         { from:30, to:40, hl:true, label:'…' },      hl:true で強調、label は区間の中に書く文字（入るときだけ）
//     ], note:'nice 0' },
//   ],
//   runs: [['A', 0, 10], ['B', 10, 20], …]             rows の代わりに「だれが、いつからいつまで走ったか」の列でも書ける（{ p, from, to } でもよい）。
//                                                      行は名前が最初に出てきた順に作る。カーネルの切り替えの記録をそのまま渡せる
//   end: 60,              横軸の終わり（省略時は最後の区間まで）。start: 0
//   tick: 10,             目盛りの間隔（省略時は自動）
//   unit: 'tick',         横軸の単位の名前
//   switches: true,       切り替え（CPU を使う区間の境目）に縦の点線を引く
//   marks: [{ at:30, label:'B が起きる' }],   時刻に縦線とラベル
//   cpu: true,            いちばん下に「CPU」の行を足す（その時刻に走っているプロセスの名前）
//   width: 520,           チャートの部分の幅（px）
// }
function ganttSvg(spec, pid) {
  const PAD = 18, RH = 26, GAPY = 10, AX = 24;
  let rows = spec.rows ? spec.rows.map((r) => ({ ...r, spans: (r.spans || []).slice() })) : [];
  if (spec.runs) {
    const by = new Map(rows.map((r) => [r.label, r]));
    spec.runs.forEach((u) => {
      const [p, from, to] = Array.isArray(u) ? u : [u.p, u.from, u.to];
      if (!by.has(p)) { const r = { label: String(p), spans: [] }; by.set(p, r); rows.push(r); }
      by.get(p).spans.push({ from, to });
    });
  }
  const all = rows.flatMap((r) => r.spans);
  const t0 = spec.start ?? 0, t1 = spec.end ?? Math.max(1, ...all.map((s) => s.to));
  const CW = spec.width || 520, sc = CW / (t1 - t0);
  const labW = Math.max(spec.cpu ? tw('CPU', FS) : 0, ...rows.map((r) => tw(r.label || '', FS))) + 14;
  const X0 = PAD + labW, Y0 = PAD + (spec.marks && spec.marks.some((m) => m.label) ? 18 : 0);
  const X = (t) => X0 + (t - t0) * sc;
  const nRows = rows.length + (spec.cpu ? 1 : 0);
  const bottom = Y0 + nRows * (RH + GAPY) - GAPY;
  let step = spec.tick;
  if (!step) { const raw = (t1 - t0) / 8; step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((v) => v >= raw) || Math.ceil(raw); }
  let body = '';
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    body += `<line x1="${r1(X(t))}" y1="${Y0 - 2}" x2="${r1(X(t))}" y2="${bottom + 4}" class="d-gt-grid"/>` + text(X(t), bottom + 14, String(t), `${MONO} d-tiny d-muted`, 'middle');
  }
  body += text(X(t1) + 10, bottom + 14, spec.unit || 'tick', 'd-tiny d-muted');
  const isRun = (s) => !s.kind || s.kind === 'run';
  if (spec.switches) {
    const cuts = new Set();
    all.filter(isRun).forEach((s) => { cuts.add(s.from); cuts.add(s.to); });
    cuts.forEach((t) => { if (t > t0 && t < t1) body += `<line x1="${r1(X(t))}" y1="${Y0 - 2}" x2="${r1(X(t))}" y2="${bottom + 2}" class="d-gt-sw"/>`; });
  }
  let maxX = X(t1) + 10 + tw(spec.unit || 'tick', 10.5);
  const bar = (s, y, ci, lab) => {
    const x = X(Math.max(s.from, t0)), w = Math.max(1.5, X(Math.min(s.to, t1)) - x);
    const cls = s.kind === 'wait' ? 'd-gt-wait' : s.kind === 'ready' ? 'd-gt-ready' : `d-gt-run d-gt-c${ci % 4}${s.hl ? ' d-gt-hl' : ''}`;
    let h = `<rect x="${r1(x)}" y="${y}" width="${r1(w)}" height="${RH}" rx="4" class="${cls}"/>`;
    if (lab && tw(lab, 11.5) + 6 <= w) h += text(x + w / 2, y + RH / 2, lab, `d-small ${s.kind === 'wait' || s.kind === 'ready' ? 'd-muted' : 'd-val'}`, 'middle');
    return h;
  };
  rows.forEach((r, i) => {
    const y = Y0 + i * (RH + GAPY);
    body += text(X0 - 12, y + RH / 2, r.label || '', `d-val${r.hl ? ' d-accent-t' : ''}`, 'end');
    body += `<rect x="${X0}" y="${y}" width="${CW}" height="${RH}" rx="4" class="d-gt-track"/>`;
    r.spans.forEach((s) => { body += bar(s, y, r.color ?? i, s.label); });
    if (r.note) { body += text(X(t1) + 10, y + RH / 2, r.note, 'd-small d-muted'); maxX = Math.max(maxX, X(t1) + 10 + tw(r.note, 11.5)); }
  });
  if (spec.cpu) {
    const y = Y0 + rows.length * (RH + GAPY);
    body += text(X0 - 12, y + RH / 2, 'CPU', 'd-val', 'end');
    body += `<rect x="${X0}" y="${y}" width="${CW}" height="${RH}" rx="4" class="d-gt-track"/>`;
    rows.forEach((r, i) => r.spans.filter(isRun).forEach((s) => { body += bar(s, y, r.color ?? i, String(r.label || '').replace(/[（(].*$/, '')); }));
  }
  (spec.marks || []).forEach((m) => {
    const at = typeof m === 'number' ? m : m.at;
    body += `<line x1="${r1(X(at))}" y1="${Y0 - 6}" x2="${r1(X(at))}" y2="${bottom + 4}" class="d-gt-mark"/>`;
    if (m.label) { body += text(X(at), Y0 - 14, m.label, 'd-small d-accent-t', 'middle'); maxX = Math.max(maxX, X(at) + tw(m.label, 11.5) / 2); }
  });
  const W = maxX + PAD, H = bottom + 22 + PAD - 6;
  return { svg: svgWrap(pid, W, H, body, spec.label), w: W };
}

const ENGINES = { mem: memSvg, graph: graphSvg, tree: treeSvg, life: lifeSvg, seq: seqSvg, bars: barsSvg, layout: layoutSvg, timeline: timelineSvg, circuit: circuitSvg, wave: waveSvg, pipe: pipeSvg, fdtable: fdtableSvg, pagetable: pagetableSvg, gantt: ganttSvg };

// fig 要素 1 つをレンダリング。spec.steps があればステップ切替
export function renderFig(type, spec, caption, figNo) {
  const eng = ENGINES[type];
  if (!eng) throw new Error('unknown fig type ' + type);
  const id = 'f' + ++FIG_SEQ;
  let inner;
  if (spec.steps) {
    const shared = { ...spec };
    delete shared.steps;
    const parts = spec.steps.map((s, i) => {
      const r = eng({ ...shared, ...s }, `${id}s${i}`);
      return `<div class="step-pane" data-i="${i}"${i ? ' hidden' : ''}>${r.svg}${s.say ? `<p class="step-say">${s.say}</p>` : ''}</div>`;
    });
    const btns = spec.steps
      .map((s, i) => `<button type="button" class="step-btn" data-i="${i}" aria-pressed="${i === 0}"><span class="step-n">${i + 1}</span>${esc(s.title || '')}</button>`)
      .join('');
    inner = `<div class="steps" data-n="${spec.steps.length}"><div class="step-bar" role="group" aria-label="ステップ">${btns}</div><div class="fig-body">${parts.join('')}</div></div>`;
  } else {
    const r = eng(spec, id);
    inner = `<div class="fig-body">${r.svg}</div>`;
  }
  return `<figure class="fig">${inner}<figcaption><span class="fig-no">図 ${figNo}</span><span>${caption}</span></figcaption></figure>`;
}
