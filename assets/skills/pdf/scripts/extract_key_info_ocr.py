#!/usr/bin/env python3
"""
使用PyMuPDF + OCR从PDF中提取甲方乙方信息
"""

import sys
import os
import json
import re
from pathlib import Path

try:
    import fitz  # PyMuPDF
    print("✓ PyMuPDF 已加载")
except ImportError:
    print("请安装: pip install PyMuPDF")
    sys.exit(1)

try:
    import pytesseract
    from PIL import Image
    import io
    print("✓ OCR 库已加载")
except ImportError:
    print("请安装: pip install pytesseract Pillow")
    sys.exit(1)


class PDFPartyExtractor:
    """PDF甲方乙方提取器"""

    def __init__(self, pdf_path):
        self.pdf_path = pdf_path
        self.full_text = ""
        self.info = {}

    def extract(self, max_pages=5):
        """提取PDF信息

        Args:
            max_pages: 最多处理前几页(通常关键信息在前几页)
        """
        if not os.path.exists(self.pdf_path):
            raise FileNotFoundError(f"找不到文件: {self.pdf_path}")

        print(f"正在处理: {self.pdf_path}\n")

        # 打开PDF
        doc = fitz.open(self.pdf_path)

        print(f"PDF信息:")
        print(f"  总页数: {len(doc)}")
        print(f"  是否加密: {doc.is_encrypted}")

        # 尝试直接提取文本
        print("\n正在尝试直接提取文本...")
        for i, page in enumerate(doc[:max_pages]):
            text = page.get_text()
            if text.strip():
                self.full_text += f"\n=== 第 {i+1} 页 (直接提取) ===\n"
                self.full_text += text

        # 如果直接提取的文本太少,说明是扫描件,需要OCR
        if len(self.full_text.strip()) < 100:
            print("  直接提取文本较少,可能是扫描件")
            print("正在使用OCR识别...")

            self.full_text = ""  # 清空

            for i, page in enumerate(doc[:max_pages]):
                print(f"  正在OCR第 {i+1} 页...")

                # 将页面渲染为图像
                mat = fitz.Matrix(2, 2)  # 2倍缩放提高识别率
                pix = page.get_pixmap(matrix=mat)
                img_data = pix.tobytes("png")
                img = Image.open(io.BytesIO(img_data))

                # OCR识别
                page_text = pytesseract.image_to_string(img, lang='chi_sim')
                self.full_text += f"\n=== 第 {i+1} 页 (OCR) ===\n"
                self.full_text += page_text

        doc.close()

        print(f"\n✓ 共提取 {len(self.full_text)} 个字符")

        # 提取甲方乙方
        self.info['parties'] = self._extract_parties()
        self.info['key_info'] = self._extract_key_info()
        self.info['text_sample'] = self.full_text[:1500]  # 保存前1500字符用于参考

        return self.info

    def _extract_parties(self):
        """提取甲方乙方"""
        parties = {}

        # 多种模式匹配
        patterns = {
            '甲方': [
                r'甲\s*方[：:]\s*([^\n]{2,50}?)(?=\n|地址|电话|身份证|传真|邮箱)',
                r'甲\s*方[：:]\s*([^\n]{2,30})',
                r'委托方[：:]\s*([^\n]{2,30})',
            ],
            '乙方': [
                r'乙\s*方[：:]\s*([^\n]{2,50}?)(?=\n|地址|电话|身份证|传真|邮箱)',
                r'乙\s*方[：:]\s*([^\n]{2,30})',
                r'受托方[：:]\s*([^\n]{2,30})',
                r'承包方[：:]\s*([^\n]{2,30})',
            ],
        }

        for party_type, pattern_list in patterns.items():
            for pattern in pattern_list:
                matches = re.findall(pattern, self.text)
                if matches:
                    # 清理匹配结果
                    value = matches[0].strip()
                    value = re.sub(r'\s+', ' ', value)  # 合并多个空白
                    value = value.split(' ')[0]  # 只取第一个词(通常是公司名)

                    if value and len(value) >= 2:  # 至少2个字符
                        parties[party_type] = value
                        print(f"✓ 找到{party_type}: {value}")
                        break

        return parties

    def _extract_key_info(self):
        """提取其他关键信息"""
        key_info = {}

        patterns = {
            '合同编号': [
                r'合同编?[号号码][：:]\s*([A-Z0-9\-]+)',
                r'协议编?[号号码][：:]\s*([A-Z0-9\-]+)',
            ],
            '日期': [
                r'\d{4}年\d{1,2}月\d{1,2}日',
                r'\d{4}-\d{1,2}-\d{1,2}',
            ],
            '电话': [
                r'电话[：:]\s*(1[3-9]\d{9})',
                r'手机[：:]\s*(1[3-9]\d{9})',
            ],
            '地址': [
                r'地址[：:]\s*([^\n]{10,80})',
            ],
        }

        for field, pattern_list in patterns.items():
            for pattern in pattern_list:
                matches = re.findall(pattern, self.text)
                if matches and field not in key_info:
                    key_info[field] = matches[:3]  # 最多3个
                    print(f"✓ 找到{field}: {matches[0]}")
                    break

        return key_info

    @property
    def text(self):
        """获取全文"""
        return self.full_text

    def print_report(self):
        """打印报告"""
        print("\n" + "="*70)
        print(" " * 15 + "甲方乙方信息提取报告")
        print("="*70)

        print("\n【协议双方】")
        parties = self.info.get('parties', {})
        if parties:
            for party, name in parties.items():
                print(f"  {party}: {name}")
        else:
            print("  ⚠ 未识别到甲方乙方信息")

        print("\n【其他关键信息】")
        key_info = self.info.get('key_info', {})
        if key_info:
            for key, value in key_info.items():
                if isinstance(value, list):
                    display_value = value[0] if len(value) == 1 else f"{value[0]} 等{len(value)}项"
                    print(f"  {key}: {display_value}")
                else:
                    print(f"  {key}: {value}")
        else:
            print("  未识别到其他关键信息")

        print("\n" + "="*70)

    def save_json(self, output_path):
        """保存为JSON"""
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(self.info, f, ensure_ascii=False, indent=2)
        print(f"\n✓ 详细信息已保存到: {output_path}")

    def show_text_sample(self):
        """显示文本样本供参考"""
        print("\n【提取的文本样本】")
        print("-" * 70)
        sample = self.info.get('text_sample', '')
        print(sample[:500])
        if len(sample) > 500:
            print("...")
        print("-" * 70)


def main():
    if len(sys.argv) < 2:
        print("使用方法: python extract_parties.py <input.pdf> [output.json]")
        sys.exit(1)

    input_pdf = sys.argv[1]
    output_json = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        extractor = PDFPartyExtractor(input_pdf)
        extractor.extract(max_pages=5)
        extractor.print_report()
        extractor.show_text_sample()

        if output_json:
            extractor.save_json(output_json)
        else:
            base_name = Path(input_pdf).stem
            default_json = f"{base_name}_parties.json"
            extractor.save_json(default_json)

    except Exception as e:
        print(f"\n✗ 错误: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
