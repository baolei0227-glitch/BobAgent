/**
 * Agent 工具系统 — admin 场景（配置 / 模型 / 沙盒运维）
 *
 * 从 tools/index.ts 抽出：10 个 admin 场景工具的定义与 executor。
 * 依赖方向单向：本模块 import registry.ts 的运行时单例（registry），
 * 仅以 import type 依赖 index.ts 的类型（编译期擦除），不产生运行时循环依赖。
 */

import { join, sep, dirname, basename } from 'path';
import { readSettingsFromFile } from '@/lib/settings-server';
import { resolveAppRoot, SANDBOX_DIRNAME } from '@/lib/app-root';
import { mcpManager } from '@/lib/mcp/manager';
import { PROVIDER_PRESETS, sanitizeBaseUrl } from '@/lib/types';
import type { ProviderConfig, SelectedModel } from '@/lib/types';
import type { Tool } from './index';
import { SANDBOX_APPS_DIR } from './shared';
import { registry } from './registry';

/**
 * Bob Sandbox 小程序文件回滚（.history 版本快照）。
 * - action=list：列出指定文件的全部历史版本（时间戳）；
 * - action=restore：把指定时间戳版本（或最近一份）写回，恢复旧内容。
 * 快照由 writeAppFileAtomic 写入文件时自动产生（.history/<相对路径>/<时间戳>-<文件名>）。
 */
