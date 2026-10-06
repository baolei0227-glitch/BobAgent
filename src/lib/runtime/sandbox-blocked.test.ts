import { describe, expect, it } from 'vitest';
import { SANDBOX_BLOCKED_TOOLS, WECHAT_ALLOWED_WRITES } from '@/lib/runtime/tools';

/**
 * 沙盒 / 微信通道的写类工具名单不变量（2026-09-25）。
 *
 * 背景证据：`lib/core/node-chat.ts` 曾有 SANDBOX_SYSTEM_PROMPT 声称「不调用 write_file /
 * rename_file / delete_file / run_command / execute_script / draw 等写类工具，**不写入待办、
 * 日历或任何文件**」，但 SANDBOX_BLOCKED_TOOLS 一度只挡文件/命令类 —— 排程三件套
 * （create_scheduled_todo / todo_update / todo_delete）与创建便签（create_sticky_note）
 * 照旧注入，提示词说「不能写」而工具面给着写接口。
 * 实测后果（.inbox.db `chat-1790283742409-ga15g6`，用户问「你可以帮我添加日程吗？」）：
 * 模型 ` thinking` 里明确纠结 "tools list includes create_scheduled_todo… There's tension"，
 * 最终在一份「禁写」与一份「可写」的指令间摇摆，行为不可预期。
 *
 * 本用例锁住不变量：副作用工具名单 = 文件/命令/配置写 + 待办/日历写 + 笔记写类；只读查询不得误拦。
 * P0 统一入口后新增第二条：微信通道白名单 WECHAT_ALLOWED_WRITES 必须是本名单的子集
 * （白名单只用于「在微信通道豁免名单里的这几件」，不能凭空放行名单外的工具）。
 * P2（2026-09-25）第三条：笔记写类此前散落名单外 → 在聚合链路被静默直接执行、不弹确认；
 * 现补入名单，并由微信白名单显式放行（delete_notebook 除外），令「工具面 = 声称的能力边界」。 */
describe('沙盒工具面与写类名单的对齐', () => {
  it('待办 / 日历写类一律拦掉', () => {
    for (const name of ['create_scheduled_todo', 'todo_update', 'todo_delete', 'create_sticky_note']) {
      expect(SANDBOX_BLOCKED_TOOLS.has(name), name).toBe(true);
    }
  });

  it('只读查询不受影响（沙盒仍能查日历/待办来回答提问）', () => {
    for (const name of ['query_schedule', 'query_todos', 'read_todo']) {
      expect(SANDBOX_BLOCKED_TOOLS.has(name), name).toBe(false);
    }
  });

  it('文件 / 命令 / 程序配置写类仍在名单内（原有语义不回归）', () => {
    for (const name of ['write_file', 'rename_file', 'delete_file', 'run_command', 'execute_script', 'set_app_icon', 'update_provider_config', 'manage_mcp_server']) {
      expect(SANDBOX_BLOCKED_TOOLS.has(name), name).toBe(true);
    }
  });

  it('名单里的工具名都是合法工具名（防手写错别字导致拦了个不存在的名字）', () => {
    for (const name of SANDBOX_BLOCKED_TOOLS) {
      expect(name, name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  it('微信通道白名单是副作用名单的子集（只做豁免，不凭空放行）', () => {
    for (const name of WECHAT_ALLOWED_WRITES) {
      expect(SANDBOX_BLOCKED_TOOLS.has(name), name).toBe(true);
    }
  });

  it('笔记写类一律拦掉，并由微信白名单显式放行（delete_notebook 除外）', () => {
    // P2：此前散落名单外 → 聚合链路静默直接执行、不弹确认
    for (const name of ['create_note', 'update_notebook', 'write_notebook_answer', 'restore_note', 'ingest_notes', 'review_notes', 'set_note_rules', 'delete_notebook']) {
      expect(SANDBOX_BLOCKED_TOOLS.has(name), name).toBe(true);
    }
    // 微信放行高频低风险写类，但破坏性的 delete_notebook 不放行
    for (const name of ['create_note', 'update_notebook', 'write_notebook_answer', 'restore_note', 'ingest_notes', 'review_notes', 'set_note_rules']) {
      expect(WECHAT_ALLOWED_WRITES.has(name), name).toBe(true);
    }
    expect(WECHAT_ALLOWED_WRITES.has('delete_notebook')).toBe(false);
    // lint_notes 是只读自检，不得误拦
    expect(SANDBOX_BLOCKED_TOOLS.has('lint_notes')).toBe(false);
  });

  it('用户记忆写类一律拦掉（2026-10-02 补），但读取不受影响', () => {
    // 背景：记忆真源 `butler/preferences.md` 是**所有联系人共享**的全局状态；
    // 沙盒/编排链路的契约是「不对外部状态产生副作用」，此前这三个写工具在名单外 = 给着写接口。
    for (const name of ['remember_preference', 'update_preference', 'delete_preference']) {
      expect(SANDBOX_BLOCKED_TOOLS.has(name), name).toBe(true);
      // 也不走微信白名单：手机端高频低风险写类里没有它们（记忆由管家在对话中自己维护）
      expect(WECHAT_ALLOWED_WRITES.has(name), name).toBe(false);
    }
    // 只读记忆必须仍可用，否则沙盒链路回答不了「我有哪些偏好」
    for (const name of ['read_preferences', 'read_rules']) {
      expect(SANDBOX_BLOCKED_TOOLS.has(name), name).toBe(false);
    }
  });

  it('打开项目 / 新建会话（2026-10-05 补）：沙盒一律拦掉，微信通道放行', () => {
    // 背景：管家新增 switch_project（切当前项目）与 create_session（在画布里派生会话，
    // 并可能让该会话在后台无人看守地跑任务）。两者都改应用结构状态——
    // 沙盒/编排链路（team 成员、organize-send）不该动用户眼前的画布与项目指针；
    // 微信是用户本人的手机入口，「打开 X 项目，建个会话把这件事跑了」正是典型指令，故放行。
    for (const name of ['switch_project', 'create_session']) {
      expect(SANDBOX_BLOCKED_TOOLS.has(name), name).toBe(true);
      expect(WECHAT_ALLOWED_WRITES.has(name), name).toBe(true);
    }
    // 只读的项目/应用状态查询不得误拦（否则沙盒里答不出「有哪些项目 / 当前在哪个」）
    for (const name of ['list_projects', 'list_nodes', 'get_app_status']) {
      expect(SANDBOX_BLOCKED_TOOLS.has(name), name).toBe(false);
    }
  });
});
