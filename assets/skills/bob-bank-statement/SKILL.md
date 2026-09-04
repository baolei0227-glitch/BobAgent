---
name: bob-bank-statement
description: >
  银行流水 OCR + 余额勾稽算证舱工具。输入 PDF/图片流水，输出 Excel（交易明细表/控制行明细/勾稽异常清单 三 Sheet）+
  Markdown 勾稽报告 + JSON 状态摘要。默认模式只出结果与勾稽证据，不做法律定性。
version: 0.1.0
scenes: [office, finance]
author: BobWork Team
tags: [bank statement, OCR, reconciliation, excel export, 勾稽报告]
entry:
  type: script
  runner: tsx
  script: scripts/run_statement_pipeline.ts
  args:
    positional:
      - name: input_path
        required: true
        description: 银行流水 PDF/图片 的绝对路径
    options:
      - name: out_dir
        type: string
        default: ./homework
        description: 输出目录（默认相对于项目根的 homework/）。不存在时自动创建。
      - name: mode
        type: string
        enum: [quick, standard, forensic]
        default: standard
        description: >
          quick: 仅本地 OCR + 勾稽，不出 Excel（快速判断是否是流水）。
          standard: 默认档：本地 OCR + 勾稽 + 三态报告 + 三 Sheet Excel。
          forensic: 标准档 + 逐格五维评估明细 JSON（人工复核/证据打包用）。
      - name: scenario
        type: string
        enum: [per_page, whole_doc]
        default: per_page
        description: >
          per_page: OCR 按页择优（缺省推荐：适合一般流水）。
          whole_doc: 整份一次性送云端 GLM 再回拼（适合列结构极乱、每页表头不同的扫描件）。
      - name: glm_priority
        type: string
        enum: [none, optional, force]
        default: optional
        description: 云端大模型 OCR 优先级（与 ocr-file 语义一致：optional=本地缺值时回退；force=强制走云端）。
      - name: glm_upgrade_if_below_passrate
        type: number
        default: 0.6
        description: 本地 OCR 勾稽通过率低于该阈值时自动升级云端（glm_priority=optional 才生效）。
input_constraints:
  - 支持 .pdf / .png / .jpg / .jpeg / .webp / .tif / .tiff
  - 单文件 <= 150 MB，多页 PDF 建议 <= 200 页
  - 扫描件建议 >= 300 DPI，手写涂改件效果可能显著下降
output:
  files:
    - pattern: ${stem}_流水明细.xlsx
      sheet_layout: 三 Sheet：[交易明细, 控制行明细, 勾稽异常清单]
    - pattern: ${stem}_勾稽报告.md
      layout: 三段模板（摘要/三态结论/Summary 汇总表）
    - pattern: ${stem}_状态.json
      schema:
        detectedAsLedger: boolean
        passRate: number | null
        coverageRate: number
        longestPassingChain: number
        crossPageStatus: string
        semanticsStatus: string
        issuesCount: number
        mode: string
        outputExcelPath: string | null
        outputMarkdownPath: string | null
        exportAt: string
  exit_code:
    0: >
      执行完成（结果好坏不影响退出码：detectedAsLedger=false 也是合法结果，
      表示"这份文档不像银行流水"，Agent 应直接用退出码 0 + JSON 来走分支）。
    2: 参数/输入错误（文件不存在 / 不支持扩展名 / 空文件）。
    3: 算证舱内部错误（OCR 服务异常、xlsx 写入失败等）。
usage_examples:
  - title: 标准档：默认勾稽 + 三 Sheet Excel + Markdown 报告（推荐日常使用）
    cli: tsx assets/skills/bob-bank-statement/scripts/run_statement_pipeline.ts /abs/path/to/流水.pdf
  - title: 快速档：仅判断"是不是流水"与通过率（不导出 Excel/报告）
    cli: tsx assets/skills/bob-bank-statement/scripts/run_statement_pipeline.ts /abs/path/to/流水.png --mode=quick
  - title: 司法鉴定档：勾稽 + 三 Sheet + 逐格五维评估 JSON 写入 Excel 第四个 Sheet
    cli: tsx assets/skills/bob-bank-statement/scripts/run_statement_pipeline.ts /abs/path/to/流水.pdf --mode=forensic
agent_hints:
  - 先读 ${stem}_状态.json 的 detectedAsLedger，若为 false 直接告诉用户"这份文档未识别为银行流水"，不要给勾稽结论。
  - 三态话术固定：
      green  → "基于当前 OCR 结果，**余额勾稽未见异常**（passRate=X / coverageRate=Y / longestChain=Z / crossPage=pass），可进入下一阶段；仍建议抽查 3-5 笔高金额交易核对。"
      yellow → "勾稽存在**局部不平或证据不足**（passRate=X / coverageRate=Y / crossPage=fail|needs_review），请人工对照 `勾稽异常清单` Sheet 复核；扫描件糊页 / 红章遮挡时可能为 OCR 错值，建议启用 whole_doc 重新识别。"
      red    → "勾稽存在**重大不平或非流水信号**（passRate=X / coverageRate=Y / detectedAsLedger=false），不得作为法律事实使用；请先确认文档类型或联系文档提供方补件。"
  - Skill 内部不写绿色事实舱；green 话术仅表示"当前 OCR 范围内未发现矛盾"，不等于"原件真实"。
---

# bob-bank-statement · 银行流水 OCR 算证舱工具

## 一、我能干什么

把一份银行流水 PDF / 图片跑完整链路：

