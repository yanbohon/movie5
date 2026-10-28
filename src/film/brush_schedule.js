// 书法笔顺时间表（纯函数，不依赖浏览器）：events.js 在 node 里 import 它，场景和 brush.js 在浏览器里用同一份。
// 字形数据来自 src/data/hanzi.json（Make Me a Hanzi 楷书：轮廓 strokes + 笔顺中线 medians，1024 字框，y 轴向上，基线偏移 900）。
// 缺字：把字加进 script/brush_chars.txt，运行 node tools/extract_hanzi.mjs。
import HANZI from '../data/hanzi.json' with { type: 'json' };

const EM = 1024, BASE = 900;

export function hasGlyph(ch) { return Object.prototype.hasOwnProperty.call(HANZI, ch); }

/** 取一个字的原始数据；缺字直接抛错并说明怎么补 */
export function glyphData(ch) {
  const g = HANZI[ch];
  if (!g) throw new Error(`brush: 字库里没有「${ch}」。把它加进 script/brush_chars.txt，然后运行 node tools/extract_hanzi.mjs`);
  return g;
}

/** 这个字符要不要写（空格和标点只占位不写） */
export const isBlank = (ch) => !hasGlyph(ch) && /[\s　·，。、]/.test(ch);

// ---------------------------------------------------------------------------
// 笔画几何（字框单位：0..1，y 向下），带缓存
const geomCache = new Map();

function catmull(pts, step) {
  // Catmull-Rom 细分成近似等距的密集折线（字框单位）
  const out = [];
  const n = pts.length;
  if (n === 1) return [pts[0].slice()];
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const m = Math.max(1, Math.ceil(seg / step));
    for (let k = 0; k < m; k++) {
      const t = k / m, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[n - 1].slice());
  return out;
}

// 笔画类型：dian 点 / heng 横 / shu 竖 / pie 撇 / na 捺 / ti 提 / zhe 折 / gou 钩
// 中线开头常有一个小弯（起笔的入锋动作），不算「折」，分类时从这个弯之后算方向
function classify(pts, cum, len, corners) {
  const entry = Math.min(0.22 * len, 0.09);
  const main = corners.filter((c) => c.s >= entry);
  const c0 = corners.find((c) => c.s < entry);
  let ka = 0;
  if (c0) while (ka < pts.length - 1 && cum[ka] < c0.s) ka++;
  const a = pts[ka], b = pts[pts.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (len < 0.13) return Math.abs(dy) < 0.35 * Math.abs(dx) ? 'heng' : 'dian';
  if (main.length) {
    const last = main[main.length - 1];
    return len - last.s < 0.16 * len + 0.02 ? 'gou' : 'zhe';
  }
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (dx > 0 && dy < -0.36 * adx) return len < 0.45 ? 'ti' : 'heng';
  if (ady < 0.42 * adx) return 'heng';
  if (dx < 0 && dy > 0 && adx > 0.2 * ady) return 'pie';
  if (adx < 0.36 * ady && dy > 0) return 'shu';
  if (dx < 0 && dy > 0) return 'pie';
  if (dx > 0 && dy > 0) return len < 0.22 ? 'dian' : 'na';
  return 'heng';
}

const BASE_SPEED = { dian: 0.6, heng: 1.0, shu: 0.85, pie: 1.2, na: 0.8, ti: 1.45, zhe: 0.9, gou: 0.9 };
const sm = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** 行笔速度（字框单位/相对时间单位），u = 弧长比例 0..1 */
function speedShape(type, u, corners, s, len) {
  let v;
  switch (type) {
    case 'pie': v = 0.42 + 1.15 * Math.pow(u, 1.25); break;                 // 撇：越写越快，出锋
    case 'ti': v = 0.55 + 1.1 * u; break;                                   // 提：一挑而过
    case 'dian': v = 0.95 - 0.55 * u; break;                                // 点：落笔快，按住收
    case 'na': v = 0.62 + 0.3 * Math.sin(Math.PI * Math.min(1, u * 1.15))   // 捺：一路铺毫，捺脚一顿再出锋
      - 0.42 * Math.exp(-(((u - 0.8) / 0.07) ** 2)) + 0.65 * sm(0.88, 1, u); break;
    default: v = 0.42 + 0.58 * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.06)), 0.55);   // 横竖折：慢起、匀行、慢收
  }
  if (type === 'gou' && corners.length) {
    const c = corners[corners.length - 1].s / len;
    if (u > c) v = 0.7 + 1.4 * sm(c, c + (1 - c) * 0.6, u);                // 钩：顿一下再踢出去
  }
  for (const c of corners) v *= 1 - 0.72 * Math.exp(-(((s - c.s) / 0.028) ** 2)); // 转折处顿笔
  return Math.max(0.12, v);
}

