'use client';

/**
 * ButlerMemoryPanel —— 记忆面板（Memories）
 *
 * 把「用户记忆」做成**可见、可改、可删**的产品对象（对齐 Today.ai 的 Memories）：
 * 记忆是黑箱时只会越记越脏——能看、能改、能删，AI 对用户的理解才能被纠正。
 *
 * 统一长期记忆（所有联系人共享，记的是用户本人），按 `type` 分组展示：
 * 六类词表（MEMORY_TYPES）固定顺序在前，未命中词表的条目归入 Other 兜底组；
 * 组标题同时标注该组的注入档位（常驻档每轮随上下文给出全文 / 目录档按需调取）。
 * 文案全英文：类型在展示层映射英文显示名（存储值仍是中文词表），编辑态用英文下拉选择，
 * 避免「视图英文 / 编辑框中文」的混排（存量自定义类型保留原值，不被静默改写）。
 *
 * 数据经 /api/butler/preferences 读写（底层 butler/preferences.md），与 Butler 工具侧同源。
 */
import { useCallback, useEffect, useState } from 'react';
import type { UserPreference } from '@/lib/core/preferences-shared';
import { ALWAYS_INJECTED_TYPES, MEMORY_TYPES } from '@/lib/core/preferences-shared';

export interface ButlerMemoryPanelProps {
  /** 独立浮窗模式的关闭回调；嵌入抽屉栏时省略（关闭由抽屉统一提供） */
  onClose?: () => void;
  /** 嵌入抽屉栏：去掉 fixed/锚定/阴影/圆角，填满父容器 */
  embedded?: boolean;
}

/** 记忆类型的英文显示名（存储值仍是中文词表，仅展示层映射；词表见 MEMORY_TYPES） */
const TYPE_LABELS: Record<string, string> = {
  身份画像: 'Identity',
  偏好习惯: 'Preferences',
  工作上下文: 'Work context',
  事实经历: 'Facts & history',
  目标计划: 'Goals & plans',
  关系边界: 'Boundaries',
  /** 缺省类型：模型未指定 type 时的兜底值（见 preferences.ts），不属于六类词表 */
  通用: 'General',
};

/** 类型显示名：已知类型映射英文，未知的自定义类型原样展示 */
function displayType(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

/** 是否命中六类词表（未命中时编辑下拉需保留原值，避免存量自定义类型被静默改写） */
function isKnownType(type: string): boolean {
  return (MEMORY_TYPES as readonly string[]).includes(type);
}

/** 未命中六类词表的兜底分组 */
const OTHER_GROUP_KEY = '__other__';
const OTHER_GROUP_LABEL = 'Other';

/** 组标题上的注入档位提示（与 context.ts 的分档策略一致） */
const RESIDENT_HINT = 'always in context';
const ON_DEMAND_HINT = 'on demand';

interface MemoryGroup {
  key: string;
  label: string;
  hint: string;
  /** Other 兜底组的条目 type 各不相同，需逐条展示原始 type */
  showRawType: boolean;
  items: UserPreference[];
}

/** 按 type 分组：六类词表固定顺序在前，未命中词表的归入 Other 兜底组（空组不展示） */
function groupByType(items: UserPreference[]): MemoryGroup[] {
  const buckets = new Map<string, UserPreference[]>();
  for (const t of MEMORY_TYPES) buckets.set(t, []);
  const others: UserPreference[] = [];
  for (const p of items) {
    const bucket = buckets.get(p.type);
    if (bucket) bucket.push(p);
    else others.push(p);
  }

  const groups: MemoryGroup[] = [];
  for (const t of MEMORY_TYPES) {
    const list = buckets.get(t) ?? [];
    if (list.length === 0) continue;
    groups.push({
      key: t,
      label: displayType(t),
      hint: ALWAYS_INJECTED_TYPES.includes(t) ? RESIDENT_HINT : ON_DEMAND_HINT,
      showRawType: false,
      items: list,
    });
  }
  if (others.length > 0) {
    groups.push({
      key: OTHER_GROUP_KEY,
      label: OTHER_GROUP_LABEL,
      hint: ON_DEMAND_HINT,
      showRawType: true,
      items: others,
    });
  }
  return groups;
}

/** 独立浮窗默认样式（embedded 时改为填满父栏，由抽屉提供边框与背景） */
function panelStyle(embedded?: boolean): React.CSSProperties {
  if (embedded) {
    return {
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      color: 'var(--foreground)',
      fontFamily: 'var(--font-sans)',
      fontSize: 13,
    };
  }
  return {
    position: 'fixed',
    right: 20,
    top: 64,
    width: 420,
    maxHeight: 'calc(100vh - 108px)',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: 16,
    background: 'var(--popover)',
    border: '1px solid var(--border)',
    boxShadow: '0 18px 48px rgba(0,0,0,0.18)',
    color: 'var(--foreground)',
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    zIndex: 1200,
  };
}

const smallBtn: React.CSSProperties = {
  border: '1px solid var(--border)',
  background: 'var(--surface-muted)',
  color: 'var(--foreground)',
  borderRadius: 8,
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
};

const dangerBtn: React.CSSProperties = { ...smallBtn, color: 'var(--danger)', borderColor: 'var(--danger)' };

const groupHeading: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  margin: '2px 2px 6px',
  fontSize: 12,
  color: 'var(--muted-foreground)',
};

