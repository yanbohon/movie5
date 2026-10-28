// S6 宜宾的画面时刻（纯函数，不依赖浏览器）：场景代码与音效共用同一批数。
import { mulberry32 } from '../../film/util.js';

export function s6Times(tl) {
  const m = (id) => tl.marks.find((x) => x.id === `s6_yibin.${id}`).t;
  const sc = tl.scenes.find((s) => s.id === 's6_yibin');
  const line = (id) => tl.lines.find((l) => l.id === id);
  const L47 = line('L47'), L48 = line('L48'), L50 = line('L50'), L52 = line('L52');
  const night = m('night_city'), wait = m('wait_night'), release = m('release_eggs'), glow = m('eggs_glow'), dark = m('eggs_dark');
  // 产卵：七股，一股比一股软（每股开头最猛）
  const W = [1.0, 1.3, 1.4, 1.25, 1.0, 0.75, 0.45];
  const spurts = W.map((w, k) => ({ t: release + 0.5 + k * 0.62, dur: 0.5, w }));
  const lapse0 = wait + 0.35, lapse1 = L50.t - 1.3;
  return {
    start: sc.start, end: sc.end, night,
    // ① 夜城：从水下仰望，城市的灯在水面的亮窗里碎成一圈；她从亮窗前滑过，穿过两江的分界
    cross: L47.t + 2.3,                  // 她身体中段穿过分界面（「两条江在这里碰头」）
    seamCut: L47.t + L47.dur - 0.9,      // 切到分界面的侧面：一边浑黄、一边青绿
    // ② 回忆（电感）：一代代白鲟的光影
    memory: L48.t - 0.45,                // 波从她吻部荡开
    ghosts: [L48.t + 0.3, L48.t + 2.6, L48.t + 4.4], // 妈妈 / 「她的妈妈也是」/ 「每一个春天」
    memoryOff: wait,
    // ③ 卵石滩上等了一整夜（延时）：头顶的灯一盏盏熄，天往黎明走
    wait, lapse0, lapse1,
    bridgeOff: lapse1 - 0.35,            // 桥上的灯带最后一起熄
    // ④ 电感：四周是空的
    empty: L50.t - 0.9,
    // ⑤ 产卵（真实视角，天快亮）
    release, spurts, spurtEnd: spurts[spurts.length - 1].t + spurts[spurts.length - 1].dur,
    // ⑥ 电感：每颗卵亮起一点琥珀色
    glow,
    macro: L52.t - 0.35,                 // 切近景：卵石上的一小簇卵
    dieStart: L52.t + 1.6,               // 「它们亮了一下。」之后，第一颗暗下去
    pull: L52.t + 2.9,                   // 「一颗一颗」起镜头往上拉开，整片卵一片片暗
    dark,                                // 最后一颗熄灭
    fadeOut: dark + 1.2, black: sc.end - 0.5,
  };
}

// 城市里的大灯（world.js 夜空里的 48 盏）各自的熄灭门槛，与着色器同一个公式（float32）
export function cityLightKeep(i) {
  const f = Math.fround;
  const x = f(f(f(i) * f(0.7548777)) + f(0.137));
  return x - Math.floor(x);
}
// 延时里「熄灭进度」随时间：先慢后快再慢（夜深时灯灭得最快）
export function cityOffAt(T, t) {
  const x = Math.min(1, Math.max(0, (t - T.lapse0) / (T.lapse1 - T.lapse0)));
  return x * x * (3 - 2 * x);
}

// 卵的熄灭顺序：随机，先慢后快。返回每颗卵熄灭的时刻（前 nFirst 颗由场景指定的卵在 firstTimes 熄）
export function eggDeathTimes(T, n, { seed = 91, firstIdx = [], firstTimes = [], lastIdx = -1 } = {}) {
  const rnd = mulberry32(seed);
  const td = new Float64Array(n);
  const t0 = T.dieStart + 1.2, t1 = T.dark - 0.35;
  for (let i = 0; i < n; i++) {
    // 熄灭的比例 F(t) = x^2.6：开头只零星几颗，越到后面越快
    const u = rnd();
    td[i] = t0 + (t1 - t0) * Math.pow(u, 1 / 2.6);
  }
  firstIdx.forEach((i, k) => { td[i] = firstTimes[k]; });
  if (lastIdx >= 0) td[lastIdx] = T.dark;
  return td;
}
// 前几颗「一颗一颗」清楚可见地熄灭的时刻
export function firstEggTimes(T) {
  const d = T.dieStart;
  return [d, d + 0.62, d + 1.12, d + 1.5, d + 1.8, d + 2.05, d + 2.27, d + 2.46];
}

export function events(tl) {
  const T = s6Times(tl);
  const ev = [
    { t: T.start, id: 's6_in', kind: 'fade_in' },
    { t: T.cross, id: 's6_cross', kind: 'swim_by', dur: 3.0, dist: 1.6, note: '穿过两江分界' },
    { t: T.seamCut, id: 's6_seam', kind: 'cut' },
    { t: T.memory, id: 's6_memory', kind: 'electro_on', note: '回忆：一代代白鲟的光影' },
    ...T.ghosts.map((t, i) => ({ t, id: `s6_ghost${i}`, kind: 'ghost_in', i })),
    { t: T.memoryOff, id: 's6_memory_off', kind: 'electro_off' },
    { t: T.lapse0, id: 's6_lapse', kind: 'timelapse_start', dur: T.lapse1 - T.lapse0 },
  ];
  // 48 盏大灯各自熄灭的时刻（按 cityOffAt 反解）
  for (let i = 0; i < 48; i++) {
    const k = cityLightKeep(i);
    let a = T.lapse0, b = T.lapse1;
    for (let it = 0; it < 40; it++) { const mm = 0.5 * (a + b); if (cityOffAt(T, mm) < k) a = mm; else b = mm; }
    ev.push({ t: b, id: `s6_light${i}`, kind: 'city_light_off', i });
  }
  ev.push(
    { t: T.bridgeOff, id: 's6_bridge', kind: 'city_lights_off', note: '桥上的灯带熄灭' },
    { t: T.lapse1, id: 's6_lapse_end', kind: 'timelapse_end' },
    { t: T.empty, id: 's6_empty', kind: 'electro_on', note: '四周是空的' },
    { t: T.release, id: 's6_release', kind: 'electro_off' },
    ...T.spurts.map((s, i) => ({ t: s.t, id: `s6_spurt${i}`, kind: 'egg_release', i, dur: s.dur, w: s.w })),
    { t: T.glow, id: 's6_glow', kind: 'eggs_glow' },
    { t: T.glow, id: 's6_glow_wave', kind: 'electro_on' },
    ...firstEggTimes(T).map((t, i) => ({ t, id: `s6_egg_out${i}`, kind: 'egg_out', i })),
    { t: T.dieStart + 1.2, id: 's6_eggs_dying', kind: 'eggs_dying', dur: T.dark - T.dieStart - 1.2 },
    { t: T.dark, id: 's6_dark', kind: 'eggs_dark' },
    { t: T.fadeOut, id: 's6_out', kind: 'fade_out' },
  );
  return ev.sort((a, b) => a.t - b.t);
}
