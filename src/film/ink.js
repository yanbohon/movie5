// ============================================================================
// 水墨工具（全片 2D 共用；负责：子代理 A）
// ============================================================================
// 思路：墨不直接画在 Canvas2D 上，而是由这里的「软件笔墨光栅器」写进浮点墨量缓冲 InkBuf
// （0 = 白纸，1 = 焦墨）。每一笔按笔毛、含墨、干湿、提按逐像素算出墨量；笔与笔之间按透射率叠加
// （d = 1-(1-d)(1-v)：叠墨越叠越深、永远不超过 1）。晕边（洇）用宣纸的「吸墨度」fiber 图调制，
// 所以边缘是顺着纸纤维毛出去的，而不是矢量羽化。全部确定性（种子随机 + 查表噪声），同样参数永远同样结果。
//
// 需要「现场画出来」的东西，InkBuf 可以同时记录每个像素的「到达时间」buf.t（绝对秒），
// 着色器里按当前时间揭示：墨沿笔画路径生长、晕边稍后洇开（见下面 INK_GLSL.reveal）。
//
// ---------------------------------------------------------------------------
// API
//   坐标一律是「世界坐标」（像素）；InkBuf 可以只覆盖世界的一块：new InkBuf(w, h, {x0, y0, time})
//
//   rng(seed)                       → {f(), r(a,b), n(), i(a,b), pick(arr), chance(p)}  确定性随机
//   vn1(x) / vn2(x,y) / fbn(x,y,o)  → [0,1) 查表值噪声（快、确定）
//   setFiber(u8, w, h)              设置全局纸纤维图（Uint8 灰度，makePaperCanvas 的 fiber 读出来）
//   fiberFromCanvas(canvas)         → {data:Uint8Array, w, h}（配合 setFiber）
//   spline(ctrl, step)              控制点 [[x,y,p?],…] → 密集点 [{x,y,p}]（Catmull-Rom）
//   tubePoly(ctrl)                  [[x,y,半宽],…] → 圆头「管」的轮廓多边形（给 wash 拼没骨形体）
//
//   stroke(buf, ctrl, o)            毛笔一笔。ctrl = [[x,y,压力],…]，常用 o：
//        w 最大笔宽 px · tone 墨色浓度 0..1 · dry 干（飞白）0..1 · dryEnd 收笔处干度 · head/tail 起收笔渐变占比
//        tailMode 'sharp'|'round'|'press' · rim 湿边加深 · halo 洇出距离 px · haloK 洇的浓度
//        shade 侧锋明暗（>0 行进方向左侧深）· fade 越写越淡 · rough 边缘毛糙 · bristles 笔毛数
//        seed · t0/t1 到达时间（buf.time 时记录；沿笔画线性）· tEase 笔速曲线指数
//   wash(buf, poly, o)              渲染块（淡墨染、没骨块面）；poly 也可以是多个多边形的数组（取并集，一块墨）。o.tone · gfn(x,y)→浓度乘子 · soft 边缘化开 px
//        rim/rimW 湿边 · bleed/bleedK 洇 · gran 颗粒 · bloom/bloomScale 墨晕浓淡 · streak/streakAng 刷痕
//        jag/jagScale 边缘抖动 · t0/t1 + tfn(x,y)→0..1（到达时间的空间分布）
//   dot(buf, x, y, r, o)            点（苔点、点叶、眼睛）：o.ax 长宽比 · ang 旋转 · jag · rim · halo · tone
//   erase(buf, poly, o)             擦除（留白）：前景的屋、船画之前先把后面的墨擦掉（poly 可以是多个多边形）
//   stampMask(buf, m, mw, mh, x, y, o)  把灰度蒙版（字、剪影）当墨印上去：o.tone · halo · t0/t1 · tfn
//   textMask(text, font, {vertical, gap}) → {m, w, h}  用字体栅格化文字（小楷注文用）
//
//   paddlefish(buf, x, y, L, o)     白鲟：x,y = 吻尖，L = 全长，o.dir = -1 头朝左(默认) / 1 头朝右
//        o.style 'xieyi' 写意（十来笔）| 'gongbi' 工笔图谱（细笔勾线 + 淡墨分染）· tone · seed · t0/t1
//   PADDLEFISH                      白鲟单位轮廓（吻 1/3、歪尾、鳃盖长尖角、背鳍臀鳍相对……），供别处复用
//   figure(buf, x, y, h, o)         写意人物（脚底 x,y，身高 h）：o.pose 'stand'|'sit'|'row'|'bend'|'carry' · dir · hat
//   tree / willow / pine(buf, x, y, h, o)   写意树
//   mountain(buf, x, y, w, h, o)    山（脚底中点 x,y）：o.style 'far'|'mid'|'near'
//   waterLines(buf, x0, x1, y0, y1, o)      水纹长线
//
//   toCanvas(buf, rgb=PALETTE.ink)  → 透明底画布（alpha = 墨量），可直接 drawImage
//   packChannel(buf, dst, dw, dh, ch, dx, dy, tmin?, tmax?)  把墨量（或 ch 为 't' 时的到达时间）写进 RGBA 字节数组的某个通道
//
//   INK_GLSL                        着色器片段：srgb2lin、inkOnPaper、reveal（按到达时间揭示）、fiberMod
// ============================================================================
import { mulberry32 } from './util.js';
import { PALETTE } from './paper.js';

// ---------------------------------------------------------------------------
// 随机与噪声
// ---------------------------------------------------------------------------
export function rng(seed = 1) {
  const f = mulberry32((seed * 2654435761) >>> 0 ^ 0x9e3779b9);
  f(); f();
  const o = {
    f,
    r: (a = 0, b = 1) => a + (b - a) * f(),
    n: () => { const u = Math.max(1e-9, f()), v = f(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307 * v); },
    i: (a, b) => a + Math.floor(f() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(f() * arr.length)],
    chance: (p) => f() < p,
  };
  return o;
}

const NT = 65536, NM = NT - 1;
const NTAB = (() => { const r = mulberry32(90127); const a = new Float32Array(NT); for (let i = 0; i < NT; i++) a[i] = r(); return a; })();
/** 1D 值噪声 [0,1) */
export function vn1(x) {
  const i = Math.floor(x), f = x - i;
  const a = NTAB[i & NM], b = NTAB[(i + 1) & NM];
  return a + (b - a) * (f * f * (3 - 2 * f));
}
function h2(i, j) { return NTAB[(Math.imul(i, 73856093) ^ Math.imul(j, 19349663)) & NM]; }
/** 2D 值噪声 [0,1) */
export function vn2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = h2(ix, iy), b = h2(ix + 1, iy), c = h2(ix, iy + 1), d = h2(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** 分形噪声 [0,1) */
export function fbn(x, y, oct = 3) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vn2(x * f + i * 17.3, y * f - i * 9.1); n += a; f *= 2.07; a *= 0.5; }
  return s / n;
}
/** 像素级哈希 [0,1) */
export const hashPx = (x, y) => h2(x | 0, (y | 0) + 7919);

const ss = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const cl01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------------------------------------------------------------------------
// 纸纤维（洇的走向）
// ---------------------------------------------------------------------------
let FIB = null, FW = 1, FH = 1;
export function setFiber(u8, w, h) { FIB = u8; FW = w; FH = h; }
export function fiberFromCanvas(cv) {
  const g = cv.getContext('2d', { willReadFrequently: true });
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  const out = new Uint8Array(cv.width * cv.height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j];
  return { data: out, w: cv.width, h: cv.height };
}
/** 纸纤维 0..1（世界坐标；没设置时退化成噪声） */
export function fiberAt(x, y) {
  if (!FIB) return 0.35 + 0.3 * vn2(x * 0.19, y * 0.19);
  let ix = (x | 0) % FW; if (ix < 0) ix += FW;
  let iy = (y | 0) % FH; if (iy < 0) iy += FH;
  return FIB[iy * FW + ix] / 255;
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------
function toPts(ctrl) {
  return ctrl.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1], p: p[2] ?? 1 } : { x: p.x, y: p.y, p: p.p ?? 1 }));
}
/** Catmull-Rom 样条：控制点 → 密集点（间距约 step px） */
export function spline(ctrl, step = 2) {
  const P = toPts(ctrl);
  const n = P.length;
  if (n <= 1) return P;
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(n - 1, i + 2)];
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const k = Math.max(1, Math.ceil(len / step));
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y), p: p1.p + (p2.p - p1.p) * t });
    }
  }
  out.push({ ...P[n - 1] });
  return out;
}

/**
 * 变粗细的「管」轮廓：ctrl = [[x, y, r], …]（r 为该处半宽），返回闭合多边形（两端圆头），
 * 用来给 wash 拼没骨的形体（颈、尾、腿、鱼身……），多个管 + 椭圆可以一起传给 wash 取并集。
 */
