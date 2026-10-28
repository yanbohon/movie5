"""《鲔》谱面。所有时间都从 script/timeline.json 取（ctx.M 卡点、ctx.L / ctx.on / ctx.off / ctx.gap 台词），
不写死秒数：配音或剪辑一改，重跑即可。

主题动机（mus_theme.THEME）：D3 A3 G3 F3 | D3。古琴指法（正调 C2 D2 F2 G2 A2 C3 D3）：
    D3 = 七弦散音；A3 = 五弦七徽按音（绰入 + 吟）；G3 = 五弦走手下滑到七徽九分再弹；
    F3 = 三弦七徽按音（注入 + 吟）；D3 = 二弦 + 七弦散音「撮」（D2 + D3 八度）。
完整出现 3 次：片名（独奏）、长卷 L22（加低弦平行五度）、产卵（古琴 + 弦乐三和弦 + 远处哼唱 + 琥珀色玻璃光）。
她死去时只弹前 4 个音（更轻、更慢），第 5 个音永远不来。
"""
import math
import numpy as np
from mus_dsp import SR, rng, reverse_swell, convolve_clip
from mus_theme import nm, nms, hz
from mus_guqin import QinPhrase
import mus_inst as I


# ======================================================================= 放置小工具
def strings(ctx, t, notes, dur, vel, att=2.0, rel=2.5, bus='hall', seed=None, **kw):
    ctx.add('strings', bus, t, I.strings_chord(nms(*notes) if isinstance(notes, (list, tuple)) else nms(notes),
                                               dur, vel=vel, att=att, rel=rel,
                                               seed=seed if seed is not None else int(t * 10), **kw))


def cello(ctx, t, note, dur, vel, sec='vcsolo', att=0.8, rel=1.2, glide_from=None, bus='hall', **kw):
    ctx.add('strings', bus, t, I.strings(nm(note), dur, vel=vel, att=att, rel=rel, sec=sec,
                                         seed=int(t * 100) + nm(note), glide_from=glide_from, **kw))


def cello_line(ctx, events, vel, sec='vcsolo', att=0.45, rel=1.0, overlap=0.35, bus='hall', **kw):
    """连奏线条：events = [(t, 音名), ...] + 结束时刻 events[-1] = (t_end, None)。相邻音交叠并滑入。"""
    prev = None
    for i in range(len(events) - 1):
        t, n_ = events[i]
        t_next = events[i + 1][0]
        v = vel[i] if isinstance(vel, (list, tuple)) else vel
        cello(ctx, t, n_, t_next - t + overlap, v, sec=sec, att=att if i else max(att, 1.2), rel=rel,
              glide_from=prev, bus=bus, **kw)
        prev = n_


def hum(ctx, t, notes, dur, vel, bus='far', **kw):
    ctx.add('hum', bus, t, I.hum(nms(*notes) if isinstance(notes, (list, tuple)) else nms(notes), dur, vel=vel,
                                 seed=kw.pop('seed', int(t * 10)), **kw))


def pad(ctx, t, notes, dur, vel, bus='hall', kind='air', **kw):
    fn = I.air_pad if kind == 'air' else I.warm_pad
    ctx.add('pad', bus, t, fn(nms(*notes) if isinstance(notes, (list, tuple)) else nms(notes), dur, vel=vel,
                              seed=kw.pop('seed', int(t * 10)), **kw))


def sub(ctx, t, note, dur, vel, **kw):
    ctx.add('sub', 'dry', t, I.sub_tone(nm(note), dur, vel=vel, **kw))


GLASS_POOL = nms('D6 F6 G6 A6 C7 D7 F7 G7 A7 C8')
EGG_POOL = nms('D5 F5 G5 A5 C6 D6 F6 A6')


def sparkles(ctx, t0, t1, rate, seed, vel=(0.02, 0.09), dur=(0.15, 0.8), pool=GLASS_POOL, warm=0.0,
             bus='shimmer', stop_at=None, vel_fn=None):
    """电感视觉的玻璃泛音粒子：非齐次泊松时间 + 随机音高（五声音阶高音区，±12 音分微偏）+ 随机长短强弱 + 随机声像。
    不规律、不重复：没有「ping 铺底」。stop_at：此刻之前的粒子到这里被收掉（切回真实视角）。"""
    r = rng(seed)
    times = I.sparkle_times(t0, t1, rate, seed)
    for k, t in enumerate(times):
        m = int(r.choice(pool))
        f = hz(m) * 2 ** (r.uniform(-12, 12) / 1200.0)
        v = math.exp(r.uniform(math.log(vel[0]), math.log(vel[1])))
        if vel_fn is not None:
            v *= vel_fn(t)
        d = math.exp(r.uniform(math.log(dur[0]), math.log(dur[1])))
        g = I.glass_grain(f, d, v, seed=seed * 1000 + k, warm=warm)
        if stop_at is not None:
            n_keep = int((stop_at - t) * SR)
            if n_keep <= 0:
                continue
            if n_keep < g.shape[1]:
                fo = min(n_keep, int(0.06 * SR))
                g = g[:, :n_keep].copy()
                g[:, -fo:] *= np.linspace(1, 0, fo)
        ctx.add('glass', bus, t, g)
        ctx.markers.setdefault('glass_times', []).append(t)
    return len(times)


# ======================================================================= S0 冷开场
def s0(ctx):
    T = ctx.M('s0_cold.title_write')
    H = ctx.M('s0_cold.title_hold')
    Dz = ctx.M('s0_cold.title_dissolve')
    c_in = ctx.M('s0_cold.card_in')
    ctx.section('s0', 0.0, ctx.S('s1_river')[0], '前 20 秒只有极低的 sub 呼吸；片名古琴独奏主题；字散开时泛音散开')
    # sub：D1 的呼吸（三口气），片名前 0.3 s 收完，让古琴独奏
    t_s = c_in - 0.6
    rel = 1.6
    dur = (T - 0.3) - t_s - rel
    sub(ctx, t_s, 'D1', dur, 0.05, att=4.5, rel=rel, h2=0.18, breath=(6.3, 0.75))
    ctx.hit(t_s, 'sub 呼吸起（D1，约 6.3 s 一口气）', 'sub', check=False)

    # ---- 片名：主题第一次（古琴独奏，一笔一音）
    q = QinPhrase(seed=100)
    n1, n2, n3, n4, n5 = T, T + 1.05, T + 2.02, T + 2.98, H
    q.note(n1, 7, None, 0.60, 'flesh', label='主题①-1 D3（七弦散音，勾）')
    q.note(n2, 5, 'A3', 0.56, 'nail', approach=('chuo', 110, 0.20), orn=[('yin', 0.40, 1.6, 13, 4.4)],
           label='主题①-2 A3（五弦七徽，挑，绰入 + 吟）')
    q.note(n3, 5, 'G3', 0.50, 'flesh', approach=('slide', n3 - 0.30), orn=[('yin', 0.35, 1.1, 9, 4.8)],
           label='主题①-3 G3（走手下滑到七徽九分再勾）')
    q.note(n4, 3, 'F3', 0.52, 'flesh', approach=('zhu', 95, 0.22), orn=[('yin', 0.45, 1.2, 11, 4.2)],
           label='主题①-4 F3（三弦七徽，注入 + 吟）')
    q.cuo(n5, [(2, None), (7, None)], 0.60, label='主题①-5 D2+D3（撮，回到主音）')
    # 28.2 字散成颗粒：泛音散开（徽位不同、越来越轻、越来越高）
    hs = [(0.00, 7, 4, 0.42), (0.33, 7, 5, 0.36), (0.61, 4, 4, 0.33), (0.98, 3, 2, 0.29), (1.30, 7, 2, 0.26),
          (1.76, 2, 1, 0.23), (2.32, 6, 2, 0.19)]
    for (dt, s, hui, v) in hs:
        q.harm(Dz + dt, s, hui, v, label=f'片名散开泛音 {s} 弦 {hui} 徽')
    ctx.qin(q, bus='far', tail=12.0, gain=0.8)      # 独奏要亲近、不要大：比产卵那次的全编制低 4 dB 左右
    ctx.theme('title', [(n1, 'D3'), (n2, 'A3'), (n3, 'G3'), (n4, 'F3'), (n5, 'D2+D3')],
              '片名：古琴独奏，一笔一音；第 5 个音落在 title_hold（字写完）')
    ctx.hit(Dz, '泛音散开（字散成颗粒）', 'guqin')
    # 光的颗粒：极轻的玻璃粒子随字一起散开
    sparkles(ctx, Dz + 0.05, Dz + 3.2, lambda t: 7.0 * max(0.0, 1 - (t - Dz) / 3.2), seed=11,
             vel=(0.012, 0.045), dur=(0.2, 0.9))


