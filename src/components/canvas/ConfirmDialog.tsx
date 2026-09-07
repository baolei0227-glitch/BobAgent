import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * 应用内确认弹窗（BobWork 暖色风格，portal 到 body 避免被 ReactFlow transform 影响）。
 * 文案为 macOS 原生 confirm 风格（英文），样式为应用内置。
 * 支持可选锚点：传入 anchor 时弹窗显示在锚点（如对话输入框顶部）上方，否则视口居中。
 */
/** 多选弹窗的选项按钮 */
export interface ConfirmDialogChoice {
  label: string;
  /** 点击后 askChoices 返回的标识值 */
  value: string;
  /** 主危险色按钮（红色强调，如"归档并完成全部"） */
  danger?: boolean;
}

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string; // default 'Delete'
  cancelLabel?: string; // default 'Cancel'
  /** 可选锚点（如对话输入框顶部中心）：传入时在锚点上方弹出，否则视口居中 */
  anchor?: { x: number; y: number } | null;
  /** 可选：传多个选项按钮（二选一/多选），此时忽略 confirmLabel/cancelLabel，取消仍可用 */
  choices?: ConfirmDialogChoice[];
}

/** 锚点定位：弹窗在锚点上方居中（水平钳制在视口内；锚点过靠上时改到下方显示） */
function computeAnchorStyle(anchor: { x: number; y: number }): CSSProperties {
  const cardW = 400;
  const vw = window.innerWidth;
  const left = Math.max(8, Math.min(anchor.x - cardW / 2, vw - cardW - 8));
  const showBelow = anchor.y < 340;
  return {
    position: 'fixed',
    left,
    top: showBelow ? anchor.y + 12 : anchor.y - 12,
    transform: showBelow ? undefined : 'translateY(-100%)',
  };
}

export function ConfirmDialog({
  options,
  onConfirm,
  onCancel,
  onChoice,
}: {
  options: ConfirmDialogOptions | null;
  onConfirm: () => void;
  onCancel: () => void;
  onChoice: (value: string) => void;
}) {
  useEffect(() => {
    if (!options) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [options, onCancel]);

  if (!options) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.35)' }}
      onClick={onCancel}
    >
      <div
        className="w-[400px] rounded-xl border shadow-lg"
        style={{
          backgroundColor: 'var(--popover)',
          borderColor: 'var(--line)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
          ...(options.anchor ? computeAnchorStyle(options.anchor) : {}),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2 px-4 pt-4">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0"
            style={{ color: 'var(--danger)' }}
          />
          <span
            className="text-base font-semibold leading-snug"
            style={{ color: 'var(--ink)' }}
          >
            {options.title}
          </span>
        </div>
        <div
          className="whitespace-pre-line px-4 pb-1 pt-2 text-sm leading-relaxed"
          style={{ color: 'var(--ink-muted)' }}
        >
          {options.message}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 pb-4 pt-3">
          {Array.isArray(options.choices) && options.choices.length > 0 ? (
            // 多选模式：选项按钮 + Cancel（忽略 confirmLabel/cancelLabel）
            <>
              {options.choices.map((c) => (
                <Button
                  key={c.value}
                  onClick={() => onChoice(c.value)}
                  variant="solid"
                  tone={c.danger ? 'danger' : 'brand'}
                  size="md"
                >
                  {c.label}
                </Button>
              ))}
              <Button
                onClick={onCancel}
                variant="soft"
                tone="neutral"
                size="md"
              >
                {options.cancelLabel || 'Cancel'}
              </Button>
            </>
          ) : (
            <>
              <Button
                onClick={onCancel}
                variant="soft"
                tone="neutral"
                size="md"
              >
                {options.cancelLabel || 'Cancel'}
              </Button>
              <Button
                onClick={onConfirm}
                variant="solid"
                tone="danger"
                size="md"
              >
                {options.confirmLabel || 'Delete'}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 弹窗控制 hook：ask() 返回 Promise<boolean>，组件内挂载 render 即可。
 *  并发确认排队（FIFO）：同一组件内多个 ask() 依次弹出，前一个关闭后才显示下一个，
 *  避免并发 tool_confirm 互相覆盖导致前一个 Promise 永不 resolve（服务端等确认超时后静默跳过工具）。 */
export function useConfirm() {
  const [queue, setQueue] = useState<Array<ConfirmDialogOptions & { id: number }>>([]);
  const idRef = useRef(0);
  // resolver 可返回 boolean（ask，confirm/cancel）或 string|null（askChoices，多选按钮）
  const resolverRef = useRef<Map<number, (v: boolean | string | null) => void>>(new Map());

  const ask = useCallback((o: ConfirmDialogOptions) => {
    return new Promise<boolean>((resolve) => {
      const id = ++idRef.current;
      resolverRef.current.set(id, resolve as (v: boolean | string | null) => void);
      setQueue((q) => [...q, { ...o, id }]);
    });
  }, []);

  /** 多选确认：options.choices 渲染多个选项按钮，返回所选 value；取消/关闭返回 null */
  const askChoices = useCallback((o: ConfirmDialogOptions) => {
    return new Promise<string | null>((resolve) => {
      const id = ++idRef.current;
      resolverRef.current.set(id, resolve as (v: boolean | string | null) => void);
      setQueue((q) => [...q, { ...o, id }]);
    });
  }, []);

  const close = useCallback((id: number, v: boolean | string | null) => {
    resolverRef.current.get(id)?.(v);
    resolverRef.current.delete(id);
    setQueue((q) => q.filter((item) => item.id !== id));
  }, []);

  const current = queue[0] ?? null;
  const render = (
    <ConfirmDialog
      options={current}
      onConfirm={() => current && close(current.id, true)}
      onCancel={() => current && close(current.id, false)}
      onChoice={(value) => current && close(current.id, value)}
    />
  );

  return { ask, askChoices, render };
}
