"""共享 DSP 工具：噪声、滤波、包络、模态共振、FM、混响 IR、动态、立体声、响度。

全部只用 numpy / scipy。所有声音都在这里的积木上合成，不读任何采样。
约定：采样率 48 kHz；单声道数组形状 (n,)，立体声 (2, n)；float64。
"""
from __future__ import annotations

import hashlib

import numpy as np
from scipy import ndimage, signal

SR = 48000
TWO_PI = 2.0 * np.pi


# ---------------------------------------------------------------- 基础
def seed_of(*keys) -> int:
    h = hashlib.sha1("|".join(map(str, keys)).encode("utf-8")).digest()
    return int.from_bytes(h[:8], "little")


def rng_of(*keys) -> np.random.Generator:
    return np.random.default_rng(seed_of(*keys))


def ns(dur: float) -> int:
    """秒 -> 采样数（至少 1）。"""
    return max(1, int(round(dur * SR)))


def tvec(n: int) -> np.ndarray:
    return np.arange(n) / SR


def dbg(x_db):
    """dB -> 线性增益。"""
    return 10.0 ** (np.asarray(x_db) / 20.0)


def to_db(x, floor=1e-12):
    return 20.0 * np.log10(np.maximum(np.abs(x), floor))


def note(name: str) -> float:
    """音名 -> 频率，例如 'D5'、'F#4'、'Bb3'（A4 = 440）。"""
    names = {"C": -9, "D": -7, "E": -5, "F": -4, "G": -2, "A": 0, "B": 2}
    s = name.strip()
    semi = names[s[0].upper()]
    i = 1
    while i < len(s) and s[i] in "#b":
        semi += 1 if s[i] == "#" else -1
        i += 1
    octave = int(s[i:])
    return 440.0 * 2.0 ** ((semi + (octave - 4) * 12) / 12.0)


# 全片主调 D 小调 / D 大调；D E G A（不含三度）对两者都协和，调音类音效默认用它
SAFE_PCS = ["D", "E", "G", "A"]


def safe_freqs(lo=500.0, hi=5000.0, pcs=SAFE_PCS):
    out = []
    for octv in range(1, 10):
        for pc in pcs:
            f = note(f"{pc}{octv}")
            if lo <= f <= hi:
                out.append(f)
    return np.array(sorted(out))


def stereo(x: np.ndarray) -> np.ndarray:
    return x if x.ndim == 2 else np.vstack([x, x])


def mono(x: np.ndarray) -> np.ndarray:
    return x if x.ndim == 1 else x.mean(axis=0)


def pad_to(x: np.ndarray, n: int) -> np.ndarray:
    if x.shape[-1] >= n:
        return x[..., :n]
    pad = [(0, 0)] * (x.ndim - 1) + [(0, n - x.shape[-1])]
    return np.pad(x, pad)


def add_at(buf: np.ndarray, x: np.ndarray, i0: int):
    """把 x 叠加到 buf 的第 i0 个采样处（自动裁切越界部分）。支持单声道/立体声。"""
    n = buf.shape[-1]
    m = x.shape[-1]
    a, b = i0, i0 + m
    xa, xb = 0, m
    if a < 0:
        xa, a = -a, 0
    if b > n:
        xb -= b - n
        b = n
    if b <= a:
        return
    if buf.ndim == 2 and x.ndim == 1:
        buf[:, a:b] += x[xa:xb]
    else:
        buf[..., a:b] += x[..., xa:xb]


# ---------------------------------------------------------------- 噪声
def white(n, rng):
    return rng.standard_normal(n)


def colored(n, rng, alpha=1.0, fmin=10.0, fmax=None):
    """功率谱 ∝ 1/f^alpha 的噪声（FFT 整形），单位标准差。"""
    # 就地运算、用完即删：整条 90 s 的床只留必要的两份（原来一次要吃 6 倍输出大小的内存）；随机数与结果和原版一致
    X = np.fft.rfft(rng.standard_normal(n))
    g = np.fft.rfftfreq(n, 1.0 / SR)
    keep = (g <= fmax) if fmax else None
    np.maximum(g, fmin, out=g)
    np.power(g, -alpha / 2.0, out=g)
    if keep is not None:
        g *= keep
        del keep
    X *= g
    del g
    X[0] = 0.0  # 去直流
    y = np.fft.irfft(X, n)
    del X
    y /= (np.std(y) + 1e-12)
    return y


def pink(n, rng):
    return colored(n, rng, 1.0, fmin=10.0)


def brown(n, rng):
    return colored(n, rng, 2.0, fmin=18.0)


def ctrl_noise(n, rng, fc=1.0, ctrl_sr=400.0, order=2):
    """缓慢变化的随机控制信号（单位标准差），在低控制率上生成再插值，避免极低截止频率的数值问题。"""
    m = int(n / SR * ctrl_sr) + 8
    fc = min(fc, ctrl_sr * 0.45)
    raw = rng.standard_normal(m + 64)
    sos = signal.butter(order, fc, fs=ctrl_sr, output="sos")
    y = signal.sosfiltfilt(sos, raw)[32 : 32 + m]
    y = (y - y.mean()) / (y.std() + 1e-12)
    xp = np.arange(m) / ctrl_sr
    return np.interp(tvec(n), xp, y)


# ---------------------------------------------------------------- 滤波
def sos_b(kind, fc, order=2):
    if kind in ("bandpass", "bandstop"):
        lo, hi = fc
        hi = min(hi, SR * 0.49)
        return signal.butter(order, [lo, hi], btype=kind, fs=SR, output="sos")
    fc = min(fc, SR * 0.49)
    return signal.butter(order, fc, btype=kind, fs=SR, output="sos")


def _apply(sos, x, zp=False):
    if zp:
        return signal.sosfiltfilt(sos, x, axis=-1)
    return signal.sosfilt(sos, x, axis=-1)


def hp(x, fc, order=2, zp=False):
    return _apply(sos_b("highpass", fc, order), x, zp)


def lp(x, fc, order=2, zp=False):
    return _apply(sos_b("lowpass", fc, order), x, zp)


def bp(x, lo, hi, order=2, zp=False):
    return _apply(sos_b("bandpass", (lo, hi), order), x, zp)


