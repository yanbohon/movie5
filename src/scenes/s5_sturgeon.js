// S5 老鲟：电感视觉里远处一团和她一样大的光 → 「是你吗」→ 她冲过去 → 切回真实视角：一条老长江鲟 →
// 对话（回忆里满江的白鲟光影；透过她的身体看见肚子里的卵）→ 老鲟从她身边游过，没入浑水。
import * as THREE from 'three';
import { UnderwaterWorld, makeWaterUniforms } from '../film/uw/world.js';
import { Fish, Path } from '../film/uw/fish.js';
import { Riverbed, bedHeight } from '../film/uw/bed.js';
import { Silt, Sparks } from '../film/uw/particles.js';
import { GlowBlobs, GlowLayer, fishAura, GhostSchool, BellyEggs } from '../film/uw/glow.js';
import { swimTrack, shake, aim, shotAt } from '../film/uw/motion.js';
import { clamp, smooth, lerp, win } from '../film/util.js';
import { s5Times, herBeats, oldBeats, pulseAt } from './s5_sturgeon/events.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

export default async function (ctx) {
  const T = s5Times(ctx.timeline);
  const { L } = T;
  const BED = -12;
  const water = makeWaterUniforms();
  water.uSigma.value = 0.27;
  const world = new UnderwaterWorld(ctx, { water });
  const bed = new Riverbed(water, { base: BED, center: [0, 0], size: 130, rocks: 90, rockRegion: 60, seed: 8 });
  world.add(bed.group);
  const her = new Fish({ species: 'paddlefish', L: 3.5, water });
  her.u.uTagAge.value = 1;
  world.add(her.group);
  const old = new Fish({ species: 'sturgeon', L: 2.8, water, tag: false });
  world.add(old.group);
  const silt = new Silt(water, { n: 22000, box: 14 });
  world.add(silt.mesh);
  const bedAt = (x, z) => {
    let s = 0;
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) s += bedHeight(x + dx, z + dz, BED);
    return s / 5;
  };
  const sparks = new Sparks(water, { n: 1500, center: [0, BED + 2.5, 0], size: [50, 6, 40], seed: 23, bedFn: (x, z) => bedHeight(x, z, BED) });
  world.add(sparks.mesh);
  // 光团都在景深之后叠加（自己按圈散变大、按深度被挡）
  const glow = new GlowLayer();
  const aura = new GlowBlobs(water, { n: 48, electroOnly: true, fadeRange: 30, maxPx: 520, overlay: true });
  const ghosts = new GhostSchool(water, {
    n: 110, seed: 5, center: [0, BED + 3.0, 0.6], size: [56, 7, 44], dir: [-1, 0, 0], spread: 0.65,
    t0: T.memStart + 0.3, t1: T.memEnd + 0.9, speed: [0.6, 1.5], overlay: true, nearFade: 2.2,
  });
  const eggs = new BellyEggs(water, her, { n: 700, overlay: true });
  glow.add(aura, ghosts.blobs, eggs.blobs);
  const cam = new THREE.PerspectiveCamera(35, ctx.W / ctx.H, 0.03, 220);

  // ---- 路径：她往上游（-x），他往下游（+x），在 x≈0 相遇，横向错开 ----
  const herPts = [], oldPts = [];
  for (let x = 26; x >= -26; x -= 0.5) {
    const z = 0.2 * Math.sin(x * 0.15);
    herPts.push([x, bedAt(x, z) + 1.05 + 0.1 * Math.sin(x * 0.3), z]);
  }
  // 老鲟从左前方斜着过来（远看是一团斜着的长光），到她跟前改成顺江往下
  const oc = new THREE.CatmullRomCurve3([[-7.2, 18], [-7.6, 11], [-6.6, 6.2], [-4.2, 3.1], [-1.9, 1.85], [0, 1.5], [2, 1.55], [5, 2.4], [9, 4.2], [16, 7.0], [30, 11.0]]
    .map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
  const ocN = Math.ceil(oc.getLength() / 0.4);
  for (let i = 0; i <= ocN; i++) {
    const q = oc.getPointAt(i / ocN);
    oldPts.push([q.x, bedAt(q.x, q.z) + 0.42, q.z]);
  }
  const herPath = new Path(herPts, { samples: 2400 });
  const oldPath = new Path(oldPts, { samples: 2400 });
  const uAtX = (path, x, dir) => {
    let a = 0, b = path.len;
    for (let i = 0; i < 50; i++) { const m = 0.5 * (a + b); if ((path.pos(m).x - x) * dir < 0) a = m; else b = m; }
    return 0.5 * (a + b);
  };
  const herTrack = swimTrack([
    [T.start, 0.28], [T.start + 1.6, 0.12], [T.ask + 0.3, 0.05], [T.rush, 0.1], [T.rush + 1.1, 1.75],
    [T.approach + 0.4, 1.5], [T.reveal - 0.1, 0.3], [T.reveal + 1.2, 0.06], [T.stop, 0.02], [T.leave + 4, 0.02],
    [T.end - 4.5, 0.04], [T.end, 0.3],
  ], { t0: T.start - 1, t1: T.end + 1, f0: 0.18, k: 0.8 });
  const oldTrack = swimTrack([
    [T.start, 0.6], [T.rush, 0.7], [T.reveal, 0.4], [T.reveal + 1.8, 0.2], [T.stop, 0.015], [T.leave, 0.015],
    [T.leave + 1.5, 0.5], [T.leave + 3.5, 1.1], [T.end, 1.2],
  ], { t0: T.start - 1, t1: T.end + 1, f0: 0.14, k: 0.6 });
  const XR = 0.6, XS = -0.45;               // 揭示时她的吻尖、老鲟停下时的吻端
  const uHerR = uAtX(herPath, XR, -1), uOldS = uAtX(oldPath, XS, 1);
  const herU = (t) => uHerR + herTrack.u(t) - herTrack.u(T.reveal);
  const oldU = (t) => uOldS + oldTrack.u(t) - oldTrack.u(T.stop);

  const hb = herBeats(T), ob = oldBeats(T);
  const speaking = (who, t) => {
    let v = 0;
    for (const id of Object.keys(L)) {
      const l = L[id];
      if ((who === 'OLD') === id.startsWith('O')) v = Math.max(v, win(t, l.t - 0.1, l.t + 0.2, l.t + l.dur - 0.1, l.t + l.dur + 0.3));
    }
    return v;
  };

  function pose(t) {
    const hs = herTrack.speed(t);
    const hp = pulseAt(hb, t);
    const look = -0.07 * win(t, T.reveal + 0.5, T.stop, T.leave + 1, T.leave + 4);
    her.update({
      path: herPath, u: herU(t), phase: herTrack.phase(t), amp: 0.06 + 0.1 * clamp(hs / 1.4), lambda: 0.95,
      headYaw: look + 0.025 * Math.sin(t * 1.3) * speaking('HER', t), headPitch: 0.02 * Math.sin(t * 0.4),
      pect: 0.04 + 0.03 * Math.sin(t * 0.9) * win(t, T.reveal, T.reveal + 2, T.end, T.end + 1),
      flutter: 0.012 + 0.02 * clamp(hs), breath: 0.5 + 0.5 * Math.sin(t * (1.2 + 0.8 * win(t, T.glow + 1, T.ask, T.reveal, T.reveal + 4))),
      heart: hp, poreGlow: 1.1 + 0.9 * win(t, T.glow + 1.5, T.ask, T.approach, T.reveal) * (0.6 + 0.4 * Math.sin(t * 7.0)), bodyGlow: 1, time: t,
    });
    const os = oldTrack.speed(t);
    const talk = speaking('OLD', t);
    old.update({
      path: oldPath, u: oldU(t), phase: oldTrack.phase(t), amp: 0.05 + 0.08 * clamp(os / 1.0), lambda: 0.9,
      headYaw: -0.06 * win(t, T.reveal + 1, T.stop, T.leave, T.leave + 1.5) + 0.015 * Math.sin(t * 0.8), bank: 0.03,
      pect: 0.05 + 0.02 * Math.sin(t * 0.7), flutter: 0.01, breath: 0.5 + 0.5 * Math.sin(t * (0.9 + 1.2 * talk)),
      heart: pulseAt(ob, t), poreGlow: 0.6, bodyGlow: 1, time: t,
    });
  }

  const frameOf = (fish) => (s) => {
    const p = fish.pointAt(s);
    const Tv = fish.pointAt(s - 0.01).sub(fish.pointAt(s + 0.01)).normalize();
    const Nv = fish.pointAt(s, 0.1).sub(p).normalize();
    const Bv = fish.pointAt(s, 0, 0.1).sub(p).normalize();
    return { p, T: Tv, N: Nv, B: Bv };
  };
  const hf = frameOf(her), of = frameOf(old);
  const eye = (fish, side) => { const [s, la, ve] = fish.eyeLocal; return fish.pointAt(s, la * side, ve); };

  const shots = [
    { t0: T.start, t1: T.rush, name: 'far' },
    { t0: T.rush, t1: T.approach, name: 'rush' },
    { t0: T.approach, t1: T.reveal, name: 'approach' },
    { t0: T.reveal, t1: L.L43.t - 0.3, name: 'reveal' },
    { t0: L.L43.t - 0.3, t1: L.O03.t - 0.25, name: 'her_ask' },
    { t0: L.O03.t - 0.25, t1: T.memStart - 0.1, name: 'old_cu' },
    { t0: T.memStart - 0.1, t1: L.O04.t - 0.3, name: 'memory' },
    { t0: L.O04.t - 0.3, t1: L.L44.t - 0.25, name: 'two' },
    { t0: L.L44.t - 0.25, t1: L.O05.t - 0.25, name: 'her_cu' },
    { t0: L.O05.t - 0.25, t1: L.L45.t - 0.45, name: 'old_cu2' },
    { t0: L.L45.t - 0.45, t1: L.O06.t - 0.3, name: 'belly' },
    { t0: L.O06.t - 0.3, t1: T.leave + 1.6, name: 'old_last' },
    { t0: T.leave + 1.6, t1: T.end, name: 'leave' },
  ];

  function camera(t) {
    const { shot, k, lt } = shotAt(shots, t);
    let pos, look, focus, aperture = 6, maxc = 10, fov = 35;
    switch (shot.name) {
      case 'far': {
        // 从她身后上方，慢慢推到她头侧；远处那团光在画面左前方
        const f = hf(0.4), e = smooth(k);
        pos = f.p.clone().addScaledVector(f.T, -2.6 + 2.3 * e).addScaledVector(f.N, 0.9 - 0.25 * e).addScaledVector(f.B, 0.75 - 0.45 * e).add(shake(t, 0.01, 0.25, 1));
        const glow = old.pointAt(0.4);
        look = hf(0.0).p.addScaledVector(f.T, 2.0).lerp(glow, 0.35 + 0.15 * e);
        focus = lerp(pos.distanceTo(glow), pos.distanceTo(eye(her, 1)), smooth((t - (T.ask - 1.2)) / 1.2));
        aperture = 6; fov = lerp(40, 34, e);
        break;
      }
      case 'rush': {
        // 她身后上方：她冲出去，前面那团光越来越大
        const f = hf(0.5);
        pos = f.p.clone().addScaledVector(f.T, -1.4 + 0.3 * k).addScaledVector(f.B, 0.95).addScaledVector(f.N, 0.4).add(shake(t, 0.02 + 0.025 * k, 0.9, 2));
        look = old.pointAt(0.45).lerp(hf(0.0).p, 0.3);
        focus = pos.distanceTo(old.pointAt(0.45)); aperture = 5; fov = 40 + 4 * smooth(k);
        break;
      }
      case 'approach': {
        // 侧面（和揭示镜头同一侧，保持方向）：两团光相向靠拢
        const A = hf(0.2).p, Bp = old.pointAt(0.3);
        const M = A.clone().lerp(Bp, 0.5);
        const side = new THREE.Vector3().subVectors(Bp, A).cross(V(0, 1, 0)).normalize();
        if (side.z < 0) side.negate();
        pos = M.clone().addScaledVector(side, 6.5).add(V(0, 0.3, 0)).add(shake(t, 0.015, 0.8, 3));
        look = M.clone();
        focus = pos.distanceTo(M); aperture = 2.5; fov = 40;
        break;
      }
      case 'reveal': {
        // 老鲟外侧、低机位 3/4 正面：他从浑水里慢慢显出来，停在镜头前
        if (!camera.revAnchor || camera.revAnchorShot !== shot.t0) {
          pose(shot.t0);
          const fa = of(0.12);
          camera.revAnchor = fa.p.clone().addScaledVector(fa.T, 2.1).addScaledVector(fa.N, 1.3).addScaledVector(fa.B, 0.22);
          camera.revAnchorShot = shot.t0;
          pose(t);
        }
        pos = camera.revAnchor.clone().add(shake(t, 0.006, 0.3, 4));
        look = old.pointAt(0.24);
        focus = pos.distanceTo(old.pointAt(0.14)); aperture = 6; fov = 36 - 3 * smooth(k);
        break;
      }
      case 'her_ask': {
        // 她的脸（朝他那一侧）：说到「鼻子很长的」镜头顺着吻往前带
        const f = hf(0.3);
        const e = eye(her, -1);
        const tail = L.L43.t + L.L43.dur - 1.9;
        const g = smooth((t - tail) / 1.9);
        pos = e.clone().addScaledVector(f.N, -0.62).addScaledVector(f.T, 0.18 + 0.55 * g).addScaledVector(f.B, 0.1).add(shake(t, 0.004, 0.3, 5));
        look = e.clone().lerp(hf(0.12).p, 0.25 + 0.55 * g);
        focus = pos.distanceTo(e.clone().lerp(hf(0.14).p, 0.7 * g)); aperture = 14; maxc = 14;
        break;
      }
      case 'old_cu': {
        // 老鲟的头：眼、骨板、须
        const f = of(0.15);
        const e = eye(old, -1);
        pos = e.clone().addScaledVector(f.N, -0.62 + 0.1 * k).addScaledVector(f.T, 0.36).addScaledVector(f.B, 0.1).add(shake(t, 0.004, 0.3, 6));
        look = e.clone().addScaledVector(f.T, 0.02).addScaledVector(f.B, -0.03);
        focus = pos.distanceTo(e); aperture = 14; maxc = 14;
        break;
      }
      case 'memory': {
        // 回忆：从他的头扩散出去的波，满江的光影；镜头往后往上拉开
        const M = eye(her, -1).lerp(eye(old, -1), 0.5);
        const e = smooth(k);
        pos = M.clone().add(V(0.8 + 1.0 * e, 0.8 + 3.2 * e, -2.4 - 6.0 * e)).add(shake(t, 0.01, 0.2, 7));
        look = M.clone().add(V(-0.6 * e, 0.1 + 0.6 * e, 0.5));
        focus = pos.distanceTo(M); aperture = 3; fov = 38 + 6 * e;
        break;
      }
      case 'two': {
        // 两个头相对：机位在两头连线的垂线上（和揭示镜头同一侧），两条身子各自伸出画外
        const A = eye(her, -1), Bp = eye(old, -1);
        const M = A.clone().lerp(Bp, 0.5);
        const side = new THREE.Vector3().subVectors(Bp, A).cross(V(0, 1, 0)).normalize();
        if (side.z < 0) side.negate();
        pos = M.clone().addScaledVector(side, 3.4 - 0.3 * k).add(V(0, -0.12, 0)).add(shake(t, 0.006, 0.25, 8));
        look = M.clone().add(V(0, 0.08, 0));
        focus = pos.distanceTo(M); aperture = 3.5; fov = 38;
        break;
      }
      case 'her_cu': {
        // 「我知道。」她朝他那一侧的眼睛
        const f = hf(0.3);
        const e = eye(her, -1);
        pos = e.clone().addScaledVector(f.N, -0.46).addScaledVector(f.T, 0.1).addScaledVector(f.B, 0.07).add(shake(t, 0.003, 0.3, 9));
        look = e.clone().addScaledVector(f.T, -0.08);
        focus = pos.distanceTo(e); aperture = 16; maxc = 16;
        break;
      }
      case 'old_cu2': {
        const f = of(0.1);
        pos = old.pointAt(0.04).addScaledVector(f.T, 0.85).addScaledVector(f.N, -0.42).addScaledVector(f.B, 0.2).add(shake(t, 0.004, 0.3, 10));
        look = old.pointAt(0.13);
        focus = pos.distanceTo(eye(old, -1)); aperture = 12; maxc = 14;
        break;
      }
      case 'belly': {
        // 她的腹侧：电感视觉透过身体，看见肚子里的卵
        const f = hf(0.62);
        pos = f.p.clone().addScaledVector(f.N, 1.3 - 0.15 * k).addScaledVector(f.B, 0.02).addScaledVector(f.T, 0.05 + 0.35 * k).add(shake(t, 0.005, 0.25, 11));
        look = f.p.clone().addScaledVector(f.T, 0.08 + 0.35 * k).addScaledVector(f.B, -0.06);
        focus = pos.distanceTo(f.p); aperture = 8;
        break;
      }
      case 'old_last': {
        // 「那你慢慢游吧」：镜头不动，他开始游，从镜头旁滑过
        const e0 = eye(old, -1);
        const f = of(0.15);
        if (!camera.lastAnchor || camera.lastAnchorShot !== shot.t0) {
          // 用镜头开始那一刻的姿态定机位（纯函数：按 shot.t0 重新算）
          pose(shot.t0);
          const a = eye(old, -1), fa = of(0.15);
          camera.lastAnchor = { p: a.clone().addScaledVector(fa.N, -0.85).addScaledVector(fa.T, 1.0).addScaledVector(fa.B, 0.18), look: a.clone().addScaledVector(fa.T, 0.15) };
          camera.lastAnchorShot = shot.t0;
          pose(t);
        }
        pos = camera.lastAnchor.p.clone().add(shake(t, 0.004, 0.3, 12));
        look = camera.lastAnchor.look.clone().lerp(e0.clone().addScaledVector(f.T, 0.3), 0.6);
        focus = pos.distanceTo(e0); aperture = 10; maxc = 12;
        break;
      }
      default: { // leave
        // 侧面固定机位：她横在画面里（头朝右），他从她身后贴着河床往左游，没入浑水；焦点从他拉回她
        if (!camera.leaveAnchor || camera.leaveAnchorShot !== shot.t0) {
          pose(shot.t0);
          const c = hf(0.45).p;
          camera.leaveAnchor = { p: c.clone().add(V(-0.2, -0.15, -3.3)), look: c.clone().add(V(0.15, -0.3, 0.6)) };
          camera.leaveAnchorShot = shot.t0;
          pose(t);
        }
        pos = camera.leaveAnchor.p.clone().add(shake(t, 0.005, 0.2, 13));
        look = camera.leaveAnchor.look.clone();
        const him = old.pointAt(0.45), me = hf(0.4).p;
        const rack = smooth((t - (L.L46.t + 0.6)) / 1.8);
        focus = lerp(pos.distanceTo(him), pos.distanceTo(me), rack); aperture = 5; fov = 36;
      }
    }
    cam.fov = fov;
    cam.updateProjectionMatrix();
    aim(cam, pos, look);
    return { focus, aperture, maxc };
  }

  // 波前中心：按那一刻的姿态算（任意跳帧一致）
  pose(T.memStart);
  const EC_MEM = eye(old, -1).clone();
  pose(T.eggStart);
  const EC_EGG = her.pointAt(0.62);

  function electro(t) {
    water.uERange.value = 16;
    water.uENoise.value = 0;
    let mix = 0, er = -1, ec = EC_MEM;
    if (t < T.reveal) mix = 1;
    else if (t >= T.memStart && t < T.memEnd + 0.8) {
      const r = (t - T.memStart) * 13.0;   // 快一点扫过镜头，别在镜头边上烧成一道白
      if (r < 26) er = r; else mix = 1;
      if (t > T.memEnd) { er = -1; mix = 1 - smooth((t - T.memEnd) / 0.8); }
    } else if (t >= T.eggStart && t < T.eggEnd + 0.8) {
      ec = EC_EGG;
      const r = (t - T.eggStart) * 5.0;
      if (r < 18) er = r; else mix = 1;
      if (t > T.eggEnd) { er = -1; mix = 1 - smooth((t - T.eggEnd) / 0.8); }
    }
    water.uEC.value.copy(ec);
    water.uER.value = er;
    water.uEMix.value = mix;
  }

  return {
    id: 's5_sturgeon', start: T.start, end: T.end,
    render(t, ctx) {
      pose(t);
      electro(t);
      const { focus, aperture, maxc } = camera(t);
      aura.begin();
      const ag = win(t, T.start - 1, T.start + 1.8, T.reveal - 0.2, T.reveal) * (1 + 0.4 * smooth((t - T.rush) / (T.reveal - T.rush)))
        + 0.25 * win(t, T.memStart, T.memStart + 1, T.memEnd, T.memEnd + 0.8);
      // 离得近了别糊成一整团白
      const near = 0.3 + 0.7 * smooth((cam.position.distanceTo(old.pointAt(0.45)) - 1.5) / 6);
      if (ag > 0.001) fishAura(old, aura, { gain: ag * near, heart: pulseAt(ob, t), time: t });
      aura.end(cam);
      ghosts.update(t, cam, { gain: 1.0 });
      eggs.update(t, cam, { gain: win(t, T.eggStart + 0.2, T.eggStart + 1.4, T.eggEnd, T.eggEnd + 0.8) });
      silt.set(cam, { focus, aperture: aperture * 0.8, current: [0.12, 0, 0.02] });
      sparks.set(cam, { gain: 0.8 });
      const dof = { focus, aperture, max: maxc };
      world.render(ctx, { t, camera: cam, dof, shafts: 1, fieldLines: 1 });
      glow.render(ctx, world, cam, dof);
    },
    postFx(t) {
      const el = water.uEMix.value;
      const fout = smooth((t - T.fadeOut) / 2.2);
      return {
        exposure: 1.3 + 0.2 * el, bloom: 0.45 + 0.4 * el, bloomThreshold: 0.75, bloomRadius: 1.0, vignette: 0.5, grain: 0.045,
        toneMix: 1, halation: 0.15, ca: 0.0006, fade: fout,
      };
    },
  };
}
