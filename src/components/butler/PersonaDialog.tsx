'use client';

/**
 * PersonaDialog —— 会话人设弹窗（新建助理 / 编辑人设）
 *
 * 归属：人设与 Butler 线程**同行**存储（见 lib/butler/threads.ts），所以「删除会话即删除人设」。
 * 本组件只负责收集表单并回传 ButlerPersona，落库由调用方（ButlerDrawer）走
 * POST /api/butler/threads/session（创建态）或 PATCH ?threadId=（编辑态）。
 *
 * 形态参照「配置类界面一律极简」：只露**姓名 + 性格 + 头像**三栏；
 * 身份 / 风格 / 如何称呼用户收进默认折叠的「高级」，不填就不注入该维度。
 * 头像默认落在 Auto（= 沿用性格/名字派生），所以「不管它」与引入该栏之前完全一致；
 * 系统身份（fixedName = Bobby / 小微）整块不渲染 —— 它们的形象按显示名钉死，不参与覆盖。
 *
 * 用 portal 挂到 body：抽屉根节点带 transform（居中弹窗），fixed 子元素会被它当包含块，
 * 直接内联渲染会跟着抽屉一起偏移。
 *
 * 编辑态另在**标题栏右侧**放一个删除好友的键（原先挂在联系人行的行尾）：
 * 行内那个键只在悬停时才看得见、又紧挨着「切换会话」的热区，容易误点；
 * 挪进弹窗后，「改人设」和「删好友」收在同一处。真正删除仍由调用方负责（确认 + 落库）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PERSONA_AVATAR_IDS } from '@/lib/butler/avatar';
import type { ButlerPersona } from '@/lib/butler/threads-shared';
import PersonaAvatar from './PersonaAvatar';

/** 与会话路由的 FIELD_MAX 对齐：人设要进系统提示，别让一屏文本吃掉上下文 */
const FIELD_MAX = 200;

/** 自定义头像体积上限（与 /api/butler/avatar 的读取上限一致）：超了存进去也读不出来，不如上传前当场拦 */
const AVATAR_MAX_BYTES = 8 * 1024 * 1024;

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
  /**
   * 该人设所属的线程 id —— 仅用于**自定义头像上传**的归档路径（服务端按 threadId 解析角色目录）。
   * 创建态还没有线程（传 undefined）：图会落到兜底角色「未分类」，仍能被头像接口读回，不影响功能。
   */
  threadId?: string;
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

export default function PersonaDialog({ mode, initial, threadId, fixedName, expandAdvanced, heading, saving, error, onCancel, onSubmit, onDelete }: PersonaDialogProps) {
  const [name, setName] = useState(fixedName ?? initial?.name ?? '');
  const [personality, setPersonality] = useState(initial?.personality ?? '');
  const [role, setRole] = useState(initial?.role ?? '');
  const [style, setStyle] = useState(initial?.style ?? '');
  const [addressUser, setAddressUser] = useState(initial?.addressUser ?? '');
  const [template, setTemplate] = useState(initial?.template ?? '');
  const [advancedOpen, setAdvancedOpen] = useState(!!expandAdvanced);
  /** 内置头像选择：'' = Auto（沿用「性格关键词 → 名字散列」的派生）。与 avatarImage 互斥 */
  const [avatarId, setAvatarId] = useState<string>(initial?.avatar ?? '');
  /** 自定义头像（butler/ 内的绝对路径）；有值即优先于 avatarId 渲染 */
  const [avatarImage, setAvatarImage] = useState<string | undefined>(initial?.avatarImage);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const avatarFileRef = useRef<HTMLInputElement>(null);

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

  /**
   * 选图 → 读成 base64 → 复用 Butler 附件端点落盘 → 拿回**绝对路径**存进 persona.avatarImage。
   * 不内联 dataURL：头像要在联系人列 / 每条气泡各渲染一次，base64 会把每次列表刷新都撑大，
   * 故存路径、由 /api/butler/avatar 按需回读（路径即内容指纹，换图即换 URL）。
   */
  const uploadAvatar = async (file: File) => {
    setAvatarError(null);
    if (!file.type.startsWith('image/')) {
      setAvatarError('Only image files are supported');
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError('Image too large (max 8MB)');
      return;
    }
    setAvatarUploading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Failed to read the image'));
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.split(',')[1] || '';
      const res = await fetch('/api/butler/attachments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, fileName: file.name, fileType: file.type, data: base64 }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        attachment?: { path?: string };
        error?: string;
      };
      if (!res.ok || !data.success || !data.attachment?.path) throw new Error(data.error || `HTTP ${res.status}`);
      setAvatarImage(data.attachment.path);
      setAvatarId(''); // 互斥：自定义图优先，清掉内置选项
    } catch (e) {
      setAvatarError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setAvatarUploading(false);
    }
  };

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
      // 头像：系统身份（fixedName）不渲染选择区，这两个值天然为空 → 不会写入，钉死形象不受影响
      avatar: avatarImage ? undefined : (avatarId || undefined) as ButlerPersona['avatar'],
      avatarImage,
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

        {/* 头像（2026-10-18）：**系统身份（fixedName）整块不渲染** —— Bobby / 小微 的形象与底色按
            显示名钉死（见 lib/butler/avatar.ts 的 SYSTEM_IDENTITIES），本就不参与覆盖。
            其余好友：Auto（沿用「性格关键词 → 名字散列」的派生）+ 10 张内置 + 自定义上传；
            选一个即清另一个（自定义图优先渲染）。默认落在 Auto，所以「不管它」与从前完全一致。 */}
        {!fixedName && (
          <>
            <label className="mb-1 block text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>
              头像
            </label>
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setAvatarId('');
                  setAvatarImage(undefined);
                }}
                className="flex h-8 items-center rounded-lg px-2 text-11 transition-colors"
                style={{
                  backgroundColor: !avatarId && !avatarImage ? 'var(--primary-soft)' : 'var(--paper)',
                  border: `1px solid ${!avatarId && !avatarImage ? 'var(--primary)' : 'var(--line)'}`,
                  color: !avatarId && !avatarImage ? 'var(--primary-strong)' : 'var(--ink-muted)',
                }}
                title="Auto (derived from personality)"
              >
                Auto
              </button>
              {avatarImage && (
                <span
                  className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg"
                  style={{ border: '1px solid var(--primary)' }}
                  title="Custom image"
                >
                  <img
                    src={`/api/butler/avatar?path=${encodeURIComponent(avatarImage)}`}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </span>
              )}
              {PERSONA_AVATAR_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setAvatarId(id);
                    setAvatarImage(undefined);
                  }}
                  className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg transition-colors"
                  style={{
                    backgroundColor: 'var(--paper)',
                    border: `1px solid ${!avatarImage && avatarId === id ? 'var(--primary)' : 'var(--line)'}`,
                  }}
                  title={id}
                >
                  <PersonaAvatar id={id} />
                </button>
              ))}
              <button
                type="button"
                onClick={() => avatarFileRef.current?.click()}
                disabled={avatarUploading}
                className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-50"
                style={{ border: '1px solid var(--line)', color: 'var(--ink-muted)' }}
                title="Upload image"
                aria-label="Upload image"
              >
                {avatarUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
              </button>
            </div>
            {avatarError && (
              <div className="mb-2 text-11" style={{ color: 'var(--danger)' }}>
                {avatarError}
              </div>
            )}
            <input
              ref={avatarFileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                // 先清空：同一张图再次选中也要能触发 change（否则选第二次时 value 未变、onChange 不响）
                e.target.value = '';
                if (picked) void uploadAvatar(picked);
              }}
            />
          </>
        )}

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