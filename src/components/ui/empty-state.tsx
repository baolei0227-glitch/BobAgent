import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { FileSearch, Rocket, Ban, Inbox, Network, Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';

/** EmptyState：统一空状态画面。
 *  - 统一 48~72px 图标区 + 标题 + 描述 + 操作区
 *  - 4 preset 插画名（搜索无结果 / 初次引导 / 权限受阻 / 收件箱空）+ 自定义 icon 覆盖
 *  - 2 尺寸：md 默认 / sm 紧凑嵌入列表卡片
 *  - 可选 variant tone：muted 默认灰调 / primary 强调（新用户引导）/ accent 彩虹
 */
const emptyStateVariants = cva(
  'relative flex w-full flex-col items-center text-center select-none',
  {
    variants: {
      size: {
        sm: 'gap-y-2 py-4',
        md: 'gap-y-3 py-8',
        lg: 'gap-y-4 py-12',
      },
      tone: {
        muted: '',
        primary: '',
        accent: '',
      },
    },
    defaultVariants: {
      size: 'md',
      tone: 'muted',
    },
  },
);

const ICON_WRAP_STYLES: Record<NonNullable<VariantProps<typeof emptyStateVariants>['tone']>, React.CSSProperties> = {
  muted:   { background: 'color-mix(in oklab, var(--paper-muted) 60%, transparent)', color: 'var(--ink-muted)', borderColor: 'var(--ink-dim)' },
  primary: { background: 'var(--primary-faint)',                      color: 'var(--primary-solid)',                borderColor: 'color-mix(in oklab, var(--primary) 22%, transparent)' },
  accent:  { background: 'linear-gradient(135deg, var(--primary-faint), var(--purple-faint))', color: 'var(--primary-solid)', borderColor: 'color-mix(in oklab, var(--primary) 22%, transparent)' },
};

const ICON_SIZE_BY_SIZE = {
  sm: { wrap: 'h-12 w-12',   icon: 'h-6 w-6',   radius: 'var(--radius-lg)' },
  md: { wrap: 'h-16 w-16',   icon: 'h-8 w-8',   radius: 'var(--radius-xl)' },
  lg: { wrap: 'h-20 w-20',   icon: 'h-10 w-10', radius: 'var(--radius-2xl)' },
} as const;

const PRESET_ICONS = {
  search:  FileSearch,
  welcome: Rocket,
  blocked: Ban,
  inbox:   Inbox,
  graph:   Network,
  sparkle: Sparkles,
} as const;

export type EmptyStatePreset = keyof typeof PRESET_ICONS;
export type EmptyStateSize = NonNullable<VariantProps<typeof emptyStateVariants>['size']>;
export type EmptyStateTone = NonNullable<VariantProps<typeof emptyStateVariants>['tone']>;

export interface EmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>,
    VariantProps<typeof emptyStateVariants> {
  /** 预设插画名：search/welcome/blocked/inbox/graph/sparkle，或传自定义 `icon` 覆盖 */
  preset?: EmptyStatePreset;
  /** 自定义图标（ReactNode，覆盖 preset）。传 `null` 可强制不显示图标框 */
  icon?: React.ReactNode | null;
  /** 标题（推荐 <= 20 字） */
  title: React.ReactNode;
  /** 描述行（推荐 <= 2 行；可传字符串或 React 元素数组） */
  description?: React.ReactNode;
  /** 主操作区（通常放一个 `btn btn-primary btn-md`） */
  action?: React.ReactNode;
  /** 次要操作区（放在 action 下方的小链接、次要按钮组） */
  subAction?: React.ReactNode;
}

function EmptyState({
  className,
  size = 'md',
  tone = 'muted',
  preset = 'search',
  icon,
  title,
  description,
  action,
  subAction,
  ...props
}: EmptyStateProps) {
  const sizes = ICON_SIZE_BY_SIZE[size ?? 'md'];
  const wrapStyle = ICON_WRAP_STYLES[tone ?? 'muted'];

  const TitleFont = size === 'sm' ? 'text-13' : size === 'lg' ? 'text-17' : 'text-15';
  const DescFont  = size === 'sm' ? 'text-12' : size === 'lg' ? 'text-14' : 'text-13';

  const PresetIcon = PRESET_ICONS[preset];
  const showIconWrap = icon !== null;

  return (
    <div
      data-slot="empty-state"
      data-size={size}
      data-tone={tone}
      className={cn(emptyStateVariants({ size, tone, className }))}
      {...props}
    >
      {showIconWrap && (
        <div
          className={cn(
            sizes.wrap,
            'shrink-0 inline-flex items-center justify-center border',
          )}
          style={{ borderRadius: sizes.radius, ...wrapStyle }}
          aria-hidden
        >
          {icon ?? <PresetIcon className={sizes.icon} strokeWidth={1.75} />}
        </div>
      )}

      <div className="w-full max-w-md flex flex-col items-center gap-y-1.5 px-1">
        <div
          className={cn('font-semibold tracking-tight', TitleFont)}
          style={{ color: 'var(--ink-strong)' }}
        >
          {title}
        </div>
        {description && (
          <div
            className={cn('leading-relaxed', DescFont)}
            style={{ color: 'var(--ink-muted)' }}
          >
            {description}
          </div>
        )}
      </div>

      {(action || subAction) && (
        <div
          className={cn(
            'mt-1 flex flex-col items-center justify-center gap-y-2',
            size === 'sm' ? 'gap-y-1.5' : 'gap-y-2',
          )}
        >
          {action && <div className="inline-flex items-center gap-2">{action}</div>}
          {subAction && (
            <div className="inline-flex items-center gap-2" style={{ color: 'var(--ink-muted)' }}>
              {subAction}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { EmptyState, emptyStateVariants };
