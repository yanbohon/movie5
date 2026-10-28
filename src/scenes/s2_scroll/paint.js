// S2 长卷的静态墨层（建场景时一次画好）：K = { far, main, river }，每遍只有一个非空，按通道分遍画
// far：远山（视差层，坐标是远山层坐标 P.farX(x)）；main：岸上的一切；river：水纹
// 构图从右往左（时间从远到近）：远古的雾与蕨 → 恐龙的河岸 → 陨石落点 → 新生代的山（现场长）与雪山 → 岸上有人
// → 「鲔」字的留白 → 周的宗庙与天子舟 → 唐宋的柳岸、罾、诗船、帆、米家山、村落 → 近代（现场画）→ 坝 → 上游的空
import { stroke, wash, dot, rng, vn1, paddlefish, figure, waterLines, erase } from '../../film/ink.js';
import { HS, Y_BANK, X_DAM, X_PLATE } from './plan.js';
import * as M from './motifs.js';
import * as LD from './land.js';
import * as FL from './flora.js';

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 留白：近处的东西（屋、船、帆、近山）先把后面让出来。
 * 蒙版那一遍把形画进 A 通道（着色器用它压掉远山、水纹、鱼）；主墨那一遍把已经画上的墨擦掉（o.main=false 时不擦）。
 */
function knocker(K) {
  return (poly, o = {}) => {
    if (!poly || !poly.length) return;
    if (K.mask) wash(K.mask, poly, { tone: o.k ?? 1, rim: 0, gran: 0, bloom: 0, bleed: 0, soft: o.soft ?? 1.5, jag: 0.6, jagScale: 10, streak: 0, gfn: o.gfn, seed: 7 });
    if (K.main && o.main !== false) erase(K.main, poly, { soft: 1.2, k: o.k ?? 1 });
  };
}
/** 近山（主墨层里的积墨山）：画 + 把后面的远山让出来 */
function nearMountain(K, x0, x1, baseY, H, o) {
  const m = LD.layerMountain(K.main, x0, x1, baseY, H, o);
  if (K.mask && m) knocker(K)(m.silhouette, { main: false, gfn: m.mistFade });
  return m;
}

export function paintStatic(P, K) {
  river(P, K.river);
  ancient(P, K);
  dino(P, K);
  impactLand(P, K);
  ceno(P, K);
  human(P, K);
  wei(P, K);
  zhou(P, K);
  tang(P, K);
  modern(P, K);
  damArea(P, K);
  plate(P, K);
}

