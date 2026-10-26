/**
 * Butler 对话入口（entry.ts）—— Butler 独立运行体系的「说话」入口
 *
 * 用户在 Butler 抽屉 / 微信发一条消息时（斜杠命令已被入口归一化成「意图 + 正文」，
 * `/chat` 命令本身已于 2026-09-25 退役 —— 普通文本直连本模块）：
 *   1. 决定会话 threadId：
 *      - 显式 threadIdHint（调用方传入的权威线程 ID）优先，如微信桥固定落「通知助理」常驻线程
 *      - 其次复用调用方传入的 reuseThreadId（桌面续聊；线程不存在/已过期则视为新线程）
 *      - 否则新建（前缀 `b-`）
 *   2. 从 Butler 自有线程存储（`butler/.state/threads/<id>.json`，见 threads.ts）加载历史 messages
 *      → 组装对话 + 新问题：恒为「完整管家身份」——剥离历史 system（旧沙盒提示残留会让模型自称
 *      「只读」），系统提示交由 /api/chat 按已装 butler 画像注入（identity='butler'）
 *   3. 调 /api/chat：恒传 identity='butler' + 显式 projectId（与悬浮球流式链路同源同序）；
 *      模型 / 思考档位是**会话级选型**：本轮传了用本轮，否则用线程里存的（见 options.modelId）。
 *      微信桥额外带 channel='wechat'（聚合链路收不到确认卡回传 → route 按白名单收口写类动作）
 *   4. 聚合 SSE 流为完整文本 → 写回线程存储（panel 长期保留；wechat 24 小时过期）
 *   5. 返回 reply + messages + threadId
 *
 * 注：/chat 结果不再发布到收件箱（2026-09），仅通过界面浮层展示。
 * 生命周期：panel 线程长期保留（供多轮问答复用上下文）；wechat 线程 24 小时过期；
 * 过期由 threads.ts 的 60s 周期 sweep 兜底清理。
 *
 * 边界（Phase 4 §二）：**生成链路仍走对话层 /api/chat**，本模块只负责 Butler 自己的
 * 线程决议 / 消息组装 / 落库 —— 不复制 /api/chat 的引擎（那不是 Butler 的第二主 chat）。
 */
import { readSettingsFromFile } from '@/lib/settings-server';
import { PROVIDER_PRESETS, type ThinkingLevel } from '@/lib/types';
import { isChatModel } from '@/lib/model-tags';
import {
  generateThreadId,
  readThread,
  upsertThread,
  type ButlerThreadSource,
} from './threads';
import { parseModelTag, parseThinkingLevel, trimThreadMessages } from './threads-shared';
import type { ChatMessage } from '@/lib/bus';

/** 占位 nodeId（仅满足 /api/chat 的参数要求，非实际落盘节点） */
export const BUTLER_PLACEHOLDER_NODE_ID = 'temporary-node';

interface ButlerModel {
  /** 是否自定义 provider（true 传 apiKey/baseUrl/providerModelId；false 只传托管 modelId） */
  custom: boolean;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  providerModelId?: string;
}

/** 客户端解析好的模型凭据（三件套）。
 *
 *  与 chat 节点同一条取 Key 路径：渲染进程经 Electron IPC 拿到**已解密的** apiKey 后随请求透传，
 *  服务端不再自行解密设置文件。这样就不再依赖「主进程与服务端子进程派生同一把机器密钥」——
 *  Windows 上后者解不开时，Butler 也能正常拿到 Key。 */
export interface ButlerModelCredential {
  apiKey: string;
  baseUrl: string;
  providerModelId: string;
}

/** 解析 Butler 对话使用的模型。
 *
 *  - **显式选型**（`provider:modelId` 标签，来自抽屉模型下拉 / 会话已存的选择）：该厂商仍已配置
 *    且能算出 baseUrl → 用它；标签失效（厂商被删或去掉 Key）时**静默回退自动**，不让一条历史
 *    选择把整个会话卡在 400 上（用户在抽屉里换一个模型即可继续）。
 *  - **自动**：第一个已配置的自定义 provider 的第一个**对话**模型（无则报错引导配置）。 */
