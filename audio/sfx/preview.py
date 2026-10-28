"""渲染音效库的试听文件与频谱图：audio/out/sfx_preview/<name>.wav + <name>.png + index.json（自查用，不进成片）。

用法: .venv/bin/python -m audio.sfx.preview [name ...]
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from . import dsp, library, viz

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "audio/out/sfx_preview"


def _stats(a):
    return dict(
        dur=round(a.shape[-1] / dsp.SR, 3),
        peak_dbfs=round(float(dsp.to_db(np.max(np.abs(a)))), 2),
        true_peak_dbtp=round(dsp.true_peak_db(a), 2),
        lufs=round(dsp.integrated_lufs(a), 2) if a.shape[-1] > 0.45 * dsp.SR else None,
        dc=float(np.abs(np.mean(a, axis=-1)).max()),
        start_abs=float(np.max(np.abs(a[:, :4]))),
        end_abs=float(np.max(np.abs(a[:, -4:]))),
    )


def render_one(key, name, params):
    t0 = time.time()
    p = dict(params)
    if library.kind_of(name) == "bed":
        d = p.pop("dur", 20.0)
        r = library.render(name, seed=1, dur=d, **p)
        a = dsp.normalize_lufs(r["audio"], -23.0)
        events, pre = [], 0.0
    else:
        r = library.render(name, seed=1, **p)
        a, events, pre = r["audio"], r["events"], r["pre"]
    pk = np.max(np.abs(a))
    if dsp.to_db(pk) > -1.0:
        a = a * dsp.dbg(-1.0) / pk
    el = time.time() - t0
    sf.write(OUT / f"{key}.wav", a.T, dsp.SR, subtype="PCM_24")
    markers = [pre + e for e in events][:200] if events else [pre]
    viz.spectrogram_png(a, OUT / f"{key}.png", f"{key}", markers=markers)
    st = _stats(a)
    st.update(render_sec=round(el, 2), params=params, recipe=library.RECIPES.get(name, ""), kind=library.kind_of(name),
              sync_pre=round(pre, 4), n_events=len(events), octave_bands={str(k): float(v) for k, v in viz.octave_bands(a).items()})
    return st


def main(names=None):
    OUT.mkdir(parents=True, exist_ok=True)
    jobs = [(name, name, library.PREVIEW.get(name, {})) for name in library.ALL]
    jobs += [(key, name, params) for key, (name, params) in library.VARIANTS.items()]
    if names:
        jobs = [j for j in jobs if j[0] in names or j[1] in names]
    idx_path = OUT / "index.json"
    index = json.loads(idx_path.read_text()) if idx_path.exists() else {}
    for key, name, params in jobs:
        st = render_one(key, name, params)
        index[key] = st
        flag = ""
        if st["kind"] != "bed" and (st["dc"] > 1e-3 or st["start_abs"] > 1e-3 or st["end_abs"] > 1e-3):
            flag = "  <-- CHECK"
        print(f"{key:24s} {st['dur']:6.2f}s pk {st['peak_dbfs']:6.1f} tp {st['true_peak_dbtp']:6.1f} "
              f"L {st['lufs']} ({st['render_sec']}s){flag}", flush=True)
    idx_path.write_text(json.dumps(index, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main(sys.argv[1:] or None)