// ---------------------------------------------------------------------------
// 河：留白为主，水纹成组（一绺一绺），疏密随时代
// ---------------------------------------------------------------------------
function river(P, B) {
  if (!B) return;
  const X = P.X;
  // x → [密度, 墨色, 回旋浪]
  const prof = [
    [2400, 0, 0.16, 0], [3200, 0.25, 0.16, 0], [4300, 0.5, 0.18, 0], [X_DAM - 40, 0.7, 0.2, 0],
    [X_DAM + 40, 1.6, 0.26, 0.05], [X.modern0, 2.2, 0.3, 0.1], [X.modern1, 2.2, 0.3, 0.1], [X.tangEnd, 1.9, 0.26, 0.12], [X.tang + 300, 1.9, 0.26, 0.12],
    [X.zhou, 1.5, 0.24, 0.06], [X.human, 1.2, 0.22, 0.03], [X.glacier, 1.1, 0.22, 0.02], [X.mount, 1.1, 0.22, 0.02], [X.impact, 1.0, 0.22, 0.02], [X.dino, 1.0, 0.22, 0.02], [X.ancient, 0.9, 0.2, 0.02], [P.LEN, 0.9, 0.2, 0.02],
  ].sort((a, b) => a[0] - b[0]);
  const at = (x, k) => {
    for (let i = 1; i < prof.length; i++) if (x <= prof[i][0]) { const a = prof[i - 1], b = prof[i]; return lerp(a[k], b[k], (x - a[0]) / Math.max(1, b[0] - a[0])); }
    return prof[prof.length - 1][k];
  };
  const R = rng(9001);
  const step = 400;
  let seed = 1;
  for (let x = 2400; x < P.LEN; x += step) {
    const dens = at(x + step / 2, 1), tone = at(x + step / 2, 2), curls = at(x + step / 2, 3);
    if (dens <= 0.01) continue;
    // 一绺一绺的长水纹：每绺 2–4 条，平行、错开
    const ng = Math.round(dens * 1.6 * (0.6 + 0.8 * R.f()));
    for (let g = 0; g < ng; g++) {
      const gy = lerp(Y_BANK + 40, HS - 30, Math.pow(R.f(), 0.9));
      const gx = x + R.r(-100, step);
      const len = R.r(180, 520) * (0.7 + 0.6 * (gy - Y_BANK) / (HS - Y_BANK));
      const n = R.i(2, 4);
      for (let k = 0; k < n; k++) {
        const yy = gy + k * R.r(6, 11), xx = gx + k * R.r(-30, 40);
        const l = len * R.r(0.55, 1);
        const amp = R.r(1.2, 3.2), per = R.r(90, 180), ph = R.f() * 6.28;
        const pts = [];
        const ns = Math.max(3, Math.round(l / 40));
        for (let s = 0; s <= ns; s++) {
          const u = s / ns, px = xx + l * u;
          pts.push([px, yy + Math.sin(px / per * 6.283 + ph) * amp + (vn1(px * 0.01 + k * 7 + g) - 0.5) * 2.5, 0.3 + 0.7 * Math.sin(Math.PI * u)]);
        }
        stroke(B, pts, { w: R.r(1.1, 2.1), tone: tone * R.r(0.55, 1), dry: R.r(0.1, 0.35), dryEnd: R.r(0.45, 0.85), head: 0.2, tail: 0.35, rough: 0.1, halo: 1.2, haloK: 0.25, fade: 0.3, seed: seed++ });
        if (curls > 0 && R.f() < curls) {
          const cx = xx + l * R.r(0.3, 0.7), cy = yy - 2, rr = R.r(4, 8);
          const arc = [];
          for (let q = 0; q <= 8; q++) { const a = Math.PI * (1 + q / 8 * 1.3); arc.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.6, 0.8]); }
          stroke(B, arc, { w: 1.2, tone: tone * 0.75, seed: seed++, tail: 0.5 });
        }
      }
    }
    // 近岸：几道短水纹
    waterLines(B, x, x + step, Y_BANK + 8, Y_BANK + 40, { density: dens * 1.4, tone: tone * 0.9, seed: seed++, minLen: 40, maxLen: 150, calm: 1.5, minW: 0.9, maxW: 1.6 });
  }
}

// ---------------------------------------------------------------------------
// 远古：雾中的河，树蕨、苏铁、蕨、木贼（开场第一屏）
// ---------------------------------------------------------------------------
function ancient(P, K) {
  const X = P.X, x0 = X.first - 60, x1 = P.LEN;
  // 远山：淡、层层没进雾里
  LD.farRange(K.far, P.farX(x0) - 200, P.farX(x1) + 150, 505, 250, { tone: 0.2, layers: 3, peaks: 4, seed: 11, cuts: true });
  if (!K.main && !K.mask) return;
  const B = K.main;
  LD.shore(B, x0, x1, Y_BANK, { tone: 0.42, seed: 21, gh: 26, spits: 2, heavy: 0.35 });
  // 右：一片坡岸，树蕨成林（开场的主体）
  nearMountain(K, 17020, 17800, Y_BANK + 4, 120, { tone: 0.5, layers: 2, seed: 23, mist: 0.2, frontK: 0.6, drop: 0.02, peaks: 2, mossK: 1.4 });
  FL.treeFern2(B, 17290, Y_BANK - 26, 400, { seed: 41, tone: 0.86, lean: -0.1 });
  FL.treeFern2(B, 17560, Y_BANK - 34, 300, { seed: 42, tone: 0.6, lean: 0.14 });
  FL.treeFern2(B, 17080, Y_BANK - 8, 235, { seed: 43, tone: 0.78, lean: -0.22 });
  FL.treeFern2(B, 17730, Y_BANK - 30, 250, { seed: 44, tone: 0.4, lean: 0.05 });
  FL.cycad2(B, 17360, Y_BANK - 8, 175, { seed: 45, tone: 0.85 });
  FL.cycad2(B, 16990, Y_BANK + 2, 120, { seed: 46, tone: 0.75 });
  FL.fern2(B, 17200, Y_BANK - 4, 95, { seed: 47, tone: 0.8, croziers: 2 });
  FL.fern2(B, 17560, Y_BANK - 16, 80, { seed: 48, tone: 0.7 });
  FL.horsetail(B, 16900, Y_BANK + 4, 80, 7, { seed: 49, tone: 0.65 });
  // 中：雾里远远的一对树蕨（淡）
  FL.treeFern2(B, 16560, Y_BANK - 6, 190, { seed: 51, tone: 0.32, lean: 0.08 });
  FL.treeFern2(B, 16640, Y_BANK - 2, 150, { seed: 52, tone: 0.26, lean: -0.12 });
  FL.fern2(B, 16600, Y_BANK + 2, 60, { seed: 53, tone: 0.35 });
  // 左：沙洲，苏铁与蕨
  nearMountain(K, 15900, 16420, Y_BANK + 4, 70, { tone: 0.42, layers: 2, seed: 55, mist: 0.15, frontK: 0.7, drop: 0.02, peaks: 1 });
  FL.cycad2(B, 16150, Y_BANK - 20, 140, { seed: 56, tone: 0.72 });
  FL.fern2(B, 16020, Y_BANK - 10, 85, { seed: 57, tone: 0.65 });
  FL.fern2(B, 16300, Y_BANK - 8, 70, { seed: 58, tone: 0.55 });
  FL.horsetail(B, 16390, Y_BANK + 2, 60, 5, { seed: 59, tone: 0.55 });
}

