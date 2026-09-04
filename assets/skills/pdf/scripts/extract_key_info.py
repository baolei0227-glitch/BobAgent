#!/usr/bin/env python3
"""
从PDF中提取关键信息

功能:
- 提取文档元数据(标题、作者、创建日期等)
- 识别常见关键字段(合同号、金额、日期、人名等)
- 统计文档基本信息
- 生成结构化摘要

使用方法:
    python extract_key_info.py <input.pdf> [output.json]

示例:
    python extract_key_info.py contract.pdf
    python extract_key_info.py contract.pdf info.json
"""

from pypdf import PdfReader
import re
import json
import sys
import os
from datetime import datetime
from pathlib import Path


class PDFKeyInfoExtractor:
    """PDF关键信息提取器"""

    # 常见关键字段正则表达式
    PATTERNS = {
        # 合同相关
        '合同编号': r'(?:合同编号|合同号|编号|No\.?|Number|Contract\s*ID?)[:：\s]*([A-Z0-9\-]+)',
        '合同金额': r'(?:合同金额|总金额|价款|总计|金额|Amount|Total)[:：\s¥$]*([\d,]+(?:\.\d{2})?)',
        '签约日期': r'(?:签约日期|签订日期|签署日期|日期|Date|Signed)[:：\s]*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日]?)',

        # 发票相关
        '发票号码': r'(?:发票号码|发票代码|Invoice\s*No?)[:：\s]*([A-Z0-9]+)',
        '发票金额': r'(?:价税合计|合计金额|发票金额|Total)[:：\s¥$]*([\d,]+(?:\.\d{2})?)',

        # 个人信息
        '姓名': r'(?:姓名|Name|甲方|乙方)[:：\s]*([^\s\n]{2,10})',
        '电话': r'(?:电话|手机|Tel|Phone|Mobile)[:：\s]*(1[3-9]\d{9})',
        '身份证': r'(?:身份证|ID\s*Card)[:：\s]*([1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx])',
        '邮箱': r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}',

        # 地址信息
        '地址': r'(?:地址|Address|住址)[:：\s]*([^\n]{10,100})',

        # 银行信息
        '银行账号': r'(?:银行账号|账号|Bank\s*Account)[:：\s]*(\d{10,25})',
        '开户行': r'(?:开户行|银行|Bank)[:：\s]*([^\n]{5,30})',
    }

    # 中文日期格式
    DATE_PATTERNS = [
        r'\d{4}年\d{1,2}月\d{1,2}日',
        r'\d{4}-\d{1,2}-\d{1,2}',
        r'\d{4}/\d{1,2}/\d{1,2}',
        r'\d{1,2}/\d{1,2}/\d{4}',
    ]

    def __init__(self, pdf_path):
        """初始化提取器"""
        self.pdf_path = pdf_path
        self.reader = None
        self.full_text = ""
        self.info = {}

    def extract(self):
        """提取所有关键信息"""
        if not os.path.exists(self.pdf_path):
            raise FileNotFoundError(f"找不到文件: {self.pdf_path}")

        print(f"正在分析: {self.pdf_path}")
        self.reader = PdfReader(self.pdf_path)

        # 1. 提取元数据
        self.info['metadata'] = self._extract_metadata()

        # 2. 提取文档统计信息
        self.info['stats'] = self._extract_stats()

        # 3. 提取全文(用于关键字段提取)
        self._extract_full_text()

        # 4. 提取关键字段
        self.info['key_fields'] = self._extract_key_fields()

        # 5. 提取所有日期
        self.info['dates'] = self._extract_dates()

        # 6. 提取金额信息
        self.info['amounts'] = self._extract_amounts()

        # 7. 生成摘要
        self.info['summary'] = self._generate_summary()

        return self.info

    def _extract_metadata(self):
        """提取PDF元数据"""
        metadata = {}
        meta = self.reader.metadata

        if meta:
            metadata['标题'] = meta.get('/Title', '未知')
            metadata['作者'] = meta.get('/Author', '未知')
            metadata['主题'] = meta.get('/Subject', '未知')
            metadata['创建者'] = meta.get('/Creator', '未知')
            metadata['创建日期'] = self._format_date(meta.get('/CreationDate', ''))
            metadata['修改日期'] = self._format_date(meta.get('/ModDate', ''))

        return metadata

    def _extract_stats(self):
        """提取文档统计信息"""
        stats = {
            '总页数': len(self.reader.pages),
            '是否加密': self.reader.is_encrypted,
        }

        # 统计页面大小分布
        page_sizes = {}
        for page in self.reader.pages:
            size = f"{round(page.mediabox.width)}x{round(page.mediabox.height)}"
            page_sizes[size] = page_sizes.get(size, 0) + 1

        stats['页面尺寸'] = page_sizes
        return stats

    def _extract_full_text(self):
        """提取全文用于关键字段识别"""
        print("正在提取全文...")
        for i, page in enumerate(self.reader.pages):
            text = page.extract_text()
            if text:
                self.full_text += text + "\n"

        print(f"✓ 提取了 {len(self.full_text)} 个字符")

    def _extract_key_fields(self):
        """提取关键字段"""
        print("正在识别关键字段...")
        fields = {}

        for field_name, pattern in self.PATTERNS.items():
            matches = re.findall(pattern, self.full_text, re.IGNORECASE | re.MULTILINE)
            if matches:
                # 去重并保留前5个匹配
                unique_matches = list(dict.fromkeys(matches))[:5]
                if len(unique_matches) == 1:
                    fields[field_name] = unique_matches[0]
                else:
                    fields[field_name] = unique_matches
                print(f"  ✓ 找到 {field_name}: {unique_matches[0]}")

        return fields

    def _extract_dates(self):
        """提取所有日期"""
        dates = []
        for pattern in self.DATE_PATTERNS:
            matches = re.findall(pattern, self.full_text)
            dates.extend(matches)

        # 去重
        dates = list(dict.fromkeys(dates))
        return dates[:10]  # 最多返回10个日期

    def _extract_amounts(self):
        """提取所有金额(格式: ¥123,456.78)"""
        amount_pattern = r'[¥$]?\s*([\d,]+(?:\.\d{2})?)\s*[元万元]?'
        matches = re.findall(amount_pattern, self.full_text)

        # 过滤并转换
        amounts = []
        for match in matches:
            try:
                # 移除逗号并转换为浮点数
                amount = float(match.replace(',', ''))
                if amount > 0:  # 只保留大于0的金额
                    amounts.append({
                        '原始值': match,
                        '数值': amount
                    })
            except ValueError:
                continue

        # 去重并排序
        seen = set()
        unique_amounts = []
        for a in amounts:
            if a['数值'] not in seen:
                seen.add(a['数值'])
                unique_amounts.append(a)

        return unique_amounts[:10]  # 最多返回10个金额

    def _generate_summary(self):
        """生成文档摘要"""
        summary = {
            '文档类型': self._guess_document_type(),
            '关键字段数': len(self.info.get('key_fields', {})),
            '主要日期': self.info.get('dates', [])[:3],
        }
        return summary

    def _guess_document_type(self):
        """猜测文档类型"""
        text = self.full_text.lower()
        keywords = {
            '合同': ['合同', '协议', '协议书'],
            '发票': ['发票', 'invoice'],
            '简历': ['简历', 'resume', 'cv'],
            '报告': ['报告', 'report'],
            '证书': ['证书', 'certificate'],
        }

        for doc_type, type_keywords in keywords.items():
            for keyword in type_keywords:
                if keyword in text:
                    return doc_type

        return '未知'

    def _format_date(self, pdf_date):
        """格式化PDF日期"""
        if not pdf_date or pdf_date == "未知":
            return "未知"

        try:
            # PDF日期格式: D:20240101123000+00'00'
            if pdf_date.startswith('D:'):
                pdf_date = pdf_date[2:10]
                return f"{pdf_date[:4]}-{pdf_date[4:6]}-{pdf_date[6:8]}"
            return pdf_date
        except:
            return "未知"

    def print_report(self):
        """打印提取报告"""
        print("\n" + "="*60)
        print("PDF 关键信息提取报告")
        print("="*60)

        # 元数据
        print("\n【文档元数据】")
        for key, value in self.info.get('metadata', {}).items():
            print(f"  {key}: {value}")

        # 统计信息
        print("\n【文档统计】")
        stats = self.info.get('stats', {})
        print(f"  总页数: {stats.get('总页数', 0)}")
        print(f"  是否加密: {stats.get('是否加密', False)}")
        print(f"  页面尺寸: {stats.get('页面尺寸', {})}")

        # 关键字段
        print("\n【关键字段】")
        key_fields = self.info.get('key_fields', {})
        if key_fields:
            for key, value in key_fields.items():
                if isinstance(value, list):
                    print(f"  {key}: {value[0]} (共{len(value)}项)")
                else:
                    print(f"  {key}: {value}")
        else:
            print("  未识别到标准关键字段")

        # 日期
        print("\n【发现的日期】")
        dates = self.info.get('dates', [])
        if dates:
            for date in dates[:5]:
                print(f"  - {date}")
        else:
            print("  未找到日期")

        # 金额
        print("\n【发现的金额】")
        amounts = self.info.get('amounts', [])
        if amounts:
            for amt in amounts[:5]:
                print(f"  - {amt['原始值']}")
        else:
            print("  未找到金额")

        # 摘要
        print("\n【文档摘要】")
        summary = self.info.get('summary', {})
        for key, value in summary.items():
            print(f"  {key}: {value}")

        print("\n" + "="*60)

    def save_json(self, output_path):
        """保存为JSON格式"""
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(self.info, f, ensure_ascii=False, indent=2)
        print(f"\n✓ 信息已保存到: {output_path}")


def main():
    if len(sys.argv) < 2:
        print("使用方法: python extract_key_info.py <input.pdf> [output.json]")
        print("\n示例:")
        print("  python extract_key_info.py contract.pdf")
        print("  python extract_key_info.py contract.pdf info.json")
        sys.exit(1)

    input_pdf = sys.argv[1]
    output_json = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        # 创建提取器
        extractor = PDFKeyInfoExtractor(input_pdf)

        # 执行提取
        info = extractor.extract()

        # 打印报告
        extractor.print_report()

        # 保存JSON(如果指定)
        if output_json:
            extractor.save_json(output_json)
        else:
            # 默认保存为同名JSON文件
            base_name = Path(input_pdf).stem
            default_json = f"{base_name}_info.json"
            extractor.save_json(default_json)

    except Exception as e:
        print(f"\n✗ 错误: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
