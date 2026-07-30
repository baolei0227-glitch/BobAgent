/**
 * /api/workflows/[template_id]/apply — 应用模板到画布
 *
 * POST — 创建节点(.md 文件) + 连线(edges)，返回节点 ID 列表和建议位置
 *
 * 变量替换规则：
 *   - {{date}}, {{project}} 等内置变量：apply 时替换
 *   - 用户自定义变量 {{company}} 等：apply 时替换
 *   - {{upstream}}：保留原样，运行时由前端替换
 */

import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import {
  initDb,
  getWorkflowTemplate,
  createEdge,
} from '@/lib/db';
import { getCurrentProject } from '@/lib/project/project-manager';
import {
  createNodeMarkdown,
  writeNodeFile,
  generateNodeId,
  cleanTitleText,
  setCurrentProjectPath,
  clearCurrentProjectPath,
} from '@/lib/node-markdown';

async function getDb() {
  const project = await getCurrentProject();
  const dbPath = join(project.path, 'project.db');
  return await initDb(dbPath);
}

async function getCurrentProjectId(): Promise<string> {
  const project = await getCurrentProject();
  return project.id;
}

/** 变量替换：apply 时只替换内置变量和用户自定义变量，{{upstream}} 保留 */
function replaceVariables(prompt: string, variables: Record<string, string>): string {
  let result = prompt;

  // 内置变量
  result = result.replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10));

  // 用户自定义变量
  for (const [key, value] of Object.entries(variables)) {
    if (key === 'upstream') continue; // 保留，运行时替换
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  return result;
}

/** 从 prompt 中提取所有 {{变量名}} */
export function extractVariables(text: string): string[] {
  const matches = text.match(/\{\{(\w+)\}\}/g) || [];
  const vars = new Set<string>();
  for (const m of matches) {
    const name = m.slice(2, -2);
    if (name !== 'upstream' && name !== 'date' && name !== 'project') {
      vars.add(name);
    }
  }
  return [...vars];
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ template_id: string }> },
) {
  try {
    const { template_id: templateId } = await params;
    const body = await request.json();
    const { variables = {}, basePosition = { x: 400, y: 200 } } = body;

    const project = await getCurrentProject();
    setCurrentProjectPath(project.path);

    try {
      const db = await getDb();
      const projectId = await getCurrentProjectId();
      const template = await getWorkflowTemplate(db, templateId);

      if (!template) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 });
      }

      const nodeIds: string[] = [];
      const nodes: Array<{ node_id: string; title: string; position: { x: number; y: number } }> = [];
      const warnings: Array<{ type: string; step: number; detail: string }> = [];
      const verticalSpacing = 350;

      // 1. 按顺序创建节点
      for (let i = 0; i < template.steps.length; i++) {
        const step = template.steps[i];
        const resolvedPrompt = replaceVariables(step.prompt, variables);
        const cleanedTitle = cleanTitleText(step.title) || `步骤 ${i + 1}`;
        const nodeId = generateNodeId();

        const mdContent = createNodeMarkdown(nodeId, cleanedTitle, {
          model: step.modelId,
          initial_prompt: resolvedPrompt,
          thinking_level: step.thinkingLevel,
          attachment_hint: step.attachmentHint,
          skills: step.skills,
        });

        await writeNodeFile(nodeId, cleanedTitle, mdContent);

        const position = {
          x: basePosition.x,
          y: basePosition.y + i * verticalSpacing,
        };

        nodeIds.push(nodeId);
        nodes.push({ node_id: nodeId, title: cleanedTitle, position });
      }

      // 2. 顺序创建连线（step[0] → step[1] → step[2] ...）
      const edges: Array<{ edge_id: string; from: string; to: string }> = [];
      for (let i = 0; i < nodeIds.length - 1; i++) {
        const edgeId = await createEdge(db, {
          project_id: projectId,
          from_node_id: nodeIds[i],
          to_node_id: nodeIds[i + 1],
          edge_type: 'vertical',
        });
        edges.push({ edge_id: edgeId, from: nodeIds[i], to: nodeIds[i + 1] });
      }

      return NextResponse.json({
        success: true,
        nodes,
        edges,
        warnings,
      });
    } finally {
      clearCurrentProjectPath();
    }
  } catch (e) {
    console.error('POST /api/workflows/[id]/apply error:', e);
    return NextResponse.json({ error: 'Failed to apply template' }, { status: 500 });
  }
}