// ---------------------------------------------------------------------------
// 恐龙（恐龙本身在化灰精灵里，这里是它们身边的世界）
// ---------------------------------------------------------------------------
function dino(P, K) {
  const X = P.X;
  LD.farRange(K.far, P.farX(14700), P.farX(15800), 510, 200, { tone: 0.17, layers: 2, peaks: 3, seed: 71 });
  if (!K.main) return;
  const B = K.main;
  LD.shore(B, 14600, X.first - 60, Y_BANK, { tone: 0.4, seed: 72, gh: 22, spits: 1 });
  FL.cycad2(B, 15700, Y_BANK - 4, 130, { seed: 91, tone: 0.7 });
  FL.fern2(B, 15600, Y_BANK - 2, 70, { seed: 92, tone: 0.6 });
  FL.horsetail(B, 15470, Y_BANK + 4, 60, 6, { seed: 94, tone: 0.55 });
  FL.fern2(B, 14760, Y_BANK - 2, 60, { seed: 93, tone: 0.5 });
  FL.treeFern2(B, 15080, Y_BANK - 10, 170, { seed: 95, tone: 0.35 });
}

// ---------------------------------------------------------------------------
// 陨石落点附近：一片平野（焦土在精灵里）
// ---------------------------------------------------------------------------
function impactLand(P, K) {
  LD.farRange(K.far, P.farX(14150), P.farX(14800), 515, 150, { tone: 0.15, layers: 2, peaks: 3, seed: 111 });
  if (!K.main) return;
  const B = K.main;
  LD.shore(B, 14180, 14620, Y_BANK, { tone: 0.38, seed: 112, gh: 18 });
  FL.horsetail(B, 14320, Y_BANK + 2, 50, 4, { seed: 114, tone: 0.45 });
}

// ---------------------------------------------------------------------------
// 新生代：山（现场长）背后的远山、雪山（以墨留白）、寒林、冰退后的新绿
// ---------------------------------------------------------------------------
function ceno(P, K) {
  const X = P.X;
  LD.farRange(K.far, P.farX(12900), P.farX(14400), 470, 300, { tone: 0.15, layers: 2, peaks: 4, seed: 121 });
  if (!K.main) return;
  const B = K.main;
  LD.shore(B, 12000, 14200, Y_BANK, { tone: 0.4, seed: 122, gh: 20 });
  // 雪山：天染灰，把山的白让出来
  LD.snowRange(B, 12180, 12930, Y_BANK - 6, 290, { seed: 131, skyPad: 160, skyTone: 0.22, tongue: [12560, 34] });
  // 寒林：雪山脚下几株枯树
  FL.tree2(B, 12140, Y_BANK + 2, 150, { kind: 'bare', seed: 141, tone: 0.9, lean: 0.06 });
  FL.tree2(B, 12220, Y_BANK + 4, 115, { kind: 'bare', seed: 142, tone: 0.8, lean: -0.1 });
  FL.tree2(B, 12950, Y_BANK + 2, 105, { kind: 'bare', seed: 143, tone: 0.75 });
  // 冰退：新绿（山脚的点叶树）
  FL.treeGroup(B, 12020, Y_BANK + 2, 105, 3, { seed: 151, tone: 0.8, kinds: ['dot', 'jie', 'dot'] });
  void X;
}

