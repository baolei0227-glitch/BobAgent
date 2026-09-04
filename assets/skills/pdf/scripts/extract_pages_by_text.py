#!/usr/bin/env python3
"""
从PDF中提取包含特定文本的页面

使用方法:
    python extract_pages_by_text.py <input.pdf> <search_text> [output.pdf]

示例:
    python extract_pages_by_text.py contract.pdf "周梦原" 周梦原相关页面.pdf
    python extract_pages_by_text.py document.pdf "关键词"
"""

from pypdf import PdfReader, PdfWriter
import sys
import os


def extract_pages_with_text(input_pdf, search_text, output_pdf=None):
    """
    从PDF中提取包含指定文本的页面

    Args:
        input_pdf: 输入PDF文件路径
        search_text: 要搜索的文本
        output_pdf: 输出PDF文件路径(可选,默认自动生成)

    Returns:
        tuple: (匹配的页面列表, 输出文件路径)
    """
    if not os.path.exists(input_pdf):
        print(f"错误: 找不到文件 '{input_pdf}'")
        return [], None

    # 如果未指定输出文件名,自动生成
    if output_pdf is None:
        base_name = os.path.splitext(os.path.basename(input_pdf))[0]
        output_pdf = f"{base_name}_{search_text}_pages.pdf"

    # 读取PDF
    reader = PdfReader(input_pdf)
    writer = PdfWriter()

    # 搜索包含指定文本的页面
    matching_pages = []
    for i, page in enumerate(reader.pages):
        # 提取页面文本
        page_text = page.extract_text()
        if page_text and search_text in page_text:
            matching_pages.append(i + 1)
            writer.add_page(page)
            print(f"✓ 找到匹配: 第 {i + 1} 页")

    # 如果找到匹配的页面,保存到新PDF
    if matching_pages:
        with open(output_pdf, "wb") as output:
            writer.write(output)
        file_size = os.path.getsize(output_pdf)
        size_mb = file_size / (1024 * 1024)
        print(f"\n✓ 成功提取 {len(matching_pages)} 页到: {output_pdf}")
        print(f"  文件大小: {size_mb:.2f} MB")
        print(f"  匹配页面: {matching_pages}")
        return matching_pages, output_pdf
    else:
        print(f"✗ 未找到包含 '{search_text}' 的页面")
        return [], None


def main():
    if len(sys.argv) < 3:
        print("使用方法: python extract_pages_by_text.py <input.pdf> <search_text> [output.pdf]")
        print("\n示例:")
        print("  python extract_pages_by_text.py contract.pdf '周梦原' 周梦原相关页面.pdf")
        print("  python extract_pages_by_text.py document.pdf '关键词'")
        sys.exit(1)

    input_pdf = sys.argv[1]
    search_text = sys.argv[2]
    output_pdf = sys.argv[3] if len(sys.argv) > 3 else None

    extract_pages_with_text(input_pdf, search_text, output_pdf)


if __name__ == "__main__":
    main()
