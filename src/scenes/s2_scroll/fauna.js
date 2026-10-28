// S2 长卷的恐龙：蜥脚类（写意大笔，像画水牛那样用侧锋一两笔带出体块）、翼龙（几笔）
import { stroke, wash, dot, rng, vn1, tubePoly } from '../../film/ink.js';
import { twin } from './land.js';

const lerp = (a, b, t) => a + (b - a) * t;
const ss = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

/**
 * 蜥脚类（没骨）：整个形体（身、颈、尾、近侧两腿、头）拼成一块墨一次染出——背深腹浅、湿边、墨晕；
 * 远侧两腿先用淡墨染；最后几笔焦墨提神：背脊（干笔飞白）、颈上沿、膝与足。
 * x,y = 前脚落地点；s = 肩高；o.dir -1 头朝左（默认）；o.drink 低头饮水；tone 浓淡。
 * 局部坐标 u 朝头为正、v 朝上为正（单位 = 肩高）。
 */
export function sauropod(buf, x, y, s, o = {}) {
  if (!buf) return;
  const seed = o.seed ?? 1, R = rng(seed * 41 + 13), d = o.dir ?? -1, tone = o.tone ?? 0.8, T = o.tw;
  const Q = (u, v) => [x + (d === -1 ? -u : u) * s, y - v * s];
  const Qr = (u, v, r) => [...Q(u, v), r * s];
  // 远侧两腿（淡）
  const farLegs = [0.22, -0.8].map((u) => tubePoly([Qr(u + 0.02, 0.62, 0.07), Qr(u - 0.01, 0.34, 0.062), Qr(u + 0.02, 0.04, 0.068)]));
  wash(buf, farLegs, { tone: tone * 0.3, rim: 0.45, rimW: 2, soft: 1, jag: 1.2, jagScale: 10, bleed: 2.5, bleedK: 0.45, gran: 0.5, bloom: 0.35, bloomScale: 30, seed: seed * 3,
    gfn: (wx, wy) => 0.75 + 0.25 * ss(y, y - 0.6 * s, wy), ...twin(T, 0, 0.35) });
  // 主体
  const body = [];
  for (let k = 0; k < 40; k++) {
    const th = (k / 40) * Math.PI * 2;
    const c = Math.cos(th), sn = Math.sin(th);
    const hump = sn > 0 ? 0.06 * Math.pow(sn, 2) * (0.6 - 0.4 * c) : 0;      // 臀部略高
    const belly = sn < 0 ? -0.04 * Math.pow(-sn, 3) : 0;                    // 肚子下坠
    body.push(Q(-0.5 + 0.86 * c, 0.8 + (0.28 + hump) * sn + belly));
  }
  const neckCtl = o.drink
    ? [[0.12, 0.84, 0.19], [0.46, 1.0, 0.14], [0.86, 0.93, 0.1], [1.2, 0.64, 0.072], [1.4, 0.3, 0.055], [1.48, 0.1, 0.048]]
    : [[0.12, 0.86, 0.2], [0.4, 1.16, 0.14], [0.6, 1.52, 0.1], [0.72, 1.86, 0.07], [0.78, 2.06, 0.055]];
  const neck = tubePoly(neckCtl.map(([u, v, r]) => Qr(u, v, r)));
  const tail = tubePoly([Qr(-1.15, 0.9, 0.17), Qr(-1.65, 0.82, 0.12), Qr(-2.15, 0.64, 0.075), Qr(-2.65, 0.5, 0.04), Qr(-3.1, 0.44, 0.012)]);
  const legs = [0.04, -0.98].map((u) => tubePoly([Qr(u + 0.03, 0.72, 0.09), Qr(u - 0.01, 0.36, 0.078), Qr(u + 0.02, 0.05, 0.085)]));
  const hp = Q(neckCtl[neckCtl.length - 1][0], neckCtl[neckCtl.length - 1][1]);
  const hq = Q(neckCtl[neckCtl.length - 2][0], neckCtl[neckCtl.length - 2][1]);
  const ang = Math.atan2(hp[1] - hq[1], hp[0] - hq[0]);
  const head = [];
  for (let k = 0; k < 14; k++) { const th = (k / 14) * Math.PI * 2; const ca = Math.cos(ang), sa = Math.sin(ang); const lx = Math.cos(th) * s * 0.085 + s * 0.04, ly = Math.sin(th) * s * 0.045; head.push([hp[0] + lx * ca - ly * sa, hp[1] + lx * sa + ly * ca]); }
  const yTop = y - 1.15 * s, yBot = y - 0.45 * s;
  wash(buf, [body, neck, tail, ...legs, head], { tone: tone * 0.62, rim: 0.55, rimW: 2.4, soft: 1, jag: 1.4, jagScale: 14, bleed: 3, bleedK: 0.5, gran: 0.5, bloom: 0.45, bloomScale: 40, streak: 0.12, streakAng: 0.1,
    seed: seed * 3 + 1, gfn: (wx, wy) => 0.52 + 0.48 * (1 - ss(yTop, yBot, wy)) * (0.85 + 0.15 * vn1(wx * 0.02)), ...twin(T, 0.1, 0.55) });
  // 焦墨提神
  stroke(buf, [[...Q(0.2, 0.98), 0.5], [...Q(-0.15, 1.08), 1], [...Q(-0.6, 1.12), 0.9], [...Q(-1.05, 1.06), 0.8], [...Q(-1.45, 0.95), 0.4]], { w: s * 0.05, tone: Math.min(0.97, tone * 1.15), dry: 0.5, dryEnd: 0.8, rough: 0.12, fray: 0.5, seed: seed * 3 + 6, ...twin(T, 0.55, 0.7) });
  const nTop = neckCtl.map(([u, v, r], i) => [...Q(u, v + r * 0.75), 0.9 - i * 0.1]);
  stroke(buf, nTop, { w: s * 0.035, tone: Math.min(0.97, tone * 1.05), dry: 0.3, dryEnd: 0.7, seed: seed * 3 + 7, tail: 0.4, ...twin(T, 0.6, 0.75) });
  dot(buf, hp[0] + Math.cos(ang) * s * 0.05, hp[1] + Math.sin(ang) * s * 0.05, s * 0.05, { ax: 1.7, ang, tone: Math.min(0.97, tone * 1.15), jag: 0.2, rim: 0.3, halo: 1.4, seed: seed * 3 + 4, ...twin(T, 0.7, 0.75) });
  for (const [u, i] of [[0.04, 0], [-0.98, 1]]) {
    stroke(buf, [[...Q(u + 0.1, 0.5), 0.8], [...Q(u + 0.1, 0.36), 1], [...Q(u + 0.12, 0.2), 0.5]], { w: s * 0.03, tone: Math.min(0.97, tone * 1.1), dry: 0.3, tail: 0.4, seed: seed * 30 + i, ...twin(T, 0.7, 0.8) });
    stroke(buf, [[...Q(u - 0.07, 0.03), 0.8], [...Q(u + 0.04, 0.02), 1], [...Q(u + 0.12, 0.035), 0.6]], { w: s * 0.04, tone: Math.min(0.97, tone * 1.1), tail: 0.3, seed: seed * 40 + i, ...twin(T, 0.75, 0.85) });
  }
  // 地上一抹影、饮水处的涟漪
  wash(buf, [Q(0.45, 0.02), Q(-1.35, 0.02), Q(-1.25, -0.05), Q(0.38, -0.06)], { tone: tone * 0.1, soft: s * 0.05, rim: 0.2, jag: 2, gran: 0.5, seed: seed * 3 + 8, ...twin(T, 0.6, 0.7) });
  if (o.drink) {
    const hx = hp[0] + Math.cos(ang) * s * 0.08, hy = y + s * 0.06;
    for (let k = 0; k < 3; k++) {
      const rr = s * (0.12 + k * 0.1);
      stroke(buf, [[hx - rr, hy + k * 4, 0.3], [hx, hy + k * 4 + 1.5, 1], [hx + rr, hy + k * 4, 0.3]], { w: 1.6, tone: tone * 0.5, dry: 0.2, seed: seed * 20 + k, tail: 0.4, ...twin(T, 0.75, 1) });
    }
  }
  void R;
}