// ---------------------------------------------------------------------------
// 岸上有了人（人、火、茅屋、独木舟在精灵里）
// ---------------------------------------------------------------------------
function human(P, K) {
  const X = P.X;
  LD.farRange(K.far, P.farX(11300), P.farX(12200), 520, 150, { tone: 0.14, layers: 2, peaks: 3, seed: 161 });
  if (!K.main) return;
  const B = K.main;
  LD.shore(B, 11300, 12000, Y_BANK, { tone: 0.42, seed: 162, gh: 26 });
  FL.treeGroup(B, X.human + 150, Y_BANK - 2, 135, 3, { seed: 171, tone: 0.85, kinds: ['dot', 'heng', 'dot'] });
  FL.tree2(B, X.human - 420, Y_BANK, 120, { kind: 'jie', seed: 173, tone: 0.75 });
  FL.reeds2(B, X.human - 200, Y_BANK + 6, 8, 50, { seed: 174, tone: 0.5 });
}

// ---------------------------------------------------------------------------
// 「鲔」这一段：天上大片留白给字，岸上简淡
// ---------------------------------------------------------------------------
function wei(P, K) {
  const X = P.X;
  LD.farRange(K.far, P.farX(X.wei - 700), P.farX(X.wei + 400), 530, 90, { tone: 0.1, layers: 2, peaks: 3, seed: 181, cuts: false });
  if (!K.main) return;
  const B = K.main;
  LD.shore(B, X.wei - 600, 11300, Y_BANK, { tone: 0.38, seed: 182, gh: 18, spits: 1 });
  FL.reeds2(B, X.wei + 260, Y_BANK + 6, 9, 60, { seed: 183, tone: 0.5 });
  FL.reeds2(B, X.wei - 460, Y_BANK + 6, 6, 44, { seed: 184, tone: 0.42 });
}

