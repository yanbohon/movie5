// S0 的两套颗粒（three.js 点精灵，全部是时间 t 的纯函数）：
//   ambient —— 黑水里极暗的悬浮泥沙，景深虚焦，慢漂；片名写字时被笔尖的光照亮一点
//   dust    —— 片名的光碎成的颗粒：位置取自字的笔画，按溶解前沿依次脱落，被水流带走（顶点着色器里从脱落时刻
//              起用固定步长积分旋度噪声流场，同一个 t 永远同一个位置），颜色从冷白青变成暖黄的泥沙
import { mulberry32 } from '../../film/util.js';

// 世界单位 = 焦平面（z=0）上的像素；相机在 z=CAM_Z 看向 -z，画面 1920×1080 正好铺满焦平面
export const CAM_Z = 1000;

const NOISE = /* glsl */ `
// Ashima Arts / Stefan Gustavson 3D simplex noise (MIT)
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

// 景深：离焦平面越远，弥散圆越大、单位面积越暗（能量守恒放宽一点，免得近处的全看不见）
const DOF = /* glsl */ `
uniform float uCoC; uniform float uFocus;
float cocPx(float dist){ return abs(1.0 - uFocus / dist) * uCoC; }
`;

const FRAG = /* glsl */ `
varying vec3 vCol; varying float vSize;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  // 小点用高斯，大的弥散圆边缘稍亮一点（像镜头里的散景）
  float small = exp(-r2 * 3.2);
  float disc = smoothstep(1.0, 0.72, sqrt(r2)) * (0.82 + 0.18 * smoothstep(0.3, 0.95, sqrt(r2)));
  float k = mix(small, disc, smoothstep(3.0, 9.0, vSize));
  gl_FragColor = vec4(vCol * k, 1.0);
}
`;

/** 黑水里的悬浮泥沙 */
export function makeAmbient(THREE, { count = 1700, seed = 5 } = {}) {
  const rnd = mulberry32(seed);
  const pos = new Float32Array(count * 3), r4 = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    // 深度分布：大多在焦平面前后，少数贴近镜头（大而虚的散景），少数很远
    const r0 = rnd();
    const z = r0 < 0.08 ? 380 + rnd() * 380 : r0 < 0.8 ? (rnd() - 0.5) * 900 : -450 - rnd() * 2200;
    const d = CAM_Z - z;
    const hw = d * 0.96 * 1.15 + 60, hh = d * 0.54 * 1.1 + 40;
    pos[i * 3] = (rnd() * 2 - 1) * hw;
    pos[i * 3 + 1] = (rnd() * 2 - 1) * hh;
    pos[i * 3 + 2] = z;
    r4[i * 4] = rnd(); r4[i * 4 + 1] = rnd(); r4[i * 4 + 2] = rnd(); r4[i * 4 + 3] = rnd();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aR', new THREE.BufferAttribute(r4, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uT: { value: 0 }, uTin: { value: 0 }, uAmp: { value: 0 }, uBreath: { value: 1 },
      uTip: { value: new THREE.Vector3() }, uGlyph: { value: new THREE.Vector3() },
      uWarm: { value: 0 }, uCoC: { value: 12 }, uFocus: { value: CAM_Z }, uCamZ: { value: CAM_Z },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aR;
      uniform float uT, uTin, uAmp, uBreath, uWarm, uCamZ;
      uniform vec3 uTip, uGlyph;
      varying vec3 vCol; varying float vSize;
      ${DOF}
      void main(){
        float tau = uT - uTin;
        vec3 p = position;
        p.x += (7.0 + 13.0 * aR.x) * tau;
        p.y += (-2.5 + 4.0 * aR.y) * tau + 7.0 * sin(tau * (0.21 + 0.1 * aR.z) + aR.z * 6.2831);
        p.z += 10.0 * sin(tau * 0.13 + aR.w * 6.2831);
        float d = uCamZ - p.z;
        float hw = d * 0.96 * 1.15 + 60.0;
        p.x = mod(p.x + hw, 2.0 * hw) - hw;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = -mv.z;
        float coc = cocPx(dist);
        float size = clamp(2.1 + coc, 2.1, 70.0);
        gl_PointSize = size;
        vSize = size;
        // 一点点从上面来的微光 + 缓慢的明灭
        float lum = (0.25 + 0.75 * aR.w * aR.w) * (0.75 + 0.35 * clamp(p.y / 700.0 + 0.5, 0.0, 1.0));
        lum *= 0.7 + 0.3 * sin(uT * (0.5 + 0.7 * aR.x) + aR.y * 40.0);
        // 片名的光：笔尖附近、整个字附近照亮颗粒（按焦平面上的投影距离）
        vec2 sp = p.xy * (uCamZ / max(dist, 1.0));
        float lt = uTip.z * exp(-dot(sp - uTip.xy, sp - uTip.xy) / (2.0 * 165.0 * 165.0));
        float lg = uGlyph.z * exp(-dot(sp - uGlyph.xy, sp - uGlyph.xy) / (2.0 * 380.0 * 380.0));
        float energy = pow(2.1 / size, 1.05);
        vec3 grey = vec3(0.62, 0.58, 0.5);
        vec3 lit = vec3(0.45, 0.8, 1.0);
        vec3 warm = vec3(0.75, 0.55, 0.28);
        vec3 c = mix(grey, warm, uWarm) * lum * uAmp * uBreath + lit * (lt + lg) * (0.4 + 0.6 * aR.w);
        vCol = c * energy;
      }`,
    fragmentShader: FRAG,
    blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return { points: pts, mat };
}

