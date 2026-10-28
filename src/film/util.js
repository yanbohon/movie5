// 通用数学与时间工具：全片所有动画都是时间 t 的纯函数，这里的一切都必须是确定性的

export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, x) => clamp((x - a) / (b - a));
export const remap = (x, a, b, c, d) => lerp(c, d, invLerp(a, b, x));
export const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
export const smoother = (t) => { t = clamp(t); return t * t * t * (t * (t * 6 - 15) + 10); };
export const sstep = (a, b, x) => smooth((x - a) / (b - a));
export const easeInCubic = (t) => { t = clamp(t); return t * t * t; };
export const easeOutCubic = (t) => { t = clamp(t); return 1 - Math.pow(1 - t, 3); };
export const easeInOutCubic = (t) => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
export const easeOutExpo = (t) => { t = clamp(t); return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); };
export const easeInExpo = (t) => { t = clamp(t); return t === 0 ? 0 : Math.pow(2, 10 * t - 10); };
export const easeInOutExpo = (t) => {
  t = clamp(t);
  if (t === 0 || t === 1) return t;
  return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
};
export const easeOutBack = (t, s = 1.70158) => { t = clamp(t) - 1; return t * t * ((s + 1) * t + s) + 1; };
export const easeOutElastic = (t) => {
  t = clamp(t);
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
};
/** 窗口：a→b 渐入，c→d 渐出（全部平滑），用于淡入淡出 */
export const win = (x, a, b, c, d) => sstep(a, b, x) * (1 - sstep(c, d, x));
export const fract = (x) => x - Math.floor(x);
export const TAU = Math.PI * 2;

// ---- 确定性随机 ----
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 无状态哈希随机：同样的输入永远得到同样的 [0,1) */
export function hash1(n) {
  let x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}
export function hash2(a, b) {
  let x = Math.sin(a * 127.1 + b * 311.7 + 74.7) * 43758.5453123;
  return x - Math.floor(x);
}
export function hash3(a, b, c) {
  let x = Math.sin(a * 127.1 + b * 311.7 + c * 74.7 + 12.9) * 43758.5453123;
  return x - Math.floor(x);
}

// ---- 2D/3D 值噪声（确定性，足够做抖动、手绘感） ----
function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
export function noise1(x) {
  const i = Math.floor(x), f = x - i;
  return lerp(hash1(i), hash1(i + 1), fade(f)) * 2 - 1;
}
export function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fade(fx), v = fade(fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1;
}
export function fbm2(x, y, oct = 4) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * noise2(x * f, y * f); f *= 2.03; a *= 0.5; }
  return s;
}

/** 手绘「抖线」用的离散时间：每秒 fps 帧换一次抖动（传统动画一拍二） */
export const boilStep = (t, fps = 12) => Math.floor(t * fps);

// ---- 节拍网格 ----
export const beatTime = (start, bpm, k) => start + (k * 60) / bpm;
export const beatPhase = (t, start, bpm) => ((t - start) * bpm) / 60;

/** 打字机：返回在时间 t 时应显示的字符数 */
export const typed = (t, t0, cps, n) => Math.max(0, Math.min(n, Math.floor((t - t0) * cps)));

/** 冲击脉冲：t0 时刻瞬间到 1，然后指数衰减 */
export const pulse = (t, t0, decay = 6) => (t < t0 ? 0 : Math.exp(-(t - t0) * decay));
