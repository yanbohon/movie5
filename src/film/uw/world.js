// 水下世界渲染器：浑水背景（含水面与天空/城市灯）→ 场景（鱼、河床…）→ 体积光束 → 景深 → 输出到 HDR 目标。
// 同一 pass 里算真实视角与电感视觉（按波前遮罩混合），所以没有第二遍渲染。
import * as THREE from 'three';
import { COMMON } from './glsl.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

export function makeWaterUniforms() {
  return {
    uTime: { value: 0 },
    uCamPos: { value: V3(0, 0, 0) },
    uSurfaceY: { value: 0 },
    uSunDir: { value: V3(0.18, 1, 0.12).normalize() },
    uSunColor: { value: V3(3.2, 2.8, 2.0) },
    uSigma: { value: 0.24 },
    uSigmaLight: { value: 0.16 },
    uFogUp: { value: V3(0.105, 0.085, 0.048) },
    uFogDown: { value: V3(0.011, 0.009, 0.0055) },
    uAmbUp: { value: V3(0.16, 0.135, 0.085) },
    uAmbDown: { value: V3(0.02, 0.017, 0.011) },
    uCaustic: { value: 0.5 },
    uShafts: { value: 1 },
    uEC: { value: V3(0, 0, 0) },
    uER: { value: -1 },
    uEMix: { value: 0 },
    uENoise: { value: 0 },
    uERange: { value: 14 },
    uOcc: { value: new THREE.Vector4(0, 0, 1, 1) },
    uOccAng: { value: 0 },
    uOccAmt: { value: 0 },
    // 两江交汇（默认关闭，见 glsl.js 的 waterSide / waterPath）
    uMix2: { value: 0 },
    uMixPlane: { value: new THREE.Vector4(0, 0, 1, 0) },
    uMixW: { value: 1 },
    uMixTurb: { value: new THREE.Vector4(0, 0, 0, 0) },
    uSigma2: { value: 0.24 },
    uFog2Up: { value: V3(0.105, 0.085, 0.048) },
    uFog2Down: { value: V3(0.011, 0.009, 0.0055) },
    uERingDim: { value: 0 },
    uEWorldR: { value: 0 },   // 电感里环境的感知半径（0 = 不限，见 glsl.js 的 electroWorld）
    uEWorldAx: { value: V3(0, 0, 0) },
  };
}

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// 背景：每个像素一条视线，算浑水散射、水面（斯涅尔窗、波纹、天空或夜城）、电感视觉的空水
const BG_FRAG = /* glsl */ `
${COMMON}
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform float uSkyMode;      // 0 白天浑光；1 夜城；2 黎明
uniform float uSkyBright;
uniform float uCityLights;   // 夜城灯的总亮度（天亮时逐渐熄）
uniform float uDawn;
uniform float uFieldLines;   // 电感视觉里水中淡淡的场线
// 以下默认值 = 原来的样子（逐像素一样）
uniform float uCityOff;      // 0..1：城市灯一盏盏熄灭的进度（每盏灯有自己的熄灭门槛），0 = 全亮
uniform float uCityDense;    // 天际线上密集的小灯（楼窗、路灯）亮度，0 = 没有
uniform float uBridge;       // 桥灯带亮度倍数（默认 1）
uniform float uRipple;       // 水面波纹强度倍数（默认 1；延时镜头调小 = 长曝光抹平的水面）
uniform vec2 uWinEdge;       // 斯涅尔窗边缘的柔和区间（入射角余弦，默认 0.56..0.8）
uniform float uSkyBlur;      // 两江交汇时：浑水把水面上的灯晕开，每单位光学厚度增加的角半径（弧度）
varying vec2 vUv;
float gBlur = 0.0;           // 本像素的灯晕角半径（只在两种水的模式里非零）

// 每盏灯的熄灭门槛：uCityOff 越过它就熄
float cityKeep(float k){ return uCityOff > 0.0 ? step(uCityOff, k) : 1.0; }
// 灯的形状：高斯点；浑水里晕开（能量守恒）
float lampShape(vec2 dd, float sz){
  if (gBlur > 0.0) { float s2 = sz + gBlur; return exp(-dot(dd, dd) / (s2 * s2)) * (sz * sz) / (s2 * s2); }
  return exp(-dot(dd, dd) / (sz * sz));
}
// 天际线上密集的小灯：按（方位, 仰角）分格，每格至多一盏；贴着天际线密、往上稀，城区有疏有密
vec3 cityDense(float az, float el){
  vec3 acc = vec3(0.0);
  const vec2 cs = vec2(0.016, 0.0095);
  vec2 id = floor(vec2(az, el) / cs);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = id + vec2(float(x), float(y));
    float ce = (c.y + 0.5) * cs.y;
    if (ce < 0.0 || ce > 0.42) continue;
    float ca = (c.x + 0.5) * cs.x;
    float dist = 0.3 + 0.7 * smoothstep(-0.3, 0.7, sin(ca * 1.3 + 0.8) + 0.45 * sin(ca * 3.7 + 2.0) + 0.25 * sin(ca * 9.1));
    // 天际线：山上的城、楼群有高有低（按方位起伏），线以上很快没灯
    float sky = 0.05 + 0.2 * (0.5 + 0.5 * sin(ca * 2.1 + 1.3)) * (0.55 + 0.45 * sin(ca * 5.3 + 0.4)) + 0.1 * step(0.93, hash12(vec2(floor(ca / 0.05), 7.0)));
    float dens = (1.0 - smoothstep(sky * 0.6, sky * 1.15, ce)) * (1.0 - 0.5 * smoothstep(0.0, 0.2, ce)) * dist;
    float h0 = hash12(c * 1.37 + 5.1);
    if (h0 > dens * 0.9) continue;
    vec2 h = hash22(c + 17.0);
    vec2 dd = vec2(az, el) - (c + 0.15 + 0.7 * h) * cs;
    float g = lampShape(dd, 0.0016 + 0.0026 * h.x * h.y) * cityKeep(hash12(c * 0.91 + 3.3));
    float hue = hash12(c * 2.13 + 9.7);
    vec3 col = hue < 0.78 ? vec3(1.0, 0.64, 0.3) : (hue < 0.93 ? vec3(1.0, 0.84, 0.62) : (hue < 0.97 ? vec3(1.0, 0.2, 0.22) : vec3(0.3, 0.5, 1.0)));
    acc += col * g * (0.5 + 1.1 * h.y);
  }
  return acc;
}
// 近处的城：江边的楼、霓虹、堤上一排路灯（仰角高，进了亮窗就不再被压成一条线，涟漪里一颗颗碎开）
vec3 cityNear(float az, float el){
  vec3 acc = vec3(0.0);
  const vec2 cs = vec2(0.05, 0.034);
  vec2 id = floor(vec2(az, el) / cs);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = id + vec2(float(x), float(y));
    float ce = (c.y + 0.5) * cs.y;
    if (ce < 0.08 || ce > 0.62) continue;
    float h0 = hash12(c * 3.71 + 1.3);
    if (h0 > 0.55 * (1.0 - smoothstep(0.1, 0.6, ce))) continue;
    vec2 h = hash22(c * 1.9 + 4.0);
    vec2 dd = vec2(az, el) - (c + 0.2 + 0.6 * h) * cs;
    float g = lampShape(dd, 0.005 + 0.008 * h.x) * cityKeep(hash12(c * 0.53 + 8.1));
    float hue = hash12(c * 5.3 + 2.2);
    vec3 col = hue < 0.66 ? vec3(1.0, 0.6, 0.27) : (hue < 0.82 ? vec3(1.0, 0.82, 0.58) : (hue < 0.91 ? vec3(1.0, 0.16, 0.2) : vec3(0.28, 0.46, 1.0)));
    acc += col * g * (0.7 + 1.6 * h.y);
  }
  // 堤上一排路灯：等距的暖黄点
  float re = 0.2 + 0.025 * sin(az * 2.3 + 0.5);
  float rowv = (el - re) / 0.006;
  float lamp = pow(max(0.5 + 0.5 * cos(az * 120.0), 0.0), 40.0);
  acc += vec3(1.0, 0.72, 0.4) * exp(-rowv * rowv) * lamp * 1.4 * smoothstep(-2.4, -1.4, az) * (1.0 - smoothstep(1.2, 2.2, az)) * cityKeep(fract(floor(az * 120.0 / 6.2832) * 0.618 + 0.3));
  return acc;
}

vec3 rayDir(vec2 uv) {
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize((uCamWorld * vec4(p.xyz / p.w, 0.0)).xyz);
}
// 水面之上的「天空」：输入是折射到空气里的方向
vec3 skyColor(vec3 d) {
  vec3 day = mix(vec3(0.9, 0.85, 0.7), vec3(1.3, 1.25, 1.1), smoothstep(0.2, 1.0, d.y)) * uSkyBright;
  if (uSkyMode < 0.5) return day;
  // 夜：墨蓝天 + 城市灯（暖橙为主，零星红蓝霓虹）+ 一座桥的灯带
  vec3 c = mix(vec3(0.004, 0.005, 0.008), vec3(0.01, 0.012, 0.02), d.y);
  c += mix(vec3(0.02, 0.012, 0.006), vec3(0.0), smoothstep(0.0, 0.6, d.y)) * 2.0; // 城市的天光
  // 窗外（全反射）传进来的是正上方 (0,1,0)：atan(0,0) 在 Metal 上是 NaN，乘 0 也会把整片染成 NaN
  float az = abs(d.x) + abs(d.z) > 1e-7 ? atan(d.z, d.x) : 0.0;
  float el = asin(clamp(d.y, -1.0, 1.0));
  vec3 lights = vec3(0.0);
  for (int i = 0; i < 48; i++) {
    float fi = float(i);
    float a = fi * 2.39996 + 0.7;
    float e = 0.05 + 0.45 * fract(fi * 0.618 + 0.13);
    vec2 dd = vec2(az - a, el - e);
    dd.x = mod(dd.x + 3.14159, 6.28318) - 3.14159;
    float sz = 0.012 + 0.02 * fract(fi * 0.37);
    float g = exp(-dot(dd, dd) / (sz * sz));
    if (gBlur > 0.0) g = lampShape(dd, sz);
    if (uCityOff > 0.0) g *= cityKeep(fract(fi * 0.7548777 + 0.137));
    float hue = fract(fi * 0.731);
    vec3 col = hue < 0.72 ? vec3(1.0, 0.62, 0.28) : (hue < 0.86 ? vec3(1.0, 0.18, 0.2) : vec3(0.25, 0.45, 1.0));
    float flick = 0.85 + 0.15 * sin(uTime * (0.5 + hue * 2.0) + fi);
    lights += col * g * flick * (0.6 + 1.4 * fract(fi * 0.917));
  }
  // 桥：一条弧形的灯带
  float bridgeEl = 0.32 + 0.06 * cos(az * 1.5 - 0.8);
  float bx = (el - bridgeEl) / 0.012;   // 注意：GLSL 的 pow 对负底数无定义（Metal 上是 NaN），这里用平方
  float bl = exp(-bx * bx) * smoothstep(-1.6, -0.6, az) * (1.0 - smoothstep(0.9, 1.9, az));
  float dots = 0.5 + 0.5 * cos(az * 90.0);
  lights += vec3(1.0, 0.8, 0.5) * bl * (0.4 + 0.8 * dots) * 1.2 * uBridge;
  if (uCityDense > 0.0) {
    lights += (cityDense(az, el) + cityNear(az, el)) * uCityDense;
    // 城市把低空的天映成暖的（灯熄了也跟着淡）
    c += vec3(0.035, 0.02, 0.009) * uCityDense * uCityLights * exp(-max(el, 0.0) / 0.14) * (1.0 - 0.85 * uCityOff);
  }
  c += lights * uCityLights;
  c = mix(c, vec3(0.35, 0.38, 0.45) * (0.3 + 0.7 * d.y), uDawn * 0.8);
  return c;
}

void main() {
  vec3 dir = rayDir(vUv);
  vec3 col;
  // 两种水：沿视线分段累积到水面（或 70 米），再按最远处那种水补到无穷远
  float Tsurf = -1.0;
  vec3 accW = vec3(0.0), insFar = vec3(0.0);
  if (uMix2 > 0.0) {
    float dMax = 70.0;
    if (dir.y > 0.0) dMax = min(dMax, (uSurfaceY - uCamPos.y) / dir.y);
    vec4 wp4 = waterPathN(uCamPos, uCamPos + dir * dMax, hash12(vUv * 1733.0 + fract(uTime * 3.7) * 91.0), 16);
    vec3 far = uCamPos + dir * dMax;
    accW = wp4.rgb;
    Tsurf = wp4.a;
    insFar = inscatterW(dir, far.y, uMix2 * waterSide(far));
    col = accW + Tsurf * insFar;
  } else {
    col = inscatterDir(dir, uCamPos.y);
  }
  if (uOccAmt > 0.0) col *= mix(1.0, 0.5 * (occAt(uCamPos + dir * 3.0) + occAt(uCamPos + dir * 7.0)), 0.9);
  // 水面：往上看才有
  if (dir.y > 0.0) {
    float d = (uSurfaceY - uCamPos.y) / dir.y;
    if (d > 0.0 && d < 80.0) {
      vec3 hit = uCamPos + dir * d;
      // 波纹法线
      float t = uTime;
      vec2 q = hit.xz;
      float n1 = snoise(vec3(q * 0.35, t * 0.25));
      float n2 = snoise(vec3(q * 1.1 + 5.0, t * 0.45));
      float n3 = snoise(vec3(q * 3.3 - 2.0, t * 0.9));
      float fade = exp(-d * 0.06) * uRipple;
      vec3 nrm = normalize(vec3((n1 * 0.12 + n2 * 0.08 + n3 * 0.035) * fade, 1.0, ((n1 - n2) * 0.1 + n3 * 0.03) * fade));
      // 从水里射向水面：斯涅尔窗（入射角小于临界角才看得到天），窗边柔和过渡，窗外是全反射的暗水
      // 窗边只用低频的波纹（浑水里窗边本来就是糊的），避免碎成斑块
      vec3 nLow = normalize(vec3(n1 * 0.08 * fade, 1.0, n1 * 0.05 * fade));
      float ci = dot(dir, nLow);
      float tw = smoothstep(uWinEdge.x, uWinEdge.y, ci);
      vec3 refr = refract(dir, -nrm, 1.33);
      vec3 skyDir = dot(refr, refr) > 1e-4 ? normalize(refr) : vec3(0.0, 1.0, 0.0);
      vec3 refl = inscatterDir(reflect(dir, -nLow), uSurfaceY) * 0.6;
      if (Tsurf >= 0.0) gBlur = uSkyBlur * -log(max(Tsurf, 1e-4));
      vec3 surf = mix(refl, skyColor(skyDir) * 0.85, tw);
      if (Tsurf >= 0.0) {
        col = surf * pow(Tsurf, 0.92) + accW + 0.15 * Tsurf * insFar;
      } else {
        float T = exp(-uSigma * d * 0.92);
        col = surf * T + col * (1.0 - T * 0.85);
      }
    }
  }
  // 电感视觉的空水：极深的蓝黑 + 缓慢流动的淡场线 + 干扰雪花
  vec3 ep = uCamPos + dir * 9.0;
  float em = electroMask(ep);
  if (em > 0.0) {
    vec3 ec = E_BG;
    // 场线：沿水流方向拉长的细丝，缓慢流动
    vec3 fp = dir * 4.0 + uCamPos * 0.05;
    float st = snoise(vec3(fp.x * 0.8 + uTime * 0.02, fp.y * 9.0, fp.z * 0.8));
    float st2 = snoise(vec3(fp.x * 1.7 - uTime * 0.03, fp.y * 17.0 + 3.0, fp.z * 1.7));
    float lines = pow(max(st, 0.0), 5.0) * 0.7 + pow(max(st2, 0.0), 8.0) * 0.5;
    ec += E_DEEP * lines * 0.12 * uFieldLines * (1.0 - smoothstep(0.3, 0.9, abs(dir.y)));
    float snow = hash13(vec3(vUv * 1200.0, floor(uTime * 30.0)));
    ec += E_CORE * pow(snow, 18.0) * uENoise * 3.0 + vec3(snow * 0.04 * uENoise);
    ec += E_DEEP * uENoise * 0.08 * (0.5 + 0.5 * sin(uTime * 37.0 + dir.x * 40.0));
    if (uEWorldR > 0.0) ec *= electroWorld(ep);
    col = mix(col, ec, em);
  }
  col += E_CORE * electroRing(ep) * 0.25;
  gl_FragColor = vec4(col, 1.0);
}
`;

