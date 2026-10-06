import { describe, expect, it } from 'vitest';
import {
  emitProjectSwitched,
  emitSessionRequest,
  hasProjectsChangedListeners,
  onProjectSwitched,
  onProjectsChanged,
  onSessionRequest,
  type SessionRequestPayload,
} from '@/lib/project/project-events';

/**
 * 服务端 → 前端的「界面动作」通道回归（2026-10-05）。
 *
 * 背景：管家新增 switch_project / create_session 两个工具，但它们要改的是**画布状态**
 * （当前项目、会话节点），只能由前端落地。服务端经这两条通道广播，前端（Sidebar）
 * 转成画布既有的窗口事件。本用例锁住三条契约：
 *   ① 广播能把负载原样送到订阅者；
 *   ② 订阅者可取消（SSE 连接断开时不能泄漏回调）；
 *   ③ 单个订阅者抛异常不影响其他订阅者（SSE 一条坏连接不该拖垮广播）。
 */
describe('project-events：管家发起的界面动作通道', () => {
  it('project-switched：订阅者能收到被切换的项目 id，取消后不再收到', () => {
    const seen: string[] = [];
    const off = onProjectSwitched((id) => seen.push(id));
    emitProjectSwitched('proj-a');
    off();
    emitProjectSwitched('proj-b');
    expect(seen).toEqual(['proj-a']);
  });

  it('session-request：建会话契约（项目/标题/agent/任务/自动执行）原样送达', () => {
    const seen: SessionRequestPayload[] = [];
    const off = onSessionRequest((p) => seen.push(p));
    const payload: SessionRequestPayload = {
      project_id: 'proj-a',
      label: '批量改名',
      agent: 'coding',
      prompt: '把这些文件重命名',
      auto: true,
    };
    emitSessionRequest(payload);
    off();
    emitSessionRequest({ ...payload, project_id: 'proj-b' });
    expect(seen).toEqual([payload]);
  });

  it('单个订阅者抛异常不影响其他订阅者，且不影响后续广播', () => {
    const seen: string[] = [];
    const offBad = onProjectSwitched(() => {
      throw new Error('坏连接');
    });
    const offGood = onProjectSwitched((id) => seen.push(id));
    expect(() => emitProjectSwitched('proj-a')).not.toThrow();
    emitProjectSwitched('proj-b');
    offBad();
    offGood();
    expect(seen).toEqual(['proj-a', 'proj-b']);
  });

  it('hasProjectsChangedListeners 是「界面是否在线」的判据（无订阅者 = 画布没开）', () => {
    // 管家 create_session 用它决定是否拒绝（ui_not_open）：无订阅者时不得改任何状态。
    // SSE 连接（Sidebar）建立即订阅 projects-changed，故该判据等价于「有界面在听」。
    expect(hasProjectsChangedListeners()).toBe(false);
    const off = onProjectsChanged(() => {
      /* noop */
    });
    expect(hasProjectsChangedListeners()).toBe(true);
    off();
    expect(hasProjectsChangedListeners()).toBe(false);
  });
});
