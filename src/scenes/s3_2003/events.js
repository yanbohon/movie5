// S3 二〇〇三 的画面事件与时间表（纯函数：不 import three / p5 / 浏览器 API）。
// 场景代码和音效用同一批时刻：schedule(tl) 给场景，events(tl) 给 tools/collect_events.mjs。
// 一律从 timeline 读卡点和台词起点；台词里某个字的时刻 = 台词起点 + 偏移（偏移由配音 wav 的能量包络量出来，见注释）。

export const STITCH_N = 24;       // 二十四针
export const STITCH_DT = 0.24;    // 每针间隔（秒）：均匀、可数；最后一针正好落在 stitch_end
export const PING_DT = 2.0;       // 信标每 2 秒嘀一声
export const PING_RING = 1.9;     // 画面上每圈同心圆荡开的时长

function mk(tl, id) {
  const m = tl.marks.find((x) => x.id === 's3_2003.' + id);
  if (!m) throw new Error(`s3_2003: no mark ${id}`);
  return m.t;
}
function ln(tl, id) {
  const l = tl.lines.find((x) => x.id === id);
  if (!l) throw new Error(`s3_2003: no line ${id}`);
  return l;
}

export function schedule(tl) {
  const sc = tl.scenes.find((s) => s.id === 's3_2003');
  const T = { start: sc.start, end: sc.end };
  const L = {};
  for (const id of ['L28', 'L29', 'H01', 'H02', 'H03', 'L30', 'L31', 'H04', 'H05', 'L32', 'L33', 'H06', 'L34', 'H07', 'H08', 'H09', 'L35', 'L36']) L[id] = ln(tl, id);
  T.L = L;
  T.date = mk(tl, 'date_card');
  T.sky = mk(tl, 'sky');
  T.cage = mk(tl, 'cage_boat');
  T.stitchEnd = mk(tl, 'stitch_end');
  T.ping0 = mk(tl, 'tag_ping_start');
  T.release = mk(tl, 'release');
  T.night = mk(tl, 'night');
  T.crash = mk(tl, 'crash');

  // ---- 日期卡 → 网 ----
  // L28 包络：「二〇〇三年」0.44–1.52 s，「一月」1.86–2.36 s，「我撞进了一张网」3.06–4.28 s
  T.dateIn = T.date + 0.15;
  T.dateOut = L.L28.t + 2.45;                 // 说完「一月」，字卡化开，水里的画面渗出来
  T.impact = L.L28.t + 3.23;                  // 「撞」：一头撞进网里
  T.netShut = L.L28.t + 4.15;                 // 「网」：网收拢
  // 挣扎：每一下甩尾甩出一串墨点
  T.thrash = [];
  for (let t = T.impact + 0.3, k = 0; t < T.sky - 0.12; t += 0.36 + 0.06 * ((k * 7) % 3), k++) T.thrash.push(t);
  T.haul = T.sky - 0.55;                       // 网往上拖
  // ---- 天 ----
  // L29 包络：0.44–2.26 s；H01「我的妈呀」0.36–0.98，「好大一条象鱼」1.36–2.46
  T.sun = L.L29.t + 0.3;
  T.faces = L.H01.t - 1.0;                     // 岸上的人探头进来（逆光，模糊）
  T.shoreIn = L.H01.t + 0.25;
  // ---- 江岸 ----
  T.wow = L.H01.t + 1.36;                      // 「好大一条象鱼！」
  T.run = L.H02.t + 0.5;                       // 「快去喊渔政的人来」：一个人跑去喊
  // ---- 抬 ----
  // H03 包络：「八个人都抬不动」0.36–1.38，「拿棉被来」1.98–2.52，「包起」2.82–3.16
  T.liftIn = L.H03.t - 0.35;
  T.strain = L.H03.t + 0.55;                   // 八个人一起使劲，没抬动
  T.cloth = L.H03.t + 2.45;                    // 棉被甩上来，盖住她
  T.wrap = L.H03.t + 2.85;                     // 「包起」
  T.lift = L.H03.t + 3.45;                     // 裹在棉被里，抬起来了
  // ---- 棉被（很暖） ----
  T.quiltIn = L.L30.t + 0.45;
  T.warm = L.L31.t - 0.35;                     // 赭石开始在棉被里洇开（「很暖」0.46–1.10）
  // ---- 网箱船：量、卵、缝、信标 ----
  T.boatIn = T.cage - 0.3;
  T.measure = L.H04.t + 0.3;                   // 「雌性」时尺开始量（H04：「雌性」0.44–0.90，「三米五二」1.28–2.08）
  T.measureEnd = L.H04.t + 2.05;               // 「二」落下时量到尾尖
  T.eggs = L.H05.t + 0.3;                      // 「……肚子里有卵」0.44–1.72
  T.stitches = [];
  for (let i = 0; i < STITCH_N; i++) T.stitches.push(T.stitchEnd - (STITCH_N - 1 - i) * STITCH_DT);
  T.knot = T.stitchEnd + 0.35;
  T.clip = L.L33.t + 1.95;                     // 「装了」：信标扣上背（L33：「又在我背上」0.42–1.60，「装了一个会叫的小东西」1.94–3.70）
  T.pings = [];
  for (let k = 0; ; k++) { const t = T.ping0 + k * PING_DT; if (t >= T.crash) break; T.pings.push(t); }
  T.pingCut = T.pings.filter((t) => t + PING_RING > T.crash);   // 触礁那一下：圈断在半截
  // ---- 放流 ----
  T.letGo = L.H06.t + 0.45;                    // 「放吧」0.44–0.92
  T.riverIn = L.H06.t + 0.9;
  T.turn = L.L34.t + 2.75;                     // 「然后转过身」2.54–3.56
  T.upstream = L.L34.t + 3.72;                 // 「往上游走」
  // ---- 夜 ----
  T.nightIn = T.night - 0.55;
  T.engine = T.night + 0.4;                    // 跟踪船的引擎
  T.rocks = L.H08.t + 0.3;                     // 「前面是金鸡尾，石头多」
  T.lost = L.H09.t + 0.3;                      // 「信号……」
  // ---- 等 ----
  T.waitIn = L.H09.t + L.H09.dur + 0.1;
  T.lampOut = L.L36.t + 0.3;                   // 「你们没有来」：远处那点灯熄了
  T.bleed = L.L36.t + L.L36.dur - 0.25;         // 墨慢慢洇开，铺满
  T.bleedEnd = T.end - 0.3;
  return T;
}

