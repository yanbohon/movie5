// S1 的画面时刻（纯函数，不依赖浏览器）：场景代码与音效共用
export function s1Times(tl) {
  const m = (id) => tl.marks.find((x) => x.id === `s1_river.${id}`).t;
  const sc = tl.scenes.find((s) => s.id === 's1_river');
  const line = (id) => tl.lines.find((l) => l.id === id);
  const reveal = m('electro_reveal');
  const ship = m('ship_pass'), peak = m('ship_peak'), gone = m('ship_gone');
  const L10 = line('L10');
  return {
    start: sc.start, end: sc.end,
    rostrum: m('rostrum_enter'),
    rostrumCenter: m('rostrum_enter') + 2.1,    // 吻尖掠过画面中央
    eyeCut: line('L05').t - 0.1,                // 切眼睛特写
    body: m('body_pass'),
    reveal,
    waveEnd: reveal + 5.0,                       // 波前扫出 35 米后，全场电感
    pullback: line('L08').t,
    scan: line('L09').t,
    scanSweeps: [0, 1, 2].map((k) => line('L09').t + 0.6 + k * 2.5), // 三次左右扫吻
    stillLook: L10.t,
    rumble: m('rumble_start'),
    ship, peak, gone,
    staticCut: ship,                             // 电感视觉被噪声冲垮，切真实视角
    bowOver: ship - 0.3,
    propOver: peak + 3.5,
    diveStart: ship + 0.4,
    bottomHit: ship + 4.3,                       // 贴到河床，泥沙扬起
    stormPeak: peak + 3.8,
    rest: gone + 1.0,
    fadeOut: sc.end - 1.6,
  };
}

export function events(tl) {
  const T = s1Times(tl);
  return [
    { t: T.start, id: 's1_in', kind: 'fade_in' },
    { t: T.rostrumCenter, id: 's1_rostrum', kind: 'swim_by', dur: 3.0, dist: 1.2 },
    { t: T.body + 1.6, id: 's1_body', kind: 'swim_by', dur: 3.4, dist: 2.5 },
    { t: T.reveal, id: 's1_reveal', kind: 'electro_on' },
    ...T.scanSweeps.map((t, i) => ({ t, id: `s1_scan${i}`, kind: 'scan' })),
    { t: T.rumble, id: 's1_rumble', kind: 'ship_approach' },
    { t: T.staticCut, id: 's1_static', kind: 'electro_off_static' },
    { t: T.bowOver, id: 's1_bow', kind: 'ship_bow' },
    { t: T.peak, id: 's1_peak', kind: 'ship_peak' },
    { t: T.propOver, id: 's1_prop', kind: 'ship_prop' },
    { t: T.diveStart, id: 's1_dive', kind: 'dive' },
    { t: T.bottomHit, id: 's1_bottom', kind: 'bottom_hit' },
    { t: T.gone, id: 's1_gone', kind: 'ship_gone' },
    { t: T.fadeOut, id: 's1_out', kind: 'fade_out' },
  ];
}
