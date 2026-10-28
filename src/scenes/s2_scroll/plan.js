// S2 长卷的时间与版面规划：纯函数，不依赖浏览器（events.js 和场景共用同一批数）
// 长卷坐标：x 向右增大（左端 = 现在，右端 = 一亿五千万年前），y 向下，纸高 HS。
// 镜头：cx/cy 为画面中心对应的长卷坐标，z 为缩放（1 = 长卷 1 像素对屏幕 1 像素）。

export const HS = 880;            // 纸高（画心）
export const MOUNT = 30;          // 上下裱边
export const Y_BANK = 566;        // 河的上岸线（远岸）
export const Y_RIVER_BOT = HS;    // 河底 = 纸底
export const FAR_P = 0.92;        // 远山视差系数
export const X_DAM = 5200;        // 坝（直线）所在
export const DAM_TOP = Y_BANK - 205; // 坝线上端（长卷 y）
export const DAM_W = 24;          // 坝线粗细（px）
export const X_PLATE = 1180;      // 开场图谱画面中心
export const PLATE_W = 2350;      // 图谱这一段的宽（从 x=0 起）

const find = (arr, id) => { const o = arr.find((x) => x.id === id); if (!o) throw new Error(`plan: no ${id}`); return o; };
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
const smoother = (t) => { t = clamp(t); return t * t * t * (t * (t * 6 - 15) + 10); };

/** 分段线性速度曲线的积分：keys = [[t, v], ...]（t 递增），返回 F(t) = ∫_{keys[0].t}^{t} v dt */
function integrator(keys) {
  const cum = [0];
  for (let i = 1; i < keys.length; i++) {
    const [ta, va] = keys[i - 1], [tb, vb] = keys[i];
    cum.push(cum[i - 1] + (tb - ta) * (va + vb) * 0.5);
  }
  return (t) => {
    if (t <= keys[0][0]) return 0;
    for (let i = 1; i < keys.length; i++) {
      const [ta, va] = keys[i - 1], [tb, vb] = keys[i];
      if (t <= tb) {
        const u = t - ta, k = (vb - va) / Math.max(1e-9, tb - ta);
        return cum[i - 1] + va * u + 0.5 * k * u * u;
      }
    }
    const [tl, vl] = keys[keys.length - 1];
    return cum[cum.length - 1] + vl * (t - tl);
  };
}
function speedAt(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [ta, va] = keys[i - 1], [tb, vb] = keys[i];
    if (t <= tb) return va + (vb - va) * (t - ta) / Math.max(1e-9, tb - ta);
  }
  return keys[keys.length - 1][1];
}

