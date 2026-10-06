'use client';

/**
 * ButlerNoticePanel —— 移动端「回执（收件箱）」面板：**列表 + 详情**两级。
 *
 * ## 为什么自建而不是复用桌面那份
 * 桌面的回执详情内联在 `ButlerDrawer.tsx` 右栏的 `detail` 分支里（约 250 行），它读的是抽屉
 * 中栏时间线的 `selectedNotice`，**不是受控组件**，无法被另一个页面挂载。而它依赖的
 * 落库链路（勾选联动日历/便签、删除、下载 .md、复制分享链接）已抽到 `./noticeActions`，
 * 格式口径已抽到 `./noticeFormat` —— 因此这里只重建**视图层**，行为与桌面完全同源。
 *
 * ## 与桌面的已知差异（有意保留）
 * 1. 桌面中栏另有「时间线 + 已读过滤 + 分组」；移动端主视图是**会话**而不是收件箱，
 *    故本面板只做扁平列表（按时间倒序），不做分组/过滤 —— 手机上多一层过滤是净负担。
 * 2. 「Ask Butler about this」在桌面是**预填抽屉输入框**；移动端由页面接管（切回对话视图 +
 *    预填草稿），故经 `onAsk` 回调外抛，不在此处持有输入框状态。
 * 3. 日程回执里的「Calendar」按钮在桌面是切抽屉右栏分区；移动端经 `onOpenCalendar` 外抛。
 *
 * 样式走 `bwn-` 前缀（`bwm-` 归 `/butler` 页面、`bws-` 归 SectionStack）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  Download,
  Flag,
  Inbox,
  Link2,
  MapPin,
  Repeat,
  Trash2,
} from 'lucide-react';
import { StreamingMarkdown } from '@/components/canvas/HtmlRenderer';
import { recurrenceLabel } from '@/lib/calendar/recurrence';
import { isShareableReportKind } from '@/lib/butler/report-share';
import { kindMeta, loadInboxHistory } from '../ButlerNoticeHost';
import { getButlerNotices, patchButlerNotice, subscribeButlerNotices, type ButlerNotice } from '../butlerNotices';
import { copyNoticeReportLink, downloadNoticeMd, removeNoticesByIds, toggleNoticeItem } from '../noticeActions';
import { fmtEventWhen, fmtReminderMinutes, formatTime, type ScheduleDetail } from '../noticeFormat';
import { openButlerDoc } from '../butlerEvents';

export interface ButlerNoticePanelProps {
  /** 「Ask Butler about this」：页面负责切回对话视图并把预填文案放进草稿 */
  onAsk: (n: ButlerNotice) => void;
  /** 日程回执的「Calendar」：页面负责切到日历分区 */
  onOpenCalendar: () => void;
  /** 外部定位：桌面通知 / 收件箱入口带着 id 进来时，直接落到该条详情（缺省 = 停在列表） */
  focusId?: string | null;
}

/** 正文里的文档链接接管：与桌面同源（开 Butler 文档面板），见 ButlerDrawer 的 openDocInDrawer */
const openDoc = (path: string): boolean => {
  openButlerDoc(path);
  return true;
};