# ======================================================================= S1 看不见的江
def s1(ctx):
    t0 = ctx.M('s1_river.fade_in')
    bp_ = ctx.M('s1_river.body_pass')
    er = ctx.M('s1_river.electro_reveal')
    rs = ctx.M('s1_river.rumble_start')
    sp = ctx.M('s1_river.ship_pass')
    pk = ctx.M('s1_river.ship_peak')
    sg = ctx.M('s1_river.ship_gone')
    ctx.section('s1', t0, ctx.S('s2_scroll')[0], '江底低弦长音 + 远处哼唱；电感视觉玻璃泛音；船来时音乐让位，只留 sub')
    # 低弦：D2 + A2 长音，身体滑过时轻轻涌起；轰鸣开始后 3 s 内退场
    end = rs + 1.2
    n = int((end - t0 + 3.0) * SR)
    tt = t0 + np.arange(n) / SR
    ex = 1.0 + 0.45 * np.exp(-((tt - (bp_ + 1.0)) / 1.2) ** 2) + 0.15 * np.clip((tt - er) / 3, 0, 1)
    strings(ctx, t0, ['D2', 'A2'], end - t0, 0.08, att=5.0, rel=3.0, expr=ex, seed=310)
    # 身体经过时大提琴加一个 F3，给「星星」段一点温度，L09 之前收掉
    l09 = ctx.on('L09')
    strings(ctx, bp_ - 0.3, ['F3'], l09 - 1.0 - bp_, 0.05, att=3.0, rel=3.5, seed=311)
    # 远处哼唱：D3 + A3，电感视觉时略张口（更亮一点），轰鸣起即退
    n2 = int((rs - (t0 + 2.0) + 3.0) * SR)
    tt2 = (t0 + 2.0) + np.arange(n2) / SR
    om = np.clip((tt2 - er) / 4.0, 0, 1) * 0.5
    hum(ctx, t0 + 2.0, ['D3', 'A3'], rs - (t0 + 2.0), 0.065, att=6.0, rel=2.5, open_mix=om, seed=312)
    # 电感视觉：49.8 一圈波荡开 —— 玻璃泛音「绽开」：1.4 s 内几十粒由低到高喷开，再加三根长的玻璃音
    r = rng(313)
    nb = 46
    for k in range(nb):
        u = k / (nb - 1)
        tb = er + 1.4 * u ** 1.3 + r.uniform(-0.02, 0.02)
        f = 700.0 * (7.0 ** u) * 2 ** (r.uniform(-60, 60) / 1200.0)
        v = 0.072 * (0.35 + 0.65 * math.sin(math.pi * min(1.0, u * 1.25))) * r.uniform(0.6, 1.0)
        ctx.add('glass', 'shimmer', tb, I.glass_grain(f, r.uniform(0.3, 1.1), v, seed=3130 + k))
        ctx.markers.setdefault('glass_times', []).append(tb)
    for (dt, m, v) in ((0.05, 'D6', 0.05), (0.35, 'A6', 0.04), (0.8, 'D7', 0.03)):
        ctx.add('glass', 'shimmer', er + dt, I.glass_grain(hz(nm(m)), 2.6, v, seed=3200 + nm(m), att=0.03))
    ctx.hit(er, '电感视觉：玻璃泛音绽开', 'glass')
    # 满江「星星」：随 L08 镜头拉远变密，找另一颗时变稀，轰鸣开始后熄掉
    l08 = ctx.on('L08')
    l08e = ctx.off('L08')

    def rate(t):
        if t < l08:
            return 4.5
        if t < l08e:
            return 4.5 + 3.0 * math.sin(math.pi * (t - l08) / (l08e - l08))
        if t < l09:
            return 4.0
        if t < rs:
            return 2.2
        return 2.2 * max(0.0, 1 - (t - rs) / 1.8)
    sparkles(ctx, er + 1.2, rs + 1.8, rate, seed=314, vel=(0.012, 0.055))
    # 「这些年，我一直在找另外一颗」之后：一个孤单的古琴泛音（A4，七弦五徽）
    ta = ctx.off('L09') + 0.18
    q = QinPhrase(seed=120)
    q.harm(ta, 7, 5, 0.30, label='找另一颗：A4 泛音')
    ctx.qin(q, bus='far', tail=8.0)
    # 船：sub 跟着船压下来（音高随船头顶经过略降，最响在 ship_peak），ship_gone 前走远
    t_s = sp - 0.6
    dur = sg - t_s - 1.0
    n3 = int((dur + 2.5) * SR)
    tt3 = t_s + np.arange(n3) / SR
    bend = 35.0 - 95.0 * np.clip((tt3 - sp) / (pk - sp), 0, 1) ** 1.2 + 40.0 * np.clip((tt3 - pk) / (sg - pk), 0, 1)
    ex3 = np.exp(-((tt3 - pk) / 2.6) ** 2)
    ctx.add('sub', 'dry', t_s, I.sub_tone(nm('D1'), dur, vel=0.07, att=1.5, rel=2.5, h2=0.25, bend=bend) * ex3[None, :])
    ctx.hit(sp, '船压下来：只留 sub（D1，随船下压 60 音分）', 'sub', check=False)


