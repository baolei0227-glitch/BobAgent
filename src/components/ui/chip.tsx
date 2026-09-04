import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

/** Chip：筛选标签（NodeMap 过滤、模型角色池选中项等）。
 *  与 Badge 的区别：Chip 是"交互型"——可点、可关；Badge 是"陈述型"信息标。
 *  - 8 变体：6 语义色 + muted(辅助灰) + paper(纸面描边，默认选中态)
 *  - 2 尺寸：sm(20px 高)/md(24px 高)
 *  - 可关闭：dismissible + onDismiss 显示 × 按钮
 *  - 可选前缀图标 icon slot
 *  - 可选 selected 态（paper 变体用"实心主色"展示，其他变体加 2px 描边环）
 */
const chipVariants = cva(
  'group inline-flex shrink-0 items-center select-none rounded-full border transition-all duration-[var(--dur-2)] ease-out cursor-pointer [&_svg]:pointer-events-none',
  {
    variants: {
      variant: {
        primary: '',
        info: '',
        success: '',
        warn: '',
        danger: '',
        purple: '',
        muted: '',
        paper: '',
      },
      size: {
        sm: 'gap-x-1 h-5 pl-1.5 pr-1.5 text-11 leading-none',
        md: 'gap-x-1.5 h-6 pl-2 pr-2 text-12 leading-none',
      },
      selected: {
        true: '',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'paper',
      size: 'sm',
      selected: false,
    },
  },
);

/** variant → 未选中 / 选中 两套颜色映射（读 Phase 1 CSS vars，六主题自动适配） */
type Pair = { base: React.CSSProperties; selected: React.CSSProperties };
const VARIANT_PAIRS: Record<NonNullable<VariantProps<typeof chipVariants>['variant']>, Pair> = {
  primary: {
    base:     { backgroundColor: 'var(--primary-faint)',  borderColor: 'color-mix(in oklab, var(--primary) 20%, transparent)', color: 'var(--primary-solid)' },
    selected: { backgroundColor: 'var(--primary-solid)',  borderColor: 'var(--primary-solid)',  color: 'var(--primary-fg, oklch(1 0 0))' },
  },
  info: {
    base:     { backgroundColor: 'var(--info-faint)',     borderColor: 'color-mix(in oklab, var(--info) 20%, transparent)', color: 'var(--info-solid)' },
    selected: { backgroundColor: 'var(--info-solid)',     borderColor: 'var(--info-solid)',     color: 'white' },
  },
  success: {
    base:     { backgroundColor: 'var(--success-faint)',  borderColor: 'color-mix(in oklab, var(--success) 20%, transparent)', color: 'var(--success-solid)' },
    selected: { backgroundColor: 'var(--success-solid)',  borderColor: 'var(--success-solid)',  color: 'white' },
  },
  warn: {
    base:     { backgroundColor: 'var(--warn-faint)',     borderColor: 'color-mix(in oklab, var(--warn) 22%, transparent)', color: 'color-mix(in oklab, var(--warn-solid) 85%, var(--ink))' },
    selected: { backgroundColor: 'var(--warn-solid)',     borderColor: 'var(--warn-solid)',     color: 'color-mix(in oklab, var(--warn-solid) 10%, white)' },
  },
  danger: {
    base:     { backgroundColor: 'var(--danger-faint)',   borderColor: 'color-mix(in oklab, var(--danger) 20%, transparent)', color: 'var(--danger-solid)' },
    selected: { backgroundColor: 'var(--danger-solid)',   borderColor: 'var(--danger-solid)',   color: 'white' },
  },
  purple: {
    base:     { backgroundColor: 'var(--purple-faint)',   borderColor: 'color-mix(in oklab, var(--purple) 20%, transparent)', color: 'var(--purple-solid)' },
    selected: { backgroundColor: 'var(--purple-solid)',   borderColor: 'var(--purple-solid)',   color: 'white' },
  },
  muted: {
    base:     { backgroundColor: 'color-mix(in oklab, var(--paper-muted) 60%, transparent)', borderColor: 'var(--ink-dim)',                                        color: 'var(--ink-muted)' },
    selected: { backgroundColor: 'var(--ink-faint)',                                              borderColor: 'var(--ink-muted)',                                      color: 'var(--ink-strong)' },
  },
  paper: {
    base:     { backgroundColor: 'var(--paper-muted)',   borderColor: 'var(--ink-dim)',   color: 'var(--ink-muted)' },
    selected: { backgroundColor: 'var(--primary-solid)', borderColor: 'var(--primary-solid)', color: 'var(--primary-fg, oklch(1 0 0))' },
  },
};

const DISMISS_STYLES_BY_SIZE: Record<NonNullable<VariantProps<typeof chipVariants>['size']>, { box: string; icon: string }> = {
  sm: { box: 'h-3.5 w-3.5', icon: 'h-3 w-3' },
  md: { box: 'h-4 w-4',     icon: 'h-3.5 w-3.5' },
};

export type ChipVariant = NonNullable<VariantProps<typeof chipVariants>['variant']>;
export type ChipSize = NonNullable<VariantProps<typeof chipVariants>['size']>;

export interface ChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'>,
    VariantProps<typeof chipVariants> {
  icon?: React.ReactNode;
  label?: React.ReactNode;
  children?: React.ReactNode;
  /** 是否显示右侧 × 关闭按钮 */
  dismissible?: boolean;
  /** 点击 × 触发（不冒泡到 chip 本身的 onClick） */
  onDismiss?: (e: React.MouseEvent) => void;
}

function Chip({
  className,
  variant,
  size = 'sm',
  selected = false,
  icon,
  label,
  children,
  dismissible = false,
  onDismiss,
  style,
  type = 'button',
  ...props
}: ChipProps) {
  const v = variant ?? 'paper';
  const pair = VARIANT_PAIRS[v];
  const mergedStyle: React.CSSProperties | undefined = style
    ? { ...(selected ? pair.selected : pair.base), ...style }
    : (selected ? pair.selected : pair.base);
  const content = label ?? children;
  const dim = DISMISS_STYLES_BY_SIZE[size ?? 'sm'];

  return (
    <button
      type={type}
      data-slot="chip"
      data-variant={v}
      data-size={size}
      data-selected={selected ? 'true' : 'false'}
      className={cn(chipVariants({ variant: v, size, selected, className }), 'hover:brightness-[1.03] active:scale-[0.98] focus-visible:z-10')}
      style={mergedStyle}
      {...props}
    >
      {icon}
      <span className="truncate">{content}</span>
      {dismissible && (
        <span
          role="button"
          aria-label="dismiss"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onDismiss?.(e);
          }}
          className={cn(
            dim.box,
            'ml-0.5 shrink-0 inline-flex items-center justify-center rounded-full opacity-70 hover:opacity-100 transition-opacity duration-[var(--dur-1)]',
            'group-hover:opacity-100',
            selected ? 'hover:bg-black/10' : 'hover:bg-black/5 dark:hover:bg-white/10',
          )}
        >
          <X className={dim.icon} />
        </span>
      )}
    </button>
  );
}

export { Chip, chipVariants };