async function toolSandboxRollback(args: Record<string, unknown>): Promise<string> {
  const appId = String(args.appId ?? '');
  const file = String(args.file ?? '');
  const action = args.action === 'restore' ? 'restore' : 'list';
  const stamp = String(args.stamp ?? '');
  if (!appId) return 'Error: appId required';
  if (!file) return 'Error: file required（app 内相对路径，如 index.html）';
  try {
    const { readdir, readFile, writeFile, stat } = await import('fs/promises');
    // 路径穿越校验：file 必须落在 app 目录内
    const appDir = join(SANDBOX_APPS_DIR, appId);
    const target = join(appDir, file);
    if (target !== appDir && !target.startsWith(appDir + sep)) {
      return 'Error: file 越界（必须是小程序目录内的相对路径）';
    }
    const historyDir = join(appDir, '.history', dirname(file));
    const prefix = `${basename(file)}`; // 备份文件名格式：<时间戳>-<basename>
    let entries: string[] = [];
    try {
      entries = (await readdir(historyDir)).filter((n) => n.endsWith(prefix) && n.length > prefix.length);
    } catch {
      entries = [];
    }
    if (action === 'list' || entries.length === 0) {
      if (entries.length === 0) return `无历史版本：${appId}/${file}（尚无 write_file / edit_code 写入记录）`;
      const lines: string[] = [];
      for (const n of entries) {
        const p = join(historyDir, n);
        const s = await stat(p).catch(() => null);
        lines.push(`- ${n}${s ? ` (${new Date(s.mtime).toISOString()})` : ''}`);
      }
      return `历史版本（共 ${entries.length} 份，时间戳即文件名前缀）：\n${lines.join('\n')}\n恢复请调用 sandbox_rollback(appId, file, action="restore", stamp="<时间戳前缀>")`;
    }
    // restore：stamp 为空取最近一份（按文件名时间戳排序取最后）
    entries.sort();
    const match = stamp
      ? entries.find((n) => n.startsWith(stamp))
      : entries[entries.length - 1];
    if (!match) return `Error: 未找到时间戳 "${stamp}" 对应的历史版本。可用 action="list" 查看。`;
    const content = await readFile(join(historyDir, match), 'utf-8');
    await writeFile(target, content, 'utf-8');
    return `已回滚 ${appId}/${file} → ${match}（${content.length} chars）。请用 capture_preview 复核渲染效果。`;
  } catch (e) {
    return `Rollback failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Bob Sandbox 小程序导出为独立单文件 HTML（发布/分享用）：
 * 内联 app 内相对引用的 css/js（<link href> / <script src>），CDN 外链保留。
 * 输出到 bob-sandbox/exports/<appId>-<ts>.html。
 */
async function toolSandboxExport(args: Record<string, unknown>): Promise<string> {
  const appId = String(args.appId ?? '');
  if (!appId) return 'Error: appId required';
  try {
    const { mkdir, writeFile } = await import('fs/promises');
    const { readAppEntry } = await import('@/lib/sandbox/apps');
    const entry = await readAppEntry(appId);
    if (!entry) return `Error: 小程序 ${appId} 不存在`;
    const appDir = join(SANDBOX_APPS_DIR, appId);
    let html = entry.content;

    // 内联相对引用的 css：<link rel="stylesheet" href="x.css">
    html = html.replace(/<link\b([^>]*)\bhref=["']([^"'http][^"']*\.css(?:\?[^"']*)?)["']([^>]*)>/gi, (_m, pre, href, post) => {
      try {
        const cssPath = join(appDir, href.split('?')[0]);
        const css = readFileSyncSafe(cssPath);
        if (css == null) return _m;
        return `<style data-inlined="${href}">${css}</style>`;
      } catch {
        return _m;
      }
    });
    // 内联相对引用的 js：<script src="x.js">
    html = html.replace(/<script\b([^>]*)\bsrc=["']([^"'http][^"']*\.js(?:\?[^"']*)?)["']([^>]*)><\/script>/gi, (_m, pre, href, post) => {
      try {
        const jsPath = join(appDir, href.split('?')[0]);
        const js = readFileSyncSafe(jsPath);
        if (js == null) return _m;
        return `<script data-inlined="${href}">${js}<\/script>`;
      } catch {
        return _m;
      }
    });

    const exportsDir = join(resolveAppRoot(), SANDBOX_DIRNAME, 'exports');
    await mkdir(exportsDir, { recursive: true });
    const ts = Date.now();
    const outPath = join(exportsDir, `${appId}-${ts}.html`);
    await writeFile(outPath, html, 'utf-8');
    return `已导出独立页面：${outPath}\n（${html.length} chars；app 内相对 css/js 已内联，CDN 外链保留。可直接用浏览器打开或分享）`;
  } catch (e) {
    return `Export failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 同步读文件（导出内联用）；失败返回 null */
function readFileSyncSafe(p: string): string | null {
  try {
    const fs = require('fs');
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/** 常用 MCP 推荐目录（内置写死，本地盘点用；不触网） */
const KNOWN_MCP_CATALOG: Array<{ id: string; name: string; purpose: string; how: string }> = [
  { id: 'bob-browser-mcp', name: 'Bob Browser', purpose: '真实浏览器自动化（导航/点击/填表/抓取反爬站）', how: 'bob-browser-mcp --serve 常驻 + streamable-http 接入' },
  { id: 'github', name: 'GitHub', purpose: 'GitHub 仓库/代码搜索、文件读写、PR/Issue', how: 'stdio npx @modelcontextprotocol/server-github + GITHUB_PERSONAL_ACCESS_TOKEN' },
  { id: 'context7', name: 'Context7', purpose: '代码库/框架文档查询', how: 'streamable-http https://mcp.context7.com/mcp' },
  { id: 'pkulaw', name: '北大法宝', purpose: '法律法规/案例检索（法律场景）', how: 'streamable-http pkulaw 网关' },
  { id: 'tianyancha', name: '天眼查', purpose: '企业工商/风险/知识产权查询', how: 'streamable-http mcp.tianyancha.com + API Key' },
  { id: 'brave-search', name: 'Brave Search', purpose: '网页搜索 API（快/结构化；内置 web_search 可替代）', how: 'stdio npx @modelcontextprotocol/server-brave-search + BRAVE_API_KEY' },
  { id: 'filesystem', name: 'Filesystem', purpose: '文件系统操作（与内置文件工具重复，通常不需要）', how: 'stdio npx @modelcontextprotocol/server-filesystem' },
  { id: 'notion', name: 'Notion', purpose: 'Notion 文档/数据库操作', how: 'stdio npx @modelcontextprotocol/server-notion + token' },
  { id: 'excel-mcp', name: 'Excel', purpose: 'Excel 读写（内置 openpyxl 可替代，通常不需要）', how: 'npx excel-mcp-server（社区包）' },
];

/** check_mcp_gaps 工具：本地盘点 MCP 配置/连接状态（不触网），供模型感知能力缺口并引导用户配置 */
async function toolCheckMcpGaps(args: Record<string, unknown>): Promise<string> {
  try {
    const need = String(args.need || '').trim().toLowerCase();
    const settings = await readSettingsFromFile();
    const servers = settings.mcpServers || [];
    const connIds = new Set(mcpManager.getConnectedServers().map((s) => s.id));

    // settings 中实际配置（含用户自定义条目）→ 配置状态
    const cfgById = new Map<string, { name: string; enabled: boolean; transport?: string; url?: string; command?: string; hasSecret: boolean }>();
    for (const s of servers) {
      const env = (s as { env?: Record<string, unknown> }).env || {};
      cfgById.set(s.id, {
        name: s.name || s.id,
        enabled: s.enabled !== false,
        transport: s.transport,
        url: s.url,
        command: s.command,
        hasSecret: Object.values(env).some((v) => typeof v === 'string' && v.length > 0),
      });
    }

    // 目录：内置推荐 + settings 里出现但目录外的（自定义）
    const entries = new Map<string, { id: string; name: string; purpose: string; how: string }>();
    for (const c of KNOWN_MCP_CATALOG) entries.set(c.id, c);
    for (const s of servers) {
      if (!entries.has(s.id)) {
        entries.set(s.id, { id: s.id, name: s.name || s.id, purpose: '（用户自定义 MCP）', how: `${s.transport || ''} ${s.url || s.command || ''}`.trim() });
      }
    }

    const lines: string[] = ['MCP status (local BobWork config only, no internet):'];
    for (const [id, c] of entries) {
      const cfg = cfgById.get(id);
      const rel = need && `${c.name} ${c.purpose}`.toLowerCase().includes(need) ? '  ← relevant' : '';
      if (!cfg) {
        lines.push(`✗ not_configured  ${id} — ${c.purpose} | 配置：${c.how}${rel}`);
      } else if (!cfg.enabled) {
        lines.push(`○ disabled  ${id} — ${c.purpose}${cfg.hasSecret ? '' : '（未填密钥）'} | 配置：${c.how}${rel}`);
      } else if (connIds.has(id)) {
        const toolCount = registry.listAll().filter((t) => t.name.startsWith(`mcp__${id}__`)).length;
        lines.push(`● connected  ${id} — ${c.purpose} (${toolCount} tools)${rel}`);
      } else {
        const why = cfg.url ? `url=${cfg.url}` : cfg.command ? `command=${cfg.command}` : '(no transport)';
        lines.push(`△ enabled_but_disconnected  ${id} — ${c.purpose} | ${why}${cfg.hasSecret ? '' : '（未填密钥）'}${rel}`);
      }
    }
    lines.push('\n提示：MCP 在 设置 → MCP Servers 面板配置；未 connected 的 MCP 其工具对模型不可见。');
    return lines.join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 聊天厂商 type 白名单 */
const CHAT_PROVIDER_TYPES = new Set(['deepseek', 'glm', 'moonshot', 'qwen', 'openai', 'doubao']);
/** STT 厂商 type 白名单 */
const STT_PROVIDER_TYPES = new Set(['doubao-stream', 'doubao', 'dashscope', 'siliconflow', 'openai']);

/** get_app_config 工具：只读当前配置摘要 */
async function toolGetAppConfig(_args: Record<string, unknown>): Promise<string> {
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const s = await readSettingsFromFile();
    const summary = {
      providers: (s.providers || []).map((p) => ({
        type: p.type,
        hasApiKey: !!p.apiKey,
        apiKeyLen: p.apiKey?.length || 0,
        baseUrl: p.baseUrl || '(default)',
        models: (p.selectedModels ?? []).map((m) => m.modelId),
      })),
      // 视觉模型配置已收敛到 bob-ocr-mcp 插件（数据根 config.json 的 vision 字段，BobWork 托管：~/BobWork/extensions/bob-ocr-mcp）
      vision: { note: 'managed by bob-ocr-mcp plugin (see /settings)' },
      taskModel: {
        provider: s.chatModel?.defaultProvider || '(未配置)',
        model: s.chatModel?.defaultModel || '(未配置)',
        hasApiKey: !!s.chatModel?.apiKey,
      },
      outcomeModel: {
        provider: s.chatModel?.defaultProvider || '(未配置)',
        model: s.chatModel?.defaultModel || '(未配置)',
        hasApiKey: !!s.chatModel?.apiKey,
      },
      stt: {
        provider: s.stt?.provider || '(未配置)',
        model: s.stt?.model || '(未配置)',
        hasApiKey: !!s.stt?.apiKey,
      },
      avatar: s.avatar || { mode: 'random' },
      brandLogo: s.brandLogo || '(default)',
      mcpServers: (s.mcpServers || []).map((m) => ({
        id: m.id,
        name: m.name,
        transport: m.transport,
        enabled: m.enabled,
        url: m.url,
        command: m.command,
        args: m.args,
      })),
      customTools: (s.customTools || []).map((t) => ({ name: t.name, enabled: t.enabled, endpoint: t.endpoint })),
      theme: {
        current: s.theme ?? 'warm',
      },
    };
    return JSON.stringify(summary, null, 2);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** list_configured_models 工具：列出用户已配置模型池中的可用模型（只读）。
 *  供 AI Coding 节点在用户同意接入 AI 功能后，询问用户选择哪个模型使用。 */
async function toolListConfiguredModels(_args: Record<string, unknown>): Promise<string> {
  try {
    const s = await readSettingsFromFile();
    const providers: ProviderConfig[] = s.providers ?? [];

    if (providers.length === 0) {
      return JSON.stringify({
        empty: true,
        message: '模型池为空。请先在 Manage Models 中配置厂商 API Key 并勾选模型，然后再为小程序接入 AI。',
        providers: [],
      });
    }

    const result = providers.map((config) => {
      const preset = PROVIDER_PRESETS.find((p) => p.type === config.type);
      const presetLabel = preset?.label ?? config.type;
      const selected: SelectedModel[] = config.selectedModels ?? [];
      const models = selected.map((sel) => {
        const modelId = sel.modelId;
        const presetModel = preset?.models.find((m) => m.modelId === modelId);
        return {
          modelId,
          fullId: `${config.type}:${modelId}`,
          label: presetModel?.label ?? modelId,
          description: presetModel?.description ?? '',
          thinking: sel.thinking,
          purpose: sel.purpose ?? 'chat',
        };
      });
      return {
        provider: config.type,
        label: presetLabel,
        hasApiKey: Boolean(config.apiKey?.trim()),
        baseUrl: config.baseUrl || preset?.baseUrl || '',
        models,
      };
    });

    const totalModels = result.reduce((sum, p) => sum + p.models.length, 0);
    return JSON.stringify({
      empty: totalModels === 0,
      totalModels,
      providers: result,
      hint: '模型 ID 格式为 "provider:modelId"（如 deepseek:deepseek-v4-flash）。在小程序中通过 BobWork.request("chat", { model: "provider:modelId", messages: [...] }) 调用。省略 model 参数则走 Auto 模式自动选择。',
    }, null, 2);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** set_app_icon 工具：设置欢迎窗口头像 / 侧边栏品牌 logo */
async function toolSetAppIcon(args: Record<string, unknown>): Promise<string> {
  try {
    const target = String(args.target ?? '').trim();
    if (target !== 'avatar' && target !== 'logo') {
      return 'Error: target 必须是 avatar（欢迎头像）或 logo（侧边栏 logo）';
    }
    const { readSettingsFromFile, writeSettingsToFile } = await import('@/lib/settings-server');
    const s = await readSettingsFromFile();

    if (target === 'avatar') {
      const mode = args.mode === 'fixed' ? 'fixed' : 'random';
      s.avatar = { mode };
      if (mode === 'fixed') {
        const selected = String(args.selected ?? '').trim();
        if (!selected) return 'Error: mode=fixed 时必须提供 selected（头像池 id，如 builtin/pumpkin-a.png）';
        s.avatar.selected = selected;
      }
    } else {
      const selected = String(args.selected ?? '').trim();
      s.brandLogo = selected || undefined; // 空字符串 → 恢复默认 logo
    }

    await writeSettingsToFile(s);
    return JSON.stringify({
      success: true,
      target,
      ...(target === 'avatar' ? { avatar: s.avatar } : { brandLogo: s.brandLogo || '(default)' }),
    });
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** update_provider_config 工具：设置厂商 Key / 角色模型 */
async function toolUpdateProviderConfig(args: Record<string, unknown>): Promise<string> {
  try {
    const target = String(args.target ?? '').trim();
    const provider = String(args.provider ?? '').trim();
    const apiKey = args.apiKey !== undefined ? String(args.apiKey) : undefined;
    const baseUrl = args.baseUrl !== undefined ? String(args.baseUrl) : undefined;
    const model = args.model !== undefined ? String(args.model).trim() : undefined;

    if (!target || !provider) return 'Error: target 与 provider 均为必填';

    const { readSettingsFromFile, writeSettingsToFile } = await import('@/lib/settings-server');
    const s = await readSettingsFromFile();

    if (target === 'provider') {
      if (!CHAT_PROVIDER_TYPES.has(provider)) {
        return `Error: 未知聊天厂商 '${provider}'。可用: ${[...CHAT_PROVIDER_TYPES].join(', ')}`;
      }
      let cfg = s.providers.find((p) => p.type === provider as ProviderConfig['type']);
      if (!cfg) {
        cfg = { type: provider as ProviderConfig['type'], apiKey: '', selectedModels: [] };
        s.providers.push(cfg);
      }
      if (apiKey !== undefined) cfg.apiKey = apiKey;
      if (baseUrl !== undefined) cfg.baseUrl = baseUrl || undefined;
      if (model) {
        const list = cfg.selectedModels ?? (cfg.selectedModels = []);
        if (!list.some((m) => m.modelId === model)) {
          list.push({ modelId: model, thinking: true } as SelectedModel);
        }
      }
    } else if (target === 'vision' || target === 'task' || target === 'outcome' || target === 'stt') {
      // task / outcome 已统一复用 chatModel；保留 target 枚举用于向后兼容 AI 调用
      const isChatRole = target === 'task' || target === 'outcome';
      const roleKey: string = isChatRole ? 'chatModel'
        : target === 'vision' ? 'vision'
        : 'stt';
      const sRoles = s as unknown as Record<string, Record<string, unknown>>;
      const role = sRoles[roleKey] = sRoles[roleKey] || {};
      if (target === 'stt') {
        if (!STT_PROVIDER_TYPES.has(provider)) return `Error: 未知 STT 厂商 '${provider}'。可用: ${[...STT_PROVIDER_TYPES].join(', ')}`;
        role.provider = provider;
        if (model !== undefined) role.model = model;
        if (apiKey !== undefined) role.apiKey = apiKey;
        if (baseUrl !== undefined) role.baseUrl = baseUrl;
      } else {
        if (!CHAT_PROVIDER_TYPES.has(provider)) return `Error: 未知厂商 '${provider}'。可用: ${[...CHAT_PROVIDER_TYPES].join(', ')}`;
        role.defaultProvider = provider;
        if (model !== undefined) role.defaultModel = model;
        if (apiKey !== undefined) role.apiKey = apiKey;
        if (baseUrl !== undefined) role.baseUrl = baseUrl;
      }
    } else {
      return 'Error: target 必须是 provider/vision/task/outcome/stt（task/outcome 已归入主对话模型）';
    }

    await writeSettingsToFile(s);
    return JSON.stringify({
      success: true,
      target,
      provider,
      ...(apiKey !== undefined ? { apiKeySet: !!apiKey } : {}),
      ...(model !== undefined ? { model } : {}),
    });
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** test_model 工具：验证模型连接（TRAE 式校验，复用 /api/test-model 同逻辑） */
async function toolTestModel(args: Record<string, unknown>): Promise<string> {
  try {
    const provider = String(args.provider ?? '').trim();
    if (!provider) return 'Error: provider 为必填';

    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const s = await readSettingsFromFile();

    const cfg = s.providers.find((p) => p.type === provider);
    if (!cfg) return `Error: 设置中未找到厂商 '${provider}'`;
    if (!cfg.apiKey) return `Error: 厂商 '${provider}' 未配置 API Key`;

    // 确定要测试的模型列表
    const models = Array.isArray(args.models) && args.models.length > 0
      ? args.models.map(String)
      : (cfg.selectedModels ?? []).map((m) => m.modelId);

    if (models.length === 0) {
      return `Error: 厂商 '${provider}' 没有已勾选的模型，且未传入 models 参数`;
    }

    // 解析 Base URL（清理端点后缀 + 回退到预设默认值）
    const preset = PROVIDER_PRESETS.find((p) => p.type === provider);
    const base = sanitizeBaseUrl(cfg.baseUrl || preset?.baseUrl || '');
    if (!base) return `Error: 无法解析厂商 '${provider}' 的 Base URL`;

    // 逐模型测试
    const results: Array<{ modelId: string; ok: boolean; status?: number; error?: string }> = [];

    for (const modelId of models) {
      const id = modelId.toLowerCase();
      let path: string;
      let body: object;
      let timeout: number;

      if (/seedream|seededit|gpt-image|qwen-image|dall-?e|flux|sdxl|stable-diffusion|image-edit/.test(id)) {
        path = 'images/generations';
        body = { model: modelId, prompt: 'a red circle', n: 1 };
        timeout = 100000;
      } else if (/tts|speech|voice/.test(id)) {
        path = 'services/tts';
        body = { model: modelId, input: 'hi' };
        timeout = 8000;
      } else if (/asr|whisper|qwen-audio/.test(id)) {
        path = 'audio/transcriptions';
        body = { model: modelId };
        timeout = 8000;
      } else {
        path = 'chat/completions';
        body = { model: modelId, messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 16 };
        timeout = 8000;
      }

      try {
        const resp = await fetch(`${base}/${path}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });

        if (resp.ok) {
          results.push({ modelId, ok: true });
        } else {
          const text = await resp.text().catch(() => '');
          let errorMsg = text.slice(0, 200);
          if (/ModelNotFound|model.*not.*found|NoSuchModel|does not exist|do not have access|InvalidEndpointOrModel|UnsupportedModel/i.test(text)) {
            errorMsg = '模型不存在或未开通：请确认模型 ID 正确并在方舟控制台开通该模型服务（订阅制还需确认该模型在当前套餐档位内）';
          } else if (/rate.?limit|RateLimit/i.test(text)) {
            errorMsg = 'RPM 限流：每分钟请求数超限，请稍后重试或检查方舟控制台模型配额';
          }
          // TTS/STT 端点 404 特殊提示
          if (resp.status === 404 && (path === 'services/tts' || path === 'audio/transcriptions')) {
            errorMsg = '当前网关不支持语音端点（TTS/STT）：语音模型需在火山语音平台单独开通，或订阅制请改用 doubao-seed-asr-2.0 等 HTTP 端点模型';
          }
          results.push({ modelId, ok: false, status: resp.status, error: errorMsg });
        }
      } catch (err) {
        const isTimeout = err instanceof Error && /abort|timeout/i.test(err.message);
        results.push({
          modelId,
          ok: false,
          error: isTimeout
            ? 'Timeout (image generation can take 60-90s, retry later or check the Ark console)'
            : (err instanceof Error ? err.message : String(err)),
        });
      }
    }

    return JSON.stringify({ provider, baseUrl: base, results }, null, 2);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** manage_mcp_server 工具：MCP 服务器增删改 + 立即重连 */
async function toolManageMcpServer(args: Record<string, unknown>): Promise<string> {
  try {
    const action = String(args.action ?? '').trim();
    if (!['add', 'update', 'toggle', 'remove'].includes(action)) {
      return 'Error: action 必须是 add/update/toggle/remove';
    }
    const server = (args.server ?? {}) as Record<string, unknown>;
    const { readSettingsFromFile, writeSettingsToFile } = await import('@/lib/settings-server');
    const s = await readSettingsFromFile();
    const servers = s.mcpServers ?? (s.mcpServers = []);

    const findTarget = () =>
      servers.find((m) => (server.id && m.id === String(server.id)) || (server.name && m.name === String(server.name)));

    if (action === 'add') {
      const name = String(server.name ?? '').trim();
      if (!name) return 'Error: add 操作必须提供 server.name';
      const id = server.id ? String(server.id) : `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server'}-${Date.now().toString(36)}`;
      if (servers.some((m) => m.id === id)) return `Error: id '${id}' 已存在`;
      const transport = server.transport === 'stdio' ? 'stdio' : 'streamable-http';
      servers.push({
        id,
        name,
        transport,
        command: server.command ? String(server.command) : undefined,
        args: Array.isArray(server.args) ? server.args.map(String) : undefined,
        env: server.env && typeof server.env === 'object' ? (server.env as Record<string, string>) : undefined,
        url: server.url ? String(server.url) : undefined,
        headers: server.headers && typeof server.headers === 'object' ? (server.headers as Record<string, string>) : undefined,
        enabled: server.enabled !== false,
      });
    } else {
      const target = findTarget();
      if (!target) return `Error: 未找到 MCP 服务器（id=${server.id ?? ''} name=${server.name ?? ''}）`;
      if (action === 'toggle') {
        target.enabled = !target.enabled;
      } else if (action === 'update') {
        if (server.name !== undefined) target.name = String(server.name);
        if (server.transport !== undefined) target.transport = server.transport === 'stdio' ? 'stdio' : 'streamable-http';
        if (server.command !== undefined) target.command = server.command ? String(server.command) : undefined;
        if (server.args !== undefined) target.args = Array.isArray(server.args) ? server.args.map(String) : undefined;
        if (server.env !== undefined && typeof server.env === 'object') target.env = server.env as Record<string, string>;
        if (server.url !== undefined) target.url = server.url ? String(server.url) : undefined;
        if (server.headers !== undefined && typeof server.headers === 'object') target.headers = server.headers as Record<string, string>;
        if (server.enabled !== undefined) target.enabled = server.enabled !== false;
      } else if (action === 'remove') {
        const idx = servers.indexOf(target);
        if (idx >= 0) servers.splice(idx, 1);
      }
    }

    await writeSettingsToFile(s);

    // 按新配置立即重连（失败不阻断返回，下次请求仍会同步）
    try {
      const { mcpManager: mgr } = await import('@/lib/mcp/manager');
      await mgr.syncServers(servers);
    } catch {
      /* 重连失败留待下次请求 syncServers 兜底 */
    }

    return JSON.stringify({ success: true, action, serverCount: servers.length });
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** manage_quick_launch 工具：在 ⌘F 添加/移除用户自建快捷入口（My Quick） */
async function toolManageQuickLaunch(args: Record<string, unknown>): Promise<string> {
  try {
    const action = String(args.action ?? '').trim();
    if (!['add', 'remove', 'list'].includes(action)) {
      return 'Error: action 必须是 add/remove/list';
    }
    const { readSettingsFromFile, writeSettingsToFile } = await import('@/lib/settings-server');
    const s = await readSettingsFromFile();
    const list = s.quickLaunchers ?? [];

    if (action === 'list') {
      return JSON.stringify({ success: true, quickLaunchers: list });
    }

    if (action === 'add') {
      const label = String(args.label ?? '').trim();
      const agent = String(args.agent ?? '').trim() || 'chat';
      const prompt = String(args.prompt ?? '').trim();
      if (!label) return 'Error: add 操作必须提供 label';
      const id = `quick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      s.quickLaunchers = [...list, { id, label, agent, prompt }];
      await writeSettingsToFile(s);
      return JSON.stringify({ success: true, id, label, agent, prompt });
    }

    // remove
    const id = String(args.id ?? '').trim();
    if (!id) return 'Error: remove 操作必须提供 id';
    s.quickLaunchers = list.filter((q) => q.id !== id);
    await writeSettingsToFile(s);
    return JSON.stringify({ success: true, id });
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * admin 场景工具定义（配置 / 模型 / 沙盒运维）。
 * 定义顺序无关行为：registry.toApiFormat 按工具名 localeCompare 确定性排序。
 */
export const adminToolDefs: Tool[] = [
  {
    name: 'sandbox_rollback',
    description: 'List or restore previous versions of a Bob Sandbox mini-app file. Every write_file/edit_code on a mini-app file auto-saves a snapshot under bob-sandbox/apps/<appId>/.history/. action="list" shows available versions; "restore"+stamp brings one back. After restore, re-verify with capture_preview.',
    parameters: {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'The Bob Sandbox app id (folder name under bob-sandbox/apps/).',
        },
        file: {
          type: 'string',
          description: 'Relative file path inside the app, e.g. index.html.',
        },
        action: {
          type: 'string',
          enum: ['list', 'restore'],
          description: 'list=show available versions (default); restore=write back a previous version.',
        },
        stamp: {
          type: 'string',
          description: 'For restore: the version timestamp prefix shown by action="list". Omit to restore the most recent snapshot.',
        },
      },
      required: ['appId', 'file'],
    },
    category: '文件',
    execute: toolSandboxRollback,
    maxOutput: 2000,
  },
  {
    name: 'sandbox_export',
    description: 'Export a Bob Sandbox mini-app as a standalone single-file HTML for sharing/publishing: inlines the app\'s own relative css/js (<link href>/<script src> become inline), keeps external CDN links untouched. Output: bob-sandbox/exports/<appId>-<ts>.html — open directly or share the file.',
    parameters: {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'The Bob Sandbox app id (folder name under bob-sandbox/apps/).',
        },
      },
      required: ['appId'],
    },
    category: '文件',
    execute: toolSandboxExport,
    maxOutput: 800,
  },
  {
    name: 'check_mcp_gaps',
    description: 'Local-only check of MCP server status against the local BobWork config — which MCPs are configured/enabled/connected (with tool counts); never touches the internet. Use when a task needs a capability that may come from an MCP (browser automation, GitHub, code docs, legal search, company data, file system, web search), or a tool call failed because an MCP is missing/offline. Returns a status list to tell the user exactly what to configure. Never claim an MCP is available unless it shows connected.',
    parameters: {
      type: 'object',
      properties: {
        need: {
          type: 'string',
          description: 'Optional: capability the current task needs, e.g. "browser automation", "github", "excel". Used to highlight relevant entries; not required.',
        },
      },
      required: [],
    },
    category: '系统',
    execute: toolCheckMcpGaps,
    maxOutput: 4000,
  },
  {
    name: 'get_app_config',
    description: '读取当前应用配置摘要（只读，不改动）：各厂商（deepseek/glm/moonshot/qwen/openai/doubao）API Key 是否配置、视觉/STT 角色模型状态；任务归纳/成果块编辑已归入主对话模型（taskModel/outcomeModel=chatModel）；欢迎头像与 logo、MCP 服务器列表、自定义工具、当前主题。要改配置时先调本工具确认现状，再调对应工具。',
    parameters: {
      type: 'object',
      properties: {},
    },
    category: '配置',
    execute: toolGetAppConfig,
    maxOutput: 4000,
  },
  {
    name: 'set_app_icon',
    description: '修改应用图标设置：target=avatar 设欢迎窗口头像（mode=random 随机 / mode=fixed 固定；fixed 时 selected 传头像池 id，如 builtin/pumpkin-a.png / custom/xxx.png）；target=logo 设侧边栏品牌 logo（selected 传头像池 id，空字符串恢复默认）。写配置并即时生效（欢迎窗头像下次启动生效）。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['avatar', 'logo'], description: 'avatar=欢迎窗口头像；logo=侧边栏品牌 logo' },
        mode: { type: 'string', enum: ['random', 'fixed'], description: '仅 target=avatar：random 随机 / fixed 固定' },
        selected: { type: 'string', description: '头像池 id（如 builtin/pumpkin-a.png）；target=logo 传空字符串恢复默认' },
      },
      required: ['target'],
    },
    category: '配置',
    execute: toolSetAppIcon,
    maxOutput: 2000,
  },
  {
    name: 'update_provider_config',
    description: '修改模型配置并即时生效。target=provider 设聊天厂商 API Key/自定义 baseUrl/勾选模型（provider: deepseek/glm/moonshot/qwen/openai/doubao；model 如 qwen-vl-max）；target=vision 设视觉角色；target=task/outcome = 改主对话模型（已归入 chatModel）；target=stt 设音频转写（doubao-stream/doubao/dashscope/siliconflow/openai）。apiKey 空=清空；baseUrl 空=恢复默认端点。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['provider', 'vision', 'task', 'outcome', 'stt'], description: 'provider=聊天厂商；vision=视觉；task/outcome=主对话模型（已归入）；stt=音频转写' },
        provider: { type: 'string', description: '厂商 type，见描述中各目标允许的取值' },
        apiKey: { type: 'string', description: 'API Key；传空字符串清空' },
        baseUrl: { type: 'string', description: '自定义 baseUrl；传空字符串恢复默认' },
        model: { type: 'string', description: '模型 id（provider 目标下追加到勾选列表；角色目标下设为 defaultModel）' },
      },
      required: ['target', 'provider'],
    },
    category: '配置',
    execute: toolUpdateProviderConfig,
    maxOutput: 2000,
  },
  {
    name: 'test_model',
    description: '验证模型连接（对指定厂商发极简请求，返回 ok/error/status）：404=模型未开通/ID 错误，401/403=API Key 无效，超时=网络或图片生成耗时。provider: deepseek/glm/moonshot/qwen/openai/doubao/agentplan/codingplan/siliconflow；models 可选（省略=测该厂商全部已勾选）。与 get_app_config + update_provider_config 构成「诊断→修改→验证」闭环。',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: '厂商 type（如 doubao、deepseek、agentplan 等）' },
        models: {
          type: 'array',
          items: { type: 'string' },
          description: '要测试的模型 ID 列表；省略时测试该厂商所有已勾选模型',
        },
      },
      required: ['provider'],
    },
    category: '配置',
    execute: toolTestModel,
    maxOutput: 4000,
  },
  {
    name: 'manage_mcp_server',
    description: '增删改 MCP 服务器配置（写设置并立即按新配置重连，之后该服务器工具可调用）。action=add 新增（server 传 name；stdio 传 command/args/env；streamable-http 传 url/headers；enabled 默认 true）；action=update 按 server.id 或 server.name 更新字段；action=toggle 启停；action=remove 删除。新增前先 get_app_config 确认现有服务器，避免重复。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'toggle', 'remove'], description: '操作类型' },
        server: {
          type: 'object',
          description: '服务器配置（id 或 name 用于定位；add 必须含 name）',
          properties: {
            id: { type: 'string', description: '唯一 id（update/toggle/remove 用于定位；add 缺省时自动生成）' },
            name: { type: 'string', description: '显示名称' },
            transport: { type: 'string', enum: ['stdio', 'streamable-http'] },
            command: { type: 'string', description: 'stdio：启动命令（如 npx）' },
            args: { type: 'array', items: { type: 'string' }, description: 'stdio：命令参数' },
            env: { type: 'object', description: 'stdio：环境变量' },
            url: { type: 'string', description: 'streamable-http：远程 URL' },
            headers: { type: 'object', description: 'streamable-http：请求头（如 Authorization）' },
            enabled: { type: 'boolean', description: '是否启用' },
          },
        },
      },
      required: ['action'],
    },
    category: '配置',
    execute: toolManageMcpServer,
    maxOutput: 2000,
  },
  {
    name: 'manage_quick_launch',
    description: '管理 ⌘F 自定义快捷入口（My Quick）：action=add 新增（label、agent 目标节点 chat/coding、prompt 预设提示词）；action=remove 按 id 删除；action=list 列出全部。用户要"在 ⌘F 加一个快捷入口/把某工作流做成一键入口"时调用；list 可先查避免重复。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove', 'list'], description: '操作类型' },
        label: { type: 'string', description: 'add：快捷入口名称（用户可见，如 “DeepSeek Harness”）' },
        agent: { type: 'string', enum: ['chat', 'coding'], description: 'add：目标节点类型（默认 chat）' },
        prompt: { type: 'string', description: 'add：点击时预填的提示词（可选）' },
        id: { type: 'string', description: 'remove：要删除的入口 id（list 可得）' },
      },
      required: ['action'],
    },
    category: '配置',
    execute: toolManageQuickLaunch,
    maxOutput: 2000,
  },
  {
    name: 'list_configured_models',
    description: 'List all models in the user\'s configured model pool (read-only): each provider with API-key status and selected (enabled) model ids, formatted "provider:modelId" — the exact format the sandbox chat bridge expects (BobWork.request("chat", { model })). Use when adding AI capability to a mini-program/app. Empty pool → tell the user to configure models first.',
    parameters: {
      type: 'object',
      properties: {},
    },
    category: '配置',
    execute: toolListConfiguredModels,
    maxOutput: 4000,
  },
];
