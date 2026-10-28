// S2 长卷的草木：点叶树 / 介字点 / 横点 / 寒林蟹爪 / 松 / 柳，树丛；远古的树蕨、苏铁、蕨丛、木贼
// 写意法：干用中锋带飞白，叶用成簇的点和短笔（不是均匀的毛刺），浓淡前后分开，偶尔垫一层淡墨衬出团块。
import { stroke, wash, dot, rng, vn1 } from '../../film/ink.js';
import { twin } from './land.js';

const lerp = (a, b, t) => a + (b - a) * t;
const cl = (x, a, b) => (x < a ? a : x > b ? b : x);
const ss = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

/** 沿折线按弧长参数 u（0..1）取点 */
function along(pts, u) {
  let L = 0;
  const seg = [];
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); L += l; }
  let s = u * L;
  for (let i = 0; i < seg.length; i++) {
    if (s <= seg[i] || i === seg.length - 1) {
      const t = seg[i] > 0 ? cl(s / seg[i], 0, 1) : 0;
      const a = pts[i], b = pts[i + 1];
      return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), Math.atan2(b[1] - a[1], b[0] - a[0])];
    }
    s -= seg[i];
  }
  const a = pts[pts.length - 1];
  return [a[0], a[1], 0];
}

// ---------------------------------------------------------------------------
// 树
// ---------------------------------------------------------------------------
/** 一团叶：抖动网格上按密度取点（中间、上面密而深，边缘疏而淡，边界有起伏）；先一遍淡而大，再一遍浓 */
function leafClump(buf, cx, cy, rx, ry, kind, ms, tone, R, sd, tt, o = {}) {
  if (o.wash !== false) {
    const poly = [];
    for (let k = 0; k < 14; k++) { const a = (k / 14) * Math.PI * 2; const q = 1 + 0.2 * Math.sin(a * 3 + sd) + 0.1 * Math.sin(a * 5 + sd * 2); poly.push([cx + Math.cos(a) * rx * 1.02 * q, cy + Math.sin(a) * ry * 1.02 * q]); }
    wash(buf, poly, { tone: tone * (o.washTone ?? 0.14), soft: rx * 0.3, rim: 0.3, jag: 2, jagScale: 8, gran: 0.55, bloom: 0.4, bloomScale: 20, seed: sd, ...tt });
  }
  const passes = [{ sp: 1.25, tn: 0.5, sz: 1.2, top: 1.0 }, { sp: 0.95, tn: 1, sz: 1, top: 0.72 }];
  let mi = 0;
  for (const ps of passes) {
    const step = ms * ps.sp * (kind === 'jie' ? 1.6 : kind === 'heng' ? 1.5 : kind === 'needle' ? 1.7 : 1.05);
    for (let gy = cy - ry; gy <= cy + ry; gy += step * 0.8) {
      for (let gx = cx - rx; gx <= cx + rx; gx += step) {
        const px = gx + R.r(-0.45, 0.45) * step, py = gy + R.r(-0.4, 0.4) * step * 0.8;
        const ex = (px - cx) / rx, ey = (py - cy) / ry;
        let rr = ex * ex + ey * ey;
        rr *= 1 + 0.45 * (vn1(px * 0.05 + sd) + vn1(py * 0.07 + sd * 3) - 1);
        const topK = 1 - (py - (cy - ry)) / (2 * ry);           // 1 顶 … 0 底
        if (topK < 1 - ps.top) continue;
        const dens = (1 - ss(0.35, 1.0, rr)) * (0.7 + 0.3 * topK);
        if (R.f() > dens) continue;
        const tn = tone * ps.tn * (0.55 + 0.45 * Math.min(1, (1 - rr) * 0.8 + topK * 0.4)) * R.r(0.85, 1.1);
        const sz = ms * ps.sz * R.r(0.8, 1.2);
        const id = sd * 5000 + mi++;
        if (kind === 'jie') {
          const rot = R.r(-0.3, 0.3);
          for (const [dx, dy] of [[-0.8, 0.85], [0.05, 1.05], [0.85, 0.8]]) {
            const qx = px + (dx * Math.cos(rot) - dy * Math.sin(rot)) * sz, qy = py + (dx * Math.sin(rot) + dy * Math.cos(rot)) * sz;
            stroke(buf, [[px, py, 1], [qx, qy, 0.25]], { w: Math.max(1, sz * 0.45), tone: tn, tail: 0.55, head: 0.1, seed: id * 3 + (dx > 0 ? 1 : dx < 0 ? 2 : 0), ...tt });
          }
        } else if (kind === 'heng') {
          dot(buf, px, py, sz * 0.5, { ax: R.r(2, 2.7), ang: R.r(-0.15, 0.15), tone: tn, jag: 0.3, rim: 0.4, halo: 1.5, seed: id, ...tt });
        } else if (kind === 'needle') {
          // 松针：一小把往上散开的短针
          const nn = 4;
          for (let q = 0; q < nn; q++) {
            const a = -Math.PI * (0.12 + 0.76 * (q + R.r(0, 1)) / nn);
            const l = sz * R.r(1.4, 2.1);
            stroke(buf, [[px, py, 1], [px + Math.cos(a) * l, py + Math.sin(a) * l * 0.75, 0.2]], { w: Math.max(0.8, sz * 0.22), tone: tn, tail: 0.5, head: 0.05, seed: id * 5 + q, ...tt });
          }
        } else if (kind === 'pinecone') {
          dot(buf, px, py, sz * 0.45, { ax: R.r(1, 1.3), tone: tn, jag: 0.25, rim: 0.4, halo: 1, seed: id, ...tt });
        } else {
          dot(buf, px, py, sz * 0.5, { ax: R.r(1.1, 1.6), ang: R.r(-0.6, 0.6), tone: tn, jag: 0.25, rim: 0.3, halo: 1, seed: id, ...tt });
        }
      }
    }
  }
}

