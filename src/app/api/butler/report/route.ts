/**
 * Butler 报告分享链接 API
 *
 * GET /api/butler/report?id=<noticeId>[&download=1]
 *   → 返回该收件箱邮件的报告正文（text/markdown；download=1 时以附件形式下载 .md）
 *
 * 用途：Butler 收件箱里「报告类」回执提供「复制链接」——复制后粘贴到
 * 对话框中，AI 通过 web_fetch 抓取该链接即可读取并分析报告内容。
 * 仅允许分享报告类邮件（见 SHAREABLE_REPORT_KINDS），
 * 聊天、任务、便签、日程等不对外暴露正文。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getInboxById } from '@/lib/core/inbox';
import { isShareableReportKind, sanitizeReportFileName } from '@/lib/butler/report-share';

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 });
  }
  try {
    const record = await getInboxById(id);
    if (!record || !isShareableReportKind(record.kind)) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    const body = record.body || '';
    const download = request.nextUrl.searchParams.get('download') === '1';
    const headers: Record<string, string> = {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
    };
    if (download) {
      headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(sanitizeReportFileName(record.title))}.md"`;
    }
    // 直接返回正文（不加标题行——标题不入正文，避免与报告自身的 H1 重复）
    const content = body;
    return new NextResponse(content, { status: 200, headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/report] 读取报告失败:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}