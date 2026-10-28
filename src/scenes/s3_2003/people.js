// 写意人物：几笔墨的剪影，不画五官。一个 2D 骨架 + 两段式 IK（脚踩实、手抓住东西），姿势由关键帧决定。
// 侧视（江岸、抬鱼）和俯视（网箱船甲板上，人蹲在她身边）两种画法。
import { spline } from './curve.js';
import { CH } from './gl.js';
import { clamp, lerp, noise1 } from '../../film/util.js';

/** 两段 IK：根 A、目标 T、两段长 l1 l2，bend=+1/-1 选弯向；返回 [关节x, 关节y, 末端x, 末端y] */
export function ik(ax, ay, tx, ty, l1, l2, bend) {
  let dx = tx - ax, dy = ty - ay;
  let d = Math.hypot(dx, dy) || 1e-3;
  const dmax = (l1 + l2) * 0.999;
  if (d > dmax) { dx *= dmax / d; dy *= dmax / d; d = dmax; }
  const dmin = Math.abs(l1 - l2) + 1e-3;
  if (d < dmin) { dx *= dmin / d; dy *= dmin / d; d = dmin; }
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const ux = dx / d, uy = dy / d;
  return [ax + ux * a - uy * h * bend, ay + uy * a + ux * h * bend, ax + dx, ay + dy];
}

const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

/**
 * 侧视人形。p：
 *  x, y     骨盆（髋）位置（世界）；H 身高（世界像素）
 *  face     +1 朝右 / -1 朝左
 *  lean     上身前倾角（弧度，+ 向 face 方向弯）
 *  head     低头/抬头（弧度）
 *  fl, fr   远脚/近脚 着地点 [x,y]；hl, hr 远手/近手 目标 [x,y]
 *  ink      墨量；far 远处（更淡）；seed；cap 戴帽子
 *  coat     棉袄厚度倍数
 */
