/**
 * Agent 工具系统 — 工具注册表与场景静态标注
 *
 * 从 tools/index.ts 抽出：ToolRegistry 类、场景静态映射表（SCENED_TOOLS）与全局注册表实例。
 * 供聚合入口 index.ts 与各场景模块（如 admin 的 MCP 盘点）共同引用，
 * 避免「场景模块 ⇄ index.ts」的循环依赖：本文件仅以 import type 依赖 index 的类型（编译期擦除，
 * 不产生运行时依赖），index.ts 单向导入本文件的运行时值。
 */

import type { Tool, ToolCategory, ToolDefinition, ToolScene } from './index';

/** 专属工具 → 适用场景映射（两层过滤的静态标注）：
 *  - 未在此表中的工具 = 通用工具（任何场景可用）
 *  - coding:    AI Coding 节点（sandbox_app_id）才暴露
 *  - butler:    事务域（记忆/待办/偏好/日程）意图才暴露
 *  - legal:     法律意图才暴露
 *  - node:      画布节点对话（nodeId 存在）才暴露——节点树/画布结构依赖工具
 *  - console:   应用状态只读查询（已装 agent / 项目 / 节点 / 插件连接 / 收件箱）才暴露
 *  - audio/skill/design/ocr: 均按 L2 动态意图检测放行（见 route.ts activeScenes） */