# ======================================================================= S2 长卷
def s2(ctx):
    P = ctx.M('s2_scroll.paper_in')
    RW = ctx.M('s2_scroll.scroll_rewind')
    AST = ctx.M('s2_scroll.asteroid')
    WEI = ctx.M('s2_scroll.wei_write')
    MOD = ctx.M('s2_scroll.modern')
    DAM = ctx.M('s2_scroll.dam_line')
    end_s2 = ctx.S('s2_scroll')[1]
    ctx.section('s2', P, end_s2, '古琴主导的长卷：旋律都放在台词缝隙；倒吸上行；陨石变暗；主题第二次；modern 急促；'
                                 'dam_line 硬切；之后只剩极低长音')
    q = QinPhrase(seed=200)
    # 88.5 之后孤零零的一个低音（L12 说完）：二弦散音 D2，一直响进宣纸
    q.note(ctx.off('L12') + 0.15, 2, None, 0.46, 'flesh', label='孤零零的低音 D2（二弦散音）')
    # 宣纸淡入：一个轻泛音
    q.harm(P + 0.25, 2, 5, 0.34, label='宣纸：A3 泛音')
    # L13 之后：C4 -> 下 A3（叹息）
    t = ctx.off('L13') + 0.12
    q.note(t, 6, 'C4', 0.42, 'flesh', orn=[('go', 0.55, 'A3', 0.40), ('yin', 1.05, 1.4, 10, 4.6)])
    # L14 句中停顿：G3
    q.note(ctx.gap('L14', 0), 4, 'G3', 0.36, 'flesh', orn=[('yin', 0.3, 1.2, 9, 4.8)])
    # scroll_rewind：倒吸（反向混响膨胀）+ 拂（散音由低到高），落在 L15 开口前
    top = ctx.on('L15') - 0.45
    sweep_t = top - 0.55
    q.sweep(sweep_t, [1, 2, 3, 4, 5, 6, 7], 0.55, vel=0.34, curve=0.85, label='倒吸后的拂（上行）')
    # 远古：水滴一样的泛音
    t = ctx.off('L15') + 0.12
    for dt, s, hui, v in ((0.0, 7, 4, 0.34), (0.48, 7, 5, 0.29), (0.95, 4, 4, 0.26)):
        q.harm(t + dt, s, hui, v, label='远古：泛音')
    # 陨石：琴手按住所有弦（世界突然停住），低音与和声由低弦和 sub 负责
    q.damp_all(AST - 0.03, 0.25)
    # 「也没能杀死我们」：F3 G3 A3 一级级站起来
    t = ctx.off('L17') + 0.15
    q.note(t, 3, 'F3', 0.44, 'flesh')
    q.note(t + 0.55, 4, 'G3', 0.45, 'flesh')
    q.note(t + 1.10, 5, 'A3', 0.50, 'nail', approach=('chuo', 60, 0.12), orn=[('yin', 0.35, 1.5, 12, 4.6)])
    # L18（山、河、冰）：缝隙里的几个音，时间在流动
    q.note(ctx.gap('L18', 0), 6, 'C4', 0.32, 'flesh')
    q.note(ctx.gap('L18', 2), 7, 'D4', 0.36, 'flesh', orn=[('yin', 0.3, 1.4, 10, 4.5)])
    t = ctx.off('L18') + 0.15
    q.note(t, 5, 'A3', 0.36, 'flesh', orn=[('go', 0.5, 'G3', 0.45)])
    # L19（岸上有了人）：F3 温暖
    q.note(ctx.gap('L19', 0), 3, 'F3', 0.32, 'flesh', orn=[('yin', 0.25, 1.2, 9, 4.4)])
    t = ctx.off('L19') + 0.12
    q.note(t, 4, 'G3', 0.34, 'flesh')
    q.note(t + 0.5, 5, 'A3', 0.36, 'flesh', label='走向 wei_write')
    # wei_write：一个清亮的泛音（七弦四徽 D5）
    q.harm(WEI, 7, 4, 0.52, 'nail', label='wei_write：清亮泛音 D5')
    q.harm(ctx.gap('L20', 0), 7, 5, 0.28, label='L20 缝隙：A4 泛音')
    q.note(ctx.off('L20') + 0.15, 4, 'G3', 0.33, 'flesh')
    # L21（天子乘舟、宗庙）：庄重的散音与泛音
    q.note(ctx.gap('L21', 0), 7, None, 0.36, 'flesh', label='宗庙：D3 散音')
    q.harm(ctx.gap('L21', 1), 2, 5, 0.30, label='宗庙：A3 泛音')
    q.harm(ctx.off('L21') + 0.14, 4, 7, 0.28, label='G3 泛音')
    # ---- 主题第二次（L22「那时候，江里到处都是我们」）：音落在台词的呼吸缝里，第 5 音在台词说完时到
    m1 = ctx.L('L22')[0]
    m2 = ctx.gap('L22', 0)
    m3 = ctx.gap('L22', 1) + 0.02
    m4 = ctx.gap('L22', 2)
    m5 = ctx.off('L22') + 0.06
    q.note(m1, 7, None, 0.62, 'flesh', label='主题②-1 D3')
    q.note(m2, 5, 'A3', 0.62, 'nail', approach=('chuo', 100, 0.18), orn=[('yin', 0.35, 1.0, 12, 4.5)],
           label='主题②-2 A3')
    q.note(m3, 5, 'G3', 0.58, 'flesh', approach=('slide', m3 - 0.28), orn=[('yin', 0.4, 1.8, 9, 4.6)],
           label='主题②-3 G3')
    q.note(m4, 3, 'F3', 0.60, 'flesh', approach=('zhu', 90, 0.2), orn=[('yin', 0.4, 2.4, 11, 4.2)],
           label='主题②-4 F3')
    q.cuo(m5, [(2, None), (7, None)], 0.64, label='主题②-5 D2+D3')
    ctx.theme('scroll', [(m1, 'D3'), (m2, 'A3'), (m3, 'G3'), (m4, 'F3'), (m5, 'D2+D3')],
              '长卷 L22：温暖，低弦平行五度 D-F-C-Bb-D 托着；四个音都在台词的换气缝里，第 5 音在「都是我们」之后')
    # ---- modern：锁（D3 / C3 散音交替急弹），越来越快、越来越响，dam_line 前一刻为止
    ts = []
    t = MOD + 0.02
    dt = 0.25
    while t < DAM - 0.07:
        ts.append(t)
        t += dt
        dt = max(0.062, dt * 0.83)
    for i, t in enumerate(ts):
        u = i / max(1, len(ts) - 1)
        q.note(t, 7 if i % 2 == 0 else 6, None, 0.34 + 0.36 * u, 'nail' if i % 2 else 'flesh',
               label='modern：锁' if i == 0 else f'modern 锁 {i}')
    ctx.qin(q, bus='hall', tail=6.0, t_end=DAM)

    # 倒吸：D2 A2 D3 散音撮 -> 远混响 -> 倒放，末端对齐拂的起点
    rq = QinPhrase(seed=201)
    rq.cuo(10.0, [(2, None), (5, None), (7, None)], 0.55)
    _, rx = rq.render(tail=3.0)
    rv = reverse_swell(rx.astype(np.float64), ctx.ir('qin_far'), 1.6)
    ctx.add('guqin', 'dry', sweep_t - rv.shape[1] / SR, rv * 0.55)
    ctx.hit(RW, 'scroll_rewind：倒吸（反向混响膨胀）', 'guqin', check=False)
    ctx.hit(sweep_t, '拂：散音由低到高，落在 L15 开口前', 'guqin')

    # ---- 低弦：和声段落（每段都在台词缝隙里换）
    def ch(t_a, t_b, notes, vel, att=2.0, rel=2.2, **kw):
        strings(ctx, t_a, notes, t_b - t_a, vel, att=att, rel=rel, **kw)

    ch(P, AST - 0.35, ['D2', 'A2'], 0.145, att=4.0, rel=0.6)
    # 陨石：沉重的低音（Bb1），和声变暗；sub 一击
    t_b = ctx.gap('L18', 0)
    nb = int((t_b - AST + 3.0) * SR)
    tb_ = np.arange(nb) / SR
    ex_b = 0.30 + 0.70 * np.exp(-tb_ / 1.6)             # 重击之后压下来，让 L17 说话
    ch(AST - 0.02, t_b, ['Bb1', 'F2'], 0.42, att=0.22, rel=2.5, seed=2201, expr=ex_b)
    ctx.add('sub', 'dry', AST, I.sub_tone(hz(nm('Bb1')), 3.6, vel=0.20, att=0.012, rel=2.8, h2=0.3))
    ctx.hit(AST, '陨石：沉重的低音 Bb1（低提 + 大提 + sub），古琴全弦按住', 'strings')
    ch(ctx.gap('L18', 0), ctx.gap('L18', 2), ['C2', 'G2'], 0.135, att=2.5)
    ch(ctx.gap('L18', 2), ctx.off('L18') + 0.4, ['D2', 'A2'], 0.135, att=2.5)
    ch(ctx.off('L18') + 0.4, WEI - 0.2, ['F2', 'C3'], 0.135, att=2.5)
    ch(WEI - 0.2, ctx.on('L21') - 0.3, ['D2', 'A2'], 0.135, att=2.5)
    ch(ctx.on('L21') - 0.3, m1 - 0.6, ['G2', 'D3'], 0.13, att=2.5)
    # 主题②：平行五度 D-F-C-Bb-D（古朴，不是流行和声）
    ch(m1 - 0.6, m2, ['D2', 'A2'], 0.17, att=1.5, rel=1.6)
    ch(m2 - 0.1, m3, ['F2', 'C3'], 0.185, att=1.2, rel=1.6)
    ch(m3 - 0.1, m4, ['C2', 'G2'], 0.175, att=1.2, rel=1.6)
    ch(m4 - 0.1, m5, ['Bb1', 'F2'], 0.185, att=1.2, rel=1.6)
    ch(m5 - 0.1, MOD + 0.2, ['D2', 'A2'], 0.17, att=0.8, rel=1.0)
    # 远处哼唱：远古的雾；岸上有了人时换到 F
    hum(ctx, ctx.on('L15') - 0.8, ['D3', 'A3'], AST - 0.4 - (ctx.on('L15') - 0.8), 0.055, att=3.0, rel=1.2, seed=221)
    hum(ctx, ctx.off('L18') + 0.6, ['F3', 'C4'], WEI - (ctx.off('L18') + 0.6), 0.05, att=3.0, rel=2.5, seed=222)
    # modern：低提 D2 与大提 Eb3 震音，越来越响（不安）
    n = int((DAM - MOD + 0.5) * SR)
    ex = np.linspace(0.35, 1.0, n) ** 1.6
    ctx.add('strings', 'hall', MOD, I.strings(nm('D2'), DAM - MOD, 0.42, att=0.3, rel=0.4, sec='cb', seed=2301,
                                              trem=9.0, expr=ex))
    ctx.add('strings', 'hall', MOD + 0.15, I.strings(nm('Eb3'), DAM - MOD - 0.15, 0.30, att=0.4, rel=0.4, sec='vc',
                                                     seed=2302, trem=11.0, expr=ex))
    ctx.hit(MOD, 'modern：节奏变急（锁 + 低弦震音）', 'guqin')

    # ================= dam_line：硬切（连混响尾巴一起 10 ms 内收掉）
    ctx.gate(DAM, fout=0.010, label='dam_line 硬切')
    # 之后只剩一根极低的长音（sub D1 + 低提 D1 极轻），L26 左右消失，171 起几乎无声
    t_on = DAM + 0.45
    t_rel = ctx.on('L26') - 1.5
    sub(ctx, t_on, 'D1', t_rel - t_on, 0.085, att=3.5, rel=3.5, h2=0.22, beat_hz=0.22)
    ctx.add('strings', 'hall', t_on + 0.8, I.strings(nm('D1'), t_rel - t_on - 0.8, 0.055, att=4.0, rel=3.5, sec='cb',
                                                     seed=2401, vib_amt=0.3))
    ctx.hit(t_on, '墙之后：极低长音 D1 慢慢升起', 'sub', check=False)


