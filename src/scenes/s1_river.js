// S1 看不见的江：浑黄的江底 → 吻从浑水里伸出来 → 小眼睛 → 整个身体滑过 → 电感视觉的波扫开 →
// 满江的「星星」→ 左右扫着找 → 远处轰鸣、电场起噪 → 船从头顶压过（真实视角）→ 泥沙落定。
import * as THREE from 'three';
import { UnderwaterWorld, makeWaterUniforms } from '../film/uw/world.js';
import { Fish, Path } from '../film/uw/fish.js';
import { Riverbed, bedHeight } from '../film/uw/bed.js';
import { Silt, Sparks } from '../film/uw/particles.js';
import { Ship, Bubbles } from '../film/uw/ship.js';
import { swimTrack, shake, aim, shotAt } from '../film/uw/motion.js';
import { clamp, smooth, lerp, win } from '../film/util.js';
import { s1Times } from './s1_river/events.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

export default async function (ctx) {
  const T = s1Times(ctx.timeline);
  const BED = -12;
  const water = makeWaterUniforms();
  const world = new UnderwaterWorld(ctx, { water });
  const bed = new Riverbed(water, { base: BED, center: [-10, 0], size: 150, rocks: 110, rockRegion: 70, seed: 3 });
  world.add(bed.group);
  const fish = new Fish({ species: 'paddlefish', L: 3.5, water });
  fish.u.uTagAge.value = 1;                // 她最后一天：背上的信标早已锈蚀、长藻
  world.add(fish.group);
  const silt = new Silt(water, { n: 26000, box: 14 });
  world.add(silt.mesh);
  const ship = new Ship(water, { len: 42, beam: 10, draft: 3.2 });
  world.add(ship.group);
  const bubbles = new Bubbles(water, { n: 6000 });
  world.add(bubbles.mesh);
  const cam = new THREE.PerspectiveCamera(35, ctx.W / ctx.H, 0.03, 220);

  // ---- 她的游动：速度关键帧 → 路程、摆尾相位 ----
  const track = swimTrack([
    [T.start, 0.3], [T.eyeCut, 0.32], [T.body, 0.45], [T.reveal, 0.4], [T.pullback + 6, 0.32],
    [T.scan - 0.5, 0.14], [T.rumble, 0.08], [T.staticCut - 0.2, 0.04], [T.diveStart, 1.35],
    [T.diveStart + 2.2, 1.0], [T.bottomHit, 0.8], [T.bottomHit + 3.5, 0.55], [T.gone + 1.5, 0.12], [T.end, 0.03],
  ], { t0: T.start - 1, t1: T.end + 1, f0: 0.2, k: 0.8 });
  const OFF = 8;                       // 路径从 u=-8 起，吻尖弧长要平移
  const U = (t) => track.u(t) + OFF;
  const uDive0 = U(T.diveStart + 0.1) - OFF, uDive1 = U(T.bottomHit + 0.6) - OFF;
  // 路径：往上游（-x）走，轻微蛇行；船来时俯冲到河床
  const X0 = 6;
  const pts = [];
  for (let u = -OFF; u <= 70; u += 0.5) {
    const x = X0 - u;
    const z = 0.7 * Math.sin(u * 0.085) + 0.25 * Math.sin(u * 0.23 + 1.0);
    const dq = clamp((u - uDive0) / (uDive1 - uDive0));
    const dk = 1 - Math.pow(1 - smooth(Math.min(1, dq * 1.15)) , 2.2); // 先陡后缓：俯冲、贴底改平
    const bedY = bedHeight(x, z, BED);
    const y = lerp(-9.9 + 0.18 * Math.sin(u * 0.05), bedY + 0.42, dk);
    pts.push([x, y, z]);
  }
  const path = new Path(pts, { samples: 2400 });
  const tipAt = (t) => path.pos(U(t));

  // 电感视觉里的活物：沿她的路线分布
  const mid = tipAt(T.pullback + 4);
  const sparks = new Sparks(water, { n: 3600, center: [mid.x, -9.5, mid.z], size: [46, 7, 40], seed: 17, bedFn: (x, z) => bedHeight(x, z, BED) });
  world.add(sparks.mesh);

  // ---- 镜头 ----
  const c1Look = tipAt(T.rostrumCenter).clone();
  const c1Pos = c1Look.clone().add(V(0.3, 0.42, 1.15));
  const tBodyMid = (T.body + T.reveal) / 2;
  const bodyAt = path.pos(U(tBodyMid) - 1.75);
  const D = tipAt(T.bottomHit);                  // 她贴到河床的地方
  const shipZ = D.z - 1.5;
  const shipX = (t) => D.x + 6.0 * (T.peak - t); // 船往上游开（-x），ship_peak 时船中部在她头顶

  const frame = (s) => {
    const p = fish.pointAt(s);
    const Tv = fish.pointAt(s - 0.01).sub(fish.pointAt(s + 0.01)).normalize();
    const Nv = fish.pointAt(s, 0.1).sub(p).normalize();
    const Bv = fish.pointAt(s, 0, 0.1).sub(p).normalize();
    return { p, T: Tv, N: Nv, B: Bv };
  };

  const shots = [
    { t0: T.start, t1: T.eyeCut, name: 'rostrum' },
    { t0: T.eyeCut, t1: T.body, name: 'eye' },
    { t0: T.body, t1: T.reveal, name: 'bodypass' },
    { t0: T.reveal, t1: T.pullback, name: 'reveal' },
    { t0: T.pullback, t1: T.scan, name: 'stars' },
    { t0: T.scan, t1: T.rumble, name: 'scan' },
    { t0: T.rumble, t1: T.staticCut, name: 'rumble' },
    { t0: T.staticCut, t1: T.peak - 0.4, name: 'hull' },
    { t0: T.peak - 0.4, t1: T.rest, name: 'ship' },
    { t0: T.rest, t1: T.end, name: 'rest' },
  ];

  function pose(t) {
    let headYaw = 0, headPitch = 0;
    if (t > T.scan && t < T.rumble) {
      const k = (t - T.scan) / 7.5;
      headYaw = 0.16 * Math.sin(k * Math.PI * 2 * 1.5) * win(t, T.scan, T.scan + 0.8, T.rumble - 1.5, T.rumble);
    }
    if (t > T.rumble - 0.5 && t < T.staticCut + 0.5) headPitch = 0.1 * win(t, T.rumble - 0.5, T.rumble + 1.5, T.staticCut, T.staticCut + 0.5);
    const sp = track.speed(t);
    const heart = Math.pow(0.5 + 0.5 * Math.sin(t * Math.PI * 2 * (0.62 + 0.5 * win(t, T.rumble, T.rumble + 2, T.gone, T.gone + 3))), 4);
    fish.update({
      path, u: U(t), phase: track.phase(t), amp: 0.07 + 0.09 * clamp(sp / 1.2), lambda: 0.95,
      headYaw, headPitch, pect: 0.035 + 0.05 * win(t, T.rumble, T.rumble + 1, T.bottomHit, T.bottomHit + 2),
      flutter: 0.012 + 0.02 * clamp(sp), breath: 0.5 + 0.5 * Math.sin(t * 1.25), heart,
      poreGlow: 1.1 + (t > T.scan && t < T.rumble ? 0.8 * Math.abs(Math.sin((t - T.scan) * 1.9)) : 0), bodyGlow: 1, time: t,
    });
  }

  function camera(t) {
    const { shot, k } = shotAt(shots, t);
    let pos, look, focus, aperture = 7, maxc = 9;
    switch (shot.name) {
      case 'rostrum': {
        pos = c1Pos.clone().add(V(-0.25 * k, 0.05 * k, -0.1 * k)).add(shake(t, 0.012, 0.3, 1));
        look = c1Look.clone().add(V(-0.25 * k, 0.02, 0));
        focus = pos.distanceTo(fish.pointAt(0.12));
        aperture = 9;
        break;
      }
      case 'eye': {
        const f = frame(0.305);
        const [es, elat, evert] = fish.eyeLocal;
        const eye = fish.pointAt(es, elat, evert);
        pos = eye.clone().addScaledVector(f.N, 0.42 + 0.05 * k).addScaledVector(f.T, 0.22 - 0.1 * k).addScaledVector(f.B, 0.06).add(shake(t, 0.005, 0.4, 2));
        look = eye.clone().addScaledVector(f.T, -0.06);
        focus = pos.distanceTo(eye);
        aperture = 18; maxc = 16;
        break;
      }
      case 'bodypass': {
        pos = bodyAt.clone().add(V(-1.0 + 1.8 * k, 0.35, 3.4)).add(shake(t, 0.01, 0.3, 3));
        look = bodyAt.clone().add(V(-0.5 + 0.9 * k, 0.0, 0));
        focus = pos.distanceTo(fish.pointAt(0.5)); aperture = 7;
        break;
      }
      case 'reveal': {
        const f = frame(0.34);
        pos = f.p.clone().addScaledVector(f.T, -1.7 + 0.5 * k).addScaledVector(f.B, 0.95 + 0.2 * k).addScaledVector(f.N, 0.8).add(shake(t, 0.008, 0.3, 4));
        look = fish.pointAt(0.0).clone().addScaledVector(f.T, 1.2 + 1.5 * k);
        focus = pos.distanceTo(fish.pointAt(0.12));
        aperture = 5;
        break;
      }
      case 'stars': {
        const f = frame(0.5);
        const e = smooth(k);
        pos = f.p.clone().addScaledVector(f.T, -2.0 - 5.5 * e).addScaledVector(f.B, 1.0 + 5.0 * e).addScaledVector(f.N, 1.2 + 3.0 * e).add(shake(t, 0.02, 0.2, 5));
        look = f.p.clone().addScaledVector(f.T, 1.5 * e);
        focus = pos.distanceTo(f.p); aperture = 3;
        break;
      }
      case 'scan': {
        const f = frame(0.3);
        pos = f.p.clone().addScaledVector(f.T, 2.6 - 0.5 * k).addScaledVector(f.N, 1.1).addScaledVector(f.B, 0.3).add(shake(t, 0.01, 0.25, 6));
        look = fish.pointAt(0.32);
        focus = pos.distanceTo(look); aperture = 6;
        break;
      }
      case 'rumble': {
        const f = frame(0.45);
        pos = f.p.clone().addScaledVector(f.T, 1.6).addScaledVector(f.N, 2.2).addScaledVector(f.B, -2.2).add(shake(t, 0.02 + 0.04 * k, 0.5, 7));
        look = f.p.clone().addScaledVector(f.B, 1.2);
        focus = pos.distanceTo(f.p); aperture = 4;
        break;
      }
      case 'hull': {
        // 中层水里仰拍：船首从画面右边压进来，船底的一侧边缘压着亮的水面滑过去
        pos = V(D.x - 7.0, -9.3, shipZ + 7.2).add(shake(t, 0.02 + 0.05 * k, 0.9, 10));
        look = V(D.x - 3.0 + 2.0 * k, -2.0, shipZ + 2.0);
        focus = 8.0; aperture = 1.5;
        break;
      }
      case 'ship': {
        // 低机位迎着她：她从上方较亮的水里俯冲下来成剪影，贴着河床从镜头旁滑过；头顶螺旋桨过去，泥沙炸开
        const cx = D.x - 4.2, cz = D.z - 1.9;
        pos = V(cx, bedHeight(cx, cz, BED) + 0.5, cz).add(shake(t, 0.02 + 0.05 * win(t, T.peak, T.propOver - 1, T.propOver + 1, T.gone), 0.9, 8));
        const her = fish.pointAt(0.28);
        look = her.clone().add(V(-0.3, 0.35, 0));
        focus = pos.distanceTo(her); aperture = 5;
        break;
      }
      default: { // rest
        const f = frame(0.45);
        pos = f.p.clone().addScaledVector(f.N, 3.0 - 0.3 * k).addScaledVector(f.T, 0.5).addScaledVector(f.B, 0.5).add(shake(t, 0.006, 0.2, 9));
        look = f.p.clone().addScaledVector(f.T, 0.3).addScaledVector(f.B, 0.1);
        focus = pos.distanceTo(f.p); aperture = 6;
      }
    }
    cam.fov = shot.name === 'hull' ? 46 : shot.name === 'stars' ? 40 : 35;
    cam.updateProjectionMatrix();
    aim(cam, pos, look);
    return { focus, aperture, maxc };
  }

  // 波前中心固定在揭示那一刻的吻尖（按那一刻的姿态算，保证任意跳帧一致）
  pose(T.reveal);
  const EC = fish.pointAt(0.0).clone();

  function electro(t) {
    water.uEC.value.copy(EC);
    if (t >= T.reveal && t < T.waveEnd) {
      water.uER.value = (t - T.reveal) * 7.0;
      water.uEMix.value = 0;
    } else {
      water.uER.value = -1;
      water.uEMix.value = t >= T.waveEnd && t < T.staticCut ? 1 : 0;
    }
    water.uENoise.value = t < T.rumble ? 0 : t < T.staticCut ? Math.pow((t - T.rumble) / (T.staticCut - T.rumble), 1.6) * 1.2 : 0;
    if (t >= T.staticCut - 0.25 && t < T.staticCut) water.uENoise.value = 3.0; // 切回真实视角前满屏雪花
    water.uERange.value = 16;
  }

  return {
    id: 's1_river', start: T.start, end: T.end,
    render(t, ctx) {
      pose(t);
      electro(t);
      const { focus, aperture, maxc } = camera(t);
      const sx = shipX(t);
      ship.place(sx, shipZ, Math.PI, t * 2 * Math.PI * 2.6, 0);
      ship.group.visible = t > T.rumble - 2 && t < T.gone + 6;
      water.uOcc.value.set(sx, shipZ, ship.len / 2, ship.beam / 2);
      water.uOccAng.value = Math.PI;
      water.uOccAmt.value = win(t, T.rumble, T.staticCut - 0.5, T.gone, T.gone + 2.5);
      const b = bubbles.u;
      const tb0 = T.peak + 1.5;
      b.uT0.value = tb0; b.uDur.value = 6.0;
      b.uEmit0.value.set(shipX(tb0) - ship.len / 2 + 1.2, -ship.draft * 0.62, shipZ);
      b.uEmitV.value.set(-6.0, 0, 0);
      b.uBack.value.set(1, 0, 0);
      b.uTanHalf.value = Math.tan((cam.fov * Math.PI) / 360);
      silt.set(cam, { focus, aperture: aperture * 0.8, storm: [D.x, D.y + 0.5, D.z], stormAmt: win(t, T.bottomHit - 0.6, T.bottomHit + 0.6, T.gone, T.end) * 1.2 });
      sparks.set(cam, { gain: 1 - 0.7 * clamp((t - T.rumble) / (T.staticCut - T.rumble)) });
      world.render(ctx, { t, camera: cam, dof: { focus, aperture, max: maxc }, shafts: 1, fieldLines: 1 });
    },
    postFx(t) {
      const fin = 1 - smooth((t - T.start) / 2.8);
      const fout = smooth((t - T.fadeOut) / 1.5);
      const el = water.uEMix.value;
      const dark = win(t, T.staticCut, T.peak, T.gone, T.gone + 3);
      return {
        exposure: 1.45 + 0.45 * dark, bloom: 0.45 + 0.35 * el, bloomThreshold: 0.75, bloomRadius: 1.0, vignette: 0.5, grain: 0.045,
        toneMix: 1, halation: 0.15, ca: 0.0006, fade: Math.max(fin, fout),
      };
    },
  };
}
