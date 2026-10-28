// S2 长卷的母题（人事）：火、茅屋、船、帆、宗庙、鼎、亭、民居、铁桥、轮船、烟囱、黑烟……全部用 ink.js 的笔墨光栅器画
// 山水见 land.js，草木见 flora.js，恐龙见 fauna.js
// 约定：函数第一个参数是 InkBuf（为 null 时直接返回，便于分通道多遍绘制），坐标为世界坐标。
import { stroke, wash, dot, erase, rng, vn1, tubePoly, figure } from '../../film/ink.js';

const lerp = (a, b, t) => a + (b - a) * t;
const ss = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

/** 按时间窗切分：返回 {t0, t1}（o 没有 t0 时返回空对象） */
export function twin(o, a, b) {
  if (!o || o.t0 === undefined) return {};
  return { t0: o.t0 + (o.t1 - o.t0) * a, t1: o.t0 + (o.t1 - o.t0) * b };
}

// ---------------------------------------------------------------------------
// 人间
/** 火：几笔上挑的焰 + 一缕烟 */
export function fire(buf, x, y, s, o = {}) {
  if (!buf) return;
  const R = rng((o.seed ?? 1) * 43 + 3);
  const T = o.tw;
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + R.r(-0.5, 0.5), l = s * R.r(0.5, 1);
    stroke(buf, [[x + R.r(-s * 0.2, s * 0.2), y, 1], [x + Math.cos(a) * l * 0.5 + R.r(-2, 2), y + Math.sin(a) * l * 0.5, 0.8], [x + Math.cos(a) * l, y + Math.sin(a) * l, 0.1]], { w: s * 0.2, tone: 0.85, tail: 0.7, dry: 0.1, dryEnd: 0.6, seed: (o.seed ?? 1) * 10 + i, ...(T ? twin(T, 0.1 + i * 0.05, 0.25 + i * 0.05) : {}) });
  }
  // 柴
  stroke(buf, [[x - s * 0.5, y + 2, 1], [x + s * 0.5, y - 1, 0.8]], { w: s * 0.12, tone: 0.9, seed: (o.seed ?? 1) * 10 + 7, ...(T ? twin(T, 0, 0.1) : {}) });
  stroke(buf, [[x - s * 0.4, y - 2, 0.8], [x + s * 0.45, y + 3, 1]], { w: s * 0.1, tone: 0.8, seed: (o.seed ?? 1) * 10 + 8, ...(T ? twin(T, 0.05, 0.12) : {}) });
  // 烟：一缕上升、被风吹斜的淡线
  const pts = [];
  const sh = o.smokeH ?? s * 6;
  for (let k = 0; k <= 12; k++) {
    const u = k / 12;
    pts.push([x + Math.sin(u * 5.5 + (o.seed ?? 1)) * s * 0.4 * u + (o.wind ?? 1) * u * u * sh * 0.5, y - s * 0.8 - u * sh, 0.9 - 0.5 * u]);
  }
  stroke(buf, pts, { w: s * 0.22, tone: 0.3, dry: 0.3, dryEnd: 0.8, halo: 3, haloK: 0.4, tail: 0.5, seed: (o.seed ?? 1) * 10 + 9, ...(T ? twin(T, 0.35, 1) : {}) });
}
/** 茅屋：尖顶草棚 */
export function hut(buf, x, y, s, o = {}) {
  if (!buf) return;
  const T = o.tw;
  const tone = o.tone ?? 0.7;
  wash(buf, [[x - s * 0.55, y - s * 0.35], [x, y - s * 1.05], [x + s * 0.55, y - s * 0.35], [x + s * 0.4, y - s * 0.28], [x - s * 0.4, y - s * 0.28]], { tone: tone * 0.5, rim: 0.5, jag: 1.5, jagScale: 8, bleed: 2, gran: 0.5, streak: 0.4, streakAng: 1.2, seed: (o.seed ?? 1) * 3, ...(T ? twin(T, 0, 0.4) : {}) });
  stroke(buf, [[x - s * 0.6, y - s * 0.32, 0.6], [x - s * 0.2, y - s * 0.8, 1], [x, y - s * 1.08, 0.5]], { w: s * 0.06, tone, seed: (o.seed ?? 1) * 3 + 1, dry: 0.3, ...(T ? twin(T, 0.3, 0.55) : {}) });
  stroke(buf, [[x, y - s * 1.08, 0.5], [x + s * 0.25, y - s * 0.75, 1], [x + s * 0.62, y - s * 0.3, 0.6]], { w: s * 0.06, tone, seed: (o.seed ?? 1) * 3 + 2, dry: 0.3, ...(T ? twin(T, 0.55, 0.75) : {}) });
  stroke(buf, [[x - s * 0.38, y - s * 0.3, 1], [x - s * 0.38, y, 0.8]], { w: s * 0.05, tone: tone * 0.8, seed: (o.seed ?? 1) * 3 + 3, ...(T ? twin(T, 0.75, 0.85) : {}) });
  stroke(buf, [[x + s * 0.36, y - s * 0.3, 1], [x + s * 0.36, y, 0.8]], { w: s * 0.05, tone: tone * 0.8, seed: (o.seed ?? 1) * 3 + 4, ...(T ? twin(T, 0.8, 0.9) : {}) });
  wash(buf, [[x - s * 0.1, y - s * 0.26], [x + s * 0.12, y - s * 0.26], [x + s * 0.12, y], [x - s * 0.1, y]], { tone: tone * 0.9, rim: 0.3, jag: 0.8, seed: (o.seed ?? 1) * 3 + 5, ...(T ? twin(T, 0.85, 1) : {}) });
}
/** 船身：一道弧（x 船头，dir 船头方向），返回船舷线 */
export function hull(buf, x, y, len, o = {}) {
  const d = o.dir ?? -1, tone = o.tone ?? 0.8, T = o.tw;
  const hh = o.h ?? len * 0.09, rise = o.rise ?? len * 0.05;
  const bow = [x, y - rise], stern = [x - d * len, y - rise * (o.sternRise ?? 0.8)];
  if (o.knock) o.knock([[bow[0] + d * 3, bow[1] - 3], [x - d * len * 0.15, y - hh * 0.3 - 3], [x - d * len * 0.85, y - hh * 0.3 - 3], [stern[0] - d * 3, stern[1] - 3], [x - d * len * 0.88, y + hh * 0.6 + 3], [x - d * len * 0.5, y + hh + 4], [x - d * len * 0.12, y + hh * 0.7 + 3]]);
  if (!buf) return { bow, stern, deckY: y - hh * 0.2 };
  // 船舷（上沿）
  stroke(buf, [[bow[0], bow[1], 0.4], [x - d * len * 0.15, y - hh * 0.25, 1], [x - d * len * 0.5, y - hh * 0.15, 1], [x - d * len * 0.85, y - hh * 0.25, 0.9], [stern[0], stern[1], 0.4]], { w: o.w ?? Math.max(2, len * 0.018), tone, dry: 0.1, dryEnd: 0.4, seed: (o.seed ?? 1) * 3, ...(T ? twin(T, 0, 0.4) : {}) });
  // 船底弧
  stroke(buf, [[bow[0], bow[1], 0.3], [x - d * len * 0.12, y + hh * 0.7, 0.9], [x - d * len * 0.5, y + hh, 1], [x - d * len * 0.88, y + hh * 0.6, 0.8], [stern[0], stern[1], 0.3]], { w: (o.w ?? Math.max(2, len * 0.018)) * 0.8, tone: tone * 0.8, dry: 0.2, dryEnd: 0.6, seed: (o.seed ?? 1) * 3 + 1, ...(T ? twin(T, 0.3, 0.7) : {}) });
  wash(buf, [[bow[0], bow[1]], [x - d * len * 0.15, y - hh * 0.2], [x - d * len * 0.85, y - hh * 0.2], [stern[0], stern[1]], [x - d * len * 0.88, y + hh * 0.6], [x - d * len * 0.5, y + hh], [x - d * len * 0.12, y + hh * 0.7]],
    { tone: tone * (o.fill ?? 0.35), rim: 0.4, jag: 1, jagScale: 10, bleed: 2, gran: 0.5, streak: 0.3, streakAng: 0.05, seed: (o.seed ?? 1) * 3 + 2, ...(T ? twin(T, 0.4, 0.8) : {}) });
  // 水线下两道淡影
  for (let k = 0; k < 2; k++) stroke(buf, [[x - d * len * (0.05 + k * 0.1), y + hh + 4 + k * 5, 0.3], [x - d * len * 0.5, y + hh + 6 + k * 5, 1], [x - d * len * (0.95 - k * 0.1), y + hh + 4 + k * 5, 0.3]], { w: 1.4, tone: tone * 0.35, dry: 0.3, seed: (o.seed ?? 1) * 3 + 5 + k, ...(T ? twin(T, 0.8, 1) : {}) });
  return { bow, stern, deckY: y - hh * 0.2 };
}
/** 帆：竹篾撑的硬帆——桅在前缘，后缘一道弧，几根篾微微下垂；帆面淡墨，后缘与下沿深 */
export function sail(buf, x, y, h, o = {}) {
  const d = o.dir ?? 1, tone = o.tone ?? 0.6, R = rng((o.seed ?? 1) * 47 + 5);
  const w = h * (o.wk ?? 0.52);
  const leech = [];
  for (let k = 0; k <= 10; k++) {
    const v = k / 10;
    leech.push([x - d * w * (0.78 + 0.22 * Math.sin(v * Math.PI * 0.5)) - d * w * 0.07 * Math.sin(v * Math.PI), lerp(y - h * 0.92, y - h * 0.06, v)]);
  }
  const poly = [[x, y - h * 0.05], [x, y - h * 1.0], ...leech];
  if (o.knock) o.knock([[x + d * 3, y], [x + d * 3, y - h * 1.1], ...leech.map(([px, py]) => [px - d * 3, py])]);
  if (!buf) return;
  stroke(buf, [[x, y + 2, 1], [x + R.r(-1, 1), y - h * 1.1, 0.6]], { w: Math.max(1.8, h * 0.022), tone: Math.min(0.95, tone * 1.4), dry: 0.15, seed: (o.seed ?? 1) * 3 });
  wash(buf, poly, { tone: tone * 0.36, rim: 0.45, rimW: 2, jag: 1.2, jagScale: 14, bleed: 2, gran: 0.6, bloom: 0.4, bloomScale: 30, seed: (o.seed ?? 1) * 3 + 1,
    gfn: (wx, wy) => 0.55 + 0.3 * ss(x, x - d * w, wx) + 0.2 * ss(y - h * 0.5, y, wy) });
  // 篾：五六根，从桅到后缘，中间微微下垂
  const nb = o.battens ?? 6;
  for (let i = 1; i <= nb; i++) {
    const v = i / (nb + 1);
    const yy = lerp(y - h * 0.92, y - h * 0.06, v);
    const [lx, ly] = leech[Math.round(v * 10)];
    stroke(buf, [[x, yy, 0.9], [lerp(x, lx, 0.5), lerp(yy, ly, 0.5) + h * 0.018, 1], [lx, ly, 0.6]], { w: Math.max(1.1, h * 0.009), tone: tone * 0.95, dry: 0.35, dryEnd: 0.7, seed: (o.seed ?? 1) * 40 + i });
  }
  stroke(buf, leech.map(([px, py], k) => [px, py, 0.5 + 0.5 * Math.sin(k / 10 * Math.PI)]), { w: Math.max(1.3, h * 0.012), tone: tone * 1.05, dry: 0.3, dryEnd: 0.6, seed: (o.seed ?? 1) * 3 + 2 });
  stroke(buf, [[x, y - h * 1.0, 0.8], [leech[0][0], leech[0][1], 0.6]], { w: Math.max(1.3, h * 0.012), tone: tone * 1.1, seed: (o.seed ?? 1) * 3 + 4 });
}

