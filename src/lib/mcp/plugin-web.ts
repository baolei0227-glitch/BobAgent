/**
 * lib/mcp/plugin-web.ts — 插件自带网页反代的「目标解析」（server-only）
 *
 * 把「查配置 → 校验声明 → 取运行时端口」抽出来，与 `lib/http/plugin-web-proxy.ts` 的
 * 纯管道逻辑解耦：管道可以被单测喂任意 resolve，本模块负责查表与鉴权。
 *
 * 声明校验用 `isDeclaredPluginWebPanel()` 守住一条**跨包不变量**：
 * 面板声明的 hostPath 必须等于 `/api/plugin-web/<id>`，而插件的 next.config 必须把
 * basePath 设成同一个串。tsc 看不见这种跨包耦合，所以放在运行时每次请求都守。
 */

import { MCP_PRESETS, type McpServerConfig } from '@/lib/mcp/types';
import { readSettingsFromFile } from '@/lib/settings-server';
import { getPanelPort, isPortAcceptingConnections } from '@/lib/mcp/panel-ports';
import { isDeclaredPluginWebPanel, type PluginWebResolution } from '@/lib/http/plugin-web-proxy';

/** 取配置的生效面板声明：实例配置优先，缺省回退预置（与 plugin-panels-server 同口径） */
function effectivePanel(cfg: McpServerConfig) {
  const preset = MCP_PRESETS.find((p) => p.id === cfg.id);
  return cfg.panel ?? preset?.panel;
}

/** 声明里登记的显示名（预置友好名优先，回退实例名/id） */
function displayName(cfg: McpServerConfig, preset: McpServerConfig | undefined): string {
  return preset?.name ?? cfg.name ?? cfg.id;
}

/**
 * 解析插件自带网页的反代目标。
 *
 * 只有 **enabled + 声明了合法 hostPath** 的实例才可能返回 ok / declared-not-running；
 * 其余一律 not-declared（404）—— 不向调用方暴露「本机存在哪些插件 id」。
 *
 * 判据（2026-10-19 修正，工单 P0-3）：表中有端口只代表「本宿主登记过」，
 * **可达性**由 isPortAcceptingConnections（TTL 缓存）保证——插件崩溃、自愈完成前的
 * 窗口内按「未运行」引导（503 引导页），而不是对死端口透传（upstream ECONNREFUSED → 502）。
 * 该表只在宿主真正 spawn 了 serve 插件时写入（manager.createConnection → ensurePanelPort）。
 */
export async function resolvePluginWebPanel(pluginId: string): Promise<PluginWebResolution> {
  const settings = await readSettingsFromFile();
  const cfg = settings.mcpServers?.find((c) => c.id === pluginId && c.enabled);
  if (!cfg) return { kind: 'not-declared' };

  const panel = effectivePanel(cfg);
  if (!isDeclaredPluginWebPanel(panel, pluginId)) return { kind: 'not-declared' };

  const name = displayName(cfg, MCP_PRESETS.find((p) => p.id === pluginId));
  const port = getPanelPort(pluginId);
  if (!port) return { kind: 'declared-not-running', name };
  if (!(await isPortAcceptingConnections(port))) return { kind: 'declared-not-running', name };
  return { kind: 'ok', port, name };
}