# ======================================================================= S3 二〇〇三
def s3(ctx):
    DC = ctx.M('s3_2003.date_card')
    SKY = ctx.M('s3_2003.sky')
    CB = ctx.M('s3_2003.cage_boat')
    TP = ctx.M('s3_2003.tag_ping_start')
    REL = ctx.M('s3_2003.release')
    NIGHT = ctx.M('s3_2003.night')
    CRASH = ctx.M('s3_2003.crash')
    ctx.section('s3', DC, ctx.S('s4_seven')[0], '更近、更人间：古琴泛音（小房间混响）+ 很轻的 pad；天一闪；信标段和声只用与 A 协和的音；'
                                               'release 向上的一句；crash 硬切；之后稀疏的单个低音')
    q = QinPhrase(seed=300)
    q.harm(DC + 0.15, 7, 5, 0.44, label='二〇〇三：A4 泛音')
    q.harm(DC + 0.85, 4, 2, 0.38, label='二〇〇三：D5 泛音')
    # 「很暖」：L30 与 L31 之间一个 F3（吟）
    q.note(ctx.off('L30') + 0.1, 3, 'F3', 0.52, 'flesh', orn=[('yin', 0.35, 1.8, 10, 4.3)], label='很暖：F3')
    # 「肚子里有卵」之后：一个很轻的泛音
    q.harm(ctx.off('H05') + 0.2, 7, 4, 0.36, label='有卵：D5 泛音')
    # 二十四针：极轻的两点（不跟针抢）
    q.harm(ctx.L('L32')[0] + 0.07, 2, 2, 0.19, label='缝针：A4 泛音（极轻）')
    q.harm(ctx.off('L32') + 0.08, 4, 4, 0.18, label='缝针：G4 泛音（极轻）')
    # release：先往下游（D4 下滑到 A3），再转身往上游（A3 上滑 C4、D4），最后两个泛音向上
    q.note(REL, 7, 'D4', 0.60, 'nail', orn=[('go', 0.30, 'A3', 0.55), ('yin', 0.95, 1.3, 9, 4.6)],
           label='release：向下游（D4 下滑 A3）')
    t = ctx.gap('L34', 0) + 0.03
    q.note(t, 5, 'A3', 0.56, 'nail', orn=[('go', 0.12, 'C4', 0.28), ('go', 0.62, 'D4', 0.30),
                                          ('yin', 1.0, 1.4, 10, 4.8)],
           label='release：转身往上游（A3 上滑 C4 再上 D4）')
    t = ctx.off('L34') + 0.08
    q.harm(t, 7, 5, 0.52, label='向上游：A4 泛音')
    q.harm(t + 0.02, 4, 2, 0.45, label='向上游：D5 泛音')
    # 夜：船在险滩前，一个很低的散音
    q.note(ctx.off('H07') + 0.2, 1, None, 0.36, 'flesh', label='夜：C2 散音')
    ctx.qin(q, bus='room', tail=6.0, t_end=CRASH)
    ctx.hit(REL, 'release：向上的一句古琴', 'guqin')

    # ---- pad 与低弦
    pad(ctx, DC, ['D3', 'A3', 'E4'], SKY - 0.35 - DC, 0.105, att=1.8, rel=0.6, seed=331)
    # 天：明亮的高音 pad 一闪（峰值对准 sky）
    ctx.add('pad', 'hall', SKY - 0.45, I.air_pad(nms('A5', 'D6', 'E6', 'A6'), 0.05, vel=0.34, att=0.45, rel=2.4,
                                                bright=3.0, seed=332, shimmer=0.2))
    ctx.hit(SKY, '天：明亮的高音 pad 一闪', 'pad', check=False)
    pad(ctx, SKY + 0.8, ['D3', 'A3'], ctx.on('L30') - 0.9 - (SKY + 0.8), 0.05, att=2.0, rel=1.2, seed=333)
    # 棉被：F 的温暖（全片 2D 唯一的暖色）
    t_w = ctx.off('H03') + 0.25
    pad(ctx, t_w, ['F3', 'A3', 'C4'], CB - t_w, 0.11, att=1.8, rel=1.5, seed=334)
    cello(ctx, t_w + 0.3, 'F2', CB - t_w - 0.3, 0.16, sec='vc', att=2.0, rel=1.8)
    pad(ctx, CB + 0.2, ['D3', 'A3'], ctx.on('L33') - (CB + 0.2), 0.056, att=2.0, rel=1.5, seed=335)
    # 信标（1760 Hz = A6）：和声只用与 A 协和的音（A E D），纯五度的 A
    pad(ctx, ctx.on('L33') - 0.4, ['A3', 'E4', 'A4'], REL - (ctx.on('L33') - 0.4), 0.077, att=2.2, rel=1.2, seed=336)
    cello(ctx, TP - 0.6, 'A2', REL - TP + 0.4, 0.14, sec='vc', att=2.5, rel=1.4)
    # release：开阔的 D-A-E（有希望）
    pad(ctx, REL - 0.2, ['D3', 'A3', 'E4'], NIGHT - REL, 0.10, att=1.2, rel=1.6, seed=337)
    strings(ctx, REL - 0.2, ['D2', 'A2'], NIGHT - REL + 0.2, 0.18, att=1.5, rel=1.6, seed=338)
    # 夜：转暗，低弦往 crash 慢慢逼近
    pad(ctx, NIGHT - 0.3, ['D3', 'A3'], CRASH - NIGHT + 0.5, 0.063, att=2.0, rel=1.0, seed=339, bright=0.5)
    n = int((CRASH - NIGHT + 3) * SR)
    ex = np.linspace(0.55, 1.0, n) ** 2
    strings(ctx, NIGHT - 0.2, ['D2', 'A2'], CRASH - NIGHT + 0.5, 0.19, att=2.0, rel=1.0, expr=ex, seed=340)

    # ================= crash：硬切
    ctx.gate(CRASH, fout=0.010, label='crash 硬切（触礁）')
    q2 = QinPhrase(seed=301)
    q2.note(ctx.off('H09') + 0.35, 2, None, 0.40, 'flesh', label='等：D2 散音')
    q2.note(ctx.off('L35') + 0.55, 1, None, 0.34, 'flesh', label='等：C2 散音')
    q2.note(ctx.off('L36') + 0.4, 2, None, 0.30, 'flesh', label='你们没有来：D2 散音')
    ctx.qin(q2, bus='hall', tail=10.0)


