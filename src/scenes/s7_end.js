// S7 最后：黎明。她慢慢沉到卵石上，身边是熄灭的卵；头顶泛起灰白的晨光，江水终于有一点暖意。
// 沉落（低机位侧面全身）→ 眼睛（长焦）→ 吻搭在石头上（斜上方）→ 斜后上方：躺在死卵中间，背上的旧信标，鳍越动越慢 →
// 电感视觉（镜头升高俯看）：剩下的光一颗颗熄灭，四周的河床从外往里暗下去，只剩她自己的心跳，越跳越慢 →
// 最后一下（她身边那一圈最后亮开一次）→ 全黑，一直黑到场景结束。
// 所有真实视角的镜头都在她左侧（+N：眼睛、信标这一侧），头朝画右。
import * as THREE from 'three';
import { UnderwaterWorld, makeWaterUniforms } from '../film/uw/world.js';
import { Fish } from '../film/uw/fish.js';
import { Silt } from '../film/uw/particles.js';
import { GlowBlobs, GlowLayer, fishAura, E_AMBER, E_CORE } from '../film/uw/glow.js';
import { EggBeads } from '../film/uw/eggs.js';
import { shake, aim, shotAt } from '../film/uw/motion.js';
import { clamp, smooth, lerp, mulberry32 } from '../film/util.js';
import { s7Times, heartbeatTimes, heartGlow, firstLightTimes, worldFadeSpan } from './s7_end/events.js';
import { makeBank, HerOnBank, bankEggs } from './s6_yibin/bank.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const flat = (v) => { const w = v.clone(); w.y = 0; return w.normalize(); };

