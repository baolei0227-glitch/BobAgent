/**
 * /api/quick-launch — ⌘F 自定义快捷入口（My Quick）
 *
 * GET  — 返回 settings.quickLaunchers
 * POST — { action: 'add' | 'remove', ... }
 *   add    { label, agent, prompt } → 追加一条（id 自生成）
 *   remove { id }                    → 移除指定入口
 *
 * 点击入口的行为（新建/聚焦对应 agent 节点并预填提示词）在后续阶段实现，
 * 本端点只负责「存储与读取」，UI 由 UnifiedPalette 的 My Quick 组消费。
 */

import { NextRequest, NextResponse } from 'next/server';
import { readSettingsFromFile, writeSettingsToFile } from '@/lib/settings-server';
import type { QuickLauncher } from '@/lib/settings';

export async function GET() {
  try {
    const settings = await readSettingsFromFile();
    return NextResponse.json({ quickLaunchers: (settings as { quickLaunchers?: QuickLauncher[] }).quickLaunchers ?? [] });
  } catch (e) {
    return NextResponse.json({ quickLaunchers: [], error: e instanceof Error ? e.message : 'Failed to load quick launchers' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      action: 'add' | 'remove';
      label?: string;
      agent?: string;
      prompt?: string;
      id?: string;
    };
    const settings = await readSettingsFromFile();
    const list: QuickLauncher[] = (settings as { quickLaunchers?: QuickLauncher[] }).quickLaunchers ?? [];

    if (body.action === 'add') {
      const label = (body.label ?? '').trim();
      const agent = (body.agent ?? '').trim() || 'chat';
      const prompt = (body.prompt ?? '').trim();
      if (!label) {
        return NextResponse.json({ success: false, error: '"label" is required' }, { status: 400 });
      }
      const id = `quick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      (settings as { quickLaunchers: QuickLauncher[] }).quickLaunchers = [...list, { id, label, agent, prompt }];
      await writeSettingsToFile(settings);
      return NextResponse.json({ success: true, id, label, agent, prompt });
    }

    if (body.action === 'remove') {
      const id = (body.id ?? '').trim();
      if (!id) {
        return NextResponse.json({ success: false, error: '"id" is required' }, { status: 400 });
      }
      const next = list.filter((q) => q.id !== id);
      (settings as { quickLaunchers: QuickLauncher[] }).quickLaunchers = next;
      await writeSettingsToFile(settings);
      return NextResponse.json({ success: true, id });
    }

    return NextResponse.json({ success: false, error: `Unknown action "${String(body.action)}"` }, { status: 400 });
  } catch (e) {
    console.error('POST /api/quick-launch error:', e);
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'Quick-launch operation failed' }, { status: 500 });
  }
}
