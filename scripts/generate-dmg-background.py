#!/usr/bin/env python3
"""
生成 DMG 安装背景图（660x440）— 极简版
淡色渐变背景 + 中央拖拽箭头 + 底部安装提示
（图标由 Finder 显示真实文件，不绘制）
"""
from PIL import Image, ImageDraw, ImageFont
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
OUTPUT_PATH = os.path.join(PROJECT_DIR, "assets", "dmg-background.png")

W, H = 660, 440

# ---- 1. 背景：从上到下的微妙线性渐变 ----
img = Image.new("RGB", (W, H))
for y in range(H):
    ratio = y / H
    r = int(248 + ratio * 6)   # 248 -> 254
    g = int(248 + ratio * 6)   # 248 -> 254
    b = int(250 + ratio * 5)   # 250 -> 255
    for x in range(W):
        img.putpixel((x, y), (r, g, b))

draw = ImageDraw.Draw(img)

# ---- 2. 中央箭头：位于两个 Finder 图标（中心 x≈250 / 410, y≈150）之间 ----
arrow_color = (59, 130, 246)
arrow_y_mid = 150
arrow_start = 294
arrow_end = 366

# 平滑曲线（二次贝塞尔，微微上弯）
ctrl_y = arrow_y_mid - 6
for i in range(arrow_start, arrow_end + 1):
    t = (i - arrow_start) / (arrow_end - arrow_start)
    y = int((1 - t)**2 * arrow_y_mid + 2*(1 - t)*t * ctrl_y + t**2 * arrow_y_mid)
    for j in range(-1, 2):
        img.putpixel((i, y + j), arrow_color)

# 箭头头部
head = 12
draw.polygon([
    (arrow_end, arrow_y_mid),
    (arrow_end - head, arrow_y_mid - head),
    (arrow_end - head, arrow_y_mid + head),
], fill=arrow_color)

# ---- 3. 底部分隔线 ----
divider_y = 250
line_color = (220, 220, 225)
for x in range(60, W - 60):
    img.putpixel((x, divider_y), line_color)

# ---- 4. 底部安装提示文字 ----
font_paths = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
]
font = None
font_small = None
font_tiny = None
for fp in font_paths:
    if os.path.exists(fp):
        try:
            font = ImageFont.truetype(fp, 15)
            font_small = ImageFont.truetype(fp, 13)
            font_tiny = ImageFont.truetype(fp, 11)
            break
        except Exception:
            continue
if font is None:
    font = ImageFont.load_default()
    font_small = ImageFont.load_default()
    font_tiny = ImageFont.load_default()

# 主提示（蓝色，突出）
hint_main = "If Apple blocks the app:"
color_blue = (59, 130, 246)
bbox1 = draw.textbbox((0, 0), hint_main, font=font)
w1 = bbox1[2] - bbox1[0]
draw.text(((W - w1) // 2, 270), hint_main, fill=color_blue, font=font)

# 方法 1：终端命令（推荐，加粗黑）
hint_1 = "Run in Terminal (recommended):"
color_black = (60, 60, 65)
bbox_a = draw.textbbox((0, 0), hint_1, font=font_small)
wa = bbox_a[2] - bbox_a[0]
draw.text(((W - wa) // 2, 295), hint_1, fill=color_black, font=font_small)

# 命令行（浅灰底框）
hint_cmd = "xattr -dr com.apple.quarantine /Applications/BobWork.app"
bbox_c = draw.textbbox((0, 0), hint_cmd, font=font_tiny)
wc = bbox_c[2] - bbox_c[0]
hc = bbox_c[3] - bbox_c[1]
cmd_x = (W - wc) // 2 - 10
cmd_y = 318
cmd_w = wc + 20
cmd_h = hc + 10
draw.rounded_rectangle([cmd_x, cmd_y, cmd_x + cmd_w, cmd_y + cmd_h], radius=5, fill=(245, 245, 248), outline=(210, 210, 215))
draw.text((cmd_x + 10, cmd_y + 5), hint_cmd, fill=(100, 100, 110), font=font_tiny)

# 提示右键打开在新系统失效
hint_note = "Right-click Open no longer works on macOS 15+"
color_note = (200, 80, 80)
bbox_n = draw.textbbox((0, 0), hint_note, font=font_tiny)
wn = bbox_n[2] - bbox_n[0]
draw.text(((W - wn) // 2, 342), hint_note, fill=color_note, font=font_tiny)

img.save(OUTPUT_PATH, "PNG")
print(f"DMG background saved to: {OUTPUT_PATH}")
