'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Pluggable, PluggableList } from 'unified';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, BookOpen, Loader2, RotateCw } from 'lucide-react';
import { openFileByProjectRelPath } from './HtmlRenderer';

/** 账本条目（与宿主 /api/ledger/document 返回的 LedgerEntry 对应） */
interface LedgerDocEntry {
  id: string;
  title: string;
  summary?: string;
  source?: string;
  tags?: string[];
  updated?: string;
  body: string;
}

/** 项目页创作阶段（与 lib/mcp/ledger.ts 的 ProjectStage 对应） */
type ProjectStage = 'idea' | 'outline' | 'draft' | 'done';

/** 项目页（p-…）：一页对一件要产出的事，比概览条目多一个阶段 */
interface LedgerDocProject extends LedgerDocEntry {
  stage: ProjectStage;
}

interface LedgerDocData {
  hasLedger: boolean;
  empty: boolean;
  entries: LedgerDocEntry[];
  projects: LedgerDocProject[];
  wikiCount: number;
  projectCount: number;
  rawCount: number;
  pending: number;
  compiledAt: string | null;
}

/** 阶段 → 徽标文案与配色（沿用全局语义色，不新造色板） */
const STAGE_META: Record<ProjectStage, { label: string; color: string; bg: string }> = {
  idea: { label: 'Idea', color: 'var(--ink-muted)', bg: 'var(--paper-soft)' },
  outline: { label: 'Outline', color: 'var(--info)', bg: 'var(--info-soft)' },
  draft: { label: 'Draft', color: 'var(--warn)', bg: 'var(--warn-soft)' },
  done: { label: 'Done', color: 'var(--success)', bg: 'var(--success-soft)' },
};

function stageMeta(stage: ProjectStage) {
  return STAGE_META[stage] ?? STAGE_META.idea;
}

interface LedgerDocPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

/* ------------------- 正文项目路径 → 可点开原件的链接 ------------------- */

/** 项目相对路径（与对话正文 .file-mention 同一口径；排除 [] # 以免吃掉引用标记的尾巴） */
const PROJECT_PATH_RE = /(?:materials|homework|attachments)\/(?!\.{1,2}(?:\/|$))[^\s<>"'`，。；：、！？（）【】《》〔〕「」『』\[\]#]+/g;
/** 判据用（不带 g：避免 lastIndex 状态在多次调用间串味） */
const PROJECT_PATH_HEAD_RE = /^(?:materials|homework|attachments)\//;

/** 该 href / 文本是否是项目相对路径（可点开原件，而非外链跳转） */
function isProjectRelPath(value: string): boolean {
  return PROJECT_PATH_HEAD_RE.test(value);
}

/** mdast 节点最小结构（只用到 type/value/url/children；不为此引入 mdast 类型包） */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/** 不下钻的节点：代码块 / 行内代码 / 既有链接（避免造出嵌套链接）/ 原始 HTML */
const NO_DESCEND = new Set(['code', 'inlineCode', 'link', 'linkReference', 'image', 'html']);

/** 纯文本 → 文本 + 链接节点；无命中返回 null（原节点不动） */
function splitProjectPaths(value: string): MdNode[] | null {
  PROJECT_PATH_RE.lastIndex = 0;
  const out: MdNode[] = [];
  let last = 0;
  let hit = false;
  for (let m = PROJECT_PATH_RE.exec(value); m; m = PROJECT_PATH_RE.exec(value)) {
    hit = true;
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
    out.push({ type: 'link', url: m[0], children: [{ type: 'text', value: m[0] }] });
    last = m.index + m[0].length;
  }
  if (!hit) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function linkifyProjectPaths(node: MdNode): void {
  const children = node.children;
  if (!children || NO_DESCEND.has(node.type)) return;
  const next: MdNode[] = [];
  for (const child of children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      const parts = splitProjectPaths(child.value);
      if (parts) {
        next.push(...parts);
        continue;
      }
    } else {
      linkifyProjectPaths(child);
    }
    next.push(child);
  }
  node.children = next;
}

/** remark 插件：把正文里的项目相对路径包成链接（href 即路径本身，由 DOC_COMPONENTS.a 拦截为「系统默认程序打开」）。
 *  只动纯文本节点：代码块 / 行内代码 / 既有链接天然不受影响。 */
const remarkLinkifyProjectPaths: Pluggable = () => (tree: unknown) => {
  linkifyProjectPaths(tree as MdNode);
};

const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkLinkifyProjectPaths];

