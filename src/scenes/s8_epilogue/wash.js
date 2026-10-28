// 「鲔」被一滴水洗掉：建场景时确定性地模拟一遍，存关键帧；逐帧只做插值与合成（t 的纯函数）。
//
// 物理草图（1 像素一格，区域 N×N，以落点为中心）：
//   水：落点处先是一颗水珠（穹顶，折射放大下面的墨、左上角一粒高光），随后渗进纸里。
//       水沿纸纤维走得快（用这张纸自己的「吸墨度」图做速度场），到达时刻用 Dijkstra 求地形距离，
//       前沿先快后慢地铺开，边缘参差、顺纤维伸出细指；然后从边缘往里慢慢变干。
//   墨：被水泡到的地方，干墨重新溶进水里。每一处「咬得多牢」不一样（纸浆厚薄、纤维疏密），
//       所以笔画是一块块破开、露出纸来，而不是整体一起变淡。托起来的墨随水往外走
//       （二维流量守恒：流速 ≈ β·F·F'/r，落点附近最快），顺纤维抖开成毛边，一部分被水冲淡带走；
//       变干时毛细流把墨带向水边，堆成一圈淡淡的墨边（咖啡环效应）；水干了，悬着的墨就地沉下来。
//       落点处洗得最干净，离得远、水来得晚的笔画留下一点残影。
//   纸：湿的地方纸色变深变灰；干了以后留下水渍：一圈发黄的水线（tide line），里面略黄。
import { clamp, sstep, mulberry32, fbm2 } from '../../film/util.js';

// 可分离的盒式/高斯模糊（建场景用）
function boxBlur(a, N, r) {
  const t = new Float32Array(a.length), o = new Float32Array(a.length);
  for (let y = 0; y < N; y++) { let s = 0; for (let x = -r; x <= r; x++) s += a[y * N + Math.min(N - 1, Math.max(0, x))];
    for (let x = 0; x < N; x++) { t[y * N + x] = s / (2 * r + 1); s += a[y * N + Math.min(N - 1, x + r + 1)] - a[y * N + Math.max(0, x - r)]; } }
  for (let x = 0; x < N; x++) { let s = 0; for (let y = -r; y <= r; y++) s += t[Math.min(N - 1, Math.max(0, y)) * N + x];
    for (let y = 0; y < N; y++) { o[y * N + x] = s / (2 * r + 1); s += t[Math.min(N - 1, y + r + 1) * N + x] - t[Math.max(0, y - r) * N + x]; } }
  return o;
}
function gaussBlur(a, N, sig) {
  const r = Math.ceil(sig * 3), k = [];
  let ks = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sig * sig)); k.push(v); ks += v; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const t = new Float32Array(a.length), o = new Float32Array(a.length);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let s = 0; for (let i = -r; i <= r; i++) s += a[y * N + Math.min(N - 1, Math.max(0, x + i))] * k[i + r]; t[y * N + x] = s; }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let s = 0; for (let i = -r; i <= r; i++) s += t[Math.min(N - 1, Math.max(0, y + i)) * N + x] * k[i + r]; o[y * N + x] = s; }
  return o;
}

/**
 * @param {object} o
 *   D0: Float32Array(N*N) 初始墨量（0..1，就是画面上「鲔」的 alpha）
 *   fib: Float32Array(N*N) 纸的吸墨度（0..1）
 *   N, cx, cy: 区域边长与落点（区域内像素坐标）
 *   R: 最终水渍的平均半径（像素）
 */
