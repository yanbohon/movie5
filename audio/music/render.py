"""《鲔》配乐一键渲染（纯代码合成，无采样）：
    .venv/bin/python audio/music/render.py
输出（audio/out/）：music.wav（整片 485.192 s，48 kHz，24-bit 立体声，真峰值 ≤ -1.5 dBFS，未做母带）、
     stems/music_<分轨>.wav（分轨之和 = music.wav）、music_markers.json、demo_guqin.wav、
     music_qa/（响度曲线、频谱图、qa_report.json）。
调试参数：--cache <dir> 保留原始分轨；--from-cache 跳过合成直接重新混音；--no-qa；--no-demo。
"""
import argparse
import json
import math
import os
import pickle
import resource
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import soundfile as sf
from mus_dsp import SR
from mus_core import Ctx, STEMS, N, ROOT, DUR
import mus_score as SC
import mus_mix as MX
import mus_qa as QA

LOUD_TARGET = -14.0      # 全片最响的 3 s 短期响度（LUFS），受真峰值约束
TP_TARGET = -1.6         # 真峰值目标（dBFS），交付要求 ≤ -1.5
LIMIT_CEIL_DBFS = -2.2   # 联动限幅的采样峰值上限


def rss():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9   # macOS：字节


def mem_free_pct():
    try:
        out = subprocess.run(['memory_pressure'], capture_output=True, text=True, timeout=30).stdout
        line = [l for l in out.splitlines() if 'free percentage' in l][-1]
        return int(line.split(':')[-1].strip().rstrip('%'))
    except Exception:
        return 100


