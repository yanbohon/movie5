// S8 尾声（2D）：宣纸 → 毛笔竖写「有鳣有鲔」→《诗经·周颂·潜》→ 史实字卡 E1…E9 → 一滴水落在「鲔」上把它洗掉 → 淡黑 → 片尾
// 负责：子代理 B。全部时刻从 src/scenes/s8_epilogue/events.js（timeline 卡点）来。
import { writeText, prepareText, loadGlyphs, textLayout } from '../film/brush.js';
import { makePaperCanvas, PALETTE } from '../film/paper.js';
import { clamp, sstep, win } from '../film/util.js';
import { timing, VERSE, VERSE_SRC, CREDITS } from './s8_epilogue/events.js';
import { buildWash, renderWash } from './s8_epilogue/wash.js';

const VS = 144;                                  // 诗句字号（字框）
const VCX = 1540;                                // 诗句这一列的中线（画面右三分之一）
const VOPT = { mode: 'ink', size: VS, wet: 0.5, dry: 0.24, seed: 23, vertical: true, gap: 0.12, charPause: 0.75 };
const INK_CARD = 'rgba(38,34,30,0.9)';
const WN = 340;                                  // 洗字区域边长

function mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

// 开发用：--scenes s8_epilogue,timing 时在控制台打印建场景耗时与单帧耗时（含 GPU 同步）
const devFlag = (name) => typeof location !== 'undefined' && new RegExp(`(?:^|[,=])${name}(?:,|&|$)`).test(decodeURIComponent(location.search));

