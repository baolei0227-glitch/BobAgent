'use client';

/**
 * docx 编辑器命令表 —— 工具栏的**唯一真源**
 *
 * 背景（2026-10-01 去重整改）：
 *   整改前同一个命令在两处各写一份 JSX —— 单行工具条与 ⋯ 溢出菜单。宽屏时两份同时可达，
 *   打开 ⋯ 菜单能看到字体 / 字号 / B I U S / 四种对齐 / 列表 / 缩进 全是副本；
 *   且改一处漏一处（加命令要改两个地方）。
 *
 * 整改后：命令只在这里定义一次，渲染层按 `tier` 过滤：
 *   · tier='primary' → **候选常驻**工具条：宽度够就上工具条，被挤出后回落进 ⋯ 菜单
 *   · tier='menu'    → 永不上工具条，只在 ⋯ 菜单里出现
 *   下拉类控件（字体 / 字号 / 样式）见宿主里的 `renderXxxSelect()`。
 *
 * 2026-10-02 二期「Word 式自适应工具条」（用户反馈：四种对齐 / 两种列表不该收成下拉）：
 *   · 宽度核算：`ToolBtn` = 24px、容器 `gap-1` = 4px。两个下拉（对齐 82 + 列表 78 = 164px）
 *     换成 4 个对齐按钮 + 2 个列表按钮 = 160px —— **还原成按钮反而更窄**。
 *     所以「空间不够」从来不是收成下拉的理由；一期把 6 个按钮并成 2 个下拉属误判，已还原。
 *   · 真正的约束是命令总量：本表 primary 全铺开约 760px（默认字号档位，含分隔线），
 *     而画布面板默认约 826px 宽，扣掉左右内边距后只剩 ≈810px ⇒ 边界处必须取舍。
 *   · 取舍方式：宿主持一张 `toolbarSlots()` 槽位表（展示顺序 + `evictRank` 淘汰优先级 +
 *     估算宽度），按可用宽度**贪心淘汰**，被挤出的整组下沉到 ⋯ 菜单补位（对标 Word ribbon）。
 *     本表只声明「命令属于哪个分区」（`toolSection`）与「在菜单里第几行」（`row`，仅 menu 级）；
 *     宽度与优先级属布局问题，归宿主，不写进本表。
 *
 * 判据（整改后自检）：
 *   · 工具条按钮的命令动作（如 `toggleMark('strong')`）只应在本文件出现，宿主不得各写一份；
 *   · `tier='primary'` 的命令都应带 `toolSection`（否则落不进任何槽位，工具条与 ⋯ 都不会渲染）；
 *   · `tier='menu'` 的命令都不带 `toolSection`；`row` 只对 menu 级有意义。
 */

import type { Editor } from '@tiptap/react';
import type { ReactNode } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ClipboardPaste,
  Columns3,
  Copy,
  Eraser,
  ExternalLink,
  FileDown,
  FileImage,
  IndentDecrease,
  IndentIncrease,
  List,
  ListOrdered,
  Pilcrow,
  Printer,
  RotateCcw,
  Rows3,
  Scissors,
  SeparatorHorizontal,
  Subscript,
  Superscript,
  Table,
} from 'lucide-react';

/** 命令的落点层级：primary = 候选常驻（可被挤出到 ⋯）；menu = 只在 ⋯ */
export type DocxTier = 'primary' | 'menu';

/** ⋯ 菜单分区归属（工具条分区见 DocxToolSection） */
export type DocxGroup = 'font' | 'paragraph' | 'insert' | 'table' | 'clipboard' | 'view' | 'file';

/**
 * 工具条分区（仅 tier='primary' 使用）——决定工具条上的**展示顺序与分隔符位置**。
 * 淘汰优先级与估算宽度由宿主的 `TOOL_SECTIONS` 表决定（布局问题不写进命令表）。
 */
export type DocxToolSection =
  | 'inline' // 加粗 / 斜体 / 下划线 / 删除线
  | 'script' // 上标 / 下标
  | 'align' // 四种对齐
  | 'list' // 项目符号 / 编号
  | 'paraIndent' // 增 / 减列表缩进
  | 'paraMisc' // 分页符 / 清除格式
  | 'insert'; // 表格 / 图片

/**
 * 命令执行时需要的外部能力（宿主闭包内的副作用）。
 * 之所以外置：插入表格 / 图片 / 清格式 / 页眉页脚切换 / 文件类动作都不是纯 editor 命令，
 * 需要访问组件状态（loading / converting / fileInfo）与 ref（隐藏 file input）。
 */
