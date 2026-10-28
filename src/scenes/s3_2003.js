// S3 二〇〇三（181.5–253.6 s）：2003 年 1 月 24 日，宜宾，人类最后一次见到白鲟。
// 全屏写意水墨，镜头在画里推拉摇；画面之间用墨在纸上化开/褪去来过渡（在「墨量」里混合，而不是叠化图像）。
// 渲染：s3_2003/gl.js（笔触 → 墨量缓冲 → 洇、湿边、飞白 → 宣纸），时间表：s3_2003/events.js（音效用同一份）。
import { InkGL } from './s3_2003/gl.js';
import { schedule } from './s3_2003/events.js';
import { mixObj } from './s3_2003/common.js';
import { makeDate, makeNet, makeSky } from './s3_2003/shots_open.js';
import { makeShore, makeLift, makeQuilt } from './s3_2003/shots_mid.js';
import { makeBoat } from './s3_2003/shots_boat.js';
import { makeRiver, makeNight, makeWait } from './s3_2003/shots_end.js';
import { smooth } from '../film/util.js';

const TIMING = false;
const POST_BASE = { toneMix: 0, exposure: 1, bloom: 0.06, grain: 0.028, vignette: 0.28 };

export default async function (ctx) {
  const span = ctx.sceneSpan('s3_2003');
  const T = schedule(ctx.timeline);
  const tb = performance.now();
  const ink = new InkGL(ctx, { paperW: 2400, paperH: 1350, paperSeed: 3 });
  const shots = [
    makeDate(ctx, ink, T),
    makeNet(ctx, ink, T),
    makeSky(ctx, ink, T),
    makeShore(ctx, ink, T),
    makeLift(ctx, ink, T),
    makeQuilt(ctx, ink, T),
    makeBoat(ctx, ink, T),
    makeRiver(ctx, ink, T),
    makeNight(ctx, ink, T),
    makeWait(ctx, ink, T),
  ];
  // 过渡：后一个镜头的 enter 定义，从它的 t0 开始，持续 dur
  const trans = [];
  for (let i = 1; i < shots.length; i++) {
    const B = shots[i], e = B.enter || { type: 0, dur: 0.6 };
    trans.push({ i, t0: B.t0, t1: B.t0 + e.dur, type: e.type || 0, win: e.win || [0, 1, 0, 1], seed: e.seed || i * 1.7, soft: e.soft, dir: e.dir });
  }
  console.log(`[dbg] s3 build ${(performance.now() - tb).toFixed(0)}ms (paper ${ink.paperMs.toFixed(0)}ms)`);

  function state(t) {
    for (const tr of trans) if (t >= tr.t0 && t < tr.t1) return { A: shots[tr.i - 1], B: shots[tr.i], tr, p: (t - tr.t0) / (tr.t1 - tr.t0) };
    for (let i = shots.length - 1; i >= 0; i--) if (t >= shots[i].t0) return { A: shots[i] };
    return { A: shots[0] };
  }
  let nFrames = 0, msSum = 0;

  return {
    id: 's3_2003', start: span.start, end: span.end,
    render(t, ctx) {
      const r0 = performance.now();
      const st = state(t);
      const A = st.A, vA = A.view(t);
      ink.begin(ink.rtA, vA, A.paper);
      A.draw(ink, t);
      ink.end();
      let dens = ink.rtA, look = A.look(t);
      if (st.B) {
        const B = st.B, vB = B.view(t);
        ink.begin(ink.rtB, vB, B.paper);
        B.draw(ink, t);
        ink.end();
        const tr = { p: st.p, type: st.tr.type, seed: st.tr.seed, soft: st.tr.soft, dir: st.tr.dir, win: st.tr.win };
        dens = ink.mix(tr);
        const k = smooth(st.p);
        const lb = B.look(t);
        look = mixObj(look, lb, k);
        look.bmode = A.usesB ? (A.look(t).bmode || 0) : (lb.bmode || 0);
        ink.composite(dens, look, vA, A.paper, vB, B.paper, tr);
      } else {
        ink.composite(dens, look, vA, A.paper);
      }
      nFrames++; msSum += performance.now() - r0;
      if (nFrames % 60 === 0) console.log(`[dbg] s3 avg cpu ${(msSum / nFrames).toFixed(1)}ms`);
      if (TIMING) {
        // 测时（临时）：读回一个像素，逼 GPU 把这一帧画完，量「CPU 建笔触 + GPU 画墨、化开、合成」的总耗时
        const cpu = performance.now() - r0;
        const gl = ctx.renderer.getContext(); const px = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        console.log(`[dbg] s3 frame t=${t.toFixed(2)} cpu=${cpu.toFixed(1)}ms total=${(performance.now() - r0).toFixed(1)}ms strokes=${ink.strokes.nv} fills=${ink.fills.nv}${ink.strokes.overflow || ink.fills.overflow ? ' OVERFLOW' : ''}`);
      }
    },
    postFx(t) {
      const st = state(t);
      const pa = { ...POST_BASE, ...(st.A.post ? st.A.post(t) : {}) };
      if (!st.B) return pa;
      const pb = { ...POST_BASE, ...(st.B.post ? st.B.post(t) : {}) };
      return mixObj(pa, pb, smooth(st.p));
    },
  };
}
