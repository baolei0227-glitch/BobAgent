/**
 * /api/workflows/[template_id] — 单个模板操作（全局）
 *
 * GET    — 获取模板详情
 * PUT    — 更新模板
 * DELETE — 删除模板
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getWorkflowTemplate,
  updateWorkflowTemplate,
  deleteWorkflowTemplate,
} from '@/lib/db';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ template_id: string }> },
) {
  try {
    const { template_id } = await params;
    const template = await getWorkflowTemplate(template_id);
    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }
    return NextResponse.json({ template });
  } catch (e) {
    console.error('GET /api/workflows/[id] error:', e);
    return NextResponse.json({ error: 'Failed to load template' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ template_id: string }> },
) {
  try {
    const { template_id } = await params;
    const body = await request.json();
    const { name, description, category, steps } = body;

    const existing = await getWorkflowTemplate(template_id);
    if (!existing) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    await updateWorkflowTemplate(template_id, {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(steps !== undefined ? { steps } : {}),
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('PUT /api/workflows/[id] error:', e);
    return NextResponse.json({ error: 'Failed to update template' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ template_id: string }> },
) {
  try {
    const { template_id } = await params;
    const existing = await getWorkflowTemplate(template_id);
    if (!existing) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }
    await deleteWorkflowTemplate(template_id);
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/workflows/[id] error:', e);
    return NextResponse.json({ error: 'Failed to delete template' }, { status: 500 });
  }
}
