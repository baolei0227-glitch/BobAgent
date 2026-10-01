/**
 * 审核报告 → docx 修订 ops 解析接口（编辑器内 @审核报告 驱动修订）
 *
 * POST /api/docx/audit-revise
 * body: { docText, reportText, trackChanges?, modelId?, apiKey?, baseUrl?, providerModelId? }
 *   - docText: 当前 docx 的纯文本/mammoth md（供 AI 定位 anchor）
 *   - reportText: 审核报告全文（含修改建议）
 *   - trackChanges: 是否生成带修订标记的 ops 类型（true→replace_text 等；false→*_plain）
 * 响应: { ok, ops, error? }
 *   - ops: [{ type, locate: {anchor, old?}, new, label }]，与 DocxTiptapEditor PlanFile.ops 对齐
 *
 * 前端拿到 ops 后构造 PlanFile 调 runPlan 逐条应用（复用现有 /api/docx/revise 通道）。
 */
import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getCurrentProject } from '@/lib/project/project-manager';
import { readSettingsFromFile } from '@/lib/settings-server';
import { getProviderPreset, parseCustomModel, isCustomModel, type ProviderConfig } from '@/lib/types';

export const runtime = 'nodejs';

/** 递归收集 .md/.txt（深度≤3，跳过隐藏目录如 .ai-workspace），name 为 homework 相对路径 */
async function walkReports(dir: string, rel: string, depth: number, out: Array<{ name: string; path: string; mtime: number }>): Promise<void> {
  if (depth > 3) return;
  let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await walkReports(join(dir, e.name), childRel, depth + 1, out);
      continue;
    }
    if (!e.isFile() || !/\.(md|txt)$/i.test(e.name)) continue;
    try {
      const st = await fs.stat(join(dir, e.name));
      out.push({ name: childRel, path: join(dir, e.name), mtime: st.mtimeMs });
    } catch { /* ignore */ }
  }
}

/** 列当前项目 homework/ 下的审核报告（含节点子目录），按修改时间倒序 */
async function listReports(): Promise<{ dir: string; reports: Array<{ name: string; path: string; mtime: number }> }> {
  try {
    const project = await getCurrentProject().catch(() => null);
    const dir = project?.path ? join(project.path, 'homework') : join(homedir(), 'BobWork', 'homework');
    const reports: Array<{ name: string; path: string; mtime: number }> = [];
    await walkReports(dir, '', 1, reports);
    reports.sort((a, b) => b.mtime - a.mtime);
    return { dir, reports };
  } catch {
    return { dir: '', reports: [] };
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get('action') === 'reports') {
    const { dir, reports } = await listReports();
    return NextResponse.json({ ok: true, dir, reports });
  }
  return NextResponse.json({ ok: false, error: 'unsupported action' }, { status: 400 });
}

interface AuditReviseRequest {
  docText?: string;
  reportText?: string;
  trackChanges?: boolean;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  providerModelId?: string;
}

/** 解析模型配置：优先请求自定义，其次 modelId，兜底 chatModel.defaultModel / 首个可用 provider */
async function resolveModelConfig(req: Partial<AuditReviseRequest>) {
  if (req.apiKey && req.baseUrl && req.providerModelId) {
    return { apiKey: req.apiKey, baseUrl: req.baseUrl, model: req.providerModelId };
  }
  const settings = await readSettingsFromFile();
  const providers: ProviderConfig[] = settings.providers || [];
  const chatDefaultPool = settings.chatModel?.pool ?? [];
  const chatDefaultModel = settings.chatModel?.defaultModel;
  const firstProvider = providers.find((p) => p.apiKey && p.selectedModels?.length);
  const resolveByRef = (ref: string) => {
    if (isCustomModel(ref)) {
      const parsed = parseCustomModel(ref);
      if (!parsed) return null;
      const p = providers.find((c) => c.type === parsed.provider && c.apiKey);
      if (!p) return null;
      const preset = getProviderPreset(p.type);
      return { apiKey: p.apiKey, baseUrl: p.baseUrl || preset?.baseUrl || '', model: parsed.modelId };
    }
    const poolMatch = chatDefaultPool.find((c) => c.modelId === ref);
    if (poolMatch) {
      const p = providers.find((c) => c.type === poolMatch.provider && c.apiKey);
      if (p) {
        const preset = getProviderPreset(p.type);
        return { apiKey: p.apiKey, baseUrl: p.baseUrl || preset?.baseUrl || '', model: poolMatch.modelId };
      }
    }
    if (firstProvider?.apiKey) {
      const preset = getProviderPreset(firstProvider.type);
      return { apiKey: firstProvider.apiKey, baseUrl: firstProvider.baseUrl || preset?.baseUrl || '', model: firstProvider.selectedModels?.[0]?.modelId || ref };
    }
    return null;
  };
  if (req.modelId) {
    const r = resolveByRef(req.modelId);
    if (r) return r;
  }
  if (chatDefaultModel) {
    const r = resolveByRef(chatDefaultModel);
    if (r) return r;
  }
  if (chatDefaultPool.length) {
    const p = providers.find((c) => c.type === chatDefaultPool[0].provider && c.apiKey);
    if (p) {
      const preset = getProviderPreset(p.type);
      return { apiKey: p.apiKey, baseUrl: p.baseUrl || preset?.baseUrl || '', model: chatDefaultPool[0].modelId };
    }
  }
  if (firstProvider?.apiKey) {
    const preset = getProviderPreset(firstProvider.type);
    return { apiKey: firstProvider.apiKey, baseUrl: firstProvider.baseUrl || preset?.baseUrl || '', model: firstProvider.selectedModels?.[0]?.modelId || '' };
  }
  return null;
}

