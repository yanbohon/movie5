"""古琴 20 秒独奏 demo 与物理模型的客观自检（非谐性、泛音分音、滑音轨迹、音准、衰减）。"""
import math
import os
import numpy as np
import soundfile as sf
from scipy import signal
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from mus_dsp import SR, make_ir, convolve_clip
from mus_theme import hz, nm
import mus_guqin as Q
import mus_qa  # noqa: F401  （中文字体设置）

DEMO_NOTES = [
    (0.30, '撮 D2+D3（二弦、七弦散音）'), (1.60, 'A3 按音：绰入 + 吟'), (2.85, 'G3：走手下滑再弹'),
    (3.95, 'F3：注入 + 猱'), (5.60, 'D3 散音'), (7.00, '泛音段：D5 A4 G4 C5 D5 A4'), (10.8, 'C4 上 D4（走手）+ 吟'),
    (12.5, 'A3 下 G3 下 F3（长走手）'), (14.7, '滚：七弦到一弦'), (15.9, 'D3 散音'), (16.6, 'A3 猱'),
    (18.2, '撮 D2+A2')]


def demo_phrase():
    q = Q.QinPhrase(seed=900)
    q.cuo(0.30, [(2, None), (7, None)], 0.62)
    q.note(1.60, 5, 'A3', 0.58, 'nail', approach=('chuo', 110, 0.2), orn=[('yin', 0.4, 1.0, 13, 4.4)])
    q.note(2.85, 5, 'G3', 0.52, 'flesh', approach=('slide', 2.55), orn=[('yin', 0.35, 0.8, 9, 4.8)])
    q.note(3.95, 3, 'F3', 0.54, 'flesh', approach=('zhu', 95, 0.22), orn=[('nao', 0.45, 1.5, 38, 2.7)])
    q.note(5.60, 7, None, 0.52, 'flesh')
    for dt, s, hui, v in ((7.0, 7, 4, 0.46), (7.5, 7, 5, 0.40), (8.0, 4, 4, 0.40), (8.5, 3, 2, 0.36),
                          (9.05, 2, 1, 0.34), (9.65, 2, 2, 0.32)):
        q.harm(dt, s, hui, v)
    q.note(10.8, 6, 'C4', 0.50, 'nail', orn=[('go', 0.35, 'D4', 0.30), ('yin', 0.75, 1.2, 11, 4.6)])
    q.note(12.5, 5, 'A3', 0.52, 'flesh', orn=[('go', 0.55, 'G3', 0.40), ('go', 1.25, 'F3', 0.45)])
    q.sweep(14.7, [7, 6, 5, 4, 3, 2, 1], 0.9, vel=0.40, curve=1.1)
    q.note(15.9, 7, None, 0.50, 'flesh')
    q.note(16.6, 5, 'A3', 0.50, 'nail', orn=[('nao', 0.4, 1.4, 40, 2.6)])
    q.cuo(18.2, [(2, None), (5, None)], 0.55)
    q.damp_all(19.55, 0.35)
    return q