# ======================================================================= S4 七年
def s4(ctx):
    TC = ctx.M('s4_seven.tag_close')
    SB = ctx.M('s4_seven.search_boat')
    SL = ctx.M('s4_seven.search_leave')
    end4 = ctx.S('s4_seven')[1]
    ctx.section('s4', TC, end4, '独奏大提琴孤独的长线条（换音都在台词缝隙）；search_boat 起一点点不安（Bb、低提震音、稀疏玻璃）')
    ev = [(TC + 0.25, 'D3'),
          (ctx.gap('L37', 0), 'C3'),
          (ctx.gap('L37', 1), 'A2'),
          (ctx.off('L37') + 0.1, 'G2'),
          (ctx.gap('L38', 0), 'A2'),
          (ctx.off('L38') + 0.05, 'Bb2'),
          (ctx.gap('L39', 0), 'A2'),
          (ctx.gap('L39', 1), 'Bb2'),
          (ctx.off('L39') + 0.1, 'A2'),
          (SL + 0.8, None)]
    vels = [0.105, 0.10, 0.095, 0.09, 0.09, 0.105, 0.095, 0.10, 0.09]
    cello_line(ctx, ev, vels, sec='vcsolo', att=0.5, rel=2.2, overlap=0.4)
    ctx.hit(TC + 0.25, '独奏大提琴线条起（D3）', 'strings', check=False)
    # 低提 D2 很轻的持续，search_boat 起加一层很轻的震音
    strings(ctx, TC, ['D2'], end4 - TC - 1.5, 0.08, att=4.0, rel=2.5, seed=410)
    ctx.add('strings', 'hall', SB, I.strings(nm('D2'), SL - SB + 1.0, 0.06, att=2.5, rel=2.0, sec='cb', seed=411, trem=5.5))
    ctx.hit(SB, 'search_boat：一点点不安（Bb2 + 低提震音）', 'strings', check=False)
    # 电感视觉（水听器悬在头顶）：极稀的玻璃
    sparkles(ctx, SB + 0.5, SL, lambda t: 1.1, seed=412, vel=(0.012, 0.04), dur=(0.2, 0.6))