function buildMessages(docText: string, reportText: string, trackChanges: boolean) {
  const docCtx = docText.length > 8000 ? docText.slice(0, 4000) + '\n<!-- ... 截断 ... -->\n' + docText.slice(-4000) : docText;
  const reportCtx = reportText.length > 12000 ? reportText.slice(0, 6000) + '\n<!-- ... 截断 ... -->\n' + reportText.slice(-6000) : reportText;
  const plainNote = trackChanges
    ? 'type 取：replace_text（段内局部替换）/ replace_paragraph（整段替换）/ insert_paragraph_after（锚段后新增段）/ replace_table_cell（表格单元格）'
    : 'type 取：replace_text_plain / replace_paragraph_plain / insert_paragraph_after_plain / replace_table_cell_plain（直接改原文，无修订标记）';
  return [
    {
      role: 'system' as const,
      content: `你是合同/文书修订专家。根据【审核报告】中的修改建议，对【文档内容】生成结构化修订操作 ops。

❗️输出格式铁律（违反即失败）：
1. 只输出一个 JSON 对象：{"ops": [...]}，绝对禁止输出解释、思考过程、markdown 围栏
2. ${plainNote}
3. 每项 op 结构：
   - type: 上述类型之一
   - locate: { "anchor": "所在段落包含的文本（用于定位段落，须与文档逐字一致）" }
     - replace_text 还需 "old": "将被替换的确切文本（段内子串，须与文档逐字一致）"
     - replace_paragraph / insert_paragraph_after 只需 anchor
     - replace_table_cell 需 "table": 表索引, "row": 行索引, "cell": 列索引
   - "new": "替换/新增后的新文本"（纯删除留空字符串 ""）
   - "label": "简短说明（如'价格条款明确范围'）"
4. anchor/old 必须从【文档内容】中逐字摘取，不得改写或臆造；否则定位会失败
5. 只生成报告明确建议的修改，不臆造未提及的修改；如报告某条建议无法定位，跳过该条
6. 顺序按报告建议出现顺序`,
    },
    {
      role: 'user' as const,
      content: `【文档内容】
${docCtx}

【审核报告】
${reportCtx}

请生成 ops JSON。`,
    },
  ];
}

const VALID_TYPES = new Set([
  'replace_text', 'replace_paragraph', 'insert_paragraph_after', 'replace_table_cell',
  'replace_text_plain', 'replace_paragraph_plain', 'insert_paragraph_after_plain', 'replace_table_cell_plain',
]);

/** 校验 + 清洗 AI 输出的 ops */
function cleanOps(raw: unknown): { ops: Array<Record<string, unknown>>; errors: string[] } {
  const errors: string[] = [];
  const arr = Array.isArray(raw) ? raw : (raw as { ops?: unknown })?.ops;
  if (!Array.isArray(arr)) return { ops: [], errors: ['AI 输出非数组'] };
  const cleaned: Array<Record<string, unknown>> = [];
  for (let i = 0; i < arr.length; i++) {
    const o = (arr[i] ?? {}) as Record<string, unknown>;
    const type = String(o.type ?? '');
    if (!VALID_TYPES.has(type)) { errors.push(`#${i + 1} 非法 type "${type || '(空)'}"`); continue; }
    if (type !== 'replace_table_cell' && type !== 'replace_table_cell_plain') {
      const locate = (o.locate ?? {}) as Record<string, unknown>;
      if (!locate.anchor) { errors.push(`#${i + 1} 缺 anchor`); continue; }
    }
    if (typeof o.new !== 'string') { errors.push(`#${i + 1} new 非字符串`); continue; }
    cleaned.push({ type, locate: o.locate ?? {}, new: o.new, label: String(o.label ?? type) });
  }
  return { ops: cleaned, errors };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as AuditReviseRequest;
    const { docText = '', reportText = '', trackChanges = true } = body;
    if (!docText.trim()) return NextResponse.json({ ok: false, error: 'docText is required' }, { status: 400 });
    if (!reportText.trim()) return NextResponse.json({ ok: false, error: 'reportText is required' }, { status: 400 });

    const config = await resolveModelConfig(body);
    if (!config) return NextResponse.json({ ok: false, error: '未配置可用模型，请先在设置中配置 API Key' }, { status: 500 });

    const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
    const messages = buildMessages(docText, reportText, trackChanges);

    // JSON mode 优先（支持的模型走结构化输出，更可靠）
    const useJsonMode = /gpt-4|gpt-5|glm|doubao|deepseek|qwen|claude/i.test(config.model);
    const resp = await client.chat.completions.create({
      model: config.model,
      messages,
      temperature: 0.2,
      max_tokens: 4096,
      ...(useJsonMode ? { response_format: { type: 'json_object' } as const } : {}),
    });

    const content = resp.choices?.[0]?.message?.content || '';
    // 兼容裸 JSON 数组 / {"ops":[...]} / 带围栏
    let parsed: unknown;
    const cleaned = content.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // 尝试从文本中抽取首个 JSON 对象/数组
      const m = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (!m) return NextResponse.json({ ok: false, error: 'AI 输出非 JSON' }, { status: 500 });
      try { parsed = JSON.parse(m[0]); } catch { return NextResponse.json({ ok: false, error: 'AI 输出 JSON 解析失败' }, { status: 500 }); }
    }

    const { ops, errors } = cleanOps(parsed);
    if (ops.length === 0) return NextResponse.json({ ok: false, error: `无有效 ops。${errors.join('；')}` }, { status: 500 });

    return NextResponse.json({ ok: true, ops, errors, model: config.model });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
