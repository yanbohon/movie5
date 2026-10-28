"""《鲔》配乐 DSP 基础库（由 movie4《重构》的 mus_dsp.py 复制后改动）：全部为纯合成（numpy / scipy / numba），不使用任何采样。

约定：
- 采样率 SR = 48000，内部 float64 计算，轨道存储 float32。
- 立体声数组形状为 (2, n)。
"""
import math
import numpy as np
from numba import njit
from scipy import signal

SR = 48000
TWO_PI = 2.0 * math.pi


def t2s(t):
    """秒 -> 采样点（四舍五入，保证卡点精确到 1 个采样）。"""
    return int(round(t * SR))


def mtof(m):
    return 440.0 * 2.0 ** ((np.asarray(m, dtype=np.float64) - 69.0) / 12.0)


def db(x):
    return 10.0 ** (x / 20.0)


def rng(seed):
    return np.random.default_rng(seed)


# ---------------------------------------------------------------- 轨道（分块稀疏存储）
class Track:
    """整片长度的立体声轨道，按块惰性分配，节省内存。"""
    CH = 1 << 18

    def __init__(self, n):
        self.n = n
        self.chunks = {}

    def add(self, start, x, gain=1.0):
        x = np.asarray(x)
        if x.ndim == 1:
            x = np.vstack([x, x])
        L = x.shape[1]
        s0 = start
        if s0 < 0:
            x = x[:, -s0:]
            L = x.shape[1]
            s0 = 0
        if s0 >= self.n or L <= 0:
            return
        L = min(L, self.n - s0)
        pos = 0
        while pos < L:
            a = s0 + pos
            ci = a // self.CH
            off = a - ci * self.CH
            take = min(self.CH - off, L - pos)
            c = self.chunks.get(ci)
            if c is None:
                c = np.zeros((2, self.CH), dtype=np.float32)
                self.chunks[ci] = c
            c[:, off:off + take] += (x[:, pos:pos + take] * gain).astype(np.float32)
            pos += take

    def empty(self):
        return len(self.chunks) == 0

    def span(self):
        """已分配块覆盖的采样区间 [a, b)。"""
        ks = sorted(self.chunks)
        return ks[0] * self.CH, min(self.n, (ks[-1] + 1) * self.CH)

    def runs(self, gap):
        """把已分配块按间隔合并成若干段 [(a, b)]；两段之间空出超过 gap 采样才分开。"""
        ks = sorted(self.chunks)
        out = []
        for k in ks:
            a = k * self.CH
            b = min(self.n, (k + 1) * self.CH)
            if out and a - out[-1][1] <= gap:
                out[-1][1] = b
            else:
                out.append([a, b])
        return [tuple(r) for r in out]

    def render_span(self, a, b):
        """取出 [a, b) 区间（float32），未分配处为 0。"""
        out = np.zeros((2, b - a), dtype=np.float32)
        for ci, c in self.chunks.items():
            ca = ci * self.CH
            cb = ca + self.CH
            lo = max(a, ca)
            hi = min(b, cb, self.n)
            if lo < hi:
                out[:, lo - a:hi - a] = c[:, lo - ca:hi - ca]
        return out

    def nbytes(self):
        return sum(c.nbytes for c in self.chunks.values())

    def render(self):
        out = np.zeros((2, self.n), dtype=np.float32)
        for ci, c in self.chunks.items():
            a = ci * self.CH
            b = min(self.n, a + self.CH)
            out[:, a:b] = c[:, :b - a]
        return out


