import { describe, expect, it } from 'vitest';
import {
  resolveExplicitProject,
  resolveProjectWithFallback,
  type ProjectLookupDeps,
  type ResolvedProjectRef,
} from '@/lib/project/resolve-explicit-project';

/**
 * 项目归属解析回归（2026-09-27）。
 *
 * 第一层 resolveExplicitProject：只认显式引用（点名项目 / 哨兵 current），空引用 → project_required。
 * 第二层 resolveProjectWithFallback：写类工具统一口径 —— 显式引用原样通过；未提及项目则兜底
 * 当前激活项目（current_fallback），且把落点来源随回执回传，让"写偏"可见（不再静默兜底）。
 */

const CONTRACT: ResolvedProjectRef = {
  id: 'contract-20260927',
  name: '合同_20260927',
  path: '/tmp/projects/合同',
};
const LITIGATION: ResolvedProjectRef = {
  id: 'litigation-20260927',
  name: '诉讼_20260927',
  path: '/tmp/projects/诉讼',
};

function makeDeps(
  active: ResolvedProjectRef[] = [CONTRACT, LITIGATION],
  current: ResolvedProjectRef = CONTRACT,
): ProjectLookupDeps {
  return {
    listActiveProjects: async () => active,
    getCurrent: async () => current,
  };
}

describe('resolveExplicitProject — 未提及项目不得回落当前项目', () => {
  it('空引用 → project_required（不返回当前项目）', async () => {
    for (const ref of [undefined, null, '', '   ']) {
      const r = await resolveExplicitProject(ref, makeDeps());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('project_required');
    }
  });

  it('哨兵（当前项目）→ 仅在用户明确说"当前项目"时才解析为当前项目', async () => {
    for (const ref of ['current', 'CURRENT', 'current project', '当前项目', '这个项目', ' 当前 ']) {
      const r = await resolveExplicitProject(ref, makeDeps());
      expect(r.ok, ref).toBe(true);
      if (r.ok) {
        expect(r.via).toBe('current');
        expect(r.project.id).toBe(CONTRACT.id);
      }
    }
  });

  it('哨兵但应用无激活项目（getCurrent 抛错）→ no_current_project，不外抛', async () => {
    const deps: ProjectLookupDeps = {
      listActiveProjects: async () => [],
      getCurrent: async () => {
        throw new Error('NO_PROJECT');
      },
    };
    const r = await resolveExplicitProject('current', deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('no_current_project');
  });

  it('按项目 ID 精确匹配', async () => {
    const r = await resolveExplicitProject(LITIGATION.id, makeDeps());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.via).toBe('id');
      expect(r.project.name).toBe(LITIGATION.name);
    }
  });

  it('按项目名匹配（trim + 大小写不敏感）', async () => {
    const deps = makeDeps([
      { id: 'alpha-1', name: 'Alpha Project', path: '/tmp/alpha' },
      CONTRACT,
    ]);
    const r = await resolveExplicitProject('  alpha project ', deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.via).toBe('name');
      expect(r.project.id).toBe('alpha-1');
    }
  });

  it('同名多命中 → project_ambiguous（不猜）', async () => {
    const deps = makeDeps([
      { id: 'a-1', name: '同名项目', path: '/tmp/a' },
      { id: 'b-1', name: '同名项目', path: '/tmp/b' },
    ]);
    const r = await resolveExplicitProject('同名项目', deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('project_ambiguous');
      expect(r.candidates?.map((c) => c.id)).toEqual(['a-1', 'b-1']);
    }
  });

  it('未找到 → project_not_found，且**绝不**回落当前项目', async () => {
    const r = await resolveExplicitProject('不存在的项目', makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('project_not_found');
      expect(r.candidates?.map((c) => c.id)).toEqual([CONTRACT.id, LITIGATION.id]);
    }
  });

  it('只匹配活跃项目（归档/垃圾桶项目不在候选内 → not_found）', async () => {
    // deps.listActiveProjects 已按语义只返回活跃项目，此处验证解析器不会命中列表外项目
    const deps = makeDeps([CONTRACT]);
    const r = await resolveExplicitProject(LITIGATION.id, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('project_not_found');
  });

  it('基名匹配：只说基名（无日期后缀）→ 命中 <基名>_YYYYMMDD', async () => {
    const deps = makeDeps([
      { id: '余靖潘案-20260927', name: '余靖潘案_20260927', path: '/tmp/yjp' },
      CONTRACT,
    ]);
    const r = await resolveExplicitProject(' 余靖潘案 ', deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.via).toBe('name');
      expect(r.project.id).toBe('余靖潘案-20260927');
    }
  });

  it('基名匹配：基名相同但日期不同有多个 → project_ambiguous（不猜）', async () => {
    const deps = makeDeps([
      { id: '余靖潘案-20260926', name: '余靖潘案_20260926', path: '/tmp/a' },
      { id: '余靖潘案-20260927', name: '余靖潘案_20260927', path: '/tmp/b' },
    ]);
    const r = await resolveExplicitProject('余靖潘案', deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('project_ambiguous');
      expect(r.candidates?.map((c) => c.id)).toEqual(['余靖潘案-20260926', '余靖潘案-20260927']);
    }
  });

  it('基名兜底不越过明确日期：带日期后缀但日期不符 → project_not_found', async () => {
    const deps = makeDeps([{ id: '余靖潘案-20260927', name: '余靖潘案_20260927', path: '/tmp/b' }]);
    const r = await resolveExplicitProject('余靖潘案_20260926', deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('project_not_found');
  });
});

