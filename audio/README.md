# 《鲔》音效与终混（audio/）

全部声音用代码合成（numpy / scipy），不下载任何音频。台词来自 `tts/volc/wav/`，配乐来自子代理 D 的 `audio/out/music.wav`。

## 一条命令重建

```bash
cd /Users/yednc/Dev/movie5
.venv/bin/python audio/build_mix.py
```

这一条命令会依次完成：重新汇总画面事件、重写 cue 表、合成全部音效和环境床、混音、母带、导出文件、自检。画面组改了 `src/scenes/<id>/events.js` 之后，重跑它就能重新对位，不用改任何代码。

整片跑一遍大约 80 秒。主进程峰值内存约 2.1 GB，环境床子进程约 1.2 GB（两者不同时达到峰值），都在 3 GB 以内。开跑前脚本会检查 `memory_pressure`，系统空闲内存低于 25% 时会先等。

可选参数：

| 参数 | 作用 |
|---|---|
| `--music PATH` | 换一个配乐文件 |
| `--music-source auto\|mix\|stems\|none` | 选择配乐来源 |
| `--music-gain auto\|dB` | 配乐推子；`auto` 表示配乐积分响度比对白低 3 dB |
| `--no-collect` | 不跑 `node tools/collect_events.mjs` |
| `--no-m4a` / `--no-png` | 不输出 m4a / 不画频谱图 |
| `--no-mem-check` | 跳过开跑前的内存检查 |
| `--out DIR` | 输出目录，默认 `out/audio` |

## 流程（`build_mix.py`）

| 步 | 做什么 | 代码 |
|---|---|---|
| 0 | `node tools/collect_events.mjs` 把各场景 `events.js` 汇总进 `audio/visual_events.json` | `tools/`（只读调用） |
| 1 | 从 `script/timeline.json` 和 `visual_events.json` 生成 `audio/cues.json`，并打印每一类音效的时间来源：画面事件，或者按 marks 推算 | `sfx/cuesheet.py`、`sfx/events.py` |
| 2 | 环境床：每条在一个短命子进程里渲染（这是最吃内存的一步，渲染完内存整块还给系统） | `sfx/beds.py` |
| 3 | 台词逐句过处理链，放到 `timeline.lines` 的 `t`；对白总线做峰值控制（PLR 13 dB）；再由对白生成侧链，环境床整条跟着闪避 −5 dB | `voice/chains.py` |
| 4 | 单次音效。持续性的音效在台词处跟着对白侧链闪避（`DUCK_SFX`）；遇到画面硬切（`cut_at`：dam_line、crash）连混响尾巴一起切掉（12 ms 余弦）；逐个测量起音误差 | `sfx/water.py`、`ink.py`、`shore.py`、`library.py` |
| 5 | 配乐：推子设在对白积分响度 −3 dB，侧链闪避 −6 dB；对白保护：某句台词的语音频段信噪比低于 11 dB 时再压配乐，最多压 6 dB | |
| 6 | 母带：轻度胶水压缩，再过真峰值前瞻限幅，迭代到 −16 LUFS、真峰值 ≤ −1 dBTP；片尾最后 1 s 余弦淡到数字静音。这条总增益曲线也乘到四条分轨上，所以四条分轨相加就等于总混音 | |
| 7 | 写出 WAV / 分轨 / m4a | |
| 8 | 自检，写报告和频谱图 | `qa.py`、`sfx/viz.py` |

## 输出

| 文件 | 内容 |
|---|---|
| `out/audio/mix.wav` | 485.192 s，48 kHz，24-bit 立体声 |
| `out/audio/mix.m4a` | AAC 256k；响度和真峰值用 ffmpeg ebur128 另外复核 |
| `out/audio/stems/{dialogue,music,sfx,amb}.wav` | 分轨，已乘母带增益，四条相加 = mix |
| `out/audio/mix_report.json` | 各项自检结果，字段见下文 |
| `out/audio/mix_spectrogram.png` | 全片频谱图 + 各分轨短时响度 |
| `out/audio/mix_spectrogram_rows.png` | 全片分 6 行放大，青色条标出台词位置 |
| `audio/cues.json` | 本次用到的全部 cue（自动生成，不要手改） |
| `audio/out/sfx_events.json` | 参数化音效内部事件的绝对时间，例如船的 ship_pass / peak / prop / gone |

`mix_report.json` 主要字段：

