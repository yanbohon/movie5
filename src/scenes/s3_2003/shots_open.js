// 开头三个镜头：日期卡 → 网 → 天
import { makeView, CH } from './gl.js';
import { Fish, swimKappa, dorsalH, ventralH } from './fish.js';
import { spline } from './curve.js';
import { makeSplatter, drawSplatter, washBand, ring } from './common.js';
import { clamp, lerp, smooth, noise1, hash1, mulberry32 } from '../../film/util.js';

// ---------------------------------------------------------------- 日期卡
export function makeDate(ctx, ink, T) {
  // 纸上小楷（霞鹜文楷），竖排两行：二〇〇三年一月二十四日 ／ 宜宾（落款式，靠下）
  const TW = 220, TH = 640, size = 40, lh = 52;
  const Lr = ctx.layer(TW, TH, { srgb: false, premult: true });
  const g = Lr.g;
  g.clear();
  g.noStroke(); g.fill(0);
  g.textFont(ctx.FONTS.kai); g.textSize(size); g.textAlign(g.CENTER, g.CENTER);
  const col1 = Array.from('二〇〇三年一月二十四日'), col2 = Array.from('宜宾');
  col1.forEach((ch, i) => g.text(ch, 150, 40 + i * lh));
  col2.forEach((ch, i) => g.text(ch, 72, 40 + (col1.length - col2.length + i) * lh));
  Lr.tex.needsUpdate = true;
  const x = 1010, y = 232;
  // 通道映射：字的 alpha → 干墨（淡墨）+ 一点湿墨（让边缘有一点洇）
  const MAP = [0, 0, 0, 0.16, 0, 0, 0, 0.56, 0, 0, 0, 0, 0, 0, 0, 0];
  return {
    id: 'date', t0: T.start, t1: T.dateOut + 0.9,
    paper: [1, 120, 60],
    enter: null,
    view: (t) => makeView(960, 540, 1 + 0.018 * clamp((t - T.start) / 4.5)),
    look: () => ({ bleed: 0.85, rim: 0.7, gran: 0.5 }),
    post: () => ({ exposure: 1, vignette: 0.26, grain: 0.028, bloom: 0.04 }),
    draw(ink, t) {
      const rev = clamp((t - T.dateIn) / 1.1);
      ink.image(Lr.tex, x, y, TW, TH, { map: MAP, reveal: rev, seed: 3.7 });
    },
  };
}

