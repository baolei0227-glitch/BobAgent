/**
 * Sandbox Chat Bridge — 小程序模型调用（亲儿子模式：与宿主主大模型同等待遇）
 *
 * 设计定位：小程序是 BobWork 的原生功能组件（亲儿子），不是不可信的外部代码，
 * 因此模型调用在权限闸通过后，享受与宿主主聊天一致的规格：
 *   - 不做 PII 脱敏（与宿主聊天相同，出口仅保留 egress-audit.log 审计留痕）；
 *   - 不限定仅命中「已勾选模型池」：只要 provider 已配置 apiKey 即可调用该厂商的任意模型；
 *   - 输入/输出 token 上限对齐宿主主聊天（不再单独钳制 2k/16k 字符）；
 *   - 保留权限闸（让 BobWork 知情并授权）与出口审计。
 *
 * 两种调用形态：
 *   - executeSandboxChat        非流式（单次返回完整文本，向后兼容）
 *   - executeSandboxChatStream  流式（异步生成器逐块产出增量文本，供宿主转发 iframe）
 * 二者共用 resolveSandboxChatConfig 的鉴权与审计。
 */

import { PROVIDER_PRESETS, type ProviderType } from '@/lib/types';
import type { SandboxChatPermission } from '@/lib/settings';

export interface SandboxChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface SandboxChatParams {
  /** 发起调用的小程序 appId（客户端脚本自动注入，服务端据此鉴权） */
  appId: string;
  /** 模型标识，格式 provider:modelId（如 deepseek:deepseek-flash）；
   *  缺省时走 Auto 模式：系统自动从已配置厂商的勾选模型池里选可用模型 */
  model?: string;
  messages: SandboxChatMessage[];
  temperature?: number;
  /** 输出 token 上限（服务端强制钳制到 MAX_OUTPUT_TOKENS 以内） */
  maxTokens?: number;
}

