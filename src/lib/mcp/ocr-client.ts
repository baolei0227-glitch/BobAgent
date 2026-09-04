/**
 * bob-ocr-mcp 识别客户端 — BobWork 内部识别链路的统一 MCP 出口
 *
 * 职责：把 BobWork 内部的扫描件/图片/PDF 识别请求转交 bob-ocr-mcp 常驻服务
 * （http://127.0.0.1:9478/mcp，streamable-http + token 鉴权），使识别引擎与
 * 配置（视觉模型 / Online OCR / GLM-OCR）完全收敛到 MCP 插件；MCP 不可用或
 * 调用失败时返回 null，由调用方返回明确错误（不再回退本地引擎）。
 *
 * 服务端为无状态 streamable-http（sessionIdGenerator 未启用），每次调用
 * 独立完成 initialize → initialized → tools/call 握手即可，无需维护会话。
 */

import type { McpServerConfig } from './types';
import { computeVisionFileHash, getVisionCache, setVisionCache } from '@/lib/parse/vision-cache';

/** 本地 Vision 引擎输出的行级几何骨架（归一化 0~1、左下原点 y 向上；GLM/VLM 升级页可能缺失） */
export interface OcrMcpBlock {
  text: string;
  confidence?: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** MCP 识别页结果（与 ocr-service.OcrPageResult 结构兼容） */
export interface OcrMcpPage {
  index: number;
  text: string;
  qualityScore: number;
  ledgerVerified: number;
  rotated: boolean;
  enhanced: boolean;
  upgraded: boolean;
  upgradeChain?: string;
  upgradeModel?: string;
  /** 行级坐标骨架：本地 Vision 主链路必有；用于 PDF 预览搜索命中精确高亮 */
  blocks?: OcrMcpBlock[];
  /** 光栅图像像素尺寸（blocks 归一化坐标的参照尺寸） */
  width?: number;
  height?: number;
  /** 页面朝向（0/90/180/270），Swift 端已转置回纸面正确朝向 */
  orientation?: number;
  skewAngle?: number | null;
}

/** MCP 识别结果（与 ocr-service.OcrServiceResult 结构兼容） */
export interface OcrMcpResult {
  success: boolean;
  text: string;
  method: string;
  pageCount: number;
  pages: OcrMcpPage[];
  upgradedCount?: number;
  notes?: string[];
  error?: string;
  /** 无文字时的下一步引导（纯图片/照片）：提示改用 ocr.image_understand 视觉理解 */
  guidance?: string;
  /** 图片空结果自动降级到视觉理解的内容（ocr.recognize 内部 image_understand 产出） */
  understanding?: string;
  /** 自动视觉理解所用模型 */
  understandingModel?: string;
  understandingMode?: string;
}

/** OCR 过程级进度（插件 ocr-service 上报，经 MCP notifications/progress 透传） */
export interface OcrProgressEvent {
  /** 阶段：start=开始；page=单页本地 Vision 完成；engine=云端引擎尝试（glm-ocr/online-ocr/vlm） */
  phase: 'start' | 'page' | 'engine';
  /** 0-based 页码 */
  pageIndex?: number;
  /** 总页数 */
  totalPages?: number;
  /** 引擎标识：local-vision / glm-ocr / online-ocr / vlm */
  engine?: string;
  /** 实际模型 id（在线引擎时有值） */
  model?: string;
}

export type OcrProgressHandler = (p: OcrProgressEvent) => void;

const OCR_MCP_ID = 'bob-ocr-mcp';
/** 握手/探测超时：仅确认服务在线，短超时避免拖慢识别入口 */
const HANDSHAKE_TIMEOUT_MS = 2000;
/** 识别调用超时：大 PDF 整份识别可能 1-2 分钟 */
const CALL_TIMEOUT_MS = 300_000;
/** 探测失败后的基础冷却期：避免每次识别都白等握手超时（MCP 未装/未启动时） */
const BACKOFF_BASE_MS = 5_000;
/** 最大冷却期：避免无限延长 */
const BACKOFF_MAX_MS = 30_000;
/** 快速探测间隔：冷却期内每隔这么久允许一次快速探测 */
const PROBE_INTERVAL_MS = 3_000;

/** 模块级冷却状态：指数退避 + 快速恢复 */
let mcpBackoffUntil = 0;
let mcpFailCount = 0;
let mcpLastProbeAt = 0;

/** 主 MCP 运行态中 bob-ocr-mcp 的状态：'missing'=从未同步 | 'active'=已连接 | 'inactive'=已同步但非 active */
type OcrMcpRuntimeState = 'missing' | 'active' | 'inactive';

/** 读取主 MCP 基建（mcpManager）中 bob-ocr-mcp 的运行态。
 *  方案 B（配置同源）：内置 OCR 通道的可用性判定与 MCP 工具注册共用主运行态，
 *  消除"内置通道不可用但 ocr.* 工具在线"的不一致。 */
async function getOcrMcpRuntimeState(): Promise<OcrMcpRuntimeState> {
  try {
    const { mcpManager } = await import('@/lib/mcp/manager');
    const runtime = mcpManager.getPluginStatuses().find((r) => r.id === OCR_MCP_ID);
    if (!runtime) return 'missing';
    return runtime.state === 'active' ? 'active' : 'inactive';
  } catch {
    return 'missing';
  }
}

/** 从 BobWork 设置动态读取 bob-ocr-mcp 条目（URL/token 随配置走，不硬编码）。
 *  可用性判定与主 MCP 运行态同源：
 *   - 主运行态从未同步该 server（missing）→ 回退静态配置（兼容非聊天入口的直接调用）
 *   - 已同步但非 active（连接失败/节点禁用）→ 视为不可用（与工具注册一致，不再出现"内置不可用但工具在线"） */
async function getOcrMcpConfig(): Promise<McpServerConfig | null> {
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const settings = await readSettingsFromFile();
    const cfg = (settings.mcpServers ?? []).find(
      (s) => s.id === OCR_MCP_ID && s.enabled && !!s.url,
    );
    if (!cfg) return null;
    const state = await getOcrMcpRuntimeState();
    if (state === 'inactive') {
      console.warn(`[ocr-mcp] bob-ocr-mcp 主运行态非 active（连接失败或被节点禁用），内置 OCR 通道与工具注册一致：按不可用处理`);
      return null;
    }
    return cfg;
  } catch {
    return null;
  }
}