/**
 * 片名碎散的颗粒。samples: [{x, y, b}]（屏幕像素、亮度 0..1），front(x, y) → 0..1 的溶解前沿（和字的遮罩同一个函数）
 */
export function makeDust(THREE, samples, { t0, dur, seed = 9, W = 1920, H = 1080 } = {}) {
  const n = samples.length;
  const rnd = mulberry32(seed);
  const pos = new Float32Array(n * 3), r4 = new Float32Array(n * 4), rel = new Float32Array(n), br = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    pos[i * 3] = s.x - W / 2;
    pos[i * 3 + 1] = H / 2 - s.y;
    pos[i * 3 + 2] = (rnd() - 0.5) * 6;
    rel[i] = t0 + s.f * dur + (rnd() - 0.5) * 0.12;
    br[i] = s.b;
    r4[i * 4] = rnd(); r4[i * 4 + 1] = rnd(); r4[i * 4 + 2] = rnd(); r4[i * 4 + 3] = rnd();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aR', new THREE.BufferAttribute(r4, 4));
  geo.setAttribute('aRel', new THREE.BufferAttribute(rel, 1));
  geo.setAttribute('aB', new THREE.BufferAttribute(br, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uT: { value: 0 }, uAmp: { value: 1 }, uFade: { value: 1 },
      uCoC: { value: 16 }, uFocus: { value: CAM_Z }, uDt: { value: 1 / 30 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aR; attribute float aRel; attribute float aB;
      uniform float uT, uAmp, uFade, uDt;
      varying vec3 vCol; varying float vSize;
      ${NOISE}
      ${DOF}
      // 水流：向右（下游）的主流 + 旋度噪声的涡（无散，颗粒不会挤成团）+ 脱落时的一点初速度
      vec3 vel(vec3 p, float s, float tabs){
        float ramp = smoothstep(0.0, 1.05, s);
        vec3 q = vec3(p.xy * 0.0042, tabs * 0.16);
        vec3 q2 = vec3(p.xy * 0.011 + 17.0, tabs * 0.3);
        float e = 0.8;
        float n0 = snoise(q), nx = snoise(q + vec3(e * 0.0042, 0.0, 0.0)), ny = snoise(q + vec3(0.0, e * 0.0042, 0.0));
        float m0 = snoise(q2), mx = snoise(q2 + vec3(e * 0.011, 0.0, 0.0)), my = snoise(q2 + vec3(0.0, e * 0.011, 0.0));
        vec2 curl = vec2(ny - n0, -(nx - n0)) / e;
        vec2 curl2 = vec2(my - m0, -(mx - m0)) / e;
        // 每粒沙的「重量」不同：轻的被卷得快、飘得远，重的慢慢沉
        float lightness = 0.45 + 1.1 * aR.w;
        vec2 base = vec2(215.0, -30.0 - 40.0 * (1.0 - aR.w)) * ramp * lightness;
        vec2 burst = (vec2(aR.x, aR.y) - 0.5) * 60.0 * exp(-s / 0.3);
        float vz = (aR.z - 0.45) * 620.0 * ramp * (0.6 + 0.6 * aR.w);
        return vec3(base + curl * 250.0 * (0.4 + 0.6 * ramp) * (0.7 + 0.5 * aR.y) + curl2 * 90.0 * ramp + burst, vz);
      }
      void main(){
        float tau = uT - aRel;
        vec3 p = position;
        if (tau > 0.0) {
          float steps = tau / uDt;
          for (int i = 0; i < 150; i++) {
            if (float(i) >= steps) break;
            float s = float(i) * uDt;
            float h = min(uDt, tau - s);
            p += vel(p, s, aRel + s) * h;
          }
        }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = -mv.z;
        float size = clamp(1.9 + cocPx(dist), 1.9, 64.0);
        gl_PointSize = size;
        vSize = size;
        float energy = pow(1.9 / size, 1.4);
        // 脱落前不画（字本身还亮着）；脱落瞬间一闪，然后变成悬浮的泥沙，颜色由冷转暖
        float on = smoothstep(-0.02, 0.06, tau);
        float lum = aB * (1.4 * exp(-max(tau, 0.0) / 0.22) + 0.6 * exp(-max(tau, 0.0) / 0.9) + 0.3 * exp(-max(tau, 0.0) / 2.6));
        float warm = smoothstep(0.1, 1.6, tau);
        vec3 cold = mix(vec3(0.42, 0.8, 1.0), vec3(1.0), 0.35 * exp(-max(tau, 0.0) / 0.3));
        vec3 sand = mix(vec3(0.95, 0.72, 0.4), vec3(0.62, 0.48, 0.28), smoothstep(1.2, 2.6, tau));
        float tw = 0.75 + 0.25 * sin(uT * (2.0 + 3.0 * aR.w) + aR.x * 50.0);
        vCol = mix(cold, sand, warm) * lum * on * energy * uAmp * uFade * mix(1.0, tw, warm);
      }`,
    fragmentShader: FRAG,
    blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return { points: pts, mat };
}
