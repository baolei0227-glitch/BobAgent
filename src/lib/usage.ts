/**
 * usage.ts —— 模型用量统计（全局账本：流水记录 + 成本估算 + 聚合查询）
 *
 * 数据流：
 *   chat 任务 done（src/app/api/chat/route.ts 内 taskUsage 已累计真实 token）
 *     → recordTaskUsage() 落一条 usage_log（app root 级全局 .usage.db，task_id 幂等）
 *     → /api/usage 聚合查询（byModel / byDay / totals / recent），面板 UI 消费
 *
 * 账本口径（2026-09-04 起）：
 *   - 全局一张 usage_log，与项目解耦；项目维度由 project_id 列区分，缺省 NULL（无项目归属）
 *   - source 列区分来源：chat（宿主对话，默认）｜host-other（宿主直连）｜ocr / notes（插件上报，待接入）
 *   - 迁移：各项目 .project.db 中历史 usage_log（2026-09-04 之前）一次性导入全局账本，幂等去重
 *
 * 成本口径：
 *   - 单价来源按优先级：用户覆盖（.settings.json 的 priceOverrides，管家对话维护）> PROVIDER_PRESETS 静态价格表
 *   - 两处都缺失（自定义模型无 spec）→ est_cost 存 NULL，聚合端显示"未定价"，绝不瞎算
 *   - 前缀缓存命中按 input 价 × CACHE_READ_RATIO 折扣估算（各家折扣不同，常量可校准）
 */

import { join } from 'path';
import { resolveAppRoot, USAGE_DB_FILENAME, resolveProjectDbPath } from '@/lib/app-root';
import { readConfig } from '@/lib/project/project-manager';
import { PROVIDER_PRESETS } from '@/lib/providers/presets';
import type { ModelPriceOverride } from '@/lib/settings';

/** 用量来源标识：宿主对话 | 宿主非 chat 直连 | 插件（OCR / notes） */
export type UsageSource = 'chat' | 'host-other' | 'ocr' | 'notes';

/** 缓存命中 token 的成本折扣系数（相对 input 单价）。
 *  OpenAI 系 cache read ≈ 0.25×，ark/GLM 等网关约 0.1×。按主流取 0.25，可校准。 */
export const CACHE_READ_RATIO = 0.25;

/** 一次任务累计的真实 token 用量（对应 chat route 的 taskUsage 结构） */
export interface UsageTokens {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  calls: number;
}

/** 落库入参 */
export interface RecordUsageInput {
  /** 项目根目录绝对路径（route 的 projectRoot；无项目归属时可省略） */
  projectRoot?: string;
  /** 显式项目 id（.projects.json 的 id）；缺省时按 projectRoot 反查 */
  projectId?: string | null;
  /** 用量来源（默认 chat） */
  source?: UsageSource;
  /** chat taskId，幂等键：同任务重试不重复记账 */
  taskId?: string;
  /** 画布节点 id（无项目/临时问答时为 undefined） */
  nodeId?: string;
  /** 完整模型引用，形如 "deepseek:deepseek-flash" */
  model: string;
  /** agent 画像 id：chat | coding */
  agent?: string;
  usage: UsageTokens;
  /** 工具循环轮数 */
  rounds?: number;
  durationMs?: number;
  ttftMs?: number | null;
}

/** 单行流水（查询返回） */
export interface UsageLogRow {
  id: string;
  project_id: string | null;
  source: UsageSource;
  /** 结算币种：usd | cny（决定 est_cost 的展示符号） */
  currency: 'usd' | 'cny';
  task_id: string | null;
  node_id: string | null;
  agent: string | null;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  total_tokens: number;
  calls: number;
  rounds: number | null;
  duration_ms: number | null;
  ttft_ms: number | null;
  est_cost: number | null;
  created_at: string;
}

export interface UsageBucket {
  key: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalTokens: number;
  calls: number;
  tasks: number;
  estCost: number | null;
}

export interface UsageSummary {
  totals: UsageBucket;
  byModel: UsageBucket[];
  byDay: UsageBucket[];
  /** 按自然月（YYYY-MM）聚合，供 All 视图的 By month 趋势 */
  byMonth: UsageBucket[];
}

export interface UsageWindow {
  from?: string;
  to?: string;
  projectId?: string | null;
}

const USAGE_DB_PATH = join(resolveAppRoot(), USAGE_DB_FILENAME);