/**
 * 写意树：x,y 根部，h 高。o.kind：'dot' 点叶 | 'jie' 介字点 | 'heng' 横点（湿、大）| 'bare' 寒林（蟹爪枝）| 'pine' 松
 * o：tone seed lean branches trunkW leafK(团大小) leafDensity wash(垫淡墨) tw
 */
export function tree2(buf, x, y, h, o = {}) {
  if (!buf) return;
  const kind = o.kind ?? 'dot', seed = o.seed ?? 1, R = rng(seed * 83 + 7), tone = o.tone ?? 0.85, T = o.tw;
  const lean = o.lean ?? R.r(-0.14, 0.14);
  const trunkH = kind === 'bare' || kind === 'pine' ? 0.92 : 0.78;
  const ph = R.f() * 6, bendA = (kind === 'pine' ? R.r(0.05, 0.1) : R.r(0.02, 0.06)) * (R.f() < 0.5 ? -1 : 1);
  const tp = [];
  for (let i = 0; i <= 6; i++) { const u = i / 6; tp.push([x + lean * h * u + Math.sin(u * 3.4 + ph) * h * bendA, y - h * trunkH * u, 1 - 0.55 * u]); }
  const tW = h * (o.trunkW ?? (kind === 'pine' ? 0.078 : kind === 'bare' ? 0.052 : 0.05));
  if (h > 130 && o.double !== false) {
    // 双勾干：两笔轮廓 + 一层淡墨 + 节疤（松另加鳞）
    const L = tp.map(([px, py, pp]) => [px - tW * 0.5 * pp, py, 0.9]);
    const Rr = tp.map(([px, py, pp]) => [px + tW * 0.5 * pp, py, 0.8]);
    stroke(buf, L, { w: Math.max(1.6, tW * 0.22), tone: tone * 0.95, dry: 0.28, dryEnd: 0.6, rough: 0.14, fray: 0.6, tail: 0.2, halo: 1, seed: seed * 5 + 1, ...twin(T, 0, 0.15) });
    stroke(buf, Rr, { w: Math.max(1.4, tW * 0.17), tone: tone * 0.8, dry: 0.38, dryEnd: 0.72, rough: 0.14, fray: 0.6, tail: 0.2, seed: seed * 5 + 2, ...twin(T, 0.05, 0.2) });
    wash(buf, [...L.map((q) => [q[0], q[1]]), ...Rr.map((q) => [q[0], q[1]]).reverse()], { tone: tone * 0.3, rim: 0.3, jag: 0.8, jagScale: 8, gran: 0.6, streak: 0.45, streakAng: 1.5, seed: seed * 5 + 3,
      gfn: (wx) => 0.55 + 0.45 * cl((wx - x) / tW + 0.5, 0, 1), ...twin(T, 0.1, 0.25) });
    const nk = kind === 'pine' ? 9 : 3;
    for (let i = 0; i < nk; i++) {
      const q = along(tp, R.r(0.08, 0.75));
      if (kind === 'pine') {
        const cx = q[0] + R.r(-0.25, 0.25) * tW, r = tW * R.r(0.16, 0.24);
        stroke(buf, [[cx - r, q[1], 0.6], [cx, q[1] - r * 0.7, 1], [cx + r, q[1], 0.5]], { w: Math.max(1, tW * 0.08), tone: tone * 0.8, tail: 0.4, seed: seed * 5 + 10 + i, ...twin(T, 0.2, 0.25) });
      } else dot(buf, q[0] + R.r(-0.2, 0.2) * tW, q[1], tW * 0.14, { ax: 1.6, ang: 1.4, tone, seed: seed * 5 + 10 + i, ...twin(T, 0.2, 0.25) });
    }
  } else {
    stroke(buf, tp, { w: tW, tone: tone * 0.92, dry: 0.3, dryEnd: 0.7, rough: 0.15, fray: 0.5, halo: 1.2, tail: 0.28, shade: 0.35, seed: seed * 5 + 1, ...twin(T, 0, 0.22) });
  }
  // 枝
  const nb = o.branches ?? (kind === 'bare' ? 10 : kind === 'pine' ? 6 : 5);
  const tips = [];
  const bt = twin(T, 0.2, 0.42);
  for (let i = 0; i < nb; i++) {
    const u = lerp(kind === 'pine' ? 0.42 : 0.34, 0.95, nb > 1 ? i / (nb - 1) : 0.5) + R.r(-0.04, 0.04);
    const [bx, by] = along(tp, u);
    const side = (i % 2 ? 1 : -1) * (R.f() < 0.18 ? -1 : 1);
    const len = h * R.r(0.2, 0.36) * (1.2 - 0.6 * u) * (kind === 'pine' ? 1.35 : kind === 'bare' ? 1.1 : 1);
    const up = kind === 'pine' ? R.r(-0.25, 0.15) : kind === 'bare' ? R.r(0.25, 0.9) : R.r(0.35, 0.8);
    const ex = bx + side * len * Math.cos(up), ey = by - len * Math.sin(up);
    const mx = lerp(bx, ex, 0.5) + R.r(-0.05, 0.05) * len, my = lerp(by, ey, 0.5) + len * R.r(0.02, 0.12) * (kind === 'pine' ? -1 : 1);
    stroke(buf, [[bx, by, 0.9], [mx, my, 0.65], [ex, ey, 0.2]], { w: Math.max(1.2, tW * R.r(0.3, 0.45)), tone: tone * 0.9, dry: 0.3, dryEnd: 0.7, tail: 0.5, rough: 0.12, seed: seed * 20 + i, ...bt });
    tips.push([ex, ey, side, len, bx, by]);
    if (kind === 'bare') {
      // 蟹爪：两级小枝，末梢向下勾
      const nt = R.i(3, 5);
      for (let j = 0; j < nt; j++) {
        const v = R.r(0.35, 1);
        const sx = lerp(bx, ex, v), sy = lerp(by, ey, v) + len * 0.04;
        const tl = len * R.r(0.25, 0.5), ta = up + R.r(-0.6, 0.7);
        const tx = sx + side * tl * Math.cos(ta), ty = sy - tl * Math.sin(ta);
        stroke(buf, [[sx, sy, 0.8], [lerp(sx, tx, 0.6), lerp(sy, ty, 0.6) - tl * 0.05, 0.6], [tx + side * tl * 0.1, ty + tl * R.r(0.08, 0.25), 0.15]], { w: Math.max(0.9, tW * 0.2), tone: tone * 0.88, dry: 0.2, tail: 0.6, seed: seed * 40 + i * 7 + j, ...twin(T, 0.4, 0.7) });
        const n2 = R.i(1, 3);
        for (let m = 0; m < n2; m++) {
          const w2 = R.r(0.4, 1), qx = lerp(sx, tx, w2), qy = lerp(sy, ty, w2);
          const l2 = tl * R.r(0.3, 0.5), a2 = ta + R.r(-0.8, 0.6);
          stroke(buf, [[qx, qy, 0.7], [qx + side * l2 * Math.cos(a2) * 0.6, qy - l2 * Math.sin(a2) * 0.6, 0.5], [qx + side * l2 * Math.cos(a2), qy - l2 * Math.sin(a2) + l2 * 0.25, 0.1]], { w: Math.max(0.8, tW * 0.12), tone: tone * 0.8, tail: 0.6, seed: seed * 60 + i * 13 + j * 3 + m, ...twin(T, 0.6, 0.85) });
        }
      }
    }
  }
  const top = tp[tp.length - 1];
  tips.push([top[0], top[1], 0, h * 0.25, top[0], top[1] + h * 0.1]);
  if (kind === 'bare') return;
  const lt = (k) => twin(T, 0.45 + 0.5 * k, 0.55 + 0.45 * k);
  tips.forEach(([tx, ty, side, len, bx, by], ci) => {
    const kk = ci / tips.length;
    if (kind === 'pine') {
      // 松针：沿枝一两团扁平的针叶（深墨、针的边），底下垫淡墨
      const nf = R.i(1, 2);
      for (let f = 0; f < nf; f++) {
        const v = nf === 1 ? 1 : lerp(0.6, 1, f);
        const cx = lerp(bx, tx, v) + R.r(-3, 3), cy = lerp(by, ty, v) - 2;
        const rx = h * R.r(0.1, 0.14) * (o.leafK ?? 1), ry = rx * R.r(0.3, 0.42);
        leafClump(buf, cx, cy, rx, ry, 'needle', Math.max(1.6, h * 0.016), tone, R, seed * 60 + ci * 3 + f, lt(kk), { wash: o.wash !== false, washTone: 0.2 });
      }
      return;
    }
    const rx = h * R.r(0.11, 0.17) * (o.leafK ?? 1), ry = rx * R.r(0.55, 0.75);
    const ms = Math.max(1.8, h * (kind === 'heng' ? 0.03 : kind === 'jie' ? 0.03 : 0.02));
    leafClump(buf, tx + side * rx * 0.3, ty + ry * 0.1, rx, ry, kind, ms, tone, R, seed * 60 + ci, lt(kk), { wash: o.wash !== false && R.f() < 0.85 });
  });
}

