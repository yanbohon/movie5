// 船：从水下仰看的船底（货船 / 搜寻小船）、螺旋桨、尾流气泡、水听器与缆绳。
// 船底挡光：通过水体 uniforms 里的遮挡矩形（uOcc*）让船正下方变暗、光束被截断（见 glsl.js 的 lightAt 用法）。
import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { mulberry32 } from '../util.js';

const HULL_VERT = /* glsl */ `
${COMMON}
varying vec3 vW;
varying vec3 vN;
varying vec3 vL;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vL = position;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const HULL_FRAG = /* glsl */ `
${COMMON}
uniform vec3 uTint;
uniform float uEngine;     // 电感视觉里的引擎/电气噪声强度
uniform vec3 uHot;         // 电感视觉里最亮的点（引擎、螺旋桨）局部坐标
uniform float uHotFall;    // 热点衰减（每米）：大船 0.35，小艇要更快
uniform float uHullGlow;   // 电感视觉里船壳本身的微光（小艇只该看见引擎）
varying vec3 vW;
varying vec3 vN;
varying vec3 vL;
void main() {
  vec3 p = vW;
  vec3 V = normalize(uCamPos - p);
  vec3 N = normalize(vN);
  if (dot(N, V) < 0.0) N = -N;
  // 锈、藻、焊缝
  float rust = fbm3(vL * 0.35 + 2.0);
  vec3 alb = uTint * (0.85 + 0.25 * rust);
  float seam = 1.0 - smoothstep(0.0, 0.04, abs(fract(vL.x * 0.25) - 0.5) * 2.0 - 0.96);
  alb *= 1.0 - 0.3 * seam;
  float depth = max(uSurfaceY - p.y, 0.0);
  float att = exp(-uSigmaLight * depth * 0.6);
  vec3 amb = mix(uAmbDown, uAmbUp, N.y * 0.5 + 0.5) * att;
  // 船底几乎只吃从下面来的散射光
  vec3 col = alb * amb * 0.5;
  col = applyWater(col, p);
  // 电感视觉：整条船是一团嘈杂的电场，引擎处最亮
  float fres = pow(clamp(1.0 - dot(N, V), 0.0, 1.0), 2.0);
  float hot = exp(-length(vL - uHot) * uHotFall);
  float crackle = 0.5 + 0.5 * snoise(vL * 0.8 + vec3(0.0, 0.0, uTime * 6.0));
  vec3 ec = E_BG + E_DEEP * fres * 0.4 * uEngine * uHullGlow + E_CORE * (hot * 1.6 + fres * 0.25 * uHullGlow) * crackle * uEngine;
  ec *= electroFade(p) * 1.8;
  col = mix(col, ec, electroMask(p));
  col += E_CORE * electroRing(p);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** 船体几何：船底平、两舷圆转、船首收尖；长 len、宽 beam、吃水 draft；x 轴为船长方向（船首 +x） */
function hullGeometry(len, beam, draft, seg = 64) {
  const pos = [], idx = [];
  const nr = 16;
  for (let i = 0; i <= seg; i++) {
    const u = i / seg;                 // 0 船尾 → 1 船首
    const x = (u - 0.5) * len;
    const bow = u > 0.8 ? Math.pow((u - 0.8) / 0.2, 1.6) : 0;
    const stern = u < 0.08 ? Math.pow((0.08 - u) / 0.08, 1.5) : 0;
    const halfB = (beam / 2) * (1 - 0.92 * bow) * (1 - 0.25 * stern);
    const d = draft * (1 - 0.55 * bow) * (1 - 0.35 * stern);
    for (let j = 0; j <= nr; j++) {
      const a = (j / nr) * Math.PI; // 从左舷水线 → 船底 → 右舷水线
      const cz = -Math.cos(a) * halfB;
      const sq = Math.pow(Math.abs(Math.sin(a)), 0.35);
      const y = -d * sq;
      pos.push(x, y, cz);
    }
  }
  const Wn = nr + 1;
  for (let i = 0; i < seg; i++) for (let j = 0; j < nr; j++) {
    const a = i * Wn + j, b = a + Wn;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function propGeometry(radius, blades = 4) {
  const geos = [];
  for (let k = 0; k < blades; k++) {
    const b = new THREE.SphereGeometry(1, 16, 8);
    b.scale(radius * 0.18, radius * 0.5, radius * 0.05);
    b.translate(0, radius * 0.5, 0);
    b.rotateY(0.5);
    b.rotateX((k / blades) * Math.PI * 2);
    geos.push(b);
  }
  const hub = new THREE.CylinderGeometry(radius * 0.14, radius * 0.1, radius * 0.5, 16);
  hub.rotateZ(Math.PI / 2);
  geos.push(hub);
  // 手工合并
  const pos = [], nrm = [], idx = [];
  let off = 0;
  for (const g of geos) {
    const gg = g.index ? g : g;
    pos.push(...gg.attributes.position.array);
    nrm.push(...gg.attributes.normal.array);
    for (const i of gg.index.array) idx.push(i + off);
    off += gg.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setIndex(idx);
  return out;
}

export class Ship {
  /** 货船：len 60、beam 11、draft 3.5 */
  constructor(water, { len = 60, beam = 11, draft = 3.5, propR = 1.3, tint = [0.09, 0.075, 0.06] } = {}) {
    this.len = len; this.beam = beam; this.draft = draft; this.propR = propR;
    this.u = { uTint: { value: new THREE.Vector3(...tint) }, uEngine: { value: 1 }, uHot: { value: new THREE.Vector3(-len / 2 + 2, -draft * 0.7, 0) }, uHotFall: { value: len > 20 ? 0.35 : 1.6 }, uHullGlow: { value: 1 } };
    this.mat = new THREE.ShaderMaterial({ uniforms: { ...water, ...this.u }, vertexShader: HULL_VERT, fragmentShader: HULL_FRAG, side: THREE.DoubleSide });
    this.group = new THREE.Group();
    const hull = new THREE.Mesh(hullGeometry(len, beam, draft), this.mat);
    hull.frustumCulled = false;
    this.group.add(hull);
    this.prop = new THREE.Mesh(propGeometry(propR), this.mat);
    this.prop.position.set(-len / 2 + 1.2, -draft * 0.62, 0);
    this.prop.frustumCulled = false;
    this.group.add(this.prop);
    const rudder = new THREE.Mesh(new THREE.BoxGeometry(1.6, propR * 2, 0.15), this.mat);
    rudder.position.set(-len / 2 - 0.2, -draft * 0.62, 0);
    this.group.add(rudder);
  }
  /** 放到位置 (x, z)、航向 heading（弧度，0 = +x），螺旋桨转角 */
  place(x, z, heading, propAngle, surfaceY = 0) {
    this.group.position.set(x, surfaceY, z);
    this.group.rotation.set(0, -heading, 0);
    this.prop.rotation.x = propAngle;
    this.group.updateMatrixWorld(true);
  }
  propWorld(out = new THREE.Vector3()) { return this.prop.getWorldPosition(out); }
}

// ---- 尾流气泡：从螺旋桨后面冒出、打旋、上浮、散开 ----
const BUB_VERT = /* glsl */ `
${COMMON}
attribute vec4 aB;     // 发射时刻偏移、随机、随机、大小
uniform vec3 uEmit0;   // 发射窗口起点时的螺旋桨位置
uniform vec3 uEmitV;   // 螺旋桨速度（米/秒）
uniform float uT0;     // 发射窗口起点
uniform float uDur;    // 发射窗口长度
uniform float uViewH;
uniform float uTanHalf;
uniform vec3 uBack;    // 船尾方向（单位向量）
varying vec2 vQ;
varying float vA;
varying vec3 vC;
void main() {
  float te = uT0 + aB.x * uDur;
  float age = uTime - te;
  float life = 3.0 + aB.y * 5.0;
  vec3 p = uEmit0 + uEmitV * (te - uT0);
  float alive = step(0.0, age) * (1.0 - smoothstep(life * 0.7, life, age));
  age = max(age, 0.0);
  // 螺旋上升 + 向船尾拖
  float ang = aB.z * 6.28 + age * 5.0;
  float r = 0.3 + age * 0.35;
  vec3 side = normalize(cross(uBack, vec3(0.0, 1.0, 0.0)));
  p += uBack * (1.5 + age * 1.2) + side * cos(ang) * r + vec3(0.0, sin(ang) * r * 0.5 + age * (0.35 + aB.w * 0.4), 0.0);
  p += vec3(snoise(vec3(aB.xy * 20.0, age * 0.5)), snoise(vec3(aB.yz * 20.0, age * 0.5)), snoise(vec3(aB.zx * 20.0, age * 0.5))) * age * 0.3;
  p.y = min(p.y, uSurfaceY - 0.05);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  float pxPerM = uViewH / (2.0 * uTanHalf * max(dist, 0.05));
  float rad = max((0.01 + 0.05 * aB.w * aB.w) * pxPerM, 0.8);
  float T = exp(-uSigma * dist);
  vC = (lightAt(p) * 0.6 + uFogUp * 2.0) * T * (1.0 - electroMask(p));
  vA = alive * (0.5 + 0.5 * aB.w);
  vQ = position.xy;
  mv.xy += position.xy * rad / pxPerM;
  gl_Position = projectionMatrix * mv;
}
`;
const BUB_FRAG = /* glsl */ `
varying vec2 vQ;
varying float vA;
varying vec3 vC;
void main() {
  float r = length(vQ);
  if (r > 1.0 || vA <= 0.001) discard;
  // 气泡：亮边、暗心、一个小高光
  float rim = smoothstep(0.6, 0.95, r) * (1.0 - smoothstep(0.95, 1.0, r));
  float hl = exp(-dot(vQ - vec2(-0.35, 0.35), vQ - vec2(-0.35, 0.35)) * 30.0);
  float a = (rim * 0.8 + hl + 0.08) * vA;
  gl_FragColor = vec4(vC * a * 1.6, a * 0.6);
}
`;

export class Bubbles {
  constructor(water, { n = 5000, seed = 31 } = {}) {
    const rnd = mulberry32(seed);
    const b = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) b.set([rnd(), rnd(), rnd(), rnd()], i * 4);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aB', new THREE.InstancedBufferAttribute(b, 4));
    g.instanceCount = n;
    this.u = {
      uEmit0: { value: new THREE.Vector3() }, uEmitV: { value: new THREE.Vector3() }, uT0: { value: 0 }, uDur: { value: 1 },
      uViewH: { value: 1080 }, uTanHalf: { value: 0.3 }, uBack: { value: new THREE.Vector3(-1, 0, 0) },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...water, ...this.u }, vertexShader: BUB_VERT, fragmentShader: BUB_FRAG,
      transparent: true, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
  }
}

// ---- 搜寻船垂下来的水听器与缆绳（电感视觉里：向内收的「聆听」圈）----
const CABLE_FRAG = /* glsl */ `
${COMMON}
uniform float uListen;
varying vec3 vW;
varying vec3 vN;
varying vec3 vL;
void main() {
  vec3 p = vW;
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - p);
  vec3 col = vec3(0.05, 0.05, 0.045) * mix(uAmbDown, uAmbUp, 0.6) * 8.0;
  col = applyWater(col, p);
  float fres = pow(clamp(1.0 - abs(dot(N, V)), 0.0, 1.0), 2.0);
  vec3 ec = E_BG + E_CORE * (0.25 + fres * 0.6) * uListen;
  ec *= electroFade(p) * 1.5;
  col = mix(col, ec, electroMask(p));
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Hydrophone {
  constructor(water) {
    this.u = { uListen: { value: 1 } };
    this.mat = new THREE.ShaderMaterial({ uniforms: { ...water, ...this.u }, vertexShader: HULL_VERT, fragmentShader: CABLE_FRAG });
    this.body = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.35, 16), this.mat);
    this.cablePts = Array.from({ length: 24 }, () => new THREE.Vector3());
    this.cableGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -1, 0)]), 40, 0.008, 6);
    this.cable = new THREE.Mesh(this.cableGeo, this.mat);
    this.group = new THREE.Group();
    this.group.add(this.body, this.cable);
    this.body.frustumCulled = false;
    this.cable.frustumCulled = false;
  }
  /** top 缆绳顶端（船上），bottom 水听器位置，sway 摆动 */
  place(top, bottom, t) {
    const pts = [];
    for (let i = 0; i < 12; i++) {
      const k = i / 11;
      const p = new THREE.Vector3().lerpVectors(top, bottom, k);
      p.x += Math.sin(k * Math.PI) * 0.4 + Math.sin(t * 0.7 + k * 3) * 0.05 * k;
      pts.push(p);
    }
    this.cable.geometry.dispose();
    this.cable.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.008, 6);
    this.body.position.copy(bottom);
    this.body.rotation.z = Math.sin(t * 0.7) * 0.08;
    this.group.updateMatrixWorld(true);
  }
}
