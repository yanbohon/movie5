// 水下世界共用的 GLSL 片段：噪声、焦散、浑水光照与雾、电感视觉的波前遮罩。
// 所有材质都在同一个 pass 里同时算「真实视角」和「电感视觉」两种颜色，按世界坐标的波前遮罩混合。

export const NOISE = /* glsl */ `
vec3 _m289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 _m289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 _perm(vec4 x){ return _m289(((x*34.0)+10.0)*x); }
vec4 _tis(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
// Ashima 3D simplex noise，输出约 -1..1
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
  i = _m289(i);
  vec4 p = _perm(_perm(_perm(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
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
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = _tis(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
float fbm3(vec3 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ s += a * snoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
float hash13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
`;

// 水体参数（所有材质共享的 uniforms，见 world.js 的 makeWaterUniforms）
export const WATER_UNIFORMS = /* glsl */ `
uniform float uTime;
uniform vec3 uCamPos;
uniform float uSurfaceY;      // 水面高度（米）
uniform vec3 uSunDir;         // 指向光源（从水里看向上的方向），归一化
uniform vec3 uSunColor;       // 水面处的入射光（线性）
uniform float uSigma;         // 视线方向的消光系数（浑浊度，1/米）
uniform float uSigmaLight;    // 光往下走的衰减（1/米）
uniform vec3 uFogUp;          // 往上看时的散射色
uniform vec3 uFogDown;        // 往下看时的散射色
uniform vec3 uAmbUp;          // 半球环境光：上
uniform vec3 uAmbDown;        // 半球环境光：下
uniform float uCaustic;       // 焦散强度
uniform float uShafts;        // 体积光束强度（背景与粒子用）
// 电感视觉
uniform vec3 uEC;             // 波前中心（吻部）
uniform float uER;            // 波前半径（米）；<0 表示没有波
uniform float uEMix;          // 全局电感混合 0..1（波扫完后置 1）
uniform float uENoise;        // 电感视觉里的干扰噪声（船）
uniform float uERange;        // 电感视觉的感知距离（米）
uniform vec4 uOcc;            // 水面上的遮挡物（船）：中心 xz、半长、半宽
uniform float uOccAng;        // 遮挡物航向（弧度）
uniform float uOccAmt;        // 遮挡强度 0..1
// 两江交汇（默认关闭）：uMix2 > 0 时，浑浊度与散射色跨一个平面过渡到「第二种水」
uniform float uMix2;          // 第二种水的强度 0..1（0 = 只有一种水，和原来逐像素一样）
uniform vec4 uMixPlane;       // 分界面：xyz 单位法线（指向第二种水），w 偏移（dot(p, n) = w 处是分界）
uniform float uMixW;          // 过渡带半宽（米）
uniform vec4 uMixTurb;        // 分界面的翻卷：xyz 随水流漂移的速度（米/秒），w 幅度（米）
uniform float uSigma2;        // 第二种水的消光系数
uniform vec3 uFog2Up;         // 第二种水往上看的散射色
uniform vec3 uFog2Down;       // 第二种水往下看的散射色
uniform float uERingDim;      // 电感波前亮环减弱多少 0..1（默认 0 = 原样；没传这个 uniform 的材质也是 0）
uniform float uEWorldR;       // 电感视觉里还「感知得到」的环境半径（米，以 uEC 为中心，越远越暗）；0 = 不限（默认）
uniform vec3 uEWorldAx;       // 感知范围沿身体拉长：以 uEC 为中点、两头各 uEWorldAx 的线段（默认 0 = 一个点）
`;