export default async function (ctx) {
  const T = s7Times(ctx.timeline);
  const beats = heartbeatTimes(ctx.timeline);
  const water = makeWaterUniforms();
  const world = new UnderwaterWorld(ctx, { water });
  const bank = makeBank(water);
  world.add(bank.bed.group);
  const fish = new Fish({ species: 'paddlefish', L: 3.5, water });
  fish.u.uTagAge.value = 1; // 七年的旧信标：锈、藻、褪成灰白的飘带
  world.add(fish.group);
  const silt = new Silt(water, { n: 22000, box: 13, seed: 31 });
  world.add(silt.mesh);
  const her = new HerOnBank(fish, ctx.timeline, bank);
  const cloud = bankEggs(her, bank.ground);
  const beads = new EggBeads(water, cloud);
  world.add(beads.mesh);
  const cam = new THREE.PerspectiveCamera(35, ctx.W / ctx.H, 0.02, 220);

  // ---- 她：呼吸越来越慢；心跳（电感视觉里）按 heartbeatTimes；最后一下之后光慢慢没了 ----
  const breathPhase = (t) => {
    const x = Math.max(0, t - T.start), tau = 11;
    return 2 * Math.PI * (0.08 * x + 0.38 * tau * (1 - Math.exp(-x / tau)));
  };
  const breathAmp = (t) => lerp(1, 0.25, smooth((t - T.start) / (T.lightsOut - T.start)));
  const lifeAt = (t) => 1 - smooth((t - T.fadeLife) / (T.black - 0.25 - T.fadeLife));
  // 电感里她自己的光也越来越弱（心跳时亮一下）
  const weakAt = (t) => lerp(1, 0.62, smooth((t - T.lightsOut) / (T.lastPulse - T.lightsOut)));
  function pose(t) {
    const heart = heartGlow(beats, t, T.lastPulse);
    const w = weakAt(t);
    her.pose(t, {
      breath: 0.5 + 0.5 * breathAmp(t) * Math.sin(breathPhase(t)),
      heart, life: lifeAt(t), poreGlow: (0.4 + 0.6 * heart) * w, bodyGlow: (0.75 + 0.55 * heart) * w,
    });
    return heart;
  }
  const frame = (s) => {
    const p = fish.pointAt(s);
    const Tv = fish.pointAt(s - 0.01).sub(fish.pointAt(s + 0.01)).normalize();
    const Nv = fish.pointAt(s, 0.1).sub(p).normalize();
    return { p, T: Tv, N: Nv };
  };
  // 落定后的身体（镜头以它为锚，不跟着她往下沉，沉落才看得出来）
  pose(T.settle);
  const ref = (s) => { const f = frame(s); return { p: f.p.clone(), Th: flat(f.T), Nh: flat(f.N) }; };
  const R = { mid: ref(0.45), head: ref(0.3), ros: ref(0.12), gill: ref(0.36) };
  const ecHeart = fish.pointAt(0.43, 0, -0.08).clone(); // 波前中心：她的心（鳃后、腹侧）
  // 眼睛镜头的机位（相对眼睛，d = 离眼睛多远）；视线别被卵石挡住：按落定后的眼睛算一次，整个镜头抬同样的高度
  const eyeAt = () => { const [es, elat, evert] = fish.eyeLocal; return fish.pointAt(es, elat, evert); };
  const eyeCam = (eye, d) => eye.clone().addScaledVector(R.head.Nh, d).addScaledVector(R.head.Th, 0.1 * d).add(V(0, 0.04 * d, 0));
  let eyeLift = 0;
  {
    const eye = eyeAt();
    for (const d of [1.5, 1.4, 1.3, 1.2]) {
      const c = eyeCam(eye, d);
      for (let i = 1; i <= 13; i++) {
        const k = i / 16;
        const need = bank.ground(lerp(c.x, eye.x, k), lerp(c.z, eye.z, k)) + 0.025 - lerp(c.y, eye.y, k);
        if (need > 0) eyeLift = Math.max(eyeLift, need / (1 - k));
      }
    }
  }

  // ---- 电感视觉里还亮着的光：卵石缝里、水里的小活物（冷白），和残余的一点卵光（琥珀），她自己 ----
  // 先是离她近的四颗，一颗、一颗、一颗地熄；然后剩下的越熄越快，最后只剩她自己的心跳
  const M = R.mid.p, Th = R.mid.Th, Nh = R.mid.Nh;
  const layer = new GlowLayer();
  const lightsB = new GlowBlobs(water, { n: 96, electroOnly: true, overlay: true, fadeRange: 30, maxPx: 90, nearFade: 0.08 });
  const aura = new GlowBlobs(water, { n: 48, electroOnly: true, overlay: true, fadeRange: 40, maxPx: 500 });
  layer.add(lightsB, aura);
  cloud.update(T.lightsOut);
  const local = (al, sd) => M.clone().addScaledVector(Th, al).addScaledVector(Nh, sd);
  const eggNear = (p) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < cloud.n; i++) {
      const j = i * 4;
      if (!cloud.pos[j + 3]) continue;
      const d = (cloud.pos[j] - p.x) ** 2 + (cloud.pos[j + 2] - p.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return V(cloud.pos[best * 4], cloud.pos[best * 4 + 1] + 0.004, cloud.pos[best * 4 + 2]);
  };
  const rl = mulberry32(61);
  const lights = [];
  const creature = (p, onBed, big = 1) => ({
    p, amber: false, r: (0.026 + 0.018 * rl()) * big, b: (0.5 + 0.55 * rl()) * big, wob: onBed ? 0.025 : 0.16,
    f: 0.25 + 0.5 * rl(), ph: rl() * 6.28, tf: 1.2 + 2.5 * rl(),
  });
  const ember = (p, big = 1) => ({ p, amber: true, r: 0.021 * big, b: (0.6 + 0.35 * rl()) * big, wob: 0, f: 0, ph: rl() * 6.28, tf: 0.8 + 1.2 * rl() });
  // 先熄的四颗：尾边一颗卵、头前石缝里一只虫、身侧水里一只小虾、尾后一颗卵
  lights.push(
    ember(eggNear(local(-1.2, 0.75)), 1.5),
    creature(local(0.9, 1.1).setY(bank.ground(local(0.9, 1.1).x, local(0.9, 1.1).z) + 0.05), true, 1.4),
    creature(local(-0.3, -1.2).setY(M.y + 0.45), false, 1.4),
    ember(eggNear(local(-2.3, -0.3)), 1.5),
  );
  const firstT = firstLightTimes(T); // 与音效共用（events.js）
  // 其余的小活物散在她身边 5 米内（身子底下的不要），六成趴在卵石缝里，四成悬在水里
  const inBody = (al, sd) => Math.abs(sd) < 0.45 && al > -2.1 && al < 1.8;
  for (let k = 0; k < 52; k++) {
    let al, sd;
    do { al = (rl() - 0.5) * 10; sd = (rl() - 0.5) * 7; } while (inBody(al, sd));
    const p = local(al, sd), onBed = rl() < 0.6;
    p.y = bank.ground(p.x, p.z) + (onBed ? 0.02 + 0.05 * rl() : 0.2 + 1.1 * rl());
    lights.push(creature(p, onBed));
  }
  // 残余的卵光：散在她身子两侧、尾后的卵
  for (let guard = 0, n = 0; n < 34 && guard < 50000; guard++) {
    const i = Math.floor(rl() * cloud.n), j = i * 4;
    if (!cloud.pos[j + 3]) continue;
    const dx = cloud.pos[j] - M.x, dz = cloud.pos[j + 2] - M.z;
    if (inBody(dx * Th.x + dz * Th.z, dx * Nh.x + dz * Nh.z)) continue;
    lights.push(ember(V(cloud.pos[j], cloud.pos[j + 1] + 0.004, cloud.pos[j + 2])));
    n++;
  }
  // 熄灭时刻：前四颗按 firstT；其余在第四颗之后越熄越快（F = x^1.7），最后一颗在 dieEnd
  const cascade0 = firstT[3] + 0.2;
  lights.forEach((L, k) => {
    L.td = k < 4 ? firstT[k] : cascade0 + (T.dieEnd - cascade0) * Math.pow(rl(), 1 / 1.7);
  });
  // 感知收缩：光一颗颗熄灭之后，四周的河床也从外往里暗下去，最后只剩贴着她身子的一小圈
  const { t0: wStart, t1: wEnd } = worldFadeSpan(T);
  // 每跳一下，她「感觉得到」的那一圈就亮开一点；最后一下亮开得最大，然后一起暗下去
  const lastGlow = (t) => {
    const x = t - T.lastPulse;
    return x < 0 ? 0 : Math.min(1, x / 0.08) * Math.exp(-Math.max(0, x - 0.08) / 0.55);
  };
  const worldR = (t) => {
    if (t < wStart) return 0;
    const x = clamp((t - wStart) / (wEnd - wStart));
    const r = 60 * Math.pow(0.9 / 60, Math.pow(x, 0.7));
    const beat = 1 + 0.3 * heartGlow(beats, t, T.lastPulse) + 1.1 * lastGlow(t);
    return Math.max(0.02, r * beat * (0.25 + 0.75 * lifeAt(t)) * (1 - smooth((t - T.fadeLife) / 1.0)));
  };
  const worldAx = R.mid.Th.clone().multiplyScalar(1.3);

  // ---- 镜头 ----
  const shots = [
    { t0: T.start, t1: T.eyeCut, name: 'dawn' },
    { t0: T.eyeCut, t1: T.rostrumCut, name: 'eye' },
    { t0: T.rostrumCut, t1: T.bodyCut, name: 'rostrum' },
    { t0: T.bodyCut, t1: T.end, name: 'body' },
  ];
  function camera(t) {
    const { shot, k } = shotAt(shots, t);
    let pos, look, focus, aperture = 5, maxc = 10, fov = 35;
    switch (shot.name) {
      case 'dawn': {
        // 黎明，低机位侧面，镜头不动（只极慢地推近）：她悬在卵石上方，慢慢沉下来，落到发白的死卵中间
        const e = smooth(k);
        const Q = R.mid;
        pos = Q.p.clone().addScaledVector(Q.Th, -0.1 + 0.1 * e).addScaledVector(Q.Nh, 3.0 - 0.25 * e);
        pos.y = bank.ground(pos.x, pos.z) + 0.2;
        pos.add(shake(t, 0.004, 0.25, 1));
        look = Q.p.clone().addScaledVector(Q.Th, -0.1).add(V(0, 0.2, 0));
        focus = pos.distanceTo(fish.pointAt(0.45)); aperture = 3.5; fov = 42;
        break;
      }
      case 'eye': {
        // 眼睛：侧面，贴着卵石的高度，很慢地推近
        const e = smooth(k);
        const H = R.head;
        const eye = eyeAt();
        // 「你们还在听吗？」：从头部中景慢慢推到眼睛；眼睛一直停在画面右三分之一
        const d = lerp(1.5, 1.2, e);
        pos = eyeCam(eye, d).add(V(0, eyeLift, 0));
        pos.y = Math.max(pos.y, bank.ground(pos.x, pos.z) + 0.12);
        pos.add(shake(t, 0.002, 0.3, 2));
        look = eye.clone().addScaledVector(H.Th, -0.055 * d).add(V(0, 0.01, 0));
        focus = pos.distanceTo(eye); aperture = 16; maxc = 16; fov = 17;
        break;
      }
      case 'rostrum': {
        // 吻搭在卵石上：斜上方看下去，顺着吻慢慢移向吻尖
        const e = smooth(k);
        const q = fish.pointAt(lerp(0.15, 0.08, e));
        const H = R.ros;
        pos = q.clone().addScaledVector(H.Nh, 0.62).addScaledVector(H.Th, -0.08).add(V(0, 0.42, 0));
        look = q.clone().addScaledVector(H.Nh, -0.02);
        focus = pos.distanceTo(q); aperture = 7; maxc = 12; fov = 34;
        break;
      }
      default: { // 斜后上方：她躺在卵石上，尾边一片发白的死卵，背上的旧信标；鳍越动越慢 → 电感里升高、俯看她整条
        const Q = R.mid;
        const e = smooth(clamp((t - T.bodyCut) / 4.5));
        const r = smooth(clamp((t - T.lightsOut + 0.3) / 6.3));
        const low = Q.p.clone().addScaledVector(Q.Th, -1.6 + 0.2 * e).addScaledVector(Q.Nh, 2.0 - 0.15 * e).add(V(0, 1.05 - 0.05 * e, 0));
        const lowLook = Q.p.clone().addScaledVector(Q.Th, -0.2).add(V(0, -0.05, 0));
        const top = Q.p.clone().addScaledVector(Q.Nh, 1.55).addScaledVector(Q.Th, 0.1).add(V(0, 4.0, 0));
        const topLook = Q.p.clone().addScaledVector(Q.Th, 0.2).add(V(0, -0.05, 0));
        pos = low.lerp(top, r);
        look = lowLook.lerp(topLook, r);
        focus = pos.distanceTo(Q.p); aperture = lerp(2.5, 2.2, r); fov = lerp(38, 40, r);
      }
    }
    cam.fov = fov;
    cam.updateProjectionMatrix();
    aim(cam, pos, look);
    return { focus, aperture, maxc, name: shot.name };
  }

  function electro(t) {
    water.uENoise.value = 0;
    water.uERange.value = 24;
    water.uEC.value.copy(ecHeart);
    water.uERingDim.value = 0.85;
    water.uEWorldR.value = worldR(t);
    water.uEWorldAx.value.copy(worldAx);
    if (t >= T.lightsOut) {
      const er = (t - T.lightsOut) * 8.0 + 0.2;
      water.uER.value = er > 36 ? -1 : er;
      water.uEMix.value = er > 36 ? 1 : 0;
    } else {
      water.uER.value = -1;
      water.uEMix.value = 0;
    }
  }

  // 黎明：灰白的天光一点点亮起来；「今天的江水，也很暖」时江水暖一点
  function setWater(t) {
    const warm = smooth((t - T.L56 + 1.2) / 4.5);
    const g = lerp(0.85, 1.0, smooth((t - T.start) / 12));
    water.uSigma.value = 0.19; water.uSigmaLight.value = 0.11;
    water.uFogUp.value.set(lerp(0.05, 0.068, warm) * g, lerp(0.05, 0.056, warm) * g, lerp(0.048, 0.04, warm) * g);
    water.uFogDown.value.set(0.0065, 0.0062, 0.0056);
    water.uAmbUp.value.set(0.07, 0.068, 0.062); water.uAmbDown.value.set(0.009, 0.0088, 0.008);
    water.uSunColor.value.set(lerp(0.95, 1.35, warm) * g, lerp(0.95, 1.1, warm) * g, lerp(0.92, 0.8, warm) * g);
    water.uSunDir.value.set(0.35, 1, -0.2).normalize();
    water.uCaustic.value = 0.22 + 0.2 * warm; water.uShafts.value = 0.55 + 0.45 * warm;
    water.uMix2.value = 0;
  }

  return {
    id: 's7_end', start: T.start, end: T.end,
    render(t, ctx) {
      if (t >= T.black) return; // 全黑，只剩江水声
      electro(t);
      setWater(t);
      const heart = pose(t);
      const { focus, aperture, maxc } = camera(t);
      silt.set(cam, { focus, aperture: aperture * 0.8, current: [0.07, -0.004, 0.02] });
      cloud.update(t); // 和 S6 共用一团卵：每帧按 t 现算（别吃上一场留下的状态）
      beads.update(cam, { dead: 0.8, boost: 1.0 });
      // 剩下的光一颗颗熄：熄的那一下先微微一亮，再暗下去
      lightsB.begin();
      if (t >= T.lightsOut) {
        const q = new THREE.Vector3();
        for (const L of lights) {
          const dt = t - L.td;
          const life = dt < 0 ? 1 : (1 + 0.4 * Math.exp(-dt / 0.06)) * Math.exp(-dt / 0.22);
          if (life < 0.004) continue;
          const tw = 0.7 + 0.3 * Math.sin(t * L.tf * 2.0 + L.ph);
          q.copy(L.p);
          if (L.wob > 0) q.add(V(Math.sin(t * L.f + L.ph) * L.wob, Math.sin(t * L.f * 0.7 + L.ph * 2.0) * L.wob * 0.4, Math.cos(t * L.f * 0.9 + L.ph) * L.wob));
          lightsB.push(q, L.r, L.amber ? E_AMBER : E_CORE, L.b * tw * life, L.amber ? 0.8 : 0.6);
        }
      }
      lightsB.end(cam);
      aura.begin();
      if (t >= T.lightsOut) fishAura(fish, aura, { gain: 0.3 * lifeAt(t) * weakAt(t) * (0.4 + 0.9 * heart), heart, time: t });
      aura.end(cam);
      const dof = { focus, aperture, max: maxc };
      world.render(ctx, { t, camera: cam, sky: { mode: 0, bright: 0.34 }, dof, shaftScale: 0.8, fieldLines: 0.5 });
      layer.render(ctx, world, cam, dof);
    },
    postFx(t) {
      const fin = 1 - smooth((t - T.start) / 3.0);
      const fout = smooth((t - (T.black - 1.3)) / 1.3);
      const el = t >= T.lightsOut ? smooth((t - T.lightsOut) / 2.0) : 0; // 波扫出去的这两秒里慢慢换成电感的曝光
      return {
        exposure: lerp(1.6, 1.5, el), bloom: 0.45 + 0.4 * el, bloomThreshold: 0.65, bloomRadius: 1.0, vignette: 0.5, grain: 0.045,
        toneMix: 1, halation: 0.15, ca: 0.0005, fade: t >= T.black ? 1 : Math.max(fin, fout),
      };
    },
  };
}
