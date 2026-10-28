"""S3 二〇〇三：网、出水、江边的人、棉被、网箱船、量尺、二十四针、信标与"嘀"、放流、夜里的柴油机、触礁。

画面是写意水墨（记忆），声音按"记忆"的听感：干净、近，空间小；只有她在网里挣扎那几秒是水下的闷声。
每个函数返回 dict(audio, pre, events, norm)。
"""
from __future__ import annotations

import numpy as np

from .dsp import (SR, TWO_PI, add_at, bp, brown, ctrl_noise, curve, dbg, env_ad, eq, hp, impulses, ir_preset, lp,
                  modes, ns, pan, pan_curve, pink, poisson_times, resonate, reverb, sine_sweep, smoothstep, softclip,
                  stereo, sweep_bp, tvec, uw_color, white, widen, width)


def _nz(x):
    return x / (np.max(np.abs(x)) + 1e-12)


def _sd(x):
    return x / (np.std(x) + 1e-12)


def _bubble(rng, f0=None, dur=0.05, rise=0.3):
    m = ns(dur)
    tt = tvec(m)
    f0 = f0 or rng.uniform(500, 1400)
    return sine_sweep(m, f0 * (1 + rise * tt / tt[-1])) * env_ad(m, 0.001, dur * 0.3)


# ================================================================ 网里的挣扎（水下，闷）
def _thrash(rng, a):
    D = rng.uniform(0.3, 0.6)
    m = ns(D + 0.3)
    tt = tvec(m)
    tp = rng.uniform(0.06, 0.12)
    e = np.where(tt < tp, (tt / tp) ** 1.5, np.exp(-(tt - tp) / (D * 0.45)))
    fc = curve([(0, 140), (tp, rng.uniform(420, 680)), (D + 0.3, 150)])
    th = sweep_bp(pink(m, rng), fc, lambda x: 0.8, block=128) * e
    bub = np.zeros(m)
    for tb in tp + np.sort(rng.exponential(0.08, int(rng.integers(8, 20)))):
        add_at(bub, _bubble(rng, rng.uniform(300, 1100), rng.uniform(0.03, 0.08)) * rng.uniform(0.2, 1.0), ns(tb))
    return (_sd(th) + 0.25 * _sd(bub)) * a, tp


