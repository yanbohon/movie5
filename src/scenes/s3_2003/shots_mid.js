// 中段：江岸 → 八个人抬 → 棉被（很暖）
import { makeView, CH } from './gl.js';
import { Fish, dorsalH, ventralH, drawNetOn, brushLike } from './fish.js';
import { drawFigure, gait } from './people.js';
import { spline, kf } from './curve.js';
import { mountains } from './common.js';
import { clamp, lerp, smooth, noise1, mulberry32 } from '../../film/util.js';

// 卵石滩：扁扁的墨点，近处大、远处小
function makePebbles(seed, x0, x1, y0, y1, n) {
  const R = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = Math.pow(R(), 0.8);
    const y = lerp(y0, y1, v);
    const sz = lerp(3, 16, v) * (0.5 + R());
    out.push({ x: lerp(x0, x1, R()), y, r: sz, ay: 0.45 + R() * 0.25, ink: 0.12 + Math.pow(R(), 2) * 0.55, rot: (R() - 0.5) * 0.4, seed: R() * 99, dark: R() < 0.08 });
  }
  return out;
}
function drawPebbles(ink, list, o = {}) {
  for (const p of list) {
    ink.blob(p.x, p.y, p.r, { ch: CH.wet, ink: (p.dark ? p.ink * 2 : p.ink) * (o.k || 1), irr: 0.2, ay: p.ay, rot: p.rot, seed: p.seed });
  }
}
// 渔船（乌篷小船）：船舷一笔、船身一笔侧锋、篷几道弧
function drawBoat(ink, x, y, s, o = {}) {
  const k = o.ink || 1, sd = o.seed || 0;
  const S = (px, py) => [x + px * s, y + py * s];
  ink.stroke(spline([S(-360, -18), S(-120, 8), S(200, 4), S(370, -40)], 5), { w: (u) => s * 14 * brushLike(u, 0.05, 0.2), ink: 1.25 * k, dry: (u) => 0.1 + 0.3 * u, ch: CH.wet, seed: sd, cap: 3, bsp: 2 });
  ink.stroke(spline([S(-340, 12), S(-120, 44), S(180, 40), S(350, -24)], 6), { wt: s * 30, wb: s * 4, ink: 0.8 * k, dry: (u) => 0.15 + 0.4 * u, side: 0.8, ch: CH.wet, seed: sd + 1, cap: 3, bsp: 3 });
  // 篷
  for (let i = 0; i < 4; i++) {
    const a = -250 + i * 55;
    ink.stroke(spline([S(a, 0), S(a + 20, -70), S(a + 60, -78), S(a + 90, -6)], 4), { w: s * (9 - i), ink: 0.9 * k, dry: 0.3, ch: CH.wet, seed: sd + 3 + i, cap: 2 });
  }
  ink.fill(new Float32Array([...S(-260, 0), ...S(-240, -68), ...S(-150, -82), ...S(-60, -60), ...S(-40, -2)]), { ch: CH.wet, ink: 0.35 * k, tex: 1.2, seed: sd + 9 });
  // 竹篙
  ink.stroke(spline([S(210, 0), S(290, -200), S(340, -330)], 6), { w: s * 4.5, ink: 0.9 * k, dry: 0.35, ch: CH.dry, seed: sd + 12, cap: 2 });
  // 挂在船舷上的网
  for (let i = 0; i < 5; i++) {
    const a = -60 + i * 40;
    ink.stroke(spline([S(a, 2), S(a + 15 + i * 3, 30), S(a + 32, 6)], 4), { w: s * 2.5, ink: 0.45 * k, dry: 0.4, ch: CH.dry, seed: sd + 20 + i, cap: 1 });
  }
}

