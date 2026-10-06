/**
 * 检索源注册表 ↔ 工具面 漂移护栏（2026-10-05）
 *
 * 背景：管家「能看见哪些知识源」此前散落在四处硬编码（SCENED_TOOLS / fixedScenes /
 * route 运行时并集 / context.ts 文案）。收敛为 runtime/sources.ts 注册表后，最大的风险是
 * 「登记表说这个源可用，工具面其实没有」——即登记与该画像真实的工具面漂移。
 *
 * 本用例以**真实工具面**（getToolDefinitions，index.ts 装配完成后注册的真源）为基准做四组断言，
 * 零运行时开销、纯单测：新增/改名/删工具时，悬空引用或场景归属不一致会在此立刻暴露。
 *
 * 读法：`getToolDefinitions(scenes)` 的 scenes 若为空集 = 全放行（见 ToolRegistry.toApiFormat），
 * 故**反向断言必须传非空场景集**。
 */
import { describe, expect, it } from 'vitest';
import { SOURCES } from '@/lib/runtime/sources';
import { getToolDefinitions } from '@/app/api/chat/tools';
import { SCENED_TOOLS } from '@/app/api/chat/tools/registry';
import type { ToolScene } from '@/app/api/chat/tools';

/** 某非空场景集下可见的工具名集合 */
function visibleNames(scenes: ToolScene[]): Set<string> {
  return new Set(getToolDefinitions(new Set<ToolScene>(scenes)).map((d) => d.function.name));
}

describe('检索源注册表 ↔ 工具面漂移护栏', () => {
  it('① 存在性：每条源登记的工具都真实存在于工具面（防改名留下悬空引用）', () => {
    for (const src of SOURCES) {
      const names = visibleNames([...src.scenes, 'general']);
      for (const tool of src.tools) {
        expect(names.has(tool), `${src.id} → ${tool} 不存在于工具面`).toBe(true);
      }
    }
  });

  it('② 场景归属：任一 entry.scenes 生效时，entry.tools 全部可见', () => {
    for (const src of SOURCES) {
      for (const scene of src.scenes) {
        const names = visibleNames([scene]);
        for (const tool of src.tools) {
          expect(names.has(tool), `${src.id} @${scene} → ${tool} 不可见`).toBe(true);
        }
      }
    }
  });

  it('②b excludedTools 注释有效：被排除的工具确实是该场景内工具（排除才有意义）', () => {
    // 注意：excludedTools（如管家剔除 delete_notebook）由**画像 coreExclusions** 在
    // ToolRuntime.computeActiveToolDefs 阶段剔除，getToolDefinitions 层不过滤——
    // 故此处置断言「它在场景内」（证明标注未失效），而非断言「它不可见」。
    for (const src of SOURCES) {
      if (!src.excludedTools?.length) continue;
      const names = visibleNames([...src.scenes, 'general']);
      for (const tool of src.excludedTools) {
        expect(names.has(tool), `${src.id} 的 excludedTools「${tool}」已不在其场景内，标注失效`).toBe(true);
      }
    }
  });

  it('③ 反向：未命中场景时，场景化工具不可见（防场景标注被误删）', () => {
    for (const src of SOURCES) {
      // 通用工具（SCENED_TOOLS 无登记）在任何非空场景集下都可见 → 只断言被场景门控者
      const scened = src.tools.filter((t) => SCENED_TOOLS[t]);
      if (scened.length === 0) continue;
      expect(src.scenes, `${src.id} 不应把 'general' 当作专属场景`).not.toContain('general');
      const names = visibleNames(['general']);
      for (const tool of scened) {
        expect(names.has(tool), `${src.id} → ${tool} 在未命中场景下仍可见`).toBe(false);
      }
    }
  });

  it('④ 一致性：entry.scenes 与各工具的 SCENED_TOOLS 归属有交集（通用工具豁免）', () => {
    for (const src of SOURCES) {
      for (const tool of src.tools) {
        const owned = SCENED_TOOLS[tool];
        if (!owned) continue; // 通用工具：无场景门控，任何场景都可见
        expect(
          src.scenes.some((s) => owned.includes(s)),
          `${src.id} → ${tool}（实际归属 ${owned.join(' / ')}）与 entry.scenes 无交集`,
        ).toBe(true);
      }
    }
  });
});
