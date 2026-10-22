/**
 * iframe 宿主桥回归（2026-10-10 方案 B）。
 *
 * 锁三件事：
 *   1) 消息分发：bob_request → 宿主请求 → bob_response；失败回 error；
 *   2) 流式：bob_chat_stream 的 delta/done、bob_chat_cancel 的 abort、并发上限；
 *   3) 安全前提：预览 iframe 必须带 sandbox 但**不得**带 allow-same-origin；
 *      注入脚本必须只接受父窗口消息、且在 opaque origin 下有 localStorage 退路。
 */
import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { handleIframeMessage, type IframeBridgeDeps } from '@/lib/sandbox/iframe-bridge-host';
import { buildBridgeClientScript } from '@/lib/sandbox/bridge';

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeDeps(overrides?: Partial<IframeBridgeDeps>) {
  const posted: unknown[] = [];
  const abort = vi.fn();
  const deps: IframeBridgeDeps = {
    post: (m) => posted.push(m),
    request: vi.fn(async () => ({ ok: 1 })),
    chatStream: (_data, onDelta) => {
      onDelta('a');
      onDelta('b');
      return { promise: Promise.resolve({ model: 'x' }), abort };
    },
    ...overrides,
  };
  return { deps, posted, abort };
}

describe('iframe 宿主桥 · 消息分发', () => {
  it('bob_request → 宿主请求 → bob_response(success)', async () => {
    const { deps, posted } = makeDeps();
    const streams = new Map<string, { abort: () => void }>();
    const handled = handleIframeMessage({ type: 'bob_request', id: 'r1', action: 'getTheme', data: { _appId: 'app_x_1' } }, deps, streams);
    expect(handled).toBe(true);
    await flush();
    expect(deps.request).toHaveBeenCalledWith('getTheme', { _appId: 'app_x_1' });
    expect(posted[0]).toEqual({ type: 'bob_response', id: 'r1', success: true, data: { ok: 1 } });
  });

  it('宿主请求失败 → bob_response(success:false, error)', async () => {
    const { deps, posted } = makeDeps({ request: async () => { throw new Error('mini-program not found'); } });
    handleIframeMessage({ type: 'bob_request', id: 'r2', action: 'getTheme', data: {} }, deps, new Map());
    await flush();
    expect(posted[0]).toEqual({ type: 'bob_response', id: 'r2', success: false, error: 'mini-program not found' });
  });

  it('缺 id/action 与未知类型都不处理', () => {
    const { deps } = makeDeps();
    const streams = new Map<string, { abort: () => void }>();
    expect(handleIframeMessage({ type: 'bob_request', id: '', action: 'x' }, deps, streams)).toBe(false);
    expect(handleIframeMessage({ type: 'bob_other' }, deps, streams)).toBe(false);
    expect(handleIframeMessage(null, deps, streams)).toBe(false);
  });

  it('bob_console → onConsole 收到归一化消息，不执行业务请求', () => {
    const onConsole = vi.fn();
    const { deps } = makeDeps({ onConsole });
    const handled = handleIframeMessage(
      { type: 'bob_console', appId: 'app_x_1', msgs: [{ level: 'error', text: 'boom' }, { level: 'warn', text: 'hmm' }] },
      deps,
      new Map(),
    );
    expect(handled).toBe(true);
    expect(onConsole).toHaveBeenCalledWith([
      { level: 'error', text: 'boom' },
      { level: 'warn', text: 'hmm' },
    ]);
    expect(deps.request).not.toHaveBeenCalled();
  });

  it('bob_ready → onReady（宿主用于加载态/错误态判定）', () => {
    const onReady = vi.fn();
    const { deps } = makeDeps({ onReady });
    expect(handleIframeMessage({ type: 'bob_ready', appId: 'app_x_1' }, deps, new Map())).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(deps.request).not.toHaveBeenCalled();
  });

  it('bob_local_storage_set → onLocalStorage（value=null 表示删除）', () => {
    const onLocalStorage = vi.fn();
    const { deps } = makeDeps({ onLocalStorage });
    expect(handleIframeMessage({ type: 'bob_local_storage_set', key: 'bob_sb_app_x_1_theme', value: 'dark' }, deps, new Map())).toBe(true);
    expect(handleIframeMessage({ type: 'bob_local_storage_set', key: 'bob_sb_app_x_1_theme', value: null }, deps, new Map())).toBe(true);
    expect(onLocalStorage).toHaveBeenNthCalledWith(1, 'bob_sb_app_x_1_theme', 'dark');
    expect(onLocalStorage).toHaveBeenNthCalledWith(2, 'bob_sb_app_x_1_theme', null);
    expect(deps.request).not.toHaveBeenCalled();
  });
});

