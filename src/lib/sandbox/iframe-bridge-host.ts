'use client';

/**
 * iframe 宿主桥（2026-10-10 方案 B）—— 把「应用内沙箱预览」的小程序请求接到宿主。
 *
 * 背景：预览原先只在 Hippo 顶层页打开，桥走**同源 HTTP 中继**；`bob_request`/`bob_response`
 * 这套 postMessage 协议虽然早就写在注入脚本里，但宿主侧**从来没有监听器**（死代码）。
 * 方案 B 把预览放进 `<iframe sandbox="allow-scripts …">`（不给 `allow-same-origin`）：
 *   - iframe 的 origin 是 opaque（读不到宿主 localStorage / Cookie，跨源 fetch 需预检）；
 *   - 小程序的一切宿主调用只能走 postMessage → 宿主成为唯一裁判。
 *
 * 本模块只负责「消息 → 宿主请求 → 回消息」，UI 壳见 SandboxPreviewFrame.tsx。
 * 依赖以参数注入，纯逻辑可单测（`handleIframeMessage`）。
 */

export interface IframeBridgeDeps {
  /** 普通桥动作：等价于 POST /api/sandbox/bridge */
  request: (action: string, data: Record<string, unknown>) => Promise<unknown>;
  /** 流式模型调用：等价于 POST /api/sandbox/chat-stream（SSE） */
  chatStream: (
    data: Record<string, unknown>,
    onDelta: (text: string) => void,
  ) => { promise: Promise<unknown>; abort: () => void };
  /** 向 iframe 回消息（宿主侧固定用 '*'：opaque origin 无法作为 targetOrigin） */
  post: (msg: unknown) => void;
  /**
   * graph* 动作的执行器（2026-10-10 方案 B 收尾）：画布就在宿主进程里，**不能**走 HTTP 中继。
   * 由 CanvasFlow 用 `executeGraphBridgeAction(action, data, { appId, gateway, requestPermission })` 提供。
   * 未注入时 graph 动作返回明确错误（提示必须在 BobWork 内的预览里调用）。
   */
  graph?: (action: string, data: Record<string, unknown>) => Promise<{ success: boolean; data?: unknown; error?: string }>;
  /** 预览页 console 上报（bob_console）：error/warn 胶囊与「Fix with AI」的数据源 */
  onConsole?: (msgs: PreviewConsoleMessage[]) => void;
  /** 预览页 bridge 已注入并启动（bob_ready）：宿主据此区分“加载成功”与 403/白屏/错误页 */
  onReady?: () => void;
  /** Layer-1（BobStorage.set/get）写入：应用内 iframe 无 localStorage，由宿主持久化 */
  onLocalStorage?: (key: string, value: string | null) => void;
  log?: (message: string, extra?: unknown) => void;
}

/** 预览页 console 上报的单条消息（由 buildConsoleCaptureInjection 产出） */
export interface PreviewConsoleMessage {
  level: string;
  text: string;
}

export interface HostBridgeHandle {
  appId: string;
  dispose: () => void;
}

const MAX_STREAMS = 4;

