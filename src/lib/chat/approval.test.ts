/**
 * P4b-1 审批策略层纯函数单测：三策略 ×（名单内 / 写类 / 读类）裁决矩阵 + 写类典型样例。
 * 默认档零变化证明：allow_scope 下名单内 → request、写类/读类（名单外）→ allow（不 consult 写类判定）。
 */
import { describe, expect, it } from 'vitest';
import { decideToolApproval, isWriteKindTool } from './approval';
import type { ApprovalStrategy, ToolApprovalVerdict } from './approval';

const STRATEGIES: ApprovalStrategy[] = ['allow_scope', 'ask', 'never'];

describe('isWriteKindTool 内置写类工具', () => {
  it.each([
    // 文件/编辑写类
    'write_file',
    'append_file',
    'edit_code',
    'rename_file',
    'delete_file',
    'copy_file',
    'move_file',
    // 命令/脚本执行（shell 系语义）
    'run_command',
    'execute_script',
    // 配置写类
    'set_app_icon',
    'update_provider_config',
    'manage_mcp_server',
  ])('%s → true', (name) => {
    expect(isWriteKindTool(name)).toBe(true);
  });
});

describe('isWriteKindTool 内置读类工具（保守：不误判）', () => {
  it.each([
    'read_file',
    'read_attachment',
    'get_app_config',
    'search_capabilities',
    'web_search',
    'web_fetch',
    'ask_user_questions',
    'list_files',
  ])('%s → false', (name) => {
    expect(isWriteKindTool(name)).toBe(false);
  });
});

describe('isWriteKindTool browser 写类（主对话 mcp__ 全名 / browser.click 简称 / 裸 browser_click 三种形式）', () => {
  it.each([
    // 页面操纵/表单交互
    'mcp__bob-browser-mcp__browser_click',
    'mcp__bob-browser-mcp__browser_type',
    'mcp__bob-browser-mcp__browser_fill_form',
    'mcp__bob-browser-mcp__browser_select_option',
    'mcp__bob-browser-mcp__browser_press_key',
    'mcp__bob-browser-mcp__browser_submit',
    'mcp__bob-browser-mcp__browser_click_coordinates',
    'mcp__bob-browser-mcp__browser_check',
    'mcp__bob-browser-mcp__browser_uncheck',
    'mcp__bob-browser-mcp__browser_drag',
    // 文件/内容产出
    'mcp__bob-browser-mcp__browser_upload_file',
    'mcp__bob-browser-mcp__browser_export_pdf',
    // 视图滚动
    'mcp__bob-browser-mcp__browser_scroll',
    // 脚本注入/持久存储写入
    'mcp__bob-browser-mcp__browser_run_js',
    'mcp__bob-browser-mcp__browser_page_script',
    'mcp__bob-browser-mcp__browser_set_cookie',
    'mcp__bob-browser-mcp__browser_clear_cookies',
    'mcp__bob-browser-mcp__browser_set_storage',
    'mcp__bob-browser-mcp__browser_clear_storage',
  ])('%s → true', (name) => {
    expect(isWriteKindTool(name)).toBe(true);
  });
  it.each(['browser.click', 'browser_click', 'mcp__webbridge__browser_click'])('简称/异名 server 形式 %s → true', (name) => {
    expect(isWriteKindTool(name)).toBe(true);
  });
});

describe('isWriteKindTool browser 读/导航/UI 探测类（保守：不判写）', () => {
  it.each([
    'mcp__bob-browser-mcp__browser_navigate',
    'mcp__bob-browser-mcp__browser_snapshot',
    'mcp__bob-browser-mcp__browser_extract_text',
    'mcp__bob-browser-mcp__browser_get_html',
    'mcp__bob-browser-mcp__browser_read_article',
    'mcp__bob-browser-mcp__browser_screenshot',
    'mcp__bob-browser-mcp__browser_hover',
    'mcp__bob-browser-mcp__browser_switch_tab',
    'mcp__bob-browser-mcp__browser_open_tab',
    'mcp__bob-browser-mcp__browser_close_tab',
    'mcp__bob-browser-mcp__browser_reload',
    'mcp__bob-browser-mcp__browser_get_cookies',
    'mcp__bob-browser-mcp__browser_login',
    'mcp__bob-browser-mcp__browser_detect_login',
    'mcp__bob-browser-mcp__browser_wait_for_text',
    'browser.snapshot',
  ])('%s → false', (name) => {
    expect(isWriteKindTool(name)).toBe(false);
  });
});

