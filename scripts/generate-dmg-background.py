#!/usr/bin/env python3
"""
生成 DMG 安装背景图（660x400）
简洁明亮的 macOS 风格
"""
from PIL import Image, ImageDraw, ImageFont
import os, math

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
LOGO_PATH = os.path.join(PROJECT_DIR, "assets", "BobAgent_logo.png")
OUTPUT_PATH = os.path.join(PROJECT_DIR, "assets", "dmg-background.png")

W, H = 660, 400

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

# ---- 2. 字体 ----
def load_font(size):
    for fp in [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/SFNSDisplay.ttf",
    ]:
        try:
            return ImageFont.truetype(fp, size)
        except Exception:
            continue
    return ImageFont.load_default()

font_title = load_font(38)
font_sub   = load_font(15)
font_small = load_font(12)

# ---- 3. 顶部：Logo + 标题 ----
logo_size = 80
logo_y = 40

# 白色圆形底
circle_r = logo_size // 2 + 6
circle_cx = W // 2
circle_cy = logo_y + logo_size // 2
draw.ellipse(
    [circle_cx - circle_r, circle_cy - circle_r,
     circle_cx + circle_r, circle_cy + circle_r],
    fill=(255, 255, 255),
    outline=(225, 225, 230),
    width=1,
)

# 真实 Logo
if os.path.exists(LOGO_PATH):
    logo = Image.open(LOGO_PATH).convert("RGBA").resize(
        (logo_size, logo_size), Image.LANCZOS)
    img.paste(logo,
              (circle_cx - logo_size // 2, circle_cy - logo_size // 2),
              logo)

logo_bottom = logo_y + logo_size + 12

# 标题
title = "BobAgent"
tb = draw.textbbox((0, 0), title, font=font_title)
draw.text(((W - (tb[2] - tb[0])) // 2, logo_bottom), title,
          fill=(30, 30, 32), font=font_title)

# 副标题
sub = "AI-Powered Canvas Agent"
sb = draw.textbbox((0, 0), sub, font=font_sub)
draw.text(((W - (sb[2] - sb[0])) // 2, logo_bottom + 48), sub,
          fill=(110, 110, 115), font=font_sub)

# ---- 4. 底部：拖拽引导卡片 ----
card_y = 200
card_h = 130
card_x1 = 50
card_x2 = W - 50

# 白色圆角卡片
card_img = Image.new("RGBA", (card_x2 - card_x1, card_h), (0, 0, 0, 0))
cd = ImageDraw.Draw(card_img)
cd.rounded_rectangle(
    [(0, 0), (card_x2 - card_x1 - 1, card_h - 1)],
    radius=14,
    fill=(255, 255, 255, 255),
    outline=(215, 215, 220, 255),
    width=1,
)
img.paste(card_img, (card_x1, card_y), card_img)

# ---- 5. 图标区域 ----
icon_size = 68
icon_y = card_y + 18
left_cx = card_x1 + 120    # App 图标中心
right_cx = card_x2 - 120   # Applications 图标中心

# ---- 左：App 图标（真实 Logo） ----
app_x = left_cx - icon_size // 2
app_y = icon_y

if os.path.exists(LOGO_PATH):
    app_icon = Image.open(LOGO_PATH).convert("RGBA").resize(
        (icon_size, icon_size), Image.LANCZOS)
    # 圆角遮罩
    mask = Image.new("L", (icon_size, icon_size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([(0, 0), (icon_size - 1, icon_size - 1)],
                         radius=14, fill=255)
    img.paste(app_icon, (app_x, app_y), mask)

# App 标签
label = "BobAgent.app"
lb = draw.textbbox((0, 0), label, font=font_small)
draw.text((left_cx - (lb[2] - lb[0]) // 2,
           app_y + icon_size + 4),
          label, fill=(60, 60, 65), font=font_small)

# ---- 右：Applications 文件夹图标 ----
fol_x = right_cx - icon_size // 2
fol_y = icon_y

# 文件夹图标（macOS 风格）
fw, fh = icon_size, icon_size
folder = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
fd = ImageDraw.Draw(folder)
# 主体
fd.rounded_rectangle([(6, 14), (fw - 7, fh - 7)], radius=6,
                     fill=(147, 197, 253, 255))
# 标签
fd.rounded_rectangle([(6, 2), (fw // 2 + 6, 18)], radius=5,
                     fill=(147, 197, 253, 255))
# 折线
fd.line([(6, 18), (6, fh - 7)], fill=(96, 165, 250, 255), width=2)
img.paste(folder, (fol_x, fol_y), folder)

# Applications 标签
label2 = "Applications"
lb2 = draw.textbbox((0, 0), label2, font=font_small)
draw.text((right_cx - (lb2[2] - lb2[0]) // 2,
           fol_y + icon_size + 4),
          label2, fill=(60, 60, 65), font=font_small)

# ---- 6. 箭头（平滑贝塞尔曲线） ----
arrow_color = (59, 130, 246)
arrow_y_mid = icon_y + icon_size // 2
arrow_start = left_cx + icon_size // 2 + 20
arrow_end = right_cx - icon_size // 2 - 20

# 平滑曲线（二次贝塞尔，微微上弯）
ctrl_y = arrow_y_mid - 6
for i in range(arrow_start, arrow_end + 1):
    t = (i - arrow_start) / (arrow_end - arrow_start)
    # 二次贝塞尔: y = (1-t)^2 * y0 + 2*(1-t)*t*ctrl + t^2 * y1
    y = int((1 - t)**2 * arrow_y_mid + 2*(1 - t)*t * ctrl_y + t**2 * arrow_y_mid)
    # 画 3px 粗线
    for j in range(-1, 2):
        px = img.getpixel((i, y + j))
        img.putpixel((i, y + j), arrow_color)

# 箭头头部
head = 12
draw.polygon([
    (arrow_end, arrow_y_mid),
    (arrow_end - head, arrow_y_mid - head),
    (arrow_end - head, arrow_y_mid + head),
], fill=arrow_color)

# ---- 7. 底部说明 ----
bottom = "Drag BobAgent to the Applications folder to install"
bb = draw.textbbox((0, 0), bottom, font=font_small)
draw.text(((W - (bb[2] - bb[0])) // 2, H - 30), bottom,
          fill=(160, 160, 165), font=font_small)

img.save(OUTPUT_PATH, "PNG")
print(f"DMG background saved to: {OUTPUT_PATH}")
