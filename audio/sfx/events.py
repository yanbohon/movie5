"""画面事件对位：优先用 audio/visual_events.json（各场景 src/scenes/<id>/events.js 汇总出来的真实画面时刻），
没有就回退到 script/timeline.json 的 marks / lines 推算。每一类用了哪一种都记下来，构建时打印、写进报告。

匹配规则（大小写不敏感，正则搜 "id kind name type label char" 拼起来的字符串），见 cuesheet.py 里每个 T.pick(...) 的 pattern。
画面组命名建议（README 里也写了）：
  s0_cold      片名每一笔 kind='stroke'（可带 dur）；散开 id='title_dissolve'
  s2_scroll    书法每一笔 kind='stroke'（可带 dur、group='baixun'/'xiangyu'/'wei'）；陨石 id 含 'asteroid'，落地 'land|impact'；
               尺子 'dam|ruler'；鱼淡掉 'fish' + 'fade|vanish|gone'；长卷掠过 'rewind'
  s3_2003      每一针 'stitch|needle'（24 个）；信标 'ping|beep'；装信标 'tag' + 'attach|click|clip'；出水 'sky|breach'；
               放流入水 'release|splash'；触礁 'crash'；抬 'lift'；量尺 'measure|ruler|tape'
  s4_seven     水听器入水 'hydrophone' + 'in|enter|drop|splash'，出水 'hydrophone' + 'out|up|leave'
  s5_sturgeon  心跳 'heart|beat'
  s6_yibin     卵熄灭 'egg' + 'dim|dark|out|off|fade'
  s7_end       心跳/最后一下 'pulse|heart'
  s8_epilogue  「有鳣有鲔」每一笔 kind='stroke'；水滴 'drop|drip'
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VE_PATH = ROOT / "audio/visual_events.json"


class Timing:
    def __init__(self, timeline=None, ve_path=VE_PATH):
        self.tl = timeline or json.loads((ROOT / "script/timeline.json").read_text())
        self.marks = {m["id"]: float(m["t"]) for m in self.tl["marks"]}
        self.lines = {l["id"]: l for l in self.tl["lines"]}
        self.scenes = {s["id"]: s for s in self.tl["scenes"]}
        self.duration = float(self.tl["duration"])
        self.ve_path = Path(ve_path)
        self.events = []
        self.ve_info = dict(path=str(self.ve_path.relative_to(ROOT)) if self.ve_path.is_relative_to(ROOT) else str(self.ve_path),
                            exists=self.ve_path.exists(), n=0)
        if self.ve_path.exists():
            try:
                doc = json.loads(self.ve_path.read_text())
                self.events = doc.get("events", doc if isinstance(doc, list) else [])
                self.ve_info.update(n=len(self.events), mtime=self.ve_path.stat().st_mtime)
                if abs(float(doc.get("duration", self.duration)) - self.duration) > 1e-3:
                    self.ve_info["warning"] = "visual_events.json 的 duration 与 timeline 不一致（画面事件可能是旧的，重跑 node tools/collect_events.mjs）"
            except (json.JSONDecodeError, OSError, AttributeError) as e:  # noqa: PERF203
                self.ve_info["error"] = f"读取失败：{e}"
        self.used = []

    # ---------------------------------------------------------------- 基础
    def mark(self, mid):
        return self.marks[mid]

    def line(self, lid):
        return self.lines[lid]

    def line_end(self, lid):
        ln = self.lines[lid]
        return float(ln["t"]) + float(ln["dur"])

    def scene(self, sid):
        return self.scenes[sid]

    @staticmethod
    def _text(e):
        return " ".join(str(e.get(k, "")) for k in ("id", "kind", "name", "type", "label", "char", "group")).lower()

    def find(self, scene, pattern, exclude=None, t0=None, t1=None):
        rx = re.compile(pattern, re.I)
        ex = re.compile(exclude, re.I) if exclude else None
        out = []
        for e in self.events:
            if scene and e.get("scene") != scene:
                continue
            s = self._text(e)
            if not rx.search(s) or (ex and ex.search(s)):
                continue
            t = float(e["t"])
            if (t0 is not None and t < t0) or (t1 is not None and t > t1):
                continue
            out.append(dict(e, t=t))
        out.sort(key=lambda e: e["t"])
        return out

    # ---------------------------------------------------------------- 取时刻（记录来源）
    def pick(self, key, scene, pattern, fallback, exclude=None, t0=None, t1=None, expect=None, limit=None):
        """返回 (事件列表 [{t, ...}], 来源)。fallback() 返回 [{t, ...}]。expect=期望个数（只用于提示）。"""
        evs = self.find(scene, pattern, exclude, t0, t1)
        if evs:
            src = "visual_events"
        else:
            evs = [dict(e) for e in fallback()]
            src = "marks"
        if limit and len(evs) > limit:  # 太多就均匀抽稀（例如"卵一颗颗熄灭"宁可少）
            idx = sorted(set(int(round(i * (len(evs) - 1) / (limit - 1))) for i in range(limit)))
            evs = [evs[i] for i in idx]
        rec = dict(key=key, source=src, n=len(evs), first=round(evs[0]["t"], 3) if evs else None,
                   last=round(evs[-1]["t"], 3) if evs else None)
        if expect is not None and len(evs) != expect:
            rec["note"] = f"期望 {expect} 个，实际 {len(evs)} 个"
        self.used.append(rec)
        return evs, src

    def one(self, key, scene, pattern, fallback_t, exclude=None, t0=None, t1=None):
        evs, src = self.pick(key, scene, pattern, lambda: [dict(t=float(fallback_t))], exclude, t0, t1)
        return float(evs[0]["t"]), src

    def summary(self):
        n_ve = sum(1 for r in self.used if r["source"] == "visual_events")
        return dict(visual_events=self.ve_info, categories=len(self.used), from_visual_events=n_ve,
                    from_marks=len(self.used) - n_ve, table=self.used)

    def print_table(self, log=print):
        s = self.summary()
        vi = s["visual_events"]
        if vi.get("exists"):
            log(f"  画面事件：{vi['path']}（{vi.get('n', 0)} 条）{('  ' + vi['warning']) if vi.get('warning') else ''}")
        else:
            log(f"  画面事件：{vi['path']} 不存在 → 全部按 timeline marks 推算")
        log(f"  对位来源：visual_events {s['from_visual_events']} 类 / marks 推算 {s['from_marks']} 类")
        for r in s["table"]:
            note = f"  ({r['note']})" if r.get("note") else ""
            log(f"    {r['key']:28s} {r['source']:13s} n={r['n']:3d}  {r['first']}–{r['last']}{note}")
