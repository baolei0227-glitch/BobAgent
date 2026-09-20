/**
 * PDF 阅读器（Hippo Browser 专用）
 *
 * Hippo Browser 打开本地 PDF（file://*.pdf）时，主进程将导航重定向到本页：
 *   http://localhost:<port>/pdf-viewer?path=<绝对路径>
 * 页面零 App 外壳，供 Hippo Browser 独立窗口整页展示。
 */

import type { Metadata } from 'next';
import PdfViewerClient from './PdfViewerClient';

/**
 * 标签页标题：Hippo 标签名取自 document.title。
 * 查看页本体是客户端组件、无法导出 metadata，因此这里在服务端按 ?path= 推导文件名写入 <title>，
 * 否则会被根布局的 'BobWork - AI Canvas' 覆盖。
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}): Promise<Metadata> {
  const sp = await searchParams;
  const path = typeof sp.path === 'string' ? sp.path : '';
  return { title: path.split('/').pop() || 'document.pdf' };
}

export default function PdfViewerPage() {
  return <PdfViewerClient />;
}
