'use client';

// 核心富文本编辑器组件：基于 Tiptap，支持 Markdown 双向解析、工具栏、自动保存、AI 内联气泡（复制/发送到节点）

// highlight.js 语言子模块缺少独立类型声明，补充 ambient 声明以通过 strict 模式
declare module 'highlight.js/lib/languages/*';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { Extension, type JSONContent } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import TurndownService from 'turndown';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
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
  Pilcrow,
  GripVertical,
  Columns2,
  Columns3,
  Link as LinkIcon,
  Image as ImageIcon,
  Undo,
  Redo,
  Check,
  Loader2,
  X,
  ListTree,
  FileDown,
  ChevronDown,
  Heading,
  CheckSquare,
  MessageSquare,
  Printer,
  FilePlus,
  Share2,
  FileText,
  Search,
  Hash,
  Wand2,
  Table as TableIcon,
  AlertTriangle,
} from 'lucide-react';
import { AnnotationBubble, mdSelTempKey } from './extensions/AnnotationBubble';
import { Button } from '@/components/ui/button';
import { MermaidCodeBlock } from './extensions/MermaidCodeBlock';
import { CollapsibleHeading } from './extensions/CollapsibleHeading';
import { MdEmbed } from './extensions/MdEmbed';
import { bus, BusEvents } from '@/lib/bus';
import { showImageAiEditToast } from '@/lib/image-ai-edit-runtime';
import { extractQuestionnaires, QuestionnairePanel, type QuestionnaireBlock } from './QuestionnairePanel';
import { ExportDocxDialog } from './ExportDocxDialog';
import { convertMarkdownToDocx, type DocxExportConfig } from '@/lib/md-to-docx';
import { MdAnnotationPanel, ANNOTATION_INTENTS, type MdAnnotation, type Revision, type RevisionRound, type RevisionOp } from './MdAnnotationPanel';
// track-changes：AI 修订注入为原生 ProseMirror mark（替代文本标记模拟），接受/拒绝/读取原生支持
import { TrackChangesExtension } from 'tiptap-track-changes';
// 块级拖拽把手：hover 块首出现，按住可拖拽排序段落/列表项/图片/表格/嵌入卡片等块（TipTap v3 官方开源扩展）
import DragHandle from '@tiptap/extension-drag-handle-react';
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

/** 统一批注定位（W3C TextQuoteSelector 思路，Hypothesis 同款）：
 *  ① from/to 精确位置（有效且该处文本与 quote 匹配）→ 直接用；
 *  ② 失效/无位置 → quote + prefix/suffix 上下文锚定（只匹配一处，杜绝重复文本跳错）；
 *  ③ 返回 null 表示无法定位（文档已被大幅改写）。
 *  高亮 / 卡片跳转 / AI 重写三处共用，消除此前"高亮全匹配、跳转第一处"的行为分裂。 */
