// 鱼的程序化几何：沿身体轴放样（截面是超椭圆），鳍是贴在身体上的网格。
// 所有顶点都存「身体坐标」aBody = (s, 横向米, 竖向米)，s 从吻尖 0 到尾尖 1；渲染时沿每帧算好的脊柱蒙皮。
// aNrm = 直身姿态下的局部法线 (前, 上, 左)。
import * as THREE from 'three';

// Catmull-Rom 插值一张按 s 排好的表
function table(rows, key) {
  const xs = rows.map((r) => r.s), ys = rows.map((r) => r[key]);
  return (s) => {
    if (s <= xs[0]) return ys[0];
    if (s >= xs[xs.length - 1]) return ys[ys.length - 1];
    let i = 0;
    while (s > xs[i + 1]) i++;
    const t = (s - xs[i]) / (xs[i + 1] - xs[i]);
    const y0 = ys[Math.max(0, i - 1)], y1 = ys[i], y2 = ys[i + 1], y3 = ys[Math.min(ys.length - 1, i + 2)];
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (2 * y1 + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
  };
}

// ---- 白鲟（Psephurus gladius）体形表，单位：全长 L 的比例 ----
// w 半宽，hu 上半高，hd 下半高，c 截面中心的竖向偏移（尾部上翘），n 超椭圆指数
export const PADDLEFISH_PROFILE = [
  { s: 0.000, w: 0.0015, hu: 0.0008, hd: 0.0008, c: 0.0000, n: 1.7 },
  { s: 0.020, w: 0.0060, hu: 0.0020, hd: 0.0018, c: 0.0000, n: 1.7 },
  { s: 0.070, w: 0.0115, hu: 0.0034, hd: 0.0030, c: 0.0000, n: 1.7 },
  { s: 0.140, w: 0.0175, hu: 0.0050, hd: 0.0044, c: 0.0002, n: 1.75 },
  { s: 0.210, w: 0.0232, hu: 0.0068, hd: 0.0060, c: 0.0006, n: 1.8 },
  { s: 0.265, w: 0.0290, hu: 0.0098, hd: 0.0085, c: 0.0012, n: 1.9 },
  { s: 0.300, w: 0.0335, hu: 0.0150, hd: 0.0130, c: 0.0020, n: 2.0 },
  { s: 0.330, w: 0.0400, hu: 0.0260, hd: 0.0230, c: 0.0035, n: 2.1 },
  { s: 0.370, w: 0.0470, hu: 0.0400, hd: 0.0370, c: 0.0050, n: 2.15 },
  { s: 0.420, w: 0.0530, hu: 0.0520, hd: 0.0480, c: 0.0055, n: 2.2 },
  { s: 0.480, w: 0.0565, hu: 0.0590, hd: 0.0555, c: 0.0050, n: 2.2 },
  { s: 0.550, w: 0.0560, hu: 0.0600, hd: 0.0570, c: 0.0045, n: 2.2 },
  { s: 0.620, w: 0.0510, hu: 0.0560, hd: 0.0530, c: 0.0045, n: 2.15 },
  { s: 0.700, w: 0.0420, hu: 0.0460, hd: 0.0440, c: 0.0050, n: 2.1 },
  { s: 0.780, w: 0.0300, hu: 0.0330, hd: 0.0310, c: 0.0065, n: 2.05 },
  { s: 0.850, w: 0.0175, hu: 0.0205, hd: 0.0185, c: 0.0100, n: 2.0 },
  { s: 0.900, w: 0.0115, hu: 0.0140, hd: 0.0120, c: 0.0165, n: 2.0 },
  { s: 0.950, w: 0.0070, hu: 0.0090, hd: 0.0070, c: 0.0270, n: 2.0 },
  { s: 1.000, w: 0.0015, hu: 0.0020, hd: 0.0015, c: 0.0420, n: 2.0 },
];

// ---- 老鲟（大型鲟，圆锥吻、五行骨板、四根须）----
export const STURGEON_PROFILE = [
  { s: 0.000, w: 0.0035, hu: 0.0020, hd: 0.0018, c: -0.005, n: 2.0 },
  { s: 0.030, w: 0.0130, hu: 0.0065, hd: 0.0055, c: -0.004, n: 2.0 },
  { s: 0.080, w: 0.0270, hu: 0.0150, hd: 0.0120, c: -0.002, n: 2.0 },
  { s: 0.140, w: 0.0400, hu: 0.0300, hd: 0.0250, c: 0.001, n: 2.1 },
  { s: 0.200, w: 0.0500, hu: 0.0450, hd: 0.0400, c: 0.003, n: 2.2 },
  { s: 0.280, w: 0.0590, hu: 0.0580, hd: 0.0520, c: 0.004, n: 2.4 },
  { s: 0.380, w: 0.0620, hu: 0.0650, hd: 0.0560, c: 0.004, n: 2.6 },
  { s: 0.480, w: 0.0590, hu: 0.0630, hd: 0.0540, c: 0.004, n: 2.6 },
  { s: 0.580, w: 0.0520, hu: 0.0560, hd: 0.0480, c: 0.004, n: 2.5 },
  { s: 0.680, w: 0.0400, hu: 0.0440, hd: 0.0380, c: 0.005, n: 2.4 },
  { s: 0.770, w: 0.0260, hu: 0.0300, hd: 0.0250, c: 0.008, n: 2.2 },
  { s: 0.840, w: 0.0150, hu: 0.0190, hd: 0.0150, c: 0.014, n: 2.1 },
  { s: 0.900, w: 0.0095, hu: 0.0120, hd: 0.0090, c: 0.026, n: 2.0 },
  { s: 0.950, w: 0.0060, hu: 0.0075, hd: 0.0055, c: 0.042, n: 2.0 },
  { s: 1.000, w: 0.0015, hu: 0.0020, hd: 0.0015, c: 0.062, n: 2.0 },
];

export function makeProfile(rows) {
  return { w: table(rows, 'w'), hu: table(rows, 'hu'), hd: table(rows, 'hd'), c: table(rows, 'c'), n: table(rows, 'n') };
}

const sgnpow = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);