// 体积光束：从相机沿视线步进到场景深度，采样从水面投下来的柔和光柱
const SHAFT_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform float uNear;
uniform float uFar;
uniform float uShaftScale;
varying vec2 vUv;
float linDepth(float z) {
  float ndc = z * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - ndc * (uFar - uNear));
}
float shaftDensity(vec3 p) {
  vec2 q = p.xz - uSunDir.xz / max(uSunDir.y, 0.25) * (uSurfaceY - p.y);
  float t = uTime * 0.05;
  float a = snoise(vec3(q * 0.16 * uShaftScale, t));
  float b = snoise(vec3(q * 0.43 * uShaftScale + 3.0, t * 1.7));
  float c = snoise(vec3(q * 1.1 * uShaftScale - 7.0, t * 2.3));
  float s = smoothstep(0.1, 0.85, a * 0.6 + b * 0.3 + c * 0.1 + 0.25);
  return s * s;
}
void main() {
  vec4 p = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 vdir = p.xyz / p.w;
  vec3 dir = normalize((uCamWorld * vec4(vdir, 0.0)).xyz);
  float z = texture2D(tDepth, vUv).x;
  float dView = z >= 1.0 ? 40.0 : linDepth(z);
  float dist = min(dView / max(dot(normalize(vdir), vec3(0.0, 0.0, -1.0)), 0.05), 40.0);
  const int STEPS = 28;
  float jitter = hash12(vUv * 1024.0 + fract(uTime * 7.0));
  float dt = dist / float(STEPS);
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  for (int i = 0; i < STEPS; i++) {
    float tt = (float(i) + jitter) * dt;
    vec3 x = uCamPos + dir * tt;
    if (x.y > uSurfaceY) break;
    float depth = uSurfaceY - x.y;
    float light = exp(-uSigmaLight * depth) * shaftDensity(x) * occAt(x);
    // 前向散射：朝着光看更亮
    float phase = 0.35 + 0.65 * pow(max(dot(dir, uSunDir), 0.0), 3.0);
    float att = exp(-uSigma * tt);
    float em = electroMask(x);
    acc += uSunColor * light * phase * att * dt * (1.0 - em);
  }
  gl_FragColor = vec4(acc * 0.11 * uShafts, 1.0);
}
`;

// 合成：场景 + 光束 + 景深（按深度的圈散，黄金角螺旋采样）
const COMP_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tShaft;
uniform vec2 uRes;
uniform float uNear;
uniform float uFar;
uniform float uFocus;      // 对焦距离（米）
uniform float uAperture;   // 光圈：越大景深越浅（像素半径系数）
uniform float uMaxCoC;     // 最大模糊半径（像素）
varying vec2 vUv;
float linDepth(float z) {
  float ndc = z * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - ndc * (uFar - uNear));
}
float coc(float d) {
  return clamp(abs(d - uFocus) / max(d, 0.05) * uAperture, 0.0, uMaxCoC);
}
void main() {
  float d0 = linDepth(texture2D(tDepth, vUv).x);
  float c0 = coc(d0);
  vec3 col = texture2D(tScene, vUv).rgb;
  if (uAperture > 0.0 && uMaxCoC > 0.5) {
    vec3 acc = col;
    float wsum = 1.0;
    const int N = 40;
    for (int i = 1; i < N; i++) {
      float fi = float(i);
      float r = sqrt(fi / float(N)) * uMaxCoC;
      float a = fi * 2.39996;
      vec2 off = vec2(cos(a), sin(a)) * r / uRes;
      vec2 uv = vUv + off;
      float d = linDepth(texture2D(tDepth, uv).x);
      float c = coc(d);
      // 样本自己的圈散覆盖到这里才算；背景样本不能越过比它近的清晰前景
      float w = smoothstep(r - 1.0, r + 1.0, c) ;
      if (d > d0 + 0.3) w *= smoothstep(r - 1.0, r + 1.0, c0);
      vec3 s = texture2D(tScene, uv).rgb;
      acc += s * w;
      wsum += w;
    }
    col = acc / wsum;
  }
  col += texture2D(tShaft, vUv).rgb;
  gl_FragColor = vec4(col, 1.0);
}
`;