def net_struggle(seed=0, dur=5.0, impact_at=None, close_at=None, thrash_at=()):
    """她撞进网里挣扎（水下听感）：impact_at 一头撞进网（闷撞 + 网绳一下绷紧）、close_at 网收拢（绳吱呀）、
    thrash_at 每一下甩尾（低频水涌 + 大团气泡，越来越激烈）+ 网绳闷吱呀与纤维拉紧的"滋"。
    时间相对缓冲开头；没给 thrash_at 就随机。同步点 = t=0（撞网）；混音里在 sky 处硬切。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.5)
    t = tvec(n)
    inten = 0.35 + 0.65 * smoothstep(t / dur)
    out = np.zeros((2, n))
    if thrash_at:
        for k, tc in enumerate(thrash_at):
            y, tp = _thrash(rng, inten[min(n - 1, ns(max(tc, 0)))] * rng.uniform(0.7, 1.0))
            add_at(out, pan(y, rng.uniform(-0.6, 0.6)), ns(max(0.0, tc - tp)))
    if impact_at is not None:
        m = ns(0.8)
        tt = tvec(m)
        hit = lp(white(m, rng), 180, order=4) * smoothstep(tt / 0.01) * np.exp(-tt / 0.16)
        twang = resonate(impulses(m, [0.02], [1.0]), [rng.uniform(180, 260), rng.uniform(420, 560)], [0.05, 0.03], [1, 0.5])
        add_at(out, stereo(1.4 * _sd(hit) + 0.5 * _sd(twang)) * 0.7, ns(impact_at))
    tc = 0.05 if not thrash_at else dur + 1.0
    while tc < dur:
        D = rng.uniform(0.3, 0.65)
        m = ns(D + 0.3)
        tt = tvec(m)
        tp = rng.uniform(0.08, 0.18)
        e = np.where(tt < tp, (tt / tp) ** 1.5, np.exp(-(tt - tp) / (D * 0.45)))
        fc = curve([(0, 120), (tp, rng.uniform(380, 650)), (D + 0.3, 150)])
        th = sweep_bp(pink(m, rng), fc, lambda x: 0.8, block=128) * e
        bub = np.zeros(m)
        for tb in tp + np.sort(rng.exponential(0.08, int(rng.integers(8, 20)))):
            add_at(bub, _bubble(rng, rng.uniform(300, 1100), rng.uniform(0.03, 0.08)) * rng.uniform(0.2, 1.0), ns(tb))
        y = _sd(th) + 0.25 * _sd(bub) * np.std(th) / (np.std(th) + 1e-9)
        a = inten[min(n - 1, ns(tc))] * rng.uniform(0.6, 1.0)
        add_at(out, pan(y * a, rng.uniform(-0.6, 0.6)), ns(tc))
        tc += rng.uniform(0.25, 0.7) / (0.6 + 0.8 * inten[min(n - 1, ns(tc))])
    # 网绳绷紧：黏滑吱呀（闷）+ 纤维拉紧的滋滋（网收拢那一刻一定有一声）
    cr = np.zeros(n)
    starts = list(np.sort(rng.uniform(0.3, dur, int(3 + 3 * dur / 2))))
    if close_at is not None:
        starts.append(float(close_at))
    for s0 in starts:
        D = rng.uniform(0.2, 0.5)
        m = ns(D)
        u = np.linspace(0, 1, m)
        r = rng.uniform(40, 110) * (1 + 0.25 * ctrl_noise(m, rng, 25.0))
        ph = np.cumsum(r) / SR
        idx = np.nonzero(np.diff(np.floor(ph)) > 0)[0]
        x = np.zeros(m)
        x[idx] = np.sin(np.pi * u[idx]) * rng.lognormal(0, 0.3, len(idx))
        add_at(cr, resonate(x, rng.uniform(320, 1300, 3), rng.uniform(0.004, 0.01, 3), [1, 0.7, 0.4]), ns(s0))
    zz = bp(white(n, rng), 500, 1600, order=2) * np.clip(ctrl_noise(n, rng, 3.0), 0, None) * inten
    turb = bp(pink(n, rng), 80, 600, order=2) * inten
    out += 0.5 * widen(_sd(cr), 0.7, seed) * np.std(out) + 0.15 * np.vstack([_sd(zz), _sd(zz)]) * np.std(out)
    out += 0.6 * widen(_sd(turb), 0.8, seed + 1) * np.std(out)
    out = uw_color(out, cutoff=1000, low_db=3.0)
    out *= smoothstep(t / 0.005)
    return dict(audio=reverb(out, ir_preset("uw_small"), wet=0.3), pre=0.0)


def breach(seed=0):
    """sky：被拖出水 —— 闷声瞬间变成开阔的空气：水从身上和网上泻下（宽带水瀑，快起、0.35 s 衰减）+ 水花 + 之后稀疏的滴水
    + 重量离开水面的一记低频。同步点 = 出水（t=0）。"""
    rng = np.random.default_rng(seed)
    n = ns(3.2)
    t = tvec(n)
    pour = bp(white(n, rng), 300, 9000, order=2) * smoothstep(t / 0.008) * np.exp(-t / 0.33)
    pour = eq(pour, ("peak", 1800, 0.7, 3.0))
    sp_t = np.sort(rng.exponential(0.12, 90))
    spx = impulses(n, sp_t, rng.lognormal(-0.5, 0.7, len(sp_t)))
    splash = resonate(spx, rng.uniform(1200, 6000, 4), [0.0008, 0.0006, 0.0005, 0.0004], [1, 0.8, 0.6, 0.5])
    drips = np.zeros(n)
    for td in 0.25 + np.sort(rng.exponential(0.7, 22)):
        if td < 3.0:
            add_at(drips, _bubble(rng, rng.uniform(1300, 3200), 0.035, 0.5) * rng.uniform(0.2, 0.7) * np.exp(-td / 1.2), ns(td))
    low = lp(white(n, rng), 140, order=4) * smoothstep(t / 0.01) * np.exp(-t / 0.18)
    y = 1.0 * _sd(pour) + 0.5 * _sd(splash) * np.exp(-t / 0.5) + 0.9 * _sd(low) + 0.12 * _nz(drips) * 6
    out = widen(y, 0.7, seed)
    return dict(audio=reverb(out, ir_preset("river_bank"), wet=0.22), pre=0.0)


# ================================================================ 江边的人
def mud_steps(seed=0, dur=7.0, rate=5.0, weight=1.0, fade=0.8):
    """八个人抬着她在泥滩上挪步：许多只脚踩进泥里（低频闷 + 湿的"噗叽" + 偶尔拔脚的吸声），声像散开，力度随机。同步点 = t=0。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 1.0)
    t = tvec(n)
    r = rate * smoothstep(t / fade) * smoothstep((dur - t) / fade) + 1e-6
    times = poisson_times(r, rng, dur, min_gap=0.04)
    out = np.zeros((2, n))
    ev = []
    for ts in times:
        m = ns(0.45)
        tt = tvec(m)
        w = weight * rng.uniform(0.6, 1.1)
        k = impulses(m, [0.0], [1.0])
        thud = resonate(lp(k, 500, order=2), [rng.uniform(60, 85), rng.uniform(110, 150)], [0.03, 0.02], [1.0, 0.5])
        sq = bp(white(m, rng), 250, 1800, order=2) * smoothstep(tt / 0.01) * np.exp(-tt / 0.07)
        slap = bp(white(m, rng), 1000, 4000, order=2) * np.exp(-tt / 0.012)
        y = 1.0 * _nz(thud) + 0.55 * _nz(sq) + 0.2 * _nz(slap)
        if rng.random() < 0.45:
            ts2 = rng.uniform(0.12, 0.25)
            mm = ns(0.08)
            suck = sweep_bp(white(mm, rng), curve([(0, 450), (0.08, 1300)]), lambda x: 2.0, block=64) * np.hanning(mm)
            add_at(y, 0.35 * _nz(suck), ns(ts2))
        add_at(out, pan(y * w, rng.uniform(-0.85, 0.85)), ns(ts))
        ev.append(round(float(ts), 4))
    return dict(audio=reverb(out, ir_preset("river_bank"), wet=0.12), pre=0.0, events=ev)


