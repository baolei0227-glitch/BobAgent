/**
 * P4b-1 审批策略层 —— 工具确认（tool_confirm）的策略化裁决，纯函数、无 I/O 依赖。
 *
 * 默认 allow_scope 策略下行为与现网逐位一致（现网：confirmTools 名单内 → 挂起请求用户确认，
 * 名单外一律自动放行；路径授权为 scope gate 不在本层）。ask / never 为本层新增档位（默认不启用，
 * 由 settings.approval.defaultStrategy 开启，见 settings.ts）。
 *
 * 本层含两个咨询点（同源策略、不同时机）：
 *   1. decideToolApproval —— 单次工具调用的「执行前」裁决（tool_confirm 接管，route 咨询点注入
 *      ctx.approvalStrategy），名单内/写类判定；
 *   2. decideTeamApproval —— 多智能体协作（team_run）的「过程级」裁决：团队已 plan（成员清单 + 任务
 *      DAG 就绪）、尚未 approve 时判定是否把草案交用户审批。team_run 既不在 confirmTools 名单、
 *      也不是写类工具（spawn 出的成员各自再走自己的工具轮），故不复用第 1 点，单列一档。
 *
 * 边界说明（本层不处理，均属其它层）：
 *   1. butler 结构化卡（butler 身份 + BUTLER_CARD_TOOLS 的可编辑确认卡片）视为强于 confirm 的
 *      人工审批 —— 卡片本身带用户可见、可编辑、可拒绝的确认 UI，任何 strategy 均保留该流程，
 *      不落入本层判定（route handleToolConfirm 先判 usesButlerCard → 'noop' 交还卡片流程）。
 *   2. .local-roots 路径授权是 scope gate，前置于工具执行（run_command / execute_script 等的
 *      个人目录读写拦截 readableError），未经授权路径仍由原 readableError 拒绝 —— 与本层正交，
 *      本层不重复判定路径。
 *   3. 与 route SANDBOX_BLOCKED_TOOLS（wanted Node 沙箱模式的禁写全集，面向「该模式一律禁止
 *      副作用」，含 write_file / run_command / set_app_icon / update_provider_config /
 *      manage_mcp_server 等）的差异：本层写类判定服务于 ask/never 档的「可确认 / 需拦截」启发，
 *      面向主对话工具全集（内置 + browser MCP），宁保守（少误判写类、避免拦截读工具）但要覆盖
 *      主流写工具（文件/命令/脚本 + browser 页面操纵与存储写入）。
 *
 * 名词匹配说明（主对话工具轮实际命名核对）：
 *   - 内置工具直接注册本名：write_file / edit_code / run_command / execute_script 等；
 *   - browser MCP 工具经 mcpManager 清洗注册为 mcp__{serverId}__{sanitizedToolName} 全名
 *     （如 mcp__bob-browser-mcp__browser_click，MCP 原名 browser.click 的点被清洗为下划线），
 *     早期/内部直调也可能出现 browser.click 简称 —— 判定时对两种形式均做兼容（见 splitToolName）。
 */

/** 审批策略档位：allow_scope = 现网（仅 confirmTools 名单内需确认）；ask = 名单 + 写类都问；
 *  never = 名单 + 写类一律拒绝（仅读类自动放行）。默认 allow_scope（行为与现网逐位一致）。 */
export type ApprovalStrategy = 'allow_scope' | 'ask' | 'never';

/** decideToolApproval 输入：工具名 + 是否在「需手动确认名单」（route ctx.confirmTools 注入结果） + 策略 */
export interface ApprovalDecisionInput {
  name: string;
  inConfirmList: boolean;
  strategy: ApprovalStrategy;
}

/** 单次工具调用的审批裁决：allow = 自动放行（通用执行）；request = 挂起请求用户确认；
 *  deny = 拒绝执行（SSE tool_result(error) + 落账 + continue）。 */
export type ToolApprovalVerdict = 'allow' | 'request' | 'deny';

/** 内置（非 MCP）写类工具精确名单：主对话内置注册写操作（tools.ts 命名核对）+ 常见别名。
 *  run_command / execute_script 已覆盖 shell 执行语义；move_file / copy_file / append_file
 *  为任务要求覆盖的通用文件写操作（当前内置未必注册，保留无害：永不命中即不产生判定差异）。 */
const BUILTIN_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'append_file',
  'edit_code',
  'rename_file',
  'delete_file',
  'copy_file',
  'move_file',
  'run_command',
  'execute_script',
  // 配置类写操作（与 SANDBOX_BLOCKED_TOOLS 同语义：set_app_icon / update_provider_config /
  // manage_mcp_server 属修改程序配置的写操作；get_app_config 只读不判写）
  'set_app_icon',
  'update_provider_config',
  'manage_mcp_server',
]);