export function buildWash({ D0, fib, N, cx, cy, R = 104, simT = 7.2, fps = 15, seed = 1 }) {
  const n = N * N;
  // ---------- 1. 水的到达：纤维加速的最短路 ----------
  const speed = new Float32Array(n);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const p = y * N + x;
    // 低频的不均匀（纸浆厚薄）+ 纤维；横向略快（纸的帘纹方向）
    const lf = Math.sin(x * 0.021 + seed) * Math.cos(y * 0.017 - seed * 0.7) * 0.5 + Math.sin((x + y) * 0.009 + seed * 2.1) * 0.5;
    speed[p] = Math.max(0.25, 0.72 + 0.95 * (fib[p] - 0.5) + 0.16 * lf);
  }
  const dist = new Float32Array(n).fill(Infinity);
  {
    // 二叉堆 Dijkstra，16 邻域（更圆）
    const heapK = new Float32Array(n * 8), heapV = new Int32Array(n * 8);
    let hs = 0;
    const push = (k, v) => {
      let i = hs++;
      heapK[i] = k; heapV[i] = v;
      while (i > 0) {
        const pi = (i - 1) >> 1;
        if (heapK[pi] <= heapK[i]) break;
        const tk = heapK[pi], tv = heapV[pi];
        heapK[pi] = heapK[i]; heapV[pi] = heapV[i]; heapK[i] = tk; heapV[i] = tv;
        i = pi;
      }
    };
    const pop = () => {
      const k = heapK[0], v = heapV[0];
      hs--;
      heapK[0] = heapK[hs]; heapV[0] = heapV[hs];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < hs && heapK[l] < heapK[m]) m = l;
        if (r < hs && heapK[r] < heapK[m]) m = r;
        if (m === i) break;
        const tk = heapK[m], tv = heapV[m];
        heapK[m] = heapK[i]; heapV[m] = heapV[i]; heapK[i] = tk; heapV[i] = tv;
        i = m;
      }
      return [k, v];
    };
    const nb = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (!dx && !dy) continue;
      if (Math.abs(dx) === 2 && Math.abs(dy) === 2) continue;
      if ((Math.abs(dx) === 2 && dy === 0) || (Math.abs(dy) === 2 && dx === 0)) continue;
      nb.push([dx, dy, Math.hypot(dx * 0.93, dy)]); // 横向便宜一点
    }
    const r0 = 4;
    for (let y = Math.floor(cy - r0); y <= Math.ceil(cy + r0); y++) for (let x = Math.floor(cx - r0); x <= Math.ceil(cx + r0); x++) {
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r0) { const p = y * N + x; dist[p] = d; push(d, p); }
    }
    while (hs > 0) {
      const [k, p] = pop();
      if (k > dist[p]) continue;
      const x = p % N, y = (p / N) | 0;
      for (const [dx, dy, len] of nb) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= N || Y >= N) continue;
        const q = Y * N + X;
        const nd = k + len * 2 / (speed[p] + speed[q]);
        if (nd < dist[q]) { dist[q] = nd; push(nd, q); }
      }
    }
  }
  // 把地形距离标定到像素：最终水渍的等效半径 = R
  {
    const ds = Array.from(dist).filter(Number.isFinite).sort((a, b) => a - b);
    const want = Math.min(ds.length - 1, Math.floor(Math.PI * R * R));
    const k = R / ds[want];
    for (let p = 0; p < n; p++) dist[p] *= k;
  }
  // 前沿半径随时间：落下瞬间就有水珠那么大，先快后慢
  const R0 = 19;
  const front = (tau) => (tau <= 0 ? 0 : R0 + (R - R0) * (1 - Math.exp(-tau / 0.85)) + 2.0 * Math.min(tau, 3) / 3);
  const frontV = (tau) => (tau <= 0 ? 0 : ((R - R0) / 0.85) * Math.exp(-tau / 0.85) + (tau < 3 ? 2 / 3 : 0)); // 前沿速度
  const Rmax = front(simT + 10);
  const tauArr = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const d = dist[p];
    if (d <= R0) { tauArr[p] = 0; continue; }
    if (d >= Rmax) { tauArr[p] = Infinity; continue; }
    // 反解 front(τ) = d
    let lo = 0, hi = 30;
    for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (front(m) < d) lo = m; else hi = m; }
    tauArr[p] = hi;
  }
  // 往外的方向：地形距离先抹平再求梯度（最短路场有「脊」，直接用会把墨汇成一根根辐条）
  const dirX = new Float32Array(n), dirY = new Float32Array(n);
  {
    const dd = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      const x = p % N, y = (p / N) | 0;
      dd[p] = Number.isFinite(dist[p]) ? dist[p] : Math.hypot(x + 0.5 - cx, y + 0.5 - cy) * 1.2;
    }
    const sm = boxBlur(boxBlur(dd, N, 5), N, 5);
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
      const p = y * N + x;
      let gx = sm[p + 1] - sm[p - 1], gy = sm[p + N] - sm[p - N];
      const rx0 = x + 0.5 - cx, ry0 = y + 0.5 - cy, rl = Math.hypot(rx0, ry0) || 1;
      const l = Math.hypot(gx, gy);
      if (l < 1e-4) { gx = rx0 / rl; gy = ry0 / rl; } else { gx /= l; gy /= l; }
      // 和纯径向方向混一点，更稳
      const mx = 0.7 * gx + 0.3 * rx0 / rl, my = 0.7 * gy + 0.3 * ry0 / rl, ml = Math.hypot(mx, my) || 1;
      dirX[p] = mx / ml; dirY[p] = my / ml;
    }
  }
  // 干：从边缘往里干，落点最后干
  const tauDry = new Float32Array(n);
  for (let p = 0; p < n; p++) tauDry[p] = 3.9 + 2.6 * clamp(1 - dist[p] / Rmax) + 0.5 * (fib[p] - 0.5);
  const W = (p, tau) => {
    if (!(tau > 0)) return 0;
    const g = front(tau) - dist[p];
    if (g <= -1) return 0;
    const wetUp = sstep(-1, 1, g); // 空间上 2 px 的软边：前沿慢下来以后不会一格一格地出锯齿
    const edge = 0.55 + 0.45 * sstep(0, 9, g); // 前沿那一圈水薄
    return wetUp * edge * (1 - sstep(tauDry[p] - 1.3, tauDry[p], tau));
  };

  // ---------- 2. 墨 ----------
  // 没被水带走的墨留在原处（边缘被泡软）；被水「托起来」的墨用十几万个小颗粒表示：
  // 先在笔画周围晕开一圈，再沿纸纤维抖动着随水往外走，水走不动的地方（前沿、干了的地方）就停下、沉积。
  const rnd = mulberry32(seed * 7919 + 17);
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 1.41;
  // 纤维方向：吸墨度图的结构张量
  const fdx = new Float32Array(n), fdy = new Float32Array(n);
  {
    const jxx = new Float32Array(n), jxy = new Float32Array(n), jyy = new Float32Array(n);
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
      const p = y * N + x;
      const gx = fib[p + 1] - fib[p - 1], gy = fib[p + N] - fib[p - N];
      jxx[p] = gx * gx; jxy[p] = gx * gy; jyy[p] = gy * gy;
    }
    const bx = (a) => boxBlur(a, N, 3);
    const A = bx(jxx), B = bx(jxy), C = bx(jyy);
    for (let p = 0; p < n; p++) {
      const th = 0.5 * Math.atan2(2 * B[p], A[p] - C[p]) + Math.PI / 2; // 垂直于梯度 = 顺着纤维
      fdx[p] = Math.cos(th); fdy[p] = Math.sin(th);
    }
  }
  // 被泡软的笔画（轻微模糊）与「最多能被带走多少」
  const Dsoft = gaussBlur(D0, N, 1.25);
  const liftMax = new Float32Array(n);
  for (let p = 0; p < n; p++) liftMax[p] = Number.isFinite(tauArr[p]) ? 0.985 - 0.05 * clamp((tauArr[p] - 0.3) / 1.6) : 0;
  const LAG = 0.1;
  // 泡开的快慢：落点处水多，墨几乎立刻被托起；离得越远越慢
  const LTp = new Float32Array(n);
  for (let p = 0; p < n; p++) LTp[p] = 0.6 + 0.7 * clamp(dist[p] / R);
  // 每一处的墨「咬得多牢」（0..1）：纸浆厚、纤维密的地方墨吃得深，最后才被泡开。
  // 笔画因此是一块块破开、露出纸来，而不是整体一起变淡（那样看起来就是模糊）
  const Zr = new Float32Array(n);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const p = y * N + x;
    Zr[p] = clamp(0.5 + 1.1 * fbm2(x / 8 + seed * 3.3, y / 8 - seed * 1.7, 3) + 0.3 * (fib[p] - 0.5));
  }
  // τ 时刻这一处已经被托起的比例
  const liftE = (p, tau) => {
    const ta = tauArr[p];
    if (!(tau > ta + LAG)) return 0;
    const cdf = 1 - Math.exp(-(tau - ta - LAG) / LTp[p]);
    return liftMax[p] * clamp((cdf - 0.6 * Zr[p]) / 0.4);
  };
  // 颗粒：按墨量抽样
  const NP = 220000;
  let total = 0;
  const cdf = new Float64Array(n);
  for (let p = 0; p < n; p++) { total += D0[p]; cdf[p] = total; }
  const m0 = total / NP;
  const Px = new Float32Array(NP), Py = new Float32Array(NP), Tl = new Float32Array(NP);
  for (let i = 0; i < NP; i++) {
    const u = rnd() * total;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m + 1; else hi = m; }
    const p = lo;
    Px[i] = (p % N) + rnd(); Py[i] = Math.floor(p / N) + rnd();
    // 这一粒会不会被带走、什么时候被带走（和留下的墨的期望 liftE 正好互补）
    const uu = rnd();
    if (uu >= liftMax[p]) Tl[i] = Infinity;
    else {
      const c = Math.min(0.995, 0.6 * Zr[p] + 0.4 * (uu / liftMax[p]));
      Tl[i] = tauArr[p] + LAG - LTp[p] * Math.log(1 - c);
    }
  }
  const dt = 1 / fps, steps = Math.ceil(simT / dt);
  const Wc = new Float32Array(n), acc = new Float32Array(n);
  const frames = [];
  const snap = (tau) => {
    acc.fill(0);
    for (let i = 0; i < NP; i++) {
      const tl = Tl[i];
      if (!(tau > tl)) continue;
      const age = tau - tl;
      const m = m0 * (0.065 + 0.935 * Math.exp(-age / 2.0)); // 被冲淡带走一部分
      const x = Px[i] - 0.5, y = Py[i] - 0.5, ix = Math.floor(x), iy = Math.floor(y);
      if (ix < 0 || iy < 0 || ix >= N - 1 || iy >= N - 1) continue;
      const fx = x - ix, fy = y - iy, q = iy * N + ix;
      acc[q] += m * (1 - fx) * (1 - fy); acc[q + 1] += m * fx * (1 - fy);
      acc[q + N] += m * (1 - fx) * fy; acc[q + N + 1] += m * fx * fy;
    }
    const cloud = gaussBlur(acc, N, 0.95);
    const f = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      let crisp = D0[p];
      const ta = tauArr[p];
      if (tau > ta) {
        const soft = D0[p] + (Dsoft[p] - D0[p]) * sstep(0, 1.1, tau - ta);
        crisp = soft * (1 - liftE(p, tau));
      }
      // 化在水里的墨沉在纤维里：纤维多处深、少处浅（颗粒感，不是一层平的灰）
      const v = 1 - (1 - crisp) * (1 - Math.min(1, cloud[p] * (0.3 + 1.4 * fib[p])));
      f[p] = v >= 1 ? 255 : Math.round(v * 255);
    }
    frames.push(f);
  };
  snap(0);
  for (let s = 1; s <= steps; s++) {
    const tau = s * dt;
    for (let p = 0; p < n; p++) Wc[p] = W(p, tau);
    // 水从落点往外铺：二维里流量守恒 → 离落点 r 处的流速 ≈ F·F'/r（F 是前沿半径）。
    // 墨被纤维拦着，比水走得慢（BETA）。于是落点被冲干净，墨被推到外圈（水花 / 回流的那种花边）
    const BETA = 0.25, FF = front(tau) * frontV(tau);
    const sq = Math.sqrt(dt);
    const RF = front(99);
    for (let i = 0; i < NP; i++) {
      const tl = Tl[i];
      if (!(tau > tl)) continue;
      const ix = Px[i] | 0, iy = Py[i] | 0;
      if (ix < 1 || iy < 1 || ix >= N - 1 || iy >= N - 1) continue;
      const p = iy * N + ix;
      const w = Wc[p];
      if (w < 0.05) continue; // 没水了（已干）：就停在这里
      const age = tau - tl;
      const fb = fib[p];
      // 平流：铺开时的外推 + 变干时往边缘去的毛细流（咖啡环），边缘附近最强
      let sp = Math.min(70, (BETA * FF) / Math.max(8, dist[p])) * w * (0.55 + 0.7 * fb);
      const drying = sstep(2.0, 4.2, tau) * (1 - sstep(tauDry[p] - 0.7, tauDry[p], tau));
      sp += 8 * drying * sstep(0.45, 0.95, dist[p] / RF);
      // 扩散：各向同性 + 顺纤维；刚被托起时晕得快
      // 墨只能顺着纤维爬：纤维多的地方走得动，少的地方被「卡住」→ 羽毛状、树枝状的晕
      const mob = 0.12 + 1.7 * fb * fb;
      const bloom = 9.0 * Math.exp(-age / 0.45);
      // 泡久了，墨在水里越化越开（后半段各向同性地晕散、变淡）
      const late = sstep(0.9, 2.8, age);
      const si = (1.6 + 0.2 * bloom + 2.5 * late) * sq * w * (mob + 0.3 * late), sf = (4.5 + bloom) * sq * w * mob;
      const gc = gauss() * sf;
      let nx = Px[i] + dirX[p] * sp * dt + fdx[p] * gc + gauss() * si;
      let ny = Py[i] + dirY[p] * sp * dt + fdy[p] * gc + gauss() * si;
      // 走到干纸边上：不越过去，沿着水边滑（墨在水边上堆成一圈）
      const jx = nx | 0, jy = ny | 0;
      if (jx < 0 || jy < 0 || jx >= N || jy >= N || Wc[jy * N + jx] < 0.05) {
        const tg = gauss() * 1.1;
        nx = Px[i] - dirY[p] * tg; ny = Py[i] + dirX[p] * tg;
      }
      Px[i] = nx; Py[i] = ny;
    }
    snap(tau);
  }
  return { N, cx, cy, R, Rmax, dist, tauArr, tauDry, frames, fps, simT, W, front };
}