# ---------------------------------------------------------------- 包络
def fade_edges(x, fin=0.003, fout=0.005):
    """每个音符都要短淡入淡出，防止爆音。"""
    n = x.shape[-1]
    a = min(n // 2, max(1, int(fin * SR)))
    b = min(n // 2, max(1, int(fout * SR)))
    w_in = 0.5 - 0.5 * np.cos(np.linspace(0, math.pi, a))
    w_out = 0.5 + 0.5 * np.cos(np.linspace(0, math.pi, b))
    x = x.copy()
    x[..., :a] *= w_in
    x[..., n - b:] *= w_out
    return x


def adsr(n, a, d, s, r, gate):
    """线性/指数混合 ADSR。gate 为按住时长（秒），总长 n 采样。"""
    t = np.arange(n) / SR
    env = np.zeros(n)
    a = max(a, 1e-4)
    att = t < a
    env[att] = 0.5 - 0.5 * np.cos(math.pi * t[att] / a)
    dec = (t >= a) & (t < gate)
    env[dec] = s + (1.0 - s) * np.exp(-(t[dec] - a) / max(d, 1e-4))
    lvl_at_gate = s + (1.0 - s) * math.exp(-max(gate - a, 0.0) / max(d, 1e-4)) if gate > a else \
        0.5 - 0.5 * math.cos(math.pi * min(gate / a, 1.0))
    rel = t >= gate
    env[rel] = lvl_at_gate * np.exp(-(t[rel] - gate) / max(r, 1e-4))
    return env


def swell_env(n, a, r, shape=2.0):
    """慢起慢落包络（弦乐/pad 用）：a 秒起音、末尾 r 秒释放。"""
    t = np.arange(n) / SR
    env = np.ones(n)
    if a > 0:
        m = t < a
        env[m] = (np.sin(0.5 * math.pi * t[m] / a)) ** shape
    if r > 0:
        tr = n / SR - r
        m = t > tr
        env[m] *= np.cos(0.5 * math.pi * np.clip((t[m] - tr) / r, 0, 1)) ** 1.5
    return env


def interp_env(points, n, t0=0.0):
    """分段线性自动化：points = [(t, v), ...]（t 为绝对秒），返回长度 n 的数组（起点 t0）。"""
    pts = np.asarray(points, dtype=np.float64)
    t = t0 + np.arange(n) / SR
    return np.interp(t, pts[:, 0], pts[:, 1])


# ---------------------------------------------------------------- 振荡器
@njit(cache=True, fastmath=True)
def blep_saw(freq, phase0):
    n = freq.size
    out = np.empty(n)
    ph = phase0
    for i in range(n):
        dt = freq[i] / 48000.0
        v = 2.0 * ph - 1.0
        if ph < dt:
            t = ph / dt
            v -= t + t - t * t - 1.0
        elif ph > 1.0 - dt:
            t = (ph - 1.0) / dt
            v -= t * t + t + t + 1.0
        out[i] = v
        ph += dt
        if ph >= 1.0:
            ph -= 1.0
    return out


@njit(cache=True, fastmath=True)
def blep_square(freq, phase0, pw):
    n = freq.size
    out = np.empty(n)
    ph = phase0
    for i in range(n):
        dt = freq[i] / 48000.0
        v = 1.0 if ph < pw else -1.0
        # 上升沿（ph=0）
        if ph < dt:
            t = ph / dt
            v += t + t - t * t - 1.0
        elif ph > 1.0 - dt:
            t = (ph - 1.0) / dt
            v += t * t + t + t + 1.0
        # 下降沿（ph=pw）
        p2 = ph - pw
        if p2 < 0.0:
            p2 += 1.0
        if p2 < dt:
            t = p2 / dt
            v -= t + t - t * t - 1.0
        elif p2 > 1.0 - dt:
            t = (p2 - 1.0) / dt
            v -= t * t + t + t + 1.0
        out[i] = v
        ph += dt
        if ph >= 1.0:
            ph -= 1.0
    return out


def sine(freq, n=None, phase0=0.0):
    if np.isscalar(freq):
        t = np.arange(n) / SR
        return np.sin(TWO_PI * freq * t + phase0)
    ph = phase0 + TWO_PI * np.cumsum(freq) / SR
    return np.sin(ph)


@njit(cache=True, fastmath=True)
def harm_additive(f0, amps, bright, K, phase0):
    """带限加法合成（谐波序列）：amps[k] 为第 k+1 次谐波基准幅度；
    bright[i] 为随时间变化的截止频率（Hz），逐谐波做平滑低通加权。
    自动剔除超过 19 kHz 的谐波，保证无混叠。"""
    n = f0.size
    out = np.zeros(n)
    ph = phase0
    for i in range(n):
        ph += 6.283185307179586 * f0[i] / 48000.0
        if ph > 6.283185307179586 * 1000.0:
            ph -= 6.283185307179586 * 1000.0
        s1 = math.sin(ph)
        c1 = math.cos(ph)
        sk_1 = 0.0
        sk = s1
        acc = 0.0
        fc = bright[i]
        for k in range(1, K + 1):
            fk = k * f0[i]
            if fk > 19000.0:
                break
            r = fk / fc
            w = amps[k - 1] / (1.0 + r * r * r * r)
            acc += w * sk
            # 切比雪夫递推 sin((k+1)x) = 2cos(x)sin(kx) - sin((k-1)x)
            sk_next = 2.0 * c1 * sk - sk_1
            sk_1 = sk
            sk = sk_next
        out[i] = acc
    return out


@njit(cache=True, fastmath=True)
def modal_bank(n, freqs, amp_l, amp_r, t1, t2, mix2, att, out):
    """衰减正弦（模态）合成器组：复数旋转递推，逐分音双段指数衰减。
    freqs: Hz；t1/t2: 两段衰减的时间常数（秒）；mix2: 第二段比例；att: 起音采样数。"""
    K = freqs.size
    for k in range(K):
        w = 6.283185307179586 * freqs[k] / 48000.0
        if freqs[k] >= 20000.0:
            continue
        cr = math.cos(w)
        ci = math.sin(w)
        zr = 1.0
        zi = 0.0
        d1 = math.exp(-1.0 / (t1[k] * 48000.0))
        d2 = math.exp(-1.0 / (t2[k] * 48000.0))
        e1 = 1.0 - mix2[k]
        e2 = mix2[k]
        a_s = att[k]
        al = amp_l[k]
        ar = amp_r[k]
        for i in range(n):
            env = e1 + e2
            if env < 3e-6:
                break
            if i < a_s:
                x = i / a_s
                g = x * x * (3.0 - 2.0 * x)
            else:
                g = 1.0
            v = zi * env * g
            out[0, i] += al * v
            out[1, i] += ar * v
            nr = zr * cr - zi * ci
            ni = zr * ci + zi * cr
            zr = nr
            zi = ni
            e1 *= d1
            e2 *= d2
            if (i & 4095) == 0:
                m = 1.0 / math.sqrt(zr * zr + zi * zi)
                zr *= m
                zi *= m
    return out


# ---------------------------------------------------------------- 滤波
@njit(cache=True, fastmath=True)
def svf(x, fc, q, mode):
    """TPT 状态变量滤波器（Zavalishin），fc 为逐样本数组。mode: 0 LP, 1 BP, 2 HP, 3 notch。"""
    n = x.size
    y = np.empty(n)
    ic1 = 0.0
    ic2 = 0.0
    k = 1.0 / q
    for i in range(n):
        f = fc[i]
        if f > 20000.0:
            f = 20000.0
        if f < 10.0:
            f = 10.0
        g = math.tan(3.141592653589793 * f / 48000.0)
        a1 = 1.0 / (1.0 + g * (g + k))
        a2 = g * a1
        a3 = g * a2
        v3 = x[i] - ic2
        v1 = a1 * ic1 + a2 * v3
        v2 = ic2 + a2 * ic1 + a3 * v3
        ic1 = 2.0 * v1 - ic1
        ic2 = 2.0 * v2 - ic2
        if mode == 0:
            y[i] = v2
        elif mode == 1:
            y[i] = v1 * k
        elif mode == 2:
            y[i] = x[i] - k * v1 - v2
        else:
            y[i] = x[i] - k * v1
    return y


def lp(x, fc, q=0.707):
    fcv = np.full(x.shape[-1], float(fc)) if np.isscalar(fc) else fc
    if x.ndim == 2:
        return np.vstack([svf(x[0], fcv, q, 0), svf(x[1], fcv, q, 0)])
    return svf(x, fcv, q, 0)


def hp(x, fc, q=0.707):
    fcv = np.full(x.shape[-1], float(fc)) if np.isscalar(fc) else fc
    if x.ndim == 2:
        return np.vstack([svf(x[0], fcv, q, 2), svf(x[1], fcv, q, 2)])
    return svf(x, fcv, q, 2)


def bp(x, fc, q=1.0):
    fcv = np.full(x.shape[-1], float(fc)) if np.isscalar(fc) else fc
    if x.ndim == 2:
        return np.vstack([svf(x[0], fcv, q, 1), svf(x[1], fcv, q, 1)])
    return svf(x, fcv, q, 1)


def sos_filter(x, kind, fc, order=2):
    sos = signal.butter(order, fc, btype=kind, fs=SR, output='sos')
    return signal.sosfilt(sos, x, axis=-1)


def peaking(x, f0, gain_db, q=1.0):
    """RBJ 峰值 EQ（静态）。"""
    A = 10 ** (gain_db / 40.0)
    w0 = TWO_PI * f0 / SR
    alpha = math.sin(w0) / (2 * q)
    b = np.array([1 + alpha * A, -2 * math.cos(w0), 1 - alpha * A])
    a = np.array([1 + alpha / A, -2 * math.cos(w0), 1 - alpha / A])
    return signal.lfilter(b / a[0], a / a[0], x, axis=-1)


def shelf(x, f0, gain_db, high=True, s=0.8):
    A = 10 ** (gain_db / 40.0)
    w0 = TWO_PI * f0 / SR
    alpha = math.sin(w0) / 2 * math.sqrt((A + 1 / A) * (1 / s - 1) + 2)
    cw = math.cos(w0)
    sa = 2 * math.sqrt(A) * alpha
    if high:
        b = [A * ((A + 1) + (A - 1) * cw + sa), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sa)]
        a = [(A + 1) - (A - 1) * cw + sa, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sa]
    else:
        b = [A * ((A + 1) - (A - 1) * cw + sa), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sa)]
        a = [(A + 1) + (A - 1) * cw + sa, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sa]
    b = np.array(b)
    a = np.array(a)
    return signal.lfilter(b / a[0], a / a[0], x, axis=-1)


