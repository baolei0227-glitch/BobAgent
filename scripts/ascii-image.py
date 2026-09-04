#!/usr/bin/env python3
"""
ASCII 图片分析工具 — 无依赖（仅 PIL），用于快速"看"截图/图片的布局结构。

用法:
  python3 ascii-image.py <image>            # 默认：ASCII 轮廓图
  python3 ascii-image.py <image> --bands    # 逐行扫描，列出内容带与空白带（量化间距）
  python3 ascii-image.py <image> --color    # 分区域统计主色调
  python3 ascii-image.py <image> --all      # 三项全部输出

说明：
  - ASCII 图：把图片降采样后按亮度映射为字符（# 深 > + 中 > . 浅 > 空格 白/背景），
    用于观察轮廓、空白区域、元素分布。
  - bands：每行统计"与背景差异超过阈值的像素数"，找出内容带和纯空白带，
    能精确量化"文字与图片之间的空隙"这类布局问题。
  - color：对指定区域输出主色调（rgb 量化到 32 级），用于区分 UI 元素类型。
"""

import argparse
import collections
import sys

from PIL import Image


def load(path: str):
    return Image.open(path).convert('RGB')


def ascii_view(img, cols: int = 100, step_y: int = 4, dark: int = 130, mid: int = 190, light: int = 240):
    """降采样 + 亮度 → 字符。默认每 4 行合并一行，每块取最暗像素（线条不易漏掉）。"""
    w, h = img.size
    gray = img.convert('L')
    step_x = max(1, w // cols)
    out = []
    for y0 in range(0, h, step_y):
        line = []
        for x0 in range(0, w, step_x):
            vals = [
                gray.getpixel((x, y))
                for y in range(y0, min(y0 + step_y, h))
                for x in range(x0, min(x0 + step_x, w))
            ]
            m = min(vals)
            line.append('#' if m < dark else ('+' if m < mid else ('.' if m < light else ' ')))
        out.append(f'{y0:6d} ' + ''.join(line))
    return '\n'.join(out)


def _dominant_bg(img, bins: int = 16):
    """背景色 = 全图最常见的量化颜色（缩小采样加速），比左上角像素更稳健。"""
    w, h = img.size
    small = img.resize((min(w, 80), max(1, h * 80 // max(w, 1))))
    counts = collections.Counter()
    for y in range(small.size[1]):
        for x in range(small.size[0]):
            r, g, b = small.getpixel((x, y))
            counts[(r // bins * bins, g // bins * bins, b // bins * bins)] += 1
    return counts.most_common(1)[0][0]


def bands(img, thr: int = 25, min_rows: int = 3):
    """逐行扫描：找出内容带与空白带，量化各带高度与带间空隙。"""
    w, h = img.size
    px = img.load()
    bg = _dominant_bg(img)  # 以全图众数颜色作为背景参考
    rows = []
    for y in range(h):
        cnt = 0
        for x in range(0, w, 4):
            r, g, b = px[x, y]
            if max(abs(r - bg[0]), abs(g - bg[1]), abs(b - bg[2])) > thr:
                cnt += 1
        rows.append(cnt)

    bands_list = []
    in_band = False
    for y, c in enumerate(rows):
        if c > 2 and not in_band:
            start, in_band = y, True
        elif c <= 2 and in_band:
            if y - start >= min_rows:
                bands_list.append((start, y - 1))
            in_band = False
    if in_band:
        bands_list.append((start, h - 1))

    lines = [f'image: {w}x{h}  bg={bg}']
    for i, (a, b) in enumerate(bands_list):
        if i > 0:
            lines.append(f'  gap before band {i}: {a - bands_list[i-1][1] - 1}px')
        lines.append(f'band {i}: y={a}..{b} h={b - a + 1}')
    return '\n'.join(lines)


def colors(img, regions: list, bins: int = 32):
    """对给定 y 区间输出主色调分布（rgb 量化到 bins 级）。regions: [(y0,y1,label)]"""
    w, h = img.size
    px = img.load()
    out = []
    for y0, y1, label in regions:
        c = collections.Counter()
        for y in range(y0, min(y1, h)):
            for x in range(w):
                r, g, b = px[x, y]
                c[(r // bins * bins, g // bins * bins, b // bins * bins)] += 1
        total = sum(c.values())
        top = c.most_common(6)
        out.append(f'[{label}] y={y0}-{y1}:')
        for col, n in top:
            out.append(f'   rgb{col} n={n} ({100 * n // max(total, 1)}%)')
    return '\n'.join(out)


def main():
    ap = argparse.ArgumentParser(description='ASCII 图片布局分析工具')
    ap.add_argument('image', help='图片路径')
    ap.add_argument('--cols', type=int, default=100, help='ASCII 列数（默认 100）')
    ap.add_argument('--step', type=int, default=4, help='ASCII 纵向合并行数（默认 4）')
    ap.add_argument('--bands', action='store_true', help='输出内容带/空白带分析')
    ap.add_argument('--color', action='store_true', help='输出区域主色调统计')
    ap.add_argument('--regions', default='', help='--color 的区域列表，逗号分隔 y0:y1:标签，如 0:100:title,100:300:image')
    ap.add_argument('--all', action='store_true', help='全部输出')
    args = ap.parse_args()

    img = load(args.image)

    if args.bands or args.all:
        print('===== bands =====')
        print(bands(img))
        print()

    if args.color or args.all:
        print('===== colors =====')
        regions = []
        for part in (args.regions or '').split(','):
            if not part.strip():
                continue
            y0, y1, label = part.split(':')
            regions.append((int(y0), int(y1), label))
        print(colors(img, regions or [(0, img.size[1], 'full')]))
        print()

    print('===== ascii =====')
    print(ascii_view(img, cols=args.cols, step_y=args.step))


if __name__ == '__main__':
    main()