export function events(tl) {
  const T = schedule(tl);
  const ev = [];
  ev.push({ t: T.dateIn, id: 'date', kind: 'card', note: '纸上小楷日期淡墨渗出' });
  ev.push({ t: T.impact, id: 'net', kind: 'impact', note: '撞进网' });
  ev.push({ t: T.netShut, id: 'net', kind: 'close', note: '网收拢' });
  T.thrash.forEach((t, i) => ev.push({ t, id: 'thrash', kind: 'splatter', i, note: '甩尾，墨点飞溅' }));
  ev.push({ t: T.sky, id: 'splash', kind: 'out_of_water', note: '被拖出水，画面过曝' });
  ev.push({ t: T.strain, id: 'lift', kind: 'strain', note: '八个人使劲，没抬动' });
  ev.push({ t: T.cloth, id: 'cloth', kind: 'quilt', note: '棉被甩上来盖住她' });
  ev.push({ t: T.lift, id: 'lift', kind: 'heave', note: '裹着棉被抬起来' });
  ev.push({ t: T.warm, id: 'cloth', kind: 'warm', dur: 1.8, note: '棉被特写，赭石暖色洇开' });
  ev.push({ t: T.measure, id: 'measure', kind: 'tape', dur: T.measureEnd - T.measure, note: '带刻度的墨线从吻尖量到尾尖' });
  ev.push({ t: T.eggs, id: 'eggs', kind: 'appear', dur: 1.4, note: '腹部隐约的卵点' });
  T.stitches.forEach((t, i) => ev.push({ t, id: 'stitch', kind: 'needle', i, note: `第 ${i + 1} 针穿过` }));
  ev.push({ t: T.knot, id: 'stitch', kind: 'knot', note: '打结剪线' });
  ev.push({ t: T.clip, id: 'clip', kind: 'tag', note: '信标扣上背' });
  T.pings.forEach((t, i) => ev.push({ t, id: 'ping', kind: 'beep', i, cut: t + PING_RING > T.crash, note: t + PING_RING > T.crash ? '最后一声：圈荡到一半被触礁截断' : '嘀' }));
  ev.push({ t: T.release, id: 'release', kind: 'into_water', note: '放流入水' });
  ev.push({ t: T.turn, id: 'turn', kind: 'swim', note: '在下游折返，转身往上游' });
  ev.push({ t: T.engine, id: 'engine', kind: 'start', note: '夜里跟踪船引擎起' });
  ev.push({ t: T.crash, id: 'crash', kind: 'reef', note: '触礁：墨炸开，灯晃，画面一抖，嘀声和圈断掉' });
  ev.push({ t: T.lampOut, id: 'lamp', kind: 'out', dur: 1.2, note: '远处的灯熄了' });
  ev.push({ t: T.bleed, id: 'bleed', kind: 'ink', dur: T.bleedEnd - T.bleed, note: '墨洇开铺满画面，变成极深的褐黑' });
  return ev.sort((a, b) => a.t - b.t);
}
