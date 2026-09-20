'use client';

/**
 * useComposer —— chat / team 输入框共用的「附件 + @ 引用」能力内核。
 *
 * 从 ChatNodeKernel 的内联实现中抽出，使 Team 输入框与 chat 输入框具备完全一致的能力：
 *   ① 本地文件选择器上传（文件真实复制到 <项目>/materials/<短id_标题>/）
 *   ② 拖拽文件到输入区
 *   ③ 粘贴（图片＝截图 → attachments/；其他文件 → materials/ 附件上传；
 *      纯 URL → 链接材料；本地绝对路径 → @文件名 引用 chip；普通文本 → 原样插入）
 *   ④ @ 弹窗引用（materials 资料文件夹 + 已授权目录，支持多级浏览）
 *
 * 宿主提供一个 contentEditable 输入框（inputRef）+ 受控纯文本（text / setText 由宿主自持，
 * 以便宿主在别处复用同一份文本，如 chat 的草稿持久化、⌘F 注入、OCR 注入），
 * 其余状态、DOM chip 渲染、@ 检测与键盘导航全部由本 hook 承担。
 *
 * 请求组装：调用 buildContextBlocks() 得到「--- 资料列表 --- / --- 引用本地文件 --- /
 * --- 链接材料 --- / --- 操作目录 ---」文本块；或读取 composerContext 拿到结构化快照
 * （Team 发起时经 onLaunch 透传给宿主节点，由节点在 doSend 时并入本轮请求）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AttachmentStore, MessageAttachment } from '@/lib/types';

/** 单个 URL（http/https/ftp 开头、无空白） */
export const URL_ONLY_RE = /^(https?:\/\/|ftp:\/\/)[^\s/$.?#][^\s]*$/i;

/** 人类可读文件大小（B / KB / MB） */
export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** materials 资料条目（@ 引用的资料清单） */
export interface MaterialItem {
  id: string;
  name: string;
  /** 相对项目根路径：materials/<...> */
  path: string;
  size: number;
  extension: string;
  type: string;
  uploadedAt: string;
}

/** @ 目录模式下的条目（授权目录 / materials 子目录中的文件或目录） */
export interface DirMentionItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: string;
  sizeBytes?: number;
  extension?: string;
}

/** 待发送链接材料（粘贴 URL 自动识别） */
export interface ComposerLink {
  url: string;
}

/** @ 引用的本地文件（授权目录或粘贴的绝对路径） */
export interface ComposerDirRef {
  name: string;
  path: string;
  size?: string;
}

/** 一轮请求的引用上下文快照（附件 / 资料 / 本地文件 / 链接 / 操作目录） */
export interface ComposerContext {
  attachments: MessageAttachment[];
  materials: MaterialItem[];
  dirRefs: ComposerDirRef[];
  links: ComposerLink[];
  folders: MessageAttachment[];
}

export function emptyComposerContext(): ComposerContext {
  return { attachments: [], materials: [], dirRefs: [], links: [], folders: [] };
}

/** File → base64（不含 data: 前缀） */
function fileToBase64(file: File): Promise<string> {
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

/**
 * 上传单个文件：用 base64 + JSON（规避 Turbopack FormData bug）。
 * 服务端把文件真实复制到 <项目>/materials/<短id_标题>/，回传附件元数据。
 * `store: 'attachments'` 时改落 <项目>/attachments/<短id_标题>/（对话级临时附件，
 * 如粘贴的截图：不进项目资料 manifest、不参与 search_materials 检索）。
 */
export async function uploadAttachment(
  nodeId: string,
  nodeTitle: string,
  file: File,
  store: AttachmentStore = 'materials',
): Promise<MessageAttachment | null> {
  const base64 = await fileToBase64(file);
  const resp: Response = await fetch('/api/attachments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodeId,
      nodeTitle,
      fileName: file.name,
      fileType: file.type || 'application/octet-stream',
      store,
      data: base64,
    }),
  });
  const respData = await resp.json();
  if (respData.success && respData.attachment) return respData.attachment as MessageAttachment;
  console.error('上传附件失败:', file.name, respData.error);
  return null;
}

export interface UseComposerOptions {
  /** 附件落盘的目标节点 id（决定 materials 子目录名）；为空时上传不可用 */
  nodeId: string | null;
  /** 节点标题（参与 materials 子目录命名） */
  nodeTitle?: string;
  /** 执行中：禁用粘贴文件 / 拖拽 / 上传（输入框本身不锁） */
  disabled?: boolean;
  /** contentEditable 输入框元素；chip 渲染与 @ 检测挂在它上面 */
  inputRef: React.RefObject<HTMLDivElement | null>;
  /** 输入框纯文本镜像（受控，由宿主自持） */
  text: string;
  setText: (next: string) => void;
  /** IME 合成状态 ref（宿主与键盘处理器共享；合成中跳过 DOM 重建，避免打断中文输入） */
  composingRef: React.MutableRefObject<boolean>;
}