def render_demo(out_wav, out_png, out_png_zoom=None):
    q = demo_phrase()
    t0, x = q.render(tail=1.5, t_start=0.0, t_end=19.9)
    x = x[:, :int(20.0 * SR)].astype(np.float64)
    if x.shape[1] < int(20.0 * SR):
        x = np.pad(x, ((0, 0), (0, int(20.0 * SR) - x.shape[1])))
    ir = make_ir(t60=2.4, pre=0.02, hf_ratio=0.42, lf_ratio=1.2, er_gain=0.5, seed=202)
    wet = convolve_clip(x, ir)[:, :x.shape[1]]
    y = x + 0.26 * wet
    fo = int(0.25 * SR)
    y[:, -fo:] *= np.linspace(1, 0, fo) ** 2
    y *= 10 ** (-3.0 / 20) / np.max(np.abs(y))
    sf.write(out_wav, y.T.astype(np.float32), SR, subtype='PCM_24')
    # 频谱图（线性-对数，细频率分辨率：看得见分音列、滑音轨迹、泛音只剩偶次/三倍次分音）
    m = np.mean(y, axis=0)
    # 对数频率轴（55–5000 Hz，480 行），分块计算，用 imshow 画（省内存）
    t, fl, Sd = mus_qa.logspec_chunked(m, 240, 8192, fmin=55, fmax=5000, rows=480)
    vmax = np.percentile(Sd, 99.95)
    fig, ax = plt.subplots(figsize=(20, 9))
    ax.imshow(Sd, origin='lower', aspect='auto', cmap='magma', vmin=vmax - 85, vmax=vmax,
              extent=[t[0], t[-1], 0, len(fl)])
    ticks = [65, 73, 87, 98, 110, 131, 147, 175, 196, 220, 262, 294, 349, 392, 440, 587, 880, 1175, 1760, 2640, 3520]
    ax.set_yticks([np.searchsorted(fl, v) for v in ticks])
    ax.set_yticklabels([str(v) for v in ticks])
    for (tt, lab) in DEMO_NOTES:
        ax.axvline(tt, color='w', lw=0.5, alpha=0.5)
        ax.text(tt + 0.05, len(fl) - 5, lab, color='w', fontsize=8, rotation=90, va='top')
    ax.set_xlabel('s')
    ax.set_ylabel('Hz（对数）')
    ax.set_title('古琴物理模型独奏 demo（20 s）频谱图：分音列、绰注吟猱的滑音轨迹、泛音只留节点分音、滚拂')
    plt.tight_layout()
    plt.savefig(out_png, dpi=66)
    plt.close(fig)
    if out_png_zoom:
        # 放大：绰注吟猱（1.4–5.6 s）与泛音段（6.8–10.4 s），线性频率 100–1400 Hz
        fig, axs = plt.subplots(1, 2, figsize=(20, 7))
        for ax, (a, b, ttl) in zip(axs, ((1.4, 5.6, 'A3 绰+吟 / G3 走手 / F3 注+猱'),
                                         (6.8, 10.4, '泛音：D5(七弦四徽) A4(五徽) G4 C5 D5 A4'))):
            ia, ib = int(a * SR), int(b * SR)
            fl2 = np.linspace(100, 1400, 700)
            t2, _, S2d = mus_qa.logspec_chunked(m[ia:ib], 240, 16384, fl=fl2)
            vm = np.percentile(S2d, 99.95)
            ax.imshow(S2d, origin='lower', aspect='auto', cmap='magma', vmin=vm - 80, vmax=vm,
                      extent=[a + t2[0], a + t2[-1], fl2[0], fl2[-1]])
            ax.set_title(ttl)
            ax.set_xlabel('s')
        axs[0].set_ylabel('Hz（线性）')
        plt.tight_layout()
        plt.savefig(out_png_zoom, dpi=66)
        plt.close(fig)
    return {'duration_s': 20.0, 'techniques': [lab for _, lab in DEMO_NOTES]}


def _peaks(x, a, b, f0, kmax, B=0.0, search=0.25):
    seg = x[int(a * SR):int(b * SR)].astype(np.float64)
    n = seg.size
    X = np.abs(np.fft.rfft(seg * np.hanning(n), 8 * n))
    fr = np.fft.rfftfreq(8 * n, 1 / SR)
    out = []
    for k in range(1, kmax + 1):
        fg = k * f0 * math.sqrt(1 + B * k * k)
        m = (fr > fg - search * f0) & (fr < fg + search * f0)
        if not np.any(m):
            continue
        i = int(np.argmax(np.where(m, X, 0)))
        out.append((k, fr[i], 20 * math.log10(X[i] + 1e-15)))
    return out