export interface DocxCmdApi {
  loading: boolean;
  converting: boolean;
  hasPath: boolean;
  /** 页眉页脚编辑态（驱动「页眉页脚」菜单项高亮） */
  hfEdit: boolean;
  /** 光标所在段落是否带段前分页符（驱动「分页符」菜单项高亮） */
  pageBreakBefore: boolean;
  insertTable: () => void;
  insertImage: () => void;
  clearFormat: () => void;
  toggleHfEdit: () => void;
  openExternal: () => void;
  convertMd: () => void;
  reload: () => void;
  /** 打印 / 导出 PDF（走系统打印面板；纸面几何已是打印成品的样子，不克隆 DOM） */
  printDoc: () => void;
}

export interface DocxCommand {
  /** 稳定 id（也是 React key） */
  id: string;
  tier: DocxTier;
  group: DocxGroup;
  /** 工具条分区（tier='primary' 必填） */
  toolSection?: DocxToolSection;
  /** tooltip 文案 */
  title: string;
  /** 菜单内文字标签（工具条不显示文字） */
  label?: string;
  /** 菜单内行号（**仅 tier='menu' 使用**：同组命令按行排布，缺省 1） */
  row?: number;
  /** 图标按钮 */
  icon?: ReactNode;
  /** 字形按钮（B / I / U / S），与 icon 二选一 */
  glyph?: string;
  /** 字形附加 class（font-bold / italic / underline / line-through） */
  glyphClass?: string;
  isActive?: (e: Editor | null, api: DocxCmdApi) => boolean;
  disabled?: (api: DocxCmdApi) => boolean;
  run: (e: Editor | null, api: DocxCmdApi) => void;
}

const ICON = 'h-3.5 w-3.5';

/** 当前列表类型（bullet / ordered / null）—— 与宿主 liKind 同一判据 */
function liKindOf(e: Editor | null): string | null {
  const a = e?.getAttributes('docxListItem');
  return a && a.listKind ? String(a.listKind) : null;
}

/** 当前 runFormat 属性（字体 / 字号 / 颜色 / 上下标） */
function vertAlignOf(e: Editor | null): string {
  return (e?.getAttributes('runFormat')?.vertAlign as string) || '';
}

/** 当前段落/标题是否处于某个对齐（与宿主 isAlign 同判据） */
function alignActive(e: Editor | null, v: string): boolean {
  return Boolean(e?.isActive('paragraph', { align: v }) || e?.isActive('heading', { align: v }));
}