| 字段 | 内容 |
|---|---|
| `integrated_lufs` / `integrated_lufs_pyloudnorm` | 两种实现测得的积分响度 |
| `true_peak_dbtp` | 真峰值 |
| `timing` | 每一类音效用的是画面事件还是 marks |
| `sync` | 每个关键音效的起音误差，容差 1 帧 = 33.3 ms |
| `beacon_ping` | 信标嘀声的周期、首声、截断；`s4_old_tag` 为 S4 旧信标 |
| `lines` | 每句台词的语音频段信噪比、最差 10% 帧、配乐被对白保护额外压了多少 |
| `scenes` | 每场的响度与各分轨响度 |
| `cue_warnings` | 自检警告 |
| `qa` | 爆音、直流、首尾静音、环境床的音高和循环检查 |
| `master.limiter_top_events` | 母带限幅器压得最多的几处 |
| `memory` | 峰值内存 |

## 画面事件怎么对位

`sfx/events.py` 里的 `Timing.pick / one` 按场景在 `visual_events.json` 里做正则查找。查找对象是 `id kind name type label char group` 这几个字段拼起来的字符串，不区分大小写，并可以用 `exclude` 排除一部分。找到了就用画面时刻，找不到就回退到 marks / 台词推算（推算规则和各场景的 `plan.js` / `events.js` 保持一致）。每一类用了哪一种来源都会打印出来，也写进报告的 `timing`。事件带 `dur` 或 `end` 时，也会用来决定音效时长。

目前各场景实际的事件命名和对应的声音：

| 场景 | 画面事件 | 声音 |
|---|---|---|
| s0 | `title_stroke_N`（kind `brush_glow`，带 `end`）、`title_dissolve` | 每一笔一声笔毛擦过加光感 swell；颗粒散开，31.0 s 硬切 |
| s1 | `s1_rostrum` / `s1_body`（`swim_by`，t 是最近点，带 `dist`）、`s1_scan*`、`s1_reveal`、`s1_rumble`、`s1_bow`、`s1_static`、`s1_peak`、`s1_prop`、`s1_dive`、`s1_bottom`、`s1_gone`、`s1_out` | 游过的 whoosh（同步点 = 听感最响处）、电感闪烁、船压过头顶的整套、泥沙、触底 |
| s2 | 还没有 `events.js`，全部按 marks 和 `plan.js` 的规则推算 | 笔画、回卷、陨石、「鲔」字、小楷、近代加速的纸风、尺子画线、鱼淡掉 |
| s3 | `net` impact/close、`thrash`、`splash out_of_water`、`lift` strain/heave、`cloth` quilt/warm、`measure`、`stitch needle`×24、`stitch knot`、`clip tag`、`ping beep`×10、`release into_water`、`turn`、`engine`、`crash`、`bleed` | 网、出水、抬、棉被、量尺、24 针、剪线、卡扣、嘀、入水、折返、柴油机、触礁、墨洇开接 S4 |
| s4 | `tag_ping`×4（带 `amp`，一声比一声弱）、`electro_on`、`boat_pass`×2、`boat_arrive`、`hydrophone_down` / `_up`、`boat_leave` | 旧信标极远极弱的几声、电感、船三次开过、缆绳、水听器入水出水 |
| s5 | `s5_hb*`（heartbeat）、`far_glow`、`rush`、`reveal` (`electro_off_cut`)、`s5_old_in` / `s5_leave`（`swim_by`）、`electro_on_memory` / `_eggs` | 心跳、电感光团、冲过去、老鲟推水、回忆和卵的电感、游走 |
| s6 | `s6_cross`、`s6_memory` / `_off`、`ghost_in`×3、`timelapse_start` / `_end`、`s6_bridge`、`s6_empty`、`egg_release`×7（带 `w`）、`eggs_glow`、`egg_out`×8 | 穿过两江分界、回忆电感、白鲟影子、城里的嗡鸣和桥上车流随灯熄退去、一股股产卵加卵雪、暖光、卵熄灭（只取 5 声，宁可少） |
| s7 | `s7_beat*`×19、`last_pulse`、`s7_touch` / `s7_settle`、`electro_on`、`lights_out`、`black` | 越来越慢的心跳、落到卵石上、吻搭到石头、最后一次电感随光熄灭、环境一层层变薄 |
| s8 | `verse_c_i`（kind `brush`，带 `end`）×47、`drop`、`wash`（带 `end`）、`fade_black` | 「有鳣有鲔」每一笔、水滴、墨被冲走 |

