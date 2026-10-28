// 白鲟（Psephurus gladius）的写意墨画：侧视（最典型的画鱼角度）与俯视（放流时江面上看）。
// 造型要点：扁平剑形长吻约占全长 1/3（根宽尖细，侧看是一片薄刃）、眼极小在吻根、口大而下位、
// 鳃盖后缘拖成长尖角、背鳍很靠后（与臀鳍上下相对）、歪尾上叶长而上翘、身体光滑无鳞。
// 坐标：u 从吻尖 0 到尾尖 1（按体长 L），h 以体长为单位的法向偏移（+ 背侧）。
import { spline } from './curve.js';
import { CH } from './gl.js';
import { clamp, lerp, noise1, hash1 } from '../../film/util.js';

// ---- 侧视轮廓（半高，单位 L）----
const DORSAL = [[0, .0011], [.06, .0026], [.15, .0045], [.24, .0063], [.30, .0079], [.33, .0098], [.345, .0142], [.37, .0226],
  [.40, .0322], [.44, .0432], [.49, .0520], [.55, .0575], [.62, .0560], [.69, .0487], [.75, .0398], [.81, .0300], [.86, .0212], [.90, .0185], [.95, .015], [1, .012]];
const VENTRAL = [[0, .0009], [.06, .0021], [.15, .0036], [.24, .0050], [.30, .0062], [.33, .0080], [.35, .0130], [.38, .0235],
  [.42, .0350], [.47, .0452], [.53, .0520], [.60, .0552], [.67, .0515], [.74, .0428], [.80, .0318], [.86, .0190], [.90, .0160], [.95, .013], [1, .010]];
// ---- 俯视轮廓（半宽，单位 L）----
const TOPW = [[0, .004], [.08, .0105], [.18, .0175], [.27, .0245], [.32, .0285], [.345, .034], [.38, .046], [.43, .054], [.5, .052],
  [.58, .047], [.66, .040], [.74, .031], [.81, .021], [.86, .012], [.9, .0075], [.95, .005], [1, .003]];

function table(ctrl, n = 512) {
  // 非均匀节点的三次 Hermite（Catmull-Rom 切线），查表
  const out = new Float32Array(n + 1);
  const m = ctrl.length;
  const tan = ctrl.map((p, i) => {
    const a = ctrl[Math.max(0, i - 1)], b = ctrl[Math.min(m - 1, i + 1)];
    return (b[1] - a[1]) / Math.max(1e-6, b[0] - a[0]);
  });
  let seg = 0;
  for (let k = 0; k <= n; k++) {
    const u = k / n;
    while (seg < m - 2 && u > ctrl[seg + 1][0]) seg++;
    const [u0, y0] = ctrl[seg], [u1, y1] = ctrl[seg + 1];
    const d = u1 - u0, t = clamp((u - u0) / d);
    const t2 = t * t, t3 = t2 * t;
    out[k] = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * d * tan[seg] + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * d * tan[seg + 1];
  }
  return out;
}
const TD = table(DORSAL), TV = table(VENTRAL), TW = table(TOPW);
const look = (T, u) => { const f = clamp(u) * (T.length - 1); const i = Math.min(T.length - 2, Math.floor(f)); return lerp(T[i], T[i + 1], f - i); };
export const dorsalH = (u) => look(TD, u);
export const ventralH = (u) => look(TV, u);
export const topHalfW = (u) => look(TW, u);

