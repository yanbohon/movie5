// S4 的画面时刻（纯函数，不依赖浏览器）：场景代码与音效共用
export function s4Times(tl) {
  const m = (id) => tl.marks.find((x) => x.id === `s4_seven.${id}`).t;
  const sc = tl.scenes.find((s) => s.id === 's4_seven');
  const line = (id) => tl.lines.find((l) => l.id === id);
  const L37 = line('L37'), L38 = line('L38'), L39 = line('L39'), L40 = line('L40'), L41 = line('L41');
  const boat = m('search_boat'), leave = m('search_leave');
  return {
    start: sc.start, end: sc.end, L37, L38, L39, L40, L41,
    tag: m('tag_close'),
    lapse0: L37.t + 0.85,                      // 延时开始：七个春夏秋冬在信标上一闪而过
    lapse1: L37.t + L37.dur * 0.76,            // 延时结束：信标没电了（「它不叫了」之前）
    pullback: L38.t - 0.4,                     // 镜头离开信标，拉远：她一个人
    boat,                                      // 电感视觉：头顶的船
    pass1: [boat - 0.6, boat + 3.6],           // 第一次开过去（很快，像回忆）
    pass2: [boat + 2.6, boat + 6.4],           // 第二次，斜着（另一年，另一条船，和第一次叠在一起）
    arrive: [L40.t - 2.6, L40.t + 0.2],        // 第三次：减速，停在她头顶
    lower: [L40.t - 0.1, L40.t + 1.7],         // 水听器放下来，悬在她上方两米多
    listen: [L40.t + 1.1, leave + 0.2],        // 听：一圈圈往里收
    leave,                                     // 水听器拉上去
    depart: leave + 0.9,                       // 船开走
    fadeIn: 1.0,
  };
}

/** 信标的叫声：[时刻, 强度]。电快没了，一声比一声弱，最后一声之后就再没有了 */
export function tagPings(T) {
  const t0 = T.tag + 0.3;
  return [[t0, 1.0], [t0 + 2.0, 0.85], [t0 + 4.0, 0.6], [T.lapse1 - 0.35, 0.28]];
}

export function events(tl) {
  const T = s4Times(tl);
  const P = tagPings(T);
  return [
    { t: T.start, id: 's4_in', kind: 'fade_in', dur: T.fadeIn },
    ...P.map(([t, a], i) => ({ t, id: `s4_ping${i}`, kind: 'tag_ping', amp: a, last: i === P.length - 1 })),
    { t: T.lapse0, id: 's4_lapse', kind: 'timelapse', dur: T.lapse1 - T.lapse0 },
    { t: P[P.length - 1][0] + 2.0, id: 's4_silence', kind: 'tag_dead' },
    { t: T.boat, id: 's4_electro', kind: 'electro_on' },
    { t: 0.5 * (T.pass1[0] + T.pass1[1]), id: 's4_pass1', kind: 'boat_pass', dur: T.pass1[1] - T.pass1[0], fast: true },
    { t: 0.5 * (T.pass2[0] + T.pass2[1]), id: 's4_pass2', kind: 'boat_pass', dur: T.pass2[1] - T.pass2[0], fast: true },
    { t: T.arrive[0], id: 's4_arrive', kind: 'boat_arrive', dur: T.arrive[1] - T.arrive[0] },
    { t: T.lower[0], id: 's4_lower', kind: 'hydrophone_down', dur: T.lower[1] - T.lower[0] },
    { t: T.listen[0], id: 's4_listen', kind: 'hydrophone_listen', dur: T.listen[1] - T.listen[0] },
    { t: T.leave, id: 's4_up', kind: 'hydrophone_up', dur: 1.6 },
    { t: T.depart, id: 's4_depart', kind: 'boat_leave', dur: T.end - T.depart },
  ];
}
