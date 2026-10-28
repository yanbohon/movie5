// 后段：放流（俯视江面，一笔水痕）→ 夜（跟踪船的灯、声呐的圈、触礁）→ 等（黑里只剩她的轮廓）→ 墨洇开
import { makeView, CH } from './gl.js';
import { Fish } from './fish.js';
import { drawTopPerson, drawFigure } from './people.js';
import { spline, kf } from './curve.js';
import { pingRings, ring, makeSplatter, drawSplatter } from './common.js';
import { PING_RING } from './events.js';
import { clamp, lerp, smooth, noise1, mulberry32 } from '../../film/util.js';

// 把折线按弧长均匀重采样，返回 {pts, S(累计弧长), total}
function arcTable(pts) {
  const n = pts.length >> 1, S = new Float32Array(n);
  for (let i = 1; i < n; i++) S[i] = S[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  return { pts, S, total: S[n - 1], n };
}
function atS(tb, s) {
  const { pts, S, n } = tb;
  s = clamp(s, 0, tb.total);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  const a = (s - S[lo]) / Math.max(1e-6, S[hi] - S[lo]);
  const x = pts[2 * lo] + (pts[2 * hi] - pts[2 * lo]) * a, y = pts[2 * lo + 1] + (pts[2 * hi + 1] - pts[2 * lo + 1]) * a;
  const tx = pts[2 * hi] - pts[2 * lo], ty = pts[2 * hi + 1] - pts[2 * lo + 1], tl = Math.hypot(tx, ty) || 1;
  return { x, y, tx: tx / tl, ty: ty / tl, i: lo };
}
function subPath(tb, s0, s1) {
  const out = [];
  const a = atS(tb, s0); out.push(a.x, a.y);
  for (let i = 0; i < tb.n; i++) if (tb.S[i] > s0 && tb.S[i] < s1) out.push(tb.pts[2 * i], tb.pts[2 * i + 1]);
  const b = atS(tb, s1); out.push(b.x, b.y);
  return new Float32Array(out);
}

// ---------------------------------------------------------------- 放流（俯视）
// 身体沿着游过的路径摆（像蛇沿着自己的轨迹走），再叠一点横摆
function poseAlong(fish, tb, sHead, L, t, amp) {
  const N = fish.N;
  const p0 = atS(tb, 0);
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    const s = sHead - u * L;
    let x, y, tx, ty;
    if (s >= 0) { const p = atS(tb, s); x = p.x; y = p.y; tx = p.tx; ty = p.ty; }
    else { x = p0.x + p0.tx * s; y = p0.y + p0.ty * s; tx = p0.tx; ty = p0.ty; }
    const nx = -ty, ny = tx; // 脊线方向是 -切线，左法向
    const env = clamp((u - 0.38) / 0.62);
    const lat = amp * L * 0.07 * env * env * Math.sin(2 * Math.PI * (u / 0.9 - 1.9 * t));
    fish.px[i] = x + nx * lat; fish.py[i] = y + ny * lat;
    fish.nx[i] = nx; fish.ny[i] = ny;
  }
  fish.L = L; fish.ds = 1;
}

