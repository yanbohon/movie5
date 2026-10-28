// 后期管线：HDR 场景 → 物理式泛光（13 抽样降采样 + 帐篷升采样）→ 合成（色调映射、调色、暗角、色散、颗粒、遮幅、叠加层、抖动）
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const DOWN = /* glsl */ `
uniform sampler2D src; uniform vec2 texel; uniform float firstPass; uniform float threshold; uniform float knee;
varying vec2 vUv;
vec3 S(vec2 o) { return texture2D(src, vUv + texel * o).rgb; }
void main() {
  vec3 a = S(vec2(-2., 2.)), b = S(vec2(0., 2.)), c = S(vec2(2., 2.));
  vec3 d = S(vec2(-2., 0.)), e = S(vec2(0., 0.)), f = S(vec2(2., 0.));
  vec3 g = S(vec2(-2., -2.)), h = S(vec2(0., -2.)), i = S(vec2(2., -2.));
  vec3 j = S(vec2(-1., 1.)), k = S(vec2(1., 1.)), l = S(vec2(-1., -1.)), m = S(vec2(1., -1.));
  vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  if (firstPass > 0.5) {
    col = min(col, vec3(64.0));
    float br = max(col.r, max(col.g, col.b));
    float soft = clamp(br - threshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    col *= max(soft, br - threshold) / max(br, 1e-4);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

const UP = /* glsl */ `
uniform sampler2D src; uniform vec2 texel; uniform float radius;
varying vec2 vUv;
vec3 S(vec2 o) { return texture2D(src, vUv + texel * radius * o).rgb; }
void main() {
  vec3 s = S(vec2(-1., 1.)) + S(vec2(1., 1.)) + S(vec2(-1., -1.)) + S(vec2(1., -1.));
  s += 2.0 * (S(vec2(0., 1.)) + S(vec2(-1., 0.)) + S(vec2(1., 0.)) + S(vec2(0., -1.)));
  s += 4.0 * S(vec2(0.));
  gl_FragColor = vec4(s / 16.0, 1.0);
}
`;

const COMPOSITE = /* glsl */ `
uniform sampler2D tScene; uniform sampler2D tBloom; uniform sampler2D tOverlay;
uniform float uBloom, uExposure, uToneMix, uSat, uContrast, uVignette, uGrain, uCA, uFade, uFadeWhite;
uniform float uFrame, uFrameAspect, uCanvasAspect, uOverlayOn, uHalation;
uniform vec3 uLift, uGamma, uGain, uTint;
uniform vec2 uRes;
varying vec2 vUv;

