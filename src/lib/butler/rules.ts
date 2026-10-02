/**
 * lib/butler/rules.ts —— 规则存储写原语（server-only）
 *
 * 依据：BobWork 轻量化管家方案 v6 §3.1（规则结构：本体字段 + 从属数据）、§4.2（⑧ 否定式路由）、
 * §10.2 Phase 0（只做存放与可见，不做自动执行）。
 *
 * 落点：`<APP_ROOT>/butler/.rules/<rule_id>.md`。
 *   - 点前缀 = 非角色内容（既有惯例，见 storage.ts 的 sanitizeRoleName 与附录 A-12），
 *     故规则集与「角色目录」天然分离，也不与 .state/ 混用。
 *   - **一条规则 = 一个文件**：规则本体低频、可编辑、需确认；与高频只追加的从属日志是两种形态
 *     （从属日志 hits / 三类信号本版不落盘，见 v6 §10.2 Phase 1）。
 *   - 存储是**全局**的，作用域由 `scope` 字段表达——**存放路径不表达作用域**（v6 §3.1）。
 *
 * 并发控制（v6 §3.1 ⑨）：单写原语内部串行（`_rulesLock`，照抄 storage.ts 的 `_rolesLock`）
 * + `version` 乐观锁。**不引入额外锁协议**。
 *
 * 依赖刻意收敛：只依赖 ./storage（其自身零内部依赖）与 gray-matter，不 import chat / core，避免环。
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import matter from 'gray-matter';
import { butlerRoot, ensureDir, dateStamp } from './storage';
import { atomicWriteFile, createLock } from './fs-atomic';
import {
  deriveCommitment,
  deriveKind,
  DEFAULT_RULE_PRIORITY,
  type RuleRecord,
  type RuleStep,
  type RuleTrigger,
  type RuleStatus,
  type StepKind,
  type CreateRuleInput,
  type RuleTimeTrigger,
} from './rules-shared';

export type { RuleRecord, RuleStep, RuleTrigger, RuleStatus, RuleKind, Commitment, StepKind, CreateRuleInput } from './rules-shared';

/** 规则集目录名（点前缀 = 非角色内容） */
const RULES_DIR_NAME = '.rules';

/** 规则 id 白名单：`r-<8位日期>-<hex>`；用于防目录穿越并校验存量格式 */
const RULE_ID_RE = /^r-\d{8}-[0-9a-f]{4,}$/;

/** 规则集根目录：<APP_ROOT>/butler/.rules */
export function rulesRoot(): string {
  return join(butlerRoot(), RULES_DIR_NAME);
}

/** 规则本体文件路径：<rulesRoot>/<id>.md */
export function ruleFilePath(id: string): string {
  return join(rulesRoot(), `${id}.md`);
}

/** 生成规则 id：`r-<YYYYMMDD>-<4hex>`（前缀示「哪天定的」，随机尾保证永不变） */
export function generateRuleId(d: Date = new Date()): string {
  return `r-${dateStamp(d).replace(/-/g, '')}-${randomBytes(2).toString('hex')}`;
}

/** 本地时间戳 YYYY-MM-DD HH:mm（与 preferences.ts 的 created_at 口径一致） */
function nowStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ==================== 序列化 / 反序列化 ====================

/** frontmatter 每个值统一 JSON 编码（JSON 是 YAML 的子集，gray-matter 可原样解析回来） */
function serialize(rule: RuleRecord): string {
  const fm: Record<string, unknown> = {
    id: rule.id,
    name: rule.name,
    kind: rule.kind,
    commitment: rule.commitment,
    scope: rule.scope,
    priority: rule.priority,
    status: rule.status,
    version: rule.version,
    created_at: rule.createdAt,
    trigger_keywords: rule.trigger.keywords,
  };
  if (rule.scopeTarget) fm.scope_target = rule.scopeTarget;
  if (rule.trigger.scenes && rule.trigger.scenes.length > 0) fm.trigger_scenes = rule.trigger.scenes;
  if (rule.trigger.time) fm.trigger_time = rule.trigger.time;
  if (rule.lastHit) fm.last_hit = rule.lastHit;
  // action 的确定参数按**步骤序号（1 基）**存 frontmatter（值可能含 ':'，不能塞进步骤标签）
  const stepParams: Record<string, { when?: string; skillId?: string }> = {};
  rule.steps.forEach((s, i) => {
    const p = s.actionParams;
    if (p?.when || p?.skillId) {
      const entry: { when?: string; skillId?: string } = {};
      if (p.when) entry.when = p.when;
      if (p.skillId) entry.skillId = p.skillId;
      stepParams[String(i + 1)] = entry;
    }
  });
  if (Object.keys(stepParams).length > 0) fm.step_params = stepParams;

  const head = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');

  const stepLines = rule.steps
    .map((s) => {
      // 标签：judgment / judgment:annex / deterministic[:<action>]（action 仅确定性步有意义）
      const tag = [
        s.kind === 'judgment' && s.annex ? 'judgment:annex' : s.kind,
        s.kind === 'deterministic' && s.action ? s.action : '',
      ].filter(Boolean).join(':');
      return `- [${tag}] ${s.text}`;
    })
    .join('\n');

  return `---\n${head}\n---\n\n## Intent\n\n${rule.intentRaw}\n\n## Steps\n\n${stepLines}\n`;
}

