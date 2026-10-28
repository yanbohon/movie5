// S6 / S7 共用的卵石滩：河床与卵石、她在滩上的姿态（歇着 → 起身产卵 → 悬停 → 沉下去）、她产下的卵。
// 两场用同一套数（同样的种子、同一张时刻表），所以 S7 黎明时她身边那些熄灭的卵，就是 S6 里落下的那些。
import * as THREE from 'three';
import { Riverbed, bedHeight } from '../../film/uw/bed.js';
import { Path } from '../../film/uw/fish.js';
import { swimTrack } from '../../film/uw/motion.js';
import { EggCloud, stoneTops } from '../../film/uw/eggs.js';
import { clamp, smooth, lerp, win } from '../../film/util.js';
import { s6Times } from './events.js';
import { s7Times } from '../s7_end/events.js';

// 卵石滩：中心、平均深度、卵石铺开的半径
export const BANK = { x: -14, z: 10, base: -8.6, r: 10 };
export const EGG_N = 16000;

export function makeBank(water) {
  const bed = new Riverbed(water, {
    base: BANK.base, center: [BANK.x, BANK.z], size: 90, seg: 450, rocks: 44, rockRegion: 64, seed: 6,
    gravel: { center: [BANK.x, BANK.z], r: BANK.r, n: 20000, smooth: true },
  });
  const tops = stoneTops(bed.gravelMesh);
  const ground = (x, z) => Math.max(bed.surface(x, z), tops(x, z));
  return { bed, tops, ground };
}

