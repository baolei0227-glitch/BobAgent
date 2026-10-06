'use client';

/**
 * Butler 回执（通知）的**动作层** —— 纯函数，不依赖 React、不依赖任何组件实例。
 *
 * ## 为什么独立成模块
 * 这些动作原先内联在 `ButlerDrawer` 的 useCallback 里（toggleItem / removeNotices /
 * downloadReportMd / copyReportLink）。移动端 `/butler` 的回执详情要的是**同一套落库链路**
 * —— 待办勾选必须与日历、便签双向联动，不能各写一份（否则两条链路迟早漂移）。
 * 2026-10-05 抽出，桌面与移动端共用。
 *
 * ## 待办勾选为什么要分三条路（原注释保留）
 * 默认只写回 items 快照（避免刷新后回到未勾选）；带 `source` 的项（日历提醒的事件 /
 * 便签待办行）接**真实链路**，与日历、StickyTodo 双向联动：
 *   - `'event'`：PATCH 日历事件状态 → 广播 `calendar-events-changed`（日历面板 / 便签画布重载）
 *     与 `butler-event-sync`（其余回执里同事件的条目一并联动）；事件源自便签行时，
 *     服务端 PATCH 会反向落回那一行。
 *   - `'sticky'`：POST `/api/sticky-notes` `action=toggle_line` 勾掉便签正文对应行，
 *     该行已入日历则由便签侧前向同步把事件置为完成。
 * 写盘失败时**不翻转本地**——宁可看起来没点上，也不要显示一个假的完成态。
 */
import { patchButlerNotice, removeButlerNotice, type ButlerNotice } from './butlerNotices';
import type { ButlerNoticeItem } from '@/lib/bus';
import { buildReportShareUrl, sanitizeReportFileName } from '@/lib/butler/report-share';

/** 待办项勾选 / 取消勾选（含事件与便签的真实联动链路） */
export function toggleNoticeItem(n: ButlerNotice, item: ButlerNoticeItem): void {
  const done = item.status !== 'done';
  const nextItems = (n.items ?? []).map((it) =>
    it.key === item.key ? { ...it, status: done ? 'done' : '' } : it,
  );
  const patchLocal = () => {
    void fetch('/api/butler/inbox', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [n.id], items: nextItems }),
    }).catch(() => undefined);
    patchButlerNotice(n.id, { items: nextItems });
  };

  // 事件类条目：source 显式声明，或**存量行兜底**——改造前落库的日程提醒 items_json 没写
  // source，但 kind='calendar' 的条目 key 恒为日历事件 id，等同 source='event'，
  // 否则老卡片点完成仍不联动。
  const eventKey = item.source === 'event' || n.kind === 'calendar' ? item.key : '';
  if (eventKey) {
    const eventId = eventKey;
    void fetch(`/api/calendar/events?event_id=${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: done ? 'done' : 'scheduled' }),
    })
      .then(() => {
        window.dispatchEvent(new Event('calendar-events-changed'));
        if (done) {
          window.dispatchEvent(
            new CustomEvent('butler-event-sync', { detail: { eventId, action: 'done' } }),
          );
        }
      })
      .catch(() => undefined);
    patchLocal();
    return;
  }

  if (item.source === 'sticky' && item.sticky) {
    const s = item.sticky;
    void fetch('/api/sticky-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'toggle_line',
        project_id: s.projectId,
        note_id: s.noteId,
        page_id: s.pageId,
        line_index: s.lineIndex,
        text: s.text,
        done,
      }),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { success?: boolean };
        if (!data.success) return;
        patchLocal();
        // 勾选可能改到了关联事件（该行已入日历）→ 广播重载日历 / 便签画布
        window.dispatchEvent(new Event('calendar-events-changed'));
      })
      .catch(() => undefined);
    return;
  }

  patchLocal();
}

/** 按 id 批量删除（一条请求带全部 id，服务端 DELETE 接数组） */
export function removeNoticesByIds(ids: string[]): void {
  if (ids.length === 0) return;
  void fetch('/api/butler/inbox', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).catch(() => undefined);
  for (const id of ids) removeButlerNotice(id);
}

/** 报告类回执：把正文下载为 .md（文件名规则与 /api/butler/report 的 Content-Disposition 同源） */
export function downloadNoticeMd(n: ButlerNotice): void {
  const blob = new Blob([n.body || ''], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeReportFileName(n.title)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * 报告类回执：复制 AI 可 web_fetch 的正文链接（粘贴到对话框即可让 Butler 读取分析）。
 * 返回 Promise，由调用方决定「已复制」的 UI 反馈（桌面用计时器改按钮文案，移动端可换 toast）。
 */
export async function copyNoticeReportLink(id: string): Promise<void> {
  const link = buildReportShareUrl(window.location.origin, id);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(link);
  }
}
