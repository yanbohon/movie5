"""代码物理建模古琴（数字波导弦，全部从零合成，不用任何采样）。

一张琴 = 7 根弦 × 2 个振动偏振 = 14 个波导环路，在同一个 numba 内核里逐样本联合仿真：

- 弦：单环路数字波导（Karplus-Strong 的物理形式）。环路延迟 = 往返一趟的时间，
  用三阶拉格朗日分数延迟逐样本读取，所以弦长可以连续变化（按音走手、吟猱绰注）。
- 损耗：环路里一阶低通，按「基频处 T60」和「3 kHz 处 T60」两点设计；散音、按音、泛音用不同的损耗
  （按音的指肉端比岳山/龙龈软，吸收高频，所以按音更短更闷）。T60 以秒给出，弦长变化时逐控制帧重算。
- 刚性色散：环路里 2 节一阶全通级联（系数为负，高频走得快，分音逐渐偏高），系数按「弦长比例 p」
  数值拟合目标非谐系数 B = B0 / p²（弦越短越「硬」）。
- 拨弦：手指离弦的平滑脉冲 -> 1/f 倾斜（泄漏积分）-> 指肉/指甲低通（指甲另加刮擦噪声）
  -> 拨弦位置梳状滤波 1 - z^(-βN)（β = 拨弦点距岳山 / 当前有效弦长，按音越高 β 越大，音色越空）。
- 泛音：左手在徽位轻触 = 在环路内部该位置放一个有损的「阻尼器」散射结（两个抽头：去波与回波），
  触弦的约 6 个周期里没有节点落在该处的分音被吸收 40–70 dB，离指后只剩节点在该处的分音
  （七徽只剩偶次分音，五徽/九徽只剩 3 的倍数次分音）。
  右手拨弦前一瞬手指「接住」弦也用同一种阻尼器（同弦重复弹奏时旧振动先被压一下）。
- 走手滑音：左手指沿缠弦滑动 -> 摩擦噪声 = 频率随滑动速度变化的脉冲串（速度 / 缠弦节距）+ 气声噪声，
  一小部分注入弦里，大部分直接进琴身。吟猱是「揉」不是「滑」，摩擦只有滑音的 8%。
- 弦间耦合与拍频：7 根弦的垂直偏振经同一个岳山（阻抗结，能量守恒、必然稳定）互相耦合，
  没弹的散音弦会被共振激起，频率与按音的分音略有差（律差 + 各弦 ±2 音分的定弦误差 + 非谐性），
  产生缓慢的拍频；每根弦的水平偏振比垂直偏振高 0.6–1.4 音分、耦合更弱、衰减更慢：
  先响后长的「两段衰减」和弦内拍频就是这样来的。
- 琴身：岳山的速度 -> 两组生成的琴身脉冲响应（左右两个「麦克风位置」）：直达 + 100–400 Hz 的
  几个主共振峰（外加 400 Hz–1.5 kHz 的次共振）+ 木头的高频短噪声尾巴。
"""
import math
import numpy as np
from numba import njit
from scipy import signal, optimize
from mus_dsp import SR, rng, fade_edges
from mus_theme import hz, nm, QIN_OPEN, HUI

FS = SR
NSTR = 7
K_CTRL = 32                 # 控制帧（采样点）：弦长/损耗/阻尼器参数每 32 点更新一次，帧内延迟线性插值
M_AP = 2                    # 色散全通节数
BUFN = 4096                 # 每个环路的循环缓冲长度（最低音 C2 一趟约 736 点）
LEN_M = 1.10                # 有效弦长（米），岳山到龙龈
PLUCK_X = 0.094             # 右手拨弦点距岳山的比例（相对散音弦长）
B_OPEN = np.array([4.0, 3.7, 3.3, 3.0, 2.7, 2.4, 2.2]) * 1e-5                 # 散音非谐系数
WIND = np.array([0.55, 0.55, 0.50, 0.50, 0.45, 0.42, 0.40]) * 1e-3          # 缠弦节距（米）
C_V = 0.0010                # 垂直偏振与岳山的耦合（每趟往返的能量交换比例量级）
C_H = 0.00033               # 水平偏振（更弱：衰减慢、辐射少）
H_OUT = 0.9                 # 水平偏振在输出里的权重（初始约低 9 dB，衰减更慢，几秒后成为「余音」）
OUT_GAIN = 2560.0           # 内核输出到琴身前的整体增益（经验标定：vel 0.6 散音单音峰值约 -14 dBFS）


