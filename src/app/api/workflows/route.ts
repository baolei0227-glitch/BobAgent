/**
 * /api/workflows — 工作流模板管理 API
 *
 * GET  /api/workflows          — 列出当前项目的所有模板
 * POST /api/workflows          — 创建新模板
 */

import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import {
  initDb,
  listWorkflowTemplates,
  createWorkflowTemplate,
  type CreateWorkflowTemplateData,
} from '@/lib/db';
import { getCurrentProject } from '@/lib/project/project-manager';

async function getDb() {
  const project = await getCurrentProject();
  const dbPath = join(project.path, 'project.db');
  return await initDb(dbPath);
}

async function getCurrentProjectId(): Promise<string> {
  const project = await getCurrentProject();
  return project.id;
}

export async function GET() {
  try {
    const db = await getDb();
    const projectId = await getCurrentProjectId();
    const templates = await listWorkflowTemplates(db, projectId);
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

    const db = await getDb();
    const projectId = await getCurrentProjectId();

    const data: CreateWorkflowTemplateData = {
      project_id: projectId,
      name,
      description: description || '',
      category: category || '通用',
      steps,
    };

    const templateId = await createWorkflowTemplate(db, data);
    return NextResponse.json({ success: true, template_id: templateId });
  } catch (e) {
    console.error('POST /api/workflows error:', e);
    return NextResponse.json({ error: 'Failed to create template' }, { status: 500 });
  }
}