export function drawFigure(ink, p) {
  const H = p.H, f = p.face || 1;
  const K = p.ink === undefined ? 1.3 : p.ink;
  const sd = p.seed || 0;
  const ch = p.ch || CH.wet, chD = p.chD || CH.dry;
  const coat = p.coat || 1;
  const step = Math.max(1.5, H / 90);
  const px = p.x, py = p.y;
  const lean = p.lean || 0;
  // 脊柱：髋 → 胸 → 颈（y 向下为正）
  const [cx0, cy0] = rot(0, -0.29 * H, lean * f);
  const chx = px + cx0, chy = py + cy0;
  const [nx0, ny0] = rot(0, -0.05 * H, (lean + (p.head || 0) * 0.5) * f);
  const nkx = chx + nx0, nky = chy + ny0;
  const [hx0, hy0] = rot(0.012 * H * f, -0.068 * H, (lean + (p.head || 0)) * f);
  const hdx = nkx + hx0, hdy = nky + hy0;
  // 肩：胸口略前
  const [sx0, sy0] = rot(0.012 * H * f, 0.02 * H, lean * f);
  const shx = chx + sx0, shy = chy + sy0;
  const thigh = 0.245 * H, shin = 0.25 * H, upper = 0.17 * H, fore = 0.165 * H;
  const legs = [];
  for (const [ft, farK] of [[p.fl, 1], [p.fr, 0]]) {
    const hipx = px - f * 0.012 * H * (farK ? 1 : -1), hipy = py;
    const ankle = [ft[0], ft[1] - 0.03 * H];
    const [kx, ky, ax, ay] = ik(hipx, hipy, ankle[0], ankle[1], thigh, shin, -f); // 膝往前弯
    legs.push({ hipx, hipy, kx, ky, ax, ay, farK, toe: p.toe || 0 });
  }
  const arms = [];
  for (const [hd, farK] of [[p.hl, 1], [p.hr, 0]]) {
    const sx = shx - f * 0.01 * H * (farK ? 1 : -1), sy = shy;
    const [ex, ey, wx, wy] = ik(sx, sy, hd[0], hd[1], upper, fore, f * (p.elbowOut ? -1 : 1)); // 肘往后弯
    arms.push({ sx, sy, ex, ey, wx, wy, farK });
  }
  const kFar = p.far ? 0.5 : 1;
  const inkL = (farK) => K * kFar * (farK ? 0.6 : 1);
  const jit = (i) => noise1(sd * 13.1 + i * 3.7) * 0.012 * H;
  const bspF = Math.max(0.8, H * 0.009);
  // 墨色有主次：头最浓，棉袄次之，裤腿、手臂更淡、更干（笔断意连）
  const drawLeg = (L) => {
    const pts = spline([[L.hipx, L.hipy - 0.02 * H], [L.kx + jit(1), L.ky], [L.ax, L.ay]], step);
    ink.stroke(pts, { w: (u) => H * lerp(0.06 * coat, 0.027, Math.pow(u, 0.85)) * (0.9 + 0.2 * noise1(u * 4 + sd)), ch, ink: (u) => inkL(L.farK) * lerp(0.85, 0.6, u),
      dry: (u) => 0.18 + 0.5 * Math.pow(u, 1.4), bsp: bspF, seed: sd + L.farK * 3 + 1, rim: 0.5, cap: 2, side: 0.3 * f });
    // 脚：顺势一点（起笔按、往前一带就收），不是一块鞋
    const toe = [L.ax + f * 0.07 * H, L.ay + 0.03 * H - L.toe * 0.04 * H];
    const heel = [L.ax - f * 0.01 * H, L.ay + 0.012 * H];
    ink.stroke(spline([heel, [lerp(heel[0], toe[0], 0.5), lerp(heel[1], toe[1], 0.5) + 0.006 * H], toe], step), { w: (u) => H * 0.03 * (1 - 0.75 * Math.pow(u, 1.3)) * (0.8 + 0.4 * Math.exp(-u * 6)), ch, ink: (u) => inkL(L.farK) * (1.0 - 0.3 * u), dry: (u) => 0.2 + 0.45 * u, seed: sd + L.farK * 3 + 2, cap: 2 });
  };
  const drawArm = (A) => {
    const pts = spline([[A.sx, A.sy], [A.ex, A.ey], [A.wx, A.wy]], step);
    ink.stroke(pts, { w: (u) => H * lerp(0.05 * coat, 0.021, Math.pow(u, 0.9)), ch, ink: (u) => inkL(A.farK) * lerp(0.85, 0.65, u), dry: (u) => 0.15 + 0.5 * u, bsp: bspF, seed: sd + A.farK * 5 + 7, rim: 0.5, cap: 2 });
    ink.blob(A.wx + (A.wx - A.ex) * 0.1, A.wy + (A.wy - A.ey) * 0.1, H * 0.019, { ch, ink: inkL(A.farK) * 0.9, irr: 0.35, seed: sd + A.farK * 5 + 8 });
  };
  if (!p.noLegs) drawLeg(legs[0]);
  drawArm(arms[0]);
  // 躯干：一笔侧锋（背侧深、胸前淡），棉袄鼓鼓的，下摆收笔飞白
  const hipMid = [px, py + (p.noLegs ? -0.02 : 0.03) * H];
  const [bx, by] = rot(-0.035 * H * f, -0.16 * H, lean * f);
  const torso = spline([[hipMid[0], hipMid[1]], [px + bx, py + by], [chx, chy], [nkx, nky]], step);
  const tw = (u) => H * coat * (0.118 + 0.034 * Math.sin(u * Math.PI * 0.9)) * (u > 0.86 ? lerp(1, 0.4, (u - 0.86) / 0.14) : 1) * (u < 0.08 ? 0.75 + 3 * u : 1);
  ink.stroke(torso, { wt: (u) => tw(u) * 0.5, wb: (u) => tw(u) * 0.5, ch, ink: (u) => K * kFar * lerp(0.95, 1.2, u), dry: (u) => 0.22 * Math.pow(1 - u, 2) + 0.05, side: 0.7 * f, rim: 0.5, bsp: Math.max(0.8, H * 0.011), seed: sd + 11, cap: 4 });
  // 头：一点浓墨
  ink.blob(hdx, hdy, H * 0.05, { ch, ink: K * kFar * 1.7, irr: 0.16, seed: sd + 12 });
  if (p.cap) {
    // 帽子：头顶一小团（帽顶）+ 往前伸的帽檐一撇
    const ha = (lean + (p.head || 0)) * f;
    const [c0x, c0y] = rot(-0.004 * H * f, -0.03 * H, ha);
    ink.blob(hdx + c0x, hdy + c0y, H * 0.045, { ch, ink: K * kFar * 1.4, irr: 0.18, ay: 0.72, rot: ha, seed: sd + 14 });
    const [c1x, c1y] = rot(0.02 * H * f, -0.022 * H, ha);
    const [c2x, c2y] = rot(0.085 * H * f, -0.012 * H, ha);
    ink.stroke(spline([[hdx + c1x, hdy + c1y], [hdx + c2x, hdy + c2y]], step), { w: (u) => H * 0.018 * (1 - 0.6 * u), ch, ink: K * kFar * 1.4, dry: 0.3, seed: sd + 13, cap: 2 });
  }
  if (!p.noLegs) drawLeg(legs[1]);
  drawArm(arms[1]);
  return { head: [hdx, hdy], hands: arms.map((a) => [a.wx, a.wy]), chest: [chx, chy] };
}