export function makeRiver(ctx, ink, T) {
  const fish = new Fish();
  const L = 260;
  const R = mulberry32(2236);
  // 江水：极淡的横纹，往下游（右）漂
  const currents = [];
  for (let i = 0; i < 46; i++) currents.push({ y: -520 + R() * 1250, x0: -1900 + R() * 3600, len: 180 + R() * 700, ink: 0.035 + R() * 0.06, w: 1.6 + R() * 2.6, seed: R() * 90, bow: (R() - 0.5) * 14 });
  // 她的放流轨迹：从船边入水，往下游（右）游几十米，在下游兜一个弯，转身往上游（左）去
  const path = spline([[-420, 448], [-160, 420], [200, 372], [560, 330], [860, 282], [1080, 214], [1196, 120], [1186, 22], [1090, -50], [900, -92], [600, -112], [240, -118], [-160, -114], [-620, -104], [-1200, -96], [-1900, -90], [-2700, -86]], 4);
  const tb = arcTable(path);
  let sApex = 0, bx = -1e9;
  for (let i = 0; i < tb.n; i++) if (tb.pts[2 * i] > bx) { bx = tb.pts[2 * i]; sApex = tb.S[i]; }
  // 速度曲线积分成 s(t)：入水先愣一下再发力；进弯减速，转过身后稳稳地往上游走
  const tEnd = T.nightIn + 1.3, DT = 1 / 120;
  const rampA = (t) => smooth((t - T.release - 0.15) / 0.8) * (1 - 0.4 * smooth((t - (T.turn - 0.9)) / 0.8));
  let raw = 0;
  for (let t = T.release; t < T.turn; t += DT) raw += rampA(t) * DT;
  const V1 = sApex / raw, V2 = 520;
  const sTab = [];
  let sAcc = 0;
  for (let t = T.release; t <= tEnd + DT; t += DT) {
    sTab.push(t, sAcc);
    const v = t < T.turn ? V1 * rampA(t) : V2 * (0.62 + 0.38 * smooth((t - T.turn) / 1.0)) + (V1 * rampA(T.turn) - V2 * 0.62) * Math.exp(-(t - T.turn) * 3);
    sAcc += v * DT;
  }
  const nTab = sTab.length >> 1;
  const sAt = (t) => {
    if (t <= T.release) return 0;
    const f = (t - T.release) / DT, i = Math.min(nTab - 2, Math.floor(f)), a = f - i;
    return sTab[2 * i + 1] + (sTab[2 * i + 3] - sTab[2 * i + 1]) * a;
  };
  // s → 她游过这里的时刻（算这一段水痕的「年纪」）
  const tAtS = (s) => {
    let lo = 0, hi = nTab - 1;
    if (s <= 0) return T.release;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sTab[2 * m + 1] <= s) lo = m; else hi = m; }
    return sTab[2 * lo];
  };
  const splash = makeSplatter(4455, 34, { dir: -Math.PI / 2, spread: 6.2, dist: 70, size: 6 });
  // 一整条小船（俯视）：船头朝上游（左），中间一截竹篷；船身 620 长（约 8 米）
  const BX = -640, BY = 568;
  const B = (x, y) => [BX + x, BY + y];
  const gunTop = spline([B(-318, 4), B(-240, -52), B(-80, -76), B(160, -74), B(300, -62)], 6);
  const gunBot = spline([B(-318, 4), B(-236, 58), B(-80, 80), B(160, 78), B(300, 66)], 6);
  const transom = spline([B(300, -62), B(308, 0), B(300, 66)], 6);
  const gunIn1 = spline([B(-270, -18), B(-200, -44), B(-80, -60), B(160, -58), B(286, -48)], 6);
  const gunIn2 = spline([B(-270, 22), B(-200, 48), B(-80, 64), B(160, 62), B(286, 52)], 6);
  const hull = spline([B(-318, 4), B(-240, -52), B(-80, -76), B(160, -74), B(300, -62), B(308, 0), B(300, 66), B(160, 78), B(-80, 80), B(-236, 58)], 8, true);
  const shade = spline([B(-300, 30), B(-220, 84), B(-60, 106), B(170, 104), B(318, 92)], 8);
  const canopy = spline([B(-40, -62), B(150, -60), B(156, 60), B(-40, 64)], 6, true);
  return {
    id: 'river', t0: T.riverIn, t1: T.nightIn + 1.15,
    paper: [1, 1600, 300],
    enter: { type: 0, dur: 0.9, win: [0, 0.55, 0.3, 1], seed: 9.2, soft: 0.1 },
    view: (t) => {
      const c = kf(t, [[T.riverIn, [-560, 430, 1.08]], [T.release, [-500, 420, 1.05]], [T.release + 1.6, [-60, 330, 0.88]], [T.turn, [170, 250, 0.78]], [T.upstream, [140, 220, 0.77]], [tEnd, [0, 200, 0.76]]]);
      return makeView(c[0], c[1], c[2], 0);
    },
    look: (t) => ({ bleed: 0.95, rim: 0.85, gran: 0.55, night: smooth((t - T.nightIn) / 0.9), nightDen: 2.4, nightStreak: 0.6, nightIn: clamp((t - T.nightIn) / 0.9) }),
    post: (t) => ({ exposure: 1.0 - 0.1 * smooth((t - T.nightIn) / 0.9), vignette: 0.26 + 0.15 * smooth((t - T.nightIn) / 0.9), grain: 0.028, bloom: 0.04 }),
    draw(ink, t) {
      const a = t - T.riverIn;
      for (const c of currents) {
        const x = c.x0 + a * 34;
        ink.stroke(spline([[x, c.y], [x + c.len * 0.5, c.y + c.bow], [x + c.len, c.y - 2]], 10), { w: (u) => c.w * Math.sin(Math.PI * u), ink: c.ink, dry: 0.55, ch: CH.dry, seed: c.seed, cap: 1 });
      }
      // 船（俯视）：船底下水面一道淡影；舱里一层淡墨；两舷侧锋、船尾一笔；竹篷一片墨、几道篷骨；横梁
      ink.stroke(shade, { w: (u) => 26 * Math.sin(Math.PI * clamp(u * 1.1)), ink: 0.08, dry: 0.2, ch: CH.wet, seed: 18, cap: 2, bsp: 5, rim: 0.8 });
      ink.fill(hull, { ch: CH.wet, ink: 0.1, tex: 1.2, seed: 19, feather: 10 });
      ink.stroke(gunTop, { w: (u) => (7 + 7 * Math.sin(Math.PI * clamp(u * 1.1))) * (1 + 0.15 * noise1(u * 9)), ink: (u) => 1.2 - 0.3 * u, dry: (u) => 0.12 + 0.3 * u + 0.12 * noise1(u * 13), side: 0.6, ch: CH.wet, seed: 11, cap: 3, bsp: 2, rim: 0.5 });
      ink.stroke(gunBot, { w: (u) => (6 + 6 * Math.sin(Math.PI * clamp(u * 1.1))) * (1 + 0.15 * noise1(u * 7 + 3)), ink: (u) => 1.0 - 0.25 * u, dry: (u) => 0.18 + 0.3 * u, side: -0.6, ch: CH.wet, seed: 13, cap: 3, bsp: 2 });
      ink.stroke(transom, { w: 9, ink: 0.95, dry: 0.3, ch: CH.wet, seed: 16, cap: 2, bsp: 2 });
      ink.stroke(gunIn1, { w: 3, ink: 0.45, dry: 0.45, ch: CH.dry, seed: 12, cap: 1 });
      ink.stroke(gunIn2, { w: 3, ink: 0.4, dry: 0.45, ch: CH.dry, seed: 15, cap: 1 });
      ink.fill(canopy, { ch: CH.wet, ink: 0.42, tex: 1.4, seed: 20, feather: 6 });
      for (let k = 0; k < 6; k++) { const x = -30 + k * 36; ink.stroke(spline([B(x, -60), B(x + 6, 0), B(x, 62)], 6), { w: 3.2, ink: 0.75, dry: 0.4, ch: CH.dry, seed: 24 + k, cap: 1 }); }
      for (const x of [-190, 230]) ink.stroke(spline([B(x, -58), B(x + 3, 0), B(x, 60)], 6), { w: 8, ink: 0.55, dry: 0.4, side: 0.4, ch: CH.dry, seed: 30 + x, cap: 1 });

      const s = sAt(t);
      const swimAmp = t < T.release ? 0.25 + 0.2 * Math.sin(t * 3.1) : 1.0 + 0.5 * Math.exp(-(t - T.release) * 1.1);
      poseAlong(fish, tb, s, L, t, swimAmp);
      // 两个人俯在上舷把她托在水里，一个人在船尾看；「放吧」之后松手，直起身
      const up = smooth((t - T.release - 0.15) / 1.2);
      const held = t < T.release + 0.05;
      const hA = held ? fish.P(0.5, 0.03) : [lerp(-560, -575, up), lerp(470, 520, up)];
      const hA2 = held ? fish.P(0.6, -0.03) : [lerp(-520, -515, up), lerp(475, 525, up)];
      const hB = held ? fish.P(0.78, 0.03) : [lerp(-660, -670, up), lerp(470, 522, up)];
      const hB2 = held ? fish.P(0.86, -0.02) : [lerp(-705, -712, up), lerp(474, 526, up)];
      drawTopPerson(ink, { x: -545, y: 532 + 8 * up, dir: -Math.PI / 2 + 0.1, H: 150, bend: 0.95 - 0.5 * up, hl: hA, hr: hA2, ink: 0.95, seed: 3 });
      drawTopPerson(ink, { x: -690, y: 534 + 8 * up, dir: -Math.PI / 2 - 0.08, H: 146, bend: 0.9 - 0.5 * up, hl: hB2, hr: hB, ink: 0.9, seed: 7 });
      drawTopPerson(ink, { x: -380, y: 560, dir: -Math.PI / 2 - 0.5 + 0.15 * up, H: 142, bend: 0.2, hl: [-418, 548], hr: [-350, 540], ink: 0.85, seed: 11 });
      // 水痕：一笔长长的墨线，从入水处一直跟到她尾后
      if (t > T.release + 0.05 && s > 6) {
        const sT = Math.max(0, s - L * 0.9);
        if (sT > 4) {
          const seg = subPath(tb, 0, sT);
          const age = (ss) => Math.max(0, t - tAtS(ss));
          const pool = (ss) => Math.exp(-Math.pow((ss - sApex) / 170, 2));
          // 老的水痕化开：宽、淡、湿
          ink.stroke(seg, { w: (u) => { const ss = u * sT, ag = age(ss); return 14 + 42 * smooth(ag / 3.5) + 26 * pool(ss) + 12 * Math.exp(-ss / 60); }, ink: (u) => { const ag = age(u * sT); return 0.15 * smooth(ag / 0.8) * (1 - 0.25 * smooth(ag / 5)); }, dry: 0.12, ch: CH.wet, seed: 21, cap: 5, rim: 0.85, bsp: 5 });
          // 芯：新的一段干脆、深；越老越淡、越碎（飞白）；入水处和转身处笔按得重
          ink.stroke(seg, { w: (u) => { const ss = u * sT, ag = age(ss); return (10 + 11 * pool(ss) + 16 * Math.exp(-ss / 55) + 3 * noise1(ss * 0.011) + 2 * noise1(ss * 0.05)) * (1 - 0.28 * smooth(ag / 4)) * (0.3 + 0.7 * smooth((sT - ss) / 40 + 0.05)); }, ink: (u) => { const ss = u * sT, ag = age(ss); return (1.15 + 0.35 * pool(ss)) * (1 - 0.38 * smooth(ag / 4.5)); }, dry: (u) => { const ss = u * sT, ag = age(ss); return 0.05 + 0.42 * smooth((ag - 0.6) / 4) + 0.12 * noise1(ss * 0.02); }, ch: CH.wet, seed: 22, cap: 5, rim: 0.45, bsp: 1.8 });
          // 尾后两道极淡的八字水纹
          const tp = fish.P(1, 0), tq = fish.P(0.93, 0);
          const bx2 = tp[0] - tq[0], by2 = tp[1] - tq[1], bl = Math.hypot(bx2, by2) || 1;
          const ux = bx2 / bl, uy = by2 / bl;
          for (const sg of [1, -1]) {
            const ca = Math.cos(0.36 * sg), sa = Math.sin(0.36 * sg);
            const vx = ux * ca - uy * sa, vy = ux * sa + uy * ca;
            ink.stroke(spline([[tp[0] + vx * 20, tp[1] + vy * 20], [tp[0] + vx * 110, tp[1] + vy * 110], [tp[0] + vx * 220, tp[1] + vy * 220]], 6), { w: (u) => 3 * Math.sin(Math.PI * u), ink: 0.12 * smooth((t - T.release - 0.5) / 0.5), dry: 0.5, ch: CH.dry, seed: 25 + sg, cap: 1 });
          }
        }
      }
      fish.drawTop(ink, { ink: 1.05, seed: 3.3 });
      // 入水：一圈圈乱的水纹 + 水花
      const ra = t - T.release;
      if (ra > 0) {
        for (let k = 0; k < 3; k++) {
          const aa = ra - k * 0.2;
          if (aa <= 0 || aa > 2.6) continue;
          ring(ink, -440, 448, 26 + 190 * (1 - Math.exp(-aa * 1.5)), { ink: 0.32 * Math.exp(-aa * 1.1), w: 3.4, arc: 0.78, a0: 0.4 + k * 2.1, ch: CH.dry, seed: 30 + k, wob: 0.08, dry: 0.45 });
        }
        drawSplatter(ink, splash, -470, 448, ra, { ink: 0.8, fly: 0.12, fade: 1.8 });
        ink.blob(-430, 448, 26 + 46 * (1 - Math.exp(-ra * 0.8)), { ch: CH.wet, ink: 0.32 - 0.12 * smooth(ra / 4), irr: 0.3, seed: 29, feather: 22 });
      }
      // 嘀：圈从她那一刻所在的地方荡开，一个接一个跟着她走
      for (const tt of T.pings) {
        const ag = t - tt;
        if (ag < 0 || ag > PING_RING + 0.5) continue;
        const ss = sAt(tt), p = ss > 0 ? atS(tb, ss) : { x: -420, y: 448 };
        pingRings(ink, p.x, p.y, ag, { rMax: 330, rMin: 16, ink: 0.55, w: 3.6, seed: tt });
      }
    },
  };
}

