// 曲线与笔势小工具（纯数学，确定性）
import { clamp, lerp, noise1, hash1 } from '../../film/util.js';

/** Catmull-Rom（向心）穿过控制点，按大约 step 世界像素采样，返回 Float32Array [x0,y0,...] */
export function spline(P, step = 4, closed = false) {
  // P: [[x,y],...] 或 平铺数组
  const pts = Array.isArray(P[0]) ? P : toPairs(P);
  const n = pts.length;
  if (n < 2) return new Float32Array(n === 1 ? [pts[0][0], pts[0][1], pts[0][0] + 0.01, pts[0][1]] : []);
  const get = (i) => {
    if (closed) return pts[((i % n) + n) % n];
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    if (i >= n) return [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
    return pts[i];
  };
  const out = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const m = Math.max(1, Math.ceil(d / step));
    // 向心参数
    const t01 = Math.pow(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + 1e-4, 0.5);
    const t12 = Math.pow(d + 1e-4, 0.5);
    const t23 = Math.pow(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]) + 1e-4, 0.5);
    const m1x = (p2[0] - p1[0]) + t12 * ((p1[0] - p0[0]) / t01 - (p2[0] - p0[0]) / (t01 + t12));
    const m1y = (p2[1] - p1[1]) + t12 * ((p1[1] - p0[1]) / t01 - (p2[1] - p0[1]) / (t01 + t12));
    const m2x = (p2[0] - p1[0]) + t12 * ((p3[0] - p2[0]) / t23 - (p3[0] - p1[0]) / (t12 + t23));
    const m2y = (p2[1] - p1[1]) + t12 * ((p3[1] - p2[1]) / t23 - (p3[1] - p1[1]) / (t12 + t23));
    const ax = 2 * p1[0] - 2 * p2[0] + m1x + m2x, ay = 2 * p1[1] - 2 * p2[1] + m1y + m2y;
    const bx = -3 * p1[0] + 3 * p2[0] - 2 * m1x - m2x, by = -3 * p1[1] + 3 * p2[1] - 2 * m1y - m2y;
    for (let k = 0; k < m; k++) {
      const t = k / m;
      out.push(((ax * t + bx) * t + m1x) * t + p1[0], ((ay * t + by) * t + m1y) * t + p1[1]);
    }
  }
  const last = closed ? pts[0] : pts[n - 1];
  out.push(last[0], last[1]);
  return new Float32Array(out);
}

export function toPairs(a) { const o = []; for (let i = 0; i + 1 < a.length; i += 2) o.push([a[i], a[i + 1]]); return o; }

export function polyLen(p) {
  let s = 0;
  for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return s;
}

/** 折线上按弧长比例 u 取点和切线 */
export function pointAt(p, u) {
  const L = polyLen(p), target = clamp(u) * L;
  let s = 0;
  for (let i = 2; i < p.length; i += 2) {
    const d = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    if (s + d >= target || i === p.length - 2) {
      const a = d > 0 ? (target - s) / d : 0;
      const tx = (p[i] - p[i - 2]) / (d || 1), ty = (p[i + 1] - p[i - 1]) / (d || 1);
      return { x: p[i - 2] + (p[i] - p[i - 2]) * a, y: p[i - 1] + (p[i + 1] - p[i - 1]) * a, tx, ty };
    }
    s += d;
  }
  return { x: p[0], y: p[1], tx: 1, ty: 0 };
}

/** 手的微颤：沿法向加一点低频噪声（amp 世界像素，freq 每像素） */
export function wobble(p, amp, freq, seed) {
  const n = p.length >> 1, out = new Float32Array(p.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) s += Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
    const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
    let tx = p[2 * i1] - p[2 * i0], ty = p[2 * i1 + 1] - p[2 * i0 + 1];
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const w = noise1(s * freq + seed * 13.1) * amp;
    out[2 * i] = p[2 * i] + ty * w; out[2 * i + 1] = p[2 * i + 1] - tx * w;
  }
  return out;
}

/** 毛笔宽度轮廓：起笔顿一下、行笔略收、收笔出锋。u 0..1 */
export function brushW(u, { head = 0.12, tail = 0.3, headW = 0.75, tailW = 0.05, press = 0, seed = 0, wav = 0.12 } = {}) {
  let w;
  if (u < head) w = lerp(headW, 1, Math.sin((u / head) * Math.PI * 0.5));
  else if (u > 1 - tail) { const k = (u - (1 - tail)) / tail; w = lerp(1, tailW, Math.pow(k, 1.35)); }
  else w = 1;
  w *= 1 + wav * noise1(u * 5.3 + seed * 7.7) + press * Math.sin(u * Math.PI);
  return Math.max(0, w);
}

/** 关键帧插值：keys = [[t, v], ...]，v 可以是数或数组；ease 可选（按段） */
export function kf(t, keys, ease = smoothE) {
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, e1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      const e = e1 || ease;
      const a = e((t - t0) / (t1 - t0));
      if (Array.isArray(v0)) return v0.map((x, j) => x + (v1[j] - x) * a);
      return v0 + (v1 - v0) * a;
    }
  }
  return last[1];
}
export const smoothE = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
export const linE = (x) => clamp(x);
export const inE = (x) => { x = clamp(x); return x * x; };
export const outE = (x) => { x = clamp(x); return 1 - (1 - x) * (1 - x); };
export const inOut3 = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };

/** 阻尼振动（冲击后晃动）：t0 冲击，f 频率，d 衰减 */
export function ring(t, t0, f = 3, d = 3.5) { if (t < t0) return 0; const x = t - t0; return Math.sin(x * f * Math.PI * 2) * Math.exp(-x * d); }

/** 确定性的 0..1 随机数序列（按整数索引） */
export const rnd = (i, s = 0) => hash1(i * 1.618 + s * 97.13 + 0.123);