def biquad(kind, f0, q=0.7071, gain_db=0.0):
    """RBJ cookbook 双二阶，返回 (1, 6) 的 sos。kind: peak/lowshelf/highshelf/bandpass/notch/lowpass/highpass/allpass。"""
    f0 = min(max(f0, 1.0), SR * 0.49)
    A = 10.0 ** (gain_db / 40.0)
    w0 = TWO_PI * f0 / SR
    cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / (2.0 * q)
    sqA = np.sqrt(A)
    if kind == "peak":
        b = [1 + alpha * A, -2 * cw, 1 - alpha * A]
        a = [1 + alpha / A, -2 * cw, 1 - alpha / A]
    elif kind == "lowshelf":
        b = [A * ((A + 1) - (A - 1) * cw + 2 * sqA * alpha), 2 * A * ((A - 1) - (A + 1) * cw),
             A * ((A + 1) - (A - 1) * cw - 2 * sqA * alpha)]
        a = [(A + 1) + (A - 1) * cw + 2 * sqA * alpha, -2 * ((A - 1) + (A + 1) * cw),
             (A + 1) + (A - 1) * cw - 2 * sqA * alpha]
    elif kind == "highshelf":
        b = [A * ((A + 1) + (A - 1) * cw + 2 * sqA * alpha), -2 * A * ((A - 1) + (A + 1) * cw),
             A * ((A + 1) + (A - 1) * cw - 2 * sqA * alpha)]
        a = [(A + 1) - (A - 1) * cw + 2 * sqA * alpha, 2 * ((A - 1) - (A + 1) * cw),
             (A + 1) - (A - 1) * cw - 2 * sqA * alpha]
    elif kind == "bandpass":
        b = [alpha, 0.0, -alpha]
        a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "notch":
        b = [1.0, -2 * cw, 1.0]
        a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "lowpass":
        b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]
        a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "highpass":
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
        a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "allpass":
        b = [1 - alpha, -2 * cw, 1 + alpha]
        a = [1 + alpha, -2 * cw, 1 - alpha]
    else:
        raise ValueError(kind)
    b = np.array(b) / a[0]
    a = np.array(a) / a[0]
    return np.concatenate([b, a])[None, :]


def eq(x, *bands, zp=False):
    """bands: (kind, f0, q, gain_db) 元组序列，串联。"""
    if not bands:
        return x
    sos = np.vstack([biquad(*b) for b in bands])
    return _apply(sos, x, zp)


def tv_filter(x, coef_fn, block=64):
    """时变滤波：按块更新系数并延续状态。coef_fn(t_sec) -> (k, 6) 的 sos。"""
    n = x.shape[-1]
    y = np.empty_like(x)
    zi = None
    for s in range(0, n, block):
        e = min(n, s + block)
        sos = coef_fn((s + e) * 0.5 / SR)
        if zi is None or zi.shape[0] != sos.shape[0]:
            zi = np.zeros((sos.shape[0], 2))
        y[s:e], zi = signal.sosfilt(sos, x[s:e], zi=zi)
    return y


def sweep_bp(x, f_curve, q_curve, block=64):
    """中心频率随时间变化的带通（f_curve/q_curve 为 (t)->值 的函数）。"""
    return tv_filter(x, lambda t: biquad("bandpass", float(f_curve(t)), float(q_curve(t))), block)


def sweep_lp(x, f_curve, q=0.7071, block=64):
    return tv_filter(x, lambda t: biquad("lowpass", float(f_curve(t)), q), block)


def curve(points, kind="exp"):
    """由 [(t, v), ...] 生成插值函数；kind='exp' 在对数域插值（适合频率）。"""
    ts = np.array([p[0] for p in points], dtype=float)
    vs = np.array([p[1] for p in points], dtype=float)
    if kind == "exp":
        lv = np.log(vs)
        return lambda t: float(np.exp(np.interp(t, ts, lv)))
    return lambda t: float(np.interp(t, ts, vs))


def dc_block(x, fc=12.0):
    return hp(x, fc, order=1)


# ---------------------------------------------------------------- 包络
def fade(x, fi=0.003, fo=0.003):
    """两端升余弦淡入淡出（秒），原地返回副本。"""
    y = np.array(x, dtype=float, copy=True)
    n = y.shape[-1]
    a = min(n // 2, int(fi * SR))
    b = min(n // 2, int(fo * SR))
    if a > 0:
        w = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, a))
        y[..., :a] *= w
    if b > 0:
        w = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, b))
        y[..., n - b:] *= w
    return y


def env_pts(n, pts, kind="lin"):
    """分段包络：pts = [(t, v), ...]，kind='lin' 线性，'cos' 余弦平滑段。"""
    t = tvec(n)
    ts = np.array([p[0] for p in pts], dtype=float)
    vs = np.array([p[1] for p in pts], dtype=float)
    if kind == "lin":
        return np.interp(t, ts, vs)
    out = np.empty(n)
    idx = np.clip(np.searchsorted(ts, t, side="right") - 1, 0, len(ts) - 2)
    t0, t1 = ts[idx], ts[idx + 1]
    v0, v1 = vs[idx], vs[idx + 1]
    u = np.clip((t - t0) / np.maximum(t1 - t0, 1e-9), 0, 1)
    u = 0.5 - 0.5 * np.cos(np.pi * u)
    out[:] = v0 + (v1 - v0) * u
    return out


def env_ad(n, attack=0.002, tau=0.1, shape=1.0):
    """快速起音 + 指数衰减。attack 为线性/余弦起音时长，tau 为衰减时间常数。"""
    t = tvec(n)
    e = np.exp(-np.maximum(t - attack, 0) / tau)
    if attack > 0:
        a = np.clip(t / attack, 0, 1)
        e *= (0.5 - 0.5 * np.cos(np.pi * a)) ** shape
    return e


def bell_env(n, peak=0.5, width=0.25, skew=1.0):
    """钟形包络（对数正态样），peak/width 为相对位置 0..1。"""
    u = np.linspace(0, 1, n)
    e = np.exp(-0.5 * ((u - peak) / width) ** 2)
    if skew != 1.0:
        e = e ** np.where(u < peak, 1.0, skew)
    return e


