# VENDOR.md — 来源、许可与本地改动说明

本目录是 **GenOffice `docx-engine` 的源码快照**（vendored source），用于 BobWork 的
「链路 B：OOXML 原生 docx 编辑」内核。**不是** npm 依赖，源码即产物、无构建步骤。

## 来源

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/genspark-ai/genoffice |
| 上游包 | `packages/docx-engine`（`@genoffice/docx-engine@0.1.0`，`private: true`，**未发布 npm**） |
| 快照 commit | `05b4bd6e4b23102b2e85847b49b5f9cc94c33797` |
| commit 日期 | 2026-09-28（`Sync snapshot (2026-09-28) (#1444)`） |
| 取源方式 | `git clone --filter=blob:none --no-checkout --depth 1` ＋ `git sparse-checkout set packages/docx-engine packages/pptx-engine` |
| 落地日期 | 2026-09-28 |
| 规模 | `src/` 下 45 个 `.ts` / 30,781 行；整目录 1.6 MB |

## 许可（Apache-2.0，已随目录附带）

- `LICENSE` —— Apache License 2.0 全文（复制自上游仓库根，未改）。
- `NOTICE` —— 上游 NOTICE，保留 `Copyright 2026 Mainfunc, Inc.` 原文，**未改**。
- `vendor/emf-converter/` —— 第三方 vendored 组件 `emf-converter 2.0.2`（Apache-2.0，
  上游 <https://github.com/ChristopherVR/emf-converter>），其 `LICENSE` 随目录保留。

## 本地改动（全量仅 2 处，其余 45 个 `.ts` 与上游逐字节一致）

| 文件 | 改动 | 性质 |
|---|---|---|
| `parse.ts:4` | `from '@genoffice/pptx-engine/custgeom'` → `from './vendor/pptx/custgeom'` | 改 1 行 |
| `vendor/pptx/types.ts` | **裁剪版**：仅保留 `parseCustGeom` 编译期所需的 `CustomGeometry`（原文照录上游 `pptx-engine/src/types.ts` 第 494–505 行） | 新增（非上游全文） |

`vendor/pptx/custgeom.ts` 为上游 `pptx-engine/src/custgeom.ts` **原文照搬，未改一字**
（已用 `cmp` 逐字节比对确认）。

### 为什么裁剪 `pptx/types.ts`

`custgeom.ts:11` 有 `import type { CustomGeometry } from './types'`。上游 `types.ts`（730 行）
的 `ChartElement` 通过**类型位置的动态 import**（`types.ts:681` 的
`import('./chart').ChartModel`）牵入 `chart.ts`，并连带 `color.ts` / `theme.ts` / `xml-utils.ts` ——

> 实测完整闭包 = **6 个文件 / 3,366 行**（custgeom 491 ＋ types 730 ＋ chart 1,370 ＋ color 371 ＋ theme 301 ＋ xml-utils 103），外部依赖 `fast-xml-parser`。

而 docx 引擎只用到其中 8 行的一个接口。因是 `import type`，**运行时零影响**（编译期即被擦除）。
如需恢复完整版，按同一 commit 取回 `pptx-engine/src/{types,chart,color,theme,xml-utils}.ts`
覆盖即可 —— `custgeom.ts` 无需改动，会自动解析到完整版。

**为压缩体积而刻意未纳入**：上游 `tests/`（160 项，约 1.5 MB）与 `scripts/`。

## 运行时依赖（3 个，均自带 TypeScript 声明）

| 包 | 版本 | 许可 | 用途 | 上游使用点数 |
|---|---|---|---|---|
| `jszip` | ^3.10.2 | MIT | docx（ZIP）读写 | 13 |
| `fast-xml-parser` | ^5.11.1 | MIT | OOXML 解析（`xml-utils.ts`） | 1 |
| `utif2` | ^4.1.0 | MIT | 内嵌 TIFF 解码（`tiff.ts`） | 1 |

> ⚠️ `fast-xml-parser` 必须 **≥5.3.4**：`xml-utils.ts` 用到 `maxNestedTags`（5.2.x 无此键，
> 会类型报错）。故实际安装版本为 `^5.11.1`，**不要**降到 5.2.x。
>
> ⚠️ 三者原先仅作为**传递依赖**间接存在于 `.pnpm`（`jszip@3.10.1` ← `docx-preview`/`mammoth`；
> `fast-xml-parser@5.2.5`），**未在 `package.json` 声明**；pnpm 不提升，裸 import 无法解析。
> 已于 `package.json` 显式声明，需执行一次 **`pnpm install`** 完成链接。
>
> 📌 曾在本地临时放一份**仅本地生效**的 `node_modules/`（`jszip` / `fast-xml-parser` / `utif2` / `strnum`），
> 目的是在 `pnpm install` 之前让类型检查立即可用。**已于 2026-09-30 删除**：顶层 `.pnpm` 已具备
> 完整依赖闭包（`fast-xml-parser@5.11.1` 带 `strnum` / `xml-naming` / `is-unsafe` / `path-expression-matcher` / `@nodable`，
> `utif2@4.1.0` 带 `pako`），裸 import 由 pnpm 链接正常解析，构建与单测均通过。
>
> ⛔ **不要在本目录再放 `node_modules/`**：Turbopack 会优先命中这棵嵌套树而遮蔽 pnpm 布局，且嵌套的
> `fast-xml-parser` 走 ESM `exports` 条件（`./src/fxp.js`）时其传递依赖不齐，直接导致构建期
> `Module not found`（v0.7.654 首次构建即栽在此处）。

## 与 BobWork 既有组件的关系

| 既有 | 关系 |
|---|---|
| `src/lib/docx/ooxml-revise.py`（python-docx 修订引擎） | **并存**，仍是 `/api/docx/revise` 的后端；本内核是**渲染与编辑侧**（块树 ＋ 脏块追踪） |
| `src/lib/md-to-docx/`（mdast → docx） | 独立，服务于「Markdown 为真源」的链路 A |
| `src/lib/docx-to-md/`（mammoth） | 独立，仍作为一键转 MD 通道 |
| `viewers/DocxViewer.tsx`（docx-preview 渲染） | **已删除**（2026-09-30，用户授权）；AI 修订等能力已并入 DocxTiptapEditor |

## 已验证事实（2026-09-28，用**本目录副本**在 BobWork 工具链内实测）

- **类型检查 0 错误**：`tsc -p`（临时 tsconfig，含 `src/**`、`electron/**`、`scripts/**`）→ `TSC_EXIT=0`。
- **零改动往返 → 与原始文件逐字节一致**：10,210 B 输入 / 10,210 B 输出，`Buffer.compare === 0`
  （机制：`patch.ts:464` 的 `isUnchanged` 早退，直接返回 `originalBytes`）。
- **单块替换 → 20 个 zip 条目中 18 项逐字节不变**，变化仅 `word/document.xml`（预期）
  与 `docProps/core.xml`（`cp:revision` 自增 ＋ `dcterms:modified` 归一化到秒 —— 符合 OOXML 惯例，
  且**不可**由 `SaveOptions.partXml` 覆盖：`patch.ts:1551` 的 `CORE_PROPS_PATH` 分支优先级高于 `:1553`）。
- **幂等**：对产物重新解析并零改动保存 → 字节一致（反复保存不漂移）。
- 性能参考（10 KB 文档）：`parseDocx` ≈ 46–60 ms；零改动 `saveDocx` ≈ 2 ms；单块替换 `saveDocx` ≈ 37 ms。
