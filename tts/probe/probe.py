"""试音：候选音色各念一句，量年龄/性别/基频/起伏/CER。用 movie4 的质检环境跑：
/Users/yednc/Dev/movie4/tts/local/envs/qc/bin/python tts/probe/probe.py her|old|fisher [voice ...]
"""
import json, sys, time
from pathlib import Path
import numpy as np, soundfile as sf
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "volc"))
sys.path.insert(0, "/Users/yednc/Dev/movie4/tts/local/scripts")
import volc_tts
import qc_metrics as Q
from common import finalize, OUT_SR

TESTS = {
    "her": ("喂。你们还在听吗？七年了。我知道，你们还在找我。",
            "用很轻、很慢、平静又疲惫的语气，像一个很老的人在深夜的江底自言自语，温柔，不是朗诵。",
            ["zh_female_wenroumama_uranus_bigtts", "zh_female_zhixingnv_uranus_bigtts", "zh_female_gufengshaoyu_uranus_bigtts",
             "zh_female_wenroushunv_uranus_bigtts", "zh_female_sophie_uranus_bigtts", "zh_female_gujie_uranus_bigtts",
             "zh_female_qinqienv_uranus_bigtts", "zh_female_wenrouxiaoya_uranus_bigtts", "zh_female_liuchangnv_uranus_bigtts",
             "zh_female_popo_uranus_bigtts", "zh_female_xiaohe_uranus_bigtts", "zh_female_vv_uranus_bigtts"]),
    "old": ("很多年前。那时候，江里到处都是你们。别往上走了，上面也没有。",
            "用苍老、低沉、缓慢的语气说，像一条活了很久很久的老鱼，话很少，带点沧桑和不忍心。",
            ["zh_male_yuanboxiaoshu_uranus_bigtts", "zh_male_dongfanghaoran_uranus_bigtts", "zh_male_zhuangzhou_uranus_bigtts",
             "zh_male_cixingjieshuonan_uranus_bigtts", "zh_male_shenyeboke_uranus_bigtts", "zh_male_gaolengchenwen_uranus_bigtts",
             "zh_male_m191_uranus_bigtts", "zh_male_ruyayichen_uranus_bigtts", "zh_male_tangseng_uranus_bigtts"]),
    "fisher": ("我的天，好大一条象鱼哦！快去喊渔政的人来！",
               "用四川话说，很激动，在江边大声喊。",
               ["zh_female_vv_uranus_bigtts", "zh_male_m191_uranus_bigtts", "zh_male_dayi_uranus_bigtts",
                "zh_male_liufei_uranus_bigtts", "zh_male_baqiqingshu_uranus_bigtts", "zh_male_huolixiaoge_uranus_bigtts",
                "zh_male_taocheng_uranus_bigtts"]),
}

def main():
    group = sys.argv[1]
    text, ctx, voices = TESTS[group]
    if len(sys.argv) > 2:
        voices = sys.argv[2:]
    out = HERE / group
    out.mkdir(parents=True, exist_ok=True)
    res = {}
    for v in voices:
        t0 = time.time()
        try:
            pcm, sr, info = volc_tts.synth(text, ctx, speaker=v, retries=2)
        except Exception as e:
            print(f"{v}: FAIL {str(e)[:160]}", flush=True)
            res[v] = {"error": str(e)[:300]}
            continue
        y, fin = finalize(pcm.astype(np.float64) / 32768.0, sr)
        sf.write(str(out / f"{v}.wav"), y, OUT_SR, subtype="PCM_24")
        m = Q.analyze(y, OUT_SR, text)
        m.pop("_emb", None)
        m["dur"] = round(len(y) / OUT_SR, 2)
        m["cps"] = round(len(text.replace("，", "").replace("。", "").replace("？", "").replace("！", "")) / m["dur"], 2)
        res[v] = m
        print(f"{v:44s} dur={m['dur']:5.2f} cps={m['cps']:4.2f} f0={m.get('f0_med')} sd={m.get('f0_st_sd')} "
              f"age={m.get('age')} pm={m.get('p_male')} hnr={m.get('hnr')} cer={m['cer']} asr={m['asr']}  ({time.time()-t0:.1f}s)", flush=True)
    (out / "metrics.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))

main()