# ---------------------------------------------------------------- 振荡与共振
def modes(n, freqs, taus, amps, phases=None, attack=0.0002, t_off=0.0):
    """模态合成：Σ a·exp(-t/τ)·sin(2πft+φ)。"""
    t = tvec(n) - t_off
    y = np.zeros(n)
    ph = phases if phases is not None else np.zeros(len(freqs))
    m = t >= 0
    tt = t[m]
    for f, tau, a, p in zip(freqs, taus, amps, ph):
        if f >= SR * 0.48 or a == 0:
            continue
        y[m] += a * np.exp(-tt / tau) * np.sin(TWO_PI * f * tt + p)
    if attack > 0:
        y *= np.clip((t) / attack, 0, 1)
    return _end_fade(y)


def _end_fade(y, sec=0.2):
    """缓冲末尾的余弦淡出，避免长衰减被截断时出现爆音。"""
    m = min(len(y) // 4, int(sec * SR))
    if m > 1:
        y[-m:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, m))
    return y


def reson_sos(f, tau, norm="impulse"):
    """二极点共振器；norm='impulse' 冲激响应幅度≈1，'peak' 峰值增益=1。"""
    r = np.exp(-1.0 / (tau * SR))
    th = TWO_PI * min(f, SR * 0.49) / SR
    a1, a2 = -2 * r * np.cos(th), r * r
    if norm == "peak":
        g = (1 - r) * np.abs(1 - r * np.exp(-2j * th))
    else:
        g = np.sin(th)
    return np.array([[g, 0.0, 0.0, 1.0, a1, a2]])


def resonate(x, freqs, taus, amps, norm="impulse"):
    """用激励信号驱动一组共振器（并联求和）。"""
    y = np.zeros_like(x, dtype=float)
    for f, tau, a in zip(freqs, taus, amps):
        if f >= SR * 0.48 or a == 0:
            continue
        y += a * signal.sosfilt(reson_sos(f, tau, norm), x)
    return y


def sine_sweep(n, f_of_t, phase0=0.0):
    """频率随时间变化的正弦（f_of_t 为长度 n 的数组，Hz）。"""
    ph = phase0 + TWO_PI * np.cumsum(f_of_t) / SR
    return np.sin(ph)


def fm_tone(n, fc, ratio=2.0, index=1.0, index_tau=0.2, amp_tau=0.5, attack=0.002,
            fc_curve=None, detune=0.0, phase=0.0):
    """两算子 FM：载波 fc，调制 fc·ratio，调制指数随 index_tau 衰减（钟、木琴、玻璃类音色）。"""
    t = tvec(n)
    fcar = np.full(n, fc) if fc_curve is None else fc_curve
    fmod = fcar * ratio + detune
    idx = index * np.exp(-t / index_tau) if index_tau else np.full(n, index)
    mod = np.sin(TWO_PI * np.cumsum(fmod) / SR)
    car = np.sin(TWO_PI * np.cumsum(fcar) / SR + idx * mod + phase)
    return _end_fade(car * env_ad(n, attack, amp_tau))


def bell(n, f, tau=1.0, bright=1.0, rng=None, attack=0.001):
    """加法合成钟/玻璃：非谐分音（类钟），高分音衰减更快。"""
    ratios = np.array([1.0, 2.0, 2.76, 3.0, 4.07, 5.4, 6.8])
    amps = np.array([1.0, 0.45, 0.35, 0.18, 0.22, 0.1, 0.06]) * np.array([1, 1, bright, 1, bright, bright ** 2, bright ** 2])
    taus = tau / (1 + 0.6 * (ratios - 1))
    ph = rng.uniform(0, TWO_PI, len(ratios)) if rng is not None else np.zeros(len(ratios))
    return modes(n, f * ratios, taus, amps, ph, attack=attack)


def glass_ping(n, f, tau=0.4, rng=None, attack=0.0015):
    """纯净玻璃/水晶类：基音 + 2.0、3.0 倍谐波 + 微弱非谐分音。"""
    ratios = np.array([1.0, 2.0, 3.0, 4.16, 5.43])
    amps = np.array([1.0, 0.25, 0.08, 0.05, 0.02])
    taus = tau / np.array([1.0, 1.6, 2.4, 3.2, 4.0])
    ph = rng.uniform(0, TWO_PI, len(ratios)) if rng is not None else np.zeros(len(ratios))
    return modes(n, f * ratios, taus, amps, ph, attack=attack)


# ---------------------------------------------------------------- 非线性
def softclip(x, drive=1.0, bias=0.0):
    """tanh 饱和，bias 引入偶次谐波（之后建议 dc_block）。drive=1 时基本透明。"""
    y = np.tanh(drive * (x + bias)) - np.tanh(drive * bias)
    return y / np.tanh(drive)


def bitcrush(x, bits=6, hold=4):
    """采样保持 + 量化。"""
    y = np.repeat(x[::hold], hold)[: len(x)]
    q = 2.0 ** (bits - 1)
    return np.round(y * q) / q


# ---------------------------------------------------------------- 立体声
def pan(x, p=0.0):
    """单声道 -> 立体声，等功率声像，p ∈ [-1, 1]。"""
    p = float(np.clip(p, -1, 1))
    th = (p + 1) * np.pi / 4
    return np.vstack([x * np.cos(th), x * np.sin(th)])


def pan_curve(x, p_arr):
    th = (np.clip(p_arr, -1, 1) + 1) * np.pi / 4
    return np.vstack([x * np.cos(th), x * np.sin(th)])


def balance(x_st, p=0.0):
    p = float(np.clip(p, -1, 1))
    gl = min(1.0, 1.0 - p)
    gr = min(1.0, 1.0 + p)
    return np.vstack([x_st[0] * gl, x_st[1] * gr])


def width(x_st, w=1.0):
    """M/S 宽度：w=0 单声道，1 原样，>1 加宽。"""
    m = (x_st[0] + x_st[1]) * 0.5
    s = (x_st[0] - x_st[1]) * 0.5 * w
    return np.vstack([m + s, m - s])


def haas(x, ms=8.0, side=1):
    """用微小延时做宽度（仅用于非关键声部）。"""
    d = int(ms * SR / 1000)
    y = np.concatenate([np.zeros(d), x])[: len(x)]
    return np.vstack([x, y]) if side > 0 else np.vstack([y, x])


# ---------------------------------------------------------------- 混响
_BANDS = [(0, 180), (180, 700), (700, 2200), (2200, 5500), (5500, 11000), (11000, 23500)]


