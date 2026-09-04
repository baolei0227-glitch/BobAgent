# 扫描版 PDF 识别方案

> 本文档说明 BobWork 当前系统对扫描版（图像型）PDF 的识别方案：判定方式、完整识别链路、质量评估、在线引擎升级与择优采用规则、长文档分片、以及数据安全约束。
>
> 核心代码入口：[`src/lib/pdf/ocr-service.ts`](src/lib/pdf/ocr-service.ts)、[`src/lib/pdf/extractor.ts`](src/lib/pdf/extractor.ts)、[`src/lib/pdf/bridge.ts`](src/lib/pdf/bridge.ts)

---

## 1. 总体设计原则

- **三级降级**：原生文本 PDF 零成本提取 → 本地 OCR → 云端 OCR/VLM 兜底，成本逐级上升，仅在必要时升级。
- **本地优先**：macOS Vision 框架本地 OCR 始终可用、零成本、无网络、无需 API Key；onlineocr / glmocr / VLM 均为精度增强层（可选），未配置时自动降级，不影响基础识别。
- **择优采用**：云端结果不无条件覆盖本地——通过「流水勾稽 + 关键字段完整度 + 质量分」三信号对比，仅当云端确实更优才替换（防幻觉/漏识劣化）。
- **证据保留**：图像增强只用于识别辅助，原始扫描图始终保留作为证据底稿（法律场景）。
- **可观测**：每页识别链路的 `want / used / adopted` 三档硬计数写入结果 notes，消除"配置了但没生效"的静默失败。

---

## 2. 扫描件判定流程

PDF 附件进入系统后（[`bridge.ts`](src/lib/pdf/bridge.ts) `applyPdfBridge`），按以下顺序判定：

```
用户消息含 PDF 附件
  └─ Python 脚本提取文本层（pypdf → pdfplumber）
       ├─ 提取到文本且质量分 ≥ 阈值（qualityScore ≥ QUALITY_THRESHOLD）→ 文本 PDF，直接注入消息
       ├─ 提取失败 → pdf-parse（Node 兜底）再次尝试
       │    └─ 有可用文本 → 文本 PDF
       └─ 仍无文本（needs_ocr=true）→ 判定为「扫描件」（method='scanned'）
```

**判定结果处理**：

- 文本 PDF：正文直接注入消息上下文，AI 直接基于内容回答。
- 扫描件：消息中提示 `Scanned PDF — Use read_attachment tool to OCR via vision model`，AI 据此调用工具走 OCR 链路。
- **A2 后台预热**：≤ 8 页的扫描件在请求入口处异步预识别并写入 PDF 缓存（复用 `read_attachment` 同款缓存），模型随后调用 `read_attachment` 时直接命中缓存，感知延迟 ≈ 0；预热失败不影响主流程。

---

## 3. 完整识别链路

扫描件进入 `ocrFile()`（[`ocr-service.ts`](src/lib/pdf/ocr-service.ts)）后，按页执行：

```
扫描件 PDF
  ├─ [可选] GLM-OCR 整份解析（仅 priority=glm-first / glm-force 时，PDF 直传官方文档解析引擎）
  ├─ 图像准备 renderPdfToImages
  │    ├─ 优先无损提取 PDF 内嵌原始图（DCTDecode 直写 JPEG / FlateDecode 经 PIL 转 PNG，零重采样）
  │    └─ 无原图的页用 sips 按 300dpi 渲染（提升清晰度，修复低 DPI 缩图降质）
  │    └─ 方向检测：横放/倒置（旋转 90°）扫描件自动转置 bbox
  ├─ 本地 OCR：macOS Vision 框架（ocr_vision.swift，swiftc 编译缓存）
  │    └─ 输出每页文字 + 文字块 bbox（含置信度，供版式/手写判定）
  ├─ 质量自适应增强（方案 C）
  │    └─ Laplacian 清晰度检测 → 低清晰度页增强后重 OCR → 领域信号对比取高者
  │        （流水页比勾稽一致行数，非流水页比质量分；增强无效自动丢弃）
  ├─ 在线升级（按 priority 顺序，逐页判定）：
  │    ├─ GLM-OCR（智谱官方文档解析，glm-first / glm-force）
  │    ├─ Online OCR（OpenAI 兼容视觉模型，OCR 专用模型，always / fallback）
  │    └─ VLM 兜底（通用视觉大模型，upgrade=off / auto / always）
  └─ 择优采用（有机结合 V2）→ 结构化后处理（页眉页脚去重 / 跨页续接）
```

### 3.1 三层识别引擎

