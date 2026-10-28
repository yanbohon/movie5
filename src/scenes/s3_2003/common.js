// S3 各镜头共用的小画法：同心圆（信标的嘀）、水纹、墨点飞溅、淡墨的水、远山
import { CH } from './gl.js';
import { spline } from './curve.js';
import { clamp, lerp, mulberry32, noise1, hash1 } from '../../film/util.js';
import { PING_RING } from './events.js';

/** 一个圈（可以只画一段弧）。aspect<1 压扁成水面上的椭圆；arc 0..1 画多少。
 *  一笔兜一圈：起笔按下（粗、浓），走着走着提笔变细、变干，收笔处留一个小缺口 */
export function ring(ink, cx, cy, r, o = {}) {
  const arc = o.arc === undefined ? 0.94 : o.arc;
  if (arc <= 0.001 || r <= 0.5) return;
  const aspect = o.aspect === undefined ? 1 : o.aspect;
  const n = Math.max(24, Math.min(200, Math.round(r * ink.view.z * arc * 0.5)));
  const a0 = o.a0 || 0;
  const pts = new Float32Array((n + 1) * 2);
  const wob = o.wob === undefined ? 0.02 : o.wob;
  const sd = o.seed || 0;
  for (let i = 0; i <= n; i++) {
    const a = a0 + (i / n) * arc * Math.PI * 2;
    const rr = r * (1 + wob * noise1(a * 1.7 + sd * 7.1) + wob * 0.5 * noise1(a * 5.3 + sd));
    pts[2 * i] = cx + Math.cos(a) * rr;
    pts[2 * i + 1] = cy + Math.sin(a) * rr * aspect;
  }
  const w = o.w === undefined ? 3 : o.w;
  const K = o.ink === undefined ? 0.3 : o.ink, dry = o.dry === undefined ? 0.3 : o.dry;
  ink.stroke(pts, {
    w: (u) => w * (0.45 + 0.75 * Math.pow(1 - u, 0.8) * clamp(u * 12 + 0.35)) * (1 + 0.35 * noise1(u * 11 + sd)),
    ink: (u) => K * (1.15 - 0.45 * u) * (1 + 0.25 * noise1(u * 7 + sd * 3)),
    dry: (u) => clamp(dry + 0.35 * u + 0.12 * noise1(u * 9 + sd)),
    ch: o.ch || CH.dry, seed: sd, cap: o.cap === undefined ? 2 : o.cap, bsp: o.bsp || 1.2, rim: 0.4,
  });
}

/**
 * 信标的嘀：从 (x,y) 荡开一圈淡淡的同心圆（两道，一前一后）。age 秒；cutAge：从这一圈开始算，多少秒后被截断（圈断在半截，残弧很快散掉）
 * 每一圈是一笔：前沿一道干笔的线，里面跟一圈极淡的湿墨（水被推开的影子）
 */
export function pingRings(ink, x, y, age, o = {}) {
  const dur = o.dur || PING_RING;
  if (age < 0 || age > dur + 0.8) return;
  const rMax = o.rMax || 260, rMin = o.rMin || 10;
  const cutAge = o.cutAge;
  const sd = o.seed || 0;
  for (let k = 0; k < 2; k++) {
    let a = age - k * 0.22;
    if (a < 0) continue;
    let arc = 0.93, fadeCut = 1;
    if (cutAge !== undefined && a > cutAge - k * 0.22) {
      const since = a - (cutAge - k * 0.22);
      a = cutAge - k * 0.22;
      if (a < 0) continue;
      arc = Math.max(0, 0.42 - since * 0.5);
      fadeCut = Math.max(0, 1 - since / 0.6);
      if (fadeCut <= 0) continue;
    }
    if (a > dur) continue;
    const p = a / dur;
    const r = rMin + (rMax - rMin) * (1 - Math.pow(1 - p, 2.2));
    const alpha = Math.pow(1 - p, 1.2) * clamp(a / 0.06) * fadeCut * (k ? 0.55 : 1) * (o.soft ? clamp(p / o.soft) * (2 - clamp(p / o.soft)) : 1);
    const a0 = (o.a0 === undefined ? -1.9 : o.a0) + hash1(sd * 3.1 + k) * 1.2 - 0.6;
    const w = (o.w || 3.2) * (1 - 0.45 * p);
    ring(ink, x, y, r, { ink: (o.ink || 0.42) * alpha, w, ch: o.ch || CH.dry, aspect: o.aspect, arc, a0, seed: sd + k * 3.3, dry: 0.15 + 0.4 * p, wob: 0.018 });
    // 圈里面一层极淡的湿墨
    if (!o.noWash && arc > 0.3) ring(ink, x, y, r * 0.93, { ink: (o.ink || 0.42) * alpha * (o.wash === undefined ? 0.16 : o.wash), w: w * 4.5, ch: o.washCh || CH.wet, aspect: o.aspect, arc: arc * 0.97, a0: a0 + 0.1, seed: sd + k * 3.3 + 9, dry: 0.1, wob: 0.02, bsp: 4 });
  }
}

