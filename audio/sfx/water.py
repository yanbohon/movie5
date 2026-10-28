"""水下音效（3D 段落：她的主观听感 —— 低频厚、高频少、远处的东西隔着水传来）。

每个函数返回 dict(audio=(2,n) 或 (n,), pre=同步点在缓冲里的位置(秒), events=[...], norm='peak'|'lufs')。
同步点：瞬态类 = 起音；掠过类 = 最近点（峰值）；见各函数说明。
"""
from __future__ import annotations

import numpy as np

from .dsp import (SR, TWO_PI, perceived_peak, add_at, bp, brown, ctrl_noise, curve, dbg, env_ad, env_pts, eq, grain_bank, hp,
                  impulses, ir_preset, lp, ns, pan, pan_curve, pink, poisson_times, resonate, reverb, sine_sweep,
                  smoothstep, softclip, stereo, sweep_bp, sweep_lp, tvec, uw_color, white, widen, width)


def _nz(x):
    return x / (np.max(np.abs(x)) + 1e-12)


def _sd(x):
    return x / (np.std(x) + 1e-12)


# ================================================================ 游过镜头的水流
def uw_whoosh(seed=0, dur=2.4, tpk=0.55, size=1.0, pan_from=-0.55, pan_to=0.55, bright=1.0, sharp=4.0):
    """大身体从镜头前滑过：推开水的低频压力 + 中低频水流（时变带通）+ 一点湍动。同步点 = 最近点（包络尖峰）。"""
    rng = np.random.default_rng(seed)
    tp = tpk * dur
    tail = 1.4
    n = ns(dur + tail)
    t = tvec(n)
    tau = 0.16 * dur
    env = np.where(t < tp, (t / tp) ** sharp, np.exp(-(t - tp) / tau))
    env *= np.clip((dur + tail - t) / 0.25, 0, 1)
    fc = curve([(0, 110 * bright), (tp, 480 * bright * size ** -0.3), (dur, 150 * bright), (dur + tail, 120)])
    body = sweep_bp(pink(n, rng), fc, lambda tt: 0.8, block=128)
    press = lp(white(n, rng), 75, order=4)
    turb = bp(pink(n, rng), 450, 1600, order=2)
    y = (_sd(body) + 0.9 * size * _sd(press) + 0.12 * _sd(turb) * env) * env
    # 最近点的"擦身"：一小段更亮的推水，窄高斯包络（σ ≈ 0.035·dur）。宽包络的最响处本来是糊的（±50 ms 都差不多响），
    # 这一层把"最近点"钉在 tp 上，听感上也是擦身而过的那一下
    sig = min(0.03 * dur, 0.08)
    swish = bp(pink(n, rng), 300 * bright, 1500 * bright, order=2) * np.exp(-0.5 * ((t - tp) / sig) ** 2)
    y += 0.8 * _sd(swish) * np.max(env)
    out = pan_curve(y, np.linspace(pan_from, pan_to, n))
    out = uw_color(out, cutoff=1500 * bright)
    out = reverb(out, ir_preset("uw_small"), wet=0.3)
    # 同步点 = 听感上的最响处（A 计权 120 ms RMS 峰值；混响和慢衰减会把它往后推十几毫秒，按实测放）
    ipk = perceived_peak(out, tp, win=0.12, search=0.15)
    return dict(audio=out, pre=ipk / SR)


