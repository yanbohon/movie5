"""《鲔》音效库注册表 + 统一渲染入口。

render(name, seed, dur, **p) 返回 dict:
  audio  (2, n) float64
         单次音效：norm='peak'（默认）峰值 -3 dBFS；norm='lufs' 积分响度 -23 LUFS（长纹理用）；norm='none' 保持函数自己的电平
         环境床：各层在函数里按绝对电平校准（full 状态约 -23 LUFS），这里不再整体归一（保证不同场景同一张床电平一致）
  pre    秒；缓冲区里"同步点"的位置。混音时把缓冲放在 cue.t - pre，使同步点正好落在 cue.t
  events 同步点之后的内部事件相对时间
"""
from __future__ import annotations

import inspect

import numpy as np

from . import dsp
from .beds import BEDS
from .ink import FUNCS as INK
from .shore import FUNCS as SHORE
from .water import FUNCS as WATER

PRE_ROLL = 0.005
ONESHOT_PEAK_DB = -3.0
ONESHOT_REF_LUFS = -23.0
TEXTURE_MAX_PLR = 16.0  # 颗粒纹理（norm=lufs）峰值最多比积分响度高多少 dB

ONESHOTS = {**WATER, **INK, **SHORE}
ALL = {**BEDS, **ONESHOTS}

