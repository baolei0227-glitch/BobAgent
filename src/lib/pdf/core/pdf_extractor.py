#!/usr/bin/env python3
"""
PDF 文本提取器 — 逐页分流（P0-6：PageRoute per-page）

PageRoute:
  coordinate_text  该页原生文本可直接用（质量 >= 0.55）
  hybrid           有部分原生文本，但覆盖率不足（0.10 <= q < 0.55），需 OCR 补
  ocr              扫描/矢量文本缺失/质量差（q < 0.10），必须走 OCR
  failed           该页读取失败

整份输出仍保留旧字段（method / success / needs_ocr）以兼容旧 Node 消费者，
新增 page_routes[] 与 page_texts[] 供 extractor.ts 做逐页混合策略。

用法:
  python3 pdf_extractor.py <pdf_path> [--max-pages N]
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


def classify_route(q: float, has_any_text: bool) -> str:
    """逐页路由：根据单页质量给出 page_route。阈值来自专家建议 P0-6。"""
    if not has_any_text:
        return 'ocr'
    if q >= 0.55:
        return 'coordinate_text'
    if q >= 0.10:
        return 'hybrid'
    return 'ocr'


# ============================================================
# 逐页抽取辅助
# ============================================================

def page_quality_tuple(text: str):
    """返回 (是否有任何有效文本, 单页质量分, route)"""
    if not text:
        return False, 0.0, 'ocr'
    stripped = text.strip()
    if len(stripped) == 0:
        return False, 0.0, 'ocr'
    q = quality_score(stripped)
    return True, round(q, 4), classify_route(q, len(stripped) > 0)


# ============================================================
# Level 1: pypdf
# ============================================================

def try_pypdf(pdf_path: str, max_pages: int = 500) -> dict:
    try:
        from pypdf import PdfReader
        reader = PdfReader(pdf_path)
        total_pages = len(reader.pages)
        pages_to_read = min(max_pages, total_pages)

        page_texts = []
        for i in range(pages_to_read):
            page = reader.pages[i]
            t = page.extract_text()
            page_texts.append(t if t else '')

        qs = [page_quality_tuple(t) for t in page_texts]
        routes = [q[2] for q in qs]
        qualities = [q[1] for q in qs]

        text = '\n\n'.join(t for t in page_texts if t)
        overall = quality_score(text) if text else 0.0

        return {
            'success': True,
            'method': 'pypdf',
            'result': text,
            'pages': pages_to_read,
            'total': total_pages,
            'quality': round(overall, 4),
            'page_routes': routes,
            'page_qualities': qualities,
            'page_texts': page_texts,
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

def try_pdfplumber(pdf_path: str, max_pages: int = 500) -> dict:
    try:
        import pdfplumber
        with pdfplumber.open(pdf_path) as pdf:
            total_pages = len(pdf.pages)
            pages_to_read = min(max_pages, total_pages)

            page_texts = []
            for i in range(pages_to_read):
                page = pdf.pages[i]
                t = page.extract_text()
                page_texts.append(t if t else '')

        qs = [page_quality_tuple(t) for t in page_texts]
        routes = [q[2] for q in qs]
        qualities = [q[1] for q in qs]

        text = '\n\n'.join(t for t in page_texts if t)
        overall = quality_score(text) if text else 0.0

        return {
            'success': True,
            'method': 'pdfplumber',
            'result': text,
            'pages': pages_to_read,
            'total': total_pages,
            'quality': round(overall, 4),
            'page_routes': routes,
            'page_qualities': qualities,
            'page_texts': page_texts,
        }
    except Exception as e:
        return {
            'success': False,
            'method': 'pdfplumber',
            'error': str(e),
        }


# ============================================================
# 融合：当 pypdf 有些页 route=ocr/hybrid 时，用 pdfplumber 仅补那些页（hybrid 策略）
# ============================================================

def merge_routes(best: dict, backup: dict) -> dict:
    """best 是主结果（pypdf），backup 是候选（pdfplumber），仅对 ocr 页用 pdfplumber 补一下（若能到 hybrid 则提级）。"""
    if not backup.get('success'):
        return best
    n = len(best.get('page_routes') or [])
    m = len(backup.get('page_routes') or [])
    if n == 0 or m == 0:
        return best

    page_routes = list(best['page_routes'])
    page_qualities = list(best['page_qualities'])
    page_texts = list(best['page_texts'])

    for i in range(min(n, m)):
        if page_routes[i] in ('ocr', 'hybrid'):
            alt_route = backup['page_routes'][i]
            alt_q = backup['page_qualities'][i]
            alt_t = backup['page_texts'][i]
            # 选择该页质量更高者
            if alt_q > page_qualities[i]:
                page_qualities[i] = alt_q
                page_routes[i] = alt_route
                if alt_t:
                    page_texts[i] = alt_t

    text = '\n\n'.join(t for t in page_texts if t)
    overall = quality_score(text) if text else 0.0

    return {
        'success': best['success'],
        'method': 'hybrid',
        'result': text,
        'pages': best['pages'],
        'total': best['total'],
        'quality': round(overall, 4),
        'page_routes': page_routes,
        'page_qualities': page_qualities,
        'page_texts': page_texts,
    }


# ============================================================
# 主入口
# ============================================================

def extract_pdf(pdf_path: str, max_pages: int = 500) -> dict:
    path = Path(pdf_path)
    if not path.exists():
        return {'success': False, 'error': f'File not found: {pdf_path}'}

    # Level 1: pypdf（必须逐页拿到 page_routes）
    result = try_pypdf(pdf_path, max_pages)
    plumber = try_pdfplumber(pdf_path, max_pages)

    # P0-6：把两个后端的逐页结果做逐页融合（hybrid）
    if result['success'] and plumber.get('success'):
        merged = merge_routes(result, plumber)
    elif result['success']:
        merged = result
    elif plumber.get('success'):
        merged = plumber
    else:
        merged = result  # 两个后端都失败

    if not merged.get('success'):
        return {
            'success': False,
            'method': 'empty',
            'result': '',
            'pages': 0,
            'total': result.get('total') or plumber.get('total') or 0,
            'quality': 0,
            'page_routes': [],
            'page_qualities': [],
            'page_texts': [],
            'error': 'Text extraction failed',
            'needs_ocr': True,
        }

    routes = merged.get('page_routes') or []
    needs_ocr_any = any(r in ('ocr', 'hybrid') for r in routes)
    all_ocr = len(routes) > 0 and all(r == 'ocr' for r in routes)

    # 兼容旧 needs_ocr：全页都要 OCR 时标 needs_ocr=true（保持 old contract 语义）
    merged['needs_ocr'] = all_ocr
    merged['has_scanned_pages'] = needs_ocr_any

    # 若融合后整份质量仍低于阈值且有需要 OCR 的页：保留整体失败语义（旧消费者 fallback）
    if all_ocr:
        merged['success'] = False
        merged['error'] = 'All pages are scanned / image-based: needs OCR'
    return merged


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='PDF text extractor (per-page routing)')
    parser.add_argument('pdf_path', help='Path to PDF file')
    parser.add_argument('--max-pages', type=int, default=500, help='Max pages to extract')
    args = parser.parse_args()

    result = extract_pdf(args.pdf_path, args.max_pages)
    print(json.dumps(result, ensure_ascii=False))
