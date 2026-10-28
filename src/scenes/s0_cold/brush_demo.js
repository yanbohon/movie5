// 书法引擎演示（开发用）：node tools/shot.mjs --scenes s0_cold,brushdemo --times 1,2,3,4,5,6 --full ...
// 只在 URL 的 scenes 参数里带 brushdemo 时启用，正式渲染不会走到这里。
import { writeText, prepareText, loadGlyphs, strokeSchedule } from '../../film/brush.js';
import { makePaperCanvas, PALETTE } from '../../film/paper.js';

export async function brushDemo(ctx) {
  const { THREE, W, H } = ctx;
  await loadGlyphs('鲔有鳣');
  const L = ctx.layer(W, H, { srgb: true, premult: false });
  const paper = makePaperCanvas(W, H, { seed: 11, mottle: 0.8, age: 0.15 }).canvas;
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy,0.,1.); }',
    fragmentShader: `uniform sampler2D map; uniform float glow; varying vec2 vUv;
      void main(){ vec3 c = texture2D(map, vUv).rgb; gl_FragColor = vec4(glow > 0.5 ? c * 2.2 : c, 1.0); }`,
    uniforms: { map: { value: L.tex }, glow: { value: 0 } }, depthTest: false, depthWrite: false,
  });
  const T0 = 0, D1 = 4, D4 = 5.2;
  const ink = { mode: 'ink', wet: 0.55, dry: 0.3, seed: 3 };
  const glow = { mode: 'glow', wet: 0.5, dry: 0.55, seed: 5 };
  const s1 = strokeSchedule('鲔', T0, D1), s4 = strokeSchedule('有鳣有鲔', T0, D4);
  // 书写中的时刻：写到一半（第 9 笔中间）
  const mid1 = (s1[8].start + s1[8].end) / 2;
  const mid4 = (s4[30].start + s4[30].end) / 2;
  const t0 = performance.now();
  prepareText('鲔', { ...ink, size: 600 });
  prepareText('有鳣有鲔', { ...ink, size: 150 });
  prepareText('鲔', { ...glow, size: 600 });
  prepareText('有鳣有鲔', { ...glow, size: 150 });
  console.log(`[dbg] brush prepare ${(performance.now() - t0).toFixed(0)} ms`);
  const panels = [
    // 1：ink 鲔 书写中 / 写完（刚写完 0.3 秒，湿）
    (c) => {
      c.drawImage(paper, 0, 0); mat.uniforms.glow.value = 0;
      writeText(c, '鲔', { ...ink, x: 240, y: 180, size: 600, t: mid1, t0: T0, dur: D1 });
      writeText(c, '鲔', { ...ink, x: 1080, y: 180, size: 600, t: D1 + 0.3, t0: T0, dur: D1 });
    },
    // 2：ink 有鳣有鲔 书写中 / 写完（干）
    (c) => {
      c.drawImage(paper, 0, 0); mat.uniforms.glow.value = 0;
      writeText(c, '有鳣有鲔', { ...ink, x: 700, y: 160, size: 150, t: mid4, t0: T0, dur: D4 });
      writeText(c, '有鳣有鲔', { ...ink, x: 1100, y: 160, size: 150, t: D4 + 10, t0: T0, dur: D4 });
    },
    // 3：glow 鲔 书写中 / 写完
    (c) => {
      c.fillStyle = '#000'; c.fillRect(0, 0, W, H); mat.uniforms.glow.value = 1;
      writeText(c, '鲔', { ...glow, x: 240, y: 180, size: 600, t: mid1, t0: T0, dur: D1 });
      writeText(c, '鲔', { ...glow, x: 1080, y: 180, size: 600, t: D1 + 3, t0: T0, dur: D1 });
    },
    // 4：glow 有鳣有鲔
    (c) => {
      c.fillStyle = '#000'; c.fillRect(0, 0, W, H); mat.uniforms.glow.value = 1;
      writeText(c, '有鳣有鲔', { ...glow, x: 700, y: 160, size: 150, t: mid4, t0: T0, dur: D4 });
      writeText(c, '有鳣有鲔', { ...glow, x: 1100, y: 160, size: 150, t: D4 + 3, t0: T0, dur: D4 });
    },
    // 5：ink 鲔 大特写（看飞白、湿边、洇）：同一个字放大画
    (c) => {
      c.drawImage(paper, 0, 0); mat.uniforms.glow.value = 0;
      writeText(c, '鲔', { ...ink, x: -300, y: -500, size: 1500, t: D1 + 10, t0: T0, dur: D1 });
    },
    // 6：书写过程连拍（ink，160 px，12 个时刻）
    (c) => {
      c.drawImage(paper, 0, 0); mat.uniforms.glow.value = 0;
      for (let q = 0; q < 12; q++) {
        const tt = T0 + (q / 11) * (D1 + 0.2);
        writeText(c, '鲔', { ...ink, x: 60 + q * 152, y: 300, size: 150, t: tt, t0: T0, dur: D1 });
      }
      for (let q = 0; q < 12; q++) {
        const tt = s1[3].start + (q / 11) * (s1[3].end - s1[3].start + 0.8);
        writeText(c, '鲔', { ...ink, x: 60 + q * 152, y: 520, size: 150, t: tt, t0: T0, dur: D1 });
      }
    },
  ];
  prepareText('鲔', { ...ink, size: 1500 });
  prepareText('鲔', { ...ink, size: 150 });
  return {
    id: 's0_cold', start: 0, end: 31,
    render(t, ctx) {
      const k = Math.max(0, Math.min(panels.length - 1, Math.floor(t) - 1));
      const t1 = performance.now();
      panels[k](L.ctx);
      console.log(`[dbg] panel ${k + 1} ${(performance.now() - t1).toFixed(0)} ms`);
      L.tex.needsUpdate = true;
      ctx.blit(mat);
    },
    postFx() { return { toneMix: 0, exposure: 1, bloom: 0.0, grain: 0.0, vignette: 0.0 }; },
  };
}