// ---------------------------------------------------------------- 网
export function makeNet(ctx, ink, T) {
  const fish = new Fish();
  const L = 1180;
  const R = mulberry32(2003);
  // 网帘：手画的菱形网，线距不匀、有粗有细、边缘渐隐（不是一块规整的铁丝网）
  const netX0 = 1180, netX1 = 1760, netY0 = 20, netY1 = 1060;
  const NA = 16, NB = 18;
  const offA = [], offB = [];
  for (let i = 0; i < 40; i++) { offA.push((R() - 0.5) * 0.5); offB.push((R() - 0.5) * 0.5); }
  const thr = [];
  for (let i = 0; i < 80; i++) thr.push({ ink: 0.6 + R() * 0.7, w: 0.7 + R() * 0.7, dry: 0.15 + R() * 0.4, cut0: R() * 0.25, cut1: 1 - R() * 0.25, seed: R() * 100 });
  const splats = T.thrash.map((t, i) => makeSplatter(700 + i * 13, 22 + (i % 2) * 8, { dir: (i % 2 ? -1.1 : -2.1) + (R() - 0.5) * 0.4, spread: 2.2, dist: 150 + i * 20, size: 6 + (i % 3) * 1.5 }));
  const impactSplat = makeSplatter(911, 26, { dir: -0.3, spread: 2.8, dist: 120, size: 5.5 });
  const surfY = 70;
  const tipImpact = [netX0 + 30, 560];
  const thrashAt = (t) => T.thrash.reduce((s, tt, i) => s + (t > tt ? Math.exp(-(t - tt) * 2.6) * Math.sin((t - tt) * 11 + (i % 2) * Math.PI) : 0), 0);
  // 她的位置：撞网前滑进来，撞上去往前一顶，被网兜住挣扎（整条身子弓起来甩），最后被往上拖
  function pose(t) {
    const ti = T.impact;
    let tipX, tipY = tipImpact[1], ang = -0.04, kap;
    if (t < ti) {
      const d = ti - t;
      tipX = tipImpact[0] - 360 * d;
      tipY = tipImpact[1] + 20 * Math.sin(d * 1.3);
      kap = swimKappa(t, { amp: 0.9, freq: 1.2, wl: 0.95 });
    } else {
      const a = t - ti;
      tipX = tipImpact[0] + 80 * (1 - Math.exp(-a * 7)) - 50 * clamp((a - 0.25) / 0.6);
      const th = thrashAt(t);
      ang = -0.04 + 0.22 * th;
      tipY = tipImpact[1] + 50 * th;
      const bend = 1.9 * th + 0.5 * Math.sin(a * 17) * clamp(a / 0.2) * Math.exp(-a * 0.5);
      kap = (u) => (u > 0.34 ? bend * (0.5 + 0.8 * (u - 0.34)) : 0) + swimKappa(t, { amp: 1.4 * clamp(a / 0.15), freq: 3.0, wl: 0.7 })(u);
    }
    const haul = clamp((t - T.haul) / (T.sky - T.haul));
    const up = -520 * haul * haul;
    fish.pose({ x: tipX, y: tipY + up, L, ang: Math.PI + ang, anchor: 0, kappa: kap, ds: -1 });
    return { tipX, tipY: tipY + up, haul, up };
  }
  // 网帘上一点（a 沿 A 方向 0..1，b 沿 B 方向 0..1）：斜网格 + 水流摆动 + 撞点附近往前鼓
  function curtain(a, b, t, st) {
    const u = a, v = b;
    let x = lerp(netX0, netX1, 0.5 + (u - v) * 0.5) + 60 * (u + v - 1);
    let y = lerp(netY0, netY1, (u + v) * 0.5);
    x += 16 * Math.sin(t * 1.1 + y * 0.004 + u * 3) + 6 * noise1(u * 13 + v * 7);
    y += 6 * noise1(u * 9 - v * 11 + 3);
    const ai = t - T.impact;
    if (ai > 0) {
      const dx = x - tipImpact[0], dy = y - tipImpact[1];
      const d2 = (dx * dx) / (170 * 170) + (dy * dy) / (240 * 240);
      x += 120 * Math.exp(-d2) * (1 - Math.exp(-ai * 6));
    }
    return [x, y + st.up * 0.9];
  }
  return {
    id: 'net', t0: T.dateOut - 0.15, t1: T.sky + 0.3,
    paper: [1, 420, 260],
    enter: { type: 0, dur: 1.05, win: [0, 0.55, 0.25, 1], seed: 4.1, soft: 0.1 },
    view(t) {
      const ai = t - T.impact;
      const shake = (tt, amp) => (t > tt ? amp * Math.exp(-(t - tt) * 9) : 0);
      let sh = shake(T.impact, 12);
      for (const tt of T.thrash) sh += shake(tt, 6);
      const sx = sh * Math.sin(t * 71), sy = sh * Math.cos(t * 53);
      const haul = clamp((t - T.haul) / (T.sky - T.haul));
      return makeView(960 + 30 * clamp(ai), 540 - 300 * haul * haul, 1.0 + 0.04 * clamp((t - T.dateOut) / 1.5) + 0.05 * clamp(ai), 0.01 * Math.sin(t * 0.7), sx, sy);
    },
    look: () => ({ bleed: 0.95, rim: 0.9, gran: 0.6 }),
    post: (t) => ({ exposure: 1 + 0.25 * smooth((t - T.sky + 0.3) / 0.3), vignette: 0.3, grain: 0.03, bloom: 0.05 }),
    draw(ink, t) {
      const st = pose(t);
      const ai = t - T.impact;
      // 水：几道极淡的横墨，慢慢往下游漂
      const drift = (t - T.start) * 18;
      washBand(ink, -200 + drift, 2300 + drift, 330, 90, { ink: 0.07, seed: 1.1, sag: 20 });
      washBand(ink, -300 + drift * 0.8, 2100 + drift * 0.8, 690, 130, { ink: 0.085, seed: 2.3, sag: -25, dry: 0.45 });
      washBand(ink, -100 + drift * 1.2, 2400 + drift * 1.2, 930, 160, { ink: 0.11, seed: 3.5, sag: 10, dry: 0.5 });
      const surfPts = spline([[-400, surfY + 6], [700, surfY - 4], [1500, surfY + 5], [2600, surfY - 3]], 10);
      ink.stroke(surfPts, { w: 3.5, ink: 0.35, dry: 0.45, ch: CH.dry, seed: 9.1, cap: 0 });
      // 网帘：撞上以后慢慢被扯过去、淡出（剩下的网都裹到她身上）
      const fadeC = 1 - 0.85 * smooth((ai - 0.2) / 0.6);
      const edge = (a, b) => smooth(a / 0.18) * smooth((1 - a) / 0.18) * smooth(b / 0.15) * smooth((1 - b) / 0.15);
      const lineOf = (fixed, isA, k) => {
        const pts = []; const inks = [];
        const tr = thr[k % thr.length];
        for (let q = 0; q <= 22; q++) {
          const w = lerp(tr.cut0, tr.cut1, q / 22);
          const a = isA ? fixed : w, b = isA ? w : fixed;
          pts.push(curtain(a, b, t, st)); inks.push(edge(a, b));
        }
        const poly = spline(pts, 8);
        ink.stroke(poly, { w: (u) => 2.8 * tr.w * (0.7 + 0.3 * Math.sin(u * 13 + tr.seed)), ink: (u) => 0.5 * tr.ink * fadeC * inks[Math.min(22, Math.round(u * 22))], dry: tr.dry, ch: CH.dry, seed: tr.seed, cap: 1, bsp: 1.1 });
      };
      for (let i = 0; i < NA; i++) lineOf(clamp((i + 0.5 + offA[i]) / NA), true, i);
      for (let j = 0; j < NB; j++) lineOf(clamp((j + 0.5 + offB[j]) / NB), false, j + 40);
      // 网结
      for (let i = 1; i < NA; i += 2) for (let j = 1; j < NB; j += 2) {
        const a = (i + 0.5) / NA, b = (j + 0.5) / NB, e = edge(a, b);
        if (e < 0.2 || hash1(i * 31 + j) < 0.4) continue;
        const p = curtain(a, b, t, st);
        ink.blob(p[0], p[1], 3.2, { ch: CH.dry, ink: 0.9 * e * fadeC, irr: 0.3, seed: i + j * 7 });
      }
      // 她
      fish.drawSide(ink, { seed: 1.3, gill: ai > 0 ? 0.5 + 0.5 * Math.sin(t * 11) : 0.2, mouth: ai > 0 ? 0.6 : 0, detail: 0.6 });
      // 网收拢：一道道网线从外面裹上来，越收越紧，贴着她的身子（从头往尾裹）
      if (ai > 0.05) {
        const tight = smooth((t - T.netShut + 0.5) / 0.9);
        const nW = 15;
        for (let k = 0; k < nW; k++) {
          for (const dirK of [1, -1]) {
            const u0 = 0.22 + (k / (nW - 1)) * 0.74;
            const appear = smooth((ai - 0.05 - k * 0.05) / 0.3);
            if (appear <= 0) continue;
            const bow = lerp(0.05, 0.008, tight) * (0.7 + 0.6 * hash1(k * 3 + dirK));
            const du = 0.07 * dirK;
            const uA = clamp(u0 - du * 0.5, 0.02, 1), uB = clamp(u0 + du * 0.5, 0.02, 1);
            const pA = fish.P(uA, dorsalH(uA) + bow), pM = fish.P((uA + uB) / 2, (dorsalH(uA) - ventralH(uB)) * 0.5 + 0.004 * dirK), pB = fish.P(uB, -ventralH(uB) - bow);
            const ext = 0.025 * (1 - tight);
            const pA2 = fish.P(uA - du * 0.3, dorsalH(uA) + bow + ext), pB2 = fish.P(uB + du * 0.3, -ventralH(uB) - bow - ext);
            ink.stroke(spline([pA2, pA, pM, pB, pB2], 6), { w: (u) => 2.6 * (0.6 + 0.4 * Math.sin(u * Math.PI)), ink: (0.3 + 0.5 * tight) * appear, dry: 0.3, ch: CH.dry, seed: 200 + k * 2 + (dirK > 0 ? 0 : 1), cap: 1, bsp: 1.1 });
          }
        }
        // 网口收成一束，往上被拖（网纲）
        const head = fish.P(0.3, 0.02);
        const gather = [head[0] + 40, head[1] - 60 - 120 * tight];
        for (let k = 0; k < 4; k++) {
          const from = fish.P(0.25 + k * 0.17, dorsalH(0.25 + k * 0.17) + 0.012);
          const top = [gather[0] + (k - 1.5) * 8, gather[1] - 400];
          const appear = smooth((t - T.haul + 0.2) / 0.4);
          ink.stroke(spline([from, [lerp(from[0], gather[0], 0.6), lerp(from[1], gather[1], 0.6) - 20], gather, top], 8), { w: 2.4, ink: 0.45 * appear, dry: 0.4, ch: CH.dry, seed: 300 + k, cap: 1 });
        }
      }
      // 撞上去：一团浑水（墨晕）慢慢化开
      if (ai > 0) {
        const tp = fish.P(0.02, 0);
        for (let k = 0; k < 4; k++) {
          const r = 60 + 240 * (1 - Math.exp(-ai * (1.4 + k * 0.3)));
          ink.blob(tp[0] - 60 - k * 130, tp[1] + (k - 1.5) * 40, r, { ch: CH.wet, ink: 0.06 * Math.exp(-ai * 0.8) * (1 - k * 0.15), irr: 0.35, seed: 30 + k });
        }
        drawSplatter(ink, impactSplat, tp[0] + 10, tp[1], ai, { ink: 0.8, scale: 1.0, fly: 0.1 });
      }
      // 甩尾甩出去的墨点
      T.thrash.forEach((tt, i) => {
        const age = t - tt;
        if (age < 0) return;
        const src = fish.P(i % 2 ? 0.93 : 0.6, i % 2 ? 0.03 : 0.05);
        drawSplatter(ink, splats[i], src[0], src[1], age, { ink: 0.9, scale: 1.0, fly: 0.11 });
      });
    },
  };
}

