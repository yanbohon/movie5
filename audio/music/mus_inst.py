"""《鲔》配乐的其它声部（古琴在 mus_guqin.py）。所有函数返回立体声 float64 数组 (2, n)。

弦乐、合唱、pad 的骨架复制自 movie4《重构》的 mus_inst.py，改成更暗、更慢、更克制；
频率一律走 mus_theme.hz（三分损益律，跟古琴同一张律表）。新增：远处的无词哼唱、空气 pad、
电感视觉的玻璃泛音粒子、sub 与心跳脉动。
"""
import math
import numpy as np
from scipy import signal
from mus_dsp import (SR, TWO_PI, db, rng, blep_saw, svf, lp, hp, bp, sos_filter, peaking, chorus,
                     fade_edges, swell_env, pan_gains)
from mus_theme import hz, nm


def _f(m):
    return hz(nm(m)) if isinstance(m, str) else hz(m)


def _fit(env, n):
    return env[:n] if env.size >= n else np.pad(env, (0, n - env.size), mode='edge')


# =============================================================== 低音弦乐（大提琴 / 低音提琴）
_SECTION = {
    # voices, 失谐音分, (颤音 Hz, 颤音音分), 琴体共振 [(Hz, dB, Q)], 亮度 (低, 高) Hz, 弓噪
    'vc': dict(voices=5, det=4.0, vib=(4.6, 5.5), body=[(190, 2.5, 1.0), (520, 1.5, 1.3), (2100, -4.0, 1.0)],
               bright=(520, 1900), noise=0.035),
    'cb': dict(voices=4, det=3.0, vib=(4.2, 3.5), body=[(100, 2.5, 1.0), (330, 1.0, 1.2), (1400, -4.0, 1.0)],
               bright=(300, 1150), noise=0.03),
    # 独奏大提琴：两根「弓」、更深的颤音、更明显的共振峰
    'vcsolo': dict(voices=2, det=2.5, vib=(5.0, 9.0), body=[(210, 3.0, 1.2), (480, 2.5, 1.5), (1050, 1.5, 1.8),
                                                            (2500, -4.0, 1.0)],
                   bright=(650, 2400), noise=0.05),
}


def strings(m, dur, vel=0.5, att=1.5, rel=2.0, sec='vc', seed=0, expr=None, spread=0.6, vib_amt=1.0,
            glide_from=None, glide_t=0.35, trem=0.0):
    P = _SECTION[sec]
    r = rng(seed)
    n = int((dur + rel) * SR)
    t = np.arange(n) / SR
    f = _f(m)
    L = np.zeros(n)
    R = np.zeros(n)
    env = swell_env(n, att, rel, 1.6)
    if expr is not None:
        env = env * _fit(expr, n)
    V = P['voices']
    for v in range(V):
        dc = P['det'] * (2 * v / max(V - 1, 1) - 1) + r.uniform(-1.0, 1.0)
        vr = P['vib'][0] * r.uniform(0.93, 1.07)
        vd = P['vib'][1] * r.uniform(0.75, 1.2) * vib_amt
        vin = np.clip((t - r.uniform(0.3, 0.8)) / 1.0, 0, 1)
        cents = dc + vd * vin * np.sin(TWO_PI * vr * t + r.uniform(0, TWO_PI))
        cents += 2.0 * np.sin(TWO_PI * r.uniform(0.08, 0.25) * t + r.uniform(0, 6))
        if glide_from is not None:
            gf = _f(glide_from)
            cents = cents + 1200 * math.log2(gf / f) * np.clip(1 - t / glide_t, 0, 1) ** 2
        fr = f * 2 ** (cents / 1200.0)
        s = blep_saw(fr, r.uniform(0, 1))
        off = int(r.uniform(0, 0.05) * SR)
        if off:
            s = np.concatenate([np.zeros(off), s[:-off]])
        if trem > 0:
            s *= 0.65 + 0.35 * np.sin(TWO_PI * trem * r.uniform(0.9, 1.1) * t + r.uniform(0, 6))
        p = spread * (2 * v / max(V - 1, 1) - 1) if V > 1 else 0.0
        gl, gr = pan_gains(float(np.clip(p, -1, 1)))
        L += s * gl
        R += s * gr
    y = np.vstack([L, R]) / math.sqrt(V)
    lo, hi = P['bright']
    fc = lo + (hi - lo) * np.clip(vel * (0.3 + 0.7 * env), 0, 1)
    y = np.vstack([svf(y[0], fc, 0.6, 0), svf(y[1], fc, 0.6, 0)])
    fc2 = fc * 1.3
    y = np.vstack([svf(y[0], fc2, 0.55, 0), svf(y[1], fc2, 0.55, 0)])
    for (f0, g, q) in P['body']:
        y = peaking(y, f0, g, q)
    nz = np.vstack([r.standard_normal(n), r.standard_normal(n)])
    nz = lp(bp(nz, min(3.0 * f, 3500), 0.8), 4000.0) * P['noise'] * (0.4 + vel)
    y = (y + nz) * env * vel
    y = hp(y, 38 if sec != 'cb' else 26)
    return fade_edges(y, 0.01, 0.08)


