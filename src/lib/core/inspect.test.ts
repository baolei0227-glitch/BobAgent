/**
 * inspect.formatInspectReply —— 报告层级「按需折叠」不变量
 *
 * 背景（2026-09-25 用户反馈）：
 *   ① 报告里「■ 项目名」下一行紧跟「◇ 同名」（便签标题默认取项目名）→ 同字重复
 *   ② 「· P1」是残层：分页能力已废（/api/sticky-notes 无「新增页」动作），每张便签恒为单页
 *   ③ 每项目最多 3 张待办便签（MAX_TODO_NOTES）→ 多张时便签标题**必须**保留
 *
 * 本用例锁住折叠规则，防止以后有人把两层改回无条件输出。
 */
import { describe, expect, it } from 'vitest';
import { formatInspectReply, type InspectResult, type InspectProject } from './inspect';
import type { StickyTodoIndexNote } from '@/lib/sticky-todo';

function page(pageId: string, pageTitle: string, items: string[]) {
  return { pageId, pageTitle, items };
}

function note(noteId: string, title: string, pages: StickyTodoIndexNote['pages']): StickyTodoIndexNote {
  return { noteId, title, color: 'yellow', pages };
}

function project(projectName: string, notes: StickyTodoIndexNote[], isCurrent = false): InspectProject {
  const pendingCount = notes.reduce(
    (s, n) => s + n.pages.reduce((s2, p) => s2 + p.items.length, 0),
    0,
  );
  return { projectId: `p-${projectName}`, projectName, isCurrent, notes, pendingCount };
}

function result(projects: InspectProject[]): InspectResult {
  const withTodos = projects.filter((p) => p.pendingCount > 0);
  const totalPending = withTodos.reduce((s, p) => s + p.pendingCount, 0);
  return {
    projects: withTodos,
    scope: 'all',
    projectCount: withTodos.length,
    noteCount: withTodos.reduce((s, p) => s + p.notes.length, 0),
    totalPending,
    // 与 inspectStickyTodos 真实语义一致：无待办即 empty（并清空 projects）
    empty: totalPending === 0,
    ...(totalPending === 0 ? { projects: [] } : {}),
    fromIndex: true,
  };
}

describe('formatInspectReply 层级折叠', () => {
  it('单便签且标题 = 项目名 + 单页 P1 → 便签层与页层整层省略，只剩项目 + 待办', () => {
    const out = formatInspectReply(
      result([project('上坤企业_20260824', [note('n1', '上坤企业_20260824', [page('pg1', 'P1', ['审核债权申报'])])])]),
    );
    expect(out).toContain('■ 上坤企业_20260824 — 1 项');
    expect(out).not.toContain('◇');
    expect(out).not.toContain('· P1');
    // 待办行缩进上提到项目层之下（2 空格），不再残留 4/6 空格
    expect(out).toContain('\n  ☐ 审核债权申报');
  });

  it('单便签但标题 ≠ 项目名 → 保留便签层，仍省略 P1', () => {
    const out = formatInspectReply(
      result([project('南宁鲸红_20260825', [note('n1', '南宁鲸红常法-0824', [page('pg1', 'P1', ['审核招募文件'])])])]),
    );
    expect(out).toContain('■ 南宁鲸红_20260825 — 1 项');
    expect(out).toContain('◇ 南宁鲸红常法-0824');
    expect(out).not.toContain('· P1');
    expect(out).toContain('\n    ☐ 审核招募文件');
  });

  it('多张便签 → 无论标题是否等于项目名，便签层都必须保留（否则无法区分）', () => {
    const out = formatInspectReply(
      result([
        project('某项目', [
          note('n1', '某项目', [page('pg1', 'P1', ['甲'])]),
          note('n2', '某项目', [page('pg2', 'P1', ['乙'])]),
        ]),
      ]),
    );
    // 两张便签标题都与项目名相同 → 仍要出两行 ◇（靠内容区分，不能折叠）
    expect(out.match(/◇/g)?.length).toBe(2);
  });

  it('多页便签 → 页层保留，且页标题与待办行都在', () => {
    const out = formatInspectReply(
      result([
        project('某项目', [
          note('n1', '某项目', [page('pg1', 'P1', ['甲']), page('pg2', 'P2', ['乙'])]),
        ]),
      ]),
    );
    expect(out).toContain('· P1');
    expect(out).toContain('· P2');
    expect(out).toContain('☐ 甲');
    expect(out).toContain('☐ 乙');
  });

  it('单页但页被起了自定义名字 → 页层保留（不按 Pn 吞掉）', () => {
    const out = formatInspectReply(
      result([project('某项目', [note('n1', '某项目', [page('pg1', '开庭安排', ['甲'])])])]),
    );
    expect(out).toContain('· 开庭安排');
    expect(out).not.toMatch(/· P1/);
  });

  it('空待办 → 给出空态文案，不输出任何层级', () => {
    const out = formatInspectReply(result([]));
    expect(out).toContain('暂无未完成待办');
    expect(out).not.toContain('■');
  });
});