// ---------------------------------------------------------------- 天
export function makeSky(ctx, ink, T) {
  const drops = [];
  const R = mulberry32(188);
  for (let i = 0; i < 6; i++) drops.push({ x: 150 + R() * 800, y0: 420 + R() * 380, v: 40 + R() * 70, r: 12 + R() * 16, t0: 0.4 + R() * 2.5, seed: R() * 50 });
  const burst = [];
  for (let i = 0; i < 9; i++) burst.push({ a: -Math.PI / 2 + (R() - 0.5) * 2.6, d: 300 + R() * 500, r: 70 + R() * 110, seed: R() * 40 });
  // 探进来的人：头 + 帽子 + 肩（从她的眼睛往上看，逆光的黑影）
  function person(ink, x, y, s, tilt, k, sd, hat) {
    // 逆光的人俯身往下看：脸（一团墨，看不清五官）、头顶的帽子或头发、后面是肩和身子一直伸到画外
    const rot = (px, py) => [x + (px - x) * Math.cos(tilt) - (py - y) * Math.sin(tilt), y + (px - x) * Math.sin(tilt) + (py - y) * Math.cos(tilt)];
    const poly = (pts) => { const P = new Float32Array(pts.length * 2); pts.forEach((p, i) => { const q = rot(p[0], p[1]); P[2 * i] = q[0]; P[2 * i + 1] = q[1]; }); return P; };
    // 肩和身子（离镜头远一点，淡一点）
    ink.fill(poly([[x - s * 1.1, y - s * 0.9], [x - s * 3.6, y - s * 2.2], [x - s * 4.2, y - s * 6], [x + s * 4.2, y - s * 6], [x + s * 3.6, y - s * 2.2], [x + s * 1.1, y - s * 0.9]]), { ch: CH.wet, ink: 1.0 * k, tex: 0.6, seed: sd + 2, feather: s * 0.5 });
    // 脖子
    ink.fill(poly([[x - s * 0.45, y - s * 0.6], [x - s * 0.55, y - s * 1.3], [x + s * 0.55, y - s * 1.3], [x + s * 0.45, y - s * 0.6]]), { ch: CH.wet, ink: 1.1 * k, tex: 0.5, seed: sd + 3, feather: s * 0.25 });
    // 脸：略扁的一团
    const face = [];
    for (let i = 0; i < 28; i++) { const a = (i / 28) * Math.PI * 2; face.push([x + Math.cos(a) * s * 0.86 * (1 + 0.04 * Math.sin(a * 3 + sd)), y + Math.sin(a) * s * (a > 0 && a < Math.PI ? 1.1 : 0.95)]); }
    ink.fill(poly(face), { ch: CH.wet, ink: 1.35 * k, tex: 0.5, seed: sd, feather: s * 0.3 });
    // 耳朵两点
    for (const sg of [-1, 1]) { const e = rot(x + sg * s * 0.9, y - s * 0.05); ink.blob(e[0], e[1], s * 0.2, { ch: CH.wet, ink: 1.1 * k, irr: 0.2, seed: sd + 5 + sg, feather: s * 0.12 }); }
    if (hat) {
      // 帽子：比头宽的一片（离镜头更远，在头的「上」边），帽檐朝我们这边压一道深
      const cap = [];
      for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; cap.push([x + Math.cos(a) * s * 1.35, y - s * 0.75 + Math.sin(a) * s * 0.55]); }
      ink.fill(poly(cap), { ch: CH.wet, ink: 1.25 * k, tex: 0.5, seed: sd + 7, feather: s * 0.3 });
    } else {
      // 头发：头顶一圈蓬松的墨
      for (let i = 0; i < 7; i++) {
        const a = Math.PI * (1.1 + 0.8 * (i / 6));
        const p0 = rot(x + Math.cos(a) * s * 0.8, y + Math.sin(a) * s * 0.9), p1 = rot(x + Math.cos(a) * s * 1.12, y + Math.sin(a) * s * 1.2);
        ink.stroke(new Float32Array([p0[0], p0[1], p1[0], p1[1]]), { w: (u) => s * 0.22 * (1 - 0.7 * u), ch: CH.wet, ink: 1.1 * k, dry: 0.3, seed: sd + 10 + i, cap: 2 });
      }
    }
  }
  return {
    id: 'sky', t0: T.sky, t1: T.shoreIn + 0.95,
    paper: [1, 900, 420],
    enter: { type: 3, dur: 0.3, win: [0, 0.5, 0, 0.6], seed: 7.7, soft: 0.12, dir: [960, 540, 1.3] },
    view: (t) => makeView(960 + 25 * clamp((t - T.sky) / 4), 540 - 12 * clamp((t - T.sky) / 4), 1.0 + 0.03 * clamp((t - T.sky) / 4), 0.012 * Math.sin((t - T.sky) * 0.6)),
    look(t) {
      const a = t - T.sky;
      return { bleed: 1.0, rim: 0.4, gran: 0.3, defocus: 0.85 + 0.15 * Math.exp(-a * 1.2) - 0.2 * smooth((t - T.faces) / 1.0), white: 0.62 - 0.32 * smooth((t - T.faces) / 1.2) };
    },
    post(t) {
      const a = t - T.sky;
      const flash = 0.8 * Math.exp(-a * 3.0);
      return { exposure: 1.32 + flash - 0.22 * smooth((t - T.faces) / 1.5), vignette: 0.2, grain: 0.022, bloom: 0.15 };
    },
    draw(ink, t) {
      const a = t - T.sky;
      // 出水那一下：一团水花从下面炸开，很快化掉
      for (const b of burst) {
        const e = 1 - Math.exp(-a * 5);
        const k = Math.exp(-a * 2.2) * clamp(a / 0.05);
        if (k < 0.01) continue;
        ink.blob(960 + Math.cos(b.a) * b.d * e, 1060 + Math.sin(b.a) * b.d * e, b.r * (0.6 + 0.6 * e), { ch: CH.wet, ink: 0.22 * k, irr: 0.3, seed: b.seed });
      }
      // 淡淡的日轮：圈里留白，外面一圈极淡的晕
      const sun = clamp((t - T.sun) / 1.8);
      if (sun > 0) {
        // 极淡的一轮：一圈若有若无的淡墨线，外面一片更淡的晕
        ring(ink, 1250, 320, 92, { ink: 0.16 * sun, w: 12, ch: CH.wet, dry: 0.08, seed: 5.5, wob: 0.012, arc: 0.97, cap: 2 });
        ink.blob(1250, 320, 180, { ch: CH.wet, ink: 0.045 * sun, irr: 0.1, seed: 6.5, feather: 130 });
      }
      // 眼前的网（很近、很虚的一片菱形），慢慢被拖着走
      // 网线松松地垂着、晃着（不是尺子画的斜线），近的粗、远的细，线与线交处一个结
      const drift = a * 22, sway = 18 * Math.sin(a * 1.3);
      const strands = [];
      for (let k = 0; k < 5; k++) {
        const o = k * 150 - drift + 14 * Math.sin(k * 2.1);
        const sag = 40 + 30 * Math.sin(k * 1.7 + a * 0.9);
        strands.push({ p: spline([[-200 + o, 1150], [260 + o + sway, 830 + sag], [760 + o * 0.9, 520 + sag * 0.3]], 12), w: 17 - k * 1.5, k: 0.3 - k * 0.02, seed: 20 + k });
        const sag2 = 35 + 25 * Math.sin(k * 2.3 + a * 1.1);
        strands.push({ p: spline([[-300 + o * 1.05, 700], [160 + o + sway * 0.7, 900 + sag2], [620 + o, 1180]], 12), w: 15 - k * 1.2, k: 0.26 - k * 0.02, seed: 40 + k });
      }
      for (const st of strands) ink.stroke(st.p, { w: (u) => st.w * (0.7 + 0.5 * u) * (1 + 0.2 * noise1(u * 6 + st.seed)), ink: (u) => st.k * (0.7 + 0.3 * noise1(u * 4 + st.seed)), dry: 0.12, ch: CH.wet, seed: st.seed, cap: 5 });
      // 眼前的水珠往下淌
      for (const d of drops) {
        const tt = a - d.t0;
        if (tt < 0) continue;
        const y = d.y0 + d.v * tt + 25 * tt * tt;
        ink.blob(d.x, y, d.r, { ch: CH.wet, ink: 0.2 * Math.min(1, tt * 3) * Math.max(0, 1 - tt / 3.2), irr: 0.12, ey: -d.r * 1.2, seed: d.seed });
      }
      // 岸上的人探头进来（逆光的黑影，虚）
      if (t > T.faces) {
        const ppl = [[1500, 300, 150, 0.35, 0, 1], [470, 250, 135, -0.4, 0.25, 0], [1030, 190, 120, 0.05, 0.45, 1]];
        ppl.forEach(([x, y, s, tilt, dl, hat], i) => {
          const k = smooth((t - T.faces - dl) / 0.75);
          if (k <= 0) return;
          person(ink, x + tilt * 200 * (1 - k), y - 420 * (1 - k) + 10 * Math.sin((t - T.faces) * 1.1 + i), s, tilt, k, 60 + i * 5, hat);
        });
      }
    },
  };
}
