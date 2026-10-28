// S2 现场生长的元素：建场景时画进带「到达时间」的墨量缓冲，着色器按时间揭示
// 每个精灵：{ name, x0, y0, w, h, mode, tA, tB, show:[ts, te], data(Uint8 RGBA), ... }
//   mode 1 墨（R=到达时间归一化，G=墨量） · 2 朱砂（同上） · 4 化灰（R=延迟，G=墨量）
import { InkBuf, stroke, wash, dot, rng, vn1, fbn, packChannel, textMask, stampMask, figure, paddlefish } from '../../film/ink.js';
import { Y_BANK, X_DAM, modernLayout, weiNoteCols } from './plan.js';
import * as M from './motifs.js';
import * as LD from './land.js';
import * as FA from './fauna.js';
import { zhouLayout } from './paint.js';

const lerp = (a, b, t) => a + (b - a) * t;
const ss = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

function timed(x0, y0, w, h) { return new InkBuf(Math.ceil(w), Math.ceil(h), { x0: Math.floor(x0), y0: Math.floor(y0), time: true }); }
function packTimed(B, tA, tB) {
  const data = new Uint8Array(B.w * B.h * 4);
  packChannel(B, data, B.w, B.h, 0, 0, 0, 't', tA, tB);
  packChannel(B, data, B.w, B.h, 1, 0, 0, 'd');
  return data;
}
function spr(name, B, mode, tA, tB, show, extra = {}) {
  return { name, x0: B.x0, y0: B.y0, w: B.w, h: B.h, mode, tA, tB, show, data: packTimed(B, tA, tB), ...extra };
}

/** 恐龙的位置（events.js / 场景共用） */
export function dinoLayout(P) {
  return {
    big: { x: 15260, s: 136 }, young: { x: 14540, s: 58 }, stand: { x: 14800, s: 100 },
    ptero: [[15440, 236, 118, 0.35, 0.85], [15130, 170, 80, 0.1, 0.62], [14690, 262, 60, 0.55, 0.5]],
  };
}
/** 陨石的几何 */
export function asteroidGeom(P) {
  const ix = P.X.impact, iy = Y_BANK - 26;
  return { ix, iy, sx: ix + 840, sy: 34 };
}

