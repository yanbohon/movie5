// S7 最后的画面时刻（纯函数，不依赖浏览器）：场景代码与音效共用同一批数。
// 心跳：heartbeatTimes(tl) 返回 S7 里每一下心跳的时刻，画面（电感视觉里她身上的微光）和声音用同一张表，一拍不差。

export function s7Times(tl) {
  const m = (id) => tl.marks.find((x) => x.id === `s7_end.${id}`).t;
  const sc = tl.scenes.find((s) => s.id === 's7_end');
  const line = (id) => tl.lines.find((l) => l.id === id);
  const L53 = line('L53'), L54 = line('L54'), L55 = line('L55'), L56 = line('L56');
  const sink = m('sink'), lightsOut = m('lights_out'), lastPulse = m('last_pulse'), black = m('black');
  return {
    start: sc.start, end: sc.end,
    sink,                                // 从黑里淡入：黎明，她慢慢沉向卵石
    touch: sink + 5.2,                   // 腹部碰到卵石
    settle: sink + 8.5,                  // 吻也搭到石头上，整条落定
    eyeCut: L54.t - 1.5,                 // 眼睛特写（「你们还在听吗？」）
    rostrumCut: L55.t - 1.3,             // 吻搭在石头上（「别找了。」）
    bodyCut: L56.t - 1.1,                // 侧面：鳍越动越慢，鳃越来越慢（「今天的江水，也很暖。」）
    L53: L53.t, L54: L54.t, L55: L55.t, L56: L56.t,
    lightsOut,                           // 电感：剩下的光一颗颗熄
    dieStart: lightsOut + 0.9, dieEnd: lastPulse - 3.2,
    lastPulse,                           // 最后一下
    fadeLife: lastPulse + 0.25,          // 最后一下之后，她身上的光慢慢没了
    black,                               // 全黑，只剩江水声
  };
}

// 电感视觉里先熄的四颗光（离她近的：一颗卵、一只虫、一只小虾、一颗卵），一颗、一颗、一颗地熄；其余的在第四颗之后越熄越快
export function firstLightTimes(T) {
  return [0.25, 0.8, 1.25, 1.6].map((x) => T.dieStart + x);
}
// 感知收缩（四周的河床从外往里暗下去）的起止
export function worldFadeSpan(T) {
  return { t0: T.lightsOut + 0.3, t1: T.lastPulse - 0.4 };
}

// 两下心跳之间的间隔（秒），r = 离最后一下还有多久：越到最后越慢
const beatGap = (r) => 1.2 + 1.6 * Math.exp(-r / 3.0);

/** S7 里每一下心跳的时刻（升序）。最后一下正好落在 last_pulse。 */
export function heartbeatTimes(tl) {
  const T = s7Times(tl);
  const out = [T.lastPulse];
  let t = T.lastPulse;
  for (;;) {
    t -= beatGap(T.lastPulse - t);
    if (t < T.start) break;
    out.push(t);
  }
  return out.reverse();
}

/** 心跳的光（0..1）：每下是「咚-哒」两个起伏；最后一下更大、更长 */
export function heartGlow(beats, t, last) {
  let h = 0;
  for (const b of beats) {
    const x = t - b;
    if (x < -0.05 || x > 2.5) continue;
    const big = b === last ? 1 : 0;
    const a = (x < 0 ? 0 : Math.min(1, x / 0.06)) * Math.exp(-Math.max(0, x - 0.06) / (0.22 + 0.5 * big));
    const y = x - 0.24;
    const d = y < 0 ? 0 : Math.min(1, y / 0.06) * Math.exp(-Math.max(0, y - 0.06) / (0.2 + 0.3 * big));
    h = Math.max(h, a * (0.8 + 0.2 * big) + d * 0.45);
  }
  return Math.min(1, h);
}

export function events(tl) {
  const T = s7Times(tl);
  const beats = heartbeatTimes(tl);
  const wf = worldFadeSpan(T);
  return [
    { t: T.sink, id: 's7_in', kind: 'fade_in', note: '黎明' },
    ...firstLightTimes(T).map((t, i) => ({ t, id: `s7_light_out${i}`, kind: 'light_out', i })),
    { t: wf.t0, id: 's7_world_fade', kind: 'world_fade', dur: wf.t1 - wf.t0, note: '四周的河床从外往里暗下去' },
    { t: T.touch, id: 's7_touch', kind: 'settle', note: '腹部碰到卵石' },
    { t: T.settle, id: 's7_settle', kind: 'settle', note: '吻搭到石头上' },
    { t: T.eyeCut, id: 's7_eye', kind: 'cut' },
    { t: T.rostrumCut, id: 's7_rostrum', kind: 'cut' },
    { t: T.bodyCut, id: 's7_body', kind: 'cut' },
    ...beats.map((t, i) => ({ t, id: `s7_beat${i}`, kind: 'heartbeat', i, last: t === T.lastPulse })),
    { t: T.lightsOut, id: 's7_electro', kind: 'electro_on' },
    { t: T.dieStart, id: 's7_lights_out', kind: 'lights_out', dur: T.dieEnd - T.dieStart },
    { t: T.lastPulse, id: 's7_last', kind: 'last_pulse' },
    { t: T.black, id: 's7_black', kind: 'black' },
  ].sort((a, b) => a.t - b.t);
}
