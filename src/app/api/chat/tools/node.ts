/**
 * Agent 工具系统 — node 场景（画布节点对话：上游连线节点树/祖先 manifest 依赖工具）
 * 从 tools/index.ts 抽出：3 个 node 场景工具的定义与 executor。
 * 依赖方向单向：import shared.ts 的公共助手（truncate / READ_CAPACITY），
 * 直接依赖 @/lib/node-markdown 读取节点文档；
 * 仅以 import type 依赖 index.ts 的类型（编译期擦除），不产生运行时循环依赖。
 */

import { truncate, READ_CAPACITY } from './shared';
import { findNodeFileById, parseNodeMarkdown } from '@/lib/node-markdown';
import type { Tool } from './index';

/** 读取上游连线节点的完整 .md 文档 */
async function toolReadUpstreamNode(args: Record<string, unknown>): Promise<string> {
  const nodeId = args.node_id as string | undefined;
  const title = args.title as string | undefined;
  if (!nodeId && !title) return 'Error: node_id or title required';

  try {
    const { getCurrentProject } = await import('@/lib/project/project-manager');
    const { readdir } = await import('fs/promises');
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');

    const project = await getCurrentProject();
    const nodesDir = join(project.path, 'notes-memory');

    // 按 node_id 查找（通过 frontmatter 匹配，非文件名前缀）
    if (nodeId) {
      const filePath = await findNodeFileById(nodeId, project.path);
      if (filePath) {
        const content = await readFile(filePath, 'utf-8');
        const parsed = parseNodeMarkdown(content);
        const extractedTitle = parsed.frontmatter.title || nodeId;
        return truncate(
          `Node document: ${extractedTitle}\nNode ID: ${nodeId}\n\n${content}`,
          READ_CAPACITY,
        );
      }
      return `No upstream node found with node_id "${nodeId}".`;
    }

    // 按标题匹配（扫描所有 .md 文件的 frontmatter）
    if (title) {
      const files = await readdir(nodesDir);
      const mdFiles = files.filter((f) => f.endsWith('.md'));
      for (const file of mdFiles) {
        const content = await readFile(join(nodesDir, file), 'utf-8');
        const parsed = parseNodeMarkdown(content);
        const extractedTitle = parsed.frontmatter.title || '';
        if (extractedTitle === title) {
          return truncate(
            `Node document: ${title}\nNode ID: ${parsed.frontmatter.node_id}\nFile: ${file}\n\n${content}`,
            8000,
          );
        }
      }
      return `No upstream node found with title "${title}".`;
    }

    return 'Error: node_id or title required';
  } catch (e) {
    return `Upstream node read failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 读取祖先节点的结构化目录（manifest，不含内容正文） */
async function toolReadManifest(args: Record<string, unknown>): Promise<string> {
  const nodeId = args.node_id as string;
  if (!nodeId) return 'Error: node_id required';

  try {
    const { getCurrentProject } = await import('@/lib/project/project-manager');
    const { readManifest } = await import('@/lib/nodes/manifest');
    const project = await getCurrentProject();
    if (!project) return 'Error: No active project';

    const manifest = await readManifest(nodeId, project.path);
    if (!manifest) return `Node ${nodeId} not found or has no manifest.`;

    const lines = manifest.sections.map((s) => {
      const tags = [
        s.type,
        s.anchor ? `#${s.anchor}` : '',
        s.time ? `(${s.time})` : '',
        s.sensitive ? '[个人笔记]' : '',
      ].filter(Boolean).join(' ');
      const kw = s.keywords.length > 0 ? ` | 关键词: ${s.keywords.slice(0, 6).join('、')}` : '';
      return `- [${tags}] ${s.title}${kw}`;
    });
    return `节点「${manifest.title}」目录（共 ${manifest.sections.length} 条，状态: ${manifest.outcomeStatus}）：\n${
      lines.join('\n') || '（空）'
    }`;
  } catch (e) {
    return `read_manifest failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 检索员实习生：按指令查祖先节点 manifest → 锚点定位 → 返回原文（R-19 ~ R-24） */
async function toolInternSearch(args: Record<string, unknown>): Promise<string> {
  const targetNodeId = args.target_node_id as string;
  const instruction = args.instruction as string;
  const currentNodeId = args.current_node_id as string;
  if (!targetNodeId || !instruction) return 'Error: target_node_id and instruction required';
  if (!currentNodeId) return 'Error: current_node_id required（当前节点 id，用于祖先链校验）';

  try {
    const { getCurrentProject } = await import('@/lib/project/project-manager');
    const { internSearchNode, INTERN_MAX_ROUNDTRIP } = await import('@/lib/nodes/intern');
    const project = await getCurrentProject();
    if (!project) return 'Error: No active project';

    const res = await internSearchNode(
      {
        targetNodeId,
        instruction,
        maxResults: typeof args.max_results === 'number' ? Math.floor(args.max_results) : 5,
        roundTrip: typeof args.round_trip === 'number' ? Math.floor(args.round_trip) : 1,
      },
      project.path,
      project.id,
      currentNodeId,
    );

    if (res.status === 'found') {
      return `[实习生返回 · 节点「${res.sourceTitle}」] ${res.disclaimer}（引用时须标 [存疑] 或转入 pending，不得标 [确定]）\n${res.content}`;
    }
    if (res.status === 'exhausted') {
      return `status=exhausted：已完成 ${INTERN_MAX_ROUNDTRIP} 轮检索仍无结果。${res.disclaimer} 请停止该条推理线，在 pending 中写明「上游 ${targetNodeId} 中未找到相关内容，需人工确认」，不得基于假设继续计算。`;
    }
    return `status=not-found：${res.content}${res.disclaimer} 若仍需要，可改写关键词后再试一次（round_trip +1，上限 ${INTERN_MAX_ROUNDTRIP}）。`;
  } catch (e) {
    return `intern_search failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** node 场景工具定义（read_upstream_node / read_manifest / intern_search） */
export const nodeToolDefs: Tool[] = [
  {
    name: 'read_upstream_node',
    description: 'Read the full .md document of an upstream connected node. Identify by node_id (preferred — from the upstream node index in system prompt) or exact title; callable multiple times. Only reads nodes within the current project.',
    parameters: {
      type: 'object',
      properties: {
        node_id: {
          type: 'string',
          description: 'Node id (e.g. n_001) from the upstream node index in system prompt. Preferred over title for precise matching.',
        },
        title: {
          type: 'string',
          description: 'Title of the upstream node (fallback, use node_id when available). Must match exactly the title in the index table.',
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolReadUpstreamNode,
    maxOutput: 8000,
  },
  {
    name: 'read_manifest',
    description: 'Read the structured directory (manifest) of an ancestor node: indexed entries (conversations/annotations/attachments) with anchors + keywords, WITHOUT content. Pass the ancestor node_id from the upstream ancestor declaration.',
    parameters: {
      type: 'object',
      properties: {
        node_id: {
          type: 'string',
          description: 'Ancestor node id (e.g. n_001) from the upstream ancestor declaration.',
        },
      },
      required: ['node_id'],
    },
    category: '文件',
    execute: toolReadManifest,
    maxOutput: 8000,
  },
  {
    name: 'intern_search',
    description: 'Fetch original conversation fragments from an ancestor node by instruction: matches against the node manifest keywords (legal synonym expansion), locates anchor blocks, returns original text verbatim (read-only). Returned content is always marked [原始对话·未认定] — treat as unverified, mark [存疑] or move to pending, NEVER [确定]. Max 2 round trips, then stop and note "需人工确认". target_node_id must be an ancestor of current_node_id.',
    parameters: {
      type: 'object',
      properties: {
        target_node_id: {
          type: 'string',
          description: 'Ancestor node id to search in (from upstream ancestor declaration).',
        },
        instruction: {
          type: 'string',
          description: 'What to look for (keywords will be matched with synonym expansion).',
        },
        current_node_id: {
          type: 'string',
          description: 'Current node id (for ancestor-chain validation).',
        },
        max_results: {
          type: 'number',
          description: 'Max hits, default 5.',
        },
        round_trip: {
          type: 'number',
          description: 'Round trip counter, start at 1, max 2.',
        },
      },
      required: ['target_node_id', 'instruction', 'current_node_id'],
    },
    category: '文件',
    execute: toolInternSearch,
    maxOutput: 8000,
  },
];