let CACHE = null;
export function makePlan(tl) {
  if (CACHE && CACHE.tl === tl) return CACHE.plan;
  const mk = (id) => find(tl.marks, `s2_scroll.${id}`).t;
  const ln = (id) => find(tl.lines, id);
  const sc = find(tl.scenes, 's2_scroll');
  const T = {
    start: sc.start, end: sc.end,
    paperIn: mk('paper_in'), rewind: mk('scroll_rewind'), asteroid: mk('asteroid'), wei: mk('wei_write'),
    modern: mk('modern'), dam: mk('dam_line'),
    L13: ln('L13'), L14: ln('L14'), L15: ln('L15'), L16: ln('L16'), L17: ln('L17'), L18: ln('L18'), L19: ln('L19'),
    L20: ln('L20'), L21: ln('L21'), L22: ln('L22'), L23: ln('L23'), L24: ln('L24'), L25: ln('L25'), L26: ln('L26'), L27: ln('L27'),
  };
  // ---- 回卷（rewind）编排 ----
  const RW = {
    t0: T.rewind,                  // 开始拉远
    tOut: T.rewind + 0.72,         // 拉到最远
    tSweep0: T.rewind + 0.42,      // 开始向右掠
    tSweep1: T.rewind + 1.46,      // 掠到最右端
    tIn0: T.rewind + 1.3,          // 开始推回
    tIn1: T.L15.t + 0.45,          // 推回 1:1
    zOut: 0.17,
  };
  // ---- 主摇镜：速度曲线（长卷像素/秒，正 = 镜头向左）----
  const tPan0 = T.L15.t - 0.3;
  const dam = T.dam;
  const keys = [
    [tPan0, 0],
    [T.L15.t + 1.0, 205],
    [T.L16.t - 0.8, 245],
    [T.asteroid - 0.6, 150],
    [T.asteroid + 2.6, 118],
    [T.L18.t - 0.3, 255],
    [T.L18.t + 6.0, 265],
    [T.wei - 1.0, 120],
    [T.wei + 0.2, 52],
    [T.wei + 3.3, 52],
    [T.L21.t - 0.2, 265],
    [T.L21.t + 1.6, 250],
    [T.L22.t + 0.6, 255],
    [T.modern - 1.0, 262],
    [T.modern - 0.2, 520],
    [T.modern + 0.6, 1050],
    [dam - 0.35, 1150],
    [dam + 0.3, 80],
    [dam + 1.2, 0],
    [T.L25.t + 1.5, 0],
    [T.L25.t + 3.0, 95],
    [T.L27.t + 2.3, 95],
    [T.L27.t + 3.25, 0],
    [sc.end + 1, 0],
  ];
  const F = integrator(keys);
  const tDamCenter = dam + 0.16;                // 坝线画到一半时在画面中心
  const X_START = X_DAM + F(tDamCenter);        // 主摇镜起点（最右端那一屏的中心）
  const panX = (t) => X_START - F(t);
  const LEN = Math.ceil(X_START + 960 + 60);    // 画心总长
  // ---- 各段落在长卷上的位置（按台词出现时镜头所在） ----
  const at = (t, dx = 0) => panX(t) + dx;       // dx：相对画面中心的屏幕偏移（z=1）
  // 焦点：某句台词时画面中心对准的长卷位置（元素围绕焦点布置；相邻段落自然衔接）
  const X = {
    start: X_START, len: LEN, dam: X_DAM, plate: X_PLATE,
    first: X_START - 960,                          // 主摇镜第一屏的左缘
    ancient: at(T.L15.t + 1.2),                    // 雾、蕨、苏铁、古河
    dino: at(T.L16.t + 1.6),                       // 蜥脚类饮水、翼龙
    impact: at(T.asteroid + 0.55, -170),           // 陨石落点
    mount: at(T.L18.t + 1.6),                      // 山长高
    reroute: at(T.L18.t + 3.8),                    // 河改道
    glacier: at(T.L18.t + 6.1),                    // 冰川
    human: at(T.L19.t + 1.3),                      // 人、火、独木舟
    wei: at(T.wei + 1.6, -40),                     // 「鲔」字中心
    zhou: at(T.L21.t + 3.2, -120),                 // 天子舟、宗庙
    tang: at(T.L22.t + 1.4),                       // 唐宋开始（右）
    tangEnd: at(T.modern - 1.6),                   // 唐宋结束（左）
    modern0: X_DAM + 950, modern1: X_DAM + 1900,   // 近代（现场画出来）
  };
  X.ship = X.modern0 + 470; X.bridge = X.modern0 + 120; X.chimney = X.modern1 - 170;
  // 镜头（全段）
  const zPlate = (t) => 1.0 + 0.045 * smooth((t - T.start) / (T.rewind - T.start));
  const plateX = (t) => X_PLATE + 36 * smooth((t - T.start) / (T.rewind - T.start));
  function camera(t) {
    let cx, cy = HS / 2, z;
    if (t < RW.t0) {
      cx = plateX(t); z = zPlate(t);
    } else if (t < RW.tIn1) {
      const zA = zPlate(RW.t0);
      const kOut = smoother((t - RW.t0) / (RW.tOut - RW.t0));
      const kIn = smoother((t - RW.tIn0) / (RW.tIn1 - RW.tIn0));
      // 缩放在对数空间插值：拉远再推回
      const lz = Math.log(zA) + (Math.log(RW.zOut) - Math.log(zA)) * kOut + (Math.log(1) - Math.log(RW.zOut)) * kIn;
      z = Math.exp(lz);
      const ks = smoother((t - RW.tSweep0) / (RW.tSweep1 - RW.tSweep0));
      cx = plateX(RW.t0) + (X_START - plateX(RW.t0)) * ks;
      // 掠过时画面中心略下移，拉远时整卷居中
      cy = HS / 2;
      if (t > tPan0) cx = X_START - F(t);
    } else {
      cx = panX(t); z = 1;
      // 结尾轻轻拉远一点，留白更大
      z = 1 - 0.05 * smooth((t - (T.L27.t - 0.5)) / 3.6);
    }
    return { cx, cy, z };
  }
  /** 屏幕上的水平速度（像素/秒），用于运动模糊 */
  function screenSpeed(t) {
    const dt = 1 / 120;
    const a = camera(t - dt), b = camera(t + dt);
    return ((b.cx - a.cx) / (2 * dt)) * ((a.z + b.z) * 0.5);
  }
  /** 远山视差偏移：只在主摇镜开始后累积（回卷拉远时远山与纸对齐） */
  function farOffset(t) {
    if (t < tPan0) return 0;
    return (1 - FAR_P) * (panX(t) - X_START);
  }
  /** 远山层坐标：想让远山在镜头经过 X 时位于其背后 → 画在 farX(X) */
  const farX = (x) => x + (1 - FAR_P) * (X_START - x);
  const plan = { T, RW, keys, panX, camera, screenSpeed, farOffset, farX, X, LEN, HS, speedAt: (t) => speedAt(keys, t), tPan0, tDamCenter };
  plan.live = liveTimes(plan);
  plan.fish = fishList(plan);
  CACHE = { tl, plan };
  return plan;
}

