'use client';

// 核心富文本编辑器组件：基于 Tiptap，支持 Markdown 双向解析、工具栏、自动保存、AI 内联气泡（复制/发送到节点）

// highlight.js 语言子模块缺少独立类型声明，补充 ambient 声明以通过 strict 模式
declare module 'highlight.js/lib/languages/*';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { Extension, type JSONContent } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { DOMParser as PMDOMParser, type Node as PMNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import TurndownService from 'turndown';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { createResizableImage } from './extensions/ResizableImage';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Highlight from '@tiptap/extension-highlight';
import { Markdown } from 'tiptap-markdown';
import { createLowlight } from 'lowlight';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdownLang from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import 'highlight.js/styles/github.css';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Code2,
  Minus,
  GripVertical,
  Columns2,
  Columns3,
  Link as LinkIcon,
  Image as ImageIcon,
  RotateCcw,
  RotateCw,
  X,
  ListTree,
  FileText,
  Package,
  ChevronDown,
  Heading,
  CheckSquare,
  MessageSquare,
  Printer,
  Share2,
  Search,
  Wand2,
  Trash2,
  Table as TableIcon,
  AlertTriangle,
  AlignLeft,
} from 'lucide-react';
import { AnnotationBubble, mdSelTempKey } from './extensions/AnnotationBubble';
import { Button } from '@/components/ui/button';
import { MermaidCodeBlock } from './extensions/MermaidCodeBlock';
import { CollapsibleHeading } from './extensions/CollapsibleHeading';
import { MdEmbed } from './extensions/MdEmbed';
import { LinkCard } from './extensions/LinkCard';
import { bus, BusEvents } from '@/lib/bus';
import { showImageAiEditToast } from '@/lib/image-ai-edit-runtime';
import { extractQuestionnaires, QuestionnairePanel, type QuestionnaireBlock } from './QuestionnairePanel';
import { ExportDocxDialog } from './ExportDocxDialog';
import { ExportMenu } from './ExportMenu';
import { convertMarkdownToDocx, type DocxExportConfig } from '@/lib/md-to-docx';
import { MdAnnotationPanel, ANNOTATION_INTENTS, type MdAnnotation, type AnnotationIntent, type Revision, type RevisionRound, type RevisionOp, type ReviseReport } from './MdAnnotationPanel';
import { MdSemanticNav } from './MdSemanticNav';
import type { ConsistencyItem } from '@/lib/md-consistency/check';
// track-changes：AI 修订注入为原生 ProseMirror mark（替代文本标记模拟），接受/拒绝/读取原生支持
import { TrackChangesExtension } from 'tiptap-track-changes';
// 块级拖拽把手为自研组件（BlockDragHandle），见文件底部定义；替换原 TipTap 第三方扩展
// 多栏容器 MVP：两栏/三栏并排编辑，markdown 以自定义 fence 往返
import { BobColumn, BobColumns } from './extensions/MultiColumn';

// ============================================================
// lowlight 实例：注册常用编程语言用于代码块语法高亮
// ============================================================
const lowlight = createLowlight();
lowlight.register('typescript', typescript);
lowlight.register('ts', typescript);
lowlight.register('javascript', javascript);
lowlight.register('js', javascript);
lowlight.register('python', python);
lowlight.register('py', python);
lowlight.register('bash', bash);
lowlight.register('sh', bash);
lowlight.register('json', json);
lowlight.register('css', css);
lowlight.register('xml', xml);
lowlight.register('html', xml);
lowlight.register('markdown', markdownLang);
lowlight.register('md', markdownLang);
lowlight.register('sql', sql);
lowlight.register('go', go);
lowlight.register('rust', rust);
lowlight.register('rs', rust);

export interface DocEditorProps {
  /** markdown 内容（已剥离 frontmatter） */
  content: string;
  /** 节点 ID（用于保存到 .md） */
  nodeMdId?: string | null;
  /** 文件路径（用于保存到项目文件系统） */
  filePath?: string;
  /** 项目 ID（配合 filePath 使用） */
  projectId?: string;
  /** 是否可编辑，默认 true */
  editable?: boolean;
  /** 文件来源（配合 filePath 决定保存通道：project → 项目 write_file；local → 本地文件 write） */
  source?: string;
  /** 可选：文档标题。打印时用作默认文件名「标题_v1_年月日」；缺省时回退文件名、再回退 document */
  docTitle?: string;
  /** 可选：隐藏目录按钮与左侧目录栏（如嵌入节点对话框时）；默认显示 */
  hideToc?: boolean;
  /** 可选：绑定到笔记库条目（notes/wiki/{id}.md），保存走 /api/notebook entry_id 通道 */
  notebookEntryId?: string;
  /** 内容变化回调（markdown 字符串） */
  onChange?: (md: string) => void;
  /** 手动保存回调 */
  onSave?: (md: string) => void;
}

type SaveStatus = 'saved' | 'saving' | 'unsaved';

/** tiptap-markdown 在 editor.storage 上注入的 markdown 存储对象类型 */
interface MarkdownStorage {
  getMarkdown: () => string;
  /** 运行时存在（类型声明未覆盖）：markdown 片段 → ProseMirror Node（含 toJSON） */
  parser?: { parse: (md: string) => { toJSON: () => JSONContent } };
}

/** 批注高亮：被批注的文字在正文中保持黄色高亮（取消选中也不消失）。
 *  用 ProseMirror Decoration（inline decoration）标记，避免直接改 DOM class 触发 mutation 重建。 */
const mdAnnotationSelKey = new PluginKey<DecorationSet>('mdAnnotationHighlight');

/** 建立「纯文本偏移 → doc 位置」映射（全文检索 / 批注锚定共用，避免各写一份而口径漂移）。
 *  纯文本 = 各文本节点内容依次拼接，块边界与行内叶节点（硬换行/行内图片）各占 1 个 '\n'；
 *  posOf[i] = 第 i 个字符的 doc 位置，-1 = 占位符（该位置不对应文档里的真实字符）。 */
function buildTextPosMap(doc: PMNode): { text: string; posOf: number[] } {
  let text = '';
  const posOf: number[] = [];
  let firstBlock = true;
  doc.descendants((node, pos) => {
    if (node.isText) {
      const t = node.text ?? '';
      for (let i = 0; i < t.length; i++) posOf.push(pos + i);
      text += t;
      return false;
    }
    if (node.isInline && node.isLeaf) {
      // 行内叶节点（硬换行 / 行内图片）：不贡献文本，占 1 位防止匹配跨越它
      text += '\n';
      posOf.push(-1);
      return false;
    }
    if (node.isTextblock) {
      if (firstBlock) firstBlock = false;
      else { text += '\n'; posOf.push(-1); }
    }
    return true;
  });
  return { text, posOf };
}

/** 统一批注定位（W3C TextQuoteSelector 思路，Hypothesis 同款）：
 *  ① from/to 精确位置（有效且该处文本与 quote 匹配）→ 直接用；
 *  ② 失效/无位置 → quote + prefix/suffix 上下文锚定（只匹配一处，杜绝重复文本跳错）；
 *  ③ 返回 null 表示无法定位（文档已被大幅改写）。
 *  高亮 / 卡片跳转 / AI 重写三处共用，消除此前"高亮全匹配、跳转第一处"的行为分裂。
 *  位置换算走 buildTextPosMap：早前用「textBetween(…, '\n') 索引 + 1」近似，
 *  块边界在文本里占 1 个字符、在文档位置里不存在，长文档下会累计偏移（跳错段）。 */
function findQuoteWithContext(doc: PMNode, quote: string, prefix?: string, suffix?: string): { from: number; to: number } | null {
  if (!quote) return null;
  const { text: fullText, posOf } = buildTextPosMap(doc);
  /** 命中偏移 → doc 位置：取区间内首个/末个真实字符位置；整段都落在占位符上则丢弃 */
  const toDocRange = (idx: number): { from: number; to: number } | null => {
    const end = idx + quote.length;
    let from = -1;
    let to = -1;
    for (let i = idx; i < end; i++) if (posOf[i] >= 0) { from = posOf[i]; break; }
    for (let i = end - 1; i >= idx; i--) if (posOf[i] >= 0) { to = posOf[i] + 1; break; }
    if (from < 0 || to < 0 || to <= from) return null;
    return { from, to };
  };
  const ctxLen = 32;
  let idx = fullText.indexOf(quote);
  while (idx >= 0) {
    const before = fullText.slice(Math.max(0, idx - ctxLen), idx);
    const after = fullText.slice(idx + quote.length, idx + quote.length + ctxLen);
    const ctxOk =
      (!prefix || before.includes(prefix) || prefix.includes(before)) &&
      (!suffix || after.includes(suffix) || suffix.includes(after));
    if (ctxOk) {
      const r = toDocRange(idx);
      if (r) return r;
    }
    idx = fullText.indexOf(quote, idx + 1);
  }
  // 无上下文约束（旧批注无 prefix/suffix）→ 返回首个匹配作为兜底（保持原有行为）
  if (!prefix && !suffix) {
    const idx2 = fullText.indexOf(quote);
    if (idx2 >= 0) {
      const r = toDocRange(idx2);
      if (r) return r;
    }
  }
  return null;
}

/** 纯文本索引 → 文档位置（精确）。
 *  项目里常见写法是「textBetween(…, '\n') 的索引 + 1」，但每个块边界在文档位置里占 2 个、
 *  在文本里只占 1 个，长文档下累计偏差可达一整段（跳转到相邻段落）。这里用二分查真实位置：
 *  textBetween(0, pos, '')（无块分隔符）的长度对 pos 单调不减，取首个长度 ≥ index+1 的位置。 */
function posAtTextIndex(doc: PMNode, index: number): number | null {
  const size = doc.content.size;
  if (index < 0 || index >= size) return null;
  let lo = 0;
  let hi = size;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (doc.textBetween(0, mid, '').length >= index + 1) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function resolveAnnotationPos(editor: Editor, a: MdAnnotation): { from: number; to: number } | null {
  const doc = editor.state.doc;
  const docSize = doc.content.size;
  if (typeof a.from === 'number' && typeof a.to === 'number' && a.from >= 1 && a.to <= docSize && a.from < a.to) {
    const atQuote = doc.textBetween(a.from, a.to, '\n');
    if (atQuote === a.quote || atQuote.trim() === a.quote || atQuote.includes(a.quote)) {
      return { from: a.from, to: a.to };
    }
  }
  return findQuoteWithContext(doc, a.quote, a.prefix, a.suffix);
}

const mdAnnotationSelPlugin = new Plugin<DecorationSet>({
  key: mdAnnotationSelKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      // 通过 tr.setMeta 更新高亮装饰；文档变化时跟随 mapping 移动
      const meta = tr.getMeta(mdAnnotationSelKey);
      if (meta) return meta as DecorationSet;
      return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
    },
  },
  props: {
    decorations(state) {
      return mdAnnotationSelKey.getState(state);
    },
  },
});

/** 批注高亮扩展：注册 mdAnnotationSelPlugin */
const MdAnnotationHighlight = Extension.create({
  name: 'mdAnnotationHighlight',
  addProseMirrorPlugins() {
    return [mdAnnotationSelPlugin];
  },
});

/** 临时选区高亮插件：批注气泡编辑期间（编辑器失焦）保持选中文字高亮；气泡隐藏时清空 */
const mdSelTempPlugin = new Plugin<DecorationSet>({
  key: mdSelTempKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(mdSelTempKey);
      if (meta) return meta as DecorationSet;
      return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
    },
  },
  props: {
    decorations(state) {
      return mdSelTempKey.getState(state);
    },
  },
});

/** 临时选区高亮扩展：注册 mdSelTempPlugin */
const MdSelTempHighlight = Extension.create({
  name: 'mdSelTempHighlight',
  addProseMirrorPlugins() {
    return [mdSelTempPlugin];
  },
});

/** 修订聚焦高亮 key：点击修订视图中的某条修订 → 正文定位并高亮被修改处；切换轮次/接受拒绝后跟随重新定位 */
const mdRevisionFocusKey = new PluginKey<DecorationSet>('mdRevisionFocus');

/** 修订聚焦高亮插件 */
const mdRevisionFocusPlugin = new Plugin<DecorationSet>({
  key: mdRevisionFocusKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(mdRevisionFocusKey);
      if (meta) return meta as DecorationSet;
      return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
    },
  },
  props: {
    decorations(state) {
      return mdRevisionFocusKey.getState(state);
    },
  },
});

/** 修订聚焦高亮扩展：注册 mdRevisionFocusPlugin */
const MdRevisionFocusHighlight = Extension.create({
  name: 'mdRevisionFocusHighlight',
  addProseMirrorPlugins() {
    return [mdRevisionFocusPlugin];
  },
});

/** 便签反向定位高亮 key：点击便签子弹图标 → 打开文档并滚动高亮划词出处（2s 后自动清除） */
const mdLocateKey = new PluginKey<DecorationSet>('mdLocateFlash');

/** 便签反向定位高亮插件 */
const mdLocatePlugin = new Plugin<DecorationSet>({
  key: mdLocateKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(mdLocateKey);
      if (meta) return meta as DecorationSet;
      return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
    },
  },
  props: {
    decorations(state) {
      return mdLocateKey.getState(state);
    },
  },
});

/** 便签反向定位高亮扩展：注册 mdLocatePlugin */
const MdLocateFlashHighlight = Extension.create({
  name: 'mdLocateFlashHighlight',
  addProseMirrorPlugins() {
    return [mdLocatePlugin];
  },
});

/** 查找替换高亮 key：⌘F 查找栏实时高亮所有匹配（当前项高亮不同色） */
const findDecoKey = new PluginKey<DecorationSet>('mdFindHighlight');

/** 查找替换高亮插件（机制与 mdLocateFlash 一致：meta 注入 DecorationSet，文档变更时自动映射） */
const findDecoPlugin = new Plugin<DecorationSet>({
  key: findDecoKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(findDecoKey);
      if (meta) return meta as DecorationSet;
      return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
    },
  },
  props: {
    decorations(state) {
      return findDecoKey.getState(state);
    },
  },
});

/** 查找替换高亮扩展 */
const MdFindHighlight = Extension.create({
  name: 'mdFindHighlight',
  addProseMirrorPlugins() {
    return [findDecoPlugin];
  },
});

/** 定位修订的被修改处：优先匹配修订后文字，其次修订前文字；
 *  表格等结构化修订（渲染后文本与 markdown 源不一致，textBetween 匹配不到）→
 *  用该轮 diff 的 preContext 锚定位到改动块。 */
function locateRevision(
  editor: Editor,
  round: RevisionRound | undefined,
  oldText: string,
  newText: string,
): { from: number; to: number } | null {
  const doc = editor.state.doc;
  const fullText = doc.textBetween(0, doc.content.size, '\n');
  let idx = newText ? fullText.indexOf(newText) : -1;
  if (idx >= 0) return { from: idx + 1, to: idx + 1 + newText.length };
  idx = oldText ? fullText.indexOf(oldText) : -1;
  if (idx >= 0) return { from: idx + 1, to: idx + 1 + oldText.length };
  // 锚点回退：改动点前的 preContext 应仍在文档中，从其尾部定位到改动块
  const ctx = round?.patch?.preContext;
  if (ctx) {
    const cIdx = fullText.lastIndexOf(ctx);
    if (cIdx >= 0) {
      const anchor = cIdx + ctx.length;
      const maxPos = doc.content.size;
      if (anchor >= maxPos) return { from: Math.max(1, maxPos - 1), to: maxPos };
      const $pos = doc.resolve(anchor);
      const blockEnd = $pos.end($pos.depth);
      return { from: anchor, to: Math.max(anchor + 1, blockEnd) };
    }
  }
  return null;
}

/** 从编辑器 storage 中安全获取 markdown 字符串（tiptap-markdown 扩展注入），
 *  并清洗 track-changes mark 的 HTML 序列化 → 结果态 md（插入保留、删除移除） */
function getMarkdown(editor: Editor): string {
  const md = (editor.storage as unknown as { markdown?: MarkdownStorage }).markdown?.getMarkdown() ?? '';
  return stripRevisionHtml(md);
}

/** 剥离 YAML frontmatter（与 MdViewer 口径一致），用于外部变更重载 / 冲突对比时还原正文 */
function stripFrontmatterLocal(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return raw;
  return raw.slice(end + 4).replace(/^\s*\n/, '');
}

/** 行级 LCS diff（用于冲突「查看差异」面板）；仅在有明显差异时被调用，长文按需截断避免 O(n*m) 失控 */
function lineDiff(oldText: string, newText: string): { type: 'same' | 'add' | 'del'; text: string }[] {
  const MAX = 2000;
  const a = oldText.split('\n').slice(0, MAX);
  const b = newText.split('\n').slice(0, MAX);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: { type: 'same' | 'add' | 'del'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

/** HTML 转义（md → HTML 片段转换的第一步） */
function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 行内 markdown → HTML：支持 **bold**、*italic*、`code`、[link](url)
 * 用于 AI 修改替换（保持行内格式）
 */
function inlineMdToHtml(s: string): string {
  let out = escapeHtmlText(s);
  out = out.replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, c: string) => `<strong>${c}</strong>`);
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, (_m, p: string, c: string) => `${p}<em>${c}</em>`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u}" rel="noopener">${t}</a>`);
  return out;
}

/** 修订标记解析：把 AI 返回的带标记 md（~~删除~~ / <ins>新增</ins>）切分成文本段 + 修订 token 段。
 *  用「切分 + 段索引」而非纯文本替换，避免相同 token 文本多处出现时误替换。 */
interface RevSegment {
  kind: 'text' | 'delete' | 'insert';
  content: string;
  /** 对应 revisions 数组下标（text 段无此字段） */
  revIndex?: number;
}

/** track-changes mark attrs 工厂 */
function markAttrs(changeId: string): { changeId: string; authorId: string; authorName: string; authorColor: string; timestamp: string } {
  return {
    changeId,
    authorId: 'ai',
    authorName: 'AI',
    authorColor: '#4b3fe3',
    timestamp: new Date().toISOString(),
  };
}

/** track-changes 命令（包的类型声明未覆盖 acceptChange/rejectChange/acceptAll/rejectAll，运行时存在） */
function trackCmds(editor: Editor) {
  return editor.commands as unknown as {
    acceptChange: (id: string) => boolean;
    rejectChange: (id: string) => boolean;
    acceptAll: () => boolean;
    rejectAll: () => boolean;
  };
}

/** 按 ops 重放一轮修订：setContent(baseMd) 后，pending 注入 mark、accepted 应用、rejected 忽略。
 *  替换（delete+insert 同 changeId 相邻）原子处理；定位基于各 op 的 locate 锚。 */
function replayOps(editor: Editor, baseMd: string, ops: RevisionOp[]): void {
  editor.commands.setContent(baseMd);
  const { state } = editor;
  const tr = state.tr;
  const docText = state.doc.textBetween(0, state.doc.content.size, '\n');
  let searchFrom = 0;
  let docPos = 1;
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    const locate = op.locate;
    if (!locate) {
      i++;
      continue;
    }
    const idx = docText.indexOf(locate, searchFrom);
    if (idx < 0) {
      i++;
      continue;
    }
    docPos += idx - searchFrom;
    searchFrom = idx + locate.length;
    const next = ops[i + 1];
    const isReplace = op.kind === 'delete' && !!next && next.kind === 'insert' && next.changeId === op.changeId;
    if (isReplace) {
      const insText = next.text;
      if (op.status === 'pending') {
        tr.addMark(docPos, docPos + locate.length, state.schema.marks.deletion.create(markAttrs(op.changeId)));
        tr.insert(docPos + locate.length, state.schema.text(insText, [state.schema.marks.insertion.create(markAttrs(op.changeId))]));
      } else if (op.status === 'accepted') {
        tr.delete(docPos, docPos + locate.length);
        tr.insert(docPos, state.schema.text(insText));
      } // rejected：保留原文，不插入
      docPos += locate.length;
      i += 2;
      continue;
    }
    if (op.kind === 'delete') {
      if (op.status === 'pending') {
        tr.addMark(docPos, docPos + locate.length, state.schema.marks.deletion.create(markAttrs(op.changeId)));
        docPos += locate.length;
      } else if (op.status === 'accepted') {
        tr.delete(docPos, docPos + locate.length);
        // 删除后游标不前进（后续 locate 在删除后文本中，docPos 已在删除起点）
      } // rejected：保留，游标前进
    } else {
      const at = op.insertBefore ? docPos : docPos + locate.length;
      if (op.status === 'pending') {
        tr.insert(at, state.schema.text(op.text, [state.schema.marks.insertion.create(markAttrs(op.changeId))]));
      } else if (op.status === 'accepted') {
        tr.insert(at, state.schema.text(op.text));
      } // rejected：不插
      docPos += locate.length;
    }
    i++;
  }
  editor.view.dispatch(tr);
}

/** 保存链路：把带 track-changes mark 的序列化结果清洗为「结果态 md」（插入保留、删除移除） */
function stripRevisionHtml(md: string): string {
  return md
    .replace(/<ins\b[^>]*>([\s\S]*?)<\/ins>/g, '$1')
    .replace(/<del\b[^>]*>[\s\S]*?<\/del>/g, '');
}

/** 根据修订状态，从 segments 生成当前应显示的 md。
 *  pending/accepted → 应用修订（删除隐藏、新增保留）；rejected → 还原（删除保留、新增隐藏）。 */
function renderRevisedMd(segments: RevSegment[], revisions: Revision[]): string {
  let out = '';
  for (const seg of segments) {
    if (seg.kind === 'text') {
      out += seg.content;
    } else {
      const rev = seg.revIndex !== undefined ? revisions[seg.revIndex] : undefined;
      const rejected = rev?.status === 'rejected';
      if (seg.kind === 'delete') {
        out += rejected ? seg.content : '';
      } else {
        out += rejected ? '' : seg.content;
      }
    }
  }
  return out;
}

/** 局部替换 diff：取「修改前/后」的最长公共前后缀，中间段即差异（oldText → newText） */
function diffPatch(before: string, after: string): { oldText: string; newText: string; preLen: number } {
  let pre = 0;
  while (pre < before.length && pre < after.length && before[pre] === after[pre]) pre++;
  let suf = 0;
  while (
    suf < before.length - pre &&
    suf < after.length - pre &&
    before[before.length - 1 - suf] === after[after.length - 1 - suf]
  ) {
    suf++;
  }
  return {
    oldText: before.slice(pre, before.length - suf),
    newText: after.slice(pre, after.length - suf),
    preLen: pre,
  };
}

/** 插入图片：上传成功后插入。有 pos 时插入到指定位置，否则插入到当前选区 */
async function insertPastedImage(
  view: EditorView,
  file: Blob,
  upload: (f: Blob) => Promise<string | null>,
  pos?: number,
): Promise<void> {
  const src = await upload(file);
  if (!src) {
    alert('Image upload failed, could not insert');
    return;
  }
  const node = view.state.schema.nodes.image?.create({ src });
  if (!node) {
    alert('This document does not support image insertion');
    return;
  }
  if (typeof pos === 'number') {
    view.dispatch(view.state.tr.insert(pos, node));
  } else {
    view.dispatch(view.state.tr.replaceSelectionWith(node));
  }
}

/** dataURL → Blob（粘贴网页中的图片时用） */
function dataUrlToBlob(dataUrl: string): Blob | null {
  const m = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!m) return null;
  const mime = m[1] || 'image/png';
  const raw = m[3];
  const bytes = m[2]
    ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(raw));
  return new Blob([bytes], { type: mime });
}

