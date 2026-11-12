// SVG 図エンジン：mem（スタック/ヒープ）, graph（依存・フロー）, tree（モジュール木）,
// life（ライフタイム）, seq（シーケンス）, bars（棒グラフ）, layout（バイト列）
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

const ENGINES = { mem: memSvg, graph: graphSvg, tree: treeSvg, life: lifeSvg, seq: seqSvg, bars: barsSvg, layout: layoutSvg };

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
