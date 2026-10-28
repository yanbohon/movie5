"""《鲔》逐句人声处理链（全部 numpy/scipy）。

  her       她（HER）：近、干净、一点点温暖与气声；一个很短很暗的「内心空间」混响。不做水下闷声，要清楚。
  old       老鲟（OLD）：音高与共振峰一起降 1.25 个半音（重采样）再用 WSOLA 拉回原长（与字幕同步）；
            更远一点（高频少一点、低频厚一点）、混响更长更暗。
  shore     2003 江边渔民（F1）：室外、带风、略远：岸边的一次回声 + 开阔的短空间 + 跟着这句话的一点风。
  shore_far 渔家妇女（F2）朝岸上喊：更远（更窄、更多空间、电平更低）。
  near_low  研究员（R1）：近而低，网箱船甲板上的很小的空间。
  boat      跟踪船（B1）：夜里船上，近；背后的引擎在环境床里。
  boat_far  船老大（B2）：在舵位上提高声音 —— 略窄的频带（导演手册："跟踪船的对讲：带宽窄"），仍然近。
"""
from __future__ import annotations

import numpy as np

from ..sfx import dsp
from ..sfx.dsp import (SR, compress, ctrl_noise, dbg, eq, hp, integrated_lufs, lp, make_ir, pink, reverb,
                       shift_pitch_formants, softclip, tvec)

_IR = {}


def _ir(name):
    if name not in _IR:
        P = {
            # 她的"内心空间"：很短（0.42 s）、很暗（3.2 kHz 以上几乎不回来）、早期反射很淡
            "inner": dict(rt60=0.42, pre=0.008, er_n=6, er_span=0.012, er_gain=0.35, seed=201, lp_hz=3200, hp_hz=200,
                          diffusion=0.006, rt_mult=(1.1, 1.05, 1.0, 0.8, 0.55, 0.4),
                          band_gain=(0.6, 1.0, 0.9, 0.5, 0.25, 0.1)),
            # 老鲟：更大更暗的水体
            "old": dict(rt60=1.45, pre=0.024, er_n=8, er_span=0.04, er_gain=0.4, seed=202, lp_hz=2800, hp_hz=120,
                        diffusion=0.01, rt_mult=(1.3, 1.15, 1.0, 0.7, 0.45, 0.3),
                        band_gain=(1.0, 1.0, 0.85, 0.5, 0.25, 0.1)),
            "bank": dict(rt60=0.55, pre=0.015, er_n=4, er_span=0.09, er_gain=0.5, seed=203, lp_hz=6000,
                         rt_mult=(1.0, 0.95, 0.85, 0.6, 0.4, 0.3)),
            "deck": dict(rt60=0.3, pre=0.004, er_n=9, er_span=0.018, er_gain=0.7, seed=204, lp_hz=7000),
            "night": dict(rt60=1.1, pre=0.03, er_n=4, er_span=0.12, er_gain=0.4, seed=205, lp_hz=4000),
        }[name]
        _IR[name] = make_ir(**P)
    return _IR[name]


# ---------------------------------------------------------------- 积木
def adaptive_deess(x, lo=4500.0, hi=9500.0, pct=96.0, below=3.0, ratio=4.0, max_red=6.0):
    band = dsp.bp(x, lo, hi, order=2, zp=True)
    idx, lev = dsp.env_follow_db(band, 0.004, 24)
    act = lev[lev > np.max(lev) - 45]
    thr = np.percentile(act, pct) - below if len(act) else -40.0
    return dsp.deess(x, lo, hi, thr_db=thr, ratio=ratio, max_red=max_red)


def light_comp(x, ratio=2.5, pct=90.0, above=-4.0, attack=0.008, release=0.12, knee=6.0):
    idx, lev = dsp.env_follow_db(x, 0.005, 48)
    act = lev[lev > np.max(lev) - 40]
    thr = np.percentile(act, pct) + above if len(act) else -20.0
    return compress(x, thr_db=thr, ratio=ratio, knee_db=knee, attack=attack, release=release)


