'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { X, FileText, Lightbulb, ChevronDown, ChevronRight, Edit3, Check, AlertCircle, RefreshCw, MessageSquare } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';

/** 单轮问答 */
interface QARound {
  question: string;
  questionTime: string;
  answer: string;
  answerTime: string;
}

interface NodeData {
  node_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  sources: string[];
  model?: string;
  mood?: {
    vibe?: string[];
    sparks?: string[];
    reflections?: string[];
    will?: string[];
  };
  tags?: string[];
  summary: string;
  conversations: Array<{ question: string; answer: string; questionTime: string; answerTime: string }>;
  annotations: string;
  stickies: string[];
}

interface MarkdownReaderProps {
  nodeMdId: string | null;
  onClose: (nodeMdId: string) => void;
  zIndex?: number;
  onClickToFront?: (nodeMdId: string) => void;
  /** 面板模式：standalone 固定定位独立面板，tabbed 嵌入标签页容器 */
  mode?: 'standalone' | 'tabbed';
}

const MOOD_COLORS: Record<string, string> = {
  vibe: '#c0392b',
  sparks: '#d4a017',
  reflections: '#537D96',
  will: '#27ae60',
};

const MOOD_LABELS: Record<string, string> = {
  vibe: 'Vibe',
  sparks: 'Sparks',
  reflections: 'Reflections',
  will: 'Will',
};

/** .md 文件中的实际标题（中文，用于解析） */
const SECTION_HEADERS = ['摘要', '对话记录', '批注', '便签'];

/** 解析对话记录为 Q&A 轮次 */
function parseConversationRounds(content: string): QARound[] {
  const rounds: QARound[] = [];
  const lines = content.split('\n');
  let currentQA: Partial<QARound> = {};
  let currentField: 'q' | 'a' | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const qMatch = line.match(/^### Q\s*(?:\((.+?)\))?\s*$/);
    const aMatch = line.match(/^### A\s*(?:\((.+?)\))?\s*$/);

    if (qMatch) {
      // 保存上一轮
      if (currentField === 'a' && currentQA.question) {
        currentQA.answer = currentContent.join('\n').trim();
        rounds.push({ ...currentQA } as QARound);
      }
      currentQA = { questionTime: qMatch[1] || '' };
      currentField = 'q';
      currentContent = [];
      continue;
    }

    if (aMatch) {
      if (currentField === 'q') {
        currentQA.question = currentContent.join('\n').trim();
      }
      currentQA.answerTime = aMatch[1] || '';
      currentField = 'a';
      currentContent = [];
      continue;
    }

    currentContent.push(line);
  }

  // 保存最后一轮
  if (currentField === 'a' && currentQA.question) {
    currentQA.answer = currentContent.join('\n').trim();
    rounds.push({ ...currentQA } as QARound);
  }

  return rounds;
}

/** 截取问题摘要 */
function questionSummary(question: string, maxLen = 60): string {
  const oneLine = question.replace(/\n/g, ' ').trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '...' : oneLine;
}

/** UI 中显示的英文标签 */
const SECTION_LABELS: Record<string, string> = {
  '摘要': 'Summary',
  '对话记录': 'Conversation',
  '批注': 'Notes',
  '便签': 'Sticky Notes',
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function debounce<A extends unknown[]>(fn: (...args: A) => unknown, delay: number) {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (match) return { frontmatter: `---\n${match[1]}\n---\n`, body: match[2] };
  return { frontmatter: '', body: content };
}

function splitSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = content.split('\n');
  let currentSection = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const sectionName = line.slice(3).trim();
      if (SECTION_HEADERS.includes(sectionName)) {
        if (currentSection) sections.set(currentSection, currentContent.join('\n').trim());
        currentSection = sectionName;
        currentContent = [];
        continue;
      }
    }
    currentContent.push(line);
  }
  if (currentSection) sections.set(currentSection, currentContent.join('\n').trim());
  return sections;
}

