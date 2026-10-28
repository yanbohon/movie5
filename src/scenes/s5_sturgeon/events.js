// S5 的画面时刻（纯函数，不依赖浏览器）：场景代码与音效共用
export function s5Times(tl) {
  const m = (id) => tl.marks.find((x) => x.id === `s5_sturgeon.${id}`).t;
  const sc = tl.scenes.find((s) => s.id === 's5_sturgeon');
  const line = (id) => tl.lines.find((l) => l.id === id);
  const L = {};
  for (const id of ['L42', 'O01', 'O02', 'L43', 'O03', 'O04', 'L44', 'O05', 'L45', 'O06', 'L46']) L[id] = line(id);
  const reveal = m('reveal');
  return {
    start: sc.start, end: sc.end, L,
    glow: m('far_glow'),                                   // 电感视觉里远处一团光
    ask: L.L42.t,                                          // ……是你吗？
    rush: m('rush'),                                       // 她冲过去
    approach: reveal - 1.3,                                // 光团占满画面
    reveal,                                                // 切回真实视角：一条老鲟
    stop: L.O02.t + 0.4,                                   // 老鲟停稳
    memStart: L.O03.t + Math.min(1.7, L.O03.dur * 0.32),  // 「那时候，江里到处都是你们」：回忆的波
    memEnd: L.O04.t - 0.35,                                // 回忆散去
    eggStart: L.L45.t - 0.25,                              // 「我肚子里有卵」：透过身体看见卵
    eggEnd: L.L45.t + L.L45.dur + 0.5,
    leave: m('sturgeon_leave'),                            // 老鲟转身没入浑水
    fadeOut: sc.end - 2.2,
  };
}

/** 心跳：按变化的心率积分，返回每一下的时刻 */
export function beatsFrom(t0, t1, rate, phase0 = 0.5) {
  const out = [];
  let ph = phase0;
  const dt = 1 / 240;
  for (let t = t0; t < t1; t += dt) {
    const p2 = ph + rate(t) * dt;
    if (Math.floor(p2) > Math.floor(ph)) out.push(t + dt * ((Math.floor(p2) - ph) / (p2 - ph)));
    ph = p2;
  }
  return out;
}
const sm = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };

/** 她的心跳：看见光团后加快，冲过去时最快 */
export function herBeats(T) {
  const rate = (t) => 0.72 + 0.5 * sm(T.glow + 1.0, T.ask, t) + 0.55 * sm(T.rush, T.rush + 1.5, t) - 0.6 * sm(T.reveal + 1, T.reveal + 6, t);
  return beatsFrom(T.start, T.reveal + 3, rate, 0.3);
}
/** 老鲟的心跳：慢 */
export function oldBeats(T) {
  return beatsFrom(T.start, T.end, () => 0.42, 0.7);
}
/** 某一时刻的搏动强度 0..1（双峰：扑—通） */
export function pulseAt(beats, t) {
  let v = 0;
  for (const b of beats) {
    const d = t - b;
    if (d < -0.3) break;
    if (d > 0.8) continue;
    v = Math.max(v, Math.exp(-((d / 0.07) ** 2)) + 0.55 * Math.exp(-(((d - 0.24) / 0.08) ** 2)) + 0.25 * Math.exp(-d / 0.35) * (d > 0 ? 1 : 0));
  }
  return Math.min(1, v);
}

export function events(tl) {
  const T = s5Times(tl);
  return [
    { t: T.start, id: 's5_glow', kind: 'far_glow', dur: T.reveal - T.start },
    ...herBeats(T).filter((b) => b < T.reveal).map((t, i) => ({ t, id: `s5_hb${i}`, kind: 'heartbeat', who: 'HER' })),
    { t: T.rush, id: 's5_rush', kind: 'rush', dur: T.reveal - T.rush },
    { t: T.reveal, id: 's5_reveal', kind: 'electro_off_cut' },
    { t: T.reveal + 0.2, id: 's5_old_in', kind: 'swim_by', dur: 3.5, dist: 3.0 },
    { t: T.memStart, id: 's5_mem', kind: 'electro_on_memory', dur: T.memEnd + 0.8 - T.memStart },
    { t: T.memEnd, id: 's5_mem_out', kind: 'electro_off_fade', dur: 0.8 },
    { t: T.eggStart, id: 's5_eggs', kind: 'electro_on_eggs', dur: T.eggEnd + 0.8 - T.eggStart },
    { t: T.eggEnd, id: 's5_eggs_out', kind: 'electro_off_fade', dur: 0.8 },
    { t: T.leave + 2.2, id: 's5_leave', kind: 'swim_by', dur: 4.0, dist: 1.0 },
    { t: T.fadeOut, id: 's5_out', kind: 'fade_out' },
  ];
}