/** 一丛树：n 棵，高低、种类、前后错开（前深后淡） */
export function treeGroup(buf, x, y, h, n, o = {}) {
  if (!buf) return;
  const R = rng((o.seed ?? 1) * 89 + 1);
  const kinds = o.kinds ?? ['dot', 'jie', 'heng'];
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  // 后面的先画（淡），前面的后画（浓）
  order.sort((a, b) => (a % 2) - (b % 2));
  for (const i of order) {
    const back = i % 2 === 1;
    const xi = x + (i - (n - 1) / 2) * h * R.r(0.16, 0.3);
    const hi = h * R.r(0.7, 1.08) * (back ? 0.88 : 1);
    tree2(buf, xi, y + (back ? -R.r(2, 8) : R.r(0, 4)), hi, { kind: kinds[i % kinds.length], tone: (o.tone ?? 0.85) * (back ? 0.62 : 1), seed: (o.seed ?? 1) * 10 + i,
      lean: R.r(-0.16, 0.16), tw: o.tw ? twin(o.tw, (back ? 0 : 0.2), (back ? 0.8 : 1)) : undefined, wash: o.wash });
  }
}

/** 双勾树干：两笔轮廓（左重右轻）+ 一层淡墨 + 几道树皮短皴 */
function trunkDouble(buf, tp, tW, tone, R, sd, tt, knots = 3) {
  const L = tp.map(([px, py, pp]) => [px - tW * 0.5 * pp, py, 0.9]);
  const Rr = tp.map(([px, py, pp]) => [px + tW * 0.5 * pp, py, 0.8]);
  stroke(buf, L, { w: Math.max(1.6, tW * 0.2), tone: tone * 0.95, dry: 0.3, dryEnd: 0.62, rough: 0.16, fray: 0.7, tail: 0.2, halo: 1, seed: sd + 1, ...tt });
  stroke(buf, Rr, { w: Math.max(1.4, tW * 0.15), tone: tone * 0.78, dry: 0.4, dryEnd: 0.72, rough: 0.16, fray: 0.7, tail: 0.2, seed: sd + 2, ...tt });
  wash(buf, [...L.map((q) => [q[0], q[1]]), ...Rr.map((q) => [q[0], q[1]]).reverse()], { tone: tone * 0.3, rim: 0.3, jag: 0.8, jagScale: 8, gran: 0.6, streak: 0.5, streakAng: 1.5, seed: sd + 3, ...tt });
  for (let i = 0; i < knots; i++) {
    const q = along(tp, R.r(0.1, 0.8));
    const w = tW * R.r(0.25, 0.45);
    stroke(buf, [[q[0] - w * 0.5, q[1] + R.r(-2, 2), 0.5], [q[0] + R.r(-2, 2), q[1] - w * 0.2, 1], [q[0] + w * 0.5, q[1] + R.r(-2, 2), 0.4]], { w: Math.max(1, tW * 0.1), tone: tone * 0.85, dry: 0.3, tail: 0.4, seed: sd + 10 + i, ...tt });
  }
}