export const SCENED_TOOLS: Record<string, ToolScene[]> = {
  // ---- butler 连通（记忆/待办/偏好/工作报告/日历 = 事务域统一场景）----
  read_todo: ['butler'],
  remember_preference: ['butler'],
  // ---- notebook（bob-notes 插件域：Kar 专职子 agent + 管家 Butler）----
  // 2026-09-06 试点收归：笔记能力不再随 butler 注入普通对话（chat/sandbox 均不含 notebook 场景），
  // 笔记诉求引导到 Kar（知识库）节点——主 agent 不背负插件能力，子 agent 按业务方向专职。
  // 2026-09-25 P1 统一入口**改口**：管家（Butler）恢复笔记能力——两端入口（微信 / Butler 抽屉）
  // 统一为管家后，/note（含 /note raw）要能在会话里直接办，否则微信里说「记一下」只能把人推去 Kar 节点。
  // 落地方式：route.ts 对 profile.id === 'butler' 做 fixedScenes **运行时并集** 'notebook'（不走
  // agent.json——安装时已物化，改 manifest 对已装用户不生效）；同处给管家 coreExclusions 剔除
  // delete_notebook（不可逆删除仍只归 Kar，防微信短指令误删）。其余画像（chat/coding/市场 agent）照旧不含。
  // 注：维护回路（read_raw_inbox / ingest_notes / review_notes / lint_notes / read_note_rules / set_note_rules）本就在 notebook 场景。
  read_notebook: ['notebook'],
  read_note: ['notebook'],
  read_note_history: ['notebook'],
  restore_note: ['notebook'],
  update_notebook: ['notebook'],
  delete_notebook: ['notebook'],
  create_note: ['notebook'],
  // 2026-09-06 追加收归：write_notebook_answer（答案/决策回填知识库）同样只归 notebook 场景——
  // 写读笔记相关工具在普通对话（General Chat / sandbox / butler 等不含 notebook 场景者）一律不再注入，
  // 沉淀知识库的入口统一为 Kar（知识库）节点或 /note 指令。
  write_notebook_answer: ['notebook'],
  // ---- ledger（项目账本 = 档案员 Archivist 维护的项目档案；与个人库 notebook 并列的第二本库）----
  // 只读入口归 ledger 场景（存在激活项目即放行 → 全体 agent 可先读档案再取原文）；
  // 写/维护工具归 ledger-keeper（仅档案员画像 Archivist 的 fixedScenes 含它）→ 其他 agent 只读不写。
  read_ledger: ['ledger', 'ledger-keeper'],
  // 项目材料检索（P0 只读入口）：读宿主已建的材料内容索引（清单/正文命中），
  // 与 read_ledger 同属「项目档案」面——存在激活项目即放行，全体 agent（含团队成员的固定画像）可用。
  search_materials: ['ledger'],
  // 观点体检（双侧检索 + 对称性呈现）：只读，但属**档案员职责**——2026-09-18 随「账本管理权唯一归 Archivist」收归，
  // 不再给 'ledger' 场景（管家等只读者拿到它就会自行体检，与「引导去档案员」的口径冲突）。
  ledger_challenge: ['ledger-keeper'],
  ledger_record: ['ledger-keeper'],
  ledger_pending: ['ledger-keeper'],
  ledger_lint: ['ledger-keeper'],
  // 项目页（p-… 创作闭环）：一件要产出的事开一页，属档案员的整理职责（其他 agent 只读）。
  ledger_project: ['ledger-keeper'],
  // 规则文件（SCHEMA.md）读写：分区/类型两张机器解析表 + 补充条款。
  // 2026-09-24 补齐：此前 SCHEMA.md 只有「宿主种子/迁移 + 人手改文件」两个写入方，
  // 档案员只能提醒用户去改隐藏目录；结论仍是「宪章由人定」——工具只在用户明确要求时用。
  ledger_schema: ['ledger-keeper'],
  // 注意：read_preferences 保持通用——系统提示条件式指示「任务涉及输出格式/引用规范等偏好时调用」，
  //   触发由模型自主判断（如用户说"用表格输出"无偏好字样），门控会阻断偏好遵循链路
  delete_preference: ['butler'],
  update_preference: ['butler'],
  // Daily News 主题（Today 面板 News 页签）：与界面 chips 同写口，归 butler 场景
  news_topics: ['butler'],
  // ---- 规则原语（v6 §5.1；Phase 0 只固化与可见，不自动执行）----
  // 与偏好同归 butler 场景；用户发起即免确认（确认闸按「谁发起」切）。
  read_rules: ['butler'],
  rule_create: ['butler'],
  rule_update: ['butler'],
  rule_pause: ['butler'],
  rule_retire: ['butler'],
  // 规则信号闭环（v6 §7 / §3.2）：否定与修订落地原语，同样归 butler 场景
  rule_dismiss: ['butler'],
  rule_revise: ['butler'],
  // 冲突裁决落地（v6 §9.3）：need_user 后用户选定方的回传原语
  rule_resolve_conflict: ['butler'],
  // 技能账本（Phase 3 §3.5）：AI 起草一条技能（程序化能力），经可编辑草案卡审固后落 .skills/<id>.md。
  // 与 Rules 同归 butler 场景；本工具只**起草**，确认链路复用规则草案卡的三段（弹卡 → 等确认 → 落盘）。
  skill_draft: ['butler'],
  // 技能账本只读（Phase 3 §3.6）：列出已固化技能及其 id，供模型把 skill 动作绑进规则
  // （rule_create / rule_update 的 action="skill" + action_params.skillId）。与 skill_draft 同归 butler 场景。
  read_skills: ['butler'],
  // 便签（画布/记忆类）：按事务域意图触发（记忆/备忘/便签关键词）；butler 专项固定画像放行
  create_sticky_note: ['butler'],
  // 新建项目（应用结构写动作）：归 butler——管家对话里「新建一个项目：X」直接办；
  // butler 固定画像直接放行，普通 chat 不注入（避免随口一句"新建项目"产生副作用）。
  // 副作用收口：列入 runtime/tools.ts 的 SANDBOX_BLOCKED_TOOLS（工具面 = 能力边界）。
  create_project: ['butler'],
  // 打开/切换当前项目（2026-10-05）：应用结构写动作，但**可逆且不落数据**——用户说「打开 X 项目」
  // 时才调；界面经 project-switched SSE 无刷新跟随。同样只归 butler、并列入写类收口名单。
  switch_project: ['butler'],
  // 新建会话（画布节点）并可选执行任务（2026-10-05）：会话是画布状态，节点本体由前端建，
  // 服务端只解析+授权+广播 session-request（界面未打开时拒绝，不静默失败）。
  // 归 butler：普通 chat 画像不注入，避免随口一句"建个会话"就派生一个无人看守的后台任务。
  create_session: ['butler'],
  // ---- butler（管家：日程/待办）----
  query_schedule: ['butler'],
  query_todos: ['butler'],
  create_scheduled_todo: ['butler'],
  plan_schedule: ['butler'],
  // 时间解析 / 可用性查询（确定性时间计算：把「算时间」交给代码，别让模型心算）
  resolve_datetime: ['butler'],
  query_free_slots: ['butler'],
  // 排程状态只读查询（schedule_meta）：回答「计划是否最新 / 还有什么没排上」
  query_schedule_status: ['butler'],
  // 待办修改/删除：与 query_todos 对齐挂 butler（2026-09-12 收敛：wanted 场景并入 butler，
  // 事务域工具统一归 butler；butler 固定画像直接放行，
  // 普通 chat 说"改/删待办"时 detectSceneHints 命中 butler 注入，否则 0 成本）。
  todo_update: ['butler'],
  todo_delete: ['butler'],
  // ---- butler 计划树状态机（项目规划：里程碑 → 步骤 → 状态推进）----
  project_plan_start: ['butler'],
  project_plan_view: ['butler'],
  project_plan_add_steps: ['butler'],
  project_plan_step_status: ['butler'],
  // ---- butler 模型计费（对话维护单价覆盖：新增模型 / 厂商调价；改价只影响此后产生的用量）----
  // 只读查询 get_model_price 与写入 set_model_price 同归 butler；
  // 普通 chat 说"某模型改价了/新增了某模型，更新计费"时由 detectSceneHints 命中 butler 注入。
  get_model_price: ['butler'],
  set_model_price: ['butler'],
  // ---- butler 会议记录（P1-b：/meeting 工具化——会议缓冲是会话状态，
  //      模型经注入的会议状态知晓"进行中"，用这三件开启/累积/收尾）----
  //      主对话（画布 chat 节点）经 detectSceneHints 的「会议/纪要/开会/meeting」命中本场景；
  //      会议进行中 route 亦直接补放行本场景（会议状态注入与工具必须同时在场）。----
  meeting_start: ['butler'],
  meeting_append: ['butler'],
  meeting_end: ['butler'],

  // ---- meeting 过往会议归档（会议记录员 Recorder 专属；2026-09-27）----
  //  这两枚工具挂在**新场景 meeting** 上——只有 recorder 画像的 fixedScenes 含它，
  //  管家（butler）/ 画布主对话 / 微信桥都拿不到（工具面 = 能力边界）。
  meeting_search: ['meeting'],
  meeting_summarize: ['meeting'],

  // ---- 节点树/画布结构依赖（画布节点对话 nodeId 存在才暴露）----
  read_upstream_node: ['node'],
  read_manifest: ['node'],
  intern_search: ['node'],
  draw: ['node'],
  // ---- 音频转写（转写/录音/语音关键词或音频附件才暴露）；语音合成与之同域（"用语音回复"意图）----
  transcribe_audio: ['audio'],
  text_to_speech: ['audio'],
  // ---- 主题设计（coding 节点自动放行，普通对话按主题/前端关键词放行）----
  get_current_theme: ['design'],
  // ---- OCR 文字识别（OCR/扫描关键词或图片/PDF 附件才暴露）----
  ocr_document: ['ocr'],
  // 图像 ROI 裁剪：OCR/图片处理流程配套（手写字段栏、印章、签名、日期裁剪）
  crop_image: ['ocr'],
  // ---- office 文档（Word 模板批量填充/占位符扫描：文档/模板/Word 意图才暴露）----
  fill_docx_templates: ['office'],
  scan_docx_templates: ['office'],
  // ---- admin 管理（配置/模型/沙盒运维：用户明确提及管理类操作才暴露，低频）----
  manage_mcp_server: ['admin'],
  manage_quick_launch: ['admin'],
  check_mcp_gaps: ['admin'],
  update_provider_config: ['admin'],
  list_configured_models: ['admin'],
  test_model: ['admin'],
  get_app_config: ['admin'],
  set_app_icon: ['admin'],
  sandbox_rollback: ['admin'],
  sandbox_export: ['admin'],

  // ---- console（应用状态只读查询：给 Chief of Staff 型助理「查应用」的能力）----
  // 2026-09-24 新增：list_agents / list_projects / list_nodes / get_app_status / read_inbox
  // 全部只读（不改 DB、不挂载插件、不写文件）， Butler 画像 via fixedScenes 放行；
  // 普通对话命中 console 意图时才注入，其余画像 0 成本。
  list_agents: ['console'],
  list_projects: ['console'],
  list_nodes: ['console'],
  get_app_status: ['console'],
  read_inbox: ['console'],
};

