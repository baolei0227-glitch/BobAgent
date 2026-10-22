import { homedir } from 'os';
import { join, basename, sep, relative, resolve, dirname } from 'path';
import { statSync, readdirSync, existsSync, mkdirSync, renameSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import {
  PROVIDER_PRESETS,
  isDeclaredV4Model,
  isPresetVisionModel,
  type ProviderType,
  type ThinkingLevel,
  type OutputFileItem,
  SYSTEM_PROMPT_INJECTIONS,
} from '@/lib/types';
import { TOOL_DEFINITIONS, executeTool, getToolSummary, describeToolCall } from './tools';
import type { ToolScene } from './tools';
// K2-S1 工具面 runtime service 抽取，行为不变：注册/组装/排序/CacheGuard 收敛进 ToolRuntime
import { ToolRuntime, SANDBOX_BLOCKED_TOOLS, isBridgeWriteAllowed, resolveEffectiveScenes } from '@/lib/runtime/tools';
// K2-S2 会话态 runtime service 抽取，行为不变：chatStickyScenes 收敛进 SessionRuntime 单例
import { sessionRuntime } from '@/lib/runtime/session';
// K2-S3 动态上下文链 runtime service 抽取，行为不变：路径/授权/偏好/OCR 文本生成收敛进 ContextRuntime
import { contextRuntime } from '@/lib/runtime/context';
// 前缀缓存 per-call 遥测（2026-10-02）：三段指纹 + 漂移标记，与每次调用的 hit/miss 一起落盘
import { getSessionTracker, recordCacheCall } from '@/lib/runtime/cache-telemetry';
// 项目级后台调度：用户对话 > 成果块提炼 > 账本编译（本轮请求是最高优先级，持有期间后台让位）
import { enterUserTurn } from '@/lib/runtime/project-scheduler';
import type { AgentId } from '@/lib/agents/profiles';
import { codingPhaseForTool, skillExclusionsFor, supportsTeamCollab } from '@/lib/agents/profiles';
import { resolveAgentProfile } from '@/lib/agents/store';
import { loadInstalledAgentProfiles } from '@/lib/agents/market-server';
import { MCP_PRESETS } from '@/lib/mcp/types';
import { getPanelPort } from '@/lib/mcp/panel-ports';
import { getCurrentProject, getProjectById, listProjects, type ProjectConfig } from '@/lib/project/project-manager';
import { readSettingsFromFile } from '@/lib/settings-server';
import { DEFAULT_CONFIRM_TOOLS } from '@/lib/settings';
import { getHippoPageUrl } from '@/lib/browser-tools';
import { isVisionModel } from '@/lib/model-tags';
import { isDeclaredVisionModel } from '@/lib/model-capabilities';
// P4b-1 审批策略层：tool_confirm 名单判定后走 decideToolApproval（纯函数裁决，见 approval.ts）
import { decideToolApproval } from '@/lib/chat/approval';
import { createPendingConfirm, CONFIRM_TIMEOUT_MS, type ConfirmResult } from '@/lib/chat/confirm-pending';
// 空轮收尾策略：输出触顶（finish_reason=length）按可恢复故障处理 + 空答案兜底（见该文件头注释的事故复盘）
import { planTruncationRetry, buildTruncationRetryNudge, buildEmptyAnswerFallback } from '@/lib/chat/empty-round';
// P4a 三段化骨架：工具轮宿主接管注册表 + 场景激活统一执行（纯类型 + 编排，见 tool-pipeline.ts 文件头注释）
// P4a-3-1：挂起型（host-pending）接管注册/查询（registerHostTakeover / hostTakeoverFor）
import { registerTakeover, takeoverFor, takeoverOfKind, applyScenarioActivation, registerHostTakeover, hostTakeoverFor, assertConsultContract } from '@/lib/chat/tool-pipeline';
import type { TakeoverServices, HostTakeoverContext, HostTakeoverVerdict } from '@/lib/chat/tool-pipeline';

// K3-2：工具轮咨询链契约加载期自检（9 咨询点顺序/覆盖/唯一性；热更加载即断言，与单测双保险）
assertConsultContract();
// Phase 2 策略层抽取：思考档位决策收敛到纯函数模块（S2a 后统一 reasoning_effort 词表，默认行为=纯固定档）
import { effortForLevel, executionDowngrade, downgradeEffortOnce, isTrivialPrompt, shouldInjectThinkPrompt, type ThinkingPolicyConfig } from '@/lib/thinking/policy';

// ── Butler 结构化确认卡片（排程创建/修改/删除走可编辑确认，而非直接执行）──
const BUTLER_CARD_TOOLS = new Set(['create_scheduled_todo', 'todo_update', 'todo_delete']);

type ButlerCard = {
  tool: string;
  mode: 'create' | 'update' | 'delete';
  event_id: string | null;
  title: string;
  date: string;   // YYYY-MM-DD（本地）
  start: string;  // HH:MM
  end: string;    // HH:MM（可空）
  allDay: boolean;
  reminderMinutes: number[];
  targetLabel: string;
  /** 同窗口已有安排（when 为 `09:00–11:00` 区间；跨日带日期） */
  conflicts: { title: string; when: string }[];
  /** 重叠命中总数；> conflicts.length 说明被截断（卡片显示「共 N 条」） */
  conflictTotal: number;
  /** 潜在风险（紧邻空档不足 / 相邻异地 / 同日全天）——与 assessEventSlot 同一判定真源，
   *  text 为卡片展示用英文（面向模型的原始 message 是中文，不走卡片） */
  risks: { kind: string; text: string }[];
  /** 净空替代时段标签（`Today 15:00–16:00`）；仅在有冲突/风险时给出 */
  alternatives: string[];
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function toLocalDateStr(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function toLocalTimeStr(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 时段评估（冲突 + 潜在风险 + 替代时段）：与 create_scheduled_todo 执行器共用
 *  lib/calendar/overlaps.assessEventSlot（判定单一真源）。
 *  2026-09-27：卡片是排程的**唯一确认点**——冲突/风险必须在卡上先讲清，
 *  用户点确认即为知情同意（handleButlerCard 随后注入 force=true，执行器不再二次拦截，
 *  避免「卡片批准后执行器再拒一次 → 模型再问 → 第二张卡」的两次确认）。 */
async function assessButlerSlot(
  startIso: string | null,
  endIso: string | null,
  opts?: { location?: string; allDay?: boolean; excludeEventId?: string },
): Promise<{
  conflicts: { title: string; when: string }[];
  total: number;
  risks: { kind: string; text: string }[];
  alternatives: string[];
}> {
  const { assessEventSlot } = await import('@/lib/calendar/overlaps');
  const res = await assessEventSlot({
    startIso,
    endIso,
    location: opts?.location,
    allDay: opts?.allDay,
    excludeEventId: opts?.excludeEventId,
  });
  // assessEventSlot 的 message / label 面向模型（中文），卡片是 UI（文案一律英文）——两者分轨，
  // 这里用结构化字段重建英文展示文案（when 字段本身是 `09:00–11:00` 这类语言中性的片段）。
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const dayEn = (d: Date) =>
    sameDay(d, now) ? 'Today' : sameDay(d, new Date(now.getTime() + 86_400_000)) ? 'Tomorrow' : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hmEn = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return {
    conflicts: res.overlaps.map((i) => ({ title: i.title, when: i.when || '—' })),
    total: res.total_overlaps,
    risks: res.risks.map((r) => {
      const when = r.when ? ` (${r.when})` : '';
      const text =
        r.kind === 'tight_gap'
          ? `Only ${r.gap_minutes ?? 0} min between "${r.title ?? ''}"${when} and this event.`
          : r.kind === 'remote_shift'
            ? `"${r.title ?? ''}"${when} is at a different place — only ${r.gap_minutes ?? 0} min to get there.`
            : `An all-day event "${r.title ?? ''}" is already on this day.`;
      return { kind: r.kind, text };
    }),
    alternatives: res.alternatives.map((a) => {
      const s = new Date(a.start);
      const e = new Date(a.end);
      return Number.isNaN(s.getTime()) ? a.label : `${dayEn(s)} ${hmEn(s)}–${hmEn(e)}`;
    }),
  };
}

/** 把工具参数转成结构化卡片；构建失败（如待改/删事件不存在）返回 null（跳过卡片直接执行） */
async function buildButlerCard(
  toolName: string,
  args: Record<string, unknown> | null,
): Promise<ButlerCard | null> {
  try {
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const numArr = (v: unknown): number[] =>
      Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
    if (toolName === 'create_scheduled_todo') {
      const title = str(args?.title).trim();
      const startIso = str(args?.start_time) || null;
      const endIso = str(args?.end_time) || null;
      const allDay = args?.all_day === true;
      const reminderMinutes = numArr(args?.reminder_minutes);
      const location = str(args?.location).trim();
      // 模型未给 end_time 时补上执行器将要写入的默认块长（估时 或 60 分钟）：
      // 让卡片的时段评估窗口 = 真正写入的窗口，卡上「时长」也与最终提交一致
      // （否则卡片按 30 分钟默认窗口评估、执行器按 60 分钟写入，两边结论可能不一致）。
      const estMin =
        typeof args?.estimated_minutes === 'number' &&
        Number.isFinite(args.estimated_minutes) &&
        args.estimated_minutes > 0
          ? Math.round(args.estimated_minutes)
          : undefined;
      const startDate = new Date(startIso ?? '');
      const endIsoResolved =
        endIso ??
        (!allDay && startIso && !Number.isNaN(startDate.getTime())
          ? new Date(startDate.getTime() + (estMin ?? 60) * 60_000).toISOString()
          : null);
      const ov = await assessButlerSlot(startIso, endIsoResolved, { location, allDay });
      return {
        tool: toolName,
        mode: 'create',
        event_id: null,
        title,
        date: toLocalDateStr(startIso),
        start: toLocalTimeStr(startIso),
        end: toLocalTimeStr(endIsoResolved),
        allDay,
        reminderMinutes,
        targetLabel: '',
        conflicts: ov.conflicts,
        conflictTotal: ov.total,
        risks: ov.risks,
        alternatives: ov.alternatives,
      };
    }
    const eventId = str(args?.event_id);
    if (!eventId) return null;
    const { getCalendarDb, getEvent } = await import('@/lib/db');
    const db = await getCalendarDb();
    const row = await getEvent(db, eventId);
    if (!row) return null;
    if (toolName === 'todo_delete') {
      // 删日程的卡片只在「删除会连带改动日历之外的数据」时才弹：事件源自便签行（source_ref 非空）时，
      // 删除会同时移除用户便签上的那一行（见 /api/calendar/events DELETE 的反向联动）——这个副作用值得先告知。
      // 普通日历事件无冲突、无副作用 → risks 空 → handleButlerCard 判 'noop'，直接软删（可恢复），不再拦人。
      const noteLinked = !!row.source_ref;
      return {
        tool: toolName,
        mode: 'delete',
        event_id: eventId,
        title: row.title,
        date: toLocalDateStr(row.start_time),
        start: toLocalTimeStr(row.start_time),
        end: '',
        allDay: row.all_day === 1,
        reminderMinutes: [],
        targetLabel: row.title,
        conflicts: [],
        conflictTotal: 0,
        risks: noteLinked
          ? [
              {
                kind: 'note_link',
                text: 'This event came from a note line — deleting it also removes that line from your note.',
              },
            ]
          : [],
        alternatives: [],
      };
    }
    // todo_update：以现有事件为默认，可被 args 覆盖
    let rowReminders: number[] = [];
    try {
      const parsed = JSON.parse(row.reminder_minutes_json || '[]');
      if (Array.isArray(parsed)) rowReminders = parsed.filter((x): x is number => typeof x === 'number');
    } catch {
      rowReminders = [];
    }
    const title = str(args?.title).trim() || row.title;
    const startIso = str(args?.start_time) || row.start_time;
    const endIso = str(args?.end_time) || row.end_time;
    const allDay = typeof args?.all_day === 'boolean' ? args.all_day : row.all_day === 1;
    const reminderMinutes =
      args?.reminder_minutes !== undefined && args?.reminder_minutes !== null
        ? numArr(args.reminder_minutes)
        : rowReminders;
    const location = str(args?.location).trim() || str(row.location).trim();
    const ov = await assessButlerSlot(startIso, endIso, { location, allDay, excludeEventId: eventId });
    return {
      tool: toolName,
      mode: 'update',
      event_id: eventId,
      title,
      date: toLocalDateStr(startIso),
      start: toLocalTimeStr(startIso),
      end: toLocalTimeStr(endIso),
      allDay,
      reminderMinutes,
      targetLabel: row.title,
      conflicts: ov.conflicts,
      conflictTotal: ov.total,
      risks: ov.risks,
      alternatives: ov.alternatives,
    };
  } catch {
    return null;
  }
}

// ── Butler 规则草案卡（v6 §3.2「拟稿回显 → 确认」，Phase 1）──
// 与排程卡并列的另一条 butler 卡片通道，复用同一 `butler_confirm` 挂起型形态。
// rule_create + 全局作用域时先弹**可编辑草案卡**：approved 才落盘（回落通用执行 → toolRuleCreate），
// denied/超时 → 不落盘 + 记一条否定。Phase 2 起「流程（含判断步）」也走拟稿回显（承诺=会启动并尽力，
// §8.5）；项目作用域规则仍不拟稿。命中后的执行语义见 rule_exec / rule_create 回执。
const BUTLER_RULE_DRAFT_TOOLS = new Set(['rule_create']);

// 技能草案卡（Phase 3 §3.5）：skill_draft 恒走可编辑草案卡 —— approved 才落 .skills/<id>.md
// （回落通用执行 → toolSkillDraft），denied/超时 → 不落盘 + 记一条否定。与规则草案卡同款三段（复用挂起容器）。
const BUTLER_SKILL_DRAFT_TOOLS = new Set(['skill_draft']);

type RuleDraftStep = {
  kind: 'deterministic' | 'judgment';
  text: string;
  annex?: boolean;
  action?: 'create_todo' | 'create_scheduled_todo';
  actionParams?: { when?: string };
};

type RuleDraftCard = {
  kind: 'rule_draft';
  tool: string;
  name: string;
  intentRaw: string;
  steps: RuleDraftStep[];
  keywords: string[];
  /** 承诺级别：固定原词（必做到 / 基本做到），§8.5 —— 不在卡上做英文意译 */
  commitment: string;
};

/** 从 rule_create 入参构建规则草案卡；非「规则 + 全局」→ null（不拟稿，交回宿主照常执行） */
async function buildRuleDraftCard(args: Record<string, unknown> | null): Promise<RuleDraftCard | null> {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const name = str(args?.name).trim();
  const intentRaw = str(args?.intent_raw).trim();
  if (!name || !intentRaw) return null;
  if (str(args?.scope_target).trim()) return null; // 项目作用域规则不走草案卡
  const rawSteps = Array.isArray(args?.steps) ? args.steps : [];
  const steps: RuleDraftStep[] = [];
  for (const s of rawSteps) {
    if (typeof s === 'string') {
      const t = s.trim();
      if (t) steps.push({ kind: 'deterministic', text: t });
      continue;
    }
    if (!s || typeof s !== 'object') continue;
    const o = s as { kind?: unknown; text?: unknown; annex?: unknown; action?: unknown; action_params?: unknown };
    const text = str(o.text).trim();
    if (!text) continue;
    const kind = o.kind === 'judgment' ? 'judgment' : 'deterministic';
    const step: RuleDraftStep = { kind, text };
    if (kind === 'judgment' && o.annex === true) step.annex = true;
    if (kind === 'deterministic') {
      const action = o.action === 'create_todo' || o.action === 'create_scheduled_todo' ? o.action : undefined;
      if (action) step.action = action;
      const ap = o.action_params as { when?: unknown } | undefined;
      if (ap && typeof ap === 'object' && typeof ap.when === 'string' && ap.when) step.actionParams = { when: ap.when };
    }
    steps.push(step);
  }
  if (steps.length === 0) return null;
  const { deriveCommitment } = await import('@/lib/butler/rules-shared');
  // Phase 2：含主体判断步的「流程」也走拟稿回显（承诺级别 = 会启动并尽力，§8.5）
  const keywords = Array.isArray(args?.keywords)
    ? args.keywords.map(String).map((x) => x.trim()).filter(Boolean)
    : [];
  return { kind: 'rule_draft', tool: 'rule_create', name, intentRaw, steps, keywords, commitment: deriveCommitment(steps) };
}

/** 规则草案卡挂起处理：弹卡 → 等确认 → approved 回落执行 / denied·超时落否定并中止 */
async function handleRuleDraftCard(ctx: HostTakeoverContext): Promise<HostTakeoverVerdict> {
  // 聚合链路收不到卡片确认回传 → 直接说明不执行
  if (ctx.channel) return denyOnAggregateChannel(ctx, '固化规则需要你在可编辑草案卡上点一下确认。');
  const card = await buildRuleDraftCard(ctx.args);
  if (!card) return 'noop';
  const { confirmId, promise } = createPendingConfirm(ctx.name, ctx.execArgs ?? '', ctx.nodeId);
  ctx.send({
    butler_confirm: {
      confirmId,
      name: ctx.name,
      card,
      timeoutSec: Math.ceil(CONFIRM_TIMEOUT_MS / 1000),
    },
    nodeId: ctx.nodeId,
  });
  const keepalive = setInterval(() => {
    ctx.send({ tool_call_update: { name: ctx.name, phase: 'running', spanId: ctx.spanId, startAt: ctx.startAt }, nodeId: ctx.nodeId });
  }, 20000);
  let res: ConfirmResult;
  try {
    res = await promise;
  } finally {
    clearInterval(keepalive);
  }
  if (res.verdict !== 'approved') {
    // denied / 超时 → 不落盘 + 记一条否定（与 rule_dismiss 同一写口；供后续修订/拉黑共用）。
    // 草案尚无真实规则 id，故用「本可生成」的 id 落账，语义为「用户否决了这个模式」。
    try {
      const { generateRuleId } = await import('@/lib/butler/rules');
      const { recordUserDismissed } = await import('@/lib/butler/rule-signals');
      await recordUserDismissed(generateRuleId(), 1, 'draft_denied');
    } catch {
      /* 记否定失败不阻断「不落盘」语义 */
    }
    const deniedResult =
      res.verdict === 'timeout'
        ? `规则固化因等待确认超时（${Math.ceil(CONFIRM_TIMEOUT_MS / 60_000)} 分钟内未收到你的确认）而自动跳过，未落盘。请如实告知用户并询问是否继续。`
        : '你放弃了这条规则草案（未确认即不落盘）。请停止该操作，向用户说明并征询意见。';
    ctx.send({
      tool_result: {
        name: ctx.name,
        result: deniedResult,
        durationMs: 0,
        success: false,
        phase: 'error',
        spanId: ctx.spanId,
        startAt: ctx.startAt,
        endAt: Date.now(),
      },
      nodeId: ctx.nodeId,
    });
    ctx.commitToolError?.(deniedResult);
    return 'handled_continue';
  }
  // approved：用户可能编辑过草案 → 用编辑后的参数覆盖执行，回落通用执行 → toolRuleCreate 真正落盘
  const editedArgs = res.edited?.toolArgs;
  const execArgs =
    editedArgs && typeof editedArgs === 'object' ? (editedArgs as Record<string, unknown>) : ctx.args;
  ctx.setExecArgs?.(JSON.stringify(execArgs));
  return 'handled_fallback';
}

/** 技能草案卡上的可编辑/只读字段（Phase 3 §3.5：卡片必须让用户看懂 4 件事） */
type SkillDraftStep = { primitive: string; text?: string; params?: Record<string, string> };
type SkillDraftCard = {
  kind: 'skill_draft';
  tool: string;
  /** ① 这技能要干什么（一句） */
  name: string;
  description: string;
  /** ② 什么时候会被自动调用（适用条件，必须显式） */
  when: { keywords: string[]; scenes?: string[]; objectTypes?: string[]; preconditions?: string[] };
  runtime: 'compose' | 'script';
  steps: SkillDraftStep[];
  /** ③ 它要什么权限（grant；默认空 = 无额外权限） */
  grants: { fs?: string[]; net?: boolean; process?: boolean };
  /** ④ 会产生什么副作用（写文件 / 进日历 / 发消息）——由 grants 派生，供卡片展示 */
  effects: string[];
};

/** 从 skill_draft 入参构建技能草案卡；缺 name/description → null（不拟稿，交回宿主照常执行） */
async function buildSkillDraftCard(args: Record<string, unknown> | null): Promise<SkillDraftCard | null> {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const name = str(args?.name).trim();
  const description = str(args?.description).trim();
  if (!name || !description) return null;

  const whenArg = args?.when && typeof args.when === 'object' ? (args.when as Record<string, unknown>) : {};
  const keywords = Array.isArray(whenArg.keywords) ? whenArg.keywords.map(String).map((x) => x.trim()).filter(Boolean) : [];
  const scenes = Array.isArray(whenArg.scenes) ? whenArg.scenes.map(String).map((x) => x.trim()).filter(Boolean) : [];
  const objectTypes = Array.isArray(whenArg.object_types)
    ? whenArg.object_types.map(String).filter((x) => ['todo', 'schedule', 'note', 'meeting', 'project'].includes(x))
    : [];
  const preconditions = Array.isArray(whenArg.preconditions) ? whenArg.preconditions.map(String).map((x) => x.trim()).filter(Boolean) : [];

  const rawSteps = Array.isArray(args?.steps) ? args.steps : [];
  const steps: SkillDraftStep[] = [];
  for (const s of rawSteps) {
    if (!s || typeof s !== 'object') continue;
    const o = s as { primitive?: unknown; text?: unknown; params?: unknown };
    const primitive = str(o.primitive).trim();
    if (!primitive) continue;
    const step: SkillDraftStep = { primitive };
    if (str(o.text).trim()) step.text = str(o.text).trim();
    if (o.params && typeof o.params === 'object' && !Array.isArray(o.params)) {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(o.params as Record<string, unknown>)) if (typeof v === 'string') params[k] = v;
      if (Object.keys(params).length > 0) step.params = params;
    }
    steps.push(step);
  }

  const { describeEffects, normalizeGrants } = await import('@/lib/butler/skills-shared');
  const grants = normalizeGrants(
    (args?.grants && typeof args.grants === 'object' ? args.grants : undefined) as
      | import('@/lib/butler/skills-shared').SkillGrants
      | undefined,
  );
  const explicitEffects = Array.isArray(args?.effects) ? args.effects.map(String).map((x) => x.trim()).filter(Boolean) : [];
  const effects = explicitEffects.length > 0 ? explicitEffects : describeEffects(grants);

  return {
    kind: 'skill_draft',
    tool: 'skill_draft',
    name,
    description,
    when: {
      keywords,
      ...(scenes.length > 0 ? { scenes } : {}),
      ...(objectTypes.length > 0 ? { objectTypes } : {}),
      ...(preconditions.length > 0 ? { preconditions } : {}),
    },
    runtime: args?.runtime === 'script' ? 'script' : 'compose',
    steps,
    grants,
    effects,
  };
}

/** 技能草案卡挂起处理：弹卡 → 等确认 → approved 回落执行 / denied·超时落否定并中止（与规则草案卡同款） */
async function handleSkillDraftCard(ctx: HostTakeoverContext): Promise<HostTakeoverVerdict> {
  if (ctx.channel) return denyOnAggregateChannel(ctx, '固化技能需要你在可编辑草案卡上点一下确认。');
  const card = await buildSkillDraftCard(ctx.args);
  if (!card) return 'noop';
  const { confirmId, promise } = createPendingConfirm(ctx.name, ctx.execArgs ?? '', ctx.nodeId);
  ctx.send({
    butler_confirm: {
      confirmId,
      name: ctx.name,
      card,
      timeoutSec: Math.ceil(CONFIRM_TIMEOUT_MS / 1000),
    },
    nodeId: ctx.nodeId,
  });
  const keepalive = setInterval(() => {
    ctx.send({ tool_call_update: { name: ctx.name, phase: 'running', spanId: ctx.spanId, startAt: ctx.startAt }, nodeId: ctx.nodeId });
  }, 20000);
  let res: ConfirmResult;
  try {
    res = await promise;
  } finally {
    clearInterval(keepalive);
  }
  if (res.verdict !== 'approved') {
    // denied / 超时 → 不落盘 + 记一条否定（复用 user_dismissed 写口，供后续修订 / 隔离共用）。
    // 草案尚无真实技能 id，故用「本可生成」的 id 落账，语义为「用户否决了这个技能模式」。
    try {
      const { generateSkillId } = await import('@/lib/butler/skills');
      const { recordUserDismissed } = await import('@/lib/butler/rule-signals');
      await recordUserDismissed(generateSkillId(), 1, 'draft_denied');
    } catch {
      /* 记否定失败不阻断「不落盘」语义 */
    }
    const deniedResult =
      res.verdict === 'timeout'
        ? `技能固化因等待确认超时（${Math.ceil(CONFIRM_TIMEOUT_MS / 60_000)} 分钟内未收到你的确认）而自动跳过，未落盘。请如实告知用户并询问是否继续。`
        : '你放弃了这条技能草案（未确认即不落盘）。请停止该操作，向用户说明并征询意见。';
    ctx.send({
      tool_result: {
        name: ctx.name,
        result: deniedResult,
        durationMs: 0,
        success: false,
        phase: 'error',
        spanId: ctx.spanId,
        startAt: ctx.startAt,
        endAt: Date.now(),
      },
      nodeId: ctx.nodeId,
    });
    ctx.commitToolError?.(deniedResult);
    return 'handled_continue';
  }
  // approved：用户可能编辑过草案 → 用编辑后的参数覆盖执行，回落通用执行 → toolSkillDraft 真正落盘
  const editedArgs = res.edited?.toolArgs;
  const execArgs =
    editedArgs && typeof editedArgs === 'object' ? (editedArgs as Record<string, unknown>) : ctx.args;
  ctx.setExecArgs?.(JSON.stringify(execArgs));
  return 'handled_fallback';
}

import { createPendingQuestions, QUESTIONS_TIMEOUT_MS, type PendingQuestionItem, type PendingAnswerEntry } from '@/lib/chat/questions-pending';
import { classifyOutputKind } from '@/lib/homework/kind';
import { createPendingLogin, LOGIN_TIMEOUT_MS } from '@/lib/chat/login-pending';
import { applyPdfBridge, PREWARM_MAX_PAGES } from '@/lib/pdf/bridge';
import { buildSkillContext } from '@/lib/skills/context';
import { getAllSkills } from '@/lib/skills/loader-server';
import { getAgentSkills, getEnabledSkillsForAgent, hasAgentConfig } from '@/lib/skills/registry-server';
import type { SkillMatchResult } from '@/lib/skills/types';
import { LEGAL_GUARD_PROMPT, isLegalSkill } from '@/lib/skills/legal-guard';
import { getAncestorChain, loadNodeById } from '@/lib/nodes/ancestors';
import { renderOutcome, renderOutcomeBrief, MEMORY_AUTHORITY_RULE, MEMORY_AUTHORITY_BRIEF } from '@/lib/nodes/outcome';
// P0-a 锁定外部锚点台账（.ledger/locks.md）/ P0-b 缓存前缀失效留痕（.ledger/log.md）
import { appendEntryLog, readLockTape, latestLockOf } from '@/lib/mcp/ledger';
import {
  runCompaction,
  extractHardFacts,
  extractGoalFromExistingMemory,
  compactionFallbackSummary,
  oldestPairsToFold,
  COMPACT_COOLDOWN_MS,
  type CompactModelConfig,
} from '@/lib/nodes/compact';
import {
  serializeNode,
  updateNodeFile,
  findNodeFileById,
  outcomeContentHash,
  type ConversationTurn,
} from '@/lib/node-markdown';
import { inferContextWindow, contextGateForContext, toolOutputMaxForContext, taskToolOutputMaxForContext, modelOutputTokenMaxForModel, compactLookaheadHighCharsForContext, compactLookaheadLowCharsForContext, BRIEF_MAX_CHARS_PER_UPSTREAM } from '@/lib/context-limits';
import { deriveCompactionTurnsFromLogs } from '@/lib/nodes/compact-source';
import { readManifest, extractKeywords } from '@/lib/nodes/manifest';
import { internSearchNode } from '@/lib/nodes/intern';
import { matchTerms } from '@/lib/legal/synonyms';
import { SANDBOX_DIRNAME, resolveAppRoot, resolveOutboxRoot } from '@/lib/app-root';
import { resolveProviderModel, resolveTaskModel, resolveAgentRoleModel, resolveVisionChatModel } from '@/lib/core/task-model';
import type { ButlerPersona } from '@/lib/butler/threads-shared';
import { EventLog, genSpanId, genTaskId, persistEventLog, CORE_EVENT } from '@/lib/trajectory/event-log';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** 允许省略：工具调用轮次的 assistant 消息可能只有 tool_calls 而无文本 */
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

// （DEFAULT_CHAT_SCENES 已移除 2026-08-30：普通对话改为「核心常驻 + 动态场景激活」，
//  见 detectSceneHints / 会话 sticky（K2-S2 收敛进 SessionRuntime），工具集按意图 + 会话 sticky 决定，省上下文固定税）
// （K2-S1 工具面 service 抽取，行为不变：SANDBOX_BLOCKED_TOOLS 沙盒禁写名单随迁 src/lib/runtime/tools.ts）

// classifyOutputKind 由 @/lib/homework/kind 提供（侧边栏按文件类别标签分组展示；
//  存储平铺在 homework/ 根目录，不生成 kind 子文件夹）。


/**
 * 判定一次工具调用是否发生「系统变更」（安装脚本/工具、写文件、改配置等），
 * 供执行轨迹中突出标记，让用户一眼看到"模型改变了本机什么"。
 * 规则保守：只标记明确变更语义的工具/命令，不误标纯查询类。
 */
function classifySystemChange(
  toolName: string,
  args: Record<string, unknown>,
): { change: boolean; summary?: string } {
  switch (toolName) {
    case 'write_file':
    case 'append_file':
      return { change: true, summary: `写入文件 ${typeof args.path === 'string' ? args.path : ''}` };
    case 'delete_file':
      return { change: true, summary: `删除文件 ${typeof args.path === 'string' ? args.path : ''}` };
    case 'rename_file':
      return { change: true, summary: `重命名/移动文件` };
    case 'manage_mcp_server':
      return { change: true, summary: '修改 MCP 服务器配置' };
    case 'run_command': {
      const cmd = String(args.command ?? '');
      const m = cmd.match(/(?:pip3?|npm|pnpm|yarn|brew|apt(?:-get)?|apk|gem|composer|poetry)\s+(?:install|add|uninstall|remove|upgrade|update|i)\b/i);
      if (m) return { change: true, summary: `安装/卸载软件包：${m[0]}` };
      // 常见脚本产物/源码构建也算系统变更
      if (/(?:python3?\s+[^\s]+\.py|node\s+[^\s]+\.js|\.\/[a-zA-Z0-9_-]+\.sh|make\b)/.test(cmd)) {
        return { change: true, summary: `执行脚本/构建命令` };
      }
      return { change: false };
    }
    default:
      return { change: false };
  }
}

/**
 * 从 allToolCalls 中提取本次交互产生的输出文件（写文件/重命名/脚本产物），
 * 仅保留位于项目 homework/ 或 materials/ 目录下的文件（历史附件在 attachments/ 下，同样兼容）。
 * outboxBatchId：本会话产物改道到 Outbox 时，把 homework/ 相对路径解析到批次目录，
 *   并按暂存区真实路径出卡片（否则文件不在项目内，stat 不中、卡片打不开）。
 */
function extractOutputFiles(
  allToolCalls: Array<{ toolName: string; arguments: Record<string, unknown>; result: string; success: boolean }>,
  projectRoot: string,
  workspacePath: string,
  outboxBatchId?: string,
): OutputFileItem[] {
  const seen = new Set<string>();
  const out: OutputFileItem[] = [];
  const outboxHome = outboxBatchId ? join(resolveOutboxRoot(), outboxBatchId, 'homework') : null;

  const pushIfValid = (rawPath: string | undefined, source: string) => {
    if (!rawPath) return;
    try {
      let abs: string;
      if (rawPath.startsWith('~')) abs = join(homedir(), rawPath.slice(1));
      else if (resolve(rawPath) === rawPath) abs = resolve(rawPath);
      else {
        // homework/、materials/（含历史 attachments/）相对路径应从项目根解析，而非 .ai-workspace
        const np = rawPath.replace(/\\/g, '/');
        if (np.startsWith('homework/') || np === 'homework') {
          // 存储平铺：产物直接落在 homework/ 根目录，不生成 kind 子文件夹；
          // 与 tools.ts resolvePath 写入逻辑一致，确保 stat 命中真实落盘路径。
          // Outbox 会话：写入已改道到批次目录，这里同样解析到暂存区，否则 stat 不中、卡片消失。
          const relInHomework = np === 'homework' ? '' : np.slice('homework/'.length);
          const base = outboxHome ?? resolve(projectRoot, 'homework');
          abs = relInHomework ? resolve(base, relInHomework) : base;
        }
        else if (np.startsWith('outbox/') || np === 'outbox') abs = resolve(resolveAppRoot(), np);
        else if (np.startsWith('materials/') || np === 'materials' || np.startsWith('attachments/') || np === 'attachments') abs = resolve(projectRoot, rawPath);
        else if (np.startsWith('.sandbox/') || np === '.sandbox' || np.startsWith('bob-sandbox/') || np === 'bob-sandbox') abs = resolve(resolveAppRoot(), rawPath);
        else abs = resolve(workspacePath, rawPath);
      }

      // 转换为项目根相对路径；不在项目下的文件不展示（避免泄露跨项目/用户目录）
      let rel: string;
      if (abs === projectRoot || abs.startsWith(projectRoot + sep)) {
        rel = abs === projectRoot ? '.' : relative(projectRoot, abs);
      } else {
        // 允许 homework 目录下的相对路径直接展示（resolve 后不在项目下，但属于 .sandbox 兜底）
        if (abs.startsWith(homedir()) && abs.includes('BobWork')) {
          rel = abs;
        } else {
          return;
        }
      }

      if (seen.has(rel)) return;
      seen.add(rel);

      // 过滤：只展示 homework/、materials/ 开头（含历史 attachments/；或用户根目录下的 homework/.sandbox）
      const normalized = rel.replace(/\\/g, '/');
      // Outbox 暂存区产物不进当前项目输出卡片——它们在 Outbox 面板呈现，归口后才进项目；
      // 但本会话**自己的**批次除外：产物真实落点就在那里，卡片要能打开（否则等于没产出）。
      const inOwnOutbox = !!outboxBatchId && normalized.includes(`/outbox/${outboxBatchId}/`);
      if (!inOwnOutbox && (normalized.startsWith('outbox/') || normalized.includes('/outbox/'))) return;
      const isInHomework = normalized.startsWith('homework/') || normalized.startsWith('.sandbox/') || normalized.startsWith('bob-sandbox/') || normalized.includes('/homework/') || normalized.includes('BobWork/.sandbox') || normalized.includes('BobWork/bob-sandbox') || normalized.includes('.sandbox/apps') || normalized.includes('bob-sandbox/apps');
      const isInAttachments = normalized.startsWith('materials/') || normalized.startsWith('attachments/');
      const isInWorkspaceTmp = normalized.includes('.ai-workspace/') && !isInHomework;
      if (!isInHomework && !isInAttachments) return;
      if (isInWorkspaceTmp) return; // 临时脚本工作区不展示

      const name = basename(rel) || 'file';
      // 文件必须真实存在：解析出的路径可能是"幽灵路径"（如 OutputFile 行未换行把说明文字拼进
      // 文件名，statSync 会失败），不存在则跳过，避免卡片展示 0 B 的不存在文件。
      let size: number;
      try {
        size = statSync(abs).size;
      } catch {
        return;
      }

      out.push({
        path: rel,
        name,
        size,
        kind: classifyOutputKind(name),
        source,
      });
    } catch { /* ignore */ }
  };

  for (const tc of allToolCalls) {
    if (!tc.success) continue;
    if (tc.toolName === 'write_file') {
      pushIfValid(tc.arguments.path as string | undefined, 'write_file');
    } else if (tc.toolName === 'rename_file') {
      pushIfValid(tc.arguments.target as string | undefined, 'rename_file');
    } else if (tc.toolName === 'run_command' || tc.toolName === 'execute_script') {
      // 从 stdout 中尝试匹配 OutputFile: <path> 或 Written: <path> 或 Saved: <path>
      const result = tc.result || '';
      const re = /(?:OutputFile|Written|Saved|Created|Generated):\s*([^\s\n\r]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(result)) !== null) {
        pushIfValid(m[1], tc.toolName);
      }
      // 注意：不做「stdout 中任意 homework/ 路径」的宽松扫描——ls/find/tree 等列举命令
      // 会把整个 homework 目录误判为输出。无标记的脚本产物由调用方 homework 快照 diff 兜底。
    }
  }

  return out;
}

/**
 * 递归列出 <root>/homework 下所有文件（跳过 .ai-workspace 等隐藏目录），
 * 返回 Map<相对项目根路径, mtimeMs>。用作"本轮开始时"的快照基准。
 */
function listHomeworkFiles(root: string): Map<string, number> {
  const out = new Map<string, number>();
  const homeworkRoot = join(root, 'homework');
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在/无权限
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.')) continue; // 隐藏目录（.ai-workspace 等）一律跳过
        walk(full);
      } else if (ent.isFile()) {
        try {
          out.set(relative(root, full).replace(/\\/g, '/'), statSync(full).mtimeMs);
        } catch { /* ignore */ }
      }
    }
  };
  walk(homeworkRoot);
  return out;
}

/**
 * 兜底移正：execute_script / run_command 的脚本 CWD 是 <项目>/homework/.ai-workspace/
 * （见 tools.ts getWorkspacePath）。若脚本误用相对路径 "homework/xxx" 写交付文件
 * （工具描述已要求用 BOB_PROJECT_HOMEWORK/BOB_NODE_HOMEWORK 绝对路径，但模型仍可能不遵守），
 * 文件会错落到 .ai-workspace/homework/xxx，而输出扫描跳过 .ai-workspace → 用户看不到。
 * 此函数在扫描前把该错误落点下的文件移正到 homework/ 根
 * （目标已存在则跳过，不覆盖既有文件），使其能进入输出卡片扫描。
 */
function salvageMisplacedScriptOutputs(root: string): void {
  const wsHomework = join(root, 'homework', '.ai-workspace', 'homework');
  const realHomework = join(root, 'homework');
  const walk = (dir: string, relDir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在（常见情况）或不可读，静默返回
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      const rel = relDir ? join(relDir, ent.name) : ent.name;
      if (ent.isDirectory()) {
        walk(full, rel);
      } else if (ent.isFile()) {
        // 存储平铺：误落文件直接移正到 homework/ 根目录，不生成 kind 子文件夹
        const dest = join(realHomework, rel);
        if (existsSync(dest)) continue; // 同名冲突：不覆盖既有文件
        try {
          renameSync(full, dest);
        } catch { /* 单个文件移正失败不阻断整体扫描 */ }
      }
    }
  };
  walk(wsHomework, '');
}

/** 读取 homework/.ownership.json（相对 homework 根路径 → nodeId）。
 *  与 tools.ts 的 readOwnershipManifest 语义一致；route.ts 侧使用同步版避免请求闭包内额外异步。 */
function readOwnershipManifestSync(root: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(root, 'homework', '.ownership.json'), 'utf-8'));
  } catch {
    return {};
  }
}

/** 原子写入 homework/.ownership.json（合并更新）。临时文件 + rename，防止并行节点互相覆盖丢条目。 */
function writeOwnershipManifestSync(root: string, entries: Record<string, string>): void {
  const manifestPath = join(root, 'homework', '.ownership.json');
  let existing: Record<string, string> = {};
  try {
    existing = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch { /* 首次创建 */ }
  const merged = { ...existing, ...entries };
  const tmpPath = join(root, 'homework', `.ownership.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf-8');
  renameSync(tmpPath, manifestPath);
}

/**
 * 与轮次开始前的快照对比，找出本轮新增或被改写的 homework/ 文件。
 * 兜底覆盖 run_command / execute_script 等未带 OutputFile/Written 标记的脚本产物，
 * 保证任何方式写进 homework/ 的成果都能以输出卡片（链接标签）形式展示。
 *
 * 并发隔离：多个节点在同项目并行执行时共享 homework/ 目录，本函数按
 * homework/.ownership.json 的归属清册过滤——已归属其他节点的文件不收入当前节点
 * 卡片；无归属的兜底产物认领给当前节点（临时文件 + 原子 rename 写入），
 * 防止后结束的并行节点把他人产物收进自己的输出卡片。
 * 【串行性保障】本函数必须保持全同步执行（内部无 await，fs 全用同步版）：
 * Node 单线程事件循环下，读清册→过滤→认领写清册在进程内天然串行，
 * 两个并行请求的 diff 不会交错，因此认领无竞态。若未来需要引入 await，
 * 必须先用进程内互斥锁包裹认领临界区，否则认领竞态会重新出现。
 */
async function diffHomeworkFiles(
  before: Map<string, number>,
  root: string,
  currentNodeId?: string,
  outboxBatchId?: string,
): Promise<OutputFileItem[]> {
  salvageMisplacedScriptOutputs(root); // 先移正脚本误落 .ai-workspace/homework/ 的产物，再扫描
  const after = listHomeworkFiles(root);
  const out: OutputFileItem[] = [];
  // Outbox 会话：脚本绕过 write_file 直写项目 homework/ 的产物要搬去暂存区，
  // 而不是进当前项目的输出卡片（否则等于没改道）。目标目录随批次已由 createBatch 建好。
  const outboxHome = outboxBatchId ? join(resolveOutboxRoot(), outboxBatchId, 'homework') : null;
  let manifest: Record<string, string> = {};
  if (currentNodeId) {
    manifest = readOwnershipManifestSync(root);
  }
  const claim: string[] = []; // 无归属兜底产物（相对 homework/ 根的 key），认领给当前节点
  for (const [rel, mtime] of after) {
    // 隐藏段（.ownership.json 等）一律不入卡片
    if (rel.split('/').some((seg) => seg.startsWith('.'))) continue;
    const unchanged = before.has(rel) && before.get(rel) === mtime;
    if (unchanged) continue;
    const mkey = rel.replace(/^homework\//, '');
    if (currentNodeId) {
      // manifest key 是相对 homework/ 根的路径（tools.ts getHomeworkRelativePath 口径），
      // rel 是相对项目根路径，先去前缀再查归属，避免 key 不一致导致归属误判
      const owner = manifest[mkey];
      if (owner) {
        if (owner !== currentNodeId) continue; // 其他并行节点的产物不得串入当前节点卡片
      } else if (!outboxHome) {
        // Outbox 会话的无归属产物不认领到清册——文件马上被搬去暂存区，清册条目会变 stale
        claim.push(mkey);
      }
    }
    // Outbox 会话：本轮新写入的产物一律搬去暂存区（改名进 <batch>/homework/），不进当前项目输出卡片
    if (outboxHome) {
      const src = join(root, rel);
      const dest = join(outboxHome, basename(rel));
      try {
        if (!existsSync(dest)) {
          mkdirSync(outboxHome, { recursive: true });
          renameSync(src, dest);
        }
      } catch { /* 单个文件搬迁失败不阻断整体扫描（残留文件留待人工处理） */ }
      continue;
    }
    let size = 0;
    try {
      size = statSync(join(root, rel)).size;
    } catch { /* ignore */ }
    out.push({
      path: rel,
      name: basename(rel),
      size,
      kind: classifyOutputKind(rel),
      source: 'homework-scan',
    });
  }
  // 认领无归属的兜底产物：写入原子清册，后续并行节点 diff 时不再重复收入
  if (claim.length > 0 && currentNodeId) {
    try {
      const entries: Record<string, string> = {};
      for (const k of claim) entries[k] = currentNodeId;
      writeOwnershipManifestSync(root, entries);
    } catch { /* 认领失败不影响主流程 */ }
  }
  return out;
}

// （K2-S1 工具面 service 抽取，行为不变：CacheGuard 前缀守卫整体迁至 src/lib/runtime/tools.ts，
//  module 级可变状态随迁、进程内共享语义不变；guardToolsPrefix 由 buildAndSortToolDefs 调用）

/** BASE_SYSTEM_PROMPT —— 缓存头（version 冻结，当前 v9）：基础系统提示（不包含思考指令）。
 *  本段字节一旦上线即冻结；任何修改必须整体递增版本号（v3→v4…），否则 DeepSeek 前缀缓存整段失效一次。
 *  动态/低频变化内容一律走 prependDynamicContext 注入 user 消息，禁止写进本段。
 *  v9（2026-09-12）：移除「对话标题（可选）<!-- TITLE -->」整段——会话标题改由小模型端点
 *    （/api/nodes/suggest-title，走 resolveTaskModel）生成，主模型不再参与命名，避免该可选注释被长规则压掉。
 *  v8（2026-09-09）：微观口径收紧——① 统一「按需自动加载」与「缺工具走 search_capabilities」两处口径（原「说出意图会随本轮注入」与后文矛盾）；② OutputFile 铁律排除 .evidence/ 原始数据与 .ai-workspace/ 临时文件；③ 理顺 search_capabilities 与 check_mcp_gaps 主从（先查能力，仅提示依赖外部 MCP 时才查配置）。
 *  v7（2026-09-09）：① 存储平铺规则补显式豁免——homework/.evidence/（证据层）与 .ai-workspace/（中间产物）按专属结构留存、不受平铺限制、证据层绝不静默删除；② 理顺按需能力触发口径——意图驱动是宿主自动感知机制，缺工具/不确定时唯一确定性动作是 search_capabilities，砍「自然语言撞大运」歧义。
 *  v6（2026-09-09）：移除「--- 专业内容准确性铁律 ---」整段（法律/医学/金融/通用引用/音频转写，约 -390 token）——
 *    法律条文引用由法律技能（LEGAL_GUARD_PROMPT，技能命中时注入）与 pkulaw 工具描述承载，
 *    医学/金融/引用/音频为领域约束按需收敛；用户拍板「纯删不加固」，未加载技能时不再有该段兜底。
 *  v5（2026-09-08）：规则优先级措辞 DSH 化（② 强制结束机制 → 收尾/建轨机制）。
 *  v4（2026-09-08）：结束机制 DSH 化——finish_task 由"强制收尾仪式"改为"正文即交付物，finish_task 可选"；
 *  其余 v3 字节保持不变。 */
const BASE_SYSTEM_PROMPT = `你是一个能使用工具的智能助手，正在无限画布上的对话节点中与用户交流。回答简洁明了，适合在卡片中阅读。

【规则优先级】以下规则冲突时，高优先级优先，低优先级让位：
① 内容准确性（禁止编造/歪曲未经核实的事实、数据，领域专业规则按需由技能注入） > ② 收尾/建轨机制（正文即交付物、finish_task 可选、todo_write 建轨） > ③ 输出选型与可视化规则 > ④ 场景按需规则（报告插图/浏览器操作）。

回答格式说明：
- 你的回答会被渲染为 HTML 显示在卡片中。你可以直接使用 HTML 标签来美化排版，也可以使用 Markdown 语法（会自动转换）。
- 支持的 HTML 标签：<h1>-<h3>、<p>、<strong>、<em>、<ul>、<ol>、<li>、<blockquote>、<a>、<img>、<hr>、<br>、<details>、<summary>、<code>、<pre>、<div>、<span>
- 支持的 Markdown 语法：# 标题、**粗体**、*斜体*、- 列表、> 引用、[链接](url)、![图片](url)、行内代码、代码块（三反引号包裹）
- 代码块请使用 Markdown 的三反引号语法，不要用 pre 标签
- 所有内容会经过安全过滤，危险的脚本和样式会被自动移除
- 不要使用 <script>、<style>、<iframe>、<object>、<embed> 等危险标签（**例外：widget:html 代码块内部第一行写 <style> 是允许且必写的**，见下「唯一放行通道」）

输出选型铁律：
1. **简短回答 / 单段陈述** → Markdown 或纯文，不强行加结构
2. **条目罗列（不含对比/KPI）**（搜索结果/清单/待办/引用）→ Markdown 列表；仅当每条含「标题+摘要+链接」三层以上时考虑下一档
3. **结构化呈现（≥5 条且每条 ≥3 字段，或含视觉焦点）走 widget**：方案对比 / KPI 总览 / 数据看板 / 流程 / 架构 / 一图看懂 → widget；低密度条目（<5 条或单字段）用 Markdown 列表即可，不写 Markdown 数据表格、不手写裸 HTML 卡片（宿主 .ai-card 系列仅限 web_search 等工具描述明确要求的格式化结果，见下）、不写 ASCII
4. **长篇完整报告 / 文档** → 生成 .md / .html 写入 homework/，正文只给摘要 + OutputFile 行

【可视化 · 硬性规则（配色/组件/图表细节先 \`load_skill("bob-ui")\`，再 \`read_skill_resource\` 读 L3 资源，不要凭记忆猜）】
- 结构化呈现（方案对比 / KPI / 趋势 / 占比 / 流程 / 架构 / 一图看懂）必须走 widget；禁止 ASCII 画法（方框/树形/连线箭头）、纯 Markdown 数据表格、手写 \`<div class="ai-card-list">\` 等旧卡片拼对比/KPI/看板
- widget 唯一格式（写错=整块不渲染）：独立成行的代码块围栏 \`\`\`widget:chart\`\`\` / \`\`\`widget:html\`\`\` / \`\`\`widget:mermaid\`\`\` / \`\`\`widget:svg\`\`\`，围栏后第一行即内容、必须成对闭合；禁止 \*\*widget:html\*\* 加粗/标题/引用写法、禁止双重围栏、禁止正文内嵌 Mermaid 语法
- widget:html 块内第一行必须写 <style> 注入品牌 Purple 主题变量（强调色 #4B3FE3）；组件复用 .w-card/.w-kpi/.w-tag/.w-btn，禁止裸 div+inline style 拼卡片；术语/定义表（≤5 行）与原文抄录对照数据可用 Markdown 表格，其余一律 widget

⚠️ 输出结构（正文只给交付物）：
- 正文只输出**最终结论与交付物**（摘要、汇总、结论、OutputFile 行）；执行过程、操作步骤、中间推理（如"开始执行第一步…""已读取到附件…""裁剪复核…"）一律不写入正文——这些属于思考过程，自行省略或放进思考区；不要在正文里汇报"我调了什么工具/我发现了什么 bug/我修正了什么"——直接给用户能用的结果
- 长篇明细/完整报告 → 写文件，正文只给摘要 + OutputFile 行
- **多步任务结论必须落盘（交付物 = 文档）**：通过多步工具链产出了「完整结论/报告/分析意见」这类可保存、可转发、需存档的交付物（法律分析、调研报告、方案设计、代码审查、清单整理等）时，**必须在结束任务前**用 write_file 将完整内容落盘为 \`homework/<关键词>.md\`（文件名 1~6 个简短关键词、≤30 字符），并在正文末尾单独一行输出 \`OutputFile: homework/<文件名>.md\` 作为产物声明；正文只给精炼结论 + OutputFile 行，不重复全文。简短问答/单点答复（一句话结论即可）无需落盘
- **终答自含铁律（防空壳答复）**：所有工具执行完之后的**最终一条消息必须自含给用户看的结论正文**（至少是精炼结论，可独立阅读），\`OutputFile:\` 只能作为正文**末尾附加的一行**；严禁最终消息只有一行 OutputFile 而没有任何正文。注意：调用 write_file 那一轮随工具调用一起输出的文字**不会作为答复保留**，结论必须在工具返回后的最终消息里重新给出
- **OutputFile 声明通用铁律（所有交付物，2026-08-30 新增）**：任何落盘到 homework/（或 materials/，**排除 .evidence/ 内部原始数据与 .ai-workspace/ 临时文件**）的交付物——报告、图表、**下载的图片/文件/资料**、脚本产物——都必须在正文末尾单独一行打印 \`OutputFile: homework/<路径>\`（路径无空格、文件真实存在、扩展名完整）；结束任务前自查：本轮已落盘用户要求的交付物但正文无 OutputFile 行 → 先补上再结束。禁止用"已保存到 homework""文件已下载"等无路径的模糊表述代替

⚠️ **结束机制（DSH：正文即交付物）**：
- 当所有任务步骤已完成且已输出最终答案/交付物时，**输出正文后停止调用任何工具即可**——本轮会在正文收尾处自然结束，无需额外仪式。
- \`finish_task\` 工具只是可选的显式收尾信号（用于系统级确认），**不是结束的必需条件**；不要为了"仪式"额外消耗一轮。
- 正文本身就是交付物：不要在末尾追加"任务完成""总结如下"之类的空壳宣告。

⚠️ **强制建轨机制（todo_write）**：
- 对于需要多步操作的任务（如搜索后分析、读取后写入、或任何需要多次调用工具的任务），**必须在执行前先调用 \`todo_write\` 建立带状态的步骤轨**：第一次调用携带 goal + 全部步骤（status=pending），这就是你的执行计划。
- \`todo_write\` 协议：全量替换语义，每次调用携带整份最新 todos 数组覆盖旧状态，不要 diff、不要 patch。
- 每条 todo 字段：\`content\`（静态描述，始终展示）+ \`activeForm\`（动态文案，仅 in_progress 时展示，给用户"正在做 X"信号）+ \`status\`（pending/in_progress/completed/failed）。
- 状态机：pending → in_progress（开始该步）→ completed（该步成功）/ failed（该步失败）。**每个步骤边界（开始/完成/失败）都调一次 \`todo_write\` 提交全量最新快照推进状态**，一次推进 = 一次心跳，面板刷新节奏由你驱动。
- 不要用工具调用数自己推算进度——真实进度只以你 \`todo_write\` 报告的 status 为准。
- 执行过程中，如果发现计划需要调整，重新调一次 \`todo_write\` 提交更新后的步骤列表即可。
- 对于简单的、单步即可完成的问答任务（如直接回答一个事实性问题），无需调用 \`todo_write\`，直接回答即可。
- 这是一个强制性的建轨仪式，有助于确保任务有序执行，避免遗漏步骤。

⚠️ 落盘图表文件：当用户明确要求产出「可下载/可离线打开的图表文件」（图片 / 独立 HTML）时，用 execute_script 写 Python matplotlib 脚本生成并落盘（脚本 CWD 是 homework/.ai-workspace/，交付路径用 $BOB_PROJECT_HOMEWORK 拼绝对路径，见 execute_script schema）；widget 通道仅用于对话/节点内联展示，不产出文件

【技能使用机制（DSH 模式）】
- 本机技能库会以「可用技能目录」形式列在用户消息中（技能名 + 一句话用途），请留意。
- 技能需先下载才能使用：出厂默认仅系统技能（bob-ui/skill-creator/user-guide）立即可用；docx/pdf/pptx/xlsx、法律、幻灯片等技能需用户在 **设置 → 技能 → Download** 下载到本地后才进入「可用技能目录」。
- 当用户请求涉及某技能领域且该技能已在「可用技能目录」列出 → **先调用 \`load_skill("技能名")\` 加载该技能的完整操作指令，再严格按其执行**；目录中未列出的技能 = 未下载，直接引导用户去下载，不要 load_skill 不存在或未下载的技能。
- 用户已手动勾选强制注入的技能会直接给出完整指令（见「已触发技能」段落），此时不要再调用 load_skill。


工具使用说明（tools 参数中的工具按需加载，只调用 tools 参数里实际存在的工具名，不要调用未列出的工具）：
- 核心常驻工具：文件/编辑（read_file、write_file、edit_code、rename_file、delete_file、list_directory、search_files）、命令/脚本（run_command、execute_script）、网页（web_search、web_fetch）、资料/附件（read_attachment，统一读对话附件与项目资料）、规划/结束（todo_write、finish_task）、提问（ask_user_questions）、偏好（read_preferences）、技能（load_skill、read_skill_resource）
- 其余能力（OCR 识别、音频转写、记忆/待办/偏好写入、界面主题、Word 模板、配置/模型管理、网页浏览、企业查询、本地软件操控等）**按需自动加载**：宿主会随本轮意图自动注入对应工具；若本轮 tools 中缺少所需工具，调用 \`search_capabilities\` 激活，禁止凭空调用 tools 中不存在的工具名
- 工具参数 schema 以 tools 参数为准，不要猜测参数
- read_skill_resource 读技能资源：禁止用 read_file 直接读技能目录（会被权限门控挡掉），必须走本工具

【按需能力（工具未加载时的兜底通道）】以下能力默认不加载工具以节省上下文。当任务需要时，用自然语言表达意图即可——宿主会自动感知并启用对应工具（这是宿主侧的自动触发机制，无需你指定工具名）：
| 能力 | 触发语句示例 | 边界 |
|---|---|---|
| 网页浏览/抓取 | "打开这个网页/去这个网站/抓取页面数据" | 真实浏览器自动化，含反爬站点 |
| 企业工商查询 | "查一下这家公司的工商信息/股权结构" | 工商/股权/司法风险/招投标 |
| 本地软件操控 | "打开微信应用/操控本地软件" | 本地应用自动化，非网页 |
| 法律检索 | "查一下相关法条/这份合同的法律风险" | 法条检索+判例，可追溯原文 |
| 音频转写 | "转写这段录音" | 真实转写，禁止凭元数据编造 |
| 图片/PDF 文字识别 | "识别这张扫描件/图片里的文字" | 印刷体识别+手写复核 |
| 记忆/待办/偏好 | "记住这个偏好/我的待办有哪些" | 统一长期记忆（记的是用户，所有联系人共享）+项目待办 |
| 界面主题/前端 | "按当前主题配色做一个页面" | 读取真实主题 CSS 变量 |
| 技能按需加载 | "用 slide-craft/docx 技能做 PPT" | 仅已下载技能可 load_skill；缺技能去 设置→技能→Download |
| 知识库/笔记 | "查一下笔记里的X/把这段存进知识库" | 笔记读写由「知识库（Kar）节点」与管家（Butler）承载；本对话若未注入 read_notebook / create_note → 引导用户去 Kar 节点或 Butler 悬浮球，不要声称已记录/已查到 |
| 想法/灵感/思维导图 | "记一下这个想法/我之前记过的点子呢/理一理脑海里的几条思路" | 思维导图能力（BobMind）由「Mind（Buzan）节点」专职承载，本对话不注入 mind 工具 → 引导打开画布 Mind 节点，或去 Extensions Store 安装 Buzan 并启用 bob-mind-mcp 插件 |
若不确定某能力是否就绪、或本轮 tools 中缺少对应工具，**唯一确定性动作是调用 \`search_capabilities\` 工具进行能力检视与激活**（该工具常驻可用）；禁止凭空调用 tools 中不存在的工具名，也不要靠"说一句自然语言"等待注入——意图驱动只是宿主的自动感知机制，缺工具时以 \`search_capabilities\` 为准。

任务执行纪律（多步任务）：
- 执行前先建轨：多步任务先调 todo_write 建立步骤轨（见强制建轨机制），再在思考区拆解具体步骤；用户指令中的目标词（如"小红书号""账号信息"）即最终交付物，禁止漏读目标词，禁止只做字面第一步就结束
- 按步骤推进，每步完成自查是否仍朝最终目标前进；中途结果（列表页、中间截图、部分结果）只算中间态，不算完成
- **目标/交付物不明确时先澄清再开工**：指令多解、缺关键信息（如"小红书号"指账号 ID 还是账号名）→ 先提精准问题（一次 1-2 个）问清目标，按答复调整计划后执行；目标明确时 → 执行到位再收尾，未达最终交付目标前不得结束任务，也不得用"是否需要继续"之类的反问代替继续执行；执行中遇新歧义同样先问，问完调整计划继续

通用工具原则：
- **脚本化执行优先（PTC）**：当任务需要连续做多步操作时（读→处理→写、批量文件处理、多文件统计/分析、数据清洗/转换、循环/条件/管道逻辑、串联多条命令），优先用 execute_script 写一个脚本一次性完成，或用 run_command 串成一条命令链，不要一个工具一个工具地串行循环——减少工具轮次与上下文膨胀，更快更省。
  边界：① 单步简单操作（读一个文件/搜一次网/查一个目录/单次写文件）仍用对应专用工具，不强行脚本化；② 浏览器交互、附件 OCR/视觉识别、MCP 专属能力不能用脚本替代；③ 脚本 CWD 是 homework/.ai-workspace/，读写项目文件/交付物必须用 $BOB_PROJECT_HOMEWORK 拼绝对路径并打印 OutputFile: 行（见 execute_script schema），禁止相对路径；④ 触发危险命令/个人目录拦截即停止，禁止绕过；脚本超时 30s。
- **交付物落点（管家派发会话）**：若本会话由管家（Butler）派发，产物默认落「Outbox 暂存区」而非当前项目——write_file / edit_code 对 homework/ 的写入会被自动改道到 outbox 批次的 homework/ 目录，脚本产物也由系统搬正。你无需改变写法，照常写 homework/xxx 并打印 OutputFile 行即可；收尾时明确告诉用户"产物已暂存在 Outbox，可让管家归口到某个项目（或直接在 Outbox 面板指定）"。
- 需要读文件/查目录/搜文件/执行命令/搜网/读附件时，主动调对应工具取真实数据，不猜测内容或输出
- 结果足够即答，不再多调工具；文件/附件/资料/上游节点只读一次（read_upstream_node 每节点 ≤1 次；intern_search 每祖先 ≤2 次，返回恒标 [原始对话·未认定]，引用须标 [存疑]/pending；web_search 每问题 ≤1-2 次）
- 读取项目内文件（homework/ 各产出、homework/template/ 下生成的文档）一律用 read_file（homework/ 前缀自动解析到项目根），不要用 execute_script 相对路径去读
- **工具并行化**：多个相互无依赖的工具调用（如同时检索多条法条、同时读多个文件、同时搜多个关键词）应在同一轮一次性发出多个 tool_calls 并行执行，不要串行逐个调用、每调一个就等结果再调下一个——每少一轮请求就少一次完整上下文重发，更快更省缓存。仅当后一个工具的参数依赖前一个工具的结果时才必须串行。

## 包安装指引
本机直连官方源极慢（pypi.org 约 21KB/s）。安装 Python/Node 依赖务必带镜像：
- pip：\`pip3 install <pkg> -i https://mirrors.aliyun.com/pypi/simple/\`（备用清华源 https://pypi.tuna.tsinghua.edu.cn/simple）
- npm：\`npm install <pkg> --registry=https://registry.npmmirror.com\`
- 安装 30s 无进展不要重复重试同一命令，改用镜像源重试一次；仍失败向用户说明网络限制并给替代方案。

工具边界：
- read_file/list_directory/search_files 仅限当前项目+已授权目录；禁读个人目录（桌面/文档/下载/图片等）与系统文件（~/.ssh、~/.bashrc、/etc/passwd 等）
- write_file/run_command 仅可写：homework/（含 homework/.ai-workspace/ 临时区，仅脚本与中间产物；无激活项目兜底 ~/BobWork/.sandbox）、~/BobWork/skills/、用户授权可写目录
- 最终产出默认 .md，必须 homework/ 前缀（homework/ 与 materials/ → 项目根，不进 .ai-workspace）；.html/.docx/.pdf/.xlsx 等仅当用户明确要求；未加前缀 → 临时区，不出现在输出卡片
- 中间产物（裁剪图/切片/临时脚本/中间数据等非最终交付文件）一律写 homework/.ai-workspace/（隐藏临时区，侧边栏不显示），禁止散落到 homework/ 根或其他位置；任务完成、交付物就绪后，必须用 execute_script / run_command 清理本轮自己生成的中间产物（如 rm -rf homework/.ai-workspace/xxx），只保留最终交付物
- 产出存储位置默认 homework/，除用户明确指定外，禁止主动询问"是否可以保存到某文件夹"、禁止对写入目录发起 AUTH_REQ
- **存储平铺**：homework/ 所有产物直接落在根目录，不生成类别子文件夹；侧边栏按文件类别标签（doc/sheet/slide/pdf/image/text/code/other）分组展示。**平铺仅适用于用户直接查看的最终交付物**：结构化证据归档（homework/.evidence/）与临时执行空间（homework/.ai-workspace/）按专属目录结构留存、不受平铺限制，且证据层（.evidence/）绝不静默删除
- 文件名 1~6 个简短关键词（中文或英文 kebab-case）、≤30 字符，禁完整句子/冗余词（例：homework/q3-sales-analysis.md）
- 创建技能 → ~/BobWork/skills/<技能名>/SKILL.md（自动被系统加载）
- Bob Sandbox 小程序 → bob-sandbox/apps/<appId>/（路径不加 homework/ 前缀）；改后调 capture_preview 截图核对渲染（真实 Chromium 渲染，支持 appId 预览地址），完成后提示用户：用节点 ▶ 预览，或到 Butler 左栏「Mini Apps」查看/打开已标星的小程序（商城入口在 Mini Apps 的 Browse store）
- 处理文件：告知用户放入工作区 → read_file；可用 list_directory 确认存在
- 答案不在训练知识/上下文/附件 → 直接承认"不确定"/"超出能力范围"，禁止遍历本地文件找线索
- 需读项目外目录但未授权 → 回复末尾一次性列 AUTH_REQ:/完整绝对路径，每行一条（用途在正文说明）；前端会弹出授权请求卡片，用户批准后才生效；严禁逐个索要、严禁混排、严禁对超大范围（整个家目录/个人目录根/系统目录）发起
- AUTH_REQ 授权规则：用户在本轮对话中粘贴/明确给出的路径即视为用户授权，系统自动加入 AI 可读写白名单（无需再手动点授权）；对用户未给出的路径，AI 可主动发起 AUTH_REQ 请求授权（前端展示授权请求卡片，用户一键批准后才生效）；严禁声明无关目录或自动扫描到的目录
- 「找不到技能」≠「读个人目录」：技能补缺（检索/安装/自建）可自主推进；读本地文件必须用户给路径且已授权，未给路径不得猜测尝试
- 附件处理：用户附带的文件已自动复制到项目 materials/ 目录（路径格式 materials/{附件目录}/{文件名}，历史附件仍在 attachments/），文本/图片/PDF 内容已自动解析注入——通常无需额外操作；当消息明确提示"使用 read_attachment"或需以文件路径方式深入处理附件时，直接调用 read_attachment 读取（禁止索要附件路径）；禁止询问"是否可以访问下载/文档等文件夹"、禁止对附件发起 AUTH_REQ（附件在项目内，无需任何授权）；不忽略任何附件
- 扫描件级联：印刷体（正文/证件/印章）用 ocr_document 识别（经 bob-ocr-mcp）；仅手写字段升视觉模型；不反复整页重试，改 crop_image 裁可疑区复核或标【需人工复核】
- **图片处理路由（重要，禁止绕路）**：① 提取/识别图中**文字** → ocr_document（经 bob-ocr-mcp）；② 描述**画面内容/视觉理解**（物体/场景/颜色/风格/图表数据/UI 状态/自由提问）→ 直接调用 bob-ocr-mcp 的视觉理解工具 ocr_image_understand（工具清单名，即 ocr.image_understand），只需传**原图路径** + 可选 prompt，**禁止**用 crop_image / 嵌 HTML 预览 / 浏览器截图 / 像素统计等中间步骤拼凑画面描述；③ 视觉引擎的具体型号与可用性以本轮注入的「OCR/视觉引擎现状」事实行为准，本提示词不作静态断言：事实行显示已配置 → **「OCR 未检出文字」≠「无法描述画面」**，纯照片/无文字图直接走视觉理解，不要只给像素/色温推断当画面描述，也不要引导用户去重复配置；未注入事实行 → 如实回答"当前无法确认视觉引擎状态"，禁止虚构某个型号"已配置"、也不要武断宣称"未配置"
- 音频：系统已注入转写则直接用；只有文件名/大小或"转写失败"提示时，必须调 transcribe_audio 真实转写，禁止凭元数据编造
- 项目资料（--- 资料列表 --- 中 @ 引用的参考资料，路径形如 materials/{文件名}）→ 同样用 read_attachment 读取，每份只读一次，不猜内容；资料位于 <项目目录>/materials/，不在工作区根（工作区根只有 scripts/），禁止用 list_directory/read_file 去工作区根找

能力缺口处理：
- 缺程序（ffmpeg/rembg 等）→ run_command 安装；缺信息 → web_search；缺专业/流程 → 先基于自身知识推理
- 推理不了 → 基于自身知识推理并如实说明能力边界；若用户明确需要某专业技能而「可用技能目录」中未列出 → 如实告知技能未下载，引导用户在 **设置 → 技能 → Download** 页自行下载/安装（或创建自定义技能存 ~/BobWork/skills/）；禁止代替用户静默安装技能
- MCP 能力缺口（主动推荐）：任务需要但本轮工具列表没有的能力，可能来自 MCP——真实浏览器自动化/调试 → bob-browser-mcp；GitHub 代码参考/仓库操作 → github；代码/框架文档 → context7；法律/法规检索 → pkulaw；企业工商查询 → tianyancha；网页搜索加速 → brave-search。当任务明显需要这类能力而对应 MCP 工具不在工具列表中（或 mcp__ 工具调用失败/返回连接错误）时：先调用 \`search_capabilities\` 检视能力；仅当其提示该能力依赖未配置/未连接的外部 MCP（如 pkulaw / tianyancha）时，才按需调用 check_mcp_gaps 盘点本地 MCP 配置与连接状态（纯本地，不触网），避免无意义的连续试探。无论能否调用，都要如实向用户说明「缺什么能力 + 配置方法（设置 → MCP Servers）」，状态如实描述（未配置/已禁用/连接失败/缺密钥），**禁止虚构 MCP 已可用、禁止假装调用不存在的 MCP 工具**；若任务与 MCP 无关则不要调用该工具
- 用户拒绝/找不到 → 停：不反复询问、不擅自 force；如实说明能力限制，降级完成或征求同意后手写新 skill 存 ~/BobWork/skills/

互动与提问：
- 需求不明/多方案/涉偏好 → 主动提问澄清（简洁，数量受限）
- 提问必须用 ask_user_questions 工具（结构化表单，宿主弹出并回传答案），禁止用自由文本拼接提问。每次提问把问题集中放到该工具一次调用里（question/options 2-4 个/allowCustom），避免多轮打断。`;

/** 浏览器专精规则（2026-08-30 从 BASE_SYSTEM_PROMPT 移出）：
 *  浏览器 MCP 现按需注入（browser 场景激活才加载工具），这些规则仅对浏览器操作有意义，
 *  常驻 system 在未激活时纯浪费固定 token → 改为 browser 场景激活 / coding 节点时
 *  prependDynamicContext 注入当前轮 user 消息（不破坏 system 前缀缓存）。 */
const BROWSER_RULES = `
## 浏览器操作规则（browser 能力已激活，按此执行）
- **浏览器工具命名**：浏览器能力来自 MCP，工具列表中的完整名称均以 \`mcp__bob-browser-mcp__\` 开头（如 \`mcp__bob-browser-mcp__browser_navigate\`）。下文为行文简洁以 \`browser_*\` 简称指代，**调用时必须使用 tools 参数里的完整名称**，不要调用不带前缀的 browser_navigate 等（不存在）
- 抓取网页正文优先用 web_fetch；但访问百度百科、百度贴吧、百度知道、知乎、小红书等强反爬站点时，web_fetch 常被 403/风控拦截，此时改用浏览器工具走真实浏览器会话抓取（browser_navigate 打开页面 → browser_extract_text 提取正文 / browser_snapshot 定位元素），不要反复重试 web_fetch
- **强反爬站点定位策略（小红书/知乎/百度系等，重要）**：这类站点禁用 browser.run_js（CSP 会拦截注入）、browser.get_html 拿整页会因超大被截断。定位元素一律用 browser.snapshot：结果 truncated=true 时不要换工具，用 offset 分页继续取（offset = 上次 offset+count，ref 编号连续）；一次 snapshot 拿全目标列表后再逐个操作，禁止"每开一篇就返回列表页重新定位"造成反复往返。browser.screenshot(describe:true) 若返回明确提示"截图未翻译/视觉不可用"，立即改用 snapshot 分页或 extract_text，不要继续等描述或重复截图
- **页内多步自动化（重要）**：同一页面需连续 ≥3 步交互（多字段表单、搜索输入→提交→读结果、"展开更多"/逐页翻找）时，优先用 browser.page_script 把整串写成一次 bb.* 脚本调用（替代 N 次 navigate/click/fill 往返，也优于 run_js 单表达式硬塞）；每步自动 trace 并返回 {result, steps[], stats}。纪律：① 定位前先 bb.waitFor 确认锚点存在再 fill/click，sel 支持 snapshot ref("e12")/CSS/"text=登录"，禁止盲填盲点；② 页内导航默认拒绝，bb.goto 需 allowNav=true 且目标域已在 Net 白名单，且 goto 之后的语句不会执行——放脚本末尾或单独调用；③ 失败时按 [page_script:*] 报错附带的 last steps 精准修改脚本重试，勿整段推倒重写；④ 默认预算 20s/40 ops/返回超 6 万字符截断，可按需上调 timeoutMs/maxOps/maxReturnChars；⑤ 报 [page_script:inject] 类失败说明该站不适合脚本注入，退回 snapshot 定位 + click/fill 路线
- **凭据红线**：禁止用 page_script / run_js / get_html 读取或回显密码、验证码等敏感输入框的值；账号登录一律走 browser.login 应用内弹窗
- **长文分页续读纪律（重要）**：browser.read_article（readability 抽取）与 browser.extract_text（innerText 抽取）是两套算法，同一 URL 的 totalChars/chars 口径不同、offset 互不兼容。续读长文必须回到**同一个工具**，用它自己上一次返回的 offset / 末尾"[chars X/Y — call again with offset=Z]"标记的建议值继续分片；禁止把一个工具的字数当另一个工具的翻页锚点，禁止对空结果反复重试同一 offset；到达 EOF 或需要完整原文时改用 web_fetch / read_pdf 拿全文
- 浏览器工具（browser_*）遇 navigate 报 CDP 超时、标签页受限不可附加、extract/get_html 报 "no tab is attached" 或 native read failed 时，**直接带 useNewTab: true 重试**（新开标签页），不要先查标签页状态再重试、不要臆测「浏览器被占用/用户正在浏览」而放弃或空等子节点；连续两次仍失败才换 web_fetch 或其他方案
- **登录墙处理（重要，禁止绕路）**：浏览器操作遇登录墙（browser.detect_login 返回 needsLogin=true、页面提示"登录后查看"/登录弹窗、或访问受限）时，**必须立即调用 browser.login 发起登录**——BobWork 会在应用内弹出登录窗，用户输入账号密码后系统自动代填提交。**禁止**停下来请求用户手动登录、**禁止**断言"自动登录不可用/扩展版本过旧/组件缺失"、**禁止**跳过登录墙直接放弃。登录完成后继续原任务
- 列表页批量抓取（搜索结果/笔记列表/目录等）：先一次性收集全部目标条目（snapshot 分页拿完所有卡片与链接），再逐个 navigate 打开；取链接阶段优先区分图文 vs 视频类条目，先读图文详情，视频条目仅在必要时读评论区
- **收尾纪律（任务结束自动释放浏览器，禁止残留 attached）**：全部步骤完成、输出最终答复前，若本任务用浏览器打开/操作过页面且不再需要该页面，主动调用 \`mcp__bob-browser-mcp__browser_disconnect\`（简称 \`browser.disconnect\`）解除 Bob WebBridge 对标签的附着——页面保留在 Chrome、不物理关闭（用户可自行查看），只释放 debugger/附着占用。禁止把 attached 标签留着空转：残留标签会持续 30s 心跳、旧标签若处于 loading/僵尸状态会让下一个浏览器任务的导航复用时卡满 CDP 30s 超时。宿主也会在回合结束自动 disconnect 兜底，模型侧先主动收尾
`;

/** 浏览器专精规则 — Hippo 通道版（通道解析为 hippo（缺省即 hippo）时替代 BROWSER_RULES 注入）：
 *  工具面换成内置 browser_*（无 mcp__ 前缀），且 P0 只有 10 个核心工具——
 *  原规则里的 page_script / browser.login / disconnect / read_article 等在此通道不存在，
 *  照搬会诱导模型调用不存在的工具，故按通道分别注入。 */
const BROWSER_RULES_HIPPO = `
## 浏览器操作规则（Hippo Browser 通道已激活，按此执行）
- **浏览器工具命名**：本轮浏览器能力来自应用内 Hippo Browser，工具为内置 \`browser_*\`（如 \`browser_navigate\`），**直接调用、不带任何 \`mcp__\` 前缀**；本轮工具列表**不存在** \`mcp__bob-browser-mcp__*\`，不要尝试调用它
- **标准闭环**：\`browser_navigate\` 打开页面 → \`browser_snapshot\` 拿可交互元素（带 ref）→ \`browser_click\` / \`browser_type\` / \`browser_fill_form\` / \`browser_press_key\` 操作（用 ref 定位）→ \`browser_extract_text\` 读正文 / \`browser_screenshot\` 留证。页面跳转或 DOM 大改后 ref 失效，**重新 snapshot 再操作**
- **ref 命名空间（shadow DOM / 子帧已打通）**：ref 可能是 \`e3\`（主文档）、\`s1-e2\`（页面里 web component 的 shadow root 内）、\`f1-e4\`（页面内 iframe 的子帧）、\`f1-s2-e5\`（子帧内的 shadow root）—— 前缀即作用域路径，直接原样传回 \`browser_click\` / \`browser_type\` 即可，**不要**试图去掉前缀或自己拼选择器。子帧元素由宿主在帧内执行（返回里带 \`frame\` 与 \`via: 'in-frame'\`）；页内脚本 \`bb.$\` 跨不到子帧，这些元素只能用工具层操作。返回里的 \`frames\` 一节列出本次扫到的子帧及其元素数，是「有 iframe 但没内容」时的判断依据
- **常用增强**：页面是异步渲染时用 \`browser_wait_for\`（等元素）/ \`browser_wait_for_text\`（等文本）/ \`browser_wait_network_idle\`（等请求静默）；多标签用 \`browser_list_tabs\` / \`browser_switch_tab\` / \`browser_open_tab\` / \`browser_close_tab\`；需要归档页面用 \`browser_export_pdf\`（落盘 homework/.evidence/），读已打开的 PDF 用 \`browser_read_pdf\`
- **等待语义（重要）**：\`browser_snapshot\` 只等约 1.5s、\`browser_open_tab\` 只等约 3s、\`browser_extract_text\` 正文一出现就返回 —— 返回 \`ready:false\` / 新标签标题为空 / \`[!] 页面可能未加载完\` 都是正常信号，**继续用 \`browser_wait_for_text\` / \`browser_wait_network_idle\` 或下一次 snapshot**，不要重复打开标签、也不要连续重发同一个 snapshot
- **下载网页上的文件（重要）**：入口明显（能直接看到下载链接/按钮）就直接 \`browser_download\`（传 \`url\` 直链或相对 href，或传 \`ref\` / \`selector\`；宿主会真实点击，登录态与 JS 处理器都生效）；入口不明显（图标按钮、列表很长、整页元素很多）先 \`browser_find_downloads\`（只扫下载入口，比整页 snapshot 便宜；返回空或入口在 iframe/shadow 里时再 \`browser_snapshot\`），拿到 \`selector\` / \`href\` 再 \`browser_download\`。它默认在「开始」后再等 2s（\`waitMs\` 可调到 30s，传 0 立即返回），返回 \`{ download: { id, fileName, savePath, state, totalBytes } }\`；小文件此时就是 \`completed\`，仍是 \`progressing\` 时用 \`browser_downloads\` 传 \`id\` + \`waitMs=5000\` 再等一次（最多查 2–3 次，不要连续空转）；用户要求打开下载所在文件夹时传 \`reveal:true\`（completed 才生效）；需要把文件放进项目 \`materials/\` 时，再用 \`browser_save_download\` 传 \`download.id\`（默认 \`materials/downloads\`，可用 \`folder\` 指定子目录）。**不要**用 \`browser_export_pdf\` 代替下载（那是把页面打印成 PDF），**不要**用 \`browser_read_pdf\` 取原文件（它只返回文本、原件留在临时目录），**不要**用 \`browser_run_js\` 把二进制读成 base64，**不要**用 \`browser_wait\` 盲等下载完成 —— 有 \`browser_downloads\` 就查状态
- **PDF 页换工具，不要判空（重要）**：当前页是 PDF（地址以 \`.pdf\` 结尾，或落在内置 pdf-viewer 查看页）时 \`browser_extract_text\` 拿不到正文 —— 直接调 \`browser_read_pdf\` 取文本（无需参数＝读当前页，长文件传 \`maxChars\`），**不要因为提取为空就断言"页面没有内容"**
- **扫描件 PDF 走 OCR（重要）**：\`browser_read_pdf\` 返回的文本为空或只有零星几个字符（扫描件没有文字层），把该返回里的 \`path\` 直接交给 \`ocr_document\` 做识别，拿逐页文本 + \`qualityScore\`；质量低时它默认自动升级视觉模型。手写字段（姓名 / 日期 / 印章 / 签名）识别结果波动属正常，**不要整页反复重试** —— 改用 \`crop_image\` 裁出可疑区域单独复核，并在答复里标注【需人工复核】。远程 PDF 拿不到本地 \`path\` 时，先 \`browser_export_pdf\` 落盘，再对返回的落盘路径做 OCR
- **\`browser_extract_text\` 带 \`note\` 时按它执行**：返回里的 \`[PDF]\` / \`[LOGIN]\` / \`[EMPTY]\` 前缀即成因分类 —— \`PDF\` → 改用 \`browser_read_pdf\`；\`LOGIN\` → 登录墙，按上面凭据红线如实告知用户手动登录；\`EMPTY\` → 页面可能尚未渲染完，先 \`browser_wait_for_text\` / \`browser_wait_network_idle\` 再重试。\`note\` 是成因提示，**不要把它当成页面正文写进答复**
- **脚本优先（PTC for browser，重要）**：同一页面要连续 ≥3 步交互（多字段表单、"展开更多"、翻找列表），或**只要页面里的某些字段**（列表 / 价格 / 链接 / 计数 / 表格行）时，用 \`browser_page_script\` 在页内一次做完并只返回需要的字段——**不要用 \`browser_extract_text\` 把整页正文灌进上下文**，整页文本是回答窄问题最贵的做法。脚本里可用 \`bb.$(refOrSelector)\` / \`bb.ref(ref)\` 定位（ref 就是 \`browser_snapshot\` 给的那些）、\`bb.fill(target, text)\` 填写（原生 setter + input/change，受控组件能正常同步）、\`bb.click(target)\` / \`bb.press(key)\` / \`bb.scroll(...)\` 交互、\`bb.text(target, {maxChars})\` 只取需要的段落、\`bb.waitFor\` / \`bb.waitText\` 等渲染、\`bb.snapshot()\` 在脚本内取元素表。定位先确认锚点存在再取值；\`bb.click\` 走页内合成点击，页面若无视它（坐标派发 / isTrusted 校验）就改用 \`browser_click\`。整页正文只在确实要通读全文时用（合同、长文、判决书）
- **跨页面流程**：常规做法是 \`browser_navigate\` / \`browser_open_tab\` / \`browser_switch_tab\` 切页，然后在**新页面上重新下发一次脚本**——导航会让页内 ref 与脚本内的引用全部失效。脚本内的 \`bb.goto(url)\` 需要对该次调用显式传 \`allowNav=true\`，且它会**终止脚本**（其后语句一律不执行），跳转由宿主完成并返回 \`{ navigated, url, title }\`；脚本里 \`bb.click\` 点到链接触发跳转时同样以 \`{ navigated, url, title }\` 收尾（其后语句未执行）。不要把 \`bb.goto\` 或会跳转的点击放在脚本中间指望后面的语句生效
- **脚本返回值直接给对象，不必自己兜底**：\`bb.$(...)\` / \`bb.ref(...)\` 拿到的 DOM 元素、\`NodeList\`、\`Map\` / \`Set\`、带循环引用的对象都可以直接 \`return\`，宿主会归一化成可读记录（元素带 \`tag\` / \`text\` / \`href\` / \`value\` / \`ref\` 等字段），不用手写 \`el.innerText\` 兜底。**但 helper 的失败是返回而不是抛错**：\`{ ok: false, error }\` 表示这一步**没做成**（目标不存在 / \`disabled\` / 只读 / 零尺寸 / \`pointer-events:none\`），必须判 \`ok\` 再往下走 —— 无视它等于在坏状态上继续跑完剩下的步骤
- **失败续跑纪律（重要）**：\`browser_page_script\` 报 \`phase=script\` 时，\`warnings\` 里会带**失败前已完成的操作轨迹**和「只补跑剩余步骤」提示 —— 照它改脚本、从断点继续，**不要重跑整个脚本**（重跑会把已完成的点击/提交再做一遍）。\`warnings\` 说「脚本因页面跳转中断」或「bb.goto 终止了脚本」时，含义是**其后语句一律未执行**：重新 snapshot 后从断点写新脚本
- 抓取网页正文优先用 web_fetch；遇强反爬站点（百度系/知乎/小红书等）被 403/风控拦截时，改用 \`browser_navigate\` + \`browser_extract_text\` / \`browser_snapshot\` 走真实浏览器会话，不要反复重试 web_fetch
- **失败纪律**：\`browser_navigate\` 已内置加载等待；报 inject（元素不存在/不可交互）时不要盲目重试同一 ref，先重新 snapshot 确认；报 driver（桥不可用）时如实告知用户"Hippo Browser 未运行，请打开 BobWork 的 Hippo Browser 窗口"，不要假装成功
- **凭据红线**：禁止用 \`browser_run_js\` 读取或回显密码、验证码等敏感输入框的值；遇登录墙时如实告知用户"请在 Hippo Browser 窗口内完成登录后告诉我继续"，不要索要凭据、不要臆造自动登录能力
- **能力边界（如实告知，不臆造）**：浏览器对话栏默认 **Core 档**，提供导航 / 等待 / 元素交互 / 内容提取 / 脚本 / 截图与 PDF 导出 / 文件下载与进度查询 / 标签页 / 阅读；cookie/storage、网络/console、拖拽/坐标/视口/前进后退等高级工具在 **Full 档**（设置 → Hippo Browser → Browse toolset 切换）。**若某工具不在本轮工具列表，不要假装调用**：如实说明该工具未启用（侧栏 Core 档可在设置切 Full），或改用现有工具完成。**本通道不提供**：站内搜索与 research 宏、笔记沉淀、应用内登录弹窗（detect_login / login / login_fill）、操作录播（record_start / record_stop / playback）、视频字幕提取（extract_video_text）——这是两个通道的分工（Hippo 免装扩展、Bob Browser 操作用户真实 Chrome），不是临时缺失。遇到这类需求如实说明"该能力由 Bob Browser 通道提供"，不要假装调用不存在的工具、也不要把缺失说成待修问题
- **收尾**：页面保留在 Hippo Browser 窗口内供用户查看，无需 disconnect 之类收尾调用
`;

/** 调研档规则（Research 模式专用，随 BROWSER_RULES_HIPPO 之后注入）：
 *  工具面与 Browse 档完全相同，这里只补「多源取证」的作业纪律 —— 同一批工具，
 *  目标从「顺手给个摘要」变成「产出可核查的结论」。 */
const BROWSER_RESEARCH_RULES = `
## 调研作业纪律（Research 模式已开启）
- **先拆子问题再动手**：把问题拆成 2-5 个可独立核查的子问题，逐个取证；清单不必给用户看，但每一步都要对着某个子问题
- **多源交叉，不靠单一页面**：关键结论至少要有两个**相互独立**的来源（不同站点/机构，不是同一篇稿子的转载）；只拿到一个来源时，如实标注「单一来源，未交叉验证」
- **搜索结果不是证据**：搜索页摘要只用来挑候选来源，结论必须落到打开后的正文；引用一律用脚注角标（格式见下条「引用格式」）
- **读全文而非片段**：抓正文按页面类型分流 —— 网页用 \`browser_extract_text\`（返回 \`note\` 时按其指示换工具）、PDF 用 \`browser_read_pdf\`；长文按返回的 offset 续读到 EOF（续读必须回到同一个工具，字数口径不可混用）；只要若干字段时用 \`browser_page_script\` 只取字段，不要整页灌进上下文
- **记录反证**：遇到与主结论冲突的材料一并写进答复（「与此相反的说法是…，来源…」），不要只留支持自己判断的部分
- **区分事实与推断**：来源里写明的标「据来源」，你自己推的标「据此推断」并说明依据；数字/时间/口径都要挂出处
- **读过的来源会自动汇总成候选清单**：本轮你用 \`browser_navigate\` / \`browser_open_tab\` / \`web_fetch\` 真正打开过的页面，宿主会自动列进答复下方的 「Sources Read」 卡片，用户勾选后一键导入项目 \`materials/\`（自动登记账本并建索引）。由此三条纪律：① 取证必须真的打开页面——搜索页摘要里看到的链接不算「读过」，没打开就不会进清单；② 脚注里的 URL 必须与你实际打开的地址一致，用户才能与清单对上号；③ 清单由宿主生成，你**不要**在答复里另抄一份来源列表，也不要输出任何来源标记块
- **按综述骨架组织答复**（六节顺序与内容不可缺，标题一律论文式多级编号）：\`# <主题>\` 作全文一级标题（交付物就是本轮答复正文：本次调研以会话内综述交付，不要为"存成文件"另起工具链，也不要因此中断任务），六节依次为 \`## 1 研究问题\` → \`## 2 检索范围\` → \`## 3 主题综合\` → \`## 4 争议与不一致\` → \`## 5 缺口\` → \`## 6 结论与下一步建议\`；子问题落在 \`### 3.1\` / \`### 3.2\`… 需要再细分时用 \`#### 3.1.1\`，最多四级。内容口径：1 研究问题一句话；2 检索范围只交代查了哪类来源、用什么条件筛，**不要罗列 URL**（来源清单由宿主卡片生成，见上条）；3 主题综合一个子问题一节，同一问题的多个来源并起来讲，**不要逐篇罗列**；4 争议与不一致给各方主张与各自依据；5 缺口写哪里证据薄、没查到什么；6 结论与下一步建议每条结论挂角标，并交代继续查该查什么
- **引用格式（脚注角标 + 文末引用表）**：正文每个出处写成 GFM 脚注角标 \`[^n]\`，n 按首次出现顺序从 1 递增，紧跟被支撑句子的末尾，**正文里不出现裸 URL**；文末另起一段逐行给定义，形如 \`[^n]: 来源名称 — 完整URL\`（一行一条，顺序与角标一致）。渲染后角标是可点击上标，文末自动生成引用表——这是本档报告唯一的引用形式，也不要另抄一份来源清单
`;

/** 浏览器对话栏（browser 画像）两条动态纪律（随当前轮 user 消息注入，不进 system）：
 *  【一】落盘约定豁免：该档沿用通用 BASE（账本/引用规范仍以 BASE 为唯一事实来源，不做第二套），
 *  但 BASE 里的「长篇报告写 homework/ + OutputFile」「产出存储位置默认 homework/」一类
 *  **落盘约定在该档执行不了** —— 该档没有 write_file / execute_script / run_command
 *  （见 profiles.ts BROWSER_CORE_EXCLUSIONS）。不做这条减法，模型会照 BASE 去找一个不存在的
 *  写文件工具：历史故障里侧边栏调研任务跑了 39 轮 58 次工具调用，末轮自述"我将用它把报告写入
 *  项目 homework/ 目录"，随后无工具调用被判定为终答，任务零产物结束。
 *  【二】窄栏输出风格：模型每轮都在工具调用之间写过程叙述（"我先搜索…""让我加载技能看看…"），
 *  这些文字逐轮累加进同一条正文（前端"去双轨"刻意不剥离，见 ChatNodeKernel 的 tool_call 分支），
 *  三十几轮下来答复被过程叙述淹没 —— 侧边栏窄栏读不下这些，故显式要求只写交付物。 */
const BROWSER_SIDEBAR_RULES = `
## 本档落盘约定豁免（浏览器对话栏没有文件工具）
- 本档工具面是**浏览器操作 + 项目档案读取 + OCR 识别**，**没有** \`write_file\` / \`execute_script\` / \`run_command\`：
  BASE 中一切"写入 homework/ / 正文末尾输出 OutputFile / 落盘成文件"的约定在本档**一律不适用** ——
  不要照它去找写文件工具，也不要说"我将把结果写入…""请稍候等待写入"这类话。
  （扫描件用 \`ocr_document\` / \`crop_image\` 是**识别手段**、不是交付通道，不违反本条。）
- **交付物就是本轮答复正文**：报告、综述、结论直接写在答复里（该详则详，不必为压缩而截断），
  不要中途停下等一个不存在的写入能力。
- 需要留档时走本档既有通道：读过的来源自动汇总成答复下方的 **Sources Read** 卡片（用户勾选即导入
  项目 \`materials/\`）；整页归档用 \`browser_export_pdf\`（落盘 homework/.evidence/）。
- **网页上已有的文件（附件/下载链接）不算「产出文件」**：直接用 \`browser_download\` 下载（存到系统下载目录，
  返回 id / savePath），再用 \`browser_downloads\` 确认完成；用户要把文件放进项目时，用 \`browser_save_download\` 传 id（落 \`materials/\`，同样不算产出文件）。这不是本档缺失的落盘能力，不要拒绝或让用户去画布会话。
- 用户明确要的产物是**新生成**的文件（Word / Excel / 图片 / 独立 HTML 等）时，如实说明"本对话栏只做浏览器任务、
  不产出文件，请到画布会话中处理"，不要假装已生成。

## 输出风格（窄栏阅读）
- **工具调用之间不写过程叙述**：不要"我先搜索…""让我加载技能看看…""接下来我会…"这类过渡句 ——
  正文只写最终交付物；跑了哪些工具由界面的 Process 行呈现，用户点开即可看到。
- 需要交代取舍或不确定时，最多一句话，写在**最终答复**里，不要每轮都汇报一次进度。
`;

/** 报告插图约定（2026-08-30 从 BASE_SYSTEM_PROMPT 移出）：
 *  仅生成报告/调研/分析类交付物时需要，常驻 system 纯浪费固定 token →
 *  报告意图（命中强交付词）时 prependDynamicContext 注入当前轮 user 消息；
 *  浏览器 Research 档不注入（那档由 BROWSER_RESEARCH_RULES 的综述骨架管答复形态）。 */
const REPORT_RULES = `
## 报告插图约定（自动配图 + 禁止询问路径）
- **配图由你根据报告内容自动判断，无需用户点名**：报告含数据趋势/对比/占比/流程/结构等适合可视化的内容时，自动生成图表插图（widget 仅对话内联展示，落盘插图用 matplotlib/脚本）；纯文字叙事报告不强配图；用户明确要求"带图/配图"时必配
- **带插图的报告以文件夹形式交付**：报告文件与插图同放 \`homework/<报告名>/\` 目录下（如 \`homework/市场分析/报告.md\` + \`homework/市场分析/图1.png\`），正文末尾输出 \`OutputFile: homework/<报告名>/报告.md\`；无插图的报告平铺为 \`homework/<关键词>.md\`
- 报告内引用插图一律用**相对路径**：\`![图1](图1.png)\`（同目录）或 \`images/图1.png\`
- 图表类插图：execute_script 用 matplotlib 落盘到 \`$BOB_PROJECT_HOMEWORK/<报告名>/\` 下，与报告同目录（先建目录再写文件）；用户附件插图经 read_attachment 读取后复制到报告文件夹再引用，或按资料列表中的 materials/{附件目录}/{文件名} 换算相对路径直接引用（如 \`../../materials/{附件目录}/{文件名}\`）
- **插图保存/引用路径由你自动决定，禁止向用户询问"图片保存路径"**；插图无来源（无附件且非图表类）时如实告知"对话节点不生成照片/实拍图"，不得用占位图或编造路径
`;

/** 项目档案软指针（存在激活项目时注入，约 130 token）：
 *  只交代「三级跳入口 + 短路规则 + 失败口径」，不做硬门禁——索引为空/未维护时，agent 行为与今日一致。
 *  首轮另有 **结构性预取**（见 lib/runtime/project-brief.ts）把账本索引与材料清单直接摆进上下文，
 *  本指针负责「怎么走」，预取快照负责「有什么」。
 *  与 BROWSER_RULES / REPORT_RULES 同法 prepend 到当前轮 user 消息，不进 system（守住前缀缓存）。 */
const LEDGER_HINT = `
## 项目档案（三级跳：账本 → 材料索引 → 取原件）
需要项目资料/背景时按固定顺序走，不要跳着猜：
1. **\`read_ledger\`（路由器，给结论与项目相对路径）**：省略参数=索引；\`ids\`/\`topics\`=批量取多条元信息；\`id\`=单条正文；\`query\`=关键词；\`rules:true\`=账本规则。
2. **\`search_materials\`（定位器，给页码与片段）**：带 \`query\`=正文命中；不带 \`query\`=已索引材料清单。
3. **\`read_attachment\`（取件）**：按项目相对路径读原文。
**短路**：账本条目已给出明确出处路径时，跳过第 2 步直接取件。
证据链只认真实路径：路径不存在就是**硬错误**，如实说"该路径不存在"，禁止按记忆复述内容。索引只覆盖 \`materials/\`，\`homework/\` 产出不在内。索引为空时照常直接检索项目文件。
`;

// 注：账本「待编译」提醒不再注入对话 —— 编译已改为材料到达后由宿主起后台会话完成
// （见 @/lib/mcp/ledger-compile）：编译是一串串行工具往返，放在对话里会拖慢用户等待。

// （K2-S1 工具面 service 抽取，行为不变：确定性排序 buildAndSortToolDefs（P4 + 来源分组，
//  MCP 段按 settings serverId 分组）与 CacheGuard 守卫随迁 src/lib/runtime/tools.ts，
//  由 ToolRuntime.assemble 统一调用——首轮初始化与场景中途激活重建共用同一排序管线。）

/** 多智能体协作规则（chat 界面「Multi-agent mode」开关打开时注入）：
 *  主 agent 只做**用户代理**：把需求写成清晰 goal 交给 team_run，宿主拉起独立「队长（captain）」会话
 *  做规划、复核与整合，主 agent 只需如实转述返回的整合稿。
 *  与 BROWSER_RULES / REPORT_RULES 同法：prepend 到当前轮 user 消息，不进 system（守住前缀缓存）。
 *  成员名单段（用户弹窗选定的预设 Agent）**不再注入主 agent**——它由 route 经 team_run 的执行上下文
 *  直接交给队长（见 multiAgentRosterSection 的调用处），主 agent 与名单解耦。 */
const MULTI_AGENT_RULES = `
## 多智能体协作模式（Multi-agent mode 已开启）
- **你只是用户代理，不是编排者**：你不需要拆分角色、不需要设计任务 DAG、不需要挑选成员——这些由宿主的「队长（captain）」会话负责
- **你唯一要做的事**：把用户需求写成一段清晰、自洽的 \`goal\`（目标 / 范围 / 交付形态 / 约束 / 引用的材料），然后调用一次 \`team_run\`。goal 是队长唯一能看到的需求来源，写具体、写全，不要指望后续补充
- **只调用一次 team_run**：它在队长完成规划、团队执行完毕、队长复核整合之后才返回；返回后不要再补充调用，也不要再拆任务
- **返回的即是最终答案**：team_run 的返回值已经是队长整合好的完整回答。请**原样转述**给用户，不要自己二次总结、不要改写结论、不要罗列内部编排细节（团队 id、成员调度、消息往来、谁做了哪个任务）
- **如实交代缺口**：返回文本里若说明某部分因成员失败/超时缺失，转述时如实保留，禁止编造
`;

/** 成员名单段（交给**队长**，不再给主 agent）：把用户在弹窗选定的预设 Agent 交给队长规划时参考，
 *  并交代「名单外补充成员必须先经用户批准」——与 team-run 的强制审批门禁是同一件事的两面。
 *  调用处：route 在 team_run 的执行上下文里注入（ctx.teamRosterSection → 队长规划消息），
 *  不进主 agent 的 user 消息（主 agent 已与名单解耦，见 MULTI_AGENT_RULES）。 */
function multiAgentRosterSection(roster: Array<{ id: string; label: string }>): string {
  if (roster.length === 0) {
    return `
## 本次成员名单（用户未选定）
用户没有指定成员，成员由你按任务自行编排。**宿主会在团队启动前弹卡把完整方案（成员 + 任务 DAG）交用户批准**，用户不批准则整套方案作废、协作不启动。因此：只拆真正必要的角色（宁少勿滥，2-5 个），并在每个成员的 role 里写清分工，便于用户判断。
`;
  }
  return `
## 本次成员名单（用户已选定，优先使用）
用户从已安装的 Agent 包中选定了本次协作的成员，请**优先**使用它们，并用 identity 引用其 id：
${roster.map((r) => `- ${r.label}（identity: \`${r.id}\`）`).join('\n')}
- 名单内成员能覆盖任务时就不要另加成员（某个成员没有对应任务时，只派名单内的一部分成员即可）
- 若任务确实需要名单外的角色（名单内都覆盖不到），可以补充成员，但**补充的成员必须先经用户批准**：宿主会弹卡把完整方案交用户批准，用户不批准则整套方案作废、协作不启动。故补充要克制，并在该成员的 role 里写清为什么必须补
- **名单改动一律会告知用户**：只要没用上用户选的某个成员（弃用），或补充了名单外成员，宿主都会弹卡把改动逐条列给用户裁决。因此弃用也要有理由（如该角色与任务无关），必要时在保留成员的 role 里体现分工调整
`;
}

/** 提取最后一条用户消息的纯文本内容 */
function extractLastUserContent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages[i].content || '';
    }
  }
  return '';
}

/** 普通对话已激活场景的会话内 sticky（key=nodeId；无 nodeId 不持久化，仅当轮生效）。
 *  目的：场景一旦激活即在该会话内保持，避免"每轮按意图变化"导致工具集在轮次间抖动——
 *  工具前缀只在首次激活时变化一次，之后逐轮字节稳定 → 前缀缓存命中率最大化。
 *  衰减（2026-10-08）：保持不是无限期的——场景 24h 内未被本轮意图重新命中即脱落，
 *  且每会话最多 6 个场景（见 SessionRuntime），避免工具段单调膨胀（实测中位 79/最大 130 个工具）。
 *  K2-S2 会话态 service，行为不变：本 module 级 Map 已收敛为 SessionRuntime 单例
 *  （src/lib/runtime/session.ts，保留跨请求全局态），读写点改走 sessionRuntime。 */

/**
 * L2 动态意图检测：从最后一条用户消息提取场景关键词（含附件类型），返回命中场景集合（不含 general）。
 * 命中场景对应的 ondemand 工具（见 tools.ts SCENED_TOOLS / BUILTIN_LAYER）本轮才注入；
 * 未涉及该场景则专属工具对模型不可见，避免误调用 + 省上下文固定税。
 */
export function detectSceneHints(text: string): Set<ToolScene> {
  const scenes = new Set<ToolScene>();
  if (!text) return scenes;
  // butler：事务域——记忆/待办/偏好/工作报告/日历/会议记录（含复盘/习惯/计划等高频信号词；沿用 wanted 作为输入别名）
  // 会议记录（会议/纪要/开会/参会/meeting）归 butler 的理由：会议三件套 meeting_start/append/end 在
  //   SCENED_TOOLS 里标 butler —— 主对话（画布 chat 节点）要靠本规则命中才能拿到这三件工具；
  //   原先只有管家画像固定放行，主对话无从进入会议链路（开会成功也拿不到 meeting_append）。
  // 计费维护词（模型计费/单价/调价/新增模型）也归 butler：由管家用 get_model_price / set_model_price 落盘单价覆盖
  if (/wanted|记忆|待办|偏好|工作报告|日历|记住|查询|复盘|习惯|总结|计划|安排|清单|收藏|备忘|遗忘|便签|会议|纪要|开会|参会|会务|meeting|todo|notebook|preference|work.?report|calendar|reminder|daily.?report|计费|单价|调价|改价|定价|按量计费|模型.*(计费|单价|价格|调价)|token.*(价|计费)/i.test(text)) {
    scenes.add('butler');
  }
  // legal：法律场景（含协议/起草/拟定等高频触发词，及刑事法核心术语）
  // 补执行/金钱债务领域词（执行款清偿顺序、先本后息/先息后本、加倍迟延履行利息等提问
  // 不含"法条/法律"字样，缺词会导致 legal 场景不激活 → 北大法宝 pkulaw MCP 不注入 → 模型只能用 web_search 兜底）
  if (/法条|文书|判决|合同|协议|诉讼|律师|法律|庭审|案由|罪名|法规|司法解释|起草|拟定|起诉状|答辩状|申请书|委托书|诈骗|犯罪|被害人|共犯|刑事|量刑|定罪|判刑|主犯|从犯|胁从犯|自首|立功|缓刑|拘役|有期徒刑|追诉|侦查|起诉|审判|执行款|执行程序|强制执行|被执行人|迟延履行|加倍部分|加倍迟延|清偿|抵充|本金|利息|债权|生效法律文书|债务/i.test(text)) {
    scenes.add('legal');
  }
  // audio：音频转写（关键词或音频附件）
  // 附件路径可能含空格/中文目录（如 materials/8ec9_AI Chat/录音.m4a），
  // 不能限定 [^\s)，否则空格后匹配中断 → 场景不激活 → 音频工具不注入。
  if (/转写|录音|语音|音频|字幕|听写|转录|transcrib|庭审.*(录音|语音)|会议.*(纪要|录音)/i.test(text) ||
      /路径:\s*(?:materials|attachments|assets)\/[^\n"']+\.(?:mp3|wav|m4a|aac|ogg|flac|opus|amr)\b/i.test(text)) {
    scenes.add('audio');
  }
  // skill：技能检索/安装
  if (/技能|能力缺口|skill|安装技能|技能库|skill registry|找.*技能/i.test(text)) {
    scenes.add('skill');
  }
  // coding：Agent 造包（子 agent/子助手/专职角色/agent 包）——无沙盒的 coding 会话也能激活
  // create_agent_package 场景，让「＋ → AI Coding → 创建子 Agent」表单预填的首轮消息可用该工具
  if (/create_agent_package|sub.?agent|子agent|子.?.agent|创建.{0,8}(专职助手|专属助手|子助手)|做一个.{0,8}(agent|子代理)/i.test(text)) {
    scenes.add('coding');
  }
  // design：主题/前端界面（coding 节点已在 L1 放行，此处覆盖普通对话）
  if (/主题|配色|颜色|前端|网页|网站|页面|界面|小程序|ui|设计风格|美化|风格|视觉|色值/i.test(text)) {
    scenes.add('design');
  }
  // ocr：图片/PDF 文字识别（关键词或图片/PDF 附件）
  // 附件路径可能含空格/中文目录（如 materials/8ec9_AI Chat/小狗.png），
  // 不能限定 [^\s)，否则空格后匹配中断 → ocr 场景不激活 → 视觉/OCR 工具不注入。
  if (/扫描|识别.*(文字|图片|图像)|ocr|截图.*文字|提取.*(文字|图片).*字|转文字|文字识别|图片.*字|票据|证件|票据识别/i.test(text) ||
      /路径:\s*(?:materials|attachments|assets)\/[^\n"']+\.(?:png|jpe?g|gif|webp|pdf)\b/i.test(text)) {
    scenes.add('ocr');
  }
  // office：Word 模板批量填充/占位符扫描（文档/模板意图；与 legal 的"模板"词可同时激活）
  if (/word|docx|模板|文档模板|合同模板|批量.*(填写|填充|生成)|jinja|占位符|扫描.*模板|套用.*模板/i.test(text)) {
    scenes.add('office');
  }
  // admin：配置/模型/沙盒运维（低频管理操作，用户明确提及才激活）
  if (/配置|设置|api.?key|provider|图标|回滚|导出.*(应用|沙盒)|管理.*(mcp|服务器)|mcp.*(增删改|管理|检查)|测试.*连接|连接测试|列出.*模型|修改.*(模型|配置)|应用配置|查.*配置|模型池/i.test(text)) {
    scenes.add('admin');
  }
  // browser：网页浏览/抓取/浏览器操作（bob-browser-mcp，61 工具 ≈ 1.8 万 token，最大 MCP 开销）
  // 注意与 design 的"网页/网站/页面"词重叠：做网页任务确实可能需要浏览器测试，双激活无害
  if (/浏览器|网页|网址|网站|打开.*(页面|链接)|https?:\/\/|抓取|爬取|浏览.*(页面|网站)|页面.*内容|在线.*(查看|预览)|访问.*网站|看.*(页面|网页)/i.test(text)) {
    scenes.add('browser');
  }
  // company：企业/工商信息查询（tianyancha）——"公司"不带查询动词不触发，避免"公司介绍"类误激活；
  // 补充"信用代码"（覆盖"社会信用代码/统一社会信用代码"这类高频公司查询意图，如"XX公司的社会信用代码"无需"查/工商"动词）
  if (/查.*(企业|公司|工商)|工商|法定代表人|股权|股东|天眼查|企业信息|注册资本|经营范围|企业.*(详情|资料|报告)|公司.*(背景|注册|资质)|信用代码/i.test(text)) {
    scenes.add('company');
  }
  // team：多智能体团队协作（Agent Teams）—— 刻意不在此做意图探测。
  // 多智能体是重操作（每个成员起独立 /api/chat 会话，成本 ≈ N 倍），唯一开启入口是
  // chat 界面的 Multi-agent mode 开关（见下方 activeScenes.add('team')）。
  // 若此处按关键词自动激活，开关即形同虚设、且与「用户显式开启才触发」的产品决定冲突。
  // local：本地软件操控（bobby）——"应用"单独不触发；"打开"后跟应用名（如"打开微信应用"）也算
  if (/操控|打开.{0,6}?(?:应用|软件|程序|\bapp\b)|本地软件|自动化.*(应用|软件)|bobby|控制.*(应用|软件|mac)|操作.*(应用|软件)|启动.*(应用|软件)/i.test(text)) {
    scenes.add('local');
  }
  return scenes;
}

/** search_capabilities 能力目录条目 */
interface CapabilityEntry {
  scene: ToolScene;
  name: string;
  keywords: string[];
  description: string;
  triggerPhrase: string;
}

/** 按需能力目录（search_capabilities 的检索源；与 detectSceneHints / MCP_SERVER_SCENES 场景对齐） */
const CAPABILITY_CATALOG: CapabilityEntry[] = [
  { scene: 'browser', name: '网页浏览/抓取', keywords: ['网页', '浏览器', '抓取', '爬取', '网站', '网址', '链接', '反爬', '页面', '上网'], description: '真实浏览器自动化（含反爬站点）：打开网页、提取正文、截图、填表、登录', triggerPhrase: '"打开这个网页" / "抓取页面数据"' },
  { scene: 'company', name: '企业工商查询', keywords: ['企业', '公司', '工商', '股权', '股东', '天眼查', '注册资本', '法定代表人', '招投标', '工商信息', '信用代码', '社会信用代码'], description: '工商信息、股权结构、司法风险、招投标', triggerPhrase: '"查一下这家公司的工商信息"' },
  { scene: 'local', name: '本地软件操控', keywords: ['本地', '软件', '应用', '操控', '自动化', 'mac', '打开应用'], description: '本地应用自动化控制', triggerPhrase: '"打开微信应用"' },
  { scene: 'legal', name: '法律检索/咨询', keywords: ['法律', '法条', '合同', '诉讼', '律师', '法规', '判例', '文书', '起诉', '司法', '执行', '清偿', '本金', '利息', '债权', '迟延履行', '加倍', '抵充'], description: '法条检索、判例查询、文书起草（含防幻觉约束）', triggerPhrase: '"查一下相关法条"' },
  { scene: 'audio', name: '音频转写', keywords: ['音频', '录音', '转写', '语音', '字幕', '听写'], description: '真实音频转写，禁止凭元数据编造', triggerPhrase: '"转写这段录音"' },
  { scene: 'ocr', name: '图片/PDF 文字识别', keywords: ['识别', '扫描', 'ocr', '图片文字', 'pdf文字', '票据', '证件', '文字识别'], description: '印刷体识别 + 手写复核', triggerPhrase: '"识别这张扫描件"' },
  { scene: 'butler', name: '记忆/待办/偏好', keywords: ['记忆', '待办', '偏好', '笔记', '日历', '提醒', '便签', '收藏', '备忘'], description: '统一长期记忆（记的是用户，所有联系人共享）、项目待办、用户偏好', triggerPhrase: '"记住这个偏好"' },
  { scene: 'design', name: '界面主题/前端', keywords: ['主题', '配色', '前端', '界面', 'ui', '美化', '网页', '页面'], description: '读取真实主题 CSS 变量，前端/页面生成', triggerPhrase: '"按当前主题配色做页面"' },
  { scene: 'skill', name: '技能检索/安装', keywords: ['技能', 'skill', '安装技能', '能力缺口', '技能库'], description: '受控技能库检索与安装', triggerPhrase: '"有没有能做 PPT 的技能"' },
  { scene: 'office', name: 'Word 模板', keywords: ['word', 'docx', '模板', '文档模板', '占位符', '合同模板'], description: 'Word 模板批量填充/占位符扫描', triggerPhrase: '"批量填写 Word 模板"' },
  { scene: 'admin', name: '配置/模型管理', keywords: ['配置', 'api key', '模型', 'provider', 'mcp', '连接测试', '图标', '快捷入口', '快捷按钮', '⌘f', 'cmd+f', 'command+f'], description: '模型/MCP/应用配置管理', triggerPhrase: '"帮我配置模型"' },
];

/** 按 query 匹配能力目录（任一 keyword 命中即算；返回空 = 未匹配） */
export function matchCapabilities(query: string): CapabilityEntry[] {
  if (!query) return [];
  const q = query.toLowerCase();
  return CAPABILITY_CATALOG.filter((c) => c.keywords.some((k) => q.includes(k.toLowerCase())));
}

/** 构造 search_capabilities 的 tool_result 文本：匹配项 + 激活说明。
 *  activationSupported=false（fixed 画像：工具面恒等于 fixedScenes ∪ core，能力检索不会增减工具）
 *  时必须**如实说明本档不可用** —— 否则模型照旧话术"等待工具就绪"，在无工具可等的情况下
 *  把"已激活/请稍候"当成交付（本轮无工具调用 = 最终答复）直接结束任务。
 *  历史故障：侧边栏（browser 画像）调研任务 39 轮 58 次调用、无一次 write_file，末轮激活 local
 *  后输出"等待工具就绪"收工，全程零产物。 */
function buildCapabilityResultText(
  query: string,
  matched: CapabilityEntry[],
  newlyActivated: ToolScene[],
  activationSupported: boolean,
): string {
  if (matched.length === 0) {
    return (
      `未在能力目录中找到匹配「${query}」的能力。可用能力：网页浏览/抓取、企业工商查询、本地软件操控、` +
      `法律检索、音频转写、图片/PDF 文字识别、记忆/待办/偏好、界面主题/前端、技能检索/安装、Word 模板、配置/模型管理。` +
      `请尝试用更明确的意图短语描述（如"查企业""转写音频""识别扫描件"）。`
    );
  }
  const lines = matched.map(
    (c) => `- ${c.name}：${c.description}。触发语句示例：${c.triggerPhrase}`,
  );
  if (!activationSupported) {
    return `能力目录匹配「${query}」（**本档不可用**）：\n${lines.join('\n')}\n\n` +
      `本档工具面固定（浏览器操作 + 项目档案读取 + OCR 识别），能力检索**不会**为本档增减任何工具——` +
      `上述能力在当前档位拿不到，请**不要**再等它出现、也不要用"已激活 / 请稍候"当作答复。` +
      `改用现有工具（browser_* / web_fetch 等）尽力完成任务，交付物直接写进本轮答复正文；` +
      `确需该能力时如实告知用户：本对话栏不提供该能力，请到画布会话中使用。`;
  }
  const activatedList = newlyActivated.length > 0
    ? `，本轮已激活: ${newlyActivated.join(', ')}`
    : '（已在可用状态）';
  return `能力目录匹配「${query}」${activatedList}：\n${lines.join('\n')}\n\n` +
    `已激活的能力其对应工具会在**下一个回合立即注入**（本轮剩余的工具调用序列请立即结束，不必再补兜底调用）。` +
    `**注意**：结束本轮工具调用 ≠ 结束任务 —— 下一个回合请**立刻调用**刚注入的工具把活干完；` +
    `不要把"已激活 / 请稍候 / 等待工具就绪"这类状态说明当作答复（本轮若没有任何工具调用，` +
    `系统会判定为最终答复、任务就此交付，你就再没有机会调用它了）。\n` +
    `**禁止**继续用 web_search / web_fetch 等网页方式兜底查询（反爬会拦截且查不到结构化工商/企业数据）。`;
}

// ── P4a 三段化骨架：首批宿主接管注册（scenario_activate，行为与迁移前的 if-else 判定一致）──
// 判定顺序 = 注册顺序（takeoverFor 同 priority 保持注册序）：
//   · search_capabilities：pre-execute 全接管（执行前咨询、命中即替代 executeTool），先判定；
//   · load_skill 法律联动：post-execute 联动（工具执行成功后咨询），后判定。
// 场景激活 / sticky / needRebuildTools 由 pipeline 统一执行（applyScenarioActivation）。
registerTakeover({
  kind: 'scenario_activate',
  phase: 'pre',
  name: 'search_capabilities',
  // 能力目录检索：命中的场景交 pipeline 去重激活 + sticky + 触发重建；
  // meta 携带匹配条目（含已激活的）供宿主编排能力清单文本（buildCapabilityResultText）。
  handleScenario(name, args) {
    const query = String(args?.query ?? '');
    const matched = matchCapabilities(query);
    return { scenes: matched.map((c) => c.scene), sticky: true, meta: { matched } };
  },
});
registerTakeover({
  kind: 'scenario_activate',
  phase: 'post',
  name: 'load_skill',
  // 法律技能加载成功 → 激活 legal 场景（pkulaw 工具随工具集重建注入可见）；
  // 技能名不在法律名单返回 null（不接管）。"成功"由宿主在 post 咨询点保证（仅 execResult.success 时咨询）。
  handleScenario(name, args) {
    let skillName = '';
    try {
      skillName = String(args?.skill_name ?? '').trim();
    } catch {
      /* 参数异常则不激活（与原 if 分支同语义） */
    }
    if (!skillName) return null;
    const def = getAllSkills().find(d => d.meta.name === skillName);
    if (!def || !isLegalSkill(def.meta)) return null;
    return {
      scenes: ['legal'],
      sticky: true,
      hint: '[宿主提示] 已自动激活法律场景(legal)：北大法宝 pkulaw MCP 法条/案例检索工具已加入可用工具集，法条原文、时效性、裁判规则核对请优先使用 mcp__pkulaw__* 工具（结果自带 pkulaw.com 原文链接），仅在 pkulaw 不可用时才用 web_search/web_fetch 降级。',
    };
  },
});

// ── P4a-2a 迁移：节点参数注入 + 执行结果压缩 收敛为注册式接管（tool-pipeline.ts，行为不变）──
//   · args_transform（phase: pre，match 文件/沙箱工具名单）：exec 前把 current_node_id /
//     node_sandbox_app_id 注入执行参数字符串 —— 名单判定与注入规则在本注册内，请求作用域值
//     （nodeId / toolLoopSandboxAppId）由宿主在咨询点经 ctx 传入；JSON 解析/回写失败返回
//     null = 原样执行（与原 if 内联 try/catch 同语义）。
//   · result_compact（phase: post，通用变换，match 全量工具）：结果写入对话历史前压缩 —— 仅
//     文本超阈值时保头保尾压缩（阈值/文案沿用 compactToolResult，含 LIST_LIKE_TOOLS 区分）；
//     compacted 由宿主发 SSE tool_compact 帧 + 压缩日志。
//     注册序须保持在 load_skill 之后：load_skill 亦为 post 场景激活条目，route 的 post 咨询点
//     用 takeoverFor（按 name+phase、不分 kind，首个命中即返回），对 load_skill 须仍先命中
//     场景激活条目，故本条目不得排在其前（其余工具无 post 场景激活条目，无影响）。
/** 节点参数自动注入名单：intern_search 需 current_node_id 做祖先链校验；read_file/write_file/
 *  rename_file/delete_file 需 current_node_id 做 homework/ 文件归属隔离与 .ownership.json 清册
 *  维护；execute_script/run_command 需 current_node_id 注入 BOB_NODE_HOMEWORK 产出目录。 */
const NODE_PARAM_INJECT_TOOLS = new Set([
  'intern_search',
  'read_file',
  'write_file',
  'edit_code',
  'rename_file',
  'delete_file',
  'list_directory',
  'execute_script',
  'run_command',
  'ocr_document',
  'crop_image',
]);
registerTakeover({
  kind: 'args_transform',
  phase: 'pre',
  name: '__node_param_inject__',
  match: (name) => NODE_PARAM_INJECT_TOOLS.has(name),
  transformArgs(name, args, ctx) {
    try {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      parsed.current_node_id = ctx.currentNodeId;
      // Coding 节点标识：工具据此强制所有写操作落 bob-sandbox/apps/<appId>/（不落 homework）
      if (ctx.sandboxAppId) parsed.node_sandbox_app_id = ctx.sandboxAppId;
      // 管家派发会话的批次标识：工具据此把交付物改道到 outbox（不写当前项目 homework/）
      if (ctx.outboxBatchId) parsed.node_outbox_batch_id = ctx.outboxBatchId;
      return JSON.stringify(parsed);
    } catch {
      // 参数解析/回写失败时原样传递（与原 if 内联 try/catch 一致）
      return null;
    }
  },
});
registerTakeover({
  kind: 'result_compact',
  phase: 'post',
  name: '__result_compact__', // 通用变换：命中全部工具；仅超阈值结果才实际压缩（compactToolResult 判定）
  match: () => true,
  compactResult(name, result) {
    return compactToolResult(result, name);
  },
});

// ── P4a-3-1 迁移 ask_user_questions，行为不变 ──
// 挂起型（host-pending）接管首类：模型调用 ask_user_questions → 立即推 questions_request 弹窗挂起
// 等待用户 answers 回传（POST /api/chat/questions 独立恢复端点，跨请求内存挂起），再把 answers 作为
// tool_result 回灌模型继续生成。与 scenario_activate 等模块级纯函数接管不同：需要 send(SSE) /
// pending 容器 / 心跳 / 回灌 / 循环 continue → handler 经 ctx（HostTakeoverContext，宿主在 handle()
// 调用点注入最小服务面）完成全部副作用；本注册为模块级单次、不持 route 闭包（多请求并发安全）。
// 行为等价：questions_request 载荷字段 / 20s tool_call_update(running) 心跳时序 / answers 回灌文本 /
// eventLog·tool_result·遥测 / 循环 continue 语义逐位一致（原 if 分支体见 git 历史 3812-3878）。
// butler_confirm / tool_confirm / login / grant 后续复用同一 host-pending 形态（各自注册新 kind）。
async function handleAskUserQuestions(ctx: HostTakeoverContext): Promise<HostTakeoverVerdict> {
  // ① 归一化 questions（与原 if 内联同语义：结构异常元素兜底为自增 id / 空问题 / 空选项 / allowCustom 默认开）
  const pendingQuestions: PendingQuestionItem[] = (
    Array.isArray(ctx.args.questions) ? ctx.args.questions : []
  ).map((q, i) => {
    const item = (q ?? {}) as Record<string, unknown>;
    return {
      id: String(item.id ?? `q${i + 1}`),
      question: String(item.question ?? ''),
      options: Array.isArray(item.options) ? item.options.map(String) : [],
      allowCustom: item.allowCustom !== false,
    };
  });
  // ①.5 聚合链路（带 channel：微信桥 / ⌘F 面板 /chat 都经 /api/core/node-chat 把上游 SSE 聚合成
  //     一句 JSON 才返回，调用方拿不到 questions_request 这类挂起帧）→ 不登记挂起（否则空等到
  //     QUESTIONS_TIMEOUT_MS 才收口），改为把问题与候选选项以文本回灌给模型，
  //     由它用自然语言在同一轮里追问用户。
  if (ctx.channel) {
    const rendered = pendingQuestions
      .map((q, i) => `${i + 1}. ${q.question}${q.options.length > 0 ? `（可选：${q.options.join(' / ')}）` : ''}`)
      .join('\n');
    const questionText =
      '当前通道没有可点选的选项卡片，你的提问没有展示给用户。请直接用自然语言把下面的问题' +
      '（含候选选项）写成一条消息发给用户，用户会在下一条消息里回答：\n' + rendered;
    ctx.send({
      tool_result: {
        name: ctx.name,
        result: questionText,
        durationMs: 0,
        success: true,
        phase: 'done',
        spanId: ctx.spanId,
        startAt: ctx.startAt,
        endAt: Date.now(),
      },
      nodeId: ctx.nodeId,
    });
    ctx.commitToolResult(questionText);
    return 'handled_continue';
  }
  // ② 登记挂起项 + SSE questions_request（载荷字段与原分支一致：requestId / questions / timeoutSec）
  const { requestId, promise, getSupplement } = createPendingQuestions(pendingQuestions, ctx.nodeId);
  ctx.send({
    questions_request: {
      requestId,
      questions: pendingQuestions,
      timeoutSec: Math.ceil(QUESTIONS_TIMEOUT_MS / 1000),
    },
    nodeId: ctx.nodeId,
  });
  // ③ 等待用户提交期间 SSE 无数据，会被前端 90s 空闲超时误杀；每 20s 发一条
  //    tool_call_update(running) 心跳保持连接（前端对重复 running 幂等）。
  const qKeepalive = setInterval(() => {
    ctx.send({ tool_call_update: { name: ctx.name, phase: 'running', spanId: ctx.spanId, startAt: ctx.startAt }, nodeId: ctx.nodeId });
  }, 20000);
  let answers: PendingAnswerEntry[] | null;
  try {
    answers = await promise; // 前端弹窗提交回传；超时/关闭为 null
  } finally {
    clearInterval(qKeepalive);
  }
  // ④ 组织回灌文本（answers + 补充说明；未回答走降级文案，与原分支逐字一致）
  const supplement = getSupplement();
  const answersText = answers && answers.length > 0
    ? `用户对你提出的问题逐一答复如下（problem/question 为其原问题，answer 为用户选择或填写的答复）：\n${JSON.stringify(answers, null, 2)}${supplement ? `\n\n用户补充说明：${supplement}` : ''}`
    : '用户未回答你的提问（弹窗被跳过或超时）。请基于已有信息继续，必要时简要说明缺失的信息。';
  // ⑤ SSE tool_result（done 成功回灌，span 轨迹字段与原分支一致）+ 结果落账（顺序与原分支一致）
  ctx.send({
    tool_result: {
      name: ctx.name,
      result: answersText,
      durationMs: 0,
      success: true,
      phase: 'done',
      spanId: ctx.spanId,
      startAt: ctx.startAt,
      endAt: Date.now(),
    },
    nodeId: ctx.nodeId,
  });
  ctx.commitToolResult(answersText);
  // ⑥ 该工具已由宿主处理 → 宿主据此 continue（跳过下方通用执行逻辑）
  return 'handled_continue';
}
registerHostTakeover({
  kind: 'ask_user',
  phase: 'pre',
  name: 'ask_user_questions',
  handle: handleAskUserQuestions,
});

// ── P4a-3-2 迁移 tool_confirm（需手动确认名单通用确认），行为不变 ──
/**
 * 聚合链路通道收口（ctx.channel 存在）：以 tool_result 说明「未执行」并结束本轮工具轮，不登记挂起项。
 * 背景：聚合入口走 /api/core/node-chat 的聚合分支（把上游 SSE 读到流结束才聚合成一句 JSON 返回），
 * 确认回传永远到不了挂起项 —— 若照桌面流式流程 createPendingConfirm，聚合请求会空等到
 * CONFIRM_TIMEOUT_MS（10 分钟）才以 timeout 收口，用户侧表现为「发完一条卡十分钟」。
 * 故该链路下确认类动作与写类工具一律「回话说明 + 不执行」，由模型如实转述（微信白名单例外，见调用点）。
 * 注：Butler 抽屉走 streamButlerChat（不传 channel）—— 它属可弹卡链路，不经过本收口；
 *     ctx.channel === 'panel' 分支当前不可达（⌘F 面板 P1-c 已退化为纯搜索），保留仅为语义完整。
 */
function denyOnAggregateChannel(ctx: HostTakeoverContext, reason: string): HostTakeoverVerdict {
  const label =
    ctx.channel === 'wechat' ? '微信通道' : ctx.channel === 'feishu' ? '飞书通道' : '当前聚合通道';
  const advice =
    ctx.channel === 'wechat' || ctx.channel === 'feishu'
      ? '如需办理，请在桌面端悬浮球（Butler 抽屉）里说一遍——那里会弹可编辑确认卡，或按审批策略直接放行。'
      : '如需办理，请在桌面端 Butler 悬浮球（左下角抽屉）里说一遍——那里会弹可编辑确认卡。';
  const resultText = `${label}未执行「${ctx.name}」：${reason} ${advice}`;
  ctx.send({
    tool_result: {
      name: ctx.name,
      result: resultText,
      durationMs: 0,
      success: false,
      phase: 'error',
      spanId: ctx.spanId,
      startAt: ctx.startAt,
      endAt: Date.now(),
    },
    nodeId: ctx.nodeId,
  });
  ctx.commitToolError?.(resultText);
  return 'handled_continue';
}

// P4b-1 追加：本 handler 名单判定后接入审批策略层（decideToolApproval，approval.ts）——默认
// allow_scope 档与迁移前逐位一致（名单内 request、名单外 noop 放行）；ask/never 为新档位（默认
// 不启用，经 settings.approval.defaultStrategy 开启、route 咨询点注入 ctx.approvalStrategy）。
// 挂起型第二类：模型调用「需手动确认名单」内工具 → 立即推 tool_confirm 弹窗挂起，等待用户确认
// （POST /api/chat/confirm 恢复端点，跨请求内存挂起；超时 = timeout ≠ 用户拒绝）。与 ask_user 同
// host-pending 形态：send / 挂起容器 / 20s 心跳 / 回灌 / 循环 continue 均经 ctx 服务面完成；本注册
// 模块级单条、不持 route 闭包。与 ask_user 的差异：判定名单（confirmTools）是运行期配置、无法绑定
// 固定工具名 → 注册条目 match 恒 true（工具名恒咨询），名单与身份由宿主在咨询点经 ctx 注入，handler
// 内判定：名单外 / butler 结构化卡片已覆盖（identity==='butler' 且属 BUTLER_CARD_TOOLS）→ 'noop'
// 照常通用执行。咨询点物理位置保持在 butler 卡片段之后（route 工具轮 ①.4 之后原 if 位置，见
// handleAskUserQuestions 上方同轮咨询点），butler 先判的顺序约束由宿主保证。
// 行为等价：tool_confirm 载荷字段（confirmId/name/arguments/timeoutSec）/ 心跳时序 / denied·timeout
// 区分措辞 / tool_result(error)·落账三连 / 循环 continue 语义逐位一致（原 if 分支体见 git 历史
// 4045-4106）；approved 不回灌编辑参数 → 'handled_fallback' 回落本轮通用执行（与迁移前一致：前端
// 通用确认只回传 approved，服务端原样忽略 edited，args 不覆盖）。
async function handleToolConfirm(ctx: HostTakeoverContext): Promise<HostTakeoverVerdict> {
  // ① P4b-1 名单判定 + 审批策略裁决（默认档与迁移前 if 条件逐位一致：名单内 且 未被 butler
  //    结构化卡片覆盖才弹通用确认、名单外一律 'noop' 放行）。顺序约束：
  //      a) butler 结构化卡覆盖最先判定并 'noop' 保留 —— butler 卡（用户可见可编辑确认 UI）视为
  //         强于 confirm 的人工审批，任何 strategy 均不拦截（见 approval.ts 文件头边界说明）；
  //      b) 其余工具走 decideToolApproval（纯函数，approval.ts）：'request' → 原挂起确认流程
  //         （② 起不变）；'allow' → 'noop' 通用执行（同现状名单外，allow_scope 下不 consult 写类）；
  //         'deny'（仅 never 档，名单内或写类）→ SSE tool_result(error) + 落账 + 'handled_continue'。
  //    ctx.approvalStrategy 未注入（undefined）= 兜底 'allow_scope'（向后兼容，行为同现网）。
  const confirmTools = ctx.confirmTools ?? [];
  const usesButlerCard = ctx.identity === 'butler' && BUTLER_CARD_TOOLS.has(ctx.name);
  if (usesButlerCard) return 'noop';
  const approvalStrategy = ctx.approvalStrategy ?? 'allow_scope';
  const approval = decideToolApproval({
    name: ctx.name,
    inConfirmList: confirmTools.includes(ctx.name),
    strategy: approvalStrategy,
  });
  if (approval === 'allow') {
    // 聚合链路（带 channel）：副作用工具默认不执行 —— 默认 allow_scope 档下名单外写工具会被静默执行，
    // 而聚合链路拿不到任何确认机会。写权限按通道分档：微信 = WECHAT_ALLOWED_WRITES（排程三件套 +
    // 便签，手机端高频低风险，无确认卡直接写）；panel（⌘F 面板 /chat）= 只读，写类一律拒。
    if (ctx.channel && SANDBOX_BLOCKED_TOOLS.has(ctx.name) && !isBridgeWriteAllowed(ctx.channel, ctx.name)) {
      return denyOnAggregateChannel(ctx, '它是会产生副作用的写类工具，本通道不放行写操作。');
    }
    return 'noop';
  }
  if (approval === 'deny') {
    // never 档：名单内或写类工具一律拒绝执行（读类已在 decideToolApproval 判 'allow'，不会到达此处）
    const deniedResult =
      `该工具调用被当前审批策略（never）拦截：写类工具及「需手动确认名单」内工具在 never 策略下` +
      `默认不允许执行，本次调用未执行。请停止涉及该工具的操作，如实向用户说明该工具尚未执行，` +
      `并征询其意见（如确认需要，可在设置中将审批策略切回 allow_scope/ask 后重试）。`;
    ctx.send({
      tool_result: {
        name: ctx.name,
        result: deniedResult,
        durationMs: 0,
        success: false,
        phase: 'error',
        spanId: ctx.spanId,
        startAt: ctx.startAt,
        endAt: Date.now(),
      },
      nodeId: ctx.nodeId,
    });
    ctx.commitToolError?.(deniedResult);
    return 'handled_continue';
  }
  // 聚合链路（带 channel）：「需手动确认」名单内的工具不登记挂起（该链路收不到确认回传），
  // 改为说明 + 不执行。微信白名单例外：排程三件套 + 便签即便落在确认名单里也直接执行（手机端高频）。
  if (ctx.channel) {
    if (isBridgeWriteAllowed(ctx.channel, ctx.name)) return 'noop';
    return denyOnAggregateChannel(ctx, '它属于「需手动确认」名单，需要你当面确认。');
  }
  // approval === 'request' → 原挂起确认流程（与迁移前逐位一致）：
  // ② 登记挂起项 + SSE tool_confirm（载荷字段与原分支一致：confirmId/name/arguments/timeoutSec；
  //    arguments 用已解析参数对象，挂起登记用原始参数字符串 ctx.execArgs）
  const { confirmId, promise } = createPendingConfirm(ctx.name, ctx.execArgs ?? '', ctx.nodeId);
  ctx.send({
    tool_confirm: {
      confirmId,
      name: ctx.name,
      arguments: ctx.args,
      timeoutSec: Math.ceil(CONFIRM_TIMEOUT_MS / 1000),
    },
    nodeId: ctx.nodeId,
  });
  // ③ 等待确认期间 SSE 无数据，会被前端 90s 空闲超时误杀；每 20s 发一条
  //    tool_call_update(running) 心跳保持连接（前端对重复 running 幂等）。
  const confirmKeepalive = setInterval(() => {
    ctx.send({ tool_call_update: { name: ctx.name, phase: 'running', spanId: ctx.spanId, startAt: ctx.startAt }, nodeId: ctx.nodeId });
  }, 20000);
  let confirmRes: ConfirmResult;
  try {
    confirmRes = await promise; // 前端弹窗确认回传；超时记为 timeout（≠ 用户拒绝）
  } finally {
    clearInterval(confirmKeepalive);
  }
  // ④ verdict 三分：approved → 'handled_fallback' 回落本轮通用执行路径（args 原样，executeTool
  //    真正执行 + 成功落账在通用路径完成，与迁移前一致）；denied/timeout → SSE tool_result(error、
  //    措辞区分「明确拒绝」与「超时未操作」) + 落账三连 + 'handled_continue'（宿主 continue 跳过通用执行）。
  if (confirmRes.verdict === 'approved') return 'handled_fallback';
  const deniedResult =
    confirmRes.verdict === 'timeout'
      ? `该工具调用因等待确认超时（${Math.ceil(CONFIRM_TIMEOUT_MS / 60_000)} 分钟内未收到你的确认）而自动跳过，并非用户拒绝执行。请如实向用户说明该工具尚未执行，并询问是否继续执行。`
      : '用户拒绝了该工具的调用（该工具在「需手动确认名单」中，未获用户确认即不执行）。请停止涉及该工具的操作，向用户说明情况并征询其意见。';
  ctx.send({
    tool_result: {
      name: ctx.name,
      result: deniedResult,
      durationMs: 0,
      success: false,
      phase: 'error',
      spanId: ctx.spanId,
      startAt: ctx.startAt,
      endAt: Date.now(),
    },
    nodeId: ctx.nodeId,
  });
  ctx.commitToolError?.(deniedResult);
  return 'handled_continue';
}
registerHostTakeover({
  kind: 'tool_confirm',
  phase: 'pre',
  name: '*', // 名单是运行期配置（不绑定固定工具名）→ 恒咨询，名单判定在 handler 内（ctx.confirmTools）
  match: () => true,
  handle: handleToolConfirm,
});

// ── P4a-3-3 迁移 butler 卡片，行为不变 ──
// 挂起型第三类：butler 专属节点（identity==='butler'）的排程 创建/改/删（BUTLER_CARD_TOOLS =
// create_scheduled_todo / todo_update / todo_delete）→ 先弹结构化可编辑确认卡片（buildButlerCard
// 预填字段 + 冲突提示），用户可改字段后确认才真正执行；拒绝/超时按未执行处理。与 tool_confirm 同
// host-pending 形态（send / createPendingConfirm 挂起容器 / 20s 心跳 / 回灌 / 循环 continue 均经
// ctx 服务面完成）；本注册模块级单条、不持 route 闭包。与 tool_confirm 的差异：approved 后用户
// 编辑过的参数（edited.toolArgs）要覆盖本轮执行参数 —— ctx.setExecArgs 写回通道由宿主注入
// （route 闭包内 let parsedArgs/execArgs），handler 据此把新参数交给宿主回落通用执行时生效。
// 判定：非 butler 身份 / 工具不在 BUTLER_CARD_TOOLS / 卡片构建失败（无 event 等）→ 'noop' 交还
// 宿主走 tool_confirm/通用执行（与迁移前 if(card) 不进入同语义）。咨询点物理位置保持在 tool_confirm
// 之前（route 工具轮 ①.4 原 if 位置），butler 先判的顺序约束由宿主保证。
// 行为等价：butler_confirm 载荷字段（confirmId/name/card/timeoutSec，card 即 buildButlerCard 产出）
// / 心跳时序 / denied·timeout 区分措辞 / tool_result(error)·落账三连 / 循环 continue 语义 /
// approved+edited.toolArgs 覆盖路径逐位一致（原 if 分支体见 git 历史 4049-4116）。
async function handleButlerCard(ctx: HostTakeoverContext): Promise<HostTakeoverVerdict> {
  // ① 身份 + 工具名单判定（与迁移前 if 条件逐位一致：butler 专属节点的排程 创建/改/删 才走卡片）
  if (ctx.identity !== 'butler') return 'noop';
  // ①.2 规则草案卡（rule_create）：与排程卡并列的另一条 butler 卡片通道
  if (BUTLER_RULE_DRAFT_TOOLS.has(ctx.name)) return handleRuleDraftCard(ctx);
  // ①.3 技能草案卡（skill_draft）：同上，approved 才落 .skills/<id>.md
  if (BUTLER_SKILL_DRAFT_TOOLS.has(ctx.name)) return handleSkillDraftCard(ctx);
  if (!BUTLER_CARD_TOOLS.has(ctx.name)) return 'noop';
  // ①.5 聚合链路（带 channel）：结构化确认卡到不了该链路用户手里，登记挂起只会空等 10 分钟。
  //      微信白名单：排程三件套 → 不弹卡、'noop' 交还宿主直接执行；其余（含 panel 通道，
  //      该通道只读）仍按「说明 + 不执行」收口。
  if (ctx.channel) {
    if (isBridgeWriteAllowed(ctx.channel, ctx.name)) return 'noop';
    return denyOnAggregateChannel(ctx, '它需要你在可编辑确认卡上点一下才会真正写入。');
  }
  // ② 卡片构建（buildButlerCard：create 由参数预填；update/delete 拉库内事件行 + 冲突提示）；
  //    构建失败（缺 event_id / 库内无此事件 / 异常）→ 不弹卡，交还宿主（noop）走下方 tool_confirm
  //    consult —— 与迁移前 if(card) 不进入、随后 tool_confirm 的 usesButlerCard 覆盖判定等价。
  const card = await buildButlerCard(ctx.name, ctx.args);
  if (!card) return 'noop';
  // ②.5 「没情况就不弹卡」（2026-09-27 用户反馈：描述已经很清楚，为什么还要弹窗确认）：
  //   卡片是「有冲突/风险要用户拍板」的界面 —— 只有**确有话要对用户说**时才弹，否则直接执行：
  //   · create / update：新时段无冲突、无风险（用户得选：接受原时段还是换一个）→ 'noop' 交还宿主，
  //     执行器自行评估后直接落库/应用，模型用一句话回报；
  //   · delete：不做时段评估；仅当事件源自便签行（source_ref，删除会连带移除便签那一行）时才带 risk 弹卡，
  //     普通事件的删除（默认软删、可恢复）直接执行；
  //   · 模型已带 force（用户此前已明确坚持原时段）→ 不弹。
  //   缺时间 / 时间非法 / 已过去同样不需要卡片：assessEventSlot 无 startIso 即判干净 → noop 后由
  //   执行器的硬校验返回 need_more_info / invalid_time / past_time，模型一句话征询。
  if (ctx.args.force === true || (card.conflicts.length === 0 && card.risks.length === 0)) return 'noop';
  // ③ 登记挂起项 + SSE butler_confirm（载荷字段与原分支一致：confirmId/name/card/timeoutSec）
  const { confirmId, promise } = createPendingConfirm(ctx.name, ctx.execArgs ?? '', ctx.nodeId);
  ctx.send({
    butler_confirm: {
      confirmId,
      name: ctx.name,
      card,
      timeoutSec: Math.ceil(CONFIRM_TIMEOUT_MS / 1000),
    },
    nodeId: ctx.nodeId,
  });
  // ④ 等待确认期间 SSE 无数据，会被前端 90s 空闲超时误杀；每 20s 发一条
  //    tool_call_update(running) 心跳保持连接（前端对重复 running 幂等）。
  const cardKeepalive = setInterval(() => {
    ctx.send({ tool_call_update: { name: ctx.name, phase: 'running', spanId: ctx.spanId, startAt: ctx.startAt }, nodeId: ctx.nodeId });
  }, 20000);
  let cardRes: ConfirmResult;
  try {
    cardRes = await promise; // 前端卡片确认/拒绝回传；超时记为 timeout（≠ 用户拒绝）
  } finally {
    clearInterval(cardKeepalive);
  }
  // ⑤ verdict 三分：
  //    - denied/timeout → SSE tool_result(error、措辞区分「明确拒绝」与「超时未操作」) + 落账三连
  //      + 'handled_continue'（宿主 continue 跳过通用执行，与迁移前分支 continue 一致）；
  //    - approved → 用户可能编辑过卡片 → 经 setExecArgs 用 edited.toolArgs 覆盖执行参数（对象判
  //      定与迁移前 4110-4114 逐位一致：toolArgs truthy 且 typeof object 才覆盖），随后
  //      'handled_fallback' 回落宿主通用执行（宿主用覆盖后 args 真正执行 + 成功落账在通用路径完成）。
  if (cardRes.verdict !== 'approved') {
    const deniedResult =
      cardRes.verdict === 'timeout'
        ? `该排程操作因等待确认超时（${Math.ceil(CONFIRM_TIMEOUT_MS / 60_000)} 分钟内未收到你的确认）而自动跳过，并未执行。请如实告知用户并询问是否继续。`
        : '你拒绝了该排程操作（未获确认即不执行）。请停止该操作，向用户说明并征询意见。';
    ctx.send({
      tool_result: {
        name: ctx.name,
        result: deniedResult,
        durationMs: 0,
        success: false,
        phase: 'error',
        spanId: ctx.spanId,
        startAt: ctx.startAt,
        endAt: Date.now(),
      },
      nodeId: ctx.nodeId,
    });
    ctx.commitToolError?.(deniedResult);
    return 'handled_continue';
  }
  // approved：用户可能编辑过卡片 → 用编辑后的参数覆盖执行
  const editedArgs = cardRes.edited?.toolArgs;
  const execArgs =
    editedArgs && typeof editedArgs === 'object'
      ? (editedArgs as Record<string, unknown>)
      : ctx.args;
  // 卡片即唯一确认点：卡上已把冲突/风险/时段讲清，用户点确认 = 知情同意。
  // create_scheduled_todo 的执行器还会再评估一次时段 + 时间硬校验（用于拦「模型绕过卡片直写」），
  // 若不在批准后注入 force，同一冲突或「已过去时间」会被拒第二次 → 模型再问一轮 → 第二张卡
  // （= 用户看到的「弹窗两次」根因）。
  // 仅在**卡片时段与即将写入的时段一致**时注入 force —— 此时卡片展示的冲突/风险就是最终要写的东西，
  // 用户确认即知情同意；若用户改了时间，则卡片没告知过新时段的冲突，交回执行器重判（严谨优先）。
  const finalStart = typeof execArgs.start_time === 'string' ? execArgs.start_time : null;
  const finalEnd = typeof execArgs.end_time === 'string' ? execArgs.end_time : null;
  const slotUnchanged =
    card.mode === 'create' &&
    card.date === toLocalDateStr(finalStart) &&
    card.start === toLocalTimeStr(finalStart) &&
    card.end === toLocalTimeStr(finalEnd);
  if (ctx.name === 'create_scheduled_todo' && slotUnchanged) {
    ctx.setExecArgs?.(JSON.stringify({ ...execArgs, force: true }));
  } else {
    ctx.setExecArgs?.(JSON.stringify(execArgs));
  }
  return 'handled_fallback';
}
registerHostTakeover({
  kind: 'butler_confirm',
  phase: 'pre',
  name: '*', // 名单是固定集（BUTLER_CARD_TOOLS）+ 身份（butler）判定 → 恒咨询，判定在 handler 内
  match: () => true,
  handle: handleButlerCard,
});

// ── P4a-3-4 迁移 login/grant，行为不变 ──
// 收官两件：browser.login 挂起型接管 与 bobby grant 接管从 route 工具轮内联 if 分支收敛为注册式
// host-pending 分发（tool-pipeline.ts，各自注册新 kind 'login' / 'grant'，phase post）。
//   · login：exec 前 mode 注入（强制 BobWork 弹窗模式，属 pre 改写）+ exec 后 loginRequired 判定 →
//     createPendingLogin 挂起 + SSE login_required（requestId/siteName/url/timeoutSec）→ 20s 心跳 →
//     前端登录窗回传凭据（POST /api/chat/login 独立恢复端点，跨请求内存挂起）→ 服务端直调
//     browser.login_fill（findBrowserLoginFillFullName 定位 + mcpManager.callTool redactArgs 脱敏；
//     login_fill 不注册给模型）→ 三分支新 execResult 经 ctx.setExecResult 写回宿主、'handled_fallback'
//     回落通用落账路径（login 不自产 tool_result/落账 —— 与原分支体结束继续向下逐位一致）。
//   · grant：mcp__bobby__* 工具返回 grantRequired → SSE grant_required（带 target）旁路；不覆盖
//     execResult、不 continue（原分支 send 后无 continue，grantRequired 原文照常回灌模型）。
//     恢复链路在宿主侧之外：前端 ChatNodeKernel 记"等待授权"，BobbyNode 授权成功广播匹配后自动
//     补发"已授权，继续"消息触发模型重试，route 无独立恢复端点。
// mode 注入为 exec 前 pre 改写、browser.login 不在 P4a-2a args_transform 节点参数注入名单
// （NODE_PARAM_INJECT_TOOLS）内 → 以 args_transform 形态注册第二条目（按名匹配，互不重叠），
// 咨询点复用既有 takeoverOfKind(toolName,'args_transform') 位置 —— 不触碰既有名单条目逻辑；
// 与原内联 if 的等价性：browser.login 的 execArgs 无其它 pre 改写叠加（不在 butler 卡名单 /
// node 注入名单），注入输入恒为 tc.function.arguments、位置仍在 executeTool 前，行为逐位一致。
registerTakeover({
  kind: 'args_transform',
  phase: 'pre',
  name: '__browser_login_mode__',
  match: (name) => isBrowserLoginTool(name),
  transformArgs(_name, _args, _ctx) {
    // browser.login：强制注入 BobWork 弹窗模式 → 扩展不弹独立登录窗，返回 loginRequired，
    // 由本节点弹登录窗（凭据经 前端→服务端内存→MCP→扩展 直传，不过模型）。与原 if 内联同语义：
    // 参数 JSON 解析/回写失败 → null（原样传递）。
    try {
      const parsed = JSON.parse(_args) as Record<string, unknown>;
      parsed.mode = 'bobwork';
      return JSON.stringify(parsed);
    } catch {
      return null;
    }
  },
});
// 技能闸门（args_transform pre）：load_skill / read_skill_resource 只按名字在技能库里查，**不做身份校验**
// —— L1 目录剔除（BROWSER_SKILL_EXCLUSIONS）挡得住"模型看见"，挡不住"凭名调用"（模型可见已加载过的技能名）。
// 故把按身份剔除的清单随请求参数注入，由技能工具在执行点拒绝，并给出可执行的替代路径。
// 清单与 L1 目录同源（profiles.ts skillExclusionsFor），不会「目录里没有、却能凭名调进来」。
// 空清单返回 null（原样执行），对其它身份零影响。与节点参数注入 / browser.login mode 注入共用
// takeoverOfKind(toolName,'args_transform') 咨询点，三者 match 互不重叠。
registerTakeover({
  kind: 'args_transform',
  phase: 'pre',
  name: '__skill_gate__',
  match: (name) => name === 'load_skill' || name === 'read_skill_resource',
  transformArgs(_name, args, ctx) {
    try {
      const excluded = skillExclusionsFor(ctx.agentId ?? '');
      if (excluded.length === 0) return null;
      const parsed = JSON.parse(args) as Record<string, unknown>;
      parsed.__disallowed_skills = [...excluded];
      return JSON.stringify(parsed);
    } catch {
      return null;
    }
  },
});
// browser.login 挂起型接管 handler（复刻迁移前工具轮内联分支 4378-4448，行为不变；判定条件
// execResult.success + isBrowserLoginTool 分别由宿主 post 咨询点与注册 match 保证）。
async function handleBrowserLogin(ctx: HostTakeoverContext): Promise<HostTakeoverVerdict> {
  // ① loginRequired 判定（结果 JSON 解析失败 / 非 loginRequired → 'noop' 交还通用路径原样落账）
  let loginReq: { loginRequired?: boolean; siteName?: string; url?: string } | null = null;
  try {
    loginReq = JSON.parse(ctx.result ?? '');
  } catch {
    loginReq = null;
  }
  if (!(loginReq && loginReq.loginRequired)) return 'noop';
  // ② 登记挂起项 + SSE login_required（载荷字段与原分支一致：requestId / siteName / url /
  //    timeoutSec；siteName/url 兜底用 ctx.pageUrl —— 宿主注入的 lastPageUrl 请求态）
  const { requestId, promise } = createPendingLogin(ctx.nodeId);
  ctx.send({
    login_required: {
      requestId,
      siteName: loginReq.siteName || toolDisplaySiteName(ctx.pageUrl ?? undefined),
      url: loginReq.url || ctx.pageUrl || '',
      timeoutSec: Math.ceil(LOGIN_TIMEOUT_MS / 1000),
    },
    nodeId: ctx.nodeId,
  });
  // ③ 等待用户输入期间 SSE 无数据会被前端 90s 空闲超时误杀；每 20s 发心跳保持连接
  const loginKeepalive = setInterval(() => {
    ctx.send({ tool_call_update: { name: ctx.name, phase: 'running', spanId: ctx.spanId, startAt: ctx.startAt }, nodeId: ctx.nodeId });
  }, 20000);
  let creds: { username: string; password: string } | null;
  try {
    creds = await promise; // 前端弹窗提交回传；超时/关闭为 null
  } finally {
    clearInterval(loginKeepalive);
  }
  // ④ 三分支构造新 execResult 并经 setExecResult 写回宿主（回落通用落账路径，与原分支体对
  //    execResult 的直接改写等价）：
  //    - 有凭据 + login_fill 成功 → 代填摘要（凭据不进结果文本、redactArgs 不打印日志）；
  //    - 有凭据 + login_fill 抛错 → success:false 失败文案；
  //    - 无凭据（超时/关闭）→ "用户未在…输入凭据"成功文案。
  if (creds) {
    try {
      const fillFullName = await findBrowserLoginFillFullName();
      if (!fillFullName) {
        throw new Error('browser.login_fill 未找到（Bob WebBridge MCP 未连接或版本过旧）');
      }
      const { mcpManager } = await import('@/lib/mcp/manager');
      const fillRaw = await mcpManager.callTool(
        fillFullName,
        { username: creds.username, password: creds.password },
        { redactArgs: true }, // 凭据不打印到日志
      );
      const fillSummary = String(fillRaw).trim().replace(/\s+/g, ' ').slice(0, 300);
      ctx.setExecResult?.({
        result:
          `你已在 BobWork 登录弹窗中提交账号密码，WebBridge 已代填并提交登录表单。` +
          (fillSummary ? ` 结果：${fillSummary}` : ''),
        durationMs: 0,
        success: true,
      });
    } catch (e) {
      ctx.setExecResult?.({
        result:
          `收到登录凭据，但自动填写登录表单失败：${e instanceof Error ? e.message : String(e)}。` +
          '请如实告知用户该站点仍处于未登录状态，建议其在浏览器中手动登录。',
        durationMs: 0,
        success: false,
      });
    }
  } else {
    ctx.setExecResult?.({
      result:
        '用户未在 BobWork 登录弹窗中输入凭据（弹窗被关闭或超时）。' +
        '请如实告知用户该站点仍处于未登录状态，必要时引导其手动登录。',
      durationMs: 0,
      success: true,
    });
  }
  // 已构造并写回新 execResult → 'handled_fallback' 回落宿主通用落账路径（与原分支体结束继续向下等价）
  return 'handled_fallback';
}
registerHostTakeover({
  kind: 'login',
  phase: 'post',
  name: 'browser.login', // 匹配 browser.login / mcp__*__browser_login（与 mode 注入条目同一判定）
  match: (name) => isBrowserLoginTool(name),
  handle: handleBrowserLogin,
});
// bobby grant 旁路 handler（复刻迁移前工具轮内联分支 4366-4376，行为不变；判定 execResult.success
// 由宿主 post 咨询点保证、工具名 mcp__bobby__* 由注册 match 保证）。
async function handleBobbyGrant(ctx: HostTakeoverContext): Promise<HostTakeoverVerdict> {
  // ① grantRequired 判定：结果不含 'grantRequired' / JSON 解析失败 / 非 grantRequired → 'noop'
  const raw = ctx.result ?? '';
  if (!raw.includes('grantRequired')) return 'noop';
  try {
    const j = JSON.parse(raw) as { grantRequired?: boolean; target?: string };
    if (j.grantRequired && typeof j.target === 'string') {
      // ② 命中：SSE grant_required 旁路下发（前端 ChatNodeKernel 记"等待授权"，BobbyNode 授权
      //    成功广播匹配后自动补发"已授权，继续"消息触发模型重试 —— 用户无需手动回复）。
      //    不覆盖 execResult、不 continue → 'handled_fallback' 回落通用路径（grantRequired 原文
      //    照常作为工具结果回灌模型，与原分支 send 后无 continue 逐位一致）。
      ctx.send({ grant_required: { target: j.target }, nodeId: ctx.nodeId });
      return 'handled_fallback';
    }
  } catch { /* 非 JSON 忽略 */ }
  return 'noop';
}
registerHostTakeover({
  kind: 'grant',
  phase: 'post',
  name: 'mcp__bobby__*',
  match: (name) => name.startsWith('mcp__bobby__'),
  handle: handleBobbyGrant,
});

/**
 * DSH 模式（重构）：技能上下文注入。
 *  - L1 技能目录（名称+简介）始终注入，供模型参考技能库全貌；
 *  - L2 完整正文仅对用户手动勾选（forcedSkills）的技能注入；
 *  - 其余技能由模型通过 load_skill 工具按需加载，系统不再做关键词自动匹配。
 * 注入目标：当前轮 user 消息（缓存前缀稳定化，C8）。返回已注入技能名列表。
 */
interface SkillDetail {
  name: string;
  score: number;
  matchedKeywords: string[];
  bodyLength: number;
  forced: boolean;
}

function injectSkillContext(
  messages: ChatMessage[],
  forcedSkills?: string[],
  agentIdParam?: string,
): { messages: ChatMessage[]; matchedSkillNames: string[]; skillDetails: SkillDetail[] } {
  const userContent = extractLastUserContent(messages);
  if (!userContent) return { messages, matchedSkillNames: [], skillDetails: [] };

  const allDefs = getAllSkills();
  if (!allDefs.length) return { messages, matchedSkillNames: [], skillDetails: [] };

  // 2026-09-06 技能按 agent 分发：画像有独立技能池（agentSkills[agentId]）→ 用它的；
  // 否则回退 'default' 全局池（旧语义：enableSkill 只写 default / 未配置=全部技能默认启用）。
  const agentId = agentIdParam ?? 'default';
  const ownPool = getAgentSkills(agentId);
  const enabledSet = ownPool
    ? ownPool
    : hasAgentConfig('default')
      ? getEnabledSkillsForAgent('default')
      : new Set(allDefs.map(d => d.meta.name));

  if (!enabledSet.size) return { messages, matchedSkillNames: [], skillDetails: [] };

  // 侧边栏（browser 身份）剔除重产出型技能：本档没有 write_file / run_command，依赖落盘的
  // 技能跑到最后一步必然失败（见 profiles.ts BROWSER_SKILL_EXCLUSIONS），且其报告模板会与
  // Research 强制的骨架/脚注规范冲突。
  // 清单与技能调用的执行侧闸门同源（profiles.ts skillExclusionsFor → 本文件 __skill_gate__）：
  // 这里管「目录里看不见」，那里管「凭名调不动」，两处读同一函数不会脱节。
  const agentSkillExclusions = new Set<string>(skillExclusionsFor(agentId));
  const skillAllowed = (name: string) => !agentSkillExclusions.has(name);

  const availableSkills = allDefs
    .filter(d => enabledSet.has(d.meta.name) && skillAllowed(d.meta.name))
    .map(d => d.meta);

  const defMap = new Map(allDefs.map(d => [d.meta.name, d]));

  let matchedNames: string[] = [];

  // DSH 模式（重构）：不再做关键词自动匹配。技能加载决策权交给模型——
  //   系统只注入 L1 技能目录（名称+简介，常驻），供模型判断何时需要技能；
  //   L2 完整正文仅对用户手动勾选（forcedSkills）的技能直接注入；
  //   其余技能由模型在对话中调用 load_skill 工具按需加载完整指令。
  // 效果：如 "hello" 等无技能意图的输入不再误加载任何技能正文，杜绝无意义上下文占用。
  let allMatches: SkillMatchResult[] = [];

  if (forcedSkills && forcedSkills.length > 0) {
    console.log('[技能注入] forcedSkills 参数:', forcedSkills);
    // 强制技能：仅注入全局仍启用的，构造满分类匹配（L2 正文直接注入）
    const forcedDefs = allDefs.filter(
      d => forcedSkills.includes(d.meta.name) && enabledSet.has(d.meta.name) && skillAllowed(d.meta.name)
    );
    allMatches = forcedDefs.map(d => ({
      skillMeta: d.meta,
      score: 1.0,
      matchedKeywords: ['手动触发'],
    }));
    console.log('[技能注入] 强制技能(DSH模式):', forcedDefs.map(d => d.meta.name));
  }

  matchedNames = allMatches.map(m => m.skillMeta.name);

  // 4. 构建上下文：L1 始终传入完整 availableSkills，确保目录完整
  //    修复"L1目录不完整"漏洞
  const skillCtx = buildSkillContext(allMatches, defMap, availableSkills);

  console.log(
    '[技能注入] 最终注入(DSH模式):', matchedNames,
    '强制:', allMatches.length, '自动: 0',
    '可用技能数:', availableSkills.length,
    '上下文长度:', skillCtx?.length || 0,
  );

  if (!skillCtx) return { messages, matchedSkillNames: matchedNames, skillDetails: [] };

  // 匹配到法律技能时，强制注入防幻觉约束到最顶部（优先级高于技能正文）
  const isLegalQuery = allMatches.some(m => isLegalSkill(m.skillMeta));
  const prefixedCtx = isLegalQuery ? LEGAL_GUARD_PROMPT + '\n\n' + skillCtx : skillCtx;

  const result = [...messages];
  const forcedSet = new Set(forcedSkills ?? []);
  const skillDetails: SkillDetail[] = allMatches.map(m => {
    const def = defMap.get(m.skillMeta.name);
    return {
      name: m.skillMeta.name,
      score: m.score,
      matchedKeywords: m.matchedKeywords,
      bodyLength: def?.body?.length ?? 0,
      forced: forcedSet.has(m.skillMeta.name),
    };
  });
  // 缓存前缀稳定化（deepseek-harness C8）：技能上下文按当前轮用户输入动态匹配，属于"每轮易变"内容。
  // 若注入 system（缓存头），轮次间匹配结果变化 → 系统提示字节变化 → 前缀整段失效，命中率掉到个位数。
  // 改为 prepend 到当前轮（最后一条）user 消息：system + 历史前缀保持字节稳定（命中缓存），
  // 技能指令仍在同一请求内、紧跟用户请求，模型可见性与原注入等效。
  // 仅当最后一条消息是 user 时才 prepend（避免把易变内容写进历史中间的 user 消息，破坏历史字节稳定）；
  // 否则退回原逻辑注入 system。
  const last = result[result.length - 1];
  if (last && last.role === 'user') {
    const prev = (last.content || '');
    result[result.length - 1] = { ...last, content: prev ? prefixedCtx + '\n\n' + prev : prefixedCtx };
    return { messages: result, matchedSkillNames: matchedNames, skillDetails };
  }
  // 兜底：最后一条不是 user 消息（历史重放等边界）→ 追加一条 user 消息承载技能上下文，
  // 仍不进 system（C8：system 字节保持稳定，杜绝任何动态内容写入缓存头）
  result.push({ role: 'user', content: prefixedCtx });

  return { messages: result, matchedSkillNames: matchedNames, skillDetails };
}

/** 基础系统提示（缓存头）注入：保证 system 消息以 basePrompt 开头。
 *  basePrompt：当前 Agent 的基础系统提示——通用 Agent 用 BASE_SYSTEM_PROMPT，
 *  专项 Agent（如 coding）用自己的专属 base（见 AGENT_PROFILES.baseSystemPrompt）。
 *
 *  与「思考引导注入」解耦（2026-10-02 修）：原先两者耦合在同一个函数里、且调用侧用
 *  `shouldInjectThink ? injectThinkingPrompt(...) : messages` 三元守卫——DeepSeek V4 家族
 *  `shouldInjectThinkPrompt` 恒返回 false，导致 basePrompt 一并被跳过，V4 请求的 system 里
 *  只剩下前端那句短英文提示，BASE_SYSTEM_PROMPT / 各画像专属 base 全部没有下发。
 *  拆开后：**base 无条件注入**，只有思考引导受 shouldInjectThink 控制。
 *
 *  幂等：system 已存在且已以 basePrompt 开头时逐字节原样返回（缓存头稳定，不产生空转 diff）。 */
function ensureBaseSystemPrompt(
  messages: ChatMessage[],
  basePrompt: string = BASE_SYSTEM_PROMPT,
): ChatMessage[] {
  const sysIdx = messages.findIndex((m) => m.role === 'system');
  if (sysIdx < 0) {
    return [{ role: 'system', content: basePrompt }, ...messages];
  }
  const existingContent = messages[sysIdx].content || '';
  if (existingContent.startsWith(basePrompt.slice(0, 20))) return messages;
  const result = [...messages];
  result[sysIdx] = { ...result[sysIdx], content: basePrompt + '\n\n' + existingContent };
  return result;
}

/** 思考深度引导注入（不碰 system）。
 *  缓存前缀稳定化：思考指令随 level 变化，若注入 system（缓存头），用户在同一对话中切换
 *  思考深度 → system 字节变化 → 前缀整段失效，历史缓存全部作废。故一律 prepend 到当前轮
 *  最后一条 user 消息（level 变化只影响当前轮 user 消息）。 */
function injectThinkingGuidance(
  messages: ChatMessage[],
  level: ThinkingLevel,
  modelSupportsThinking = true,
): ChatMessage[] {
  let injection = SYSTEM_PROMPT_INJECTIONS[level];

  if (injection && !modelSupportsThinking) {
    // 非推理模型：去掉 <think></think> 标签引用，但保留思考引导内容
    injection = injection
      .replace(/思考过程用 <think><\/think> 标签包裹[。.]?/g, '')
      .replace(/用 <think><\/think> 标签包裹[。.]?/g, '')
      .replace(/用 <think> 标签包裹[。.]?/g, '')
      .replace(/所有分析用 <think> 标签包裹[。.]?/g, '')
      .replace(/\n{3,}/g, '\n\n');
  }

  if (!injection) return messages;

  const result = [...messages];
  const last = result[result.length - 1];
  if (last && last.role === 'user') {
    const prev = last.content || '';
    result[result.length - 1] = { ...last, content: prev ? injection + '\n\n' + prev : injection };
  } else {
    // 兜底：最后一条不是 user 消息（历史重放等边界）→ 追加一条 user 消息，仍不进 system
    result.push({ role: 'user', content: injection });
  }
  return result;
}

/**
 * 缓存前缀稳定化（deepseek-harness C8 扩展）：把「低频变化」的动态上下文块 prepend 到
 * 当前轮最后一条 user 消息，而不是追加进 system（缓存头）。
 *   - system 只含字节稳定的 BASE_SYSTEM_PROMPT → 所有节点/会话共享同一缓存前缀；
 *   - 项目路径 / 授权目录 / 镜像指引 / 偏好目录 / AI Coding 上下文等动态内容只影响当前轮
 *     user 消息（本轮内容本就每次不同），历史缓存不受影响；
 *   - 仅当最后一条消息是 user 时才 prepend（避免把易变内容写进历史中间的 user 消息，
 *     破坏历史字节稳定）；否则退回追加 system（历史重放等边界兜底）。
 */
function prependDynamicContext(messages: ChatMessage[], text: string): ChatMessage[] {
  const clean = (text || '').trimStart();
  if (!clean) return messages;
  const result = [...messages];
  const last = result[result.length - 1];
  if (last && last.role === 'user') {
    const prev = (last.content || '').trimStart();
    result[result.length - 1] = {
      ...last,
      content: prev ? clean + '\n\n' + prev : clean,
    };
    return result;
  }
  // 兜底：最后一条不是 user（历史重放等边界）→ 追加一条 user 消息承载动态内容，
  // 仍不进 system（C8：杜绝任何动态内容写入缓存头）
  result.push({ role: 'user', content: clean });
  return result;
}

/** 会话人设字段长度上限（与 node-chat/session 路由的清洗保持一致，这里再兜一层） */
const PERSONA_FIELD_MAX = 200;

/**
 * 会话级人设注入文本（新建会话时弹窗设定，与该会话同行存储、随会话删除）。
 *
 * 只覆盖**身份 / 语气 / 自称**——工具能力、权限边界、确认与安全规则一律不动，
 * 否则「填个人设」就变成了提权通道。仅在 identity==='butler' 且 persona.name 非空时调用。
 * 注入到 C8 低频通道（当前轮 user 消息前缀），system 缓存头保持字节稳定。
 */
function buildPersonaInjection(persona?: ButlerPersona | null): string {
  const name = typeof persona?.name === 'string' ? persona.name.trim().slice(0, PERSONA_FIELD_MAX) : '';
  if (!name) return '';
  const field = (k: keyof ButlerPersona): string => {
    const v = persona?.[k];
    return typeof v === 'string' ? v.trim().slice(0, PERSONA_FIELD_MAX) : '';
  };
  const lines = [`【本次会话人设】你正在以「${name}」的身份与用户对话，请始终以该身份自称与应答。`];
  const personality = field('personality');
  const role = field('role');
  const style = field('style');
  const addressUser = field('addressUser');
  if (personality) lines.push(`- 性格：${personality}`);
  if (role) lines.push(`- 身份 / 职责：${role}`);
  if (style) lines.push(`- 说话风格：${style}`);
  if (addressUser) lines.push(`- 称呼用户为：${addressUser}`);
  lines.push(
    '以上仅改变你的身份、语气与自称；工具能力、权限边界、安全与确认规则一律不变。' +
      '与默认管家口吻冲突时，以本节为准。',
  );
  return lines.join('\n');
}

/**
 * Bob-Mind 插件面板地址（宿主 iframe 嵌入同一实例；面板未运行时 fetch 失败即跳过）。
 * 端口由宿主编排时按实例分配（见 mcp manager），运行时表优先，未登记时回退预置固定地址。
 */
function mindPanelUrl(): string {
  const port = getPanelPort('bob-mind-mcp');
  if (port) return `http://127.0.0.1:${port}`;
  return MCP_PRESETS.find((p) => p.id === 'bob-mind-mcp')?.panel?.url ?? '';
}

/**
 * Bob-Mind（Buzan）面板改动回看注入：
 * 用户在插件面板手动增删改导图走插件的 REST，插件侧把它登记为「未回看改动」流水
 * （见 bob-mind-mcp/src/web/server.ts）。Buzan 是回合制的，收不到任何推送 ——
 * 所以仅当本轮是 mind agent 时，服务端取走这批流水（consume=1，取走即视为已回看）
 * 并拼成紧凑摘要 prepend 到本轮 user 消息，让它先 mind_query 再就改动表态。
 * 插件未运行/超时一律静默跳过，绝不阻塞对话。
 */
async function buildMindChangesInjection(agentId: string): Promise<string> {
  if (agentId !== 'mind') return '';
  const panelUrl = mindPanelUrl();
  if (!panelUrl) return '';
  const VERB: Record<string, string> = {
    save: 'added',
    update: 'edited',
    delete: 'deleted',
    move: 'moved',
    star: 'starred',
  };
  try {
    const resp = await fetch(`${panelUrl}/api/changes?consume=1`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });
    if (!resp.ok) return '';
    const data = (await resp.json()) as { changes?: Array<{ action?: unknown; title?: unknown }> };
    const list = Array.isArray(data?.changes) ? data.changes : [];
    if (!list.length) return '';
    const lines = list.slice(-12).map((c) => {
      const verb = VERB[String(c.action)] || String(c.action || 'changed');
      return `- ${verb}: ${String(c.title || '').slice(0, 60)}`;
    });
    let block =
      `[Bob-Mind panel changes since your last review — ${list.length} edit(s), newest last]\n` +
      'The user edited the mind map in the Bob-Mind panel after you last looked. Call mind_query first ' +
      'to see the current tree, then give your take on these edits (agree or disagree, with reasons) ' +
      '— as a partner, not a passive recorder.\n' +
      lines.join('\n');
    if (block.length > 800) block = `${block.slice(0, 800)}…`;
    return block;
  } catch {
    return ''; // 插件未运行/超时：静默跳过，不影响本轮对话
  }
}

/**
 * 工具循环不设轮数硬上限：任务只要在推进，就一直做下去直到完成。
 * 仅保留「停滞保护」安全网（不是轮数限制）：
 * - STALL_LIMIT：连续 N 轮没有任何实质进展（无成功工具结果 / 工具全部失败或重复 / 无文本输出）→ 判定死循环，强制收尾
 * - MAX_DUPLICATE_CALLS：同一工具+相同参数的重复次数限制（防模型原地打转）
 */
const STALL_LIMIT = 3;

/** AI Coding（绑定小程序）任务硬预算（2026-10-10 评估 B4）：
 *  小程序迭代是"改码 → 预览截图 → 再改"的**交替调用**，单工具收敛/停滞保护都难触发，
 *  叠加"失败被误判成功"时可无限烧 token。这里给 coding 任务加轮数 + 墙钟双阈值，
 *  超限即注入收尾说明并进入强制收尾轮（只触发一次，见 kctx.taskBudgetExceeded）。 */
const CODING_TASK_MAX_ROUNDS = 25;
const CODING_TASK_MAX_MS = 10 * 60 * 1000;
/** 同一工具+相同参数的最大重复次数 */
const MAX_DUPLICATE_CALLS = 2;
/** 页面状态已变（同参数调用之后发生过页面交互）时的放宽上限。
 *  交互（切 tab / 展开 / 加载更多 / 脚本改 DOM）不改 URL，却会让上一次的读取结果失效；
 *  此时若仍按 2 次封顶，模型会被回灌「请基于已有结果回答」——等于逼它用陈旧内容。
 *  放宽到 6 给足「每次交互后重读一次」的余量，同时保留硬顶，防止「读-滚-读」原地打转。 */
const MAX_DUPLICATE_CALLS_AFTER_INTERACTION = 6;
/** OCR 识别重试预算：同一文件被 ocr_document/crop_image 反复识别的最大次数。
 * 超过即判定手写字段识别不收敛，注入提示要求停止重试并报 NEED_REVIEW（治"15+ 轮空转"）。 */
const OCR_REOCR_BUDGET = 4;
/** 工具收敛护栏：同一工具连续「主导」的轮数上限。
 * 与停滞保护互补 —— 停滞保护抓「连续多轮无实质进展」，抓不住另一种卡法：每轮都有成功工具调用
 * （被判为推进、stallCount 反复清零），但方向永不收敛（逐条穷举检索 / 反复重写同一文件），
 * 最终只能烧到时间预算才被迫收口。超过本阈值即注入「停止穷举」指令并强制收尾。
 *
 * 取 3（原 6）：模型每轮可**并行**发起多个工具调用（实测一次复现为「3 轮 × 6 次 get_article」），
 * 而本护栏按「轮」自增，轮数远小于调用数 —— 原阈值 6 轮在并行形态下要烧到 30+ 次调用才够得着，
 * 与「12 次调用附近收口」的设计意图不符，真实穷举因此逃逸（实测 18 次连续调用零触发）。 */
const TOOL_CONVERGENCE_ROUNDS = 3;
/** 触发收敛护栏所需的同一工具累计调用次数（与轮数双阈值，避免正常多文件读取等短程重复被误判）。
 * 取 20（原 12）：实测合法的「逐条核对民法典 577~594 条」正是 18 次调用后自然收尾 —— 阈值必须高于它，
 * 否则会截断本可正常完成的批读任务；而真实卡死样本为 71 次调用（143s 无结论），20 次即拦。 */
const TOOL_CONVERGENCE_MIN_CALLS = 20;
/** 声明真实性校验：最多注入纠偏消息的次数（防止无限纠偏循环） */
const MAX_CLAIM_MISMATCH_CORRECTIONS = 2;

/**
 * 声明真实性校验（Claim Verification）
 *
 * 问题：模型可能在正文里声称"已写入文件 xxx.md"但实际并未调用 write_file，
 * 或调用了但返回失败。服务端只校验"被调用的工具是否成功"，不校验"模型文字声明
 * 是否与工具调用记录吻合"。这导致模型可以"幻觉式完成"——谎报结果而系统不发现。
 *
 * 方案：解析模型本轮正文中的完成性声明（写入/生成/创建/保存了某文件），
 * 反查 allToolCalls 记录，确认对应工具确实成功执行过。不匹配则返回纠偏指令。
 *
 * @returns 不匹配声明列表 + 纠偏消息（null 表示无声明或不需纠偏）
 */
function verifyClaimsAgainstToolRecords(
  assistantText: string,
  allToolCalls: Array<{ toolName: string; arguments: Record<string, unknown>; result: string; success: boolean }>,
): { mismatches: string[]; correction: string | null } {
  // 提取 <think> 外的正文（声明只在正文里，不在思考块里）
  const thinkMatch = assistantText.match(/<think>[\s\S]*?<\/think>\s*/i);
  const body = thinkMatch ? assistantText.slice(thinkMatch[0].length) : assistantText;
  if (!body.trim()) return { mismatches: [], correction: null };

  // 匹配完成性声明：已写入/已生成/已创建/已保存 + 文件路径
  // 覆盖中英文：已写入/written/已生成/generated/已创建/created/已保存/saved
  const claimPatterns: Array<{ regex: RegExp; tool: string; argKey: string }> = [
    // write_file: "已写入 xxx.md" / "written to xxx" / "file written: xxx"
    { regex: /(?:已写入|已保存到?|写入成功|written\s+to|file\s+written[:\s]+|saved\s+(?:to\s+)?)([^\s，。,;.!！\n'"`<>]{2,120}\.(?:md|txt|json|js|ts|tsx|jsx|html|css|py|sh|yaml|yml|csv|pdf|png|jpg|jpeg|svg))/gi, tool: 'write_file', argKey: 'path' },
    // generate_image: "已生成图片 xxx.png" / "generated image xxx"
    { regex: /(?:已生成(?:图片|图像)?|generated\s+image(?:\s+(?:to|at|:))?)\s*([^\s，。,;.!！\n'"`<>]{2,120}\.(?:png|jpg|jpeg|svg|gif|webp))/gi, tool: 'generate_image', argKey: 'file_path' },
  ];

  const mismatches: string[] = [];
  for (const { regex, tool, argKey } of claimPatterns) {
    const matches = body.matchAll(regex);
    for (const m of matches) {
      const claimedPath = argKey === '__any__' ? null : m[1];
      // 反查 allToolCalls：该工具是否成功执行过
      const relevantCalls = allToolCalls.filter((tc) => tc.toolName === tool && tc.success);
      if (relevantCalls.length === 0) {
        // 工具从未成功执行过 → 声明虚假
        mismatches.push(
          claimedPath
            ? `声称已${tool === 'write_file' ? '写入' : tool === 'generate_image' ? '生成' : '处理'} "${claimedPath}"，但 ${tool} 从未被成功调用`
            : `声称已完成 ${tool}，但该工具从未被成功调用`,
        );
        continue;
      }
      // 对于有路径的声明，进一步检查路径是否匹配
      if (claimedPath) {
        const normalizedClaim = claimedPath.replace(/\\/g, '/').toLowerCase();
        const pathMatched = relevantCalls.some((tc) => {
          const actualPath = String(tc.arguments[argKey] ?? '').replace(/\\/g, '/').toLowerCase();
          if (!actualPath) return false;
          // 包含匹配：声明路径是实际路径的子串或反之（处理相对/绝对路径差异）
          return actualPath.endsWith(normalizedClaim) || normalizedClaim.endsWith(actualPath) || actualPath === normalizedClaim;
        });
        if (!pathMatched) {
          mismatches.push(`声称已处理 "${claimedPath}"，但 ${tool} 成功记录中的路径均不匹配`);
        }
      }
    }
  }

  if (mismatches.length === 0) return { mismatches: [], correction: null };

  const correction = [
    '⚠️ 声明真实性校验未通过：以下操作被声称完成但工具调用记录中未找到对应的成功执行：',
    ...mismatches.map((m, i) => `  ${i + 1}. ${m}`),
    '',
    '请立即调用相应工具真正执行上述操作，不要用文字描述代替工具调用。只有工具返回成功结果后，才算真正完成。',
  ].join('\n');

  return { mismatches, correction };
}

/**
 * PDF 读取完整性校验（防"残缺输入上的幻觉式完成"）
 *
 * 背景：多页渲染失败时单页回退只返回第 1 页（工具结果带 `⚠ INCOMPLETE: page 1 of N`
 * 机器可读硬标记），截断时也带 `⚠ INCOMPLETE: pages a-b of N`。若模型在正文声称
 * "已完整读取/分析整份 PDF" 并据此给出结论，但工具记录里其实只有残缺页——
 * 必须拦截，强制分页续读后再作答。
 *
 * @returns 不匹配项 + 纠偏消息（null 表示模型无"完整读取"声明，或工具结果无 INCOMPLETE 标记）
 */
function verifyPdfReadCompleteness(
  assistantText: string,
  allToolCalls: Array<{ toolName: string; arguments: Record<string, unknown>; result: string; success: boolean }>,
): { mismatches: string[]; correction: string | null } {
  // 提取 <think> 外的正文（声明只在正文里）
  const thinkMatch = assistantText.match(/<think>[\s\S]*?<\/think>\s*/i);
  const body = thinkMatch ? assistantText.slice(thinkMatch[0].length) : assistantText;
  if (!body.trim()) return { mismatches: [], correction: null };

  // 1) 模型是否声明"完整读取/分析"了某 PDF（完成性声明，中英文覆盖）
  const completeClaimRe =
    /(?:已?完整(?:读取|识别|分析|浏览|阅览)|已(?:通读|读完整份|阅完|识别完|分析完)|全部(?:页|内容|页面)(?:都)?(?:已)?(?:读取|识别|分析)|整份(?:PDF|文档)(?:已)?(?:读取|识别|分析|审阅)|已读取(?:全部|所有)(?:页|内容)|基于(?:整个|完整)文档|based\s+on\s+(?:the\s+)?(?:entire|complete|full)\s+(?:document|pdf))/gi;
  if (!completeClaimRe.test(body)) return { mismatches: [], correction: null };

  // 2) 反查 read_attachment 成功结果中的 INCOMPLETE 硬标记
  const INC_RE = /INCOMPLETE:\s*(?:page|pages)\s+([0-9,\s-]+?)\s+of\s+(\d+|\?)/i;
  const incomplete: Array<{ path: string; pageNo: number; total: number }> = [];
  for (const tc of allToolCalls) {
    if (tc.toolName !== 'read_attachment' || !tc.success) continue;
    const m = (tc.result || '').match(INC_RE);
    if (m) {
      const total = parseInt(m[2], 10);
      incomplete.push({
        path: String(tc.arguments.path ?? ''),
        pageNo: parseInt(m[1], 10) || 1,
        total: Number.isFinite(total) ? total : 0,
      });
    }
  }
  if (incomplete.length === 0) return { mismatches: [], correction: null };

  // 3) 构造纠偏：对每个残缺 PDF 给出续读指令（剩余页区间）
  const mismatches = incomplete.map(({ path, pageNo, total }) =>
    total > 0
      ? `声称已完整读取 "${path}"，但工具返回带 INCOMPLETE 标记（仅第 ${pageNo} 页，共 ${total} 页）`
      : `声称已完整读取 "${path}"，但工具返回带 INCOMPLETE 标记（仅第 ${pageNo} 页，总页数未知）`,
  );
  const hints = incomplete
    .filter((x) => x.total > x.pageNo)
    .map(({ path, pageNo, total }) => `- 调用 read_attachment(path="${path}", pages="${pageNo + 1}-${total}") 续读剩余 ${total - pageNo} 页`);
  const correction = [
    '⚠️ PDF 读取完整性校验未通过：以下文件被声称"完整读取/分析"，但工具返回结果带有 INCOMPLETE 标记（只识别了部分页）：',
    ...mismatches.map((m, i) => `  ${i + 1}. ${m}`),
    '',
    '请先分页续读完整内容，再基于完整内容作答，禁止基于残缺页下结论：',
    ...(hints.length > 0 ? hints : ['- 使用 read_attachment(path="...", pages="页码区间") 分页读取剩余页']),
  ].join('\n');

  return { mismatches, correction };
}

/**
 * 笔记读取声明校验（第二类死角）：模型声称"根据笔记/库里/你记录的回答"，
 * 但工具记录中从未成功调用 read_notebook / read_note / read_raw_inbox。
 * 与第一类死角（全程零工具调用）互补：此处是"调了工具但没读笔记就冒充引用了笔记"。
 *
 * @returns mismatches 非空 = 存在"声称引用笔记但未读取"的幻觉声明
 */
function verifyNoteReadClaims(
  assistantText: string,
  allToolCalls: Array<{ toolName: string; arguments: Record<string, unknown>; result: string; success: boolean }>,
): { mismatches: string[]; correction: string | null } {
  // 提取 <think> 外的正文（声明只在正文里）
  const thinkMatch = assistantText.match(/<think>[\s\S]*?<\/think>\s*/i);
  const body = thinkMatch ? assistantText.slice(thinkMatch[0].length) : assistantText;
  if (!body.trim()) return { mismatches: [], correction: null };

  // "声称基于个人笔记/知识库回答"的中文表述。核心信号：个人库知识词(笔记/知识库/素材/记录/整理)
  // 之后 15 字内紧跟"引用谓词"(有/是/记录/提到/查到/写着/讲过…) = 声称读取过内容。
  // 操作性语句("记了一条笔记到素材库"——谓词在知识词前)与法律条文引用(无知识词)不命中。
  const noteClaimRe =
    /(?:你的?|我的?|个人)?(?:笔记|知识库|素材库|素材|记录|整理(?:过|的)?(?:内容|笔记)?|库(?:里|中|内)?)(?:[^。！？\n]{0,15}?(?:有|是|提到|写了|记录|说|查到|见过|保存|收录|写着|讲过|上面写|来看|可知|显示|得知))/i;
  if (!noteClaimRe.test(body)) return { mismatches: [], correction: null };

  // 反查：是否成功调用过笔记读取工具
  const noteTools = ['read_notebook', 'read_note', 'read_raw_inbox'];
  const hasRead = allToolCalls.some((tc) => noteTools.includes(tc.toolName) && tc.success);
  if (hasRead) return { mismatches: [], correction: null };

  return {
    mismatches: ['声称基于个人笔记/知识库回答，但本会话从未成功调用 read_notebook / read_note / read_raw_inbox 读取过任何笔记——请核实答案是否凭空编造，必要时先检索笔记再作答。'],
    correction: null,
  };
}

/** 当前对话模型是否支持视觉（直连多模态前提）。
 *  与模型池/API 标注同源（model-tags.isVisionModel），并排除 ocr 专用转录模型
 *  （qwen-vl-ocr 等只能走 OCR 工具转录，不能作为对话看图模型）。 */
function chatModelSupportsVision(modelId?: string): boolean {
  // 三种口径取或：名字正则（model-tags）∪ 模型池能力注册表（supports_vision 等厂商声明）
  // ∪ 预设显式声明（spec.capabilities 含 'vision'）。
  // 二者/三者对齐后，deepseek-flash（V4.1-Flash）这类「名字无视觉字样但厂商声明多模态」
  // 的模型也能直连，不会因正则漏判而错误降级为 bob-ocr 描述注入。
  // 预设声明是同步可读的，不依赖 /api/models 先把注册表填好（重启后未拉模型列表也可判定）。
  return isVisionModel(modelId || '') || isDeclaredVisionModel(modelId || '') || isPresetVisionModel(modelId || '');
}

/** Vision Bridge：自动检测图片附件，用视觉模型描述后注入文本 */
async function applyVisionBridge(
  messages: ChatMessage[],
  onProgress?: (p: { phase: string; current: number; total: number }) => void,
): Promise<ChatMessage[]> {
  const hasImageAttachment = messages.some((m) => {
    if (m.role !== 'user') return false;
    const c = m.content || '';
    return c.includes('图片') && (c.includes('路径: materials/') || c.includes('路径: attachments/') || c.includes('路径: assets/'));
  });

  if (!hasImageAttachment) {
    return messages;
  }

  try {
    const project = await getCurrentProject();

    const imagePaths: string[] = [];
    messages.forEach((m) => {
      if (m.role === 'user') {
        const matches = (m.content || '').match(/路径: ((?:materials|attachments|assets)\/[^\\n]+)/g);
        if (matches) {
          matches.forEach((match) => {
            const path = match.replace('路径: ', '');
            const ext = path.split('.').pop()?.toLowerCase();
            if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
              imagePaths.push(path);
            }
          });
        }
      }
    });

    if (imagePaths.length === 0) {
      return messages;
    }
    onProgress?.({ phase: 'start', current: 0, total: imagePaths.length });

    const descriptions: string[] = [];
    for (let i = 0; i < imagePaths.length; i++) {
      const imgPath = imagePaths[i];
      const filePath = `${project.path}/${imgPath}`;
      onProgress?.({ phase: 'image', current: i + 1, total: imagePaths.length });
      try {
        // 心跳保活：单图多候选模型串行识别可能超过 90s 无输出（每候选 30-40s × 降级链），
        // 周期发送进度帧，前端任一 SSE 帧即重置 90s 空闲超时计时器，避免识别中被误杀。
        let beat = 0;
        const heartbeat = setInterval(() => {
          beat += 1;
          onProgress?.({ phase: 'recognizing', current: i + 1, total: imagePaths.length });
        }, 15_000);
        try {
          // 图片理解统一走 bob-ocr-mcp（ocr.image_understand general 模式）；配置已收敛到插件，MCP 不可用则跳过该图描述
          const { ocrImageUnderstandViaMcp } = await import('@/lib/mcp/ocr-client');
          const viaMcp = await ocrImageUnderstandViaMcp(filePath, { mode: 'general' });
          if (viaMcp) {
            descriptions.push(`图片描述: ${viaMcp.understanding}`);
          } else {
            console.warn('bob-ocr-mcp 视觉模型不可用，跳过图片描述');
          }
        } finally {
          clearInterval(heartbeat);
        }
      } catch (e) {
        console.warn('视觉模型分析图片失败:', e);
      }
    }

    if (descriptions.length === 0) {
      return messages;
    }

    const modifiedMessages: ChatMessage[] = [];
    for (const m of messages) {
      if (m.role === 'user') {
        const hasImage = (m.content || '').includes('图片') && ((m.content || '').includes('路径: materials/') || (m.content || '').includes('路径: attachments/') || (m.content || '').includes('路径: assets/'));
        if (hasImage) {
          modifiedMessages.push({
            ...m,
            content: (m.content || '') + `\n\n[图片已通过视觉模型描述如下：\n${descriptions.join('\n')}\n]`,
          });
        } else {
          modifiedMessages.push(m);
        }
      } else {
        modifiedMessages.push(m);
      }
    }

    return modifiedMessages;
  } catch (e) {
    console.warn('Vision Bridge 执行失败:', e);
    return messages;
  }
}

// ==================== Vision Bridge ====================

// ==================== Direct Multimodal（视觉模型直连图片） ====================
// 与 Vision Bridge（bob-ocr-mcp 描述注入）互斥：当前轮对话模型本身支持视觉时，
// 把图片附件以 OpenAI 兼容 image_url content 段直接随消息发给模型，保留原图像素，
// 不再降级为「视觉模型描述 → 文本注入」。图片只在发送体里出现：
//   - kctx.conversationMessages 始终保持纯文本（路径引用），不污染日志/持久化/压缩；
//   - base64 在 turn 开始时一次性读取，按消息索引缓存，供工具循环各轮复用。

/** 可作为多模态输入直接发送的栅格图扩展名 → MIME（OpenAI 兼容 data URL） */
const DIRECT_VISION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
/** 单张图片体积上限：base64 会膨胀约 33%，超限跳过直连（保留文本，read_attachment 兜底） */
const DIRECT_VISION_MAX_BYTES = 12 * 1024 * 1024;
/** 直连时注入模型侧的说明：图片已直接可见，避免模型对已附像素的图片再跑 read_attachment */
const DIRECT_VISION_NOTE =
  '[本消息的图片附件已以多模态图像直接提供，可直接查看图片内容，无需对它们调用 read_attachment；资料列表中的 PDF/Office/表格等文件如需读取，仍请使用 read_attachment。]';

/** 单个 OpenAI 兼容 image_url content 段 */
interface DirectVisionImagePart {
  type: 'image_url';
  image_url: { url: string };
}

/** 直连计划项：某条 user 消息在发送数组中的下标 + 已读取成功的图片段 */
interface DirectVisionPayload {
  index: number;
  /** 该消息原始文本（payload 物化时作为 text 段整体回填） */
  text: string;
  parts: DirectVisionImagePart[];
}

/** 提取消息文本中「路径: materials|attachments|assets/…」的栅格图相对路径（去重） */
function extractDirectVisionRelPaths(content: string): string[] {
  const rels: string[] = [];
  const seen = new Set<string>();
  const re = /路径:\s*((?:materials|attachments|assets)\/[^\n]+)/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(content))) {
    const rel = mm[1].trim();
    const ext = rel.split('.').pop()?.toLowerCase() ?? '';
    if (!rel || !DIRECT_VISION_MIME[ext] || seen.has(rel)) continue;
    seen.add(rel);
    rels.push(rel);
  }
  return rels;
}

/** 以纯文本消息为输入构建直连计划：读取图片→base64 data URL（越权/超限/失败一律跳过该图）。 */
function buildDirectVisionPayloads(messages: ChatMessage[], projectRoot: string): DirectVisionPayload[] {
  const payloads: DirectVisionPayload[] = [];
  const rootPrefix = projectRoot.endsWith(sep) ? projectRoot : projectRoot + sep;
  messages.forEach((m, index) => {
    if (m.role !== 'user' || typeof m.content !== 'string') return;
    const rels = extractDirectVisionRelPaths(m.content);
    if (rels.length === 0) return;
    const parts: DirectVisionImagePart[] = [];
    for (const rel of rels) {
      try {
        const abs = resolve(projectRoot, rel);
        // 越权护栏：只允许项目根内文件（与附件/成果路径白名单同语义）
        if (!abs.startsWith(rootPrefix)) continue;
        if (!existsSync(abs)) continue;
        const size = statSync(abs).size;
        if (size <= 0 || size > DIRECT_VISION_MAX_BYTES) continue;
        const ext = rel.split('.').pop()?.toLowerCase() ?? '';
        const dataUrl = `data:${DIRECT_VISION_MIME[ext]};base64,${readFileSync(abs).toString('base64')}`;
        parts.push({ type: 'image_url', image_url: { url: dataUrl } });
      } catch (e) {
        console.warn(`[direct-vision] 图片直连读取失败，跳过（保留文本兜底）: ${rel}`, e instanceof Error ? e.message : String(e));
      }
    }
    if (parts.length > 0) {
      payloads.push({ index, text: m.content, parts });
    }
  });
  return payloads;
}

/**
 * 按直连计划把纯文本消息物化为「text + image_url」多模态 payload（每轮请求前调用）。
 * 未命中计划的索引原样透传；conversationMessages 本身不被改写。
 */
function materializeDirectVisionMessages(
  messages: ChatMessage[],
  payloads: DirectVisionPayload[],
): unknown[] {
  const byIndex = new Map<number, DirectVisionPayload>(payloads.map((p) => [p.index, p]));
  if (byIndex.size === 0) return messages;
  return messages.map((m, i) => {
    const p = byIndex.get(i);
    if (!p) return m;
    return {
      ...m,
      content: [
        { type: 'text', text: `${DIRECT_VISION_NOTE}\n\n${p.text}` },
        ...p.parts,
      ],
    };
  });
}

/**
 * 按 nodeId 定位节点所属项目（chat 链路专用）。
 * 背景：普通画布节点请求不带 projectId，后端此前一律用「全局激活项目」，当节点所在项目
 * ≠ 激活项目时，loadNodeById 找不到节点 → sandbox_app_id / 上游成果注入静默失败
 * （典型症状：新建 Coding 节点绑定小程序后 AI "找不到程序的存放位置"）。
 * 规则：1) 显式 projectId 优先；2) 否则先试当前激活项目；3) 仍找不到则遍历全部非归档项目定位。
 */
async function resolveNodeProject(
  nodeId: string | undefined,
  projectId?: string,
): Promise<ProjectConfig | null> {
  if (projectId) {
    try {
      return await getProjectById(projectId);
    } catch {
      return null;
    }
  }
  if (!nodeId) {
    try {
      return await getCurrentProject();
    } catch {
      return null;
    }
  }
  try {
    const cur = await getCurrentProject();
    if (await loadNodeById(nodeId, cur.path)) return cur;
  } catch {
    /* 无激活项目，继续遍历 */
  }
  try {
    const { projects } = await listProjects();
    for (const p of projects) {
      if (p.archived || p.hidden) continue;
      try {
        if (await loadNodeById(nodeId, p.path)) return p;
      } catch {
        /* 单个项目读取失败跳过 */
      }
    }
  } catch {
    /* 项目列表读取失败忽略 */
  }
  return null;
}

// ==================== Node Bridge（v3：上游成果块注入 + 托管模型自动派发实习生） ====================

/** R-14：注入总长上限（超过自动回退：裁剪旧对话重试，注入独占时才拒绝）
 * 动态方案：闸值 = contextGateForContext(当前请求模型 contextWindow)，见 src/lib/context-limits.ts；
 * 1M→200000、256k→51200、128k→25600、8k→1600，下限 32000，为对话历史 + 上游注入留足空间，同时给模型输出预留余量 */

/** 系统提示引导语（规格 v3 §七） */
const UPSTREAM_GUIDE_PROMPT = `以下是上游节点已锁定的成果，是本节点分析的既定前提。
其中的事实认定与法律依据可直接引用，无需重新论证。
「明确排除」中的路径已被否定，不要重复提出。
如需推翻上游结论，必须显式指出，不得默默改用其他前提。

上游成果中未涵盖的内容，你有三个选择，按顺序尝试：
1. read_manifest(node_id) 查看祖先节点目录
2. intern_search(node_id, instruction) 取回原始对话片段（返回内容恒标 [原始对话·未认定]，引用时须标 [存疑] 或转入 pending）
3. 若仍无所获，在 pending 中写明「上游未认定 xxx，需回溯确认」并停止推理

严禁基于常理、惯例或合理推断填补上游未认定的事实。

引用格式：当回答引用了上游成果块（已锁定）或实习生取回的内容时，请在回答末尾附加引用元数据块（正文引用处用 [1]、[2] 角标对应 id）：
<!-- CITATIONS -->
[{"id":1,"node":"n_003","block":"facts","anchor":"fact-2","preview":"内容一句话摘要","status":"locked"}]
<!-- /CITATIONS -->
- status: locked = 上游成果块（已签字，可直接引用）；unverified = 实习生返回（未认定，须标 [存疑] 或转 pending）
- 无引用时不输出该块。`;

/**
 * 从被 R-14 裁剪掉的消息中提取 (user, assistant) 轮次（缓存感知压缩的输入）。
 * 裁剪按数组头部成对丢弃，这里同样从头部扫描；单条不成对的 user 也按一轮计入。
 */
function extractTrimmedTurns(original: ChatMessage[], trimmed: ChatMessage[]): ConversationTurn[] {
  const cutCount = original.length - trimmed.length;
  if (cutCount <= 0) return [];
  const cut = original.slice(0, cutCount);
  const turns: ConversationTurn[] = [];
  for (let i = 0; i < cut.length; i += 2) {
    const u = cut[i];
    const a = cut[i + 1];
    if (u?.role !== 'user') continue;
    turns.push({
      question: typeof u.content === 'string' ? u.content : '',
      answer: a && a.role === 'assistant' && typeof a.content === 'string' ? a.content : '',
      questionTime: '',
      answerTime: '',
    });
  }
  return turns;
}

/** 读取 settings 中第一个可用自定义 provider 作为压缩模型（与 /api/nodes 增量压缩同款优先级） */
async function resolveCompactModelConfig(): Promise<CompactModelConfig | null> {
  try {
    const settings = await readSettingsFromFile();
    const providers = (settings as { providers?: Array<{ enabled?: boolean; apiKey?: string; baseUrl?: string; defaultModel?: string; models?: Array<{ enabled?: boolean; id?: string }> }> }).providers || [];
    const firstEnabled = providers.find((p) => p.enabled !== false && p.apiKey && p.baseUrl);
    if (!firstEnabled) return null;
    const defaultModel =
      firstEnabled.defaultModel ||
      firstEnabled.models?.find((m) => m.enabled)?.id ||
      firstEnabled.models?.[0]?.id;
    if (!defaultModel) return null;
    return { apiKey: firstEnabled.apiKey!, baseURL: firstEnabled.baseUrl!, model: defaultModel };
  } catch {
    return null;
  }
}

/**
 * chat 侧压缩模型配置三来源解析（R-14-C，与 /api/nodes append 侧 L474-485 同语义）：
 *   1) 请求体透传 compact_model_config（节点自定义模型正在用它，随 /api/chat 请求带来，
 *      能省 Key 就省——避免这里再回退 settings 换 Key/换供应商）；字段校验同 append 侧
 *      （apiKey/baseURL/model 均为字符串）。
 *   2) settings 第一个可用自定义 provider + 默认聊天模型（既有 resolveCompactModelConfig）。
 *   3) 当前 chat 请求模型回退：本次请求实际用的模型（providerModelId + baseUrl + 明文 apiKey）。
 *      key/baseUrl 在路由兜底解析后已以「可发请求」的明文形式就绪（前端直传，或 settings 经
 *      readSettingsFromFile→decryptSettings 解密）——复用当前请求模型发压缩可再省一次 Key 查找，
 *      且压缩模型与对话模型同源、口径一致；托管池模型无明文 Key 时该项跳过。
 *   仍无 → null → 折叠降级 compactionFallbackSummary 硬事实直写（现网行为不变）。
 */
async function resolveChatCompactModelConfig(
  bodyCompactCfg: { apiKey?: string; baseURL?: string; model?: string } | undefined,
  currentModel: { apiKey?: string; baseUrl?: string; model?: string } | null,
): Promise<CompactModelConfig | null> {
  // 1) 请求体透传（校验同 append：三者均须为字符串）
  if (
    bodyCompactCfg &&
    typeof bodyCompactCfg.apiKey === 'string' &&
    typeof bodyCompactCfg.baseURL === 'string' &&
    typeof bodyCompactCfg.model === 'string'
  ) {
    return { apiKey: bodyCompactCfg.apiKey, baseURL: bodyCompactCfg.baseURL, model: bodyCompactCfg.model };
  }
  // 2) settings（既有）
  const fromSettings = await resolveCompactModelConfig();
  if (fromSettings) return fromSettings;
  // 3) 当前请求模型回退（三项均明文就绪才可复用；托管池无明文 Key → null）
  if (currentModel && currentModel.apiKey && currentModel.baseUrl && currentModel.model) {
    return { apiKey: currentModel.apiKey, baseURL: currentModel.baseUrl, model: currentModel.model };
  }
  return null;
}

/**
 * 缓存感知压缩（R-14-C）：R-14 裁剪旧对话时，把被裁轮次增量压缩进节点压缩记忆并推进
 * memory_compacted_until（持久化）。
 *   - 信息不丢：被裁文本 → runCompaction 合并进 compressedMemory（含硬事实 R-27 兜底）；
 *   - 前缀稳定：下一轮前端 compactedUntilRef 读到推进后的游标 → 跳过这些轮次不再发送 →
 *     请求前缀与裁剪后一致 → 命中 DeepSeek 前缀缓存（否则每轮重新裁剪、前缀漂移、全价重算）。
 * 返回更新后的压缩记忆渲染文本（供本轮注入兜底），无变化返回 null。
 * 模型调用失败 / 冷却期内 → 降级为硬事实直写（不 throw，不阻断裁剪主流程）。
 */
async function compactTrimmedHistoryForCache(
  nodeId: string,
  project: Awaited<ReturnType<typeof getCurrentProject>> | null,
  trimmedTurns: ConversationTurn[],
  taskId: string,
  eventLog: EventLog,
  /** R-14-C 压缩模型配置（由 POST 侧按「请求透传 → settings → 当前请求模型」三来源解析后传入；null=无可用模型） */
  modelCfg: CompactModelConfig | null,
): Promise<string | null> {
  if (!nodeId || !project || trimmedTurns.length === 0) return null;

  // 写回前重新读取节点（压缩可能耗时，期间节点可能被 /api/nodes 并发写入，避免覆盖丢失）
  const node = await loadNodeById(nodeId, project.path);
  if (!node) return null;

  const compactedUntil = node.frontmatter.memory_compacted_until ?? 0;
  const newUntil = Math.min(compactedUntil + trimmedTurns.length, node.conversations.length);
  // 被裁轮次已全部被压缩覆盖 → 无需重复压缩（信息已有压缩记忆兜底）
  if (newUntil <= compactedUntil) return null;

  const existing = node.compressedMemory || '';
  const finalText = trimmedTurns.reduce((s, t) => s + (t.question || '') + (t.answer || ''), '');
  const hardFacts = extractHardFacts(finalText);
  const goal = extractGoalFromExistingMemory(existing);

  // 冷却期内（上次压缩后 10 分钟内）→ 降级硬事实直写，不调模型，避免长文档逐轮触发压缩风暴
  const inCooldown = (() => {
    const at = node.frontmatter.memory_compacted_at;
    if (!at) return false;
    const last = Date.parse(at);
    return Number.isFinite(last) && Date.now() - last < COMPACT_COOLDOWN_MS;
  })();

  // P4c-1 fallback 收敛：无模型/冷却期 均走 compact.ts 共享 compactionFallbackSummary（与 nodes append 同款）
  const compressInput = { goal, existingMemory: existing, uncompressedTurns: trimmedTurns, hardFacts };
  let rendered: string;
  let fallbackKind: 'none' | 'no-model' | 'cooldown' = 'none';
  if (!inCooldown && modelCfg) {
    // R-14-C 真模型分支：命中压缩模型 → 走 runCompaction 产出模型叙事摘要
    //（模型配置由 POST 侧三来源解析后传入，见 resolveChatCompactModelConfig）
    const result = await runCompaction(compressInput, modelCfg);
    rendered = result.rendered;
  } else if (inCooldown) {
    // 冷却期内 → 降级硬事实直写，不调模型，避免长文档逐轮触发压缩风暴
    fallbackKind = 'cooldown';
    rendered = compactionFallbackSummary(compressInput);
  } else {
    // 无可用模型 → 硬事实直写（与 /api/nodes 降级逻辑一致）
    fallbackKind = 'no-model';
    rendered = compactionFallbackSummary(compressInput);
  }

  // 持久化：压缩记忆 + 游标推进（前端下轮按 ×2 跳过这些轮次 → 前缀稳定）。
  // T2 gap 修复：折叠真实落盘时置一次性回声标记——同轮 append 侧 R-26 会因「已被覆盖」
  // （newUntil ≤ compactedUntil）返回 compacted=null，前端内存游标收不到新值 → 下轮仍全量上传。
  // append 读到本标记后把真实游标随响应 compacted 回传并清除（见 /api/nodes append）。
  node.compressedMemory = rendered;
  node.frontmatter.memory_compacted_at = new Date().toISOString();
  node.frontmatter.memory_compacted_until = newUntil;
  node.frontmatter.memory_turn_count = 0;
  node.frontmatter.memory_compacted_pending_echo = true;
  node.frontmatter.updated_at = new Date().toISOString();
  try {
    const filePath = await findNodeFileById(nodeId, project.path);
    if (filePath) {
      await updateNodeFile(filePath, serializeNode(node));
    }
  } catch (e) {
    console.warn('[R-14-压缩] 节点写回失败（压缩记忆仅本轮生效）:', e instanceof Error ? e.message : String(e));
  }
  console.log(`[R-14-压缩] 被裁 ${trimmedTurns.length} 轮已压缩进节点记忆（游标 ${compactedUntil} → ${newUntil}，冷却内=${inCooldown}）`);
  // P4c-1 压缩事件化：压缩实际发生（游标推进 + 写回 .md 成功）后记一条 compaction 事件；
  // 仅追加事件记录，不改变任何压缩触发/游标/写回语义。
  eventLog.mark(CORE_EVENT.COMPACTION, `compaction:${taskId}`, {
    reason: 'R-14-C 缓存感知压缩',
    shadowedTurns: { from: compactedUntil, to: newUntil },
    hardFactsCount: hardFacts.length,
    hardFactsSample: hardFacts.slice(0, 5),
    summaryGoal: goal,
    compactedUntil: newUntil,
    fallbackKind,
  });
  return rendered;
}

// ==================== R-14-C 预算前瞻（T2：提前折叠 + chain 判断外 + 折叠源切日志派生） ====================

/** 取消息文本（content 非字符串时按空处理，与 extractTrimmedTurns 同口径） */
function messageText(m: ChatMessage): string {
  return typeof m?.content === 'string' ? m.content : '';
}

/** 历史字符数：不含最后一条（当前轮 user，其体积由 R-14 硬闸负责，不属于「未压缩历史」） */
function historyCharsOf(msgs: ChatMessage[]): number {
  let sum = 0;
  for (let i = 0; i < msgs.length - 1; i++) sum += messageText(msgs[i]).length;
  return sum;
}

/** 把折叠后更新的压缩记忆 prepend 到当前轮最后一条 user（C8：不进 system，缓存头字节稳定） */
function prependCompactedMemoryToTail(messages: ChatMessage[], memoryText: string): ChatMessage[] {
  const result = [...messages];
  const block = '\n\n## 本节点压缩记忆（本轮裁剪后更新）\n\n' + memoryText.trim();
  const last = result[result.length - 1];
  if (last && last.role === 'user') {
    const prev = last.content || '';
    result[result.length - 1] = { ...last, content: block + '\n\n' + prev };
  } else {
    // 兜底：最后一条不是 user（历史重放等边界）→ 追加一条 user 消息，仍不进 system
    result.push({ role: 'user', content: block });
  }
  return result;
}

/**
 * 折叠输入解析（T2：C/D 共用同一日志派生函数）：
 * 请求消息与 .md 对话记录对齐（同游标、无丢轮/续写错位）时，把被裁轮次映射回 .md 轮次，
 * 再经 .trajectory 事件日志派生出权威压缩输入（Q/A/reasoning，不含工具结果全文）；
 * 日志缺失 → 该轮 .md 文本兜底。请求与 .md 不对齐（续写、丢失 append 等）→ 沿用「被裁
 * request 文本」现网语义（foldTurns = trimmedTurns，零漂移）。
 * @param originalMessages 裁剪前请求消息（含可能的头部队 system 也可，按对计数即可）
 */
async function resolveHistoryFoldTurns(
  nodeId: string,
  project: NonNullable<Awaited<ReturnType<typeof getCurrentProject>>>,
  originalMessages: ChatMessage[],
  trimmedTurns: ConversationTurn[],
): Promise<ConversationTurn[]> {
  if (trimmedTurns.length === 0) return trimmedTurns;
  let node: Awaited<ReturnType<typeof loadNodeById>> | null = null;
  try {
    node = await loadNodeById(nodeId, project.path);
  } catch {
    node = null;
  }
  if (!node) return trimmedTurns;
  const cursor = node.frontmatter.memory_compacted_until ?? 0;
  const lastIsUser = originalMessages[originalMessages.length - 1]?.role === 'user';
  const pairCount = Math.floor((originalMessages.length - (lastIsUser ? 1 : 0)) / 2);
  const aligned =
    pairCount > 0 &&
    trimmedTurns.length <= pairCount &&
    cursor + pairCount === node.conversations.length &&
    cursor + trimmedTurns.length <= node.conversations.length;
  if (!aligned) return trimmedTurns;
  const mdTurns = node.conversations.slice(cursor, cursor + trimmedTurns.length);
  return deriveCompactionTurnsFromLogs(mdTurns, project.path, nodeId);
}

/**
 * R-14-C 预算前瞻（route projection hook，chain 判断之外——孤立节点同样受益）：
 * 触发从「总长超闸才裁」升级为「未压缩历史接近预算（高水位 = contextGate×60%）即提前离散折叠」，
 * 折叠最早轮直到保留历史 ≤ 低水位（= contextGate×30%，至少保留最近 1 轮 + 当前轮）。
 *   - 折叠 = 现网 R-14-C 同款：最早轮增量压缩进节点记忆 + .md 游标推进 + 记忆 prepend 当前轮 user；
 *   - 收益：服务端实际裁剪与游标推进同步（消除 append 侧「已被覆盖」导致的游标滞后 gap），
 *     前端下轮 skip 生效，每轮 prompt 提前变小；
 *   - 默认零漂移：历史未达高水位 / 消息结构异常（含非成对历史）→ 原样返回，逐字节不变。
 */
async function applyHistoryProjectionHook(
  messages: ChatMessage[],
  nodeId: string | undefined,
  project: Awaited<ReturnType<typeof getCurrentProject>> | null,
  contextWindow: number,
  taskId: string,
  eventLog: EventLog,
  compactModelCfg: CompactModelConfig | null,
): Promise<ChatMessage[]> {
  if (!nodeId || !project || messages.length < 3) return messages;

  // 头部队 system 等非对话消息拆出，折叠只在对话体上操作（system 从不参与折叠/不丢）
  const head = messages[0]?.role === 'system' ? [messages[0]] : [];
  const body = head.length > 0 ? messages.slice(1) : messages;
  if (body.length < 3) return messages;

  // 结构守卫：仅处理「成对历史 + 当前轮 user 结尾」的标准形态；异常形态跳过（保零漂移）
  const last = body[body.length - 1];
  if (!last || last.role !== 'user') return messages;
  if (body.length % 2 !== 1) return messages;
  const pairCount = (body.length - 1) / 2;
  for (let i = 0; i < pairCount; i++) {
    if (body[i * 2]?.role !== 'user' || body[i * 2 + 1]?.role !== 'assistant') return messages;
  }

  const highWater = compactLookaheadHighCharsForContext(contextWindow);
  const lowWater = compactLookaheadLowCharsForContext(contextWindow);
  const histChars = historyCharsOf(body);
  if (histChars < highWater) return messages; // 未触发折叠的会话逐字节不变

  const pairChars: number[] = [];
  for (let i = 0; i < pairCount; i++) {
    pairChars.push(messageText(body[i * 2]).length + messageText(body[i * 2 + 1]).length);
  }
  const foldCount = oldestPairsToFold(pairChars, lowWater, 1);
  if (foldCount <= 0) return messages;

  const originalBody = body;
  const trimmedBody = body.slice(foldCount * 2);
  const trimmedTurns: ConversationTurn[] = [];
  for (let i = 0; i < foldCount; i++) {
    trimmedTurns.push({
      question: messageText(originalBody[i * 2]),
      answer: messageText(originalBody[i * 2 + 1]),
      questionTime: '',
      answerTime: '',
    });
  }

  // 折叠主流程失败（读节点/压缩模型/写回异常）不阻断：降级为直接裁剪（与 R-14 硬闸同款）
  try {
    const foldTurns = await resolveHistoryFoldTurns(nodeId, project, originalBody, trimmedTurns);
    const newMemory = await compactTrimmedHistoryForCache(nodeId, project, foldTurns, taskId, eventLog, compactModelCfg);
    let out = [...head, ...trimmedBody];
    if (newMemory) out = prependCompactedMemoryToTail(out, newMemory);
    return out;
  } catch (e) {
    console.warn('[R-14-前瞻] 预算前瞻折叠失败，降级为直接裁剪:', e instanceof Error ? e.message : String(e));
    return [...head, ...trimmedBody];
  }
}

/**
 * Node Bridge：按祖先链注入上游信息（规格 v3 §七 R-12~R-18 + §八）
 *  - R-14-C 预算前瞻（T2）：hook 在 chain 判断之前执行（孤立节点同样可折叠），见上
 *  - R-12 直接上游（深度 1）成果块全文注入，不截断不递归
 *  - R-17 祖先（深度 ≥2）只注入存在性声明一行
 *  - R-14 注入总长超限自动回退（方案 A：先裁本节点旧对话 + 增量压缩 → 仍超才把上游全文降级为结论档 brief → 最后才拒绝）
 *  - Step 9：托管模型（无工具能力）自动派发实习生，命中关键词交集 ≥2 的祖先取回原文注入
 */
async function applyUpstreamNodeBridge(
  messages: ChatMessage[],
  nodeId: string | undefined,
  project: Awaited<ReturnType<typeof getCurrentProject>> | null,
  isManagedModel: boolean,
  contextWindow: number,
  taskId: string,
  eventLog: EventLog,
  /** R-14-C 压缩模型配置（POST 侧三来源解析：请求透传 → settings → 当前请求模型；null=降级硬事实） */
  compactModelCfg: CompactModelConfig | null,
): Promise<ChatMessage[]> {
  if (!nodeId || !project) return messages;

  // ===== R-14-C 预算前瞻（chain 判断之外：孤立节点同样受益）=====
  messages = await applyHistoryProjectionHook(messages, nodeId, project, contextWindow, taskId, eventLog, compactModelCfg);

  let chain;
  try {
    chain = await getAncestorChain(nodeId, project.path, project.id);
  } catch (e) {
    console.warn('Node Bridge 祖先链构造失败:', e);
    return messages;
  }
  if (chain.depth1.length === 0 && chain.depthPlus.length === 0) return messages;

  // 注入分两档：full = 上游成果块全文；brief = 同一份只留「结论 + 确定性等级 + 来源 id」。
  // 溢出处理顺序（R-14，方案 A）：本节点旧对话（有压缩记忆兜底）先裁，上游 full 是低频稳定段、
  // 且是已签字的前提，最后才降级 —— 上游在 full/brief 间抖动会反复击穿 C8 缓存前缀。
  const partsFull: string[] = [];
  const partsBrief: string[] = [];
  const addPart = (full: string, brief?: string): void => {
    partsFull.push(full);
    partsBrief.push(brief ?? full);
  };

  // 加载当前节点自身，用于注入自身成果块和压缩记忆
  const current = await loadNodeById(nodeId, project.path);

  // 当前节点自身成果块
  // - 用户手动修正过 → 以用户修正为准，不可随意更改
  // - AI 自动提取 → 前序认定，可引用但非既定前提
  if (current?.outcome) {
    const isUserEdited = current.frontmatter.outcome_user_edited === true;
    if (isUserEdited) {
      addPart(`## 本节点成果块（已由用户手动修正，请以此为准，不可随意更改）\n\n${renderOutcome(current.outcome)}`);
    } else {
      addPart(`## 本节点已填写的成果块（你的前序认定，可引用但非既定前提）\n\n${renderOutcome(current.outcome)}`);
    }
  }

  // 当前节点压缩记忆（长对话产物的精炼摘要）
  if (current?.compressedMemory?.trim() && !/^（无|暂无）/.test(current.compressedMemory.trim())) {
    addPart(`## 本节点压缩记忆（对话超过阈值后的精炼摘要）\n\n${current.compressedMemory.trim()}`);
  }

  // R-12: 直接上游成果块全文（仅 locked 才作为既定前提注入）
  let injectedLockedUpstream = false;
  // P0-a 外部锚点：读一次锁定台账（.ledger/locks.md），逐上游比对「节点 frontmatter + 台账最新一条」
  const lockTape = readLockTape(project.path);
  for (const d of chain.depth1) {
    const node = await loadNodeById(d.nodeId, project.path);
    if (node?.frontmatter.outcome_status === 'locked' && node.outcome) {
      // P0-a 双锚点校验（锁与钥匙不再放同一抽屉）：
      //  ① 内容哈希须等于节点 frontmatter 留痕 —— 挡「改正文忘改哈希」；
      //  ② 台账最新一条须同时匹配哈希与版本号 —— 挡「正文与哈希一并重写」；
      //  ③ 台账中该节点无记录（存量老项目）→ 显式提示「无外部锚点，无法确认完整签署链」，不静默通过。
      const stampedHash = node.frontmatter.outcome_content_hash;
      const actualHash = outcomeContentHash(node.outcome);
      const hashMismatch = !!stampedHash && stampedHash !== actualHash;
      const tapeRec = latestLockOf(project.path, d.nodeId);
      const anchorBroken = !hashMismatch
        && (!tapeRec || tapeRec.action === 'unlock' || tapeRec.hash !== stampedHash || tapeRec.version !== node.frontmatter.outcome_version);
      if (hashMismatch || anchorBroken) {
        // 台账不连续（被截断/被删行）也在这里留 warn，供事后排查
        console.warn(
          `[chat:inject] 上游锚点校验未通过 node=${d.nodeId} hashMismatch=${hashMismatch} anchorBroken=${anchorBroken} tapeTruncated=${lockTape.truncated} stamped=${stampedHash ?? '-'} actual=${actualHash}`,
        );
      }
      if (hashMismatch) {
        // 哈希不一致 = 签字已被破坏：不再作为「既定前提」，降级为显式警告 + 仅供参考的内容
        addPart(
          `## 上游节点「${d.title}」（n_${d.nodeId}）警告：成果块在锁定后被修改（内容哈希与签署留痕不一致）\n\n以下内容**仅供参考，不得作为既定前提**（须回原文核实；如需确认请让用户重新锁定该节点）：\n\n${renderOutcome(node.outcome)}`,
          `## 上游节点「${d.title}」（n_${d.nodeId}）警告：成果块在锁定后被修改（哈希不一致，不得作为既定前提 · 因上下文预算已精简，仅给结论）\n\n${renderOutcomeBrief(node.outcome, BRIEF_MAX_CHARS_PER_UPSTREAM, `n_${d.nodeId}`)}\n\n（详细推理已因预算裁剪；如需依据请回原节点 n_${d.nodeId} 查看）`,
        );
        continue;
      }
      // 标题带节点 id（n_ 前缀），供下游成果块引用时写 [来源: n_xxx#q-yyy] 规范来源
      injectedLockedUpstream = true;
      // 存量项目（v3 之前锁定，台账里没有该节点记录）：内容仍作既定前提，但必须明注签署链无法确认
      const anchorNote = anchorBroken
        ? `（无外部锚点，无法确认完整签署链：项目锁定台账中没有该节点的连续签署记录。本机留痕，非密码学签署，不构成对外举证。）\n\n`
        : '';
      addPart(
        `## 上游节点「${d.title}」（n_${d.nodeId}）已锁定成果（既定前提${anchorBroken ? ' · 无外部锚点，无法确认完整签署链' : ''}）\n\n${anchorNote}${renderOutcome(node.outcome)}`,
        // 降级档（P0-c）：结论全文 + 每条确定性等级 + 来源 id，硬上限 BRIEF_MAX_CHARS_PER_UPSTREAM，
        // 并显式告知模型「上游推理链已因预算裁剪」
        `## 上游节点「${d.title}」（n_${d.nodeId}）已锁定成果（既定前提${anchorBroken ? ' · 无外部锚点，无法确认完整签署链' : ''} · 因上下文预算已精简，仅给结论）\n\n${renderOutcomeBrief(node.outcome, BRIEF_MAX_CHARS_PER_UPSTREAM, `n_${d.nodeId}`)}\n\n（详细推理已因预算裁剪；如需依据请回原节点 n_${d.nodeId} 查看）`,
      );
    } else if (node?.frontmatter.outcome_status === 'stale') {
      // R-10 级联失效：带出原因链，让模型知道「哪条前提已废」，而不是笼统的「已变更」
      const why = node.frontmatter.outcome_stale_reason?.trim();
      addPart(`## 上游节点「${d.title}」（警告：上游成果块已失效，此前注入的内容不得作为既定前提。${why || '上游成果块已变更，请优先调用 intern_search 取最新原文'}）`);
    } else {
      addPart(`## 上游节点「${d.title}」（${node ? '成果块未锁定，未注入成果内容' : '无法读取'}）`);
    }
  }

  // P0-1 记忆源权威顺序：仅在**本节点确实注入了上游锁定成果**时注入（条件段，不常驻）——
  // 这正是「上游成果块 vs 项目账本/压缩记忆」可能冲突的场景，此时才值得付这段 token。
  if (injectedLockedUpstream) addPart(MEMORY_AUTHORITY_RULE);

  // R-17: 祖先存在性声明（不注入目录/原文）
  if (chain.depthPlus.length > 0) {
    const lines = chain.depthPlus.map((d) => {
      const statusText = d.outcomeStatus === 'locked' ? '已锁定'
        : d.outcomeStatus === 'stale' ? 'stale（前提已失效）'
        : (d.outcomeStatus || '未知');
      return `  ${d.nodeId}「${d.title}」· ${statusText} · ${(d.updatedAt || '').slice(0, 10)}`;
    });
    const truncatedNote = chain.truncated > 0 ? `\n  （另有 ${chain.truncated} 个更早祖先）` : '';
    addPart(
      `上游祖先（非直接父，内容未注入）：\n${lines.join('\n')}${truncatedNote}\n需要时调用 read_manifest(node_id) 查看目录，再调用 intern_search 取原文。`,
    );
  }

  // Step 9: 托管模型自动派发实习生（无工具能力 → 后端自动取回，输出同样带 [原始对话·未认定]）
  if (isManagedModel) {
    const auto = await autoDispatchIntern(messages, chain, nodeId, project);
    if (auto) addPart(auto);
  }

  addPart(UPSTREAM_GUIDE_PROMPT);
  let injection = '\n\n' + partsFull.join('\n\n');

  // R-14: 上下文超长时自动回退（**方案 A**：先裁本节点旧对话 + 增量压缩 → 仍超才降级上游 full → brief → 最后才拒绝）
  // 定案理由：C8 把上游成果块归入「低频变化段（稳定缓存前缀）」，而上游是已签字的前提——
  // 它若随对话长度在 full/brief 间抖动，既反复击穿前缀缓存，又让下游重复推翻已定结论。
  // 因此优先牺牲「有压缩记忆兜底的本节点旧对话」，把上游推理链留到最后才动；不静默截断、也不直接拒绝。
  const messagesLenOf = (msgs: ChatMessage[]): number =>
    msgs.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
  const contextGate = contextGateForContext(contextWindow);
  if (messagesLenOf(messages) + injection.length > contextGate) {
    // ① 先裁本节点未压缩的旧对话（含 R-14-C 增量压缩）。
    //    注入已独占闸值时（gateForMessages <= 0）裁剪救不了，跳过 ① 直接进 ② 的上游降级。
    const gateForMessages = contextGate - injection.length;
    if (gateForMessages > 0) {
      // 从最旧开始成对丢弃 user+assistant，直到 ≤ 闸值的 80%（至少保留最近 2 轮 + 当前轮）
      const target = Math.floor(gateForMessages * 0.8);
      const originalMessages = messages;
      let trimmed = messages;
      let len = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
      while (trimmed.length > 4 && len > target) {
        if (trimmed[0]?.role === 'user' && trimmed[1]?.role === 'assistant') {
          trimmed = trimmed.slice(2);
        } else {
          trimmed = trimmed.slice(1);
        }
        len = trimmed.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
      }
      // ===== 缓存感知压缩（R-14-C）=====
      // 被裁轮次 → 增量压缩进节点记忆并推进 memory_compacted_until（持久化）：
      //   - 信息不丢：压缩记忆兜底被裁内容（模型仍可读）；
      //   - 前缀稳定：下一轮前端 compactedUntilRef 读到新游标 → 跳过这些轮次不再发送 →
      //     请求前缀与裁剪后一致 → 命中 DeepSeek 前缀缓存（否则每轮重新裁剪、前缀漂移、全价重算）。
      const trimmedTurns = extractTrimmedTurns(originalMessages, trimmed);
      // 缓存稳定化：压缩记忆不混入 system injection（会改 system 字节 → 缓存头整段失效），
      // 改为收集后 prepend 到当前轮最后一条 user 消息（尾部变化保头缓存，见下方注入点）
      let compactedMemoryInjection = '';
      if (trimmedTurns.length > 0) {
        try {
          // T2 折叠源切换：请求与 .md 对齐时经 .trajectory 日志派生权威压缩输入（含 reasoning），
          // 否则沿用被裁 request 文本（现网语义）；两轨与 /api/nodes append 共用同一派生函数
          const foldTurns = await resolveHistoryFoldTurns(nodeId, project, originalMessages, trimmedTurns);
          const newMemory = await compactTrimmedHistoryForCache(nodeId, project, foldTurns, taskId, eventLog, compactModelCfg);
          if (newMemory) {
            compactedMemoryInjection = '\n\n## 本节点压缩记忆（本轮裁剪后更新）\n\n' + newMemory.trim();
          }
        } catch (e) {
          console.warn('[R-14-压缩] 被裁轮次压缩失败，已降级为直接裁剪:', e instanceof Error ? e.message : String(e));
        }
      }
      console.warn(
        `[R-14] 上下文超长自动回退：对话从 ${messages.length} 条裁剪到 ${trimmed.length} 条（约 ${Math.round(len / 1000)}k / 闸值 ${Math.round(contextGate / 1000)}k）。被裁剪的旧对话由压缩记忆+成果块兜底，模型可 intern_search 按需检索。`,
      );
      messages = trimmed;

      // 缓存稳定化：压缩记忆 prepend 到当前轮最后一条 user 消息（与技能上下文/思考指令同策略），
      // 而非注入 system——system 字节一旦变化，缓存头整段失效，历史缓存全部作废。
      // 本轮即生效：裁剪后 system 不变、历史已收敛，本轮请求即可命中缓存。
      if (compactedMemoryInjection) {
        const last = messages[messages.length - 1];
        if (last && last.role === 'user') {
          const prev = last.content || '';
          messages[messages.length - 1] = { ...last, content: compactedMemoryInjection + '\n\n' + prev };
        } else {
          // 兜底：最后一条不是 user（历史重放等边界）→ 追加一条 user 消息，仍不进 system
          messages.push({ role: 'user', content: compactedMemoryInjection });
        }
      }
    }

    // ② 对话裁到底后仍超闸 → 才把上游全文降级为结论档 brief。
    //    每次 full→brief 切换都会改变注入段字节 = 缓存前缀失效，必须可观测（console + .ledger/log.md 留痕）。
    if (messagesLenOf(messages) + injection.length > contextGate) {
      const briefInjection = '\n\n' + partsBrief.join('\n\n');
      if (briefInjection.length < injection.length) {
        const beforeLen = injection.length;
        console.warn(
          `[R-14] 上下文超长：本节点对话已裁到底仍超闸，上游成果块全文降级为结论档（注入 ${Math.round(beforeLen / 1000)}k → ${Math.round(briefInjection.length / 1000)}k）；上游 full→brief 使缓存前缀失效`,
        );
        appendEntryLog(project.path, [
          `[r14] upstream=full→brief inject=${Math.round(beforeLen / 1000)}k→${Math.round(briefInjection.length / 1000)}k gate=${Math.round(contextGate / 1000)}k cache_prefix=invalidated`,
        ]);
        injection = briefInjection;
      }
    }

    // ③ 仍超（上游 brief 独占闸值）：对话裁剪救不了，必须用户侧拆节点/减少上游
    if (messagesLenOf(messages) + injection.length > contextGate) {
      throw new Error(`R-14 上游注入后上下文超长（约 ${Math.round((messagesLenOf(messages) + injection.length) / 1000)}k 字符，当前模型闸值约 ${Math.round(contextGate / 1000)}k），且主要为上游/成果块注入占用（已降级为结论档仍不足），无法自动裁剪对话。请拆分节点或减少上游关联后再试。`);
    }
  }

  // 缓存前缀稳定化（C8）：「低频变化段」= 按事件变化、不按轮变化的内容 —— 上游成果块（仅锁定/重锁才变）、
  // 本节点成果块、压缩记忆（折叠发生才变）、祖先声明。它们不进 system——system 字节一旦变化，
  // 缓存头整段失效，作废所有下游节点请求的前缀缓存；改为 prepend 到当前轮最后一条 user 消息
  // （每轮必 miss 段，不影响历史缓存）；与技能上下文/思考指令同策略。
  // 与 R-14 降级顺序的一致性（方案 A）：正因为上游成果块属低频稳定段，溢出时**最后才**降级为 brief ——
  // 否则上游会随对话长度在 full/brief 间抖动，等于每轮改写本段字节、前缀反复失效。
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    const prev = last.content || '';
    messages[messages.length - 1] = { ...last, content: injection + '\n\n' + prev };
  } else {
    // 兜底：最后一条不是 user（历史重放等边界）→ 追加一条 user 消息，仍不进 system
    messages.push({ role: 'user', content: injection });
  }
  return messages;
}

/** Step 9：托管模型自动派发——命中关键词交集 ≥2 的祖先节点自动跑一次实习生并入 system */
async function autoDispatchIntern(
  messages: ChatMessage[],
  chain: Awaited<ReturnType<typeof getAncestorChain>>,
  currentNodeId: string,
  project: Awaited<ReturnType<typeof getCurrentProject>>,
): Promise<string | null> {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser || typeof lastUser.content !== 'string') return null;
  const queryTerms = extractKeywords(lastUser.content, 12);
  if (queryTerms.length === 0) return null;

  const ancestors = [...chain.depth1, ...chain.depthPlus];
  const outs: string[] = [];
  for (const anc of ancestors) {
    const manifest = await readManifest(anc.nodeId, project.path);
    if (!manifest) continue;
    let maxHit = 0;
    for (const entry of manifest.sections) {
      const n = matchTerms(queryTerms, entry.keywords).size;
      if (n > maxHit) maxHit = n;
    }
    if (maxHit >= 2) {
      const res = await internSearchNode(
        { targetNodeId: anc.nodeId, instruction: lastUser.content, maxResults: 3 },
        project.path,
        project.id,
        currentNodeId,
      );
      if (res.status === 'found') {
        outs.push(`[实习生自动检索 · 节点「${res.sourceTitle}」]（${res.disclaimer}，引用时须标 [存疑]）：\n${res.content}`);
      }
    }
  }
  return outs.length > 0 ? outs.join('\n\n') : null;
}

/** 检查是否重复调用同一工具+相同参数（max 可放宽：页面交互过的浏览器读取见调用点） */
function isDuplicateCall(
  toolName: string,
  args: Record<string, unknown>,
  history: Array<{ toolName: string; arguments: Record<string, unknown> }>,
  max: number = MAX_DUPLICATE_CALLS,
): boolean {
  const argKey = JSON.stringify(args);
  const count = history.filter(
    (h) => h.toolName === toolName && JSON.stringify(h.arguments) === argKey,
  ).length;
  return count >= max;
}

/** DeepSeek V4 硬上下文上限（deepseek-harness C7）：2^20 = 1,048,576 tokens */
const DEEPSEEK_MAX_CONTEXT_TOKENS = 1_048_576;

/** C7 前置校验用的输入 token 估算：CJK 为主的文本 ≈ 1 字 0.6~1 token，取 1/2.5 保守偏大防误判 */
function estimateMessagesTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    const tc = (m as unknown as { tool_calls?: unknown[] }).tool_calls;
    if (Array.isArray(tc)) chars += JSON.stringify(tc).length;
  }
  return Math.ceil(chars / 2.5);
}

/**
 * 上下文占用 Meter（dsh ContextMeter）：按 系统 / 对话 分组估算消息占用，
 * 工具定义（toolDefs 序列化）单独估算 —— 三者之和即本轮请求的上下文总量。
 * 与 estimateMessagesTokens 同口径（字符数 / 2.5），供前端圆环 + 明细弹窗展示。
 */
function estimateContextBreakdown(
  messages: ChatMessage[],
  toolDefs: unknown[],
): { systemTokens: number; conversationTokens: number; toolsTokens: number } {
  let systemChars = 0;
  let convoChars = 0;
  for (const m of messages) {
    let chars = typeof m.content === 'string' ? m.content.length : 0;
    const tc = (m as unknown as { tool_calls?: unknown[] }).tool_calls;
    if (Array.isArray(tc)) chars += JSON.stringify(tc).length;
    if (m.role === 'system') systemChars += chars;
    else convoChars += chars;
  }
  return {
    systemTokens: Math.ceil(systemChars / 2.5),
    conversationTokens: Math.ceil(convoChars / 2.5),
    toolsTokens: Math.ceil(JSON.stringify(toolDefs ?? []).length / 2.5),
  };
}

/**
 * 模型请求限流/瞬时故障的重试策略（deepseek-harness 限流稳健化）：
 * DeepSeek 官方 API 并发受限时返回 429，网关/代理偶发 5xx 与网络层抖动也常见。
 * 直接报错会让整轮任务失败、用户需重发整个对话——改为在「请求建立阶段」指数退避重试。
 * 边界：
 *  - 仅在请求发出但尚未收到任何流式块（create() 抛错）时重试；流中途断开不重试
 *    （工具可能已执行，重放会重复副作用）。
 *  - 只重试可恢复错误：429 / 5xx / 网络层错误；4xx 业务错误（401/402/404 等）与
 *    用户主动 Abort 不重试，直接上抛。
 */
const COMPLETION_MAX_ATTEMPTS = 3;
const COMPLETION_RETRY_BASE_MS = 1000;
const COMPLETION_RETRY_CAP_MS = 8000;

/**
 * 输出触顶（finish_reason=length）空轮的放宽预算上限：与 max 档同款 32k。
 * 仅对 baseMaxTokens ≥ 16384 的档位可用（1M 推理大模型），低档位放大可能超模型支持上限触发 API 400。
 * 依据 2026-10-08 事故：high 档 16384 预算被 reasoning 吃满 → 连续两轮零正文零工具。
 */
const TRUNCATION_RETRY_MAX_TOKENS = 32768;

/**
 * 工具循环思考降级（item 4）的降级表已收敛到 src/lib/thinking/policy.ts
 * （executionDowngrade），策略层说明见该文件。
 */

function isRetryableCompletionError(e: unknown): boolean {
  if (typeof e === 'object' && e !== null) {
    // openai SDK 的 APIError 带 status；AbortError 是用户取消，禁止重试
    const err = e as { status?: number; name?: string };
    if (err.name === 'AbortError' || err.name === 'APIUserAbortError') return false;
    if (typeof err.status === 'number') {
      if (err.status === 429) return true;
      if (err.status >= 500 && err.status < 600) return true;
    }
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/429|rate limit|too many requests/i.test(msg)) return true;
  if (/\b(5\d{2})\b|server error|internal server error|bad gateway|service unavailable|gateway timeout/i.test(msg)) return true;
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network error|timeout of/i.test(msg)) return true;
  return false;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 工具调用参数 JSON 截断修复（deepseek-harness 工具调用修复流水线 / pi-reasonix repair）：
 * 模型长输出时 arguments 可能被 max_tokens 截断（缺右括号/引号/尾逗号）。自动补全：
 * 1) 未闭合字符串补引号；2) 未闭合 {/[ 补右括号；3) 去除尾随逗号；4) JSON.parse 验证。
 * 修复成功返回修复后的字符串，否则 null。
 */
function repairTruncatedJson(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try { JSON.parse(s); return s; } catch { /* 继续尝试修复 */ }
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); out += ch; continue; }
    if (ch === '}' || ch === ']') {
      if (stack.length && stack[stack.length - 1] === (ch === '}' ? '{' : '[')) stack.pop();
      out += ch;
      continue;
    }
    out += ch;
  }
  if (inString) out += '"';
  // 补闭合括号前清理尾随逗号（如 {"a":1,"b":2, → {"a":1,"b":2}）
  out = out.replace(/,\s*$/, '');
  while (stack.length) {
    const open = stack.pop();
    out += open === '{' ? '}' : ']';
  }
  try { JSON.parse(out); return out; } catch { return null; }
}

/**
 * 成本控制（pi-reasonix Pillar 3）：工具结果超长时"保头保尾"压缩再进模型上下文。
 * 默认 1800 tokens 阈值（可感知 ~1/50 缓存价下仍值得省的输入量）；保留开头 + 结尾，
 * 长输出的尾部（错误信息、汇总、末行数据）绝不被静默丢弃，并用显式标记告知模型内容已截断、
 * 需要时按需分片重读。仅压缩进入对话历史（模型付费输入）的副本，工具执行的完整结果仍保留在
 * allToolCalls（供去重/声明校验/前端展示使用）。
 */
const TOOL_RESULT_TOKEN_CAP = 1800;
const TOOL_RESULT_HEAD_RATIO = 0.4;
/** 目录/列表/搜索结果类工具：返回多为多条记录，压缩时按条目（换行）对齐保头部，避免切断单条记录 */
const LIST_LIKE_TOOLS = new Set([
  'read_manifest', 'list_directory', 'search_files', 'web_search',
  'read_todo', 'read_notebook', 'read_raw_inbox', 'read_note_history',
]);

function compactToolResult(result: string, toolName?: string): { text: string; compacted: boolean } {
  if (!result) return { text: result, compacted: false };
  const estTokens = Math.ceil(result.length / 2.5);
  if (estTokens <= TOOL_RESULT_TOKEN_CAP) return { text: result, compacted: false };
  const budgetChars = Math.floor(TOOL_RESULT_TOKEN_CAP * 2.5);
  const headChars = Math.floor(budgetChars * TOOL_RESULT_HEAD_RATIO);
  const tailChars = budgetChars - headChars;

  // 截断点向上/向下对齐到换行符，避免切断半个条目/半行（对法律原文也更安全）
  let head = result.slice(0, headChars);
  const headBreak = head.lastIndexOf('\n');
  if (headBreak > headChars * 0.5) head = head.slice(0, headBreak);

  let tail = result.slice(result.length - tailChars);
  const tailBreak = tail.indexOf('\n');
  if (tailBreak > 0) tail = tail.slice(tailBreak + 1);

  const listLike = toolName ? LIST_LIKE_TOOLS.has(toolName) : false;
  const visibleNote = `可见开头 ${head.length.toLocaleString()} + 结尾 ${tail.length.toLocaleString()} 字符`;
  const omittedHint = listLike
    ? `… [结果过长已压缩：原文约 ${estTokens.toLocaleString()} tokens（${result.length.toLocaleString()} 字符），中间条目已省略，${visibleNote}] …`
    : `… [结果过长已压缩：原文约 ${estTokens.toLocaleString()} tokens（${result.length.toLocaleString()} 字符），${visibleNote}。需完整内容时：必须回到同一个工具，用其上一次返回的 offset 或末尾续读标记分片续读（不同抽取工具如 extract_text/read_article 的字符口径与 offset 互不兼容，勿跨工具混用）] …`;

  const text = `${head}\n\n${omittedHint}\n\n${tail}`;
  return { text, compacted: true };
}

/**
 * 从 reasoning_content 中回收工具调用（deepseek-harness / pi-reasonix scavenge 流水线）：
 * DeepSeek 系模型偶发把工具调用写进思考文本而非结构化 tool_calls。
 * 仅在本轮无结构化 tool_calls 时触发；扫描所有可能是 JSON 对象的起点，
 * 用平衡括号定位完整对象后 JSON.parse，认 {name|tool|function + arguments|args|params} 结构。
 */
function scavengeToolCallsFromReasoning(reasoning: string): Array<{ id: string; name: string; arguments: string }> {
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  const r = reasoning.trim();
  if (!r) return calls;
  for (let i = 0; i < r.length; i++) {
    if (r[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < r.length; j++) {
      const ch = r[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{' || ch === '[') { depth++; continue; }
      if (ch === '}' || ch === ']') {
        if (depth > 0) {
          depth--;
          if (depth === 0) {
            // 找到平衡的候选 JSON 对象
            const candidate = r.slice(i, j + 1);
            let obj: Record<string, unknown>;
            try { obj = JSON.parse(candidate) as Record<string, unknown>; }
            catch { break; } // 起点非法，放弃该候选
            const name = String(obj?.name ?? obj?.tool ?? obj?.function ?? '').trim();
            const rawArgs = obj?.arguments ?? obj?.args ?? obj?.params;
            if (name && rawArgs !== undefined && rawArgs !== null) {
              const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
              const repaired = repairTruncatedJson(args) ?? args;
              calls.push({
                id: `call_scavenged_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                name,
                arguments: repaired,
              });
            }
            i = j; // 跳过已消费段，避免内部嵌套对象被重复扫描
            break;
          }
        } else {
          break; // 未匹配的闭合括号，放弃该起点
        }
      }
    }
  }
  return calls;
}

/** 是否「结果依赖页面当前状态」的浏览器工具。
 *  这类工具（extract_text / snapshot / wait / navigate / click 等）即使参数相同，
 *  页面跳转后结果也会截然不同，去重必须感知页面变化，否则会误判为「重复调用」。 */
function isPageStateTool(toolName: string): boolean {
  return toolName.includes('browser_');
}

/** 轮询型工具：相同参数重复调用是正常用法（查询下载进度），不参与去重 */
function isPollingTool(toolName: string): boolean {
  return toolName === 'browser_downloads' || toolName.endsWith('__browser_downloads');
}

/** 会改变当前页面内容的交互工具（DOM 写操作 / 会话跳转 / 视口变化）。
 *  这些操作多数不改 URL，但会让上一次的内容读取结果失效——URL 指纹抓不到这种变化。
 *  MCP 通道为 `mcp__<server>__browser_xxx` 下划线形式，故按后缀匹配。 */
const PAGE_INTERACTION_TOOLS = [
  'browser_click', 'browser_click_coordinates', 'browser_type', 'browser_fill_form',
  'browser_press_key', 'browser_submit', 'browser_check', 'browser_uncheck',
  'browser_select_option', 'browser_hover', 'browser_drag', 'browser_scroll',
  'browser_mouse_wheel', 'browser_run_js', 'browser_page_script', 'browser_upload_file',
  'browser_download',
  'browser_handle_dialog', 'browser_back', 'browser_forward', 'browser_reload',
  'browser_switch_tab', 'browser_close_tab', 'browser_resize_viewport',
];

function isPageInteractionTool(toolName: string): boolean {
  return PAGE_INTERACTION_TOOLS.some((n) => toolName === n || toolName.endsWith(`__${n}`));
}

/** 下标 fromIndex 之后是否发生过成功的页面交互（失败的操作没改变页面，不计） */
function hasPageInteractionAfter(
  history: Array<{ toolName: string; success?: boolean }>,
  fromIndex: number,
): boolean {
  for (let i = fromIndex + 1; i < history.length; i++) {
    const h = history[i];
    if (h.success !== false && isPageInteractionTool(h.toolName)) return true;
  }
  return false;
}

/** 是否 browser.login 工具（BobWork 登录弹窗流程的触发点）。工具名为 MCP fullName（下划线形式）。 */
function isBrowserLoginTool(toolName: string): boolean {
  return toolName === 'browser.login' || /^mcp__.*__browser_login$/.test(toolName);
}

/** 定位 browser.login_fill 的完整工具名（内部专用：登录弹窗凭据回填，不注册给模型）。 */
async function findBrowserLoginFillFullName(): Promise<string | null> {
  try {
    const { mcpManager } = await import('@/lib/mcp/manager');
    const tools = await mcpManager.discoverTools();
    return tools.find((t) => /browser\.login_fill$/.test(t.name))?.fullName ?? null;
  } catch {
    return null;
  }
}

/** 从页面 URL 派生可读站点名（https://www.xiaohongshu.com/explore → xiaohongshu.com） */
function toolDisplaySiteName(url?: string): string {
  try {
    if (!url) return '';
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
}

/**
 * MCP 自带说明书 → 注入文本（宿主只加壳，不改写、不裁剪正文）。
 *
 * 正文来自各 server 的 InitializeResult.instructions —— 它是「这个服务怎么用」的唯一权威来源，
 * 过去该字段被整体丢弃，第三方 MCP 只剩逐工具 description，没有整体用法与作业纪律。
 * 只对**工具真的在册**的 server 注入（判据见注入点），杜绝「指引有、工具没有」。
 */
function buildMcpInstructionsText(
  items: Array<{ serverId: string; serverName: string; instructions: string }>,
): string {
  const sections = items.map((it) => `### ${it.serverName}（${it.serverId}）\n${it.instructions}`);
  return ['## MCP 服务自带说明书（由各服务自行声明，供调用其工具时参考）', ...sections].join('\n\n');
}

/**
 * K1 会话上下文（会话上下文收敛，K 系列第一步，零行为变化 refactor）：
 * 把「每轮工具循环（r0-r19）及其子流程共享的请求级状态」从 ReadableStream.start()
 * 内散落声明归组为一个局部对象字面量 kctx（见 start() 内 `const kctx: KernelContext`）。
 *
 * 收编范围：仅在 start() 闭包内声明、且被工具循环跨轮读写/共享的状态；
 * 收敛只移动声明与读写点，不改任何执行逻辑 / SSE 载荷 / 事件 mark / 退出语义。
 *
 * 明确不在此接口内（保持原地）：
 *  - module 级可变状态：会话 sticky 已随 K2-S2 收敛进 SessionRuntime（src/lib/runtime/session.ts）、
 *    CacheGuard guard 已随 K2-S1 收敛进 ToolRuntime（src/lib/runtime/tools.ts）、
 *    pending 各容器（挂起型接管，保留原地）；
 *  - 请求通道对象：ReadableStream / controller / send / eventLog / taskId；
 *  - 请求级只读配置：level / baseEffort / thinkingPolicyConfig / isDeepseekV4 /
 *    modelSupportsThinking / trivialPrompt（声明于 POST 作用域，跨 start() 只读引用，最小 diff）；
 *  - 单轮派生 const：for 自增 round、roundEffort / thinkingDowngraded /
 *    downgradeDecision / isFinalRound / finalRoundInjection（每轮重新计算，非跨轮共享）；
 *  - 结算期派生：hitRatio / hitTotal / ttftMs / taskDurationMs / tokensPerSec / finalCtx / outputFiles；
 *  - 只读一次计算遥测：prefixSegments / prefixHash（首帧 context_meter 与 done 帧共用，值不变）。
 */
interface KernelContext {
  /** 对话历史落账（结算语义：allToolCalls → conversationMessages → eventLog 三连顺序不变） */
  conversationMessages: ChatMessage[];
  /** 工具调用落账（含执行元数据，供去重 / 声明校验 / tool_summary / output_files 使用） */
  allToolCalls: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
    result: string;
    durationMs: number;
    success: boolean;
    phase?: 'pending' | 'running' | 'done' | 'error';
    kind?: 'tool' | 'mcp' | 'skill';
    systemChange?: boolean;
    changeSummary?: string;
    summary?: string;
    /** 该工具执行时刻的页面 URL 指纹（浏览器工具去重感知页面变化用；非浏览器工具为 null） */
    pageUrl?: string | null;
  }>;
  /** 浏览器工具去重用的「页面 URL 指纹」：browser_active_tab 刷新；页面跳转后变化 → 不误判重复调用 */
  lastPageUrl: string | null;
  /** search_capabilities / load_skill 中途激活场景后置 true → 下一轮请求前重建 loopToolDefs */
  needRebuildTools: boolean;
  /** 完成确认轮只允许一次：已追加过「任务是否真正完成」确认即置 true（防假完成） */
  completionConfirmUsed: boolean;
  /** 截断重试已用次数：空轮 + finish_reason=length 递增（不占用 completionConfirmUsed 预算，见 chat/empty-round.ts） */
  truncationRetries: number;
  /** 本任务发生输出触顶（finish_reason=length）的轮数（空答案兜底正文据实说明成因） */
  truncatedRounds: number;
  /**
   * 最后一轮的正文（每轮覆盖）。整轮结束时若仍为空 → 判定没有任何可读正文，
   * 触发空答案兜底（禁止节点里只剩系统提示，见 2026-10-08 事故复盘）。
   */
  finalAnswerText: string;
  /** 声明真实性校验纠偏次数计数（D-B：保持现状仅记录，不引行为变化） */
  claimMismatchCorrections: number;
  /** 停滞保护：连续无实质进展轮数（≥ STALL_LIMIT → 强制收尾轮） */
  stallCount: number;
  /** 强制收尾轮：置 true 后下一轮不带 tools，模型基于注入的收尾说明直接输出最终回答；lite 首轮即收尾 */
  forceFinalRound: boolean;
  /** OCR 重试预算门控：已触发后不再重复注入「停止重试」指令 */
  ocrBudgetExceeded: boolean;
  /** 收敛护栏：当前连续主导的工具名（本轮调用占比 ≥ 80% 者；null 表示尚未建立） */
  convergenceTool: string | null;
  /** 收敛护栏：同一工具连续主导的轮数 */
  convergenceRounds: number;
  /** 收敛护栏门控：已触发后不再重复注入「停止穷举」指令 */
  toolConvergenceExceeded: boolean;
  /** AI Coding 任务硬预算门控：已触发后不再重复注入收尾说明（与 forceFinalRound 解耦，避免互相打架） */
  taskBudgetExceeded: boolean;
  /** 工具循环思考降级遥测：执行轮降级计数（对照 done hitRate 判断 thinking 降级是否影响缓存命中） */
  thinkingDowngradedRounds: number;
  /** 思考决策可见性（方向 D）：每轮实际模式/降级/C1 命中记录，done 帧带出供前端展示 */
  thinkingModes: Array<{ round: number; mode: string | null; downgraded: boolean; trivialOff: boolean }>;
  /** 模型调用总轮数（done 结算 rounds 字段 / TURN_END） */
  totalRounds: number;
  /** 跨轮累计本次任务真实 token 消耗（cacheHit/cacheMiss：DeepSeek 前缀缓存遥测 §4.4） */
  taskUsage: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number; calls: number };
  /** 整轮任务开始时刻（首轮模型调用之前；TTFT = firstTokenMs - taskStartMs） */
  taskStartMs: number;
  /** 首个 content/reasoning 块到达时刻 */
  firstTokenMs: number | null;
  /** 本轮开始前的 homework/ 目录快照（结束时比对出新产出，兜底输出卡片） */
  homeworkSnapshot: Map<string, number> | null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      messages: ChatMessage[];
      nodeId?: string;
      modelId?: string;
      thinking?: 'enabled' | 'disabled';
      temperature?: number;
      apiKey?: string;
      baseUrl?: string;
      providerModelId?: string;
      thinkingLevel?: ThinkingLevel;
      forcedSkills?: string[];
      /** 节点"强制使用"MCP（复选框）：无视场景/画像过滤保留该 MCP 工具；仅对 Store 中 enabled 的 server 生效；缺省/空 = 跟随全局 */
      enabledMcpIds?: string[];
      /** Agent 标识（chat | coding）：决定工具画像与专项 prompt（见 @/lib/agents/profiles） */
      identity?: AgentId;
      /** Research 开关（Hippo 侧边栏）：开启时在浏览器操作纪律之外再叠一层调研纪律（BROWSER_RESEARCH_RULES），
       *  并让答复走综述骨架（据此排除 REPORT_RULES）。它与 browser 身份工具面正交，不改变工具集。 */
      researchMode?: boolean;
      /** 显式指定项目上下文（如 Butler 临时问答），仅本次请求生效，不切换全局当前项目 */
      projectId?: string;
      /** 会话级人设（Butler 会话专属，见 lib/butler/threads-shared.ButlerPersona）：仅身份/语气/自称层覆盖，
       *  不改工具面与权限；仅 identity==='butler' 时生效，其它身份一律忽略 */
      persona?: ButlerPersona;
      /** 无确认回传链路（sandbox:true 编排链路）：过滤写类工具，禁止 AI 产生文件/待办/日历/笔记等副作用 */
      sandbox?: boolean;
      /** 调用通道：**非 undefined = 聚合链路**（微信桥 = 'wechat'，飞书桥 = 'feishu'；panel 为保留语义，
       *  ⌘F 面板已退化为纯搜索），该链路收不到确认回传 → 确认类/写类工具据此改「回话说明 + 不执行」，
       *  避免空等 10 分钟挂起或静默写入（桥接通道按 WECHAT_ALLOWED_WRITES 白名单放行排程/便签/笔记
       *  写类，其它通道只读）；缺省 = 桌面流式通道，行为不变 */
      channel?: 'wechat' | 'feishu' | 'panel';
      /** 多智能体协作模式（chat 界面开关）：激活 team 场景并注入「用户代理」规则，主 agent 用 team_run 交
       *  goal，宿主拉起队长（captain）会话做规划与整合。
       *  能力门控：仅 supportsTeamCollab(profile) 的画像生效（dynamic 画像或 fixedScenes 含 team）；
       *  coding / 市场 agent 等 fixed 画像即使传 true 也忽略，不注入规则、不激活 team 场景。 */
      multiAgentMode?: boolean;
      /** 本次执行的成员名单（Multi-agent mode 弹窗选定的已安装 agent id）：不落盘，仅本轮生效；
       *  服务端把它交给队长（captain）规划时参考，并在队长补充名单外成员时强制弹卡请用户批准 */
      presetAgentIds?: string[];
      /** team 模式队长模型（Team 分栏「Main model」显式选择，provider:modelId）：宿主注入 team_run 的
       *  执行上下文，只读模型池与节点 frontmatter，**绝不回写节点模型** */
      teamMainModel?: string;
      /** team 模式成员模型（Team 分栏「Worker model」显式选择，provider:modelId）：一刀切覆盖全部成员 */
      teamWorkerModel?: string;
      /** 轻量单轮问答（Bob WebBridge 侧边栏等外部客户端）：跳过工具循环，模型直接基于上下文回答 */
      lite?: boolean;
      /** 续写请求携带的初始产物（如模板填充面板生成的文件），补进本轮 output_files 卡片 */
      initialOutputFiles?: OutputFileItem[];
      /** R-14-C：前端透传压缩模型配置（节点自定义模型在用的 apiKey/baseURL/model；与 /api/nodes append 同字段同校验） */
      compact_model_config?: { apiKey?: string; baseURL?: string; model?: string };
      /** Butler 会话线程 id（2026-10-02）：仅 Butler 链路（`lib/butler/entry.ts`）会带。
       *  用途见下方 `butlerThreadId` 的注释（记忆来源归因 + 规则预算按会话分片）。
       *  与 `nodeId` 的区别：Butler 不走画布节点，`nodeId` 传的是占位符，**不是**会话身份。 */
      threadId?: string;
    };
    const {
      messages,
      nodeId,
      modelId,
      thinking,
      temperature,
      thinkingLevel,
      forcedSkills,
      enabledMcpIds,
      identity,
      researchMode,
      projectId,
      persona,
      sandbox,
      channel,
      multiAgentMode,
      teamMainModel,
      teamWorkerModel,
      lite,
      initialOutputFiles,
    } = body;
    /**
     * Butler 会话线程 id（2026-10-02 新增字段）：**只有 Butler 链路会带**。
     * 为什么需要它：① 记忆来源要能归到「哪次对话」（`remember_preference` 的 source）；
     * ② 规则预算（`.state/rule-budget`）本就按会话分片，而此前传的是 `entry.ts` 的
     * **占位 nodeId**（`BUTLER_PLACEHOLDER_NODE_ID`）——同一把钥匙开所有会话的锁。
     * 非 Butler 链路不传 → 全部退化为原行为。
     */
    const butlerThreadId = typeof body.threadId === 'string' && body.threadId ? body.threadId : undefined;
    const initialUserInput = extractLastUserContent(messages);
    // Agent 配置（AGENT_PROFILES + 覆盖项）：决定工具画像、场景策略与专属 prompt（chat 通用 / coding 专项）。
    // 专项 agent 被禁用 → 回退 chat；自定义 prompt → 覆盖 baseSystemPrompt
    const profile = await resolveAgentProfile(identity);
    // 模型三件套：允许外部 HTTP 客户端（如 WebBridge AI 侧边栏）省略，由服务端兜底解析
    let { apiKey, baseUrl, providerModelId } = body;

    // 兜底解析：
    //  - providerModelId 形如 "provider:modelId" → 从已配置 providers 按供应商解析 apiKey/baseUrl
    //  - 未显式指定 → 先按请求 identity 查 agentModels 专属池（resolveAgentRoleModel），
    //    再回退默认聊天模型（resolveTaskModel = 候选池有序首选）——兜底来自未带模型的外部
    //    HTTP 客户端与迁移前的旧节点（模型选择器已下线 Auto，节点侧始终带具体模型）
    //  - 显式指定但供应商未配置 → 明确 400（不悄悄降级默认模型，避免用户以为选模型已生效）
    if (!apiKey || !baseUrl || !providerModelId) {
      const resolved = providerModelId
        ? await resolveProviderModel(String(providerModelId))
        : ((await resolveAgentRoleModel(profile?.id ?? identity))
            ?? (await resolveTaskModel()));
      if (resolved) {
        apiKey = resolved.apiKey;
        baseUrl = resolved.baseUrl;
        providerModelId = resolved.model;
      } else if (providerModelId) {
        const pname = String(providerModelId).split(':')[0];
        return new Response(
          JSON.stringify({ error: `Provider "${pname}" is not configured (missing API key). Please configure it in BobWork Manage Models first.` }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
    }

    // 视觉兜底：模型选择器已下线 Auto（节点始终带具体模型），带图轮次若当前模型读不了图，
    // 在此改选候选池里第一个视觉模型（开关 settings.chatModel.autoVisionOnImage，默认开），
    // 让下方「直连多模态」判定成立；池内无视觉模型则保持原模型，继续走 Vision Bridge 描述兜底。
    if (providerModelId && !chatModelSupportsVision(providerModelId)) {
      const hasImageInRequest =
        Array.isArray(messages) &&
        messages.some(
          (m: ChatMessage) =>
            m.role === 'user' &&
            /图片/.test(m.content || '') &&
            /路径: (?:materials|attachments|assets)\//.test(m.content || ''),
        );
      if (hasImageInRequest) {
        const chatModelSettings = (await readSettingsFromFile().catch(() => null))?.chatModel;
        if (chatModelSettings?.autoVisionOnImage !== false) {
          const visionResolved = await resolveVisionChatModel(chatModelSupportsVision).catch(() => null);
          if (visionResolved) {
            apiKey = visionResolved.apiKey;
            baseUrl = visionResolved.baseUrl;
            providerModelId = visionResolved.model;
            console.log(`[vision-fallback] 当前模型读不了图，本轮改用候选池视觉模型 model=${providerModelId}`);
          }
        }
      }
    }

    // P3-3b2：SSE model 通知用的 `provider:modelId` 标签（供外部客户端与消息落盘用）。
    // provider 类型按 apiKey 在已配置 providers 中反查；查不到（自定义 baseUrl 直配）则用裸 providerModelId。
    const providersForModelTag = (await readSettingsFromFile().catch(() => null))?.providers ?? [];
    const modelTagProvider = providersForModelTag.find((p) => p.apiKey === apiKey)?.type ?? '';
    const modelTag = providerModelId
      ? (modelTagProvider ? `${modelTagProvider}:${providerModelId}` : providerModelId)
      : undefined;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: 'messages is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // forcedSkills 规范化（去空值）。DSH 模式：仅用户手动勾选的技能直接注入 L2 正文；
    // 其余技能由模型按需 load_skill 加载，不再按关键词自动匹配注入。格式禁令在
    // BASE_SYSTEM_PROMPT 每轮常驻，保证不退回老画法。
    const mergedForcedSkills: string[] =
      (Array.isArray(forcedSkills) ? forcedSkills : []).filter(
        (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0,
      );

    const hasUserMessage = messages.some((m) => m.role === 'user');
    if (!hasUserMessage) {
      return new Response(
        JSON.stringify({ error: 'At least one user message is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // 注入思考深度系统提示（S2b：UI 四档 off/low/high/max + legacy medium；缺省 high = DSH 默认档）
    const level: ThinkingLevel = thinkingLevel ?? 'high';

    // Phase 2 策略层抽取（S2a 语义定稿，默认=纯 DSH 固定档）：思考档位决策读 settings.thinking，
    // harnessPure 缺省 true —— 每轮一律发用户所选档位，不降级、不 C1 关思考；显式 false 才启用
    // 旧业务插件行为（执行轮降级 + C1，沿用 downgradeOnExecution/trivialPromptOff 语义）。
    // 读取发生在思考决策前（settingsForTools 于 isCustom 分支内才加载，此处无法复用其作用域）
    const thinkingSettings = await readSettingsFromFile();
    const thinkingPolicyConfig: ThinkingPolicyConfig = {
      harnessPure: thinkingSettings.thinking?.harnessPure !== false,
      downgradeOnExecution: thinkingSettings.thinking?.downgradeOnExecution !== false,
      trivialPromptOff: thinkingSettings.thinking?.trivialPromptOff !== false,
    };

    // C1（deepseek-harness）：琐碎对话判定（问候/致谢等，避免白烧 reasoning tokens）——
    // 仅 harnessPure=false 时由 effortForLevel 消费并把档位压成 reasoning_effort: none；
    // harnessPure=true（纯固定档）忽略 trivial，不关思考
    const trivialPrompt = isTrivialPrompt(messages);

    // 判断当前模型是否支持推理（用于决定是否传 reasoning_effort 参数）
    const isCustom = !!(apiKey && baseUrl && providerModelId);
    // DeepSeek V4 家族识别（deepseek-harness C2/C7 的适用条件）：判据是「模型标识属于 V4 家族」，
    // 不看 baseUrl —— agentplan/ark 等订阅网关的 baseUrl 不含 deepseek 而模型名仍是 deepseek-v4-*；
    // 直连 api.deepseek.com 的模型名同样是 deepseek-*。
    // 不能用 `/v4/i`：本项目预设把 V4 Flash 的显示名标准化为 `deepseek-flash`（不含 "v4"），
    // 纯名字判定会漏掉它 → 工具循环不回传 reasoning_content → 上游 400
    // "The `reasoning_content` in the thinking mode must be passed back to the API"（2026-09-15 实测）。
    // 2026-09-15 改为「声明优先」：预设里标了 `family: 'deepseek-v4'` 的模型直接命中（不改模型名，
    // 厂商再改 id 只需改 presets.ts 一处）；名字正则降级为未知型号兜底 —— 排除非 V4 旧型号
    // （deepseek-chat / deepseek-reasoner(R1) / deepseek-coder / deepseek-vl2 / DeepSeek-V3 系）：
    // 它们不需要（reasoner 反而禁止）回传 reasoning_content，也不能套 1M 硬上下文校验。
    const dsModelName = providerModelId ?? '';
    const isDeepseekLegacy =
      /deepseek[\w./-]*(?:chat|reasoner|coder|r1|vl)|deepseek[\w./-]*v?3\b/i.test(dsModelName);
    const isDeepseekV4 =
      isCustom && (isDeclaredV4Model(dsModelName) || (/deepseek/i.test(dsModelName) && !isDeepseekLegacy));

    // R-14 动态闸值依据：按当前请求模型推断 contextWindow（自定义模型优先用 providerModelId，托管用 modelId）
    const requestContextWindow = inferContextWindow(providerModelId || modelId || '', thinking === 'enabled');
    const modelSupportsThinking = (() => {
      if (!isCustom) return thinking === 'enabled';
      // DeepSeek V4：模型支持思考模式（S2a 后 V4 与非 V4 统一走 reasoning_effort，不再有 thinking_mode 专用分支）
      if (isDeepseekV4) return true;
      // 其他自定义模型：通过模型名判断
      return !!providerModelId && /reason|r1|z1|think|k2/i.test(providerModelId);
    })();

    // S2a/S2b 统一档位：V4 与非 V4 同走 reasoning_effort 词表（none/low/high/max）。
    // 档位决策收敛到 policy.effortForLevel：off→none、low→low、medium(legacy)→high、high→high、max→max；
    // C1（仅 harnessPure=false）或 off 显式 → none。供整轮共享（每轮 base，执行轮降级见循环内）
    const baseEffort = effortForLevel(level, thinkingPolicyConfig, trivialPrompt);

    // 上游节点上下文已在前端注入到系统提示中，后端直接使用
    const messagesWithContext = messages;

    // Vision Bridge：自动检测图片附件，用视觉模型描述后注入文本。
    // 首字节前提速：识别不再在此阻塞（此前每张图 × 候选模型串行降级，单次超时 30s+，
    // 多图最坏累计 >90s，前端已在首字节前超时）。改到流内（工具循环前）执行，期间持续发送
    // vision_progress SSE 事件，前端有数据流即重置超时计时器，同时用户可见"正在识别图片"进度。
    const messagesWithVision = messagesWithContext;

    // PDF Bridge：自动检测 PDF 附件，提取文本内容后注入
    let messagesWithPdf = messagesWithVision;
    let currentProjectPath = '';
    let projectRoot = '';
    // 当前项目 id（Butler 规则裁决的作用域具体度判定用；在下方 PDF Bridge 解析处顺带捕获）
    let activeProjectId = '';
    try {
      const project = await resolveNodeProject(nodeId, projectId);
      if (project) {
        messagesWithPdf = await applyPdfBridge(messagesWithVision, project.path);
        currentProjectPath = project.path.replace(homedir(), '~');
        projectRoot = project.path;
        activeProjectId = project.id;
      }
    } catch (e) {
      console.warn('PDF Bridge 执行失败:', e);
    }

    // P4c-1 压缩事件化：eventLog/taskId 提前创建，使 R-14-C 压缩事件（Node Bridge 内发生）与
    // SSE 事件写入同一任务日志（默认行为不变：无压缩时日志仍以 TURN_START 开头）。
    const taskId = genTaskId();
    const eventLog = new EventLog();

    // R-14-C：chat 折叠/裁剪压缩模型配置三来源解析（请求透传 compact_model_config → settings →
    // 当前请求模型回退），供 applyUpstreamNodeBridge 内预算前瞻折叠与 R-14 超闸折叠复用；
    // 三项来源均无明文可用（托管池等）→ null → 折叠降级硬事实直写（现网行为不变）。
    const chatCompactModelCfg = await resolveChatCompactModelConfig(
      body.compact_model_config,
      apiKey && baseUrl && providerModelId ? { apiKey, baseUrl, model: providerModelId } : null,
    );

    // Node Bridge（v3）：注入上游成果块 + 祖先存在性声明 + 托管模型自动派发实习生
    let messagesWithNodeBridge = messagesWithPdf;
    try {
      const project = await resolveNodeProject(nodeId, projectId);
      if (project) {
        messagesWithNodeBridge = await applyUpstreamNodeBridge(messagesWithPdf, nodeId, project, !isCustom, requestContextWindow, taskId, eventLog, chatCompactModelCfg);
      }
    } catch (e) {
      // R-14: 注入超长 → 拒绝执行并提示拆分，不静默截断
      if (e instanceof Error && e.message.startsWith('R-14')) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      console.warn('Node Bridge 执行失败:', e);
    }

    // 注入当前项目路径到系统提示，让 AI 知道文档应该写入哪里。
    // 普通节点：统一写 homework/ 根目录（归属由 .ownership.json 清册追踪）。
    const nodeHomeworkDir = 'homework';
    // K2-S3 动态上下文链 runtime service 抽取（行为不变）：项目路径/授权目录文本生成收敛进
    // ContextRuntime（src/lib/runtime/context.ts），prepend 注入动作仍保留在 route 原位（见下）
    const projectPathInjection = contextRuntime.buildProjectPathInjection({ currentProjectPath, nodeHomeworkDir });

    // 注入用户授权目录清单，让 AI 知道除了项目目录外还可以操作哪些本地目录
    const authorizedRootsInjection = await contextRuntime.buildAuthorizedRootsInjection({ nodeHomeworkDir });

    // off 模式不注入思考提示；非推理模型去掉 <think> 标签引用
    const effectiveLevel: ThinkingLevel = level;
    const { messages: messagesWithSkill, matchedSkillNames, skillDetails } = injectSkillContext(messagesWithNodeBridge, mergedForcedSkills, profile.id);
    // 基础系统提示按 Agent 隔离：专项 Agent（coding）用自己的专属 base，不背通用 chat 向内容
    const agentBasePrompt = profile.baseSystemPrompt ?? BASE_SYSTEM_PROMPT;
    // Phase 2b（全面 DSH 化）：DeepSeek V4 不注入思考引导（原生 reasoning_content，纯 API reasoning_effort 驱动），
    // 非 V4 推理模型恒注入  thinking 标签引导（其思考块显示依赖该格式，属正确性前提，不设开关）
    const shouldInjectThink = shouldInjectThinkPrompt(isDeepseekV4, modelSupportsThinking);
    // 缓存头注入与思考引导注入解耦（2026-10-02 修）：base 无条件进 system，
    // 只有思考引导受 shouldInjectThink 控制。此前两者耦合在一个三元里，
    // V4 家族（shouldInjectThink 恒 false）连带把 base 一起丢掉 → system 只剩前端短提示。
    let finalMessages = ensureBaseSystemPrompt(messagesWithSkill, agentBasePrompt);
    if (shouldInjectThink) {
      finalMessages = injectThinkingGuidance(finalMessages, effectiveLevel, modelSupportsThinking);
    }

    // 将项目路径 + 授权目录注入 prepend 到当前轮 user 消息（缓存前缀稳定化 C8）：
    // 属「低频变化」动态内容，不进 system（缓存头），system 只含字节稳定的 BASE_SYSTEM_PROMPT
    const pathContextInjection = projectPathInjection + authorizedRootsInjection;
    if (pathContextInjection) {
      finalMessages = prependDynamicContext(finalMessages, pathContextInjection);
    }

    // ===== 当前时间锚点注入（全身份 · 相对时间解析必需）=====
    // 模型没有「现在几点 / 今天几号」的内在感知：用户说"明天下午三点""下周三"时，
    // 不知道锚点就只能反问或凭记忆猜，对话式建日程首轮必卡。每轮现算注入；
    // 走动态通道（当前轮 user 消息内），system 缓存前缀字节不变。
    const nowInjection = contextRuntime.buildNowInjection();
    if (nowInjection) {
      finalMessages = prependDynamicContext(finalMessages, nowInjection);
    }

    // 包安装镜像指引 / 工具并行化 / 按需能力提示 已挪进 BASE_SYSTEM_PROMPT（字节固定，吃缓存）。
    // 此处仅保留「低频变化」动态内容（项目路径 / 用户偏好 / OCR 引擎现状）prepend 到 user 消息。

    // ===== 用户记忆注入（统一长期记忆，所有联系人共享；分档：常驻档注入正文 + 目录档按需调取） =====
    // K2-S3：记忆注入文本（listPreferences 读取/分档拼装）收敛进
    // ContextRuntime.buildUserPreferencesInjection；注入动作 prependDynamicContext 仍保留在 route 原位。
    // 缓存前缀稳定化：偏好目录属「低频变化」动态内容。若注入 system（缓存头），
    // 用户新增/删除偏好 → system 字节变化 → 前缀整段失效，历史缓存全部作废。
    // 改为 prepend 到当前轮最后一条 user 消息：system + 工具 + 历史前缀保持字节稳定，
    // 偏好变化只影响当前轮 user 消息（本轮内容本就每次不同），历史缓存不受影响。
    const prefInjection = await contextRuntime.buildUserPreferencesInjection();
    if (prefInjection) {
      finalMessages = prependDynamicContext(finalMessages, prefInjection);
    }

    // ===== 会议进行中状态注入（全身份 · P1-b /meeting 工具化） =====
    // 会议缓冲是服务端**全局单场状态**（lib/core/meeting-session.ts，P1-d 起落 SQLite .inbox.db），
    // 模型看不见它——不注入的话，会议进行中用户每条补充内容都会被当新任务处理（回话/建日程），
    // 而不会用 meeting_append 原样记录，会议链路就断了。
    // 原先只在 identity==='butler' 分支内注入（/meeting 曾是管家命令）→ 主对话（画布 chat 节点）
    // 即使开会成功，第二轮起模型也不知道"会议进行中"，meeting_append 链路必断；
    // 现放宽为全身份注入（下 gate 排除拿不到会议三件套的固定画像）：
    // 无进行中会议 → 空串，不产生任何注入（仅一次 SQLite 单行读）。
    // meetingActive 供下方场景过滤使用（会议进行中放行 butler 场景 = 会议三件套所在场景）。
    // 管家侧保持原有顺序（命令表 → 会议 → 人设），故下方 butler 分支内仍注入一次、字节序不变。
    let meetingActive = false;
    // 只有"手里可能有会议三件套"的画像才注入：dynamic 画像（主对话）经下方场景放行即可拿到；
    // fixed 画像须自身 fixedScenes 含 butler（browser 侧栏 / coding 节点的 fixedScenes 不含 →
    // 不注入，避免出现「注入要求调 meeting_append、工具却不在手里」的反向错位）。
    const canCarryMeetingTools = profile.scenes === 'dynamic'
      || (profile.fixedScenes ?? []).includes('butler');
    if (identity !== 'butler' && canCarryMeetingTools) {
      const meetingInjection = await contextRuntime.buildMeetingStateInjection();
      meetingActive = meetingInjection.length > 0;
      if (meetingInjection) {
        finalMessages = prependDynamicContext(finalMessages, meetingInjection);
      }
    }

    // ===== Butler 斜杠命令表注入（P0 · 统一入口） =====
    // 仅当本次为管家身份（identity==='butler'）时注入：命令表是宿主层唯一真源（BUTLER_COMMANDS），
    // 管家提示词被物化为 agent.json 对已装用户不生效，故改走本动态通道（每轮现算，已装用户即刻生效）。
    // C8 低频通道：与偏好/OCR 一致 prepend 到当前轮 user 消息，system 缓存头保持字节稳定。
    if (identity === 'butler') {
      const cmdInjection = contextRuntime.buildButlerCommandsInjection();
      if (cmdInjection) {
        finalMessages = prependDynamicContext(finalMessages, cmdInjection);
      }
      // 排期纪律（2026-09-27）：与命令表同因——管家提示词被物化为 agent.json，改常量对已装用户
      // 不生效；「无冲突直接落地 + 一句话、有潜在冲突先确认」这条口径必须立刻对所有人生效。
      // 传 agentBasePrompt 做幂等去重（2026-10-02）：system 里已含同一常量时不再重复注入。
      const scheduleInjection = contextRuntime.buildScheduleDisciplineInjection(agentBasePrompt);
      if (scheduleInjection) {
        finalMessages = prependDynamicContext(finalMessages, scheduleInjection);
      }
      // 信息分层纪律（2026-10-04）：与排期纪律同因——管家提示词被物化为 agent.json，改常量对已装
      // 用户不生效；「人与分工→记忆 / 口径与节奏→规则 / 授权→能力边界」这条落层纪律须立刻对所有人生效。
      // 传 agentBasePrompt 做幂等去重（system 里已含同一常量时不再重复注入）。
      const routingInjection = contextRuntime.buildMemoryRoutingInjection(agentBasePrompt);
      if (routingInjection) {
        finalMessages = prependDynamicContext(finalMessages, routingInjection);
      }
      // 「新建会话」意图（2026-10-06）：用户以「新建会话…」开头 = 派单，不是本次对话的背景说明。
      // 实测事故：这句被读成背景说明 → 0 次调用 create_session，管家自己在管家线程里把活干了
      // （2026-10-06 16:31 起草协议实例）。同一理由走动态通道：画像提示词对已装用户不生效，
      // 而这条判定必须立刻对所有人生效。只在命中时注入（未命中返回空串，零成本、零缓存扰动）。
      const newSessionInjection = contextRuntime.buildButlerNewSessionInjection(initialUserInput);
      if (newSessionInjection) {
        finalMessages = prependDynamicContext(finalMessages, newSessionInjection);
      }
      // 会议进行中：注入当前会议状态（P1-b /meeting 工具化）——详见上方「全身份注入」段；
      // 此处为管家保留原有注入位置（命令表 → 会议 → 人设，字节序不变），仅补记 meetingActive 供场景过滤。
      const meetingInjection = await contextRuntime.buildMeetingStateInjection();
      meetingActive = meetingInjection.length > 0;
      if (meetingInjection) {
        finalMessages = prependDynamicContext(finalMessages, meetingInjection);
      }
      // ===== 会话人设注入（新建会话时弹窗设定，与该会话同行存储、随会话删除） =====
      // 放在管家命令表之后：命令表是宿主层能力真源，人设只调身份/语气，不让它压过能力说明。
      // 无 persona（旧会话 / 未设定）→ 空串 → 不注入，行为与改造前逐字节一致。
      const personaInjection = buildPersonaInjection(persona);
      if (personaInjection) {
        finalMessages = prependDynamicContext(finalMessages, personaInjection);
      }
    }

    // ===== OCR/视觉引擎事实注入（防 system 硬编码引擎断言与插件真实配置脱节） =====
    // C8 低频通道：与路径/镜像/偏好一致 prepend 到当前轮 user 消息，system 缓存头保持字节稳定
    // K2-S3：事实文本生成（config.json 读取/schema 解析）收敛进 ContextRuntime.buildOcrEngineFactInjection，
    // 注入动作 prependDynamicContext 仍保留在 route 原位。
    const ocrEngineFactInjection = contextRuntime.buildOcrEngineFactInjection();
    if (ocrEngineFactInjection) {
      finalMessages = prependDynamicContext(finalMessages, ocrEngineFactInjection);
    }

    // ===== AI Coding 编程上下文注入 =====
    // 节点 frontmatter 带 sandbox_app_id 时，注入小程序编程任务上下文：
    // 告知写入路径（bob-sandbox/apps/<id>/ 相对路径）、文件读取方式、预览截图自检闭环。
    // K2-S3b 沙盒上下文抽取，行为不变：readAppEntry/hasAppImplementation/getBridgeActionsText
    //   分支模板生成（Spec 采集/交底方案/产物路径/兜底探测指令，~170 行）已收敛进
    //   ContextRuntime.buildCodingSandboxInjection（src/lib/runtime/context.ts）；
    //   此处仅保留 node 定位（resolveNodeProject/loadNodeById）+ 结果承接 + prepend 注入动作，
    //   sandboxCodingInjection / toolLoopSandboxAppId 两局部结果原位驱动后续 coding 场景/工具
    //   联动与 args_transform 注入（toolLoopSandboxAppId 先于生成调用赋值，失败时序与迁移前一致）。
    let sandboxCodingInjection = '';
    // 供工具循环注入：当前节点关联的 bob-sandbox appId（Coding 节点所有写入强制落 bob-sandbox/apps/，不落 homework）
    let toolLoopSandboxAppId: string | undefined;
    // 供工具循环注入：管家派发会话的 Outbox 批次 id（交付物改道落暂存区，不写当前项目 homework/）
    let toolLoopOutboxBatchId: string | undefined;
    if (nodeId) {
      try {
        const project = await resolveNodeProject(nodeId, projectId);
        const node = project ? await loadNodeById(nodeId, project.path) : null;
        const sandboxAppId = node?.frontmatter?.sandbox_app_id;
        if (sandboxAppId && typeof sandboxAppId === 'string') toolLoopSandboxAppId = sandboxAppId;
        const outboxBatchId = node?.frontmatter?.outbox_batch_id;
        if (outboxBatchId && typeof outboxBatchId === 'string') toolLoopOutboxBatchId = outboxBatchId;
        sandboxCodingInjection = await contextRuntime.buildCodingSandboxInjection({ node });
      } catch (e) {
        console.warn('AI Coding 上下文注入失败:', e instanceof Error ? e.message : String(e));
      }
    }
    // ===== 路径 A：管家在自己的会话里直接回复（无派发节点/批次）=====
    // 与派发会话同口径：交付物一律先落 Outbox 暂存区，不写当前项目 homework/。
    // 批次按 threadId 稳定复用（同一会话多轮写入归入同一批），用户归口后才进目标项目。
    const isButlerChatOutbox = !toolLoopOutboxBatchId && identity === 'butler' && !!butlerThreadId;
    if (isButlerChatOutbox && butlerThreadId) {
      try {
        const { ensureChatBatch } = await import('@/lib/outbox/store');
        const batch = await ensureChatBatch(butlerThreadId, {
          originProjectId: projectId || null,
          originLabel: 'Butler',
        });
        toolLoopOutboxBatchId = batch.batch_id;
      } catch (e) {
        console.warn('Outbox 批次创建失败（管家产物仍写当前项目）:', e instanceof Error ? e.message : String(e));
      }
    }
    // 缓存前缀稳定化（C8）：AI Coding 上下文属「低频变化」动态内容（同一节点内字节稳定），
    // prepend 到当前轮 user 消息而非 system（缓存头），system 保持字节稳定
    if (sandboxCodingInjection) {
      finalMessages = prependDynamicContext(finalMessages, sandboxCodingInjection);
    }
    // 管家对话 + Outbox：告知真实落点与产物声明写法（卡片要指向暂存区真实路径，否则点不开）
    if (isButlerChatOutbox && toolLoopOutboxBatchId) {
      finalMessages = prependDynamicContext(
        finalMessages,
        `【产物落点】本会话由你直接应答：write_file / edit_code 的交付物会被系统自动改道到 Outbox 暂存区（批次 ${toolLoopOutboxBatchId}），不会写入当前项目。照常写 homework/xxx 即可；正文末尾的产物声明请写 \`OutputFile: outbox/${toolLoopOutboxBatchId}/homework/<文件名>\`（工具返回的 Written 路径同此口径），这样文件卡片能直接打开。收尾时告诉用户"文档已暂存到 Outbox，可在 Butler 左栏 Outbox 指定归口项目"。`,
      );
    }

    // ===== Bob-Mind 面板改动回看注入（仅 mind agent） =====
    // 有「用户已改、Buzan 未回看」的导图改动时才注入（consume=1 取走即清零）；
    // 无改动/插件未运行 → 空串，不产生任何注入。同样走 prepend 而非 system（缓存头字节稳定）。
    const mindChangesInjection = await buildMindChangesInjection(profile.id);
    if (mindChangesInjection) {
      finalMessages = prependDynamicContext(finalMessages, mindChangesInjection);
    }

    const encoder = new TextEncoder();

    if (isCustom) {
      // ---- 使用 OpenAI SDK 调用自定义提供商（支持工具调用循环） ----
      const client = new OpenAI({ apiKey, baseURL: baseUrl });

      // K2-S1 工具面 service 抽取，行为不变：注册（自定义 + MCP 快照/排除 + syncServers）收敛进
      // ToolRuntime.register；每次请求 new（只读快照），settings 每请求读取一次与迁移前一致
      const settingsForTools = await readSettingsFromFile();
      // 「ledger 判据统一」的一半：fixed 画像（coding / 市场 agent）的工具面由 fixedScenes 决定
      // （ToolRuntime.computeActiveToolDefs），下面往 activeScenes 加的 'ledger' 对它们一律无效，
      // 于是出现「指引有、工具没有」的反向错位。有激活项目即把只读入口并集给全体 agent：
      // 只并 'ledger'（read_ledger / search_materials），不并 'ledger-keeper'（写工具只归档案员 Archivist）。
      // 只对**已有非空 fixedScenes** 的画像并集：fixedScenes 缺失时不动（空集合原本只给内核工具，
      // 若在这里补 ['general'] 会顺带把 general 场景工具也放进来——那是另一件事，不顺手做）。
      //
      // 管家（profile.id === 'butler'）在此再并 'notebook'（P1 统一入口）：管家要能自己应答
      // 「记一下 / 查笔记 / /note check / /note raw」，不再只把用户推去 Kar 节点（commands.ts 的
      // capability 字段与 registry.ts 的收归说明同源）。同样走**运行时并集**而非改 agent.json
      // ——后者安装时已物化，改 manifest 对已装用户不生效（同 ledger 的理由）。
      // 破坏性维护（delete_notebook）仍只归 Kar：管家 coreExclusions 剔除，避免微信/语音这类
      // 短指令（「那条删了吧」）误删笔记。
      const fixedScenes = profile.scenes === 'fixed' ? profile.fixedScenes : undefined;
      const extraScenes: ToolScene[] = [];
      if (projectRoot && fixedScenes && !fixedScenes.includes('ledger')) extraScenes.push('ledger');
      if (profile.id === 'butler' && fixedScenes && !fixedScenes.includes('notebook')) extraScenes.push('notebook');
      const toolProfile = fixedScenes && fixedScenes.length > 0 && extraScenes.length > 0
        ? {
            ...profile,
            fixedScenes: [...fixedScenes, ...extraScenes],
            // 管家并 'notebook' 时同步剔除不可逆的删除（其余笔记工具照常：读 / 写 / 编译 / 维护）
            ...(extraScenes.includes('notebook')
              ? { coreExclusions: [...(profile.coreExclusions ?? []), 'delete_notebook'] }
              : {}),
          }
        : profile;
      const toolRuntime = new ToolRuntime({
        settings: settingsForTools,
        profile: toolProfile,
        sandbox: !!sandbox,
        enabledMcpIds,
        // 截图自检优先用当前模型的原生 vision（仅当模型声明支持时）；否则工具内回退 bob-ocr-mcp。
        ...(providerModelId && apiKey && baseUrl && chatModelSupportsVision(providerModelId)
          ? { visionModel: { providerModelId, apiKey, baseUrl } }
          : {}),
      });
      await toolRuntime.register();

      // mcpManager 宿主侧调用（bobby 急停清除 / 浏览器当前页 URL 指纹）仍留在 route 原位
      const { mcpManager } = await import('@/lib/mcp/manager');

      // 新任务开始：清除 bobby 急停标志（上一轮用户按 ESC / 点停止中止后，本轮恢复正常执行）
      mcpManager.callTool('mcp__bobby__clear_abort', {}).catch(() => { /* bobby 未启用/未连接时忽略 */ });

      // ===== 工具场景过滤（两层） =====
      // L1 静态（节点类型）：
      //   - coding：AI Coding 节点（sandboxCodingInjection 非空）→ 放行 design 场景，
      //     coding 提示要求先调用 get_current_theme 获取真实主题色值
      //   - butler：沙盒模式（事务 Node 聊天）→ 放行 read_todo/read_notebook/preferences/calendar
      //   - node：画布节点对话（nodeId 存在）→ 放行 read_upstream_node/read_manifest/intern_search/draw（节点树/画布结构依赖工具）
      // L2 动态（对话意图）：最后用户消息明确提到对应场景关键词（或附件类型）时，才放行该场景专属工具；
      //   未涉及该场景则专属工具对模型不可见，避免误调用
      const activeScenes = new Set<ToolScene>(['general']);
      if (sandboxCodingInjection) {
        activeScenes.add('coding');
        activeScenes.add('design');
      }
      if (sandbox) activeScenes.add('butler');
      if (nodeId) activeScenes.add('node');
      // ledger：项目账本只读入口（read_ledger）随「存在激活项目」放行 —— 画布下恒真，
      // 使全体 agent（含团队成员的固定画像）都能先读档案再取原文。无项目时不激活（无库可读）。
      // 注意：本行只对 scenes='dynamic' 画像生效；fixed 画像的工具面另由 toolProfile 并集 'ledger' 补齐。
      // 写工具归 ledger-keeper 场景：只有档案员画像（Archivist）的 fixedScenes 含它（账本由档案员维护，其他 agent 只读）。
      if (projectRoot) activeScenes.add('ledger');
      try {
        const sceneHintText = extractLastUserContent(messagesWithNodeBridge);
        for (const s of detectSceneHints(sceneHintText)) activeScenes.add(s);
      } catch {
        /* 场景检测失败不阻断工具注册 */
      }

      // 按 Agent 配置（AGENT_PROFILES）决定场景策略：
      //   - chat（通用）：核心常驻 + 动态场景激活（省上下文固定税）。
      //     已激活场景会话内 sticky（仅 nodeId 存在时持久化）：首次激活后该会话保持注入，
      //     避免工具集在轮次间抖动 → 前缀缓存只在首次激活变化一次，后续轮次字节稳定。
      //     注意：检测词含宽泛高频词（如 Butler 的"总结/计划"、admin 的"配置/设置"），
      //     实际效果近似"常用场景工具逐步常驻"，省上下文收益主要来自从未激活的场景工具不注入。
      //     衰减（2026-10-08 一周回测）：sticky 落盘后失去了"重启即衰减"这个天然复位阀，
      //     实测工具数中位 79、最大 130（工具段 150KB），而首调 miss 随工具段增大 4.4 倍
      //     （≤40KB 时 5.4k → >120KB 时 23.7k），>80KB 的首调吃掉全部 miss 的 38%。
      //     故 mergeStickyScenes 现按 TTL(24h) + 每会话上限(6) 收敛：只有**本轮真正命中**的
      //     场景续命，仅靠读回的旧场景会自然脱落（代价是模型偶需 search_capabilities 重新激活）。
      //   - coding（专项）：固定场景子集，剔除 legal/core/ocr/audio/skill 等编码无关的
      //     专属工具与领域 MCP，过滤结果是节点类型决定的确定集合 → 工具前缀逐轮字节稳定。
      if (!sandbox && profile.scenes === 'dynamic') {
        const stickyKey = nodeId;
        if (stickyKey) {
          // K2-S2 会话态 service，行为不变：sticky 读回合并 + 过滤写回
          // （同 nodeId 跨请求聚合）收敛进 SessionRuntime.mergeStickyScenes
          sessionRuntime.mergeStickyScenes(stickyKey, activeScenes);
        }
      }

      // 会议进行中：补放行 butler 场景 —— 会议三件套（meeting_start / meeting_append / meeting_end）
      // 在 SCENED_TOOLS 里归 butler，不补就会出现「注入要求调 meeting_append、工具却不在手里」的反向错位
      // （主对话原先无会议链路，模型只能看着注入干瞪眼）。
      // 刻意放在 sticky 合并**之后**、不写入会话 sticky：会议结束即恢复原工具面，不长期占用上下文。
      if (meetingActive) activeScenes.add('butler');

      // ===== Butler 规则裁决段（v6 §9.3 ②③④；Phase 3 §3.2 收敛进运行时门面）=====
      // 场景判定（detectSceneHints）之后、工具注入之前跑一次宿主侧裁决：
      //   ② 候选生成 → ③ 裁决（execute / ask / need_user / silent）→ ④ 执行（确定性动作，如建待办）。
      // 自 Phase 3 起，②③④ 不再就地拼接，改由**运行时门面 butlerTick** 统一编排
      // （能力匹配 → 裁决 → 执行 → 信号回写；含定时候选与幂等去重）。此处只负责注入一行状态陈述。
      // 硬约束（计划 D6）：裁决**不改本轮工具集**，只决定「是否执行确定性动作」并注入一行状态陈述。
      // 聚合链路（channel 非 undefined）不跑：询问/提议回传不到用户手里，跑也是空等。
      if (activeScenes.has('butler') && !channel) {
        try {
          const { butlerTick } = await import('@/lib/butler/runtime');
          const adj = await butlerTick({
            trigger: { kind: 'speech', text: extractLastUserContent(messagesWithNodeBridge) },
            anchor: { projectId: activeProjectId || undefined, threadId: butlerThreadId ?? nodeId },
          });
          if (adj.notice) finalMessages = prependDynamicContext(finalMessages, adj.notice);
        } catch (e) {
          console.warn('Butler 规则裁决失败:', e);
        }
      }

      // 普通对话注入动态场景集合（DEFAULT_CHAT_SCENES 常量已不再用于普通对话）——
      // 核心工具（layer=core，未标注场景）始终注入且字节稳定（占前缀缓存锚点）；
      // ondemand 工具（layer=ondemand，标注场景）按 detectSceneHints 意图 + 会话 sticky 激活才注入，
      // 内置工具定义从固定 ~18.4k token 降为「核心 ~6.5k + 已激活场景」，省出的上下文让给任务本身。
      // sandbox 受限对话保留场景过滤 + 黑名单（安全优先）；
      // coding 专项 Agent 直接用 AGENT_PROFILES 中的固定工具画像。
      // 场景/画像过滤组装 + mergeForcedMcp + 确定性排序 + CacheGuard 已收敛进 ToolRuntime.assemble
      // （K2-S1 工具面 service 抽取，行为不变）：toolDefs / loopToolDefs 于 REPORT_RULES 注入后统一组装，见下。

      // 多智能体协作模式（chat 界面「Multi-agent mode」开关）：
      //   1) 强制激活 team 场景 → team_run（scenes:['team']）对模型可见；裸 mcp__team__* 不注入
      //      （见 tools/index.ts MCP_SERVER_SCENES 注释），模型侧唯一入口就是 team_run；
      //   2) 编排规则随当前轮 user 消息注入（与 BROWSER_RULES 同法，不进 system）。
      // 这是 team 场景的**唯一入口**：意图探测（detectSceneHints）、search_capabilities 能力目录、
      // 节点「强制使用」勾选均不产出 team。多智能体是重操作（每成员一条独立 /api/chat 会话，
      // 成本 ≈ N 倍），必须由用户显式开关开启，不接受任何自动触发路径。
      // 注意：本段在 sticky 合并之后 —— 开关是 per-request 语义，不写入会话 sticky，关掉即恢复单 agent。
      // 多智能体能力门控：team_run 只在 team 场景注入，而 fixed 画像（coding / 市场 agent）
      // 的 fixedScenes 不含 team（见 CODING_PROFILE 注释）→ 必须忽略 multiAgentMode。
      // 护栏点：旧节点 frontmatter 里可能仍遗留 multi_agent_mode=true，或直接调 API 传 true；
      // 否则会走成「注入 MULTI_AGENT_RULES 要求调 team_run，工具面里却没有 team_run」的反向错位。
      const teamModeOn = supportsTeamCollab(profile) && multiAgentMode === true;
      // 本次成员名单（chat 节点「Multi-agent mode」弹窗选定的已安装 agent id）：不落盘、仅本轮生效。
      // 两处消费：① 队长规划消息（优先用名单内成员）；② team_run 的执行上下文（名单外补充成员强制弹卡）。
      const presetAgentIds = teamModeOn && Array.isArray(body.presetAgentIds)
        ? body.presetAgentIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        : [];
      // 队长（captain）规划时参考的成员名单段：**只交给队长**（经 team_run 的执行上下文注入，
      // 见下方 ctx.teamRosterSection），不进主 agent 的 user 消息——主 agent 已退化为纯用户代理。
      let teamRosterSection = '';
      if (teamModeOn) {
        activeScenes.add('team');
        // 注入「用户代理」规则（队长规则由宿主在 captain 会话里注入，主 agent 不参与编排）
        finalMessages = prependDynamicContext(finalMessages, MULTI_AGENT_RULES);
        // 名单 label 从已安装 agent 包取，与弹窗候选同源；名单里的 id 未装/已卸载时回退显示 id，
        // 规则仍按 identity 引用它——成员装配端亦回退 chat 画像
        const labels = new Map<string, string>();
        if (presetAgentIds.length > 0) {
          for (const a of loadInstalledAgentProfiles()) labels.set(a.id, a.label);
        }
        const roster = presetAgentIds.map((id) => ({ id, label: labels.get(id) ?? id }));
        teamRosterSection = multiAgentRosterSection(roster);
      }

      // 浏览器专精规则按需注入（browser 场景激活 / coding 专项 Agent 强制注入）：
      // 已从 system 移出以省固定 token，随当前轮 user 消息动态注入（不破坏 system 前缀缓存）；
      // browser 工具随 tools 注入时，模型同步获得完整操作纪律。
      // 规则文本按 AI Browser 通道分流：hippo 通道的工具面无 mcp__ 前缀且能力面不同（见 BROWSER_RULES_HIPPO）。
      // 缺省（undefined）= hippo（默认通道）：仅显式 'chrome' 才注入 Bob Browser 版规则。
      // 判据口径：fixed 画像（浏览器对话栏 Sidebar、市场 agent）的浏览器能力由 fixedScenes 决定，
      // 动态场景检测对它无效 —— 仍按 activeScenes 判定会出现「指引有、工具没有」。
      const browserSceneActive = profile.scenes === 'fixed'
        ? (profile.fixedScenes ?? []).includes('browser')
        : activeScenes.has('browser');
      if (browserSceneActive || profile.forceBrowserTools) {
        finalMessages = prependDynamicContext(
          finalMessages,
          settingsForTools.aiBrowser === 'chrome' ? BROWSER_RULES : BROWSER_RULES_HIPPO,
        );
      }
      // 侧边栏动态纪律（落盘约定豁免 + 窄栏输出风格）：判据是画像本身而非上面的浏览器场景
      // —— 该档没有文件/命令工具，而 BASE 仍按通用会话给了 homework/ 落盘约定；且窄栏读不下
      // 逐轮累加的过程叙述（成因与故障见 BROWSER_SIDEBAR_RULES 注释）。
      if (profile.id === 'browser') {
        finalMessages = prependDynamicContext(finalMessages, BROWSER_SIDEBAR_RULES);
      }
      // Research 开关：浏览器操作纪律之外再叠一层调研纪律（工具面与默认浏览器画像完全相同，只差提示词）。
      // 判据是开关本身，与画像条件彼此独立（REPORT_RULES 那边按 researchMode 排除）。
      if (researchMode) {
        finalMessages = prependDynamicContext(finalMessages, BROWSER_RESEARCH_RULES);
      }

      // 「ledger 判据统一」的另一半：有激活项目即注入 —— 与工具放行（上面的 activeScenes.add('ledger')
      // 以及 toolProfile 对 fixed 画像并集 'ledger'）**同一条判据**，不再按画像/沙盒分叉。
      // 两边一致后不存在「工具到手、指引没有」，也不存在「指引有、工具没有」。
      const ledgerVisible = !!projectRoot;
      if (ledgerVisible) {
        // 「一」结构性预取：把账本索引 + 材料清单摘要直接摆进上下文——
        // 零模型调用、零决策成本，不依赖模型自觉去调 read_ledger / search_materials。
        // 必须**每轮**注入：前端每轮用本地消息重建 messages（ChatNodeKernel），服务端 prepend
        // 的动态上下文不回传前端，首轮注入的快照第 2 轮即消失。成本靠紧凑版压住：
        // 首轮全量（≤2400 字符，含出处与逐份清单），后续轮紧凑版（≤800 字符，账本只留标题+id、
        // 材料只留一级目录汇总）。清单是"有哪些可选"，不是"该看哪些"，不替模型做相关性判断。
        const isFirstTurn = messages.filter((m) => m.role === 'user').length <= 1;
        let archiveBrief = '';
        try {
          const { buildProjectArchiveBrief } = await import('@/lib/runtime/project-brief');
          archiveBrief = await buildProjectArchiveBrief(projectRoot as string, { compact: !isFirstTurn });
        } catch (e) {
          // 预取失败不影响对话：退回纯软指针（无快照）
          console.warn('[chat] 项目档案预取失败（已降级为软指针）:', e instanceof Error ? e.message : String(e));
        }
        finalMessages = prependDynamicContext(
          finalMessages,
          // P0-1 权威顺序紧凑版挂在快照头：模型读到账本索引/材料清单时就先知道「账本不出结论」
          archiveBrief ? `${LEDGER_HINT}\n${MEMORY_AUTHORITY_BRIEF}\n${archiveBrief}` : `${LEDGER_HINT}\n${MEMORY_AUTHORITY_BRIEF}`,
        );
      }

      // 账本编译不由对话触发：材料登记后宿主自起后台会话（lib/mcp/ledger-compile.ts）
      // —— 编译是串行工具往返，份数多则慢，放进对话轮次只会拖慢用户等待。

      // 报告插图约定按需注入（报告/调研类交付物才注入）：
      // 已从 system 移出，仅生成报告类交付物时需要，避免常驻浪费固定 token。
      // 收敛信号词：只保留强交付词（报告/调研/研报/白皮书/可行性/尽调/意见书），
      // 去掉"XX分析"等模糊词（"深度分析这个问题"≠生成报告，避免误注入 REPORT_RULES）。
      // Research 开关打开时排除：该档已由 BROWSER_RESEARCH_RULES 的综述骨架管「答复怎么组织」，
      // 两套同注入会把答复推向「homework/ 交付物」口吻（骨架要的是会话内综述）。
      // 开关关闭时不排除：没有综述骨架，报告交付物约定仍是唯一相关指引。
      if (
        !sandbox &&
        !researchMode &&
        /报告|调研|研报|白皮书|可行性|尽调|意见书/i.test(extractLastUserContent(messagesWithNodeBridge))
      ) {
        finalMessages = prependDynamicContext(finalMessages, REPORT_RULES);
      }

      // 可见源 · 能力边界（2026-10-04；2026-10-05 下移至此处）：把「当前能看见什么 / 看不见什么」
      // 如实下发，避免模型对未接入的源含糊承诺或假装执行。
      // 清单由 runtime/sources.ts 注册表按**生效场景集**派生，故调用点贴近 assemble、与工具面同判据
      // （resolveEffectiveScenes 为两者共用），保证「清单里有的源，工具一定在手里」。
      if (identity === 'butler') {
        const sourcesInjection = await contextRuntime.buildVisibleSourcesInjection(
          resolveEffectiveScenes({
            sandbox: !!sandbox,
            profileMode: profile.scenes,
            fixedScenes: toolProfile.fixedScenes,
            activeScenes,
          }),
        );
        if (sourcesInjection) {
          finalMessages = prependDynamicContext(finalMessages, sourcesInjection);
        }
      }

      // 缓存前缀稳定化（P4 + 来源分组）+ CacheGuard 守卫在 ToolRuntime.assemble 内完成
      // （K2-S1 工具面 service 抽取，行为不变：与迁移前模块级 buildAndSortToolDefs 同一确定性排序；
      //   search_capabilities 中途激活场景后重建 loopToolDefs 也复用同一 assemble 管线）。
      // （K1：场景中途激活标志 needRebuildTools 已收敛进 kctx，见 start() 内 const kctx.needRebuildTools）
      const assembledTools = toolRuntime.assemble(activeScenes);
      let toolDefs = assembledTools.toolDefs;
      let loopToolDefs = assembledTools.loopToolDefs;

      // MCP 自带说明书按需注入（与工具面同一条判据）：只对**工具真的在册**的 server 注入它的
      // instructions —— 按 toolDefs 里的 `mcp__<serverId>__` 前缀对齐，杜绝「指引有、工具没有」。
      // 走 prependDynamicContext（随当前轮 user 消息，不进 system、不回传前端即不落盘）；
      // 服务未声明说明书时整段不出现，零常驻成本。
      try {
        const inRegistry = new Set<string>();
        for (const d of toolDefs) {
          const n = (d as { function?: { name?: string }; name?: string })?.function?.name ?? (d as { name?: string })?.name ?? '';
          const m = /^mcp__[a-zA-Z0-9_-]+?__/.exec(n);
          if (m) inRegistry.add(m[0]);
        }
        if (inRegistry.size > 0) {
          const { mcpManager } = await import('@/lib/mcp/manager');
          const briefs = (await mcpManager.discoverServerInstructions()).filter((b) => inRegistry.has(b.toolPrefix));
          if (briefs.length > 0) {
            finalMessages = prependDynamicContext(finalMessages, buildMcpInstructionsText(briefs));
          }
        }
      } catch (e) {
        // 说明书注入失败不阻断对话（与账本预取同一降级姿态）
        console.warn('[chat] MCP 说明书注入失败（已跳过）:', e instanceof Error ? e.message : String(e));
      }

      const isMoonshotThinking = !!baseUrl && baseUrl.includes('moonshot') && !!providerModelId && /kimi-k\d/i.test(providerModelId);
      const finalTemp = isMoonshotThinking || isDeepseekV4 ? 1 : (temperature ?? 0.7);

      // 用户对话优先级最高（见 @/lib/runtime/project-scheduler）：持有期间后台任务（成果块提炼 /
      // 账本编译）不启动 —— 不抢模型、不同时写项目文件。整轮结束（正常/异常/断开）在流收尾释放。
      // 放在这里而不是更早：此前还有 R-14 拒绝执行等提前 return 的分支，那样会漏释放、把后台永久挡死。
      const leaveUserTurn = projectRoot ? enterUserTurn(projectRoot) : () => {};

      const readableStream = new ReadableStream({
        async start(controller) {
          // P4c-1 压缩事件化：taskId/eventLog 已提前创建（Node Bridge 压缩事件需同日志），此处直接复用
          const send = (data: Record<string, unknown>) => {
            // 同步记录事件（append-only 日志，流式 reasoning/content 块被 EventLog 跳过）
            eventLog.record(data);
            // abort/断开后 controller 已关闭：任何迟到的帧（挂起心跳/超时 resolve）不得再 enqueue，
            // 否则抛 ERR_INVALID_STATE → uncaughtException（P4a 挂起心跳回归点，已实测复现）
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            } catch {
              /* stream closed —— 静默忽略迟到帧 */
            }
          };
          // 关闭 SSE 流（2026-09-15）：客户端断开后底层流可能已被 cancel，此时 close() 抛
          // ERR_INVALID_STATE → uncaughtException。正常/异常收尾统一走这里。
          const closeStream = () => {
            try {
              controller.close();
            } catch {
              /* 流已关闭/已取消 —— 忽略 */
            }
          };
          eventLog.mark(CORE_EVENT.TURN_START, taskId, { nodeId, identity, model: providerModelId || modelId || '', userInput: initialUserInput ?? '' });
          eventLog.mark(CORE_EVENT.USER_MESSAGE, taskId, { role: 'user', content: initialUserInput ?? '' });

          // 空闲看门狗心跳（2026-09-15）：前端 90s 超时是「空闲」语义——收到任一 SSE 帧即重置计时器。
          // 但上游单轮模型调用可能长时间静默（实测有 506s 才返回首帧、期间服务端一帧不发的场景），
          // 前端会在 90s 处误判超时 abort 并渲染 "Request timed out"，而服务端仍在继续跑（继续烧 token）。
          // 这里在整轮生命周期内每 20s 推一个轻量心跳帧，保证任意静默窗口都远小于 90s
          // （与 vision_progress 进度帧、ask_user_questions 挂起心跳同一思路，见本文件 L1801 视觉识别心跳）。
          // 心跳不进 EventLog（轨迹只记业务事件）；前端对未识别帧静默忽略（ChatNodeKernel 解析区按 key 匹配）。
          const watchdogId = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ watchdog: Date.now(), nodeId })}\n\n`));
            } catch {
              /* stream closed —— 静默忽略迟到帧（与 send 一致） */
            }
          }, 20_000);

          // 客户端断开（2026-09-15）：前端 90s 空闲看门狗 abort / 用户点"停止"后连接断开，
          // Next.js 会在 request.signal 上触发 abort。据此做三件事，避免被抛弃的轮次继续跑完烧 token：
          //   ① 模型请求传 signal → 上游 HTTP 立即中断（SDK 抛 APIUserAbortError，isRetryableCompletionError 判不可重试）；
          //   ② 重试退避后、每轮工具循环开头检查 aborted → 及时退出，不再发起新的模型调用；
          //   ③ catch 中识别为断开 → 不再推错误帧，仅持久化轨迹（保留被打断现场）。
          // 注：工具执行中（如 ask_user_questions 挂起 600s）的即时中断不在此范围，需等该工具返回后于轮次边界退出。
          try {
            // === ② Skills / MCP 概览提前推送：SSE 第 1 条就发，不让用户等到整轮结束 ===
            //   - matchedSkills: 后端注入的技能名（含 强制+自动 合并）
            //   - enabledMcps:   本轮启用的 MCP 服务清单 {id, name, toolCount}
            //   前端收到后立即渲染命中条，不用等 done 事件
            {
              // 注意：toolDefs 已被 activeScenes 场景过滤（两层过滤），
              // 所以下面统计的 mcpToolCountsMap 只包含"本轮实际注入到模型上下文"的 MCP 工具。
              const rawEnabledList = (settingsForTools.mcpServers || [])
                .filter((s) => s.enabled !== false)
                .map((s) => ({ id: s.id, name: s.name || s.id }));
              // 统计每个 server 的工具数（注意：key 是 sanitize 清洗后的 serverId，与 tool 名 mcp__<safeId>__<tool> 一致）
              // toApiFormat 返回 { type, function: { name, ... } }，工具名在 td.function.name（td.name 为 undefined）
              const mcpToolCountsMap: Record<string, number> = {};
              for (const td of toolDefs) {
                // 宽松视图：兼容个别 MCP 下发的非标准定义（缺 function 或仅有 name）
                const tdView = td as { function?: { name?: string }; name?: string };
                const name = tdView.function?.name ?? tdView.name;
                if (name && name.startsWith('mcp__')) {
                  const parts = name.split('__');
                  const srv = parts[1] || '';
                  if (srv) mcpToolCountsMap[srv] = (mcpToolCountsMap[srv] || 0) + 1;
                }
              }
              // 关键：只保留"场景过滤后实际有工具被注入"的 MCP server，避免显示"已注入 X 个 0 工具的 MCP"。
              // 同时修复：serverId 含 -/. 等字符时，工具名里的 key 经 sanitizeToolName 清洗过，
              //   必须用相同方式清洗后再查，否则 bob-ocr-mcp 这类 id 永远读不到 count。
              const { sanitizeToolName } = await import('@/lib/mcp/manager');
              const enabledMcps = rawEnabledList
                .map((s) => ({
                  id: s.id,
                  name: s.name,
                  toolCount: mcpToolCountsMap[sanitizeToolName(s.id)] || 0,
                }))
                .filter((s) => s.toolCount > 0);
              // 手动勾选强制注入的 skills 单独列出来，方便前端区分"强制注入 vs 空"
              const forced = forcedSkills && forcedSkills.length > 0
                ? matchedSkillNames.filter((n) => forcedSkills.includes(n))
                : [];
              send({
                matchedSkills: matchedSkillNames,
                forcedSkills: forced,
                enabledMcps,
                skillDetails,
                nodeId,
              });
            }

            // ===== 视觉增强（首字节前提速：图片识别延后到流内执行） =====
            // 识别期间持续发 vision_progress 事件：前端收到任一 SSE 帧即重置 90s 空闲超时计时器，
            // 慢识别（多图 × 多候选模型降级）不再被误判为"请求超时"；同时用户可看到识别进度。
            let effectiveMessages: ChatMessage[] = finalMessages;
            const visionNeeded = finalMessages.some(
              (m) => m.role === 'user' && /图片/.test(m.content || '') && /路径: (?:materials|attachments|assets)\//.test(m.content || ''),
            );
            // 直连多模态：当前对话模型本身支持视觉且项目路径可解析时，把图片附件以
            // image_url 段直接随消息发送（buildDirectVisionPayloads → 每轮 materialize），
            // 跳过 bob-ocr-mcp 描述注入，保留原图像素供模型直接查看。判定与模型池标注同源。
            let directVisionPlan: DirectVisionPayload[] | null = null;
            try {
              if (projectRoot && chatModelSupportsVision(providerModelId)) {
                directVisionPlan = buildDirectVisionPayloads(finalMessages, projectRoot);
              }
            } catch (e) {
              console.warn('直连多模态图片准备失败，回退描述注入:', e);
              directVisionPlan = null;
            }
            // 无直连计划（非视觉模型 / 项目路径缺失 / 无成功读取的图片）时，
            // 维持既有行为：Vision Bridge 描述注入后回填文本。
            if (directVisionPlan && directVisionPlan.length > 0) {
              console.log(
                `[direct-vision] 多模态直连启用 model=${providerModelId} 图片消息=${directVisionPlan.length} 图片段=${directVisionPlan.reduce((n, p) => n + p.parts.length, 0)}`,
              );
            }
            if ((!directVisionPlan || directVisionPlan.length === 0) && visionNeeded) {
              try {
                send({ vision_progress: { phase: 'start', current: 0, total: 0 } });
                effectiveMessages = await applyVisionBridge(finalMessages, (p) => send({ vision_progress: p }));
                send({ vision_progress: { phase: 'done', current: 0, total: 0 } });
              } catch (e) {
                console.warn('流内视觉增强失败:', e);
                send({ vision_progress: { phase: 'failed', current: 0, total: 0 } });
              }
            }

            // 工具调用循环
            // ---- K1 会话上下文收敛：把「每轮循环及其子流程共享的请求级状态」归组为 kctx ----
            // interface KernelContext 见模块级定义（POST 之前）；收编范围与未收编项见该 interface 注释。
            const kctx: KernelContext = {
              conversationMessages: [...effectiveMessages],
              allToolCalls: [],
              // 浏览器工具去重页面指纹：browser_active_tab 刷新；页面跳转后变化 → 不误判重复调用
              lastPageUrl: null,
              // search_capabilities / load_skill 中途激活场景后置 true → 下一轮请求前重建 loopToolDefs
              // （takeoverServices.requestToolRebuild 触发；重建后场景已 sticky，后续轮次字节稳定）
              needRebuildTools: false,
              // 完成确认轮只允许一次：模型本轮未调用任何工具时，追加一轮「任务是否真正完成」确认，
              // 防止模型过早自我判定完成（假完成）导致任务不完整；再次无工具调用才接受收尾
              completionConfirmUsed: false,
              // 截断重试 / 触顶统计 / 空答案兜底判据（2026-10-08 事故：详见 chat/empty-round.ts 文件头）
              truncationRetries: 0,
              truncatedRounds: 0,
              finalAnswerText: '',
              // 声明真实性校验纠偏次数计数（防无限纠偏循环；D-B：保持现状仅记录）
              claimMismatchCorrections: 0,
              // 停滞保护：连续 STALL_LIMIT 轮无实质进展 → 判定死循环，进入强制收尾轮（检测在循环末尾）
              stallCount: 0,
              // 强制收尾轮：置 true 后下一轮不带 tools，让模型基于注入的收尾说明输出最终回答；
              // lite 模式（侧边栏等外部轻量问答）：首轮即收尾、不带工具，模型直接回答，
              // 避免工具循环反复调用 browser_* 等多轮生成重复内容
              forceFinalRound: !!lite,
              // OCR 重试预算门控标志：已触发后不再重复注入「停止重试」指令
              ocrBudgetExceeded: false,
              // 收敛护栏（与停滞保护互补）：同一工具连续主导轮数 + 累计次数双阈值，治「有进展但不收敛」
              convergenceTool: null,
              convergenceRounds: 0,
              toolConvergenceExceeded: false,
              // AI Coding 任务预算门控（2026-10-10 B4）：
              taskBudgetExceeded: false,
              // 工具循环思考降级遥测（item 4 验证）：执行轮降级轮数（对照 done 日志 hitRate）
              thinkingDowngradedRounds: 0,
              // 思考决策可见性（方向 D）：每轮实际模式入账
              thinkingModes: [],
              // 模型调用总轮数（dsh 完成轮次统计条 / done rounds 字段）
              totalRounds: 0,
              // 跨轮累计本次任务真实 token 消耗（所有模型调用轮次之和）。
              // cacheHitTokens / cacheMissTokens：DeepSeek 前缀缓存遥测（§4.4 —— 命中部分按缓存价计费）
              taskUsage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, calls: 0 },
              // ---- 轮次统计（dsh 完成轮次统计条）：TTFT / 总耗时 / 吞吐 ----
              // taskStartMs：整轮任务开始（首轮模型调用之前）；firstTokenMs：首个 content/reasoning 块到达时刻
              taskStartMs: Date.now(),
              firstTokenMs: null,
              // 快照本轮开始前的 homework/ 目录，结束时比对出新产出（兜底输出卡片，
              // 覆盖 run_command / execute_script 等未在结果中带路径标记的写入方式）
              homeworkSnapshot: projectRoot ? listHomeworkFiles(projectRoot) : null,
            };

            // 浏览器工具去重用的「页面 URL 指纹」（状态本体见 kctx.lastPageUrl）：
            // 每次 browser 工具成功执行后刷新；页面跳转后 kctx.lastPageUrl 变化
            // → 相同参数的调用不再被误判为「重复调用」。
            // 通道分流（与工具面注入一致，settings.aiBrowser；缺省 = hippo）：
            //   chrome → Bob Browser MCP 的 browser_active_tab；
            //   hippo  → 内置通道无 active_tab 工具，改由 HippoDriver 查桥 /state
            const fetchCurrentPageUrl = async (): Promise<string | null> => {
              if (settingsForTools.aiBrowser !== 'chrome') return getHippoPageUrl();
              try {
                const raw = await mcpManager.callTool('mcp__bob-browser-mcp__browser_active_tab', {});
                const m = String(raw || '').match(/"url"\s*:\s*"(https?:\/\/[^"]*)"/);
                return m ? m[1] : null;
              } catch {
                return null;
              }
            };

            //（K1：完成确认 kctx.completionConfirmUsed / 纠偏计数 kctx.claimMismatchCorrections / 停滞 kctx.stallCount /
            //  强制收尾 kctx.forceFinalRound / OCR 门控 kctx.ocrBudgetExceeded / 降级遥测 kctx.thinkingDowngradedRounds /
            //  轮计数 kctx.totalRounds / 用量 kctx.taskUsage / kctx.taskStartMs / kctx.firstTokenMs —— 均已收敛进上方 kctx，
            //  原散落声明与注释随迁至 kctx 字面量内，见 interface KernelContext）

            // ---- 上下文占用 Meter（dsh ContextMeter）----
            // 按 系统/工具/对话 分组估算 + 模型 contextWindow 容量，SSE 推送给前端 composer 圆环。
            // 任务开始发一次（当前状态），done 时再发一次最终状态（含工具结果回灌后的真实占用）。
            // 缓存头分段指纹（pi-reasonix + item 3）：system / 工具 / 历史 三段独立 hash + 总指纹。
            // 前端仍用 prefixHash（总指纹）做跨任务对比；命中率下降时对照三段 hash 精确定位漂移段：
            //   - system 变 → 注入/项目路径/偏好/AI Coding 上下文变动
            //   - tools 变 → 工具集变动（MCP 连接/注册顺序）
            //   - history 变 → 历史消息漂移（R-14 裁剪、压缩游标跳动）
            // 避免"只知道缓存没命中、不知道是哪段断的"。
            const prefixSegments = (() => {
              try {
                const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
                const sys = finalMessages.find((m) => m.role === 'system')?.content ?? '';
                // P4：tools 段 hash 按 name 排序归一化（语义指纹，忽略顺序），
                // 避免 MCP 连接/注册顺序变化导致同一工具集 hash 漂移
                const sortedToolDefs = [...loopToolDefs].sort((a, b) => {
                  const na = (a as { function?: { name?: string } })?.function?.name ?? '';
                  const nb = (b as { function?: { name?: string } })?.function?.name ?? '';
                  return na.localeCompare(nb);
                });
                const tools = JSON.stringify(sortedToolDefs);
                // 字节级指纹：按实际发送顺序（loopToolDefs）逐字节 hash。与 tools（语义指纹）对照
                // 可区分「工具集变化」与「发送顺序漂移」：命中率掉但 tools 不变 → 查 toolsByte
                // （顺序变了）；tools 也变 → 查 CacheGuard 落盘的具体工具 diff。
                const toolsByte = JSON.stringify(loopToolDefs);
                // 历史段：除 system 与当前轮最后一条 user 之外的消息（最后一条为本轮输入，每次必然不同）
                const historyMsgs = finalMessages.filter((m, i) => m.role !== 'system' && i < finalMessages.length - 1);
                const history = historyMsgs
                  .map((m) => JSON.stringify({ r: m.role, c: typeof m.content === 'string' ? m.content : '' }))
                  .join('\x00');
                return {
                  system: h(sys),
                  tools: h(tools),
                  toolsByte: h(toolsByte),
                  history: h(history),
                  all: h(sys + '\x00TOOLS\x00' + tools + '\x00HIST\x00' + history),
                };
              } catch {
                return { system: '', tools: '', toolsByte: '', history: '', all: '' };
              }
            })();
            const prefixHash = prefixSegments.all;

            const sendContextMeter = () => {
              const ctx = estimateContextBreakdown(kctx.conversationMessages, loopToolDefs);
              send({
                context_meter: {
                  system: ctx.systemTokens,
                  tools: ctx.toolsTokens,
                  conversation: ctx.conversationTokens,
                  capacity: inferContextWindow(
                    providerModelId || '',
                    // S2a：effort≠none 视为思考模式请求（none = off/C1 关思考）
                    baseEffort !== 'none',
                  ),
                },
                prefixHash,
                prefixSegments,
                nodeId,
              });
            };
            sendContextMeter(); // 首轮前下发（显示当前上下文占用，供 composer 圆环预览）

            // P4a 三段化骨架：宿主注入给接管管线的最小服务面（tool-pipeline.ts）——
            // 场景激活副作用（activeScenes.add / sticky / kctx.needRebuildTools）统一经此执行。
            // K2-S2 会话态 service，行为不变：addStickyScene 与原分支语义一致——
            // 仅 nodeId 存在时落 SessionRuntime（跨请求保持），无 nodeId 的会话不持久化、仅当轮生效。
            const takeoverServices: TakeoverServices = {
              activeScenes,
              addStickyScene: (scene) => {
                if (nodeId) sessionRuntime.addStickyScene(nodeId, scene);
              },
              requestToolRebuild: () => {
                kctx.needRebuildTools = true;
              },
            };

            // 前缀缓存 per-call 遥测跟踪器：**按会话（nodeId）取、跨任务复用**，
            // 这样"上一任务最后一次发送的前缀"能作为本任务首调的比对基准——跨任务边界正是
            // 「重放历史与上次实际发送不一致」唯一可观测的地方（@资料块丢失 / 压缩游标跳过 / R-14 裁剪）。
            // 无 nodeId 的调用方（外部 HTTP 客户端）用一次性 key，退化为任务内逐轮比对。
            // 与任务级 prefixSegments 并存：后者是"循环前算一次"的展示用指纹，本跟踪器按每次调用采样。
            const callPrefixTracker = getSessionTracker(nodeId || `task:${taskId}`);

            for (let round = 0; ; round++) {
              // 客户端已断开（前端看门狗 abort / 用户点停止）→ 不再发起新一轮模型调用
              if (request.signal.aborted) throw new Error('客户端已断开连接，本轮已中止。');

              // ===== AI Coding 任务硬预算（2026-10-10 评估 B4）=====
              // 绑定小程序的 coding 节点：轮数 或 墙钟超限 → 注入收尾说明 + 强制收尾轮。
              // 只触发一次（taskBudgetExceeded），避免与"收尾轮解除"逻辑互相打架导致反复注入。
              if (
                !kctx.taskBudgetExceeded &&
                !!toolLoopSandboxAppId &&
                (round >= CODING_TASK_MAX_ROUNDS || Date.now() - kctx.taskStartMs > CODING_TASK_MAX_MS)
              ) {
                kctx.taskBudgetExceeded = true;
                kctx.conversationMessages.push({
                  role: 'user',
                  content: `已达到本任务预算上限（${CODING_TASK_MAX_ROUNDS} 轮或 ${Math.round(CODING_TASK_MAX_MS / 60000)} 分钟）。请立即停止一切工具调用，基于已完成的修改给出最终回答，并在末尾用【未完成项】如实列出还没做完的部分；不要声称已完成未经预览验证的改动。`,
                });
                send({ task_budget_exceeded: true, rounds: round, nodeId });
                kctx.forceFinalRound = true;
                continue;
              }
              // 场景中途激活（search_capabilities / load_skill 法律技能）→ 用最新 activeScenes
              // 重算 toolDefs 再重建 loopToolDefs，下一轮模型请求携带新工具集；
              // 重建后本会话场景已 sticky，后续轮次字节稳定。
              if (kctx.needRebuildTools) {
                // K2-S1 工具面 service 抽取，行为不变：复用同一 assemble 管线（最新 activeScenes）重建
                const rebuilt = toolRuntime.assemble(activeScenes);
                toolDefs = rebuilt.toolDefs;
                loopToolDefs = rebuilt.loopToolDefs;
                kctx.needRebuildTools = false;
                console.log(`[chat] 场景中途激活后重建工具集: n=${loopToolDefs.length}`);
              }
              const isFinalRound = kctx.forceFinalRound;
              // lite 模式不注入「基于以上结果」的收尾指令（首轮即是最终回答，无前置工具结果）
              const finalRoundInjection = isFinalRound && !lite;
              // item 6：max_tokens 分级——max 深度放宽到 32k（高思考深度下
              // reasoning 占用大半输出预算，16k 仍可能截断正文）；仅对 1M 推理大模型档
              // （函数返回 16384）翻倍，128k/小模型档保持不动，避免超出模型支持上限触发 API 400。
              // S2b：判据收敛为统一 baseEffort==='max'（仅 UI max 档 → max；legacy medium→high、
              // high→high 不放大）
              const baseMaxTokens = modelOutputTokenMaxForModel(providerModelId || '', baseEffort !== 'none');
              const highDepthRequest = baseEffort === 'max';
              // 截断重试（kctx.truncationRetries>0）同样放宽预算：把「思考吃满输出预算」当可恢复故障处理，
              // 而不是直接收尾。仍只对 ≥16384 档（1M 推理大模型）放大，低档位不动（超出支持上限会 400）。
              const widenOutputBudget = highDepthRequest || kctx.truncationRetries > 0;
              const effectiveMaxTokens = widenOutputBudget && baseMaxTokens >= 16384
                ? Math.min(baseMaxTokens * 2, TRUNCATION_RETRY_MAX_TOKENS)
                : baseMaxTokens;
              const baseRoundMessages = finalRoundInjection
                ? [
                    ...kctx.conversationMessages,
                    {
                      role: 'user' as const,
                      content: '请基于以上结果给出最终回答，不要再调用任何工具。如果仍有未完成的步骤，请在回答末尾用【未完成项】明确列出，供用户决定是否继续。',
                    },
                  ]
                : kctx.conversationMessages;
              // 直连多模态：每轮发送前把携带图片附件的 user 消息物化为「text + image_url」content 段。
              // conversationMessages 始终是纯文本（图片只在发送体出现），直连计划跨轮复用（base64 只读一次）。
              const roundPayloadMessages = directVisionPlan && directVisionPlan.length > 0
                ? materializeDirectVisionMessages(baseRoundMessages, directVisionPlan)
                : baseRoundMessages;
              // ---- 前缀缓存 per-call 遥测（2026-10-02）----
              // 任务级 prefixSegments 只在循环前算一次，看不出"第几次调用漂的、漂了多少钱"。
              // 这里按**每次调用**采集三段指纹与漂移标记，待 usage 块到达时随 hit/miss 一起落盘
              // （.logs/cache-telemetry.jsonl），让下次复盘能直接把 miss 归因到「工具段漂移 /
              // 历史被改写 / 新内容首次读入」三类，不必再按时间窗口 join 两套日志。
              // 口径：history 链走 baseRoundMessages（纯文本、任务内只追加），直连多模态的
              // materialize 是确定性变换，不参与指纹（否则视觉会话每轮都会误报"历史被改写"）。
              const callPrefix = callPrefixTracker.describe(baseRoundMessages, lite ? [] : loopToolDefs);
              const requestBody: Record<string, unknown> = {
                model: providerModelId,
                messages: roundPayloadMessages,
                stream: true,
                temperature: finalTemp,
                // 请求流式响应随附 usage 汇总块，末 chunk.usage 即本轮真实 token 计数
                stream_options: { include_usage: true },
                // 显式声明单次输出上限：不传时多数 API 默认 4096，高思考深度下 reasoning 占用大半，
                // 正文往往写不完就戛然而止（无任何提示）。按模型上下文窗口动态推断：
                // 1M 模型 → 16384（deepseek-v4/doubao-seed 等输出上限高，避免正文被 8192 截断）；
                // 128k/256k → 12288；小模型 → 8192（已验证安全）。
                max_tokens: effectiveMaxTokens,
              };
              // 每轮都携带 tools（缓存前缀稳定化）：tools 数组属于请求前缀的一部分，
              // 若中途轮次去掉 tools（如原收尾轮逻辑），该轮前缀与循环内其余轮不同 →
              // 整个任务历史（可能数十万 token）在该轮全部按缓存未命中全价重算。
              // 带上 tools 后模型若仍调用工具会继续执行循环（见下 kctx.forceFinalRound 解除），
              // 无工具调用即正常收尾，行为与原先一致。
              // 例外：lite 模式（侧边栏等外部轻量问答）保持首轮不带 tools（本来就是
              // 一次性独立问答、无工具循环，携带 tools 反而诱导模型反复调用生成重复内容）。
              if (!lite) {
                requestBody.tools = loopToolDefs;
              }

              // 思考决策（S2a 统一 effort 词表，V4 与非 V4 同一套）：
              //  - harnessPure=true（默认，纯 DSH 固定档）：每轮一律发 baseEffort（用户所选档位），不降级、不 C1；
              //  - harnessPure=false（旧业务插件）：执行轮（round>0 且非收尾轮）按 policy 的 effort 降级表
              //    降一档（max→high、high→low、low→none、none→none）；首轮/收尾轮保持 baseEffort
              //    （baseEffort 可含 C1 压成的 none）。深度推理放规划轮，执行轮只做决策，省 reasoning tokens。
              // 降级决策收敛到 policy.executionDowngrade（仅 harnessPure=false 时生效，默认开）
              const downgradeDecision = modelSupportsThinking
                ? executionDowngrade(round, isFinalRound, level, thinkingPolicyConfig)
                : null;
              let roundEffort = downgradeDecision?.reasoningEffort ?? baseEffort;
              // 浏览器侧栏专用例外：执行轮几乎都是机械动作（snapshot / click / download），
              // 在 harnessPure 固定档下也定向降一档，避免每轮都按 high 思考烧时间。
              // 规划轮（round 0）与收尾轮保持原档；用户关闭 downgradeOnExecution 即恢复纯固定档。
              if (
                !downgradeDecision &&
                profile.id === 'browser' &&
                modelSupportsThinking &&
                round > 0 &&
                !isFinalRound &&
                baseEffort !== 'none' &&
                thinkingPolicyConfig.downgradeOnExecution
              ) {
                roundEffort = downgradeEffortOnce(roundEffort);
              }
              // 截断重试第 2 次起：连输出预算翻倍都还撞顶 → 定向再降一档思考（harnessPure=true 下也生效：
              // 这是对本任务**已观测故障**（finish_reason=length 空轮）的纠偏，不是常态执行轮降级）。
              if (kctx.truncationRetries >= 2 && modelSupportsThinking && baseEffort !== 'none') {
                roundEffort = downgradeEffortOnce(roundEffort);
              }
              const thinkingDowngraded = round > 0 && !isFinalRound && roundEffort !== baseEffort;
              eventLog.mark(CORE_EVENT.STEP_START, `${taskId}:r${round}`, { round });
              kctx.totalRounds++;
              if (thinkingDowngraded) kctx.thinkingDowngradedRounds++;
              // 思考决策可见性（方向 D）：每轮实际档位入账（effort 值 none/low/high/max），
              // done 帧带出供前端展示降级/C1 命中
              kctx.thinkingModes.push({
                round,
                mode: roundEffort,
                downgraded: thinkingDowngraded,
                // C1 命中（仅 harnessPure=false）：琐碎关思考把首轮档位压成 none
                trivialOff: !thinkingPolicyConfig.harnessPure && round === 0 && roundEffort === 'none' && trivialPrompt,
              });

              // 统一传输：支持思考的模型每轮都带 reasoning_effort（含 none，C1/off 即 none）；
              // 不支持的模型不传（模型能力判定 modelSupportsThinking 保留）
              if (modelSupportsThinking) {
                requestBody.reasoning_effort = roundEffort;
              }

              console.log(
                `[chat] round=${round}${thinkingDowngraded ? ' [thinking降级]' : ''} model: ${providerModelId} | thinking_level: ${level} | effort: ${roundEffort} | reasoning_effort: ${modelSupportsThinking ? roundEffort : '(unsupported)'}`,
              );

              // C7（deepseek-harness）：DeepSeek V4 发送前校验 prompt+max_tokens ≤ 1,048,576 硬上限。
              // 超限直接给出可读错误（而非等 DeepSeek 返回 400），提示用户拆分对话/节点。
              if (isDeepseekV4) {
                const estIn = estimateMessagesTokens(requestBody.messages as ChatMessage[]);
                const estMaxOut = typeof requestBody.max_tokens === 'number' ? requestBody.max_tokens : 0;
                if (estIn + estMaxOut > DEEPSEEK_MAX_CONTEXT_TOKENS) {
                  throw new Error(
                    `上下文超长（估算输入约 ${Math.round(estIn / 1000)}k tokens + 输出上限 ${Math.round(estMaxOut / 1000)}k），超过 DeepSeek V4 的 ${(DEEPSEEK_MAX_CONTEXT_TOKENS / 1000).toLocaleString()}k token 硬上限。请拆分对话/节点、或精简历史后再试。`,
                  );
                }
              }

              // 429/5xx/网络错误的指数退避重试（deepseek-harness 限流稳健化）：
              // 请求建立阶段失败（尚未收到任何流式块）才重试，流中途断开不重试（工具可能已执行，重放有副作用）。
              let completion: AsyncIterable<{
                choices?: Array<{
                  delta?: {
                    content?: string | null;
                    reasoning_content?: string | null;
                    tool_calls?: Array<{
                      index: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                  finish_reason?: string;
                }>;
                usage?: {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                  total_tokens?: number;
                  // DeepSeek 原生缓存字段
                  prompt_cache_hit_tokens?: number;
                  prompt_cache_miss_tokens?: number;
                  // OpenAI 兼容格式缓存字段（部分代理只填这一侧）
                  prompt_tokens_details?: { cached_tokens?: number };
                };
              }>;
              for (let attempt = 1; ; attempt++) {
                // 客户端已断开 → 不再重试（重试只会把 token 烧在被抛弃的轮次上）
                if (request.signal.aborted) throw new Error('客户端已断开连接，本轮已中止。');
                try {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  completion = (await (client.chat.completions.create as any)(
                    { ...requestBody, stream: true },
                    // 客户端断开时立即中止上游请求（SDK 抛 APIUserAbortError，不可重试）
                    { signal: request.signal },
                  )) as AsyncIterable<{
                    choices?: Array<{
                      delta?: {
                        content?: string | null;
                        reasoning_content?: string | null;
                        tool_calls?: Array<{
                          index: number;
                          id?: string;
                          function?: { name?: string; arguments?: string };
                        }>;
                      };
                      finish_reason?: string;
                    }>;
                    usage?: {
                      prompt_tokens?: number;
                      completion_tokens?: number;
                      total_tokens?: number;
                      prompt_cache_hit_tokens?: number;
                      prompt_cache_miss_tokens?: number;
                      prompt_tokens_details?: { cached_tokens?: number };
                    };
                  }>;
                  break; // 请求建立成功，进入流式消费
                } catch (createErr) {
                  if (attempt >= COMPLETION_MAX_ATTEMPTS || !isRetryableCompletionError(createErr)) {
                    throw createErr;
                  }
                  // 优先尊重服务端 Retry-After 头；否则指数退避 + 随机抖动（防多节点同时重试打满网关）
                  const retryAfterMs = (() => {
                    if (typeof createErr === 'object' && createErr !== null) {
                      const headers = (createErr as { headers?: Record<string, string | undefined> }).headers;
                      const ra = headers?.['retry-after'];
                      if (ra) {
                        const secs = parseFloat(ra);
                        if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
                      }
                    }
                    return null;
                  })();
                  const delay = Math.min(
                    retryAfterMs ?? (COMPLETION_RETRY_BASE_MS * 2 ** (attempt - 1)),
                    COMPLETION_RETRY_CAP_MS,
                  ) + Math.random() * 300;
                  console.warn(`[chat] 模型请求失败，第 ${attempt}/${COMPLETION_MAX_ATTEMPTS} 次重试（${Math.round(delay)}ms 后）: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
                  send({ retry: { attempt, maxAttempts: COMPLETION_MAX_ATTEMPTS, delayMs: Math.round(delay), reason: createErr instanceof Error ? createErr.message : String(createErr) }, nodeId });
                  await sleepMs(delay);
                  // 退避等待期间客户端断开 → 立即停止重试（退避上限 8s，不值得改成可中断 sleep）
                  if (request.signal.aborted) throw new Error('客户端已断开连接，本轮已中止。');
                }
              }

              // 收集流式内容（C5：list + join 聚合，避免逐块字符串拼接 O(n²) —— DeepSeek SSE 块粒度 1-3 字符，一轮可达数千块）
              const contentParts: string[] = [];
              const reasoningParts: string[] = [];
              const toolCallBuf: Map<number, { id: string; name: string; arguments: string }> = new Map();
              // 本轮是否被 max_tokens 截断（finish_reason=length）——空轮收尾时要区分
              // 「模型摆烂」与「输出被截断」（后者可重试，见 §4.5 截断重试）
              let roundTruncated = false;

              for await (const chunk of completion) {
                // usage 汇总块（include_usage 时，末 chunk 无 choices 仅带 usage）需在 delta 判空之前采集
                if (chunk.usage) {
                  if (typeof chunk.usage.prompt_tokens === 'number') kctx.taskUsage.promptTokens += chunk.usage.prompt_tokens;
                  if (typeof chunk.usage.completion_tokens === 'number') kctx.taskUsage.completionTokens += chunk.usage.completion_tokens;
                  // 缓存遥测：DeepSeek 与 OpenAI 两种字段命名都可能出现（§4.3 字段名桥），
                  // 取两者较大值并互相兜底；命中部分按缓存价（约 1/50）计费，miss 部分按原价。
                  const hit = Math.max(
                    typeof chunk.usage.prompt_cache_hit_tokens === 'number' ? chunk.usage.prompt_cache_hit_tokens : 0,
                    typeof chunk.usage.prompt_tokens_details?.cached_tokens === 'number' ? chunk.usage.prompt_tokens_details.cached_tokens : 0,
                  );
                  if (hit > 0) kctx.taskUsage.cacheHitTokens += hit;
                  if (typeof chunk.usage.prompt_cache_miss_tokens === 'number') kctx.taskUsage.cacheMissTokens += chunk.usage.prompt_cache_miss_tokens;
                  kctx.taskUsage.calls += 1;
                  // per-call 落盘（旁路，失败不影响主链路）：把本次 hit/miss 与发送前缀的三段指纹对齐，
                  // 供离线区分「漂移导致的重复全价读」与「新内容必然的首次读入」。
                  recordCacheCall({
                    ...callPrefix,
                    taskId,
                    nodeId,
                    agent: profile.id,
                    model: providerModelId || modelId,
                    callIdx: kctx.taskUsage.calls,
                    promptTokens: chunk.usage.prompt_tokens ?? 0,
                    completionTokens: chunk.usage.completion_tokens ?? 0,
                    cacheHitTokens: hit,
                    cacheMissTokens:
                      typeof chunk.usage.prompt_cache_miss_tokens === 'number'
                        ? chunk.usage.prompt_cache_miss_tokens
                        : Math.max(0, (chunk.usage.prompt_tokens ?? 0) - hit),
                    cumPromptTokens: kctx.taskUsage.promptTokens,
                    cumCacheHitTokens: kctx.taskUsage.cacheHitTokens,
                    cumCacheMissTokens: kctx.taskUsage.cacheMissTokens,
                    payloadChars: (roundPayloadMessages as Array<{ content?: unknown }>).reduce<number>(
                      (s, m) => s + (typeof m.content === 'string' ? m.content.length : 0),
                      0,
                    ),
                    messageCount: roundPayloadMessages.length,
                  });
                }
                const delta = chunk.choices?.[0]?.delta;
                if (!delta) continue;

                // TTFT（dsh 完成轮次统计）：首个 content/reasoning 块到达时刻（首轮模型响应延迟）
                if (kctx.firstTokenMs === null && (delta.content || delta.reasoning_content)) {
                  kctx.firstTokenMs = Date.now();
                }

                // 输出触顶检测：finish_reason=length 说明本次生成被 max_tokens 截断（内容不完整）
                if (chunk.choices?.[0]?.finish_reason === 'length') {
                  roundTruncated = true;
                  kctx.truncatedRounds += 1;
                  send({ content_truncated: true, nodeId });
                }

                // 思考过程
                const reasoning = delta.reasoning_content ?? undefined;
                if (reasoning) {
                  reasoningParts.push(reasoning);
                  send({ reasoning, nodeId });
                }

                // 文本内容
                if (delta.content) {
                  contentParts.push(delta.content);
                  send({ content: delta.content, nodeId });
                }

                // 工具调用增量
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index;
                    if (!toolCallBuf.has(idx)) {
                      toolCallBuf.set(idx, { id: '', name: '', arguments: '' });
                    }
                    const buf = toolCallBuf.get(idx)!;
                    if (tc.id) buf.id = tc.id;
                    if (tc.function?.name) buf.name += tc.function.name;
                    if (tc.function?.arguments) buf.arguments += tc.function.arguments;
                  }
                }
              }

              // C5：流式内容一次性 join（每轮只 join 一次，后续统一使用聚合后的文本）
              const reasoningText = reasoningParts.join('');
              const contentText = contentParts.join('');
              // 最后一轮正文（每轮覆盖）：整轮结束时为空 → 空答案兜底（§空答案兜底）。
              // 用「最后一轮」而非「是否曾输出过」做判据：中间轮的过程性叙述不构成最终答案。
              kctx.finalAnswerText = contentText;

              // ===== 工具调用回收（deepseek-harness / pi-reasonix scavenge）=====
              // DeepSeek 系模型偶发把工具调用写进 reasoning_content 而非结构化 tool_calls。
              // 本轮无结构化 tool_calls 时，从思考文本回收合法 JSON 结构并当作本轮工具调用执行。
              if (toolCallBuf.size === 0 && reasoningText.trim()) {
                const scavenged = scavengeToolCallsFromReasoning(reasoningText);
                if (scavenged.length > 0) {
                  console.warn(`[工具回收] 从思考内容回收 ${scavenged.length} 个工具调用: ${scavenged.map((c) => c.name).join(', ')}`);
                  send({ tool_scavenged: { count: scavenged.length }, nodeId });
                  for (const c of scavenged) {
                    const idx = toolCallBuf.size;
                    toolCallBuf.set(idx, { id: c.id, name: c.name, arguments: c.arguments });
                  }
                }
              }

              // 检查是否有工具调用
              if (toolCallBuf.size === 0) {
                // 强制收尾轮（带 tools 但模型无工具调用，仅输出文本）已完成 → 结束循环
                // 正文为空时不落 final 事件（收尾轮被截断的情况）：交给整轮结束的空答案兜底
                if (kctx.forceFinalRound && contentText.trim()) eventLog.mark(CORE_EVENT.ASSISTANT_MESSAGE, `${taskId}:r${round}:final`, { round, role: 'assistant', content: contentText, reasoning: reasoningText || undefined, toolCalls: [] });
                if (kctx.forceFinalRound) break;

                // ── 声明真实性校验（Claim Verification）──
                // 模型本轮无工具调用但正文声称"已写入/已生成"某文件 → 反查 kctx.allToolCalls 确认是否真正执行。
                // 仅做告警（send claim_mismatch），不再 push user 消息强制重跑——
                //   强制重跑必然触发第二轮生成（用户看到"AI 回答两遍"），
                //   改为只把告警透传给前端，由用户决定是否继续追问，彻底消除双重回答 bug。
                if (
                  kctx.allToolCalls.length > 0 &&
                  contentText.trim()
                ) {
                  const thinkPrefix = reasoningText ? `<think>${reasoningText}</think>\n` : '';
                  const fullAssistantText = thinkPrefix + contentText;
                  const { mismatches } = verifyClaimsAgainstToolRecords(fullAssistantText, kctx.allToolCalls);
                  const pdfCheck = verifyPdfReadCompleteness(fullAssistantText, kctx.allToolCalls);
                  // 第二类死角：调了工具但没读笔记就"声称引用笔记"——在调过工具(本分支前提)的收尾回答里检测
                  const noteCheck = profile.id === 'note' ? verifyNoteReadClaims(fullAssistantText, kctx.allToolCalls) : { mismatches: [] as string[], correction: null };
                  const allMismatches =
                    mismatches.length > 0
                      ? mismatches
                      : pdfCheck.mismatches.length > 0
                        ? pdfCheck.mismatches
                        : noteCheck.mismatches;
                  if (allMismatches.length > 0) {
                    send({
                      claim_mismatch: {
                        mismatches: allMismatches,
                        correctionCount: kctx.claimMismatchCorrections,
                        suppressed: true, // 明确告知前端：已识别但未强制重跑
                      },
                      nodeId,
                    });
                  }
                }

                // 续写流识别：末尾 user 消息是「补充信息继续原任务」（前端续写模式注入）。
                // 续写请求的 kctx.allToolCalls 从空开始，模型收到补充信息后可能直接给结论不再调工具，
                // 若不识别会被当作「纯问答」直接收尾 → 任务未完成也停止（补充信息后任务被自动终止的根因）。
                const lastUserMsg = [...kctx.conversationMessages].reverse().find((m) => m.role === 'user');
                const isContinuationFlow =
                  typeof lastUserMsg?.content === 'string' &&
                  lastUserMsg.content.startsWith('用户已根据你的提问补充了以下信息');
                //（P4 盘点清理：原 finish_task / todo_write / isFirstRoundWithoutPlan 死分支——
                //  恒位于 toolCallBuf.size===0 内不可达，见 DSH 内核接口面盘点 §1.3；行为不变）
                // 4. 模型本轮已输出正文（最终答案）且无工具调用 → 直接视为完成
                // 正文本身是交付物，不需要再通过 finish_task 确认；防止在最终答案后追加
                // "⏳ Completion check" 提示并诱导模型生成第二遍答案
                // （去双轨：不再剥离 process_narration，正文全文直出，交付物不再被误吞）
                if (contentText.trim()) {
                  eventLog.mark(CORE_EVENT.ASSISTANT_MESSAGE, `${taskId}:r${round}:final`, { round, role: 'assistant', content: contentText, reasoning: reasoningText || undefined, toolCalls: [] });
                  break;
                }

                // 4.5 输出触顶（finish_reason=length）造成的空轮：按**可恢复故障**处理，不记「假完成」
                // 依据 2026-10-08 事故（济星-20261008 /「从甲方角度对本协提出修改意见」）：
                //   high 档 max_tokens=16384 被 reasoning 吃满 → 两轮各 73s/74s 只产出思考（正文与工具调用
                //   全空）→ 旧逻辑把它当模型放弃：补问一次后强制收尾，落盘答案正文为空，
                //   只剩下「⏳ Completion check」+「⚠️ Output reached the model limit」两条系统提示。
                // 处理：加输出预算（第 2 次起再降一档思考）后重试该轮，最多 TRUNCATION_RETRY_LIMIT 次；
                // 预算用尽仍空轮才回到下面的「假完成」判定（详见 src/lib/chat/empty-round.ts）。
                const retryPlan = planTruncationRetry({ truncated: roundTruncated, retriesUsed: kctx.truncationRetries });
                if (retryPlan) {
                  kctx.truncationRetries = retryPlan.attempt;
                  console.warn(
                    `[chat] 本轮输出被长度上限截断且无正文/工具调用，第 ${retryPlan.attempt}/${retryPlan.maxAttempts} 次截断重试` +
                    `（放宽输出预算${retryPlan.downgradeEffort ? ' + 降低思考深度' : ''}）`,
                  );
                  kctx.conversationMessages.push({ role: 'user', content: buildTruncationRetryNudge(retryPlan) });
                  send({
                    truncation_retry: {
                      attempt: retryPlan.attempt,
                      maxAttempts: retryPlan.maxAttempts,
                      boostOutputBudget: retryPlan.boostOutputBudget,
                      downgradeEffort: retryPlan.downgradeEffort,
                    },
                    nodeId,
                  });
                  continue;
                }

                // 5. 检查是否处于"假完成"状态（连续轮无正文且无任何工具调用）
                // 如果之前执行过工具（kctx.allToolCalls > 0）或是续写流，但本轮没有产生新的工具调用
                if (kctx.allToolCalls.length > 0 || isContinuationFlow) {
                  if (!kctx.completionConfirmUsed) {
                    // 第一次追问：要求模型要么继续调工具，要么直接输出正文收尾
                    kctx.completionConfirmUsed = true;
                    kctx.conversationMessages.push({
                      role: 'user',
                      content:
                        '本轮你没有调用任何工具，也没有输出最终答案。请检查：\n' +
                        '1. 如果任务尚未完成，请继续调用相应的工具去执行剩余步骤。\n' +
                        '2. 如果你已确认全部完成，请直接输出最终答案（正文即交付物，无需调用 finish_task）结束本轮。',
                    });
                    send({ completion_check: true, nodeId });
                    continue;
                  } else {
                    // 第二次仍无工具调用：模型放弃（或输出触顶且重试预算已用尽），强制收尾。
                    // 正文为空时**不在此落 final 事件**——交给整轮结束的空答案兜底生成可读正文，
                    // 否则轨迹/落盘会出现一个无语义的空 assistant 答案（2026-10-08 事故）。
                    console.warn(
                      `[chat] 模型连续两次未输出正文或调用工具，强制结束任务` +
                      `（截断 ${kctx.truncatedRounds} 轮 / 截断重试 ${kctx.truncationRetries} 次）`,
                    );
                    if (contentText.trim()) {
                      eventLog.mark(CORE_EVENT.ASSISTANT_MESSAGE, `${taskId}:r${round}:final`, { round, role: 'assistant', content: contentText, reasoning: reasoningText || undefined, toolCalls: [] });
                    }
                    break;
                  }
                }

                // 6. 纯问答（从未调用工具且非续写流，且本轮也无工具调用）→ 接受完成，收尾
                if (kctx.allToolCalls.length === 0 && !isContinuationFlow) {
                  // ── 笔记节点防幻觉兜底（死角修复）：Kar(note) 全程未读任何笔记就给出断言性回答 ──
                  // 触发条件：note 身份 + 本会话从未调用 read_notebook/read_note + 正文非空且非寒暄。
                  // 仅告警（复用 claim_mismatch 通道透传前端），不强制重跑，避免"回答两遍"。
                  if (
                    profile.id === 'note' &&
                    contentText.trim().length > 20 &&
                    !kctx.allToolCalls.some(
                      (t) => t.toolName === 'read_notebook' || t.toolName === 'read_note' || t.toolName === 'read_raw_inbox',
                    )
                  ) {
                    console.warn('[chat] note 节点未读取任何笔记即给出较长回答，疑似凭记忆作答');
                    send({
                      claim_mismatch: {
                        mismatches: [
                          '⚠️ 本轮回答未读取任何笔记（read_notebook / read_note）即给出较长结论。若内容涉及个人知识库，请先检索确认；若确无相关笔记或基于常识作答，请在回答中说明依据。',
                        ],
                        correctionCount: kctx.claimMismatchCorrections,
                        suppressed: true,
                      },
                      nodeId,
                    });
                  }
                  // 纯问答空正文（本轮未输出任何正文）：交给整轮结束的空答案兜底，不落空 final 事件
                  if (contentText.trim()) {
                    eventLog.mark(CORE_EVENT.ASSISTANT_MESSAGE, `${taskId}:r${round}:final`, { round, role: 'assistant', content: contentText, reasoning: reasoningText || undefined, toolCalls: [] });
                  }
                  break;
                }
                
                // 7. 其他情况（本轮有新工具调用，但不是 finish_task）→ 继续循环执行工具
                // 这将在后续的代码中处理，不需要 break
              }

              // 本轮产生了工具调用 → 强制收尾轮解除：模型仍在执行任务（任务未完成），
              // 下一轮回到正常循环，避免重复注入「请基于以上结果给出最终回答」的收尾指令
              // （该指令只应出现一次；收尾轮已带 tools，前缀保持稳定）。
              if (kctx.forceFinalRound) kctx.forceFinalRound = false;

              // 构建 assistant 消息（含 tool_calls）
              const parsedToolCalls = Array.from(toolCallBuf.entries())
                .sort(([a], [b]) => a - b)
                .map(([, buf]) => ({
                  id: buf.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                  type: 'function' as const,
                  function: { name: buf.name, arguments: buf.arguments },
                }));

              // 构建 assistant 消息（含 tool_calls）。
              // 所有轮次都把 reasoning 用 <think> 包裹在 content 最前面：
              //   · 下一轮模型请求会真正看到自己之前的思考，保持"思考→动作"风格的一致性（否则多轮后模型习惯丢失标签）
              //   · node-chat 等纯 SSE 消费方（只看 content）也能拿到并展示思考
              //   · 前端 msg.reasoning 仍然作为优先渲染源（不依赖 content 解析）
              // 若模型直接调用工具未输出文字且无 reasoning，content 为空会触发部分 API 的
              // "assistant message must not be empty" 校验错误（OpenAI 兼容格式允许省略 content）
              const thinkPrefix = reasoningText ? `<think>${reasoningText}</think>\n` : '';
              const finalContent = thinkPrefix + contentText;
              kctx.conversationMessages.push({
                role: 'assistant',
                ...(finalContent ? { content: finalContent } : {}),
                tool_calls: parsedToolCalls,
                // DeepSeek V4 协议要求（deepseek-harness C2）：工具循环内重发 assistant 消息必须回传
                // 原始 reasoning_content 字段，否则 HTTP 400 "reasoning_content must be passed back"。
                // 该字段由本轮流式采集、字节直传（禁止 trim/normalize/重编码），不会破坏前缀缓存；
                // 其他厂商模型忽略此字段，行为不变。
                ...(isDeepseekV4 && reasoningText ? { reasoning_content: reasoningText } : {}),
              });
              eventLog.mark(CORE_EVENT.ASSISTANT_ATTEMPT, `${taskId}:r${round}`, { round, role: 'assistant', content: finalContent || '', reasoning: isDeepseekV4 && reasoningText ? reasoningText : undefined, toolCalls: parsedToolCalls.map((tc: { id?: string; function?: { name?: string; arguments?: string } }) => ({ id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments })) });
              if (isDeepseekV4 && reasoningText) {
                // 前缀缓存可观测性：记录本轮 reasoning 回传长度，便于排查 history 前缀漂移
                console.debug(`[前缀缓存] 第${round + 1}轮 reasoning_content 回传 ${reasoningText.length} 字符（字节直传，禁止改写）`);
              }

              // 执行每个工具调用（跳过重复调用）
              const roundStartToolCount = kctx.allToolCalls.length;
              for (const tc of parsedToolCalls) {
                const toolName = tc.function.name;
                // P0 轨迹：为本次工具调用生成稳定 spanId + 真实开始时间戳，
                // 随 tool_call / tool_result 事件下发（前端 P0 忽略，P1 据此稳定渲染 + 真实耗时）
                const toolSpanId = genSpanId();
                const toolStartAt = Date.now();
                // 工具参数 JSON 修复（deepseek-harness / pi-reasonix repair）：
                // 模型长输出截断导致 arguments 不合法时，先尝试自动补全再执行；补全失败则不执行并提示重试。
                let parsedArgs: Record<string, unknown> | null = null;
                let argsRepaired = false;
                try {
                  parsedArgs = JSON.parse(tc.function.arguments);
                } catch {
                  const repaired = repairTruncatedJson(tc.function.arguments);
                  if (repaired !== null) {
                    try {
                      parsedArgs = JSON.parse(repaired);
                      argsRepaired = true;
                    } catch {
                      parsedArgs = null;
                    }
                  }
                }
                // 方案 B：本步「在做什么」中文动作描述（随 tool_call 下发供 UI 展示，不进模型上下文、不耗 token）
                const callPurpose = describeToolCall(toolName, parsedArgs ?? {});
                if (parsedArgs === null) {
                  // 参数既无法解析也无法修复 → 跳过执行（避免空参误执行），注入修复指令让模型重试。
                  // 长文写入（2026-10-06 实测事故：管家把整份协议塞进 write_file 的 content，22604 字输出
                  // 被长度上限截断 → 解析失败 → 自动修复也没救回）：光说「重新调用、确保 JSON 完整」等于
                  // 让模型再撞一次同一面墙，故对写文件类工具直接给出**可执行的替代路径**（分段写）。
                  const longWriteHint =
                    toolName === 'write_file' || toolName === 'edit_code'
                      ? ' 内容太长会被输出长度上限截断——不要把长文一次性放进一个工具的 arguments：'
                        + '先 write_file 只写第一段，并在末尾留一行占位标记（例如 <!-- MORE -->），'
                        + '再用 edit_code 把该标记分段替换成后续内容（可多次），最后把标记行删掉。'
                      : '';
                  const errMsg = `工具调用参数 JSON 解析失败（可能被输出截断），已跳过执行。原始参数: ${tc.function.arguments.slice(0, 200)}。请重新调用该工具，确保 arguments 为完整合法的 JSON。${longWriteHint}`;
                  kctx.conversationMessages.push({ role: 'tool', tool_call_id: tc.id, content: errMsg });
                  eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: errMsg, name: toolName });
                  send({ tool_call: { name: toolName, arguments: {}, phase: 'error', spanId: toolSpanId, startAt: toolStartAt, purpose: callPurpose }, nodeId });
                  send({ tool_result: { name: toolName, result: errMsg, durationMs: 0, success: false, phase: 'error', spanId: toolSpanId, startAt: toolStartAt, endAt: Date.now() }, nodeId });
                  continue;
                }
                if (argsRepaired) {
                  console.warn(`[工具参数修复] ${toolName} arguments 截断已自动补全: ${tc.function.arguments.slice(0, 100)} → ${JSON.stringify(parsedArgs).slice(0, 100)}`);
                  send({ tool_repair: { name: toolName, repaired: true }, nodeId });
                }

                // 检查是否重复调用同一工具+相同参数
                // 浏览器工具额外感知页面状态：页面已跳转（kctx.lastPageUrl 变化）→ 参数相同但结果不同，不视为重复
                let skipDuplicate = !isPollingTool(toolName) && isDuplicateCall(toolName, parsedArgs, kctx.allToolCalls);
                if (skipDuplicate && isPageStateTool(toolName) && kctx.lastPageUrl) {
                  const argKey = JSON.stringify(parsedArgs);
                  for (let i = kctx.allToolCalls.length - 1; i >= 0; i--) {
                    const h = kctx.allToolCalls[i];
                    if (h.toolName === toolName && JSON.stringify(h.arguments) === argKey) {
                      if (h.pageUrl && h.pageUrl !== kctx.lastPageUrl) {
                        // 该工具上次执行时的页面 URL 与当前不同 → 页面已变化，上次结果已失效，允许重新执行
                        skipDuplicate = false;
                      } else if (hasPageInteractionAfter(kctx.allToolCalls, i)) {
                        // 同 URL 但中间发生过页面交互（切 tab / 点击 / 脚本改 DOM）——URL 指纹抓不到这种变化，
                        // 上次读到的内容同样已失效。按放宽上限判重，而不是直接放行：保留硬顶防「读-滚-读」打转。
                        skipDuplicate = isDuplicateCall(
                          toolName, parsedArgs, kctx.allToolCalls, MAX_DUPLICATE_CALLS_AFTER_INTERACTION,
                        );
                      }
                      break;
                    }
                  }
                }
                if (skipDuplicate) {
                  // 跳过重复调用，直接返回提示
                  const dupResult = '跳过重复调用：已执行过相同参数的此工具，请基于已有结果回答。';
                  kctx.conversationMessages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: dupResult,
                  });
                  eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: dupResult, name: toolName });
                  send({
                    tool_call: { name: toolName, arguments: parsedArgs, phase: 'pending', spanId: toolSpanId, startAt: toolStartAt, purpose: callPurpose },
                    nodeId,
                  });
                  send({
                    tool_result: {
                      name: toolName,
                      result: dupResult,
                      durationMs: 0,
                      success: false,
                      phase: 'error',
                      spanId: toolSpanId,
                      startAt: toolStartAt,
                      endAt: Date.now(),
                    },
                    nodeId,
                  });
                  continue;
                }

                // ① 发送 tool_call 事件（pending 阶段：模型已决定要调这个工具，但还没执行）
                send({
                  tool_call: {
                    name: toolName,
                    arguments: parsedArgs,
                    phase: 'pending',
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                    purpose: callPurpose,
                  },
                  nodeId,
                });

                // ② P4a-3-1 迁移：ask_user_questions 挂起型接管已从 route if 分支收敛为注册式
                //    host-pending 分发（tool-pipeline.ts，行为不变）——模型决定提问的那一刻即触发
                //    弹窗，快且稳定（结构化、无格式容错）。questions_request 载荷字段 / 20s 心跳
                //    时序 / answers 回传文本 / eventLog·tool_result·遥测 / 循环 continue 语义均由
                //    注册 handler（handleAskUserQuestions，见模块级注册）经 ctx 服务面逐位复刻；
                //    'handled_continue' = 已由宿主接管完成 → 跳过下方通用执行逻辑（等价原 if 分支
                //    continue；'handled_fallback'/'noop' 保留给 P4a-3 后续 confirm/login/grant 类）。
                // K3 hook: ask_user (consult seq #1 · before_execute_running)
                const askUserTakeover = hostTakeoverFor(toolName, 'ask_user', 'pre');
                if (askUserTakeover) {
                  const askUserArgs = parsedArgs;
                  const askUserVerdict = await askUserTakeover.handle({
                    name: toolName,
                    args: askUserArgs,
                    nodeId,
                    send,
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                    // 调用通道：**非 undefined = 聚合链路**（微信桥 / ⌘F 面板 /chat），该链路无选项卡片
                    // 也收不到挂起帧，据此改「文本回灌 + 不挂起」
                    channel,
                    // 结果落账三连（顺序与原分支一致：kctx.allToolCalls → 对话历史 → eventLog.TOOL_RESULT）；
                    // round / taskId / tool_call_id / pageUrl 等请求态在闭包内绑定当前值。
                    commitToolResult: (resultText) => {
                      kctx.allToolCalls.push({
                        toolName,
                        arguments: askUserArgs,
                        result: resultText,
                        durationMs: 0,
                        success: true,
                        phase: 'done',
                        pageUrl: kctx.lastPageUrl,
                      });
                      kctx.conversationMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
                      eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: resultText, name: toolName });
                    },
                  });
                  // 该工具已由宿主处理，跳过下方通用执行逻辑
                  if (askUserVerdict === 'handled_continue') continue;
                }

                // ②.0 P4a 三段化骨架：search_capabilities 收敛为注册式 pre-execute 接管
                //     （tool-pipeline.ts 注册表，行为不变）。能力检索/场景去重激活/sticky/
                //     kctx.needRebuildTools 由 pipeline 统一执行；本工具为全接管——未匹配到能力时
                //     decision 仍非 null（scenes 空），照常返回"未找到"文案。decision.meta 携带
                //     匹配条目（含已激活场景）供 buildCapabilityResultText 生成能力清单。
                //     与 ask_user_questions 同为"宿主接管、不落 executeTool"的模式。
                // K3 hook: search_capabilities→scenario_activate (consult seq #2 · before_execute_running)
                const searchCapabilityTakeover = takeoverFor(toolName, 'pre');
                if (searchCapabilityTakeover && searchCapabilityTakeover.kind === 'scenario_activate') {
                  const scenarioDecision =
                    searchCapabilityTakeover.handleScenario?.(toolName, parsedArgs) ?? null;
                  const query = String((parsedArgs as Record<string, unknown>)?.query ?? '');
                  const matched: CapabilityEntry[] =
                    ((scenarioDecision?.meta as { matched?: CapabilityEntry[] } | undefined)?.matched) ?? [];
                  const { newlyActivated } = applyScenarioActivation(
                    scenarioDecision ?? { scenes: [], sticky: false },
                    takeoverServices,
                  );
                  // fixed 画像（浏览器对话栏）的能力检索是空转：computeActiveToolDefs 对 fixed
                  // 只用 fixedScenes（见 lib/runtime/tools.ts），激活再多场景也不改工具面 —— 必须如实告知，
                  // 否则模型会等一个永远不会到来的工具（历史故障见 buildCapabilityResultText 注释）。
                  const resultText = buildCapabilityResultText(
                    query, matched, newlyActivated, profile.scenes !== 'fixed',
                  );
                  send({
                    tool_call: { name: toolName, arguments: parsedArgs, phase: 'done', spanId: toolSpanId, startAt: toolStartAt, purpose: callPurpose },
                    nodeId,
                  });
                  send({
                    tool_result: {
                      name: toolName,
                      result: resultText,
                      durationMs: 0,
                      success: true,
                      phase: 'done',
                      spanId: toolSpanId,
                      startAt: toolStartAt,
                      endAt: Date.now(),
                    },
                    nodeId,
                  });
                  kctx.allToolCalls.push({
                    toolName,
                    arguments: parsedArgs,
                    result: resultText,
                    durationMs: 0,
                    success: true,
                    phase: 'done',
                    pageUrl: kctx.lastPageUrl,
                  });
                  kctx.conversationMessages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: resultText,
                  });
                  eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: resultText, name: toolName });
                  // 该工具已由宿主处理，跳过下方通用执行逻辑
                  continue;
                }

                // 执行参数（intern_search 需注入 current_node_id，见下）
                let execArgs = tc.function.arguments;

                // ①.4 P4a-3-3 迁移 butler 卡片，行为不变：butler 结构化确认卡片已从 route if 分支
                //     收敛为注册式 host-pending 分发（tool-pipeline.ts）。判定（identity==='butler' &&
                //     BUTLER_CARD_TOOLS）+ 卡片构建（buildButlerCard）+ butler_confirm SSE 载荷 /
                //     20s 心跳 / denied·timeout 措辞 / 落账三连 / continue 语义均在注册 handler
                //     （handleButlerCard，见模块级注册）内逐位复刻。本咨询点特有职责：
                //       a) 把身份（identity）+ 挂起登记用原始参数串（execArgs）+ 结果落账
                //          commitToolError 注入 ctx；setExecArgs 写回通道绑定本轮 let parsedArgs /
                //          execArgs —— approved + edited.toolArgs 覆盖后回落通用执行即用新参数
                //          （等价迁移前「parsedArgs = editedArgs; execArgs = JSON.stringify」覆盖路径）；
                //       b) verdict 流控：'handled_continue'（denied/timeout）→ continue；
                //          'handled_fallback'（approved）→ butler 卡已接管确认 → 跳过下方 tool_confirm
                //          consult（等价迁移前 consult 后 usesButlerCard → noop 的照常执行，且避免
                //          重复弹窗）；'noop'（非 butler 身份/名单外/卡片构建失败）→ 照常进入
                //          tool_confirm consult。
                //     咨询点物理位置保持在 tool_confirm（①.5）之前 —— butler 先判的顺序约束不因迁移改变。
                // K3 hook: butler_confirm (consult seq #3 · before_execute_running)
                const butlerTakeover = hostTakeoverFor(toolName, 'butler_confirm', 'pre');
                // 编辑覆盖中间通道：approved + edited.toolArgs 时 handler 经 ctx.setExecArgs 写入，
                // handle() 返回后再同步应用到本轮 parsedArgs / execArgs（避免在异步闭包内改写捕获
                // 变量导致后续类型收窄失效）
                let butlerEditedExecArgs: string | null = null;
                let butlerCardCovered = false;
                if (butlerTakeover) {
                  // 本轮参数快照（denied/timeout 时与 parsedArgs 同引用；落账/ctx.args 均用快照，
                  // 与 tool_confirm 咨询点 confirmToolArgs 同构 —— 嵌套闭包内读取捕获 let 会退回
                  // 声明类型，快照 const 保持收窄）
                  const butlerCardArgs = parsedArgs;
                  const butlerVerdict = await butlerTakeover.handle({
                    name: toolName,
                    args: butlerCardArgs,
                    nodeId,
                    send,
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                    // 请求作用域注入：身份（butler 专属判定）+ 挂起登记用原始参数串 + 编辑覆盖写回通道
                    identity,
                    channel,
                    execArgs,
                    setExecArgs: (raw) => {
                      butlerEditedExecArgs = raw;
                    },
                    // 结果落账：approved 走 handled_fallback 落回下方通用执行（executeTool 成功落账在
                    // 通用路径完成，commitToolResult 仅为 ctx 接口必填、本 handler 不调用）；
                    // denied/timeout 的 error 三连由 commitToolError 复刻原分支（success:false /
                    // phase:'error' / 无 pageUrl 字段，arguments 用本轮快照）。
                    commitToolResult: (resultText) => {
                      kctx.allToolCalls.push({
                        toolName,
                        arguments: butlerCardArgs,
                        result: resultText,
                        durationMs: 0,
                        success: true,
                        phase: 'done',
                        pageUrl: kctx.lastPageUrl,
                      });
                      kctx.conversationMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
                      eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: resultText, name: toolName });
                    },
                    commitToolError: (resultText) => {
                      kctx.allToolCalls.push({
                        toolName,
                        arguments: butlerCardArgs,
                        result: resultText,
                        durationMs: 0,
                        success: false,
                        phase: 'error',
                      });
                      kctx.conversationMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
                      eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: resultText, name: toolName });
                    },
                  });
                  // denied/timeout 已由宿主处理（error 回灌 + 落账）→ 跳过下方通用执行逻辑
                  if (butlerVerdict === 'handled_continue') continue;
                  // approved（handled_fallback）：先用用户编辑后的参数覆盖本轮执行参数（等价迁移前
                  // 「parsedArgs = editedArgs; execArgs = JSON.stringify(parsedArgs)」路径），再标记卡已
                  // 接管确认 → 跳过 tool_confirm consult、回落通用执行
                  if (butlerVerdict === 'handled_fallback') {
                    if (butlerEditedExecArgs !== null) {
                      parsedArgs = JSON.parse(butlerEditedExecArgs) as Record<string, unknown>;
                      execArgs = butlerEditedExecArgs;
                    }
                    butlerCardCovered = true;
                  }
                }

                // ①.5 P4a-3-2 迁移：tool_confirm（需手动确认名单通用确认）已从 route if 分支收敛为
                //     注册式 host-pending 分发（tool-pipeline.ts，行为不变）。咨询点物理位置保持
                //     在 butler 结构化卡片段（①.4）之后 —— butler 先判的顺序约束不因迁移改变：
                //     butler 卡已覆盖的排程工具（identity==='butler' 且属 BUTLER_CARD_TOOLS）不重复
                //     弹通用确认、名单外工具不接管，均由注册 handler（handleToolConfirm，见模块级注册）
                //     依据 ctx 注入的 identity + confirmTools（settingsForTools.confirmTools ??
                //     DEFAULT_CONFIRM_TOOLS，运行期配置不可由模块级 handler 持有）判定后返回 'noop'；
                //     denied/timeout 的 SSE tool_result(error)·措辞区分·落账三连·循环 continue 亦在
                //     handler 内逐位复刻（'handled_continue'）；approved → 'handled_fallback' 回落下方
                //     通用执行（args 原样，通用确认不回灌编辑参数，与迁移前一致）。
                //     衔接（P4a-3-3）：butler consult（①.4）verdict === 'handled_fallback'（approved，
                //     args 可能已经 setExecArgs 覆盖）→ 卡已接管确认，直接跳过本 consult（等价迁移前
                //     consult 后 usesButlerCard → noop 的照常执行，无任何副作用差异）；仅 butler
                //     verdict === 'noop'（含卡片构建失败 → usesButlerCard 冗余判定在 handleToolConfirm
                //     内保留，保证仍不弹通用确认）或 butler 未命中时本 consult 才执行。
                // 本轮生效的审批策略（identity 级 perAgent 覆盖 > 全局 defaultStrategy > allow_scope）：
                // 同一次工具轮里被两处消费 —— tool_confirm 接管（下方 ctx.approvalStrategy，名单/写类
                // 判定）与多智能体门禁（executeTool ctx，team_run 的 allow/request/deny 形态），
                // 取值必须同源（默认 allow_scope 与现网逐位一致）。
                const effectiveApprovalStrategy =
                  (identity ? settingsForTools.approval?.perAgent?.[identity] : undefined)
                  ?? settingsForTools.approval?.defaultStrategy
                  ?? 'allow_scope';
                // K3 hook: tool_confirm (consult seq #4 · before_execute_running；butler 卡覆盖后跳过)
                const confirmTakeover = hostTakeoverFor(toolName, 'tool_confirm', 'pre');
                if (confirmTakeover && !butlerCardCovered) {
                  const confirmToolArgs = parsedArgs;
                  const confirmVerdict = await confirmTakeover.handle({
                    name: toolName,
                    args: confirmToolArgs,
                    nodeId,
                    send,
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                    // 请求作用域注入：身份（butler 卡覆盖判定）+ 当前生效手动确认名单 + 审批策略
                    // （P4b-1：复用上面同一取值的 effectiveApprovalStrategy，默认档与现网逐位一致）
                    // + 挂起登记用原始参数串
                    identity,
                    channel,
                    confirmTools: settingsForTools.confirmTools ?? DEFAULT_CONFIRM_TOOLS,
                    approvalStrategy: effectiveApprovalStrategy,
                    execArgs,
                    // 结果落账：approved 走 handled_fallback 落回下方通用执行（executeTool 成功落账在
                    // 通用路径完成，此处不产成功落账）；denied/timeout 的 error 三连由 commitToolError
                    // 复刻原分支（success:false / phase:'error' / 无 pageUrl 字段，arguments 用本轮快照）。
                    commitToolResult: (resultText) => {
                      kctx.allToolCalls.push({
                        toolName,
                        arguments: confirmToolArgs,
                        result: resultText,
                        durationMs: 0,
                        success: true,
                        phase: 'done',
                        pageUrl: kctx.lastPageUrl,
                      });
                      kctx.conversationMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
                      eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: resultText, name: toolName });
                    },
                    commitToolError: (resultText) => {
                      kctx.allToolCalls.push({
                        toolName,
                        arguments: confirmToolArgs,
                        result: resultText,
                        durationMs: 0,
                        success: false,
                        phase: 'error',
                      });
                      kctx.conversationMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
                      eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: resultText, name: toolName });
                    },
                  });
                  // denied/timeout 已由宿主处理（error 回灌 + 落账）→ 跳过下方通用执行逻辑
                  if (confirmVerdict === 'handled_continue') continue;
                  // approved（handled_fallback）→ 继续本轮通用执行；noop（名单外/butler 卡覆盖）→ 照常执行
                }

                // ② 执行前：phase=running（单独发一条"更新"事件，前端接收到替换 pending）
                send({
                  tool_call_update: {
                    name: toolName,
                    phase: 'running',
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                  },
                  nodeId,
                });

                // AI Coding 专项任务循环：按工具映射循环阶段（改码→预览自检→测试），
                // SSE 推送 coding_phase 供前端渲染循环状态条；非编码工具不改变当前阶段
                if (profile.id === 'coding') {
                  const loopPhase = codingPhaseForTool(toolName);
                  if (loopPhase) {
                    send({ coding_phase: { phase: loopPhase, tool: toolName }, nodeId });
                  }
                }

                // 执行工具前 args 注入：intern_search 需要 current_node_id 做祖先链校验；read_file/
                // write_file/rename_file/delete_file 需要 current_node_id 做 homework/ 文件归属隔离与
                // .ownership.json 清册维护；execute_script/run_command 需要 current_node_id 注入
                // BOB_NODE_HOMEWORK 产出目录；Coding 节点另需 node_sandbox_app_id 强制写操作落
                // bob-sandbox/apps/<appId>/（不落 homework）。P4a-2a 迁移：名单与注入规则收敛为
                // 注册式 args_transform 接管（tool-pipeline.ts，行为不变）——命中返回注入后的参数
                // 字符串、未命中/解析失败返回 null 原样执行。
                // K3 hook: args_transform (consult seq #5 · before_execute；节点参数注入 + browser.login mode 注入 + 技能闸门三注册条目共用本咨询点，match 互不重叠)
                const nodeParamTakeover = takeoverOfKind(toolName, 'args_transform');
                const injectedExecArgs = nodeParamTakeover?.transformArgs?.(toolName, execArgs, {
                  currentNodeId: nodeId,
                  sandboxAppId: toolLoopSandboxAppId,
                  outboxBatchId: toolLoopOutboxBatchId,
                  agentId: profile.id,
                });
                if (injectedExecArgs !== null && injectedExecArgs !== undefined) {
                  execArgs = injectedExecArgs;
                }
                // 工具输出上限按请求模型动态计算（1M→50000，小模型自动收缩），替代固定 maxOutput
                // 长耗时工具 keepalive：read_attachment 等工具内部做 OCR/视觉识别可达 60-120s，
                // 期间 SSE 无任何数据会被前端 90s 空闲超时误杀（后台仍在工作）。每 20s 发一条
                // tool_call_update(running) 心跳保持连接，工具完成即清除（前端对重复 running 幂等）。
                const keepalive = setInterval(() => {
                  send({ tool_call_update: { name: toolName, phase: 'running', spanId: toolSpanId, startAt: toolStartAt }, nodeId });
                }, 20000);
                // Bobby 触发事件：主 Agent 调用 Bobby 插件工具 → SSE 推送 bobby_trigger，
                // 画布据此自动打开（创建/激活）BobbyNode 并建立「发起节点 → BobbyNode」的连线。
                if (toolName.startsWith('mcp__bobby__')) {
                  send({ bobby_trigger: { tool: toolName }, nodeId });
                }
                let execResult: { result: string; durationMs: number; success: boolean; cardHtml?: string };
                // P0-d 工具返回预算：T_turn（单次上限，按请求窗口）× T_task（单任务累计上限，防多轮下钻爆窗）。
                // 累计量直接从本轮对话历史里的 tool 消息就地统计（不另设计数器，避免各处更新不同步）；
                // 剩余预算不足时按剩余量收紧本次上限，下限 2000 —— 截断仍由工具内部显式提示（不静默截断）。
                const turnCap = toolOutputMaxForContext(requestContextWindow);
                const taskBudget = taskToolOutputMaxForContext(requestContextWindow);
                const taskUsedChars = kctx.conversationMessages.reduce(
                  (s, m) => s + (m.role === 'tool' && typeof m.content === 'string' ? m.content.length : 0),
                  0,
                );
                const callCap = Math.max(2000, Math.min(turnCap, taskBudget - taskUsedChars));
                if (taskUsedChars >= taskBudget) {
                  console.warn(`[工具预算 T_task] 单任务工具返回累计已达上限（${Math.round(taskUsedChars / 1000)}k ≥ ${Math.round(taskBudget / 1000)}k），本次调用上限收紧至 ${callCap} 字符`);
                }
                try {
                  execResult = await executeTool(toolName, execArgs, callCap, {
                    // 内层分片上限跟外层同源：read_attachment 等读取类工具按此收缩单次返回，
                    // 保证续读 offset 提示不被外层截断（小窗口模型也能一段段读完长材料）
                    maxOutputChars: callCap,
                    // Butler 会话线程 id（2026-10-02）：记忆类工具据此把「来源」写成 chat:<threadId>
                    // （此前只能写死 'chat'，用户看到「via chat」但不知道是哪次对话）。非 Butler 链路为 undefined。
                    ...(butlerThreadId ? { threadId: butlerThreadId } : {}),
                    // 宿主自身绝对 base（Node fetch 不支持相对路径）：工具内自调用宿主 API 用
                    // （如管家会议工具 meeting_end → /api/core/meeting 整理纪要）
                    baseUrl: new URL(request.url).origin,
                    // OCR 过程级进度（read_attachment 扫描件/图片识别走 bob-ocr-mcp）：插件实时上报引擎/页码
                    // → 转为 vision_progress(phase='ocr') SSE 事件，前端显示"正在识别 第N/M页 · 本地 Vision"等
                    onOcrProgress: (p) =>
                      send({
                        vision_progress: {
                          phase: 'ocr',
                          current: (p.pageIndex ?? 0) + 1,
                          total: p.totalPages ?? 0,
                          engine: p.engine,
                          model: p.model,
                        },
                        nodeId,
                      }),
                    // 多智能体协作过程级进度（team_run 编排期间按轮询节奏外推）：转 subagent_update SSE，
                    // 前端据此渲染「成员分支卡片」（默认折叠，展开看每个成员的任务与产出）；同一帧可附带
                    // 「群聊流」增量事件（subagent_events，形态 A 呈现层）——前端按时间线累积，与快照互为补充。
                    // onProgress 每次回调的 events 只含**本次新增**（可能为空数组），快照则始终是全量。
                    onTeamProgress: (p, events) =>
                      send({ subagent_update: p, subagent_events: events, nodeId }),
                    // 多智能体人类审批门禁（team_run 在 approve 之前回调本函数）：复用工具确认的挂起容器
                    // （createPendingConfirm 生成 confirmId + Promise，前端弹审阅卡后经 POST
                    // /api/chat/confirm 回传 resolve），另发一条 team_confirm 帧携带草案（goal + 成员
                    // 清单 + 任务 DAG）供前端展示。等待期间 SSE 无数据，但本轮 keepalive 已在按 20s 发
                    // tool_call_update(running) 心跳，故此处不再另起心跳。
                    onTeamConfirm: async (draft) => {
                      // 第 4 参传本轮请求的 signal：客户端断开即按未批准收口，team_run 随即 team_discard
                      // 作废草案 —— 不这样做的话门禁会一直等到 CONFIRM_TIMEOUT_MS（10 分钟）才收口，
                      // 期间团队停在 planning（成员/任务未物化），工作台看着就是「只有队长第一步、后面全空」。
                      const { confirmId, promise } = createPendingConfirm(
                        'team_run',
                        JSON.stringify(draft),
                        nodeId,
                        request.signal,
                      );
                      // 被弃用的名单成员（AI 最终方案未指派）：id → 已安装 agent 的 label，未装/已卸载
                      // 回退显示 id（与名单段同口径）——用户名单被改动时前端据此在卡上点名
                      const droppedLabels = new Map(loadInstalledAgentProfiles().map((a) => [a.id, a.label]));
                      send({
                        team_confirm: {
                          confirmId,
                          // 团队 id：团队在 approve 之前才推 subagent_update 帧，若此处不携带，
                          // 前端在「待批准」阶段就无从把团队绑到节点——页面一刷新团队即失联（回空状态）
                          teamId: draft.teamId,
                          goal: draft.goal,
                          members: draft.members,
                          tasks: draft.tasks,
                          // 名单外补充成员（AI 推荐补人触发审批时非空）：前端弹卡单独点名，便于用户判断
                          extraMemberNames: draft.extraMemberNames,
                          droppedMemberNames: (draft.droppedMemberIds ?? []).map(
                            (id) => droppedLabels.get(id) ?? id,
                          ),
                          timeoutSec: Math.ceil(CONFIRM_TIMEOUT_MS / 1000),
                        },
                        nodeId,
                      });
                      const res = await promise;
                      return res.verdict;
                    },
                    // 审批策略档位（与上方 tool_confirm 接管同源，单一取值）：team_run 据此经
                    // decideTeamApproval 决定门禁形态 —— allow_scope 不打断用户直接 approve & run /
                    // ask 在 approve 前弹审阅卡 / never 在入口直接拒绝（不建团队、零 MCP 副作用）
                    approvalStrategy: effectiveApprovalStrategy,
                    // 本次成员名单（用户弹窗选定）：名单外补充成员一律强制弹卡请用户批准
                    presetAgentIds,
                    // team 模式一主一次两个模型（Team 分栏显式选择）：队长用主模型、成员一刀切用次模型；
                    // 只读模型池与节点 frontmatter，**绝不回写节点模型**（与主 chat 完全隔离）
                    teamMainModel: typeof teamMainModel === 'string' ? teamMainModel : undefined,
                    teamWorkerModel: typeof teamWorkerModel === 'string' ? teamWorkerModel : undefined,
                    // 队长规划时参考的成员名单段（主 agent 看不到名单，见 MULTI_AGENT_RULES）
                    teamRosterSection,
                    // 触发本次协作的用户原文（本轮请求体的 last user 消息，未经任何宿主注入加工——
                    // 与 TURN_START/USER_MESSAGE 事件同源）：随 team_plan 落进 team_start 事件，
                    // 工作台群聊流据此在右侧渲染「我的发言」气泡
                    teamQuestionText: initialUserInput || undefined,
                    // 当前项目上下文：透传给队长会话的 /api/chat
                    projectId,
                    // web_search / web_fetch 按次计费时把费用记到当前项目（无项目则记全局）
                    projectRoot: projectRoot || undefined,
                  });
                } finally {
                  clearInterval(keepalive);
                }

                // P4a-3-4 迁移 grant/login（bobby grant SSE 旁路 + browser.login 挂起型接管），行为不变：
                // 两段已从 route if 分支收敛为注册式 host-pending 分发（tool-pipeline.ts，kind 'grant' /
                // 'login'，phase post；handler 见模块级注册 handleBobbyGrant / handleBrowserLogin）。
                // 咨询点物理位置保持在 executeTool 之后、load_skill 场景激活（post）之前 —— 与迁移前
                // 分支所在窗口一致；execResult.success 是两分支原 if 的第一条件，咨询点据此门控，
                // 工具名/内容判定由注册 match + handler 内完成：
                //   · grant（mcp__bobby__*）：命中 grantRequired → handler 发 SSE grant_required 旁路并
                //     'handled_fallback'（原 send 后无 continue，回落通用路径原文落账）；未命中 'noop'。
                //   · login（browser.login）：loginRequired 挂起 → 20s 心跳 → 前端回传凭据（POST
                //     /api/chat/login）→ login_fill 代填（redactArgs 脱敏）→ handler 经 ctx.setExecResult
                //     把三分支新 execResult 写回 loginExecOverride，handle() 返回后宿主覆盖 execResult ——
                //     随后照常落入通用落账（send tool_result / tool_span / kctx.allToolCalls / 对话历史 /
                //     eventLog），与迁移前分支体直接改写 execResult 后继续向下逐位等价；loginRequired
                //     未命中 → 'noop'（execResult 原样）。
                // K3 hook: grant (consult seq #6 · after_execute)
                const grantTakeover = hostTakeoverFor(toolName, 'grant', 'post');
                if (execResult.success && grantTakeover) {
                  await grantTakeover.handle({
                    name: toolName,
                    args: parsedArgs,
                    result: execResult.result,
                    nodeId,
                    send,
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                    // grant 为 SSE 旁路、不自产落账（新 execResult 不覆盖、通用路径完成），接口占位
                    commitToolResult: () => { /* 占位：grant handler 不调用，落账走通用路径 */ },
                  });
                }
                // K3 hook: login (consult seq #7 · after_execute)
                const loginTakeover = hostTakeoverFor(toolName, 'login', 'post');
                if (execResult.success && loginTakeover) {
                  // 登录代填结果写回通道：handler 在 loginRequired 命中后经 setExecResult 写入，
                  // handle() 返回后再应用到 execResult（避免在异步闭包内改写捕获变量，与 ①.4
                  // setExecArgs 同构）；未命中（'noop'）时保持 null → execResult 原样走通用路径。
                  let loginExecOverride: { result: string; durationMs: number; success: boolean; cardHtml?: string } | null = null;
                  const loginVerdict = await loginTakeover.handle({
                    name: toolName,
                    args: parsedArgs,
                    result: execResult.result,
                    pageUrl: kctx.lastPageUrl ?? undefined,
                    nodeId,
                    send,
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                    setExecResult: (r) => { loginExecOverride = r; },
                    // login 不自产落账（新 execResult 回落通用路径完成），接口占位
                    commitToolResult: () => { /* 占位：login handler 不调用，落账走通用路径 */ },
                  });
                  // 挂起型 handler 本不产 continue（原分支体无 continue）；防御性保留流控
                  if (loginVerdict === 'handled_continue') continue;
                  if (loginExecOverride) execResult = loginExecOverride;
                }

                // load_skill 加载法律技能 → 联动激活 legal 场景并重建工具集：
                // 技能正文要求法条核对必须走北大法宝(pkulaw)，但 pkulaw 工具仅当 legal 场景激活才可见；
                // 而首轮用户消息未必命中 detectSceneHints 法律关键词（如"执行款清偿顺序"类提问），
                // 若不在此兜底激活，模型加载技能后依然看不到 pkulaw 工具，只能退化到 web_search/web_fetch。
                // P4a 三段化骨架：本段已收敛为注册式 post-execute 接管（tool-pipeline.ts，行为不变）——
                // 仅当工具执行成功（execResult.success）且工具在注册表中被 scenario_activate 命中才咨询；
                // 激活/sticky/kctx.needRebuildTools 由 applyScenarioActivation 统一执行。
                // K3 hook: load_skill→scenario_activate (consult seq #8 · after_execute)
                const legalSkillTakeover = takeoverFor(toolName, 'post');
                if (execResult.success && legalSkillTakeover && legalSkillTakeover.kind === 'scenario_activate') {
                  const scenarioDecision = legalSkillTakeover.handleScenario?.(toolName, parsedArgs) ?? null;
                  if (scenarioDecision) {
                    const { newlyActivated, hint } = applyScenarioActivation(scenarioDecision, takeoverServices);
                    // 激活提示仅首次激活（legal 之前未激活）时追加到工具结果尾部（与原 if 分支一致）
                    if (newlyActivated.includes('legal') && hint) {
                      execResult = {
                        ...execResult,
                        result: execResult.result + '\n\n' + hint,
                      };
                    }
                  }
                }

                const finalPhase: 'done' | 'error' = execResult.success ? 'done' : 'error';

                // 执行轨迹元数据：类型（内置工具/MCP）+ 系统变更标记（安装/写文件/改配置）+ 结果摘要
                const traceKind: 'tool' | 'mcp' = toolName.startsWith('mcp__') ? 'mcp' : 'tool';
                const change = classifySystemChange(toolName, parsedArgs);
                const traceSummary = (execResult.result || '')
                  .trim().replace(/\s+/g, ' ')
                  .slice(0, 200);

                // ③ 发送 tool_result 事件（带最终 phase + 轨迹元数据 + span 时间戳）
                const toolEndAt = Date.now();
                send({
                  tool_result: {
                    name: toolName,
                    result: execResult.result.slice(0, 2000),
                    durationMs: execResult.durationMs,
                    success: execResult.success,
                    phase: finalPhase,
                    // P0 轨迹：稳定 spanId + 真实时间戳（前端 P0 忽略，P1 据此稳定渲染 + 真实耗时）
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                    endAt: toolEndAt,
                    // 方案B：展示卡片随事件下发，前端独立渲染
                    cardHtml: execResult.cardHtml,
                    // 执行轨迹：类型 + 系统变更 + 结果摘要（供前端内联步骤流直接使用）
                    kind: traceKind,
                    systemChange: change.change,
                    changeSummary: change.summary,
                    summary: traceSummary,
                  },
                  nodeId,
                });
                // P0 轨迹：记录结构化 span 标记（start/end）
                eventLog.mark('tool_span', toolSpanId, { name: toolName, phase: finalPhase, durationMs: execResult.durationMs }, toolStartAt, toolEndAt);

                // 附件解析结果持久化到所属节点引用区（供下游 intern_search 溯源命中）
                // 项目资料（materials/）不走这里：它已登记进项目资料 manifest，由 intern_search 直接检索，
                // 再往节点引用区写一份摘要是同一内容的二次登记（仅对话附件/授权目录文件需要节点级溯源）。
                if (toolName === 'read_attachment' && execResult.success && projectRoot) {
                  const attPath = typeof parsedArgs.path === 'string' ? parsedArgs.path : '';
                  if (attPath && !attPath.startsWith('materials/')) {
                    try {
                      const { persistAttachmentReference } = await import('@/lib/nodes/references');
                      await persistAttachmentReference(attPath, execResult.result, projectRoot);
                    } catch { /* 引用区写入失败不影响主流程 */ }
                  }
                }

                // 浏览器工具执行成功 → 刷新页面 URL 指纹（供去重判断感知页面跳转）
                if (execResult.success && isPageStateTool(toolName)) {
                  const u = await fetchCurrentPageUrl();
                  if (u) kctx.lastPageUrl = u;
                }

                // 记录工具调用
                kctx.allToolCalls.push({
                  toolName,
                  arguments: parsedArgs,
                  result: execResult.result,
                  durationMs: execResult.durationMs,
                  success: execResult.success,
                  phase: finalPhase,
                  kind: traceKind,
                  systemChange: change.change,
                  changeSummary: change.summary,
                  summary: traceSummary,
                  pageUrl: kctx.lastPageUrl,
                });

                // 工具结果加入对话历史（成本控制：超长结果按工具类型压缩后再进模型上下文。
                // P4a-2a 迁移：压缩判定收敛为注册式 post result_compact 通用接管（tool-pipeline.ts，
                // 行为不变 —— 阈值 / 保头保尾 / LIST_LIKE 提示文案均由 compactToolResult 原样产出，
                // 全工具命中、仅超阈值结果才实际压缩）；SSE tool_compact 帧与压缩日志仍由宿主按
                // compacted 标志发送（pipeline 不产 SSE）。
                // K3 hook: result_compact (consult seq #9 · after_tool_result)
                const compactTakeover = takeoverOfKind(toolName, 'result_compact', 'post');
                const compactOut = compactTakeover?.compactResult?.(toolName, execResult.result) ?? null;
                const toolMsgContent = compactOut ? compactOut.text : execResult.result;
                const toolResultCompacted = compactOut ? compactOut.compacted : false;
                kctx.conversationMessages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: toolMsgContent,
                });
                eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: toolMsgContent, name: toolName });
                if (toolResultCompacted) {
                  console.warn(`[工具结果压缩] ${toolName} 结果超长，已保头保尾压缩（原文约 ${Math.ceil(execResult.result.length / 2.5).toLocaleString()} tokens）`);
                  send({ tool_compact: { name: toolName }, nodeId });
                }
              }

              // ===== 停滞保护检测（不是轮数限制，只防死循环烧钱）=====
              // 任务在推进（本轮有成功且非重复、结果非空的工具调用）→ 清零停滞计数，循环继续；
              // 连续 STALL_LIMIT 轮无任何实质进展 → 判定模型陷入死循环，强制收尾
              const roundHasProgress = kctx.allToolCalls
                .slice(roundStartToolCount)
                .some((t) => t.success && !t.result.startsWith('跳过重复调用') && t.result.trim().length > 0);
              if (roundHasProgress) {
                kctx.stallCount = 0;
              } else {
                kctx.stallCount++;
                if (kctx.stallCount >= STALL_LIMIT) {
                  // 连续多轮无进展 → 判定死循环：注入收尾说明，下一轮进入强制收尾轮（不带 tools）
                  kctx.conversationMessages.push({
                    role: 'user',
                    content: '连续多轮工具执行未取得实质进展（工具失败或未产生新结果），疑似陷入循环。请停止重试，基于现有结果给出最终回答，并在回答末尾用【未完成项】列出未能完成的部分。',
                  });
                  send({ stall_detected: true, rounds: kctx.stallCount, nodeId });
                  kctx.forceFinalRound = true;
                  continue;
                }
              }

              // ===== 工具收敛护栏：有进展但不收敛（穷举型 / 空想型）→ 停止空转，基于已有结果作答 =====
              // 停滞保护抓的是「连续多轮无实质进展」；抓不住另一种卡法：每轮都有成功的工具调用
              // （被判为推进、stallCount 反复清零），但方向永不收敛 —— 例如逐条穷举检索法条、
              // 反复重写同一个文件，最终只能烧到时间预算才被迫收口，UI 表现为「一直转但不动」。
              // 判据（双阈值，避免误伤正常的多文件读取）：同一工具连续主导 ≥ TOOL_CONVERGENCE_ROUNDS 轮，
              // 且该工具累计调用 ≥ TOOL_CONVERGENCE_MIN_CALLS 次 → 判定不收敛，注入停止指令并强制收尾。
              if (!kctx.toolConvergenceExceeded) {
                const roundCalls = kctx.allToolCalls.slice(roundStartToolCount);
                // 本轮主导工具：出现次数最多者
                const perTool = new Map<string, number>();
                for (const c of roundCalls) perTool.set(c.toolName, (perTool.get(c.toolName) ?? 0) + 1);
                const dominant = [...perTool.entries()].sort((a, b) => b[1] - a[1])[0];
                // 主导判定：该工具占本轮调用 ≥ 80%（单工具轮次天然满足），避免并行多工具被误判
                if (dominant && roundCalls.length > 0 && dominant[1] / roundCalls.length >= 0.8) {
                  if (dominant[0] === kctx.convergenceTool) {
                    kctx.convergenceRounds++;
                  } else {
                    kctx.convergenceTool = dominant[0];
                    kctx.convergenceRounds = 1;
                  }
                  const totalOfTool = kctx.allToolCalls.filter((t) => t.toolName === dominant[0]).length;
                  if (
                    kctx.convergenceRounds >= TOOL_CONVERGENCE_ROUNDS &&
                    totalOfTool >= TOOL_CONVERGENCE_MIN_CALLS
                  ) {
                    kctx.toolConvergenceExceeded = true;
                    kctx.conversationMessages.push({
                      role: 'user',
                      content: `你已连续 ${kctx.convergenceRounds} 轮反复调用工具「${dominant[0]}」（累计 ${totalOfTool} 次），调用次数只增、结论始终没有落地，疑似陷入不收敛的穷举循环。请立即停止继续调用该工具，基于已经取得的结果直接给出最终回答；确实缺失的部分不要再以同一方式反复重试，在回答末尾用【未完成项】列出未能完成的部分及原因。`,
                    });
                    send({
                      tool_convergence: true,
                      tool: dominant[0],
                      rounds: kctx.convergenceRounds,
                      calls: totalOfTool,
                      nodeId,
                    });
                    kctx.forceFinalRound = true;
                    continue;
                  }
                }
              }

              // ===== OCR 重试预算门控：同一文件反复识别不收敛 → 停止空转，报 NEED_REVIEW =====
              // 手写字段（姓名/身份证/日期）VLM 每次可能给出不同候选，推进但不收敛，停滞保护抓不住。
              // 这里对 ocr_document/crop_image 针对同一文件的累计调用计数，超预算即注入"停止重试"指令。
              if (!kctx.ocrBudgetExceeded) {
                const ocrCalls = kctx.allToolCalls.filter(
                  (t) =>
                    (t.toolName === 'ocr_document' || t.toolName === 'crop_image') &&
                    t.arguments &&
                    typeof t.arguments.path === 'string' &&
                    t.arguments.path.trim().length > 0,
                );
                const perFile = new Map<string, number>();
                for (const c of ocrCalls) {
                  const key = String(c.arguments.path).trim();
                  perFile.set(key, (perFile.get(key) ?? 0) + 1);
                }
                const worst = [...perFile.entries()].sort((a, b) => b[1] - a[1])[0];
                if (worst && worst[1] >= OCR_REOCR_BUDGET) {
                  kctx.ocrBudgetExceeded = true;
                  kctx.conversationMessages.push({
                    role: 'user',
                    content: `你已对文件「${worst[0]}」尝试识别 ${worst[1]} 次仍未得到稳定结果（手写识别多次给出不同候选，属正常波动）。请停止继续重试该文件，基于已有候选给出你最有把握的答案，并在答案末尾用【需人工复核】列出置信度低/版本不一致的字段（如姓名、身份证号、日期），交给人工核对原件。不要再次调用 ocr_document / crop_image 识别该文件。`,
                  });
                  send({ ocr_budget_exceeded: true, file: worst[0], retries: worst[1], nodeId });
                }
              }

              // 继续下一轮循环，让模型基于工具结果继续思考
            }

            // 如果达到最大轮次，发送工具摘要
            if (kctx.allToolCalls.length > 0) {
              send({
                tool_summary: {
                  total: kctx.allToolCalls.length,
                  names: [...new Set(kctx.allToolCalls.map((t) => t.toolName))],
                },
                nodeId,
              });
            }

            // 发送本次交互中产生的输出文件卡片（homework/、materials/）
            // answerOutputFileNames：同批产物路径留档，供下方空答案兜底正文列出（本块异常也不影响兜底）
            let answerOutputFileNames: string[] = [];
            try {
              const workspacePath = projectRoot
                ? join(projectRoot, 'homework', '.ai-workspace')
                : join(homedir(), 'BobWork', SANDBOX_DIRNAME);
              const _pr = projectRoot || join(homedir(), 'BobWork', SANDBOX_DIRNAME);
              // 仅管家直聊要把自己的 Outbox 批次产物做成卡片；派发会话仍只在 Outbox 面板呈现
              const outputFiles = extractOutputFiles(
                kctx.allToolCalls,
                _pr,
                workspacePath,
                isButlerChatOutbox ? toolLoopOutboxBatchId : undefined,
              );
              // 合并续写请求携带的初始产物（如模板填充面板生成的文件）：
              // 仅接受项目内 homework/、materials/ 相对路径（含历史 attachments/），拒绝路径穿越
              if (Array.isArray(initialOutputFiles)) {
                for (const f of initialOutputFiles) {
                  const raw = String((f as { path?: unknown })?.path || '').replace(/\\/g, '/');
                  if (!/^(homework|materials|attachments)\//.test(raw) || raw.includes('..')) continue;
                  if (outputFiles.some((o) => o.path === raw)) continue;
                  let size = Number((f as { size?: unknown })?.size) || 0;
                  try {
                    size = statSync(resolve(_pr, raw)).size;
                  } catch { /* 保持 0 */ }
                  outputFiles.push({
                    path: raw,
                    name: basename(raw),
                    size,
                    kind: classifyOutputKind(raw),
                    source: 'template_fill',
                  });
                }
              }
              // 兜底：比对 homework/ 目录快照，把本轮任何新写入的成果文件（含脚本产物）补进输出卡片
              // （按 .ownership.json 归属过滤，并行节点的产物不入本卡片）
              if (projectRoot && kctx.homeworkSnapshot) {
                for (const f of await diffHomeworkFiles(kctx.homeworkSnapshot, projectRoot, nodeId, toolLoopOutboxBatchId)) {
                  if (!outputFiles.some((o) => o.path === f.path)) outputFiles.push(f);
                }
              }
              answerOutputFileNames = outputFiles.map((f) => f.path);
              if (outputFiles.length > 0) {
                send({
                  output_files: outputFiles,
                  nodeId,
                });
              }
            } catch { /* ignore */ }

            // ===== 空答案兜底（2026-10-08 事故）=====
            // 整轮结束时最后一轮正文为空 → 节点/界面会只剩系统提示（⏳ Completion check、⚠️ 输出触顶），
            // 用户侧表现就是「没有结果就暂停了」。此处补一段可读正文：说明成因 + 下一步 + 本轮产物，
            // 保证任何收尾路径（强制收尾 / 收尾轮 / 纯问答 / 截断重试预算用尽）都不会落下空答案。
            if (!kctx.finalAnswerText.trim()) {
              const fallback = buildEmptyAnswerFallback({
                truncatedRounds: kctx.truncatedRounds,
                toolCallCount: kctx.allToolCalls.length,
                producedFiles: answerOutputFileNames,
              });
              console.warn(
                `[chat] 整轮无正文（截断 ${kctx.truncatedRounds} 轮 / 工具 ${kctx.allToolCalls.length} 次），已写入空答案兜底正文`,
              );
              send({ content: fallback, nodeId });
              send({ empty_answer_fallback: true, nodeId });
              kctx.finalAnswerText = fallback;
              eventLog.mark(CORE_EVENT.ASSISTANT_MESSAGE, `${taskId}:fallback`, {
                round: Math.max(0, kctx.totalRounds - 1),
                role: 'assistant',
                content: fallback,
                toolCalls: [],
              });
            }



            // ark/部分 DeepSeek 网关不返回 prompt_cache_miss_tokens：miss 按 prompt - hit 派生，保证命中率口径正确
            if (kctx.taskUsage.cacheMissTokens === 0 && kctx.taskUsage.promptTokens > kctx.taskUsage.cacheHitTokens) {
              kctx.taskUsage.cacheMissTokens = kctx.taskUsage.promptTokens - kctx.taskUsage.cacheHitTokens;
            }
            const hitTotal = kctx.taskUsage.cacheHitTokens + kctx.taskUsage.cacheMissTokens;
            const hitRatio = hitTotal > 0 ? (kctx.taskUsage.cacheHitTokens / hitTotal) * 100 : 0;
            // 完成轮次统计（dsh）：TTFT（首 token 延迟）/ 总耗时 / 输出吞吐
            const taskDurationMs = Date.now() - kctx.taskStartMs;
            const ttftMs = kctx.firstTokenMs !== null ? kctx.firstTokenMs - kctx.taskStartMs : null;
            const tokensPerSec = taskDurationMs > 0
              ? Math.round((kctx.taskUsage.completionTokens / taskDurationMs) * 1000)
              : 0;
            console.log(
              `[chat] done | model: ${providerModelId} | prompt: ${kctx.taskUsage.promptTokens} | out: ${kctx.taskUsage.completionTokens} | cacheHit: ${kctx.taskUsage.cacheHitTokens} | cacheMiss: ${kctx.taskUsage.cacheMissTokens} | hitRate: ${hitRatio.toFixed(1)}% | calls: ${kctx.taskUsage.calls}` +
              ` | rounds: ${kctx.totalRounds} (thinkingDowngraded: ${kctx.thinkingDowngradedRounds})` +
              ` | duration: ${taskDurationMs}ms | ttft: ${ttftMs ?? 'n/a'}ms | tok/s: ${tokensPerSec}`,
            );

            // 最终上下文占用（含工具结果回灌）：done 事件内附带，前端更新 composer 圆环
            const finalCtx = estimateContextBreakdown(kctx.conversationMessages, loopToolDefs);

            // AI Coding 专项任务循环：整轮结束（含工具循环）→ 推送 done，前端循环状态条回到"完成"
            if (profile.id === 'coding') {
              send({ coding_phase: { phase: 'done' }, nodeId });
            }

            send({
              done: true,
              nodeId,
              taskId,
              // P3-3b2：本轮实际使用模型（provider:modelId），供外部客户端与后续消息落盘
              model: modelTag,
              matchedSkills: matchedSkillNames,
              skillDetails,
              usage: kctx.taskUsage,
              stats: { ttftMs, durationMs: taskDurationMs, tokensPerSec },
              // 思考决策可见性（方向 D）：每轮实际档位/降级/C1 命中，前端完成统计条渲染
              thinking: {
                level,
                downgradedRounds: kctx.thinkingDowngradedRounds,
                trivialOff: kctx.thinkingModes.some((m) => m.trivialOff),
                modes: kctx.thinkingModes,
              },
              // 缓存命中率遥测（P1）：显式下发 hitRate，随事件日志落盘供离线复盘
              cache: {
                hitRate: hitTotal > 0 ? Math.round(hitRatio * 10) / 10 : 0,
                cacheHitTokens: kctx.taskUsage.cacheHitTokens,
                cacheMissTokens: kctx.taskUsage.cacheMissTokens,
              },
              contextMeter: {
                system: finalCtx.systemTokens,
                tools: finalCtx.toolsTokens,
                conversation: finalCtx.conversationTokens,
                capacity: inferContextWindow(
                  providerModelId || '',
                  // S2a：effort≠none 视为思考模式请求（none = off/C1 关思考）
                  baseEffort !== 'none',
                ),
              },
              prefixHash,
              prefixSegments,
            });
            // 用量统计：本轮真实 token 流水落库（task_id 幂等；失败仅告警，不阻塞收尾）
            if (projectRoot) {
              try {
                const { recordTaskUsage } = await import('@/lib/usage');
                await recordTaskUsage({
                  projectRoot,
                  taskId,
                  nodeId,
                  agent: profile.id,
                  model: providerModelId || modelId || 'unknown',
                  usage: kctx.taskUsage,
                  rounds: kctx.totalRounds,
                  durationMs: taskDurationMs,
                  ttftMs,
                });
              } catch (usageErr) {
                console.warn('[usage] 用量落库失败（不影响本轮结果）:', usageErr);
              }
            }
            eventLog.mark(CORE_EVENT.TURN_END, taskId, { rounds: kctx.totalRounds });
            // P0 轨迹：任务正常结束时持久化事件日志（为 P2 历史恢复铺路）
            if (projectRoot) {
              persistEventLog(`${projectRoot}/.trajectory/${nodeId}/${taskId}.jsonl`, eventLog.finalize());
            }
            // 浏览器收尾自动释放（2026-09-08）：本回合调过 bob-browser-mcp 工具时，
            // 回合结束自动 browser.disconnect 解除 Bob WebBridge 对标签的附着（页面保留在 Chrome、不物理关闭）。
            // 目的：避免 attached 标签 + 30s 心跳残留到下一个任务，旧标签若处于 loading/僵尸状态会让
            // 下个浏览器任务的导航复用时卡满 CDP 30s 超时（历史教训：2026-09-08 XHS 任务两次 30s 导航超时，
            // 根因即上个已关闭会话残留的 attached 标签）。fire-and-forget：失败仅告警，不阻塞收尾。
            // 下一回合若需继续浏览，模型 navigate 会自动重新 attach（秒级）。
            if (kctx.allToolCalls.some((t) => t.toolName?.startsWith('mcp__bob-browser-mcp__'))) {
              mcpManager
                .callTool('mcp__bob-browser-mcp__browser_disconnect', {})
                .catch((e: unknown) => console.warn('[chat] browser auto-disconnect on turn end failed:', e));
            }
            closeStream();
          } catch (error) {
            let errorMessage =
              error instanceof Error ? error.message : 'Unknown error';
            const rawMessage = errorMessage;
            // 客户端已断开：连接已关闭，推错误帧无意义（前端已渲染超时/已取消），
            // 仅停止心跳与持久化轨迹，保留被打断的现场。上游在飞请求已由 request.signal 中止。
            if (request.signal.aborted) {
              console.warn(`[chat] 客户端已断开，本轮中止: ${rawMessage}`);
            } else {
              if (errorMessage.includes('model') && (errorMessage.includes('not found') || errorMessage.includes('does not exist'))) {
                errorMessage = `模型 "${providerModelId}" 不可用，请检查该模型是否已在当前 API Key 下开通。可在设置中重新获取模型列表并选择可用模型。`;
              }
              if (errorMessage.includes('401') || errorMessage.includes('Authentication')) {
                errorMessage = 'API Key 认证失败，请检查设置中的 API Key 是否正确。';
              }
              if (errorMessage.includes('402') || errorMessage.includes('insufficient')) {
                errorMessage = 'API 账户余额不足，请充值后重试。';
              }
              if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
                errorMessage = '请求过于频繁，请稍后再试。';
              }
              // 上游 400 可读化（2026-09-15）：此前只有 401/402/429 有映射，400 会把上游英文原文
              // 原样推给前端（实测：`400 The 'reasoning_content' in the thinking mode must be passed back
              // to the API.` 直接渲染成 [400 The 'reasoning_content' ...]，用户无法自查）。
              const status = typeof error === 'object' && error !== null
                ? (error as { status?: number }).status
                : undefined;
              if (status === 400 || /\b400\b/.test(errorMessage)) {
                if (/reasoning_content/i.test(errorMessage)) {
                  // thinking 模式下，工具循环重发历史 assistant 消息必须原样回传 reasoning_content
                  errorMessage = '模型拒绝了本次请求：思考模式下的历史消息缺少 reasoning 字段（思考协议不同步）。请重试；若持续出现，可在设置中把该模型切换为非思考模式。';
                } else if (/max_tokens|maximum context length|context length|too long/i.test(errorMessage)) {
                  errorMessage = '本轮内容超出模型的上下文/输出上限，请精简当前对话或清理历史后重试。';
                } else if (/model/i.test(errorMessage)) {
                  errorMessage = `模型 "${providerModelId}" 拒绝了本次请求，请检查模型名与账号权限。`;
                } else {
                  errorMessage = `模型返回请求错误（400）：${errorMessage}`;
                }
              } else if (errorMessage === rawMessage && !/[\u4e00-\u9fa5]/.test(rawMessage)) {
                // 通用兜底：未命中任何映射的英文原文加前缀，至少让用户知道是上游返回的错误
                errorMessage = `AI 服务返回错误：${rawMessage}`;
              }
              send({ error: errorMessage, nodeId, taskId });
            }
            // P0 轨迹：异常结束时也持久化已有事件日志
            if (projectRoot) {
              persistEventLog(`${projectRoot}/.trajectory/${nodeId}/${taskId}.jsonl`, eventLog.finalize());
            }
            closeStream();
          } finally {
            // 看门狗心跳随整轮生命周期结束（正常/异常都要停，避免定时器泄漏持续 enqueue）
            clearInterval(watchdogId);
            // 释放「用户对话」占用：后台任务（成果块提炼 / 账本编译）恢复调度
            leaveUserTurn();
          }
        },
      });

      return new Response(readableStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    } else {
      // 托管模型（coze）通道已移除（2026-08）：所有模型必须配置 API Key（自定义 provider）
      return new Response(
        JSON.stringify({ error: '未配置模型：请先在设置中配置 API Key 并选择模型，再发送消息。' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
