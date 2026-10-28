"""《鲔》最终混音（音效与混音：子代理 E）。

一条命令重建（在 /Users/yednc/Dev/movie5 下）：
  .venv/bin/python audio/build_mix.py [--music PATH] [--music-source auto|mix|stems|none] [--music-gain auto|dB]
                                      [--no-collect] [--no-m4a] [--no-png] [--no-mem-check]

流程：
  0. node tools/collect_events.mjs → audio/visual_events.json（各场景 events.js 的真实画面时刻；没有 node / 没有事件就跳过）
  1. audio/sfx/cuesheet.py 从 script/timeline.json + audio/visual_events.json 重写 audio/cues.json
     （每一类音效打印"用了 visual_events 还是 marks 推算"）
  2. 环境床：每条在单独的短命子进程里渲染（最吃内存的一步，算完整块还给系统）
  3. 台词：tts/volc/wav/<id>.wav → 逐句处理链（audio/voice/chains.py）→ 放在 timeline.lines 的 t；
     对白峰值控制；由对白生成侧链闪避曲线，环境床整条乘上去
  4. 单次音效（纯代码合成）；画面硬切（dam_line、crash）连混响尾巴一起收；逐个量起音误差
  5. 配乐 audio/out/music.wav（子代理 D；没有就按静音）：推子 = 对白积分响度 -3 dB，对白侧链 -6 dB，
     对白保护（逐句语音频段信噪比 < 11 dB 时再压配乐，最多 6 dB）
  6. 母带：轻胶水压缩 + 真峰值前瞻限幅 → 积分 -16 LUFS、真峰值 ≤ -1 dBTP；片尾最后 1 s 余弦淡到数字静音
     （母带增益曲线同样乘到四条分轨上：四条分轨相加 = 总混音）
  7. 输出 out/audio/mix.wav（485.192 s，48 kHz，24-bit 立体声）、stems/{dialogue,music,sfx,amb}.wav、mix.m4a
  8. 自检与报告 mix_report.json、mix_spectrogram.png / mix_spectrogram_rows.png（起音误差、嘀的周期与截断、
     每句语音频段信噪比、削波/爆音/直流/短循环/环境床音高）

内存：整片总线都是 float32（每条立体声 485 s ≈ 186 MB），响度/真峰值/频谱分块算；开跑前检查 memory_pressure，
空闲低于 25% 就等；报告里记录主进程与床子进程的峰值内存。
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import resource
import shutil
import subprocess
import sys
import time
from fractions import Fraction
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import ndimage, signal

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from audio import qa  # noqa: E402
from audio.sfx import cuesheet, dsp, library, viz  # noqa: E402
from audio.voice import chains  # noqa: E402

SR = dsp.SR
F32 = np.float32
FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
TIMELINE = json.loads((ROOT / "script/timeline.json").read_text())
DUR = float(TIMELINE["duration"])
N = int(round(DUR * SR))

DUCK = dict(music_db=-6.0, amb_db=-5.0, lookahead=0.05, attack=0.12, release=0.70, hold=0.25,
            thr_db=-45.0, knee_db=10.0, rms_win=0.03)
RIDER = dict(target_snr_db=11.0, max_extra_db=-6.0, pre=0.3, post=0.6, min_music_share=0.2)
MUSIC_LEVEL = dict(rel_to_dialogue_db=-3.0)
DLG_LIMIT = dict(plr_db=13.0, lookahead=0.002, release=0.06)
MASTER = dict(target_lufs=-16.0, tp_ceiling=-1.0, tp_internal=-1.3, glue_ratio=1.6, glue_knee=6.0,
              glue_attack=0.03, glue_release=0.25, glue_max_gr=3.0, lim_lookahead=0.003, lim_release=0.08,
              end_fade=1.0)
STEM_DUCK = [
    (("pad", "string", "piano", "lead", "melody", "vox", "choir", "keys", "arp", "synth", "bell", "organ", "theme",
      "qin", "guqin", "glass"), -7.0),
    (("drum", "kick", "perc", "hat", "bass", "sub", "timp", "beat"), -4.0),
]
CUT_FADE = 0.012        # 画面硬切处的收尾（秒）：足够短 = 硬切，又不出咔哒
SYNC_TOL_MS = 1000.0 / 30  # 1 帧
MEM_MIN_FREE = 25


def log(*a):
    print(*a, flush=True)


def _rel(p):
    p = Path(p).resolve()
    try:
        return str(p.relative_to(ROOT))
    except ValueError:
        return str(p)


def wait_for_memory(min_free=MEM_MIN_FREE, tries=45, wait=20):
    free = None
    for i in range(tries):
        try:
            out = subprocess.run(["memory_pressure"], capture_output=True, text=True, timeout=60).stdout
            m = re.search(r"free percentage:\s*(\d+)%", out)
            free = int(m.group(1)) if m else None
        except (OSError, subprocess.SubprocessError):
            return None
        if free is None or free >= min_free:
            return free
        log(f"  系统空闲内存 {free}% < {min_free}%，{wait} s 后重试（{i + 1}/{tries}）")
        time.sleep(wait)
    raise SystemExit(f"系统空闲内存持续低于 {min_free}%（最后 {free}%），放弃本次混音")


def peak_rss_mb():
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r / (1024 * 1024) if sys.platform == "darwin" else r / 1024


def trim_heap():
    """把 malloc 缓存着的空闲大块还给系统（macOS 的 malloc 会留着刚释放的大块备用，RSS 看起来就一路涨）。
    每一大步之后调一次，后面各步的内存水位就只算真在用的数组。"""
    if sys.platform == "darwin":
        try:
            import ctypes
            ctypes.CDLL("/usr/lib/libSystem.B.dylib").malloc_zone_pressure_relief(None, 0)
        except (OSError, AttributeError):
            pass


def zeros2():
    return np.zeros((2, N), dtype=F32)


def read_audio(path, mono=False):
    if not mono and sf.info(str(path)).samplerate == SR:
        return read_back(path)  # 整片长的配乐：分块读进 (2, n)，不多开整份
    x, sr = sf.read(str(path), always_2d=True, dtype="float32")
    x = x.T
    if sr != SR:
        fr = Fraction(SR, sr).limit_denominator(1000)
        x = signal.resample_poly(x, fr.numerator, fr.denominator, axis=-1).astype(F32)
    if mono:
        return x.mean(axis=0)
    if x.shape[0] == 1:
        x = np.vstack([x[0], x[0]])
    return np.ascontiguousarray(x[:2])


# ================================================================ 0. 画面事件
def collect_events(warnings):
    tool = ROOT / "tools/collect_events.mjs"
    node = shutil.which("node")
    if not node or not tool.exists():
        warnings.append("没有 node 或 tools/collect_events.mjs，沿用现有 audio/visual_events.json（若有）")
        return None
    try:
        r = subprocess.run([node, str(tool)], cwd=str(ROOT), capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        warnings.append(f"collect_events 失败：{e}")
        return None
    out = (r.stdout + r.stderr).strip()
    for line in out.splitlines()[-12:]:
        log(f"  [collect_events] {line}")
    if r.returncode != 0:
        warnings.append(f"collect_events 退出码 {r.returncode}（沿用现有 visual_events.json）：{out[-300:]}")
    return out


# ================================================================ 2. 台词
def build_dialogue(timeline, warnings):
    bus = zeros2()
    recs = []
    for item in timeline["lines"]:
        lid, t, who = item["id"], float(item["t"]), item["who"]
        f = ROOT / "tts/volc/wav" / f"{lid}.wav"
        x = read_audio(f, mono=True).astype(np.float64)
        src_dur = len(x) / SR
        if abs(src_dur - float(item["dur"])) > 0.05:
            warnings.append(f"{lid}: 配音时长 {src_dur:.2f} s 与 timeline dur {item['dur']} 不一致（重跑 script/build_timeline.py）")
        r = chains.process(lid, who, x)
        i0 = int(round((t - r["pre"]) * SR))
        dsp.add_at(bus, r["audio"].astype(F32), i0)
        recs.append(dict(id=lid, who=who, t=t, end=round(t + src_dur, 3), dur=round(src_dur, 3), chain=r["chain"],
                         target_lufs=r["lufs"], file=_rel(f), text=item["text"]))
        log(f"  {lid} {who:3s} {r['chain']:9s} t={t:7.2f} dur={src_dur:5.2f}")
    for a, b in zip(recs, recs[1:]):
        if a["end"] > b["t"] - 0.15:
            warnings.append(f"台词重叠/过近：{a['id']} 结束 {a['end']:.2f} s，{b['id']} 开始 {b['t']:.2f} s")
    return bus, recs


# ================================================================ 3. 音效与环境床
def _to_rel(p, t0):
    q = {}
    for k, v in p.items():
        if k.endswith("_at"):
            q[k] = [round(float(x) - t0, 4) for x in v] if isinstance(v, (list, tuple)) else round(float(v) - t0, 4)
        elif k.endswith("_env") and v:
            q[k] = [(round(float(a) - t0, 4), float(b)) for a, b in v]
        else:
            q[k] = v
    return q


def _seed_params(c):
    name = c.get("sfx") or c.get("bed")
    t = float(c["t"])
    p = dict(c.get("p", {}))
    seed_p = p.pop("seed", None)
    seed = (dsp.seed_of(name, t) if seed_p is None else dsp.seed_of(name, seed_p)) % 2 ** 31
    return name, t, seed, _to_rel(p, t)


def _render_bed_job(c):
    """子进程里渲染一条环境床（加增益/淡入淡出/声像，转 float32），顺带做床自检。进程结束内存全部还给系统。"""
    name, t, seed, p = _seed_params(c)
    end = float(c["end"])
    r = library.render(name, seed=seed, dur=end - t, **p)
    rep = qa.bed_report(f"{c['id']} {name} {t:.1f}–{end:.1f}", r["audio"])
    a = r["audio"]
    del r
    a *= dsp.dbg(float(c.get("gain_db", 0.0)))
    a = dsp.fade(a, max(float(c.get("fade_in", 0.5)), 0.01), max(float(c.get("fade_out", 0.5)), 0.01))
    if c.get("pan"):
        a = dsp.balance(a, float(c["pan"]))
    return a.astype(F32), rep, peak_rss_mb()


def render_beds(cues):
    """环境床：每条床在单独的短命子进程里渲染（床是整段几十秒的 float64 运算，一条就要几百 MB 到 1 GB 临时内存；
    放在子进程里，算完内存整块还给系统，主进程只收一条 float32 结果）。子进程一次只跑一个。
    返回 (amb 需闪避, amb 不闪避 或 None, recs, 床自检, 子进程峰值 MB)。闪避在对白做完后整条乘上去。"""
    import multiprocessing as mp
    from concurrent.futures import ProcessPoolExecutor
    amb = zeros2()
    amb_nd = None
    recs, beds, child_peak = [], [], 0.0
    jobs = [c for c in cues if "bed" in c]
    with ProcessPoolExecutor(max_workers=1, mp_context=mp.get_context("spawn"), max_tasks_per_child=1) as ex:
        for c, (a, rep, pk) in zip(jobs, ex.map(_render_bed_job, jobs)):
            beds.append(rep)
            child_peak = max(child_peak, pk)
            t, end = float(c["t"]), float(c["end"])
            i0 = int(round(t * SR))
            a0, a1 = max(0, i0), min(N, i0 + a.shape[-1])
            if a1 > a0:
                if c.get("duck", True):
                    dsp.add_at(amb, a[:, a0 - i0: a1 - i0], a0)
                else:
                    if amb_nd is None:
                        amb_nd = zeros2()
                    dsp.add_at(amb_nd, a[:, a0 - i0: a1 - i0], a0)
            del a
            recs.append(dict(id=c["id"], name=c["bed"], kind="bed", t=t, start=t, end=end, gain_db=c.get("gain_db", 0.0),
                             scene=c.get("scene", ""), duck=c.get("duck", True)))
    return amb, amb_nd, recs, beds, child_peak


PING_PARTS = []  # (起点秒, 音频, mode)：信标"嘀"单独留一份，自检时拼一条只有嘀的局部总线


def _ping_bus(t0, t1, modes=("air", "uw")):
    """只含指定 mode 的嘀的局部立体声总线（t0–t1 秒）。"""
    n = int(round((t1 - t0) * SR))
    bus = np.zeros((2, n), dtype=F32)
    for st, a, mode in PING_PARTS:
        if mode in modes:
            dsp.add_at(bus, a, int(round((st - t0) * SR)))
    return bus


def _duck_seg(shape, hop, i0, n, depth_db):
    """侧链闪避形状（控制率，0..1）取 [i0, i0+n) 这一段，换成逐采样的线性增益（depth_db·shape）。"""
    idx = np.arange(i0, i0 + n, dtype=np.float64)
    g = np.interp(idx, np.arange(len(shape), dtype=np.float64) * hop, shape, left=0.0, right=0.0)
    return (10.0 ** (depth_db * g / 20.0)).astype(F32)


def render_cues(cues, duck_shape=None, hop=48):
    """单次音效（环境床另见 render_beds）。带 duck_db 的持续性音效在台词处跟着对白侧链闪避。"""
    sfx = zeros2()
    recs, events, syncs = [], [], []
    for c in cues:
        if "bed" in c:
            continue
        name, t, seed, p = _seed_params(c)
        gain = dsp.dbg(float(c.get("gain_db", 0.0)))
        r = library.render(name, seed=seed, **p)
        a = r["audio"] * gain
        if c.get("pan"):
            a = dsp.balance(a, float(c["pan"]))
        start = t - r["pre"]
        i_sync = int(round(r["pre"] * SR))
        if c.get("duck_db") and duck_shape is not None:
            a *= _duck_seg(duck_shape, hop, int(round(start * SR)), a.shape[-1], float(c["duck_db"]))[None, :]
        cut = None
        if c.get("cut_at") is not None:  # 画面硬切：连混响尾巴一起收
            keep = max(0, int(round((float(c["cut_at"]) - start) * SR)))
            if keep < a.shape[-1]:
                a = a[:, :keep].copy()
                nf = min(keep, int(CUT_FADE * SR))
                if nf > 0:
                    a[:, keep - nf:] *= 0.5 * (1 + np.cos(np.linspace(0, np.pi, nf)))
                cut = float(c["cut_at"])
        if a.shape[-1] == 0:
            recs.append(dict(id=c["id"], name=name, kind="oneshot", t=t, skipped="cut before start"))
            continue
        env = np.max(np.abs(a), axis=0)
        pk = float(env.max()) + 1e-12
        nz = np.nonzero(env > dsp.dbg(-60) * pk)[0]
        aud_end = start + (nz[-1] / SR if len(nz) else a.shape[-1] / SR)
        edge = dict(start_db=round(float(dsp.to_db(env[:8].max() / pk)), 1),
                    end_db=round(float(dsp.to_db(env[-8:].max() / pk)), 1))
        if c.get("check"):
            err = qa.measure_sync(a, i_sync, c["check"])
            syncs.append(dict(id=c["id"], name=name, label=c.get("note", "")[:40], target=round(t, 4),
                              measured=round(t + err, 4) if err is not None else None, kind=c["check"],
                              err_ms=round(err * 1000, 1) if err is not None else None, src=c.get("src", "marks")))
        for s in c.get("sub", []):
            i = int(round((float(s["t"]) - start) * SR))
            err = qa.measure_sync(a, i, s["kind"], search=(0.15, 0.15))
            syncs.append(dict(id=c["id"], name=name, label=s["label"], target=round(float(s["t"]), 4),
                              measured=round(float(s["t"]) + err, 4) if err is not None else None, kind=s["kind"],
                              err_ms=round(err * 1000, 1) if err is not None else None, src=c.get("src", "marks")))
        dsp.add_at(sfx, a.astype(F32), int(round(start * SR)))
        if name == "beacon_ping":
            PING_PARTS.append((start, a.astype(F32), c["p"].get("mode", "air")))
        recs.append(dict(id=c["id"], name=name, kind="oneshot", t=t, start=round(start, 4), end=round(aud_end, 4),
                         gain_db=c.get("gain_db", 0.0), peak_dbfs=round(float(dsp.to_db(pk)), 2), cut_at=cut,
                         edge=edge, scene=c.get("scene", "")))
        if r["events"]:
            events.append(dict(id=c["id"], sfx=name, t=t, note=c.get("note", ""),
                               events=[round(t + e, 4) for e in r["events"]][:64]))
        del a, r
    return sfx, recs, events, syncs


# ================================================================ 4. 配乐
def music_sources(args, warnings):
    mix_path = Path(args.music) if args.music else ROOT / "audio/out/music.wav"
    stems_dir = ROOT / "audio/out/stems"
    stem_files = sorted(stems_dir.glob("music_*.wav")) if stems_dir.exists() else []
    src = args.music_source
    if src == "auto":
        src = "mix" if mix_path.exists() else ("stems" if stem_files else "none")
    info = dict(source=src)
    if src == "none" or (src == "mix" and not mix_path.exists()) or (src == "stems" and not stem_files):
        if src != "none":
            warnings.append(f"配乐来源 {src} 不存在，使用静音")
        info.update(source="none", note=("按 --music-source none：音乐总线为静音" if args.music_source == "none"
                                         else "配乐缺失（audio/out/music.wav 还没有）：音乐总线为静音"))
        return [], info
    if src == "stems":
        parts = []
        for f in stem_files:
            depth = DUCK["music_db"]
            low = f.stem.lower()
            for keys, d in STEM_DUCK:
                if any(k in low for k in keys):
                    depth = d
                    break
            parts.append(dict(name=f.stem, path=f, duck_db=depth))
        info.update(files=[_rel(f) for f in stem_files])
        return parts, info
    info.update(files=[_rel(mix_path)], mtime=_dt.datetime.fromtimestamp(mix_path.stat().st_mtime).isoformat(timespec="seconds"))
    return [dict(name="music", path=mix_path, duck_db=DUCK["music_db"])], info


def load_music_part(part, warnings=None):
    x = read_audio(part["path"])
    n = x.shape[-1]
    if warnings is not None and abs(n - N) > int(0.05 * SR):
        warnings.append(f"{Path(part['path']).name} 长度 {n / SR:.3f} s ≠ {DUR:.3f} s（已补零/截断）")
    return np.ascontiguousarray(dsp.pad_to(x, N), dtype=F32)


# ================================================================ 侧链
def _pow2(x, chunk=1 << 20):
    """立体声 → 每采样平均功率（float32，分块算，不开整长的临时数组）。"""
    n = x.shape[-1]
    p = np.empty(n, dtype=F32)
    for a in range(0, n, chunk):
        b = min(n, a + chunk)
        s0, s1 = x[0, a:b], x[1, a:b]
        p[a:b] = 0.5 * (s0 * s0 + s1 * s1)
    return p


def duck_key(dlg):
    hop = 48
    p = _pow2(dlg)
    p = dsp.filt1d_chunked(ndimage.uniform_filter1d, p, int(DUCK["rms_win"] * SR), mode="constant")
    lev = 10 * np.log10(p[::hop].astype(np.float64) + 1e-14)
    del p
    key = np.clip((lev - DUCK["thr_db"]) / DUCK["knee_db"], 0, 1)
    hn = int(DUCK["hold"] * SR / hop) | 1
    key = ndimage.maximum_filter1d(key, size=hn, origin=(hn - 1) // 2)
    la = int(DUCK["lookahead"] * SR / hop)
    key = np.concatenate([key[la:], np.zeros(la)])
    return key, hop


def duck_gain_db(key, hop, depth_db):
    g = dsp.smooth_ar(depth_db * key, DUCK["attack"], DUCK["release"], hop)
    return dsp.upsample_ctrl(g, hop, N)


# ================================================================ 对白保护
_SB_SOS = signal.butter(4, [300, 4000], btype="bandpass", fs=SR, output="sos")
_FL = int(0.05 * SR)


def band_seg(x, a, b, pre=int(0.5 * SR)):
    a0 = max(0, a - pre)
    y = signal.sosfilt(_SB_SOS, np.asarray(x[:, a0:b], dtype=np.float64), axis=-1)
    return y[:, a - a0:]


def _energy_frames(xb, fl=_FL):
    seg = np.mean(xb ** 2, axis=0)
    m = len(seg) // fl
    return seg[: m * fl].reshape(m, fl).mean(axis=1) if m > 0 else np.array([np.mean(seg)])


def line_snr(dlg, bg, a, b):
    d = _energy_frames(band_seg(dlg, a, b))
    g = _energy_frames(band_seg(bg, a, b))
    act = d > d.max() * 10 ** (-30 / 10)
    if not act.any():
        return None
    mean_snr = 10 * np.log10(d[act].sum() / (g[act].sum() + 1e-15))
    fr = 10 * np.log10(d[act] / (g[act] + 1e-15))
    return mean_snr, float(np.percentile(fr, 10))


def rider(lines, dlg, music_d, amb_d, sfx):
    if music_d is None:
        return None, {}
    g = np.zeros(N, dtype=F32)
    res = {}
    for ln in lines:
        a, b = int(ln["t"] * SR), min(N, int(ln["end"] * SR))
        pre = min(a, int(0.5 * SR))
        d = _energy_frames(band_seg(dlg, a, b))
        act = d > d.max() * 10 ** (-30 / 10)
        if not act.any():
            continue
        other = sfx[:, a - pre:b] + amb_d[:, a - pre:b]
        em = _energy_frames(band_seg(music_d, a, b))[act].sum()
        eo = _energy_frames(band_seg(other, pre, other.shape[-1]))[act].sum()
        ed = d[act].sum()
        snr = 10 * np.log10(ed / (em + eo + 1e-15))
        need = RIDER["target_snr_db"] - snr
        extra = 0.0
        if need > 0 and em > RIDER["min_music_share"] * (em + eo):
            allowed = ed / 10 ** (RIDER["target_snr_db"] / 10) - eo
            extra = RIDER["max_extra_db"] if allowed <= 0 else max(RIDER["max_extra_db"], min(0.0, 10 * np.log10(allowed / em)))
        res[ln["id"]] = dict(extra_db=round(extra, 2), snr_before_db=round(snr, 1))
        if extra < 0:
            ta, tb = ln["t"] - RIDER["pre"], ln["end"] + RIDER["post"]
            ia, ib = max(0, int(ta * SR)), min(N, int(np.ceil(tb * SR)) + 1)
            t0 = ia / SR
            env = dsp.env_pts(ib - ia, [(max(0.0, ta) - t0, 0.0), (ln["t"] - t0, extra), (ln["end"] - t0, extra),
                                        (tb - t0, 0.0)], "cos").astype(F32)
            np.minimum(g[ia:ib], env, out=g[ia:ib])
    return g, res


# ================================================================ 5. 母带
def glue_gain_db(x):
    hop = 48
    p = _pow2(x)
    p = dsp.filt1d_chunked(ndimage.uniform_filter1d, p, int(0.02 * SR), mode="constant")
    lev = 10 * np.log10(p[::hop].astype(np.float64) + 1e-14)
    del p
    act = lev[lev > lev.max() - 50]
    thr = float(np.percentile(act, 95)) - 6.0 if len(act) else -20.0
    over = lev - thr
    k = MASTER["glue_knee"]
    r = MASTER["glue_ratio"]
    gr = np.where(over <= -k / 2, 0.0, np.where(over >= k / 2, (1 / r - 1) * over, (1 / r - 1) * (over + k / 2) ** 2 / (2 * k)))
    gr = np.maximum(gr, -MASTER["glue_max_gr"])
    g = dsp.smooth_ar(gr, MASTER["glue_attack"], MASTER["glue_release"], hop)
    return dsp.upsample_ctrl(g, hop, x.shape[-1]), thr


def limiter_gain(y, ceiling_db, lookahead=None, release=None):
    lookahead = lookahead or MASTER["lim_lookahead"]
    release = release or MASTER["lim_release"]
    g = dsp.true_peak_env(y)
    np.maximum(g, F32(1e-12), out=g)
    np.divide(F32(dsp.dbg(ceiling_db)), g, out=g)
    np.minimum(g, F32(1.0), out=g)
    if g.min() >= 1.0:
        return np.ones(y.shape[-1], dtype=F32)
    L = int(lookahead * SR) | 1
    g = dsp.filt1d_chunked(ndimage.minimum_filter1d, g, 2 * L - 1, mode="nearest")
    g = dsp.filt1d_chunked(ndimage.uniform_filter1d, g, L, mode="nearest")
    np.maximum(g, F32(1e-9), out=g)
    gdb = np.log10(g)
    del g
    gdb *= F32(20.0)
    R = int(release * SR) | 1
    W = R // 2
    h = dsp.filt1d_chunked(ndimage.minimum_filter1d, gdb, R, origin=(R - 1) // 2, mode="nearest")
    rel = dsp.filt1d_chunked(ndimage.uniform_filter1d, h, W, origin=-(W // 2), mode="nearest")
    del h
    np.minimum(gdb, rel, out=gdb)
    del rel
    gdb /= F32(20.0)
    return np.power(F32(10.0), gdb, out=gdb)


def end_fade_curve():
    """片尾最后 end_fade 秒余弦淡到 0（最后一个采样 = 0），开头 5 ms 从 0 起。"""
    g = np.ones(N, dtype=F32)
    m = int(MASTER["end_fade"] * SR)
    g[N - m:] = (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, m))).astype(F32)
    s = int(0.005 * SR)
    g[:s] *= np.linspace(0, 1, s, dtype=F32)
    return g


def master(mix):
    """母带增益曲线（会就地改写 mix）。"""
    fade = end_fade_curve()
    mix *= fade[None, :]
    glue_db, glue_thr = glue_gain_db(mix)
    glue_max = float(-glue_db.min())
    y0 = dsp.apply_gain_db(mix, glue_db)
    trim_heap()
    G = MASTER["target_lufs"] - dsp.integrated_lufs(y0)
    ceil = MASTER["tp_internal"]
    gl = None
    for it in range(6):
        gl = None
        trim_heap()
        gl = limiter_gain(y0, ceil - G)
        L = dsp.integrated_lufs(y0, gain=gl, scale=float(dsp.dbg(G)))
        tp = dsp.true_peak_db(y0, gain=gl, scale=float(dsp.dbg(G)))
        log(f"  master iter {it}: gain {G:+.2f} dB → {L:.2f} LUFS, TP {tp:.2f} dBTP, limiter max GR {-dsp.to_db(gl.min()):.2f} dB")
        ok_l = abs(L - MASTER["target_lufs"]) < 0.03
        ok_tp = tp <= MASTER["tp_ceiling"] - 0.05
        if ok_l and ok_tp:
            break
        if not ok_tp:
            ceil -= (tp - (MASTER["tp_ceiling"] - 0.1))
        G += MASTER["target_lufs"] - L
    # 限幅器压得最多的几处（给混音师看是哪些声音顶到了天花板）
    hop_l = int(0.05 * SR)
    m_l = len(gl) // hop_l
    gmin = gl[: m_l * hop_l].reshape(m_l, hop_l).min(axis=1)
    lim_events = []
    for k in np.argsort(gmin)[:200]:
        if gmin[k] >= dsp.dbg(-1.0):
            break
        tk = k * hop_l / SR
        if all(abs(tk - e["t"]) > 1.0 for e in lim_events):
            lim_events.append(dict(t=round(tk, 2), gr_db=round(float(-dsp.to_db(gmin[k])), 2)))
        if len(lim_events) >= 10:
            break
    info = dict(limiter_top_events=lim_events,
                gain_db=round(G, 2), glue_threshold_dbfs=round(glue_thr, 2), glue_max_gr_db=round(glue_max, 2),
                limiter_ceiling_dbtp=round(ceil, 2), limiter_max_gr_db=round(float(-dsp.to_db(gl.min())), 2),
                limiter_active_ms=round(float(np.sum(gl < 0.999) / SR * 1000), 1), end_fade_s=MASTER["end_fade"])
    glue_db += F32(G)
    total = dsp.apply_gain_db(gl, glue_db)
    total *= fade
    return total, info


# ================================================================ 报告
def seg_lufs(x, a, b):
    s = x[:, int(a * SR): int(b * SR)]
    if s.shape[-1] <= 0.45 * SR:
        return None
    L = dsp.integrated_lufs(s)
    return round(L, 2) if np.isfinite(L) else None


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (float, np.floating)):
        return float(o) if np.isfinite(o) else None
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def scene_of(t, scenes):
    for s in scenes:
        if s["start"] <= t < s["end"]:
            return s["id"]
    return None


def cue_checks(cue_recs, scenes, lines, dlg, sfx_bus):
    warns, info = [], []
    for r in cue_recs:
        if r.get("skipped"):
            info.append(f"{r['id']} {r['name']}：{r['skipped']}")
            continue
        if r["start"] < -0.001 or r["end"] > DUR + 0.001:
            warns.append(f"{r['id']} {r['name']} 越界：{r['start']:.2f}–{r['end']:.2f} s")
        if r["kind"] == "oneshot":
            e = r.get("edge", {})
            if e.get("start_db", -99) > -50 or (e.get("end_db", -99) > -50 and not r.get("cut_at")):
                warns.append(f"{r['id']} {r['name']} 首尾不在零附近（开头 {e.get('start_db')} dB / 结尾 {e.get('end_db')} dB，可能爆音）")
    beds = [r for r in cue_recs if r.get("kind") == "bed"]
    for i, a in enumerate(beds):
        for b in beds[i + 1:]:
            if a["name"] == b["name"] and b["start"] < a["end"] - 3.5 and a["start"] < b["end"] - 3.5:
                warns.append(f"同名环境床长时间重叠：{a['id']} 与 {b['id']} {a['name']}（{max(a['start'], b['start']):.2f}–{min(a['end'], b['end']):.2f} s）")
    shots = sorted([r for r in cue_recs if r.get("kind") == "oneshot" and not r.get("skipped")], key=lambda r: r["t"])
    for i, a in enumerate(shots):
        for b in shots[i + 1:]:
            if b["t"] - a["t"] > 0.02:
                break
            if a["name"] == b["name"]:
                warns.append(f"疑似重复 cue：{a['id']} 与 {b['id']} {a['name']} @ {a['t']:.2f}/{b['t']:.2f}")
    for ln in lines:
        a, b = int(ln["t"] * SR), min(N, int(ln["end"] * SR))
        r = line_snr(dlg, sfx_bus, a, b)
        if r is None:
            continue
        snr, worst = r
        over = [x["id"] + ":" + x["name"] for x in shots if x["start"] < ln["end"] and x["end"] > ln["t"]]
        if snr < 12.0 or worst < -3.0:
            warns.append(f"{ln['id']} 语音频段 对白/音效 = {snr:.1f} dB（最差 10% 帧 {worst:.1f} dB），重叠：{', '.join(over[:8])}")
        elif over:
            info.append(f"{ln['id']} 与音效重叠但可懂（对白/音效 {snr:.1f} dB）：{', '.join(over[:6])}")
    return warns, info


def write_wav(path, x):
    path.parent.mkdir(parents=True, exist_ok=True)
    step = SR * 30
    with sf.SoundFile(str(path), "w", SR, 2, subtype="PCM_24") as f:
        for a in range(0, N if x is None else x.shape[-1], step):
            if x is None:
                f.write(np.zeros((min(step, N - a), 2), dtype=F32))
            else:
                f.write(np.ascontiguousarray(np.clip(x[:, a:a + step], -1.0, 1.0).T))


def read_back(path, block=SR * 20):
    """把 WAV 读成 (2, n) float32：分块读进预先分配的数组（sf.read 再转置会多开一整份）。单声道复制成两路，多声道取前两路。"""
    with sf.SoundFile(str(path)) as f:
        n = f.frames
        x = np.empty((2, n), dtype=F32)
        a = 0
        while a < n:
            d = f.read(min(block, n - a), dtype="float32", always_2d=True)
            if len(d) == 0:
                break
            x[0, a:a + len(d)] = d[:, 0]
            x[1, a:a + len(d)] = d[:, 1] if d.shape[1] > 1 else d[:, 0]
            a += len(d)
    return x[:, :a] if a < n else x


def encode_m4a(wav, m4a, bitrate="256k"):
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(wav), "-c:a", "aac", "-b:a", bitrate,
                    "-movflags", "+faststart", str(m4a)], check=True)


def ffmpeg_r128(path):
    """用 ffmpeg 的 ebur128 滤镜（另一套独立实现）量文件的积分响度 / 真峰值，并用 ffprobe 取时长。
    解码全在 ffmpeg 里流式做，Python 这边不占整片内存。"""
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True)
    txt = r.stderr[r.stderr.rfind("Summary:"):] if "Summary:" in r.stderr else r.stderr
    mi = re.search(r"I:\s+(-?[\d.]+|-inf)\s+LUFS", txt)
    mp = re.search(r"True peak:\s+Peak:\s+(-?[\d.]+|-inf)\s+dBFS", txt)
    ffprobe = shutil.which("ffprobe") or str(Path(FFMPEG).with_name("ffprobe"))
    try:
        d = float(subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                                 capture_output=True, text=True, check=True).stdout.strip())
    except (subprocess.CalledProcessError, ValueError, FileNotFoundError):
        d = None
    f = lambda m: (float(m.group(1)) if m and m.group(1) != "-inf" else None)
    return dict(integrated_lufs=f(mi), true_peak_dbtp=f(mp), duration_s=d)


# ================================================================ 主程序
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--music", default=None, help="配乐文件（默认 audio/out/music.wav）")
    ap.add_argument("--music-source", choices=["auto", "mix", "stems", "none"], default="auto")
    ap.add_argument("--music-gain", default="auto", help="配乐推子 dB；auto = 配乐积分响度比对白低 3 dB")
    ap.add_argument("--out", default=str(ROOT / "out/audio"))
    ap.add_argument("--no-collect", action="store_true", help="不跑 node tools/collect_events.mjs")
    ap.add_argument("--no-m4a", action="store_true")
    ap.add_argument("--no-png", action="store_true")
    ap.add_argument("--no-mem-check", action="store_true")
    args = ap.parse_args()
    T0 = time.time()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    warnings = []
    if not args.no_mem_check:
        free = wait_for_memory()
        log(f"系统空闲内存 {free}%")

    scenes = TIMELINE["scenes"]
    log(f"[0/8] 画面事件（{'跳过' if args.no_collect else 'node tools/collect_events.mjs'}）")
    if not args.no_collect:
        collect_events(warnings)
    log("[1/8] cue 表（timeline + visual_events → audio/cues.json）")
    cue_doc, T = cuesheet.main(write=True, log=log)
    cues = cue_doc["cues"]
    if T.ve_info.get("warning"):
        warnings.append(T.ve_info["warning"])

    log(f"[2/8] 环境床（先渲染，内存峰值最低）：{sum(1 for c in cues if 'bed' in c)} 条")
    t1 = time.time()
    amb_d, amb_nd, bed_recs, bed_reps, bed_child_peak = render_beds(cues)
    main_at_beds = peak_rss_mb()
    log(f"  用时 {time.time() - t1:.1f} s，主进程峰值 {main_at_beds:.0f} MB，渲染子进程峰值 {bed_child_peak:.0f} MB")

    log("[3/8] 台词（tts/volc/wav → 逐句处理链）")
    dlg, line_recs = build_dialogue(TIMELINE, warnings)
    L_dlg = dsp.integrated_lufs(dlg)
    g_dl = limiter_gain(dlg, L_dlg + DLG_LIMIT["plr_db"], DLG_LIMIT["lookahead"], DLG_LIMIT["release"])
    dlg *= g_dl[None, :]
    dlg_lim = dict(integrated_lufs=round(L_dlg, 2), ceiling_dbtp=round(L_dlg + DLG_LIMIT["plr_db"], 2),
                   max_gr_db=round(float(-dsp.to_db(g_dl.min())), 2), active_ms=round(float(np.sum(g_dl < 0.999) / SR * 1000), 1))
    del g_dl
    trim_heap()
    log(f"  对白总线 {L_dlg:.2f} LUFS，峰值控制最大 {dlg_lim['max_gr_db']} dB")
    key, hop = duck_key(dlg)

    g_amb = duck_gain_db(key, hop, DUCK["amb_db"])
    dsp.apply_gain_db(amb_d, g_amb)  # 环境床整条闪避（就地）
    del g_amb
    if amb_nd is not None:
        amb_d += amb_nd
        del amb_nd
    log(f"[4/8] 单次音效：{sum(1 for c in cues if 'bed' not in c)} 条 cue")
    t1 = time.time()
    duck_shape = -dsp.smooth_ar(-key, DUCK["attack"], DUCK["release"], hop)  # 0..1，乘上各 cue 的 duck_db 就是它的闪避量
    sfx, cue_recs, events, syncs = render_cues(cues, duck_shape, hop)
    del duck_shape
    cue_recs = bed_recs + cue_recs
    trim_heap()
    log(f"  渲染用时 {time.time() - t1:.1f} s，峰值内存 {peak_rss_mb():.0f} MB")

    log("[5/8] 配乐")
    music_parts, music_info = music_sources(args, warnings)
    log(f"  来源：{music_info['source']}" + (f"（{music_info.get('note')}）" if music_info.get("note") else ""))
    mg = 0.0
    music_d = None
    if music_parts:
        msum = zeros2()
        for part in music_parts:
            msum += load_music_part(part, warnings)
        L_m = dsp.integrated_lufs(msum)
        del msum
        if args.music_gain == "auto":
            mg = (L_dlg + MUSIC_LEVEL["rel_to_dialogue_db"]) - L_m if np.isfinite(L_m) else 0.0
        else:
            mg = float(args.music_gain)
        music_info.update(input_lufs=round(L_m, 2), fader_db=round(mg, 2), mode=args.music_gain)
        log(f"  配乐输入 {L_m:.2f} LUFS，推子 {mg:+.2f} dB")
        music_d = zeros2()
        for part in music_parts:
            x = load_music_part(part)
            gdb = duck_gain_db(key, hop, part["duck_db"])
            gdb += F32(mg)
            music_d += dsp.apply_gain_db(x, gdb)
            del x, gdb
    log("  侧链闪避与对白保护")
    rider_db, rider_res = rider(line_recs, dlg, music_d, amb_d, sfx)
    if rider_db is not None and np.any(rider_db < 0):
        dsp.apply_gain_db(music_d, rider_db)
    del rider_db, key
    trim_heap()

    log("[6/8] 母带")
    buses = [b for b in (dlg, music_d, sfx, amb_d) if b is not None]
    mix = buses[0].copy()
    for bus in buses[1:]:
        mix += bus
    g_total, minfo = master(mix)
    del mix
    for bus in buses:
        bus *= g_total[None, :]
    del g_total
    trim_heap()
    stems = {"dialogue": dlg, "music": music_d, "sfx": sfx, "amb": amb_d}
    log(f"  峰值内存 {peak_rss_mb():.0f} MB")

    log("[7/8] 写文件")
    mix_m = buses[0].copy()
    for bus in buses[1:]:
        mix_m += bus
    del buses
    write_wav(out / "mix.wav", mix_m)
    del mix_m
    for k, v in stems.items():
        write_wav(out / "stems" / f"{k}.wav", v)
    chk = read_back(out / "mix.wav")
    L_int = dsp.integrated_lufs(chk)
    tp = dsp.true_peak_db(chk)

    log("[8/8] 自检与报告")
    line_rows = []
    for ln in line_recs:
        a, b = ln["t"], ln["end"]
        ia, ib = int(a * SR), min(N, int(b * SR))
        pre = min(ia, int(0.5 * SR))
        bg = amb_d[:, ia - pre:ib] + sfx[:, ia - pre:ib]
        if music_d is not None:
            bg += music_d[:, ia - pre:ib]
        d = _energy_frames(band_seg(dlg, ia, ib))
        g = _energy_frames(band_seg(bg, pre, bg.shape[-1]))
        act = d > d.max() * 10 ** (-30 / 10)
        snr = 10 * np.log10(d[act].sum() / (g[act].sum() + 1e-15)) if act.any() else None
        worst = float(np.percentile(10 * np.log10(d[act] / (g[act] + 1e-15)), 10)) if act.any() else None
        Ld = seg_lufs(dlg, a, b)
        Lb = seg_lufs(bg[:, pre:], 0, (ib - ia) / SR)
        line_rows.append(dict(
            id=ln["id"], who=ln["who"], chain=ln["chain"], t=a, end=b, text=ln["text"],
            dialogue_lufs=Ld, background_lufs=Lb,
            dbr_db=round(Ld - Lb, 1) if (Ld is not None and Lb is not None) else None,
            speech_band_snr_db=round(snr, 1) if snr is not None else None,
            worst10_frame_snr_db=round(worst, 1) if worst is not None else None,
            rider_extra_db=rider_res.get(ln["id"], {}).get("extra_db", 0.0)))
        del bg
    scene_rows = []
    for sc in scenes:
        a, b = sc["start"], sc["end"]
        seg = chk[:, int(a * SR): int(b * SR)]
        _, st = dsp.loudness_series(seg, 3.0, 0.1)
        scene_rows.append(dict(id=sc["id"], start=a, end=b, integrated_lufs=seg_lufs(chk, a, b),
                               max_short_term_lufs=round(float(st.max()), 2), true_peak_dbtp=round(dsp.true_peak_db(seg), 2),
                               stems_lufs={k: (seg_lufs(v, a, b) if v is not None else None) for k, v in stems.items()}))
    cw, ci = cue_checks(cue_recs, scenes, line_recs, dlg, sfx)
    stem_stats = {k: (dict(integrated_lufs=seg_lufs(v, 0, DUR), true_peak_dbtp=round(dsp.true_peak_db(v), 2))
                      if v is not None else dict(integrated_lufs=None, true_peak_dbtp=None, note="静音"))
                  for k, v in stems.items()}
    # 嘀：周期、首声、截断在"只有嘀"的局部总线上量（不受别的音效干扰）；整条音效分轨另查触礁后有没有像嘀的纯音
    M = T.marks
    ping0 = M["s3_2003.tag_ping_start"]
    crash_t = next((c["t"] for c in cues if c.get("sfx") == "crash"), M["s3_2003.crash"])
    ping_cues = sorted(c["t"] for c in cues if c.get("sfx") == "beacon_ping" and c["p"].get("mode") != "far")
    ping_first = ping_cues[0] if ping_cues else ping0
    t_a, t_b = ping_first - 1.0, crash_t + 3.0
    pings = qa.ping_report(_ping_bus(t_a, t_b), 0.0, t_b - t_a, ping_first - t_a, crash_t - t_a)
    pings["onsets"] = [round(o + t_a, 4) for o in pings.get("onsets", [])]
    ctx = qa.ping_report(sfx, t_a, t_b, ping_first, crash_t)  # 整条音效分轨：混在别的声音里还认得出几声、触礁后有没有像嘀的纯音
    pings["in_sfx_stem"] = dict(n=ctx.get("n"), onsets=ctx.get("onsets"),
                                after_crash_tone_db_rel=ctx.get("after_crash_tone_db_rel"))
    pings.update(expected_n=len(ping_cues), tag_ping_start_mark=ping0, crash_t=crash_t,
                 first_vs_tag_ping_start_ms=round((pings["onsets"][0] - ping0) * 1000, 2) if pings.get("onsets") else None)
    if pings.get("onsets") and ping_cues:
        errs = [min(abs(o - pc) for pc in ping_cues) for o in pings["onsets"]]
        pings["max_match_error_ms"] = round(max(errs) * 1000, 2)
    # S4 旧信标：按画面的几声（一声比一声弱）逐声对
    far = sorted(c["t"] for c in cues if c.get("sfx") == "beacon_ping" and c["p"].get("mode") == "far")
    if far:
        fa, fb = far[0] - 0.6, far[-1] + 1.5
        pm = qa.ping_report(_ping_bus(fa, fb, ("far",)), 0.0, fb - fa, far[0] - fa, 1e9)
        det = [round(o + fa, 4) for o in pm.get("onsets", [])]
        errs = [min(abs(o - c) for c in far) for o in det]
        pings["s4_old_tag"] = dict(expected=[round(x, 4) for x in far], detected=det, level_db_rel=pm.get("peak_db_rel"),
                                   max_match_error_ms=round(max(errs) * 1000, 2) if errs else None)
    else:
        pings["s4_old_tag"] = None
    sync_ok = [s for s in syncs if s["err_ms"] is not None]
    sync_bad = [s for s in sync_ok if abs(s["err_ms"]) > SYNC_TOL_MS]
    sync_sum = dict(n_checked=len(sync_ok), n_over_1_frame=len(sync_bad), tolerance_ms=round(SYNC_TOL_MS, 1),
                    max_abs_err_ms=round(max((abs(s["err_ms"]) for s in sync_ok), default=0.0), 1),
                    mean_abs_err_ms=round(float(np.mean([abs(s["err_ms"]) for s in sync_ok])), 2) if sync_ok else None,
                    unmeasured=[s["id"] for s in syncs if s["err_ms"] is None], worst=sorted(sync_ok, key=lambda s: -abs(s["err_ms"]))[:8])
    for s in sync_bad:
        cw.append(f"起音误差超 1 帧：{s['id']} {s['name']} {s['label']} 目标 {s['target']} 实测 {s['measured']}（{s['err_ms']} ms）")
    clicks = qa.click_report(chk)
    dc = qa.dc_report(chk)
    tail = chk[:, -int(0.1 * SR):]
    silence = dict(first_sample_abs=float(np.max(np.abs(chk[:, 0]))), last_sample_abs=float(np.max(np.abs(chk[:, -1]))),
                   last_100ms_peak_dbfs=round(float(dsp.to_db(np.max(np.abs(tail)) + 1e-12)), 1),
                   last_100ms_all_zero=bool(np.all(np.abs(tail) < 1.0 / 2 ** 23)))
    bed_flags = []
    for br in bed_reps:
        for k in ("raw", "lp800", "hp500"):
            v = br.get(f"tonal_{k}_db")
            if v is not None and v > 9.0:
                bed_flags.append(f"{br['name']} [{k}] 窄带凸起 {v} dB @ {br.get(f'tonal_{k}_hz')} Hz")
        if br.get("repeat_corr") is not None and br["repeat_corr"] > 0.5:
            bed_flags.append(f"{br['name']} 疑似重复/循环：相关 {br['repeat_corr']} @ {br['repeat_lag_s']} s")
    cw += [f"环境床：{f}" for f in bed_flags]
    ev_path = ROOT / "audio/out/sfx_events.json"
    ev_path.parent.mkdir(parents=True, exist_ok=True)
    ev_path.write_text(json.dumps(dict(note="参数化 cue 的内部事件绝对时间（秒）", cues=events), ensure_ascii=False, indent=1))
    trim_heap()
    if not args.no_png:
        spans = [(l["t"], l["end"], l["id"]) for l in line_recs]
        viz.mix_overview_png(chk, stems, out / "mix_spectrogram.png", scenes=scenes, lines=spans,
                             title=f"WEI mix  {L_int:.1f} LUFS, TP {tp:.1f} dBTP, music={music_info['source']}")
        viz.mix_rows_png(chk, out / "mix_spectrogram_rows.png", rows=6, scenes=scenes, lines=spans,
                         title="mix spectrogram (pink-weighted), cyan = dialogue")
    del stems, dlg, music_d, sfx, amb_d
    trim_heap()
    try:
        import pyloudnorm as pyln
        L_pyln = float(pyln.Meter(SR).integrated_loudness(chk.T))
    except Exception:  # noqa: BLE001
        L_pyln = None
    m4a_info = None
    if not args.no_m4a:
        encode_m4a(out / "mix.wav", out / "mix.m4a")
        r128 = ffmpeg_r128(out / "mix.m4a")
        tp_m4a = r128["true_peak_dbtp"]
        if tp_m4a is not None and tp_m4a > MASTER["tp_ceiling"]:  # AAC 编码会让真峰值涨一点：超了就给 m4a 的源再多限一点
            extra = tp_m4a - MASTER["tp_ceiling"] + 0.15
            gl = limiter_gain(chk, MASTER["tp_internal"] - extra)
            tmp = out / "_m4a_src.wav"
            write_wav(tmp, chk * gl[None, :])
            del gl
            encode_m4a(tmp, out / "mix.m4a")
            tmp.unlink()
            r128 = ffmpeg_r128(out / "mix.m4a")
        m4a_info = dict(path=_rel(out / "mix.m4a"), codec="AAC-LC", bitrate="256k", duration_s=r128["duration_s"],
                        integrated_lufs=r128["integrated_lufs"], true_peak_dbtp=r128["true_peak_dbtp"],
                        measured_by="ffmpeg ebur128 (peak=true)")
        wav_r128 = ffmpeg_r128(out / "mix.wav")
        m4a_info["wav_crosscheck_ffmpeg"] = wav_r128

    report = dict(
        built=_dt.datetime.now().isoformat(timespec="seconds"),
        duration_s=round(chk.shape[-1] / SR, 6), samples=int(chk.shape[-1]), sr=SR, format="WAV PCM 24-bit stereo",
        integrated_lufs=round(L_int, 2), integrated_lufs_pyloudnorm=round(L_pyln, 2) if L_pyln is not None else None,
        true_peak_dbtp=round(tp, 2), sample_peak_dbfs=round(float(dsp.to_db(np.max(np.abs(chk)))), 2),
        loudness_range_lu=round(dsp.loudness_range(chk), 1),
        targets=dict(integrated_lufs=MASTER["target_lufs"], true_peak_max_dbtp=MASTER["tp_ceiling"], duration_s=DUR),
        timing=T.summary(), sync=dict(summary=sync_sum, all=syncs), beacon_ping=pings,
        master=minfo, dialogue_peak_control=dlg_lim, music=music_info, ducking=DUCK, rider=RIDER, m4a=m4a_info,
        stems=stem_stats, scenes=scene_rows, lines=line_rows,
        qa=dict(clicks=clicks, dc=dc, silence=silence, beds=bed_reps),
        cue_warnings=cw, cue_warning_count=len(cw), cue_info=ci, warnings=warnings,
        n_cues=len(cues), render_seconds=round(time.time() - T0, 1), peak_rss_mb=round(peak_rss_mb(), 0),
        memory=dict(main_peak_mb=round(peak_rss_mb(), 0), bed_child_peak_mb=round(bed_child_peak, 0),
                    main_during_beds_mb=round(main_at_beds, 0),
                    combined_peak_upper_bound_mb=round(max(peak_rss_mb(), main_at_beds + bed_child_peak), 0),
                    note="环境床在单独子进程里逐条渲染；整体峰值 ≤ max(主进程峰值, 渲染床时主进程 + 子进程峰值)"),
        files=dict(mix=_rel(out / "mix.wav"), m4a=_rel(out / "mix.m4a") if m4a_info else None,
                   stems=[_rel(out / "stems" / f"{k}.wav") for k in ("dialogue", "music", "sfx", "amb")],
                   spectrogram=[_rel(out / "mix_spectrogram.png"), _rel(out / "mix_spectrogram_rows.png")],
                   cues="audio/cues.json", events="audio/out/sfx_events.json"),
    )
    (out / "mix_report.json").write_text(json.dumps(_clean(report), ensure_ascii=False, indent=1))
    snr_vals = [r["speech_band_snr_db"] for r in line_rows if r["speech_band_snr_db"] is not None]
    log(f"完成：{L_int:.2f} LUFS（pyloudnorm {L_pyln and round(L_pyln, 2)}），TP {tp:.2f} dBTP，{chk.shape[-1] / SR:.3f} s，"
        f"用时 {time.time() - T0:.0f} s，峰值内存 主进程 {peak_rss_mb():.0f} MB / 含床子进程上界 "
        f"{max(peak_rss_mb(), main_at_beds + bed_child_peak):.0f} MB")
    log(f"  起音自检：{sync_sum['n_checked']} 个，超 1 帧 {sync_sum['n_over_1_frame']} 个，最大 {sync_sum['max_abs_err_ms']} ms")
    log(f"  嘀：{pings.get('n')} 声，首声误差 {pings.get('first_error_ms')} ms，周期 {pings.get('period_mean_s')} s"
        f"（最大偏差 {pings.get('period_max_error_ms')} ms），期望 {pings.get('expected_n')} 声，"
        f"最后一声早于触礁 {pings.get('last_onset_to_crash_s')} s，触礁后纯音残留 {pings.get('after_crash_tone_db_rel')}"
        f"（音效分轨里：认出 {pings['in_sfx_stem']['n']} 声，触礁后像嘀的纯音 {pings['in_sfx_stem']['after_crash_tone_db_rel']}）")
    log(f"  对白语音频段信噪比：最低 {min(snr_vals) if snr_vals else None} dB；cue 警告 {len(cw)} 条，其他警告 {len(warnings)} 条")


if __name__ == "__main__":
    main()
