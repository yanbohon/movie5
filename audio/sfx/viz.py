"""频谱图 PNG（matplotlib，Agg 后端）。用于逐个检查音效与总混音。"""
from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from scipy import signal  # noqa: E402

from .dsp import SR, loudness_series, mono, stereo, to_db  # noqa: E402


def _edges(t):
    if len(t) < 2:
        return np.array([0.0, 1.0])
    dt = t[1] - t[0]
    return np.concatenate([t - dt / 2, [t[-1] + dt / 2]])


def _logspec(x, nper, hop, fmin=20.0, fmax=24000.0, nbins=320, chunk_frames=2048):
    """对数频率功率谱（粉红加权：每带功率 × fc/1kHz）。按帧分块做 FFT，
    结果与 scipy.signal.stft(boundary=None, padded=False) 一致，但全片也只占几十 MB。"""
    x = np.asarray(x, dtype=np.float64) if len(x) < SR * 60 else np.asarray(x)
    n = len(x)
    if n < nper:
        x = np.pad(x, (0, nper - n))
        n = nper
    n_frames = 1 + (n - nper) // hop
    f = np.fft.rfftfreq(nper, 1.0 / SR)
    win = signal.get_window("hann", nper)
    scale = 1.0 / win.sum()
    edges = np.geomspace(fmin, fmax, nbins + 1)
    idx = np.clip(np.searchsorted(f, edges), 0, len(f) - 1)
    lo = idx[:-1]
    hi = np.maximum(idx[1:], idx[:-1] + 1)
    out = np.zeros((nbins, n_frames))
    for f0 in range(0, n_frames, chunk_frames):
        f1 = min(n_frames, f0 + chunk_frames)
        seg = np.asarray(x[f0 * hop: (f1 - 1) * hop + nper], dtype=np.float64)
        frames = np.lib.stride_tricks.sliding_window_view(seg, nper)[::hop]
        S = np.fft.rfft(frames * win, axis=-1) * scale
        P = S.real ** 2 + S.imag ** 2  # (帧, 频点)
        c = np.concatenate([np.zeros((P.shape[0], 1)), np.cumsum(P, axis=1)], axis=1)
        out[:, f0:f1] = ((c[:, hi] - c[:, lo]) / (hi - lo)).T
    t = (np.arange(n_frames) * hop + nper / 2) / SR
    fc = np.sqrt(edges[:-1] * edges[1:])
    out *= (fc / 1000.0)[:, None]
    return edges, t, 10 * np.log10(out + 1e-20)


def _mono32(xs):
    """立体声 → 单声道；float32 输入就地相加（只开一份 N 长的数组）。"""
    if xs.dtype != np.float32:
        return mono(xs)
    m = np.add(xs[0], xs[1])
    m *= np.float32(0.5)
    return m


def _logimg(ax, t, edges, S, vmin, vmax, ylim=(25, 20000)):
    """对数频率频谱图：S 的各行在对数频率上等距（edges 为几何级数），直接 imshow 到 log10(Hz) 轴上，
    再把刻度标回 Hz。比 pcolormesh 省内存得多（全片几百万个格子）。"""
    le = np.log10(edges)
    dt = (t[1] - t[0]) if len(t) > 1 else 1.0
    ax.imshow(S, origin="lower", aspect="auto", cmap="magma", vmin=vmin, vmax=vmax, interpolation="nearest",
              extent=[t[0] - dt / 2, t[-1] + dt / 2, le[0], le[-1]])
    ticks = [f for f in (31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000) if ylim[0] <= f <= ylim[1]]
    ax.set_yticks(np.log10(ticks))
    ax.set_yticklabels([f"{f:g}" if f < 1000 else f"{f / 1000:g}k" for f in ticks])
    ax.set_ylim(np.log10(ylim[0]), np.log10(ylim[1]))


def octave_bands(x, centers=(31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000)):
    """倍频程能量（dB，相对最大带）。"""
    m = mono(stereo(x))
    f, P = signal.welch(m, fs=SR, nperseg=min(len(m), 16384))
    out = []
    for c in centers:
        sel = (f >= c / np.sqrt(2)) & (f < c * np.sqrt(2))
        out.append(10 * np.log10(P[sel].sum() * (f[1] - f[0]) + 1e-20))
    out = np.array(out)
    return dict(zip(centers, np.round(out - out.max(), 1)))