const NT = 64; // 时间表采样数

// 相距不到 0.06 字框的两个转折合并成一个（保留转得更急的）
function pushCorner(list, c) {
  const last = list[list.length - 1];
  if (last && c.s - last.s < 0.06) { if (c.ang > last.ang) list[list.length - 1] = c; return; }
  list.push(c);
}

/**
 * 一笔的几何与行笔节奏（字框单位，y 向下）：
 * { pts 密集中线, cum 累计弧长, len, type, corners, relDur 相对时长, tAt[NT] 弧长比例→时间比例, speed(u) }
 */
export function strokeGeom(ch, i) {
  const key = ch + '|' + i;
  let g = geomCache.get(key);
  if (g) return g;
  const raw = glyphData(ch).medians[i].map(([x, y]) => [x / EM, (BASE - y) / EM]);
  const pts = catmull(raw, 0.004);
  const cum = new Float64Array(pts.length);
  for (let k = 1; k < pts.length; k++) cum[k] = cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  const len = Math.max(1e-4, cum[pts.length - 1]);
  // 转折：密集中线上，前后各 0.05 字框的方向夹角大于 48° 的局部极大
  const corners = [];
  const W = 12; // 0.004 × 12 ≈ 0.048 字框
  let best = null;
  for (let k = W; k < pts.length - W; k++) {
    const ax = pts[k][0] - pts[k - W][0], ay = pts[k][1] - pts[k - W][1];
    const bx = pts[k + W][0] - pts[k][0], by = pts[k + W][1] - pts[k][1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-4 || lb < 1e-4) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
    if (ang > (48 * Math.PI) / 180) {
      if (!best || ang > best.ang) best = { s: cum[k], ang };
    } else if (best) { pushCorner(corners, best); best = null; }
  }
  if (best) pushCorner(corners, best);
  const type = classify(pts, cum, len, corners);
  // 积分 dt = ds / v
  const M = 200;
  const tc = new Float64Array(M + 1);
  const bs = BASE_SPEED[type];
  for (let k = 1; k <= M; k++) {
    const u0 = (k - 1) / M, u1 = k / M;
    const v0 = bs * speedShape(type, u0, corners, u0 * len, len), v1 = bs * speedShape(type, u1, corners, u1 * len, len);
    tc[k] = tc[k - 1] + (len / M) * 0.5 * (1 / v0 + 1 / v1);
  }
  const press = type === 'dian' ? 0.05 : 0.03; // 落笔与收笔的按压也占时间（按在弧长两端）
  const relDur = tc[M] + press;
  // tAt[j]：弧长比例 j/(NT-1) 处的时间比例（两端各分一半按压时间）
  const tAt = new Float64Array(NT);
  for (let j = 0; j < NT; j++) {
    const x = (j / (NT - 1)) * M, k0 = Math.floor(x), f = x - k0;
    const tv = k0 >= M ? tc[M] : tc[k0] + (tc[k0 + 1] - tc[k0]) * f;
    tAt[j] = (press * 0.5 + tv) / relDur;
  }
  tAt[0] = press * 0.5 / relDur;
  const speed = (u) => bs * speedShape(type, u, corners, u * len, len);
  g = { pts, cum, len, type, corners, relDur, tAt, speed, start: pts[0], end: pts[pts.length - 1] };
  geomCache.set(key, g);
  return g;
}