export function tubePoly(ctrl, step = 3, cap = true) {
  const P = spline(ctrl.map((q) => [q[0], q[1], q[2] ?? 4]), step);
  const n = P.length;
  if (n < 2) return [];
  const L = [], Rt = [];
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y;
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    L.push([P[i].x - ty * P[i].p, P[i].y + tx * P[i].p]);
    Rt.push([P[i].x + ty * P[i].p, P[i].y - tx * P[i].p]);
  }
  const out = [...L];
  if (cap) {
    // 末端半圆
    const e = P[n - 1], q = P[n - 2];
    const a0 = Math.atan2(e.y - q.y, e.x - q.x);
    for (let k = 1; k < 6; k++) { const a = a0 + Math.PI / 2 - (k / 6) * Math.PI; out.push([e.x + Math.cos(a) * e.p, e.y + Math.sin(a) * e.p]); }
  }
  for (let i = n - 1; i >= 0; i--) out.push(Rt[i]);
  if (cap) {
    const e = P[0], q = P[1];
    const a0 = Math.atan2(e.y - q.y, e.x - q.x);
    for (let k = 1; k < 6; k++) { const a = a0 + Math.PI / 2 - (k / 6) * Math.PI; out.push([e.x + Math.cos(a) * e.p, e.y + Math.sin(a) * e.p]); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 墨量缓冲
// ---------------------------------------------------------------------------
export class InkBuf {
  /** @param {number} w @param {number} h @param {{x0?:number,y0?:number,time?:boolean}} o */
  constructor(w, h, { x0 = 0, y0 = 0, time = false } = {}) {
    this.w = w | 0; this.h = h | 0; this.x0 = x0 | 0; this.y0 = y0 | 0;
    this.d = new Float32Array(this.w * this.h);
    this.t = time ? new Float32Array(this.w * this.h).fill(1e9) : null;
  }
  clear() { this.d.fill(0); if (this.t) this.t.fill(1e9); }
}

// 临时缓冲（每一笔先在这里取 max，再按透射率合进 InkBuf）
let SCR = new Float32Array(1 << 18), SCT = new Float32Array(1 << 18), SCA = new Float32Array(1 << 18);
let SV = new Float32Array(1 << 18), SI = new Float32Array(1 << 18), SE = new Float32Array(1 << 18);
function scratch(n) {
  if (SCR.length < n) {
    const m = Math.ceil(n * 1.25);
    SCR = new Float32Array(m); SCT = new Float32Array(m); SCA = new Float32Array(m);
    SV = new Float32Array(m); SI = new Float32Array(m); SE = new Float32Array(m);
  }
}
/** 把临时缓冲按透射率合进 buf：区域 (bx, by, bw, bh) 是 buf 内部坐标 */
function commit(buf, bx, by, bw, bh, timed) {
  const D = buf.d, T = buf.t, W = buf.w;
  for (let yy = 0; yy < bh; yy++) {
    let k = yy * bw, kk = (by + yy) * W + bx;
    for (let xx = 0; xx < bw; xx++, k++, kk++) {
      const v = SCR[k];
      if (!(v > 0.0005)) continue;
      const vv = v > 1 ? 1 : v;
      D[kk] = 1 - (1 - D[kk]) * (1 - vv);
      if (timed && SCT[k] < T[kk]) T[kk] = SCT[k];
    }
  }
}
/** 世界坐标包围盒 → buf 内部像素范围（裁剪），空则返回 null */
function clipBox(buf, x0, y0, x1, y1) {
  const bx0 = Math.max(0, Math.floor(x0) - buf.x0), by0 = Math.max(0, Math.floor(y0) - buf.y0);
  const bx1 = Math.min(buf.w - 1, Math.ceil(x1) - buf.x0), by1 = Math.min(buf.h - 1, Math.ceil(y1) - buf.y0);
  if (bx1 < bx0 || by1 < by0) return null;
  return [bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1];
}

// ---------------------------------------------------------------------------
// 毛笔一笔
// ---------------------------------------------------------------------------
export function stroke(buf, ctrl, o = {}) {
  if (!buf || !ctrl || ctrl.length === 0) return;
  const W = o.w ?? 8;
  const pts = spline(ctrl, o.step ?? Math.max(0.5, Math.min(2.2, W * 0.18)));
  const n = pts.length;
  if (n < 2) { dot(buf, pts[0].x, pts[0].y, W * 0.5, o); return; }
  const tone = o.tone ?? 0.85, seed = o.seed ?? 1;
  const head = o.head ?? 0.08, tail = o.tail ?? 0.3, tailMode = o.tailMode ?? 'sharp';
  const headMin = o.headMin ?? 0.72;
  const dry0 = o.dry ?? 0.05, dry1 = o.dryEnd ?? Math.min(1, dry0 + 0.3);
  const fade = o.fade ?? 0.18, rim = o.rim ?? 0.16;
  const halo = o.halo ?? 0, haloK = o.haloK ?? 0.35, haloDelay = o.haloDelay ?? 0.25;
  const shade = o.shade ?? 0, rough = o.rough ?? 0.03, fray = o.fray ?? 0.35, gran = o.gran ?? 0.2;
  const load = o.load ?? 0.12; // 落笔处墨更足
  const timed = !!(buf.t && o.t0 !== undefined);
  const t0 = o.t0 ?? 0, t1 = o.t1 ?? t0, tEase = o.tEase ?? 1;
  const X = new Float32Array(n), Y = new Float32Array(n), S = new Float32Array(n);
  const R = new Float32Array(n), TN = new Float32Array(n), DR = new Float32Array(n), AR = new Float32Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    X[i] = pts[i].x - buf.x0; Y[i] = pts[i].y - buf.y0;
    if (i > 0) s += Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]);
    S[i] = s;
  }
  const L = Math.max(1e-3, s);
  const R0 = rng(seed * 7 + 3);
  const wob = R0.f() * 5000, wob2 = R0.f() * 5000, ep1 = R0.f() * 5000, ep2 = R0.f() * 5000, ep3 = R0.f() * 5000;
  const wobble = o.wobble ?? 0.035;
  for (let i = 0; i < n; i++) {
    const u = S[i] / L;
    let k = pts[i].p;
    const hu = S[i] / Math.max(1e-3, head * L);
    if (hu < 1) k *= headMin + (1 - headMin) * Math.sin(hu * 1.5707963);
    const tu = (L - S[i]) / Math.max(1e-3, tail * L);
    if (tu < 1) {
      if (tailMode === 'sharp') k *= Math.pow(tu, 0.8) * 0.95 + 0.05;
      else if (tailMode === 'round') k *= 0.62 + 0.38 * Math.sqrt(tu);
      else if (tailMode === 'press') k *= 1 + 0.2 * (1 - tu);
    }
    k *= 1 + wobble * (vn1(S[i] * 0.02 + wob) * 2 - 1);
    R[i] = Math.max(0.3, 0.5 * W * k);
    let tn = tone * (1 - fade * Math.pow(u, 1.4)) * (0.95 + 0.1 * vn1(S[i] * 0.008 + wob2));
    tn *= 1 + load * Math.exp(-S[i] / Math.max(4, W * 1.6));
    if (tailMode === 'press' && tu < 1) tn *= 1 + 0.12 * (1 - tu);
    TN[i] = tn;
    DR[i] = dry0 + (dry1 - dry0) * ss(0.1, 1, u);
    AR[i] = timed ? t0 + (t1 - t0) * Math.pow(u, tEase) : 0;
  }
  const NB = o.bristles ?? Math.max(4, Math.min(40, Math.round(W / 1.7)));
  const CAP = new Float32Array(NB), PH = new Float32Array(NB), FQ = new Float32Array(NB);
  for (let b = 0; b < NB; b++) {
    CAP[b] = 0.55 + 0.45 * R0.f();
    PH[b] = R0.f() * 60000;
    FQ[b] = (0.3 + 0.5 * R0.f()) / Math.max(14, W * 2.5);
  }
  // 包围盒
  let mx0 = 1e9, my0 = 1e9, mx1 = -1e9, my1 = -1e9;
  for (let i = 0; i < n; i++) {
    const r = R[i] * (1 + rough) + fray + halo + 2;
    if (X[i] - r < mx0) mx0 = X[i] - r; if (X[i] + r > mx1) mx1 = X[i] + r;
    if (Y[i] - r < my0) my0 = Y[i] - r; if (Y[i] + r > my1) my1 = Y[i] + r;
  }
  const bx0 = Math.max(0, Math.floor(mx0)), by0 = Math.max(0, Math.floor(my0));
  const bx1 = Math.min(buf.w - 1, Math.ceil(mx1)), by1 = Math.min(buf.h - 1, Math.ceil(my1));
  if (bx1 < bx0 || by1 < by0) return;
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  scratch(bw * bh);
  SCR.fill(0, 0, bw * bh);
  if (timed) SCT.fill(1e9, 0, bw * bh);
  const gx = buf.x0, gy = buf.y0;
  const N = bw * bh;
  SV.fill(1e9, 0, N);
  // 第一遍：每个像素找「最靠里」的那一段（归一化距离最小），记下带符号的横向位置、沿笔画的参数、该处半宽
  for (let i = 0; i < n - 1; i++) {
    const ax = X[i], ay = Y[i], dx = X[i + 1] - ax, dy = Y[i + 1] - ay;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-8) continue;
    const ll = Math.sqrt(l2);
    const rA = R[i], rB = R[i + 1];
    const rm = Math.max(rA, rB) * (1 + rough) + fray * 2 + halo + 1.5;
    const sx0 = Math.max(bx0, Math.floor(Math.min(ax, ax + dx) - rm)), sx1 = Math.min(bx1, Math.ceil(Math.max(ax, ax + dx) + rm));
    const sy0 = Math.max(by0, Math.floor(Math.min(ay, ay + dy) - rm)), sy1 = Math.min(by1, Math.ceil(Math.max(ay, ay + dy) + rm));
    const sA = S[i], drA = DR[i], drB = DR[i + 1];
    for (let py = sy0; py <= sy1; py++) {
      const cy = py + 0.5 - ay;
      const rowK = (py - by0) * bw - bx0;
      for (let px = sx0; px <= sx1; px++) {
        const cx = px + 0.5 - ax;
        let tc = (cx * dx + cy * dy) / l2;
        if (tc < 0) tc = 0; else if (tc > 1) tc = 1;
        const qx = cx - tc * dx, qy = cy - tc * dy;
        const dist = Math.sqrt(qx * qx + qy * qy);
        const r = rA + (rB - rA) * tc;
        if (dist > r * (1 + rough) + fray * 2 + halo + 1) continue;
        const cross = dx * cy - dy * cx;
        const sAl = sA + tc * ll;
        const dr = drA + (drB - drA) * tc;
        const side = cross >= 0 ? ep1 : ep2;
        const er = Math.max(0.3, r * (1 + rough * (vn1(sAl * 0.05 + side) * 2 - 1)) + (fray + dr * 0.6) * (vn1(sAl * 0.9 + side * 1.3) * 2 - 1));
        const av = dist / er;
        const k = rowK + px;
        if (av < SV[k]) { SV[k] = av; SI[k] = (cross >= 0 ? 1 : -1) * (i + tc + 1); SE[k] = er; }
      }
    }
  }
  // 第二遍：按最近段的参数算墨量
  for (let yy = 0; yy < bh; yy++) {
    for (let xx = 0; xx < bw; xx++) {
      const k = yy * bw + xx;
      const av = SV[k];
      if (av > 1e8) { SCR[k] = 0; continue; }
      const sgn = SI[k] > 0 ? 1 : -1;
      const fi = sgn * SI[k] - 1;
      let i = fi | 0; if (i > n - 2) i = n - 2;
      const tc = fi - i;
      const er = SE[k];
      const sAl = S[i] + (S[i + 1] - S[i]) * tc;
      const tn = TN[i] + (TN[i + 1] - TN[i]) * tc;
      const dr = DR[i] + (DR[i + 1] - DR[i]) * tc;
      const dist = av * er;
      const px = xx + bx0, py = yy + by0;
      let val = 0;
      const body = cl01(er - dist + 0.5);
      if (body > 0) {
        const v = sgn * av;
        // 相邻两根笔毛之间平滑过渡（抗锯齿），笔毛的干湿与相邻笔毛相关（飞白成条、有宽有窄）
        const bf = (v * 0.5 + 0.5) * NB - 0.5;
        let b0 = Math.floor(bf); const fb = bf - b0;
        let b1 = b0 + 1; if (b0 < 0) b0 = 0; if (b1 < 0) b1 = 0; if (b1 > NB - 1) b1 = NB - 1; if (b0 > NB - 1) b0 = NB - 1;
        const wb = ss(0.25, 0.75, fb);
        let act = 1;
        if (dr > 0.001) {
          const thr = dr * (0.72 + 0.55 * v * v);
          const cor = vn2(sAl * 0.018 + ep3, bf * 0.33);
          const g0 = 0.58 * vn1(sAl * FQ[b0] + PH[b0]) + 0.42 * cor;
          const g1 = 0.58 * vn1(sAl * FQ[b1] + PH[b1]) + 0.42 * cor;
          act = ss(thr - 0.045, thr + 0.045, g0) * (1 - wb) + ss(thr - 0.045, thr + 0.045, g1) * wb;
        }
        const cap = CAP[b0] * (1 - wb) + CAP[b1] * wb;
        const rv = av > 0.62 ? Math.min(1, (av - 0.62) * 2.63) : 0;
        let m = (0.86 + 0.14 * cap) * (1 + rim * rv * rv);
        if (shade !== 0) m *= 1 - Math.abs(shade) * (1 + (shade > 0 ? v : -v)) * 0.5;
        if (gran > 0) m *= 1 - gran * (0.6 - fiberAt(px + gx, py + gy)) * (1.25 - tn);
        val = tn * body * act * m;
      }
      let isHalo = false;
      if (halo > 0 && av > 1 - 0.5 / er) {
        const hd = (dist - er) / halo;
        if (hd < 1) {
          const f = fiberAt(px + gx, py + gy);
          const hv = tn * haloK * (1 - hd) * (1 - hd) * ss(0.3, 0.72, f + 0.2 * (vn1(sAl * 0.4 + ep3) - 0.5));
          if (hv > val) { val = hv; isHalo = true; }
        }
      }
      SCR[k] = val;
      if (timed && val > 0) SCT[k] = AR[i] + (AR[i + 1] - AR[i]) * tc + (isHalo ? haloDelay : 0);
    }
  }
  commit(buf, bx0, by0, bw, bh, timed);
}

// ---------------------------------------------------------------------------
// 点
// ---------------------------------------------------------------------------
export function dot(buf, x, y, r, o = {}) {
  if (!buf) return;
  const tone = o.tone ?? 0.8, ax = o.ax ?? 1, ang = o.ang ?? 0, jag = o.jag ?? 0.16;
  const rim = o.rim ?? 0.25, halo = o.halo ?? Math.min(3, r * 0.4), haloK = o.haloK ?? 0.35;
  const soft = o.soft ?? 0, gran = o.gran ?? 0.2;
  const R0 = rng(o.seed ?? 1);
  const a1 = R0.f() * 6.28, a2 = R0.f() * 6.28, a3 = R0.f() * 6.28;
  const timed = !!(buf.t && o.t0 !== undefined);
  const t0 = o.t0 ?? 0, t1 = o.t1 ?? t0;
  const ext = r * Math.max(ax, 1) * (1 + jag) + halo + 2;
  const box = clipBox(buf, x - ext, y - ext, x + ext, y + ext);
  if (!box) return;
  const [bx, by, bw, bh] = box;
  scratch(bw * bh);
  SCR.fill(0, 0, bw * bh);
  if (timed) SCT.fill(1e9, 0, bw * bh);
  const ca = Math.cos(-ang), sa = Math.sin(-ang);
  for (let yy = 0; yy < bh; yy++) {
    const wy = by + yy + buf.y0 + 0.5 - y;
    for (let xx = 0; xx < bw; xx++) {
      const wx = bx + xx + buf.x0 + 0.5 - x;
      const lx = (wx * ca - wy * sa) / ax, ly = wx * sa + wy * ca;
      const rho = Math.sqrt(lx * lx + ly * ly);
      const th = Math.atan2(ly, lx);
      const er = r * (1 + jag * (0.5 * Math.sin(3 * th + a1) + 0.3 * Math.sin(5 * th + a2) + 0.2 * Math.sin(8 * th + a3)));
      let val = 0, isHalo = false;
      if (rho < er + 0.5) {
        const body = soft > 0 ? 1 - ss(er - soft, er + 0.5, rho) : cl01(er - rho + 0.5);
        const q = rho / Math.max(0.5, er);
        let m = 1 + rim * q * q * q;
        if (gran > 0) m *= 1 - gran * (0.62 - fiberAt(bx + xx + buf.x0, by + yy + buf.y0)) * 0.9;
        val = tone * body * m;
      }
      if (halo > 0 && rho > er - 0.5) {
        const hd = (rho - er) / halo;
        if (hd < 1) {
          const f = fiberAt(bx + xx + buf.x0, by + yy + buf.y0);
          const hv = tone * haloK * (1 - hd) * (1 - hd) * ss(0.3, 0.72, f);
          if (hv > val) { val = hv; isHalo = true; }
        }
      }
      if (val <= 0) continue;
      const k = yy * bw + xx;
      SCR[k] = val;
      if (timed) SCT[k] = isHalo ? t1 : t0 + (t1 - t0) * Math.min(1, rho / Math.max(1, er));
    }
  }
  commit(buf, bx, by, bw, bh, timed);
}