/** 合法的确定性 action 取值（解析白名单）。
 *  `'skill'`：调用已固化技能（Phase 3 §3.6）——Skills 是 Rules 动作枚举的动态扩展，
 *  与 create_todo 等同属确定性动作，共用同一执行器（rule-exec），不经模型。 */
const RULE_STEP_ACTIONS = ['create_todo', 'create_scheduled_todo', 'skill'] as const;

/**
 * 从 Markdown 正文解析步骤：`- [deterministic[:<action>]|judgment|judgment:annex] 文本`。
 * `actionParams` 由 frontmatter 的 `step_params`（按 1 基步骤序号）回填。
 */
function parseSteps(body: string, params?: Record<string, { when?: string; skillId?: string }>): RuleStep[] {
  const steps: RuleStep[] = [];
  for (const line of body.split('\n')) {
    const m = /^-\s*\[([a-z:_]+)\]\s*(.+)$/i.exec(line.trim());
    if (!m) continue;
    const tagParts = m[1].split(':');
    const kind: StepKind = tagParts[0].startsWith('judgment') ? 'judgment' : 'deterministic';
    const step: RuleStep = { kind, text: m[2].trim() };
    if (tagParts.includes('annex')) step.annex = true;
    if (kind === 'deterministic') {
      const action = RULE_STEP_ACTIONS.find((a) => tagParts.includes(a));
      if (action) step.action = action;
      const p = params?.[String(steps.length + 1)];
      const when = p?.when;
      const skillId = p?.skillId;
      if ((typeof when === 'string' && when) || (typeof skillId === 'string' && skillId)) {
        step.actionParams = {};
        if (typeof when === 'string' && when) step.actionParams.when = when;
        if (typeof skillId === 'string' && skillId) step.actionParams.skillId = skillId;
      }
    }
    steps.push(step);
  }
  return steps;
}

/** 归一化入参步骤：白名单 action + 确定参数（createRule / updateRule 共用同一口径） */
function normalizeSteps(steps: RuleStep[]): RuleStep[] {
  return steps
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .map((s) => {
      const kind: StepKind = s.kind === 'judgment' ? 'judgment' : 'deterministic';
      const out: RuleStep = { kind, text: s.text.trim() };
      if (kind === 'judgment' && s.annex === true) out.annex = true;
      if (kind === 'deterministic') {
        if (s.action && (RULE_STEP_ACTIONS as readonly string[]).includes(s.action)) out.action = s.action;
        const p = s.actionParams;
        if (p?.when || p?.skillId) {
          out.actionParams = {};
          if (p.when) out.actionParams.when = p.when;
          if (p.skillId) out.actionParams.skillId = p.skillId;
        }
      }
      return out;
    });
}

