// 水里的颗粒：泥沙（跟着相机循环的无限颗粒场，带景深散景）、电感视觉里的「星星」（活物的微光）。
// 全部是时间的纯函数：位置 = 初始位置 + 漂移(t)，没有任何累积状态。
import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { mulberry32 } from '../util.js';

function quadInstanced(n, attrs) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  for (const [name, size, arr] of attrs) g.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));
  g.instanceCount = n;
  return g;
}

const SILT_VERT = /* glsl */ `
${COMMON}
attribute vec4 aSeed;        // xyz 初始位置（0..1）、w 大小随机
uniform float uBox;
uniform vec3 uCurrent;       // 水流速度（米/秒）
uniform float uFocus;
uniform float uAperture;
uniform float uSizeMul;
uniform float uViewH;        // 视口高度（像素）
uniform float uTanHalf;      // tan(fov/2)
uniform vec3 uStorm;         // 船过时的泥沙风暴：xyz 中心
uniform float uStormAmt;
uniform float uShutter;      // 运动拖影的快门（秒），0 = 没有（延时镜头里快速流过的泥沙拉成细线）
uniform vec2 uSideDens;      // 两种水时两侧的泥沙多少（第一种, 第二种，0..1），只在 uMix2 > 0 时起作用
varying vec2 vQ;
varying float vAlpha;
varying vec3 vCol;
void main() {
  vec3 base = aSeed.xyz * uBox;
  float t = uTime;
  vec3 drift = uCurrent * t + vec3(
    snoise(vec3(aSeed.xy * 13.0, t * 0.05)),
    snoise(vec3(aSeed.yz * 13.0, t * 0.05 + 5.0)) * 0.6,
    snoise(vec3(aSeed.zx * 13.0, t * 0.05 + 9.0))) * 0.35;
  vec3 p = base + drift;
  p = mod(p - uCamPos + uBox * 0.5, uBox) - uBox * 0.5 + uCamPos;
  // 泥沙风暴：中心附近的颗粒被搅起、打转
  if (uStormAmt > 0.0) {
    vec3 d = p - uStorm;
    float k = exp(-dot(d, d) / 30.0) * uStormAmt;
    p += vec3(snoise(p * 0.3 + t * 0.4), snoise(p * 0.3 + 3.0 + t * 0.4), snoise(p * 0.3 + 7.0 + t * 0.4)) * k * 1.5;
  }
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  float r = (0.0006 + 0.0022 * aSeed.w * aSeed.w) * uSizeMul;  // 物理半径（米）
  float pxPerM = uViewH / (2.0 * uTanHalf * max(dist, 0.05));
  float core = max(r * pxPerM, 0.7);
  float coc = abs(dist - uFocus) / max(dist, 0.05) * uAperture;
  float rad = max(core, coc);
  float energy = (core * core) / (rad * rad);
  // 光：水面下来的光 + 散射
  vec3 Li = lightAt(p);
  vec3 col = Li * 0.6 + mix(uFogDown, uFogUp, 0.6) * 1.5;
  float T = exp(-uSigma * dist);
  float em = electroMask(p);
  vCol = col * T * (1.0 - em);
  vAlpha = energy * smoothstep(0.08, 0.35, dist) * (0.35 + 0.65 * aSeed.w) * (1.0 + uStormAmt * 0.5);
  if (uMix2 > 0.0) {
    // 两种水：透射按实际穿过的水算；清水一侧泥沙少
    vCol = col * waterPath(uCamPos, p).a * (1.0 - em);
    float dens = mix(uSideDens.x, uSideDens.y, uMix2 * waterSide(p));
    vAlpha *= smoothstep(-0.05, 0.05, dens - fract(aSeed.x * 91.7 + aSeed.z * 13.3));
  }
  vQ = position.xy;
  if (uShutter > 0.0) {
    // 拖影：快门开始到结束之间，颗粒被水流带过的一段（视平面上），能量摊到整条线上
    vec4 mvb = viewMatrix * vec4(p - uCurrent * uShutter, 1.0);
    vec2 dv = (mv.xy - mvb.xy) * 0.5;
    float dl = length(dv);
    vec2 ax = dl > 1e-6 ? dv / dl : vec2(1.0, 0.0);
    float rw = rad / pxPerM;
    mv.xy += -dv + ax * position.x * (dl + rw) + vec2(-ax.y, ax.x) * position.y * rw;
    vAlpha *= rw / (dl + rw);
  } else {
    vec2 off = position.xy * rad / pxPerM;
    mv.xy += off;
  }
  gl_Position = projectionMatrix * mv;
}
`;
const SILT_FRAG = /* glsl */ `
varying vec2 vQ;
varying float vAlpha;
varying vec3 vCol;
void main() {
  float r = length(vQ);
  if (r > 1.0) discard;
  float a = (1.0 - smoothstep(0.55, 1.0, r)) * vAlpha;
  gl_FragColor = vec4(vCol * a, a);
}
`;

