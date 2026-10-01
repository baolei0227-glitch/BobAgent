/**
 * 项目日报摘要（Daily Project Digest）——「昨日各项目做了什么」，作为日报组里的 Progress 页签。
 *
 * 数据源与「项目流水账」完全同源（lib/project/activity.ts，只读派生，不做任何埋点）：
 * 取**昨天**（本地时区 00:00–24:00）各活跃项目的任务执行 / 文档 / 附件 / 生命周期条目。
 *
 * 归纳复用「任务模型」（lib/core/task-model.ts 的 resolveTaskModel，与 /todo 解析同一路模型）：
 * 输出「📋 昨日小结（含日期）→ blockquote 一段话 → `---` → 各项目 📁 标题 + emoji 要点」，
 * 其中**分区标题由代码拼装**（见 summaryHeading），模型只写小结正文与项目明细。
 * 模型不可用 / 超时 / 无有效输出 → **结构化兜底**（计数式小结 + 按类型计数 + 代表性条目），
 * 保证这段要么有实质内容、要么整体缺席，绝不留半截空壳。
 *
 * 只列**当天确有活动**的项目；全部项目都无活动时返回空串（调用方据此跳过这一份报告）。
 */
import { listProjects } from '@/lib/project/project-manager';
import { collectProjectActivity, type ActivityItem, type ActivityKind } from '@/lib/project/activity';
import { resolveTaskModel, type ResolvedModel } from '@/lib/core/task-model';

/** 一天内单项目参与归纳的条目上限（防止附件/文档高频变动把 prompt 撑爆） */
const MAX_ITEMS_PER_PROJECT = 50;
/** 模型调用超时：日报是后台定时任务，宁可用兜底也不要挂住整个晨报 */
const MODEL_TIMEOUT_MS = 25_000;
/** activity 聚合单项目拉取上限（与 activity.ts 的 MAX_LIMIT 一致，desc 排序下昨日条目必在首页） */
const ACTIVITY_LIMIT = 500;

export interface DailyDigest {
  /** 报告正文（归纳要点 / 结构化兜底）；无活动时为空串 */
  markdown: string;
  /** 有活动的项目数 */
  projectCount: number;
  /** 参与归纳的条目总数 */
  itemCount: number;
}

/** 昨天（缺省 offsetDays=-1）的本地日期键 YYYY-MM-DD */
function localDateKey(offsetDays: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 日报分区标题「昨日小结」+ 中文日期（如「9月27日 周日」）。
 *  标题固定文案 + 日期由**代码拼装**：不让模型自己写——它可能漏写或写错日期，
 *  而且兜底路径与模型路径共用这一份，版式天然一致。 */
function summaryHeading(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dt.getDay()];
  const datePart = Number.isFinite(dt.getTime()) ? `（${dt.getMonth() + 1}月${dt.getDate()}日 ${week}）` : '';
  return `### 📋 昨日小结${datePart}`;
}

/** 条目的一句可读文案：任务条目用问题摘要（detail），其余用文件名 / 项目名（title） */
function itemText(it: ActivityItem): string {
  return it.kind === 'task' ? it.detail || it.title : it.title;
}

interface DigestProject {
  name: string;
  items: ActivityItem[];
}

/** 归纳提示词：给模型紧凑的流水清单，要求输出中文 markdown 要点 */
function buildPrompt(projects: DigestProject[], dateKey: string): string {
  const blocks = projects.map((p) => {
    const lines = p.items
      .slice(0, MAX_ITEMS_PER_PROJECT)
      .map((it) => {
        const t = fmtClock(it.ts);
        return `- [${it.kind}${t ? ` ${t}` : ''}] ${itemText(it)}`;
      });
    return `【项目】${p.name}\n${lines.join('\n')}`;
  });
  return `以下是各项目在 ${dateKey} 当天产生的流水记录（任务执行 / 文档生成 / 附件添加 / 项目状态变更）。
请输出「昨日小结 + 各项目明细」两部分，输出中文 markdown。

要求：
1. 开头是「昨日小结」正文：用 blockquote 写**一段话**（2–4 句），每行以 \`> \` 开头；
   整体概括这一天各项目总体上做了什么、推进到哪，像秘书汇报昨日工作那样自然连贯；
   **不要**自己写「昨日小结」这类分区标题（标题由报告框架另行添加），也不要额外的加粗行；
2. 空一行后输出一行 \`---\` 作为分隔线；
3. 分隔线之后是各项目明细：每个项目用 \`#### 📁 项目名\` 作四级标题（📁 与项目名之间留一个空格；
   用四级是因为「📋 昨日小结」已占三级，项目要比它低一档），
   其下用 \`- \` 列出 1–3 条要点，**每条要点以一个贴合语义的 emoji 起头**
   （例如：生成文档 📄、执行任务 🔧、新增附件 📎、新建项目 🆕、状态变更 🔄；同一类事项用同一个 emoji）；
4. 小结只做整体概括，不重复明细里已列的条目，不编造未出现的内容；
   信息不足的项目在明细里保留一行概述即可；
5. 只输出 markdown 正文，不要额外说明、不要代码块围栏。

--- 流水开始 ---
${blocks.join('\n\n')}
--- 流水结束 ---`;
}

