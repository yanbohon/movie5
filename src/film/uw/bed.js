// 河床：起伏的泥沙底（JS 与 GLSL 同一个高度函数，方便摆放东西）、大石头、产卵场的卵石滩。
import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { mulberry32 } from '../util.js';

// 河床高度（米）：只用 sin/cos，JS 与 GLSL 完全一致
export function bedHeight(x, z, base = -12) {
  return base
    + 0.9 * Math.sin(0.061 * x + 0.3) * Math.cos(0.047 * z - 0.8)
    + 0.45 * Math.sin(0.13 * x + 0.21 * z + 1.7)
    + 0.22 * Math.cos(0.29 * x - 0.17 * z + 0.4)
    + 0.08 * Math.sin(0.71 * x + 0.53 * z);
}
// ---- JS 版的 3D simplex 噪声（与 glsl.js 的 snoise 同一算法），给摆放东西用 ----
const m289 = (x) => x - Math.floor(x * (1 / 289)) * 289;
const perm = (x) => m289((x * 34 + 10) * x);
export function snoise3(vx, vy, vz) {
  const C0 = 1 / 6, C1 = 1 / 3;
  const s = (vx + vy + vz) * C1;
  let ix = Math.floor(vx + s), iy = Math.floor(vy + s), iz = Math.floor(vz + s);
  const t = (ix + iy + iz) * C0;
  const x0 = vx - ix + t, y0 = vy - iy + t, z0 = vz - iz + t;
  const gx = x0 >= y0 ? 1 : 0, gy = y0 >= z0 ? 1 : 0, gz = z0 >= x0 ? 1 : 0;
  const lx = 1 - gx, ly = 1 - gy, lz = 1 - gz;
  const i1x = Math.min(gx, lz), i1y = Math.min(gy, lx), i1z = Math.min(gz, ly);
  const i2x = Math.max(gx, lz), i2y = Math.max(gy, lx), i2z = Math.max(gz, ly);
  const x1 = x0 - i1x + C0, y1 = y0 - i1y + C0, z1 = z0 - i1z + C0;
  const x2 = x0 - i2x + C1, y2 = y0 - i2y + C1, z2 = z0 - i2z + C1;
  const x3 = x0 - 0.5, y3 = y0 - 0.5, z3 = z0 - 0.5;
  ix = m289(ix); iy = m289(iy); iz = m289(iz);
  const pz = [0, i1z, i2z, 1].map((o) => perm(iz + o));
  const py = [0, i1y, i2y, 1].map((o, k) => perm(pz[k] + iy + o));
  const p = [0, i1x, i2x, 1].map((o, k) => perm(py[k] + ix + o));
  const n_ = 0.142857142857, nsx = 2 * n_, nsy = 0.5 * n_ - 1, nsz = n_;
  const X = [x0, x1, x2, x3], Y = [y0, y1, y2, y3], Z = [z0, z1, z2, z3];
  let sum = 0;
  for (let k = 0; k < 4; k++) {
    const j = p[k] - 49 * Math.floor(p[k] * nsz * nsz);
    const xx = Math.floor(j * nsz), yy = Math.floor(j - 7 * xx);
    const x = xx * nsx + nsy, y = yy * nsx + nsy;
    const h = 1 - Math.abs(x) - Math.abs(y);
    const sh = h <= 0 ? -1 : 0;
    const gxk = x + (Math.floor(x) * 2 + 1) * sh, gyk = y + (Math.floor(y) * 2 + 1) * sh, gzk = h;
    const nrm = 1.79284291400159 - 0.85373472095314 * (gxk * gxk + gyk * gyk + gzk * gzk);
    let m = Math.max(0.5 - (X[k] * X[k] + Y[k] * Y[k] + Z[k] * Z[k]), 0);
    m *= m;
    sum += m * m * nrm * (gxk * X[k] + gyk * Y[k] + gzk * Z[k]);
  }
  return 105 * sum;
}
// 河床网格顶点的真实高度（含着色器里的沙纹和细碎起伏）
function bedVertexH(x, z, base) {
  const rip = Math.sin(2.1 * x + 0.7 * z + snoise3(x * 0.3, z * 0.3, 1.0) * 2.0) * 0.012;
  const fine = snoise3(x * 1.7, z * 1.7, 3.0) * 0.035 + snoise3(x * 5.0, z * 5.0, 7.0) * 0.012;
  return bedHeight(x, z, base) + rip + fine;
}
const BED_H_GLSL = /* glsl */ `
uniform float uBedBase;
float bedH(vec2 p) {
  float x = p.x, z = p.y;
  return uBedBase
    + 0.9 * sin(0.061 * x + 0.3) * cos(0.047 * z - 0.8)
    + 0.45 * sin(0.13 * x + 0.21 * z + 1.7)
    + 0.22 * cos(0.29 * x - 0.17 * z + 0.4)
    + 0.08 * sin(0.71 * x + 0.53 * z);
}
`;