/** 项目内文件路径胶囊（与对话正文 .file-mention 同款外观）：点击用系统默认程序打开原件 */
function ProjectFileLink({ path, children }: { path: string; children?: ReactNode }) {
  return (
    <button
      type="button"
      title={`Open ${path}`}
      onClick={() => void openFileByProjectRelPath(path)}
      className="inline-block cursor-pointer align-bottom"
      style={{
        maxWidth: '100%',
        padding: '0 5px',
        margin: '0 1px',
        borderRadius: 6,
        border: '1px solid color-mix(in oklab, var(--info) 25%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--info) 10%, transparent)',
        color: 'var(--info)',
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: 12,
        lineHeight: 1.6,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {children ?? path}
    </button>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * 编译文稿（只读）：把账本 `wiki/` 条目现拼成一份可读文稿，看账本归并出了什么、出处是哪份材料、
 * 还有多少条待编译。**不落盘**——数据由 /api/ledger/document 现拼，磁盘上只有 .ledger/ 本身。
 * 后台编译会持续往里加条目，所以留一个 Refresh 手动拉取最新（打开时也会自动拉一次）。
 */
export function LedgerDocPanel({ open, onOpenChange, projectId }: LedgerDocPanelProps) {
  const [data, setData] = useState<LedgerDocData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  const load = useCallback(async () => {
    if (!projectId) {
      setData(null);
      setError('No active project');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/ledger/document?project_id=${encodeURIComponent(projectId)}`);
      const json = await resp.json();
      if (json?.success) setData(json as LedgerDocData);
      else setError(json?.error || 'Failed to load the compiled ledger');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const jumpTo = (id: string) => {
    sectionRefs.current.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const entries = data?.entries ?? [];
  const projects = data?.projects ?? [];
  const isEmpty = entries.length === 0 && projects.length === 0;
  const status = !data
    ? ''
    : !data.hasLedger
      ? 'No ledger yet'
      : `${data.compiledAt ? `Compiled ${fmtTime(data.compiledAt)} · ` : ''}${data.projectCount} project page${data.projectCount === 1 ? '' : 's'} · ${data.wikiCount} entr${data.wikiCount === 1 ? 'y' : 'ies'} · ${data.pending} pending`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 p-4 sm:max-w-[880px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-13 font-semibold" style={{ color: 'var(--ink-strong)' }}>
            <BookOpen className="h-4 w-4" />
            Compiled Ledger
          </DialogTitle>
        </DialogHeader>

        {/* 状态条：编译时间 / 条目数 / 待编译数 + 手动刷新（后台编译在持续加条目） */}
        <div
          className="flex items-center justify-between gap-2 rounded-md px-2 py-1"
          style={{ backgroundColor: 'var(--paper-soft)' }}
        >
          <span className="truncate text-11" style={{ color: 'var(--ink-muted)' }}>{status}</span>
          <Button
            type="button"
            variant="ghost"
            tone="neutral"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            title="Reload the compiled ledger"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        </div>

        {error && (
          <div
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs"
            style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }}
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex min-h-0 gap-3" style={{ height: 'min(62vh, 640px)' }}>
          {/* 目录（最新在前，与正文同序）：条目多时比通读更快定位；项目页与概览条分组 */}
          {!isEmpty && (
            <nav
              className="hidden w-40 shrink-0 overflow-y-auto border-r pr-1.5 sm:block"
              style={{ borderColor: 'var(--line-soft)' }}
            >
              {projects.length > 0 && (
                <>
                  <p className="px-1.5 pt-0.5 pb-1 text-10 font-medium" style={{ color: 'var(--ink-faint)' }}>
                    Project pages
                  </p>
                  {projects.map((p) => {
                    const meta = stageMeta(p.stage);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => jumpTo(p.id)}
                        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-11 transition-colors hover:bg-[var(--paper-hover)]"
                        style={{ color: 'var(--ink)' }}
                        title={`${meta.label} · ${p.title}`}
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
                        <span className="truncate">{p.title}</span>
                      </button>
                    );
                  })}
                </>
              )}
              {entries.length > 0 && (
                <>
                  <p className="px-1.5 pt-2 pb-1 text-10 font-medium" style={{ color: 'var(--ink-faint)' }}>
                    Compiled knowledge
                  </p>
                  {entries.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => jumpTo(e.id)}
                      className="block w-full truncate rounded px-1.5 py-1 text-left text-11 transition-colors hover:bg-[var(--paper-hover)]"
                      style={{ color: 'var(--ink-muted)' }}
                      title={e.title}
                    >
                      {e.title}
                    </button>
                  ))}
                </>
              )}
            </nav>
          )}

          <div className="min-w-0 flex-1 overflow-y-auto pr-1">
            {!data && loading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--ink-muted)' }} />
              </div>
            ) : isEmpty ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
                <BookOpen className="h-5 w-5" style={{ color: 'var(--ink-faint)' }} />
                <p className="text-13 font-medium" style={{ color: 'var(--ink)' }}>
                  {data?.hasLedger ? 'No compiled entries yet' : 'No ledger yet'}
                </p>
                <p className="text-11" style={{ color: 'var(--ink-muted)' }}>
                  {data?.hasLedger
                    ? 'Materials uploaded to this project are compiled in the background; entries show up here once they are done.'
                    : 'It is created automatically as soon as materials are uploaded to this project.'}
                </p>
                {!!data?.pending && (
                  <p className="text-11" style={{ color: 'var(--ink-muted)' }}>
                    {data.pending} registration{data.pending === 1 ? '' : 's'} waiting to be compiled.
                  </p>
                )}
              </div>
            ) : (
              <>
                {projects.length === 0 && (
                  <p className="mb-2 text-11" style={{ color: 'var(--ink-muted)' }}>
                    No project pages yet — the Butler opens one per deliverable and moves it
                    idea → outline → draft → done.
                  </p>
                )}
                {projects.length > 0 && (
                  <>
                    <p className="mb-1 text-10 font-medium" style={{ color: 'var(--ink-faint)' }}>
                      Project pages
                    </p>
                    {projects.map((p) => {
                      const meta = stageMeta(p.stage);
                      return (
                        <section
                          key={p.id}
                          id={`ledger-${p.id}`}
                          ref={(el) => {
                            if (el) sectionRefs.current.set(p.id, el);
                            else sectionRefs.current.delete(p.id);
                          }}
                          className="border-b py-2.5 first:pt-0 last:border-b-0"
                          style={{ borderColor: 'var(--line-soft)' }}
                        >
                          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <h3 className="text-13 font-semibold" style={{ color: 'var(--ink-strong)' }}>{p.title}</h3>
                            <span
                              className="rounded px-1 py-0.5 text-10 font-medium"
                              style={{ color: meta.color, backgroundColor: meta.bg }}
                            >
                              {meta.label}
                            </span>
                          </div>
                          <div className="mt-0.5 mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-10" style={{ color: 'var(--ink-muted)' }}>
                            <span className="font-mono">{p.id}</span>
                            {p.updated && <span>{fmtTime(p.updated)}</span>}
                            {(p.tags ?? []).map((t) => <span key={t}>#{t}</span>)}
                          </div>
                          <div className="text-13" style={{ color: 'var(--ink)' }}>
                            <Markdown remarkPlugins={REMARK_PLUGINS} components={DOC_COMPONENTS}>{p.body}</Markdown>
                          </div>
                        </section>
                      );
                    })}
                  </>
                )}

                {entries.length > 0 && (
                  <>
                    <p className="mt-3 mb-1 text-10 font-medium" style={{ color: 'var(--ink-faint)' }}>
                      Compiled knowledge
                    </p>
                    {entries.map((e) => (
                      <section
                        key={e.id}
                        id={`ledger-${e.id}`}
                        ref={(el) => {
                          if (el) sectionRefs.current.set(e.id, el);
                          else sectionRefs.current.delete(e.id);
                        }}
                        className="border-b py-2.5 first:pt-0 last:border-b-0"
                        style={{ borderColor: 'var(--line-soft)' }}
                      >
                        <h3 className="text-13 font-semibold" style={{ color: 'var(--ink-strong)' }}>{e.title}</h3>
                        <div className="mt-0.5 mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-10" style={{ color: 'var(--ink-muted)' }}>
                          <span className="font-mono">{e.id}</span>
                          {e.source && (isProjectRelPath(e.source)
                            ? <ProjectFileLink path={e.source} />
                            : <span>{e.source}</span>)}
                          {e.updated && <span>{fmtTime(e.updated)}</span>}
                          {(e.tags ?? []).map((t) => <span key={t}>#{t}</span>)}
                        </div>
                        <div className="text-13" style={{ color: 'var(--ink)' }}>
                          <Markdown remarkPlugins={REMARK_PLUGINS} components={DOC_COMPONENTS}>{e.body}</Markdown>
                        </div>
                      </section>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {!isEmpty && (
          <p className="text-10" style={{ color: 'var(--ink-faint)' }}>
            Assembled on the fly from .ledger/wiki — no file is written.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 文稿排版（比对话里的 Markdown 更接近文档：标题分级、正文行距） */
function MdH1({ children }: { children?: ReactNode }) {
  return <div className="mt-2 mb-1 text-13 font-semibold">{children}</div>;
}
function MdH2({ children }: { children?: ReactNode }) {
  return <div className="mt-2 mb-1 text-13 font-semibold">{children}</div>;
}
function MdH3({ children }: { children?: ReactNode }) {
  return <div className="mt-2 mb-1 text-11 font-semibold">{children}</div>;
}
function MdH4({ children }: { children?: ReactNode }) {
  return <div className="mt-1.5 mb-0.5 text-11 font-semibold">{children}</div>;
}
function MdH5({ children }: { children?: ReactNode }) {
  return <div className="mt-1.5 mb-0.5 text-11 font-medium">{children}</div>;
}

const DOC_COMPONENTS: Components = {
  h1: MdH1,
  h2: MdH2,
  h3: MdH3,
  h4: MdH4,
  h5: MdH5,
  h6: MdH5,
  p: ({ children }) => <p className="my-1 leading-5">{children}</p>,
  ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-4">{children}</ol>,
  li: ({ children }) => <li className="leading-5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote
      className="my-1 border-l-2 pl-2"
      style={{ borderColor: 'var(--line)', color: 'var(--ink-muted)' }}
    >
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-2 border-0 border-t" style={{ borderColor: 'var(--line-soft)' }} />,
  a: ({ href, children }) => {
    const rel = typeof href === 'string' ? href : '';
    // 项目相对路径（materials/… homework/…）→ 用系统默认程序打开原件；target=_blank 对本地相对路径只会开出一个坏页面
    if (isProjectRelPath(rel)) return <ProjectFileLink path={rel}>{children}</ProjectFileLink>;
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2" style={{ color: 'var(--info)' }}>
        {children}
      </a>
    );
  },
  code: ({ className, children }) =>
    /language-/.test(className ?? '') ? (
      <code className="font-mono text-10 leading-5">{children}</code>
    ) : (
      <code className="rounded px-1 font-mono text-10" style={{ backgroundColor: 'var(--paper-soft)' }}>
        {children}
      </code>
    ),
  pre: ({ children }) => (
    <pre
      className="my-1 overflow-x-auto rounded-md border px-2 py-1 text-10 leading-5"
      style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper-soft)' }}
    >
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-1 w-full overflow-x-auto">
      <table className="w-full border-collapse text-11">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border px-1.5 py-0.5 text-left font-semibold" style={{ borderColor: 'var(--line-soft)' }}>
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border px-1.5 py-0.5 align-top" style={{ borderColor: 'var(--line-soft)' }}>
      {children}
    </td>
  ),
};
