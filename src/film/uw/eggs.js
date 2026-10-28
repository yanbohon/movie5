// 卵：她产下的成千上万颗卵（白鲟的卵是沉性、粘性的，落到卵石上就粘住）。
// 建场景时用带种子的随机数算好每颗卵的一生：哪一股、哪一刻从泄殖孔出来、初速度、在水里怎么沉、
// 被水流带多远、落在哪块卵石的哪一处。每帧按 t 现算位置（纯函数，没有任何累积状态）。
// 真实视角：EggBeads 画成半透明的淡琥珀色小珠子（背光时透亮、带一点湿的高光；死去的卵发白、不透）。
// 电感视觉：每颗卵一点琥珀色的光，交给 glow.js 的 GlowBlobs（景深之后叠加）；亮度与熄灭时刻由场景按 t 给。
import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { mulberry32, clamp, smooth, noise1 } from '../util.js';

const expInt = (k, t) => (1 - Math.exp(-k * t)) / k; // ∫0..t e^(-k s) ds

/**
 * 卵石顶面：读 Riverbed 的卵石实例矩阵，每块石头近似成一个旋转的椭球（rockGeometry 是压扁 0.62 的二十面体）。
 * 返回 top(x, z)：该处最高的石头表面高度，没有石头返回 -Infinity。
 */
export function stoneTops(mesh, { flat = 0.62, shrink = 0.94, cell = 0.3 } = {}) {
  const n = mesh.count;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), ps = new THREE.Vector3(), sc = new THREE.Vector3();
  const R = new THREE.Matrix3(), S = new THREE.Matrix3(), M = new THREE.Matrix3(), Rt = new THREE.Matrix3();
  const stones = [];
  const grid = new Map();
  const key = (i, j) => i * 100003 + j;
  for (let i = 0; i < n; i++) {
    mesh.getMatrixAt(i, m4);
    m4.decompose(ps, q, sc);
    const ax = sc.x * shrink, ay = sc.y * flat * shrink, az = sc.z * shrink;
    R.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
    Rt.copy(R).transpose();
    S.set(1 / (ax * ax), 0, 0, 0, 1 / (ay * ay), 0, 0, 0, 1 / (az * az));
    M.multiplyMatrices(R, S).multiply(Rt); // M = R S^-2 R^T
    const e = M.elements; // 列主序
    const st = { x: ps.x, y: ps.y, z: ps.z, mxx: e[0], mxy: e[3], mxz: e[6], myy: e[4], myz: e[7], mzz: e[8], rr: Math.max(ax, ay, az) };
    stones.push(st);
    const i0 = Math.floor((ps.x - st.rr) / cell), i1 = Math.floor((ps.x + st.rr) / cell);
    const j0 = Math.floor((ps.z - st.rr) / cell), j1 = Math.floor((ps.z + st.rr) / cell);
    for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) {
      const k = key(a, b);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(st);
    }
  }
  return (x, z) => {
    const list = grid.get(key(Math.floor(x / cell), Math.floor(z / cell)));
    if (!list) return -Infinity;
    let best = -Infinity;
    for (const s of list) {
      const dx = x - s.x, dz = z - s.z;
      // (dx, e, dz)ᵀ M (dx, e, dz) = 1，解 e 的上根
      const A = s.myy, B = 2 * (s.mxy * dx + s.myz * dz), C = s.mxx * dx * dx + 2 * s.mxz * dx * dz + s.mzz * dz * dz - 1;
      const D = B * B - 4 * A * C;
      if (D < 0) continue;
      const y = s.y + (-B + Math.sqrt(D)) / (2 * A);
      if (y > best) best = y;
    }
    return best;
  };
}

