// S3 专用水墨渲染核心（只给本场景用，不改共享模块）。
//
// 思路：所有笔触、墨块都画进一张 HalfFloat「墨量」缓冲，加法混合（叠墨自然更深），四个通道各自累加：
//   R 湿墨（会洇、有湿边）  G 干墨/线（几乎不洇）  B 朱砂 或 留白（按镜头切换）  A 赭石
// 然后降采样模糊出两三级，合成时：
//   湿边 = 清晰墨量 − 大半径模糊（墨块内侧靠边处颜料堆积）
//   洇   = 小半径模糊 × 纸纤维吸墨度（墨沿纤维渗出去，毛边）
//   颗粒 = 纸的齿纹调制中间调
// 最后按 1−exp(−墨量) 从纸色走向墨色（感知上均匀），再换成线性色写进 HDR 目标。
// 一切都是 t 的纯函数：CPU 端每帧按时间重建几何，GPU 端无状态。
import { makePaperCanvas, PALETTE } from '../../film/paper.js';

export const W = 1920, H = 1080;
export const CH = { wet: [1, 0, 0, 0], dry: [0, 1, 0, 0], b: [0, 0, 1, 0], red: [0, 0, 1, 0], res: [0, 0, 1, 0], ochre: [0, 0, 0, 1] };

export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  float a = hash12(i), b = hash12(i+vec2(1.0,0.0)), c = hash12(i+vec2(0.0,1.0)), d = hash12(i+vec2(1.0,1.0));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y); }
float fbm4(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ s += a*vnoise(p); p = p*2.03 + vec2(17.1, 9.3); a *= 0.5; } return s / 0.9375; }
float fbm6(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++){ s += a*vnoise(p); p = p*2.03 + vec2(17.1, 9.3); a *= 0.5; } return s / 0.984375; }
`;

const VS_SCREEN = /* glsl */ `
uniform vec2 uRes;
vec4 toClip(vec2 s){ return vec4(s.x / uRes.x * 2.0 - 1.0, 1.0 - s.y / uRes.y * 2.0, 0.0, 1.0); }
`;

// ---------------- 笔触（带状三角形条） ----------------
// 顶点：position(屏幕xy) | aPap(纸坐标xy, 弧长s, 横向v) | aP1(几何宽px, 墨, 干, 种子) | aP2(侧锋, 湿边, 笔毛间距, 缩放) | aCh
const STROKE_STRIDE = 18;
const STROKE_VS = VS_SCREEN + /* glsl */ `
attribute vec4 aPap; attribute vec4 aP1; attribute vec4 aP2; attribute vec4 aCh;
varying vec4 vPap; varying vec4 vP1; varying vec4 vP2; varying vec4 vCh;
void main(){ vPap = aPap; vP1 = aP1; vP2 = aP2; vCh = aCh; gl_Position = toClip(position.xy); }
`;
const STROKE_FS = NOISE_GLSL + /* glsl */ `
uniform sampler2D uFiber; uniform vec4 uPaperT; uniform vec2 uPaperSize;
varying vec4 vPap; varying vec4 vP1; varying vec4 vP2; varying vec4 vCh;
void main(){
  float v = vPap.w; float wpx = vP1.x; float zoom = vP2.w;
  const float M = 1.0;
  float seed = vP1.w;
  float s = vPap.z;
  float dry = vP1.z;
  vec2 puv = (vPap.xy * uPaperT.x + uPaperT.yz) / uPaperSize;
  float tooth = texture2D(uFiber, puv).r;
  float tooth2 = texture2D(uFiber, puv * 1.93 + 0.31).r;
  // 边缘：纸纤维 + 笔毛末端让边缘毛糙（干笔更毛）
  float dTop = (1.0 - v) * 0.5 * wpx - M;
  float dBot = (1.0 + v) * 0.5 * wpx - M;
  float inkW = max(wpx - 2.0 * M, 0.0);
  float jag = (vnoise(vec2(s * zoom / 2.3 + seed * 11.0, v > 0.0 ? 3.0 : 9.0)) - 0.5) * 1.4
            + (vnoise(vec2(s * zoom / 9.0 - seed * 3.0, v > 0.0 ? 5.0 : 1.0)) - 0.5) * 1.6
            + (tooth - 0.5) * 2.2;
  float rough = min(inkW * 0.22, 0.9 + 2.2 * dry);
  float cov = clamp(min(dTop, dBot) + 0.5 + jag * rough, 0.0, 1.0);
  float thin = clamp(inkW, 0.0, 1.0);
  float acrossW = (v * 0.5 + 0.5) * inkW / max(zoom, 1e-3);
  float bsp = max(vP2.z, 0.4);
  // 笔毛不是笔直的平行线：沿笔慢慢游移、时聚时散
  float b = acrossW / bsp + seed * 7.13 + (vnoise(vec2(s / (bsp * 80.0 + 40.0), seed)) - 0.5) * 3.0;
  float st1 = vnoise(vec2(b, s / (bsp * 30.0) + seed * 3.1));
  float st2 = vnoise(vec2(b * 2.37 + 5.1, s / (bsp * 8.0) - seed));
  float st3 = vnoise(vec2(b * 0.41 - 2.0, s / (bsp * 60.0) + seed * 0.7));
  float br = 0.5 * st1 + 0.3 * st2 + 0.2 * st3;
  float edgeFac = 1.0 - abs(v);
  float side = vP2.x;
  float sp = clamp(0.5 + 0.5 * v * sign(side + 1e-6), 0.0, 1.0);
  float light = (1.0 - sp) * abs(side);          // 侧锋的淡边：笔肚子里水多墨少，丝更明显、更容易断
  // 飞白：墨少时只有笔毛浓处、纸面凸处沾得上墨，笔的两侧先干
  float dryE = dry + light * 0.3;
  float k = br * 0.78 + tooth2 * 0.22 + edgeFac * 0.12;
  float dep = smoothstep(dryE - 0.07, dryE + 0.1, k);
  // 墨色：笔毛带来的丝状浓淡 + 沿笔的蘸墨起伏
  float load = 1.0 + 0.3 * (vnoise(vec2(s / (bsp * 45.0 + 20.0), seed * 5.0)) - 0.5);
  float tone = (1.0 + (br - 0.5) * (0.32 + dry * 0.8 + light * 0.75) * (0.5 + 0.9 * vnoise(vec2(s / (bsp * 50.0 + 30.0), seed * 2.0 + 4.0)))) * load;
  float prof = mix(1.0, pow(sp, 1.8) * 1.9, abs(side));
  float rim = 1.0 + vP2.y * smoothstep(0.5, 0.98, abs(v)) * (1.0 - dry);
  float d = vP1.y * cov * thin * dep * tone * prof * rim;
  gl_FragColor = vCh * max(d, 0.0);
}
`;

// ---------------- 墨块（三角化的多边形） ----------------
// 顶点：position(屏幕xy) | aPap(纸坐标xy) | aF(墨, 种子, 纹理量, 颗粒) | aCh | aE(边：1 里面，0 羽化边的最外圈)
const FILL_STRIDE = 13;
const FILL_VS = VS_SCREEN + /* glsl */ `
attribute vec2 aPap; attribute vec4 aF; attribute vec4 aCh; attribute float aE;
varying vec2 vPap; varying vec4 vF; varying vec4 vCh; varying float vE;
void main(){ vPap = aPap; vF = aF; vCh = aCh; vE = aE; gl_Position = toClip(position.xy); }
`;
const FILL_FS = NOISE_GLSL + /* glsl */ `
uniform sampler2D uFiber; uniform vec4 uPaperT; uniform vec2 uPaperSize;
varying vec2 vPap; varying vec4 vF; varying vec4 vCh; varying float vE;
void main(){
  vec2 p = vPap; float seed = vF.y;
  float n1 = vnoise(p / 210.0 + seed * 3.7);
  float n2 = vnoise(p / 53.0 + seed * 1.3 + 7.0);
  float n3 = vnoise(p / 13.0 - seed);
  vec2 puv = (p * uPaperT.x + uPaperT.yz) / uPaperSize;
  float tooth = texture2D(uFiber, puv).r;
  float var = (n1 - 0.5) * 0.9 + (n2 - 0.5) * 0.55 + (n3 - 0.5) * 0.3 + (tooth - 0.5) * 0.4 * (1.0 + vF.w);
  float d = vF.x * max(0.0, 1.0 + vF.z * var);
  if (vE < 0.999) {
    // 羽化边：淡墨往外渗，边界跟着纸纹和噪声走，不是一圈均匀的渐变
    float en = (n2 - 0.5) * 0.9 + (n3 - 0.5) * 0.6 + (tooth - 0.5) * 0.6;
    float ef = clamp(vE * 1.12 + en * 0.7 * (1.0 - vE) - 0.06, 0.0, 1.0);
    d *= ef * ef * (3.0 - 2.0 * ef);
  }
  gl_FragColor = vCh * d;
}
`;

// ---------------- 贴图（字、预渲染的画） ----------------
const IMG_VS = VS_SCREEN + /* glsl */ `
attribute vec2 aUv; varying vec2 vUv;
void main(){ vUv = aUv; gl_Position = toClip(position.xy); }
`;
const IMG_FS = NOISE_GLSL + /* glsl */ `
uniform sampler2D map; uniform mat4 uMap; uniform float uMul; uniform vec2 uReveal; varying vec2 vUv;
void main(){
  vec4 c = texture2D(map, vUv);
  // 渗出来：按噪声先后显现（墨一点点吃进纸里）
  float n = fbm4(vUv * vec2(9.0, 16.0) + uReveal.y) * 0.8 + 0.1;
  float m = uReveal.x >= 1.0 ? 1.0 : smoothstep(n - 0.18, n + 0.02, uReveal.x * 1.2 - 0.1) * smoothstep(0.0, 0.25, uReveal.x);
  gl_FragColor = (uMap * c) * uMul * m;
}
`;

const FS_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// 降采样（4 抽样盒子）
const DOWN_FS = /* glsl */ `
uniform sampler2D src; uniform vec2 texel; varying vec2 vUv;
void main(){ vec4 a = texture2D(src, vUv + texel * vec2(-0.5, -0.5)); vec4 b = texture2D(src, vUv + texel * vec2(0.5, -0.5));
  vec4 c = texture2D(src, vUv + texel * vec2(-0.5, 0.5)); vec4 d = texture2D(src, vUv + texel * vec2(0.5, 0.5));
  gl_FragColor = (a + b + c + d) * 0.25; }
