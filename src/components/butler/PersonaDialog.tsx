'use client';

/**
 * PersonaDialog —— 会话人设弹窗（新建助理 / 编辑人设）
 *
 * 归属：人设与 Butler 线程**同行**存储（见 lib/butler/threads.ts），所以「删除会话即删除人设」。
 * 本组件只负责收集表单并回传 ButlerPersona，落库由调用方（ButlerDrawer）走
 * POST /api/butler/threads/session（创建态）或 PATCH ?threadId=（编辑态）。
 *
 * 形态参照「配置类界面一律极简」：只露**姓名 + 性格**两栏；
 * 身份 / 风格 / 如何称呼用户收进默认折叠的「高级」，不填就不注入该维度。
 *
 * 用 portal 挂到 body：抽屉根节点带 transform（居中弹窗），fixed 子元素会被它当包含块，
 * 直接内联渲染会跟着抽屉一起偏移。
 *
 * 编辑态另在**标题栏右侧**放一个删除好友的键（原先挂在联系人行的行尾）：
 * 行内那个键只在悬停时才看得见、又紧挨着「切换会话」的热区，容易误点；
 * 挪进弹窗后，「改人设」和「删好友」收在同一处。真正删除仍由调用方负责（确认 + 落库）。
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ButlerPersona } from '@/lib/butler/threads-shared';

/** 与会话路由的 FIELD_MAX 对齐：人设要进系统提示，别让一屏文本吃掉上下文 */
const FIELD_MAX = 200;

/** 性格模板：chip 点击即把 personality 填成对应文案（可再手改）；'custom' 只记录来源、不动文本 */
const PERSONA_TEMPLATES: { id: string; label: string; personality: string }[] = [
  { id: 'tsundere', label: '傲娇', personality: '傲娇但心软，嘴上嫌弃行动上很上心' },
  { id: 'genki', label: '元气', personality: '元气满满、热情积极，说话有活力' },
  { id: 'airhead', label: '天然呆', personality: '天然呆，反应慢半拍但真诚可爱' },
  { id: 'kuudere', label: '三无', personality: '三无：无口、无心、无表情，话少而精准' },
  { id: 'gentle', label: '温柔治愈', personality: '温柔耐心，善于安抚与鼓励' },
  { id: 'yandere', label: '病娇', personality: '病娇，对用户有强烈的独占欲与依恋' },
  { id: 'custom', label: '自定义', personality: '' },
];

export interface PersonaDialogProps {
  mode: 'create' | 'edit';
  /** 编辑态回填（创建态传 null） */
  initial?: ButlerPersona | null;
  /** 锁定显示名（系统身份如 Bobby：名字钉死、不随人设改）；给定则不渲染姓名输入框 */
  fixedName?: string;
  /** 打开即展开「高级」（首次完整人设引导用；已填过高级项时也会自动展开） */
  expandAdvanced?: boolean;
  /** 覆盖标题栏文案（不传按 mode 取「新建助理 / 编辑人设」） */
  heading?: string;
  /** 保存中：禁用按钮，避免重复提交 */
  saving?: boolean;
  /** 保存失败的原因（服务端错误 / 网络错误），显示在页脚上方 */
  error?: string | null;
  onCancel: () => void;
  onSubmit: (persona: ButlerPersona) => void;
  /**
   * 删除该好友（仅编辑态传入；常驻通知助理没有编辑入口，故天然拿不到）。
   * 组件只负责把点击转出去 —— 确认弹窗与删除请求都由调用方走同一条 deleteThread。
   */
  onDelete?: () => void;
}