describe('resolveProjectWithFallback — 未提及项目时兜底当前激活项目（写类工具统一口径）', () => {
  it('点名项目 → explicit（不兜底）', async () => {
    const r = await resolveProjectWithFallback(LITIGATION.id, {}, makeDeps());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe('explicit');
      expect(r.project?.id).toBe(LITIGATION.id);
    }
  });

  it('显式 current → current_explicit', async () => {
    const r = await resolveProjectWithFallback('current', {}, makeDeps());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe('current_explicit');
      expect(r.project?.id).toBe(CONTRACT.id);
    }
  });

  it('未提及项目 → current_fallback，落当前激活项目', async () => {
    for (const ref of [undefined, null, '', '   ']) {
      const r = await resolveProjectWithFallback(ref, {}, makeDeps());
      expect(r.ok, String(ref)).toBe(true);
      if (r.ok) {
        expect(r.source).toBe('current_fallback');
        expect(r.project?.id).toBe(CONTRACT.id);
      }
    }
  });

  it('未提及项目且无激活项目：默认拒绝（no_active_project 结构化错误）', async () => {
    const deps: ProjectLookupDeps = {
      listActiveProjects: async () => [],
      getCurrent: async () => {
        throw new Error('NO_PROJECT');
      },
    };
    const r = await resolveProjectWithFallback(undefined, {}, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.parse(r.payload).error).toBe('no_active_project');
  });

  it('未提及项目且无激活项目：allowGlobal=true → project=null / source=global', async () => {
    const deps: ProjectLookupDeps = {
      listActiveProjects: async () => [],
      getCurrent: async () => {
        throw new Error('NO_PROJECT');
      },
    };
    const r = await resolveProjectWithFallback(undefined, { allowGlobal: true }, deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe('global');
      expect(r.project).toBeNull();
    }
  });

  it('同名多命中 / 未找到 → 不兜底，原样返回解析错误', async () => {
    const notFound = await resolveProjectWithFallback('不存在的项目', {}, makeDeps());
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(JSON.parse(notFound.payload).error).toBe('project_not_found');

    const ambiguous = await resolveProjectWithFallback(
      '同名项目',
      {},
      makeDeps([
        { id: 'a-1', name: '同名项目', path: '/tmp/a' },
        { id: 'b-1', name: '同名项目', path: '/tmp/b' },
      ]),
    );
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(JSON.parse(ambiguous.payload).error).toBe('project_ambiguous');
  });
});