// ---------------------------------------------------------------------------
// 渲染块（淡墨染 / 没骨）
// ---------------------------------------------------------------------------
/** 多边形边缘加噪（重采样后沿法线抖动），返回新点列 */
function jagPoly(poly, jag, scale, seed, closed = true) {
  const P = poly.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p));
  const n = P.length;
  if (jag <= 0) return P;
  const sp = Math.max(1.5, Math.min(6, scale / 6));
  const out = [];
  const R0 = rng(seed * 13 + 5);
  const ph1 = R0.f() * 9000, ph2 = R0.f() * 9000;
  let arc = 0;
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const nx = -dy / len, ny = dx / len;
    const k = Math.max(1, Math.ceil(len / sp));
    for (let j = 0; j < k; j++) {
      const t = j / k;
      const s = arc + t * len;
      const off = (vn1(s / scale + ph1) - 0.5) * 2 * jag + (vn1(s / (scale * 0.22) + ph2) - 0.5) * jag * 0.45;
      out.push({ x: a.x + dx * t + nx * off, y: a.y + dy * t + ny * off });
    }
    arc += len;
  }
  if (!closed) out.push({ ...P[n - 1] });
  return out;
}
/** 扫描线多边形覆盖率（4 条子扫描线，水平方向精确），写进 SCA（bw*bh） */
function rasterPoly(P, ox, oy, bw, bh, dst = SCA) {
  const SCA = dst;
  SCA.fill(0, 0, bw * bh);
  const n = P.length;
  // 边表按 y 排序，扫描时只看跨过当前 y 的边
  const edges = [];
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    if (a.y === b.y) continue;
    const up = a.y < b.y;
    const y0 = up ? a.y : b.y, y1 = up ? b.y : a.y;
    const x0 = up ? a.x : b.x, x1 = up ? b.x : a.x;
    edges.push({ y0, y1, x0, k: (x1 - x0) / (y1 - y0) });
  }
  edges.sort((p, q) => p.y0 - q.y0);
  const xs = [];
  let ei = 0;
  const active = [];
  for (let row = 0; row < bh; row++) {
    for (let sub = 0; sub < 4; sub++) {
      const y = oy + row + (sub + 0.5) * 0.25;
      while (ei < edges.length && edges[ei].y0 <= y) active.push(edges[ei++]);
      xs.length = 0;
      for (let j = active.length - 1; j >= 0; j--) {
        const e = active[j];
        if (e.y1 <= y) { active.splice(j, 1); continue; }
        if (e.y0 <= y) xs.push(e.x0 + (y - e.y0) * e.k - ox);
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      const base = row * bw;
      for (let j = 0; j + 1 < xs.length; j += 2) {
        let xa = xs[j], xb = xs[j + 1];
        if (xb <= 0 || xa >= bw) continue;
        if (xa < 0) xa = 0; if (xb > bw) xb = bw;
        const ia = Math.floor(xa), ib = Math.floor(xb);
        if (ia === ib) { SCA[base + ia] += (xb - xa) * 0.25; continue; }
        SCA[base + ia] += (ia + 1 - xa) * 0.25;
        for (let x = ia + 1; x < ib; x++) SCA[base + x] += 0.25;
        if (ib < bw) SCA[base + ib] += (xb - ib) * 0.25;
      }
    }
  }
}
/** 倒角距离变换：inside=true 时算内部像素到边界的距离，否则算外部像素到形状的距离；结果写进 out */
function chamfer(cov, bw, bh, inside, cap, out) {
  const INF = cap + 2;
  for (let k = 0; k < bw * bh; k++) {
    const isIn = cov[k] >= 0.5;
    out[k] = (inside ? isIn : !isIn) ? INF : 0;
  }
  const D1 = 1, D2 = 1.41421;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const k = y * bw + x;
      let v = out[k];
      if (v === 0) continue;
      if (x > 0 && out[k - 1] + D1 < v) v = out[k - 1] + D1;
      if (y > 0) {
        if (out[k - bw] + D1 < v) v = out[k - bw] + D1;
        if (x > 0 && out[k - bw - 1] + D2 < v) v = out[k - bw - 1] + D2;
        if (x < bw - 1 && out[k - bw + 1] + D2 < v) v = out[k - bw + 1] + D2;
      }
      out[k] = v;
    }
  }
  for (let y = bh - 1; y >= 0; y--) {
    for (let x = bw - 1; x >= 0; x--) {
      const k = y * bw + x;
      let v = out[k];
      if (v === 0) continue;
      if (x < bw - 1 && out[k + 1] + D1 < v) v = out[k + 1] + D1;
      if (y < bh - 1) {
        if (out[k + bw] + D1 < v) v = out[k + bw] + D1;
        if (x < bw - 1 && out[k + bw + 1] + D2 < v) v = out[k + bw + 1] + D2;
        if (x > 0 && out[k + bw - 1] + D2 < v) v = out[k + bw - 1] + D2;
      }
      out[k] = v;
    }
  }
}
let DIN = new Float32Array(1 << 16), DOUT = new Float32Array(1 << 16), TMPA = new Float32Array(1 << 16);
export function wash(buf, poly, o = {}) {
  if (!buf || !poly || poly.length < 1) return;
  const multi = Array.isArray(poly[0]) && typeof poly[0][0] !== 'number';
  if (!multi && poly.length < 3) return;
  const tone = o.tone ?? 0.3, seed = o.seed ?? 1;
  const Ps = (multi ? poly.filter((q) => q && q.length >= 3) : [poly]).map((q, j) => jagPoly(q, o.jag ?? 2.2, o.jagScale ?? 28, seed + j * 17, true));
  if (!Ps.length) return;
  const P = Ps.length === 1 ? Ps[0] : Ps.flat();
  const soft = o.soft ?? 0, rim = o.rim ?? 0.35, rimW = o.rimW ?? 2.2;
  const bleed = o.bleed ?? 2.5, bleedK = o.bleedK ?? 0.45;
  const gran = o.gran ?? 0.3, bloom = o.bloom ?? 0.25, bloomScale = o.bloomScale ?? 55;
  const streak = o.streak ?? 0, sAng = o.streakAng ?? 1.5708;
  const gfn = o.gfn || null, tfn = o.tfn || null;
  const timed = !!(buf.t && o.t0 !== undefined);
  const t0 = o.t0 ?? 0, t1 = o.t1 ?? t0, haloDelay = o.haloDelay ?? 0.2;
  let mx0 = 1e9, my0 = 1e9, mx1 = -1e9, my1 = -1e9;
  for (const p of P) { if (p.x < mx0) mx0 = p.x; if (p.x > mx1) mx1 = p.x; if (p.y < my0) my0 = p.y; if (p.y > my1) my1 = p.y; }
  const mg = Math.ceil(bleed + 2);
  const box = clipBox(buf, mx0 - mg, my0 - mg, mx1 + mg, my1 + mg);
  if (!box) return;
  const [bx, by, bw, bh] = box;
  const N = bw * bh;
  scratch(N);
  if (DIN.length < N) { DIN = new Float32Array(Math.ceil(N * 1.25)); DOUT = new Float32Array(Math.ceil(N * 1.25)); }
  if (Ps.length === 1) rasterPoly(Ps[0], bx + buf.x0, by + buf.y0, bw, bh);
  else {
    // 多个多边形取并集（覆盖率取最大）
    if (TMPA.length < N) TMPA = new Float32Array(Math.ceil(N * 1.25));
    SCA.fill(0, 0, N);
    for (const Q of Ps) {
      rasterPoly(Q, bx + buf.x0, by + buf.y0, bw, bh, TMPA);
      for (let k = 0; k < N; k++) if (TMPA[k] > SCA[k]) SCA[k] = TMPA[k];
    }
  }
  const capIn = Math.max(soft, rimW * 4, 2) + 2;
  chamfer(SCA, bw, bh, true, capIn, DIN);
  if (bleed > 0) chamfer(SCA, bw, bh, false, bleed + 1, DOUT);
  SCR.fill(0, 0, N);
  if (timed) SCT.fill(1e9, 0, N);
  const R0 = rng(seed * 31 + 7);
  const bo1 = R0.f() * 5000, bo2 = R0.f() * 5000, so = R0.f() * 5000;
  const cs = Math.cos(sAng), sn = Math.sin(sAng);
  for (let yy = 0; yy < bh; yy++) {
    const wy = by + yy + buf.y0;
    for (let xx = 0; xx < bw; xx++) {
      const k = yy * bw + xx;
      const c = SCA[k];
      const wx = bx + xx + buf.x0;
      let val = 0, isHalo = false;
      if (c > 0.001) {
        const dIn = DIN[k] + (c >= 0.5 ? c - 0.5 : 0);
        let edge = soft > 0 ? ss(0, soft, dIn) * (c < 0.5 ? c * 2 : 1) : (c > 1 ? 1 : c);
        let m = 1 + rim * Math.exp(-dIn / rimW);
        if (bloom > 0) m *= 1 + bloom * (vn2(wx / bloomScale + bo1, wy / bloomScale + bo2) * 2 - 1);
        if (gran > 0) m *= 1 - gran * (0.62 - fiberAt(wx, wy)) - gran * 0.35 * (vn2(wx * 0.55, wy * 0.55) - 0.5);
        if (streak > 0) {
          const pp = -wx * sn + wy * cs, qq = wx * cs + wy * sn;
          m *= 1 + streak * (vn1(pp * 0.42 + so) * 2 - 1) * (0.6 + 0.4 * vn1(qq * 0.02 + so));
        }
        const g = gfn ? gfn(wx, wy) : 1;
        val = tone * g * edge * m;
      } else if (bleed > 0) {
        const dOut = DOUT[k];
        if (dOut < bleed) {
          const g = gfn ? gfn(wx, wy) : 1;
          const f = fiberAt(wx, wy);
          const hd = dOut / bleed;
          val = tone * g * bleedK * (1 - hd) * (1 - hd) * ss(0.3, 0.72, f);
          isHalo = true;
        }
      }
      if (val <= 0) continue;
      SCR[k] = val > 1 ? 1 : val;
      if (timed) SCT[k] = t0 + (t1 - t0) * (tfn ? tfn(wx, wy) : 0) + (isHalo ? haloDelay : 0);
    }
  }
  commit(buf, bx, by, bw, bh, timed);
}

/**
 * 擦除（留白）：把多边形（或多个多边形的并集）里已经画上的墨去掉——前景的东西（屋、船）画之前先把后面的山「让」出来，
 * 就像画家画山时给屋子留出空白。o.soft 边缘羽化 px · o.k 擦除强度（1 = 擦净）· o.jag 边缘抖动
 */
