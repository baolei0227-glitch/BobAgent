/**
 * Bob Sandbox postMessage Bridge
 *
 * Allows mini-apps running in the sandbox preview to call BobWork host APIs.
 * 2026-10-10「放开小程序权限」：小程序已是宿主一等公民——
 *   - 模型调用不再需要授权申请（完全信任默认放开，仅显式 Revoke 才拒）；
 *   - 桥的人工确认动作（chatRequestPermission / graphRequestPermission / writeWanted）不再弹窗；
 *   - 新增 hostTool / listHostTools：直通宿主工具注册表**全部**工具（与画布 AI Agent 同权）。
 * 保留的硬护栏（与"完全信任"不冲突，仍必须存在）：
 *   - butler/ 真源文件不可被小程序覆盖（bridge-guards）
 *   - 每次桥调用落 bob-sandbox/audit.log 审计
 *   - graph* 动作用户侧仍需画布宿主在线（Hippo 顶层页天然没有画布，友好拒绝）
 *
 * Protocol:
 *   App → Host:  { type: 'bob_request',  id, action, data }
 *   Host → App:  { type: 'bob_response', id, success, data?, error? }
 *
 * Storage layers (exposed via injected window.BobStorage):
 *   1. BobStorage.set/get  →  browser localStorage, auto-prefixed with APP_ID
 *   2. BobStorage.save/load → ~/BobWork/bob-sandbox/apps/<APP_ID>/data/<key>.json  (disk, survives restart)
 *   3. BobStorage.writeWanted → ~/BobWork/butler/  (global delivery)
 */

import { join } from 'path';
import { promises as fs } from 'fs';
import { z } from 'zod';
import { resolveAppRoot, BOB_SANDBOX_DIRNAME, LOGS_DIRNAME } from '@/lib/app-root';
import { PLATFORM } from '@/lib/platform';
import { getCurrentProject, type ProjectConfig } from '@/lib/project/project-manager';
import { findNodeFileById, parseNodeMarkdown } from '@/lib/node-markdown';
import { GRAPH_BRIDGE_ACTIONS } from '@/lib/graph/graph-bridge';
import { getSandboxChatPermissionServer } from '@/lib/settings-server';
import { executeSandboxChat, type SandboxChatMessage } from '@/lib/sandbox/chat-bridge';
import { callNotes, renderNotesText } from '@/lib/mcp/notes-bridge';
import { isProtectedButlerFile } from './bridge-guards';
import { sanitizeAppId, appExists, appOriginOf } from './apps';
import { runHostTool, listHostTools } from './host-tools';

// ==================== Type Definitions ====================

export interface BridgeActionDef {
  action: string;
  description: string;
  params?: string[];
  returns?: string;
}

export interface BridgeRequest {
  type: 'bob_request';
  id: string;
  action: string;
  data: Record<string, unknown>;
}

