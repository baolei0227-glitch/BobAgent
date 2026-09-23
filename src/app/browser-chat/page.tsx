'use client';

/**
 * Hippo Browser 右侧对话栏页面（P2 ChatSidebar）
 *
 * 主进程用独立 WebContentsView 加载本页（`/browser-chat?win=<窗口标识>`），与网页视图并排。
 * 零 App 外壳：整页只有对话栏本体，会话与浏览器窗口一一对应（win 参数决定会话隔离维度）。
 * win 参数在浏览器端读取：服务端渲染时拿不到，故首帧占位、挂载后从 location.search 取值。
 */

import { useEffect, useState } from 'react';
import { BrowserChatPanel } from '@/components/hippo-browser/BrowserChatPanel';

export default function BrowserChatPage() {
  const [winId, setWinId] = useState('');

  useEffect(() => {
    const win = new URLSearchParams(window.location.search).get('win') || 'default';
    setWinId(win);
  }, []);

  return (
    <div className="h-screen w-screen overflow-hidden" style={{ backgroundColor: '#fff' }}>
      {winId ? <BrowserChatPanel winId={winId} /> : null}
    </div>
  );
}