const BED_VERT = /* glsl */ `
${COMMON}
${BED_H_GLSL}
varying vec3 vW;
varying float vFine;
void main() {
  vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
  float h = bedH(p.xz);
  // 沙纹 + 细碎起伏
  float rip = sin(dot(p.xz, vec2(2.1, 0.7)) + snoise(vec3(p.xz * 0.3, 1.0)) * 2.0) * 0.012;
  float fine = snoise(vec3(p.xz * 1.7, 3.0)) * 0.035 + snoise(vec3(p.xz * 5.0, 7.0)) * 0.012;
  p.y = h + rip + fine;
  vFine = fine;
  vW = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;
const BED_FRAG = /* glsl */ `
${COMMON}
${BED_H_GLSL}
uniform float uGravel;       // 卵石滩区域强度（中心、半径）
uniform vec3 uGravelC;
uniform float uGravelR;
varying vec3 vW;
varying float vFine;
void main() {
  vec3 p = vW;
  // 用高度场的差分求法线（含细节噪声）
  float e = 0.05;
  float hx = bedH(p.xz + vec2(e, 0.0)) - bedH(p.xz - vec2(e, 0.0));
  float hz = bedH(p.xz + vec2(0.0, e)) - bedH(p.xz - vec2(0.0, e));
  vec3 N = normalize(vec3(-hx / (2.0 * e), 1.0, -hz / (2.0 * e)));
  vec3 bump = vec3(snoise(vec3(p.xz * 6.0, 1.0)), 0.0, snoise(vec3(p.xz * 6.0, 4.0)));
  N = normalize(N + bump * 0.18);
  // 泥沙颜色：灰黄，有深浅斑块、零星的碎石点
  float m = fbm3(vec3(p.xz * 0.35, 2.0));
  vec3 alb = mix(vec3(0.16, 0.135, 0.095), vec3(0.24, 0.205, 0.15), 0.5 + 0.5 * m);
  float pebble = smoothstep(0.62, 0.8, snoise(vec3(p.xz * 9.0, 11.0)));
  alb = mix(alb, vec3(0.11, 0.1, 0.085), pebble * 0.6);
  float g = uGravel * (1.0 - smoothstep(uGravelR * 0.6, uGravelR, length(p.xz - uGravelC.xz)));
  alb = mix(alb, vec3(0.2, 0.19, 0.17), g * 0.5);
  vec3 V = normalize(uCamPos - p);
  vec3 Li = lightAt(p);
  float depth = max(uSurfaceY - p.y, 0.0);
  float att = exp(-uSigmaLight * depth * 0.6);
  float diff = max(dot(N, uSunDir), 0.0) * 0.8 + 0.2;
  vec3 amb = mix(uAmbDown, uAmbUp, N.y * 0.5 + 0.5) * att;
  vec3 col = alb * (Li * diff + amb);
  col = applyWater(col, p);
  // 电感视觉：等高线 + 石缝里极淡的噪声
  float hh = p.y * 4.0;
  float iso = pow(max(1.0 - abs(fract(hh) - 0.5) * 2.0, 0.0), 24.0);
  vec3 ec = E_BG + E_DEEP * iso * 0.22 + E_DEEP * 0.02 * (0.5 + 0.5 * vFine * 20.0);
  ec *= electroFade(p);
  if (uEWorldR > 0.0) ec *= electroWorld(p);
  float em = electroMask(p);
  col = mix(col, ec, em);
  col += E_CORE * electroRing(p) * 1.4;
  gl_FragColor = vec4(col, 1.0);
}
`;

const ROCK_VERT = /* glsl */ `
${COMMON}
varying vec3 vW;
varying vec3 vN;
varying vec3 vL;
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vL = position;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const ROCK_FRAG = /* glsl */ `
${COMMON}
uniform vec3 uTint;
varying vec3 vW;
varying vec3 vN;
varying vec3 vL;
void main() {
  vec3 p = vW;
  vec3 N = normalize(vN);
  vec3 bump = vec3(snoise(vL * 7.0), snoise(vL * 7.0 + 3.0), snoise(vL * 7.0 + 6.0));
  N = normalize(N + bump * 0.25);
  float m = fbm3(vL * 2.5 + 1.0);
  vec3 alb = uTint * (0.75 + 0.35 * m);
  // 顶上积了泥
  alb = mix(alb, vec3(0.2, 0.17, 0.12), smoothstep(0.5, 0.95, N.y) * 0.7);
  vec3 V = normalize(uCamPos - p);
  vec3 Li = lightAt(p);
  float depth = max(uSurfaceY - p.y, 0.0);
  float att = exp(-uSigmaLight * depth * 0.6);
  float diff = max(0.0, (dot(N, uSunDir) + 0.3) / 1.3);
  vec3 amb = mix(uAmbDown, uAmbUp, N.y * 0.5 + 0.5) * att;
  vec3 col = alb * (Li * diff + amb);
  col = applyWater(col, p);
  float fres = pow(clamp(1.0 - dot(N, V), 0.0, 1.0), 2.0);
  vec3 ec = E_BG + E_DEEP * fres * 0.18;
  ec *= electroFade(p);
  if (uEWorldR > 0.0) ec *= electroWorld(p);
  col = mix(col, ec, electroMask(p));
  col += E_CORE * electroRing(p) * 1.2;
  gl_FragColor = vec4(col, 1.0);
}
`;