def cloth_strain(seed=0, dur=5.0, heaves=None):
    """抬的用力感：布与身体的摩擦（一次次"起"的动作包络 × 粗布摩擦噪声 × 纤维颗粒）+ 布料绷紧的细吱。同步点 = t=0。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.6)
    t = tvec(n)
    motion = np.zeros(n)
    k = heaves or max(2, int(dur / 1.0))
    for c in np.sort(rng.uniform(0.2, dur - 0.2, k)):
        w = rng.uniform(0.35, 0.8)
        motion += rng.uniform(0.6, 1.0) * np.exp(-0.5 * ((t - c) / (w / 2.5)) ** 2)
    motion = np.clip(motion, 0, 1.2)
    fr = bp(white(n, rng), 400, 4500, order=2)
    g = np.abs(lp(white(n, rng), 260, order=2))
    g = 0.4 + 0.6 * g / (np.mean(g) + 1e-9) / 1.8
    y = _sd(fr) * motion ** 1.3 * g
    ss = poisson_times(160 * motion + 1e-6, rng, dur)
    sx = impulses(n, ss, rng.lognormal(-0.5, 0.4, len(ss)))
    y += 0.3 * _sd(resonate(sx, [900, 1600, 2500], [0.0012, 0.0009, 0.0007], [1, 0.7, 0.5])) * motion
    out = widen(y, 0.6, seed)
    return dict(audio=reverb(out, ir_preset("river_bank"), wet=0.1), pre=0.0, norm="lufs")


def quilt_rustle(seed=0, dur=5.0, folds=None):
    """棉被：厚、软的棉布沙沙（高频少）+ 密集的细小摩擦 + 大动作时棉被的"呼"。同步点 = t=0。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.6)
    t = tvec(n)
    motion = np.zeros(n)
    k = folds or max(3, int(dur / 0.8))
    for c in np.sort(rng.uniform(0.1, dur - 0.2, k)):
        w = rng.uniform(0.3, 0.9)
        motion += rng.uniform(0.5, 1.0) * np.exp(-0.5 * ((t - c) / (w / 2.5)) ** 2)
    motion = np.clip(motion, 0, 1.2) * smoothstep(t / 0.1)
    soft = bp(white(n, rng), 280, 3200, order=2)
    soft = lp(soft, 2800, order=2)
    ct = poisson_times(420 * motion + 1e-6, rng, dur)
    cx = impulses(n, ct, rng.lognormal(-0.3, 0.5, len(ct)) * rng.choice([-1, 1], len(ct)))
    micro = resonate(cx, rng.uniform(900, 3200, 4), rng.uniform(0.0002, 0.0005, 4), [1, 0.8, 0.6, 0.5])
    fw = lp(white(n, rng), 380, order=2) * motion ** 2
    y = _sd(soft) * motion ** 1.2 + 0.35 * _sd(micro) * motion + 0.5 * _sd(fw)
    out = widen(y, 0.5, seed)
    return dict(audio=reverb(out, ir_preset("paper_room"), wet=0.08), pre=0.0, norm="lufs")