RECIPES = {
    # 环境床
    "uw_river": "水下江底：棕噪 20–110 Hz 极低轰鸣（0.025/0.11 Hz 非周期起伏）+ 两层粉噪水流 70–650 Hz（时变低通 250–700 Hz 慢漂）"
                "+ 350–1400 Hz 极轻湍动 + 稀疏远处砾石簇（每颗石子随机落进 8 个随机频率的 τ≤0.7 ms 共振 → 无音高）；"
                "可选宜宾夜的城市低频（宽带 32–170 Hz、只有一个很宽的 62 Hz 鼓包）与桥上车流远雷；整床二阶低通 2.6 kHz；各层可独立自动化",
    "scroll_air": "2D 长卷：极淡的远处江风（粉噪 180–2200 Hz、非周期阵风）+ 更淡的远处水声；gaps_at 挖'水声的缺口'，cut_at 硬切后慢慢回来",
    "river_day": "2003 江边白天：开阔的风（时变带通呼啸 300–850 Hz + 湍流嘶声）+ 宽广江水 + 拍岸（时变带通水涌 + 水花 + 回落的嘶）"
                 "+ 远处柴油船的低频轮廓 + 人群嘈杂（语音谱形噪声 × 14 人音节包络，听不出字）",
    "river_night": "2003 夜江：水拍木船壳（空腔闷响 + 细水花）+ 低沉江水 + 极轻夜风；rock_at 触礁后拍水变密变重再平息",
    "paper_room": "尾声：几乎不可闻的一点空气（粉噪 90–3200 Hz）",
    # 水下
    "uw_whoosh": "游过镜头：时变带通水流 110→480→150 Hz + 75 Hz 以下压力 + 湍动；包络尖峰 = 最近点（同步点）",
    "electro_sparkle": "电感视觉：荡开的波（带通噪声 1.5→9 kHz）+ 泊松正弦颗粒（3–11 kHz 连续随机频率、3–12 ms）+ 小簇'一闪一闪'，无固定音高",
    "field_crackle": "电场开始闪烁、出现噪点：稀疏电噼啪由少到多，最后接近白噪声",
    "ship_pass": "大船压顶：距离模型（1/d、远闷近亮）+ 37 Hz 点火谐波（多普勒 ±3.5%）+ 12.4 Hz 叶片脉冲的低频'呼呼' + 空化泊松噼啪"
                 "+ 宽带船体轰鸣 + 20–45 Hz 压力涌；ship_pass 白噪声冲垮电感，ship_peak 最近一记重拍",
    "sediment": "泥沙打在身上：极密细沙颗粒（2.6–5.4 kHz 超短共振、闷）+ 沙云的沙沙，之后慢慢落定",
    "heart": "她的心跳：lub（44→ Hz 下滑正弦 + 闷击）+ dub，轻饱和后低通 180 Hz（体内、水下）",
    "water_rush": "她冲过去：起步低频推水 + 带通扫频的前冲水流",
    "presence_push": "老鲟出现：大物体推水的低沉存在感（18–55 Hz 压力涌 + 55–300 Hz 水体位移）",
    "swim_away": "老鲟游走：尾鳍一拍 + 远去下沉的漩涡",
    "small_boat": "S4 头顶搜寻船（隔水）：21 Hz 点火谐波 + 小螺旋桨轻空化，渐近—悬停—远去",
    "cable_creak": "缆绳在水里的闷吱呀（黏滑激励 → 260–1100 Hz 共振）",
    "hydro_plop": "水听器入水/出水（从水下听）：闷冲击 + Minnaert 气泡 + 小气泡串",
    "eggs_snow": "产卵像雪落：大量极轻噪声颗粒 1–4.5 kHz + 轻沙沙，声像越铺越宽；不用正弦、不叮当",
    "warm_glow": "卵亮起的温暖质感：140–900 Hz 暖色噪声缓慢开花 + 极淡空气，无音高",
    "egg_dim": "一颗卵暗下去：极轻的下沉'噗'",
    "sink_settle": "沉到卵石上：轻的下沉水体 + 落底软闷响 + 卵石细碎咔啦 + 一小团泥沙",
    "gill_breaths": "越来越慢的鳃动：水进/水出两段柔和噪声涨落",
    # 纸与笔
    "brush_stroke": "毛笔一笔：落纸软'嗒' + 拖行摩擦（纤维颗粒、按压暗/速度亮、飞白噼啪）+ 提笔轻扫",
    "light_stroke": "片名一笔：柔和的笔毛擦过 + 极低的无音高光感 swell",
    "grain_dissolve": "片名散成颗粒：细碎沙沙渐稀、声像散开漂向一侧",
    "paper_breath": "宣纸淡入/铺开：很轻的纸面沙沙 + 纸体的'呼'",
    "scroll_rush": "长卷飞速掠过：风声扫频 + 纸边颤动 + 停住时纸面一顿",
    "asteroid_flight": "朱砂陨石划过：火焰气流呼啸 + 稀疏噼啪 + 低频轰",
    "asteroid_impact": "陨石落地：58→26 Hz 低频冲击 + 闷击，两次越来越暗的远处回响 + 暗长尾（无碎片）",
    "ruler_line": "尺子画线：沉重的'咚'（木模态 + 桌面低频 + 硬咔）+ 硬而干的刮擦",
    "fish_sigh": "坝后鱼淡掉：极轻的叹息般气声",
    "small_brush": "小楷：一串很小很快的笔画",
    "drop_on_paper": "水滴落在字上：湿的轻'嗒' + 小溅开 + 吸进纸里的嘶",
    "ink_bleed": "墨被水晕开：湿噼啪由密到疏 + 软湿嘶 + 水漫过冲走的轻流动",
    # 2003
    "net_struggle": "网里挣扎（水下闷）：一次次甩动的低频水涌 + 气泡 + 网绳闷吱呀 + 纤维拉紧的滋",
    "breach": "出水：水从身上泻下 + 水花 + 滴水 + 重量离开水面的低频",
    "mud_steps": "八个人在泥滩上挪步：低频闷 + 湿'噗叽' + 拔脚吸声",
    "cloth_strain": "抬的用力感：布与身体的摩擦 + 布料绷紧细吱",
    "quilt_rustle": "棉被：厚软的棉布沙沙 + 细小摩擦 + 大动作的'呼'",
    "boat_creaks": "网箱船：木船吱呀 + 水拍船身空腔'咚'",
    "tape_measure": "量尺：钢卷尺拉出的细密咔哒 + 滑动摩擦 + 锁住",
    "stitch": "一针：穿刺细'嗒' + 18 ms 后拉线摩擦 + 线绷紧",
    "tag_click": "信标装上：接触小咔 + 主咔哒 + 三下轻棘轮",
    "beacon_ping": "信标'嘀'：1760 Hz 干净正弦 60 ms（8 ms 升余弦起音）；air / uw（水下滤波 + 多径 + 微混响）/ far（回忆，极远极弱）",
    "release_splash": "放流：滑落水声 → 沉重入水 + 水花 + 溅落 → 闷的翻涌 → 游开的漩涡",
    "diesel_boat": "跟踪船单缸柴油机'突突'：11 Hz 点火（88–350 Hz 排气共振 + 机械咔嗒，±2% 抖动）+ 排气/搅水底子 + 船体低频振动",
    "receiver_hiss": "接收机的细微电子声：极轻嘶声 + 偶发静噪咔",
    "crash": "触礁：低频撞击 + 木板模态与裂响 + 螺旋桨打石（金属铛 + 研磨）+ 船身摇晃的水 + 引擎挣扎熄火 + 船体吱呀",
}

