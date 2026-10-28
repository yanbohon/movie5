// S2「长卷」（子代理 A）：一亿五千万年的手卷。92.9–181.5 s。
// 长卷在建场景时一次画进分块纹理（纸 + 远山 / 主墨 / 水纹三个墨量通道），每帧只在着色器里按镜头合成；
// 需要「现场画出来」的元素是带到达时间的精灵（按时间揭示）；书法走 brush.js；鱼是图集里的个体，逐帧游动。
// 时间一律来自 timeline（plan.js / events.js），同一个 t 永远同一帧。
import { makePaperCanvas } from '../film/paper.js';
import { setFiber, InkBuf, packChannel } from '../film/ink.js';
import { loadGlyphs, prepareText, writeText } from '../film/brush.js';
import { makePlan, fishState, HS, MOUNT, X_DAM, DAM_TOP, DAM_W } from './s2_scroll/plan.js';
import { paintStatic, PLATE_FISH } from './s2_scroll/paint.js';
import { buildLive, buildFishAtlas } from './s2_scroll/live.js';
import { makeScrollMaterial, makeBlurMaterial, NSPR, NFISH, NTILE } from './s2_scroll/shader.js';

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };

function paperTexture(THREE, w, h, seed) {
  const { canvas, fiber } = makePaperCanvas(w, h, { seed });
  const pc = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const fc = fiber.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h * 4);
  const fib = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    data[j] = pc[j]; data[j + 1] = pc[j + 1]; data[j + 2] = pc[j + 2]; data[j + 3] = fc[j];
    fib[i] = fc[j];
  }
  const tex = dataTex(THREE, data, w, h, true);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return { tex, fib };
}
function dataTex(THREE, data, w, h, mip = true) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = mip;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export default async function (ctx) {
  const { THREE } = ctx;
  const span = ctx.sceneSpan('s2_scroll');
  const P = makePlan(ctx.timeline);
  const T = P.T, L = P.live;
  const tb = performance.now();
  const lap = (name) => console.log(`[dbg] s2 ${name} ${Math.round(performance.now() - tb)} ms`);

  // ---- 纸 ----
  const PW = 2048, PH = 1024;
  const paper = paperTexture(THREE, PW, PH, 3);
  setFiber(paper.fib, PW, PH);
  lap('paper');

  // ---- 静态长卷：远山 / 主墨 / 水纹，分块打包 ----
  const LEN = P.LEN;
  const nT = Math.min(NTILE, Math.ceil(LEN / 8000));
  const tileW = Math.ceil(LEN / nT), pad = 32, tw = tileW + 2 * pad;
  const tileData = Array.from({ length: nT }, () => new Uint8Array(tw * HS * 4));
  {
    const buf = new InkBuf(LEN, HS);
    const chans = [['far', 0], ['main', 1], ['river', 2], ['mask', 3]];
    for (const [name, c] of chans) {
      if (c > 0) buf.clear();
      paintStatic(P, { far: name === 'far' ? buf : null, main: name === 'main' ? buf : null, river: name === 'river' ? buf : null, mask: name === 'mask' ? buf : null });
      for (let i = 0; i < nT; i++) packChannel(buf, tileData[i], tw, HS, c, i * tileW - pad, 0);
      lap(`static ${name}`);
    }
  }
  const tiles = tileData.map((d) => dataTex(THREE, d, tw, HS, true));

  // ---- 鱼图集、现场精灵 ----
  const fa = buildFishAtlas(P);
  const fishTex = dataTex(THREE, fa.data, fa.W, fa.H, true);
  lap('fish atlas');
  const lives = buildLive(P, ctx.FONTS);
  for (const s of lives) s.tex = dataTex(THREE, s.data, s.w, s.h, s.mode === 4);
  lap('live sprites');

  // ---- 书法：白鲟、象鱼、鲔（brush.js 逐笔书写，画在各自的小画布上）----
  await loadGlyphs('白鲟象鱼鲔');
  const PF = PLATE_FISH;
  const names = [
    { ...L.name1, size: 150, x: PF.x + PF.L + 250, y: 150, seed: 31 },
    { ...L.name2, size: 132, x: PF.x + PF.L + 90, y: 250, seed: 32 },
  ];
  const weiSize = 360;
  const weiW = { ...L.wei, size: weiSize, x: P.X.wei - weiSize / 2, y: 90, seed: 33 };
  const brushSprites = [...names, weiW].map((b) => {
    const pad2 = Math.round(b.size * 0.22);
    const n = [...b.text].length;
    const w = b.size + pad2 * 2, h = Math.round(b.size * (1 + 0.12) * n - b.size * 0.12 + pad2 * 2);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const c2 = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv);
    tex.flipY = false; tex.premultiplyAlpha = false; tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = true;
    const o = { x: pad2, y: pad2, size: b.size, vertical: true, gap: 0.12, t0: b.t0, dur: b.dur, seed: b.seed, wet: 0.55, dry: 0.45 };
    prepareText(b.text, o);
    return { ...b, cv, c2, tex, o, x0: b.x - pad2, y0: b.y - pad2, w, h, drawnAt: null };
  });
  lap('brush');

  // ---- 材质 ----
  const blank = dataTex(THREE, new Uint8Array(4 * 4 * 4).fill(255), 4, 4, false);
  const mat = makeScrollMaterial(THREE, { paper: paper.tex, PW, PH, tiles, tileW, pad, HS, LEN, mount: MOUNT, fishTex, fishW: fa.W, fishH: fa.H, blank });
  const blurMat = makeBlurMaterial(THREE);
  const rt = ctx.makeTarget(ctx.W, ctx.H, { samples: 0, depth: false });
  const U = mat.uniforms;
  lap('built');

  // 预上传纹理，释放 CPU 侧的大数组
  for (const t of [...tiles, fishTex, paper.tex, ...lives.map((s) => s.tex)]) ctx.renderer.initTexture(t);
  for (const t of tiles) t.image.data = null;
  for (const s of lives) { s.data = null; s.tex.image.data = null; }
  fishTex.image.data = null;
  lap('uploaded');

  // ---- 每帧 ----
  function brushFrame(b, t) {
    // 画布是 t 的纯函数：写的过程中每帧重画；写完、墨干之后只画一次终态
    const settled = t > b.t0 + b.dur + 3.6;
    const key = settled ? 'settled' : t;
    if (b.drawnAt === key) return;
    b.c2.setTransform(1, 0, 0, 1, 0, 0);
    b.c2.clearRect(0, 0, b.w, b.h);
    writeText(b.c2, b.text, { ...b.o, t: settled ? b.t0 + b.dur + 100 : t });
    b.tex.needsUpdate = true;
    b.drawnAt = key;
  }
  function render(t, ctx) {
    const cam = P.camera(t);
    U.uCam.value.set(cam.cx, cam.cy, cam.z);
    U.uFarOff.value = P.farOffset(t);
    U.uTime.value = t;
    const halfW = 960 / cam.z + 200, halfH = 540 / cam.z;
    const vx0 = cam.cx - halfW, vx1 = cam.cx + halfW;
    // 精灵
    const cand = [];
    for (const s of lives) {
      if (t < s.show[0] || t > s.show[1]) continue;
      if (s.x0 + s.w < vx0 || s.x0 > vx1) continue;
      if (s.mode !== 4 && t < s.tA - 0.05) continue;
      cand.push(s);
    }
    for (const b of brushSprites) {
      if (t < b.t0 - 0.02) continue;
      if (b.x0 + b.w < vx0 || b.x0 > vx1) continue;
      cand.push(b);
    }
    for (let i = 0; i < NSPR; i++) {
      const s = cand[i];
      const SP = U.uSP.value[i], SR = U.uSR.value[i], SQ = U.uSQ.value[i];
      if (!s) { SP.set(0, 0, 0, 0); continue; }
      SR.set(s.x0, s.y0, s.w, s.h);
      if (s.cv) {
        brushFrame(s, t);
        U[`uS${i}`].value = s.tex;
        SP.set(3, 0, 1, 0);
      } else if (s.mode === 4) {
        U[`uS${i}`].value = s.tex;
        SP.set(4, 0, 1, 0);
        SQ.set(t - s.fade0, s.dmax, s.fadeDur, 0);
      } else {
        U[`uS${i}`].value = s.tex;
        const k = 254 / 255 / (s.tB - s.tA);
        SP.set(s.mode, clamp((t - s.tA) / (s.tB - s.tA)) * 254 / 255, 1, (s.soft ?? 0.07) * k);
        SQ.set(0.25, s.occ ?? 0, 0, 0);
      }
    }
    if (cand.length > NSPR) console.warn('[s2] sprite slots overflow', t, cand.map((s) => s.name || s.text));
    // 鱼
    let nf = 0;
    for (const f of P.fish) {
      if (nf >= NFISH) break;
      const st = fishState(P, f, t);
      if (st.alpha <= 0.001) continue;
      if (st.x + f.L * 1.1 < vx0 || st.x - f.L * 1.1 > vx1) continue;
      const it = fa.map.get(f.id);
      U.uFA.value[nf].set(st.x, st.y, f.dir, f.L);
      U.uFB.value[nf].set(it.u0, it.v0, it.ox, it.oy);
      U.uFC.value[nf].set(it.w, it.h, f.phase, 1);
      U.uFD.value[nf].set(st.swim, 0.55 + (f.id % 5) * 0.06, 1 - st.alpha, 0);
      nf++;
    }
    U.uFN.value = nf;
    // 坝：尺子画的直线，从上往下一口气画到底
    const dk = clamp((t - L.ruler0) / (L.ruler1 - L.ruler0));
    U.uDam.value.set(X_DAM, DAM_TOP, HS + 2, t >= L.ruler0 ? 0.02 + 0.98 * Math.pow(dk, 0.85) : 0);
    U.uDam2.value.set(DAM_W, 0.97, 0, 0);
    void halfH;
    // 运动模糊（回卷掠过时）
    const v = P.screenSpeed(t);
    const blur = -v * (1 / 30) * 0.55;
    if (Math.abs(blur) > 2) {
      ctx.blit(mat, rt);
      blurMat.uniforms.uSrc.value = rt.texture;
      blurMat.uniforms.uLen.value = blur;
      ctx.blit(blurMat);
    } else {
      ctx.blit(mat);
    }
  }

  return {
    id: 's2_scroll', start: span.start, end: span.end,
    render,
    postFx(t) {
      const fade = 1 - smooth((t - span.start) / 1.5);
      return { toneMix: 0, exposure: 1, bloom: 0.06, grain: 0.028, vignette: 0.28, fade };
    },
  };
}