export async function resolveButlerModel(
  tag?: string | null,
  credential?: ButlerModelCredential | null,
): Promise<ButlerModel> {
  // 客户端已解析好的三件套优先：Key 由渲染进程经 IPC 解密后透传，服务端不再读设置文件。
  const credApiKey = credential?.apiKey?.trim() || '';
  const credBaseUrl = credential?.baseUrl?.trim() || '';
  const credModelId = credential?.providerModelId?.trim() || '';
  if (credApiKey && credBaseUrl && credModelId) {
    return { custom: true, providerModelId: credModelId, apiKey: credApiKey, baseUrl: credBaseUrl };
  }
  const settings = await readSettingsFromFile();
  const explicit = (tag ?? '').trim();
  if (explicit) {
    const sep = explicit.indexOf(':');
    const provider = sep > 0 ? settings.providers.find((p) => p.type === explicit.slice(0, sep) && !!p.apiKey) : undefined;
    const modelId = sep > 0 ? explicit.slice(sep + 1).trim() : '';
    if (provider && modelId) {
      const baseUrl = provider.baseUrl?.trim() || PROVIDER_PRESETS.find((p) => p.type === provider.type)?.baseUrl;
      if (baseUrl) return { custom: true, providerModelId: modelId, apiKey: provider.apiKey, baseUrl };
    }
  }
  for (const prov of settings.providers) {
    if (prov.apiKey && prov.selectedModels && prov.selectedModels.length > 0) {
      const firstChat =
        prov.selectedModels.find((s) => isChatModel(typeof s === 'string' ? s : s.modelId)) ||
        prov.selectedModels[0];
      const modelId = typeof firstChat === 'string' ? firstChat : firstChat.modelId;
      if (!modelId) continue;
      const baseUrl = prov.baseUrl?.trim() || PROVIDER_PRESETS.find((p) => p.type === prov.type)?.baseUrl;
      if (!baseUrl) continue;
      return {
        custom: true,
        providerModelId: modelId,
        apiKey: prov.apiKey,
        baseUrl,
      };
    }
  }
  throw new Error('No model configured. Please add a provider model in Settings → Models before using the chat.');
}

/**
 * 解析「当前活跃项目」id（用于显式传 projectId，见 streamButlerTurn 注释）。
 * 读失败 / 无活跃项目（NO_PROJECT）一律返回 undefined —— 调用方按「不传 projectId」降级，
 * 与旧行为一致，不阻断对话。
 */
async function resolveActiveProjectId(): Promise<string | undefined> {
  try {
    const { getCurrentProject } = await import('@/lib/project/project-manager');
    const p = await getCurrentProject();
    return p.id || undefined;
  } catch {
    return undefined;
  }
}

/**
 * askButler / streamButlerTurn 共用选项。
 *
 * ⚠️ 两条路径由**调用哪个函数**区分，不用选项开关。历史上 `butlerAgent?: boolean`（恒 undefined，
 * 半截通路）与 `source === 'wechat'` 身份分叉均已删除（P0 统一入口）：
 *   - askButler()      → 聚合问答，恒为**完整管家身份**（identity='butler'）+ 通道标记 channel
 *                        （'wechat' | 'panel'）。该 API 把上游 SSE 读到流结束才回一句 JSON，
 *                        拿不到确认卡/结构化提问回传 → route 对带 channel 的请求不登记挂起
 *                        （否则空等 CONFIRM_TIMEOUT_MS 十分钟）。写类权限按通道分档：
 *                        微信 = WECHAT_ALLOWED_WRITES 白名单（排程三件套 + 便签）；
 *                        panel = 只读（迁移到可弹卡的流式链路后再放开）。
 *   - streamButlerTurn() → Butler 抽屉路径，identity='butler'（route 解析已装 butler 包画像 +
 *                        fixedScenes 工具面，排程三件套走 butler_confirm 结构化确认卡）
 * `source` 自此只决定线程 TTL：'wechat' 24 小时过期 / 'panel' 长期保留（threads.ts）。
 */
