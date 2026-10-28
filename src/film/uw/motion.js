// 编舞工具：速度关键帧积分成路程与摆尾相位（预先算表，按 t 查，纯函数），镜头手持抖动。
import * as THREE from 'three';
import { noise1, clamp, lerp } from '../util.js';

/**
 * keys: [[t, speed(米/秒)], ...]（线性插值）。返回 { u(t) 路程, phase(t) 摆尾相位, speed(t) }
 * 摆尾频率随速度：f = f0 + k * speed（赫兹）
 */
export function swimTrack(keys, { t0, t1, dt = 1 / 120, f0 = 0.22, k = 0.75, u0 = 0 }) {
  const n = Math.ceil((t1 - t0) / dt) + 2;
  const U = new Float64Array(n), Ph = new Float64Array(n);
  const sp = (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [ta, va] = keys[i], [tb, vb] = keys[i + 1];
      if (t <= tb) { const x = (t - ta) / (tb - ta); const s = x * x * (3 - 2 * x); return lerp(va, vb, s); }
    }
    return keys[keys.length - 1][1];
  };
  U[0] = u0; Ph[0] = 0;
  for (let i = 1; i < n; i++) {
    const ta = t0 + (i - 1) * dt, tb = t0 + i * dt;
    const va = sp(ta), vb = sp(tb);
    U[i] = U[i - 1] + 0.5 * (va + vb) * dt;
    Ph[i] = Ph[i - 1] + 2 * Math.PI * (f0 + k * 0.5 * (va + vb)) * dt;
  }
  const look = (A, t) => {
    const f = clamp((t - t0) / dt, 0, n - 1.0001);
    const i = Math.floor(f), x = f - i;
    return A[i] * (1 - x) + A[i + 1] * x;
  };
  return { u: (t) => look(U, t), phase: (t) => look(Ph, t), speed: sp };
}

/** 确定性的手持抖动（米 / 弧度），amp 幅度，f 频率 */
export function shake(t, amp = 0.02, f = 0.35, seed = 0) {
  return new THREE.Vector3(noise1(t * f + seed * 11.3), noise1(t * f * 1.13 + seed * 7.1 + 40), noise1(t * f * 0.91 + seed * 3.7 + 80)).multiplyScalar(amp);
}

/** 相机看向某点，附带滚转 roll（弧度） */
export function aim(cam, pos, target, roll = 0) {
  cam.position.copy(pos);
  cam.up.set(Math.sin(roll), Math.cos(roll), 0);
  cam.lookAt(target);
  cam.updateMatrixWorld();
}

/** 按时间找当前镜头：shots = [{t0, t1, ...}]，返回 {shot, k(0..1), lt(镜头内秒数)} */
export function shotAt(shots, t) {
  let s = shots[0];
  for (const x of shots) if (t >= x.t0) s = x;
  return { shot: s, lt: t - s.t0, k: clamp((t - s.t0) / Math.max(1e-6, s.t1 - s.t0)) };
}
