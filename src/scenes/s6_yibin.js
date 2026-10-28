// S6 宜宾：夜。从水下仰望宜宾城，灯在水面的亮窗里碎成一圈；她从亮窗前滑过，穿过两江的分界（一边浑黄、一边青绿）→
// 回忆（电感）：卵石滩上方，一代代白鲟的光影 → 卵石滩上等了一整夜（延时：头顶的灯一盏盏熄，天往黎明走）→
// 电感：四周是空的 → 产卵：成千上万颗卵像雪一样散开、落到卵石上 → 电感：每颗卵亮起一点琥珀色 →
// 一颗一颗，暗下去 → 全暗。
import * as THREE from 'three';
import { UnderwaterWorld, makeWaterUniforms } from '../film/uw/world.js';
import { Fish, Path } from '../film/uw/fish.js';
import { bedHeight } from '../film/uw/bed.js';
import { Silt } from '../film/uw/particles.js';
import { GlowBlobs, GlowLayer, GhostSchool, BellyEggs, fishAura, E_AMBER } from '../film/uw/glow.js';
import { EggBeads } from '../film/uw/eggs.js';
import { swimTrack, shake, aim, shotAt } from '../film/uw/motion.js';
import { clamp, smooth, lerp, win } from '../film/util.js';
import { s6Times, cityOffAt, eggDeathTimes, firstEggTimes } from './s6_yibin/events.js';
import { BANK, makeBank, HerOnBank, bankEggs } from './s6_yibin/bank.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// 水的样子（真实视角）：几套预设，按时间插值
const LOOKS = {
  // 夜里的交汇处：金沙江（默认那种水）浑黄，城市的光从上面把浑水照成暖褐
  city: {
    sigma: 0.3, sigmaL: 0.1, fogUp: [0.03, 0.019, 0.0095], fogDown: [0.0032, 0.0021, 0.0011],
    ambUp: [0.035, 0.024, 0.013], ambDown: [0.004, 0.003, 0.002], sun: [0.5, 0.33, 0.17], sunDir: [0.08, 1, 0.1],
  },
  // 夜里的卵石滩
  bankNight: {
    sigma: 0.2, sigmaL: 0.12, fogUp: [0.016, 0.0105, 0.0055], fogDown: [0.0018, 0.0012, 0.0007],
    ambUp: [0.03, 0.021, 0.012], ambDown: [0.0035, 0.0025, 0.0016], sun: [0.45, 0.3, 0.16], sunDir: [0.15, 1, 0.1],
  },
  // 天快亮：灰青、很暗
  preDawn: {
    sigma: 0.19, sigmaL: 0.12, fogUp: [0.016, 0.019, 0.021], fogDown: [0.0019, 0.0021, 0.0023],
    ambUp: [0.02, 0.023, 0.025], ambDown: [0.0025, 0.0027, 0.003], sun: [0.3, 0.33, 0.36], sunDir: [0.2, 1, 0.12],
  },
};
function mixLook(a, b, k) {
  const o = {};
  for (const key of Object.keys(a)) o[key] = Array.isArray(a[key]) ? a[key].map((x, i) => lerp(x, b[key][i], k)) : lerp(a[key], b[key], k);
  return o;
}

