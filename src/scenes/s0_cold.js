// S0 冷开场（0–31 s）：黑 → 地点字卡 → 黑水里的悬浮泥沙 → 三句台词 → 光写出的「鲔」→ 光碎成泥沙被水流带走，融进浑黄
// 负责：子代理 B。全部时刻从 src/scenes/s0_cold/events.js（timeline 卡点）来。
import { writeText, prepareText, loadGlyphs, textRun, textLayout } from '../film/brush.js';
import { PALETTE } from '../film/paper.js';
import { clamp, sstep, win, fbm2, mulberry32, smooth } from '../film/util.js';
import { timing, TITLE, SUBTITLE, CARD } from './s0_cold/events.js';
import { makeAmbient, makeDust, CAM_Z } from './s0_cold/particles.js';
import { brushDemo } from './s0_cold/brush_demo.js';

// 片名：字框 540 px，画面正中略偏上，下面留出副标题
const TS = 540;
const TBOX = { x: 960 - 272, y: 236 };
const TPAD = 90;                  // 片名画布四周留给辉光
const TW = TS + TPAD * 2;          // 片名画布边长
const GLOW = { mode: 'glow', size: TS, wet: 0.4, dry: 0.58, seed: 17 };

// 开发用：--scenes s0_cold,timing 时在控制台打印建场景耗时与单帧耗时（含 GPU 同步）
const devFlag = (name) => typeof location !== 'undefined' && new RegExp(`(?:^|[,=])${name}(?:,|&|$)`).test(decodeURIComponent(location.search));