export function buildLive(P, fonts) {
  const X = P.X, L = P.live, T = P.T;
  const out = [];
  const tlog = (n, t) => console.log(`[dbg] live ${n} ${Math.round(performance.now() - t)} ms`);
  let t0;

  // ---- 恐龙（化灰）：蜥脚类饮水、翼龙掠过 ----
  t0 = performance.now();
  {
    const D = dinoLayout(P);
    const x0 = 14420, x1 = 15770, y0 = 110, y1 = Y_BANK + 60;
    const B = new InkBuf(x1 - x0, y1 - y0, { x0, y0 });
    FA.sauropod(B, D.stand.x, Y_BANK - 12, D.stand.s, { drink: false, dir: -1, seed: 4, tone: 0.5 });
    FA.sauropod(B, D.big.x, Y_BANK - 2, D.big.s, { drink: true, dir: -1, seed: 3, tone: 0.82 });
    FA.sauropod(B, D.young.x, Y_BANK - 4, D.young.s, { drink: true, dir: -1, seed: 5, tone: 0.62 });
    D.ptero.forEach(([px, py, s, f, tn], i) => FA.pterosaur(B, px, py, s, { dir: -1, seed: 6 + i, flap: f, tone: tn }));
    const data = new Uint8Array(B.w * B.h * 4);
    packChannel(B, data, B.w, B.h, 1, 0, 0, 'd');
    // 延迟：离落点越远，冲击到得越晚
    const { ix, iy } = asteroidGeom(P);
    for (let y = 0; y < B.h; y++) for (let x = 0; x < B.w; x++) {
      const d = Math.hypot(x + x0 - ix, y + y0 - iy);
      data[(y * B.w + x) * 4] = Math.round(Math.min(1, (d / 1200) + 0.08 * vn1((x + y) * 0.02)) * 255);
    }
    out.push({ name: 'dino', x0, y0, w: B.w, h: B.h, mode: 4, show: [T.start, T.L19.t], data, dmax: 1.2, fade0: L.dinoFade0, fadeDur: L.dinoFadeDur });
  }
  tlog('dino', t0);

  // ---- 陨石：朱砂一笔（起笔轻、干，越往下越重，落地一按）+ 落点红晕 + 把天烧红 ----
  t0 = performance.now();
  {
    const { ix, iy, sx, sy } = asteroidGeom(P);
    const B = timed(ix - 1700, 20, 2950, iy + 150 - 20);
    const pts = [];
    for (let k = 0; k <= 12; k++) {
      const u = k / 12;
      pts.push([lerp(sx, ix + 4, u) + Math.sin(u * 3.1) * 16, lerp(sy, iy - 6, Math.pow(u, 1.06)), 0.25 + 0.75 * Math.pow(u, 1.25)]);
    }
    stroke(B, pts, { w: 46, tone: 0.95, dry: 0.62, dryEnd: 0.04, head: 0.25, headMin: 0.2, tail: 0.1, tailMode: 'press', rough: 0.22, fray: 1.6, halo: 3.5, haloK: 0.5, fade: -0.25, load: 0,
      seed: 11, t0: L.astStreak0, t1: L.astImpact, tEase: 0.72 });
    // 分叉的笔毛：两三道细干笔擦在主笔旁
    for (let j = 0; j < 3; j++) {
      const off = (j - 1) * 20 + 6;
      const q = pts.slice(0, 9).map(([px, py, p], k) => [px + off * 0.5 + Math.sin(k + j) * 2, py - off * 0.45, p * 0.5]);
      stroke(B, q, { w: 8, tone: 0.8, dry: 0.7, dryEnd: 0.8, head: 0.3, tail: 0.5, seed: 12 + j, t0: L.astStreak0 + 0.02, t1: L.astStreak0 + 0.02 + (L.astImpact - L.astStreak0) * 0.72, tEase: 0.72 });
    }
    // 落点：一团湿的朱砂，往外一圈圈洇开
    const R = rng(12);
    for (let i = 0; i < 4; i++) {
      const r = 34 + i * 30;
      const poly = [];
      for (let k = 0; k < 30; k++) { const a = (k / 30) * Math.PI * 2; const rr = r * (1 + 0.28 * Math.sin(a * 3 + i * 1.7) + 0.16 * Math.sin(a * 7 + i) + 0.1 * (R.f() - 0.5)); poly.push([ix + Math.cos(a) * rr * 1.3, iy + Math.sin(a) * rr * 0.6]); }
      wash(B, poly, { tone: 0.7 - i * 0.13, soft: 10 + i * 6, rim: 0.6, rimW: 3, jag: 3, jagScale: 14, bleed: 5, bleedK: 0.55, gran: 0.5, bloom: 0.45, bloomScale: 30, seed: 20 + i,
        t0: L.astImpact + i * 0.2, t1: L.astImpact + 0.5 + i * 0.45, tfn: (wx, wy) => Math.min(1, Math.hypot((wx - ix) / 1.3, (wy - iy) / 0.6) / (r * 1.2)) });
    }
    // 把天烧红：一大片淡朱砂从落点往天上、往两边漫开——不是一团团圆，而是一层湿染：
    // 浓淡由扭曲过的距离场决定，贴着地平线最红、往上渐淡，边上有几道水渍线（颜料在湿纸上推开留下的边）
    {
      const RX = 1150, RY = 470;
      const glow = (wx, wy) => {
        const dx = (wx - ix) / RX, dy = (wy - iy) / RY;
        const warp = 0.72 + 0.56 * fbn(wx * 0.0032 + 7.1, wy * 0.0055 + 3.3, 3);
        const d = Math.hypot(dx * 1.05, dy) * warp;
        const base = Math.pow(1 - ss(0.05, 0.85, d), 1.4) * (0.55 + 0.45 * ss(iy - 520, iy - 40, wy)) * (1 - 0.85 * ss(iy - 12, iy + 50, wy));
        const tide = Math.exp(-Math.pow((base - 0.2) / 0.035, 2)) * 0.5 + Math.exp(-Math.pow((base - 0.42) / 0.03, 2)) * 0.3;
        return Math.min(1, base * 0.85 + tide * 0.3);
      };
      wash(B, [[ix - RX * 1.45, 20], [ix + RX * 1.05, 20], [ix + RX * 1.05, iy + 60], [ix - RX * 1.45, iy + 60]], { tone: 0.46, soft: 0, rim: 0, jag: 0, bleed: 0, gran: 0.6, bloom: 0.45, bloomScale: 70, seed: 30,
        gfn: glow, t0: L.astImpact + 0.15, t1: L.astImpact + 2.6, tfn: (wx, wy) => Math.min(1, Math.hypot((wx - ix) / RX, (wy - iy) / RY) * 1.1) });
    }
    // 溅点
    for (let i = 0; i < 22; i++) {
      const a = R.r(-Math.PI, 0.25), d = R.r(40, 200);
      dot(B, ix + Math.cos(a) * d * 1.3, iy + Math.sin(a) * d * 0.55, R.r(1.5, 5.5), { ax: R.r(1, 2.2), ang: a, tone: R.r(0.5, 0.92), seed: 40 + i, t0: L.astImpact + 0.04 + d / 900, t1: L.astImpact + 0.12 + d / 900 });
    }
    out.push(spr('asteroid', B, 2, L.astStreak0, L.astBloomEnd, [T.asteroid - 0.5, T.L19.t]));
  }
  // 灰：落点的焦土 + 升起的灰墨，往天上、往左漫
  {
    const { ix, iy } = asteroidGeom(P);
    const B = timed(ix - 800, 30, 1500, iy + 70 - 30);
    const R = rng(51);
    const scorch = [];
    for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; const rr = 1 + 0.25 * Math.sin(a * 3) + 0.15 * Math.sin(a * 7 + 1); scorch.push([ix + Math.cos(a) * 230 * rr, iy + 12 + Math.sin(a) * 26 * rr]); }
    wash(B, scorch, { tone: 0.42, soft: 12, rim: 0.5, jag: 3, jagScale: 16, bleed: 3, gran: 0.65, bloom: 0.5, bloomScale: 25, seed: 59,
      t0: L.astImpact + 0.1, t1: L.astImpact + 1.2, tfn: (wx, wy) => Math.min(1, Math.hypot(wx - ix, (wy - iy) * 4) / 260) });
    for (let i = 0; i < 10; i++) {
      const u = i / 9;
      const cx = ix - u * 480 + R.r(-80, 80), cy = iy - 60 - u * 300 - R.r(0, 60), r = lerp(70, 190, u) * R.r(0.8, 1.2);
      const poly = [];
      for (let k = 0; k < 20; k++) { const a = (k / 20) * Math.PI * 2; const rr = r * (1 + 0.3 * Math.sin(a * 3 + i) + 0.15 * Math.sin(a * 5 + i * 2)); poly.push([cx + Math.cos(a) * rr * 1.5, cy + Math.sin(a) * rr * 0.62]); }
      const dd = Math.hypot(cx - ix, cy - iy);
      wash(B, poly, { tone: R.r(0.1, 0.17) * (1 - 0.4 * u), soft: r * 0.18, rim: 0.55, rimW: 3, jag: 6, jagScale: 24, bleed: 4, gran: 0.65, bloom: 0.6, bloomScale: 40, streak: 0.12, streakAng: 0.25, seed: 60 + i,
        t0: L.astImpact + 0.3 + dd / 650, t1: L.astImpact + 1.6 + dd / 650, tfn: (wx, wy) => ss(0, r * 1.6, Math.hypot(wx - cx, wy - cy)) });
    }
    out.push(spr('ash', B, 1, L.astImpact, L.astImpact + 4.2, [T.asteroid - 0.5, T.L19.t]));
  }
  tlog('asteroid', t0);

  // ---- 山一重一重长高（积墨山，现场长）----
  t0 = performance.now();
  {
    const B = timed(12880, 60, 1640, Y_BANK + 30 - 60);
    const a = L.mount0, b = L.mount1, d = b - a;
    LD.layerMountain(B, 13860, 14470, Y_BANK - 8, 290, { tone: 0.58, layers: 3, seed: 501, ridgeTrees: 4, mist: 0.38, tw: { t0: a, t1: a + d * 0.5 } });
    LD.layerMountain(B, 12960, 13940, Y_BANK - 12, 440, { tone: 0.58, layers: 4, seed: 502, ridgeTrees: 6, peaks: 3, mist: 0.42, frontTone: 0.46, tw: { t0: a + d * 0.2, t1: b } });
    out.push(spr('mount', B, 1, a, b + 0.8, [T.asteroid, T.wei], { occ: 4 }));
  }
  tlog('mount', t0);

  // ---- 河改道：一道新沙洲从岸上长进江里，旧河道淡成一道干痕，水纹绕开 ----
  t0 = performance.now();
  {
    const cx = X.reroute, x0 = cx - 470, x1 = cx + 470;
    const B = timed(x0 - 20, 400, x1 - x0 + 40, 700 - 400);
    const a = L.reroute0, b = L.reroute1;
    // 旧河道：一抹干笔淡痕（像水退后留下的印子）
    const old = [];
    for (let k = 0; k <= 16; k++) { const u = k / 16; old.push([lerp(x1 - 60, x0 + 60, u), Y_BANK - 16 - Math.sin(u * Math.PI) * 28, 0.5 + 0.5 * Math.sin(u * Math.PI)]); }
    stroke(B, old, { w: 16, tone: 0.16, dry: 0.7, dryEnd: 0.85, halo: 2, seed: 601, t0: a - 0.6, t1: a + 0.5 });
    // 新岸：往江里凸出的一弯沙洲
    const bank = [];
    for (let k = 0; k <= 20; k++) { const u = k / 20; bank.push([lerp(x1, x0, u), Y_BANK + Math.pow(Math.sin(u * Math.PI), 0.8) * 70 + (vn1(u * 9) - 0.5) * 6, 0.5 + 0.5 * Math.sin(u * Math.PI)]); }
    stroke(B, bank, { w: 5, tone: 0.6, dry: 0.2, dryEnd: 0.6, halo: 2.5, seed: 604, t0: a, t1: b, tEase: 0.9 });
    const bar = [...bank.map((p) => [p[0], p[1] - 2]), [x0, Y_BANK - 20], [x1, Y_BANK - 20]];
    wash(B, bar, { tone: 0.2, soft: 8, rim: 0.35, jag: 2, gran: 0.6, bloom: 0.4, seed: 605, t0: a + 0.25, t1: b + 0.35, tfn: (wx, wy) => Math.min(1, Math.max(0, ((x1 - wx) / (x1 - x0)) * 0.85 + 0.15 * vn1(wy * 0.05 + wx * 0.013))) });
    const R = rng(606);
    for (let i = 0; i < 14; i++) {
      const u = (i + 0.5) / 14, xx = lerp(x1, x0, u), yy = Y_BANK + Math.pow(Math.sin(u * Math.PI), 0.8) * 70 + 14 + (i % 3) * 8;
      stroke(B, [[xx + 34, yy - 3, 0.4], [xx, yy + 2, 1], [xx - 34, yy - 3, 0.4]], { w: 1.4, tone: 0.32, seed: 610 + i, t0: a + (b - a) * u, t1: a + (b - a) * u + 0.3 });
      if (R.f() < 0.5) dot(B, xx + R.r(-20, 20), Y_BANK + Math.pow(Math.sin(u * Math.PI), 0.8) * 70 * R.r(0.3, 0.8), R.r(1.4, 2.4), { ax: 1.8, tone: 0.6, seed: 640 + i, t0: b, t1: b + 0.4 });
    }
    out.push(spr('reroute', B, 1, a - 0.6, b + 0.7, [T.asteroid, T.wei]));
  }
  tlog('reroute', t0);

  // ---- 岸上有了人：茅屋、火与烟、人、独木舟 ----
  t0 = performance.now();
  {
    const cx = X.human, x0 = cx - 520, x1 = cx + 520;
    const B = timed(x0, 150, x1 - x0, 760 - 150);
    const a = L.human0, b = L.human1, d = b - a;
    M.hut(B, cx - 250, Y_BANK - 4, 88, { seed: 701, tw: { t0: a, t1: a + d * 0.35 } });
    M.fire(B, cx - 40, Y_BANK - 6, 22, { seed: 702, smokeH: 250, wind: -1, tw: { t0: a + d * 0.25, t1: b + 0.4 } });
    figure(B, cx - 100, Y_BANK - 4, 56, { pose: 'stand', dir: 1, seed: 703, t0: a + d * 0.15, t1: a + d * 0.35 });
    figure(B, cx + 14, Y_BANK - 4, 46, { pose: 'sit', dir: -1, seed: 704, t0: a + d * 0.3, t1: a + d * 0.5 });
    figure(B, cx - 160, Y_BANK - 4, 40, { pose: 'sit', dir: 1, seed: 705, t0: a + d * 0.4, t1: a + d * 0.6 });
    const bx = cx + 330, by = 668;
    M.hull(B, bx, by, 160, { dir: -1, tone: 0.82, h: 11, rise: 5, fill: 0.6, seed: 706, tw: { t0: a + d * 0.5, t1: a + d * 0.75 } });
    figure(B, bx + 95, by - 9, 42, { pose: 'row', dir: -1, seed: 707, pole: 1.4, t0: a + d * 0.7, t1: a + d * 0.95 });
    out.push(spr('human', B, 1, a, b + 0.8, [T.L18.t, T.L21.t]));
  }
  tlog('human', t0);

  // ---- 「鲔」旁的小楷：季春之月 天子始乘舟 / 荐鲔于寝庙（两行，从右往左） ----
  t0 = performance.now();
  {
    const [c1, c2] = weiNoteCols(L.weiNote.text);
    const size = 33;
    const m1 = textMask(c1, fonts.kai, { size, vertical: true, gap: 0.14 });
    const m2 = textMask(c2, fonts.kai, { size, vertical: true, gap: 0.14 });
    const xA = X.wei - 232, xB = xA - size * 1.45, y = 128;
    const B = timed(xB - 8, y - 8, xA - xB + m1.w + 16, Math.max(m1.h, m2.h) + 16);
    const a = L.weiNote.t0, b = L.weiNote.t1;
    const n1 = [...c1].length, n2 = [...c2].length, n = n1 + n2;
    stampMask(B, m1.m, m1.w, m1.h, xA, y, { tone: 0.84, halo: 1.2, haloK: 0.3, t0: a, t1: b, tfn: (lx, ly) => Math.min(1, (ly / m1.step) / n) });
    stampMask(B, m2.m, m2.w, m2.h, xB, y, { tone: 0.84, halo: 1.2, haloK: 0.3, t0: a, t1: b, tfn: (lx, ly) => Math.min(1, (n1 + ly / m2.step) / n) });
    out.push(spr('weiNote', B, 1, a, b + 0.5, [T.L19.t, T.L22.t]));
  }
  tlog('weiNote', t0);

  // ---- 周：鼎里的香烟 ----
  {
    const Z = zhouLayout(P);
    const cx = Z.ding, cy = Y_BANK - 4 - 30;
    const B = timed(cx - 150, cy - 340, 310, 350);
    const pts = [];
    for (let k = 0; k <= 14; k++) { const u = k / 14; pts.push([cx + Math.sin(u * 7 + 1) * 10 * u - u * u * 100, cy - u * 310, 0.9 - 0.6 * u]); }
    stroke(B, pts, { w: 4, tone: 0.24, dry: 0.3, dryEnd: 0.8, halo: 3, haloK: 0.4, tail: 0.5, seed: 801, t0: L.zhouSmoke0, t1: L.zhouSmoke1 });
    out.push(spr('incense', B, 1, L.zhouSmoke0, L.zhouSmoke1 + 0.5, [T.wei, T.modern]));
  }

  // ---- 近代：厂房、烟囱、轮船、铁桥——焦墨几笔「砍」出来；江面上几道油黑；再是泼墨一样的黑烟 ----
  t0 = performance.now();
  {
    const ML = modernLayout(P);
    const x0 = X.bridge - 330, x1 = X.chimney + 280;
    const B = timed(x0, 120, x1 - x0, 780 - 120);
    const S = ML.sheds;
    M.sheds(B, S.x0, S.x1, S.y, S.h, { seed: 330, tw: S });
    ML.chim.forEach((c, i) => M.chimney(B, c.x, c.y, c.h, { w: c.w, lean: c.lean, seed: 323 + i, tw: c }));
    // 江面：几道横拖的焦墨干笔（油污），从右往左
    const R = rng(350), O = ML.oil;
    for (let i = 0; i < 7; i++) {
      const u = i / 6, xa = lerp(O.x1, O.x0, u * 0.8) + R.r(-60, 60), len = R.r(260, 520), yy = 600 + R.r(0, 150);
      stroke(B, [[xa, yy, 0.4], [xa - len * 0.3, yy + R.r(-3, 3), 1], [xa - len * 0.7, yy + R.r(-3, 3), 0.8], [xa - len, yy + R.r(-2, 2), 0.2]],
        { w: R.r(3, 7), tone: R.r(0.5, 0.72), dry: 0.62, dryEnd: 0.85, head: 0.05, tail: 0.4, rough: 0.2, fray: 1, halo: 1.5, seed: 351 + i,
          t0: lerp(O.t0, O.t1, u * 0.7), t1: lerp(O.t0, O.t1, u * 0.7) + 0.35 });
    }
    const SH = ML.ship;
    M.steamship(B, SH.x, SH.y, SH.len, { dir: 1, seed: 340, tw: SH });
    const BR = ML.bridge;
    M.trussBridge(B, BR.x0, BR.x1, BR.y, BR.s, { seed: 341, piers: 3, pierH: 118, tw: BR });
    out.push(spr('modern', B, 1, L.modern0, L.modern1 + 0.5, [T.L22.t, T.L24.t], { occ: 2, soft: 0.025 }));
  }
  {
    const ML = modernLayout(P);
    const x0 = X.bridge - 500, x1 = X.chimney + 320;
    const B = timed(x0, 0, x1 - x0, 700);
    ML.smoke.forEach((m, i) => M.smoke(B, m.x, m.y, m.len, { wind: -1, rise: m.rise, w0: 12, w1: m.w1, tone: 0.86, seed: 900 + i, tw: m }));
    const SH = ML.ship, SS = ML.shipSmoke;
    const fx = SH.x - SH.len * 0.52 + SH.len * 0.02 + 3, fy = SH.y - SH.len * 0.37;
    M.smoke(B, fx, fy - 4, SS.len, { wind: -1, rise: SS.rise, w0: 9, w1: SS.w1, tone: 0.84, seed: 910, tw: SS });
    const tA = Math.min(...ML.smoke.map((m) => m.t0), SS.t0), tB = Math.max(...ML.smoke.map((m) => m.t1), SS.t1);
    out.push(spr('smoke', B, 1, tA, tB + 0.6, [T.L22.t, T.L25.t], { occ: 1 }));
  }
  tlog('modern', t0);

  // ---- 海：墙外远处一抹极淡的水平线 ----
  {
    const x0 = X_DAM + 40, x1 = X_DAM + 1500, y = Y_BANK - 72;
    const B = timed(x0, y - 50, x1 - x0, 110);
    const a = L.sea0, b = L.sea1;
    const pts = [];
    for (let k = 0; k <= 20; k++) { const u = k / 20; pts.push([lerp(x0 + 20, x1 - 20, u), y + (vn1(u * 6) - 0.5) * 2.5, 0.5 + 0.5 * Math.sin(Math.min(1, u * 1.4) * Math.PI * 0.5)]); }
    stroke(B, pts, { w: 5, tone: 0.2, dry: 0.2, dryEnd: 0.5, halo: 4, haloK: 0.5, head: 0.05, tail: 0.3, fade: 0.4, seed: 1001, t0: a, t1: b, tEase: 0.8 });
    const band = [[x0 + 30, y + 4], [x1 - 60, y + 4], [x1 - 20, y + 30], [x0 + 60, y + 34]];
    wash(B, band, { tone: 0.06, soft: 14, rim: 0.1, jag: 2, gran: 0.6, seed: 1002, t0: a + 0.4, t1: b + 0.6, tfn: (wx) => (wx - x0) / (x1 - x0) });
    out.push(spr('sea', B, 1, a, b + 0.8, [T.L24.t, T.end]));
  }
  return out;
}