// ---------------------------------------------------------------------------
// 建筑
/** 宗庙：夯土台基、台阶、一排柱、深的屋身、四坡大顶（坡面微凹、檐口两端略起）、正脊；o.knock(poly) 先把后面让出来 */
export function temple(buf, x, y, s, o = {}) {
  const tone = o.tone ?? 0.85, R = rng((o.seed ?? 1) * 53 + 1);
  const ry = y - s * 0.5;                 // 檐口
  const rt = ry - s * 0.34;               // 正脊
  if (o.knock) o.knock([[x - s * 0.8, ry - s * 0.02], [x - s * 0.42, rt - 4], [x + s * 0.42, rt - 4], [x + s * 0.8, ry - s * 0.02], [x + s * 0.7, y + 2], [x - s * 0.7, y + 2]]);
  if (!buf) return;
  // 台基：夯土，横向刷痕
  wash(buf, [[x - s * 0.64, y - s * 0.17], [x + s * 0.64, y - s * 0.17], [x + s * 0.69, y], [x - s * 0.69, y]], { tone: tone * 0.3, rim: 0.45, jag: 1.2, jagScale: 10, gran: 0.6, streak: 0.45, streakAng: 0.02, seed: (o.seed ?? 1) * 3 });
  stroke(buf, [[x - s * 0.66, y - s * 0.17, 0.8], [x, y - s * 0.175, 1], [x + s * 0.66, y - s * 0.17, 0.8]], { w: 2.6, tone, dry: 0.25, dryEnd: 0.5, seed: (o.seed ?? 1) * 3 + 1 });
  // 台阶
  for (let i = 0; i < 4; i++) stroke(buf, [[x - s * 0.1 - i * 2, y - s * 0.04 * i, 1], [x + s * 0.1 + i * 2, y - s * 0.04 * i, 0.8]], { w: 1.6, tone: tone * 0.7, seed: (o.seed ?? 1) * 3 + 10 + i });
  // 屋身：深处（门内）一层墨，越往檐下越深
  wash(buf, [[x - s * 0.5, ry], [x + s * 0.5, ry], [x + s * 0.49, y - s * 0.18], [x - s * 0.49, y - s * 0.18]], { tone: tone * 0.42, soft: 2, rim: 0.3, jag: 0.8, gran: 0.6, seed: (o.seed ?? 1) * 3 + 2, gfn: (wx, wy) => 1 - ss(ry, y - s * 0.18, wy) * 0.65 });
  // 柱：六根，门两旁的更清楚
  for (let i = 0; i < 6; i++) {
    const cx = x - s * 0.44 + i * s * 0.176;
    stroke(buf, [[cx, y - s * 0.18, 1], [cx + R.r(-0.5, 0.5), ry + 2, 0.9]], { w: Math.max(2.4, s * 0.026), tone: tone * 0.95, dry: 0.2, dryEnd: 0.4, seed: (o.seed ?? 1) * 3 + 20 + i });
  }
  // 大屋顶：坡面微凹，檐口两端略起
  const roof = [];
  for (let k = 0; k <= 12; k++) { const u = k / 12; roof.push([lerp(x - s * 0.78, x - s * 0.4, u), lerp(ry - s * 0.045, rt, Math.pow(u, 1.6))]); }
  for (let k = 0; k <= 12; k++) { const u = k / 12; roof.push([lerp(x + s * 0.4, x + s * 0.78, u), lerp(rt, ry - s * 0.045, 1 - Math.pow(1 - u, 1.6))]); }
  roof.push([x + s * 0.62, ry + s * 0.02], [x - s * 0.62, ry + s * 0.02]);
  wash(buf, roof, { tone: tone * 0.62, rim: 0.5, rimW: 2.4, jag: 1, jagScale: 10, bleed: 2, gran: 0.55, bloom: 0.3, streak: 0.35, streakAng: 1.57, seed: (o.seed ?? 1) * 3 + 3, gfn: (wx, wy) => 0.7 + 0.3 * ss(rt, ry, wy) });
  // 檐口一笔（两端上挑）、正脊一笔焦墨、垂脊
  stroke(buf, [[x - s * 0.8, ry - s * 0.06, 0.5], [x - s * 0.62, ry + s * 0.005, 1], [x, ry + s * 0.02, 1], [x + s * 0.62, ry + s * 0.005, 1], [x + s * 0.8, ry - s * 0.06, 0.5]], { w: 3.4, tone: Math.min(0.96, tone * 1.1), dry: 0.15, dryEnd: 0.45, seed: (o.seed ?? 1) * 3 + 4 });
  stroke(buf, [[x - s * 0.44, rt + 1, 0.8], [x, rt - 1, 1], [x + s * 0.44, rt + 1, 0.8]], { w: 4.2, tone: 0.95, dry: 0.1, seed: (o.seed ?? 1) * 3 + 5 });
  for (const sd of [-1, 1]) stroke(buf, [[x + sd * s * 0.4, rt + 2, 1], [x + sd * s * 0.58, ry - s * 0.12, 0.8], [x + sd * s * 0.74, ry - s * 0.05, 0.4]], { w: 2.2, tone: tone * 0.95, dry: 0.2, seed: (o.seed ?? 1) * 3 + 6 + sd });
  // 瓦垄：稀疏几道，顺坡
  for (let i = 0; i < 11; i++) {
    const u = (i + 0.5) / 11, xx = lerp(x - s * 0.36, x + s * 0.36, u);
    stroke(buf, [[xx, rt + 4, 0.6], [lerp(xx, x + (xx - x) * 1.55, 1), ry - 2, 0.9]], { w: 1.2, tone: tone * 0.55, dry: 0.4, dryEnd: 0.7, seed: (o.seed ?? 1) * 3 + 30 + i });
  }
}
/** 鼎：三足两耳 */
export function ding(buf, x, y, s, o = {}) {
  if (!buf) return;
  const tone = o.tone ?? 0.85;
  wash(buf, [[x - s * 0.5, y - s * 0.75], [x + s * 0.5, y - s * 0.75], [x + s * 0.42, y - s * 0.35], [x, y - s * 0.22], [x - s * 0.42, y - s * 0.35]], { tone: tone * 0.8, rim: 0.4, jag: 0.6, seed: (o.seed ?? 1) * 3, gran: 0.4 });
  for (const lx of [-0.3, 0, 0.3]) stroke(buf, [[x + lx * s, y - s * 0.3, 1], [x + lx * s * 1.2, y, 0.8]], { w: s * 0.09, tone, seed: (o.seed ?? 1) * 3 + 5 + lx * 10 });
  for (const ex of [-1, 1]) stroke(buf, [[x + ex * s * 0.32, y - s * 0.75, 0.8], [x + ex * s * 0.34, y - s * 1.0, 1], [x + ex * s * 0.2, y - s * 1.0, 0.8], [x + ex * s * 0.18, y - s * 0.76, 0.6]], { w: s * 0.06, tone, seed: (o.seed ?? 1) * 3 + 9 + ex });
}
/** 亭：六角攒尖 */
export function pavilion(buf, x, y, s, o = {}) {
  if (o.knock) o.knock([[x - s * 0.62, y - s * 0.5], [x, y - s * 1.0], [x + s * 0.62, y - s * 0.5], [x + s * 0.4, y + 2], [x - s * 0.4, y + 2]]);
  if (!buf) return;
  const tone = o.tone ?? 0.75;
  for (const cx of [-0.32, -0.1, 0.12, 0.32]) stroke(buf, [[x + cx * s, y, 1], [x + cx * s, y - s * 0.55, 0.9]], { w: Math.max(1.6, s * 0.025), tone: tone * (Math.abs(cx) < 0.2 ? 0.55 : 0.9), dry: 0.2, seed: (o.seed ?? 1) * 10 + cx * 10 });
  wash(buf, [[x - s * 0.55, y - s * 0.52], [x, y - s * 0.95], [x + s * 0.55, y - s * 0.52], [x + s * 0.3, y - s * 0.56], [x - s * 0.3, y - s * 0.56]], { tone: tone * 0.7, rim: 0.4, jag: 1, seed: (o.seed ?? 1) * 3, streak: 0.3 });
  stroke(buf, [[x - s * 0.6, y - s * 0.5, 0.5], [x - s * 0.3, y - s * 0.57, 1], [x + s * 0.3, y - s * 0.57, 1], [x + s * 0.6, y - s * 0.5, 0.5]], { w: 2.4, tone, seed: (o.seed ?? 1) * 3 + 1 });
  stroke(buf, [[x - s * 0.34, y - s * 0.2, 1], [x + s * 0.34, y - s * 0.2, 1]], { w: 1.4, tone: tone * 0.6, seed: (o.seed ?? 1) * 3 + 2 });
  dot(buf, x, y - s * 0.97, 2.2, { tone, seed: (o.seed ?? 1) * 3 + 3 });
}
/** 民居：一两间小屋 */
export function house(buf, x, y, s, o = {}) {
  const tone = o.tone ?? 0.7, R = rng((o.seed ?? 1) * 59 + 2);
  const w = s * R.r(0.9, 1.3);
  if (o.knock) o.knock([[x - w * 0.68, y - s * 0.38], [x - w * 0.36, y - s * 0.75], [x + w * 0.36, y - s * 0.75], [x + w * 0.68, y - s * 0.38], [x + w * 0.5, y + 2], [x - w * 0.5, y + 2]]);
  if (!buf) return;
  wash(buf, [[x - w * 0.5, y - s * 0.42], [x + w * 0.5, y - s * 0.42], [x + w * 0.48, y], [x - w * 0.48, y]], { tone: tone * 0.12, soft: 3, rim: 0.3, seed: (o.seed ?? 1) * 3 });
  stroke(buf, [[x - w * 0.46, y - s * 0.4, 1], [x - w * 0.46, y, 0.8]], { w: 1.6, tone, seed: (o.seed ?? 1) * 3 + 1 });
  stroke(buf, [[x + w * 0.46, y - s * 0.4, 1], [x + w * 0.46, y, 0.8]], { w: 1.4, tone: tone * 0.8, seed: (o.seed ?? 1) * 3 + 2 });
  wash(buf, [[x - w * 0.62, y - s * 0.4], [x - w * 0.35, y - s * 0.72], [x + w * 0.35, y - s * 0.72], [x + w * 0.62, y - s * 0.4]], { tone: tone * 0.55, rim: 0.4, jag: 1, streak: 0.4, streakAng: 1.57, seed: (o.seed ?? 1) * 3 + 3 });
  stroke(buf, [[x - w * 0.66, y - s * 0.39, 0.6], [x, y - s * 0.42, 1], [x + w * 0.66, y - s * 0.39, 0.6]], { w: 2, tone, seed: (o.seed ?? 1) * 3 + 4 });
  wash(buf, [[x - w * 0.08, y - s * 0.26], [x + w * 0.1, y - s * 0.26], [x + w * 0.1, y], [x - w * 0.08, y]], { tone: tone * 0.7, rim: 0.2, jag: 0.6, seed: (o.seed ?? 1) * 3 + 5 });
}