# ======================================================================= 数值设计
def loss_coefs(f, t_lo, t_hi, f_hi=3000.0):
    """一阶损耗 H(z) = g(1+a)/(1 + a z^-1)：基频处 T60 = t_lo，f_hi 处 T60 = t_hi（秒）。返回 (g, a)。
    f 可为数组。"""
    f = np.asarray(f, dtype=np.float64)
    P = 1.0 / f
    G0 = 10.0 ** (-3.0 * P / t_lo)
    G1 = 10.0 ** (-3.0 * P / t_hi)
    r = np.minimum(G1 / G0, 0.999999)
    w = 2 * math.pi * np.minimum(f_hi, 0.45 * FS) / FS
    c = np.cos(w)
    A2 = r * r - 1.0
    B2 = 2.0 * (r * r * c - 1.0)
    disc = np.maximum(B2 * B2 - 4.0 * A2 * A2, 0.0)
    a1 = (-B2 - np.sqrt(disc)) / (2.0 * A2)
    a2 = (-B2 + np.sqrt(disc)) / (2.0 * A2)
    a = np.where(np.abs(a1) < 1.0, a1, a2)
    a = np.clip(a, -0.95, 0.0)
    return G0, a


def onepole_delay(w, a):
    """一阶损耗滤波在 w（弧度/样本）处的相位延迟（样本）。"""
    return -np.arctan2(a * np.sin(w), 1.0 + a * np.cos(w)) / w


def ap_delay(w, a):
    """一阶全通 (a + z^-1)/(1 + a z^-1) 的相位延迟（样本）。"""
    return (w - 2.0 * np.arctan2(a * np.sin(w), 1.0 + a * np.cos(w))) / w


def _fit_disp(f0, B, fmax=2000.0):
    """拟合 M_AP 节全通系数，使环路分音 f_k 接近 k f0 sqrt(1 + B k^2)（按音分误差、1/k² 加权最小二乘：
    响的低中分音拟合准，最高的弱分音略偏少）。"""
    K = int(max(2, min(40, fmax / f0)))
    k = np.arange(1, K + 1, dtype=np.float64)
    fk = k * f0 * np.sqrt(1 + B * k * k)
    wk = 2 * math.pi * fk / FS
    tgt = FS / (f0 * np.sqrt(1 + B * k * k))        # 所需的环路总相位延迟
    wt = 1.0 / (k * k)

    def err(a):
        tau = M_AP * ap_delay(wk, a)
        D = tgt[0] - tau[0]                           # 基频精确对准
        tot = D + tau
        return float(np.sum(wt * (1200 * np.log2(tot / tgt)) ** 2))

    res = optimize.minimize_scalar(err, bounds=(-0.92, -0.001), method='bounded', options={'xatol': 1e-5})
    return float(res.x)


class _DispTable:
    """每根弦：弦长比例 p -> 全通系数（B = B0 / p²）。"""
    P = np.linspace(0.12, 1.0, 45)

    def __init__(self):
        self.tab = np.zeros((NSTR, self.P.size))
        for s in range(NSTR):
            f_open = hz(QIN_OPEN[s])
            for i, p in enumerate(self.P):
                self.tab[s, i] = _fit_disp(f_open / p, B_OPEN[s] / (p * p))

    def __call__(self, s, p):
        return np.interp(p, self.P, self.tab[s])


_DISP = None


def disp_table():
    global _DISP
    if _DISP is None:
        _DISP = _DispTable()
    return _DISP


