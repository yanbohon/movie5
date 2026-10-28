// 鱼：程序化几何 + 沿脊柱蒙皮游动 + 同一 pass 里的「真实 / 电感」两套着色。
// 用法：const f = new Fish({ species: 'paddlefish', L: 3.5, water }); scene.add(f.group);
//       每帧 f.update({ path, u, phase, amp, ... })，path.pos(u) 返回弧长 u 处的世界坐标 [x,y,z]。
import * as THREE from 'three';
import { COMMON } from './glsl.js';
import {
  PADDLEFISH_PROFILE, STURGEON_PROFILE, makeProfile, buildBody, paddlefishFins, rigidPart, spherePts,
  cylinderPts, mergeGeos, sectionPoint, buildFin,
} from './fishgeo.js';

export const NS = 48; // 脊柱采样数

const SKIN_VERT = /* glsl */ `
#define NS ${NS}
attribute vec3 aBody;
attribute vec3 aNrm;
#ifdef FINS
attribute vec4 aFin;
attribute vec3 aFlap;
varying vec4 vFin;
#else
attribute vec3 aSec;
attribute float aPart;
varying vec3 vSec;
varying float vPart;
#endif
uniform vec3 uSpP[NS];
uniform vec3 uSpN[NS];
uniform vec3 uSpB[NS];
uniform float uPhase;
uniform float uPect;
uniform float uFlutter;
uniform float uBreath;
uniform float uLen;
varying vec3 vWorld;
varying vec3 vNw;
varying vec3 vBody;
varying vec2 vUv2;

void frameAt(float s, out vec3 P, out vec3 T, out vec3 N, out vec3 B) {
  float f = clamp(s, 0.0, 1.0) * float(NS - 1);
  int i0 = int(floor(f));
  int i1 = min(i0 + 1, NS - 1);
  float k = f - float(i0);
  // 越过两端（吻尖前、尾尖后）按端点切线外推
  float over = s < 0.0 ? s : (s > 1.0 ? s - 1.0 : 0.0);
  P = mix(uSpP[i0], uSpP[i1], k);
  N = normalize(mix(uSpN[i0], uSpN[i1], k));
  B = normalize(mix(uSpB[i0], uSpB[i1], k));
  T = normalize(cross(B, N));
  P -= T * over * uLen;
}

void main() {
  vec3 P, T, N, B;
  frameAt(aBody.x, P, T, N, B);
  vec3 loc = vec3(0.0, aBody.z, aBody.y);   // (前, 上, 横)
  vec3 nl = aNrm;
#ifdef FINS
  float id = aFin.x, v = aFin.y, u = aFin.z, side = aFin.w;
  if (id > 3.5 && id < 4.5) {
    float a = uPect * pow(v, 1.3) * sin(uPhase * 0.5 + u * 0.8 + (side > 0.0 ? 0.0 : 0.5));
    loc += aFlap * a;
  } else if (id > 2.5 && id < 3.5) {
    loc += aFlap * uPect * 0.35 * pow(v, 1.5) * sin(uPhase * 0.5 + 1.3 + (side > 0.0 ? 0.0 : 0.6));
  } else if (id > 8.5) {
    // 信标飘带：沿身体往后，末端大幅摆动
    loc.z += uFlutter * 5.0 * pow(v, 1.6) * sin(uPhase * 1.7 - v * 5.0) + 0.012 * v * sin(uPhase * 3.1 + v * 9.0);
    loc.y += 0.006 * v * sin(uPhase * 2.3 - v * 4.0);
  } else {
    loc.z += uFlutter * pow(v, 2.0) * sin(uPhase - 1.3 - v * 1.2 - u * 0.8);
  }
  vFin = aFin;
#else
  vSec = aSec;
  vPart = aPart;
  // 鳃盖随呼吸微微张开（只在身体上、鳃盖后缘附近）
  if (aPart < 0.5) {
    float s = aBody.x;
    float edge = 0.40 + 0.075 * pow(max(0.0, 1.0 - abs(aSec.x + 0.1) / 0.85), 1.6);
    float m = smoothstep(edge - 0.05, edge - 0.004, s) * (1.0 - smoothstep(edge - 0.004, edge + 0.002, s)) * smoothstep(0.25, 0.6, abs(aSec.y));
    loc += nl * m * uBreath * 0.006 * uLen;
  }
#endif
  vec3 wp = P + T * loc.x + B * loc.y + N * loc.z;
  vNw = normalize(T * nl.x + B * nl.y + N * nl.z);
  vWorld = wp;
  vBody = vec3(aBody.x * uLen, aBody.z, aBody.y);  // 身体固定坐标（米）：沿轴、竖、横
  vUv2 = vec2(aBody.x, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

// 白鲟皮肤：反荫蔽色、吻上的感觉孔、侧线、鳃盖长尖角、口、两道旧伤（二十四针的疤）
const PADDLE_SKIN = /* glsl */ `
float cellPore(vec2 q, float cs, float r, float seed) {
  vec2 id = floor(q / cs);
  float best = 1e9;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = id + vec2(float(x), float(y));
    vec2 o = hash22(c + seed);
    float keep = step(0.28, hash12(c * 1.7 + seed * 3.1));
    vec2 p = (c + 0.15 + 0.7 * o) * cs;
    float d = length(q - p) + (1.0 - keep) * 1e3;
    best = min(best, d);
  }
  return 1.0 - smoothstep(r * 0.45, r, best);
}
float lineSeg(vec2 p, vec2 a, vec2 b, float w) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return 1.0 - smoothstep(w * 0.4, w, length(pa - ba * h));
}
// 返回反照率；pore 输出感觉孔强度（电感视觉里会发光），gill 为鳃盖缘
vec3 skinPaddle(vec3 q, float s, float vn, float ln, float arc, out float pore, out float gill, out float rough) {
  float L = uLen;
  vec3 back = vec3(0.15, 0.165, 0.175);
  vec3 flank = vec3(0.43, 0.44, 0.44);
  vec3 belly = vec3(0.74, 0.725, 0.69);
  vec3 c = mix(belly, flank, smoothstep(-0.62, 0.02, vn));
  c = mix(c, back, smoothstep(0.02, 0.72, vn));
  // 吻：背面灰褐、腹面浅，越到尖端越暗
  float r = 1.0 - smoothstep(0.255, 0.315, s);
  // 目击者（2003）：「微红光亮的吻像长长的鼻子」
  vec3 rostTop = vec3(0.145, 0.128, 0.12) * mix(0.72, 1.0, smoothstep(0.0, 0.22, s));
  vec3 rostBot = vec3(0.43, 0.398, 0.378);
  c = mix(c, mix(rostBot, rostTop, smoothstep(-0.25, 0.25, vn)), r);
  // 大块斑驳与细纹
  float m = fbm3(q * vec3(2.2, 5.0, 5.0) + 3.1);
  c *= 0.9 + 0.12 * m;
  float fine = snoise(q * vec3(28.0, 60.0, 60.0));
  c *= 0.97 + 0.03 * fine;
  // 目击者：「背部呈清灰色，局部带有梅花状斑点」—— 背上稀疏的几簇，每簇五个小暗点围成一朵
  {
    vec2 bq = vec2(q.x, arc);
    float cs = 0.075;
    vec2 id = floor(bq / cs);
    float plum = 0.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 cid = id + vec2(float(x), float(y));
      float keep = step(0.72, hash12(cid * 3.3 + 17.0));
      vec2 ctr = (cid + 0.25 + 0.5 * hash22(cid + 5.0)) * cs;
      float rot = hash12(cid + 9.0) * 6.283;
      float cw = 0.5 + 0.5 * hash12(cid + 23.0);
      for (int k = 0; k < 5; k++) {
        float fk = float(k);
        float a = rot + fk * 1.2566 + (hash12(cid + fk * 3.1) - 0.5) * 0.7;
        vec2 dp = ctr + vec2(cos(a), sin(a)) * 0.0085 * (0.75 + 0.5 * hash12(cid + fk * 7.7));
        float rr = 0.0019 + 0.0016 * hash12(cid + fk * 5.3);
        plum = max(plum, keep * cw * (1.0 - smoothstep(rr * 0.4, rr * 1.6, length(bq - dp))));
      }
    }
    float onBack = smoothstep(0.15, 0.45, vn) * smoothstep(0.3, 0.36, s) * (1.0 - smoothstep(0.85, 0.92, s));
    c *= 1.0 - 0.26 * plum * onBack * (0.7 + 0.3 * m);
  }
  // 感觉孔：吻的上下两面布满，靠近中线稀疏；头部、鳃盖上也有成片的孔
  float band = smoothstep(0.08, 0.35, abs(ln)) * r;
  float headField = smoothstep(0.28, 0.31, s) * (1.0 - smoothstep(0.40, 0.44, s)) * smoothstep(0.1, 0.5, abs(ln)) * smoothstep(-0.7, 0.2, vn);
  vec2 pq = vec2(q.x, arc);
  float p1 = cellPore(pq, 0.0095, 0.0016, 1.0) * (band + 0.12 * r);
  float p2 = cellPore(pq + 3.7, 0.016, 0.0013, 7.0) * headField * 0.7;
  pore = clamp(p1 + p2, 0.0, 1.0);
  c *= 1.0 - 0.55 * pore;
  // 侧线
  float ll = smoothstep(0.42, 0.46, s) * (1.0 - smoothstep(0.86, 0.9, s));
  float lline = ll * (1.0 - smoothstep(0.0, 0.05, abs(vn - 0.22))) * smoothstep(0.2, 0.6, abs(ln));
  c = mix(c, c * 1.35 + 0.02, lline * 0.6);
  // 鳃盖后缘：从上到下的弧，中下部拖成长尖角
  float edge = 0.40 + 0.075 * pow(max(0.0, 1.0 - abs(vn + 0.1) / 0.85), 1.6);
  float gd = (s - edge) * L;
  gill = (1.0 - smoothstep(0.0, 0.012, abs(gd))) * smoothstep(0.15, 0.5, abs(ln)) * (1.0 - smoothstep(0.75, 0.9, abs(vn)));
  c *= 1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.012, gd)) * smoothstep(-0.003, 0.003, gd) * smoothstep(0.15, 0.5, abs(ln));
  c = mix(c, c * 1.15, (1.0 - smoothstep(-0.03, 0.0, gd)) * smoothstep(-0.05, -0.03, gd));
  // 口：头部腹面一道宽 U 形的线
  float mouthS = 0.375 - 0.055 * ln * ln;
  float mouth = (1.0 - smoothstep(0.002, 0.006, abs(s - mouthS) * L / 3.5)) * smoothstep(-0.45, -0.75, vn) * step(abs(ln), 0.85);
  c *= 1.0 - 0.6 * mouth;
  // 旧伤：头侧下方两道浅色疤，每道 12 个缝针印（2003 年的二十四针）
  vec2 hp = vec2(s * L, vn);
  float sc = 0.0, st = 0.0;
  for (int k = 0; k < 2; k++) {
    vec2 a = k == 0 ? vec2(0.335 * L, -0.34) : vec2(0.352 * L, -0.12);
    vec2 b = k == 0 ? vec2(0.372 * L, -0.46) : vec2(0.384 * L, -0.24);
    float side = k == 0 ? 1.0 : -1.0;
    float sideMask = step(0.0, ln * side) * smoothstep(0.35, 0.6, abs(ln));
    vec2 hp2 = vec2(hp.x, hp.y * 0.55 * L);
    vec2 a2 = vec2(a.x, a.y * 0.55 * L), b2 = vec2(b.x, b.y * 0.55 * L);
    sc += lineSeg(hp2, a2, b2, 0.006) * sideMask;
    for (int j = 0; j < 12; j++) {
      float tj = (float(j) + 0.5) / 12.0;
      vec2 m0 = mix(a2, b2, tj);
      vec2 dir = normalize(b2 - a2);
      vec2 perp = vec2(-dir.y, dir.x);
      st += lineSeg(hp2, m0 - perp * 0.009, m0 + perp * 0.009, 0.0022) * sideMask;
    }
  }
  c = mix(c, vec3(0.62, 0.6, 0.57), clamp(sc * 0.55 + st * 0.35, 0.0, 0.8));
  rough = 0.45 + 0.2 * m;
  return c;
}
`;

// 鲟皮肤：深灰褐背、白腹，粗糙
const STURGEON_SKIN = /* glsl */ `
vec3 skinSturgeon(vec3 q, float s, float vn, float ln, float arc, out float pore, out float gill, out float rough) {
  vec3 back = vec3(0.075, 0.068, 0.058);
  vec3 flank = vec3(0.19, 0.175, 0.15);
  vec3 belly = vec3(0.56, 0.54, 0.5);
  vec3 c = mix(belly, flank, smoothstep(-0.7, -0.1, vn));
  c = mix(c, back, smoothstep(-0.1, 0.6, vn));
  float m = fbm3(q * vec3(3.0, 6.0, 6.0) + 11.0);
  c *= 0.85 + 0.2 * m;
  // 老鱼：几块褪色的斑
  c = mix(c, c * 1.35 + vec3(0.012), smoothstep(0.3, 0.62, fbm3(q * 1.6 + 5.0)) * 0.55);
  // 细小的皮肤颗粒（鲟的皮肤有细小骨粒）
  float gr = snoise(q * 90.0);
  c *= 0.93 + 0.07 * gr;
  // 疤：几道短的斜痕（老鱼，被螺旋桨和滚钩刮过）
  float scar = 0.0;
  for (int k = 0; k < 5; k++) {
    float fk = float(k);
    vec2 a = vec2((0.3 + fk * 0.085) * uLen, -0.05 + 0.09 * sin(fk * 2.3));
    vec2 b = a + vec2(0.07 * uLen, 0.06 * cos(fk * 1.7) + 0.03);
    vec2 pp = vec2(q.x, arc);
    vec2 pa = pp - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    float d = length(pa - ba * h);
    scar += (1.0 - smoothstep(0.002, 0.008, d)) * smoothstep(-0.3, 0.3, snoise(q * 9.0 + fk * 3.1)) * (0.6 + 0.4 * snoise(q * 25.0 + fk));
  }
  c = mix(c, c * 1.8 + vec3(0.035, 0.025, 0.02), clamp(scar, 0.0, 0.7));
  // 口（腹面横裂）与鳃盖缘（只在两侧）
  float mouth = (1.0 - smoothstep(0.003, 0.008, abs(s - 0.115) * uLen)) * smoothstep(-0.6, -0.85, vn) * step(abs(ln), 0.55);
  c *= 1.0 - 0.7 * mouth;
  float edge = 0.225 + 0.03 * vn * vn;
  float gd = (s - edge) * uLen;
  gill = (1.0 - smoothstep(0.0, 0.01, abs(gd))) * smoothstep(0.35, 0.65, abs(ln)) * (1.0 - smoothstep(0.55, 0.8, abs(vn)));
  c *= 1.0 - 0.45 * gill;
  // 吻部感觉孔（鲟也有，稀疏）
  float r = 1.0 - smoothstep(0.08, 0.16, s);
  pore = r * smoothstep(0.6, 0.95, snoise(q * 70.0)) * step(vn, 0.3);
  rough = 0.7;
  return c;
}
`;

const SKIN_FRAG = (species) => /* glsl */ `
${COMMON}
uniform float uLen;
uniform float uPhase;
uniform float uHeart;     // 心跳 0..1（电感视觉里身体的微光）
uniform float uLife;      // 生命力 1→0（最后一场逐渐熄灭）
uniform float uPoreGlow;  // 感觉孔在电感视觉里的亮度
uniform float uBodyGlow;
uniform float uDbg;
uniform float uTagAge;
uniform vec4 uEye;
varying vec3 vWorld;
varying vec3 vNw;
varying vec3 vBody;
varying vec3 vSec;
varying float vPart;
${species === 'sturgeon' ? STURGEON_SKIN : PADDLE_SKIN}
void main() {
  vec3 wp = vWorld;
  vec3 N = normalize(vNw);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uCamPos - wp);
  float s = vBody.x / uLen;
  vec3 q = vBody;
  float pore = 0.0, gill = 0.0, rough = 0.5;
  vec3 alb;
  float part = vPart;
  if (uDbg > 4.5 && uDbg < 5.5 && part > 6.5 && part < 7.5) discard;
  if (part < 0.5) {
    alb = ${species === 'sturgeon' ? 'skinSturgeon' : 'skinPaddle'}(q, s, vSec.x, vSec.y, vSec.z, pore, gill, rough);
    // 细微凹凸：扰动法线
    vec3 bump = vec3(snoise(q * 34.0), snoise(q * 34.0 + 13.0), snoise(q * 34.0 + 29.0));
    vec3 wrinkle = vec3(snoise(q * vec3(40.0, 160.0, 160.0)), snoise(q * vec3(40.0, 160.0, 160.0) + 7.0), snoise(q * vec3(40.0, 160.0, 160.0) + 21.0));
    N = normalize(N + bump * 0.06 + wrinkle * 0.025);
    // 眼窝：眼球周围一圈皮肤压暗（眼睑的影），眼睛嵌在皮里，不是贴上去的珠子
    float re = length(vec2(q.x - uEye.x, q.y - uEye.y)) / uEye.w;
    alb *= 1.0 - 0.6 * (1.0 - smoothstep(0.95, 1.9, re));
  } else if (part < 6.5) {
    // 眼：黑瞳 + 金灰虹膜（放射纹、瞳缘一圈亮）+ 暗角膜缘；在眼球局部坐标里画（uEye = 中心 s·L、竖、|横|，半径）
    vec3 d = vec3(q.x - uEye.x, q.y - uEye.y, abs(q.z) - uEye.z) / uEye.w;
    float rho = length(d.xy);
    float ang = atan(d.y, d.x);
    float stri = snoise(vec3(cos(ang) * 4.0, sin(ang) * 4.0, rho * 2.0)) * 0.55 + snoise(vec3(cos(ang) * 10.0, sin(ang) * 10.0, rho * 3.0 + 5.0)) * 0.45;
    vec3 iris = mix(vec3(0.06, 0.055, 0.045), vec3(0.3, 0.27, 0.19), smoothstep(-0.55, 0.65, stri));
    iris = mix(iris, vec3(0.4, 0.35, 0.24), smoothstep(0.54, 0.48, rho) * 0.6);   // 瞳缘亮圈
    iris *= 1.0 - 0.85 * smoothstep(0.64, 0.8, rho);                           // 角膜缘暗圈
    alb = mix(vec3(0.005, 0.005, 0.006), iris, smoothstep(0.43, 0.47, rho));
    rough = 0.12;
  } else if (part < 7.5) {
    // 信标：旧金属 + 锈 + 藻（随 uTagAge 变老）
    float fb = fbm3(q * 60.0);
    float rust = smoothstep(0.1 - 0.5 * uTagAge, 0.4 - 0.4 * uTagAge, fbm3(q * 90.0 + 7.0));
    float a = smoothstep(0.55 - 1.1 * uTagAge, 0.9 - 0.9 * uTagAge, fb);
    alb = mix(vec3(0.24, 0.24, 0.23), vec3(0.2, 0.1, 0.045), rust * 0.8);
    alb = mix(alb, vec3(0.07, 0.085, 0.04) * (0.8 + 0.4 * snoise(q * 200.0)), a);
    rough = mix(0.3, 0.9, max(a, rust));
  } else if (part < 8.5) {
    // 鲟的骨板：骨白偏黄、带细纹、边缘暗
    alb = mix(vec3(0.085, 0.08, 0.07), vec3(0.19, 0.18, 0.155), 0.5 + 0.5 * snoise(q * 45.0)) * (0.85 + 0.2 * snoise(q * 140.0));
    rough = 0.8;
  } else if (part < 9.5) {
    alb = vec3(0.26, 0.21, 0.19); rough = 0.6;  // 须：带点肉色
  } else {
    alb = vec3(0.004, 0.004, 0.005); rough = 0.05; // 瞳孔
  }
  // ---- 真实视角：浑水里的光 ----
  vec3 Li = lightAt(wp);
  float depth = max(uSurfaceY - wp.y, 0.0);
  float att = exp(-uSigmaLight * depth * 0.6);
  float wrap = (part > 6.5 && part < 7.5) ? 0.9 : 0.45;
  float diff = max(0.0, (dot(N, uSunDir) + wrap) / (1.0 + wrap));
  vec3 amb = mix(uAmbDown, uAmbUp, N.y * 0.5 + 0.5) * att;
  if (part > 6.5 && part < 7.5) amb += uAmbUp * att * 0.8 * max(0.0, -N.y);
  vec3 H = normalize(uSunDir + V);
  float sp = pow(max(dot(N, H), 0.0), mix(90.0, 12.0, rough)) * mix(0.55, 0.05, rough) * (part < 0.5 ? 0.45 : 1.0);
  float fres = pow(clamp(1.0 - dot(N, V), 0.0, 1.0), 3.0);
  vec3 col = alb * (Li * diff + amb) + Li * sp + mix(uFogDown, uFogUp, 0.5) * fres * 0.6 * att;
  if ((part > 5.5 && part < 6.5) || part > 9.5) {
    vec3 R = reflect(-V, N);
    col += Li * pow(max(dot(R, uSunDir), 0.0), 240.0) * 1.4;
    col += (Li * 0.3 + uAmbUp * att) * smoothstep(0.55, 0.92, R.y) * 0.55;
  }
  col = applyWater(col, wp);
  // ---- 电感视觉 ----
  float heart = uHeart;
  vec3 ec = E_BG * 0.6;
  ec += E_DEEP * (0.05 + 0.10 * heart) * (0.35 + 0.65 * fres) * uBodyGlow;
  ec += E_CORE * fres * fres * 0.06 * uBodyGlow;
  float spark = 0.6 + 0.4 * sin(uTime * 6.0 + dot(q, vec3(91.0, 37.0, 53.0)));
  ec += E_CORE * pore * uPoreGlow * (1.4 + 1.6 * spark) * (0.35 + 0.65 * heart);
  ec += E_CORE * gill * 0.35 * uBodyGlow * (0.5 + 0.5 * sin(uTime * 1.9));
  // 肌节：沿身体的 W 形微光，随游动起伏
  float myo = pow(0.5 + 0.5 * sin(q.x * 16.0 - abs(vSec.x) * 2.6 - uPhase * 0.5), 40.0);
  ec += E_DEEP * myo * 0.05 * smoothstep(0.4, 0.5, s) * (1.0 - smoothstep(0.88, 0.97, s)) * uBodyGlow;
  if ((part > 5.5 && part < 6.5) || part > 9.5) ec = vec3(0.0);
  if (part > 6.5 && part < 7.5) ec = E_BG * 0.4;
  ec *= uLife * electroFade(wp);
  float em = electroMask(wp);
  col = mix(col, ec, em);
  col += E_CORE * electroRing(wp) * 0.45;
  if (uDbg > 5.5 && part > 6.5 && part < 7.5) col = vec3(2.0, 0.0, 2.0) * (0.3 + 0.7 * max(dot(N, V), 0.0));
  if (uDbg > 0.5 && uDbg < 4.5) col = uDbg < 1.5 ? vec3(pore) : (uDbg < 2.5 ? vec3(gill) : (uDbg < 3.5 ? alb : vec3(fract(s * 20.0), vSec.x * 0.5 + 0.5, vSec.y * 0.5 + 0.5)));
  gl_FragColor = vec4(col, 1.0);
}
`;

const FIN_FRAG = (species) => /* glsl */ `
${COMMON}
uniform float uLen;
uniform float uHeart;
uniform float uLife;
uniform float uBodyGlow;
uniform float uTagAge;
uniform vec4 uEye;
varying vec3 vWorld;
varying vec3 vNw;
varying vec3 vBody;
varying vec4 vFin;
void main() {
  vec3 wp = vWorld;
  vec3 V = normalize(uCamPos - wp);
  vec3 N = normalize(vNw);
  if (dot(N, V) < 0.0) N = -N;
  float id = vFin.x, v = vFin.y, u = vFin.z;
  float alpha;
  vec3 alb;
  if (id > 8.5) {
    // 褪色的黄飘带
    float a = smoothstep(-0.5, 0.8, snoise(vec3(u * 2.0, v * 9.0, 1.0))) * 0.8;
    vec3 fresh = mix(vec3(0.42, 0.34, 0.12), vec3(0.2, 0.2, 0.1), a * 0.6 + v * 0.3);
    vec3 old = mix(vec3(0.3, 0.29, 0.25), vec3(0.12, 0.13, 0.08), a * 0.7 + v * 0.2);
    alb = mix(fresh, old, uTagAge);
    float fray = snoise(vec3(u * 9.0, v * 14.0, 4.0)) * 0.25 * uTagAge;
    alpha = 0.95 * (1.0 - smoothstep(0.92 - 0.35 * uTagAge + fray, 1.0 - 0.3 * uTagAge + fray, v));
  } else {
    // 鳍膜与鳍条：鳍条沿展向，间距按弦向
    float nr = id > 4.5 ? 34.0 : 16.0;
    float ray = pow(abs(sin(u * nr * 3.14159)), 6.0);
    float edge = 1.0 - smoothstep(0.78, 1.0, v);
    // 老鱼的鳍边破损
    float tat = snoise(vec3(u * 26.0, v * 5.0, id * 3.3));
    float torn = smoothstep(0.55, 0.9, v + tat * 0.22);
    alpha = (${species === 'sturgeon' ? '0.72 + 0.14' : '0.5 + 0.4'} * ray) * mix(1.0, 0.55, v) * (1.0 - torn * 0.85) * (0.35 + 0.65 * edge);
    alpha *= smoothstep(0.0, 0.06, v + 0.03);
    alb = mix(vec3(0.2, 0.21, 0.22), vec3(0.34, 0.33, 0.31), v) * (0.85 + 0.25 * ray);
    ${species === 'sturgeon' ? 'alb *= vec3(0.8, 0.74, 0.66);' : ''}
  }
  vec3 Li = lightAt(wp);
  float depth = max(uSurfaceY - wp.y, 0.0);
  float att = exp(-uSigmaLight * depth * 0.6);
  float diff = max(0.0, (dot(N, uSunDir) + 0.6) / 1.6);
  // 透光：从背面照过来的光穿过鳍膜
  float trans = pow(max(dot(-V, uSunDir), 0.0), 2.0) * 0.5;
  vec3 amb = mix(uAmbDown, uAmbUp, N.y * 0.5 + 0.5) * att;
  vec3 col = alb * (Li * (diff + trans) + amb);
  col = applyWater(col, wp);
  vec3 ec = E_DEEP * (0.03 + 0.05 * uHeart) * uBodyGlow + E_CORE * pow(abs(sin(u * 20.0)), 20.0) * 0.05 * uBodyGlow;
  if (id > 8.5) ec = vec3(0.0);
  ec *= uLife * electroFade(wp);
  float em = electroMask(wp);
  col = mix(col, ec, em);
  col += E_CORE * electroRing(wp) * 0.35;
  gl_FragColor = vec4(col, alpha * mix(1.0, 0.5, em));
}
`;

/** 信标在身体上的位置（沿轴 s、绕轴角 θ，0 为正背） */
export const TAG_S = 0.6, TAG_THETA = 0.8;

/** 路径：一串控制点的 Catmull-Rom 曲线，按弧长取点，两端直线外推 */
export class Path {
  constructor(points, { samples = 800, closed = false } = {}) {
    this.curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), closed, 'centripetal', 0.5);
    this.len = this.curve.getLength();
    this.curve.arcLengthDivisions = samples;
    this._a = this.curve.getPointAt(0);
    this._b = this.curve.getPointAt(1);
    this._ta = this.curve.getTangentAt(0);
    this._tb = this.curve.getTangentAt(1);
  }
  pos(u, out = new THREE.Vector3()) {
    if (u <= 0) return out.copy(this._a).addScaledVector(this._ta, u);
    if (u >= this.len) return out.copy(this._b).addScaledVector(this._tb, u - this.len);
    return this.curve.getPointAt(u / this.len, out);
  }
}

export class Fish {
  /**
   * @param {object} o species: 'paddlefish' | 'sturgeon'；L 全长（米）；water 共享水体 uniforms（world.js）
   */
  constructor({ species = 'paddlefish', L = 3.5, water, tag = species === 'paddlefish' }) {
    this.species = species;
    this.L = L;
    const P = makeProfile(species === 'sturgeon' ? STURGEON_PROFILE : PADDLEFISH_PROFILE);
    this.P = P;
    const parts = [buildBody(P, L, { nS: species === 'sturgeon' ? 220 : 300, nT: 64 })];
    const finGeos = [];
    let eyeU = [0, 0, 0, 1];
    if (species === 'paddlefish') {
      finGeos.push(...paddlefishFins(P, L));
      // 眼睛：吻根两侧，极小
      for (const side of [1, -1]) {
        const s = 0.304;
        const [lat, vert] = sectionPoint(P, L, s, side * 1.38);
        const r = 0.0031 * L;
        const zc = lat * 0.985 - side * r * 0.2;   // 眼球中心往里收，露出的弧更浅
        const e = spherePts([-s * L, vert, zc], r, 18, 12, [1, 1, 0.8]);
        parts.push(rigidPart(e.pts, e.nrms, e.idx, L, 6));
        const p = spherePts([-s * L, vert, zc + side * r * 0.42], r * 0.52, 14, 10, [1, 1, 0.7]);
        parts.push(rigidPart(p.pts, p.nrms, p.idx, L, 10));
        if (side === 1) { this.eyeLocal = [s, lat * 0.985 + r * 0.6, vert]; eyeU = [s * L, vert, Math.abs(zc), r]; }
      }
      if (tag) {
        // 信标：2003 年装在她「腰段侧身部」（成都商报采访穆天荣），身体中段偏上的侧面
        const s = TAG_S;
        const [lat, vert] = sectionPoint(P, L, s, TAG_THETA);
        const x = -s * L;
        // 超声波信标：直径约 2 厘米、长 9 厘米的圆柱，两头圆，两道扎线
        // 贴着皮肤：沿截面法向（从截面中心指向表面点）抬起一个半径
        const cy = P.c(s) * L, nl = Math.hypot(lat, vert - cy) || 1;
        const nz = lat / nl, ny = (vert - cy) / nl;
        // 两端各按自己那一截的表面抬起（身体往前变粗，只按中点算的话前端会埋进皮肤）
        const endAt = (dx) => {
          const se = s - dx / L;
          const [la, ve] = sectionPoint(P, L, se, TAG_THETA);
          const ce = P.c(se) * L, n2 = Math.hypot(la, ve - ce) || 1;
          return [x + dx, ve + ((ve - ce) / n2) * 0.0118, la + (la / n2) * 0.0118];
        };
        const a0 = endAt(0.045), a1 = endAt(-0.045);
        const c = cylinderPts(a0, a1, 0.0105, 0.0105, 28, 6);
        parts.push(rigidPart(c.pts, c.nrms, c.idx, L, 7));
        for (const e of [a0, a1]) {
          const cap = spherePts(e, 0.0106, 28, 14, [0.55, 1, 1]);
          parts.push(rigidPart(cap.pts, cap.nrms, cap.idx, L, 7));
        }
        for (const k of [0.25, 0.75]) {
          const m = a0.map((v, i) => v + (a1[i] - v) * k);
          const band = cylinderPts([m[0] + 0.0028, m[1], m[2]], [m[0] - 0.0028, m[1], m[2]], 0.0112, 0.0112, 28, 1);
          parts.push(rigidPart(band.pts, band.nrms, band.idx, L, 7));
        }
        // 飘带
        finGeos.push(buildFin({
          id: 9, L, nU: 2, nV: 24,
          root: (u) => [s + 0.014, lat + nz * 0.0135 - ny * (u - 0.5) * 0.018, vert + ny * 0.0135 + nz * (u - 0.5) * 0.018],
          span: (u, v) => [0.09 * L * v, 0, 0.004 * v],
          flapNormal: () => [0, 1, 0],
        }));
      }
    } else {
      finGeos.push(...sturgeonFins(P, L));
      parts.push(...sturgeonScutes(P, L));
      for (const side of [1, -1]) {
        const s = 0.19;
        const [lat, vert] = sectionPoint(P, L, s, side * 1.2);
        const r = 0.0036 * L;
        const zc = lat * 0.99 - side * r * 0.15;
        const e = spherePts([-s * L, vert + 0.003 * L, zc], r, 16, 12, [1, 1, 0.75]);
        parts.push(rigidPart(e.pts, e.nrms, e.idx, L, 6));
        const p = spherePts([-s * L, vert + 0.003 * L, zc + side * r * 0.4], r * 0.55, 12, 10, [1, 1, 0.7]);
        parts.push(rigidPart(p.pts, p.nrms, p.idx, L, 10));
        if (side === 1) { this.eyeLocal = [s, lat * 0.99 + r * 0.6, vert + 0.003 * L]; eyeU = [s * L, vert + 0.003 * L, Math.abs(zc), r]; }
      }
    }
    const bodyGeo = mergeGeos(parts);
    const finGeo = mergeGeos(finGeos);
    this.u = {
      uSpP: { value: Array.from({ length: NS }, () => new THREE.Vector3()) },
      uSpN: { value: Array.from({ length: NS }, () => new THREE.Vector3(0, 0, 1)) },
      uSpB: { value: Array.from({ length: NS }, () => new THREE.Vector3(0, 1, 0)) },
      uPhase: { value: 0 }, uPect: { value: 0.05 }, uFlutter: { value: 0.02 }, uBreath: { value: 0 },
      uLen: { value: L }, uDbg: { value: 0 }, uHeart: { value: 0 }, uLife: { value: 1 }, uPoreGlow: { value: 1 }, uBodyGlow: { value: 1 },
      uTagAge: { value: 0.35 }, uEye: { value: new THREE.Vector4(...eyeU) },
    };
    const uniforms = { ...water, ...this.u };
    this.bodyMat = new THREE.ShaderMaterial({
      uniforms, vertexShader: SKIN_VERT, fragmentShader: SKIN_FRAG(species), side: THREE.FrontSide,
    });
    this.finMat = new THREE.ShaderMaterial({
      uniforms, vertexShader: SKIN_VERT, fragmentShader: FIN_FRAG(species), defines: { FINS: 1 },
      side: THREE.DoubleSide, transparent: true, depthWrite: false,
    });
    this.body = new THREE.Mesh(bodyGeo, this.bodyMat);
    this.fins = new THREE.Mesh(finGeo, this.finMat);
    this.body.frustumCulled = false;
    this.fins.frustumCulled = false;
    this.fins.renderOrder = 2;
    this.group = new THREE.Group();
    this.group.add(this.body, this.fins);
    this._tmp = Array.from({ length: NS }, () => new THREE.Vector3());
    this._base = Array.from({ length: NS }, () => new THREE.Vector3());
    this._lat = Array.from({ length: NS }, () => new THREE.Vector3());
  }

  /**
   * 更新姿态。path.pos(u)，u 是吻尖在路径上的弧长位置（米）。
   * phase：摆尾相位（弧度，随时间增长）；amp：尾部横摆幅度（米）；lambda：波长（体长）；
   * bank：侧倾（弧度）；bend：额外的侧弯（-1..1，整条身体弯成弧，用于转头）；pitchUp：抬头（弧度，只作用于前段）
   */
  update({ path, u, phase = 0, amp = 0.12, lambda = 0.95, bank = 0, bend = 0, headYaw = 0, headPitch = 0, pect = 0.05, flutter = 0.02,
    breath = 0, heart = 0, life = 1, poreGlow = 1, bodyGlow = 1, time = 0 }) {
    const L = this.L;
    const base = this._base, lat = this._lat, P = this._tmp;
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < NS; i++) path.pos(u - (i / (NS - 1)) * L, base[i]);
    const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3();
    for (let i = 0; i < NS; i++) {
      const a = base[Math.max(0, i - 1)], b = base[Math.min(NS - 1, i + 1)];
      T.subVectors(a, b).normalize();
      lat[i].crossVectors(T, up);
      if (lat[i].lengthSq() < 1e-6) lat[i].set(0, 0, 1);
      lat[i].normalize();
    }
    for (let i = 0; i < NS; i++) {
      const s = i / (NS - 1);
      const sm = Math.min(1, Math.max(0, (s - 0.22) / 0.78));
      const A = amp * (0.035 + 0.965 * Math.pow(sm * sm * (3 - 2 * sm), 1.45));
      const lever = Math.max(0, 0.45 - s) * L;
      const d = A * Math.sin(phase - (2 * Math.PI * s) / lambda) + bend * L * 0.18 * (s - 0.45) * (s - 0.45) * 2.0 + headYaw * lever;
      P[i].copy(base[i]).addScaledVector(lat[i], d);
      P[i].y += headPitch * lever;
    }
    const uP = this.u.uSpP.value, uN = this.u.uSpN.value, uB = this.u.uSpB.value;
    const cb = Math.cos(bank), sb = Math.sin(bank);
    for (let i = 0; i < NS; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(NS - 1, i + 1)];
      T.subVectors(a, b).normalize();
      N.crossVectors(T, up).normalize();
      B.crossVectors(N, T).normalize();
      // 侧倾：绕 T 转
      const n2 = N.clone().multiplyScalar(cb).addScaledVector(B, sb);
      const b2 = B.clone().multiplyScalar(cb).addScaledVector(N, -sb);
      uP[i].copy(P[i]); uN[i].copy(n2); uB[i].copy(b2);
    }
    const U = this.u;
    U.uPhase.value = phase; U.uPect.value = pect; U.uFlutter.value = flutter; U.uBreath.value = breath;
    U.uHeart.value = heart; U.uLife.value = life; U.uPoreGlow.value = poreGlow; U.uBodyGlow.value = bodyGlow;
    this.headPos = P[0].clone();
    this.headDir = new THREE.Vector3().subVectors(P[0], P[2]).normalize();
  }

  /** 身体上某点（s, 横向米, 竖向米）的世界坐标（给镜头瞄准、放粒子用） */
  pointAt(s, lat = 0, vert = 0, out = new THREE.Vector3()) {
    const f = Math.min(1, Math.max(0, s)) * (NS - 1);
    const i0 = Math.floor(f), i1 = Math.min(NS - 1, i0 + 1), k = f - i0;
    const uP = this.u.uSpP.value, uN = this.u.uSpN.value, uB = this.u.uSpB.value;
    out.copy(uP[i0]).lerp(uP[i1], k);
    const n = uN[i0].clone().lerp(uN[i1], k).normalize();
    const b = uB[i0].clone().lerp(uB[i1], k).normalize();
    return out.addScaledVector(n, lat).addScaledVector(b, vert);
  }
}

// ---- 鲟的鳍、骨板、须 ----
function sturgeonFins(P, L) {
  const fins = [];
  const smooth = (x) => x * x * (3 - 2 * x);
  const topAt = (s) => (P.c(s) + P.hu(s) * 0.95) * L;
  const botAt = (s) => (P.c(s) - P.hd(s) * 0.95) * L;
  fins.push(buildFin({ id: 1, L, nU: 14, nV: 8,
    root: (u) => { const s = 0.7 + u * 0.08; return [s, 0, topAt(s) - 0.003]; },
    span: (u, v) => [0.04 * L * v, 0, (0.055 * Math.pow(1 - u, 0.8) + 0.006) * L * v],
    flapNormal: () => [0, 0, 1] }));
  fins.push(buildFin({ id: 2, L, nU: 12, nV: 8,
    root: (u) => { const s = 0.74 + u * 0.06; return [s, 0, botAt(s) + 0.003]; },
    span: (u, v) => [0.03 * L * v, 0, -(0.045 * Math.pow(1 - u, 0.8) + 0.005) * L * v],
    flapNormal: () => [0, 0, 1] }));
  for (const side of [1, -1]) {
    fins.push(buildFin({ id: 3, side, L, nU: 10, nV: 8,
      root: (u) => { const s = 0.6 + u * 0.04; const [lat, vert] = sectionPoint(P, L, s, Math.PI - side * 0.7); return [s, lat * 0.97, vert * 0.97]; },
      span: (u, v) => { const h = (0.05 * Math.pow(1 - u, 0.7) + 0.006) * L; return [0.03 * L * v, side * h * v * 0.6, -h * v * 0.75]; },
      flapNormal: () => [0, 0.6, side * 0.8] }));
    fins.push(buildFin({ id: 4, side, L, nU: 12, nV: 10,
      root: (u) => { const s = 0.24 + u * 0.05; const [lat, vert] = sectionPoint(P, L, s, Math.PI - side * 0.85); return [s, lat * 0.97, vert * 0.97]; },
      span: (u, v) => { const h = (0.1 * Math.pow(1 - u, 0.5) * (0.5 + 0.5 * smooth(Math.min(1, u * 3 + 0.3))) + 0.008) * L; return [0.05 * L * v, side * h * v * 0.85, -h * v * 0.45]; },
      flapNormal: () => [0, 0.85, side * 0.5] }));
  }
  fins.push(buildFin({ id: 5, L, nU: 30, nV: 14,
    root: (u) => { const s = 0.83 + u * 0.17; return [s, 0, P.c(s) * L]; },
    span: (u, v) => {
      const up = (0.012 + 0.004 * Math.sin(u * Math.PI)) * L;
      const lobe = u < 0.5 ? 0.02 + 0.075 * smooth(u / 0.5) : 0.097 * Math.pow(1 - (u - 0.5) / 0.5, 1.2);
      const down = (lobe + 0.01) * L;
      return [0.02 * L * v * v + 0.015 * L * v, 0, up - (up + down) * v];
    },
    flapNormal: () => [0, 0, 1] }));
  return fins;
}

function sturgeonScutes(P, L) {
  const geos = [];
  const rnd = (k, j) => { const x = Math.sin(k * 12.9898 + j * 78.233) * 43758.5453; return x - Math.floor(x); };
  const rows = [
    { th: 0.0, n: 13, s0: 0.21, s1: 0.64, h: 0.0065, size: 0.032, j: 1 },
    { th: 1.25, n: 34, s0: 0.23, s1: 0.86, h: 0.0035, size: 0.02, j: 2 },
    { th: -1.25, n: 34, s0: 0.23, s1: 0.86, h: 0.0035, size: 0.02, j: 3 },
    { th: 2.3, n: 11, s0: 0.3, s1: 0.6, h: 0.003, size: 0.018, j: 4 },
    { th: -2.3, n: 11, s0: 0.3, s1: 0.6, h: 0.003, size: 0.018, j: 5 },
  ];
  const pts = [], nrms = [], idx = [];
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  for (const r of rows) {
    for (let k = 0; k < r.n; k++) {
      const r1 = rnd(k, r.j), r2 = rnd(k + 50, r.j), r3 = rnd(k + 90, r.j);
      if (r.j > 1 && r3 < 0.1) continue;            // 老鱼：有几块磨掉了
      const s = r.s0 + (r.s1 - r.s0) * ((k + (r2 - 0.5) * 0.3) / (r.n - 1));
      const [lat, vert] = sectionPoint(P, L, s, r.th + (r1 - 0.5) * 0.06);
      const cy = P.c(s) * L;
      let ny = vert - cy, nz = lat;
      const nl = Math.hypot(ny, nz) || 1; ny /= nl; nz /= nl;
      const x = -s * L;
      const bell = Math.sin((k / (r.n - 1)) * Math.PI);
      const size = r.size * L * (0.7 + 0.3 * bell) * (0.8 + 0.4 * r1);
      const h = r.h * L * (0.6 + 0.4 * bell) * (0.5 + 0.7 * r2);
      const tv = [0, -nz, ny];
      const at = (ax, off, up) => [ax, vert + tv[1] * off + ny * up, lat + tv[2] * off + nz * up];
      // 菱形底（略沉进皮肤）+ 前低后高的脊
      const B = [at(x + size * 0.5, 0, -0.002 * L), at(x, size * 0.34, -0.001 * L), at(x - size * 0.5, 0, -0.002 * L), at(x, -size * 0.34, -0.001 * L)];
      const A0 = at(x + size * 0.18, 0, h * 0.7), A1 = at(x - size * 0.16, 0, h);
      const tris = [[B[0], B[1], A0], [B[1], A1, A0], [B[1], B[2], A1], [B[2], B[3], A1], [B[3], A0, A1], [B[3], B[0], A0]];
      for (const [p0, p1, p2] of tris) {
        let n = cross(sub(p1, p0), sub(p2, p0));
        const l = Math.hypot(...n) || 1; n = n.map((v) => v / l);
        const out = n[1] * ny + n[2] * nz >= 0;
        const o = pts.length;
        pts.push(p0, p1, p2);
        const nn = out ? n : n.map((v) => -v);
        nrms.push(nn, nn, nn);
        idx.push(o, o + 1, o + 2);
      }
    }
  }
  geos.push(rigidPart(pts, nrms, idx, L, 8));
  // 四根须：吻下一横排，先向下再微微后勾
  for (const zz of [-0.017, -0.0058, 0.0058, 0.017]) {
    const s = 0.058 + Math.abs(zz) * 0.3;
    const x = -s * L, y0 = (P.c(s) - P.hd(s) * 0.85) * L;
    const len = (0.028 + 0.004 * Math.abs(zz) / 0.017) * L;
    const curve = (k) => [x + len * (0.25 * k - 0.45 * k * k), y0 - len * (k - 0.15 * k * k), zz * L * (1 + 0.35 * k)];
    const nseg = 5;
    for (let i = 0; i < nseg; i++) {
      const k0 = i / nseg, k1 = (i + 1) / nseg;
      const c = cylinderPts(curve(k0), curve(k1), 0.0022 * L * (1 - 0.6 * k0), 0.0022 * L * (1 - 0.6 * k1), 6, 1);
      geos.push(rigidPart(c.pts, c.nrms, c.idx, L, 9));
    }
  }
  return geos;
}
