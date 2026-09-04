/**
 * bob-notes-mcp 宿主转发桥（server-only）
 *
 * 与 /api/team、/api/bobby 同构：BobWork 宿主侧笔记的唯一数据通道。
 * 笔记实现（raw/wiki/ingest/review/lint）全部在 bob-notes-mcp 插件域，
 * 本模块只做"mcpManager → notes_* 工具"的语义转发与结果解析，不含任何笔记逻辑。
 *
 * 语义映射（action → 插件工具）：
 *   add_raw    → notes_add_raw   投放素材（URL 自动抓正文）
 *   ingest     → notes_ingest    编译 raw → wiki（插件大脑）
 *   query      → notes_query     分层检索（含操作符 / 自然语言拆解）
 *   get        → notes_get       单条全文
 *   update     → notes_update    按 id 修改
 *   delete     → notes_delete    按 id 删除
 *   review     → notes_review    回看打捞
 *   lint       → notes_lint      自检
 *   backfill   → notes_backfill  答案回填
 *   stats      → notes_stats     库概览
 *   config_get → notes_config_get / config_set → notes_config_set（插件大脑模型配置）
 */

import { mcpManager } from './manager';
import { readSettingsFromFile } from '@/lib/settings-server';
import type { McpServerConfig } from './types';

const NOTES_SERVER_ID = 'bob-notes-mcp';

/** 工具名（MCP 原始名，无 mcp__ 前缀） */
export type NotesBridgeAction =
  | 'add_raw' | 'raw_list' | 'ingest' | 'query' | 'get' | 'update' | 'delete'
  | 'review' | 'lint' | 'backfill' | 'stats' | 'config_get' | 'config_test' | 'config_set'
  | 'history' | 'restore' | 'log' | 'schema_get' | 'schema_set';

function toolFor(action: NotesBridgeAction): string {
  return `notes_${action}`;
}

interface NotesCallResult {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

/** 读取 bob-notes-mcp 服务配置（enabled 判定用） */
async function getNotesConfig(): Promise<{ settings: { mcpServers?: McpServerConfig[] }; serverConfig?: McpServerConfig }> {
  const settings = await readSettingsFromFile();
  const serverConfig = (settings.mcpServers || []).find((s) => s.id === NOTES_SERVER_ID);
  return { settings, serverConfig };
}

/** 确保 bob-notes-mcp 已连接并调用插件工具（与 /api/team callTeam 同构） */
export async function callNotes(
  action: NotesBridgeAction,
  args: Record<string, unknown> = {},
): Promise<NotesCallResult> {
  const { settings, serverConfig } = await getNotesConfig();
  if (!serverConfig || !serverConfig.enabled) {
    return { ok: false, error: `bob-notes-mcp 未启用：请在设置面板开启 ${NOTES_SERVER_ID}` };
  }
  await mcpManager.syncServers(settings.mcpServers || []);
  const raw = await mcpManager.callTool(`mcp__${NOTES_SERVER_ID}__${toolFor(action)}`, args);
  const parsed = parseToolOutput(raw);
  if (!parsed) return { ok: false, error: `bob-notes-mcp 调用异常：${raw.slice(0, 300)}` };
  if (parsed.isError) {
    return { ok: false, error: String(parsed.error || parsed.text || 'bob-notes-mcp 服务端报错') };
  }
  return { ok: true, data: parsed as Record<string, unknown> };
}

/** 把 notes_query 返回的条目渲染为文本（宿主工具/沙箱桥展示层共用；非笔记实现） */
export function renderNotesText(
  data: Record<string, unknown>,
  mode: 'index' | 'full',
): string {
  const entries = Array.isArray(data.entries) ? (data.entries as Array<Record<string, unknown>>) : [];
  const total = typeof data.total === 'number' ? data.total : entries.length;
  const groups = Array.isArray(data.groups)
    ? (data.groups as Array<{ name?: string; tags?: Array<{ tag?: string; count?: number }> }>)
    : [];

  if (mode === 'index') {
    const labelOf: Record<string, string> = { type: '类型', topics: '主题' };
    const indexText = groups.length === 0
      ? '（暂无标签）'
      : groups
          .map((g) => {
            const items = (g.tags || []).map((t) => `${t.tag ?? ''}（${t.count ?? 0} 条）`).join('  ');
            return `【${labelOf[g.name ?? ''] ?? g.name}】${items}`;
          })
          .join('\n');
    let out = `Wiki 索引（共 ${total} 条笔记，命中 ${entries.length} 条）：\n${indexText}`;
    if (entries.length > 0) {
      out += `\n\n命中条目：\n${renderEntriesLines(entries, false)}`;
    }
    return out;
  }

  if (entries.length === 0) return '（无匹配条目）';
  return renderEntriesLines(entries, true);
}

function renderEntriesLines(entries: Array<Record<string, unknown>>, withBody: boolean): string {
  return entries
    .map((e) => {
      const title = String(e.title ?? '');
      const tagsArr = Array.isArray(e.tags) ? (e.tags as string[]) : [];
      const tags = tagsArr.length > 0 ? `[${tagsArr.join(' · ')}] ` : '';
      const d = e.date ? `（${e.date}）` : '';
      const body = withBody ? String(e.content ?? '') : '';
      return body ? `- 💡 ${tags}${title}${d}\n  ${body}` : `- 💡 ${tags}${title}${d}`;
    })
    .join('\n\n');
}

/** 从 MCP callTool 返回文本中解析 JSON。
 *  mcpManager.callTool 已抽取 content 文本；成功为 notesDispatch 的 JSON.stringify(data)，
 *  失败以 "Error from server: ..." 前缀返回。 */
function parseToolOutput(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^Error( from server)?:/.test(trimmed)) {
    return { isError: true, error: trimmed };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
    return { text: trimmed };
  } catch {
    return { isError: true, error: trimmed.slice(0, 300) };
  }
}
