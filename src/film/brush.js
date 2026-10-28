// 书法引擎：毛笔按真实笔顺逐笔书写（Make Me a Hanzi 楷书轮廓 + 笔顺中线，数据在 src/data/hanzi.json）。
//
// 用法（c 是 Canvas2D，比如 p5.Graphics 的 drawingContext）：
//   await loadGlyphs('有鳣有鲔');                       // 建场景时：检查字库（缺字会抛错）
//   prepareText('有鳣有鲔', { size: 140, ... });         // 可选：建场景时把笔画缓存先算好，免得第一帧卡
//   writeText(c, '有鳣有鲔', { x, y, size: 140, t, t0, dur });   // 每帧：按笔顺时间表画到时刻 t
//   writeText(c, '白鲟', { x, y, size: 120, progress: 0.4 });    // 或者给整体进度 0..1
//
// 坐标：(x, y) 是第一个字的字框左上角，字框边长 = size（1024 字框单位缩放到 size 像素）；
//   vertical=true 时往下排，false 时往右排，字距 gap×size。drawImage 走 c 的当前变换，可以整体平移缩放。
// 时间：t0 第一笔落笔，t0+dur 最后一笔收笔；每笔的起止见 strokeSchedule（纯函数，events.js 在 node 里也能用）。
// 选项：ink=[r,g,b] 墨色、alpha 整体不透明度、wet 0..1 洇的程度、dry 0..1 飞白程度、seed 随机种子、
//   mode 'ink'（纸上的墨）| 'glow'（黑底发光冷白青线条，用 lighter 叠加，适合画进 HDR 目标再吃泛光）、
//   hide=[字序号…] 这几个字不画（其余字的墨、节奏不变，比如洗掉某个字时由别的效果接手）。
// 返回 { tip, done, boxes }：tip 是正在写的笔尖 {x, y, r, char, i, arc}（没在写为 null），boxes 是各字框。
//
// 画质模型（每一笔建场景时预计算，逐帧只做一次阈值合成）：
//   · 形：官方楷书轮廓（形准）。笔尖沿中线「生长」：每个像素记下笔尖圆盘第一次盖住它时的中线弧长，
//     逐帧按笔尖位置显现，前沿就是圆润的笔锋；落笔时笔毫由尖到铺开。
//   · 墨：每个字开头蘸一次墨，墨量随写过的笔画长度消耗（墨不够中途再蘸）：起笔饱满、行笔渐干；
//     按压处（轮廓宽处）与停顿处（起笔、转折、慢笔）更浓；湿边（边缘比中间深一点）。
//   · 飞白：几十根笔毛各沿自己的轨迹走（中线按横向位置偏移，转折处跟着拐弯），每根笔毛的墨量不同、
//     在不同地方断墨；断墨的笔毛在纸上留下顺着行笔方向的细白丝，相邻几根一起断就是一绺。快笔更容易出。
//     湿的地方是实墨，只留极淡的笔毛纹理。
//   · 洇：边缘有一点软，墨顺着纸纤维渗出细毛（只在纤维处），湿墨外还有极淡的水晕；毛边在笔尖经过后半秒内长出来。
//   · 叠笔：同一个字里后写的笔画压在先写的上面，只加深一点（浓墨叠浓墨），不会露出轮廓数据里的接缝。
//   · 刚写的湿墨有一点亮泽（迎光一侧边缘的反光），几秒后变哑光。
//   · glow：同样的笔触结构，笔画里有细光丝（沿笔毛轨迹）、边缘更亮、笔尖一个亮点，刚写的部分更「烫」，
//     外面两层辉光（高斯模糊叠加）。
import { mulberry32, noise1 } from './util.js';
import { PALETTE } from './paper.js';
import { strokeSchedule, strokeArc, arcTime, strokeGeom, glyphData, hasGlyph, isBlank } from './brush_schedule.js';

export { strokeSchedule, strokeArc, arcTime } from './brush_schedule.js';

const INF = 1e20;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function mkCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w); c.height = Math.max(1, h);
  return c;
}

/**
 * 预载字形。chars 可以是字符串或数组；缺字抛错（说明怎么补）。返回 {字: {strokes, medians}}。
 */
