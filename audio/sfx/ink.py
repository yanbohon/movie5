"""2D 水墨段落（片名、长卷、尾声）的纸与笔：毛笔擦纸、宣纸、长卷掠过、陨石、尺子画线、水滴与墨晕。

"记忆"的听感：干净、近、几乎没有空间（paper_room 很小很干）。
每个函数返回 dict(audio, pre, events, norm)。同步点见各函数说明。
"""
from __future__ import annotations

import numpy as np

from .dsp import (SR, TWO_PI, add_at, bp, brown, ctrl_noise, curve, dbg, env_ad, eq, grain_bank, hp, impulses, ir_preset, lp,
                  modes, ns, pan, pan_curve, pink, poisson_times, resonate, reverb, sine_sweep, smoothstep, softclip,
                  stereo, sweep_bp, tvec, white, widen, width)


def _nz(x):
    return x / (np.max(np.abs(x)) + 1e-12)


def _sd(x):
    return x / (np.std(x) + 1e-12)


def _fiber(n, rng, rate=320.0, depth=0.65):
    """宣纸纤维颗粒：低通整流噪声 → 0..1 的粗糙调制。"""
    g = np.abs(lp(white(n, rng), rate, order=2))
    g = g / (np.mean(g) + 1e-9)
    return (1 - depth) + depth * np.clip(g, 0, 3) / 1.8


def _stroke_core(n, dur, rng, pressure=0.8, dry=0.25, size=1.0, speed_shape=None, lift=0.05, press=0.012):
    """一笔的"擦纸"主体（单声道）：按压-拖行-提笔的包络 × 纤维颗粒 × 两段摩擦噪声（按压重=暗，速度快=亮）+ 飞白噼啪。"""
    t = tvec(n)
    u = np.clip(t / max(dur, 1e-3), 0, 1)
    env = smoothstep(t / press) * smoothstep((dur - t) / max(min(lift, dur * 0.4), 0.005)) * (t < dur)
    sp = np.sin(np.pi * u) ** 0.6 if speed_shape is None else speed_shape
    k = size ** -0.35
    body = bp(white(n, rng), 450 * k, 2600 * k, order=2)
    bright = bp(white(n, rng), 2400 * k, 8500, order=2)
    fib = _fiber(n, rng)
    fr = (_sd(body) * (0.55 + 0.45 * pressure) + 0.8 * _sd(bright) * (0.3 + 0.7 * sp)) * fib * env * pressure
    if dry > 0:
        cr_t = poisson_times(dry * 420 * sp * env + 1e-6, rng, dur)
        cx = impulses(n, cr_t, rng.lognormal(-0.2, 0.6, len(cr_t)) * rng.choice([-1, 1], len(cr_t)))
        cr = resonate(cx, rng.uniform(2800, 8000, 3), rng.uniform(0.0001, 0.00025, 3), [1, 0.8, 0.6])
        fr += 0.7 * dry * _sd(cr) * np.std(fr[env > 0.5]) if np.any(env > 0.5) else 0.0
    return fr


def brush_stroke(seed=0, dur=0.3, pressure=0.8, dry=0.25, size=1.0, wet=0.06, pan_pos=0.0):
    """毛笔一笔：笔尖落纸的软"嗒"（纸下毡垫吸掉高频）→ 拖行摩擦（纤维颗粒、按压与速度变化、飞白）→ 提笔一点上扬的轻扫。
    同步点 = 落纸（t=0）。"""
    rng = np.random.default_rng(seed)
    dur = float(max(0.04, dur))
    n = ns(dur + 0.3)
    y = _stroke_core(n, dur, rng, pressure, dry, size)
    k = impulses(n, [0.0], [1.0])
    tip = resonate(lp(k, 1800, order=2), [230 * size ** -0.5, 540 * size ** -0.4], [0.010, 0.006], [1.0, 0.5])
    y += 0.35 * pressure * _nz(tip) * np.max(np.abs(y) + 1e-9)
    m = ns(0.04)
    flick = bp(white(m, rng), 3000, 8000, order=2) * np.hanning(m)
    add_at(y, 0.25 * _nz(flick) * np.max(np.abs(y)) * pressure, ns(max(0.0, dur - 0.025)))
    y = lp(y, 7500, order=2)
    o = pan(y, pan_pos)
    return dict(audio=reverb(o, ir_preset("paper_room"), wet=wet), pre=0.0)