// ---------------------------------------------------------------------------
// 近代
/** 铁桥：上下弦 + 斜腹杆 + 桥墩（毛笔画，线都略抖，不是直线）；o.tw 时从右往左一节一节「砍」出来 */
export function trussBridge(buf, x0, x1, deckY, s, o = {}) {
  if (!buf) return;
  const tone = o.tone ?? 0.9, R = rng((o.seed ?? 1) * 61 + 3), T = o.tw;
  const topY = deckY - s;
  const wob = (x, k) => (vn1(x * 0.01 + k) - 0.5) * 2.4;
  const tx = (x) => 1 - (x - x0) / (x1 - x0);   // 右边先画
  const chord = (yy, k, w, a0, a1) => {
    const pts = [];
    for (let x = x1; x >= x0; x -= 40) pts.push([x, yy + wob(x, k), 0.85 + 0.15 * Math.sin(x * 0.02 + k)]);
    stroke(buf, pts, { w, tone, dry: 0.3, dryEnd: 0.5, head: 0.03, tail: 0.03, rough: 0.08, fray: 0.6, seed: (o.seed ?? 1) * 7 + k, ...twin(T, a0, a1) });
  };
  chord(deckY, 1, 5, 0, 0.55); chord(topY, 2, 3.8, 0.1, 0.65);
  const n = Math.round((x1 - x0) / (s * 0.9));
  for (let i = 0; i <= n; i++) {
    const xa = lerp(x0, x1, i / n);
    const k = tx(xa);
    stroke(buf, [[xa, topY + wob(xa, 2), 1], [xa + R.r(-0.8, 0.8), deckY + wob(xa, 1), 1]], { w: 2.4, tone: tone * 0.9, dry: 0.3, head: 0.05, tail: 0.05, seed: (o.seed ?? 1) * 100 + i, ...twin(T, 0.15 + 0.6 * k, 0.25 + 0.6 * k) });
    if (i < n) {
      const xb = lerp(x0, x1, (i + 1) / n);
      stroke(buf, [[xa, topY + 2, 1], [xb, deckY - 2, 1]], { w: 1.8, tone: tone * 0.75, dry: 0.35, head: 0.05, tail: 0.05, seed: (o.seed ?? 1) * 200 + i, ...twin(T, 0.25 + 0.6 * k, 0.33 + 0.6 * k) });
      stroke(buf, [[xb, topY + 2, 1], [xa, deckY - 2, 1]], { w: 1.8, tone: tone * 0.75, dry: 0.35, head: 0.05, tail: 0.05, seed: (o.seed ?? 1) * 300 + i, ...twin(T, 0.28 + 0.6 * k, 0.36 + 0.6 * k) });
    }
  }
  // 桥墩：落进水里，下半截被水吃淡
  const np = o.piers ?? 3;
  const ph = o.pierH ?? 90;
  for (let i = 0; i < np; i++) {
    const px = lerp(x0 + 30, x1 - 30, np === 1 ? 0.5 : i / (np - 1));
    const k = tx(px);
    wash(buf, [[px - 12, deckY + 3], [px + 12, deckY + 3], [px + 15, deckY + ph], [px - 15, deckY + ph]], { tone: tone * 0.6, rim: 0.45, jag: 1, seed: (o.seed ?? 1) * 400 + i, gran: 0.55,
      gfn: (wx, wy) => 1 - ss(deckY + 20, deckY + ph, wy) * 0.85, ...twin(T, 0.2 + 0.6 * k, 0.35 + 0.6 * k), ...(T ? { tfn: (wx, wy) => (wy - deckY) / ph } : {}) });
  }
}
/** 轮船：黑船身、两层舱（舷窗留白）、一根粗烟囱、两根桅（烟另画）。x,y = 船头水线处，dir 船头方向 */
export function steamship(buf, x, y, len, o = {}) {
  if (!buf) return;
  const d = o.dir ?? 1, tone = o.tone ?? 0.95, T = o.tw, sd = (o.seed ?? 1) * 3;
  const h = hull(buf, x, y, len, { dir: d, tone, h: len * 0.11, rise: len * 0.03, w: 4, fill: 0.85, seed: sd, tw: T ? twin(T, 0, 0.45) : undefined });
  const cx = x - d * len * 0.52;
  const deck1 = [[cx - len * 0.26, y - len * 0.03], [cx + len * 0.24, y - len * 0.03], [cx + len * 0.22, y - len * 0.1], [cx - len * 0.25, y - len * 0.1]];
  wash(buf, deck1, { tone: tone * 0.72, rim: 0.4, jag: 0.6, jagScale: 8, gran: 0.5, streak: 0.2, streakAng: 0, seed: sd + 7, ...twin(T, 0.35, 0.6) });
  const deck2 = [[cx - len * 0.15, y - len * 0.1], [cx + len * 0.1, y - len * 0.1], [cx + len * 0.09, y - len * 0.155], [cx - len * 0.14, y - len * 0.155]];
  wash(buf, deck2, { tone: tone * 0.62, rim: 0.4, jag: 0.6, jagScale: 8, gran: 0.5, seed: sd + 8, ...twin(T, 0.45, 0.65) });
  stroke(buf, [[cx - len * 0.28, y - len * 0.1, 1], [cx + len * 0.25, y - len * 0.1, 1]], { w: 3.2, tone, dry: 0.3, head: 0.02, tail: 0.05, seed: sd + 11, ...twin(T, 0.5, 0.65) });
  stroke(buf, [[cx - len * 0.16, y - len * 0.155, 1], [cx + len * 0.11, y - len * 0.155, 1]], { w: 2.8, tone, dry: 0.3, head: 0.02, tail: 0.05, seed: sd + 12, ...twin(T, 0.55, 0.7) });
  // 舷窗：一排小窗留白
  for (let i = 0; i < 9; i++) {
    const wx = cx - len * 0.215 + i * len * 0.052, wy = y - len * 0.068;
    erase(buf, [[wx - 2.6, wy - 3.4], [wx + 2.6, wy - 3.4], [wx + 2.6, wy + 3.4], [wx - 2.6, wy + 3.4]], { soft: 0.8, k: 0.78, jag: 0.3, seed: sd + 20 + i });
  }
  // 烟囱：一笔焦墨侧锋，口上一道箍
  const fx = cx + d * len * 0.02, ftop = y - len * 0.37;
  stroke(buf, [[fx, y - len * 0.14, 1], [fx + d * 2, y - len * 0.26, 0.96], [fx + d * 3, ftop, 0.92]], { w: len * 0.062, tone, dry: 0.2, dryEnd: 0.4, head: 0.02, tail: 0.03, tailMode: 'press', shade: 0.3, rough: 0.12, fray: 0.8, seed: sd + 9, ...twin(T, 0.6, 0.85) });
  stroke(buf, [[fx + d * 3 - len * 0.042, ftop + 3, 1], [fx + d * 3 + len * 0.042, ftop + 3, 1]], { w: 3.6, tone, dry: 0.2, head: 0.03, tail: 0.08, seed: sd + 13, ...twin(T, 0.85, 0.9) });
  // 桅
  stroke(buf, [[x - d * len * 0.17, y - len * 0.04, 1], [x - d * len * 0.18, y - len * 0.34, 0.5]], { w: 2.2, tone, seed: sd + 10, ...twin(T, 0.8, 0.95) });
  stroke(buf, [[x - d * len * 0.87, y - len * 0.04, 1], [x - d * len * 0.87, y - len * 0.25, 0.5]], { w: 1.9, tone, seed: sd + 14, ...twin(T, 0.85, 1) });
  // 船尾的浪：几道横的干笔
  for (let k = 0; k < 3; k++) stroke(buf, [[x - d * len * (1.02 + k * 0.07), y + len * 0.02 + k * 5, 0.3], [x - d * len * (1.2 + k * 0.12), y + len * 0.03 + k * 6, 1], [x - d * len * (1.4 + k * 0.16), y + len * 0.02 + k * 6, 0.2]], { w: 2.4 - k * 0.5, tone: tone * 0.5, dry: 0.5, dryEnd: 0.8, seed: sd + 30 + k, ...twin(T, 0.7 + k * 0.08, 0.9 + k * 0.03) });
  return { funnel: [fx + d * 3, ftop], hull: h };
}
/** 烟囱：一笔焦墨侧锋自下而上「砍」出来（下粗上略细，笔毛擦出飞白），口上一道箍。返回烟囱口 */
export function chimney(buf, x, y, h, o = {}) {
  const lean = o.lean ?? 0, top = [x + lean * h, y - h];
  if (!buf) return top;
  const tone = o.tone ?? 0.95, w = o.w ?? h * 0.075, T = o.tw, sd = (o.seed ?? 1) * 5;
  stroke(buf, [[x, y + 2, 1], [x + lean * h * 0.35 + 0.8, y - h * 0.35, 0.94], [x + lean * h * 0.7 - 0.6, y - h * 0.7, 0.86], [top[0], top[1], 0.8]],
    { w, tone, dry: 0.16, dryEnd: 0.4, head: 0.02, headMin: 0.95, tail: 0.02, tailMode: 'press', shade: 0.35, rough: 0.14, fray: 0.9, halo: 1.2, haloK: 0.3, load: 0.05, fade: 0.05, seed: sd, ...twin(T, 0, 0.8) });
  stroke(buf, [[top[0] - w * 0.62, top[1] + 3, 1], [top[0] + w * 0.62, top[1] + 2, 1]], { w: Math.max(3, w * 0.3), tone, dry: 0.2, head: 0.05, tail: 0.1, seed: sd + 1, ...twin(T, 0.8, 1) });
  return top;
}
/** 厂房：一排锯齿顶的厂房——墙面一层重墨，焦墨一笔一个齿，窗留白。x0..x1，y 墙脚，h 齿尖高 */
export function sheds(buf, x0, x1, y, h, o = {}) {
  if (!buf) return;
  const T = o.tw, tone = o.tone ?? 0.82, sd = (o.seed ?? 1) * 7;
  const n = o.teeth ?? Math.max(2, Math.round((x1 - x0) / (h * 0.95)));
  const tw2 = (x1 - x0) / n, eave = y - h * 0.6;
  const poly = [[x1, y], [x0, y], [x0, eave]];
  for (let i = 0; i < n; i++) { const xa = x0 + i * tw2; poly.push([xa + tw2 * 0.2, y - h], [xa + tw2, eave]); }
  wash(buf, poly, { tone: tone * 0.7, rim: 0.4, rimW: 2, jag: 0.8, jagScale: 10, bleed: 1.5, gran: 0.55, bloom: 0.3, streak: 0.25, streakAng: Math.PI / 2, seed: sd + 2,
    ...twin(T, 0.2, 0.85), ...(T ? { tfn: (wx) => (x1 - wx) / (x1 - x0) } : {}) });
  for (let i = n - 1; i >= 0; i--) {
    const xa = x0 + i * tw2, k = (n - 1 - i) / n;
    stroke(buf, [[xa, eave, 1], [xa + tw2 * 0.2, y - h, 1], [xa + tw2, eave, 0.85]], { w: 3.4, tone: Math.min(0.97, tone * 1.15), dry: 0.3, dryEnd: 0.5, head: 0.02, tail: 0.1, seed: sd + 10 + i, ...twin(T, k * 0.75, k * 0.75 + 0.25) });
  }
  // 窗：一排小窗留白
  const nw = Math.floor((x1 - x0) / 26);
  for (let i = 0; i < nw; i++) {
    const wx = x0 + 14 + i * 26, wy = y - h * 0.3;
    erase(buf, [[wx - 4, wy - 7], [wx + 4, wy - 7], [wx + 4, wy + 7], [wx - 4, wy + 7]], { soft: 0.8, k: 0.72, jag: 0.4, seed: sd + 40 + i });
  }
}
/**
 * 黑烟（泼墨）：从烟口翻滚着冒出，被风压弯往 wind 一侧拖开；近处浓、远处淡而散，边缘顺纸纹洇开，里面带几道干笔絮。
 * x,y = 烟口；len = 拖出去的长度；o.rise 上升占比 · w0/w1 起止半宽 · tone · wind(-1 往左) · tw 时间窗（沿烟的方向生长）
 */