export async function loadGlyphs(chars) {
  const out = {};
  for (const ch of Array.from(Array.isArray(chars) ? chars.join('') : chars)) {
    if (isBlank(ch) || out[ch]) continue;
    if (!hasGlyph(ch)) throw new Error(`brush: 字库里没有「${ch}」。把它加进 script/brush_chars.txt，然后运行 node tools/extract_hanzi.mjs`);
    out[ch] = glyphData(ch);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 纸纤维、细颗粒、低频起伏（256×256 可平铺，建一次）
let TEX = null;
function tex() {
  if (TEX) return TEX;
  const N = 256, F = new Float32Array(N * N), G = new Float32Array(N * N), Wb = new Float32Array(N * N);
  const rnd = mulberry32(90211);
  const wrap = (v) => ((v % N) + N) % N;
  for (let f = 0; f < 1500; f++) {
    let x = rnd() * N, y = rnd() * N;
    const len = 4 + Math.pow(rnd(), 1.7) * 46;
    let ang = rnd() * Math.PI * 2;
    const bend = (rnd() - 0.5) * 0.09;
    const w = 0.38 + rnd() * 0.55, str = 0.3 + rnd() * 0.7;
    const steps = Math.ceil(len / 0.6), inv = 1 / (2 * w * w);
    for (let s = 0; s < steps; s++) {
      x += Math.cos(ang) * 0.6; y += Math.sin(ang) * 0.6; ang += bend;
      const ix = Math.floor(x), iy = Math.floor(y);
      for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
        const dx = ix + ox + 0.5 - x, dy = iy + oy + 0.5 - y;
        F[wrap(iy + oy) * N + wrap(ix + ox)] += str * Math.exp(-(dx * dx + dy * dy) * inv) * 0.3;
      }
    }
  }
  for (let q = 0; q < N * N; q++) F[q] = 1 - Math.exp(-F[q] * 1.7);
  const lat = (sp, seed) => {
    const M = N / sp, L = new Float32Array(M * M), r = mulberry32(seed);
    for (let i = 0; i < M * M; i++) L[i] = r() * 2 - 1;
    return { M, L, sp };
  };
  const sample = ({ M, L, sp }, x, y) => {
    const fx = x / sp, fy = y / sp, ix = Math.floor(fx), iy = Math.floor(fy);
    let tx = fx - ix, ty = fy - iy; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const a = L[(iy % M) * M + (ix % M)], b = L[(iy % M) * M + ((ix + 1) % M)];
    const c = L[((iy + 1) % M) * M + (ix % M)], d = L[((iy + 1) % M) * M + ((ix + 1) % M)];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  const A = lat(2, 11), B = lat(8, 23), C = lat(16, 37), D = lat(32, 41);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    G[y * N + x] = 0.6 * sample(A, x, y) + 0.4 * sample(B, x, y);
    Wb[y * N + x] = 0.6 * sample(C, x, y) + 0.4 * sample(D, x, y);
  }
  TEX = { N, F, G, Wb };
  return TEX;
}

// 高斯查表：exp(-0.5 d²)，d ∈ [0, 4)
const GLUT = new Float32Array(257);
for (let i = 0; i <= 256; i++) { const d = i / 64; GLUT[i] = Math.exp(-0.5 * d * d); }

// ---------------------------------------------------------------------------
// 距离变换（Felzenszwalb 1D 平方距离，两遍得到欧氏距离）
function edt(feature, w, h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = feature[i] ? 0 : INF;
  const pass = (len) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    pass(h);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(Math.min(d[x], 1e12));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 一笔的几何场（与字号、外扩边距有关，与墨无关）
const GEO = new Map();

function strokeGeoPx(ch, i, S, margin) {
  const key = `${ch}|${i}|${S}|${margin}`;
  let geo = GEO.get(key);
  if (geo) return geo;
  const d = glyphData(ch).strokes[i];
  const sg = strokeGeom(ch, i);
  const k = S / 1024;
  // 包围盒：轮廓控制点 + 中线
  const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  let x0 = INF, y0 = INF, x1 = -INF, y1 = -INF;
  for (let q = 0; q + 1 < nums.length; q += 2) {
    const X = nums[q] * k, Y = (900 - nums[q + 1]) * k;
    if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
  }
  for (const [ex, ey] of sg.pts) {
    const X = ex * S, Y = ey * S;
    if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
  }
  const bx = Math.floor(x0 - margin), by = Math.floor(y0 - margin);
  const bw = Math.ceil(x1 + margin) - bx, bh = Math.ceil(y1 + margin) - by;
  const n = bw * bh;
  // 覆盖率（抗锯齿栅格）
  const cv = mkCanvas(bw, bh);
  const g2 = cv.getContext('2d', { willReadFrequently: true });
  g2.setTransform(k, 0, 0, -k, -bx, 900 * k - by);
  g2.fillStyle = '#fff';
  g2.fill(new Path2D(d));
  const px = g2.getImageData(0, 0, bw, bh).data;
  const cov = new Float32Array(n), inside = new Uint8Array(n), outside = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const c = px[p * 4 + 3] / 255;
    cov[p] = c; inside[p] = c >= 0.5 ? 1 : 0; outside[p] = c >= 0.5 ? 0 : 1;
  }
  const dToOut = edt(outside, bw, bh), dToIn = edt(inside, bw, bh);
  const sd = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const c = cov[p];
    if (c > 0.02 && c < 0.98) sd[p] = 0.5 - c;
    else sd[p] = inside[p] ? -(dToOut[p] - 0.5) : dToIn[p] - 0.5;
  }
  // 中线：按 1 px 等距重采样（局部像素坐标）
  const L = Math.max(1, sg.len * S);
  const J = Math.max(2, Math.ceil(L) + 1);
  const mx = new Float32Array(J), my = new Float32Array(J), tx = new Float32Array(J), ty = new Float32Array(J);
  {
    let seg = 0;
    const cum = sg.cum, pts = sg.pts;
    for (let j = 0; j < J; j++) {
      const s = (j / (J - 1)) * sg.len;
      while (seg < pts.length - 2 && cum[seg + 1] < s) seg++;
      const a = cum[seg], b = cum[seg + 1];
      const f = b > a ? (s - a) / (b - a) : 0;
      mx[j] = (pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * f) * S - bx;
      my[j] = (pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * f) * S - by;
    }
    const W = Math.max(1, Math.round(Math.min(6, J / 8)));
    for (let j = 0; j < J; j++) {
      const a = Math.max(0, j - W), b = Math.min(J - 1, j + W);
      const dx = mx[b] - mx[a], dy = my[b] - my[a];
      const l = Math.hypot(dx, dy) || 1;
      tx[j] = dx / l; ty[j] = dy / l;
    }
  }
  // 两侧半宽：沿法线往外走到轮廓外
  const covAt = (x, y) => {
    const ix = Math.floor(x - 0.5), iy = Math.floor(y - 0.5);
    if (ix < 0 || iy < 0 || ix >= bw - 1 || iy >= bh - 1) return 0;
    const fx = x - 0.5 - ix, fy = y - 0.5 - iy, p = iy * bw + ix;
    return cov[p] * (1 - fx) * (1 - fy) + cov[p + 1] * fx * (1 - fy) + cov[p + bw] * (1 - fx) * fy + cov[p + bw + 1] * fx * fy;
  };
  const rp = new Float32Array(J), rm = new Float32Array(J);
  const maxR = 0.25 * S;
  for (let j = 0; j < J; j++) {
    const nx = -ty[j], ny = tx[j];
    for (const [arr, sgn] of [[rp, 1], [rm, -1]]) {
      let r = 0;
      if (covAt(mx[j], my[j]) < 0.5) { arr[j] = NaN; continue; }
      while (r < maxR && covAt(mx[j] + nx * sgn * r, my[j] + ny * sgn * r) >= 0.5) r += 0.5;
      arr[j] = Math.max(0.5, r);
    }
  }
  const fillNaN = (arr) => {
    let last = -1;
    for (let j = 0; j < J; j++) {
      if (!Number.isNaN(arr[j])) {
        if (last < j - 1) for (let q = last + 1; q < j; q++) arr[q] = last < 0 ? arr[j] : arr[last] + (arr[j] - arr[last]) * ((q - last) / (j - last));
        last = j;
      }
    }
    if (last < 0) arr.fill(0.03 * S);
    else for (let q = last + 1; q < J; q++) arr[q] = arr[last];
  };
  fillNaN(rp); fillNaN(rm);
  const sorted = Array.from(rp).concat(Array.from(rm)).sort((a, b) => a - b);
  const rMed = sorted[sorted.length >> 1];
  const smoothArr = (arr, W) => {
    const tmp = Float32Array.from(arr);
    for (let j = 0; j < J; j++) {
      let s = 0, c = 0;
      for (let q = Math.max(0, j - W); q <= Math.min(J - 1, j + W); q++) { s += tmp[q]; c++; }
      arr[j] = Math.max(0.3 * rMed, s / c);
    }
  };
  const SW = Math.max(1, Math.round(rMed * 0.35));
  smoothArr(rp, SW); smoothArr(rm, SW);
  let rMean = 0;
  for (let j = 0; j < J; j++) rMean += (rp[j] + rm[j]) * 0.5;
  rMean /= J;
  // 扫掠：笔尖圆盘沿中线走，记下每个像素第一次被盖住时的弧长（显现时刻）、最近中线点的弧长与横向坐标、
  // 以及一个平滑的弧长参数（高斯加权，转折处不跳）
  const rev = new Float32Array(n).fill(Infinity), sN = new Float32Array(n), uN = new Float32Array(n), near = new Float32Array(n).fill(Infinity);
  const sW = new Float32Array(n), sWS = new Float32Array(n);
  const r0 = Math.max(rp[0], rm[0]);
  for (let j = 0; j < J; j++) {
    const s = (j / (J - 1)) * L;
    const rr = Math.max(rp[j], rm[j]);
    let rho = rr * 1.1 + 0.75;
    const ramp = s / (r0 * 1.3 + 1);
    if (ramp < 1) rho *= 0.35 + 0.65 * ramp; // 落笔：笔毫由尖到铺开
    const rn = rr * 1.25 + margin + 1.5;
    const cx = mx[j], cy = my[j], nx = -ty[j], ny = tx[j];
    const xa = Math.max(0, Math.floor(cx - rn)), xb = Math.min(bw - 1, Math.ceil(cx + rn));
    const ya = Math.max(0, Math.floor(cy - rn)), yb = Math.min(bh - 1, Math.ceil(cy + rn));
    const rho2 = rho * rho, rn2 = rn * rn, ip = 1 / rp[j], im = 1 / rm[j];
    const iw = 1 / (2 * (0.55 * rr + 0.5) ** 2);
    for (let y = ya; y <= yb; y++) {
      const dy = y + 0.5 - cy;
      let p = y * bw + xa;
      for (let x = xa; x <= xb; x++, p++) {
        const dx = x + 0.5 - cx, d2 = dx * dx + dy * dy;
        if (d2 > rn2) continue;
        if (d2 < near[p]) {
          near[p] = d2; sN[p] = s;
          const lat = dx * nx + dy * ny;
          uN[p] = lat >= 0 ? lat * ip : lat * im;
        }
        const w = Math.exp(-d2 * iw);
        sW[p] += w; sWS[p] += w * s;
        if (d2 <= rho2 && rev[p] === Infinity) rev[p] = s;
      }
    }
  }
  const sB = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    if (rev[p] === Infinity) rev[p] = near[p] < Infinity ? sN[p] : L;
    if (near[p] === Infinity) { sN[p] = L; uN[p] = 2; }
    sB[p] = sW[p] > 1e-5 ? sWS[p] / sW[p] : sN[p];
  }
  // 法线方向（给湿墨反光用）：sd 的梯度
  const gx = new Float32Array(n), gy = new Float32Array(n);
  for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
    const p = y * bw + x;
    const ax = sd[p + 1] - sd[p - 1], ay = sd[p + bw] - sd[p - bw];
    const l = Math.hypot(ax, ay) || 1;
    gx[p] = ax / l; gy[p] = ay / l;
  }
  geo = { key, ch, i, S, margin, bx, by, bw, bh, n, cov, sd, rev, sN, sB, uN, gx, gy, J, L, mx, my, tx, ty, rp, rm, rMean, rMed, sg, img: null };
  GEO.set(key, geo);
  return geo;
}