// ---------------------------------------------------------------- 江岸
export function makeShore(ctx, ink, T) {
  const fish = new Fish();
  const pebbles = makePebbles(311, -200, 2300, 690, 1080, 360);
  const currents = [];
  const R = mulberry32(77);
  for (let i = 0; i < 9; i++) currents.push({ y: 505 + R() * 130, x0: -300 + R() * 900, len: 500 + R() * 900, seed: R() * 50, ink: 0.05 + R() * 0.07 });
  const H = 270, gy = 800;
  const lookAt = (t) => t; void lookAt;
  return {
    id: 'shore', t0: T.shoreIn, t1: T.liftIn + 0.75,
    paper: [1, 300, 700],
    enter: { type: 0, dur: 0.95, win: [0, 0.55, 0.3, 1], seed: 2.2, soft: 0.1 },
    view: (t) => {
      const a = clamp((t - T.shoreIn) / (T.liftIn - T.shoreIn + 0.75));
      return makeView(1000 + 70 * smooth(a), 570 + 20 * smooth(a), 1.0 + 0.07 * smooth(a), 0);
    },
    look: () => ({ bleed: 0.8, rim: 0.8, gran: 0.55 }),
    post: () => ({ exposure: 1.0, vignette: 0.27, grain: 0.028, bloom: 0.04 }),
    draw(ink, t) {
      const a = t - T.shoreIn;
      // 远山两层 + 水汽
      mountains(ink, -300, 2500, 455, 210, { ink: 0.07, seed: 3.3, bsp: 8 });
      mountains(ink, -200, 2400, 485, 120, { ink: 0.14, seed: 7.1, bsp: 6 });
      // 江：几道淡淡的水纹往下游（右）走
      for (const c of currents) {
        const x = c.x0 + a * 25;
        ink.stroke(spline([[x, c.y], [x + c.len * 0.5, c.y + 3], [x + c.len, c.y - 2]], 10), { w: (u) => 3.5 * Math.sin(Math.PI * u), ink: c.ink, dry: 0.5, ch: CH.dry, seed: c.seed, cap: 1 });
      }
      // 水边：一道湿的深色
      ink.stroke(spline([[-300, 668], [500, 660], [1200, 672], [2400, 664]], 10), { wt: 3, wb: 26, ink: 0.18, dry: 0.4, side: -0.6, ch: CH.wet, seed: 4.4, cap: 0, bsp: 4 });
      drawPebbles(ink, pebbles);
      // 船
      drawBoat(ink, 470, 640, 1.0, { seed: 1.7 });
      // 她：躺在卵石上，还裹着网；鳃一张一合，偶尔甩一下尾
      const tw = Math.exp(-Math.max(0, t - T.wow) * 3) * Math.sin((t - T.wow) * 14) * (t > T.wow ? 1 : 0);
      fish.pose({ x: 1165, y: 770, L: 590, ang: -0.03, anchor: 0.5, kappa: (u) => (u > 0.6 ? 0.9 * tw : 0) });
      fish.drawSide(ink, { seed: 2.4, gill: 0.5 + 0.5 * Math.sin(t * 2.3), detail: 0.5, tailSwing: 0.02 * tw });
      drawNetOn(ink, fish, { tight: 0.85, n: 12, ink: 0.75, w: 1.8 });
      // 人
      const figs = [];
      // 1 喊「我的妈呀，好大一条象鱼」的渔民：先往后一仰双手一扬，再指着她
      {
        const x = 745 - 25 * smooth((t - T.L.H01.t - 0.3) / 0.35) + 10 * smooth((t - T.wow) / 0.4);
        const lean = kf(t, [[T.L.H01.t + 0.2, 0.05], [T.L.H01.t + 0.55, -0.22], [T.wow - 0.1, -0.12], [T.wow + 0.25, 0.18]]);
        const py = gy - 0.52 * H;
        const up = smooth((t - T.L.H01.t - 0.25) / 0.3) * (1 - smooth((t - T.wow + 0.1) / 0.35));
        const point = smooth((t - T.wow) / 0.3);
        const hl = [lerp(lerp(x - 20, x - 90, up), x - 30, point), lerp(lerp(py + 20, py - 0.62 * H, up), py + 30, point)];
        const hr = [lerp(lerp(x + 25, x + 70, up), x + 0.62 * H, point), lerp(lerp(py + 25, py - 0.66 * H, up), py - 0.28 * H + 8 * Math.sin(t * 9) * point, point)];
        figs.push({ x, y: py, H, face: 1, lean, head: -0.1 * up + 0.1 * point, fl: [x - 18, gy], fr: [x + 20, gy], hl, hr, ink: 1.35, seed: 11, cap: true });
      }
      // 2、3 拉网的两个人：往后仰，一把一把往回拽
      [[1590, 21, 0], [1740, 23, 0.4]].forEach(([x0, sd, ph]) => {
        const pull = clamp((T.L.H02.t - 0.3 - t) / 1.2);
        const cyc = (t - T.shoreIn) * 1.3 + ph;
        const heave = Math.max(0, Math.sin(cyc * Math.PI * 2)) * pull;
        const x = x0 + 26 * Math.floor(cyc) * pull + 18 * heave;
        const py = gy - 0.47 * H - 10 * heave;
        const lean = -0.38 * pull - 0.08 * heave + 0.05;
        figs.push({ x, y: py, H, face: -1, lean, head: 0.1, fl: [x + 30, gy], fr: [x - 35, gy - 2], hl: [x - 0.3 * H, py - 0.2 * H - 10 * heave], hr: [x - 0.36 * H, py - 0.17 * H - 10 * heave], ink: 1.3, seed: sd, cap: sd === 23 });
      });
      // 4 蹲在她背后摸她的人（远，淡）
      {
        const x = 1230, py = 700;
        const bp = fish.P(0.55, dorsalH(0.55)), bp2 = fish.P(0.62, dorsalH(0.62));
        figs.push({ x, y: py, H: H * 0.95, face: -1, lean: 0.95 + 0.05 * Math.sin(t * 1.3), head: 0.25, fl: [x + 20, 760], fr: [x - 10, 760], hl: [bp[0] + 10, bp[1] + 6], hr: [bp2[0], bp2[1] + 4], ink: 0.9, far: true, noLegs: true, seed: 31 });
      }
      // 5 船上的妇女：「快去喊渔政的人来！」转身朝岸上挥手喊
      {
        const x = 610, gyb = 632, py = gyb - 0.52 * H * 0.92;
        const call = smooth((t - T.L.H02.t) / 0.3) * (1 - smooth((t - T.L.H02.t - 1.8) / 0.5));
        const face = t > T.L.H02.t - 0.1 ? 1 : -1;
        const wave = Math.sin((t - T.L.H02.t) * 12) * call;
        figs.push({ x, y: py, H: H * 0.92, face, lean: 0.12 * call, head: -0.15 * call, fl: [x - 16, gyb], fr: [x + 18, gyb], hl: [x - 30 * face, py + 20], hr: [x + (60 + 20 * wave) * face, py - 0.55 * H * call + (1 - call) * 20], ink: 1.1, seed: 41 });
      }
      // 6 跑去喊人的年轻人
      {
        const r0 = T.run;
        const d = t < r0 ? 0 : 520 * (t - r0) + 160 * Math.pow(Math.max(0, t - r0), 2);
        const x = 1370 + d, gyr = 745;
        const running = clamp((t - r0) / 0.25);
        const g = gait(d / 190, 0.36 * H * running + 1, 0.12 * H * running);
        const py = gyr - 0.5 * H * 0.9 - 8 * g.bob * running;
        const sw = Math.sin((d / 190) * Math.PI * 2) * running;
        figs.push({ x, y: py, H: H * 0.9, face: t < r0 - 0.35 ? -1 : 1, lean: 0.35 * running, head: -0.1, fl: [x + g.far[0], gyr + g.far[1]], fr: [x + g.near[0], gyr + g.near[1]],
          hl: [x - 0.25 * H * sw, py - 0.05 * H], hr: [x + 0.25 * H * sw, py - 0.05 * H], ink: 0.95, far: true, seed: 51 });
      }
      const heads = figs.map((f) => drawFigure(ink, f));
      // 拉网的绳：从她尾巴那头拉到两个人手里
      const tail = fish.P(0.97, 0.01);
      const h2 = heads[1].hands[1], h3 = heads[2].hands[1];
      ink.stroke(spline([tail, [lerp(tail[0], h2[0], 0.5), lerp(tail[1], h2[1], 0.5) + 14], h2, [lerp(h2[0], h3[0], 0.5), lerp(h2[1], h3[1], 0.5) + 6], h3, [h3[0] + 40, h3[1] + 60]], 6), { w: 3.2, ink: 0.8, dry: 0.35, ch: CH.dry, seed: 61, cap: 1 });
    },
  };
}

