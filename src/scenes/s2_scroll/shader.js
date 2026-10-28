// S2 长卷合成着色器：纸 + 静态墨层（分块纹理）+ 现场生长的精灵 + 游动的鱼 + 坝线 + 裱边/卷轴/暗底
import { INK_GLSL } from '../../film/ink.js';
import { PALETTE } from '../../film/paper.js';

export const NSPR = 6;     // 精灵槽
export const NFISH = 40;   // 同屏鱼上限
export const NTILE = 3;    // 静态分块数上限

const VERT = 'varying vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy,0.,1.); }';
const v3 = (c) => `vec3(${(c[0] / 255).toFixed(4)}, ${(c[1] / 255).toFixed(4)}, ${(c[2] / 255).toFixed(4)})`;

export function makeScrollMaterial(THREE, o) {
  const sprDecl = [], sprCode = [];
  for (let i = 0; i < NSPR; i++) {
    sprDecl.push(`uniform sampler2D uS${i};`);
    sprCode.push(`
    if (uSP[${i}].x > 0.5) {
      vec2 lp = (s - uSR[${i}].xy) / uSR[${i}].zw;
      if (lp.x > 0.0 && lp.y > 0.0 && lp.x < 1.0 && lp.y < 1.0) {
        vec4 q = textureLod(uS${i}, lp, lodS);
        applySprite(q, uSP[${i}], uSQ[${i}], s, lp, T, red, over, occ);
      }
    }`);
  }
  const tileCode = [];
  for (let i = 0; i < NTILE; i++) tileCode.push(`${i ? 'else ' : ''}if (ti < ${i}.5) return textureLod(uT${i}, uv, lod);`);
  const frag = /* glsl */ `
${INK_GLSL}
uniform sampler2D uPaper; uniform vec2 uPaperSize;
${Array.from({ length: NTILE }, (_, i) => `uniform sampler2D uT${i};`).join('\n')}
uniform float uTileW, uPad, uHS, uLen, uMount;
uniform vec3 uCam; uniform float uFarOff; uniform float uTime; uniform float uFarK;
${sprDecl.join('\n')}
uniform vec4 uSR[${NSPR}]; uniform vec4 uSP[${NSPR}]; uniform vec4 uSQ[${NSPR}];
uniform sampler2D uFishTex; uniform vec2 uFishTexSize;
uniform vec4 uFA[${NFISH}]; uniform vec4 uFB[${NFISH}]; uniform vec4 uFC[${NFISH}]; uniform vec4 uFD[${NFISH}];
uniform int uFN;
uniform vec4 uDam; uniform vec4 uDam2;
varying vec2 vUv;

float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { return vn(p) * 0.5 + vn(p * 2.03 + 7.1) * 0.3 + vn(p * 4.1 - 3.3) * 0.2; }

vec4 tileTex(vec2 s, float lod) {
  float x = clamp(s.x, 0.0, uLen - 0.5);
  float ti = floor(x / uTileW);
  vec2 uv = vec2((x - ti * uTileW + uPad) / (uTileW + 2.0 * uPad), clamp(s.y, 0.0, uHS) / uHS);
  ${tileCode.join('\n  ')}
  return vec4(0.0);
}

// 精灵：mode 1 按到达时间揭示的墨；2 同上但是朱砂；3 画布墨（alpha）；4 化灰散去；5 画布朱砂
void applySprite(vec4 q, vec4 P, vec4 Q, vec2 s, vec2 lp, inout float T, inout float red, inout vec4 over, inout float occ) {
  float mode = P.x, now = P.y, alpha = P.z, soft = P.w;
  if (mode < 1.5 || (mode > 1.5 && mode < 2.5)) {
    if (q.r > 0.999) return;
    float r = smoothstep(q.r, q.r + soft, now);
    float wet = 1.0 + Q.x * exp(-max(0.0, now - q.r) / max(0.001, soft * 3.0));
    float d = clamp(q.g * r * wet, 0.0, 1.0) * alpha;
    if (mode < 1.5) T *= 1.0 - d; else red = 1.0 - (1.0 - red) * (1.0 - d);
    // 近处现场长出来的山把后面的远山挡住（Q.y = 遮挡强度）
    if (Q.y > 0.0) occ = max(occ, clamp(d * Q.y, 0.0, 1.0));
  } else if (mode < 3.5) {
    // 书法画布（brush.js 的颜色 + alpha，保留它的湿墨反光），按「覆盖」叠在最上
    float a = q.a * alpha;
    over = vec4(q.rgb * a + over.rgb * (1.0 - a), a + over.a * (1.0 - a));
  } else if (mode < 4.5) {
    // 化灰：Q.x = 冲击后经过的秒数，q.r = 延迟（0..1 → 0..Q.y 秒）
    float k = clamp((Q.x - q.r * Q.y) / Q.z, 0.0, 1.0);
    float n = fbm(s * 0.045) * 0.7 + h21(floor(s * 0.5)) * 0.3;
    float gone = smoothstep(n - 0.2, n + 0.05, k * 1.15);
    float gray = mix(1.0, 0.38, smoothstep(0.0, 0.35, k));
    float d = q.g * gray * (1.0 - gone) * alpha;
    T *= 1.0 - d;
  } else {
    red = 1.0 - (1.0 - red) * (1.0 - q.a * alpha);
  }
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 px = vec2(fc.x, 1080.0 - fc.y);
  float z = uCam.z;
  vec2 s = uCam.xy + (px - vec2(960.0, 540.0)) / z;
  float lod = max(0.0, log2(1.0 / z));
  float aa = 0.75 / z;
  // ---- 纸外：裱边、卷轴、暗底 ----
  vec3 bg = ${v3([22, 19, 16])} * (0.85 + 0.15 * smoothstep(1400.0, 0.0, length(px - vec2(960.0, 540.0)) ));
  float inPaperX = step(0.0, s.x) * step(s.x, uLen);
  float mountTop = -uMount, mountBot = uHS + uMount;
  bool inBand = s.y > mountTop && s.y < mountBot && s.x > -34.0 && s.x < uLen + 74.0;
  if (!(s.x >= 0.0 && s.x <= uLen && s.y >= 0.0 && s.y <= uHS)) {
    vec3 col = bg;
    // 纸卷投在桌上的影
    float dy = s.y < 0.0 ? mountTop - s.y : s.y - mountBot;
    float dx = s.x < 0.0 ? -60.0 - s.x : s.x - (uLen + 86.0);
    float sh = smoothstep(0.0, 70.0, max(dy - 6.0, dx));
    col *= 0.55 + 0.45 * sh;
    if (inBand) {
      // 裱边的绫：细密的织纹
      float weave = 0.5 + 0.25 * sin(s.x * 2.1) * sin(s.y * 2.3) + 0.25 * vn(s * vec2(0.08, 1.2));
      vec3 silk = ${v3([196, 188, 168])} * (0.94 + 0.08 * weave) * (0.97 + 0.05 * fbm(s * 0.004));
      // 裱边与画心交界一道细细的暗缝
      float seam = 1.0 - 0.18 * exp(-abs(s.y < 0.0 ? s.y : s.y - uHS) * 0.6) - 0.18 * exp(-abs(s.x < 0.0 ? s.x : s.x - uLen) * 0.6);
      col = silk * seam;
      float edge = min(min(s.y - mountTop, mountBot - s.y), min(s.x + 34.0, uLen + 74.0 - s.x));
      col = mix(bg, col, smoothstep(0.0, aa * 2.0, edge));
    }
    // 右端天杆
    if (s.x > uLen + 74.0 && s.x < uLen + 88.0 && s.y > mountTop - 6.0 && s.y < mountBot + 6.0) {
      float u = (s.x - uLen - 74.0) / 14.0;
      col = ${v3([70, 50, 36])} * (0.6 + 0.6 * sin(u * 3.1416));
    }
    // 左端卷轴 + 轴头
    if (s.x < -34.0 && s.x > -64.0) {
      float u = (s.x + 64.0) / 30.0;
      float cyl = 0.45 + 0.55 * pow(sin(u * 3.1416), 0.7);
      if (s.y > mountTop - 12.0 && s.y < mountBot + 12.0) col = ${v3([58, 40, 28])} * cyl * (0.95 + 0.1 * vn(s * vec2(0.3, 0.02)));
      else if (s.y > mountTop - 46.0 && s.y < mountBot + 46.0 && s.x > -60.0 && s.x < -38.0) col = ${v3([214, 204, 182])} * (0.55 + 0.45 * cyl);
    }
    gl_FragColor = vec4(srgb2lin(col), 1.0);
    return;
  }
  // ---- 纸 ----
  vec4 P1 = textureLod(uPaper, s / uPaperSize, lod);
  vec4 P2 = textureLod(uPaper, (s * 0.83 + vec2(517.0, 213.0)) / uPaperSize, lod);
  float pw = smoothstep(0.35, 0.65, vn(s / 1300.0 + 3.7));
  vec4 P = mix(P1, P2, pw);
  vec3 paper = P.rgb * (0.985 + 0.03 * fbm(s / 700.0));
  float fib = P.a;
  // ---- 静态墨 ----
  vec4 A = tileTex(s, lod);
  float dFar = tileTex(vec2(s.x - uFarOff, s.y), lod).r * uFarK;
  float dLine = A.g, dRiver = A.b;
  // A 通道 = 留白蒙版：近处的屋、船、山把后面的远山、水纹「让」出来（画家不会把远山画进屋里）
  float keep = 1.0 - A.a;
  dFar = fiberMod(dFar, fib, 0.35) * keep;
  dRiver = fiberMod(dRiver, fib, 0.2) * keep;
  float T = (1.0 - dLine) * (1.0 - dRiver);
  float occ = 0.0;
  float red = 0.0;
  vec4 over = vec4(0.0);
  // ---- 精灵 ----
  float lodS = lod;
  ${sprCode.join('\n')}
  // ---- 鱼 ----
  for (int i = 0; i < ${NFISH}; i++) {
    if (i >= uFN) break;
    vec4 a = uFA[i]; vec4 b = uFB[i]; vec4 c = uFC[i]; vec4 e = uFD[i];
    float lx = (s.x - a.x) * (-a.z);
    float ly = s.y - a.y;
    if (lx < -b.z - 4.0 || lx > c.x - b.z + 4.0 || ly < -b.w - 12.0 || ly > c.y - b.w + 12.0) continue;
    float u = clamp(lx / a.w, 0.0, 1.1);
    float disp = e.x * a.w * 0.016 * sin(6.2831 * (u * 0.85 - uTime * e.y) + c.z) * u * u;
    vec2 sp = vec2(b.z + lx, b.w + ly - disp);
    if (sp.x < 0.0 || sp.y < 0.0 || sp.x > c.x || sp.y > c.y) continue;
    float d = textureLod(uFishTex, (b.xy + sp) / uFishTexSize, lod).g;
    // 淡去：墨色先变淡，再被纸吃掉
    float k = e.z;
    if (k > 0.0) {
      float n = vn(sp * 0.09 + c.z * 10.0) * 0.6 + vn(sp * 0.4) * 0.4;
      d *= (1.0 - k) * (1.0 - smoothstep(n - 0.25, n + 0.05, k * 1.1));
    }
    d = fiberMod(d * c.w, fib, 0.25) * keep;
    T *= 1.0 - d;
  }
  T *= 1.0 - dFar * (1.0 - occ);
  // ---- 坝：尺子画的直线（粗、硬、没有笔锋）----
  if (uDam.w > 0.0) {
    float hw = uDam2.x * 0.5;
    float dx = abs(s.x - uDam.x);
    float yEnd = mix(uDam.y, uDam.z, uDam.w);
    float cov = (1.0 - smoothstep(hw - aa, hw + aa, dx)) * smoothstep(uDam.y - aa, uDam.y + aa, s.y) * (1.0 - smoothstep(yEnd - aa, yEnd + aa, s.y));
    // 尺边的墨很匀，只有极细的一点墨量起伏
    float dd = uDam2.y * (0.965 + 0.035 * vn(vec2(s.x * 0.7, s.y * 0.05)));
    T *= 1.0 - cov * dd;
  }
  vec3 col = inkOnPaper(paper, T);
  // 朱砂：矿物颜料，浓处发暗、淡处带点粉
  vec3 cin = ${v3(PALETTE.cinnabar)};
  vec3 redCol = mix(mix(paper, cin, 0.75), cin * 0.82, smoothstep(0.55, 1.0, red));
  col = mix(col, redCol * (0.96 + 0.08 * fib), clamp(red * 1.1, 0.0, 1.0));
  col = col * (1.0 - over.a) + over.rgb;
  gl_FragColor = vec4(srgb2lin(col), 1.0);
}
`;
  const U = {
    uPaper: { value: o.paper }, uPaperSize: { value: new THREE.Vector2(o.PW, o.PH) },
    uTileW: { value: o.tileW }, uPad: { value: o.pad }, uHS: { value: o.HS }, uLen: { value: o.LEN }, uMount: { value: o.mount },
    uCam: { value: new THREE.Vector3(0, 0, 1) }, uFarOff: { value: 0 }, uTime: { value: 0 }, uFarK: { value: 1 },
    uSR: { value: Array.from({ length: NSPR }, () => new THREE.Vector4()) },
    uSP: { value: Array.from({ length: NSPR }, () => new THREE.Vector4()) },
    uSQ: { value: Array.from({ length: NSPR }, () => new THREE.Vector4()) },
    uFishTex: { value: o.fishTex }, uFishTexSize: { value: new THREE.Vector2(o.fishW, o.fishH) },
    uFA: { value: Array.from({ length: NFISH }, () => new THREE.Vector4()) },
    uFB: { value: Array.from({ length: NFISH }, () => new THREE.Vector4()) },
    uFC: { value: Array.from({ length: NFISH }, () => new THREE.Vector4()) },
    uFD: { value: Array.from({ length: NFISH }, () => new THREE.Vector4()) },
    uFN: { value: 0 },
    uDam: { value: new THREE.Vector4() }, uDam2: { value: new THREE.Vector4(16, 0.97, 0, 0) },
  };
  for (let i = 0; i < NTILE; i++) U[`uT${i}`] = { value: o.tiles[Math.min(i, o.tiles.length - 1)] };
  for (let i = 0; i < NSPR; i++) U[`uS${i}`] = { value: o.blank };
  return new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms: U, depthTest: false, depthWrite: false });
}

/** 运动模糊（水平），带一点「墨的拖影」：暗处拖得更长 */
export function makeBlurMaterial(THREE) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D uSrc; uniform float uLen; varying vec2 vUv;
      void main() {
        vec3 acc = vec3(0.0); float wsum = 0.0; vec3 mn = vec3(1e3);
        for (int i = 0; i < 48; i++) {
          float u = (float(i) + 0.5) / 48.0;
          float w = exp(-u * 2.2);
          vec3 c = texture2D(uSrc, vUv + vec2(u * uLen / 1920.0, 0.0)).rgb;
          acc += c * w; wsum += w; mn = min(mn, c);
        }
        vec3 avg = acc / wsum;
        // 墨的拖影：往最暗值靠一点，像湿墨被拖出一道
        vec3 col = mix(avg, mn, 0.18 * smoothstep(40.0, 260.0, abs(uLen)));
        gl_FragColor = vec4(col, 1.0);
      }`,
    uniforms: { uSrc: { value: null }, uLen: { value: 0 } },
    depthTest: false, depthWrite: false,
  });
}