function assembleMarkdown(frontmatter: string, sections: Record<string, string>): string {
  let body = '';
  for (const name of SECTION_HEADERS) {
    const content = sections[name];
    if (content && content.trim() && content.trim() !== '(Empty)') {
      body += `## ${name}\n${content.trim()}\n\n`;
    }
  }
  return frontmatter + body.trim();
}

export function MarkdownReader({ nodeMdId, onClose, zIndex = 50, onClickToFront, mode = 'standalone' }: MarkdownReaderProps) {
  const [nodeData, setNodeData] = useState<NodeData | null>(null);
  const [rawContent, setRawContent] = useState('');
  const [frontmatter, setFrontmatter] = useState('');
  const [sectionContents, setSectionContents] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'modified'>('saved');
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set(['便签']));
  const [collapsedRounds, setCollapsedRounds] = useState<Set<number>>(new Set());
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const lastSavedRef = useRef<string>('');
  const fetchKeyRef = useRef(0);

  // 加载节点文档（含重试逻辑）
  const loadNodeDocument = useCallback(async (retryCount = 0) => {
    if (!nodeMdId) return;
    const key = ++fetchKeyRef.current;
    setError(null);
    setLoading(true);

    const MAX_RETRIES = 2;

    try {
      // 并行请求：node data + raw content
      const [nodeResp, rawResp] = await Promise.all([
        fetch(`/api/nodes?id=${nodeMdId}`).then(r => r.json()),
        fetch(`/api/nodes?id=${nodeMdId}&action=raw`).then(r => r.json()),
      ]);

      // 防止过期响应覆盖
      if (key !== fetchKeyRef.current) return;

      if (nodeResp.success) {
        setNodeData(nodeResp.node);
      } else if (nodeResp.error) {
        // 节点数据请求失败，记录但继续尝试 raw content
        console.warn('[MarkdownReader] 节点数据加载失败:', nodeResp.error);
      }

      if (rawResp.success && rawResp.content) {
        const { frontmatter: fm, body } = splitFrontmatter(rawResp.content);
        setFrontmatter(fm);
        setRawContent(rawResp.content);
        lastSavedRef.current = rawResp.content;

        const sections = splitSections(body);
        const contents: Record<string, string> = {};
        for (const name of SECTION_HEADERS) {
          contents[name] = sections.get(name) || '';
        }
        setSectionContents(contents);
        setError(null);
      } else {
        const errMsg = rawResp.error || 'Failed to load document';
        if (retryCount < MAX_RETRIES) {
          // 自动重试
          console.warn(`[MarkdownReader] 加载失败，${500 * (retryCount + 1)}ms 后重试 (${retryCount + 1}/${MAX_RETRIES}):`, errMsg);
          await new Promise(r => setTimeout(r, 500 * (retryCount + 1)));
          if (key !== fetchKeyRef.current) return;
          return loadNodeDocument(retryCount + 1);
        }
        setError(errMsg);
      }
    } catch (e) {
      // 防止过期响应覆盖
      if (key !== fetchKeyRef.current) return;
      const errMsg = e instanceof Error ? e.message : 'Network request failed';
      if (retryCount < MAX_RETRIES) {
        console.warn(`[MarkdownReader] 网络错误，${500 * (retryCount + 1)}ms 后重试 (${retryCount + 1}/${MAX_RETRIES}):`, errMsg);
        await new Promise(r => setTimeout(r, 500 * (retryCount + 1)));
        if (key !== fetchKeyRef.current) return;
        return loadNodeDocument(retryCount + 1);
      }
      setError(errMsg);
    } finally {
      if (key === fetchKeyRef.current) {
        setLoading(false);
      }
    }
  }, [nodeMdId]);

  useEffect(() => {
    if (!nodeMdId) {
      setNodeData(null);
      setRawContent('');
      setSectionContents({});
      setError(null);
      return;
    }
    loadNodeDocument();
  }, [nodeMdId, loadNodeDocument]);

  const doSave = useCallback(async (contents: Record<string, string>) => {
    if (!nodeMdId) return;
    const newContent = assembleMarkdown(frontmatter, contents);
    if (newContent === lastSavedRef.current) return;
    setSaveStatus('saving');
    try {
      const resp = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_content', node_id: nodeMdId, content: newContent }),
      });
      if (resp.ok) {
        lastSavedRef.current = newContent;
        setRawContent(newContent);
        setSaveStatus('saved');
      } else {
        setSaveStatus('modified');
      }
    } catch {
      setSaveStatus('modified');
    }
  }, [nodeMdId, frontmatter]);

  const debouncedSave = useCallback(
    debounce((contents: Record<string, string>) => doSave(contents), 800),
    [doSave],
  );

  const handleSectionChange = useCallback((sectionName: string, content: string) => {
    setSectionContents(prev => {
      const next = { ...prev, [sectionName]: content };
      setSaveStatus('modified');
      debouncedSave(next);
      return next;
    });
    setEditingSection(null);
  }, [debouncedSave]);

  const toggleSection = useCallback((name: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleRound = useCallback((index: number) => {
    setCollapsedRounds(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const startEdit = useCallback((sectionName: string) => {
    setEditingSection(sectionName);
    setEditValue(sectionContents[sectionName] || '');
  }, [sectionContents]);

  const cancelEdit = useCallback(() => {
    setEditingSection(null);
    setEditValue('');
  }, []);

  const confirmEdit = useCallback(() => {
    if (editingSection) {
      handleSectionChange(editingSection, editValue);
    }
  }, [editingSection, editValue, handleSectionChange]);

  if (!nodeMdId) return null;

  const mood = nodeData?.mood;
  const hasMood = mood && Object.values(mood).some(arr => arr && arr.length > 0);

  return (
    <>
      <div
        className={mode === 'standalone' ? 'fixed right-0 top-0 flex h-full flex-col' : 'flex h-full flex-col'}
        style={{
          width: mode === 'standalone' ? '48%' : '100%',
          minWidth: mode === 'standalone' ? '480px' : undefined,
          maxWidth: mode === 'standalone' ? '780px' : undefined,
          backgroundColor: '#faf8f3',
          borderLeft: mode === 'standalone' ? '1px solid rgba(0, 0, 0, 0.07)' : undefined,
          boxShadow: mode === 'standalone' ? '-12px 0 32px rgba(0, 0, 0, 0.06)' : undefined,
          zIndex: mode === 'standalone' ? zIndex : undefined,
        }}
        onClick={() => onClickToFront?.(nodeMdId!)}
      >
        <div
          className="flex shrink-0 items-center gap-3 px-5 py-3"
          style={{ borderBottom: '1px solid rgba(0, 0, 0, 0.05)', backgroundColor: '#faf8f3' }}
        >
          <FileText className="h-4 w-4 shrink-0" style={{ color: '#537D96' }} />
          <span className="flex-1 truncate text-[14px] font-semibold" style={{ color: '#2c2416' }}>
            {nodeData?.title || 'Loading...'}
          </span>
          {!loading && saveStatus !== 'saved' && (
            <span className="text-[11px] font-medium" style={{ color: saveStatus === 'saving' ? '#537D96' : '#d4a017' }}>
              {saveStatus === 'saving' ? 'Saving...' : '*Unsaved'}
            </span>
          )}
          <button
            onClick={() => onClose(nodeMdId!)}
            className="rounded-md p-1.5 transition-colors hover:bg-[rgba(0,0,0,0.04)]"
            style={{ color: '#7a7260' }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {nodeData && (
          <div
            className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2 text-[11px]"
            style={{ borderBottom: '1px solid rgba(0, 0, 0, 0.04)', color: '#8a8270' }}
          >
            <span>Created {formatTime(nodeData.created_at)}</span>
            <span>Updated {formatTime(nodeData.updated_at)}</span>
            {nodeData.model && (
              <span style={{ color: '#537D96' }}>{nodeData.model}</span>
            )}
            {nodeData.tags && nodeData.tags.length > 0 && (
              <span className="flex items-center gap-1">
                {nodeData.tags.map(t => (
                  <span key={t} className="rounded-full px-2 py-0.5" style={{ backgroundColor: 'rgba(83, 125, 150, 0.08)', color: '#537D96' }}>
                    {t}
                  </span>
                ))}
              </span>
            )}
          </div>
        )}

        {loading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent" style={{ color: '#537D96' }} />
            <span className="text-[12px]" style={{ color: '#8a8270' }}>Loading...</span>
          </div>
        ) : error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
            <AlertCircle className="h-8 w-8" style={{ color: '#c0392b' }} />
            <p className="text-center text-[13px]" style={{ color: '#5c5342' }}>{error}</p>
            <button
              onClick={() => loadNodeDocument()}
              className="flex items-center gap-1.5 rounded-md px-4 py-2 text-[12px] font-medium transition-colors"
              style={{ backgroundColor: '#537D96', color: '#fff' }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </button>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto ai-canvas-scroll">
            <div className="px-6 py-5 space-y-5">
              <div className="text-[11px] font-medium" style={{ color: '#8a8270' }}>{nodeData?.title || 'Document'}</div>

              {sectionContents['摘要'] && sectionContents['摘要'] !== '(Empty)' && (
                <div className="reader-section-wrap">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#537D96' }}>{SECTION_LABELS['摘要']}</div>
                  <div className="rounded-lg border-l-[3px] p-4" style={{ borderLeftColor: '#537D96', backgroundColor: '#ffffff', borderColor: 'rgba(0,0,0,0.04)' }}>
                    <MarkdownRenderer content={sectionContents['摘要']} />
                  </div>
                </div>
              )}

              {sectionContents['对话记录'] !== undefined && (
                <div className="reader-section-wrap">
                  <button
                    onClick={() => toggleSection('对话记录')}
                    className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide transition-opacity hover:opacity-70"
                    style={{ color: '#2c2416' }}
                  >
                    {collapsedSections.has('对话记录') ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    {SECTION_LABELS['对话记录']}
                    {(() => {
                      const rounds = parseConversationRounds(sectionContents['对话记录'] || '');
                      return rounds.length > 0 ? ` (${rounds.length} rounds)` : '';
                    })()}
                  </button>
                  {!collapsedSections.has('对话记录') && (
                    <div className="space-y-2">
                      {editingSection === '对话记录' ? (
                        <div className="rounded-lg border p-4 space-y-2" style={{ backgroundColor: '#ffffff', borderColor: 'rgba(0,0,0,0.04)' }}>
                          <textarea
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="w-full resize-none rounded-md border p-3 font-mono text-[12px] outline-none leading-relaxed"
                            style={{ borderColor: 'rgba(83, 125, 150, 0.1)', fontFamily: '"SF Mono", Menlo, monospace', color: '#4a4232', minHeight: '160px' }}
                            placeholder="### Q&#10;Your question here&#10;&#10;### A&#10;Answer here"
                            autoFocus
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={cancelEdit}
                              className="rounded-md px-3 py-1 text-[11px] font-medium transition-colors hover:bg-black/5"
                              style={{ color: '#8a8270' }}
                            >
                              Cancel
                            </button>
                            <button
                              onClick={confirmEdit}
                              className="flex items-center gap-1 rounded-md px-3 py-1 text-[11px] font-medium transition-colors"
                              style={{ backgroundColor: '#537D96', color: '#fff' }}
                            >
                              <Check className="h-3 w-3" />
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        (() => {
                          const rounds = parseConversationRounds(sectionContents['对话记录'] || '');
                          return rounds.length > 0 ? (
                            <>
                              {rounds.map((round, idx) => {
                                const isCollapsed = collapsedRounds.has(idx);
                                return (
                                  <div
                                    key={idx}
                                    className="rounded-lg border overflow-hidden"
                                    style={{ backgroundColor: '#ffffff', borderColor: 'rgba(0,0,0,0.04)' }}
                                  >
                                    {/* 折叠头部 - 始终显示 Q */}
                                    <button
                                      onClick={() => toggleRound(idx)}
                                      className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-[rgba(0,0,0,0.015)]"
                                    >
                                      {isCollapsed ? (
                                        <ChevronRight className="h-3.5 w-3.5 shrink-0" style={{ color: '#8a8270' }} />
                                      ) : (
                                        <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: '#8a8270' }} />
                                      )}
                                      <span className="mr-1 text-[10px] font-semibold shrink-0"
                                        style={{ color: '#537D96' }}>
                                        Q{idx + 1}
                                      </span>
                                      <span className="flex-1 truncate text-[12px]"
                                        style={{ color: isCollapsed ? '#4a4232' : '#8a8270' }}>
                                        {questionSummary(round.question)}
                                      </span>
                                      {round.questionTime && (
                                        <span className="shrink-0 text-[10px]" style={{ color: '#b0a890' }}>
                                          {formatTime(round.questionTime)}
                                        </span>
                                      )}
                                    </button>

                                    {/* 展开内容 - Q + A */}
                                    {!isCollapsed && (
                                      <div className="border-t px-4 py-3" style={{ borderColor: 'rgba(0,0,0,0.04)' }}>
                                        <div className="mb-2">
                                          <span className="text-[10px] font-semibold" style={{ color: '#537D96' }}>Q:</span>
                                          <div className="mt-0.5 text-[12px] leading-relaxed" style={{ color: '#4a4232' }}>
                                            <MarkdownRenderer content={round.question} />
                                          </div>
                                        </div>
                                        <div>
                                          <span className="text-[10px] font-semibold" style={{ color: '#27ae60' }}>A:</span>
                                          <div className="mt-0.5 text-[12px] leading-relaxed" style={{ color: '#4a4232' }}>
                                            <MarkdownRenderer content={round.answer} />
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                              <div className="flex justify-end">
                                <button
                                  onClick={() => startEdit('对话记录')}
                                  className="rounded-md p-1 transition-colors hover:bg-black/5"
                                  style={{ color: '#8a8270' }}
                                >
                                  <Edit3 className="h-3 w-3" />
                                </button>
                              </div>
                            </>
                          ) : (
                            <div className="rounded-lg border p-4" style={{ backgroundColor: '#ffffff', borderColor: 'rgba(0,0,0,0.04)' }}>
                              <div className="mb-2 flex items-center justify-between">
                                <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#537D96' }}>
                                  <MessageSquare className="h-3 w-3" />
                                  Conversation
                                </span>
                                <button
                                  onClick={() => startEdit('对话记录')}
                                  className="rounded-md p-1 transition-colors hover:bg-black/5"
                                  style={{ color: '#8a8270' }}
                                >
                                  <Edit3 className="h-3 w-3" />
                                </button>
                              </div>
                              <MarkdownRenderer content={sectionContents['对话记录'] && sectionContents['对话记录'] !== '(Empty)' ? sectionContents['对话记录'] : ''} />
                            </div>
                          );
                        })()
                      )}
                    </div>
                  )}
                </div>
              )}

              {sectionContents['批注'] !== undefined && (
                <div className="reader-section-wrap">
                  <button
                    onClick={() => toggleSection('批注')}
                    className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide transition-opacity hover:opacity-70"
                    style={{ color: '#2c2416' }}
                  >
                    {collapsedSections.has('批注') ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    {SECTION_LABELS['批注']}
                  </button>
                  {!collapsedSections.has('批注') && (
                    <div className="rounded-lg border p-4" style={{ borderColor: 'rgba(212, 160, 23, 0.2)', backgroundColor: '#ffffff', borderLeftWidth: '3px', borderLeftColor: '#d4a017' }}>
                      {editingSection === '批注' ? (
                        <div className="space-y-2">
                          <textarea
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="w-full resize-none rounded-md border p-3 font-mono text-[12px] outline-none leading-relaxed"
                            style={{ borderColor: 'rgba(212, 160, 23, 0.2)', fontFamily: '"SF Mono", Menlo, monospace', color: '#4a4232', minHeight: '80px' }}
                            placeholder="Enter notes..."
                            autoFocus
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={cancelEdit}
                              className="rounded-md px-3 py-1 text-[11px] font-medium transition-colors hover:bg-black/5"
                              style={{ color: '#8a8270' }}
                            >
                              Cancel
                            </button>
                            <button
                              onClick={confirmEdit}
                              className="flex items-center gap-1 rounded-md px-3 py-1 text-[11px] font-medium transition-colors"
                              style={{ backgroundColor: '#d4a017', color: '#fff' }}
                            >
                              <Check className="h-3 w-3" />
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#d4a017' }}>Notes</span>
                            <button
                              onClick={() => startEdit('批注')}
                              className="rounded-md p-1 transition-colors hover:bg-black/5"
                              style={{ color: '#8a8270' }}
                            >
                              <Edit3 className="h-3 w-3" />
                            </button>
                          </div>
                          <MarkdownRenderer content={sectionContents['批注'] && sectionContents['批注'] !== '(Empty)' ? sectionContents['批注'] : ''} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {sectionContents['便签'] !== undefined && (
                <div className="reader-section-wrap">
                  <button
                    onClick={() => toggleSection('便签')}
                    className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide transition-opacity hover:opacity-70"
                    style={{ color: '#2c2416' }}
                  >
                    {collapsedSections.has('便签') ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    {SECTION_LABELS['便签']}
                  </button>
                  {!collapsedSections.has('便签') && (
                    <div className="rounded-lg border p-4" style={{ borderColor: 'rgba(83, 125, 150, 0.1)', backgroundColor: '#ffffff' }}>
                      {editingSection === '便签' ? (
                        <div className="space-y-2">
                          <textarea
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="w-full resize-none rounded-md border p-3 font-mono text-[12px] outline-none leading-relaxed"
                            style={{ borderColor: 'rgba(83, 125, 150, 0.1)', fontFamily: '"SF Mono", Menlo, monospace', color: '#4a4232', minHeight: '80px' }}
                            placeholder="- Item 1&#10;- Item 2"
                            autoFocus
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={cancelEdit}
                              className="rounded-md px-3 py-1 text-[11px] font-medium transition-colors hover:bg-black/5"
                              style={{ color: '#8a8270' }}
                            >
                              Cancel
                            </button>
                            <button
                              onClick={confirmEdit}
                              className="flex items-center gap-1 rounded-md px-3 py-1 text-[11px] font-medium transition-colors"
                              style={{ backgroundColor: '#537D96', color: '#fff' }}
                            >
                              <Check className="h-3 w-3" />
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#537D96' }}>Sticky Notes</span>
                            <button
                              onClick={() => startEdit('便签')}
                              className="rounded-md p-1 transition-colors hover:bg-black/5"
                              style={{ color: '#8a8270' }}
                            >
                              <Edit3 className="h-3 w-3" />
                            </button>
                          </div>
                          <MarkdownRenderer content={sectionContents['便签'] && sectionContents['便签'] !== '(Empty)' ? sectionContents['便签'] : ''} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {hasMood && (
                <div className="reader-section-wrap">
                  <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#2c2416' }}>
                    <Lightbulb className="h-3 w-3" />
                    MOOD
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {(['vibe', 'sparks', 'reflections', 'will'] as const).map(pool => {
                      const items = mood![pool];
                      if (!items || items.length === 0) return null;
                      return (
                        <div
                          key={pool}
                          className="rounded-lg border p-3"
                          style={{ borderColor: `${MOOD_COLORS[pool]}20`, backgroundColor: `${MOOD_COLORS[pool]}08` }}
                        >
                          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: MOOD_COLORS[pool] }}>{MOOD_LABELS[pool]}</div>
                          <ul className="space-y-1">
                            {items.map((item, idx) => (
                              <li key={idx} className="flex gap-1.5 text-[12px] leading-snug" style={{ color: '#5c5342' }}>
                                <span style={{ color: `${MOOD_COLORS[pool]}60` }}>—</span>
                                <span>{item}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

            </div>
          </div>
        )}
      </div>
    </>
  );
}