export default async function (ctx) {
  if (devFlag('brushdemo')) return brushDemo(ctx);
  const DBG = devFlag('timing');
  const tBuild = performance.now();
  const { THREE, W, H } = ctx;
  const T = timing(ctx.timeline);
  await loadGlyphs(TITLE);

  // ---------- 片名：光写的字（Canvas2D → 纹理 → HDR）----------
  const L = ctx.layer(TW, TW, { srgb: false, premult: false });
  const gOpts = { ...GLOW, x: TPAD, y: TPAD };
  prepareText(TITLE, gOpts);
  const rect = { x: TBOX.x - TPAD, y: TBOX.y - TPAD };

  // 溶解前沿：从上游（左）往下游（右）一片片剥落，边缘参差（片名遮罩和颗粒脱落用同一张表）
  const FN = 128;
  const front = new Float32Array(FN * FN);
  {
    const box = textLayout(TITLE, gOpts)[0];
    const gx0 = box.x + TS * 0.08, gx1 = box.x + TS * 0.94;
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < FN; j++) for (let i = 0; i < FN; i++) {
      const x = ((i + 0.5) / FN) * TW, y = ((j + 0.5) / FN) * TW;
      const xn = (x - gx0) / (gx1 - gx0);
      const v = 0.66 * xn + 0.24 * fbm2(x / 150 + 3.1, y / 150 - 7.7, 3) + 0.1 * fbm2(x / 40 + 11, y / 40 + 5, 2) - 0.05 * (y / TW);
      front[j * FN + i] = v;
      if (x > gx0 && x < gx1) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
    for (let q = 0; q < front.length; q++) front[q] = clamp((front[q] - lo) / (hi - lo));
  }
  const frontAt = (x, y) => { // 片名画布像素坐标 → 0..1（双线性，和 GPU 采样一致）
    const fx = clamp(x / TW) * FN - 0.5, fy = clamp(y / TW) * FN - 0.5;
    const i0 = Math.max(0, Math.min(FN - 1, Math.floor(fx))), j0 = Math.max(0, Math.min(FN - 1, Math.floor(fy)));
    const i1 = Math.min(FN - 1, i0 + 1), j1 = Math.min(FN - 1, j0 + 1);
    const ax = clamp(fx - i0), ay = clamp(fy - j0);
    const a = front[j0 * FN + i0], b = front[j0 * FN + i1], c = front[j1 * FN + i0], d = front[j1 * FN + i1];
    return a + (b - a) * ax + (c - a) * ay + (a - b - c + d) * ax * ay;
  };
  const frontTex = new THREE.DataTexture(front, FN, FN, THREE.RedFormat, THREE.FloatType);
  frontTex.minFilter = THREE.LinearFilter; frontTex.magFilter = THREE.LinearFilter;
  frontTex.needsUpdate = true;

  // 颗粒的出生点：从片名每一笔的光强里按亮度抽样
  const samples = [];
  {
    const run = textRun(TITLE, gOpts);
    const box = textLayout(TITLE, gOpts)[0];
    const rnd = mulberry32(4242);
    let total = 0;
    run.apps.forEach((app) => { for (let p = 0; p < app.core.length; p++) total += Math.min(1, app.core[p]); });
    const want = 70000, k = want / Math.max(1, total);
    run.geos.forEach((geo, s) => {
      const core = run.apps[s].core;
      for (let y = 0; y < geo.bh; y++) for (let x = 0; x < geo.bw; x++) {
        const v = core[y * geo.bw + x];
        if (v < 0.04) continue;
        if (rnd() > Math.min(1, v) * k) continue;
        const cx = box.x + geo.bx + x + rnd(), cy = box.y + geo.by + y + rnd();
        samples.push({ x: rect.x + cx, y: rect.y + cy, b: 0.2 + 0.8 * Math.min(1, v), f: frontAt(cx, cy) });
      }
    });
  }

  const titleMat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy,0.,1.); }',
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex; uniform sampler2D uFront;
      uniform vec4 uRect; uniform float uT, uD0, uDD, uGain, uOn, uHaze, uWarm, uBreath;
      varying vec2 vUv;
      float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
      void main(){
        vec2 px = vec2(vUv.x * 1920.0, (1.0 - vUv.y) * 1080.0);
        vec3 col = vec3(0.0);
        // 水里的一点点暗光：大尺度的浑浊起伏，上面稍亮（光从水面来），慢慢漂
        float n = vn(px / 520.0 + vec2(uT * 0.025, uT * 0.006)) * 0.6 + vn(px / 190.0 - vec2(uT * 0.04, 0.0)) * 0.4;
        float top = 1.0 - smoothstep(0.0, 1080.0, px.y) * 0.55;
        vec3 murk = mix(vec3(0.55, 0.62, 0.66), vec3(1.0, 0.78, 0.42), uWarm);
        col += murk * uHaze * (0.45 + 0.9 * n) * top * uBreath;
        if (uOn > 0.0) {
          vec2 tuv = (px - uRect.xy) / uRect.zw;
          if (tuv.x >= 0.0 && tuv.x <= 1.0 && tuv.y >= 0.0 && tuv.y <= 1.0) {
            vec3 g = texture2D(uTex, vec2(tuv.x, 1.0 - tuv.y)).rgb;
            vec3 lin = pow(g, vec3(2.2));
            float f = texture2D(uFront, tuv).r;
            float tr = uD0 + f * uDD;
            float alive = 1.0 - smoothstep(tr - 0.12, tr + 0.06, uT);
            float flare = exp(-pow((uT - tr + 0.1) / 0.1, 2.0));
            col += lin * uGain * (alive + 0.9 * flare);
          }
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
    uniforms: {
      uTex: { value: L.tex }, uFront: { value: frontTex },
      uRect: { value: new THREE.Vector4(rect.x, rect.y, TW, TW) },
      uT: { value: 0 }, uD0: { value: T.dissolve }, uDD: { value: T.dissolveDur },
      uGain: { value: 1.85 }, uOn: { value: 0 }, uHaze: { value: 0 }, uWarm: { value: 0 }, uBreath: { value: 1 },
    },
    depthTest: false, depthWrite: false,
  });

  // ---------- 颗粒 ----------
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera((2 * Math.atan(540 / CAM_Z) * 180) / Math.PI, W / H, 10, 12000);
  cam.position.set(0, 0, CAM_Z);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  const amb = makeAmbient(THREE, { count: 2400, seed: 5 });
  const dust = makeDust(THREE, samples, { t0: T.dissolve, dur: T.dissolveDur, seed: 9 });
  scene.add(amb.points, dust.points);

  // 片名画布：内容只随书写变化，写完（光也凉了）之后就不再变
  let lastKey = null;
  const settleT = T.write + T.dur + 1.0;
  let lastTip = null;
  function drawTitle(t) {
    const key = t >= settleT ? 'settled' : t < T.write ? 'none' : t.toFixed(4);
    if (key === lastKey) return lastTip;
    const c = L.ctx;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = '#000';
    c.fillRect(0, 0, TW, TW);
    c.restore();
    let tip = null;
    if (key !== 'none') {
      const r = writeText(c, TITLE, { ...gOpts, t: key === 'settled' ? settleT + 10 : t, t0: T.write, dur: T.dur });
      tip = r.tip;
    }
    L.tex.needsUpdate = true;
    lastKey = key; lastTip = tip;
    return tip;
  }

  const u = titleMat.uniforms;
  if (DBG) console.log(`[dbg] s0_cold build ${(performance.now() - tBuild).toFixed(0)} ms, ${samples.length} dust`);
  const scene0 = {
    id: 's0_cold', start: T.start, end: T.end,
    render(t, ctx) {
      // ---- 片名 ----
      const titleOn = t >= T.write && t < T.end;
      let tip = null;
      if (titleOn) tip = drawTitle(t);
      u.uT.value = t;
      u.uOn.value = titleOn ? 1 : 0;
      // 写完以后光轻轻呼吸
      const breatheG = 1 + 0.05 * Math.sin((t - T.hold) * 1.7) * sstep(T.write + T.dur, T.hold + 0.5, t);
      u.uGain.value = 1.85 * breatheG;
      // 水的暗光：颗粒出来以后才有，台词期间像呼吸一样起伏；碎散时转暖、变成浑黄
      const amb0 = sstep(T.particlesIn, T.particlesIn + 5, t);
      const breath = 1 + 0.22 * Math.sin(((t - T.particlesIn) / 6.4) * Math.PI * 2) * sstep(T.particlesIn + 2, T.particlesIn + 5, t) * (1 - sstep(T.write - 1, T.write, t));
      const warm = sstep(T.dissolve + 0.2, T.end - 0.6, t);
      const endDim = 1 - 0.35 * sstep(T.end - 0.7, T.end, t);
      u.uHaze.value = (0.005 * amb0 + 0.012 * warm) * endDim;
      u.uWarm.value = warm;
      u.uBreath.value = breath;
      ctx.blit(titleMat);

      // ---- 颗粒 ----
      const au = amb.mat.uniforms;
      au.uT.value = t; au.uTin.value = T.particlesIn;
      au.uAmp.value = 0.16 * amb0 * (1 + 0.5 * warm) * endDim;
      au.uBreath.value = breath;
      au.uWarm.value = warm;
      // 片名的光照亮周围的泥沙：笔尖是移动的光源，整个字是一团柔光
      const writing = t >= T.write && t < T.write + T.dur;
      if (tip && writing) au.uTip.value.set(rect.x + tip.x - W / 2, H / 2 - (rect.y + tip.y), 0.3);
      else au.uTip.value.set(0, 0, 0);
      const glyphLight = 0.06 * sstep(T.write, T.write + T.dur, t) * (1 - sstep(T.dissolve, T.dissolve + T.dissolveDur, t));
      au.uGlyph.value.set(TBOX.x + TS / 2 - W / 2, H / 2 - (TBOX.y + TS * 0.49), glyphLight);
      const du = dust.mat.uniforms;
      du.uT.value = t;
      du.uAmp.value = 0.55;
      du.uFade.value = 1 - 0.55 * sstep(T.dissolve + T.dissolveDur, T.end, t);
      dust.points.visible = t >= T.dissolve - 0.3;
      ctx.draw(scene, cam, { clear: false });

      // ---- 叠加层：地点字卡、副标题 ----
      const c = ctx.film.ov.ctx;
      const aCard = win(t, T.cardIn, T.cardIn + 1.5, T.cardOut, T.cardOut + 1.3);
      if (aCard > 0.001) {
        c.save();
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillStyle = `rgba(189,182,168,${aCard})`;
        c.font = `300 40px ${ctx.FONTS.serif}`;
        c.letterSpacing = '14px';
        c.fillText(CARD[0], W / 2 + 7, 585);
        c.font = `300 27px ${ctx.FONTS.serif}`;
        c.letterSpacing = '9px';
        c.fillStyle = `rgba(189,182,168,${aCard * 0.82})`;
        c.fillText(CARD[1], W / 2 + 4.5, 646);
        c.restore();
      }
      const aSub = win(t, T.subIn, T.subIn + 1.4, T.subOut, T.subOut + 1.0);
      if (aSub > 0.001) {
        c.save();
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.font = `300 30px ${ctx.FONTS.serif}`;
        c.letterSpacing = '18px';
        c.fillStyle = `rgba(196,210,216,${aSub * 0.8})`;
        c.fillText(SUBTITLE, W / 2 + 9, 830);
        c.restore();
      }
    },
    postFx(t) {
      const glow = sstep(T.write - 0.5, T.write + 0.5, t);
      return {
        bloom: 0.35 + 0.4 * glow, bloomThreshold: 0.75, bloomKnee: 0.55, bloomRadius: 1.0,
        toneMix: 1, exposure: 1.0, sat: 1.0, contrast: 1.0,
        grain: 0.032, vignette: 0.42, halation: 0.0,
      };
    },
  };
  if (DBG && !ctx.film.__timed) {
    // 整帧计时（场景 + 字幕 + 后期），读回一个像素逼 GPU 做完
    const film = ctx.film, ra = film.renderAt.bind(film), px = new Uint8Array(4);
    film.__timed = true;
    film.renderAt = (t, o) => {
      const a = performance.now();
      ra(t, o);
      const gl = film.renderer.getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      console.log(`[dbg] frame t=${t.toFixed(2)} ${(performance.now() - a).toFixed(1)} ms`);
    };
  }
  return scene0;
}
