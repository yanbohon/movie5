"""《鲔》配乐质检（我听不到声音，全部用客观测量）：
- BS.1770 响度：短期（3 s）/ 瞬时（0.4 s）响度曲线、分场景积分响度、真峰值（4 倍过采样）
- 卡点起音误差：在每个放置的起音附近找能量上升最陡处
- 硬切：切点前后 2 ms 窗的电平，切点后 15 ms 起必须低于 -60 dBFS
- 爆音：高频瞬态比值扫描（古琴拨弦时刻前后 25 ms 豁免——那是设计出来的起音）+ 二阶差分跳变
- 直流、削波、片尾静音、black 时刻静音
- 短循环：非静音 2048 点块的哈希完全重复检测；玻璃粒子起音间隔的周期性（自相关）
- 频谱图：全片 + 分场景（标台词、卡点、主题音）
k_blocks / true_peak / onset_near / click_scan 的骨架复制自 movie4《重构》的 mus_qa.py。"""
import hashlib
import json
import math
import os
import numpy as np
from scipy import signal
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from mus_dsp import SR, sos_filter

for _fp in (os.path.join(os.path.dirname(__file__), '..', '..', 'fonts-src', 'NotoSansSC.ttf'),
            '/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/STHeiti Light.ttc'):
    if os.path.exists(_fp):
        try:
            font_manager.fontManager.addfont(_fp)
            plt.rcParams['font.family'] = font_manager.FontProperties(fname=_fp).get_name()
            plt.rcParams['axes.unicode_minus'] = False
            break
        except Exception:
            pass


def true_peak_db(x):
    pk = 0.0
    blk = SR * 20
    for ch in range(x.shape[0]):
        for a in range(0, x.shape[1], blk):
            seg = x[ch, max(0, a - 64):a + blk + 64].astype(np.float64)
            up = signal.resample_poly(seg, 4, 1)
            pk = max(pk, float(np.max(np.abs(up))))
    return 20 * math.log10(pk + 1e-12)


_KB1 = np.array([1.53512485958697, -2.69169618940638, 1.19839281085285])
_KA1 = np.array([1.0, -1.69065929318241, 0.73248077421585])
_KB2 = np.array([1.0, -2.0, 1.0])
_KA2 = np.array([1.0, -1.99004745483398, 0.99007225036621])
BLK = 480


