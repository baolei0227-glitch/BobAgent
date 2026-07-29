#!/usr/bin/env python3
"""
generate_docx.py — 将 Markdown 法律文书转换为 .docx 文件

排版标准（法律文书专用）：
- 标题：黑体，H1 居中二号（22pt），H2 三号（16pt），H3 四号（14pt）
- 正文：仿宋小四号（12pt），行间距 1.5 倍，首行缩进 2 字符
- 落款：右对齐
- 表格：网格样式，表头蓝灰色底纹，五号（10.5pt）
- 页面：A4，页边距 2.54cm

用法:
    python3 generate_docx.py <input.md> [output.docx]

依赖:
    pip install python-docx
"""

import sys
import os
import re
from pathlib import Path

try:
    from docx import Document
    from docx.shared import Pt, Cm, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
except ImportError:
    print("ERROR: python-docx not installed. Run: pip install python-docx", file=sys.stderr)
    sys.exit(1)


# ── 字体与排版常量 ──────────────────────────────────────────
HEADING_FONT = "黑体"
HEADING_FONT_ASCII = "SimHei"
BODY_FONT = "仿宋"
BODY_FONT_ASCII = "FangSong"

H1_SIZE = Pt(22)          # 二号
H2_SIZE = Pt(16)          # 三号
H3_SIZE = Pt(14)          # 四号
BODY_SIZE = Pt(12)        # 小四号
TABLE_SIZE = Pt(10.5)     # 五号

LINE_SPACING = 1.5
FIRST_LINE_INDENT_CHARS = 2  # 首行缩进 2 字符

# 表头蓝灰色底纹
HEADER_SHADING_COLOR = "8FAADC"  # 蓝灰色

# 落款关键词（用于自动右对齐检测）
SIGNATURE_KEYWORDS = [
    "具状人", "答辩人", "上诉人", "申请人", "委托人",
    "甲方", "乙方", "丙方", "丁方",
    "发函", "署名人", "签名", "盖章",
    "日期：", "年  月  日", "年  月  日",
]


def set_font(run, font_name=BODY_FONT, font_ascii=BODY_FONT_ASCII, size=None, bold=False):
    """Set font for a run, handling both ASCII and East Asian text."""
    run.font.name = font_ascii
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
    rFonts.set(qn('w:eastAsia'), font_name)
    rFonts.set(qn('w:ascii'), font_ascii)
    rFonts.set(qn('w:hAnsi'), font_ascii)


def set_paragraph_format(paragraph, line_spacing=LINE_SPACING, space_before=0, space_after=6,
                         first_line_indent=False, alignment=None):
    """Set paragraph formatting."""
    pf = paragraph.paragraph_format
    pf.line_spacing = line_spacing
    pf.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
    pf.space_before = Pt(space_before)
    pf.space_after = Pt(space_after)
    if first_line_indent:
        # 首行缩进 2 字符 ≈ 2 * font_size
        pf.first_line_indent = Pt(BODY_SIZE.pt * FIRST_LINE_INDENT_CHARS)
    if alignment is not None:
        paragraph.alignment = alignment


def set_cell_shading(cell, color_hex):
    """Set background shading color for a table cell."""
    tcPr = cell._element.get_or_add_tcPr()
    shading = OxmlElement('w:shd')
    shading.set(qn('w:val'), 'clear')
    shading.set(qn('w:color'), 'auto')
    shading.set(qn('w:fill'), color_hex)
    tcPr.append(shading)


def is_signature_line(text):
    """Detect if a line is a signature/date line that should be right-aligned."""
    stripped = text.strip()
    # 检测落款关键词
    for kw in SIGNATURE_KEYWORDS:
        if kw in stripped:
            return True
    # 检测以大量空格开头的行（模板中的右对齐效果）
    if stripped.startswith("  ") and len(stripped) > 10:
        return True
    return False


def add_heading(doc, text, level=1):
    """Add a heading with proper formatting."""
    p = doc.add_paragraph()
    size_map = {1: H1_SIZE, 2: H2_SIZE, 3: H3_SIZE}
    size = size_map.get(level, H3_SIZE)
    set_paragraph_format(p, space_before=12, space_after=6, first_line_indent=False)
    run = p.add_run(text)
    set_font(run, font_name=HEADING_FONT, font_ascii=HEADING_FONT_ASCII,
             size=size, bold=True)
    if level == 1:
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    return p


def add_body(doc, text, bold=False):
    """Add a body paragraph with first-line indent."""
    p = doc.add_paragraph()
    set_paragraph_format(p, first_line_indent=True)
    run = p.add_run(text)
    set_font(run, bold=bold)
    return p


def add_signature(doc, text):
    """Add a right-aligned signature/date line (no first-line indent)."""
    p = doc.add_paragraph()
    set_paragraph_format(p, first_line_indent=False, alignment=WD_ALIGN_PARAGRAPH.RIGHT)
    # 去除前导空格（模板中用空格模拟右对齐）
    clean_text = text.strip()
    run = p.add_run(clean_text)
    set_font(run)
    return p


