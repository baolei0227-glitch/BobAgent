'use client';

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { cn } from '@/lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        // z 必须高于浮层宿主（Radix Dialog / 设置面板 z-[2000]、登录弹窗 z-[2100]）：
        // tooltip 是 portal 到 body 的 fixed 层，若低于弹窗就会整块被弹窗盖住
        // （例：设置 → Model Usage → Month 的按日柱状图悬停提示）。
        'z-[3000] max-w-[320px] overflow-hidden rounded-lg px-2.5 py-1.5 text-xs leading-relaxed shadow-lg',
        'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        className
      )}
      style={{
        backgroundColor: 'var(--panel-bg)',
        color: 'var(--ink)',
        fontFamily: "var(--font-sans)",
        border: '1px solid color-mix(in oklab, var(--line) 60%, transparent)',
      }}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