export interface ButlerTurnOptions {
  baseUrl?: string;
  reuseThreadId?: string | null;
  threadIdHint?: string;
  source?: ButlerThreadSource;
  /**
   * 通道能力标记（**与会话 source 解耦**：source 只管 TTL，channel 管工具面/权限分档）。
   * 微信桥固定落「通知助理」常驻线程时 source='notify'（长期保留）但 channel 仍须为 'wechat'
   * （写类按 WECHAT_ALLOWED_WRITES 白名单收口）——所以这里必须能显式指定，不能只看 source。
   * 缺省（undefined）= 按 source 推导，保留既有语义（wechat → 'wechat'，其余 → 'panel'）。
   */
  channel?: 'panel' | 'wechat' | 'feishu';
  /** B5「中途改」：外部打断信号。用户在上一条还没答完时又发了一条 → 调用方 abort，
   *  本次上游请求立刻中止，不写线程、不回执（重跑的那次负责回执）。 */
  signal?: AbortSignal;
  /**
   * 本轮使用的模型（`provider:modelId` 标签）：抽屉模型下拉传当前选择，**null = 明确回到自动**。
   * undefined（微信桥等不带选型的老调用方）= 沿用线程里存的选择。
   */
  modelId?: string | null;
  /** 本轮模型凭据（渲染进程明文透传；缺省 = 服务端按 modelId 自行解析设置文件）。 */
  modelCredential?: ButlerModelCredential | null;
  /** 本轮思考档位：抽屉传当前选择；undefined = 沿用线程选择，再回退历史默认 medium（语义同 high）。 */
  thinkingLevel?: ThinkingLevel | null;
}

/**
 * 向 /chat 提问（Butler 聚合入口）：
 *   - opts.reuseThreadId: 调用方指定的复用 threadId（桌面续聊）→ 复用该线程历史；
 *   - opts.threadIdHint: 调用方传入的权威 Butler 线程 ID（续聊优先）；
 *   - opts.source: 'panel'（长期保留）| 'wechat'（24 小时过期）| 'notify'（常驻）。
 *
 * 返回 { reply, messages, threadId }：threadId 为本次落点，供调用方记录（如微信桥固定落常驻线程）。
 */