export default function PersonaDialog({ mode, initial, fixedName, expandAdvanced, heading, saving, error, onCancel, onSubmit, onDelete }: PersonaDialogProps) {
  const [name, setName] = useState(fixedName ?? initial?.name ?? '');
  const [personality, setPersonality] = useState(initial?.personality ?? '');
  const [role, setRole] = useState(initial?.role ?? '');
  const [style, setStyle] = useState(initial?.style ?? '');
  const [addressUser, setAddressUser] = useState(initial?.addressUser ?? '');
  const [template, setTemplate] = useState(initial?.template ?? '');
  const [advancedOpen, setAdvancedOpen] = useState(!!expandAdvanced);

  /** 高级里是否已有内容（编辑态若填过，默认展开，否则用户会以为丢了） */
  const advancedFilled = useMemo(
    () => !!(initial?.role || initial?.style || initial?.addressUser),
    [initial],
  );
  useEffect(() => {
    if (advancedFilled) setAdvancedOpen(true);
  }, [advancedFilled]);

  // Esc 关闭（未保存即放弃）；保存中不响应，避免关到一半
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, saving]);

  const canSubmit = !!(fixedName ?? name.trim()) && !saving;

  const submit = () => {
    if (!canSubmit) return;
    const trim = (s: string) => s.trim().slice(0, FIELD_MAX) || undefined;
    onSubmit({
      name: (fixedName ?? name.trim()).slice(0, FIELD_MAX),
      personality: trim(personality),
      role: trim(role),
      style: trim(style),
      addressUser: trim(addressUser),
      template: template || undefined,
    });
  };

  const inputStyle = {
    backgroundColor: 'var(--paper)',
    border: '1px solid var(--line)',
    color: 'var(--ink-strong)',
  } as const;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-6"
      style={{ zIndex: 1400, background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={onCancel}
    >
      <div
        className="flex w-full max-w-[480px] flex-col rounded-2xl p-5"
        style={{
          backgroundColor: 'var(--popover)',
          border: '1px solid var(--border)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.24), 0 6px 16px rgba(0,0,0,0.10)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="text-sm font-semibold" style={{ color: 'var(--ink-strong)' }}>
            {heading ?? (mode === 'create' ? '新建助理' : '编辑人设')}
          </div>
          {/* 删除好友：编辑态才出现，固定在标题栏右侧（原先在联系人行的行尾）。
              点它只是把事件转给调用方 —— 那边会先弹确认，再走 deleteThread。 */}
          {mode === 'edit' && onDelete && (
            <button
              type="button"
              onClick={onDelete}
              disabled={saving}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-50"
              style={{ color: 'var(--ink-faint)' }}
              title="Delete friend"
              aria-label="Delete friend"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* 姓名（必填）—— 同时是联系人行与中栏的标题。
            系统身份（fixedName）名字钉死：不渲染输入框，只做只读展示，避免改名丢掉钉死的形象 */}
        <label className="mb-1 block text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>
          姓名
        </label>
        {fixedName ? (
          <div
            className="mb-3 w-full rounded-lg px-2.5 py-1.5 text-xs"
            style={{ ...inputStyle, opacity: 0.7 }}
          >
            {fixedName}
          </div>
        ) : (
          <input
            autoFocus
            value={name}
            maxLength={FIELD_MAX}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="例如：小助、法务小张"
            className="mb-3 w-full rounded-lg px-2.5 py-1.5 text-xs outline-none"
            style={inputStyle}
          />
        )}

        {/* 性格：模板 chips + 自由文本 */}
        <label className="mb-1 block text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>
          性格
        </label>
        <div className="mb-2 flex flex-wrap gap-1">
          {PERSONA_TEMPLATES.map((t) => {
            const active = template === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setTemplate(t.id);
                  if (t.id !== 'custom') setPersonality(t.personality);
                }}
                className="rounded-full px-2.5 py-1 text-11 transition-colors"
                style={{
                  backgroundColor: active ? 'var(--primary-soft)' : 'var(--paper)',
                  border: `1px solid ${active ? 'var(--primary)' : 'var(--line)'}`,
                  color: active ? 'var(--primary-strong)' : 'var(--ink-muted)',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <textarea
          value={personality}
          maxLength={FIELD_MAX}
          onChange={(e) => setPersonality(e.target.value)}
          rows={2}
          placeholder="例如：高冷话少，但对我的事格外上心"
          className="mb-3 w-full resize-none rounded-lg px-2.5 py-1.5 text-xs outline-none"
          style={inputStyle}
        />

        {/* 高级：身份 / 风格 / 称呼用户（默认折叠，不填就不注入） */}
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="mb-2 flex items-center gap-1 self-start text-11"
          style={{ color: 'var(--ink-faint)' }}
        >
          {advancedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          高级
        </button>
        {advancedOpen && (
          <div className="mb-1 flex flex-col gap-2">
            <input
              value={role}
              maxLength={FIELD_MAX}
              onChange={(e) => setRole(e.target.value)}
              placeholder="身份 / 职责边界（如：只聊工作安排）"
              className="w-full rounded-lg px-2.5 py-1.5 text-xs outline-none"
              style={inputStyle}
            />
            <input
              value={style}
              maxLength={FIELD_MAX}
              onChange={(e) => setStyle(e.target.value)}
              placeholder="说话风格（如：简短、少用敬语）"
              className="w-full rounded-lg px-2.5 py-1.5 text-xs outline-none"
              style={inputStyle}
            />
            <input
              value={addressUser}
              maxLength={FIELD_MAX}
              onChange={(e) => setAddressUser(e.target.value)}
              placeholder="如何称呼我（如：老板）"
              className="w-full rounded-lg px-2.5 py-1.5 text-xs outline-none"
              style={inputStyle}
            />
          </div>
        )}

        {error && (
          <div className="mt-3 text-11" style={{ color: 'var(--danger)' }}>
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" onClick={onCancel} disabled={saving} variant="soft" tone="neutral" size="sm">
            取消
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            loading={saving}
            variant="solid"
            tone="brand"
            size="sm"
          >
            {mode === 'create' ? '创建' : '保存'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}