"""《鲔》环境声床。全部程序化合成、一次生成整段（不循环、不拼接），电平按层在函数内部校准到绝对值。

每个函数签名：fn(dur, seed=0, **params) -> (2, n) 立体声 float64。
约定：gain=0 时整床约 -23 LUFS（"full" 状态）；混音里的 gain_db 是推子。
*_env 参数是 [(t, dB), ...] 折线（t 相对这条床的开头；cue 表里写绝对时间，library 负责换算）。
*_at  参数是时间点列表（同上）。

设计纪律（movie3 的教训）：
- 不用任何窄带共振 / 固定音高的 ping 去铺底；只有宽带噪声 + 慢速随机调制。
- 所有随机调制都是非周期的（滤波噪声控制信号），不会出现可察觉的循环。
- 每层单独校准再叠加，某层在别的滤波/闪避状态下单独暴露时也只是"更薄"，不会露出音高。
"""
from __future__ import annotations

import numpy as np
from scipy import signal

from .dsp import (SR, add_at, bp, brown, ctrl_noise, dbg, env_pts, eq, hp, impulses, integrated_lufs, ir_preset,
                  lp, ns, pan, pan_curve, pink, poisson_times, resonate, reverb, stereo, sweep_bp, sweep_lp, tvec,
                  white, width)


# ---------------------------------------------------------------- 工具
def _norm(x, target):
    L = integrated_lufs(stereo(x))
    if not np.isfinite(L):
        return x
    return x * dbg(target - L)


def _pair(fn, n, rng, corr=0.3):
    """部分相关的一对噪声（corr=共有成分比例）。"""
    c = fn(n, rng)
    c *= corr
    a = np.sqrt(max(0.0, 1 - corr ** 2))
    out = np.empty((2, n))
    for k in range(2):  # 与原来 vstack 写法同样的随机数顺序（先左后右），逐声道就地累加省内存
        out[k] = fn(n, rng)
        out[k] *= a
        out[k] += c
    return out


def _db_env(n, pts, default=0.0):
    """[(t, dB)] → 线性增益曲线（t 相对缓冲开头）。"""
    if not pts:
        return np.full(n, dbg(default))
    t = tvec(n)
    ts = np.array([float(p[0]) for p in pts])
    vs = np.array([float(p[1]) for p in pts])
    o = np.argsort(ts)
    return dbg(np.interp(t, ts[o], vs[o]))


def _slow(n, rng, fc, depth, lo=0.2, hi=2.0):
    return np.clip(1.0 + depth * ctrl_noise(n, rng, fc), lo, hi)


def _gravel_layer(n, dur, rng, rate=1 / 8.0, murk=1.0, dist=(0.25, 1.0)):
    """远处砾石滚动：稀疏的"簇"，每簇里是一串极短的石子碰撞（随机频率、极短衰减，无音高）+ 一点低频滚动。"""
    out = np.zeros((2, n))
    n_cl = rng.poisson(max(dur, 0.1) * rate)
    for tc in np.sort(rng.uniform(0.3, max(0.4, dur - 0.5), n_cl)):
        D = rng.uniform(0.6, 2.4)
        m = ns(D + 0.2)
        u = np.linspace(0, 1, m)
        shape = np.sin(np.pi * np.clip(u * (D + 0.2) / D, 0, 1)) ** rng.uniform(0.8, 2.0)
        peak_rate = rng.uniform(35, 140)
        times = poisson_times(peak_rate * shape + 1e-6, rng, (D + 0.2))
        amps = rng.lognormal(-0.3, 0.7, len(times)) * rng.choice([-1, 1], len(times))
        # 每颗石子随机落进 8 个随机频率之一的极短共振（τ 0.2–0.7 ms，Q≈1–3 → 听不出音高，只有"咔啦"）
        nb = 8
        fr = np.exp(rng.uniform(np.log(700), np.log(3400), nb))
        tau = rng.uniform(0.0002, 0.0007, nb)
        which = rng.integers(0, nb, len(times))
        clicks = np.zeros(m)
        for b in range(nb):
            sel = which == b
            if np.any(sel):
                clicks += resonate(impulses(m, times[sel], amps[sel]), [fr[b]], [tau[b]], [1.0])
        clicks += 0.25 * hp(impulses(m, times, amps), 1500, order=1)
        roll = lp(white(m, rng), 180, order=2) * shape
        roll *= np.std(clicks) / (np.std(roll) + 1e-12) * 0.9
        y = clicks + roll
        y = lp(y, 2400 * murk, order=2)
        a = rng.uniform(*dist)
        p0 = rng.uniform(-0.75, 0.75)
        pc = np.clip(p0 + rng.uniform(-0.2, 0.2) * u, -0.9, 0.9)
        add_at(out, pan_curve(y * a, pc), int(tc * SR))
    return out