/** 资料列表条目（已上传附件与 @ 引用资料统一形态） */
interface MaterialLine {
  name: string;
  path: string;
  size: number;
  kind: string;
}

function renderMaterialBlock(lines: MaterialLine[]): string {
  if (lines.length === 0) return '';
  const materialInfo = lines
    .map((l, i) => `  ${i + 1}. ${l.name} (${l.kind}, ${formatFileSize(l.size)})\n     路径: ${l.path}`)
    .join('\n');
  return `\n\n--- 资料列表 ---\n${materialInfo}\n--- 资料列表结束 ---\n\n如需了解资料内容，请使用 read_attachment 工具读取（路径已在列表中给出，勿向用户索要）。`;
}

/** 已上传附件（不含 folder 型，folder 走操作目录块）→ 资料列表条目 */
function attachmentMaterialLines(attachments: MessageAttachment[]): MaterialLine[] {
  return attachments
    .filter((a) => a.type !== 'folder')
    .map((a) => ({
      name: a.name,
      path: a.path,
      size: a.size,
      kind: a.type === 'text' ? 'Text' : a.type === 'image' ? 'Image' : 'File',
    }));
}

function materialItemLines(materials: MaterialItem[]): MaterialLine[] {
  return materials.map((m) => ({ name: m.name, path: m.path, size: m.size, kind: m.type }));
}

/** 附件上下文四种文本块的固定开头（供宿主按需拼接顺序） */
export function buildMaterialBlock(materials: MaterialItem[]): string {
  return renderMaterialBlock(materialItemLines(materials));
}

export function buildDirRefBlock(dirRefs: ComposerDirRef[]): string {
  if (dirRefs.length === 0) return '';
  const dirInfo = dirRefs
    .map((ref, i) => `  ${i + 1}. ${ref.name}${ref.size ? ` (${ref.size})` : ''}\n     路径: ${ref.path}`)
    .join('\n');
  return `\n\n--- 引用本地文件 ---\n${dirInfo}\n以上为本地文件引用（来源：@ 引用或用户粘贴路径）。如需了解文件内容，请使用 read_file 工具读取完整绝对路径；若目录未授权，请先按 AUTH_REQ 流程请求授权。`;
}

export function buildLinkBlock(links: ComposerLink[]): string {
  if (links.length === 0) return '';
  const linkInfo = links.map((l, i) => `  ${i + 1}. ${l.url}`).join('\n');
  return `\n\n--- 链接材料 ---\n${linkInfo}\n请使用 web_fetch 工具依次访问以上链接获取网页内容，并结合链接内容回答用户问题。`;
}

export function buildFolderBlock(folders: MessageAttachment[]): string {
  if (folders.length === 0) return '';
  // 用户从文件面板一键发送的子文件夹 = 锁定操作范围
  const hasUserLocked = folders.some((f) => f.id.startsWith('sent-folder:'));
  const folderInfo = folders
    .map((folder) => {
      const isUserLocked = folder.id.startsWith('sent-folder:');
      return `- ${folder.name}${isUserLocked ? '（用户指定·锁定操作范围）' : ''}\n  路径: ${folder.path}`;
    })
    .join('\n');
  return (
    `\n\n--- 操作目录 ---\n${folderInfo}\n` +
    (hasUserLocked
      ? '以上目录中带「用户指定·锁定操作范围」标记的目录，是用户指定的本次操作范围：请将文件读写操作严格集中在该目录内（使用完整绝对路径），不得越出该目录；其余目录为默认授权目录。\n'
      : '以上目录已授权给 AI，可读可写。请使用 list_directory / read_file / write_file 等文件工具在该目录内完成用户要求的操作（路径使用完整绝对路径）。\n') +
    '--- 操作目录结束 ---'
  );
}

/** 附件四类引用块按固定顺序拼接（与 chat 既有口径一致）；已上传附件与 @ 资料合并为同一个小节 */
export function buildContextBlocks(ctx: ComposerContext): string {
  return (
    renderMaterialBlock([...attachmentMaterialLines(ctx.attachments), ...materialItemLines(ctx.materials)]) +
    buildDirRefBlock(ctx.dirRefs) +
    buildLinkBlock(ctx.links) +
    buildFolderBlock(ctx.folders)
  );
}

/**
 * 附件 + @ 引用能力内核。返回的 setter/handler 可直接挂到宿主的输入区 JSX 上。
 */
