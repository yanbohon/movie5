"""生成《鲔》整部片的音效 / 环境床 cue 表（audio/cues.json）。

每次 build_mix 都会重新生成：时间全部来自 script/timeline.json（marks/lines）与 audio/visual_events.json（画面真实时刻），
画面组改了事件，重跑一条命令就能重新对位。这里不写任何绝对秒数，只写"相对某个卡点/台词多少秒"。

cue 格式：
  单次 {"id","t"(同步点，绝对秒),"sfx","gain_db","pan","p":{参数},"note","scene","src"(visual_events|marks),
        "cut_at"(可选：画面硬切，连混响尾巴在这里收掉),"check"(可选：onset|slope|peak，自检起音误差),"sub"(可选：内部事件自检),
        "duck_db"(可选：台词处跟对白侧链闪避多少 dB，见 DUCK_SFX)}
  床   {"id","t","end","bed","gain_db","fade_in","fade_out","p","note","duck"}
p 里以 _at 结尾的参数是绝对时间列表，以 _env 结尾的是 [(绝对时间, dB)] 折线；混音时换算成相对这条 cue 的时间。

电平约定：单次音效峰值 -3 dBFS（norm=lufs 的长纹理为 -23 LUFS）再加 gain_db；环境床 full 状态 ≈ -23 LUFS 再加 gain_db；
对白约 -20 LUFS。母带最后整体推到 -16 LUFS。

用法: .venv/bin/python -m audio.sfx.cuesheet
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .dsp import smoothstep
from .events import Timing

ROOT = Path(__file__).resolve().parents[2]
CUES: list = []
_n = {"k": 0}

# 片名「鲔」与书法字的笔画数（真实笔顺；画面没给事件时用来推算）
STROKES = {"鲔": 14, "白": 5, "鲟": 14, "象": 11, "鱼": 8, "有": 6, "鳣": 21}


def _id(prefix):
    _n["k"] += 1
    return f"{prefix}{_n['k']:03d}"


# S4 旧信标：导演手册写的是"回忆，只出现一次，极远极弱"；后来主导演在 s4 events.js 里给了四声一声比一声弱的 tag_ping
# （配 L37「又叫了很久。后来有一天，它不叫了」）。"picture" = 按画面的四声；"once" = 回到手册：L37 句中停顿里只一声。
S4_TAG_PINGS = "picture"

# 对白优先：会压在台词下面的持续性音效，在台词处跟着对白侧链闪避（dB；只在有人说话时生效，台词之间照常）。
# 笔画、针、嘀、咔哒、撞击这类短促的"事件声"不闪避：它们是画面同步点，本来就不长，压了只会变软。
DUCK_SFX = {
    "quilt_rustle": -6.0, "receiver_hiss": -6.0, "crash": -6.0, "diesel_boat": -7.0, "mud_steps": -4.0, "cloth_strain": -4.0,
    "boat_creaks": -4.0, "breach": -4.0, "water_rush": -6.0, "eggs_snow": -4.0, "warm_glow": -4.0, "tape_measure": -3.0,
    "stitch": -3.0, "presence_push": -5.0, "uw_whoosh": -4.0, "heart": -3.0, "electro_sparkle": -3.0, "swim_away": -3.0,
    "small_boat": -3.0, "cable_creak": -3.0, "sediment": -3.0, "ship_pass": -3.0, "scroll_rush": -3.0, "field_crackle": -3.0,
    "gill_breaths": -3.0, "sink_settle": -3.0, "swirl_turn": -3.0, "release_splash": -3.0, "net_struggle": -3.0,
    "scroll_slide": -3.0, "ink_bleed": -3.0, "paper_breath": -3.0, "small_brush": -3.0, "grain_dissolve": -3.0,
}


def fx(t, name, gain=0.0, pan=0.0, note="", scene="", src="marks", cut_at=None, check=None, sub=None, duck=None, **p):
    c = dict(id=_id("fx"), t=round(float(t), 4), sfx=name, gain_db=gain, pan=pan, p=p, note=note, scene=scene, src=src)
    d = DUCK_SFX.get(name, 0.0) if duck is None else float(duck)
    if d < 0:
        c["duck_db"] = d
    if cut_at is not None:
        c["cut_at"] = round(float(cut_at), 4)
    if check:
        c["check"] = check
    if sub:
        c["sub"] = [dict(label=a, t=round(float(b), 4), kind=k) for a, b, k in sub]
    CUES.append(c)
    return c


def bed(t, end, name, gain, fi=1.0, fo=1.0, note="", scene="", duck=True, **p):
    c = dict(id=_id("bed"), t=round(float(t), 4), end=round(float(end), 4), bed=name, gain_db=gain, fade_in=fi,
             fade_out=fo, p=p, note=note, scene=scene)
    if not duck:
        c["duck"] = False
    CUES.append(c)
    return c


def _even(t0, t1, n):
    if n <= 1:
        return [t0]
    return list(np.linspace(t0, t1, n))


def _strokes_fallback(groups, spacing_gap=0.12):
    """groups: [(字, 起点, 总时长)] → 每笔 {t, dur}（按笔画数均分；字与字之间留一点空）。"""
    out = []
    for ch, t0, D in groups:
        k = STROKES[ch]
        step = D / k
        for i in range(k):
            out.append(dict(t=t0 + i * step, dur=step * (0.62 + 0.25 * ((i * 7) % 5) / 4), char=ch, i=i))
    return out


def _chars_seq(chars, t0, D, gap=0.12):
    """一串字在 [t0, t0+D] 内按笔画数分配时间（字间留 gap 秒）。"""
    total = sum(STROKES[c] for c in chars)
    avail = D - gap * (len(chars) - 1)
    groups = []
    t = t0
    for c in chars:
        d = avail * STROKES[c] / total
        groups.append((c, t, d))
        t += d + gap
    return groups


def _gap_in_line(lid, min_gap=0.3):
    """在一句配音内部找最长的停顿（句中换气），返回 (停顿开始, 停顿长度)（相对句首秒）；找不到返回 None。"""
    try:
        import soundfile as sf
        x, sr = sf.read(str(ROOT / f"tts/volc/wav/{lid}.wav"), always_2d=True)
    except Exception:  # noqa: BLE001
        return None
    m = x.mean(axis=1)
    hop = int(0.01 * sr)
    k = len(m) // hop
    e = 10 * np.log10(np.mean(m[: k * hop].reshape(k, hop) ** 2, axis=1) + 1e-12)
    quiet = e < e.max() - 38
    best = None
    i = int(0.3 / 0.01)
    while i < k - int(0.3 / 0.01):
        if quiet[i]:
            j = i
            while j < k and quiet[j]:
                j += 1
            L = (j - i) * 0.01
            if L >= min_gap and (best is None or L > best[1]):
                best = (i * 0.01, L)
            i = j
        else:
            i += 1
    return best


def _dur(e, default):
    """事件时长：dur 优先，其次 end - t。"""
    if e.get("dur") is not None:
        return float(e["dur"])
    if e.get("end") is not None:
        return max(0.0, float(e["end"]) - float(e["t"]))
    return float(default)


STROKE_RX = r"stroke|brush|笔"


def build(T: Timing):
    CUES.clear()
    _n["k"] = 0
    M = T.mark
    Ln = T.line
    Le = T.line_end
    S = T.scene

    # ================================================================ S0 冷开场
    s0 = S("s0_cold")
    s1 = S("s1_river")
    bed(0.0, s1["start"] + 2.0, "uw_river", -11.5, fi=9.0, fo=2.5, scene="s0_cold",
        note="江底极低的轰鸣从 0 秒慢慢起来（只有轰鸣 + 一点点水流，没有砾石）", flow=0.35, hush=0.0, gravel=0.0)
    title_t = M("s0_cold.title_write")
    hold_t = M("s0_cold.title_hold")
    evs, src = T.pick("s0 片名笔画", "s0_cold", STROKE_RX, lambda: _strokes_fallback(
        [("鲔", title_t, min(4.0, hold_t - title_t - 0.12))]), exclude=r"dissolve|card", expect=14)
    for k, e in enumerate(evs):
        fx(e["t"], "light_stroke", -17.0, (-0.25 + 0.5 * (k % 5) / 4), f"片名「鲔」第 {k + 1} 笔（笔毛擦过 + 极低的光感 swell）",
           "s0_cold", src, cut_at=s1["start"], check="onset", dur=min(max(_dur(e, 0.24), 0.08), 0.6), seed=100 + k)
    evs, src = T.pick("s0 片名散开", "s0_cold", r"dissolve|disperse|scatter",
                      lambda: [dict(t=M("s0_cold.title_dissolve"), dur=1.8)])
    t_dis = evs[0]["t"]
    fx(t_dis, "grain_dissolve", -9.0, 0.0, "片名的光散成颗粒、被水流带走（细碎沙沙），31.0 硬接 S1", "s0_cold", src,
       cut_at=s1["start"], check="onset", dur=min(s1["start"] - t_dis, _dur(evs[0], 1.8) + 1.0), drift=-0.4)

    # ================================================================ S1 看不见的江
    s2 = S("s2_scroll")
    t_out, _ = T.one("s1 画面淡出", "s1_river", r"fade_out|s1_out", s1["end"] - 1.6)
    bed(s1["start"] - 0.2, t_out + 1.5, "uw_river", -12.0, fi=2.2, fo=1.6, scene="s1_river",
        note="水下江底床（轰鸣 + 缓慢起伏的水流 + 偶尔远处砾石），跟画面淡出")
    for key, rx, fb, g, base_size in (("s1 吻部擦过镜头", r"rostrum", dict(t=M("s1_river.rostrum_enter") + 2.1, dur=3.0, dist=1.2), -16.0, 0.6),
                                      ("s1 身体滑过", r"body", dict(t=M("s1_river.body_pass") + 1.6, dur=3.4, dist=2.5), -8.0, 1.25)):
        evs, src = T.pick(key, "s1_river", rx, lambda fb=fb: [fb])
        e = evs[0]
        dist = float(e.get("dist", 2.0))
        dd = _dur(e, 3.0)
        fx(e["t"], "uw_whoosh", g - 3.0 * np.log2(max(dist, 0.5) / 1.5), 0.0,
           f"{key[3:]}：水流 whoosh（同步点 = 最近点，距离 {dist} m）", "s1_river", src, check="peak",
           dur=dd, tpk=0.5, size=base_size, bright=float(np.clip(1.25 - 0.12 * dist, 0.8, 1.2)),
           pan_from=(-0.6 if "身体" in key else 0.5), pan_to=(0.6 if "身体" in key else -0.35))
    evs, src = T.pick("s1 左右扫吻", "s1_river", r"scan",
                      lambda: [dict(t=Ln("L09")["t"] + 0.6 + 2.5 * k) for k in range(3)])
    for k, e in enumerate(evs):
        fx(e["t"], "uw_whoosh", -25.0, 0.0, f"她左右摆动长吻（第 {k + 1} 次，很轻）", "s1_river", src,
           dur=1.3, tpk=0.5, size=0.35, bright=1.1, pan_from=(-0.5 if k % 2 == 0 else 0.5), pan_to=(0.5 if k % 2 == 0 else -0.5),
           seed=120 + k)
    t_el, src = T.one("s1 电感视觉荡开", "s1_river", r"electro_on|electro|reveal|wave", M("s1_river.electro_reveal"),
                      exclude=r"off|static")
    t_rum, src_r = T.one("s1 远处船声起", "s1_river", r"rumble|approach", M("s1_river.rumble_start"))
    fx(t_el, "electro_sparkle", -12.0, 0.0, "电感视觉：荡开的一圈波 + 晶莹细碎的高频闪烁（随机颗粒、无固定音高），到 rumble_start 前收",
       "s1_river", src, check="onset", dur=max(1.0, t_rum - t_el), fade_out=0.9)
    t_pass, src_p = T.one("s1 电感被白噪声冲垮", "s1_river", r"static|ship.*pass|pass.*ship", M("s1_river.ship_pass"))
    t_bow, _ = T.one("s1 船头压过", "s1_river", r"bow", t_pass - 0.3)
    t_peak, _ = T.one("s1 船最响", "s1_river", r"ship_peak|peak", M("s1_river.ship_peak"))
    t_prop, _ = T.one("s1 螺旋桨过头顶", "s1_river", r"prop", t_peak + 3.5)
    t_gone, _ = T.one("s1 船走远", "s1_river", r"gone", M("s1_river.ship_gone"))
    tail = max(2.0, t_out + 1.2 - t_gone)
    fx(t_rum, "ship_pass", -4.0, 0.0, "远处船声渐近 → 船头推水 → 白噪声冲垮电感 → ship_peak 最响 → 螺旋桨过头顶 → 远去",
       "s1_river", src_p, sub=[("ship_pass(白噪声)", t_pass, "slope"), ("ship_peak(重拍)", t_peak, "slope")],
       t_pass=t_pass - t_rum, t_peak=t_peak - t_rum, t_gone=t_gone - t_rum, t_prop=t_prop - t_rum, t_bow=t_bow - t_rum,
       tail=tail)
    fx(t_rum, "field_crackle", -8.0, 0.0, "电场开始闪烁、出现噪点（越来越密，接 ship_pass 的白噪声）", "s1_river", src_r,
       cut_at=t_pass + 0.04, dur=t_pass - t_rum)
    t_dive, src = T.one("s1 她贴着河床下潜", "s1_river", r"dive", t_pass + 0.4)
    fx(t_dive + 0.45, "uw_whoosh", -13.0, 0.0, "她猛地下潜（身体推水）", "s1_river", src, dur=1.4, tpk=0.32, size=1.0,
       pan_from=0.2, pan_to=-0.2, seed=131)
    t_bot, src = T.one("s1 贴到河床", "s1_river", r"bottom", t_pass + 4.3)
    fx(t_bot, "bottom_touch", -9.0, 0.0, "贴到河床，泥沙扬起", "s1_river", src, check="onset")
    storm = t_prop + 0.3
    fx(t_pass, "sediment", -6.0, 0.0, "泥沙风暴打在身上的沙沙声（螺旋桨过去时最密），ship_gone 后慢慢落定", "s1_river", src_p,
       t_peak=storm - t_pass, t_gone=t_gone - t_pass, settle=max(1.5, min(4.5, t_out + 1.0 - t_gone)))

    # ================================================================ S2 长卷
    s3 = S("s3_2003")
    dam = M("s2_scroll.dam_line")
    evs, src_dam = T.pick("s2 尺子画线（咚 + 刮擦）", "s2_scroll", r"dam|ruler|wall", lambda: [dict(t=dam, dur=0.55)])
    t_dam, scrape = evs[0]["t"], min(max(_dur(evs[0], 0.55), 0.2), 1.2)
    l27 = Ln("L27")
    fish_evs, src_f = T.pick("s2 坝后鱼一条条淡掉", "s2_scroll", r"fish.*(fade|vanish|gone|out)|(fade|vanish).*fish",
                             lambda: [dict(t=l27["t"] + d) for d in (0.05, 0.35, 0.5, 1.05, 1.8)])
    bed(s2["start"] - 0.5, s3["start"] + 0.5, "scroll_air", -21.0, fi=1.6, fo=1.3, scene="s2_scroll",
        note="极淡的远处江风（让位给笔墨与音乐）；鱼淡掉处水声挖缺口；dam_line 硬切后慢慢回来",
        gaps_at=[e["t"] for e in fish_evs], cut_at=[t_dam])
    t_pin, src = T.one("s2 宣纸淡入", "s2_scroll", r"paper", M("s2_scroll.paper_in"))
    fx(t_pin, "paper_breath", -19.0, 0.0, "宣纸淡入", "s2_scroll", src, check="onset", dur=1.6)
    l13, l14 = Ln("L13"), Ln("L14")
    rew = M("s2_scroll.scroll_rewind")
    groups = _chars_seq("白鲟", l13["t"] + 0.15, 2.35) + _chars_seq("象鱼", l14["t"] + 0.25, 2.6)
    evs, src = T.pick("s2 书法「白鲟」「象鱼」", "s2_scroll", STROKE_RX, lambda: _strokes_fallback(groups),
                      t0=s2["start"], t1=rew, exclude=r"note|anno|small", expect=38)
    for k, e in enumerate(evs):
        fx(e["t"], "brush_stroke", -21.0, (-0.1 + 0.2 * (k % 3) / 2), f"毛笔竖写{e.get('char', '')}（第 {k + 1} 笔）", "s2_scroll", src,
           check="onset", dur=min(max(_dur(e, 0.11), 0.05), 0.5), pressure=0.75, dry=0.25, size=1.0, seed=300 + k)
    t_rw, src = T.one("s2 长卷飞速掠过", "s2_scroll", r"rewind", rew, exclude=r"stop")  # 不能写 rush：会匹配到 brush
    fx(t_rw, "scroll_rush", -11.0, 0.0, "镜头飞速向右掠过长卷（风声/纸声），停在最右端", "s2_scroll", src, check="onset",
       dur=max(1.0, Ln("L15")["t"] - 0.1 - t_rw))
    ast = M("s2_scroll.asteroid")
    t_af, src_a = T.one("s2 陨石划过", "s2_scroll", r"asteroid|meteor", ast, exclude=r"land|impact|hit")
    t_ai, src_i = T.one("s2 陨石落地", "s2_scroll", r"(asteroid|meteor).*(land|impact|hit)|(land|impact|hit).*(asteroid|meteor)",
                        t_af + 0.55)
    fx(t_af, "asteroid_flight", -20.0, 0.0, "朱砂陨石划过天空（带火焰气流）", "s2_scroll", src_a, check="onset",
       dur=max(0.3, t_ai - t_af))
    fx(t_ai, "asteroid_impact", -9.0, 0.0, "落地：沉重但克制的低频冲击 + 远处回响（全卷唯一的红晕开）", "s2_scroll", src_i, check="onset")
    for k, (tp, g) in enumerate([(Le("L17") + 0.3, -25.0), (Le("L18") + 0.25, -26.0), (Le("L21") + 0.2, -26.0)]):
        fx(tp, "paper_breath", g, (0.3 if k % 2 else -0.3), "长卷缓缓移动：纸的轻翻动（台词间隙）", "s2_scroll", "marks",
           dur=0.9, body=0.5, seed=330 + k)
    t_wei = M("s2_scroll.wei_write")
    evs, src = T.pick("s2 长卷大字「鲔」", "s2_scroll", STROKE_RX, lambda: _strokes_fallback([("鲔", t_wei + 0.05, 3.0)]),
                      t0=t_wei - 0.3, t1=t_wei + 3.1, exclude=r"note|anno|small", expect=14)
    for k, e in enumerate(evs):
        fx(e["t"], "brush_stroke", -19.0, 0.0, f"长卷大字「鲔」第 {k + 1} 笔", "s2_scroll", src, check="onset",
           dur=min(max(_dur(e, 0.2), 0.06), 0.7), pressure=0.9, dry=0.35, size=1.6, seed=400 + k)
    evs, src = T.pick("s2 小楷（季春之月…）", "s2_scroll", r"note|anno|small",
                      lambda: [dict(t=t_wei + 3.15, end=Ln("L21")["t"] + 0.9)])
    fx(evs[0]["t"], "small_brush", -26.0, 0.1, "小楷「季春之月 天子始乘舟 荐鲔于寝庙」（很轻）", "s2_scroll", src,
       dur=max(0.8, (float(evs[-1].get("end", evs[-1]["t"] + 0.2)) if len(evs) > 1 else _dur(evs[0], 2.7) + evs[0]["t"]) - evs[0]["t"]),
       rate=8.0)
    t_mod = M("s2_scroll.modern")
    fx(t_mod, "scroll_slide", -17.0, 0.0, "近代：镜头越摇越快冲向坝线（纸面掠过的风越来越紧），dam_line 硬切", "s2_scroll", "marks",
       cut_at=t_dam, dur=max(0.5, t_dam - t_mod))
    fx(t_dam, "ruler_line", -3.0, 0.0, "dam_line：尺子画线 —— 沉重的「咚」+ 硬而干的刮擦（全卷唯一的硬声音；之前的一切连尾巴硬切）",
       "s2_scroll", src_dam, check="onset", scrape=scrape)
    for k, e in enumerate(fish_evs):
        fx(e["t"], "fish_sigh", -30.0, 0.0, f"墙上游的鱼一条条淡掉（第 {k + 1} 条）：极轻的叹息 + 水声的缺口", "s2_scroll", src_f,
           check="onset", dur=0.9, seed=500 + k)
    for c in CUES:  # dam_line 之前的长卷声音连尾巴硬切
        if "sfx" in c and c.get("scene") == "s2_scroll" and c["t"] < t_dam - 1e-3 and "cut_at" not in c:
            c["cut_at"] = round(t_dam, 4)

    # ================================================================ S3 二〇〇三
    s4 = S("s4_seven")
    l28 = Ln("L28")
    t_date, src = T.one("s3 日期小楷淡墨渗出", "s3_2003", r"date", M("s3_2003.date_card") + 0.15)
    fx(t_date, "ink_bleed", -21.0, 0.0, "纸上小楷日期淡墨渗出（几乎无声的湿）", "s3_2003", src, dur=1.6, wash_from=5.0, wash_to=6.0)
    t_sky, src_sky = T.one("s3 出水（看见天）", "s3_2003", r"sky|breach|out_of_water", M("s3_2003.sky"))
    t_imp, src_n = T.one("s3 撞进网", "s3_2003", r"net.*impact|impact.*net", l28["t"] + 3.23)
    t_close, _ = T.one("s3 网收拢", "s3_2003", r"net.*close|close.*net", l28["t"] + 4.15)

    def _thr():
        out, t, k = [], t_imp + 0.3, 0
        while t < t_sky - 0.12:
            out.append(dict(t=t))
            t += 0.36 + 0.06 * ((k * 7) % 3)
            k += 1
        return out
    thr, _ = T.pick("s3 网里甩尾", "s3_2003", r"thrash|splatter", _thr)
    fx(t_imp, "net_struggle", -11.0, 0.0, "撞进网 → 网收拢 → 每一下甩尾（水下闷），sky 处硬切成空气", "s3_2003", src_n,
       cut_at=t_sky, check="onset", dur=max(1.0, t_sky - t_imp + 0.3), impact_at=0.0, close_at=t_close - t_imp,
       thrash_at=[round(e["t"] - t_imp, 4) for e in thr])
    fx(t_sky, "breach", -9.0, 0.0, "被拖出水：闷声瞬间变成开阔的空气（水泻下、水花、滴水）", "s3_2003", src_sky, check="onset")
    t_night = M("s3_2003.night")
    cage = M("s3_2003.cage_boat")
    rel = M("s3_2003.release")
    crowd_on = Ln("H01")["t"] - 1.2
    bed(t_sky, t_night + 1.0, "river_day", -10.0, fi=0.03, fo=1.0, scene="s3_2003",
        note="2003 江边白天：风、江水拍岸、远处的船、人群嘈杂（滤波噪声）；sky 时刻瞬间打开", wind=0.8,
        crowd_env=[(t_sky, -40.0), (crowd_on, -40.0), (crowd_on + 2.5, 0.0), (cage - 1.5, 0.0), (cage + 0.5, -8.0),
                   (rel, -14.0)],
        wind_env=[(t_sky, 3.0), (t_sky + 0.6, 0.0)])
    h03 = Ln("H03")
    t_strain, src_ls = T.one("s3 八个人使劲（没抬动）", "s3_2003", r"lift.*strain|strain", h03["t"] + 0.55)
    t_quilt, src_q = T.one("s3 棉被甩上来", "s3_2003", r"quilt|cloth", h03["t"] + 2.45, exclude=r"warm")
    t_heave, src_h = T.one("s3 抬起来了", "s3_2003", r"heave|lift", h03["t"] + 3.45, exclude=r"strain")
    fx(t_strain - 0.3, "mud_steps", -15.0, 0.0, "八个人围上来使劲：脚在泥滩上挪、踩实", "s3_2003", src_ls,
       dur=max(1.0, t_quilt - t_strain + 0.2), rate=3.5, seed=21)
    fx(t_strain, "cloth_strain", -8.0, 0.0, "使劲：布与身体的摩擦（没抬动）", "s3_2003", src_ls, dur=max(1.2, t_quilt - t_strain),
       heaves=2)
    fx(t_quilt, "quilt_throw", -12.0, 0.0, "棉被甩上来盖住她", "s3_2003", src_q, check="slope")
    fx(t_heave, "cloth_strain", -7.0, 0.0, "裹着棉被抬起来：用力感", "s3_2003", src_h, dur=2.2, heaves=2, seed=23)
    fx(t_heave + 0.15, "mud_steps", -13.0, 0.0, "抬着走：一群人的脚踩在泥滩上", "s3_2003", src_h,
       dur=max(1.5, cage - 0.5 - t_heave), rate=6.0, seed=22)
    t_warm, src = T.one("s3 棉被特写（很暖）", "s3_2003", r"warm", Ln("L31")["t"] - 0.35)
    fx(t_quilt + 0.35, "quilt_rustle", -12.0, 0.1, "棉被的沙沙（裹着、抬着、贴着她）", "s3_2003", src_q, dur=max(2.0, cage - 0.4 - t_quilt - 0.35))
    fx(cage - 0.3, "boat_creaks", -12.0, 0.0, "网箱船：木船吱呀、水拍船身", "s3_2003", "marks", dur=max(3.0, rel - cage))
    evs, src = T.pick("s3 量尺", "s3_2003", r"measure|tape", lambda: [dict(t=Ln("H04")["t"] + 0.3, dur=1.75)])
    fx(evs[0]["t"], "tape_measure", -22.0, -0.1, "量体长：钢卷尺拉出（带刻度的墨线沿她身体量过去）", "s3_2003", src, check="onset",
       dur=min(max(_dur(evs[0], 1.75), 0.6), 3.0))
    st_end = M("s3_2003.stitch_end")
    evs, src = T.pick("s3 二十四针", "s3_2003", r"stitch|needle",
                      lambda: [dict(t=st_end - (23 - i) * 0.24, i=i) for i in range(24)], exclude=r"knot", expect=24)
    for k, e in enumerate(evs):
        nxt = evs[k + 1]["t"] - e["t"] if k + 1 < len(evs) else 0.24
        fx(e["t"], "stitch", -15.0, 0.0, f"第 {k + 1} 针：穿刺 + 拉线", "s3_2003", src, check="onset", interval=nxt, seed=600 + k)
    t_knot, src = T.one("s3 打结剪线", "s3_2003", r"knot", st_end + 0.35)
    fx(t_knot, "snip", -16.0, 0.0, "打结、剪线", "s3_2003", src, check="slope")
    ping0 = M("s3_2003.tag_ping_start")
    crash_t, src_c = T.one("s3 触礁", "s3_2003", r"crash|reef", M("s3_2003.crash"))
    t_tag, src = T.one("s3 信标扣上背", "s3_2003", r"clip|tag.*(attach|click|on)|beacon.*(attach|click)", Ln("L33")["t"] + 1.95)
    fx(t_tag, "tag_click", -12.0, 0.1, "信标扣上背的咔哒", "s3_2003", src, check="slope")
    pings, src_pg = T.pick("s3 信标嘀（每 2 s）", "s3_2003", r"ping|beep|嘀",
                           lambda: [dict(t=ping0 + 2.0 * k) for k in range(200) if ping0 + 2.0 * k < crash_t], exclude=r"start")
    pings = [e for e in pings if e["t"] < crash_t]
    t_rel, src_rl = T.one("s3 放流入水", "s3_2003", r"release|into_water", rel, exclude=r"out_of_water|egg")
    for k, e in enumerate(pings):
        uw = e["t"] >= t_rel
        fx(e["t"], "beacon_ping", -28.5 if uw else -25.0, 0.0,
           f"信标「嘀」第 {k + 1} 声（{'放流后水下：水下滤波 + 微混响' if uw else '船上'}）", "s3_2003", src_pg,
           cut_at=crash_t, check="onset", mode="uw" if uw else "air")
    fx(t_rel, "release_splash", -11.0, 0.0, "放流：她滑进江里（入水 + 水花 + 翻涌）", "s3_2003", src_rl, check="slope")
    t_turn, src = T.one("s3 在下游折返", "s3_2003", r"turn", Ln("L34")["t"] + 2.75)
    fx(t_turn, "swirl_turn", -20.0, 0.0, "她在下游折返、转身往上游（江面一道水被带转）", "s3_2003", src, dur=1.8)
    t_eng, src_e = T.one("s3 跟踪船引擎", "s3_2003", r"engine", t_night + 0.4)
    bed(t_night - 0.5, Ln("L35")["t"] + 0.8, "river_night", -11.0, fi=1.2, fo=2.2, scene="s3_2003",
        note="夜江：安静的水拍船身；触礁后船身摇晃、之后只剩水拍船", rock_at=[crash_t])
    fx(t_eng, "diesel_boat", -8.0, 0.0, "跟踪船的柴油机「突突」（近，在 B1/B2 身后），触礁处硬切", "s3_2003", src_e,
       cut_at=crash_t, dur=crash_t - t_eng + 0.6, fade_in=0.6)
    fx(t_eng + 0.3, "receiver_hiss", -24.0, 0.25, "接收机的细微电子声", "s3_2003", "marks", cut_at=crash_t,
       dur=max(1.0, crash_t - t_eng))
    fx(crash_t, "crash", -4.5, 0.0, "触礁：木头与金属撞击、螺旋桨打石头、船身摇晃的水，嘀声断在这一刻；之后引擎熄火", "s3_2003",
       src_c, check="onset")
    # 夜里跟踪船段之后：她在金鸡尾等（黑墨）→ 墨慢慢洇开接 S4 的 3D 江水
    s5 = S("s5_sturgeon")
    l36 = Ln("L36")
    evs, src_b = T.pick("s3 墨洇开接 S4", "s3_2003", r"bleed", lambda: [dict(t=Le("L36") - 0.25, end=s4["start"] - 0.3)])
    t_bl, bl_end = evs[0]["t"], evs[0]["t"] + _dur(evs[0], 3.0)
    bed(Ln("L35")["t"] - 1.2, s5["start"] + 0.8, "uw_river", -12.0, fi=2.0, fo=1.6, scene="s3_2003→s4_seven",
        note="她在金鸡尾停下来（极静的水下）→ 墨洇开，江水涨起来接 S4",
        master_env=[(Ln("L35")["t"] - 1.2, -16.0), (t_bl, -15.0), (max(bl_end, t_bl + 0.5), -1.0), (s4["start"] + 0.5, 0.0)])
    for c in CUES:  # 触礁之前夜里的声音（嘀、柴油机、接收机）连尾巴硬切
        if "sfx" in c and c.get("scene") == "s3_2003" and t_night - 3.0 <= c["t"] < crash_t - 1e-3 and "cut_at" not in c:
            c["cut_at"] = round(crash_t, 4)

    # ================================================================ S4 七年
    tag_close = M("s4_seven.tag_close")
    l37 = Ln("L37")
    sb_mark, sl_mark = M("s4_seven.search_boat"), M("s4_seven.search_leave")

    # 旧信标的叫声：画面（s4 events.js）给了四声、一声比一声弱（amp），最后一声之后 tag_dead —— 按画面走（配 L37
    # 「又叫了很久。后来有一天，它不叫了」）；没有画面事件时回退到导演手册最初的写法：L37 句中停顿里一声极远、极弱的「嘀」
    def _ping_fb():
        gap = _gap_in_line("L37")
        if gap and gap[1] >= 0.3:
            return [dict(t=l37["t"] + gap[0] + min(0.35, gap[1] * 0.4), amp=1.0)]
        return [dict(t=tag_close + 0.8, amp=1.0)]
    if S4_TAG_PINGS == "picture":
        evs, src = T.pick("s4 旧信标的叫声（一声比一声弱）", "s4_seven", r"tag_ping|ping|beep", _ping_fb, exclude=r"dead|silence")
    else:
        evs, src = _ping_fb(), "marks"
    for k, e in enumerate(evs):
        amp = float(e.get("amp", 1.0))
        fx(e["t"], "beacon_ping", -31.0 + 20 * np.log10(max(amp, 0.05)), 0.0,
           f"她背上旧信标的「嘀」：极远、极弱（第 {k + 1} 声，强度 {amp:g}{'，最后一声，之后再没有了' if e.get('last') else ''}）",
           "s4_seven", src, check="onset", mode="far", seed=250 + k)
    t_el, src = T.one("s4 电感视觉（头顶的船）", "s4_seven", r"electro", sb_mark)
    fx(t_el, "electro_sparkle", -27.0, 0.0, "电感视觉打开：一圈很轻的波 + 稀疏的闪烁（一直接到 S5 的电感）", "s4_seven", src,
       check="onset", dur=max(2.0, s5["start"] + 1.2 - t_el), density=7.0, wave=0.4, fade_out=1.4, twinkle=0.3, seed=255)
    passes, src_p = T.pick("s4 船一次次从头顶开过（延时）", "s4_seven", r"boat_pass",
                           lambda: [dict(t=sb_mark + 1.5, dur=4.2), dict(t=sb_mark + 4.5, dur=3.8)])
    for k, e in enumerate(passes):
        d = _dur(e, 4.0)
        fx(e["t"] - d / 2, "small_boat", -18.0, 0.0, f"第 {k + 1} 次：一条船很快地从头顶开过去（隔着水，像回忆）", "s4_seven", src_p,
           t_arrive=d / 2, t_leave=d / 2, recede=d / 2 + 0.8, f_fire=(21.0, 24.5, 19.0)[k % 3], seed=260 + k)
    evs, src_a = T.pick("s4 第三次：减速停在她头顶", "s4_seven", r"boat_arrive|arrive",
                        lambda: [dict(t=Ln("L40")["t"] - 2.6, dur=2.8)])
    t_arr, d_arr = evs[0]["t"], _dur(evs[0], 2.8)
    t_dep, _ = T.one("s4 船开走", "s4_seven", r"boat_leave|depart", sl_mark + 0.9)
    fx(t_arr, "small_boat", -15.0, 0.0, "第三次：船减速、停在她头顶（引擎闷声隔着水），水听器收上去后开走", "s4_seven", src_a,
       t_arrive=d_arr, t_leave=max(d_arr + 0.5, t_dep - t_arr), recede=max(2.0, s5["start"] + 1.5 - t_dep), seed=263)
    evs, src = T.pick("s4 水听器放下来", "s4_seven", r"hydrophone_down|hydrophone.*lower|lower.*hydrophone",
                      lambda: [dict(t=Ln("L40")["t"] - 0.1, dur=1.8)])
    t_low, d_low = evs[0]["t"], _dur(evs[0], 1.8)
    fx(t_low, "cable_creak", -22.0, 0.0, "放下缆绳（闷吱呀）", "s4_seven", src, dur=d_low + 0.4)
    fx(t_low + 0.12, "hydro_plop", -16.0, 0.1, "水听器入水的一声轻响（从水下听）", "s4_seven", src, check="onset")
    evs, src = T.pick("s4 水听器拉上去", "s4_seven", r"hydrophone_up|hydrophone.*(out|up|lift)", lambda: [dict(t=sl_mark, dur=1.6)])
    t_up, d_up = evs[0]["t"], _dur(evs[0], 1.6)
    fx(t_up, "cable_creak", -22.0, 0.0, "收缆", "s4_seven", src, dur=d_up + 0.3, seed=77)
    fx(t_up + 0.85 * d_up, "hydro_plop", -19.0, 0.1, "水听器被拉出水面（拉到头的那一下）", "s4_seven", src, check="slope", out=True)

    # ================================================================ S5 老鲟
    s6 = S("s6_yibin")
    bed(s5["start"] - 0.8, s6["start"] + 0.8, "uw_river", -12.0, fi=1.6, fo=1.6, scene="s5_sturgeon",
        note="水下江底床（对话中只有水）", flow=1.1)
    fg = M("s5_sturgeon.far_glow")
    rush = M("s5_sturgeon.rush")
    rev = M("s5_sturgeon.reveal")
    t_rev, src_rev = T.one("s5 光团切回真实视角", "s5_sturgeon", r"reveal|electro_off_cut", rev)
    t_fg, src = T.one("s5 电感：远处一团光", "s5_sturgeon", r"far_glow|glow", fg)
    fx(t_fg, "electro_sparkle", -20.0, 0.0, "电感视觉里远处一团光：稀疏的电感闪烁（S1 同一套声音语言），reveal 处随视角硬切", "s5_sturgeon",
       src, cut_at=t_rev, dur=max(1.0, t_rev - t_fg + 0.3), density=11.0, wave=0.0, fade_out=0.05, twinkle=0.5)

    def _beats():
        out, t = [], fg
        while t < rev:
            bpm = 52 + 34 * min(1.0, (t - fg) / max(rev - fg, 1.0)) ** 1.4
            out.append(dict(t=t))
            t += 60.0 / bpm
        return out
    evs, src = T.pick("s5 心跳（far_glow 起、慢慢加快）", "s5_sturgeon", r"heart|beat", _beats, exclude=r"old")
    t_ask = Ln("L42")["t"]
    amps = [float(e.get("a", 0.5 + 0.2 * smoothstep((e["t"] - fg) / max(t_ask - fg, 0.5))
                          + 0.3 * smoothstep((e["t"] - rush) / 1.5))) for e in evs]
    fx(evs[0]["t"], "heart", -10.0, 0.0, "far_glow 起她的心跳：低沉、越来越快（冲过去时最快），reveal 前最后一下", "s5_sturgeon", src,
       check="onset", beats_at=[e["t"] for e in evs], amps=amps)
    evs, src = T.pick("s5 她冲过去", "s5_sturgeon", r"rush|dash", lambda: [dict(t=rush, dur=rev - rush)])
    fx(evs[0]["t"], "water_rush", -8.0, 0.0, "她冲过去的水流", "s5_sturgeon", src, check="onset",
       dur=min(max(_dur(evs[0], 3.2), 1.5), 4.5))
    fx(t_rev, "presence_push", -9.0, 0.0, "老鲟从浑水里露出来：大物体推水的低沉存在感", "s5_sturgeon", src_rev, check="onset", dur=3.2)
    evs, src = T.pick("s5 老鲟游近", "s5_sturgeon", r"old_in|swim_by", lambda: [dict(t=rev + 0.2, dur=3.5, dist=3.0)],
                      t0=rev - 0.5, t1=rev + 2.0)
    e = evs[0]
    fx(e["t"], "uw_whoosh", -15.0 - 3.0 * np.log2(max(float(e.get("dist", 3.0)), 0.5) / 1.5), 0.0,
       "老鲟慢慢游近（很大、很慢的推水）", "s5_sturgeon", src, check="peak", dur=_dur(e, 3.5), tpk=0.5, size=1.7, bright=0.75,
       pan_from=0.5, pan_to=0.05, seed=151)
    for key, rx, fb_t, fb_d, wave in (("s5 回忆的波（电感）", r"memory", Ln("O03")["t"] + min(1.7, Ln("O03")["dur"] * 0.32),
                                       Ln("O04")["t"] + 0.45 - (Ln("O03")["t"] + min(1.7, Ln("O03")["dur"] * 0.32)), 0.45),
                                      ("s5 透过身体看见卵（电感）", r"electro_on_eggs|eggs", Ln("L45")["t"] - 0.25,
                                       Ln("L45")["dur"] + 1.55, 0.3)):
        evs, src = T.pick(key, "s5_sturgeon", rx, lambda fb_t=fb_t, fb_d=fb_d: [dict(t=fb_t, dur=fb_d)], exclude=r"off|out")
        e = evs[0]
        fx(e["t"], "electro_sparkle", -25.0, 0.0, f"{key[3:]}：一圈很轻的波 + 稀疏闪烁（压在台词下面）", "s5_sturgeon", src,
           check="onset", dur=max(1.5, _dur(e, fb_d)), density=9.0, wave=wave, fade_out=0.8, twinkle=0.35,
           seed=160 + len(key))
    t_sl, src = T.one("s5 老鲟转身", "s5_sturgeon", r"sturgeon_leave|turn", M("s5_sturgeon.sturgeon_leave"))
    fx(t_sl, "swim_away", -13.0, 0.0, "老鲟转身：尾鳍一拍 + 漩涡", "s5_sturgeon", "marks", check="onset", dur=2.4, side=-1.0)
    evs, src = T.pick("s5 老鲟从身边游走", "s5_sturgeon", r"leave|away|swim_by", lambda: [dict(t=t_sl + 2.2, dur=4.0, dist=1.0)],
                      t0=t_sl - 0.5)
    e = evs[-1]
    fx(e["t"], "uw_whoosh", -12.0 - 3.0 * np.log2(max(float(e.get("dist", 1.0)), 0.5) / 1.5), 0.0,
       "老鲟从身边擦过、没入浑水（最近处）", "s5_sturgeon", src, check="peak", dur=_dur(e, 4.0), tpk=0.5, size=1.6, bright=0.8,
       pan_from=0.35, pan_to=-0.75, seed=171)

    # ================================================================ S6 宜宾
    s7 = S("s7_end")
    wn = M("s6_yibin.wait_night")
    re_ = M("s6_yibin.release_eggs")
    lapse0, _ = T.one("s6 延时开始（城里的灯一盏盏熄）", "s6_yibin", r"timelapse_start", wn + 0.35)
    bridge, _ = T.one("s6 桥上的灯带熄灭", "s6_yibin", r"bridge|city_lights_off", wn + 4.3)
    lapse1, _ = T.one("s6 延时结束", "s6_yibin", r"timelapse_end", wn + 4.64)
    bed(s6["start"] - 0.8, s7["start"] + 0.8, "uw_river", -12.0, fi=1.6, fo=1.6, scene="s6_yibin",
        note="宜宾夜：水下听到的城市低频嗡鸣 + 桥上车流的远雷；延时里城里的灯一盏盏熄、嗡鸣一层层退，桥灯熄时车流的远雷也断了",
        city=1.0, traffic=1.0,
        city_env=[(lapse0, 0.0), (lapse1, -18.0)], traffic_env=[(wn, 0.0), (bridge - 0.4, -4.0), (bridge + 0.5, -35.0)],
        master_env=[(wn, 0.0), (lapse1, -5.0), (re_, -5.0), (re_ + 6.0, -3.5)])
    evs, src = T.pick("s6 穿过两江分界", "s6_yibin", r"cross|swim_by", lambda: [dict(t=s6["start"] + 6.3, dur=3.0, dist=1.6)])
    e = evs[0]
    dist = float(e.get("dist", 1.6))
    fx(e["t"], "uw_whoosh", -12.0 - 3.0 * np.log2(max(dist, 0.5) / 1.5), 0.0, "她穿过两江分界（两股水的交界，身体推开水）", "s6_yibin",
       src, check="peak", dur=_dur(e, 3.0), tpk=0.5, size=1.2, bright=0.95, pan_from=-0.5, pan_to=0.5, seed=341)
    t_m0, src = T.one("s6 回忆：一代代白鲟的光影（电感）", "s6_yibin", r"s6_memory|memory", wn - 8.0, exclude=r"off")
    t_m1, _ = T.one("s6 回忆散去", "s6_yibin", r"memory_off", wn)
    fx(t_m0, "electro_sparkle", -26.0, 0.0, "回忆的电感视觉：一圈很轻的波 + 稀疏闪烁（压在台词下面）", "s6_yibin", src, check="onset",
       dur=max(1.5, t_m1 + 0.2 - t_m0), density=8.0, wave=0.4, fade_out=0.8, twinkle=0.35, seed=345)
    ghosts, src = T.pick("s6 一代代白鲟的影子游过", "s6_yibin", r"ghost", lambda: [dict(t=t_m0 + 0.75 + 2.1 * k) for k in range(3)])
    for k, e in enumerate(ghosts):
        fx(e["t"] + 0.9, "uw_whoosh", -27.0, 0.0, f"第 {k + 1} 条白鲟的影子游过（极轻、很远的推水）", "s6_yibin", src,
           dur=2.6, tpk=0.35, size=1.0, bright=0.7, pan_from=(-0.6, 0.5, -0.2)[k % 3], pan_to=(0.3, -0.5, 0.6)[k % 3], seed=346 + k)
    t_e0, src = T.one("s6 电感：四周是空的", "s6_yibin", r"s6_empty|empty", wn + 5.0)
    fx(t_e0, "electro_sparkle", -30.0, 0.0, "电感视觉：四周是空的（闪烁极稀）", "s6_yibin", src, check="onset",
       dur=max(1.5, re_ - t_e0), density=3.0, wave=0.25, fade_out=1.0, twinkle=0.1, seed=358)
    spurts, src_s = T.pick("s6 产卵（一股一股）", "s6_yibin", r"egg_release|spurt|spawn", lambda: [dict(t=re_ + 0.5 + 0.62 * k, w=1.0) for k in range(7)])
    fx(spurts[0]["t"], "eggs_snow", -10.0, 0.0, "产卵：成千上万颗卵像雪一样散开（柔软、细密，不叮当）", "s6_yibin", src_s, check="onset", dur=9.5)
    for k, e in enumerate(spurts):
        w = float(e.get("w", 1.0))
        fx(e["t"] + 0.12, "uw_whoosh", -24.0 + 20 * np.log10(max(w, 0.2) / 1.4), 0.0, f"第 {k + 1} 股卵推出去的一下软水流", "s6_yibin",
           src_s, dur=0.9, tpk=0.25, size=0.45, bright=1.0, pan_from=-0.15, pan_to=0.15, seed=362 + k)
    t_gl, src = T.one("s6 卵亮起", "s6_yibin", r"eggs_glow|glow", M("s6_yibin.eggs_glow"))
    fx(t_gl, "warm_glow", -11.0, 0.0, "卵在电感视觉里亮起：轻微的温暖质感（和声交给配乐）", "s6_yibin", src, dur=8.0, attack=2.2)
    l52 = Ln("L52")
    ed = M("s6_yibin.eggs_dark")
    evs, src = T.pick("s6 卵一颗颗熄灭（宁可少）", "s6_yibin", r"egg_out|egg.*(dim|fade)",
                      lambda: [dict(t=x) for x in _even(l52["t"] + 1.9, ed - 0.05, 6)], limit=5)
    for k, e in enumerate(evs):
        fx(e["t"], "egg_dim", -29.0, 0.0, f"一颗卵暗下去（第 {k + 1} 声，极轻；画面熄的比这多，宁可少）", "s6_yibin", src, check="onset",
           seed=700 + k)

    # ================================================================ S7 最后
    s8 = S("s8_epilogue")
    lo, _ = T.one("s7 她的光熄灭", "s7_end", r"lights_out", M("s7_end.lights_out"))
    lo_ev = T.find("s7_end", r"lights_out")
    lo_dur = _dur(lo_ev[0], 2.9) if lo_ev else 2.9
    lp_, _ = T.one("s7 最后一下（last_pulse）", "s7_end", r"last_pulse", M("s7_end.last_pulse"))
    blk, _ = T.one("s7 全黑", "s7_end", r"black", M("s7_end.black"))
    bed(s7["start"] - 0.8, s8["start"], "uw_river", -12.0, fi=1.6, fo=2.9, scene="s7_end",
        note="lights_out 之后环境一层层变薄（砾石 → 湍动 → 轰鸣），black 之后只剩江水，淡到 S7 结束",
        gravel_env=[(lo, 0.0), (lo + 1.2, -45.0)], hush_env=[(lo + 0.8, 0.0), (lo + 3.5, -45.0)],
        rumble_env=[(lo + 2.0, 0.0), (lp_, -30.0), (blk, -45.0)],
        flow_env=[(lo, 0.0), (blk, -3.0), (s8["start"] - 0.2, -30.0)])
    sink = M("s7_end.sink")
    t_touch, src_t = T.one("s7 腹部碰到卵石", "s7_end", r"touch|settle|pebble", sink + 1.4)
    fx(sink, "sink_settle", -12.0, 0.0, "她慢慢沉下去，腹部碰到卵石（软闷响 + 卵石细碎声 + 一小团泥沙）", "s7_end", src_t,
       t_contact=max(0.8, t_touch - sink), sub=[("腹部碰到卵石", t_touch, "slope")])
    evs, src = T.pick("s7 吻搭到石头上", "s7_end", r"settle|rostrum.*(rest|stone)", lambda: [dict(t=t_touch + 3.3)], t0=t_touch + 0.5)
    fx(evs[0]["t"], "bottom_touch", -20.0, 0.0, "长吻轻轻搭到一块石头上（很小的一下）", "s7_end", src, check="onset", strength=0.5)
    gt, g_a, g_l = [], [], []
    t, per = sink + 0.6, 2.4
    while t < lo + 2.2:
        gt.append(t)
        g_a.append(max(0.35, 1.0 - 0.035 * len(gt)))
        g_l.append(min(2.1, 1.3 + 0.05 * len(gt)))
        t += per
        per *= 1.09
    fx(gt[0], "gill_breaths", -22.0, 0.0, "越来越慢的呼吸/鳃动", "s7_end", "marks", times=gt, amps=g_a, lens=g_l)
    evs, src = T.pick("s7 心跳（越来越慢，最后一下 = last_pulse）", "s7_end", r"heartbeat|heart|beat",
                      lambda: [dict(t=lo + 0.35), dict(t=lo + 2.0), dict(t=lo + 3.8), dict(t=lo + 5.3), dict(t=lp_)],
                      exclude=r"last_pulse")
    evs = [e for e in evs if e["t"] <= lp_ + 1e-3] or [dict(t=lp_)]
    nb = len(evs)
    amps = [0.62 - 0.3 * i / max(nb - 1, 1) for i in range(nb)]
    amps[-1] = max(amps[-1], 0.45)  # 最后一下稍清楚一点（但不比开头响）
    fx(evs[0]["t"], "heart", -12.0, 0.0, "她的心跳越来越慢、越来越轻，last_pulse 是最后一下", "s7_end", src, check="onset",
       beats_at=[e["t"] for e in evs], amps=amps, sub=[("last_pulse", evs[-1]["t"], "slope")])
    t_el7, src = T.one("s7 最后一次电感视觉", "s7_end", r"electro", lo - 0.9)
    fx(t_el7, "electro_sparkle", -24.0, 0.0, "最后一次电感视觉：闪烁随着她的光一盏盏熄掉变稀、消失", "s7_end", src, check="onset",
       dur=max(1.5, lo + lo_dur - t_el7), density=10.0, wave=0.3, fade_out=lo_dur, twinkle=0.4, seed=399)

    # ================================================================ S8 尾声
    fb, _ = T.one("s8 淡黑", "s8_epilogue", r"fade", M("s8_epilogue.fade_black"))
    bed(s8["start"], fb + 1.6, "paper_room", -36.0, fi=1.5, fo=2.5, scene="s8_epilogue",
        note="尾声几乎无环境：只有极淡的一点空气（纸和笔在前面）")
    t_pin, src = T.one("s8 宣纸淡入", "s8_epilogue", r"paper", M("s8_epilogue.paper_in"))
    fx(t_pin, "paper_breath", -24.0, 0.0, "宣纸淡入（比长卷更素）", "s8_epilogue", src, check="onset", dur=1.4, body=0.6)
    vw = M("s8_epilogue.verse_write")
    evs, src = T.pick("s8 「有鳣有鲔」每一笔", "s8_epilogue", STROKE_RX,
                      lambda: _strokes_fallback(_chars_seq("有鳣有鲔", vw, 5.0, gap=0.15)), exclude=r"wash|card",
                      t1=M("s8_epilogue.verse_src"), expect=47)
    for k, e in enumerate(evs):
        fx(e["t"], "brush_stroke", -14.0, (-0.15 + 0.3 * (k % 4) / 3), f"「有鳣有鲔」{e.get('char', '')} 第 {k + 1} 笔（浓墨）", "s8_epilogue",
           src, check="onset", dur=min(max(_dur(e, 0.09), 0.05), 0.5), pressure=0.9, dry=0.15, size=1.3, seed=800 + k)
    ww = M("s8_epilogue.wei_wash")
    wd = M("s8_epilogue.wash_done")
    t_drop, src = T.one("s8 水滴落在「鲔」上", "s8_epilogue", r"drop|drip", ww)
    fx(t_drop, "drop_on_paper", -13.0, 0.0, "一滴水落在「鲔」字上", "s8_epilogue", src, check="onset")
    evs, src = T.pick("s8 墨被水晕开、冲走", "s8_epilogue", r"wash", lambda: [dict(t=t_drop, end=wd)])
    t_w, w_end = evs[0]["t"], evs[0]["t"] + _dur(evs[0], wd - t_drop)
    fx(t_w + 0.05, "ink_bleed", -9.0, 0.0, "墨被水晕开、变淡、被冲走的湿声", "s8_epilogue", src,
       dur=max(2.0, w_end - t_w), wash_from=1.0, wash_to=max(2.0, w_end - t_w - 0.8))
    return CUES


def main(write=True, log=print):
    T = Timing()
    cues = build(T)
    out = dict(
        version=1, sr=48000, duration=T.duration,
        note=("t=同步点（秒，全片绝对时间）；gain_db 相对音效库电平（单次峰值 -3 dBFS / 长纹理 -23 LUFS，环境床 full ≈ -23 LUFS）；"
              "p 中 *_at 为绝对时间，*_env 为 [(绝对时间, dB)]。每次 build_mix 自动重写本文件。"),
        timing=T.summary(),
        cues=sorted(cues, key=lambda c: c["t"]),
    )
    if write:
        path = ROOT / "audio/cues.json"
        path.write_text(json.dumps(out, ensure_ascii=False, indent=1))
        n_b = sum(1 for c in cues if "bed" in c)
        log(f"  cue 表：{len(cues)} 条（{n_b} 条环境床，{len(cues) - n_b} 条单次）→ audio/cues.json")
    T.print_table(log)
    return out, T


if __name__ == "__main__":
    main()