def light_stroke(seed=0, dur=0.28, swell=1.0, pan_pos=0.0):
    """片名：光在黑水里写字的一笔 —— 柔和的"笔毛擦过"（更软、更空气、没有落纸闷响）+ 极低的光感 swell（无音高的暖暗噪声涨落 + 一点空气）。
    同步点 = 笔画起笔（t=0）。"""
    rng = np.random.default_rng(seed)
    dur = float(max(0.06, dur))
    n = ns(dur + 1.4)
    t = tvec(n)
    y = _stroke_core(n, dur, rng, pressure=0.6, dry=0.08, size=0.8, press=0.018, lift=0.08)
    y = lp(y, 7000, order=2)
    se = smoothstep(t / max(dur * 0.9, 0.05)) * np.exp(-np.maximum(t - dur, 0) / 0.55) * np.clip((n / SR - t) / 0.3, 0, 1)
    sw = bp(pink(n, rng), 110, 650, order=2)
    air = bp(white(n, rng), 4000, 9000, order=2)
    s = (_sd(sw) + 0.08 * _sd(air)) * se
    o = pan(y, pan_pos) + 0.55 * swell * widen(s, 0.8, seed) * np.std(y[: ns(dur)]) / (np.std(s) + 1e-9)
    return dict(audio=reverb(o, ir_preset("plate"), wet=0.2), pre=0.0)


def grain_dissolve(seed=0, dur=2.8, drift=-0.5):
    """片名的光散成颗粒、被水流带走：一阵细碎的"沙沙"（极细的颗粒，随机、渐稀、声像散开并漂向一侧），无音高。同步点 = 散开（t=0）。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.6)
    t = tvec(n)
    e = smoothstep(t / 0.06) * np.exp(-t / (0.38 * dur))
    rate = 1400 * e + 1e-6
    times = poisson_times(rate, rng, dur)
    out = np.zeros((2, n))
    spread = 0.2 + 0.8 * smoothstep(times / dur)
    pans = np.clip(rng.uniform(-1, 1, len(times)) * spread + drift * smoothstep(times / dur), -1, 1)
    for c, sgn in ((0, -1), (1, 1)):
        th = (pans + 1) * np.pi / 4
        g = np.cos(th) if c == 0 else np.sin(th)
        x = impulses(n, times, rng.lognormal(-0.4, 0.7, len(times)) * rng.choice([-1, 1], len(times)) * g)
        out[c] = resonate(x, [3600, 5600, 8200], [0.00012, 0.0001, 0.00008], [1, 0.8, 0.6]) + 0.4 * hp(x, 2500, order=1)
    hiss = bp(white(n, rng), 3000, 9000, order=2) * e
    out = out / (np.std(out) + 1e-9) + 0.3 * widen(_sd(hiss), 0.9, seed)
    out = lp(out, 10000, order=2)
    out = eq(out, ("lowshelf", 800, 0.7, -3.0))
    return dict(audio=reverb(out, ir_preset("plate_short"), wet=0.2), pre=0.0, norm="lufs")


def paper_breath(seed=0, dur=1.6, body=1.0):
    """宣纸淡入 / 纸轻轻铺开：很轻的纸面沙沙 + 一点纸体的"呼"。同步点 = t=0。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.4)
    t = tvec(n)
    # 第一下"纸落定"从 t=0 起（50 ms 起来，同步点就是它），之后再有两三下随机的轻动
    motion = 0.9 * smoothstep(t / 0.05) * np.exp(-np.maximum(t - 0.05, 0) / 0.3)
    for _ in range(int(rng.integers(2, 4))):
        c = rng.uniform(0.35, dur * 0.8)
        w = rng.uniform(0.2, 0.5)
        motion += rng.uniform(0.4, 0.8) * np.exp(-0.5 * ((t - c) / (w / 2.5)) ** 2) * smoothstep(t / 0.2)
    motion = np.clip(motion, 0, 1.1)
    ct = poisson_times(240 * motion + 1e-6, rng, dur)
    x = impulses(n, ct, rng.lognormal(0, 0.8, len(ct)) * rng.choice([-1, 1], len(ct)))
    cr = resonate(x, rng.uniform(1800, 6500, 5), rng.uniform(0.0006, 0.0015, 5), rng.uniform(0.4, 1.0, 5))
    sw = bp(white(n, rng), 600, 4500, order=2) * motion ** 1.5
    fw = lp(white(n, rng), 350, order=2) * motion
    y = _sd(cr) * 0.6 + 0.8 * _sd(sw) * np.std(cr) / (np.std(cr) + 1e-9) + 0.5 * body * _sd(fw)
    y *= smoothstep(t / 0.02)
    o = widen(y, 0.5, seed)
    return dict(audio=reverb(o, ir_preset("paper_room"), wet=0.08), pre=0.0)