# ======================================================================= S5 老鲟
def s5(ctx):
    FG = ctx.M('s5_sturgeon.far_glow')
    RU = ctx.M('s5_sturgeon.rush')
    RV = ctx.M('s5_sturgeon.reveal')
    SLV = ctx.M('s5_sturgeon.sturgeon_leave')
    end5 = ctx.S('s5_sturgeon')[1]
    ctx.section('s5', FG, end5, '心跳般的低频脉动渐快；「是你吗」悬起来；reveal 落到悲伤的和弦（A 挂着 -> Bb，假终止）；'
                                '对话只有很薄的 pad；低弦目送')
    # 心跳：远处的光出现 -> 越来越快；她问「是你吗」时屏住；rush 起再跳，更快，reveal 前一刻停
    t_hold = ctx.on('L42') - 0.25
    beats = []
    t = FG + 0.15
    iv = 1.15
    while t < t_hold:
        beats.append(t)
        t += iv
        iv = max(0.60, iv * 0.9)
    t = RU + 0.02
    iv = 0.56
    while t < RV - 0.2:
        beats.append(t)
        t += iv
        iv = max(0.43, iv * 0.96)
    for i, bt in enumerate(beats):
        u = i / max(1, len(beats) - 1)
        ctx.add('sub', 'dry', bt, I.heart(0.10 + 0.14 * u, f=hz(nm('A1'))))
    ctx.hit(FG + 0.15, '远处的光：心跳般的低频脉动（A1）渐快', 'sub', check=False)
    # 大的光团：玻璃越来越密，reveal 切回真实视角时收掉
    sparkles(ctx, FG + 0.3, RV, lambda t: 2.0 + 8.0 * ((t - FG) / (RV - FG)) ** 1.5, seed=510,
             vel=(0.03, 0.14), dur=(0.2, 0.8), stop_at=RV + 0.04,
             vel_fn=lambda t: 0.6 + 0.6 * (t - FG) / (RV - FG))
    # 「是你吗」：A 上挂起来（A2 E3 + 远处哼 A3 E4），rush 起涌起，reveal 前收
    n = int((RV - (t_hold - 0.3) + 2.0) * SR)
    tt = (t_hold - 0.3) + np.arange(n) / SR
    ex = 0.55 + 0.45 * np.clip((tt - RU) / (RV - RU), 0, 1) ** 1.5
    strings(ctx, t_hold - 0.3, ['A1', 'E2', 'A2', 'E3'], RV - (t_hold - 0.3), 0.36, att=1.2, rel=0.5, expr=ex, seed=511)
    hum(ctx, t_hold - 0.2, ['A3', 'E4'], RV - t_hold, 0.12, att=1.0, rel=0.6, open_mix=0.4, seed=512, expr=ex)
    ctx.hit(t_hold, '「是你吗」：悬在 A 上', 'strings', check=False)
    # reveal：落到 Bb（假终止：不是她的同类）
    # 砸下来之后 0.4 s 起让路：约 3 s 内降到 1/4 左右（老鲟 O01 / O02 开口时只剩一层底色）
    d_rv = ctx.on('L43') - RV + 0.5
    tt = np.arange(int((d_rv + 4.0) * SR)) / SR
    ex_rv = 0.25 + 0.75 * np.exp(-np.maximum(0.0, tt - 0.4) / 1.1)
    strings(ctx, RV, ['Bb1', 'F2', 'D3', 'F3'], d_rv, 0.40, att=0.35, rel=3.5, expr=ex_rv, seed=513)
    hum(ctx, RV + 0.05, ['D4', 'F4'], ctx.on('O02') - RV, 0.10, att=0.6, rel=3.0, seed=514)
    ctx.hit(RV, 'reveal：悲伤的和弦 Bb（A -> Bb 假终止）', 'strings')
    # 对话：很薄的 pad
    t_p = ctx.on('O02') - 0.5
    pad(ctx, t_p, ['D3', 'F3'], ctx.on('O04') - t_p, 0.07, att=3.0, rel=2.0, seed=515, bright=0.6)
    pad(ctx, ctx.on('O04') - 0.6, ['C3', 'F3'], ctx.on('L45') - ctx.on('O04'), 0.065, att=2.0, rel=2.0, seed=516,
        bright=0.6)
    pad(ctx, ctx.on('L45') - 0.6, ['D3', 'A3'], SLV - ctx.on('L45') + 0.6, 0.07, att=2.0, rel=2.0, seed=517, bright=0.6)
    # 老鲟说「那时候，江里到处都是你们」之后：一个远处的泛音（回忆）
    q = QinPhrase(seed=500)
    q.harm(ctx.off('O03') + 0.2, 7, 5, 0.27, label='回忆：A4 泛音')
    ctx.qin(q, bus='far', tail=8.0)
    # 低弦目送：A2 -> G2 -> F2 -> D2（换音在 L46 的停顿里）
    ev = [(SLV + 0.05, 'A2'), (ctx.gap('L46', 0), 'G2'), (ctx.gap('L46', 1), 'F2'), (ctx.off('L46') + 0.1, 'D2'),
          (end5 + 1.2, None)]
    cello_line(ctx, ev, [0.17, 0.165, 0.16, 0.16], sec='vcsolo', att=0.7, rel=2.5, overlap=0.45)
    strings(ctx, SLV, ['D2'], end5 - SLV + 0.5, 0.12, att=3.0, rel=3.0, seed=518)
    ctx.hit(SLV + 0.05, '低弦目送（A2 G2 F2 D2）', 'strings', check=False)