// ---------------------------------------------------------------------------
// 周：岸上高台宗庙、鼎、松；抬鱼进庙的人；江上天子的舟（华盖、桨手、旌旗）
// ---------------------------------------------------------------------------
export function zhouLayout(P) {
  const X = P.X;
  return { temple: X.zhou - 700, ding: X.zhou - 505, carry: X.zhou - 330, crowd: X.zhou - 190, boatBow: X.zhou - 250, boatY: 648 };
}
function zhou(P, K) {
  const X = P.X, Z = zhouLayout(P);
  LD.farRange(K.far, P.farX(9250), P.farX(10950), 480, 250, { tone: 0.18, layers: 3, peaks: 4, seed: 191, cuts: true });
  if (!K.main && !K.mask) return;
  const B = K.main, kn = knocker(K);
  LD.shore(B, 9220, X.wei - 600, Y_BANK, { tone: 0.44, seed: 192, gh: 28 });
  // 庙后的山
  nearMountain(K, Z.temple - 300, Z.temple + 330, Y_BANK - 20, 230, { tone: 0.42, layers: 2, seed: 193, mist: 0.4, ridgeTrees: 3, frontK: 0.6 });
  // 高台（夯土）
  const ty = Y_BANK - 34;
  const terrace = [[Z.temple - 232, ty], [Z.temple + 232, ty], [Z.temple + 264, Y_BANK - 2], [Z.temple - 264, Y_BANK - 2]];
  kn(terrace);
  wash(B, terrace, { tone: 0.22, rim: 0.45, jag: 1.2, jagScale: 10, gran: 0.6, streak: 0.4, streakAng: 0.02, seed: 194 });
  stroke(B, [[Z.temple - 236, ty, 0.8], [Z.temple, ty - 1, 1], [Z.temple + 236, ty, 0.8]], { w: 3, tone: 0.85, dry: 0.25, dryEnd: 0.5, seed: 195 });
  for (let i = 0; i < 5; i++) stroke(B, [[Z.temple + 150, ty + 6 + i * 6, 1], [Z.temple + 210 + i * 10, ty + 6 + i * 6, 0.8]], { w: 1.6, tone: 0.6, seed: 196 + i });
  FL.tree2(B, Z.temple - 250, ty + 4, 240, { kind: 'pine', seed: 197, tone: 0.9, lean: 0.12 });
  M.temple(B, Z.temple, ty, 240, { seed: 199, knock: kn });
  FL.tree2(B, Z.temple + 210, ty + 2, 180, { kind: 'pine', seed: 198, tone: 0.78, lean: -0.1 });
  M.ding(B, Z.ding, Y_BANK - 4, 30, { seed: 200 });
  // 抬鱼的两个人（荐鲔于寝庙）：一根杠子，鱼吊在中间
  const cx = Z.carry;
  figure(B, cx - 38, Y_BANK - 2, 50, { pose: 'carry', dir: -1, seed: 201 });
  figure(B, cx + 38, Y_BANK - 2, 50, { pose: 'carry', dir: -1, seed: 202 });
  paddlefish(B, cx - 52, Y_BANK - 26, 104, { style: 'xieyi', dir: -1, tone: 0.85, seed: 203, ang: 0.04 });
  for (let i = 0; i < 4; i++) figure(B, Z.crowd + i * 28, Y_BANK - 2, 44 + (i % 2) * 4, { pose: 'stand', dir: -1, seed: 210 + i, hat: i % 2 === 0 });
  // 天子舟：船头朝左（逆流而上往宗庙去）
  const bx = Z.boatBow, by = Z.boatY;
  const gx = bx + 215, gy = by - 124;
  kn([[gx - 82, gy + 16], [gx - 58, gy - 10], [gx, gy - 27], [gx + 58, gy - 10], [gx + 82, gy + 16], [gx + 8, by - 14], [gx - 8, by - 14]]);
  kn([[bx + 380, by - 22], [bx + 386, by - 174], [bx + 322, by - 164], [bx + 318, by - 128], [bx + 378, by - 132]]);
  M.hull(B, bx, by, 420, { dir: -1, tone: 0.88, h: 36, rise: 30, sternRise: 1.3, fill: 0.5, seed: 220, knock: kn });
  stroke(B, [[gx, by - 14, 1], [gx + 1, gy - 6, 0.8]], { w: 3.2, tone: 0.9, seed: 221 });
  wash(B, [[gx - 76, gy + 14], [gx - 56, gy - 8], [gx, gy - 24], [gx + 56, gy - 8], [gx + 76, gy + 14], [gx, gy + 3]], { tone: 0.78, rim: 0.45, jag: 1.2, jagScale: 10, bleed: 2, seed: 222, streak: 0.3, gran: 0.5 });
  stroke(B, [[gx - 80, gy + 15, 0.6], [gx - 40, gy + 6, 1], [gx, gy + 3, 1], [gx + 40, gy + 6, 1], [gx + 80, gy + 15, 0.6]], { w: 2.6, tone: 0.92, seed: 223 });
  for (let i = 0; i < 15; i++) { const u = i / 14, fx = gx - 74 + u * 148, fy = gy + 14 - Math.sin(u * Math.PI) * 11; stroke(B, [[fx, fy, 1], [fx + 1, fy + 13, 0.3]], { w: 1.3, tone: 0.7, seed: 224 + i, tail: 0.5 }); }
  figure(B, gx, by - 18, 54, { pose: 'sit', dir: -1, seed: 240, hat: true });
  // 桨手：一排人俯身，桨斜插进水
  for (let i = 0; i < 5; i++) {
    const rx = bx + 70 + i * 28;
    if (Math.abs(rx - gx) < 44) continue;
    figure(B, rx, by - 16, 34, { pose: 'row', dir: -1, seed: 250 + i, pole: 1.35 });
  }
  stroke(B, [[bx + 380, by - 22, 1], [bx + 383, by - 170, 0.6]], { w: 2.4, tone: 0.88, seed: 270 });
  wash(B, [[bx + 383, by - 170], [bx + 326, by - 160], [bx + 340, by - 145], [bx + 322, by - 132], [bx + 382, by - 136]], { tone: 0.6, rim: 0.45, jag: 1, seed: 271, gran: 0.5 });
  figure(B, bx + 398, by - 18, 40, { pose: 'row', dir: 1, seed: 272, pole: 1.1 });
}