def scroll_rush(seed=0, dur=1.8):
    """长卷飞速掠过：风（带通 300→2600→700 Hz 扫频）+ 纸边颤动（1–5 kHz × 25–35 Hz 抖动）+ 墨色拖影的"呼"，
    结尾停在长卷最右端（纸面一顿）。同步点 = 起步（t=0）。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.8)
    t = tvec(n)
    tp = 0.55 * dur
    env = np.where(t < tp, 0.35 * smoothstep(t / 0.05) + 0.65 * smoothstep(t / tp) ** 2, np.exp(-(t - tp) / (0.3 * dur)))
    env *= np.clip((dur + 0.6 - t) / 0.4, 0, 1)
    fc = curve([(0, 300), (tp, 2600), (dur, 700), (dur + 0.8, 500)])
    air = sweep_bp(0.6 * pink(n, rng) + 0.4 * white(n, rng), fc, lambda x: 0.8, block=128)
    flut = bp(white(n, rng), 1000, 5000, order=2) * (0.5 + 0.5 * np.sin(TWO_PI * np.cumsum(28 + 6 * ctrl_noise(n, rng, 3.0)) / SR))
    body = lp(pink(n, rng), 300, order=2)
    y = (_sd(air) + 0.35 * _sd(flut) + 0.4 * _sd(body)) * env
    k = impulses(n, [dur], [1.0])
    settle = resonate(lp(k, 2500, order=2), [240, 430], [0.012, 0.008], [0.6, 0.4])
    y += 0.25 * _nz(settle) * np.max(np.abs(y))
    out = pan_curve(y, np.linspace(-0.6, 0.6, n))
    return dict(audio=reverb(out, ir_preset("paper_room"), wet=0.1), pre=0.0)


def asteroid_flight(seed=0, dur=1.15, pan_from=0.65, pan_to=-0.25):
    """朱砂陨石划过：带火焰气流的呼啸（湍流调制的带通噪声 + 稀疏噼啪 + 低频轰），越来越近，dur 处交给落地。同步点 = 起始（t=0）。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.25)
    t = tvec(n)
    e = smoothstep(t / 0.015) * (0.35 + 0.65 * smoothstep(t / dur) ** 1.5) * np.clip((dur + 0.15 - t) / 0.15, 0, 1)
    fc = curve([(0, 500), (dur * 0.7, 1500), (dur, 900), (dur + 0.25, 700)])
    roar = sweep_bp(pink(n, rng), fc, lambda x: 0.7, block=128) * np.clip(1 + 0.5 * ctrl_noise(n, rng, 18.0), 0.5, 2.0)
    ct = poisson_times(70 * e + 1e-6, rng, dur)
    cx = impulses(n, ct, rng.lognormal(-0.3, 0.6, len(ct)))
    crk = resonate(cx, rng.uniform(1500, 5000, 3), [0.0006, 0.0005, 0.0004], [1, 0.7, 0.5])
    low = lp(brown(n, rng), 120, order=2)
    y = (_sd(roar) + 0.25 * _sd(crk) + 0.6 * _sd(low)) * e
    out = pan_curve(y, np.linspace(pan_from, pan_to, n))
    return dict(audio=reverb(out, ir_preset("paper_room"), wet=0.12), pre=0.0)