/** 她在卵石滩上的一切动作（S6 的等待 / 产卵 / 悬停，S7 的沉落 / 最后）都是 t 的纯函数 */
export class HerOnBank {
  constructor(fish, tl, bank) {
    this.fish = fish;
    const L = (this.L = fish.L), P = (this.P = fish.P);
    const T6 = (this.T6 = s6Times(tl)), T7 = (this.T7 = s7Times(tl));
    // 水平面上的基准路线：歇着时吻尖在 uR，头朝上游（-x）；起身后往左前方缓缓转、悬停
    const X = BANK.x - 1.1, Z = BANK.z - 0.2;
    const pts = [];
    let x = X + 6, z = Z, th = 0;
    for (let u = -6; u <= 14.001; u += 0.25) {
      pts.push([x, 0, z]);
      const k = u < 0.6 ? 0 : 0.2 * smooth((u - 0.6) / 1.5) * (1 - smooth((u - 3.6) / 2.5));
      th += k * 0.25;
      x -= Math.cos(th) * 0.25;
      z += Math.sin(th) * 0.25;
    }
    this.base = new Path(pts, { samples: 3000 });
    this.uR = 6;                                   // 歇着时吻尖的路程
    // 趴下时身体底下的「支撑面」：沿路线每 2 厘米取身体两侧最高的卵石顶，再平滑——她躺在卵石上，吻搭在石头上
    this.gStep = 0.02; this.gU0 = -6;
    const nG = Math.round(20 / this.gStep) + 1, raw = new Float32Array(nG), sm = new Float32Array(nG);
    const q = new THREE.Vector3(), q2 = new THREE.Vector3();
    for (let k = 0; k < nG; k++) {
      const uq = this.gU0 + k * this.gStep;
      this.base.pos(uq, q); this.base.pos(uq + 0.05, q2);
      const tx = q2.x - q.x, tz = q2.z - q.z, tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl;
      let m = -Infinity;
      for (const o of [-0.11, -0.055, 0, 0.055, 0.11]) m = Math.max(m, bank.ground(q.x + nx * o, q.z + nz * o));
      raw[k] = m;
    }
    for (let k = 0; k < nG; k++) {                 // 先取 ±6 厘米里的最高，再在 ±14 厘米里平均
      let mx = -Infinity;
      for (let j = -3; j <= 3; j++) mx = Math.max(mx, raw[Math.min(nG - 1, Math.max(0, k + j))]);
      sm[k] = mx;
    }
    this.gRest = new Float32Array(nG);
    for (let k = 0; k < nG; k++) {
      let a = 0;
      for (let j = -7; j <= 7; j++) a += sm[Math.min(nG - 1, Math.max(0, k + j))];
      this.gRest[k] = a / 15;
    }
    // 游速关键帧：歇着 → 起身产卵（边游边排）→ 放慢、悬停 → S7 几乎不动
    this.track = swimTrack([
      [T6.wait - 1, 0], [T6.release - 0.9, 0], [T6.release + 0.6, 0.2], [T6.spurtEnd - 0.8, 0.14],
      [T6.spurtEnd + 0.8, 0], [T6.glow + 5, -0.06], [T6.dark, -0.04], [T7.sink, -0.02], [T7.touch, 0], [T7.end + 1, 0],
    ], { t0: T6.wait - 1, t1: T7.end + 1, f0: 0.16, k: 0.9 });
    // 悬停时身体所在的水平面（离卵石多高）
    const hov = this.base.pos(this.uR + 1.6);
    this.gH = bedHeight(hov.x, hov.z, BANK.base);
    this._p = new THREE.Vector3();
    const self = this;
    // 身体的路径：水平位置取基准路线；高度按身体上每一处（s）算：趴着时贴着卵石，浮起时是一条水平线
    this.path = {
      t: 0,
      pos(uq, out = new THREE.Vector3()) {
        self.base.pos(uq, out);
        const t = this.t;
        const s = (self.uTip - uq) / L;
        const sc = clamp(s);
        const rest = self.restGround(uq) + (P.hd(sc) - P.c(sc)) * L + 0.004;
        const lift = self.lift(sc, t);
        if (lift <= 0) { out.y = rest; return out; }
        const hover = self.gH + self.height(t) - 0.06 * (0.5 - sc) + self.bob(t);
        out.y = lerp(rest, hover, lift);
        return out;
      },
    };
  }
  /** 路线上 uq 处趴下时的支撑高度（卵石顶） */
  restGround(uq) {
    const f = Math.min(this.gRest.length - 1.001, Math.max(0, (uq - this.gU0) / this.gStep));
    const i = Math.floor(f), k = f - i;
    return this.gRest[i] * (1 - k) + this.gRest[i + 1] * k;
  }
  /** 身体离开卵石的程度（s 处，0 趴着，1 浮着）：起身时头先起来；S7 沉下去时腹部先落、吻最后搭到石头上 */
  lift(s, t) {
    const { T6, T7 } = this;
    if (t < T6.release - 1.4) return 0;
    if (t < T7.start) return smooth((t - T6.release + 1.3 - s * 0.7) / 1.7);
    return 1 - smooth((t - T7.sink - 0.2 - Math.abs(s - 0.55) * 2.6) / 5.2);
  }
  /** 浮起时脊柱离卵石的高度（米） */
  height(t) {
    const { T6, T7 } = this;
    const a = smooth((t - T6.release + 0.8) / 2.4);
    const b = smooth((t - T6.spurtEnd) / 3.0);
    const c = smooth((t - T6.glow - 3) / (T7.sink - T6.glow - 3));
    return 0.44 + 0.22 * a - 0.1 * b - 0.1 * c;
  }
  bob(t) { return 0.012 * Math.sin(t * 1.45) + 0.006 * Math.sin(t * 2.33 + 1.0); }
  /** 吻尖此刻的路程 */
  tipU(t) { return this.uR + this.track.u(t); }
  /** 摆尾相位：S6 按游速积分；S7 越来越慢 */
  phase(t) {
    const { T7 } = this;
    if (t < T7.start) return this.track.phase(t);
    const x = t - T7.start, tau = 8.0, f = 0.3;
    return this.track.phase(T7.start) + 2 * Math.PI * f * tau * (1 - Math.exp(-x / tau));
  }
  /** 产卵时身体的轻颤（每股开头最强） */
  quiver(t) {
    let q = 0;
    for (const s of this.T6.spurts) q = Math.max(q, win(t, s.t - 0.05, s.t + 0.05, s.t + 0.15, s.t + s.dur + 0.1) * s.w);
    return q;
  }
  /** 摆好这一刻的姿态；extra：heart、life、poreGlow、bodyGlow、breath 等覆盖 */
  pose(t, extra = {}) {
    const { T6, T7 } = this;
    this.uTip = this.tipU(t);
    this.path.t = t;
    const sp = this.track.speed(t);
    const q = this.quiver(t);
    const hovering = smooth((t - T6.release + 1.4) / 1.0);
    let pect = lerp(0.006, 0.03 + 0.05 * clamp(sp / 0.3), hovering);
    let breath = extra.breath ?? (0.5 + 0.5 * Math.sin(t * 1.1));
    if (t >= T7.start) {
      const x = t - T7.start;
      pect = 0.032 * Math.exp(-x / 9);
    }
    this.fish.update({
      path: this.path, u: this.uTip, phase: this.phase(t),
      amp: lerp(0.003, 0.02 + 0.07 * clamp(sp / 0.3), hovering) * (t >= T7.start ? Math.exp(-(t - T7.start) / 4) : 1),
      lambda: 0.95, bend: 0.012 * q * Math.sin(t * 2 * Math.PI * 7.3), headPitch: 0,
      pect, flutter: lerp(0.004, 0.012, hovering), breath,
      heart: extra.heart ?? 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.85),
      life: extra.life ?? 1, poreGlow: extra.poreGlow ?? 1.1, bodyGlow: extra.bodyGlow ?? 1, time: t,
    });
  }
  /** 泄殖孔：位置、速度、身体的前 / 上 / 横方向（建场景时给卵用） */
  vent(t) {
    const f = this.fish, P = this.P, L = this.L, s = 0.66;
    const at = (tt) => { this.pose(tt); return f.pointAt(s, 0, (P.c(s) - P.hd(s)) * L); };
    const p0 = at(t - 0.01), p1 = at(t + 0.01);
    const p = at(t);
    const T = f.pointAt(s - 0.02).sub(f.pointAt(s + 0.02)).normalize();
    const B = f.pointAt(s, 0, 0.1).sub(f.pointAt(s)).normalize();
    const N = f.pointAt(s, 0.1, 0).sub(f.pointAt(s)).normalize();
    return { p, v: p1.sub(p0).multiplyScalar(50), T, B, N };
  }
}

// 两场共用同一团卵（建一次）
let _cloud = null;
export function bankEggs(her, ground) {
  if (_cloud) return _cloud;
  const T6 = her.T6;
  _cloud = new EggCloud({
    n: EGG_N, seed: 7, spurts: T6.spurts, ground, vent: (t) => her.vent(t),
    sink: [0.07, 0.13], drag: 1.6, eject: [0.06, 0.46], carry: 0.3, current: [0.05, 0, 0.015], drift: 0.15, turb: 0.2,
  });
  return _cloud;
}