/** 柳：歪斜的老干，低处分出几根往外拱的大枝；柳条沿枝各处拱出后长长垂下（成伞形），条上疏叶，外罩一层极淡的墨 */
export function willow2(buf, x, y, h, o = {}) {
  if (!buf) return;
  const seed = o.seed ?? 1, R = rng(seed * 43 + 3), tone = o.tone ?? 0.8, T = o.tw;
  const lean = o.lean ?? R.r(-0.25, 0.25);
  const fork = [x + lean * h * 0.3, y - h * 0.32];
  const tp = [[x, y, 1], [x + lean * h * 0.12 + R.r(-0.02, 0.02) * h, y - h * 0.16, 0.9], [fork[0], fork[1], 0.8]];
  trunkDouble(buf, tp, h * 0.1, tone, R, seed * 5, twin(T, 0, 0.2), 3);
  const limbs = [];
  const angs = [-1.15, -0.5, 0.15, 0.85].map((a) => a + lean * 0.8 + R.r(-0.15, 0.15));
  angs.forEach((a, i) => {
    const l = h * R.r(0.32, 0.5) * (1 - 0.25 * Math.abs(Math.sin(a)));
    const ex = fork[0] + Math.sin(a) * l, ey = fork[1] - Math.cos(a) * l * 0.75;
    const mx = lerp(fork[0], ex, 0.55), my = lerp(fork[1], ey, 0.55) - l * 0.12;
    const pts = [[fork[0] + Math.sin(a) * h * 0.02, fork[1], 1], [mx, my, 0.7], [ex, ey + l * 0.08, 0.25]];
    stroke(buf, pts, { w: h * 0.036, tone: tone * 0.85, dry: 0.35, dryEnd: 0.7, rough: 0.18, fray: 0.7, tail: 0.45, seed: seed * 9 + i, ...twin(T, 0.15, 0.35) });
    limbs.push(pts);
  });
  const wind = o.wind ?? 0.5;
  const ns = o.strands ?? 52;
  for (let i = 0; i < ns; i++) {
    const lp = limbs[i % limbs.length];
    const [sx0, sy0] = along(lp, R.r(0.25, 1));
    const sx = sx0 + R.r(-0.015, 0.015) * h, sy = sy0 + R.r(-0.01, 0.015) * h;
    const out = (sx >= fork[0] ? 1 : -1) * h * R.r(0.01, 0.05);
    const rise = h * R.r(0.005, 0.03);
    const len = Math.max(h * 0.1, (y - sy) * R.r(0.4, 0.85));
    const sway = wind * h * R.r(0.01, 0.05);
    const pts = [[sx, sy, 0.45], [sx + out * 0.6, sy - rise, 0.9], [sx + out, sy + len * 0.15, 0.85], [sx + out * 1.1 + sway * 0.4, sy + len * 0.6, 0.6], [sx + out * 1.15 + sway, sy + len, 0.1]];
    const k = i / ns;
    stroke(buf, pts, { w: Math.max(0.9, h * 0.0072), tone: tone * R.r(0.28, 0.68), dry: 0.1, dryEnd: 0.4, head: 0.1, tail: 0.35, seed: seed * 11 + i, ...twin(T, 0.3 + 0.5 * k, 0.45 + 0.5 * k) });
    const nlv = Math.round(len / (h * 0.03));
    for (let j = 0; j < nlv; j++) {
      const v = (j + 0.5) / nlv;
      if (R.f() > 0.45) continue;
      const lx = sx + out * (1 + 0.15 * v) + sway * v * v + R.r(-1.2, 1.2), ly = sy + len * (0.15 + 0.85 * v);
      dot(buf, lx, ly, Math.max(0.8, h * 0.0075), { ax: 2.4, ang: 1.3 + R.r(-0.35, 0.35), tone: tone * R.r(0.28, 0.6), halo: 0.8, seed: seed * 13 + i * 50 + j, ...twin(T, 0.5 + 0.45 * k, 0.6 + 0.4 * k) });
    }
  }
  const cx = fork[0], cy = fork[1];
  const poly = [];
  for (let k = 0; k < 14; k++) { const a = (k / 14) * Math.PI * 2; poly.push([cx + Math.cos(a) * h * 0.5 * (1 + 0.14 * Math.sin(a * 3 + seed)), cy + Math.sin(a) * h * 0.36 * (a > 0 && a < Math.PI ? 1.15 : 0.95)]); }
  wash(buf, poly, { tone: tone * 0.08, soft: h * 0.15, rim: 0.2, jag: 3, jagScale: 20, gran: 0.6, bloom: 0.5, bloomScale: 30, seed: seed * 17, ...twin(T, 0.6, 1) });
}

