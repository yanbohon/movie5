"""豆包 2.0 生成全部台词 + 质检（错字率 / 性别 / 最长内部静音）。
用 movie4 的质检环境跑：/Users/yednc/Dev/movie4/tts/local/envs/qc/bin/python tts/volc/gen.py [--ids L01 L02] [--force] [--voice-override OLD=zh_male_x]
输出 tts/volc/wav/<id>.wav（48k 24bit 单声道，已去首尾静音）、tts/volc/qa.json、tts/volc/durations.json
"""
import argparse, json, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np, soundfile as sf

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, "/Users/yednc/Dev/movie4/tts/local/scripts")
import volc_tts
from common import finalize, OUT_SR, longest_internal_silence

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", nargs="*")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--voice-override", nargs="*", default=[])
    ap.add_argument("--out", default="wav")
    ap.add_argument("--take", default="t0")
    args = ap.parse_args()
    S = json.loads((ROOT / "script/lines.json").read_text())
    cast = S["cast"]
    for ov in args.voice_override:
        k, v = ov.split("=")
        cast[k]["voice"] = v
    out = HERE / args.out
    out.mkdir(exist_ok=True)
    raw = HERE / "raw"
    todo = [ln for ln in S["lines"] if (not args.ids or ln["id"] in args.ids) and (args.force or not (out / f"{ln['id']}.wav").exists())]
    print(f"{len(todo)} lines to synth", flush=True)

    def job(ln):
        c = cast[ln["who"]]
        ctx = f"用{ln['dir']}的语气说这句话。{c['persona']}"
        for k in range(3):
            try:
                pcm, sr, info = volc_tts.synth(ln["tts"], ctx, speech_rate=c.get("rate", 0), speaker=c["voice"])
                rp = raw / ln["id"] / f"{args.take}_{c['voice'].split('_')[2]}.wav"
                rp.parent.mkdir(parents=True, exist_ok=True)
                sf.write(str(rp), pcm, sr, subtype="PCM_16")
                return ln, pcm, sr, ctx
            except Exception as e:
                print(ln["id"], "retry", e, flush=True)
                time.sleep(2)
        raise RuntimeError(ln["id"])

    with ThreadPoolExecutor(4) as ex:
        results = list(ex.map(job, todo))

    import qc_metrics as Q
    qa_path = HERE / f"qa_{args.out}.json"
    qa = json.loads(qa_path.read_text()) if qa_path.exists() else {}
    for ln, pcm, sr, ctx in results:
        y, fin = finalize(pcm.astype(np.float64) / 32768.0, sr)
        sf.write(str(out / f"{ln['id']}.wav"), y, OUT_SR, subtype="PCM_24")
        m = Q.analyze(y, OUT_SR, ln["tts"])
        m.pop("_emb", None)
        m["dur"] = round(len(y) / OUT_SR, 3)
        m["sil"] = round(longest_internal_silence(y, OUT_SR), 2)
        m.update(voice=cast[ln["who"]]["voice"], who=ln["who"], text=ln["text"], ctx=ctx)
        qa[ln["id"]] = m
        flag = []
        if m["cer"] > 0.08: flag.append("CER")
        if ln["who"] in ("HER", "F2") and (m.get("p_male") or 0) > 0.5: flag.append("GENDER")
        if ln["who"] not in ("HER", "F2") and (m.get("p_male") or 1) < 0.5: flag.append("GENDER")
        if m["sil"] > 1.2: flag.append("SIL")
        m["flags"] = flag
        print(f"{ln['id']} {ln['who']:4s} {m['dur']:5.2f}s f0={m.get('f0_med')} sd={m.get('f0_st_sd')} age={m.get('age')} "
              f"sil={m['sil']} cer={m['cer']} {'!!'+','.join(flag) if flag else ''} | {m['asr']}", flush=True)
    qa_path.write_text(json.dumps(qa, ensure_ascii=False, indent=1))
    dur = {k: v["dur"] for k, v in qa.items()}
    (HERE / f"durations_{args.out}.json").write_text(json.dumps(dur, ensure_ascii=False, indent=1))

main()
