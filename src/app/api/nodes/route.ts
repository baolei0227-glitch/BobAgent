import { NextRequest, NextResponse } from 'next/server';
import {
  createNodeMarkdown,
  appendConversation,
  removeConversation,
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
  readVersionToken,
  bumpUpdatedAt,
} from '@/lib/node-markdown';
import { getCurrentProject, getProjectById } from '@/lib/project/project-manager';
import { initDb, deleteEdgesByNode, listActiveEdges } from '@/lib/db';
import { validateOutcome, renderOutcome, parseOutcome, OUTCOME_FIELD_DEFS, OUTCOME_MAX_LENGTH, type Outcome } from '@/lib/nodes/outcome';
import { invalidateManifest, syncManifestAfterWrite } from '@/lib/nodes/manifest';
import {
  shouldCompact,
  extractHardFacts,
  runCompaction,
  extractGoalFromExistingMemory,
  compactionFallbackSummary,
  type CompactModelConfig,
} from '@/lib/nodes/compact';
import { inferContextWindow, modelOutputTokenMaxForModel } from '@/lib/context-limits';
import { readSettingsFromFile } from '@/lib/settings-server';
import { resolveTaskModel, resolveOutcomeModel } from '@/lib/wanted/task-model';
import { promises as fs } from 'fs';
import { join, resolve, sep, basename } from 'path';
import OpenAI from 'openai';
import { PROJECT_DB_FILENAME } from '@/lib/app-root';
import { cleanupMdAnnotationSidecars } from '@/lib/md-annotations-cleanup';
import { readEventLog } from '@/lib/trajectory/event-log';
import { appendPayloadFromEvents, type AppendDerivedPayload } from '@/lib/trajectory/export';

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

/** 成果块提取模型解析：统一复用 Wanted 模型解析（分层回退：chatModel → pool → taskModel → providers） */

/** 将节点标记为 stale（R-10：直接下游失效标记，UI 显示告警但不阻断使用） */
async function markStale(nodeId: string, projectPath: string): Promise<void> {
  try {
    const childPath = await findNodeFileById(nodeId, projectPath);
    if (!childPath) return;
    const childContent = await fs.readFile(childPath, 'utf-8');
    const child = parseNodeMarkdown(childContent);
    child.frontmatter.outcome_status = 'stale';
    child.frontmatter.updated_at = new Date().toISOString();
    await updateNodeFile(childPath, serializeNode(child));
  } catch (e) {
    console.warn('[nodes:lock] 标记下游 stale 失败 nodeId:', nodeId, e instanceof Error ? e.message : String(e));
  }
}

// ==================== 成果块懒生成 ====================

/** 判定成果块是否仍为空模板（8 字段全为空值标记「无」/「无已知限制」/空串），用于决定锁定时是否需要懒生成 */
function isOutcomeBlank(outcome: Outcome | null | undefined): boolean {
  if (!outcome) return true;
  const record = outcome as unknown as Record<string, string>;
  return OUTCOME_FIELD_DEFS.every((def) => {
    const val = (record[def.key] ?? '').trim();
    return val === '' || val === '无' || val === '无已知限制';
  });
}

/**
 * 懒生成成果块（锁定/连线自动锁定时调用）：用模型从当前对话记录提炼成果块并写回文件。
 * - 未配置模型 / 无对话 / 模型返回空 / 解析失败 → 返回 { ok:false, error }，调用方不阻塞，转由成果块校验兜底。
 * - 写回时推进 outcome_turns 覆盖全部对话轮次，供后续锁定校验「是否已覆盖最新轮次」。
 */
