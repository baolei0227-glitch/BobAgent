import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';

import { cn } from '@/lib/utils';

/* ============================================================
 * Button — BobWork 按钮唯一事实源（v2 · 2026-09-05）
 *
 * 设计纪律（对齐 THEME-GUIDE · dynamic-ui 扁平克制）：
 *  · 焦点表达：solid 实底（品牌）每视图 ≤1 个主操作；其余降为 soft / outline / ghost
 *  · 颜色即含义：tone 只在真实状态/风险语义下偏离 brand
 *    - brand   唯一焦点色（新建/保存/批准/恢复）
 *    - danger  破坏性最终确认（solid）；危险入口潜伏为 ghost/outline，常态不刷红
 *    - success/info/warn 状态机动作（批准执行、归档、授权等），克制使用
 *  · 忙碌态：loading=true → disabled + aria-busy（视觉 spinner 由调用方渲染，
 *    本组件不吞 children，避免与既有 {cond ? <Loader2/> : <Icon/>} 双份）
 *  · 按下反馈：active 微缩放（translateY+scale），无 hover 抬升、无阴影堆叠
 *  · 几何刻度：sm 默认（h-7）；md 主 CTA（h-8）；xs/micro 内联；icon 系方钮；
 *    icon-xs 为 h-5 圆形小钮（节点头部关闭/删除位）；icon-sm/icon 覆盖 24/28px 图标主档
 *  · 迁移目标：全项目 821 个 <button> 逐步收敛到本组件；手写 tailwind 配方
 *    与 globals.css 的 .btn 体系停用（.btn 保留兼容，不再新增使用点）
 * ============================================================ */

export type ButtonTone = 'brand' | 'neutral' | 'danger' | 'success' | 'info' | 'warn';
export type ButtonVariant = 'solid' | 'soft' | 'outline' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'xs' | 'micro' | 'icon' | 'icon-sm' | 'icon-xs' | 'icon-lg';

const BASE =
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium ' +
  'outline-none cursor-pointer transition-colors ' +
  'disabled:pointer-events-none disabled:opacity-50 ' +
  'active:translate-y-[0.5px] active:scale-[0.985]';

/* variant × tone 视觉矩阵（样式写死在本文件，禁止外溢到组件 className） */
const VARIANTS: Record<ButtonVariant, Record<ButtonTone, string>> = {
  solid: {
    brand: 'bg-[var(--brand)] text-[var(--brand-on)] hover:bg-[var(--brand-strong)]',
    neutral: 'bg-[var(--ink)] text-white hover:bg-[color-mix(in_oklab,var(--ink)_82%,black)]',
    danger: 'bg-[var(--danger)] text-white hover:bg-[color-mix(in_oklab,var(--danger)_85%,black)]',
    success: 'bg-[var(--success)] text-white hover:bg-[color-mix(in_oklab,var(--success)_85%,black)]',
    info: 'bg-[var(--info)] text-white hover:bg-[color-mix(in_oklab,var(--info)_85%,black)]',
    warn: 'bg-[var(--warn)] text-white hover:bg-[color-mix(in_oklab,var(--warn)_85%,black)]',
  },
  soft: {
    brand: 'bg-[color-mix(in_oklab,var(--brand)_12%,transparent)] text-[var(--brand)] hover:bg-[color-mix(in_oklab,var(--brand)_18%,transparent)]',
    neutral: 'bg-[var(--paper-soft)] text-[var(--ink)] hover:bg-[var(--paper-hover)]',
    danger: 'bg-[var(--danger-soft)] text-[var(--danger)] hover:bg-[color-mix(in_oklab,var(--danger)_18%,transparent)]',
    success: 'bg-[color-mix(in_oklab,var(--success)_14%,transparent)] text-[var(--success)] hover:bg-[color-mix(in_oklab,var(--success)_22%,transparent)]',
    info: 'bg-[color-mix(in_oklab,var(--info)_12%,transparent)] text-[var(--info)] hover:bg-[color-mix(in_oklab,var(--info)_20%,transparent)]',
    warn: 'bg-[color-mix(in_oklab,var(--warn)_14%,transparent)] text-[var(--warn)] hover:bg-[color-mix(in_oklab,var(--warn)_22%,transparent)]',
  },
  outline: {
    brand: 'border-[var(--line)] bg-transparent text-[var(--brand)] hover:bg-[color-mix(in_oklab,var(--brand)_8%,transparent)]',
    neutral: 'border-[var(--line)] bg-transparent text-[var(--ink)] hover:bg-[var(--paper-soft)]',
    danger: 'border-[var(--danger)] bg-transparent text-[var(--danger)] hover:bg-[var(--danger-soft)]',
    success: 'border-[var(--success)] bg-transparent text-[var(--success)] hover:bg-[color-mix(in_oklab,var(--success)_10%,transparent)]',
    info: 'border-[var(--info)] bg-transparent text-[var(--info)] hover:bg-[color-mix(in_oklab,var(--info)_10%,transparent)]',
    warn: 'border-[var(--warn)] bg-transparent text-[var(--warn)] hover:bg-[color-mix(in_oklab,var(--warn)_10%,transparent)]',
  },
  ghost: {
    brand: 'text-[var(--brand)] hover:bg-[color-mix(in_oklab,var(--brand)_10%,transparent)]',
    neutral: 'text-[var(--ink)] hover:bg-[var(--paper-hover)]',
    /* 危险潜伏：常态中性灰，hover 才显红（删除/清空入口，配合 confirm 二次确认） */
    danger: 'text-[var(--ink-muted)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]',
    success: 'text-[var(--success)] hover:bg-[color-mix(in_oklab,var(--success)_10%,transparent)]',
    info: 'text-[var(--info)] hover:bg-[color-mix(in_oklab,var(--info)_10%,transparent)]',
    warn: 'text-[var(--warn)] hover:bg-[color-mix(in_oklab,var(--warn)_10%,transparent)]',
  },
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 rounded-md px-2.5 text-xs',
  md: 'h-8 rounded-md px-3.5 text-xs',
  xs: 'h-6 rounded-md px-2 text-11',
  micro: 'rounded px-1.5 py-0.5 text-10',
  /* 图标档对齐存量主分布：h-6(24px) 最常见、h-7(28px) 次之、h-8(32px) 少量 */
  'icon-xs': 'h-5 w-5 rounded-full',
  'icon-sm': 'h-6 w-6 rounded-md',
  icon: 'h-7 w-7 rounded-md',
  'icon-lg': 'h-8 w-8 rounded-md',
};

export interface ButtonProps extends React.ComponentProps<'button'> {
  variant?: ButtonVariant;
  tone?: ButtonTone;
  size?: ButtonSize;
  /** 忙碌态：disabled + aria-busy。视觉 spinner 由调用方按既有模式渲染 */
  loading?: boolean;
  asChild?: boolean;
}

function Button({
  variant = 'solid',
  tone = 'brand',
  size = 'sm',
  loading = false,
  asChild = false,
  className,
  disabled,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-tone={tone}
      data-size={size}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(BASE, VARIANTS[variant][tone], SIZES[size], className)}
      {...props}
    />
  );
}

/** 兼容旧调用（buttonVariants({...})），返回拼接类字符串 */
function buttonVariants(opts?: Partial<Pick<ButtonProps, 'variant' | 'tone' | 'size' | 'className'>>) {
  const { variant = 'solid', tone = 'brand', size = 'sm', className } = opts ?? {};
  return cn(BASE, VARIANTS[variant][tone], SIZES[size], className);
}

export { Button, buttonVariants };
export default Button;
