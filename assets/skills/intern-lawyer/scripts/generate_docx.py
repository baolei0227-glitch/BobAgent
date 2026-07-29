#!/usr/bin/env python3
"""
generate_docx.py — 将 Markdown 法律分析报告转换为 .docx 文件

排版标准：
- 全文仿宋字体
- 正文小四号 (12pt)
- 标题三号 (16pt)
- 行间距 1.5 倍

用法:
    python3 generate_docx.py <input.md> [output.docx]

依赖:
    pip install python-docx markdown
"""

import sys
import os
import re
from pathlib import Path

try:
    from docx import Document
    from docx.shared import Pt, Cm, Inches
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
    from docx.oxml.ns import qn
except ImportError:
    print("ERROR: python-docx not installed. Run: pip install python-docx", file=sys.stderr)
    sys.exit(1)


FONT_NAME = "仿宋"
FONT_NAME_ASCII = "FangSong"
BODY_SIZE = Pt(12)       # 小四号
HEADING_SIZE = Pt(16)    # 三号
LINE_SPACING = 1.5


def set_font(run, size=None, bold=False):
    """Set font for a run, handling both ASCII and East Asian text."""
    run.font.name = FONT_NAME_ASCII
    run.font.size = size or BODY_SIZE
    run.font.bold = bold
    r = run._element
    rPr = r.find(qn('w:rPr'))
    if rPr is None:
        rPr = r.makeelement(qn('w:rPr'), {})
        r.insert(0, rPr)
    rFonts = rPr.find(qn('w:rFonts'))
    if rFonts is None:
        rFonts = rPr.makeelement(qn('w:rFonts'), {})
        rPr.append(rFonts)
    rFonts.set(qn('w:eastAsia'), FONT_NAME)
    rFonts.set(qn('w:ascii'), FONT_NAME_ASCII)
    rFonts.set(qn('w:hAnsi'), FONT_NAME_ASCII)


def set_paragraph_format(paragraph, size=None):
    """Set paragraph formatting: line spacing and font size."""
    pf = paragraph.paragraph_format
    pf.line_spacing = LINE_SPACING
    pf.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
    pf.space_before = Pt(0)
    pf.space_after = Pt(6)


def add_heading(doc, text, level=1):
    """Add a heading with proper formatting."""
    p = doc.add_paragraph()
    set_paragraph_format(p)
    run = p.add_run(text)
    set_font(run, size=HEADING_SIZE, bold=True)
    if level == 1:
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    return p


def add_body(doc, text, bold=False):
    """Add a body paragraph."""
    p = doc.add_paragraph()
    set_paragraph_format(p)
    run = p.add_run(text)
    set_font(run, bold=bold)
    return p


def add_table(doc, headers, rows):
    """Add a formatted table from headers and rows."""
    table = doc.add_table(rows=1 + len(rows), cols=len(headers))
    table.style = 'Table Grid'

    for i, header in enumerate(headers):
        cell = table.rows[0].cells[i]
        cell.text = ""
        p = cell.paragraphs[0]
        set_paragraph_format(p)
        run = p.add_run(header.strip())
        set_font(run, bold=True)

    for row_idx, row in enumerate(rows):
        for col_idx, cell_text in enumerate(row):
            if col_idx < len(headers):
                cell = table.rows[row_idx + 1].cells[col_idx]
                cell.text = ""
                p = cell.paragraphs[0]
                set_paragraph_format(p)
                run = p.add_run(cell_text.strip())
                set_font(run)

    doc.add_paragraph()
    return table


def parse_markdown(md_text):
    """Parse markdown into structured elements."""
    elements = []
    lines = md_text.split('\n')
    i = 0
    in_code_block = False
    code_lines = []

    while i < len(lines):
        line = lines[i]

        if line.strip().startswith('```'):
            if in_code_block:
                elements.append(('code', '\n'.join(code_lines)))
                code_lines = []
                in_code_block = False
            else:
                in_code_block = True
                code_lines = []
            i += 1
            continue

        if in_code_block:
            code_lines.append(line)
            i += 1
            continue

        stripped = line.strip()

        if stripped.startswith('# '):
            elements.append(('h1', stripped[2:].strip()))
        elif stripped.startswith('## '):
            elements.append(('h2', stripped[3:].strip()))
        elif stripped.startswith('### '):
            elements.append(('h3', stripped[4:].strip()))
        elif stripped.startswith('---'):
            elements.append(('hr', ''))
        elif stripped.startswith('|') and '|' in stripped[1:]:
            table_lines = [stripped]
            j = i + 1
            while j < len(lines) and lines[j].strip().startswith('|'):
                table_lines.append(lines[j].strip())
                j += 1
            if len(table_lines) >= 2:
                headers = [c.strip() for c in table_lines[0].split('|') if c.strip()]
                rows = []
                for tl in table_lines[2:]:
                    row = [c.strip() for c in tl.split('|') if c.strip()]
                    rows.append(row)
                elements.append(('table', (headers, rows)))
            i = j
            continue
        elif stripped.startswith('- '):
            items = []
            while i < len(lines) and lines[i].strip().startswith('- '):
                items.append(lines[i].strip()[2:].strip())
                i += 1
            elements.append(('list', items))
            continue
        elif stripped:
            elements.append(('text', stripped))

        i += 1

    if in_code_block and code_lines:
        elements.append(('code', '\n'.join(code_lines)))

    return elements


def convert(md_path, docx_path):
    """Convert markdown file to docx."""
    with open(md_path, 'r', encoding='utf-8') as f:
        md_text = f.read()

    if md_text.startswith('---'):
        parts = md_text.split('---', 2)
        if len(parts) >= 3:
            md_text = parts[2].strip()

    doc = Document()

    style = doc.styles['Normal']
    style.font.name = FONT_NAME_ASCII
    style.font.size = BODY_SIZE
    style.element.rPr.rFonts.set(qn('w:eastAsia'), FONT_NAME)

    elements = parse_markdown(md_text)

    for elem in elements:
        etype = elem[0]
        edata = elem[1]

        if etype == 'h1':
            add_heading(doc, edata, level=1)
        elif etype == 'h2':
            add_heading(doc, edata, level=2)
        elif etype == 'h3':
            add_heading(doc, edata, level=3)
        elif etype == 'text':
            add_body(doc, edata)
        elif etype == 'list':
            for item in edata:
                p = doc.add_paragraph(style='List Bullet')
                set_paragraph_format(p)
                run = p.add_run(item)
                set_font(run)
        elif etype == 'table':
            headers, rows = edata
            add_table(doc, headers, rows)
        elif etype == 'code':
            p = doc.add_paragraph()
            set_paragraph_format(p)
            run = p.add_run(edata)
            set_font(run)
            run.font.name = 'Courier New'
            run.font.size = Pt(10)
        elif etype == 'hr':
            p = doc.add_paragraph()
            p.add_run('─' * 40)

    doc.save(docx_path)
    print(f"OK: {docx_path}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 generate_docx.py <input.md> [output.docx]", file=sys.stderr)
        sys.exit(1)

    md_path = sys.argv[1]
    if not os.path.exists(md_path):
        print(f"ERROR: File not found: {md_path}", file=sys.stderr)
        sys.exit(1)

    if len(sys.argv) >= 3:
        docx_path = sys.argv[2]
    else:
        docx_path = str(Path(md_path).with_suffix('.docx'))

    convert(md_path, docx_path)