// ============================================================
// 网页富文本粘贴 → 干净 Markdown
// 从浏览器/网页复制的带样式 HTML 粘贴进编辑器，默认会被 ProseMirror 解析为
// 带内联样式的脏节点。这里把非本地(无 data-pm-slice)的富文本 HTML 转回纯 Markdown，
// 再走 tiptap-markdown 同源解析插入，保证粘贴内容与手写/文档其余部分风格一致。
// ============================================================

/** 剪贴板 HTML 是否携带真实富文本结构（排除纯文本复制时浏览器附带的转义 HTML） */
function isRichClipboardHtml(html: string): boolean {
  return /<(a|p|div|span|h[1-6]|ul|ol|li|img|strong|b|em|i|blockquote|pre|code|br)\b[\s>]/i.test(html);
}

/** turndown 单例（HTML → Markdown） */
let turndownService: TurndownService | null = null;
function getTurndownService(): TurndownService {
  if (!turndownService) {
    turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined',
      hr: '---',
    });
    // 网页容器类噪声节点（导航/脚本/隐藏样式/内嵌框架）直接丢弃，不进入正文
    turndownService.remove(['script', 'style', 'noscript', 'iframe', 'template']);
  }
  return turndownService;
}

/**
 * 网页 HTML → 干净 Markdown 文本；转换后为空返回 null（调用方不拦截、回退默认粘贴）。
 * 表格不在此处理：turndown 不产出 GFM 表格，由默认 HTML 粘贴接管（编辑器原生支持表格）。
 */
function cleanWebHtmlToMarkdown(html: string): string | null {
  const md = getTurndownService().turndown(html).trim();
  return md || null;
}

/**
 * 将 Markdown 片段解析为编辑器可识别的切片并替换当前选区。
 * 复用 tiptap-markdown 的 parser（与文档初始解析同源，兼容 mdEmbed 等自定义扩展的 markdown 规则）。
 */
function insertMarkdownSlice(editor: Editor, view: EditorView, md: string): boolean {
  const parser = (editor.storage as { markdown?: { parser?: { parse: (c: string, o?: { inline?: boolean }) => string } } }).markdown?.parser;
  if (!parser) return false;
  try {
    const html = parser.parse(md);
    if (!html.trim()) return false;
    const container = document.createElement('div');
    container.innerHTML = html;
    const slice = PMDOMParser.fromSchema(editor.schema).parseSlice(container, { preserveWhitespace: true });
    view.dispatch(view.state.tr.replaceSelection(slice));
    return true;
  } catch {
    return false;
  }
}

/** 跑偏检测：AI 修改输出与批注引用文字的相关性兜底校验。
 *  若输出几乎不含原文字符（覆盖率 < 15%）且长度远超原文（> 1.5 倍），
 *  判定模型改写了别处内容（"改到别处"），应还原。 */
function revisionDrifted(text: string, quote: string): boolean {
  const t = text.trim().replace(/\s+/g, '');
  const q = quote.trim().replace(/\s+/g, '');
  if (!q || !t) return false;
  if (t === q) return false;
  const qChars = new Set(q.split(''));
  let hits = 0;
  for (const c of qChars) if (t.includes(c)) hits++;
  const coverage = qChars.size ? hits / qChars.size : 1;
  const lenRatio = t.length / Math.max(1, q.length);
  return coverage < 0.15 && lenRatio > 1.5;
}

/** 轻量 Markdown 格式化：标题 # 后补空格、空行归一（≤2）、行尾空白清理、首尾空行清理 */
function formatMarkdown(md: string): string {
  let out = md;
  // 标题：#text → # text。
  // 注意 (?![\s#]) 必须同时排除空格和 #：若只排除空格，(## 标题) 中 #{1,6} 会回溯到单个 #
  // 后，把第二个 # 误判为"无空格"，插入空格变成 "# # 标题"（标题文本出现 # 的根因）
  out = out.replace(/^(#{1,6})(?![\s#])(\S)/gm, '$1 $2');
  // 3 个及以上连续空行 → 2 个
  out = out.replace(/\n{3,}/g, '\n\n');
  // 行尾空白
  out = out.replace(/[ \t]+$/gm, '');
  // 首尾多余空行
  out = out.replace(/^\n+/, '').replace(/\n+$/, '');
  return out ? out + '\n' : out;
}

/** 意图达成度校验：按结构化意图验证输出长度方向（宽松阈值，避免误伤合理改写）。
 *  shorten（精简）→ 输出明显更长则未达成；expand（扩写）→ 输出明显更短则未达成。 */
function intentUnmet(intent: string | undefined, text: string, quote: string): boolean {
  const t = text.trim().length;
  const q = quote.trim().length;
  if (!q || !t) return false;
  if (intent === 'shorten') return t > q * 1.3;
  if (intent === 'expand') return t < q * 0.7;
  return false;
}

/** 「改了什么」的一句话回报：由改动前后的片段文本确定性生成（不额外调模型，零延迟、可审计）。
 *  输入为差异段（delete 段 / insert 段），不是全文 —— 全文长度对用户没有信息量。 */
function describePatch(oldText: string, newText: string, intent?: string): string {
  const o = oldText.trim().length;
  const n = newText.trim().length;
  if (!o && n) return `Inserted ${n} chars`;
  if (o && !n) return `Deleted ${o} chars`;
  if (intent === 'shorten') return `Shortened ${o} → ${n} chars`;
  if (intent === 'expand') return `Expanded ${o} → ${n} chars`;
  if (intent === 'translate') return `Translated ${o} → ${n} chars`;
  if (n > o) return `Rewrote ${o} → ${n} chars (+${n - o})`;
  if (n < o) return `Rewrote ${o} → ${n} chars (−${o - n})`;
  return `Rewrote ${o} chars (same length)`;
}

/** 渲染局部替换轮次：accepted/pending 应用 newText，rejected 保留 oldText（用 preContext 锚定位避免误替换他处） */
function renderPatchRound(round: RevisionRound): string {
  const p = round.patch;
  if (!p) return '';
  const apply = round.revisions.every((r) => r.status !== 'rejected');
  const replacement = apply ? p.newText : p.oldText;
  const anchor = p.preContext + p.oldText;
  const anchorIdx = p.baseMd.indexOf(anchor);
  if (anchorIdx >= 0) {
    return p.baseMd.slice(0, anchorIdx + p.preContext.length) + replacement + p.baseMd.slice(anchorIdx + anchor.length);
  }
  // 锚失效（内容被手动改动过）：退化为直接找 oldText
  const idx = p.baseMd.indexOf(p.oldText);
  if (idx < 0) return p.baseMd;
  return p.baseMd.slice(0, idx) + replacement + p.baseMd.slice(idx + p.oldText.length);
}

/** 调 /api/ai-edit/markdown（SSE）。成功返回 { text, error:null }；失败返回 { text:null, error }（错误可展示给用户） */
async function fetchAiEditSse(body: Record<string, unknown>): Promise<{ text: string | null; error: string | null }> {
  try {
    const resp = await fetch('/api/ai-edit/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      let reason = `请求失败（HTTP ${resp.status}）`;
      try {
        const raw = await resp.text();
        if (raw) reason = `${reason}: ${raw.slice(0, 300)}`;
      } catch { /* ignore */ }
      console.warn('[ai-edit] HTTP', resp.status, reason);
      return { text: null, error: reason };
    }
    let resultText = '';
    let serverError: string | null = null;
    const reader = resp.body?.getReader();
    if (!reader) return { text: null, error: '无法读取响应流' };
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = block.split('\n');
        let event = '';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data = line.slice(5).replace(/^ /, '');
        }
        if (event === 'error') {
          serverError = data || 'AI 服务错误';
          console.warn('[ai-edit] server error:', data);
        }
        if (event === 'done') {
          try {
            const parsed = JSON.parse(data.replace(/\\n/g, '\n')) as { success?: boolean; text?: string; error?: string };
            if (parsed.success && parsed.text) resultText = parsed.text;
            else if (parsed.error) {
              serverError = parsed.error;
              console.warn('[ai-edit] done error:', parsed.error);
            }
          } catch { /* ignore */ }
        }
      }
    }
    if (resultText) return { text: resultText, error: null };
    return { text: null, error: serverError || 'AI 未返回改写结果（可能超时或输出为空）' };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn('[ai-edit] fetch failed:', e);
    return { text: null, error: reason || '网络请求异常' };
  }
}