/**
 * 工具注册表。管理 agent 可用的所有工具。
 *
 * 对应 Python 版 ToolRegistry：
 *   - register(tool): 注册单个工具
 *   - get(name): 按名称查找
 *   - toApiFormat(): 批量转换为 OpenAI API 格式
 *   - byCategory(cat): 按分类筛选
 */
export class ToolRegistry {
  private _tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this._tools.set(tool.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  unregister(name: string): boolean {
    return this._tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this._tools.get(name);
  }

  listAll(): Tool[] {
    return Array.from(this._tools.values());
  }

  byCategory(category: ToolCategory): Tool[] {
    return this.listAll().filter((t) => t.category === category);
  }

  toApiFormat(activeScenes?: Set<ToolScene>): ToolDefinition[] {
    return this.listAll()
      // 确定性顺序（按工具名排序）：消除 MCP 异步连接/注册顺序抖动，
      // 保证每轮工具定义前缀一字不差 → 命中网关前缀缓存（dsh 方案核心）
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter((t) => {
        // 场景过滤：工具标注了 scenes 时，仅当任一场景被激活才暴露；未标注 = 通用工具
        if (!activeScenes || activeScenes.size === 0) return true;
        const scenes = t.scenes ?? SCENED_TOOLS[t.name];
        if (!scenes || scenes.length === 0) return true;
        return scenes.some((s) => activeScenes.has(s));
      })
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
  }

  count(): number {
    return this._tools.size;
  }
}

/** 全局工具注册表实例（工具定义在 index.ts 装配完成后 registerAll） */
export const registry = new ToolRegistry();