# ================================================================ 水下江底（S0 / S1 / S4–S7）
def uw_river(dur, seed=0, murk=1.0, flow=1.0, rumble=1.0, hush=1.0, gravel=1.0, gravel_rate=1 / 8.0,
             city=0.0, traffic=0.0, rumble_env=None, flow_env=None, hush_env=None, gravel_env=None,
             city_env=None, traffic_env=None, master_env=None):
    """水下江底床：
      rumble  极低的轰鸣（棕噪 20–110 Hz，缓慢起伏）
      flow    缓慢起伏的水流（粉噪 70–650 Hz，时变低通 250–700 Hz 慢慢漂，两层独立调制）
      hush    水流湍动的"沙"（350–1400 Hz，极轻，随水流阵发）
      gravel  偶尔远处砾石滚动（稀疏簇，无音高）
      city    宜宾夜：水下听到的城市低频嗡鸣（宽带 35–160 Hz，无窄带音）
      traffic 桥上车流：偶发的远雷式低频滚动
    各层 *_env 为 dB 折线（相对缓冲开头），用于"环境一层层变薄"之类的自动化。"""
    rng = np.random.default_rng(seed)
    n = ns(dur)
    out = np.zeros((2, n))
    # 1) rumble
    if rumble > 0:
        r = _pair(brown, n, rng, 0.75)
        r = lp(hp(r, 20, order=2), 110, order=4)
        r *= _slow(n, rng, 0.025, 0.22) * _slow(n, rng, 0.11, 0.10)
        out += _norm(r, -26.0 + 20 * np.log10(rumble)) * _db_env(n, rumble_env)
    # 2) flow（两层，时变低通在 250–700 Hz 之间慢漂）
    if flow > 0:
        acc = np.zeros((2, n))
        for k in range(2):
            f = _pair(pink, n, rng, 0.35)
            f = bp(f, 70, 650, order=2)
            cn = ctrl_noise(n, rng, 0.05)
            cut = 430 * np.exp(0.45 * np.clip(cn, -2.2, 2.2)) * murk
            cs = cut[::256]
            fn = lambda tt, cs=cs: float(cs[min(int(tt * SR) // 256, len(cs) - 1)])
            f = np.vstack([sweep_lp(f[0], fn, block=256), sweep_lp(f[1], fn, block=256)])
            f *= _slow(n, rng, 0.06 + 0.03 * k, 0.30) * _slow(n, rng, 0.23, 0.12)
            acc += f
        out += _norm(acc, -27.0 + 20 * np.log10(flow)) * _db_env(n, flow_env)
    # 3) hush
    if hush > 0:
        h = _pair(pink, n, rng, 0.2)
        h = lp(hp(h, 350, order=2), 1400 * murk, order=2)
        gust = np.clip(0.6 + 0.35 * ctrl_noise(n, rng, 0.04) + 0.12 * ctrl_noise(n, rng, 0.35), 0.1, 1.6)
        h *= gust ** 1.5 * _slow(n, rng, 1.5, 0.08)
        out += _norm(h, -37.0 + 20 * np.log10(hush)) * _db_env(n, hush_env)
    # 4) gravel
    if gravel > 0:
        g = _gravel_layer(n, dur, rng, rate=gravel_rate, murk=murk)
        if np.any(g):
            g = reverb(g, ir_preset("uw_small"), wet=0.35)[:, :n]
            # 按"稀疏簇的长期平均"校准：-41 LUFS 左右（簇本身比平均响，偶尔听得到）
            L = integrated_lufs(g)
            if np.isfinite(L):
                g *= dbg(-41.0 + 20 * np.log10(gravel) - L)
            out += g * _db_env(n, gravel_env)
    # 5) city hum（宽带，只有一个很宽的 60 Hz 附近的鼓包，不是 50 Hz 电源音）
    if city > 0:
        c = _pair(brown, n, rng, 0.8)
        c = lp(hp(c, 32, order=2), 170, order=4)
        c = eq(c, ("peak", 62.0, 0.9, 3.0))
        c *= _slow(n, rng, 0.02, 0.15) * _slow(n, rng, 0.2, 0.06)
        out += _norm(c, -31.0 + 20 * np.log10(city)) * _db_env(n, city_env)
    # 6) traffic：远雷
    if traffic > 0:
        tr = np.zeros((2, n))
        for tc in np.sort(rng.uniform(-2, dur, rng.poisson(max(dur, 1) / 6.5))):
            D = rng.uniform(2.2, 5.5)
            m = ns(D)
            u = np.linspace(0, 1, m)
            e = np.sin(np.pi * u) ** 1.6
            roll = 1 + 0.35 * ctrl_noise(m, rng, rng.uniform(3, 8))
            s = lp(hp(brown(m, rng), 28, order=2), rng.uniform(120, 190), order=4) * e * np.clip(roll, 0.3, 1.8)
            p = rng.uniform(-0.6, 0.6)
            add_at(tr, pan_curve(s * rng.uniform(0.5, 1.0), np.clip(p + 0.3 * (u - 0.5), -0.9, 0.9)), int(tc * SR))
        tr = reverb(tr, ir_preset("uw_big"), wet=0.5)[:, :n]
        out += _norm(tr, -35.0 + 20 * np.log10(traffic)) * _db_env(n, traffic_env)
    out = lp(out, 2600 * murk, order=2)   # 整床再压一次高频：水下"高频少"
    out *= _db_env(n, master_env)
    return out


# ================================================================ 2D 长卷：极淡的远处江风
def scroll_air(dur, seed=0, water=1.0, gaps_at=(), gap_db=-9.0, gap_len=1.1, cut_at=(), cut_back=2.5):
    """极淡的远处江风 + 更淡的远处水声（给"鱼淡掉 = 水声的缺口"留位置）。
    gaps_at：每个时刻水声层挖一个 gap_db 的凹陷（余弦，长 gap_len 秒）。
    cut_at：硬切（30 ms 切到静音，停 0.7 s 后 cut_back 秒慢慢回来）。"""
    rng = np.random.default_rng(seed)
    n = ns(dur)
    wind = _pair(pink, n, rng, 0.15)
    wind = lp(hp(wind, 180, order=2), 2200, order=2)
    wind = eq(wind, ("peak", 520, 0.7, 2.0))
    gust = np.clip(0.65 + 0.3 * ctrl_noise(n, rng, 0.05) + 0.1 * ctrl_noise(n, rng, 0.3), 0.15, 1.5)
    wind *= gust ** 1.4
    wat = _pair(pink, n, rng, 0.4)
    wat = lp(hp(wat, 100, order=2), 900, order=2) * _slow(n, rng, 0.08, 0.2)
    g = np.ones(n)
    for tg in gaps_at or ():
        L = ns(gap_len)
        i0 = int((float(tg) - gap_len * 0.35) * SR)
        w = 1 - (1 - dbg(gap_db)) * np.sin(np.pi * np.linspace(0, 1, L)) ** 2
        a, b = max(0, i0), min(n, i0 + L)
        if b > a:
            g[a:b] *= w[a - i0: b - i0]
    out = _norm(wind, -24.0) + _norm(wat, -30.0 + 20 * np.log10(max(water, 1e-3))) * g
    c = np.ones(n)
    for tcut in cut_at or ():
        i = int(float(tcut) * SR)
        if 0 <= i < n:
            f = ns(0.03)
            c[max(0, i - f): i] *= np.linspace(1, 0, min(f, i))
            hold = ns(0.7)
            c[i: i + hold] = 0.0
            back = ns(cut_back)
            j = min(n, i + hold + back)
            c[i + hold: j] = (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, back)))[: j - (i + hold)]
    return out * c


# ================================================================ 2003 江边白天
def _one_lap(rng, strength=1.0, hull=False):
    """一次拍水（单声道）：水涌（时变带通）+ 细碎水花 + 回落的"嘶"；hull=True 加木船壳的空腔闷响。"""
    D = rng.uniform(0.45, 1.2)
    m = ns(D + 0.6)
    tt = tvec(m)
    tp = rng.uniform(0.06, 0.16)
    env = np.where(tt < tp, (tt / tp) ** 1.5, np.exp(-(tt - tp) / rng.uniform(0.18, 0.4)))
    f0 = rng.uniform(260, 420)
    fc = lambda x, f0=f0, tp=tp, D=D: f0 * (1 + 1.4 * np.exp(-((x - tp) / 0.12) ** 2)) * (1 - 0.25 * min(1.0, x / D))
    slosh = sweep_bp(pink(m, rng), fc, lambda x: 1.1, block=256) * env
    fizz_env = np.exp(-np.maximum(tt - tp * 1.3, 0) / rng.uniform(0.25, 0.55)) * np.clip(tt / (tp * 1.3), 0, 1)
    fizz = bp(white(m, rng), 1800, 6500, order=2) * fizz_env
    y = slosh / (np.std(slosh) + 1e-9) + 0.1 * fizz / (np.std(fizz) + 1e-9)
    if hull:
        k = impulses(m, [tp * 0.9], [1.0])
        knock = resonate(lp(k, 900, order=2), rng.uniform(110, 190, 2), rng.uniform(0.03, 0.06, 2), [1.0, 0.6])
        y += 0.5 * knock / (np.max(np.abs(knock)) + 1e-9) * np.max(np.abs(y))
    y = lp(y, 8000, order=2)
    y[-ns(0.05):] *= np.linspace(1, 0, ns(0.05))
    return y * strength * rng.lognormal(-0.2, 0.35)


def _laps(n, dur, rng, rate=0.55, strength=1.0, hull=False):
    """岸边（或船身）拍水：随机间隔（指数分布、最小 0.35 s）的一次次拍水，随机声像。"""
    out = np.zeros((2, n))
    t = rng.uniform(0, 1.0)
    while t < dur:
        add_at(out, pan(_one_lap(rng, strength, hull), rng.uniform(-0.7, 0.7)), int(t * SR))
        t += max(0.35, rng.exponential(1.0 / rate))
    return out


def _syllable_env(n, rng, rate=4.4, talk=(0.8, 3.5), pause=(0.4, 2.8)):
    env = np.zeros(n)
    pos = int(rng.uniform(0, pause[1]) * SR)
    while pos < n:
        end = min(n, pos + ns(rng.uniform(*talk)))
        while pos < end:
            L = ns(rng.uniform(0.6, 1.4) / rate)
            seg = np.hanning(L) ** 0.7 * rng.uniform(0.4, 1.0)
            e = min(n, pos + L)
            env[pos:e] = np.maximum(env[pos:e], seg[: e - pos])
            pos += int(L * rng.uniform(0.85, 1.05))
        pos = end + ns(rng.uniform(*pause))
    return env


def _crowd(n, rng, talkers=14):
    """含糊的人群嘈杂：语音谱形噪声 × 许多人的音节包络之和（听不出字，只有"人多"的感觉）。"""
    out = np.zeros((2, n))
    for c in range(2):
        s = pink(n, rng)
        s = eq(hp(s, 180, order=2), ("peak", 520, 0.8, 4.0), ("peak", 2300, 1.0, 1.5))
        s = lp(s, 3400, order=2)
        acc = np.zeros(n)
        for _ in range(talkers // 2):
            acc += _syllable_env(n, rng) ** 2
        env = np.sqrt(acc / max(1, talkers // 2))
        out[c] = s * env / (np.mean(env) + 1e-9)
    return reverb(out, ir_preset("river_bank"), wet=0.35)[:, :n]


def _distant_diesel(n, dur, rng, rpm_hz=7.2, passes=1):
    """远处江上的柴油船：突突声的低频轮廓（高频被距离吃掉）+ 慢慢经过。"""
    out = np.zeros((2, n))
    for _ in range(passes):
        D = rng.uniform(14, 26)
        c = rng.uniform(0.2 * dur, 0.8 * dur)
        m = ns(D)
        f = rpm_hz * rng.uniform(0.85, 1.15) * (1 + 0.01 * ctrl_noise(m, rng, 0.3))
        ph = np.cumsum(f) / SR
        pulse = (0.5 + 0.5 * np.cos(2 * np.pi * ph)) ** 6
        body = lp(white(m, rng), 260, order=2) * pulse + 0.3 * lp(brown(m, rng), 120, order=2)
        u = np.linspace(-1, 1, m)
        e = np.exp(-0.5 * (u / 0.38) ** 2)
        s = lp(body, 380, order=2) * e
        add_at(out, pan_curve(s, np.linspace(-0.6, 0.6, m) * rng.choice([-1, 1])), int((c - D / 2) * SR))
    return reverb(out, ir_preset("valley"), wet=0.55, dry=0.6)[:, :n]


def river_day(dur, seed=0, wind=1.0, laps=1.0, boat=1.0, crowd=1.0, crowd_env=None, wind_env=None, laps_env=None):
    """2003 江边白天：风 + 江水拍岸 + 远处的船 + 人群的嘈杂（滤波噪声 × 音节包络，听不出字）。"""
    rng = np.random.default_rng(seed)
    n = ns(dur)
    t = tvec(n)
    # 风：两条时变带通（呼啸随风速）+ 湍流嘶声；开阔、无楼角口哨
    gust = np.clip(0.6 + 0.3 * ctrl_noise(n, rng, 0.06) + 0.12 * ctrl_noise(n, rng, 0.25), 0.1, 1.5)
    g_norm = np.clip((gust - 0.1) / 1.3, 0, 1)
    gs = g_norm[::256]
    fw = lambda tt: 300 * (850 / 300) ** gs[min(int(tt * SR) // 256, len(gs) - 1)]
    w = np.zeros((2, n))
    for c in range(2):
        h1 = sweep_bp(pink(n, rng), fw, lambda tt: 2.2, block=256)
        h2 = bp(pink(n, rng), 1200, 5500, order=2) * gust ** 2
        rum = lp(hp(brown(n, rng), 35, order=2), 160, order=2)
        w[c] = h1 * gust + 0.35 * h2 / (np.std(h2) + 1e-9) * np.std(h1) + 0.6 * rum / (np.std(rum) + 1e-9) * np.std(h1)
    w = width(lp(w, 7000, order=2), 1.2)
    # 江水：宽广的低沉流动
    riv = _pair(pink, n, rng, 0.5)
    riv = lp(hp(riv, 70, order=2), 520, order=2) * _slow(n, rng, 0.07, 0.18)
    lap = _laps(n, dur, rng, rate=0.6)
    lap = reverb(lap, ir_preset("river_bank"), wet=0.2)[:, :n]
    out = (_norm(w, -26.5 + 20 * np.log10(max(wind, 1e-3))) * _db_env(n, wind_env)
           + _norm(riv, -30.0)
           + _norm(lap, -28.5 + 20 * np.log10(max(laps, 1e-3))) * _db_env(n, laps_env))
    if boat > 0:
        out += _norm(_distant_diesel(n, dur, rng, passes=1), -38.0 + 20 * np.log10(boat))
    if crowd > 0:
        cr = _crowd(n, rng)
        out += _norm(cr, -31.0 + 20 * np.log10(crowd)) * _db_env(n, crowd_env)
    return out


# ================================================================ 2003 夜江
def river_night(dur, seed=0, laps=1.0, rock_at=(), rock_len=6.0, breeze=1.0, laps_env=None, master_env=None):
    """夜里安静的江面：水拍木船壳（空腔闷响 + 细水花）+ 很低的江水流动 + 极轻的夜风。
    rock_at：触礁后船身摇晃，拍水变密变重，rock_len 秒内慢慢平息。"""
    rng = np.random.default_rng(seed)
    n = ns(dur)
    riv = _pair(pink, n, rng, 0.5)
    riv = lp(hp(riv, 60, order=2), 420, order=2) * _slow(n, rng, 0.05, 0.2)
    lap = _laps(n, dur, rng, rate=0.7, strength=1.0, hull=True)
    for tr in rock_at or ():
        # 触礁后的摇晃：额外一串更重、更密的拍水，逐渐稀疏
        sub = np.zeros((2, n))
        t = float(tr) + 0.25
        k = 0
        while t < float(tr) + rock_len and t < dur:
            decay = np.exp(-(t - float(tr)) / (rock_len * 0.45))
            one = _one_lap(rng, 2.4 * decay, hull=True)
            add_at(sub, pan(one, rng.uniform(-0.5, 0.5)), int(t * SR))
            t += rng.uniform(0.28, 0.55) / max(decay, 0.3)
            k += 1
        lap = lap + sub
    lap = reverb(lap, ir_preset("night_river"), wet=0.25)[:, :n]
    br = _pair(pink, n, rng, 0.2)
    br = lp(hp(br, 200, order=2), 1800, order=2) * np.clip(0.6 + 0.35 * ctrl_noise(n, rng, 0.05), 0.1, 1.4)
    out = (_norm(riv, -29.0) + _norm(lap, -25.5 + 20 * np.log10(max(laps, 1e-3))) * _db_env(n, laps_env)
           + _norm(br, -36.0 + 20 * np.log10(max(breeze, 1e-3))))
    return out * _db_env(n, master_env)


# ================================================================ 尾声：几乎无环境
def paper_room(dur, seed=0):
    """尾声的纸与笔所在的"房间"：只有一点点空气，几乎不可闻（避免数字静音的死寂感）。"""
    rng = np.random.default_rng(seed)
    n = ns(dur)
    a = _pair(pink, n, rng, 0.2)
    a = lp(hp(a, 90, order=2), 3200, order=2) * _slow(n, rng, 0.03, 0.1)
    return _norm(a, -23.0)


BEDS = {
    "uw_river": uw_river,
    "scroll_air": scroll_air,
    "river_day": river_day,
    "river_night": river_night,
    "paper_room": paper_room,
}