def strings_chord(midis, dur, vel=0.5, att=2.0, rel=2.5, seed=0, **kw):
    """按音高自动分配：低于 G2 给低音提琴，其余给大提琴。"""
    out = None
    for j, m in enumerate(midis):
        mm = nm(m) if isinstance(m, str) else m
        sec = 'cb' if mm < 43 else 'vc'
        y = strings(mm, dur, vel, att, rel, sec, seed + 31 * j + mm, **kw)
        out = y if out is None else _addpad(out, y)
    return out / math.sqrt(max(1, len(midis))) * 1.25


def _addpad(a, b):
    if a.shape[1] < b.shape[1]:
        a, b = b, a
    a = a.copy()
    a[:, :b.shape[1]] += b
    return a


# =============================================================== 远处的无词哼唱（共振峰）
_VOWELS = {
    # 闭口哼 [m]：第一共振峰很低、很强，1 kHz 以上几乎只剩鼻腔的微弱共振
    'mm': [(260, 1.0, 70), (1100, 0.07, 160), (2350, 0.015, 220)],
    'oo': [(310, 1.0, 55), (820, 0.30, 80), (2250, 0.04, 120)],
    'ah': [(720, 1.0, 85), (1100, 0.45, 95), (2450, 0.10, 130)],
}


def hum(midis, dur, vel=0.4, att=2.5, rel=3.0, vowel='mm', open_mix=0.0, seed=0, voices=5, breath=0.035,
        expr=None, glide=None):
    """很柔、很远的无词哼唱：锯齿源（颤音 + 抖动）-> 共振峰（mm 与 oo 之间可渐变）-> 低通。
    open_mix 可为数组（0 = 闭口哼，1 = 半张口的 oo）。glide=[(t_rel, midi), ...] 可让整组音连续滑到新音。"""
    r = rng(seed)
    n = int((dur + rel) * SR)
    t = np.arange(n) / SR
    L = np.zeros(n)
    R = np.zeros(n)
    for j, m in enumerate(midis):
        f = _f(m)
        glide_c = np.zeros(n)
        if glide:
            # 每个新音在其时刻前 0.12 s 开始、0.22 s 内滑到（人声连唱的滑音）
            cur = 0.0
            for (tg, mg) in glide:
                c_new = 1200 * math.log2(_f(mg) / f)
                u = np.clip((t - (tg - 0.12)) / 0.34, 0, 1)
                u = u * u * (3 - 2 * u)
                glide_c += (c_new - cur) * u
                cur = c_new
        for v in range(voices):
            dc = r.uniform(-7, 7)
            vib = 11 * np.sin(TWO_PI * r.uniform(4.4, 5.4) * t + r.uniform(0, 6)) * np.clip((t - 0.6) / 1.5, 0, 1)
            jit = 4 * np.sin(TWO_PI * r.uniform(0.15, 0.5) * t + r.uniform(0, 6))
            fr = f * 2 ** ((dc + vib + jit + glide_c) / 1200.0)
            s = blep_saw(fr, r.uniform(0, 1))
            off = int(r.uniform(0, 0.12) * SR)
            if off:
                s = np.concatenate([np.zeros(off), s[:-off]])
            gl, gr = pan_gains(0.8 * (2 * r.uniform() - 1))
            L += s * gl
            R += s * gr
    src = np.vstack([L, R]) / math.sqrt(len(midis) * voices)
    src = src + np.vstack([r.standard_normal(n), r.standard_normal(n)]) * breath
    om = open_mix if np.isscalar(open_mix) else _fit(np.asarray(open_mix, dtype=np.float64), n)
    out = np.zeros_like(src)
    for key, wgt in ((vowel, 1 - om), ('oo', om)):
        acc = np.zeros_like(src)
        for (fc, g, bw) in _VOWELS[key]:
            acc += bp(src, fc, fc / bw) * g
        out += acc * wgt
    out = sos_filter(out, 'highpass', 85, 2)
    out = sos_filter(out, 'lowpass', 2600, 2)
    env = swell_env(n, att, rel, 1.5)
    if expr is not None:
        env = env * _fit(expr, n)
    out *= env * vel * 2.6
    out = chorus(out, rate=0.17, depth_ms=5.0, base_ms=19.0, mix=0.4, seed=seed + 3)
    return fade_edges(out, 0.02, 0.15)


