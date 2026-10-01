import type { Metadata, Viewport } from 'next';
import { Inspector } from 'react-dev-inspector';
import * as ReactDOM from 'react-dom';
import { ScreenOcrHost } from '@/components/screen-ocr/ScreenOcrHost';
import { BobbyAuthHost } from '@/components/bobby/BobbyAuthHost';
import { ButlerHost } from '@/components/butler/ButlerHost';
import './globals.css';

export const metadata: Metadata = {
  title: 'BobWork - AI Canvas',
  description:
    'Create and manage AI conversation nodes on an infinite canvas',
  keywords: ['AI Canvas', 'AI Chat', 'Infinite Canvas', 'Knowledge Graph', 'Node Management'],
  authors: [{ name: 'AI Canvas' }],
  robots: {
    index: true,
    follow: true,
  },
  // iOS「添加到主屏幕」：以独立 App 形态启动（无 Safari 地址栏），标题用 BobWork。
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'BobWork',
  },
};

// 移动端视口：viewport-fit=cover 让内容铺到刘海/圆角安全区，配合上方 appleWebApp 独立启动。
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#6a5acd',
};

function FontPreconnect() {
  ReactDOM.preconnect('https://fonts.googleapis.cn');
  ReactDOM.preconnect('https://fonts.gstatic.cn');
  return null;
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const isDev = process.env.COZE_PROJECT_ENV === 'DEV';

  return (
    <html lang="zh-CN">
      <FontPreconnect />
      <body className="antialiased" suppressHydrationWarning>
        {isDev && <Inspector />}
        {children}
        {/* 全局截图 OCR 宿主：任意页面按 Cmd+Shift+O 都能弹编辑面板（与画布挂载状态解耦） */}
        <ScreenOcrHost />
        {/* 全局 Bobby 授权宿主：授权弹窗 / 系统权限引导 / 急停，不再依赖画布节点
            （CanvasFlow 改为单焦点 world 后画布已不存在，节点可能落在视口外导致弹窗不可见） */}
        <BobbyAuthHost />
        {/* 全局 Butler 助理宿主：悬浮球 → 微信式三栏抽屉（收件箱 / Today / 记忆 / 文档预览）
            与画布挂载状态解耦，避免在 4000+ 行的画布组件里再叠加 UI */}
        <ButlerHost />
      </body>
    </html>
  );
}