export default async function (ctx) {
  const DBG = devFlag('timing');
  const tBuild = performance.now();
  const { THREE, W, H, FONTS } = ctx;
  const T = timing(ctx.timeline);
  await loadGlyphs(VERSE);

  // ---------- 纸 ----------
  const L = ctx.layer(W, H, { srgb: true, premult: false });
  const { canvas: paper, fiber } = makePaperCanvas(W, H, { seed: 29, mottle: 0.55, fibers: 0.85, age: 0.1 });

  // ---------- 诗句 ----------
  const colH = VS * 4 + VS * 0.12 * 3;
  const vx = Math.round(VCX - VS / 2), vy = Math.round(540 - colH / 2);
  const vopts = { ...VOPT, x: vx, y: vy };
  prepareText(VERSE, vopts);
  const boxes = textLayout(VERSE, vopts);
  const wb = boxes[3];
  // 写完、干透以后的样子缓存成底图：纸 + 四个字 / 纸 + 前三个字（洗字时用）
  const baseAll = mk(W, H), baseNoWei = mk(W, H);
  {
    const a = baseAll.getContext('2d'); a.drawImage(paper, 0, 0);
    writeText(a, VERSE, { ...vopts, progress: 1 });
    const b = baseNoWei.getContext('2d'); b.drawImage(paper, 0, 0);
    writeText(b, VERSE, { ...vopts, progress: 1, hide: [3] });
  }
  const settleAt = T.write + T.dur + 3.6; // 最后一笔的湿光褪尽

  // ---------- 洗字：落点在「鲔」字中心略偏右下 ----------
  const gcx = wb.x + VS * 0.513 + 5, gcy = wb.y + VS * 0.49 + 13;
  const rx = Math.round(gcx - WN / 2), ry = Math.round(gcy - WN / 2);
  const cx = gcx - rx, cy = gcy - ry;
  let D0, fib;
  {
    const c = mk(WN, WN), g = c.getContext('2d', { willReadFrequently: true });
    writeText(g, VERSE, { ...vopts, x: vx - rx, y: vy - ry, progress: 1, hide: [0, 1, 2] });
    const px = g.getImageData(0, 0, WN, WN).data;
    D0 = new Float32Array(WN * WN);
    for (let p = 0; p < WN * WN; p++) D0[p] = px[p * 4 + 3] / 255;
    const fpx = fiber.getContext('2d').getImageData(rx, ry, WN, WN).data;
    fib = new Float32Array(WN * WN);
    for (let p = 0; p < WN * WN; p++) fib[p] = fpx[p * 4] / 255;
  }
  const t0 = performance.now();
  const sim = buildWash({ D0, fib, N: WN, cx, cy, R: 100, simT: 7.4, fps: 15, seed: 3 });
  if (DBG) console.log(`[dbg] s8 wash sim ${(performance.now() - t0).toFixed(0)} ms, ${sim.frames.length} frames`);
  const bufs = { mul: new ImageData(WN, WN), ink: new ImageData(WN, WN), hi: new ImageData(WN, WN) };
  const cMul = mk(WN, WN), cInk = mk(WN, WN), cHi = mk(WN, WN);
  const xMul = cMul.getContext('2d'), xInk = cInk.getContext('2d'), xHi = cHi.getContext('2d');
  const washEnd = sim.simT + 0.2;
  let washFinal = null; // 洗完、干透后的整张（缓存）

  function drawWash(c, tau) {
    renderWash(sim, tau, bufs, { ink: PALETTE.ink, fib });
    xMul.putImageData(bufs.mul, 0, 0);
    c.save();
    c.globalCompositeOperation = 'multiply';
    c.drawImage(cMul, rx, ry);
    if (tau >= 0) {
      xInk.putImageData(bufs.ink, 0, 0);
      c.globalCompositeOperation = 'source-over';
      c.drawImage(cInk, rx, ry);
      xHi.putImageData(bufs.hi, 0, 0);
      c.globalCompositeOperation = 'lighter';
      c.drawImage(cHi, rx, ry);
    }
    c.restore();
  }

  // ---------- 字 ----------
  const srcChars = Array.from(VERSE_SRC);
  function drawSource(c, a) {
    if (a <= 0.001) return;
    const fs = 30, adv = 35;
    const x = vx - 58, y0 = vy + Math.round(VS * 0.62);
    c.save();
    c.font = `${fs}px ${FONTS.kai}`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = `rgba(${PALETTE.ink.join(',')},${0.56 * a})`;
    srcChars.forEach((ch, i) => {
      const y = y0 + i * adv;
      if (ch === '《' || ch === '》') {
        c.save(); c.translate(x, y); c.rotate(Math.PI / 2); c.fillText(ch, 0, 0); c.restore();
      } else c.fillText(ch, x, y);
    });
    c.restore();
  }
  // 字卡：放在诗句左边的留白里，每行居中
  const cardCX = Math.round((90 + (vx - 170)) / 2);
  function drawCard(c, card, a) {
    if (a <= 0.001) return;
    const big = card.id === 'E8';
    const fs = big ? 36 : 30, lh = big ? 64 : 58;
    c.save();
    c.font = `400 ${fs}px ${FONTS.serif}`;
    c.letterSpacing = big ? '8px' : '3px';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = INK_CARD;
    c.globalAlpha = a;
    const n = card.lines.length;
    card.lines.forEach((ln, i) => c.fillText(ln, cardCX + (big ? 4 : 1.5), 532 + (i - (n - 1) / 2) * lh));
    c.restore();
  }
  const cardAlpha = (cd, t) => sstep(cd.inAt, cd.inAt + cd.inDur, t) * (1 - sstep(cd.outAt, cd.outAt + cd.outDur, t));

  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy,0.,1.); }',
    fragmentShader: `uniform sampler2D map; uniform float fade; varying vec2 vUv;
      void main(){ gl_FragColor = vec4(texture2D(map, vUv).rgb * fade, 1.0); }`,
    uniforms: { map: { value: L.tex }, fade: { value: 0 } }, depthTest: false, depthWrite: false,
  });

  if (DBG) console.log(`[dbg] s8_epilogue build ${(performance.now() - tBuild).toFixed(0)} ms`);
  const scene8 = {
    id: 's8_epilogue', start: T.start, end: T.end,
    render(t, ctx) {
      const fade = sstep(T.paperIn, T.paperIn + 1.8, t) * (1 - sstep(T.fadeBlack, T.fadeBlack + 1.8, t));
      if (fade > 0.0005) {
        const c = L.ctx;
        const tau = t - T.impact;
        if (tau < -0.4) {
          if (t >= settleAt) c.drawImage(baseAll, 0, 0);
          else {
            c.drawImage(paper, 0, 0);
            if (t >= T.write) writeText(c, VERSE, { ...vopts, t, t0: T.write, dur: T.dur });
          }
        } else if (tau < washEnd) {
          c.drawImage(tau < 0 ? baseAll : baseNoWei, 0, 0);
          drawWash(c, tau);
        } else {
          if (!washFinal) {
            washFinal = mk(W, H);
            const g = washFinal.getContext('2d');
            g.drawImage(baseNoWei, 0, 0);
            drawWash(g, washEnd);
          }
          c.drawImage(washFinal, 0, 0);
        }
        drawSource(c, sstep(T.src, T.src + 1.4, t));
        for (const cd of T.cards) drawCard(c, cd, cardAlpha(cd, t));
        L.tex.needsUpdate = true;
      }
      mat.uniforms.fade.value = fade;
      ctx.blit(mat);
      // ---- 片尾：黑底小字（叠加层）----
      const aCr = win(t, T.credits, T.credits + 1.6, T.endT - 1.6, T.endT - 0.15);
      if (aCr > 0.001) {
        const c = ctx.film.ov.ctx;
        c.save();
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillStyle = `rgba(189,182,168,${aCr})`;
        c.font = `400 46px ${FONTS.serif}`;
        c.letterSpacing = '0px';
        c.fillText(CREDITS[0], W / 2, 468);
        c.font = `300 22px ${FONTS.serif}`;
        c.letterSpacing = '3px';
        c.fillStyle = `rgba(189,182,168,${aCr * 0.85})`;
        c.fillText(CREDITS[1], W / 2 + 1.5, 572);
        c.fillText(CREDITS[2], W / 2 + 1.5, 616);
        c.restore();
      }
    },
    postFx() {
      return { toneMix: 0, exposure: 1, bloom: 0.0, grain: 0.026, vignette: 0.26, contrast: 1.0, sat: 1.0 };
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
  return scene8;
}