export const WATER_FUNCS = /* glsl */ `
// 水面焦散（投影到深度 y 处）：扭曲的余弦网，给出明亮的细网与暗的空洞
float causticAt(vec3 p){
  vec2 q = p.xz - uSunDir.xz / max(uSunDir.y, 0.2) * (uSurfaceY - p.y);
  q *= 0.55;
  float t = uTime * 0.35;
  vec2 w = q + 0.6 * vec2(snoise(vec3(q * 0.7, t)), snoise(vec3(q * 0.7 + 7.3, t)));
  float c = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 d = vec2(cos(fi * 2.1 + 0.3), sin(fi * 2.1 + 0.3));
    c += 1.0 - abs(sin(dot(w, d) * (2.3 + fi * 0.37) + t * (1.0 + fi * 0.3) + snoise(vec3(w * 0.9, t + fi)) * 1.6));
  }
  c /= 3.0;
  return pow(max(c, 0.0), 6.0) * 2.2;
}
// 船底挡光：把点沿光线方向投到水面，看落不落在船的投影里（越深半影越软）
float occAt(vec3 p){
  if (uOccAmt <= 0.0) return 1.0;
  float depth = max(uSurfaceY - p.y, 0.0);
  vec2 q = p.xz - uSunDir.xz / max(uSunDir.y, 0.2) * depth - uOcc.xy;
  float c = cos(uOccAng), s = sin(uOccAng);
  q = vec2(c * q.x + s * q.y, -s * q.x + c * q.y);
  float soft = 0.6 + depth * 0.22;
  float ix = 1.0 - smoothstep(uOcc.z - soft, uOcc.z + soft, abs(q.x));
  float iz = 1.0 - smoothstep(uOcc.w - soft, uOcc.w + soft, abs(q.y));
  return 1.0 - uOccAmt * ix * iz * 0.8;
}
// 某点处从水面下来的光（含深度衰减、焦散、船影）
vec3 lightAt(vec3 p){
  float depth = max(uSurfaceY - p.y, 0.0);
  float att = exp(-uSigmaLight * depth);
  float caus = 1.0 + uCaustic * (causticAt(p) - 0.35) * exp(-depth * 0.18);
  return uSunColor * att * max(caus, 0.0) * occAt(p);
}
// 沿视线方向的散射色（背景色）：往上亮、往下暗
vec3 inscatterDir(vec3 dir, float y){
  float k = smoothstep(-0.9, 0.95, dir.y);
  float depth = max(uSurfaceY - y, 0.0);
  float att = exp(-uSigmaLight * depth * 0.55);
  vec3 c = mix(uFogDown, uFogUp, k) * att;
  // 太阳方向附近亮一团（浑水里的前向散射）
  float sunk = pow(max(dot(dir, uSunDir), 0.0), 6.0);
  c += uSunColor * 0.06 * sunk * att;
  return c;
}
// ---- 两江交汇（只在 uMix2 > 0 时用到）----
// 某点属于第二种水的程度 0..1（不含 uMix2）：分界面两侧平滑过渡，界面本身按噪声翻卷、随水流漂走
float waterSide(vec3 p){
  float sd = dot(p, uMixPlane.xyz) - uMixPlane.w;
  if (uMixTurb.w > 0.0) {
    vec3 q = (p - uMixTurb.xyz * uTime) * 0.21;
    sd += uMixTurb.w * (snoise(q) + 0.5 * snoise(q * 2.4 + 7.1) + 0.2 * snoise(q * 6.1 - 3.7));
  }
  return smoothstep(-uMixW, uMixW, sd);
}
// 某种水（w：第二种水的比例）沿方向 dir 的散射色
vec3 inscatterW(vec3 dir, float y, float w){
  float k = smoothstep(-0.9, 0.95, dir.y);
  float depth = max(uSurfaceY - y, 0.0);
  float att = exp(-uSigmaLight * depth * 0.55);
  vec3 c = mix(mix(uFogDown, uFogUp, k), mix(uFog2Down, uFog2Up, k), w) * att;
  float sunk = pow(max(dot(dir, uSunDir), 0.0), 6.0);
  c += uSunColor * 0.06 * sunk * att;
  return c;
}
// 视线 a→b 穿过两种水：分 N 段累积（段内按那一处的水算透射与散射）。返回 (散射色, 总透射)
vec4 waterPathN(vec3 a, vec3 b, float jitter, const int N){
  vec3 v = b - a;
  float d = length(v);
  vec3 dir = v / max(d, 1e-4);
  float dl = d / float(N);
  vec3 acc = vec3(0.0);
  float Tr = 1.0;
  for (int i = 0; i < 16; i++) {
    if (i >= N) break;
    vec3 m = a + dir * ((float(i) + jitter) * dl);
    float w = uMix2 * waterSide(m);
    float Ti = exp(-mix(uSigma, uSigma2, w) * dl);
    acc += Tr * (1.0 - Ti) * inscatterW(dir, m.y, w);
    Tr *= Ti;
  }
  return vec4(acc, Tr);
}
vec4 waterPath(vec3 a, vec3 b){ return waterPathN(a, b, 0.5, 8); }
// 把表面颜色融进浑水：透射 + 散射
vec3 applyWater(vec3 col, vec3 wp){
  if (uMix2 > 0.0) { vec4 wpth = waterPath(uCamPos, wp); return col * wpth.a + wpth.rgb; }
  vec3 v = wp - uCamPos;
  float d = length(v);
  vec3 dir = v / max(d, 1e-4);
  float T = exp(-uSigma * d);
  vec3 ins = inscatterDir(dir, mix(uCamPos.y, wp.y, 0.5));
  // 船影里的水不被照亮：散射按视线中段与终点的遮挡变暗
  if (uOccAmt > 0.0) ins *= mix(1.0, 0.5 * (occAt(mix(uCamPos, wp, 0.5)) + occAt(wp)), 0.9);
  return col * T + ins * (1.0 - T);
}
// 电感视觉遮罩：1 = 电感，0 = 真实
float electroMask(vec3 wp){
  float m = uEMix;
  if (uER > 0.0) {
    float d = length(wp - uEC);
    m = max(m, 1.0 - smoothstep(uER - 1.2, uER, d));
  }
  return clamp(m, 0.0, 1.0);
}
// 波前亮环（叠加在两种视角的交界上）
float electroRing(vec3 wp){
  if (uER <= 0.0) return 0.0;
  float d = length(wp - uEC);
  float x = (d - uER) / 0.14;
  float ring = exp(-x * x) * smoothstep(0.5, 3.0, uER) * (1.0 - smoothstep(18.0, 30.0, uER));
  return uERingDim > 0.0 ? ring * (1.0 - uERingDim) : ring;
}
// 电感视觉的距离衰减（比真实视角看得远，但越远越暗）
float electroFade(vec3 wp){
  float d = length(wp - uCamPos);
  return exp(-d / max(uERange, 0.1));
}
// 感知收缩（默认关闭）：uEWorldR > 0 时，环境（河床、卵石、空水）离 uEC 越远越暗，外圈先黑
float electroWorld(vec3 wp){
  if (uEWorldR <= 0.0) return 1.0;
  vec3 a = uEC - uEWorldAx, ab = 2.0 * uEWorldAx;
  float h = clamp(dot(wp - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return 1.0 - smoothstep(uEWorldR * 0.45, uEWorldR, length(wp - a - ab * h));
}
`;

// 电感视觉的色彩
export const ELECTRO_COLORS = /* glsl */ `
const vec3 E_CORE = vec3(0.62, 0.90, 1.00);   // 冷白青
const vec3 E_DEEP = vec3(0.05, 0.22, 0.34);
const vec3 E_BG   = vec3(0.004, 0.009, 0.016); // 电感视觉里的「空水」
const vec3 E_AMBER = vec3(1.0, 0.72, 0.38);
`;

export const COMMON = NOISE + WATER_UNIFORMS + ELECTRO_COLORS + WATER_FUNCS;