type DB = import('better-sqlite3').Database;

let _db: DB | null = null;
let legacyImported = false;

function ensureSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      source TEXT NOT NULL DEFAULT 'chat',
      currency TEXT NOT NULL DEFAULT 'usd',
      task_id TEXT,
      node_id TEXT,
      agent TEXT,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
      cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      rounds INTEGER,
      duration_ms INTEGER,
      ttft_ms INTEGER,
      est_cost REAL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_log_task
      ON usage_log(task_id) WHERE task_id IS NOT NULL AND task_id != '';
    CREATE INDEX IF NOT EXISTS idx_usage_log_created ON usage_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_log_model ON usage_log(model);
    CREATE INDEX IF NOT EXISTS idx_usage_log_project ON usage_log(project_id);
  `);
  // 存量库列迁移：早期建表无 currency 列 → 补上（默认 usd，幂等）
  const cols = (db.prepare(`PRAGMA table_info(usage_log)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes('currency')) {
    db.exec(`ALTER TABLE usage_log ADD COLUMN currency TEXT NOT NULL DEFAULT 'usd'`);
  }
}

/** 打开（或创建）全局用量账本（惰性单例，WAL） */
async function openGlobalUsageDb(): Promise<DB> {
  if (!_db) {
    const Database = (await import('better-sqlite3')).default;
    _db = new Database(USAGE_DB_PATH);
    _db.pragma('journal_mode = WAL');
    ensureSchema(_db);
  }
  // 一次性迁移历史项目级 usage_log（进程内只跑一次，幂等去重）
  if (!legacyImported) {
    legacyImported = true;
    await migrateLegacyProjectUsage(_db);
  }
  return _db;
}

/** 历史迁移：各项目 .project.db 的 usage_log → 全局账本（source='chat'，task_id 幂等去重） */
async function migrateLegacyProjectUsage(db: DB): Promise<void> {
  try {
    const { projects } = await readConfig();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO usage_log (
        project_id, source, id, task_id, node_id, agent, model,
        prompt_tokens, completion_tokens, cache_hit_tokens, cache_miss_tokens, total_tokens,
        calls, rounds, duration_ms, ttft_ms, est_cost, created_at
      ) VALUES (
        @projectId, 'chat', @id, @taskId, @nodeId, @agent, @model,
        @promptTokens, @completionTokens, @cacheHitTokens, @cacheMissTokens, @total,
        @calls, @rounds, @durationMs, @ttftMs, @cost, @createdAt
      )
    `);
    const Database = (await import('better-sqlite3')).default;
    for (const p of projects) {
      try {
        const dbFile = resolveProjectDbPath(p.path);
        const src = new Database(dbFile, { readonly: true });
        try {
          const has = src
            .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='usage_log'`)
            .get();
          if (!has) continue;
          const rows = src
            .prepare(
              `SELECT id, task_id, node_id, agent, model, prompt_tokens, completion_tokens,
                      cache_hit_tokens, cache_miss_tokens, total_tokens, calls, rounds,
                      duration_ms, ttft_ms, est_cost, created_at
               FROM usage_log`,
            )
            .all() as Array<Record<string, unknown>>;
          for (const r of rows) {
            insert.run({
              projectId: p.id,
              id: r.id,
              taskId: r.task_id ?? null,
              nodeId: r.node_id ?? null,
              agent: r.agent ?? null,
              model: r.model,
              promptTokens: r.prompt_tokens ?? 0,
              completionTokens: r.completion_tokens ?? 0,
              cacheHitTokens: r.cache_hit_tokens ?? 0,
              cacheMissTokens: r.cache_miss_tokens ?? 0,
              total: r.total_tokens ?? 0,
              calls: r.calls ?? 0,
              rounds: r.rounds ?? null,
              durationMs: r.duration_ms ?? null,
              ttftMs: r.ttft_ms ?? null,
              cost: r.est_cost ?? null,
              createdAt: r.created_at,
            });
          }
        } finally {
          src.close();
        }
      } catch (e) {
        console.warn(`[usage] 迁移项目「${p.name}」旧用量失败:`, e);
      }
    }
  } catch (e) {
    console.warn('[usage] 历史用量迁移跳过:', e);
  }
}

/** 按项目根路径反查 .projects.json 的 project id（查不到返回 null） */
async function resolveProjectIdByPath(projectRoot: string): Promise<string | null> {
  try {
    const { projects } = await readConfig();
    return projects.find((p) => p.path === projectRoot)?.id ?? null;
  } catch {
    return null;
  }
}

