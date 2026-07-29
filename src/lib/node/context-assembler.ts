import { promises as fs } from 'fs';
import { join } from 'path';
import {
  parseNodeMarkdown,
  findNodeFileById,
  setCurrentProjectPath,
  clearCurrentProjectPath,
} from '@/lib/node-markdown';
import { getAllUpstream, type EdgeInfo } from '@/lib/edge/cycle-detector';
import { initDb, listActiveEdges, type EdgeRow } from '@/lib/db';
import { getCurrentProject } from '@/lib/project/project-manager';

const MAX_CONTEXT_LENGTH = 50000;

interface UpstreamNodeContent {
  nodeId: string;
  title: string;
  summary: string;
  annotation: string;
  lastAnswer: string;
}

export async function assembleUpstreamContextForNode(
  nodeId: string,
): Promise<{ context: string; truncated: boolean; upstreamCount: number }> {
  const project = await getCurrentProject();
  setCurrentProjectPath(project.path);

  try {
    const dbPath = join(project.path, 'project.db');
    const db = await initDb(dbPath);
    const edges: EdgeRow[] = await listActiveEdges(db, project.id);

    const edgeInfos: EdgeInfo[] = edges.map((e) => ({
      from: e.from_node_id,
      to: e.to_node_id,
    }));

    const upstreamIds = getAllUpstream(edgeInfos, nodeId);

    if (upstreamIds.length === 0) {
      return { context: '', truncated: false, upstreamCount: 0 };
    }

    const contents: UpstreamNodeContent[] = [];
    for (const id of upstreamIds) {
      const content = await readNodeContent(id);
      if (content) {
        contents.push(content);
      }
    }

    if (contents.length === 0) {
      return { context: '', truncated: false, upstreamCount: 0 };
    }

    const sections: string[] = [];
    let totalLength = 0;
    let truncated = false;

    for (const node of contents) {
      const parts: string[] = [];
      parts.push(`### ${node.title}`);

      if (node.summary) {
        parts.push(`**摘要：** ${node.summary}`);
      }

      if (node.annotation) {
        parts.push(`**批注：** ${node.annotation}`);
      }

      if (node.lastAnswer) {
        const answerSlice = node.lastAnswer.slice(0, 2000);
        if (answerSlice.length < node.lastAnswer.length) {
          parts.push(`**最近回答（截断）：** ${answerSlice}...`);
        } else {
          parts.push(`**最近回答：** ${answerSlice}`);
        }
      }

      const section = parts.join('\n');
      const sectionLength = section.length;

      if (totalLength + sectionLength > MAX_CONTEXT_LENGTH) {
        const remaining = MAX_CONTEXT_LENGTH - totalLength;
        if (remaining > 100) {
          const truncatedSection = section.slice(0, remaining);
          sections.push(truncatedSection + '\n...(内容已截断)');
        }
        truncated = true;
        break;
      }

      sections.push(section);
      totalLength += sectionLength;
    }

    const context = sections.join('\n\n---\n\n');
    const header = `## 上游节点上下文（共 ${contents.length} 个上游节点）\n\n以下是与当前节点相连的上游节点内容，请作为首要参考知识，回答时优先基于这些信息。\n\n`;
    const footer = truncated ? '\n\n*注：部分上游内容因长度限制已截断。*' : '';

    return {
      context: header + context + footer,
      truncated,
      upstreamCount: contents.length,
    };
  } finally {
    clearCurrentProjectPath();
  }
}

async function readNodeContent(nodeId: string): Promise<UpstreamNodeContent | null> {
  try {
    const filePath = await findNodeFileById(nodeId);
    if (!filePath) return null;

    const content = await fs.readFile(filePath, 'utf-8');
    const node = parseNodeMarkdown(content);
    const conversations = node.conversations || [];
    const lastConv = conversations[conversations.length - 1];

    return {
      nodeId,
      title: node.frontmatter.title || '未命名',
      summary: node.summary || '',
      annotation: node.annotations || '',
      lastAnswer: lastConv?.answer || '',
    };
  } catch {
    return null;
  }
}

export function buildContextSystemPrompt(
  basePrompt: string,
  upstreamContext: string,
): string {
  if (!upstreamContext) {
    return basePrompt;
  }

  return `${basePrompt}\n\n${upstreamContext}\n\n## 回答原则\n以上上游节点内容是你的首要参考知识。用户的问题很可能与上游内容相关，请优先基于这些信息进行回答，必要时引用或衔接上游内容。`;
}