/** 截面上的点（身体坐标，单位米）：theta 0 = 正上方，pi/2 = 左侧 */
export function sectionPoint(P, L, s, theta) {
  const n = P.n(s), e = 2 / n;
  const ct = Math.cos(theta), st = Math.sin(theta);
  const vert = (P.c(s) + (ct >= 0 ? P.hu(s) : P.hd(s)) * sgnpow(ct, e)) * L;
  const lat = P.w(s) * sgnpow(st, e) * L;
  return [lat, vert];
}

/**
 * 身体放样。返回 BufferGeometry：position（直身姿态，仅供包围盒/调试）、aBody、aNrm、uv、aPart
 * @param {object} P makeProfile 的结果
 * @param {number} L 全长（米）
 */
export function buildBody(P, L, { nS = 280, nT = 64, sPow = 1.0 } = {}) {
  const pos = [], body = [], nrm = [], uv = [], idx = [], sec = [];
  const ring = [];
  for (let i = 0; i <= nS; i++) {
    const u = i / nS;
    const s = Math.pow(u, sPow);
    const row = [];
    let arc = 0, prev = null;
    for (let j = 0; j <= nT; j++) {
      const th = (j / nT) * Math.PI * 2;
      const [lat, vert] = sectionPoint(P, L, s, th);
      const e = 2 / P.n(s);
      if (prev) arc += Math.hypot(lat - prev[0], vert - prev[1]);
      prev = [lat, vert];
      // 弧长以正上方为 0，左右对称（-半周..+半周）
      row.push([-s * L, vert, lat, s, th, sgnpow(Math.cos(th), e), sgnpow(Math.sin(th), e), arc]);
    }
    const half = row[row.length - 1][7] / 2;
    for (const r of row) r[7] = r[7] <= half ? r[7] : r[7] - 2 * half;
    ring.push(row);
  }
  // 有限差分求法线
  const at = (i, j) => ring[Math.max(0, Math.min(nS, i))][(j + nT) % nT];
  for (let i = 0; i <= nS; i++) {
    for (let j = 0; j <= nT; j++) {
      const p = ring[i][j];
      const a = at(i + 1, j), b = at(i - 1, j), c = at(i, j + 1), d = at(i, j - 1);
      const ds = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      const dt = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
      // 法线 = dt × ds（朝外）
      let nx = dt[1] * ds[2] - dt[2] * ds[1];
      let ny = dt[2] * ds[0] - dt[0] * ds[2];
      let nz = dt[0] * ds[1] - dt[1] * ds[0];
      let l = Math.hypot(nx, ny, nz);
      if (l < 1e-12) { // 两端收成一点：用轴向
        nx = i === 0 ? 1 : -1; ny = 0; nz = 0; l = 1;
      }
      nx /= l; ny /= l; nz /= l;
      // 确保朝外：与 (0, vert-c, lat) 同向
      const cx = 0, cy = p[1] - P.c(p[3]) * L, cz = p[2];
      if (nx * cx + ny * cy + nz * cz < 0 && (Math.abs(cy) + Math.abs(cz)) > 1e-6) { nx = -nx; ny = -ny; nz = -nz; }
      pos.push(p[0], p[1], p[2]);
      body.push(p[3], p[2], p[1]);
      nrm.push(nx, ny, nz);
      uv.push(p[3], j / nT);
      sec.push(p[5], p[6], p[7]);
    }
  }
  const W = nT + 1;
  for (let i = 0; i < nS; i++) {
    for (let j = 0; j < nT; j++) {
      const a = i * W + j, b = a + W, c = a + 1, d = b + 1;
      idx.push(a, b, c, c, b, d); // 朝外为正面（局部 x 前、y 上、z 横向构成右手系）
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBody', new THREE.Float32BufferAttribute(body, 3));
  g.setAttribute('aNrm', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aSec', new THREE.Float32BufferAttribute(sec, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1));
  g.setIndex(idx);
  return g;
}

/**
 * 把一块局部刚体（眼睛、信标、骨板、须）转成身体坐标几何。
 * pts: 局部直身坐标 [x前, y上, z横] 的顶点；nrms: 局部法线；part: 部件号；返回与身体相同属性的几何
 */
export function rigidPart(pts, nrms, idx, L, part) {
  const body = [], pos = [], nrm = [], uv = [], sec = [], parts = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, y, z] = pts[i];
    body.push(-x / L, z, y);
    pos.push(x, y, z);
    nrm.push(...nrms[i]);
    uv.push(-x / L, 0);
    sec.push(0, 0, 0);
    parts.push(part);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBody', new THREE.Float32BufferAttribute(body, 3));
  g.setAttribute('aNrm', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aSec', new THREE.Float32BufferAttribute(sec, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(parts, 1));
  g.setIndex(idx);
  return g;
}

/** 局部坐标系里的一个 UV 球（眼睛）：中心 c，半径 r */
export function spherePts(c, r, nu = 18, nv = 12, squash = [1, 1, 1]) {
  const pts = [], nrms = [], idx = [];
  for (let i = 0; i <= nv; i++) {
    const th = (i / nv) * Math.PI;
    for (let j = 0; j <= nu; j++) {
      const ph = (j / nu) * Math.PI * 2;
      const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      pts.push([c[0] + n[0] * r * squash[0], c[1] + n[1] * r * squash[1], c[2] + n[2] * r * squash[2]]);
      nrms.push(n);
    }
  }
  const W = nu + 1;
  for (let i = 0; i < nv; i++) for (let j = 0; j < nu; j++) {
    const a = i * W + j, b = a + W;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  return { pts, nrms, idx };
}

/** 局部坐标系里的一个圆柱（信标、须）：从 p0 到 p1，半径 r0→r1 */
export function cylinderPts(p0, p1, r0, r1, nu = 12, nv = 6) {
  const pts = [], nrms = [], idx = [];
  const ax = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const al = Math.hypot(...ax);
  const a = ax.map((v) => v / al);
  let t = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [a[1] * t[2] - a[2] * t[1], a[2] * t[0] - a[0] * t[2], a[0] * t[1] - a[1] * t[0]];
  const ul = Math.hypot(...u); u = u.map((v) => v / ul);
  const w = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
  for (let i = 0; i <= nv; i++) {
    const k = i / nv, r = r0 + (r1 - r0) * k;
    for (let j = 0; j <= nu; j++) {
      const ph = (j / nu) * Math.PI * 2;
      const n = [u[0] * Math.cos(ph) + w[0] * Math.sin(ph), u[1] * Math.cos(ph) + w[1] * Math.sin(ph), u[2] * Math.cos(ph) + w[2] * Math.sin(ph)];
      pts.push([p0[0] + ax[0] * k + n[0] * r, p0[1] + ax[1] * k + n[1] * r, p0[2] + ax[2] * k + n[2] * r]);
      nrms.push(n);
    }
  }
  const W = nu + 1;
  for (let i = 0; i < nv; i++) for (let j = 0; j < nu; j++) {
    const q = i * W + j, b = q + W;
    idx.push(q, b, q + 1, q + 1, b, b + 1);
  }
  return { pts, nrms, idx };
}

/**
 * 鳍：按 (u 弦向 0..1, v 展向 0..1) 的网格生成。
 * root(u) → [s, lat, vert]（根部在身体上的位置），dir(u, v) → [ds, dlat, dvert]（从根到鳍缘的方向，单位米，已乘展长）
 * 返回的几何带 aFin = (鳍号, v, u, 侧)，aFlap = 鳍面法线（局部，用于扇动）
 */
export function buildFin({ id, side = 1, root, span, nU = 18, nV = 10, L, flapNormal }) {
  const body = [], nrm = [], fin = [], flap = [], idx = [], pos = [];
  for (let i = 0; i <= nU; i++) {
    const u = i / nU;
    const r = root(u);
    for (let j = 0; j <= nV; j++) {
      const v = j / nV;
      const d = span(u, v);
      const s = r[0] + d[0] / L;
      const lat = r[1] + d[1], vert = r[2] + d[2];
      body.push(s, lat, vert);
      pos.push(-s * L, vert, lat);
      const fnrm = flapNormal(u, v);
      nrm.push(fnrm[0], fnrm[1], fnrm[2]);
      fin.push(id, v, u, side);
      flap.push(fnrm[0], fnrm[1], fnrm[2]);
    }
  }
  const W = nV + 1;
  for (let i = 0; i < nU; i++) {
    for (let j = 0; j < nV; j++) {
      const a = i * W + j, b = a + W, c = a + 1, d = b + 1;
      idx.push(a, b, c, c, b, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBody', new THREE.Float32BufferAttribute(body, 3));
  g.setAttribute('aNrm', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aFin', new THREE.Float32BufferAttribute(fin, 4));
  g.setAttribute('aFlap', new THREE.Float32BufferAttribute(flap, 3));
  g.setIndex(idx);
  return g;
}

/** 合并若干几何（属性名需一致） */
export function mergeGeos(geos) {
  const names = Object.keys(geos[0].attributes);
  const out = new THREE.BufferGeometry();
  for (const n of names) {
    const size = geos[0].attributes[n].itemSize;
    const arr = [];
    for (const g of geos) arr.push(...g.attributes[n].array);
    out.setAttribute(n, new THREE.Float32BufferAttribute(arr, size));
  }
  const idx = [];
  let off = 0;
  for (const g of geos) {
    for (const k of g.index.array) idx.push(k + off);
    off += g.attributes[names[0]].count;
  }
  out.setIndex(idx);
  return out;
}

// ---- 白鲟的鳍 ----
export function paddlefishFins(P, L) {
  const fins = [];
  const topAt = (s) => (P.c(s) + P.hu(s) * 0.96) * L;
  const botAt = (s) => (P.c(s) - P.hd(s) * 0.96) * L;
  const smooth = (x) => x * x * (3 - 2 * x);
  // 背鳍（1）：靠后，镰刀形，前缘高
  fins.push(buildFin({
    id: 1, L, nU: 16, nV: 10,
    root: (u) => { const s = 0.655 + u * 0.085; return [s, 0, topAt(s) - 0.004]; },
    span: (u, v) => {
      const h = (0.078 * Math.pow(1 - u, 0.8) * (0.35 + 0.65 * Math.sin(Math.min(1, u * 4 + 0.15) * Math.PI / 2)) + 0.008) * L;
      const sweep = 0.055 * L * v * (0.6 + 0.4 * (1 - u));
      return [sweep, 0, h * v];
    },
    flapNormal: () => [0, 0, 1],
  }));
  // 臀鳍（2）
  fins.push(buildFin({
    id: 2, L, nU: 14, nV: 8,
    root: (u) => { const s = 0.705 + u * 0.075; return [s, 0, botAt(s) + 0.003]; },
    span: (u, v) => {
      const h = (0.055 * Math.pow(1 - u, 0.9) * (0.4 + 0.6 * Math.sin(Math.min(1, u * 4 + 0.2) * Math.PI / 2)) + 0.006) * L;
      return [0.035 * L * v, 0, -h * v];
    },
    flapNormal: () => [0, 0, 1],
  }));
  // 腹鳍（3，左右）
  for (const side of [1, -1]) {
    fins.push(buildFin({
      id: 3, side, L, nU: 10, nV: 8,
      root: (u) => {
        const s = 0.545 + u * 0.035;
        const th = Math.PI - side * 0.62;
        const [lat, vert] = sectionPoint(P, L, s, th);
        return [s, lat * 0.97, vert * 0.97];
      },
      span: (u, v) => {
        const h = (0.045 * Math.pow(1 - u, 0.7) + 0.006) * L;
        return [0.03 * L * v, side * h * v * 0.55, -h * v * 0.8];
      },
      flapNormal: () => [0, 0.55, side * 0.83],
    }));
  }
  // 胸鳍（4，左右）：低位，向后外下伸，会扇
  for (const side of [1, -1]) {
    fins.push(buildFin({
      id: 4, side, L, nU: 12, nV: 10,
      root: (u) => {
        const s = 0.425 + u * 0.04;
        const th = Math.PI - side * 0.78;
        const [lat, vert] = sectionPoint(P, L, s, th);
        return [s, lat * 0.97, vert * 0.97];
      },
      span: (u, v) => {
        const h = (0.075 * Math.pow(1 - u, 0.55) * (0.5 + 0.5 * smooth(Math.min(1, u * 3 + 0.3))) + 0.006) * L;
        return [0.045 * L * v, side * h * v * 0.72, -h * v * 0.62];
      },
      flapNormal: () => [0, 0.72, side * 0.69],
    }));
  }
  // 尾鳍（5）：歪型尾，轴线上翘进入上叶，膜主要在轴下
  fins.push(buildFin({
    id: 5, L, nU: 30, nV: 14,
    root: (u) => { const s = 0.855 + u * 0.145; return [s, 0, P.c(s) * L]; },
    span: (u, v) => {
      // v 0..1 映射到上缘（窄）→ 下缘（宽）
      const up = (0.013 + 0.004 * Math.sin(u * Math.PI)) * L;
      const lobe = u < 0.55 ? 0.022 + 0.07 * smooth(u / 0.55) : 0.092 * Math.pow(1 - (u - 0.55) / 0.45, 1.25);
      const down = (lobe + 0.012) * L;
      const y = up - (up + down) * v;
      const back = (u > 0.2 ? 0.02 * L * v * v : 0) + 0.018 * L * v * smooth(Math.min(1, u * 2));
      return [back, 0, y];
    },
    flapNormal: () => [0, 0, 1],
  }));
  return fins;
}
