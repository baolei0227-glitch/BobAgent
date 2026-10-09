import { describe, expect, it } from 'vitest';
import { canvasLagsServerProject } from '@/lib/current-project';

/**
 * 「画布 vs 服务端当前项目」对账判定的回归（2026-10-09）。
 *
 * 背景：2026-10-09 用户报障 —— 管家 `create_project(make_current=true)` 建完项目
 * （昆明鲸红王钧案_20261009）后，侧边栏已高亮新项目，画布与会话列表却仍是上一个项目的；
 * 此时再点那条已高亮的项目又「点不动」（项目已是 current，切换被短路）。
 *
 * 真源在服务端 `.projects.json`，前端自己点的切换会主动广播 `bobagent:project-switched`，
 * 而服务端单方面改写当前项目的路径只广播 `projects-changed`（刷新列表）—— 于是分叉。
 * 本判定是 Sidebar 拿到服务端快照后的对账口径：落后才补发一次无刷新切换。
 * 三条边界都要守住：一致不能重载（点了白闪）、画布未报到不能当落后（启动瞬间）、
 * 服务端无当前项目不能瞎跟随。
 */
describe('canvasLagsServerProject：画布是否落后于服务端当前项目', () => {
  it('两边都有值且不同 → 落后（需要补发一次无刷新切换）', () => {
    expect(canvasLagsServerProject('proj-old', 'proj-new')).toBe(true);
  });

  it('一致 → 不落后（点当前项目不该白重载一遍画布）', () => {
    expect(canvasLagsServerProject('proj-a', 'proj-a')).toBe(false);
  });

  it('画布还没报到（空串）→ 不作为落后依据（启动时画布本来就会读当前项目）', () => {
    expect(canvasLagsServerProject('', 'proj-a')).toBe(false);
  });

  it('服务端没有当前项目（空串）→ 无从跟随，不广播', () => {
    expect(canvasLagsServerProject('proj-a', '')).toBe(false);
    expect(canvasLagsServerProject('', '')).toBe(false);
  });
});
