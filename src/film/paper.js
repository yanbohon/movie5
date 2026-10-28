// 宣纸与全片色板。所有 2D 场景共用同一种纸，保证长卷、2003、尾声的纸是一张纸。
// 纸在建场景时一次性生成（确定性），之后每帧只是贴图/合成。
import { mulberry32, fbm2, noise2 } from './util.js';

// ---- 全片色板（sRGB 0..255）----
export const PALETTE = {
  paper: [236, 227, 207],      // 宣纸底色，偏暖
  paperShade: [217, 205, 178], // 纸的阴影/旧色
  ink: [21, 19, 17],           // 浓墨
  cinnabar: [179, 55, 43],     // 朱砂：全片只用在陨石、二十四针红线、印章
  ochre: [201, 163, 107],      // 赭石：只用在 2003 棉被
  electro: [159, 227, 255],    // 电感视觉的冷白青（片名光字也用它）
  electroDeep: [58, 143, 181],
  amber: [255, 201, 138],      // 卵的光
  mud: [107, 90, 58],          // 长江浑水
  mudDeep: [26, 21, 13],
};
export const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/**
 * 生成一张宣纸（Canvas2D 画布）。
 * 返回 { canvas, fiber }：canvas 是彩色纸；fiber 是同尺寸灰度「吸墨度」图（亮 = 纤维多、吸墨快，墨在这里洇得更开），
 * 墨色模拟可以用它调制边缘。
 * @param {number} w 宽
 * @param {number} h 高
 * @param {object} o seed、tone（底色）、mottle（大块深浅起伏 0..1）、fibers（纤维密度倍数）、age（旧色 0..1）
 */
export function makePaperCanvas(w, h, { seed = 7, tone = PALETTE.paper, mottle = 1, fibers = 1, age = 0.25 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  const img = c.createImageData(w, h);
  const d = img.data;
  const fcv = document.createElement('canvas');
  fcv.width = w; fcv.height = h;
  const fc = fcv.getContext('2d');
  const fimg = fc.createImageData(w, h);
  const fd = fimg.data;
  const ox = seed * 131.7, oy = seed * 71.3;
  const sh = PALETTE.paperShade;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // 大块的深浅（纸浆不匀）+ 旧色斑
      const m1 = fbm2(x / 380 + ox, y / 380 + oy, 4);
      const m2 = fbm2(x / 90 + oy, y / 90 + ox, 3);
      const m3 = noise2(x / 14 + ox * 3, y / 14 - oy);
      const k = 0.5 + 0.5 * m1;
      const ageK = age * Math.max(0, fbm2(x / 520 - ox, y / 520 + oy, 3) * 1.4 - 0.1);
      let r = tone[0] + (m1 * 7 + m2 * 3.2 + m3 * 1.6) * mottle;
      let g = tone[1] + (m1 * 7 + m2 * 3.2 + m3 * 1.6) * mottle;
      let b = tone[2] + (m1 * 8.5 + m2 * 3.4 + m3 * 1.4) * mottle;
      r = r + (sh[0] - r) * ageK; g = g + (sh[1] - g) * ageK; b = b + (sh[2] - b) * ageK;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      const fib = 0.5 + 0.35 * m2 + 0.15 * m3 + 0.1 * (k - 0.5);
      const v = Math.max(0, Math.min(255, fib * 255));
      fd[i] = fd[i + 1] = fd[i + 2] = v; fd[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  fc.putImageData(fimg, 0, 0);
  // 纤维：细长弯曲的丝，亮的多、暗的少（宣纸的檀皮纤维）
  const rnd = mulberry32(seed * 977 + 13);
  const n = Math.round((w * h) / 700 * fibers);
  for (let k = 0; k < n; k++) {
    const x = rnd() * w, y = rnd() * h;
    const len = 12 + Math.pow(rnd(), 2.2) * 150;
    const ang = rnd() * Math.PI * 2;
    const bend = (rnd() - 0.5) * 1.6;
    const light = rnd() < 0.72;
    const a = light ? 0.05 + rnd() * 0.09 : 0.03 + rnd() * 0.06;
    const col = light ? `rgba(250,246,236,${a})` : `rgba(150,132,100,${a})`;
    const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
    const mx = (x + x2) / 2 + Math.cos(ang + Math.PI / 2) * len * bend * 0.3;
    const my = (y + y2) / 2 + Math.sin(ang + Math.PI / 2) * len * bend * 0.3;
    c.strokeStyle = col;
    c.lineWidth = 0.35 + rnd() * 1.1;
    c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(mx, my, x2, y2); c.stroke();
    fc.strokeStyle = `rgba(255,255,255,${0.1 + a})`;
    fc.lineWidth = c.lineWidth + 0.6;
    fc.beginPath(); fc.moveTo(x, y); fc.quadraticCurveTo(mx, my, x2, y2); fc.stroke();
  }
  // 零星的杂质小点
  const m = Math.round((w * h) / 26000);
  for (let k = 0; k < m; k++) {
    const x = rnd() * w, y = rnd() * h, r = 0.4 + rnd() * 1.3;
    c.fillStyle = `rgba(90,78,60,${0.08 + rnd() * 0.18})`;
    c.beginPath(); c.ellipse(x, y, r * (1 + rnd()), r, rnd() * 3, 0, Math.PI * 2); c.fill();
  }
  return { canvas: cv, fiber: fcv };
}

/**
 * 纸作为 three 纹理层（ctx.layer 包装），画在 p5.Graphics 里：{ g, ctx, tex, fiber }。
 * 场景里可以直接 g.image(...) 往上叠墨，然后 tex.needsUpdate = true。
 */
export function makePaperLayer(ctx, w, h, opts = {}) {
  const L = ctx.layer(w, h, { srgb: true, premult: false });
  const { canvas, fiber } = makePaperCanvas(w, h, opts);
  L.ctx.drawImage(canvas, 0, 0);
  L.paper = canvas;
  L.fiber = fiber;
  L.tex.needsUpdate = true;
  return L;
}