# ---------------------------------------------------------------- 调制延迟类效果
@njit(cache=True, fastmath=True)
def mod_delay(x, dsamp):
    """分数延迟（Hermite 三次插值），dsamp 为逐样本延迟（采样点，>=2）。"""
    n = x.size
    y = np.zeros(n)
    for i in range(n):
        p = i - dsamp[i]
        ip = int(math.floor(p))
        fr = p - ip
        if ip - 1 < 0 or ip + 2 >= n:
            continue
        xm1 = x[ip - 1]
        x0 = x[ip]
        x1 = x[ip + 1]
        x2 = x[ip + 2]
        c1 = 0.5 * (x1 - xm1)
        c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2
        c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1)
        y[i] = ((c3 * fr + c2) * fr + c1) * fr + x0
    return y


def chorus(x, rate=0.35, depth_ms=3.5, base_ms=14.0, mix=0.45, seed=1):
    """立体声合唱：左右不同相位的慢速调制。输入 (2,n)。"""
    n = x.shape[1]
    t = np.arange(n) / SR
    r = rng(seed)
    out = np.empty_like(x, dtype=np.float64)
    for ch in range(2):
        ph = r.uniform(0, TWO_PI)
        mod = np.sin(TWO_PI * rate * t + ph) * 0.7 + 0.3 * np.sin(TWO_PI * rate * 1.73 * t + ph * 1.3)
        d = (base_ms + depth_ms * mod) * SR / 1000.0
        wet = mod_delay(x[ch].astype(np.float64), d)
        out[ch] = (1 - mix) * x[ch] + mix * wet
    return out


