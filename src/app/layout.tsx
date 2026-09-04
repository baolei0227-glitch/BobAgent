import type { Metadata } from 'next';
import { Inspector } from 'react-dev-inspector';
import * as ReactDOM from 'react-dom';
import { ScreenOcrHost } from '@/components/screen-ocr/ScreenOcrHost';
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
      </body>
    </html>
  );
}