export interface BridgeResponse {
  type: 'bob_response';
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** 设置中 provider.selectedModels 的条目形态（兼容历史 string 与对象两种存储） */
interface SelectedModelEntry {
  modelId?: string;
  label?: string;
  supportsVision?: boolean;
}

// ==================== Whitelist ====================

export const BRIDGE_ACTIONS: BridgeActionDef[] = [
  {
    action: 'listActions',
    description: 'List all available bridge actions and their parameters',
    returns: 'BridgeActionDef[]',
  },
  {
    action: 'listNodes',
    description: 'List all nodes in the current project',
    returns: 'Array<{ nodeId, title, updatedAt }>',
  },
  {
    action: 'readNode',
    description: 'Read a node content by its node ID',
    params: ['nodeId:string'],
    returns: '{ nodeId, title, summary, content }',
  },
  {
    action: 'writeWanted',
    description: 'Write a file to the global butler/ directory',
    params: ['filename:string', 'content:string'],
    returns: '{ path }',
  },
  {
    action: 'getProjectInfo',
    description: 'Get current project metadata',
    returns: '{ id, name, path }',
  },
  {
    action: 'getTheme',
    description: 'Get current theme info: themeId, themeName, dark flag, keyColors (primary/background/surface/text/border/muted), and full CSS variables object. Use for Canvas/Chart/SVG scenarios where CSS var() is not applicable.',
    returns: '{ themeId, themeName, dark, keyColors, variables }',
  },
  // ===== App-scoped disk persistence (BobStorage.save/load) =====
  {
    action: 'saveAppData',
    description: 'Save a JSON-serializable value to the app-private data directory on disk',
    params: ['appId:string', 'key:string', 'value:any (JSON)'],
    returns: '{ ok: true, path }',
  },
  {
    action: 'loadAppData',
    description: 'Load a previously saved value from the app-private data directory on disk',
    params: ['appId:string', 'key:string'],
    returns: 'any (parsed JSON) or null if key missing',
  },
  {
    action: 'listAppDataKeys',
    description: 'List all keys stored in the app-private data directory on disk',
    params: ['appId:string'],
    returns: 'string[]',
  },
  {
    action: 'deleteAppData',
    description: 'Delete a key from the app-private data directory on disk',
    params: ['appId:string', 'key:string'],
    returns: '{ ok: true, deleted: bool }',
  },
  // ===== GraphGateway 对接（太空舱对接协议）=====
  // 由宿主（CanvasFlow）在客户端拦截执行，需先通过 graphRequestPermission 获得授权；
  // 授权级别按 appId 存储：read = 只读，control = 可操作画布。未授权一律拒绝。
  {
    action: 'graphGetPermission',
    description: 'Query the current canvas-access permission level of this app',
    returns: '{ level: "none" | "read" | "control" }',
  },
  {
    action: 'graphRequestPermission',
    description: 'Request canvas-access permission from the user (docking protocol)',
    params: ['level:"read"|"control"'],
    returns: '{ level: granted level ("none" if rejected) }',
  },
  {
    action: 'graphGetSnapshot',
    description: 'Read canvas snapshot: nodes, edges (requires read)',
    returns: 'GraphSnapshot',
  },
  {
    action: 'graphExpandNode',
    description: 'Expand a node container (requires control)',
    params: ['nodeId:string'],
    returns: '{ ok: true }',
  },
  {
    action: 'graphSetNodePositions',
    description: 'Batch-set node positions, auto-layout (requires control)',
    params: ['positions:Record<nodeId,{ x, y }>'],
    returns: '{ ok: true }',
  },
  {
    action: 'graphSetNodeSelected',
    description: 'Select/deselect a node (null = clear all) (requires control)',
    params: ['nodeId:string|null'],
    returns: '{ ok: true }',
  },
  // ===== 模型调用（chat，MVP）=====
  // 无工具裸模型对话（纯文本进出）。2026-10-10 放开后默认直接可用（完全信任）；
  // 仅当 settings.json 的 sandboxChatPermissions[appId] 被显式写成 "none" 才拒绝。
  // 服务端仍强制：provider 必须已配置 apiKey + 出口审计。
  {
    action: 'chatGetPermission',
    description: 'Query whether this app is granted the model-call (chat) permission',
    returns: '{ granted: boolean }',
  },
  {
    action: 'chatRequestPermission',
    description:
      'Request model-call permission. 2026-10-10 放开后不再弹窗、也不再需要申请：无显式否决即直接授予（granted:true）。' +
      '只有当 settings.json 里 sandboxChatPermissions[appId] 被显式写成 "none" 时才返回 granted:false —— ' +
      '该档位没有应用内开关，需要改配置文件。',
    returns: '{ granted: boolean, level: "none"|"per_call"|"permanent" }',
  },
  {
    action: 'chat',
    description:
      'Call the AI model (no tools, plain text). No authorization needed (full trust). ' +
      'Params: model "provider:modelId" (required in new code; legacy calls without it fall back to the first configured model), ' +
      'messages [{role, content}], ' +
      'maxTokens (default 8192, up to 32768), temperature. ' +
      'Note: a long generation may exceed the client-side timeout — prefer BobWork.chatStream for those.',
    params: ['model:string', 'messages:Array<{role,content}>', 'maxTokens?:number', 'temperature?:number'],
    returns: '{ content, model, usage? }',
  },
  {
    action: 'chatStream',
    description:
      'Call the AI model with streaming output (no tools, plain text). Same permissions as chat. ' +
      'Use BobWork.chatStream({ model, messages, onDelta }) which resolves incrementally; ' +
      'onDelta(text) receives each text delta as it is generated.',
    params: ['model:string', 'messages:Array<{role,content}>', 'onDelta:(text)=>void', 'maxTokens?:number', 'temperature?:number'],
    returns: 'Promise<{ model, provider, usage? }> (via onDelta for incremental text)',
  },
  // ===== 宿主全能力直通（2026-10-10 放开小程序权限）=====
  // 小程序与画布节点里的 AI 同权：宿主工具注册表里的**任意**工具都能直接调用
  // （读写文件 / 列目录 / 搜索 / 跑命令与脚本 / Butler / 笔记 / 日历 / 检索 / MCP 等）。
  {
    action: 'hostTool',
    description:
      'Invoke ANY BobWork host tool by name (same registry the canvas AI agent uses): read_file, write_file, ' +
      'edit_code, list_directory, search_files, rename_file, delete_file, run_command, execute_script, web_*, ' +
      'butler_*, create_project, switch_project, notes_*, calendar_*, mcp__* … Full trust mode: no confirmation. ' +
      'Params: name (tool name), args (tool argument object). Use listHostTools to discover names + schemas.',
    params: ['name:string', 'args?:Record<string,unknown>'],
    returns: '{ success: boolean, result: string, durationMs: number }',
  },
  {
    action: 'listHostTools',
    description: 'List every host tool available to hostTool calls: name, description, category, scenes.',
    returns: 'Array<{ name, description, category, scenes }>',
  },
  // ===== Butler（亲儿子：宿主 Butler 直接读，小程序作全局信息面板）=====
  {
    action: 'readWantedTodo',
    description: 'Read the Butler to-do list (merged into the events DB). Pass optional filter: "today" / date (YYYY-MM-DD) / category. Returns markdown or null.',
    params: ['filter?:string'],
    returns: '{ content: string } or { content: null }',
  },
  {
    action: 'readWantedNotebook',
    description: 'Read entries from the personal wiki (notes/wiki/). Pass mode="full" for all entries; omit for the index (type/topics with counts).',
    params: ['mode?:"index"|"full"'],
    returns: '{ content: string }',
  },
  {
    action: 'readWantedPreferences',
    description: 'Read the full user preferences record at butler/preferences.md. Pass optional type (e.g. "output-format", "reference-spec") to filter a category.',
    params: ['type?:string'],
    returns: '{ content: string, categories: string[] }',
  },
  // ===== 节点祖先链 & 结构化目录（亲儿子：打通画布节点信息，可直接做节点导航/检索页）=====
  {
    action: 'getNodeAncestorChain',
    description: 'Return the ancestor chain (parent / block-tracker / ... → root) of the current project default (or pass projectId). Each entry { nodeId, title, summary, filePath }.',
    params: ['projectId?:string'],
    returns: 'Array<{ nodeId, title, summary, filePath }>',
  },
  {
    action: 'getNodeManifest',
    description: 'Read the structured manifest (ancestor node directory listing) of the current project. Each entry { nodeId, title, tags, depth }.',
    params: ['projectId?:string'],
    returns: 'Array<{ nodeId, title, tags: string[], depth: number }>',
  },
  // ===== 技能清单（亲儿子：决定自己需要哪些能力缺口时检索）=====
  {
    action: 'searchSkills',
    description: 'Search the local controlled skill registry for skills that match the query keywords. Up to limit (default 8) results. Each { id, name, description, category, installed, enabled }.',
    params: ['query:string', 'limit?:number'],
    returns: 'Array<{ id, name, description, category, installed: boolean, enabled: boolean }>',
  },
  {
    action: 'listConfiguredModels',
    description: 'List the model pool the user has configured (provider, modelId, description, vision support, default). Mirrors the host tool with same name; useful for AI-model selection UI. Returns { empty, models: [...] }.',
    returns: '{ empty: boolean, models: Array<{ provider, providerLabel, modelId, label, description, supportsVision: boolean, isDefault: boolean }> }',
  },
  // ===== 画布项目 & 配置 =====
  {
    action: 'listProjects',
    description: 'List all BobWork projects (same list as the side panel). Each { id, name, path, createdAt, updatedAt }.',
    returns: 'Array<{ id, name, path, createdAt, updatedAt }>',
  },
  {
    action: 'getAppConfig',
    description: 'Get the current application configuration summary (active theme, active project id, providers count, first-run flag, BobWork version/platform). Read-only.',
    returns: '{ themeId, themeName, dark, projectId, projectName, providersCount, providers: Array<{type, name, hasApiKey, modelsCount}>, version, platform, isFirstRun, sandboxDataDir }',
  },
  // ===== 日历 & 提醒（亲儿子：宿主待办/日程直接呈现给用户）=====
  {
    action: 'listCalendarEvents',
    description: 'List calendar events for the current project. Pass scope: "today" | "week" | "upcoming" | "all" (default today). Each { id, title, date, time, repeat, completed, note }.',
    params: ['scope?:"today"|"week"|"upcoming"|"all"'],
    returns: 'Array<{ id, title, date, time?, repeat?, completed: boolean, note? }>',
  },
];

export { HOST_CHAT_PERMISSION_ACTIONS } from '@/lib/sandbox/bridge-constants';

/** 由宿主客户端拦截执行的 graph 动作（不进服务端 handleBridgeRequest） */
export const HOST_GRAPH_BRIDGE_ACTIONS: readonly string[] = GRAPH_BRIDGE_ACTIONS as readonly string[];

// ==================== Client-side script injected into iframe ====================

/**
 * Build the client bridge script, injecting the current appId so storage
 * can be automatically namespaced.
 *
 * Exposes two globals inside the sandbox iframe:
 *   window.BobWork   — request / listActions (host API bridge)
 *   window.BobStorage — 3-layer persistence helpers
 */
export function buildBridgeClientScript(appId: string, opts?: { fullTrust?: boolean }): string {
  const safeAppId = JSON.stringify(appId);
  // 放开小程序权限（2026-10-10）：完全信任下不再有任何"人工确认"弹窗；默认放开
  const fullTrust = opts?.fullTrust !== false;
  const safeFullTrust = String(fullTrust);
  return `
<script>
(function() {
  var APP_ID = ${safeAppId};
  // 完全信任：桥的人工确认动作不再弹窗（writeWanted / 权限申请一律直通）
  var FULL_TRUST = ${safeFullTrust};
  var pendingRequests = {};
  var chatStreams = {};
  var requestId = 0;

  // 人工确认型动作：宿主端会弹出确认框等待用户选择，请求超时需放宽（普通动作 10s）
  var MANUAL_CONFIRM_TIMEOUT = 120000;
  var MANUAL_CONFIRM_ACTIONS = ['chatRequestPermission', 'graphRequestPermission', 'writeWanted'];
  // 宿主全能力直通：run_command / execute_script 等可能跑几十秒到几分钟（安装类命令 180s）
  var HOST_TOOL_TIMEOUT = 600000;
  // chat 也不该用 10s/30s 默认预算：一次正常生成常 20-60s，长回复更久（2026-10-10 评估 B3）
  var CHAT_TIMEOUT = 120000;

  // ===== Security: resolve trusted host targetOrigin (reject '*' fallback) =====
  function resolveTargetOrigin() {
    try {
      var metaEl = document.querySelector('meta[name="bob-host-origin"]');
      var origin = metaEl && metaEl.getAttribute('content');
      if (origin && origin !== 'null') {
        // Reject wildcard fallback: preview route must inject a concrete origin
        if (origin === '*') return '';
        return origin;
      }
    } catch (_) {}
    // Fallback: parent window's origin (same-origin / electron file:// context tolerant)
    try {
      if (window.parent && window.parent.location && window.parent.location.origin) {
        return window.parent.location.origin;
      }
    } catch (_) {}
    // file:// / about:blank tolerant: fall back to empty string only when no other option
    return '';
  }
  // iframe 模式（非顶层页）：meta 注入的是预览页自己的 origin，而父窗口是宿主 origin；
  // sandbox iframe 又读不到 parent.location.origin → 对父窗口只能用 '*'。
  // 安全性由两侧共同保证：宿主校验 event.source === iframe.contentWindow；预览入口页用 CSP
  // frame-ancestors 只允许回环宿主嵌入（不设 X-Frame-Options，否则宿主跨 origin 的预览也会被拦）。
  var IN_IFRAME = (window.parent !== window);
  var HOST_TARGET_ORIGIN = IN_IFRAME ? '*' : resolveTargetOrigin();

  // 身份令牌（2026-10-10）：由预览路由注入到 <meta name="bob-app-token">。
  // 服务端只认它解出的 appId；自报的 _appId 仅作对照（不一致 = 冒充，会记进审计）。
  function resolveAppToken() {
    try {
      var metaEl = document.querySelector('meta[name="bob-app-token"]');
      return (metaEl && metaEl.getAttribute('content')) || '';
    } catch (_) { return ''; }
  }
  var APP_TOKEN = resolveAppToken();

  // 自托管模式：顶层页（Hippo guest / 独立窗口）无父窗口，桥请求直连服务端中继
  var IS_STANDALONE = (window.parent === window);

  // 服务端中继（独立页场景）：POST /api/sandbox/bridge { action, data }
  function relayRequest(action, data) {
    var ctrl = new AbortController();
    var isLong = action === 'hostTool' || action === 'chat' || MANUAL_CONFIRM_ACTIONS.indexOf(action) >= 0;
    var budget = action === 'hostTool' ? HOST_TOOL_TIMEOUT
      : action === 'chat' ? CHAT_TIMEOUT
      : (isLong ? MANUAL_CONFIRM_TIMEOUT : 30000);
    var to = setTimeout(function() { try { ctrl.abort(); } catch (_) {} }, budget);
    return fetch('/api/sandbox/bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action, data: data }),
      signal: ctrl.signal
    }).then(function(r) { return r.json(); }).then(function(j) {
      if (j && j.success) return j.data;
      throw new Error((j && j.error) || ('bridge error: ' + action));
    }).finally(function() { clearTimeout(to); });
  }

  // 服务端流式中继（独立页场景）：POST /api/sandbox/chat-stream，解析 SSE
  function relayChatStream(data, onDelta) {
    var ctrl = new AbortController();
    var LF = String.fromCharCode(10);
    var promise = fetch('/api/sandbox/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: ctrl.signal
    }).then(function(resp) {
      if (!resp.ok) return resp.json().then(function(j) { throw new Error(j.error || ('chat-stream HTTP ' + resp.status)); });
      if (!resp.body || !resp.body.getReader) throw new Error('chat-stream not readable');
      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      var meta = {};
      return new Promise(function(resolve, reject) {
        function pump() {
          reader.read().then(function(step) {
            if (step.done) { resolve(meta); return; }
            buf += decoder.decode(step.value, { stream: true });
            var sep;
            while ((sep = buf.indexOf(LF + LF)) >= 0) {
              var chunk = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              var ev = null, dt = null;
              chunk.split(LF).forEach(function(line) {
                if (line.indexOf('event:') === 0) ev = line.slice(6).trim();
                else if (line.indexOf('data:') === 0) dt = line.slice(5).trim();
              });
              if (!dt) return;
              var parsed; try { parsed = JSON.parse(dt); } catch (_) { return; }
              if (ev === 'delta') { if (typeof parsed.text === 'string') onDelta(parsed.text); }
              else if (ev === 'done') { meta = parsed; }
              else if (ev === 'error') { reject(new Error(parsed.error || 'chat-stream error')); }
            }
            pump();
          }).catch(function(e) { reject(e); });
        }
        pump();
      });
    });
    return { promise: promise, abort: function() { try { ctrl.abort(); } catch (_) {} } };
  }

  function postToHost(msg) {
    if (HOST_TARGET_ORIGIN) {
      try { window.parent.postMessage(msg, HOST_TARGET_ORIGIN); return; } catch (_) {}
    }
    // file:// / localhost dev tolerant
    try { window.parent.postMessage(msg, '*'); } catch (_) {}
  }

  // 预览就绪信号：宿主据此区分“页面成功加载”与 403/白屏/错误页。
  // 多次发送：宿主是在 iframe onLoad 时才挂监听，首条可能早于挂载（真实 E2E 抓到过同类竞态）。
  function announcePreviewReady() {
    if (IS_STANDALONE) return;
    try { postToHost({ type: 'bob_ready', appId: APP_ID }); } catch (_) {}
  }
  if (!IS_STANDALONE) {
    announcePreviewReady();
    setTimeout(announcePreviewReady, 250);
    setTimeout(announcePreviewReady, 900);
    window.addEventListener('load', announcePreviewReady);
  }

  // ===== window.BobWork =====
  window.BobWork = {
    request: function(action, data) {
      data = data || {};
      // 自动注入本小程序 appId（仅作对照）与身份令牌（服务端以令牌为准）
      data._appId = APP_ID;
      if (APP_TOKEN) data._appToken = APP_TOKEN;
      // 自托管模式（Hippo 顶层页）：无父窗口，直连服务端中继
      if (IS_STANDALONE) {
        // 画布对接类动作在独立页无意义（无画布宿主），直接友好拒绝
        if (action.indexOf('graph') === 0) {
          return Promise.reject(new Error('当前为独立页面（Hippo），不支持画布对接操作'));
        }
        // 人工确认型动作：先 in-page 确认，复刻宿主弹窗语义（服务端权限闸仍生效）
        // 确认文案带上目标文件名（2026-10-02）：原先只说「执行 writeWanted」，用户看不到写哪个文件、
        // 更看不到会覆盖什么 —— 现在至少把落点摆在他眼前（受保护文件由服务端直接拒绝，见 bridge-guards）。
        // 2026-10-10 放开小程序权限：FULL_TRUST 下**跳过一切确认**，直接放行（服务端仍有写盘护栏与审计）。
        var manual = !FULL_TRUST && MANUAL_CONFIRM_ACTIONS.indexOf(action) >= 0;
        var manualTarget = data && data.filename ? '（目标文件：' + String(data.filename) + '）' : '';
        if (manual && !window.confirm('小程序请求执行「' + action + '」' + manualTarget + '，是否允许？')) {
          return Promise.reject(new Error('user denied: ' + action));
        }
        return relayRequest(action, data);
      }
      var id = 'req_' + (++requestId);
      return new Promise(function(resolve, reject) {
        pendingRequests[id] = { resolve: resolve, reject: reject };
        postToHost({
          type: 'bob_request',
          id: id,
          action: action,
          data: data
        });
        // 人工确认型动作（宿主会弹窗等待用户选择）：超时放宽到 120s，
        // 避免用户在两轮确认弹窗中未及时点击导致请求超时误报"授权失败"
        var isLong = action === 'hostTool' || action === 'chat' || MANUAL_CONFIRM_ACTIONS.indexOf(action) >= 0;
        var budget = action === 'hostTool' ? HOST_TOOL_TIMEOUT
          : action === 'chat' ? CHAT_TIMEOUT
          : (isLong ? MANUAL_CONFIRM_TIMEOUT : 10000);
        setTimeout(function() {
          if (pendingRequests[id]) {
            delete pendingRequests[id];
            reject(new Error('BobWork.request timeout: ' + action));
          }
        }, budget);
      });
    },
    listActions: function() {
      return window.BobWork.request('listActions');
    },
    /**
     * 宿主全能力直通（2026-10-10 放开小程序权限）：以宿主工具注册表里的任意工具名发起调用，
     * 与画布节点里的 AI Agent 同权 —— 读写文件 / 列目录 / 搜索 / 跑命令与脚本 / Butler / 笔记 /
     * 日历 / 项目 / 检索 / MCP 等。无需授权、不再弹确认（完全信任模式）。
     * 例：await BobWork.host('read_file', { path: 'homework/report.md' })
     *     await BobWork.host('run_command', { cmd: 'ls -la' })
     *     await BobWork.host('create_project', { name: '新项目' })
     * 返回 { success, result, durationMs }。
     */
    host: function(name, args) {
      return window.BobWork.request('hostTool', { name: name, args: args || {} });
    },
    /** 列出全部可用宿主工具（name / description / category / scenes），用于自建工具面板 */
    listHostTools: function() {
      return window.BobWork.request('listHostTools', {});
    },
    /**
     * 流式模型调用（无需工具、纯文本）。通过 onDelta 实时接收增量，返回 Promise<{model, provider, usage}>。
     * opts: { model?, messages, temperature?, maxTokens?, onDelta(text) }
     * 返回 handle: { promise, abort() } —— abort() 可中途取消生成。
     */
    chatStream: function(opts) {
      opts = opts || {};
      var data = {
        model: opts.model,
        messages: opts.messages || [],
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        _appId: APP_ID,
        _appToken: APP_TOKEN
      };
      var onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : function() {};
      // 自托管模式（Hippo 顶层页）：直连服务端流式中继
      if (IS_STANDALONE) {
        var relay = relayChatStream(data, onDelta);
        return {
          promise: relay.promise,
          abort: function() { relay.abort(); }
        };
      }
      var id = 'stream_' + (++requestId);
      var settled = false;
      var promise = new Promise(function(resolve, reject) {
        chatStreams[id] = {
          onDelta: onDelta,
          resolve: resolve,
          reject: reject
        };
        postToHost({ type: 'bob_chat_stream', id: id, data: data });
        setTimeout(function() {
          if (chatStreams[id]) {
            delete chatStreams[id];
            reject(new Error('BobWork.chatStream timeout'));
          }
        }, 120000);
      });
      return {
        promise: promise,
        abort: function() {
          if (chatStreams[id]) {
            delete chatStreams[id];
            postToHost({ type: 'bob_chat_cancel', id: id });
            settled = true;
          }
        }
      };
    }
  };

  // ===== 存储门面 =====
  // - 应用内 iframe（opaque origin）：使用预览路由内联的 window.__BOB_LOCAL_SNAPSHOT__，
  //   同步读、写通过 postMessage 交给宿主落盘（刷新/重开不丢）；无快照时退化为内存。
  // - Hippo 顶层页：正常 localStorage（第 2/3 层磁盘存储不受影响）。
  var HOST_LOCAL_SNAPSHOT = null;
  if (!IS_STANDALONE) {
    try {
      var snapshotCandidate = window.__BOB_LOCAL_SNAPSHOT__;
      if (snapshotCandidate && typeof snapshotCandidate === 'object' && !Array.isArray(snapshotCandidate)) {
        HOST_LOCAL_SNAPSHOT = snapshotCandidate;
      }
    } catch (_) {}
  }
  var memoryStore = {};
  // 宿主 onLoad 才挂桥；页面初始化期间的 set 先排队，收到 bob_host_ready 后补发，避免首屏丢写。
  var hostBridgeReady = false;
  var localWritesQueue = [];
  function persistLocalWrite(k, v) {
    if (!hostBridgeReady) {
      localWritesQueue.push({ key: k, value: v });
      return;
    }
    try { postToHost({ type: 'bob_local_storage_set', key: k, value: v }); } catch (_) {}
  }
  var LS = {
    get: function(k) {
      if (HOST_LOCAL_SNAPSHOT) {
        return Object.prototype.hasOwnProperty.call(HOST_LOCAL_SNAPSHOT, k) ? String(HOST_LOCAL_SNAPSHOT[k]) : null;
      }
      try { return localStorage.getItem(k); } catch (_) {
        return Object.prototype.hasOwnProperty.call(memoryStore, k) ? memoryStore[k] : null;
      }
    },
    set: function(k, v) {
      var s = String(v);
      if (HOST_LOCAL_SNAPSHOT) {
        HOST_LOCAL_SNAPSHOT[k] = s;
        persistLocalWrite(k, s);
        return;
      }
      try { localStorage.setItem(k, s); } catch (_) { memoryStore[k] = s; }
    },
    remove: function(k) {
      if (HOST_LOCAL_SNAPSHOT) {
        try { delete HOST_LOCAL_SNAPSHOT[k]; } catch (_) {}
        persistLocalWrite(k, null);
        return;
      }
      try { localStorage.removeItem(k); } catch (_) { delete memoryStore[k]; }
    },
    keys: function() {
      if (HOST_LOCAL_SNAPSHOT) return Object.keys(HOST_LOCAL_SNAPSHOT);
      try {
        var out = [];
        for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k) out.push(k); }
        return out;
      } catch (_) { return Object.keys(memoryStore); }
    }
  };

  // ===== window.BobStorage =====
  var LS_PREFIX = 'bob_sb_' + APP_ID + '_';
  function toLSKey(k) { return LS_PREFIX + String(k); }
  // P0#9: HMR soft-reload snapshot key (auto-prefixed)
  var SOFT_RELOAD_KEY = toLSKey('__softReloadSnapshot__');

  function captureUISnapshot() {
    try {
      var snap = {
        scrollY: window.scrollY || 0,
        scrollX: window.scrollX || 0,
        scrollElements: [],
        hash: window.location.hash || '',
      };
      // Document-level textarea/input/select (no-framework simple templates: todo/habit/form)
      var fields = document.querySelectorAll('input, textarea, select');
      var fieldStates = [];
      for (var i = 0; i < fields.length; i++) {
        var el = fields[i];
        var idAttr = el.getAttribute('id') || el.getAttribute('name') || el.getAttribute('data-sb-key');
        if (!idAttr) continue;
        var tag = (el.tagName || '').toLowerCase();
        if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
          fieldStates.push({ id: idAttr, type: el.type, checked: el.checked });
        } else if (tag === 'select') {
          fieldStates.push({ id: idAttr, type: 'select', value: el.value });
        } else if (tag === 'input' || tag === 'textarea') {
          fieldStates.push({ id: idAttr, type: tag, value: el.value });
        }
      }
      snap.fields = fieldStates;
      // Capture scroll of any scrollable container with id/data-sb-key
      var scrollers = document.querySelectorAll('[data-sb-scroll]');
      for (var j = 0; j < scrollers.length; j++) {
        var scr = scrollers[j];
        var key = scr.getAttribute('data-sb-scroll') || scr.getAttribute('id');
        if (!key) continue;
        snap.scrollElements.push({ key, top: scr.scrollTop, left: scr.scrollLeft });
      }
      return JSON.stringify(snap);
    } catch (_) {
      return null;
    }
  }
  function restoreUISnapshot() {
    try {
      var raw = LS.get(SOFT_RELOAD_KEY);
      if (!raw) return false;
      // One-shot: delete immediately so no cross-session stale recovery
      LS.remove(SOFT_RELOAD_KEY);
      var snap = JSON.parse(raw);
      if (!snap) return false;
      var fields = snap.fields || [];
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        var el =
          (f.id && document.getElementById(f.id)) ||
          document.querySelector('[name="' + f.id.replace(/"/g, '\\"') + '"]') ||
          document.querySelector('[data-sb-key="' + f.id.replace(/"/g, '\\"') + '"]');
        if (!el) continue;
        var tag = (el.tagName || '').toLowerCase();
        if (tag === 'input' && (f.type === 'checkbox' || f.type === 'radio')) {
          el.checked = !!f.checked;
        } else if (tag === 'select') {
          el.value = f.value || '';
        } else if (tag === 'input' || tag === 'textarea') {
          el.value = f.value || '';
        }
        // dispatch change so frameworks sync state
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
        try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      }
      // Scrollers
      var scrollEls = snap.scrollElements || [];
      for (var j = 0; j < scrollEls.length; j++) {
        var sk = scrollEls[j];
        var scrEl = document.querySelector('[data-sb-scroll="' + sk.key + '"]') ||
          (sk.key && document.getElementById(sk.key));
        if (scrEl) {
          scrEl.scrollTop = sk.top || 0;
          scrEl.scrollLeft = sk.left || 0;
        }
      }
      // Page scroll
      setTimeout(function () {
        try { window.scrollTo(snap.scrollX || 0, snap.scrollY || 0); } catch (_) {}
        if (snap.hash) try { window.location.hash = snap.hash; } catch (_) {}
      }, 0);
      return true;
    } catch (_) {
      return false;
    }
  }
  // Auto-restore snapshot on load (HMR / file-save soft-reload scenario)
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { restoreUISnapshot(); });
  } else {
    restoreUISnapshot();
  }

  window.BobStorage = {
    // ---- Layer 1: browser localStorage (auto-prefixed, no host round-trip) ----
    // P1#5 hard quota: single app Layer1 total bytes <= 500 KB (UTF-16 units ≈ bytes for ASCII)
    LS_APP_QUOTA_BYTES: 500 * 1024,
    lsUsedBytes: function() {
      try {
        var total = 0;
        var allKeys = LS.keys();
        for (var i = 0; i < allKeys.length; i++) {
          var k = allKeys[i];
          if (!k || k.indexOf(LS_PREFIX) !== 0) continue;
          var v = LS.get(k);
          if (typeof v === 'string') total += k.length * 2 + v.length * 2;
        }
        return total;
      } catch (_) { return 0; }
    },
    set: function(key, value) {
      try {
        var serialized = JSON.stringify(value);
        var k = toLSKey(key);
        var sizeDelta = (k.length * 2) + (serialized.length * 2);
        // Remove existing first so we count new replace correctly
        var prev = LS.get(k);
        if (prev !== null) sizeDelta -= (k.length * 2) + (prev.length * 2);
        var current = window.BobStorage.lsUsedBytes();
        if (current + sizeDelta > window.BobStorage.LS_APP_QUOTA_BYTES) {
          throw new Error('BobStorage.set quota exceeded: Layer1 app limit is ' + window.BobStorage.LS_APP_QUOTA_BYTES + ' bytes');
        }
        LS.set(k, serialized);
        return true;
      } catch (e) { return false; }
    },
    get: function(key) {
      try {
        var raw = LS.get(toLSKey(key));
        return raw == null ? null : JSON.parse(raw);
      } catch (e) { return null; }
    },
    remove: function(key) {
      try { LS.remove(toLSKey(key)); return true; }
      catch (e) { return false; }
    },
    listLocalKeys: function() {
      var out = [];
      var keys2 = LS.keys();
      for (var i = 0; i < keys2.length; i++) {
        var k = keys2[i];
        if (k && k.indexOf(LS_PREFIX) === 0) out.push(k.slice(LS_PREFIX.length));
      }
      return out;
    },

    // ---- Layer 2: disk app-private data dir (~/BobWork/bob-sandbox/apps/<id>/data/) ----
    save: function(key, value) {
      return window.BobWork.request('saveAppData', { appId: APP_ID, key: key, value: value });
    },
    load: function(key) {
      return window.BobWork.request('loadAppData', { appId: APP_ID, key: key });
    },
    listDiskKeys: function() {
      return window.BobWork.request('listAppDataKeys', { appId: APP_ID });
    },
    deleteKey: function(key) {
      return window.BobWork.request('deleteAppData', { appId: APP_ID, key: key });
    },

    // ---- Layer 3: write to global butler/ (final deliverables) ----
    writeWanted: function(filename, content) {
      return window.BobWork.request('writeWanted', { filename: filename, content: content });
    }
  };

  // 只接受来自**父窗口**的消息（sandbox iframe 的 origin 是 opaque 'null'，source 才是可靠判据）
  function isFromParent(event) {
    try { return event.source === window.parent; } catch (_) { return false; }
  }

  // Listen for responses from host (also verify origin when possible)
  window.addEventListener('message', function(event) {
    if (!isFromParent(event)) return;
    // Only accept messages from trusted host origin
    if (HOST_TARGET_ORIGIN && HOST_TARGET_ORIGIN !== '*' && event.origin !== HOST_TARGET_ORIGIN) {
      // file:// contexts: both origins are 'null' – be permissive only there
      if (!(HOST_TARGET_ORIGIN === 'null' && event.origin === 'null')) return;
    }
    var msg = event.data;
    if (!msg) return;

    // 宿主挂桥完成后主动握手：子页回 bob_ready，避免 onLoad 挂载晚于自动上报的竞态
    if (msg.type === 'bob_host_ready') {
      hostBridgeReady = true;
      // 补发页面初始化期间排队、但当时还没有宿主的 Layer-1 写入
      for (var queuedIndex = 0; queuedIndex < localWritesQueue.length; queuedIndex++) {
        var queued = localWritesQueue[queuedIndex];
        try { postToHost({ type: 'bob_local_storage_set', key: queued.key, value: queued.value }); } catch (_) {}
      }
      localWritesQueue.length = 0;
      announcePreviewReady();
      return;
    }

    // P0#9: Host requests snapshot capture (before file-save reload)
    if (msg.type === 'bob_soft_reload') {
      try {
        var snap = captureUISnapshot();
        if (snap) LS.set(SOFT_RELOAD_KEY, snap);
        // Ack the host so it knows it can refresh now
        try { postToHost({ type: 'bob_soft_reload_ack', id: msg.id || 'soft' }); } catch (_) {}
      } catch (_) {}
      return;
    }

    // Theme update: host pushes new CSS variables without reloading iframe
    if (msg.type === 'bob_theme_update') {
      // 首次接收主题更新时注入全局 transition（平滑变色）
      if (!window.__bobThemeTransitionAdded) {
        window.__bobThemeTransitionAdded = true;
        var styleEl = document.createElement('style');
        styleEl.textContent = '* { transition: background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease, fill 0.3s ease, stroke 0.3s ease !important; }';
        document.head.appendChild(styleEl);
        // 0.5s 后移除 transition，避免影响后续交互动画
        setTimeout(function() {
          if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
          window.__bobThemeTransitionAdded = false;
        }, 500);
      }
      var vars = msg.variables || {};
      var root = document.documentElement;
      for (var key in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, key)) {
          root.style.setProperty(key, vars[key]);
        }
      }
      // Update dark mode marker
      if (typeof msg.dark === 'boolean') {
        root.setAttribute('data-bob-dark', msg.dark ? 'true' : 'false');
      }
      // Notify mini-app code (in case charts/canvas need to re-read colors)
      window.dispatchEvent(new CustomEvent('bob-theme-change', {
        detail: { dark: !!msg.dark, keyColors: msg.keyColors || {} }
      }));
      return;
    }

    if (msg.type !== 'bob_response') return;
    var pending = pendingRequests[msg.id];
    if (!pending) return;
    delete pendingRequests[msg.id];
    if (msg.success) {
      pending.resolve(msg.data);
    } else {
      pending.reject(new Error(msg.error || 'Unknown error'));
    }
  });

  // Stream responses from host (BobWork.chatStream)
  window.addEventListener('message', function(event) {
    if (!isFromParent(event)) return;
    if (HOST_TARGET_ORIGIN && HOST_TARGET_ORIGIN !== '*' && event.origin !== HOST_TARGET_ORIGIN) {
      if (!(HOST_TARGET_ORIGIN === 'null' && event.origin === 'null')) return;
    }
    var msg = event.data;
    if (!msg) return;
    if (msg.type !== 'bob_chat_delta' && msg.type !== 'bob_chat_done' && msg.type !== 'bob_chat_error') return;
    var s = chatStreams[msg.id];
    if (!s) return;
    if (msg.type === 'bob_chat_delta') {
      if (typeof msg.text === 'string') s.onDelta(msg.text);
    } else if (msg.type === 'bob_chat_done') {
      delete chatStreams[msg.id];
      s.resolve(msg.data || {});
    } else {
      delete chatStreams[msg.id];
      s.reject(new Error(msg.error || 'Unknown stream error'));
    }
  });
})();
</script>
`;
}

/** @deprecated kept for backwards compatibility; use buildBridgeClientScript(appId) instead */
export const BRIDGE_CLIENT_SCRIPT = buildBridgeClientScript('__UNKNOWN__');

// ==================== Server-side helpers ====================

function appsRootDir(): string {
  return join(resolveAppRoot(), BOB_SANDBOX_DIRNAME, 'apps');
}

function sanitizeDataKey(key: string): string {
  // Only allow safe key chars; max 80 chars. Prevents path traversal.
  const cleaned = String(key).replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.slice(0, 80) || 'unnamed';
}

function appDataDir(appId: string): string {
  // Basic sanity on appId (should already be app_xxx_yyy)
  const safe = String(appId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(appsRootDir(), safe, 'data');
}

// P1#5: Layer2 hard quota (10MB per app) – pre-check for every saveAppData write
const LAYER2_APP_QUOTA_BYTES = 10 * 1024 * 1024; // 10 MB

async function dirSizeBytes(dirPath: string): Promise<number> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    let total = 0;
    for (const e of entries) {
      const full = join(dirPath, e.name);
      if (e.isDirectory()) {
        total += await dirSizeBytes(full);
      } else if (e.isFile()) {
        try {
          const st = await fs.stat(full);
          total += st.size;
        } catch { /* ignore */ }
      }
    }
    return total;
  } catch {
    return 0;
  }
}

