/**
 * lib/plugin-panels.ts — 插件面板注册表共享类型（client-safe，不引入任何 server 依赖）
 *
 * 前端（CanvasFlow 动态 Tab、左侧入口）与后端（/api/plugin-panels）共用同一数据形状：
 * 每个条目 = 一个「启用的 MCP 实例声明的自带界面」，注册中心服务端汇总后原样下发。
 */

/** 插件面板图标键（前端映射 lucide 图标；缺省回退通用插件图标） */
export type PluginPanelIcon = 'brain' | 'notebook' | string;

/** 注册表对外条目（纯数据） */
export interface PluginPanelEntry {
  /** 所属 MCP server id（= 插件 id） */
  pluginId: string;
  /** 面板显示名（如 Bob-Mind / Bob Notes） */
  name: string;
  /** 托管形态：serve = 插件自起本地网页；static = 宿主 /api/plugin-panel/<id> 代理 */
  mode: 'serve' | 'static';
  /** iframe src：serve = 面板 URL；static = /api/plugin-panel/<id>/index.html */
  src: string;
  /** serve 形态的就绪探测完整 URL（static 由宿主代理托管，无需探测） */
  probeUrl?: string;
  /** 面板图标键 */
  icon?: PluginPanelIcon;
}
