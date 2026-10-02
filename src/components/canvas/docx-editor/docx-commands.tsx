'use client';

/**
 * docx 编辑器命令表 —— 工具栏的**唯一真源**
 *
 * 背景（2026-10-01 整改）：
 *   整改前同一个命令在两处各写一份 JSX —— 单行工具条（DocxTiptapEditor `L1668-1751`）
 *   与 ⋯ 溢出菜单（`L1363-1556`）。宽屏（panelW ≥ WIDE_TOOLBAR_MIN）时两份同时可达，
 *   打开 ⋯ 菜单能看到字体 / 字号 / B I U S / 四种对齐 / 列表 / 缩进 全是副本；
 *   且改一处漏一处（加命令要改两个地方）。
 *
 * 整改后：命令只在这里定义一次，渲染层按 `tier` 过滤：
 *   · tier='primary' → 任何面板宽度都常驻工具条（不再出现在菜单里）
 *   · tier='menu'    → 只在 ⋯ 菜单里出现（工具条无落点）
 *   下拉类控件（字体 / 字号 / 样式 / 对齐 / 列表）另见宿主里的 `renderXxxSelect()`
 *   单一实现 + 宽窄档条件渲染，保证同一控件不会同屏出现两次。
 *
 * 判据（整改后自检）：
 *   · `DocxTiptapEditor.tsx` 内 `<ToolBtn` / `<MenuBtn` 各只剩 1 处（都在 renderCmd 里）；
 *   · 命令动作（如 `toggleMark('strong')`）在宿主里为 0 处，只在本文件出现 1 次。
 */

import type { Editor } from '@tiptap/react';
import type { ReactNode } from 'react';
import {
  ClipboardPaste,
  Columns3,
  Copy,
  Eraser,
  ExternalLink,
  FileDown,
  FileImage,
  IndentDecrease,
  IndentIncrease,
  Pilcrow,
  RotateCcw,
  Rows3,
  Scissors,
  SeparatorHorizontal,
  Subscript,
  Superscript,
  Table,
} from 'lucide-react';

/** 命令的落点层级：primary = 工具条常驻；menu = 仅 ⋯ 菜单 */
export type DocxTier = 'primary' | 'menu';

/** 菜单分区归属（工具条不分区，靠 ToolSep 手工分组） */
export type DocxGroup = 'font' | 'paragraph' | 'insert' | 'table' | 'clipboard' | 'view' | 'file';

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
}

export interface DocxCommand {
  /** 稳定 id（也是 React key） */
  id: string;
  tier: DocxTier;
  group: DocxGroup;
  /** tooltip 文案 */
  title: string;
  /** 菜单内文字标签（工具条不显示文字） */
  label?: string;
  /** 菜单内行号（同组命令按行排布，缺省 1） */
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

export const DOCX_COMMANDS: DocxCommand[] = [
  /* ---------------- primary：工具条常驻（任何宽度） ---------------- */

  {
    id: 'bold',
    tier: 'primary',
    group: 'font',
    title: '加粗（⌘B）',
    glyph: 'B',
    glyphClass: 'font-bold',
    isActive: (e) => Boolean(e?.isActive('strong')),
    run: (e) => e?.chain().focus().toggleMark('strong').run(),
  },
  {
    id: 'italic',
    tier: 'primary',
    group: 'font',
    title: '斜体（⌘I）',
    glyph: 'I',
    glyphClass: 'italic',
    isActive: (e) => Boolean(e?.isActive('em')),
    run: (e) => e?.chain().focus().toggleMark('em').run(),
  },
  {
    id: 'underline',
    tier: 'primary',
    group: 'font',
    title: '下划线（⌘U）',
    glyph: 'U',
    glyphClass: 'underline',
    isActive: (e) => Boolean(e?.isActive('underline')),
    run: (e) => e?.chain().focus().toggleMark('underline').run(),
  },
  {
    id: 'strike',
    tier: 'primary',
    group: 'font',
    title: '删除线',
    glyph: 'S',
    glyphClass: 'line-through',
    isActive: (e) => Boolean(e?.isActive('strike')),
    run: (e) => e?.chain().focus().toggleMark('strike').run(),
  },

  /* ---------------- menu · 字体 ---------------- */

  {
    id: 'superscript',
    tier: 'menu',
    group: 'font',
    title: '上标',
    label: '上标',
    icon: <Superscript className={ICON} />,
    isActive: (e) => vertAlignOf(e) === 'superscript',
    run: (e) => e?.chain().focus().setVertAlign('superscript').run(),
  },
  {
    id: 'subscript',
    tier: 'menu',
    group: 'font',
    title: '下标',
    label: '下标',
    icon: <Subscript className={ICON} />,
    isActive: (e) => vertAlignOf(e) === 'subscript',
    run: (e) => e?.chain().focus().setVertAlign('subscript').run(),
  },

  /* ---------------- menu · 插入 ---------------- */

  {
    id: 'insertTable',
    tier: 'menu',
    group: 'insert',
    title: '插入表格',
    label: '表格',
    icon: <Table className={ICON} />,
    run: (_e, api) => api.insertTable(),
  },
  {
    id: 'insertImage',
    tier: 'menu',
    group: 'insert',
    title: '插入图片',
    label: '图片',
    icon: <FileImage className={ICON} />,
    run: (_e, api) => api.insertImage(),
  },

  /* ---------------- menu · 段落 ---------------- */

  {
    id: 'indentIncrease',
    tier: 'menu',
    group: 'paragraph',
    row: 1,
    title: '增加列表缩进（多级列表）',
    label: '增缩进',
    icon: <IndentIncrease className={ICON} />,
    run: (e) => e?.chain().focus().increaseListLevel().run(),
  },
  {
    id: 'indentDecrease',
    tier: 'menu',
    group: 'paragraph',
    row: 1,
    title: '减少列表缩进',
    label: '减缩进',
    icon: <IndentDecrease className={ICON} />,
    run: (e) => e?.chain().focus().decreaseListLevel().run(),
  },
  {
    id: 'pageBreak',
    tier: 'menu',
    group: 'paragraph',
    row: 2,
    title: '在当前段前插入 / 取消分页符',
    label: '分页符',
    icon: <SeparatorHorizontal className={ICON} />,
    isActive: (_e, api) => api.pageBreakBefore,
    run: (e) => e?.chain().focus().setPageBreak().run(),
  },
  {
    id: 'clearFormat',
    tier: 'menu',
    group: 'paragraph',
    row: 2,
    title: '清除格式',
    label: '清除格式',
    icon: <Eraser className={ICON} />,
    run: (_e, api) => api.clearFormat(),
  },

  /* ---------------- menu · 表格（仅在表格内显示） ---------------- */

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

/** 按落点层级取命令（工具条 / 菜单的唯一取数入口） */
export function commandsOfTier(tier: DocxTier): DocxCommand[] {
  return DOCX_COMMANDS.filter((c) => c.tier === tier);
}

/** 按分区取菜单命令（保持 DOCX_COMMANDS 中的声明顺序） */
export function commandsOfGroup(group: DocxGroup): DocxCommand[] {
  return DOCX_COMMANDS.filter((c) => c.tier === 'menu' && c.group === group);
}

export { liKindOf };
