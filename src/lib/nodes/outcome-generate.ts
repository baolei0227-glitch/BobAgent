/**
 * src/lib/nodes/outcome-generate.ts
 * 成果块提炼（模型调用）：从节点对话记录提炼 8 字段成果块并写回 .md。
 *
 * 从 api/nodes/route.ts 抽出，供两处复用：
 *  - 锁定节点（R-1 要求锁定前必须有成果块）；
 *  - 对话落盘后自动生成（见 ./outcome-auto.ts）。
 *
 * 保护语义（不变）：
 *  - R-9 已锁定节点不重写（保护签字）；
 *  - 用户手动修正过的非空字段一律保留（outcome_user_edited）；
 *  - 写回时推进 outcome_turns 覆盖到当前对话轮次。
 */

import { promises as fs } from 'fs';
import { parseNodeMarkdown, serializeNode, updateNodeFile, outcomeContentHash, type ConversationTurn } from '@/lib/node-markdown';
import { parseOutcome, renderOutcome, OUTCOME_FIELD_DEFS, type Outcome } from '@/lib/nodes/outcome';
import { resolveOutcomeModel } from '@/lib/core/task-model';
import OpenAI from 'openai';

/** 材料来源的规范写法：`[来源: 材料:materials/相对路径#p页码]`（页码可省） */
const MATERIAL_SOURCE_RE = /\[来源:\s*材料:(materials\/[^\s\]#]+)(#p\d+)?\]/g;
/** 账本条目渲染的出处行（` — 出处：materials/…`） */
const LEDGER_SOURCE_RE = /出处：(materials\/[^\s，、)\]]+)/g;

/** 白名单最多注入多少条（超出截断并注明总数，避免把提炼 prompt 撑爆） */
const WHITELIST_MAX = 40;

/**
 * per-turn 材料来源白名单：从**已落盘的 toolCalls**（node .md 的 RMETA，持久化在文件里）
 * 收集本轮工具真实命中的材料来源，产出可直接照抄的 `[来源: 材料:…]` 串。
 *
 * 为什么不靠对话文本兜底：R-14-C 压缩会把命中详情那段对话折掉，模型"记得住路径却查不到出处"；
 * 工具调用留痕是落盘的，白名单不依赖对话幸存，也不给编造留空间。
 * 三个来源：search_materials 命中的来源串、read_attachment 成功读到的路径、read_ledger 条目出处。
 */
export function collectMaterialSourceWhitelist(conversations: ConversationTurn[]): string[] {
  const out = new Set<string>();
  const add = (path: string, page?: string) => out.add(`[来源: 材料:${path}${page ?? ''}]`);
  for (const turn of conversations) {
    for (const tc of turn.toolCalls ?? []) {
      if (tc.toolName === 'read_attachment' && tc.success) {
        const p = tc.arguments?.path;
        if (typeof p === 'string' && p.startsWith('materials/')) add(p);
      }
      const result = typeof tc.result === 'string' ? tc.result : '';
      if (!result) continue;
      for (const m of result.matchAll(MATERIAL_SOURCE_RE)) add(m[1], m[2]);
      if (tc.toolName === 'read_ledger') {
        for (const m of result.matchAll(LEDGER_SOURCE_RE)) add(m[1]);
      }
    }
  }
  return [...out];
}

/** 判定成果块是否仍为空模板（8 字段全为空值标记「无」/「无已知限制」/空串），用于决定是否需要生成 */
export function isOutcomeBlank(outcome: Outcome | null | undefined): boolean {
  if (!outcome) return true;
  const record = outcome as unknown as Record<string, string>;
  return OUTCOME_FIELD_DEFS.every((def) => {
    const val = (record[def.key] ?? '').trim();
    return val === '' || val === '无' || val === '无已知限制';
  });
}

/**
 * 提炼成果块并写回文件。
 * - 未配置模型 / 无对话 / 模型返回空 / 解析失败 → 返回 { ok:false, error }，调用方自行决定是否阻塞。
 * - 写回时推进 outcome_turns 覆盖全部对话轮次，供后续校验「是否已覆盖最新轮次」。
 */