export class Silt {
  constructor(water, { n = 26000, box = 14, seed = 11 } = {}) {
    const rnd = mulberry32(seed);
    const s = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i++) s[i] = rnd();
    this.u = {
      uBox: { value: box }, uCurrent: { value: new THREE.Vector3(0.08, -0.004, 0.02) },
      uFocus: { value: 3 }, uAperture: { value: 8 }, uSizeMul: { value: 1 },
      uViewH: { value: 1080 }, uTanHalf: { value: Math.tan((35 * Math.PI) / 360) },
      uStorm: { value: new THREE.Vector3() }, uStormAmt: { value: 0 },
      uShutter: { value: 0 }, uSideDens: { value: new THREE.Vector2(1, 1) },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...water, ...this.u }, vertexShader: SILT_VERT, fragmentShader: SILT_FRAG,
      transparent: true, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(quadInstanced(n, [['aSeed', 4, s]]), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }
  /** shutter：拖影快门（秒，0 关）；sideDens [a, b]：两种水时两侧的泥沙多少（0..1） */
  set(cam, { focus, aperture, sizeMul, current, storm, stormAmt, shutter, sideDens } = {}) {
    const u = this.u;
    u.uTanHalf.value = Math.tan((cam.fov * Math.PI) / 360);
    if (shutter !== undefined) u.uShutter.value = shutter;
    if (sideDens) u.uSideDens.value.set(...sideDens);
    if (focus !== undefined) u.uFocus.value = focus;
    if (aperture !== undefined) u.uAperture.value = aperture;
    if (sizeMul !== undefined) u.uSizeMul.value = sizeMul;
    if (current) u.uCurrent.value.set(...current);
    if (storm) u.uStorm.value.set(...storm);
    if (stormAmt !== undefined) u.uStormAmt.value = stormAmt;
  }
}

// ---- 电感视觉里的活物：小鱼、虾、石缝里的虫 ----
const SPARK_VERT = /* glsl */ `
${COMMON}
attribute vec4 aP;     // xyz 世界位置，w 种类随机
attribute vec4 aR;     // 心率、相位、亮度、游动半径
uniform float uViewH;
uniform float uTanHalf;
uniform float uLifeK;   // 0..1：熄灭进度（最后一场，一颗颗暗下去）
uniform float uGain;
varying vec2 vQ;
varying vec3 vCol;
varying float vA;
void main() {
  float t = uTime;
  vec3 p = aP.xyz;
  // 小幅游动：小鱼画圈、虾一顿一顿地跳
  float sw = aR.w;
  p += vec3(sin(t * (0.3 + aR.x * 0.2) + aR.y * 6.28), sin(t * 0.21 + aR.y * 11.0) * 0.4, cos(t * (0.27 + aR.x * 0.15) + aR.y * 6.28)) * sw;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  float pxPerM = uViewH / (2.0 * uTanHalf * max(dist, 0.05));
  float beat = pow(0.5 + 0.5 * sin(t * (2.0 + aR.x * 5.0) * 3.14159 + aR.y * 40.0), 3.0);
  float b = aR.z * (0.35 + 0.65 * beat);
  // 熄灭：每颗有自己的熄灭时刻（按随机数排序）
  float off = smoothstep(aR.y - 0.04, aR.y + 0.02, uLifeK);
  b *= 1.0 - off;
  float em = electroMask(p);
  float fade = electroFade(p);
  vCol = mix(E_CORE, vec3(0.75, 1.0, 0.95), aP.w) * b * em * fade * uGain;
  vA = 1.0;
  float rad = clamp(0.035 * pxPerM, 1.2, 40.0);
  vQ = position.xy;
  mv.xy += position.xy * rad / pxPerM;
  gl_Position = projectionMatrix * mv;
}
`;
const SPARK_FRAG = /* glsl */ `
varying vec2 vQ;
varying vec3 vCol;
void main() {
  float r = length(vQ);
  if (r > 1.0) discard;
  float core = exp(-r * r * 18.0);
  float halo = exp(-r * r * 3.5) * 0.25;
  gl_FragColor = vec4(vCol * (core * 2.5 + halo), 1.0);
}
`;

export class Sparks {
  /** region: {center:[x,y,z], size:[sx,sy,sz]}，floorY 以下不放；bedFn(x,z) 可选：一部分贴着河床（石缝里的虫） */
  constructor(water, { n = 3200, center = [0, -8, 0], size = [40, 8, 40], seed = 21, bedFn = null } = {}) {
    const rnd = mulberry32(seed);
    const P = new Float32Array(n * 4), R = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      let x = center[0] + (rnd() - 0.5) * size[0];
      let z = center[2] + (rnd() - 0.5) * size[2];
      let y = center[1] + (rnd() - 0.5) * size[1];
      const onBed = bedFn && rnd() < 0.45;
      if (onBed) y = bedFn(x, z) + 0.03 + rnd() * 0.08;
      else if (bedFn) y = Math.max(y, bedFn(x, z) + 0.15);
      P.set([x, y, z, rnd()], i * 4);
      const small = onBed || rnd() < 0.5;
      R.set([rnd(), rnd(), (small ? 0.35 : 0.8) * (0.4 + rnd() * 0.9), onBed ? 0.01 : 0.05 + rnd() * 0.35], i * 4);
    }
    this.u = { uViewH: { value: 1080 }, uTanHalf: { value: 0.3 }, uLifeK: { value: 0 }, uGain: { value: 1 } };
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...water, ...this.u }, vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(quadInstanced(n, [['aP', 4, P], ['aR', 4, R]]), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }
  set(cam, { lifeK, gain } = {}) {
    this.u.uTanHalf.value = Math.tan((cam.fov * Math.PI) / 360);
    if (lifeK !== undefined) this.u.uLifeK.value = lifeK;
    if (gain !== undefined) this.u.uGain.value = gain;
  }
}