| 层级 | 引擎 | 成本 | 依赖 | 适用 |
|------|------|------|------|------|
| 本地 | macOS Vision 框架（swift） | 零 | 本机可执行 swift（Xcode CLT） | 印刷体扫描件基础识别，始终可用 |
| 在线 | Online OCR（OpenAI 兼容视觉模型） | API | 设置中配置 onlineocr 模型 + Key | 本地质量低时的 OCR 专用兜底 |
| 在线 | GLM-OCR（智谱官方文档解析） | API | 设置中配置 glmocr | 整份文档解析（layout_parsing），复杂版式强项 |
| 在线 | VLM 通用视觉模型（qwen-vl / glm-4v / doubao-vision 等） | API | 角色派发已配置视觉模型 | 本地质量低/复杂版式页的最终兜底 |

> 未配置 onlineocr / glmocr / 视觉模型时，系统自动退化为纯本地 Vision OCR + 增强链路，识别能力不中断，仅低质量/复杂版式文档精度下降。

---

## 4. 质量评估与升级触发

### 4.1 质量信号（每页）

- **qualityScore**：文本质量分 0–1（字符密度/可读性）。
- **invalidChineseRatio**：无效汉字比例（常用字表白名单外生僻字/错字占比），> 0.15 判定为乱码。
- **hasPathologicalRepetition**：病态重复（如 "99999999"×50，列错位/乱码典型特征）。
- **ledgerVerificationScore**：流水表格余额勾稽一致行数（-1 = 非流水页，0 = 疑似全错）。
- **keyFieldCompleteness**：关键字段完整度（金额/日期/编号/电话等提示词出现但值缺失）。

### 4.2 VLM 升级触发条件（auto 策略，任一命中即升级该页）

| 条件 | 阈值 |
|------|------|
| 本地文本为空 | — |
| 质量分过低 | < 0.30 |
| 无效汉字比例过高（乱码） | > 0.15 |
| 病态重复 | 命中 |
| 关键字段缺失 | missing > 0 |
| 流水页勾稽一致行数为 0（数字疑似全错） | == 0 |

`upgrade='always'` 全部页升级；`upgrade='off'` 纯本地（默认安全档）。

---

## 5. 择优采用规则（有机结合 V2）

云端结果不无条件替换本地，按页独立判定：

1. **本地空白** → 必用云端。
2. **本地勾稽通过（verified > 0）**：数字域可信，但文字列需独立判定 —— 云端「关键字段缺失更少」或「质量分 ≥ 本地 - 0.05」任一满足即采用。
3. **本地勾稽 ≤ 0（非流水页）**：`关键字段缺失更少 || 质量分 ≥ 本地 - 0.05` 即采用。
4. **本地勾稽 = 0（流水疑似全错）**：需 `关键字段缺失不增 && 质量分不降` 才采用（最严格）。

> 采用后清空本地 bbox（云端结果无结构化坐标，避免下游误用），并在结果中标注 `upgraded / upgradeChain / upgradeModel`。

---

## 6. 在线引擎优先级与调度

`GLM-OCR priority` 四档控制在线引擎先后顺序：

| priority | 行为 |
|----------|------|
| `glm-first` | GLM-OCR 先跑，空结果才 Online OCR（整份解析分支可用） |
| `online-first` | Online OCR 先跑，空结果才 GLM-OCR（整份解析分支跳过） |
| `glm-force` | 只跑 GLM-OCR，不降级 Online/VLM（整份解析命中） |
| `online-force` | 只跑 Online OCR（等同禁用 GLM 与整份解析） |

**执行顺序固定**：GLM-OCR → Online OCR → VLM 兜底；先跑的有非空结果就不发后续请求（避免重复消费 token）。

**调度统计**（写入结果 notes）：`want / used / adopted` 三档逐页硬计数，一眼可见「配置是否命中 / 是否真调用 / 结果是否真采用」，并自动附加排查提示（如"GLM 已启用但 want=0"）。

---

## 7. 长扫描件分片委派（segment-scheduler）

扫描件页数多（≥ 多图/多步骤触发委派阈值）时，主节点创建 Bobby 分身并行识别：

1. **页级属性打标**：每页判定 `ledger`（疑似流水，需 VLM）或 `contract`（合同/发票/封面，纯本地 OCR 不打 VLM）。
2. **按任务属性归集切段**：相邻同标签页合并为 run，run 再切成 ≤ 8 页的段（`maxPagesPerSegment = 8`），按段派给不同 Bobby。
3. **目的**：流水页集中到 1–2 个 Bobby、合同/封面页集中到另一些 Bobby，避免每个 Bobby 都混入流水页而排队抢 VLM 配额。