export const DOCX_COMMANDS: DocxCommand[] = [
  /* ---------------- primary · 行内格式（Word 的字体组最常用四项） ---------------- */

  {
    id: 'bold',
    tier: 'primary',
    group: 'font',
    toolSection: 'inline',
    title: '加粗（⌘B）',
    label: '加粗',
    glyph: 'B',
    glyphClass: 'font-bold',
    isActive: (e) => Boolean(e?.isActive('strong')),
    run: (e) => e?.chain().focus().toggleMark('strong').run(),
  },
  {
    id: 'italic',
    tier: 'primary',
    group: 'font',
    toolSection: 'inline',
    title: '斜体（⌘I）',
    label: '斜体',
    glyph: 'I',
    glyphClass: 'italic',
    isActive: (e) => Boolean(e?.isActive('em')),
    run: (e) => e?.chain().focus().toggleMark('em').run(),
  },
  {
    id: 'underline',
    tier: 'primary',
    group: 'font',
    toolSection: 'inline',
    title: '下划线（⌘U）',
    label: '下划线',
    glyph: 'U',
    glyphClass: 'underline',
    isActive: (e) => Boolean(e?.isActive('underline')),
    run: (e) => e?.chain().focus().toggleMark('underline').run(),
  },
  {
    id: 'strike',
    tier: 'primary',
    group: 'font',
    toolSection: 'inline',
    title: '删除线',
    label: '删除线',
    glyph: 'S',
    glyphClass: 'line-through',
    isActive: (e) => Boolean(e?.isActive('strike')),
    run: (e) => e?.chain().focus().toggleMark('strike').run(),
  },

  /* ---------------- primary · 上标 / 下标（Word 也在字体组，但优先级低） ---------------- */

  {
    id: 'superscript',
    tier: 'primary',
    group: 'font',
    toolSection: 'script',
    title: '上标',
    label: '上标',
    icon: <Superscript className={ICON} />,
    isActive: (e) => vertAlignOf(e) === 'superscript',
    run: (e) => e?.chain().focus().setVertAlign('superscript').run(),
  },
  {
    id: 'subscript',
    tier: 'primary',
    group: 'font',
    toolSection: 'script',
    title: '下标',
    label: '下标',
    icon: <Subscript className={ICON} />,
    isActive: (e) => vertAlignOf(e) === 'subscript',
    run: (e) => e?.chain().focus().setVertAlign('subscript').run(),
  },

  /* ---------------- primary · 对齐（2026-10-02 由下拉还原为 4 个按钮） ---------------- */

  {
    id: 'alignLeft',
    tier: 'primary',
    group: 'paragraph',
    toolSection: 'align',
    title: '左对齐',
    label: '左对齐',
    icon: <AlignLeft className={ICON} />,
    isActive: (e) => alignActive(e, 'left'),
    run: (e) => e?.chain().focus().setTextAlign('left').run(),
  },
  {
    id: 'alignCenter',
    tier: 'primary',
    group: 'paragraph',
    toolSection: 'align',
    title: '居中',
    label: '居中',
    icon: <AlignCenter className={ICON} />,
    isActive: (e) => alignActive(e, 'center'),
    run: (e) => e?.chain().focus().setTextAlign('center').run(),
  },
  {
    id: 'alignRight',
    tier: 'primary',
    group: 'paragraph',
    toolSection: 'align',
    title: '右对齐',
    label: '右对齐',
    icon: <AlignRight className={ICON} />,
    isActive: (e) => alignActive(e, 'right'),
    run: (e) => e?.chain().focus().setTextAlign('right').run(),
  },
  {
    id: 'alignJustify',
    tier: 'primary',
    group: 'paragraph',
    toolSection: 'align',
    title: '两端对齐',
    label: '两端对齐',
    icon: <AlignJustify className={ICON} />,
    isActive: (e) => alignActive(e, 'justify'),
    run: (e) => e?.chain().focus().setTextAlign('justify').run(),
  },

  /* ---------------- primary · 列表（同样由下拉还原为按钮） ---------------- */

  {
    id: 'bulletList',
    tier: 'primary',
    group: 'paragraph',
    toolSection: 'list',
    title: '项目符号',
    label: '项目符号',
    icon: <List className={ICON} />,
    isActive: (e) => liKindOf(e) === 'bullet',
    run: (e) => e?.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'orderedList',
    tier: 'primary',
    group: 'paragraph',
    toolSection: 'list',
    title: '编号列表',
    label: '编号',
    icon: <ListOrdered className={ICON} />,
    isActive: (e) => liKindOf(e) === 'ordered',
    run: (e) => e?.chain().focus().toggleNumberedList().run(),
  },

  /* ---------------- primary · 段落缩进 ---------------- */

  {
    id: 'indentIncrease',
    tier: 'primary',
    group: 'paragraph',
    toolSection: 'paraIndent',
    title: '增加列表缩进（多级列表）',
    label: '增缩进',
    icon: <IndentIncrease className={ICON} />,
    run: (e) => e?.chain().focus().increaseListLevel().run(),
  },
  {
    id: 'indentDecrease',
    tier: 'primary',
    group: 'paragraph',
    toolSection: 'paraIndent',
    title: '减少列表缩进',
    label: '减缩进',
    icon: <IndentDecrease className={ICON} />,
    run: (e) => e?.chain().focus().decreaseListLevel().run(),
  },

  /* ---------------- primary · 分页符 / 清除格式 ---------------- */

  {
    id: 'pageBreak',
    tier: 'primary',
    group: 'paragraph',
    toolSection: 'paraMisc',
    title: '在当前段前插入 / 取消分页符',
    label: '分页符',
    icon: <SeparatorHorizontal className={ICON} />,
    isActive: (_e, api) => api.pageBreakBefore,
    run: (e) => e?.chain().focus().setPageBreak().run(),
  },
  {
    id: 'clearFormat',
    tier: 'primary',
    group: 'paragraph',
    toolSection: 'paraMisc',
    title: '清除格式',
    label: '清除格式',
    icon: <Eraser className={ICON} />,
    run: (_e, api) => api.clearFormat(),
  },

  /* ---------------- primary · 插入（Word 里在「插入」选项卡，这里优先级最低） ---------------- */

  {
    id: 'insertTable',
    tier: 'primary',
    group: 'insert',
    toolSection: 'insert',
    title: '插入表格',
    label: '表格',
    icon: <Table className={ICON} />,
    run: (_e, api) => api.insertTable(),
  },
  {
    id: 'insertImage',
    tier: 'primary',
    group: 'insert',
    toolSection: 'insert',
    title: '插入图片',
    label: '图片',
    icon: <FileImage className={ICON} />,
    run: (_e, api) => api.insertImage(),
  },

  /* ---------------- menu · 表格（仅在表格内显示，永不上工具条） ---------------- */

  {
    id: 'rowAdd',
    tier: 'menu',
    group: 'table',
    row: 1,
    title: '在下方插入行',
    label: '增行',
    icon: <Rows3 className={ICON} />,
    run: (e) => e?.chain().focus().addRowAfter().run(),
  },
  {
    id: 'rowDel',
    tier: 'menu',
    group: 'table',
    row: 1,
    title: '删除当前行',
    label: '删行',
    icon: <Rows3 className={ICON} />,
    run: (e) => e?.chain().focus().deleteRow().run(),
  },
  {
    id: 'colAdd',
    tier: 'menu',
    group: 'table',
    row: 2,
    title: '在右侧插入列',
    label: '增列',
    icon: <Columns3 className={ICON} />,
    run: (e) => e?.chain().focus().addColumnAfter().run(),
  },
  {
    id: 'colDel',
    tier: 'menu',
    group: 'table',
    row: 2,
    title: '删除当前列',
    label: '删列',
    icon: <Columns3 className={ICON} />,
    run: (e) => e?.chain().focus().deleteColumn().run(),
  },

  /* ---------------- menu · 剪贴板 ---------------- */

  {
    id: 'paste',
    tier: 'menu',
    group: 'clipboard',
    title: '粘贴（也可直接用 ⌘V）',
    label: '粘贴',
    icon: <ClipboardPaste className={ICON} />,
    run: (e) => {
      e?.commands.focus();
      try {
        document.execCommand('paste');
      } catch {
        /* 浏览器可能限制脚本粘贴，用户可用快捷键 */
      }
    },
  },
  {
    id: 'cut',
    tier: 'menu',
    group: 'clipboard',
    title: '剪切',
    label: '剪切',
    icon: <Scissors className={ICON} />,
    run: (e) => {
      e?.commands.focus();
      document.execCommand('cut');
    },
  },
  {
    id: 'copy',
    tier: 'menu',
    group: 'clipboard',
    title: '复制',
    label: '复制',
    icon: <Copy className={ICON} />,
    run: (e) => {
      e?.commands.focus();
      document.execCommand('copy');
    },
  },

  /* ---------------- menu · 视图 ---------------- */

  {
    id: 'toggleHfEdit',
    tier: 'menu',
    group: 'view',
    title: '编辑 / 完成页眉页脚',
    label: '页眉页脚',
    icon: <Pilcrow className={ICON} />,
    isActive: (_e, api) => api.hfEdit,
    run: (_e, api) => api.toggleHfEdit(),
  },

  /* ---------------- menu · 文件 ---------------- */

  {
    id: 'printDoc',
    tier: 'menu',
    group: 'file',
    title: '打印 / 导出 PDF（系统打印面板，可选「存储为 PDF」）',
    label: '打印 / PDF',
    icon: <Printer className={ICON} />,
    disabled: (api) => api.loading,
    run: (_e, api) => api.printDoc(),
  },
  {
    id: 'openExternal',
    tier: 'menu',
    group: 'file',
    title: '用系统默认程序打开',
    label: '外部打开',
    icon: <ExternalLink className={ICON} />,
    disabled: (api) => api.loading || !api.hasPath,
    run: (_e, api) => api.openExternal(),
  },
  {
    id: 'convertMd',
    tier: 'menu',
    group: 'file',
    title: '转为 Markdown 存入 homework',
    label: '转 MD',
    icon: <FileDown className={ICON} />,
    disabled: (api) => api.loading || api.converting,
    run: (_e, api) => api.convertMd(),
  },
  {
    id: 'reload',
    tier: 'menu',
    group: 'file',
    title: '重新载入原文件（放弃未保存改动）',
    label: '重载',
    icon: <RotateCcw className={ICON} />,
    disabled: (api) => api.loading,
    run: (_e, api) => api.reload(),
  },
];

/** 按落点层级取命令（⋯ 菜单取数入口；工具条另见宿主的分区布局） */
export function commandsOfTier(tier: DocxTier): DocxCommand[] {
  return DOCX_COMMANDS.filter((c) => c.tier === tier);
}

/** 按分区取 menu 命令（保持 DOCX_COMMANDS 中的声明顺序） */
export function commandsOfGroup(group: DocxGroup): DocxCommand[] {
  return DOCX_COMMANDS.filter((c) => c.tier === 'menu' && c.group === group);
}

/** 按工具条分区取 primary 命令（保持声明顺序 = 工具条展示顺序） */
export function commandsOfToolSection(section: DocxToolSection): DocxCommand[] {
  return DOCX_COMMANDS.filter((c) => c.tier === 'primary' && c.toolSection === section);
}

export { liKindOf };
