import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/** 统一徽章：节点类型标识（C/Code/🖼）、状态指示（Pending/Running/✓/✗）、
 *  链标题分类等全局通用的小圆标。
 *  - 颜色：读取 6 套主题的 CSS vars（--xxx-soft 背景 / --xxx-solid 字），自动适配
 *  - 6 个语义变体 + muted（辅助灰）
 *  - 2 个尺寸：sm (10px) 目录/列表内联 / md (12px) 节点卡头部
 *  - 图标 slot：前缀可选，自动 gap 对齐
 */
const badgeVariants = cva(
  'inline-flex shrink-0 items-center justify-center select-none [&_svg]:pointer-events-none whitespace-nowrap font-semibold tabular-nums tracking-tight',
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
      },
      size: {
        sm: 'gap-x-1 px-1 py-[1px] rounded-[var(--radius-xs)] text-10 leading-[14px]',
        md: 'gap-x-1.5 px-1.5 py-0.5 rounded-[var(--radius-sm)] text-11.5 leading-[16px]',
      },
    },
    defaultVariants: {
      variant: 'muted',
      size: 'sm',
    },
  },
);

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;
export type BadgeSize = NonNullable<VariantProps<typeof badgeVariants>['size']>;

/** variant → 背景/文字 CSS var 映射。
 *  这里用 style 而不是 tailwind class，因为 tailwind 没有配置 primary-soft 这类语义派生类。
 *  注：各主题 --xxx-soft 已经是 ~10% 透明的合适卡片底色，muted 变体用纸质微染。 */
const VARIANT_STYLES: Record<BadgeVariant, React.CSSProperties> = {
  primary: {
    backgroundColor: 'var(--primary-soft)',
    color: 'var(--primary-strong)',
  },
  info: {
    backgroundColor: 'var(--info-soft)',
    color: 'var(--info-solid)',
  },
  success: {
    backgroundColor: 'var(--success-soft)',
    color: 'var(--success-solid)',
  },
  warn: {
    backgroundColor: 'var(--warn-soft)',
    color: 'color-mix(in oklab, var(--warn-solid) 85%, var(--ink))',
  },
  danger: {
    backgroundColor: 'var(--danger-soft)',
    color: 'var(--danger-solid)',
  },
  purple: {
    backgroundColor: 'var(--purple-soft)',
    color: 'var(--purple-solid)',
  },
  muted: {
    backgroundColor: 'color-mix(in oklab, var(--paper-muted) 65%, transparent)',
    color: 'var(--ink-muted)',
  },
};

export interface BadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>,
    VariantProps<typeof badgeVariants> {
  /** 前缀图标（10-12px，h-3 w-3），如 <CheckCircle2 className="h-3 w-3" /> */
  icon?: React.ReactNode;
  /** 徽章文字或元素 */
  label?: React.ReactNode;
  /** 替代 API：用原生 children（与 label 二选一，传了 label 优先 label） */
  children?: React.ReactNode;
}

function Badge({
  className,
  variant,
  size,
  icon,
  label,
  children,
  style,
  ...props
}: BadgeProps) {
  const v = variant ?? 'muted';
  const mergedStyle: React.CSSProperties | undefined =
    style ? { ...VARIANT_STYLES[v], ...style } : VARIANT_STYLES[v];
  const content = label ?? children;
  return (
    <span
      data-slot="badge"
      data-variant={v}
      data-size={size ?? 'sm'}
      className={cn(badgeVariants({ variant, size, className }))}
      style={mergedStyle}
      {...props}
    >
      {icon}
      {content}
    </span>
  );
}

export { Badge, badgeVariants };