function rockGeometry(seed, detail = 4) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.attributes.position;
  const rnd = mulberry32(seed);
  const k = [rnd() * 10, rnd() * 10, rnd() * 10];
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = Math.sin(v.x * 2.1 + k[0]) * Math.sin(v.y * 1.7 + k[1]) * Math.sin(v.z * 2.3 + k[2]);
    const n2 = Math.sin(v.x * 5.3 + k[1]) * Math.sin(v.y * 4.9 + k[2]) * Math.sin(v.z * 5.7 + k[0]);
    const r = 1 + 0.22 * n + 0.07 * n2;
    v.multiplyScalar(r);
    v.y *= 0.62; // 扁一点
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// 把按面的法线（二十面体网格不共享顶点，算出来是一块块平面）改成按顶点平均：卵石近看是圆的，不是多面体
function smoothNormals(g) {
  const pos = g.attributes.position, nrm = g.attributes.normal;
  const key = (i) => `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
  const acc = new Map();
  for (let i = 0; i < pos.count; i++) {
    const k = key(i), a = acc.get(k) || [0, 0, 0];
    a[0] += nrm.getX(i); a[1] += nrm.getY(i); a[2] += nrm.getZ(i);
    acc.set(k, a);
  }
  for (let i = 0; i < pos.count; i++) {
    const a = acc.get(key(i)), l = Math.hypot(a[0], a[1], a[2]) || 1;
    nrm.setXYZ(i, a[0] / l, a[1] / l, a[2] / l);
  }
  nrm.needsUpdate = true;
  return g;
}

export class Riverbed {
  /** o: base 平均深度（负数）、center/size 平面范围、rocks 数量、gravel {center:[x,z], r, n} */
  constructor(water, { base = -12, center = [0, 0], size = 140, seg = 360, rocks = 90, rockRegion = 60, seed = 5, gravel = null } = {}) {
    this.base = base;
    this.grid = { cx: center[0] - size / 2, cz: center[1] - size / 2, step: size / seg, seg };
    const u = { uBedBase: { value: base }, uGravel: { value: gravel ? 1 : 0 }, uGravelC: { value: new THREE.Vector3(gravel ? gravel.center[0] : 0, 0, gravel ? gravel.center[1] : 0) }, uGravelR: { value: gravel ? gravel.r : 1 } };
    const g = new THREE.PlaneGeometry(size, size, seg, seg);
    g.rotateX(-Math.PI / 2);
    g.translate(center[0], 0, center[1]);
    this.mat = new THREE.ShaderMaterial({ uniforms: { ...water, ...u }, vertexShader: BED_VERT, fragmentShader: BED_FRAG });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    const rnd = mulberry32(seed);
    const rockMat = new THREE.ShaderMaterial({ uniforms: { ...water, uTint: { value: new THREE.Vector3(0.13, 0.12, 0.105) } }, vertexShader: ROCK_VERT, fragmentShader: ROCK_FRAG });
    const variants = [rockGeometry(seed + 1), rockGeometry(seed + 2), rockGeometry(seed + 3)];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3(), eu = new THREE.Euler();
    for (let vi = 0; vi < variants.length; vi++) {
      const n = Math.round(rocks / variants.length);
      const im = new THREE.InstancedMesh(variants[vi], rockMat, n);
      for (let i = 0; i < n; i++) {
        const x = center[0] + (rnd() - 0.5) * rockRegion, z = center[1] + (rnd() - 0.5) * rockRegion;
        const s = 0.25 + Math.pow(rnd(), 2.5) * 1.8;
        ps.set(x, bedHeight(x, z, base) + s * 0.15, z);
        eu.set((rnd() - 0.5) * 0.4, rnd() * 6.28, (rnd() - 0.5) * 0.4);
        q.setFromEuler(eu);
        sc.set(s * (0.8 + rnd() * 0.5), s * (0.7 + rnd() * 0.5), s * (0.8 + rnd() * 0.5));
        m4.compose(ps, q, sc);
        im.setMatrixAt(i, m4);
      }
      im.frustumCulled = false;
      this.group.add(im);
    }
    if (gravel) {
      // gravel.detail 细分级数（默认 2）；gravel.smooth 顶点平均法线（默认关：和原来一样是多面体）
      const pg = rockGeometry(seed + 9, gravel.detail ?? 2);
      if (gravel.smooth) smoothNormals(pg);
      const gm = new THREE.ShaderMaterial({ uniforms: { ...water, uTint: { value: new THREE.Vector3(0.19, 0.18, 0.16) } }, vertexShader: ROCK_VERT, fragmentShader: ROCK_FRAG });
      const n = gravel.n || 9000;
      const im = new THREE.InstancedMesh(pg, gm, n);
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * gravel.r;
        const x = gravel.center[0] + Math.cos(a) * r, z = gravel.center[1] + Math.sin(a) * r;
        const s = 0.025 + Math.pow(rnd(), 2) * 0.07;
        ps.set(x, bedHeight(x, z, base) + s * 0.25, z);
        eu.set(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28);
        q.setFromEuler(eu);
        sc.set(s * (0.9 + rnd() * 0.5), s * (0.6 + rnd() * 0.4), s * (0.9 + rnd() * 0.5));
        m4.compose(ps, q, sc);
        im.setMatrixAt(i, m4);
      }
      im.frustumCulled = false;
      this.group.add(im);
      this.gravelMesh = im;   // 卵石的实例矩阵（给放东西的人读：卵落在哪块石头上）
    }
  }
  h(x, z) { return bedHeight(x, z, this.base); }
  /** 画出来的河床表面在 (x, z) 的高度：网格顶点含沙纹与细碎起伏，三角形内线性插值（和 GPU 画的一致） */
  surface(x, z) {
    const { cx, cz, step, seg } = this.grid;
    if (!this._vh) this._vh = new Float32Array((seg + 1) * (seg + 1)).fill(NaN);
    const vh = (i, j) => {
      const k = j * (seg + 1) + i;
      if (Number.isNaN(this._vh[k])) this._vh[k] = bedVertexH(cx + i * step, cz + j * step, this.base);
      return this._vh[k];
    };
    const fx = (x - cx) / step, fz = (z - cz) / step;
    const ix = Math.max(0, Math.min(seg - 1, Math.floor(fx))), iz = Math.max(0, Math.min(seg - 1, Math.floor(fz)));
    const u = fx - ix, v = fz - iz;
    const h10 = vh(ix + 1, iz), h01 = vh(ix, iz + 1);
    // PlaneGeometry 的每格两个三角形，对角线从 (0,1) 到 (1,0)
    if (u + v <= 1) {
      const h00 = vh(ix, iz);
      return h00 + u * (h10 - h00) + v * (h01 - h00);
    }
    const h11 = vh(ix + 1, iz + 1);
    return h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
  }
}