export function ButlerNoticePanel({ onAsk, onOpenCalendar, focusId }: ButlerNoticePanelProps) {
  const [notices, setNotices] = useState<ButlerNotice[]>(() => getButlerNotices());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scheduleDetail, setScheduleDetail] = useState<ScheduleDetail | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 订阅模块级 store + 拉一次历史：/butler 没有 ButlerNoticeHost，这条链路必须自己起
  useEffect(() => {
    setNotices(getButlerNotices());
    const unsub = subscribeButlerNotices(setNotices);
    void loadInboxHistory();
    return unsub;
  }, []);

  const sorted = useMemo(() => [...notices].sort((a, b) => b.time - a.time), [notices]);
  const selected = useMemo(() => notices.find((n) => n.id === selectedId) ?? null, [notices, selectedId]);

  /** 选中条目对应的事件 id（单条且为事件类才取整卡详情，与桌面判据一致） */
  const scheduleEventId = useMemo(() => {
    if (!selected) return null;
    const items = selected.items ?? [];
    if (items.length !== 1) return null;
    const it = items[0];
    return it.source === 'event' || selected.kind === 'calendar' ? it.key : null;
  }, [selected]);

  // 日程完整信息（点开时按事件 id 现取；取不到则退化为待办 chip）
  useEffect(() => {
    if (!scheduleEventId) {
      setScheduleDetail(null);
      return;
    }
    let alive = true;
    setScheduleDetail(null);
    fetch(`/api/calendar/events?event_id=${encodeURIComponent(scheduleEventId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive && d?.success && d.event) setScheduleDetail(d.event as ScheduleDetail);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [scheduleEventId]);

  /** 点开即已读：本地先落再回传服务端（与桌面 markNoticeRead 同款端点；失败不改本地显示） */
  const openNotice = useCallback((n: ButlerNotice) => {
    setSelectedId(n.id);
    if (n.read) return;
    patchButlerNotice(n.id, { read: true });
    void fetch('/api/butler/inbox', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [n.id], read: true }),
    }).catch(() => undefined);
  }, []);

  const scheduleItem = scheduleDetail ? (selected?.items?.[0] ?? null) : null;
  const scheduleDone = scheduleItem?.status === 'done';

  /**
   * 外部定位（桌面通知点击 / `BUTLER_FOCUS_NOTICE_EVENT`）：带 id 进来即落到该条详情。
   * 读 `getButlerNotices()` 而不是订阅态：定位发生在「刚打开面板」这一刻，
   * 订阅的 state 可能还没跟上（面板与宿主同一帧挂载）。
   */
  useEffect(() => {
    if (!focusId) return;
    const hit = getButlerNotices().find((n) => n.id === focusId);
    if (hit) openNotice(hit);
  }, [focusId, openNotice]);

  const copyLink = useCallback((id: string) => {
    void copyNoticeReportLink(id)
      .then(() => {
        setCopiedId(id);
        window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1600);
      })
      .catch(() => undefined);
  }, []);

  /** 删除后回列表（详情里删掉自己时留在空详情页没有意义） */
  const removeSelected = useCallback(
    (n: ButlerNotice) => {
      removeNoticesByIds([n.id]);
      setSelectedId(null);
    },
    [],
  );

  return (
    <div className="bwn-root">
      <style>{`
        .bwn-root { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
        .bwn-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }

        .bwn-row {
          width: 100%; display: flex; align-items: flex-start; gap: 10px; text-align: left;
          padding: 11px 14px; border: 0; background: transparent; font: inherit; color: inherit;
          border-bottom: 1px solid var(--line-soft, rgba(0,0,0,.06));
          -webkit-tap-highlight-color: transparent;
        }
        .bwn-row:active { background: var(--muted, #efeff2); }
        .bwn-rowicon { flex: 0 0 auto; width: 30px; height: 30px; border-radius: 9px;
          display: flex; align-items: center; justify-content: center; }
        .bwn-rowmain { flex: 1 1 auto; min-width: 0; }
        .bwn-rowtop { display: flex; align-items: center; gap: 7px; }
        .bwn-rowtitle { flex: 1 1 auto; min-width: 0; font-size: 14.5px; font-weight: 600;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bwn-rowtime { flex: 0 0 auto; font-size: 11.5px; color: var(--ink-faint, #71717a); font-variant-numeric: tabular-nums; }
        .bwn-rowbody { margin-top: 3px; font-size: 13px; line-height: 1.45; color: var(--text-muted, #52525b);
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .bwn-rowmeta { margin-top: 4px; display: flex; align-items: center; gap: 6px; }
        .bwn-kind { font-size: 10px; font-weight: 700; letter-spacing: .3px; }
        .bwn-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--danger, #e8463a); }

        .bwn-detail { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
        .bwn-detailbody { flex: 1 1 auto; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 14px; }
        .bwn-title { font-size: 16px; font-weight: 650; line-height: 1.35; color: var(--ink-strong, #0f0f11); }
        .bwn-card { margin-top: 12px; border-radius: 12px; padding: 11px; background: var(--paper-hover, #f2f2f4); }
        .bwn-line { display: flex; align-items: flex-start; gap: 6px; font-size: 12.5px; line-height: 1.5;
          color: var(--text, #171717); margin-top: 6px; }
        .bwn-line:first-child { margin-top: 0; }
        .bwn-todo { width: 100%; display: flex; align-items: center; gap: 8px; text-align: left;
          padding: 7px 8px; border: 0; border-radius: 8px; background: transparent; font: inherit; color: inherit;
          -webkit-tap-highlight-color: transparent; }
        .bwn-todo:active { background: var(--muted, #efeff2); }
        .bwn-todotitle { flex: 1 1 auto; min-width: 0; font-size: 13.5px; }
        .bwn-todotime { flex: 0 0 auto; font-size: 11.5px; color: var(--ink-faint, #71717a); font-variant-numeric: tabular-nums; }
        .bwn-label { font-size: 10.5px; font-weight: 700; letter-spacing: .4px; color: var(--ink-muted, #6b6b73);
          margin-bottom: 4px; }
        .bwn-archive { margin-top: 12px; border-radius: 12px; padding: 9px 11px; background: var(--paper-hover, #f2f2f4); }
        .bwn-archiveline { font-size: 12px; line-height: 1.5; color: var(--text-muted, #52525b); margin-top: 4px; }

        .bwn-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
          padding: 9px 14px calc(env(safe-area-inset-bottom, 0px) + 9px);
          border-top: 1px solid var(--line-soft, rgba(0,0,0,.07));
          background: color-mix(in oklab, var(--panel-bg, #fff) 88%, transparent);
          -webkit-backdrop-filter: saturate(180%) blur(16px); backdrop-filter: saturate(180%) blur(16px); }
        .bwn-chip { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 11px;
          border: 1px solid var(--border, rgba(0,0,0,.12)); border-radius: 999px; background: transparent;
          font: inherit; font-size: 12.5px; color: var(--ink-muted, #6b6b73);
          -webkit-tap-highlight-color: transparent; }
        .bwn-chip:active { background: var(--muted, #efeff2); }
        .bwn-chip.ok { color: var(--success, #1dc981); border-color: color-mix(in oklab, var(--success, #1dc981) 45%, transparent); }
        .bwn-chip.icon { width: 30px; padding: 0; justify-content: center; }
        .bwn-spacer { flex: 1 1 auto; }
        .bwn-ask { flex: 0 0 auto; width: 100%; height: 40px; border: 0; border-radius: 12px; color: #fff;
          font: inherit; font-size: 14px; font-weight: 600;
          background: linear-gradient(135deg, #6f6fff 0%, var(--primary, #4b3fe3) 100%);
          -webkit-tap-highlight-color: transparent; }
        .bwn-ask:active { transform: scale(.985); }
        .bwn-empty { display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 6px; padding: 64px 32px; text-align: center; color: var(--ink-faint, #71717a); }
        .bwn-emptyicon { width: 52px; height: 52px; border-radius: 16px; display: flex; align-items: center;
          justify-content: center; background: var(--paper-hover, #f2f2f4); color: var(--ink-muted, #6b6b73); }
        .bwn-backbar { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 8px 8px 0; }
        .bwn-back { width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center;
          border: 0; border-radius: 10px; background: transparent; color: var(--text, #171717);
          -webkit-tap-highlight-color: transparent; }
        .bwn-back:active { background: var(--muted, #efeff2); }
      `}</style>

      {!selected ? (
        <div className="bwn-scroll">
          {sorted.length === 0 ? (
            <div className="bwn-empty">
              <div className="bwn-emptyicon">
                <Inbox size={24} />
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text, #171717)' }}>No notifications</div>
              <div style={{ fontSize: 12.5, maxWidth: 240, lineHeight: 1.5 }}>
                Butler pushes reports, schedule reminders and notes here.
              </div>
            </div>
          ) : (
            sorted.map((n) => {
              const meta = kindMeta(n.kind);
              const preview = (n.body || '').replace(/\s+/g, ' ').trim();
              return (
                <button key={n.id} className="bwn-row" onClick={() => openNotice(n)}>
                  <span
                    className="bwn-rowicon"
                    style={{ backgroundColor: `color-mix(in oklab, ${meta.color} 14%, transparent)` }}
                  >
                    <meta.Icon size={15} style={{ color: meta.color }} />
                  </span>
                  <span className="bwn-rowmain">
                    <span className="bwn-rowtop">
                      <span className="bwn-rowtitle" style={{ color: n.read ? 'var(--ink-muted, #6b6b73)' : 'var(--ink-strong, #0f0f11)' }}>
                        {n.title}
                      </span>
                      <span className="bwn-rowtime">{formatTime(n.time)}</span>
                    </span>
                    {preview ? <span className="bwn-rowbody">{preview}</span> : null}
                    <span className="bwn-rowmeta">
                      <span className="bwn-kind" style={{ color: meta.color }}>
                        {meta.label}
                      </span>
                      {(n.items?.length ?? 0) > 0 ? (
                        <span style={{ fontSize: 10.5, color: 'var(--ink-faint, #71717a)' }}>
                          {n.items?.length} to-dos
                        </span>
                      ) : null}
                      {!n.read ? <span className="bwn-dot" /> : null}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : (
        <div className="bwn-detail">
          <div className="bwn-backbar">
            <button className="bwn-back" onClick={() => setSelectedId(null)} aria-label="Back to list">
              <ChevronLeft size={20} />
            </button>
            {(() => {
              const meta = kindMeta(selected.kind);
              return (
                <span className="bwn-kind" style={{ color: meta.color, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <meta.Icon size={13} />
                  {meta.label}
                </span>
              );
            })()}
            <span className="bwn-spacer" />
            <span className="bwn-rowtime">{formatTime(selected.time)}</span>
          </div>

          <div className="bwn-detailbody">
            <div className="bwn-title">{selected.title}</div>

            {/* 正文：只在没有待办项时才出现（有待办项时清单本身就是正文，与桌面口径一致） */}
            {(selected.items?.length ?? 0) === 0 && selected.body ? (
              <div className="butler-md" style={{ marginTop: 8, fontSize: 13, color: 'var(--text, #171717)' }}>
                <StreamingMarkdown content={selected.body} streaming={false} onOpenDoc={openDoc} />
              </div>
            ) : null}

            {/* 日程：完整事件信息（点开时现取），勾选沿用真实联动链路 */}
            {scheduleDetail && scheduleItem ? (
              <div className="bwn-card">
                <button
                  className="bwn-todo"
                  style={{ padding: 0 }}
                  onClick={() => toggleNoticeItem(selected, scheduleItem)}
                >
                  <CheckCircle2
                    size={16}
                    style={{ color: scheduleDone ? 'var(--success, #1dc981)' : 'var(--ink-faint, #71717a)', flex: '0 0 auto' }}
                  />
                  <span
                    className="bwn-todotitle"
                    style={{
                      fontWeight: 600,
                      color: scheduleDone ? 'var(--ink-faint, #71717a)' : 'var(--ink-strong, #0f0f11)',
                      textDecoration: scheduleDone ? 'line-through' : undefined,
                    }}
                  >
                    {scheduleDetail.title}
                  </span>
                </button>

                {scheduleDetail.start_time ? (
                  <div className="bwn-line" style={{ marginTop: 8 }}>
                    <CalendarDays size={13} style={{ color: 'var(--ink-muted, #6b6b73)', marginTop: 2, flex: '0 0 auto' }} />
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {fmtEventWhen(scheduleDetail.start_time, scheduleDetail.end_time, scheduleDetail.all_day)}
                    </span>
                  </div>
                ) : null}

                {scheduleDetail.priority === 'high' ? (
                  <div className="bwn-line" style={{ color: 'var(--warn, #d97706)' }}>
                    <Flag size={13} style={{ marginTop: 2, flex: '0 0 auto' }} />
                    <span>High priority</span>
                  </div>
                ) : null}

                {scheduleDetail.location ? (
                  <div className="bwn-line">
                    <MapPin size={13} style={{ color: 'var(--ink-muted, #6b6b73)', marginTop: 2, flex: '0 0 auto' }} />
                    <span style={{ wordBreak: 'break-word' }}>{scheduleDetail.location}</span>
                  </div>
                ) : null}

                {recurrenceLabel(scheduleDetail.recurrence) ? (
                  <div className="bwn-line" style={{ color: 'var(--ink-muted, #6b6b73)' }}>
                    <Repeat size={13} style={{ marginTop: 2, flex: '0 0 auto' }} />
                    <span>Repeats {recurrenceLabel(scheduleDetail.recurrence)}</span>
                  </div>
                ) : null}

                {!scheduleDetail.reminder_disabled && scheduleDetail.reminder_minutes.length > 0 ? (
                  <div className="bwn-line" style={{ color: 'var(--ink-muted, #6b6b73)' }}>
                    <Bell size={13} style={{ marginTop: 2, flex: '0 0 auto' }} />
                    <span>
                      {scheduleDetail.reminder_minutes.map((m) => `${fmtReminderMinutes(m)} before`).join(' · ')}
                    </span>
                  </div>
                ) : null}

                {scheduleDetail.description ? (
                  <div className="bwn-line" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {scheduleDetail.description}
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* 结构化待办项 */}
            {!scheduleDetail && (selected.items?.length ?? 0) > 0 ? (
              <div style={{ marginTop: 12 }}>
                <div className="bwn-label">To-dos · {selected.items?.length}</div>
                {(selected.items ?? []).map((it) => {
                  const done = it.status === 'done';
                  return (
                    <button key={it.key} className="bwn-todo" onClick={() => toggleNoticeItem(selected, it)}>
                      <CheckCircle2
                        size={15}
                        style={{ color: done ? 'var(--success, #1dc981)' : 'var(--ink-faint, #71717a)', flex: '0 0 auto' }}
                      />
                      <span
                        className="bwn-todotitle"
                        style={{
                          color: done ? 'var(--ink-faint, #71717a)' : 'var(--text, #171717)',
                          textDecoration: done ? 'line-through' : undefined,
                        }}
                      >
                        {it.title}
                      </span>
                      {it.startMs > 0 || it.time ? (
                        <span className="bwn-todotime">{it.startMs > 0 ? formatTime(it.startMs) : it.time}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {/* 对话存档（kind='web' / 'info'） */}
            {(selected.messages?.length ?? 0) > 0 ? (
              <div className="bwn-archive">
                <div className="bwn-label" style={{ marginBottom: 0 }}>
                  Chat archive · {selected.messages?.length}
                </div>
                {(selected.messages ?? []).map((m, i) => (
                  <div key={i} className="bwn-archiveline">
                    <span style={{ fontWeight: 600, color: 'var(--text, #171717)' }}>
                      {m.role === 'user' ? 'You' : 'Butler'}:
                    </span>{' '}
                    {m.content}
                  </div>
                ))}
              </div>
            ) : null}

            {selected.source === 'wechat' ? (
              <div style={{ marginTop: 12, fontSize: 11, color: 'var(--ink-faint, #71717a)' }}>via WeChat</div>
            ) : null}
          </div>

          <div className="bwn-actions">
            {selected.actionType === 'open-calendar' ? (
              <button className="bwn-chip" onClick={onOpenCalendar}>
                <CalendarDays size={13} />
                Calendar
              </button>
            ) : null}
            {isShareableReportKind(selected.kind) ? (
              <>
                <button className="bwn-chip" onClick={() => downloadNoticeMd(selected)} title="Download .md">
                  <Download size={13} />
                  .md
                </button>
                <button
                  className={`bwn-chip${copiedId === selected.id ? ' ok' : ''}`}
                  onClick={() => copyLink(selected.id)}
                  title="Copy report link"
                >
                  {copiedId === selected.id ? <Check size={13} /> : <Link2 size={13} />}
                  {copiedId === selected.id ? 'Copied' : 'Link'}
                </button>
              </>
            ) : null}
            <span className="bwn-spacer" />
            <button
              className="bwn-chip icon"
              onClick={() => removeSelected(selected)}
              aria-label="Delete"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </div>

          <div style={{ flex: '0 0 auto', padding: '0 14px calc(env(safe-area-inset-bottom, 0px) + 12px)' }}>
            <button className="bwn-ask" onClick={() => onAsk(selected)}>
              Ask Butler about this
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