export class EggCloud {
  /**
   * n 卵数；seed 随机种子
   * vent(t) → { p, v, T, B, N }：t 时刻泄殖孔的世界位置、速度、身体的前 / 上 / 横方向（建场景时按表采样；场景保证它是 t 的纯函数）
   * spurts [{ t, dur, w }]：分几股排出（w 权重）；每股开头最猛
   * ground(x, z)：那一处能粘住卵的最高面（卵石顶或河床）
   * sink 下沉终速范围（米/秒）；drag 阻尼（1/秒）；eject 喷出速度范围；carry 继承她身体速度的比例；
   * current 水流（米/秒）；drift 每颗卵各自被乱流带走的水平速度（高斯分布的标准差，米/秒，会留在落点里）；
   * turb 水里乱流造成的来回摆动（米，落地时归零）；radius 卵半径范围（米）
   */
  constructor({ n = 20000, seed = 7, vent, spurts, ground, sink = [0.05, 0.09], drag = 2.0, eject = [0.04, 0.32],
    carry = 0.35, current = [0.04, 0, 0.012], drift = 0, turb = 0.1, radius = [0.0014, 0.0019] }) {
    const rnd = mulberry32(seed);
    this.n = n;
    this.current = current;
    this.turb = turb;
    // 泄殖孔轨迹表（100 Hz）
    const t0 = Math.min(...spurts.map((s) => s.t)) - 0.05, t1 = Math.max(...spurts.map((s) => s.t + s.dur)) + 0.05;
    const dt = 0.01;
    const tab = [];
    for (let t = t0; t <= t1 + dt; t += dt) tab.push(vent(t));
    const ventAt = (t) => {
      const f = clamp((t - t0) / dt, 0, tab.length - 1.001);
      const i = Math.floor(f), k = f - i, a = tab[i], b = tab[i + 1];
      const L = (u, w) => u.clone().lerp(w, k);
      return { p: L(a.p, b.p), v: L(a.v, b.v), T: L(a.T, b.T).normalize(), B: L(a.B, b.B).normalize(), N: L(a.N, b.N).normalize() };
    };
    const te = (this.te = new Float64Array(n));
    const P0 = (this.p0 = new Float64Array(n * 3)), V0 = (this.v0 = new Float64Array(n * 3));
    const K = (this.k = new Float32Array(n)), VS = (this.vs = new Float32Array(n));
    const TL = (this.tl = new Float64Array(n)), PL = (this.pl = new Float64Array(n * 3));
    const RR = (this.r = new Float32Array(n)), NS = (this.ns = new Float32Array(n * 2)), RN = (this.rn = new Float32Array(n * 2));
    const DW = (this.dw = new Float32Array(n * 2));
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
    this.spurt = new Uint8Array(n);
    const wsum = spurts.reduce((a, s) => a + s.w, 0);
    const cum = [];
    let acc = 0;
    for (const s of spurts) { acc += s.w / wsum; cum.push(acc); }
    for (let i = 0; i < n; i++) {
      const pick = rnd();
      let si = cum.findIndex((c) => pick <= c);
      if (si < 0) si = spurts.length - 1;
      const S = spurts[si];
      this.spurt[i] = si;
      const x = Math.pow(rnd(), 1.6);              // 每股开头最猛，后面拖一点
      te[i] = S.t + S.dur * x;
      const V = ventAt(te[i]);
      // 喷出方向：往下、往后、向两侧散开；越往股尾越软
      const side = (rnd() - 0.5) * 2, back = 0.25 + 0.75 * rnd(), down = 0.5 + 0.5 * rnd();
      const dir = V.T.clone().multiplyScalar(-back).addScaledVector(V.B, -down).addScaledVector(V.N, side * 1.5)
        .add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.5)).normalize();
      const sp = (eject[0] + (eject[1] - eject[0]) * rnd() * rnd()) * (1.15 - 0.6 * x);
      const v0 = dir.multiplyScalar(sp).addScaledVector(V.v, carry);
      // 从泄殖孔周围一小团出来（卵是一团一团挤出来的）
      const p0 = V.p.clone().addScaledVector(V.N, (rnd() - 0.5) * 0.03).addScaledVector(V.T, (rnd() - 0.5) * 0.03);
      P0.set([p0.x, p0.y, p0.z], i * 3);
      V0.set([v0.x, v0.y, v0.z], i * 3);
      K[i] = drag * (0.7 + 0.6 * rnd());
      VS[i] = sink[0] + (sink[1] - sink[0]) * rnd();
      RR[i] = radius[0] + (radius[1] - radius[0]) * rnd();
      NS[i * 2] = rnd() * 1000; NS[i * 2 + 1] = rnd() * 1000;
      RN[i * 2] = rnd(); RN[i * 2 + 1] = rnd();
      DW[i * 2] = drift * gauss(); DW[i * 2 + 1] = drift * gauss();
      // 落点：沿轨迹往后找第一次碰到卵石 / 河床的时刻（先粗走再二分）
      const out = new THREE.Vector3();
      const below = (tau) => { this._traj(i, tau, out, false); return out.y - RR[i] - ground(out.x, out.z); };
      let a = 0, b = -1;
      for (let tau = 0.1; tau < 60; tau += 0.1) { if (below(tau) <= 0) { b = tau; break; } a = tau; }
      if (b < 0) { TL[i] = Infinity; continue; }
      for (let it = 0; it < 12; it++) { const m = 0.5 * (a + b); if (below(m) <= 0) b = m; else a = m; }
      TL[i] = b;
      this._traj(i, b, out, false);
      PL.set([out.x, ground(out.x, out.z) + RR[i] * 0.8, out.z], i * 3);
    }
    this.pos = new Float32Array(n * 4);
  }
  /** 第 i 颗卵出来 tau 秒后的位置（在水里那段；turb 为 false 时不含乱流漂移） */
  _traj(i, tau, out, turb = true) {
    const k = this.k[i], e = expInt(k, tau), c = this.current, P = this.p0, V = this.v0, j = i * 3, W = this.dw;
    out.set(
      P[j] + V[j] * e + (c[0] + W[i * 2]) * tau,
      P[j + 1] + V[j + 1] * e + c[1] * tau - this.vs[i] * (tau - e),
      P[j + 2] + V[j + 2] * e + (c[2] + W[i * 2 + 1]) * tau,
    );
    if (turb && this.turb > 0) {
      const g = smooth(tau / 0.9) * clamp((this.tl[i] - tau) / 1.4);
      out.x += this.turb * g * noise1(this.ns[i * 2] + tau * 0.42);
      out.z += this.turb * g * noise1(this.ns[i * 2 + 1] + tau * 0.42);
    }
    return out;
  }
  /** 第 i 颗卵在 t 时刻的位置；还没出来返回 null；落地后固定在落点 */
  at(i, t, out = new THREE.Vector3()) {
    const tau = t - this.te[i];
    if (tau < 0) return null;
    if (tau >= this.tl[i]) { const j = i * 3; return out.set(this.pl[j], this.pl[j + 1], this.pl[j + 2]); }
    return this._traj(i, tau, out);
  }
  /** 第 i 颗卵在 t 时刻是否已经落地 */
  landed(i, t) { return t - this.te[i] >= this.tl[i]; }
  /** 算好这一帧所有卵的位置：this.pos = [x, y, z, 1 可见 / 0 没出来] */
  update(t) {
    const out = new THREE.Vector3(), pos = this.pos;
    for (let i = 0; i < this.n; i++) {
      const p = this.at(i, t, out);
      const j = i * 4;
      if (!p) { pos[j + 3] = 0; continue; }
      pos[j] = p.x; pos[j + 1] = p.y; pos[j + 2] = p.z; pos[j + 3] = 1;
    }
    return pos;
  }
}