// ---------------------------------------------------------------------------
// 墨与光的外观（每段文字每一笔一份：和写到第几笔、蘸墨状态有关）
function params(o) {
  const wet = clamp01(o.wet ?? 0.5), dry = clamp01(o.dry ?? 0.35);
  return {
    wet, dry,
    dryAmp: 0.1 + 0.34 * dry,           // 笔毛断墨的起伏
    depRate: 0.22 + 0.55 * dry,         // 行笔耗墨
    inkMax: 0.935 + 0.03 * (1 - dry),   // 浓墨的遮盖（留一点给湿边）
    wetEdge: 0.35 + 0.45 * wet,         // 湿边加深
    wetF: 0.08 + 0.3 * wet,             // 纤维毛边
    haloA: 0.012 + 0.05 * wet * wet,    // 水晕
    soft: 0.65 + 0.6 * wet,             // 边缘软硬（像素）
    rough: 0.25 + 0.2 * dry,            // 边缘毛糙（像素）
    wobble: 0.35 + 0.35 * wet,          // 边缘低频起伏（像素，随字号放大）
  };
}

// 洇的尺度是纸的尺度（纤维长短），和字多大无关：全片同一种纸，所以用固定像素
const bleedPx = (P) => 0.7 + 1.3 * P.wet;