# =============================================================== 空气 pad（加法 + 气声）
def air_pad(midis, dur, vel=0.3, att=2.0, rel=3.0, bright=1.0, seed=0, expr=None, partials=6, breath=0.25,
            shimmer=0.35):
    """柔和的加法 pad：每个音 6 个分音，各自极慢的随机起伏（像远处的弦/玻璃琴），再加一层以音高为中心的气声。"""
    r = rng(seed)
    n = int((dur + rel) * SR)
    t = np.arange(n) / SR
    out = np.zeros((2, n))
    for j, m in enumerate(midis):
        f = _f(m)
        for k in range(1, partials + 1):
            fk = f * k
            if fk > 12000:
                break
            # 三个副本，各自 ±0.3–1.0 音分的随机失谐（符号也随机）：拍频互不成整数比、而且很慢，
            # 听起来是不规则的起伏，不是固定周期的「哇哇」拍。功率与原来的两副本相同。
            a = k ** -1.4 / (1 + (fk / (2200.0 * bright)) ** 2) * math.sqrt(2.0 / 3.0)
            signs = (-1.0, 1.0, 1.0 if r.uniform() < 0.5 else -1.0)
            for c in signs:
                det = c * r.uniform(0.3, 1.0)
                lfo = 1 + shimmer * np.sin(TWO_PI * r.uniform(0.04, 0.25) * t + r.uniform(0, 6))
                ph = r.uniform(0, TWO_PI)
                s = np.sin(TWO_PI * fk * 2 ** (det / 1200.0) * t + ph) * lfo * a
                gl, gr = pan_gains(float(np.clip(0.7 * (2 * r.uniform() - 1), -1, 1)))
                out[0] += s * gl
                out[1] += s * gr
        if breath > 0:
            nz = np.vstack([r.standard_normal(n), r.standard_normal(n)])
            out += bp(nz, min(2 * f, 9000), 5.0) * breath * 0.08
    env = swell_env(n, att, rel, 1.5)
    if expr is not None:
        env = env * _fit(expr, n)
    out *= env * vel / math.sqrt(len(midis)) * 0.55
    return fade_edges(out, 0.02, 0.15)


def warm_pad(midis, dur, vel=0.3, att=3.0, rel=4.0, cutoff=900.0, seed=0, expr=None):
    """温暖的远 pad（失谐锯齿 + 两级低通 + 合唱），夜城灯光用。"""
    r = rng(seed)
    n = int((dur + rel) * SR)
    t = np.arange(n) / SR
    L = np.zeros(n)
    R = np.zeros(n)
    for j, m in enumerate(midis):
        f = _f(m)
        for v in range(4):
            dc = [-8, -3, 3, 8][v] + r.uniform(-1, 1)
            fr = f * 2 ** ((dc + 3 * np.sin(TWO_PI * r.uniform(0.04, 0.1) * t + r.uniform(0, 6))) / 1200.0)
            s = blep_saw(fr, r.uniform(0, 1))
            gl, gr = pan_gains([-0.8, -0.3, 0.3, 0.8][v])
            L += s * gl
            R += s * gr
    fcv = cutoff * (1 + 0.2 * np.sin(TWO_PI * 0.045 * t + r.uniform(0, 6)))
    y = np.vstack([svf(svf(L, fcv, 0.6, 0), fcv, 0.6, 0), svf(svf(R, fcv, 0.6, 0), fcv, 0.6, 0)])
    y /= math.sqrt(len(midis) * 4)
    env = swell_env(n, att, rel, 1.6)
    if expr is not None:
        env = env * _fit(expr, n)
    y *= env
    y = chorus(y, rate=0.15, depth_ms=4.0, base_ms=16.0, mix=0.45, seed=seed + 9)
    return fade_edges(y * vel, 0.02, 0.15)


