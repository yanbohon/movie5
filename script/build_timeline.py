"""全片时间线：台词时刻、场景边界、画面/声音卡点（marks）。

画面、配乐、音效全部从 script/timeline.json 取时间。改了台词或配音后重跑：
  .venv/bin/python script/build_timeline.py
时间单位秒。每个场景是一串事件：
  ("line", id, gap)   上一个事件结束后空 gap 秒，再说这句
  ("at", id, t)       这句台词固定在场景内 t 秒（相对场景起点）
  ("mark", name, gap) 在当前游标 + gap 处打一个卡点（不推进游标）
  ("wait", gap)       游标前进 gap 秒
  ("markat", name, t) 在场景内 t 秒打卡点
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DUR = json.loads((ROOT / "tts/volc/durations_wav.json").read_text())
LINES = {ln["id"]: ln for ln in json.loads((ROOT / "script/lines.json").read_text())["lines"]}

FPS = 30

# 每个场景：(id, 开始时间, 结束时间 or None=按内容, 事件)
SCENES = [
    ("s0_cold", 0.0, 31.0, [
        ("markat", "card_in", 2.0),          # 字卡：长江 · 宜宾江段 / 2005—2010 年间 · 某一个春天
        ("markat", "card_out", 8.5),
        ("markat", "particles_in", 9.0),     # 黑里开始有极暗的悬浮颗粒
        ("at", "L01", 10.5),
        ("line", "L02", 1.8),
        ("line", "L03", 2.4),
        ("markat", "title_write", 22.0),     # 片名「鲔」：光的笔画一笔一笔写出来
        ("markat", "title_hold", 26.2),
        ("markat", "title_dissolve", 28.2),  # 字散成颗粒，接江底
    ]),
    ("s1_river", 31.0, None, [
        ("markat", "fade_in", 0.0),
        ("markat", "rostrum_enter", 4.5),    # 吻部尖端从浑水里伸出来
        ("at", "L04", 6.0),
        ("line", "L05", 1.5),                # 镜头推到小眼睛
        ("mark", "body_pass", 1.0),
        ("line", "L06", 2.4),
        ("mark", "electro_reveal", 0.6),     # 从吻部荡开一圈波，世界变成电感视觉
        ("wait", 0.6),
        ("line", "L07", 1.9),
        ("line", "L08", 1.1),
        ("line", "L09", 2.0),
        ("line", "L10", 1.5),
        ("mark", "rumble_start", 1.2),       # 远处轰鸣，电场开始闪烁
        ("wait", 1.4),
        ("line", "L11", 0.6),
        ("mark", "ship_pass", 0.4),          # 船从头顶压过：噪声白屏，切回真实视角，船底阴影、螺旋桨、泥沙风暴
        ("mark", "ship_peak", 3.6),
        ("mark", "ship_gone", 8.4),
        ("wait", 9.6),
        ("line", "L12", 0.0),
        ("wait", 2.6),
    ]),
    ("s2_scroll", None, None, [
        ("markat", "paper_in", 0.0),         # 宣纸：一条白鲟的工笔墨线，像古书插图
        ("at", "L13", 1.5),                  # 旁边写「白鲟」
        ("line", "L14", 1.0),                # 写「象鱼」
        ("mark", "scroll_rewind", 0.6),      # 镜头飞向长卷最右端（一亿五千万年前）
        ("wait", 2.4),
        ("line", "L15", 0.0),                # 远古：蕨类、苏铁、雾、河
        ("line", "L16", 1.4),                # 恐龙在河边饮水
        ("mark", "asteroid", 1.0),           # 朱砂一笔划过天空
        ("line", "L17", 1.0),
        ("line", "L18", 1.4),                # 山长高、河改道、冰川
        ("line", "L19", 1.4),                # 岸上有了人
        ("mark", "wei_write", 1.2),          # 大字「鲔」写在长卷上
        ("line", "L20", 1.2),
        ("line", "L21", 1.2),                # 天子乘舟，荐鲔于寝庙
        ("line", "L22", 1.2),                # 渔网、诗人、帆船，江里到处是鱼
        ("mark", "modern", 1.0),             # 轮船、烟囱、桥
        ("wait", 2.6),
        ("mark", "dam_line", 0.0),           # 一条尺子画的直线截断江面（全卷唯一的直线）
        ("line", "L23", 0.4),
        ("line", "L24", 1.0),
        ("line", "L25", 1.2),
        ("line", "L26", 0.8),
        ("line", "L27", 1.2),                # 鱼一条条淡掉，只剩一条
        ("wait", 3.2),
    ]),
    ("s3_2003", None, None, [
        ("markat", "date_card", 0.0),        # 2003.1.24 宜宾
        ("at", "L28", 1.5),                  # 网收拢
        ("mark", "sky", 0.2),                # 被拖出水：白纸、淡日
        ("line", "L29", 0.6),
        ("line", "H01", 0.9),                # 江边的人
        ("line", "H02", 0.4),
        ("line", "H03", 0.5),                # 八个人抬
        ("line", "L30", 0.8),                # 棉被裹身
        ("line", "L31", 0.9),                # 很暖
        ("mark", "cage_boat", 0.6),          # 网箱船
        ("line", "H04", 1.2),                # 量体长
        ("line", "H05", 1.2),                # 腹中有卵
        ("line", "L32", 1.4),                # 二十四针，红线
        ("mark", "stitch_end", 0.2),
        ("line", "L33", 1.0),                # 背上的信标
        ("mark", "tag_ping_start", -1.2),    # 信标开始嘀嘀响（每 2 秒一声）
        ("line", "H06", 1.2),
        ("mark", "release", 0.4),            # 放流：一笔水线，先下游再折返上游
        ("line", "L34", 0.8),
        ("mark", "night", 0.6),              # 墨色压暗成夜，跟踪船的灯，声呐圈
        ("line", "H07", 1.4),
        ("line", "H08", 1.3),
        ("mark", "crash", 0.35),             # 触礁：墨炸开，嘀声断
        ("line", "H09", 1.3),
        ("wait", 1.6),
        ("line", "L35", 0.0),                # 她在金鸡尾等
        ("line", "L36", 1.3),
        ("wait", 2.8),
    ]),
    ("s4_seven", None, None, [
        ("markat", "tag_close", 0.0),        # 3D：她背上锈掉的信标和褪色的黄飘带
        ("at", "L37", 1.5),
        ("line", "L38", 1.3),
        ("mark", "search_boat", 0.6),        # 电感视觉：头顶一条船放下水听器
        ("line", "L39", 1.0),
        ("line", "L40", 1.0),
        ("line", "L41", 1.0),
        ("mark", "search_leave", 0.2),       # 水听器收回，船走远
        ("wait", 3.6),
    ]),
    ("s5_sturgeon", None, None, [
        ("markat", "far_glow", 0.0),         # 远处一团大的亮光
        ("at", "L42", 3.0),
        ("mark", "rush", 0.2),               # 她冲过去
        ("mark", "reveal", 4.2),             # 浑水里露出一条老鲟
        ("wait", 4.7),
        ("line", "O01", 0.0),
        ("line", "O02", 0.9),
        ("line", "L43", 1.2),
        ("line", "O03", 1.3),
        ("line", "O04", 1.2),
        ("line", "L44", 0.9),
        ("line", "O05", 0.8),
        ("line", "L45", 0.9),
        ("line", "O06", 1.9),
        ("mark", "sturgeon_leave", 0.3),     # 老鲟转身没入浑水
        ("line", "L46", 1.8),
        ("wait", 1.8),
    ]),
    ("s6_yibin", None, None, [
        ("markat", "night_city", 0.0),       # 夜：头顶宜宾城的灯在水面上晃，两江交汇的清浊分界
        ("at", "L47", 4.0),
        ("line", "L48", 1.6),
        ("mark", "wait_night", 0.6),         # 卵石滩上等，头顶灯光由夜到天将亮
        ("wait", 3.0),
        ("line", "L49", 0.0),
        ("line", "L50", 1.8),
        ("wait", 1.8),
        ("mark", "release_eggs", 0.0),       # 产卵：卵像雪一样散开，在电感视觉里一颗颗发亮
        ("line", "L51", 0.9),
        ("mark", "eggs_glow", 0.6),
        ("wait", 5.8),
        ("line", "L52", 0.0),                # 一颗一颗暗下去
        ("mark", "eggs_dark", 1.0),
        ("wait", 5.6),
    ]),
    ("s7_end", None, None, [
        ("markat", "sink", 0.0),             # 她沉到卵石上，身上的光在变弱，天亮了一点
        ("at", "L53", 2.0),
        ("line", "L54", 2.4),
        ("line", "L55", 2.7),
        ("line", "L56", 2.8),
        ("mark", "lights_out", 1.0),         # 电感视觉里的光点一颗颗熄灭，她自己的最后一个
        ("mark", "last_pulse", 8.0),
        ("mark", "black", 9.6),
        ("wait", 12.6),
    ]),
    ("s8_epilogue", None, None, [
        ("markat", "paper_in", 0.0),
        ("markat", "verse_write", 1.5),      # 竖写「有鳣有鲔」
        ("markat", "verse_src", 7.0),        # 《诗经·周颂·潜》
        ("markat", "E1", 9.5),
        ("markat", "E2", 14.5),
        ("markat", "E3", 21.0),
        ("markat", "E4", 27.0),
        ("markat", "E5", 31.5),
        ("markat", "E6", 36.0),
        ("markat", "E7", 42.0),
        ("markat", "E8", 45.5),
        ("markat", "E9", 49.5),
        ("markat", "wei_wash", 55.5),        # 「鲔」被水洗掉，只剩「有鳣有」
        ("markat", "wash_done", 61.0),
        ("markat", "fade_black", 64.0),
        ("markat", "credits", 66.0),
        ("markat", "end", 74.0),
    ]),
]

EPILOGUE = [  # 尾声字卡（无配音）
    ("E1", "1981 年 1 月，葛洲坝截流。白鲟洄游的路被切断。"),
    ("E2", "2003 年 1 月 24 日，一尾长 3.52 米、腹中怀卵的雌性白鲟在宜宾被误捕。|救护人员为她缝合伤口，装上超声波信标，放归长江。"),
    ("E3", "1 月 30 日凌晨，跟踪船触礁，信号消失。|此后八年，科研人员一直在找她。"),
    ("E4", "那是人类最后一次见到白鲟。"),
    ("E5", "研究推断，白鲟在 2005 年至 2010 年间灭绝。"),
    ("E6", "没有人知道，最后一尾死在哪一天。"),
    ("E7", "2020 年 1 月 1 日，长江开始十年禁渔。"),
    ("E8", "她没有等到。"),
    ("E9", "2022 年 7 月 21 日，世界自然保护联盟宣布：白鲟灭绝。"),
]


def build():
    out_lines, marks, scenes = [], [], []
    t_prev_end = 0.0
    for sid, start, end, events in SCENES:
        s0 = start if start is not None else t_prev_end
        cur = s0
        last_end = s0
        for ev in events:
            kind = ev[0]
            if kind == "line":
                _, lid, gap = ev
                t = cur + gap
                d = DUR[lid]
                out_lines.append({"id": lid, "t": round(t, 3), "dur": d, "who": LINES[lid]["who"],
                                  "text": LINES[lid]["text"], "scene": sid})
                cur = t + d
                last_end = max(last_end, cur)
            elif kind == "at":
                _, lid, tt = ev
                t = s0 + tt
                d = DUR[lid]
                out_lines.append({"id": lid, "t": round(t, 3), "dur": d, "who": LINES[lid]["who"],
                                  "text": LINES[lid]["text"], "scene": sid})
                cur = t + d
                last_end = max(last_end, cur)
            elif kind == "mark":
                _, name, gap = ev
                marks.append({"id": f"{sid}.{name}", "t": round(cur + gap, 3)})
            elif kind == "markat":
                _, name, tt = ev
                marks.append({"id": f"{sid}.{name}", "t": round(s0 + tt, 3)})
                last_end = max(last_end, s0 + tt)
            elif kind == "wait":
                cur += ev[1]
                last_end = max(last_end, cur)
        s1 = end if end is not None else round(max(cur, last_end), 3)
        scenes.append({"id": sid, "start": round(s0, 3), "end": round(s1, 3)})
        t_prev_end = s1
    duration = round(scenes[-1]["end"], 3)
    # 检查台词不重叠
    ol = sorted(out_lines, key=lambda x: x["t"])
    for a, b in zip(ol, ol[1:]):
        if a["t"] + a["dur"] > b["t"] - 0.15:
            print(f"WARN overlap {a['id']} ({a['t']}+{a['dur']}) -> {b['id']} ({b['t']})")
    tl = {"fps": FPS, "duration": duration, "aspect": 2.39, "scenes": scenes, "lines": ol,
          "marks": sorted(marks, key=lambda m: m["t"]),
          "epilogue": [{"id": k, "text": v} for k, v in EPILOGUE]}
    (ROOT / "script/timeline.json").write_text(json.dumps(tl, ensure_ascii=False, indent=1))
    # 给前端的台词数据（字幕）
    (ROOT / "src/data").mkdir(parents=True, exist_ok=True)
    (ROOT / "src/data/dialogue.json").write_text(json.dumps({"lines": ol}, ensure_ascii=False, indent=1))
    print(f"duration {duration:.2f}s = {int(duration // 60)}:{duration % 60:05.2f}  frames {round(duration * FPS)}")
    for s in scenes:
        print(f"  {s['id']:12s} {s['start']:7.2f} → {s['end']:7.2f}  ({s['end'] - s['start']:.1f}s)")


if __name__ == "__main__":
    build()