export function erase(buf, poly, o = {}) {
  if (!buf || !poly || poly.length < 1) return;
  const multi = Array.isArray(poly[0]) && typeof poly[0][0] !== 'number';
  const seed = o.seed ?? 1, soft = o.soft ?? 1.5, k = o.k ?? 1;
  const Ps = (multi ? poly.filter((q) => q && q.length >= 3) : [poly]).map((q, j) => jagPoly(q, o.jag ?? 0.8, o.jagScale ?? 10, seed + j * 17, true));
  if (!Ps.length) return;
  let mx0 = 1e9, my0 = 1e9, mx1 = -1e9, my1 = -1e9;
  for (const P of Ps) for (const p of P) { if (p.x < mx0) mx0 = p.x; if (p.x > mx1) mx1 = p.x; if (p.y < my0) my0 = p.y; if (p.y > my1) my1 = p.y; }
  const mg = Math.ceil(soft + 2);
  const box = clipBox(buf, mx0 - mg, my0 - mg, mx1 + mg, my1 + mg);
  if (!box) return;
  const [bx, by, bw, bh] = box;
  const N = bw * bh;
  scratch(N);
  if (DIN.length < N) { DIN = new Float32Array(Math.ceil(N * 1.25)); DOUT = new Float32Array(Math.ceil(N * 1.25)); }
  if (TMPA.length < N) TMPA = new Float32Array(Math.ceil(N * 1.25));
  SCA.fill(0, 0, N);
  for (const Q of Ps) {
    rasterPoly(Q, bx + buf.x0, by + buf.y0, bw, bh, TMPA);
    for (let q = 0; q < N; q++) if (TMPA[q] > SCA[q]) SCA[q] = TMPA[q];
  }
  if (soft > 0) chamfer(SCA, bw, bh, false, soft + 1, DOUT);
  const D = buf.d, W = buf.w;
  for (let yy = 0; yy < bh; yy++) {
    for (let xx = 0; xx < bw; xx++) {
      const q = yy * bw + xx;
      let c = SCA[q] > 1 ? 1 : SCA[q];
      if (soft > 0 && c < 0.5) { const f = 0.5 * (1 - ss(0, soft, DOUT[q])); if (f > c) c = f; }
      if (c <= 0) continue;
      const kk = (by + yy) * W + bx + xx;
      D[kk] *= 1 - k * (c > 1 ? 1 : c);
    }
  }
}