/** 走路/跑步时脚的相对位置：phase 周期数，stride 步幅，lift 抬脚高度 */
export function gait(phase, stride, lift) {
  const a = phase * Math.PI * 2;
  const foot = (ph) => [Math.cos(ph) * stride * 0.5, -Math.max(0, Math.sin(ph)) * lift];
  return { far: foot(a), near: foot(a + Math.PI), bob: Math.abs(Math.sin(a)) };
}

/**
 * 俯视的人（网箱船甲板上，从上往下看）：头顶一团墨、肩背一笔、两臂伸向手的目标
 * p: x, y（肩中点）, dir（身体朝向角：头朝哪）, H（身高尺度）, bend（弯腰程度 0..1：头往前探、背拉长）, hl/hr 手目标, ink, seed
 */
// ---- 手：白描（几笔勾出手指和掌缘）+ 一层极淡的肤色墨 ----
// 局部坐标 (a 沿前臂方向, b 往拇指一侧)，单位 P（手长：腕到中指尖）
// 手指：[根 a, 根 b, 方向角, 长, 宽]；平放张开 与 捏合（拇指食指相捏，其余蜷起）两套，按 pinch 插值
const FING_FLAT = [[0.46, 0.14, 0.12, 0.39, 0.088], [0.49, 0.045, 0.03, 0.45, 0.092], [0.475, -0.05, -0.07, 0.41, 0.086], [0.435, -0.14, -0.18, 0.31, 0.076]];
const FING_PINCH = [[0.46, 0.14, 0.44, 0.3, 0.09], [0.49, 0.045, 0.22, 0.2, 0.094], [0.475, -0.05, 0.12, 0.17, 0.088], [0.435, -0.14, 0.02, 0.13, 0.078]];
const THUMB_FLAT = [[0.08, 0.15], [0.22, 0.29], [0.37, 0.4]];
const THUMB_PINCH = [[0.08, 0.15], [0.3, 0.31], [0.715, 0.275]];

function handGeom(pinch, grip, spread) {
  const F = [];
  for (let i = 0; i < 4; i++) {
    const f = FING_FLAT[i], q = FING_PINCH[i];
    const sp = (spread === undefined ? 0.5 : spread) * 2;
    const ang = lerp(f[2] * sp, q[2], pinch);
    const len = lerp(f[3], q[3], pinch) * (1 - 0.5 * grip * (1 - pinch));
    F.push([lerp(f[0], q[0], pinch), lerp(f[1], q[1], pinch), ang, len, lerp(f[4], q[4], pinch)]);
  }
  const th = THUMB_FLAT.map((pt, i) => [lerp(pt[0], THUMB_PINCH[i][0], pinch), lerp(pt[1], THUMB_PINCH[i][1], pinch)]);
  return { F, th };
}

