#!/usr/bin/env python3
"""
PDF 文本提取器 — 三级降级策略

Level 1: pypdf   (毫秒级, 零成本) → 原生文本 PDF
Level 2: pdfplumber (快, 零成本) → 表格/复杂排版
Level 3: 返回 empty → 由 Node.js 端触发 sips + VLM OCR

用法:
  python3 pdf_extractor.py <pdf_path> [--max-pages N]

返回 JSON:
  {"success": true, "method": "pypdf", "result": "...", "pages": 3, "total": 5, "quality": 0.85}
"""

import json
import sys
import argparse
import re
from pathlib import Path


# ============================================================
# 质量评分（简化版 — 与 TS 端 quality-scorer 保持一致）
# ============================================================

def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def quality_score(text: str) -> float:
    if not text or len(text.strip()) == 0:
        return 0.0

    cleaned = re.sub(r'\s+', ' ', text).strip()
    length = len(cleaned)
    if length < 20:
        return 0.0

    # 可打印字符占比 (5%)
    printable = len(re.findall(r'[\x20-\x7E\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]', cleaned))
    s1 = clamp(printable / length, 0.7, 1.0)

    # 中文字符占比 (30%)
    chinese = len(re.findall(r'[\u4E00-\u9FFF]', cleaned))
    chinese_ratio = chinese / length
    s2 = clamp(chinese_ratio * 3, 0, 1) if chinese_ratio > 0.01 else 0

    # 英文占比 (20%)
    english = len(re.findall(r'[a-zA-Z]', cleaned))
    english_ratio = english / length
    s3 = clamp(english_ratio, 0, 1) if english_ratio > 0.3 else 0

    # 单字符乱码 (25%)
    singles = len(re.findall(r'(?:^|\s)([a-zA-Z0-9])(?=\s|$)', cleaned))
    garbage_ratio = singles / length
    s4 = 1 - clamp(garbage_ratio * 5, 0, 1)

    # 空白比例 (20%)
    space_ratio = (len(text) - len(text.replace(r'\s', ''))) / max(len(text), 1)
    s5 = 1 - clamp(space_ratio * 2, 0, 1)

    return s1 * 0.05 + s2 * 0.30 + s3 * 0.20 + s4 * 0.25 + s5 * 0.20


# ============================================================
# Level 1: pypdf
# ============================================================

def try_pypdf(pdf_path: str, max_pages: int = 50) -> dict:
    try:
        from pypdf import PdfReader
        reader = PdfReader(pdf_path)
        total_pages = len(reader.pages)
        pages_to_read = min(max_pages, total_pages)

        texts = []
        for i in range(pages_to_read):
            page = reader.pages[i]
            t = page.extract_text()
            if t:
                texts.append(t.strip())

        text = '\n\n'.join(texts)
        q = quality_score(text)

        return {
            'success': True,
            'method': 'pypdf',
            'result': text,
            'pages': pages_to_read,
            'total': total_pages,
            'quality': round(q, 4),
        }
    except Exception as e:
        return {
            'success': False,
            'method': 'pypdf',
            'error': str(e),
        }


# ============================================================
# Level 2: pdfplumber
# ============================================================

def try_pdfplumber(pdf_path: str, max_pages: int = 50) -> dict:
    try:
        import pdfplumber
        with pdfplumber.open(pdf_path) as pdf:
            total_pages = len(pdf.pages)
            pages_to_read = min(max_pages, total_pages)

            texts = []
            for i in range(pages_to_read):
                page = pdf.pages[i]
                t = page.extract_text()
                if t:
                    texts.append(t.strip())

            text = '\n\n'.join(texts)
            q = quality_score(text)

            return {
                'success': True,
                'method': 'pdfplumber',
                'result': text,
                'pages': pages_to_read,
                'total': total_pages,
                'quality': round(q, 4),
            }
    except Exception as e:
        return {
            'success': False,
            'method': 'pdfplumber',
            'error': str(e),
        }


# ============================================================
# 主入口
# ============================================================

def extract_pdf(pdf_path: str, max_pages: int = 50) -> dict:
    path = Path(pdf_path)
    if not path.exists():
        return {'success': False, 'error': f'File not found: {pdf_path}'}

    # Level 1: pypdf
    result = try_pypdf(pdf_path, max_pages)
    if result['success'] and result.get('quality', 0) >= 0.10:
        return result

    # Level 2: pdfplumber
    result = try_pdfplumber(pdf_path, max_pages)
    if result['success'] and result.get('quality', 0) >= 0.10:
        return result

    # 前两级均失败 → 返回 empty，由 Node.js 触发 VLM
    total_pages = result.get('total', 0)
    return {
        'success': False,
        'method': 'empty',
        'result': '',
        'pages': 0,
        'total': total_pages,
        'quality': 0,
        'error': 'Text extraction failed (scanned or image-based PDF)',
        'needs_ocr': True,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='PDF text extractor')
    parser.add_argument('pdf_path', help='Path to PDF file')
    parser.add_argument('--max-pages', type=int, default=50, help='Max pages to extract')
    args = parser.parse_args()

    result = extract_pdf(args.pdf_path, args.max_pages)
    print(json.dumps(result, ensure_ascii=False))