// ---------------------------------------------------------------- 夜
// 侧看江面（贴着水）：远岸一抹更深的山，水面一片黑；只剩跟踪船的一盏灯、灯的倒影、前面水里一圈圈声呐的圈。
// 船往上游（左）开；H08 前面现出金鸡尾的石头；触礁：船头一顶，墨炸开，灯甩起来，画面一抖，圈断在半截，之后再没有圈。
export function makeNight(ctx, ink, T) {
  const R = mulberry32(2290);
  const HZ = 452; // 远岸水线
  const WL = 640; // 船的水线
  // 灯附近的碎波光（留白），只在灯左右一片
  const glints = [];
  for (let i = 0; i < 46; i++) glints.push({ dx: (R() - 0.5) * 900, y: WL + 14 + Math.pow(R(), 1.3) * 300, len: 14 + R() * 60, k: 0.1 + R() * 0.25, ph: R() * 6.3, sp: 0.6 + R() * 1.4 });
  const boom = makeSplatter(9911, 40, { dir: -Math.PI / 2 - 0.4, spread: 3.0, dist: 230, size: 20, far: 1.5 });
  const spray = makeSplatter(9912, 46, { dir: -Math.PI / 2 - 0.2, spread: 2.4, dist: 280, size: 7, far: 1.4 });
  // 船：引擎起后往左开，触礁后停住（往回弹一点）
  const v0 = 58;
  const boatX = (t) => {
    const go = Math.max(0, Math.min(t, T.crash) - T.engine);
    const x = 520 - v0 * (go - 1.2 * (1 - Math.exp(-go / 1.2)));
    if (t < T.crash) return x;
    const ca = t - T.crash;
    return x + 26 * (1 - Math.exp(-ca * 5)) * Math.exp(-ca * 0.3);
  };
  const crashX = boatX(T.crash);
  const bowX = crashX - 214; // 触礁那一刻船头所在
  // 金鸡尾的石头：船头前一片（撞上的那块就在船头下）
  const rocks = [{ x: bowX - 30, w: 70, h: 26, seed: 3.1, hit: 1 }];
  for (let i = 0; i < 7; i++) rocks.push({ x: bowX - 170 - i * 170 - R() * 90, w: 50 + R() * 110, h: 16 + R() * 44, seed: R() * 50, y: WL + 6 + R() * 50 });
  function boatPose(t) {
    const x = boatX(t);
    const ca = t - T.crash;
    let pitch = 0.012 * Math.sin(t * 1.3), dy = 3 * Math.sin(t * 1.7);
    if (ca > 0) {
      // 船头被顶起：先猛一仰，再晃几下，最后歪着卡在石头上
      pitch += 0.16 * Math.exp(-ca * 2.4) * Math.cos(ca * 7.5) - 0.06 * (1 - Math.exp(-ca * 3));
      dy += -8 * Math.exp(-ca * 3) * Math.sin(ca * 9) + 6 * (1 - Math.exp(-ca * 2));
    }
    return { x, y: WL + dy, pitch };
  }
  const Bt = (bp, px, py) => { const c = Math.cos(bp.pitch), s = Math.sin(bp.pitch); return [bp.x + px * c - py * s, bp.y + px * s + py * c]; };
  function lampPos(t, bp) {
    const ca = t - T.crash;
    const swing = ca > 0 ? 0.95 * Math.exp(-ca * 0.6) * Math.sin(ca * 4.2 + 0.5) : 0.035 * Math.sin(t * 1.9);
    const top = Bt(bp, 96, -160);
    const len = 44;
    return { x: top[0] - Math.sin(swing) * len, y: top[1] + Math.cos(swing) * len, top, swing };
  }
  const herX = (t) => boatX(t) - 520 + 30 * Math.sin(t * 0.5);
  return {
    id: 'night', t0: T.nightIn, t1: T.waitIn + 1.2, usesB: true,
    paper: [1, 200, 900],
    enter: { type: 2, dur: 1.15, win: [0.1, 0.8, 0.25, 1], seed: 3.9, soft: 0.14, dir: [1, 0.1] },
    view: (t) => {
      const bp = boatPose(t);
      const ca = t - T.crash;
      const sh = ca > 0 ? 22 * Math.exp(-ca * 4.5) : 0;
      const push = smooth((t - T.night) / 9);
      return makeView(bp.x - 160 + 40 * smooth((t - T.crash) / 3), 606 - 10 * push, 1.0 + 0.08 * push, 0, sh * Math.sin(t * 83), sh * Math.cos(t * 67));
    },
    look: (t) => {
      const ca = t - T.crash;
      const flick = ca > 0 && ca < 1.4 ? 0.45 + 0.55 * Math.abs(Math.sin(ca * 31)) : 1;
      return { bleed: 0.9, rim: 0.7, gran: 0.5, night: 1, nightDen: 2.55, nightStreak: 0.5, nightIn: clamp((t - T.nightIn) / 0.9), bmode: 1, resv: 6, glow: 0.42 * flick * (1 - 0.3 * smooth((t - T.crash - 1.0) / 2.0)) };
    },
    post: (t) => ({ exposure: 0.95, vignette: 0.42, grain: 0.034, bloom: 0.12 }),
    draw(ink, t) {
      const bp = boatPose(t);
      const lamp = lampPos(t, bp);
      const ca = t - T.crash;
      const lampK = ca > 0 && ca < 1.4 ? 0.45 + 0.55 * Math.abs(Math.sin(ca * 31)) : 1;
      const cx = bp.x;
      // 远岸：一抹比夜更深的山（上缘起伏，下缘化进水汽），水线上一丝若有若无的亮
      for (let k = 0; k < 2; k++) {
        const pts = [];
        for (let i = 0; i <= 30; i++) { const x = cx - 2600 + i * 180; pts.push([x, HZ - (60 + 80 * noise1(i * 0.31 + k * 3 + Math.floor((cx - 2600) / 180) * 0.31)) * (0.55 + 0.45 * k)]); }
        ink.stroke(spline(pts, 14), { wt: 2, wb: 110, ink: 0.7 + 0.35 * k, dry: 0.15, side: 0.9, ch: CH.wet, seed: 8 + k, cap: 0, bsp: 6 });
      }
      ink.stroke(spline([[cx - 2600, HZ + 2], [cx, HZ], [cx + 2600, HZ + 3]], 20), { w: 5, ink: 0.06, dry: 0.5, ch: CH.res, seed: 5, cap: 0, bsp: 3 });
      // 灯附近水面的碎光（离灯越近越亮），随水晃
      for (const g of glints) {
        const x = lamp.x + g.dx + 14 * Math.sin(t * g.sp + g.ph);
        const near = Math.exp(-Math.pow(g.dx / 330, 2)) * Math.exp(-(g.y - WL) / 260);
        const k = g.k * near * lampK * (0.6 + 0.4 * Math.sin(t * 2.3 * g.sp + g.ph));
        if (k < 0.015) continue;
        ink.stroke(new Float32Array([x - g.len / 2, g.y, x, g.y + 1, x + g.len / 2, g.y]), { w: (u) => 3.2 * Math.sin(Math.PI * u), ink: k, dry: 0.35, ch: CH.res, seed: g.ph * 10, cap: 1 });
      }
      // 灯在水里的倒影：一竖串碎光，长短不一、断断续续
      for (let k = 0; k < 18; k++) {
        const yy = WL + 10 + k * 17 + 5 * noise1(k * 1.7 + t * 0.8);
        const w = (22 + k * 5) * (0.35 + 0.65 * Math.abs(noise1(t * 1.6 + k * 1.3)));
        const x = lamp.x + 16 * noise1(t * 1.2 + k * 0.7) + Math.sin(lamp.swing) * (k * 6);
        const kk = 0.95 * lampK * Math.exp(-k * 0.14) * (0.55 + 0.45 * noise1(t * 2.1 + k * 2.3));
        if (kk < 0.03) continue;
        ink.stroke(new Float32Array([x - w / 2, yy, x - w * 0.1, yy + 1, x + w / 2, yy]), { w: (u) => (4.2 - k * 0.14) * Math.pow(Math.sin(Math.PI * u), 0.6), ink: kk, dry: 0.3, ch: CH.res, seed: 40 + k, cap: 1 });
      }
      // 引擎起：船尾一道淡淡的尾迹（留白的水纹）
      const eg = Math.max(0, t - T.engine);
      if (eg > 0) {
        const wl = Math.min(560, eg * 95);
        const fade = t < T.crash ? smooth(eg / 0.8) : Math.exp(-(t - T.crash) * 0.8);
        for (const [sg, k] of [[1, 0], [-1, 1], [1, 2]]) {
          const st = Bt(bp, 205, 4);
          ink.stroke(spline([[st[0], st[1] + 4 + k * 6], [st[0] + wl * 0.5, st[1] + 10 + sg * 6 + k * 8], [st[0] + wl, st[1] + 18 + sg * 16 + k * 10]], 8), { w: (u) => 3 * (1 - u), ink: 0.13 * fade * (1 - 0.25 * k), dry: (u) => 0.4 + 0.4 * u, ch: CH.res, seed: 50 + k, cap: 1 });
        }
      }
      // 声呐的圈：船前面的水面上（她在那底下），压扁成椭圆；触礁那一圈断在半截
      for (const tt of T.pings) {
        const age = t - tt;
        if (age < 0 || age > PING_RING + 0.8) continue;
        if (tt < T.nightIn - 0.5) continue;
        const cutAge = tt + PING_RING > T.crash ? T.crash - tt : undefined;
        pingRings(ink, herX(tt), WL + 40, age, { rMax: 520, rMin: 16, ink: 0.26, w: 5.5, ch: CH.res, aspect: 0.16, cutAge, a0: -Math.PI * 0.5, seed: tt, wash: 0.22, washCh: CH.res, soft: 0.28 });
      }
      // 金鸡尾的石头：H08 之后，灯照得到的一侧有一点亮边，石根一圈白浪
      const rk = smooth((t - T.rocks) / 1.4);
      for (const r of rocks) {
        const y0 = r.y || WL + 4;
        const pts = [[r.x - r.w, y0 + 6], [r.x - r.w * 0.55, y0 - r.h * 0.75], [r.x - r.w * 0.1, y0 - r.h], [r.x + r.w * 0.45, y0 - r.h * 0.6], [r.x + r.w, y0 + 6]];
        ink.fill(spline(pts, 5), { ch: CH.wet, ink: 1.3 * (0.25 + 0.75 * rk), tex: 0.7, seed: r.seed, feather: 3 });
        const lit = Math.exp(-Math.pow((r.x - lamp.x) / 620, 2)) * (0.35 + 0.65 * rk);
        if (lit > 0.02) {
          ink.stroke(spline(pts.slice(1, 4), 4), { w: (u) => 3.2 * Math.sin(Math.PI * u), ink: 0.4 * lit, dry: 0.5, ch: CH.res, seed: r.seed + 1, cap: 1 });
          for (let k = 0; k < 3; k++) {
            const fx = r.x - r.w * 1.1 + k * r.w * 0.8 + 8 * Math.sin(t * 2 + k + r.seed);
            ink.stroke(new Float32Array([fx, y0 + 8 + k * 3, fx + r.w * 0.5, y0 + 9 + k * 3]), { w: 3, ink: 0.35 * lit * (0.6 + 0.4 * Math.sin(t * 3 + k * 2 + r.seed)), dry: 0.45, ch: CH.res, seed: r.seed + 2 + k, cap: 1 });
          }
        }
      }
      // 船：侧影（船身一笔侧锋，小舱，舱顶一根杆挂灯）
      const hullPts = spline([Bt(bp, -214, -22), Bt(bp, -150, 4), Bt(bp, 0, 12), Bt(bp, 150, 8), Bt(bp, 210, -12)], 5);
      ink.stroke(hullPts, { wt: (u) => 10 + 6 * Math.sin(Math.PI * u), wb: (u) => 12 + 14 * Math.sin(Math.PI * u), ink: 2.0, dry: 0.12, side: -0.4, ch: CH.wet, seed: 60, cap: 3 });
      ink.fill(new Float32Array([...Bt(bp, 30, -8), ...Bt(bp, 34, -84), ...Bt(bp, 150, -86), ...Bt(bp, 176, -10)]), { ch: CH.wet, ink: 1.9, tex: 0.5, seed: 61, feather: 2 });
      ink.stroke(spline([Bt(bp, 96, -84), Bt(bp, 96, -160)], 3), { w: 4, ink: 2.0, dry: 0.2, ch: CH.wet, seed: 62, cap: 1 });
      // 舱窗一点灯光、舱顶和船舷被灯照到的一线（留白）
      const win = Bt(bp, 70, -50);
      ink.blob(win[0], win[1], 7, { ch: CH.res, ink: 0.3 * lampK, irr: 0.2, ay: 0.7, seed: 63 });
      ink.stroke(spline([Bt(bp, 40, -86), Bt(bp, 96, -90), Bt(bp, 148, -87)], 4), { w: 3, ink: 0.3 * lampK, dry: 0.4, ch: CH.res, seed: 64, cap: 1 });
      ink.stroke(spline([Bt(bp, -100, -10), Bt(bp, 40, -6), Bt(bp, 190, -12)], 5), { w: 2.4, ink: 0.2 * lampK, dry: 0.5, ch: CH.res, seed: 65, cap: 1 });
      // 船头的人：蹲着，手里一根线垂进水里（听信标）；H08 时抬手指着前面；触礁后站起来拿手电找
      {
        const bow = Bt(bp, -150, -18);
        const stand = smooth((t - T.lost) / 0.6);
        const point = smooth((t - (T.L.H08.t + 0.2)) / 0.4) * (1 - smooth((t - T.crash + 0.2) / 0.3));
        const H = 150;
        // 触礁那一下被顶得往后一仰、一矮
        const jolt = ca > 0 ? Math.exp(-ca * 2.2) * Math.sin(Math.min(ca * 9, Math.PI * 0.5 + ca * 3)) : 0;
        const px = bow[0] + 10 + 26 * jolt, py = bow[1] - lerp(0.3, 0.46, stand) * H + 14 * Math.abs(jolt);
        const cableEnd = [bow[0] - 60, WL + 40];
        const hr = point > 0.01 ? [lerp(px - 40, px - 0.36 * H, point), lerp(py - 10, py - 0.46 * H, point)] : [px - 40, py - 10];
        const torch = [px - 0.2 * H, py - 0.22 * H];
        drawFigure(ink, { x: px, y: py, H, face: -1, lean: lerp(0.55, 0.15, stand) - 0.9 * jolt, head: lerp(0.35, 0.1, stand) - 0.4 * jolt, fl: [bow[0] + 18, bow[1]], fr: [bow[0] - 14, bow[1] + 2], hl: stand > 0.5 ? torch : [px - 30, py + 20], hr, ink: 2.2, seed: 71, coat: 1.1 });
        if (stand < 0.5) ink.stroke(spline([[px - 30, py + 20], [px - 44, py + 60], cableEnd], 4), { w: 1.6, ink: 1.4, dry: 0.3, ch: CH.wet, seed: 72, cap: 1 });
        // 手电：一道光扫过黑水（什么也照不到）
        const sk = smooth((t - T.lost - 0.4) / 0.6) * (1 - smooth((t - T.waitIn - 0.2) / 0.8));
        if (sk > 0) {
          const ang = Math.PI + 0.35 + 0.3 * Math.sin((t - T.lost) * 1.3);
          const len = 1100, spr = 0.06;
          const o = torch;
          const p1 = [o[0] + Math.cos(ang - spr) * len, o[1] + Math.sin(ang - spr) * len * 0.4 + 40];
          const p2 = [o[0] + Math.cos(ang + spr) * len, o[1] + Math.sin(ang + spr) * len * 0.4 + 40];
          ink.fill(new Float32Array([o[0], o[1], p1[0], p1[1], p2[0], p2[1]]), { ch: CH.res, ink: (x, y) => 0.32 * sk * Math.max(0, 1 - Math.hypot(x - o[0], y - o[1]) / len), tex: 0.9, seed: 80, feather: 18 });
          const hit = [o[0] + Math.cos(ang) * len * 0.62, WL + 70 + 40 * Math.sin((t - T.lost) * 1.3)];
          ink.blob(hit[0], hit[1], 60, { ch: CH.res, ink: 0.12 * sk, irr: 0.3, ay: 0.3, seed: 81, feather: 30 });
        }
      }
      // 灯：留白 + 光晕（合成时从留白里化出来）；杆头一根短绳
      ink.stroke(spline([lamp.top, [lamp.x, lamp.y - 6]], 2), { w: 1.8, ink: 1.6, dry: 0.2, ch: CH.wet, seed: 66 });
      ink.blob(lamp.x, lamp.y, 7, { ch: CH.res, ink: 2.4 * lampK, irr: 0.12, seed: 67 });
      ink.blob(lamp.x, lamp.y, 30, { ch: CH.res, ink: 0.16 * lampK, irr: 0.2, seed: 68, feather: 24 });
      // 触礁：船头一团墨炸开（黑的甩出去）+ 白的水花；水里一大团墨化开
      if (ca > 0) {
        const bow = Bt(bp, -205, -4);
        drawSplatter(ink, boom, bow[0], bow[1], ca, { ink: 1.5, scale: 1.25, fly: 0.2, fade: 3.2, grav: 380, noTail: true });
        drawSplatter(ink, spray, bow[0], bow[1] - 8, ca, { ink: 0.42, scale: 0.8, fly: 0.24, ch: CH.res, fade: 0.8, grav: 620 });
        const r = 70 + 420 * (1 - Math.exp(-ca * 2.6));
        ink.blob(bow[0] - 30, bow[1] + 20, r, { ch: CH.wet, ink: 0.75 * Math.exp(-ca * 0.5), irr: 0.45, ay: 0.55, seed: 70, feather: r * 0.4 });
      }
    },
  };
}