def delay(x, sec):
    d = int(round(sec * SR))
    return np.concatenate([np.zeros(d), x])[: len(x)]


def _prep(x, target=-23.0):
    x = np.asarray(x, dtype=float)
    if x.ndim == 2:
        x = x.mean(axis=1) if x.shape[1] <= 2 else x.mean(axis=0)
    x = dsp.dc_block(x)
    x = dsp.fade(x, 0.004, 0.025)  # TTS 首尾已裁到很紧，补一点淡入淡出防咔
    L = integrated_lufs(np.vstack([x, x]))
    return x * dbg(target - L + 3.01) if np.isfinite(L) else x


def _wind_on_voice(y, rng, amount=1.0):
    """"带风"：高频随风轻轻起伏（时变高架 ±1.5 dB，0.3–1.5 Hz）。"""
    n = len(y)
    m = np.clip(ctrl_noise(n, rng, 0.8), -2, 2) * 0.75 * amount
    hi = dsp.hp(y, 2500, order=2)
    return y + hi * (dbg(m) - 1.0)


def _wind_layer(n_voice, rng, pre=0.35, post=0.5, rel_db=-27.0):
    """跟着这句话的一点风（台词前 pre 秒淡入、后 post 秒淡出），相对人声 rel_db。"""
    n = n_voice + int((pre + post) * SR)
    w = pink(n, rng)
    w = lp(hp(w, 120, order=2), 1600, order=2)
    g = np.clip(0.6 + 0.35 * ctrl_noise(n, rng, 0.5), 0.1, 1.5)
    w = w * g ** 1.5
    w = dsp.fade(w, pre * 0.9, post * 0.9)
    return w, int(pre * SR), rel_db


# ---------------------------------------------------------------- 各链
def her(x, rng):
    y = hp(x, 75, order=2)
    y = eq(y, ("peak", 210, 0.8, 1.5), ("peak", 480, 1.2, -1.0), ("peak", 3200, 0.9, 1.0), ("highshelf", 8000, 0.7, 2.0))
    y = lp(y, 13500, order=2)
    y = adaptive_deess(y)
    y = light_comp(y, ratio=2.2, above=-4.0)
    return reverb(y, _ir("inner"), wet=0.12, pre_hp=250), 0


def old(x, rng):
    y = shift_pitch_formants(x, -1.25)
    y = hp(y, 60, order=2)
    y = eq(y, ("lowshelf", 160, 0.7, 2.0), ("peak", 900, 1.0, -0.5), ("peak", 3500, 0.9, -2.5))
    y = lp(y, 7500, order=2)
    y = light_comp(y, ratio=2.0, above=-3.0)
    return reverb(y, _ir("old"), wet=0.32, pre_hp=150), 0


def _shore(x, rng, far=False):
    y = hp(x, 135 if far else 110, order=2)
    y = eq(y, ("peak", 250, 1.0, -1.5), ("peak", 2500, 1.0, 1.5))
    if far:
        y = lp(y, 7000, order=2)
        y = eq(y, ("peak", 3500, 1.0, -2.0))
    y = light_comp(y, ratio=2.5, above=-4.0)
    y = _wind_on_voice(y, rng)
    slap = lp(delay(y, 0.085 if not far else 0.12), 3500, order=2) * dbg(-17.0 if not far else -13.0)
    st = reverb(y, _ir("bank"), wet=0.16 if not far else 0.28)
    st[:, : len(slap)] += dsp.pan(slap, -0.5)
    w, pre, rel = _wind_layer(len(y), rng)
    Lv = integrated_lufs(st)
    Lw = integrated_lufs(np.vstack([w, w]))
    w *= dbg(Lv + rel - Lw)
    out = np.zeros((2, max(st.shape[-1] + pre, len(w))))
    out[:, pre: pre + st.shape[-1]] += st
    out[:, : len(w)] += dsp.pan(w, 0.3) * 0.9
    return out, pre