export interface SandboxChatResult {
  content: string;
  model: string;
  provider: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

/** 流式调用的产出：生成器逐块 yield 增量文本；结束时 return 元信息 */
export interface SandboxChatStreamMeta {
  model: string;
  provider: string;
  finish_reason?: string;
  stop_reason?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

/** 单次输出 token 建议上限（亲儿子模式：不强制钳制，仅当小程序未显式传 maxTokens 时以此作为默认值） */
export const BRIDGE_CHAT_DEFAULT_OUTPUT_TOKENS = 8192;
/** 亲儿子模式：无输出硬上限，模型输出能力按模型本身上下文窗口决定（保留该常量仅用于向后兼容引用） */
export const BRIDGE_CHAT_MAX_OUTPUT_TOKENS = 32768;
/** 输入字符量建议上限（亲儿子模式：对齐宿主主聊天，宽松到 128k 字符；超过时警告但不拒绝） */
export const BRIDGE_CHAT_SOFT_INPUT_CHARS = 128_000;

/**
 * Auto 模式：从已配置厂商列表里选第一个有 API Key 的厂商，
 * 优先用该厂商首个「已勾选模型」作默认，没有勾选时退回 provider type 对应的 preset defaultModel。
 * 小程序是亲儿子，不再严格依赖「已勾选模型池」——只要 provider 有 apiKey，就能用任意模型。
 */
function pickAutoModel(
  providerConfigs: Array<{ type: string; apiKey?: string; selectedModels?: Array<string | { modelId: string }>; defaultModel?: string }>,
): { provider: string; modelId: string } | null {
  for (const cfg of providerConfigs) {
    if (!cfg.apiKey?.trim()) continue;
    const selected = (cfg.selectedModels ?? []).map((s) => (typeof s === 'string' ? s : s.modelId));
    if (selected.length > 0) {
      return { provider: cfg.type, modelId: selected[0] };
    }
    // 没有勾选模型时，退回 provider preset 的首个模型（亲儿子兜底：不被 selectedModels 卡死）
    const preset = PROVIDER_PRESETS.find((p) => p.type === cfg.type);
    const fallback = (cfg as any).defaultModel || preset?.models?.[0]?.modelId;
    if (fallback) {
      return { provider: cfg.type, modelId: String(fallback) };
    }
    // 最后兜底：仍返回第一个可用 provider（哪怕暂时没有 modelId，稍后 resolve 层会报错）
    return { provider: cfg.type, modelId: '' };
  }
  return null;
}

/** 安全闸解析结果：executeSandboxChat / executeSandboxChatStream 共用的已鉴权配置 */
interface ResolvedSandboxChat {
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  maxTokens: number;
  msgs: SandboxChatMessage[];
  totalChars: number;
}

/**
 * 鉴权与配置解析：返回可发起模型请求的已授权配置。
 * 亲儿子模式下，仅保留两道闸：权限闸（用户知情并授权）+ 出口审计。
 * 模型池、PII 脱敏、输入/输出硬性上限全部对齐宿主主聊天的处理方式。
 */
async function resolveSandboxChatConfig(
  params: SandboxChatParams,
): Promise<ResolvedSandboxChat> {
  // ── 0. appId 必须存在 ──
  if (!params.appId) {
    throw new Error('chat denied: cannot identify mini-program (appId missing)');
  }

  // ── 1. 读取服务端设置文件（权限闸共用） ──
  const { readSettingsFromFile } = await import('@/lib/settings-server');
  const settings = await readSettingsFromFile();

  // ── 2. 权限闸：保留（让 BobWork 知情并授权） ──
  const rawPerm = settings.sandboxChatPermissions?.[params.appId] as unknown as SandboxChatPermission | boolean | undefined;
  const permGranted = rawPerm === true || rawPerm === 'permanent' || rawPerm === 'per_call';
  if (!permGranted) {
    throw new Error(
      'chat denied: model-call permission not granted. Call BobWork.request("chatRequestPermission") first.',
    );
  }

  // ── 3. 输入校验：消息格式（亲儿子模式：仅记录字数警告，超过软上限不拒绝） ──
  const msgs = (Array.isArray(params.messages) ? params.messages : []).filter(
    (m) => m && typeof m.content === 'string' && m.role !== undefined,
  );
  if (msgs.length === 0 || !msgs.some((m) => m.role === 'user')) {
    throw new Error('chat: at least one user message is required');
  }
  const totalChars = msgs.reduce((n, m) => n + m.content.length, 0);
  if (totalChars > BRIDGE_CHAT_SOFT_INPUT_CHARS) {
    try {
      // eslint-disable-next-line no-console
      console.warn(
        `[sandbox-chat] App ${params.appId} input ${totalChars} chars exceeds soft cap ${BRIDGE_CHAT_SOFT_INPUT_CHARS}; proceeding anyway.`,
      );
    } catch { /* ignore */ }
  }

  // ── 4. 模型解析：亲儿子模式 —— 取消「必须命中 selectedModels」的限制 ──
  //    只要求：provider 已配置且存在 apiKey。modelId 由小程序自由指定，未指定时走 Auto 兜底。
  const providerConfigs = settings.providers ?? [];
  const presetByType = new Map(PROVIDER_PRESETS.map((p) => [p.type, p]));

  let provider: string;
  let modelId: string;
  if (params.model && params.model.includes(':')) {
    const [p, m] = params.model.split(':', 2);
    provider = p;
    modelId = m;
  } else {
    const picked = pickAutoModel(providerConfigs);
    if (!picked) {
      throw new Error('chat: no model available. Configure at least one provider with an API key.');
    }
    provider = picked.provider;
    modelId = picked.modelId;
  }
  if (!modelId) {
    throw new Error(`chat: no model selected for provider "${provider}". Pass a model like "provider:modelId".`);
  }

  const providerType = provider as ProviderType;
  const cfg = providerConfigs.find((c) => c.type === providerType);
  if (!cfg || !cfg.apiKey?.trim()) {
    throw new Error(`chat: provider "${provider}" is not configured (missing API key)`);
  }

  // ── 5. 组装 OpenAI 兼容请求地址 + 输出 token 默认值（不强制钳制，小程序显式传则按其值） ──
  const baseUrl = (cfg.baseUrl?.trim() || presetByType.get(providerType)?.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error(`chat: provider "${provider}" has no base URL`);
  }
  // 亲儿子模式：不再 Math.min 钳制——缺省时用 DEFAULT（8192），小程序显式传大值允许超过 BRIDGE_CHAT_MAX_OUTPUT_TOKENS
  const maxTokens = Math.max(1, Math.floor(params.maxTokens ?? BRIDGE_CHAT_DEFAULT_OUTPUT_TOKENS));

  return { provider, modelId, baseUrl, apiKey: cfg.apiKey, maxTokens, msgs, totalChars };
}

/** 构造发给模型的标准请求体（流式/非流式共用） */
function buildChatBody(
  cfg: ResolvedSandboxChat,
  temperature: number | undefined,
  stream: boolean,
): Record<string, unknown> {
  return {
    model: cfg.modelId,
    messages: cfg.msgs,
    temperature: typeof temperature === 'number' ? temperature : undefined,
    max_tokens: cfg.maxTokens,
    stream,
  };
}

/** 出口审计：统一在 finally 记录，永不抛错、不阻塞主链路 */
async function audit(
  cfg: ResolvedSandboxChat,
  ok: boolean,
  ms: number,
): Promise<void> {
  try {
    const { logEgressUpload } = await import('@/lib/egress-audit');
    logEgressUpload({
      filePath: `sandbox://${cfg.provider}:${cfg.modelId}`,
      bytes: cfg.totalChars,
      baseUrl: cfg.baseUrl,
      model: `${cfg.provider}:${cfg.modelId}`,
      chain: 'sandbox-chat',
      ok,
      ms,
      error: ok ? undefined : 'sandbox chat call failed',
    });
  } catch {
    // 审计失败不影响主链路
  }
}

/** 执行一次小程序模型调用（非流式，向后兼容）；不满足任一闸条件时抛错 */
export async function executeSandboxChat(params: SandboxChatParams): Promise<SandboxChatResult> {
  const cfg = await resolveSandboxChatConfig(params);
  const started = Date.now();
  let ok = false;
  try {
    const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(buildChatBody(cfg, params.temperature, false)),
      signal: AbortSignal.timeout(60_000),
    });
    const body: {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      error?: { message?: string };
    } = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      throw new Error(`chat: provider error (${body?.error?.message || `HTTP ${resp.status}`})`);
    }
    const contentRaw = body?.choices?.[0]?.message?.content;
    if (typeof contentRaw !== 'string') {
      throw new Error('chat: empty response from provider');
    }
    ok = true;
    return {
      content: contentRaw,
      model: `${cfg.provider}:${cfg.modelId}`,
      provider: cfg.provider,
      usage: body?.usage
        ? {
            promptTokens: body.usage.prompt_tokens,
            completionTokens: body.usage.completion_tokens,
            totalTokens: body.usage.total_tokens,
          }
        : undefined,
    };
  } finally {
    await audit(cfg, ok, Date.now() - started);
  }
}