# ======================================================================= S6 宜宾
def s6(ctx):
    NC = ctx.M('s6_yibin.night_city')
    WN = ctx.M('s6_yibin.wait_night')
    RE = ctx.M('s6_yibin.release_eggs')
    EG = ctx.M('s6_yibin.eggs_glow')
    ED = ctx.M('s6_yibin.eggs_dark')
    ctx.section('s6', NC, ctx.S('s7_end')[0], '夜城温暖的远 pad；等一整夜的长音（灯一盏盏熄 = pad 一个音一个音退）；'
                                             '产卵：主题第三次（最饱满）；L52 起随卵熄灭一层层变薄')
    # 夜城：温暖的远 pad（F A C + 远处哼 D）
    for (m, t_off, seed) in (('F3', 1.4, 601), ('A3', 3.3, 602), ('C4', 5.0, 603), ('D4', 6.8, 604)):
        pad(ctx, NC, [m], WN + t_off - NC, 0.10, kind='warm', att=4.0, rel=2.2, cutoff=950, seed=seed, bus='far')
    hum(ctx, NC + 1.5, ['F3', 'C4'], WN - NC - 1.0, 0.09, att=4.0, rel=3.0, seed=605)
    strings(ctx, NC + 0.5, ['F2'], WN - NC, 0.11, att=4.0, rel=3.0, seed=606)
    q = QinPhrase(seed=600)
    q.note(ctx.gap('L47', 0) + 0.02, 6, 'C4', 0.34, 'flesh', orn=[('yin', 0.3, 1.3, 9, 4.5)], label='宜宾：C4')
    t = ctx.off('L47') + 0.12
    q.note(t, 4, 'G3', 0.38, 'flesh', orn=[('go', 0.5, 'A3', 0.35), ('yin', 0.95, 1.4, 10, 4.6)], label='宜宾：G3 上 A3')
    q.note(ctx.gap('L48', 2) + 0.02, 3, 'F3', 0.30, 'flesh', label='妈妈：F3')
    q.harm(ctx.off('L48') + 0.12, 7, 7, 0.30, label='等：D4 泛音')
    # 等一整夜：持续的长音 A（远处哼 + 大提琴）
    hum(ctx, WN - 0.3, ['A3'], RE - WN + 0.6, 0.10, att=3.0, rel=2.0, seed=607)
    cello(ctx, WN, 'A2', RE - WN + 0.8, 0.14, sec='vc', att=3.5, rel=2.0)
    ctx.hit(WN, 'wait_night：持续的长音 A（夜城 pad 一个音一个音退掉）', 'strings', check=False)
    # 产卵：卵像雪一样散开 -> 滚（散音由高到低，很轻）
    q.sweep(RE + 0.05, [7, 6, 5, 4, 3, 2, 1], 0.95, vel=0.28, curve=1.1, label='release_eggs：滚（由高到低）')
    # ---- 主题第三次（最完整最饱满）：古琴 + 弦乐三和弦 + 远处哼唱（高八度跟唱旋律）+ 琥珀色玻璃光
    e1, e2, e3, e4, e5 = EG, EG + 1.27, EG + 2.47, EG + 3.62, EG + 4.87
    assert e5 < ctx.on('L52') - 0.3, 'theme 3 must finish before L52'
    q.cuo(e1, [(2, None), (7, None)], 0.70, label='主题③-1 D2+D3')
    q.note(e2, 5, 'A3', 0.70, 'nail', approach=('chuo', 110, 0.2), orn=[('yin', 0.4, 1.0, 13, 4.4)],
           label='主题③-2 A3')
    q.note(e3, 5, 'G3', 0.66, 'flesh', approach=('slide', e3 - 0.3), orn=[('yin', 0.4, 0.9, 10, 4.7)],
           label='主题③-3 G3')
    q.note(e4, 3, 'F3', 0.68, 'flesh', approach=('zhu', 95, 0.22), orn=[('yin', 0.45, 1.1, 12, 4.2)],
           label='主题③-4 F3')
    q.cuo(e5, [(2, None), (7, None)], 0.72, label='主题③-5 D2+D3')
    # L52「一颗一颗，暗下去」：缝里的泛音一个比一个轻
    for i, (s, hui, v) in enumerate(((7, 5, 0.30), (4, 2, 0.21), (2, 2, 0.14))):
        q.harm(ctx.gap('L52', i) + 0.04, s, hui, v, label=f'卵熄灭：泛音 {i + 1}')
    ctx.qin(q, bus='hall', tail=10.0)
    ctx.theme('eggs', [(e1, 'D2+D3'), (e2, 'A3'), (e3, 'G3'), (e4, 'F3'), (e5, 'D2+D3')],
              '产卵：最完整最饱满（古琴 + 弦乐三和弦 Dm-F-C-Bb-Dm + 远处哼唱跟唱旋律 + 琥珀玻璃光），L52 起逐层变薄')
    # 弦乐：release_eggs 起涌起，主题时三和弦（每个音换一次）
    strings(ctx, RE, ['D2', 'A2'], e1 - RE + 0.3, 0.20, att=2.5, rel=1.2, seed=610)
    chords = [(e1, ['D2', 'A2', 'F3']), (e2, ['F2', 'C3', 'A3']), (e3, ['C2', 'G2', 'E3']), (e4, ['Bb1', 'F2', 'D3'])]
    for i, (tc_, notes) in enumerate(chords):
        t_nx = chords[i + 1][0] if i + 1 < len(chords) else e5
        strings(ctx, tc_ - 0.12, notes, t_nx - tc_ + 0.1, 0.29, att=0.9, rel=1.4, seed=611 + i)
    # 最后的 Dm：各声部一层层退（F3 先走，A2 其次，D2 最后），跟着卵一颗颗熄灭
    g = ctx.gaps('L52')
    strings(ctx, e5 - 0.12, ['F3'], g[0][0] - e5, 0.21, att=0.8, rel=1.6, seed=620)
    strings(ctx, e5 - 0.12, ['A2'], g[1][0] - e5, 0.21, att=0.8, rel=1.8, seed=621)
    strings(ctx, e5 - 0.12, ['D2'], g[2][1] - e5, 0.22, att=0.8, rel=2.2, seed=622)
    # 远处哼唱：高八度跟唱旋律（整句一口气，滑到每个音），加一层和弦
    mel = [(e2 - e1, 'A4'), (e3 - e1, 'G4'), (e4 - e1, 'F4'), (e5 - e1, 'D4')]
    ctx.add('hum', 'far', e1 - 0.15, I.hum([nm('D4')], e5 - e1 + 1.0, vel=0.14, att=1.0, rel=2.2, seed=630,
                                           open_mix=0.35, glide=[(t_ + 0.15, m_) for t_, m_ in mel]))
    hum(ctx, RE + 0.5, ['D3', 'A3'], e5 - RE + 0.2, 0.11, att=2.5, rel=2.5, seed=631)
    # 卵的琥珀光：暖的玻璃粒子（低一些、软一些），eggs_glow 起亮，L52 起一颗颗熄
    l52 = ctx.on('L52')

    def egg_rate(t):
        if t < EG + 0.6:
            return 12.0 * (t - EG) / 0.6
        if t < l52:
            return 12.0
        return 12.0 * max(0.0, 1 - (t - l52) / (ED - 0.6 - l52)) ** 1.5
    sparkles(ctx, EG, ED - 0.6, egg_rate, seed=640, vel=(0.035, 0.15), dur=(0.3, 1.1), pool=EGG_POOL, warm=0.7,
             vel_fn=lambda t: 1.0 if t < l52 else max(0.15, 1 - (t - l52) / (ED - l52)))
    ctx.hit(EG, '卵亮起：主题第三次', 'guqin')