function marginFor(S, mode, P) {
  if (mode === 'glow') return 3;
  return Math.ceil(bleedPx(P) * 6 + 3);
}

/** 整段文字的蘸墨计划：每个字开头蘸一次，墨不够了中途再蘸 */
function inkPlan(P, sched, geos, S) {
  const plan = [];
  let load = 1;
  sched.forEach((st, k) => {
    const geo = geos[k];
    if (st.i === 0) load = 1;
    else if (load < 0.42) load = 0.93;
    const widthF = Math.min(1.6, Math.max(0.6, geo.rMean / (0.042 * S)));
    const dep = st.len * P.depRate * widthF * (0.85 + 0.3 * Math.min(2, st.speed));
    plan.push({ loadStart: load, dep });
    load -= dep;
  });
  return plan;
}

const S0 = (geo) => geo.S;

function buildApp(geo, st, pl, P, mode, seed, charOff) {
  const { bw, bh, n, J, L, sd, sB, gx, gy, rMean, rp, rm, sg, mx, my, tx, ty } = geo;
  const S = geo.S;
  const rnd = mulberry32(hashStr(`${seed}|${st.char}|${st.ci}|${st.i}|${mode}`));
  const T = tex();
  const TN = T.N, TM = TN - 1;
  // ---- 沿中线的表 ----
  const load = new Float32Array(J), dens = new Float32Array(J), thr = new Float32Array(J), pool = new Float32Array(J);
  const vbar = sg.len / Math.max(1e-6, (sg.tAt[sg.tAt.length - 1] - sg.tAt[0]) * sg.relDur);
  for (let j = 0; j < J; j++) {
    const u = j / (J - 1);
    const ld = pl.loadStart - pl.dep * Math.pow(u, 0.9);
    load[j] = ld;
    const vrel = sg.speed(u) / vbar;
    const press = (rp[j] + rm[j]) / (2 * rMean);
    pool[j] = 0.06 * Math.max(0, 1 - vrel) + 0.05 * Math.exp(-(u * L) / (0.9 * rMean + 1));
    dens[j] = Math.min(0.975, P.inkMax * (0.9 + 0.1 * clamp01(ld)) * (1 + 0.06 * (press - 1)) + pool[j] * 0.6);
    // 出锋的笔（撇、提、钩、捺）收尾时笔毫提起、散开，尾巴上容易出飞白
    const lift = (sg.type === 'pie' || sg.type === 'ti' || sg.type === 'gou' || sg.type === 'na') ? 0.3 * sstep(0.72, 1.0, u) : 0;
    thr[j] = 0.16 + 0.24 * Math.max(0, vrel - 1) + 0.12 * Math.max(0, st.speed - 1) + lift;
  }
  // ---- 笔毛：横向位置、墨量、断墨 ----
  const N = Math.max(8, Math.min(56, Math.round((2 * rMean) / 1.15)));
  const spacing = (2 * rMean) / N;
  const uK = new Float32Array(N * J), kK = new Float32Array(N * J);
  const clumpPh = [];
  for (let c = 0; c < Math.ceil(N / 3) + 2; c++) clumpPh.push(rnd() * 100);
  const qAmp = new Float32Array(N), qPh = new Float32Array(N), qLam = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const u0 = -1 + (2 * k + 1) / N + (rnd() - 0.5) * (0.8 / N);
    let cap = 0.8 + 0.4 * rnd();
    if (Math.abs(u0) > 0.75) cap *= 0.88; // 边上的毛先干
    const ph1 = rnd() * 100, ph2 = clumpPh[Math.floor(k / 3) + (rnd() < 0.3 ? 1 : 0)], wph = rnd() * 50;
    const lam1 = (0.8 + rnd() * 1.6) * rMean + 3, lam2 = (2.5 + rnd() * 3) * rMean + 6;
    qAmp[k] = rnd(); qPh[k] = rnd() * 100; qLam[k] = (1.5 + rnd() * 3) * rMean + 4;
    for (let j = 0; j < J; j++) {
      const q = k * J + j;
      uK[q] = u0 * (0.97 + 0.04 * noise1(j / (4 * rMean + 3) + wph)) + 0.02 * noise1(j / (2.5 * rMean + 2) + wph * 1.7);
      const th = thr[j] + P.dryAmp * (0.5 * noise1(j / lam1 + ph1) + 0.5 * noise1(j / lam2 + ph2));
      kK[q] = clamp01(0.5 + (load[j] * cap - th) / 0.12);
    }
  }
  // ---- 沿笔毛轨迹撒点：飞白（断墨留下的细白丝）、笔毛浓淡纹理、光丝 ----
  // 转折与起笔处笔锋按住、墨聚，不出飞白；钩只在出锋的后半段出飞白
  const cw = new Float32Array(J);
  const cs = sg.corners.map((c) => c.s * S0(geo));
  for (let j = 0; j < J; j++) {
    const s = (j / (J - 1)) * L;
    let w = Math.exp(-(((s) / (1.1 * rMean + 2)) ** 2));
    for (const c of cs) w = Math.max(w, Math.exp(-(((s - c) / (1.3 * rMean + 2)) ** 2)));
    if (sg.type === 'gou' && cs.length) {
      const c = cs[cs.length - 1];
      if (s > c) w = Math.max(w, 1 - sstep(c + 0.45 * (L - c), L, s));
    }
    cw[j] = w;
  }
  const gap = new Float32Array(n), stN = new Float32Array(n), stD = new Float32Array(n);
  const thd = mode === 'glow' ? new Float32Array(n) : null;
  const splat = (X, Y, dv, qv, sp, tb) => {
    const sig = sp * 0.9, R = Math.ceil(2 * sig + 1.5), is2 = 1 / (2 * sig * sig);
    const tsig = Math.max(0.42, sp * 0.34), it2 = 1 / (2 * tsig * tsig);
    const xa = Math.max(0, Math.floor(X - R)), xb = Math.min(bw - 1, Math.ceil(X + R));
    const ya = Math.max(0, Math.floor(Y - R)), yb = Math.min(bh - 1, Math.ceil(Y + R));
    const hg = sp * (0.18 + 0.42 * dv); // 断得越干净，白丝越宽（按当地笔毛间距）
    for (let y = ya; y <= yb; y++) {
      const dy = y + 0.5 - Y;
      let p = y * bw + xa;
      for (let x = xa; x <= xb; x++, p++) {
        const dx = x + 0.5 - X, d2 = dx * dx + dy * dy;
        const w = Math.exp(-d2 * is2);
        stN[p] += w * qv; stD[p] += w;
        if (dv > 0.02) {
          const c = (hg + 0.5 - Math.sqrt(d2)) * dv;
          if (c > gap[p]) gap[p] = c > dv ? dv : c;
        }
        if (tb > 0) thd[p] += tb * Math.exp(-d2 * it2);
      }
    }
  };
  const thB = new Float32Array(N), thPh = new Float32Array(N);
  for (let k = 0; k < N; k++) { const r = rnd(); thB[k] = r < 0.12 ? 1.6 : 0.35 + 0.65 * rnd(); thPh[k] = rnd() * 100; }
  for (let k = 0; k < N; k++) {
    let pX = 0, pY = 0, pD = 0, pQ = 1, pS = 1, pT = 0;
    for (let j = 0; j < J; j++) {
      const q = k * J + j;
      const u = uK[q];
      const side = u >= 0 ? rp[j] : rm[j];
      const X = mx[j] - ty[j] * u * side, Y = my[j] + tx[j] * u * side;
      let dv = (1 - kK[q]) * (1 - cw[j]);
      const amp = 0.025 + 0.11 * (1 - clamp01(load[j]));
      const qv = 1 + amp * (qAmp[k] * 2 - 1) * (0.6 + 0.4 * noise1(j / qLam[k] + qPh[k]));
      const sp = Math.max(0.35, (rp[j] + rm[j]) / N);
      const tb = mode === 'glow' ? kK[q] * thB[k] * (0.55 + 0.45 * noise1(j / (1.5 * rMean + 4) + thPh[k])) : 0;
      if (j === 0) splat(X, Y, dv, qv, sp, tb * 0.6);
      else {
        const dX = X - pX, dY = Y - pY;
        const dist = Math.hypot(dX, dY);
        // 转弯内侧的笔毛会「倒着走」：那一段笔毛挤在一起，不留白
        if (dist > 1e-6 && dX * tx[j] + dY * ty[j] < 0.35 * dist) dv = 0;
        const m = Math.max(1, Math.ceil(dist / 0.7));
        for (let st2 = 1; st2 <= m; st2++) {
          const f = st2 / m;
          splat(pX + dX * f, pY + dY * f, pD + (dv - pD) * f, pQ + (qv - pQ) * f, pS + (sp - pS) * f, (pT + (tb - pT) * f) / m);
        }
      }
      pX = X; pY = Y; pD = dv; pQ = qv; pS = sp; pT = tb;
    }
  }
  // ---- 逐像素 ----
  const thNorm = 0.7 / 1.0;
  const core = new Float32Array(n), fringe = new Float32Array(n), hl = new Float32Array(n);
  const fr0 = bleedPx(P);
  const we = 0.6 + 0.08 * rMean;
  const wob = P.wobble * (0.6 + 0.02 * rMean);
  const wetLocal = 0.55 + 0.45 * clamp01(pl.loadStart);
  const LX = -0.55, LY = -0.83; // 光从左上来
  const ox = geo.bx + charOff.x, oy = geo.by + charOff.y;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const p = y * bw + x;
      const s0 = sd[p];
      if (s0 > 8 * fr0 + 2) continue;
      const tq = (((y + oy) & TM) * TN) + ((x + ox) & TM);
      const fib = T.F[tq], grn = T.G[tq], wb = T.Wb[(((y + oy + 91) & TM) * TN) + ((x + ox + 37) & TM)];
      const sdr = s0 + P.rough * (grn * 0.8 + (fib - 0.5) * 0.5) + wob * wb;
      const covR = clamp01(0.5 - sdr / P.soft);
      let j = Math.round(sB[p]); if (j < 0) j = 0; else if (j > J - 1) j = J - 1;
      const g = gap[p];
      const stx = stD[p] > 1e-4 ? stN[p] / stD[p] : 1;
      const dIn = sdr < 0 ? -sdr : 0;
      if (mode === 'glow') {
        if (covR <= 0) continue;
        const B = 1 - g;
        const th = thd[p] * thNorm;
        const I = 0.15 * B * (0.7 + 0.3 * clamp01(load[j]))
          + 0.52 * (1 - Math.exp(-1.15 * th))
          + 0.1 * Math.exp(-dIn / (we * 1.2)) * B;
        core[p] = covR * I * (1 - 0.06 * grn);
        continue;
      }
      if (covR > 0) {
        const dj = dens[j];
        const body = Math.min(0.985, dj * stx) * (1 - 0.035 * grn);
        const a = body + P.wetEdge * (1 - body) * Math.exp(-dIn / we);
        core[p] = Math.min(0.995, covR * a * (1 - g));
        // 湿墨反光：迎光一侧的边缘 + 墨聚处
        // 湿墨反光：墨层微微鼓起，迎光（左上）一侧的斜坡反光 + 墨聚处
        const facing = Math.max(0, -(gx[p] * LX + gy[p] * LY));
        const ridge = Math.exp(-(((dIn - 0.3 * rMean) / (0.25 * rMean + 0.8)) ** 2));
        hl[p] = Math.min(1, facing * facing * ridge * 0.85 + pool[j] * 2.5) * covR * (1 - g);
      }
      if (sdr > -1) {
        const o = sdr > 0 ? sdr : 0;
        const edgeD = dens[j] * wetLocal * clamp01(load[j] * 1.4 + 0.15);
        const soft = 0.13 * Math.exp(-o / (0.35 + 0.6 * P.wet));
        const feather = P.wetF * sstep(0.6, 0.95, fib) * Math.exp(-o / (fr0 * (0.45 + 1.0 * fib)));
        const halo = P.haloA * wetLocal * clamp01(load[j]) ** 2 * Math.exp(-o / (fr0 * 2.2));
        fringe[p] = Math.min(0.5, edgeD * (soft + feather) + halo) * (1 - covR);
      }
    }
  }
  return { core, fringe, hl, settled: null, tpass: null, tkey: '' };
}