/** 手的捏合点（拇指尖）相对腕的偏移：已知要捏住的点，反算腕在哪 */
export function handTipOffset(dir, P, side = 1, grip = 0, pinch = 0) {
  const fx = Math.cos(dir), fy = Math.sin(dir);
  const nx = -fy * side, ny = fx * side;
  const { th } = handGeom(pinch, grip, 0.5);
  const [a, b] = th[2];
  return [fx * a * P + nx * b * P, fy * a * P + ny * b * P];
}

/**
 * 手（俯看手背）。写意：先一层淡墨把手的形铺出来（掌一笔侧锋、指头一指一笔），
 * 再用几笔浓墨点出最要紧的边（食指和拇指的外缘、掌外缘、指间的缝）——不把每根手指勾一圈。
 *  x,y 腕；dir 前臂方向（腕→指尖）；P 手长；side ±1 拇指在 dir 的哪一侧
 *  pinch 0..1 拇指食指相捏；grip 0..1 四指蜷（只在不捏时起作用）；spread 张指
 */
export function drawHand(ink, h) {
  const P = h.P, K = h.ink === undefined ? 0.8 : h.ink, sd = h.seed || 0;
  const ch = h.ch || CH.wet, chD = h.chD || CH.dry;
  const pinch = h.pinch || 0, grip = h.grip || 0, side = h.side || 1;
  const fx = Math.cos(h.dir), fy = Math.sin(h.dir);
  const nx = -fy * side, ny = fx * side;
  const W = (a, b) => [h.x + fx * a * P + nx * b * P, h.y + fy * a * P + ny * b * P];
  const step = Math.max(0.8, P / 60);
  const { F, th } = handGeom(pinch, grip, h.spread);
  const sgn = side; // 侧锋的浓边朝小指一侧（背光）
  // 掌：一笔侧锋，腕到指根，宽是手掌宽
  ink.stroke(spline([W(-0.04, 0.0), W(0.2, 0.005), W(0.44, 0.0)], step), { w: (u) => P * lerp(0.34, 0.44, u) * (1 + 0.05 * noise1(u * 5 + sd)), ch, ink: (u) => K * 0.26 * (0.7 + 0.3 * u), dry: (u) => 0.05 + 0.12 * u, side: -0.6 * sgn, rim: 0.85, bsp: P * 0.02, seed: sd, cap: 3 });
  // 手指：一指一笔（根粗、指尖圆收），指与指之间自然留出一线纸白
  const tips = [];
  for (let i = 0; i < 4; i++) {
    const [a0, b0, ang, len, wd] = F[i];
    const dA = Math.cos(ang), dB = Math.sin(ang);
    const tip = [a0 + dA * len, b0 + dB * len];
    const m = [a0 + dA * len * 0.5 + (-dB) * 0.006, b0 + dB * len * 0.5 + dA * 0.006];
    ink.stroke(spline([W(a0 - dA * 0.03, b0 - dB * 0.03), W(m[0], m[1]), W(tip[0] - dA * wd * 0.3, tip[1] - dB * wd * 0.3)], step), { w: (u) => P * wd * (0.95 - 0.12 * u) * (u > 0.8 ? Math.sqrt(Math.max(0, 1 - Math.pow((u - 0.8) / 0.2, 2))) * 0.9 + 0.1 : 1), ch, ink: (u) => K * 0.3 * (0.85 + 0.25 * u), dry: (u) => 0.04 + 0.1 * u, side: -0.5 * sgn, rim: 0.85, bsp: P * 0.012, seed: sd + 3 + i, cap: 4 });
    tips.push(tip);
  }
  // 拇指
  ink.stroke(spline([W(th[0][0], th[0][1]), W(th[1][0], th[1][1]), W(th[2][0] - 0.03, th[2][1] - 0.01)], step), { w: (u) => P * lerp(0.13, 0.09, u) * (u > 0.82 ? Math.sqrt(Math.max(0, 1 - Math.pow((u - 0.82) / 0.18, 2))) * 0.9 + 0.1 : 1), ch, ink: (u) => K * 0.3 * (0.85 + 0.2 * u), dry: (u) => 0.04 + 0.1 * u, side: 0.4 * sgn, rim: 0.85, bsp: P * 0.012, seed: sd + 9, cap: 4 });
  // 浓墨点睛：拇指外缘一笔兜到指尖、食指外缘、掌外缘到小指、两道指缝、骨节几点
  const lw = P * (h.line || 0.026);
  const acc = (pts, s2, kk = 1, taper = 1) => ink.stroke(spline(pts, step), { w: (u) => lw * kk * (0.35 + 0.95 * Math.pow(Math.sin(Math.PI * clamp(u * 1.05)), 0.8) * (1 - 0.4 * u * taper)) * (1 + 0.25 * noise1(u * 8 + s2)), ch: chD, ink: (u) => K * 1.8 * (1 - 0.35 * u), dry: (u) => 0.08 + 0.45 * Math.pow(u, 1.3), seed: sd + s2, cap: 2, bsp: 1 });
  const [ia, ib, iang, ilen, iwd] = F[0];
  const idA = Math.cos(iang), idB = Math.sin(iang);
  const ihw = iwd * 0.5;
  // 拇指外缘（从腕侧起，绕过指尖）
  const tdx = th[2][0] - th[1][0], tdy = th[2][1] - th[1][1], tl = Math.hypot(tdx, tdy) || 1;
  const tpA = -tdy / tl, tpB = tdx / tl;
  acc([W(0.04, 0.16), W(th[1][0] + tpA * 0.055, th[1][1] + tpB * 0.055), W(th[2][0] + tpA * 0.035 - tdx / tl * 0.02, th[2][1] + tpB * 0.035 - tdy / tl * 0.02), W(th[2][0] + tdx / tl * 0.02, th[2][1] + tdy / tl * 0.02)], 11, 1.0);
  // 食指外缘（虎口起，到指尖）
  acc([W(0.36 + 0.06 * pinch, 0.195), W(ia + idA * ilen * 0.5 - idB * ihw, ib + idB * ilen * 0.5 + idA * ihw), W(tips[0][0] - idB * ihw * 0.5, tips[0][1] + idA * ihw * 0.5), W(tips[0][0] + idA * 0.015, tips[0][1] + idB * 0.015)], 12, 0.9);
  // 掌外缘到小指
  const [pa, pb, pang, plen, pwd] = F[3];
  const pdA = Math.cos(pang), pdB = Math.sin(pang);
  acc([W(-0.02, -0.16), W(0.2, -0.19), W(pa + pdA * plen * 0.4 + pdB * pwd * 0.5, pb + pdB * plen * 0.4 - pdA * pwd * 0.5), W(tips[3][0] + pdB * pwd * 0.2, tips[3][1] - pdA * pwd * 0.2)], 13, 0.8);
  // 指缝：两道短线（中指两侧），从指根往外，不到指尖
  for (const [i, s2] of [[1, 14], [2, 15]]) {
    const [a0, b0, ang, len, wd] = F[i];
    const dA = Math.cos(ang), dB = Math.sin(ang);
    const e = -wd * 0.5;
    acc([W(a0 + dA * 0.02 - dB * e, b0 + dB * 0.02 + dA * e), W(a0 + dA * len * 0.45 - dB * e, b0 + dB * len * 0.45 + dA * e), W(a0 + dA * len * 0.72 - dB * e * 0.9, b0 + dB * len * 0.72 + dA * e * 0.9)], s2, 0.55);
  }
  for (let i = 0; i < 4; i++) { const [a0, b0] = F[i]; const p = W(a0 - 0.01, b0 - 0.01); ink.blob(p[0], p[1], P * 0.011, { ch: chD, ink: K * 0.6, irr: 0.35, seed: sd + 30 + i }); }
  return { tip: W(th[2][0], th[2][1]), index: W(tips[0][0], tips[0][1]) };
}

