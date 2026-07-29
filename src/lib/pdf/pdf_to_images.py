#!/usr/bin/env python3
"""
PDF 转高质量图片

将扫描件 PDF 的每一页转换为高分辨率 PNG，供视觉模型 OCR 使用。

策略：
  1. pypdf 逐页拆分（纯 Python，零依赖）
  2. macOS sips 渲染为高分辨率 PNG（200 DPI）
  3. 返回图片路径列表

用法:
  python3 pdf_to_images.py <pdf_path> --dpi 200 --max-pages 5

返回 JSON:
  {"success": true, "images": ["/tmp/.../page_0.png", ...], "total_pages": 5, "rendered": 3}
"""

import json
import sys
import os
import tempfile
import subprocess
import argparse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed


def render_page(page_pdf: str, output_png: str, dpi: int = 200) -> bool:
    """
    用 macOS sips 将单页 PDF 渲染为 PNG。
    A4 @ 200 DPI ≈ 1654 x 2339 px，质量足够 OCR。
    """
    # A4 宽度约 8.27 inch * dpi
    width = int(8.27 * dpi)
    try:
        subprocess.run(
            [
                'sips',
                '-s', 'format', 'png',
                '--resampleWidth', str(width),
                page_pdf,
                '--out', output_png,
            ],
            capture_output=True,
            timeout=30,
            check=True,
        )
        return os.path.exists(output_png)
    except Exception:
        return False


def pdf_to_images(pdf_path: str, dpi: int = 200, max_pages: int = 50) -> dict:
    """
    主入口：将 PDF 转为高质量图片列表。
    """
    if not os.path.exists(pdf_path):
        return {'success': False, 'error': f'File not found: {pdf_path}'}

    try:
        from pypdf import PdfReader
        reader = PdfReader(pdf_path)
        total_pages = len(reader.pages)
        pages_to_render = min(max_pages, total_pages)

        tmp_dir = tempfile.mkdtemp(prefix='bobagent-pdf-img-')

        # 先拆分所有页面为独立 PDF
        page_pdfs = []
        from pypdf import PdfWriter
        for i in range(pages_to_render):
            writer = PdfWriter()
            writer.add_page(reader.pages[i])
            page_pdf = os.path.join(tmp_dir, f'page_{i}.pdf')
            with open(page_pdf, 'wb') as f:
                writer.write(f)
            page_pdfs.append((i, page_pdf))

        # 并行渲染为 PNG（并发 4，macOS sips 是 I/O 密集型）
        images = [None] * len(page_pdfs)
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = {}
            for i, page_pdf in page_pdfs:
                output_png = os.path.join(tmp_dir, f'page_{i}.png')
                futures[executor.submit(render_page, page_pdf, output_png, dpi)] = i

            for future in as_completed(futures):
                idx = futures[future]
                output_png = os.path.join(tmp_dir, f'page_{idx}.png')
                if future.result():
                    images[idx] = output_png

        images = [img for img in images if img is not None]

        return {
            'success': len(images) > 0,
            'images': images,
            'total_pages': total_pages,
            'rendered': len(images),
            'dpi': dpi,
            'tmp_dir': tmp_dir,
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='PDF to high-quality images')
    parser.add_argument('pdf_path', help='Path to PDF file')
    parser.add_argument('--dpi', type=int, default=200, help='Output DPI (default: 200)')
    parser.add_argument('--max-pages', type=int, default=50, help='Max pages to render')
    args = parser.parse_args()

    result = pdf_to_images(args.pdf_path, args.dpi, args.max_pages)
    print(json.dumps(result, ensure_ascii=False))