// ---------------------------------------------------------------------------
// 唐宋：柳岸与罾、撒网的渔舟、松石下的诗船、顺流的帆、米家山、村落与亭（组与组之间留出水和雾）
// ---------------------------------------------------------------------------
export function tangLayout(P) {
  const X = P.X;
  return { willow: 9000, lift: 8880, cast: 8760, rock: 8480, poet: 8440, sail1: 8110, sail2: 7930, village: 7640, pavilion: 7380, x0: X.tangEnd - 250, x1: 9200 };
}
function tang(P, K) {
  const G = tangLayout(P);
  // 米家山：远处一片（视差层），淡而软，峰与峰之间有雾
  if (K.far) {
    const peaks = [[7200, 200], [7780, 260], [8350, 230], [8950, 280], [9450, 190]];
    peaks.forEach(([cx, h], i) => LD.miMountain(K.far, P.farX(cx) - 360, P.farX(cx) + 360, 525 - (i % 2) * 14, h, { tone: 0.3, seed: 280 + i, trees: 2, fadeH: 0.55, peaks: 2 + (i % 2) }));
  }
  if (!K.main && !K.mask) return;
  const B = K.main, R = rng(601), kn = knocker(K);
  LD.shore(B, G.x0, G.x1, Y_BANK, { tone: 0.46, seed: 290, gh: 26, spits: 2 });
  // 柳岸 + 罾
  FL.willow2(B, G.willow + 70, Y_BANK + 2, 240, { seed: 291, tone: 0.82, lean: 0.1 });
  FL.willow2(B, G.willow - 60, Y_BANK - 2, 185, { seed: 292, tone: 0.62, lean: -0.12 });
  liftNet(B, G.lift, Y_BANK, 293);
  // 撒网的渔舟
  M.hull(B, G.cast, 716, 140, { dir: -1, tone: 0.82, h: 14, rise: 9, fill: 0.42, seed: 303, knock: kn });
  figure(B, G.cast + 60, 706, 42, { pose: 'stand', dir: -1, seed: 304, hat: true });
  castNet(B, G.cast + 36, 672, 305);
  // 松石：一块石坡，两株松，石下泊着诗船
  nearMountain(K, G.rock - 170, G.rock + 170, Y_BANK + 2, 150, { tone: 0.62, layers: 2, seed: 294, mist: 0.05, frontK: 0.65, drop: 0.02, peaks: 1, mossK: 2 });
  FL.tree2(B, G.rock - 40, Y_BANK - 108, 200, { kind: 'pine', seed: 295, tone: 0.92, lean: -0.16 });
  FL.tree2(B, G.rock + 70, Y_BANK - 68, 145, { kind: 'pine', seed: 296, tone: 0.8, lean: 0.2 });
  poetBoat(B, G.poet, 676, 297, kn);
  // 顺流的帆（船头朝右）
  M.sail(B, G.sail1 - 100, 612, 176, { dir: 1, seed: 299, tone: 0.6, knock: kn });
  M.hull(B, G.sail1, 626, 200, { dir: 1, tone: 0.82, h: 19, rise: 10, fill: 0.42, seed: 298, knock: kn });
  figure(B, G.sail1 - 160, 616, 30, { pose: 'stand', dir: 1, seed: 300 });
  M.sail(B, G.sail2 - 62, 592, 112, { dir: 1, seed: 302, tone: 0.4, knock: kn });
  M.hull(B, G.sail2, 602, 124, { dir: 1, tone: 0.55, h: 12, rise: 7, fill: 0.35, seed: 301, knock: kn });
  FL.reeds2(B, G.sail2 - 200, Y_BANK + 6, 9, 52, { seed: 316, tone: 0.5 });
  // 村落：几间屋、树、亭、柳
  FL.treeGroup(B, G.village + 250, Y_BANK - 4, 140, 3, { seed: 312, tone: 0.85, kinds: ['dot', 'jie', 'heng'] });
  for (let i = 0; i < 5; i++) M.house(B, G.village - 120 + i * 66 + R.r(-10, 10), Y_BANK - 6 - R.r(0, 12), 44 + R.r(-6, 8), { seed: 307 + i, knock: kn });
  FL.treeGroup(B, G.village - 230, Y_BANK - 2, 120, 2, { seed: 313, tone: 0.75, kinds: ['heng', 'dot'] });
  FL.willow2(B, G.pavilion - 110, Y_BANK, 190, { seed: 315, tone: 0.7 });
  M.pavilion(B, G.pavilion, Y_BANK - 16, 92, { seed: 314, knock: kn });
}
/** 罾：岸边的扳罾，竹竿十字撑开方网，吊在长杠杆上 */
function liftNet(B, x, y, seed) {
  const tip = [x - 150, y - 150];
  stroke(B, [[x + 40, y - 6, 1], [x - 40, y - 70, 0.9], [tip[0], tip[1], 0.5]], { w: 2.8, tone: 0.82, dry: 0.2, seed: seed * 3 });
  stroke(B, [[tip[0], tip[1], 0.6], [tip[0] - 4, y + 18, 0.6]], { w: 1.1, tone: 0.5, seed: seed * 3 + 1 });
  const nx = tip[0] - 4, ny = y + 34;
  const w = 130;
  stroke(B, [[nx - w, ny - 26, 0.6], [nx, ny - 20, 1], [nx + w, ny - 26, 0.6]], { w: 1.8, tone: 0.7, seed: seed * 3 + 2 });
  stroke(B, [[nx - w * 0.7, ny + 10, 0.5], [nx, ny - 20, 1], [nx + w * 0.7, ny + 10, 0.5]], { w: 1.6, tone: 0.6, seed: seed * 3 + 3 });
  for (let i = 0; i <= 12; i++) {
    const u = i / 12;
    stroke(B, [[lerp(nx - w, nx + w, u), ny - 26 + Math.sin(u * Math.PI) * -14, 0.6], [lerp(nx - w * 0.7, nx + w * 0.7, u), ny + 10 + Math.sin(u * Math.PI) * -22, 0.6]], { w: 0.9, tone: 0.4, dry: 0.3, seed: seed * 10 + i });
  }
  for (let j = 1; j < 4; j++) {
    const v = j / 4;
    const pts = [];
    for (let i = 0; i <= 8; i++) { const u = i / 8; pts.push([lerp(lerp(nx - w, nx - w * 0.7, v), lerp(nx + w, nx + w * 0.7, v), u), lerp(ny - 26, ny + 10, v) - Math.sin(u * Math.PI) * lerp(14, 22, v), 0.6]); }
    stroke(B, pts, { w: 0.9, tone: 0.38, dry: 0.3, seed: seed * 20 + j });
  }
  figure(B, x + 52, y - 4, 46, { pose: 'bend', dir: -1, seed: seed * 3 + 7, hat: true });
}
/** 篷船：船尾半边一道拱篷（竹篾席），船头两人对坐，一人举杯，一人执笔；小几、酒壶；船尾撑篙的船家 */
function poetBoat(B, x, y, seed, kn) {
  const cx = x + 150;                       // 篷的中心（靠船尾）
  if (kn) kn([[cx - 62, y - 12], [cx - 56, y - 50], [cx, y - 64], [cx + 56, y - 50], [cx + 62, y - 12]]);
  M.hull(B, x, y, 250, { dir: -1, tone: 0.84, h: 21, rise: 12, fill: 0.46, seed, knock: kn });
  if (!B) return;
  const arch = [];
  for (let k = 0; k <= 12; k++) { const a = Math.PI + (k / 12) * Math.PI; arch.push([cx + Math.cos(a) * 58, y - 14 + Math.sin(a) * 46]); }
  wash(B, arch, { tone: 0.34, rim: 0.5, rimW: 2, jag: 1, jagScale: 8, gran: 0.6, streak: 0.5, streakAng: 1.5, seed: seed * 3 + 1, gfn: (wx, wy) => 0.6 + 0.4 * (1 - (wy - (y - 60)) / 46) });
  stroke(B, arch.map(([px, py], k) => [px, py, 0.5 + 0.5 * Math.sin(k / 12 * Math.PI)]), { w: 2.4, tone: 0.85, dry: 0.25, dryEnd: 0.5, seed: seed * 3 + 2 });
  for (let i = 1; i < 6; i++) { const a = Math.PI + (i / 6) * Math.PI; stroke(B, [[cx + Math.cos(a) * 56, y - 14 + Math.sin(a) * 44, 0.8], [cx + Math.cos(a) * 58, y - 15, 0.5]], { w: 1.1, tone: 0.55, dry: 0.4, seed: seed * 3 + 10 + i }); }
  // 船头：两人对坐
  const px = x + 62;
  figure(B, px - 18, y - 14, 42, { pose: 'sit', dir: 1, seed: seed * 3 + 2, hat: true });
  figure(B, px + 30, y - 14, 40, { pose: 'sit', dir: -1, seed: seed * 3 + 3 });
  stroke(B, [[px - 10, y - 34, 1], [px - 1, y - 45, 0.6]], { w: 2.4, tone: 0.8, seed: seed * 3 + 4 });
  stroke(B, [[px - 2, y - 19, 1], [px + 18, y - 19, 1]], { w: 2.2, tone: 0.8, seed: seed * 3 + 5 });
  dot(B, px + 10, y - 25, 3.4, { ax: 0.8, tone: 0.85, seed: seed * 3 + 6 });
  stroke(B, [[px + 22, y - 30, 1], [px + 12, y - 36, 0.5]], { w: 1.6, tone: 0.85, seed: seed * 3 + 8 });
  figure(B, x + 225, y - 18, 42, { pose: 'row', dir: 1, seed: seed * 3 + 7, hat: true, pole: 1.3 });
}
/** 撒网：一扇细线散开 */
function castNet(B, x, y, seed) {
  const R = rng(seed);
  for (let i = 0; i < 11; i++) {
    const a = -2.6 + i * 0.12;
    const l = 70 + R.r(-8, 8);
    stroke(B, [[x, y, 0.6], [x + Math.cos(a) * l * 0.5, y + Math.sin(a) * l * 0.3 - 10, 0.8], [x + Math.cos(a) * l, y + Math.sin(a) * l * 0.2 + 30, 0.4]], { w: 1, tone: 0.45, dry: 0.3, seed: seed * 10 + i });
  }
  const arc = [];
  for (let i = 0; i <= 10; i++) { const a = -2.6 + i * 0.12; arc.push([x + Math.cos(a) * 70, y + Math.sin(a) * 14 + 30, 0.7]); }
  stroke(B, arc, { w: 1.4, tone: 0.55, dry: 0.2, seed: seed * 10 + 20 });
}