export function useComposer(opts: UseComposerOptions) {
  const { nodeId, nodeTitle = '', disabled = false, inputRef, text, setText, composingRef } = opts;

  // ==== 待发送附件 / 链接 / 操作目录 ====
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const [pendingLinks, setPendingLinks] = useState<ComposerLink[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /** 操作目录（授权目录发送到节点后显示在输入框下方工具栏） */
  const [contextFolders, setContextFolders] = useState<MessageAttachment[]>([]);
  /** 已授权文件夹（全局授权：AI 可读写这些目录） */
  const [authorizedRoots, setAuthorizedRoots] = useState<string[]>([]);

  // ==== @ 引用集合 ====
  const [pendingMaterials, setPendingMaterials] = useState<MaterialItem[]>([]);
  const [pendingMaterialPaths, setPendingMaterialPaths] = useState<Set<string>>(new Set());
  const [pendingDirRefs, setPendingDirRefs] = useState<ComposerDirRef[]>([]);
  const [pendingDirRefPaths, setPendingDirRefPaths] = useState<Set<string>>(new Set());

  // ==== @ 弹窗状态 ====
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionAtPos, setMentionAtPos] = useState(-1);
  const mentionRef = useRef<HTMLDivElement>(null);
  /** @ 弹窗目录导航状态（null = 显示入口列表；非 null = 浏览目录/子目录）
   *  source: 'auth' = 授权目录 / 'materials' = materials 文件夹（多级子目录浏览） */
  const [mentionDir, setMentionDir] = useState<{ root: string; path: string; source: 'auth' | 'materials' } | null>(null);
  const [mentionDirItems, setMentionDirItems] = useState<DirMentionItem[]>([]);
  const [mentionDirLoading, setMentionDirLoading] = useState(false);
  /** materials 目录树缓存（一次拉取，前端按路径过滤实现多级浏览） */
  const materialTreeRef = useRef<unknown[] | null>(null);

  /** 获取 contentEditable 内光标偏移（字符数） */
  const getCursorOffset = useCallback((el: HTMLElement): number => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return el.textContent?.length ?? 0;
    const range = sel.getRangeAt(0).cloneRange();
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.endContainer, range.endOffset);
    return pre.toString().length;
  }, []);

  // ==== 附件添加入口 ====

  /** 上传待发附件（入口①②③ 共用）。opts.store 指定落盘根目录，缺省 materials/ */
  const handleFileSelect = useCallback(
    async (files: FileList | null, opts?: { store?: AttachmentStore }) => {
      if (!files || files.length === 0 || !nodeId) return;
      const fileArray = Array.from(files);
      setUploadingAttachment(true);
      for (const file of fileArray) {
        try {
          const att = await uploadAttachment(nodeId, nodeTitle, file, opts?.store ?? 'materials');
          if (att) setPendingAttachments((prev) => [...prev, att]);
        } catch (e) {
          if (e instanceof DOMException && e.name === 'NotReadableError') {
            console.warn(`附件无法读取（文件可能已被移动或删除）: ${file.name}`);
          } else {
            console.error('上传附件失败:', file.name, e);
          }
        }
      }
      setUploadingAttachment(false);
    },
    [nodeId, nodeTitle],
  );

  /** 外部追加附件（划词「作为附件」/ 文件面板「添加到节点」通道）：folder 型自动分流到操作目录 */
  const addAttachments = useCallback((atts: MessageAttachment[]) => {
    const files = atts.filter((a) => a.type !== 'folder');
    const folders = atts.filter((a) => a.type === 'folder');
    if (files.length > 0) setPendingAttachments((prev) => [...prev, ...files]);
    if (folders.length > 0) {
      setContextFolders((prev) => {
        const seen = new Set(prev.map((f) => f.id));
        return [...prev, ...folders.filter((f) => !seen.has(f.id))];
      });
    }
  }, []);

  const removePendingAttachment = useCallback((attId: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== attId));
  }, []);

  const removePendingLink = useCallback((url: string) => {
    setPendingLinks((prev) => prev.filter((l) => l.url !== url));
  }, []);

  /** 移除操作目录（工具栏中的授权目录） */
  const removeContextFolder = useCallback((attId: string) => {
    setContextFolders((prev) => prev.filter((f) => f.id !== attId));
  }, []);

  /** 拖拽进入 */
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) setDragOver(true);
    },
    [disabled],
  );

  /** 拖拽离开 */
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  /** 拖拽放下 */
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (disabled) return;
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) void handleFileSelect(files);
    },
    [disabled, handleFileSelect],
  );

  /** 粘贴：文件 / URL / 本地绝对路径 / 普通文本 四分支 */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (disabled) return;
      const items = e.clipboardData?.items;

      // 1) 文件粘贴：作为附件上传。
      //    整批都是图片（＝剪贴板截图）时落 attachments/：截图是对话级临时素材，
      //    不该进项目账本的材料层（materials/ 会被材料索引收录、参与 search_materials 检索）。
      //    粘贴复制的文件（如 Finder 拷来的 PDF）仍按资料处理，走 materials/。
      if (items) {
        const files: File[] = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) files.push(file);
          }
        }
        if (files.length > 0) {
          e.preventDefault();
          const dt = new DataTransfer();
          files.forEach((f) => dt.items.add(f));
          const allImages = files.every((f) => f.type.startsWith('image/'));
          void handleFileSelect(dt.files, allImages ? { store: 'attachments' } : undefined);
          return;
        }
      }

      // 2) 粘贴单个 URL：自动识别为链接材料（类似附件胶囊），发送时 AI 用 web_fetch 访问
      let plain = e.clipboardData?.getData('text/plain')?.trim() ?? '';
      // 引号包裹的文本先剥掉首尾配对引号再识别（find 拖文件到终端复制的路径常带引号）
      const quoted = plain.match(/^(['"])(.*)\1$/);
      if (quoted) plain = quoted[2].trim();
      if (plain && URL_ONLY_RE.test(plain)) {
        e.preventDefault();
        setPendingLinks((prev) => (prev.some((l) => l.url === plain) ? prev : [...prev, { url: plain }]));
        return;
      }

      // 3) 粘贴本地绝对路径：转为输入框内文件引用 chip（@文件名），
      //    发送时经 pendingDirRefs 注入 AI 上下文，AI 用 read_file 读取完整绝对路径；
      //    未授权目录的路径在 AI 请求授权时，因用户消息中明确出现过该路径而自动放行（AUTH_REQ 安全护栏）
      if (plain) {
        const pathTokens = plain.split(/[\s，,；;]+/).filter((t) => {
          if (t.length === 0 || t.includes('://')) return false; // 排除 URL
          return /^(\/|~\/|~)(?!\/+$).+\S$/.test(t); // 绝对路径（/ 或 ~ 开头，非纯斜杠）
        });
        if (pathTokens.length > 0) {
          e.preventDefault();
          let newText = plain;
          for (const p of [...new Set(pathTokens)]) {
            const name = p.replace(/\/+$/, '').split('/').pop() ?? p;
            // 登记文件引用（函数式更新去重，避免闭包 stale）
            setPendingDirRefs((prev) => (prev.some((r) => r.path === p) ? prev : [...prev, { name, path: p }]));
            setPendingDirRefPaths((prev) => new Set(prev).add(p));
            // 文本中把路径替换为 @文件名 标记（镜像 effect 按 text 重建 DOM 并渲染 chip）
            const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            newText = newText.replace(new RegExp(escaped, 'g'), `@${name}`);
          }
          // 光标处插入替换后的文本；DOM 由镜像 effect 重建（与 @ mention 一致，光标落到末尾）
          const el = inputRef.current;
          const current = el?.textContent ?? '';
          const offset = el ? getCursorOffset(el) : current.length;
          setText(current.slice(0, offset) + newText + current.slice(offset));
          return;
        }
      }

      // 4) 普通文本：contentEditable 需要按纯文本插入（阻止浏览器粘贴富文本 HTML 节点），
      //    onInput 会自动同步镜像 → 重建 DOM，光标由浏览器保持
      const plainText = e.clipboardData?.getData('text/plain') ?? '';
      if (plainText) {
        e.preventDefault();
        document.execCommand('insertText', false, plainText);
      }
    },
    [disabled, handleFileSelect, getCursorOffset, inputRef, setText],
  );

  // ==== @ 引用数据源 ====

  /** 加载 materials 目录树（一次性缓存，供多级子目录浏览） */
  const loadMaterialTree = useCallback(async (): Promise<unknown[]> => {
    if (materialTreeRef.current) return materialTreeRef.current;
    try {
      const resp = await fetch('/api/materials?action=list');
      const data = await resp.json();
      materialTreeRef.current = data.success && Array.isArray(data.tree) ? data.tree : [];
    } catch {
      materialTreeRef.current = [];
    }
    return materialTreeRef.current ?? [];
  }, []);

  /** 按相对路径（'' = 根）列出 materials 目录内容（子目录 + 文件），支持多级嵌套 */
  const listMaterialDir = useCallback(
    async (relPath: string): Promise<DirMentionItem[]> => {
      const tree = await loadMaterialTree();
      const segs = relPath ? relPath.split('/') : [];
      const findNode = (nodes: unknown[], pathSegs: string[]): unknown[] | null => {
        if (pathSegs.length === 0) return nodes || [];
        const [head, ...rest] = pathSegs;
        const child = (nodes || []).find(
          (n) => (n as { type?: string; name?: string }).type === 'directory' && (n as { name?: string }).name === head,
        ) as { children?: unknown[] } | undefined;
        if (!child) return null;
        return findNode(child.children || [], rest);
      };
      const nodes = findNode(tree, segs) as Array<{ name: string; path?: string; type?: string; size?: number; extension?: string }> | null;
      if (!nodes) return [];
      return nodes.map((n) => ({
        name: n.name,
        path: n.path ?? '',
        type: n.type === 'directory' ? 'directory' : 'file',
        size: n.size != null ? String(n.size) : undefined,
        extension: n.extension,
      }));
    },
    [loadMaterialTree],
  );

  /** 进入 materials 目录浏览（从根开始） */
  const enterMentionMaterials = useCallback(() => {
    // 打开 materials 浏览时强制重新拉取目录树：材料列表以文件系统为准，
    // 否则已打开节点会一直显示首次缓存的旧材料（新建节点才可见）
    materialTreeRef.current = null;
    setMentionDir({ root: '__materials__', path: '', source: 'materials' });
    setMentionQuery('');
    setMentionIndex(0);
    setMentionDirLoading(true);
    listMaterialDir('').then((items) => {
      setMentionDirItems(items);
      setMentionDirLoading(false);
    });
  }, [listMaterialDir]);

  /** 关闭 mention 弹窗 */
  const closeMention = useCallback(() => {
    setMentionOpen(false);
    setMentionQuery('');
    setMentionAtPos(-1);
    setMentionIndex(0);
  }, []);

  /** 点击 mention 弹窗外部 / Esc → 关闭弹窗 */
  useEffect(() => {
    if (!mentionOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (mentionRef.current?.contains(t)) return;
      // 兼容旧标记：弹窗容器带 data-mention-popup 时同样视为「在弹窗内」
      if (t.closest('[data-mention-popup]')) return;
      // 输入框内点击不关窗（继续输入 @ 查询词）
      if (inputRef.current?.contains(t)) return;
      if (t.closest('[data-chat-input]')) return;
      closeMention();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMention();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [mentionOpen, closeMention, inputRef]);

  /** 加载目录内容（授权目录/子目录文件列表） */
  const loadDirItems = useCallback(async (dir: string) => {
    setMentionDirLoading(true);
    try {
      const resp = await fetch(`/api/local-files?path=${encodeURIComponent(dir)}`);
      const data = await resp.json();
      setMentionDirItems(data.success && Array.isArray(data.items) ? (data.items as DirMentionItem[]) : []);
    } catch {
      setMentionDirItems([]);
    } finally {
      setMentionDirLoading(false);
    }
  }, []);

  /** 打开 @ 入口列表（Materials 文件夹 + 授权目录们） */
  const openDirMode = useCallback(() => {
    setMentionDir(null);
    setMentionDirItems([]);
    setMentionIndex(0);
  }, []);

  /** 进入授权目录/子目录浏览（source 由入口来源决定：授权目录 or materials） */
  const enterDir = useCallback(
    (item: DirMentionItem) => {
      if (item.type !== 'directory') return;
      if (!mentionDir) {
        // 从入口列表进入：materials 根（固定标记）或授权目录（完整路径）
        const source: 'auth' | 'materials' = item.path === '__materials__' ? 'materials' : 'auth';
        setMentionDir({ root: item.path, path: '', source });
        setMentionQuery('');
        setMentionIndex(0);
        if (source === 'materials') {
          // 从入口列表进入 materials：同样强制刷新（与 enterMentionMaterials 一致），
          // 保证本节点打开期间新增/删除的材料可见
          materialTreeRef.current = null;
          setMentionDirLoading(true);
          listMaterialDir('').then((items) => {
            setMentionDirItems(items);
            setMentionDirLoading(false);
          });
        } else {
          void loadDirItems(item.path);
        }
      } else {
        // 进入子目录
        const sub = mentionDir.path ? `${mentionDir.path}/${item.name}` : item.name;
        setMentionDir({ ...mentionDir, path: sub });
        setMentionQuery('');
        setMentionIndex(0);
        if (mentionDir.source === 'materials') {
          setMentionDirLoading(true);
          listMaterialDir(sub).then((items) => {
            setMentionDirItems(items);
            setMentionDirLoading(false);
          });
        } else {
          void loadDirItems(`${mentionDir.root}/${sub}`);
        }
      }
    },
    [mentionDir, loadDirItems, listMaterialDir],
  );

  /** 返回上级（或回到入口列表） */
  const goBackDir = useCallback(() => {
    setMentionQuery('');
    setMentionIndex(0);
    if (!mentionDir) {
      // 入口列表无可返回 → 关闭弹窗
      closeMention();
      return;
    }
    if (!mentionDir.path) {
      // 已回到根 → 返回入口列表（授权目录存在时显示；否则关闭）
      if (authorizedRoots.length > 0) {
        setMentionDir(null);
        setMentionDirItems([]);
      } else {
        closeMention();
      }
      return;
    }
    const parentPath = mentionDir.path.split('/').slice(0, -1).join('/');
    const loadParent = (relOrFull: string) => {
      if (mentionDir.source === 'materials') {
        setMentionDirLoading(true);
        listMaterialDir(relOrFull).then((items) => {
          setMentionDirItems(items);
          setMentionDirLoading(false);
        });
      } else {
        void loadDirItems(relOrFull);
      }
    };
    if (!parentPath) {
      setMentionDir({ ...mentionDir, path: '' });
      loadParent(mentionDir.source === 'materials' ? '' : mentionDir.root);
    } else {
      setMentionDir({ ...mentionDir, path: parentPath });
      loadParent(mentionDir.source === 'materials' ? parentPath : `${mentionDir.root}/${parentPath}`);
    }
  }, [mentionDir, loadDirItems, closeMention, listMaterialDir, authorizedRoots.length]);

  // ---- 已授权文件夹（全局授权：AI 可读写） ----
  const loadAuthorizedRoots = useCallback(async () => {
    try {
      const resp = await fetch('/api/local-files?action=roots');
      const data = await resp.json();
      if (data.success) {
        const roots = (data.roots || []) as string[];
        setAuthorizedRoots(roots);
        // 联动：撤销授权后，输入框下方工具栏中已不再授权的操作目录一并移除
        setContextFolders((prev) => prev.filter((f) => roots.includes(f.path)));
      }
    } catch {
      /* ignore */
    }
  }, []);

  /** 断开授权（保留浏览） */
  const revokeRootAuth = useCallback(async (root: string) => {
    try {
      const resp = await fetch(`/api/local-files?action=revoke_root&path=${encodeURIComponent(root)}`);
      const data = await resp.json();
      if (data.success) {
        setAuthorizedRoots(data.roots || []);
        window.dispatchEvent(new CustomEvent('local-roots-changed'));
      }
    } catch {
      /* ignore */
    }
  }, []);

  // 加载授权列表，并监听侧栏授权变化（local-roots-changed 事件）
  useEffect(() => {
    void loadAuthorizedRoots();
    const handler = () => void loadAuthorizedRoots();
    window.addEventListener('local-roots-changed', handler);
    return () => window.removeEventListener('local-roots-changed', handler);
  }, [loadAuthorizedRoots]);

  // ==== 输入框 DOM：文本镜像 → chip 渲染 + @ 检测 ====

  /** 创建 @文件引用 chip（contentEditable=false 整块删除，含 × 移除按钮） */
  const createFileChip = useCallback(
    (path: string, label: string, onRemove: (path: string) => void): HTMLSpanElement => {
      const span = document.createElement('span');
      span.dataset.filePath = path;
      span.contentEditable = 'false';
      span.setAttribute('class', 'node-file-chip');
      const labelEl = document.createElement('span');
      labelEl.textContent = label;
      const del = document.createElement('button');
      del.type = 'button';
      // 叉号由 CSS 伪元素绘制（.node-file-chip button::after），不能写进 textContent：
      // handleInput / removeRef 都是读 el.textContent 取正文，按钮文字会混进发送内容。
      del.setAttribute('aria-label', 'Remove file reference');
      del.title = 'Remove file reference';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        span.remove();
        onRemove(path);
      });
      span.appendChild(labelEl);
      span.appendChild(del);
      return span;
    },
    [],
  );

  /** 文本镜像 → DOM：把 @文件名 标记文本渲染为高亮 chip；其余按纯文本重建 */
  const renderPromptToDom = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    // 引用候选：materials + 授权目录文件（长标签优先，避免短文件名误匹配）
    const refs: Array<{ label: string; path: string }> = [
      ...pendingMaterials.map((m) => ({ label: `@${m.name}`, path: m.path })),
      ...pendingDirRefs.map((r) => ({ label: `@${r.name}`, path: r.path })),
    ].sort((a, b) => b.label.length - a.label.length);
    const removeRef = (path: string) => {
      setPendingMaterials((prev) => prev.filter((m) => m.path !== path));
      setPendingMaterialPaths((prev) => {
        const s = new Set(prev);
        s.delete(path);
        return s;
      });
      setPendingDirRefs((prev) => prev.filter((r) => r.path !== path));
      setPendingDirRefPaths((prev) => {
        const s = new Set(prev);
        s.delete(path);
        return s;
      });
      setText(inputRef.current?.textContent ?? '');
    };
    el.innerHTML = '';
    let rest = text;
    while (rest.length > 0) {
      let matched: { label: string; path: string } | null = null;
      let matchIdx = -1;
      for (const c of refs) {
        const idx = rest.indexOf(c.label);
        if (idx !== -1 && (matchIdx === -1 || idx < matchIdx)) {
          matched = c;
          matchIdx = idx;
        }
      }
      if (!matched) break;
      if (matchIdx > 0) el.appendChild(document.createTextNode(rest.slice(0, matchIdx)));
      el.appendChild(createFileChip(matched.path, matched.label, removeRef));
      rest = rest.slice(matchIdx + matched.label.length);
    }
    if (rest.length > 0) el.appendChild(document.createTextNode(rest));
    // 光标移到末尾
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, [inputRef, text, pendingMaterials, pendingDirRefs, createFileChip, setText]);

  // 镜像 effect：text 变化 → 重建 DOM（IME 组合中跳过，避免打断中文输入）
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (composingRef.current) return;
    if ((el.textContent ?? '') !== text) {
      renderPromptToDom();
    }
  }, [text, renderPromptToDom, inputRef, composingRef]);

  /** contentEditable onInput：同步文本镜像 + 键盘删除 chip 同步引用 + @ 检测 */
  const handleInput = useCallback(
    (e: React.FormEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const newText = el.textContent ?? '';
      setText(newText);
      // 键盘（Backspace/Delete）删掉 chip → DOM 中消失 → 同步从引用集合移除
      const chipPaths = new Set<string>();
      el.querySelectorAll<HTMLSpanElement>('span[data-file-path]').forEach((s) => {
        const p = s.dataset.filePath;
        if (p) chipPaths.add(p);
      });
      setPendingMaterials((prev) => prev.filter((m) => chipPaths.has(m.path)));
      setPendingMaterialPaths((prev) => {
        const s = new Set(prev);
        for (const p of [...s]) if (!chipPaths.has(p)) s.delete(p);
        return s;
      });
      setPendingDirRefs((prev) => prev.filter((r) => chipPaths.has(r.path)));
      setPendingDirRefPaths((prev) => {
        const s = new Set(prev);
        for (const p of [...s]) if (!chipPaths.has(p)) s.delete(p);
        return s;
      });
      // @ mention 检测（不要求前导空格）
      const cursorPos = getCursorOffset(el);
      const textBeforeCursor = newText.slice(0, cursorPos);
      const atMatch = textBeforeCursor.match(/@([^\s@]*)$/);
      if (atMatch) {
        const query = atMatch[1];
        setMentionAtPos(cursorPos - query.length - 1);
        setMentionQuery(query);
        setMentionOpen(true);
        setMentionIndex(0);
        // 仅新触发时初始化数据源（连续输入/弹窗内导航不重置）：有授权目录 → 入口列表；无 → materials 浏览
        if (!mentionOpen) {
          if (authorizedRoots.length > 0) openDirMode();
          else enterMentionMaterials();
        }
      } else if (mentionOpen) {
        closeMention();
      }
    },
    [getCursorOffset, setText, authorizedRoots.length, mentionOpen, openDirMode, enterMentionMaterials, closeMention],
  );

  /** 选择 @ 引用的文件（materials 材料或授权目录中的文件），目录项则进入浏览 */
  const handleMentionSelect = useCallback(
    (file: MaterialItem | DirMentionItem) => {
      // 目录：进入浏览（不关闭弹窗，保留 @ 状态）
      if (file.type === 'directory') {
        enterDir(file as DirMentionItem);
        return;
      }
      // 1) 引用登记（发送时作为操作对象注入 AI 上下文）
      if (mentionDir?.source === 'materials') {
        // materials 资料 → read_attachment 语义（路径为相对项目根的 materials/xxx）
        const dir = file as DirMentionItem;
        const mat: MaterialItem = {
          id: `mat-${dir.path}`,
          name: dir.name,
          path: `materials/${dir.path}`,
          size: typeof dir.sizeBytes === 'number' ? dir.sizeBytes : Number(dir.size) || 0,
          extension: dir.extension ?? '',
          type: dir.extension ? dir.extension.replace('.', '') : 'file',
          uploadedAt: '',
        };
        if (!pendingMaterialPaths.has(mat.path)) {
          setPendingMaterials((prev) => [...prev, mat]);
          setPendingMaterialPaths((prev) => new Set(prev).add(mat.path));
        }
      } else {
        const dir = file as DirMentionItem;
        if (!pendingDirRefPaths.has(dir.path)) {
          setPendingDirRefs((prev) => [...prev, { name: dir.name, path: dir.path, size: dir.size }]);
          setPendingDirRefPaths((prev) => new Set(prev).add(dir.path));
        }
      }
      // 2) 输入框：@ 触发 → 原位替换查询词；图标触发（mentionAtPos < 0）→ 末尾追加 @文件名
      //    镜像文本含 @文件名 标记，DOM 由镜像 effect 渲染为高亮 chip
      const el = inputRef.current;
      if (el) {
        if (mentionAtPos >= 0) {
          const domText = el.textContent ?? '';
          const beforeAt = domText.slice(0, mentionAtPos);
          const afterQuery = domText.slice(mentionAtPos + 1 + mentionQuery.length);
          setText(`${beforeAt}@${file.name}${afterQuery}`);
        } else {
          const cur = text ?? '';
          const sep = cur.length > 0 && !cur.endsWith(' ') && !cur.endsWith('\n') ? ' ' : '';
          setText(`${cur}${sep}@${file.name} `);
        }
      }
      closeMention();
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [
      mentionAtPos,
      mentionQuery,
      text,
      mentionDir,
      pendingMaterialPaths,
      pendingDirRefPaths,
      closeMention,
      enterDir,
      inputRef,
      setText,
    ],
  );

  /** 工具行 @ 图标触发：打开入口列表（mentionAtPos = -1 → 选中后追加到末尾） */
  const openMentionFromIcon = useCallback(() => {
    setMentionAtPos(-1);
    setMentionOpen(true);
    enterMentionMaterials();
  }, [enterMentionMaterials]);

  /** @ 弹窗打开时的键盘导航；返回 true 表示事件已消费（宿主不应再处理） */
  const handleMentionKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): boolean => {
      if (!mentionOpen) return false;
      // 数据源：进入浏览后按当前目录内容过滤；未进入 → 入口列表（Materials + 授权目录）按名称过滤
      const filtered: DirMentionItem[] = mentionDir
        ? mentionDirItems.filter((i) => i.name.toLowerCase().includes(mentionQuery.toLowerCase()))
        : authorizedRoots.length > 0
          ? [
              { name: 'Materials', path: '__materials__', type: 'directory' as const },
              ...authorizedRoots.map((r) => ({
                name: r.split('/').filter(Boolean).pop() || r,
                path: r,
                type: 'directory' as const,
              })),
            ].filter((i) => i.name.toLowerCase().includes(mentionQuery.toLowerCase()))
          : [];
      if (filtered.length === 0) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeMention();
          return true;
        }
        return false;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((prev) => Math.min(prev + 1, filtered.length - 1));
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((prev) => Math.max(prev - 1, 0));
        return true;
      }
      // 输入法合成状态（中文候选/英文确认）按 Enter 不触发选择
      if (
        e.key === 'Enter' &&
        !(composingRef.current || (e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229)
      ) {
        e.preventDefault();
        const target = filtered[mentionIndex];
        if (target) handleMentionSelect(target);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMention();
        return true;
      }
      return false;
    },
    [mentionOpen, mentionDir, mentionDirItems, mentionQuery, authorizedRoots, mentionIndex, closeMention, handleMentionSelect, composingRef],
  );

  // ==== 请求组装 / 清空 ====

  /** 本轮引用上下文结构化快照 */
  const composerContext = useMemo<ComposerContext>(
    () => ({
      attachments: [...pendingAttachments],
      materials: [...pendingMaterials],
      dirRefs: [...pendingDirRefs],
      links: [...pendingLinks],
      folders: [...contextFolders],
    }),
    [pendingAttachments, pendingMaterials, pendingDirRefs, pendingLinks, contextFolders],
  );

  /** 本轮请求要拼进消息正文的引用块文本 */
  const buildBlocks = useCallback(
    (ctx?: ComposerContext) => buildContextBlocks(ctx ?? composerContext),
    [composerContext],
  );

  /** 发送后清空本轮全部引用（文本由宿主自行清空） */
  const reset = useCallback(() => {
    setPendingAttachments([]);
    setPendingMaterials([]);
    setPendingMaterialPaths(new Set());
    setPendingDirRefs([]);
    setPendingDirRefPaths(new Set());
    setPendingLinks([]);
    setContextFolders([]);
    closeMention();
  }, [closeMention]);

  return {
    // 附件 / 链接 / 目录
    pendingAttachments,
    pendingLinks,
    contextFolders,
    uploadingAttachment,
    dragOver,
    authorizedRoots,
    setContextFolders,
    addAttachments,
    removePendingAttachment,
    removePendingLink,
    removeContextFolder,
    revokeRootAuth,
    handleFileSelect,
    addFiles: handleFileSelect,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    // @ 引用
    pendingMaterials,
    pendingDirRefs,
    mentionOpen,
    mentionQuery,
    mentionIndex,
    mentionDir,
    mentionDirItems,
    mentionDirLoading,
    mentionRef,
    handleInput,
    handleMentionKeyDown,
    handleMentionSelect,
    openMentionFromIcon,
    enterDir,
    goBackDir,
    closeMention,
    // 请求组装
    composerContext,
    buildBlocks,
    reset,
  };
}

export type Composer = ReturnType<typeof useComposer>;