// ---------------------------------------------------------------------------
// 蒙版印墨（文字、预先画好的剪影）
// ---------------------------------------------------------------------------
/** 用字体栅格化文字 → 灰度蒙版。vertical：竖排（从上往下） */
export function textMask(text, font, { size = 40, vertical = false, gap = 0.08 } = {}) {
  const chars = [...text];
  const step = size * (1 + gap);
  const w = Math.ceil(vertical ? size * 1.3 : step * chars.length + size * 0.3);
  const h = Math.ceil(vertical ? step * chars.length + size * 0.3 : size * 1.3);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000'; g.textBaseline = 'middle'; g.textAlign = 'center';
  g.font = `${size}px ${font}`;
  chars.forEach((ch, i) => {
    if (ch === ' ' || ch === '　') return;
    if (vertical) g.fillText(ch, w / 2, size * 0.65 + i * step);
    else g.fillText(ch, size * 0.65 + i * step, h / 2);
  });
  const d = g.getImageData(0, 0, w, h).data;
  const m = new Float32Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] / 255;
  return { m, w, h, step, n: chars.length };
}
/** 把蒙版 m（mw×mh，0..1）印到 (x,y)（左上角）；tfn(lx, ly) → 0..1 到达时间分布（蒙版局部坐标） */
export function stampMask(buf, m, mw, mh, x, y, o = {}) {
  if (!buf) return;
  const tone = o.tone ?? 0.85, halo = o.halo ?? 1.5, haloK = o.haloK ?? 0.3, gran = o.gran ?? 0.15;
  const timed = !!(buf.t && o.t0 !== undefined);
  const t0 = o.t0 ?? 0, t1 = o.t1 ?? t0, tfn = o.tfn || null, haloDelay = o.haloDelay ?? 0.15;
  const hx = Math.ceil(halo) + 1;
  const box = clipBox(buf, x - hx, y - hx, x + mw + hx, y + mh + hx);
  if (!box) return;
  const [bx, by, bw, bh] = box;
  scratch(bw * bh);
  SCR.fill(0, 0, bw * bh);
  if (timed) SCT.fill(1e9, 0, bw * bh);
  const ix0 = Math.round(x), iy0 = Math.round(y);
  const at = (lx, ly) => (lx < 0 || ly < 0 || lx >= mw || ly >= mh ? 0 : m[ly * mw + lx]);
  for (let yy = 0; yy < bh; yy++) {
    for (let xx = 0; xx < bw; xx++) {
      const wx = bx + xx + buf.x0, wy = by + yy + buf.y0;
      const lx = wx - ix0, ly = wy - iy0;
      const c = at(lx, ly);
      let val = 0, isHalo = false;
      if (c > 0.002) {
        val = tone * c * (gran > 0 ? 1 - gran * (0.62 - fiberAt(wx, wy)) : 1);
      }
      if (halo > 0 && c < 0.6) {
        // 邻域最大值近似晕开
        let nb = 0;
        const hr = Math.ceil(halo);
        for (let j = -hr; j <= hr; j += hr) for (let i = -hr; i <= hr; i += hr) { const q = at(lx + i, ly + j); if (q > nb) nb = q; }
        const f = fiberAt(wx, wy);
        const hv = tone * haloK * nb * ss(0.35, 0.75, f);
        if (hv > val) { val = hv; isHalo = true; }
      }
      if (val <= 0) continue;
      const k = yy * bw + xx;
      SCR[k] = val;
      if (timed) SCT[k] = t0 + (t1 - t0) * (tfn ? tfn(lx, ly) : 0) + (isHalo ? haloDelay : 0);
    }
  }
  commit(buf, bx, by, bw, bh, timed);
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
export function toCanvas(buf, rgb = PALETTE.ink) {
  const cv = document.createElement('canvas'); cv.width = buf.w; cv.height = buf.h;
  const g = cv.getContext('2d');
  const img = g.createImageData(buf.w, buf.h);
  const d = img.data;
  for (let i = 0, j = 0; i < buf.d.length; i++, j += 4) {
    d[j] = rgb[0]; d[j + 1] = rgb[1]; d[j + 2] = rgb[2];
    d[j + 3] = Math.round(cl01(buf.d[i]) * 255);
  }
  g.putImageData(img, 0, 0);
  return cv;
}
/**
 * 把 buf 写进 RGBA 字节数组 dst（dw×dh）的通道 ch（0..3）。buf 的 (sx, sy) 像素落到 dst 的 (0,0)。
 * mode 'd'：墨量；mode 't'：到达时间，按 [tmin, tmax] 归一化（没到达 = 255）
 */
export function packChannel(buf, dst, dw, dh, ch, sx = 0, sy = 0, mode = 'd', tmin = 0, tmax = 1) {
  const src = mode === 't' ? buf.t : buf.d;
  const inv = 1 / Math.max(1e-6, tmax - tmin);
  for (let y = 0; y < dh; y++) {
    const yy = y + sy;
    if (yy < 0 || yy >= buf.h) continue;
    let k = yy * buf.w + sx, j = (y * dw) * 4 + ch;
    for (let x = 0; x < dw; x++, k++, j += 4) {
      const xx = x + sx;
      if (xx < 0 || xx >= buf.w) continue;
      const v = src[k];
      if (mode === 't') dst[j] = v > 1e8 ? 255 : Math.round(cl01((v - tmin) * inv) * 254);
      else dst[j] = Math.round(cl01(v) * 255);
    }
  }
}

// ---------------------------------------------------------------------------
// 白鲟（Psephurus gladius）
// ---------------------------------------------------------------------------
// 单位长度 1：吻尖 x=0，尾鳍上叶末端 x=1；y 向下为正，身体中线约 y=0。头朝左。
// 形态要点：扁平剑形长吻约占全长 1/3，根部宽、尖端细；眼极小，在吻根；口大、下位；
// 鳃盖后缘拖成一个长长的尖角皮瓣；背鳍很靠后，与臀鳍上下相对；歪尾，上叶长而上翘；身体光滑无鳞，背深腹浅。
export const PADDLEFISH = {
  top: [[0.0, -0.011], [0.07, -0.014], [0.15, -0.017], [0.23, -0.021], [0.30, -0.026], [0.335, -0.030],
    [0.37, -0.040], [0.41, -0.053], [0.45, -0.063], [0.50, -0.071], [0.56, -0.076], [0.62, -0.076],
    [0.68, -0.071], [0.745, -0.060], [0.80, -0.046], [0.85, -0.034], [0.878, -0.029]],
  bottom: [[0.0, -0.008], [0.07, -0.006], [0.15, -0.004], [0.23, -0.001], [0.30, 0.002], [0.335, 0.005],
    [0.36, 0.012], [0.40, 0.027], [0.44, 0.041], [0.48, 0.053], [0.54, 0.063], [0.60, 0.068], [0.66, 0.066],
    [0.72, 0.058], [0.78, 0.046], [0.83, 0.034], [0.878, 0.022]],
  rostrumBase: 0.335,
  eye: [0.352, -0.012, 0.0042],
  mouth: [[0.337, 0.007], [0.37, 0.015], [0.405, 0.024], [0.44, 0.031]],
  gill: [[0.465, -0.062], [0.487, -0.035], [0.50, -0.008], [0.505, 0.012], [0.54, 0.020], [0.585, 0.028], [0.635, 0.036]],
  gillLow: [[0.635, 0.036], [0.59, 0.038], [0.545, 0.041], [0.505, 0.047], [0.49, 0.054]],
  pectoral: [[0.515, 0.052], [0.555, 0.07], [0.61, 0.095], [0.585, 0.074], [0.55, 0.06]],
  pelvic: [[0.69, 0.064], [0.715, 0.078], [0.745, 0.095], [0.73, 0.074], [0.715, 0.061]],
  dorsal: [[0.745, -0.060], [0.78, -0.088], [0.82, -0.115], [0.81, -0.08], [0.812, -0.043]],
  anal: [[0.765, 0.048], [0.8, 0.066], [0.848, 0.085], [0.836, 0.058], [0.83, 0.035]],
  tailUp: [[0.878, -0.029], [0.915, -0.043], [0.955, -0.066], [1.0, -0.104]],
  tailUpLow: [[1.0, -0.104], [0.97, -0.066], [0.945, -0.035], [0.925, -0.008]],
  tailLow: [[0.925, -0.008], [0.945, 0.026], [0.967, 0.066]],
  tailLowBot: [[0.967, 0.066], [0.93, 0.043], [0.9, 0.030], [0.878, 0.022]],
  lateral: [[0.51, -0.02], [0.6, -0.017], [0.7, -0.012], [0.8, -0.007], [0.87, -0.004]],
};
function outlinePoly(G) {
  return [...G.top, ...G.tailUp.slice(1), ...G.tailUpLow.slice(1), ...G.tailLow.slice(1), ...G.tailLowBot.slice(1, -1), ...[...G.bottom].reverse()];
}
/**
 * 画一条白鲟。x,y = 吻尖位置，L = 全长 px。o.dir：-1 头朝左（默认），1 头朝右。
 * o.style 'xieyi'（写意，十来笔）| 'gongbi'（工笔图谱：细笔勾线 + 淡墨分染）| 'silhouette'（极小时用：一抹墨）
 */
export function paddlefish(buf, x, y, L, o = {}) {
  if (!buf) return;
  const dir = o.dir ?? -1, style = o.style ?? 'xieyi', tone = o.tone ?? 0.85, seed = o.seed ?? 1;
  const ang = o.ang ?? 0; // 身体倾角（弧度，正 = 头朝下）
  const G = PADDLEFISH;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  // 鱼的局部坐标 → 世界坐标（头朝左：x + rx；头朝右：镜像成 x - rx）
  const TX = (p, pr = 1) => {
    const lx = p[0] * L, ly = p[1] * L;
    const rx = lx * ca - ly * sa, ry = lx * sa + ly * ca;
    return [dir === 1 ? x - rx : x + rx, y + ry, pr];
  };
  const tm = o.t0 !== undefined ? o : null;
  const R0 = rng(seed * 101 + 11);
  let si = 0;
  const S = () => seed * 1000 + (si++) * 17;
  // 到达时间：按笔顺均分
  const nStrokes = style === 'gongbi' ? 40 : 16;
  const tw = (k0, k1) => (tm ? { t0: o.t0 + (o.t1 - o.t0) * (k0 / nStrokes), t1: o.t0 + (o.t1 - o.t0) * (k1 / nStrokes) } : {});
  if (style === 'silhouette') {
    wash(buf, outlinePoly(G).map((p) => TX(p)), { tone: tone * 0.55, rim: 0.4, jag: 0.6, jagScale: 10, bleed: 1.5, gran: 0.2, seed: S(), ...tw(0, 16) });
    stroke(buf, [TX([0.34, -0.02]), TX([0.0, -0.01])], { w: Math.max(1, L * 0.024), tone: tone * 0.7, seed: S(), tail: 0.9, ...tw(0, 4) });
    return;
  }
  if (style === 'xieyi') {
    const w = L;
    const top = (xx) => interpY(G.top, xx), bot = (xx) => interpY(G.bottom, xx);
    const small = L < 150;
    // 0. 身体：湿墨没骨一块，背深腹浅（后面的笔落在湿底上）
    const bodyP = [];
    for (let xx = 0.345; xx <= 0.879; xx += 0.015) bodyP.push(TX([xx, top(xx)]));
    for (let xx = 0.879; xx >= 0.345; xx -= 0.015) bodyP.push(TX([xx, bot(xx) - 0.002]));
    const yTB = (wx) => { const lx = Math.min(0.879, Math.max(0.345, (dir === 1 ? x - wx : wx - x) / L)); return [y + top(lx) * L, y + bot(lx) * L, lx]; };
    wash(buf, bodyP, { tone: tone * 0.5, soft: 0, rim: 0.5, rimW: Math.max(1, w * 0.004), jag: w * 0.002, jagScale: w * 0.05, bleed: Math.max(1, w * 0.006), bleedK: 0.4, gran: 0.4, bloom: 0.3, bloomScale: w * 0.08, seed: S(),
      gfn: (wx, wy) => { const [a, b, lx] = yTB(wx); const q = (wy - a) / Math.max(1, b - a); return (0.12 + 0.88 * Math.pow(1 - ss(0.05, 0.85, q), 1.6)) * (1 - 0.25 * ss(0.75, 0.88, lx)); }, ...tw(0, 2) });
    // 1. 背：侧锋一笔，贴着背线，上深下浅
    stroke(buf, [TX([0.39, top(0.39) + 0.012], 0.5), TX([0.47, top(0.47) + 0.019], 0.9), TX([0.57, top(0.57) + 0.022], 1), TX([0.68, top(0.68) + 0.02], 0.85), TX([0.78, top(0.78) + 0.014], 0.55), TX([0.87, top(0.87) + 0.008], 0.25)],
      { w: w * 0.046, tone: tone * 0.9, shade: dir === -1 ? 0.7 : -0.7, dry: 0.04, dryEnd: 0.55, rim: 0.2, halo: Math.max(1, w * 0.006), haloK: 0.3, tail: 0.35, headMin: 0.55, seed: S(), ...tw(2, 4) });
    // 2. 头背：重墨
    stroke(buf, [TX([0.365, -0.034], 0.45), TX([0.4, -0.047], 0.9), TX([0.445, -0.058], 1), TX([0.49, -0.066], 0.5)],
      { w: w * 0.024, tone: tone * 0.95, dry: 0.02, dryEnd: 0.25, halo: 1, seed: S(), tail: 0.45, ...tw(4, 5) });
    // 3. 长吻：从根部向前一笔出锋
    stroke(buf, [TX([0.35, -0.0165], 0.85), TX([0.26, -0.0135], 0.72), TX([0.14, -0.0115], 0.5), TX([0.0, -0.0095], 0.14)],
      { w: w * 0.025, tone: tone * 0.75, dry: 0.04, dryEnd: 0.4, halo: 1, head: 0.03, headMin: 0.9, tail: 0.75, seed: S(), ...tw(5, 6.5) });
    // 4. 鳃盖：一道弧 + 细长的尖角皮瓣（深一层的墨块）
    stroke(buf, [TX([0.463, -0.058], 0.45), TX([0.483, -0.033], 0.85), TX([0.495, -0.006], 1), TX([0.5, 0.02], 0.7), TX([0.492, 0.045], 0.3)],
      { w: w * 0.011, tone: tone * 0.8, dry: 0.04, dryEnd: 0.45, halo: 1, tail: 0.4, seed: S(), ...tw(6.5, 7.5) });
    wash(buf, [TX([0.497, 0.006]), TX([0.54, 0.018]), TX([0.59, 0.027]), TX([0.638, 0.036]), TX([0.59, 0.036]), TX([0.545, 0.038]), TX([0.5, 0.04])],
      { tone: tone * 0.42, rim: 0.4, rimW: 1, jag: w * 0.0015, jagScale: w * 0.03, bleed: 1, gran: 0.3, seed: S(), ...tw(7.5, 8) });
    // 5. 口裂、眼（极小）
    if (!small) stroke(buf, [TX([0.338, 0.007], 0.6), TX([0.38, 0.017], 1), TX([0.43, 0.029], 0.35)], { w: w * 0.006, tone: tone * 0.55, seed: S(), tail: 0.5, ...tw(8, 8.5) });
    const ep = TX([0.357, -0.007]);
    dot(buf, ep[0], ep[1], Math.max(0.7, w * 0.004), { tone: tone, halo: 0.4, rim: 0, seed: S(), ...tw(8.5, 9) });
    // 6. 鳍：背鳍、臀鳍上下相对（重），胸鳍、腹鳍（淡、小）
    stroke(buf, [TX([0.748, -0.052], 1), TX([0.785, -0.084], 0.75), TX([0.82, -0.113], 0.18)], { w: w * 0.023, tone: tone * 0.88, tail: 0.6, dry: 0.08, dryEnd: 0.5, seed: S(), halo: 1, ...tw(9, 10) });
    stroke(buf, [TX([0.77, 0.036], 1), TX([0.808, 0.06], 0.75), TX([0.845, 0.082], 0.18)], { w: w * 0.019, tone: tone * 0.8, tail: 0.6, dry: 0.08, dryEnd: 0.5, seed: S(), ...tw(10, 11) });
    if (!small) {
      stroke(buf, [TX([0.51, 0.045], 1), TX([0.555, 0.066], 0.75), TX([0.6, 0.087], 0.16)], { w: w * 0.015, tone: tone * 0.6, tail: 0.6, dry: 0.1, dryEnd: 0.5, seed: S(), ...tw(11, 12) });
      stroke(buf, [TX([0.688, 0.055], 1), TX([0.713, 0.07], 0.7), TX([0.736, 0.086], 0.16)], { w: w * 0.011, tone: tone * 0.5, tail: 0.6, seed: S(), ...tw(12, 12.5) });
    }
    // 7. 歪尾：上叶长而上翘，下叶短；中间一抹淡墨连起来
    wash(buf, [TX([0.87, -0.026]), TX([0.93, -0.05]), TX([0.99, -0.095]), TX([0.955, -0.035]), TX([0.93, -0.006]), TX([0.955, 0.055]), TX([0.915, 0.035]), TX([0.87, 0.02])],
      { tone: tone * 0.22, rim: 0.35, jag: w * 0.002, jagScale: w * 0.03, bleed: 1, gran: 0.4, seed: S(), ...tw(12.5, 13) });
    stroke(buf, [TX([0.85, -0.019], 1), TX([0.91, -0.04], 0.9), TX([0.955, -0.064], 0.6), TX([1.0, -0.104], 0.1)],
      { w: w * 0.03, tone: tone * 0.9, tail: 0.55, dry: 0.06, dryEnd: 0.55, halo: 1, seed: S(), ...tw(13, 14.5) });
    stroke(buf, [TX([0.862, 0.006], 1), TX([0.915, 0.03], 0.85), TX([0.967, 0.066], 0.12)],
      { w: w * 0.024, tone: tone * 0.78, tail: 0.6, dry: 0.08, dryEnd: 0.55, seed: S(), ...tw(14.5, 16) });
    return;
  }
  // ---- 工笔图谱：熟宣上先勾后染再复勾 ----
  // 分染 = 一笔淡墨沿轮廓落下、清水笔带开，一层层积出「背深腹白」；熟宣不洇，边缘干净。
  const lw = Math.max(1.2, L * 0.0027);
  // 背线、腹线按样条加密（和勾线同一条曲线，染色才不会溢出或够不着线）
  const dense = (arr) => spline(arr.map((p) => [p[0], p[1], 1]), 0.003).map((q) => [q.x, q.y]);
  const GT = dense(G.top), GB = dense(G.bottom);
  const GTU = dense(G.tailUp), GTB = dense([[0.878, 0.022], [0.9, 0.03], [0.93, 0.043], [0.967, 0.066], [1.0, 0.07]]);
  const top = (xx) => (xx <= 0.878 ? interpY(GT, xx) : interpY(GTU, xx)), bot = (xx) => (xx <= 0.878 ? interpY(GB, xx) : interpY(GTB, xx));
  // 世界坐标 → 鱼的局部坐标（单位 = 全长 L）
  const LOC = (wx, wy) => {
    const rx = dir === 1 ? x - wx : wx - x, ry = wy - y;
    return [(rx * ca + ry * sa) / L, (-rx * sa + ry * ca) / L];
  };
  // 背 → 腹的相对深度（0 = 背线，1 = 腹线）
  const depth = (lx, ly) => { const c = lx < 0 ? 0 : lx > 1 ? 1 : lx; const t = top(c), b = bot(c); return (ly - t) / Math.max(1e-4, b - t); };
  const bodyP = [];
  for (let xx = 0; xx <= 0.8791; xx += 0.004) bodyP.push(TX([xx, top(xx)]));
  for (let xx = 0.879; xx >= -0.0001; xx -= 0.004) bodyP.push(TX([xx, bot(Math.max(0, xx))]));
  // 身 + 尾一整块（背部分染一直带到尾上叶，尾柄处不留接缝）
  const tailPoly = [...G.tailUp, ...G.tailUpLow.slice(1), ...G.tailLow.slice(1), ...G.tailLowBot.slice(1)];
  const fullP = [...bodyP.slice(0, Math.ceil(bodyP.length / 2)), ...GTU.slice(1).map((p) => TX(p)), ...G.tailUpLow.slice(1).map((p) => TX(p)), ...G.tailLow.slice(1).map((p) => TX(p)),
    ...G.tailLowBot.slice(1, -1).map((p) => TX(p)), ...bodyP.slice(Math.ceil(bodyP.length / 2))];
  const WO = { rim: 0.1, rimW: 2, soft: 1.2, jag: 0.35, jagScale: 14, bleed: 0, gran: 0.34, bloom: 0.16, bloomScale: 70, streak: 0.08, streakAng: ang };
  // 1. 背部分染：五层，一层比一层窄，每层下沿不齐（清水笔一笔笔带开）；头背、尾柄更深，吻端、尾鳍渐淡
  const DL = [[1.0, 0.1], [0.78, 0.2], [0.56, 0.26], [0.36, 0.28], [0.18, 0.26]];
  DL.forEach(([q1, k], i) => {
    wash(buf, fullP, { ...WO, tone: tone * k, seed: S(), gfn: (wx, wy) => {
      const [lx, ly] = LOC(wx, wy);
      const q = depth(lx, ly);
      const qe = q1 * (0.84 + 0.32 * vn1(lx * 11 + i * 7.3));
      const along = (0.45 + 0.55 * ss(0, 0.32, lx)) * (1 + 0.18 * ss(0.33, 0.4, lx) * (1 - ss(0.47, 0.56, lx)) + 0.14 * ss(0.76, 0.88, lx)) * (1 - 0.5 * ss(0.885, 0.97, lx));
      return (1 - ss(0, qe, q)) * along;
    }, ...tw(i * 0.8, i * 0.8 + 0.8) });
  });
  // 2. 腹：沿腹线一道极淡的染，托出圆的体积（其余留白）
  wash(buf, bodyP, { ...WO, tone: tone * 0.11, seed: S(), gfn: (wx, wy) => { const [lx, ly] = LOC(wx, wy); return ss(0.74, 1.0, depth(lx, ly)) * ss(0.3, 0.42, lx); }, ...tw(4, 4.5) });
  // 3. 鳃盖：后缘外侧的身上一道阴影（鳃盖压在身上），后缘内侧淡染（鳃盖鼓起）；尖角皮瓣略深
  wash(buf, bodyP, { ...WO, tone: tone * 0.2, seed: S(), gfn: (wx, wy) => {
    const [lx, ly] = LOC(wx, wy); const [d, sd] = polyDist(lx, ly, G.gill);
    return sd < 0 ? Math.pow(1 - ss(0, 0.03, d), 1.5) * (1 - ss(0.85, 1.0, depth(lx, ly))) : 0;
  }, ...tw(4.5, 5) });
  wash(buf, bodyP, { ...WO, tone: tone * 0.1, seed: S(), gfn: (wx, wy) => {
    const [lx, ly] = LOC(wx, wy); const [d, sd] = polyDist(lx, ly, G.gill);
    return sd > 0 && lx > 0.36 ? Math.pow(1 - ss(0, 0.022, d), 1.3) : 0;
  }, ...tw(5, 5.5) });
  const flap = [...G.gill.slice(3), ...G.gillLow.slice(1)];
  wash(buf, flap.map((p) => TX(p)), { ...WO, tone: tone * 0.12, seed: S(), gfn: (wx, wy) => 1 - 0.6 * ss(0.5, 0.64, LOC(wx, wy)[0]), ...tw(5.5, 6) });
  // 4. 吻：根部略深，向前渐淡
  wash(buf, bodyP, { ...WO, tone: tone * 0.1, seed: S(), gfn: (wx, wy) => { const lx = LOC(wx, wy)[0]; return lx > 0.36 ? 0 : (0.35 + 0.65 * ss(0.02, 0.32, lx)) * (1 - ss(0.33, 0.36, lx)); }, ...tw(6, 6.5) });
  // 5. 鳍：从鳍基往外渐淡
  for (const [f, k] of [[G.dorsal, 0.2], [G.anal, 0.18], [G.pectoral, 0.15], [G.pelvic, 0.13]]) {
    const bm = [(f[0][0] + f[f.length - 1][0]) / 2, (f[0][1] + f[f.length - 1][1]) / 2], tp = f[2];
    const ax2 = tp[0] - bm[0], ay2 = tp[1] - bm[1], al2 = ax2 * ax2 + ay2 * ay2;
    wash(buf, f.map((p) => TX(p)), { ...WO, soft: 1, tone: tone * k, seed: S(), gfn: (wx, wy) => { const [lx, ly] = LOC(wx, wy); const u = ((lx - bm[0]) * ax2 + (ly - bm[1]) * ay2) / al2; return 0.2 + 0.8 * (1 - ss(0, 1, u)); }, ...tw(6.5, 7) });
  }
  // 6. 尾鳍：再薄薄一层，下叶、后缘淡
  wash(buf, tailPoly.map((p) => TX(p)), { ...WO, soft: 1, tone: tone * 0.12, seed: S(), gfn: (wx, wy) => {
    const [lx, ly] = LOC(wx, wy);
    return ss(0.87, 0.9, lx) * (0.35 + 0.65 * (1 - ss(0.9, 0.99, lx))) * (0.55 + 0.45 * (1 - ss(-0.1, 0.05, ly)));
  }, ...tw(7, 8) });
  // 7. 勾线（铁线描，略带提按：中段实、两头收）；背线重，腹线轻
  const line = (pts, k0, k1, e = {}) => {
    const n = pts.length;
    stroke(buf, pts.map((p, i) => { const u = n > 1 ? i / (n - 1) : 0.5; return TX(p, 0.7 + 0.3 * Math.sin(Math.PI * u) + 0.1 * (vn1(i * 1.7 + seed * 3.1 + k0 * 5.3) - 0.5)); }),
      { w: lw * (e.wk ?? 1), tone: tone * (e.tk ?? 0.8), dry: 0.02, dryEnd: 0.2, rim: 0.1, halo: lw * 0.35, haloK: 0.2, head: 0.06, headMin: 0.55, tail: 0.18, tailMode: 'sharp', fade: 0.12, seed: S(), rough: 0.03, fray: 0.2, wobble: 0.05, ...tw(k0, k1) });
  };
  const seg = (arr, a, b) => arr.filter((p) => p[0] >= a - 1e-6 && p[0] <= b + 1e-6);
  line(seg(G.top, 0, 0.335), 9, 11, { tk: 0.72, wk: 0.85 });
  line(seg(G.bottom, 0, 0.36), 11, 12, { tk: 0.58, wk: 0.75 });
  line(seg(G.top, 0.33, 0.62), 12, 14, { tk: 0.92, wk: 1.3 });
  line(seg(G.top, 0.6, 0.878), 14, 16, { tk: 0.88, wk: 1.15 });
  line(seg(G.bottom, 0.36, 0.66), 16, 18, { tk: 0.6, wk: 0.85 });
  line(seg(G.bottom, 0.64, 0.878), 18, 19, { tk: 0.62, wk: 0.85 });
  line(G.mouth, 19, 20, { tk: 0.72, wk: 0.8 });
  line(G.gill, 20, 22, { tk: 0.74, wk: 0.95 });
  line(G.gillLow, 22, 23, { tk: 0.52, wk: 0.72 });
  line(G.dorsal.slice(0, 3), 23, 24, { tk: 0.8 }); line(G.dorsal.slice(2), 24, 25, { tk: 0.55, wk: 0.7 });
  line(G.anal.slice(0, 3), 25, 26, { tk: 0.78 }); line(G.anal.slice(2), 26, 27, { tk: 0.55, wk: 0.7 });
  line(G.pectoral.slice(0, 3), 27, 28, { tk: 0.72, wk: 0.9 }); line(G.pectoral.slice(2), 28, 29, { tk: 0.5, wk: 0.65 });
  line(G.pelvic.slice(0, 3), 29, 30, { tk: 0.7, wk: 0.85 }); line(G.pelvic.slice(2), 30, 30.5, { tk: 0.5, wk: 0.65 });
  line(G.tailUp, 30.5, 32, { tk: 0.88, wk: 1.15 });
  line(G.tailUpLow, 32, 33, { tk: 0.62, wk: 0.75 });
  line(G.tailLow, 33, 34, { tk: 0.65, wk: 0.75 });
  line(G.tailLowBot, 34, 35, { tk: 0.66, wk: 0.85 });
  // 8. 鳍条：从鳍基斜向后放射到鳍缘，微弯，淡而细，不碰外缘
  const rays = (base0, base1, tip0, tip1, nR, bow, k0, k1) => {
    for (let i = 0; i < nR; i++) {
      const u = (i + 0.6) / (nR + 0.2);
      const b = [base0[0] + (base1[0] - base0[0]) * u, base0[1] + (base1[1] - base0[1]) * u];
      const t = [tip0[0] + (tip1[0] - tip0[0]) * u, tip0[1] + (tip1[1] - tip0[1]) * u];
      const e = [b[0] + (t[0] - b[0]) * 0.93, b[1] + (t[1] - b[1]) * 0.93];
      const m = [b[0] + (t[0] - b[0]) * 0.5 + bow * (t[1] - b[1]), b[1] + (t[1] - b[1]) * 0.5 - bow * (t[0] - b[0])];
      stroke(buf, [TX(b, 0.8), TX(m, 0.65), TX(e, 0.25)], { w: lw * 0.5, tone: tone * 0.3, dry: 0.15, dryEnd: 0.5, seed: S(), tail: 0.5, head: 0.1, halo: 0, ...tw(k0 + (k1 - k0) * u, k0 + (k1 - k0) * u + 0.2) });
    }
  };
  rays([0.749, -0.064], [0.81, -0.049], [0.815, -0.108], [0.81, -0.066], 10, 0.05, 35, 36);
  rays([0.769, 0.052], [0.828, 0.04], [0.843, 0.08], [0.833, 0.048], 9, -0.05, 36, 36.6);
  rays([0.521, 0.056], [0.548, 0.062], [0.603, 0.091], [0.578, 0.072], 7, -0.05, 36.6, 37);
  rays([0.694, 0.067], [0.713, 0.065], [0.74, 0.091], [0.726, 0.073], 5, -0.05, 37, 37.2);
  // 尾鳍条：从尾柄放射到后缘（上叶尖 → 凹缘 → 下叶尖）
  const margin = [...G.tailUpLow, ...G.tailLow.slice(1)];
  const mlen = [0];
  for (let i = 1; i < margin.length; i++) mlen.push(mlen[i - 1] + Math.hypot(margin[i][0] - margin[i - 1][0], margin[i][1] - margin[i - 1][1]));
  const mTot = mlen[mlen.length - 1];
  const onMargin = (u) => {
    const s = u * mTot;
    for (let i = 1; i < margin.length; i++) if (s <= mlen[i]) { const f = (s - mlen[i - 1]) / Math.max(1e-6, mlen[i] - mlen[i - 1]); return [margin[i - 1][0] + (margin[i][0] - margin[i - 1][0]) * f, margin[i - 1][1] + (margin[i][1] - margin[i - 1][1]) * f]; }
    return margin[margin.length - 1];
  };
  for (let i = 0; i < 16; i++) {
    const u = (i + 0.5) / 16;
    const e = onMargin(0.03 + u * 0.94), b = [0.872 + 0.016 * Math.sin(u * Math.PI) + 0.008 * (vn1(i * 3.7 + seed) - 0.5), -0.026 + 0.045 * u];
    const bb = [b[0] + (e[0] - b[0]) * 0.93, b[1] + (e[1] - b[1]) * 0.93];
    const m = [b[0] + (e[0] - b[0]) * 0.5, b[1] + (e[1] - b[1]) * 0.5 + 0.004 * (u - 0.5)];
    stroke(buf, [TX(b, 0.35), TX(m, 0.65), TX(bb, 0.2)], { w: lw * 0.48, tone: tone * 0.28, dry: 0.15, dryEnd: 0.5, seed: S(), tail: 0.5, head: 0.35, headMin: 0.1, halo: 0, ...tw(37.2 + u * 0.3, 37.4 + u * 0.3) });
  }
  // 尾上叶上缘的棘状硬鳞：一排小刻，往尾尖渐小
  for (let i = 0; i < 13; i++) {
    const u = i / 12, px = 0.882 + u * 0.11, s2 = 1 - 0.5 * u;
    const py = interpY(G.tailUp, px);
    stroke(buf, [TX([px, py - 0.0005], 1), TX([px + 0.006 * s2, py - 0.0045 * s2], 0.3)], { w: lw * 0.75, tone: tone * 0.6, seed: S(), tail: 0.6, halo: 0, ...tw(37.5, 38) });
  }
  // 侧线：一道极细的淡线（干笔，自然断续）
  stroke(buf, G.lateral.map((p, i) => TX(p, 0.8 + 0.2 * Math.sin(i * 1.7))), { w: lw * 0.45, tone: tone * 0.3, dry: 0.35, dryEnd: 0.6, seed: S(), tail: 0.4, head: 0.1, halo: 0, fade: 0.3, ...tw(38, 38.5) });
  // 吻上的感觉孔：两行细点，越往吻端越小
  for (let i = 0; i < 40; i++) {
    const u = (i + R0.f() * 0.8) / 40, px = 0.02 + u * 0.3;
    const t = top(px), b = bot(px);
    const py = t + (b - t) * ((i % 2 ? 0.34 : 0.7) + (R0.f() - 0.5) * 0.16);
    const q = TX([px, py]);
    dot(buf, q[0], q[1], lw * (0.18 + 0.24 * u) * (0.8 + 0.4 * R0.f()), { tone: tone * (0.2 + 0.15 * R0.f()), halo: 0, rim: 0.2, seed: S(), ...tw(38.5, 39) });
  }
  // 9. 眼：极小；眼眶淡染、细圈、点睛，留一点高光
  const e = TX([G.eye[0], G.eye[1]]), er = G.eye[2] * L;
  dot(buf, e[0], e[1], er * 1.6, { tone: tone * 0.14, soft: er * 0.8, rim: 0, halo: 0, jag: 0.05, seed: S(), ...tw(39, 39.3) });
  stroke(buf, circlePts(e[0], e[1], er, 12), { w: lw * 0.7, tone: tone * 0.7, seed: S(), tail: 0.1, head: 0.1, halo: 0, ...tw(39.3, 39.6) });
  dot(buf, e[0], e[1], er * 0.6, { tone, halo: 0, rim: 0.1, jag: 0.05, seed: S(), ...tw(39.6, 40) });
  if (!tm) erase(buf, circlePts(e[0] - er * 0.22, e[1] - er * 0.25, er * 0.2, 8), { soft: 0.6, jag: 0 });
}
/** 点到折线的距离与所在侧（叉积符号；局部坐标） */
function polyDist(px, py, pl) {
  let best = 1e9, side = 0;
  for (let i = 0; i < pl.length - 1; i++) {
    const ax = pl[i][0], ay = pl[i][1], dx = pl[i + 1][0] - ax, dy = pl[i + 1][1] - ay, l2 = dx * dx + dy * dy;
    if (l2 < 1e-12) continue;
    let u = ((px - ax) * dx + (py - ay) * dy) / l2; u = u < 0 ? 0 : u > 1 ? 1 : u;
    const d = Math.hypot(px - ax - u * dx, py - ay - u * dy);
    if (d < best) { best = d; side = dx * (py - ay) - dy * (px - ax); }
  }
  return [best, side];
}
function interpY(arr, x) {
  if (x <= arr[0][0]) return arr[0][1];
  for (let i = 1; i < arr.length; i++) {
    if (x <= arr[i][0]) { const a = arr[i - 1], b = arr[i]; const t = (x - a[0]) / Math.max(1e-6, b[0] - a[0]); return a[1] + (b[1] - a[1]) * t; }
  }
  return arr[arr.length - 1][1];
}
function circlePts(cx, cy, r, n) { const out = []; for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2 - 0.5; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1]); } return out; }