如果画面组改了命名，导致某一类没匹配上，打印出来的对位来源表里那一类就会变成 `marks`。这时要么在 `events.js` 里用上表的命名，要么改 `cuesheet.py` 里那一类的正则。

## cue 约定（`cuesheet.py`）

- `t` 是同步点。缓冲放在 `t - pre`，`pre` 由音效函数给出，比如游过的 whoosh 的 `pre` 就是它听感上最响的那一刻。
- `p` 里以 `_at` 结尾的参数是绝对时间，以 `_env` 结尾的是 `[(绝对时间, dB)]`；混音时会换算成相对这条 cue 的时间。
- `cut_at`：画面硬切，这条 cue 的尾巴（含混响）在这里 12 ms 收掉。
- `check`：自检方式，取值 `onset` / `slope` / `peak`。
  - `onset`：首次超过自身峰值 −30 dB 的时刻。
  - `slope`：A 计权后 5 ms 包络上升最陡处，低于峰值 30 dB 的部分不算。
  - `peak`：A 计权 120 ms 的 RMS 最大处。
- `sub`：内部事件的自检，比如船的 ship_pass / ship_peak、S7 的 last_pulse。
- `duck_db`：台词处跟着对白侧链闪避的深度，默认值见 `DUCK_SFX`。
- 电平：单次音效先把峰值归一到 −3 dBFS；颗粒类纹理（`norm="lufs"`）归一到 −23 LUFS，峰值最多比响度高 16 dB。然后再加 `gain_db`。

## 声音设计要点

- **环境床**（`sfx/beds.py`）每条都是整段连续渲染，没有循环。自检会在原样、800 Hz 低通、去掉 500 Hz 以下三种滤波状态下检查有没有窄带音高，并检查 1–20 s 内有没有重复（最大 lag 不超过床长的 1/3）。
  - 水下床 `uw_river`：极低的轰鸣、缓慢起伏的水流、偶尔远处的砾石。每一粒砾石走自己的随机共振，所以没有固定音高。S6 叠加城市嗡鸣和桥上车流，S7 一层层变薄。
  - 长卷 `scroll_air`：极淡的江风，鱼淡掉的地方挖出水声的缺口，dam_line 处硬切。
  - 江边白天 `river_day`：风、拍岸、远处的船，用滤波噪声做人群。
  - 夜江 `river_night`：水拍船身；触礁后船身摇晃，拍水变多。
  - 尾声 `paper_room`：几乎只有空气。
- **人声**（`voice/chains.py`）：
  - HER：近、干净，带很短很暗的「内心空间」混响。
  - OLD：音高和共振峰一起降 1.25 个半音，再用 WSOLA 拉回原长，混响更长更暗。
  - F1/F2：室外，带风，有岸边的一次回声。
  - R1：近而低。
  - B1/B2：夜里的船上，引擎在身后（柴油机在音效里）。
- **信标嘀**：1760 Hz 正弦，60 ms，8 ms 升余弦起音。放流后改成水下（滤波 + 多径 + 微混响）。触礁那一刻连尾巴一起断掉。触礁里金属声的分音都避开了 1760 ± 250 Hz。
- **S4 旧信标**：导演手册原本写的是「极远极弱，只出现一次」。后来主导演在 `s4 events.js` 里给了四声 `tag_ping`，一声比一声弱，配 L37「又叫了很久。后来有一天，它不叫了」。现在按画面做成四声，全部极远极弱，电平跟 `amp` 走。要回到只一声，把 `cuesheet.py` 里的 `S4_TAG_PINGS` 改成 `"once"` 即可。

## 试听 / 调单个音效

```bash
.venv/bin/python -m audio.sfx.preview                 # 渲染全部预览到 audio/out/sfx_preview/（wav + 频谱 png）
.venv/bin/python -m audio.sfx.preview crash ship_pass # 只渲染这几个
.venv/bin/python -m audio.sfx.cuesheet               # 只重写 cue 表并打印对位来源
```

`sfx/dsp.py`、`sfx/viz.py`，以及 `build_mix.py` / `voice/chains.py` 的框架，都是从 `/Users/yednc/Dev/movie4/audio/` 复制过来再改的，movie4 本身没有动。