// ---------------------------------------------------------------------------
// 近代：岸（东西都在现场精灵里）；远处一层灰
// ---------------------------------------------------------------------------
function modern(P, K) {
  const X = P.X;
  if (!K.main) return;
  const B = K.main;
  LD.shore(B, X_DAM + 60, X.tangEnd - 250, Y_BANK, { tone: 0.5, seed: 322, gh: 24, grass: 14, heavy: 0.5 });
}

// ---------------------------------------------------------------------------
// 坝两侧与更上游：岸越来越淡、越来越空
// ---------------------------------------------------------------------------
function damArea(P, K) {
  if (!K.main) return;
  const B = K.main;
  LD.shore(B, X_DAM - 1400, X_DAM + 60, Y_BANK, { tone: 0.26, seed: 351, gh: 14, grass: 8 });
  LD.shore(B, X_DAM - 2600, X_DAM - 1400, Y_BANK, { tone: 0.14, seed: 352, gh: 8, grass: 3, ground: false });
}

// ---------------------------------------------------------------------------
// 卷尾：白鲟图谱（细笔勾线 + 淡墨分染）
// ---------------------------------------------------------------------------
export const PLATE_FISH = { x: X_PLATE - 760, y: 470, L: 1150 };
function plate(P, K) {
  if (!K.main) return;
  paddlefish(K.main, PLATE_FISH.x, PLATE_FISH.y, PLATE_FISH.L, { style: 'gongbi', seed: 7, tone: 0.9 });
}
void HS;
