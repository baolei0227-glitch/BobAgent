/**
 * Bob Sandbox postMessage Bridge
 *
 * Allows mini-apps running in the sandbox iframe to call a whitelist
 * of BobWork host APIs via window.parent.postMessage.
 *
 * Protocol:
 *   App → Host:  { type: 'bob_request',  id, action, data }
 *   Host → App:  { type: 'bob_response', id, success, data?, error? }
 *
 * Storage layers (exposed via injected window.BobStorage):
 *   1. BobStorage.set/get  →  browser localStorage, auto-prefixed with APP_ID
 *   2. BobStorage.save/load → ~/BobWork/bob-sandbox/apps/<APP_ID>/data/<key>.json  (disk, survives restart)
 *   3. BobStorage.writeWanted → ~/BobWork/wanted/  (global delivery, requires explicit user request)
 */

import { join } from 'path';
import { promises as fs } from 'fs';
import { z } from 'zod';
import { resolveAppRoot, BOB_SANDBOX_DIRNAME } from '@/lib/app-root';
import { getCurrentProject, type ProjectConfig } from '@/lib/project/project-manager';
import { findNodeFileById, parseNodeMarkdown } from '@/lib/node-markdown';
import { GRAPH_BRIDGE_ACTIONS } from '@/lib/graph/graph-bridge';
import { getSandboxChatPermission } from '@/lib/settings';
import { executeSandboxChat, type SandboxChatMessage } from '@/lib/sandbox/chat-bridge';
import { callNotes, renderNotesText } from '@/lib/mcp/notes-bridge';

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
    description: 'Write a file to the global wanted/ directory',
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
    description: 'Read canvas snapshot: nodes, edges, viewport (requires read)',
    returns: 'GraphSnapshot',
  },
  {
    action: 'graphGetViewport',
    description: 'Read current canvas viewport { x, y, zoom } (requires read)',
    returns: 'ViewportState',
  },
  {
    action: 'graphExpandNode',
    description: 'Expand a node container (requires control)',
    params: ['nodeId:string'],
    returns: '{ ok: true }',
  },
  {
    action: 'graphCollapseNode',
    description: 'Collapse a node container (requires control)',
    params: ['nodeId:string'],
    returns: '{ ok: true }',
  },
  {
    action: 'graphSetViewport',
    description: 'Set canvas viewport (requires control)',
    params: ['viewport:{ x, y, zoom }'],
    returns: '{ ok: true }',
  },
  {
    action: 'graphFitView',
    description: 'Fit view to all nodes (requires control)',
    params: ['padding?:number'],
    returns: '{ ok: true }',
  },
  {
    action: 'graphZoomBy',
    description: 'Zoom canvas by delta (requires control)',
    params: ['delta:number'],
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
  // 无工具裸模型对话（纯文本进出）。必须先在宿主端经 chatRequestPermission 获得授权；
  // 服务端再强制：模型白名单（仅已配置勾选模型）+ 单次 token 上限 + 出口审计。
  {
    action: 'chatGetPermission',
    description: 'Query whether this app is granted the model-call (chat) permission',
    returns: '{ granted: boolean }',
  },
  {
    action: 'chatRequestPermission',
    description: 'Request model-call permission from the user (host shows a confirmation dialog)',
    returns: '{ granted: boolean }',
  },
  {
    action: 'chat',
    description:
      'Call the AI model (no tools, plain text). Requires chat permission + a model from the configured pool. ' +
      'Params: model "provider:modelId" (optional, auto-picks from your configured model pool), messages [{role, content}], ' +
      'maxTokens (clamped server-side), temperature. Output capped at 2048 tokens.',
    params: ['model?:string', 'messages:Array<{role,content}>', 'maxTokens?:number', 'temperature?:number'],
    returns: '{ content, model, usage? }',
  },
  {
    action: 'chatStream',
    description:
      'Call the AI model with streaming output (no tools, plain text). Same permissions as chat. ' +
      'Use BobWork.chatStream({ model?, messages, onDelta }) which resolves incrementally; ' +
      'onDelta(text) receives each text delta as it is generated.',
    params: ['model?:string', 'messages:Array<{role,content}>', 'onDelta:(text)=>void', 'maxTokens?:number', 'temperature?:number'],
    returns: 'Promise<{ model, provider, usage? }> (via onDelta for incremental text)',
  },
  // ===== WANTED（亲儿子：宿主 WANTED 直接读，小程序作全局信息面板）=====
  {
    action: 'readWantedTodo',
    description: 'Read the WANTED to-do list (merged into the events DB). Pass optional filter: "today" / date (YYYY-MM-DD) / category. Returns markdown or null.',
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
    description: 'Read the full user preferences record at wanted/preferences.md. Pass optional type (e.g. "output-format", "reference-spec") to filter a category.',
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
export function buildBridgeClientScript(appId: string): string {
  const safeAppId = JSON.stringify(appId);
  return `
<script>
(function() {
  var APP_ID = ${safeAppId};
  var pendingRequests = {};
  var chatStreams = {};
  var requestId = 0;

  // 人工确认型动作：宿主端会弹出确认框等待用户选择，请求超时需放宽（普通动作 10s）
  var MANUAL_CONFIRM_TIMEOUT = 120000;
  var MANUAL_CONFIRM_ACTIONS = ['chatRequestPermission', 'graphRequestPermission', 'writeWanted'];

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
  var HOST_TARGET_ORIGIN = resolveTargetOrigin();

  function postToHost(msg) {
    if (HOST_TARGET_ORIGIN) {
      try { window.parent.postMessage(msg, HOST_TARGET_ORIGIN); return; } catch (_) {}
    }
    // file:// / localhost dev tolerant
    try { window.parent.postMessage(msg, '*'); } catch (_) {}
  }

  // ===== window.BobWork =====
  window.BobWork = {
    request: function(action, data) {
      data = data || {};
      // 自动注入本小程序 appId，宿主据此做权限校验（graph* 动作必需）
      data._appId = APP_ID;
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
        var manualConfirm = MANUAL_CONFIRM_ACTIONS.indexOf(action) >= 0;
        setTimeout(function() {
          if (pendingRequests[id]) {
            delete pendingRequests[id];
            reject(new Error('BobWork.request timeout: ' + action));
          }
        }, manualConfirm ? MANUAL_CONFIRM_TIMEOUT : 10000);
      });
    },
    listActions: function() {
      return window.BobWork.request('listActions');
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
        _appId: APP_ID
      };
      var id = 'stream_' + (++requestId);
      var onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : function() {};
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
      var raw = localStorage.getItem(SOFT_RELOAD_KEY);
      if (!raw) return false;
      // One-shot: delete immediately so no cross-session stale recovery
      localStorage.removeItem(SOFT_RELOAD_KEY);
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
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (!k || k.indexOf(LS_PREFIX) !== 0) continue;
          var v = localStorage.getItem(k);
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
        var prev = localStorage.getItem(k);
        if (prev !== null) sizeDelta -= (k.length * 2) + (prev.length * 2);
        var current = window.BobStorage.lsUsedBytes();
        if (current + sizeDelta > window.BobStorage.LS_APP_QUOTA_BYTES) {
          throw new Error('BobStorage.set quota exceeded: Layer1 app limit is ' + window.BobStorage.LS_APP_QUOTA_BYTES + ' bytes');
        }
        localStorage.setItem(k, serialized);
        return true;
      } catch (e) { return false; }
    },
    get: function(key) {
      try {
        var raw = localStorage.getItem(toLSKey(key));
        return raw == null ? null : JSON.parse(raw);
      } catch (e) { return null; }
    },
    remove: function(key) {
      try { localStorage.removeItem(toLSKey(key)); return true; }
      catch (e) { return false; }
    },
    listLocalKeys: function() {
      var out = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
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

    // ---- Layer 3: write to global wanted/ (final deliverables) ----
    writeWanted: function(filename, content) {
      return window.BobWork.request('writeWanted', { filename: filename, content: content });
    }
  };

  // Listen for responses from host (also verify origin when possible)
  window.addEventListener('message', function(event) {
    // Only accept messages from trusted host origin
    if (HOST_TARGET_ORIGIN && event.origin !== HOST_TARGET_ORIGIN) {
      // file:// contexts: both origins are 'null' – be permissive only there
      if (!(HOST_TARGET_ORIGIN === 'null' && event.origin === 'null')) return;
    }
    var msg = event.data;
    if (!msg) return;

    // P0#9: Host requests snapshot capture (before file-save reload)
    if (msg.type === 'bob_soft_reload') {
      try {
        var snap = captureUISnapshot();
        if (snap) localStorage.setItem(SOFT_RELOAD_KEY, snap);
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
    if (HOST_TARGET_ORIGIN && event.origin !== HOST_TARGET_ORIGIN) {
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
  }).strict(),
  loadAppData: z.object({
    appId: z.string().min(1).max(64),
    key: z.string().min(1).max(256),
  }).strict(),
  listAppDataKeys: z.object({ appId: z.string().min(1).max(64) }).strict(),
  deleteAppData: z.object({
    appId: z.string().min(1).max(64),
    key: z.string().min(1).max(256),
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
  // ===== WANTED 亲儿子只读接口 =====
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
};
function sandboxAuditLogPath() {
  return join(resolveAppRoot(), BOB_SANDBOX_DIRNAME, 'audit.log');
}
async function appendAudit(e: AuditEntry) {
  try {
    const dir = join(resolveAppRoot(), BOB_SANDBOX_DIRNAME);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(sandboxAuditLogPath(), JSON.stringify(e) + '\n', 'utf-8');
  } catch {
    // 审计写失败不能中断业务
  }
}
/** 单进程内存阈值：超过后滚动裁剪（保留后半段），避免单文件无限增长 */
const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
async function rotateAuditIfNeeded() {
  try {
    const path = sandboxAuditLogPath();
    const st = await fs.stat(path);
    if (st.size <= AUDIT_MAX_BYTES) return;
    const raw = await fs.readFile(path, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    const keep = lines.slice(Math.floor(lines.length / 2));
    await fs.writeFile(path, keep.join('\n') + '\n', 'utf-8');
  } catch { /* ignore */ }
}

export async function handleBridgeRequest(
  action: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  const started = Date.now();
  let appId: string | undefined;
  let dataBytes: number | undefined;
  let ok = false;
  let errorMsg: string | undefined;
  try {
    // ============= P2#4：统一 schema 解析 =============
    const schema = ActionSchemas[action];
    if (schema) {
      const parsed = schema.safeParse(data ?? {});
      if (!parsed.success) {
        throw new Error(formatZodError(parsed.error));
      }
      // 替换为已解析且严格剥离了额外字段的 payload，防止字段注入
      data = (parsed.data ?? {}) as Record<string, unknown>;
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
        const content = String(data.content ?? '');
        if (!filename) throw new Error('filename is required');
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const wantedDir = join(resolveAppRoot(), 'wanted');
        await fs.mkdir(wantedDir, { recursive: true });
        const filePath = join(wantedDir, safeName);
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
        const _appId = String(data.appId ?? '');
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
        const _appId = String(data.appId ?? '');
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
        const _appId = String(data.appId ?? '');
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
        const _appId = String(data.appId ?? '');
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
        const _appId = String((data as Record<string, unknown>)._appId ?? data.appId ?? '');
        if (!_appId) throw new Error('appId is required');
        const level = await getSandboxChatPermission(_appId);
        // 返回布尔 granted（level !== 'none'）+ 具体 level：
        // 兼容旧版 boolean 语义（小程序 if (r.granted) 判断）与三级授权展示
        result = { granted: level !== 'none', level };
        break;
      }

      case 'chat': {
        const _appId = String((data as Record<string, unknown>)._appId ?? data.appId ?? '');
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

      // ===== WANTED（亲儿子：宿主 WANTED 全系列只读）=====

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
          content = await fs.readFile(join(resolveAppRoot(), 'wanted', 'preferences.md'), 'utf-8');
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
          const modelsList = Array.isArray(cfg.selectedModels) ? cfg.selectedModels : [];
          if (modelsList.length === 0) continue;
          for (let i = 0; i < modelsList.length; i++) {
            const entry = modelsList[i];
            const modelId = typeof entry === 'string' ? entry : (entry as any).modelId;
            const label = typeof entry === 'string' ? entry : (entry as any).label || modelId;
            const supportsVision = Boolean(typeof entry !== 'string' && entry && (entry as any).supportsVision);
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
        result = (all.active_projects || []).map((p) => ({
          id: (p as any).id,
          name: (p as any).name,
          path: (p as any).path,
          createdAt: (p as any).createdAt,
          updatedAt: (p as any).updatedAt,
        }));
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
          platform: process.platform,
          isFirstRun: !(await settingsFileExists().catch(() => false)),
          sandboxDataDir: join(resolveAppRoot(), BOB_SANDBOX_DIRNAME, 'apps'),
        } as any;
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