/** 提取 `## Intent` 段落（到下一个 `## ` 为止） */
function parseIntent(body: string): string {
  const m = /^##\s+Intent\s*\n+([\s\S]*?)(?=\n##\s|\s*$)/m.exec(body);
  return m ? m[1].trim() : '';
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 解析一个规则文件（坏文件 / 缺关键字段 → null，不让脏数据阻断列表） */
export function parseRule(raw: string): RuleRecord | null {
  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(raw);
    data = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content;
  } catch {
    return null;
  }

  const id = asString(data.id);
  const name = asString(data.name);
  if (!id || !name) return null;

  const stepParams =
    data.step_params && typeof data.step_params === 'object'
      ? (data.step_params as Record<string, { when?: string; skillId?: string }>)
      : undefined;
  const steps = parseSteps(body, stepParams);
  const statusRaw = asString(data.status);

  const trigger: RuleTrigger = {
    keywords: Array.isArray(data.trigger_keywords)
      ? (data.trigger_keywords as unknown[]).filter((k): k is string => typeof k === 'string')
      : [],
  };
  if (Array.isArray(data.trigger_scenes)) {
    trigger.scenes = (data.trigger_scenes as unknown[]).filter((s): s is string => typeof s === 'string');
  }
  if (data.trigger_time && typeof data.trigger_time === 'object') {
    trigger.time = data.trigger_time as RuleTimeTrigger;
  }

  return {
    id,
    name,
    // 派生字段以 steps 为准（落盘值仅作参考），保证盘上与派生逻辑永不打架
    kind: deriveKind(steps),
    intentRaw: parseIntent(body),
    trigger,
    steps,
    commitment: deriveCommitment(steps),
    scope: asString(data.scope) === 'project' ? 'project' : 'global',
    ...(typeof data.scope_target === 'string' && data.scope_target ? { scopeTarget: data.scope_target } : {}),
    priority: asNumber(data.priority, DEFAULT_RULE_PRIORITY),
    status: (['draft', 'active', 'paused', 'retired'] as string[]).includes(statusRaw)
      ? (statusRaw as RuleStatus)
      : 'active',
    version: asNumber(data.version, 1),
    createdAt: asString(data.created_at),
    ...(typeof data.last_hit === 'string' && data.last_hit ? { lastHit: data.last_hit } : {}),
  };
}

// ==================== 读写原语 ====================

/** rules 读-改-写串行化（多请求并发改同一规则时避免互相覆盖）。
 *  锁与原子写原语统一取自 `./fs-atomic`（2026-10-02 评审：此前 5 份副本各自演化）。 */
const withLock = createLock();

/** 原子写一个规则文件（先写 tmp 再 rename，避免并发读-改-写写出半截文件） */
async function writeRuleFile(rule: RuleRecord): Promise<void> {
  await ensureDir(rulesRoot());
  await atomicWriteFile(ruleFilePath(rule.id), serialize(rule));
}

/** 读一条规则；不存在 / id 非法 / 解析失败 → null */
export async function readRule(id: string): Promise<RuleRecord | null> {
  if (!RULE_ID_RE.test(id)) return null;
  try {
    const raw = await fs.readFile(ruleFilePath(id), 'utf-8');
    return parseRule(raw);
  } catch {
    return null;
  }
}

/** 列出全部规则（目录不存在 → []；按 created_at 倒序，同刻按 id 升序保证稳定） */
export async function listRules(): Promise<RuleRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(rulesRoot());
  } catch {
    return [];
  }
  const rules: RuleRecord[] = [];
  for (const n of names) {
    const id = n.endsWith('.md') ? n.slice(0, -3) : '';
    if (!id || !RULE_ID_RE.test(id)) continue;
    const r = await readRule(id);
    if (r) rules.push(r);
  }
  rules.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : b.createdAt.localeCompare(a.createdAt)));
  return rules;
}

/** 新建一条规则（id / version / createdAt / commitment / kind 自动生成） */
export async function createRule(input: CreateRuleInput): Promise<RuleRecord> {
  const name = (input.name || '').trim();
  const intentRaw = (input.intentRaw || '').trim();
  const steps = input.steps || [];
  if (!name) throw new Error('rule name is required');
  if (!intentRaw) throw new Error('rule intent_raw is required');
  const normalized = normalizeSteps(steps);
  if (normalized.length === 0) throw new Error('rule must have at least one step');

  const scope = input.scope === 'project' ? 'project' : 'global';
  if (scope === 'project' && !input.scopeTarget) throw new Error('scope_target is required when scope is project');

  const rule: RuleRecord = {
    id: generateRuleId(),
    name,
    kind: input.kind ?? deriveKind(normalized),
    intentRaw,
    trigger: {
      keywords: (input.trigger?.keywords ?? []).map((k) => String(k).trim()).filter(Boolean),
      ...(input.trigger?.scenes && input.trigger.scenes.length > 0 ? { scenes: input.trigger.scenes } : {}),
      ...(input.trigger?.time ? { time: input.trigger.time } : {}),
    },
    steps: normalized,
    commitment: deriveCommitment(normalized),
    scope,
    ...(scope === 'project' ? { scopeTarget: input.scopeTarget } : {}),
    priority: typeof input.priority === 'number' && Number.isFinite(input.priority) ? input.priority : DEFAULT_RULE_PRIORITY,
    status: 'active',
    version: 1,
    createdAt: nowStamp(),
  };

  await withLock(() => writeRuleFile(rule));
  return rule;
}