# ======================================================================= S7 最后
def s7(ctx):
    SINK = ctx.M('s7_end.sink')
    LO = ctx.M('s7_end.lights_out')
    LP = ctx.M('s7_end.last_pulse')
    BLK = ctx.M('s7_end.black')
    ctx.section('s7', SINK, ctx.S('s8_epilogue')[0], '极其脆弱的几个音；lights_out 之后只弹主题前 4 个音，第 5 个音永远不来；'
                                                  'last_pulse 前琴声已止，black 时完全无声')
    # 极轻的低提（像她身下的卵石），L56 说完就收
    strings(ctx, SINK + 0.2, ['D2'], ctx.off('L56') - SINK - 0.8, 0.038, att=4.0, rel=2.0, seed=710)
    q = QinPhrase(seed=700)
    q.harm(SINK + 0.35, 7, 4, 0.20, label='沉：D5 泛音（极轻）')
    q.note(ctx.off('L53') + 0.3, 5, 'A3', 0.22, 'flesh', label='我有点累了：A3（极轻）')
    q.harm(ctx.off('L54') + 0.4, 4, 4, 0.16, label='还在听吗：G4 泛音')
    q.harm(ctx.off('L55') + 0.45, 3, 2, 0.14, label='别找了：C5 泛音')
    # ---- 最后 4 个音：D3 A3 G3 F3（更轻、更慢），第 5 个音永远不来
    f1 = LO + 0.30
    f2 = f1 + 1.35
    f3 = f2 + 1.45
    f4 = f3 + 1.60
    t_damp = LP - 0.75
    assert t_damp - f4 > 1.2
    q.note(f1, 7, None, 0.40, 'flesh', label='最后①（D3）')
    q.note(f2, 5, 'A3', 0.36, 'flesh', approach=('chuo', 70, 0.2), orn=[('yin', 0.3, 1.0, 6, 3.6)], label='最后②（A3）')
    q.note(f3, 5, 'G3', 0.32, 'flesh', approach=('slide', f3 - 0.35), label='最后③（G3）')
    q.note(f4, 3, 'F3', 0.31, 'flesh', approach=('zhu', 50, 0.25), orn=[('yin', 0.5, 1.3, 5, 3.4)],
           label='最后④（F3）——第 5 个音永远不来')
    # 手轻轻放到弦上：所有弦止住（last_pulse 之前）
    q.damp_all(t_damp, 0.45)
    ctx.qin(q, bus='hall', tail=4.0, t_end=t_damp + 0.5)
    ctx.theme('death', [(f1, 'D3'), (f2, 'A3'), (f3, 'G3'), (f4, 'F3')],
              f'她死去：只有前 4 个音，第 5 个音不来；{t_damp:.2f} 手放到弦上止音，last_pulse {LP:.2f} 前琴声已尽，'
              f'black {BLK:.2f} 时音乐完全无声')
    # 最后的光点：极稀、极轻的玻璃粒子，在 4 个音之间一颗颗熄掉
    sparkles(ctx, LO - 0.4, f4 - 0.2, lambda t: 2.4 * max(0.0, 1 - (t - (LO - 0.4)) / (f4 - LO)), seed=711,
             vel=(0.010, 0.03), dur=(0.2, 0.7), stop_at=t_damp)
    # 止音后厅堂的余响在 last_pulse 之前 0.05 s 收净（0.55 s 余弦慢收）：最后一下心跳四周是真正的静音
    ctx.gate(LP - 0.05, fout=0.55, label='last_pulse 前：止音后的余响收净', kind='fade')


# ======================================================================= S8 尾声
def s8(ctx):
    PI = ctx.M('s8_epilogue.paper_in')
    VW = ctx.M('s8_epilogue.verse_write')
    VS = ctx.M('s8_epilogue.verse_src')
    E = [ctx.M(f's8_epilogue.E{i}') for i in range(1, 10)]
    WW = ctx.M('s8_epilogue.wei_wash')
    WD = ctx.M('s8_epilogue.wash_done')
    FB = ctx.M('s8_epilogue.fade_black')
    CR = ctx.M('s8_epilogue.credits')
    END = ctx.M('s8_epilogue.end')
    ctx.section('s8', PI, END, '古琴与低弦的安静终曲：每张字卡一个音、一次换和声；E8 留白；鲔字被洗掉时只剩泛音；'
                               'credits 一个温暖但不解决的和弦（F 上的五声全音：F C A D G）慢慢消失；结束时完全静音')
    q = QinPhrase(seed=800)
    # 有 鳣 有 鲔：四个泛音，一字一音
    for i, (s, hui, v) in enumerate(((7, 5, 0.34), (4, 2, 0.30), (6, 5, 0.28), (7, 7, 0.30))):
        q.harm(VW + 0.25 + i * 1.25, s, hui, v, label=f'有鳣有鲔：泛音 {i + 1}')
    q.cuo(VS + 0.2, [(2, None), (5, None)], 0.40, label='诗经出处：D2+A2 撮')
    # 字卡：每张一个音
    q.note(E[0] + 0.4, 6, None, 0.36, 'flesh', label='E1：C3 散音')
    q.note(E[1] + 0.5, 3, 'F3', 0.36, 'flesh', orn=[('yin', 0.4, 1.6, 9, 4.3)], label='E2：F3')
    q.note(E[2] + 0.5, 5, 'A3', 0.34, 'flesh', orn=[('go', 0.7, 'G3', 0.5)], label='E3：A3 下 G3')
    q.note(E[3] + 0.5, 7, None, 0.36, 'flesh', label='E4：D3 散音')
    q.note(E[4] + 0.5, 4, None, 0.32, 'flesh', label='E5：G2 散音')
    q.note(E[5] + 0.6, 5, None, 0.30, 'flesh', label='E6：A2 散音')
    q.note(E[6] + 0.5, 4, 'G3', 0.34, 'flesh', orn=[('go', 0.6, 'A3', 0.4), ('yin', 1.05, 1.4, 9, 4.5)],
           label='E7：G3 上 A3（一点点希望）')
    # E8「她没有等到。」：留白（不弹）
    q.note(E[8] + 0.5, 1, None, 0.40, 'flesh', label='E9：C2 散音（最低的弦）')
    # 鲔字被洗掉：只剩泛音，一个比一个淡
    for i, (dt, s, hui, v) in enumerate(((0.3, 7, 4, 0.28), (1.8, 2, 2, 0.21), (3.6, 4, 2, 0.15))):
        q.harm(WW + dt, s, hui, v, label=f'鲔字洗去：泛音 {i + 1}')
    ctx.qin(q, bus='far', tail=9.0)
    ctx.hit(WW + 0.3, 'wei_wash：只剩泛音', 'guqin')
    # 低弦：每张字卡换一次（很轻、很慢）
    plan = [(VW, E[0], ['D2', 'A2']), (E[0], E[1], ['C2', 'G2']), (E[1], E[2], ['F2', 'C3']),
            (E[2], E[3], ['Bb1', 'F2']), (E[3], E[4], ['D2', 'A2']), (E[4], E[5], ['C2', 'G2']),
            (E[5], E[6], ['D2']), (E[6], E[7], ['F2', 'C3']), (E[8], WW, ['Bb1', 'F2'])]
    for i, (a, b, notes) in enumerate(plan):
        strings(ctx, a - 0.2, notes, b - a + 0.2, 0.095, att=2.8, rel=1.8 if i != 7 else 1.4, seed=810 + i)
    ctx.hit(E[7], 'E8「她没有等到。」：留白', 'strings', check=False)
    # credits：温暖但不解决（F2 C3 + 哼 A3 D4 G4 = F 上的五声全音），慢慢消失，结束前完全静音
    t_c = CR - 0.4
    fade_end = END - 0.55
    d = fade_end - t_c
    n = int((d + 0.2) * SR)
    tt = np.arange(n) / SR
    ex = np.clip(1 - (tt - 2.5) / (d - 2.5), 0, 1) ** 1.8
    strings(ctx, t_c, ['F2', 'C3'], d, 0.28, att=3.0, rel=0.15, expr=ex, seed=830)
    ctx.add('hum', 'far', t_c + 0.3, I.hum(nms('A3', 'D4', 'G4'), d - 0.3, vel=0.14, att=3.0, rel=0.15, seed=831,
                                         open_mix=0.25, expr=ex[int(0.3 * SR):]))
    ctx.hit(CR, 'credits：温暖但不解决的和弦（F C A D G），慢慢消失', 'strings', check=False)


SECTIONS = [s0, s1, s2, s3, s4, s5, s6, s7, s8]