def asteroid_impact(seed=0, echo=1.0):
    """陨石落地：沉重但克制的低频冲击（58→26 Hz 下滑 + 低通噪声闷击 + 一点中低频体），没有碎片；远处回响（两次延迟、越来越暗）+ 暗长尾。
    同步点 = 落地（t=0）。"""
    rng = np.random.default_rng(seed)
    n = ns(4.5)
    t = tvec(n)
    y = sine_sweep(n, 26 + 32 * np.exp(-t / 0.09)) * env_ad(n, 0.004, 0.38)
    y += 0.6 * _nz(lp(white(n, rng), 150, order=4) * env_ad(n, 0.003, 0.11))
    y += 0.25 * _nz(resonate(lp(impulses(n, [0.0], [1.0]), 600, order=2), [95, 160, 230], [0.06, 0.04, 0.03], [1, 0.6, 0.4]))
    y = softclip(_nz(y) * 1.3, 1.4)
    out = np.vstack([y, y])
    for d, g, cut in ((0.46, -9.0, 380.0), (0.97, -15.0, 260.0)):
        ech = np.zeros(n)
        i = ns(d)
        ech[i:] = lp(y[: n - i], cut, order=2)
        out += pan(ech * dbg(g), rng.uniform(-0.6, 0.6))
    out = reverb(out, ir_preset("valley"), wet=0.35, pre_lp=900)
    return dict(audio=out, pre=0.0)


def ruler_line(seed=0, scrape=0.45):
    """dam_line：全卷唯一的硬声音。t=0 一声沉重的"咚"（木尺拍在纸/桌上：木模态 + 桌面低频 + 硬边缘的咔），
    紧接一段硬而干的刮擦（笔沿尺边：粗糙宽带摩擦 + 细小的黏滑颗粒），最后提笔。几乎不加空间。同步点 = "咚"（t=0）。"""
    rng = np.random.default_rng(seed)
    n = ns(scrape + 1.2)
    t = tvec(n)
    k = impulses(n, [0.0], [1.0])
    wood = resonate(lp(k + 0.3 * impulses(n, [0.0015], [1.0]), 3000, order=2), [180, 320, 540, 910],
                    [0.06, 0.04, 0.03, 0.02], [1.0, 0.8, 0.55, 0.35])
    table = resonate(lp(k, 400, order=2), [68.0, 112.0], [0.09, 0.06], [1.0, 0.7])
    click = resonate(hp(k, 1500, order=1), [1900, 2900, 4100], [0.0025, 0.002, 0.0015], [1, 0.8, 0.6])
    thud = 1.0 * _nz(wood) + 0.9 * _nz(table) + 0.45 * _nz(click)
    s0, s1 = 0.02, 0.02 + scrape
    se = smoothstep((t - s0) / 0.01) * smoothstep((s1 - t) / 0.04) * (t > s0) * (t < s1)
    fric = bp(white(n, rng), 900, 8000, order=2)
    ss_t = poisson_times(np.full(n, 230.0), rng, n / SR)
    ssx = impulses(n, ss_t, rng.lognormal(0, 0.4, len(ss_t)))
    grit = resonate(ssx, [2300, 3700, 5600], [0.0003, 0.00025, 0.0002], [1, 0.8, 0.6])
    scr = (_sd(fric) + 0.9 * _sd(grit)) * se * (0.8 + 0.2 * np.sin(TWO_PI * 7 * t))
    scr = lp(scr, 11000, order=2)
    y = thud + 0.28 * scr * np.max(np.abs(thud)) / (np.max(np.abs(scr)) + 1e-9)
    return dict(audio=reverb(pan(y, 0.0), ir_preset("paper_room"), wet=0.1), pre=0.0)