def make_ir(rt60=1.0, pre=0.01, length=None, rt_mult=(1.25, 1.1, 1.0, 0.82, 0.58, 0.38),
            diffusion=0.012, er_n=10, er_span=0.035, er_gain=0.6, er_first=None, stereo_ir=True,
            seed=0, lp_hz=None, hp_hz=None, band_gain=(0.8, 1.0, 1.0, 0.9, 0.7, 0.45),
            flutter=None):
    """程序化混响 IR：分频段指数衰减噪声 + 早期反射 + 可选颤动回声（楼梯间）。能量归一化。"""
    rng = np.random.default_rng(seed)
    length = length or min(rt60 * 1.25 + pre + 0.05, 9.0)
    n = ns(length)
    t = tvec(n)
    chans = 2 if stereo_ir else 1
    ir = np.zeros((chans, n))
    ipre = int(pre * SR)
    for c in range(chans):
        noise = rng.standard_normal(n)
        tail = np.zeros(n)
        for (lo, hi), m, g in zip(_BANDS, rt_mult, band_gain):
            if lo <= 0:
                band = lp(noise, hi, order=4, zp=True)
            elif hi >= SR * 0.49:
                band = hp(noise, lo, order=4, zp=True)
            else:
                band = bp(noise, lo, hi, order=3, zp=True)
            tail += g * band * np.exp(-6.9078 * t / max(rt60 * m, 0.02))
        tail *= 1.0 - np.exp(-t / max(diffusion, 1e-4))
        tail = np.concatenate([np.zeros(ipre), tail])[:n]
        er = np.zeros(n)
        first = er_first if er_first is not None else pre * 0.35
        times = np.sort(rng.uniform(first, first + er_span, er_n))
        for k, tt in enumerate(times):
            i = int(tt * SR)
            if i < n:
                er[i] += rng.choice([-1, 1]) * (0.9 ** k) * rng.uniform(0.5, 1.0)
        if flutter:
            # 平行墙面的颤动回声：period 秒一次，逐次衰减
            period, fb, count = flutter
            for k in range(1, count + 1):
                i = int((first + k * period) * SR)
                if i < n:
                    er[i] += (fb ** k) * rng.choice([-1, 1]) * 1.4
        er = lp(er, 7000, order=2)
        er_rms = np.sqrt(np.sum(er ** 2)) + 1e-12
        tail_rms = np.sqrt(np.sum(tail ** 2)) + 1e-12
        ir[c] = tail / tail_rms + er_gain * er / er_rms
    if hp_hz:
        ir = hp(ir, hp_hz, order=2)
    if lp_hz:
        ir = lp(ir, lp_hz, order=2)
    ir = fade(ir, 0.0, min(0.2, length * 0.2))
    ir /= np.sqrt(np.sum(ir ** 2) / chans) + 1e-12
    return ir if stereo_ir else ir[0]


_IR_CACHE: dict = {}


def ir_preset(name: str) -> np.ndarray:
    """常用空间预设（缓存）。"""
    if name in _IR_CACHE:
        return _IR_CACHE[name]
    P = {
        "small_room": dict(rt60=0.32, pre=0.004, er_n=8, er_span=0.02, er_gain=0.8, seed=11),
        "bedroom": dict(rt60=0.42, pre=0.005, er_n=10, er_span=0.028, er_gain=0.7, seed=12),
        "office": dict(rt60=0.75, pre=0.008, er_n=12, er_span=0.04, er_gain=0.6, seed=13),
        "office_empty": dict(rt60=1.15, pre=0.01, er_n=14, er_span=0.05, er_gain=0.55, seed=14),
        "plate": dict(rt60=1.2, pre=0.012, er_n=0, diffusion=0.004, er_gain=0.0, seed=15,
                      rt_mult=(0.9, 1.0, 1.0, 0.95, 0.85, 0.7), band_gain=(0.5, 0.9, 1.0, 1.0, 0.9, 0.7)),
        "plate_short": dict(rt60=0.7, pre=0.008, er_n=0, diffusion=0.003, er_gain=0.0, seed=16,
                            rt_mult=(0.9, 1.0, 1.0, 0.95, 0.85, 0.7), band_gain=(0.5, 0.9, 1.0, 1.0, 0.9, 0.7)),
        "hall": dict(rt60=2.4, pre=0.03, er_n=14, er_span=0.08, er_gain=0.45, seed=17),
        "arena": dict(rt60=3.0, pre=0.045, er_n=16, er_span=0.12, er_gain=0.4, seed=18,
                      rt_mult=(1.35, 1.15, 1.0, 0.75, 0.5, 0.3)),
        "stairwell": dict(rt60=1.9, pre=0.006, er_n=6, er_span=0.02, er_gain=0.9, seed=19,
                          flutter=(0.031, 0.72, 14), rt_mult=(1.1, 1.05, 1.0, 0.85, 0.6, 0.4)),
        "street": dict(rt60=0.9, pre=0.02, er_n=5, er_span=0.09, er_gain=0.9, seed=20,
                       rt_mult=(1.0, 0.9, 0.8, 0.6, 0.4, 0.3)),
        "space": dict(rt60=3.6, pre=0.02, er_n=0, er_gain=0.0, diffusion=0.03, seed=21,
                      rt_mult=(1.0, 1.1, 1.05, 0.95, 0.8, 0.6), band_gain=(0.6, 0.9, 1.0, 1.0, 0.85, 0.6)),
        "tv_room": dict(rt60=0.5, pre=0.004, er_n=10, er_span=0.025, er_gain=0.7, seed=22),
        "venue": dict(rt60=1.6, pre=0.02, er_n=12, er_span=0.06, er_gain=0.5, seed=23),
        "valley": dict(rt60=2.2, pre=0.035, er_n=4, er_span=0.15, er_gain=0.5, seed=24,
                       rt_mult=(1.2, 1.1, 0.9, 0.6, 0.35, 0.2)),
        "tunnel": dict(rt60=1.6, pre=0.012, er_n=10, er_span=0.03, er_gain=0.7, seed=25,
                       flutter=(0.018, 0.55, 8)),
        # ---- 《鲔》新增空间
        # 水下：短、暗、扩散快（水里声速快，早期反射挤在一起），高频几乎不回来
        "uw_small": dict(rt60=0.55, pre=0.003, er_n=12, er_span=0.018, er_gain=0.5, seed=41, lp_hz=2600,
                         diffusion=0.004, rt_mult=(1.3, 1.15, 1.0, 0.7, 0.45, 0.3),
                         band_gain=(1.0, 1.0, 0.85, 0.5, 0.25, 0.1)),
        "uw_big": dict(rt60=1.8, pre=0.008, er_n=14, er_span=0.05, er_gain=0.35, seed=42, lp_hz=1900,
                       diffusion=0.01, rt_mult=(1.35, 1.2, 1.0, 0.6, 0.35, 0.25),
                       band_gain=(1.0, 1.0, 0.8, 0.4, 0.2, 0.08)),
        # 2D 长卷 / 尾声：安静的小书房，几乎不可闻的一点空间
        "paper_room": dict(rt60=0.3, pre=0.003, er_n=8, er_span=0.015, er_gain=0.6, seed=43, lp_hz=9000),
        # 2003 江边：开阔室外，几个稀疏的岸边反射
        "river_bank": dict(rt60=0.7, pre=0.02, er_n=4, er_span=0.12, er_gain=0.55, seed=44, lp_hz=6500,
                           rt_mult=(1.0, 0.95, 0.85, 0.6, 0.4, 0.3)),
        # 夜江：空旷水面，暗
        "night_river": dict(rt60=1.3, pre=0.025, er_n=5, er_span=0.15, er_gain=0.45, seed=45, lp_hz=4200,
                            rt_mult=(1.15, 1.05, 0.9, 0.65, 0.4, 0.3)),
        # 木船船舱 / 甲板
        "boat_deck": dict(rt60=0.32, pre=0.004, er_n=10, er_span=0.02, er_gain=0.75, seed=46, lp_hz=7000),
    }
    ir = make_ir(**P[name])
    _IR_CACHE[name] = ir
    return ir