/** MCP notifications/progress 通知的 params（MCP 规范：progressToken/progress/total/message） */
interface McpProgressParams {
  progressToken?: number | string;
  progress?: number;
  total?: number;
  message?: string;
}

/** 把 MCP progress 通知解析成 OcrProgressEvent（message 为插件 JSON 时直接透传，否则按页码反推） */
function parseOcrProgress(p: McpProgressParams): OcrProgressEvent {
  if (typeof p.message === 'string' && p.message.trim()) {
    try {
      const parsed = JSON.parse(p.message) as OcrProgressEvent;
      if (parsed && typeof parsed.phase === 'string') return parsed;
    } catch {
      /* message 非 JSON，走下面按页码反推 */
    }
  }
  return { phase: 'page', pageIndex: Math.max(0, (p.progress ?? 1) - 1), totalPages: p.total };
}

/** 一次 MCP JSON-RPC 请求；返回 { ok, data, sessionId }，任一步失败 ok=false。
 *  onProgress：SSE 响应流中收到 notifications/progress 通知时回调（识别过程实时上报） */
async function mcpRequest(
  cfg: McpServerConfig,
  body: Record<string, unknown>,
  timeoutMs: number,
  sessionId?: string,
  onProgress?: OcrProgressHandler,
): Promise<{ ok: boolean; data?: unknown; sessionId?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const auth = cfg.headers?.Authorization || cfg.headers?.authorization;
  if (auth) headers.Authorization = auth;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.url!, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false };
    const ctype = res.headers.get('content-type') || '';
    // SSE 响应：流式逐帧读取（识别期间插件会先发 notifications/progress 帧，最后发 tools/call 结果帧）
    if (ctype.includes('text/event-stream') && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let resultJson: string | undefined;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const raw = dataLine.slice(5).trim();
            if (!raw) continue;
            try {
              const msg = JSON.parse(raw);
              if (msg?.method === 'notifications/progress') {
                onProgress?.(parseOcrProgress(msg.params ?? {}));
              } else if (msg?.id !== undefined) {
                resultJson = raw; // 请求响应帧（tools/call 结果）
              }
            } catch {
              /* 坏帧忽略 */
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      const data = resultJson ? JSON.parse(resultJson) : undefined;
      return { ok: true, data, sessionId: res.headers.get('Mcp-Session-Id') ?? undefined };
    }
    const text = await res.text();
    // 兼容：响应体带 data: 行但 content-type 未声明 SSE（部分服务端行为差异）
    const jsonStr = text.includes('\ndata:')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('')
      : text;
    const data = jsonStr ? JSON.parse(jsonStr) : undefined;
    return { ok: true, data, sessionId: res.headers.get('Mcp-Session-Id') ?? undefined };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用一个 MCP OCR 工具（握手 + tools/call）。
 * @param onProgress 识别过程级进度回调（notifications/progress 实时上报，引擎/页码）
 * @returns 工具返回的原始对象；MCP 未配置/不可用/调用失败 → null（调用方回退本地）
 */
async function callOcrTool(
  cfg: McpServerConfig,
  name: string,
  args: Record<string, unknown>,
  onProgress?: OcrProgressHandler,
): Promise<Record<string, unknown> | null> {
  const now = Date.now();
  // 方案 B 同源：主 MCP 运行态 active（= 工具列表 ocr.* 在线）时服务确认在线，
  // 冷却期不拦截——冷却只防御"运行态失联"场景，避免"内置不可用但工具在线"反复出现。
  const runtimeState = await getOcrMcpRuntimeState();
  if (runtimeState !== 'active' && now < mcpBackoffUntil) {
    // 允许偶尔进行快速探测（每 PROBE_INTERVAL_MS 一次），成功则立即退出冷却
    if (now - mcpLastProbeAt < PROBE_INTERVAL_MS) {
      console.warn(`[ocr-mcp] ${name} 跳过：冷却期内（剩余 ${Math.ceil((mcpBackoffUntil - now) / 1000)}s）`);
      return null;
    }
    mcpLastProbeAt = now;
    console.log(`[ocr-mcp] ${name} 冷却期内快速探测...`);
  }

  try {
    // 1) initialize 握手
    const init = await mcpRequest(
      cfg,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'bob-work-ocr', version: '1.0.0' },
        },
      },
      HANDSHAKE_TIMEOUT_MS,
    );
    if (!init.ok) {
      // 失败：指数退避
      mcpFailCount++;
      const backoff = Math.min(BACKOFF_BASE_MS * Math.pow(2, mcpFailCount - 1), BACKOFF_MAX_MS);
      mcpBackoffUntil = Date.now() + backoff;
      console.warn(`[ocr-mcp] ${name} 握手失败（第${mcpFailCount}次），冷却 ${backoff / 1000}s`);
      return null;
    }
    // 2) initialized 通知（可选；无状态服务忽略失败）
    await mcpRequest(
      cfg,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      HANDSHAKE_TIMEOUT_MS,
      init.sessionId,
    ).catch(() => ({ ok: false }));

    // 3) tools/call（带 _meta.progressToken：插件据此实时发 notifications/progress 进度帧）
    const call = await mcpRequest(
      cfg,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name, arguments: args, _meta: { progressToken: 1 } },
      },
      CALL_TIMEOUT_MS,
      init.sessionId,
      onProgress,
    );
    if (!call.ok || !call.data) {
      // 失败：指数退避
      mcpFailCount++;
      const backoff = Math.min(BACKOFF_BASE_MS * Math.pow(2, mcpFailCount - 1), BACKOFF_MAX_MS);
      mcpBackoffUntil = Date.now() + backoff;
      console.warn(`[ocr-mcp] ${name} 工具调用失败（第${mcpFailCount}次），冷却 ${backoff / 1000}s`);
      return null;
    }
    const result = call.data as {
      result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
    };
    if (result.result?.isError) {
      // 工具返回错误（非连接问题）：重置失败计数，不触发冷却
      const errText = (result.result.content ?? []).map((c) => c.text ?? '').join('');
      console.warn(`[ocr-mcp] ${name} 工具返回错误: ${errText}`);
      mcpFailCount = 0;
      mcpBackoffUntil = 0;
      return null;
    }
    const text = (result.result?.content ?? []).map((c) => c.text ?? '').join('');
    if (!text) {
      // 空响应：重置失败计数
      console.warn(`[ocr-mcp] ${name} 返回空响应`);
      mcpFailCount = 0;
      mcpBackoffUntil = 0;
      return null;
    }
    // 成功：重置所有冷却状态
    mcpFailCount = 0;
    mcpBackoffUntil = 0;
    return JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    // 异常：指数退避
    mcpFailCount++;
    const backoff = Math.min(BACKOFF_BASE_MS * Math.pow(2, mcpFailCount - 1), BACKOFF_MAX_MS);
    mcpBackoffUntil = Date.now() + backoff;
    console.warn(`[ocr-mcp] ${name} 异常（第${mcpFailCount}次）: ${e instanceof Error ? e.message : String(e)}，冷却 ${backoff / 1000}s`);
    return null;
  }
}

