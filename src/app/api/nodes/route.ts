import { NextRequest, NextResponse } from 'next/server';
import {
  createNodeMarkdown,
  appendConversation,
  parseNodeMarkdown,
  writeNodeFile,
  updateNodeFile,
  findNodeFileById,
  generateNodeId,
  serializeNode,
  renameNodeFile,
  cleanTitleText,
  setCurrentProjectPath,
  clearCurrentProjectPath,
  type NodeMood,
} from '@/lib/node-markdown';
import { getCurrentProject } from '@/lib/project/project-manager';
import { initDb, deleteEdgesByNode } from '@/lib/db';
import { promises as fs } from 'fs';
import { join } from 'path';

/** 在请求处理前设置当前项目路径 */
async function withProjectContext<T>(handler: () => Promise<T>): Promise<T> {
  const project = await getCurrentProject();
  setCurrentProjectPath(project.path);
  try {
    return await handler();
  } finally {
    clearCurrentProjectPath();
  }
}

// ==================== mood 分离工具 ====================

/** 从回答内容中分离 <mood> 标签和 <think> 标签，返回干净内容和 mood 文本 */
function stripMoodAndThink(content: string): { cleanAnswer: string; moodText: string } {
  let moodText = '';
  let clean = content;

  // 提取 <mood>...</mood>
  const moodMatch = clean.match(/<mood>([\s\S]*?)<\/mood>/i);
  if (moodMatch) {
    moodText = moodMatch[1].trim();
    clean = clean.replace(/<mood>[\s\S]*?<\/mood>/i, '');
  }
  // 处理未闭合的 <mood> 标签
  const openMoodMatch = clean.match(/<mood>([\s\S]*)$/i);
  if (openMoodMatch) {
    moodText += (moodText ? '\n' : '') + openMoodMatch[1].trim();
    clean = clean.replace(/<mood>[\s\S]*$/i, '');
  }

  // 移除 think 标签
  clean = clean.replace(/<think>[\s\S]*?<\/think>/gi, '');
  clean = clean.replace(/<think>[\s\S]*$/i, '');

  return { cleanAnswer: clean.trim(), moodText };
}

