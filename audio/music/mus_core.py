"""《鲔》配乐渲染上下文：时间线（卡点/台词一律从 script/timeline.json 读）、分轨/总线/混响、硬切门限、
标记、逐分轨流式渲染。骨架复制自 movie4《重构》的 mus_core.py，按本片需要改写。"""
import json
import math
import os
import numpy as np
import soundfile as sf
from mus_dsp import SR, Track, t2s, make_ir, convolve_stereo, sos_filter, db

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
TL = json.load(open(os.path.join(ROOT, 'script', 'timeline.json')))
DUR = float(TL['duration'])
N = int(round(DUR * SR))

STEMS = ['guqin', 'strings', 'hum', 'pad', 'glass', 'sub']

# 混响 IR 规格（全部程序生成）
IR_SPECS = {
    'qin_room': dict(t60=1.1, pre=0.008, hf_ratio=0.45, lf_ratio=1.1, er_gain=0.75, seed=201),
    'qin_hall': dict(t60=2.8, pre=0.024, hf_ratio=0.40, lf_ratio=1.2, er_gain=0.5, seed=202),
    'qin_far': dict(t60=4.6, pre=0.035, hf_ratio=0.30, lf_ratio=1.25, er_gain=0.35, seed=203, lp_hz=8000.0),
    'hall': dict(t60=3.2, pre=0.025, hf_ratio=0.35, lf_ratio=1.25, er_gain=0.45, seed=204),
    'far': dict(t60=6.5, pre=0.045, hf_ratio=0.28, lf_ratio=1.3, er_gain=0.3, seed=205, length=8.6, lp_hz=7000.0),
    'shimmer': dict(t60=4.0, pre=0.012, hf_ratio=0.75, lf_ratio=0.8, er_gain=0.2, n_er=8, seed=206),
}

# 总线：stem -> {bus: (ir, dry, wet)}
BUSES = {
    'guqin': {'room': ('qin_room', 1.0, 0.24), 'hall': ('qin_hall', 1.0, 0.34), 'far': ('qin_far', 1.0, 0.46),
              'dry': (None, 1.0, 0.0)},
    'strings': {'hall': ('hall', 1.0, 0.50), 'far': ('far', 0.8, 0.60)},
    'hum': {'far': ('far', 0.35, 0.85)},
    'pad': {'hall': ('hall', 1.0, 0.50), 'far': ('far', 0.6, 0.70)},
    'glass': {'shimmer': ('shimmer', 1.0, 0.60), 'far': ('far', 0.7, 0.60)},
    'sub': {'dry': (None, 1.0, 0.0)},
}