# ======================================================================= 仿真内核
@njit(cache=True, fastmath=True)
def _qin_kernel(n, K, D, G, A, AD, MUTE, TAd, TAk, TBd, TBk, isV,
                ev_t, ev_loop, ev_off, ev_len, ev_gain, pulses, cV, cH, out):
    L = D.shape[0]
    MASK = 4095
    buf = np.zeros((L, 4096))
    lf = np.zeros(L)
    apx = np.zeros((L, 2))
    apy = np.zeros((L, 2))
    y = np.zeros(L)
    e = np.zeros(L)
    act = np.zeros(512, np.int64)
    nact = 0
    ep = 0
    nev = ev_t.size
    w = 0
    for i in range(n):
        c = i // K
        fr = (i - c * K) / K
        while ep < nev and ev_t[ep] <= i:
            if nact < 512:
                act[nact] = ep
                nact += 1
            ep += 1
        sV = 0.0
        sH = 0.0
        for j in range(L):
            d = D[j, c] + (D[j, c + 1] - D[j, c]) * fr
            rp = w - d
            ip = int(math.floor(rp))
            f = rp - ip
            xm1 = buf[j, (ip - 1) & MASK]
            x0 = buf[j, ip & MASK]
            x1 = buf[j, (ip + 1) & MASK]
            x2 = buf[j, (ip + 2) & MASK]
            # 三阶拉格朗日分数延迟
            fm1 = f - 1.0
            fm2 = f - 2.0
            fp1 = f + 1.0
            v = (-f * fm1 * fm2 / 6.0) * xm1 + (fp1 * fm1 * fm2 * 0.5) * x0 \
                - (fp1 * f * fm2 * 0.5) * x1 + (fp1 * f * fm1 / 6.0) * x2
            # 损耗（一阶低通）
            g = G[j, c]
            a = A[j, c]
            v = g * (1.0 + a) * v - a * lf[j]
            lf[j] = v
            # 刚性色散（全通级联）
            ad = AD[j, c]
            for m in range(2):
                z = ad * v + apx[j, m] - ad * apy[j, m]
                apx[j, m] = v
                apy[j, m] = z
                v = z
            y[j] = v
            if isV[j]:
                sV += v
            else:
                sH += v
        vJ = cV * sV
        vH = cH * sH
        for j in range(L):
            e[j] = 0.0
        k = 0
        while k < nact:
            q = act[k]
            pos = i - ev_t[q]
            if pos >= ev_len[q]:
                nact -= 1
                act[k] = act[nact]
                continue
            e[ev_loop[q]] += pulses[ev_off[q] + pos] * ev_gain[q]
            k += 1
        for j in range(L):
            if isV[j]:
                v = y[j] - vJ
            else:
                v = y[j] - vH
            v = v * MUTE[j, c] + e[j]
            buf[j, w] = v
            # 阻尼器 A（右手接弦）/ B（左手泛音轻触、手掌止音）：环路内部的散射结
            kk = TAk[j, c]
            if kk < 0.99999:
                d1 = TAd[j, c]
                d2 = int(D[j, c] + 0.5) - d1
                i1 = (w - d1) & MASK
                i2 = (w - d2) & MASK
                r = buf[j, i1]
                l = -buf[j, i2]
                vj = kk * (r + l)
                buf[j, i1] = vj - l
                buf[j, i2] = -(vj - r)
            kk = TBk[j, c]
            if kk < 0.99999:
                d1 = TBd[j, c]
                d2 = int(D[j, c] + 0.5) - d1
                i1 = (w - d1) & MASK
                i2 = (w - d2) & MASK
                r = buf[j, i1]
                l = -buf[j, i2]
                vj = kk * (r + l)
                buf[j, i1] = vj - l
                buf[j, i2] = -(vj - r)
        out[0, i] = vJ
        out[1, i] = vH
        w = (w + 1) & MASK
    return out


# ======================================================================= 激励
def pluck_pulse(f0, beta, vel, finger, r):
    """拨弦激励（注入环路）。返回 1-D 数组。"""
    N = FS / f0
    n = int(0.030 * FS + beta * N + 64)
    x = np.zeros(n)
    x[0] = 1.0
    # 1/f 倾斜：泄漏积分，转折在 0.45 f0
    fc = 0.45 * f0
    p = math.exp(-2 * math.pi * fc / FS)
    x = signal.lfilter([1.0 - p], [1.0, -p], x) * (2 * math.pi * f0 / FS) ** -1 * 0.25
    # 指肉/指甲：离弦的圆滑程度 = 低通
    if finger == 'nail':
        fcut = 4500.0 + 5000.0 * vel
    else:
        fcut = 2200.0 + 3200.0 * vel ** 1.2
    sos = signal.butter(2, min(fcut, 0.45 * FS), 'lowpass', fs=FS, output='sos')
    x = signal.sosfilt(sos, x)
    if finger == 'nail':
        nl = int(0.0022 * FS)
        tn = np.arange(nl) / FS
        scr = r.standard_normal(nl) * np.exp(-tn / 0.0006)
        scr = signal.sosfilt(signal.butter(2, [2500, 9000], 'bandpass', fs=FS, output='sos'), scr)
        x[:nl] += scr * 0.10 * (0.4 + vel) * np.max(np.abs(x))
    # 拨弦位置梳状滤波：e[n] - e[n - βN]（分数延迟，线性插值）
    dl = beta * N
    i0 = int(dl)
    fr = dl - i0
    sh = np.zeros(n)
    sh[i0:] += (1 - fr) * x[:n - i0]
    if i0 + 1 < n:
        sh[i0 + 1:] += fr * x[:n - i0 - 1]
    y = x - sh
    return y


def friction_noise(v, lam, r, pressure=1.0):
    """走手摩擦声：v 为每个采样点的手指滑动速度（米/秒，非负）。返回 1-D。
    脉冲串频率 = v / 缠弦节距，叠一层气声噪声；带通在 0.6–6 kHz。"""
    n = v.size
    if n == 0:
        return np.zeros(0)
    fw = v / lam
    ph = np.cumsum(fw) / FS
    # 过零即一个脉冲（每跨过一个整数）
    k = np.floor(ph)
    tick = np.zeros(n)
    idx = np.nonzero(np.diff(k, prepend=k[0]) > 0)[0]
    tick[idx] = 1.0 + 0.35 * r.standard_normal(idx.size)
    hiss = r.standard_normal(n) * 0.35
    src = tick + hiss
    sos = signal.butter(2, [600.0, 6000.0], 'bandpass', fs=FS, output='sos')
    src = signal.sosfilt(sos, src)
    # 「缠弦共鸣」：以 fw 为中心的宽共振（用两个固定带通近似，随速度加权）
    amp = np.clip(v / 0.25, 0, 3.0) ** 0.8
    env_sos = signal.butter(1, 30.0, 'lowpass', fs=FS, output='sos')
    amp = signal.sosfilt(env_sos, amp)
    return src * amp * pressure


