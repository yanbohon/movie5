"""扫描剧本与源码里出现的所有字符，把字体裁成只含这些字的 woff2，放进 public/fonts。

改了任何画面文字后重跑：.venv/bin/python tools/subset_fonts.py
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "fonts-src"
OUT = ROOT / "public/fonts"
OUT.mkdir(parents=True, exist_ok=True)

chars = set()
for pattern in ("script/*.json", "script/*.md", "src/**/*.js"):
    for f in ROOT.glob(pattern):
        chars.update(f.read_text(encoding="utf-8"))
# ASCII 可见字符 + 常用全角标点 + 一些排版符号
chars.update(chr(c) for c in range(0x20, 0x7F))
chars.update("，。！？：；、“”‘’（）《》〈〉「」『』【】…—～·￥％＋－×÷＝≈≠≤≥←→↑↓✓✕⚠●○■□▶▸◆◇★☆")
chars = {c for c in chars if c.isprintable() and c not in "\t\r\n"}
text_file = ROOT / "fonts-src/_chars.txt"
text_file.write_text("".join(sorted(chars)), encoding="utf-8")
cjk = sum(1 for c in chars if "一" <= c <= "鿿")
print(f"{len(chars)} chars ({cjk} CJK)")

FONTS = {
    "NotoSansSC.ttf": "sans.woff2",
    "NotoSerifSC.ttf": "serif.woff2",
    "LXGWWenKai.ttf": "kai.woff2",
    "JetBrainsMono.ttf": "mono.woff2",
}
for src, dst in FONTS.items():
    cmd = [
        str(ROOT / ".venv/bin/pyftsubset"), str(SRC / src),
        f"--text-file={text_file}", "--flavor=woff2", f"--output-file={OUT / dst}",
        "--layout-features=*", "--no-hinting", "--desubroutinize",
    ]
    subprocess.run(cmd, check=True)
    print(dst, (OUT / dst).stat().st_size // 1024, "KB")
