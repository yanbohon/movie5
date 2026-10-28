// S0 冷开场：画面时刻表（纯函数，不依赖浏览器）。场景代码和音效对位用同一份。
import { strokeSchedule } from '../../film/brush_schedule.js';

export const TITLE = '鲔';
export const SUBTITLE = '最后一尾白鲟';
export const CARD = ['长江 · 宜宾江段', '2005—2010 年间 · 某一个春天'];

/** 全部时刻（秒，绝对时间），全部从 timeline 的卡点推出来 */
export function timing(tl) {
  const m = (id) => { const x = tl.marks.find((k) => k.id === id); if (!x) throw new Error(`no mark ${id}`); return x.t; };
  const span = tl.scenes.find((s) => s.id === 's0_cold');
  const write = m('s0_cold.title_write'), hold = m('s0_cold.title_hold'), dissolve = m('s0_cold.title_dissolve');
  const dur = Math.min(4.0, hold - write - 0.12); // 片名 14 笔约 4 秒
  const strokes = strokeSchedule(TITLE, write, dur, { strokePause: 0.16, travel: 0.36 });
  return {
    start: span.start, end: span.end,
    cardIn: m('s0_cold.card_in'), cardOut: m('s0_cold.card_out'),
    particlesIn: m('s0_cold.particles_in'),
    write, dur, hold, dissolve,
    subIn: hold, subOut: dissolve + 0.35,
    // 光碎成颗粒：从上游（左）往下游（右）一片片剥落，dissolveDur 秒剥完
    dissolveDur: Math.min(1.9, (span.end - dissolve) * 0.62),
    strokes,
  };
}

export function events(tl) {
  const T = timing(tl);
  const out = [
    { t: T.cardIn, id: 'card_place', kind: 'card', text: CARD.join(' / '), end: T.cardOut + 1.2 },
    { t: T.particlesIn, id: 'particles_in', kind: 'particles' },
  ];
  for (const st of T.strokes) {
    out.push({ t: st.start, end: st.end, id: `title_stroke_${st.i + 1}`, kind: 'brush_glow', i: st.i, char: st.char, type: st.type });
  }
  out.push({ t: T.subIn, id: 'title_sub', kind: 'card', text: SUBTITLE, end: T.subOut + 1.0 });
  out.push({ t: T.dissolve, id: 'title_dissolve', kind: 'dissolve', end: T.dissolve + T.dissolveDur });
  return out;
}