// ---------------------------------------------------------------------------
// 远古植物
// ---------------------------------------------------------------------------
/** 一片羽状叶：沿叶轴两侧排小叶（宽、短、互相搭住，湿墨），越往叶尖越小越淡 */
function frond(buf, pts, len, o, R, sd, tt) {
  const tone = o.tone, lw = o.lw;
  stroke(buf, pts, { w: Math.max(1.1, o.axW), tone: tone * 0.95, dry: 0.12, dryEnd: 0.5, tail: 0.35, head: 0.08, seed: sd, ...tt });
  const m = o.pinnae ?? 14;
  for (let k = 0; k < m; k++) {
    const u = 0.06 + 0.92 * (k + R.r(0.2, 0.8)) / m;
    const [px, py, ang] = along(pts, u);
    const size = len * lw * Math.sin(Math.PI * (0.12 + 0.88 * u)) * (1 - 0.35 * u) * R.r(0.85, 1.12);
    if (size < 2) continue;
    for (const side of [-1, 1]) {
      const a = ang + side * (o.pinAng ?? 0.95) + R.r(-0.1, 0.1);
      const ex = px + Math.cos(a) * size, ey = py + Math.sin(a) * size + size * (o.pinDroop ?? 0.25);
      const mx = lerp(px, ex, 0.5) + Math.cos(ang) * size * 0.12, my = lerp(py, ey, 0.5) + Math.sin(ang) * size * 0.12;
      const ptone = tone * R.r(0.72, 1) * (1 - 0.3 * u);
      stroke(buf, [[px, py, 0.9], [mx, my, 1], [ex, ey, 0.2]], { w: Math.max(1.3, size * (o.pinW ?? 0.36)), tone: ptone, dry: 0.06 + 0.25 * u, dryEnd: 0.4 + 0.3 * u,
        tail: 0.55, head: 0.15, headMin: 0.6, halo: 1, haloK: 0.3, seed: sd * 100 + k * 2 + (side > 0 ? 1 : 0), ...tt });
      // 细裂的小羽片：沿小叶两侧一串小点，叶缘就碎了（蕨的「花边」，和棕榈叶的一条条不同）
      if (o.lacy && size > 7) {
        const nP = Math.min(6, Math.round(size / 6));
        const qx = Math.cos(a + Math.PI / 2), qy = Math.sin(a + Math.PI / 2);
        for (let j = 1; j <= nP; j++) {
          const t = j / (nP + 1), sgn = j % 2 ? 1 : -1;
          const bx = lerp(px, ex, t) + qx * sgn * size * 0.16, by = lerp(py, ey, t) + qy * sgn * size * 0.16 + size * 0.04;
          dot(buf, bx, by, Math.max(0.9, size * 0.1 * (1 - 0.5 * t)), { ax: 1.6, ang: a + sgn * 0.6, tone: ptone * 0.9, jag: 0.25, rim: 0.2, halo: 0.6, seed: sd * 1000 + k * 20 + j * 2 + (side > 0 ? 1 : 0), ...tt });
        }
      }
    }
  }
}
function frondPath(x, y, a, len, droop, curl) {
  const pts = [];
  for (let k = 0; k <= 8; k++) {
    const u = k / 8;
    const aa = a + curl * u;
    pts.push([x + Math.cos(aa) * len * u, y + Math.sin(aa) * len * u + droop * len * u * u, 1 - 0.75 * u]);
  }
  return pts;
}