def wait_memory(log):
    for _ in range(60):
        p = mem_free_pct()
        if p >= 25:
            log(f'memory free {p}%')
            return
        log(f'memory free {p}% < 25%, waiting 20 s ...')
        time.sleep(20)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'audio', 'out'))
    ap.add_argument('--cache', default='')
    ap.add_argument('--from-cache', action='store_true')
    ap.add_argument('--no-qa', action='store_true')
    ap.add_argument('--no-demo', action='store_true')
    ap.add_argument('--stage', default='all', help=argparse.SUPPRESS)
    args = ap.parse_args()
    T0 = time.time()

    def log(msg):
        print(f'[{time.time() - T0:6.1f}s] {msg}', flush=True)

    keep_cache = bool(args.cache)
    cache = args.cache or tempfile.mkdtemp(prefix='wei_music_')
    os.makedirs(cache, exist_ok=True)
    raw = lambda s: os.path.join(cache, f'{s}.npy')

    if args.stage == 'compose':
        # 子进程：作曲 + 合成 + 逐分轨渲染原始分轨（含混响、硬切、对白让路），写到 cache 后退出，内存随进程释放
        ctx = Ctx()
        for fn in SC.SECTIONS:
            t0 = time.time()
            fn(ctx)
            log(f'composed {fn.__name__} ({time.time() - t0:.1f}s)')
        tb = sum(t.nbytes() for t in ctx.tracks.values()) / 1e9
        log(f'composed all: track chunks {tb:.2f} GB, peak RSS {rss():.2f} GB')
        ctx.render_stream(lambda s, x: np.save(raw(s), x), dialog_trim=MX.DIALOG_TRIM)
        with open(os.path.join(cache, 'markers.pkl'), 'wb') as f:
            pickle.dump(ctx.markers, f)
        log(f'raw stems rendered, compose-stage peak RSS {rss():.2f} GB')
        with open(os.path.join(cache, 'compose_stats.json'), 'w') as f:
            json.dump({'peak_rss_gb': round(rss(), 2), 'seconds': round(time.time() - T0, 1)}, f)
        return

    wait_memory(log)
    ctx = Ctx()
    if not args.from_cache:
        cmd = [sys.executable, os.path.abspath(__file__), '--stage', 'compose', '--cache', cache]
        r = subprocess.run(cmd)
        if r.returncode != 0:
            raise SystemExit('compose stage failed')
    with open(os.path.join(cache, 'markers.pkl'), 'rb') as f:
        ctx.markers = pickle.load(f)
    comp = json.load(open(os.path.join(cache, 'compose_stats.json'))) if os.path.exists(
        os.path.join(cache, 'compose_stats.json')) else {}
    log(f'raw stems ready in {cache}')

    def mixed_stem(s, g=1.0, gcurve=None):
        x = np.load(raw(s))
        x *= np.float32(10 ** (MX.STEM_GAIN_DB.get(s, 0.0) / 20.0) * g)
        if gcurve is not None:
            x *= gcurve
        return x

    # 第 1 遍：响度归一（全片最响的 3 s 短期响度 -> LOUD_TARGET）
    mix = np.zeros((2, N), dtype=np.float32)
    for s in STEMS:
        mix += mixed_stem(s)
    st = [v for _, v in QA.curve_lufs(QA.k_blocks(mix), 0.0, DUR, 3.0, 0.25) if np.isfinite(v)]
    g1 = 10 ** ((LOUD_TARGET - max(st)) / 20.0)
    log(f'loudest short-term {max(st):.1f} LUFS -> gain {20 * math.log10(g1):+.2f} dB')
    # 第 2 遍：由总混求联动限幅曲线，再按真峰值补一个增益
    mix *= np.float32(g1)
    gcurve, gr = MX.linked_gain(mix, 10 ** (LIMIT_CEIL_DBFS / 20.0))
    log(f'linked limiter: max gain reduction {gr:.2f} dB, {np.mean(gcurve < 0.999) * 100:.3f}% of samples touched')
    mix *= gcurve
    tp = QA.true_peak_db(mix)
    g2 = min(1.0, 10 ** ((TP_TARGET - tp) / 20.0))
    log(f'true peak {tp:.2f} dBFS -> extra gain {20 * math.log10(g2):+.2f} dB')
    # 第 3 遍：写分轨与总混（总混 = 分轨之和），同时做分轨质检
    os.makedirs(os.path.join(args.out, 'stems'), exist_ok=True)
    qadir = os.path.join(args.out, 'music_qa')
    os.makedirs(qadir, exist_ok=True)
    mix[:] = 0
    stem_stats = {}
    hit_checks = []
    qin_times = [h['t'] for h in ctx.markers['hits'] if h.get('stem') == 'guqin']
    glass_times = ctx.markers.get('glass_times', [])
    clicks = {}
    for s in STEMS:
        x = mixed_stem(s, g1 * g2, gcurve)
        MX.end_silence(x, DUR - 4.2, DUR - 0.25)
        sf.write(os.path.join(args.out, 'stems', f'music_{s}.wav'), x.T, SR, subtype='PCM_24')
        ss = sum(float(np.sum(np.square(x[:, a:a + SR * 10], dtype=np.float64))) for a in range(0, N, SR * 10))
        stem_stats[s] = {'peak_dbfs': round(20 * math.log10(float(np.max(np.abs(x))) + 1e-12), 2),
                         'rms_dbfs': round(10 * math.log10(ss / x.size + 1e-24), 1),
                         'dc': [float('%.2g' % float(np.mean(x[0]))), float('%.2g' % float(np.mean(x[1])))]}
        if not args.no_qa:
            others = [h['t'] for h in ctx.markers['hits'] if h.get('stem') == s]
            if s == 'glass':
                others = others + list(glass_times)
            for h in ctx.markers['hits']:
                if h.get('stem') == s and h.get('check', True):
                    # 撮 / 和弦的第二根弦（前 20 ms 内已有同分轨的卡点）：属于同一个动作，只量第一根
                    if any(0 < h['t'] - o < 0.02 for o in others):
                        continue
                    off, rise, band = QA.onset_near(x, h['t'], others)
                    hit_checks.append({'t': h['t'], 'what': h['what'], 'stem': s,
                                       'onset_error_ms': None if off is None else round(off * 1000, 2),
                                       'onset_rise_db': round(rise, 1), 'band': band})
            ex = qin_times if s == 'guqin' else (glass_times if s == 'glass' else [])
            clicks[s] = {'hf_transients': QA.click_scan(x, ex)[:50], 'sample_jumps': QA.jump_scan(x, ex)[:50]}
        mix += x
        del x
    assert mix.shape[1] == N
    sf.write(os.path.join(args.out, 'music.wav'), mix.T, SR, subtype='PCM_24')
    tp2 = QA.true_peak_db(mix)
    log(f'wrote music.wav ({N / SR:.3f} s), true peak {tp2:.2f} dBFS, sample peak '
        f'{20 * math.log10(np.max(np.abs(mix))):.2f} dBFS, peak RSS {rss():.2f} GB')

    # ---------------- 标记
    cut_meas = [QA.cut_check(mix, c['t']) for c in ctx.markers['cuts']]
    for c, m in zip(ctx.markers['cuts'], cut_meas):
        c['measured'] = m
    markers = {
        'film': '鲔', 'duration_s': DUR, 'sample_rate': SR,
        'note': '所有时间为全片绝对秒，全部由 script/timeline.json 的 marks / lines 推出。themes 为主题三次完整出现与临终只弹前 4 个音；'
                'cuts 为两个硬切（含实测）；fades 为 last_pulse 前把余响收净的慢收（不是硬切）；hits 为每个放置的音乐卡点（古琴每一个拨弦/泛音都在内）。',
        'mode': 'D 羽调式五声（D F G A C，E/Bb 经过），三分损益律，A4 = 440 Hz（与 1760 Hz 信标严格协和）',
        'theme_motif': 'D3 A3 G3 F3 | D3（第 5 个音回到主音）',
        'themes': ctx.markers['themes'], 'cuts': ctx.markers['cuts'], 'fades': ctx.markers['fades'],
        'sections': ctx.markers['sections'],
        'hits': sorted(ctx.markers['hits'], key=lambda d: d['t']),
        'true_peak_dbfs': round(tp2, 2), 'gain_applied_db': round(20 * math.log10(g1 * g2), 2),
        'limiter_max_gain_reduction_db': round(gr, 2),
    }
    with open(os.path.join(args.out, 'music_markers.json'), 'w') as f:
        json.dump(markers, f, ensure_ascii=False, indent=1)
    log('wrote music_markers.json')

    del gcurve
    # ---------------- 质检
    if not args.no_qa:
        cum = QA.k_blocks(mix)
        scenes = [(s_['id'], float(s_['start']), float(s_['end'])) for s_ in ctx.tl['scenes']]
        rep = {'duration_s': round(mix.shape[1] / SR, 4), 'samples': int(mix.shape[1]), 'sample_rate': SR,
               'true_peak_dbfs': round(tp2, 2),
               'sample_peak_dbfs': round(20 * math.log10(float(np.max(np.abs(mix)))), 2),
               'clipped_samples': int(np.sum(np.abs(mix) >= 0.999)),
               'dc_offset': [float('%.2g' % float(np.mean(mix[0]))), float('%.2g' % float(np.mean(mix[1])))],
               'film_integrated_lufs': round(QA.integrated_lufs(cum, 0, DUR), 1),
               'loudest_short_term_lufs': round(max(v for _, v in QA.curve_lufs(cum, 0, DUR, 3.0, 0.25) if np.isfinite(v)), 1),
               'stems': stem_stats, 'cuts': cut_meas, 'hits': hit_checks, 'clicks': clicks}
        errs = np.array([abs(h['onset_error_ms']) for h in hit_checks if h['onset_error_ms'] is not None])
        rep['hits_summary'] = {
            'checked': len(hit_checks), 'measured': int(errs.size),
            'masked_by_ringing_sound(rise<8dB)': [f"{h['t']:.3f} {h['what']}" for h in hit_checks if h['onset_error_ms'] is None],
            'abs_error_ms_median': round(float(np.median(errs)), 2) if errs.size else None,
            'abs_error_ms_p95': round(float(np.percentile(errs, 95)), 2) if errs.size else None,
            'abs_error_ms_max': round(float(np.max(errs)), 2) if errs.size else None,
            'worst': sorted([h for h in hit_checks if h['onset_error_ms'] is not None],
                            key=lambda h: -abs(h['onset_error_ms']))[:8]}
        rep['scenes'] = []
        for sid, a, b in scenes:
            vals = [v for _, v in QA.curve_lufs(cum, a, b, 3.0, 0.5) if np.isfinite(v)]
            rep['scenes'].append({'id': sid, 'start': a, 'end': b,
                                  'integrated_lufs': round(QA.integrated_lufs(cum, a, b), 1),
                                  'short_term_max': round(max(vals), 1) if vals else None,
                                  'short_term_median': round(float(np.median(vals)), 1) if vals else None,
                                  'peak_dbfs': round(QA.peak_db(mix, a, b), 1)})
        # 卡点前后的短时响度变化（0.4 s 窗，前 1 s 平均 vs 后 1 s 最大）
        rep['cue_loudness'] = []
        key = [(t['start'], f"主题-{t['which']}") for t in ctx.markers['themes']] + \
              [(c['t'], 'cut') for c in ctx.markers['cuts']]
        for nm_ in ('s1_river.electro_reveal', 's2_scroll.asteroid', 's2_scroll.wei_write', 's3_2003.sky',
                    's3_2003.release', 's5_sturgeon.reveal', 's6_yibin.eggs_glow', 's7_end.lights_out',
                    's7_end.last_pulse', 's7_end.black', 's8_epilogue.credits', 's1_river.ship_pass', 's1_river.rumble_start'):
            key.append((ctx.M(nm_), nm_))
        for (t, lab) in sorted(key):
            pre = QA._win_lufs(cum, int((t - 1.2) * SR), int((t - 0.1) * SR))
            post = max(QA._win_lufs(cum, int((t + a) * SR), int((t + a + 0.4) * SR)) for a in np.arange(0.0, 1.0, 0.1))
            rep['cue_loudness'].append({'t': round(t, 3), 'cue': lab, 'pre_1s_lufs': round(pre, 1) if np.isfinite(pre) else None,
                                        'post_max_0.4s_lufs': round(post, 1) if np.isfinite(post) else None})
        rep['silence'] = {
            'last_0.3s_peak_dbfs': round(QA.peak_db(mix, DUR - 0.3, DUR), 1),
            'at_black_peak_dbfs(black..black+0.5)': round(QA.peak_db(mix, ctx.M('s7_end.black'), ctx.M('s7_end.black') + 0.5), 1),
            'at_last_pulse_rms_dbfs': round(QA.level_db(mix, ctx.M('s7_end.last_pulse'), ctx.M('s7_end.last_pulse') + 0.3), 1),
            'last_pulse_to_black_peak_dbfs': round(QA.peak_db(mix, ctx.M('s7_end.last_pulse') - 0.05, ctx.M('s7_end.black') + 0.5), 1),
        }
        rep['duplicate_blocks'] = QA.dup_blocks(mix)[:20]
        gper = {}
        for a, b, lab in ((ctx.M('electro_reveal') + 1.5, ctx.M('rumble_start'), 's1 电感视觉'),
                          (ctx.M('far_glow'), ctx.M('reveal'), 's5 光团'),
                          (ctx.M('eggs_glow'), ctx.M('eggs_dark'), 's6 卵光')):
            gper[lab] = QA.onset_periodicity(glass_times, a, b)
        rep['glass_onset_periodicity_max_autocorr'] = gper
        # 对白：每句真正发声期间 vs 句前 1 s，音乐在 200 Hz–4 kHz 的 RMS
        band = QA.sos_filter(np.mean(mix, axis=0, dtype=np.float32), 'bandpass', [200, 4000], 2).astype(np.float32)
        dia = []
        for lid, v in ctx.voice.items():
            a, b = v['on'], v['off']
            s_ = band[int(a * SR):int(b * SR)]
            g_ = band[int(max(0, a - 1.2) * SR):int(max(0, a - 0.2) * SR)]
            onsets_in = [h['t'] for h in markers['hits'] if h.get('stem') == 'guqin' and ctx.in_line(h['t'], 0.05) == lid]
            in_gap = [t_ for t_ in onsets_in if any(ga - 0.01 <= t_ <= gb for ga, gb in v.get('gaps', []))]
            dia.append({'line': lid, 'on': round(a, 3), 'off': round(b, 3),
                        'music_band_rms_db': round(20 * math.log10(np.sqrt(np.mean(s_ ** 2)) + 1e-9), 1),
                        'pre_gap_band_rms_db': round(20 * math.log10(np.sqrt(np.mean(g_ ** 2)) + 1e-9), 1) if g_.size else None,
                        'qin_onsets_in_breath_gaps': in_gap,
                        'qin_onsets_while_voiced': [t_ for t_ in onsets_in if t_ not in in_gap]})
        rep['dialog'] = dia
        rep['dialog_summary'] = {
            'lines': len(dia),
            'qin_onsets_while_voiced': sum(len(x['qin_onsets_while_voiced']) for x in dia),
            'qin_onsets_in_breath_gaps': sum(len(x['qin_onsets_in_breath_gaps']) for x in dia),
            'music_200_4k_during_speech_minus_before_db_median': round(float(np.median(
                [x['music_band_rms_db'] - x['pre_gap_band_rms_db'] for x in dia
                 if x['pre_gap_band_rms_db'] is not None and x['pre_gap_band_rms_db'] > -100])), 1)}
        del band
        lines = [(lid, v['on'], v['off']) for lid, v in ctx.voice.items()]
        themes = []
        for th in ctx.markers['themes']:
            for i, nt in enumerate(th['notes']):
                themes.append((nt['t'], f"{th['which']}{i + 1}"))
        cuts = [c['t'] for c in ctx.markers['cuts']]
        marks = [(v, k.split('.')[-1]) for k, v in ctx.marks.items()]
        QA.loudness_png(cum, DUR, os.path.join(qadir, 'loudness.png'), scenes,
                        [(th['start'], th['which']) for th in ctx.markers['themes']], cuts, lines)
        QA.spectrogram_png(mix, 0, DUR, os.path.join(qadir, 'spec_full.png'), 'music.wav 全片', lines, [], themes, cuts,
                           nper=4096, drange=100)
        for sid, a, b in scenes:
            QA.spectrogram_png(mix, max(0, a - 1), min(DUR, b + 1), os.path.join(qadir, f'spec_{sid}.png'),
                               f'{sid}  {a:.1f}–{b:.1f} s', lines, marks, themes, cuts, nper=8192)
        log('QA plots written')
        if not args.no_demo:
            import mus_demo
            info = mus_demo.render_demo(os.path.join(args.out, 'demo_guqin.wav'), os.path.join(qadir, 'demo_guqin_spec.png'),
                                        os.path.join(qadir, 'demo_guqin_zoom.png'))
            rep['guqin_demo'] = info
            rep['guqin_model_check'] = mus_demo.analyze()
            log('guqin demo + model check done')
        rep['render_seconds'] = round(time.time() - T0, 1)
        rep['peak_rss_gb'] = {'compose_stage': comp.get('peak_rss_gb'), 'mix_qa_stage': round(rss(), 2)}
        with open(os.path.join(qadir, 'qa_report.json'), 'w') as f:
            json.dump(rep, f, ensure_ascii=False, indent=1)
        log('wrote music_qa/qa_report.json')
    del mix
    if not keep_cache:
        for s in STEMS:
            if os.path.exists(raw(s)):
                os.remove(raw(s))
        for fn_ in ('markers.pkl', 'compose_stats.json'):
            if os.path.exists(os.path.join(cache, fn_)):
                os.remove(os.path.join(cache, fn_))
        os.rmdir(cache)
    log(f'done: compose-stage peak RSS {comp.get("peak_rss_gb")} GB, mix/QA-stage peak RSS {rss():.2f} GB')


if __name__ == '__main__':
    main()