/** 调任务模型做一次纯文本（markdown）归纳；失败抛出，由调用方降级 */
async function summarizeWithModel(cfg: ResolvedModel, prompt: string): Promise<string> {
  const endpoint = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: '你是项目日报助手，擅长把零散的开发/文档流水归纳成简洁的中文进展要点。' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`模型调用失败 (HTTP ${resp.status}): ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content: string = data?.choices?.[0]?.message?.content || '';
  return content
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

const KIND_ORDER: ActivityKind[] = ['task', 'document', 'attachment', 'lifecycle', 'project'];
const KIND_LABEL: Record<ActivityKind, string> = {
  task: '执行任务',
  document: '生成文档',
  attachment: '新增附件',
  lifecycle: '项目状态变更',
  project: '项目创建',
};
/** 类型 → emoji：与 buildPrompt 给模型的示例同一套，保证「模型输出」与「兜底输出」视觉一致 */
const KIND_EMOJI: Record<ActivityKind, string> = {
  task: '🔧',
  document: '📄',
  attachment: '📎',
  lifecycle: '🔄',
  project: '🆕',
};

/** 结构化兜底：先给一段计数式「昨日小结」，再按类型计数 + 最多 3 条代表性条目
 *  （模型不可用时仍有可读日报，且与模型输出的「小结 + 明细」结构一致）。 */
function fallbackBody(projects: DigestProject[]): string {
  const out: string[] = [];
  const totalItems = projects.reduce((n, p) => n + p.items.length, 0);
  const kindCount = new Map<ActivityKind, number>();
  for (const p of projects) {
    for (const it of p.items) kindCount.set(it.kind, (kindCount.get(it.kind) ?? 0) + 1);
  }
  const parts = KIND_ORDER.filter((k) => kindCount.get(k)).map((k) => `${KIND_LABEL[k]} ${kindCount.get(k)} 次`);
  // 与模型输出的版式保持同构：小结 blockquote → `---` 分隔 → 每个项目一个 `📁 ####` 标题 + emoji 要点
  //（「📋 昨日小结」三级分区标题不在这里——它由 buildDailyProjectDigest 统一拼装，两条路径共用同一份）
  out.push(`> 昨日共 ${projects.length} 个项目有活动，累计 ${totalItems} 条流水（${parts.join('、')}）。`);
  out.push('');
  out.push('---');
  out.push('');
  for (const p of projects) {
    out.push(`#### 📁 ${p.name}`);
    const byKind = new Map<ActivityKind, ActivityItem[]>();
    for (const it of p.items) {
      const arr = byKind.get(it.kind) ?? [];
      arr.push(it);
      byKind.set(it.kind, arr);
    }
    for (const kind of KIND_ORDER) {
      const list = byKind.get(kind);
      if (!list || list.length === 0) continue;
      const samples = list.slice(0, 3).map((x) => itemText(x));
      const tail = list.length > samples.length ? ` 等 ${list.length} 项` : '';
      out.push(`- ${KIND_EMOJI[kind]} ${KIND_LABEL[kind]} ${list.length} 次：${samples.join('；')}${tail}`);
    }
  }
  return out.join('\n');
}

/**
 * 生成「昨日项目进展」报告正文。
 * @param offsetDays 相对今天的天数偏移，缺省 -1（昨天）
 * @returns markdown 正文；无任何活动时为空串
 */
export async function buildDailyProjectDigest(offsetDays = -1): Promise<DailyDigest> {
  const dateKey = localDateKey(offsetDays);
  const { active_projects } = await listProjects();

  const projects: DigestProject[] = [];
  for (const p of active_projects) {
    let items: ActivityItem[] = [];
    try {
      const res = await collectProjectActivity(p, { order: 'desc', limit: ACTIVITY_LIMIT });
      items = res.groups.find((g) => g.date === dateKey)?.items ?? [];
    } catch (e) {
      console.warn(`[daily-digest] 项目「${p.name}」流水聚合失败，跳过:`, e);
      continue;
    }
    if (items.length > 0) projects.push({ name: p.name, items });
  }

  const itemCount = projects.reduce((n, g) => n + g.items.length, 0);
  if (projects.length === 0) return { markdown: '', projectCount: 0, itemCount: 0 };

  let body = '';
  try {
    const cfg = await resolveTaskModel();
    if (cfg) body = await summarizeWithModel(cfg, buildPrompt(projects, dateKey));
  } catch (e) {
    console.warn('[daily-digest] 模型归纳失败，改用结构化兜底:', e);
  }
  if (!body) body = fallbackBody(projects);

  return {
    // 分区标题（代码拼装，含日期）统一加在两条路径的产物之前 —— 模型只写小结正文与明细
    markdown: `${summaryHeading(dateKey)}\n\n${body}`,
    projectCount: projects.length,
    itemCount,
  };
}