def fish_sigh(seed=0, dur=0.9):
    """坝后一条鱼淡掉：非常轻的、叹息般的气声（带通噪声 1400→600 Hz 下沉），近乎听不见。同步点 = t=0。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.3)
    t = tvec(n)
    e = smoothstep(t / (0.3 * dur)) * np.exp(-np.maximum(t - 0.3 * dur, 0) / (0.3 * dur)) * np.clip((dur + 0.3 - t) / 0.2, 0, 1)
    fc = curve([(0, 1400), (dur, 600), (dur + 0.3, 550)])
    y = sweep_bp(pink(n, rng), fc, lambda x: 1.2, block=128) * e
    y += 0.12 * _sd(bp(white(n, rng), 2000, 5000, order=2)) * np.std(y) * e
    o = pan(y, rng.uniform(-0.3, 0.3))
    # 叹息是慢慢起来的：把"听得见"（包络到峰值 -30 dB）的那一刻对到画面上
    pre = float(np.argmax(e >= e.max() * 10 ** (-30 / 20))) / SR
    return dict(audio=reverb(o, ir_preset("paper_room"), wet=0.15), pre=pre)


def small_brush(seed=0, dur=1.3, rate=7.0, pressure=0.45):
    """小楷：一串很小很快的笔画（40–120 ms），比大字轻、亮。同步点 = 第一笔。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.4)
    y = np.zeros(n)
    t = 0.0
    ev = []
    while t < dur:
        d = rng.uniform(0.04, 0.12)
        m = ns(d + 0.1)
        s = _stroke_core(m, d, rng, pressure=pressure * rng.uniform(0.7, 1.1), dry=0.15, size=0.45, press=0.006, lift=0.02)
        add_at(y, s, ns(t))
        ev.append(round(t, 4))
        t += d + rng.exponential(1.0 / rate)
    o = pan(y, rng.uniform(-0.15, 0.15))
    return dict(audio=reverb(o, ir_preset("paper_room"), wet=0.06), pre=0.0, events=ev)


def drop_on_paper(seed=0):
    """一滴水落在"鲔"字上：湿的轻"嗒"（纸面 + 纸下毡垫）+ 很小的溅开 + 一点吸进纸里的"嘶"。不是空心的"咚"水滴声。同步点 = 落下（t=0）。"""
    rng = np.random.default_rng(seed)
    n = ns(1.2)
    t = tvec(n)
    k = impulses(n, [0.0], [1.0])
    tup = resonate(lp(k, 2200, order=2), [260, 470, 820], [0.012, 0.007, 0.004], [1.0, 0.6, 0.3])
    sp_t = np.sort(rng.uniform(0.0, 0.025, int(rng.integers(6, 12))))
    spx = impulses(n, sp_t, rng.lognormal(-1.0, 0.5, len(sp_t)))
    splat = resonate(spx, rng.uniform(2000, 6000, 3), [0.00025, 0.0002, 0.00015], [1, 0.8, 0.6])
    soak = bp(white(n, rng), 1000, 4000, order=2) * smoothstep((t - 0.01) / 0.03) * np.exp(-t / 0.25) * (t > 0.01)
    y = _nz(tup) + 0.35 * _nz(splat) + 0.08 * _nz(soak)
    return dict(audio=reverb(pan(y, 0.05), ir_preset("paper_room"), wet=0.08), pre=0.0)