// ---------------------------------------------------------------------------
// 写意人物（几笔墨，不画五官）
// ---------------------------------------------------------------------------
export function figure(buf, x, y, h, o = {}) {
  if (!buf) return;
  const pose = o.pose ?? 'stand', dir = o.dir ?? 1, tone = o.tone ?? 0.85, seed = o.seed ?? 1;
  const tm = o.t0 !== undefined ? o : null;
  const tw = (a, b) => (tm ? { t0: o.t0 + (o.t1 - o.t0) * a, t1: o.t0 + (o.t1 - o.t0) * b } : {});
  const R0 = rng(seed * 57 + 1);
  const P = (dx, dy, p = 1) => [x + dir * dx * h, y + dy * h, p];
  const lean = (o.lean ?? 0) + R0.r(-0.03, 0.03);
  const hr = h * 0.075;
  if (pose === 'sit') {
    // 坐：一团衣袍 + 头
    stroke(buf, [P(-0.02 + lean, -0.58, 0.5), P(0.02 + lean, -0.4, 1), P(0.08, -0.14, 1), P(0.12, 0.0, 0.7)], { w: h * 0.34, tone: tone * 0.8, dry: 0.1, dryEnd: 0.5, tail: 0.4, halo: 1.5, seed: seed * 3 + 1, rough: 0.14, ...tw(0.2, 0.7) });
    stroke(buf, [P(-0.14, -0.04, 0.8), P(0.06, 0.0, 1), P(0.24, 0.0, 0.4)], { w: h * 0.12, tone: tone * 0.7, dry: 0.15, dryEnd: 0.6, seed: seed * 3 + 2, ...tw(0.7, 1) });
    dot(buf, ...P(0.0 + lean, -0.7).slice(0, 2), hr, { tone, seed: seed * 3 + 3, ...tw(0, 0.2) });
    if (o.hat) stroke(buf, [P(-0.12, -0.74, 0.4), P(0.0, -0.79, 1), P(0.13, -0.74, 0.4)], { w: h * 0.06, tone, seed: seed * 3 + 4, tail: 0.4, ...tw(0.1, 0.2) });
    return;
  }
  if (pose === 'row') {
    // 划船/撑篙：身体前倾，一根长篙
    stroke(buf, [P(-0.05, -0.8, 0.6), P(0.05 + lean, -0.5, 1), P(0.04, -0.2, 0.9), P(0.0, 0.0, 0.6)], { w: h * 0.22, tone: tone * 0.85, dry: 0.08, dryEnd: 0.45, tail: 0.3, halo: 1.2, seed: seed * 3 + 1, rough: 0.12, ...tw(0.2, 0.6) });
    dot(buf, ...P(-0.08, -0.88).slice(0, 2), hr, { tone, seed: seed * 3 + 3, ...tw(0, 0.2) });
    const pl = o.pole ?? 1.5;
    stroke(buf, [P(0.3, -1.0, 0.7), P(-0.05, -0.55, 1), P(-0.35 * pl, 0.45 * pl, 0.6)], { w: Math.max(1.2, h * 0.03), tone: tone * 0.75, dry: 0.2, dryEnd: 0.6, tail: 0.3, seed: seed * 3 + 5, ...tw(0.6, 1) });
    if (o.hat) stroke(buf, [P(-0.22, -0.9, 0.4), P(-0.08, -0.97, 1), P(0.07, -0.9, 0.4)], { w: h * 0.06, tone, seed: seed * 3 + 4, tail: 0.4, ...tw(0.1, 0.2) });
    return;
  }
  if (pose === 'bend') {
    stroke(buf, [P(-0.2, -0.62, 0.6), P(0.0, -0.66, 1), P(0.1, -0.4, 1), P(0.12, 0.0, 0.5)], { w: h * 0.22, tone: tone * 0.85, dry: 0.08, dryEnd: 0.5, tail: 0.3, halo: 1.2, seed: seed * 3 + 1, rough: 0.12, ...tw(0.2, 0.7) });
    dot(buf, ...P(-0.27, -0.6).slice(0, 2), hr, { tone, seed: seed * 3 + 3, ...tw(0, 0.2) });
    stroke(buf, [P(-0.12, -0.6, 0.8), P(-0.3, -0.35, 0.6)], { w: h * 0.06, tone: tone * 0.8, seed: seed * 3 + 6, ...tw(0.7, 1) });
    return;
  }
  // 站 / 扛
  stroke(buf, [P(0.0 + lean, -0.84, 0.55), P(0.02 + lean * 0.6, -0.6, 1), P(0.03, -0.3, 1), P(0.05, 0.0, 0.8)], { w: h * 0.2, tone: tone * 0.85, dry: 0.08, dryEnd: 0.45, tail: 0.25, tailMode: 'round', halo: 1.2, seed: seed * 3 + 1, rough: 0.12, ...tw(0.2, 0.7) });
  stroke(buf, [P(-0.01 + lean, -0.05, 0.6), P(0.1, 0.0, 1), P(0.16, 0.0, 0.5)], { w: h * 0.07, tone: tone * 0.7, seed: seed * 3 + 2, ...tw(0.7, 0.8) });
  dot(buf, ...P(lean, -0.93).slice(0, 2), hr, { tone, seed: seed * 3 + 3, ...tw(0, 0.2) });
  if (o.hat) stroke(buf, [P(-0.13 + lean, -0.97, 0.4), P(lean, -1.03, 1), P(0.13 + lean, -0.97, 0.4)], { w: h * 0.06, tone, seed: seed * 3 + 4, tail: 0.4, ...tw(0.1, 0.2) });
  if (pose === 'carry') stroke(buf, [P(-0.45, -0.8, 0.6), P(0.0, -0.8, 1), P(0.45, -0.78, 0.6)], { w: Math.max(1.2, h * 0.03), tone: tone * 0.8, seed: seed * 3 + 5, tail: 0.2, ...tw(0.8, 1) });
  else stroke(buf, [P(0.02 + lean, -0.7, 0.8), P(0.12 + lean, -0.52, 0.9), P(0.16, -0.4, 0.5)], { w: h * 0.06, tone: tone * 0.75, seed: seed * 3 + 6, ...tw(0.8, 1) });
}

