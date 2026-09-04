import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertCircle, Info, CheckCircle2, AlertTriangle, XCircle, Sparkles, X } from 'lucide-react';

import { cn } from '@/lib/utils';

/** Callout：全局告警/提示条。用于空状态、错误提示、操作成功横幅、升级引导等。
 *  - 6 语义色 + accent(彩虹强调/推广位) 共 7 变体
 *  - 结构：左侧语义 Icon（或自定义） + 中部 title/description + 右侧 CTA/Dismiss
 *  - 尺寸：默认 md(大横幅) / sm(紧凑内嵌表单提示)
 */
const calloutVariants = cva(
  'relative flex w-full gap-x-3 rounded-[var(--radius-lg)] border px-3.5 py-3 text-13 leading-[1.5] transition-[box-shadow,background-color] duration-[var(--dur-2)] ease-out',
  {
    variants: {
      variant: {
        info:    '',
        success: '',
        warn:    '',
        danger:  '',
        primary: '',
        purple:  '',
        accent:  '',
      },
      size: {
        sm: 'gap-x-2 rounded-[var(--radius-md)] px-2.5 py-2 text-12',
        md: '',
      },
    },
    defaultVariants: {
      variant: 'info',
      size: 'md',
    },
  },
);

type VariantColor = NonNullable<VariantProps<typeof calloutVariants>['variant']>;

/** 每个变体对应的：背景 / 边框 / 文字 / 图标色 */
interface CalloutPalette {
  bg: string;
  border: string;
  fg: string;
  muted: string;
  icon: string;
}
const PALETTE: Record<VariantColor, CalloutPalette> = {
  info: {
    bg:     'color-mix(in oklab, var(--info) 7%, var(--paper-muted))',
    border: 'color-mix(in oklab, var(--info) 22%, transparent)',
    fg:     'var(--ink)',
    muted:  'var(--ink-muted)',
    icon:   'var(--info-solid)',
  },
  success: {
    bg:     'color-mix(in oklab, var(--success) 7%, var(--paper-muted))',
    border: 'color-mix(in oklab, var(--success) 22%, transparent)',
    fg:     'var(--ink)',
    muted:  'var(--ink-muted)',
    icon:   'var(--success-solid)',
  },
  warn: {
    bg:     'color-mix(in oklab, var(--warn) 9%, var(--paper-muted))',
    border: 'color-mix(in oklab, var(--warn) 25%, transparent)',
    fg:     'var(--ink)',
    muted:  'var(--ink-muted)',
    icon:   'color-mix(in oklab, var(--warn-solid) 85%, var(--ink))',
  },
  danger: {
    bg:     'color-mix(in oklab, var(--danger) 8%, var(--paper-muted))',
    border: 'color-mix(in oklab, var(--danger) 25%, transparent)',
    fg:     'var(--ink)',
    muted:  'var(--ink-muted)',
    icon:   'var(--danger-solid)',
  },
  primary: {
    bg:     'color-mix(in oklab, var(--primary) 8%, var(--paper-muted))',
    border: 'color-mix(in oklab, var(--primary) 25%, transparent)',
    fg:     'var(--ink)',
    muted:  'var(--ink-muted)',
    icon:   'var(--primary-solid)',
  },
  purple: {
    bg:     'color-mix(in oklab, var(--purple) 8%, var(--paper-muted))',
    border: 'color-mix(in oklab, var(--purple) 25%, transparent)',
    fg:     'var(--ink)',
    muted:  'var(--ink-muted)',
    icon:   'var(--purple-solid)',
  },
  accent: {
    bg:     'linear-gradient(110deg, color-mix(in oklab, var(--primary) 10%, var(--paper-muted)) 0%, color-mix(in oklab, var(--purple) 10%, var(--paper-muted)) 60%, color-mix(in oklab, var(--info) 8%, var(--paper-muted)) 100%)',
    border: 'color-mix(in oklab, var(--primary) 22%, transparent)',
    fg:     'var(--ink)',
    muted:  'var(--ink-muted)',
    icon:   'var(--primary-solid)',
  },
};