/** 清零全部用量记录（全局账本 + 各项目本地 usage_log，防重启迁移再导回）。 */
export async function resetUsageLedger(): Promise<void> {
  const db = await openGlobalUsageDb();
  db.prepare(`DELETE FROM usage_log`).run();
  try {
    const { projects } = await readConfig();
    const Database = (await import('better-sqlite3')).default;
    for (const p of projects) {
      try {
        const dbFile = resolveProjectDbPath(p.path);
        if (!dbFile) continue;
        const src = new Database(dbFile);
        try {
          const has = src
            .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='usage_log'`)
            .get();
          if (has) src.prepare(`DELETE FROM usage_log`).run();
        } finally {
          src.close();
        }
      } catch (e) {
        console.warn(`[usage] 清理项目「${p.name}」用量失败:`, e);
      }
    }
  } catch (e) {
    console.warn('[usage] 清理项目级用量跳过:', e);
  }
}

/**
 * 打开全局用量账本（无需项目参数）。
 * 兼容旧签名：忽略传入的项目根路径，统一读写全局 .usage.db。
 */
export async function openUsageDb(): Promise<DB> {
  return openGlobalUsageDb();
}

export interface ModelPrice {
  /** 缓存未命中·输入单价（厂商分时定价时为高峰价） */
  input: number;
  /** 输出单价（厂商分时定价时为高峰价） */
  output: number;
  /** 缓存命中单价（缺省 = input × CACHE_READ_RATIO） */
  cacheHit?: number;
  /** 空闲时段倍率（如 DeepSeek 0.5 = 高峰半价）；无分时定价则不设 */
  offPeak?: number;
  /** 结算币种：usd（默认）| cny */
  currency: 'usd' | 'cny';
}

/** 单价来源：override = 用户改过（管家对话 / settings.json）；preset = 内置价格表 */
export type ModelPriceSource = 'override' | 'preset';

export interface ResolvedModelPrice {
  price: ModelPrice;
  source: ModelPriceSource;
}

// ---- 用户覆盖价缓存：读 settings.json 有成本，按 TTL 惰性加载 ----
let _priceOverrides: Record<string, ModelPriceOverride> = {};
let _priceOverridesAt = 0;
const PRICE_OVERRIDES_TTL_MS = 30_000;

/** 覆盖价写盘后调用：下一次计费立即生效，无需等 TTL 过期 */
export function invalidatePriceOverrides(): void {
  _priceOverridesAt = 0;
}

/** 确保覆盖表已加载（计费前 / 管家读取单价前调用） */
export async function ensurePriceOverridesLoaded(): Promise<void> {
  if (Date.now() - _priceOverridesAt < PRICE_OVERRIDES_TTL_MS) return;
  _priceOverridesAt = Date.now();
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const s = await readSettingsFromFile();
    _priceOverrides = { ...(s.priceOverrides ?? {}) };
  } catch {
    _priceOverrides = {};
  }
}

/** 覆盖表按 "provider:modelId" 与裸 modelId 双口径匹配（忽略空/非法条目） */
function findOverride(bare: string): ModelPriceOverride | undefined {
  for (const [k, v] of Object.entries(_priceOverrides)) {
    if (!v || typeof v.input !== 'number' || typeof v.output !== 'number') continue;
    const keyBare = k.includes(':') ? k.slice(k.lastIndexOf(':') + 1) : k;
    if (keyBare === bare) return v;
  }
  return undefined;
}

/** 解析模型单价（/ 百万 token）并标注来源：用户覆盖 > 内置价格表。
 *  modelRef 形如 "provider:modelId" 或裸 modelId，均按 modelId 段匹配。 */
export function resolveModelPriceInfo(modelRef: string): ResolvedModelPrice | null {
  if (!modelRef) return null;
  const bare = modelRef.includes(':') ? modelRef.slice(modelRef.lastIndexOf(':') + 1) : modelRef;

  const override = findOverride(bare);
  if (override) {
    return {
      source: 'override',
      price: {
        input: override.input,
        output: override.output,
        cacheHit: override.cacheHit,
        offPeak: override.offPeak,
        currency: override.currency ?? 'usd',
      },
    };
  }

  for (const preset of PROVIDER_PRESETS) {
    for (const m of preset.models) {
      if (m.modelId === modelRef || m.modelId === bare) {
        const p = m.spec?.pricePerMillionTokens;
        if (!p) return null;
        return { source: 'preset', price: { currency: 'usd', ...p } };
      }
    }
  }
  return null;
}

/** 从价格表（覆盖优先）解析模型单价；无价返回 null */
export function resolveModelPrice(modelRef: string): ModelPrice | null {
  return resolveModelPriceInfo(modelRef)?.price ?? null;
}

/** 是否处于"高峰时段"（北京时间 周一~周五 09:00–12:00、14:00–18:00；其余为空闲时段）。
 *  DeepSeek 官方分时定价据此判定是否套用空闲折扣。 */
export function isPeakHourBeijing(ts: Date): boolean {
  const bj = new Date(ts.getTime() + 8 * 3_600_000);
  const dow = bj.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
}

/** 成本估算（按模型结算币种计）。价格缺失 → null（不估算）。
 *   缓存命中优先用官方 cacheHit 单价；分时定价（offPeak）按任务时刻套用空闲折扣。 */
export function estimateCost(model: string, usage: UsageTokens, at?: Date): number | null {
  const price = resolveModelPrice(model);
  if (!price) return null;
  const atTime = at ?? new Date();
  const discount = price.offPeak != null && !isPeakHourBeijing(atTime) ? price.offPeak : 1;
  const cacheHitPrice = price.cacheHit ?? price.input * CACHE_READ_RATIO;
  const raw =
    ((usage.cacheMissTokens * price.input + usage.cacheHitTokens * cacheHitPrice) / 1_000_000 +
      (usage.completionTokens * price.output) / 1_000_000) *
    discount;
  return Math.round(raw * 1e6) / 1e6;
}

/** 落一条任务用量流水（幂等：task_id 已存在则跳过）。
 *   projectId 缺省时按 projectRoot 反查；无项目归属时 project_id 存 NULL。
 *   失败由调用方 try/catch 吸收，绝不阻塞主流程。 */
export async function recordTaskUsage(input: RecordUsageInput): Promise<void> {
  const { projectRoot, projectId, source, taskId, nodeId, model, agent, usage, rounds, durationMs, ttftMs } = input;
  if (!model || (!usage.promptTokens && !usage.completionTokens)) return;

  const db = await openGlobalUsageDb();
  const pid =
    projectId != null ? projectId : projectRoot ? await resolveProjectIdByPath(projectRoot) : null;
  const id = crypto.randomUUID().slice(0, 24);
  const now = new Date().toISOString();
  const total = usage.promptTokens + usage.completionTokens;
  // 覆盖价惰性加载（管家改价后立即生效）；estimateCost 为同步查表，须先确保覆盖表就绪
  await ensurePriceOverridesLoaded();
  // 按任务完成时刻判定分时价（DeepSeek 高峰/空闲）；币种随模型价格表
  const cost = estimateCost(model, usage, new Date(now));
  const currency = resolveModelPrice(model)?.currency ?? 'usd';

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO usage_log (
      id, project_id, source, currency, task_id, node_id, agent, model,
      prompt_tokens, completion_tokens, cache_hit_tokens, cache_miss_tokens, total_tokens,
      calls, rounds, duration_ms, ttft_ms, est_cost, created_at
    ) VALUES (
      @id, @projectId, @source, @currency, @taskId, @nodeId, @agent, @model,
      @promptTokens, @completionTokens, @cacheHitTokens, @cacheMissTokens, @total,
      @calls, @rounds, @durationMs, @ttftMs, @cost, @now
    )
  `);
  stmt.run({
    id,
    projectId: pid,
    source: source || 'chat',
    currency,
    taskId: taskId || null,
    nodeId: nodeId || null,
    agent: agent || null,
    model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheHitTokens: usage.cacheHitTokens,
    cacheMissTokens: usage.cacheMissTokens,
    total,
    calls: usage.calls || 1,
    rounds: rounds ?? null,
    durationMs: durationMs ?? null,
    ttftMs: ttftMs ?? null,
    cost,
    now,
  });
}

// ==================== 聚合查询 ====================

const BUCKET_SELECT = `
  COUNT(*) AS tasks,
  COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
  COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit_tokens,
  COALESCE(SUM(cache_miss_tokens), 0) AS cache_miss_tokens,
  COALESCE(SUM(total_tokens), 0) AS total_tokens,
  COALESCE(SUM(calls), 0) AS calls,
  SUM(est_cost) AS est_cost
`;

/** 聚合查询行：SQL 别名字段（来自 BUCKET_SELECT；未经校验，字段可能缺失） */
interface UsageBucketRow {
  key: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_hit_tokens?: number;
  cache_miss_tokens?: number;
  total_tokens?: number;
  calls?: number;
  tasks?: number;
  est_cost?: number | null;
}

function rowToBucket(row: UsageBucketRow, key: string): UsageBucket {
  return {
    key,
    promptTokens: row.prompt_tokens ?? 0,
    completionTokens: row.completion_tokens ?? 0,
    cacheHitTokens: row.cache_hit_tokens ?? 0,
    cacheMissTokens: row.cache_miss_tokens ?? 0,
    totalTokens: row.total_tokens ?? 0,
    calls: row.calls ?? 0,
    tasks: row.tasks ?? 0,
    estCost: row.est_cost == null ? null : Math.round(row.est_cost * 1e6) / 1e6,
  };
}

function buildWindowClause(opts: UsageWindow): { clause: string; params: Record<string, string> } {
  const where: string[] = [];
  const params: Record<string, string> = {};
  if (opts.from) {
    where.push('created_at >= @from');
    params.from = opts.from;
  }
  if (opts.to) {
    where.push('created_at <= @to');
    params.to = opts.to;
  }
  if (opts.projectId != null) {
    where.push('project_id = @projectId');
    params.projectId = opts.projectId;
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** 用量聚合。from/to：ISO 起止时间；projectId 传 null = 不按项目过滤（全局）。 */
export function queryUsageSummary(db: DB, opts: UsageWindow = {}): UsageSummary {
  const { clause, params } = buildWindowClause(opts);

  const totalsRow = db.prepare(`SELECT ${BUCKET_SELECT} FROM usage_log ${clause}`).get(params);
  const totals = rowToBucket(totalsRow as UsageBucketRow, 'total');

  const byModel = db
    .prepare(`
      SELECT model AS key, ${BUCKET_SELECT}
      FROM usage_log ${clause}
      GROUP BY model
      ORDER BY total_tokens DESC
    `)
    .all(params)
    .map((r) => rowToBucket(r as UsageBucketRow, (r as UsageBucketRow).key));

  const byDay = db
    .prepare(`
      SELECT substr(created_at, 1, 10) AS key, ${BUCKET_SELECT}
      FROM usage_log ${clause}
      GROUP BY substr(created_at, 1, 10)
      ORDER BY key ASC
    `)
    .all(params)
    .map((r) => rowToBucket(r as UsageBucketRow, (r as UsageBucketRow).key));

  const byMonth = db
    .prepare(`
      SELECT substr(created_at, 1, 7) AS key, ${BUCKET_SELECT}
      FROM usage_log ${clause}
      GROUP BY substr(created_at, 1, 7)
      ORDER BY key ASC
    `)
    .all(params)
    .map((r) => rowToBucket(r as UsageBucketRow, (r as UsageBucketRow).key));

  return { totals, byModel, byDay, byMonth };
}

/** 最近 N 条流水明细（面板"最近任务"列表）；opts 限定与汇总同窗口，避免与所选时段矛盾 */
export function listRecentUsage(db: DB, opts: UsageWindow = {}, limit = 8): UsageLogRow[] {
  const { clause, params } = buildWindowClause(opts);
  const all = db
    .prepare(`
      SELECT * FROM usage_log ${clause}
      ORDER BY created_at DESC
      LIMIT @limit
    `)
    .all({ ...params, limit });
  return (all as unknown) as UsageLogRow[];
}

/** 窗口内出现的结算币种集合（决定面板成本符号；混币种时无法合并展示） */
export function listCostCurrencies(db: DB, opts: UsageWindow = {}): Array<'usd' | 'cny'> {
  const { clause, params } = buildWindowClause(opts);
  const rows = db
    .prepare(`SELECT DISTINCT currency AS c FROM usage_log ${clause}`)
    .all(params) as Array<{ c: string }>;
  return rows.map((r) => (r.c === 'cny' ? 'cny' : 'usd'));
}

// ==================== 展示格式化 ====================

/** token 数格式化：≥1000 显示 k（128k / 1.2M） */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 金额格式化：$0.0012 / $12.34；null = 未定价 */
export function fmtUSD(n: number | null): string {
  if (n == null) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