export class UnderwaterWorld {
  constructor(ctx, { water = makeWaterUniforms() } = {}) {
    this.ctx = ctx;
    const { W, H } = ctx;
    this.water = water;
    this.scene = new THREE.Scene();
    this.scene.autoUpdate = true;
    const depthTex = new THREE.DepthTexture(W, H);
    depthTex.type = THREE.FloatType;
    this.rt = new THREE.WebGLRenderTarget(W, H, {
      type: THREE.HalfFloatType, samples: 4, depthBuffer: true, depthTexture: depthTex,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.rtShaft = new THREE.WebGLRenderTarget(W / 2, H / 2, { type: THREE.HalfFloatType, depthBuffer: false });
    // 背景四边形（最先画，不写深度）
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.bgMat = new THREE.ShaderMaterial({
      uniforms: {
        ...water, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
        uSkyMode: { value: 0 }, uSkyBright: { value: 1 }, uCityLights: { value: 1 }, uDawn: { value: 0 }, uFieldLines: { value: 1 },
        uCityOff: { value: 0 }, uCityDense: { value: 0 }, uBridge: { value: 1 }, uRipple: { value: 1 },
        uWinEdge: { value: new THREE.Vector2(0.56, 0.8) }, uSkyBlur: { value: 0 },
      },
      vertexShader: FS_VERT, fragmentShader: BG_FRAG, depthTest: false, depthWrite: false,
    });
    this.bg = new THREE.Mesh(tri, this.bgMat);
    this.bg.frustumCulled = false;
    this.bg.renderOrder = -100;
    this.scene.add(this.bg);
    this.shaftMat = new THREE.ShaderMaterial({
      uniforms: {
        ...water, tDepth: { value: depthTex }, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
        uNear: { value: 0.05 }, uFar: { value: 200 }, uShaftScale: { value: 1 },
      },
      vertexShader: FS_VERT, fragmentShader: SHAFT_FRAG, depthTest: false, depthWrite: false,
    });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.rt.texture }, tDepth: { value: depthTex }, tShaft: { value: this.rtShaft.texture },
        uRes: { value: new THREE.Vector2(W, H) }, uNear: { value: 0.05 }, uFar: { value: 200 },
        uFocus: { value: 3 }, uAperture: { value: 0 }, uMaxCoC: { value: 0 },
      },
      vertexShader: FS_VERT, fragmentShader: COMP_FRAG, depthTest: false, depthWrite: false,
    });
  }

  add(...objs) { this.scene.add(...objs); }

  /**
   * 渲染一帧到 ctx.target。
   * o: { t, camera, sky: {mode, bright, city, dawn}, dof: {focus, aperture, max}, shafts, shaftScale, fieldLines }
   * sky 的可选项（不给 = 原来的样子）：cityOff 0..1 灯一盏盏熄的进度、dense 天际线密集小灯的亮度、
   *   bridge 桥灯带倍数、ripple 水面波纹倍数、winEdge [lo, hi] 斯涅尔窗边缘、blur 浑水里灯晕开的程度（两种水时）
   */
  render(ctx, o) {
    const w = this.water;
    const cam = o.camera;
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    w.uTime.value = o.t;
    w.uCamPos.value.copy(cam.position);
    const bu = this.bgMat.uniforms;
    bu.uInvProj.value.copy(cam.projectionMatrixInverse);
    bu.uCamWorld.value.copy(cam.matrixWorld);
    const sky = o.sky || {};
    bu.uSkyMode.value = sky.mode ?? 0;
    bu.uSkyBright.value = sky.bright ?? 1;
    bu.uCityLights.value = sky.city ?? 1;
    bu.uDawn.value = sky.dawn ?? 0;
    bu.uCityOff.value = sky.cityOff ?? 0;
    bu.uCityDense.value = sky.dense ?? 0;
    bu.uBridge.value = sky.bridge ?? 1;
    bu.uRipple.value = sky.ripple ?? 1;
    bu.uWinEdge.value.set(...(sky.winEdge ?? [0.56, 0.8]));
    bu.uSkyBlur.value = sky.blur ?? 0;
    bu.uFieldLines.value = o.fieldLines ?? 1;
    const r = ctx.renderer;
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(this.scene, cam);
    // 光束（半分辨率）
    const su = this.shaftMat.uniforms;
    su.uInvProj.value.copy(cam.projectionMatrixInverse);
    su.uCamWorld.value.copy(cam.matrixWorld);
    su.uNear.value = cam.near; su.uFar.value = cam.far;
    su.uShaftScale.value = o.shaftScale ?? 1;
    ctx.film.post.blit(this.shaftMat, this.rtShaft);
    // 合成 + 景深
    const cu = this.compMat.uniforms;
    cu.uNear.value = cam.near; cu.uFar.value = cam.far;
    const dof = o.dof || {};
    cu.uFocus.value = dof.focus ?? 3;
    cu.uAperture.value = dof.aperture ?? 0;
    cu.uMaxCoC.value = dof.max ?? 0;
    ctx.blit(this.compMat);
  }
}
