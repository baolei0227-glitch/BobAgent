/**
 * WANTED 报告分享链接 API
 *
 * GET /api/wanted/report?id=<noticeId>[&download=1]
 *   → 返回该收件箱邮件的报告正文（text/markdown；download=1 时以附件形式下载 .md）
 *
 * 用途：BobMail 里 webbridge 等「报告类」邮件提供「复制链接」——复制后粘贴到
 * 对话框中，AI 通过 web_fetch 抓取该链接即可读取并分析报告内容。
 * 仅允许分享报告类邮件（web / daily-report / inspect / info），
 * 聊天、任务、便签、日程等不对外暴露正文。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getInboxById } from '@/lib/wanted/inbox';

const SHAREABLE_KINDS = new Set(['web', 'daily-report', 'inspect', 'info']);

function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report'
  );
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
  }
  try {
    const record = await getInboxById(id);
    if (!record || !SHAREABLE_KINDS.has(record.kind)) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    const body = record.body || '';
    const download = request.nextUrl.searchParams.get('download') === '1';
    const headers: Record<string, string> = {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
    };
    if (download) {
      headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(sanitizeFilename(record.title))}.md"`;
    }
    // 头部带标题行，便于 AI 抓取后快速识别报告主题
    const content = body;
    return new NextResponse(content, { status: 200, headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[wanted/report] 读取报告失败:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}