/** 可更新字段（id / created_at 不可改；kind 未显式传入时由 steps 重派生） */
export interface UpdateRulePatch {
  name?: string;
  intentRaw?: string;
  steps?: RuleStep[];
  trigger?: Partial<RuleTrigger>;
  scope?: 'global' | 'project';
  scopeTarget?: string;
  priority?: number;
  status?: RuleStatus;
  kind?: RuleRecord['kind'];
}

/**
 * 更新一条规则。`expectedVersion` 为乐观锁：与盘上 version 不符 → `{ok:false, conflict:true}`。
 * 变更后 `version++`，`commitment` 始终由 steps 重派生。
 */
export async function updateRule(
  id: string,
  patch: UpdateRulePatch,
  expectedVersion?: number,
): Promise<{ ok: true; rule: RuleRecord } | { ok: false; conflict?: true; error: string }> {
  if (!RULE_ID_RE.test(id)) return { ok: false, error: `invalid rule id: ${id}` };
  return withLock(async () => {
    const current = await readRule(id);
    if (!current) return { ok: false, error: `rule not found: ${id}` };
    if (typeof expectedVersion === 'number' && expectedVersion !== current.version) {
      return { ok: false, conflict: true, error: `version conflict: expected ${expectedVersion}, on disk ${current.version}` };
    }

    const steps: RuleStep[] = patch.steps ? normalizeSteps(patch.steps) : current.steps;
    if (steps.length === 0) return { ok: false, error: 'rule must have at least one step' };

    const name = patch.name !== undefined ? patch.name.trim() : current.name;
    if (!name) return { ok: false, error: 'rule name cannot be empty' };
    const intentRaw = patch.intentRaw !== undefined ? patch.intentRaw.trim() : current.intentRaw;
    if (!intentRaw) return { ok: false, error: 'rule intent_raw cannot be empty' };

    const scope = patch.scope ?? current.scope;
    const scopeTarget = patch.scopeTarget !== undefined ? patch.scopeTarget : current.scopeTarget;
    if (scope === 'project' && !scopeTarget) return { ok: false, error: 'scope_target is required when scope is project' };

    const trigger: RuleTrigger = patch.trigger
      ? {
          keywords: (patch.trigger.keywords ?? current.trigger.keywords).map((k) => String(k).trim()).filter(Boolean),
          ...(patch.trigger.scenes !== undefined
            ? (patch.trigger.scenes.length > 0 ? { scenes: patch.trigger.scenes } : {})
            : (current.trigger.scenes ? { scenes: current.trigger.scenes } : {})),
          ...(patch.trigger.time !== undefined
            ? (patch.trigger.time ? { time: patch.trigger.time } : {})
            : (current.trigger.time ? { time: current.trigger.time } : {})),
        }
      : current.trigger;

    const next: RuleRecord = {
      ...current,
      name,
      intentRaw,
      steps,
      trigger,
      kind: patch.kind ?? deriveKind(steps),
      commitment: deriveCommitment(steps),
      scope,
      priority: patch.priority !== undefined && Number.isFinite(patch.priority) ? patch.priority : current.priority,
      status: patch.status ?? current.status,
      version: current.version + 1,
    };
    if (scope === 'project' && scopeTarget) next.scopeTarget = scopeTarget;
    else delete next.scopeTarget;

    await writeRuleFile(next);
    return { ok: true, rule: next };
  });
}

/** 改状态（pause / retire / active / draft） */
export async function setRuleStatus(
  id: string,
  status: RuleStatus,
): Promise<{ ok: boolean; rule?: RuleRecord; error?: string }> {
  const res = await updateRule(id, { status });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, rule: res.rule };
}

/** 删除一条规则（仅删本体；Phase 0 无从属日志，故无孤儿） */
export async function deleteRule(id: string): Promise<boolean> {
  if (!RULE_ID_RE.test(id)) return false;
  try {
    await fs.unlink(ruleFilePath(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * ⑧ 路由落点：把否定式表达转成一条规则（v6 §4.2）。
 * 否定式是**硬约束**（执行上无中间态），故记为 kind=rule、单个确定性步骤、commitment=必做到。
 * 语面触发词 Phase 0 留空（不评估）；时间组不设。
 */
export async function createRuleFromNegation(
  content: string,
  opts?: { scopeTarget?: string },
): Promise<RuleRecord> {
  const text = (content || '').trim();
  if (!text) throw new Error('negation content is empty');
  const name = text.length > 24 ? `${text.slice(0, 24)}…` : text;
  return createRule({
    name,
    intentRaw: text,
    steps: [{ kind: 'deterministic', text }],
    trigger: { keywords: [] },
    ...(opts?.scopeTarget ? { scope: 'project' as const, scopeTarget: opts.scopeTarget } : {}),
  });
}