def conv1(x, h, chunk=1 << 20):
    """一维线性卷积（长度 n+m-1）。短的直接 oaconvolve；长的（整条环境床）分块 fftconvolve 再重叠相加 ——
    结果与整段卷积一致（线性），但 oaconvolve 会把整条输入一次性切块做批量 FFT，90 s 的床要多吃几百 MB。"""
    n, m = len(x), len(h)
    if n <= chunk * 1.5:
        return signal.oaconvolve(x, h)
    out = np.zeros(n + m - 1)
    for a in range(0, n, chunk):
        b = min(n, a + chunk)
        y = signal.fftconvolve(x[a:b], h)
        out[a:a + len(y)] += y
    return out


def convolve(x, ir):
    """x (n,) 或 (2,n)；ir (m,) 或 (2,m)。返回长度 n+m-1 的立体声（若 ir 为立体声）。"""
    if ir.ndim == 1:
        if x.ndim == 1:
            return conv1(x, ir)
        return np.vstack([conv1(x[0], ir), conv1(x[1], ir)])
    src = x if x.ndim == 1 else x.mean(axis=0)
    out = np.empty((2, len(src) + ir.shape[-1] - 1))
    out[0] = conv1(src, ir[0])
    out[1] = conv1(src, ir[1])
    return out


def reverb(x, ir, wet=0.2, dry=1.0, tail=True, pre_hp=None, pre_lp=None):
    """干声 + 混响返回；IR 能量归一化，wet 为能量比的平方根。返回立体声。"""
    xs = stereo(x)
    src = x if x.ndim == 1 else x.mean(axis=0)
    if pre_hp:
        src = hp(src, pre_hp)
    if pre_lp:
        src = lp(src, pre_lp)
    w = convolve(src, ir if ir.ndim == 2 else np.vstack([ir, ir]))
    del src
    n = w.shape[-1] if tail else xs.shape[-1]
    out = w if tail else np.ascontiguousarray(w[:, :n])
    del w
    out *= wet  # 就地：长的环境床不再多开三四条整长的临时数组
    m = min(n, xs.shape[-1])
    for k in range(2):
        out[k, :m] += dry * xs[k, :m]
    return out


# ---------------------------------------------------------------- 动态
def env_follow_db(x, win=0.01, hop=48):
    """RMS 包络（dB），按 hop 采样。返回 (times_idx, level_db)。"""
    xm = x if x.ndim == 1 else np.mean(x ** 2, axis=0) ** 0.5
    p = ndimage.uniform_filter1d(xm.astype(float) ** 2, size=max(1, int(win * SR)), mode="constant")
    idx = np.arange(0, len(xm), hop)
    return idx, 10 * np.log10(p[idx] + 1e-14)


def smooth_ar(target_db, attack, release, hop=48):
    """控制率上的非对称一阶平滑（dB 域）。target 越低（增益越小）用 attack。"""
    a_att = np.exp(-hop / (attack * SR))
    a_rel = np.exp(-hop / (release * SR))
    out = np.empty_like(target_db)
    s = 0.0
    tl = target_db.tolist()
    for i, v in enumerate(tl):
        c = a_att if v < s else a_rel
        s = c * s + (1 - c) * v
        out[i] = s
    return out


def compress(x, thr_db=-20.0, ratio=3.0, knee_db=6.0, attack=0.005, release=0.12, win=0.005,
             makeup_db=0.0, detector=None, hop=48, return_gain=False):
    """前馈压缩器（控制率 1 ms）。detector 可指定侧链信号。"""
    det = x if detector is None else detector
    idx, lev = env_follow_db(det, win, hop)
    over = lev - thr_db
    k = knee_db
    gr = np.where(over <= -k / 2, 0.0,
                  np.where(over >= k / 2, (1.0 / ratio - 1.0) * over,
                           (1.0 / ratio - 1.0) * (over + k / 2) ** 2 / (2 * k)))
    g = smooth_ar(gr, attack, release, hop)
    n = x.shape[-1]
    g_full = np.interp(np.arange(n), idx, g) + makeup_db
    lin = dbg(g_full)
    y = x * lin
    return (y, g_full) if return_gain else y


def deess(x, lo=4500.0, hi=9500.0, thr_db=-30.0, ratio=4.0, max_red=8.0, attack=0.001, release=0.06):
    """分频段去齿音：零相位带通分出齿音带，按其电平压缩后与余量相加（互补重建）。"""
    band = bp(x, lo, hi, order=2, zp=True)
    rest = x - band
    idx, lev = env_follow_db(band, 0.004, 24)
    over = np.maximum(lev - thr_db, 0.0)
    gr = -np.minimum(over * (1 - 1.0 / ratio), max_red)
    g = smooth_ar(gr, attack, release, 24)
    gl = dbg(np.interp(np.arange(len(x)), idx, g))
    return rest + band * gl