// ---------------------------------------------------------------------------
// 现场生长的元素的时间窗
// ---------------------------------------------------------------------------
function liveTimes(P) {
  const { T } = P;
  const L = {};
  // 开场题名：白鲟（L13）、象鱼（L14）
  L.name1 = { text: '白鲟', t0: T.L13.t + 0.15, dur: 2.35 };
  L.name2 = { text: '象鱼', t0: T.L14.t + 0.25, dur: 2.6 };
  // 陨石：朱砂一笔划下 → 落地 → 红晕开 → 恐龙化灰
  L.astStreak0 = T.asteroid + 0.05;
  L.astImpact = T.asteroid + 0.55;
  L.astBloomEnd = T.asteroid + 3.4;
  L.dinoFade0 = L.astImpact + 0.25;
  L.dinoFadeDur = 2.6;
  // 新生代：山一层层长高、河改道、冰川
  L.mount0 = T.L18.t - 0.9; L.mount1 = T.L18.t + 5.0;
  L.reroute0 = T.L18.t + 2.2; L.reroute1 = T.L18.t + 4.6;
  // 岸上有了人：人、火、独木舟
  L.human0 = T.L19.t - 0.4; L.human1 = T.L19.t + 2.6;
  // 「鲔」字 + 小楷
  L.wei = { text: '鲔', t0: T.wei + 0.05, dur: 3.0 };
  L.weiNote = { text: '季春之月 天子始乘舟 荐鲔于寝庙', t0: T.wei + 3.15, t1: T.L21.t + 0.9 };
  // 周：香烟
  L.zhouSmoke0 = T.L21.t - 1.0; L.zhouSmoke1 = T.L21.t + 4.0;
  // 近代：黑烟
  L.modern0 = T.modern - 0.55; L.modern1 = T.modern + 0.85;   // 近代的东西现场几笔砍出来
  L.smoke0 = T.modern - 0.1; L.smoke1 = T.modern + 2.4;
  // 坝线：用尺子画的直线（从上往下）
  L.ruler0 = T.dam; L.ruler1 = T.dam + 0.55;
  // 海：墙外远处一抹极淡的水平线
  L.sea0 = T.L25.t + 1.6; L.sea1 = T.L25.t + 4.2;
  return L;
}

/** 小楷注文分两行（空格处断开：前两句一行，末句一行）；场景与 events.js 共用 */
export function weiNoteCols(text) {
  const parts = text.split(' ');
  return [parts.slice(0, 2).join(' '), parts.slice(2).join(' ')];
}