def add_table(doc, headers, rows):
    """Add a formatted table with blue-gray header shading."""
    table = doc.add_table(rows=1 + len(rows), cols=len(headers))
    table.style = 'Table Grid'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER

    # 表头：蓝灰色底纹 + 五号字
    for i, header in enumerate(headers):
        cell = table.rows[0].cells[i]
        set_cell_shading(cell, HEADER_SHADING_COLOR)
        cell.text = ""
        p = cell.paragraphs[0]
        set_paragraph_format(p, first_line_indent=False, space_after=0)
        run = p.add_run(header.strip())
        set_font(run, size=TABLE_SIZE, bold=True)

    # 数据行：五号字
    for row_idx, row in enumerate(rows):
        for col_idx, cell_text in enumerate(row):
            if col_idx < len(headers):
                cell = table.rows[row_idx + 1].cells[col_idx]
                cell.text = ""
                p = cell.paragraphs[0]
                set_paragraph_format(p, first_line_indent=False, space_after=0)
                run = p.add_run(cell_text.strip())
                set_font(run, size=TABLE_SIZE)

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

        # 代码块处理
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

        # 跳过空行
        if not stripped:
            i += 1
            continue

        # 标题
        if stripped.startswith('# '):
            elements.append(('h1', stripped[2:].strip()))
        elif stripped.startswith('## '):
            elements.append(('h2', stripped[3:].strip()))
        elif stripped.startswith('### '):
            elements.append(('h3', stripped[4:].strip()))
        elif stripped.startswith('#### '):
            elements.append(('h4', stripped[5:].strip()))
        # 分割线
        elif stripped.startswith('---'):
            elements.append(('hr', ''))
        # 表格
        elif stripped.startswith('|') and '|' in stripped[1:]:
            table_lines = [stripped]
            j = i + 1
            while j < len(lines) and lines[j].strip().startswith('|'):
                table_lines.append(lines[j].strip())
                j += 1
            if len(table_lines) >= 2:
                headers = [c.strip() for c in table_lines[0].split('|') if c.strip()]
                rows = []
                for tl in table_lines[2:]:  # 跳过分隔行
                    row = [c.strip() for c in tl.split('|') if c.strip()]
                    rows.append(row)
                elements.append(('table', (headers, rows)))
            i = j
            continue
        # 无序列表
        elif stripped.startswith('- ') or stripped.startswith('* '):
            items = []
            while i < len(lines) and (lines[i].strip().startswith('- ') or lines[i].strip().startswith('* ')):
                items.append(lines[i].strip()[2:].strip())
                i += 1
            elements.append(('list', items))
            continue
        # 有序列表
        elif re.match(r'^\d+\.\s', stripped):
            items = []
            while i < len(lines) and re.match(r'^\d+\.\s', lines[i].strip()):
                items.append(re.sub(r'^\d+\.\s*', '', lines[i].strip()))
                i += 1
            elements.append(('olist', items))
            continue
        # 落款行检测
        elif is_signature_line(stripped):
            elements.append(('signature', stripped))
        # 普通文本
        else:
            elements.append(('text', stripped))

        i += 1

    if in_code_block and code_lines:
        elements.append(('code', '\n'.join(code_lines)))

    return elements


def setup_page(doc):
    """Set up A4 page with 2.54cm margins."""
    for section in doc.sections:
        section.page_width = Cm(21.0)   # A4 width
        section.page_height = Cm(29.7)  # A4 height
        section.top_margin = Cm(2.54)
        section.bottom_margin = Cm(2.54)
        section.left_margin = Cm(2.54)
        section.right_margin = Cm(2.54)


def convert(md_path, docx_path):
    """Convert markdown file to docx."""
    with open(md_path, 'r', encoding='utf-8') as f:
        md_text = f.read()

    # 跳过 YAML frontmatter
    if md_text.startswith('---'):
        parts = md_text.split('---', 2)
        if len(parts) >= 3:
            md_text = parts[2].strip()

    doc = Document()

    # 设置 Normal 样式默认字体
    style = doc.styles['Normal']
    style.font.name = BODY_FONT_ASCII
    style.font.size = BODY_SIZE
    style.element.rPr.rFonts.set(qn('w:eastAsia'), BODY_FONT)

    # 页面设置
    setup_page(doc)

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
        elif etype == 'h4':
            add_heading(doc, edata, level=4)
        elif etype == 'text':
            add_body(doc, edata)
        elif etype == 'signature':
            add_signature(doc, edata)
        elif etype == 'list':
            for item in edata:
                p = doc.add_paragraph(style='List Bullet')
                set_paragraph_format(p, first_line_indent=False)
                run = p.add_run(item)
                set_font(run)
        elif etype == 'olist':
            for item in edata:
                p = doc.add_paragraph(style='List Number')
                set_paragraph_format(p, first_line_indent=False)
                run = p.add_run(item)
                set_font(run)
        elif etype == 'table':
            headers, rows = edata
            add_table(doc, headers, rows)
        elif etype == 'code':
            for code_line in edata.split('\n'):
                p = doc.add_paragraph()
                set_paragraph_format(p, first_line_indent=False, space_after=0)
                run = p.add_run(code_line)
                set_font(run, font_name=BODY_FONT, font_ascii="Courier New",
                         size=Pt(10))
        elif etype == 'hr':
            p = doc.add_paragraph()
            set_paragraph_format(p, first_line_indent=False)
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