def boat_creaks(seed=0, dur=16.0, rate=0.35, knocks=0.6):
    """网箱船：木船的吱呀（黏滑摩擦 → 木板共振）+ 水轻拍船身的空腔"咚" + 偶尔网箱铁架一声轻响。同步点 = t=0。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.8)
    t = tvec(n)
    y = np.zeros((2, n))
    for s0 in poisson_times(np.full(n, rate), rng, dur):
        D = rng.uniform(0.4, 1.1)
        m = ns(D)
        u = np.linspace(0, 1, m)
        r = rng.uniform(30, 75) * (1 + 0.3 * np.sin(np.pi * u)) * (1 + 0.15 * ctrl_noise(m, rng, 20.0))
        ph = np.cumsum(r) / SR
        idx = np.nonzero(np.diff(np.floor(ph)) > 0)[0]
        x = np.zeros(m)
        x[idx] = np.sin(np.pi * u[idx]) ** 1.5 * rng.lognormal(0, 0.3, len(idx))
        cr = resonate(x, [rng.uniform(180, 450), rng.uniform(600, 1300)], [rng.uniform(0.01, 0.025), 0.008], [1.0, 0.5])
        add_at(y, pan(lp(cr, 3000, order=2) * rng.uniform(0.4, 1.0), rng.uniform(-0.6, 0.6)), ns(s0))
    kk = np.zeros((2, n))
    for s0 in poisson_times(np.full(n, knocks), rng, dur):
        m = ns(0.4)
        k = impulses(m, [0.0], [1.0])
        kn = resonate(lp(k, 800, order=2), rng.uniform(110, 240, 2), [0.04, 0.03], [1, 0.6])
        sp = bp(white(m, rng), 500, 2500, order=2) * np.exp(-tvec(m) / 0.05)
        add_at(kk, pan(_nz(kn) + 0.2 * _nz(sp), rng.uniform(-0.5, 0.5)) * rng.uniform(0.3, 0.8), ns(s0))
    out = y / (np.max(np.abs(y)) + 1e-9) + 0.8 * kk / (np.max(np.abs(kk)) + 1e-9)
    out *= smoothstep(t / 0.5) * smoothstep((dur - t) / 1.0)
    return dict(audio=reverb(out, ir_preset("boat_deck"), wet=0.15), pre=0.0, norm="lufs")


def tape_measure(seed=0, dur=1.6):
    """量体长：钢卷尺被拉出来（棘轮般的细密咔哒随拉速变化 + 钢带滑动摩擦 + 一点金属轻鸣），最后锁住一下。同步点 = t=0。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.4)
    t = tvec(n)
    sp = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 0.7 * (t < dur)
    ct = poisson_times(55 * sp + 1e-6, rng, dur)
    ct = np.concatenate([[0.0], ct[ct > 0.03]])  # 第一下：卷尺锁扣松开、开始拉出的"咔"（同步点）
    cx = impulses(n, ct, np.concatenate([[1.2], rng.lognormal(-0.3, 0.3, len(ct) - 1)]))
    clicks = resonate(hp(cx, 1500, order=1), [3100, 4700, 6600], [0.0006, 0.0005, 0.0004], [1, 0.8, 0.5])
    ring = resonate(cx, [5200.0], [0.003], [0.15])
    slide = bp(white(n, rng), 1500, 7000, order=2) * sp
    lock = resonate(impulses(n, [dur], [1.0]), [2200, 3500], [0.002, 0.0015], [1, 0.6])
    y = _nz(clicks) + 0.2 * _nz(ring) + 0.25 * _sd(slide) * np.std(clicks) * 3 + 0.5 * _nz(lock)
    return dict(audio=reverb(pan(y, -0.15), ir_preset("boat_deck"), wet=0.08), pre=0.0)


def stitch(seed=0, interval=0.14, depth=1.0):
    """一针：针尖刺穿的细小"嗒"（高频极短共振 + 很小的"噗"）→ 18 ms 后拉线（线穿过皮肉的细摩擦，长度随针距）→ 线绷紧的一下轻"嗒"。
    同步点 = 穿刺（t=0）。"""
    rng = np.random.default_rng(seed)
    pull = float(np.clip(0.55 * interval, 0.04, 0.22))
    n = ns(0.03 + pull + 0.3)
    t = tvec(n)
    k = impulses(n, [0.0], [1.0])
    pk = resonate(hp(k, 1500, order=1), [rng.uniform(2600, 4200), rng.uniform(5200, 7000)], [0.0005, 0.0003], [1.0, 0.6])
    pop = resonate(lp(k, 1200, order=2), [rng.uniform(380, 520)], [0.004], [1.0])
    s0 = 0.018
    pe = smoothstep((t - s0) / 0.008) * smoothstep((s0 + pull - t) / (0.35 * pull)) * (t > s0) * (t < s0 + pull)
    th = bp(white(n, rng), 2000, 7500, order=2) * pe * (0.8 + 0.2 * np.clip(ctrl_noise(n, rng, 60.0), -1, 1))
    tug = resonate(impulses(n, [s0 + pull], [1.0]), [rng.uniform(3000, 4500)], [0.0004], [1.0])
    th = lp(th, 6500, order=2)
    y = _nz(pk) * depth + 0.3 * _nz(pop) * depth + 0.13 * _sd(th) * np.max(np.abs(pk)) / 6 + 0.18 * _nz(tug)
    return dict(audio=reverb(pan(y, rng.uniform(-0.12, 0.12)), ir_preset("boat_deck"), wet=0.05), pre=0.0)


def tag_click(seed=0):
    """信标装上背：先一下接触的小咔，35 ms 后主"咔哒"（塑料 + 金属卡扣 + 一点低频"笃"），再三下很轻的棘轮。同步点 = 主咔哒。"""
    rng = np.random.default_rng(seed)
    n = ns(0.8)
    t0 = 0.035
    a = resonate(hp(impulses(n, [0.0], [0.5]), 1200, order=1), [2400, 3900, 5200], [0.0015, 0.0012, 0.001], [1, 0.7, 0.5])
    k = impulses(n, [t0], [1.0])
    # 卡扣的共振避开 1760 Hz（紧接着就是信标的嘀，那个频率只留给嘀）
    b = resonate(hp(k, 900, order=1), [2250, 2900, 4300, 6100], [0.004, 0.003, 0.0025, 0.0015], [1, 0.8, 0.6, 0.35])
    tok = resonate(lp(k, 900, order=2), [300.0], [0.008], [1.0])
    rat = np.zeros(n)
    for j in range(3):
        rat += resonate(impulses(n, [t0 + 0.06 + 0.016 * j], [0.2]), [4100, 5600], [0.0008, 0.0006], [1, 0.6])
    y = 0.4 * _nz(a) + _nz(b) + 0.35 * _nz(tok) + 0.25 * _nz(rat)
    return dict(audio=reverb(pan(y, 0.1), ir_preset("boat_deck"), wet=0.08), pre=t0)