// ==================== Server-side handler ====================

// ============================================================
// P2#4：统一 zod schema 入口
//   所有来自小程序 postMessage → /api/sandbox/bridge → handleBridgeRequest
//   的参数，都在这里走一次 schema 校验，统一错误格式并防御字段注入。
// ============================================================
const ActionSchemas: Record<string, z.ZodTypeAny | undefined> = {
  listNodes: z.object({}).strict().optional(),
  readNode: z.object({ nodeId: z.string().min(1) }).strict(),
  writeWanted: z.object({
    filename: z.string().min(1).max(200),
    content: z.string().max(20_000_000),
  }).strict(),
  saveAppData: z.object({
    appId: z.string().min(1).max(64),
    key: z.string().min(1).max(256),
    // 允许任意 JSON-able 值
    value: z.any(),
    // 客户端桥对**每个**请求都会自动注入 _appId（见 buildBridgeClientScript），
    // .strict() 下必须在 schema 里显式声明，否则 BobStorage 磁盘层被判 Unrecognized key 全量拒绝
    // （2026-10-10 修复：历史 audit.log 里 203 次 loadAppData / 36 次 saveAppData 失败均源于此）。
    _appId: z.string().max(64).optional(),
  }).strict(),
  loadAppData: z.object({
    appId: z.string().min(1).max(64),
    key: z.string().min(1).max(256),
    _appId: z.string().max(64).optional(),
  }).strict(),
  listAppDataKeys: z.object({
    appId: z.string().min(1).max(64),
    _appId: z.string().max(64).optional(),
  }).strict(),
  deleteAppData: z.object({
    appId: z.string().min(1).max(64),
    key: z.string().min(1).max(256),
    _appId: z.string().max(64).optional(),
  }).strict(),
  chatGetPermission: z.object({
    appId: z.string().max(64).optional(),
    _appId: z.string().max(64).optional(),
  }).strict(),
  chat: z.object({
    appId: z.string().min(1).max(64).optional(),
    _appId: z.string().max(64).optional(),
    model: z.string().max(128).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(32_768).optional(),
    messages: z.array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
      }),
    ).min(1).max(128),
  }).strict(),
  getProjectInfo: z.object({}).strict().optional(),
  getTheme: z.object({}).strict().optional(),
  listActions: z.object({}).strict().optional(),
  // ===== Butler 亲儿子只读接口 =====
  readWantedTodo: z.object({
    filter: z.string().max(64).optional(),
  }).strict().optional(),
  readWantedNotebook: z.object({
    mode: z.enum(['index', 'full']).optional(),
  }).strict().optional(),
  readWantedPreferences: z.object({
    type: z.string().max(64).optional(),
  }).strict().optional(),
  // ===== 节点祖先链 & 结构化目录 =====
  getNodeAncestorChain: z.object({
    projectId: z.string().max(64).optional(),
    _focusNodeId: z.string().max(64).optional(),
  }).strict().optional(),
  getNodeManifest: z.object({
    projectId: z.string().max(64).optional(),
  }).strict().optional(),
  // ===== 技能检索、模型池、项目列表、总配置 =====
  searchSkills: z.object({
    query: z.string().min(1).max(256),
    limit: z.number().int().min(1).max(30).optional(),
  }).strict(),
  listConfiguredModels: z.object({}).strict().optional(),
  listProjects: z.object({}).strict().optional(),
  getAppConfig: z.object({}).strict().optional(),
  // ===== 日历事件 =====
  listCalendarEvents: z.object({
    scope: z.enum(['today', 'week', 'upcoming', 'all']).optional(),
  }).strict().optional(),
  // ===== 权限确认弹窗 =====
  chatRequestPermission: z.object({
    appId: z.string().max(64).optional(),
    _appId: z.string().max(64).optional(),
  }).strict().optional(),
  // ===== 宿主全能力直通（放开小程序权限）=====
  // name 不限白名单：直通宿主工具注册表（与画布 AI 同权）；args 允许任意 JSON 参数对象。
  hostTool: z.object({
    name: z.string().min(1).max(128),
    args: z.record(z.string(), z.unknown()).optional(),
    _appId: z.string().max(64).optional(),
  }).strict(),
  listHostTools: z.object({
    _appId: z.string().max(64).optional(),
  }).strict().optional(),
};