// ---- 真实视角：半透明的小珠子（按屏幕上的大小画成一个球的替身）----
const BEAD_VERT = /* glsl */ `
${COMMON}
attribute vec4 aP;     // xyz 世界位置，w 半径（米）；w <= 0 不画
attribute vec2 aK;     // 两个随机数
uniform float uViewH;
uniform float uTanHalf;
uniform float uMinPx;  // 画出来至少这么大（像素半径），更小的按面积减淡
varying vec2 vQ;
varying vec3 vW;
varying vec2 vK;
varying float vFade;
void main() {
  vQ = position.xy; vK = aK; vW = aP.xyz; vFade = 0.0;
  if (aP.w <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec4 mv = viewMatrix * vec4(aP.xyz, 1.0);
  float dist = -mv.z;
  float pxPerM = uViewH / (2.0 * uTanHalf * max(dist, 0.02));
  float want = aP.w * pxPerM;
  float rad = max(want, uMinPx);
  vFade = min(1.0, want * want / (uMinPx * uMinPx)) * smoothstep(0.03, 0.1, dist);
  mv.xy += position.xy * rad / pxPerM;
  gl_Position = projectionMatrix * mv;
}
`;
const BEAD_FRAG = /* glsl */ `
${COMMON}
uniform vec3 uCamX;
uniform vec3 uCamY;
uniform vec3 uCamZ;
uniform float uDead;     // 0 新鲜（淡琥珀、半透明）… 1 死了（发白、不透）
uniform float uBoost;    // 真实视角里卵接到的光（夜里略补，让它们「接一点光」）
uniform float uOpacity;
varying vec2 vQ;
varying vec3 vW;
varying vec2 vK;
varying float vFade;
void main() {
  float r2 = dot(vQ, vQ);
  if (r2 > 1.0 || vFade <= 0.0) discard;
  float em = electroMask(vW);
  if (em > 0.995) discard;
  vec3 nv = vec3(vQ, sqrt(1.0 - r2));
  vec3 N = normalize(uCamX * nv.x + uCamY * nv.y + uCamZ * nv.z);
  vec3 V = normalize(uCamPos - vW);
  vec3 L = uSunDir;
  vec3 Li = lightAt(vW) * uBoost;
  float depth = max(uSurfaceY - vW.y, 0.0);
  float att = exp(-uSigmaLight * depth * 0.6);
  vec3 amb = mix(uAmbDown, uAmbUp, N.y * 0.5 + 0.5) * att * uBoost;
  float thick = sqrt(1.0 - r2);                          // 中间厚、边缘薄
  float dead = clamp(uDead * (0.55 + 0.9 * vK.y), 0.0, 1.0);
  // 新鲜的卵：淡琥珀，光从背后穿过来时整颗透亮，中间有一点更深的卵黄
  vec3 amber = vec3(0.7, 0.47, 0.2) * (0.85 + 0.3 * vK.x);
  float diff = max(0.0, (dot(N, L) + 0.6) / 1.6);
  float trans = 0.35 + 1.4 * pow(max(dot(-V, L), 0.0), 2.0);
  vec3 fresh = amber * (Li * diff * 0.45 + amb * 1.2) + amber * amber * Li * trans * (0.35 + 0.65 * thick);
  vec3 H = normalize(L + V);
  fresh += Li * pow(max(dot(N, H), 0.0), 70.0) * 1.2;   // 湿的高光
  fresh += mix(uFogDown, uFogUp, 0.7) * pow(max(1.0 - thick, 0.0), 2.0) * 1.5 * uBoost; // 边缘一圈淡淡的反光
  // 死了的卵：蛋白凝住，发白、不透
  vec3 deadc = vec3(0.6, 0.58, 0.52) * (Li * diff + amb * 1.5);
  vec3 col = mix(fresh, deadc, dead);
  col = applyWater(col, vW);
  float a = mix(0.5 + 0.4 * thick, 0.97, dead) * vFade * uOpacity * (1.0 - em);
  if (a < 0.004) discard;
  gl_FragColor = vec4(col * a, a);
}
`;