// ---------------------------------------------------------------------------
// 近代：烟囱、厂房、轮船、铁桥的位置与现场落笔时间（场景与 events.js 共用）
// ---------------------------------------------------------------------------
export function modernLayout(P) {
  const { X } = P, L = P.live;
  const a = L.modern0, b = L.modern1, d = b - a;
  const yb = Y_BANK - 20;
  // 从右往左一根根砍出来
  const chim = [[X.chimney + 130, 250, 22], [X.chimney + 40, 336, 28], [X.chimney - 55, 372, 31], [X.chimney - 150, 300, 26]]
    .map(([x, h, w], i) => ({ x, y: yb, h, w, lean: (1.5 - i) * 0.004, t0: a + d * (0.04 + i * 0.09), t1: a + d * (0.24 + i * 0.09) }));
  const smoke = chim.map((c, i) => ({ x: c.x + c.lean * c.h, y: c.y - c.h - 4, len: [380, 470, 520, 440][i], rise: [0.34, 0.26, 0.22, 0.3][i], w1: [70, 95, 105, 85][i], t0: c.t1 + 0.04, t1: c.t1 + 1.7 }));
  const ship = { x: X.ship + 330, y: 652, len: 420, t0: a + d * 0.32, t1: a + d * 0.62 };
  return {
    chim, smoke, ship,
    shipSmoke: { len: 480, rise: 0.16, w1: 62, t0: ship.t1 - 0.05, t1: ship.t1 + 1.5 },
    sheds: { x0: X.chimney - 300, x1: X.chimney + 230, y: Y_BANK - 6, h: 72, t0: a, t1: a + d * 0.4 },
    bridge: { x0: X.bridge - 300, x1: X.bridge + 250, y: Y_BANK - 22, s: 48, t0: a + d * 0.55, t1: b },
    oil: { x0: X.bridge - 250, x1: X.chimney + 200, t0: a + d * 0.2, t1: b + 0.3 },
  };
}

