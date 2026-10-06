'use client';

/**
 * SectionStack —— 移动端 Butler（`/butler`）的分区栈容器。
 *
 * ## 为什么需要它
 * 桌面 Butler 的四栏抽屉骨架（`ButlerDrawer.tsx` 的布局层）在手机上**不可用**：
 *   - 它是「居中模态框 + 全屏透明挡板」，在 390px 视口里既压不住内容、点任意处还会误关；
 *   - 更糟的是若 localStorage 里存有桌面拖拽几何（`butler.drawer.geom.v1`），
 *     面板宽度会被 `clampNum` 钳到 **520px** 硬塞进 390px 视口 → 横向溢出。
 * 因此移动端不用「三栏并排」，改为**栈式导航**：对话页留在原地，分区全屏滑入，返回即回。
 *
 * ## 职责边界
 * 只做容器：标题栏 / 转场 / 安全区 / 滚动归属。**不含任何业务**
 * —— 面板内容由调用方传入（多为直接复用的桌面组件，见 `components/butler/*.tsx`）。
 *
 * 样式全部走 `bws-` 前缀（`bwm-` 归 `/butler` 页面自身），两者不冲突。
 */
import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';

export interface SectionStackProps {
  /** 顶栏标题 */
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 顶栏右侧可选动作（不传则占位保持标题居中） */
  action?: ReactNode;
}

export function SectionStack({ title, onClose, children, action }: SectionStackProps) {
  return (
    <div className="bws-root">
      <style>{`
        .bws-root {
          position: fixed; inset: 0; z-index: 60;
          display: flex; flex-direction: column;
          background: var(--background, #f7f7f8); color: var(--text, #171717);
          font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
          animation: bws-in .22s cubic-bezier(.22,.61,.36,1) both;
          -webkit-font-smoothing: antialiased;
        }
        @keyframes bws-in { from { transform: translateX(100%); } to { transform: none; } }

        /* 顶栏：磨砂玻璃 + 刘海安全区（与 /butler 主页面同款口径） */
        .bws-header {
          flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
          padding: calc(env(safe-area-inset-top, 0px) + 8px) 10px 8px;
          background: color-mix(in oklab, var(--panel-bg, #fff) 84%, transparent);
          -webkit-backdrop-filter: saturate(180%) blur(16px); backdrop-filter: saturate(180%) blur(16px);
          border-bottom: 1px solid var(--line-soft, rgba(0,0,0,.07));
        }
        .bws-back {
          flex: 0 0 auto; width: 36px; height: 36px; display: inline-flex; align-items: center;
          justify-content: center; border: 0; border-radius: 10px; background: transparent;
          color: var(--text, #171717); -webkit-tap-highlight-color: transparent;
        }
        .bws-back:active { background: var(--muted, #efeff2); }
        .bws-title {
          flex: 1 1 auto; min-width: 0; text-align: center;
          font-size: 16px; font-weight: 650; letter-spacing: -.2px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .bws-action { flex: 0 0 auto; min-width: 36px; display: flex; justify-content: flex-end; }

        /* 内容区：min-height:0 是内部面板（自带 overflow-y）能正确滚动的唯一前提 */
        .bws-body {
          flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
          padding-bottom: env(safe-area-inset-bottom, 0px);
        }
      `}</style>
      <header className="bws-header">
        <button className="bws-back" onClick={onClose} aria-label="Back">
          <ChevronLeft size={22} />
        </button>
        <div className="bws-title">{title}</div>
        <div className="bws-action">{action}</div>
      </header>
      <div className="bws-body">{children}</div>
    </div>
  );
}