# ======================================================================= 琴身
def make_body_ir(seed=5, length=0.32):
    """两路（左右两个拾音位置）琴身脉冲响应：直达 + 模态（100–400 Hz 主共振）+ 木头的高频短尾。"""
    r = rng(seed)
    n = int(length * FS)
    t = np.arange(n) / FS
    modes = [  # (Hz, 相对幅度, T60 秒)
        (78, 0.55, 0.22), (112, 0.80, 0.24), (158, 0.95, 0.20), (205, 0.70, 0.16), (238, 1.00, 0.17),
        (296, 0.85, 0.14), (345, 0.60, 0.12), (392, 0.75, 0.12), (455, 0.45, 0.09), (530, 0.40, 0.08),
        (615, 0.40, 0.07), (720, 0.50, 0.06), (860, 0.50, 0.05), (1010, 0.45, 0.045), (1230, 0.40, 0.04),
        (1480, 0.32, 0.035), (1800, 0.24, 0.03), (2300, 0.18, 0.025)]
    out = np.zeros((2, n))
    for ch in range(2):
        acc = np.zeros(n)
        for (f, g, T) in modes:
            f2 = f * (1 + r.uniform(-0.015, 0.015))
            g2 = g * r.uniform(0.7, 1.3)
            acc += g2 * np.sin(2 * math.pi * f2 * t + r.uniform(0, 2 * math.pi)) * np.exp(-6.9078 * t / T)
        acc *= 0.011
        # 木头的高频短尾（密集高阶模态）
        wood = r.standard_normal(n) * np.exp(-t / 0.006)
        wood = signal.sosfilt(signal.butter(2, [1200, 7500], 'bandpass', fs=FS, output='sos'), wood) * 0.060
        acc += wood
        acc[0] += 0.62                                  # 直达（保留拨弦的清晰起音）
        acc = signal.sosfilt(signal.butter(2, 45.0, 'highpass', fs=FS, output='sos'), acc)
        out[ch] = acc
    fo = int(0.05 * FS)
    out[:, -fo:] *= np.linspace(1, 0, fo) ** 2
    return out


_IRS = {}


def body_irs():
    """垂直偏振与水平偏振经不同的辐射路径（两组互不相关的琴身响应），避免两者相消。"""
    if not _IRS:
        _IRS['V'] = make_body_ir(seed=5)
        _IRS['H'] = make_body_ir(seed=9)
    return _IRS['V'], _IRS['H']


# ======================================================================= 演奏（一段连续的弹奏）
class _Str:
    def __init__(self, s):
        self.s = s
        self.kf = [(-1.0, 0.0, 'step')]     # (t, cents, mode)：按弦位置（相对散音的音分）关键帧
        self.stop = []                       # [(t0, t1)] 按弦区间
        self.vib = []                        # (t0, dur, depth, rate, kind, phase)
        self.mute = []                       # (t0, dur, T60)
        self.touchA = []                     # (t0, t1, pos_frac, kappa)   右手接弦（拨弦点）
        self.touchB = []                     # (t0, t1, pos_frac, kappa)   左手触弦（泛音/止音）
        self.cur = 0.0                       # 当前按弦音分（添加时的状态）
        self.stopped_from = None
        self.last_t = -1e9