export function smoke(buf, x, y, len, o = {}) {
  if (!buf) return;
  const R = rng((o.seed ?? 1) * 71 + 5), T = o.tw, wind = o.wind ?? -1, tone = o.tone ?? 0.8, sd = (o.seed ?? 1) * 100;
  const rise = o.rise ?? 0.3, w0 = o.w0 ?? 10, w1 = o.w1 ?? 100;
  const ph = R.f() * 100;
  const cl = (u) => [x + wind * len * Math.pow(u, 1.25), y - len * rise * (1 - Math.pow(1 - u, 2)) + (vn1(u * 4 + ph) - 0.5) * len * 0.05];
  const hw = (u) => (w0 + (w1 - w0) * Math.pow(u, 0.6)) * (0.75 + 0.5 * vn1(u * 7 + ph * 2));
  const N = 40, CU = [];
  for (let k = 0; k <= N; k++) { const u = k / N; CU.push([...cl(u), hw(u), u]); }
  // 像素 → 沿烟的参数 u 与横向偏移（取最近的中心线采样点）
  const near = (wx, wy) => {
    let best = 1e18, bi = 0;
    for (let k = 0; k <= N; k++) { const dx = wx - CU[k][0], dy = wy - CU[k][1], d = dx * dx + dy * dy; if (d < best) { best = d; bi = k; } }
    return [CU[bi][3], Math.sqrt(best) / Math.max(4, CU[bi][2])];
  };
  // 生长：沿烟往外，前沿是圆的、不齐的（不是一刀切）
  const grow = (wx, wy) => { const [u, q] = near(wx, wy); const v = u * 0.88 + 0.1 * q * q + 0.08 * (vn1(wx * 0.013 + wy * 0.021 + ph) - 0.5); return v < 0 ? 0 : v > 1 ? 1 : v; };
  const tm = (a, b) => (T ? { ...twin(T, a, b), tfn: grow } : {});
  const fade = (k) => (wx, wy) => 1 - k * near(wx, wy)[0];
  // 1. 外层：大片淡湿墨
  wash(buf, tubePoly(CU.map(([a, b, r]) => [a, b, r]), 4), { tone: tone * 0.3, soft: 22, rim: 0.3, rimW: 6, jag: 8, jagScale: 40, bleed: 8, bleedK: 0.5, gran: 0.6, bloom: 0.65, bloomScale: 50, streak: 0.1, streakAng: 0,
    seed: sd + 1, gfn: fade(0.75), ...tm(0.02, 1) });
  // 2. 内核：窄、浓，偏上，拖得短一些
  wash(buf, tubePoly(CU.filter((c) => c[3] <= 0.7).map(([a, b, r]) => [a, b - r * 0.12, r * 0.5]), 4), { tone: tone * 0.4, soft: 12, rim: 0.45, rimW: 4, jag: 6, jagScale: 24, bleed: 5, bleedK: 0.5, gran: 0.6, bloom: 0.6, bloomScale: 28, streak: 0.12, streakAng: 0,
    seed: sd + 2, gfn: fade(1.1), ...tm(0, 0.75) });
  // 3. 烟口几团翻滚的浓墨（一团叠一团往上冒）
  for (let i = 0; i < 6; i++) {
    const u = 0.01 + i * 0.035, [cx, cy] = cl(u), r = w0 * 1.1 + hw(u) * 0.55;
    const poly = [];
    for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; const rr = r * (1 + 0.3 * Math.sin(a * 3 + i * 1.9) + 0.15 * Math.sin(a * 5 + i)); poly.push([cx + Math.cos(a) * rr * 1.2, cy + Math.sin(a) * rr * 0.9]); }
    wash(buf, poly, { tone: tone * (0.5 - i * 0.05), soft: r * 0.35, rim: 0.55, rimW: 3, jag: 3, jagScale: 12, bleed: 4, bleedK: 0.5, gran: 0.55, bloom: 0.5, bloomScale: 20, seed: sd + 10 + i,
      ...(T ? { ...twin(T, i * 0.03, 0.1 + i * 0.05), tfn: (wx, wy) => ss(0, r * 1.4, Math.hypot(wx - cx, wy - cy)) } : {}) });
  }
  // 4. 几道干笔絮，顺着烟走
  for (let j = 0; j < 3; j++) {
    const u0 = 0.05 + j * 0.05, u1 = 0.45 + j * 0.12, off = (j - 1) * 0.4;
    const pts = [];
    for (let k = 0; k <= 10; k++) { const u = lerp(u0, u1, k / 10), [cx, cy] = cl(u); pts.push([cx, cy + off * hw(u), 0.9 - 0.6 * (k / 10)]); }
    stroke(buf, pts, { w: 7 + j * 3, tone: tone * 0.45, dry: 0.75, dryEnd: 0.92, head: 0.1, tail: 0.5, rough: 0.2, fray: 1.2, halo: 2, haloK: 0.3, seed: sd + 20 + j, ...(T ? twin(T, u0 * 0.9, u1 * 0.95) : {}) });
  }
}
export { figure };
