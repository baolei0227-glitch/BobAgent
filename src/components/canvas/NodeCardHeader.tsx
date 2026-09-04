import * as React from 'react';

import { cn } from '@/lib/utils';

/** NodeCardHeader：AiChatNode / ImageGenNode 等节点卡头部的统一布局骨架。
 *  只解决"左侧锚点区 + 中间标题/副标题 + 右侧操作组"的 3 段式排版，
 *  不承担任何业务逻辑（具体徽标/按钮由外部作为 slot 传入）。
 *
 *  · 左：leftAnchor — 头像 / 类型 Badge / 状态小点 / 任意组合
 *  · 中：title + subtitle(可选) — 主标题截断、副标 muted 小字
 *  · 右：rightActions — 预览 / 报告 / 成果块 / 锁定 / 展开 / 删除 等操作组
 *  · 底部分隔线：divider(默认开) + dividerColor(可覆盖主题色)
 */
export interface NodeCardHeaderProps {
  leftAnchor?: React.ReactNode;
  title: React.ReactNode;
  titleStyle?: React.CSSProperties;
  /** 副标题（默认显示在标题下方 muted 小字；传 inline=true 则同一行紧跟标题尾） */
  subtitle?: React.ReactNode;
  subtitleInline?: boolean;
  rightActions?: React.ReactNode;
  /** 是否显示底部分隔线 */
  divider?: boolean;
  /** 分隔线颜色覆盖（AiCoding / 选中态需要有色描边等场景） */
  dividerColor?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function NodeCardHeader({
  leftAnchor,
  title,
  titleStyle,
  subtitle,
  subtitleInline = false,
  rightActions,
  divider = true,
  dividerColor,
  className,
  style,
}: NodeCardHeaderProps) {
  return (
    <div
      data-slot="node-card-header"
      className={cn(
        'flex w-full items-center gap-2 px-3 py-2',
        divider && 'border-b',
        className,
      )}
      style={{
        ...(divider ? { borderColor: dividerColor ?? 'color-mix(in oklab, var(--line) 30%, transparent)' } : undefined),
        ...style,
      }}
    >
      {/* 左侧锚点 */}
      {leftAnchor !== undefined && leftAnchor !== null && (
        <div className="flex shrink-0 items-center gap-1.5">{leftAnchor}</div>
      )}

      {/* 中间标题区 */}
      {subtitleInline ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            className="min-w-0 flex-1 truncate text-base font-semibold"
            style={{ color: 'var(--ink)', ...titleStyle }}
          >
            {title}
          </span>
          {subtitle !== undefined && subtitle !== null && subtitle !== '' && (
            <span className="shrink-0 text-xs" style={{ color: 'var(--ink-muted)' }}>
              {subtitle}
            </span>
          )}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <span
            className="min-w-0 truncate text-base font-semibold"
            style={{ color: 'var(--ink)', ...titleStyle }}
          >
            {title}
          </span>
          {subtitle !== undefined && subtitle !== null && subtitle !== '' && (
            <span
              className="min-w-0 truncate text-11.5 leading-[14px]"
              style={{ color: 'var(--ink-muted)' }}
            >
              {subtitle}
            </span>
          )}
        </div>
      )}

      {/* 右侧操作组 */}
      {rightActions !== undefined && rightActions !== null && (
        <div className="flex shrink-0 items-center gap-1.5">{rightActions}</div>
      )}
    </div>
  );
}

export default NodeCardHeader;