// ---------------------------------------------------------------------------
/**
 * 整段文字每一笔的绝对时间。笔速按中线长度与笔画类型分配（撇提快、捺折慢），
 * 笔间有提笔移位的停顿（和空中移动的距离有关），字间停顿更长。总时长正好是 dur。
 * @param {string} text
 * @param {number} t0 第一笔落笔时刻（秒）
 * @param {number} dur 最后一笔收笔 - 第一笔落笔（秒）
 * @param {object} opts strokePause（相对单位，默认 0.13）、travel（移位系数，默认 0.32）、charPause（默认 0.6）
 * @returns {{char, ci, i, k, start, end, len, type, speed}[]}  ci 第几个字，i 字内第几笔，k 全段第几笔，len 中线长（字框单位）
 */
export function strokeSchedule(text, t0, dur, opts = {}) {
  const { strokePause = 0.13, travel = 0.32, charPause = 0.6 } = opts;
  const chars = Array.from(text);
  const items = [];
  let tRel = 0, prevEnd = null, first = true, pendingCharPause = false;
  chars.forEach((ch, ci) => {
    if (!hasGlyph(ch)) {
      if (isBlank(ch)) { pendingCharPause = true; return; }
      glyphData(ch); // 抛错
    }
    const n = glyphData(ch).medians.length;
    for (let i = 0; i < n; i++) {
      const g = strokeGeom(ch, i);
      if (!first) {
        if (i === 0 || pendingCharPause) tRel += charPause;
        else tRel += strokePause + travel * Math.hypot(g.start[0] - prevEnd[0], g.start[1] - prevEnd[1]);
      }
      pendingCharPause = false;
      items.push({ char: ch, ci, i, rs: tRel, re: tRel + g.relDur, len: g.len, type: g.type });
      tRel += g.relDur;
      prevEnd = g.end;
      first = false;
    }
  });
  const total = Math.max(1e-6, tRel);
  const k = dur / total;
  const meanSpeed = items.reduce((a, it) => a + it.len, 0) / Math.max(1e-6, items.reduce((a, it) => a + (it.re - it.rs), 0));
  return items.map((it, idx) => ({
    char: it.char, ci: it.ci, i: it.i, k: idx,
    start: t0 + it.rs * k, end: t0 + it.re * k,
    len: it.len, type: it.type,
    speed: it.len / Math.max(1e-6, it.re - it.rs) / meanSpeed, // 相对行笔速度（1 = 这段文字的平均）
  }));
}

/** 时刻 t 这一笔写到了中线的哪里（弧长比例 0..1，带行笔的快慢） */
export function strokeArc(st, t) {
  if (t <= st.start) return 0;
  if (t >= st.end) return 1;
  const g = strokeGeom(st.char, st.i);
  const f = (t - st.start) / (st.end - st.start);
  const T = g.tAt;
  if (f <= T[0]) return 0;
  // 二分查找时间比例
  let lo = 0, hi = NT - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= f) lo = m; else hi = m; }
  const a = T[lo], b = T[hi];
  return (lo + (b > a ? (f - a) / (b - a) : 0)) / (NT - 1);
}

/** 笔尖到达弧长比例 u 的绝对时刻（strokeArc 的反函数） */
export function arcTime(st, u) {
  const g = strokeGeom(st.char, st.i);
  const x = Math.min(1, Math.max(0, u)) * (NT - 1), j = Math.min(NT - 2, Math.floor(x)), f = x - j;
  const tf = g.tAt[j] + (g.tAt[j + 1] - g.tAt[j]) * f;
  return st.start + tf * (st.end - st.start);
}

/** 一段文字在 [t0, t0+dur] 里的整体书写进度 → 各笔状态（给 progress 模式用） */
export function textStrokeCount(text) {
  return Array.from(text).reduce((a, ch) => a + (hasGlyph(ch) ? glyphData(ch).medians.length : 0), 0);
}