def ink_bleed(seed=0, dur=5.5, wash_from=1.2, wash_to=4.6):
    """墨被水晕开：纤维吸水的极细湿噼啪（由密到疏）+ 很软的湿"嘶" + 中段一点水在纸上漫过冲走的轻流动。同步点 = t=0。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.6)
    t = tvec(n)
    e = smoothstep(t / 0.35) * np.clip((dur - t) / 1.2, 0, 1)
    rate = (140 * np.exp(-t / 1.6) + 18) * e + 1e-6
    ct = poisson_times(rate, rng, dur)
    # 纤维吸水的"噼啪"是湿的、软的：每一粒是 0.8–2.2 ms 的 Hann 窗短颗粒（七成正弦、三成带通噪声），频率逐粒随机
    # （2–6.5 kHz 连续分布）—— 没有裸脉冲那种数字"嗒"，也没有固定共振峰那种一直在的"嘶"色
    k = len(ct)
    amp_c = rng.lognormal(-0.5, 0.6, k) * rng.choice([-1, 1], k)
    f_c = np.exp(rng.uniform(np.log(2000), np.log(6500), k))
    d_c = rng.uniform(0.0008, 0.0022, k)
    sine = rng.random(k) < 0.7
    fz = (grain_bank(n, ct[sine], f_c[sine], d_c[sine], amp_c[sine], None, "sine", rng)
          + grain_bank(n, ct[~sine], f_c[~sine], d_c[~sine] * 1.5, amp_c[~sine] * 0.8, None, "noise", rng, bw=2.5))
    fizz = lp(fz[0] * np.sqrt(2.0), 8000, order=2)
    wet = bp(pink(n, rng), 800, 3500, order=2) * e
    we = smoothstep((t - wash_from) / 0.8) * smoothstep((wash_to - t) / 1.0)
    wash = sweep_bp(pink(n, rng), lambda x: 700 + 350 * np.sin(TWO_PI * 0.6 * x), lambda x: 1.0, block=256) * we
    wash *= np.clip(1 + 0.4 * ctrl_noise(n, rng, 6.0), 0.2, 1.8)
    y = 0.6 * _sd(fizz) * np.sqrt(e + 1e-9) + 0.5 * _sd(wet) + 0.45 * _sd(wash)
    o = widen(y, 0.5, seed)
    return dict(audio=reverb(o, ir_preset("paper_room"), wet=0.08), pre=0.0, norm="lufs")


def scroll_slide(seed=0, dur=1.6):
    """近代段镜头越摇越快冲向坝线：纸面掠过的风声越来越紧（到 dur 处最强，混音里在 dam_line 硬切）。同步点 = t=0。"""
    rng = np.random.default_rng(seed)
    n = ns(dur + 0.2)
    t = tvec(n)
    e = smoothstep(t / dur) ** 2
    fc = curve([(0, 350), (dur, 1800), (dur + 0.2, 1800)])
    y = sweep_bp(0.6 * pink(n, rng) + 0.4 * white(n, rng), fc, lambda x: 0.8, block=128) * e
    y += 0.25 * _sd(bp(white(n, rng), 1200, 5000, order=2)) * np.std(y) * e ** 1.5 * (0.6 + 0.4 * np.sin(TWO_PI * 30 * t))
    return dict(audio=reverb(widen(y, 0.6, seed), ir_preset("paper_room"), wet=0.08), pre=0.0)


FUNCS = {
    "scroll_slide": scroll_slide,
    "brush_stroke": brush_stroke,
    "light_stroke": light_stroke,
    "grain_dissolve": grain_dissolve,
    "paper_breath": paper_breath,
    "scroll_rush": scroll_rush,
    "asteroid_flight": asteroid_flight,
    "asteroid_impact": asteroid_impact,
    "ruler_line": ruler_line,
    "fish_sigh": fish_sigh,
    "small_brush": small_brush,
    "drop_on_paper": drop_on_paper,
    "ink_bleed": ink_bleed,
}
