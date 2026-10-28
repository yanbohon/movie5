// 电影引擎：给定时间 t，确定性地渲染出这一帧。实时播放和逐帧导出走同一条路径。
import * as THREE from 'three';
import p5 from 'p5';
import { Post, DEFAULT_POST } from './post.js';
import { clamp, smooth, lerp } from './util.js';
import timeline from '../../script/timeline.json';
import dialogue from '../data/dialogue.json';

export const W = 1920, H = 1080, FPS = timeline.fps || 30;

export const FONTS = {
  sans: 'FilmSans', serif: 'FilmSerif', kai: 'FilmKai', mono: 'FilmMono',
};

// 全片 2.39:1 宽银幕（上下黑边各约 138 px，字幕放在下黑边里）
export const ASPECT = timeline.aspect || 2.39;
export const BAR = Math.round((H - W / ASPECT) / 2);
export function aspectAt() { return ASPECT; }

// 字幕颜色：她（暖白）、老鲟（冷灰蓝）、岸上的人（淡旧黄）
const SUB_COLOR = { HER: [236, 230, 218], OLD: [176, 194, 204], F1: [226, 206, 160], F2: [226, 206, 160],
  R1: [226, 206, 160], B1: [226, 206, 160], B2: [226, 206, 160] };

export class Film {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = W; canvas.height = H;
    const renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, preserveDrawingBuffer: true,
      powerPreference: 'high-performance', stencil: false,
    });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // 最终的 sRGB 在合成着色器里手动做
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.autoClear = true;
    this.renderer = renderer;
    const mk = () => new THREE.WebGLRenderTarget(W, H, {
      type: THREE.HalfFloatType, samples: 4, depthBuffer: true,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.hdrA = mk();
    this.hdrB = mk();
    this.post = new Post(renderer, W, H);
    this.scenes = [];
    this.frame = 0;
    this.lastT = -1;

    // 两场景交叠时的混合材质
    this.mixMat = new THREE.ShaderMaterial({
      vertexShader: `varying vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy,0.,1.); }`,
      fragmentShader: `
        uniform sampler2D a; uniform sampler2D b; uniform float k; uniform float mode; varying vec2 vUv;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
        float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
          return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
        void main(){
          vec3 A = texture2D(a, vUv).rgb, B = texture2D(b, vUv).rgb;
          float w = k;
          if (mode > 0.5) { // 噪声溶解
            float n = vn(vUv*vec2(9.0,5.0))*0.6 + vn(vUv*vec2(31.0,17.0))*0.4;
            w = smoothstep(n - 0.12, n + 0.12, k * 1.24 - 0.12);
          }
          gl_FragColor = vec4(mix(A, B, w), 1.0);
        }`,
      uniforms: { a: { value: null }, b: { value: null }, k: { value: 0 }, mode: { value: 0 } },
      depthTest: false, depthWrite: false,
    });
    this.copyMat = new THREE.ShaderMaterial({
      vertexShader: `varying vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy,0.,1.); }`,
      fragmentShader: `uniform sampler2D a; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(a, vUv).rgb, 1.0); }`,
      uniforms: { a: { value: null } }, depthTest: false, depthWrite: false,
    });
    this.hdrC = mk();
  }

  async initP5() {
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;left:-99999px;top:0;width:10px;height:10px;overflow:hidden;';
    document.body.appendChild(holder);
    await new Promise((resolve) => {
      this.p = new p5((p) => {
        p.setup = () => {
          p.createCanvas(8, 8);
          p.pixelDensity(1);
          p.noLoop();
          resolve();
        };
      }, holder);
    });
    this.ov = this.makeLayer(W, H);
  }

  /** 创建一块 p5 画布并包成 three 纹理（colorSpace: 'srgb' 表示当颜色图用） */
  makeLayer(w, h, { srgb = false, premult = true } = {}) {
    const g = this.p.createGraphics(w, h);
    g.pixelDensity(1);
    const tex = new THREE.CanvasTexture(g.elt);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.premultiplyAlpha = premult;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    return { g, tex, ctx: g.drawingContext, w, h };
  }

  async load(factories, onProgress) {
    await this.initP5();
    this.ctx = this.makeContext();
    let i = 0;
    for (const f of factories) {
      const s = await f(this.ctx);
      this.scenes.push(s);
      i++;
      onProgress && onProgress(i / factories.length, s.id);
    }
    // 预热：每个场景各渲染一帧，让着色器提前编译，避免播放时卡顿
    for (const s of this.scenes) {
      try { this.renderAt(s.start + 0.01); } catch (e) { console.error('warmup', s.id, e); }
    }
  }

  makeContext() {
    const film = this;
    const ctx = {
      THREE, W, H, FPS, FONTS, timeline, dialogue: dialogue.lines,
      renderer: this.renderer, post: this.post, p: this.p, film,
      target: null,
      layer: (w, h, o) => film.makeLayer(w, h, o),
      /** 把 three 场景渲染到当前目标 */
      draw(scene, camera, { clear = true, target } = {}) {
        const r = film.renderer;
        r.setRenderTarget(target || ctx.target);
        r.autoClear = clear;
        r.render(scene, camera);
        r.autoClear = true;
      },
      /** 全屏画一个材质（2D 场景、特效） */
      blit(material, target) {
        film.post.blit(material, target || ctx.target);
      },
      /** 找台词 */
      line(id) { return dialogue.lines.find((l) => l.id === id); },
      /** 卡点时间：ctx.mark('s1_river.ship_pass')，找不到直接抛错（避免静默写错名字） */
      mark(id) {
        const m = timeline.marks.find((x) => x.id === id);
        if (!m) throw new Error(`no mark ${id}`);
        return m.t;
      },
      /** 场景起止：ctx.sceneSpan('s1_river') → {start, end} */
      sceneSpan(id) { return timeline.scenes.find((x) => x.id === id); },
      /** 台词在时间 t 的说话进度（0..1），没开始为负，结束后 >1 */
      lineProgress(id, t) { const l = ctx.line(id); return (t - l.t) / l.dur; },
      /** 新建一个全屏 HDR 目标（场景内部多通道用） */
      makeTarget(w = W, h = H, opts = {}) {
        return new THREE.WebGLRenderTarget(w, h, {
          type: THREE.HalfFloatType, samples: opts.samples ?? 0, depthBuffer: opts.depth ?? true,
          minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        });
      },
    };
    return ctx;
  }

  activeScenes(t) {
    return this.scenes.filter((s) => t >= s.start - (s.pre || 0) && t < s.end + (s.post || 0));
  }

  /** 渲染时间 t 的一帧到画布；subs=false 不画字幕（场景初始化时拿别的场景当素材用） */
  renderAt(t, { subs = true } = {}) {
    const ctx = this.ctx;
    ctx.t = t;
    ctx.frame = Math.round(t * FPS);
    const ov = this.ov;
    ov.g.clear();
    const act = this.activeScenes(t);
    let postParams = { ...DEFAULT_POST };
    let hdr = this.hdrA;
    if (act.length === 0) {
      this.renderer.setRenderTarget(this.hdrA);
      this.renderer.setClearColor(0x000000, 1);
      this.renderer.clear();
    } else if (act.length === 1) {
      ctx.target = this.hdrA;
      this.renderer.setRenderTarget(this.hdrA);
      this.renderer.setClearColor(0x000000, 1);
      this.renderer.clear();
      act[0].render(t, ctx);
      postParams = { ...postParams, ...(act[0].postFx ? act[0].postFx(t) : {}) };
    } else {
      // 两个场景交叠：后开始的是进入方，按它的 enter(t) 混合
      const [a, b] = act.sort((x, y) => x.start - y.start);
      ctx.target = this.hdrA;
      this.renderer.setRenderTarget(this.hdrA); this.renderer.setClearColor(0, 1); this.renderer.clear();
      a.render(t, ctx);
      ctx.target = this.hdrB;
      ctx.under = this.hdrA.texture; // 进入方可以拿到退出方这一帧的画面（比如把上一场缩成剪辑时间线上的一个片段）
      this.renderer.setRenderTarget(this.hdrB); this.renderer.setClearColor(0, 1); this.renderer.clear();
      b.render(t, ctx);
      ctx.under = null;
      const k = b.enter ? clamp(b.enter(t)) : smooth((t - b.start + (b.pre || 0)) / Math.max(0.001, b.pre || 0.001));
      this.mixMat.uniforms.a.value = this.hdrA.texture;
      this.mixMat.uniforms.b.value = this.hdrB.texture;
      this.mixMat.uniforms.k.value = k;
      this.mixMat.uniforms.mode.value = b.enterMode === 'dissolve' ? 1 : 0;
      this.post.blit(this.mixMat, this.hdrC);
      hdr = this.hdrC;
      const pa = a.postFx ? a.postFx(t) : {}, pb = b.postFx ? b.postFx(t) : {};
      postParams = mixPost({ ...DEFAULT_POST, ...pa }, { ...DEFAULT_POST, ...pb }, k);
    }
    if (subs) this.drawSubtitles(t, act);
    ov.tex.needsUpdate = true;
    this.post.composite(hdr, ov.tex, postParams, aspectAt(t), ctx.frame, null);
    this.lastT = t;
  }

  drawSubtitles(t, act) {
    if (act.some((s) => s.noSubtitles && s.noSubtitles(t))) return;
    const styler = act.find((s) => s.subStyle);
    const style = styler ? styler.subStyle(t) : null;
    const c = this.ov.ctx;
    const r = aspectAt(t);
    const barH = r > W / H ? (H - W / r) / 2 : 0;
    for (const l of dialogue.lines) {
      const a = t - l.t, b = l.t + l.dur + 0.45 - t;
      if (a < -0.08 || b < 0) continue;
      const alpha = clamp((a + 0.08) / 0.22) * clamp(b / 0.3);
      const col = SUB_COLOR[l.who] || SUB_COLOR.HER;
      const y = barH > 60 ? H - barH / 2 + 3 : H - 78;
      c.save();
      c.font = `400 34px ${FONTS.serif}`;
      c.letterSpacing = '3px';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.globalAlpha = alpha;
      if (barH <= 60) { c.shadowColor = style?.shadow || 'rgba(0,0,0,0.75)'; c.shadowBlur = 14; }
      c.fillStyle = style?.fill || `rgb(${col[0]},${col[1]},${col[2]})`;
      c.fillText(l.text, W / 2, y);
      c.restore();
    }
  }
}

function mixPost(a, b, k) {
  const o = {};
  for (const key of Object.keys(a)) {
    const va = a[key], vb = b[key];
    if (Array.isArray(va)) o[key] = va.map((x, i) => lerp(x, vb[i], k));
    else o[key] = lerp(va, vb, k);
  }
  return o;
}