// ---------------------------------------------------------------- 等
// 水底，金鸡尾。夜的墨退成一片暗的褐灰（不是全黑），石头是更深的墨；她停在石头上，只剩一道淡淡的墨线轮廓，鳃很慢地开合。
// 远处水面上那条船的灯还亮着一点，「你们没有来」时熄了。最后墨从四处洇进来，铺成极深的褐黑（接 S4 的浑水）。
export function makeWait(ctx, ink, T) {
  const fish = new Fish();
  const R = mulberry32(2420);
  const motes = [];
  for (let i = 0; i < 26; i++) motes.push({ x: R() * 2100 - 90, y: 240 + R() * 700, r: 1.2 + R() * 2.2, v: 3 + R() * 8, ink: 0.05 + R() * 0.1, seed: R() * 99 });
  // 江底的石头：大小不一、错落，有的只露一角；形状不规则（多几个随机的折角）
  const stones = [];
  const xs = [-160, 120, 330, 560, 760, 1240, 1470, 1700, 1950, 2150];
  for (let i = 0; i < xs.length; i++) {
    const cxs = xs[i] + (R() - 0.5) * 100, base = 900 + R() * 70, w = 110 + R() * 190, h = 60 + R() * 140;
    const n = 7 + Math.floor(R() * 3);
    const pts = [[cxs - w, 1300]];
    for (let k = 0; k <= n; k++) {
      const a = Math.PI * (1 - k / n);
      const rr = 1 + (R() - 0.5) * 0.35;
      pts.push([cxs + Math.cos(a) * w * rr, base - Math.sin(a) * h * rr * (0.75 + 0.5 * Math.sin(a + i))]);
    }
    pts.push([cxs + w, 1300]);
    stones.push({ pts, x: cxs, base, w, h, seed: R() * 50, k: 0.75 + R() * 0.55, lean: R() < 0.5 ? 1 : -1 });
  }
  // 她身下那两块（她停在它们之间）
  stones.push({ pts: [[700, 1300], [712, 900], [760, 836], [860, 806], [940, 830], [990, 880], [1000, 1300]], x: 850, base: 900, w: 150, h: 94, seed: 31.7, k: 1.1, lean: 1 });
  stones.push({ pts: [[1060, 1300], [1080, 880], [1150, 818], [1250, 800], [1330, 842], [1370, 910], [1380, 1300]], x: 1220, base: 900, w: 160, h: 100, seed: 17.3, k: 1.0, lean: -1 });
  return {
    id: 'wait', t0: T.waitIn, t1: T.end + 0.01, usesB: true,
    paper: [1, 1300, 100],
    enter: { type: 0, dur: 1.4, win: [0, 0.6, 0.35, 1], seed: 12.3, soft: 0.14 },
    view: (t) => {
      const a = clamp((t - T.waitIn) / (T.end - T.waitIn));
      return makeView(990 - 30 * a, 600, 1.0 + 0.1 * smooth(a), 0);
    },
    look: (t) => ({ bleed: 0.9, rim: 0.7, gran: 0.5, night: 1, nightDen: 1.55, nightStreak: 0.4, nightIn: 1, bmode: 1, resv: 6, glow: 0.25 * (1 - smooth((t - T.lampOut) / 1.2)),
      final: clamp((t - T.bleed) / (T.bleedEnd - T.bleed)), finalX: 1000, finalY: 560, finalSeed: 2.7 }),
    post: (t) => ({ exposure: 0.95, vignette: 0.45, grain: 0.034, bloom: 0.08 }),
    draw(ink, t) {
      const a = t - T.waitIn;
      // 头顶很远的水面：一道若有若无的亮；那条船的灯（快熄了）
      ink.stroke(spline([[-300, 272], [600, 262], [1400, 276], [2300, 266]], 14), { wt: 14, wb: 70, ink: 0.05, dry: 0.4, side: 0.5, ch: CH.res, seed: 3, cap: 0, bsp: 8 });
      const lampK = 1 - smooth((t - T.lampOut) / 1.2);
      if (lampK > 0) {
        const fl = 0.85 + 0.15 * Math.sin(t * 7.3) * Math.sin(t * 3.1);
        ink.blob(1590, 262, 4, { ch: CH.res, ink: 1.1 * lampK * fl, irr: 0.2, seed: 4 });
        ink.blob(1590, 262, 16, { ch: CH.res, ink: 0.1 * lampK * fl, irr: 0.2, seed: 5, feather: 12 });
        for (let k = 0; k < 4; k++) ink.stroke(new Float32Array([1574 + 5 * Math.sin(t + k), 282 + k * 11, 1590, 283 + k * 11, 1606 - 4 * Math.sin(t * 1.3 + k), 282 + k * 11]), { w: 2.2, ink: 0.22 * lampK * fl * (1 - k * 0.22), dry: 0.4, ch: CH.res, seed: 6 + k, cap: 1 });
      }
      // 江底：一片更深的墨，石头坐在上面
      ink.fill(new Float32Array([-400, 985, 600, 966, 1400, 980, 2400, 972, 2400, 1400, -400, 1400]), { ch: CH.wet, ink: 0.6, tex: 1.2, seed: 90, feather: 70 });
      // 石头：黑里更黑；暗面一笔侧锋，面上几笔干擦（皴），上缘极淡一线
      for (const st of stones) {
        const poly = spline(st.pts, 8);
        ink.fill(poly, { ch: CH.wet, ink: 0.85 * st.k, tex: 1.1, seed: st.seed, feather: 12 });
        const top = spline(st.pts.slice(1, -1), 6);
        ink.stroke(top, { w: (u) => 6 + 5 * Math.sin(Math.PI * u), ink: 1.0 * st.k, dry: (u) => 0.25 + 0.45 * u, ch: CH.dry, seed: st.seed + 1, cap: 1 });
        // 暗面：沿着轮廓的一侧压一笔侧锋（顺着石头的形，不是竖着）
        const half = st.lean > 0 ? st.pts.slice(Math.floor(st.pts.length / 2), -1) : st.pts.slice(1, Math.ceil(st.pts.length / 2)).reverse();
        if (half.length >= 2) ink.stroke(spline(half, 6), { w: (u) => st.w * 0.3 * (0.4 + 0.8 * u), ink: 0.55 * st.k, dry: (u) => 0.2 + 0.35 * u, side: -st.lean * 0.9, ch: CH.wet, seed: st.seed + 2, cap: 2, bsp: 3 });
        // 皴：几笔斜的干擦
        for (let k = 0; k < 4; k++) {
          const y0 = st.base - st.h * (0.7 - k * 0.2), x0 = st.x - st.w * (0.55 - k * 0.22) + 30 * Math.sin(st.seed + k);
          const dx = st.w * (0.28 + 0.1 * Math.sin(st.seed * 3 + k)), dy = st.h * 0.22 * st.lean;
          ink.stroke(spline([[x0, y0], [x0 + dx * 0.5, y0 + dy * 0.4 + 4], [x0 + dx, y0 + dy]], 6), { w: (u) => 9 * (1 - 0.6 * u), ink: 0.55 * st.k, dry: (u) => 0.55 + 0.3 * u, ch: CH.dry, seed: st.seed + 3 + k, cap: 1 });
        }
        ink.stroke(spline(st.pts.slice(2, -2), 6), { w: 2.2, ink: 0.04, dry: 0.5, ch: CH.res, seed: st.seed + 6, cap: 1 });
      }
      // 她：停在两块石头之间，一动不动，只有鳃很慢地一开一合；墨线轮廓，淡
      fish.pose({ x: 1010, y: 700, L: 1320, ang: -0.03, anchor: 0.5, kappa: (u) => (u > 0.8 ? 0.035 * Math.sin(t * 0.5) : 0) });
      const fade = smooth((t - T.waitIn - 0.5) / 1.8);
      fish.drawOutline(ink, { ink: 2.0 * fade, width: 1.5, seed: 6.6, gill: 0.25 + 0.25 * Math.sin(t * 0.8), body: 0.45 * fade });
      // 水里极少的一点悬浮的东西
      for (const m of motes) {
        const y = m.y - m.v * a, x = m.x + 8 * Math.sin(a * 0.3 + m.seed);
        ink.blob(x, y, m.r, { ch: CH.res, ink: m.ink * fade, irr: 0.3, seed: m.seed });
      }
    },
  };
}