/** 统一入口：读配置并调用工具；MCP 未配置返回 null */
async function withOcrMcp<T>(fn: (cfg: McpServerConfig) => Promise<T | null>): Promise<T | null> {
  const cfg = await getOcrMcpConfig();
  if (!cfg?.url) return null;
  return fn(cfg);
}

/**
 * 经 MCP 识别一个文件（ocr.recognize）。
 * @param onProgress 识别过程级进度回调（notifications/progress 实时上报，引擎/页码）
 * @returns 识别成功 → 结构化结果；MCP 未配置/不可用/识别失败 → null（调用方回退本地）
 */
export async function ocrRecognizeViaMcp(
  filePath: string,
  upgrade: 'off' | 'auto' | 'always' = 'off',
  onProgress?: OcrProgressHandler,
): Promise<OcrMcpResult | null> {
  const r = await withOcrMcp((cfg) => callOcrTool(cfg, 'ocr.recognize', { path: filePath, upgrade }, onProgress));
  if (!r) return null;
  const parsed = r as unknown as OcrMcpResult;
  return parsed && parsed.success ? parsed : null;
}

/**
 * 经 MCP 识别银行流水（ocr.bank_statement：流水转录 + 余额勾稽）。
 * @param onProgress 识别过程级进度回调（notifications/progress 实时上报，引擎/页码）
 * @returns 识别成功 → 结构化结果（含逐页 ledger 摘要）；MCP 不可用/失败 → null（调用方回退）
 */