/** 同一个字里后写的笔画叠在先写的上面：重叠处只加深一点，免得露出轮廓数据里的接缝 */
function applyOverlap(run) {
  const { S, margin, rel, geos, apps } = run;
  const M = margin + 2, side = S + 2 * M;
  let acc = null, cur = -1;
  rel.forEach((st, k) => {
    if (st.ci !== cur) { cur = st.ci; acc = new Float32Array(side * side); }
    const geo = geos[k], app = apps[k];
    const { bw, bh, bx, by } = geo;
    for (let y = 0; y < bh; y++) {
      const Y = by + y + M;
      if (Y < 0 || Y >= side) continue;
      for (let x = 0; x < bw; x++) {
        const X = bx + x + M;
        if (X < 0 || X >= side) continue;
        const p = y * bw + x, q = Y * side + X;
        const prev = acc[q];
        const a2 = app.core[p];
        if (prev <= 0.001 || a2 <= 0) { if (a2 > 0) acc[q] = 1 - (1 - prev) * (1 - a2); continue; }
        // 叠完的目标：取两者较浓的，再加一点点（浓墨叠浓墨只深一点）
        const hi = prev > a2 ? prev : a2, lo = prev > a2 ? a2 : prev;
        const target = 1 - (1 - hi) * (1 - 0.14 * lo);
        const a = prev >= 0.999 ? 0 : Math.max(0, 1 - (1 - target) / (1 - prev));
        app.core[p] = a;
        app.fringe[p] *= (1 - prev) * (1 - prev);
        acc[q] = 1 - (1 - prev) * (1 - a);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 排版
export function textLayout(text, o = {}) {
  const { x = 0, y = 0, size = 200, vertical = true, gap = 0.12 } = o;
  const step = size * (1 + gap);
  return Array.from(text).map((ch, ci) => ({
    char: ch, ci,
    x: Math.round(vertical ? x : x + ci * step),
    y: Math.round(vertical ? y + ci * step : y),
    size,
  }));
}

const SCHED = new Map();
function schedFor(text, t0, dur, o) {
  const key = `${text}|${t0}|${dur}|${o.strokePause ?? ''}|${o.charPause ?? ''}|${o.travel ?? ''}`;
  let s = SCHED.get(key);
  if (!s) {
    s = strokeSchedule(text, t0, dur, o);
    if (SCHED.size > 200) SCHED.clear();
    SCHED.set(key, s);
  }
  return s;
}

/** 这段文字（字号、墨）对应的全部笔画缓存 */
const RUNS = new Map();
function runFor(text, o) {
  const S = Math.max(8, Math.round(o.size ?? 200));
  const mode = o.mode === 'glow' ? 'glow' : 'ink';
  const P = params(o);
  const seed = o.seed ?? 1;
  const key = `${text}|${S}|${mode}|${P.wet}|${P.dry}|${seed}|${o.strokePause ?? ''}|${o.charPause ?? ''}`;
  let run = RUNS.get(key);
  if (run) return run;
  const margin = marginFor(S, mode, P);
  const rel = strokeSchedule(text, 0, 1, o); // 相对节奏（和绝对时长无关）
  const geos = rel.map((st) => strokeGeoPx(st.char, st.i, S, margin));
  const plan = inkPlan(P, rel, geos, S);
  const apps = rel.map((st, k) => buildApp(geos[k], st, plan[k], P, mode, seed, { x: st.ci * 97, y: st.ci * 61 }));
  run = { key, S, mode, P, seed, margin, rel, geos, apps, text };
  if (mode === 'ink') applyOverlap(run);
  if (RUNS.size > 64) RUNS.clear();
  RUNS.set(key, run);
  return run;
}

/** 建场景时调用：把这段文字的笔画缓存算好（参数同 writeText） */
export function prepareText(text, o = {}) {
  for (const ch of Array.from(text)) if (!isBlank(ch)) glyphData(ch);
  const run = runFor(text, o);
  const ink = run.mode === 'glow' ? PALETTE.electro : (o.ink || PALETTE.ink);
  run.geos.forEach((geo, k) => settledCanvas(geo, run.apps[k], run.mode, ink));
  return { strokes: run.rel.length, size: run.S };
}

// ---------------------------------------------------------------------------
// 逐帧合成
const GROW_T = 0.55;   // 毛边长出来的时间（秒）
const SHEEN_T = 3.2;   // 湿墨反光消失的时间（秒）
const HOT_T = 0.7;     // glow：刚写的部分变「凉」的时间

let SCRATCH = null;
function scratch(w, h) {
  if (!SCRATCH || SCRATCH.width < w || SCRATCH.height < h) {
    SCRATCH = mkCanvas(Math.max(w, SCRATCH ? SCRATCH.width : 0), Math.max(h, SCRATCH ? SCRATCH.height : 0));
    SCRATCH._c = SCRATCH.getContext('2d');
  }
  return SCRATCH;
}

/**
 * 合成一笔的当前样子到 ImageData（sCur：笔尖弧长 px；now：当前时刻；tpass：弧长→经过时刻）
 * settledOnly=true 时按「早就干了」画（缓存用）
 */
function composeStroke(geo, app, mode, sCur, now, tpass, ink, settledOnly) {
  const { bw, bh, rev, J } = geo;
  const n = bw * bh;
  if (!geo.img || geo.img.width !== bw) geo.img = new ImageData(bw, bh);
  const D = geo.img.data;
  const { core, fringe, hl } = app;
  const ir = ink[0], ig = ink[1], ib = ink[2];
  const E = PALETTE.electro;
  const SH0 = 128, SH1 = 132, SH2 = 138;
  const e1 = Math.exp(-SHEEN_T / 1.1);
  for (let p = 0; p < n; p++) {
    const q = p * 4;
    const a0 = core[p], f0 = mode === 'glow' ? 0 : fringe[p];
    if (a0 + f0 < 0.002) { D[q + 3] = 0; continue; }
    let age = INF, front = 1;
    if (!settledOnly) {
      const r = rev[p];
      if (r > sCur + 1) { D[q + 3] = 0; continue; }
      front = sCur - r + 1; if (front > 1) front = 1;
      let jj = r | 0; if (jj > J - 1) jj = J - 1;
      age = now - tpass[jj];
    }
    if (mode === 'glow') {
      const hot = age < HOT_T ? (1 - Math.max(0, age) / HOT_T) ** 2 : 0;
      // 刚写的部分只是更亮一点、更白一点，不能整笔烧成一片白（笔毛的明暗结构要留着）
      const I = a0 * (1 + 0.15 * hot) * front;
      const w = clamp01((I - 0.55) * 1.6) * 0.8 + hot * 0.06;
      D[q] = E[0] + (255 - E[0]) * w; D[q + 1] = E[1] + (255 - E[1]) * w; D[q + 2] = E[2] + (255 - E[2]) * w;
      D[q + 3] = (I > 1 ? 1 : I) * 255;
      continue;
    }
    const grow = age >= GROW_T ? 1 : 1 - (1 - Math.max(0, age) / GROW_T) ** 2;
    let a = a0 + f0 * grow * (1 - a0);
    if (a > 1) a = 1;
    a *= front;
    let sh = 0;
    if (age < SHEEN_T) sh = ((Math.exp(-Math.max(0, age) / 1.1) - e1) / (1 - e1)) * hl[p] * 0.5;
    D[q] = ir + (SH0 - ir) * sh; D[q + 1] = ig + (SH1 - ig) * sh; D[q + 2] = ib + (SH2 - ib) * sh;
    D[q + 3] = a * 255;
  }
  return geo.img;
}

function tpassFor(geo, app, st) {
  const key = `${st.start}|${st.end}`;
  if (app.tkey === key) return app.tpass;
  const J = geo.J;
  const tp = app.tpass && app.tpass.length === J ? app.tpass : new Float64Array(J);
  for (let j = 0; j < J; j++) tp[j] = arcTime(st, j / (J - 1));
  app.tpass = tp; app.tkey = key;
  return tp;
}

function settledCanvas(geo, app, mode, ink) {
  const key = ink.join(',');
  if (app.settled && app.settledKey === key) return app.settled;
  const img = composeStroke(geo, app, mode, geo.L + 2, INF, null, ink, true);
  const cv = mkCanvas(geo.bw, geo.bh);
  cv.getContext('2d').putImageData(img, 0, 0);
  app.settled = cv; app.settledKey = key;
  return cv;
}

// glow 的整段文字画布（先在这里合成，再带两层辉光叠到目标上）
const GLOWC = new Map();

/**
 * 按笔顺把文字写到 Canvas2D 上。见文件头注释。
 */
export function writeText(c, text, o = {}) {
  const mode = o.mode === 'glow' ? 'glow' : 'ink';
  const run = runFor(text, o);
  const S = run.S;
  const boxes = textLayout(text, { ...o, size: S });
  // 时间
  let now, t0, dur;
  if (o.progress !== undefined && o.t === undefined) {
    dur = o.dur ?? 4; t0 = 0;
    const pr = o.progress;
    now = pr >= 1 ? INF : pr * dur;
  } else {
    now = o.t ?? 0; t0 = o.t0 ?? 0; dur = o.dur ?? 4;
  }
  const sched = schedFor(text, t0, dur, o);
  const ink = mode === 'glow' ? PALETTE.electro : (o.ink || PALETTE.ink);
  const alpha = o.alpha ?? 1;
  let tip = null, done = true;

  let target = c, glowC = null, gx0 = 0, gy0 = 0;
  if (mode === 'glow') {
    // 文字包围盒 + 辉光边距
    const pad = Math.ceil(S * 0.16);
    const last = boxes[boxes.length - 1];
    gx0 = boxes[0].x - pad; gy0 = boxes[0].y - pad;
    const gw = last.x + S + pad - gx0, gh = last.y + S + pad - gy0;
    const gk = `${run.key}|${gw}|${gh}`;
    glowC = GLOWC.get(gk);
    if (!glowC) { glowC = mkCanvas(gw, gh); glowC._c = glowC.getContext('2d'); GLOWC.set(gk, glowC); }
    glowC._c.setTransform(1, 0, 0, 1, 0, 0);
    glowC._c.globalCompositeOperation = 'source-over';
    glowC._c.clearRect(0, 0, gw, gh);
    glowC._c.globalCompositeOperation = 'lighten';
    target = glowC._c;
  } else {
    c.save();
    c.globalAlpha = c.globalAlpha * alpha;
    c.globalCompositeOperation = o.composite || 'source-over';
  }

  const hide = o.hide || null;
  for (let k = 0; k < sched.length; k++) {
    const st = sched[k];
    if (hide && hide.includes(st.ci)) continue;
    const geo = run.geos[k], app = run.apps[k];
    const box = boxes[st.ci];
    const ox = box.x + geo.bx - (mode === 'glow' ? gx0 : 0), oy = box.y + geo.by - (mode === 'glow' ? gy0 : 0);
    if (now < st.start) { done = false; continue; }
    const arc = strokeArc(st, now);
    const settleT = mode === 'glow' ? HOT_T : Math.max(GROW_T, SHEEN_T);
    if (arc >= 1 && now - st.end >= settleT + 0.05) {
      target.drawImage(settledCanvas(geo, app, mode, ink), ox, oy);
      continue;
    }
    if (arc < 1) {
      done = false;
      const j = Math.min(geo.J - 1, Math.round(arc * (geo.J - 1)));
      tip = { x: box.x + geo.bx + geo.mx[j], y: box.y + geo.by + geo.my[j], r: Math.max(geo.rp[j], geo.rm[j]), char: st.char, ci: st.ci, i: st.i, k, arc };
    }
    const tp = tpassFor(geo, app, st);
    const img = composeStroke(geo, app, mode, arc * geo.L, now, tp, ink, false);
    const sc = scratch(geo.bw, geo.bh);
    sc._c.putImageData(img, 0, 0);
    target.drawImage(sc, 0, 0, geo.bw, geo.bh, ox, oy, geo.bw, geo.bh);
  }

  if (mode === 'glow') {
    const g = glowC._c;
    // 笔尖亮点
    if (tip) {
      // 只是一个小亮点：外面还要叠两层辉光和后期泛光，这里给多了就会烧成一团白
      const x = tip.x - gx0, y = tip.y - gy0, r = tip.r * 0.6 + 2;
      g.globalCompositeOperation = 'lighter';
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(255,255,255,0.2)');
      grd.addColorStop(0.3, `rgba(${PALETTE.electro.join(',')},0.08)`);
      grd.addColorStop(1, `rgba(${PALETTE.electro.join(',')},0)`);
      g.fillStyle = grd;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    c.save();
    const a0 = c.globalAlpha * alpha;
    c.globalCompositeOperation = 'lighter';
    const h1 = Math.max(1.5, S * 0.012), h2 = Math.max(4, S * 0.05);
    c.filter = `blur(${h2.toFixed(1)}px)`;
    c.globalAlpha = a0 * 0.55;
    c.drawImage(glowC, gx0, gy0);
    c.filter = `blur(${h1.toFixed(1)}px)`;
    c.globalAlpha = a0 * 0.7;
    c.drawImage(glowC, gx0, gy0);
    c.filter = 'none';
    c.globalAlpha = a0;
    c.drawImage(glowC, gx0, gy0);
    c.restore();
  } else {
    c.restore();
  }
  return { tip, done, boxes };
}

/** 合成用：这段文字的笔画缓存（几何场、墨量），比如 S8 洗字要读「鲔」的墨 */
export function textRun(text, o = {}) { return runFor(text, o); }