/**
 * 逐帧合成到三张 ImageData（和区域一样大）：
 *   mul —— 用 multiply 叠：湿纸变深、水渍、水线
 *   ink —— 用 source-over 叠：墨（颜色 ink，alpha = 墨量）
 *   hi  —— 用 lighter 叠：水珠高光、湿面反光
 * tau < 0 时画水滴落下前的影子。
 */
export function renderWash(S, tau, bufs, { ink = [21, 19, 17], fib }) {
  const { N, cx, cy, dist, tauArr, frames, fps, W, front } = S;
  const n = N * N;
  const M = bufs.mul.data, I = bufs.ink.data, Hh = bufs.hi.data;
  // 关键帧插值
  const fpos = clamp(tau * fps, 0, frames.length - 1);
  const f0 = Math.floor(fpos), f1 = Math.min(frames.length - 1, f0 + 1), ff = fpos - f0;
  const A = frames[f0], B = frames[f1];
  // 水珠：落下的一瞬间摊开、轻轻一颤，随后 1.2 秒里渗进纸
  const bead = tau >= 0 ? 1 - sstep(0.05, 1.3, tau) : 0;
  const land = tau >= 0 ? 0.72 + 0.28 * sstep(0, 0.07, tau) + 0.05 * Math.exp(-tau / 0.09) * Math.sin(tau * 55) : 0;
  const rb = 24 * land * (1 - 0.18 * sstep(0.1, 1.2, tau));
  const hb = 10 * bead;
  // 光：左上方
  const Lx = -0.42, Ly = -0.52, Lz = 0.745;
  const Hx = Lx, Hy = Ly, Hz = Lz + 1;
  const Hl = Math.hypot(Hx, Hy, Hz);
  const hx = Hx / Hl, hy = Hy / Hl, hz = Hz / Hl;
  const Rfin = front(99);
  const sampleInk = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= N - 1 || iy >= N - 1) return 0;
    const fx = x - ix, fy = y - iy, q = iy * N + ix;
    const va = A[q] + (B[q] - A[q]) * ff, vb = A[q + 1] + (B[q + 1] - A[q + 1]) * ff;
    const vc = A[q + N] + (B[q + N] - A[q + N]) * ff, vd = A[q + N + 1] + (B[q + N + 1] - A[q + N + 1]) * ff;
    return (va * (1 - fx) * (1 - fy) + vb * fx * (1 - fy) + vc * (1 - fx) * fy + vd * fx * fy) / 255;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const p = y * N + x, q = p * 4;
      const px = x + 0.5 - cx, py = y + 0.5 - cy;
      const r = Math.hypot(px, py);
      let mr = 1, mg = 1, mb = 1;   // multiply
      let inkA;                      // 墨
      let hiV = 0;                   // 高光
      const w = tau >= 0 ? W(p, tau) : 0;
      // ---- 纸：湿了变深，干了留下水渍与水线 ----
      const fr = tau >= 0 ? front(tau) : 0;
      if (tau >= 0 && dist[p] < fr + 4) {
        const d = dist[p];
        // 湿纸：变深、半透明，纤维的网在湿的时候更显（纤维少、纸薄处更透更暗），靠近前沿的一圈水薄、暗得轻
        const wetDark = w * (0.07 + 0.07 * (1 - fib[p]) + 0.02 * Math.sin(x * 0.05 + y * 0.037));
        // 水线：水走到头的那一圈，干后发黄；走动中的前沿有一条细细的暗线（水的弯月面）
        const moving = Math.exp(-(((d - fr) / 1.4) ** 2)) * 0.09 * sstep(0, 0.3, tau) * (1 - sstep(2.5, 4.5, tau));
        const dried = 1 - w;
        const tide = Math.exp(-(((d - Rfin + 1.2) / 1.7) ** 2)) * 0.1 * sstep(1.5, 5.5, tau) * sstep(-4, -2, fr - d);
        const inner = 0.028 * sstep(2.0, 6.0, tau) * (0.7 + 0.6 * fib[p]) * sstep(-1, 1, fr - d);
        const k = wetDark + moving;
        // 湿纸：暗下去，同时纸本来的暖色更「饱」（蓝掉得多），不是蒙一层灰
        mr = 1 - k * 0.82 - (tide + inner) * 0.55;
        mg = 1 - k * 0.9 - (tide + inner) * 0.72;
        mb = 1 - k * 1.05 - (tide + inner) * 1.1;
        void dried;
      }
      // ---- 水珠：穹顶，折射放大下面的墨，左上一粒高光，边缘一圈暗 ----
      let sx = x, sy = y;
      if (bead > 0 && r < rb + 3) {
        const rr = Math.min(r, rb);
        const t2 = rr / rb;
        const slope = (2 * hb * rr) / (rb * rb); // dz/dr
        const nxv = r > 1e-3 ? -slope * (px / r) : 0, nyv = r > 1e-3 ? -slope * (py / r) : 0;
        const nl = Math.hypot(nxv, nyv, 1);
        const Nx = nxv / nl, Ny = nyv / nl, Nz = 1 / nl;
        const edgeMask = 1 - sstep(rb - 1.0, rb + 1.0, r);
        // 平凸透镜：底下的墨被放大（往中心收着取样）
        const mag = 0.34 * bead * (1 - t2 * t2) * edgeMask;
        sx = cx - 0.5 + px * (1 - mag); sy = cy - 0.5 + py * (1 - mag);
        const ndh = Math.max(0, Nx * hx + Ny * hy + Nz * hz);
        const spec = Math.pow(ndh, 90) * 1.25 * bead;
        const sheen = Math.pow(ndh, 7) * 0.08 * bead;
        // 焦散：光穿过水珠聚在背光一侧的纸上
        const kx = px - 0.42 * rb, ky = py - 0.48 * rb;
        const caus = Math.exp(-(kx * kx + ky * ky) / (2 * (0.24 * rb) ** 2)) * 0.22 * bead;
        // 接触线：水珠边上一圈暗（光在这里被折走了）
        const rim = Math.exp(-(((r - rb * 0.95) / 1.25) ** 2)) * 0.32 * bead;
        hiV += (spec + sheen + caus) * edgeMask;
        mr -= rim; mg -= rim; mb -= rim * 0.92;
        mr -= 0.05 * bead * edgeMask; mg -= 0.05 * bead * edgeMask; mb -= 0.04 * bead * edgeMask;
      }
      // ---- 落下前：影子由虚到实、由大到小 ----
      if (tau < 0 && tau > -0.4) {
        const k = 1 + tau / 0.4; // 0→1
        const ox = 9 * (1 - k) + 3, oy = 12 * (1 - k) + 4; // 影子偏右下（光在左上）
        const sr = 19 - 8 * k, blur = 12 - 8.5 * k;
        const d = Math.hypot(px - ox, py - oy);
        const sh = (1 - sstep(sr - blur, sr + blur, d)) * 0.26 * k * k;
        mr -= sh; mg -= sh; mb -= sh;
      }
      // ---- 湿面反光：很淡的一层，前沿移动时那圈更亮一点 ----
      if (w > 0) {
        const g = (0.5 - (px * 0.42 + py * 0.52) / (2 * S.R)) ; // 左上亮
        hiV += 0.022 * w * w * clamp(g + 0.4, 0, 1);
      }
      inkA = tau >= 0 ? sampleInk(sx, sy) : A[p] / 255;
      M[q] = clamp(mr) * 255; M[q + 1] = clamp(mg) * 255; M[q + 2] = clamp(mb) * 255; M[q + 3] = 255;
      I[q] = ink[0]; I[q + 1] = ink[1]; I[q + 2] = ink[2]; I[q + 3] = clamp(inkA) * 255;
      const hv = clamp(hiV);
      Hh[q] = 255; Hh[q + 1] = 252; Hh[q + 2] = 244; Hh[q + 3] = hv * 255;
    }
  }
  return bufs;
}