describe('decideToolApproval 三策略 ×（名单内/写类/读类）矩阵', () => {
  // 每个 (strategy, inList, name) → 期望 verdict
  const CASES: Array<{ strategy: ApprovalStrategy; inConfirmList: boolean; name: string; expected: ToolApprovalVerdict }> = [
    // allow_scope（默认档）：仅名单内 request，其余一律 allow（不 consult 写类 → 现网零变化）
    { strategy: 'allow_scope', inConfirmList: true, name: 'read_file', expected: 'request' },
    { strategy: 'allow_scope', inConfirmList: true, name: 'write_file', expected: 'request' },
    { strategy: 'allow_scope', inConfirmList: false, name: 'write_file', expected: 'allow' }, // 写类在默认档自动放行（现网）
    { strategy: 'allow_scope', inConfirmList: false, name: 'run_command', expected: 'allow' },
    { strategy: 'allow_scope', inConfirmList: false, name: 'mcp__bob-browser-mcp__browser_click', expected: 'allow' },
    { strategy: 'allow_scope', inConfirmList: false, name: 'read_file', expected: 'allow' },
    // ask：名单内 request；写类（名单外）request；读类 allow
    { strategy: 'ask', inConfirmList: true, name: 'read_file', expected: 'request' },
    { strategy: 'ask', inConfirmList: false, name: 'write_file', expected: 'request' },
    { strategy: 'ask', inConfirmList: false, name: 'run_command', expected: 'request' },
    { strategy: 'ask', inConfirmList: false, name: 'mcp__bob-browser-mcp__browser_click', expected: 'request' },
    { strategy: 'ask', inConfirmList: false, name: 'read_file', expected: 'allow' },
    { strategy: 'ask', inConfirmList: false, name: 'browser.snapshot', expected: 'allow' },
    // never：名单内 deny；写类（名单外）deny；读类 allow
    { strategy: 'never', inConfirmList: true, name: 'read_file', expected: 'deny' },
    { strategy: 'never', inConfirmList: false, name: 'write_file', expected: 'deny' },
    { strategy: 'never', inConfirmList: false, name: 'run_command', expected: 'deny' },
    { strategy: 'never', inConfirmList: false, name: 'mcp__bob-browser-mcp__browser_click', expected: 'deny' },
    { strategy: 'never', inConfirmList: false, name: 'read_file', expected: 'allow' },
    { strategy: 'never', inConfirmList: false, name: 'web_search', expected: 'allow' },
    { strategy: 'never', inConfirmList: false, name: 'browser.snapshot', expected: 'allow' },
  ];
  it.each(CASES)('$strategy × inConfirmList=$inConfirmList × $name → $expected', (c) => {
    expect(
      decideToolApproval({ name: c.name, inConfirmList: c.inConfirmList, strategy: c.strategy }),
    ).toBe(c.expected);
  });

  it('三策略 × 名单内恒 request/deny 一致性', () => {
    // 名单内：allow_scope/ask → request；never → deny（与写类无关）
    expect(decideToolApproval({ name: 'read_file', inConfirmList: true, strategy: 'allow_scope' })).toBe('request');
    expect(decideToolApproval({ name: 'read_file', inConfirmList: true, strategy: 'ask' })).toBe('request');
    expect(decideToolApproval({ name: 'read_file', inConfirmList: true, strategy: 'never' })).toBe('deny');
  });

  it('全部策略集合穷举无遗漏（9 组合）', () => {
    for (const strategy of STRATEGIES) {
      // 名单内写类
      expect(decideToolApproval({ name: 'write_file', inConfirmList: true, strategy })).toBe(
        strategy === 'never' ? 'deny' : 'request',
      );
      // 名单外写类
      expect(decideToolApproval({ name: 'write_file', inConfirmList: false, strategy })).toBe(
        strategy === 'allow_scope' ? 'allow' : strategy === 'ask' ? 'request' : 'deny',
      );
      // 名单外读类
      expect(decideToolApproval({ name: 'read_file', inConfirmList: false, strategy })).toBe('allow');
    }
  });
});