/** 蕨的幼叶（拳卷）：一根小梗顶着一个螺旋 */
function crozier(buf, x, y, r, ang, tone, sd, tt) {
  const pts = [];
  const cx = x + Math.cos(ang) * r * 2.2, cy = y + Math.sin(ang) * r * 2.2;
  pts.push([x, y, 1]);
  for (let k = 0; k <= 14; k++) {
    const th = (k / 14) * Math.PI * 2.1;
    const rr = r * (1 - th / (Math.PI * 2.6));
    const a = ang + Math.PI + th;
    pts.push([cx + Math.cos(a) * rr + Math.cos(ang) * r, cy + Math.sin(a) * rr + Math.sin(ang) * r, 1 - 0.5 * k / 14]);
  }
  stroke(buf, pts, { w: Math.max(1.2, r * 0.45), tone, dry: 0.1, tail: 0.3, head: 0.1, seed: sd, ...tt });
}

/**
 * 树蕨（桫椤）：粗而毛的干（叶痕交错、冠下挂一圈枯叶）；冠是一把伞——大羽叶先斜向上、再向外、叶梢垂下，
 * 小叶短而密、叶缘细碎；冠心几支拳卷的幼叶。干矮冠大，和棕榈（干高细、叶一条条）分开。
 */
export function treeFern2(buf, x, y, h, o = {}) {
  if (!buf) return;
  const seed = o.seed ?? 1, R = rng(seed * 31 + 9), tone = o.tone ?? 0.8, T = o.tw;
  const lean = (o.lean ?? R.r(-0.2, 0.2)) * 0.45;
  const th = h * 0.6, tW = h * 0.062;
  const tp = [[x, y, 1.12], [x + lean * th * 0.25 + R.r(-0.02, 0.02) * h, y - th * 0.35, 1], [x + lean * th * 0.65, y - th * 0.7, 0.96], [x + lean * th, y - th, 1.06]];
  stroke(buf, tp, { w: tW, tone: tone * 0.78, dry: 0.5, dryEnd: 0.5, rough: 0.25, fray: 1.2, shade: 0.5, halo: 1.2, head: 0.05, tail: 0.06, tailMode: 'round', seed: seed * 3 + 1, ...twin(T, 0, 0.25) });
  // 叶痕：干上交错的深墨小点（上密下疏）
  // 交错排（不成对，免得像梯子横档），大小、斜向都不齐
  const nb = Math.max(6, Math.round(th / (tW * 0.45)));
  for (let i = 0; i < nb; i++) {
    const u = Math.pow((i + R.r(0.1, 0.9)) / nb, 0.8);
    const [px, py] = along(tp, u);
    const c = (i % 2 ? 0.24 : -0.26) + R.r(-0.12, 0.12);
    if (R.f() < 0.15) continue;
    dot(buf, px + c * tW, py + R.r(-2, 2), tW * R.r(0.07, 0.15), { ax: R.r(1.3, 2.2), ang: (i % 2 ? 0.5 : -0.5) + R.r(-0.3, 0.3), tone: tone * R.r(0.75, 1), jag: 0.35, rim: 0.3, halo: 0.6, seed: seed * 50 + i, ...twin(T, 0.12, 0.3) });
  }
  const tx = tp[3][0], ty = tp[3][1];
  // 冠下一圈枯叶，像裙
  for (let i = 0; i < 7; i++) {
    const sgn = (i - 3) / 3, l = h * R.r(0.14, 0.24);
    stroke(buf, [[tx + sgn * tW * 0.6, ty + tW * 0.3, 0.8], [tx + sgn * (tW + h * 0.05), ty + l * 0.45, 0.6], [tx + sgn * (tW + h * 0.07) + R.r(-3, 3), ty + l, 0.1]],
      { w: h * 0.014, tone: tone * 0.42, dry: 0.45, dryEnd: 0.8, tail: 0.5, seed: seed * 70 + i, ...twin(T, 0.2, 0.35) });
  }
  // 冠：后层淡、前层浓
  const layers = [{ n: 6, k: 0.45, d: 0.12 }, { n: o.fronds ?? 10, k: 1, d: 0 }];
  let fi = 0;
  for (const ly of layers) {
    for (let f = 0; f < ly.n; f++) {
      const v = ly.n > 1 ? f / (ly.n - 1) : 0.5, side = v < 0.5 ? -1 : 1, kc = Math.abs(v - 0.5) * 2;
      const a0 = -Math.PI / 2 + side * (0.3 + 1.05 * kc) + R.r(-0.1, 0.1) + ly.d * (f % 2 ? 1 : -1);
      const len = h * R.r(0.48, 0.62) * (0.8 + 0.3 * kc);
      const pts = frondPath(tx, ty - h * 0.01, a0, len, 0.22 + 0.45 * kc, side * R.r(0.25, 0.45));
      frond(buf, pts, len, { tone: tone * ly.k * (0.8 + 0.2 * (1 - kc)), lw: 0.1, axW: Math.max(1.2, h * 0.008), pinnae: 28, pinW: 0.6, pinAng: 1.25, pinDroop: 0.3, lacy: true }, R, seed * 20 + fi++,
        twin(T, 0.25 + 0.3 * (1 - kc), 0.6 + 0.4 * (1 - kc * 0.5)));
    }
  }
  // 冠心拳卷的幼叶
  const nc = o.croziers ?? 3;
  for (let i = 0; i < nc; i++) {
    const a = -Math.PI / 2 + (i - (nc - 1) / 2) * 0.5 + R.r(-0.15, 0.15);
    crozier(buf, tx + Math.cos(a) * h * 0.04, ty + Math.sin(a) * h * 0.04, h * R.r(0.026, 0.034), a, tone * 0.95, seed * 90 + i, twin(T, 0.8, 1));
  }
}

