// S8 尾声：画面时刻表（纯函数，不依赖浏览器）。场景代码和音效对位用同一份。
import { strokeSchedule } from '../../film/brush_schedule.js';

export const VERSE = '有鳣有鲔';
export const VERSE_SRC = '《诗经·周颂·潜》';
export const CREDITS = [
  '鲔',
  '画面、声音、音乐全部由代码生成（p5.js · three.js）',
  '史实来源：成都商报、新华社、湖北日报；Zhang et al., Science of the Total Environment, 2020',
];

/** 全部时刻（秒，绝对时间），全部从 timeline 的卡点推出来 */
export function timing(tl) {
  const m = (id) => { const x = tl.marks.find((k) => k.id === id); if (!x) throw new Error(`no mark ${id}`); return x.t; };
  const span = tl.scenes.find((s) => s.id === 's8_epilogue');
  const write = m('s8_epilogue.verse_write'), src = m('s8_epilogue.verse_src');
  const dur = Math.min(5.4, src - write - 0.35); // 四个字约 5 秒
  const strokes = strokeSchedule(VERSE, write, dur, { charPause: 0.75 });
  // 史实字卡：每条在自己的卡点淡入，下一条出现前淡出；E8 单独、停得久：E9 等 E8 走干净再进
  const ids = tl.epilogue.map((e) => e.id);
  const wash = m('s8_epilogue.wei_wash');
  const cards = tl.epilogue.map((e, k) => {
    const tIn = m(`s8_epilogue.${e.id}`);
    const next = k + 1 < ids.length ? m(`s8_epilogue.${ids[k + 1]}`) : wash;
    const isE8 = e.id === 'E8', afterE8 = k > 0 && ids[k - 1] === 'E8';
    const inAt = afterE8 ? tIn + 0.75 : tIn;
    const outAt = isE8 ? next - 0.15 : (k + 1 < ids.length ? next - 0.55 : wash - 1.1);
    const outDur = isE8 ? 0.95 : 0.55;
    return { id: e.id, text: e.text, lines: e.text.split('|'), inAt, inDur: isE8 ? 1.3 : 0.9, outAt, outDur };
  });
  const impact = wash + 0.32;
  return {
    start: span.start, end: span.end,
    paperIn: m('s8_epilogue.paper_in'),
    write, dur, strokes,
    src, cards,
    wash, impact, washDone: m('s8_epilogue.wash_done'),
    fadeBlack: m('s8_epilogue.fade_black'), credits: m('s8_epilogue.credits'), endT: m('s8_epilogue.end'),
  };
}

export function events(tl) {
  const T = timing(tl);
  const out = [{ t: T.paperIn, id: 'paper_in', kind: 'paper' }];
  for (const st of T.strokes) {
    out.push({ t: st.start, end: st.end, id: `verse_${st.ci + 1}_${st.i + 1}`, kind: 'brush', char: st.char, ci: st.ci, i: st.i, type: st.type });
  }
  out.push({ t: T.src, id: 'verse_src', kind: 'card', text: VERSE_SRC });
  for (const c of T.cards) out.push({ t: c.inAt, id: c.id, kind: 'card', text: c.text, end: c.outAt + c.outDur });
  out.push({ t: T.impact, id: 'drop', kind: 'drop', char: '鲔' });
  out.push({ t: T.impact, id: 'wash', kind: 'wash', end: T.washDone, char: '鲔' });
  out.push({ t: T.fadeBlack, id: 'fade_black', kind: 'fade', end: T.fadeBlack + 1.8 });
  out.push({ t: T.credits, id: 'credits', kind: 'card', text: CREDITS.join(' / ') });
  return out;
}
