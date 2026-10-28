// S2 长卷的山水骨架：积墨山（中景）、远山积染、米点云山、雪山（以墨留白）、岸
// 约定同 motifs.js：第一个参数是 InkBuf（null 直接返回），世界坐标；o.tw = {t0, t1} 时记录到达时间（现场生长）。
import { stroke, wash, dot, rng, vn1, vn2, fbn, ridge, ridgeYAt } from '../../film/ink.js';

const lerp = (a, b, t) => a + (b - a) * t;
const cl = (x, a, b) => (x < a ? a : x > b ? b : x);
const cl01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ss = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------
// 积墨山（中景）：几重山，一重一重湿墨染出来（后淡前深、各自山脚没进雾里），
// 每重山脊一道干笔（断续、有短皴往下挂），峰的阴面再压一遍墨，脊上焦墨苔点与小树
// ---------------------------------------------------------------------------
export function layerMountain(buf, x0, x1, baseY, H, o = {}) {
  const seed = o.seed ?? 1, G = rng(seed * 59 + 17), R = rng(seed * 61 + 29), tone = o.tone ?? 0.6, T = o.tw;
  const nL = o.layers ?? 3;
  const W = x1 - x0;
  const D = T ? T.t1 - T.t0 : 0;
  // 先定形（与画不画无关，蒙版那一遍也要用同样的形）
  const geo = [];
  for (let li = 0; li < nL; li++) {
    const k = nL > 1 ? li / (nL - 1) : 1;                 // 0 最后（高、淡）… 1 最前（低、深）
    const lx0 = x0 + W * (li === 0 ? 0 : G.r(-0.05, 0.25)), lx1 = x1 - W * (li === 0 ? 0 : G.r(-0.05, 0.25));
    const hh = H * lerp(1, o.frontK ?? 0.42, k) * G.r(0.88, 1.05);
    const by = baseY + k * H * (o.drop ?? 0.08);
    const rg = ridge(lx0, lx1, by, hh, { seed: seed * 11 + li, peaks: o.peaks ?? (2 + (li % 2)), rough: o.rough ?? 8, sharp: o.sharp ?? 0.55, step: 4 });
    geo.push({ k, lx0, lx1, hh, by, rg, ph: G.f() * 100 });
  }
  const out = geo.map((g) => g.rg);
  // 外轮廓（各重山的上包络）与雾线，给「留白」用
  const sil = [];
  for (let x = x0 - W * 0.05; x <= x1 + W * 0.05; x += 6) {
    let top = 1e9;
    for (const rg of out) if (x >= rg[0][0] && x <= rg[rg.length - 1][0]) top = Math.min(top, ridgeYAt(rg, x));
    if (top < 1e9) sil.push([x, top]);
  }
  if (sil.length) sil.push([sil[sil.length - 1][0], baseY + 4], [sil[0][0], baseY + 4]);
  out.silhouette = sil;
  out.mistFade = (wx, wy) => 1 - ss(baseY - H * (o.mist ?? 0.32) * 0.9, baseY, wy);
  if (!buf) return out;
  for (let li = 0; li < nL; li++) {
    const { k, lx0, lx1, hh, by, rg, ph } = geo[li];
    const mistY = (wx) => by - hh * (o.mist ?? 0.32) * (0.5 + 0.9 * vn1(wx * 0.0032 + ph));
    const fog = (wx, wy) => 1 - ss(mistY(wx) - hh * 0.08, by + 4, wy);
    const lt = T ? (a, b) => ({ t0: T.t0 + D * (li / nL + a / nL), t1: T.t0 + D * (li / nL + b / nL) }) : () => ({});
    // 生长次序：前面（低）的一重先出来
    const order = nL - 1 - li;
    const lt2 = T ? (a, b) => ({ t0: T.t0 + D * (order / nL + a / nL), t1: T.t0 + D * (order / nL + b / nL) }) : () => ({});
    void lt;
    const tn = tone * lerp(o.backK ?? 0.3, o.frontTone ?? 0.52, k);
    // 染：山顶实、往下化进雾；带墨晕与颗粒
    wash(buf, [...rg, [lx1, by + 20], [lx0, by + 20]], { tone: tn, gfn: (wx, wy) => fog(wx, wy) * (0.78 + 0.22 * fbn(wx * 0.01 + li, wy * 0.01)) * (1 + 0.3 * Math.exp(-(wy - ridgeYAt(rg, wx)) / 6)),
      soft: 1.2, rim: 0.7, rimW: 2.2, jag: 1.4, jagScale: 12, bleed: 2.5, bleedK: 0.55, gran: 0.55, bloom: 0.5, bloomScale: 45, seed: seed * 13 + li,
      ...(T ? { ...lt2(0, 0.7), tfn: (wx, wy) => cl01((by - wy) / Math.max(8, by - ridgeYAt(rg, wx))) * (0.85 + 0.15 * vn1(wx * 0.02 + li)) } : {}) });
    // 峰的阴面：再压一遍（右侧）
    const peaks = [];
    for (let i = 3; i < rg.length - 3; i++) if (rg[i][1] < rg[i - 3][1] && rg[i][1] <= rg[i + 3][1] && by - rg[i][1] > hh * 0.4) peaks.push(rg[i]);
    peaks.forEach(([px, py], pi) => {
      const ph2 = by - py;
      const side = o.lightFrom === 'right' ? -1 : 1;
      const pts = [[px, py + 1]];
      for (let s2 = 1; s2 <= 8; s2++) { const u = s2 / 8; const wx = px + side * ph2 * 0.9 * u; pts.push([wx, Math.max(ridgeYAt(rg, wx) + 1, py + ph2 * 0.02 * u)]); }
      pts.push([px + side * ph2 * 0.7, py + ph2 * 0.62], [px + side * ph2 * 0.15, py + ph2 * 0.58], [px - side * ph2 * 0.04, py + ph2 * 0.3]);
      wash(buf, pts, { tone: tn * (o.shadowK ?? 0.4), gfn: (wx, wy) => fog(wx, wy) * (1 - ss(py + ph2 * 0.25, py + ph2 * 0.62, wy)), soft: 2, rim: 0.45, rimW: 2, jag: 2.2, jagScale: 9, bleed: 2, bleedK: 0.5, gran: 0.55, bloom: 0.5, bloomScale: 25,
        seed: seed * 200 + li * 10 + pi, ...(T ? { ...lt2(0.45, 0.85), tfn: (wx, wy) => cl01((by - wy) / Math.max(8, by - ridgeYAt(rg, wx))) } : {}) });
    });
    // 脊：干笔断续 + 往下挂的短皴
    const lw = o.lineW ?? cl(hh * 0.009, 1.6, 4);
    let i = 0;
    while (i < rg.length - 3) {
      const n = R.i(6, 16);
      const seg = [];
      for (let j = i; j < Math.min(rg.length, i + n); j += 2) {
        const [wx, wy] = rg[j];
        if (fog(wx, wy) < 0.35) break;
        seg.push([wx, wy + 1 + R.r(-0.4, 0.8), 0.4 + 0.6 * vn1(j * 0.5 + li * 7)]);
      }
      const gap = R.f() < 0.35;
      if (seg.length >= 2 && !gap) {
        const kk = cl01((by - seg[0][1]) / hh);
        stroke(buf, seg, { w: lw * R.r(0.7, 1.3), tone: Math.min(0.95, tn * R.r(1.5, 2.1)), dry: 0.35, dryEnd: 0.75, rough: 0.1, fray: 0.6, halo: 1.3, head: 0.1, tail: 0.35, seed: seed * 700 + li * 97 + i,
          ...(T ? lt2(0.3 + 0.5 * kk, 0.45 + 0.5 * kk) : {}) });
      }
      i += n + R.i(0, 3);
    }
    const nc = Math.round((lx1 - lx0) / (o.cunGap ?? 12) * (o.cunK ?? 1));
    for (let j = 0; j < nc; j++) {
      const wx = lerp(lx0, lx1, R.r(0.02, 0.98));
      const top = ridgeYAt(rg, wx);
      const sy = top + R.r(1, 6) + Math.pow(R.f(), 2) * hh * 0.35;
      if (fog(wx, sy) < 0.4) continue;
      const sl = (ridgeYAt(rg, wx + 5) - ridgeYAt(rg, wx - 5)) / 10;
      const ang = cl(sl, -1.2, 1.2) * 0.6 + R.r(-0.15, 0.15);
      const l = hh * R.r(0.03, 0.12);
      const kk = cl01((by - sy) / hh);
      stroke(buf, [[wx, sy, 0.8], [wx + Math.sin(ang) * l * 0.5, sy + Math.cos(ang) * l * 0.5, 1], [wx + Math.sin(ang) * l, sy + Math.cos(ang) * l, 0.3]], { w: lw * R.r(0.5, 0.9), tone: Math.min(0.9, tn * R.r(1.1, 1.7)) * fog(wx, sy),
        dry: 0.45, dryEnd: 0.85, rough: 0.08, fray: 0.5, head: 0.1, tail: 0.5, seed: seed * 900 + li * 131 + j, ...(T ? lt2(0.5 + 0.4 * kk, 0.6 + 0.4 * kk) : {}) });
    }
    // 苔点：成簇
    const nm = Math.round((lx1 - lx0) / 60 * (o.mossK ?? 1) * (0.4 + 0.6 * k));
    for (let j = 0; j < nm; j++) {
      const wx = lerp(lx0, lx1, R.r(0.03, 0.97)), wy = ridgeYAt(rg, wx) + R.r(0, 5);
      if (fog(wx, wy) < 0.5) continue;
      const nd = R.i(2, 5);
      for (let d = 0; d < nd; d++) dot(buf, wx + R.r(-7, 7), wy + R.r(-1, 3.5), R.r(1.3, 2.6) * (o.mossScale ?? 1), { ax: R.r(1.3, 2.1), ang: R.r(-0.3, 0.3), tone: R.r(0.72, 0.92) * Math.min(1, tone * 1.6), halo: 1.1, seed: seed * 1300 + li * 211 + j * 7 + d, ...(T ? lt2(0.85, 1) : {}) });
    }
    const nt = Math.round((o.ridgeTrees ?? 0) * (0.3 + 0.7 * k));
    for (let j = 0; j < nt; j++) {
      const wx = lerp(lx0, lx1, R.r(0.08, 0.92)), wy = ridgeYAt(rg, wx);
      if (by - wy < hh * 0.35) continue;
      tinyTree(buf, wx, wy + 2, hh * R.r(0.04, 0.075), { tone: Math.min(0.95, tn * 2.2), seed: seed * 1700 + li * 31 + j, ...(T ? { tw: lt2(0.85, 1) } : {}) });
    }
  }
  return out;
}