def tape(x, wow=0.0012, wow_rate=0.55, flutter=0.00035, flutter_rate=6.8, drive=1.4, lp_hz=6500.0,
         seed=3, extra_pitch=None):
    """磁带：wow/flutter（调制延迟）+ 软饱和 + 高频滚降 + 头部低频鼓包。
    wow/flutter 以相对音高偏差给出；extra_pitch 可叠加额外的延迟曲线（采样点）。"""
    n = x.shape[1]
    t = np.arange(n) / SR
    r = rng(seed)
    # 相对音高偏差 p(t) -> 延迟 d(t) = -∫p dt
    ph1 = r.uniform(0, TWO_PI)
    ph2 = r.uniform(0, TWO_PI)
    d = (wow * SR / (TWO_PI * wow_rate)) * (1.0 - np.cos(TWO_PI * wow_rate * t + ph1)) \
        + (flutter * SR / (TWO_PI * flutter_rate)) * (1.0 - np.cos(TWO_PI * flutter_rate * t + ph2))
    d = d + 40.0
    if extra_pitch is not None:
        d = d + extra_pitch
    out = np.empty((2, n))
    for ch in range(2):
        y = mod_delay(x[ch].astype(np.float64), d + (0.6 if ch else 0.0))
        out[ch] = y
    # 软饱和（保持小信号增益为 1）
    out = np.tanh(drive * out) / drive
    out = shelf(out, 110.0, 1.5, high=False)
    out = sos_filter(out, 'lowpass', lp_hz, 2)
    return out


