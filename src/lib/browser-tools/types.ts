/**
 * 浏览器工具规格层 — 共享类型
 *
 * 一套工具规格 + 两个 driver（chrome / hippo）：
 *   - 规格层只描述「工具名 / 参数 schema / 统一返回 envelope」，与具体驱动无关；
 *   - driver 负责把工具调用落到具体宿主（扩展通道 / 应用内 Hippo）。
 *
 * 驱动由全局互斥开关（settings.aiBrowser）决定，**不做单次调用路由**。
 */

/** 错误阶段枚举：模型据此决定降级路径（如 unsupported → 提示用户切换通道） */
export type ErrorPhase =
  | 'syntax' // 参数 / 脚本语法错误
  | 'script' // 页内脚本执行异常
  | 'timeout' // 操作超时
  | 'op-limit' // 操作次数超限
  | 'nav-denied' // 导航被白名单拒绝
  | 'wait-timeout' // 等待条件未满足
  | 'inject' // 注入失败（元素不存在 / 不可交互）
  | 'driver' // 驱动内部异常（桥不可用、CDP 失败等）
  | 'unsupported'; // 该驱动不支持此工具

/** 统一返回 envelope（所有工具共用） */
export interface Envelope {
  ok: boolean;
  value?: unknown;
  error?: { phase: ErrorPhase; message: string; hint?: string };
  warnings?: string[];
  steps?: Array<{ op: string; ms: number }>;
  stats?: { ops: number; elapsedMs: number; urlEnd?: string };
}

/** 驱动可用性（status / connect 语义） */
export interface DriverStatus {
  ready: boolean;
  url?: string;
  title?: string;
  detail?: string;
}

/** 驱动执行上下文（宿主注入） */
export interface DriverCtx {
  /** 当前激活项目根（账号本 / 证据落盘用；无项目时为空） */
  projectRoot?: string | null;
}

/** 驱动接口：一次解析、整轮生效 */
export interface BrowserDriver {
  readonly id: 'chrome' | 'hippo';
  /** 本驱动支持的工具名集合（不支持者返回 phase='unsupported'，不静默回退另一通道） */
  readonly supportedTools: ReadonlySet<string>;
  status(): Promise<DriverStatus>;
  exec(name: string, args: Record<string, unknown>, ctx: DriverCtx): Promise<Envelope>;
}

/** 工具规格（driver 无关；Chrome 与 Hippo 共用同一份定义） */
export interface BrowserToolSpec {
  /** 工具名（内置统一 browser_*，不带 mcp__ 前缀） */
  name: string;
  /** 面向模型的能力描述 */
  description: string;
  /** 返回结构说明（拼进 description 末尾，帮助模型理解 envelope.value） */
  returns: string;
  /** JSON Schema 参数定义 */
  parameters: Record<string, unknown>;
  /** 结果字符上限 */
  maxOutput: number;
}