1. **OCR 识别**：本地 Vision OCR + （按策略可选）云端 GLM OCR，按页择优；
2. **列检测 & 控制行分类**：自动识别「日期 / 摘要 / 金额 / 余额」四列或「日期 / 摘要 / 收入 / 支出 / 余额」五列，同时识别「期初余额 / 期末余额 / 本页合计 / 本年累计 / 重复表头 / 分隔行」等控制行，控制行**不参与**余额勾稽方程（避免误报）；
3. **余额勾稽**：按 `prevBalance ± amount/income-expense = currBalance` 逐行校验，输出 `passRate / coverageRate / longestPassingChain / crossPageStatus` 四个证据指标；
4. **逐格五维评估（P1-2）**：每个金额/余额/日期/摘要格，写入 `visual / structural / normalization / reconciliation / human` 五维评估 → 最终 `green / yellow / red` 准入颜色；
5. **输出产物**：Excel 三 Sheet + Markdown 勾稽报告 + JSON 状态摘要（forensic 档追加逐格明细）。

---

## 二、三档模式

| 档位 | 本地 OCR | 勾稽 | 控制行分类 | 三态报告 | 三 Sheet Excel | 逐格评估 JSON |
| --- | --- | --- | --- | --- | --- | --- |
| `--mode=quick` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `--mode=standard`（默认） | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `--mode=forensic` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅（第 4 Sheet） |

- **quick** 适合「先判断是不是流水，再决定要不要跑完整档」；
- **standard** 适合日常批量跑；
- **forensic** 适合人工复核 / 合规留档 / 打包证据。

---

## 三、三态话术（Agent 固定朗读，不要自行发挥）

> 说明：三态只基于「当前 OCR 结果」的自洽性，**不等同于法律事实判断**。红色档≠"伪造"，绿色档≠"原件真实"，仅表示 OCR 链路里的数值/结构自洽程度。

### 🟢 Green（勾稽未见异常）

满足：`passRate >= 0.98 && coverageRate >= 0.95 && longestPassingChain >= 10 && crossPageStatus ∈ {pass, not_checked}`

```
基于当前 OCR 结果，**余额勾稽未见异常**（passRate=X / coverageRate=Y / longestChain=Z / crossPage=pass），
可进入下一阶段；仍建议抽查 3-5 笔高金额交易核对。
```

### 🟡 Yellow（局部不平或证据不足）

既不是 green 也不是 red 的全部情况。

```
勾稽存在**局部不平或证据不足**（passRate=X / coverageRate=Y / crossPage=FAIL_STATUS），
请人工对照 Excel 的「勾稽异常清单」Sheet 复核；
扫描件糊页 / 红章遮挡时可能为 OCR 错值，建议启用 --scenario=whole_doc 重新识别。
```

### 🔴 Red（重大不平或非流水信号）

满足任一：`passRate < 0.50` 或 `coverageRate < 0.40` 或 `detectedAsLedger === false`。

```
勾稽存在**重大不平或非流水信号**（passRate=X / coverageRate=Y / detectedAsLedger=BOOL），
不得作为法律事实使用；请先确认文档类型或联系文档提供方补件。
```

---

## 四、输出文件说明

完整产物目录结构（standard 档示例）：

```
${out_dir}/
├── ${stem}_流水明细.xlsx
│   ├── 交易明细              （主表）
│   ├── 控制行明细            （opening/closing/subtotal/total/header_repeat/separator/noise）
│   └── 勾稽异常清单           （issues[] 映射：行号/类型/详情）
├── ${stem}_勾稽报告.md         （三段：摘要 / 三态结论 / Summary 汇总表）
└── ${stem}_状态.json           （{ detectedAsLedger, passRate, coverageRate, ..., outputExcelPath, outputMarkdownPath }）
```

forensic 档在 `流水明细.xlsx` 里追加第 4 个 Sheet：**逐格评估明细**（每格一行，key / 行列坐标 / 原始 / 标准化 / 五维 / 最终颜色）。

---

## 五、CLI 用法示例

```bash
# 推荐：标准档
cd projects
tsx assets/skills/bob-bank-statement/scripts/run_statement_pipeline.ts \
  /abs/path/to/某银行流水2024Q2.pdf \
  --out_dir ./homework \
  --mode standard

# 快速：只看是不是流水 + 勾稽通过率
tsx assets/skills/bob-bank-statement/scripts/run_statement_pipeline.ts /abs/path/to/截图2025-01-20.jpg --mode quick

# 司法鉴定：逐格评估明细 + 三 Sheet + 报告
tsx assets/skills/bob-bank-statement/scripts/run_statement_pipeline.ts /abs/path/to/多页扫描件.pdf --mode forensic
```

---

## 六、和 PDF 主识别链路的关系

- bob-bank-statement **不是** PDF/OCR 主链路的分支；它是**独立的可选算证舱工具**：
  - 输入文件 → 调 `ocrFile()` 主链路出 `OcrPage[]` → 再调算证舱 `buildMultiPageLedgerReport()` 做流水专属的勾稽、控制行分类、Excel 导出。
  - 非流水 PDF：`detectedAsLedger=false`，直接返回，**不**影响主链路结果。
- 好处：
  - 主链路不需要关心「流水列结构 / 控制行排除 / 双列金额模式」，保持通用；
  - 流水的合规逻辑（三态话术 / Summary 表 / 勾稽异常清单着色）可以独立迭代，不污染通用代码。