def analyze():
    """物理模型自检：散音非谐性、按音音准、泛音分音、衰减时间。返回 dict（写进质检报告）。"""
    rep = {}
    # 1) 一弦散音 C2：分音频率 -> 拟合非谐系数 B
    q = Q.QinPhrase(seed=950)
    q.note(1.0, 1, None, 0.6)
    t0, x = q.render(tail=6.0)
    m = x[0]
    f_open = hz('C2') * 2 ** (q.tune_err[0] / 1200)
    pk = _peaks(m, 1.3 - t0, 4.3 - t0, f_open, 30, Q.B_OPEN[0])
    ks = np.array([p[0] for p in pk], dtype=float)
    fs = np.array([p[1] for p in pk])
    f1 = fs[0]
    Bfit = float(np.polyfit(ks ** 2, (fs / (ks * f1)) ** 2 - 1, 1)[0])
    rep['open_C2'] = {
        'f0_measured_hz': round(float(f1), 3), 'f0_target_hz': round(f_open, 3),
        'f0_error_cents': round(1200 * math.log2(f1 / f_open), 2),
        'inharmonicity_B_fit': float('%.3g' % Bfit), 'B_target': float(Q.B_OPEN[0]),
        'partial_stretch_cents': {int(k): round(1200 * math.log2(f / (k * f1)), 1) for k, f, _ in pk if k in (5, 10, 15, 20, 25)},
    }
    # 衰减：基频与 10 次分音的 T60（STFT 跟踪斜率）
    f_, t_, S = signal.stft(m.astype(np.float64), SR, nperseg=16384, noverlap=16384 - 2400)
    t_ = t_ + t0
    t60 = {}
    for k in (1, 2, 4, 10, 20):
        fk = k * f1
        i = int(np.argmin(np.abs(f_ - fk)))
        mag = 20 * np.log10(np.max(np.abs(S[max(0, i - 2):i + 3]), axis=0) + 1e-15)
        sel = (t_ > 1.4) & (t_ < 5.0)
        sl = np.polyfit(t_[sel], mag[sel], 1)[0]
        t60[f'k{k}'] = round(-60 / sl, 2) if sl < 0 else None
    rep['open_C2']['T60_s'] = t60
    # 2) 七弦七徽泛音（D4）：奇次分音（D3、A4）应被节点吸收
    q = Q.QinPhrase(seed=951)
    q.harm(1.0, 7, 7, 0.5)
    t0, x = q.render(tail=4.0)
    fD3 = hz('D3') * 2 ** (q.tune_err[6] / 1200)
    pk = _peaks(x[0], 1.25 - t0, 3.0 - t0, fD3, 8, Q.B_OPEN[6], search=0.12)
    lv = {k: l for k, f, l in pk}
    ref = lv.get(2, 0)
    rep['harmonic_hui7_on_D3'] = {'partial_levels_db_rel_2nd': {int(k): round(l - ref, 1) for k, l in lv.items()},
                                  'odd_partials_suppressed_db': round(ref - max(lv.get(1, -300), lv.get(3, -300), lv.get(5, -300)), 1)}
    # 3) 五徽泛音（1/3，A4）：只剩 3、6、9 次
    q = Q.QinPhrase(seed=952)
    q.harm(1.0, 7, 5, 0.5)
    t0, x = q.render(tail=4.0)
    pk = _peaks(x[0], 1.25 - t0, 3.0 - t0, fD3, 9, Q.B_OPEN[6], search=0.12)
    lv = {k: l for k, f, l in pk}
    ref = lv.get(3, 0)
    rep['harmonic_hui5_on_D3'] = {'partial_levels_db_rel_3rd': {int(k): round(l - ref, 1) for k, l in lv.items()},
                                  'non_multiples_of_3_suppressed_db': round(ref - max(lv.get(k, -300) for k in (1, 2, 4, 5)), 1)}
    # 4) 按音音准（三分损益律）：A3（五弦七徽）、F3（三弦七徽）、C4（六弦七徽）
    acc = {}
    for s, p_ in ((5, 'A3'), (3, 'F3'), (6, 'C4'), (7, 'A3')):
        q = Q.QinPhrase(seed=953)
        q.note(1.0, s, p_, 0.5)
        t0, x = q.render(tail=2.0)
        tgt = hz(p_) * 2 ** (q.tune_err[s - 1] / 1200)
        pk = _peaks(x[0], 1.2 - t0, 2.2 - t0, tgt, 1, search=0.05)
        acc[f'{s}弦 {p_}'] = round(1200 * math.log2(pk[0][1] / tgt), 2)
    rep['stopped_pitch_error_cents'] = acc
    return rep