def k_blocks(x):
    n = x.shape[1] // BLK * BLK
    acc = np.zeros(n // BLK, dtype=np.float64)
    CH = BLK * 1000
    for ch in range(x.shape[0]):
        z1 = np.zeros(2)
        z2 = np.zeros(2)
        for a in range(0, n, CH):
            seg = x[ch, a:min(n, a + CH)].astype(np.float64)
            y, z1 = signal.lfilter(_KB1, _KA1, seg, zi=z1)
            y, z2 = signal.lfilter(_KB2, _KA2, y, zi=z2)
            acc[a // BLK:(a + seg.size) // BLK] += np.sum((y * y).reshape(-1, BLK), axis=1)
    return np.concatenate([[0.0], np.cumsum(acc)])


def _win_lufs(cum, a, b):
    ia, ib = a // BLK, b // BLK
    if ib <= ia:
        return -np.inf
    ms = (cum[ib] - cum[ia]) / ((ib - ia) * BLK)
    return -0.691 + 10 * math.log10(ms) if ms > 1e-15 else -np.inf


def curve_lufs(cum, t0, t1, win, hop):
    out = []
    t = t0
    while t + win <= t1 + 1e-9:
        out.append((t + win / 2, _win_lufs(cum, int(t * SR), int((t + win) * SR))))
        t += hop
    return out


def integrated_lufs(cum, t0, t1):
    blocks = []
    t = t0
    while t + 0.4 <= t1 + 1e-9:
        blocks.append(_win_lufs(cum, int(t * SR), int((t + 0.4) * SR)))
        t += 0.1
    bl = np.array([b for b in blocks if b > -70])
    if bl.size == 0:
        return -np.inf
    rel = -0.691 + 10 * math.log10(np.mean(10 ** ((bl + 0.691) / 10))) - 10
    bl2 = bl[bl > rel]
    return -0.691 + 10 * math.log10(np.mean(10 ** ((bl2 + 0.691) / 10)))


def onset_near(x, t, others=(), win_max=0.05, rise_min=8.0, base_len=0.03):
    """在 t 附近找实际起音。窗口随同一分轨相邻卡点的间距自适应（往后 0.45 倍间距、8–50 ms，往前最多 20 ms）；
    全频与 1.2 kHz 以上两个频带各算 0.5 ms 帧能量（2 ms 平滑）；基线取窗口前 30 ms 的最大值
    （低音一个周期里能量起伏很大，用最大值才不会把正在响的音当成新起音）；
    起音 = 窗口内第一次超过 max(基线 + 8 dB, 窗内峰值 - 20 dB) 的帧，取上升量大的频带。
    返回 (偏差秒 或 None, 上升 dB, 频带)。上升不足 8 dB 返回 None：新音被正在响的声音盖住
    （快速的滚拂、锁，同一根弦滑音后重拨，慢起的弦乐），测不准就不报数。"""
    near = [abs(o - t) for o in others if abs(o - t) > 0.02]
    win = float(np.clip(0.45 * min(near), 0.008, win_max)) if near else win_max
    wpre = min(win, 0.02)          # 往前只看 20 ms：更早的起音会贴在窗口起点，照样暴露出来
    a = int((t - wpre - base_len - 0.01) * SR)
    b = int((t + win + 0.01) * SR)
    seg = np.mean(x[:, max(0, a):b], axis=0).astype(np.float64)
    hop = int(0.0005 * SR)
    best = (None, -1e9, '')
    for band in ('full', 'hf'):
        z = seg if band == 'full' else sos_filter(seg, 'highpass', 1200, 4)
        e = np.mean(z[:len(z) // hop * hop].reshape(-1, hop) ** 2, axis=1)
        e = np.convolve(e, np.ones(4) / 4, mode='same')
        tt = (max(0, a) + (np.arange(e.size) + 0.5) * hop) / SR
        bs = (tt >= t - wpre - base_len) & (tt < t - wpre)
        ms = (tt >= t - wpre) & (tt <= t + win)
        if not np.any(ms):
            continue
        base = (float(np.max(e[bs])) if np.any(bs) else 0.0) + 1e-20
        pk = float(np.max(e[ms]))
        rise = 10 * math.log10(pk / base + 1e-30)
        if rise <= best[1]:
            continue
        if rise < rise_min:
            best = (None, rise, band)
            continue
        thr = max(base * 10 ** (rise_min / 10), pk * 0.01)
        i = int(np.nonzero(ms & (e >= thr))[0][0])
        best = (float(tt[i] - t), rise, band)
    return best


def click_scan(x, exempt=(), thresh=8.0):
    """8 kHz 以上能量在 1 ms 内相对周围 20 ms 突增的点（豁免 exempt 中的时刻 ±25 ms）。"""
    y = sos_filter(np.mean(x, axis=0, dtype=np.float32), 'highpass', 8000, 4).astype(np.float32)
    hop = int(0.001 * SR)
    fr = y[:len(y) // hop * hop].reshape(-1, hop)
    e = np.sqrt(np.mean(fr ** 2, axis=1)) + 1e-9
    k = 21
    loc = np.convolve(e, np.ones(k) / k, mode='same')
    ratio = e / (loc + 1e-9)
    idx = np.nonzero((ratio > thresh) & (e > 1e-4))[0]
    ex = np.array(sorted(exempt)) if len(exempt) else np.zeros(0)
    out = []
    for i in idx:
        t = i * 0.001
        if ex.size and np.min(np.abs(ex - t)) < 0.025:
            continue
        out.append(round(t, 3))
    return out


def jump_scan(x, exempt=(), k=12.0):
    """样本级跳变：|二阶差分| 远大于局部（5 ms）平均幅度的点。"""
    m = np.mean(x, axis=0, dtype=np.float32)
    d2 = np.abs(np.diff(m, 2))
    loc = np.convolve(np.abs(m), np.ones(240, dtype=np.float32) / 240, mode='same')[1:-1]
    idx = np.nonzero((d2 > k * (loc + 1e-5)) & (d2 > 2e-3))[0]
    ex = np.array(sorted(exempt)) if len(exempt) else np.zeros(0)
    out = []
    last = -1.0
    for i in idx:
        t = (i + 1) / SR
        if ex.size and np.min(np.abs(ex - t)) < 0.025:
            continue
        if t - last > 0.01:
            out.append(round(t, 4))
        last = t
    return out


def level_db(x, t0, t1):
    seg = x[:, max(0, int(t0 * SR)):int(t1 * SR)]
    if seg.size == 0:
        return -np.inf
    return 20 * math.log10(float(np.sqrt(np.mean(seg.astype(np.float64) ** 2))) + 1e-12)


def peak_db(x, t0, t1):
    seg = x[:, max(0, int(t0 * SR)):int(t1 * SR)]
    return 20 * math.log10(float(np.max(np.abs(seg))) + 1e-12)


def cut_check(x, t):
    """硬切检测：2 ms 窗 RMS 曲线（dBFS），切点前 0.2 s 的电平、切点后 15 ms / 100 ms 内的最大电平。"""
    before = level_db(x, t - 0.2, t - 0.02)
    win = int(0.002 * SR)
    a = int(t * SR)
    seg = x[:, a:a + int(0.3 * SR)].astype(np.float64)
    nfr = seg.shape[1] // win
    rms = 20 * np.log10(np.sqrt(np.mean(seg[:, :nfr * win].reshape(2, nfr, win) ** 2, axis=(0, 2))) + 1e-12)
    after15 = float(np.max(rms[int(0.015 / 0.002):int(0.100 / 0.002)]))
    t_below = None
    for i, v in enumerate(rms):
        if np.all(rms[i:i + 10] < -60):
            t_below = i * 0.002
            break
    return {'t': round(t, 4), 'level_before_dbfs': round(before, 1),
            'max_level_15_100ms_after_dbfs': round(after15, 1),
            'first_time_below_-60dBFS_s': None if t_below is None else round(t_below, 4),
            'pass_15ms_-60dB': bool(after15 < -60 and t_below is not None and t_below <= 0.015)}


def dup_blocks(x, blk=2048, min_db=-65.0):
    """完全相同的非静音样本块（循环/复制粘贴）检测。"""
    m = np.mean(x, axis=0, dtype=np.float32)
    seen = {}
    dups = []
    thr = 10 ** (min_db / 20)
    for a in range(0, m.size - blk, blk):
        b = m[a:a + blk]
        if np.max(np.abs(b)) < thr:
            continue
        h = hashlib.md5(b.tobytes()).hexdigest()
        if h in seen:
            dups.append((round(seen[h] / SR, 3), round(a / SR, 3)))
        else:
            seen[h] = a
    return dups


def onset_periodicity(times, t0, t1, max_lag=4.0):
    """起音时刻序列的周期性：起音脉冲序列（10 ms 分辨率）的自相关在 0.1–4 s 的最大归一化峰值。
    规律的 ping 铺底会接近 1；泊松过程约 0.1–0.3。"""
    ts = [t for t in times if t0 <= t < t1]
    if len(ts) < 8:
        return None
    n = int((t1 - t0) * 100) + 1
    s = np.zeros(n)
    for t in ts:
        s[int((t - t0) * 100)] = 1.0
    s -= s.mean()
    ac = np.correlate(s, s, mode='full')[n - 1:]
    ac /= ac[0] + 1e-12
    lo, hi = 10, min(n - 1, int(max_lag * 100))
    return round(float(np.max(ac[lo:hi])), 3)


# ------------------------------------------------------------------ 图
def logspec_chunked(seg, hop, nper=4096, fl=None, fmin=25.0, fmax=20000.0, rows=360, block=256):
    """省内存的频谱图：分块取帧（float32）、FFT 后立刻只留对数频率轴上的 rows 行。
    返回 (帧中心时间, 频率行, dB 矩阵 rows × 帧数)。"""
    import scipy.fft as sfft
    seg = np.ascontiguousarray(seg, dtype=np.float32)
    if fl is None:
        fl = np.geomspace(fmin, fmax, rows)
    f = np.fft.rfftfreq(nper, 1 / SR)
    idx = np.clip(np.searchsorted(f, fl), 1, len(f) - 1)
    win = np.hanning(nper).astype(np.float32)
    nfr = max(1, (seg.size - nper) // hop + 1)
    out = np.empty((len(fl), nfr), dtype=np.float32)
    from numpy.lib.stride_tricks import as_strided
    for a in range(0, nfr, block):
        b = min(nfr, a + block)
        frames = as_strided(seg[a * hop:], shape=(b - a, nper), strides=(hop * 4, 4))
        X = sfft.rfft(frames * win, axis=1, workers=2)
        P = (X.real ** 2 + X.imag ** 2)[:, idx]
        out[:, a:b] = (10 * np.log10(P + 1e-18)).T
        del X, P
    t = (np.arange(nfr) * hop + nper / 2) / SR
    return t, fl, out


def _logspec(seg, hop, nper=4096):
    return logspec_chunked(seg, hop, nper)


def spectrogram_png(x, t0, t1, path, title, lines=(), marks=(), themes=(), cuts=(), nper=4096, drange=95):
    seg = np.mean(x[:, int(t0 * SR):int(t1 * SR)], axis=0, dtype=np.float32)
    hop = max(240, int((t1 - t0) * SR / 2400))
    t, fl, Sdb = _logspec(seg, hop, nper)
    vmax = np.percentile(Sdb, 99.9)
    fig, (ax, ax2) = plt.subplots(2, 1, figsize=(19, 8.5), gridspec_kw={'height_ratios': [4, 1.2]}, sharex=True)
    ax.imshow(Sdb, origin='lower', aspect='auto', cmap='magma', vmin=vmax - drange, vmax=vmax,
              extent=[t0 + t[0], t0 + t[-1], 0, len(fl)])
    ticks = [30, 50, 73, 110, 147, 220, 294, 440, 587, 880, 1760, 3520, 7000, 14000]
    ax.set_yticks([np.searchsorted(fl, v) for v in ticks])
    ax.set_yticklabels([str(v) for v in ticks])
    ax.set_ylabel('Hz')
    ax.set_title(title)
    for (lid, a, b) in lines:
        if b > t0 and a < t1:
            ax.axvspan(max(a, t0), min(b, t1), ymin=0.0, ymax=0.025, color='cyan', alpha=0.9)
            ax.text(max(a, t0), 10, lid, color='cyan', fontsize=7)
    for (tm, lab) in marks:
        if t0 <= tm <= t1:
            ax.axvline(tm, color='lime', lw=0.6, alpha=0.6)
            ax.text(tm, len(fl) - 12, lab, color='lime', fontsize=6, rotation=90, va='top')
    for (tm, lab) in themes:
        if t0 <= tm <= t1:
            ax.axvline(tm, color='white', lw=1.0, ls='--', alpha=0.9)
            ax.text(tm, len(fl) * 0.62, lab, color='white', fontsize=7, rotation=90)
    for tm in cuts:
        if t0 <= tm <= t1:
            ax.axvline(tm, color='red', lw=1.4)
            ax2.axvline(tm, color='red', lw=1.4)
    hopb = int(0.01 * SR)
    fr = seg[:len(seg) // hopb * hopb].reshape(-1, hopb)
    rms = 20 * np.log10(np.sqrt(np.mean(fr ** 2, axis=1)) + 1e-9)
    pk = 20 * np.log10(np.max(np.abs(fr), axis=1) + 1e-9)
    tt = t0 + np.arange(len(rms)) * 0.01
    ax2.plot(tt, pk, lw=0.5, color='orange', label='peak')
    ax2.plot(tt, rms, lw=0.7, color='k', label='rms')
    ax2.set_ylim(-80, 0)
    ax2.set_ylabel('dBFS')
    ax2.legend(loc='lower left', fontsize=7)
    ax2.set_xlabel('s（全片时间）')
    plt.tight_layout()
    plt.savefig(path, dpi=68)
    plt.close(fig)


def loudness_png(cum, dur, path, scenes, themes, cuts, lines):
    st = curve_lufs(cum, 0, dur, 3.0, 0.25)
    mo = curve_lufs(cum, 0, dur, 0.4, 0.1)
    fig, ax = plt.subplots(figsize=(20, 6))
    ax.plot([a for a, _ in mo], [v if np.isfinite(v) else -90 for _, v in mo], lw=0.4, color='0.6', label='瞬时 0.4 s')
    ax.plot([a for a, _ in st], [v if np.isfinite(v) else -90 for _, v in st], lw=1.2, color='C0', label='短期 3 s')
    for sid, a, b in scenes:
        ax.axvline(a, color='k', lw=0.6)
        ax.text(a + 0.5, -18, sid, fontsize=8)
    for (lid, a, b) in lines:
        ax.axvspan(a, b, ymin=0, ymax=0.03, color='cyan', alpha=0.8)
    for (tm, lab) in themes:
        ax.axvline(tm, color='green', lw=1.0, ls='--')
        ax.text(tm, -22, lab, fontsize=7, color='green', rotation=90)
    for tm in cuts:
        ax.axvline(tm, color='red', lw=1.2)
    ax.set_ylim(-80, -10)
    ax.set_xlim(0, dur)
    ax.set_ylabel('LUFS')
    ax.set_xlabel('s')
    ax.set_title('music.wav 响度曲线（BS.1770）  绿虚线 = 主题三次与临终四音  红线 = 硬切  青色 = 台词')
    ax.legend(loc='lower right')
    ax.grid(alpha=0.25)
    plt.tight_layout()
    plt.savefig(path, dpi=70)
    plt.close(fig)