export async function generateOutcomeForNode(filePath: string): Promise<{ ok: boolean; outcome?: Outcome | null; error?: string }> {
  try {
    const cfg = await resolveOutcomeModel();
    if (!cfg) return { ok: false, error: '未配置模型，无法生成成果块' };

    const latestContent = await fs.readFile(filePath, 'utf-8');
    const latestParsed = parseNodeMarkdown(latestContent);
    if (latestParsed.conversations.length === 0) return { ok: false, error: '节点无对话记录，无法生成成果块' };
    // R-9: 已锁定节点不重写成果块（保护签字；继续对话须先解锁）
    if (latestParsed.frontmatter.outcome_status === 'locked') {
      // P0-2：签字后盘上内容是否被外部改写（注入侧会据此降级为警告，这里留一条 warn 便于追溯）
      const stamped = latestParsed.frontmatter.outcome_content_hash;
      if (stamped && stamped !== outcomeContentHash(latestParsed.outcome)) {
        console.warn(`[outcome-generate] 已锁定节点内容哈希与签署留痕不一致 file=${filePath} stamped=${stamped}`);
      }
      return { ok: true, outcome: latestParsed.outcome ?? null };
    }

    const conversationText = latestParsed.conversations
      .map((t, i) => {
        const parts: string[] = [];
        parts.push(`### 第 ${i + 1} 轮`);
        parts.push(`用户: ${t.question}`);
        if (t.questionAttachments && t.questionAttachments.length > 0) {
          parts.push(`(附件: ${t.questionAttachments.map(a => a.name).join(', ')})`);
        }
        // 本轮引用的项目材料路径（成果块要写 `[来源: 材料:…]` 时须有真实路径，防模型编造）
        const materialRefs = (t.questionReferences ?? [])
          .filter((r) => r.path && r.path.startsWith('materials/'))
          .map((r) => r.path as string);
        if (materialRefs.length > 0) parts.push(`(本轮引用材料: ${materialRefs.join(', ')})`);
        parts.push(`AI: ${t.answer}`);
        return parts.join('\n');
      })
      .join('\n\n');

    // 「三」per-turn 材料来源白名单：只传本轮工具真实命中的来源，成果块的 [来源: 材料:…] 只能从里面抄
    const sourceWhitelist = collectMaterialSourceWhitelist(latestParsed.conversations);
    const whitelistNote = sourceWhitelist.length > 0
      ? [
          '',
          '## 本轮工具真实命中的材料来源（白名单）',
          '写 [来源: 材料:…] 必须从下面这份清单里**原样照抄**（页码已含在条目里）；清单外的材料路径一律不得出现：',
          ...sourceWhitelist.slice(0, WHITELIST_MAX).map((s) => `- ${s}`),
          ...(sourceWhitelist.length > WHITELIST_MAX ? [`（共 ${sourceWhitelist.length} 条，此处仅列前 ${WHITELIST_MAX} 条）`] : []),
        ].join('\n')
      : '';

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
      '- 事实认定和法律依据中的每条信息必须带来源标记，三种之一：本节点对话提炼 → [来源: 本节点]；引用上游节点成果块 → [来源: n_上游节点id#q-锚点]；依据项目材料原文（材料索引命中或 read_attachment 读到） → [来源: 材料:materials/相对路径#p页码]。',
      ...(sourceWhitelist.length > 0
        ? ['- 材料出处只能从「本轮工具真实命中的材料来源（白名单）」里原样照抄；白名单里没有的材料，该条改标 [来源: 本节点] 或不带来源，禁止另造路径与页码。']
        : ['- 材料出处只能用「本轮引用材料」列出的路径或对话中出现过的真实路径，页码用检索命中的真实页码；没有页码时省略 #p页码，直接写 [来源: 材料:materials/相对路径]。禁止编造路径与页码。']),
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
      whitelistNote,
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

    const parsedOutcome = parseOutcome(rawText);
    if (!parsedOutcome) return { ok: false, error: '成果块解析失败' };

    // R-3 补强：材料来源页码必须落在该文件索引的可寻址页集合内，不命中降级为「#p页码待核实」
    const { checkOutcomeSourcePages } = await import('@/lib/nodes/outcome-source-check');
    const { outcome: newOutcome, degraded } = await checkOutcomeSourcePages(parsedOutcome, await currentProjectPath());
    if (degraded > 0) {
      console.warn(`[outcome] R-3 页码校验：${degraded} 处材料来源页码不在索引命中页内，已降级为「页码待核实」`);
    }

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
    // 成果块已按最新对话重写 → 失效原因随之作废（仍为 stale 时保留：还等着复核）
    if (node.frontmatter.outcome_status !== 'stale') delete node.frontmatter.outcome_stale_reason;
    // 记录成果块已覆盖的对话轮次：锁定前据此判断是否有未提炼的新对话（防竞态锁旧成果块）
    node.frontmatter.outcome_turns = node.conversations.length;
    node.frontmatter.updated_at = new Date().toISOString();
    await updateNodeFile(filePath, serializeNode(node));
    return { ok: true, outcome: newOutcome };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 当前项目根（R-3 页码校验要读项目内容索引）；无激活项目 → undefined（跳过校验） */
async function currentProjectPath(): Promise<string | undefined> {
  try {
    const { getCurrentProject } = await import('@/lib/project/project-manager');
    return (await getCurrentProject()).path;
  } catch {
    return undefined;
  }
}