/** File → base64（不含 data: 前缀），用于附件/图片上传 */
function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function DocEditor({
  content,
  nodeMdId = null,
  filePath,
  projectId,
  source,
  docTitle,
  editable = true,
  hideToc = false,
  notebookEntryId,
  onChange,
  onSave,
}: DocEditorProps) {
  // 用 ref 保存最新的回调，避免 useEditor 重建
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  // 保存状态与防抖计时器
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const changeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 外部变更冲突：baseVersionRef = 加载/保存时记录的 mtimeMs 令牌；conflict 非空时显示三选一横幅
  const baseVersionRef = useRef<number | null>(null);
  const [conflict, setConflict] = useState<{ current_content: string; current_version: number } | null>(null);
  const [showConflictDiff, setShowConflictDiff] = useState(false);
  const saveStatusRef = useRef(saveStatus);
  saveStatusRef.current = saveStatus;


  // 目录栏：显示开关 + 内容版本号（文档变化时重算目录与折叠）
  const [showToc, setShowToc] = useState(false);
  const [tocTick, setTocTick] = useState(0);
  const [activeHeadingPos, setActiveHeadingPos] = useState<number | null>(null);


  /** 表格浮动工具栏：光标在表格内时显示（x/y = 锚点坐标，above = 是否浮在表格上方） */
  const [tableMenu, setTableMenu] = useState<{ x: number; y: number; above: boolean } | null>(null);

  // 查找替换（⌘F）：编辑器内查找/替换，实时高亮匹配，复用 mdLocate 装饰机制
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [findMatches, setFindMatches] = useState<{ from: number; to: number }[]>([]);
  /** 当前定位的匹配索引（-1 = 无匹配/未定位） */
  const [findIndex, setFindIndex] = useState(-1);
  /** 查找栏模式：text=关键词子串查找；semantic=按主题语义检索（AI 分块定位） */
  const [findMode, setFindMode] = useState<'text' | 'semantic'>('text');
  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // 当前活跃节点（canvas 选中）：用于划词追问「发送当前节点」
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ node_id: string | null }>).detail;
      setActiveNodeId(detail?.node_id ?? null);
    };
    window.addEventListener('node-selected', handler);
    return () => window.removeEventListener('node-selected', handler);
  }, []);

  // 中间区域可见的会话（画布单焦点节点）：node-selected 为空时「发送到当前会话」的兜底投递目标。
  // 用户点进节点输入框 / 打开文档面板后 React Flow 的选中态会丢失，仅靠 node-selected 会让按钮恒为禁用；
  // 与文件面板「发送到当前节点」同口径（都取 CanvasFlow 的活跃节点）。
  const [activeSessionNodeId, setActiveSessionNodeId] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ node_id: string | null }>).detail;
      setActiveSessionNodeId(detail?.node_id ?? null);
    };
    window.addEventListener('active-node-changed', handler);
    // 两个监听器都就位后再请求重播：画布可能在 DocEditor 挂载前就已广播，被动监听会错过初始状态
    // 导致 activeNodeId / activeSessionNodeId 误判为 null（“发送到当前节点”被禁用）
    window.dispatchEvent(new CustomEvent('node-selected-request'));
    return () => window.removeEventListener('active-node-changed', handler);
  }, []);

  // 右键命令菜单（⌘K 命令面板改为正文右键触发）：记录打开时的视口坐标（null = 关闭）
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // 打开右键菜单时若编辑器失焦，执行命令前恢复焦点（focus() 保持文档 selection）
  const ctxOpenRef = useRef(false);
  useEffect(() => {
    if (!ctxMenu) { ctxOpenRef.current = false; return; }
    ctxOpenRef.current = true;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // 点菜单内部不关闭；点外部任意处关闭
      if (!t?.closest?.('.md-ctx-menu')) setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement | null;
      // 菜单自身内容滚动（下拉查看超出项）不关闭；外部文档/容器滚动才关闭
      if (t?.closest?.('.md-ctx-menu')) return;
      setCtxMenu(null);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [ctxMenu]);

  // 通用输入弹窗（替代 Electron 中不可用的 window.prompt）
  const [promptState, setPromptState] = useState<{
    title: string;
    initialValue?: string;
    placeholder?: string;
    onSubmit?: (value: string) => void | Promise<void>;
    /** 可选：多个提交动作（如「以链接插入」「以卡片嵌入」），存在时替代底部单一 Confirm 按钮 */
    choices?: { label: string; primary?: boolean; onSubmit: (value: string) => void | Promise<void> }[];
  } | null>(null);
  const [promptValue, setPromptValue] = useState('');

  // DOCX 导出弹窗
  const [showExportDialog, setShowExportDialog] = useState(false);

  // 统一导出入口（图片卡片 / DOCX / PDF 分组菜单）
  const [showExportMenu, setShowExportMenu] = useState(false);

  // ===== 批注 + 修订 =====
  const [annotations, setAnnotations] = useState<MdAnnotation[]>([]);
  /** 批注结尾图标点击 → 弹出查看卡片（纯查看）：记录批注 id + 触发图标坐标（卡片定位用） */
  const [annotationCard, setAnnotationCard] = useState<{ id: string; x: number; y: number } | null>(null);
  /** widget 点击回调（经 ref 调用：高亮 effect 每次重建 widget 时总能拿到最新闭包） */
  const onAnnotationWidgetRef = useRef<(id: string, x: number, y: number) => void>(() => {});
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(false);
  /** 右侧栏视图：annotations=批注列表；revisions=修订视图；checks=一致性检查 */
  const [annotationView, setAnnotationView] = useState<'annotations' | 'revisions' | 'checks'>('annotations');
  const [revising, setRevising] = useState(false);
  /** 最近一轮「按批注修订」的结果回报（改了几条 / 失败的批注与原因）；null = 尚未跑过 */
  const [reviseReport, setReviseReport] = useState<ReviseReport | null>(null);
  /** 一致性检查结果（仅当前文档）；null = 尚未跑过。文档变更后自动清空（避免展示过期结论） */
  const [consistencyItems, setConsistencyItems] = useState<ConsistencyItem[] | null>(null);
  const [checking, setChecking] = useState(false);
  // 修订历史：每次「按批注修订」生成一轮，按轮次保留；activeRoundId 指向当前文档内容对应的轮
  const [revisionRounds, setRevisionRounds] = useState<RevisionRound[]>([]);
  const [activeRoundId, setActiveRoundId] = useState<string | null>(null);
  /** 当前聚焦的修订（修订视图点击定位）：切换轮次/接受拒绝后跟随重新定位高亮 */
  const [focusedRevision, setFocusedRevision] = useState<{ roundId: string; oldText: string; newText: string } | null>(null);
  /** 聚焦定位需要滚动一次的标记（跨轮切换时，文档重建完成后再滚动） */
  const pendingRevisionScrollRef = useRef(false);
  /** 刚刚就地应用的改动文字（AI 修订/重写成功）→ 全文重建后据此把视口停回改动处，
   *  否则整篇 setContent 重置选区会让视图漂到别处（"AI 修订完成后跳到别的段落"） */
  const justAppliedAnchorRef = useRef('');
  /** 定位提示（修订文字未在文档中找到时给可见反馈，避免"点了没反应"） */
  const [locateHint, setLocateHint] = useState('');
  useEffect(() => {
    if (!locateHint) return;
    const t = setTimeout(() => setLocateHint(''), 3000);
    return () => clearTimeout(t);
  }, [locateHint]);
  // 修订历史已从 sidecar 加载完成（未完成前禁止落盘，避免空数组覆盖旧数据）
  const revisionRoundsLoadedRef = useRef(false);
  // 上一次的 annotationKey：key 变化（文档改名/移动/换节点）时用于从旧 key 迁移批注与修订
  const prevAnnotationKeyRef = useRef<string | null>(null);
  // 写盘串行队列：严格按提交顺序落盘，避免并发 POST 乱序覆盖
  const sidecarWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  // 批注 sidecar 唯一 key：nodeMdId 优先，其次 projectId:filePath，再次 filePath
  const annotationKey = nodeMdId || (filePath ? (projectId ? `${projectId}:${filePath}` : filePath) : null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedMdRef = useRef<string>(content);
  const lastContentRef = useRef<string>(content);

  // 手动保存处理（通过 ref 供 editorProps.handleKeyDown 调用）
  const saveToApi = useCallback(
    async (md: string, force = false) => {
      if (!nodeMdId && !(filePath && projectId) && !(filePath && source === 'local') && !notebookEntryId) return;
      setSaveStatus('saving');
      // 乐观并发令牌：force（用户选择「保留我的版本」）时不回传，跳过服务端比对直接覆盖
      const base_version = force ? undefined : (baseVersionRef.current ?? undefined);
      try {
        let data: Record<string, unknown>;
        if (source === 'local' && filePath) {
          // 保存到本地文件（绝对路径）
          const resp = await fetch('/api/local-files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'write', path: filePath, content: md, base_version }),
          });
          data = await resp.json();
        } else if (filePath && projectId) {
          // 保存到项目文件系统（相对路径）
          const resp = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'write_file', project_id: projectId, file_path: filePath, content: md, base_version }),
          });
          data = await resp.json();
        } else if (nodeMdId) {
          // 保存到节点 .md
          const resp = await fetch('/api/nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'update_content', node_id: nodeMdId, content: md, base_version }),
          });
          data = await resp.json();
        } else if (notebookEntryId) {
          // 保存到笔记库条目（notes/wiki/{id}.md）
          const resp = await fetch('/api/notebook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entry_id: notebookEntryId, content: md }),
          });
          data = await resp.json();
        } else {
          return;
        }
        // 服务端检测到加载后被外部改写：弹三选一横幅，不落盘
        if (data.conflict) {
          setConflict({
            current_content: stripFrontmatterLocal(typeof data.current_content === 'string' ? data.current_content : ''),
            current_version: typeof data.current_version === 'number' ? data.current_version : Date.now(),
          });
          setShowConflictDiff(false);
          setSaveStatus('unsaved');
          return;
        }
        if (data.success) {
          if (typeof data.version === 'number') baseVersionRef.current = data.version;
          lastSavedMdRef.current = md;
          setSaveStatus('saved');
          // 通知文件侧栏：文件已变更，立即刷新（若正在浏览相关目录）
          window.dispatchEvent(new CustomEvent('local-files-changed'));
        } else {
          setSaveStatus('unsaved');
        }
      } catch {
        setSaveStatus('unsaved');
      }
    },
    [nodeMdId, filePath, projectId, source, notebookEntryId],
  );

  // 读取当前版本令牌（mtimeMs）：编辑期轮询检测外部改写（node md / project 文件 / local 文件）
  const fetchVersion = useCallback(async (): Promise<number | null> => {
    try {
      if (nodeMdId) {
        const q = new URLSearchParams({ id: nodeMdId, action: 'version' });
        if (projectId) q.set('project_id', projectId);
        const r = await fetch(`/api/nodes?${q}`).then((x) => x.json());
        return typeof r.version === 'number' ? r.version : null;
      }
      if (filePath && projectId) {
        const r = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stat', project_id: projectId, file_path: filePath }),
        }).then((x) => x.json());
        return typeof r.mtime === 'number' ? r.mtime : null;
      }
      if (filePath && source === 'local') {
        const q = new URLSearchParams({ action: 'stat', path: filePath });
        const r = await fetch(`/api/local-files?${q}`).then((x) => x.json());
        return typeof r.mtime === 'number' ? r.mtime : null;
      }
      return null;
    } catch {
      return null;
    }
  }, [nodeMdId, filePath, projectId, source]);

  // 拉取当前磁盘全文（已剥离 frontmatter），供干净态静默重载 / 脏态冲突对比
  const fetchFullBody = useCallback(async (): Promise<string | null> => {
    try {
      if (nodeMdId) {
        const q = new URLSearchParams({ id: nodeMdId, action: 'raw' });
        if (projectId) q.set('project_id', projectId);
        const r = await fetch(`/api/nodes?${q}`).then((x) => x.json());
        return typeof r.content === 'string' ? stripFrontmatterLocal(r.content) : null;
      }
      if (filePath && projectId) {
        const r = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'read_file', project_id: projectId, file_path: filePath }),
        }).then((x) => x.json());
        return typeof r.content === 'string' ? stripFrontmatterLocal(r.content) : null;
      }
      if (filePath && source === 'local') {
        const q = new URLSearchParams({ action: 'read_file', path: filePath });
        const r = await fetch(`/api/local-files?${q}`).then((x) => x.json());
        return typeof r.content === 'string' ? stripFrontmatterLocal(r.content) : null;
      }
      return null;
    } catch {
      return null;
    }
  }, [nodeMdId, filePath, projectId, source]);

  // 手动保存处理（通过 ref 供 editorProps.handleKeyDown 调用，赋值在 editor 创建之后）
  const handleSaveRef = useRef<() => void>(() => {});
  // 打开查找替换栏（同上：handleKeyDown 闭包创建于首轮渲染，直接引用会锁死 editor=null 的旧值）
  const openFindRef = useRef<() => void>(() => {});

  // 最新 nodeMdId（供 editorProps 的 handlePaste 读取，避免闭包拿到过期值）
  const nodeMdIdRef = useRef(nodeMdId);
  nodeMdIdRef.current = nodeMdId;

  // useEditor 的 onUpdate 闭包只捕获首次渲染的函数，用 ref 保持最新的 saveToApi 引用
  const saveToApiRef = useRef(saveToApi);
  saveToApiRef.current = saveToApi;

  /** 上传图片文件：节点文档 → 节点附件目录；本地文档 → 文档同目录 attachments/ 子目录。返回可插入的 src；失败返回 null */
  const uploadImageFile = useCallback(async (file: Blob): Promise<string | null> => {
    try {
      const base64 = await fileToBase64(file);
      const nodeId = nodeMdIdRef.current;
      if (nodeId) {
        // 节点文档：上传到节点附件目录
        const resp = await fetch('/api/attachments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nodeId,
            nodeTitle: '',
            fileName: (file as File).name || `paste-${Date.now()}.png`,
            fileType: file.type || 'application/octet-stream',
            data: base64,
          }),
        });
        const data = await resp.json();
        if (data.success && data.attachment) {
          return '/api/attachments?path=' + encodeURIComponent(data.attachment.path);
        }
        return null;
      }
      // 项目文件（source='project'）：图片写入项目内文档同目录 attachments/ 子目录，
      // 走 projects write_file(base64) + file_proxy 通道（此前缺失该分支，相对路径被当本地路径写错位置导致图片 404）
      if (filePath && source === 'project' && projectId) {
        const dir = filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : '';
        const ext = (file.type || 'image/png').split('/')[1]?.split('+')[0] || 'png';
        const name = `paste-${Date.now()}.${ext}`;
        const relPath = dir ? `${dir}/attachments/${name}` : `attachments/${name}`;
        const wresp = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'write_file', project_id: projectId, file_path: relPath, content: base64, encoding: 'base64' }),
        });
        const wdata = await wresp.json();
        if (wdata.success) {
          const written = (wdata.path as string) || relPath;
          return '/api/projects?action=file_proxy&project_id=' + encodeURIComponent(projectId) + '&file_path=' + encodeURIComponent(written);
        }
        return null;
      }
      // 本地文档（无节点）：图片写入文档同目录 attachments/ 子目录，src 走 file_proxy
      if (filePath) {
        const dir = filePath.split('/').slice(0, -1).join('/');
        const ext = (file.type || 'image/png').split('/')[1]?.split('+')[0] || 'png';
        const name = `paste-${Date.now()}.${ext}`;
        const fullPath = `${dir}/attachments/${name}`;
        const wresp = await fetch('/api/local-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'write', path: fullPath, content: base64, encoding: 'base64' }),
        });
        const wdata = await wresp.json();
        if (wdata.success) {
          return '/api/local-files?action=file_proxy&path=' + encodeURIComponent(fullPath);
        }
        return null;
      }
      // 兜底（无节点且无本地文件路径的临时文档）：dataURL 内嵌，保证截图粘贴始终可用
      return `data:${file.type || 'image/png'};base64,${base64}`;
    } catch {
      return null;
    }
  }, [filePath, source, projectId]);
  const uploadImageFileRef = useRef(uploadImageFile);
  uploadImageFileRef.current = uploadImageFile;

  // ===== 问卷识别（```json 问卷块 → 编辑器视图占位 + 交互面板） =====
  const qResult = useMemo(() => extractQuestionnaires(content), [content]);
  const qBlocksRef = useRef<QuestionnaireBlock[]>(qResult.blocks);
  qBlocksRef.current = qResult.blocks;
  // 流式生成中/格式异常的疑似问卷块：视图已占位，保存前需还原为原文 JSON
  const qPendingRef = useRef(qResult.pendingPlaceholders);
  qPendingRef.current = qResult.pendingPlaceholders;

  /** 保存/导出前将编辑器中的问卷占位符还原为真实 JSON（避免占位文本写盘导致问卷丢失） */
  const restoreQuestionnaires = useCallback((md: string): string => {
    let out = md;
    for (const b of qBlocksRef.current) {
      if (out.includes(b.placeholder)) out = out.replace(b.placeholder, b.raw);
    }
    for (const p of qPendingRef.current) {
      if (out.includes(p.placeholder)) out = out.replace(p.placeholder, p.raw);
    }
    return out;
  }, []);

  // 扩展列表：用 useMemo 稳定引用，避免每次渲染都触发 editor.setOptions 重新配置
  const extensions = useMemo(
    () => [
      // StarterKit 内置 CodeBlock 由 MermaidCodeBlock 替代（内部仍是 CodeBlockLowlight，
      // 额外为 ```mermaid 提供图表渲染 NodeView，其余代码块行为不变）；
      // 内置 heading 由 CollapsibleHeading 替代（NodeView 提供标题 data-pos 供目录定位，命令行为一致）
      StarterKit.configure({ codeBlock: false, heading: false }),
      CollapsibleHeading,
      // 链接：openOnClick 点击打开（新窗口）；链接目标（文档分享页/外部 URL）均可点开
      Link.configure({
        openOnClick: true,
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
      // 图片：左右手柄拖拽改尺寸（等比），尺寸以 <img width> 落进 Markdown（样式见 globals.css）
      createResizableImage(),
      Table.configure({ resizable: true }),
      TableRow,
      // 单元格对齐：textAlign attribute（表格浮动工具栏「对齐」按钮经 setCellAttribute 写入，style 内联控制渲染）
      // 注意：必须继承父扩展原生属性（colspan/rowspan/colwidth/align）。
      // TipTap 的 extend 是浅合并，直接返回新 addAttributes 会覆盖掉原生属性，
      // 导致 tableCell 丢失 colspan/rowspan，prosemirror-tables 的 fixTables 读到
      // undefined 列宽后误判「missing」并向表头插入空单元格，表格由 3 列错位成 6 列。
      TableCell.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            textAlign: {
              default: null,
              parseHTML: (el: HTMLElement) => el.style.textAlign || null,
              renderHTML: (attrs: { textAlign?: string | null }) =>
                attrs.textAlign ? { style: `text-align: ${attrs.textAlign}` } : {},
            },
          };
        },
      }),
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight,
      MermaidCodeBlock.configure({ lowlight }),
      // 文档嵌入：`![[路径]]` → 嵌入卡片（markdown 双向序列化见扩展内）
      MdEmbed,
      // 链接卡片：独占一行的裸链接 → 卡片（markdown 仍为 `[url](url)`，元数据异步抓取）
      LinkCard,
      // 多栏容器 MVP：bobColumns + bobColumn（自定 markdown fence 往返，见扩展内 addStorage）
      BobColumn,
      BobColumns,
      // 批注高亮：被批注文字保持黄色高亮
      MdAnnotationHighlight,
      // 临时选区高亮：批注气泡编辑期间保持选中文字高亮
      MdSelTempHighlight,
      // 修订聚焦高亮：修订视图点击某条修订 → 正文定位高亮被修改处
      MdRevisionFocusHighlight,
      // 便签反向定位高亮：点击便签子弹图标 → 打开文档并滚动高亮划词出处
      MdLocateFlashHighlight,
      // 查找替换高亮：⌘F 查找栏实时高亮所有匹配
      MdFindHighlight,
      // track-changes：兼容旧 mark 轮次数据（当前修订走 patch 轮次）
      TrackChangesExtension.configure({ author: { id: 'ai', name: 'AI', color: '#4b3fe3' }, mode: 'edit' }),
      // tiptap-markdown：在 onBeforeCreate 中自动解析 markdown content，
      // 并提供 editor.storage.markdown.getMarkdown() 序列化
      Markdown.configure({
        html: true,
        tightLists: true,
        linkify: false,
        breaks: false,
        // 粘贴纯文本时自动解析 markdown 语法（从外部复制 md 内容保留格式）
        transformPastedText: true,
      }),
    ],
    [],
  );

  const editor = useEditor({
    extensions,
    // 初始内容为 markdown 字符串，由 Markdown 扩展解析（问卷代码块已替换为占位文本）
    content: qResult.editorContent,
    editable,
    // Next.js SSR：延迟到客户端挂载后再创建编辑器，避免水合不匹配
    immediatelyRender: false,
    editorProps: {
      attributes: {
        // 复用现有 .html-renderer 样式 + .doc-editor-content 专属样式
        // 只读渲染（如消息里的文本块）不保留编辑占位高度，避免与下方 widget 之间出现大空隙
        class: `doc-editor-content html-renderer${editable ? '' : ' doc-editor-readonly'}`,
        'data-placeholder': editable ? 'Start writing, or paste Markdown…' : '',
      },
      handleKeyDown: (_view, event) => {
        // ⌘⇧F / Ctrl+Shift+F：打开编辑器内查找替换（⌘F 已专属全局搜索，见 CanvasFlow）
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          openFindRef.current();
          return true;
        }
        // Cmd/Ctrl+S 手动保存
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          handleSaveRef.current();
          return true;
        }
        return false;
      },
      // 粘贴增强：图片（剪贴板位图 / 网页 dataURL 图片）自动上传后插入
      handlePaste: (view, event) => {
        const items = event.clipboardData?.items;
        if (items) {
          for (const it of Array.from(items)) {
            if (it.kind === 'file' && it.type.startsWith('image/')) {
              const file = it.getAsFile();
              if (file) {
                event.preventDefault();
                void insertPastedImage(view, file, uploadImageFileRef.current);
                return true;
              }
            }
          }
        }
        // 网页中复制的图片：HTML 里的 dataURL <img>
        const html = event.clipboardData?.getData('text/html') || '';
        const m = html.match(/<img[^>]+src=["'](data:image\/[^"']+)["']/i);
        if (m) {
          event.preventDefault();
          const blob = dataUrlToBlob(m[1]);
          if (blob) void insertPastedImage(view, blob, uploadImageFileRef.current);
          return true;
        }
        // 纯文本粘贴自动识别（无富文本 HTML 时）：URL → 链接；文档路径 → 嵌入卡片
        const plain = (event.clipboardData?.getData('text/plain') || '').trim();
        if (editor && !html && plain && !plain.includes('\n')) {
          // 文档相对路径（homework/report.md / 文件.md）→ 嵌入卡片（占位 `![[path]]` 解析）
          if (/^(?:[\w.\- ]+\/)*[\w.\- ]+\.(?:md|mdx)$/i.test(plain) && /\/|\.md/i.test(plain)) {
            event.preventDefault();
            insertMarkdownSlice(editor, view, `![[${plain}]]`);
            return true;
          }
          // 单个 http(s) URL → 链接（有选区时把选中文字包成链接；无选区插入可见 URL 链接）
          const urlOnly = plain.match(/^https?:\/\/\S+$/i);
          if (urlOnly) {
            const url = urlOnly[0];
            event.preventDefault();
            const { from, to, empty } = view.state.selection;
            if (empty) {
              insertMarkdownSlice(editor, view, `[${url}](${url})`);
            } else {
              editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
              // setLink 只作用于当前选区文本
            }
            return true;
          }
        }
        // 网页富文本粘贴 → 干净 Markdown：
        // - 本地编辑器内部复制带 data-pm-slice 元数据 → 走默认精确粘贴（不拦截）；
        // - 含 <table> 的外部 HTML → 走默认 HTML 粘贴（编辑器原生表格，turndown 会损坏结构）；
        // - 其余外部富文本（正文/链接/标题/列表/代码块）→ 转纯 Markdown 后同源解析插入，去脏样式。
        if (editor && html && !html.includes('data-pm-slice') && isRichClipboardHtml(html) && !/<table[\s>]/i.test(html)) {
          const md = cleanWebHtmlToMarkdown(html);
          if (md && insertMarkdownSlice(editor, view, md)) {
            event.preventDefault();
            return true;
          }
        }
        return false;
      },
      // 拖入文件/图片：定位到拖放落点，上传后插入（复用粘贴图片的 upload + insert 通道）
      handleDrop: (view, event) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        // 仅处理图片（与粘贴一致）；非图片文件拖入不拦截，交给默认行为
        const imgFiles = Array.from(files).filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(f.name));
        if (imgFiles.length === 0) return false;
        event.preventDefault();
        // 拖放落点（无精确坐标时退回当前选区起点）；多图依次向后顺延插入
        const coords = { left: event.clientX, top: event.clientY };
        let dropPos = view.posAtCoords(coords)?.pos ?? view.state.selection.from;
        for (const f of imgFiles) {
          const pos = dropPos;
          void insertPastedImage(view, f, uploadImageFileRef.current, pos);
          // 乐观顺延：下张图插到本张之后（实际插入后由文档重算，偏差可接受）
          dropPos = pos + 1;
        }
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      const md = getMarkdown(editor);
      setSaveStatus('unsaved');
      // 内容变化回调：防抖 500ms
      if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
      changeTimerRef.current = setTimeout(() => {
        onChangeRef.current?.(md);
      }, 500);
      // 自动保存：防抖 2000ms（保存前还原问卷占位符为真实 JSON）；
      // docx 编辑模式除外——每次改动都重新生成 docx 太重，仅手动保存（Ctrl+S / 工具栏按钮）
      if (source !== 'docx') {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          saveToApiRef.current(restoreQuestionnaires(md));
        }, 2000);
      }
    },
  });

  /** 记录一次局部替换为修订轮次（逐条 AI 修改也进修订面板，可审阅/回退）。
   *  intent 用于生成「改了什么」的回报文案（note）；返回新轮次 id（未产生轮次时 null），供调用方回报。 */
  const addPatchRound = useCallback((before: string, after: string, annotationId?: string, intent?: string): string | null => {
    if (!before || before === after) return null;
    const { oldText, newText, preLen } = diffPatch(before, after);
    if (!oldText && !newText) return null;
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const revs: Revision[] = [];
    if (oldText) revs.push({ id: `rev-${stamp}-d`, type: 'delete', text: oldText, status: 'pending' });
    if (newText) revs.push({ id: `rev-${stamp}-i`, type: 'insert', text: newText, status: 'pending' });
    const preContext = before.slice(Math.max(0, preLen - 20), preLen);
    const round: RevisionRound = {
      id: `round-${stamp}`,
      createdAt: new Date().toISOString(),
      segments: [],
      revisions: revs,
      patch: { baseMd: before, oldText, newText, preContext },
      ...(annotationId ? { annotationId } : {}),
      note: describePatch(oldText, newText, intent),
    };
    setRevisionRounds((prev) => [...prev, round]);
    // 标记"刚就地应用的改动"：该轮设为活动轮会触发整篇重建，重建后据此把视口停回改动处
    justAppliedAnchorRef.current = newText || oldText;
    setActiveRoundId(round.id);
    return round.id;
  }, []);

  // ===== 批注 + 修订 sidecar 读写 =====
  // 加载批注列表 + 修订历史（修订恢复到最后一次修订轮，文档内容随之切换到该轮状态）
  // 若 key 变化（文档改名/移动）且新 key 无数据，自动从旧 key 迁移批注与修订后删除旧 sidecar
  useEffect(() => {
    if (!annotationKey) return;
    const prevKey = prevAnnotationKeyRef.current;
    prevAnnotationKeyRef.current = annotationKey;
    let alive = true;
    (async () => {
      try {
        const resp = await fetch(`/api/md-annotations?key=${encodeURIComponent(annotationKey)}`);
        const data = await resp.json();
        let annotationsToLoad = data.success ? (data.annotations || []) : [];
        let roundsToLoad = data.success ? (data.revisionRounds || []) : [];
        // 新 key 无数据但旧 key 有数据 → 迁移（文档改名/移动，key 跟随变化）
        if (data.success && data.exists === false && prevKey && prevKey !== annotationKey) {
          const prevResp = await fetch(`/api/md-annotations?key=${encodeURIComponent(prevKey)}`);
          const prevData = await prevResp.json();
          if (prevData.success && prevData.exists) {
            const prevAnnotations = prevData.annotations || [];
            const prevRounds = prevData.revisionRounds || [];
            if (prevAnnotations.length > 0 || prevRounds.length > 0) {
              await fetch('/api/md-annotations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: annotationKey, annotations: prevAnnotations, revisionRounds: prevRounds }),
              });
              annotationsToLoad = prevAnnotations;
              roundsToLoad = prevRounds;
              // 旧 key sidecar 不再被引用，删除避免残留
              await fetch(`/api/md-annotations?key=${encodeURIComponent(prevKey)}`, { method: 'DELETE' });
            }
          }
        }
        if (!alive) return;
        setAnnotations(annotationsToLoad);
        if (roundsToLoad.length > 0) {
          setRevisionRounds(roundsToLoad);
          setActiveRoundId(roundsToLoad[roundsToLoad.length - 1].id);
        }
      } catch { /* ignore */ }
      finally {
        // 无论成功失败，加载流程结束才允许落盘（防止初始空状态覆盖旧数据）
        if (alive) revisionRoundsLoadedRef.current = true;
      }
    })();
    return () => { alive = false; };
  }, [annotationKey]);

  /** 串行写盘：批注 + 修订全量写入 sidecar（按提交顺序排队，避免并发覆盖） */
  const persistSidecar = useCallback((annotationsToWrite: MdAnnotation[], roundsToWrite: RevisionRound[]) => {
    if (!annotationKey) return Promise.resolve();
    const payload = { key: annotationKey, annotations: annotationsToWrite, revisionRounds: roundsToWrite };
    const write = sidecarWriteChainRef.current.then(async () => {
      try {
        await fetch('/api/md-annotations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch { /* ignore */ }
    });
    sidecarWriteChainRef.current = write;
    return write;
  }, [annotationKey]);

  // 批注 / 修订历史变化 → 持久化（仅加载完成后；串行队列保证最终落盘为最新状态）
  useEffect(() => {
    if (!annotationKey || !revisionRoundsLoadedRef.current) return;
    void persistSidecar(annotations, revisionRounds);
  }, [annotationKey, annotations, revisionRounds, persistSidecar]);

  /** 更新批注内存态（写盘由上方统一持久化 effect 负责） */
  const persistAnnotations = useCallback(async (next: MdAnnotation[]) => {
    setAnnotations(next);
  }, []);

  /** 新增批注（气泡「批注」按钮 → 输入框确认后调用） */
  const addAnnotation = useCallback(async (quote: string, content: string, from?: number, to?: number, intent?: string) => {
    // 上下文锚（W3C TextQuoteSelector）：记录 quote 前后各 32 字符，
    // 重复文本/文档漂移时用上下文精确定位（quote 可能在文中出现多次）
    let prefix: string | undefined;
    let suffix: string | undefined;
    if (editor && typeof from === 'number' && typeof to === 'number' && from >= 1 && to <= editor.state.doc.content.size) {
      const fullText = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
      const ctxLen = 32;
      prefix = fullText.slice(Math.max(0, from - 1 - ctxLen), from - 1);
      suffix = fullText.slice(to - 1, to - 1 + ctxLen);
    }
    const a: MdAnnotation = {
      id: `ann-${Date.now().toString(36)}`,
      quote,
      content,
      intent: intent || undefined,
      from,
      to,
      prefix,
      suffix,
      createdAt: new Date().toISOString(),
    };
    await persistAnnotations([...annotations, a]);
  }, [annotations, persistAnnotations, editor]);

  /** 重建正文批注装饰（高亮 + 查看图标）：被批注文字保持黄色高亮，取消选中不消失；
   *  已解决批注淡化。优先按批注记录的精确位置锁定（不乱飘），无位置/失效时回退文本匹配。
   *  删除 / 编辑批注后立即调用，保证侧边栏与正文实时同步。 */
  const applyAnnotationHighlights = useCallback((list: MdAnnotation[]) => {
    if (!editor) return;
    const doc = editor.state.doc;
    const decorations: Decoration[] = [];
    for (const a of list) {
      if (!a.quote.trim()) continue;
      // 统一锚定：from/to 优先 + quote/prefix/suffix 上下文兜底，每个批注只高亮精确的一处
      // （此前循环 indexOf 会把重复文本的所有出现都高亮，与卡片跳转的第一处行为分裂）
      const pos = resolveAnnotationPos(editor, a);
      if (!pos) continue;
      decorations.push(
        Decoration.inline(pos.from, pos.to, {
          class: a.resolved ? 'md-annotation-resolved' : 'md-annotation-highlight',
        }),
      );
      // 未解决批注：在结尾追加查看图标（widget），点击弹卡片查看批注内容；已解决批注不显示图标
      if (!a.resolved) {
        const wDom = document.createElement('span');
        wDom.className = 'md-annotation-widget';
        wDom.title = a.content;
        wDom.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8"/><path d="M8 13h5"/></svg>';
        // 阻止 mousedown 落下光标/收起选区（批注查看不改变编辑器状态）
        wDom.addEventListener('mousedown', (e) => e.preventDefault());
        wDom.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          onAnnotationWidgetRef.current(a.id, e.clientX, e.clientY);
        });
        decorations.push(Decoration.widget(pos.to, wDom, { side: 0 }));
      }
    }
    editor.view.dispatch(
      editor.state.tr.setMeta(mdAnnotationSelKey, DecorationSet.create(doc, decorations)),
    );
  }, [editor]);

  /** 删除批注：从侧边栏 / 批注卡片删除后立即重建正文装饰，高亮与图标实时消失 */
  const deleteAnnotation = useCallback(async (id: string) => {
    const next = annotations.filter((a) => a.id !== id);
    await persistAnnotations(next);
    // 立即用新列表重建正文装饰（不等被动 effect），保证侧边栏删除 → 正文高亮/图标实时消失
    applyAnnotationHighlights(next);
  }, [annotations, persistAnnotations, applyAnnotationHighlights]);

  /** 二次编辑批注内容（批注卡片编辑保存） */
  const updateAnnotation = useCallback(async (id: string, content: string) => {
    const next = annotations.map((a) => (a.id === id ? { ...a, content } : a));
    await persistAnnotations(next);
    applyAnnotationHighlights(next);
  }, [annotations, persistAnnotations, applyAnnotationHighlights]);

  /** 批注列表变化（加载 / 新增 / 编辑 / 删除）→ 重建正文高亮装饰 */
  useEffect(() => {
    applyAnnotationHighlights(annotations);
  }, [applyAnnotationHighlights, annotations]);

  /** 批注气泡：把选中文字 + 位置 + 批注内容转为批注（不自动打开右侧栏，用户按需从工具栏进入） */
  const handleAnnotate = useCallback((quote: string, content: string, from?: number, to?: number, intent?: string) => {
    if (quote.trim() && content.trim()) void addAnnotation(quote.trim(), content.trim(), from, to, intent);
  }, [addAnnotation]);

  /** 定位到批注对应的正文位置（选中文字 + 滚动）：统一锚定——from/to 优先，quote/上下文兜底 */
  const jumpToAnnotation = useCallback((a: MdAnnotation) => {
    if (!editor || !a.quote) return;
    const pos = resolveAnnotationPos(editor, a);
    if (!pos) return;
    editor.chain().focus().setTextSelection({ from: pos.from, to: pos.to }).run();
    const scroller = editor.view.dom.parentElement;
    if (scroller) {
      const coords = editor.view.coordsAtPos(pos.from);
      scroller.scrollTo({ top: coords.top - scroller.getBoundingClientRect().top + scroller.scrollTop - 80, behavior: 'smooth' });
    }
  }, [editor]);

  /** 批注结尾图标查看卡片：点击图标经 ref 转发打开；点击外部 / Esc / 滚动正文时关闭
   *  （滚动关闭：图标随文档滚动，卡片 fixed 定位会坐标错位，关闭最稳妥） */
  useEffect(() => {
    onAnnotationWidgetRef.current = (id, x, y) => setAnnotationCard({ id, x, y });
    if (!annotationCard) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // 点卡片内 / 点其他图标：不关闭（点其他图标由 click 转发更新坐标）
      if (t?.closest?.('.md-annotation-card, .md-annotation-widget')) return;
      setAnnotationCard(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAnnotationCard(null);
    };
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement | null;
      // 卡片内（textarea 编辑长内容）滚动不关闭卡片，只关外部滚动导致的坐标错位
      if (t?.closest?.('.md-annotation-card')) return;
      setAnnotationCard(null);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [annotationCard]);

  // ===== 单条批注 / 全部批注 逐条 AI 修改（quote 按批注意见即时改写并替换，进修订面板可回退） =====
  const [rewritingAll, setRewritingAll] = useState(false);
  // 当前正在重写的批注 id（对应卡片显示进度百分比）；null = 无进行中
  const [rewritingId, setRewritingId] = useState<string | null>(null);

  /** 单条重写核心：调 AI 改写 quote 并替换（进度由调用方管理）；替换记录为修订轮次。
   *  返回 { ok, roundId } 成功 / { ok:false, reason } 失败原因（可展示给用户）。 */
  const rewriteSingle = useCallback(async (a: MdAnnotation): Promise<{ ok: boolean; reason?: string; roundId?: string }> => {
    if (!editor || !a.quote.trim() || !a.content.trim()) return { ok: false, reason: '选中范围或意见为空' };
    const before = getMarkdown(editor);
    // 结构化意图：给 AI 带明确操作前缀；auto（自动判断）不指定方向，提示 AI 自行理解意见意图
    const intentDef = a.intent ? ANNOTATION_INTENTS.find((x) => x.id === a.intent) : undefined;
    const instruction = a.intent === 'auto'
      ? `【请自行判断本条意见的意图（改写润色/精简/扩写/翻译/修正事实/格式化等），按判断执行】${a.content}`
      : intentDef?.prefix
        ? `【${intentDef.prefix}】${a.content}`
        : a.content;
    const res = await fetchAiEditSse({
      md: before,
      instruction,
      mode: 'inline',
      selection: { text: a.quote },
    });
    const text = res.text;
    if (!text || !text.trim()) return { ok: false, reason: res.error || 'AI 未返回改写结果' };
    // 定位批注文字：统一锚定（from/to 优先 + quote/prefix/suffix 上下文兜底）
    const pos = resolveAnnotationPos(editor, a);
    if (!pos) return { ok: false, reason: '无法定位选中的文字（可能已被改动）' };
    const from = pos.from;
    const to = pos.to;
    // 输出含块级 markdown（代码块/表格/标题/引用/列表）→ 用 markdown parser 解析为块级内容插入，
    // 保证表格/列表等结构节点可渲染（纯行内改写保持 inlineMdToHtml）
    const mdStorage = (editor.storage as unknown as { markdown?: MarkdownStorage }).markdown;
    const hasBlockMd =
      /```/.test(text) ||
      /^\s*\|.*\|/m.test(text) || // markdown 表格行
      /^\s*#{1,6}\s+/m.test(text) || // 标题
      /^\s*>\s+/m.test(text) || // 引用
      /^\s*[-*+]\s+/m.test(text) || // 无序列表
      /^\s*\d+[.)]\s+/m.test(text); // 有序列表
    const content = hasBlockMd && mdStorage?.parser
      ? mdStorage.parser.parse(text.trim()).toJSON()
      : inlineMdToHtml(text.trim());
    const beforeSize = editor.state.doc.content.size;
    editor.chain().focus().insertContentAt({ from, to }, content).run();
    const afterSize = editor.state.doc.content.size;
    // 跑偏/意图未达成校验：AI 输出应与批注引用文字相关；且按意图（精简/扩写）验证长度方向。
    // 不满足 → 还原为修改前，不记录修订（用户可重试）
    const after = getMarkdown(editor);
    if (revisionDrifted(text, a.quote) || intentUnmet(a.intent, text, a.quote)) {
      editor.commands.setContent(before);
      return { ok: false, reason: 'AI 改写结果偏离原文 / 未达成意图，已还原（请调整指令后重试）' };
    }
    // 逐条重写也记录为修订轮次（进修订面板可审阅/回退），并关联来源批注（接受修订时自动标记批注已解决）
    const roundId = addPatchRound(before, after, a.id, a.intent);
    // 重写成功：把批注锚更新到新文本处（quote=替换后文本、from/to=新区间、prefix/suffix 重算）——
    // 否则锚停留在被替换的旧文本，后续定位/高亮失效（"修改卡片无法定位"的残留根因）
    const newLen = afterSize - beforeSize + (to - from);
    const newTo = from + newLen;
    const newQuote = editor.state.doc.textBetween(from, newTo, '\n').trim();
    if (newQuote) {
      const fullNew = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
      const ctxLen = 32;
      await persistAnnotations(annotations.map((x) =>
        x.id === a.id
          ? {
              ...x,
              quote: newQuote,
              from,
              to: newTo,
              prefix: fullNew.slice(Math.max(0, from - 1 - ctxLen), from - 1),
              suffix: fullNew.slice(newTo - 1, newTo - 1 + ctxLen),
            }
          : x,
      ));
    }
    return { ok: true, roundId: roundId ?? undefined };
  }, [editor, addPatchRound, annotations, persistAnnotations]);

  /** 单条批注 AI 重写（卡片按钮）：进行中在卡片上显示进度 */
  const rewriteAnnotation = useCallback(async (a: MdAnnotation) => {
    setRewritingId(a.id);
    try {
      await rewriteSingle(a);
    } finally {
      setRewritingId(null);
    }
  }, [rewriteSingle]);

  /** AI 直接修订（批注气泡「AI 修订」按钮）：不挂批注，把选中文字按输入意见+风格直接改写进稿；
   *  复用 rewriteSingle 可靠链路，替换结果进修订面板可审阅/回退。返回 null=成功，否则为失败原因。 */
  const directRevise = useCallback(async (
    quote: string,
    content: string,
    from: number,
    to: number,
    intent: AnnotationIntent | '',
  ): Promise<string | null> => {
    if (!quote.trim() || !content.trim()) return '选中范围或意见为空';
    const a: MdAnnotation = {
      id: `direct-${Date.now().toString(36)}`,
      quote,
      content,
      intent: intent || undefined,
      from,
      to,
      createdAt: new Date().toISOString(),
    };
    const r = await rewriteSingle(a);
    return r.ok ? null : (r.reason ?? 'AI 修订失败');
  }, [rewriteSingle]);

  const rewriteAllAnnotations = useCallback(async () => {
    const unresolved = annotations.filter((a) => !a.resolved && a.quote.trim() && a.content.trim());
    if (unresolved.length === 0 || rewritingAll) return;
    setRewritingAll(true);
    try {
      // 串行逐条重写（共享同一 AI 通道，避免并发），当前条在卡片上显示进度
      for (let i = 0; i < unresolved.length; i++) {
        setRewritingId(unresolved[i].id);
        await rewriteSingle(unresolved[i]);
      }
      setRewritingId(null);
    } finally {
      setRewritingAll(false);
    }
  }, [annotations, rewriteSingle, rewritingAll]);

  /** 按批注修订（简化版）：串行逐条 AI 修改每条未解决批注（复用可靠单条链路），
   *  每条改动进修订面板可审阅/回退；全部成功后批注标记已解决。
   *  结束后产出 ReviseReport（改了几条 / 哪几条失败及原因），失败不再静默丢弃。 */
  const reviseFromAnnotations = useCallback(async () => {
    if (!editor || revising) return;
    const unresolved = annotations.filter((a) => !a.resolved && a.quote.trim() && a.content.trim());
    if (unresolved.length === 0) return;
    setRevising(true);
    setReviseReport(null);
    try {
      const doneIds: string[] = [];
      const revised: ReviseReport['revised'] = [];
      const failed: ReviseReport['failed'] = [];
      for (const a of unresolved) {
        setRewritingId(a.id);
        const r = await rewriteSingle(a);
        if (r.ok) {
          doneIds.push(a.id);
          if (r.roundId) revised.push({ annotationId: a.id, roundId: r.roundId });
        } else {
          failed.push({ annotationId: a.id, quote: a.quote, reason: r.reason ?? 'AI 修订失败' });
        }
      }
      setRewritingId(null);
      setReviseReport({ total: unresolved.length, revised, failed, at: new Date().toISOString() });
      // 修改成功的批注标记为已解决
      if (doneIds.length > 0) {
        const done = new Set(doneIds);
        const nextAnnotations = annotations.map((x) => done.has(x.id) ? { ...x, resolved: true } : x);
        await persistAnnotations(nextAnnotations);
      }
    } catch (e) {
      console.error('[revise] 修订失败:', e);
    } finally {
      setRevising(false);
    }
  }, [editor, revising, annotations, rewriteSingle, persistAnnotations]);

  // ===== 修订接受 / 拒绝（作用于当前活动轮） =====
  /** 标记批注已解决（由"接受修订"触发：该轮来自某条批注的 AI 修改，接受即视为批注意见被采纳） */
  const resolveAnnotation = useCallback((id: string) => {
    setAnnotations((prev) =>
      prev.some((x) => x.id === id && !x.resolved)
        ? prev.map((x) => (x.id === id ? { ...x, resolved: true } : x))
        : prev,
    );
  }, []);
  const updateActiveRoundOps = useCallback((updater: (op: RevisionOp) => RevisionOp) => {
    setRevisionRounds((prev) =>
      prev.map((round) => (round.id === activeRoundId && round.ops ? { ...round, ops: round.ops.map(updater) } : round)),
    );
  }, [activeRoundId]);
  /** 更新活动轮 revisions 状态（patch / 旧 segments 轮次：渲染由切换 effect 按状态重建） */
  const updateActiveRoundRevisions = useCallback((updater: (rev: Revision) => Revision) => {
    setRevisionRounds((prev) =>
      prev.map((round) => (round.id === activeRoundId ? { ...round, revisions: round.revisions.map(updater) } : round)),
    );
  }, [activeRoundId]);
  /** 接受/拒绝一条改动：mark 轮次走原生命令（mark 立即应用/还原）+ ops 状态；patch/旧 segments 轮次走状态 + 重渲染 */
  const applyChangeStatus = useCallback((changeId: string, status: 'accepted' | 'rejected') => {
    if (!editor) return;
    const round = revisionRounds.find((r) => r.id === activeRoundId);
    if (round?.ops) {
      const cmds = trackCmds(editor);
      if (status === 'accepted') cmds.acceptChange(changeId);
      else cmds.rejectChange(changeId);
      updateActiveRoundOps((op) => (op.changeId === changeId ? { ...op, status } : op));
    } else {
      // patch / 旧 segments 轮次：更新 revisions 状态（切换 effect 按状态重建文档内容）
      updateActiveRoundRevisions((rev) => (rev.id === changeId ? { ...rev, status } : rev));
      // 该轮来自批注 AI 修改且被接受 → 源批注自动标记已解决（避免重复 AI 修改产生重复轮次）
      if (status === 'accepted' && round?.annotationId) resolveAnnotation(round.annotationId);
    }
  }, [editor, revisionRounds, activeRoundId, updateActiveRoundOps, updateActiveRoundRevisions, resolveAnnotation]);
  const acceptRevision = useCallback((id: string) => applyChangeStatus(id, 'accepted'), [applyChangeStatus]);
  const rejectRevision = useCallback((id: string) => applyChangeStatus(id, 'rejected'), [applyChangeStatus]);
  const acceptAllRevisions = useCallback(() => {
    if (!editor) return;
    const round = revisionRounds.find((r) => r.id === activeRoundId);
    if (round?.ops) {
      trackCmds(editor).acceptAll();
      updateActiveRoundOps((op) => ({ ...op, status: 'accepted' as const }));
    } else {
      updateActiveRoundRevisions((rev) => ({ ...rev, status: 'accepted' as const }));
      // 全部接受：该轮来自批注 AI 修改 → 源批注自动标记已解决
      if (round?.annotationId) resolveAnnotation(round.annotationId);
    }
  }, [editor, revisionRounds, activeRoundId, updateActiveRoundOps, updateActiveRoundRevisions, resolveAnnotation]);
  const rejectAllRevisions = useCallback(() => {
    if (!editor) return;
    const round = revisionRounds.find((r) => r.id === activeRoundId);
    if (round?.ops) {
      trackCmds(editor).rejectAll();
      updateActiveRoundOps((op) => ({ ...op, status: 'rejected' as const }));
    } else {
      updateActiveRoundRevisions((rev) => ({ ...rev, status: 'rejected' as const }));
    }
  }, [editor, revisionRounds, activeRoundId, updateActiveRoundOps, updateActiveRoundRevisions]);

  /** 切换活动轮：点击历史轮次 → 文档内容切换到该轮应用后的状态（并清除上一轮残留的修订聚焦） */
  const selectRevisionRound = useCallback((id: string) => {
    setFocusedRevision(null);
    setActiveRoundId(id);
  }, []);

  // 活动轮变化 → 重建编辑器内容（mark 轮次按 baseMd+ops 重放；patch 轮次按 diff 渲染；旧 segments 轮次按状态渲染）。
  // 整篇 setContent 会把编辑器选区重置到重建后的落点（文首附近），视图随之漂移 —— 这就是
  // 「AI 修改完成后跳到文档别的段落」的根因。这里：重建前记住视口 + 刚就地应用的改动锚点，
  // 重建后优先滚回改动处，无锚点时还原原视口；跨轮聚焦由下方聚焦 effect 负责滚动，此处不插手。
  useEffect(() => {
    if (!editor) return;
    const round = revisionRounds.find((r) => r.id === activeRoundId);
    if (!round) return;
    const scroller = editor.view.dom.parentElement;
    const prevScrollTop = scroller?.scrollTop ?? 0;
    const anchor = justAppliedAnchorRef.current;
    justAppliedAnchorRef.current = '';
    const focusScrollPending = pendingRevisionScrollRef.current;
    if (round.ops && round.baseMd !== undefined) {
      replayOps(editor, round.baseMd, round.ops);
    } else {
      const md = round.patch ? renderPatchRound(round) : renderRevisedMd(round.segments, round.revisions);
      editor.chain().setContent(md).run();
    }
    if (focusScrollPending) return;
    // rAF：等重建后的布局与浏览器自身的滚动补偿落定再恢复视口，避免被覆盖
    requestAnimationFrame(() => {
      const el = editor.view.dom.parentElement;
      if (!el) return;
      // 锚点取改动文字的首个非空行（单行锚点才能与无分隔符的纯文本对齐做精确索引）
      const needle = anchor.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
      const flat = editor.state.doc.textBetween(0, editor.state.doc.content.size, '');
      const idx = needle ? flat.indexOf(needle) : -1;
      const pos = idx >= 0 ? posAtTextIndex(editor.state.doc, idx) : null;
      if (pos == null) {
        el.scrollTop = prevScrollTop;
        return;
      }
      const coords = editor.view.coordsAtPos(pos);
      el.scrollTo({ top: coords.top - el.getBoundingClientRect().top + el.scrollTop - 80 });
    });
  }, [revisionRounds, activeRoundId, editor]);

  /** 滚动编辑器到指定位置（视图中部） */
  const scrollEditorTo = useCallback((from: number) => {
    if (!editor) return;
    const node = editor.view.domAtPos(from).node as Node | undefined;
    const target = node instanceof HTMLElement ? node : node?.parentElement;
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [editor]);

  /** 聚焦修订：切换到目标轮并定位高亮被修改处（优先修订后文字，未应用/拒绝时找修订前文字；
   *  表格等结构化修订用 diff 锚点回退定位） */
  const focusRevision = useCallback((roundId: string, oldText: string, newText: string) => {
    if (!editor) return;
    setFocusedRevision({ roundId, oldText, newText });
    if (roundId !== activeRoundId) {
      // 目标轮不是当前查看轮 → 切轮（文档重建后由聚焦 effect 定位 + 滚动一次）
      pendingRevisionScrollRef.current = true;
      setActiveRoundId(roundId);
      return;
    }
    // 已在目标轮 → 立即选中 + 滚动 + 高亮
    const round = revisionRounds.find((r) => r.id === roundId);
    const pos = locateRevision(editor, round, oldText, newText);
    if (!pos) {
      setLocateHint('Revision not found in the document — it may have been edited');
      return;
    }
    editor.chain().focus().setTextSelection(pos).run();
    scrollEditorTo(pos.from);
    const set = DecorationSet.create(editor.state.doc, [Decoration.inline(pos.from, pos.to, { class: 'md-revision-focus' })]);
    editor.view.dispatch(editor.state.tr.setMeta(mdRevisionFocusKey, set));
  }, [editor, activeRoundId, revisionRounds, scrollEditorTo]);

  // 活动轮切换 / 接受拒绝（文档重建）后：重新定位聚焦的修订并高亮；跨轮定位时滚动一次
  useEffect(() => {
    if (!editor || !focusedRevision) return;
    const round = revisionRounds.find((r) => r.id === focusedRevision.roundId);
    const pos = locateRevision(editor, round, focusedRevision.oldText, focusedRevision.newText);
    if (!pos) {
      editor.view.dispatch(editor.state.tr.setMeta(mdRevisionFocusKey, DecorationSet.empty));
      pendingRevisionScrollRef.current = false;
      setLocateHint('Revision not found in the document — it may have been edited');
      return;
    }
    const set = DecorationSet.create(editor.state.doc, [Decoration.inline(pos.from, pos.to, { class: 'md-revision-focus' })]);
    editor.view.dispatch(editor.state.tr.setMeta(mdRevisionFocusKey, set));
    if (pendingRevisionScrollRef.current) {
      pendingRevisionScrollRef.current = false;
      scrollEditorTo(pos.from);
    }
  }, [editor, revisionRounds, activeRoundId, focusedRevision, scrollEditorTo]);

  // 保持只读类与 editable 同步（Tiptap editorProps.attributes 仅在编辑器创建时应用）
  useEffect(() => {
    editor?.view.dom.classList.toggle('doc-editor-readonly', !editable);
  }, [editor, editable]);

  // ===== 目录（TOC） =====
  // 收集文档标题用于目录（依赖 tocTick 在内容变化后重算）
  const headings = useMemo(() => {
    if (!editor) return [] as { level: number; text: string; pos: number }[];
    const out: { level: number; text: string; pos: number }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        const text = node.textContent.replace(/\s+/g, ' ').trim();
        if (text) out.push({ level: node.attrs.level as number, text, pos });
      }
      return true;
    });
    return out;
  }, [editor, tocTick]);

  // 监听文档变化：重算目录
  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => {
      setTocTick((t) => t + 1);
    };
    editor.on('update', onUpdate);
    return () => {
      editor.off('update', onUpdate);
    };
  }, [editor]);

  // 滚动时高亮当前所在目录项
  useEffect(() => {
    if (!editor || !showToc) return;
    const scroller = editor.view.dom.parentElement;
    if (!scroller) return;
    const updateActive = () => {
      const headingEls = Array.from(editor.view.dom.querySelectorAll<HTMLElement>('[data-pos]'));
      let current: number | null = null;
      for (const el of headingEls) {
        const rect = el.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        if (rect.top >= scrollerRect.top - 8) {
          const pos = parseInt(el.dataset.pos || '0', 10);
          current = Number.isNaN(pos) ? null : pos;
          break;
        }
      }
      setActiveHeadingPos(current);
    };
    updateActive();
    scroller.addEventListener('scroll', updateActive, { passive: true });
    return () => scroller.removeEventListener('scroll', updateActive);
  }, [editor, showToc, tocTick]);

  // 目录项点击 → 硬切（瞬时跳转，不做平滑动画）到对应章节标题
  // 按 NodeView 的 data-pos 精确定位（domAtPos 对块级标题可能返回内部文本节点，定位不稳定）
  const scrollToHeading = useCallback(
    (pos: number) => {
      if (!editor) return;
      const el = editor.view.dom.querySelector(`[data-pos="${pos}"]`) as HTMLElement | null;
      el?.scrollIntoView({ behavior: 'auto', block: 'start' });
    },
    [editor],
  );

  // 目录弹窗容器：点击弹窗/按钮以外区域时自动关闭
  const tocRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showToc) return;
    const onDown = (e: PointerEvent) => {
      if (!tocRef.current?.contains(e.target as Node)) setShowToc(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [showToc]);

  // 赋值手动保存处理（在 editor 创建之后，闭包内引用 editor）
  handleSaveRef.current = () => {
    if (!editor) return;
    const md = getMarkdown(editor);
    onSaveRef.current?.(md);
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    saveToApiRef.current(restoreQuestionnaires(md));
  };

  // 同步 editable 属性变化
  useEffect(() => {
    if (editor) editor.setEditable(editable, false);
  }, [editor, editable]);

  // 外部 content 变化时更新编辑器（用问卷占位视图对比，避免父组件回传 onChange 结果时重置内容、导致光标跳动）
  useEffect(() => {
    if (!editor) return;
    const currentMd = getMarkdown(editor);
    if (qResult.editorContent !== currentMd) {
      // emitUpdate: false 不触发 onUpdate，避免循环
      editor.commands.setContent(qResult.editorContent, { emitUpdate: false });
    }
    lastContentRef.current = qResult.editorContent;
  }, [qResult.editorContent, editor]);

  // ===== 外部变更冲突：编辑期轮询检测 + 三选一动作 =====
  // 采纳外部版本（丢弃本地）：用冲突时拉到的磁盘正文重载编辑器并同步令牌
  const reloadExternal = useCallback(() => {
    if (conflict) {
      editor?.commands.setContent(extractQuestionnaires(conflict.current_content).editorContent, { emitUpdate: false });
      baseVersionRef.current = conflict.current_version;
      setSaveStatus('saved');
    }
    setConflict(null);
    setShowConflictDiff(false);
  }, [conflict, editor]);

  // 保留我的版本（覆盖外部）：不带令牌强制落盘，服务端跳过比对
  const forceSaveLocal = useCallback(() => {
    if (!editor) return;
    const md = restoreQuestionnaires(getMarkdown(editor));
    setConflict(null);
    setShowConflictDiff(false);
    saveToApiRef.current(md, true);
  }, [editor, restoreQuestionnaires]);

  // 编辑期轮询：检测磁盘 mtimeMs 令牌变化 → 干净态静默重载 / 脏态弹三选一横幅
  useEffect(() => {
    if (!editable) return;
    const hasTarget = !!nodeMdId || !!(filePath && projectId) || !!(filePath && source === 'local');
    if (!hasTarget) return;

    baseVersionRef.current = null; // 目标切换时重置令牌，避免与上一个目标的版本误比对
    let cancelled = false;

    const tick = async () => {
      if (cancelled || saveStatusRef.current === 'saving') return;
      const v = await fetchVersion();
      if (cancelled || v === null) return;
      if (baseVersionRef.current === null) {
        baseVersionRef.current = v;
        return;
      }
      if (Math.abs(v - baseVersionRef.current) <= 1) return;
      // 磁盘已被外部改写
      if (saveStatusRef.current === 'saved') {
        // 干净态：静默重载
        const body = await fetchFullBody();
        if (cancelled || body === null) return;
        editor?.commands.setContent(extractQuestionnaires(body).editorContent, { emitUpdate: false });
        baseVersionRef.current = v;
        setSaveStatus('saved');
      } else {
        // 脏态：弹三选一横幅（保留磁盘正文供对比）
        const body = await fetchFullBody();
        if (cancelled || body === null) return;
        setConflict({ current_content: body, current_version: v });
        setShowConflictDiff(false);
      }
    };

    void tick();
    const timer = setInterval(() => { void tick(); }, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [nodeMdId, filePath, projectId, source, editable, editor, fetchVersion, fetchFullBody]);

  // 卸载时清理计时器
  useEffect(() => {
    return () => {
      if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // DOCX 导出：读取编辑器 markdown → 转换 → 浏览器下载
  // 不注入文件名标题：正文写什么就导出什么，避免与正文已有的一级标题重复
  const handleExportDocx = useCallback(async (config: DocxExportConfig, fileName: string) => {
    if (!editor) return;
    const md = getMarkdown(editor);
    const blob = await convertMarkdownToDocx(md, config);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName.endsWith('.docx') ? fileName : `${fileName}.docx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [editor]);

  /** 打印期临时替换 document.title 前的原标题（恢复由 restorePrintTitle 统一负责） */
  const prevTitleRef = useRef<string | null>(null);

  /** 打印文件名：标题_v1_年月日（标题取文档标题 → 文件名 → document；日期用本地时间 YYYY-MM-DD） */
  const printFileName = useCallback(() => {
    const base = (docTitle || filePath?.split('/').pop()?.replace(/\.[^.]+$/, '') || 'document').trim();
    const d = new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    return `${base}_v1_${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }, [docTitle, filePath]);

  /** 还原被打印临时改写的 window 标题（幂等：未替换过则不动） */
  const restorePrintTitle = useCallback(() => {
    if (prevTitleRef.current !== null) {
      document.title = prevTitleRef.current;
      prevTitleRef.current = null;
    }
  }, []);

  /** 填充隐藏打印容器（doc-print-root）：打印 / PDF 导出 / HTML 导出共用 */
  const ensurePrintContent = useCallback((): HTMLElement | null => {
    if (!editor) return null;
    // editor.view.dom 自身即 .doc-editor-content（attributes.class 注入），
    // querySelector 只查后代、不匹配根自身 → 必须显式检测根，否则恒为 null 导致打印/导出无反应
    const contentEl = (editor.view.dom as HTMLElement).classList.contains('doc-editor-content')
      ? (editor.view.dom as HTMLElement)
      : editor.view.dom.querySelector<HTMLElement>('.doc-editor-content');
    if (!contentEl) return null;
    let printRoot = document.getElementById('doc-print-root');
    if (!printRoot) {
      printRoot = document.createElement('div');
      printRoot.id = 'doc-print-root';
      document.body.appendChild(printRoot);
    }
    printRoot.innerHTML = '';
    // 页眉：左侧品牌（图标 + BobWork 词标），最右侧打印时间（本地时间，YYYY-MM-DD HH:mm）
    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const header = document.createElement('div');
    header.className = 'doc-print-header';
    header.innerHTML =
      // 用 welcome-icon.png：与 welcome 屏同一个品牌标，且带 alpha 通道。
      // bobwork-logo.png 是不透明白底（WelcomeScreen 需 mix-blend-mode 融底），
      // 放进打印页眉会在白纸上留出明显的白色方块 → 不用。
      '<span class="doc-print-brand"><img src="/welcome-icon.png" alt="" />BobWork</span>'
      + `<span class="doc-print-time">${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}</span>`;
    printRoot.appendChild(header);
    const clone = contentEl.cloneNode(true) as HTMLElement;
    clone.removeAttribute('contenteditable');
    // 克隆体脱离 ProseMirror 交互态：清掉占位符提示与选中态装饰，避免打印出多余残留
    clone.removeAttribute('data-placeholder');
    printRoot.appendChild(clone);
    return printRoot;
  }, [editor]);

  /** 打印：克隆文档正文到隐藏打印容器，调用系统打印面板（@media print 只显示该容器） */
  const handlePrint = useCallback(async () => {
    const printRoot = ensurePrintContent();
    if (!printRoot) return;
    // 页眉 logo 是呼出打印面板前才插入的 DOM：等它解码完再打印，
    // 否则打印快照里会留下一个空白框（图片尚未加载/解码）。
    const logo = printRoot.querySelector('img');
    if (logo) {
      await Promise.race([
        logo.decode().catch(() => undefined),
        new Promise((resolve) => window.setTimeout(resolve, 1200)),
      ]);
    }
    // 打印文件名：浏览器「存储为 PDF」与系统打印面板都取 document.title 作为默认名 →
    // 打印期临时替换为「标题_v1_年月日」，打印结束后还原（见下方 restorePrintTitle）
    prevTitleRef.current = document.title;
    document.title = printFileName();
    // Electron：先走主进程 webContents.print 弹系统打印面板；浏览器（dev）回退 window.print()
    const api = (window as unknown as { api?: { print?: () => Promise<{ success?: boolean; error?: string }> } }).api;
    if (api?.print) {
      try {
        const res = await api.print();
        if (res && res.success === false) {
          // 主进程系统打印面板失败（如 macOS OOP printing 异常）→ alert 提示 + 兜底走
          // Chromium 原生 window.print()（系统打印面板稳定路径），保证打印始终可用
          alert(res.error || 'Print failed');
          window.print();
        }
      } catch (e) {
        alert(`Print failed: ${e instanceof Error ? e.message : String(e)}`);
        window.print();
      }
    } else {
      window.print();
    }
    restorePrintTitle();
  }, [ensurePrintContent, printFileName, restorePrintTitle]);

  /** 打印结束 / 编辑器卸载时移除克隆容器，避免残留节点长期挂在 body 下 */
  useEffect(() => {
    const dropPrintRoot = () => {
      document.getElementById('doc-print-root')?.remove();
      // 兜底还原标题：某些环境（Electron 系统面板）不触发 afterprint
      restorePrintTitle();
    };
    window.addEventListener('afterprint', dropPrintRoot);
    return () => {
      window.removeEventListener('afterprint', dropPrintRoot);
      dropPrintRoot();
    };
  }, [restorePrintTitle]);

  /** 新建 md 文档：在当前文档所在目录创建 untitled.md 并打开。
   *  支持本地文件（绝对路径父目录）与项目文件（项目内相对目录）两种场景；
   *  其他场景（节点文档/docx 编辑）点击给出明确提示，避免"点了没反应"。 */
  /** 问卷面板写回：把带答案的 JSON 写入文档，并通知预览刷新以回显答案 */
  const handleQuestionnaireWriteBack = useCallback(
    async (updates: { placeholder: string; json: string }[]) => {
      if (!editor) return;
      // 更新映射：写回后占位符对应的原始 JSON 变为带答案版本（供后续自动保存还原）
      for (const u of updates) {
        const existing = qBlocksRef.current.find((b) => b.placeholder === u.placeholder);
        if (existing) existing.raw = `\`\`\`json\n${u.json}\n\`\`\``;
      }
      let md = getMarkdown(editor);
      for (const u of updates) {
        const blockMd = `\`\`\`json\n${u.json}\n\`\`\``;
        if (md.includes(u.placeholder)) md = md.replace(u.placeholder, blockMd);
        else md += `\n\n${blockMd}`;
      }
      await saveToApiRef.current(md);
      // 刷新预览 content：面板回显答案，编辑器保持占位符视图
      if (nodeMdId) {
        window.dispatchEvent(new CustomEvent('node-document-updated', { detail: { node_id: nodeMdId } }));
      }
    },
    [editor, nodeMdId],
  );

  // 工具栏：添加链接
  /** 当前文档可分享的相对/绝对路径（分享用）：优先 filePath；nodeMdId 场景暂不分享 */
  const sharePathForDoc = useCallback((): string | null => {
    if (filePath) return filePath;
    return null;
  }, [filePath]);

  /** 分享当前文档：生成局域网分享链接并复制到剪贴板 */
  const handleShareDocument = useCallback(async () => {
    const path = sharePathForDoc();
    if (!path) {
      showImageAiEditToast('This document cannot be shared (only saved project or local files can be shared)', 'error');
      return;
    }
    try {
      const resp = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await resp.json();
      if (!data.success || !data.url) {
        showImageAiEditToast(`Share failed: ${data.error ?? 'unknown'}`, 'error');
        return;
      }
      await navigator.clipboard.writeText(data.url).catch(() => {});
      showImageAiEditToast(`Share link copied: ${data.url}`);
    } catch (e) {
      showImageAiEditToast(`Share failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }, [sharePathForDoc]);

  /** 嵌入卡片点击 → 打开目标文档（复用分享链接在应用内打开） */
  useEffect(() => {
    const onOpen = (e: Event) => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (!path) return;
      void fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.success && d.url) window.open(d.url, '_blank');
        })
        .catch(() => {});
    };
    window.addEventListener('md-embed-open', onOpen);
    return () => window.removeEventListener('md-embed-open', onOpen);
  }, []);

  /** 嵌入卡片展开预览：宿主按当前文档所属通道读取目标文档开头内容并回传给卡片 */
  useEffect(() => {
    const onRequest = (e: Event) => {
      const d = (e as CustomEvent<{ path?: string; rid?: number }>).detail;
      if (!d || !d.path) return;
      const targetPath = d.path;
      void (async () => {
        let content: string | null = null;
        try {
          if (projectId) {
            const r = await fetch('/api/projects', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'read_file', project_id: projectId, file_path: targetPath }),
            }).then((x) => x.json());
            if (typeof r.content === 'string') content = r.content;
          } else if (nodeMdId) {
            // 节点文档通道：目标 path 视为同一节点库下的文档 id（无法解析则返回不可读）
            const q = new URLSearchParams({ id: targetPath.replace(/\.md$/i, ''), action: 'raw' });
            const r = await fetch(`/api/nodes?${q}`).then((x) => x.json());
            if (typeof r.content === 'string') content = r.content;
          } else if (source === 'local') {
            const q = new URLSearchParams({ action: 'read_file', path: targetPath });
            const r = await fetch(`/api/local-files?${q}`).then((x) => x.json());
            if (typeof r.content === 'string') content = r.content;
          }
        } catch { /* 通道不可用 → 无法预览 */ }
        if (content !== null) {
          const clean = stripFrontmatterLocal(content).replace(/\s+/g, ' ').trim();
          window.dispatchEvent(new CustomEvent('md-embed-preview-result', {
            detail: { rid: d.rid, ok: true, text: clean.length > 600 ? `${clean.slice(0, 600)}…` : clean },
          }));
        } else {
          window.dispatchEvent(new CustomEvent('md-embed-preview-result', { detail: { rid: d.rid, ok: false } }));
        }
      })();
    };
    window.addEventListener('md-embed-preview-request', onRequest);
    return () => window.removeEventListener('md-embed-preview-request', onRequest);
  }, [projectId, nodeMdId, source]);

  /** 格式化文档：轻量整理 markdown（标题空格/空行/行尾空白） */
  const handleFormatMarkdown = useCallback(() => {
    if (!editor) return;
    const md = getMarkdown(editor);
    const formatted = formatMarkdown(md);
    if (formatted !== md) editor.chain().setContent(formatted).run();
  }, [editor]);

  /** 导出用 markdown 快照：卡片 / 文档产物统一取源（惰性求值，点导出时才序列化） */
  const getExportMarkdown = useCallback(() => (editor ? getMarkdown(editor) : ''), [editor]);

  /** 导出草稿身份：优先文件路径，其次节点 id（同一文档复用草稿；都没有时由 ExportMenu 退化为内容哈希） */
  const exportDocKey = filePath || nodeMdId || undefined;

  /** 打开查找替换栏：有选区时用选区文字预填（⌘⇧F / 右上角按钮 / 右键菜单共用同一入口） */
  const openFind = useCallback(() => {
    const view = editor?.view;
    if (view) {
      const sel = view.state.selection;
      if (!sel.empty) {
        const text = view.state.doc.textBetween(sel.from, sel.to, '\n').trim();
        if (text) setFindQuery(text);
      }
    }
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, [editor]);
  openFindRef.current = openFind;

  /** 命令集：右键菜单统一入口（格式/段落/插入/历史/工具） */
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    if (!editor) return [];
    const cmds: PaletteCommand[] = [];
    // 注意：push 顺序决定右键菜单各行的排列顺序（下方 ctxRows 按此顺序过滤挑选）
    const push = (group: string, id: string, label: string, hint: string | undefined, run: () => void) =>
      cmds.push({ id: `${group}:${id}`, group, label, hint, run });
    // 历史
    push('Format', 'undo', 'Undo', '⌘Z', () => editor.chain().focus().undo().run());
    push('Format', 'redo', 'Redo', '⇧⌘Z', () => editor.chain().focus().redo().run());
    // 段落：标题 1-3 / 正文、字符格式、列表、引用、代码块已移至划词气泡顶部工具栏（分隔线留在此菜单）
    // 插入（链接/图片/文档/脚注改为粘贴自动识别，不再提供按钮）
    // label 为右键菜单竖向条目的可见文字：统一压到单个单词（最多的 "2-Column"/"3-Column" 用连字符区分栏数）
    push('Insert', 'table', 'Table', '', () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run());
    push('Insert', 'columns2', '2-Column', '', () => editor.chain().focus().insertBobColumns(2).run());
    push('Insert', 'columns3', '3-Column', '', () => editor.chain().focus().insertBobColumns(3).run());
    // 分隔线从划词气泡工具栏移回此处（会替换选中文字 / 在光标处插入一条 ---）
    push('Insert', 'hr', 'Divider', '', () => editor.chain().focus().setHorizontalRule().run());
    // 工具
    push('Tools', 'find', 'Find', '⌘⇧F', openFind);
    push('Tools', 'format', 'Format', '', handleFormatMarkdown);
    push('Tools', 'annotations', 'Annotations', '', () => setAnnotationPanelOpen((v) => !v));
    push('Tools', 'export', 'Export', 'Card/Poster/Article/HTML', () => setShowExportMenu(true));
    // DOCX 从导出菜单里提出来单独成键（少一层弹窗）；PDF 不设条目，用系统打印面板另存
    push('Tools', 'docx', 'Word', '.docx', () => setShowExportDialog(true));
    push('Tools', 'print', 'Print', '', handlePrint);
    push('Tools', 'share', 'Share', '', handleShareDocument);
    return cmds;
  }, [editor, handleFormatMarkdown, handlePrint, handleShareDocument, openFind]);


  /** 从当前选区向上查找所在表格节点，返回其文档位置（不在表格内则 null） */
  const findTablePos = useCallback((ed: Editor | null): number | null => {
    if (!ed) return null;
    const { selection } = ed.state;
    for (let d = selection.$from.depth; d >= 0; d--) {
      const node = selection.$from.node(d);
      if (node.type.name === 'table') return selection.$from.before(d);
    }
    return null;
  }, []);

  // 表格浮动工具栏：光标移入/移出表格时更新锚点（定位在表格上方，居中于光标）
  useEffect(() => {
    if (!editor || !editable) {
      setTableMenu(null);
      return;
    }
    const update = () => {
      const pos = findTablePos(editor);
      if (pos == null) {
        setTableMenu(null);
        return;
      }
      const coords = editor.view.coordsAtPos(pos);
      const selCoords = editor.view.coordsAtPos(editor.state.selection.from);
      const above = coords.top - 48 > 0;
      setTableMenu({
        x: Math.min(selCoords.left, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 320),
        y: above ? coords.top - 8 : coords.bottom + 8,
        above,
      });
    };
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    update();
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
    };
  }, [editor, editable, findTablePos]);

  /** 全文检索匹配区间。
   *  不能用「textBetween(…, '\n') 的索引 + 1」换算 doc 位置：块分隔符在文本里占 1 个字符、
   *  在文档位置里却不存在，于是第 k 个文本块内的匹配会被低估 k 个位置（k = 其前置文本块数），
   *  越靠后偏移越大——这正是「搜索高亮文字不准确」的根因（同类坑见上方 posAtTextIndex 注释）。
   *  这里按节点一次性建立「字符偏移 → doc 位置」映射：文本节点内部位置连续（跨 mark 也能命中），
   *  块边界与行内叶节点写 -1 占位，跨越占位符的匹配直接丢弃，避免拼出假匹配或横跨换行/图片的高亮。 */
  const computeFindMatches = useCallback(
    (view: EditorView | null, query: string): { from: number; to: number }[] => {
      if (!view || !query) return [];
      let text = '';
      const posOf: number[] = []; // posOf[i] = 第 i 个字符的 doc 位置；-1 = 占位符（不可匹配）
      let firstBlock = true;
      view.state.doc.descendants((node, pos) => {
        if (node.isText) {
          const t = node.text ?? '';
          for (let i = 0; i < t.length; i++) posOf.push(pos + i);
          text += t;
          return false;
        }
        if (node.isInline && node.isLeaf) {
          // 行内叶节点（硬换行 / 行内图片）：不贡献文本，占 1 位防止匹配跨越它
          text += '\n';
          posOf.push(-1);
          return false;
        }
        if (node.isTextblock) {
          if (firstBlock) firstBlock = false;
          else { text += '\n'; posOf.push(-1); }
        }
        return true;
      });
      const matches: { from: number; to: number }[] = [];
      let idx = 0;
      while ((idx = text.indexOf(query, idx)) >= 0) {
        const end = idx + query.length;
        let valid = true;
        for (let i = idx; i < end; i++) {
          if (posOf[i] < 0) { valid = false; break; }
        }
        if (valid) matches.push({ from: posOf[idx], to: posOf[end - 1] + 1 });
        idx = end;
      }
      return matches;
    },
    [],
  );

  /** 应用查找装饰（当前项不同色高亮）+ 定位选区；scroll=true 时滚动到当前项 */
  const applyFindDecos = useCallback(
    (view: EditorView, matches: { from: number; to: number }[], activeIdx: number, scroll: boolean) => {
      let tr = view.state.tr;
      if (matches.length === 0) {
        tr = tr.setMeta(findDecoKey, DecorationSet.empty);
      } else {
        const decos = matches.map((m, i) =>
          Decoration.inline(m.from, m.to, { class: i === activeIdx ? 'md-find-active' : 'md-find-match' }),
        );
        tr = tr.setMeta(findDecoKey, DecorationSet.create(view.state.doc, decos));
        const m = matches[Math.max(0, activeIdx)];
        tr = tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to));
      }
      view.dispatch(tr);
      if (scroll && matches.length > 0) {
        const m = matches[Math.max(0, activeIdx)];
        const coords = view.coordsAtPos(m.from);
        const scroller = view.dom.parentElement;
        if (scroller) {
          scroller.scrollTo({
            top: scroller.scrollTop + coords.top - scroller.getBoundingClientRect().top - 90,
            behavior: 'smooth',
          });
        }
      }
    },
    [],
  );

  /** 查找词变化 / 替换后：重算匹配并定位到指定索引（scroll 控制是否滚动到当前项） */
  const refreshFind = useCallback(
    (nextIdx: number, scroll: boolean) => {
      const view = editor?.view;
      if (!view) return;
      const matches = computeFindMatches(view, findQuery);
      setFindMatches(matches);
      if (matches.length === 0) {
        setFindIndex(-1);
        applyFindDecos(view, [], -1, false);
        return;
      }
      const idx = nextIdx < 0 ? 0 : Math.min(nextIdx, matches.length - 1);
      setFindIndex(idx);
      applyFindDecos(view, matches, idx, scroll);
    },
    [editor, findQuery, computeFindMatches, applyFindDecos],
  );

  /** 上一个 / 下一个匹配（循环） */
  const goFind = useCallback(
    (dir: 1 | -1) => {
      if (findMatches.length === 0) return;
      const next = (findIndex + dir + findMatches.length) % findMatches.length;
      refreshFind(next, true);
    },
    [findMatches.length, findIndex, refreshFind],
  );

  /** 替换当前匹配：替换后从当前索引重算（自动定位到下一处） */
  const replaceCurrent = useCallback(() => {
    const view = editor?.view;
    if (!view || findIndex < 0 || findIndex >= findMatches.length) return;
    const m = findMatches[findIndex];
    let tr = view.state.tr;
    tr = tr.insertText(replaceQuery, m.from, m.to);
    view.dispatch(tr);
    refreshFind(findIndex, false);
  }, [editor, findIndex, findMatches, replaceQuery, refreshFind]);

  /** 全部替换：从后往前插入避免位置偏移 */
  const replaceAll = useCallback(() => {
    const view = editor?.view;
    if (!view || findMatches.length === 0) return;
    let tr = view.state.tr;
    for (let i = findMatches.length - 1; i >= 0; i--) {
      const m = findMatches[i];
      tr = tr.insertText(replaceQuery, m.from, m.to);
    }
    view.dispatch(tr);
    refreshFind(-1, false);
  }, [editor, findMatches, replaceQuery, refreshFind]);

  /** 关闭查找栏并清除高亮 */
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery('');
    setReplaceQuery('');
    setFindMatches([]);
    setFindIndex(-1);
    setFindMode('text');
    const view = editor?.view;
    if (view) view.dispatch(view.state.tr.setMeta(findDecoKey, DecorationSet.empty));
    editor?.commands.focus();
  }, [editor]);

  /** 语义检索结果跳转：按 quote 在正文中精确定位（findQuoteWithContext，非子串近似）
   *  → 选中 + 临时高亮（复用查找高亮装饰）+ 滚动到视口。返回是否成功定位，
   *  false 时由调用方提示「文档已改动、找不到该片段」。 */
  const jumpToQuote = useCallback(
    (quote: string): boolean => {
      const view = editor?.view;
      if (!view || !quote) return false;
      const range = findQuoteWithContext(view.state.doc, quote);
      if (!range) return false;
      let tr = view.state.tr;
      tr = tr.setMeta(
        findDecoKey,
        DecorationSet.create(view.state.doc, [Decoration.inline(range.from, range.to, { class: 'md-find-active' })]),
      );
      tr = tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to));
      view.dispatch(tr);
      const coords = view.coordsAtPos(range.from);
      const scroller = view.dom.parentElement;
      if (scroller) {
        scroller.scrollTo({
          top: scroller.scrollTop + coords.top - scroller.getBoundingClientRect().top - 90,
          behavior: 'smooth',
        });
      }
      return true;
    },
    [editor],
  );

  /** 一致性检查（仅当前文档）：编号 / 交叉引用确定性查 + 术语交模型分组（见 /api/md-consistency） */
  const runConsistencyCheck = useCallback(async () => {
    if (!editor || checking) return;
    setChecking(true);
    try {
      const resp = await fetch('/api/md-consistency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ md: getMarkdown(editor) }),
      });
      const data = (await resp.json()) as { success?: boolean; items?: ConsistencyItem[]; error?: string };
      if (!data.success) {
        setConsistencyItems([
          { key: 'check-error', level: 'fail', msg: data.error || 'Consistency check failed', kind: 'numbering', locate: '' },
        ]);
        return;
      }
      setConsistencyItems(data.items ?? []);
    } catch (e) {
      setConsistencyItems([
        {
          key: 'check-error',
          level: 'fail',
          msg: e instanceof Error ? e.message : String(e),
          kind: 'numbering',
          locate: '',
        },
      ]);
    } finally {
      setChecking(false);
    }
  }, [editor, checking]);

  /** 点击检查项 → 跳转到正文对应位置（复用语义导航同款精确定位 + 临时高亮） */
  const jumpToCheck = useCallback(
    (item: ConsistencyItem) => {
      if (!item.locate) return;
      if (!jumpToQuote(item.locate)) showImageAiEditToast('Could not locate this text in the document', 'error');
    },
    [jumpToQuote],
  );

  // 文档变更 → 清空过期的一致性检查结果（避免把旧结论当现行事实）
  useEffect(() => {
    if (!editor) return;
    const clear = () => setConsistencyItems(null);
    editor.on('update', clear);
    return () => { editor.off('update', clear); };
  }, [editor]);

  // 查找词变化 → 实时刷新匹配（打开时预填选区文字也会走到这里）
  useEffect(() => {
    if (!findOpen) return;
    if (findQuery) refreshFind(0, false);
    else {
      setFindMatches([]);
      setFindIndex(-1);
      const view = editor?.view;
      if (view) view.dispatch(view.state.tr.setMeta(findDecoKey, DecorationSet.empty));
    }
  }, [findOpen, findQuery, refreshFind, editor]);

  /** 执行命令面板命令（右键菜单点击 → 关闭菜单并执行） */
  const runPaletteCommand = useCallback((cmd: PaletteCommand) => {
    setCtxMenu(null);
    cmd.run();
  }, []);

  /** 划词引用：把选中段落发送到目标节点挂为输入框上方引用标签（current=当前活跃节点 / new=新建节点），等用户补写问题后发送 */
  const handleAskInNode = useCallback(
    (quote: string, target: 'current' | 'new') => {
      if (target === 'new') {
        window.dispatchEvent(new CustomEvent('node-create-and-ask', { detail: { text: quote } }));
        return;
      }
      // 「当前节点」优先取本文档所属节点（nodeMdId）。节点文档在阅读器里打开时，
      // canvas 上的 React Flow 选中（node-selected）可能与文档归属不一致——用户打开/阅读 A 的
      // 文档时画布可能仍停留在 B 的选中态，导致引用错落到 B（“点击发送到节点，不是当前节点”）。
      // 与划词引用同口径：以文档归属节点为准。
      // 兜底链：本文档所属节点 → 画布 live 选中 → 中间区域可见的会话（用户点进输入框后选中态会丢）
      const targetNodeId = nodeMdId || activeNodeId || activeSessionNodeId;
      if (!targetNodeId) return;
      window.dispatchEvent(new CustomEvent('node-ask-question', { detail: { nodeId: targetNodeId, text: quote } }));
      // 目标节点 ≠ 画布当前选中节点时，把它切换为当前打开节点：输入框 + 引用标签在目标节点上可见，
      // 避免引用挂到“看不到”的节点上造成困惑（Ask 后让目标成为可见的当前节点）。
      if (nodeMdId && nodeMdId !== activeNodeId) {
        window.dispatchEvent(new CustomEvent('canvas-focus-node', { detail: { nodeId: nodeMdId } }));
      }
    },
    [nodeMdId, activeNodeId, activeSessionNodeId],
  );


  // 本地图片选择 → 上传到节点附件目录 → 以附件 URL 插入编辑器
  if (!editor) {
    return <div className="doc-editor-loading p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>Loading editor...</div>;
  }

  // 右键菜单命令分组（按 Format/Insert/Tools 三类归拢，供下方合成两行）
  const ctxGroups: { items: PaletteCommand[] }[] = (() => {
    const g = { fmt: [], ins: [], tls: [] } as Record<string, PaletteCommand[]>;
    for (const c of paletteCommands) {
      if (c.group === 'Format') g.fmt.push(c);
      else if (c.group === 'Insert') g.ins.push(c);
      else if (c.group === 'Tools') g.tls.push(c);
    }
    return [g.fmt, g.ins, g.tls].map((items) => ({ items }));
  })();

  // 右键菜单结构：顶行图标（撤销/重做 ｜ 打印/分享…）+ 其余命令竖向「图标 + 文字」依次排开
  //（标题 1-3、字符格式、列表、引用、代码块、分隔线已移至划词气泡顶部工具栏）
  const ctxRows: { key: string; items: PaletteCommand[] }[] = (() => {
    const cmdId = (c: PaletteCommand) => c.id.slice(c.id.indexOf(':') + 1);
    const tools = ctxGroups[2]?.items ?? [];
    // 顺序由 paletteCommands 的 push 顺序决定，这里的 ids 只做筛选
    const pickTools = (ids: string[]) => tools.filter((c) => ids.includes(cmdId(c)));
    const topIds = ['undo', 'redo', 'print', 'share'];
    return [
      { key: 'top-icons', items: [...(ctxGroups[0]?.items ?? []), ...pickTools(['print', 'share'])] },
      { key: 'vertical', items: paletteCommands.filter((c) => !topIds.includes(cmdId(c))) },
    ];
  })();

  return (
    <div
      className="doc-editor-wrapper flex flex-col h-full"
      style={{ position: 'relative' }}
      onClick={() => {}}
    >
      {/* 外部变更冲突横幅：磁盘已被外部（AI 等）改写且本地有未保存改动，三选一处理 */}
      {conflict && (
        <div
          className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
          style={{ borderColor: 'color-mix(in oklab, var(--warn) 40%, transparent)', backgroundColor: 'color-mix(in oklab, var(--warn) 10%, transparent)' }}
        >
          <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: 'var(--warn)' }} />
          <span className="text-13" style={{ color: 'var(--ink)' }}>This document was changed elsewhere.</span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              type="button"
              onClick={reloadExternal}
              variant="outline"
              tone="neutral"
              size="sm"
            >
              Reload
            </Button>
            <Button
              type="button"
              onClick={forceSaveLocal}
              variant="solid"
              tone="info"
              size="sm"
            >
              Keep mine
            </Button>
            <Button
              type="button"
              onClick={() => setShowConflictDiff((v) => !v)}
              variant="outline"
              tone="neutral"
              size="sm"
            >
              Compare
            </Button>
          </div>
        </div>
      )}
      {conflict && showConflictDiff && (
        <div
          className="max-h-64 overflow-auto border-b px-3 py-2 font-mono text-xs"
          style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-soft)', whiteSpace: 'pre-wrap' }}
        >
          {lineDiff(editor ? getMarkdown(editor) : '', conflict.current_content).map((r, i) => (
            <div
              key={i}
              style={{
                color: r.type === 'add' ? 'var(--success)' : r.type === 'del' ? 'var(--danger)' : 'var(--ink-muted)',
              }}
            >
              {r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}{r.text || ' '}
            </div>
          ))}
        </div>
      )}

      {/* 查找栏（⌘F）：固定在工具栏与内容区之间，不随文档滚动。
          两种模式：Text=关键词子串查找/替换；Semantic=按主题检索条款（AI 分块定位，见 MdSemanticNav）。 */}
      {findOpen && (
        <div
          className="flex flex-col border-b"
          style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-soft)' }}
        >
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          {/* 模式切换：Text | Semantic（与右侧栏 tab 同款分段控件） */}
          <div className="flex shrink-0 items-center gap-0.5 rounded-md p-0.5" style={{ backgroundColor: 'var(--paper-hover)', boxShadow: 'inset 0 1px 2px rgba(23,23,23,0.06)' }}>
            <button
              type="button"
              onClick={() => setFindMode('text')}
              className="rounded px-1.5 py-0.5 text-10 font-medium transition-colors"
              style={{
                backgroundColor: findMode === 'text' ? 'var(--paper)' : 'transparent',
                boxShadow: findMode === 'text' ? '0 1px 2px rgba(23,23,23,0.1)' : 'none',
                color: findMode === 'text' ? 'var(--primary)' : 'var(--ink-muted)',
              }}
              title="Keyword find & replace"
            >
              Text
            </button>
            <button
              type="button"
              onClick={() => setFindMode('semantic')}
              className="rounded px-1.5 py-0.5 text-10 font-medium transition-colors"
              style={{
                backgroundColor: findMode === 'semantic' ? 'var(--paper)' : 'transparent',
                boxShadow: findMode === 'semantic' ? '0 1px 2px rgba(23,23,23,0.1)' : 'none',
                color: findMode === 'semantic' ? 'var(--primary)' : 'var(--ink-muted)',
              }}
              title="Find clauses by topic (AI)"
            >
              Semantic
            </button>
          </div>

          {findMode === 'text' && (
            <>
          <div className="flex items-center gap-1.5">
            <Search className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
            <input
              ref={findInputRef}
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); findInputRef.current?.focus(); findInputRef.current?.select(); }
                else if (e.key === 'Enter') { e.preventDefault(); goFind(e.shiftKey ? -1 : 1); }
                else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
                else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); replaceInputRef.current?.focus(); }
              }}
              placeholder="Find…"
              className="h-7 w-44 rounded-lg border bg-transparent px-2.5 text-13 outline-none"
              style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}
            />
            <span className="w-10 shrink-0 text-center text-11 tabular-nums" style={{ color: 'var(--ink-faint)' }}>
              {findQuery ? (findIndex >= 0 ? `${findIndex + 1}/${findMatches.length}` : '0') : ''}
            </span>
            <Button
              type="button"
              onClick={() => goFind(-1)}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              title="Previous (Shift+Enter)"
              aria-label="Previous match"
            >
              ↑
            </Button>
            <Button
              type="button"
              onClick={() => goFind(1)}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              title="Next (Enter)"
              aria-label="Next match"
            >
              ↓
            </Button>
            <Button
              type="button"
              onClick={closeFind}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              title="Close (Esc)"
              aria-label="Close find"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          {findQuery && (
            <>
              <span style={{ width: '1px', height: '18px', backgroundColor: 'var(--line)' }} />
              <div className="flex items-center gap-1.5">
                <input
                  ref={replaceInputRef}
                  value={replaceQuery}
                  onChange={(e) => setReplaceQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); findInputRef.current?.focus(); findInputRef.current?.select(); }
                    else if (e.key === 'Enter') { e.preventDefault(); replaceCurrent(); }
                    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
                  }}
                  placeholder="Replace…"
                  className="h-7 w-44 rounded-lg border bg-transparent px-2.5 text-13 outline-none"
                  style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}
                />
                <Button
                  type="button"
                  onClick={replaceCurrent}
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  title="Replace current (Enter)"
                >
                  Replace
                </Button>
                <Button
                  type="button"
                  onClick={replaceAll}
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  title="Replace all"
                >
                  All
                </Button>
              </div>
            </>
          )}
            </>
          )}

          {/* Semantic 模式：关闭按钮（Text 模式的关闭按钮在查找控件组内） */}
          {findMode === 'semantic' && (
            <Button
              type="button"
              onClick={closeFind}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              className="ml-auto"
              title="Close (Esc)"
              aria-label="Close find"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {/* Semantic 模式：按主题检索条款（AI 单次分块定位），结果点击跳转并高亮 */}
        {findMode === 'semantic' && (
          <MdSemanticNav md={editor ? getMarkdown(editor) : ''} onJump={jumpToQuote} />
        )}
        </div>
      )}

      {/* 编辑器内容区：主编辑区（目录已改为右上角弹窗，不再占用左侧栏） */}
      <div className="doc-editor-body relative flex min-h-0 flex-1">
        {/* 主编辑区外层：relative 承载右上角目录弹窗，使其不随正文滚动、也不被滚动容器裁剪 */}
        <div className="relative flex min-w-0 flex-1">
        <div
          className="relative flex min-w-0 flex-1 flex-col overflow-y-auto ai-canvas-scroll hide-scrollbar"
          style={{ backgroundColor: '#fff' }}
          onContextMenu={(e) => {
            // 正文右键：阻止系统菜单，弹出命令菜单（仅可编辑态）
            if (!editable) return;
            e.preventDefault();
            setCtxMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          {/* 问卷交互面板（文档含 ```json 问卷块时显示） */}
          {qResult.blocks.length > 0 && (
            <QuestionnairePanel blocks={qResult.blocks} onWriteBack={handleQuestionnaireWriteBack} />
          )}
          {/* 定位提示：修订文字未找到时可见反馈 */}
          {locateHint && (
            <div
              className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 whitespace-nowrap rounded-lg border px-3 py-1.5 text-11 shadow-lg"
              style={{ backgroundColor: 'var(--popover)', borderColor: 'var(--line)', color: 'var(--ink-muted)' }}
            >
              {locateHint}
            </div>
          )}
          {/* EditorContent 包装层必须为纵向 flex 并撑满滚动区，.doc-editor-content 的 flex:1 才能把纸张卡片自然填满预览高度（否则短文档只占 min-height:200px，下方留白） */}
          <EditorContent editor={editor} className="flex min-h-0 flex-1 flex-col" />
        </div>

        {!hideToc && (
          <div ref={tocRef} className="absolute right-2 top-2 z-30 flex flex-col items-end">
            {/* 文档工具图标（同排）：查找替换 + 目录 */}
            <div className="flex items-center gap-1">
              {editable && (
                <button
                  type="button"
                  onClick={() => { setShowToc(false); openFind(); }}
                  title="Find and replace (⌘⇧F)"
                  aria-label="Find and replace"
                  className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-[color-mix(in_oklab,var(--ink)_10%,transparent)]"
                  style={{ color: 'var(--ink-muted)' }}
                >
                  <Search className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowToc((v) => !v)}
                title={showToc ? 'Hide outline' : 'Show outline'}
                className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-[color-mix(in_oklab,var(--ink)_10%,transparent)]"
                style={{ color: 'var(--ink-muted)', backgroundColor: showToc ? 'color-mix(in oklab, var(--ink) 6%, transparent)' : 'transparent' }}
              >
                <ListTree className="h-3.5 w-3.5" />
              </button>
            </div>
            {/* 目录弹窗：灰色底；点击目录项硬切到对应章节且保持展开，仅在点击弹窗/按钮以外区域时收起 */}
            {showToc && headings.length > 0 && (
              <div
                className="mt-1 w-64 max-h-[60vh] overflow-y-auto rounded-lg border py-2 shadow-xl ai-canvas-scroll"
                style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-soft)' }}
              >
                <div className="px-3 pb-1.5 text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
                  Outline
                </div>
                {headings.map((h) => {
                  const active = activeHeadingPos === h.pos;
                  return (
                    <button
                      key={h.pos}
                      onClick={() => {
                        // 点击目录项只做硬切跳转，不收起弹窗（保持展开以连续翻阅章节）
                        scrollToHeading(h.pos);
                      }}
                      title={h.text}
                      className="group relative block w-full truncate px-3 py-1 text-left text-xs transition-colors"
                      style={{
                        paddingLeft: 12 + (h.level - 1) * 14,
                        color: active ? 'var(--primary)' : 'var(--ink)',
                        fontWeight: h.level === 1 ? 600 : 400,
                        backgroundColor: active ? 'color-mix(in oklab, var(--primary) 6%, transparent)' : 'transparent',
                      }}
                      onMouseEnter={(e) => {
                        if (!active) e.currentTarget.style.backgroundColor = 'color-mix(in oklab, var(--ink) 5%, transparent)';
                      }}
                      onMouseLeave={(e) => {
                        if (!active) e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                    >
                      {active && (
                        <span
                          className="absolute left-0 top-0 bottom-0 w-0.5 rounded-r"
                          style={{ backgroundColor: 'var(--primary)' }}
                        />
                      )}
                      {h.text}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        </div>

        {/* 右侧批注 + 修订栏（仅可编辑且有 sidecar key 时显示） */}
        {editable && annotationKey && (
          <MdAnnotationPanel
            open={annotationPanelOpen}
            annotations={annotations}
            revisionRounds={revisionRounds}
            activeRoundId={activeRoundId}
            onSelectRound={selectRevisionRound}
            revising={revising}
            onClose={() => setAnnotationPanelOpen(false)}
            onDeleteAnnotation={deleteAnnotation}
            onUpdateAnnotation={updateAnnotation}
            onJumpToAnnotation={jumpToAnnotation}
            onRevise={reviseFromAnnotations}
            onAcceptRevision={acceptRevision}
            onRejectRevision={rejectRevision}
            onAcceptAll={acceptAllRevisions}
            onRejectAll={rejectAllRevisions}
            onRewriteAnnotation={rewriteAnnotation}
            onRewriteAll={rewriteAllAnnotations}
            rewritingAll={rewritingAll}
            rewritingId={rewritingId}
            onFocusRevision={focusRevision}
            reviseReport={reviseReport}
            consistencyItems={consistencyItems ?? undefined}
            checking={checking}
            onRunChecks={runConsistencyCheck}
            onJumpToCheck={jumpToCheck}
            view={annotationView}
            onViewChange={setAnnotationView}
          />
        )}
      </div>

      {/* 批注结尾图标查看卡片：点击图标弹出，纯查看批注内容；点外部 / Esc / 滚动关闭 */}
      {annotationCard &&
        (() => {
          const ann = annotations.find((x) => x.id === annotationCard.id);
          if (!ann) return null;
          const intentDef = ann.intent ? ANNOTATION_INTENTS.find((x) => x.id === ann.intent) : undefined;
          // 图标下方 8px 弹出；下方空间不足（预估卡片高 ≤260px）翻转到上方
          const below = window.innerHeight - annotationCard.y > 260;
          const cardStyle: React.CSSProperties = {
            position: 'fixed',
            left: Math.max(8, Math.min(annotationCard.x, window.innerWidth - 296)),
            ...(below ? { top: annotationCard.y + 8 } : { bottom: window.innerHeight - annotationCard.y + 8 }),
            zIndex: 10000,
          };
          return (
            <div className="md-annotation-card" style={cardStyle}>
              {/* 标题栏：左侧意图 / 批注图标，右侧时间 */}
              <div className="md-annotation-card-head">
                {intentDef ? (
                  <span className="md-annotation-card-intent">
                    <Wand2 className="h-2 w-2" />
                    {intentDef.label}
                  </span>
                ) : (
                  <span className="md-annotation-card-intent" title="Annotation">
                    <MessageSquare className="h-2.5 w-2.5" />
                  </span>
                )}
                <span className="md-annotation-card-time">
                  {ann.resolved ? 'Resolved' : new Date(ann.createdAt).toLocaleString()}
                </span>
                <span className="md-annotation-card-actions">
                  <button
                    type="button"
                    className="md-annotation-card-del"
                    title="Delete annotation"
                    aria-label="Delete annotation"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteAnnotation(ann.id);
                      setAnnotationCard(null);
                    }}
                  >
                    <Trash2 className="h-2.5 w-2.5" />
                  </button>
                </span>
              </div>
              <textarea
                className="md-annotation-card-content md-annotation-card-edit"
                value={ann.content}
                onChange={(e) => updateAnnotation(ann.id, e.target.value)}
                placeholder="批注内容…"
              />
            </div>
          );
        })()}

      {/* 批注气泡：选中文字直接弹出批注输入框（添加后同步到右侧批注栏） */}
      {editable && annotationKey && editor && (
        <AnnotationBubble
          editor={editor}
          onAdd={handleAnnotate}
          onAsk={handleAskInNode}
          onDirectRevise={directRevise}
          canAskCurrent={!!(nodeMdId || activeNodeId || activeSessionNodeId)}
        />
      )}

      {/* ProseMirror 专属样式：复用 .html-renderer 的全局样式，此处补充编辑器特有样式 */}
      <style>{`
        /* 编辑区平铺：占满整个区域，无卡片边框/圆角/限宽，背景与面板一致（2026-09-12 改纯白） */
        .doc-editor-content {
          outline: none;
          flex: 1 0 auto;
          min-height: 200px;
          width: 100%;
          padding: 32px 40px;
          font-family: var(--font-sans);
          font-size: 14px;
          line-height: 1.8;
          color: var(--ink);
          user-select: text;
          background: #fff;
        }
        .doc-editor-content:focus { outline: none; }
        /* 去掉聚焦时的品牌紫描边（用户反馈"选中后出现紫色边框"）；保留 :focus 无描边即可 */
        .doc-editor-content:focus-visible {
          outline: none;
        }
        /* 指针统一（消除「I 形光标 ↔ 箭头」闪烁）：可编辑面上显式声明 I 形文本光标，
           其余后代继承之。成因：cursor 为 auto 时浏览器只在"命中文字"处返回 I 形，
           段落间隙 / 行尾空白 / 左内边距列这些非文字位置解析为箭头，鼠标横移时两种形态
           高频来回切换 → 视觉闪烁（与画布、Hippo Browser 的指针统一策略同源）。
           只读渲染（消息文本块）不在此列，保持画布统一箭头。 */
        .doc-editor-content:not(.doc-editor-readonly),
        .doc-editor-content:not(.doc-editor-readonly) > * {
          cursor: text;
        }
        /* 例外：图片保持放大镜（点击走 Lightbox）——需在统一规则之后显式声明覆盖之 */
        .doc-editor-content:not(.doc-editor-readonly) img {
          cursor: zoom-in;
        }
        /* 覆盖 [data-canvas-ui="overlay"] 的透明 ::selection（便签防干扰规则误伤预览面板）：
           编辑器内选中文字保持品牌紫，与 @chip / 输入框紫底形成"正文↔面板"联动 */
        div.doc-editor-content ::selection {
          background: color-mix(in oklab, var(--primary) 18%, transparent) !important;
          color: inherit !important;
        }
        div.doc-editor-content ::-moz-selection {
          background: color-mix(in oklab, var(--primary) 18%, transparent) !important;
          color: inherit !important;
        }
        /* 只读渲染（消息文本块）：无需编辑占位高度，紧贴内容（width 恢复 auto，避免被上文的 width:100% 撑满） */
        .doc-editor-content.doc-editor-readonly { min-height: 0; padding: 0; flex: 0 1 auto; width: auto; }
        /* 分块编辑模式（对齐 HTML 元素级编辑）：顶级块虚线框 + hover 蓝 / 选中橙 */
        /* 注意：不禁用 user-select，拖拽划词（inline 编辑）与点击区块（block 编辑）可共存 */
        .doc-editor-content.md-block-edit-mode { cursor: pointer; }
        .doc-editor-content.md-block-edit-mode > * {
          outline: 1.5px dashed rgba(59, 130, 246, 0.45);
          outline-offset: 3px;
          border-radius: 4px;
          transition: outline-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
        }
        .doc-editor-content.md-block-edit-mode > *:hover {
          outline-color: rgba(59, 130, 246, 0.8);
          background-color: rgba(59, 130, 246, 0.08);
        }
        /* 选中块（对齐 HTML 的 selOv）：橙色实线 + 外发光，持久显示直到切换/退出 */
        .doc-editor-content.md-block-edit-mode > .md-block-selected,
        .doc-editor-content.md-block-edit-mode > .md-block-selected:hover {
          outline: 2px solid rgba(249, 115, 22, 0.9);
          outline-offset: 2px;
          background-color: rgba(249, 115, 22, 0.06);
          box-shadow: 0 0 0 1px rgba(249, 115, 22, 0.3);
        }
        /* 批注高亮：被批注文字保持标记（取消选中不消失）。视觉：琥珀下划线（无背景底色），
           浅/深主题自适应（color-mix）；已解决批注淡化 */
        .doc-editor-content .md-annotation-highlight {
          text-decoration: underline;
          text-decoration-color: color-mix(in oklab, #f59e0b 75%, transparent);
          text-decoration-thickness: 2px;
          text-underline-offset: 3px;
        }
        .doc-editor-content .md-annotation-resolved {
          text-decoration: underline;
          text-decoration-color: color-mix(in oklab, #f59e0b 25%, transparent);
          text-decoration-thickness: 2px;
          text-underline-offset: 3px;
        }
        /* 批注结尾查看图标（widget）：琥珀色对话气泡小图标，hover 加深放大；点击弹查看卡片 */
        .doc-editor-content .md-annotation-widget {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 15px;
          height: 15px;
          margin-left: 3px;
          border-radius: 4px;
          background-color: color-mix(in oklab, #f59e0b 20%, transparent);
          color: #b45309;
          cursor: pointer;
          vertical-align: middle;
          transition: background-color 120ms ease, transform 120ms ease;
          user-select: none;
          -webkit-user-select: none;
        }
        .doc-editor-content .md-annotation-widget:hover {
          background-color: color-mix(in oklab, #f59e0b 32%, transparent);
          transform: scale(1.12);
        }
        .doc-editor-content .md-annotation-widget svg {
          width: 10px;
          height: 10px;
          display: block;
        }
        /* 批注查看卡片：点图标弹出，可自由编辑；fixed 定位由 JS 计算（图标下方 / 视口不足翻转） */
        .md-annotation-card {
          width: 240px;
          min-height: 96px;
          max-height: 230px;
          display: flex;
          flex-direction: column;
          gap: 5px;
          padding: 8px 10px 9px;
          border-radius: 10px;
          border: 1px solid color-mix(in oklab, #b45309 16%, transparent);
          background-color: #fffbeb;
          color: var(--ink);
          box-shadow: 0 6px 18px rgba(70, 45, 20, 0.12), 0 1px 3px rgba(70, 45, 20, 0.06);
          font-family: var(--font-sans);
        }
        .md-annotation-card-head {
          display: flex;
          align-items: center;
          gap: 5px;
          padding-bottom: 0;
          border-bottom: 1px dashed color-mix(in oklab, #b45309 18%, transparent);
          margin-bottom: 5px;
        }
        .md-annotation-card-intent {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          border-radius: 999px;
          padding: 0 6px;
          font-size: 8.5px;
          font-weight: 500;
          line-height: 15px;
          background-color: color-mix(in oklab, #d97706 13%, transparent);
          color: #92400e;
        }
        .md-annotation-card-intent svg { display: block; }
        .md-annotation-card-content {
          font-size: 11.5px;
          line-height: 1.6;
          color: var(--ink);
          overflow-y: auto;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .md-annotation-card-edit {
          flex: 1;
          resize: vertical;
          border: none;
          outline: none;
          background: transparent;
          width: 100%;
          min-height: 60px;
          padding: 0;
          font-family: inherit;
        }
        .md-annotation-card-edit:focus { color: var(--ink); }
        .md-annotation-card-actions {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          flex: none;
          margin-left: auto;
        }
        .md-annotation-card-del {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 16px;
          height: 16px;
          border-radius: 4px;
          border: none;
          background: transparent;
          color: color-mix(in oklab, var(--ink) 40%, transparent);
          cursor: pointer;
          padding: 0;
          transition: color 120ms ease, background 120ms ease;
        }
        .md-annotation-card-del:hover {
          color: var(--danger);
          background: var(--danger-soft);
        }
        .md-annotation-card-time {
          flex: none;
          font-size: 8.5px;
          color: color-mix(in oklab, var(--ink) 42%, transparent);
          white-space: nowrap;
        }
        /* 临时选区高亮：批注气泡编辑期间保持选中文字高亮（比批注黄更淡，避免叠加喧宾夺主）。
           与原生选区互斥，任一时刻只有一重高亮：
           - 编辑器聚焦：原生 ::selection（品牌紫）可见，临时层透明让位；
           - 编辑器失焦（气泡输入中）：Chromium 对失焦选区仍绘制 ::selection，
             令其透明让位，临时层接管保持高亮（ProseMirror 自动维护 ProseMirror-focused 类） */
        .doc-editor-content .md-annotation-sel-temp {
          background-color: color-mix(in oklab, var(--primary) 14%, transparent);
          border-radius: 2px;
        }
        .doc-editor-content.ProseMirror-focused .md-annotation-sel-temp {
          background-color: transparent;
        }
        .doc-editor-content:not(.ProseMirror-focused) ::selection {
          background-color: transparent !important;
          color: inherit !important;
        }
        .doc-editor-content:not(.ProseMirror-focused) ::-moz-selection {
          background-color: transparent !important;
          color: inherit !important;
        }
        /* 修订聚焦高亮：修订视图点击某条修订 → 正文被修改处品牌紫强调（选中态） */
        .doc-editor-content .md-revision-focus {
          background-color: color-mix(in oklab, var(--primary) 22%, transparent);
          box-shadow: 0 0 0 2px color-mix(in oklab, var(--primary) 45%, transparent);
          border-radius: 2px;
        }
        /* 便签反向定位高亮：点击便签子弹图标 → 文档对应出处闪烁强调（金黄，2s 自动清除） */
        .doc-editor-content .md-locate-flash {
          background-color: color-mix(in oklab, #f5b301 30%, transparent);
          box-shadow: 0 0 0 2px color-mix(in oklab, #f5b301 55%, transparent);
          border-radius: 2px;
        }
        /* 查找替换高亮：普通匹配浅琥珀、当前匹配品牌紫描边 */
        .doc-editor-content .md-find-match {
          background-color: color-mix(in oklab, #f59e0b 22%, transparent);
          border-radius: 2px;
        }
        .doc-editor-content .md-find-active {
          background-color: color-mix(in oklab, var(--primary) 28%, transparent);
          box-shadow: 0 0 0 1.5px var(--primary);
          border-radius: 2px;
        }
        .doc-editor-content p { margin: 0 0 14px; }
        .doc-editor-content h1 { margin: 34px 0 14px; font-size: 24px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.3; }
        .doc-editor-content h2 { margin: 26px 0 12px; font-size: 19px; font-weight: 680; letter-spacing: -0.015em; line-height: 1.35; }
        .doc-editor-content h3 { margin: 18px 0 10px; font-size: 16px; font-weight: 650; line-height: 1.4; }
        .doc-editor-content a { color: var(--primary); text-decoration: none; }
        .doc-editor-content a:hover { text-decoration: underline; }
        .doc-editor-content ul, .doc-editor-content ol { margin: 0 0 14px; padding-left: 1.6em; }
        .doc-editor-content li { margin: 4px 0; }
        .doc-editor-content blockquote {
          margin: 14px 0;
          padding: 12px 16px;
          border-left: 3px solid var(--primary);
          border-radius: 0 8px 8px 0;
          background: color-mix(in oklab, var(--primary) 5%, transparent);
          color: var(--ink-muted);
        }
        .doc-editor-content blockquote p { margin: 0; }
        .doc-editor-content blockquote p + p { margin-top: 8px; }
        .doc-editor-content code {
          background: var(--paper-soft);
          border: 1px solid var(--line);
          border-radius: 4px;
          padding: 1px 5px;
          font-size: 12.5px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        }
        .doc-editor-content pre {
          background: var(--paper-soft);
          border: 1px solid var(--line);
          border-radius: 8px;
          padding: 12px 14px;
          overflow-x: auto;
          margin: 12px 0;
        }
        .doc-editor-content pre code {
          background: transparent;
          border: none;
          border-radius: 0;
          padding: 0;
          font-size: 13px;
          line-height: 1.6;
        }
        /* 标题（CollapsibleHeading NodeView：标题文本 flex 布局，data-pos 供目录定位） */
        .doc-editor-content .doc-heading {
          display: flex;
          align-items: center;
          margin: 16px 0 8px;
        }
        .doc-editor-content .doc-heading .doc-heading-content {
          margin: 0;
          flex: 1;
          min-width: 0;
        }
        /* 任务列表 */
        .doc-editor-content ul[data-type="taskList"] {
          list-style: none;
          padding: 0;
        }
        /* 文档嵌入卡片（MdEmbed NodeView）：折叠显示文档名，展开预览部分内容 */
        .doc-editor-content .md-embed-card {
          border: 1px solid color-mix(in oklab, var(--primary) 25%, var(--line-soft));
          border-radius: 8px;
          background: color-mix(in oklab, var(--primary) 5%, var(--paper));
          user-select: none;
          overflow: hidden;
          transition: background 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
        }
        .doc-editor-content .md-embed-card:hover {
          background: color-mix(in oklab, var(--primary) 8%, var(--paper));
          border-color: var(--primary);
          box-shadow: 0 2px 8px color-mix(in oklab, var(--primary) 18%, transparent);
        }
        .doc-editor-content .md-embed-card .md-embed-head {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px 8px 8px;
          cursor: pointer;
        }
        .doc-editor-content .md-embed-card .md-embed-icon-wrap {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          border-radius: 6px;
          background: color-mix(in oklab, var(--primary) 12%, transparent);
          flex: none;
        }
        .doc-editor-content .md-embed-card .md-embed-icon {
          width: 15px;
          height: 15px;
          color: var(--primary-strong);
          flex: none;
        }
        .doc-editor-content .md-embed-card .md-embed-text {
          display: inline-flex;
          flex-direction: column;
          gap: 1px;
          min-width: 0;
          text-align: left;
          flex: 1;
        }
        .doc-editor-content .md-embed-card .md-embed-label {
          font-size: 13px;
          font-weight: 600;
          color: var(--ink);
          line-height: 1.2;
        }
        .doc-editor-content .md-embed-card .md-embed-sub {
          font-size: 10px;
          color: var(--ink-muted);
          line-height: 1;
        }
        .doc-editor-content .md-embed-card .md-embed-tools {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          flex: none;
        }
        .doc-editor-content .md-embed-card .md-embed-open {
          display: inline-flex;
          width: 22px;
          height: 22px;
          align-items: center;
          justify-content: center;
          border-radius: 5px;
          color: var(--ink-muted);
          transition: background 120ms ease, color 120ms ease;
        }
        .doc-editor-content .md-embed-card .md-embed-open:hover {
          color: var(--primary);
          background: color-mix(in oklab, var(--primary) 10%, transparent);
        }
        .doc-editor-content .md-embed-card .md-embed-chevron {
          display: inline-flex;
          align-items: center;
          color: var(--ink-muted);
        }
        .doc-editor-content .md-embed-card .md-embed-open-icon {
          width: 13px;
          height: 13px;
        }
        .doc-editor-content .md-embed-card .md-embed-preview {
          border-top: 1px dashed color-mix(in oklab, var(--primary) 20%, var(--line-soft));
          padding: 6px 10px 8px;
          background: color-mix(in oklab, var(--paper) 60%, transparent);
        }
        .doc-editor-content .md-embed-card .md-embed-preview-text {
          margin: 0;
          font-size: 11.5px;
          line-height: 1.6;
          color: var(--ink);
          white-space: pre-wrap;
          word-break: break-word;
          font-family: var(--font-sans);
          max-height: 180px;
          overflow-y: auto;
        }
        .doc-editor-content .md-embed-card .md-embed-preview-state {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          color: var(--ink-muted);
        }
        .doc-editor-content .md-embed-card .md-embed-spin {
          animation: embed-spin 1s linear infinite;
        }
        @keyframes embed-spin { to { transform: rotate(360deg); } }
        /* 链接卡片（LinkCard NodeView）：独占一行的裸链接，元数据异步抓取，失败降级为普通链接 */
        .doc-editor-content .link-card {
          display: flex;
          align-items: stretch;
          gap: 10px;
          margin: 8px 0;
          padding: 8px 10px;
          border: 1px solid var(--line-soft);
          border-radius: 8px;
          background: color-mix(in oklab, var(--ink) 2%, var(--paper));
          user-select: none;
          overflow: hidden;
          transition: border-color 120ms ease, box-shadow 120ms ease;
        }
        .doc-editor-content .link-card:hover {
          border-color: color-mix(in oklab, var(--primary) 45%, var(--line-soft));
          box-shadow: 0 2px 8px color-mix(in oklab, var(--primary) 12%, transparent);
        }
        .doc-editor-content .link-card.is-loading {
          opacity: 0.75;
        }
        .doc-editor-content .link-card .link-card-main {
          display: flex;
          align-items: center;
          gap: 9px;
          min-width: 0;
          flex: 1;
          cursor: pointer;
        }
        .doc-editor-content .link-card .link-card-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border-radius: 6px;
          background: color-mix(in oklab, var(--ink) 6%, transparent);
          flex: none;
          overflow: hidden;
        }
        .doc-editor-content .link-card .link-card-icon img {
          width: 18px;
          height: 18px;
          object-fit: contain;
        }
        .doc-editor-content .link-card .link-card-globe,
        .doc-editor-content .link-card .link-card-spin {
          width: 15px;
          height: 15px;
          color: var(--ink-muted);
          flex: none;
        }
        .doc-editor-content .link-card .link-card-spin {
          animation: embed-spin 1s linear infinite;
        }
        .doc-editor-content .link-card .link-card-text {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
          flex: 1;
        }
        .doc-editor-content .link-card .link-card-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--ink);
          line-height: 1.35;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .doc-editor-content .link-card .link-card-desc {
          font-size: 11.5px;
          color: var(--ink-muted);
          line-height: 1.5;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .doc-editor-content .link-card .link-card-site {
          font-size: 10px;
          color: var(--ink-muted);
          line-height: 1.2;
          opacity: 0.85;
        }
        .doc-editor-content .link-card .link-card-open {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          flex: none;
          color: var(--ink-muted);
          opacity: 0;
          transition: opacity 120ms ease, color 120ms ease;
        }
        .doc-editor-content .link-card:hover .link-card-open {
          opacity: 1;
        }
        .doc-editor-content .link-card .link-card-open-icon {
          width: 13px;
          height: 13px;
        }
        .doc-editor-content .link-card .link-card-thumb {
          display: inline-flex;
          width: 72px;
          align-self: stretch;
          flex: none;
          border-radius: 6px;
          overflow: hidden;
          background: color-mix(in oklab, var(--ink) 5%, transparent);
        }
        .doc-editor-content .link-card .link-card-thumb img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        /* 抓取失败降级：与普通链接表现一致 */
        .doc-editor-content .link-card-fallback {
          margin: 8px 0;
        }
        .doc-editor-content ul[data-type="taskList"] li {
          display: flex;
          align-items: flex-start;
          gap: 8px;
        }
        .doc-editor-content ul[data-type="taskList"] li > label {
          flex-shrink: 0;
          margin-top: 5px;
          user-select: none;
        }
        .doc-editor-content ul[data-type="taskList"] li > label input[type="checkbox"] {
          appearance: none;
          width: 15px;
          height: 15px;
          border-radius: 4px;
          border: 1.5px solid var(--line);
          background: var(--paper);
          cursor: pointer;
          display: grid;
          place-items: center;
          transition: all 0.15s ease;
        }
        .doc-editor-content ul[data-type="taskList"] li > label input[type="checkbox"]:hover {
          border-color: var(--primary);
        }
        .doc-editor-content ul[data-type="taskList"] li > label input[type="checkbox"]:checked {
          background: var(--primary);
          border-color: var(--primary);
        }
        .doc-editor-content ul[data-type="taskList"] li > label input[type="checkbox"]:checked::after {
          content: '';
          width: 5px;
          height: 8px;
          border: solid #fff;
          border-width: 0 1.5px 1.5px 0;
          transform: rotate(45deg) translate(-0.5px, -0.5px);
        }
        .doc-editor-content ul[data-type="taskList"] li[data-checked="true"] > div {
          text-decoration: line-through;
          color: var(--ink-muted);
        }
        .doc-editor-content ul[data-type="taskList"] li > div {
          flex: 1;
          min-width: 0;
        }
        /* 表格容器 */
        .doc-editor-content .tableWrapper {
          overflow-x: auto;
          margin: 8px 0;
        }
        .doc-editor-content table {
          border-collapse: collapse;
          table-layout: fixed;
          width: 100%;
        }
        .doc-editor-content th,
        .doc-editor-content td {
          border: 1px solid var(--line);
          padding: 6px 10px;
          vertical-align: top;
          min-width: 0;
          /* 长文字（中文长句/URL/无空格英文）强制换行，防止溢出单元格；
             显式 normal 覆盖 .html-renderer 可能施加的 nowrap */
          white-space: normal;
          word-break: break-word;
          overflow-wrap: break-word;
        }
        .doc-editor-content th,
        .doc-editor-content td,
        .doc-editor-content th *,
        .doc-editor-content td * {
          max-width: 100%;
        }
        .doc-editor-content th {
          background: var(--paper-hover);
          font-weight: 600;
        }
        .doc-editor-content .selectedCell:after {
          content: '';
          position: absolute;
          background: color-mix(in oklab, var(--primary) 15%, transparent);
          pointer-events: none;
          z-index: 2;
        }
        .doc-editor-content .column-resize-handle {
          position: absolute;
          right: -2px;
          top: 0;
          bottom: 0;
          width: 4px;
          background: color-mix(in oklab, var(--primary) 40%, transparent);
          pointer-events: none;
        }
        /* 列宽拖拽指示：ProseMirror 在 view.dom 上加 .resize-cursor，靠「继承」传到表内热区
           （.column-resize-handle 为 pointer-events:none，命中测试落在其下的单元格上）。
           上方指针统一规则在顶级块上声明了 cursor，会截断该继承链 → 表内不再显示 col-resize，
           故此处连同后代一并覆盖（权重同、位置更后 → 生效）。 */
        .doc-editor-content.resize-cursor,
        .doc-editor-content.resize-cursor * { cursor: col-resize; }
        /* 占位符 */
        .doc-editor-content p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: var(--ink-muted);
          pointer-events: none;
          height: 0;
          font-style: italic;
        }
        /* 打印：打印时隐藏应用 UI，仅输出文档正文（白底黑字）。
           平时隐藏 #doc-print-root 的规则在 globals.css 全局声明：若只写在这里，
           DocEditor 卸载后规则消失，残留克隆体会撑高 body 使整个窗口可滚动。 */
        @media print {
          body > *:not(#doc-print-root) { display: none !important; }
          /* 页边距由 globals.css 的 @page 提供（A4，左侧 30mm 装订边），
             容器内边距归零，避免与 @page 叠加后边距变窄 */
          #doc-print-root {
            display: block !important;
            padding: 0;
            color: #000 !important;
            font-family: "Times New Roman", Times, 'Songti SC', 'Source Han Serif SC', 'Noto Serif SC', 'SimSun', 'Liberation Serif', serif;
          }
          /* 克隆正文打印时剥离编辑器卡片样式（边框/阴影/圆角/背景），纯白纸输出。
             正文按中文出版惯例排版：五号（10.5pt）、1.5 倍行距、两端对齐、段首缩进 2 字符 */
          #doc-print-root .doc-editor-content {
            max-width: none !important;
            margin: 0 !important;
            padding: 0 !important;
            border: none !important;
            box-shadow: none !important;
            border-radius: 0 !important;
            background: #fff !important;
            color: #000 !important;
            font-size: 10.5pt !important;
            line-height: 1.5 !important;
            text-align: justify;
            orphans: 2;
            widows: 2;
          }
          #doc-print-root .doc-editor-content p {
            margin: 0 !important;
            line-height: 1.5 !important;
            text-indent: 2em;
          }
          /* 缩进只给正文段落：列表 / 引用 / 表格 / 脚注 / 图注内不缩进 */
          #doc-print-root .doc-editor-content li p,
          #doc-print-root .doc-editor-content blockquote p,
          #doc-print-root .doc-editor-content th p,
          #doc-print-root .doc-editor-content td p,
          #doc-print-root .doc-editor-content .footnotes p,
          #doc-print-root .doc-editor-content figcaption {
            text-indent: 0 !important;
          }
          /* 标题：改用无衬线（黑体族）与正文宋体形成字族对比；三号 / 四号 / 小四，纯黑 */
          #doc-print-root .doc-editor-content h1,
          #doc-print-root .doc-editor-content h2,
          #doc-print-root .doc-editor-content h3,
          #doc-print-root .doc-editor-content h4 {
            font-family: 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', ui-sans-serif, -apple-system, 'Helvetica Neue', sans-serif !important;
            color: #000 !important;
            font-weight: 700 !important;
            line-height: 1.35 !important;
            text-indent: 0 !important;
            break-after: avoid-page;
            page-break-after: avoid;
          }
          #doc-print-root .doc-editor-content h1 { font-size: 16pt !important; margin: 0 0 12pt !important; }
          #doc-print-root .doc-editor-content h1:not(:first-child) { margin-top: 18pt !important; }
          #doc-print-root .doc-editor-content h2 { font-size: 14pt !important; margin: 18pt 0 8pt !important; }
          #doc-print-root .doc-editor-content h3 { font-size: 12pt !important; margin: 14pt 0 6pt !important; }
          /* 表格：三线表（顶线 / 表头下线 / 底线），去掉灰底、隔行底色与竖线，小五 9pt */
          #doc-print-root .doc-editor-content .table-wrapper { overflow: visible !important; }
          #doc-print-root .doc-editor-content table {
            width: 100% !important;
            min-width: 0 !important;
            font-size: 9pt !important;
            line-height: 1.3 !important;
            border-collapse: collapse !important;
            border-top: 1.2pt solid #000 !important;
            border-bottom: 1.2pt solid #000 !important;
          }
          #doc-print-root .doc-editor-content th,
          #doc-print-root .doc-editor-content td {
            padding: 4px 6px !important;
            border: none !important;
            background: transparent !important;
            color: #000 !important;
            text-transform: none !important;
            letter-spacing: 0 !important;
            text-align: left !important;
          }
          #doc-print-root .doc-editor-content thead th,
          #doc-print-root .doc-editor-content tr:first-child td,
          #doc-print-root .doc-editor-content tr:first-child th {
            font-weight: 600 !important;
            border-bottom: 0.8pt solid #000 !important;
          }
          /* 分页保护：块级内容不被拆断（标题不落单在页底见上方 break-after） */
          #doc-print-root .doc-editor-content blockquote,
          #doc-print-root .doc-editor-content pre,
          #doc-print-root .doc-editor-content .table-wrapper,
          #doc-print-root .doc-editor-content figure,
          #doc-print-root .doc-editor-content li {
            break-inside: avoid;
            page-break-inside: avoid;
          }
          #doc-print-root .doc-editor-content pre { text-align: left !important; text-indent: 0 !important; }
          #doc-print-root .doc-editor-content img { max-width: 100% !important; height: auto !important; }
          /* 页眉：左品牌（图标 + BobWork）、右打印时间；与正文用一条细线分隔。
             用无衬线字体，和正文的衬线体区分开，读起来像页边信息而不是正文。 */
          #doc-print-root .doc-print-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 20px;
            padding-bottom: 8px;
            border-bottom: 1px solid rgba(0, 0, 0, 0.14);
            font-family: ui-sans-serif, -apple-system, 'Helvetica Neue', 'PingFang SC', sans-serif;
          }
          #doc-print-root .doc-print-brand {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            color: #111;
            font-size: 13px;
            font-weight: 600;
            letter-spacing: 0.01em;
          }
          #doc-print-root .doc-print-brand img {
            width: 16px;
            height: 16px;
            object-fit: contain;
            border-radius: 4px;
            /* 兜底：万一换用不透明白底的品牌图（如 bobwork-logo.png），
               multiply 把白底融进白纸，不至于出现白色方块 */
            mix-blend-mode: multiply;
          }
          #doc-print-root .doc-print-time {
            color: #666;
            font-size: 12px;
            font-variant-numeric: tabular-nums;
          }
        }
      `}</style>

      {/* 通用输入弹窗（替代 Electron 中不可用的 window.prompt） */}
      {promptState && (
        <div
            className="fixed inset-0 z-[300] flex items-center justify-center"
            style={{ backgroundColor: 'color-mix(in oklab, var(--ink) 25%, transparent)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={() => setPromptState(null)}
          >
            <div
              className="w-[360px] overflow-hidden rounded-xl shadow-2xl"
              style={{ backgroundColor: 'var(--paper)', border: '1px solid var(--line)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--line-soft)' }}>
                <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{promptState.title}</span>
                <Button
                  onClick={() => setPromptState(null)}
                  variant="ghost"
                  tone="neutral"
                  size="icon-sm"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="px-4 py-4">
                <input
                  autoFocus
                  value={promptValue}
                  onChange={(e) => setPromptValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const submit = promptState.choices?.[0]?.onSubmit ?? promptState.onSubmit;
                      if (submit) submit(promptValue.trim());
                      setPromptState(null);
                    } else if (e.key === 'Escape') {
                      setPromptState(null);
                    }
                  }}
                  placeholder={promptState.placeholder ?? 'Enter content'}
                  className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                  style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
                />
              </div>
              <div className="flex justify-end gap-2 px-4 pb-4">
                <Button
                  onClick={() => setPromptState(null)}
                  variant="ghost"
                  tone="neutral"
                  size="md"
                >
                  Cancel
                </Button>
                {promptState.choices ? (
                  promptState.choices.map((c) => (
                    <Button
                      key={c.label}
                      onClick={() => {
                        c.onSubmit(promptValue.trim());
                        setPromptState(null);
                      }}
                      variant={c.primary ? 'solid' : 'soft'}
                      tone={c.primary ? 'brand' : 'neutral'}
                      size="md"
                    >
                      {c.label}
                    </Button>
                  ))
                ) : (
                  <Button
                    onClick={() => {
                      promptState.onSubmit?.(promptValue.trim());
                      setPromptState(null);
                    }}
                    variant="solid"
                    tone="brand"
                    size="md"
                  >
                    Confirm
                  </Button>
                )}
              </div>
            </div>
          </div>
      )}

      {/* 统一导出入口：分组菜单（Image / Article / Document-HTML），统一从编辑器 markdown 取源 */}
      <ExportMenu
        open={showExportMenu}
        onClose={() => setShowExportMenu(false)}
        getMarkdown={getExportMarkdown}
        docKey={exportDocKey}
      />

      <ExportDocxDialog
        open={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        onExport={handleExportDocx}
        defaultFileName={nodeMdId ? 'export' : (filePath?.split('/').pop()?.replace(/\.[^.]+$/, '') || 'export')}
      />

      {/* 表格浮动工具栏：光标在表格内时显示（行/列增删、合并拆分、对齐、删除表格） */}
      {tableMenu && editor && (
        <div
          className="fixed z-[150] flex items-center gap-0.5 rounded-lg border px-1 py-0.5"
          style={{
            left: tableMenu.x,
            top: tableMenu.y,
            transform: tableMenu.above ? 'translateY(-100%)' : undefined,
            backgroundColor: 'var(--popover)',
            borderColor: 'var(--line)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
            WebkitAppRegion: 'no-drag',
          } as React.CSSProperties}
        >
          <ToolbarButton title="Insert row above" onClick={() => editor.chain().focus().addRowBefore().run()}>
            <span className="text-11 font-medium leading-none">R↑</span>
          </ToolbarButton>
          <ToolbarButton title="Insert row below" onClick={() => editor.chain().focus().addRowAfter().run()}>
            <span className="text-11 font-medium leading-none">R↓</span>
          </ToolbarButton>
          <ToolbarButton title="Delete row" onClick={() => editor.chain().focus().deleteRow().run()}>
            <span className="text-11 font-medium leading-none">R−</span>
          </ToolbarButton>
          <Divider />
          <ToolbarButton title="Insert column left" onClick={() => editor.chain().focus().addColumnBefore().run()}>
            <span className="text-11 font-medium leading-none">C←</span>
          </ToolbarButton>
          <ToolbarButton title="Insert column right" onClick={() => editor.chain().focus().addColumnAfter().run()}>
            <span className="text-11 font-medium leading-none">C→</span>
          </ToolbarButton>
          <ToolbarButton title="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()}>
            <span className="text-11 font-medium leading-none">C−</span>
          </ToolbarButton>
          <Divider />
          <ToolbarButton title="Merge cells" onClick={() => editor.chain().focus().mergeCells().run()}>
            <span className="text-11 font-medium leading-none">Merge</span>
          </ToolbarButton>
          <ToolbarButton title="Split cell" onClick={() => editor.chain().focus().splitCell().run()}>
            <span className="text-11 font-medium leading-none">Split</span>
          </ToolbarButton>
          <Divider />
          {(['left', 'center', 'right'] as const).map((align) => (
            <ToolbarButton
              key={align}
              active={(editor.getAttributes('tableCell').textAlign as string | null) === align}
              title={`Align ${align}`}
              onClick={() => editor.chain().focus().setCellAttribute('textAlign', align).run()}
            >
              <span className="text-11 font-medium leading-none">
                {align === 'left' ? 'L' : align === 'center' ? 'C' : 'R'}
              </span>
            </ToolbarButton>
          ))}
          <Divider />
          <ToolbarButton title="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}>
            <span className="text-11 font-medium leading-none">Del</span>
          </ToolbarButton>
        </div>
      )}

      {/* 右键命令菜单：顶行图标（撤销/重做 ｜ 打印/分享…）+ 下方竖向「图标 + 文字」条目；作用于选中文字 / 所在段落 */}
      {ctxMenu && (
        <div
          className="md-ctx-menu fixed w-[9rem] overflow-y-auto ai-canvas-scroll rounded-xl border p-1 [&_button_svg]:h-[13px] [&_button_svg]:w-[13px] [&_button_svg]:shrink-0"
          style={{
            // 最宽内容为顶行 4 个图标按钮（约 135px@1×，紧凑成排后不再留白）；右边缘钳制按 9rem+16px 换算
            left: Math.min(ctxMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 0) - 160),
            top: ctxMenu.y,
            maxHeight: 380,
            backgroundColor: 'var(--popover)',
            borderColor: 'var(--line)',
            boxShadow: '0 12px 32px -8px rgba(0,0,0,0.20), 0 2px 6px rgba(0,0,0,0.06)',
            zIndex: 12000,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 顶行：撤销/重做 ｜ 打印/分享，四个图标靠左紧凑成排（与下方图标列对齐），重做与打印之间竖线分隔 */}
          {ctxRows[0].items.length > 0 && (
            <div className="flex items-center gap-0.5">
              {ctxRows[0].items.map((cmd, ci) => (
                <Fragment key={cmd.id}>
                  {ci === 2 && (
                    <span className="mx-1 h-4 w-px shrink-0" style={{ backgroundColor: 'var(--line)' }} />
                  )}
                  <button
                    type="button"
                    title={cmd.hint ? `${ctxLabel(cmd.id)} (${cmd.hint})` : ctxLabel(cmd.id)}
                    onClick={() => runPaletteCommand(cmd)}
                    onMouseDown={(e) => e.preventDefault()}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-hover)] hover:text-[var(--ink)]"
                  >
                    {commandGlyph(cmd.id)}
                  </button>
                </Fragment>
              ))}
            </div>
          )}

          {/* 其余命令：竖向排列，图标 + 名称（等行高，图标列与顶行按钮基本对齐；文字已可见，不再挂 tooltip） */}
          {ctxRows[1].items.length > 0 && (
            <>
              <div className="mx-1 my-1 h-px" style={{ backgroundColor: 'var(--line-soft)' }} />
              {ctxRows[1].items.map((cmd) => (
                <button
                  key={cmd.id}
                  type="button"
                  onClick={() => runPaletteCommand(cmd)}
                  onMouseDown={(e) => e.preventDefault()}
                  className="group flex h-7 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink)' }}
                >
                  <span className="flex w-4 shrink-0 items-center justify-center text-[var(--ink-muted)] transition-colors group-hover:text-[var(--ink)]">
                    {commandGlyph(cmd.id)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-12">{cmd.label}</span>
                  {cmd.hint && SHORTCUT_HINT_RE.test(cmd.hint) && (
                    <span className="shrink-0 text-11" style={{ color: 'var(--ink-faint)' }}>{cmd.hint}</span>
                  )}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {/* 块级拖拽把手（仅可编辑态）：hover 块首显示，压住可拖拽排序顶级块（自研定位，固定于纸张左侧内边距列，不压首字） */}
      <BlockDragHandle editor={editable && editor ? editor : null} />
      <style>{`
        .doc-drag-handle {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 24px;
          border-radius: 6px;
          color: var(--ink-muted);
          cursor: grab;
          z-index: 30;
          position: absolute;
          pointer-events: auto;
          opacity: 0;
          transition: opacity 0.12s ease;
        }
        .doc-drag-handle[data-visible='true'] { opacity: 1; }
        .doc-drag-handle:hover {
          color: var(--primary);
          background: color-mix(in oklab, var(--primary) 8%, transparent);
        }
        .doc-drag-handle[data-dragging='true'] {
          color: var(--primary);
          background: color-mix(in oklab, var(--primary) 8%, transparent);
          cursor: grabbing;
        }
        .doc-drag-handle svg {
          width: 15px;
          height: 15px;
        }
        .doc-drag-target {
          outline: 1.5px solid var(--primary);
          outline-offset: -1px;
          border-radius: 6px;
        }
        .bob-columns-wrap {
          margin: 4px 0;
        }
        .bob-columns-bar {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 0 6px;
          font-size: 11px;
          color: var(--ink-muted);
          user-select: none;
        }
        .bob-columns-bar button {
          width: 22px;
          height: 20px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--ink-muted);
          cursor: pointer;
          line-height: 1;
        }
        .bob-columns-bar button:hover {
          color: var(--primary);
          background: color-mix(in oklab, var(--primary) 10%, transparent);
        }
        .bob-columns-body {
          display: block;
        }
        /* Tiptap v3 会在 [data-node-view-content] 内部再注入一层 contentDOM（div[data-node-view-content-react]），
           各栏其实是这一层的子节点。flex 布局必须落在注入层上：若加在 .bob-columns-body 上，
           注入层会成为唯一 flex 项、宽度按内容塌缩为 0，整块分栏退化成只剩工具条。
           用 :not([data-bob-column]) 精确选中注入层（同时兼容无注入层的实现）。 */
        .bob-columns-body > div:not([data-bob-column]) {
          display: flex;
          align-items: stretch;
          gap: 12px;
        }
        .bob-columns-body [data-bob-column] {
          flex: 1 1 0;
          min-width: 0;
          border: 1px solid var(--line);
          border-radius: 8px;
          padding: 6px 10px;
          background: color-mix(in oklab, var(--paper-soft) 45%, transparent);
        }
        .bob-columns-body [data-bob-column] > p:first-child {
          margin-top: 0;
        }
      `}</style>
    </div>
  );
}

// ============================================================
// 工具栏按钮 + 分隔线
// ============================================================
/** ⌘K 命令面板命令 */
interface PaletteCommand {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** 命令按钮图标：命令 id → lucide 图标（右键菜单与工具栏同款）
 *  注意 PaletteCommand.id 形如 `${group}:${shortId}`（如 "Format:bold"），
 *  这里取冒号后的短 id 做匹配，避免全部走 default 返回 null 导致按钮空白。 */
function commandGlyph(id: string): React.ReactNode {
  const key = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  switch (key) {
    case 'bold': return <Bold className="h-4 w-4" />;
    case 'italic': return <Italic className="h-4 w-4" />;
    case 'strike': return <Strikethrough className="h-4 w-4" />;
    case 'code': return <Code className="h-4 w-4" />;
    case 'h1': return <Heading1 className="h-4 w-4" />;
    case 'h2': return <Heading2 className="h-4 w-4" />;
    case 'h3': return <Heading3 className="h-4 w-4" />;
    case 'paragraph': return <AlignLeft className="h-4 w-4" />;
    case 'bullet': return <List className="h-4 w-4" />;
    case 'ordered': return <ListOrdered className="h-4 w-4" />;
    case 'task': return <CheckSquare className="h-4 w-4" />;
    case 'quote': return <Quote className="h-4 w-4" />;
    case 'codeblock': return <Code2 className="h-4 w-4" />;
    case 'hr': return <Minus className="h-4 w-4" />;
    case 'link': return <LinkIcon className="h-4 w-4" />;
    case 'image': return <ImageIcon className="h-4 w-4" />;
    case 'table': return <TableIcon className="h-4 w-4" />;
    case 'columns2': return <Columns2 className="h-4 w-4" />;
    case 'columns3': return <Columns3 className="h-4 w-4" />;
    case 'undo': return <RotateCcw className="h-4 w-4" />;
    case 'redo': return <RotateCw className="h-4 w-4" />;
    case 'find': return <Search className="h-4 w-4" />;
    case 'format': return <Wand2 className="h-4 w-4" />;
    case 'annotations': return <MessageSquare className="h-4 w-4" />;
    case 'toc': return <ListTree className="h-4 w-4" />;
    case 'export': return <Package className="h-4 w-4" />;
    case 'docx': return <FileText className="h-4 w-4" />;
    case 'print': return <Printer className="h-4 w-4" />;
    case 'share': return <Share2 className="h-4 w-4" />;
    default: return null;
  }
}

/** 右键菜单顶行图标按钮的 tooltip 文案（竖向条目已有可见文字，不再需要映射） */
const CTX_LABELS: Record<string, string> = {
  undo: 'Undo', redo: 'Redo', print: 'Print', share: 'Share',
};
/** 竖向条目右侧的快捷键提示：仅显示含修饰键的 hint。
 *  Export / Word 那类描述性 hint 过长，会撑破 9rem 菜单宽度，故不显示。 */
const SHORTCUT_HINT_RE = /[⌘⇧]/;
function ctxLabel(id: string): string {
  const key = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  return CTX_LABELS[key] ?? id;
}

interface ToolbarButtonProps {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}

function ToolbarButton({ active, onClick, title, children, disabled }: ToolbarButtonProps & { disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="flex items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-30"
      style={{
        width: '28px',
        height: '28px',
        color: active ? 'var(--primary-foreground)' : 'var(--ink-muted)',
        backgroundColor: active ? 'var(--primary)' : 'transparent',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.color = active ? 'var(--primary-foreground)' : 'var(--primary)';
        e.currentTarget.style.backgroundColor = active
          ? 'color-mix(in oklab, var(--primary) 85%, transparent)'
          : 'color-mix(in oklab, var(--primary) 10%, transparent)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = active ? 'var(--primary-foreground)' : 'var(--ink-muted)';
        e.currentTarget.style.backgroundColor = active ? 'var(--primary)' : 'transparent';
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {children}
    </button>
  );
}

function Divider() {
  return (
    <span
      style={{
        width: '1px',
        height: '18px',
        backgroundColor: 'var(--line)',
        margin: '0 4px',
      }}
    />
  );
}

/** 块级拖拽把手（自研，替代 @tiptap/extension-drag-handle-react）。
 *  解决了第三方两处问题：
 *  1) 不再「偶尔不显示」——显隐由独立 mousemove/mouseleave 驱动，不依赖第三方「节点变化才显示」的门控；
 *  2) 不压首字/符号——把手 x 固定在纸张左侧内边距列（content.left + 14，22px 落在 40px 内边距内），
 *     y 对齐所 hover 顶级块的顶部。
 *  拖拽：HTML5 DnD；drop 时按光标在目标块的上/下半判定插到其前/后，一个事务内 delete+insert 完成整块移动。 */
function BlockDragHandle({ editor }: { editor: Editor | null }) {
  const handleRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const hoverRef = useRef<{ start: number; end: number; el: HTMLElement } | null>(null);
  // 拖拽中：源块信息（锁定于 mousedown）+ 目标落点（mousemove 实时更新）
  const dragRef = useRef<{ start: number; end: number; el: HTMLElement } | null>(null);
  const dropTargetRef = useRef<{ start: number; end: number; before: boolean } | null>(null);
  const targetElRef = useRef<HTMLElement | null>(null);
  // 拖拽 ghost（跟随鼠标的块预览）与插入指示线：DOM 直操，避免重渲染
  const ghostRef = useRef<HTMLElement | null>(null);
  const indicatorRef = useRef<HTMLElement | null>(null);

  // editor view 同步到 ref（不在 render 内写 ref，改在提交后同步）
  useEffect(() => {
    viewRef.current = editor?.view ?? null;
  }, [editor]);

  /** 取光标所在顶级块（doc depth=1）：返回 {start,end,el}
   *  优先 posAtCoords（精确到文本行）；但编辑器在段落之间的垂直间隙（<p> 的 margin 空白区）上
   *  posAtCoords 会返回 null，导致把手一移过段间距就消失（"时隐时现"）。
   *  为此退化为按"含 margin 的块盒"扫描顶级子块定位，保证把手始终跟随光标所在块。 */
  const blockAt = useCallback((clientX: number, clientY: number) => {
    const view = viewRef.current;
    if (!view) return null;
    const resolveTopBlock = (pos: number): { start: number; end: number; el: HTMLElement } | null => {
      const dp = view.state.doc.resolve(pos);
      if (dp.depth < 1) return null;
      const start = dp.before(1);
      const end = start + dp.node(1).nodeSize;
      const el = view.nodeDOM(start) as HTMLElement | null;
      if (!el || !view.dom.contains(el)) return null;
      return { start, end, el };
    };
    // 1) 精确命中文本行
    const coord = view.posAtCoords({ left: clientX, top: clientY });
    if (coord) {
      const b = resolveTopBlock(coord.pos);
      if (b) return b;
    }
    // 2) 段落间隙兜底：遍历顶级子块，按"含上下 margin 的盒"命中纵坐标
    for (const child of Array.from(view.dom.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const r = child.getBoundingClientRect();
      const cs = getComputedStyle(child);
      const mTop = parseFloat(cs.marginTop) || 0;
      const mBot = parseFloat(cs.marginBottom) || 0;
      if (clientY >= r.top - mTop && clientY <= r.bottom + mBot) {
        const b = resolveTopBlock(view.posAtDOM(child, 0));
        if (b) return b;
      }
    }
    return null;
  }, []);

  /** 定位：把手进入左侧内边距列并对齐块顶部。
   *  x 以"块文本左缘"为锚：把手右缘恒保持在文本左缘前 8px，不随纸张内边距变化而压住段落首字符。
   *  y 对齐块顶。可见性由 data-visible 控制。 */
  const position = useCallback((b: { start: number; end: number; el: HTMLElement } | null) => {
    const h = handleRef.current;
    const view = viewRef.current;
    if (!h || !view) return;
    if (!b) {
      h.dataset.visible = 'false';
      return;
    }
    const wrap = h.offsetParent as HTMLElement | null;
    const wrapRect = wrap?.getBoundingClientRect();
    const wy = wrapRect?.top ?? 0;
    const blockLeft = b.el.getBoundingClientRect().left - (wrapRect?.left ?? 0); // 块文本左缘（相对 wrap）
    const handleW = h.getBoundingClientRect().width || 22;
    // 右缘距文本左缘 8px；hover 定位时该值通常为正（纸张内边距列），偶发被块内边距压缩时让位给"不错位"
    h.style.left = `${Math.max(0, blockLeft - handleW - 8)}px`;
    h.style.top = `${b.el.getBoundingClientRect().top - wy}px`;
    h.dataset.visible = 'true';
  }, []);

  const clearTarget = useCallback(() => {
    if (targetElRef.current) {
      targetElRef.current.classList.remove('doc-drag-target');
      targetElRef.current = null;
    }
  }, []);

  const hideHandle = useCallback(() => {
    // 清理 ghost / 指示线 / 源块隐藏
    if (ghostRef.current) { ghostRef.current.remove(); ghostRef.current = null; }
    if (indicatorRef.current) { indicatorRef.current.remove(); indicatorRef.current = null; }
    if (dragRef.current?.el) dragRef.current.el.style.opacity = '';
    dragRef.current = null;
    dropTargetRef.current = null;
    clearTarget();
    hoverRef.current = null;
    position(null);
    if (handleRef.current) handleRef.current.dataset.dragging = 'false';
  }, [clearTarget, position]);

  // hover 显隐 + 定位 + 跟随滚动/缩放/文档变更时重新定位
  useEffect(() => {
    const h = handleRef.current;
    const view = viewRef.current;
    if (!h || !view) return;
    const onMove = (e: MouseEvent) => {
      if (dragRef.current) return; // 拖拽中不更新 hover（把手显隐交给拖拽逻辑）
      // 用「编辑器内容区（含内边距列）」的几何范围判断，而非 view.dom 的 mouseleave：
      // 把手绝对定位在 view.dom 的 DOM 树外，鼠标移到把手上会触发 view.dom mouseleave 导致 hoverRef 被误清空。
      const rect = view.dom.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (!inside) {
        hoverRef.current = null;
        position(null);
        return;
      }
      const b = blockAt(e.clientX, e.clientY);
      hoverRef.current = b;
      position(b);
    };
    const onRepos = () => {
      if (!dragRef.current) position(hoverRef.current);
    };
    document.addEventListener('mousemove', onMove);
    window.addEventListener('scroll', onRepos, true);
    window.addEventListener('resize', onRepos);
    editor?.on('transaction', onRepos);
    return () => {
      document.removeEventListener('mousemove', onMove);
      window.removeEventListener('scroll', onRepos, true);
      window.removeEventListener('resize', onRepos);
      editor?.off('transaction', onRepos);
    };
  }, [editor, blockAt, position, clearTarget, hideHandle]);

  // 鼠标事件驱动的块拖拽：mousedown 锁定源块 → mousemove 移动 ghost + 高亮目标/插入线 → mouseup 落点插入。
  // 不依赖 HTML5 原生 DnD（draggable/dragstart 在该把手场景下易因 hoverRef 竞态失效，且不丝滑）。
  const onMouseDown = (e: React.MouseEvent) => {
    const view = viewRef.current;
    const b = hoverRef.current;
    if (!view || !b) return;
    e.preventDefault(); // 阻止文本选择 / 编辑器聚焦
    e.stopPropagation();

    // 锁定源块
    const src = { start: b.start, end: b.end, el: b.el };
    dragRef.current = src;
    dropTargetRef.current = null;
    clearTarget();
    if (handleRef.current) handleRef.current.dataset.dragging = 'true';

    // 源块完全隐藏（提起后原位置留白，ghost 跟随鼠标，视觉更清晰）
    b.el.style.opacity = '0';
    const srcRect = b.el.getBoundingClientRect();

    // 创建 ghost：克隆源块，fixed 跟随鼠标
    const ghost = b.el.cloneNode(true) as HTMLElement;
    ghost.style.position = 'fixed';
    ghost.style.left = `${srcRect.left}px`;
    ghost.style.top = `${srcRect.top}px`;
    ghost.style.width = `${srcRect.width}px`;
    ghost.style.margin = '0';
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '10000';
    ghost.style.opacity = '0.92';
    ghost.style.boxShadow = '0 12px 32px rgba(0,0,0,0.22)';
    ghost.style.borderRadius = '8px';
    ghost.style.transform = 'scale(0.99)';
    document.body.appendChild(ghost);
    ghostRef.current = ghost;

    // 创建插入指示线（2px 主色横线，显示在目标块上/下边界）
    const indicator = document.createElement('div');
    indicator.style.position = 'fixed';
    indicator.style.height = '2px';
    indicator.style.backgroundColor = 'var(--primary)';
    indicator.style.zIndex = '10000';
    indicator.style.pointerEvents = 'none';
    indicator.style.display = 'none';
    indicator.style.borderRadius = '1px';
    document.body.appendChild(indicator);
    indicatorRef.current = indicator;

    const onMove = (ev: MouseEvent) => {
      // ghost 跟随鼠标（右上偏移，避免遮挡视线）
      if (ghostRef.current) {
        ghostRef.current.style.left = `${ev.clientX + 12}px`;
        ghostRef.current.style.top = `${ev.clientY + 12}px`;
      }
      // 目标块 + 插入线
      const tb = blockAt(ev.clientX, ev.clientY);
      clearTarget();
      if (tb && tb.el !== src.el) {
        tb.el.classList.add('doc-drag-target');
        targetElRef.current = tb.el;
        const rect = tb.el.getBoundingClientRect();
        const before = ev.clientY < rect.top + rect.height / 2;
        dropTargetRef.current = { start: tb.start, end: tb.end, before };
        if (indicatorRef.current) {
          indicatorRef.current.style.display = 'block';
          indicatorRef.current.style.left = `${rect.left}px`;
          indicatorRef.current.style.width = `${rect.width}px`;
          indicatorRef.current.style.top = `${before ? rect.top - 1 : rect.bottom - 1}px`;
        }
      } else {
        dropTargetRef.current = null;
        if (indicatorRef.current) indicatorRef.current.style.display = 'none';
      }
    };

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);

      const view2 = viewRef.current;
      let dt = dropTargetRef.current;
      const srcStart = src.start;
      const srcEnd = src.end;
      // 恢复源块并清理 ghost/指示线/高亮
      src.el.style.opacity = '';
      clearTarget();
      if (ghostRef.current) { ghostRef.current.remove(); ghostRef.current = null; }
      if (indicatorRef.current) { indicatorRef.current.remove(); indicatorRef.current = null; }
      dropTargetRef.current = null;
      dragRef.current = null;
      if (handleRef.current) handleRef.current.dataset.dragging = 'false';

      // 落点兜底：若最后一次 mousemove 未留下有效落点（鼠标停在块间隙），用 mouseup 坐标重算
      if (!dt && view2) {
        const tb = blockAt(ev.clientX, ev.clientY);
        if (tb && tb.el !== src.el) {
          const rect = tb.el.getBoundingClientRect();
          dt = { start: tb.start, end: tb.end, before: ev.clientY < rect.top + rect.height / 2 };
        }
      }

      // 无可落点或落点即原位 → 结束
      if (!view2 || !dt || dt.start === srcStart) { hideHandle(); return; }
      const span = srcEnd - srcStart;

      let insertAt = dt.before ? dt.start : dt.end;
      if (srcStart < insertAt) insertAt -= span; // 源块在目标之前时，删除会使其后的位置前移
      const tr = view2.state.tr;
      const node = view2.state.doc.nodeAt(srcStart);
      if (!node) { hideHandle(); return; }
      tr.delete(srcStart, srcEnd);
      const at = Math.max(0, Math.min(insertAt, tr.doc.content.size));
      tr.insert(at, node);
      view2.dispatch(tr);
      hideHandle();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  if (!editor || !editor.isEditable) return null;
  return (
    <div
      ref={handleRef}
      className="doc-drag-handle"
      data-visible="false"
      data-dragging="false"
      onMouseDown={onMouseDown}
      title="Drag to reorder"
    >
      <GripVertical />
    </div>
  );
}