// ---------------------------------------------------------------------------
// 鱼的图集：每条鱼一个独立个体（不同笔、不同浓淡），头都朝左画，着色器里按方向翻转
export function buildFishAtlas(P) {
  const W = 2048;
  const items = P.fish.map((f) => {
    const m = 8;
    const w = Math.ceil(f.L * 1.03 + 2 * m), h = Math.ceil(f.L * 0.27 + 2 * m);
    return { f, w, h, ox: m, oy: Math.round(m + f.L * 0.13) };
  });
  const order = [...items].sort((a, b) => b.h - a.h);
  let x = 0, y = 0, rowH = 0;
  for (const it of order) {
    if (x + it.w > W) { x = 0; y += rowH + 2; rowH = 0; }
    it.u0 = x; it.v0 = y; x += it.w + 2; rowH = Math.max(rowH, it.h);
  }
  const H = Math.ceil((y + rowH + 2) / 4) * 4;
  const B = new InkBuf(W, H);
  for (const it of items) {
    const f = it.f;
    paddlefish(B, it.u0 + it.ox, it.v0 + it.oy, f.L, { style: 'xieyi', dir: -1, tone: f.tone, seed: 3000 + f.id * 7 });
  }
  const data = new Uint8Array(W * H * 4);
  packChannel(B, data, W, H, 1, 0, 0, 'd');
  const map = new Map(items.map((it) => [it.f.id, it]));
  return { data, W, H, map };
}