export class EggBeads {
  constructor(water, cloud, { minPx = 0.7, renderOrder = 4 } = {}) {
    this.cloud = cloud;
    const n = cloud.n;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.P = new Float32Array(n * 4);
    this.aP = new THREE.InstancedBufferAttribute(this.P, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aP', this.aP);
    g.setAttribute('aK', new THREE.InstancedBufferAttribute(cloud.rn, 2));
    g.instanceCount = n;
    this.u = {
      uViewH: { value: 1080 }, uTanHalf: { value: 0.3 }, uMinPx: { value: minPx },
      uCamX: { value: new THREE.Vector3() }, uCamY: { value: new THREE.Vector3() }, uCamZ: { value: new THREE.Vector3() },
      uDead: { value: 0 }, uBoost: { value: 1 }, uOpacity: { value: 1 },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...water, ...this.u }, vertexShader: BEAD_VERT, fragmentShader: BEAD_FRAG,
      transparent: true, depthWrite: true, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
  }
  /** 拿 cloud.update(t) 算好的位置；dead 0..1 死卵外观，boost 亮度补偿 */
  update(cam, { dead = 0, boost = 1, opacity = 1, visible = true } = {}) {
    const c = this.cloud, P = this.P, pos = c.pos;
    this.mesh.visible = visible;
    for (let i = 0; i < c.n; i++) {
      const j = i * 4;
      P[j] = pos[j]; P[j + 1] = pos[j + 1]; P[j + 2] = pos[j + 2]; P[j + 3] = pos[j + 3] > 0 ? c.r[i] : 0;
    }
    this.aP.needsUpdate = true;
    const u = this.u;
    u.uTanHalf.value = Math.tan((cam.fov * Math.PI) / 360);
    const e = cam.matrixWorld.elements;
    u.uCamX.value.set(e[0], e[1], e[2]).normalize();
    u.uCamY.value.set(e[4], e[5], e[6]).normalize();
    u.uCamZ.value.set(e[8], e[9], e[10]).normalize();
    u.uDead.value = dead; u.uBoost.value = boost; u.uOpacity.value = opacity;
  }
}