export default async function (ctx) {
  const T = s6Times(ctx.timeline);
  const water = makeWaterUniforms();
  const world = new UnderwaterWorld(ctx, { water });
  const bank = makeBank(water);
  world.add(bank.bed.group);
  const fish = new Fish({ species: 'paddlefish', L: 3.5, water });
  fish.u.uTagAge.value = 1; // 七年的旧信标
  world.add(fish.group);
  const silt = new Silt(water, { n: 24000, box: 14, seed: 23 });
  world.add(silt.mesh);
  const her = new HerOnBank(fish, ctx.timeline, bank);
  const cloud = bankEggs(her, bank.ground);
  const beads = new EggBeads(water, cloud);
  world.add(beads.mesh);
  const cam = new THREE.PerspectiveCamera(35, ctx.W / ctx.H, 0.02, 220);
  const P = fish.P, L = fish.L;

  // ---- 电感视觉的光（景深之后叠加）----
  const layer = new GlowLayer();
  const eggGlow = new GlowBlobs(water, { n: cloud.n, electroOnly: true, overlay: true, fadeRange: 28, maxPx: 70, nearFade: 0.06 });
  const aura = new GlowBlobs(water, { n: 48, electroOnly: true, overlay: true, fadeRange: 40, maxPx: 500 });
  const belly = new BellyEggs(water, fish, { overlay: true });
  layer.add(eggGlow, aura, belly.blobs);

  // ---- ① 夜城：她斜着穿过两江的分界（z = 0 的竖直面；-z 一侧是偏清的岷江水）----
  const XC = V(8, -3.9, 0);
  const dC = V(-0.28, 0, 1).normalize();
  const sideC = V(-dC.z, 0, dC.x);
  const ptsC = [];
  for (let u = -30; u <= 30; u += 0.5) {
    const p = XC.clone().addScaledVector(dC, u).addScaledVector(sideC, 0.35 * Math.sin(u * 0.16));
    p.y += 0.25 * Math.sin(u * 0.11 + 0.6);
    ptsC.push([p.x, p.y, p.z]);
  }
  const pathC = new Path(ptsC, { samples: 2400 });
  const trackC = swimTrack([[T.start - 1, 0.58], [T.memory + 1, 0.5]], { t0: T.start - 1, t1: T.memory + 1, f0: 0.2, k: 0.8 });
  const offC = 30 + 1.75 - trackC.u(T.cross);
  const UC = (t) => trackC.u(t) + offC;

  // ---- ② 回忆：她贴着卵石滩上方滑向产卵场 ----
  const ptsM = [];
  for (let u = -4; u <= 30; u += 0.5) {
    const x = BANK.x + 11 - u, z = BANK.z - 1.2 + 0.9 * smooth(u / 14) + 0.25 * Math.sin(u * 0.2);
    ptsM.push([x, bedHeight(x, z, BANK.base) + 1.15 + 0.1 * Math.sin(u * 0.3), z]);
  }
  const pathM = new Path(ptsM, { samples: 2400 });
  const trackM = swimTrack([[T.memory - 1, 0.42], [T.wait + 1, 0.38]], { t0: T.memory - 1, t1: T.wait + 1, f0: 0.2, k: 0.8 });
  const UM = (t) => trackM.u(t) + 5;

  // 回忆里的光影：妈妈（在她身边）、妈妈的妈妈（更远、更淡）、「每一个春天」（远处一群）
  const ghostAt = (school, { mid, d, v, L: gl, ta, tb, bright, f = 1.1, ph = 0 }) => {
    school.g[0] = { L: gl, d: d.clone().normalize(), v, mid, ph, ta, tb, tm: 0.5 * (ta + tb), bright, f };
    return school;
  };
  const mom = new GhostSchool(water, { n: 1, seed: 3, overlay: true, nearFade: 1.2 });
  const gran = new GhostSchool(water, { n: 1, seed: 4, overlay: true, nearFade: 1.2 });
  const spring = new GhostSchool(water, {
    n: 7, seed: 12, overlay: true, nearFade: 2.5, center: [BANK.x - 6, BANK.base + 2.2, BANK.z + 2], size: [22, 2.5, 16],
    dir: [-1, 0, 0.1], spread: 0.35, t0: T.ghosts[2] - 0.4, t1: T.wait + 0.6, speed: [0.35, 0.7],
  });
  layer.add(mom.blobs, gran.blobs, spring.blobs);

  // ---- 她的姿态：按段 ----
  function pose(t, extra = {}) {
    if (t < T.memory) {
      const sp = 0.58;
      fish.update({ path: pathC, u: UC(t), phase: trackC.phase(t), amp: 0.1, lambda: 0.95, pect: 0.03, flutter: 0.022,
        breath: 0.5 + 0.5 * Math.sin(t * 1.2), heart: 0.5, poreGlow: 1, bodyGlow: 1, time: t });
      return sp;
    }
    if (t < T.wait) {
      fish.update({ path: pathM, u: UM(t), phase: trackM.phase(t), amp: 0.085, lambda: 0.95, pect: 0.03, flutter: 0.02,
        breath: 0.5 + 0.5 * Math.sin(t * 1.2), heart: Math.pow(0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.8), 3), poreGlow: 1.2, bodyGlow: 1, time: t });
      return 0.4;
    }
    her.pose(t, extra);
    return her.track.speed(t);
  }
  const frame = (s) => {
    const p = fish.pointAt(s);
    const Tv = fish.pointAt(s - 0.01).sub(fish.pointAt(s + 0.01)).normalize();
    const Nv = fish.pointAt(s, 0.1).sub(p).normalize();
    const Bv = fish.pointAt(s, 0, 0.1).sub(p).normalize();
    return { p, T: Tv, N: Nv, B: Bv };
  };

  // 回忆里的光影：放在她身边（按她那一刻的位置算好，之后各走各的直线）
  pose(T.ghosts[0]);
  {
    const f = frame(0.3);
    const dir = f.T.clone().setY(0).normalize();
    mom.g.length = 1; gran.g.length = 1;
    // 妈妈：在她上方、略靠前，和她一起游；妈妈的妈妈：更远、更高、更淡（在她身子另一侧）
    // （ghostAt 的 mid 是 ta、tb 中点那一刻的位置：妈妈比她快一点点，中点时在她前上方约 1.5 米）
    ghostAt(mom, { mid: f.p.clone().addScaledVector(f.N, -0.2).add(V(0, 0.5, 0)).addScaledVector(dir, 3.0), d: dir, v: 0.42, L: 3.3, ta: T.ghosts[0], tb: T.wait - 0.2, bright: 0.95, f: 0.95 });
    const f2 = frame(0.3);
    ghostAt(gran, { mid: f2.p.clone().addScaledVector(f2.N, 2.8).add(V(0, 1.4, 0)).addScaledVector(dir, 3.2 + 0.42 * (T.ghosts[1] - T.ghosts[0])), d: dir.clone().applyAxisAngle(V(0, 1, 0), -0.08), v: 0.4, L: 3.5, ta: T.ghosts[1], tb: T.wait - 0.1, bright: 0.6, f: 0.85, ph: 2 });
  }

  // ---- 卵：熄灭顺序（先挑出近景里那一簇，让头几颗在镜头里一颗一颗暗下去）----
  const cluster = []; // 场景建好后按近景镜头选
  let td = null;

  // ---- 电感视觉的波前中心（按那一刻的姿态算好，任意跳帧一致）----
  pose(T.memory); const ecMemory = fish.pointAt(0.0).clone();
  pose(T.empty); const ecEmpty = fish.pointAt(0.02).clone();
  pose(T.glow); const ecGlow = fish.pointAt(0.55).clone();
  const herMid = ecGlow.clone();

  // ---- 镜头 ----
  const shots = [
    { t0: T.start, t1: T.memory, name: 'city' },
    { t0: T.memory, t1: T.wait, name: 'memory' },
    { t0: T.wait, t1: T.empty, name: 'lapse' },
    { t0: T.empty, t1: T.release, name: 'empty' },
    { t0: T.release, t1: T.glow, name: 'release' },
    { t0: T.glow, t1: T.macro, name: 'glow' },
    { t0: T.macro, t1: T.pull, name: 'macro' },
    { t0: T.pull, t1: T.end, name: 'pull' },
  ];
  // 近景那一簇卵：近景开始时已经落地、周围 3 厘米内卵最多的一处（在她身下的卵堆里挑）
  pose(T.macro);
  const ventM = fish.pointAt(0.66);
  const macroFocus = (() => {
    const cell = 0.03, grid = new Map(), key = (a, b) => a * 73856093 ^ b * 19349663;
    const ok = [];
    for (let i = 0; i < cloud.n; i++) {
      if (!cloud.landed(i, T.macro)) continue;
      const j = i * 3, x = cloud.pl[j], z = cloud.pl[j + 2];
      if (Math.hypot(x - ventM.x, z - ventM.z) > 0.8) continue;
      ok.push(i);
      const k = key(Math.floor(x / cell), Math.floor(z / cell));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
    let best = ok[0], bn = -1;
    for (const i of ok) {
      const j = i * 3, x = cloud.pl[j], z = cloud.pl[j + 2];
      const gx = Math.floor(x / cell), gz = Math.floor(z / cell);
      let n = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        for (const q of grid.get(key(gx + a, gz + b)) || []) {
          const jq = q * 3;
          if (Math.hypot(cloud.pl[jq] - x, cloud.pl[jq + 1] - cloud.pl[j + 1], cloud.pl[jq + 2] - z) < 0.03) n++;
        }
      }
      if (n > bn) { bn = n; best = i; }
    }
    const j = best * 3;
    return V(cloud.pl[j], cloud.pl[j + 1], cloud.pl[j + 2]);
  })();
  // 近景镜头：从卵堆外侧低低地看过去，背景是她（一团淡青的散景）
  pose(T.macro);
  const hMac = fish.pointAt(0.5);
  const dH = V(hMac.x - macroFocus.x, 0, hMac.z - macroFocus.z).normalize();
  const sideH = V(-dH.z, 0, dH.x);
  const macroCam = macroFocus.clone().addScaledVector(dH, -0.15).addScaledVector(sideH, 0.03).add(V(0, 0.05, 0));
  {
    // 头几颗：离近景焦点最近、已经落地、在画面里的卵
    const cand = [];
    for (let i = 0; i < cloud.n; i++) {
      if (!cloud.landed(i, T.macro)) continue;
      const j = i * 3;
      const d = Math.hypot(cloud.pl[j] - macroFocus.x, cloud.pl[j + 1] - macroFocus.y, cloud.pl[j + 2] - macroFocus.z);
      if (d < 0.05) cand.push([d, i]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    const firsts = firstEggTimes(T);
    const pick = [];
    for (let k = 0; k < cand.length && pick.length < firsts.length; k++) pick.push(cand[k][1]);
    // 最后一颗：她头下方
    pose(T.dark);
    const hd = fish.pointAt(0.36);
    let last = -1, ld = 1e9;
    for (let i = 0; i < cloud.n; i++) {
      if (!cloud.landed(i, T.dark - 1)) continue;
      const j = i * 3;
      const d = Math.hypot(cloud.pl[j] - hd.x, cloud.pl[j + 2] - hd.z);
      if (d < ld && !pick.includes(i)) { ld = d; last = i; }
    }
    td = eggDeathTimes(T, cloud.n, { firstIdx: pick, firstTimes: firsts.slice(0, pick.length), lastIdx: last });
    cluster.push(...pick);
  }
  // 拉开的终点：高处斜看整片卵石滩，她在正中
  pose(T.dark);
  const herDark = fish.pointAt(0.5);
  const pullTop = herDark.clone().addScaledVector(dH, -3.2).addScaledVector(sideH, 0.8).add(V(0, 4.6, 0));

  function camera(t) {
    const { shot, k, lt } = shotAt(shots, t);
    let pos, look, focus, aperture = 5, maxc = 9, fov = 35, roll = 0;
    switch (shot.name) {
      case 'city': {
        // 仰拍：镜头在清水一侧、她下方约 3 米，看向下游方向的城市与桥
        const e = smooth(k);
        pos = XC.clone().add(V(-2.2 + 0.4 * e, -3.1, -1.4 + 0.6 * e)).add(shake(t, 0.02, 0.2, 1));
        look = pos.clone().add(V(0.55 - 0.1 * e, 1.0, 0.1 + 0.25 * e));
        const mid = fish.pointAt(0.5);
        focus = pos.distanceTo(mid); aperture = 3.5; fov = 64;
        break;
      }
      case 'memory': {
        // 在她身侧略低处平行跟拍：她的侧影，妈妈的光影在她身边另一侧，远处一代代的光影
        const f = frame(0.4);
        const e = smooth(k);
        pos = f.p.clone().addScaledVector(f.N, -3.4 - 0.3 * e).addScaledVector(f.T, 0.4 - 0.6 * e).add(V(0, -0.25 + 0.15 * e, 0)).add(shake(t, 0.012, 0.25, 2));
        look = f.p.clone().addScaledVector(f.T, 0.9).addScaledVector(f.N, 0.9).add(V(0, 0.25, 0));
        focus = pos.distanceTo(f.p) + 0.3; aperture = 2.5; fov = 48;
        break;
      }
      case 'lapse': {
        // 延时（机位不动）：贴着卵石、紧挨着她仰拍——她的头和背是画面下方一道暗的轮廓，
        // 轮廓上方是水面的亮窗，城市的灯（虚成光斑）一盏盏熄，天往黎明走
        const f = frame(0.4);
        const e = smooth(k);
        pos = f.p.clone().addScaledVector(f.N, -0.7).addScaledVector(f.T, 0.2);
        pos.y = bank.ground(pos.x, pos.z) + 0.07;
        const fwd = f.N.clone().setY(0).normalize().applyAxisAngle(V(0, 1, 0), 0.26);
        const pitch = 0.45 + 0.02 * e;
        look = pos.clone().addScaledVector(fwd, Math.cos(pitch)).add(V(0, Math.sin(pitch), 0));
        focus = 0.75; aperture = 8; maxc = 12; fov = 76;
        break;
      }
      case 'empty': {
        const f = frame(0.45);
        const e = smooth(k);
        pos = f.p.clone().addScaledVector(f.N, 3.0 + 2.0 * e).add(V(0, 5.0 + 2.5 * e, 0)).addScaledVector(f.T, -1.2);
        look = f.p.clone().addScaledVector(f.T, 0.6);
        focus = pos.distanceTo(f.p); aperture = 2; fov = 48;
        break;
      }
      case 'release': {
        // 低机位侧面：她从卵石上起身，卵从身下像雪一样散开、落下来
        const f = frame(0.62);
        pos = f.p.clone().addScaledVector(f.N, -2.3).addScaledVector(f.T, 0.35).add(shake(t, 0.008, 0.3, 3));
        pos.y = bank.ground(pos.x, pos.z) + 0.32;
        look = f.p.clone().addScaledVector(f.T, 0.3).add(V(0, -0.22, 0));
        focus = pos.distanceTo(f.p); aperture = 4; fov = 40;
        break;
      }
      case 'glow': {
        // 低机位，隔着卵石上、水里的卵看她：她是中间一团淡青，四周成千上万个琥珀光点
        const e = smooth(k);
        const f = frame(0.55);
        pos = f.p.clone().addScaledVector(f.N, -2.6 + 0.5 * e).addScaledVector(f.T, -0.9 + 0.2 * e).add(shake(t, 0.006, 0.2, 4));
        pos.y = bank.ground(pos.x, pos.z) + 0.24 + 0.08 * e;
        look = f.p.clone().add(V(0, -0.28, 0));
        focus = pos.distanceTo(f.p); aperture = 4; fov = 44;
        break;
      }
      case 'macro': {
        pos = macroCam.clone().add(shake(t, 0.0015, 0.3, 5));
        look = macroFocus.clone().add(V(0, 0.005, 0));
        focus = pos.distanceTo(macroFocus); aperture = 26; maxc = 30; fov = 30;
        break;
      }
      default: { // pull：从那一簇往上、往后拉开，整片卵一片片暗下去，最后只剩她
        const e = smooth(clamp(lt / 4.0));
        const e2 = smooth(clamp(lt / 2.6));
        pos = macroCam.clone().lerp(pullTop, e);
        pos.y += 0.6 * Math.sin(Math.PI * e) * 0.3;
        look = macroFocus.clone().lerp(herDark.clone().add(V(0, -0.25, 0)), e2);
        focus = lerp(macroCam.distanceTo(macroFocus), pos.distanceTo(herDark), e2); aperture = lerp(26, 2.5, e); maxc = lerp(30, 8, e); fov = lerp(30, 46, e);
      }
    }
    cam.fov = fov;
    cam.updateProjectionMatrix();
    aim(cam, pos, look, roll);
    return { focus, aperture, maxc, name: shot.name };
  }

  function electro(t) {
    water.uENoise.value = 0;
    water.uERange.value = 18;
    let ec = ecMemory, er = -1, mix = 0;
    if (t >= T.memory && t < T.wait) { ec = ecMemory; er = (t - T.memory) * 7; mix = er > 40 ? 1 : 0; }
    else if (t >= T.empty && t < T.release) { ec = ecEmpty; er = (t - T.empty) * 6.5; mix = 0; water.uERange.value = 26; }
    else if (t >= T.glow) { ec = ecGlow; er = (t - T.glow) * 4.2 + 0.3; mix = er > 40 ? 1 : 0; water.uERange.value = 22; }
    water.uERingDim.value = t >= T.glow ? 0.93 : t >= T.empty ? 0.88 : 0.9; // 波前只留一道淡淡的亮边
    water.uEC.value.copy(ec);
    water.uER.value = mix > 0 ? -1 : er;
    water.uEMix.value = mix;
  }

  function setWater(t, name) {
    let lk;
    if (name === 'city') lk = LOOKS.city;
    else if (t < T.wait) lk = LOOKS.bankNight;
    else if (t < T.release) lk = mixLook(LOOKS.bankNight, LOOKS.preDawn, cityOffAt(T, t) * 0.8);
    else lk = LOOKS.preDawn;
    water.uSigma.value = lk.sigma; water.uSigmaLight.value = lk.sigmaL;
    water.uFogUp.value.set(...lk.fogUp); water.uFogDown.value.set(...lk.fogDown);
    water.uAmbUp.value.set(...lk.ambUp); water.uAmbDown.value.set(...lk.ambDown);
    water.uSunColor.value.set(...lk.sun); water.uSunDir.value.set(...lk.sunDir).normalize();
    water.uCaustic.value = 0; water.uShafts.value = 0;
    // 两江交汇：只在第一个镜头
    if (name === 'city') {
      water.uMix2.value = 1;
      water.uMixPlane.value.set(0, 0, -1, 0);        // -z 一侧是岷江（偏清的青绿）
      water.uMixW.value = 0.5;
      water.uMixTurb.value.set(0.25, 0, 0.05, 1.1);
      water.uSigma2.value = 0.085;
      water.uFog2Up.value.set(0.004, 0.0125, 0.0095);
      water.uFog2Down.value.set(0.0005, 0.0016, 0.0013);
    } else {
      water.uMix2.value = 0;
    }
  }

  function sky(t, name) {
    if (name === 'city') return { mode: 1, city: 1.6, dawn: 0, dense: 1.3, bridge: 1.4, ripple: 1.25, winEdge: [0.6, 0.72], blur: 0.018 };
    if (name === 'memory') return { mode: 1, city: 1.2, dawn: 0, dense: 1.0 };
    const off = cityOffAt(T, t);
    const dawn = t < T.release ? 0.42 * off : 0.45 + 0.1 * smooth((t - T.release) / 15);
    return {
      mode: 1, city: 1.5 * (1 - 0.3 * off), dawn, dense: 1.2, cityOff: Math.min(0.999, off * 1.02),
      bridge: 1.3 * (1 - smooth((t - T.bridgeOff) / 0.12)), ripple: name === 'lapse' ? 0.35 : 0.8, winEdge: [0.6, 0.74],
    };
  }

  return {
    id: 's6_yibin', start: T.start, end: T.end,
    render(t, ctx) {
      const { shot } = shotAt(shots, t);
      pose(t);
      electro(t);
      setWater(t, shot.name);
      const { focus, aperture, maxc, name } = camera(t);
      pose(t); // 镜头里可能按别的时刻摆过姿态，这里摆回来
      // 泥沙：夜城里浑水一侧多、清水一侧少；延时里流得飞快、拉成细线
      const lapse = name === 'lapse';
      silt.set(cam, {
        focus, aperture: aperture * 0.8, current: lapse ? [2.4, -0.05, 0.5] : [0.09, -0.004, 0.02],
        shutter: lapse ? 0.03 : 0, sideDens: [1, 0.2], sizeMul: lapse ? 2.4 : 1,
      });
      // 卵
      cloud.update(t);
      beads.update(cam, { dead: 0, boost: 2.2, visible: t >= T.release - 0.1 });
      eggGlow.begin();
      if (t >= T.glow - 0.1) {
        const pos = cloud.pos, ec = water.uEC.value, er = water.uER.value;
        const cp = cam.position, tanH = Math.tan((cam.fov * Math.PI) / 360);
        for (let i = 0; i < cloud.n; i++) {
          const j = i * 4;
          if (pos[j + 3] <= 0) continue;
          const x = pos[j], y = pos[j + 1], z = pos[j + 2];
          const dt = t - td[i];
          // 熄灭：先轻轻一亮，再暗下去
          const life = dt < 0 ? 1 : Math.exp(-dt / 0.24) * (1 + 0.5 * Math.exp(-Math.pow((dt - 0.05) / 0.08, 2)));
          if (life < 0.003) continue;
          const dh = Math.hypot(x - herMid.x, z - herMid.z);
          const rn = cloud.rn[i * 2], rn2 = cloud.rn[i * 2 + 1];
          // 呼吸：各自的节奏，叠一层从她身边往外荡的慢波
          const breath = 0.6 + 0.4 * Math.sin(t * (1.6 + 0.9 * rn) + rn2 * 6.28 - dh * 1.3);
          let flare = 1;
          if (er > 0) { const dw = Math.hypot(x - ec.x, y - ec.y, z - ec.z) - er; flare += 1.2 * Math.exp(-(dw * dw) / 0.05); }
          const born = smooth((t - cloud.te[i]) / 0.45);   // 刚出来的卵还挤在一起，慢慢亮起来
          const d = Math.hypot(x - cp.x, y - cp.y, z - cp.z);
          // 光晕半径：近看（近景那一簇）只比卵本身大一圈，一颗是一颗；远处照旧是一团柔光
          const near = smooth((d - 0.12) / 0.5);
          let r = lerp(0.0022, 0.0045, near) + lerp(0.0008, 0.0025, near) * rn2;
          let k = 0.62 * breath * flare * life * born * (0.35 + 1.3 * rn * rn);
          // 远处的卵：至少画成 1.4 像素的一点（不然整片糊成一层雾）
          const pxm = ctx.H / (2 * tanH * Math.max(d, 0.05));
          if (r * pxm < 1.4) { const r2 = 1.4 / pxm; k *= Math.pow(r2 / r, 0.7); r = r2; }
          eggGlow.push({ x, y, z }, r, E_AMBER, k, 0.85);
        }
      }
      eggGlow.end(cam);
      // 她：电感视觉里一团淡青；肚子里的卵在产卵前透过身体亮着
      aura.begin();
      if (t >= T.memory) fishAura(fish, aura, { gain: t >= T.glow ? 0.3 : 0.28, heart: 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.8), time: t });
      aura.end(cam);
      belly.update(t, cam, { gain: t < T.wait ? 0.7 : t < T.release ? 1 : 1 - smooth((t - T.spurts[0].t) / (T.spurtEnd - T.spurts[0].t)) });
      mom.update(t, cam, { gain: t < T.wait ? 1 : 0 });
      gran.update(t, cam, { gain: t < T.wait ? 1 : 0 });
      spring.update(t, cam, { gain: t < T.wait ? 1 : 0 });
      const dof = { focus, aperture, max: maxc };
      world.render(ctx, { t, camera: cam, sky: sky(t, name), dof, fieldLines: 0.6 });
      layer.render(ctx, world, cam, dof);
    },
    postFx(t) {
      const fin = 1 - smooth((t - T.start) / 2.6);
      const fout = smooth((t - T.fadeOut) / (T.black - T.fadeOut));
      // 电感视觉的几段（与 electro() 同一套时刻，直接按 t 算）
      const el = (t > T.memory && t < T.wait) || (t > T.empty && t < T.release) || t > T.glow ? 1 : 0;
      const { shot } = shotAt(shots, t);
      const night = shot.name === 'city' ? 1 : 0;
      return {
        exposure: night ? 2.0 : el ? 1.5 : 2.2, bloom: 0.5 + 0.4 * el, bloomThreshold: 0.6, bloomRadius: 1.0, vignette: 0.5, grain: 0.05,
        toneMix: 1, halation: 0.18, ca: 0.0006, fade: Math.max(fin, fout),
      };
    },
  };
}