PREVIEW = {
    "uw_river": {"dur": 20.0}, "scroll_air": {"dur": 20.0, "gaps_at": [8.0, 11.0]},
    "river_day": {"dur": 20.0}, "river_night": {"dur": 20.0, "rock_at": [8.0]}, "paper_room": {"dur": 20.0},
    "electro_sparkle": {"dur": 8.0}, "ship_pass": {}, "sediment": {},
    "heart": {"beats_at": [0.0, 1.1, 2.1, 3.0, 3.8, 4.5, 5.2]},
    "small_boat": {"t_arrive": 2.5, "t_leave": 8.0, "recede": 4.0},
    "eggs_snow": {}, "warm_glow": {}, "gill_breaths": {"times": [0.0, 2.3, 4.8, 7.6], "amps": [1, 0.9, 0.75, 0.6]},
    "mud_steps": {"dur": 5.0}, "cloth_strain": {"dur": 4.0}, "quilt_rustle": {"dur": 4.0}, "boat_creaks": {"dur": 10.0},
    "diesel_boat": {"dur": 6.0}, "receiver_hiss": {"dur": 5.0}, "net_struggle": {"dur": 5.0},
    "brush_stroke": {"dur": 0.35}, "small_brush": {"dur": 1.5}, "ink_bleed": {"dur": 5.5},
}

VARIANTS = {
    "uw_river__city": ("uw_river", {"dur": 20.0, "city": 1.0, "traffic": 1.0}),
    "beacon_ping__uw": ("beacon_ping", {"mode": "uw"}),
    "beacon_ping__far": ("beacon_ping", {"mode": "far"}),
    "hydro_plop__out": ("hydro_plop", {"out": True}),
    "brush_stroke__dry_big": ("brush_stroke", {"dur": 0.5, "dry": 0.7, "size": 1.6}),
}


def kind_of(name: str) -> str:
    if name in BEDS:
        return "bed"
    if name in ONESHOTS:
        return "oneshot"
    raise KeyError(f"unknown sfx name: {name}")


def _accepts(fn, key):
    return key in inspect.signature(fn).parameters


def render(name: str, seed: int = 0, dur: float | None = None, **p) -> dict:
    kind = kind_of(name)
    if kind == "bed":
        if dur is None:
            raise ValueError(f"bed {name} 需要 dur")
        audio = BEDS[name](float(dur), seed=seed, **p)
        audio = dsp.hp(audio, 22, order=2)
        audio = dsp.fade(audio, 0.01, 0.01)
        out = dict(audio=audio, pre=0.0, events=[], kind="bed")
    else:
        fn = ONESHOTS[name]
        kw = dict(p)
        if dur is not None and _accepts(fn, "dur"):
            kw["dur"] = float(dur)
        r = fn(seed=seed, **kw)
        if isinstance(r, dict):
            audio, pre, events = r["audio"], r.get("pre", 0.0), r.get("events", [])
            level_db, norm = r.get("level_db", 0.0), r.get("norm", "peak")
        else:
            audio, pre, events, level_db, norm = r, 0.0, [], 0.0, "peak"
        audio = dsp.stereo(np.asarray(audio, dtype=float))
        audio = dsp.hp(audio, 16, order=1)
        if norm == "peak":
            audio = dsp.normalize_peak(audio, ONESHOT_PEAK_DB)
        elif norm == "lufs":
            audio = dsp.normalize_lufs(audio, ONESHOT_REF_LUFS)
            # 颗粒纹理的峰值-响度比最多 TEXTURE_MAX_PLR dB：离群颗粒会顶到母带限幅器（上一版泥沙、散开的光粒、墨被冲走
            # 都有单个颗粒比纹理本身高 24–27 dB，母带限幅压了 7–8 dB）
            audio = dsp.peak_tame(audio, ONESHOT_REF_LUFS + TEXTURE_MAX_PLR)
        audio = audio * dsp.dbg(level_db)
        audio = np.concatenate([np.zeros((2, dsp.ns(PRE_ROLL))), audio], axis=1)
        env = np.max(np.abs(audio), axis=0)
        nz = np.nonzero(env > dsp.dbg(-96))[0]
        if len(nz):
            audio = audio[:, : min(audio.shape[-1], nz[-1] + dsp.ns(0.05))]
        audio = dsp.fade(audio, 0.0005, 0.03)
        out = dict(audio=audio, pre=float(pre) + PRE_ROLL, events=[round(float(e) - float(pre), 4) for e in events],
                   kind="oneshot", norm=norm)
    a = out["audio"]
    if not np.all(np.isfinite(a)):
        raise FloatingPointError(f"{name}: 非有限值")
    return out