---

## 8. 手写内容识别（handwriting）

macOS Vision 对中文手写（批注/补充条款/签名）不可靠，采用双方案：

- **方案 A**：识别置信度 < 0.6 的文本块所在行加 `[识别不确定]` 标记，主模型标 [存疑] 而非采信。
- **方案 B**：低置信度块（疑似手写区域）裁剪后按原相对位置拼图，一次性送视觉大模型局部识别，标注 `[手写批注·视觉识别]`。

仅用于本地 OCR 直接返回文本的路径（simple 版式或视觉模型不可用）；复杂版式整页走视觉模型时，手写内容由整页识别自然覆盖。

---

## 9. 结构化后处理（structural-postprocess）

纯函数、无 IO，扫描件典型痛点治理：

- **页眉页脚去重**：跨页重复出现的页眉/页脚行合并。
- **跨页标题续接**：被分页打断的表格标题/段落续接。

---

## 10. 数据安全与审计

- **数据出口审计**（egress-audit）：任何图片上传到在线 OCR/VLM 服务均记录审计日志（`chain` 标注 glm-ocr / online-ocr / vlm-upgrade）。
- **调度反馈降权**（dispatch-log）：识别失败/低质/被择优拒绝的模型记入历史统计，自动匹配视觉模型时跳过被降权模型。
- **证据底稿保留**：增强只用于识别辅助，原始扫描图始终保留。

---

## 11. 相关代码文件索引

| 文件 | 职责 |
|------|------|
| `src/lib/pdf/ocr-service.ts` | OCR 核心入口：整份解析、逐页升级、择优采用、调度统计 |
| `src/lib/pdf/extractor.ts` | 文本提取（pypdf/pdfplumber/pdf-parse）、图像渲染、本地 Vision OCR、图像增强 |
| `src/lib/pdf/bridge.ts` | 附件入口：扫描件判定、文本注入、A2 后台预热 |
| `src/lib/pdf/pdf_to_images.py` | PDF → 图片：内嵌原图无损提取 / sips 渲染 / 方向检测 / 图像增强 |
| `src/lib/pdf/pdf_extractor.py` | Python 文本层提取（pypdf → pdfplumber）与质量检测 |
| `src/lib/pdf/ocr_vision.swift` | macOS Vision 框架本地 OCR（含旋转 90° 自适应） |
| `src/lib/pdf/quality-scorer.ts` | 质量分 / 无效汉字比例 / 病态重复 |
| `src/lib/pdf/ledger.ts` | 流水余额勾稽校验 |
| `src/lib/pdf/key-fields.ts` | 关键字段完整度（金额/日期/编号/电话） |
| `src/lib/pdf/layout-score.ts` | 版式复杂度与 OcrPage 结构 |
| `src/lib/pdf/segment-scheduler.ts` | 长扫描件页级打标与按属性切段 |
| `src/lib/pdf/structural-postprocess.ts` | 页眉页脚去重 + 跨页续接 |
| `src/lib/pdf/handwriting.ts` | 手写识别（低置信度标记 + 局部拼图送 VLM） |
| `src/lib/pdf/ocr-online.ts` | Online OCR 配置解析与调用 |
| `src/lib/parse/glm-ocr.ts` | GLM-OCR 官方文档解析引擎 |
| `src/lib/parse/vision-adapter.ts` | 视觉模型 Prompt 与 OpenAI 兼容适配 |
| `src/lib/parse/image-parser.ts` | 单张图片视觉解析（VLM 兜底复用） |
| `src/lib/pdf/ocr_bands.swift` / `ocr_img*.swift` / `ocr_invert.swift` | 历史 OCR swift 工具 |

---

## 12. 常见问题

**Q：没配置 onlineocr 也没配置 glmocr，扫描版 PDF 还能识别吗？**

能。本地 macOS Vision OCR + 图像增强始终可用（零配置），未配置在线引擎时自动降级为纯本地链路，仅低质量/复杂版式文档的识别精度下降。若已配置视觉模型（角色派发 → Vision Model），还可通过 `upgrade=auto/always` 启用 VLM 兜底。

**Q：如何让在线引擎真正生效？**

检查 OCR 结果 notes 中的调度统计：`want=0` 说明未被调度（strategy=fallback 但本地质量达标 / priority 强制关闭）；`used=0` 说明请求空回/报错（Key 或端点问题）；`adopted=0` 说明云端结果未优于本地（正常保留本地）。面板「Run Sample OCR」可复现定位。