def beacon_ping(seed=0, mode="air", f=1760.0, dur=0.06, att=0.008, rel=0.015):
    """信标的"嘀"：1760 Hz 干净正弦短音，约 60 ms，柔和起音（8 ms 升余弦）、15 ms 收尾。
    mode='air'  船上（几乎干）
    mode='uw'   放流后在水下：一点水下滤波 + 几个多径早反射 + 微混响
    mode='far'  S4 回忆：极远、极弱（重水下 + 长暗尾）
    同步点 = 起音（t=0）。"""
    L = ns(dur)
    t = tvec(L)
    env = smoothstep(t / att) * smoothstep((dur - t) / rel)
    tone = np.sin(TWO_PI * f * t) * env
    n = ns(dur + (1.6 if mode == "far" else 0.7))
    y = np.zeros(n)
    y[:L] = tone
    if mode == "air":
        out = reverb(pan(y, 0.08), ir_preset("boat_deck"), wet=0.04)
    elif mode == "uw":
        y = lp(y, 4000, order=2)
        for d, g in ((0.011, -10.0), (0.023, -14.0), (0.041, -19.0)):
            y[ns(d):] += dbg(g) * y[: n - ns(d)] * (1.0 if d < 0.03 else 0.8)
        out = reverb(pan(y, 0.0), ir_preset("uw_small"), wet=0.22)
    else:
        y = lp(y, 3000, order=2)
        for d, g in ((0.017, -8.0), (0.036, -12.0), (0.07, -16.0)):
            y[ns(d):] += dbg(g) * y[: n - ns(d)]
        out = reverb(pan(y, -0.1), ir_preset("uw_big"), wet=0.7, dry=0.45)
    return dict(audio=out, pre=0.0, norm="none")


def release_splash(seed=0):
    """放流：她从船边滑进江里 —— 滑下的水声 → 一记沉重的入水（低频"扑通" + 水花 + 细密溅落）→ 水下翻涌（闷）→ 一道游开的漩涡。
    同步点 = 入水（pre = 0.35 s 的滑落）。"""
    rng = np.random.default_rng(seed)
    pre = 0.35
    n = ns(pre + 3.2)
    t = tvec(n)
    ts = t - pre
    slide = sweep_bp(pink(n, rng), curve([(0, 300), (pre, 900), (pre + 0.2, 600)]), lambda x: 0.9, block=128)
    # 滑落在入水前 80 ms 最响，入水瞬间已退到一半，80 ms 内平滑收掉（不再硬门限）
    slide *= smoothstep(t / (pre - 0.08)) ** 2 * (0.5 + 0.5 * smoothstep((pre - t) / 0.08)) * smoothstep((pre + 0.08 - t) / 0.08)
    plunge = lp(white(n, rng), 160, order=4) * smoothstep(ts / 0.006) * np.exp(-np.maximum(ts, 0) / 0.22) * (ts > 0)
    spl = bp(white(n, rng), 250, 8000, order=2) * smoothstep(ts / 0.005) * np.exp(-np.maximum(ts, 0) / 0.4) * (ts > 0)
    # 身体拍上水面的那一下"啪"：1 ms 起音的宽带拍击，入水的清楚起点
    slap = bp(white(n, rng), 400, 6000, order=2) * smoothstep(ts / 0.0015) * np.exp(-np.maximum(ts, 0) / 0.025) * (ts > 0)
    dr_t = pre + np.sort(rng.exponential(0.3, 140))
    drx = impulses(n, dr_t, rng.lognormal(-0.8, 0.6, len(dr_t)) * np.exp(-(dr_t - pre) / 0.6))
    drops = resonate(drx, rng.uniform(1500, 6500, 4), [0.0006, 0.0005, 0.0004, 0.0003], [1, 0.8, 0.6, 0.5])
    gurg = np.zeros(n)
    for tb in pre + 0.1 + np.sort(rng.exponential(0.35, 30)):
        if tb < n / SR - 0.1:
            add_at(gurg, _bubble(rng, rng.uniform(200, 700), rng.uniform(0.04, 0.1)) * rng.uniform(0.2, 1.0), ns(tb))
    gurg = lp(gurg, 1200, order=2)
    swirl = sweep_bp(pink(n, rng), curve([(0, 200), (pre + 1.2, 200), (pre + 1.8, 600), (pre + 3.0, 180)]), lambda x: 0.9, block=128)
    swirl *= smoothstep((ts - 1.0) / 0.6) * np.exp(-np.maximum(ts - 1.6, 0) / 0.6) * (ts > 1.0)
    y = (0.35 * _sd(slide) + 1.2 * _sd(plunge) + 0.9 * _sd(spl) + 1.1 * _sd(slap)
         + 0.35 * _sd(drops) * np.exp(-np.maximum(ts, 0) / 0.8) + 0.6 * _nz(gurg) + 0.35 * _sd(swirl))
    out = widen(y, 0.6, seed)
    return dict(audio=reverb(out, ir_preset("river_bank"), wet=0.2), pre=pre)