/** 纯逻辑：处理一条来自 iframe 的消息（返回值仅用于测试：是否被处理） */
export function handleIframeMessage(
  raw: unknown,
  deps: IframeBridgeDeps,
  streams: Map<string, { abort: () => void }>,
): boolean {
  const msg = raw as { type?: string; id?: string; action?: string; data?: Record<string, unknown>; msgs?: unknown; key?: unknown; value?: unknown } | null;
  if (!msg || typeof msg.type !== 'string') return false;

  // 预览页 bridge 启动完成：用于宿主加载态/错误态判定，不执行业务动作
  if (msg.type === 'bob_ready') {
    deps.onReady?.();
    return true;
  }

  // Layer-1 持久化：子页没有 localStorage，写操作交给宿主落盘（value=null 表示删除）
  if (msg.type === 'bob_local_storage_set') {
    const key = typeof msg.key === 'string' ? msg.key : '';
    if (!key || key.length > 300) return true;
    const value = msg.value === null ? null : typeof msg.value === 'string' ? msg.value : null;
    deps.onLocalStorage?.(key, value);
    return true;
  }

  // 预览页 console 上报：不执行业务动作，只转交宿主 UI（错误胶囊 / Fix with AI）
  if (msg.type === 'bob_console') {
    if (!Array.isArray(msg.msgs) || msg.msgs.length === 0) return true;
    const msgs: PreviewConsoleMessage[] = msg.msgs.slice(0, 50).map((item) => {
      const o = item as { level?: unknown; text?: unknown } | null;
      return {
        level: typeof o?.level === 'string' ? o.level.slice(0, 20) : 'error',
        text: typeof o?.text === 'string' ? o.text.slice(0, 500) : String(item).slice(0, 500),
      };
    });
    deps.onConsole?.(msgs);
    return true;
  }

  if (msg.type === 'bob_request') {
    const id = String(msg.id ?? '');
    const action = String(msg.action ?? '');
    if (!id || !action) return false;
    const data = (msg.data && typeof msg.data === 'object' ? msg.data : {}) as Record<string, unknown>;

    // graph* 由宿主进程内的 GraphGateway 执行（画布状态在渲染进程里，HTTP 中继够不着）
    if (action.startsWith('graph')) {
      if (!deps.graph) {
        deps.post({
          type: 'bob_response',
          id,
          success: false,
          error: 'graph actions require the in-app canvas host — open this mini-program via "Preview" inside BobWork (not the Hippo window)',
        });
        return true;
      }
      deps.graph(action, data)
        .then((r) => deps.post(
          r.success
            ? { type: 'bob_response', id, success: true, data: r.data }
            : { type: 'bob_response', id, success: false, error: r.error || 'graph error' },
        ))
        .catch((e: unknown) => deps.post({
          type: 'bob_response',
          id,
          success: false,
          error: e instanceof Error ? e.message : String(e),
        }));
      return true;
    }

    deps.request(action, data)
      .then((result) => deps.post({ type: 'bob_response', id, success: true, data: result }))
      .catch((e: unknown) => deps.post({
        type: 'bob_response',
        id,
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    return true;
  }

  if (msg.type === 'bob_chat_stream') {
    const id = String(msg.id ?? '');
    if (!id) return false;
    if (streams.size >= MAX_STREAMS) {
      deps.post({ type: 'bob_chat_error', id, error: 'too many concurrent streams' });
      return true;
    }
    const data = (msg.data && typeof msg.data === 'object' ? msg.data : {}) as Record<string, unknown>;
    // 宿主侧兜底（小程序可能不传）：两者都走同一个鉴权/审计闸
    const handle = deps.chatStream(data, (text) => deps.post({ type: 'bob_chat_delta', id, text }));
    streams.set(id, { abort: handle.abort });
    handle.promise
      .then((meta) => deps.post({ type: 'bob_chat_done', id, data: meta ?? {} }))
      .catch((e: unknown) => deps.post({
        type: 'bob_chat_error',
        id,
        error: e instanceof Error ? e.message : String(e),
      }))
      .finally(() => streams.delete(id));
    return true;
  }

  if (msg.type === 'bob_chat_cancel') {
    const id = String(msg.id ?? '');
    const s = streams.get(id);
    if (s) {
      s.abort();
      streams.delete(id);
    }
    return true;
  }

  return false;
}

/** 默认依赖：直接走宿主同源 HTTP（与注入脚本的 standalone 中继同一套端点） */
export function defaultIframeBridgeDeps(iframe: HTMLIFrameElement): IframeBridgeDeps {
  const post = (msg: unknown) => {
    try {
      iframe.contentWindow?.postMessage(msg, '*');
    } catch {
      /* iframe 已卸载 */
    }
  };
  return {
    post,
    request: async (action, data) => {
      const resp = await fetch('/api/sandbox/bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, data }),
      });
      const json = (await resp.json().catch(() => null)) as
        | { success?: boolean; data?: unknown; error?: string }
        | null;
      if (!resp.ok && !json?.error) throw new Error(`bridge HTTP ${resp.status}`);
      if (!json?.success) throw new Error(json?.error || `bridge error: ${action}`);
      return json.data;
    },
    chatStream: (data, onDelta) => {
      const ctrl = new AbortController();
      const promise = (async () => {
        const resp = await fetch('/api/sandbox/chat-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
          signal: ctrl.signal,
        });
        if (!resp.ok) {
          const j = (await resp.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error || `chat-stream HTTP ${resp.status}`);
        }
        if (!resp.body) throw new Error('chat-stream not readable');
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let meta: unknown = {};
        for (;;) {
          const step = await reader.read();
          if (step.done) break;
          buf += decoder.decode(step.value, { stream: true });
          const LF = String.fromCharCode(10);
          let sep = buf.indexOf(LF + LF);
          while (sep >= 0) {
            const chunk = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            let ev = '';
            let dt = '';
            for (const line of chunk.split(LF)) {
              if (line.startsWith('event:')) ev = line.slice(6).trim();
              else if (line.startsWith('data:')) dt = line.slice(5).trim();
            }
            if (dt) {
              try {
                const parsed = JSON.parse(dt) as { text?: string };
                if (ev === 'delta' && typeof parsed.text === 'string') onDelta(parsed.text);
                else if (ev === 'done') meta = parsed;
              } catch {
                /* 跳过坏帧 */
              }
            }
            sep = buf.indexOf(LF + LF);
          }
        }
        return meta;
      })();
      return { promise, abort: () => { try { ctrl.abort(); } catch { /* ignore */ } } };
    },
  };
}

/**
 * 挂到真实 iframe：只接受**来自该 iframe** 的消息（`event.source === iframe.contentWindow`）。
 * sandbox iframe 的 origin 是 'null'，不能靠 origin 判定 —— source 才是可靠判据。
 */
export function attachIframeBridgeHost(
  iframe: HTMLIFrameElement,
  appId: string,
  overrides?: Partial<IframeBridgeDeps>,
): HostBridgeHandle {
  const deps: IframeBridgeDeps = { ...defaultIframeBridgeDeps(iframe), ...overrides };
  const streams = new Map<string, { abort: () => void }>();

  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data as { type?: string } | null;
    if (!msg || typeof msg.type !== 'string') return;
    if (!msg.type.startsWith('bob_')) return;
    const handled = handleIframeMessage(msg, deps, streams);
    if (!handled && msg.type !== 'bob_soft_reload_ack') {
      deps.log?.('[iframe-bridge] 未处理的消息', msg.type);
    }
  };
  window.addEventListener('message', onMessage);

  return {
    appId,
    dispose: () => {
      window.removeEventListener('message', onMessage);
      for (const s of streams.values()) s.abort();
      streams.clear();
    },
  };
}