/** 将 mood 文本解析为 NodeMood 对象 */
function parseMoodTextToObject(moodText: string): NodeMood | undefined {
  if (!moodText || !moodText.trim()) return undefined;

  const pools: Record<string, string[]> = {
    vibe: [],
    sparks: [],
    reflections: [],
    will: [],
  };

  const sections = moodText.split(/(?:^|\n)\s*(?:Vibe|Sparks|Reflections|Will)\s*[:：]\s*/i);
  const labels = moodText.match(/(?:Vibe|Sparks|Reflections|Will)\s*[:：]/gi) || [];

  for (let i = 0; i < labels.length && i + 1 < sections.length; i++) {
    const labelLower = labels[i].toLowerCase().replace(/[:：]\s*/, '').trim();
    if (pools[labelLower] !== undefined) {
      pools[labelLower] = sections[i + 1]
        .split('\n')
        .map(s => s.replace(/^[-\u2022\u00b7]\s*/, '').trim())
        .filter(s => s.length > 0);
    }
  }

  if (Object.values(pools).every(arr => arr.length === 0) && moodText.trim()) {
    pools.vibe = [moodText.trim()];
  }

  const result: Record<string, string[]> = {};
  for (const key of Object.keys(pools)) {
    if (pools[key].length > 0) {
      result[key] = pools[key];
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

// ==================== POST: 创建/更新节点 ====================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    // 设置当前项目上下文（节点文件操作需要知道读写哪个项目目录）
    const project = await getCurrentProject();
    setCurrentProjectPath(project.path);

    if (action === 'create') {
      const { title, model, sources, mood, tags } = body;
      if (!title) {
        return NextResponse.json({ error: 'title is required' }, { status: 400 });
      }
      const cleanedTitle = cleanTitleText(title) || '未命名节点';
      const nodeId = body.node_id || generateNodeId();
      const mdContent = createNodeMarkdown(nodeId, cleanedTitle, { model, sources, mood, tags });
      const relativePath = await writeNodeFile(nodeId, cleanedTitle, mdContent);
      return NextResponse.json({ success: true, node_id: nodeId, title: cleanedTitle, file_path: relativePath });
    }

    if (action === 'append') {
      const { node_id, question, answer, questionTime, answerTime, mood, summary, question_attachments, title } = body;
      if (!node_id || !question || !answer) {
        return NextResponse.json({ error: 'node_id, question, answer are required' }, { status: 400 });
      }
      let filePath = await findNodeFileById(node_id, project.path);
      // .md 文件不存在时自动创建（处理降级节点、文件被意外删除等情况）
      if (!filePath) {
        const nodeTitle = cleanTitleText(title) || 'AI 对话';
        const now = new Date().toISOString();
        const freshContent = createNodeMarkdown(node_id, nodeTitle);
        const relativePath = await writeNodeFile(node_id, nodeTitle, freshContent);
        filePath = join(project.path, relativePath);
        console.log('[nodes:append] 自动创建缺失的节点文件:', filePath);
      }
      // 后端兜底：分离 mood 和 think 标签
      const { cleanAnswer, moodText } = stripMoodAndThink(answer);
      const parsedMood = moodText ? parseMoodTextToObject(moodText) : undefined;
      const finalMood = mood || parsedMood;
      const content = await fs.readFile(filePath, 'utf-8');
      const updatedContent = appendConversation(content, question, cleanAnswer, {
        questionTime, answerTime, mood: finalMood, summary,
        questionAttachments: question_attachments,
      });
      await updateNodeFile(filePath, updatedContent);
      const parsed = parseNodeMarkdown(updatedContent);
      return NextResponse.json({ success: true, node_id, conversations_count: parsed.conversations.length, updated_at: parsed.frontmatter.updated_at });
    }

    if (action === 'update_summary') {
      const { node_id, summary } = body;
      if (!node_id || !summary) {
        return NextResponse.json({ error: 'node_id, summary are required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      const content = await fs.readFile(filePath, 'utf-8');
      const node = parseNodeMarkdown(content);
      node.summary = summary;
      node.frontmatter.updated_at = new Date().toISOString();
      const updatedContent = serializeNode(node);
      await updateNodeFile(filePath, updatedContent);
      return NextResponse.json({ success: true, node_id });
    }

    if (action === 'rename_title') {
      const { node_id, new_title } = body;
      if (!node_id || !new_title) {
        return NextResponse.json({ error: 'node_id, new_title are required' }, { status: 400 });
      }
      const cleanedTitle = cleanTitleText(new_title);
      if (!cleanedTitle) {
        return NextResponse.json({ error: '标题内容无效' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      const content = await fs.readFile(filePath, 'utf-8');
      const node = parseNodeMarkdown(content);
      node.frontmatter.title = cleanedTitle;
      node.frontmatter.updated_at = new Date().toISOString();
      const updatedContent = serializeNode(node);
      await updateNodeFile(filePath, updatedContent, { validate: false });
      let newFilePath = filePath;
      let wasRenamed = false;
      try {
        newFilePath = await renameNodeFile(filePath, cleanedTitle);
        wasRenamed = newFilePath !== filePath;
      } catch (renameErr) {
        console.warn('文件重命名失败:', renameErr instanceof Error ? renameErr.message : String(renameErr));
      }
      return NextResponse.json({ success: true, node_id, title: cleanedTitle, file_path: newFilePath, was_renamed: wasRenamed });
    }

    if (action === 'add_annotation') {
      const { node_id, annotation } = body;
      if (!node_id || !annotation) {
        return NextResponse.json({ error: 'node_id, annotation are required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      const content = await fs.readFile(filePath, 'utf-8');
      const node = parseNodeMarkdown(content);
      node.annotations = node.annotations ? node.annotations + '\n' + annotation : annotation;
      node.frontmatter.updated_at = new Date().toISOString();
      const updatedContent = serializeNode(node);
      await updateNodeFile(filePath, updatedContent);
      return NextResponse.json({ success: true, node_id });
    }

    if (action === 'add_sticky') {
      const { node_id, sticky } = body;
      if (!node_id || !sticky) {
        return NextResponse.json({ error: 'node_id, sticky are required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      const content = await fs.readFile(filePath, 'utf-8');
      const node = parseNodeMarkdown(content);
      node.stickies.push(sticky);
      node.frontmatter.updated_at = new Date().toISOString();
      const updatedContent = serializeNode(node);
      await updateNodeFile(filePath, updatedContent);
      return NextResponse.json({ success: true, node_id, stickies_count: node.stickies.length });
    }

    if (action === 'update_content') {
      const { node_id, content } = body;
      if (!node_id || !content) {
        return NextResponse.json({ error: 'node_id, content are required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      await updateNodeFile(filePath, content);
      const parsed = parseNodeMarkdown(content);
      return NextResponse.json({ success: true, node_id, updated_at: parsed.frontmatter.updated_at });
    }

    if (action === 'summarize') {
      const { node_id, question, answer, apiKey, baseUrl, providerModelId } = body;
      if (!node_id || !question || !answer) {
        return NextResponse.json({ error: 'node_id, question, answer are required' }, { status: 400 });
      }
      // 后端兜底：摘要生成也使用干净内容
      const { cleanAnswer } = stripMoodAndThink(answer);
      const FALLBACK_MAX_LEN = 100;
      const SUMMARY_TIMEOUT_MS = 30000;
      function fallbackSummary(text: string): string {
        const clean = text.replace(/\n/g, ' ').trim();
        return clean.length > FALLBACK_MAX_LEN ? clean.slice(0, FALLBACK_MAX_LEN) + '...' : clean;
      }
      let summary = '';
      let isFallback = true;
      if (apiKey && baseUrl && providerModelId) {
        try {
          const { default: OpenAI } = await import('openai');
          const client = new OpenAI({ apiKey, baseURL: baseUrl });
          const completionPromise = client.chat.completions.create({
            model: providerModelId,
            messages: [
              { role: 'system', content: '你是一个摘要生成器。请用一句话（100字以内）总结用户问题和AI回答的核心内容。直接输出摘要，不要加任何前缀或解释。' },
              { role: 'user', content: '问题：' + question + '\n\n回答：' + cleanAnswer.slice(0, 50000) },
            ],
            temperature: 0.3,
            max_tokens: 150,
          });
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('摘要生成超时')), SUMMARY_TIMEOUT_MS),
          );
          const completion = await Promise.race([completionPromise, timeoutPromise]);
          const result = completion.choices[0]?.message?.content?.trim() || '';
          if (result) {
            summary = result;
            isFallback = false;
          } else {
            summary = fallbackSummary(cleanAnswer);
          }
        } catch (e) {
          console.warn('摘要生成失败，使用 fallback:', e instanceof Error ? e.message : String(e));
          summary = fallbackSummary(cleanAnswer);
        }
      } else {
        summary = fallbackSummary(cleanAnswer);
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (filePath) {
        const content = await fs.readFile(filePath, 'utf-8');
        const node = parseNodeMarkdown(content);
        node.summary = summary;
        node.frontmatter.updated_at = new Date().toISOString();
        const updatedContent = serializeNode(node);
        await updateNodeFile(filePath, updatedContent);
      }
      return NextResponse.json({ success: true, node_id, summary, is_fallback: isFallback });
    }

    if (action === 'delete') {
      const { node_id } = body;
      if (!node_id) {
        return NextResponse.json({ error: 'node_id is required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      await fs.unlink(filePath);

      // 同步删除该节点的附件目录
      const assetsDir = join(project.path, 'assets', node_id);
      try {
        await fs.rm(assetsDir, { recursive: true, force: true });
      } catch {
        // 附件目录不存在时忽略
      }

      // 同步删除数据库中关联的边
      try {
        const dbPath = join(project.path, 'project.db');
        const db = await initDb(dbPath);
        await deleteEdgesByNode(db, project.id, node_id);
      } catch (dbErr) {
        console.warn('删除节点关联边失败:', dbErr instanceof Error ? dbErr.message : String(dbErr));
      }

      return NextResponse.json({ success: true, node_id });
    }

    return NextResponse.json({ error: 'Unknown action: ' + action }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    clearCurrentProjectPath();
  }
}

// ==================== GET: 读取节点 / 列出所有节点 ====================

export async function GET(request: NextRequest) {
  try {
    // 设置当前项目上下文
    const project = await getCurrentProject();
    setCurrentProjectPath(project.path);

    const { searchParams } = new URL(request.url);
    const nodeId = searchParams.get('id');
    const action = searchParams.get('action');

    if (action === 'raw') {
      if (!nodeId) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(nodeId, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + nodeId }, { status: 404 });
      }
      const content = await fs.readFile(filePath, 'utf-8');
      return NextResponse.json({ success: true, content });
    }

    if (action === 'list' || (!nodeId && !action)) {
      const nodesDir = join(project.path, 'nodes');
      try {
        const files = await fs.readdir(nodesDir);
        const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'example_node.md');
        const nodes = await Promise.all(
          mdFiles.map(async (file) => {
            try {
              const content = await fs.readFile(join(nodesDir, file), 'utf-8');
              const node = parseNodeMarkdown(content);
              return {
                node_id: node.frontmatter.node_id,
                title: node.frontmatter.title,
                created_at: node.frontmatter.created_at,
                updated_at: node.frontmatter.updated_at,
                sources: node.frontmatter.sources,
                model: node.frontmatter.model,
                mood: node.frontmatter.mood,
                tags: node.frontmatter.tags,
                summary: node.summary,
                conversations: node.conversations,
                annotations: node.annotations,
                stickies: node.stickies,
              };
            } catch {
              return null;
            }
          }),
        );
        return NextResponse.json({ success: true, nodes: nodes.filter(Boolean) });
      } catch {
        return NextResponse.json({ success: true, nodes: [] });
      }
    }

    if (!nodeId) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    console.log('[nodes:GET] looking up nodeId:', nodeId, 'project.path:', project.path);
    const filePath = await findNodeFileById(nodeId, project.path);
    if (!filePath) {
      return NextResponse.json({ error: '节点文件不存在: ' + nodeId }, { status: 404 });
    }
    const content = await fs.readFile(filePath, 'utf-8');
    const node = parseNodeMarkdown(content);
    return NextResponse.json({
      success: true,
      node: {
        node_id: node.frontmatter.node_id,
        title: node.frontmatter.title,
        created_at: node.frontmatter.created_at,
        updated_at: node.frontmatter.updated_at,
        sources: node.frontmatter.sources,
        model: node.frontmatter.model,
        mood: node.frontmatter.mood,
        tags: node.frontmatter.tags,
        summary: node.summary,
        conversations: node.conversations,
        annotations: node.annotations,
        stickies: node.stickies,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    clearCurrentProjectPath();
  }
}