# =============================================================== 电感视觉：玻璃泛音粒子
# 自由-自由梁的模态频率比（玻璃条/水晶的非谐分音），每个粒子都不一样：没有重复的 ping
_BAR = np.array([1.0, 2.756, 5.404, 8.933])
_BAR_A = np.array([1.0, 0.30, 0.10, 0.035])


def glass_grain(f, dur=0.6, vel=0.3, att=0.002, seed=0, warm=0.0, pan=None):
    """一粒玻璃泛音：4 个非谐分音，高分音衰减更快；warm>0 时去掉高分音、起音更软（卵的琥珀光）。"""
    r = rng(seed)
    n = int(min(dur * 5.0, 4.0) * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for k, (ratio, a) in enumerate(zip(_BAR, _BAR_A)):
        fk = f * ratio * (1 + r.uniform(-0.004, 0.004))
        if fk > 17000:
            continue
        a2 = a * (1 - warm) ** (k * 1.5) if k else a
        tau = dur / (1 + 1.6 * k)
        y += a2 * np.sin(TWO_PI * fk * t + r.uniform(0, 6)) * np.exp(-t / tau)
    a_s = att * (1 + 3 * warm)
    y *= np.clip(t / a_s, 0, 1) ** 2
    p = r.uniform(-0.85, 0.85) if pan is None else pan
    gl, gr = pan_gains(p)
    return fade_edges(np.vstack([y * gl, y * gr]) * vel, 0.0005, 0.02)


def sparkle_times(t0, t1, rate, seed, min_gap=0.03):
    """非齐次泊松过程：rate(t) 为每秒粒子数（函数）。返回时间列表（绝对秒）。"""
    r = rng(seed)
    out = []
    t = t0
    rmax = max(rate(x) for x in np.linspace(t0, t1, 400)) + 1e-6
    while True:
        t += r.exponential(1.0 / rmax)
        if t >= t1:
            break
        if r.uniform() < rate(t) / rmax:
            if not out or t - out[-1] >= min_gap:
                out.append(t)
    return out


# =============================================================== sub 与脉动
def sub_tone(m, dur, vel=0.3, att=3.0, rel=3.0, h2=0.12, breath=None, bend=None, beat_hz=0.0):
    """极低的正弦长音。breath=(周期秒, 深度 0..1) 为「呼吸」起伏；bend 为音分曲线（长度 n）；
    beat_hz>0 时叠一个略偏的正弦产生缓慢拍动。"""
    f = _f(m) if not isinstance(m, float) else m
    n = int((dur + rel) * SR)
    t = np.arange(n) / SR
    cents = np.zeros(n) if bend is None else _fit(np.asarray(bend, dtype=np.float64), n)
    ph = TWO_PI * np.cumsum(f * 2 ** (cents / 1200.0)) / SR
    y = np.sin(ph) + h2 * np.sin(2 * ph + 0.4)
    if beat_hz > 0:
        y += 0.6 * np.sin(ph + TWO_PI * beat_hz * t)
        y /= 1.6
    env = swell_env(n, att, rel, 1.4)
    if breath is not None:
        per, depth = breath
        env *= (1 - depth) + depth * (0.5 - 0.5 * np.cos(TWO_PI * t / per))
    y *= env * vel
    return fade_edges(np.vstack([y, y]), 0.02, 0.1)


def heart(vel=0.5, f=55.0, dub=True, gap=0.26, seed=0):
    """心跳般的低频脉动（音乐性的，不是拟音）：lub（重）+ dub（轻），正弦加快速下滑的音高。"""
    n = int((gap + 0.6) * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for (t0, a, ff) in ((0.0, 1.0, f), (gap, 0.55, f * 0.92)) if dub else ((0.0, 1.0, f),):
        tt = t - t0
        m = tt >= 0
        ph = TWO_PI * ff * (tt[m] + 0.05 * (1 - np.exp(-tt[m] / 0.03)))
        y[m] += a * np.sin(ph) * np.exp(-tt[m] / 0.13) * (1 - np.exp(-tt[m] / 0.006))
    y = np.tanh(1.3 * y) / np.tanh(1.3)
    return fade_edges(np.vstack([y, y]) * vel, 0.001, 0.05)
