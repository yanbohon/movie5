// S4 七年：她背上旧信标的特写 → 延时：七个春夏秋冬一闪而过，信标生锈长藻、飘带褪白，叫声一声比一声弱，停了 →
// 拉远：她一个人 → 电感视觉：头顶的船开过去好几次 → 最后一次停在她头顶，放下水听器，一圈圈地听 → 听不见她，拉上去，开走。
import * as THREE from 'three';
import { UnderwaterWorld, makeWaterUniforms } from '../film/uw/world.js';
import { Fish, Path, TAG_S, TAG_THETA } from '../film/uw/fish.js';
import { sectionPoint } from '../film/uw/fishgeo.js';
import { Riverbed, bedHeight } from '../film/uw/bed.js';
import { Silt, Sparks } from '../film/uw/particles.js';
import { Ship, Bubbles, Hydrophone } from '../film/uw/ship.js';
import { PulseRings, GlowBlobs, GlowLayer, fishAura } from '../film/uw/glow.js';
import { swimTrack, shake, aim, shotAt } from '../film/uw/motion.js';
import { clamp, smooth, lerp, win } from '../film/util.js';
import { s4Times, tagPings } from './s4_seven/events.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

export default async function (ctx) {
  const T = s4Times(ctx.timeline);
  const PINGS = tagPings(T);
  const BED = -7;                                   // 枯水期，江浅一些：船从她头顶五米多开过去
  const water = makeWaterUniforms();
  const base = { sun: water.uSunColor.value.clone(), fu: water.uFogUp.value.clone(), fd: water.uFogDown.value.clone(), au: water.uAmbUp.value.clone(), ad: water.uAmbDown.value.clone() };
  const world = new UnderwaterWorld(ctx, { water });
  const bed = new Riverbed(water, { base: BED, center: [0, 0], size: 130, rocks: 80, rockRegion: 60, seed: 12 });
  world.add(bed.group);
  const her = new Fish({ species: 'paddlefish', L: 3.5, water });
  world.add(her.group);
  const silt = new Silt(water, { n: 24000, box: 14 });
  world.add(silt.mesh);
  const sparks = new Sparks(water, { n: 700, center: [0, BED + 2.5, 0], size: [50, 5, 40], seed: 31, bedFn: (x, z) => bedHeight(x, z, BED) });
  world.add(sparks.mesh);
  const shipA = new Ship(water, { len: 8, beam: 2.6, draft: 0.8, propR: 0.35 });
  const shipB = new Ship(water, { len: 9, beam: 2.8, draft: 0.9, propR: 0.4 });
  // 电感视觉里的小艇：只看得见螺旋桨处一小团噼啪作响的电噪，船壳是淡淡的轮廓
  for (const s of [shipA, shipB]) {
    s.u.uHullGlow.value = 0.35; s.u.uHotFall.value = 3.2;
    s.u.uHot.value.set(-s.len / 2 + 1.2, -s.draft * 0.62, 0);
  }
  world.add(shipA.group, shipB.group);
  const bubbles = new Bubbles(water, { n: 2500 });
  world.add(bubbles.mesh);
  const hydro = new Hydrophone(water);
  world.add(hydro.group);
  const pings = new PulseRings(water, { n: 2, pow: 10 });
  const listen = new PulseRings(water, { n: 3, electroOnly: true, pow: 14 });
  world.add(pings.group, listen.group);
  // 电感视觉里她自己的一团光（远一点也看得见她，跟着心跳涨缩）
  const glow = new GlowLayer();
  const aura = new GlowBlobs(water, { n: 48, electroOnly: true, fadeRange: 30, maxPx: 520, overlay: true, nearFade: 2.2 });
  glow.add(aura);
  const heartAt = (t) => Math.pow(0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.58), 4);
  const cam = new THREE.PerspectiveCamera(35, ctx.W / ctx.H, 0.03, 220);

  // ---- 她：往上游慢慢游，后来几乎不动 ----
  const bedAt = (x, z) => {
    let s = 0;
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) s += bedHeight(x + dx, z + dz, BED);
    return s / 5;
  };
  const pts = [];
  for (let x = 20; x >= -30; x -= 0.5) {
    const z = 0.3 * Math.sin(x * 0.12);
    pts.push([x, bedAt(x, z) + 1.0 + 0.08 * Math.sin(x * 0.4), z]);
  }
  const path = new Path(pts, { samples: 2400 });
  const track = swimTrack([
    [T.start, 0.3], [T.pullback, 0.28], [T.boat, 0.2], [T.arrive[0], 0.08], [T.lower[1], 0.03], [T.end, 0.03],
  ], { t0: T.start - 1, t1: T.end + 1, f0: 0.2, k: 0.8 });
  const U = (t) => 12 + track.u(t);

  // ---- 延时：七个年头的明暗（加速再减速，一共七个周期），泥沙被冲得飞快 ----
  const lapseK = (t) => clamp((t - T.lapse0) / (T.lapse1 - T.lapse0));
  const lapsePhase = (t) => { const k = lapseK(t); return 7 * (k * k * (3 - 2 * k)); };
  const dayAt = (t) => (t <= T.lapse0 || t >= T.lapse1 ? 1 : 0.5 + 0.5 * Math.cos(2 * Math.PI * lapsePhase(t)));
  // 泥沙位移 = ∫v dt（shader 里是 uCurrent·t，所以给 D(t)/t）
  const dtab = [], DT = 1 / 60;
  { let D = 0; for (let t = T.start - 1; t <= T.end + 1; t += DT) { dtab.push(D); D += (0.12 + 2.6 * win(t, T.lapse0, T.lapse0 + 0.8, T.lapse1 - 0.6, T.lapse1)) * DT; } }
  const driftAt = (t) => { const f = clamp((t - (T.start - 1)) / DT, 0, dtab.length - 1.001); const i = Math.floor(f); return lerp(dtab[i], dtab[i + 1], f - i); };

  const frame = (s) => {
    const p = her.pointAt(s);
    const Tv = her.pointAt(s - 0.01).sub(her.pointAt(s + 0.01)).normalize();
    const Nv = her.pointAt(s, 0.1).sub(p).normalize();
    const Bv = her.pointAt(s, 0, 0.1).sub(p).normalize();
    return { p, T: Tv, N: Nv, B: Bv };
  };
  const [tagLat, tagVert] = sectionPoint(her.P, her.L, TAG_S, TAG_THETA);
  const tagCy = her.P.c(TAG_S) * her.L, tagNl = Math.hypot(tagLat, tagVert - tagCy);
  const tagPos = () => her.pointAt(TAG_S, tagLat * (1 + 0.0112 / tagNl), tagCy + (tagVert - tagCy) * (1 + 0.0112 / tagNl));

  function pose(t) {
    const sp = track.speed(t);
    const heart = heartAt(t);
    her.update({
      path, u: U(t), phase: track.phase(t), amp: 0.06 + 0.08 * clamp(sp / 1.0), lambda: 0.95,
      pect: 0.04, flutter: 0.012 + 0.03 * win(t, T.lapse0, T.lapse0 + 0.5, T.lapse1 - 0.5, T.lapse1) + 0.02 * clamp(sp),
      breath: 0.5 + 0.5 * Math.sin(t * 1.2), heart, poreGlow: 1.0, bodyGlow: 1 + 0.6 * win(t, T.L41.t, T.L41.t + 0.4, T.L41.t + 1.2, T.L41.t + 2.4), time: t,
    });
    her.u.uTagAge.value = lerp(0.35, 1.0, smooth(lapseK(t)));
  }

  // 船的位置：以她在 search_boat 那一刻的位置为参照（按那一刻的姿态算，任意跳帧一致）
  pose(T.boat);
  const H = her.pointAt(0.4).clone();
  pose(T.lower[1]);
  const Hstop = her.pointAt(0.3).clone();
  const hydroBottom = Hstop.clone().add(V(0, 2.3, 0));
  const parkX = Hstop.x + 0.9, parkZ = Hstop.z - 1.0;

  function boats(t) {
    // A：第一次（快）+ 最后一次（减速停在头顶，放水听器，再开走）；B：第二次（斜着）
    let ax, az, ah = Math.PI, ae = 0;
    if (t < T.pass1[1] + 0.5) {
      const k = (t - T.pass1[0]) / (T.pass1[1] - T.pass1[0]);
      ax = H.x + 24 - 48 * k; az = H.z + 1.4;
      ae = 0.8 * win(t, T.pass1[0], T.pass1[0] + 0.8, T.pass1[1] - 0.8, T.pass1[1]);
    } else {
      const k = smooth(clamp((t - T.arrive[0]) / (T.arrive[1] - T.arrive[0])));
      const e = 1 - Math.pow(1 - k, 2.2);
      ax = lerp(parkX + 20, parkX, e); az = parkZ;
      const go = Math.max(0, t - T.depart);
      ax -= 0.9 * go * go;                                    // 开走：慢慢加速
      ae = win(t, T.arrive[0] - 0.2, T.arrive[0] + 0.8, T.end + 5, T.end + 6) * (0.7 + 0.4 * clamp(go));
    }
    shipA.place(ax, az, ah, t * 2 * Math.PI * 7.0, 0);
    shipA.u.uEngine.value = ae;
    shipA.group.visible = ae > 0.001;
    const kb = (t - T.pass2[0]) / (T.pass2[1] - T.pass2[0]);
    const hb = 2.35;
    const db = -24 + 48 * kb;
    shipB.place(H.x + Math.cos(Math.PI - hb) * -db, H.z + Math.sin(hb) * db - 0.8, hb, t * 2 * Math.PI * 7.5, 0);
    shipB.u.uEngine.value = 0.8 * win(t, T.pass2[0], T.pass2[0] + 0.8, T.pass2[1] - 0.8, T.pass2[1]);
    shipB.group.visible = shipB.u.uEngine.value > 0.001;
    // 水听器：船停稳后放下来；search_leave 拉上去
    const down = smooth(clamp((t - T.lower[0]) / (T.lower[1] - T.lower[0]))) * (1 - smooth(clamp((t - T.leave) / 1.6)));
    hydro.group.visible = down > 0.01;
    const top = V(ax + 0.5, 0.05, az + shipA.beam * 0.5);
    const bottom = top.clone().lerp(hydroBottom, down);
    bottom.y = lerp(-0.2, hydroBottom.y, down);
    hydro.place(top, bottom, t);
    hydro.u.uListen.value = 0.4 + 0.6 * win(t, T.listen[0], T.listen[0] + 0.5, T.listen[1] - 0.3, T.listen[1]);
    return { ax, az, bottom, down };
  }

  const shots = [
    { t0: T.start, t1: T.pullback, name: 'tag' },
    { t0: T.pullback, t1: T.boat, name: 'alone' },
    { t0: T.boat, t1: T.end, name: 'long' },
  ];

  function camera(t) {
    const { shot, k } = shotAt(shots, t);
    let pos, look, focus, aperture = 6, maxc = 10, fov = 35;
    switch (shot.name) {
      case 'tag': {
        // 信标微距：低机位贴着她背的弧线，信标和飘带衬在浑水前面；镜头跟着她一起游
        const f = frame(0.6), tp = tagPos();
        pos = tp.clone().addScaledVector(f.N, 0.3 - 0.04 * k).addScaledVector(f.B, 0.05).addScaledVector(f.T, 0.1 - 0.03 * k).add(shake(t, 0.002, 0.3, 1));
        look = tp.clone().addScaledVector(f.T, -0.05).addScaledVector(f.B, 0.01);
        focus = pos.distanceTo(tp); aperture = 18; maxc = 18; fov = 30;
        break;
      }
      case 'alone': {
        // 从信标拉起、拉远：她越来越小，化进浑水里
        const f = frame(0.6), tp = tagPos();
        const e = smooth(k);
        const near = tp.clone().addScaledVector(f.N, 0.26).addScaledVector(f.B, 0.05).addScaledVector(f.T, 0.07);
        const far = frame(0.45).p.addScaledVector(f.N, 5.2).addScaledVector(f.B, 3.6).addScaledVector(f.T, -0.8);
        pos = near.lerp(far, e).add(shake(t, 0.004 + 0.01 * e, 0.25, 2));
        look = tp.clone().lerp(frame(0.45).p, Math.min(1, e * 1.6));
        focus = pos.distanceTo(look); aperture = lerp(20, 3, e); maxc = 16; fov = lerp(30, 42, e);
        break;
      }
      case 'long': {
        // 一个长镜头（遮幅后可见高度只有 3/4）：她是画面底部一小团光，船一趟趟从上面水面开过去；
        // 最后一条停下，水听器垂到她头顶；镜头慢慢推近，拉上去以后留她一个
        const push = smooth((t - (T.arrive[1] - 1.0)) / 4.5);
        const up = smooth((t - T.leave) / 2.5);
        const D = lerp(12.5, 8.0, push);
        pos = Hstop.clone().add(V(0.6, lerp(1.4, 0.9, push), -D)).add(shake(t, 0.006, 0.2, 3));
        look = Hstop.clone().add(V(0.2, lerp(3.0, 1.25, push) + 0.35 * up, 0.4));
        focus = pos.distanceTo(Hstop); aperture = 1.5; fov = lerp(46, 42, push);
        break;
      }
    }
    cam.fov = fov;
    cam.updateProjectionMatrix();
    aim(cam, pos, look);
    return { focus, aperture, maxc };
  }

  function electro(t) {
    water.uERange.value = 16;
    water.uENoise.value = 0;
    if (t < T.boat) { water.uER.value = -1; water.uEMix.value = 0; return; }
    pose(T.boat);
    water.uEC.value.copy(her.pointAt(0.3));
    pose(t);
    const r = (t - T.boat) * 7.0;
    if (r < 28) { water.uER.value = r; water.uEMix.value = 0; } else { water.uER.value = -1; water.uEMix.value = 1; }
  }

  function light(t) {
    const d = dayAt(t);
    const s = 0.78 * lerp(0.12, 1, d), a = 0.85 * lerp(0.3, 1, d);
    water.uSunColor.value.copy(base.sun).multiplyScalar(s);
    water.uFogUp.value.copy(base.fu).multiplyScalar(a);
    water.uFogDown.value.copy(base.fd).multiplyScalar(a);
    water.uAmbUp.value.copy(base.au).multiplyScalar(a);
    water.uAmbDown.value.copy(base.ad).multiplyScalar(a);
  }

  return {
    id: 's4_seven', start: T.start, end: T.end,
    render(t, ctx) {
      pose(t);
      electro(t);
      light(t);
      const b = boats(t);
      const { focus, aperture, maxc } = camera(t);
      // 信标的叫声：从信标向外扩的一圈
      pings.begin();
      for (const [tp, amp] of PINGS) {
        const dt = t - tp;
        if (dt < 0 || dt > 0.55) continue;
        const r = 0.02 + dt * 0.55;
        pings.push(tagPos(), r, amp * 0.6 * (1 - smooth(dt / 0.55)) * smooth(dt / 0.05));
      }
      // 水听器在听：三圈往里收
      listen.begin();
      const lk = win(t, T.listen[0], T.listen[0] + 0.6, T.listen[1] - 0.4, T.listen[1]);
      if (lk > 0.001) for (let i = 0; i < 3; i++) {
        const ph = ((t - T.listen[0]) / 1.7 + i / 3) % 1;
        const r = 2.6 * (1 - ph);
        listen.push(b.bottom, r, lk * 0.2 * smooth(ph / 0.25) * smooth((1 - ph) / 0.08));
      }
      silt.set(cam, { focus, aperture: aperture * 0.8, current: [driftAt(t) / Math.max(1, t), 0, 0.01] });
      sparks.set(cam, { gain: 0.6 });
      const bu = bubbles.u;
      bu.uT0.value = T.depart; bu.uDur.value = 4.0;
      bu.uEmit0.value.set(parkX - 3.6, -0.5, parkZ);
      bu.uEmitV.value.set(-2.0, 0, 0);
      bu.uBack.value.set(1, 0, 0);
      bu.uTanHalf.value = Math.tan((cam.fov * Math.PI) / 360);
      aura.begin();
      if (water.uEMix.value > 0 || water.uER.value > 0) fishAura(her, aura, { gain: 0.32, heart: heartAt(t), time: t, pores: 0, spread: 1.4 });
      aura.end(cam);
      const dof = { focus, aperture, max: maxc };
      world.render(ctx, { t, camera: cam, dof, shafts: 1, fieldLines: 1 });
      glow.render(ctx, world, cam, dof);
    },
    postFx(t) {
      const el = water.uEMix.value;
      const fin = 1 - smooth((t - T.start) / T.fadeIn);
      return {
        exposure: 1.3 + 0.2 * el, bloom: 0.45 + 0.4 * el, bloomThreshold: 0.75, bloomRadius: 1.0, vignette: 0.5, grain: 0.045,
        toneMix: 1, halation: 0.15, ca: 0.0006, fade: fin,
      };
    },
  };
}