def sat(x, drive=2.0):
    return np.tanh(drive * x) / np.tanh(drive)


def pan_gains(p):
    """等功率声像，p ∈ [-1, 1]。"""
    a = (p + 1.0) * 0.25 * math.pi
    return math.cos(a), math.sin(a)


def pan(x, p):
    gl, gr = pan_gains(p)
    return np.vstack([x * gl, x * gr])


def width(x, w):
    m = 0.5 * (x[0] + x[1])
    s = 0.5 * (x[0] - x[1]) * w
    return np.vstack([m + s, m - s])


# ---------------------------------------------------------------- 混响脉冲响应（全合成）
def make_ir(t60=2.5, length=None, pre=0.018, hf_ratio=0.35, lf_ratio=1.25, n_er=18, er_span=0.075,
            er_gain=0.55, diffuse_rise=0.045, lp_hz=11000.0, hp_hz=70.0, seed=7):
    """生成去相关立体声 IR：早期反射 + 频率相关衰减的指数噪声尾巴。
    t60：1 kHz 处的混响时间；hf_ratio：8 kHz 处 T60 比例；lf_ratio：125 Hz 处比例。"""
    if length is None:
        length = min(t60 * 1.25 + pre + 0.1, 9.0)
    n = int(length * SR)
    r = rng(seed)
    t = np.arange(n) / SR
    edges = [0, 180, 360, 720, 1440, 2880, 5760, 11520, 24000]
    ir = np.zeros((2, n))
    for ch in range(2):
        noise = r.standard_normal(n)
        tail = np.zeros(n)
        for bi in range(len(edges) - 1):
            lo, hi = edges[bi], edges[bi + 1]
            fcen = math.sqrt(max(lo, 60) * hi)
            # 对数频率插值 T60
            lf = math.log2(fcen / 1000.0)
            if lf < 0:
                ratio = 1.0 + (lf_ratio - 1.0) * min(1.0, -lf / 3.0)
            else:
                ratio = 1.0 + (hf_ratio - 1.0) * min(1.0, lf / 3.0)
            T = max(0.05, t60 * ratio)
            if lo == 0:
                band = sos_filter(noise, 'lowpass', hi, 4)
            elif hi >= 24000:
                band = sos_filter(noise, 'highpass', lo, 4)
            else:
                band = sos_filter(noise, 'bandpass', [lo, hi], 3)
            tail += band * np.exp(-6.907755 * np.maximum(t - pre, 0) / T)
        # 扩散建立：pre 之前为 0，之后平滑上升
        rise = np.clip((t - pre) / diffuse_rise, 0, 1)
        tail *= np.sin(0.5 * math.pi * rise) ** 2
        # 早期反射
        er = np.zeros(n)
        taps = np.sort(r.uniform(0.004, er_span, n_er))
        for k, tt in enumerate(taps):
            idx = int((tt + pre * 0.35) * SR)
            if idx < n:
                er[idx] += r.choice([-1.0, 1.0]) * (0.9 ** k) * r.uniform(0.5, 1.0)
        er = sos_filter(er, 'lowpass', 7000, 2)
        tail /= np.sqrt(np.sum(tail ** 2)) + 1e-12
        er /= np.sqrt(np.sum(er ** 2)) + 1e-12
        ir[ch] = tail + er_gain * er
    ir = sos_filter(ir, 'lowpass', lp_hz, 2)
    ir = sos_filter(ir, 'highpass', hp_hz, 2)
    # 末尾淡出，防止截断
    fo = int(0.25 * SR)
    ir[:, -fo:] *= np.linspace(1, 0, fo) ** 2
    ir /= np.sqrt(np.mean(np.sum(ir ** 2, axis=1)))
    return ir


