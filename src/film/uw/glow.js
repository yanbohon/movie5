// 电感视觉里的「光团」：一组按世界尺寸画的柔光点（加色混合）。
// GlowBlobs 是底层；fishAura 把一条鱼画成远处的一团光；GhostSchool 是回忆里满江的白鲟光影；
// BellyEggs 是她肚子里的卵（电感视觉里透过身体看见的琥珀色小光点）。
// 全部按 t 现算，没有累积状态。
import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { sectionPoint } from './fishgeo.js';
import { mulberry32, win } from '../util.js';

const BLOB_VERT = /* glsl */ `
${COMMON}
attribute vec4 aPos;     // xyz 世界位置，w 半径（米）
attribute vec4 aCol;     // rgb 颜色×亮度，w 核心比例（0 全柔，1 带亮核）
uniform float uViewH;
uniform float uTanHalf;
uniform float uElectroOnly;
uniform float uFadeRange;
uniform float uMaxPx;
uniform float uNearFade;   // 离镜头太近的光团淡掉（米），0 不淡
uniform float uOverlay;    // 1：景深之后单独叠加（自己按圈散放大、自己做深度比较）
uniform float uFocus;
uniform float uAperture;
uniform float uMaxCoC;
varying vec2 vQ;
varying vec3 vCol;
varying float vCore;
varying float vDist;
void main() {
  vec4 mv = viewMatrix * vec4(aPos.xyz, 1.0);
  float dist = -mv.z;
  vDist = dist - aPos.w * 0.9;   // 按光团朝镜头的前沿比深度：别被自己包着的身体挡成空心圈
  float pxPerM = uViewH / (2.0 * uTanHalf * max(dist, 0.05));
  float want = aPos.w * pxPerM;
  float em = uElectroOnly > 0.5 ? electroMask(aPos.xyz) : 1.0;
  vCol = aCol.rgb * em * exp(-max(dist, 0.0) / uFadeRange);
  if (uNearFade > 0.0) vCol *= smoothstep(uNearFade * 0.35, uNearFade, dist);
  float rad;
  if (uOverlay > 0.5) {
    // 景深：光团按所在深度的圈散变大、变暗（能量守恒），和场景的景深一致
    float coc = clamp(abs(dist - uFocus) / max(dist, 0.05) * uAperture, 0.0, uMaxCoC);
    float base = max(want, 1.0);
    float r2 = base * base + coc * coc;
    rad = min(sqrt(r2), uMaxPx);
    vCol *= want * want / r2;
  } else {
    rad = clamp(want, 1.0, uMaxPx);
    if (want < 1.0) vCol *= want * want;           // 小于一个像素：按面积减亮，避免闪
    if (want > uMaxPx) vCol *= uMaxPx / want;      // 被截的大光团：别一下子变得太亮
  }
  vCore = aCol.w;
  vQ = position.xy;
  mv.xy += position.xy * rad / pxPerM;
  gl_Position = projectionMatrix * mv;
  if (dist < 0.06) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}
`;
const BLOB_FRAG = /* glsl */ `
uniform float uOverlay;
uniform float uDepthMode;  // 1：被场景里更近的东西挡住（软过渡）
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uNear;
uniform float uFar;
varying vec2 vQ;
varying vec3 vCol;
varying float vCore;
varying float vDist;
float linDepth(float z) {
  float ndc = z * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - ndc * (uFar - uNear));
}
void main() {
  float r2 = dot(vQ, vQ);
  if (r2 > 1.0) discard;
  float soft = (exp(-r2 * 4.0) - 0.0183) / 0.9817;
  float core = exp(-r2 * 26.0);
  vec3 col = vCol * (soft * (1.0 - 0.5 * vCore) + core * vCore * 2.2);
  if (uOverlay > 0.5 && uDepthMode > 0.5) {
    float sd = linDepth(texture2D(tDepth, gl_FragCoord.xy / uRes).x);
    col *= clamp((sd - vDist) / 0.35 + 0.5, 0.0, 1.0);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export class GlowBlobs {
  /** n 个光点；electroOnly：只在电感视觉里可见；depthTest=false 可以透过身体看见（肚子里的卵） */
  constructor(water, { n = 256, electroOnly = true, depthTest = true, fadeRange = 26, maxPx = 420, renderOrder = 7, overlay = false, nearFade = 0 } = {}) {
    this.n = n;
    this.pos = new Float32Array(n * 4);
    this.col = new Float32Array(n * 4);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 4).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aPos', this.aPos);
    g.setAttribute('aCol', this.aCol);
    g.instanceCount = n;
    this.overlay = overlay;
    this.u = {
      uViewH: { value: 1080 }, uTanHalf: { value: 0.3 }, uElectroOnly: { value: electroOnly ? 1 : 0 },
      uFadeRange: { value: fadeRange }, uMaxPx: { value: maxPx }, uNearFade: { value: nearFade },
      uOverlay: { value: overlay ? 1 : 0 }, uDepthMode: { value: depthTest ? 1 : 0 },
      uFocus: { value: 3 }, uAperture: { value: 0 }, uMaxCoC: { value: 0 },
      tDepth: { value: null }, uRes: { value: new THREE.Vector2(1920, 1080) }, uNear: { value: 0.03 }, uFar: { value: 200 },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...water, ...this.u }, vertexShader: BLOB_VERT, fragmentShader: BLOB_FRAG,
      transparent: true, depthWrite: false, depthTest: overlay ? false : depthTest, blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.count = 0;
  }
  begin() { this.count = 0; }
  push(p, r, c, k, core = 0) {
    if (this.count >= this.n) return;
    const i = this.count++ * 4;
    this.pos[i] = p.x; this.pos[i + 1] = p.y; this.pos[i + 2] = p.z; this.pos[i + 3] = r;
    this.col[i] = c[0] * k; this.col[i + 1] = c[1] * k; this.col[i + 2] = c[2] * k; this.col[i + 3] = core;
  }
  end(cam) {
    for (let i = this.count * 4; i < this.n * 4; i++) { this.pos[i] = 0; this.col[i] = 0; }
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.u.uTanHalf.value = Math.tan((cam.fov * Math.PI) / 360);
  }
  /** 叠加模式：拿到这一帧的场景深度与景深参数 */
  view(world, cam, dof = {}) {
    const u = this.u;
    u.tDepth.value = world.rt.depthTexture;
    u.uRes.value.set(world.rt.width, world.rt.height);
    u.uViewH.value = world.rt.height;
    u.uNear.value = cam.near; u.uFar.value = cam.far;
    u.uFocus.value = dof.focus ?? 3; u.uAperture.value = dof.aperture ?? 0; u.uMaxCoC.value = dof.max ?? 0;
    u.uTanHalf.value = Math.tan((cam.fov * Math.PI) / 360);
  }
}

/** 景深之后叠加的一层光团：world.render 之后调用 render，光团自己按景深变大、按深度被挡 */
export class GlowLayer {
  constructor() { this.scene = new THREE.Scene(); this.items = []; }
  add(...blobs) { for (const b of blobs) { this.scene.add(b.mesh); this.items.push(b); } }
  render(ctx, world, cam, dof) {
    for (const b of this.items) b.view(world, cam, dof);
    ctx.draw(this.scene, cam, { clear: false });
  }
}

// 电感视觉的颜色（和 glsl.js 里一致）
export const E_CORE = [0.62, 0.9, 1.0];
export const E_DEEP = [0.05, 0.22, 0.34];
export const E_AMBER = [1.0, 0.72, 0.38];

/** 把一条鱼画成一团光：沿身体一串柔光（半径按体宽），头部撒一些亮的感觉孔；heart 0..1 让整团跟着心跳涨缩 */
export function fishAura(fish, blobs, { gain = 1, heart = 0, k = 18, spread = 1.7, pores = 26, time = 0 } = {}) {
  const P = fish.P, L = fish.L;
  const tmp = new THREE.Vector3();
  const c = [E_DEEP[0] + E_CORE[0] * 0.25, E_DEEP[1] + E_CORE[1] * 0.25, E_DEEP[2] + E_CORE[2] * 0.25];
  for (let i = 0; i < k; i++) {
    const s = 0.04 + (0.92 * i) / (k - 1);
    const girth = Math.max(P.w(s), 0.5 * (P.hu(s) + P.hd(s))) * L;
    fish.pointAt(s, 0, P.c(s) * L, tmp);
    const r = girth * spread * (1 + 0.1 * heart) + 0.05;
    const mid = Math.sin(Math.PI * Math.min(1, s * 1.1));
    blobs.push(tmp, r, c, gain * (0.3 + 0.7 * mid) * (0.65 + 0.35 * heart) * 0.75, 0.1);
  }
  for (let i = 0; i < pores; i++) {
    const h1 = fract(Math.sin(i * 12.9898) * 43758.5453), h2 = fract(Math.sin(i * 78.233) * 12345.678), h3 = fract(Math.sin(i * 3.17) * 999.1);
    const s = 0.02 + 0.22 * h1;
    const [lat, vert] = sectionPoint(P, L, s, h2 * Math.PI * 2);
    fish.pointAt(s, lat * 1.02, vert, tmp);
    const tw = 0.5 + 0.5 * Math.sin(time * (2 + 3 * h3) + h2 * 30);
    blobs.push(tmp, 0.025, E_CORE, gain * (0.4 + 0.6 * tw) * 0.8, 0.9);
  }
}
const fract = (x) => x - Math.floor(x);

// 白鲟的外形（体宽/体高，按全长比例），给光影用
const PADDLE_GIRTH = (s) => (s < 0.3 ? 0.006 + 0.01 * s : s < 0.42 ? 0.04 + 0.2 * (s - 0.3) : 0.064 * Math.pow(1 - (s - 0.42) / 0.58, 0.9) + 0.006);

/**
 * 回忆里的一江白鲟：n 条光影各走各的直线，带摆尾；每条有自己的出现/消失时间。
 * box: {center:[x,y,z], size:[sx,sy,sz]}；dir: 主要游向（单位向量），spread 方向散布（弧度）
 */
export class GhostSchool {
  constructor(water, { n = 40, seed = 5, center = [0, -9, 0], size = [40, 6, 30], dir = [-1, 0, 0], spread = 0.9, t0 = 0, t1 = 10, speed = [0.5, 1.4], overlay = false, nearFade = 2.0 } = {}) {
    // n 条光影；每条在 [t0, t1] 里有自己的出现、消失
    const rnd = mulberry32(seed);
    this.t0 = t0; this.t1 = t1;
    this.g = [];
    const base = Math.atan2(dir[2], dir[0]);
    for (let i = 0; i < n; i++) {
      const L = 2.2 + rnd() * 1.8;
      const ang = base + (rnd() - 0.5) * 2 * spread + (rnd() < 0.2 ? Math.PI : 0);
      const v = speed[0] + rnd() * (speed[1] - speed[0]);
      const d = new THREE.Vector3(Math.cos(ang), (rnd() - 0.5) * 0.08, Math.sin(ang)).normalize();
      const mid = new THREE.Vector3(center[0] + (rnd() - 0.5) * size[0], center[1] + (rnd() - 0.5) * size[1], center[2] + (rnd() - 0.5) * size[2]);
      const ta = t0 + rnd() * (t1 - t0) * 0.45, tb = t1 - rnd() * (t1 - t0) * 0.35;
      this.g.push({ L, d, v, mid, ph: rnd() * 6.28, ta, tb, tm: 0.5 * (ta + tb), bright: 0.6 + 0.6 * rnd(), f: 0.9 + 0.5 * rnd() });
    }
    this.blobs = new GlowBlobs(water, { n: n * 26, electroOnly: true, fadeRange: 22, maxPx: 300, overlay, nearFade });
    this.mesh = this.blobs.mesh;
  }
  update(t, cam, { gain = 1 } = {}) {
    const B = this.blobs;
    B.begin();
    const p = new THREE.Vector3(), side = new THREE.Vector3();
    const body = [E_DEEP[0] + 0.35 * E_CORE[0], E_DEEP[1] + 0.35 * E_CORE[1], E_DEEP[2] + 0.35 * E_CORE[2]];
    for (const g of this.g) {
      const env = win(t, g.ta, g.ta + 1.2, g.tb - 1.2, g.tb) * gain * g.bright;
      if (env <= 0.001) continue;
      side.set(-g.d.z, 0, g.d.x).normalize();
      const head = g.mid.clone().addScaledVector(g.d, g.v * (t - g.tm));
      const ph = g.ph + t * Math.PI * 2 * g.f;
      const off = (s) => 0.1 * g.L * Math.pow(Math.max(0, s - 0.3) / 0.7, 1.5) * Math.sin(ph - s * 6.5);
      const at = (s, lat = 0, up = 0) => p.copy(head).addScaledVector(g.d, -s * g.L).addScaledVector(side, off(s) + lat).setY(p.y + up);
      // 吻：一串细小的亮点（感觉孔），吻根处两排
      for (let i = 0; i < 8; i++) {
        const s = 0.015 + i * 0.038;
        B.push(at(s), 0.016 + 0.01 * (i / 7), E_CORE, env * 0.5, 0.85);
      }
      for (const sg of [1, -1]) for (let i = 0; i < 3; i++) B.push(at(0.3 + i * 0.03, sg * 0.03 * g.L, 0.01 * g.L), 0.02, E_CORE, env * 0.4, 0.8);
      // 身体：细长的一串柔光，越往尾越淡
      for (let i = 0; i < 11; i++) {
        const s = 0.36 + i * 0.056;
        const r = PADDLE_GIRTH(s) * g.L * 1.5 + 0.03;
        B.push(at(s), r, body, env * 0.3 * (1 - 0.5 * (i / 10)), 0.05);
      }
      // 尾叉
      for (const sgn of [1, -1]) B.push(at(1.0, 0, sgn * 0.06 * g.L), 0.03 * g.L, E_DEEP, env * 0.25, 0);
    }
    B.end(cam);
  }
}

/** 她肚子里的卵：身体局部坐标里的一团点，每帧跟着身体走；透过身体可见 */
export class BellyEggs {
  constructor(water, fish, { n = 700, s0 = 0.5, s1 = 0.79, seed = 11, overlay = false } = {}) {
    const rnd = mulberry32(seed);
    this.fish = fish;
    this.e = [];
    const P = fish.P, L = fish.L;
    for (let i = 0; i < n; i++) {
      // 一对卵巢：沿身体的细长团，两头收尖，中间饱满
      const side = rnd() < 0.5 ? 1 : -1;
      const x = (rnd() + rnd() + rnd()) / 3;
      const s = s0 + (s1 - s0) * x;
      const taper = Math.sin(Math.PI * x);
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd());
      const lat = side * (0.34 + 0.4 * Math.cos(a) * r) * P.w(s) * L * (0.35 + 0.65 * taper);
      const vert = (P.c(s) - (0.25 + 0.5 * Math.sin(a) * r * taper) * P.hd(s)) * L;
      this.e.push({ s, lat, vert, ph: rnd() * 6.28, f: 0.5 + rnd() * 1.2, b: 0.35 + rnd() * 0.9, r: 0.006 + 0.005 * rnd() });
    }
    this.blobs = new GlowBlobs(water, { n, electroOnly: true, depthTest: false, fadeRange: 30, maxPx: 40, renderOrder: 9, overlay });
    this.mesh = this.blobs.mesh;
  }
  update(t, cam, { gain = 1 } = {}) {
    const B = this.blobs, p = new THREE.Vector3();
    B.begin();
    if (gain > 0.001) {
      for (const e of this.e) {
        this.fish.pointAt(e.s, e.lat, e.vert, p);
        const tw = 0.55 + 0.45 * Math.sin(t * e.f * 2.2 + e.ph);
        B.push(p, e.r, E_AMBER, gain * e.b * tw * 1.3, 0.6);
      }
    }
    B.end(cam);
  }
}

// ---- 脉冲环：信标每叫一声向外扩的一圈（她感觉得到）；水听器「听」的时候向里收的圈 ----
const RING_VERT = /* glsl */ `
varying vec3 vW;
varying vec3 vN;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const RING_FRAG = /* glsl */ `
${COMMON}
uniform float uK;
uniform float uElectroOnly;
uniform vec3 uCol;
uniform float uPow;
varying vec3 vW;
varying vec3 vN;
void main() {
  vec3 V = normalize(uCamPos - vW);
  float ndv = abs(dot(normalize(vN), V));
  float rim = pow(clamp(1.0 - ndv, 0.0, 1.0), uPow);
  float wob = 0.75 + 0.25 * snoise(vW * 2.5 + vec3(0.0, uTime * 0.7, 0.0));
  float em = uElectroOnly > 0.5 ? electroMask(vW) : 1.0;
  gl_FragColor = vec4(uCol * (rim * 1.2 + 0.015) * wob * uK * em, 1.0);
}
`;

export class PulseRings {
  /** n 个球壳；每帧 set(i, 中心, 半径, 亮度)，没设的自动隐藏 */
  constructor(water, { n = 4, electroOnly = false, color = E_CORE, pow = 6 } = {}) {
    const geo = new THREE.SphereGeometry(1, 64, 40);
    this.rings = [];
    this.group = new THREE.Group();
    for (let i = 0; i < n; i++) {
      const u = { uK: { value: 0 }, uElectroOnly: { value: electroOnly ? 1 : 0 }, uCol: { value: new THREE.Vector3(...color) }, uPow: { value: pow } };
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...water, ...u }, vertexShader: RING_VERT, fragmentShader: RING_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = 8;
      m.visible = false;
      this.group.add(m);
      this.rings.push({ m, u });
    }
  }
  begin() { for (const r of this.rings) r.m.visible = false; this.i = 0; }
  push(center, radius, k) {
    if (this.i >= this.rings.length || radius <= 0.001 || k <= 0.001) return;
    const r = this.rings[this.i++];
    r.m.visible = true;
    r.m.position.copy(center);
    r.m.scale.setScalar(radius);
    r.m.updateMatrixWorld();
    r.u.uK.value = k;
  }
}
