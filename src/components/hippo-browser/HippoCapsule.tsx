'use client';

/**
 * Hippo Browser「胶囊态」浮层——浏览器窗口收起时（非关闭），在主窗口正中
 * 显示一个圆角矩形胶囊按钮 + 呼吸灯。点击即恢复浏览器窗口。
 *
 * 状态来源：主进程在收起/恢复时通过 'hippo-browser:capsule' 事件推送，
 * preload 的 onCapsule 订阅；这里同步本地 state 控制显隐。
 */
import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { desktop } from '@/lib/desktop-adapter';

export function HippoCapsule() {
  const [capsule, setCapsule] = useState(false);

  useEffect(() => {
    // 初始同步一次当前态（避免主窗口晚于浏览器创建，漏掉首帧状态）
    let alive = true;
    void desktop.hippoBrowser.getCapsule().then((on) => {
      if (alive) setCapsule(!!on);
    });
    const unsub = desktop.hippoBrowser.onCapsule((on) => setCapsule(!!on));
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  if (!capsule) return null;

  return (
    <button
      type="button"
      aria-label="恢复 Hippo Browser"
      title="点击恢复浏览器（⌘⇧B）"
      onClick={() => void desktop.hippoBrowser.capsuleToggle()}
      className="hippo-capsule"
    >
      <Globe className="h-[23px] w-[23px]" />
      <span className="hippo-capsule__dot" aria-hidden />
    </button>
  );
}