'use client';

/**
 * SectionRail —— 移动端 Butler 的**左侧滑入导航**（「分区栈」的入口）。
 *
 * ## 为什么是左滑而不是底栏 Tab
 * 桌面 Butler 用一条 48px 的功能键栏承载分区；手机没有横向余量，底栏又会常年吃掉
 * 一行的滚动高度。而移动端的主视图是**会话**（不是分区），分区是「偶尔进去看一眼」的
 * 次要面 —— 故收敛为左缘滑出的抽屉：默认不可见、进去即回。
 *
 * ## 交互约定
 *   - 左缘 24px 内向右拖 > 56px 打开（`onEdgeSwipe` 由页面接管，见 /butler 页注释）
 *   - 点条目 → 关导航 + 打开对应分区栈；点遮罩 → 关导航
 *   - 高度用 `env(safe-area-inset-*)` 让开刘海与home 指示条
 *
 * 样式走 `bwr-` 前缀（`bwm-` 归页面、`bws-` 归 SectionStack、`bwn-` 归回执面板）。
 */
import type { LucideIcon } from 'lucide-react';

export interface RailEntry {
  key: string;
  label: string;
  /** 一行说明（可选）：让「Memories / Preferences」这类近义项在手机上也能一眼分辨 */
  hint?: string;
  Icon: LucideIcon;
  /** 右侧角标（今日新增 / 未读回执数） */
  badge?: number;
  /** 角标语义：true = 红点强调（未读）；false = 中性数字 */
  alert?: boolean;
  /** 「正在发生」指示灯（会议进行中）：绿点，与「未读」的红角标语义互斥 */
  live?: boolean;
}

export interface SectionRailProps {
  open: boolean;
  onClose: () => void;
  entries: RailEntry[];
  onPick: (key: string) => void;
}

export function SectionRail({ open, onClose, entries, onPick }: SectionRailProps) {
  if (!open) return null;
  return (
    <div className="bwr-root">
      <style>{`
        .bwr-root { position: fixed; inset: 0; z-index: 70; }
        .bwr-scrim {
          position: absolute; inset: 0; border: 0; padding: 0;
          background: rgba(15, 18, 30, .32);
          -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px);
          animation: bwr-fade .18s ease both;
        }
        @keyframes bwr-fade { from { opacity: 0; } to { opacity: 1; } }

        .bwr-panel {
          position: absolute; top: 0; bottom: 0; left: 0;
          width: min(80vw, 306px); display: flex; flex-direction: column;
          padding-top: env(safe-area-inset-top, 0px);
          padding-bottom: env(safe-area-inset-bottom, 0px);
          background: var(--panel-bg, #fff); color: var(--text, #171717);
          border-right: 1px solid var(--line-soft, rgba(0,0,0,.07));
          box-shadow: 0 18px 48px -12px rgba(10, 14, 30, .35);
          animation: bwr-in .22s cubic-bezier(.22,.61,.36,1) both;
          font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
        }
        @keyframes bwr-in { from { transform: translateX(-100%); } to { transform: none; } }

        .bwr-head { flex: 0 0 auto; display: flex; align-items: center; gap: 11px; padding: 14px 16px 12px; }
        .bwr-brand {
          flex: 0 0 auto; width: 38px; height: 38px; border-radius: 12px; color: #fff;
          display: flex; align-items: center; justify-content: center;
          background: linear-gradient(135deg, #6f6fff 0%, var(--primary, #4b3fe3) 100%);
          box-shadow: 0 4px 12px -3px color-mix(in oklab, var(--primary, #4b3fe3) 55%, transparent);
        }
        .bwr-headtext { min-width: 0; }
        .bwr-name { font-size: 16px; font-weight: 700; letter-spacing: -.2px; }
        .bwr-sub { margin-top: 1px; font-size: 11.5px; color: var(--text-muted, #52525b); }

        .bwr-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 8px 12px; }
        .bwr-sep { height: 1px; margin: 7px 8px; background: var(--line-soft, rgba(0,0,0,.07)); }
        .bwr-item {
          width: 100%; display: flex; align-items: center; gap: 11px; text-align: left;
          padding: 10px 10px; border: 0; border-radius: 11px; background: transparent;
          font: inherit; color: inherit; transition: background .14s ease;
          -webkit-tap-highlight-color: transparent;
        }
        .bwr-item:active { background: var(--muted, #efeff2); }
        .bwr-itemicon {
          flex: 0 0 auto; width: 32px; height: 32px; border-radius: 10px;
          display: flex; align-items: center; justify-content: center;
          background: color-mix(in oklab, var(--primary, #4b3fe3) 9%, transparent);
          color: var(--primary, #4b3fe3);
        }
        .bwr-itemtext { flex: 1 1 auto; min-width: 0; }
        .bwr-itemlabel { font-size: 14.5px; font-weight: 600; }
        .bwr-itemhint { margin-top: 1px; font-size: 11.5px; line-height: 1.35; color: var(--text-muted, #52525b);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bwr-badge { flex: 0 0 auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
          font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; }
        .bwr-badge.alert { background: var(--danger, #e8463a); color: #fff; }
        .bwr-badge.plain { background: var(--muted, #efeff2); color: var(--text-muted, #52525b);
          border: 1px solid var(--line-soft, rgba(0,0,0,.07)); }
        .bwr-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--success, #1dc981); }
      `}</style>

      <button className="bwr-scrim" aria-label="Close menu" onClick={onClose} />
      <div className="bwr-panel" role="dialog" aria-label="Butler sections">
        <div className="bwr-head">
          <div className="bwr-brand">
            <Sparkle />
          </div>
          <div className="bwr-headtext">
            <div className="bwr-name">Butler</div>
            <div className="bwr-sub">Sections</div>
          </div>
        </div>
        <div className="bwr-list">
          {entries.map((e) => (
            <button key={e.key} className="bwr-item" onClick={() => onPick(e.key)}>
              <span className="bwr-itemicon">
                <e.Icon size={16} />
              </span>
              <span className="bwr-itemtext">
                <span className="bwr-itemlabel">{e.label}</span>
                {e.hint ? <span className="bwr-itemhint">{e.hint}</span> : null}
              </span>
              {e.live ? <span className="bwr-dot" /> : null}
              {typeof e.badge === 'number' && e.badge > 0 ? (
                <span className={`bwr-badge${e.alert ? ' alert' : ' plain'}`}>
                  {e.badge > 99 ? '99+' : e.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 品牌位的小星标（避免为一个图标引整个 lucide 命名空间） */
function Sparkle() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"
        fill="currentColor"
      />
      <path d="M18.5 15.5l.8 2.1 2.2.8-2.2.8-.8 2.1-.8-2.1-2.2-.8 2.2-.8.8-2.1z" fill="currentColor" opacity=".55" />
    </svg>
  );
}