/**
 * 胳膊（从画外伸进来）：棉袄袖子两笔勾边（兰叶描）+ 一层淡墨 + 肘部两道褶 + 袖口一道弧，手接在腕上。
 *  sx,sy 肩（可在画外）；x,y 腕；P 手长；elbow ±1 肘往哪边弯；hand {dir, grip, pinch, side, spread}
 */
export function drawArm(ink, a) {
  const P = a.P, K = a.ink === undefined ? 0.85 : a.ink, sd = a.seed || 0;
  const ch = a.ch || CH.wet, chD = a.chD || CH.dry;
  const l = Math.hypot(a.x - a.sx, a.y - a.sy);
  const seg = Math.max(l * 0.52, a.len || P * 1.6);
  const [ex, ey] = ik(a.sx, a.sy, a.x, a.y, seg, seg, a.elbow || 1);
  const step = Math.max(2, P / 30);
  const sw = P * (a.sleeve || 0.64);
  // 袖子的中线：肩→肘→袖口（袖口在腕后一点）
  const dx = a.x - ex, dy = a.y - ey, dl = Math.hypot(dx, dy) || 1;
  const ux = dx / dl, uy = dy / dl;
  const cuff = [a.x - ux * P * 0.1, a.y - uy * P * 0.1];
  const mid = spline([[a.sx, a.sy], [ex, ey], cuff], step);
  const n = mid.length >> 1;
  const Lp = [], Rp = [];
  for (let i = 0; i < n; i++) {
    const j = Math.min(n - 1, i + 1), k = Math.max(0, i - 1);
    let tx = mid[2 * j] - mid[2 * k], ty = mid[2 * j + 1] - mid[2 * k + 1];
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const u = i / (n - 1);
    const hw = sw * 0.5 * (1.08 - 0.2 * u) * (1 + 0.07 * noise1(u * 5 + sd)) * (1 + 0.06 * Math.sin(u * 17 + sd));
    Lp.push([mid[2 * i] - ty * hw, mid[2 * i + 1] + tx * hw]);
    Rp.push([mid[2 * i] + ty * hw, mid[2 * i + 1] - tx * hw]);
  }
  // 袖子：主笔一大笔（湿，靠阴面偏一点，笔里带纹理），受光一侧再扫一笔干的；不是一根光滑的管子
  const eb = (a.elbow || 1) > 0 ? 1 : -1;
  const off = (arr, k) => { const o = []; for (let i = 0; i < n; i += 2) o.push([lerp(mid[2 * i], arr[i][0], k), lerp(mid[2 * i + 1], arr[i][1], k)]); o.push([lerp(mid[2 * n - 2], arr[n - 1][0], k), lerp(mid[2 * n - 1], arr[n - 1][1], k)]); return spline(o, step); };
  const dark = eb > 0 ? Rp : Lp, light = eb > 0 ? Lp : Rp;
  ink.stroke(off(dark, 0.18), { w: (u) => sw * 0.9 * (1.02 - 0.18 * u) * (1 + 0.12 * noise1(u * 4 + sd)), ch, ink: (u) => K * (a.wash || 0.8) * (0.8 + 0.35 * noise1(u * 3 + sd)), dry: (u) => 0.1 + 0.25 * u + 0.12 * noise1(u * 6 + sd), side: eb * 0.7, rim: 0.7, bsp: P * 0.02, seed: sd, cap: 0 });
  ink.stroke(off(light, 0.55), { w: (u) => sw * 0.42 * (1 - 0.2 * u), ch: chD, ink: K * 0.3, dry: (u) => 0.5 + 0.3 * u, side: -eb * 0.4, bsp: P * 0.012, seed: sd + 3, cap: 0 });
  // 阴面一道勾边（兰叶描：一笔里有提按），断在肘部
  const edgeLine = (arr, i0, i1, s2, kk) => {
    const o = []; for (let i = i0; i <= i1; i += 2) o.push(arr[Math.min(i, n - 1)]);
    if (o.length < 2) return;
    ink.stroke(spline(o, step), { w: (u) => P * 0.034 * kk * (0.3 + Math.pow(Math.sin(Math.PI * u), 0.7)) * (1 + 0.3 * noise1(u * 9 + s2)), ch: chD, ink: (u) => K * 1.5 * (0.6 + 0.4 * Math.sin(Math.PI * u)), dry: (u) => 0.15 + 0.4 * u, seed: sd + s2, cap: 2, bsp: 1.1 });
  };
  const em = Math.round((n - 1) * 0.5);
  edgeLine(dark, Math.round(n * 0.3), em - 1, 1, 0.8);
  edgeLine(dark, em + 2, n - 1, 2, 0.7);
  // 肘部的褶：几道短的折笔（起笔重、一折、收笔尖）
  for (let f = 0; f < 3; f++) {
    const i0 = Math.min(n - 1, Math.max(0, em + (f - 1) * Math.max(1, Math.round(n * 0.08))));
    const A = dark, Bq = light;
    const p0 = [lerp(A[i0][0], Bq[i0][0], 0.05), lerp(A[i0][1], Bq[i0][1], 0.05)];
    const i1 = Math.min(n - 1, i0 + 2);
    const p1 = [lerp(A[i1][0], Bq[i1][0], 0.32 + 0.05 * f), lerp(A[i1][1], Bq[i1][1], 0.32 + 0.05 * f)];
    const i2 = Math.max(0, i0 - 1);
    const p2 = [lerp(A[i2][0], Bq[i2][0], 0.55 + 0.1 * f), lerp(A[i2][1], Bq[i2][1], 0.55 + 0.1 * f)];
    ink.stroke(spline([p0, p1, p2], step), { w: (u) => P * 0.026 * (1.1 - 0.85 * u), ch: chD, ink: K * 1.2, dry: (u) => 0.15 + 0.5 * u, seed: sd + 5 + f, cap: 1 });
  }
  // 袖口：一道不太规则的弧（朝手那边鼓），浓墨，一头重一头轻
  const cl = Lp[n - 1], cr = Rp[n - 1];
  const cm = [(cl[0] + cr[0]) / 2 + ux * P * 0.07 + uy * P * 0.03, (cl[1] + cr[1]) / 2 + uy * P * 0.07 - ux * P * 0.03];
  ink.stroke(spline([[cl[0] - ux * P * 0.03, cl[1] - uy * P * 0.03], cm, [cr[0] + ux * P * 0.01, cr[1] + uy * P * 0.01]], step), { w: (u) => P * 0.036 * (1.1 - 0.7 * u) * (1 + 0.25 * noise1(u * 7 + sd)), ch: chD, ink: K * 1.6, dry: (u) => 0.12 + 0.4 * u, seed: sd + 8, cap: 2, bsp: 1 });
  const hd = a.hand || {};
  const dir = hd.dir === undefined ? Math.atan2(dy, dx) : hd.dir;
  return { elbow: [ex, ey], hand: drawHand(ink, { x: a.x, y: a.y, dir, P, ink: K * (hd.ink || 1), seed: sd + 20, ch, chD, grip: hd.grip, pinch: hd.pinch, side: hd.side, spread: hd.spread }) };
}