def _voice_activity():
    """用配音 wav 的真实包络求每句台词的发声起止与句中停顿（给旋律找缝隙、给质检用）。
    没有 wav 时退回 timeline 的 t / dur。"""
    out = {}
    wdir = os.path.join(ROOT, 'tts', 'volc', 'wav')
    for ln in TL['lines']:
        lid, t, d = ln['id'], float(ln['t']), float(ln['dur'])
        path = os.path.join(wdir, f'{lid}.wav')
        rec = {'t': t, 'end': t + d, 'on': t, 'off': t + d, 'gaps': []}
        if os.path.exists(path):
            x, sr = sf.read(path, dtype='float32')
            if x.ndim > 1:
                x = x.mean(1)
            hop = int(0.01 * sr)
            fr = x[:len(x) // hop * hop].reshape(-1, hop)
            e = 20 * np.log10(np.sqrt((fr ** 2).mean(1)) + 1e-9)
            act = e > e.max() - 38
            idx = np.nonzero(act)[0]
            if idx.size:
                # 句首常有一小口气（0.3–0.4 s 的弱段）：真正开口 = 第一个 ≥ 0.12 s 的连续发声段
                runs = []
                start = None
                for k in range(idx[0], idx[-1] + 2):
                    a = k <= idx[-1] and act[k]
                    if a and start is None:
                        start = k
                    elif not a and start is not None:
                        runs.append((start, k))
                        start = None
                on = next((a for a, b in runs if b - a >= 12), runs[0][0])
                rec['on'] = t + on * 0.01
                rec['off'] = t + (idx[-1] + 1) * 0.01
                for (a, b), (a2, b2) in zip(runs[:-1], runs[1:]):
                    if a2 - b >= 12 and a2 > on:
                        rec['gaps'].append((t + b * 0.01, t + a2 * 0.01))
        out[lid] = rec
    return out


class Ctx:
    def __init__(self):
        self.tl = TL
        self.marks = {m['id']: float(m['t']) for m in TL['marks']}
        self.scenes = {s['id']: (float(s['start']), float(s['end'])) for s in TL['scenes']}
        self.lines = [(ln['id'], float(ln['t']), float(ln['t']) + float(ln['dur'])) for ln in TL['lines']]
        self.voice = _voice_activity()
        self.tracks = {}
        self.post = []
        self.gates = []
        self.markers = {'themes': [], 'cuts': [], 'fades': [], 'hits': [], 'sections': []}
        self.irs = {}
        self.max_t = 0.0

    # ------------------------------------------------------------ 时间线
    def M(self, mid):
        """卡点时间（例如 'sky' 会自动补场景前缀；也可写全名 's3_2003.sky'）。"""
        if mid in self.marks:
            return self.marks[mid]
        hits = [k for k in self.marks if k.endswith('.' + mid)]
        assert len(hits) == 1, (mid, hits)
        return self.marks[hits[0]]

    def L(self, lid):
        """台词：(开始, 结束)（timeline 的 t 与 t + dur）。"""
        v = self.voice[lid]
        return v['t'], v['end']

    def on(self, lid):
        """真正开口的时刻（跳过句首那一口气）。"""
        return self.voice[lid]['on']

    def off(self, lid):
        return self.voice[lid]['off']

    def gaps(self, lid):
        """句中停顿 [(a, b)]（≥ 0.12 s）。"""
        return self.voice[lid]['gaps']

    def gap(self, lid, i, at=0.03):
        """第 i 个句中停顿开始后 at 秒。"""
        return self.voice[lid]['gaps'][i][0] + at

    def S(self, sid):
        return self.scenes[sid]

    def in_line(self, t, pad=0.0):
        """t 是否落在某句台词真正发声的区间里（去掉句中停顿）。返回台词 id 或 None。"""
        for lid, rec in self.voice.items():
            if rec['on'] - pad <= t <= rec['off'] + pad:
                if any(a + pad <= t <= b - pad for a, b in rec['gaps']):
                    return None
                return lid
        return None

    # ------------------------------------------------------------ 放置
    def add(self, stem, bus, t, x, gain=1.0):
        """放置事件。按「门限纪元」分组：同一纪元的所有声音（含混响尾巴）在下一个门限处被掐断。"""
        assert bus in BUSES[stem], (stem, bus)
        ep = sum(1 for g in self.gates if g[0] <= t + 1e-9)
        key = (stem, bus, ep)
        if key not in self.tracks:
            self.tracks[key] = Track(N)
        self.tracks[key].add(t2s(t), x, gain)
        self.max_t = max(self.max_t, t)

    def gate(self, t0, fout=0.010, label='', kind='cut'):
        """硬切：t0 之前开始的一切声音（含混响尾巴）在 [t0 - fout, t0] 内淡到 0，t0 起完全静音，
        直到 t0 之后开始的新事件。必须在添加任何 t >= t0 的事件之前声明。
        kind='fade'：同一机制的慢收（例如临终止音后把厅堂余响收净），记在 markers['fades']，不算硬切。"""
        assert self.max_t < t0 + 1e-9, f'gate {t0} declared after events at {self.max_t}'
        assert not self.gates or t0 > self.gates[-1][0]
        self.gates.append((t0, fout))
        self.markers['cuts' if kind == 'cut' else 'fades'].append(
            {'t': round(t0, 4), 'what': label, 'fade_ms': round(fout * 1000, 1),
             'how': f'门限：此前开始的所有声音连同混响尾巴在 {t0 - fout:.3f}–{t0:.3f} 内收到 0'})

    def ir(self, name):
        if name not in self.irs:
            self.irs[name] = make_ir(**IR_SPECS[name])
        return self.irs[name]

    def qin(self, phrase, bus='hall', gain=1.0, tail=11.0, t_end=None):
        """渲染一段古琴并放到 guqin 分轨。"""
        t0, x = phrase.render(tail=tail, t_end=t_end)
        self.add('guqin', bus, t0, x, gain)
        for (t, what) in phrase.hits:
            self.markers['hits'].append({'t': round(t, 4), 'what': what, 'stem': 'guqin'})
        return t0, x.shape[1] / SR

    # ------------------------------------------------------------ 标记
    def section(self, sid, start, end, notes=''):
        self.markers['sections'].append({'id': sid, 'start': round(start, 3), 'end': round(end, 3), 'notes': notes})

    def hit(self, t, what, stem='', check=True):
        """记一个音乐卡点（质检会在该时刻附近找起音）。"""
        self.markers['hits'].append({'t': round(float(t), 4), 'what': what, 'stem': stem, 'check': check})

    def theme(self, which, notes, what):
        """主题出现：notes = [(t, 音名), ...]。"""
        self.markers['themes'].append({'which': which, 'what': what,
                                       'notes': [{'t': round(t, 4), 'pitch': p} for t, p in notes],
                                       'start': round(notes[0][0], 4), 'last_note': round(notes[-1][0], 4)})

    # ------------------------------------------------------------ 渲染
    def dialog_curve(self, fade_in=0.35, fade_out=0.6):
        """对白存在曲线（0..1）：真正开口前 fade_in 秒开始下压，说完后 fade_out 秒恢复。"""
        g = np.zeros(N, dtype=np.float32)
        for lid, rec in self.voice.items():
            a, b = rec['on'], rec['off']
            i0 = max(0, t2s(a - fade_in))
            i1 = min(N, t2s(b + fade_out))
            tt = np.arange(i0, i1) / SR
            up = np.clip((tt - (a - fade_in)) / fade_in, 0, 1)
            dn = np.clip(((b + fade_out) - tt) / fade_out, 0, 1)
            w = np.minimum(up, dn)
            w = 0.5 - 0.5 * np.cos(np.pi * w)
            g[i0:i1] = np.maximum(g[i0:i1], w.astype(np.float32))
        return g

    def render_stream(self, callback, dialog_trim=None, log=print):
        """逐分轨流式渲染：总线（含混响）-> 18 Hz 高通去直流 -> 门限（硬切）-> post 事件
        -> 对白让路（慢速宽带下压，编曲层面）。每完成一个分轨调用 callback(name, stereo_float32) 后释放。"""
        from scipy import signal as _sg
        from mus_dsp import sosfilt_chunked
        hp_sos = _sg.butter(2, 18.0, btype='highpass', fs=SR, output='sos')
        dcurve = self.dialog_curve() if dialog_trim else None
        for stem in STEMS:
            acc = np.zeros((2, N), dtype=np.float32)
            for bus, spec in BUSES[stem].items():
                ir_name, dry, wet = spec
                tail = self.ir(ir_name).shape[1] if (ir_name is not None and wet > 0) else 0
                for ep in range(len(self.gates) + 1):
                    key = (stem, bus, ep)
                    if key not in self.tracks:
                        continue
                    tr = self.tracks.pop(key)
                    if ep < len(self.gates):
                        g0, gfo = self.gates[ep]
                        end = t2s(g0)
                        fo = max(1, int(gfo * SR))
                    else:
                        end, fo = N, 0
                    for (a, b) in tr.runs(gap=tail + SR):
                        if a >= end:
                            continue
                        b2 = min(N, b + tail, end)
                        x = tr.render_span(a, b2)
                        y = x * np.float32(dry)
                        if ir_name is not None and wet > 0:
                            y += convolve_stereo(x, self.ir(ir_name)) * np.float32(wet)
                        del x
                        # 18 Hz 高通（去直流）放在门限淡出之前：切点之后不会留下滤波器的尾巴
                        y = sosfilt_chunked(y, hp_sos)
                        if fo and b2 == end:
                            k = min(fo, b2 - a)
                            y[:, -k:] *= (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, k, dtype=np.float32)))
                        acc[:, a:b2] += y
                        del y
                    del tr
            for (st, t, x) in self.post:
                if st != stem:
                    continue
                i0 = t2s(t)
                L = min(x.shape[1], N - i0)
                acc[:, i0:i0 + L] += x[:, :L].astype(np.float32)
            depth = (dialog_trim or {}).get(stem, 0.0)
            if depth > 0:
                acc *= (1.0 - (1.0 - np.float32(db(-depth))) * dcurve)[None, :]
            callback(stem, acc)
            del acc
        self.post = []
