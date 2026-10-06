import { describe, expect, it } from 'vitest';
import { GET } from '@/app/api/projects/events/route';
import { emitProjectSwitched, emitSessionRequest, type SessionRequestPayload } from '@/lib/project/project-events';

/**
 * GET /api/projects/events 的推送契约回归（2026-10-05）。
 *
 * 为什么要连路由一起测：管家 switch_project / create_session 的落地成败，全押在
 * 「服务端广播的负载字段」与「Sidebar 解析的字段」对上。字段名写成 camelCase（projectId / prompt…）
 * 或事件名拼错，单元测试全绿、真机上却毫无反应——本用例把这条线钉成显式断言：
 *   event 名 project-switched / session-request，负载键 project_id / label / agent / prompt / auto。
 */
async function openBridge(): Promise<{ read: () => Promise<string>; close: () => Promise<void> }> {
  const res = await GET();
  const body = res.body;
  if (!body) throw new Error('SSE 响应无 body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  return {
    read: async () => {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('SSE 流已结束');
      return decoder.decode(chunk.value);
    },
    close: async () => {
      await reader.cancel();
    },
  };
}

describe('SSE /api/projects/events：管家界面动作的传输层', () => {
  it('转发 project-switched（负载键 project_id），与前端解析口径一致', async () => {
    const bridge = await openBridge();
    try {
      // 建立连接后先发一次 projects-changed（重连即刷新），这里消费掉
      expect(await bridge.read()).toContain('event: projects-changed');
      emitProjectSwitched('proj-a');
      const frame = await bridge.read();
      expect(frame).toContain('event: project-switched');
      expect(JSON.parse(frame.split('data: ')[1].trim()) as Record<string, unknown>).toEqual({ project_id: 'proj-a' });
    } finally {
      await bridge.close();
    }
  });

  it('转发 session-request（建会话契约原样送达，含 auto 标记）', async () => {
    const bridge = await openBridge();
    try {
      await bridge.read();
      const payload: SessionRequestPayload = {
        project_id: 'proj-a',
        label: '批量改名',
        agent: 'coding',
        prompt: '把这些文件重命名',
        auto: true,
      };
      emitSessionRequest(payload);
      const frame = await bridge.read();
      expect(frame).toContain('event: session-request');
      expect(JSON.parse(frame.split('data: ')[1].trim()) as SessionRequestPayload).toEqual(payload);
    } finally {
      await bridge.close();
    }
  });

  it('连接取消后停止订阅（不泄漏回调、不再入队）', async () => {
    const bridge = await openBridge();
    await bridge.read();
    await bridge.close();
    // 取消后广播不得抛异常（订阅者已摘除；若此处抛错说明订阅泄漏）
    expect(() => emitProjectSwitched('proj-after-close')).not.toThrow();
  });
});
