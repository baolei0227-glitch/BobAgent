/**
 * src/lib/nodes/note-ingest-generate.ts
 * 研究结论回流（模型调用）：把「研究型轮次」的结论沉淀成个人知识库（bob-notes）条目。
 *
 * 为什么只收研究型轮次：研究得出的结论有复用价值（可迁移的判断标准 / 事实 / 方法 / 限制），
 * 闲聊与项目一次性细节没有。判据看**落盘的 toolCalls**（联网检索取页、项目材料检索取件），
 * 不靠对话文本猜 —— 压缩（R-14-C）会把命中详情折掉，工具留痕不会。
 *
 * 落库走 bob-notes 的 notes_backfill（不投 raw、不再编译：结论已是成品），
 * 去重三重：① 游标 note_ingest_turns（无新轮次不调模型）② merge_into / 标题精确归并
 * ③ 无研究轮直接返回（零模型调用、零写盘）。
 *
 * 库归属：只落个人库（研究结论是「知识」）。项目事实仍走账本编译那条线，互不重复。
 */

import { promises as fs } from 'fs';
import OpenAI from 'openai';
import { parseNodeMarkdown, serializeNode, updateNodeFile, type ConversationTurn } from '@/lib/node-markdown';
import { resolveOutcomeModel } from '@/lib/core/task-model';
import { collectMaterialSourceWhitelist } from '@/lib/nodes/outcome-generate';
import type { NoteTypeDef } from '@/lib/mcp/notes-types';

/** 「研究型轮次」判据：本轮调用过联网检索/取页 或 项目材料检索/取件 */
const RESEARCH_TOOLS = new Set(['web_search', 'web_fetch', 'search_materials', 'read_attachment']);

/** 注入提示词的单轮回答截断（研究结论多在前半段；防超长回答撑爆 prompt） */
const ANSWER_CAP = 4000;
/** 一次回流最多消化的研究轮数（取最近的；老节点首次触发不把全部历史塞进 prompt） */
const BATCH_MAX_TURNS = 10;
/** 一次回流最多产出条目数（防一条问答被拆成一堆碎片笔记） */
const ENTRIES_MAX = 3;
const MATERIAL_WHITELIST_MAX = 40;
const WEB_WHITELIST_MAX = 30;
const TITLE_LIST_MAX = 80;

const URL_RE = /https?:\/\/[^\s)"'<>\]，、]+/g;

/** 该轮是否做过研究：联网工具 / 材料工具留痕，或本轮 @引用 带项目材料路径 */
function isResearchTurn(turn: ConversationTurn): boolean {
  for (const tc of turn.toolCalls ?? []) {
    if (tc.success === false) continue;
    if (RESEARCH_TOOLS.has(tc.toolName)) return true;
  }
  return (turn.questionReferences ?? []).some((r) => !!r.path && r.path.startsWith('materials/'));
}