# ================================================================ 夜：跟踪船
def _diesel_cycle(rng, fire_hz, amp=1.0):
    m = ns(min(0.25, 2.5 / fire_hz))
    tt = tvec(m)
    k = impulses(m, [0.0], [1.0])
    exc = lp(k + 0.3 * np.concatenate([rng.standard_normal(ns(0.004)), np.zeros(m - ns(0.004))]), 1500, order=2)
    pop = resonate(exc, [rng.uniform(88, 102), rng.uniform(180, 200), rng.uniform(310, 350)], [0.03, 0.02, 0.012],
                   [1.0, 0.7, 0.4])
    clat = bp(white(m, rng), 1200, 4500, order=2) * np.exp(-tt / 0.006)
    return (_nz(pop) + 0.12 * _nz(clat)) * amp


def diesel_boat(seed=0, dur=9.0, fire_hz=11.0, fade_in=1.2):
    """夜里跟踪船的单缸柴油机"突突突"（在船上听，近）：每次点火 = 排气低频"突"（88–350 Hz 共振）+ 机械的细碎咔嗒；
    周期抖动 ±2%、力度 ±12%；外加排气/螺旋桨搅水的持续底子与船体的低频振动（宽带，不是纯音）。同步点 = t=0。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.4)
    t = tvec(n)
    y = np.zeros(n)
    tc = 0.0
    ev = []
    while tc < dur:
        add_at(y, _diesel_cycle(rng, fire_hz, rng.uniform(0.88, 1.12)), ns(tc))
        ev.append(tc)
        tc += (1.0 / fire_hz) * (1 + 0.02 * rng.standard_normal())
    exh = lp(white(n, rng), 600, order=2) * (0.6 + 0.4 * np.clip(ctrl_noise(n, rng, 3.0), -1, 1))
    churn = bp(pink(n, rng), 200, 1200, order=2) * np.clip(1 + 0.25 * ctrl_noise(n, rng, 0.5), 0.4, 1.6)
    vib = lp(hp(brown(n, rng), 40, order=2), 95, order=4)
    z = _nz(y) + 0.12 * _sd(exh) * np.std(_nz(y)) * 3 + 0.18 * _sd(churn) * np.std(_nz(y)) * 3 + 0.3 * _sd(vib) * np.std(_nz(y)) * 3
    z *= smoothstep(t / max(fade_in, 0.01)) * smoothstep((n / SR - t) / 0.3)
    # 引擎在说话人身后：给人声让出 1–4 kHz（宽的 -4 dB 凹陷），机械咔嗒的最高频也收一点（7 kHz 以上）
    z = lp(eq(z, ("peak", 2000.0, 0.6, -4.0)), 7000, order=2)
    out = widen(z, 0.35, seed)
    out = reverb(out, ir_preset("boat_deck"), wet=0.08)
    out = reverb(out, ir_preset("night_river"), wet=0.1)
    return dict(audio=out, pre=0.0, events=[round(x, 4) for x in ev[:4]], norm="lufs")


def receiver_hiss(seed=0, dur=8.0, fade_in=1.0):
    """接收机的细微电子声：耳机里漏出来的极轻嘶声（1.5–6.5 kHz、慢起伏）+ 偶发极轻的静噪咔。同步点 = t=0。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.3)
    t = tvec(n)
    h = bp(white(n, rng), 1500, 6500, order=2) * np.clip(1 + 0.2 * ctrl_noise(n, rng, 0.4), 0.5, 1.5)
    y = _sd(h)
    ct = poisson_times(np.full(n, 0.35), rng, dur)
    if len(ct):
        ck = resonate(impulses(n, ct, rng.uniform(0.4, 1.0, len(ct))), [2800, 4300], [0.0008, 0.0006], [1, 0.6])
        y = y + 0.5 * _nz(ck) * np.max(np.abs(y))
    y = y * smoothstep(t / fade_in) * smoothstep((dur - t) / 0.5)
    return dict(audio=pan(y, 0.25), pre=0.0, norm="lufs")