`;
// 9 抽样高斯（线性采样合并成 5 次）
const BLUR_FS = /* glsl */ `
uniform sampler2D src; uniform vec2 dir; varying vec2 vUv;
void main(){
  vec4 s = texture2D(src, vUv) * 0.2270270270;
  s += texture2D(src, vUv + dir * 1.3846153846) * 0.3162162162;
  s += texture2D(src, vUv - dir * 1.3846153846) * 0.3162162162;
  s += texture2D(src, vUv + dir * 3.2307692308) * 0.0702702703;
  s += texture2D(src, vUv - dir * 3.2307692308) * 0.0702702703;
  gl_FragColor = s;
}
`;

// 两个镜头之间的过渡：在墨量空间里混合（墨褪去 / 墨渗进来），比直接叠化图像更像纸上的墨
export const TRANS_GLSL = /* glsl */ `
uniform vec4 uTr;   // x 进度 0..1, y 类型, z 种子, w 软边
uniform vec4 uTr2;  // 类型相关参数：方向/中心
float trArrive(vec2 sp){
  // 到达时间场：0..1，越小越早被新画面「渗到」
  vec2 q = sp / 1080.0;
  float n = fbm4(q * 3.1 + uTr.z) * 0.62 + fbm4(q * 11.0 - uTr.z * 1.7) * 0.22;
  float base = 0.5;
  if (uTr.y > 1.5 && uTr.y < 2.5) { // 方向性（从某侧洇过来）
    vec2 d = normalize(uTr2.xy + 1e-5);
    base = clamp(dot(q - vec2(0.889, 0.5), d) * 0.55 + 0.5, 0.0, 1.0);
  } else if (uTr.y > 2.5) { // 从中心点向外
    base = clamp(length((sp - uTr2.xy) / 1080.0) * uTr2.z, 0.0, 1.0);
  }
  return clamp(base * 0.62 + n * 0.5 - 0.06, 0.0, 1.0);
}
`;
const MIX_FS = NOISE_GLSL + TRANS_GLSL + /* glsl */ `
uniform sampler2D tA; uniform sampler2D tB; uniform vec2 uRes; uniform vec4 uTrW; // x 旧画面淡出窗, y 新画面淡入窗（经留白时二者错开）
varying vec2 vUv;
void main(){
  vec2 sp = vec2(vUv.x, 1.0 - vUv.y) * uRes;
  float T = trArrive(sp);
  float w = uTr.w;
  // 旧画面：按到达时间先后褪去；新画面：按到达时间先后渗入
  float pa = clamp((uTr.x - uTrW.x) / max(uTrW.y - uTrW.x, 1e-3), 0.0, 1.0);
  float pb = clamp((uTr.x - uTrW.z) / max(uTrW.w - uTrW.z, 1e-3), 0.0, 1.0);
  float ma = smoothstep(T - w, T + w, pa * (1.0 + 2.0 * w) - w);
  float mb = smoothstep(T - w, T + w, pb * (1.0 + 2.0 * w) - w);
  vec4 A = texture2D(tA, vUv), B = texture2D(tB, vUv);
  gl_FragColor = A * (1.0 - ma) + B * mb;
}
`;

// ---------------- 合成 ----------------
const COMP_FS = NOISE_GLSL + TRANS_GLSL + /* glsl */ `
uniform sampler2D tD; uniform sampler2D tS; uniform sampler2D tL; uniform sampler2D tXL;
uniform sampler2D tPaper; uniform sampler2D tFiber;
uniform vec2 uRes; uniform vec2 uPaperSize;
uniform vec4 uCamA; uniform vec4 uPapA;   // 镜头 A：cx, cy, zoom, rot；纸：scale, ox, oy, -
uniform vec4 uCamB; uniform vec4 uPapB;
uniform float uHasB;
uniform vec4 uTrW;
uniform vec4 uLook;    // x 洇, y 湿边, z 颗粒, w 虚焦
uniform vec4 uLook2;   // x B 通道模式(0 朱砂 1 留白), y 留白强度, z 光晕, w 过曝（纸走向白）
uniform vec4 uNight;   // x 夜的墨量 0..1, y 夜的浓度, z 夜的笔触方向性, w 夜漫进来的进度
uniform vec4 uFinal;   // x 终场洇开进度, y 种子, zw 洇开的中心（屏幕像素）
uniform vec3 uInk; uniform vec3 uCin; uniform vec3 uOch; uniform vec3 uDeep; uniform vec3 uGlowCol;
uniform float uTime; uniform vec2 uWob;
varying vec2 vUv;