/** 将 zod 的字段错误汇总为单条易读消息 */
function formatZodError(err: z.ZodError): string {
  const head = err.issues.slice(0, 3);
  return 'invalid payload: ' + head.map((i) => `${i.path.join('.')} ${i.message}`).join('; ');
}

// ============================================================
// P2#14：统一审计日志（仅写磁盘，敏感值不打日志，防回溯）
// ============================================================
type AuditEntry = {
  t: string; // ISO
  action: string;
  appId?: string;
  ok: boolean;
  msMs: number;
  error?: string;
  // 非精确计数，用于体量感判断
  dataBytes?: number;
  /** 自报 appId（与令牌不一致时才有值）：冒充信号，出事时直接可查 */
  claimedAppId?: string;
  /** 自报值与令牌不一致 = 疑似冒充（审计筛选用） */
  spoofSuspected?: boolean;
  /** 目标摘要（2026-10-10 评估 P1-3）：hostTool 记「工具名 + 目标路径/命令前缀」、
   *  writeWanted 记目标文件名 —— 出事能定位到"哪个小程序写了什么/跑了什么"。
   *  绝不记录 content / script / value 等正文。 */
  detail?: string;
};

/**
 * 纯函数：把一次 hostTool 调用压成一行可审计摘要（不含文件正文/脚本正文）。
 * 例：`read_file path=homework/a.md`、`run_command cmd=ls -la`、`write_file path=… (12B content)`
 */