// ---------------------------------------------------------------------------
// 树
// ---------------------------------------------------------------------------
/** 点叶树：x,y 根部，h 高 */
export function tree(buf, x, y, h, o = {}) {
  if (!buf) return;
  const tone = o.tone ?? 0.8, seed = o.seed ?? 1, R0 = rng(seed * 41 + 9);
  const lean = o.lean ?? R0.r(-0.12, 0.12);
  const tm = o.t0 !== undefined ? o : null;
  const tw = (a, b) => (tm ? { t0: o.t0 + (o.t1 - o.t0) * a, t1: o.t0 + (o.t1 - o.t0) * b } : {});
  const top = [x + lean * h, y - h];
  // 树干：两笔
  const mid = [x + lean * h * 0.4 + R0.r(-0.05, 0.05) * h, y - h * 0.5];
  stroke(buf, [[x, y, 1], [mid[0], mid[1], 0.8], [top[0], top[1], 0.3]], { w: h * 0.07, tone: tone * 0.85, dry: 0.25, dryEnd: 0.7, tail: 0.5, halo: 1, seed: seed * 5 + 1, rough: 0.15, ...tw(0, 0.25) });
  // 枝
  const nb = o.branches ?? 5;
  const tips = [];
  for (let i = 0; i < nb; i++) {
    const u = 0.35 + 0.6 * (i / Math.max(1, nb - 1)) + R0.r(-0.05, 0.05);
    const bx = x + (top[0] - x) * u, by = y - h * u;
    const side = i % 2 === 0 ? -1 : 1;
    const len = h * R0.r(0.2, 0.38) * (1.1 - u * 0.5);
    const ex = bx + side * len * R0.r(0.7, 1), ey = by - len * R0.r(0.3, 0.8);
    stroke(buf, [[bx, by, 0.8], [(bx + ex) / 2, (by + ey) / 2 + len * 0.1, 0.6], [ex, ey, 0.2]], { w: h * 0.03, tone: tone * 0.8, dry: 0.2, dryEnd: 0.6, tail: 0.5, seed: seed * 5 + 10 + i, ...tw(0.25, 0.4) });
    tips.push([ex, ey]);
  }
  tips.push(top);
  // 点叶：成团的点
  const leaf = o.leaf ?? 'dot';
  const nd = o.dots ?? Math.round(h * 0.9);
  for (let i = 0; i < nd; i++) {
    const t = tips[i % tips.length];
    const rr = h * R0.r(0.02, 0.2);
    const a = R0.r(0, 6.283);
    const px = t[0] + Math.cos(a) * rr * 1.3, py = t[1] + Math.sin(a) * rr * 0.8;
    const k = 0.4 + 0.6 * i / nd;
    if (leaf === 'dot') dot(buf, px, py, h * R0.r(0.012, 0.024), { tone: tone * R0.r(0.5, 0.95), ax: R0.r(1, 1.8), ang: R0.r(-0.5, 0.5), seed: seed * 97 + i, halo: 1.2, ...tw(0.4 + 0.6 * k - 0.05, 0.4 + 0.6 * k) });
    else {
      const ang = R0.r(-2.5, -0.6), l = h * R0.r(0.03, 0.06);
      stroke(buf, [[px, py, 1], [px + Math.cos(ang) * l, py + Math.sin(ang) * l, 0.2]], { w: h * 0.025, tone: tone * R0.r(0.5, 0.95), tail: 0.7, seed: seed * 97 + i, ...tw(0.4 + 0.6 * k - 0.05, 0.4 + 0.6 * k) });
    }
  }
}
/** 柳：垂条 */
export function willow(buf, x, y, h, o = {}) {
  if (!buf) return;
  const tone = o.tone ?? 0.75, seed = o.seed ?? 1, R0 = rng(seed * 43 + 3);
  const lean = o.lean ?? R0.r(-0.15, 0.15);
  const top = [x + lean * h, y - h];
  stroke(buf, [[x, y, 1], [x + lean * h * 0.3, y - h * 0.45, 0.9], [top[0], top[1], 0.4]], { w: h * 0.09, tone: tone * 0.9, dry: 0.3, dryEnd: 0.75, rough: 0.2, halo: 1, seed: seed * 5 + 1 });
  // 树干上的节疤
  for (let i = 0; i < 4; i++) dot(buf, x + lean * h * (0.2 + i * 0.2) + R0.r(-2, 2), y - h * (0.2 + i * 0.2), h * 0.012, { tone: tone, seed: seed * 7 + i });
  const nb = o.strands ?? 26;
  for (let i = 0; i < nb; i++) {
    const u = R0.r(0.55, 1.0);
    const sx = x + (top[0] - x) * u + R0.r(-0.2, 0.2) * h, sy = y - h * u + R0.r(-0.05, 0.1) * h;
    const len = h * R0.r(0.3, 0.7);
    const sway = R0.r(-0.12, 0.12) * h;
    stroke(buf, [[sx, sy, 0.3], [sx + sway * 0.3, sy + len * 0.2, 0.7], [sx + sway * 0.8, sy + len * 0.6, 0.6], [sx + sway, sy + len, 0.15]],
      { w: Math.max(0.9, h * 0.011), tone: tone * R0.r(0.35, 0.8), dry: 0.15, dryEnd: 0.5, head: 0.2, tail: 0.4, seed: seed * 11 + i });
    // 柳叶：沿垂条的细点
    const nl = Math.round(len / (h * 0.05));
    for (let j = 0; j < nl; j++) {
      const v = (j + 0.5) / nl;
      const lx = sx + sway * v * v * 0.95 + R0.r(-1, 1), ly = sy + len * v;
      if (R0.f() < 0.6) dot(buf, lx, ly, Math.max(0.8, h * 0.008), { tone: tone * R0.r(0.3, 0.7), ax: 2.2, ang: 1.3 + R0.r(-0.3, 0.3), seed: seed * 13 + i * 50 + j, halo: 0.8 });
    }
  }
}
/** 松：虬干 + 针叶团 */
export function pine(buf, x, y, h, o = {}) {
  if (!buf) return;
  const tone = o.tone ?? 0.85, seed = o.seed ?? 1, R0 = rng(seed * 47 + 5);
  const lean = o.lean ?? R0.r(-0.25, 0.25);
  const pts = [[x, y, 1]];
  for (let i = 1; i <= 5; i++) pts.push([x + lean * h * (i / 5) + Math.sin(i * 1.7 + seed) * h * 0.05, y - h * (i / 5), 1 - i * 0.12]);
  stroke(buf, pts, { w: h * 0.075, tone: tone * 0.85, dry: 0.35, dryEnd: 0.75, rough: 0.2, halo: 1, seed: seed * 5 + 1 });
  // 鳞皮：干上的小圈点
  for (let i = 0; i < 10; i++) { const p = pts[1 + (i % 4)]; dot(buf, p[0] + R0.r(-h * 0.025, h * 0.025), p[1] + R0.r(-h * 0.08, h * 0.08), h * 0.01, { tone: tone * 0.6, ax: 1.6, seed: seed * 9 + i }); }
  // 针叶团：扇形短线
  const nclus = o.clusters ?? 5;
  for (let c = 0; c < nclus; c++) {
    const p = pts[2 + (c % 4)];
    const side = c % 2 === 0 ? -1 : 1;
    const bx = p[0] + side * h * R0.r(0.1, 0.3), by = p[1] - h * R0.r(0.0, 0.08);
    stroke(buf, [[p[0], p[1], 0.7], [bx, by, 0.3]], { w: h * 0.03, tone: tone * 0.8, dry: 0.3, seed: seed * 17 + c });
    const nn = 16;
    for (let k = 0; k < nn; k++) {
      const a = -Math.PI * (0.15 + 0.7 * (k / (nn - 1))) + R0.r(-0.1, 0.1);
      const l = h * R0.r(0.05, 0.09);
      stroke(buf, [[bx, by, 1], [bx + Math.cos(a) * l, by + Math.sin(a) * l * 0.6, 0.3]], { w: Math.max(0.8, h * 0.008), tone: tone * R0.r(0.6, 0.95), tail: 0.5, seed: seed * 19 + c * 40 + k });
    }
    wash(buf, [[bx - h * 0.1, by - h * 0.01], [bx, by - h * 0.07], [bx + h * 0.1, by - h * 0.01], [bx, by + h * 0.015]], { tone: tone * 0.2, soft: 3, jag: 2, rim: 0.3, seed: seed * 23 + c });
  }
}