/** browser MCP 写类动作词（browser-mcp/src/tools.ts 实际命名核对后抽取，匹配 action 不带命名空间）：
 *  - 页面操纵/表单交互（会改变页面状态或触发副作用请求）：click / type / fill_form /
 *    select_option / press_key / submit / click_coordinates / check / uncheck / drag；
 *  - 文件/内容产出：upload_file / export_pdf；
 *  - 视图滚动（任务点名，视作页面操纵写类）：scroll；
 *  - 脚本注入与持久存储写入（强副作用，等同 execute_script 语义）：run_js / page_script /
 *    set_cookie / clear_cookies / set_storage / clear_storage。
 *  保守排除（无持久副作用的读/UI 探测/纯导航类）：hover / mouse_wheel / navigate / snapshot /
 *  extract_text / get_html / read_article / screenshot / switch_tab / open_tab / close_tab /
 *  reload / back / forward / wait* / detect_login / login / get_cookies / get_storage 等
 *  —— 宁可少误判写类，避免 ask/never 档误拦读操作。 */
const BROWSER_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'click',
  'type',
  'fill_form',
  'select_option',
  'press_key',
  'submit',
  'click_coordinates',
  'check',
  'uncheck',
  'drag',
  'upload_file',
  'export_pdf',
  'scroll',
  'run_js',
  'page_script',
  'set_cookie',
  'clear_cookies',
  'set_storage',
  'clear_storage',
]);

/** 把工具全名拆成 { 命名空间, 动作名 }：
 *  - mcp__bob-browser-mcp__browser_click → ns='bob-browser-mcp', action='browser_click'；
 *  - browser.click → ns='browser', action='click'；
 *  - 内置裸名 write_file → ns='', action='write_file'。 */
function splitToolName(name: string): { ns: string; action: string } {
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const idx = rest.lastIndexOf('__');
    if (idx > 0) return { ns: rest.slice(0, idx), action: rest.slice(idx + 2) };
    return { ns: '', action: rest };
  }
  const dot = name.indexOf('.');
  if (dot > 0) return { ns: name.slice(0, dot), action: name.slice(dot + 1) };
  return { ns: '', action: name };
}

/** 保守写类判定：true = 该工具属于写类（ask 档触发确认 / never 档直接拒绝）。
 *  精确名单（内置）+ browser 命名空间动作词匹配；其余工具一律视为非写类（保守）。 */
export function isWriteKindTool(name: string): boolean {
  const { ns, action } = splitToolName(name);
  // 内置写类：动作名命中（含带命名空间的同名动作，如 mcp__x__execute_script —— 语义同样危险）
  if (BUILTIN_WRITE_TOOLS.has(action)) return true;
  // browser 写类：命名空间含 browser（serverId bob-browser-mcp 或 browser 简称），或动作名自带
  // browser. / browser_ 前缀（MCP 原名 browser.click 清洗而来，无论外层 serverId 是否含 browser
  // 字样 —— 兼容 mcp__{任意server}__browser_click / 裸 browser_click / browser.click 三种形式）；
  // 命中动作前先剥掉前缀，未命中动作（读/导航/UI 探测类）一律非写类（保守）。
  const browserNs = /browser/i.test(ns) || /^browser[._]/.test(action);
  const bareAction = action.replace(/^browser[._]/, '');
  return browserNs && BROWSER_WRITE_ACTIONS.has(bareAction);
}

/**
 * 审批策略裁决（纯函数）：
 *  - allow_scope（现网默认，行为零变化）：inConfirmList → 'request'；否则 'allow'（不 consult
 *    写类判定 —— 现网名单外工具一律自动放行）；
 *  - ask：inConfirmList → 'request'；写类 → 'request'；否则 'allow'；
 *  - never：inConfirmList 或 写类 → 'deny'；否则 'allow'。
 * 边界（不属本层，见文件头注释）：butler 结构化卡 / .local-roots 路径授权 gate 均在调用方先判，
 * 本函数不感知；调用方（handleToolConfirm）对 butler 覆盖工具不 consult 本函数。
 */
export function decideToolApproval(input: ApprovalDecisionInput): ToolApprovalVerdict {
  const { name, inConfirmList, strategy } = input;
  if (strategy === 'allow_scope') {
    return inConfirmList ? 'request' : 'allow';
  }
  if (strategy === 'ask') {
    return inConfirmList || isWriteKindTool(name) ? 'request' : 'allow';
  }
  // never
  return inConfirmList || isWriteKindTool(name) ? 'deny' : 'allow';
}

/** 多智能体协作（team_run）的门禁裁决：allow = 自动批准（直接 approve & run，不打断用户）；
 *  request = 挂起，把草案（goal + 成员清单 + 任务 DAG）交用户审批；deny = 拒绝，不建团队、
 *  不 plan（零 MCP 副作用，团队记录都不产生）。 */
export type TeamApprovalVerdict = 'allow' | 'request' | 'deny';

/**
 * 多智能体协作门禁裁决（纯函数）：
 *  - allow_scope（现网默认，行为零变化）：'allow' —— 与 v0.5.422 之前一致，宿主持草案直接 approve；
 *  - ask：'request' —— 用户批准后才 approve & run（拒绝 / 超时则 team_discard 作废草案）；
 *  - never：'deny' —— 直接收口（team_run 属编排类重操作，never 档一律不自动执行）。
 * 与 decideToolApproval 的档位语义一致（默认档 = 不打断用户），仅判定对象与时机不同（见文件头）。
 */
export function decideTeamApproval(strategy: ApprovalStrategy): TeamApprovalVerdict {
  if (strategy === 'ask') return 'request';
  if (strategy === 'never') return 'deny';
  return 'allow';
}