const DEFAULT_ICONS: Record<VariantColor, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  danger: XCircle,
  primary: AlertCircle,
  purple: Sparkles,
  accent: Sparkles,
};

export type CalloutVariant = VariantColor;
export type CalloutSize = NonNullable<VariantProps<typeof calloutVariants>['size']>;

export interface CalloutProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>,
    VariantProps<typeof calloutVariants> {
  /** 标题（加粗第一行） */
  title?: React.ReactNode;
  /** 描述（标题下的小字，颜色 muted） */
  description?: React.ReactNode;
  /** 自定义左侧图标；默认按语义色选 Info/CheckCircle2 等 */
  icon?: React.ReactNode | false;
  /** 右侧操作区（通常放"查看详情"/"立即修复"等 CTA 按钮） */
  action?: React.ReactNode;
  /** 可关闭：显示右上角 × */
  dismissible?: boolean;
  /** 关闭回调 */
  onDismiss?: () => void;
}

function Callout({
  className,
  variant = 'info',
  size = 'md',
  title,
  description,
  icon,
  action,
  dismissible = false,
  onDismiss,
  style,
  ...props
}: CalloutProps) {
  const v = variant ?? 'info';
  const palette = PALETTE[v];
  const bgIsGradient = v === 'accent';
  const rootStyle: React.CSSProperties | undefined = (() => {
    const base: React.CSSProperties = {
      background: bgIsGradient ? palette.bg : undefined,
      backgroundColor: bgIsGradient ? undefined : palette.bg,
      borderColor: palette.border,
      color: palette.fg,
    };
    return style ? { ...base, ...style } : base;
  })();

  const IconComp = icon === false ? null : DEFAULT_ICONS[v];
  const iconSize = size === 'sm' ? 'h-4 w-4 shrink-0 mt-[1px]' : 'h-[18px] w-[18px] shrink-0 mt-[2px]';
  const dimIcon = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';

  return (
    <div
      data-slot="callout"
      data-variant={variant}
      data-size={size}
      role="status"
      className={cn(calloutVariants({ variant, size, className }))}
      style={rootStyle}
      {...props}
    >
      {/* 左侧语义图标 */}
      {icon !== false && icon !== undefined ? (
        <div className={iconSize} style={{ color: palette.icon }} aria-hidden>
          {icon}
        </div>
      ) : IconComp ? (
        <IconComp className={iconSize} style={{ color: palette.icon }} aria-hidden />
      ) : null}

      {/* 中间标题 + 描述 */}
      <div className="min-w-0 flex-1">
        {title && (
          <div className={cn('font-semibold tracking-tight', size === 'sm' ? 'text-12.5' : 'text-13.5')}>
            {title}
          </div>
        )}
        {description && (
          <div
            className={cn(
              'min-w-0 break-words',
              size === 'sm' ? 'mt-0.5' : 'mt-1',
            )}
            style={{ color: palette.muted }}
          >
            {description}
          </div>
        )}
        {!title && !description && props.children && (
          <div style={{ color: palette.muted }}>{props.children}</div>
        )}
      </div>

      {/* 右侧 CTA */}
      {action && (
        <div className="shrink-0 flex items-center self-start pt-[1px]">
          {action}
        </div>
      )}

      {/* 右上角关闭按钮 */}
      {dismissible && (
        <button
          type="button"
          aria-label="close callout"
          onClick={onDismiss}
          className={cn(
            'absolute top-2 right-2 inline-flex items-center justify-center rounded-[var(--radius-sm)] transition-all duration-[var(--dur-1)] hover:opacity-100 focus-visible:z-10',
            size === 'sm' ? 'h-5 w-5 opacity-70' : 'h-6 w-6 opacity-60',
          )}
          style={{ color: palette.muted }}
        >
          <X className={dimIcon} />
        </button>
      )}
    </div>
  );
}

export { Callout, calloutVariants };
