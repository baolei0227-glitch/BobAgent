#!/usr/bin/env python3
"""
将六宫格南瓜表情包裁切为6个统一尺寸的正方形图片。
基于内容分析，定位每个表情的精确位置。
"""
from PIL import Image
import os

# 源文件路径
src_path = "/Users/baolei/Desktop/BobWork/projects/assets/南瓜表情包-无文字六宫图-1785234477365.png"
# 输出目录
out_dir = "/Users/baolei/Desktop/BobWork/projects/assets/南瓜表情包_裁切"

# 加载原图
img = Image.open(src_path)
W, H = img.size  # 1728 x 2304
print(f"原图尺寸: {W} x {H}")

# 基于内容分析得到的每个表情的实际中心点
# 统一裁切为 720x720 正方形
SIZE = 720
HALF = SIZE // 2  # 360

# 每个表情的中心点 (cx, cy) + 命名
expressions = [
    {
        "cx": 502, "cy": 418,
        "name": "01-OK眨眼得意.png",
        "desc": "OK手势+眨眼+小星星 - 得意/搞怪"
    },
    {
        "cx": 1248, "cy": 422,
        "name": "02-无语烦躁.png",
        "desc": "皱眉+蓝眼泪+螺旋线 - 无语/烦躁"
    },
    {
        "cx": 507, "cy": 1080,
        "name": "03-开心惊喜.png",
        "desc": "眯眼笑+感叹号 - 开心/惊喜"
    },
    {
        "cx": 1231, "cy": 1078,
        "name": "04-愤怒暴怒.png",
        "desc": "生气表情+颤抖线 - 愤怒/暴怒"
    },
    {
        "cx": 540, "cy": 1716,
        "name": "05-爱心喜爱.png",
        "desc": "爱心眼+多颗爱心 - 喜爱/心动"
    },
    {
        "cx": 1225, "cy": 1708,
        "name": "06-万圣节酷酷.png",
        "desc": "戴巫师帽+星星 - 万圣节/酷酷"
    }
]

# 裁切并保存
for exp in expressions:
    cx, cy = exp["cx"], exp["cy"]

    # 计算裁切框，确保不超出原图边界
    left = max(0, cx - HALF)
    top = max(0, cy - HALF)
    right = min(W, left + SIZE)
    bottom = min(H, top + SIZE)

    # 调整以保持SIZE大小（如果一边超出）
    if right - left < SIZE:
        left = max(0, right - SIZE)
    if bottom - top < SIZE:
        top = max(0, bottom - SIZE)
    right = min(W, left + SIZE)
    bottom = min(H, top + SIZE)

    box = (left, top, right, bottom)
    cropped = img.crop(box)

    out_path = os.path.join(out_dir, exp["name"])
    # 高质量PNG输出
    cropped.save(out_path, "PNG", optimize=True, dpi=(300, 300))
    file_size = os.path.getsize(out_path) / 1024
    print(f"✓ {exp['name']}")
    print(f"  描述: {exp['desc']}")
    print(f"  裁切框: {box}  尺寸: {cropped.size}  大小: {file_size:.1f}KB")

print(f"\n完成！共裁切 {len(expressions)} 张 {SIZE}x{SIZE} 正方形图片")
print(f"保存位置: {out_dir}")