// ---------------------------------------------------------------------------
// 山
// ---------------------------------------------------------------------------
/** 生成山脊线（从左到右），x0..x1，基线 y，峰高 h，返回点列 */
export function ridge(x0, x1, y, h, o = {}) {
  const R0 = rng(o.seed ?? 1);
  const peaks = o.peaks ?? 2;
  const n = Math.max(8, Math.round((x1 - x0) / (o.step ?? 12)));
  const ph = R0.f() * 1000;
  const pk = [];
  for (let i = 0; i < peaks; i++) pk.push({ c: R0.r(0.15, 0.85), w: R0.r(0.18, 0.4), a: R0.r(0.55, 1) });
  pk.sort((a, b) => a.c - b.c);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    let e = 0;
    for (const p of pk) { const d = (u - p.c) / p.w; e = Math.max(e, p.a * Math.exp(-d * d * 1.6)); }
    const env = Math.sin(Math.PI * u) ** (o.sharp ?? 0.6);
    const ns = (fbn(u * (o.rough ?? 6) + ph, ph * 0.3, 3) - 0.5) * 0.35;
    out.push([x0 + (x1 - x0) * u, y - h * env * Math.max(0, e + ns * e)]);
  }
  return out;
}
/**
 * 山：x0..x1 宽度，baseY 山脚，h 高。
 * o.style：'far' 远山（淡墨层层积染，无勾）· 'mid' 中景（染 + 淡勾 + 披麻皴 + 苔点）· 'near' 近景石山（重勾 + 皴 + 点）
 */
export function mountain(buf, x0, x1, baseY, h, o = {}) {
  if (!buf) return;
  const style = o.style ?? 'mid', tone = o.tone ?? 0.5, seed = o.seed ?? 1, R0 = rng(seed * 61 + 7);
  const tm = o.t0 !== undefined ? o : null;
  const tw = (a, b) => (tm ? { t0: o.t0 + (o.t1 - o.t0) * a, t1: o.t0 + (o.t1 - o.t0) * b } : {});
  const rg = o.ridge || ridge(x0, x1, baseY, h, { seed, peaks: o.peaks ?? 2, rough: o.rough ?? 6, sharp: o.sharp ?? 0.6 });
  const fadeH = o.fadeH ?? 0.75; // 山脚没入雾中的比例
  const topY = Math.min(...rg.map((p) => p[1]));
  const gv = (wx, wy) => { // 上深下淡：离脊线越远越淡
    const ry = ridgeYAt(rg, wx);
    const dd = (wy - ry) / Math.max(10, (baseY - ry));
    return Math.pow(1 - ss(0, fadeH, dd), 1.4);
  };
  const poly = [...rg, [x1, baseY + 2], [x0, baseY + 2]];
  const tfnUp = tm ? (wx, wy) => Math.min(1, Math.max(0, (baseY - wy) / Math.max(1, baseY - topY))) : null; // 从山脚长到山顶
  if (style === 'far') {
    const layers = o.layers ?? 3;
    for (let i = 0; i < layers; i++) {
      const k = i / Math.max(1, layers - 1);
      const sh = rg.map((p) => [p[0], p[1] + (baseY - p[1]) * k * 0.28]);
      wash(buf, [...sh, [x1, baseY + 2], [x0, baseY + 2]], { tone: tone * (0.45 + 0.25 * k), gfn: gv, soft: 2, rim: 0.45, rimW: 2.5, jag: 1.8, jagScale: 26, bleed: 3, bleedK: 0.5, gran: 0.4, bloom: 0.35, bloomScale: 90, seed: seed * 3 + i, tfn: tfnUp, ...tw(k * 0.5, 0.5 + k * 0.5) });
    }
    return;
  }
  // 中景 / 近景：先染，后勾，再皴，最后点苔
  wash(buf, poly, { tone: tone * 0.55, gfn: gv, soft: 3, rim: 0.35, jag: 1.5, jagScale: 22, bleed: 2.5, gran: 0.45, bloom: 0.4, bloomScale: 70, streak: 0.18, streakAng: 1.35, seed: seed * 3, tfn: tfnUp, ...tw(0, 0.6) });
  const cw = style === 'near' ? 5 : 2.8;
  // 脊线分几段勾
  const nseg = 3;
  for (let s = 0; s < nseg; s++) {
    const a = Math.floor((s / nseg) * (rg.length - 1)), b = Math.floor(((s + 1) / nseg) * (rg.length - 1)) + 1;
    const segp = rg.slice(a, Math.min(rg.length, b + 1)).filter((_, i, arr) => i % 2 === 0 || i === arr.length - 1).map((p, i) => [p[0], p[1] + R0.r(-0.5, 0.5), 0.6 + 0.4 * Math.sin(i + s)]);
    if (segp.length < 2) continue;
    stroke(buf, segp, { w: cw, tone: tone * 1.3, dry: 0.25, dryEnd: 0.65, rough: 0.2, halo: 1.5, seed: seed * 7 + s, tail: 0.3, ...tw(0.1 + s * 0.12, 0.25 + s * 0.12) });
  }
  // 披麻皴：从脊线顺坡往下的长线
  const ncun = o.cun ?? Math.round((x1 - x0) / 14);
  for (let i = 0; i < ncun; i++) {
    const u = R0.r(0.03, 0.97);
    const sx = x0 + (x1 - x0) * u;
    const sy = ridgeYAt(rg, sx) + R0.r(2, 14);
    const len = (baseY - sy) * R0.r(0.2, 0.55);
    if (len < 8) continue;
    const slope = (ridgeYAt(rg, sx + 4) - ridgeYAt(rg, sx - 4)) / 8;
    const dxs = -slope * len * 0.35 + R0.r(-4, 4);
    stroke(buf, [[sx, sy, 0.6], [sx + dxs * 0.5, sy + len * 0.5, 1], [sx + dxs, sy + len, 0.3]],
      { w: style === 'near' ? R0.r(2, 4) : R0.r(1.4, 2.6), tone: tone * R0.r(0.5, 0.95), dry: 0.4, dryEnd: 0.85, rough: 0.2, seed: seed * 11 + i, tail: 0.5, ...tw(0.4 + 0.4 * (1 - (sy - topY) / Math.max(1, baseY - topY)), 0.55 + 0.4 * (1 - (sy - topY) / Math.max(1, baseY - topY))) });
  }
  // 苔点
  const nd = o.moss ?? Math.round((x1 - x0) / 30);
  for (let i = 0; i < nd; i++) {
    const sx = x0 + (x1 - x0) * R0.r(0.05, 0.95);
    const sy = ridgeYAt(rg, sx) + R0.r(-2, 10);
    dot(buf, sx, sy, R0.r(1.4, 3.2), { tone: tone * R0.r(1.1, 1.6), ax: R0.r(1, 1.8), ang: R0.r(-0.4, 0.4), seed: seed * 13 + i, halo: 1.5, ...tw(0.85, 1) });
  }
}
export function ridgeYAt(rg, x) {
  if (x <= rg[0][0]) return rg[0][1];
  for (let i = 1; i < rg.length; i++) if (x <= rg[i][0]) { const a = rg[i - 1], b = rg[i]; const t = (x - a[0]) / Math.max(1e-6, b[0] - a[0]); return a[1] + (b[1] - a[1]) * t; }
  return rg[rg.length - 1][1];
}

// ---------------------------------------------------------------------------
// 水纹
// ---------------------------------------------------------------------------
/** 水纹：x0..x1、y0..y1 之间的淡墨长线（留白为主）。o.density 每百像素行数，o.tone，o.seed，o.calm（越大越平） */
export function waterLines(buf, x0, x1, y0, y1, o = {}) {
  if (!buf) return;
  const R0 = rng(o.seed ?? 1), tone = o.tone ?? 0.3;
  const rows = Math.max(1, Math.round(((y1 - y0) / 100) * (o.density ?? 3.2) * ((x1 - x0) / 1000)));
  const calm = o.calm ?? 1;
  for (let i = 0; i < rows; i++) {
    const y = y0 + (y1 - y0) * Math.pow(R0.f(), o.bias ?? 1);
    const len = R0.r(o.minLen ?? 120, o.maxLen ?? 520);
    const sx = R0.r(x0 - len * 0.3, x1 - len * 0.7);
    const nseg = Math.max(3, Math.round(len / 40));
    const amp = R0.r(1.5, 5) / calm, per = R0.r(60, 160), ph = R0.f() * 6.28;
    const pts = [];
    for (let k = 0; k <= nseg; k++) {
      const u = k / nseg;
      const xx = sx + len * u;
      const yy = y + Math.sin(xx / per * 6.283 + ph) * amp + (vn1(xx * 0.01 + i * 7.1) - 0.5) * 3;
      pts.push([xx, yy, 0.35 + 0.65 * Math.sin(Math.PI * u)]);
    }
    const tk = o.depthTone ? o.depthTone(y) : 1;
    stroke(buf, pts, { w: R0.r(o.minW ?? 1.1, o.maxW ?? 2.2), tone: tone * R0.r(0.55, 1) * tk, dry: R0.r(0.05, 0.3), dryEnd: R0.r(0.4, 0.8), head: 0.2, tail: 0.35, rough: 0.12, halo: 1.2, haloK: 0.25, seed: (o.seed ?? 1) * 1000 + i, fade: 0.3 });
    // 偶尔一个回旋小浪
    if (o.curls && R0.f() < o.curls) {
      const cx = sx + len * R0.r(0.2, 0.8), cy = y + R0.r(-3, 3), rr = R0.r(4, 9);
      const arcp = [];
      for (let k = 0; k <= 8; k++) { const a = Math.PI * (1 + k / 8 * 1.3); arcp.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.6, 0.8]); }
      stroke(buf, arcp, { w: 1.2, tone: tone * 0.7 * tk, seed: (o.seed ?? 1) * 2000 + i, tail: 0.5 });
    }
  }
}

// ---------------------------------------------------------------------------
// 着色器片段
// ---------------------------------------------------------------------------
export const INK_GLSL = /* glsl */ `
vec3 srgb2lin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
// 墨落在纸上：T 为透射率（1 = 白纸）。淡墨偏一点冷灰，浓墨暖黑
vec3 inkOnPaper(vec3 paper, float T) {
  vec3 ink = vec3(${(PALETTE.ink[0] / 255).toFixed(4)}, ${(PALETTE.ink[1] / 255).toFixed(4)}, ${(PALETTE.ink[2] / 255).toFixed(4)});
  float d = 1.0 - T;
  vec3 c = mix(paper, ink, d);
  c += vec3(-0.012, -0.003, 0.014) * d * (1.0 - d) * 4.0;
  return c;
}
// 按到达时间揭示：arr 到达时刻（归一化），now 当前（同一归一化），soft 生长前沿宽度
float reveal(float arr, float now, float soft) { return smoothstep(arr, arr + soft, now); }
// 纸纤维对墨量的微调（淡处更显纤维）
float fiberMod(float d, float fib, float k) { return clamp(d * (1.0 + k * (fib - 0.5) * 2.0 * (1.0 - smoothstep(0.3, 0.9, d))), 0.0, 1.0); }
`;