// ---------------------------------------------------------------- 八个人抬
export function makeLift(ctx, ink, T) {
  const fish = new Fish();
  const pebbles = makePebbles(512, -300, 2400, 780, 1100, 300);
  const H = 440, L = 900, gyN = 935, gyF = 812;
  // 棉被：一块方布（网格），飞进来 → 盖上 → 裹紧
  const QI = 14, QJ = 8;
  const NEAR = [600, 830, 1060, 1290], FAR = [700, 930, 1160, 1390];
  function bodyY(t) {
    const strain = 12 * Math.sin(clamp((t - T.strain) / 0.55) * Math.PI);
    const up = 160 * smooth((t - T.lift) / 0.65);
    const bob = t > T.lift + 0.65 ? 6 * Math.sin((t - T.lift) * 7.5) : 0;
    return 790 - strain - up - bob;
  }
  function bodyX(t) { return 960 + 45 * Math.max(0, t - T.lift - 0.55); }
  function quiltPt(i, j, t) {
    // 布上一点：i 沿长 0..QI-1，j 沿宽 0..QJ-1
    const a = i / (QI - 1), b = j / (QJ - 1);
    const fly = clamp((t - (T.cloth - 0.55)) / 0.55);
    // 空中：一张斜着飘的布
    const cx = lerp(-300, 980, smooth(fly)), cy = lerp(180, 520, fly) - 120 * Math.sin(fly * Math.PI);
    const ang = lerp(-0.5, 0.05, fly) + 0.15 * Math.sin(t * 5) * (1 - fly);
    const bx = (a - 0.5) * 980, by = (b - 0.5) * 320 * (0.5 + 0.5 * fly) + 40 * Math.sin(a * 6 + t * 7) * (1 - fly);
    const airX = cx + bx * Math.cos(ang) - by * Math.sin(ang), airY = cy + bx * Math.sin(ang) + by * Math.cos(ang);
    // 盖在身上：沿身子 u，从背上搭下来，两边垂到地上
    const u = lerp(0.36, 0.93, a);
    const topH = dorsalH(u) + 0.02, botH = -ventralH(u) - 0.02;
    const wrapK = smooth((t - T.wrap + 0.15) / 0.45);
    const drapeHang = (1 - wrapK) * 0.06 * Math.sin(a * Math.PI);
    const h = lerp(topH + 0.015, botH - drapeHang, b) + 0.006 * Math.sin(a * 17 + b * 5);
    const p = fish.P(u, h);
    if (t < T.cloth - 0.55) return [airX, airY - 900];
    const land = smooth((t - T.cloth + 0.12) / 0.3);
    return [lerp(airX, p[0], land), lerp(airY, p[1], land)];
  }
  return {
    id: 'lift', t0: T.liftIn, t1: T.quiltIn + 0.95,
    paper: [1, 1100, 180],
    enter: { type: 0, dur: 0.75, win: [0, 0.6, 0.25, 1], seed: 5.3, soft: 0.1 },
    view: (t) => {
      const a = clamp((t - T.lift) / 2.2);
      return makeView(960 + 60 * smooth(a) + 0.8 * Math.max(0, t - T.lift) * 45, 600 - 30 * smooth(a), 1.0 + 0.12 * smooth(clamp((t - T.lift - 0.6) / 1.8)), 0);
    },
    look: () => ({ bleed: 0.8, rim: 0.8, gran: 0.55 }),
    post: () => ({ exposure: 1.0, vignette: 0.28, grain: 0.028, bloom: 0.04 }),
    draw(ink, t) {
      // 远处：江和对岸，极淡
      mountains(ink, -300, 2600, 360, 150, { ink: 0.06, seed: 9.9, bsp: 8 });
      ink.stroke(spline([[-300, 520], [900, 512], [2500, 522]], 10), { wt: 2, wb: 40, ink: 0.08, dry: 0.5, side: -0.7, ch: CH.wet, seed: 3.1, cap: 0 });
      drawPebbles(ink, pebbles, { k: 0.8 });
      const bx = bodyX(t), by = bodyY(t);
      fish.pose({ x: bx, y: by, L, ang: -0.02 + 0.03 * Math.sin(clamp((t - T.lift) / 0.6) * Math.PI), anchor: 0.55, kappa: (u) => (u > 0.8 ? 0.3 * Math.sin(t * 3) * (t < T.cloth ? 1 : 0.2) : 0) });
      const hasQuilt = t > T.cloth - 0.55;
      // 她（被子盖上后只露出吻和尾）
      fish.drawSide(ink, { seed: 3.1, gill: 0.4 + 0.4 * Math.sin(t * 2.1), detail: 0.6, parts: hasQuilt && t > T.cloth ? { body: false, fins: false } : {} });
      if (!(hasQuilt && t > T.cloth)) drawNetOn(ink, fish, { tight: 0.9, n: 13, ink: 0.55, w: 2.2 });
      // 棉被
      if (hasQuilt) {
        const P = [];
        for (let i = 0; i < QI; i++) for (let j = 0; j < QJ; j++) P.push(quiltPt(i, j, t));
        const at = (i, j) => P[i * QJ + j];
        // 被面：一层淡墨（网格面片），边上深一点
        const G = new Float32Array(QI * QJ * 3);
        for (let i = 0; i < QI; i++) for (let j = 0; j < QJ; j++) {
          const p = at(i, j), k = (i * QJ + j) * 3;
          const e = Math.min(i, QI - 1 - i, j, QJ - 1 - j);
          G[k] = p[0]; G[k + 1] = p[1]; G[k + 2] = 0.16 + (e === 0 ? 0.05 : 0) + 0.06 * Math.sin(i * 1.3 + j * 2.1);
        }
        ink.grid(G, QI, QJ, { ch: CH.wet, tex: 1.2, seed: 7.7 });
        // 绗缝的线（虚线，跟着布走）
        for (let j = 1; j < QJ - 1; j += 2) {
          const row = []; for (let i = 0; i < QI; i++) row.push(at(i, j));
          const pts = spline(row, 6);
          ink.stroke(pts, { w: 1.8, ink: (u) => (Math.sin(u * 90) > 0.1 ? 0.5 : 0), dry: 0.3, ch: CH.dry, seed: 90 + j, cap: 0 });
        }
        // 褶：几道深一点的线
        for (let i = 2; i < QI - 1; i += 3) {
          const col = []; for (let j = 0; j < QJ; j++) col.push(at(i, j));
          ink.stroke(spline(col, 6), { w: (u) => 5 * Math.sin(Math.PI * u), ink: 0.45, dry: 0.35, ch: CH.wet, seed: 120 + i, cap: 2 });
        }
        // 布边
        const edgeTop = []; for (let i = 0; i < QI; i++) edgeTop.push(at(i, 0));
        const edgeBot = []; for (let i = 0; i < QI; i++) edgeBot.push(at(i, QJ - 1));
        ink.stroke(spline(edgeTop, 6), { w: 4.5, ink: 0.6, dry: 0.25, ch: CH.wet, seed: 130, cap: 2 });
        ink.stroke(spline(edgeBot, 6), { w: 4, ink: 0.55, dry: 0.3, ch: CH.wet, seed: 131, cap: 2 });
      }
      // 八个人
      const figs = [];
      const pose8 = (i, isNear) => {
        const x0 = isNear ? NEAR[i] : FAR[i];
        const gy = isNear ? gyN : gyF;
        const dt = [0.0, 0.16, 0.05, 0.22][i] + (isNear ? 0 : 0.09);
        const tt = t - dt;
        const deep = [1, 0.85, 0.95, 0.8][i];
        const crouch = deep * kf(tt, [[T.liftIn, 1], [T.strain - 0.05, 1], [T.strain + 0.4, 0.8], [T.strain + 0.95, 0.15 + 0.1 * (i % 2)], [T.cloth - 0.4, 0.1], [T.cloth + 0.1, 0.55], [T.wrap + 0.2, 0.9], [T.lift - 0.05, 1], [T.lift + 0.6, 0.25]]);
        const walk = Math.max(0, tt - T.lift - 0.55);
        const dx = 45 * walk;
        const g = gait(walk * 0.9 + i * 0.25, 0.14 * H * clamp(walk * 2), 0.04 * H);
        const x = x0 + dx;
        const py = gy - lerp(0.52, 0.3, crouch) * H - (walk > 0 ? 5 * g.bob : 0);
        const lean = lerp(0.08, 0.75, crouch) + (Math.abs(tt - T.strain - 0.2) < 0.35 ? 0.02 * Math.sin(tt * 60) : 0) - (t > T.lift ? 0.1 : 0);
        // 手：抓在她身上（近侧抓腹下、远侧抓背上）
        const u = clamp((x - (bodyX(t) - L * 0.55)) / L, 0.36, 0.92);
        const grab = fish.P(u, isNear ? -ventralH(u) - 0.01 : dorsalH(u) + 0.005);
        const rest = [x + 0.08 * H, py + 0.2 * H];
        const hold = t > T.cloth - 0.4 && t < T.cloth + 0.1 ? 0 : 1;
        const hh = [lerp(rest[0], grab[0] - 12, hold), lerp(rest[1], grab[1], hold)];
        const hh2 = [lerp(rest[0] - 20, grab[0] + 14, hold), lerp(rest[1], grab[1] + 4, hold)];
        const Hh = H * [1, 0.95, 1.04, 0.97][i];
        return { x, y: py, H: Hh, face: 1, lean, head: 0.15 * crouch + 0.1 * Math.sin(i * 2.3), fl: [x - 0.1 * H + g.far[0], gy + g.far[1]], fr: [x + 0.08 * H + g.near[0], gy + g.near[1]], hl: hh, hr: hh2,
          ink: isNear ? 1.3 : 0.8, far: !isNear, noLegs: !isNear, seed: 200 + i * 7 + (isNear ? 0 : 3), cap: (i + (isNear ? 0 : 1)) % 3 === 0, coat: [1.1, 1.0, 1.2, 0.95][i] };
      };
      for (let i = 0; i < 4; i++) figs.push(pose8(i, false));
      for (let i = 0; i < 4; i++) figs.push(pose8(i, true));
      for (const f of figs) drawFigure(ink, f);
    },
  };
}