/** 苏铁：粗矮的鳞干 + 一冠硬挺拱出的羽叶 */
export function cycad2(buf, x, y, h, o = {}) {
  if (!buf) return;
  const seed = o.seed ?? 1, R = rng(seed * 29 + 3), tone = o.tone ?? 0.8, T = o.tw;
  const th = h * R.r(0.3, 0.42), tw = h * 0.2;
  // 干：一笔宽的侧锋，带飞白 + 一层淡墨
  stroke(buf, [[x, y, 1], [x + R.r(-2, 2), y - th * 0.5, 0.98], [x + R.r(-3, 3), y - th, 0.9]], { w: tw, tone: tone * 0.7, dry: 0.5, dryEnd: 0.6, rough: 0.2, fray: 1, shade: 0.5, tailMode: 'round', tail: 0.15, head: 0.1,
    seed: seed * 3, ...twin(T, 0, 0.3) });
  // 鳞：菱形格的深墨小勾
  const rows = Math.max(3, Math.round(th / (h * 0.045)));
  for (let r = 0; r < rows; r++) {
    const yy = y - th * (r + 0.5) / rows;
    for (let c = -1; c <= 1; c++) {
      const xx = x + c * tw * 0.3 + (r % 2) * tw * 0.15;
      stroke(buf, [[xx - tw * 0.12, yy - h * 0.01, 0.7], [xx, yy + h * 0.008, 1], [xx + tw * 0.12, yy - h * 0.01, 0.5]], { w: Math.max(1.1, h * 0.011), tone: tone * R.r(0.8, 1), tail: 0.4, seed: seed * 50 + r * 3 + c + 1, ...twin(T, 0.2, 0.35) });
    }
  }
  const tx = x, ty = y - th;
  const n = o.leaves ?? 11;
  for (let f = 0; f < n; f++) {
    const v = f / (n - 1);
    const a = -Math.PI / 2 + (v - 0.5) * 3.05 + R.r(-0.08, 0.08);
    const horiz = Math.abs(Math.cos(a));
    const len = h * R.r(0.5, 0.68) * (0.8 + 0.3 * horiz);
    const pts = frondPath(tx, ty, a, len, 0.12 + 0.4 * horiz, Math.sign(Math.cos(a)) * 0.08);
    const k = Math.abs(v - 0.5) * 2;
    frond(buf, pts, len, { tone: tone * (0.85 + 0.15 * (1 - k)), lw: 0.12, axW: h * 0.014, pinnae: 15, pinW: 0.34, pinAng: 0.7, pinDroop: 0.05 }, R, seed * 20 + f, twin(T, 0.3 + 0.3 * (1 - k), 0.6 + 0.4 * (1 - k * 0.5)));
  }
}