def convolve_stereo(x, ir):
    """x: (2,n)；ir: (2,m)；左右各自卷积（去相关 IR 带来宽度）。输出与 x 等长（float32）。"""
    n = x.shape[1]
    out = np.empty((2, n), dtype=np.float32)
    for ch in range(2):
        y = signal.oaconvolve(x[ch].astype(np.float32, copy=False), ir[ch].astype(np.float32))
        out[ch] = y[:n]
        del y
    return out


def sosfilt_chunked(x, sos, chunk=SR * 10):
    """float32 分块 IIR 滤波（保持状态），避免整段 float64 临时数组。x: (2,n)，原地返回新数组。"""
    out = np.empty_like(x, dtype=np.float32)
    zi = np.zeros((sos.shape[0], x.shape[0], 2), dtype=np.float64)
    for a in range(0, x.shape[1], chunk):
        seg = x[:, a:a + chunk].astype(np.float64)
        y, zi = signal.sosfilt(sos, seg, axis=-1, zi=zi)
        out[:, a:a + chunk] = y.astype(np.float32)
    return out


def convolve_clip(x, ir):
    """短片段卷积：输出长度 = n + m - 1（保留完整尾巴）。"""
    out = []
    for ch in range(2):
        out.append(signal.oaconvolve(x[ch], ir[ch]))
    return np.vstack(out)


@njit(cache=True, fastmath=True)
def _pingpong_core(mono, d, fb):
    """左声道：第 1、3、5… 次回声（增益 1, fb², …）；右声道：第 2、4… 次（fb, fb³, …）。"""
    n = mono.size
    yl = np.zeros(n, dtype=np.float32)
    yr = np.zeros(n, dtype=np.float32)
    for i in range(d, n):
        yl[i] = mono[i - d] + fb * yr[i - d]
        yr[i] = fb * yl[i - d]
    return yl, yr


def pingpong(x, delay_s, fb=0.35, mix=0.25, lp_hz=5000.0, hp_hz=300.0):
    """乒乓延迟（输入 (2,n)），float32；回声先左后右交替，每次往返衰减 fb。"""
    d = int(delay_s * SR)
    mono = (0.5 * (x[0] + x[1])).astype(np.float32)
    sos = signal.butter(1, [hp_hz, lp_hz], btype='bandpass', fs=SR, output='sos')
    mono = signal.sosfilt(sos, mono).astype(np.float32)
    yl, yr = _pingpong_core(mono, d, np.float32(fb))
    out = np.empty((2, x.shape[1]), dtype=np.float32)
    out[0] = x[0] + np.float32(mix) * yl
    out[1] = x[1] + np.float32(mix) * yr
    return out


def reverse_swell(x, ir, dur):
    """反向膨胀：音频卷积长混响后反转，截取末尾 dur 秒（结束处即目标时间点）。"""
    wet = convolve_clip(x, ir)
    rev = wet[:, ::-1]
    n = int(dur * SR)
    rev = rev[:, -n:] if rev.shape[1] >= n else np.pad(rev, ((0, 0), (n - rev.shape[1], 0)))
    env = np.linspace(0, 1, n) ** 1.5
    return rev * env


def noise(n, seed=0):
    return rng(seed).standard_normal(n)


def pink(n, seed=0):
    """粉红噪声（频域 1/f 整形）。"""
    w = rng(seed).standard_normal(n)
    X = np.fft.rfft(w)
    f = np.fft.rfftfreq(n, 1 / SR)
    f[0] = f[1]
    X /= np.sqrt(f / 20.0)
    y = np.fft.irfft(X, n)
    return y / (np.std(y) + 1e-12)