class QinPhrase:
    """一段连续的古琴演奏。所有时间为全片绝对秒；render() 返回 (起点秒, 立体声 float32)。

    note(t, s, pitch)      弹一个音：s = 弦号 1..7；pitch=None 为散音，否则为按音（音名/MIDI）
        approach=('chuo', 音分, 秒)  绰：从下方滑入；('zhu', 音分, 秒) 注：从上方滑入；
                 ('slide', t_from) 走手：手指从上一个按位滑到本音（拨弦时刚好到达）
        orn=[('yin', 起点, 时长, 深度音分, 速率Hz), ('nao', ...), ('go', 起点, 音名, 时长),
             ('zhuang', 起点, 深度音分, 时长)]   起点均相对拨弦时刻
        end=('damp', 相对秒) 止音；('lift', 相对秒) 抬指（按音变回散音前先止住）
    harm(t, s, hui_or_frac)  泛音；cuo(t, [(s, pitch), ...]) 撮；sweep(t, [弦...], dur) 滚/拂；damp(t, s)
    """

    def __init__(self, seed=0, detune_seed=77):
        self.seed = seed
        self.r = rng(seed)
        self.strs = [_Str(s) for s in range(NSTR)]
        self.plucks = []                     # (t, s, vel, finger, x_abs)
        self.hits = []                       # 对外报告的音（t, 描述）
        rd = rng(detune_seed)
        # 各弦定弦误差（±2.2 音分，人耳调弦的真实误差）与水平偏振的额外升高（0.6–1.4 音分）
        self.tune_err = rd.uniform(-2.2, 2.2, NSTR)
        self.pol_det = rd.uniform(0.6, 1.4, NSTR)
        self.t_min = 1e9
        self.t_max = -1e9

    # ------------------------------------------------------------ 工具
    def cents_of(self, s, pitch):
        f_open = hz(QIN_OPEN[s])
        return 1200.0 * math.log2(hz(nm(pitch)) / f_open)

    def _touch(self, t):
        self.t_min = min(self.t_min, t)
        self.t_max = max(self.t_max, t)

    def _lift(self, st, t):
        """抬指：先用 70 ms 把弦止住，再变回散音。"""
        st.mute.append((t - 0.075, 0.075, 0.05))
        st.kf.append((t, 0.0, 'step'))
        if st.stopped_from is not None:
            st.stop.append((st.stopped_from, t))
        st.stopped_from = None
        st.cur = 0.0

    # ------------------------------------------------------------ 演奏动作
    def note(self, t, s, pitch=None, vel=0.5, finger='flesh', approach=None, orn=(), end=None, x=None,
             label=None):
        si = s - 1
        st = self.strs[si]
        assert t >= st.last_t - 1e-6, f'string {s}: events must be added in time order ({t} < {st.last_t})'
        self._touch(t - 0.3)
        if pitch is None:
            if st.stopped_from is not None:
                self._lift(st, t - 0.02)
            target = 0.0
        else:
            target = self.cents_of(si, pitch)
            assert 3.0 < target < 3700.0, (s, pitch, target)
            if approach is not None and approach[0] == 'slide':
                t_from = approach[1]
                assert st.stopped_from is not None, 'slide needs a stopped string'
                st.kf.append((t_from, st.cur, 'step'))
                st.kf.append((t, target, 'ease'))
            else:
                if st.stopped_from is not None and abs(st.cur - target) > 2.0:
                    # 换按位：先止住旧振动再落指（不出滑音）
                    st.mute.append((t - 0.13, 0.07, 0.05))
                start_c = target
                if approach is not None and approach[0] == 'chuo':
                    start_c = target - approach[1]
                elif approach is not None and approach[0] == 'zhu':
                    start_c = target + approach[1]
                st.kf.append((t - 0.05, start_c, 'step'))
                if start_c != target:
                    st.kf.append((t + 0.015, start_c, 'step'))
                    st.kf.append((t + 0.015 + approach[2], target, 'out'))
                if st.stopped_from is None:
                    st.stopped_from = t - 0.05
        cur = target
        for o in orn:
            kind = o[0]
            if kind in ('yin', 'nao'):
                ph = 0.0 if kind == 'yin' else math.pi * 0.5
                st.vib.append((t + o[1], o[2], o[3], o[4], kind, ph))
            elif kind == 'go':
                newc = self.cents_of(si, o[2])
                st.kf.append((t + o[1], cur, 'step'))
                st.kf.append((t + o[1] + o[3], newc, 'ease'))
                cur = newc
            elif kind == 'zhuang':
                st.kf.append((t + o[1], cur, 'step'))
                st.kf.append((t + o[1] + o[3] * 0.4, cur + o[2], 'out'))
                st.kf.append((t + o[1] + o[3], cur, 'ease'))
        st.cur = cur
        self.plucks.append((t, si, float(vel), finger, x))
        self.hits.append((t, label or f'qin s{s} {pitch or "open"}'))
        st.last_t = t
        if end is not None:
            te = t + end[1]
            if end[0] == 'damp':
                st.mute.append((te, 0.22, 0.10))
                st.touchB.append((te, te + 0.22, self.r.uniform(0.25, 0.4), 0.35))
                if st.stopped_from is not None:
                    st.kf.append((te + 0.22, cur, 'step'))
                    st.kf.append((te + 0.23, 0.0, 'step'))
                    st.stop.append((st.stopped_from, te + 0.23))
                    st.stopped_from = None
                    st.cur = 0.0
            elif end[0] == 'lift':
                if st.stopped_from is not None:
                    self._lift(st, te)
            st.last_t = te + 0.25
            self._touch(te)
        return self

    def harm(self, t, s, pos, vel=0.5, finger='flesh', label=None):
        """泛音：pos 为徽号（整数）或距岳山的弦长比例。左手指肉在该点轻触：一个有损的阻尼器
        （κ = 0.55，阻抗接近弦本身，吸收最多），持续拨弦后约 6.5 个周期（低音弦更久），然后离弦。
        没有节点落在该点的分音被吸收 40–70 dB，只剩节点分音。"""
        si = s - 1
        st = self.strs[si]
        frac = HUI[pos] if isinstance(pos, int) else float(pos)
        if st.stopped_from is not None:
            self._lift(st, t - 0.03)
        per = 1.0 / hz(QIN_OPEN[si])
        st.touchB.append((t - 0.035, t + max(0.03, 6.5 * per), frac, 0.55))
        vel = min(1.0, vel * 1.3)                    # 泛音要弹得实一些（能量只剩节点分音）
        self.plucks.append((t, si, float(vel), finger, None))
        self.hits.append((t, label or f'qin harmonic s{s} @{frac:.3f}'))
        st.last_t = t
        self._touch(t - 0.3)
        return self

    def cuo(self, t, pairs, vel=0.5, spread=0.014, finger='flesh', label=None):
        """撮：两弦同时（略有先后，低音先）。pairs = [(弦, 音高或 None), ...]"""
        for i, (s, p) in enumerate(pairs):
            self.note(t + i * spread, s, p, vel * (1.0 if i == 0 else 0.92), finger,
                      label=(label if i == 0 else None) or f'qin cuo s{s}')
        return self

    def sweep(self, t, strings, dur, vel=0.4, finger='flesh', curve=1.0, label=None):
        """滚/拂：依次拨一串散音弦。curve>1 越来越快。"""
        n = len(strings)
        for i, s in enumerate(strings):
            u = (i / max(1, n - 1)) ** curve
            self.note(t + u * dur, s, None, vel * (0.85 + 0.3 * self.r.uniform()), finger,
                      label=label if i == 0 else f'qin sweep s{s}')
        return self

    def damp(self, t, s, dur=0.25):
        si = s - 1
        st = self.strs[si]
        st.mute.append((t, dur, 0.09))
        st.touchB.append((t, t + dur, self.r.uniform(0.2, 0.45), 0.3))
        if st.stopped_from is not None:
            st.kf.append((t + dur, st.cur, 'step'))
            st.kf.append((t + dur + 0.01, 0.0, 'step'))
            st.stop.append((st.stopped_from, t + dur + 0.01))
            st.stopped_from = None
            st.cur = 0.0
        st.last_t = t + dur
        self._touch(t + dur)
        return self

    def damp_all(self, t, dur=0.3):
        for s in range(1, NSTR + 1):
            self.damp(t, s, dur)
        return self

    # ------------------------------------------------------------ 渲染
    def _curves(self, st, tc):
        """按弦音分（含颤音）、是否按弦、颤音速度（用于摩擦声）。"""
        kf = sorted(st.kf, key=lambda z: z[0])
        cents = np.zeros(tc.size)
        prev_t, prev_c = kf[0][0], kf[0][1]
        cents[:] = prev_c
        for (t, c, mode) in kf[1:]:
            if mode == 'step':
                cents[tc >= t] = c
            else:
                m = tc > prev_t
                u = np.clip((tc[m] - prev_t) / max(t - prev_t, 1e-4), 0, 1)
                if mode == 'ease':
                    u = u * u * (3 - 2 * u)
                elif mode == 'out':
                    u = 1 - (1 - u) ** 2.2
                cents[m] = prev_c + (c - prev_c) * u
            prev_t, prev_c = t, c
        stopped = np.zeros(tc.size)
        ivs = list(st.stop)
        if st.stopped_from is not None:
            ivs.append((st.stopped_from, 1e9))
        for (a, b) in ivs:
            stopped[(tc >= a) & (tc < b)] = 1.0
        vib = np.zeros(tc.size)
        # 颤音在下一次换位（step 关键帧）处截止
        steps = sorted([k[0] for k in st.kf if k[2] == 'step'])
        for (t0, dur, depth, rate, kind, ph) in st.vib:
            nxt = [x for x in steps if x > t0 + 0.02]
            t_end = min(t0 + dur, nxt[0] if nxt else 1e9)
            m = (tc >= t0) & (tc < t_end)
            if not np.any(m):
                continue
            u = (tc[m] - t0) / dur
            # 吟：由大到小、略微变慢；猱：幅度更大、先向上；被下一次换位截断时 80 ms 内收住
            env = np.clip(u / 0.12, 0, 1) * (1 - u) ** (1.3 if kind == 'yin' else 0.9)
            env *= np.clip((t_end - tc[m]) / 0.08, 0, 1)
            phase = 2 * math.pi * rate * (tc[m] - t0) * (1 - 0.18 * u) + ph
            wave = np.sin(phase) + 0.18 * np.sin(2 * phase + 0.7)
            if kind == 'yin':
                wave -= 0.35          # 吟多在本音下方
            vib[m] += depth * env * wave
        return cents, stopped, vib

    def render(self, tail=11.0, t_start=None, t_end=None):
        t0 = (self.t_min if t_start is None else t_start)
        t1 = (self.t_max if t_end is None else t_end) + tail
        n = int(round((t1 - t0) * FS))
        nc = n // K_CTRL + 2
        tc = t0 + np.arange(nc) * K_CTRL / FS
        L = 2 * NSTR
        D = np.zeros((L, nc))
        G = np.zeros((L, nc))
        A = np.zeros((L, nc))
        AD = np.zeros((L, nc))
        MUTE = np.ones((L, nc))
        TAd = np.zeros((L, nc), dtype=np.int64)
        TAk = np.ones((L, nc))
        TBd = np.zeros((L, nc), dtype=np.int64)
        TBk = np.ones((L, nc))
        isV = np.zeros(L, dtype=np.bool_)
        dt_tab = disp_table()
        fric_direct = np.zeros(n)
        ev = []                                   # (sample, loop, pulse, gain)
        freq_at = {}
        for s in range(NSTR):
            st = self.strs[s]
            f_open = hz(QIN_OPEN[s]) * 2 ** (self.tune_err[s] / 1200.0)
            cents, stopped, vib = self._curves(st, tc)
            # 按弦状态平滑（损耗在 30 ms 内过渡）
            ksm = max(1, int(0.03 * FS / K_CTRL))
            stopped_s = np.convolve(stopped, np.ones(ksm) / ksm, mode='same')
            for pol in range(2):
                j = 2 * s + pol
                isV[j] = pol == 0
                det = 0.0 if pol == 0 else self.pol_det[s]
                f = f_open * 2 ** ((cents + vib + det) / 1200.0)
                p = np.clip(f_open / f, 0.1, 1.0)
                # T60：散音长、按音短（指肉吸收），高频更短；水平偏振衰减更慢
                t_lo_open = 13.0 * (65.0 / f) ** 0.45
                t_lo_stop = 9.0 * (130.0 / f) ** 0.5
                t_hi_open = 1.5
                t_hi_stop = 0.65
                t_lo = t_lo_open * (1 - stopped_s) + t_lo_stop * stopped_s
                t_hi = t_hi_open * (1 - stopped_s) + t_hi_stop * stopped_s
                if pol == 1:
                    t_lo = t_lo * 1.35
                    t_hi = t_hi * 1.2
                g, a = loss_coefs(f, t_lo, t_hi)
                cself = C_V if pol == 0 else C_H
                g = np.minimum(g / (1.0 - cself), 0.99999)
                ad = dt_tab(s, p)
                w = 2 * math.pi * f / FS
                d = FS / f - onepole_delay(w, a) - M_AP * ap_delay(w, ad)
                D[j] = d
                G[j] = g
                A[j] = a
                AD[j] = ad
                if pol == 0:
                    freq_at[s] = (f, p)
            # 止音（逐控制帧的每趟增益）
            for (tm, dur, T) in st.mute:
                m = (tc >= tm) & (tc < tm + dur)
                if np.any(m):
                    for pol in range(2):
                        j = 2 * s + pol
                        fj = FS / np.maximum(D[j, m], 8.0)
                        MUTE[j, m] = np.minimum(MUTE[j, m], 10 ** (-3.0 / (fj * T)))
            # 阻尼器
            for (arr_d, arr_k, lst) in ((TAd, TAk, st.touchA), (TBd, TBk, st.touchB)):
                for (ta, tb, frac, kap) in lst:
                    m = (tc >= ta) & (tc < tb)
                    if not np.any(m):
                        continue
                    # 8 ms 的放开过程（κ 回到 1）
                    rel = np.clip((tb - tc[m]) / 0.008, 0, 1)
                    kv = 1.0 - (1.0 - kap) * rel
                    for pol in range(2):
                        j = 2 * s + pol
                        arr_d[j, m] = np.maximum(2, np.round(frac * D[j, m] * 0.5)).astype(np.int64)
                        arr_k[j, m] = np.minimum(arr_k[j, m], kv)
            # 走手摩擦声：由按弦位置的变化速度求滑动速度
            f_v, p_v = freq_at[s]
            base_c = cents.copy()
            p_base = 2 ** (-base_c / 1200.0)
            p_vib = 2 ** (-(base_c + vib) / 1200.0)
            v_slide = np.abs(np.gradient(p_base, tc)) * LEN_M * stopped
            v_slide[v_slide > 2.5] = 0.0             # 落指/抬指是瞬间换位（不是滑），不产生摩擦声
            v_vib = np.abs(np.gradient(p_vib - p_base, tc)) * LEN_M * stopped
            v_eff = v_slide + 0.08 * v_vib
            if np.max(v_eff) > 0.004:
                vs = np.interp(t0 + np.arange(n) / FS, tc, v_eff)
                fn = friction_noise(vs, WIND[s], rng(self.seed * 131 + s * 7 + 1))
                fric_direct += fn * 0.0007
                # 一小部分注入弦里（靠近指端，激起高次分音）
                nz = np.nonzero(vs > 0.004)[0]
                if nz.size:
                    a_, b_ = nz[0], nz[-1] + 1
                    ev.append((a_, 2 * s, fn[a_:b_] * 0.0035))
                    ev.append((a_, 2 * s + 1, fn[a_:b_] * 0.0025))
        # 拨弦事件
        for (t, s, vel, finger, x) in self.plucks:
            pr = rng(self.seed * 7919 + int(round(t * 1000)) * 13 + s)     # 每个拨弦自己的随机数（改谱不牵连别处）
            i = int(round((t - t0) * FS))
            c = min(nc - 1, i // K_CTRL)
            f_open = hz(QIN_OPEN[s]) * 2 ** (self.tune_err[s] / 1200.0)
            f = f_open * 2 ** (self._cents_at(s, t) / 1200.0)
            p = f_open / f
            x_abs = (PLUCK_X if x is None else x) * (1 + pr.uniform(-0.06, 0.06))
            beta = float(np.clip(x_abs / p, 0.03, 0.45))
            pul = pluck_pulse(f, beta, vel, finger, pr)
            amp = 0.07 + 0.93 * vel ** 1.6
            # 单环路里激励从「离开岳山」处注入，要绕一整圈才到读出点：提前一个周期注入，
            # 让第一个波前正好在拨弦时刻到达岳山（起音时间精确到样本）。
            # 泛音例外：左手触点（距岳山 frac）会把一部分波前「抄近路」反射回岳山，frac 个周期就到，
            # 所以只提前 frac 个周期（否则泛音会早响 (1 - frac) 个周期，低音弦上接近 10 ms）
            lead = FS / f
            for (ta_, tb_, fr_, kp_) in self.strs[s].touchB:
                if kp_ >= 0.5 and ta_ <= t < tb_:
                    lead = min(lead, fr_ * FS / f)
            i_inj = max(0, i - int(round(lead)))
            # 右手接弦：拨之前 14 ms 手指压住拨弦点
            for pol in range(2):
                j = 2 * s + pol
                cc = np.arange(max(0, (i_inj - int(0.014 * FS)) // K_CTRL), max(0, i_inj // K_CTRL))
                if cc.size:
                    TAd[j, cc] = np.maximum(2, np.round(beta * D[j, cc] * 0.5)).astype(np.int64)
                    TAk[j, cc] = np.minimum(TAk[j, cc], 0.45)
            ev.append((i_inj, 2 * s, pul * amp * 0.58))
            ev.append((i_inj, 2 * s + 1, pul * amp * 0.82))
            if finger == 'nail':
                nl = int(0.003 * FS)
                ck = pr.standard_normal(nl) * np.exp(-np.arange(nl) / (0.0005 * FS))
                ck = signal.sosfilt(signal.butter(2, [3000, 10000], 'bandpass', fs=FS, output='sos'), ck)
                if i + nl < n:
                    fric_direct[i:i + nl] += ck * 0.0035 * amp
        ev.sort(key=lambda z: z[0])
        ev_t = np.array([e_[0] for e_ in ev], dtype=np.int64)
        ev_loop = np.array([e_[1] for e_ in ev], dtype=np.int64)
        lens = [len(e_[2]) for e_ in ev]
        ev_len = np.array(lens, dtype=np.int64)
        ev_off = np.concatenate([[0], np.cumsum(lens)[:-1]]).astype(np.int64) if ev else np.zeros(0, np.int64)
        pulses = np.concatenate([e_[2] for e_ in ev]) if ev else np.zeros(1)
        ev_gain = np.ones(len(ev))
        out = np.zeros((2, n))
        _qin_kernel(n, K_CTRL, D, G, A, AD, MUTE, TAd, TAk, TBd, TBk, isV,
                    ev_t, ev_loop, ev_off, ev_len, ev_gain, pulses.astype(np.float64), C_V, C_H, out)
        mV = out[0] * OUT_GAIN + fric_direct
        mH = out[1] * (OUT_GAIN * H_OUT)
        del out
        irV, irH = body_irs()
        st2 = np.vstack([signal.oaconvolve(mV, irV[0])[:n] + signal.oaconvolve(mH, irH[0])[:n],
                         signal.oaconvolve(mV, irV[1])[:n] + signal.oaconvolve(mH, irH[1])[:n]])
        del mV, mH
        # 两个拾音位置的微小时间差（空间感）
        sh = int(0.00035 * FS)
        st2[1] = np.concatenate([np.zeros(sh), st2[1, :-sh]])
        st2 = fade_edges(st2, 0.002, min(2.0, tail * 0.3))
        return t0, st2.astype(np.float32)

    def _cents_at(self, s, t):
        st = self.strs[s]
        c, _, v = self._curves(st, np.array([t + 0.0005]))
        return float(c[0] + v[0])