export function summarizeHostToolCall(name: string, args: Record<string, unknown>): string {
  const clip = (v: unknown, n: number): string => {
    const t = String(v ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  const parts: string[] = [name];
  const pathLike = args.path ?? args.file ?? args.filename ?? args.dir;
  if (pathLike) parts.push(`path=${clip(pathLike, 160)}`);
  if (typeof args.cmd === 'string') parts.push(`cmd=${clip(args.cmd, 120)}`);
  if (args.language) parts.push(`lang=${clip(args.language, 20)}`);
  if (typeof args.content === 'string') parts.push(`(${Buffer.byteLength(args.content, 'utf8')}B content)`);
  if (typeof args.script === 'string') parts.push(`(${Buffer.byteLength(args.script, 'utf8')}B script)`);
  if (args.appId && args.appId !== pathLike) parts.push(`appId=${clip(args.appId, 64)}`);
  return parts.join(' ');
}
/** 当日审计文件：~/BobWork/.logs/sandbox/audit-YYYY-MM-DD.jsonl
 *  2026-10-10 评估 P1-3/P1-5：原来是 bob-sandbox/audit.log 单文件 + 5MB 覆盖式裁剪，
 *  既丢历史、又和"小程序自己的目录"混在一起（可被 run_command 顺手删掉）。 */
function sandboxAuditLogPath(day = new Date()): string {
  const stamp = day.toISOString().slice(0, 10);
  return join(resolveAppRoot(), LOGS_DIRNAME, 'sandbox', `audit-${stamp}.jsonl`);
}
/** .logs/sandbox 目录（0700） */
function sandboxAuditDir(): string {
  return join(resolveAppRoot(), LOGS_DIRNAME, 'sandbox');
}
async function appendAudit(e: AuditEntry) {
  try {
    const dir = sandboxAuditDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = sandboxAuditLogPath();
    // 0o600：审计含小程序 id 与目标路径，不给同机其他用户读
    await fs.appendFile(file, JSON.stringify(e) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // 审计写失败不能中断业务
  }
}
/** 审计保留天数：按天文件 + 到期删除（不再"覆盖式裁剪丢掉前半段"） */
const AUDIT_KEEP_DAYS = 30;
async function rotateAuditIfNeeded() {
  try {
    const dir = sandboxAuditDir();
    const files = await fs.readdir(dir);
    const cutoff = Date.now() - AUDIT_KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const name of files) {
      if (!/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      const full = join(dir, name);
      const st = await fs.stat(full).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fs.rm(full, { force: true });
    }
  } catch { /* ignore */ }
}

export interface BridgeIdentityOptions {
  /** 由**签名令牌**解出的权威 appId（路由传入）；缺省时回退到自报值（仅测试/内部直接调用） */
  verifiedAppId?: string;
  /** 自报值与令牌值不一致时的自报值（作为冒充信号写入审计） */
  claimedAppId?: string;
}

export async function handleBridgeRequest(
  action: string,
  data: Record<string, unknown>,
  identity?: BridgeIdentityOptions,
): Promise<unknown> {
  const started = Date.now();
  let appId: string | undefined;
  let dataBytes: number | undefined;
  let ok = false;
  let errorMsg: string | undefined;
  let auditDetail: string | undefined;
  /** 冒充信号：自报 appId 与令牌不一致时记录自报值（2026-10-10 身份令牌） */
  let auditClaimedAppId: string | undefined;
  try {
    // ============= 0. 小程序存在性闸（2026-10-10） =============
    // 桥是无状态的、appId 由客户端自报：删除小程序后，已打开的预览标签页仍能继续调用
    // （实测：删除后 hostTool 照旧执行命令，saveAppData 还会把目录复活成无 manifest 的幽灵目录）。
    // 这里在入口统一校验 apps/<appId>/manifest.json 存在 —— 删除即断连，且不再产生幽灵目录。
    // 注意必须放在 schema 解析之前：`.strict()` 会剥掉未声明的 `_appId`。
    const rawAppId = (data as Record<string, unknown>)._appId ?? (data as Record<string, unknown>).appId;
    const claimedAppId = sanitizeAppId(rawAppId);
    // 权威 appId：优先取令牌解出的值（路由已校验）；直接调用（测试）才回退自报值
    const requestAppId = sanitizeAppId(identity?.verifiedAppId) ?? claimedAppId;
    if (!requestAppId) {
      throw new Error('mini-program id is required: bridge requests must originate from a sandbox app page');
    }
    if (identity?.claimedAppId) {
      // 冒充信号：自报值 ≠ 令牌值（攻击者试图用别人的 appId 拿更高权限/冒充审计归因）
      auditClaimedAppId = identity.claimedAppId;
    }
    if (!(await appExists(requestAppId))) {
      throw new Error(`mini-program not found or deleted: ${requestAppId}`);
    }

    // ============= P2#4：统一 schema 解析 =============
    // `_appId` 是客户端脚本对**每个**请求自动注入的（见 buildBridgeClientScript）——它必须
    // 在 `.strict()` 解析前剥离，否则会报 "Unrecognized key: _appId"。这一条历史上造成过一整类
    // 隐藏故障：loadAppData/saveAppData/chatGetPermission 全量失败（2026-08 审计里有 203 次），
    // 以及 listNodes/getTheme 这种「零字段」schema 直接不可用（客户端永远带 _appId）。
    // 解析后再把入口已校验过的 appId 回填，handler 仍可按老写法读 `_appId`。
    // 注意：客户端注入的键（_appId / _appToken）都必须在 .strict() 解析前剥离，否则报
    // "Unrecognized key"。新增注入字段时**必须**同步加到这里（历史上 _appId 造成过一整类隐藏故障）。
    const {
      _appId: _injectedAppId,
      _appToken: _injectedAppToken,
      ...payloadForSchema
    } = (data ?? {}) as Record<string, unknown>;
    void _injectedAppId;
    void _injectedAppToken;
    const schema = ActionSchemas[action];
    if (schema) {
      const parsed = schema.safeParse(payloadForSchema);
      if (!parsed.success) {
        throw new Error(formatZodError(parsed.error));
      }
      // 替换为已解析且严格剥离了额外字段的 payload，防止字段注入
      data = { ...((parsed.data ?? {}) as Record<string, unknown>), _appId: requestAppId };
    } else {
      data = { ...payloadForSchema, _appId: requestAppId };
    }

    // 估算 data 体大小（仅用于审计，不含真实内容）
    try { dataBytes = Buffer.byteLength(JSON.stringify(data ?? {}), 'utf-8'); } catch { /* ignore */ }

    // 抽取 appId（审计用）
    const appIdAny = (data as Record<string, unknown>)._appId ?? (data as Record<string, unknown>).appId;
    if (typeof appIdAny === 'string') appId = appIdAny;

    let result: unknown;
    switch (action) {
      case 'listActions':
        result = BRIDGE_ACTIONS;
        break;

      case 'listNodes': {
        const project = await getCurrentProject();
        const nodesDir = join(project.path, 'notes-memory');
        try {
          const files = await fs.readdir(nodesDir);
          const mdFiles = files.filter((f) => f.endsWith('.md'));
          const nodes: Array<{ nodeId: string; title: string; updatedAt: string }> = [];
          for (const f of mdFiles) {
            try {
              const content = await fs.readFile(join(nodesDir, f), 'utf-8');
              const parsed = parseNodeMarkdown(content);
              nodes.push({
                nodeId: parsed.frontmatter.node_id || '',
                title: parsed.frontmatter.title || f,
                updatedAt: parsed.frontmatter.updated_at || '',
              });
            } catch {
              // skip corrupted
            }
          }
          result = nodes;
        } catch {
          result = [];
        }
        break;
      }

      case 'readNode': {
        const nodeId = String(data.nodeId ?? '');
        if (!nodeId) throw new Error('nodeId is required');
        const project = await getCurrentProject();
        const filePath = await findNodeFileById(nodeId, project.path);
        if (!filePath) throw new Error('Node not found: ' + nodeId);
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = parseNodeMarkdown(content);
        result = {
          nodeId: parsed.frontmatter.node_id || nodeId,
          title: parsed.frontmatter.title || '',
          summary: parsed.summary || '',
          content,
        };
        break;
      }

      case 'writeWanted': {
        const filename = String(data.filename ?? '');
        auditDetail = `file=${filename}`;
        const content = String(data.content ?? '');
        if (!filename) throw new Error('filename is required');
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        // 2026-10-02 护栏：butler/ 根下的**真源 / 状态文件**不给小程序写。
        // 此前只清洗文件名（挡目录穿越），却把 preferences.md（用户记忆，所有人共享）、
        // roles.json、notify-state.json 一起暴露成「可被 fs.writeFile 全量覆盖」——
        // 一次笼统确认就能清空全部记忆。详见 ./bridge-guards.ts。
        if (isProtectedButlerFile(safeName)) {
          throw new Error(
            `refused: ${safeName} is Butler's own file (user memory / registry / notify state) and cannot be overwritten by a mini-app`,
          );
        }
        const butlerDir = join(resolveAppRoot(), 'butler');
        await fs.mkdir(butlerDir, { recursive: true });
        const filePath = join(butlerDir, safeName);
        await fs.writeFile(filePath, content, 'utf-8');
        result = { path: safeName };
        break;
      }

      case 'getProjectInfo': {
        const project: ProjectConfig = await getCurrentProject();
        result = {
          id: project.id,
          name: project.name,
          path: project.path,
        };
        break;
      }

      case 'getTheme': {
        const { readSettingsFromFile } = await import('@/lib/settings-server');
        const { PRESET_THEME_VARIABLES, THEME_OPTIONS } = await import('@/lib/settings');
        const s = await readSettingsFromFile();
        const themeId = s.theme ?? 'warm';
        // 统一单一品牌色：始终使用预设变量（历史 custom 主题已被 normalizeCustomThemes 收敛）
        const variables = PRESET_THEME_VARIABLES[themeId] ?? PRESET_THEME_VARIABLES['warm'];
        const opt = THEME_OPTIONS.find((t) => t.id === themeId);
        const themeName = opt?.label ?? themeId;
        const dark = opt?.dark ?? false;
        result = {
          themeId,
          themeName,
          dark,
          keyColors: {
            primary: variables['--primary'],
            background: variables['--background'] ?? variables['--canvas-bg'],
            surface: variables['--paper'] ?? variables['--card'],
            text: variables['--foreground'] ?? variables['--ink'],
            border: variables['--border'] ?? variables['--line'],
            muted: variables['--muted-foreground'] ?? variables['--ink-muted'],
          },
          variables,
        };
        break;
      }

      // ===== App-scoped disk persistence =====

      case 'saveAppData': {
        const _appId = requestAppId; // 权威 appId（令牌解出），自报值不可信
        const key = String(data.key ?? '');
        if (!_appId) throw new Error('appId is required');
        if (!key) throw new Error('key is required');
        const dir = appDataDir(_appId);
        await fs.mkdir(dir, { recursive: true });
        const file = join(dir, sanitizeDataKey(key) + '.json');
        const serialized = JSON.stringify({ v: data.value }, null, 2);

        // P1#5: quota pre-check (10MB per-app) – account for the delta between new file and overwritten file
        let existingSize = 0;
        try { existingSize = (await fs.stat(file)).size; } catch { /* ignore */ }
        const currentTotal = await dirSizeBytes(dir);
        const projected = currentTotal - existingSize + Buffer.byteLength(serialized, 'utf-8');
        if (projected > LAYER2_APP_QUOTA_BYTES) {
          throw new Error(
            `BobStorage.save quota exceeded: Layer2 app limit is ${LAYER2_APP_QUOTA_BYTES} bytes (current=${currentTotal}, projected=${projected})`,
          );
        }

        // P1#5 atomic write: write to tmp file in same dir, then fs.rename (POSIX atomic)
        const tmpPath = `${file}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmpPath, serialized, 'utf-8');
        try {
          await fs.rename(tmpPath, file);
        } catch (renameErr) {
          // Fallback cleanup: remove tmp and retry via copy+unlink
          try { await fs.unlink(tmpPath).catch(() => {}); } catch { /* ignore */ }
          await fs.writeFile(file, serialized, 'utf-8');
        }
        result = { ok: true as const, path: file };
        break;
      }

      case 'loadAppData': {
        const _appId = requestAppId; // 权威 appId（令牌解出），自报值不可信
        const key = String(data.key ?? '');
        if (!_appId) throw new Error('appId is required');
        if (!key) throw new Error('key is required');
        const dir = appDataDir(_appId);
        const file = join(dir, sanitizeDataKey(key) + '.json');
        try {
          const raw = await fs.readFile(file, 'utf-8');
          const parsed = JSON.parse(raw);
          result = parsed && Object.prototype.hasOwnProperty.call(parsed, 'v') ? parsed.v : null;
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === 'ENOENT') { result = null; } else { throw e; }
        }
        break;
      }

      case 'listAppDataKeys': {
        const _appId = requestAppId; // 权威 appId（令牌解出），自报值不可信
        if (!_appId) throw new Error('appId is required');
        const dir = appDataDir(_appId);
        try {
          const files = await fs.readdir(dir);
          result = files
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -'.json'.length));
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === 'ENOENT') { result = []; } else { throw e; }
        }
        break;
      }

      case 'deleteAppData': {
        const _appId = requestAppId; // 权威 appId（令牌解出），自报值不可信
        const key = String(data.key ?? '');
        if (!_appId) throw new Error('appId is required');
        if (!key) throw new Error('key is required');
        const dir = appDataDir(_appId);
        const file = join(dir, sanitizeDataKey(key) + '.json');
        try {
          await fs.unlink(file);
          result = { ok: true as const, deleted: true };
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === 'ENOENT') { result = { ok: true as const, deleted: false }; } else { throw e; }
        }
        break;
      }

      // ===== 模型调用（chat，MVP）=====

      // appId 统一取客户端脚本自动注入的 _appId（与 graph 动作一致），兼容显式 appId

      case 'chatGetPermission': {
        const _appId = requestAppId; // 权威 appId（令牌解出）
        if (!_appId) throw new Error('appId is required');
        const level = await getSandboxChatPermissionServer(_appId);
        // 返回布尔 granted（level !== 'none'）+ 具体 level：
        // 兼容旧版 boolean 语义（小程序 if (r.granted) 判断）与三级授权展示
        result = { granted: level !== 'none', level };
        break;
      }

      case 'chatRequestPermission': {
        const _appId = requestAppId; // 权威 appId（令牌解出）
        if (!_appId) throw new Error('appId is required');
        // 2026-10-10 放开小程序权限：此动作**不再弹任何确认框**，也不再是"未实现"。
        // 无显式否决（sandboxChatPermissions[appId] !== 'none'）即视为已授权：
        // 完全信任默认下服务端读取已返回 'permanent'，故这里直接回 granted:true（不再弹窗、不再报 Unknown action）。
        const level = await getSandboxChatPermissionServer(_appId);
        result = { granted: level !== 'none', level };
        break;
      }

      // ===== 宿主全能力直通（放开小程序权限：与画布 AI 同权）=====
      // 白名单不再限制工具名：任何注册在宿主工具注册表里的工具都可被小程序调用。
      case 'hostTool': {
        const name = String(data.name ?? '');
        if (!name) throw new Error('name is required');
        const rawArgs = data.args;
        const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
        // 落地层 host-tools.ts 必须**静态** import 工具注册表：早期在路由处理函数里
        // 动态 import('@/app/api/chat/tools') 会让 dev server 整体挂死（请求不返回 + 同进程所有路由超时）。
        // origin 决定工具面：built = 全量；imported（第三方 ZIP）= 只读且限自己目录（评估 A5）。
        const origin = await appOriginOf(requestAppId);
        auditDetail = summarizeHostToolCall(name, args) + (origin === 'imported' ? ' [imported]' : '');
        result = await runHostTool(name, args, { appId: requestAppId, origin });
        break;
      }

      case 'listHostTools': {
        result = listHostTools();
        break;
      }

      case 'chat': {
        const _appId = requestAppId; // 权威 appId（令牌解出）
        const messages = (data.messages as SandboxChatMessage[] | undefined) ?? [];
        result = await executeSandboxChat({
          appId: _appId,
          model: typeof data.model === 'string' ? data.model : undefined,
          messages,
          temperature: typeof data.temperature === 'number' ? data.temperature : undefined,
          maxTokens: typeof data.maxTokens === 'number' ? data.maxTokens : undefined,
        });
        break;
      }

      // ===== Butler（亲儿子：宿主 Butler 全系列只读）=====

      case 'readWantedTodo': {
        const f = String(data.filter ?? '');
        let content: string | null = null;
        try {
          // 待办已并入 events 表（SSOT，全局日历库 .calendar.db，与项目独立），不再读 todo.md
          const { getCalendarDb } = await import('@/lib/db');
          const db = await getCalendarDb();
          const rows = db.prepare(`
            SELECT title, start_time, status, priority
            FROM events
            WHERE status != 'cancelled'
            ORDER BY COALESCE(start_time, '9999') ASC, created_at ASC
            LIMIT 500
          `).all() as Array<{ title: string; start_time: string | null; status: string; priority: string }>;

          if (rows.length === 0) {
            content = null;
          } else {
            const lines: string[] = ['# TODO 待办记录', ''];
            for (const r of rows) {
              const check = r.status === 'done' ? 'x' : ' ';
              const emoji = r.priority === 'high' ? '🔴' : r.priority === 'low' ? '🟢' : '🟡';
              let time = '';
              if (r.start_time) {
                const d = new Date(r.start_time);
                if (!Number.isNaN(d.getTime())) {
                  const p = (n: number) => String(n).padStart(2, '0');
                  time = ` — ${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
                }
              }
              lines.push(`- [${check}] ${emoji} ${r.title}${time}`);
            }
            content = lines.join('\n');
          }
          if (f && content) {
            const picked = content.split('\n').filter((l) => l.includes(f) || l.startsWith('#'));
            if (picked.length > 1) content = picked.join('\n');
          }
        } catch {
          content = null;
        }
        result = { content };
        break;
      }

      case 'readWantedNotebook': {
        const mode = data.mode === 'full' ? 'full' : 'index';
        try {
          const r = await callNotes('query', { mode });
          if (!r.ok || !r.data) {
            result = { content: '' };
            break;
          }
          result = { content: renderNotesText(r.data, mode) };
        } catch {
          result = { content: '' };
        }
        break;
      }

      case 'readWantedPreferences': {
        const typeFilter = typeof data.type === 'string' ? data.type.trim() : '';
        let content = '';
        try {
          content = await fs.readFile(join(resolveAppRoot(), 'butler', 'preferences.md'), 'utf-8');
        } catch {
          content = '';
        }
        const cats = Array.from(new Set(
          (content.match(/^##\s+(.+)$/gm) || []).map((h) => h.replace(/^##\s+/, '').trim()),
        ));
        if (typeFilter) {
          const lines = content.split(/\r?\n/);
          const buf: string[] = [];
          let inSection = false;
          for (const line of lines) {
            if (/^##\s+/.test(line)) inSection = line.toLowerCase().includes(typeFilter.toLowerCase());
            if (inSection) buf.push(line);
          }
          content = buf.join('\n');
        }
        result = { content, categories: cats };
        break;
      }

      // ===== 节点祖先链 & 结构化目录 =====

      case 'getNodeAncestorChain': {
        const { getAncestorChain, loadNodeById } = await import('@/lib/nodes/ancestors');
        const project = await (data.projectId
          ? (async () => {
              const { getProjectById } = await import('@/lib/project/project-manager');
              return getProjectById(String(data.projectId));
            })()
          : getCurrentProject());
        if (!project) {
          result = [];
          break;
        }
        // 若有当前聚焦节点（由宿主注入 _focusNodeId）以其为起点；否则取项目第一个节点作链基准
        const focus = String((data as Record<string, unknown>)._focusNodeId ?? '');
        let start = focus;
        if (!start) {
          try {
            const entries = await fs.readdir(join(project.path, 'notes-memory'));
            const first = entries.find((e) => e.endsWith('.md'));
            if (first) start = first.replace(/\.md$/, '');
          } catch { /* empty */ }
        }
        if (!start) {
          result = [];
          break;
        }
        const chain = await getAncestorChain(start, project.path, project.id);
        const out: Array<{ nodeId: string; title: string; summary: string; filePath: string }> = [];
        for (const anode of [...chain.depth1, ...chain.depthPlus]) {
          try {
            const nid = anode.nodeId;
            const node = await loadNodeById(nid, project.path);
            if (node) {
              const nodeFilePath = await findNodeFileById(nid, project.path);
              out.push({
                nodeId: nid,
                title: node.frontmatter?.title || nid,
                summary: node.summary || '',
                filePath: nodeFilePath || '',
              });
            }
          } catch { /* skip */ }
        }
        result = out;
        break;
      }

      case 'getNodeManifest': {
        const { readManifest } = await import('@/lib/nodes/manifest');
        const project = await (data.projectId
          ? (async () => {
              const { getProjectById } = await import('@/lib/project/project-manager');
              return getProjectById(String(data.projectId));
            })()
          : getCurrentProject());
        if (!project) {
          result = [];
          break;
        }
        try {
          const nodesDir = join(project.path, 'notes-memory');
          const files = await fs.readdir(nodesDir);
          const mdFiles = files.filter((f) => f.endsWith('.md'));
          const entries: Array<{ nodeId: string; title: string; tags: string[]; depth: number }> = [];
          for (const f of mdFiles) {
            try {
              const content = await fs.readFile(join(nodesDir, f), 'utf-8');
              const parsed = parseNodeMarkdown(content);
              const nodeId = parsed.frontmatter.node_id || '';
              if (!nodeId) continue;
              const m = await readManifest(nodeId, project.path);
              const tags = Array.from(new Set(
                (m?.sections ?? []).map((s) => s.type),
              ));
              entries.push({
                nodeId,
                title: m?.title || parsed.frontmatter.title || f,
                tags,
                depth: 0,
              });
            } catch { /* skip corrupted */ }
          }
          result = entries;
        } catch {
          result = [];
        }
        break;
      }

      // ===== 技能检索、模型池、项目列表、总配置 =====

      case 'searchSkills': {
        const q = String(data.query || '').trim();
        const limit = Math.max(1, Math.min(30, typeof data.limit === 'number' ? data.limit : 8));
        const out: Array<{ id: string; name: string; description: string; category: string; installed: boolean; enabled: boolean }> = [];
        try {
          const { getAllSkills } = await import('@/lib/skills/loader-server');
          const { matchSkills } = await import('@/lib/skills/matcher');
          const all = await getAllSkills();
          const metas = all.map((s) => s.meta);
          const scored = q ? await matchSkills(q, metas) : metas.map((m) => ({ skillMeta: m, score: 1, matchedKeywords: [] as string[] }));
          for (const { skillMeta } of scored.slice(0, limit)) {
            out.push({
              id: skillMeta.name,
              name: skillMeta.name,
              description: String(skillMeta.description || ''),
              category: String(skillMeta.scenes?.[0] || ''),
              installed: true,
              enabled: true,
            });
          }
        } catch { /* empty */ }
        result = out;
        break;
      }

      case 'listConfiguredModels': {
        // 与 tools.ts 中 list_configured_models 工具输出格式保持一致
        const { readSettingsFromFile } = await import('@/lib/settings-server');
        const { PROVIDER_PRESETS } = await import('@/lib/types');
        const s = await readSettingsFromFile();
        const providers = s.providers ?? [];
        const models: Array<{ provider: string; providerLabel: string; modelId: string; label: string; description: string; supportsVision: boolean; isDefault: boolean }> = [];
        let defaultFound = false;
        for (const cfg of providers) {
          const preset = PROVIDER_PRESETS.find((p) => p.type === cfg.type);
          const providerLabel = preset?.label || String(cfg.type);
          const modelsList: Array<string | SelectedModelEntry> = Array.isArray(cfg.selectedModels) ? cfg.selectedModels : [];
          if (modelsList.length === 0) continue;
          for (let i = 0; i < modelsList.length; i++) {
            const entry = modelsList[i];
            const modelId = typeof entry === 'string' ? entry : entry.modelId ?? '';
            const label = typeof entry === 'string' ? entry : entry.label || modelId;
            const supportsVision = typeof entry === 'string' ? false : Boolean(entry.supportsVision);
            const isDefault = !defaultFound && cfg.apiKey?.trim() ? (defaultFound = true, true) : false;
            const desc = preset?.models.find((pm) => pm.modelId === modelId)?.description || '';
            models.push({
              provider: String(cfg.type),
              providerLabel,
              modelId,
              label,
              description: String(desc),
              supportsVision,
              isDefault,
            });
          }
        }
        result = { empty: models.length === 0, models };
        break;
      }

      case 'listProjects': {
        const { listProjects } = await import('@/lib/project/project-manager');
        const all = await listProjects();
        result = (all.active_projects || []).map((p) => {
          const e: ProjectConfig & { createdAt?: string; updatedAt?: string } = p;
          return {
            id: e.id,
            name: e.name,
            path: e.path,
            createdAt: e.createdAt,
            updatedAt: e.updatedAt,
          };
        });
        break;
      }

      case 'getAppConfig': {
        const { readSettingsFromFile, settingsFileExists } = await import('@/lib/settings-server');
        const { THEME_OPTIONS } = await import('@/lib/settings');
        const { PROVIDER_PRESETS } = await import('@/lib/types');
        const s = await readSettingsFromFile();
        const project = await getCurrentProject().catch(() => null) as ProjectConfig | null;
        const themeId = s.theme ?? 'warm';
        // 统一单一品牌色：始终使用预设主题信息（历史 custom 主题已被 normalizeCustomThemes 收敛）
        const opt = THEME_OPTIONS.find((t) => t.id === themeId);
        const themeName = opt?.label ?? themeId;
        const dark = opt?.dark ?? false;
        const providers = (s.providers ?? []).map((cfg) => {
          const preset = PROVIDER_PRESETS.find((p) => p.type === cfg.type);
          return {
            type: String(cfg.type),
            name: preset?.label || String(cfg.type),
            hasApiKey: Boolean(cfg.apiKey?.trim()),
            modelsCount: Array.isArray(cfg.selectedModels) ? cfg.selectedModels.length : 0,
          };
        });
        result = {
          themeId,
          themeName,
          dark,
          projectId: project?.id ?? '',
          projectName: project?.name ?? '',
          providersCount: providers.length,
          providers,
          version: process.env.npm_package_version || '',
          platform: PLATFORM,
          isFirstRun: !(await settingsFileExists().catch(() => false)),
          sandboxDataDir: join(resolveAppRoot(), BOB_SANDBOX_DIRNAME, 'apps'),
        };
        break;
      }

      // ===== 日历事件 =====

      case 'listCalendarEvents': {
        const scope = (data.scope === 'today' || data.scope === 'week' || data.scope === 'upcoming' || data.scope === 'all')
          ? data.scope
          : 'today';
        const events: Array<{ id: string; title: string; date: string; time?: string; repeat?: string; completed: boolean; note?: string }> = [];
        try {
          const project = await getCurrentProject();
          const calPath = join(project.path, 'calendar.json');
          const raw = JSON.parse(await fs.readFile(calPath, 'utf-8'));
          const arr = Array.isArray(raw) ? raw : (raw.events || []);
          const today = new Date().toISOString().slice(0, 10);
          const weekAfter = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
          for (const ev of arr) {
            const date = String(ev.date || '');
            if (scope === 'today' && date !== today) continue;
            if (scope === 'week' && (date < today || date > weekAfter)) continue;
            if (scope === 'upcoming' && date < today) continue;
            events.push({
              id: String(ev.id || ''),
              title: String(ev.title || ''),
              date,
              time: ev.time ? String(ev.time) : undefined,
              repeat: ev.repeat ? String(ev.repeat) : undefined,
              completed: Boolean(ev.completed),
              note: ev.note ? String(ev.note) : undefined,
            });
          }
        } catch { /* empty */ }
        result = events;
        break;
      }

      default:
        throw new Error('Unknown action: ' + action);
    } // end switch

    ok = true;
    return result;
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    // P2#14 统一审计：成功/失败都在这里落一条（单出口，避免双写）
    await appendAudit({
      t: new Date().toISOString(),
      action,
      appId,
      ok,
      msMs: Date.now() - started,
      error: errorMsg,
      dataBytes,
      detail: auditDetail,
      ...(auditClaimedAppId ? { claimedAppId: auditClaimedAppId, spoofSuspected: true } : {}),
    });
    // 每 16 次调用触发一次异步 rotate 检查（避免每次调 fs.stat）
    if (((Math.random() * 16) | 0) === 0) void rotateAuditIfNeeded();
  }
}


/**
 * Build the list of available actions as a human-readable string
 * for AI Coding system prompt injection.
 */
export function getBridgeActionsText(): string {
  const lines = BRIDGE_ACTIONS.map((a) => {
    const params = a.params ? ` (${a.params.join(', ')})` : '';
    return `  - ${a.action}${params}: ${a.description} → ${a.returns || 'void'}`;
  });
  return lines.join('\n');
}