export async function ocrBankStatementViaMcp(
  filePath: string,
  onProgress?: OcrProgressHandler,
): Promise<OcrMcpResult | null> {
  const r = await withOcrMcp((cfg) => callOcrTool(cfg, 'ocr.bank_statement', { path: filePath }, onProgress));
  if (!r) return null;
  const parsed = r as unknown as OcrMcpResult;
  return parsed && parsed.success ? parsed : null;
}

/**
 * MCP 优先统一出口：BobWork 识别链路只调用本函数。
 * 可用 → MCP 结果；未配置/不可用/失败 → null（调用方返回明确错误，不再回退本地引擎）。
 */
export async function tryOcrViaMcp(
  filePath: string,
  upgrade: 'off' | 'auto' | 'always' = 'off',
  onProgress?: OcrProgressHandler,
): Promise<OcrMcpResult | null> {
  return ocrRecognizeViaMcp(filePath, upgrade, onProgress);
}

/** ocr.image_understand 结果（与插件返回结构兼容） */
export interface OcrImageUnderstandResult {
  file: string;
  model: string;
  mode: string;
  understanding: string;
  tokens?: { input?: number; output?: number };
}

/**
 * 经 MCP 做图片语义理解（ocr.image_understand：风格/内容/图表/UI/自定义问题）。
 * 复用插件 vision 配置 + general 模式 prompt；未配置/不可用/失败 → null（调用方回退本地视觉模型）。
 */
export async function ocrImageUnderstandViaMcp(
  filePath: string,
  opts: { mode?: string; prompt?: string } = {},
): Promise<OcrImageUnderstandResult | null> {
  const mode = opts.mode ?? 'general';

  // 内容哈希（一次计算，缓存查/写共用）；哈希失败则跳过缓存直接走 MCP
  let fileHash = '';
  try {
    fileHash = await computeVisionFileHash(filePath);
  } catch {
    fileHash = '';
  }

  // 缓存查：命中直接返回，避免重复调用视觉模型（同图多轮/多项目复用）
  if (fileHash) {
    const cached = await getVisionCache(fileHash, mode, opts.prompt).catch(() => null);
    if (cached) {
      return { file: filePath, model: cached.model, mode, understanding: cached.understanding };
    }
  }

  const args: Record<string, unknown> = { path: filePath };
  if (opts.mode) args.mode = opts.mode;
  if (opts.prompt) args.prompt = opts.prompt;
  const r = await withOcrMcp((cfg) => callOcrTool(cfg, 'ocr.image_understand', args));
  if (!r) return null;
  const parsed = r as unknown as OcrImageUnderstandResult;
  if (!parsed || !parsed.understanding) return null;

  // 缓存写：成功结果落盘（异步，不阻塞返回）
  if (fileHash) {
    void setVisionCache({
      fileHash,
      mode,
      prompt: opts.prompt,
      understanding: parsed.understanding,
      model: parsed.model || '',
      cached_at: new Date().toISOString(),
    }).catch(() => {});
  }

  return parsed;
}