# ---------------------------------------------------------------- 响度（BS.1770，自实现用于序列）
_K1 = (np.array([1.53512485958697, -2.69169618940638, 1.19839281085285]),
       np.array([1.0, -1.69065929318241, 0.73248077421585]))
_K2 = (np.array([1.0, -2.0, 1.0]), np.array([1.0, -1.99004745483398, 0.99007225036621]))


def k_weight(x):
    y = signal.lfilter(_K1[0], _K1[1], x, axis=-1)
    return signal.lfilter(_K2[0], _K2[1], y, axis=-1)


_K_SOS = np.array([np.concatenate([_K1[0], _K1[1]]), np.concatenate([_K2[0], _K2[1]])])


def _chunk(xs, a, b, gain=None, scale=1.0):
    """取 xs[:, a:b]（float64），可乘逐样本增益 gain[a:b] 与标量 scale（不生成整段乘积）。"""
    y = xs[:, a:b].astype(np.float64)
    if gain is not None:
        y *= gain[a:b]
    if scale != 1.0:
        y *= scale
    return y


def kw_block_energy(x_st, block, chunk_sec=10.0, gain=None, scale=1.0):
    """K 加权后逐块（block 个采样）的能量和（各声道相加）。分段滤波并携带滤波器状态，
    结果与整段滤波一致，但内存只和分段长度有关（440 s 全片也只要几十 MB）。尾部不足一块的样本丢弃。
    gain/scale：先乘逐样本增益再测（等价于测 x·gain·scale）。"""
    xs = stereo(x_st)
    n = xs.shape[-1]
    nb = n // block
    E = np.zeros(nb)
    if nb == 0:
        return E
    zi = np.zeros((_K_SOS.shape[0], xs.shape[0], 2))
    step = block * max(1, int(chunk_sec * SR) // block)
    for a in range(0, nb * block, step):
        b = min(nb * block, a + step)
        y, zi = signal.sosfilt(_K_SOS, _chunk(xs, a, b, gain, scale), axis=-1, zi=zi)
        E[a // block: b // block] = np.einsum("ij,ij->j", y, y).reshape(-1, block).sum(axis=1)
    return E


def loudness_series(x_st, win=3.0, hop=0.1):
    """滑动窗响度（LUFS）：win=0.4 为瞬时，3.0 为短时。返回 (中心时间, LUFS)。"""
    xs = stereo(x_st)
    w = max(1, int(win * SR))
    h = max(1, int(hop * SR))
    n = xs.shape[-1]
    if n >= w and w % h == 0:  # 常用组合（0.4/0.1、3/0.1、0.4/0.05、3/0.25）走分块能量，省内存
        k = w // h
        E = kw_block_energy(xs, h)
        c = np.concatenate([[0.0], np.cumsum(E)])
        ms = (c[k:] - c[:-k]) / w
        times = (np.arange(len(ms)) * h + w / 2) / SR
        return times, -0.691 + 10 * np.log10(ms + 1e-15)
    kw = k_weight(xs)
    p = np.sum(kw ** 2, axis=0)
    c = np.concatenate([[0.0], np.cumsum(p)])
    starts = np.arange(0, max(1, len(p) - w + 1), h)
    ms = (c[starts + w] - c[starts]) / w if len(p) >= w else np.array([c[-1] / max(1, len(p))])
    times = (starts + w / 2) / SR
    return times, -0.691 + 10 * np.log10(ms + 1e-15)


def integrated_lufs(x_st, gain=None, scale=1.0):
    """BS.1770-4 门限积分响度（自实现，与 pyloudnorm 一致到 ±0.1）。400 ms 窗 / 100 ms 步 = 4 个 100 ms 块。
    gain/scale 同 kw_block_energy（测 x·gain·scale）。"""
    xs = stereo(x_st)
    if xs.shape[-1] < int(0.4 * SR):
        return float("-inf")
    h = int(0.1 * SR)
    E = kw_block_energy(xs, h, gain=gain, scale=scale)
    z = np.convolve(E, np.ones(4), mode="valid") / (4 * h)
    l = -0.691 + 10 * np.log10(z + 1e-15)
    z1 = z[l > -70]
    if len(z1) == 0:
        return float("-inf")
    rel = -0.691 + 10 * np.log10(np.mean(z1)) - 10
    z2 = z[(l > -70) & (l > rel)]
    if len(z2) == 0:
        return float("-inf")
    return float(-0.691 + 10 * np.log10(np.mean(z2)))


def loudness_range(x_st):
    """EBU Tech 3342 LRA。"""
    t, st = loudness_series(x_st, 3.0, 0.1)
    st = st[st > -70]
    if len(st) < 2:
        return 0.0
    rel = 10 * np.log10(np.mean(10 ** (st / 10))) - 20
    st = st[st > rel]
    if len(st) < 2:
        return 0.0
    return float(np.percentile(st, 95) - np.percentile(st, 10))


def true_peak_env(x_st, chunk=SR * 5, up=4):
    """4 倍过采样的逐样本真峰值包络（取两声道最大）。分块处理控制内存。"""
    xs = stereo(x_st)
    n = xs.shape[-1]
    out = np.zeros(n, dtype=np.float32)
    ov = 256
    for s in range(0, n, chunk):
        a = max(0, s - ov)
        b = min(n, s + chunk + ov)
        seg = signal.resample_poly(xs[:, a:b].astype(np.float64), up, 1, axis=-1)
        pk = np.max(np.abs(seg), axis=0)
        m = (b - a)
        pk = pk[: m * up].reshape(m, up).max(axis=1)
        out[s: min(n, s + chunk)] = pk[s - a: s - a + min(chunk, n - s)]
    return out


def true_peak_db(x_st, chunk=SR * 5, up=4, gain=None, scale=1.0):
    """真峰值（dBTP）：分块求最大值，不生成整段包络。gain/scale：测 x·gain·scale。"""
    xs = stereo(x_st)
    n = xs.shape[-1]
    pk = 0.0
    ov = 256
    for s in range(0, n, chunk):
        a = max(0, s - ov)
        b = min(n, s + chunk + ov)
        seg = signal.resample_poly(_chunk(xs, a, b, gain, scale), up, 1, axis=-1)
        i0 = (s - a) * up  # 丢掉两端重叠区（重采样边缘效应），与 true_peak_env 一致
        i1 = i0 + min(chunk, n - s) * up
        pk = max(pk, float(np.max(np.abs(seg[:, i0:i1]))))
    return float(to_db(pk))


def filt1d_chunked(fn, x, size, chunk=SR * 20, **kw):
    """对很长的一维数组分段做 scipy.ndimage 的 1-D 滤波（minimum/maximum/uniform_filter1d）。
    ndimage 会为整条"线"分配 float64 缓冲，全片 2100 万点一次就是几百 MB；分段 + 两侧留足窗口余量，结果与整段完全一致。"""
    n = len(x)
    if n <= chunk * 1.5:
        return fn(x, size=size, **kw)
    out = np.empty_like(x)
    m = int(size) + abs(int(kw.get("origin", 0))) + 2
    for a in range(0, n, chunk):
        b = min(n, a + chunk)
        a0, b0 = max(0, a - m), min(n, b + m)
        y = fn(x[a0:b0], size=size, **kw)
        out[a:b] = y[a - a0: a - a0 + (b - a)]
    return out


def upsample_ctrl(g, hop, n, dtype=np.float32, chunk=1 << 20):
    """控制率曲线（每 hop 个采样一个点，第 k 点在采样 k*hop）线性插值到 n 个采样。
    等价于 np.interp(np.arange(n), np.arange(len(g))*hop, g)，分块填充，不生成 n 长的中间数组。"""
    g = np.asarray(g, dtype=np.float64)
    xp = np.arange(len(g), dtype=np.float64) * hop
    out = np.empty(n, dtype=dtype)
    for a in range(0, n, chunk):
        b = min(n, a + chunk)
        out[a:b] = np.interp(np.arange(a, b, dtype=np.float64), xp, g)
    return out


def apply_gain_db(x, gdb, chunk=1 << 20):
    """x（立体声或单声道）就地乘以逐样本增益 10^(gdb/20)，分块算，不生成整段线性增益。"""
    n = x.shape[-1]
    for a in range(0, n, chunk):
        b = min(n, a + chunk)
        x[..., a:b] *= (10.0 ** (np.asarray(gdb[a:b], dtype=np.float64) / 20.0)).astype(x.dtype)
    return x


def normalize_peak(x, target_db=-3.0):
    pk = np.max(np.abs(x)) + 1e-12
    return x * (dbg(target_db) / pk)


def normalize_lufs(x, target=-23.0):
    L = integrated_lufs(x)
    if not np.isfinite(L):
        return x
    return x * dbg(target - L)


# ================================================================ 《鲔》新增积木
def uw_color(x, cutoff=1100.0, low_db=3.0, mid_db=-2.0, order=2):
    """水下听感：高频迅速衰减（二阶低通）+ 低频略厚（低架）+ 中频一点点"闷"。立体声/单声道均可。"""
    y = eq(x, ("lowshelf", 160.0, 0.7, low_db), ("peak", 700.0, 0.8, mid_db))
    y = lp(y, cutoff, order=order)
    return y


def frac_read(x, pos):
    """三次 Hermite 分数延时读取（越界补零）。"""
    n = len(x)
    i = np.floor(pos).astype(np.int64)
    f = pos - i
    xm1 = x[np.clip(i - 1, 0, n - 1)]
    x0 = x[np.clip(i, 0, n - 1)]
    x1 = x[np.clip(i + 1, 0, n - 1)]
    x2 = x[np.clip(i + 2, 0, n - 1)]
    c1 = 0.5 * (x1 - xm1)
    c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2
    c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1)
    y = ((c3 * f + c2) * f + c1) * f + x0
    y[(pos < 0) | (pos > n - 1)] = 0.0
    return y


def wsola(x, tmap, out_len, win=0.03, hop=0.015, tol=0.008):
    """WSOLA 变速不变调：tmap(t_out)->t_src（秒）。"""
    W = int(win * SR)
    H = int(hop * SR)
    T = int(tol * SR)
    xp = np.concatenate([np.zeros(W + T), x, np.zeros(2 * W + 2 * T)])
    off = W + T
    out = np.zeros(out_len + 2 * W)
    wsum = np.zeros_like(out)
    w = np.hanning(W)
    prev = None
    for k in range(0, out_len // H + 2):
        t_out = k * H
        ideal = int(round(tmap(t_out / SR) * SR)) + off
        if prev is None:
            pos = ideal
        else:
            tgt = xp[prev + H: prev + H + W]
            lo = max(0, ideal - T)
            reg = xp[lo: lo + W + 2 * T]
            if len(reg) < W + 1 or np.std(tgt) < 1e-7:
                pos = ideal
            else:
                cc = signal.correlate(reg, tgt, mode="valid")
                pos = lo + int(np.argmax(cc))
        seg = xp[pos: pos + W]
        if len(seg) < W:
            seg = np.pad(seg, (0, W - len(seg)))
        out[t_out: t_out + W] += seg * w
        wsum[t_out: t_out + W] += w
        prev = pos
    y = out[:out_len] / np.maximum(wsum[:out_len], 1e-3)
    y[wsum[:out_len] < 1e-3] = 0.0
    return y


def shift_pitch_formants(x, semitones):
    """音高与共振峰一起移动（重采样 = 整体变慢/变快），再用 WSOLA 把时长拉回原长，保证与字幕/时间线同步。"""
    if abs(semitones) < 1e-6:
        return np.array(x, dtype=float)
    r = 2.0 ** (semitones / 12.0)          # <1 降调
    n = len(x)
    m = int(round(n / r))                   # 降调后变长
    pos = np.arange(m) * r
    y = frac_read(np.asarray(x, dtype=float), pos)
    y = lp(y, min(SR * 0.45, 0.45 * SR * r), order=4) if r > 1 else y
    return wsola(y, lambda t: t * (m / n), n)


def smoothstep(u):
    u = np.clip(u, 0.0, 1.0)
    return u * u * (3 - 2 * u)


def env_db_points(n, pts, t0=0.0):
    """dB 折线包络 → 线性增益（pts=[(t, dB), ...]，t 相对缓冲开头；区间外保持端点值）。"""
    t = tvec(n) + t0
    ts = np.array([p[0] for p in pts], dtype=float)
    vs = np.array([p[1] for p in pts], dtype=float)
    return dbg(np.interp(t, ts, vs))


def grain_bank(n, times, freqs, durs, amps, pans=None, kind="sine", rng=None, bw=None):
    """在长度 n 的立体声缓冲里放一批很短的颗粒（Hann 窗）。kind='sine' 正弦颗粒，'noise' 带通噪声颗粒。"""
    out = np.zeros((2, n))
    if pans is None:
        pans = np.zeros(len(times))
    rng = rng if rng is not None else np.random.default_rng(0)
    for tc, f, d, a, p in zip(times, freqs, durs, amps, pans):
        m = max(8, int(d * SR))
        i = int(tc * SR)
        if i >= n or i + m <= 0:
            continue
        w = np.hanning(m + 2)[1:-1]
        if kind == "sine":
            g = np.sin(TWO_PI * f * np.arange(m) / SR + rng.uniform(0, TWO_PI)) * w
        else:
            q = bw if bw else 2.0
            g = signal.sosfilt(biquad("bandpass", f, q), rng.standard_normal(m + 64))[64:] * w
            g /= (np.max(np.abs(g)) + 1e-12)
        th = (np.clip(p, -1, 1) + 1) * np.pi / 4
        add_at(out, np.vstack([g * np.cos(th), g * np.sin(th)]) * a, i)
    return out


def poisson_times(rate_arr, rng, dur, min_gap=0.0):
    """按时变速率（每样本一个值，单位 次/秒）生成泊松事件时间（稀疏化），可选最小间隔。"""
    rmax = float(np.max(rate_arr)) + 1e-9
    cand = np.sort(rng.uniform(0, dur, rng.poisson(rmax * dur)))
    idx = np.minimum((cand * SR).astype(int), len(rate_arr) - 1)
    keep = rng.random(len(cand)) < rate_arr[idx] / rmax
    t = cand[keep]
    if min_gap > 0 and len(t) > 1:
        out = [t[0]]
        for v in t[1:]:
            if v - out[-1] >= min_gap:
                out.append(v)
        t = np.array(out)
    return t


def impulses(n, times, amps):
    """稀疏冲激序列。"""
    x = np.zeros(n)
    idx = (np.asarray(times) * SR).astype(int)
    ok = (idx >= 0) & (idx < n)
    np.add.at(x, idx[ok], np.asarray(amps)[ok])
    return x


def norm_lufs_st(x, target):
    """立体声/单声道片段校准到目标积分响度（静音则原样返回）。"""
    L = integrated_lufs(stereo(x))
    if not np.isfinite(L):
        return x
    return x * dbg(target - L)


def _velvet(rng, dur=0.03, density=1500.0, decay=0.012):
    m = ns(dur)
    k = max(4, int(dur * density))
    pos = np.sort(rng.integers(0, m, k))
    h = np.zeros(m)
    h[pos] = rng.choice([-1.0, 1.0], k) * np.exp(-pos / (decay * SR))
    return h / (np.sqrt(np.sum(h ** 2)) + 1e-12)


def widen(x, amount=0.5, seed=0):
    """单声道 → 立体声，保证单声道兼容：L = x + S，R = x − S，S = amount·velvet 去相关(x)。
    L+R = 2x（完全没有梳状滤波），只有左右差异里有去相关成分。x 若为立体声先取中间声道。"""
    x = np.asarray(x, dtype=float)
    if x.ndim == 2:
        x = x.mean(axis=0)
    rng = np.random.default_rng(seed + 7919)
    s = conv1(x, _velvet(rng))[: len(x)]
    s *= amount * (np.std(x) + 1e-12) / (np.std(s) + 1e-12)
    k = 1.0 / np.sqrt(1.0 + amount ** 2)
    out = np.empty((2, len(x)))
    np.add(x, s, out=out[0])
    np.subtract(x, s, out=out[1])
    out *= k
    return out


# ---------------------------------------------------------------- A 计权 / 听感最响处
_AW = {}


def a_weight(x):
    """A 计权（IEC 61672 的模拟零极点 → 双线性变换，1 kHz 处 0 dB）。沿最后一维滤波。"""
    if "sos" not in _AW:
        z = [0.0] * 4
        p = [-2 * np.pi * f for f in (20.598997, 20.598997, 107.65265, 737.86223, 12194.217, 12194.217)]
        zd, pd, kd = signal.bilinear_zpk(z, p, 1.0, SR)
        _, h = signal.freqz_zpk(zd, pd, kd, worN=[1000.0], fs=SR)
        _AW["sos"] = signal.zpk2sos(zd, pd, kd / abs(h[0]))
    return signal.sosfilt(_AW["sos"], x, axis=-1)


def perceived_peak(x, near, win=0.12, search=0.3):
    """x: (2,n) 或 (n,)。A 计权后 win 秒 RMS 的最大处（采样位置），只在 near±search 秒里找。
    给"最近点"这类宽包络定同步点用：混响、包络不对称都会把听感上的最响处往后推，按实测放。"""
    m = x.mean(axis=0) if x.ndim == 2 else x
    y = a_weight(m)
    e = ndimage.uniform_filter1d(y * y, max(1, int(win * SR)), mode="constant")
    a, b = max(0, int((near - search) * SR)), min(len(e), int((near + search) * SR))
    return a + int(np.argmax(e[a:b]))


def peak_tame(x, ceiling_db, lookahead=0.002):
    """颗粒纹理（泥沙、散开的光粒、墨点）里个别特别大的颗粒压到 ceiling：±lookahead 的最小值保持 + 等宽平滑，
    离群的那一粒被整体按比例压下去（颗粒本身只有几毫秒，听不出限幅），其余密集纹理完全不动。"""
    c = dbg(ceiling_db)
    env = np.max(np.abs(x), axis=0) if x.ndim == 2 else np.abs(x)
    g = np.minimum(1.0, c / np.maximum(env, 1e-12))
    if g.min() >= 1.0:
        return x
    L = max(1, int(lookahead * SR))
    g = ndimage.minimum_filter1d(g, 2 * L + 1, mode="nearest")
    g = ndimage.uniform_filter1d(g, L, mode="nearest")
    return x * g
