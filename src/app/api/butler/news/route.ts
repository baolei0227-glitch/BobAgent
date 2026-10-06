/**
 * /api/butler/news — Daily News 主题配置 + 当日简报
 *
 *   GET  → { config, briefing }（briefing = 当日缓存或 null，秒开、不触发采集）
 *   POST → { action: 'save-topics', topics }  保存主题 chips（整份覆盖）
 *        → { action: 'refresh' }              强制重算当日简报（Refresh now）
 *
 * 与 Butler 对话工具 news_topics 写的是**同一份** config（butler/.state/news/config.json），
 * 双入口同写口，避免「界面上改一份、对话里改一份」两边分叉。
 * GET 只读缓存：采集 + 归纳是重活，交给每日调度或显式 refresh。
 */
import { NextRequest, NextResponse } from 'next/server';
import { readNewsBriefing, readNewsConfig, writeNewsConfig } from '@/lib/news/store';
import { generateNewsBriefing } from '@/lib/news/generate';

export async function GET() {
  try {
    const [config, briefing] = await Promise.all([readNewsConfig(), readNewsBriefing()]);
    return NextResponse.json({ success: true, config, briefing });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[news] 读取失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { action?: unknown; topics?: unknown };
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'save-topics') {
      const config = await writeNewsConfig(body.topics);
      return NextResponse.json({ success: true, config });
    }

    if (action === 'refresh') {
      const briefing = await generateNewsBriefing({ force: true });
      return NextResponse.json({ success: true, briefing });
    }

    return NextResponse.json({ success: false, error: `unknown action: ${action || '(empty)'}` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[news] 操作失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}