describe('iframe 宿主桥 · 流式与取消', () => {
  it('bob_chat_stream → delta* + done，并清理 streams', async () => {
    const { deps, posted } = makeDeps();
    const streams = new Map<string, { abort: () => void }>();
    handleIframeMessage({ type: 'bob_chat_stream', id: 's1', data: { appId: 'app_x_1' } }, deps, streams);
    expect(streams.size).toBe(1);
    await flush();
    expect(posted).toEqual([
      { type: 'bob_chat_delta', id: 's1', text: 'a' },
      { type: 'bob_chat_delta', id: 's1', text: 'b' },
      { type: 'bob_chat_done', id: 's1', data: { model: 'x' } },
    ]);
    expect(streams.size).toBe(0);
  });

  it('bob_chat_cancel → 调用 abort', () => {
    const { deps, abort } = makeDeps();
    const streams = new Map<string, { abort: () => void }>();
    handleIframeMessage({ type: 'bob_chat_stream', id: 's2', data: {} }, deps, streams);
    handleIframeMessage({ type: 'bob_chat_cancel', id: 's2' }, deps, streams);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(streams.has('s2')).toBe(false);
  });

  it('并发上限（>4 路）→ bob_chat_error，不再新开流', () => {
    const { deps, posted } = makeDeps({ chatStream: () => ({ promise: new Promise(() => {}), abort: () => {} }) });
    const streams = new Map<string, { abort: () => void }>();
    for (let i = 0; i < 5; i++) handleIframeMessage({ type: 'bob_chat_stream', id: `s${i}`, data: {} }, deps, streams);
    expect(posted).toContainEqual({ type: 'bob_chat_error', id: 's4', error: 'too many concurrent streams' });
  });
});

describe('graph* 走宿主画布（方案 B 收尾）', () => {
  it('graph 动作路由到注入的执行器，不回落到 HTTP 中继', async () => {
    const graph = vi.fn(async () => ({ success: true, data: { nodes: [], edges: [] } }));
    const { deps, posted } = makeDeps({ graph });
    handleIframeMessage({ type: 'bob_request', id: 'g1', action: 'graphGetSnapshot', data: {} }, deps, new Map());
    await flush();
    expect(graph).toHaveBeenCalledWith('graphGetSnapshot', {});
    expect(deps.request).not.toHaveBeenCalled();
    expect(posted[0]).toEqual({ type: 'bob_response', id: 'g1', success: true, data: { nodes: [], edges: [] } });
  });

  it('执行器返回失败 → bob_response(success:false, error)', async () => {
    const graph = vi.fn(async () => ({ success: false, error: 'Graph access denied: not granted.' }));
    const { deps, posted } = makeDeps({ graph });
    handleIframeMessage({ type: 'bob_request', id: 'g2', action: 'graphExpandNode', data: { nodeId: 'n1' } }, deps, new Map());
    await flush();
    expect(posted[0]).toEqual({ type: 'bob_response', id: 'g2', success: false, error: 'Graph access denied: not granted.' });
  });

  it('没有画布宿主（Hippo 顶层页）时给出明确错误，而不是 Unknown action', async () => {
    const { deps, posted } = makeDeps();
    handleIframeMessage({ type: 'bob_request', id: 'g3', action: 'graphGetPermission', data: {} }, deps, new Map());
    await flush();
    const msg = posted[0] as { success: boolean; error: string };
    expect(msg.success).toBe(false);
    expect(msg.error).toContain('in-app canvas host');
  });

  it('注入脚本在独立页仍直接拒绝 graph*（顶层页没有画布）', () => {
    const script = buildBridgeClientScript('app_g_1', { fullTrust: true });
    expect(script).toContain('不支持画布对接操作');
  });
});

describe('方案 B 的安全前提（源码级守卫）', () => {
  it('预览 iframe 带 sandbox 但不带 allow-same-origin', () => {
    const src = readFileSync(new URL('../../components/canvas/SandboxPreviewFrame.tsx', import.meta.url), 'utf-8');
    // 只对**属性值**断言（注释里会提到 allow-same-origin，那是解释"不给它"）
    const sandboxAttr = /sandbox="([^"]*)"/.exec(src)?.[1] ?? '';
    expect(sandboxAttr).toContain('allow-scripts');
    expect(sandboxAttr).not.toContain('allow-same-origin');
    expect(sandboxAttr).not.toContain('allow-top-navigation');
    // 预览必须从"另一个回环 origin"加载（方案 A），不能是宿主的相对路径
    expect(src).toContain('previewOriginFor(window.location.origin)');
    // 宿主桥必须在 iframe 进入文档后挂载（曾写成只依赖 useEffect，iframe 还没渲染 → 监听器永不注册，
    // 真实浏览器 E2E 表现为小程序所有请求 10s 超时）
    expect(src).toContain('onLoad={attachBridge}');
  });

  it('注入脚本：只接受父窗口消息 + opaque origin 下的存储退路 + iframe 模式 targetOrigin', () => {
    const script = buildBridgeClientScript('app_b_1', { fullTrust: true });
    expect(script).toContain('function isFromParent(event)');
    expect(script).toContain('var IN_IFRAME = (window.parent !== window);');
    expect(script).toContain("var HOST_TARGET_ORIGIN = IN_IFRAME ? '*' : resolveTargetOrigin();");
    expect(script).toContain('var LS = {');
    expect(script).toContain('memoryStore[k] = s');
    expect(script).toContain('HOST_LOCAL_SNAPSHOT');
    expect(script).toContain('bob_local_storage_set');
    // 身份令牌：每个请求都带 _appToken（服务端据此判定"是谁在调用"，不再信任自报 appId）
    expect(script).toContain("querySelector('meta[name=\"bob-app-token\"]')");
    expect(script).toContain('if (APP_TOKEN) data._appToken = APP_TOKEN;');
    expect(script).toContain('_appToken: APP_TOKEN');
  });
});