/** 预生成一串墨点（甩出去的墨/水花）：返回 [{dx,dy,r,delay,ink,ex,ey}] 相对坐标 */
export function makeSplatter(seed, n, { dir = 0, spread = Math.PI * 0.7, dist = 220, size = 7, far = 1.6 } = {}) {
  const R = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = dir + (R() - 0.5) * spread;
    const d = dist * (0.2 + Math.pow(R(), 0.7) * far);
    // 大小：多数是细点，少数大滴
    const big = R() < 0.12;
    const r = size * (big ? 1.1 + R() * 1.0 : 0.18 + Math.pow(R(), 2.0) * 0.8);
    out.push({ dx: Math.cos(a) * d, dy: Math.sin(a) * d, r, delay: R() * 0.07, ink: big ? 0.9 + R() * 0.8 : 0.35 + R() * 1.0, a, seed: R() * 100, tail: R() < 0.3 });
  }
  return out;
}
/** 画飞溅：age 秒。前 fly 秒墨点往外飞（略拉长），之后落定成点（湿边），慢慢略淡；有的带一小截拖尾 */
export function drawSplatter(ink, list, x, y, age, o = {}) {
  if (age < 0) return;
  const fly = o.fly || 0.16, sc = o.scale || 1;
  const ch = o.ch || CH.wet;
  for (const s of list) {
    const a = age - s.delay;
    if (a < 0) continue;
    const p = clamp(a / fly);
    const e = 1 - Math.pow(1 - p, 2.5);
    const px = x + s.dx * e * sc, py = y + s.dy * e * sc + (o.grav || 0) * a * a;
    const k = (o.ink || 1) * s.ink * (o.fade ? Math.max(0, 1 - a / o.fade) : 1);
    if (k <= 0.01) continue;
    const vx = Math.cos(s.a), vy = Math.sin(s.a);
    if (p < 1) {
      const len = s.r * sc * (0.6 + 1.6 * (1 - p));
      ink.blob(px, py, s.r * sc * (0.7 + 0.3 * p), { ch, ink: k, irr: 0.3, ex: -vx * len, ey: -vy * len, seed: s.seed });
    } else {
      ink.blob(px, py, s.r * sc, { ch, ink: k, irr: 0.32, seed: s.seed });
      if (s.tail && !o.noTail && s.r * sc > 2) {
        // 落定后的一小截拖尾（墨甩出去时拉出的细线）
        const tl = s.r * sc * 3.2;
        ink.stroke(new Float32Array([px - vx * tl, py - vy * tl, px - vx * s.r * sc * 0.5, py - vy * s.r * sc * 0.5]), { w: (u) => s.r * sc * lerp(0.15, 0.9, u), ink: k * 0.6, ch, dry: 0.3, seed: s.seed, cap: 2 });
      }
    }
  }
}

/** 一片淡墨的水/雾：横向的大笔，带飞白 */
export function washBand(ink, x0, x1, y, h, o = {}) {
  const pts = spline([[x0, y + (o.tilt || 0) * -0.5], [(x0 + x1) / 2, y + (o.sag || 0)], [x1, y + (o.tilt || 0) * 0.5]], 8);
  ink.stroke(pts, {
    w: (u) => h * (0.6 + 0.4 * Math.sin(Math.PI * clamp(u * 1.1))) * (1 + 0.25 * noise1(u * 4 + (o.seed || 0))),
    ink: (u) => (o.ink || 0.1) * (0.7 + 0.3 * Math.sin(u * 3 + (o.seed || 0))), dry: (u) => (o.dry || 0.35) + 0.3 * u, ch: o.ch || CH.wet, side: o.side || 0, rim: 0.5,
    bsp: o.bsp || 5, seed: o.seed || 0, cap: 4,
  });
}

/** 远山：一道起伏的淡墨（上缘清楚，下缘化开到水汽里） */
export function mountains(ink, x0, x1, base, hmax, o = {}) {
  const n = 40, sd = o.seed || 0;
  const top = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, x = lerp(x0, x1, u);
    const h = hmax * (0.45 + 0.35 * noise1(u * 3.1 + sd) + 0.2 * noise1(u * 9.7 + sd * 2)) * (0.7 + 0.3 * Math.sin(u * Math.PI));
    top.push([x, base - h]);
  }
  const pts = spline(top, 10);
  ink.stroke(pts, { wt: 2, wb: (u) => hmax * (0.5 + 0.2 * noise1(u * 5 + sd)), ch: o.ch || CH.wet, ink: o.ink || 0.18, dry: (u) => 0.08 + 0.25 * noise1(u * 3 + sd) * 0.5 + 0.1, side: 0.9, rim: 0.7, bsp: o.bsp || 6, seed: sd, cap: 0 });
}

/** 镜头参数插值用的混合 */
export function mixObj(a, b, k) {
  const o = { ...a };
  for (const key of Object.keys(b)) {
    const va = a[key], vb = b[key];
    if (va === undefined) o[key] = vb;
    else if (Array.isArray(va)) o[key] = va.map((x, i) => lerp(x, vb[i], k));
    else if (typeof va === 'number') o[key] = lerp(va, vb, k);
    else o[key] = k < 0.5 ? va : vb;
  }
  return o;
}

export const H1 = hash1;
