/**
 * /api/workflows — 工作流模板管理 API（全局，独立于项目）
 *
 * GET  /api/workflows          — 列出所有模板
 * POST /api/workflows          — 创建新模板
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  listWorkflowTemplates,
  createWorkflowTemplate,
  type CreateWorkflowTemplateData,
} from '@/lib/db';

export async function GET() {
  try {
    const templates = await listWorkflowTemplates();
    return NextResponse.json({ templates });
  } catch (e) {
    console.error('GET /api/workflows error:', e);
    return NextResponse.json({ error: 'Failed to load templates' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, category, steps } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      return NextResponse.json({ error: 'steps must be a non-empty array' }, { status: 400 });
    }

    const data: CreateWorkflowTemplateData = {
      name,
      description: description || '',
      category: category || 'General',
      steps,
    };

    const templateId = await createWorkflowTemplate(data);
    return NextResponse.json({ success: true, template_id: templateId });
  } catch (e) {
    console.error('POST /api/workflows error:', e);
    return NextResponse.json({ error: 'Failed to create template' }, { status: 500 });
  }
}