/** 地上的蕨丛：五七片羽叶从一处拱出去 */
export function fern2(buf, x, y, s, o = {}) {
  if (!buf) return;
  const seed = o.seed ?? 1, R = rng(seed * 23 + 7), tone = o.tone ?? 0.7, T = o.tw;
  const n = o.fronds ?? 10;
  for (let f = 0; f < n; f++) {
    const v = f / (n - 1);
    const a = -Math.PI / 2 + (v - 0.5) * (o.spread ?? 2.6) + R.r(-0.15, 0.15);
    const horiz = Math.abs(Math.cos(a));
    const len = s * R.r(0.65, 1.05) * (0.8 + 0.3 * horiz);
    const pts = frondPath(x + R.r(-0.06, 0.06) * s, y, a, len, 0.12 + 0.3 * horiz, Math.sign(Math.cos(a)) * R.r(0.15, 0.4));
    frond(buf, pts, len, { tone: tone * R.r(0.7, 1) * (f % 3 === 0 ? 0.7 : 1), lw: 0.13, axW: Math.max(1.1, s * 0.014), pinnae: 20, pinW: 0.6, pinAng: 1.15, pinDroop: 0.2, lacy: true }, R, seed * 30 + f, twin(T, v * 0.4, 0.6 + v * 0.4));
  }
  if (o.croziers) for (let i = 0; i < o.croziers; i++) crozier(buf, x + R.r(-0.1, 0.1) * s, y - s * R.r(0.15, 0.3), s * 0.05, -Math.PI / 2 + R.r(-0.5, 0.5), tone, seed * 40 + i, twin(T, 0.8, 1));
}

/** 木贼：一丛带节的直茎 */
export function horsetail(buf, x, y, h, n, o = {}) {
  if (!buf) return;
  const seed = o.seed ?? 1, R = rng(seed * 19 + 1), tone = o.tone ?? 0.7, T = o.tw;
  for (let i = 0; i < n; i++) {
    const xx = x + R.r(-1, 1) * (o.spread ?? h * 0.25), hh = h * R.r(0.5, 1.1);
    const lean = R.r(-0.12, 0.12) * hh;
    const tn = tone * R.r(0.65, 1);
    const pts = [[xx, y, 1], [xx + lean * 0.35, y - hh * 0.5, 0.95], [xx + lean, y - hh, 0.45]];
    stroke(buf, pts, { w: Math.max(1.6, h * 0.022), tone: tn * 0.85, dry: 0.15, dryEnd: 0.45, tail: 0.3, seed: seed * 100 + i, ...twin(T, 0, 0.6) });
    const nn = Math.round(hh / (h * 0.11));
    for (let j = 1; j < nn; j++) {
      const u = j / nn;
      const px = xx + lean * u * u * 0.8 + lean * u * 0.2, py = y - hh * u;
      stroke(buf, [[px - h * 0.018, py + 0.5, 0.8], [px + h * 0.018, py - 0.5, 1]], { w: Math.max(1.2, h * 0.014), tone: Math.min(0.97, tn * 1.2), tail: 0.2, head: 0.1, seed: seed * 300 + i * 20 + j, ...twin(T, 0.5, 0.8) });
      if (o.whorls !== false && u < 0.85) for (const s of [-1, 1]) {
        const l = h * R.r(0.05, 0.09) * (1 - u * 0.6);
        stroke(buf, [[px, py, 0.9], [px + s * l * 0.7, py + l * 0.35, 0.5], [px + s * l, py + l * 0.9, 0.1]], { w: Math.max(0.9, h * 0.008), tone: tn * 0.8, tail: 0.6, seed: seed * 500 + i * 40 + j * 2 + (s > 0 ? 1 : 0), ...twin(T, 0.6, 1) });
      }
    }
  }
}

/** 芦苇：细长的弧 + 披下的叶 */
export function reeds2(buf, x, y, n, h, o = {}) {
  if (!buf) return;
  const seed = o.seed ?? 1, R = rng(seed * 19 + 7), tone = o.tone ?? 0.6, T = o.tw;
  for (let i = 0; i < n; i++) {
    const xx = x + R.r(-1, 1) * (o.spread ?? 30), hh = h * R.r(0.55, 1.1);
    const lean = (R.r(-0.1, 0.25) + (o.wind ?? 0.1)) * hh;
    const tn = tone * R.r(0.6, 1.05);
    stroke(buf, [[xx, y, 1], [xx + lean * 0.3, y - hh * 0.5, 0.8], [xx + lean, y - hh, 0.15]], { w: R.r(1.2, 2.1), tone: tn, dry: 0.1, dryEnd: 0.45, tail: 0.5, seed: seed * 100 + i, ...twin(T, 0, 0.6) });
    const nl = R.i(1, 3);
    for (let j = 0; j < nl; j++) {
      const u = R.r(0.2, 0.7), bx = xx + lean * u * u, by = y - hh * u, side = R.f() < 0.5 ? -1 : 1;
      const ll = hh * R.r(0.25, 0.45);
      stroke(buf, [[bx, by, 0.9], [bx + side * ll * 0.45, by - ll * 0.25, 1], [bx + side * ll, by + ll * R.r(0, 0.35), 0.1]], { w: R.r(2, 3.4), tone: tn * 0.9, tail: 0.6, head: 0.2, seed: seed * 700 + i * 5 + j, ...twin(T, 0.4, 1) });
    }
  }
}