/** ocr.config_status 结果（插件配置概览，脱敏） */
export interface OcrConfigStatus {
  vision?: { defaultModel?: string; model?: string; apiKey?: string; baseUrl?: string; local?: boolean };
  onlineOcr?: { model?: string; apiKey?: string; strategy?: string } | null;
  glmOcr?: { enabled?: boolean; strategy?: string; priority?: string } | null;
  providers?: string[];
  importedFromBobwork?: string;
}

/**
 * 经 MCP 读取插件配置状态（ocr.config_status，零 API 消耗）。
 * 用于探测插件是否已配置视觉模型等能力；MCP 未配置/不可用 → null。
 */
export async function ocrConfigStatusViaMcp(): Promise<OcrConfigStatus | null> {
  const r = await withOcrMcp((cfg) => callOcrTool(cfg, 'ocr.config_status', {}));
  if (!r) return null;
  return r as unknown as OcrConfigStatus;
}

/** 插件 /setup/status 探测结果 */
export interface OcrSetupStatus {
  mcpOnline: boolean;
  /** 插件配置页地址（自带 token），在线且有值时可一键打开 */
  settingsUrl: string | null;
}

/**
 * 异步识别：提交任务立即返回 taskId（插件后台执行，不阻塞客户端超时）。
 * 用于长耗时识别（本地 VLM 分钟级 / 整份大 PDF）——同步等待会撞客户端超时 → 重试翻倍。
 * @returns { taskId, status: 'queued', upgrade } | null（MCP 不可用/失败）
 */
export async function submitRecognizeTask(
  filePath: string,
  upgrade: 'off' | 'auto' | 'always' = 'off',
): Promise<{ taskId: string; status: string; upgrade?: string } | null> {
  const r = await withOcrMcp((cfg) =>
    callOcrTool(cfg, 'ocr.recognize', { path: filePath, upgrade, async: true }),
  );
  if (!r) return null;
  const parsed = r as { taskId?: unknown; status?: unknown; upgrade?: unknown };
  return parsed && typeof parsed.taskId === 'string' && parsed.taskId
    ? { taskId: parsed.taskId, status: String(parsed.status ?? 'queued'), upgrade: typeof parsed.upgrade === 'string' ? parsed.upgrade : upgrade }
    : null;
}

/** 异步任务状态查询（ocr.task_status）。status: queued|running|done|failed|not_found */
export interface OcrTaskStatusResult {
  taskId: string;
  status: string;
  progress?: number;
  progressText?: string;
  position?: number;
  result?: unknown;
  error?: string;
}

export async function getOcrTaskStatus(taskId: string): Promise<OcrTaskStatusResult | null> {
  const r = await withOcrMcp((cfg) => callOcrTool(cfg, 'ocr.task_status', { task_id: taskId }));
  if (!r) return null;
  const t = r as Partial<OcrTaskStatusResult>;
  return {
    taskId: String(t.taskId ?? taskId),
    status: String(t.status ?? 'unknown'),
    ...(typeof t.progress === 'number' ? { progress: t.progress } : {}),
    ...(typeof t.progressText === 'string' ? { progressText: t.progressText } : {}),
    ...(typeof t.position === 'number' ? { position: t.position } : {}),
    ...(t.result !== undefined ? { result: t.result } : {}),
    ...(typeof t.error === 'string' ? { error: t.error } : {}),
  };
}

/**
 * 探测插件常驻服务 /setup/status，取配置页地址（settingsUrl 带 token）。
 * 走插件的 HTTP 探测端点（非 MCP），BobWork 设置里的"Open Config"按钮用；
 * 插件不在线/未配置 → { mcpOnline: false, settingsUrl: null }。
 */
export async function getOcrSetupStatus(): Promise<OcrSetupStatus> {
  const cfg = await getOcrMcpConfig();
  if (!cfg?.url) return { mcpOnline: false, settingsUrl: null };
  try {
    // 从 MCP URL（…/mcp?token=…）换路径到 /setup/status（该端点不校验 token，query 一并清掉）
    const parsed = new URL(cfg.url);
    parsed.pathname = '/setup/status';
    parsed.search = '';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), HANDSHAKE_TIMEOUT_MS);
    try {
      const res = await fetch(parsed.toString(), { signal: ctl.signal });
      if (!res.ok) return { mcpOnline: false, settingsUrl: null };
      const data = (await res.json()) as { settingsUrl?: unknown };
      return {
        mcpOnline: true,
        settingsUrl: typeof data.settingsUrl === 'string' && data.settingsUrl ? data.settingsUrl : null,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { mcpOnline: false, settingsUrl: null };
  }
}