# ================================================================ 电感视觉：晶莹细碎的高频闪烁
def electro_sparkle(seed=0, dur=25.0, density=24.0, wave=1.0, fade_out=0.8, twinkle=0.9):
    """颗粒合成：Poisson 分布的极短正弦颗粒（3–11 kHz 连续随机频率、3–12 ms、Hann 窗）→ 无固定音高；
    偶尔 3–7 粒一簇的"一闪一闪"；起点一圈荡开的波（带通噪声 1.5→9 kHz 扫开 + 很轻的低频"场"切换）。
    同步点 = 波的起音（t=0）。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 1.0)
    t = tvec(n)
    out = np.zeros((2, n))
    # 荡开的波
    if wave > 0:
        m = ns(1.8)
        tt = tvec(m)
        e = smoothstep(tt / 0.012) * np.exp(-tt / 0.42)
        sw = sweep_bp(white(m, rng), curve([(0, 1500), (0.9, 9000), (1.8, 11000)]), lambda x: 1.6, block=64) * e
        whump = lp(white(m, rng), 90, order=4) * env_ad(m, 0.008, 0.12)
        wv = widen(sw / (np.max(np.abs(sw)) + 1e-9), 0.8, seed) + 0.35 * stereo(_nz(whump))
        add_at(out, wv * 0.35 * wave, 0)
    # 持续颗粒
    ramp = smoothstep(t / 1.5) * smoothstep((dur - t) / max(fade_out, 0.05))
    mod = np.clip(0.8 + 0.3 * ctrl_noise(n, rng, 0.15), 0.3, 1.4)
    rate = density * ramp * mod + 1e-6
    times = poisson_times(rate, rng, dur)
    k = len(times)
    freqs = np.exp(rng.uniform(np.log(3000), np.log(11000), k))
    durs = rng.uniform(0.0025, 0.007, k)
    amps = rng.lognormal(-0.6, 0.55, k) * ramp[np.minimum((times * SR).astype(int), n - 1)]
    pans = rng.uniform(-0.9, 0.9, k)
    is_sine = rng.random(k) < 0.6
    out += grain_bank(n, times[is_sine], freqs[is_sine], durs[is_sine], amps[is_sine] * 0.35, pans[is_sine], "sine", rng)
    out += grain_bank(n, times[~is_sine], freqs[~is_sine], durs[~is_sine] * 1.5, amps[~is_sine] * 0.3, pans[~is_sine],
                      "noise", rng, bw=3.0)
    # 一闪一闪：小簇
    ct = poisson_times(twinkle * ramp * mod + 1e-6, rng, dur)
    for tc in ct:
        c = int(rng.integers(3, 8))
        f0 = np.exp(rng.uniform(np.log(3500), np.log(9500)))
        tt = tc + np.sort(rng.uniform(0, rng.uniform(0.04, 0.09), c))
        ff = f0 * np.exp(rng.normal(0, 0.12, c))
        p0 = rng.uniform(-0.8, 0.8)
        out += grain_bank(n, tt, ff, rng.uniform(0.0025, 0.006, c), 0.3 * rng.lognormal(-0.4, 0.4, c) * ramp[min(int(tc * SR), n - 1)],
                          np.clip(p0 + rng.normal(0, 0.1, c), -0.95, 0.95), "sine", rng)
    air = hp(white(n, rng), 7000, order=2) * ramp
    out += widen(air, 0.9, seed + 1) * 0.004
    out = reverb(out, ir_preset("plate_short"), wet=0.14)
    return dict(audio=out, pre=0.0, norm="lufs")


def field_crackle(seed=0, dur=3.9, end_burst=True):
    """rumble_start → ship_pass：电场开始闪烁、出现噪点。稀疏的电噼啪由少到多，最后一段接近白噪声。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.3)
    t = tvec(n)
    u = np.clip(t / dur, 0, 1)
    rate = 6 + 260 * u ** 3
    times = poisson_times(rate, rng, dur)
    amps = rng.lognormal(-0.8, 0.8, len(times)) * rng.choice([-1, 1], len(times)) * (0.4 + 0.6 * u[np.minimum((times * SR).astype(int), n - 1)])
    x = impulses(n, times, amps)
    cr = resonate(x, [2400, 4100, 6300], [0.00025, 0.0002, 0.00015], [1, 0.8, 0.6]) + 0.4 * hp(x, 3000, order=1)
    hiss = bp(white(n, rng), 1500, 9000, order=2) * u ** 4 * (t < dur)
    y = widen(cr, 0.9, seed) + 0.35 * widen(hiss, 0.9, seed + 1) * np.std(cr) / (np.std(hiss) + 1e-9) * 3
    y = lp(y, 9000, order=2)
    return dict(audio=reverb(y, ir_preset("plate_short"), wet=0.15), pre=0.0, norm="lufs")