export function ButlerMemoryPanel({ onClose, embedded }: ButlerMemoryPanelProps) {
  const [items, setItems] = useState<UserPreference[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 正在编辑的条目序号（null = 无） */
  const [editing, setEditing] = useState<number | null>(null);
  const [draftContent, setDraftContent] = useState('');
  const [draftType, setDraftType] = useState('');
  /** 待确认删除的序号（两步确认，避免误删记忆） */
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/butler/preferences');
      const data = await res.json();
      if (!data?.success) {
        setError(data?.error ?? 'Failed to load memories');
        return;
      }
      setItems(data.preferences as UserPreference[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load memories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startEdit = (p: UserPreference) => {
    setEditing(p.index);
    setDraftContent(p.content);
    setDraftType(p.type);
    setPendingDelete(null);
  };

  const saveEdit = async () => {
    if (editing === null) return;
    setBusy(true);
    try {
      const res = await fetch('/api/butler/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: editing, content: draftContent, type: draftType }),
      });
      const data = await res.json();
      if (!data?.success) {
        setError(data?.error ?? 'Failed to save');
        return;
      }
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (index: number) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/butler/preferences?index=${index}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data?.success) {
        setError(data?.error ?? 'Failed to delete');
        return;
      }
      setPendingDelete(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setBusy(false);
    }
  };

  const groups = groupByType(items);

  return (
    <aside style={panelStyle(embedded)} role="dialog" aria-label="Memory panel">
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 14,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 500 }}>Memories</div>
          <div style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
            What Butler remembers about you · edit or delete
          </div>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} style={{ ...smallBtn, border: 'none', background: 'transparent' }} aria-label="Close">
            ✕
          </button>
        )}
      </header>

      <div style={{ padding: 12, overflowY: 'auto', ...(embedded ? { flex: 1, minHeight: 0 } : {}) }}>
        {loading && <p style={{ color: 'var(--muted-foreground)' }}>Loading…</p>}
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
        {!loading && !error && items.length === 0 && (
          <p style={{ color: 'var(--muted-foreground)' }}>
            Nothing yet. Butler remembers your preferences and facts as you chat — edit or delete them anytime.
          </p>
        )}

        {groups.map((g) => (
          <section key={g.key} style={{ marginBottom: 14 }}>
            <div style={groupHeading}>
              <span style={{ fontWeight: 500 }}>{g.label}</span>
              <span style={{ opacity: 0.75 }}>{g.items.length}</span>
              <span style={{ opacity: 0.75 }}>· {g.hint}</span>
            </div>

            {g.items.map((p) => {
              const isEditing = editing === p.index;
              return (
                <div
                  key={p.index}
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    background: 'var(--surface-muted)',
                    marginBottom: 8,
                  }}
                >
                  {isEditing ? (
                    <>
                      <textarea
                        value={draftContent}
                        onChange={(e) => setDraftContent(e.target.value)}
                        rows={3}
                        style={{
                          width: '100%',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          padding: 8,
                          fontSize: 13,
                          background: 'var(--popover)',
                          color: 'var(--foreground)',
                          resize: 'vertical',
                        }}
                      />
                      <select
                        value={draftType}
                        onChange={(e) => setDraftType(e.target.value)}
                        aria-label="Category"
                        style={{
                          marginTop: 6,
                          width: '100%',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          padding: '6px 8px',
                          fontSize: 12,
                          background: 'var(--popover)',
                          color: 'var(--foreground)',
                        }}
                      >
                        {draftType !== '' && !isKnownType(draftType) && (
                          <option value={draftType}>{displayType(draftType)}</option>
                        )}
                        {MEMORY_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {displayType(t)}
                          </option>
                        ))}
                      </select>
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button type="button" onClick={saveEdit} disabled={busy} style={smallBtn}>
                          Save
                        </button>
                        <button type="button" onClick={() => setEditing(null)} style={smallBtn}>
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ lineHeight: 1.6 }}>{p.content}</div>
                      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                        {g.showRawType && p.type && (
                          <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>{displayType(p.type)}</span>
                        )}
                        {p.createdAt && (
                          <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>{p.createdAt}</span>
                        )}
                        <span style={{ flex: 1 }} />
                        <button type="button" onClick={() => startEdit(p)} style={smallBtn}>
                          Edit
                        </button>
                        {pendingDelete === p.index ? (
                          <>
                            <button type="button" onClick={() => void doDelete(p.index)} disabled={busy} style={dangerBtn}>
                              Confirm delete
                            </button>
                            <button type="button" onClick={() => setPendingDelete(null)} style={smallBtn}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button type="button" onClick={() => setPendingDelete(p.index)} style={smallBtn}>
                            Delete
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}