// ---------------------------------------------------------------------------
// 河里的白鲟：每个时代不同的个体，数量体现兴衰
// ---------------------------------------------------------------------------
function fishList(P) {
  const { T, X } = P;
  const out = [];
  let id = 0;
  const R = mulberry(20250926);
  // 镜头经过 x 的时刻（二分），漂游的鱼以此为参考时刻，保证经过时正好在它的位置附近
  const passT = (x) => { let a = P.tPan0, b = P.T.dam + 0.2; for (let k = 0; k < 40; k++) { const m = (a + b) / 2; if (P.panX(m) > x) a = m; else b = m; } return (a + b) / 2; };
  const add = (o) => { const f = { id: id++, dir: -1, tone: 0.82, swim: 1, v: 6 + R() * 8, phase: R() * 6.28, fade0: null, fadeDur: 0.9, mode: 'drift', ...o }; f.tref = passT(f.x); out.push(f); };
  const scatter = (x0, x1, n, o = {}) => {
    for (let i = 0; i < n; i++) {
      const u = (i + 0.2 + R() * 0.6) / n;
      add({ x: x0 + (x1 - x0) * u, y: 618 + R() * 220, L: (o.Lmin ?? 150) + R() * ((o.Lmax ?? 300) - (o.Lmin ?? 150)), era: o.era, tone: 0.72 + R() * 0.2 });
    }
  };
  // 远古（少而稳）
  scatter(X.ancient - 500, X.ancient + 700, 2, { era: 'ancient', Lmin: 240, Lmax: 300 });
  scatter(X.dino - 500, X.dino + 400, 2, { era: 'dino', Lmin: 200, Lmax: 280 });
  scatter(X.impact - 400, X.impact + 300, 2, { era: 'ast', Lmin: 200, Lmax: 260 });
  scatter(X.glacier - 400, X.mount + 500, 4, { era: 'ceno', Lmin: 170, Lmax: 290 });
  scatter(X.human - 500, X.human + 500, 4, { era: 'human', Lmin: 160, Lmax: 280 });
  scatter(X.wei - 600, X.wei + 400, 4, { era: 'wei', Lmin: 150, Lmax: 260 });
  scatter(X.zhou - 900, X.zhou + 700, 7, { era: 'zhou', Lmin: 150, Lmax: 270 });
  // 唐宋：江里到处都是
  scatter(X.tangEnd - 200, X.tang + 600, 18, { era: 'tang', Lmin: 120, Lmax: 290 });
  // 近代：骤减
  scatter(X.modern0 + 100, X.modern1 - 100, 2, { era: 'modern', Lmin: 170, Lmax: 230 });
  // 坝下游：游到墙脚聚在一起（上不来）
  // 错开深浅与离墙的远近，免得叠成一团：每条都看得清是一条鱼在顶墙
  const DS = [[668, 16, 236], [722, 70, 204], [772, 28, 252], [814, 104, 190], [745, 150, 172]];
  DS.forEach(([dy, wx, len], i) => {
    add({ x: X_DAM + 220 + i * 150 + R() * 50, y: dy, L: len, era: 'down', mode: 'wall', wallX: X_DAM + DAM_W / 2 + 4 + wx, v: 62 + R() * 26, t0: T.modern - 3.0 - i * 0.2, tone: 0.78 + R() * 0.12 });
  });
  // 坝上游：朝墙的（下不去）
  add({ x: X_DAM - 30, y: 650, L: 240, dir: 1, era: 'up', mode: 'hover', tone: 0.8, fade0: T.L27.t + 0.05, fadeDur: 1.0, key: 'U1' });
  add({ x: X_DAM - 48, y: 792, L: 200, dir: 1, era: 'up', mode: 'hover', tone: 0.76, fade0: T.L27.t + 0.5, fadeDur: 1.0, key: 'U2' });
  // 上游一群：母鱼、小鱼、另外两条。L25 起往上游游，镜头跟着
  const follow0 = T.L25.t + 1.5;
  add({ x: X_DAM - 900, y: 632, L: 235, era: 'up', mode: 'follow', t0: follow0, tone: 0.8, fade0: T.L27.t + 0.35, fadeDur: 1.0, key: 'U3' });
  add({ x: X_DAM - 780, y: 806, L: 205, era: 'up', mode: 'follow', t0: follow0, tone: 0.78, fade0: T.L27.t + 1.05, fadeDur: 1.0, key: 'U4' });
  add({ x: X_DAM - 520, y: 716, L: 330, era: 'up', mode: 'follow', t0: follow0, tone: 0.86, fade0: T.L27.t + 1.8, fadeDur: 1.2, key: 'M' });
  add({ x: X_DAM - 300, y: 774, L: 118, era: 'up', mode: 'follow', t0: follow0, tone: 0.9, key: 'C' });
  return out;
}
function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 鱼在时刻 t 的吻尖位置与状态（纯函数） */
export function fishState(P, f, t) {
  let x = f.x, y = f.y;
  const bob = Math.sin(t * 0.55 + f.phase) * 2.2;
  let swim = 1;
  if (f.mode === 'drift') {
    x = f.x + f.dir * f.v * (t - f.tref) + Math.sin(t * 0.21 + f.phase) * 6;
  } else if (f.mode === 'wall') {
    const d = Math.max(0, t - f.t0) * f.v;
    const free = f.x - d;
    x = Math.max(f.wallX + 6 * Math.sin(t * 1.3 + f.phase) * (free < f.wallX ? 1 : 0), free);
    swim = free < f.wallX ? 1.25 : 1;
  } else if (f.mode === 'hover') {
    x = f.x + Math.sin(t * 0.8 + f.phase) * 5;
  } else if (f.mode === 'follow') {
    const c0 = P.panX(f.t0);
    const dx = P.panX(Math.max(t, f.t0)) - c0;
    x = f.x + dx + Math.sin(t * 0.25 + f.phase) * 4;
    // 结尾停住：游动幅度随镜头停下而收
    const tStop = P.T.L27.t + 3.25;
    swim = 1 - 0.85 * smooth((t - tStop + 0.4) / 1.4);
  }
  let alpha = 1;
  if (f.fade0 != null) alpha = 1 - smooth((t - f.fade0) / f.fadeDur);
  return { x, y: y + bob * (f.mode === 'follow' && t > P.T.L27.t + 3.25 ? 0.3 : 1), alpha, swim };
}