/**
 * 执行一次小程序模型调用（流式）：异步生成器逐块 yield 增量文本，结束时 return 元信息。
 * 通过 AbortSignal 取消（前端可中止生成，终止后停止审计为 ok=false 记录）。
 */
export async function* executeSandboxChatStream(
  params: SandboxChatParams,
  signal?: AbortSignal,
): AsyncGenerator<string, SandboxChatStreamMeta, void> {
  const cfg = await resolveSandboxChatConfig(params);
  const started = Date.now();
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  // 90s「空闲」超时：每收到一个数据块就重置计时器，仅连续 90s 无数据（真挂起）才中断。
  // 此前为固定总时长 90s，慢推理/长输出流会被误杀（后端仍在执行、前端已 abort）。
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(), 90_000);
  };
  armIdle();

  let ok = false;
  let completionTokens: number | undefined;
  let promptTokens: number | undefined;
  let finishReason: string | undefined;
  let stopReason: string | undefined;
  try {
    const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(buildChatBody(cfg, params.temperature, true)),
      signal: ac.signal,
    });

    if (!resp.ok || !resp.body) {
      // 非流式错误：尝试读取 JSON 错误体
      let msg = `HTTP ${resp.status}`;
      try {
        const err = await resp.json();
        if (err?.error?.message) msg = err.error.message;
      } catch { /* ignore */ }
      throw new Error(`chat: provider error (${msg})`);
    }

    // 逐块读取 SSE 流：OpenAI 兼容格式 data: {...}\n\n，最后一个 data: [DONE]
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle(); // 空闲超时：收到数据块即重置 90s 计时器
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          ok = true;
          return {
            model: `${cfg.provider}:${cfg.modelId}`,
            provider: cfg.provider,
            finish_reason: finishReason,
            stop_reason: stopReason,
            usage:
              promptTokens !== undefined || completionTokens !== undefined
                ? { promptTokens, completionTokens, totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0) }
                : undefined,
          };
        }
        try {
          const parsed = JSON.parse(data);
          // P3#12: 读取 finish_reason / stop_reason
          const choice = parsed?.choices?.[0];
          if (choice) {
            if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
            if (typeof choice.stop_reason === 'string') stopReason = choice.stop_reason;
          }
          const delta = choice?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            yield delta;
          }
          if (parsed?.usage) {
            if (typeof parsed.usage.prompt_tokens === 'number') promptTokens = parsed.usage.prompt_tokens;
            if (typeof parsed.usage.completion_tokens === 'number') completionTokens = parsed.usage.completion_tokens;
          }
        } catch {
          // 单块解析失败忽略（跳过非 JSON 的 SSE 注释等）
        }
      }
    }
    ok = true;
    return {
      model: `${cfg.provider}:${cfg.modelId}`,
      provider: cfg.provider,
      finish_reason: finishReason,
      stop_reason: stopReason,
      usage:
        promptTokens !== undefined || completionTokens !== undefined
          ? { promptTokens, completionTokens, totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0) }
          : undefined,
    };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
    // 审计在流式结束时统一记录（若中途出错，ok 保持 false）
    await audit(cfg, ok, Date.now() - started);
  }
}