async function generateOutcomeForNode(filePath: string): Promise<{ ok: boolean; outcome?: Outcome | null; error?: string }> {
  try {
    const cfg = await resolveOutcomeModel();
    if (!cfg) return { ok: false, error: '未配置模型，无法生成成果块' };

    const latestContent = await fs.readFile(filePath, 'utf-8');
    const latestParsed = parseNodeMarkdown(latestContent);
    if (latestParsed.conversations.length === 0) return { ok: false, error: '节点无对话记录，无法生成成果块' };
    // R-9: 已锁定节点不重写成果块（保护签字；继续对话须先解锁）
    if (latestParsed.frontmatter.outcome_status === 'locked') return { ok: true, outcome: latestParsed.outcome ?? null };

    const conversationText = latestParsed.conversations
      .map((t, i) => {
        const parts: string[] = [];
        parts.push(`### 第 ${i + 1} 轮`);
        parts.push(`用户: ${t.question}`);
        if (t.questionAttachments && t.questionAttachments.length > 0) {
          parts.push(`(附件: ${t.questionAttachments.map(a => a.name).join(', ')})`);
        }
        parts.push(`AI: ${t.answer}`);
        return parts.join('\n');
      })
      .join('\n\n');

    // 检查是否有用户手动修改的成果块需要保护
    const isUserEdited = latestParsed.frontmatter.outcome_user_edited === true;
    const existingOutcome = latestParsed.outcome;
    const preservationNote = isUserEdited && existingOutcome
      ? [
          '',
          '## 当前成果块（已被用户手动修正，以下字段内容必须保留，不可修改）',
          renderOutcome(existingOutcome),
          '',
          '重要：上述成果块中的字段已被用户手动修正过。',
          '请在提炼新的成果块时，严格保留这些手动修正的内容，',
          '仅更新其他字段以反映新增对话信息。',
          '尤其是用户填写过非「无」值的字段，一个字都不能改。',
        ].join('\n')
      : '';

    const OUTCOME_EXTRACT_SYSTEM = [
      '你是法律成果提炼器。请根据对话记录，提炼出以下 8 个字段的结构化成果块。',
      '',
      '输出格式（严格按以下 8 节，每节以 ### 标题开头）：',
      '### 事实认定',
      '### 法律依据',
      '### 分析推理',
      '### 结论',
      '### 明确排除',
      '### 适用限制',
      '### 待确认',
      '### 用户补充',
      '',
      '规则：',
      '- 每个字段如无内容，必须写「无」而非留空或省略；不得写「（暂无）」「暂无」等变体。',
      '- 事实认定和法律依据中的每条信息须带 [来源: 本节点] 标记（本节点对话记录中提炼；若内容来自上游节点成果块，则写 [来源: n_上游节点id#q-锚点]）。',
      '- 法律依据中的每条须可定位（含条款号/案例编号/法释编号），无法定位的标 [待核实]。',
      '- 结论中的每条须带确定性等级：[确定] / [倾向性] / [存疑]。',
      '- 待确认的每条须写明所需内容与责任方（如「需用户提供xxx」）。',
      '- 适用限制如无，写「无已知限制」。',
      '- 用户补充始终写「无」（仅用户可填写）。',
      '- 每条以 "- " 列表项格式书写。',
      '- 仅输出上述 8 节内容，不要输出其他解释、引言或总结。',
      ...(isUserEdited ? ['', '重要：当前成果块中的部分字段已被用户手动修正。你必须严格保留用户修正过的内容，不得覆盖或修改。只有用户未修正的字段（内容仅为「无」或空）才可以根据新增对话内容更新。'] : []),
    ].join('\n');

    const userPrompt = [
      '## 对话记录',
      '',
      conversationText,
      preservationNote,
      '',
      '请提炼成果块：',
    ].join('\n');

    const client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl,
      timeout: 60_000,
    });
    const resp = await client.chat.completions.create({
      model: cfg.model,
      messages: [
        { role: 'system', content: OUTCOME_EXTRACT_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      temperature: 0.1,
    });
    const rawText = (resp.choices[0]?.message?.content || '').trim();
    if (!rawText) return { ok: false, error: '模型未返回成果块内容' };

    let newOutcome = parseOutcome(rawText);
    if (!newOutcome) return { ok: false, error: '成果块解析失败' };

    // 再次读取（生成期间文件可能已被并发修改）
    const finalContent = await fs.readFile(filePath, 'utf-8');
    const node = parseNodeMarkdown(finalContent);

    // 合并保护：用户手动修改过的非空字段 → 保留用户值，不覆盖
    if (node.frontmatter.outcome_user_edited && node.outcome) {
      const record = node.outcome as unknown as Record<string, string>;
      const newRecord = newOutcome as unknown as Record<string, string>;
      for (const key of OUTCOME_FIELD_DEFS.map(d => d.key)) {
        const userVal = (record[key] ?? '').trim();
        // 用户填写过非空且非空标记「无」的字段 → 保留
        if (userVal && userVal !== '无' && userVal !== '无已知限制' && key !== 'user_notes') {
          newRecord[key] = record[key];
        }
      }
    }

    node.outcome = newOutcome as typeof node.outcome;
    if (!node.frontmatter.outcome_status || node.frontmatter.outcome_status === 'legacy') {
      node.frontmatter.outcome_status = 'draft';
    }
    // 记录成果块已覆盖的对话轮次：锁定前据此判断是否有未提炼的新对话（防竞态锁旧成果块）
    node.frontmatter.outcome_turns = node.conversations.length;
    node.frontmatter.updated_at = new Date().toISOString();
    await updateNodeFile(filePath, serializeNode(node));
    return { ok: true, outcome: newOutcome };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ==================== think 分离工具 ====================

/** think 标签及其常见变体（大小写不敏感）：与前端 parseThink 保持一致，
 *  识别 <think> / <thinking> / <Thought> / <reasoning> 等，避免变体标签残留到 .md */
const THINK_TAG_RE = /<(?:think|thinking|thought|reasoning)>[\s\S]*?<\/(?:think|thinking|thought|reasoning)>/gi;

/** 从回答内容中移除 think 标签，返回干净内容 */
function stripThink(content: string): string {
  let clean = content;

  // 移除完整的 think 标签
  clean = clean.replace(THINK_TAG_RE, '');
  // 处理未闭合的 think 标签
  clean = clean.replace(/<(?:think|thinking|thought|reasoning)>[\s\S]*$/i, '');

  const result = clean.trim();
  // 安全兜底：如果结果为空但原文有实质内容，可能是标签未闭合导致全部被清空
  if (!result && content.length > 20) {
    const fallback = content
      .replace(THINK_TAG_RE, '')
      .trim();
    return fallback || content.trim();
  }

  return result;
}

// ==================== POST: 创建/更新节点 ====================

export async function POST(request: NextRequest) {
  // body 提升到函数级：finally 中按 action 做写时维护（manifest 同步）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any = {};
  // explicitProjectId 提升到函数级：finally 中 syncManifestForAction 需要访问
  let explicitProjectId: string | undefined = undefined;
  try {
    body = await request.json();
    const { action } = body;

    // 设置当前项目上下文：body 显式传 project_id 时（如临时节点投影）优先用指定项目，否则走当前项目
    const explicitProjectIdRaw = body.project_id;
    explicitProjectId = typeof explicitProjectIdRaw === 'string' && explicitProjectIdRaw ? explicitProjectIdRaw : undefined;
    const project = explicitProjectId
      ? await getProjectById(explicitProjectId)
      : await getCurrentProject();
    setCurrentProjectPath(project.path);

    if (action === 'create') {
      const { title, model, sources, tags, position_x, position_y, sandbox_app_id, node_type, annotated_node_ids, annotation_text, md_anchor } = body;
      if (!title) {
        return NextResponse.json({ error: 'title is required' }, { status: 400 });
      }
      const cleanedTitle = cleanTitleText(title) || '未命名节点';
      const nodeId = body.node_id || generateNodeId();
      const mdContent = createNodeMarkdown(nodeId, cleanedTitle, {
        model, sources, tags,
        position_x: typeof position_x === 'number' ? position_x : undefined,
        position_y: typeof position_y === 'number' ? position_y : undefined,
        sandbox_app_id: typeof sandbox_app_id === 'string' && sandbox_app_id ? sandbox_app_id : undefined,
        node_type: typeof node_type === 'string' && node_type ? node_type : undefined,
        annotation_node_ids: Array.isArray(annotated_node_ids) && annotated_node_ids.length > 0 ? annotated_node_ids : undefined,
        annotation_text: typeof annotation_text === 'string' && annotation_text ? annotation_text : undefined,
        md_anchor: typeof md_anchor === 'string' && md_anchor ? md_anchor : undefined,
      });
      const relativePath = await writeNodeFile(cleanedTitle, mdContent);
      return NextResponse.json({ success: true, node_id: nodeId, title: cleanedTitle, file_path: relativePath });
    }

    // 在 homework/ 根目录下新建普通 MD 文档（节点输入框「MD」按钮触发）：
    // 存储平铺（不生成 kind 子文件夹），登记 homework/.ownership.json 归属，侧边栏按类别标签分组展示
    if (action === 'create_homework_md') {
      const { node_id } = body;
      if (!node_id || typeof node_id !== 'string') {
        return NextResponse.json({ error: 'node_id is required' }, { status: 400 });
      }
      const nodeDir = join(project.path, 'homework');
      await fs.mkdir(nodeDir, { recursive: true });
      // 避重命名：untitled.md → untitled-2.md …
      let name = 'untitled.md';
      let counter = 2;
      const fileExists = async (p: string): Promise<boolean> => {
        try { await fs.access(p); return true; } catch { return false; }
      };
      while (await fileExists(join(nodeDir, name))) {
        name = `untitled-${counter}.md`;
        counter++;
      }
      const absPath = join(nodeDir, name);
      await fs.writeFile(absPath, '', 'utf-8');
      // 登记归属：homework/.ownership.json 相对路径 → nodeId（原子写：tmp + rename）
      // 相对 homework 根路径（如 untitled.md），与 chat/tools.ts 写入口径一致
      const rel = name;
      const manifestPath = join(project.path, 'homework', '.ownership.json');
      let manifest: Record<string, string> = {};
      try {
        manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Record<string, string>;
      } catch { /* 无清册或损坏，重建 */ }
      manifest[rel] = node_id;
      const tmpPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2), 'utf-8');
      await fs.rename(tmpPath, manifestPath);
      return NextResponse.json({ success: true, path: `homework/${rel}`, name });
    }

    // 更新画布节点位置（拖拽停止时调用，重启恢复布局用）
    if (action === 'update_position') {
      const { node_id, position_x, position_y } = body;
      if (!node_id || typeof position_x !== 'number' || typeof position_y !== 'number') {
        return NextResponse.json({ error: 'node_id, position_x, position_y are required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      const content = await fs.readFile(filePath, 'utf-8');
      const node = parseNodeMarkdown(content);
      node.frontmatter.position_x = Math.round(position_x);
      node.frontmatter.position_y = Math.round(position_y);
      node.frontmatter.updated_at = new Date().toISOString();
      await updateNodeFile(filePath, serializeNode(node));
      return NextResponse.json({ success: true, node_id });
    }

    // 更新批注框（annotation 节点）的批注文字
    if (action === 'update_annotation') {
      const { node_id, text } = body;
      if (!node_id || typeof text !== 'string') {
        return NextResponse.json({ error: 'node_id, text are required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      const content = await fs.readFile(filePath, 'utf-8');
      const node = parseNodeMarkdown(content);
      node.frontmatter.annotation_text = text;
      node.frontmatter.updated_at = new Date().toISOString();
      await updateNodeFile(filePath, serializeNode(node));
      return NextResponse.json({ success: true, node_id });
    }

    // 星标切换（任意节点）：标记画布重要性，仅提示用途
    if (action === 'update_star') {
      const { node_id, starred } = body;
      if (!node_id || typeof starred !== 'boolean') {
        return NextResponse.json({ error: 'node_id, starred(boolean) are required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      const content = await fs.readFile(filePath, 'utf-8');
      const node = parseNodeMarkdown(content);
      node.frontmatter.starred = starred;
      node.frontmatter.updated_at = new Date().toISOString();
      await updateNodeFile(filePath, serializeNode(node));
      return NextResponse.json({ success: true, node_id, starred });
    }

    if (action === 'append') {
      const { node_id, question, answer, questionTime, answerTime, summary, question_attachments, title, compact_model_config, model_id, thinking_level, reasoning, process_narration, tool_calls, task_id, output_files, derive } = body;
      if (!node_id) {
        return NextResponse.json({ error: 'node_id is required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      // 节点文件不存在时直接拒绝（而非自动重建）：正常流程总是先 create 再 append，
      // 若此处重建会把"用户已删除的节点"复活（删除后迟到的 append 会重新创建 .md 文件，重启后节点再现）
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      // —— 方案 A（derive 模式）：从本轮事件日志派生 append 摘要（.md 与事件日志同源）——
      // question/answer/reasoning/tool_calls/output_files 由日志派生值补缺；
      // 日志尚未落盘（persist 与前端 append 的时序竞态）→ 短重试，仍缺失则回退前端直传字段。
      let derivedPayload: AppendDerivedPayload | null = null;
      if (derive === true && typeof task_id === 'string' && task_id && /^[A-Za-z0-9._:-]{1,96}$/.test(task_id)) {
        const trajPath = join(project.path, '.trajectory', node_id, `${task_id}.jsonl`);
        for (const waitMs of [0, 250, 700]) {
          if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
          const events = readEventLog(trajPath);
          if (events.length > 0) {
            derivedPayload = appendPayloadFromEvents(events);
            break;
          }
        }
      }
      const questionText = (typeof question === 'string' && question.trim())
        ? question
        : (derivedPayload?.question || '');
      const answerRaw = derivedPayload?.answer || (typeof answer === 'string' ? answer : '');
      if (!questionText || !answerRaw) {
        return NextResponse.json({ error: 'node_id, question, answer are required' }, { status: 400 });
      }
      // 后端兜底：移除 think 标签
      const cleanAnswer = stripThink(answerRaw);
      const reasoningText = (typeof reasoning === 'string' && reasoning.trim())
        ? reasoning
        : (derivedPayload?.reasoning || undefined);
      // 派生步骤/文件映射到 ConversationTurn 结构（durationMs/source 等必填字段补齐）
      const derivedToolCalls = derivedPayload?.toolCalls?.map((t) => ({
        toolName: t.toolName,
        arguments: t.arguments,
        result: t.result,
        durationMs: t.durationMs ?? 0,
        success: t.success,
        phase: t.phase,
      }));
      const derivedOutputFiles = derivedPayload?.outputFiles?.map((f) => ({
        path: f.path,
        name: f.name,
        size: f.size,
        kind: f.kind,
        source: f.source ?? '',
      }));
      const toolCallsFinal = (Array.isArray(tool_calls) && tool_calls.length > 0)
        ? tool_calls
        : (derivedToolCalls && derivedToolCalls.length > 0 ? derivedToolCalls : undefined);
      const outputFilesFinal = (Array.isArray(output_files) && output_files.length > 0)
        ? output_files
        : (derivedOutputFiles && derivedOutputFiles.length > 0 ? derivedOutputFiles : undefined);
      const content = await fs.readFile(filePath, 'utf-8');
      const updatedContent = appendConversation(content, questionText, cleanAnswer, {
        questionTime, answerTime, summary,
        questionAttachments: question_attachments,
        modelId: typeof model_id === 'string' ? model_id : undefined,
        thinkingLevel: typeof thinking_level === 'string' ? thinking_level as 'off' | 'low' | 'medium' | 'high' | 'max' : undefined,
        reasoning: reasoningText && reasoningText.trim() ? reasoningText : undefined,
        processNarration: typeof process_narration === 'string' && process_narration.trim() ? process_narration : undefined,
        taskId: typeof task_id === 'string' && task_id.trim() ? task_id : undefined,
        toolCalls: toolCallsFinal && toolCallsFinal.length > 0 ? toolCallsFinal : undefined,
        outputFiles: outputFilesFinal && outputFilesFinal.length > 0 ? outputFilesFinal : undefined,
      });
      await updateNodeFile(filePath, updatedContent);
      const parsedAfterAppend = parseNodeMarkdown(updatedContent);

      // ==================== 增量压缩触发（R-25~R-27） ====================
      // 只在 append 成功后触发；触发阈值 4000token / 5 轮；失败不影响本次写入。
      let compacted: { new_compacted_until: number; appended_facts: number } | null = null;
      try {
        const decision = shouldCompact(
          parsedAfterAppend.conversations,
          parsedAfterAppend.frontmatter.memory_compacted_until ?? 0,
          model_id ? inferContextWindow(model_id, thinking_level === 'high') : undefined,
          parsedAfterAppend.frontmatter.memory_compacted_at,
        );
        if (decision.shouldCompact && decision.range) {
          const { start, end } = decision.range;
          const existing = parsedAfterAppend.compressedMemory || '';
          const turnsToCompact = parsedAfterAppend.conversations.slice(start, end);
          const finalText = turnsToCompact.reduce((s, t) => s + (t.question || '') + (t.answer || ''), '');
          const finalHardFacts = extractHardFacts(finalText);

          // 模型配置优先级：
          //   1) 本次请求透传的 compact_model_config（节点自定义模型正在用它，能省 Key 就省）
          //   2) settings 中第一个自定义 provider + 它的默认聊天模型
          //   3) 托管模型（无 Key）→ 跳过模型，只写硬事实直写版，游标照样推进
          let modelCfg: CompactModelConfig | null = null;
          if (
            compact_model_config &&
            typeof compact_model_config === 'object' &&
            typeof (compact_model_config as any).apiKey === 'string' &&
            typeof (compact_model_config as any).baseURL === 'string' &&
            typeof (compact_model_config as any).model === 'string'
          ) {
            modelCfg = compact_model_config as CompactModelConfig;
          } else {
            try {
              const settings = await readSettingsFromFile();
              const providers = (settings as any).providers || [];
              const firstEnabled = providers.find((p: any) => p.enabled !== false && p.apiKey && p.baseUrl);
              if (firstEnabled) {
                const defaultModel =
                  firstEnabled.defaultModel ||
                  firstEnabled.models?.find((m: any) => m.enabled)?.id ||
                  firstEnabled.models?.[0]?.id;
                if (defaultModel) {
                  modelCfg = {
                    apiKey: firstEnabled.apiKey,
                    baseURL: firstEnabled.baseUrl,
                    model: defaultModel,
                  };
                }
              }
            } catch (e) {
              console.warn('[nodes:append] 读取 settings 获取压缩模型失败，降级:', e instanceof Error ? e.message : String(e));
            }
          }

          // 避免重复 fs 读取：用刚刚更新过的内容再 parse 一次
          let existingParsed = parseNodeMarkdown(await fs.readFile(filePath, 'utf-8'));

          if (modelCfg) {
            const result = await runCompaction(
              {
                goal: extractGoalFromExistingMemory(existing),
                existingMemory: existing,
                uncompressedTurns: turnsToCompact,
                hardFacts: finalHardFacts,
              },
              modelCfg,
            );
            existingParsed.compressedMemory = result.rendered;
            existingParsed.frontmatter.memory_compacted_at = new Date().toISOString();
            existingParsed.frontmatter.memory_compacted_until = end;
            existingParsed.frontmatter.memory_turn_count = 0;
            existingParsed.frontmatter.updated_at = new Date().toISOString();
            await updateNodeFile(filePath, serializeNode(existingParsed));
            compacted = {
              new_compacted_until: end,
              appended_facts: result.hardFactsAppended.length,
            };
            console.log(
              `[compact] 完成（${decision.reason}）：轮次 ${start}..${end} 入参≈${result.tokenApprox.input} tokens，输出≈${result.tokenApprox.output} tokens，硬事实漏写${result.hardFactsAppended.length}条已强制补回。`,
            );
          } else {
            // 无模型可用 → 与 route R-14-C 共用 compactionFallbackSummary：只把硬事实直写成 settled，
            // 推理/争议/偏好留空。游标照推，避免下次同一段反复触发。
            existingParsed.compressedMemory = compactionFallbackSummary({
              goal: extractGoalFromExistingMemory(existing),
              existingMemory: existing,
              uncompressedTurns: turnsToCompact,
              hardFacts: finalHardFacts,
            });
            existingParsed.frontmatter.memory_compacted_at = new Date().toISOString();
            existingParsed.frontmatter.memory_compacted_until = end;
            existingParsed.frontmatter.memory_turn_count = 0;
            existingParsed.frontmatter.updated_at = new Date().toISOString();
            await updateNodeFile(filePath, serializeNode(existingParsed));
            compacted = { new_compacted_until: end, appended_facts: finalHardFacts.length };
            console.log(`[compact] 无可调用模型，硬事实直写 ${finalHardFacts.length} 条。游标推进到 ${end}。`);
          }
        }
      } catch (e) {
        console.warn('[nodes:append] 增量压缩阶段异常（已吞，不影响写入）:', e instanceof Error ? e.message : String(e));
      }

      const finalParsed = parseNodeMarkdown(await fs.readFile(filePath, 'utf-8'));
      return NextResponse.json({
        success: true,
        node_id,
        conversations_count: finalParsed.conversations.length,
        updated_at: finalParsed.frontmatter.updated_at,
        ...(compacted ? { compacted } : {}),
      });
    }

    if (action === 'remove_last_round') {
      const { node_id } = body;
      if (!node_id) {
        return NextResponse.json({ error: 'node_id is required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = parseNodeMarkdown(content);
      if (parsed.conversations.length === 0) {
        return NextResponse.json({ success: true, node_id, conversations_count: 0, skipped: true });
      }
      const lastIndex = parsed.conversations.length - 1;
      const updatedContent = removeConversation(content, lastIndex);
      await updateNodeFile(filePath, updatedContent);
      const reparsed = parseNodeMarkdown(updatedContent);
      return NextResponse.json({ success: true, node_id, conversations_count: reparsed.conversations.length, updated_at: reparsed.frontmatter.updated_at });
    }

    if (action === 'remove_round') {
      const { node_id, round_index } = body;
      if (!node_id || round_index === undefined) {
        return NextResponse.json({ error: 'node_id, round_index are required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      const content = await fs.readFile(filePath, 'utf-8');
      const updatedContent = removeConversation(content, Number(round_index));
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

    if (action === 'update_agent_state') {
      // 持久化节点级 MCP / 技能选择到 frontmatter（重启恢复）
      // 按字段存在性更新：传 null 表示清除（回归跟随全局），字段缺失表示保留现值
      const { node_id } = body;
      if (!node_id) {
        return NextResponse.json({ error: 'node_id is required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      const content = await fs.readFile(filePath, 'utf-8');
      const node = parseNodeMarkdown(content);
      if ('enabledMcpIds' in body) {
        node.frontmatter.enabledMcpIds = body.enabledMcpIds ?? undefined;
      }
      if ('selectedSkills' in body) {
        node.frontmatter.selectedSkills = body.selectedSkills ?? undefined;
      }
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
        // 标题全是 emoji/特殊字符清洗后为空，保持原标题不变
        return NextResponse.json({ success: true, node_id, title: null, was_renamed: false, skipped: true });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      const nodeContent = await fs.readFile(filePath, 'utf-8');
      const node = parseNodeMarkdown(nodeContent);
      // 如果原标题已经和清洗后的标题相同，跳过重命名
      if (node.frontmatter.title === cleanedTitle) {
        return NextResponse.json({ success: true, node_id, title: cleanedTitle, was_renamed: false });
      }
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

    if (action === 'update_content') {
      const { node_id, content, base_version } = body;
      if (!node_id || !content) {
        return NextResponse.json({ error: 'node_id, content are required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      // 乐观并发：客户端保存时回传加载时刻的 mtimeMs 令牌，写前比对磁盘当前值，
      // 不一致说明加载后被外部（AI 写盘等）改写，拒绝静默覆盖并返回磁盘当前内容供前端提示。
      const currentVersion = await readVersionToken(filePath);
      if (typeof base_version === 'number' && currentVersion !== null && Math.abs(currentVersion - base_version) > 1) {
        return NextResponse.json({
          conflict: true,
          current_version: currentVersion,
          current_content: await fs.readFile(filePath, 'utf-8'),
        });
      }
      // R-9: 已锁定节点的成果块修改必须显式解锁（对话记录仍可追加）
      const oldNode = parseNodeMarkdown(await fs.readFile(filePath, 'utf-8'));
      if (oldNode.frontmatter.outcome_status === 'locked') {
        const oldOutcome = oldNode.outcome ? renderOutcome(oldNode.outcome) : '';
        const newParsed = parseNodeMarkdown(content);
        const newOutcome = newParsed.outcome ? renderOutcome(newParsed.outcome) : '';
        if (oldOutcome !== newOutcome) {
          return NextResponse.json(
            { error: 'R-9 已锁定节点的成果块修改需先解锁（先调用 unlock，再编辑成果块）' },
            { status: 400 },
          );
        }
      }
      // 用户保存节点文档时回写 updated_at（此前透传旧值，时间戳语义错误）
      const savedContent = bumpUpdatedAt(content);
      await updateNodeFile(filePath, savedContent);
      const parsed = parseNodeMarkdown(savedContent);
      const newVersion = await readVersionToken(filePath);
      return NextResponse.json({
        success: true,
        node_id,
        updated_at: parsed.frontmatter.updated_at,
        version: newVersion ?? currentVersion ?? Date.now(),
      });
    }

    // ===== v3：锁定 / 解锁（规格 v3 §六 R-1~R-11）=====

    if (action === 'lock') {
      const { node_id, max_length, force } = body;
      if (!node_id) {
        return NextResponse.json({ error: 'node_id is required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      const content = await fs.readFile(filePath, 'utf-8');
      let node = parseNodeMarkdown(content);

      // ==================== 成果块懒生成 ====================
      // 成果块不再于 append 时自动提炼（省 token），改为锁定时按需生成：
      // 触发条件——成果块为空模板，或存在尚未覆盖的新对话轮次（锁定后解锁继续对话再重锁时）。
      // 已锁定节点受 R-9 保护，不重新生成。
      const isLockedNow = node.frontmatter.outcome_status === 'locked';
      const coveredTurns = node.frontmatter.outcome_turns ?? 0;
      const needsGeneration = !isLockedNow && (
        isOutcomeBlank(node.outcome) ||
        node.conversations.length > coveredTurns
      );
      if (needsGeneration) {
        const genResult = await generateOutcomeForNode(filePath);
        if (!genResult.ok) {
          // 生成失败（未配置模型 / 无对话 / 模型报错）: R-1 语义要求锁定前必须有成果块，故阻塞锁定
          return NextResponse.json({
            success: false,
            error: `成果块生成失败，无法锁定：${genResult.error ?? '未知错误'}`,
            outcome_generate_error: true,
          }, { status: 400 });
        }
        // 生成完成已写回文件（outcome_turns 已推进到当前轮次），重新读取以锁定最新状态
        const regeneratedContent = await fs.readFile(filePath, 'utf-8');
        node = parseNodeMarkdown(regeneratedContent);
      }

      // R-1: 成果块必须存在且有实质内容（懒生成后仍为空模板则不可锁定）
      if (!node.outcome || isOutcomeBlank(node.outcome)) {
        return NextResponse.json({ error: 'R-1 节点缺少成果块，无法锁定（旧节点请先补全成果块）' }, { status: 400 });
      }
      // R-1 ~ R-8b: 校验成果块（force=true 时校验未通过可强制锁定，由用户自主决定）
      const maxLen = typeof max_length === 'number' && max_length > 0 ? max_length : OUTCOME_MAX_LENGTH;
      const validation = validateOutcome(node.outcome, maxLen);
      const forceLock = force === true && !validation.valid;
      if (!validation.valid && !forceLock) {
        // error 字段直接带完整规则清单，保证任何调用方（Alert/日志）都能看到具体原因
        return NextResponse.json({
          success: false,
          error: `成果块校验未通过:\n${validation.errors.join('\n')}`,
          errors: validation.errors,
        }, { status: 400 });
      }

      // R-10: 锁定即签字，outcome_version 递增
      const now = new Date().toISOString();
      node.frontmatter.outcome_status = 'locked';
      node.frontmatter.outcome_locked_at = now;
      node.frontmatter.outcome_version = (node.frontmatter.outcome_version ?? 0) + 1;
      // 强制锁定标记：校验未通过但用户自主决定 → 记录；校验通过 → 清除
      if (forceLock) {
        node.frontmatter.outcome_force_locked = true;
      } else {
        delete node.frontmatter.outcome_force_locked;
      }
      node.frontmatter.updated_at = now;
      const updatedContent = serializeNode(node);
      await updateNodeFile(filePath, updatedContent);

      // R-10: 全部直接下游节点标记 stale（有边才标记，首次锁定无出边则无副作用）
      let staleChildren = 0;
      try {
        const dbPath = join(project.path, PROJECT_DB_FILENAME);
        const db = await initDb(dbPath);
        const edges = await listActiveEdges(db, project.id);
        for (const edge of edges) {
          if (edge.from_node_id !== node_id) continue;
          await markStale(edge.to_node_id, project.path);
          staleChildren++;
        }
      } catch (err) {
        console.warn('[nodes:lock] 标记下游 stale 失败:', err instanceof Error ? err.message : String(err));
      }

      return NextResponse.json({
        success: true,
        node_id,
        outcome_status: 'locked',
        outcome_version: node.frontmatter.outcome_version,
        force_locked: forceLock,
        stale_children: staleChildren,
      });
    }

    if (action === 'unlock') {
      const { node_id } = body;
      if (!node_id) {
        return NextResponse.json({ error: 'node_id is required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      const content = await fs.readFile(filePath, 'utf-8');
      const node = parseNodeMarkdown(content);
      if (node.frontmatter.outcome_status !== 'locked') {
        return NextResponse.json({ success: false, error: '节点当前未处于锁定状态' }, { status: 400 });
      }
      node.frontmatter.outcome_status = 'draft';
      delete node.frontmatter.outcome_locked_at;
      delete node.frontmatter.outcome_force_locked;
      node.frontmatter.updated_at = new Date().toISOString();
      const updatedContent = serializeNode(node);
      await updateNodeFile(filePath, updatedContent);

      // 解锁时标记直接下游为 stale（上游成果块可能被修改）
      let staleChildren = 0;
      try {
        const dbPath = join(project.path, PROJECT_DB_FILENAME);
        const db = await initDb(dbPath);
        const edges = await listActiveEdges(db, project.id);
        for (const edge of edges) {
          if (edge.from_node_id !== node_id) continue;
          await markStale(edge.to_node_id, project.path);
          staleChildren++;
        }
      } catch (err) {
        console.warn('[nodes:unlock] 标记下游 stale 失败:', err instanceof Error ? err.message : String(err));
      }

      return NextResponse.json({ success: true, node_id, outcome_status: 'draft', stale_children: staleChildren });
    }

    if (action === 'summarize') {
      const { node_id, question, answer, apiKey, baseUrl, providerModelId } = body;
      if (!node_id || !question || !answer) {
        return NextResponse.json({ error: 'node_id, question, answer are required' }, { status: 400 });
      }
      // 后端兜底：摘要生成也使用干净内容
      const cleanAnswer = stripThink(answer);
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

    if (action === 'update_outcome') {
      const { node_id, outcome_section } = body;
      if (!node_id || !outcome_section) {
        return NextResponse.json({ error: 'node_id, outcome_section are required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }
      const content = await fs.readFile(filePath, 'utf-8');
      const node = parseNodeMarkdown(content);
      // R-9: locked 状态下拒绝修改成果块
      if (node.frontmatter.outcome_status === 'locked') {
        return NextResponse.json(
          { error: 'R-9 已锁定节点的成果块修改需先解锁' },
          { status: 400 },
        );
      }
      // 从 outcome_section 解析出新成果块，替换到现有文档
      const outcomeText = outcome_section.replace(/^## 成果块\n?/i, '');
      const newOutcome = parseOutcome(outcomeText);
      if (newOutcome) {
        node.outcome = newOutcome;
        // 记录成果块已覆盖的对话轮次（用户手动补全，防锁定时误判为未提炼）
        node.frontmatter.outcome_turns = node.conversations.length;
        // 标记用户已手动编辑，AI 自动生成时不得覆盖
        node.frontmatter.outcome_user_edited = true;
      }
      if (!node.frontmatter.outcome_status || node.frontmatter.outcome_status === 'legacy') {
        node.frontmatter.outcome_status = 'draft';
      }
      node.frontmatter.updated_at = new Date().toISOString();
      let updatedContent = serializeNode(node);

      // 在对话记录末尾追加系统提示
      const noteTimestamp = new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const manualNote = `\n> [系统提示 ${noteTimestamp}] 用户已手动修正成果块，后续对话请以修正后的成果块为准，不可随意更改已修正字段。`;
      const convSectionMatch = updatedContent.match(/(## 对话记录\n)/);
      if (convSectionMatch) {
        // 在对话记录标题后、第一条对话前插入提示
        updatedContent = updatedContent.replace(
          /(## 对话记录\n)/,
          `$1${manualNote}\n`,
        );
      }

      await updateNodeFile(filePath, updatedContent);
      return NextResponse.json({ success: true, node_id });
    }

    if (action === 'extract_outcome') {
      const { node_id } = body;
      if (!node_id) {
        return NextResponse.json({ error: 'node_id is required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }

      // 1. 读取节点对话记录
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = parseNodeMarkdown(content);
      if (parsed.conversations.length === 0) {
        return NextResponse.json({ error: '节点尚无对话记录' }, { status: 400 });
      }

      // 2. 读取模型配置：复用主对话模型（分层回退），两者皆无则提示配置
      const cfg = await resolveTaskModel();
      if (!cfg) {
        return NextResponse.json(
          { error: '尚未配置任何模型。请在【设置 → Models】中添加 API Key 并勾选聊天模型，或在【Role Assignment → Chat Model】把模型加入候选池。' },
          { status: 400 },
        );
      }

      // 3. 构建对话文本
      const conversationText = parsed.conversations
        .map((t, i) => {
          const parts: string[] = [];
          parts.push(`### 第 ${i + 1} 轮`);
          parts.push(`用户: ${t.question}`);
          if (t.questionAttachments && t.questionAttachments.length > 0) {
            parts.push(`(附件: ${t.questionAttachments.map(a => a.name).join(', ')})`);
          }
          parts.push(`AI: ${t.answer}`);
          return parts.join('\n');
        })
        .join('\n\n');

      // 3b. 检查是否有用户手动修改的成果块需要保护
      const isUserEdited = parsed.frontmatter.outcome_user_edited === true;
      const preservationNote = isUserEdited && parsed.outcome
        ? [
            '',
            '## 当前成果块（已被用户手动修正，以下字段内容必须保留，不可修改）',
            renderOutcome(parsed.outcome),
            '',
            '重要：上述成果块中的字段已被用户手动修正过。',
            '请在提炼新的成果块时，严格保留这些手动修正的内容，',
            '仅更新其他字段以反映新增对话信息。',
            '尤其是用户填写过非「无」值的字段，一个字都不能改。',
          ].join('\n')
        : '';

      // 4. 构建 system prompt
      const OUTCOME_EXTRACT_SYSTEM = [
        '你是法律成果提炼器。请根据对话记录，提炼出以下 8 个字段的结构化成果块。',
        '',
        '输出格式（严格按以下 8 节，每节以 ### 标题开头）：',
        '### 事实认定',
        '### 法律依据',
        '### 分析推理',
        '### 结论',
        '### 明确排除',
        '### 适用限制',
        '### 待确认',
        '### 用户补充',
        '',
        '规则：',
        '- 每个字段如无内容，必须写「无」而非留空或省略；不得写「（暂无）」「暂无」等变体。',
        '- 事实认定和法律依据中的每条信息须带 [来源: 本节点] 标记（本节点对话记录中提炼；若内容来自上游节点成果块，则写 [来源: n_上游节点id#q-锚点]）。',
        '- 法律依据中的每条须可定位（含条款号/案例编号/法释编号），无法定位的标 [待核实]。',
        '- 结论中的每条须带确定性等级：[确定] / [倾向性] / [存疑]。',
        '- 待确认的每条须写明所需内容与责任方（如「需用户提供xxx」）。',
        '- 适用限制如无，写「无已知限制」。',
        '- 用户补充始终写「无」（仅用户可填写）。',
        '- 每条以 "- " 列表项格式书写。',
        '- 仅输出上述 8 节内容，不要输出其他解释、引言或总结。',
        ...(isUserEdited ? ['', '重要：当前成果块中的部分字段已被用户手动修正。你必须严格保留用户修正过的内容，不得覆盖或修改。只有用户未修正的字段（内容仅为「无」或空）才可以根据新增对话内容更新。'] : []),
      ].join('\n');

      const userPrompt = [
        '## 对话记录',
        '',
        conversationText,
        preservationNote,
        '',
        '请提炼成果块：',
      ].join('\n');

      // 5. 调用 LLM
      let rawText = '';
      try {
        const client = new OpenAI({
          apiKey: cfg.apiKey,
          baseURL: cfg.baseUrl,
          timeout: 60_000,
        });
        const resp = await client.chat.completions.create({
          model: cfg.model,
          messages: [
            { role: 'system', content: OUTCOME_EXTRACT_SYSTEM },
            { role: 'user', content: userPrompt },
          ],
          stream: false,
          temperature: 0.1,
          // 成果块提取输出 8 节长文，默认 4096 在长对话/思考模式下可能截断 → 按模型能力放大
          max_tokens: modelOutputTokenMaxForModel(cfg.model),
        });
        rawText = (resp.choices[0]?.message?.content || '').trim();
      } catch (e) {
        return NextResponse.json(
          { error: '成果块提取模型调用失败: ' + (e instanceof Error ? e.message : String(e)) },
          { status: 500 },
        );
      }

      if (!rawText) {
        return NextResponse.json({ error: '模型未返回内容' }, { status: 500 });
      }

      // 6. 解析 LLM 输出为 Outcome
      // 在输出前加 ## 成果块 标题以便 parseOutcome 解析
      const newOutcome = parseOutcome(rawText);
      if (!newOutcome) {
        return NextResponse.json({ error: '无法从模型输出中解析成果块' }, { status: 500 });
      }

      // 7. 写入 .md 文件
      const node = parseNodeMarkdown(content);
      // R-9: 已锁定节点不可重新提取覆盖成果块（须先解锁）
      if (node.frontmatter.outcome_status === 'locked') {
        return NextResponse.json({ error: 'R-9 已锁定节点不可重新提取成果块，请先解锁再提取' }, { status: 400 });
      }
      node.outcome = newOutcome;
      // AI 自动生成，不标记为 user_edited（用户手动编辑后才会覆盖此标记）
      node.frontmatter.outcome_user_edited = false;
      if (!node.frontmatter.outcome_status || node.frontmatter.outcome_status === 'legacy') {
        node.frontmatter.outcome_status = 'draft';
      }
      node.frontmatter.outcome_turns = node.conversations.length;
      node.frontmatter.updated_at = new Date().toISOString();
      await updateNodeFile(filePath, serializeNode(node));

      return NextResponse.json({ success: true, node_id });
    }

    if (action === 'delete') {
      const { node_id, attachmentFolders } = body;
      if (!node_id) {
        return NextResponse.json({ error: 'node_id is required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(node_id, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + node_id }, { status: 404 });
      }

      const db = await initDb(join(project.path, PROJECT_DB_FILENAME));
      // 删除主节点磁盘档案（.md + 附件目录 + 关联边）
      await removeNodeDiskArchive(node_id, project, db, attachmentFolders);

      return NextResponse.json({ success: true, node_id });
    }

    if (action === 'restore_trash') {
      // 从回收站恢复节点：把 .trash/nodes/ 中的备份写回 notes-memory/（writeNodeFile 自动处理重名），
      // 恢复成功后删除对应备份
      const { file } = body;
      if (typeof file !== 'string' || !file) {
        return NextResponse.json({ error: 'file is required' }, { status: 400 });
      }
      const trashDir = join(project.path, '.trash', 'nodes');
      const srcPath = join(trashDir, basename(file)); // basename 防路径穿越
      let content = '';
      try {
        content = await fs.readFile(srcPath, 'utf-8');
      } catch {
        return NextResponse.json({ error: '回收站备份不存在' }, { status: 404 });
      }
      const parsed = parseNodeMarkdown(content);
      const relativePath = await writeNodeFile(parsed.frontmatter.title, content, project.path);
      await fs.unlink(srcPath).catch(() => {});
      return NextResponse.json({ success: true, node_id: parsed.frontmatter.node_id, file_path: relativePath });
    }

    if (action === 'empty_trash') {
      // 一键清空回收站（破坏性操作，前端需二次确认）
      const trashDir = join(project.path, '.trash', 'nodes');
      // 联动清理：回收站内每个备份节点 md 已被永久销毁，同步清理其批注/修订 sidecar。
      // 备份文件名格式 {nodeId}-{时间戳}.md（restore_trash 亦按 basename 定位），
      // 从文件名提取 nodeId（= nodeMdId，节点自身文档的 sidecar key）。
      try {
        const entries = await fs.readdir(trashDir).catch(() => [] as string[]);
        const nodeIds = entries
          .filter((f) => f.endsWith('.md'))
          .map((f) => f.replace(/\.md$/, '').replace(/-\d{4}-\d{2}-\d{2}T[\d-]+$/, ''))
          .filter((id) => /^[0-9a-fA-F-]{20,}$/.test(id));
        if (nodeIds.length > 0) {
          await cleanupMdAnnotationSidecars({ nodeIds }).catch(() => {});
        }
      } catch { /* sidecar 清理失败不阻断清空 */ }
      await fs.rm(trashDir, { recursive: true, force: true });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Unknown action: ' + action }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    clearCurrentProjectPath();
    // 写时维护：manifest 同步（写操作重建索引，删除操作失效缓存）
    await syncManifestForAction(body, explicitProjectId).catch(() => {});
  }
}

/** 删除单个节点的磁盘档案：unlink .md + 清理附件目录 + 删除关联边。
 *  供删除节点与其历史产物目录清理共用。 */
async function removeNodeDiskArchive(
  nodeId: string,
  project: { id: string; path: string },
  db: Awaited<ReturnType<typeof initDb>>,
  extraAttachmentFolders?: unknown,
): Promise<void> {
  const filePath = await findNodeFileById(nodeId, project.path);
  if (!filePath) return;
  // 删除节点文件前，先读取内容以解析其中的附件路径
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    // 读取失败时忽略，继续删除
  }
  // === 回收站备份：删除前先把节点 .md 备份到项目 .trash/nodes/，防止误删节点
  // 导致对话记录永久丢失（画布删除有确认框但仍有误删风险），可手动找回恢复 ===
  if (content) {
    try {
      const trashDir = join(project.path, '.trash', 'nodes');
      await fs.mkdir(trashDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      await fs.writeFile(join(trashDir, `${nodeId}-${stamp}.md`), content, 'utf-8');
    } catch (e) {
      console.warn('[nodes:delete] 回收站备份失败（不影响删除）:', e instanceof Error ? e.message : String(e));
    }
  }
  await fs.unlink(filePath);

  // 同步删除该节点的附件目录（上传时目录名为 {node_id前4位}_{标题}，与 node_id 不一致，需从附件路径精确解析）
  // 解析失败不阻断清理：兜底 nodeId 与前端上报的目录仍会执行
  const folderNames = new Set<string>();
  try {
    const parsed = parseNodeMarkdown(content);
    for (const turn of parsed.conversations || []) {
      for (const att of turn.questionAttachments || []) {
        // path 形如 attachments/{folder}/{fileName}（兼容旧格式 assets/）
        const m = att.path?.match(/^(?:attachments|assets)\/([^/]+)\//);
        if (m) folderNames.add(m[1]);
      }
    }
  } catch {
    // 解析失败时忽略，仍保留兜底目录清理
  }
  // 兜底：无标题时目录名可能直接等于 node_id
  folderNames.add(nodeId);
  // 合并前端上报的附件目录（覆盖"附件未持久化到 md 即删除节点"的场景）
  if (Array.isArray(extraAttachmentFolders)) {
    for (const f of extraAttachmentFolders) {
      if (typeof f === 'string' && f) folderNames.add(f);
    }
  }
  const removedAttachmentDirs: string[] = [];
  for (const folder of folderNames) {
    try {
      const abs = join(project.path, 'attachments', folder);
      await fs.rm(abs, { recursive: true, force: true });
      removedAttachmentDirs.push(abs);
    } catch {
      // 单个目录删除失败时忽略
    }
  }
  // 联动清理：附件目录内的文档（曾被 DocEditor 打开批注的 md/docx）随节点删除一并清理
  if (removedAttachmentDirs.length > 0) {
    await cleanupMdAnnotationSidecars({ targets: removedAttachmentDirs.map((abs) => ({ abs, isDir: true })) }).catch(() => {});
  }

  // 同步删除数据库中关联的边
  try {
    await deleteEdgesByNode(db, project.id, nodeId);
  } catch (dbErr) {
    console.warn('删除节点关联边失败:', dbErr instanceof Error ? dbErr.message : String(dbErr));
  }

  // 同步清理该节点在 homework/ 下的全部产出文件，避免删除后文件流入新建节点
  try {
    await removeNodeHomeworkFiles(nodeId, project.path);
  } catch (hwErr) {
    console.warn('删除节点 homework 产出失败:', hwErr instanceof Error ? hwErr.message : String(hwErr));
  }
}

/** 删除节点在 homework/ 下的全部产出文件：
 *  homework/.ownership.json 归属清册中该 nodeId 的文件（删除文件并清空条目）。
 *  ImageGen 节点的图片产物由 ImageGenNode 自行经 /api/imagegen/delete 清理（平铺存 homework/ 根，
 *  无 per-node 目录），不在此处理。防误删：路径严格限定在 homework 根目录内（resolve 防穿越）。 */
async function removeNodeHomeworkFiles(nodeId: string, projectPath: string): Promise<void> {
  const homeworkRoot = resolve(join(projectPath, 'homework'));
  const guard = (p: string): string | null => {
    const resolved = resolve(p);
    return resolved === homeworkRoot || resolved.startsWith(homeworkRoot + sep) ? resolved : null;
  };

  // homework/.ownership.json 中归属该节点 id 的文件（删除文件 + 清空条目）
  const manifestPath = join(homeworkRoot, '.ownership.json');
  let manifest: Record<string, string> | null = null;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Record<string, string>;
  } catch { /* 缓存不存在或损坏，无需清理 */ }
  if (!manifest) return;
  let changed = false;
  const deletedAbs: string[] = [];
  for (const [rel, owner] of Object.entries(manifest)) {
    if (owner !== nodeId) continue;
    const abs = guard(join(homeworkRoot, rel));
    if (abs) {
      try {
        const st = await fs.stat(abs);
        if (st.isFile()) {
          await fs.unlink(abs);
          deletedAbs.push(abs);
        }
      } catch { /* 文件不存在，仅清条目 */ }
    }
    delete manifest[rel];
    changed = true;
  }
  // 联动清理：homework 产物永久删除 → 同步清理其批注/修订 sidecar（key 为绝对/相对路径形态）
  if (deletedAbs.length > 0) {
    await cleanupMdAnnotationSidecars({ targets: deletedAbs.map((abs) => ({ abs })) }).catch(() => {});
  }
  if (changed) {
    try {
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    } catch { /* 写回失败忽略，不阻塞主流程 */ }
  }
}

/** 写后同步 manifest（规格 v3 §五 写时维护）；explicitProjectId 传临时节点的 hidden 项目 id */
async function syncManifestForAction(body: Record<string, unknown>, explicitProjectId?: string): Promise<void> {
  const action = body.action as string | undefined;
  const nodeId = body.node_id as string | undefined;
  if (!nodeId || !action) return;
  try {
    const project = explicitProjectId
      ? await getProjectById(explicitProjectId)
      : await getCurrentProject();
    if (action === 'delete') {
      await invalidateManifest(nodeId, project.path);
    } else if (
      ['append', 'remove_round', 'update_summary', 'rename_title',
        'add_annotation', 'update_content',
        'update_outcome', 'summarize', 'lock', 'unlock'].includes(action)
    ) {
      await syncManifestAfterWrite(nodeId, project.path);
    }
  } catch {
    // manifest 同步失败不阻断主流程
  }
}

// ==================== GET: 读取节点 / 列出所有节点 ====================

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    // 设置当前项目上下文：查询参数显式传 project_id 时（如临时节点投影）优先用指定项目，否则走当前项目
    const explicitProjectId = searchParams.get('project_id');
    const project = explicitProjectId
      ? await getProjectById(explicitProjectId)
      : await getCurrentProject();
    setCurrentProjectPath(project.path);

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

    if (action === 'version') {
      if (!nodeId) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 });
      }
      const filePath = await findNodeFileById(nodeId, project.path);
      if (!filePath) {
        return NextResponse.json({ error: '节点文件不存在: ' + nodeId }, { status: 404 });
      }
      const version = await readVersionToken(filePath);
      return NextResponse.json({ success: true, version });
    }

    if (action === 'list_trash') {
      // 回收站列表：读取项目 .trash/nodes/*.md 备份（删除节点时自动写入）
      const trashDir = join(project.path, '.trash', 'nodes');
      let names: string[] = [];
      try {
        names = (await fs.readdir(trashDir)).filter((f) => f.endsWith('.md'));
      } catch {
        names = []; // 无回收站目录
      }
      const items = await Promise.all(
        names.map(async (f) => {
          try {
            const p = join(trashDir, f);
            const content = await fs.readFile(p, 'utf-8');
            const parsed = parseNodeMarkdown(content);
            const st = await fs.stat(p);
            return {
              file: f,
              node_id: parsed.frontmatter.node_id,
              title: parsed.frontmatter.title,
              deleted_at: st.mtime.toISOString(),
              size: st.size,
              turns: parsed.conversations.length,
            };
          } catch {
            return null;
          }
        }),
      );
      return NextResponse.json({
        success: true,
        items: items.filter((x): x is NonNullable<typeof x> => x !== null),
      });
    }

    if (action === 'list' || (!nodeId && !action)) {
      const nodesDir = join(project.path, 'notes-memory');
      try {
        const files = await fs.readdir(nodesDir);
        const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'example_node.md');
        const nodes = await Promise.all(
          mdFiles.map(async (file) => {
            try {
              const content = await fs.readFile(join(nodesDir, file), 'utf-8');
              const node = parseNodeMarkdown(content);
              // 归档功能移除（2026-09）：存量 archived:true 一次性惰性迁移——
              // serializeNode 已不再输出该字段，检测到即写回一次即可清除残留标记（幂等，前端不再读取）
              const rawFm = node.frontmatter as unknown as Record<string, unknown>;
              if (rawFm.archived === true) {
                try {
                  await updateNodeFile(join(nodesDir, file), serializeNode(node));
                } catch { /* 写回失败静默：前端已不再消费该标记，残留无影响 */ }
              }
              return {
                node_id: node.frontmatter.node_id,
                title: node.frontmatter.title,
                created_at: node.frontmatter.created_at,
                updated_at: node.frontmatter.updated_at,
                sources: node.frontmatter.sources,
                model: node.frontmatter.model,
                mood: undefined as never,
                tags: node.frontmatter.tags,
                outcome_status: node.frontmatter.outcome_status,
                position_x: node.frontmatter.position_x,
                position_y: node.frontmatter.position_y,
                sandbox_app_id: node.frontmatter.sandbox_app_id,
                node_type: node.frontmatter.node_type,
                annotation_node_ids: node.frontmatter.annotation_node_ids,
                annotation_text: node.frontmatter.annotation_text,
                starred: node.frontmatter.starred,
                md_anchor: node.frontmatter.md_anchor,
                summary: node.summary,
                conversations: node.conversations,
                annotations: node.annotations,
                enabledMcpIds: node.frontmatter.enabledMcpIds,
                selectedSkills: node.frontmatter.selectedSkills,
                // 压缩游标：已压缩轮次数（前端据此在请求时跳过已压缩的历史，真正减小上下文）
                compacted_until: node.frontmatter.memory_compacted_until,
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
        tags: node.frontmatter.tags,
        outcome_status: node.frontmatter.outcome_status,
        outcome_force_locked: node.frontmatter.outcome_force_locked,
        sandbox_app_id: node.frontmatter.sandbox_app_id,
        summary: node.summary,
        conversations: node.conversations,
        annotations: node.annotations,
        compacted_until: node.frontmatter.memory_compacted_until,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    clearCurrentProjectPath();
  }
}