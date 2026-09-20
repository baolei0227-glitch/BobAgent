'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Save, RefreshCw, FileCheck, Edit3, Wand2, ChevronDown, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  OUTCOME_FIELD_DEFS,
  type Outcome,
  type OutcomeFieldKey,
  type OutcomeStatus,
  parseOutcome,
} from '@/lib/nodes/outcome';

interface OutcomeEditorProps {
  nodeMdId: string;
  outcomeStatus: OutcomeStatus | null;
  /** 失效原因链（stale 期间）：展示「因哪条上游、哪条前提已废」，而不是笼统文案 */
  staleReason?: string | null;
  onStatusChange?: (status: OutcomeStatus | null) => void;
  /** 只读预览模式：字段以文本展示，隐藏编辑操作按钮 */
  readonly?: boolean;
}

export function OutcomeEditor({ nodeMdId, outcomeStatus, staleReason, onStatusChange, readonly = false }: OutcomeEditorProps) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const isLocked = outcomeStatus === 'locked';
  // 强制锁定标记（frontmatter outcome_force_locked）：校验未通过但用户自主确认锁定
  const [forceLocked, setForceLocked] = useState(false);
  // 签署留痕（P0-2）：谁签的（outcome_locked_by）/ 何时签的 / 第几版。
  // 属"自称"留痕（本机用户名），用于事后追溯签字人，不宣称密码学意义上的不可否认。
  const [lockTrace, setLockTrace] = useState<{ by?: string; at?: string; version?: number } | null>(null);
  // P0-a 双锚点：节点侧锁定历史镜像（frontmatter outcome_lock_history）+ 项目级台账（.ledger/locks.md）
  // 里是否存在该节点的锚点记录；两者都在时才认为签字链完整。
  const [lockHistory, setLockHistory] = useState<Array<{ version: number; hash: string; by?: string; at: string; prev?: string }>>([]);
  const [lockAnchored, setLockAnchored] = useState(false);
  // 锁定历史列表折叠（默认折叠）
  const [historyOpen, setHistoryOpen] = useState(false);
  // 编辑态：只读模式下内部可切换"编辑模式/完成"（floating 预览面板头部无编辑按钮时兜底）
  const [editing, setEditing] = useState(!readonly);
  // 打开时成果块为空则自动提取一次（防重复）
  const autoExtractRef = useRef(false);

  // 父级（UnifiedViewer 头部）进入编辑模式时强制同步；父级切回只读时保留内部切换状态
  useEffect(() => {
    if (!readonly) setEditing(true);
  }, [readonly]);

  // 从 .md 文件加载成果块
  const loadOutcome = useCallback(async () => {
    if (!nodeMdId) return;
    setLoading(true);
    try {
      const resp = await fetch(`/api/nodes?id=${encodeURIComponent(nodeMdId)}&action=raw`);
      const data = await resp.json();
      if (data.success && data.content) {
        const raw = data.content as string;
        // 强制锁定标记：frontmatter 中 outcome_force_locked: true
        setForceLocked(/outcome_force_locked:\s*true/.test(raw));
        // 签署留痕（frontmatter）：outcome_locked_by / outcome_locked_at / outcome_version
        const byMatch = raw.match(/^outcome_locked_by:\s*(.+)$/m);
        const atMatch = raw.match(/^outcome_locked_at:\s*(.+)$/m);
        const verMatch = raw.match(/^outcome_version:\s*(\d+)$/m);
        setLockTrace(
          byMatch || atMatch || verMatch
            ? {
                by: byMatch?.[1]?.trim().replace(/^["']|["']$/g, ''),
                at: atMatch?.[1]?.trim().replace(/^["']|["']$/g, ''),
                version: verMatch ? Number(verMatch[1]) : undefined,
              }
            : null,
        );
        // P0-a：锁定历史镜像 + 外部台账锚点标记（与 content 同一次 raw 响应，无新增接口调用）
        setLockHistory(Array.isArray(data.lock_history) ? data.lock_history : []);
        setLockAnchored(data.lock_anchored === true);
        // 提取 ## 成果块 section
        const outcomeMatch = (data.content as string).match(/## 成果块\n([\s\S]*?)(?=\n## |$)/);
        if (outcomeMatch) {
          const parsed = parseOutcome(outcomeMatch[1]);
          setOutcome(parsed);
        } else {
          // 无成果块 → 空模板
          setOutcome({
            facts: '', basis: '', reasoning: '', conclusions: '',
            excluded: '', limits: '', pending: '', user_notes: '',
          });
        }
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [nodeMdId]);

  useEffect(() => {
    loadOutcome();
  }, [loadOutcome]);

  // 监听外部文档更新事件
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { node_id: string };
      if (detail?.node_id === nodeMdId) {
        loadOutcome();
      }
    };
    window.addEventListener('node-document-updated', handler);
    return () => window.removeEventListener('node-document-updated', handler);
  }, [nodeMdId, loadOutcome]);

  // 成果块尚未生成（8 字段全空）时自动触发一次 AI 提取。
  // 提取失败（如首次提问时对话尚未落盘）时允许后续文档更新事件重试，避免"首次不生成"。
  useEffect(() => {
    if (!outcome || autoExtractRef.current) return;
    const record = outcome as unknown as Record<OutcomeFieldKey, string>;
    const isEmpty = OUTCOME_FIELD_DEFS.every((def) => !(record[def.key] ?? '').trim());
    if (isEmpty) {
      autoExtractRef.current = true;
      void handleExtract().then((ok) => {
        if (!ok) autoExtractRef.current = false;
      });
    }
  }, [outcome]);

  const handleFieldChange = (key: OutcomeFieldKey, value: string) => {
    setOutcome(prev => prev ? { ...prev, [key]: value } : prev);
    // 清除保存提示
    if (saveMsg) setSaveMsg(null);
  };

  const handleSave = async () => {
    if (!outcome || !nodeMdId || isLocked) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      // 为每个字段补充空值标记
      const record = outcome as unknown as Record<OutcomeFieldKey, string>;
      const outcomeSection = OUTCOME_FIELD_DEFS.map((def) => {
        const value = (record[def.key] ?? '').trim();
        return `### ${def.label}\n${value || def.emptyValue}`;
      }).join('\n\n');

      const resp = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_outcome',
          node_id: nodeMdId,
          outcome_section: `## 成果块\n\n${outcomeSection}`,
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setSaveMsg('已保存');
        // 通知其他组件（如 HtmlReader）刷新
        window.dispatchEvent(new CustomEvent('node-document-updated', { detail: { node_id: nodeMdId } }));
      } else {
        setSaveMsg(data.error || '保存失败');
      }
    } catch {
      setSaveMsg('保存失败');
    } finally {
      setSaving(false);
      // 3秒后清除提示
      setTimeout(() => setSaveMsg(null), 3000);
    }
  };

  /** AI 提取成果块；返回是否成功（失败时调用方允许重试） */
  const handleExtract = async (): Promise<boolean> => {
    if (!nodeMdId || isLocked || extracting) return false;
    setExtracting(true);
    setSaveMsg(null);
    try {
      const resp = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'extract_outcome',
          node_id: nodeMdId,
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setSaveMsg('AI 提取完成');
        await loadOutcome();
        window.dispatchEvent(new CustomEvent('node-document-updated', { detail: { node_id: nodeMdId } }));
        onStatusChange?.('draft');
        return true;
      } else {
        setSaveMsg(data.error || '提取失败');
        return false;
      }
    } catch {
      setSaveMsg('提取失败');
      return false;
    } finally {
      setExtracting(false);
      setTimeout(() => setSaveMsg(null), 5000);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}>
        <RefreshCw className="h-3 w-3 animate-spin mr-1.5" />
        加载成果块...
      </div>
    );
  }

  if (!outcome) {
    return (
      <div className="flex items-center justify-center py-6 text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}>
        无法加载成果块
      </div>
    );
  }

  const record = outcome as unknown as Record<OutcomeFieldKey, string>;

  return (
    <div
      className="flex flex-col gap-2.5 px-3 py-2.5 border-b"
      style={{ borderColor: 'var(--line)', backgroundColor: 'var(--popover)' }}
    >
      {/* 头部 */}
      <div
        className="flex items-center justify-between cursor-pointer select-none"
        onClick={() => setCollapsed(v => !v)}
        title={collapsed ? '展开成果块' : '折叠成果块'}
      >
        <div className="flex items-center gap-1.5">
          <FileCheck className="h-3.5 w-3.5" style={{ color: isLocked ? 'var(--success)' : 'var(--primary)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>
            成果块
          </span>
          {isLocked && (
            <span
              className="rounded-full px-1.5 py-0 text-xs font-medium"
              style={{ backgroundColor: 'color-mix(in oklab, var(--success) 12%, transparent)', color: 'var(--success)' }}
            >
              已锁定{forceLocked ? '·强制' : ''}
            </span>
          )}
          {/* 签署留痕（P0-2）：谁签的 · 何时签的 · 第几版；属"自称"留痕，可追溯不宣称不可否认 */}
          {isLocked && lockTrace && (lockTrace.by || lockTrace.at) && (
            <span
              className="text-xs"
              style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}
              title={`签署留痕：${lockTrace.by ?? 'unknown'}${lockTrace.at ? ` · ${lockTrace.at}` : ''}${lockTrace.version ? ` · v${lockTrace.version}` : ''}`}
            >
              签署留痕 {lockTrace.by ?? 'unknown'}
              {lockTrace.at ? ` · ${lockTrace.at.slice(0, 10)}` : ''}
              {lockTrace.version ? ` · v${lockTrace.version}` : ''}
            </span>
          )}
          {/* P0-a 定位说明：无论台账是否在，都明确「这是本机自称留痕，不是密码学签名」 */}
          {isLocked && lockTrace && (lockTrace.by || lockTrace.at) && (
            <span
              className="text-xs"
              style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}
              title="Recorded on this machine only — a self-declared trace, not a cryptographic signature and not admissible as evidence for third parties."
            >
              Local record only · not a cryptographic signature
            </span>
          )}
          {/* 双锚点缺口：项目级台账里找不到该节点的锚点（.ledger/locks.md 缺失/被删/该节点无记录） */}
          {isLocked && !lockAnchored && (
            <span
              className="text-xs"
              style={{ color: 'color-mix(in oklab, var(--danger) 70%, transparent)' }}
              title="No lock record found in the project ledger (.ledger/locks.md) — the signature chain cannot be verified against an external anchor."
            >
              No external anchor · signature chain unverified
            </span>
          )}
          {saveMsg && (
            <span
              className="rounded-full px-1.5 py-0 text-xs font-medium"
              style={{
                backgroundColor: saveMsg === '已保存' || saveMsg === 'AI 提取完成' ? 'color-mix(in oklab, var(--success) 12%, transparent)' : 'color-mix(in oklab, var(--danger) 12%, transparent)',
                color: saveMsg === '已保存' || saveMsg === 'AI 提取完成' ? 'var(--success)' : 'var(--danger)',
              }}
            >
              {saveMsg}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* 只读态下的编辑切换（floating 预览面板头部无编辑按钮时兜底） */}
          {!isLocked && readonly && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setEditing(v => !v); }}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors"
              style={{
                backgroundColor: editing ? 'var(--primary)' : 'color-mix(in oklab, var(--info) 10%, transparent)',
                color: editing ? '#fff' : 'var(--info)',
              }}
              title={editing ? '返回只读预览' : '进入编辑模式'}
            >
              {editing ? '完成' : '编辑模式'}
            </button>
          )}
          <ChevronDown
            className="h-3 w-3 transition-transform"
            style={{ color: 'color-mix(in oklab, var(--ink-muted) 40%, transparent)', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
          />
        </div>
      </div>

      {/* 字段列表 + 操作按钮（折叠时隐藏） */}
      {!collapsed && (
        <>
          {/* 失效原因链横幅（stale）：把前提失效链原样展示，不只说"已变更" */}
          {outcomeStatus === 'stale' && (
            <div
              className="flex items-start gap-1.5 rounded border px-2 py-1.5 text-xs leading-relaxed"
              style={{
                borderColor: 'color-mix(in oklab, var(--primary-strong) 40%, transparent)',
                backgroundColor: 'color-mix(in oklab, var(--primary-strong) 8%, transparent)',
                color: 'var(--primary-strong)',
              }}
            >
              <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
              <span>
                {staleReason || '上游成果块已变更，本条前提可能已失效。'}
                <span className="opacity-70">（重新锁定后本提示清除）</span>
              </span>
            </div>
          )}
          {/* 强制锁定警示横幅 */}
          {isLocked && forceLocked && (
            <div
              className="flex items-start gap-1.5 rounded border px-2 py-1.5 text-xs leading-relaxed"
              style={{
                borderColor: 'color-mix(in oklab, var(--danger) 40%, transparent)',
                backgroundColor: 'color-mix(in oklab, var(--danger) 8%, transparent)',
                color: 'var(--danger)',
              }}
            >
              <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
              <span>
                强制锁定：本成果块未通过质量校验（R-x 有未达标项），由用户自主确认锁定。下游引用请自行核实。
              </span>
            </div>
          )}
          {/* 操作按钮（仅编辑态显示） */}
          {!isLocked && editing && (
            <div className="flex items-center gap-1.5">
              <Button
                onClick={(e) => { e.stopPropagation(); handleExtract(); }}
                disabled={extracting}
                loading={extracting}
                variant="solid"
                tone="info"
                size="xs"
                title="AI 从对话记录中提取成果块"
              >
                <Wand2 className={`h-2.5 w-2.5 ${extracting ? 'animate-spin' : ''}`} />
                {extracting ? '提取中...' : 'AI 提取'}
              </Button>
              <Button
                onClick={(e) => { e.stopPropagation(); handleSave(); }}
                disabled={saving}
                loading={saving}
                variant="solid"
                tone="brand"
                size="xs"
              >
                <Save className="h-2.5 w-2.5" />
                {saving ? '保存中...' : '保存'}
              </Button>
            </div>
          )}

          {/* P0-a 锁定历史（节点侧镜像，最新在前）：默认折叠；数据来自同一次 action=raw 响应 */}
          {lockHistory.length > 0 && (
            <div className="flex flex-col gap-1">
              <div
                className="flex items-center gap-1 cursor-pointer select-none text-xs font-medium"
                style={{ color: 'var(--ink)' }}
                onClick={(e) => { e.stopPropagation(); setHistoryOpen(v => !v); }}
                title={historyOpen ? 'Collapse lock history' : 'Expand lock history'}
              >
                <ChevronDown
                  className="h-3 w-3 transition-transform"
                  style={{ color: 'color-mix(in oklab, var(--ink-muted) 40%, transparent)', transform: historyOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                />
                Lock history
                <span className="font-normal" style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}>
                  ({lockHistory.length})
                </span>
              </div>
              {historyOpen && (
                <div className="flex flex-col gap-0.5 pl-4">
                  {[...lockHistory].reverse().map((h, i) => (
                    <div
                      key={`${h.version}-${h.at}-${i}`}
                      className="text-xs"
                      style={{ color: 'color-mix(in oklab, var(--ink-muted) 80%, transparent)' }}
                      title={`hash: ${h.hash}${h.prev ? `\nprev: ${h.prev}` : ''}`}
                    >
                      v{h.version} · {h.hash.slice(0, 8)}… · {h.by ?? 'unknown'} · {h.at.slice(0, 10)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 字段列表 */}
          <div className="flex flex-col gap-2">
            {OUTCOME_FIELD_DEFS.map((def) => {
              const value = record[def.key] ?? '';
              return (
                <div key={def.key} className="flex flex-col gap-0.5">
                  <label
                    className="text-xs font-medium flex items-center gap-1"
                    style={{ color: 'var(--ink)' }}
                  >
                    {def.label}
                    {def.required && (
                      <span className="text-xs" style={{ color: 'color-mix(in oklab, var(--danger) 70%, transparent)' }}>*</span>
                    )}
                    <span className="text-xs font-medium" style={{ color: 'color-mix(in oklab, var(--ink-muted) 40%, transparent)' }}>
                      {def.key === 'user_notes' ? '(仅用户填写)' : `(空值写"${def.emptyValue}")`}
                    </span>
                  </label>
                  {!editing ? (
                    <div
                      className="whitespace-pre-wrap rounded border px-2 py-1.5 text-xs leading-relaxed"
                      style={{
                        backgroundColor: 'var(--popover)',
                        borderColor: 'var(--line)',
                        color: 'var(--ink)',
                        minHeight: 30,
                      }}
                    >
                      {value || def.emptyValue}
                    </div>
                  ) : (
                  <textarea
                    value={value}
                    onChange={(e) => handleFieldChange(def.key, e.target.value)}
                    disabled={isLocked || def.key === 'user_notes'}
                    rows={1}
                    ref={(el) => {
                      // 高度随文字行数自适应
                      if (el) {
                        el.style.height = 'auto';
                        el.style.height = `${el.scrollHeight}px`;
                      }
                    }}
                    className="nodrag resize-none overflow-hidden rounded border px-2 py-1.5 text-xs leading-relaxed transition-colors focus:outline-none disabled:opacity-60"
                    style={{
                      backgroundColor: isLocked || def.key === 'user_notes' ? 'var(--popover)' : 'var(--input-bg)',
                      borderColor: 'var(--line)',
                      color: 'var(--ink)',
                      minHeight: 52,
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = 'color-mix(in oklab, var(--primary) 40%, transparent)';
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = 'var(--line)';
                    }}
                    placeholder={def.emptyValue || '请输入...'}
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