def crash(seed=0, fire_hz=11.0):
    """触礁（t=0）：木船壳撞上石头（巨大的低频 + 木板模态 + 裂响）→ 60 ms 后螺旋桨打在石头上（金属铛 + 0.12–1.1 s 的研磨）
    → 船身摇晃的大水涌与后续几次拍水 → 引擎挣扎、失火、1.9 s 熄火（最后一声"哐"和机械余颤）→ 船体的吱呀。
    嘀声在这一刻断掉（由 cue 表的 cut_at 负责）。同步点 = 撞击（t=0）。"""
    rng = np.random.default_rng(seed)
    n = ns(6.0)
    t = tvec(n)
    k = impulses(n, [0.0], [1.0])
    boom = sine_sweep(n, 32 + 30 * np.exp(-t / 0.07)) * env_ad(n, 0.003, 0.26)
    boom += 0.7 * _nz(lp(white(n, rng), 160, order=4) * env_ad(n, 0.002, 0.1))
    wood = resonate(lp(k, 2500, order=2), [95, 140, 210, 330, 480, 720], [0.12, 0.09, 0.07, 0.05, 0.04, 0.03],
                    [1.0, 0.9, 0.8, 0.6, 0.45, 0.3])
    sp_t = np.sort(rng.exponential(0.07, 35))
    spl = resonate(impulses(n, sp_t, rng.lognormal(-0.3, 0.6, len(sp_t))), rng.uniform(1000, 5000, 4),
                   rng.uniform(0.0005, 0.002, 4), [1, 0.8, 0.6, 0.5])
    t_m = 0.06
    km = impulses(n, [t_m], [1.0])
    # 金属"铛"的分音避开 1760 Hz 附近（±250 Hz）：嘀声断掉之后不能有一个音高像嘀的余音
    clang = resonate(hp(km, 300, order=1), [612, 1180, 2130, 2560, 3380], [0.35, 0.25, 0.16, 0.12, 0.08],
                     [1.0, 0.8, 0.55, 0.45, 0.3])
    ge = smoothstep((t - 0.12) / 0.03) * smoothstep((1.1 - t) / 0.35) * (t > 0.12) * (t < 1.1)
    jag = np.clip(np.sign(np.sin(TWO_PI * np.cumsum(35 + 25 * ctrl_noise(n, rng, 8.0)) / SR)) * 0.5 + 0.5
                  + 0.3 * ctrl_noise(n, rng, 40.0), 0, 1.5)
    grind = bp(white(n, rng), 500, 4500, order=2) * ge * jag
    sq_t = poisson_times(np.full(n, 90.0) * ge, rng, 1.2)
    squeal = resonate(impulses(n, sq_t, np.ones(len(sq_t))), [1380, 2750], [0.004, 0.003], [1, 0.6]) * ge
    # 水：大水涌 + 后续拍水
    wat = np.zeros(n)
    for tw, a in ((0.05, 1.0), (0.9, 0.55), (1.6, 0.4), (2.5, 0.28), (3.4, 0.2)):
        m = ns(1.2)
        tt = tvec(m)
        sl = sweep_bp(pink(m, rng), curve([(0, 250), (0.12, 1300), (1.2, 400)]), lambda x: 0.9, block=128)
        sl *= np.where(tt < 0.1, (tt / 0.1) ** 1.5, np.exp(-(tt - 0.1) / 0.35))
        add_at(wat, a * _sd(sl), ns(tw))
    # 引擎：挣扎 → 失火 → 熄火
    eng = np.zeros(n)
    tc = 0.15
    f = fire_hz
    while tc < 1.9:
        u = (tc - 0.15) / 1.75
        f = fire_hz * (1.25 - 0.55 * u) if u > 0.3 else fire_hz * (1 + 0.8 * u)
        if rng.random() > 0.25 + 0.5 * u:
            add_at(eng, _diesel_cycle(rng, f, rng.uniform(0.5, 1.1) * (1 - 0.5 * u)), ns(tc))
        tc += 1.0 / max(f, 3.0)
    last = resonate(lp(impulses(n, [1.95], [1.0]), 1200, order=2), [70, 140, 260], [0.08, 0.05, 0.03], [1, 0.6, 0.4])
    rattle = resonate(impulses(n, 1.97 + np.sort(rng.exponential(0.12, 10)), rng.uniform(0.1, 0.4, 10)),
                      [900, 1500, 2300], [0.01, 0.008, 0.006], [1, 0.7, 0.5])
    # 船体吱呀
    creak = np.zeros(n)
    for s0 in (2.3, 3.2, 4.3):
        D = rng.uniform(0.4, 0.9)
        m = ns(D)
        u = np.linspace(0, 1, m)
        ph = np.cumsum(rng.uniform(35, 60) * (1 + 0.3 * np.sin(np.pi * u))) / SR
        idx = np.nonzero(np.diff(np.floor(ph)) > 0)[0]
        x = np.zeros(m)
        x[idx] = np.sin(np.pi * u[idx]) ** 1.5
        add_at(creak, resonate(x, [rng.uniform(200, 380), rng.uniform(700, 1100)], [0.02, 0.01], [1, 0.5]), ns(s0))
    y = (1.3 * _nz(boom) + 0.9 * _nz(wood) + 0.35 * _nz(spl) + 0.65 * _nz(clang) + 0.35 * _sd(grind) * 0.25
         + 0.2 * _nz(squeal) + 0.55 * _nz(wat) + 0.45 * _nz(eng) + 0.3 * _nz(last) + 0.12 * _nz(rattle)
         + 0.15 * _nz(creak))
    y = softclip(y / (np.max(np.abs(y)) + 1e-9) * 1.2, 1.3)
    out = widen(y, 0.5, seed)
    out[:, -ns(0.6):] *= np.linspace(1, 0, ns(0.6))
    return dict(audio=reverb(out, ir_preset("night_river"), wet=0.25), pre=0.0)


