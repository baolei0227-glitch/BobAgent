import type { Metadata, Viewport } from 'next';
import { Inspector } from 'react-dev-inspector';
import * as ReactDOM from 'react-dom';
import { AppHosts } from '@/components/AppHosts';
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
        {/* 应用级宿主（截图 OCR / Bobby 授权 / Butler 抽屉）：按路由排除独立球窗 /butler-orb */}
        <AppHosts />
      </body>
    </html>
  );
}
