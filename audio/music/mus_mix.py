"""《鲔》配乐混音阶段：分轨基准增益、对白让路深度、联动限幅（由总混求增益曲线，同乘到所有分轨，
分轨之和严格等于总混）、片尾静音。linked_gain 复制自 movie4《重构》的 mus_mix.py。"""
import numpy as np
from scipy.ndimage import minimum_filter1d, uniform_filter1d
from mus_dsp import SR

STEM_GAIN_DB = {'guqin': 4.0, 'strings': -5.0, 'hum': -3.0, 'pad': -4.0, 'glass': -5.0, 'sub': 0.0}

# 台词期间（真正开口前 0.35 s 到说完后 0.6 s）各分轨的慢速宽带下压（dB）：编曲层面的让路。
# 最终的侧链闪避由音效组在混音时再做。
DIALOG_TRIM = {'guqin': 1.5, 'strings': 2.5, 'hum': 3.0, 'pad': 3.0, 'glass': 2.0, 'sub': 0.0}


def _release(g, coef):
    from numba import njit

    @njit(cache=False)
    def rel(g, coef):
        out = np.empty_like(g)
        prev = 1.0
        for i in range(g.size):
            v = g[i]
            if v < prev:
                prev = v
            else:
                prev = prev + (v - prev) * coef
            out[i] = prev
        return out
    return rel(g, coef)


def linked_gain(mix, ceiling, look_ms=1.5, release_ms=80.0):
    """由总混求限幅增益曲线（float32，长度 n），同一曲线乘到每个分轨上：分轨之和仍精确等于总混。"""
    n = mix.shape[1]
    g = np.ones(n, dtype=np.float32)
    L = max(2, int(look_ms * 1e-3 * SR))
    pad = int(release_ms * 1e-3 * SR * 10) + 4 * L
    over = np.nonzero(np.max(np.abs(mix), axis=0) > ceiling)[0]
    if over.size == 0:
        return g, 0.0
    regions = []
    start = prev = over[0]
    for i in over[1:]:
        if i - prev > pad:
            regions.append((start, prev))
            start = i
        prev = i
    regions.append((start, prev))
    coef = 1.0 - np.exp(-1.0 / (release_ms * 1e-3 * SR))
    for (r0, r1) in regions:
        a = max(0, r0 - 4 * L)
        b = min(n, r1 + pad)
        pk = np.max(np.abs(mix[:, a:b]), axis=0).astype(np.float64)
        req = np.minimum(1.0, ceiling / np.maximum(pk, 1e-12))
        gmin = minimum_filter1d(req, size=2 * L + 1, mode='nearest')
        gs = np.minimum(uniform_filter1d(gmin, size=L, mode='nearest'), req)
        g[a:b] = np.minimum(g[a:b], _release(gs, coef).astype(np.float32))
    return g, float(20 * np.log10(np.min(g)))


def end_silence(x, t_start, t_zero):
    """片尾：t_start 到 t_zero 余弦淡到 0，之后严格为 0（485.19 s 结束时完全静音；混响尾巴一起收）。"""
    a = int(t_start * SR)
    z = int(t_zero * SR)
    w = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, z - a, dtype=np.float32))
    x[:, a:z] *= w
    x[:, z:] = 0.0
    return x