def snip(seed=0):
    """缝完打结剪线：线被拉紧打结的轻"吱" + 小剪刀"咔嚓"（两片刃的短金属咔）。同步点 = 剪断（t=0，打结在它之前 0.12 s）。"""
    rng = np.random.default_rng(seed)
    pre = 0.12
    n = ns(pre + 0.5)
    t = tvec(n)
    kn = bp(white(n, rng), 2500, 7000, order=2) * smoothstep(t / 0.035) * smoothstep((pre - 0.02 - t) / 0.03) * (t < pre)
    k = impulses(n, [pre, pre + 0.006], [1.0, 0.6])
    blade = resonate(hp(k, 1500, order=1), [3400, 5100, 7300], [0.004, 0.003, 0.002], [1.0, 0.7, 0.4])
    y = 0.12 * _sd(kn) * np.max(np.abs(blade)) / 4 + _nz(blade)
    return dict(audio=reverb(pan(y, 0.1), ir_preset("boat_deck"), wet=0.06), pre=pre)


def quilt_throw(seed=0):
    """棉被甩上来盖住她：一阵柔软的棉被带起的风（低、软）→ 落下的"噗"（厚棉布的低中频闷拍）+ 一点布面沙沙。同步点 = 盖上（t=0，前 0.3 s 是甩过来的风）。"""
    rng = np.random.default_rng(seed)
    pre = 0.3
    n = ns(pre + 1.2)
    t = tvec(n)
    air = sweep_bp(pink(n, rng), curve([(0, 250), (pre * 0.85, 700), (pre + 0.3, 300)]), lambda x: 0.8, block=128)
    # 风在落下前 45 ms 最大、随后让位给落下的"噗"（落下那一下才是同步点）
    air *= smoothstep(t / (pre * 0.85)) ** 2 * np.exp(-np.maximum(t - pre * 0.85, 0) / 0.05)
    land = lp(white(n, rng), 420, order=2) * smoothstep((t - pre) / 0.012) * np.exp(-np.maximum(t - pre, 0) / 0.09) * (t > pre)
    # 厚棉被拍在身上的闷"噗"：确定的低中频冲击（2 ms 起音），给落下一个清楚的起点
    fl = resonate(lp(impulses(n, [pre], [1.0]), 600, order=2), [135.0, 240.0, 410.0], [0.022, 0.012, 0.006], [1.0, 0.55, 0.3])
    rus = bp(white(n, rng), 600, 3200, order=2) * smoothstep((t - pre) / 0.02) * np.exp(-np.maximum(t - pre, 0) / 0.3) * (t > pre)
    y = 0.4 * _sd(air) + 1.0 * _sd(land) + 0.9 * _nz(fl) * 3.0 + 0.25 * _sd(rus)
    return dict(audio=reverb(widen(y, 0.4, seed), ir_preset("river_bank"), wet=0.1), pre=pre)


def swirl_turn(seed=0, dur=1.8):
    """放流后她在下游折返：江面上一道水被带转的"哗"（俯视，远一点、轻）。同步点 = 转身（t=0 起势，0.5 s 最强）。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.5)
    t = tvec(n)
    e = smoothstep(t / 0.5) * np.exp(-np.maximum(t - 0.5, 0) / (0.35 * dur))
    y = sweep_bp(pink(n, rng), curve([(0, 300), (0.5, 900), (dur, 400)]), lambda x: 0.9, block=128) * e
    y += 0.2 * _sd(bp(white(n, rng), 1500, 5000, order=2)) * np.std(y) * e ** 2
    return dict(audio=reverb(pan_curve(y, np.linspace(0.3, -0.3, n)), ir_preset("river_bank"), wet=0.25), pre=0.0)


FUNCS = {
    "snip": snip,
    "quilt_throw": quilt_throw,
    "swirl_turn": swirl_turn,
    "net_struggle": net_struggle,
    "breach": breach,
    "mud_steps": mud_steps,
    "cloth_strain": cloth_strain,
    "quilt_rustle": quilt_rustle,
    "boat_creaks": boat_creaks,
    "tape_measure": tape_measure,
    "stitch": stitch,
    "tag_click": tag_click,
    "beacon_ping": beacon_ping,
    "release_splash": release_splash,
    "diesel_boat": diesel_boat,
    "receiver_hiss": receiver_hiss,
    "crash": crash,
}
