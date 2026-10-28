"""《鲔》调式、律制与主题动机。

调式：D 羽调式五声音阶（F 宫系统）：D F G A C 为骨干，E、Bb 只作经过。
古琴正调定弦恰好就是这套音：一弦到七弦 = C2 D2 F2 G2 A2 C3 D3。

律制：三分损益（纯五度相生），以 A4 = 440 Hz 为锚。
- 古琴本来就用泛音调弦（纯五度、纯四度），全片所有乐器（弦乐、哼唱、pad、玻璃、sub）都用同一张律表，
  彼此之间不会有 2–8 音分的「打架」拍频。
- 以 A 为锚是为了跟音效组的信标「嘀」（1760 Hz = A6）严格协和。
相对十二平均律的偏移（音分）：A 0，E +1.96，D -1.96，G -3.91，C -5.87，F -7.82，Bb -9.78。

主题动机（5 个音，可以唱，第 5 个音回到主音 D）：
    D3  A3  G3  F3  |  D3
    1   5   4   b3  |  1
上行五度是「喊出去」，然后一级一级落回来；第 4 个音 F 离家只差一步。
她死去时只弹前 4 个音，第 5 个音永远不来。
"""
import math
import numpy as np

_PC = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}

# 五度链上距 A 的位置 n（向上 n 个纯五度）-> 相对平均律的音分偏移 n * 1.955
_PYTH_CENTS = {}
for _n in range(-6, 6):
    _PYTH_CENTS[(9 + 7 * _n) % 12] = _n * (1200.0 * math.log2(1.5) - 700.0)


def nm(s):
    """音名 -> MIDI（C4 = 60），支持 # 与 b。整数原样返回。"""
    if isinstance(s, (int, np.integer)):
        return int(s)
    s = s.strip()
    pc = _PC[s[0].upper()]
    i = 1
    while i < len(s) and s[i] in '#b':
        pc += 1 if s[i] == '#' else -1
        i += 1
    return 12 * (int(s[i:]) + 1) + pc


def nms(*names):
    out = []
    for n in names:
        out.extend([nm(x) for x in n.split()] if isinstance(n, str) else [nm(n)])
    return out


def cents_off(m):
    return _PYTH_CENTS[int(round(m)) % 12]


def hz(m):
    """音名或 MIDI -> 频率（三分损益律，A4 = 440）。允许小数 MIDI（按最近音级取律偏移）。"""
    m = nm(m) if isinstance(m, str) else m
    return 440.0 * 2.0 ** ((m - 69.0) / 12.0) * 2.0 ** (cents_off(m) / 1200.0)


# 主题（音名）
THEME = ['D3', 'A3', 'G3', 'F3', 'D3']
THEME_4 = THEME[:4]

# 古琴正调：一弦到七弦
QIN_OPEN = ['C2', 'D2', 'F2', 'G2', 'A2', 'C3', 'D3']

# 徽位（距岳山的弦长比例）：一徽 1/8 … 十三徽 7/8
HUI = {1: 1 / 8, 2: 1 / 6, 3: 1 / 5, 4: 1 / 4, 5: 1 / 3, 6: 2 / 5, 7: 1 / 2, 8: 3 / 5, 9: 2 / 3, 10: 3 / 4,
       11: 4 / 5, 12: 5 / 6, 13: 7 / 8}
