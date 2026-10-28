"""客观自检（听不到声音，就用数）：
  measure_sync   单个 cue 的起音/峰值时刻（onset=首次超过自身峰值 -30 dB；slope=5 ms RMS 的 dB 包络最陡处；peak=50 ms RMS 最大处）
  ping_report    信标「嘀」：在音效分轨上只认 1760 Hz 的纯音（比两侧频带高 12 dB 以上），查周期 2.000 s、首声对 tag_ping_start、触礁后是否断干净
  bed_report     环境床：长时谱的窄带尖峰（"奇怪的音高"，另在水下低通 / 去低频两种滤波状态下各查一次）+ 包络/谱的重复（短循环）
  click_report   爆音：二阶差分相对局部水平的离群点（设计里的瞬态也会被列出，给人对照）
  dc_report      直流
全部分块或只取局部片段，内存和整片长度无关。
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage, signal

from audio.sfx import dsp

SR = dsp.SR


# ---------------------------------------------------------------- 起音
def a_weight(x):
    """A 计权（见 dsp.a_weight）。起音"陡度"和"最响处"都按人耳的响度感来量：
    40–100 Hz 的轰鸣对人耳几乎不算数，否则船、江底这类低频噪声的随机起伏会把真正的瞬态盖住。"""
    return dsp.a_weight(x)


def measure_sync(a, i_sync, kind="onset", search=(0.2, 0.3), floor_db=30.0, peak_win=0.12):
    """a: (2,n) 或 (n,)；i_sync: 期望同步点在 a 里的采样位置。返回 实测 - 期望（秒）；测不到返回 None。
    onset：首次超过自身峰值 -30 dB 的时刻（原始信号）。
    slope：A 计权后 5 ms RMS 的 dB 包络上升最陡处；低于峰值 floor_db 的部分不计（孤立缓冲里从数字静音起步的
           极轻前导声，在混音里被环境床盖住，不该算成"起音"）。
    peak ：A 计权后 peak_win（默认 120 ms，≈ 响度积分时间）RMS 的最大处 —— 给"最近点"这类宽包络用。"""
    x = np.asarray(a, dtype=np.float64)
    m = np.max(np.abs(x), axis=0) if x.ndim == 2 else np.abs(x)
    n = len(m)
    lo = max(0, i_sync - int(search[0] * SR))
    hi = min(n, i_sync + int(search[1] * SR))
    if hi - lo < 64:
        return None
    if kind == "onset":
        seg = m[lo:]
        pk = seg.max()
        if pk <= 0:
            return None
        idx = int(np.argmax(seg >= pk * 10 ** (-30 / 20)))
        return (lo + idx - i_sync) / SR
    xm = x.mean(axis=0) if x.ndim == 2 else x
    if kind == "slope":
        w = int(0.005 * SR)
        pad = int(0.05 * SR)
        a0, b0 = max(0, lo - pad), min(n, hi + pad)
        y = a_weight(xm[max(0, a0 - int(0.05 * SR)):b0])[a0 - max(0, a0 - int(0.05 * SR)):]
        e = ndimage.uniform_filter1d(y ** 2, w, mode="constant")
        db = 10 * np.log10(e + 1e-20)
        db = np.maximum(db, db.max() - floor_db)
        d = np.zeros_like(db)
        d[w:] = db[w:] - db[:-w]
        s0, s1 = lo - a0, hi - a0
        k = int(np.argmax(d[s0:s1])) + s0
        return (a0 + k - w // 2 - i_sync) / SR
    if kind == "peak":
        w = int(peak_win * SR)
        a0, b0 = max(0, i_sync - int(0.8 * SR)), min(n, i_sync + int(0.8 * SR))
        y = a_weight(xm[max(0, a0 - int(0.05 * SR)):b0])[a0 - max(0, a0 - int(0.05 * SR)):]
        e = ndimage.uniform_filter1d(y ** 2, w, mode="constant")
        return (a0 + int(np.argmax(e)) - i_sync) / SR
    raise ValueError(kind)


# ---------------------------------------------------------------- 嘀
def _band_env(x, f0, bw):
    sos = signal.butter(4, [f0 - bw, f0 + bw], btype="bandpass", fs=SR, output="sos")
    y = signal.sosfiltfilt(sos, x)
    e = np.abs(signal.hilbert(y))
    return ndimage.uniform_filter1d(e, int(0.002 * SR))


def ping_report(bus, t_from, t_to, first_expected, crash_t, period=2.0, f0=1760.0, tonal_db=20.0, min_len=0.02):
    """bus: 立体声分轨；在 [t_from, t_to] 里找 f0 的"纯音"短音。
    只认"音"：f0±50 Hz 的包络要比两侧（f0-330 / f0+330 Hz）的平均高 tonal_db 以上，且连续 min_len 秒以上 ——
    咔哒、撞击这类宽带或短促共振的瞬态不会被当成嘀（上一版就把信标扣上的咔哒和触礁算成了嘀）。
    电平基准 = 触礁之前最响的那声纯音；起音 = 回溯到该声自身峰值 -30 dB 处。
    返回每声起音、首声误差、周期误差、触礁后的纯音残留（没有就是 None）。"""
    a, b = int(t_from * SR), min(bus.shape[-1], int(t_to * SR))
    x = np.asarray(bus[:, a:b], dtype=np.float64).mean(axis=0)
    e = _band_env(x, f0, 50.0)
    side = 0.5 * (_band_env(x, f0 - 330.0, 50.0) + _band_env(x, f0 + 330.0, 50.0))
    tonal = e >= side * 10 ** (tonal_db / 20)
    ic = int((crash_t + 0.015 - t_from) * SR)  # 触礁后（留 15 ms 给截断淡出）
    before = tonal.copy()
    if 0 <= ic < len(before):
        before[ic:] = False
    if not before.any():
        return dict(n=0, note="没有检测到 1760 Hz 纯音")
    pk = e[before].max()
    is_tone = tonal & (e >= pk * 10 ** (-24 / 20))
    is_tone = ndimage.binary_opening(is_tone, np.ones(max(1, int(min_len * SR)), bool))
    lab, k = ndimage.label(is_tone)
    ons, peaks_db = [], []
    gap = int(0.5 * period * SR)  # 一个周期里只有一声：离上一声不到半个周期的纯音段是它的混响尾巴
    for j in range(1, k + 1):
        idx = np.nonzero(lab == j)[0]
        i_pk = idx[np.argmax(e[idx])]
        if ons and idx[0] - ons[-1] < gap:
            continue
        thr = e[i_pk] * 10 ** (-30 / 20)
        i = idx[0]
        stop = ons[-1] + gap if ons else 0
        while i > stop and e[i - 1] >= thr:
            i -= 1
        ons.append(i)
        peaks_db.append(round(float(20 * np.log10(e[i_pk] / pk)), 1))
    t_on = [(a + i) / SR for i in ons]
    per = np.diff(t_on) if len(t_on) > 1 else np.array([])
    after_db = None
    if 0 <= ic < len(e):
        tail = e[ic:][tonal[ic:]]
        if len(tail):
            after_db = round(float(20 * np.log10((tail.max() + 1e-12) / pk)), 1)
    return dict(
        n=len(t_on), onsets=[round(t, 4) for t in t_on], peak_db_rel=peaks_db,
        first_error_ms=round((t_on[0] - first_expected) * 1000, 2) if t_on else None,
        period_mean_s=round(float(per.mean()), 5) if len(per) else None,
        period_max_error_ms=round(float(np.max(np.abs(per - period))) * 1000, 2) if len(per) else None,
        last_before_crash=bool(t_on and t_on[-1] < crash_t),
        last_onset_to_crash_s=round(crash_t - t_on[-1], 3) if t_on else None,
        after_crash_tone_db_rel=after_db,
    )


# ---------------------------------------------------------------- 环境床
def _tonality(x, lo=40.0, hi=8000.0):
    """长时谱（Welch，~2.9 Hz 分辨率）相对 1/3 倍频程中值基线的最大凸起（dB）及其频率。"""
    m = x.mean(axis=0) if x.ndim == 2 else x
    f, P = signal.welch(m, fs=SR, nperseg=16384, noverlap=8192)
    Pdb = 10 * np.log10(P + 1e-30)
    sel = (f >= lo) & (f <= hi)
    base = np.empty_like(Pdb)
    lf = np.log2(np.maximum(f, 1.0))
    for i in range(len(f)):
        if not sel[i]:
            base[i] = Pdb[i]
            continue
        w = (lf >= lf[i] - 1 / 6) & (lf <= lf[i] + 1 / 6)
        base[i] = np.median(Pdb[w])
    prom = np.where(sel, Pdb - base, -99)
    k = int(np.argmax(prom))
    return float(prom[k]), float(f[k])


def _repetition(x, min_lag=1.0, max_lag=20.0):
    """重复检测：对 8 个频带、20 ms 帧的对数能量轨迹做归一化自相关，返回 lag∈[min_lag,max_lag] 的最大相关与其 lag。
    程序化噪声床应该很低（<0.5）；一段短循环会在循环周期处接近 1。"""
    m = x.mean(axis=0) if x.ndim == 2 else x
    hop = int(0.02 * SR)
    k = len(m) // hop
    # 至少要有两倍 lag 的重叠才统计得稳：短床（15 s）只查到 5 s 的循环，否则两秒的重叠里偶然相关 0.5 很常见
    max_lag = min(max_lag, k * 0.02 / 3.0)
    if max_lag < min_lag + 0.5:
        return None, None
    edges = np.geomspace(60, 8000, 9)
    feats = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        sos = signal.butter(2, [lo, hi], btype="bandpass", fs=SR, output="sos")
        y = signal.sosfilt(sos, m)
        e = 10 * np.log10(np.mean(y[: k * hop].reshape(k, hop) ** 2, axis=1) + 1e-20)
        e = e - ndimage.uniform_filter1d(e, int(3.0 / 0.02))  # 去掉慢的起伏（淡入淡出 / 自动化）
        feats.append((e - e.mean()) / (e.std() + 1e-9))
    F = np.array(feats)
    n = F.shape[1]
    best, best_lag = 0.0, None
    for lag in range(int(min_lag / 0.02), min(int(max_lag / 0.02), n - 10)):
        c = float(np.mean(np.sum(F[:, lag:] * F[:, :-lag], axis=1) / (n - lag)))
        if c > best:
            best, best_lag = c, lag * 0.02
    return round(best, 3), (round(best_lag, 2) if best_lag else None)


def bed_report(name, audio, max_sec=60.0):
    """audio: 渲染好的床（(2,n)，未闪避）。在"原样 / 水下低通 800 Hz / 去掉 500 Hz 以下"三种状态下各查一次音高尖峰。"""
    x = np.asarray(audio[:, : int(max_sec * SR)], dtype=np.float64)
    if x.shape[-1] < 4 * SR:
        return dict(name=name, note="太短，跳过")
    states = {"raw": x, "lp800": dsp.lp(x, 800, order=4), "hp500": dsp.hp(x, 500, order=4)}
    out = dict(name=name)
    for k, v in states.items():
        pr, fr = _tonality(v, hi=(700 if k == "lp800" else 8000), lo=(550 if k == "hp500" else 40))
        out[f"tonal_{k}_db"] = round(pr, 1)
        out[f"tonal_{k}_hz"] = round(fr, 1)
    rep, lag = _repetition(x)
    out["repeat_corr"] = rep
    out["repeat_lag_s"] = lag
    return out


# ---------------------------------------------------------------- 爆音 / 直流
def click_report(x, top=12, chunk=SR * 20):
    """二阶差分 / 局部 5 ms 中值 的离群点。返回最显著的 top 个（时间、强度、局部电平）。"""
    n = x.shape[-1]
    found = []
    for a in range(0, n, chunk):
        b = min(n, a + chunk + 2)
        seg = np.asarray(x[:, a:b], dtype=np.float64).mean(axis=0)
        d2 = np.abs(np.diff(seg, 2))
        loc = ndimage.uniform_filter1d(d2, size=int(0.005 * SR), mode="nearest") + 1e-7
        r = d2 / loc
        lev = ndimage.maximum_filter1d(np.abs(seg[1:-1]), int(0.005 * SR))
        cand = np.nonzero((r > 40) & (d2 > 10 ** (-60 / 20)))[0]
        if len(cand):
            # 同一个 20 ms 里只留最强的
            keep = []
            for i in cand:
                if keep and i - keep[-1] < int(0.02 * SR):
                    if r[i] > r[keep[-1]]:
                        keep[-1] = i
                else:
                    keep.append(i)
            for i in keep:
                found.append((float(r[i]), (a + i + 1) / SR, float(20 * np.log10(d2[i] + 1e-12)),
                              float(20 * np.log10(lev[i] + 1e-12))))
    found.sort(reverse=True)
    return dict(n_candidates=len(found),
                top=[dict(t=round(t, 3), ratio=round(r, 1), jump_db=round(j, 1), level_db=round(l, 1)) for r, t, j, l in found[:top]])


def dc_report(x, win=SR * 10):
    n = x.shape[-1]
    worst = 0.0
    tot = np.zeros(2)
    for a in range(0, n, win):
        s = np.asarray(x[:, a:a + win], dtype=np.float64)
        tot += s.sum(axis=1)
        worst = max(worst, float(np.max(np.abs(s.mean(axis=1)))))
    return dict(mean_l=float(tot[0] / n), mean_r=float(tot[1] / n), worst_10s_window=worst)
