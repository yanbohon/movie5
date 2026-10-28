// 网箱船：俯拍甲板，她侧躺着（画里最标准的鱼的样子）。一个长镜头：全身 → 量尺 → 腹中的卵 → 推近头上缝二十四针 → 摇到背上装信标 → 第一声嘀
// 人不进画：量尺自己量过去；缝针时只落下俯身的人一片淡影，伸进来的是持针钳和镊子；装信标时伸进来一只手。
import { makeView, CH } from './gl.js';
import { Fish, dorsalH } from './fish.js';
import { drawArm, handTipOffset } from './people.js';
import { spline, kf, pointAt } from './curve.js';
import { pingRings } from './common.js';
import { clamp, lerp, smooth, noise1, hash1, mulberry32 } from '../../film/util.js';

export function makeBoat(ctx, ink, T) {
  const fish = new Fish();
  const L = 2400;
  const pose = (t) => fish.pose({ x: 0, y: 0, L, ang: 0, anchor: 0.5, kappa: (u) => (u > 0.75 ? 0.05 * Math.sin(t * 0.9) : 0) });
  pose(T.boatIn);
  const PH = L / 352 * 18; // 手长 18 厘米（她 3.52 米）
  // 伤口：头顶一道口子（眼后沿头顶斜着往后划到鳃盖上）
  const woundUH = [[0.366, 0.008], [0.392, 0.0165], [0.423, 0.0225], [0.455, 0.0262], [0.486, 0.0285], [0.506, 0.029]];
  const woundPts = spline(woundUH.map(([u, h]) => fish.P(u, h)), 3);
  // 二十四针：均匀排在伤口上，每针斜跨伤口；每针的斜度、长短略有不同（手缝的）
  const stitches = T.stitches.map((ts, i) => {
    const q = pointAt(woundPts, (i + 0.5) / 24);
    const nx = -q.ty, ny = q.tx;
    const hl = 10 + 2.5 * hash1(i * 3.7 + 1), sl = 5.5 + 3 * hash1(i * 5.3 + 2);
    const a = [q.x + nx * hl - q.tx * sl, q.y + ny * hl - q.ty * sl];
    const b = [q.x - nx * hl + q.tx * sl, q.y - ny * hl + q.ty * sl];
    const bow = (hash1(i * 7.1) - 0.5) * 3;
    const m = [(a[0] + b[0]) / 2 + q.tx * bow, (a[1] + b[1]) / 2 + q.ty * bow];
    return { t: ts, a, b, m, q, nx, ny };
  });
  // 卵：腹部隐约一团小点（淡墨点，化开）
  const R = mulberry32(2203);
  const eggs = [];
  for (let i = 0; i < 190; i++) {
    const u = 0.5 + R() * 0.25, hh = -0.004 - R() * 0.038 * Math.sin(Math.PI * clamp((u - 0.495) / 0.26));
    const p = fish.P(u, hh);
    eggs.push({ x: p[0], y: p[1], r: 3.2 + R() * 3, k: 0.07 + R() * 0.12, d: Math.hypot(u - 0.62, (hh + 0.024) * 3) + R() * 0.05, seed: R() * 99 });
  }
  eggs.sort((a, b) => a.d - b.d);
  // 甲板木板：避开她的身子
  const planks = [];
  for (const y of [-930, -760, -590, -420, 330, 500, 670, 840]) {
    const segs = [];
    let x = -2300 + R() * 200;
    while (x < 2300) { const len = 500 + R() * 900; segs.push([x, x + len, R() * 50]); x += len + 60 + R() * 260; }
    planks.push({ y: y + (R() - 0.5) * 20, segs });
  }
  // 身下的水渍：几团很淡的湿墨叠在一起（像一摊摊水印在木板上）
  const puddles = [];
  for (let i = 0; i < 7; i++) {
    const u = 0.3 + i * 0.1 + R() * 0.04;
    const p = fish.P(u, (R() - 0.5) * 0.03);
    puddles.push({ x: p[0], y: p[1], r: 150 + R() * 140, ex: 120 + R() * 160, seed: R() * 50, k: 0.028 + R() * 0.02 });
  }
  // 信标的位置：背上、背鳍前
  const tagU = 0.672;
  const tagAt = () => { const p = fish.P(tagU, dorsalH(tagU) - 0.013); const p2 = fish.P(tagU + 0.03, dorsalH(tagU + 0.03) - 0.012); return { x: p[0], y: p[1], x2: p2[0], y2: p2[1] }; };
  // 镜头：全身 → 量 → 腹部 + 头（卵、第一针）→ 推到伤口 → 拉开、摇到背上的信标
  const camK = [
    [T.boatIn, [0, -170, 0.5]],
    [T.cage, [0, -130, 0.53]],
    [T.measure, [0, -70, 0.58]],
    [T.measureEnd, [40, -40, 0.61]],
    [T.eggs - 0.6, [110, 10, 0.86]],
    [T.eggs + 0.3, [80, 12, 0.95]],
    [T.stitches[5], [-90, -12, 1.3]],
    [T.stitches[10], [-150, -38, 1.95]],
    [T.stitches[14], [-160, -42, 2.3]],
    [T.stitchEnd, [-162, -45, 2.42]],
    [T.knot + 0.3, [-150, -48, 2.36]],
    [T.clip - 1.3, [300, -80, 1.42]],
    [T.clip, [405, -80, 1.3]],
    [T.pings[1] + 0.5, [420, -60, 1.1]],
    [T.riverIn + 0.9, [430, -60, 0.98]],
  ];
  const tapeY = 205;
  const tapeYAt = (x) => tapeY + 7 * Math.sin(x * 0.0037 + 0.6) + 3 * noise1(x * 0.01);
  // 捏针的手：每针 0.24 秒一个来回——扎进 a、从 b 穿出、往外一拉收线、回到下一针
  function needleAt(t) {
    const s0 = T.stitches[0];
    if (t < s0 - 0.13) {
      const k = smooth((t - (s0 - 1.3)) / 1.0);
      return { p: [lerp(stitches[0].a[0] + 160, stitches[0].a[0] - 14, k), lerp(stitches[0].a[1] - 170, stitches[0].a[1] - 16, k)], last: -1, g: 0, pull: 0 };
    }
    let i = 0;
    while (i < 23 && t >= stitches[i + 1].t - 0.13) i++;
    const st = stitches[i];
    const since = t - (st.t - 0.13);
    if (since < 0.13) {
      const g = since / 0.13;
      return { p: [lerp(st.a[0], st.b[0], g) - 14, lerp(st.a[1], st.b[1], g) - 16], last: i - 1, g, pull: 0 };
    }
    const pullOut = [st.b[0] - st.nx * 55 + 30, st.b[1] - st.ny * 55 - 70];
    if (i === 23) {
      const k = smooth((t - st.t) / 0.35);
      const k2 = smooth((t - T.knot) / 0.9);
      return { p: [lerp(st.b[0] - 14, pullOut[0], k) + 260 * k2, lerp(st.b[1] - 16, pullOut[1], k) - 420 * k2], last: 23, g: 1, pull: k };
    }
    const nx2 = stitches[i + 1];
    const ph = (since - 0.13) / 0.11;
    const out = Math.sin(Math.PI * clamp(ph));
    const base = [lerp(st.b[0], nx2.a[0], smooth(ph)) - 14, lerp(st.b[1], nx2.a[1], smooth(ph)) - 16];
    return { p: [base[0] + (pullOut[0] - st.b[0]) * 0.8 * out, base[1] + (pullOut[1] - st.b[1]) * 0.8 * out], last: i, g: 1, pull: out };
  }
  return {
    id: 'boat', t0: T.boatIn, t1: T.riverIn + 0.9, usesB: true,
    paper: [0.72, 700, 480],
    enter: { type: 2, dur: 0.75, win: [0, 0.65, 0.25, 1], seed: 6.2, soft: 0.12, dir: [1, 0.2] },
    view: (t) => { const c = kf(t, camK); return makeView(c[0], c[1], c[2], 0); },
    look: () => ({ bleed: 0.85, rim: 0.85, gran: 0.55, bmode: 0 }),
    post: () => ({ exposure: 1.0, vignette: 0.28, grain: 0.028, bloom: 0.05 }),
    draw(ink, t) {
      pose(t);
      // 网箱：顶上一根粗木梁 + 水里的网
      ink.stroke(spline([[-2500, -1015], [0, -1030], [2500, -1012]], 12), { w: 34, ink: 0.9, dry: 0.3, ch: CH.wet, seed: 3, cap: 3, bsp: 3, side: 0.5 });
      for (let k = 0; k < 16; k++) {
        const x = -2200 + k * 290;
        ink.stroke(spline([[x, -1260], [x + 60, -1140], [x + 120, -1040]], 10), { w: 3, ink: 0.3, dry: 0.4, ch: CH.dry, seed: 10 + k, cap: 1 });
        ink.stroke(spline([[x + 290, -1260], [x + 200, -1140], [x + 120, -1040]], 10), { w: 3, ink: 0.3, dry: 0.4, ch: CH.dry, seed: 40 + k, cap: 1 });
      }
      // 甲板
      for (const pl of planks) for (const [x0, x1, sd] of pl.segs) {
        ink.stroke(spline([[x0, pl.y], [(x0 + x1) / 2, pl.y + 4 * Math.sin(sd)], [x1, pl.y - 2]], 12), { w: (u) => 5 * Math.sin(Math.PI * u) + 1, ink: 0.3, dry: (u) => 0.35 + 0.3 * u, ch: CH.dry, seed: sd, cap: 1, bsp: 1.4 });
      }
      for (const pd of puddles) ink.blob(pd.x, pd.y, pd.r, { ch: CH.wet, ink: pd.k, irr: 0.32, ay: 0.55, ex: pd.ex, ey: 0, seed: pd.seed, feather: pd.r * 0.35 });
      // 她
      fish.drawSide(ink, { seed: 5.1, gill: 0.35 + 0.35 * Math.sin(t * 1.7), detail: 1 });
      // 伤口：一道深色的口子，周围一片淡墨（淤青）；缝上以后口子合拢、颜色变淡
      const closed = smooth((t - T.stitches[0]) / (T.stitchEnd - T.stitches[0]));
      ink.stroke(woundPts, { w: (u) => 52 * Math.sin(Math.PI * clamp(u * 1.05)) * (1 + 0.25 * noise1(u * 7)), ink: 0.11, dry: 0.15, ch: CH.wet, seed: 71, cap: 3, bsp: 3, rim: 0.9 });
      ink.stroke(woundPts, { w: (u) => (8 + 5 * noise1(u * 19) + 3 * Math.sin(u * 41)) * Math.pow(Math.sin(Math.PI * clamp(u * 1.04)), 0.6) * (1 - 0.5 * clamp(closed * 1.25 - u * 0.25)), ink: (u) => 1.1 + 0.4 * noise1(u * 13), dry: (u) => 0.2 + 0.3 * noise1(u * 17 + 3), ch: CH.wet, seed: 72, cap: 2, bsp: 1.2, rim: 0.6 });
      // 口子两边翻起的一点皮（细碎的干笔）
      ink.stroke(woundPts, { w: (u) => 22 * Math.sin(Math.PI * clamp(u * 1.05)), ink: 0.22 * (1 - 0.6 * closed), dry: 0.75, ch: CH.dry, seed: 73, cap: 2, bsp: 2.5 });
      // 卵（隐约）：从腹部中间往外一颗颗显出来
      const ek = clamp((t - T.eggs) / 1.6);
      if (ek > 0) {
        const n = Math.floor(eggs.length * ek);
        for (let i = 0; i < n; i++) {
          const e = eggs[i];
          const f = clamp((ek * eggs.length - i) / 25);
          ink.blob(e.x, e.y, e.r, { ch: CH.wet, ink: e.k * f * 0.75, irr: 0.2, seed: e.seed, feather: e.r * 1.2 });
        }
        ink.stroke(fish.axis(0.52, 0.73, -0.024, 12), { w: (u) => L * 0.03 * Math.sin(Math.PI * u), ink: 0.05 * ek, dry: 0.2, ch: CH.wet, seed: 77, cap: 4, rim: 0.9, bsp: 8 });
      }
      // 量尺：一条软尺从吻尖拉到尾尖（淡墨的带子、一侧一线、刻度 10 厘米一格）
      const mk = clamp((t - T.measure) / (T.measureEnd - T.measure));
      const x0 = -1200, x1 = 1200;
      const xe = lerp(x0, x1, 1 - Math.pow(1 - mk, 1.3));
      if (mk > 0) {
        const tp = [];
        for (let x = x0; x <= xe; x += 40) tp.push([x, tapeYAt(x)]);
        tp.push([xe, tapeYAt(xe)]);
        if (tp.length >= 2) {
          const tpts = spline(tp, 8);
          ink.stroke(tpts, { w: 15, ink: 0.07, dry: 0.3, ch: CH.wet, seed: 80, cap: 1, rim: 0.6 });
          const edge = spline(tp.map(([x, y]) => [x, y - 7]), 8);
          ink.stroke(edge, { w: (u) => 2.6 + 0.8 * noise1(u * 13), ink: 0.85, dry: (u) => 0.2 + 0.2 * noise1(u * 5 + 2), ch: CH.dry, seed: 81, cap: 1 });
        }
        const step = L / 3.52 / 10; // 10 厘米一格
        for (let k = 0; k <= 35; k++) {
          const x = x0 + k * step;
          if (x > xe) break;
          const len = (k % 10 === 0 ? 17 : k % 5 === 0 ? 12 : 7) * (0.9 + 0.2 * hash1(k));
          const y = tapeYAt(x) - 7;
          ink.stroke(new Float32Array([x, y, x + 0.8, y + len]), { w: k % 5 === 0 ? 2.8 : 2.0, ink: k % 5 === 0 ? 0.95 : 0.65, dry: 0.3, ch: CH.dry, seed: 82 + k, cap: 1 });
        }
        if (mk >= 1) ink.stroke(new Float32Array([x1, tapeYAt(x1) + 22, x1 + 2, tapeYAt(x1) - 40]), { w: 3.2, ink: 1.0, dry: 0.2, ch: CH.dry, seed: 120, cap: 1 });
      }
      // 缝针：朱砂红线一针一针（第 i 针在 T.stitches[i] 穿过）
      const s0 = T.stitches[0];
      if (t > s0 - 1.6 && t < T.knot + 1.6) {
        const nd = needleAt(t);
        let last = -1;
        for (let i = 0; i < 24; i++) {
          const st = stitches[i];
          const g = clamp((t - (st.t - 0.13)) / 0.13);
          if (g <= 0) break;
          const bx = lerp(st.a[0], st.b[0], g), by = lerp(st.a[1], st.b[1], g);
          const mx = lerp(st.a[0], st.m[0], Math.min(1, g * 2)), my = lerp(st.a[1], st.m[1], Math.min(1, g * 2));
          // 红线洇进湿皮肤里一点
          ink.stroke(new Float32Array([st.a[0], st.a[1], mx, my, bx, by]), { w: (u) => 2.7 * (0.9 + 0.3 * Math.exp(-u * 5) - 0.35 * u) * (1 + 0.15 * noise1(u * 5 + i)), ink: (u) => 1.8 - 0.5 * u, dry: (u) => 0.06 + 0.3 * Math.pow(u, 1.5), ch: CH.red, seed: 400 + i, cap: 2, bsp: 1 });
          // 针眼（淡）
          ink.blob(st.a[0], st.a[1], 1.4, { ch: CH.wet, ink: 0.55, irr: 0.25, seed: 500 + i });
          if (g >= 1) ink.blob(st.b[0], st.b[1], 1.3, { ch: CH.wet, ink: 0.45, irr: 0.25, seed: 600 + i });
          last = i;
        }
        // 线：从最后一针拉到捏针的指间（往外拉时绷直，回来时垂下）
        if (last >= 0 && t < T.knot + 0.05) {
          const from = stitches[last].b;
          const taut = nd.pull;
          const mid = [(from[0] + nd.p[0]) / 2 + 26 * (1 - taut), (from[1] + nd.p[1]) / 2 + 34 * (1 - taut)];
          ink.stroke(spline([from, mid, nd.p], 3), { w: 2.2, ink: 1.2, dry: 0.15, ch: CH.red, seed: 700, cap: 1 });
        }
        if (t >= T.knot) {
          const kb = stitches[23].b;
          ink.blob(kb[0], kb[1], 4.2, { ch: CH.red, ink: 1.7, irr: 0.3, seed: 710 });
          ink.stroke(spline([kb, [kb[0] + 9, kb[1] + 13], [kb[0] + 6, kb[1] + 26]], 2), { w: 1.8, ink: 1.1, dry: 0.3, ch: CH.red, seed: 711, cap: 1 });
          ink.stroke(spline([kb, [kb[0] + 15, kb[1] + 6], [kb[0] + 25, kb[1] + 16]], 2), { w: 1.8, ink: 1.0, dry: 0.3, ch: CH.red, seed: 712, cap: 1 });
        }
        // 缝的人俯在她头上：画面里只落下他一片很淡的影子（随每一针轻轻起伏）；手在画外，伸进来的是持针钳和镊子
        const come = smooth((t - (s0 - 0.9)) / 0.7), go = smooth((t - T.knot - 0.2) / 0.9);
        if (come > 0 && go < 1) {
          const p = nd.p;
          const vis = come * (1 - go);
          const bob = 8 * nd.pull;
          ink.blob(p[0] + 40, p[1] - 200 - bob, 230, { ch: CH.wet, ink: 0.07 * vis, irr: 0.25, ay: 0.7, seed: 730, feather: 160 });
          ink.blob(p[0] - 140, p[1] - 150 - bob * 0.5, 170, { ch: CH.wet, ink: 0.05 * vis, irr: 0.3, ay: 0.8, seed: 731, feather: 120 });
          // 弯针（夹在持针钳嘴里）
          if (t < T.knot + 0.3) ink.stroke(spline([[p[0] - 3, p[1] - 5], [p[0] + 9, p[1] + 9], [p[0] + 13, p[1] + 25]], 2), { w: (u) => lerp(2.2, 0.7, u), ink: 1.4, dry: 0.1, ch: CH.dry, seed: 720, cap: 1 });
          // 持针钳：两片细长的钳嘴从右上方画外伸进来，嘴尖夹着针（笔意：一笔长线，一笔短的并着）
          const hx = p[0] + 150 + 60 * go, hy = p[1] - 330 - 380 * go;
          const jaw = (off, k, sd2) => ink.stroke(spline([[p[0] - 2, p[1] - 4], [lerp(p[0], hx, 0.45) + off, lerp(p[1], hy, 0.45)], [hx + off * 2.4, hy]], 4), { w: (u) => lerp(1.6, 3.6, u) * k, ink: (u) => 1.25 * vis * (0.85 + 0.15 * u), dry: (u) => 0.12 + 0.3 * u, ch: CH.dry, seed: sd2, cap: 1 });
          jaw(-3, 1, 740); jaw(3.5, 0.7, 741);
          // 钳子的关节一点
          const jx = lerp(p[0], hx, 0.62), jy = lerp(p[1], hy, 0.62);
          ink.blob(jx, jy, 5.5, { ch: CH.dry, ink: 1.2 * vis, irr: 0.25, seed: 742 });
          // 镊子：从左上方伸进来，尖头压着伤口边（跟着针走，慢半拍）
          const lag = needleAt(Math.max(s0 - 0.13, t - 0.12)).p;
          const tx = lag[0] - 34, ty = lag[1] - 8;
          const fx = tx - 120 - 40 * go, fy = ty - 300 - 380 * go;
          for (const [off, sd2] of [[-4, 750], [4, 751]]) ink.stroke(spline([[tx, ty], [lerp(tx, fx, 0.5) + off, lerp(ty, fy, 0.5)], [fx + off * 2.2, fy]], 4), { w: (u) => lerp(1.2, 2.8, u), ink: 1.1 * vis, dry: (u) => 0.15 + 0.3 * u, ch: CH.dry, seed: sd2, cap: 1 });
        }
      }
      // 信标：一只手捏着小圆柱从上方放下，扣在背上，松手退出
      const tg = tagAt();
      const tc = clamp((t - (T.clip - 1.1)) / 1.1);
      if (tc > 0) {
        const land = smooth(tc);
        const hx = lerp(tg.x + 150, tg.x, land), hy = lerp(tg.y - 420, tg.y, land);
        const jolt = t > T.clip ? 5 * Math.exp(-(t - T.clip) * 12) * Math.sin((t - T.clip) * 60) : 0;
        const x0t = hx + (tg.x2 - tg.x) * -0.5, y0t = hy + (tg.y2 - tg.y) * -0.5 + jolt;
        const x1t = hx + (tg.x2 - tg.x) * 0.5, y1t = hy + (tg.y2 - tg.y) * 0.5 + jolt;
        // 小圆柱：一笔浓墨的圆头条子，中间一线留出的光
        ink.stroke(new Float32Array([x0t, y0t, x1t, y1t]), { wt: 13, wb: 13, ink: 1.5, dry: 0.08, side: 0.45, ch: CH.wet, seed: 800, cap: 5 });
        ink.stroke(new Float32Array([x0t + 6, y0t - 4, x1t - 6, y1t - 4]), { w: 2, ink: 0.6, dry: 0.2, ch: CH.dry, seed: 801, cap: 1 });
        // 飘带（淡墨）
        const ph = t * 3.1;
        ink.stroke(spline([[x1t, y1t], [x1t + 50, y1t + 8 + 6 * Math.sin(ph)], [x1t + 110, y1t + 2 + 10 * Math.sin(ph + 1)], [x1t + 170, y1t + 14 + 12 * Math.sin(ph + 2)]], 4), { w: (u) => lerp(9, 4, u), ink: 0.22, dry: 0.3, ch: CH.wet, seed: 802, cap: 2 });
        if (t > T.clip) {
          // 扎进背上的两道细铁丝
          ink.stroke(spline([[x0t + 10, y0t + 8], [x0t + 14, y0t + 22], [x0t + 22, y0t + 30]], 2), { w: 2, ink: 0.8, dry: 0.3, ch: CH.dry, seed: 803 });
          ink.stroke(spline([[x1t - 10, y1t + 8], [x1t - 6, y1t + 22], [x1t, y1t + 30]], 2), { w: 2, ink: 0.8, dry: 0.3, ch: CH.dry, seed: 804 });
        }
        const go = smooth((t - T.clip - 0.25) / 1.0);
        const pinch = 1 - smooth((t - T.clip - 0.05) / 0.2);
        const dirT = Math.PI / 2 + 0.3, ot = handTipOffset(dirT, PH, 1, 0.3, pinch);
        const tip = [lerp((x0t + x1t) / 2, tg.x + 60, go), lerp((y0t + y1t) / 2 - 8, tg.y - 520, go)];
        const w = [tip[0] - ot[0], tip[1] - ot[1]];
        drawArm(ink, { sx: w[0] - 150, sy: w[1] - 600, x: w[0], y: w[1], P: PH, elbow: 1, ink: 0.7 * (1 - 0.3 * go), seed: 220, hand: { dir: dirT, grip: 0.3, pinch, side: 1 } });
      }
      // 嘀：每 2 秒从信标荡开一圈淡淡的同心圆
      for (const tt of T.pings) {
        const age = t - tt;
        if (age < 0 || age > 3) continue;
        pingRings(ink, tg.x + 20, tg.y, age, { rMax: 620, rMin: 20, ink: 0.5, w: 7, seed: tt });
      }
    },
  };
}