export class Fish {
  constructor(N = 140) {
    this.N = N;
    this.px = new Float32Array(N); this.py = new Float32Array(N);
    this.nx = new Float32Array(N); this.ny = new Float32Array(N);
    this.L = 1000; this.ds = 1;
  }
  /**
   * 摆姿势：脊线从吻尖到尾尖，曲率 kappa(u)（弧度/体长）积分出来，保持体长不变。
   * anchor：这个 u 处的点放在 (x, y)；ang：吻→尾方向角；ds：+1 背侧在行进方向左侧（吻朝左时背朝上）
   */
  pose({ x, y, L, ang = 0, anchor = 0.45, kappa = null, ds }) {
    const N = this.N, du = 1 / (N - 1);
    let th = ang, cx = 0, cy = 0;
    const px = this.px, py = this.py;
    px[0] = 0; py[0] = 0;
    const tx = new Float32Array(N), ty = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = i * du;
      const k = kappa ? kappa(u) : 0;
      if (i > 0) {
        th += k * du * 0.5;
        cx += Math.cos(th) * L * du; cy += Math.sin(th) * L * du;
        th += k * du * 0.5;
        px[i] = cx; py[i] = cy;
      }
      tx[i] = Math.cos(th); ty[i] = Math.sin(th);
    }
    // 锚点平移
    const fa = anchor * (N - 1), ia = Math.min(N - 2, Math.floor(fa)), fr = fa - ia;
    const ax = lerp(px[ia], px[ia + 1], fr), ay = lerp(py[ia], py[ia + 1], fr);
    for (let i = 0; i < N; i++) {
      px[i] += x - ax; py[i] += y - ay;
      this.nx[i] = ty[i]; this.ny[i] = -tx[i]; // 行进方向左侧
    }
    this.L = L;
    this.ds = ds === undefined ? (Math.cos(ang) >= 0 ? 1 : -1) : ds;
    return this;
  }
  /** (u, h) → 世界坐标 */
  P(u, h = 0) {
    const f = clamp(u) * (this.N - 1), i = Math.min(this.N - 2, Math.floor(f)), a = f - i;
    const x = lerp(this.px[i], this.px[i + 1], a), y = lerp(this.py[i], this.py[i + 1], a);
    const nx = lerp(this.nx[i], this.nx[i + 1], a), ny = lerp(this.ny[i], this.ny[i + 1], a);
    const k = h * this.L * this.ds;
    return [x + nx * k, y + ny * k];
  }
  /** 一串 (u,h) 控制点 → 世界坐标样条 */
  curve(uh, step = 4) {
    const pts = uh.map(([u, h]) => this.P(u, h));
    return spline(pts, step);
  }
  /** 沿脊线 u0→u1 的采样折线 */
  axis(u0, u1, h = 0, step = 5) {
    const n = Math.max(2, Math.ceil(Math.abs(u1 - u0) * this.L / step));
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { const p = this.P(lerp(u0, u1, i / (n - 1)), h); out[2 * i] = p[0]; out[2 * i + 1] = p[1]; }
    return out;
  }
  /** 沿轮廓（hFn(u) 给 h）采样 */
  edge(u0, u1, hFn, step = 5) {
    const n = Math.max(2, Math.ceil(Math.abs(u1 - u0) * this.L / step));
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { const u = lerp(u0, u1, i / (n - 1)); const p = this.P(u, hFn(u)); out[2 * i] = p[0]; out[2 * i + 1] = p[1]; }
    return out;
  }
  /** 身体外轮廓多边形（侧视），给留白/遮挡用 */
  outline(step = 8) {
    const a = this.edge(0, 0.9, dorsalH, step), b = this.edge(0.9, 0, (u) => -ventralH(u), step);
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }

  /**
   * 侧视写意。o：
   *  ch       'ink'（墨）或 'res'（黑底上的留白线，夜里用）
   *  ink      整体墨量倍数；wash 身体墨色倍数；line 线条倍数
   *  seed     笔触随机
   *  gill     鳃盖张合 0..1；pect 胸鳍摆角（弧度）；mouth 张口 0..1
   *  parts    { rostrum, head, body, fins, tail }（缺省全画）
   *  detail   0..1（感觉孔、侧线、鳍条）
   *  grow     0..1 整条鱼按笔顺画出来（可选）
   */
  drawSide(ink, o = {}) {
    const L = this.L, ds = this.ds;
    const res = o.ch === 'res';
    const cW = res ? CH.res : CH.wet, cD = res ? CH.res : CH.dry;
    const K = o.ink === undefined ? 1 : o.ink;
    const kw = (o.wash === undefined ? 1 : o.wash) * K, kl = (o.line === undefined ? 1 : o.line) * K;
    const sd = o.seed === undefined ? 1.3 : o.seed;
    const parts = o.parts || {};
    const want = (k) => parts[k] !== false;
    const detail = o.detail === undefined ? 1 : o.detail;
    const gill = o.gill || 0, pect = o.pect || 0, mouth = o.mouth || 0;
    const zL = L * ink.view.z; // 屏幕上的体长
    const step = Math.max(2.5, Math.min(8, L / 260));
    const g = o.grow === undefined ? 1 : o.grow;
    const G = (a, b) => clamp((g - a) / (b - a));  // 分笔生长
    const side = (s) => s * ds;
    const wtb = (fd, fv) => (ds > 0 ? { wt: fd, wb: fv } : { wt: fv, wb: fd });
    const R = res ? 0.55 : 1; // 留白线整体更轻

    if (want('body')) {
      // 1 背：一笔侧锋。从眼后起笔（轻、窄），上缘贴着背线（浓），往下化开到半身，腹部留白；尾柄处提笔飞白
      // 头部只盖住上半（眼的一圈留白），往后才化到半身
      const u0 = 0.348, u1 = o.uMax ? Math.min(0.9, o.uMax) : 0.9;
      const cut = o.uMax ? (u) => clamp((1 - u) / 0.3) : () => 1; // 身子没进被子里：往后淡掉
      const pts = this.axis(u0, u1, 0, step);
      const U = (u) => lerp(u0, u1, u);
      const lowF = (u) => { const uu = U(u); const a = clamp((uu - 0.36) / 0.08); return lerp(-dorsalH(uu) * 0.35, ventralH(uu) * (0.1 + 0.32 * Math.sin(Math.min(1, u * 1.3) * Math.PI)), a); };
      const ww = wtb((u) => dorsalH(U(u)) * L * 1.0, (u) => lowF(u) * L);
      ink.stroke(pts, { ...ww, ch: cW, ink: (u) => kw * R * (1.0 + 0.2 * Math.sin(u * 4.1 + sd)) * (u > 0.8 && !o.uMax ? 1 - (u - 0.8) * 2.2 : 1) * (0.35 + 0.65 * clamp(u / 0.1)) * cut(u),
        dry: (u) => 0.03 + 0.5 * Math.pow(Math.max(0, u - 0.4) / 0.6, 1.5), side: side(0.97), rim: 0.3, bsp: L * 0.004, seed: sd, cap: 4, grow: G(0, 0.35) });
      if (o.uMax) {
        // 只露出头：整个头一层极淡的墨（有体积），喉下一线，背上一笔浓墨从额头到被子边
        const hp = this.axis(0.345, o.uMax + 0.01, 0, step);
        const HU = (u) => lerp(0.345, o.uMax + 0.01, u);
        ink.stroke(hp, { wt: (u) => dorsalH(HU(u)) * L * 0.96, wb: (u) => ventralH(HU(u)) * L * 0.92, ch: cW, ink: (u) => kw * R * 0.1 * clamp(u / 0.15) * clamp((1 - u) / 0.2), dry: 0.08, side: side(0.5), rim: 0.8, bsp: L * 0.004, seed: sd + 30, cap: 0 });
        const th = this.edge(0.35, o.uMax, (u) => -ventralH(u) + 0.0012, step);
        ink.stroke(th, { w: (u) => L * 0.0024 * (0.4 + 0.8 * Math.sin(Math.PI * u)), ch: cD, ink: (u) => kl * R * 0.55 * clamp((1 - u) / 0.3), dry: (u) => 0.25 + 0.4 * u, bsp: 1.2, seed: sd + 31 });
        const bk = this.edge(0.36, Math.min(0.6, o.uMax + 0.004), (u) => dorsalH(u) - 0.0028, step);
        ink.stroke(bk, { w: (u) => L * 0.0085 * brushLike(u, 0.1, 0.1) * (0.8 + 0.3 * Math.sin(u * 5 + sd)), ch: cD, ink: (u) => kl * R * 1.05 * clamp((1 - u) / 0.25), dry: (u) => 0.12 + 0.4 * u, bsp: 1.6, seed: sd + 2, rim: 0.2 });
      } else {
      // 2 腰身一笔淡墨（更淡、更飞），给身体一点体积，下缘毛糙地停在腹部上方
      const mid = this.axis(0.45, 0.84, -0.004, step);
      const U2 = (u) => lerp(0.45, 0.84, u);
      ink.stroke(mid, { ...wtb((u) => dorsalH(U2(u)) * L * 0.55, (u) => ventralH(U2(u)) * L * (0.62 + 0.1 * Math.sin(u * 3))), ch: cW,
        ink: (u) => kw * R * 0.24 * clamp(u / 0.18) * clamp((1 - u) / 0.3), dry: (u) => 0.18 + 0.4 * u, side: side(0.6), rim: 0.6, bsp: L * 0.006, seed: sd + 40, cap: 0, grow: G(0.1, 0.4) });
      // 背上再压一笔浓墨（从颈部到背鳍前，边缘利落）
      const back = this.edge(0.4, 0.7, (u) => dorsalH(u) - 0.0028, step);
      ink.stroke(back, { w: (u) => L * 0.0105 * brushLike(u, 0.08, 0.35) * (0.8 + 0.3 * Math.sin(u * 5 + sd)),
        ch: cD, ink: kl * R * 1.1, dry: (u) => 0.12 + 0.55 * Math.pow(u, 1.5), bsp: 1.6, seed: sd + 2, rim: 0.2, grow: G(0.05, 0.4) });
      const back2 = this.edge(0.775, 0.88, (u) => dorsalH(u) - 0.0015, step);
      ink.stroke(back2, { w: (u) => L * 0.0055 * brushLike(u, 0.15, 0.6), ch: cD, ink: kl * R * 0.85, dry: (u) => 0.3 + 0.4 * u, bsp: 1.4, seed: sd + 3, grow: G(0.35, 0.45) });
      // 腹线：极淡、断成两截，像笔尖轻轻带过
      [[0.43, 0.57], [0.6, 0.79]].forEach(([a, b], i) => {
        const pts2 = this.edge(a, b, (u) => -ventralH(u) + 0.0015, step);
        ink.stroke(pts2, { w: (u) => L * 0.0026 * brushLike(u, 0.2, 0.45), ch: cD, ink: kl * R * 0.4, dry: (u) => 0.35 + 0.35 * u, bsp: 1.2, seed: sd + 5 + i, grow: G(0.4 + i * 0.05, 0.5 + i * 0.05) });
      });
      }
    }
    if (want('rostrum')) {
      // 吻：一笔从吻根拖到吻尖（根宽尖细，上缘略深，墨在吻根处渐淡、不留接缝），再用笔尖勾一下上缘
      const rs = this.axis(0.346, 0.0, 0, step);
      const U = (u) => lerp(0.346, 0.0, u);
      ink.stroke(rs, { ...wtb((u) => dorsalH(U(u)) * L * 0.98, (u) => ventralH(U(u)) * L * 0.98), ch: cW,
        ink: (u) => kw * R * (0.3 - 0.08 * u) * (0.35 + 0.65 * clamp(u / 0.06)), dry: (u) => 0.06 + 0.4 * Math.pow(u, 1.4), side: side(0.55), rim: 0.8, bsp: Math.max(1, L * 0.0016), seed: sd + 9, cap: 0, grow: G(0.45, 0.6) });
      const up = this.edge(0.343, 0.015, (u) => dorsalH(u) * 0.86, step);
      ink.stroke(up, { w: (u) => L * lerp(0.0045, 0.0007, Math.pow(u, 0.7)) * brushLike(u, 0.05, 0.25), ch: cD, ink: kl * R * 0.9, dry: (u) => 0.1 + 0.45 * u, bsp: 1.2, seed: sd + 7, grow: G(0.45, 0.6) });
      const lo = this.edge(0.33, 0.08, (u) => -ventralH(u) * 0.85, step);
      ink.stroke(lo, { w: (u) => L * lerp(0.0026, 0.0006, u) * brushLike(u, 0.1, 0.4), ch: cD, ink: kl * R * 0.4, dry: (u) => 0.25 + 0.4 * u, bsp: 1.1, seed: sd + 8, grow: G(0.5, 0.62) });
      // 感觉孔：吻上细密的小点（近看才画）
      if (detail > 0.3 && zL > 1600 && !res) {
        for (let k = 0; k < 34; k++) {
          const u = 0.05 + hash1(k * 7.1 + sd) * 0.27;
          const hh = (hash1(k * 3.3 + sd * 2.0) * 1.5 - 0.75) * (u < 0.3 ? dorsalH(u) : dorsalH(u) * 0.6);
          const p = this.P(u, hh);
          ink.blob(p[0], p[1], L * (0.0006 + 0.0007 * hash1(k * 1.9 + 4.0)) * (0.6 + u / 0.33 * 0.7), { ch: cD, ink: kl * (0.18 + 0.25 * hash1(k * 5.3)) * detail, irr: 0.35, seed: k + sd });
        }
      }
    }
    if (want('head')) {
      // 额：从吻根沿头顶往后一笔（利落的细线，头部的形）
      const fh = this.edge(0.34, 0.43, (u) => dorsalH(u) - 0.0012, step);
      ink.stroke(fh, { w: (u) => L * lerp(0.0032, 0.0078, u) * brushLike(u, 0.1, 0.15), ch: cD, ink: kl * R * 1.05, dry: (u) => 0.08 + 0.3 * u, bsp: 1.3, seed: sd + 10, grow: G(0.55, 0.62) });
      // 口：吻根下面一道弯（张口时下颌下落）
      const mo = mouth * 0.012;
      const mpts = this.curve([[0.337, -0.009], [0.36, -0.0155 - mo * 0.4], [0.385, -0.0225 - mo], [0.412, -0.027 - mo * 0.6]], step);
      ink.stroke(mpts, { w: (u) => L * 0.0026 * brushLike(u, 0.15, 0.5), ch: cD, ink: kl * R * 0.7, dry: (u) => 0.15 + 0.4 * u, bsp: 1.1, seed: sd + 11, grow: G(0.6, 0.66) });
      // 眼：极小，在吻根，靠近口角上方；四周留白
      const e = this.P(0.354, 0.0015);
      ink.blob(e[0], e[1], L * 0.0031, { ch: cD, ink: kl * R * 2.8, irr: 0.12, seed: sd + 12 });
      // 鳃盖：从头顶弯下来，后缘拖成长尖角（呼吸时尖角微微外翻）
      const go = gill * 0.01;
      const hideGill = o.uMax && o.uMax < 0.5;
      if (!hideGill) {
      const op = this.curve([[0.426, 0.031], [0.444, 0.024], [0.456, 0.008], [0.461, -0.009], [0.471, -0.022 - go * 0.5], [0.5, -0.029 - go], [0.54, -0.0335 - go * 1.2], [0.585, -0.0365 - go * 1.4]], step);
      ink.stroke(op, { w: (u) => L * (u < 0.12 ? lerp(0.001, 0.0042, u / 0.12) : lerp(0.0042, 0.0003, Math.pow((u - 0.12) / 0.88, 0.85))) * (1 + 0.35 * Math.sin(u * 9 + sd)),
        ch: cD, ink: (u) => kl * R * (0.78 - 0.3 * u) * (0.4 + 0.6 * clamp(u / 0.08)), dry: (u) => 0.22 + 0.55 * Math.pow(u, 1.1) + 0.15 * Math.sin(u * 13 + sd), bsp: 1.4, seed: sd + 13, rim: 0.4, grow: G(0.66, 0.78) });
      // 颊部一抹淡墨（鳃盖区），尖角里一层更淡的
      const ow = this.curve([[0.378, 0.016], [0.41, 0.03], [0.445, 0.024], [0.455, -0.004], [0.44, -0.028], [0.392, -0.021]], step);
      ink.fill(ow, { ch: cW, ink: kw * R * 0.09, tex: 1.2, seed: sd + 14, feather: L * 0.007 });
      const flap = this.curve([[0.468, -0.016], [0.51, -0.029], [0.56, -0.035], [0.59, -0.037], [0.55, -0.041], [0.5, -0.041], [0.47, -0.036]], step);
      ink.fill(flap, { ch: cW, ink: kw * R * 0.08, tex: 1.0, seed: sd + 15, feather: L * 0.004 });
      }
    }
    if (want('fins')) {
      // 鳍都小而软：淡墨一抹（扇形），前缘一笔稍深
      const fan = (base, tips, inkK, sdd) => {
        // 鳍：从鳍基往外扫几笔淡墨，笔根按下、笔梢散成飞白（鳍条），笔与笔叠处自然深一点；前缘一笔稍深
        const Bp = this.P(base[0], base[1]);
        const TP = tips.map(([u, h]) => this.P(u, h));
        const n = TP.length;
        for (let k = 0; k < n; k++) {
          const a = TP[k], pv = TP[Math.max(0, k - 1)], nx2 = TP[Math.min(n - 1, k + 1)];
          const sp = Math.max(L * 0.004, Math.hypot(nx2[0] - pv[0], nx2[1] - pv[1]) * 0.55);
          const mid = [lerp(Bp[0], a[0], 0.5) + (nx2[0] - pv[0]) * 0.08, lerp(Bp[1], a[1], 0.5) + (nx2[1] - pv[1]) * 0.08];
          ink.stroke(spline([Bp, mid, a], Math.max(1.5, step * 0.6)), { w: (u) => sp * lerp(0.5, 1.45, Math.pow(u, 0.7)), ch: cW,
            ink: (u) => kw * R * 0.12 * inkK * (1 - 0.35 * u) * (0.8 + 0.4 * hash1(k * 3.1 + sdd)), dry: (u) => 0.06 + 0.42 * Math.pow(u, 1.6), rim: 0.8, bsp: Math.max(1, L * 0.0022), seed: sd + sdd + k * 1.3, cap: 2 });
        }
        const lead = this.curve([base, tips[0]], step);
        ink.stroke(lead, { w: (u) => L * 0.004 * brushLike(u, 0.15, 0.7), ch: cW, ink: (u) => kw * R * 0.5 * inkK * (1 - 0.5 * u), dry: (u) => 0.2 + 0.55 * u, bsp: 1.2, seed: sd + sdd + 1, rim: 0.5 });
      };
      const pa = pect;
      // 胸鳍：鳃盖下方，向后下方
      fan([0.474, -0.04], [[0.5, -0.06 - pa * 0.025], [0.524, -0.072 - pa * 0.035], [0.541, -0.075 - pa * 0.04], [0.545, -0.066 - pa * 0.03], [0.525, -0.052]], 1.25, 16);
      // 腹鳍
      fan([0.648, -0.051], [[0.672, -0.061], [0.692, -0.068], [0.698, -0.066], [0.685, -0.058], [0.665, -0.053]], 0.9, 20);
      // 背鳍（很靠后）：前缘陡、后缘内凹
      fan([0.708, 0.046], [[0.728, 0.068], [0.744, 0.08], [0.749, 0.074], [0.753, 0.058], [0.762, 0.044]], 1.2, 24);
      // 臀鳍（与背鳍上下相对）
      fan([0.742, -0.042], [[0.76, -0.058], [0.776, -0.07], [0.781, -0.062], [0.786, -0.047], [0.793, -0.035]], 1.1, 28);
    }
    if (want('tail')) {
      // 歪尾：上叶长而上翘（身体的延长），下叶短；两笔侧锋 + 一层淡墨
      const sw = o.tailSwing || 0; // 尾鳍摆动（h 方向的附加偏移）
      const T = (u, h) => [u, h + sw * Math.pow(clamp((u - 0.86) / 0.14), 1.5)];
      // 尾鳍的膜：从尾柄往后缘扫几笔淡墨，梢上飞白
      const TE = [T(0.992, 0.078), T(0.975, 0.055), T(0.962, 0.034), T(0.953, 0.012), T(0.95, -0.012), T(0.948, -0.036), T(0.945, -0.056)];
      for (let k = 0; k < TE.length; k++) {
        const b0 = this.P(...T(0.872 + k * 0.004, 0.012 - k * 0.004)), tp = this.P(...TE[k]);
        const md = [lerp(b0[0], tp[0], 0.5), lerp(b0[1], tp[1], 0.5)];
        ink.stroke(spline([b0, md, tp], Math.max(1.5, step * 0.6)), { w: (u) => L * lerp(0.007, 0.015, u), ch: cW, ink: (u) => kw * R * 0.08 * (1 - 0.3 * u) * (0.8 + 0.4 * hash1(k * 2.3)), dry: (u) => 0.06 + 0.45 * Math.pow(u, 1.5), rim: 0.8, bsp: Math.max(1, L * 0.0022), seed: sd + 22 + k, cap: 2 });
      }
      // 上叶：尾柄处按下，顺势挑到尾尖（侧锋，上缘深）
      const ue = this.curve([T(0.845, 0.006), T(0.88, 0.017), T(0.92, 0.034), T(0.96, 0.057), T(1.0, 0.087)], step);
      ink.stroke(ue, { w: (u) => L * lerp(0.03, 0.0012, Math.pow(u, 0.8)), ch: cW, ink: (u) => kw * R * 0.85 * (0.6 + 0.4 * clamp(u / 0.2)), dry: (u) => 0.08 + 0.6 * Math.pow(u, 1.3), side: side(0.8), bsp: Math.max(1, L * 0.0022), seed: sd + 23, rim: 0.4, cap: 0, grow: G(0.9, 0.96) });
      // 上叶上缘一线（硬鳞，近看是细密的齿）
      const ul = this.curve([T(0.88, 0.029), T(0.93, 0.045), T(0.968, 0.064), T(0.998, 0.085)], step);
      ink.stroke(ul, { w: (u) => L * 0.0035 * brushLike(u, 0.1, 0.5), ch: cD, ink: kl * R * 0.9, dry: (u) => 0.2 + 0.5 * u, bsp: 1.2, seed: sd + 27, grow: G(0.92, 0.97) });
      if (detail > 0.5 && zL > 1800 && !res) {
        for (let k = 0; k < 14; k++) {
          const u = 0.9 + k * 0.0068, hh = 0.031 + (u - 0.9) * 0.56;
          const a = this.P(u, hh + 0.001), b = this.P(u + 0.004, hh + 0.006);
          ink.stroke(new Float32Array([a[0], a[1], b[0], b[1]]), { w: L * 0.0016, ch: cD, ink: kl * 0.5 * detail, dry: 0.3, seed: sd + 40 + k });
        }
      }
      // 下叶：短短一撇
      const le = this.curve([T(0.86, -0.008), T(0.89, -0.024), T(0.92, -0.043), T(0.946, -0.062)], step);
      ink.stroke(le, { w: (u) => L * lerp(0.017, 0.0012, Math.pow(u, 0.8)), ch: cW, ink: (u) => kw * R * 0.5 * (1 - 0.3 * u), dry: (u) => 0.2 + 0.55 * u, side: side(-0.6), bsp: Math.max(1, L * 0.002), seed: sd + 24, cap: 0, grow: G(0.92, 0.97) });
      // 后缘（内凹的叉）一笔干笔，若断若续
      const te = this.curve([T(0.997, 0.083), T(0.972, 0.046), T(0.952, 0.012), T(0.949, -0.025), T(0.945, -0.06)], step);
      ink.stroke(te, { w: (u) => L * 0.0028 * (0.6 + 0.4 * Math.sin(u * 7 + sd)), ch: cD, ink: kl * R * 0.32, dry: 0.55, bsp: 1.1, seed: sd + 25, grow: G(0.95, 1.0) });
    }
  }

  /**
   * 只剩轮廓：背线、腹线、吻的上下缘、鳃盖、鳍的前缘、歪尾的边、一点眼。笔有提按、有断续（飞白）。
   *  o.ink 墨量；o.ch 'res' 时画成留白线；o.gill 鳃盖张合
   */
  drawOutline(ink, o = {}) {
    const L = this.L, K = o.ink === undefined ? 1 : o.ink, sd = o.seed === undefined ? 4.4 : o.seed;
    const ch = o.ch === 'res' ? CH.res : CH.dry;
    const step = Math.max(2.5, Math.min(8, L / 260));
    const go = (o.gill || 0) * 0.008;
    const wk = o.width === undefined ? 1 : o.width;
    const line = (pts, w0, s2, kk = 1, dryB = 0.12) => ink.stroke(pts, { w: (u) => L * w0 * wk * (0.35 + 0.9 * Math.pow(Math.sin(Math.PI * clamp(u * 1.04)), 0.7)) * (1 + 0.3 * noise1(u * 11 + s2)), ch, ink: (u) => K * kk * (0.75 + 0.35 * noise1(u * 5 + s2 * 2)), dry: (u) => dryB + 0.3 * Math.max(0, noise1(u * 7 + s2) - 0.2) + 0.15 * u, seed: sd + s2, cap: 2, bsp: 1.2 });
    // 身子里一层极淡的墨（只让她从暗里浮出一个形，不画体积）
    if (o.body) {
      const bpts = this.axis(0.35, 0.9, 0, step);
      const U = (u) => lerp(0.35, 0.9, u);
      ink.stroke(bpts, { wt: (u) => dorsalH(U(u)) * L * 0.92, wb: (u) => ventralH(U(u)) * L * 0.92, ch: o.bodyCh === 'res' ? CH.res : CH.wet, ink: (u) => o.body * clamp(u / 0.08) * clamp((1 - u) / 0.15), dry: 0.1, rim: 0.9, bsp: L * 0.006, seed: sd + 20, cap: 4 });
      ink.stroke(this.axis(0.35, 0.02, 0, step), { wt: (u) => dorsalH(lerp(0.35, 0.02, u)) * L * 0.9, wb: (u) => ventralH(lerp(0.35, 0.02, u)) * L * 0.9, ch: o.bodyCh === 'res' ? CH.res : CH.wet, ink: (u) => o.body * 0.8 * clamp(u / 0.05), dry: 0.2, rim: 0.9, bsp: L * 0.004, seed: sd + 21, cap: 0 });
    }
    line(this.edge(0.34, 0.905, (u) => dorsalH(u) - 0.001, step), 0.0042, 1, 1.0);
    line(this.edge(0.345, 0.9, (u) => -ventralH(u) + 0.001, step), 0.0034, 2, 0.8, 0.35);
    line(this.edge(0.345, 0.012, (u) => dorsalH(u) * 0.9, step), 0.0022, 3, 0.9);
    line(this.edge(0.33, 0.05, (u) => -ventralH(u) * 0.85, step), 0.0016, 4, 0.6, 0.4);
    line(this.curve([[0.426, 0.031], [0.444, 0.024], [0.456, 0.008], [0.461, -0.009], [0.471, -0.022 - go * 0.5], [0.5, -0.029 - go], [0.54, -0.0335 - go * 1.2], [0.585, -0.0365 - go * 1.4]], step), 0.0024, 5, 0.75, 0.35);
    // 鳍：前缘一笔
    for (const [pts, s2] of [[[[0.474, -0.04], [0.5, -0.06], [0.524, -0.072]], 6], [[[0.648, -0.051], [0.672, -0.061], [0.692, -0.068]], 7], [[[0.708, 0.046], [0.728, 0.068], [0.744, 0.08]], 8], [[[0.742, -0.042], [0.76, -0.058], [0.776, -0.07]], 9]]) line(this.curve(pts, step), 0.0028, s2, 0.8, 0.3);
    // 尾：上叶上缘、下叶、后缘
    line(this.curve([[0.88, 0.022], [0.93, 0.045], [0.968, 0.064], [0.998, 0.085]], step), 0.003, 10, 0.95);
    line(this.curve([[0.87, -0.012], [0.9, -0.028], [0.925, -0.046], [0.946, -0.062]], step), 0.0026, 11, 0.8);
    line(this.curve([[0.997, 0.083], [0.972, 0.046], [0.952, 0.012], [0.949, -0.025], [0.945, -0.06]], step), 0.0018, 12, 0.6, 0.45);
    const e = this.P(0.354, 0.0015);
    ink.blob(e[0], e[1], L * 0.0028, { ch, ink: K * 1.4, irr: 0.15, seed: sd + 13 });
  }

  /**
   * 俯视（江面上往下看）：吻是一柄扁剑，头宽，胸鳍两侧张开，身体收成细尾（歪尾侧着看只是一条线）
   */
  drawTop(ink, o = {}) {
    const L = this.L;
    const K = o.ink === undefined ? 1 : o.ink;
    const sd = o.seed === undefined ? 2.1 : o.seed;
    const step = Math.max(2, L / 90);
    const ch = o.ch === 'res' ? CH.res : CH.wet, chD = o.ch === 'res' ? CH.res : CH.dry;
    // 背：一笔，中线深、两侧化开
    const pts = this.axis(0.33, 0.97, 0, step);
    const U = (u) => lerp(0.33, 0.97, u);
    ink.stroke(pts, { wt: (u) => topHalfW(U(u)) * L, wb: (u) => topHalfW(U(u)) * L, ch, ink: (u) => K * (0.9 + 0.3 * Math.sin(u * 2.5)) * (1 - 0.45 * u),
      dry: (u) => 0.05 + 0.5 * Math.pow(u, 2), rim: 0.5, bsp: Math.max(0.8, L * 0.006), seed: sd });
    ink.stroke(this.axis(0.36, 0.88, 0, step), { w: (u) => L * 0.022 * (1 - 0.7 * u), ch, ink: K * 0.6, dry: 0.2, bsp: 1, seed: sd + 1 });
    // 吻：淡墨一片，边缘一线
    const rs = this.axis(0.34, 0.0, 0, step);
    const R = (u) => lerp(0.34, 0.0, u);
    ink.stroke(rs, { wt: (u) => topHalfW(R(u)) * L, wb: (u) => topHalfW(R(u)) * L, ch, ink: (u) => K * (0.35 - 0.12 * u), dry: (u) => 0.1 + 0.3 * u, rim: 0.9, bsp: Math.max(0.7, L * 0.004), seed: sd + 2 });
    // 胸鳍
    for (const s of [1, -1]) {
      const a = this.P(0.46, s * 0.045), b = this.P(0.5, s * 0.075), c = this.P(0.53, s * 0.098);
      ink.stroke(spline([a, b, c], step), { w: (u) => L * lerp(0.02, 0.002, u), ch, ink: K * 0.55, dry: (u) => 0.2 + 0.5 * u, bsp: 1, seed: sd + 3 + s });
    }
    // 尾：侧看成一条细线，末端微叉
    const t1 = this.P(0.9, 0), t2 = this.P(1.0, 0.004), t3 = this.P(0.985, -0.006);
    ink.stroke(spline([this.P(0.86, 0), t1, t2], step), { w: (u) => L * lerp(0.012, 0.002, u), ch: chD, ink: K * 0.9, dry: 0.3, seed: sd + 5 });
    ink.stroke(spline([t1, t3], step), { w: L * 0.004, ch: chD, ink: K * 0.5, dry: 0.4, seed: sd + 6 });
  }
}