/** 山脊上的小树（几笔）：一竖 + 一簇点 */
export function tinyTree(buf, x, y, h, o = {}) {
  if (!buf) return;
  const R = rng((o.seed ?? 1) * 13 + 3), tone = o.tone ?? 0.85, T = o.tw;
  const tt = T ? { t0: T.t0, t1: T.t1 } : {};
  const lean = R.r(-0.15, 0.15) * h;
  stroke(buf, [[x, y, 1], [x + lean * 0.5, y - h * 0.5, 0.8], [x + lean, y - h, 0.3]], { w: Math.max(1.1, h * 0.09), tone, dry: 0.2, tail: 0.4, seed: (o.seed ?? 1) * 3, ...tt });
  const nd = R.i(4, 8);
  for (let i = 0; i < nd; i++) {
    const u = R.r(0.35, 1);
    dot(buf, x + lean * u + R.r(-0.25, 0.25) * h, y - h * u + R.r(-0.08, 0.08) * h, Math.max(1, h * R.r(0.06, 0.1)), { ax: R.r(1.2, 1.9), ang: R.r(-0.4, 0.4), tone: tone * R.r(0.8, 1), halo: 1, seed: (o.seed ?? 1) * 50 + i, ...tt });
  }
}

// ---------------------------------------------------------------------------
// 远山：淡墨一层层积染；山顶一道湿边，山腰有雾带断开，山脚没进雾里（不是渐变色块）
// ---------------------------------------------------------------------------
export function farRange(buf, x0, x1, baseY, h, o = {}) {
  if (!buf) return;
  const seed = o.seed ?? 1, R = rng(seed * 7 + 1);
  const layers = o.layers ?? 3;
  const tone = o.tone ?? 0.22;
  for (let i = 0; i < layers; i++) {
    const k = layers > 1 ? i / (layers - 1) : 1;            // 0 最远（高、淡）… 1 最近（低、深）
    const w = x1 - x0;
    const lx0 = x0 + w * R.r(0, 0.18) * (i > 0 ? 1 : 0), lx1 = x1 - w * R.r(0, 0.18) * (i > 0 ? 1 : 0);
    const hh = h * lerp(1, 0.55, k) * R.r(0.85, 1.08);
    const by = baseY + k * h * 0.12;
    const rg = ridge(lx0, lx1, by, hh, { seed: seed * 7 + i, peaks: o.peaks ?? 3 + i, rough: o.rough ?? 9, sharp: o.sharp ?? 0.5, step: 5 });
    const ph = R.f() * 100;
    const mistY = (wx) => by - hh * (0.25 + 0.4 * vn1(wx * 0.0028 + ph));
    const cutY = (wx) => by - hh * (0.52 + 0.2 * (vn1(wx * 0.0021 + ph * 2) - 0.5));
    const hasCut = o.cuts ?? R.f() < 0.6;
    const gfn = (wx, wy) => {
      const top = ridgeYAt(rg, wx);
      let g = 1 - ss(mistY(wx) - hh * 0.12, mistY(wx) + hh * 0.2, wy);
      if (hasCut) { const c = (wy - cutY(wx)) / (hh * 0.07); g *= 1 - 0.7 * Math.exp(-c * c) * vn1(wx * 0.004 + ph); }
      g *= 0.82 + 0.18 * fbn(wx * 0.012, wy * 0.012);
      g *= 1 + 0.35 * Math.exp(-(wy - top) / 5);
      return g;
    };
    wash(buf, [...rg, [lx1, by + 30], [lx0, by + 30]], {
      tone: tone * lerp(0.5, 1, k) * (o.k0 ?? 1), gfn, soft: 1.2, rim: 0.65, rimW: 2.2, jag: 1.3, jagScale: 14, bleed: 2.5, bleedK: 0.55,
      gran: 0.55, bloom: 0.38, bloomScale: 70, seed: seed * 13 + i, ...(o.tw ? { t0: o.tw.t0 + (o.tw.t1 - o.tw.t0) * k * 0.5, t1: o.tw.t0 + (o.tw.t1 - o.tw.t0) * (0.5 + k * 0.5) } : {}),
    });
    // 最近一层山顶偶尔几点淡树
    if (o.dots && i === layers - 1) {
      const nd = Math.round((lx1 - lx0) / 60);
      for (let j = 0; j < nd; j++) {
        const wx = lerp(lx0, lx1, R.r(0.05, 0.95)), wy = ridgeYAt(rg, wx) + R.r(0, 4);
        dot(buf, wx, wy, R.r(1.6, 3), { ax: R.r(1.2, 2), tone: tone * 1.4, halo: 1.2, seed: seed * 900 + j });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 米点云山（宋·米氏）：淡墨底 + 三遍横点（淡大 → 中 → 浓小），点顺着山势成行，山腰雾断
// ---------------------------------------------------------------------------
export function miMountain(buf, x0, x1, baseY, h, o = {}) {
  if (!buf) return null;
  const seed = o.seed ?? 1, R = rng(seed * 3 + 1), tone = o.tone ?? 0.5, T = o.tw;
  const rg = o.ridge || ridge(x0, x1, baseY, h, { seed, peaks: o.peaks ?? 3, rough: o.rough ?? 5, sharp: o.sharp ?? 0.35, step: 5 });
  const fadeH = o.fadeH ?? 0.6;
  const ph = R.f() * 100;
  const depthK = (wx, wy) => { const ry = ridgeYAt(rg, wx); return (wy - ry) / Math.max(10, baseY - ry); };
  const fl = (wx) => fadeH * (0.7 + 0.6 * vn1(wx * 0.004 + ph));
  const fog = (wx, wy) => 1 - ss(fl(wx) - 0.25, fl(wx) + 0.08, depthK(wx, wy));
  wash(buf, [...rg, [x1, baseY + 20], [x0, baseY + 20]], { tone: tone * 0.26, gfn: (wx, wy) => fog(wx, wy) * (0.75 + 0.25 * fbn(wx * 0.01, wy * 0.01)), soft: 2.5, rim: 0.35, jag: 1.6, jagScale: 16,
    bleed: 3, gran: 0.55, bloom: 0.5, bloomScale: 45, seed: seed * 5, ...(T ? twin(T, 0, 0.4) : {}) });
  const sc = o.dotScale ?? 1;
  const area = (x1 - x0) * h * 0.5;
  // 三遍横点：淡而大（湿、化开）→ 中 → 浓而小（只在山脊一带）
  const passes = [
    { n: area / 300, r: [11, 18], tone: [0.14, 0.24], depth: 0.62, ax: [2.1, 2.8], soft: 0.7, w0: 0.2, w1: 0.6 },
    { n: area / 1100, r: [7, 11], tone: [0.26, 0.4], depth: 0.34, ax: [2.0, 2.6], soft: 0.4, w0: 0.45, w1: 0.8 },
    { n: area / 5000, r: [4.5, 7], tone: [0.5, 0.7], depth: 0.12, ax: [1.8, 2.3], soft: 0.1, w0: 0.7, w1: 1 },
  ];
  let di = 0;
  for (const ps of passes) {
    const n = Math.round(ps.n * (o.dots ?? 1));
    for (let i = 0; i < n; i++) {
      const wx = lerp(x0, x1, R.r(0.02, 0.98));
      const ry = ridgeYAt(rg, wx);
      if ((baseY - ry) < h * (ps.depth < 0.2 ? 0.55 : ps.depth < 0.5 ? 0.4 : 0.22)) continue;   // 低处（山脚的尾巴）不点，浓点只在高处
      const dk = Math.pow(R.f(), 1.3) * ps.depth;
      const wy = ry + 1.5 + dk * (baseY - ry);
      const f = fog(wx, wy);
      if (f < 0.15 || R.f() > f) continue;
      const slope = (ridgeYAt(rg, wx + 6) - ridgeYAt(rg, wx - 6)) / 12;
      const r = R.r(ps.r[0], ps.r[1]) * sc * (1 - 0.25 * dk);
      dot(buf, wx, wy, r * 0.45, { ax: R.r(ps.ax[0], ps.ax[1]), ang: Math.atan(slope) * 0.5 + R.r(-0.1, 0.1), tone: Math.min(0.97, tone * R.r(ps.tone[0], ps.tone[1]) * 1.6), jag: 0.3, rim: 0.35,
        soft: ps.soft * r * 0.45, halo: 1.8, haloK: 0.4, gran: 0.35, seed: seed * 10000 + di++, ...(T ? twin(T, ps.w0 + (ps.w1 - ps.w0) * (1 - dk / ps.depth) * 0.5, ps.w0 + (ps.w1 - ps.w0) * (0.5 + 0.5 * (1 - dk / ps.depth))) : {}) });
    }
  }
  const nt = o.trees ?? 0;
  for (let i = 0; i < nt; i++) {
    const wx = lerp(x0, x1, R.r(0.1, 0.9));
    tinyTree(buf, wx, ridgeYAt(rg, wx) + 3, R.r(12, 22) * sc, { tone: Math.min(0.95, tone * 1.6), seed: seed * 400 + i, ...(T ? { tw: twin(T, 0.9, 1) } : {}) });
  }
  return rg;
}

// ---------------------------------------------------------------------------
// 雪山（以墨留白）：天空染一层灰，把山的白「让」出来；山只勾轮廓、阴面极淡、几道冰裂
// ---------------------------------------------------------------------------
export function snowRange(buf, x0, x1, baseY, h, o = {}) {
  if (!buf) return null;
  const seed = o.seed ?? 1, R = rng(seed * 11 + 3), T = o.tw;
  // 两重山：后面的高而淡，前面的低而实
  const back = ridge(x0 + (x1 - x0) * 0.08, x1 - (x1 - x0) * 0.05, baseY - h * 0.1, h, { seed, peaks: o.peaks ?? 3, rough: o.rough ?? 12, sharp: o.sharp ?? 0.38, step: 4 });
  const front = ridge(x0 - (x1 - x0) * 0.05, x1 + (x1 - x0) * 0.08, baseY, h * 0.55, { seed: seed + 5, peaks: 4, rough: 14, sharp: 0.45, step: 4 });
  const topOf = (wx) => Math.min(ridgeYAt(back, wx), ridgeYAt(front, wx));
  const skyH = o.skyH ?? h * 0.9;
  const sx0 = x0 - (o.skyPad ?? 220), sx1 = x1 + (o.skyPad ?? 220);
  // 天：贴着山脊最深，往上化开（把雪山的白让出来）
  const sky = [[sx0, baseY - h * 1.05 - skyH], [sx1, baseY - h * 1.05 - skyH], [sx1, baseY - h * 0.1]];
  for (let x = sx1; x >= sx0; x -= 6) sky.push([x, Math.min(baseY - h * 0.1, topOf(x))]);
  sky.push([sx0, baseY - h * 0.1]);
  // 天的深浅只随高度变（贴着山的地方最深），不跟着每个山尖起落——否则会出一道道竖的「帘子」
  const horizon = baseY - h * 0.75;
  const gSky = (wx, wy) => {
    const ex = Math.min(ss(sx0, sx0 + 300, wx), 1 - ss(sx1 - 300, sx1, wx));
    const dd = horizon - wy;
    const ey = dd < 0 ? 1 : Math.exp(-dd / (skyH * 0.55));
    return ex * ey * (0.8 + 0.2 * fbn(wx * 0.005, wy * 0.006));
  };
  wash(buf, sky, { tone: o.skyTone ?? 0.24, gfn: gSky, soft: 1, rim: 0.25, rimW: 2, jag: 0.8, jagScale: 8, bleed: 1.5, bleedK: 0.4, gran: 0.6, bloom: 0.45, bloomScale: 80, streak: 0.1, streakAng: 0.05, seed: seed * 3, ...(T ? twin(T, 0, 0.5) : {}) });
  // 后山与前山之间的谷：一层极淡的墨
  const valley = [];
  for (let x = x0; x <= x1; x += 8) valley.push([x, ridgeYAt(back, x) + 4]);
  for (let x = x1; x >= x0; x -= 8) valley.push([x, ridgeYAt(front, x) + 2]);
  wash(buf, valley, { tone: 0.07, soft: 12, rim: 0.2, jag: 2, gran: 0.6, bloom: 0.5, seed: seed * 4, gfn: (wx, wy) => ss(ridgeYAt(back, wx), ridgeYAt(front, wx) + 10, wy), ...(T ? twin(T, 0.2, 0.6) : {}) });
  const outline = (rg, tone, w, k, sk) => {
    const nseg = Math.max(3, Math.round((rg[rg.length - 1][0] - rg[0][0]) / 110));
    for (let s = 0; s < nseg; s++) {
      if (R.f() < 0.15) continue;
      const a = Math.floor((s / nseg) * (rg.length - 1)), b = Math.min(rg.length - 1, Math.floor(((s + 1) / nseg) * (rg.length - 1)) - 1);
      const seg = [];
      for (let i = a; i <= b; i += 3) {
        const hidden = rg === back && ridgeYAt(front, rg[i][0]) < rg[i][1] + 2;
        if (hidden) break;
        seg.push([rg[i][0], rg[i][1] + 0.5, 0.45 + 0.55 * vn1(i * 0.3 + s + k)]);
      }
      if (seg.length > 1) stroke(buf, seg, { w: w * R.r(0.8, 1.2), tone, dry: 0.3, dryEnd: 0.72, rough: 0.08, fray: 0.5, halo: 1.2, seed: seed * 7 + s + k * 100, ...(T ? twin(T, sk + 0.3 * s / nseg, sk + 0.1 + 0.3 * s / nseg) : {}) });
    }
  };
  outline(back, 0.42, (o.lineW ?? 2.6) * 0.85, 1, 0.2);
  outline(front, 0.66, o.lineW ?? 2.6, 2, 0.35);
  // 露出雪面的山石：陡处挂不住雪，顺坡几笔焦墨干笔（成组，贴着脊线往下）
  const rocks = o.rocks ?? Math.round((x1 - x0) / 70);
  for (let i = 0; i < rocks; i++) {
    const useF = R.f() < 0.55;
    const rg = useF ? front : back;
    const wx = lerp(x0, x1, R.r(0.05, 0.95));
    const ty = ridgeYAt(rg, wx);
    if (!useF && ridgeYAt(front, wx) < ty + 20) continue;
    const sl = (ridgeYAt(rg, wx + 6) - ridgeYAt(rg, wx - 6)) / 12;
    if (Math.abs(sl) < 0.35) continue;                      // 只在陡坡
    const dir = sl > 0 ? 1 : -1;
    const yy = ty + R.r(2, 12);
    const l = R.r(18, 46) * (useF ? 1 : 0.7);
    const tn = useF ? R.r(0.5, 0.8) : R.r(0.3, 0.45);
    const n = R.i(1, 3);
    for (let j = 0; j < n; j++) {
      const ox = j * R.r(4, 8) * -dir, oy = j * R.r(3, 7);
      const ang = Math.atan(Math.abs(sl)) * 0.8;
      const ex = wx + ox + dir * Math.cos(ang) * l * 0.5, ey = yy + oy + Math.sin(ang) * l;
      stroke(buf, [[wx + ox, yy + oy, 1], [lerp(wx + ox, ex, 0.5), lerp(yy + oy, ey, 0.5), 0.8], [ex, ey, 0.2]], { w: R.r(2.2, 4.5) * (useF ? 1 : 0.7), tone: tn, dry: 0.5, dryEnd: 0.85, rough: 0.15, fray: 0.8, head: 0.05, tail: 0.5,
        seed: seed * 90 + i * 5 + j, ...(T ? twin(T, 0.6, 0.85) : {}) });
    }
  }
  // 冰舌：从谷里流到山脚的一道白，两侧淡线
  if (o.tongue) {
    const [tx, tw2] = o.tongue;
    for (const s of [-1, 1]) {
      const pts = [];
      for (let k = 0; k <= 6; k++) { const v = k / 6; pts.push([tx + s * tw2 * (0.35 + 0.65 * v) + (vn1(v * 3 + s) - 0.5) * 8, lerp(ridgeYAt(front, tx) + 10, baseY + 8, v), 0.5 + 0.5 * v]); }
      stroke(buf, pts, { w: 2.2, tone: 0.45, dry: 0.35, dryEnd: 0.7, seed: seed * 120 + s, ...(T ? twin(T, 0.5, 0.75) : {}) });
    }
  }
  return { back, front, topOf };
}

// ---------------------------------------------------------------------------
// 岸：水线（断续的横笔）+ 岸上一抹地 + 偶尔伸进水里的沙洲 + 草点
// ---------------------------------------------------------------------------
export function shore(buf, x0, x1, y, o = {}) {
  if (!buf) return (x) => y;
  const seed = o.seed ?? 1, R = rng(seed * 17 + 5), tone = o.tone ?? 0.45, T = o.tw;
  const wave = o.wave ?? 12;
  const yAt = (x) => y + (vn1(x * 0.004 + seed) - 0.5) * wave + (vn1(x * 0.025 + seed * 3) - 0.5) * 3;
  const gh = o.gh ?? 24;
  if (o.ground !== false) {
    const top = [], bot = [];
    for (let x = x0; x <= x1; x += 16) { top.push([x, yAt(x) - gh * (0.4 + 0.9 * vn1(x * 0.008 + seed * 5))]); bot.push([x, yAt(x) + 1]); }
    wash(buf, [...top, ...bot.reverse()], { tone: tone * 0.3, gfn: (wx, wy) => ss(yAt(wx) - gh * 1.3, yAt(wx), wy), soft: 5, rim: 0.25, jag: 2, bleed: 2, gran: 0.55, bloom: 0.4, bloomScale: 40,
      seed: seed * 3, ...(T ? twin(T, 0, 0.4) : {}) });
  }
  let x = x0 + R.r(0, 30), i = 0;
  while (x < x1) {
    const len = R.r(80, 260);
    const pts = [];
    const xe = Math.min(x1, x + len);
    for (let k = 0; k <= 8; k++) { const xx = lerp(x, xe, k / 8); pts.push([xx, yAt(xx) + R.r(-0.8, 0.8), 0.45 + 0.55 * Math.sin((k / 8) * Math.PI)]); }
    const heavy = R.f() < (o.heavy ?? 0.3);
    stroke(buf, pts, { w: heavy ? R.r(4, 6.5) : R.r(2, 3.6), tone: tone * (heavy ? R.r(1.1, 1.4) : R.r(0.6, 1)), dry: R.r(0.15, 0.4), dryEnd: R.r(0.55, 0.9), halo: 1.8, haloK: 0.35, rough: 0.08,
      seed: seed * 100 + i, head: 0.12, tail: 0.35, ...(T ? twin(T, 0.15 + 0.6 * (x - x0) / (x1 - x0), 0.25 + 0.6 * (x - x0) / (x1 - x0)) : {}) });
    x = xe + R.r(8, 90);
    i++;
  }
  // 沙洲：一道弧伸进水里
  const ns = o.spits ?? 0;
  for (let j = 0; j < ns; j++) {
    const cx = lerp(x0, x1, (j + R.r(0.25, 0.75)) / ns), sw = R.r(120, 300), dy = R.r(10, 26);
    const pts = [];
    for (let k = 0; k <= 10; k++) { const u = k / 10; const xx = cx - sw / 2 + sw * u; pts.push([xx, yAt(xx) + Math.sin(u * Math.PI) * dy * (u < 0.5 ? 1 : 0.8), 0.4 + 0.6 * Math.sin(u * Math.PI)]); }
    stroke(buf, pts, { w: R.r(2, 3.4), tone: tone * 0.9, dry: 0.25, dryEnd: 0.7, halo: 1.6, seed: seed * 300 + j, tail: 0.4, ...(T ? twin(T, 0.5, 0.8) : {}) });
    wash(buf, [...pts.map((q) => [q[0], q[1] - 1]), [cx + sw / 2, yAt(cx) - 4], [cx - sw / 2, yAt(cx) - 4]], { tone: tone * 0.16, soft: 4, rim: 0.3, jag: 1.5, gran: 0.55, seed: seed * 310 + j, ...(T ? twin(T, 0.6, 0.9) : {}) });
    for (let k = 0; k < 4; k++) { const xx = cx + R.r(-0.35, 0.35) * sw; dot(buf, xx, yAt(xx) + R.r(-1, dy * 0.6), R.r(1.3, 2.4), { ax: R.r(1.5, 2.4), tone: tone * 1.5, seed: seed * 320 + j * 10 + k, ...(T ? twin(T, 0.85, 1) : {}) }); }
  }
  // 草点、小石
  const nd = o.grass ?? Math.round((x1 - x0) / 40);
  for (let k = 0; k < nd; k++) {
    const xx = lerp(x0, x1, R.f());
    const yy = yAt(xx) - R.r(0, 8);
    if (R.f() < 0.5) {
      const nb = R.i(2, 4);
      for (let j = 0; j < nb; j++) {
        const a = -Math.PI / 2 + R.r(-0.7, 0.7), l = R.r(5, 14);
        stroke(buf, [[xx + j * 2.2, yy, 1], [xx + j * 2.2 + Math.cos(a) * l * 0.5, yy + Math.sin(a) * l * 0.55, 0.7], [xx + j * 2.2 + Math.cos(a) * l, yy + Math.sin(a) * l, 0.15]],
          { w: 1.5, tone: tone * R.r(0.9, 1.5), seed: seed * 500 + k * 5 + j, tail: 0.6, ...(T ? twin(T, 0.7, 0.95) : {}) });
      }
    } else dot(buf, xx, yy + 2, R.r(1.4, 3), { ax: R.r(1.4, 2.4), tone: tone * R.r(1, 1.7), seed: seed * 700 + k, ...(T ? twin(T, 0.7, 0.95) : {}) });
  }
  return yAt;
}

/** 按时间窗切分 */
export function twin(o, a, b) {
  if (!o || o.t0 === undefined) return {};
  return { t0: o.t0 + (o.t1 - o.t0) * a, t1: o.t0 + (o.t1 - o.t0) * b };
}
void vn2;