export async function askButler(
  question: string,
  opts: ButlerTurnOptions = {},
): Promise<{ ok: boolean; reply: string; messages?: ChatMessage[]; threadId: string; aborted?: boolean }> {
  const source: ButlerThreadSource = opts.source ?? 'panel';
  const base = opts.baseUrl ? opts.baseUrl.replace(/\/$/, '') : '';
  // channel 是**通道能力**标记（非身份，且与 source 解耦——source 只管线程 TTL：panel 长期 /
  // wechat 24h；抽屉必须用 panel 才不会过期，切忌由 source 反推 channel）。
  // askButler 是聚合 API（把上游 SSE 读到流结束才回一句 JSON），调用方拿不到 butler_confirm /
  // questions_request / tool_confirm 这类挂起帧 → route 据此不登记挂起（否则空等 CONFIRM_TIMEOUT_MS
  // 十分钟）。写类权限按通道分档：微信 = WECHAT_ALLOWED_WRITES 白名单（排程三件套 + 便签），
  // 其它聚合通道保持只读。
  // Butler 抽屉不走这里：它走 streamButlerTurn（stream:true），那条链路**不传 channel** —— 属
  // 「可弹卡链路」，三类挂起由抽屉自渲染（ButlerDrawer / L645 / L652 / L666），写类不受聚合收口限制。
  // 故下面由 source 推导出的 'panel' 分支当前**不可达**（本路径仅剩微信桥一个调用方）；保留该分支只为语义完整。
  // 微信桥固定落常驻线程 → source='notify'（长期）但 channel 仍须 'wechat'，故显式入参优先。
  const channel = opts.channel ?? (source === 'wechat' ? ('wechat' as const) : ('panel' as const));

  // 1. 决定 threadId：显式 hint > reuseThreadId；复用目标不存在/已过期则视为新线程
  const hint = opts.threadIdHint;
  let threadId = hint || opts.reuseThreadId || null;
  let thread = threadId ? await readThread(threadId) : null;
  if (threadId && !thread && !hint) {
    // reuseThreadId 是「尽量复用」：线程缺失（wechat 24h 过期被清 / 从未落盘）→ 退化为新线程。
    // threadIdHint 则相反，是调用方指定的**权威**落点（如微信桥固定落常驻线程）：
    // 即便线程尚未落盘（首次微信消息、桌面还没拉过联系人列）也必须按它建，否则会漏进随机新线程。
    threadId = null;
  }
  if (!threadId) {
    threadId = generateThreadId();
    thread = null;
  }

  // 2. 组装消息：恒为管家居画像 → 一律剥离历史里的 system。历史可能残留旧版沙盒提示
  //    （「只读问答」），带上会让模型自称不能写、与真实工具面矛盾；系统提示统一由 route
  //    按已装 butler 画像注入。
  const history = thread?.messages ?? [];
  const baseMessages: ChatMessage[] = history.filter((m) => m.role !== 'system');
  const messages: ChatMessage[] = [...baseMessages, { role: 'user', content: question }];

  // 3. 调 /api/chat：恒传 identity='butler' + 显式 projectId —— 与 streamButlerTurn 同源同序，
  //    避免上下文注入「当前没有激活项目」而工具实际作用于当前项目的错位。
  //    会话级选型（模型 / 思考档位）：本轮传了用本轮，否则用会话存的，最后回退历史默认。
  const modelTag = parseModelTag(opts.modelId) ?? thread?.modelId ?? null;
  const level: ThinkingLevel = parseThinkingLevel(opts.thinkingLevel) ?? thread?.thinkingLevel ?? 'medium';
  const model = await resolveButlerModel(modelTag, opts.modelCredential);
  const projectId = await resolveActiveProjectId();
  const ac = new AbortController();
  const timeoutTimer = setTimeout(() => ac.abort(new Error('请求超时（180 秒），请稍后重试或简化问题')), 180_000);
  // B5「中途改」：把外部打断信号并到本地 controller 上（本地还要负责 180s 超时，不能直接透传）
  const onExternalAbort = () => ac.abort(new Error('已打断：你发送了新的一条，按新要求重跑'));
  if (opts.signal) {
    if (opts.signal.aborted) onExternalAbort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const chatResp = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        messages,
        nodeId: BUTLER_PLACEHOLDER_NODE_ID,
        // 会话身份（2026-10-02）：nodeId 是占位符，**真正的会话是 threadId**。
        // 带上它 route 才能把记忆来源写成 chat:<threadId>，并让规则预算按会话分片。
        threadId,
        thinkingLevel: level,
        // 恒为管家身份（完整画像 + fixedScenes 工具面）；channel 标记聚合链路
        // （wechat / panel：route 据此不登记挂起，写类权限按通道分档，见上）。
        // 桌面抽屉的流式链路走 streamButlerTurn（identity='butler'，无 channel，带确认卡链路）。
        identity: 'butler',
        channel,
        // 会话级人设（该线程建过才带）：route 在 Butler 通道里以「覆盖」语义注入系统提示
        ...(thread?.persona ? { persona: thread.persona } : {}),
        ...(projectId ? { projectId } : {}),
        ...(model.custom
          ? { apiKey: model.apiKey, baseUrl: model.baseUrl, providerModelId: model.providerModelId }
          : { modelId: model.modelId }),
      }),
    });
    clearTimeout(timeoutTimer);

    if (!chatResp.ok) {
      let errText = '';
      try { errText = (await chatResp.json()).error || ''; } catch { /* 非 JSON */ }
      return { ok: false, reply: errText || `节点请求失败（HTTP ${chatResp.status}）`, threadId };
    }

    const raw = await chatResp.text();
    const ct = chatResp.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try {
        const jsonErr = JSON.parse(raw);
        return {
          ok: false,
          reply: (jsonErr.error || jsonErr.message || jsonErr.reply || '服务端错误') as string,
          threadId,
        };
      } catch {
        // 解析失败：继续走 SSE 兜底
      }
    }

    // 4. 聚合 SSE 流：拼接 content + reasoning（用 <think> 包裹在前面，避免思考丢失）
    let answer = '';
    let reasoning = '';
    for (const chunk of raw.split('\n\n')) {
      const line = chunk.trim();
      if (!line.startsWith('data:')) continue;
      try {
        const data = JSON.parse(line.slice(5).trim());
        if (data.error) {
          return { ok: false, reply: String(data.error), threadId };
        }
        if (typeof data.reasoning === 'string' && data.reasoning) reasoning += data.reasoning;
        if (typeof data.content === 'string') answer += data.content;
      } catch {
        // 忽略无法解析的 chunk
      }
    }
    const thinkWrapped = reasoning ? `<think>${reasoning}</think>\n` : '';
    const combinedAnswer = thinkWrapped + answer;

    if (!combinedAnswer.trim()) {
      return { ok: false, reply: '节点未返回有效内容，请重试', threadId };
    }

    // 5. 写回线程存储（panel 长期；wechat 24 小时过期），连续提问保持上下文
    const fullMessages = trimThreadMessages([
      ...messages,
      { role: 'assistant' as const, content: combinedAnswer },
    ]);
    try {
      // 选型随会话落盘：下一轮即便调用方不带选型（微信桥）也沿用这次的选择
      await upsertThread(threadId, fullMessages, source, { modelId: modelTag, thinkingLevel: level });
    } catch (e) {
      console.warn('[butler/threads] 线程写入失败（不影响回复）:', e instanceof Error ? e.message : String(e));
    }

    return { ok: true, reply: combinedAnswer, messages: fullMessages, threadId };
  } catch (e) {
    // B5「中途改」：主动打断不算失败——重跑的那次会回执，本次缄默（否则用户会先收到一条❌）
    if (opts.signal?.aborted) {
      return { ok: false, aborted: true, reply: '', threadId };
    }
    if (e instanceof Error) {
      if (e.name === 'AbortError') {
        return { ok: false, reply: e.message || '请求超时，请稍后重试', threadId };
      }
      return { ok: false, reply: e.message || String(e) || '网络错误', threadId };
    }
    return { ok: false, reply: String(e) || '网络错误', threadId };
  } finally {
    clearTimeout(timeoutTimer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Butler 抽屉（悬浮球）流式问答 —— SSE 透传版。
 *
 * 为什么必须流式（而不是复用 askButler 的聚合返回）：
 *   butler 画像的排程三件套会走 butler_confirm 挂起型确认卡（route.ts handleButlerCard）——
 *   服务端登记挂起项后 **SSE 连接保持打开并等待用户确认**（最长 CONFIRM_TIMEOUT_MS）。
 *   聚合版会一直读到流结束才返回，卡片事件永远到不了前端 → 必然是「转圈到超时」。
 *   因此这里把上游 SSE 原样透传给调用方，前端边读边渲染，并在读到 butler_confirm 时弹可编辑卡片。
 *
 * 职责：
 *   1. threadId 决议 / 消息组装 / 模型解析 与 askButler 同源同序（身份统一为 identity='butler'）；
 *   2. 首帧注入 `{ threadId }`（聚合版由 JSON 体返回，流式版需显式告知，供前端续聊复用）；
 *   3. 透传上游所有帧（content / reasoning / butler_confirm / tool_result / 心跳…），
 *      同时在服务端累积 content+reasoning，流结束后按 trimThreadMessages 落库（panel 长期保留）。
 *
 * 失败（模型未配置 / 上游非 200）直接抛错，由调用方转成错误响应。
 */
export async function streamButlerTurn(
  question: string,
  opts: ButlerTurnOptions = {},
): Promise<Response> {
  const source: ButlerThreadSource = opts.source ?? 'panel';
  const base = opts.baseUrl ? opts.baseUrl.replace(/\/$/, '') : '';

  // 1. threadId 决议（与 askButler 同序：显式 hint > reuseThreadId；缺失/过期则新建）
  //    显式 threadIdHint 是权威落点（线程尚不存在也按它建）；reuseThreadId 才是「尽量复用」。
  const hint = opts.threadIdHint;
  let threadId = hint || opts.reuseThreadId || null;
  let thread = threadId ? await readThread(threadId) : null;
  if (threadId && !thread && !hint) threadId = null;
  if (!threadId) {
    threadId = generateThreadId();
    thread = null;
  }

  // 2. 消息组装：剥掉历史里的 system（系统提示交给 route 按 butler 画像注入）
  const history = (thread?.messages ?? []).filter((m) => m.role !== 'system');
  const messages: ChatMessage[] = [...history, { role: 'user', content: question }];

  // 3. 上游请求（身份=butler，无 sandbox → 完整工具面 + 确认卡链路）
  //    项目落点：本链路用的是**占位 nodeId**（BUTLER_PLACEHOLDER_NODE_ID）——route 的 resolveNodeProject
  //    按「显式 projectId → 用激活项目找该节点 → 遍历全部项目找该节点」定位，占位节点哪儿都不存在，
  //    于是 currentProjectPath 落空、上下文注入「当前没有激活项目：…~/BobWork/.sandbox」，
  //    Butler 便会误判"无项目 / 这条日程记为全局待办"，而排程工具内部其实写的是当前活跃项目
  //    （getCurrentProject）→ 说一套写一套。这里显式解析并传 projectId，让 route 走显式分支。
  //    会话级选型（模型 / 思考档位）同 askButler：本轮传了用本轮，否则沿用会话存的。
  const modelTag = parseModelTag(opts.modelId) ?? thread?.modelId ?? null;
  const level: ThinkingLevel = parseThinkingLevel(opts.thinkingLevel) ?? thread?.thinkingLevel ?? 'medium';
  const model = await resolveButlerModel(modelTag, opts.modelCredential);
  const projectId = await resolveActiveProjectId();
  const upstream = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      nodeId: BUTLER_PLACEHOLDER_NODE_ID,
      // 会话身份（2026-10-02）：同上——记忆来源归因与规则预算都靠它，nodeId 只是占位符
      threadId,
      thinkingLevel: level,
      identity: 'butler',
      // 会话级人设（该线程建过才带）：route 在 Butler 通道里以「覆盖」语义注入系统提示
      ...(thread?.persona ? { persona: thread.persona } : {}),
      ...(projectId ? { projectId } : {}),
      ...(model.custom
        ? { apiKey: model.apiKey, baseUrl: model.baseUrl, providerModelId: model.providerModelId }
        : { modelId: model.modelId }),
    }),
  });

  if (!upstream.ok || !upstream.body) {
    let errText = '';
    try {
      const j = (await upstream.json()) as { error?: string; message?: string };
      errText = j.error || j.message || '';
    } catch {
      errText = `节点请求失败（HTTP ${upstream.status}）`;
    }
    throw new Error(errText || `节点请求失败（HTTP ${upstream.status}）`);
  }

  const upstreamBody = upstream.body;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let pending = '';
  let answer = '';
  let reasoning = '';

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          /* 前端已断开（AbortController）→ 忽略，服务端仍继续读上游以完成落库 */
        }
      };
      // 首帧告知 threadId（前端续聊复用）
      send(`data: ${JSON.stringify({ threadId })}\n\n`);

      const reader = upstreamBody.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            // 先透传原始字节（保真：心跳/未知帧原样到前端），再在服务端副本上累积正文
            try {
              controller.enqueue(value);
            } catch {
              /* 前端断开 */
            }
            pending += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = pending.indexOf('\n\n')) >= 0) {
              const frame = pending.slice(0, idx);
              pending = pending.slice(idx + 2);
              for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue;
                try {
                  const d = JSON.parse(line.slice(5).trim()) as { content?: string; reasoning?: string };
                  if (typeof d.reasoning === 'string' && d.reasoning) reasoning += d.reasoning;
                  if (typeof d.content === 'string') answer += d.content;
                } catch {
                  /* 非 JSON 帧（心跳/注释）忽略 */
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn('[butler/entry] 上游读取中断:', e instanceof Error ? e.message : String(e));
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
        // 4. 落库（流已结束）：与聚合版同格式（reasoning 用 <think> 包裹），供下轮续聊保持上下文
        const thinkWrapped = reasoning ? `<think>${reasoning}</think>\n` : '';
        const combined = thinkWrapped + answer;
        if (combined.trim()) {
          try {
            await upsertThread(
              threadId,
              trimThreadMessages([...messages, { role: 'assistant' as const, content: combined }]),
              source,
              // 选型随会话落盘（与 askButler 同口径）：下一轮调用方不带选型也沿用这次的选择
              { modelId: modelTag, thinkingLevel: level },
            );
          } catch (e) {
            console.warn('[butler/threads] 线程写入失败（不影响回复）:', e instanceof Error ? e.message : String(e));
          }
        }
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}