/** 裹在她身上的网（菱形，贴着身子）：tight 0..1 越大越贴；appear(k) 控制从头往尾出现 */
export function drawNetOn(ink, fish, o = {}) {
  const tight = o.tight === undefined ? 1 : o.tight;
  const nW = o.n || 15, K = o.ink === undefined ? 0.8 : o.ink;
  const u0s = o.u0 || 0.22, u1s = o.u1 || 0.96;
  const w = o.w || 2.6;
  for (let k = 0; k < nW; k++) {
    for (const dirK of [1, -1]) {
      const u0 = u0s + (k / (nW - 1)) * (u1s - u0s);
      const appear = o.appear ? o.appear(k) : 1;
      if (appear <= 0) continue;
      const bow = lerp(0.05, 0.008, tight) * (0.7 + 0.6 * hash1(k * 3 + dirK));
      const du = 0.07 * dirK;
      const uA = clamp(u0 - du * 0.5, 0.02, 1), uB = clamp(u0 + du * 0.5, 0.02, 1);
      const pA = fish.P(uA, dorsalH(uA) + bow), pM = fish.P((uA + uB) / 2, (dorsalH(uA) - ventralH(uB)) * 0.5 + 0.004 * dirK), pB = fish.P(uB, -ventralH(uB) - bow);
      const ext = 0.025 * (1 - tight);
      const pA2 = fish.P(uA - du * 0.3, dorsalH(uA) + bow + ext), pB2 = fish.P(uB + du * 0.3, -ventralH(uB) - bow - ext);
      ink.stroke(spline([pA2, pA, pM, pB, pB2], Math.max(3, fish.L / 200)), { w: (u) => w * (0.6 + 0.4 * Math.sin(u * Math.PI)), ink: (0.3 + 0.5 * tight) * appear * K, dry: 0.3, ch: o.ch || CH.dry, seed: 200 + k * 2 + (dirK > 0 ? 0 : 1), cap: 1, bsp: 1.1 });
    }
  }
}

/** 毛笔一笔的宽度轮廓：起笔按下（head 占比）、收笔出锋（tail 占比） */
export function brushLike(u, head = 0.12, tail = 0.4) {
  if (u < head) return 0.55 + 0.45 * Math.sin((u / head) * Math.PI / 2);
  if (u > 1 - tail) { const k = (u - (1 - tail)) / tail; return Math.max(0.04, 1 - Math.pow(k, 1.4) * 0.96); }
  return 1;
}

/** 游动的曲率：一列从头传到尾的波（头部几乎不动），amp 弧度/体长 */
export function swimKappa(t, { amp = 1.2, freq = 1.1, wl = 0.9, bias = 0, head = 0.42 } = {}) {
  return (u) => {
    const env = clamp((u - head) / (1 - head));
    return bias * env + amp * env * env * Math.sin(2 * Math.PI * (u / wl - freq * t));
  };
}