/** 联网来源白名单：web_fetch 的 url + web_search 结果里出现的 url（防模型编造链接） */
function collectWebSources(turns: ConversationTurn[]): string[] {
  const out = new Set<string>();
  for (const turn of turns) {
    for (const tc of turn.toolCalls ?? []) {
      if (tc.success === false) continue;
      if (tc.toolName === 'web_fetch') {
        const u = tc.arguments?.url;
        if (typeof u === 'string' && /^https?:\/\//.test(u)) out.add(u);
      }
      if (tc.toolName === 'web_search') {
        const result = typeof tc.result === 'string' ? tc.result : '';
        for (const m of result.matchAll(URL_RE)) out.add(m[0]);
      }
    }
  }
  return [...out];
}

/** 从模型文本里稳妥提取 JSON 对象 */
function extractJson<T>(text: string): T {
  let cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
  return JSON.parse(cleaned) as T;
}

const NOTE_EXTRACT_SYSTEM = `你是个人知识库编辑。用户刚完成一轮「研究型」问答（联网检索 / 项目材料检索），
请把其中**可复用的结论**沉淀成知识库条目 —— 不是复述对话过程。

规则：
- 只写有复用价值的结论：可迁移的判断标准、方法、事实性结论、口径与限制、踩过的坑。
  纯项目一次性细节、过程叙述、闲聊、寒暄一律不写。
- 一条问答可产出 0~3 条条目；没有可复用结论时返回空 entries 数组（宁缺勿滥）。
- 正文以 \`## 摘要\` 开头（2~3 句概括），再写 \`## 要点\`（- 列表，3~8 条）与 \`## 详情\`（结构化 markdown）。
- 事实性结论必须带来源标记，三种之一：
  \`[来源: 材料:materials/相对路径#p页码]\`（项目材料原文，只能从下方「材料来源白名单」原样照抄）；
  \`[来源: 网络:URL]\`（联网检索，URL 只能从下方「联网来源白名单」原样照抄）；
  \`[来源: 本节点]\`（本轮推导所得）。
  白名单外的路径、页码、链接一律不得出现，禁止编造。
- 提到已有笔记或概念时写行内双链 [[名称]]（已有的用其标题；新概念写概念名即可）。
- type 只能取下方「可用页面类型」清单里的 key（清单来自笔记库 SCHEMA.md「页面类型」段）；研究结论一般用 synthesis。
- 标签 tags 0~5 个短词（2~6 字，反映主题）。
- merge_into：若这条结论与某篇【既有笔记】同主题（标题不同也算），填那篇既有笔记的标题
  （必须精确来自下方既有笔记标题列表），让服务端归并更新而非新建；不确定时省略该字段。

输出严格 JSON（不要 markdown 代码块，只返回纯 JSON）：
{"entries":[{"title":"标题","type":"synthesis","tags":["主题词"],"links":["相关概念"],"merge_into":"既有笔记标题(可选)","content":"## 摘要\\n...\\n\\n## 要点\\n- ...\\n\\n## 详情\\n..."}]}

## 可用页面类型（type 只能取这里的 key）
__NOTE_TYPES__`;

/** 内置 6 类兜底（插件 notes_types 不可用时静默降级，与插件 BUILTIN_NOTE_TYPES 一致） */
const BUILTIN_NOTE_TYPES: NoteTypeDef[] = [
  { key: 'concept', label: '概念/主题' },
  { key: 'entity', label: '实体（人/组织/产品/机构）' },
  { key: 'source', label: '来源/资料' },
  { key: 'note', label: '想法随笔' },
  { key: 'synthesis', label: '跨素材的综合与问答结论' },
  { key: 'todo', label: '待办' },
];

/** 把类型清单渲染为提示词片段（每行 `- key：label`，有正文模板的附上骨架） */
function renderTypeLines(defs: NoteTypeDef[]): string {
  return defs
    .map((d) => `- ${d.key}：${d.label}${d.template ? `（正文骨架：${d.template.replace(/\n/g, '\\n')}）` : ''}`)
    .join('\n');
}

/** 生成注入类型清单后的 system 提示词 */
function buildNoteExtractSystem(defs: NoteTypeDef[]): string {
  return NOTE_EXTRACT_SYSTEM.replace('__NOTE_TYPES__', renderTypeLines(defs));
}

/**
 * 把节点里未回流的研究型轮次沉淀为笔记条目。
 * 无研究轮次时直接返回（不调模型、不写盘）；模型或解析失败时不推进游标（下次静默窗重试）。
 */
export async function generateNotesFromResearch(filePath: string): Promise<{ ok: boolean; created?: number; error?: string }> {
  try {
    const node = parseNodeMarkdown(await fs.readFile(filePath, 'utf-8'));
    const covered = node.frontmatter.note_ingest_turns ?? 0;
    if (node.conversations.length <= covered) return { ok: true, created: 0 };

    const researched = node.conversations.slice(covered).filter(isResearchTurn);
    // 没有研究轮次 → 零模型调用、零写盘（游标也不动：非研究轮不产生任何副作用）
    if (researched.length === 0) return { ok: true, created: 0 };
    const batch = researched.slice(-BATCH_MAX_TURNS);

    // 预检（廉价 MCP 调用，0 token）：笔记库是否可用 + 取既有标题（供模型判 merge_into 归并）
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const idx = await callNotes('query', { mode: 'index' });
    if (!idx.ok) {
      console.warn(`[note-ingest] 笔记库不可用，本轮跳过（游标不推进，下次静默窗再试）: ${idx.error}`);
      return { ok: false, error: idx.error };
    }
    const titles = ((idx.data?.entries as Array<Record<string, unknown>> | undefined) ?? [])
      .map((e) => String(e.title ?? '').trim())
      .filter(Boolean)
      .slice(0, TITLE_LIST_MAX);

    // 页面类型清单（SCHEMA.md「页面类型」段）：注入提示词 + 校验回填 type。
    // 取不到（插件不支持/调用失败）时静默降级为内置 6 类，不阻断回流。
    const typesRes = await callNotes('types', {});
    const fetchedTypes = typesRes.ok && Array.isArray(typesRes.data?.types)
      ? (typesRes.data.types as NoteTypeDef[]).filter((d) => d && typeof d.key === 'string' && d.key)
      : [];
    const noteTypes = fetchedTypes.length > 0 ? fetchedTypes : BUILTIN_NOTE_TYPES;
    const typeKeys = new Set(noteTypes.map((d) => d.key));
    const fallbackType = typeKeys.has('synthesis') ? 'synthesis' : (noteTypes[0]?.key ?? 'synthesis');

    const cfg = await resolveOutcomeModel();
    if (!cfg) return { ok: false, error: '未配置模型，无法回流研究结论' };

    const materialSources = collectMaterialSourceWhitelist(batch).slice(0, MATERIAL_WHITELIST_MAX);
    const webSources = collectWebSources(batch).slice(0, WEB_WHITELIST_MAX);

    const turnBlocks = batch.map((t, i) => {
      const parts: string[] = [`### 第 ${i + 1} 轮`];
      const refs = (t.questionReferences ?? [])
        .filter((r) => r.path && r.path.startsWith('materials/'))
        .map((r) => r.path as string);
      if (refs.length > 0) parts.push(`(本轮引用材料: ${refs.join(', ')})`);
      parts.push(`用户: ${t.question}`);
      const answer = t.answer.length > ANSWER_CAP ? `${t.answer.slice(0, ANSWER_CAP)}\n…（截断）` : t.answer;
      parts.push(`AI: ${answer}`);
      return parts.join('\n');
    });

    const whitelistNote = [
      '## 材料来源白名单（写 [来源: 材料:…] 必须原样照抄，清单外一律不得出现）',
      ...(materialSources.length > 0 ? materialSources.map((s) => `- ${s}`) : ['（本轮未命中项目材料）']),
      '',
      '## 联网来源白名单（写 [来源: 网络:URL] 必须原样照抄，清单外一律不得出现）',
      ...(webSources.length > 0 ? webSources.map((s) => `- ${s}`) : ['（本轮无联网来源）']),
    ].join('\n');

    const userPrompt = [
      '## 既有笔记标题（供 merge_into 归并判断）',
      titles.length > 0 ? titles.map((t) => `- ${t}`).join('\n') : '（暂无既有笔记）',
      '',
      whitelistNote,
      '',
      '## 研究轮次',
      '',
      turnBlocks.join('\n\n'),
      '',
      '请只返回 JSON，不要加任何其他文字。',
    ].join('\n');

    const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, timeout: 90_000 });
    const resp = await client.chat.completions.create({
      model: cfg.model,
      messages: [
        { role: 'system', content: buildNoteExtractSystem(noteTypes) },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      temperature: 0.3,
    });
    const rawText = (resp.choices[0]?.message?.content || '').trim();
    if (!rawText) return { ok: false, error: '模型未返回内容' };

    let parsed: { entries?: Array<Record<string, unknown>> };
    try {
      parsed = extractJson<{ entries?: Array<Record<string, unknown>> }>(rawText);
    } catch {
      return { ok: false, error: '模型返回的不是合法 JSON' };
    }

    const modelEntries = (Array.isArray(parsed.entries) ? parsed.entries : []).slice(0, ENTRIES_MAX);
    let created = 0;
    for (const it of modelEntries) {
      const title = String(it?.title ?? '').trim();
      const content = String(it?.content ?? '').trim();
      if (!title && !content) continue;
      // type 校验：只认 SCHEMA.md 定义的 key；非法/缺失 → 回退 synthesis（registry 无 synthesis 时用第一个）
      const rawType = String(it?.type ?? '').trim();
      const type = typeKeys.has(rawType) ? rawType : fallbackType;
      const tags = Array.isArray(it?.tags)
        ? [...new Set((it.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean))].slice(0, 5)
        : [];
      const links = Array.isArray(it?.links)
        ? [...new Set((it.links as unknown[]).map((l) => String(l).trim()).filter(Boolean))]
        : [];
      const mergeInto = String(it?.merge_into ?? '').trim();
      const r = await callNotes('backfill', {
        title,
        content,
        tags,
        links,
        type,
        ...(mergeInto ? { merge_into: mergeInto } : {}),
      });
      if (r.ok) created += 1;
      else console.warn(`[note-ingest] 回填失败「${title}」: ${r.error}`);
    }

    // 游标推进到本轮读到的轮次数：个别回填失败也不重试 —— 研究回流是最佳努力，
    // 重试会把同一批轮次反复喂给模型，代价远大于偶发少一条背景笔记。
    // （模型/JSON 失败上面已提前返回，不推进 → 下次静默窗自动重试。）
    await advanceCursor(filePath, node.conversations.length);
    return { ok: true, created };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 推进回流游标。记账字段与节点内容无关 → 不动 updated_at，避免误触发「文件已改」信号。 */
async function advanceCursor(filePath: string, turns: number): Promise<void> {
  const latest = parseNodeMarkdown(await fs.readFile(filePath, 'utf-8'));
  if ((latest.frontmatter.note_ingest_turns ?? 0) >= turns) return;
  latest.frontmatter.note_ingest_turns = turns;
  await updateNodeFile(filePath, serializeNode(latest));
}