# ================================================================ 巨大的船从头顶压过
def ship_pass(seed=0, t_pass=3.9, t_peak=7.1, t_gone=11.9, t_prop=None, t_bow=None, tail=6.5, f_fire=37.0,
              shaft_hz=3.1, blades=4, doppler=0.035, pan_from=0.45, pan_to=-0.45):
    """一条大船从头顶压过（缓冲从 rumble_start 开始，t_* 为相对时间）：
      距离模型 d(t)（接近慢、远去快）→ 电平 ~1/d、截止频率随距离（远 = 闷）
      引擎：点火频率 f_fire 的谐波列（1/k^0.9），多普勒：接近时 +doppler、远去时 -doppler（电影化夸张）
      螺旋桨：叶片频率 shaft_hz×blades 的尖脉冲 → 低频"呼、呼"脉动 + 调制空化碎裂噪声（泊松噼啪）
      船体水流：宽带低频轰鸣；压力：t_peak 附近的 20–45 Hz 次声涌
      t_pass：电感视觉被白噪声冲垮（短促的亮噪声冲击，起音）；t_peak：最近的一记叶片重拍（最响）
    同步点 = 缓冲开头（rumble_start）；events=[t_pass, t_peak, t_gone]。"""
    rng = np.random.default_rng(seed)
    total = t_gone + tail
    n = ns(total)
    t = tvec(n)
    # 距离：峰值处 d=1；t_pass 处 d≈3；rumble_start 处 d≈6；远去更快（t_gone 处 d≈5）
    v_app = np.sqrt(3.0 ** 2 - 1) / max(t_peak - t_pass, 0.5)
    v_rec = np.sqrt(5.0 ** 2 - 1) / max(t_gone - t_peak, 0.5)
    x = np.where(t < t_peak, v_app * (t - t_peak), v_rec * (t - t_peak))
    d = np.sqrt(1.0 + x ** 2)
    amp = 1.0 / d ** 1.15
    # 多普勒
    s = -doppler * np.tanh(x / 1.2)
    # 引擎谐波
    f_eng = f_fire * (1 + s) * (1 + 0.004 * ctrl_noise(n, rng, 0.4))
    ph = TWO_PI * np.cumsum(f_eng) / SR
    eng = np.zeros(n)
    for k in range(1, 15):
        eng += (1.0 / k ** 0.9) * np.sin(k * ph + rng.uniform(0, TWO_PI)) * (1 + 0.15 * ctrl_noise(n, rng, 2.0))
    eng += 0.5 * lp(white(n, rng), 200, order=2) * (0.5 + 0.5 * np.cos(ph)) ** 4
    # 螺旋桨在船尾：它的最近点 t_prop 晚于船体（没给就按 t_peak + 1.5）
    t_prop = t_peak + 1.5 if t_prop is None else t_prop
    vp_app = np.sqrt(4.0 ** 2 - 1.3 ** 2) / max(t_prop - t_pass, 0.5)
    vp_rec = np.sqrt(5.0 ** 2 - 1.3 ** 2) / max(t_gone - t_prop, 0.5)
    xp = np.where(t < t_prop, vp_app * (t - t_prop), vp_rec * (t - t_prop))
    dp = np.sqrt(1.3 ** 2 + xp ** 2)
    amp_p = 1.0 / dp ** 1.2
    sp = -doppler * np.tanh(xp / 1.2)
    # 叶片脉冲
    fb = shaft_hz * blades * (1 + sp)
    phb = TWO_PI * np.cumsum(fb * (1 + 0.01 * ctrl_noise(n, rng, 1.0))) / SR
    pulse = (0.5 + 0.5 * np.cos(phb)) ** 6
    thump = lp(white(n, rng), 70, order=4) * pulse
    # 空化噼啪（泊松，随螺旋桨距离与叶片脉冲调制）
    cav_rate = 3500 * amp_p ** 1.4 * (0.3 + 0.7 * pulse) + 1e-6
    ct = poisson_times(cav_rate, rng, total)
    cx = impulses(n, ct, rng.lognormal(-0.3, 0.9, len(ct)) * rng.choice([-1, 1], len(ct)))
    cav = bp(cx, 500, 6500, order=2) + 0.5 * bp(white(n, rng), 800, 5000, order=2) * pulse * amp_p
    # 船体水流：宽带低频轰鸣
    hull = lp(hp(pink(n, rng), 30, order=2), 420, order=2) * (1 + 0.2 * ctrl_noise(n, rng, 0.8))
    # 时变低通：远 = 闷
    fcut = 160.0 + 1500.0 / d
    fcs = fcut[::256]
    fcf = lambda tt: float(fcs[min(int(tt * SR) // 256, len(fcs) - 1)])
    fcp = (160.0 + 1500.0 / dp)[::256]
    cav = sweep_lp(cav, lambda tt: 2.4 * float(fcp[min(int(tt * SR) // 256, len(fcp) - 1)]), block=256)
    eng = sweep_lp(eng, fcf, block=256)
    hull = sweep_lp(hull, lambda tt: 0.8 * fcf(tt), block=256)
    # 压力涌
    press = lp(hp(brown(n, rng), 18, order=2), 45, order=4) * np.exp(-0.5 * ((t - t_peak) / 1.4) ** 2)
    y = amp * (0.55 * _sd(eng) + 1.0 * _sd(hull)) + amp_p * (0.8 * _sd(thump) + 0.55 * _sd(cav)) + 0.9 * _sd(press)
    if t_bow is not None:  # 船头压过来：一道低频的推水
        bw = lp(white(n, rng), 90, order=4) * smoothstep((t - t_bow) / 0.05) * np.exp(-np.maximum(t - t_bow, 0) / 0.5) * (t > t_bow)
        y += 0.7 * _sd(bw) * np.max(np.abs(amp)) * 0.5
    # t_peak：最近的一记重拍（低频下滑 + 空化爆裂）
    m = ns(0.9)
    tt = tvec(m)
    whump = sine_sweep(m, 30 + 28 * np.exp(-tt / 0.08)) * env_ad(m, 0.004, 0.28)
    whump += 0.5 * lp(white(m, rng), 120, order=4) * env_ad(m, 0.003, 0.09) / 0.3
    crack = bp(white(m, rng), 700, 4500, order=2) * env_ad(m, 0.002, 0.05)
    hit = 1.6 * _nz(whump) + 0.5 * _nz(crack)
    add_at(y, hit * np.max(np.abs(y)) * 0.55, ns(t_peak))
    # t_pass：电感视觉被白噪声冲垮（她的"电感"而不是声学声音：亮一些，但不刺）
    m = ns(1.2)
    tt = tvec(m)
    burst = lp(hp(white(m, rng), 250, order=2), 8500, order=2) * smoothstep(tt / 0.004) * np.exp(-tt / 0.28)
    burst = burst * smoothstep((1.2 - tt) / 0.25)
    burst = widen(burst, 0.9, seed + 3)
    # 声像：从一侧压过头顶到另一侧（整体保持宽）
    pc = pan_from + (pan_to - pan_from) * smoothstep((t - t_pass + 1.0) / (t_gone - t_pass + 1.0))
    out = pan_curve(y, pc * 0.7)
    out = width(out, 1.15)
    out = uw_color(out, cutoff=2600, low_db=2.0)
    add_at(out, burst * np.max(np.abs(out)) * 0.45, ns(t_pass))
    out = reverb(out, ir_preset("uw_big"), wet=0.28)[:, :n]
    out[:, -ns(1.2):] *= np.linspace(1, 0, ns(1.2))
    return dict(audio=out, pre=0.0, events=[round(t_pass, 4), round(t_peak, 4), round(t_prop, 4), round(t_gone, 4)])


def sediment(seed=0, t_peak=3.2, t_gone=8.0, settle=5.0, peak_rate=1400.0):
    """泥沙风暴打在身上：极密的细沙颗粒（近身、略闷）+ 沙云的"沙沙"；t_gone 之后泥沙慢慢落定、越来越稀。
    同步点 = 缓冲开头（ship_pass）。"""
    rng = np.random.default_rng(seed)
    total = t_gone + settle
    n = ns(total + 0.3)
    t = tvec(n)
    r = np.where(t < t_peak, smoothstep(t / t_peak) ** 0.8, 1.0)
    r = np.where(t > t_gone - 1.5, np.exp(-(t - (t_gone - 1.5)) / 1.1), r)
    r = r * (t < total)
    rate = peak_rate * r + 2.0 * np.exp(-np.maximum(t - t_gone, 0) / (settle * 0.5)) * (t > t_gone) + 1e-6
    ct = poisson_times(rate, rng, total)
    out = np.zeros((2, n))
    for c in range(2):
        sel = rng.random(len(ct)) < 0.5
        x = impulses(n, ct[sel], rng.lognormal(-0.2, 0.8, int(sel.sum())) * rng.choice([-1, 1], int(sel.sum())))
        g = resonate(x, [2600, 3900, 5400], [0.00015, 0.00012, 0.0001], [1, 0.8, 0.6]) + 0.5 * hp(x, 1800, order=1)
        out[c] = g
    hiss = _sd(bp(pink(n, rng), 700, 3800, order=2)) * r ** 0.7
    out = out / (np.std(out) + 1e-9) + 0.6 * widen(hiss, 0.9, seed + 1)
    out = lp(out, 4800, order=2)
    return dict(audio=reverb(out, ir_preset("uw_small"), wet=0.2), pre=0.0, norm="lufs")


# ================================================================ 心跳（她的）
def heart(seed=0, beats_at=(0.0,), amps=None, pitch=0.85, dub=0.6, muffle=180.0):
    """低沉的心跳：lub（下滑正弦 + 低通噪声闷击）+ dub（更高更轻），轻饱和后低通（水下、体内的闷）。
    beats_at 为相对缓冲开头的每一拍时刻；同步点 = 第一拍 lub 起音。"""
    rng = np.random.default_rng(seed)
    beats = [float(b) for b in beats_at]
    b0 = beats[0]
    beats = [b - b0 for b in beats]
    amps = list(amps) if amps is not None else [1.0] * len(beats)
    pre = 0.03
    n = ns(beats[-1] + pre + 1.2)
    y = np.zeros(n)
    for k, (tb, a) in enumerate(zip(beats, amps)):
        per = beats[k + 1] - tb if k + 1 < len(beats) else 1.0
        s2 = float(np.clip(0.28 * per, 0.16, 0.32))
        m = ns(0.42)
        tt = tvec(m)
        lub = sine_sweep(m, (44 + 30 * np.exp(-tt / 0.035)) * pitch) * env_ad(m, 0.006, 0.075)
        lub += 0.35 * lp(rng.standard_normal(m), 160, order=2) * env_ad(m, 0.003, 0.03)
        db = sine_sweep(m, (56 + 36 * np.exp(-tt / 0.025)) * pitch) * env_ad(m, 0.004, 0.05) * dub
        g = a * rng.uniform(0.94, 1.04)
        add_at(y, lub * g, ns(pre + tb))
        add_at(y, db * g, ns(pre + tb + s2))
    pk = np.max(np.abs(y)) + 1e-9
    y = softclip(y / pk * 1.5, 1.8) * pk
    y = lp(hp(y, 24, order=2), muffle, order=2)
    return dict(audio=np.vstack([y, y]) * 0.7071, pre=pre, events=[round(b, 4) for b in beats])


# ================================================================ S5：冲过去 / 存在感 / 游走
def water_rush(seed=0, dur=3.2):
    """她冲过去：起步一记低频推水 + 持续的前冲水流（带通扫频），逐渐减弱。同步点 = 起步（t=0）。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 1.0)
    t = tvec(n)
    push = lp(white(n, rng), 140, order=4) * smoothstep(t / 0.015) * np.exp(-t / 0.28)
    fc = curve([(0, 180), (0.35, 750), (dur, 260), (dur + 1.0, 200)])
    flow = sweep_bp(pink(n, rng), fc, lambda x: 0.7, block=128)
    e = smoothstep(t / 0.02) * (0.35 + 0.65 * np.exp(-t / (0.45 * dur))) * np.clip((dur + 1.0 - t) / 0.8, 0, 1)
    turb = bp(pink(n, rng), 400, 1400, order=2) * e ** 2
    y = 1.1 * _sd(push) * np.exp(-t / 0.5) + _sd(flow) * e + 0.2 * _sd(turb)
    out = widen(y, 0.5, seed)
    out = uw_color(out, cutoff=1600)
    return dict(audio=reverb(out, ir_preset("uw_small"), wet=0.3), pre=0.0)


def presence_push(seed=0, dur=3.2, peak=0.7):
    """老鲟出现：大物体推水的低沉存在感。极低的压力涌 + 低频水体位移 + 慢湍动。同步点 = 起音（t=0，前 30 ms 迅速起来）。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 1.0)
    t = tvec(n)
    e = (1 - np.exp(-t / 0.09)) * np.where(t < peak, 0.6 + 0.4 * smoothstep(t / peak), np.exp(-(t - peak) / (0.45 * dur)))
    e *= np.clip((dur + 1.0 - t) / 0.5, 0, 1)
    press = lp(hp(brown(n, rng), 18, order=2), 55, order=4)
    disp = bp(pink(n, rng), 55, 300, order=2)
    turb = bp(pink(n, rng), 200, 800, order=2) * e
    y = (1.0 * _sd(press) + 0.9 * _sd(disp) + 0.18 * _sd(turb)) * e
    out = widen(y, 0.45, seed)
    out = uw_color(out, cutoff=900, low_db=3.0)
    return dict(audio=reverb(out, ir_preset("uw_big"), wet=0.3), pre=0.0)


def swim_away(seed=0, dur=4.0, side=-1.0):
    """它转身游走：一记尾鳍拍水（低频）+ 远去的漩涡（带通下沉、声像移到一侧）。同步点 = 尾鳍拍水。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.8)
    t = tvec(n)
    stroke = lp(white(n, rng), 120, order=4) * smoothstep(t / 0.03) * np.exp(-t / 0.3)
    fc = curve([(0, 420), (0.4, 520), (dur, 110), (dur + 0.8, 90)])
    swirl = sweep_bp(pink(n, rng), fc, lambda x: 0.9, block=128)
    e = smoothstep(t / 0.08) * np.exp(-t / (0.35 * dur))
    y = 1.0 * _sd(stroke) + 0.8 * _sd(swirl) * e
    out = pan_curve(y, side * 0.7 * smoothstep(t / dur))
    out = uw_color(out, cutoff=1200)
    return dict(audio=reverb(out, ir_preset("uw_big"), wet=0.35), pre=0.0)


# ================================================================ S4：头顶的搜寻船
def small_boat(seed=0, t_arrive=2.5, t_leave=13.9, recede=5.0, f_fire=21.0, blades=3, shaft_hz=11.0, doppler=0.02):
    """隔着水听到的头顶小船：引擎点火谐波（很闷）+ 小螺旋桨的轻空化（叶片脉动）；
    0→t_arrive 渐近，悬停时有缓慢起伏，t_leave 后远去（电平、截止频率、音高一起下沉）。同步点 = 缓冲开头。"""
    rng = np.random.default_rng(seed)
    total = t_leave + recede
    n = ns(total)
    t = tvec(n)
    near = smoothstep(t / t_arrive) * np.where(t > t_leave, np.exp(-(t - t_leave) / (recede * 0.3)), 1.0)
    near *= np.clip((total - t) / 0.8, 0, 1)
    s = -doppler * smoothstep((t - t_leave) / 1.5) + 0.3 * doppler * (1 - smoothstep(t / t_arrive))
    f = f_fire * (1 + s) * (1 + 0.006 * ctrl_noise(n, rng, 0.3))
    ph = TWO_PI * np.cumsum(f) / SR
    eng = sum((1.0 / k) * np.sin(k * ph + rng.uniform(0, TWO_PI)) for k in range(1, 12))
    eng += 0.6 * lp(white(n, rng), 300, order=2) * (0.5 + 0.5 * np.cos(ph)) ** 3
    phb = TWO_PI * np.cumsum(shaft_hz * blades * (1 + s)) / SR
    pulse = (0.5 + 0.5 * np.cos(phb)) ** 4
    cav = bp(white(n, rng), 600, 3500, order=2) * (0.4 + 0.6 * pulse)
    y = (_sd(eng) + 0.35 * _sd(cav)) * (0.85 + 0.15 * ctrl_noise(n, rng, 0.2))
    cut = 220 + 520 * near
    cs = cut[::256]
    y = sweep_lp(y, lambda tt: float(cs[min(int(tt * SR) // 256, len(cs) - 1)]), block=256) * near
    out = pan_curve(y, 0.15 * np.sin(TWO_PI * 0.03 * t) - 0.5 * smoothstep((t - t_leave) / recede))
    out = uw_color(out, cutoff=1200)
    return dict(audio=reverb(out, ir_preset("uw_big"), wet=0.35)[:, :n], pre=0.0)


def cable_creak(seed=0, dur=2.4, n_creaks=4):
    """缆绳在水里：几声闷闷的绳索吱呀（黏滑摩擦激励 → 纤维/缆的共振）+ 摩擦声，隔着水。同步点 = t=0。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.6)
    y = np.zeros(n)
    starts = np.sort(rng.uniform(0.0, dur * 0.8, n_creaks))
    starts[0] = 0.0
    for s0 in starts:
        D = rng.uniform(0.25, 0.7)
        m = ns(D)
        u = np.linspace(0, 1, m)
        rate = rng.uniform(28, 70) * (1 + 0.3 * np.sin(np.pi * u))
        amp = np.sin(np.pi * u) ** 1.5
        r = rate * (1 + 0.2 * ctrl_noise(m, rng, 20.0))
        phs = np.cumsum(r) / SR
        idx = np.nonzero(np.diff(np.floor(phs)) > 0)[0]
        x = np.zeros(m)
        x[idx] = amp[idx] * rng.lognormal(0, 0.3, len(idx))
        cr = resonate(x, rng.uniform(260, 1100, 3), rng.uniform(0.005, 0.012, 3), [1.0, 0.7, 0.4])
        rub = bp(white(m, rng), 300, 1800, order=2) * amp * 0.15
        add_at(y, cr + rub * np.std(cr) / (np.std(rub) + 1e-9) * 0.4, ns(s0))
    out = pan(y, rng.uniform(-0.2, 0.2))
    out = uw_color(out, cutoff=1300)
    return dict(audio=reverb(out, ir_preset("uw_small"), wet=0.35), pre=0.0)


def hydro_plop(seed=0, out=False):
    """水听器入水（从水下听）：轻"噗"的冲击 + Minnaert 气泡 + 一串小气泡；out=True 为被拉出水面的吸水声 + 气泡。
    同步点 = 入水冲击（out 时 = 出水那一下）。"""
    rng = np.random.default_rng(seed)
    n = ns(1.6)
    t = tvec(n)
    y = np.zeros(n)
    t0 = 0.3 if out else 0.0
    if out:
        # 往上拉的吸水声，到出水那一刻 20 ms 内平滑收掉；出水那一下是一记短促的"啵"（破水面），它就是同步点
        suck = bp(pink(n, rng), 250, 1200, order=2) * np.clip(t / (t0 - 0.05), 0, 1) ** 3
        suck *= (0.35 + 0.65 * smoothstep((t0 - t) / 0.05)) * smoothstep((t0 + 0.02 - t) / 0.02)
        y += 0.4 * _nz(suck)
        brk = bp(white(n, rng), 500, 3000, order=2) * smoothstep((t - t0) / 0.001) * np.exp(-np.maximum(t - t0, 0) / 0.012) * (t > t0)
        y += 1.2 * _nz(brk)
    k = impulses(n, [t0], [1.0])
    thup = resonate(lp(k, 900, order=2), [150, 260], [0.02, 0.012], [1.0, 0.6])
    y += _nz(thup)
    m = ns(0.12)
    tt = tvec(m)
    f0 = rng.uniform(380, 460)
    bub = sine_sweep(m, f0 * (1 + 0.25 * tt / tt[-1])) * env_ad(m, 0.002, 0.035)
    add_at(y, 0.7 * bub, ns(t0 + 0.004))
    for tb in t0 + np.sort(rng.exponential(0.12, int(rng.integers(6, 11)))):
        mm = ns(0.05)
        tb2 = tvec(mm)
        fb = rng.uniform(650, 1600)
        add_at(y, (0.12 if out else 0.25) * rng.uniform(0.3, 1.0) * sine_sweep(mm, fb * (1 + 0.3 * tb2 / tb2[-1])) * env_ad(mm, 0.001, 0.012),
               ns(tb))
    o = pan(y, 0.1)
    o = uw_color(o, cutoff=2500, low_db=2.0)
    return dict(audio=reverb(o, ir_preset("uw_small"), wet=0.3), pre=t0)


# ================================================================ S6：卵
def eggs_snow(seed=0, dur=9.5, rise=1.4, hold=3.0, push=1.0):
    """产卵：成千上万颗卵像雪一样散开 —— 柔软、细密：大量极轻的噪声颗粒（1–4.5 kHz、6–25 ms）+ 雪落般的轻"沙"，
    声像随时间越铺越宽；开头她身体一收的轻推水。不要叮当（没有正弦颗粒、没有共振）。同步点 = t=0。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.8)
    t = tvec(n)
    e = smoothstep(t / rise) * np.where(t > rise + hold, np.exp(-(t - rise - hold) / ((dur - rise - hold) * 0.45)), 1.0)
    e *= np.clip((dur - t) / 0.8, 0, 1)
    rate = 520 * e + 1e-6
    times = poisson_times(rate, rng, dur)
    k = len(times)
    spread = 0.25 + 0.7 * smoothstep(times / (dur * 0.6))
    out = grain_bank(n, times, np.exp(rng.uniform(np.log(1000), np.log(4500), k)), rng.uniform(0.006, 0.025, k),
                     rng.lognormal(-1.0, 0.5, k), rng.uniform(-1, 1, k) * spread, "noise", rng, bw=1.2)
    hiss = bp(pink(n, rng), 700, 3500, order=2) * e ** 1.2
    out = out / (np.std(out) + 1e-9) + 0.5 * widen(_sd(hiss), 0.9, seed + 1)
    if push > 0:
        pu = lp(white(n, rng), 160, order=4) * smoothstep(t / 0.06) * np.exp(-t / 0.35)
        out += 1.2 * push * np.vstack([_sd(pu), _sd(pu)]) * np.exp(-t / 0.6)
    out = lp(out, 4500, order=2)
    return dict(audio=reverb(out, ir_preset("uw_small"), wet=0.35), pre=0.0, norm="lufs")


def warm_glow(seed=0, dur=8.0, attack=2.2):
    """卵在电感视觉里亮起：温暖的质感（配乐为主）—— 140–900 Hz 的暖色噪声缓慢开花 + 很淡的空气层，无音高。同步点 = t=0。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.5)
    t = tvec(n)
    e = smoothstep(t / attack) * np.where(t > attack + 1.5, np.exp(-(t - attack - 1.5) / ((dur - attack - 1.5) * 0.5)), 1.0)
    e *= np.clip((dur + 0.5 - t) / 0.5, 0, 1)
    w = np.vstack([bp(pink(n, rng), 140, 900, order=2), bp(pink(n, rng), 140, 900, order=2)])
    w = eq(w, ("peak", 330, 0.7, 2.0))
    w *= np.clip(1 + 0.12 * ctrl_noise(n, rng, 0.3), 0.6, 1.4)
    air = np.vstack([bp(white(n, rng), 2500, 6000, order=2), bp(white(n, rng), 2500, 6000, order=2)])
    out = (w / (np.std(w) + 1e-9) + 0.08 * air / (np.std(air) + 1e-9)) * e
    return dict(audio=reverb(out, ir_preset("uw_big"), wet=0.4), pre=0.0, norm="lufs")


def egg_dim(seed=0):
    """一颗卵暗下去：一声极轻、极短、往下沉的"噗"（400–1500 Hz 噪声，70–110 ms）。同步点 = t=0。"""
    rng = np.random.default_rng(seed)
    D = rng.uniform(0.07, 0.11)
    n = ns(D + 0.4)
    t = tvec(n)
    fc = curve([(0, 1300), (D, 520), (D + 0.4, 450)])
    y = sweep_bp(white(n, rng), fc, lambda x: 1.3, block=64) * smoothstep(t / 0.01) * np.exp(-t / (D * 0.6))
    o = pan(y, rng.uniform(-0.6, 0.6))
    o = uw_color(o, cutoff=1800)
    return dict(audio=reverb(o, ir_preset("uw_small"), wet=0.45), pre=0.0)


# ================================================================ S7：沉到卵石上 / 鳃 / 最后
def sink_settle(seed=0, t_contact=1.4):
    """慢慢沉下去（很轻的低频水体移动）→ t_contact 身体落到卵石上：软的低频闷响 + 卵石被压的细碎咔啦（闷）+ 一小团泥沙。
    同步点 = 缓冲开头（sink 时刻）；events=[t_contact]。"""
    rng = np.random.default_rng(seed)
    n = ns(t_contact + 2.5)
    t = tvec(n)
    # 下沉的水体移动；落底前 0.25 s 稍微收一点（沉得慢下来），让"碰到卵石"那一下有清楚的起点
    desc = bp(pink(n, rng), 60, 300, order=2) * smoothstep(t / (t_contact * 0.6)) * np.exp(-np.maximum(t - t_contact, 0) / 0.4)
    desc *= 0.6 + 0.4 * smoothstep((t_contact - t) / 0.25)
    y = 0.4 * _sd(desc) * 0.3
    m = n - ns(t_contact)
    tt = tvec(m)
    thud = lp(white(m, rng), 110, order=4) * smoothstep(tt / 0.02) * np.exp(-tt / 0.2)
    knock = resonate(lp(impulses(m, [0.0], [1.0]), 1500, order=2), [420.0, 780.0], [0.012, 0.006], [1.0, 0.5])  # 身体压上卵石的闷"笃"
    ptimes = np.sort(np.concatenate([[0.0, 0.004], rng.exponential(0.12, int(rng.integers(22, 36)))]))
    px = impulses(m, ptimes, np.concatenate([[1.0, 0.7], rng.lognormal(-0.3, 0.6, len(ptimes) - 2)]))
    peb = resonate(px, rng.uniform(600, 2300, 4), rng.uniform(0.0003, 0.0008, 4), [1, 0.8, 0.6, 0.5]) + 0.3 * hp(px, 1000, order=1)
    puff = bp(pink(m, rng), 300, 1500, order=2) * smoothstep(tt / 0.05) * np.exp(-tt / 0.6)
    tail = np.zeros(n)
    tail[ns(t_contact):] = 1.0 * _nz(thud) + 0.45 * _nz(knock) + 0.35 * _nz(peb) + 0.12 * _nz(puff)
    y = y * np.max(np.abs(tail)) + tail
    o = widen(y, 0.4, seed)
    o = uw_color(o, cutoff=1800)
    return dict(audio=reverb(o, ir_preset("uw_small"), wet=0.35), pre=0.0, events=[round(t_contact, 4)])


def gill_breaths(seed=0, times=(0.0,), amps=None, lens=None):
    """越来越慢的鳃动：每次 = 水进（柔和的 150–900 Hz 噪声涨落）+ 水出（略亮一点），交替轻微左右。times 相对缓冲开头。"""
    rng = np.random.default_rng(seed)
    times = [float(x) for x in times]
    t0 = times[0]
    times = [x - t0 for x in times]
    amps = list(amps) if amps is not None else [1.0] * len(times)
    lens = list(lens) if lens is not None else [1.4] * len(times)
    n = ns(times[-1] + max(lens) + 0.8)
    out = np.zeros((2, n))
    for k, (tb, a, L) in enumerate(zip(times, amps, lens)):
        m = ns(L)
        u = np.linspace(0, 1, m)
        ein = np.sin(np.pi * np.clip(u / 0.45, 0, 1)) ** 2 * (u < 0.45)
        eout = np.sin(np.pi * np.clip((u - 0.42) / 0.58, 0, 1)) ** 2 * (u > 0.42) * 0.8
        s_in = bp(pink(m, rng), 150, 800, order=2)
        s_out = bp(pink(m, rng), 220, 1100, order=2)
        y = _sd(s_in) * ein + _sd(s_out) * eout
        add_at(out, pan(y * a, 0.12 if k % 2 == 0 else -0.12), ns(tb))
    out = uw_color(out, cutoff=1300)
    return dict(audio=reverb(out, ir_preset("uw_small"), wet=0.3), pre=0.0, events=[round(x, 4) for x in times])


def bottom_touch(seed=0, strength=1.0):
    """贴到河床：软的低频闷响 + 卵石/泥沙被扫起的细碎（闷）+ 一团扬起的沙沙。同步点 = 触底（t=0）。"""
    rng = np.random.default_rng(seed)
    n = ns(2.2)
    t = tvec(n)
    thud = lp(white(n, rng), 110, order=4) * smoothstep(t / 0.015) * np.exp(-t / 0.18)
    ptimes = np.sort(rng.exponential(0.15, int(rng.integers(25, 40))))
    px = impulses(n, ptimes, rng.lognormal(-0.3, 0.6, len(ptimes)))
    peb = resonate(px, rng.uniform(600, 2300, 4), rng.uniform(0.0003, 0.0008, 4), [1, 0.8, 0.6, 0.5]) + 0.3 * hp(px, 1000, order=1)
    puff = bp(pink(n, rng), 300, 1600, order=2) * smoothstep(t / 0.06) * np.exp(-t / 0.7)
    y = 1.0 * _nz(thud) * strength + 0.35 * _nz(peb) + 0.2 * _nz(puff)
    o = widen(y, 0.45, seed)
    o = uw_color(o, cutoff=1800)
    return dict(audio=reverb(o, ir_preset("uw_small"), wet=0.3), pre=0.0)


FUNCS = {
    "bottom_touch": bottom_touch,
    "uw_whoosh": uw_whoosh,
    "electro_sparkle": electro_sparkle,
    "field_crackle": field_crackle,
    "ship_pass": ship_pass,
    "sediment": sediment,
    "heart": heart,
    "water_rush": water_rush,
    "presence_push": presence_push,
    "swim_away": swim_away,
    "small_boat": small_boat,
    "cable_creak": cable_creak,
    "hydro_plop": hydro_plop,
    "eggs_snow": eggs_snow,
    "warm_glow": warm_glow,
    "egg_dim": egg_dim,
    "sink_settle": sink_settle,
    "gill_breaths": gill_breaths,
}
