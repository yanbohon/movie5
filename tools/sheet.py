"""把若干帧拼成带时间码的联系表。用法: sheet.py out.png cols file1:t1 file2:t2 ..."""
import sys
from PIL import Image, ImageDraw, ImageFont

out, cols = sys.argv[1], int(sys.argv[2])
items = [a.rsplit(":", 1) for a in sys.argv[3:]]
tw, th = 640, 360
rows = (len(items) + cols - 1) // cols
sheet = Image.new("RGB", (cols * tw, rows * th), "black")
font = ImageFont.truetype("fonts-src/JetBrainsMono.ttf", 20)
for i, (f, t) in enumerate(items):
    im = Image.open(f).convert("RGB").resize((tw, th), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 90, 28], fill=(0, 0, 0))
    d.text((6, 3), t, fill=(255, 255, 255), font=font)
    sheet.paste(im, ((i % cols) * tw, (i // cols) * th))
sheet.save(out)
