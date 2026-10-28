// S2「长卷」的画面时刻（纯函数，不依赖浏览器）：场景代码和音效对位用同一份（plan.js + brush_schedule.js）。
// 书法（白鲟、象鱼、鲔）逐笔给出落笔 / 收笔时刻；回卷、陨石、山长、近代、坝线、鱼淡掉……都是真实画面时刻。
import { makePlan, modernLayout, weiNoteCols } from './plan.js';
import { strokeSchedule } from '../../film/brush_schedule.js';

/** 书法：和场景里 brush.js 的 writeText 同一个调用（默认笔顺节奏） */
export function brushStrokes(P) {
  const L = P.live;
  return [
    { key: 'name1', ...L.name1 },
    { key: 'name2', ...L.name2 },
    { key: 'wei', ...L.wei },
  ].map((b) => ({ ...b, strokes: strokeSchedule(b.text, b.t0, b.dur) }));
}

/** 小楷注文：两行竖写，按字依次显出（与 live.js 的 stampMask 揭示同一节奏） */
export function noteChars(P) {
  const L = P.live;
  const [c1, c2] = weiNoteCols(L.weiNote.text);
  const n = [...c1].length + [...c2].length;
  const out = [];
  [...c1, ...c2].forEach((ch, k) => {
    if (ch === ' ') return;
    out.push({ ch, t: L.weiNote.t0 + (L.weiNote.t1 - L.weiNote.t0) * (k / n) });
  });
  return out;
}

export function events(tl) {
  const P = makePlan(tl);
  const T = P.T, L = P.live, RW = P.RW;
  const out = [];
  const push = (e) => out.push(e);

  push({ t: T.start, end: T.start + 1.5, id: 's2_paper_in', kind: 'fade_in' });

  // 书法：逐笔（音效对笔声）
  for (const b of brushStrokes(P)) {
    for (const st of b.strokes) {
      push({ t: st.start, end: st.end, id: `s2_${b.key}_stroke_${st.k + 1}`, kind: 'brush', char: st.char, i: st.i, type: st.type, speed: Math.round(st.speed * 100) / 100, size: b.key === 'wei' ? 'large' : 'medium' });
    }
  }
  // 小楷注文：细笔，一个字一个字
  noteChars(P).forEach((c, k) => push({ t: c.t, id: `s2_note_${k + 1}`, kind: 'brush_small', char: c.ch }));

  // 回卷：拉远 → 向右急掠（运动模糊）→ 停在最右端 → 推回
  push({ t: RW.t0, end: RW.tSweep1, id: 's2_rewind', kind: 'whoosh', phase: 'start' });
  push({ t: RW.tSweep1, id: 's2_rewind_stop', kind: 'whoosh', phase: 'stop' });
  push({ t: RW.tIn0, end: RW.tIn1, id: 's2_push_in', kind: 'push_in' });

  // 陨石：朱砂一笔划下 → 落地 → 红晕漫开 → 恐龙化灰
  push({ t: L.astStreak0, end: L.astImpact, id: 's2_asteroid_streak', kind: 'streak' });
  push({ t: L.astImpact, id: 's2_asteroid_impact', kind: 'impact' });
  push({ t: L.astImpact + 0.15, end: L.astImpact + 2.6, id: 's2_red_sky', kind: 'wash_spread', color: 'cinnabar' });
  push({ t: L.dinoFade0, end: L.dinoFade0 + L.dinoFadeDur, id: 's2_dino_ash', kind: 'dissolve' });

  // 新生代：山一层层长高、河改道
  push({ t: L.mount0, end: L.mount1, id: 's2_mountains_grow', kind: 'wash_grow' });
  push({ t: L.reroute0, end: L.reroute1, id: 's2_river_reroute', kind: 'stroke' });
  // 岸上有了人
  push({ t: L.human0, end: L.human1, id: 's2_humans', kind: 'stroke' });
  // 周：鼎里的香烟
  push({ t: L.zhouSmoke0, end: L.zhouSmoke1, id: 's2_incense', kind: 'smoke_thin' });

  // 近代：焦墨一笔一根烟囱、厂房、轮船、铁桥；黑烟泼开
  const ML = modernLayout(P);
  push({ t: ML.sheds.t0, end: ML.sheds.t1, id: 's2_sheds', kind: 'stroke' });
  ML.chim.forEach((c, i) => push({ t: c.t0, end: c.t0 + (c.t1 - c.t0) * 0.8, id: `s2_chimney_${i + 1}`, kind: 'stroke', weight: 'heavy' }));
  push({ t: ML.ship.t0, end: ML.ship.t1, id: 's2_steamship', kind: 'stroke' });
  push({ t: ML.bridge.t0, end: ML.bridge.t1, id: 's2_iron_bridge', kind: 'stroke' });
  ML.smoke.forEach((m, i) => push({ t: m.t0, end: m.t1, id: `s2_smoke_${i + 1}`, kind: 'smoke' }));
  push({ t: ML.shipSmoke.t0, end: ML.shipSmoke.t1, id: 's2_ship_smoke', kind: 'smoke' });

  // 坝：尺子画的直线，从上往下一口气画到底
  push({ t: L.ruler0, id: 's2_dam_ruler_start', kind: 'ruler_start' });
  push({ t: L.ruler1, id: 's2_dam_ruler_end', kind: 'ruler_end' });
  // 墙外远处的海：一抹极淡的水平线
  push({ t: L.sea0, end: L.sea1, id: 's2_sea_line', kind: 'stroke', weight: 'faint' });

  // 上游的鱼一条条淡掉（L27），最后剩一条小鱼
  for (const f of P.fish) {
    if (f.fade0 == null) continue;
    push({ t: f.fade0, end: f.fade0 + f.fadeDur, id: `s2_fish_fade_${f.key}`, kind: 'fade', fish: f.key });
  }
  const last = P.fish.find((f) => f.key === 'C');
  if (last) push({ t: T.L27.t + 3.25, id: 's2_last_fish', kind: 'hold', fish: 'C' });

  return out.sort((a, b) => a.t - b.t);
}