// ---------------------------------------------------------------- 棉被（很暖）
export function makeQuilt(ctx, ink, T) {
  const fish = new Fish();
  const R = mulberry32(2041);
  // 褶子：几道大的斜向软褶（侧锋淡墨），褶谷里一笔稍深
  const folds = [];
  for (let i = 0; i < 7; i++) folds.push({ x: 380 + i * 240 + R() * 80, y: -100 + R() * 80, len: 1250 + R() * 300, ang: 1.05 + (R() - 0.5) * 0.25, w: 150 + R() * 90, ink: 0.1 + R() * 0.08, seed: R() * 80, curl: (R() - 0.5) * 0.5 });
  // 被面上的花（旧式棉被的大花被面，几笔淡墨）
  const flowers = [];
  for (let i = 0; i < 6; i++) flowers.push({ x: 1000 + R() * 1150, y: 200 + R() * 800, r: 70 + R() * 40, seed: R() * 90, rot: R() * 6.28 });
  // 赭石洇开：CPU 上按时间算一张网格（中心往外、带噪声），GPU 上插值
  const GI = 40, GJ = 22;
  const G = new Float32Array(GI * GJ * 3);
  return {
    id: 'quilt', t0: T.quiltIn, t1: T.boatIn + 0.75,
    paper: [1.15, 500, 300],
    enter: { type: 3, dur: 0.95, win: [0, 0.6, 0.3, 1], seed: 8.4, soft: 0.12, dir: [1100, 560, 1.6] },
    view: (t) => {
      const a = clamp((t - T.quiltIn) / (T.boatIn + 0.75 - T.quiltIn));
      const bob = 5 * Math.sin((t - T.quiltIn) * 7.5 * 0.5);
      return makeView(1000 - 60 * a, 560 + bob - 20 * a, 1.0 + 0.1 * smooth(a), -0.01 + 0.02 * a);
    },
    look: () => ({ bleed: 0.9, rim: 0.7, gran: 0.6 }),
    post: (t) => {
      const w = smooth((t - T.warm) / 1.6) * (1 - 0.5 * smooth((t - T.boatIn) / 0.6));
      return { exposure: 1.0 + 0.03 * w, vignette: 0.3 - 0.05 * w, grain: 0.03, bloom: 0.05 + 0.05 * w };
    },
    draw(ink, t) {
      const a = t - T.quiltIn;
      // 褶（布的起伏）
      for (const f of folds) {
        const cx = Math.cos(f.ang), cy = Math.sin(f.ang);
        const p0 = [f.x, f.y], p2 = [f.x + cx * f.len, f.y + cy * f.len];
        const p1 = [(p0[0] + p2[0]) / 2 + f.curl * 200, (p0[1] + p2[1]) / 2];
        const pts = spline([p0, p1, p2], 10);
        ink.stroke(pts, { w: (u) => f.w * (0.7 + 0.3 * Math.sin(u * 3 + f.seed)), ink: (u) => f.ink * 0.7 * (0.5 + 0.5 * Math.sin(u * Math.PI)), dry: 0.12, side: 0.9, rim: 0.3, ch: CH.wet, bsp: 14, seed: f.seed, cap: 6 });
        // 褶谷一线：断断续续，只在褶最深的一段
        ink.stroke(pts, { w: (u) => 4.5 * Math.pow(Math.sin(Math.PI * u), 2) * (0.5 + 0.5 * noise1(u * 5 + f.seed)), ink: (u) => 0.3 * Math.max(0, noise1(u * 4 + f.seed * 2) + 0.2), dry: 0.5, ch: CH.dry, seed: f.seed + 1, cap: 2 });
      }
      // 绗缝的针脚：一格一格的虚线，跟着褶子起伏
      for (let r = 0; r < 9; r++) {
        const row = [];
        for (let c = 0; c <= 11; c++) {
          const x = 930 + c * 130, y = 120 + r * 115 + 24 * Math.sin(c * 0.9 + r * 0.7);
          row.push([x, y]);
        }
        ink.stroke(spline(row, 5), { w: 2.2, ink: (u) => (Math.sin(u * 260) > 0.2 ? 0.5 : 0), dry: 0.35, ch: CH.dry, seed: 300 + r, cap: 0 });
      }
      // 被面上的大花：几片淡墨花瓣
      for (const fl of flowers) {
        for (let k = 0; k < 5; k++) {
          const ang = fl.rot + (k / 5) * Math.PI * 2;
          ink.blob(fl.x + Math.cos(ang) * fl.r * 0.55, fl.y + Math.sin(ang) * fl.r * 0.55, fl.r * 0.5, { ch: CH.wet, ink: 0.07, irr: 0.25, ay: 0.7, rot: ang, seed: fl.seed + k });
        }
        ink.blob(fl.x, fl.y, fl.r * 0.22, { ch: CH.wet, ink: 0.16, irr: 0.3, seed: fl.seed + 9 });
      }
      // 她：从被子里露出吻根、小眼睛和嘴（左边），吻伸出画外
      fish.pose({ x: 560, y: 560, L: 4200, ang: -0.16, anchor: 0.354 });
      fish.drawSide(ink, { seed: 4.2, gill: 0.2 + 0.2 * Math.sin(a * 1.3), detail: 1, parts: { fins: false, tail: false }, uMax: 0.435, ink: 0.9 });
      // 被子的边：盖在她头后面——一道软的布褶（下面一层淡影，边上断续一线），不是一根管子
      const edge = spline([[820, -80], [880, 240], [830, 560], [900, 880], [860, 1180]], 8);
      ink.stroke(edge, { wt: 150, wb: 6, ink: 0.13, dry: 0.08, side: 0.95, rim: 0.4, ch: CH.wet, bsp: 12, seed: 71, cap: 3 });
      ink.stroke(edge, { w: (u) => 5 * (0.4 + 0.8 * Math.sin(Math.PI * u)) * (0.6 + 0.5 * noise1(u * 6)), ink: (u) => 0.5 * (0.5 + 0.5 * Math.max(0, noise1(u * 5 + 1) + 0.4)), dry: (u) => 0.3 + 0.3 * noise1(u * 9), ch: CH.dry, seed: 72, cap: 2 });
      ink.fill(new Float32Array([830, -120, 2600, -120, 2600, 1300, 870, 1300, 900, 880, 840, 560, 890, 240]), { ch: CH.wet, ink: 0.035, tex: 1.2, seed: 73, feather: 40 });
      // 赭石：从中间往外慢慢洇开（全片 2D 唯一的暖色）
      const w = clamp((t - T.warm) / 2.2);
      if (w > 0) {
        const cx = 1150, cy = 560;
        const rad = 1400 * (1 - Math.pow(1 - w, 1.8));
        let k = 0;
        for (let i = 0; i < GI; i++) for (let j = 0; j < GJ; j++) {
          const x = 560 + (i / (GI - 1)) * 1700, y = -60 + (j / (GJ - 1)) * 1200;
          const d = Math.hypot(x - cx, (y - cy) * 1.3) + 180 * noise1(x * 0.004 + y * 0.003 + 3.1);
          const front = clamp((rad - d) / 260);
          G[k] = x; G[k + 1] = y; G[k + 2] = 0.55 * front * (0.8 + 0.2 * noise1(x * 0.01 - y * 0.008)) * clamp((x - 860) / 120);
          k += 3;
        }
        ink.grid(G, GI, GJ, { ch: CH.ochre, tex: 1.3, seed: 5.5 });
      }
    },
  };
}