def spectrogram_png(x, path, title="", db_range=90, markers=None):
    """单个音效：上面波形包络（dBFS 峰值），下面对数频率频谱图。"""
    xs = stereo(x)
    m = mono(xs)
    dur = len(m) / SR
    nper = 1024 if dur < 4 else 2048
    hop = nper // 4 if dur < 20 else nper // 2
    if len(m) < nper * 2:
        m = np.pad(m, (0, nper * 2 - len(m)))
    edges, t, S = _logspec(m, nper, hop)
    vmax = S.max()
    fig, (a0, a1) = plt.subplots(2, 1, figsize=(11, 5.2), gridspec_kw={"height_ratios": [1, 3]}, sharex=True)
    hop_env = max(1, int(SR * 0.005))
    pk = np.maximum(np.abs(xs[0]), np.abs(xs[1]))
    nb = len(pk) // hop_env
    env = pk[: nb * hop_env].reshape(nb, hop_env).max(axis=1) if nb > 0 else pk
    te = (np.arange(len(env)) + 0.5) * hop_env / SR
    a0.plot(te, to_db(env), lw=0.7, color="#1f77b4", label="peak")
    if dur >= 1.0:
        tl, ll = loudness_series(xs, 0.4, 0.05)
        a0.plot(tl, ll, lw=0.9, color="#d62728", label="momentary LUFS")
    a0.set_ylim(-80, 3)
    a0.set_ylabel("dB")
    a0.grid(alpha=0.3)
    a0.legend(loc="upper right", fontsize=7)
    a0.set_title(f"{title}   dur={dur:.2f}s  peak={to_db(pk.max()):.1f} dBFS   (spectrogram pink-weighted)")
    _logimg(a1, t, edges, S, vmax - db_range, vmax, ylim=(20, 24000))
    a1.set_ylabel("Hz")
    a1.set_xlabel("s")
    if markers:
        for tm in markers:
            a1.axvline(tm, color="cyan", lw=0.5, alpha=0.6)
    fig.tight_layout()
    fig.savefig(path, dpi=90)
    plt.close(fig)


def mix_overview_png(mix, stems: dict, path, scenes=(), lines=(), title="", width_px=2600):
    """总混音：频谱图 + 各分轨短时响度曲线，标出场景边界与台词位置。"""
    xs = stereo(mix)
    m = _mono32(xs)
    dur = len(m) / SR
    edges, t, S = _logspec(m, 4096, 2048, nbins=240)
    del m
    vmax = S.max()
    fig, (a0, a1) = plt.subplots(2, 1, figsize=(width_px / 100, 9), gridspec_kw={"height_ratios": [2.2, 1.3]}, sharex=True)
    _logimg(a0, t, edges, S, vmax - 85, vmax)
    a0.set_ylabel("Hz")
    a0.set_title(title)
    colors = {"mix": "black", "dialogue": "#1f77b4", "music": "#2ca02c", "sfx": "#d62728", "amb": "#9467bd"}
    tl, ll = loudness_series(xs, 3.0, 0.25)
    a1.plot(tl, ll, color="black", lw=1.2, label="mix (short-term)")
    for k, v in stems.items():
        if v is None or not np.any(v):
            continue
        tk, lk = loudness_series(v, 3.0, 0.25)
        a1.plot(tk, lk, color=colors.get(k, None), lw=0.8, label=k)
    a1.set_ylim(-60, -5)
    a1.set_ylabel("LUFS (3 s)")
    a1.set_xlabel("s")
    a1.grid(alpha=0.3)
    a1.legend(loc="lower right", fontsize=8, ncol=5)
    for sc in scenes:
        for ax in (a0, a1):
            ax.axvline(sc["start"], color="white" if ax is a0 else "gray", lw=0.8, alpha=0.8)
        a0.text(sc["start"] + 0.5, np.log10(17000), sc["id"], color="white", fontsize=7, va="top")
    for ln in lines:
        a1.axvspan(ln[0], ln[1], color="#1f77b4", alpha=0.08)
    a1.set_xlim(0, dur)
    fig.tight_layout()
    fig.savefig(path, dpi=100)
    plt.close(fig)


def mix_rows_png(mix, path, rows=4, scenes=(), lines=(), title=""):
    """把全片分成几行放大显示，便于逐段检查。"""
    xs = stereo(mix)
    m = _mono32(xs)
    dur = len(m) / SR
    seg = dur / rows
    fig, axes = plt.subplots(rows, 1, figsize=(26, 3.2 * rows))
    edges, t, S = _logspec(m, 2048, 1024, nbins=200)
    del m
    vmax = S.max()
    for r in range(rows):
        ax = axes[r]
        a, b = r * seg, (r + 1) * seg
        sel = (t >= a) & (t <= b)
        _logimg(ax, t[sel], edges, S[:, sel], vmax - 85, vmax)
        ax.set_xlim(a, b)
        for sc in scenes:
            if a <= sc["start"] <= b:
                ax.axvline(sc["start"], color="white", lw=1.0)
                ax.text(sc["start"] + 0.3, np.log10(15000), sc["id"], color="white", fontsize=8, va="top")
        for ln in lines:
            if ln[1] >= a and ln[0] <= b:
                ax.axvspan(max(a, ln[0]), min(b, ln[1]), ymin=0.0, ymax=0.03, color="cyan", alpha=0.9)
                ax.text(max(a, ln[0]), np.log10(30), ln[2], color="cyan", fontsize=7)
    axes[0].set_title(title)
    fig.tight_layout()
    fig.savefig(path, dpi=80)
    plt.close(fig)