/** 翼龙（侧看，往 dir 飞）：两翼各一笔「<」形（腕处前折、翼尖后掠），极淡的翼膜；身子一短笔；长喙、后冠 */
export function pterosaur(buf, x, y, s, o = {}) {
  if (!buf) return;
  const seed = o.seed ?? 1, d = o.dir ?? -1, tone = o.tone ?? 0.8, f = o.flap ?? 0.4, T = o.tw;
  const Q = (u, v, p = 1) => [x + (d === -1 ? -u : u) * s, y - v * s, p];
  // 每只翼一笔侧锋：根部宽、腕处折、翼尖细而后掠（像写意画燕子的翅）
  const wing = (k, sd, tn, w, t0, t1) => {
    const S = Q(-0.02 * k, 0.02), W = Q(0.1 * k, (0.24 + 0.2 * f) * k), M = Q(-0.06 * k, (0.4 + 0.24 * f) * k), Tp = Q(-0.36 * k, (0.5 + 0.26 * f) * k);
    stroke(buf, [[...S, 1], [...W, 0.85], [...M, 0.5], [...Tp, 0.05]], { w: s * w, tone: tn, shade: 0.5 * (d === -1 ? -1 : 1), tail: 0.55, head: 0.15, dry: 0.1, dryEnd: 0.55, halo: 1, seed: sd + 1, ...twin(T, t0, t1) });
  };
  wing(0.75, seed * 3, tone * 0.45, 0.1, 0, 0.5);
  wing(1, seed * 3 + 2, tone, 0.13, 0.1, 0.6);
  stroke(buf, [[...Q(0.1, 0.02), 0.9], [...Q(-0.04, -0.01), 1], [...Q(-0.2, -0.045), 0.3]], { w: s * 0.065, tone, tail: 0.5, seed: seed * 3 + 4, ...twin(T, 0.3, 0.7) });
  stroke(buf, [[...Q(0.09, 0.035), 1], [...Q(0.2, 0.025), 0.7], [...Q(0.34, -0.005), 0.1]], { w: s * 0.036, tone, tail: 0.7, seed: seed * 3 + 5, ...twin(T, 0.6, 0.8) });
  stroke(buf, [[...Q(0.11, 0.05), 0.8], [...Q(0.02, 0.12), 0.15]], { w: s * 0.028, tone, tail: 0.7, seed: seed * 3 + 6, ...twin(T, 0.7, 0.9) });
  stroke(buf, [[...Q(-0.17, -0.04), 0.7], [...Q(-0.27, -0.08), 0.2]], { w: s * 0.02, tone: tone * 0.8, tail: 0.6, seed: seed * 3 + 7, ...twin(T, 0.7, 0.9) });
  void lerp;
}