function findQuoteWithContext(fullText: string, quote: string, prefix?: string, suffix?: string): { from: number; to: number } | null {
  if (!quote) return null;
  const ctxLen = 32;
  let idx = fullText.indexOf(quote);
  while (idx >= 0) {
    const before = fullText.slice(Math.max(0, idx - ctxLen), idx);
    const after = fullText.slice(idx + quote.length, idx + quote.length + ctxLen);
    const ctxOk =
      (!prefix || before.includes(prefix) || prefix.includes(before)) &&
      (!suffix || after.includes(suffix) || suffix.includes(after));
    if (ctxOk) return { from: idx + 1, to: idx + 1 + quote.length };
    idx = fullText.indexOf(quote, idx + 1);
  }
  // 无上下文约束（旧批注无 prefix/suffix）→ 返回首个匹配作为兜底（保持原有行为）
  if (!prefix && !suffix) {
    const idx2 = fullText.indexOf(quote);
    if (idx2 >= 0) return { from: idx2 + 1, to: idx2 + 1 + quote.length };
  }
  return null;
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
  const fullText = doc.textBetween(0, docSize, '\n');
  return findQuoteWithContext(fullText, a.quote, a.prefix, a.suffix);
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

/** 调 /api/ai-edit/markdown（SSE），返回 done 事件的完整文本；失败返回 null */
async function fetchAiEditSse(body: Record<string, unknown>): Promise<string | null> {
  try {
    const resp = await fetch('/api/ai-edit/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let resultText = '';
    const reader = resp.body?.getReader();
    if (!reader) return null;
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
        if (event === 'done') {
          try {
            const parsed = JSON.parse(data.replace(/\\n/g, '\n')) as { success?: boolean; text?: string };
            if (parsed.success && parsed.text) resultText = parsed.text;
          } catch { /* ignore */ }
        }
      }
    }
    return resultText || null;
  } catch {
    return null;
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

  // 本地图片上传状态
  const [uploadingImage, setUploadingImage] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // 目录栏：显示开关 + 内容版本号（文档变化时重算目录与折叠）
  const [showToc, setShowToc] = useState(false);
  const [tocTick, setTocTick] = useState(0);
  const [activeHeadingPos, setActiveHeadingPos] = useState<number | null>(null);
  // 顶部工具栏：默认折叠（保留「Formatting」常驻条，展开后可用全部格式按钮；格式操作亦可经 ⌘K / `/` 完成）
  const [toolbarCollapsed, setToolbarCollapsed] = useState(true);

  // `/` 斜杠命令：输入 / 在光标处弹出插入菜单（复用 ⌘K 面板命令，零新依赖）
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  /** 菜单锚点：打开瞬间用 coordsAtPos 记录的视口坐标（fixed 定位用） */
  const [slashAnchor, setSlashAnchor] = useState<{ x: number; y: number } | null>(null);
  const slashRef = useRef<HTMLDivElement>(null);
  /** ref 镜像：editorProps 回调（创建时闭包）读取最新菜单开关状态 */
  const slashOpenRef = useRef(false);
  slashOpenRef.current = slashOpen;
  /** 斜杠行当前光标字符位置快照：菜单打开期间随输入/删除实时更新。
   *  点击弹窗命令会令编辑器短暂失焦，PM selection 可能漂移（误删/误改其他行），
   *  执行命令时一律以该快照定位，不信任失焦后的 selection。 */
  const slashCaretRef = useRef<number | null>(null);
  /** 斜杠菜单键盘导航：以 ref 函数注入 editorProps.handleKeyDown，每次渲染刷新最新命令/索引 */
  const slashNavRef = useRef<(e: KeyboardEvent) => boolean>(() => false);
  /** 表格浮动工具栏：光标在表格内时显示（x/y = 锚点坐标，above = 是否浮在表格上方） */
  const [tableMenu, setTableMenu] = useState<{ x: number; y: number; above: boolean } | null>(null);

  // 查找替换（⌘F）：编辑器内查找/替换，实时高亮匹配，复用 mdLocate 装饰机制
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [findMatches, setFindMatches] = useState<{ from: number; to: number }[]>([]);
  /** 当前定位的匹配索引（-1 = 无匹配/未定位） */
  const [findIndex, setFindIndex] = useState(-1);
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

  // ⌘K 命令面板
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandIndex, setCommandIndex] = useState(0);
  /** 顶部搜索栏左侧「历史」按钮（撤销/重做）的悬停高亮 */
  const [historySel, setHistorySel] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen((v) => {
          if (!v) { setCommandQuery(''); setCommandIndex(0); }
          return !v;
        });
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // 工具栏下拉菜单开关
  const [headingDropdownOpen, setHeadingDropdownOpen] = useState(false);
  const [listDropdownOpen, setListDropdownOpen] = useState(false);
  const headingDropdownRef = useRef<HTMLDivElement>(null);
  const listDropdownRef = useRef<HTMLDivElement>(null);

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

  // ===== 批注 + 修订 =====
  const [annotations, setAnnotations] = useState<MdAnnotation[]>([]);
  /** 批注结尾图标点击 → 弹出查看卡片（纯查看）：记录批注 id + 触发图标坐标（卡片定位用） */
  const [annotationCard, setAnnotationCard] = useState<{ id: string; x: number; y: number } | null>(null);
  /** widget 点击回调（经 ref 调用：高亮 effect 每次重建 widget 时总能拿到最新闭包） */
  const onAnnotationWidgetRef = useRef<(id: string, x: number, y: number) => void>(() => {});
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(false);
  /** 右侧栏视图：annotations=批注列表；revisions=修订视图 */
  const [annotationView, setAnnotationView] = useState<'annotations' | 'revisions'>('annotations');
  const [revising, setRevising] = useState(false);
  // 修订历史：每次「按批注修订」生成一轮，按轮次保留；activeRoundId 指向当前文档内容对应的轮
  const [revisionRounds, setRevisionRounds] = useState<RevisionRound[]>([]);
  const [activeRoundId, setActiveRoundId] = useState<string | null>(null);
  /** 当前聚焦的修订（修订视图点击定位）：切换轮次/接受拒绝后跟随重新定位高亮 */
  const [focusedRevision, setFocusedRevision] = useState<{ roundId: string; oldText: string; newText: string } | null>(null);
  /** 聚焦定位需要滚动一次的标记（跨轮切换时，文档重建完成后再滚动） */
  const pendingRevisionScrollRef = useRef(false);
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

  /** 取光标所在行文本（不含换行）：斜杠命令检测 / 删除前缀用。
   *  hardBreak（Shift+Enter 软换行）是行内节点，textBetween 的 blockSeparator 不会为它插入 \n，
   *  必须用 leafText 把 hardBreak 也渲染成换行，否则 lastIndexOf('\n') 会误切到上一段落，
   *  导致跨行斜杠误删上一行内容。 */
  const currentLineText = useCallback((view: EditorView | null | undefined, pos: number): string => {
    if (!view) return '';
    const text = view.state.doc.textBetween(0, pos, '\n', (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : ''));
    return text.slice(text.lastIndexOf('\n') + 1);
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
      Image,
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
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      MermaidCodeBlock.configure({ lowlight }),
      // 文档嵌入：`![[路径]]` → 嵌入卡片（markdown 双向序列化见扩展内）
      MdEmbed,
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
      handleKeyDown: (view, event) => {
        // `/` 斜杠命令菜单键盘导航（优先于编辑器快捷键，避免方向键/回车被编辑器消费）
        if (slashOpenRef.current && slashNavRef.current(event)) return true;
        // ⌘⇧F / Ctrl+Shift+F：打开编辑器内查找替换（⌘F 已专属全局搜索，见 CanvasFlow）
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          // 有选区时用选区文字预填
          const sel = view.state.selection;
          if (!sel.empty) {
            const text = view.state.doc.textBetween(sel.from, sel.to, '\n').trim();
            if (text) setFindQuery(text);
          }
          setFindOpen(true);
          requestAnimationFrame(() => {
            findInputRef.current?.focus();
            findInputRef.current?.select();
          });
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
      // `/` 斜杠命令触发与查询同步：行首/前导空白输入 / 时打开菜单；菜单打开时继续输入则更新查询词
      handleTextInput: (view, from, _to, text) => {
        if (!view.editable || view.composing || text.length !== 1) return false;
        const line = currentLineText(view, from);
        if (slashOpenRef.current) {
          // 菜单已开：输入空白/换行，或 '/' 前缀消失 → 关闭；否则同步查询词
          if (/\s/.test(text) || !line.startsWith('/')) {
            setSlashOpen(false);
            setSlashQuery('');
          } else {
            setSlashQuery(line.slice(1));
            setSlashIndex(0);
          }
          slashCaretRef.current = view.state.selection.from;
          return false;
        }
        // 输入 '/'：仅当行首或前导空白时打开（'1/'、'word/' 不误触发）
        if (text === '/' && from > 0) {
          const before = line.slice(0, -1);
          if (/^\s*$/.test(before)) {
            const coords = view.coordsAtPos(from);
            setSlashAnchor({ x: coords.left, y: coords.bottom });
            setSlashOpen(true);
            setSlashQuery('');
            setSlashIndex(0);
            slashCaretRef.current = view.state.selection.from;
          }
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

  /** 记录一次局部替换为修订轮次（逐条 AI 修改也进修订面板，可审阅/回退） */
  const addPatchRound = useCallback((before: string, after: string, annotationId?: string) => {
    if (!before || before === after) return;
    const { oldText, newText, preLen } = diffPatch(before, after);
    if (!oldText && !newText) return;
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
    };
    setRevisionRounds((prev) => [...prev, round]);
    setActiveRoundId(round.id);
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

  /** 删除批注 */
  const deleteAnnotation = useCallback(async (id: string) => {
    await persistAnnotations(annotations.filter((a) => a.id !== id));
  }, [annotations, persistAnnotations]);

  /** 二次编辑批注内容（批注卡片编辑保存） */
  const updateAnnotation = useCallback(async (id: string, content: string) => {
    await persistAnnotations(annotations.map((a) => (a.id === id ? { ...a, content } : a)));
  }, [annotations, persistAnnotations]);

  /** 批注变化 → 重新生成正文高亮（被批注文字保持黄色高亮，取消选中不消失；
   *  已解决批注淡化）。优先按批注记录的精确位置锁定（不乱飘），无位置/失效时回退文本匹配。 */
  useEffect(() => {
    if (!editor) return;
    const doc = editor.state.doc;
    const decorations: Decoration[] = [];
    for (const a of annotations) {
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
  }, [editor, annotations]);

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
    const close = () => setAnnotationCard(null);
    // capture 阶段捕获所有滚动（scroll 事件不冒泡，capture 才能拦到内部滚动容器）
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // 点卡片内 / 点其他图标：不关闭（点其他图标由 click 转发更新坐标）
      if (t?.closest?.('.md-annotation-card, .md-annotation-widget')) return;
      setAnnotationCard(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAnnotationCard(null);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', close, true);
    };
  }, [annotationCard]);

  // ===== 单条批注 / 全部批注 逐条 AI 修改（quote 按批注意见即时改写并替换，进修订面板可回退） =====
  const [rewritingAll, setRewritingAll] = useState(false);
  // 当前正在重写的批注 id（对应卡片显示进度百分比）；null = 无进行中
  const [rewritingId, setRewritingId] = useState<string | null>(null);

  /** 单条重写核心：调 AI 改写 quote 并替换（进度由调用方管理）；替换记录为修订轮次。返回是否成功 */
  const rewriteSingle = useCallback(async (a: MdAnnotation): Promise<boolean> => {
    if (!editor || !a.quote.trim() || !a.content.trim()) return false;
    const before = getMarkdown(editor);
    // 结构化意图：给 AI 带明确操作前缀；auto（自动判断）不指定方向，提示 AI 自行理解意见意图
    const intentDef = a.intent ? ANNOTATION_INTENTS.find((x) => x.id === a.intent) : undefined;
    const instruction = a.intent === 'auto'
      ? `【请自行判断本条意见的意图（改写润色/精简/扩写/翻译/修正事实/格式化等），按判断执行】${a.content}`
      : intentDef?.prefix
        ? `【${intentDef.prefix}】${a.content}`
        : a.content;
    const text = await fetchAiEditSse({
      md: before,
      instruction,
      mode: 'inline',
      selection: { text: a.quote },
    });
    if (!text || !text.trim()) return false;
    // 定位批注文字：统一锚定（from/to 优先 + quote/prefix/suffix 上下文兜底）
    const pos = resolveAnnotationPos(editor, a);
    if (!pos) return false;
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
      return false;
    }
    // 逐条重写也记录为修订轮次（进修订面板可审阅/回退），并关联来源批注（接受修订时自动标记批注已解决）
    addPatchRound(before, after, a.id);
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
    return true;
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
   *  每条改动进修订面板可审阅/回退；全部成功后批注标记已解决。 */
  const reviseFromAnnotations = useCallback(async () => {
    if (!editor || revising) return;
    const unresolved = annotations.filter((a) => !a.resolved && a.quote.trim() && a.content.trim());
    if (unresolved.length === 0) return;
    setRevising(true);
    try {
      const doneIds: string[] = [];
      for (const a of unresolved) {
        setRewritingId(a.id);
        const ok = await rewriteSingle(a);
        if (ok) doneIds.push(a.id);
      }
      setRewritingId(null);
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

  // 活动轮变化 → 重建编辑器内容（mark 轮次按 baseMd+ops 重放；patch 轮次按 diff 渲染；旧 segments 轮次按状态渲染）
  useEffect(() => {
    if (!editor) return;
    const round = revisionRounds.find((r) => r.id === activeRoundId);
    if (!round) return;
    if (round.ops && round.baseMd !== undefined) {
      replayOps(editor, round.baseMd, round.ops);
      return;
    }
    const md = round.patch ? renderPatchRound(round) : renderRevisedMd(round.segments, round.revisions);
    editor.chain().setContent(md).run();
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

  // 目录项点击 → 平滑滚动到标题
  // 按 NodeView 的 data-pos 精确定位（domAtPos 对块级标题可能返回内部文本节点，定位不稳定）
  const scrollToHeading = useCallback(
    (pos: number) => {
      if (!editor) return;
      const el = editor.view.dom.querySelector(`[data-pos="${pos}"]`) as HTMLElement | null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [editor],
  );

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

  // 点击外部关闭工具栏下拉菜单
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (headingDropdownRef.current && !headingDropdownRef.current.contains(event.target as Node)) {
        setHeadingDropdownOpen(false);
      }
      if (listDropdownRef.current && !listDropdownRef.current.contains(event.target as Node)) {
        setListDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
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
    const clone = contentEl.cloneNode(true) as HTMLElement;
    clone.removeAttribute('contenteditable');
    // 克隆体脱离 ProseMirror 交互态：清掉占位符提示与选中态装饰，避免打印出多余残留
    clone.removeAttribute('data-placeholder');
    printRoot.appendChild(clone);
    return printRoot;
  }, [editor]);

  /** 打印：克隆文档正文到隐藏打印容器，调用系统打印面板（@media print 只显示该容器） */
  const handlePrint = useCallback(async () => {
    if (!ensurePrintContent()) return;
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
  }, [ensurePrintContent]);

  /** HTML 导出：把文档正文打包为自包含 HTML（内联基础排版样式）下载 */
  const handleExportHtml = useCallback(async (fileName: string) => {
    const printRoot = ensurePrintContent();
    if (!printRoot) return;
    const title = fileName.replace(/\.html$/i, '') || 'export';
    const css = `
      body { max-width: 900px; margin: 0 auto; padding: 48px; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', sans-serif; color: #1d1d1f; line-height: 1.7; font-size: 15px; }
      img { max-width: 100%; height: auto; }
      table { border-collapse: collapse; width: 100%; margin: 12px 0; }
      th, td { border: 1px solid #d2d2d7; padding: 8px 12px; text-align: left; vertical-align: top; }
      pre { background: #f5f5f7; padding: 12px; border-radius: 8px; overflow-x: auto; }
      code { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 0.92em; }
      blockquote { border-left: 3px solid #d2d2d7; margin: 8px 0; padding: 4px 12px; color: #6e6e73; }
      h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.2em 0 0.5em; }
      ul, ol { padding-left: 1.6em; }
      .footnotes { margin-top: 2em; padding-top: 12px; border-top: 1px solid #d2d2d7; font-size: 12px; color: #6e6e73; }
      .footnotes h2 { font-size: 12px; }
      .footnotes a[data-footnote-backref] { text-decoration: none; color: #6e6e73; margin-left: 4px; }
      sup[data-footnote-ref] { font-size: 0.72em; }
      sup[data-footnote-ref] a { color: #4b3fe3; text-decoration: none; font-weight: 600; }
    `;
    const full = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${css}</style></head><body>${printRoot.innerHTML}</body></html>`;
    const blob = new Blob([full], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName.endsWith('.html') ? fileName : `${fileName}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [ensurePrintContent]);

  /** PDF 导出：Electron 主进程 printToPDF → 下载；浏览器（dev）回退系统打印面板（可存储为 PDF） */
  const handleExportPdf = useCallback(async (fileName: string) => {
    if (!ensurePrintContent()) return;
    const api = (window as unknown as { api?: { exportPdf?: () => Promise<{ success?: boolean; data?: string; error?: string }> } }).api;
    if (api?.exportPdf) {
      try {
        const res = await api.exportPdf();
        if (res && res.success && res.data) {
          const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
          const blob = new Blob([bytes], { type: 'application/pdf' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          return;
        }
        // 主进程 PDF 生成失败：提示 + 回退系统打印（面板中可选择"存储为 PDF"）
        alert(res?.error || 'PDF export failed');
        window.print();
      } catch (e) {
        alert(`PDF export failed: ${e instanceof Error ? e.message : String(e)}`);
        window.print();
      }
    } else {
      window.print();
    }
  }, [ensurePrintContent]);

  /** 新建 md 文档：在当前文档所在目录创建 untitled.md 并打开。
   *  支持本地文件（绝对路径父目录）与项目文件（项目内相对目录）两种场景；
   *  其他场景（节点文档/docx 编辑）点击给出明确提示，避免"点了没反应"。 */
  const handleCreateMdDoc = useCallback(async () => {
    try {
      // ── 本地文件：绝对路径父目录 ──
      if (filePath && source === 'local') {
        const dir = filePath.split('/').slice(0, -1).join('/');
        const listResp = await fetch(`/api/local-files?path=${encodeURIComponent(dir)}`);
        const listData = await listResp.json();
        const names = new Set((listData.items || []).map((it: { name: string }) => it.name));
        let name = 'untitled.md';
        let counter = 2;
        while (names.has(name)) {
          name = `untitled-${counter}.md`;
          counter++;
        }
        const fullPath = `${dir}/${name}`;
        const writeResp = await fetch('/api/local-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'write', path: fullPath, content: '' }),
        });
        const writeData = await writeResp.json();
        if (!writeData.success) {
          alert(writeData.error || 'Create file failed');
          return;
        }
        // 与本地文件面板双击 md 行为一致：发布 fileOpen 事件在查看舱打开
        bus.publish(BusEvents.fileOpen, { source: 'local', path: fullPath, name });
        return;
      }

      // ── 项目文件：项目内相对目录（filePath 为项目内相对路径，空目录 = 项目根） ──
      if (filePath && projectId && source === 'project') {
        const dir = filePath.split('/').slice(0, -1).join('/');
        // stat 探测避重命名（轻量存在性校验）
        const exists = async (rel: string): Promise<boolean> => {
          try {
            const resp = await fetch('/api/projects', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'stat', project_id: projectId, file_path: rel }),
            });
            const d = await resp.json();
            return d.success && d.exists === true;
          } catch { return false; }
        };
        let name = 'untitled.md';
        let counter = 2;
        let rel = dir ? `${dir}/${name}` : name;
        while (await exists(rel)) {
          name = `untitled-${counter}.md`;
          counter++;
          rel = dir ? `${dir}/${name}` : name;
        }
        const writeResp = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'write_file', project_id: projectId, file_path: rel, content: '' }),
        });
        const writeData = await writeResp.json();
        if (!writeData.success) {
          alert(writeData.error || 'Create file failed');
          return;
        }
        bus.publish(BusEvents.fileOpen, { source: 'project', path: rel, name });
        return;
      }

      alert('New Markdown files are supported for local files or project files only: open a .md file in the left file panel first, then use this command.');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Create file failed');
    }
  }, [filePath, projectId, source]);

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
  const handleAddLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href as string | undefined;
    setPromptValue(previousUrl ?? 'https://');
    setPromptState({
      title: 'Add Link',
      initialValue: previousUrl ?? 'https://',
      onSubmit: (url) => {
        if (!editor) return;
        if (url === '') {
          editor.chain().focus().extendMarkRange('link').unsetLink().run();
        } else {
          editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
        }
      },
    });
  }, [editor]);

  // 工具栏：添加图片（节点编辑时选择本地图片，无节点时降级为 URL）
  const handleAddImage = useCallback(() => {
    if (!editor) return;
    if (nodeMdId) {
      // 打开本地图片选择，上传到节点附件目录后插入
      imageInputRef.current?.click();
      return;
    }
    // 降级：无节点场景（如直接编辑项目文件）仍可粘贴 URL 图片
    setPromptValue('https://');
    setPromptState({
      title: 'Add Image',
      initialValue: 'https://',
      onSubmit: (url) => {
        if (url && editor) editor.chain().focus().setImage({ src: url }).run();
      },
    });
  }, [editor, nodeMdId]);

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

  /** 插入文档（飞书式单入口）：输入目标路径后，选择「链接」或「嵌入卡片」两种呈现方式 */
  const handleInsertDoc = useCallback(() => {
    if (!editor) return;
    setPromptValue('');
    setPromptState({
      title: 'Insert Document',
      initialValue: '',
      placeholder: 'Paste a link, or enter a document path (e.g. homework/report.md)',
      choices: [
        {
          label: 'Link',
          primary: true,
          onSubmit: async (targetPath) => {
            if (!targetPath || !editor) return;
            const raw = targetPath.trim();
            // 直接粘贴 URL：跳过 share，原样作为链接
            const isUrl = /^https?:\/\//i.test(raw);
            let href = raw;
            let label = raw;
            if (!isUrl) {
              // 文档路径 → 生成局域网分享链接
              try {
                const resp = await fetch('/api/share', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ path: raw }),
                });
                const data = await resp.json();
                if (!data.success || !data.url) {
                  showImageAiEditToast(`Insert failed: ${data.error ?? 'unknown'}`, 'error');
                  return;
                }
                href = data.url;
                label = raw.split('/').pop()?.replace(/\.md$/i, '') ?? 'document';
              } catch (e) {
                showImageAiEditToast(`Insert failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
                return;
              }
            }
            const { from, to } = editor.state.selection;
            if (from === to) {
              // 无选中文字：插入带文本的 markdown 链接
              editor.chain().focus().insertContent(`[${label}](${href})`).run();
            } else {
              // 有选中文字：把选区包成链接
              editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
            }
            showImageAiEditToast('Document link inserted');
          },
        },
        {
          label: 'Embed Card',
          onSubmit: (targetPath) => {
            if (!targetPath || !editor) return;
            editor.chain().focus().insertContent({ type: 'mdEmbed', attrs: { path: targetPath.trim() } }).run();
            showImageAiEditToast('Document embedded');
          },
        },
      ],
    });
  }, [editor]);

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

  /** 格式化文档：轻量整理 markdown（标题空格/空行/行尾空白） */
  const handleFormatMarkdown = useCallback(() => {
    if (!editor) return;
    const md = getMarkdown(editor);
    const formatted = formatMarkdown(md);
    if (formatted !== md) editor.chain().setContent(formatted).run();
  }, [editor]);

  /** 插入脚注：光标处插入引用标记 [^n]（编号自动递增），定义行统一追加到文档末尾
   *  （Markdown 规范：脚注定义集中放文末），并把光标移到定义处直接输入内容 */
  const handleAddFootnote = useCallback(() => {
    if (!editor) return;
    const md = getMarkdown(editor);
    const used = new Set<string>();
    for (const m of md.matchAll(/\[\^(\d+)\]/g)) used.add(m[1]);
    let n = 1;
    while (used.has(String(n))) n++;
    const marker = `[^${n}]`;
    // 1) 光标处插入引用标记，光标保持在标记后
    editor.chain().focus().insertContent(marker).run();
    // 2) 定义行追加到文档末尾（独立段落，避免 \n 被解析为 <br>）
    const docEnd = editor.state.doc.content.size;
    editor
      .chain()
      .focus()
      .setTextSelection(docEnd)
      .insertContent(`<p></p><p>${marker}: </p>`)
      .run();
    // 3) 光标落到定义内容位置，用户可直接输入脚注文字
    editor.chain().focus().setTextSelection(editor.state.doc.content.size).run();
  }, [editor]);

  // ⌘K 命令面板：统一入口（格式/段落/插入/历史/工具）
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    if (!editor) return [];
    const cmds: PaletteCommand[] = [];
    const push = (group: string, id: string, label: string, hint: string | undefined, run: () => void) =>
      cmds.push({ id: `${group}:${id}`, group, label, hint, run });
    // 格式
    push('Format', 'bold', 'Bold', '⌘B', () => editor.chain().focus().toggleBold().run());
    push('Format', 'italic', 'Italic', '⌘I', () => editor.chain().focus().toggleItalic().run());
    push('Format', 'strike', 'Strikethrough', '', () => editor.chain().focus().toggleStrike().run());
    push('Format', 'code', 'Inline Code', '', () => editor.chain().focus().toggleCode().run());
    // 段落
    push('Block', 'h1', 'Heading 1', '', () => editor.chain().focus().toggleHeading({ level: 1 }).run());
    push('Block', 'h2', 'Heading 2', '', () => editor.chain().focus().toggleHeading({ level: 2 }).run());
    push('Block', 'h3', 'Heading 3', '', () => editor.chain().focus().toggleHeading({ level: 3 }).run());
    push('Block', 'paragraph', 'Paragraph', '', () => editor.chain().focus().setParagraph().run());
    push('Block', 'bullet', 'Bullet List', '', () => editor.chain().focus().toggleBulletList().run());
    push('Block', 'ordered', 'Ordered List', '', () => editor.chain().focus().toggleOrderedList().run());
    push('Block', 'task', 'Task List', '', () => editor.chain().focus().toggleTaskList().run());
    push('Block', 'quote', 'Blockquote', '', () => editor.chain().focus().toggleBlockquote().run());
    push('Block', 'codeblock', 'Code Block', '', () => editor.chain().focus().toggleCodeBlock().run());
    push('Block', 'hr', 'Divider', '', () => editor.chain().focus().setHorizontalRule().run());
    // 插入
    push('Insert', 'link', 'Add Link…', '', handleAddLink);
    push('Insert', 'image', 'Add Image…', '', handleAddImage);
    push('Insert', 'footnote', 'Footnote', '', handleAddFootnote);
    push('Insert', 'table', 'Table (3×3)', '', () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run());
    push('Insert', 'columns2', 'Two Columns', '', () => editor.chain().focus().insertBobColumns(2).run());
    push('Insert', 'columns3', 'Three Columns', '', () => editor.chain().focus().insertBobColumns(3).run());
    // 历史
    push('History', 'undo', 'Undo', '⌘Z', () => editor.chain().focus().undo().run());
    push('History', 'redo', 'Redo', '⇧⌘Z', () => editor.chain().focus().redo().run());
    // 工具
    push('Tools', 'format', 'Format Document', '', handleFormatMarkdown);
    push('Tools', 'annotations', 'Annotations', '', () => setAnnotationPanelOpen((v) => !v));
    push('Tools', 'toc', 'Table of Contents', '', () => setShowToc((v) => !v));
    push('Tools', 'docx', 'Export…', 'DOCX/HTML/PDF', () => setShowExportDialog(true));
    push('Tools', 'print', 'Print', '', handlePrint);
    push('Tools', 'new-doc', 'New Markdown File', '', handleCreateMdDoc);
    push('Tools', 'insert-doc', 'Insert Document…', 'Link / Embed', handleInsertDoc);
    push('Tools', 'share', 'Share…', '', handleShareDocument);
    return cmds;
  }, [editor, handleAddLink, handleAddImage, handleAddFootnote, handleFormatMarkdown, handlePrint, handleCreateMdDoc, handleInsertDoc, handleShareDocument]);

  /** `/` 斜杠命令列表：复用 ⌘K 面板的段落/插入类命令，按输入查询词实时过滤 */
  const slashCommands = useMemo(() => {
    if (paletteCommands.length === 0) return [];
    const q = slashQuery.trim().toLowerCase();
    return paletteCommands
      .filter((c) => c.group === 'Block' || c.group === 'Insert')
      .filter((c) => !q || `${c.group}${c.label}`.toLowerCase().includes(q));
  }, [paletteCommands, slashQuery]);

  /** 执行斜杠命令：先删除光标所在行的 '/' + 查询词（保留行首缩进），再执行插入命令 */
  const runSlashCommand = useCallback(
    (cmd: PaletteCommand) => {
      const view = editor?.view;
      if (view) {
        // 用斜杠行光标快照定位（失焦/选区漂移时仍准确）；无快照回退当前选区
        const caret = typeof slashCaretRef.current === 'number' ? slashCaretRef.current : view.state.selection.from;
        const pos = Math.max(0, Math.min(caret, view.state.doc.content.size));
        const line = currentLineText(view, pos);
        if (line.startsWith('/') && pos > 0) {
          // 与 currentLineText 一致：hardBreak 也渲染为 \n，行起点以最近换行(含软换行)为准
          const textBefore = view.state.doc.textBetween(0, pos, '\n', (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : ''));
          const lineStart = textBefore.lastIndexOf('\n') + 1;
          view.dispatch(view.state.tr.delete(lineStart, pos));
        }
        slashCaretRef.current = null;
      }
      setSlashOpen(false);
      setSlashQuery('');
      cmd.run();
    },
    [editor, currentLineText],
  );

  // 斜杠菜单键盘导航（注入 editorProps.handleKeyDown；每次渲染刷新闭包拿到最新命令/索引）
  slashNavRef.current = (e) => {
    if (!slashOpen) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => Math.min(i + 1, slashCommands.length - 1)); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => Math.max(i - 1, 0)); return true; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = slashCommands[slashIndex];
      if (cmd) runSlashCommand(cmd);
      else { setSlashOpen(false); setSlashQuery(''); }
      return true;
    }
    if (e.key === 'Escape') { e.preventDefault(); setSlashOpen(false); setSlashQuery(''); return true; }
    if (e.key === 'Backspace') {
      // 不拦截删除；按删除后的行文本同步菜单（'/' 消失则关闭）
      const view = editor?.view;
      const from = view?.state.selection.from ?? 0;
      const line = currentLineText(view, from);
      if (line === '/') { setSlashOpen(false); setSlashQuery(''); }
      else if (line.startsWith('/')) {
        setSlashQuery(line.slice(1, -1));
        setSlashIndex(0);
        // 默认 Backspace 将删除光标前一字符：快照随之回退一位（保持与行尾一致）
        slashCaretRef.current = Math.max(from - 1, 0);
      }
      return false;
    }
    return false;
  };

  // `/` 斜杠菜单：点击外部 / 在菜单外滚轮滚动时关闭（菜单内滚动用于翻看命令列表，不关闭）
  useEffect(() => {
    if (!slashOpen) return;
    const onDown = (e: MouseEvent) => {
      if (slashRef.current && !slashRef.current.contains(e.target as Node)) setSlashOpen(false);
    };
    const onWheel = (e: WheelEvent) => {
      if (slashRef.current && slashRef.current.contains(e.target as Node)) return;
      setSlashOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('wheel', onWheel);
    };
  }, [slashOpen]);

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

  /** 全文检索匹配区间（textBetween 字符串索引 +1 即 doc position，与 locateTextInDoc 一致） */
  const computeFindMatches = useCallback(
    (view: EditorView | null, query: string): { from: number; to: number }[] => {
      if (!view || !query) return [];
      const fullText = view.state.doc.textBetween(0, view.state.doc.content.size, '\n');
      const matches: { from: number; to: number }[] = [];
      let idx = 0;
      while ((idx = fullText.indexOf(query, idx)) >= 0) {
        matches.push({ from: idx + 1, to: idx + 1 + query.length });
        idx += query.length;
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
    const view = editor?.view;
    if (view) view.dispatch(view.state.tr.setMeta(findDecoKey, DecorationSet.empty));
    editor?.commands.focus();
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

  /** 执行命令面板命令 */
  const runPaletteCommand = useCallback((cmd: PaletteCommand) => {
    setCommandOpen(false);
    setCommandQuery('');
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
      const targetNodeId = nodeMdId || activeNodeId;
      if (!targetNodeId) return;
      window.dispatchEvent(new CustomEvent('node-ask-question', { detail: { nodeId: targetNodeId, text: quote } }));
      // 目标节点 ≠ 画布当前选中节点时，把它放大置前：输入框 + 引用标签在目标节点上可见，
      // 避免引用挂到“看不到/输入框已收起”的节点上造成困惑（Ask 后让目标成为可见的当前节点）。
      if (nodeMdId && nodeMdId !== activeNodeId) {
        window.dispatchEvent(new CustomEvent('node-expand-request', { detail: { node_id: nodeMdId } }));
      }
    },
    [nodeMdId, activeNodeId],
  );


  // 本地图片选择 → 上传到节点附件目录 → 以附件 URL 插入编辑器
  const handleImageFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // 允许重复选择同一文件
      if (!file || !editor) return;
      setUploadingImage(true);
      try {
        const src = await uploadImageFile(file);
        if (src) editor.chain().focus().setImage({ src }).run();
        else console.error('图片上传失败');
      } catch (err) {
        console.error('图片上传失败:', err);
      } finally {
        setUploadingImage(false);
      }
    },
    [editor, uploadImageFile],
  );

  if (!editor) {
    return <div className="doc-editor-loading p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>Loading editor...</div>;
  }

  // ⌘K 顶部历史区：撤销/重做固定在搜索栏左侧（不占命令分组行）
  const historyCmds = paletteCommands.filter((c) => c.group === 'History');
  // 主体命令（不含历史）：用于命令行渲染与搜索导航
  const mainCommands = paletteCommands.filter((c) => c.group !== 'History');

  // ⌘K 命令面板：过滤后的命令列表
  const paletteQuery = commandQuery.trim().toLowerCase();
  const filteredCommands = paletteQuery
    ? mainCommands.filter((c) => `${c.group}${c.label}${c.hint ?? ''}`.toLowerCase().includes(paletteQuery))
    : mainCommands;

  // ⌘K 横排分组布局：把扁平命令按组归拢成若干「行」（组内命令仍保持原有先后），每条记录全局 flat 索引供高亮/回车
  const groupRuns: { group: string; items: { cmd: PaletteCommand; idx: number }[] }[] = [];
  filteredCommands.forEach((cmd, idx) => {
    const last = groupRuns[groupRuns.length - 1];
    if (last && last.group === cmd.group) last.items.push({ cmd, idx });
    else groupRuns.push({ group: cmd.group, items: [{ cmd, idx }] });
  });

  return (
    <div
      className="doc-editor-wrapper flex flex-col h-full"
      onClick={() => {}}
    >
      {/* 顶部工具栏（仅可编辑时显示）：默认折叠，常驻 Formatting 条点击展开/收起；格式操作亦可经 ⌘K / `/` 完成 */}
      {editable && (
        <div className="shrink-0" style={{ backgroundColor: 'var(--paper-soft)' }}>
          {/* 折叠条：右侧常驻保存状态 */}
          <div className="flex h-8 items-center gap-1 border-b px-2" style={{ borderColor: 'var(--line)' }}>
            <button
              type="button"
              onClick={() => setToolbarCollapsed((v) => !v)}
              title={toolbarCollapsed ? 'Show formatting toolbar' : 'Hide formatting toolbar'}
              className="flex h-6 items-center gap-1 rounded-md px-1.5 text-12 font-medium transition-colors hover:bg-[color-mix(in_oklab,var(--ink)_8%,transparent)]"
              style={{ color: 'var(--ink-muted)' }}
            >
              <ChevronDown
                className="h-3.5 w-3.5 transition-transform"
                style={{ transform: toolbarCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
              />
              Formatting
            </button>
            {toolbarCollapsed && (
              <span className="text-10" style={{ color: 'var(--ink-faint)' }}>
                Press ⌘K for all commands
              </span>
            )}
            {/* 保存状态指示器（折叠时也可见） */}
            <div
              className="ml-auto flex items-center px-1"
              title={saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : 'Unsaved changes'}
              style={{ color: 'var(--ink-muted)' }}
            >
              {saveStatus === 'saving' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {saveStatus === 'saved' && <Check className="h-3.5 w-3.5" style={{ color: 'var(--success)' }} />}
              {saveStatus === 'unsaved' && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--warn)' }} />}
            </div>
          </div>

          {!toolbarCollapsed && (
            <div className="doc-editor-toolbar flex flex-wrap items-center gap-0.5 px-2 py-1.5" style={{ borderBottom: '1px solid var(--line)' }}>
          <ToolbarButton
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
            title="Bold"
          >
            <Bold className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            title="Italic"
          >
            <Italic className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('strike')}
            onClick={() => editor.chain().focus().toggleStrike().run()}
            title="Strikethrough"
          >
            <Strikethrough className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('code')}
            onClick={() => editor.chain().focus().toggleCode().run()}
            title="Inline Code"
          >
            <Code className="h-4 w-4" />
          </ToolbarButton>

          <Divider />

          {/* Heading 下拉分组 */}
          <div ref={headingDropdownRef} className="relative">
            <button
              type="button"
              onClick={() => setHeadingDropdownOpen((v) => !v)}
              title="Heading"
              className="flex items-center justify-center gap-0.5 rounded-md transition-colors"
              style={{
                height: '28px',
                padding: '0 5px',
                color: editor.isActive('heading') ? 'var(--primary)' : 'var(--ink-muted)',
                backgroundColor: editor.isActive('heading') ? 'color-mix(in oklab, var(--primary) 10%, transparent)' : 'transparent',
              }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {editor.isActive('heading', { level: 1 }) ? <Heading1 className="h-4 w-4" /> :
               editor.isActive('heading', { level: 2 }) ? <Heading2 className="h-4 w-4" /> :
               editor.isActive('heading', { level: 3 }) ? <Heading3 className="h-4 w-4" /> :
               <Heading className="h-4 w-4" />}
              <ChevronDown className="h-3 w-3" />
            </button>
            {headingDropdownOpen && (
              <div
                className="absolute left-0 top-full z-50 mt-1 min-w-[120px] overflow-hidden rounded-lg border py-1 shadow-lg"
                style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)' }}
              >
                <DropdownItem
                  active={!editor.isActive('heading')}
                  onClick={() => {
                    editor.chain().focus().setParagraph().run();
                    setHeadingDropdownOpen(false);
                  }}
                  label="Paragraph"
                  shortcut={<span className="text-xs">P</span>}
                />
                <DropdownItem
                  active={editor.isActive('heading', { level: 1 })}
                  onClick={() => {
                    editor.chain().focus().toggleHeading({ level: 1 }).run();
                    setHeadingDropdownOpen(false);
                  }}
                  label="Heading 1"
                  shortcut={<Heading1 className="h-3.5 w-3.5" />}
                />
                <DropdownItem
                  active={editor.isActive('heading', { level: 2 })}
                  onClick={() => {
                    editor.chain().focus().toggleHeading({ level: 2 }).run();
                    setHeadingDropdownOpen(false);
                  }}
                  label="Heading 2"
                  shortcut={<Heading2 className="h-3.5 w-3.5" />}
                />
                <DropdownItem
                  active={editor.isActive('heading', { level: 3 })}
                  onClick={() => {
                    editor.chain().focus().toggleHeading({ level: 3 }).run();
                    setHeadingDropdownOpen(false);
                  }}
                  label="Heading 3"
                  shortcut={<Heading3 className="h-3.5 w-3.5" />}
                />
              </div>
            )}
          </div>

          {/* List 下拉分组 */}
          <div ref={listDropdownRef} className="relative">
            <button
              type="button"
              onClick={() => setListDropdownOpen((v) => !v)}
              title="List"
              className="flex items-center justify-center gap-0.5 rounded-md transition-colors"
              style={{
                height: '28px',
                padding: '0 5px',
                color: editor.isActive('list') ? 'var(--primary)' : 'var(--ink-muted)',
                backgroundColor: editor.isActive('list') ? 'color-mix(in oklab, var(--primary) 10%, transparent)' : 'transparent',
              }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {editor.isActive('orderedList') ? <ListOrdered className="h-4 w-4" /> :
               editor.isActive('taskList') ? <CheckSquare className="h-4 w-4" /> :
               <List className="h-4 w-4" />}
              <ChevronDown className="h-3 w-3" />
            </button>
            {listDropdownOpen && (
              <div
                className="absolute left-0 top-full z-50 mt-1 min-w-[140px] overflow-hidden rounded-lg border py-1 shadow-lg"
                style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)' }}
              >
                <DropdownItem
                  active={editor.isActive('bulletList')}
                  onClick={() => {
                    editor.chain().focus().toggleBulletList().run();
                    setListDropdownOpen(false);
                  }}
                  label="Bullet List"
                  shortcut={<List className="h-3.5 w-3.5" />}
                />
                <DropdownItem
                  active={editor.isActive('orderedList')}
                  onClick={() => {
                    editor.chain().focus().toggleOrderedList().run();
                    setListDropdownOpen(false);
                  }}
                  label="Ordered List"
                  shortcut={<ListOrdered className="h-3.5 w-3.5" />}
                />
                <DropdownItem
                  active={editor.isActive('taskList')}
                  onClick={() => {
                    editor.chain().focus().toggleTaskList().run();
                    setListDropdownOpen(false);
                  }}
                  label="Task List"
                  shortcut={<CheckSquare className="h-3.5 w-3.5" />}
                />
              </div>
            )}
          </div>

          {/* 插入表格 */}
          <ToolbarButton
            active={editor.isActive('table')}
            onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
            title="Insert Table (3×3)"
          >
            <TableIcon className="h-4 w-4" />
          </ToolbarButton>

          <Divider />

          <ToolbarButton
            active={editor.isActive('blockquote')}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            title="Blockquote"
          >
            <Quote className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('codeBlock')}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            title="Code Block"
          >
            <Code2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
            title="Horizontal Rule"
          >
            <Minus className="h-4 w-4" />
          </ToolbarButton>

          <Divider />

          <ToolbarButton active={editor.isActive('link')} onClick={handleAddLink} title="Link">
            <LinkIcon className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={handleAddImage}
            title={nodeMdId ? 'Insert Local Image' : 'Insert Image (URL)'}
          >
            {uploadingImage ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ImageIcon className="h-4 w-4" />
            )}
          </ToolbarButton>

          <ToolbarButton onClick={handleAddFootnote} title="Footnote（插入脚注引用与定义）">
            <Hash className="h-4 w-4" />
          </ToolbarButton>

          {/* 本地图片文件选择（仅节点编辑场景使用） */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleImageFileSelected}
          />

          <Divider />

          <ToolbarButton onClick={() => editor.chain().focus().undo().run()} title="Undo">
            <Undo className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().redo().run()} title="Redo">
            <Redo className="h-4 w-4" />
          </ToolbarButton>

          <Divider />

          <ToolbarButton onClick={() => setShowExportDialog(true)} title="Export（DOCX / HTML / PDF）">
            <FileDown className="h-4 w-4" />
          </ToolbarButton>

          {/* 新建 md 文档（本地文件场景：当前文档目录；其他场景点击给出提示） */}
          <ToolbarButton
            onClick={handleCreateMdDoc}
            title="Create new Markdown file in this folder (local files only)"
          >
            <FilePlus className="h-4 w-4" />
          </ToolbarButton>

          <ToolbarButton onClick={handleFormatMarkdown} title="Format（整理 Markdown）">
            <Wand2 className="h-4 w-4" />
          </ToolbarButton>

          <ToolbarButton onClick={handleInsertDoc} title="Insert document（插入其他 md 文档，可选链接或嵌入卡片）">
            <FileText className="h-4 w-4" />
          </ToolbarButton>

          <ToolbarButton onClick={handleShareDocument} title="Share（生成局域网分享链接）">
            <Share2 className="h-4 w-4" />
          </ToolbarButton>

          <ToolbarButton onClick={handlePrint} title="Print">
            <Printer className="h-4 w-4" />
          </ToolbarButton>

          <Divider />

          {/* 批注栏开关（仅可编辑且有 sidecar key 时显示）：打开批注面板（修订视图在面板内 tab 切换） */}
          {annotationKey && (
            <ToolbarButton
              active={annotationPanelOpen}
              onClick={() => setAnnotationPanelOpen((v) => !v)}
              title={annotationPanelOpen ? 'Close annotations' : 'Annotations'}
            >
              <MessageSquare className="h-4 w-4" />
            </ToolbarButton>
          )}

            </div>
          )}
        </div>
      )}

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

      {/* 查找替换栏（⌘F）：固定在工具栏与内容区之间，不随文档滚动 */}
      {findOpen && (
        <div
          className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
          style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-soft)' }}
        >
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
        </div>
      )}

      {/* 编辑器内容区：左侧目录栏 + 主编辑区 */}
      <div className="doc-editor-body flex min-h-0 flex-1">
        {!hideToc && showToc && headings.length > 0 && (
          <div
            className="doc-editor-toc w-52 shrink-0 overflow-y-auto border-r py-2 ai-canvas-scroll"
            style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)' }}
          >
            <div className="px-3 pb-1.5 text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
              Outline
            </div>
            {headings.map((h) => {
              const active = activeHeadingPos === h.pos;
              return (
                <button
                  key={h.pos}
                  onClick={() => scrollToHeading(h.pos)}
                  title={h.text}
                  className="group relative block w-full truncate px-3 py-0.5 text-left text-xs transition-colors"
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
        <div
          className="relative flex min-w-0 flex-1 flex-col overflow-y-auto ai-canvas-scroll"
          style={{ backgroundColor: 'var(--paper-soft)', padding: '28px 32px' }}
        >
          {!hideToc && (
            /* 目录开关（悬浮按钮） */
            <button
              onClick={() => setShowToc((v) => !v)}
              title={showToc ? 'Hide TOC' : 'Show TOC'}
              className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md hover:bg-[color-mix(in_oklab,var(--ink)_10%,transparent)]"
              style={{ color: 'var(--ink-muted)', backgroundColor: showToc ? 'color-mix(in oklab, var(--ink) 6%, transparent)' : 'transparent' }}
            >
              <ListTree className="h-3.5 w-3.5" />
            </button>
          )}
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
              <div className="md-annotation-card-title">
                <MessageSquare className="h-3 w-3" style={{ color: 'var(--primary)' }} />
                <span className="truncate" title={ann.quote}>
                  &ldquo;{ann.quote.length > 40 ? `${ann.quote.slice(0, 40)}…` : ann.quote}&rdquo;
                </span>
              </div>
              {intentDef && (
                <div className="md-annotation-card-intent">
                  <Wand2 className="h-2 w-2" />
                  {intentDef.label}
                </div>
              )}
              <div className="md-annotation-card-content">{ann.content}</div>
              <div className="md-annotation-card-time">
                {ann.resolved ? 'Resolved' : new Date(ann.createdAt).toLocaleString()}
              </div>
            </div>
          );
        })()}

      {/* 批注气泡：选中文字直接弹出批注输入框（添加后同步到右侧批注栏） */}
      {editable && annotationKey && editor && (
        <AnnotationBubble
          editor={editor}
          onAdd={handleAnnotate}
          onAsk={handleAskInNode}
          canAskCurrent={!!(nodeMdId || activeNodeId)}
        />
      )}

      {/* ProseMirror 专属样式：复用 .html-renderer 的全局样式，此处补充编辑器特有样式 */}
      <style>{`
        /* 纸张居中排版：编辑区限宽居中、白纸卡片感（柔和投影/圆角），与面板底色区分。
           width:100% 必须显式声明：flex-col 容器中子项交叉轴（横向）默认 stretch 撑满，
           但 margin:0 auto 会禁用 stretch，宽度退化为内容宽（空文档只剩占位符一行，纸张缩成小条）。
           width:100% + max-width:900px + margin:auto → 面板内贴满（窄面板 516px / 宽面板 896px），宽容器下 900px 居中 */
        .doc-editor-content {
          outline: none;
          flex: 1 0 auto;
          min-height: 200px;
          max-width: 900px;
          width: 100%;
          margin: 0 auto;
          padding: 32px 40px;
          font-family: var(--font-sans);
          font-size: 14px;
          line-height: 1.8;
          color: var(--ink);
          user-select: text;
          background: var(--paper);
          border: 1px solid var(--line-soft);
          border-radius: 10px;
          /* 完全去掉投影：只留边框与圆角（用户反馈去投影） */
          box-shadow: none;
        }
        .doc-editor-content:focus { outline: none; }
        /* 去掉聚焦时的品牌紫描边（用户反馈"选中后出现紫色边框"）；保留 :focus 无描边即可 */
        .doc-editor-content:focus-visible {
          outline: none;
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
        /* 批注查看卡片：点图标弹出，纯查看；fixed 定位由 JS 计算（图标下方 / 视口不足翻转） */
        .md-annotation-card {
          width: 280px;
          max-height: 260px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid var(--line);
          background-color: var(--popover);
          color: var(--ink);
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.08);
          font-family: var(--font-sans);
        }
        .md-annotation-card-title {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          font-weight: 600;
          color: var(--primary);
        }
        .md-annotation-card-intent {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          align-self: flex-start;
          border-radius: 999px;
          padding: 1px 7px;
          font-size: 9px;
          font-weight: 500;
          background-color: color-mix(in oklab, var(--primary) 10%, transparent);
          color: var(--primary);
        }
        .md-annotation-card-content {
          font-size: 11.5px;
          line-height: 1.55;
          color: var(--ink);
          overflow-y: auto;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .md-annotation-card-time {
          font-size: 10px;
          color: var(--ink-faint);
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
        .doc-editor-content h1 { margin: 34px 0 14px; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.3; }
        .doc-editor-content h2 { margin: 26px 0 12px; font-size: 22px; font-weight: 680; letter-spacing: -0.015em; line-height: 1.35; }
        .doc-editor-content h3 { margin: 18px 0 10px; font-size: 17px; font-weight: 650; line-height: 1.4; }
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
        /* 文档嵌入卡片（MdEmbed NodeView）：明显的「卡片」视觉，与普通文字链接区分 */
        .doc-editor-content .md-embed-card {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px 8px 8px;
          border: 1px solid color-mix(in oklab, var(--primary) 25%, var(--line-soft));
          border-radius: 8px;
          background: color-mix(in oklab, var(--primary) 5%, var(--paper));
          cursor: pointer;
          user-select: none;
          transition: background 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
        }
        .doc-editor-content .md-embed-card:hover {
          background: color-mix(in oklab, var(--primary) 10%, transparent);
          border-color: var(--primary);
          box-shadow: 0 2px 8px color-mix(in oklab, var(--primary) 18%, transparent);
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
        .doc-editor-content .md-embed-card .md-embed-open {
          width: 13px;
          height: 13px;
          color: var(--ink-muted);
          flex: none;
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
        .doc-editor-content.resize-cursor { cursor: col-resize; }
        /* 占位符 */
        .doc-editor-content p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: var(--ink-muted);
          pointer-events: none;
          height: 0;
          font-style: italic;
        }
        /* 打印：克隆容器平时隐藏；打印时隐藏应用 UI，仅输出文档正文（白底黑字） */
        #doc-print-root { display: none; }
        @media print {
          body > *:not(#doc-print-root) { display: none !important; }
          #doc-print-root {
            display: block !important;
            padding: 24px;
            color: #111 !important;
            font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', sans-serif;
            font-size: 14px;
            line-height: 1.75;
          }
          /* 克隆正文打印时剥离编辑器卡片样式（边框/阴影/圆角/背景），纯白纸输出 */
          #doc-print-root .doc-editor-content {
            max-width: none !important;
            margin: 0 !important;
            padding: 0 !important;
            border: none !important;
            box-shadow: none !important;
            border-radius: 0 !important;
            background: #fff !important;
            color: #111 !important;
            font-size: 14px !important;
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

      <ExportDocxDialog
        open={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        onExport={handleExportDocx}
        onExportHtml={handleExportHtml}
        onExportPdf={handleExportPdf}
        defaultFileName={nodeMdId ? 'export' : (filePath?.split('/').pop()?.replace(/\.[^.]+$/, '') || 'export')}
      />

      {/* `/` 斜杠命令菜单：光标处弹出插入命令（复用 ⌘K 面板命令，无新依赖） */}
      {slashOpen && slashAnchor && (
        <div
          ref={slashRef}
          className="fixed z-[150] w-[240px] overflow-hidden rounded-lg border"
          style={{
            left: Math.min(slashAnchor.x, (typeof window !== 'undefined' ? window.innerWidth : 900) - 256),
            top: slashAnchor.y + 6,
            backgroundColor: 'var(--popover)',
            borderColor: 'var(--line)',
            boxShadow: '0 16px 48px rgba(0,0,0,0.22)',
            WebkitAppRegion: 'no-drag',
          } as React.CSSProperties}
        >
          <div className="max-h-[280px] overflow-y-auto ai-canvas-scroll py-1">
            {slashCommands.length === 0 ? (
              <div className="px-3 py-2 text-xs" style={{ color: 'var(--ink-faint)' }}>No matching commands</div>
            ) : (
              slashCommands.map((cmd, i) => (
                <button
                  key={cmd.id}
                  onClick={() => runSlashCommand(cmd)}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setSlashIndex(i)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-13 transition-colors"
                  style={{ backgroundColor: i === slashIndex ? 'var(--paper-hover)' : 'transparent', color: 'var(--ink)' }}
                >
                  <span className="w-10 shrink-0 text-10 font-medium" style={{ color: 'var(--ink-faint)' }}>{cmd.group}</span>
                  <span className="flex-1 truncate">{cmd.label}</span>
                </button>
              ))
            )}
          </div>
          <div className="border-t px-3 py-1 text-10" style={{ borderColor: 'var(--line)', color: 'var(--ink-faint)' }}>
            ↑↓ navigate · Enter insert · Esc close
          </div>
        </div>
      )}

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

      {/* ⌘K 命令面板 */}
      {commandOpen && (
        <div
          className="fixed inset-0 z-[300] flex items-start justify-center pt-[16vh]"
          style={{ backgroundColor: 'color-mix(in oklab, var(--ink) 25%, transparent)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={() => setCommandOpen(false)}
        >
          <div
            className="w-[440px] overflow-hidden rounded-xl border"
            style={{ backgroundColor: 'var(--popover)', borderColor: 'var(--line)', boxShadow: '0 24px 64px rgba(0,0,0,0.28)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: 'var(--line)' }}>
              {/* 历史（撤销/重做）固定在搜索栏左侧，鼠标悬停高亮；不参与分组行与键盘导航 */}
              {historyCmds.map((cmd) => {
                const sel = historySel === cmd.id;
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    title={cmd.hint ? `${cmd.label} (${cmd.hint})` : cmd.label}
                    onClick={() => runPaletteCommand(cmd)}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHistorySel(cmd.id)}
                    onMouseLeave={() => setHistorySel(null)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
                    style={{
                      color: sel ? 'var(--primary)' : 'var(--ink-muted)',
                      backgroundColor: sel ? 'color-mix(in oklab, var(--primary) 10%, transparent)' : 'transparent',
                    }}
                  >
                    {commandGlyph(cmd.id)}
                  </button>
                );
              })}
              <span style={{ width: '1px', height: '16px', backgroundColor: 'var(--line)' }} />
              <Search className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
              <input
                autoFocus
                value={commandQuery}
                onChange={(e) => { setCommandQuery(e.target.value); setCommandIndex(0); }}
                onKeyDown={(e) => {
                  // 当前聚焦命令所在行（组）；-1 表示无可导航命令
                  const runIdx = commandIndex >= 0 ? groupRuns.findIndex((g) => commandIndex >= g.items[0].idx && commandIndex <= g.items[g.items.length - 1].idx) : -1;
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (groupRuns.length) {
                      const target = groupRuns[(runIdx + 1 + groupRuns.length) % groupRuns.length];
                      setCommandIndex(target.items[0].idx);
                    }
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (groupRuns.length) {
                      const target = groupRuns[(runIdx - 1 + groupRuns.length) % groupRuns.length];
                      setCommandIndex(target.items[0].idx);
                    }
                  } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    if (runIdx >= 0) {
                      const run = groupRuns[runIdx];
                      setCommandIndex((i) => Math.min(i + 1, run.items[run.items.length - 1].idx));
                    }
                  } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    if (runIdx >= 0) {
                      const run = groupRuns[runIdx];
                      setCommandIndex((i) => Math.max(i - 1, run.items[0].idx));
                    }
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const c = filteredCommands[commandIndex];
                    if (c) runPaletteCommand(c);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setCommandOpen(false);
                  }
                }}
                placeholder="Type a command or search…"
                className="flex-1 bg-transparent text-sm outline-none"
                style={{ color: 'var(--ink)' }}
              />
              <span className="shrink-0 text-10" style={{ color: 'var(--ink-faint)' }}>
                Esc
              </span>
            </div>
            <div className="max-h-[340px] overflow-y-auto ai-canvas-scroll py-1">
              {groupRuns.length === 0 ? (
                <div className="px-3 py-3 text-xs" style={{ color: 'var(--ink-faint)' }}>No matching commands</div>
              ) : (
                groupRuns.map((run, gi) => (
                  <div
                    key={run.group}
                    className="flex items-center gap-1 px-3 py-1.5"
                    style={{ borderTop: gi === 0 ? undefined : '1px solid var(--line)' }}
                  >
                    <span className="w-9 shrink-0 text-10 font-medium" style={{ color: 'var(--ink-faint)' }}>{run.group}</span>
                    <div className="flex min-w-0 flex-1 items-center gap-0.5">
                      {run.items.map(({ cmd, idx }) => {
                        const selected = idx === commandIndex;
                        return (
                          <button
                            key={cmd.id}
                            type="button"
                            title={cmd.hint ? `${cmd.label} (${cmd.hint})` : cmd.label}
                            onClick={() => runPaletteCommand(cmd)}
                            onMouseDown={(e) => e.preventDefault()}
                            onMouseEnter={() => setCommandIndex(idx)}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
                            style={{
                              color: selected ? 'var(--primary)' : 'var(--ink-muted)',
                              backgroundColor: selected ? 'color-mix(in oklab, var(--primary) 10%, transparent)' : 'transparent',
                            }}
                          >
                            {commandGlyph(cmd.id)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 块级拖拽把手（仅可编辑态）：hover 块首显示，按住拖拽可排序段落/列表项/图片/表格/嵌入卡片等块 */}
      {editable && editor && (
        <DragHandle
          editor={editor}
          nested={{ edgeDetection: 'left', allowedContainers: ['bulletList', 'orderedList', 'taskList'] }}
          className="doc-drag-handle"
        >
          <GripVertical />
        </DragHandle>
      )}
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
          z-index: 20;
        }
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
          display: flex;
          align-items: stretch;
          gap: 12px;
        }
        .bob-columns-body > [data-bob-column] {
          flex: 1 1 0;
          min-width: 0;
          border: 1px solid var(--line);
          border-radius: 8px;
          padding: 6px 10px;
          background: color-mix(in oklab, var(--paper-soft) 45%, transparent);
        }
        .bob-columns-body > [data-bob-column] > p:first-child {
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

/** ⌘K 横排命令按钮图标：命令 id → lucide 图标（与工具栏同款，便于横排识别）
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
    case 'paragraph': return <Pilcrow className="h-4 w-4" />;
    case 'bullet': return <List className="h-4 w-4" />;
    case 'ordered': return <ListOrdered className="h-4 w-4" />;
    case 'task': return <CheckSquare className="h-4 w-4" />;
    case 'quote': return <Quote className="h-4 w-4" />;
    case 'codeblock': return <Code2 className="h-4 w-4" />;
    case 'hr': return <Minus className="h-4 w-4" />;
    case 'link': return <LinkIcon className="h-4 w-4" />;
    case 'image': return <ImageIcon className="h-4 w-4" />;
    case 'footnote': return <Hash className="h-4 w-4" />;
    case 'table': return <TableIcon className="h-4 w-4" />;
    case 'columns2': return <Columns2 className="h-4 w-4" />;
    case 'columns3': return <Columns3 className="h-4 w-4" />;
    case 'undo': return <Undo className="h-4 w-4" />;
    case 'redo': return <Redo className="h-4 w-4" />;
    case 'format': return <Wand2 className="h-4 w-4" />;
    case 'annotations': return <MessageSquare className="h-4 w-4" />;
    case 'toc': return <ListTree className="h-4 w-4" />;
    case 'docx': return <FileDown className="h-4 w-4" />;
    case 'print': return <Printer className="h-4 w-4" />;
    case 'new-doc': return <FilePlus className="h-4 w-4" />;
    case 'insert-doc': return <FileText className="h-4 w-4" />;
    case 'share': return <Share2 className="h-4 w-4" />;
    default: return null;
  }
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

interface DropdownItemProps {
  active?: boolean;
  onClick: () => void;
  label: string;
  shortcut?: React.ReactNode;
}

function DropdownItem({ active, onClick, label, shortcut }: DropdownItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      className="flex w-full items-center justify-between gap-4 px-2.5 py-1 text-left text-xs transition-colors"
      style={{
        color: active ? 'var(--primary)' : 'var(--ink)',
        backgroundColor: active ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.backgroundColor = 'color-mix(in oklab, var(--ink) 5%, transparent)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.backgroundColor = 'transparent';
      }}
    >
      <span>{label}</span>
      {shortcut && <span style={{ color: 'var(--ink-muted)' }}>{shortcut}</span>}
    </button>
  );
}
