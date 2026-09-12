import { describe, expect, it } from 'vitest';
import { getToolLayer, getToolSource } from '@/app/api/chat/tools';
import { isAllDynamicSceneChange, isDynamicSceneTool } from '@/lib/runtime/tools';

/**
 * CacheGuard / 前缀分层语义（2026-09-09）：
 * SCENED_TOOLS 场景门控的内置工具 = 动态（随画像/场景激活），必须归 ondemand 段，
 * 不能落入 core「常驻锚点段」——否则场景切换增减会作废整段前缀缓存，
 * 并被 CacheGuard 豁免判定误报为异常漂移（cacheguard.jsonl 曾累积 50+ 次误报）。
 */
describe('tool layer: SCENED_TOOLS 场景门控工具归 ondemand（修复前默认 core 误锚点）', () => {
  const scenedButlerTodo = [
    'query_schedule',
    'query_todos',
    'create_scheduled_todo',
    'todo_update',
    'todo_delete',
    'project_plan_start',
    'project_plan_view',
    'project_plan_add_steps',
    'project_plan_step_status',
  ];

  it.each(scenedButlerTodo)('%s 有场景门控 → ondemand（不进 core 锚点段）', (name) => {
    expect(getToolLayer(name)).toBe('ondemand');
  });

  it('核心常驻锚点工具保持 core（不误伤）', () => {
    for (const name of ['read_file', 'write_file', 'edit_code', 'run_command', 'execute_script', 'web_search', 'web_fetch', 'read_attachment', 'todo_write', 'finish_task', 'ask_user_questions', 'read_preferences', 'load_skill', 'read_skill_resource', 'search_capabilities', 'read_material']) {
      expect(getToolLayer(name), name).toBe('core');
    }
  });

  it('BUILTIN_LAYER 显式 ondemand 标注仍优先', () => {
    expect(getToolLayer('ocr_document')).toBe('ondemand');
    expect(getToolLayer('crop_image')).toBe('ondemand');
    expect(getToolLayer('remember_preference')).toBe('ondemand');
  });
});

describe('CacheGuard 豁免边界（修复后：场景切换不误报，core 真漂移仍告警）', () => {
  it('场景门控内置工具 = 动态场景工具 → 豁免', () => {
    for (const name of ['query_schedule', 'query_todos', 'create_scheduled_todo', 'todo_update', 'todo_delete', 'project_plan_start', 'project_plan_add_steps', 'ocr_document', 'read_todo']) {
      expect(isDynamicSceneTool(name), name).toBe(true);
    }
  });

  it('core 常驻锚点工具 = 非动态 → 不豁免（真漂移仍告警）', () => {
    for (const name of ['read_file', 'write_file', 'edit_code', 'run_command', 'execute_script', 'web_search', 'web_fetch', 'read_attachment', 'todo_write', 'finish_task', 'search_capabilities', 'read_material']) {
      expect(isDynamicSceneTool(name), name).toBe(false);
    }
  });

  it('纯场景切换的增减集 → isAllDynamicSceneChange=true（豁免）', () => {
    const changed = [
      'query_todos:NEW(a1b2c3d4)',
      'create_scheduled_todo:NEW(deadbeef)',
      'project_plan_start:REMOVED',
    ];
    expect(isAllDynamicSceneChange(changed)).toBe(true);
  });

  it('混入 core 工具字节变化的集 → false（真漂移，不豁免）', () => {
    const changed = [
      'query_todos:NEW(a1b2c3d4)',
      'read_file:224d0149→5247c711',
    ];
    expect(isAllDynamicSceneChange(changed)).toBe(false);
  });

  it('MCP 工具增减 → 豁免（getToolSource===\'mcp\' 路径）', () => {
    expect(isDynamicSceneTool('mcp__pkulaw__mcp-fatiao_get_law_item_content')).toBe(true);
  });
});