vec3 aces(vec3 x) {
  // Narkowicz ACES 近似，再轻微压一下高光饱和
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 uv = vUv;
  vec2 dir = uv - 0.5;
  vec3 col;
  if (uCA > 0.0) {
    col.r = texture2D(tScene, uv - dir * uCA).r;
    col.g = texture2D(tScene, uv).g;
    col.b = texture2D(tScene, uv + dir * uCA).b;
  } else {
    col = texture2D(tScene, uv).rgb;
  }
  vec3 bloom = texture2D(tBloom, uv).rgb;
  col += bloom * uBloom;
  // 胶片光晕：泛光里的红通道外溢一点
  col += bloom * vec3(0.35, 0.08, 0.02) * uHalation;
  col *= uExposure;
  col = mix(clamp(col, 0.0, 1.0), aces(col), uToneMix);
  vec3 g = toSRGB(col);
  // 调色（显示空间里做，直觉可控）
  g = (g - 0.5) * uContrast + 0.5;
  float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
  g = mix(vec3(l), g, uSat);
  g = pow(max(g * uGain + uLift * (1.0 - g), 0.0), 1.0 / max(uGamma, vec3(0.01)));
  g *= uTint;
  // 遮幅区域（先算，暗角也按有效画面算）
  vec2 halfSize = vec2(0.5);
  if (uFrameAspect > uCanvasAspect) halfSize.y = 0.5 * uCanvasAspect / uFrameAspect;
  else halfSize.x = 0.5 * uFrameAspect / uCanvasAspect;
  vec2 fuv = (uv - 0.5) / (2.0 * halfSize);
  // 暗角
  float vr = length(fuv * vec2(1.0, 0.9));
  g *= mix(1.0, 1.0 - smoothstep(0.32, 0.9, vr), uVignette);
  // 颗粒（亮部弱、暗部强）
  float n = hash12(uv * uRes + fract(uFrame * 0.6180339) * 1000.0) - 0.5;
  float n2 = hash12(uv * uRes * 0.5 + fract(uFrame * 0.7548776) * 777.0) - 0.5;
  float lum = dot(g, vec3(0.299, 0.587, 0.114));
  g += (n * 0.7 + n2 * 0.5) * uGrain * (1.1 - lum * 0.8);
  // 遮幅
  vec2 d2 = abs(uv - 0.5) - halfSize;
  float inside = (1.0 - smoothstep(-0.5 / uRes.x, 0.5 / uRes.x, d2.x)) * (1.0 - smoothstep(-0.5 / uRes.y, 0.5 / uRes.y, d2.y));
  g *= inside;
  g = mix(g, vec3(0.0), uFade);
  g = mix(g, vec3(1.0), uFadeWhite * inside); // 白闪不染黑边
  // 叠加层（字幕、标题等，不参与调色）
  if (uOverlayOn > 0.5) {
    vec4 ov = texture2D(tOverlay, uv);
    g = g * (1.0 - ov.a) + ov.rgb;
  }
  g += (hash12(uv * uRes + 17.0 + uFrame) - 0.5) / 255.0;
  gl_FragColor = vec4(g, 1.0);
}
`;

export const DEFAULT_POST = {
  bloom: 0.9, bloomThreshold: 0.9, bloomKnee: 0.5, bloomRadius: 1.0,
  exposure: 1.0, toneMix: 1.0, sat: 1.0, contrast: 1.0,
  lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], tint: [1, 1, 1],
  vignette: 0.35, grain: 0.035, ca: 0.0, halation: 0.0,
  fade: 0, fadeWhite: 0,
};

export class Post {
  constructor(renderer, W, H) {
    this.renderer = renderer;
    this.W = W; this.H = H;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mesh = new THREE.Mesh(geo, null);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);

    this.mips = [];
    let w = W, h = H;
    for (let i = 0; i < 7; i++) {
      w = Math.max(2, Math.floor(w / 2)); h = Math.max(2, Math.floor(h / 2));
      this.mips.push(new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false,
      }));
    }
    this.down = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: DOWN, depthTest: false, depthWrite: false,
      uniforms: { src: { value: null }, texel: { value: new THREE.Vector2() }, firstPass: { value: 0 }, threshold: { value: 1 }, knee: { value: 0.5 } },
    });
    this.up = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: UP, depthTest: false, depthWrite: false,
      blending: THREE.AdditiveBlending, transparent: true,
      uniforms: { src: { value: null }, texel: { value: new THREE.Vector2() }, radius: { value: 1 } },
    });
    this.comp = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COMPOSITE, depthTest: false, depthWrite: false,
      uniforms: {
        tScene: { value: null }, tBloom: { value: null }, tOverlay: { value: null },
        uBloom: { value: 1 }, uExposure: { value: 1 }, uToneMix: { value: 1 }, uSat: { value: 1 }, uContrast: { value: 1 },
        uVignette: { value: 0.3 }, uGrain: { value: 0.03 }, uCA: { value: 0 }, uFade: { value: 0 }, uFadeWhite: { value: 0 },
        uFrame: { value: 0 }, uFrameAspect: { value: 16 / 9 }, uCanvasAspect: { value: W / H }, uOverlayOn: { value: 1 },
        uHalation: { value: 0 },
        uLift: { value: new THREE.Vector3() }, uGamma: { value: new THREE.Vector3(1, 1, 1) }, uGain: { value: new THREE.Vector3(1, 1, 1) },
        uTint: { value: new THREE.Vector3(1, 1, 1) }, uRes: { value: new THREE.Vector2(W, H) },
      },
    });
  }

  pass(material, target) {
    this.mesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
  }

  /** 全屏画一个材质到目标（场景也可以借用） */
  blit(material, target) { this.pass(material, target); }

  bloom(src, p) {
    const r = this.renderer;
    const prevAuto = r.autoClear;
    let input = src.texture, iw = src.width, ih = src.height;
    for (let i = 0; i < this.mips.length; i++) {
      const u = this.down.uniforms;
      u.src.value = input; u.texel.value.set(1 / iw, 1 / ih);
      u.firstPass.value = i === 0 ? 1 : 0; u.threshold.value = p.bloomThreshold; u.knee.value = p.bloomKnee;
      r.autoClear = true;
      this.pass(this.down, this.mips[i]);
      input = this.mips[i].texture; iw = this.mips[i].width; ih = this.mips[i].height;
    }
    r.autoClear = false;
    for (let i = this.mips.length - 1; i > 0; i--) {
      const u = this.up.uniforms;
      u.src.value = this.mips[i].texture; u.texel.value.set(1 / this.mips[i].width, 1 / this.mips[i].height);
      u.radius.value = p.bloomRadius;
      this.pass(this.up, this.mips[i - 1]);
    }
    r.autoClear = prevAuto;
    return this.mips[0].texture;
  }

  composite(hdr, overlayTex, p, frameAspect, frame, target = null) {
    const bloomTex = p.bloom > 0 ? this.bloom(hdr, p) : this.mips[0].texture;
    const u = this.comp.uniforms;
    u.tScene.value = hdr.texture; u.tBloom.value = bloomTex; u.tOverlay.value = overlayTex;
    u.uOverlayOn.value = overlayTex ? 1 : 0;
    u.uBloom.value = p.bloom; u.uExposure.value = p.exposure; u.uToneMix.value = p.toneMix;
    u.uSat.value = p.sat; u.uContrast.value = p.contrast; u.uVignette.value = p.vignette; u.uGrain.value = p.grain;
    u.uCA.value = p.ca; u.uFade.value = p.fade; u.uFadeWhite.value = p.fadeWhite; u.uHalation.value = p.halation;
    u.uLift.value.fromArray(p.lift); u.uGamma.value.fromArray(p.gamma); u.uGain.value.fromArray(p.gain); u.uTint.value.fromArray(p.tint);
    u.uFrame.value = frame; u.uFrameAspect.value = frameAspect;
    this.renderer.autoClear = true;
    this.pass(this.comp, target);
  }
}