def shore(x, rng):
    return _shore(x, rng, far=False)


def shore_far(x, rng):
    return _shore(x, rng, far=True)


def near_low(x, rng):
    y = hp(x, 85, order=2)
    y = eq(y, ("peak", 200, 0.8, 1.0), ("peak", 4000, 1.0, -1.0))
    y = lp(y, 12000, order=2)
    y = adaptive_deess(y)
    y = light_comp(y, ratio=2.5, above=-4.0)
    return reverb(y, _ir("deck"), wet=0.07), 0


def boat(x, rng):
    y = hp(x, 100, order=2)
    y = eq(y, ("peak", 2200, 1.0, 1.0), ("peak", 300, 1.0, -1.0))
    y = lp(y, 11000, order=2)
    y = adaptive_deess(y)
    y = light_comp(y, ratio=2.5, above=-4.0)
    return reverb(y, _ir("deck"), wet=0.1), 0


def boat_far(x, rng):
    y = hp(x, 160, order=2)
    y = lp(y, 6500, order=2)
    y = eq(y, ("peak", 1500, 1.0, 2.0), ("peak", 350, 1.0, -1.5))
    pk = np.max(np.abs(y)) + 1e-12
    y = softclip(y / pk * 1.3, 1.2) * pk
    y = light_comp(y, ratio=3.0, above=-5.0)
    st = reverb(y, _ir("deck"), wet=0.12)
    st = reverb(st, _ir("night"), wet=0.08)
    return st, 0


# ---------------------------------------------------------------- 入口
CHAIN_BY_WHO = {"HER": "her", "OLD": "old", "F1": "shore", "F2": "shore_far", "R1": "near_low", "B1": "boat", "B2": "boat_far"}
CHAINS = {"her": her, "old": old, "shore": shore, "shore_far": shore_far, "near_low": near_low, "boat": boat,
          "boat_far": boat_far}
TARGET_LUFS = {"her": -20.0, "old": -21.0, "shore": -20.5, "shore_far": -22.0, "near_low": -21.5, "boat": -21.0,
               "boat_far": -21.5}
PAN = {"shore": -0.12, "shore_far": 0.22, "boat_far": 0.15, "boat": -0.06, "old": 0.05}
# 表演方向带来的相对电平（dB），响度归一之后叠加
LEVEL_OFFSET = {
    "L01": -1.5, "L02": -0.5, "L06": -1.0, "L10": -1.5, "L11": -0.5, "L17": 0.3, "L23": 0.5, "L26": -0.8, "L29": -1.0,
    "L31": -1.5, "L36": -1.0, "L38": -0.8, "L40": -1.0, "L41": -1.5, "L42": -0.5, "L44": -0.8, "L50": -1.0, "L51": -0.8,
    "L53": -1.2, "L54": -1.2, "L55": -0.8, "L56": -1.8,
    "H01": 1.0, "H02": 0.5, "H03": 0.8, "H05": -0.8, "H06": -1.0, "H07": -0.5, "H08": 0.5, "O06": -0.8,
}


def chain_for(line_id: str, who: str) -> str:
    return CHAIN_BY_WHO[who]


def process(line_id, who, x):
    """x: 单声道配音。返回 dict(audio(2,n), pre(秒), chain, lufs)。pre = 缓冲开头到台词起点的距离（风声层先出来）。"""
    rng = np.random.default_rng(dsp.seed_of("voice5", line_id))
    ch = chain_for(line_id, who)
    src = _prep(x)
    st, pre = CHAINS[ch](src, rng)
    if st.ndim == 1:
        st = np.vstack([st, st])
    if ch in PAN:
        st = dsp.balance(st, PAN[ch])
    target = TARGET_LUFS[ch] + LEVEL_OFFSET.get(line_id, 0.0)
    L = integrated_lufs(st)
    st = st * dbg(target - L)
    st = dsp.fade(st, 0.002, 0.08)
    return dict(audio=st, pre=pre / SR, chain=ch, lufs=round(target, 2))