vec2 toWorld(vec2 sp, vec4 cam){
  vec2 d = sp - 0.5 * uRes; float c = cos(-cam.w), s = sin(-cam.w);
  d = vec2(c * d.x - s * d.y, s * d.x + c * d.y) / cam.z;
  return cam.xy + d;
}
vec3 paperAt(vec2 w, vec4 pap, out float fib, out float tooth){
  vec2 uv = (w * pap.x + pap.yz) / uPaperSize;
  fib = texture2D(tFiber, uv).r;
  tooth = texture2D(tFiber, uv * 1.63 + 0.37).r;
  vec3 c = texture2D(tPaper, uv).rgb;
  // 镜头推得很近时纸纹会被放大发虚：混入一层细一倍的纸（同一张纸的另一处），纸的颗粒感保持不变
  float lod = smoothstep(1.35, 2.3, pap.w);
  if (lod > 0.0) {
    vec2 uv2 = uv * 2.0 + vec2(0.31, 0.57);
    vec3 c2 = texture2D(tPaper, uv2).rgb;
    float m1 = dot(c, vec3(0.333)), m2 = dot(c2, vec3(0.333));
    c = mix(c, c2 - vec3(m2) + vec3(m1), lod);
    fib = mix(fib, texture2D(tFiber, uv2).r, lod);
    tooth = mix(tooth, texture2D(tFiber, uv2 * 1.63 + 0.37).r, lod);
  }
  return c;
}
vec3 toLin(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }

void main(){
  vec2 sp = vec2(vUv.x, 1.0 - vUv.y) * uRes;
  float fibA, toothA; vec3 papA = paperAt(toWorld(sp, uCamA), uPapA, fibA, toothA);
  vec3 paper = papA; float fib = fibA, tooth = toothA;
  if (uHasB > 0.5) {
    float fibB, toothB; vec3 papB = paperAt(toWorld(sp, uCamB), uPapB, fibB, toothB);
    float T = trArrive(sp);
    float pb = clamp((uTr.x - uTrW.z) / max(uTrW.w - uTrW.z, 1e-3), 0.0, 1.0);
    float pa = clamp((uTr.x - uTrW.x) / max(uTrW.y - uTrW.x, 1e-3), 0.0, 1.0);
    float m = smoothstep(0.0, 1.0, 0.5 * (pa + pb));
    paper = mix(papA, papB, m); fib = mix(fibA, fibB, m); tooth = mix(toothA, toothB, m);
  }
  // 纸纹带来的轻微抖动（让所有边缘都带手感，跟纸走，不会随镜头闪）
  vec2 wA = toWorld(sp, uCamA);
  vec2 puv = (wA * uPapA.x + uPapA.yz) / uPaperSize;
  vec2 wob = vec2(texture2D(tFiber, puv * 1.37 + vec2(0.37, 0.11)).r - 0.5, texture2D(tFiber, puv * 1.29 + vec2(0.13, 0.71)).r - 0.5);
  wob += 0.6 * vec2(vnoise(wA / 23.0) - 0.5, vnoise(wA / 23.0 + 7.3) - 0.5);
  vec2 o1 = wob * uWob.x / uRes, o2 = wob * uWob.y / uRes;
  vec4 D = texture2D(tD, vUv + o1), S = texture2D(tS, vUv + o2), L = texture2D(tL, vUv + o2 * 1.5), XL = texture2D(tXL, vUv + o2 * 2.0);
  // 虚焦：清晰墨量换成模糊墨量（像湿纸上的墨整体化开）
  float df = uLook.w;
  D = mix(D, mix(S, L, clamp(df * 1.4 - 0.4, 0.0, 1.0)), clamp(df * 1.6, 0.0, 1.0));
  S = mix(S, L, df); L = mix(L, XL, df);
  float fw = smoothstep(0.28, 0.82, fib);
  float fw2 = smoothstep(0.2, 0.9, 0.55 * fib + 0.45 * texture2D(tFiber, puv * 3.3 + 0.5).r);
  // 湿墨：①核 ②沿纤维渗出的毛边 ③水渍晕（只在笔湿的地方，外缘一圈若有若无的水线）④湿边
  // 淡墨水多，边缘更化（深墨保持利落）
  float soft = (1.0 - smoothstep(0.06, 0.45, S.r)) * 0.8;
  float core = mix(D.r, S.r * (0.85 + 0.3 * fw2), soft * smoothstep(0.0, 0.02, S.r));
  float thS = mix(0.26, 0.04, fw2);
  float fuzz = smoothstep(thS, thS + 0.08, S.r) * S.r * 0.8;
  float nH = fbm4(wA / 55.0 + 5.3);
  float wetAmt = smoothstep(0.38, 0.78, nH);
  float thL = mix(0.16, 0.035, fw) * mix(1.7, 0.75, wetAmt);
  float hm = smoothstep(thL * 0.6, thL * 1.35, L.r);
  float front = (hm - smoothstep(thL * 1.35, thL * 2.4, L.r)) * wetAmt;
  float halo = hm * (0.012 + 0.06 * L.r) * (0.35 + wetAmt) + front * 0.035;
  float rim = max(0.0, core - L.r * 1.05);
  float wetD = max(core, fuzz * uLook.x) + uLook.x * halo * (1.0 - smoothstep(0.02, 0.2, core)) + uLook.y * rim;
  // 颜料的絮凝：湿墨里大块的不匀
  float disp = fbm4(wA / 70.0 + 3.1) - 0.5;
  wetD *= 1.0 + 0.45 * uLook.z * disp * smoothstep(0.02, 0.3, wetD);
  float dens = wetD;
  // 干墨：只有一点点纤维毛边
  float thD = mix(0.3, 0.1, fw);
  float dry = max(D.g, smoothstep(thD, thD + 0.1, S.g) * S.g * 0.7 * uLook.x);
  dens += dry;
  // 颗粒：纸齿让中间调不匀
  float mid = smoothstep(0.015, 0.35, dens) * (1.0 - smoothstep(1.4, 3.2, dens));
  dens *= 1.0 + uLook.z * (tooth - 0.5) * 0.55 * mid;
  // 夜：大片泼墨，带横向笔势
  if (uNight.x > 0.0) {
    vec2 q = sp / 1080.0;
    float streak = fbm4(vec2(q.x * 1.3, q.y * 7.0) + 3.7) * 0.6 + fbm4(q * 4.0 - 1.3) * 0.4;
    float arrive = clamp(fbm4(q * 2.2 + 9.1) * 0.9 + (1.0 - q.x / 1.78) * 0.25 - 0.1, 0.0, 1.0);
    float cover = smoothstep(arrive - 0.12, arrive + 0.12, uNight.w * 1.25 - 0.1);
    dens += uNight.x * cover * uNight.y * (0.78 + 0.5 * (streak - 0.5) * (1.0 + uNight.z) + 0.1 * (fib - 0.5));
  }
  // 留白：把墨「让」出来（夜里的灯、倒影、声呐圈、她的轮廓）
  float resv = uLook2.x * (D.b + 0.35 * S.b);
  dens = max(0.0, dens - resv * uLook2.y);
  vec3 pap = mix(paper, vec3(1.0, 0.995, 0.975), uLook2.w);
  float a = 1.0 - exp(-dens);
  vec3 col = mix(pap, uInk, a);
  // 朱砂（只在缝针）
  float cin = (1.0 - uLook2.x) * (D.b + 0.35 * uLook.x * max(0.0, S.b * (0.4 + 0.9 * fib) - D.b));
  float ac = 1.0 - exp(-cin * 1.5);
  col = mix(col, col * (uCin / max(pap, vec3(0.3))), ac);
  // 赭石（只在棉被）
  float och = D.a + 0.5 * uLook.x * max(0.0, S.a * (0.45 + 0.9 * fib) - D.a) + 0.25 * max(0.0, D.a - L.a);
  float ao = 1.0 - exp(-och * 1.4);
  col = mix(col, col * (uOch / max(pap, vec3(0.3))), ao);
  // 终场：墨慢慢洇开铺满，变成极深的褐黑
  if (uFinal.x > 0.0) {
    vec2 q = sp / 1080.0;
    float T = length((sp - uFinal.zw) / 1080.0) * 0.55 + fbm6(q * 2.6 + uFinal.y) * 0.55 + (fib - 0.5) * 0.12 - 0.12;
    float p = uFinal.x * 0.95 - 0.06;
    float m = smoothstep(T - 0.07, T + 0.05, p);
    float edge = smoothstep(T - 0.1, T - 0.02, p) * (1.0 - smoothstep(T - 0.02, T + 0.06, p));
    vec3 deep = uDeep * (0.9 + 0.2 * fbm4(q * 5.0 + 2.0) + 0.06 * (fib - 0.5));
    col = mix(col, deep * 0.8, clamp(m + edge * 0.35, 0.0, 1.0));
    col = mix(col, uDeep, smoothstep(0.9, 1.0, uFinal.x));
  }
  vec3 lin = toLin(clamp(col, 0.0, 1.0));
  // 留白处的光晕（夜里灯的光在墨里化开）
  lin += uGlowCol * uLook2.z * (L.b * 0.35 + XL.b * 0.9) * uLook2.x;
  gl_FragColor = vec4(lin, 1.0);
}
`;

function additive(THREE) {
  return {
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendEquationAlpha: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  };
}

const hashF = (x) => { const v = Math.sin(x * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };

class Batch {
  constructor(THREE, stride, maxV, maxI, layout, material) {
    this.stride = stride; this.maxV = maxV; this.maxI = maxI;
    this.v = new Float32Array(maxV * stride);
    this.i = new Uint32Array(maxI);
    this.nv = 0; this.ni = 0;
    const ib = new THREE.InterleavedBuffer(this.v, stride);
    ib.setUsage(THREE.DynamicDrawUsage);
    this.ib = ib;
    const g = new THREE.BufferGeometry();
    for (const [name, size, off] of layout) g.setAttribute(name, new THREE.InterleavedBufferAttribute(ib, size, off));
    this.idx = new THREE.BufferAttribute(this.i, 1);
    this.idx.setUsage(THREE.DynamicDrawUsage);
    g.setIndex(this.idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-1e9, -1e9, -1e9), new THREE.Vector3(1e9, 1e9, 1e9));
    this.geo = g;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.overflow = false;
  }
  reset() { this.nv = 0; this.ni = 0; }
  room(nv, ni) {
    if (this.nv + nv > this.maxV || this.ni + ni > this.maxI) { this.overflow = true; return false; }
    return true;
  }
  upload() {
    this.ib.clearUpdateRanges();
    this.ib.addUpdateRange(0, Math.max(1, this.nv * this.stride));
    this.ib.needsUpdate = true;
    this.idx.clearUpdateRanges();
    this.idx.addUpdateRange(0, Math.max(1, this.ni));
    this.idx.needsUpdate = true;
    this.geo.setDrawRange(0, this.ni);
    this.mesh.visible = this.ni > 0;
  }
}

/** 镜头：世界坐标（像素，y 向下）→ 屏幕像素。shake 折进中心点，合成着色器用同一组数反算世界坐标 */
export function makeView(cx, cy, z = 1, rot = 0, shx = 0, shy = 0) {
  const c = Math.cos(rot), s = Math.sin(rot);
  // 屏幕 = R(rot)·(世界 − c')·z + 中心 + 抖动  →  等价于 c' = c − R(−rot)·抖动/z
  const cx2 = cx - (c * shx + s * shy) / z;
  const cy2 = cy - (-s * shx + c * shy) / z;
  return { cx: cx2, cy: cy2, z, rot, c, s };
}

export class InkGL {
  constructor(ctx, { paperW = 2400, paperH = 1350, paperSeed = 3 } = {}) {
    const THREE = ctx.THREE;
    this.THREE = THREE; this.ctx = ctx; this.r = ctx.renderer;
    const t0 = performance.now();
    const { canvas, fiber } = makePaperCanvas(paperW, paperH, { seed: paperSeed });
    this.paperMs = performance.now() - t0;
    this.paperW = paperW; this.paperH = paperH;
    const mkTex = (cv) => {
      const tx = new THREE.CanvasTexture(cv);
      tx.colorSpace = THREE.NoColorSpace;
      tx.wrapS = tx.wrapT = THREE.MirroredRepeatWrapping;
      tx.minFilter = THREE.LinearFilter; tx.magFilter = THREE.LinearFilter; tx.generateMipmaps = false;
      tx.needsUpdate = true;
      return tx;
    };
    this.paperTex = mkTex(canvas);
    this.fiberTex = mkTex(fiber);
    this.paperCanvas = canvas; this.fiberCanvas = fiber;

    const rt = (w, h, samples = 0) => new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, samples, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    });
    this.rtA = rt(W, H, 4); this.rtB = rt(W, H, 4); this.rtM = rt(W, H);
    this.h1 = [rt(W / 2, H / 2), rt(W / 2, H / 2)];
    this.q1 = [rt(W / 4, H / 4), rt(W / 4, H / 4)];
    this.e1 = [rt(W / 8, H / 8), rt(W / 8, H / 8)];
    this.mkRT = rt;

    const paperU = () => ({ uFiber: { value: this.fiberTex }, uPaperT: { value: new THREE.Vector4(1, 0, 0, 0) }, uPaperSize: { value: new THREE.Vector2(paperW, paperH) }, uRes: { value: new THREE.Vector2(W, H) } });
    this.strokeMat = new THREE.ShaderMaterial({ vertexShader: STROKE_VS, fragmentShader: STROKE_FS, uniforms: paperU(), ...additive(THREE) });
    this.fillMat = new THREE.ShaderMaterial({ vertexShader: FILL_VS, fragmentShader: FILL_FS, uniforms: paperU(), ...additive(THREE) });
    this.strokes = new Batch(THREE, STROKE_STRIDE, 420000, 1300000,
      [['position', 2, 0], ['aPap', 4, 2], ['aP1', 4, 6], ['aP2', 4, 10], ['aCh', 4, 14]], this.strokeMat);
    this.fills = new Batch(THREE, FILL_STRIDE, 260000, 800000,
      [['position', 2, 0], ['aPap', 2, 2], ['aF', 4, 4], ['aCh', 4, 8], ['aE', 1, 12]], this.fillMat);
    this.scene = new THREE.Scene();
    this.scene.add(this.fills.mesh); this.scene.add(this.strokes.mesh);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // 贴图池
    this.imgPool = [];
    this.imgUsed = 0;

    const fs = (frag, uniforms) => new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    this.downMat = fs(DOWN_FS, { src: { value: null }, texel: { value: new THREE.Vector2() } });
    this.blurMat = fs(BLUR_FS, { src: { value: null }, dir: { value: new THREE.Vector2() } });
    this.mixMat = fs(MIX_FS, {
      tA: { value: null }, tB: { value: null }, uRes: { value: new THREE.Vector2(W, H) },
      uTr: { value: new THREE.Vector4() }, uTr2: { value: new THREE.Vector4() }, uTrW: { value: new THREE.Vector4(0, 1, 0, 1) },
    });
    const c3 = (c) => new THREE.Vector3(c[0] / 255, c[1] / 255, c[2] / 255);
    this.compMat = fs(COMP_FS, {
      tD: { value: null }, tS: { value: null }, tL: { value: null }, tXL: { value: null },
      tPaper: { value: this.paperTex }, tFiber: { value: this.fiberTex },
      uRes: { value: new THREE.Vector2(W, H) }, uPaperSize: { value: new THREE.Vector2(paperW, paperH) },
      uCamA: { value: new THREE.Vector4(960, 540, 1, 0) }, uPapA: { value: new THREE.Vector4(1, 0, 0, 0) },
      uCamB: { value: new THREE.Vector4(960, 540, 1, 0) }, uPapB: { value: new THREE.Vector4(1, 0, 0, 0) },
      uHasB: { value: 0 }, uTr: { value: new THREE.Vector4() }, uTr2: { value: new THREE.Vector4() }, uTrW: { value: new THREE.Vector4(0, 1, 0, 1) },
      uLook: { value: new THREE.Vector4(0.7, 0.8, 0.6, 0) },
      uLook2: { value: new THREE.Vector4(0, 6, 0, 0) },
      uNight: { value: new THREE.Vector4(0, 3, 0, 0) },
      uFinal: { value: new THREE.Vector4(0, 0, 960, 540) },
      uInk: { value: c3(PALETTE.ink) }, uCin: { value: c3(PALETTE.cinnabar) }, uOch: { value: c3(PALETTE.ochre) },
      uDeep: { value: c3([22, 17, 11]) }, uGlowCol: { value: new THREE.Vector3(0.95, 0.93, 0.88) },
      uTime: { value: 0 }, uWob: { value: new THREE.Vector2(1.6, 3.0) },
    });
    this.view = makeView(960, 540, 1);
    this.paperT = [1, 0, 0];
  }

  // ---------------- 每帧：开始一张墨量缓冲 ----------------
  begin(rt, view, paperT = [1, 0, 0]) {
    this.rt = rt;
    this.view = view;
    this.paperT = paperT;
    this.strokes.reset(); this.fills.reset();
    this.imgUsed = 0;
    for (const m of this.imgPool) m.visible = false;
  }
  setView(view) { this.view = view; }

  /** 世界 → 屏幕 */
  sx(x, y) { const v = this.view; return v.c * (x - v.cx) * v.z - v.s * (y - v.cy) * v.z + W / 2; }
  sy(x, y) { const v = this.view; return v.s * (x - v.cx) * v.z + v.c * (y - v.cy) * v.z + H / 2; }

  /**
   * 一笔：pts 是世界坐标的密集折线 [x0,y0,x1,y1,...]（先用 brush.js 的 spline 采样）。
   * o.wt(u)/o.wb(u)：上/下半宽（世界像素，u=0..1 沿笔），或 o.w(u) 全宽；o.ink(u)、o.dry(u) 可为数或函数；
   * o.ch 通道；o.seed；o.side 侧锋（+ 上深 / − 下深）；o.rim 湿边；o.bsp 笔毛间距（世界像素）；o.grow 画到哪（0..1）；o.tip 生长前沿笔尖长度
   */
  stroke(pts, o = {}) {
    const n = pts.length >> 1;
    if (n < 2) return;
    const v = this.view, z = v.z;
    // 弧长
    const S = this._S && this._S.length >= n ? this._S : (this._S = new Float32Array(Math.max(n, 4096)));
    S[0] = 0;
    for (let i = 1; i < n; i++) S[i] = S[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
    const total = S[n - 1];
    if (total < 1e-4) return;
    const grow = o.grow === undefined ? 1 : Math.max(0, Math.min(1, o.grow));
    if (grow <= 0) return;
    const sEnd = total * grow;
    const ch = o.ch || CH.wet;
    const seed = o.seed === undefined ? 0.37 : o.seed;
    const side = o.side || 0, rim = o.rim === undefined ? 0.35 : o.rim, bsp = o.bsp || 3.2;
    const fw = o.w, fwt = o.wt, fwb = o.wb, fink = o.ink === undefined ? 1 : o.ink, fdry = o.dry || 0;
    const tipLen = o.tip === undefined ? 0 : o.tip;
    const val = (f, u) => (typeof f === 'function' ? f(u) : f);
    // 需要的点数
    let m = 0;
    while (m < n && S[m] <= sEnd) m++;
    const cnt = Math.min(n, m + 1);
    const capA = o.cap === undefined ? 5 : o.cap, capB = o.capEnd === undefined ? capA : o.capEnd; // 圆头的采样数（起笔/收笔）
    if (!this.strokes.room(cnt * 2 + (capA + capB) * 2, (cnt - 1 + capA + capB) * 6)) return;
    const B = this.strokes, arr = B.v, st = B.stride;
    const base = B.nv;
    let k = 0;
    const MARGIN = 1.0;
    const emit = (x, y, nx, ny, s, wt, wb, ink, dry) => {
      const wpx = (wt + wb) * z + 2 * MARGIN;
      const mt = wt + MARGIN / z, mb = wb + MARGIN / z;
      const xt = x + nx * mt, yt = y + ny * mt, xb = x - nx * mb, yb = y - ny * mb;
      const o0 = (base + k * 2) * st, o1 = o0 + st;
      arr[o0] = this.sx(xt, yt); arr[o0 + 1] = this.sy(xt, yt);
      arr[o0 + 2] = xt; arr[o0 + 3] = yt; arr[o0 + 4] = s; arr[o0 + 5] = 1;
      arr[o0 + 6] = wpx; arr[o0 + 7] = ink; arr[o0 + 8] = dry; arr[o0 + 9] = seed;
      arr[o0 + 10] = side; arr[o0 + 11] = rim; arr[o0 + 12] = bsp; arr[o0 + 13] = z;
      arr[o0 + 14] = ch[0]; arr[o0 + 15] = ch[1]; arr[o0 + 16] = ch[2]; arr[o0 + 17] = ch[3];
      arr[o1] = this.sx(xb, yb); arr[o1 + 1] = this.sy(xb, yb);
      arr[o1 + 2] = xb; arr[o1 + 3] = yb; arr[o1 + 4] = s; arr[o1 + 5] = -1;
      for (let q = 6; q < 18; q++) arr[o1 + q] = arr[o0 + q];
      k++;
    };
    const widths = (u) => {
      if (fwt !== undefined) return [val(fwt, u), val(fwb === undefined ? fwt : fwb, u)];
      const ww = val(fw === undefined ? 4 : fw, u) * 0.5; return [ww, ww];
    };
    let lastX = 0, lastY = 0, lastNx = 0, lastNy = 0, lastWt = 0, lastWb = 0, lastInk = 0, lastDry = 0, lastS = 0, lastTx = 1, lastTy = 0;
    for (let i = 0; i < cnt; i++) {
      let x, y, s;
      if (i < m) { x = pts[2 * i]; y = pts[2 * i + 1]; s = S[i]; }
      else { // 截在 sEnd
        const j = m; const a = (sEnd - S[j - 1]) / Math.max(1e-6, S[j] - S[j - 1]);
        x = pts[2 * j - 2] + (pts[2 * j] - pts[2 * j - 2]) * a; y = pts[2 * j - 1] + (pts[2 * j + 1] - pts[2 * j - 1]) * a; s = sEnd;
      }
      const ii = Math.min(i, n - 1);
      const i0 = Math.max(0, ii - 1), i1 = Math.min(n - 1, ii + 1);
      let tx = pts[2 * i1] - pts[2 * i0], ty = pts[2 * i1 + 1] - pts[2 * i0 + 1];
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const nx = ty, ny = -tx; // 「上」= 行进方向左侧
      const u = s / total;
      let [wt, wb] = widths(u);
      if (tipLen > 0 && grow < 1) {
        const dd = sEnd - s;
        if (dd < tipLen) { const f = Math.sqrt(Math.max(0, dd / tipLen)) * 0.75 + 0.25; wt *= f; wb *= f; }
      }
      const ink = val(fink, u), dry = val(fdry, u);
      if (i === 0 && capA > 0) {
        // 起笔圆头：往回延伸半个笔宽
        const r = (wt + wb) * 0.5, off = (wt - wb) * 0.5;
        for (let c = capA; c >= 1; c--) {
          const a = c / (capA + 1), f = Math.sqrt(Math.max(0, 1 - a * a));
          const d = r * a;
          const cx = x - tx * d + nx * off * (1 - f), cy = y - ty * d + ny * off * (1 - f);
          emit(cx, cy, nx, ny, s - d, wt * f, wb * f, ink, dry);
        }
      }
      emit(x, y, nx, ny, s, wt, wb, ink, dry);
      lastX = x; lastY = y; lastNx = nx; lastNy = ny; lastWt = wt; lastWb = wb; lastInk = ink; lastDry = dry; lastS = s; lastTx = tx; lastTy = ty;
    }
    if (capB > 0 && (lastWt + lastWb) * z > 1.5) {
      const r = (lastWt + lastWb) * 0.5, off = (lastWt - lastWb) * 0.5;
      for (let c = 1; c <= capB; c++) {
        const a = c / (capB + 1), f = Math.sqrt(Math.max(0, 1 - a * a));
        const d = r * a;
        emit(lastX + lastTx * d + lastNx * off * (1 - f), lastY + lastTy * d + lastNy * off * (1 - f), lastNx, lastNy, lastS + d, lastWt * f, lastWb * f, lastInk, lastDry);
      }
    }
    if (k < 2) return;
    const I = B.i;
    let ni = B.ni;
    for (let j = 0; j < k - 1; j++) {
      const a = base + j * 2, b = a + 1, c = a + 2, d = a + 3;
      I[ni++] = a; I[ni++] = b; I[ni++] = c;
      I[ni++] = b; I[ni++] = d; I[ni++] = c;
    }
    B.ni = ni; B.nv = base + k * 2;
  }

  /** 墨块：poly 世界坐标 [x0,y0,...]；o.ink 数或 (x,y)=>墨；o.fan 以中心扇形（凸形，快）；o.tex 纹理量 */
  fill(poly, o = {}) {
    let n = poly.length >> 1;
    if (n < 3) return;
    // 闭合样条最后一点等于第一点：去掉重复
    if (Math.abs(poly[0] - poly[2 * n - 2]) < 1e-3 && Math.abs(poly[1] - poly[2 * n - 1]) < 1e-3) n--;
    if (n < 3) return;
    const ch = o.ch || CH.wet, seed = o.seed === undefined ? 0.5 : o.seed, tex = o.tex === undefined ? 0.6 : o.tex, gr = o.gran || 0;
    const fink = o.ink === undefined ? 0.3 : o.ink;
    const fe = o.feather ? o.feather : (o.featherPx ? o.featherPx / this.view.z : 0);
    const B = this.fills, arr = B.v, st = B.stride;
    const put = (idx, x, y, ink, e) => {
      const oo = idx * st;
      arr[oo] = this.sx(x, y); arr[oo + 1] = this.sy(x, y); arr[oo + 2] = x; arr[oo + 3] = y;
      arr[oo + 4] = ink; arr[oo + 5] = seed; arr[oo + 6] = tex; arr[oo + 7] = gr;
      arr[oo + 8] = ch[0]; arr[oo + 9] = ch[1]; arr[oo + 10] = ch[2]; arr[oo + 11] = ch[3]; arr[oo + 12] = e;
    };
    const inkAt = (x, y) => (typeof fink === 'function' ? fink(x, y) : fink);
    let ringBase = 0; // 外轮廓第 i 点的顶点号 = ringBase + i
    const skirtV = fe > 0 ? n : 0, skirtI = fe > 0 ? n * 6 : 0;
    if (o.fan) {
      if (!B.room(n + 1 + skirtV, n * 3 + skirtI)) return;
      let cx = 0, cy = 0;
      for (let i = 0; i < n; i++) { cx += poly[2 * i]; cy += poly[2 * i + 1]; }
      cx /= n; cy /= n;
      const base = B.nv;
      put(base, cx, cy, o.inkCenter === undefined ? inkAt(cx, cy) : o.inkCenter, 1);
      for (let i = 0; i < n; i++) put(base + 1 + i, poly[2 * i], poly[2 * i + 1], inkAt(poly[2 * i], poly[2 * i + 1]), 1);
      const I = B.i; let ni = B.ni;
      for (let i = 0; i < n; i++) { I[ni++] = base; I[ni++] = base + 1 + i; I[ni++] = base + 1 + ((i + 1) % n); }
      B.ni = ni; B.nv = base + n + 1;
      ringBase = base + 1;
    } else {
      const THREE = this.THREE;
      const contour = [];
      for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(poly[2 * i], poly[2 * i + 1]));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      if (!B.room(n + skirtV, tris.length * 3 + skirtI)) return;
      const base = B.nv;
      for (let i = 0; i < n; i++) put(base + i, poly[2 * i], poly[2 * i + 1], inkAt(poly[2 * i], poly[2 * i + 1]), 1);
      const I = B.i; let ni = B.ni;
      for (const t of tris) { I[ni++] = base + t[0]; I[ni++] = base + t[1]; I[ni++] = base + t[2]; }
      B.ni = ni; B.nv = base + n;
      ringBase = base;
    }
    if (fe > 0) {
      // 羽化：沿外法线挤出一圈（宽度带一点随机），外圈 aE=0
      let A2 = 0;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; A2 += poly[2 * i] * poly[2 * j + 1] - poly[2 * j] * poly[2 * i + 1]; }
      const sg = A2 >= 0 ? 1 : -1;
      const base2 = B.nv;
      let pnx = 0, pny = 0;
      { const i = n - 1, j = 0; const dx = poly[2 * j] - poly[2 * i], dy = poly[2 * j + 1] - poly[2 * i + 1], l = Math.hypot(dx, dy) || 1; pnx = sg * dy / l; pny = -sg * dx / l; }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const dx = poly[2 * j] - poly[2 * i], dy = poly[2 * j + 1] - poly[2 * i + 1], l = Math.hypot(dx, dy);
        let nnx = pnx, nny = pny;
        if (l > 1e-4) { nnx = sg * dy / l; nny = -sg * dx / l; }
        let vx = pnx + nnx, vy = pny + nny;
        const vl = Math.hypot(vx, vy) || 1;
        vx /= vl; vy /= vl;
        // 尖角处别挤太远
        const cosH = Math.max(0.35, vx * nnx + vy * nny);
        const k = fe * (0.75 + 0.5 * hashF(i * 1.37 + seed * 7.1)) / cosH;
        const x = poly[2 * i] + vx * k, y = poly[2 * i + 1] + vy * k;
        put(base2 + i, x, y, inkAt(poly[2 * i], poly[2 * i + 1]), 0);
        pnx = nnx; pny = nny;
      }
      const I = B.i; let ni = B.ni;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = ringBase + i, b = ringBase + j, c = base2 + i, d = base2 + j;
        I[ni++] = a; I[ni++] = b; I[ni++] = c; I[ni++] = b; I[ni++] = d; I[ni++] = c;
      }
      B.ni = ni; B.nv = base2 + n;
    }
  }

  /** 网格墨块：rows×cols 的世界坐标网格（带每点墨量），用于身体、棉被这类要平滑渐变的面 */
  grid(P, rows, cols, o = {}) {
    // P: Float32Array (rows*cols*3) = x, y, ink
    const ch = o.ch || CH.wet, seed = o.seed === undefined ? 0.5 : o.seed, tex = o.tex === undefined ? 0.6 : o.tex, gr = o.gran || 0;
    const B = this.fills, arr = B.v, st = B.stride;
    if (!B.room(rows * cols, (rows - 1) * (cols - 1) * 6)) return;
    const base = B.nv;
    for (let i = 0; i < rows * cols; i++) {
      const x = P[3 * i], y = P[3 * i + 1], oo = (base + i) * st;
      arr[oo] = this.sx(x, y); arr[oo + 1] = this.sy(x, y); arr[oo + 2] = x; arr[oo + 3] = y;
      arr[oo + 4] = P[3 * i + 2]; arr[oo + 5] = seed; arr[oo + 6] = tex; arr[oo + 7] = gr;
      arr[oo + 8] = ch[0]; arr[oo + 9] = ch[1]; arr[oo + 10] = ch[2]; arr[oo + 11] = ch[3]; arr[oo + 12] = 1;
    }
    const I = B.i; let ni = B.ni;
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
      const a = base + r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      I[ni++] = a; I[ni++] = d; I[ni++] = b; I[ni++] = b; I[ni++] = d; I[ni++] = e;
    }
    B.ni = ni; B.nv = base + rows * cols;
  }

  /** 圆点（不规则墨点）：r 世界半径；o.irr 边缘不规则；o.sx,o.sy 拉长方向（世界）；o.seg 边数 */
  blob(x, y, r, o = {}) {
    const seg = o.seg || Math.max(10, Math.min(40, Math.round(r * this.view.z * 0.9) + 8));
    const irr = o.irr === undefined ? 0.18 : o.irr, sd = o.seed === undefined ? (x * 0.013 + y * 0.029) : o.seed;
    const ex = o.ex || 0, ey = o.ey || 0; // 拉长向量（世界）
    const el = Math.hypot(ex, ey), ux = el > 0 ? ex / el : 1, uy = el > 0 ? ey / el : 0;
    const pts = this._blobPts || (this._blobPts = new Float32Array(128));
    // 墨点的外形：几个随机相位的谐波叠在一起（不要规则的三瓣/心形），再加一点随机的椭圆
    const f1 = (sd * 7.31) % 6.283, f2 = (sd * 3.17) % 6.283, f3 = (sd * 5.77) % 6.283, f4 = (sd * 1.93) % 6.283;
    const ell = 0.12 * Math.sin(sd * 2.1), ea = sd * 1.37, ay = o.ay || 1, rotB = o.rot || 0, cr = Math.cos(rotB), sr = Math.sin(rotB);
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const n1 = Math.sin(a * 2 + f1) * 0.35 + Math.sin(a * 3 + f2) * 0.25 + Math.sin(a * 5 + f3) * 0.22 + Math.sin(a * 8 + f4) * 0.18;
      const rr = r * (1 + irr * n1) * (1 + ell * Math.cos(2 * (a - ea)));
      let px = Math.cos(a) * rr, py = Math.sin(a) * rr * ay;
      if (rotB) { const qx = px * cr - py * sr, qy = px * sr + py * cr; px = qx; py = qy; }
      const along = px * ux + py * uy;
      if (el > 0 && along > 0) { const f = (el / Math.max(r, 1e-3)) * (along / rr); px += ux * along * f; py += uy * along * f; }
      pts[2 * i] = x + px; pts[2 * i + 1] = y + py;
    }
    this.fill(pts.subarray(0, seg * 2), { ...o, fan: true, inkCenter: o.inkCenter });
  }

  /** 贴图：tex 按世界矩形 (x,y,w,h) 画进墨量；map 是 4×4 通道映射（列主序，同 three Matrix4.set 的行主序参数） */
  image(tex, x, y, w, h, { map, mul = 1, uv = [0, 0, 1, 1], reveal = 1, seed = 0 } = {}) {
    const THREE = this.THREE;
    let mesh = this.imgPool[this.imgUsed];
    if (!mesh) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8), 2));
      g.setAttribute('aUv', new THREE.BufferAttribute(new Float32Array(8), 2));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      const mat = new THREE.ShaderMaterial({
        vertexShader: IMG_VS, fragmentShader: IMG_FS,
        uniforms: { map: { value: null }, uMap: { value: new THREE.Matrix4() }, uMul: { value: 1 }, uReveal: { value: new THREE.Vector2(1, 0) }, uRes: { value: new THREE.Vector2(W, H) } },
        ...additive(THREE),
      });
      mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      this.imgPool.push(mesh);
      this.scene.add(mesh); // 与笔触同一次 render：MSAA 目标每次 resolve 后颜色会被 invalidate，不能分两次累加
    }
    this.imgUsed++;
    const p = mesh.geometry.attributes.position, a = mesh.geometry.attributes.aUv;
    const cs = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    const us = [[uv[0], 1 - uv[1]], [uv[2], 1 - uv[1]], [uv[2], 1 - uv[3]], [uv[0], 1 - uv[3]]];
    for (let i = 0; i < 4; i++) {
      p.array[2 * i] = this.sx(cs[i][0], cs[i][1]); p.array[2 * i + 1] = this.sy(cs[i][0], cs[i][1]);
      a.array[2 * i] = us[i][0]; a.array[2 * i + 1] = us[i][1];
    }
    p.needsUpdate = true; a.needsUpdate = true;
    const u = mesh.material.uniforms;
    u.map.value = tex; u.uMul.value = mul; u.uReveal.value.set(reveal, seed);
    if (map) u.uMap.value.set(...map); else u.uMap.value.identity();
    mesh.visible = true;
  }

  /** 把这一帧积累的几何画进墨量缓冲 */
  end() {
    const r = this.r;
    const pt = this.paperT;
    for (const m of [this.strokeMat, this.fillMat]) m.uniforms.uPaperT.value.set(pt[0], pt[1], pt[2], 0);
    this.strokes.upload(); this.fills.upload();
    const prevAuto = r.autoClear;
    const cc = new this.THREE.Color(); r.getClearColor(cc); const ca = r.getClearAlpha();
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.autoClear = false;
    r.render(this.scene, this.cam);
    r.autoClear = prevAuto;
    r.setClearColor(cc, ca);
  }

  pass(mat, target) {
    const r = this.r; const prev = r.autoClear; r.autoClear = true;
    this.ctx.post.blit(mat, target);
    r.autoClear = prev;
  }

  /** 两个镜头的墨量混合（过渡）→ rtM */
  mix(tr) {
    const u = this.mixMat.uniforms;
    u.tA.value = this.rtA.texture; u.tB.value = this.rtB.texture;
    u.uTr.value.set(tr.p, tr.type, tr.seed || 0, tr.soft === undefined ? 0.08 : tr.soft);
    const d = tr.dir || [1, 0, 1];
    u.uTr2.value.set(d[0], d[1], d[2] || 1, 0);
    const w = tr.win || [0, 1, 0, 1];
    u.uTrW.value.set(w[0], w[1], w[2], w[3]);
    this.pass(this.mixMat, this.rtM);
    return this.rtM;
  }

  blurChain(src) {
    const d = this.downMat.uniforms, b = this.blurMat.uniforms;
    const down = (s, dst) => { d.src.value = s.texture; d.texel.value.set(1 / s.width, 1 / s.height); this.pass(this.downMat, dst); };
    const gauss = (pair, rad) => {
      const [a, c] = pair;
      b.src.value = a.texture; b.dir.value.set(rad / a.width, 0); this.pass(this.blurMat, c);
      b.src.value = c.texture; b.dir.value.set(0, rad / a.height); this.pass(this.blurMat, a);
    };
    down(src, this.h1[0]); gauss(this.h1, 1.0);
    down(this.h1[0], this.q1[0]); gauss(this.q1, 1.2);
    down(this.q1[0], this.e1[0]); gauss(this.e1, 1.4);
    return { S: this.h1[0], L: this.q1[0], XL: this.e1[0] };
  }

  /** 合成到当前 HDR 目标。look 见 COMP_FS 的 uniform 注释 */
  composite(dens, look, camA, papA, camB, papB, tr) {
    const bl = this.blurChain(dens);
    const u = this.compMat.uniforms;
    u.tD.value = dens.texture; u.tS.value = bl.S.texture; u.tL.value = bl.L.texture; u.tXL.value = bl.XL.texture;
    u.uCamA.value.set(camA.cx, camA.cy, camA.z, camA.rot);
    u.uPapA.value.set(papA[0], papA[1], papA[2], camA.z / papA[0]);
    if (camB) {
      u.uHasB.value = 1;
      u.uCamB.value.set(camB.cx, camB.cy, camB.z, camB.rot);
      u.uPapB.value.set(papB[0], papB[1], papB[2], camB.z / papB[0]);
      u.uTr.value.set(tr.p, tr.type, tr.seed || 0, tr.soft === undefined ? 0.08 : tr.soft);
      const d = tr.dir || [1, 0, 1];
      u.uTr2.value.set(d[0], d[1], d[2] || 1, 0);
      const w = tr.win || [0, 1, 0, 1];
      u.uTrW.value.set(w[0], w[1], w[2], w[3]);
    } else u.uHasB.value = 0;
    const L = look;
    u.uLook.value.set(L.bleed ?? 0.7, L.rim ?? 0.8, L.gran ?? 0.6, L.defocus ?? 0);
    u.uLook2.value.set(L.bmode ?? 0, L.resv ?? 6, L.glow ?? 0, L.white ?? 0);
    u.uNight.value.set(L.night ?? 0, L.nightDen ?? 3, L.nightStreak ?? 0, L.nightIn ?? 1);
    u.uFinal.value.set(L.final ?? 0, L.finalSeed ?? 1.7, L.finalX ?? 960, L.finalY ?? 540);
    u.uWob.value.set(L.wob ?? 1.6, L.wob2 ?? 3.0);
    const r = this.r; const prev = r.autoClear; r.autoClear = true;
    this.ctx.blit(this.compMat);
    r.autoClear = prev;
  }
}