/**
 * 俯视的人（江面上看船边的人）：一团棉袄（湿墨，边缘不齐），头顶一团浓墨（头发），两条袖子伸出去，手是淡墨。
 *  x,y 两肩中点；dir 朝向；H 身高；bend 俯身程度；hl,hr 手（腕）的目标
 */
export function drawTopPerson(ink, p) {
  const H = p.H, K = p.ink === undefined ? 0.9 : p.ink, sd = p.seed || 0;
  const ch = p.ch || CH.wet;
  const d = p.dir, cx = Math.cos(d), cy = Math.sin(d);  // 朝前
  const rx = -cy, ry = cx;                             // 右
  const bend = p.bend || 0;
  const sw = 0.25 * H;
  const at = (f, r) => [p.x + cx * f * H + rx * r * H, p.y + cy * f * H + ry * r * H];
  // 背：三笔。肩一笔横着压下去（棉袄的肩，浓）；背一大笔往后拖，越往后越干越淡（腰以下散成飞白，不画出轮廓）；脊背一道褶
  const step = Math.max(2, H / 60);
  const bl = 0.3 + 0.3 * bend;
  ink.stroke(spline([at(-0.02, -0.25), at(0.02, -0.1), at(0.03, 0.08), at(-0.01, 0.25)], step), { w: (u) => H * 0.15 * (0.75 + 0.35 * Math.sin(Math.PI * u)) * (1 + 0.1 * noise1(u * 5 + sd)), ch, ink: (u) => K * 0.75 * (0.85 + 0.3 * noise1(u * 4 + sd)), dry: (u) => 0.12 + 0.2 * Math.abs(u - 0.5), side: 0.5, rim: 0.7, bsp: H * 0.008, seed: sd, cap: 3 });
  ink.stroke(spline([at(-0.03, 0.02), at(-bl * 0.45, 0.03), at(-bl, -0.01)], step), { w: (u) => H * lerp(0.44, 0.3, u) * (1 + 0.08 * noise1(u * 4 + sd + 1)), ch, ink: (u) => K * 0.42 * (1 - 0.55 * u), dry: (u) => 0.1 + 0.65 * Math.pow(u, 1.2), side: -0.4, rim: 0.7, bsp: H * 0.009, seed: sd + 1, cap: 0 });
  ink.stroke(spline([at(-0.06, 0.05), at(-bl * 0.4, 0.07), at(-bl * 0.75, 0.04)], step), { w: (u) => H * 0.02 * (1 - 0.7 * u), ch: CH.dry, ink: K * 0.7, dry: (u) => 0.2 + 0.5 * u, seed: sd + 2, cap: 1 });
  // 头：浓墨一团（头发），往前探；上面几笔短的发丝
  const hd = at(0.1 + 0.1 * bend, 0.0);
  ink.blob(hd[0], hd[1], H * 0.072, { ch, ink: K * 1.5, irr: 0.22, ex: cx * H * 0.02, ey: cy * H * 0.02, seed: sd + 3 });
  for (let k = 0; k < 4; k++) {
    const a0 = (k - 1.5) * 0.5;
    const p0 = [hd[0] - cx * H * 0.05 + rx * H * 0.03 * (k - 1.5), hd[1] - cy * H * 0.05 + ry * H * 0.03 * (k - 1.5)];
    const p1 = [p0[0] - cx * H * 0.05 * Math.cos(a0) + rx * H * 0.02 * Math.sin(a0), p0[1] - cy * H * 0.05 * Math.cos(a0) + ry * H * 0.02 * Math.sin(a0)];
    ink.stroke(new Float32Array([p0[0], p0[1], p1[0], p1[1]]), { w: (u) => H * 0.012 * (1 - u), ch: CH.dry, ink: K * 1.1, dry: 0.4, seed: sd + 4 + k, cap: 1 });
  }
  // 胳膊：袖子 + 淡墨的手
  const P = H * 0.105;
  const out = [];
  for (const [sgn, tg, k] of [[-1, p.hl, 0], [1, p.hr, 1]]) {
    if (!tg) continue;
    const sh = at(0.0, sgn * 0.2);
    const r = drawArm(ink, { sx: sh[0], sy: sh[1], x: tg[0], y: tg[1], P, len: H * 0.16, elbow: sgn, ink: K, seed: sd + 10 + k * 20, ch, sleeve: 0.9, hand: { grip: p.grip || 0.3, side: -sgn, spread: 0.6 } });
    out.push(r.hand.tip);
  }
  return { head: hd, hands: out };
}

export const clamp01 = clamp;
