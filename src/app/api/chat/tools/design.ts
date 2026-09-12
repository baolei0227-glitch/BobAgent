/**
 * Design 场景工具：主题设计规范读取（get_current_theme）。
 * 从 tools/index.ts 抽出，导入路径保持不变（index.ts 通过 ...designToolDefs 聚合）。
 * 依赖方向单向：仅动态 import 设置模块，无运行时循环依赖。
 */
import type { Tool } from './index';

/** get_current_theme 工具：返回当前生效主题的完整 CSS 变量集 + 设计规范摘要 */
async function toolGetCurrentTheme(_args: Record<string, unknown>): Promise<string> {
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const { PRESET_THEME_VARIABLES, THEME_OPTIONS } = await import('@/lib/settings');
    const s = await readSettingsFromFile();
    const themeId = s.theme ?? 'warm';
    // 统一单一品牌色：始终使用预设变量（历史 custom 主题已被 normalizeCustomThemes 收敛）
    const preset = PRESET_THEME_VARIABLES[themeId];
    if (!preset) {
      return JSON.stringify({ error: `未知主题 id: ${themeId}` });
    }
    const variables = preset;
    const opt = THEME_OPTIONS.find((t) => t.id === themeId);
    const themeName = opt?.label ?? themeId;
    const dark = opt?.dark ?? false;
    const source = 'preset';

    // 提取关键色摘要（AI 最常用的几个）
    const keyColors = {
      primary: variables['--primary'],
      background: variables['--background'] ?? variables['--canvas-bg'],
      surface: variables['--paper'] ?? variables['--card'],
      text: variables['--foreground'] ?? variables['--ink'],
      border: variables['--border'] ?? variables['--line'],
      muted: variables['--muted-foreground'] ?? variables['--ink-muted'],
    };

    return JSON.stringify({
      themeId,
      themeName,
      dark,
      source,
      keyColors,
      variablesCount: Object.keys(variables).length,
      variables,
      designGuide: {
        '主色(--primary)': `${variables['--primary']} — 按钮、标签、链接、选中态`,
        '背景(--background/--canvas-bg)': `${variables['--background'] ?? variables['--canvas-bg']} — 全局/画布背景`,
        '卡片/纸张(--paper/--card)': `${variables['--paper'] ?? variables['--card']} — 节点卡片、弹窗、侧边栏`,
        '主文字(--foreground/--ink)': `${variables['--foreground'] ?? variables['--ink']} — 正文文字`,
        '弱化文字(--muted-foreground/--ink-muted)': `${variables['--muted-foreground'] ?? variables['--ink-muted']} — 辅助、说明文字`,
        '边框(--border/--line)': `${variables['--border'] ?? variables['--line']} — 分割线、卡片边框`,
        '信息蓝(--info)': `${variables['--info']} — 信息提示`,
        '成功绿(--success)': `${variables['--success']} — 成功状态`,
        '警示橙(--warn)': `${variables['--warn']} — 警告提示`,
        '危险红(--danger)': `${variables['--danger']} — 错误、删除`,
      },
    }, null, 2);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export const designToolDefs: Tool[] = [
  {
    name: 'get_current_theme',
    description: '获取当前生效主题的完整设计规范（只读）：主题 id/名称/是否深色/来源（preset/custom）、关键色摘要、完整 CSS 变量集（40+，含 shadcn 基底+语义色）、每变量用途的设计指南。用户问"当前主题/主色"或需生成与当前主题配色一致的前端代码时调用。',
    parameters: {
      type: 'object',
      properties: {},
    },
    category: '配置',
    execute: toolGetCurrentTheme,
    maxOutput: 8000,
  },
];
