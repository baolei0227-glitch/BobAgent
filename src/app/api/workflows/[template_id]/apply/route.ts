/**
 * /api/workflows/[template_id]/apply — 应用模板：创建新项目并部署节点
 *
 * POST — 创建新项目 + 节点(.md 文件) + 连线(edges)，返回新项目信息
 *
 * 变量替换规则：
 *   - {{date}}, {{project}} 等内置变量：apply 时替换
 *   - 用户自定义变量 {{company}} 等：apply 时替换
 *   - {{upstream}}：保留原样，运行时由前端替换
 */

import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { PROJECT_DB_FILENAME } from '@/lib/app-root';
import {
  initDb,
  getWorkflowTemplate,
  createEdge,
} from '@/lib/db';
import { createProject } from '@/lib/project/project-manager';
import {
  createNodeMarkdown,
  writeNodeFile,
  generateNodeId,
  cleanTitleText,
  setCurrentProjectPath,
  clearCurrentProjectPath,
} from '@/lib/node-markdown';

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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ template_id: string }> },
) {
  try {
    const { template_id: templateId } = await params;
    const body = await request.json();
    const { variables = {}, project_name } = body;

    // 从全局 .templates.db 读取模板
    const template = await getWorkflowTemplate(templateId);

    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    // 1. 创建新项目
    const projectName = project_name || template.name || 'New Project';
    const project = await createProject(projectName);

    setCurrentProjectPath(project.path);

    try {
      const dbPath = join(project.path, PROJECT_DB_FILENAME);
      const db = await initDb(dbPath);

      const nodeIds: string[] = [];
      const nodes: Array<{ node_id: string; title: string; position: { x: number; y: number } }> = [];
      const verticalSpacing = 350;

      // 2. 创建节点
      for (let i = 0; i < template.steps.length; i++) {
        const step = template.steps[i];
        const resolvedPrompt = replaceVariables(step.prompt, variables);
        const cleanedTitle = cleanTitleText(step.title) || `Step ${i + 1}`;
        const nodeId = generateNodeId();

        const mdContent = createNodeMarkdown(nodeId, cleanedTitle, {
          model: step.modelId,
          initial_prompt: resolvedPrompt,
          thinking_level: step.thinkingLevel,
          attachment_hint: step.attachmentHint,
          skills: step.skills,
        });

        await writeNodeFile(cleanedTitle, mdContent);

        const position = {
          x: 400,
          y: 200 + i * verticalSpacing,
        };

        nodeIds.push(nodeId);
        nodes.push({ node_id: nodeId, title: cleanedTitle, position });
      }

      // 3. 创建连线
      const edges: Array<{ edge_id: string; from: string; to: string }> = [];
      for (let i = 0; i < template.steps.length; i++) {
        const step = template.steps[i];
        const nextOrders = step.nextSteps || (i < template.steps.length - 1 ? [i + 1] : []);
        for (const nextOrder of nextOrders) {
          if (nextOrder >= 0 && nextOrder < nodeIds.length) {
            const edgeId = await createEdge(db, {
              project_id: project.id,
              from_node_id: nodeIds[i],
              to_node_id: nodeIds[nextOrder],
              edge_type: 'vertical',
            });
            edges.push({ edge_id: edgeId, from: nodeIds[i], to: nodeIds[nextOrder] });
          }
        }
      }

      return NextResponse.json({
        success: true,
        project: {
          id: project.id,
          name: project.name,
        },
        nodes,
        edges,
      });
    } finally {
      clearCurrentProjectPath();
    }
  } catch (e) {
    console.error('POST /api/workflows/[id]/apply error:', e);
    return NextResponse.json({ error: 'Failed to apply template' }, { status: 500 });
  }
}
