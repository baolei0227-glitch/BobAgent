'use client';

/**
 * WANTED 通知中心（通缉令右上角猎人图标）—— 邮件式「概览 → 详情」左右并排布局
 *
 * 消费 bus 的 wanted.notice 事件：
 *   - 任务完成（⌘F 面板执行 /todo、/note 等成功后）
 *   - 每日报告（Morning）
 *
 * 布局（一个弹窗内左右两栏，仿邮件客户端）：
 *   - 左栏 收件箱：每条 = 未读圆点 + 主题单行 + 2 行摘要 + 时间；未读加粗 + 左侧品牌色条
 *   - 右栏 详情：点击列表项即时切换，展示完整正文 + 类型 + 时间，底部 Prev / 动作 / Next 连续阅读
 *   - 已读时机：打开弹窗不标已读，仅点开某条时才清除该条未读标记；头部提供 Mark all read
 *   - 桌面系统通知：发布者未自行发送时（desktop !== false）自动补发
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, CalendarDays, Bell, CheckCircle2, ChevronLeft, ChevronRight,
  LayoutGrid, Eye, EyeOff, Circle, Mail, Search, Trash,
  Clock, Star, MoreHorizontal, Archive,
  Download, Link2, Check,
} from 'lucide-react';
import { bus, BusEvents, stripThinkTags, type WantedNoticePayload, type WantedNoticeItem, type ChatMessage, type WantedExecutingPayload } from '@/lib/bus';
import { desktop } from '@/lib/desktop-adapter';
import { useConfirm } from './ConfirmDialog';
import { HtmlRenderer } from './HtmlRenderer';

interface Notice extends WantedNoticePayload {
  id: string;
  time: number;
  read: boolean;
  /** 已完成（归入「已完成」分区）；wanted 角标统计未完成条数 */
  done: boolean;
}

let noticeSeq = 0;

/** 弹窗宽度：窄态仅收件箱（默认） / 全宽双栏（点击左侧条目后展开右栏详情） */
const WIDTH_LIST = 360;
const WIDTH_FULL = 1040;

function formatTime(iso: number): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 信封头用的完整时间格式：YYYY-MM-DD Weekday HH:MM GMT+Z */
function formatFullTime(iso: number): string {
  const d = new Date(iso);
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = (n: number) => String(n).padStart(2, '0');
  // 本机时区偏移：分钟数 → GMT±H:MM
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absH = Math.floor(Math.abs(offsetMin) / 60);
  const absM = Math.abs(offsetMin) % 60;
  const tz = `GMT${sign}${absH}${absM > 0 ? ':' + pad(absM) : ''}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${weekdays[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())} ${tz}`;
}

/** 发件人信息：按 kind 映射头像/姓名/邮箱地址 */
type SenderInfo = {
  name: string;
  email: string;
  /** 头像是纯文本 emoji（省一次网络请求 + 风格统一） */
  avatarEmoji: string;
  /** 头像图片路径（存在时优先于 emoji 渲染） */
  avatarSrc?: string;
  /** 头像背景色 className-like：走 CSS 变量填充 */
  avatarBg: string;
  avatarFg: string;
  avatarBorder: string;
  /** 收件人显示（全部是 To: 我） */
  to: string;
};
function senderOf(n: Notice): SenderInfo {
  switch (n.kind) {
    case 'calendar':
      return {
        name: '日历提醒',
        email: 'calendar@bobwork.dev',
        avatarEmoji: '📅',
        avatarBg: 'var(--info-soft)',
        avatarFg: 'var(--info)',
        avatarBorder: 'var(--info)',
        to: 'me',
      };
    case 'daily-report':
      return {
        name: '每日报告',
        email: 'morning@bobwork.dev',
        avatarEmoji: '🌞',
        avatarBg: 'var(--warn-soft)',
        avatarFg: 'var(--warn)',
        avatarBorder: 'var(--warn)',
        to: 'me',
      };
    case 'task':
      return {
        name: 'WANTED · 任务',
        email: 'tasks@bobwork.dev',
        avatarEmoji: '🎯',
        avatarBg: 'var(--success-soft)',
        avatarFg: 'var(--success)',
        avatarBorder: 'var(--success)',
        to: 'me',
      };
    case 'note':
      return {
        name: 'WANTED · 想法',
        email: 'notes@bobwork.dev',
        avatarEmoji: '📝',
        avatarBg: 'var(--success-soft)',
        avatarFg: 'var(--success)',
        avatarBorder: 'var(--success)',
        to: 'me',
      };
    case 'inspect':
      return {
        name: 'Sticky · 检查',
        email: 'inspect@bobwork.dev',
        avatarEmoji: '🗂️',
        avatarBg: 'var(--teal-soft)',
        avatarFg: 'var(--teal)',
        avatarBorder: 'var(--teal)',
        to: 'me',
      };
    case 'web':
      return {
        name: 'WANTED · 网页整理',
        email: 'web@bobwork.dev',
        avatarEmoji: '🌐',
        avatarBg: 'var(--purple-soft)',
        avatarFg: 'var(--purple)',
        avatarBorder: 'var(--purple)',
        to: 'me',
      };
    case 'info':
    default:
      return {
        name: 'WANTED · 通知',
        email: 'wanted@bobwork.dev',
        avatarEmoji: '📬',
        avatarBg: 'var(--success-soft)',
        avatarFg: 'var(--success)',
        avatarBorder: 'var(--success)',
        to: 'me',
      };
  }
}

/** 正文富文本 mini processor：处理
 *  - > 引用块（左竖线）
 *  - -- 签名分隔（下面淡色）
 *  - URL 自动转 <a>
 *  - \n\n 段落换行
 *  - \n 行内换行
 *  返回：ReactNode 数组（inline 元素），消费方只需渲染
 */
const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
function richText(text: string, opts: { keyBase?: string } = {}): React.ReactNode[] {
  const base = opts.keyBase ?? 'rich';
  // 签名分隔：把 "--\n" 之后的全段作为 signature
  const sigIdx = text.search(/(^|\n)--\s*\n/);
  const mainText = sigIdx >= 0 ? text.slice(0, sigIdx + 1) : text;
  const sigPart = sigIdx >= 0 ? text.slice(sigIdx).replace(/^\n?--\s*\n/, '') : '';
  const nodes: React.ReactNode[] = [];
  // 分块按行块（空行分段）处理；每段按引用前缀/普通分类
  const paragraphs = mainText.split(/\n\s*\n/);
  paragraphs.forEach((para, pIdx) => {
    const lines = para.split('\n');
    // 一段如果全是引用 → 渲染成引用块
    const allQuote = lines.length > 0 && lines.every((l) => /^>\s?/.test(l));
    if (allQuote) {
      const stripped = lines.map((l) => l.replace(/^>\s?/, '')).join('\n');
      nodes.push(
        <blockquote
          key={`${base}-p${pIdx}`}
          style={{
            margin: '6px 0',
            padding: '4px 10px',
            borderLeft: `3px solid var(--primary-soft)`,
            background: 'var(--paper-soft)',
            color: 'var(--ink-muted)',
            fontSize: '0.833333rem',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: SANS_FONT,
          }}
        >
          {inlineWithUrls(stripped, `${base}-p${pIdx}-in`)}
        </blockquote>
      );
      return;
    }
    // 混合段落：逐行判断是否引用
    const rowNodes: React.ReactNode[] = [];
    lines.forEach((line, lIdx) => {
      const k = `${base}-p${pIdx}-l${lIdx}`;
      if (/^>\s?/.test(line)) {
        const stripped = line.replace(/^>\s?/, '');
        rowNodes.push(
          <div
            key={k}
            style={{
              padding: '2px 8px',
              borderLeft: `3px solid var(--primary-soft)`,
              background: 'var(--paper-soft)',
              color: 'var(--ink-muted)',
              fontSize: '0.833333rem',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {inlineWithUrls(stripped, `${k}-in`)}
          </div>
        );
      } else {
        rowNodes.push(
          <div key={k} style={{
            fontSize: '0.866667rem',
            lineHeight: 1.7,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'var(--ink)',
            fontFamily: SANS_FONT,
          }}>
            {inlineWithUrls(line, `${k}-in`)}
          </div>
        );
      }
    });
    nodes.push(
      <div key={`${base}-p${pIdx}`} style={{ margin: '6px 0', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {rowNodes}
      </div>
    );
  });
  if (sigPart) {
    nodes.push(
      <div
        key={`${base}-sig`}
        style={{
          marginTop: 10,
          paddingTop: 6,
          borderTop: '1px dashed var(--line-soft)',
          color: 'var(--ink-muted)',
          fontSize: '0.8rem',
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: SANS_FONT,
        }}
      >
        {inlineWithUrls(sigPart, `${base}-sig-in`)}
      </div>
    );
  }
  return nodes;
}
function inlineWithUrls(text: string, kbase: string): React.ReactNode[] {
  const parts = text.split(URL_RE);
  return parts.map((seg, i) => {
    if (i % 2 === 1) {
      // URL
      return (
        <a
          key={`${kbase}-u${i}`}
          href={seg}
          target="_blank"
          rel="noreferrer noopener"
          style={{ color: 'var(--primary)', textDecoration: 'none' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
        >
          {seg}
        </a>
      );
    }
    return <span key={`${kbase}-t${i}`}>{seg}</span>;
  });
}

/** 待办项时间：全天事件只显示日期 */
function formatItemTime(it: WantedNoticeItem): string {
  if (it.allDay) {
    const d = new Date(it.startMs);
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} All-day`;
  }
  return formatTime(it.startMs);
}

/** 详情正文/表格使用的无衬线字体（标题保留衬线"通缉令纸张"质感） */
const SANS_FONT = 'var(--font-sans)';

/** /inspect 邮件章节结构（由 formatInspectReply 生成的纯文本分组解析而来） */
type InspectBlockNote = { title: string; pages: { title: string; items: string[] }[] };
type InspectBlock = { name: string; isCurrent: boolean; pending: number; notes: InspectBlockNote[] };

/**
 * 解析 /inspect 邮件正文 → 结构化项目分组
 * 对应 formatInspectReply 的缩进约定：■ 项目 → ◇ 便签 → · 页 → ☐ 待办
 */
function parseInspectBody(body: string): { title: string; empty: boolean; blocks: InspectBlock[] } {
  const empty = body.includes('暂无未完成待办');
  const lines = body.split('\n');
  const title = (lines[0] ?? '').replace(/^\s*📋\s*/, '').trim();
  const blocks: InspectBlock[] = [];
  let cur: InspectBlock | null = null;
  let curNote: InspectBlockNote | null = null;
  let curPage: { title: string; items: string[] } | null = null;
  for (const raw of lines.slice(1)) {
    if (/^\s*$/.test(raw)) continue;
    const mProj = /^■\s*(.+?)(（当前）)?\s*—\s*(\d+)\s*项/.exec(raw);
    if (mProj) {
      cur = { name: mProj[1].trim(), isCurrent: !!mProj[2], pending: Number(mProj[3]), notes: [] };
      curNote = null;
      curPage = null;
      blocks.push(cur);
      continue;
    }
    const mNote = /^\s{2,}◇\s*(.+)$/.exec(raw);
    if (mNote && cur) {
      curNote = { title: mNote[1], pages: [] };
      cur.notes.push(curNote);
      curPage = null;
      continue;
    }
    const mPage = /^\s{4,}·\s*(.+)$/.exec(raw);
    if (mPage && curNote) {
      curPage = { title: mPage[1], items: [] };
      curNote.pages.push(curPage);
      continue;
    }
    const mItem = /^\s{6,}☐\s*(.+)$/.exec(raw);
    if (mItem && curPage) curPage.items.push(mItem[1]);
  }
  return { title, empty, blocks };
}

/**
 * /inspect 详情：按「项目 → 便签 → 页 → 待办」渲染为项目卡片列表
 * （相比纯文本缩进，一眼看清各项目待办分布，当前项目高亮）
 */
function InspectDetail({ body }: { body: string }) {
  const parsed = useMemo(() => parseInspectBody(body), [body]);
  // 空态：无待办的项目检查，原样展示轻量文案
  if (parsed.empty) {
    return (
      <div style={{
        fontSize: '0.866667rem', color: 'var(--ink-muted)', lineHeight: 1.7,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: SANS_FONT,
      }}>
        {body}
      </div>
    );
  }
  // 解析兜底：非标准结构（旧数据）回退为轻量正文渲染
  if (parsed.blocks.length === 0) {
    return <div style={{ padding: '2px 0' }}>{richText(body, { keyBase: 'inspect-fb' })}</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: '0.733333rem', color: 'var(--ink-muted)', lineHeight: 1.6, fontFamily: SANS_FONT }}>
        {parsed.title}
      </div>
      {parsed.blocks.map((b, bi) => (
        <div
          key={`inspect-p${bi}`}
          style={{
            border: '1px solid var(--line-soft)',
            borderRadius: 8,
            overflow: 'hidden',
            background: 'var(--paper-soft)',
          }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 10px',
            background: 'var(--paper)',
            borderBottom: '1px solid var(--line-soft)',
          }}>
            <span style={{ fontWeight: 600, fontSize: '0.866667rem', color: 'var(--ink)', fontFamily: SANS_FONT }}>{b.name}</span>
            {b.isCurrent && (
              <span style={{
                fontSize: '0.666667rem',
                padding: '1px 6px',
                borderRadius: 8,
                background: 'var(--teal-soft)',
                color: 'var(--teal)',
                fontWeight: 600,
                fontFamily: SANS_FONT,
              }}>
                当前
              </span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: '0.733333rem', color: 'var(--ink-muted)', fontFamily: SANS_FONT }}>
              {b.pending} 项待办
            </span>
          </div>
          <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {b.notes.map((note, ni) => (
              <div key={`n${bi}-${ni}`}>
                {note.pages.length === 0 ? (
                  <div style={{ fontSize: '0.666667rem', color: 'var(--ink-muted)', fontFamily: SANS_FONT }}>◇ {note.title}</div>
                ) : (
                  <>
                    <div style={{ fontSize: '0.766667rem', fontWeight: 600, color: 'var(--ink)', marginBottom: 4, fontFamily: SANS_FONT }}>
                      ◇ {note.title}
                    </div>
                    {note.pages.map((pg, pi) => (
                      <div key={`p${bi}-${ni}-${pi}`} style={{ paddingLeft: 12, marginBottom: 6 }}>
                        <div style={{ fontSize: '0.733333rem', color: 'var(--ink-muted)', marginBottom: 2, fontFamily: SANS_FONT }}>
                          · {pg.title}
                        </div>
                        {pg.items.map((it, ii) => (
                          <div
                            key={`i${bi}-${ni}-${pi}-${ii}`}
                            style={{
                              display: 'flex', gap: 6, fontSize: '0.833333rem', lineHeight: 1.6,
                              color: 'var(--ink)', fontFamily: SANS_FONT,
                            }}
                          >
                            <span style={{ color: 'var(--warn)', flexShrink: 0 }}>☐</span>
                            <span style={{ wordBreak: 'break-word' }}>{it}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </>
                )}
              </div>
            ))}
            {b.notes.length === 0 && (
              <div style={{ fontSize: '0.733333rem', color: 'var(--ink-muted)', fontFamily: SANS_FONT }}>
                （该分部暂无便签明细）
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 搜索匹配：标题 / 正文 / 待办项标题任一命中（空串 = 全匹配） */
function matchesQuery(n: Notice, q: string): boolean {
  const query = q.trim().toLowerCase();
  if (!query) return true;
  if (n.title.toLowerCase().includes(query)) return true;
  if (n.body.toLowerCase().includes(query)) return true;
  return (n.items ?? []).some((it) => it.title.toLowerCase().includes(query));
}

/** 结构化待办表格（When / Title / Priority / Action，含行内完成/删除）——普通通知与日报分区共用 */
function ItemsTable({ items, onToggle, onDelete }: {
  items: WantedNoticeItem[];
  onToggle: (it: WantedNoticeItem) => void;
  onDelete: (it: WantedNoticeItem) => void;
}) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', fontFamily: SANS_FONT }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--line-soft)' }}>
          <th style={{ padding: '5px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--ink-muted)', whiteSpace: 'nowrap' }}>When</th>
          <th style={{ padding: '5px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--ink-muted)' }}>Title</th>
          <th style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600, color: 'var(--ink-muted)', whiteSpace: 'nowrap' }}>Priority</th>
          <th style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600, color: 'var(--ink-muted)', whiteSpace: 'nowrap' }}>Action</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it) => {
          const badge =
            it.status === 'done'
              ? { text: 'Done', color: 'var(--success)', bg: 'var(--success-soft)' }
              : it.status === 'cancelled'
                ? { text: 'Cancelled', color: 'var(--ink-muted)', bg: 'var(--paper-hover)' }
                : it.priority === 'high'
                  ? { text: 'High', color: 'var(--danger)', bg: 'var(--danger-soft)' }
                  : it.priority === 'low'
                    ? { text: 'Low', color: 'var(--ink-muted)', bg: 'var(--paper-hover)' }
                    : null;
          return (
            <tr key={it.key} style={{ borderBottom: '1px solid var(--line-soft)' }}>
              <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', color: 'var(--ink-muted)', verticalAlign: 'top' }}>
                {formatItemTime(it)}
              </td>
              <td style={{ padding: '6px 8px', color: 'var(--ink)', verticalAlign: 'top' }}>
                <span style={{ wordBreak: 'break-word' }}>{it.title}</span>
              </td>
              <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                {badge ? (
                  <span
                    style={{
                      display: 'inline-block',
                      fontSize: '0.6rem',
                      lineHeight: '13px',
                      padding: '0 5px',
                      borderRadius: 999,
                      backgroundColor: badge.bg,
                      color: badge.color,
                    }}
                  >
                    {badge.text}
                  </span>
                ) : (
                  <span style={{ fontSize: '0.666667rem', color: 'var(--ink-faint)' }}>Normal</span>
                )}
              </td>
              <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                  <button
                    onClick={() => onToggle(it)}
                    title={it.status === 'done' ? 'Restore to scheduled' : 'Mark event done'}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 2,
                      color: it.status === 'done' ? 'var(--success)' : 'var(--ink-faint)',
                      display: 'inline-flex',
                      opacity: 0.55,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.55'; }}
                  >
                    {it.status === 'done' ? <CheckCircle2 size={13} /> : <Circle size={13} />}
                  </button>
                  <button
                    onClick={() => onDelete(it)}
                    title="Delete event"
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 2,
                      color: 'var(--danger)',
                      display: 'inline-flex',
                      opacity: 0.4,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.4'; }}
                  >
                    <Trash size={12} />
                  </button>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** 笔记列表表格（/note check 邮件）：Date / Title+content / Category / Action（一键删除笔记）。
 * 删除仅移除该条笔记（DELETE /api/notebook），不影响整封邮件的 done 状态。 */
function NotesTable({ items, onDelete }: {
  items: WantedNoticeItem[];
  onDelete: (it: WantedNoticeItem) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {items.map((it) => (
        <div
          key={it.key}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '8px 2px',
            borderBottom: '1px solid var(--line-soft)',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.833333rem', fontWeight: 700, color: 'var(--ink-strong)', wordBreak: 'break-word' }}>
                {it.title}
              </span>
              <span style={{ fontSize: '0.666667rem', color: 'var(--ink-faint)', whiteSpace: 'nowrap' }}>{it.time || ''}</span>
            </div>
            {it.content ? (
              <div style={{
                fontSize: '0.733333rem',
                color: 'var(--ink-muted)',
                marginTop: 2,
                lineHeight: 1.5,
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
              }}>
                {it.content}
              </div>
            ) : null}
          </div>
          <button
            onClick={() => onDelete(it)}
            title="Delete this note — permanently remove from notebook"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 3,
              color: 'var(--danger)',
              display: 'inline-flex',
              opacity: 0.4,
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.4'; }}
          >
            <Trash size={12} />
          </button>
        </div>
      ))}
      {items.length === 0 && (
        <div style={{ fontSize: '0.733333rem', color: 'var(--ink-faint)', padding: '8px 2px' }}>
          All notes in this list have been deleted.
        </div>
      )}
    </div>
  );
}

/** 日报专属详情：顶部统计卡 + Today / Overdue 分区表格 + 快捷操作（一键完成今日） */
function DailyReportDetail({ items, onToggle, onDelete, onCompleteToday }: {
  items: WantedNoticeItem[];
  onToggle: (it: WantedNoticeItem) => void;
  onDelete: (it: WantedNoticeItem) => void;
  onCompleteToday: () => void;
}) {
  const today = items.filter((it) => it.section !== 'overdue');
  const overdue = items.filter((it) => it.section === 'overdue');
  const isPending = (it: WantedNoticeItem) => it.status !== 'done' && it.status !== 'cancelled';
  const todayPending = today.filter(isPending).length;
  const overduePending = overdue.filter(isPending).length;
  return (
    <>
      {/* 顶部统计卡 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
        {[
          { label: 'Today', value: today.length, sub: `${todayPending} pending` },
          { label: 'Overdue', value: overdue.length, sub: `${overduePending} pending` },
        ].map((s) => (
          <div
            key={s.label}
            style={{
              flex: 1,
              border: '1px solid var(--line)',
              borderRadius: 8,
              padding: '8px 10px',
              backgroundColor: 'var(--paper-soft)',
            }}
          >
            <div style={{ fontSize: '0.666667rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--ink-muted)' }}>{s.label}</div>
            <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1.25, color: 'var(--ink-strong)' }}>{s.value}</div>
            <div style={{ fontSize: '0.666667rem', color: 'var(--ink-faint)' }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* 分区表格：Today / Overdue（每行可完成/删除，改动即时同步日历） */}
      {today.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', fontWeight: 700, color: 'var(--ink)', margin: '10px 0 6px' }}>
            <CalendarDays size={12} /> Today · {today.length}
          </div>
          <ItemsTable items={today} onToggle={onToggle} onDelete={onDelete} />
        </>
      )}
      {overdue.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', fontWeight: 700, color: 'var(--ink)', margin: '10px 0 6px' }}>
            <Clock size={12} /> Overdue · {overdue.length}
          </div>
          <ItemsTable items={overdue} onToggle={onToggle} onDelete={onDelete} />
        </>
      )}

      {/* 快捷操作：一键完成今日全部未完成项 */}
      {todayPending > 0 && (
        <button
          onClick={onCompleteToday}
          title="Complete all today's pending events"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 12,
            padding: '7px 12px',
            background: 'var(--primary)',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: '0.8rem',
            fontWeight: 700,
            color: '#fff',
          }}
        >
          <CheckCircle2 size={13} /> Complete all today
        </button>
      )}
    </>
  );
}

/** 桌面通知点击后跳转：dispatch 自定义事件，通知中心收到后打开弹窗并定位到对应通知详情 */
function openNoticeFromDesktop(noticeId: string) {
  window.dispatchEvent(new CustomEvent('bobmail-open-notice', { detail: { noticeId } }));
}

function sendDesktopNotification(title: string, body: string, opts?: { noticeId?: string }) {
  try {
    desktop.update.notify(title, body).catch(() => {});
    // web 浏览器回退：HTML5 Notification
    if (typeof window !== 'undefined' && 'Notification' in window) {
      const send = () => {
        try {
          const n = new Notification(title, { body, silent: false });
          n.onclick = () => {
            window.focus();
            n.close();
            if (opts?.noticeId) openNoticeFromDesktop(opts.noticeId);
          };
          setTimeout(() => n.close(), 15000);
        } catch { /* ignore */ }
      };
      if (Notification.permission === 'granted') send();
      else if (Notification.permission === 'default') {
        Notification.requestPermission().then((p) => { if (p === 'granted') send(); }).catch(() => {});
      }
    }
  } catch { /* ignore */ }
}

interface WantedNoticeCenterProps {
  onOpenCalendar?: () => void;
  /** 受控：外部控制打开/关闭；不传时退化为内部自管 open */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 受控：入口按钮的点击 DOMRect，用于弹层锚点定位；null/undefined 时回退视口右上固定 */
  anchorRect?: DOMRect | null;
  /** 角标 pending 数变化回调（外部按钮图标红点使用） */
  onPendingChange?: (pending: number) => void;
}

/** 可折叠分区：pending（INBOX，默认展开）/ done（ARCHIVE，默认折叠），点击标题栏展开/收起。
 *  必须定义为模块级组件（而非组件函数体内）：若定义在组件体内，每次渲染都会产生新的组件类型，
 *  React 会卸载并重建分区，导致内部 expanded state 被重置（展开的 ARCHIVE 点击邮件后自动折叠）。 */
function CollapsibleSection({
  title, count, defaultExpanded, renderNoticeRow, doneList, isDone,
  tagBar, headerAction,
}: {
  title: string;
  count: number;
  defaultExpanded: boolean;
  renderNoticeRow: (
    n: Notice,
    isDone: boolean,
    info: { threadOrder: number; threadSize: number; threadCollapsed: boolean },
  ) => React.ReactNode;
  doneList: Notice[];
  isDone: boolean;
  tagBar?: React.ReactNode;
  headerAction?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          backgroundColor: 'var(--paper-soft)',
          borderBottom: '1px solid var(--line-soft)',
          borderTop: '1px solid var(--line-soft)',
        }}
      >
        <button
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? `Collapse ${title}` : `Expand ${title}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flex: 1,
            minWidth: 0,
            padding: '6px 10px',
            fontSize: '0.666667rem',
            fontWeight: 700,
            letterSpacing: '0.08em',
            color: 'var(--ink-muted)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <ChevronRight
            size={11}
            style={{
              transition: 'transform var(--dur-fast) var(--ease-fast)',
              transform: expanded ? 'rotate(90deg)' : 'none',
              flexShrink: 0,
            }}
          />
          {title} · {count}
        </button>
        {headerAction && (
          <span
            onClick={(e) => e.stopPropagation()}
            style={{ display: 'inline-flex', alignItems: 'center', paddingRight: 4, flexShrink: 0 }}
          >
            {headerAction}
          </span>
        )}
      </div>
      {expanded && tagBar}
      {expanded && doneList.map((n) => {
        return renderNoticeRow(n, isDone, { threadOrder: 1, threadSize: 1, threadCollapsed: false });
      })}
    </>
  );
}

export function WantedNoticeCenter({
  onOpenCalendar,
  open: openProp,
  onOpenChange,
  anchorRect,
  onPendingChange,
}: WantedNoticeCenterProps) {
  const { ask: confirmAsk, askChoices: confirmAskChoices, render: confirmRender } = useConfirm();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [openSelf, setOpenSelf] = useState(false);
  // 受控模式优先：外部 prop 有值 → 用 prop，否则用内部
  const open = typeof openProp === 'boolean' ? openProp : openSelf;
  const setOpen: React.Dispatch<React.SetStateAction<boolean>> = useCallback((updater) => {
    const next = typeof updater === 'function'
      ? (updater as (prev: boolean) => boolean)(typeof openProp === 'boolean' ? openProp : openSelf)
      : updater;
    if (typeof openProp === 'boolean') {
      onOpenChange?.(next);
    } else {
      setOpenSelf(next);
    }
  }, [openProp, onOpenChange]);
  // 右栏详情：当前查看的通知索引（null = 未选中，右栏显示空态提示）
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
  // 类别筛选态：非 null 表示按类别标签（CHAT/SCHEDULES/...）筛选收件箱邮件（null = 全部）
  const [filterCat, setFilterCat] = useState<string | null>(null);
  // 关键字搜索：标题 / 正文 / 待办项标题与标签模糊匹配，TODO + DONE 分区同时过滤
  const [searchQ, setSearchQ] = useState('');
  const [attachOpen, setAttachOpen] = useState(false);
  const [popupPos, setPopupPos] = useState<{ top: number; left: number } | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  // ===== Toast 浮层栈：toast=true 的 action 回执(task/note/info)只弹这个，不落 INBOX =====
  interface ToastItem {
    id: string;
    kind: WantedNoticePayload['kind'];
    title: string;
    body: string;
    action?: { type: 'open-calendar' };
    createdAt: number;
    expireAt: number;
  }
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // ⌘F 面板执行 / 命令期间的"执行中"常驻浮层文案（bus wantedExecuting 驱动）
  const [executingLabel, setExecutingLabel] = useState<string | null>(null);
  const pushToast = useCallback((p: WantedNoticePayload) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    const item: ToastItem = {
      id,
      kind: p.kind,
      title: p.title,
      body: p.body,
      action: p.action,
      createdAt: now,
      expireAt: now + 3500,
    };
    setToasts((prev) => {
      const arr = [item, ...prev];
      return arr.length > 3 ? arr.slice(0, 3) : arr;
    });
    const expireMs = item.expireAt - now + 200;
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, expireMs);
  }, []);
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const TOAST_KIND_LABEL: Record<string, { emoji: string; label: string; color: string }> = {
    task:        { emoji: '✅', label: 'TASK',    color: 'var(--success)' },
    note:        { emoji: '📝', label: 'NOTE',    color: 'var(--primary)' },
    notes:       { emoji: '📒', label: 'NOTES',   color: 'var(--primary)' },
    info:        { emoji: 'ℹ️', label: 'INFO',    color: 'var(--info)' },
    calendar:    { emoji: '⏰', label: 'REMIND',  color: 'var(--warning-strong)' },
    'daily-report': { emoji: '📋', label: 'REPORT', color: 'var(--info)' },
  };

  // 未完成（未点击 Done）条数：角标 + 收件箱分区计数 —— 延后到 inboxNotices 声明之后计算（避免 TS2448/2454）
  // （实际值用 lazy getter，放到下面声明后再赋值）

  /** kind → bucket 映射（actions 类 task/note/info 历史遗留兼容：显示但不新建；无右上角计数，空时折叠）
   *  Actions: task / note / info（历史遗留兼容：显示但不新建；无右上角计数，空时折叠）
   *  Schedules: calendar / daily-report（到期提醒、每日报告）
   */
  type BucketKey = 'schedules' | 'actions' | 'web' | 'inspect' | 'notes' | 'meeting';
  const BUCKET_LABEL: Record<BucketKey, string> = {
    schedules: 'SCHEDULES',
    actions: 'ACTIONS',
    web: 'WEB',
    inspect: 'INSPECT',
    notes: 'NOTES',
    meeting: 'MEETINGS',
  };
  const KIND_TO_BUCKET: Record<string, BucketKey> = {
    check: 'schedules',
    todo_del: 'schedules',
    calendar: 'schedules',
    'daily-report': 'schedules',
    inspect: 'inspect',
    task: 'actions',
    note: 'actions',
    info: 'actions',
    web: 'web',
    notes: 'notes',
    meeting: 'meeting',
  };
  const bucketOf = (n: Notice): BucketKey | null => KIND_TO_BUCKET[n.kind] ?? null;
  const inboxNotices = useMemo(() => notices.filter((n) => bucketOf(n) !== null), [notices]);
  const pendingList = useMemo(() => inboxNotices.filter((n) => !n.done && matchesQuery(n, searchQ)), [inboxNotices, searchQ]);
  const doneList = useMemo(() => inboxNotices.filter((n) => n.done && matchesQuery(n, searchQ)), [inboxNotices, searchQ]);

  const pending = inboxNotices.filter((n) => !n.done).length;
  const pendingCalendar = inboxNotices.filter((n) => !n.done && n.kind === 'calendar').length;

  const inboxVisibleCount = pendingList.length;
  const archiveVisibleCount = doneList.length;

  // 受控：pending 变化 → 通知外部（Sidebar Rail 图标红点）
  const pendingRef = useRef(pending);
  useEffect(() => {
    if (pendingRef.current !== pending) {
      pendingRef.current = pending;
      onPendingChange?.(pending);
    }
  }, [pending, onPendingChange]);

  /** 标题栏下方分类：按收件箱邮件的类别标签（bucket）统计条数，按条数降序；
   *  不再按内容里的待办标签自动识别（item.tags） */
  const catSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of pendingList) {
      const b = bucketOf(n);
      if (!b) continue;
      const label = BUCKET_LABEL[b];
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
  }, [pendingList]);

  /** 当前类别筛选下的收件箱邮件（按类别标签；null = 不筛选） */
  const filteredMails = useMemo(() => {
    if (filterCat === null) return null;
    return pendingList.filter((n) => {
      const b = bucketOf(n);
      return b !== null && BUCKET_LABEL[b] === filterCat;
    });
  }, [pendingList, filterCat]);

  // 订阅 ⌘F 命令执行状态：执行中 → 右上角常驻浮层；结束 → 关闭
  useEffect(() => {
    return bus.subscribe<WantedExecutingPayload>(BusEvents.wantedExecuting, (p) => {
      setExecutingLabel(p.executing ? (p.label ?? 'Running…') : null);
    });
  }, []);

  // 订阅 WANTED 通知事件：进内存 + 异步落库（收件箱持久化，刷新后历史仍在）
  useEffect(() => {
    // 消费端内存去重：防止同一事件被两个并发 bus.publish 推两遍（例如 ⌘F 面板卸载重挂载）
    // - 窗口 5 秒：同一 dedupeKey 在 5 秒内重复到达直接跳过；到期后清出
    // - 兜底 key：payload.dedupeKey 缺失时，按 `kind|title|time` 合成
    const seenDedupes = new Map<string, number>();  // key -> expireAt
    const DEDUP_WINDOW_MS = 5000;
    const deriveDedupeKey = (p: WantedNoticePayload): string => {
      if (p.dedupeKey) return p.dedupeKey;
      return `${p.kind}|${p.title}|${p.time ?? ''}`;
    };
    // 周期清理过期条目，避免 Map 无限增长
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of seenDedupes) {
        if (v <= now) seenDedupes.delete(k);
      }
    }, 30000);

    const unsub = bus.subscribe<WantedNoticePayload>(BusEvents.wantedNotice, (payload) => {
      const dedupeKey = deriveDedupeKey(payload);
      const now = Date.now();
      const expire = seenDedupes.get(dedupeKey);
      if (expire && expire > now) {
        console.warn(`[WantedNoticeCenter] dedupe 跳过重复通知 key=${dedupeKey}`);
        return;
      }
      seenDedupes.set(dedupeKey, now + DEDUP_WINDOW_MS);

      // === toast 分支：task/note/info 等用户主动操作回执，只弹即时浮层 + 可选桌面通知，
      //     不进 notices/不落 INBOX（避免"自己发的邮件还要自己归档"）
      if (payload.toast === true) {
        pushToast(payload);
        if (payload.desktop !== false && (payload.time == null || Date.now() - payload.time < 2000)) {
          sendDesktopNotification(payload.title, payload.body);
        }
        return;
      }

      // 统一 time 计算：内存 + DB 落库 + (kind,title,time) 签名去重三处必须完全相同，
      // 否则毫秒级差异会导致同一事件在 INBOX 中出现两条（一条 wn- id，一条 in- id）。
      const unifiedTime = payload.time ?? Date.now();
      const notice: Notice = {
        ...payload,
        id: `wn-${Date.now()}-${noticeSeq++}`,
        time: unifiedTime,
        read: false,
        // 新邮件一律进「收件箱」，不做自动归档；只有用户手动归档才进「已完成」分区
        done: false,
      };
      setNotices((prev) => [notice, ...prev].slice(0, 100));
      // 发布者未自行发送桌面通知时自动补发；
      // 仅对"新发布"（2 秒内）的消息弹桌面通知，避免重启后历史消息经 bus 重放导致桌面通知轰炸
      if (payload.desktop !== false && (payload.time == null || Date.now() - unifiedTime < 2000)) {
        sendDesktopNotification(payload.title, payload.body, { noticeId: notice.id });
      }
      const dbDedupeKey = payload.dedupeKey;
      // 回执落库（fire-and-forget；失败仅影响历史持久化，不阻塞实时展示）。
      // 落库成功后把内存 notice 的 id 换成服务端 in- 主键——bus 实时 id(wn-) 在 DB 中不存在，
      // 归档/已读/删除的 PATCH 若用 wn- id 会静默 no-op，导致重启后状态（done/read）丢失。
      // 若命中 insertInbox 幂等返回已存在记录（如已归档邮件被重放），同时采用其 done/read，
      // 避免重放后该邮件又回到 INBOX。
      void fetch('/api/wanted/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: payload.kind,
          title: payload.title,
          body: payload.body,
          items: payload.items,
          action: payload.action,
          source: payload.source,
          threadId: payload.threadId,
          messages: payload.messages,
          time: unifiedTime,
          dedupeKey: dbDedupeKey,
          queryKey: payload.queryKey,
        }),
      })
        .then((r) => r.json().catch(() => null))
        .then((data) => {
          const msg = (data as { message?: { id?: string; done?: boolean; read?: boolean } } | null)?.message;
          if (!msg?.id) return;
          setNotices((prev) => prev.map((n) =>
            n.id === notice.id ? { ...n, id: msg.id as string, done: !!msg.done, read: !!msg.read } : n,
          ));
        })
        .catch(() => {});
    });

    return () => {
      unsub();
      clearInterval(sweep);
    };
  }, []);

  // ---- 收件箱历史拉取（挂载 / 每次打开弹窗时增量同步，按 id 去重合并） ----
  const fetchInboxHistory = useCallback(async (): Promise<Notice[] | null> => {
    try {
      const resp = await fetch('/api/wanted/inbox?limit=50');
      const data = await resp.json();
      if (!data?.success) return null;
      return ((data.messages ?? []) as Array<{
        id: string;
        kind: Notice['kind'];
        title: string;
        body: string;
        time: number;
        read: boolean;
        done: boolean;
        action_type?: string | null;
        items?: WantedNoticeItem[];
        source?: Notice['source'];
        thread_id?: string | null;
        messages?: ChatMessage[] | null;
        dedupe_key?: string | null;
      }>).map((m) => ({
        id: m.id,
        kind: m.kind,
        title: m.title,
        body: m.body,
        time: m.time,
        read: m.read,
        done: !!m.done,
        action: m.action_type === 'open-calendar' ? { type: 'open-calendar' as const } : undefined,
        items: m.items ?? undefined,
        source: m.source ?? undefined,
        threadId: m.thread_id ?? undefined,
        messages: m.messages ?? undefined,
        dedupeKey: m.dedupe_key ?? undefined,
      }));
    } catch {
      /* 历史拉取失败时退化为仅实时通知 */
      return null;
    }
  }, []);

  /** 合并历史到内存列表（按 id 去重，新消息置顶） */
  const mergeHistory = useCallback((history: Notice[]) => {
    setNotices((prev) => {
      const existingIds = new Set(prev.map((n) => n.id));
      const existingDedupeKeys = new Set(
        prev.filter((n) => n.dedupeKey).map((n) => n.dedupeKey as string),
      );
      const existingSigs = new Set(prev.map((n) => `${n.kind}|${n.title}|${n.time}`));
      const fresh = history.filter((h) => {
        if (existingIds.has(h.id)) return false;
        if (bucketOf(h) === null) return false;
        if (h.dedupeKey && existingDedupeKeys.has(h.dedupeKey)) return false;
        if (existingSigs.has(`${h.kind}|${h.title}|${h.time}`)) return false;
        return true;
      });
      return fresh.length > 0 ? [...fresh, ...prev] : prev;
    });
  }, []);

  // 挂载时拉取收件箱历史（含已读/完成状态），与实时订阅合并
  useEffect(() => {
    let cancelled = false;
    void fetchInboxHistory().then((history) => {
      if (cancelled || !history) return;
      mergeHistory(history);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchInboxHistory, mergeHistory]);

  // ============================================================
  // 通知消费端（独占）轮询：日报 + 到期提醒 两条 pending 队列，
  // 统一由 WantedNoticeCenter（BobMail = 通知中心）独占消费。
  // 【节点舱职责清晰原则】
  //   生产舱：event-reminder.ts / daily-report.ts 只写 pending.json
  //   消费舱：WantedNoticeCenter 轮询取 pending → publish bus → 落库 inbox
  //   其他组件（⌘F 面板/CalendarPanel）禁止做同类轮询，避免双组件竞态造成同通知两遍
  // ============================================================
  // —— 每日报告（Morning Report）轮询：30s 一次
  useEffect(() => {
    let alive = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const res = await fetch('/api/wanted/daily-report');
        const d = (await res.json()) as { success?: boolean; reports?: { kind?: string; title: string; body: string; time: number; items?: WantedNoticeItem[]; dedupeKey?: string }[] };
        if (alive && d?.success && Array.isArray(d.reports) && d.reports.length > 0) {
          for (const r of d.reports) {
            // 按 kind 分流：sticky 报告落 INSPECT 分类，其余（morning）落 daily-report（Schedules 桶）
            bus.publish(BusEvents.wantedNotice, {
              kind: r.kind === 'inspect' ? 'inspect' : 'daily-report',
              title: r.title,
              body: r.body,
              time: r.time,
              desktop: false,
              items: r.items,
              source: 'scheduled',
              dedupeKey: r.dedupeKey,
            });
          }
        }
      } catch { /* 忽略网络错误 */ } finally {
        polling = false;
      }
    };
    poll();
    const timer = setInterval(poll, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  // —— 日历到期提醒（kind='calendar'）轮询：30s 一次；
  //    同时监听 calendar-events-changed 事件（日历端改状态 / ⌘F 面板创建 todo 后 dispatch）
  //    事件驱动立即拉一次，避免 30s 轮询延迟。
  useEffect(() => {
    let alive = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const res = await fetch('/api/wanted/reminders');
        const d = (await res.json()) as { success?: boolean; reminders?: { title: string; body: string; time: number; items?: WantedNoticeItem[]; dedupeKey?: string }[] };
        if (alive && d?.success && Array.isArray(d.reminders) && d.reminders.length > 0) {
          for (const r of d.reminders) {
            bus.publish(BusEvents.wantedNotice, {
              kind: 'calendar',
              title: r.title,
              body: r.body,
              time: r.time,
              desktop: true, // 由 WantedNoticeCenter 再按 time 判定：刚到期弹桌面通知，补发历史不弹
              items: r.items,
              action: { type: 'open-calendar' },
              source: 'scheduled',
              dedupeKey: r.dedupeKey,
            });
          }
        }
      } catch { /* 忽略网络错误 */ } finally {
        polling = false;
      }
    };
    poll();
    const timer = setInterval(poll, 30000);
    const onEventsChanged = () => { void poll(); };
    window.addEventListener('calendar-events-changed', onEventsChanged);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('calendar-events-changed', onEventsChanged);
    };
  }, []);

  // 日历反向联动：日历端完成/删除事件 → BobMail 中引用该事件的条目自动完成/删除
  // 用 ref 持有最新 notices，处理器只注册一次，避免 notices 变化反复 addEventListener 造成闭包陈旧
  const noticesRef = useRef<Notice[]>([]);
  noticesRef.current = notices;

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { eventId?: string; action?: 'done' | 'deleted' } | undefined;
      const evId = detail?.eventId;
      if (!evId) return;

      // 分类处理：
      //  - kind='calendar'（单事件提醒邮件）：事件 done/deleted → 整封邮件 done/删除
      //  - kind='daily-report'（多事件汇总日报）：只改动对应 item（done→标记、deleted→移除），
      //    不把日报整体 done 或删除，避免删一条日程把整份日报带走。
      //  - 其他 kind 且含 items：按 calendar 同逻辑处理（保持历史行为）。
      const shouldHandleNoticeLevel = (n: Notice): boolean => n.kind !== 'daily-report';

      if (detail.action === 'done') {
        setNotices((prev) => prev.map((n) => {
          const linkedItems = (n.items ?? []).filter((it) => it.key === evId);
          if (linkedItems.length === 0) return n;

          if (shouldHandleNoticeLevel(n)) {
            if (n.done) return n;
            void fetch('/api/wanted/inbox', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: [n.id], done: true }),
            }).catch(() => {});
            return { ...n, done: true };
          }

          // daily-report：仅将匹配 item 标为 done，其余不动
          const nextItems = (n.items ?? []).map((x) =>
            x.key === evId ? { ...x, status: 'done' as const } : x,
          );
          void fetch('/api/wanted/inbox', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [n.id], items: nextItems }),
          }).catch(() => {});
          return { ...n, items: nextItems };
        }));
      } else if (detail.action === 'deleted') {
        const patchDaily: { id: string; items: WantedNoticeItem[] }[] = [];
        const doomedNoticeIds = new Set<string>();

        setNotices((prev) => {
          const next: Notice[] = [];
          for (const n of prev) {
            const linked = (n.items ?? []).some((it) => it.key === evId);
            if (!linked) {
              next.push(n);
              continue;
            }
            if (shouldHandleNoticeLevel(n)) {
              doomedNoticeIds.add(n.id);
              // 不 push：相当于从内存 notices 中删除该封邮件
              continue;
            }
            // daily-report：只从 items 列表中剔除被删的那条，邮件主体保留
            const trimmedItems = (n.items ?? []).filter((it) => it.key !== evId);
            patchDaily.push({ id: n.id, items: trimmedItems });
            next.push({ ...n, items: trimmedItems });
          }
          return next;
        });

        // 异步持久化：整封删除的 notices 走 DELETE，daily-report 的 item 裁剪走 PATCH
        if (doomedNoticeIds.size > 0) {
          void fetch('/api/wanted/inbox', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [...doomedNoticeIds] }),
          }).catch(() => {});
        }
        if (patchDaily.length > 0) {
          void Promise.all(
            patchDaily.map((p) =>
              fetch('/api/wanted/inbox', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: [p.id], items: p.items }),
              }).catch(() => {}),
            ),
          ).catch(() => {});
        }

        // 只有整封 notice 被删除的情况才收起右栏详情；daily-report 只减了 item 不需要关详情
        setDetailIdx((idx) => {
          if (idx === null) return null;
          const cur = noticesRef.current[idx];
          if (!cur) return idx;
          const linked = (cur.items ?? []).some((it) => it.key === evId);
          if (!linked) return idx;
          return shouldHandleNoticeLevel(cur) ? null : idx;
        });
      }
    };
    window.addEventListener('bobmail-event-sync', handler);
    return () => window.removeEventListener('bobmail-event-sync', handler);
  }, []);

  // 弹窗位置计算：
  //   - 受控模式且 anchorRect（外部传入按钮的 DOMRect）存在 → 锚定到按钮**上方**（NodeMap 通知角标入口）
  //   - 否则（回退态 / 无按钮）→ 视口右上角固定 top:48, right:16
  //   始终钳制：弹窗不超出视口 8px 安全边
  const applyPopupPos = useCallback((width: number) => {
    const anchor: DOMRect | null = anchorRect && (anchorRect.top > 0 || anchorRect.left > 0)
      ? anchorRect
      : null;
    const popupW = Math.min(width, window.innerWidth - 24);
    const popupH = Math.min(720, window.innerHeight - 16);
    let top: number;
    let left: number;
    if (anchor) {
      // 弹窗放在按钮上方（水平对齐按钮左侧）；顶部空间不足时回退到按钮下方
      left = Math.max(8, Math.min(anchor.left, window.innerWidth - popupW - 8));
      top = anchor.top - popupH - 8;
      if (top < 8) top = Math.min(anchor.bottom + 8, window.innerHeight - popupH - 8);
      top = Math.max(8, top);
    } else {
      // 视口右上固定（默认回退）
      left = window.innerWidth - popupW - 16;
      top = 48;
    }
    left = Math.max(8, left);
    top = Math.max(8, top);
    setPopupPos({ top, left });
  }, [anchorRect]);

  // 桌面通知点击 → 打开弹窗并定位到对应通知详情（标已读 + 展开右栏）
  useEffect(() => {
    const handler = (e: Event) => {
      const noticeId = (e as CustomEvent).detail?.noticeId as string | undefined;
      if (!noticeId) return;
      const idx = noticesRef.current.findIndex((n) => n.id === noticeId);
      if (idx === -1) return; // 历史列表尚未拉回时忽略；该通知仍可从收件箱手动打开
      setNotices((prev) => prev.map((n) => (n.id === noticeId && !n.read ? { ...n, read: true } : n)));
      setOpen(true);
      setDetailIdx(idx);
      applyPopupPos(WIDTH_FULL);
    };
    window.addEventListener('bobmail-open-notice', handler);
    return () => window.removeEventListener('bobmail-open-notice', handler);
  }, [applyPopupPos]);

  // 打开弹窗：计算位置；回到收件箱态（不标已读、退出标签筛选、收起右栏），并增量同步收件箱。
  // 受控模式下 open 由 Sidebar Rail 图标控制，这里用 useEffect 在 open 变 true 时初始化。
  const prevOpen = useRef(open);
  useEffect(() => {
    if (open && !prevOpen.current) {
      applyPopupPos(detailIdx !== null ? WIDTH_FULL : WIDTH_LIST);
      setFilterCat(null);
      // 增量同步收件箱：保证打开弹窗即是最新（微信桥/服务端直接落库的消息也能补上）
      void fetchInboxHistory().then((h) => { if (h) mergeHistory(h); });
    }
    prevOpen.current = open;
  }, [open, applyPopupPos, fetchInboxHistory, mergeHistory, detailIdx]);

  // 关闭弹窗：同时退出标签筛选态
  const closePopup = useCallback(() => {
    setOpen(false);
    setFilterCat(null);
  }, []);

  // BobMail 弹窗固定：点击弹层外部不再自动折叠，需通过关闭按钮/右上角收起（用户偏好）。

  // 点开某条：标记已读（本地 + 后端同步）并切换右栏详情（弹窗展开为双栏）
  const openDetail = useCallback((idx: number) => {
    setNotices((prev) => {
      const target = prev[idx];
      if (target && !target.read) {
        void fetch('/api/wanted/inbox', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [target.id] }),
        }).catch(() => {});
      }
      return prev.map((n, i) => (i === idx && !n.read ? { ...n, read: true } : n));
    });
    setDetailIdx(idx);
    applyPopupPos(WIDTH_FULL);
  }, [applyPopupPos]);

  // 收起右栏详情：回到仅收件箱态
  const closeDetail = useCallback(() => {
    setDetailIdx(null);
    applyPopupPos(WIDTH_LIST);
  }, [applyPopupPos]);

  // Prev / Next 连续阅读：循环切换并同步标已读；定位基于当前分区（INBOX ⇄ pendingList / ARCHIVE ⇄ doneList），
  // 只浏览当前分区的邮件，不会跨区跳到另一区
  const navDetail = useCallback((dir: number) => {
    if (detailIdx === null || inboxNotices.length === 0) return;
    const cur = notices[detailIdx];
    const pool = cur?.done ? doneList : pendingList;
    if (pool.length === 0) return;
    const curIdx = cur ? pool.findIndex((n) => n.id === cur.id) : -1;
    const nextIdx = curIdx < 0
      ? (dir > 0 ? 0 : pool.length - 1)
      : (curIdx + dir + pool.length) % pool.length;
    const target = pool[nextIdx];
    if (!target) return;
    // 反查 notices 全局索引（因为 setNotices/setDetailIdx 仍基于全局索引）
    const nextGlobal = notices.findIndex((n) => n.id === target.id);
    if (nextGlobal < 0) return;
    if (!target.read) {
      void fetch('/api/wanted/inbox', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [target.id] }),
      }).catch(() => {});
    }
    setNotices((ns) => ns.map((n) => (n.id === target.id && !n.read ? { ...n, read: true } : n)));
    setDetailIdx(nextGlobal);
  }, [detailIdx, inboxNotices, notices, doneList, pendingList]);

  // 标记单条为已完成：从「收件箱」移入「已完成」分区；角标未完成数随之减一。
  // 该通知若携带日历事件 id（items[].key），同步把对应日历事件标记为 done 并触发日历面板刷新
  const markDone = useCallback(async (id: string): Promise<boolean> => {
    // 联动日历：仅到期提醒（kind = calendar）携带事件 id，归档时可选择顺带把对应日历事件标为 done。
    // 告知类通知（/todo 创建回执、日程查询邮件、每日报告）只标记通知本身，不改日历
    const notice = notices.find((n) => n.id === id);
    const eventIds = notice?.kind === 'calendar'
      ? (notice.items ?? [])
          .map((it) => it.key)
          .filter((k): k is string => !!k && /^[0-9a-f-]{16,}$/i.test(k))
      : [];
    // 副作用确认（英文弹窗，二选一）：归档日历提醒可选择"仅归档"或"归档并完成全部事件"
    let completeLinked = eventIds.length > 0;
    if (eventIds.length > 0) {
      const choice = await confirmAskChoices({
        title: 'Archive calendar reminder?',
        message: `This reminder is linked to ${eventIds.length} event(s) in the calendar. Choose how to archive:`,
        choices: [
          { label: 'Archive only', value: 'archive_only' },
          { label: 'Archive & complete all', value: 'archive_complete', danger: true },
        ],
      });
      if (!choice) return false; // 用户取消：什么都不做
      completeLinked = choice === 'archive_complete';
    }
    setNotices((prev) => prev.map((n) => (n.id === id ? { ...n, done: true } : n)));
    void fetch('/api/wanted/inbox', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], done: true }),
    }).catch(() => {});
    // 仅当用户选择"归档并完成全部"时才把事件标为 done
    if (eventIds.length > 0 && completeLinked) {
      let patched = 0;
      void Promise.all(
        eventIds.map((evId) =>
          fetch(`/api/calendar/events?event_id=${encodeURIComponent(evId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'done' }),
          })
            .then((r) => { if (r.ok) patched++; return r; })
            .catch(() => {})
        )
      ).then(() => {
        if (patched > 0) window.dispatchEvent(new Event('calendar-events-changed'));
      });
    }
    return true;
  }, [notices, confirmAskChoices]);

  // 星标切换：详情 / 列表行内 Star 按钮用（本地 state + 后端 PATCH）
  const markStar = useCallback((id: string, starred: boolean) => {
    setNotices((prev) => prev.map((n) => (n.id === id ? { ...n, starred } : n)));
    void fetch('/api/wanted/inbox', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], starred }),
    }).catch(() => {});
  }, []);

  // 删除通知：本地移除 + 后端 DELETE（无此 API 则吞错，仅本地生效）
  const deleteNotices = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setNotices((prev) => prev.filter((n) => !ids.includes(n.id)));
    void fetch('/api/wanted/inbox', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }).catch(() => {});
  }, []);

  // ===== ARCHIVE 多选删除：Select 模式 → 勾选行 → 批量删除 =====
  const [archiveSelMode, setArchiveSelMode] = useState(false);
  const [archiveSelected, setArchiveSelected] = useState<Set<string>>(new Set());
  const toggleArchiveSelect = useCallback((n: Notice) => {
    setArchiveSelected((prev) => {
      const next = new Set(prev);
      if (n.threadId) {
        const siblings = notices.filter((x) => x.threadId === n.threadId).map((x) => x.id);
        const allSelected = siblings.every((id) => next.has(id));
        siblings.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
      } else if (next.has(n.id)) {
        next.delete(n.id);
      } else {
        next.add(n.id);
      }
      return next;
    });
  }, [notices]);
  const exitArchiveSelect = useCallback(() => {
    setArchiveSelMode(false);
    setArchiveSelected(new Set());
  }, []);
  // 全选/清空：作用于当前搜索过滤后的 ARCHIVE 可见列表
  const toggleSelectAllArchive = useCallback(() => {
    setArchiveSelected((prev) => (
      prev.size === doneList.length ? new Set() : new Set(doneList.map((n) => n.id))
    ));
  }, [doneList]);
  const deleteSelectedArchive = useCallback(() => {
    const ids = Array.from(archiveSelected);
    if (ids.length === 0) return;
    confirmAsk({
      title: ids.length > 1 ? `Delete ${ids.length} messages?` : 'Delete this message?',
      message: 'This will permanently remove the selected messages from ARCHIVE.',
      confirmLabel: 'Delete',
    }).then((ok) => {
      if (!ok) return;
      deleteNotices(ids);
      // 若当前详情恰好是选中项之一，删除后关闭详情（索引会漂移）
      const curDetail = detailIdx !== null ? notices[detailIdx] : null;
      if (curDetail && ids.includes(curDetail.id)) closeDetail();
      exitArchiveSelect();
    }).catch(() => {});
  }, [archiveSelected, confirmAsk, deleteNotices, detailIdx, notices, closeDetail, exitArchiveSelect]);

  // Star / Archive / Delete 当前详情后：
  // 归档 → 直接关闭预览（回到邮件列表，给"已归档走"的清爽感，避免残留预览造成混淆）；
  // 删除 → 跳下一封（邮件列表仍在，保持连续处理）。
  const autoAdvanceAfterRemove = useCallback((targetId: string, isArchive: boolean) => {
    if (detailIdx === null) return;
    const cur = notices[detailIdx];
    if (!cur || cur.id !== targetId) return;
    // archive 只标 done，不移除 → 关闭预览，回到列表（不跳到下一封）
    if (isArchive) {
      closeDetail();
      return;
    }
    // delete 物理移除：按当前分区列表（INBOX ⇄ pendingList / ARCHIVE ⇄ doneList）判断是否关详情
    // 闭包内仍是操作前快照：cur.done 未变，目标仍在分区列表里
    const pool = cur.done ? doneList : pendingList;
    const remaining = pool.filter((n) => n.id !== targetId);
    if (remaining.length === 0) {
      closeDetail();
      return;
    }
    // 保持当前分区中的位置（删除后同索引 = 下一条），末尾则前移 1 位
    const posInPool = pool.findIndex((n) => n.id === targetId);
    const nextPos = Math.min(posInPool < 0 ? 0 : posInPool, remaining.length - 1);
    const nextId = remaining[nextPos]?.id;
    if (!nextId) { closeDetail(); return; }
    const nextGlobal = notices.findIndex((n) => n.id === nextId);
    if (nextGlobal < 0) closeDetail();
    else openDetail(nextGlobal);
  }, [detailIdx, notices, doneList, pendingList, closeDetail, openDetail]);

  // 详情表格行内动作：完成/恢复单条日历事件（仅更新该条 event 状态与本地 items，
  // 不动整条通知的 done —— schedule/报告里的某条做完不应把整份报告"完成"）
  const toggleItemDone = useCallback(async (it: WantedNoticeItem) => {
    const isDone = it.status === 'done';
    // 完成方向（scheduled → done）：弹英文确认，提示事件在日历中变暗、提醒停发（恢复方向不弹）
    if (!isDone) {
      const ok = await confirmAsk({
        title: 'Mark event as Done?',
        message: 'Marking this calendar event as Done will dim it in the calendar and stop its reminders from firing. You can restore it anytime by clicking the circle again.',
        confirmLabel: 'Mark Done',
      });
      if (!ok) return;
    }
    void fetch(`/api/calendar/events?event_id=${encodeURIComponent(it.key)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: isDone ? 'scheduled' : 'done' }),
    }).then((r) => {
      if (!r.ok) return;
      window.dispatchEvent(new Event('calendar-events-changed'));
      setNotices((prev) => prev.map((n) => ({
        ...n,
        items: (n.items ?? []).map((x) => (x.key === it.key ? { ...x, status: isDone ? 'scheduled' : 'done' } : x)),
      })));
    }).catch(() => {});
  }, [confirmAsk]);

  // 详情表格行内动作：删除单条日历事件（联动 BobMail 收件箱）
  const deleteItem = useCallback((it: WantedNoticeItem) => {
    void fetch(`/api/calendar/events?event_id=${encodeURIComponent(it.key)}`, {
      method: 'DELETE',
    }).then((r) => {
      if (!r.ok) return;
      window.dispatchEvent(new Event('calendar-events-changed'));
      // 联动 BobMail：删除事件 → 引用该事件的收件箱条目自动删除（与日历面板删除行为一致）
      window.dispatchEvent(new CustomEvent('bobmail-event-sync', { detail: { eventId: it.key, action: 'deleted' } }));
    }).catch(() => {});
  }, []);

  // 笔记列表邮件行内动作：删除单条笔记（DELETE /api/notebook → 本地 items 移除 → 收件箱 items 快照同步）
  const deleteNotebookItem = useCallback((it: WantedNoticeItem) => {
    void fetch(`/api/notebook?id=${encodeURIComponent(it.key)}`, {
      method: 'DELETE',
    }).then(async (r) => {
      if (!r.ok) {
        let errText = '';
        try { errText = ((await r.json()) as { error?: string }).error || ''; } catch { /* ignore */ }
        pushToast({ kind: 'info', title: 'Delete note failed', body: errText || `HTTP ${r.status}` });
        return;
      }
      const noticeId = notices[detailIdx ?? -1]?.id;
      setNotices((prev) => prev.map((n) =>
        n.id === noticeId
          ? { ...n, items: (n.items ?? []).filter((x) => x.key !== it.key) }
          : n,
      ));
      // 同步收件箱 items 快照（避免刷新后已删笔记在邮件中复活）
      if (noticeId) {
        const current = noticesRef.current[detailIdx ?? -1];
        const remaining = (current?.items ?? []).filter((x) => x.key !== it.key);
        void fetch('/api/wanted/inbox', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [noticeId], items: remaining }),
        }).catch(() => {});
      }
    }).catch(() => {});
  }, [notices, detailIdx, pushToast]);

  // 日报快捷操作：一键把今日（section=today）未完成事件全部标记完成，并同步日历与本地 items。
  // 批量操作不可撤销，点击后先弹确认，提示操作后果（会完成 N 项并同步日历待办）
  const completeAllToday = useCallback(async () => {
    const report = noticesRef.current[detailIdx ?? -1];
    if (!report) return;
    const pendingToday = (report.items ?? []).filter(
      (it) => it.section !== 'overdue' && it.status !== 'done' && it.status !== 'cancelled',
    );
    if (pendingToday.length === 0) return;
    const ok = await confirmAsk({
      title: 'Complete all today',
      message: `Mark all ${pendingToday.length} pending item(s) as done? This will also complete the linked calendar events, and they cannot be restored automatically.`,
      confirmLabel: 'Complete',
    });
    if (!ok) return;
    let patched = 0;
    void Promise.all(
      pendingToday.map((it) =>
        fetch(`/api/calendar/events?event_id=${encodeURIComponent(it.key)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done' }),
        })
          .then((r) => { if (r.ok) patched++; return r; })
          .catch(() => {})
      )
    ).then(() => {
      if (patched === 0) return;
      window.dispatchEvent(new Event('calendar-events-changed'));
      setNotices((prev) => prev.map((n) => {
        if (n.id !== report.id) return n;
        return {
          ...n,
          items: (n.items ?? []).map((x) =>
            x.section !== 'overdue' && x.status !== 'done' && x.status !== 'cancelled'
              ? { ...x, status: 'done' }
              : x,
          ),
        };
      }));
    });
  }, [detailIdx, confirmAsk]);

  // 恢复为未完成：从「已完成」分区移回待办（TODO）。日历类通知同时把对应日历事件恢复为 scheduled
  const markUndone = useCallback((id: string) => {
    setNotices((prev) => prev.map((n) => (n.id === id ? { ...n, done: false } : n)));
    void fetch('/api/wanted/inbox', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], done: false }),
    }).catch(() => {});
    // 联动日历：仅到期提醒（kind = calendar）携带事件 id，恢复时把对应日历事件改回 scheduled。
    // 告知类通知点"恢复未完成"只标记通知本身，不改日历
    const notice = notices.find((n) => n.id === id);
    const eventIds = notice?.kind === 'calendar'
      ? (notice.items ?? [])
          .map((it) => it.key)
          .filter((k): k is string => !!k && /^[0-9a-f-]{16,}$/i.test(k))
      : [];
    if (eventIds.length > 0) {
      let patched = 0;
      void Promise.all(
        eventIds.map((evId) =>
          fetch(`/api/calendar/events?event_id=${encodeURIComponent(evId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'scheduled' }),
          })
            .then((r) => { if (r.ok) patched++; return r; })
            .catch(() => {})
        )
      ).then(() => {
        if (patched > 0) window.dispatchEvent(new Event('calendar-events-changed'));
      });
    }
  }, [notices]);

  // 右栏动作按钮：日历类通知打开日历；其余任务/告知/日报类标记完成（联动日历）
  const handleDetailAction = useCallback((n: Notice) => {
    if (n.action?.type === 'open-calendar' || n.kind === 'calendar') {
      onOpenCalendar?.();
      setOpen(false);
    } else if (n.kind === 'task' || n.kind === 'info' || n.kind === 'web' || n.kind === 'daily-report'
      || n.kind === 'inspect' || n.kind === 'note'
      || n.kind === 'notes' || n.kind === 'check') {
      void markDone(n.id);
    }
  }, [onOpenCalendar, markDone]);

  // ===== 详情区子组件们（辅助渲染：避免 JSX 一大坨） =====

  /** 头像：图片优先，否则 emoji + 色板（发件人用） */
  const avatarEl = (s: SenderInfo, size: number = 36) => (
    <div style={{
      width: size,
      height: size,
      borderRadius: '50%',
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: Math.round(size * 0.48),
      backgroundColor: s.avatarBg,
      color: s.avatarFg,
      border: `1.5px solid ${s.avatarBorder}`,
      overflow: 'hidden',
      userSelect: 'none',
    }}>
      {s.avatarSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={s.avatarSrc} alt={s.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        s.avatarEmoji
      )}
    </div>
  );

  /** Star / Archive / Delete 后自动跳下一封（删除 L1337 重名实现，统一使用 L1047 版本）——这里不再重新定义 */

  // ——— webbridge 报告分享：下载 .md / 复制分析链接（仅 kind === 'web'） ———
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);

  const reportFileName = (title: string) =>
    title.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'report';

  const downloadReportMd = (n: Notice) => {
    const blob = new Blob([n.body || ''], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${reportFileName(n.title)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const copyReportLink = (id: string) => {
    const link = `${window.location.origin}/api/wanted/report?id=${encodeURIComponent(id)}`;
    const doSet = () => {
      setCopiedLinkId(id);
      window.setTimeout(() => setCopiedLinkId((c) => (c === id ? null : c)), 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(link).then(doSet).catch(() => {});
    } else {
      doSet();
    }
  };

  /** 邮件动作工具栏（Star / Delete / ⋯ More；web 附加下载+复制链接） */
  const mailActions = (n: Notice) => {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {n.kind === 'web' && (
          <>
            <button
              onClick={() => downloadReportMd(n)}
              title="Download .md — 下载报告为 Markdown 文件"
              style={iconBtn({ color: 'var(--success)' })}
            >
              <Download size={13} />
            </button>
            <button
              onClick={() => copyReportLink(n.id)}
              title={copiedLinkId === n.id ? 'Link copied ✓' : '复制报告链接 — 粘贴到对话框即可让 AI 分析'}
              style={iconBtn({ color: copiedLinkId === n.id ? 'var(--success)' : 'var(--info)' })}
            >
              {copiedLinkId === n.id ? <Check size={13} /> : <Link2 size={13} />}
            </button>
            <div style={{ width: 1, height: 16, background: 'var(--line-soft)', margin: '0 2px' }} />
          </>
        )}
        <button
          onClick={() => markStar(n.id, !n.starred)}
          title={n.starred ? 'Unstar (S)' : 'Star (S)'}
          style={iconBtn({ color: n.starred ? 'var(--warn)' : 'var(--ink-muted)' })}
        >
          <Star size={14} fill={n.starred ? 'var(--warn)' : 'none'} />
        </button>
        <button
          onClick={async () => {
            const ok = await confirmAsk({
              title: 'Delete this message?',
              message: 'This will permanently remove it from INBOX / ARCHIVE.',
              confirmLabel: 'Delete',
            });
            if (!ok) return;
            deleteNotices([n.id]);
            autoAdvanceAfterRemove(n.id, /*archive*/ false);
          }}
          title="Delete — ⌘/Ctrl + Shift + Backspace"
          style={iconBtn({ color: 'var(--danger)' })}
        >
          <Trash size={14} />
        </button>
        <button
          title="More…"
          style={iconBtn({ color: 'var(--ink-muted)' })}
          onClick={() => {
            // 占位：真实项目可展开下拉 (Mark as unread / Mute thread / Print etc.)
            void 0;
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    );
  };
  const iconBtn = ({
    color = 'var(--ink-muted)', active = false, activeBg, activeFg, disabled = false,
  }: {
    color?: string;
    active?: boolean;
    activeBg?: string;
    activeFg?: string;
    disabled?: boolean;
  }) => ({
    width: 28,
    height: 28,
    borderRadius: 4,
    background: active ? (activeBg ?? 'var(--primary-soft)') : 'none',
    color: active ? (activeFg ?? 'var(--primary)') : color,
    border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    opacity: disabled ? 0.4 : 1,
  } as React.CSSProperties);

  /** 单一邮件信封：主题行 ➜ 信封头（头像+From/To+时间+动作） ➜ 分隔线 ➜ 正文 ➜ 底部动作
   *  @param n         邮件通知
   *  @param kb        React key 前缀（堆叠时区分每封邮件）
   *  @param options.isCurrentInThread  是否当前是"主查看邮件"（高亮，不折叠摘要）
   *  @param options.showJumpTo        是否在头部右侧提供"跳到这封"按钮（堆叠里使用）
   */
  const MailEnvelope = ({
    n, kb, isCurrentInThread = true, showJumpTo = false,
  }: {
    n: Notice;
    kb: string;
    isCurrentInThread?: boolean;
    showJumpTo?: boolean;
  }) => {
    const bucket = bucketOf(n);
    const bucketSafe: BucketKey = bucket ?? 'actions';
    const badgeColor: Record<BucketKey, { bg: string; fg: string; label: string }> = {
      schedules: { bg: 'var(--info-soft)', fg: 'var(--info)', label: BUCKET_LABEL.schedules },
      actions: { bg: 'var(--success-soft)', fg: 'var(--success)', label: BUCKET_LABEL.actions },
      web: { bg: 'var(--purple-soft)', fg: 'var(--purple)', label: BUCKET_LABEL.web },
      inspect: { bg: 'var(--teal-soft)', fg: 'var(--teal)', label: BUCKET_LABEL.inspect },
      notes: { bg: 'var(--warn-soft)', fg: 'var(--warn)', label: BUCKET_LABEL.notes },
      meeting: { bg: 'rgba(201,158,54,.14)', fg: '#b8860b', label: BUCKET_LABEL.meeting },
    };
    const b = badgeColor[bucketSafe];
    const s = senderOf(n);
    const threadCount = n.threadId ? notices.filter((x) => x.threadId === n.threadId).length : 0;
    return (
      <div
        data-envelope={n.id}
        style={{
          border: isCurrentInThread ? '1px solid var(--line)' : '1px solid var(--line-soft)',
          borderRadius: 6,
          background: isCurrentInThread ? 'var(--paper)' : 'var(--paper-soft)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* === 主题行：⭐ · 标题 · thread(N) · [标签 chip] */}
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          padding: '12px 14px 6px',
        }}>
          <button
            onClick={() => markStar(n.id, !n.starred)}
            title={n.starred ? 'Unstar' : 'Star'}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 2,
              marginTop: 1,
              color: n.starred ? 'var(--warn)' : 'var(--ink-faint)',
              display: 'inline-flex',
              flexShrink: 0,
            }}
          >
            <Star size={15} fill={n.starred ? 'var(--warn)' : 'none'} />
          </button>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: '1.066667rem', fontWeight: 900, color: 'var(--ink-strong)', lineHeight: 1.35, wordBreak: 'break-word' }}>
              {n.title}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: '0.7rem',
                fontWeight: 700,
                letterSpacing: '0.04em',
                padding: '1px 7px',
                borderRadius: 2,
                backgroundColor: b.bg,
                color: b.fg,
                border: '1px solid currentColor',
              }}>
                {n.kind === 'calendar' ? <Bell size={10} /> : n.kind === 'daily-report' ? <Clock size={10} /> : <Mail size={10} />}
                {b.label}
              </span>
              {n.threadId && threadCount > 1 && (
                <span style={{
                  fontSize: '0.666667rem',
                  padding: '1px 7px',
                  borderRadius: 999,
                  backgroundColor: 'var(--primary-soft)',
                  color: 'var(--primary)',
                  fontWeight: 700,
                  border: '1px solid currentColor',
                }}>
                  🧵 {threadCount} msgs
                </span>
              )}
              {n.done && (
                <span style={{
                  fontSize: '0.666667rem',
                  padding: '1px 7px',
                  borderRadius: 999,
                  backgroundColor: 'var(--success-soft)',
                  color: 'var(--success)',
                  fontWeight: 700,
                  border: '1px solid currentColor',
                }}>
                  ✓ Archived
                </span>
              )}
            </div>
          </div>
          {showJumpTo && (
            <button
              onClick={() => {
                const i = notices.findIndex((x) => x.id === n.id);
                if (i >= 0) openDetail(i);
              }}
              title="Open as main message (shift focus to this)"
              style={{
                flexShrink: 0,
                background: 'none',
                border: '1px solid var(--line)',
                borderRadius: 2,
                padding: '3px 8px',
                cursor: 'pointer',
                color: 'var(--ink-muted)',
                fontSize: '0.733333rem',
                fontWeight: 600,
              }}
            >
              ↗ Focus
            </button>
          )}
        </div>

        {/* === 信封头：头像 + From/To + 完整时间 + 动作工具栏 */}
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '8px 14px 10px',
        }}>
          {avatarEl(s, 40)}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 2 }}>
            <div style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              flexWrap: 'wrap',
            }}>
              <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--ink-strong)' }}>
                {s.name}
              </span>
              <span style={{ fontSize: '0.733333rem', color: 'var(--ink-faint)' }}>
                &lt;{s.email}&gt;
              </span>
            </div>
            <div style={{ fontSize: '0.733333rem', color: 'var(--ink-muted)' }}>
              To:&nbsp;<span style={{ color: 'var(--ink-strong)' }}>{s.to}</span>
              {n.kind === 'calendar' && (
                <>
                  &nbsp;·&nbsp;
                  <span style={{ color: 'var(--info)', fontWeight: 600 }}>📅 Calendar reminder</span>
                </>
              )}
              {n.kind === 'daily-report' && (
                <>
                  &nbsp;·&nbsp;
                  <span style={{ color: 'var(--warn)', fontWeight: 600 }}>🌞 Scheduled daily digest</span>
                </>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
            <div
              title={formatFullTime(n.time)}
              style={{ fontSize: '0.733333rem', color: 'var(--ink-muted)', whiteSpace: 'nowrap' }}
            >
              {formatTime(n.time)}
            </div>
            {mailActions(n)}
          </div>
        </div>

        {/* === 分隔线 === */}
        <div style={{ height: 1, background: 'var(--line-soft)', margin: '0 14px' }} />

        {/* === 正文容器：daily-report 模板 / itemsTable / 正文 */}
        <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {n.kind === 'daily-report' && Array.isArray(n.items) && n.items.length > 0 ? (
            <DailyReportDetail
              items={n.items}
              onToggle={toggleItemDone}
              onDelete={deleteItem}
              onCompleteToday={completeAllToday}
            />
          ) : n.kind === 'inspect' && n.body ? (
            <InspectDetail body={n.body} />
          ) : n.kind === 'notes' && Array.isArray(n.items) ? (
            <>
              {n.body.split('\n')[0]?.trim() ? (
                <div style={{ fontSize: '0.733333rem', color: 'var(--ink-muted)', marginBottom: 4 }}>
                  {richText(n.body.split('\n')[0].trim(), { keyBase: `${kb}-noteshead` })}
                </div>
              ) : null}
              <NotesTable items={n.items} onDelete={deleteNotebookItem} />
            </>
          ) : Array.isArray(n.items) && n.items.length > 0 ? (
            <>
              {(() => {
                const firstLine = n.body.split('\n')[0]?.trim() ?? '';
                return firstLine && !firstLine.includes(' event(s)') ? (
                  <div style={{ fontSize: '0.733333rem', color: 'var(--ink-muted)', marginBottom: 4 }}>
                    {richText(firstLine, { keyBase: `${kb}-firstline` })}
                  </div>
                ) : null;
              })()}
              <ItemsTable items={n.items} onToggle={toggleItemDone} onDelete={deleteItem} />
            </>
          ) : (
            <div style={{ padding: '2px 0' }}>
              {n.kind === 'web'
                ? <HtmlRenderer content={stripThinkTags(n.body)} />
                : richText(n.body, { keyBase: `${kb}-body` })}
            </div>
          )}
        </div>

        {/* === 附件：info 邮件携带的原始对话存档（organize-send 整理报告）——点击展开完整对话记录 === */}
        {(n.kind === 'info' || n.kind === 'web') && Array.isArray(n.messages) && n.messages.length > 0 && (
          <div style={{
            margin: '0 14px 10px',
            borderRadius: 6,
            border: '1px dashed var(--primary)',
            background: 'var(--primary-soft)',
            overflow: 'hidden',
          }}>
            <button
              onClick={() => setAttachOpen((v) => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                background: 'none',
                border: 'none',
                padding: '8px 12px',
                cursor: 'pointer',
                color: 'var(--primary)',
                fontSize: '0.8rem',
                fontWeight: 700,
                fontFamily: SANS_FONT,
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: '0.933333rem' }}>📎</span>
              <span style={{ flex: 1 }}>
                附件 · 原始对话（{n.messages.length} 条消息）
              </span>
              <span style={{ fontSize: '0.666667rem', opacity: 0.7 }}>{attachOpen ? '▲ 收起' : '▼ 展开'}</span>
            </button>
            {attachOpen && (
              <div style={{
                borderTop: '1px dashed var(--primary)',
                padding: '8px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                maxHeight: 260,
                overflowY: 'auto',
              }}>
                {n.messages.map((m, i) => (
                  <div key={`${kb}-attach-${i}`} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      color: m.role === 'user' ? 'var(--primary)' : 'var(--ink-muted)',
                    }}>
                      {m.role === 'user' ? '👤 用户' : '🤖 AI'}
                    </div>
                    <div style={{
                      fontSize: '0.8rem',
                      lineHeight: 1.6,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      color: 'var(--ink)',
                      fontFamily: SANS_FONT,
                    }}>
                      {m.role === 'user'
                        ? richText(m.content, { keyBase: `${kb}-attach-${i}` })
                        : <HtmlRenderer content={stripThinkTags(m.content)} />}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* === 底部动作：calendar 类提供 Open Calendar；其余提供 Mark as done */}
        {(
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '10px 14px 12px',
            borderTop: '1px solid var(--line-soft)',
            background: 'var(--paper-soft)',
            borderRadius: '0 0 6px 6px',
          }}>
            {(n.action?.type === 'open-calendar' || n.kind === 'calendar') && (
              <button
                onClick={() => handleDetailAction(n)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  background: 'var(--info-soft)',
                  border: '1px solid var(--info)',
                  color: 'var(--info)',
                  borderRadius: 2,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                  fontWeight: 700,
                }}
              >
                <CalendarDays size={13} /> Open Calendar
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  // 弹窗头部自由拖动：按下记录偏移，移动实时更新位置，松开结束
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const startDrag = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (!popupPos) return;
    // 按钮（Mark all read / Close 等）不触发拖动
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    dragRef.current = { dx: e.clientX - popupPos.left, dy: e.clientY - popupPos.top };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setPopupPos({ top: ev.clientY - dragRef.current.dy, left: ev.clientX - dragRef.current.dx });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // 松手后钳制在视口内，避免拖出屏幕导致弹窗再也找不到
      setPopupPos((pos) => {
        if (!pos) return pos;
        const popupW = Math.min(detailIdx !== null ? WIDTH_FULL : WIDTH_LIST, window.innerWidth - 24);
        const popupH = Math.min(720, window.innerHeight - 16);
        return {
          top: Math.max(8, Math.min(pos.top, window.innerHeight - popupH - 8)),
          left: Math.max(8, Math.min(pos.left, window.innerWidth - popupW - 8)),
        };
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [popupPos, detailIdx]);

  const detail = detailIdx !== null ? notices[detailIdx] : null;

  // 归档：语义等同 markDone（快捷键 E 与 Archive 按钮均用 markArchive + autoAdvanceAfterRemove）
  const markArchive = useCallback(async (id: string, doArchive: boolean) => {
    if (doArchive) {
      const ok = await markDone(id);
      if (!ok) return;
      autoAdvanceAfterRemove(id, true);
    } else {
      setNotices((prev) => prev.map((n) => (n.id === id ? { ...n, done: false } : n)));
      void fetch('/api/wanted/inbox', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], done: false }),
      }).catch(() => {});
    }
  }, [markDone, autoAdvanceAfterRemove]);

  // 单条删除（快捷键 ⌘⇧D / delete 等 UI 复用）：包装已有的 deleteNotices([id])
  const markDelete = useCallback((id: string) => {
    confirmAsk({
      title: 'Delete this message?',
      message: 'This will permanently remove it from INBOX / ARCHIVE.',
      confirmLabel: 'Delete',
    }).then((ok) => {
      if (!ok) return;
      deleteNotices([id]);
      autoAdvanceAfterRemove(id, false);
    }).catch(() => {});
  }, [confirmAsk, deleteNotices, autoAdvanceAfterRemove]);

  // 全局邮箱快捷键：J/K 切上/下一封；Esc 关详情；E 归档；S 星标；⌘⇧D 删除
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.isTrusted) return;
      const target = e.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
          (target as any).isContentEditable);
      // R / Esc / ⌘⇧D / ⌘↵ 允许在 reply textarea 中生效；其余仅在非输入焦点时
      const typingOk = (k: string) =>
        k === 'R' || k === 'Escape' || (k === 'D' && e.metaKey && e.shiftKey) ||
        (k === 'Enter' && (e.metaKey || e.ctrlKey));
      if (isTyping && !typingOk(e.key)) return;
      switch (e.key) {
        case 'j': case 'J':
          if (!isTyping) { e.preventDefault(); navDetail(1); }
          break;
        case 'k': case 'K':
          if (!isTyping) { e.preventDefault(); navDetail(-1); }
          break;
        case 'Escape':
          if (!isTyping) {
            e.preventDefault();
            closeDetail();
          }
          break;
        case 'e': case 'E':
          if (detail && !isTyping) {
            e.preventDefault();
            void markArchive(detail.id, !detail.done);
          }
          break;
        case 's': case 'S':
          if (detail && !isTyping) {
            e.preventDefault();
            markStar(detail.id, !detail.starred);
          }
          break;
        case 'd': case 'D':
          if ((e.metaKey || e.ctrlKey) && e.shiftKey && detail && !isTyping) {
            e.preventDefault();
            markDelete(detail.id);
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, detail, closeDetail, navDetail, markArchive, markStar, markDelete]);

  /** INBOX 标题栏下方的类别筛选栏：按类别标签（bucket）统计收件箱邮件条数，降序；点击原位筛选 */
  const tagBarNode = catSummary.length > 0 ? (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
        padding: '6px 10px',
        borderBottom: '1px solid var(--line-soft)',
        backgroundColor: 'var(--paper-soft)',
      }}
    >
      <button
        onClick={() => setFilterCat(null)}
        title="Show all categories"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          borderRadius: 999,
          border: `1px solid ${filterCat === null ? 'var(--primary)' : 'var(--line)'}`,
          background: filterCat === null ? 'var(--primary-soft)' : 'var(--paper)',
          color: filterCat === null ? 'var(--primary)' : 'var(--ink-muted)',
          cursor: 'pointer',
          fontSize: '0.733333rem',
          fontWeight: filterCat === null ? 700 : 400,
          lineHeight: '16px',
        }}
      >
        All
      </button>
      {catSummary.map(({ tag, count }) => {
        const active = filterCat === tag;
        return (
          <button
            key={tag}
            onClick={() => setFilterCat(active ? null : tag)}
            title={`View ${tag} mails`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 8px',
              borderRadius: 999,
              border: `1px solid ${active ? 'var(--primary)' : 'var(--line)'}`,
              background: active ? 'var(--primary-soft)' : 'var(--paper)',
              color: active ? 'var(--primary)' : 'var(--ink)',
              cursor: 'pointer',
              fontSize: '0.733333rem',
              fontWeight: active ? 700 : 400,
              lineHeight: '16px',
            }}
          >
            <LayoutGrid size={10} />
            {tag}
            <span style={{ color: active ? 'var(--primary)' : 'var(--ink-faint)', fontSize: '0.666667rem' }}>{count}</span>
          </button>
        );
      })}
    </div>
  ) : null;

  /** 左栏单行渲染 */
  const renderNoticeRow = (
    n: Notice,
    isDone: boolean,
    _info: { threadOrder: number; threadSize: number; threadCollapsed: boolean } = {
      threadOrder: 1,
      threadSize: 1,
      threadCollapsed: false,
    },
  ): React.ReactNode => {
    const idx = notices.findIndex((x) => x.id === n.id);
    const selected = idx === detailIdx;
    const selMode = isDone && archiveSelMode;
    const rowSelected = selMode && (n.threadId
      ? notices.filter((x) => x.threadId === n.threadId).some((x) => archiveSelected.has(x.id))
      : archiveSelected.has(n.id));
    const leftAccentColor =
      n.kind === 'daily-report' ? 'var(--warn)' :
      n.kind === 'inspect' ? 'var(--teal)' : 'var(--primary)';
    return (
      <div
        key={n.id}
        className="group"
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'stretch',
          borderBottom: '1px solid var(--line-soft)',
          background: selected || rowSelected ? 'var(--paper-hover)' : 'none',
        }}
        onMouseEnter={(e) => { if (!selected && !rowSelected) e.currentTarget.style.backgroundColor = 'var(--paper-hover)'; }}
        onMouseLeave={(e) => { if (!selected && !rowSelected) e.currentTarget.style.backgroundColor = 'transparent'; }}
      >
        <div style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: isDone || n.read ? 'transparent' : leftAccentColor,
          zIndex: 1,
        }} />
        {selMode && (
          <span
            onClick={(e) => { e.stopPropagation(); toggleArchiveSelect(n); }}
            title={rowSelected ? 'Deselect' : 'Select'}
            style={{
              flexShrink: 0,
              alignSelf: 'flex-start',
              margin: '10px 2px 0 8px',
              width: 15,
              height: 15,
              borderRadius: 3,
              border: `1.5px solid ${rowSelected ? 'var(--primary)' : 'var(--ink-faint)'}`,
              backgroundColor: rowSelected ? 'var(--primary)' : 'transparent',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: '0.666667rem',
              fontWeight: 700,
              lineHeight: 1,
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            {rowSelected ? '✓' : ''}
          </span>
        )}
        <button
          onClick={() => (selMode ? toggleArchiveSelect(n) : openDetail(idx))}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '8px 4px 8px 10px',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            opacity: isDone ? 0.62 : 1,
            position: 'relative',
            zIndex: 2,
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                flexShrink: 0,
                width: 6,
                height: 6,
                borderRadius: '50%',
                backgroundColor: isDone || n.read ? 'transparent' : leftAccentColor,
              }}
            />
            {(() => {
              const b = bucketOf(n);
              const cfg: Record<BucketKey, { bg: string; fg: string; label: string }> = {
                schedules: { bg: 'var(--info-soft)', fg: 'var(--info)', label: 'SCHEDULES' },
                actions: { bg: 'var(--success-soft)', fg: 'var(--success)', label: 'ACTIONS' },
                web: { bg: 'var(--purple-soft)', fg: 'var(--purple)', label: 'WEB' },
                inspect: { bg: 'var(--teal-soft)', fg: 'var(--teal)', label: 'INSPECT' },
                notes: { bg: 'var(--warn-soft)', fg: 'var(--warn)', label: 'NOTES' },
                meeting: { bg: 'rgba(201,158,54,.14)', fg: '#b8860b', label: 'MEETINGS' },
              };
              if (!b) return null;
              const c = cfg[b];
              return (
                <span style={{
                  flexShrink: 0,
                  fontSize: '0.533333rem',
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  padding: '1px 4px',
                  borderRadius: 2,
                  backgroundColor: c.bg,
                  color: c.fg,
                  lineHeight: '14px',
                }}>
                  {c.label}
                </span>
              );
            })()}
          </span>
          <span
            style={{
              display: 'block',
              fontSize: '0.8rem',
              fontWeight: n.read ? 400 : 700,
              color: n.read ? 'var(--ink-muted)' : 'var(--ink)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              lineHeight: '18px',
            }}
          >
            {n.title}
          </span>
          <span
            title={formatFullTime(n.time)}
            style={{
              fontSize: '0.666667rem',
              color: 'var(--ink-muted)',
              lineHeight: '16px',
            }}
          >
            {formatTime(n.time)}
          </span>
        </button>
        {!isDone ? (
          n.kind === 'calendar' ? (
            /* 到期提醒：空心圆（绿），点击完成日历待办 → 完成后变为空心勾选 */
            <button
              onClick={(e) => { e.stopPropagation(); void markDone(n.id); }}
              title="Complete this calendar event"
              style={{
                flexShrink: 0,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '4px 8px',
                color: 'var(--success)',
                display: 'inline-flex',
                alignItems: 'center',
                opacity: 0.45,
                transition: 'opacity var(--dur-fast) var(--ease-fast)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.45'; }}
            >
              <Circle size={13} />
            </button>
          ) : (
            /* 告知类通知：睁开的眼睛（蓝），仅标记通知本身 → 完成后变为闭上的眼睛 */
            <button
              onClick={(e) => { e.stopPropagation(); void markDone(n.id); }}
              title="Mark as done"
              style={{
                flexShrink: 0,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '4px 8px',
                color: 'var(--info)',
                display: 'inline-flex',
                alignItems: 'center',
                opacity: 0.45,
                transition: 'opacity var(--dur-fast) var(--ease-fast)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.45'; }}
            >
              <Eye size={13} />
            </button>
          )
        ) : (
          <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            {n.kind === 'calendar' ? (
              /* 到期提醒已完成：空心勾选（绿）兼作恢复按钮（点击 → 移回 TODO 并联动日历回 scheduled） */
              <button
                onClick={(e) => { e.stopPropagation(); markUndone(n.id); }}
                title="Restore to TODO"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px 8px',
                  color: 'var(--success)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  opacity: 0.55,
                  transition: 'opacity var(--dur-fast) var(--ease-fast)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.55'; }}
              >
                <CheckCircle2 size={13} />
              </button>
            ) : (
              /* 告知类通知已完成：闭眼（蓝），仅标识已处理 */
              <span
                title="Handled"
                style={{
                  padding: '4px 8px',
                  color: 'var(--info)',
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
              >
                <EyeOff size={13} />
              </span>
            )}
          </span>
        )}
      </div>
    );
  };

  return (
    <>
      {/* 触发按钮已移到 Sidebar Rail（WANTED 图标）——本组件只渲染弹层 + toast */}

      {/* 通知弹窗：左收件箱 + 右详情（并排，仿邮件客户端）——通过 portal 挂到 body，
          避免被 ⌘F 面板通缉令容器的 overflow:hidden 裁切。
          层级：z-44 —— 低于 ⌘F 面板展开面板（z-45），面板展开时不被 BobMail 遮挡；
          仍高于 Sidebar（z-20）与悬浮面板（z-40）；同时低于 Dialog（z-50），不遮挡 SettingsModal 等弹窗 */}
      {open && popupPos && createPortal(
        <>
          <div
            ref={popupRef}
            style={{
              position: 'fixed',
              top: popupPos.top,
              left: popupPos.left,
              zIndex: 44,
              width: detailIdx !== null ? WIDTH_FULL : WIDTH_LIST,
              maxWidth: 'calc(100vw - 24px)',
              height: 720,
              maxHeight: 'calc(100vh - 16px)',
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: 'var(--paper)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
              fontFamily: "var(--font-sans)",
              overflow: 'hidden',
              transition: 'width var(--dur-fast) var(--ease-fast)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 标题栏：始终渲染（含关闭按钮）——空收件箱也保留，避免清空邮件后无法关闭面板 */}
            <div
              onMouseDown={startDrag}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 10px',
                borderBottom: '1px solid var(--line-soft)',
                backgroundColor: 'var(--paper-soft)',
                cursor: 'move',
                userSelect: 'none',
              }}
            >
              <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--ink-strong)', letterSpacing: '0.08em' }}>
                BobMail<span style={{ color: 'var(--ink-muted)', fontWeight: 400, marginLeft: 4 }}>· {pending} pending</span>
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button
                  onClick={closePopup}
                  title="Close"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--ink-muted)', display: 'inline-flex' }}
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            {inboxNotices.length === 0 ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ padding: '18px 12px', textAlign: 'center', fontSize: '0.8rem', color: 'var(--ink-muted)' }}>
                  No notifications
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                {/* ===== 左栏：收件箱列表 ===== */}
                <div
                  className="flex flex-col"
                  style={{ width: 360, flexShrink: 0, borderRight: '1px solid var(--line-soft)' }}
                >

                  {/* 收件箱态：搜索框 + 通知列表 = 收件箱（未完成）分区 + 已完成分区；
                      类别筛选时 INBOX 列表按类别标签原位过滤 */}
                  <>
                      {notices.length > 0 && (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '6px 10px',
                            borderBottom: '1px solid var(--line-soft)',
                            backgroundColor: 'var(--paper-soft)',
                          }}
                        >
                          <Search size={12} style={{ flexShrink: 0, color: 'var(--ink-faint)' }} />
                          <input
                            value={searchQ}
                            onChange={(e) => setSearchQ(e.target.value)}
                            placeholder="Search title / body / tag…"
                            spellCheck={false}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              height: 20,
                              background: 'none',
                              border: 'none',
                              outline: 'none',
                              fontSize: '0.8rem',
                              color: 'var(--ink)',
                            }}
                          />
                          {searchQ && (
                            <button
                              onClick={() => setSearchQ('')}
                              title="Clear search"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink-faint)', display: 'inline-flex' }}
                            >
                              <X size={11} />
                            </button>
                          )}
                        </div>
                      )}
                      <div style={{ flex: 1, overflowY: 'auto', overscrollBehavior: 'contain', padding: '4px 0' }}>
                        <CollapsibleSection title="INBOX" count={filterCat !== null ? (filteredMails ?? []).length : inboxVisibleCount} defaultExpanded renderNoticeRow={renderNoticeRow} doneList={filterCat !== null ? (filteredMails ?? []) : pendingList} isDone={false} tagBar={tagBarNode} />
                        {doneList.length > 0 && (
                          <CollapsibleSection title="ARCHIVE" count={archiveVisibleCount} defaultExpanded={false} renderNoticeRow={renderNoticeRow} doneList={doneList} isDone headerAction={(
                            <button
                              onClick={(e) => { e.stopPropagation(); if (archiveSelMode) exitArchiveSelect(); else setArchiveSelMode(true); }}
                              title={archiveSelMode ? 'Exit multi-select' : 'Multi-select to delete'}
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: '2px 4px',
                                fontSize: '0.666667rem',
                                fontWeight: 700,
                                color: archiveSelMode ? 'var(--primary)' : 'var(--ink-muted)',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 3,
                              }}
                            >
                              {archiveSelMode ? 'Done' : 'Select'}
                            </button>
                          )} />
                        )}
                        {(filterCat !== null ? (filteredMails ?? []).length : pendingList.length) === 0 && doneList.length === 0 && (searchQ || filterCat !== null) && (
                          <div style={{ padding: '18px 12px', textAlign: 'center', fontSize: '0.8rem', color: 'var(--ink-muted)' }}>
                            {filterCat !== null ? `No mails under ${filterCat}` : `No matches for &ldquo;${searchQ}&rdquo;`}
                          </div>
                        )}
                      </div>
                      {/* ARCHIVE 多选删除操作栏：选中数 + Select all / Delete / Cancel */}
                      {archiveSelMode && (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '8px 10px',
                            borderTop: '1px solid var(--line-soft)',
                            backgroundColor: 'var(--paper-soft)',
                          }}
                        >
                          <button
                            onClick={toggleSelectAllArchive}
                            title={archiveSelected.size === doneList.length ? 'Clear all selection' : 'Select all visible messages'}
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              padding: '3px 6px',
                              fontSize: '0.733333rem',
                              fontWeight: 600,
                              color: 'var(--ink-muted)',
                              borderRadius: 4,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 3,
                            }}
                          >
                            {archiveSelected.size === doneList.length ? 'Clear all' : 'Select all'}
                          </button>
                          <span style={{ flex: 1, fontSize: '0.733333rem', fontWeight: 600, color: 'var(--primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {archiveSelected.size} selected
                          </span>
                          <button
                            onClick={deleteSelectedArchive}
                            disabled={archiveSelected.size === 0}
                            title="Delete selected"
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: archiveSelected.size === 0 ? 'not-allowed' : 'pointer',
                              padding: '3px 6px',
                              fontSize: '0.733333rem',
                              fontWeight: 700,
                              color: archiveSelected.size === 0 ? 'var(--ink-faint)' : '#d64545',
                              borderRadius: 4,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 3,
                              opacity: archiveSelected.size === 0 ? 0.5 : 1,
                            }}
                          >
                            <Trash size={12} />
                            Delete
                          </button>
                          <button
                            onClick={exitArchiveSelect}
                            title="Cancel multi-select"
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              padding: '3px 6px',
                              fontSize: '0.733333rem',
                              fontWeight: 600,
                              color: 'var(--ink-muted)',
                              borderRadius: 4,
                              display: 'inline-flex',
                              alignItems: 'center',
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </>
                </div>

                {/* ===== 右栏：详情（默认收起，点击左侧条目后展开） —— 始终占一席，空态居中插画 ===== */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, borderLeft: detail ? '1px solid var(--line-soft)' : 'none' }}>
                  {/* 顶栏：拖动 + Prev/Next + Close（分类 badge 移到信封主题行） */}
                  <div
                    onMouseDown={startDrag}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '10px 14px',
                      borderBottom: '1px solid var(--line-soft)',
                      backgroundColor: 'var(--paper-soft)',
                      cursor: detail ? 'move' : 'move',
                      userSelect: 'none',
                    }}
                  >
                    <div style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: '0.733333rem',
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      padding: '2px 8px',
                      borderRadius: 2,
                      backgroundColor: 'var(--primary-soft)',
                      color: 'var(--primary)',
                      border: '1px solid currentColor',
                    }}>
                      <Mail size={11} />
                      {detail ? 'MESSAGE' : 'INBOX'}
                    </div>
                    {detail && (
                      <span style={{ fontSize: '0.733333rem', color: 'var(--ink-muted)' }}>
                        {Math.min(detailIdx ?? 0, notices.length - 1) + 1} / {notices.length}
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    <button
                      onClick={() => navDetail(-1)}
                      disabled={!detail || notices.length <= 1}
                      title="Previous (K)"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 3,
                        background: 'none',
                        border: '1px solid var(--line)',
                        borderRadius: 2,
                        cursor: detail && notices.length > 1 ? 'pointer' : 'not-allowed',
                        fontSize: '0.8rem',
                        color: detail && notices.length > 1 ? 'var(--ink)' : 'var(--ink-faint)',
                        padding: '4px 8px',
                      }}
                    >
                      <ChevronLeft size={13} />
                      Prev
                    </button>
                    <button
                      onClick={() => navDetail(1)}
                      disabled={!detail || notices.length <= 1}
                      title="Next (J)"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 3,
                        background: 'none',
                        border: '1px solid var(--line)',
                        borderRadius: 2,
                        cursor: detail && notices.length > 1 ? 'pointer' : 'not-allowed',
                        fontSize: '0.8rem',
                        color: detail && notices.length > 1 ? 'var(--ink)' : 'var(--ink-faint)',
                        padding: '4px 8px',
                      }}
                    >
                      Next
                      <ChevronRight size={13} />
                    </button>
                    <button
                      onClick={closeDetail}
                      title="Collapse detail (Esc)"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--ink-muted)',
                        padding: '2px 4px',
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>

                  {!detail ? (
                    // ============ 空态：📭 Select a message ============
                    <div style={{
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 16,
                      padding: '24px 40px',
                      color: 'var(--ink-muted)',
                    }}>
                      <div style={{
                        width: 96, height: 96,
                        borderRadius: '50%',
                        background: 'var(--primary-soft)',
                        border: '1.5px solid var(--primary)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 44,
                      }}>
                        📭
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                        <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--ink-strong)' }}>
                          Select a message to preview
                        </div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--ink-muted)', textAlign: 'center', lineHeight: 1.6, maxWidth: 360 }}>
                          Choose a conversation from the left inbox.<br/>
                          Chat threads are preserved forever — no 15-minute TTL.
                        </div>
                      </div>
                      <div style={{
                        display: 'flex',
                        gap: 8,
                        marginTop: 4,
                        flexWrap: 'wrap',
                        justifyContent: 'center',
                      }}>
                        {[
                          ['J / K', 'Prev / Next'],
                          ['E', 'Archive'],
                          ['S', 'Star / Unstar'],
                        ].map(([k, v]) => (
                          <div key={k} style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '3px 8px',
                            border: '1px solid var(--line-soft)',
                            borderRadius: 4,
                            fontSize: '0.733333rem',
                          }}>
                            <span style={{
                              fontFamily: "var(--font-mono)",
                              fontWeight: 700,
                              color: 'var(--primary)',
                              fontSize: '0.7rem',
                              padding: '1px 5px',
                              borderRadius: 3,
                              backgroundColor: 'var(--primary-soft)',
                              border: '1px solid var(--primary)',
                            }}>{k}</span>
                            <span style={{ color: 'var(--ink-muted)' }}>{v}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    // ============ 内容区（可滚动） ============
                    <div style={{ flex: 1, overflowY: 'auto', overscrollBehavior: 'contain', padding: '14px 16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <MailEnvelope n={detail} kb={`detail-${detail.id}`} />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </>,
        document.body
      )}

      {/* 应用内确认弹窗（批量完成等操作前的后果提醒） */}
      {confirmRender}

      {/* ===== ⌘F 命令"执行中"常驻浮层：DOS 终端风格，执行期间右上角展示，结束消失 ===== */}
      {executingLabel && (
        <div
          style={{
            position: 'fixed',
            top: 16,
            right: 16,
            zIndex: 2147483001,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              width: 360,
              maxWidth: 'calc(100vw - 32px)',
              overflow: 'hidden',
              background: '#0a0a0a',
              border: '1px solid #1f7a2f',
              borderRadius: 4,
              boxShadow: '0 10px 28px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.8)',
              fontFamily: '"Cascadia Mono", "Consolas", "Courier New", monospace',
              animation: 'toastIn 180ms ease-out',
            }}
          >
            {/* 终端标题栏 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '3px 6px 3px 8px',
                background: 'linear-gradient(180deg, #232323, #111111)',
                borderBottom: '1px solid #1f7a2f',
              }}
            >
              <span style={{ color: '#7fd97f', fontSize: '0.666667rem', letterSpacing: 1, fontWeight: 700 }}>C:\BOBWORK -- EXEC</span>
              <span style={{ color: '#7fd97f', fontSize: '0.666667rem' }}>▬▬▬▬ □ ×</span>
            </div>
            {/* 终端口令行 */}
            <div style={{ padding: '8px 10px 9px 10px', minHeight: 30 }}>
              <span style={{ color: '#bfbfbf', fontSize: '0.8rem' }}>C:\WANTED&gt;</span>{' '}
              <span style={{ color: '#7ff57f', fontSize: '0.8rem', fontWeight: 700 }}>{executingLabel}</span>{' '}
              <span style={{ display: 'inline-block', width: 7, height: 13, background: '#7ff57f', verticalAlign: 'text-bottom', animation: 'dosBlink 1s steps(1) infinite' }} />
            </div>
          </div>
        </div>
      )}

      {/* ===== 即时 Toast 栈：task/note/info 回执不落 INBOX，只弹这个（3.5s 自消） =====
         *  放 body 根（跟随视口 fixed），不随 BobMail 关闭丢失
         */}
      {toasts.length > 0 && (
        <div
          style={{
            position: 'fixed',
            top: 16,
            right: 16,
            zIndex: 2147483000,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            alignItems: 'flex-end',
            pointerEvents: 'none',
          }}
        >
          {toasts.map((t) => {
            const lbl = TOAST_KIND_LABEL[t.kind] ?? TOAST_KIND_LABEL.info;
            const bodyShort = t.body.length > 180 ? `${t.body.slice(0, 180)}…` : t.body;
            return (
              <div
                key={t.id}
                style={{
                  pointerEvents: 'auto',
                  width: 360,
                  maxWidth: 'calc(100vw - 32px)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '10px 12px 10px 12px',
                  background: 'var(--paper)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  boxShadow: '0 10px 28px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.06)',
                  animation: 'toastIn 180ms ease-out',
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                <div style={{
                  position: 'absolute', inset: 0,
                  background: `linear-gradient(180deg, ${lbl.color}12 0%, transparent 32%)`,
                  pointerEvents: 'none',
                }} />
                <div style={{
                  position: 'absolute',
                  left: 0, top: 0, bottom: 0,
                  width: 3,
                  background: lbl.color,
                  opacity: 0.9,
                }} />
                <div style={{
                  fontSize: 18,
                  lineHeight: 1,
                  flexShrink: 0,
                  marginTop: 1,
                  paddingLeft: 8,
                }}>
                  {lbl.emoji}
                </div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{
                      fontSize: '0.6rem',
                      fontWeight: 800,
                      letterSpacing: '0.08em',
                      color: lbl.color,
                      padding: '1px 6px',
                      borderRadius: 999,
                      backgroundColor: `${lbl.color}14`,
                      border: `1px solid ${lbl.color}55`,
                    }}>
                      {lbl.label}
                    </span>
                    <span style={{
                      fontSize: '0.833333rem', fontWeight: 800, color: 'var(--ink-strong)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: 1,
                    }} title={t.title}>
                      {t.title}
                    </span>
                  </div>
                  <div style={{
                    fontSize: '0.8rem',
                    color: 'var(--ink-muted)',
                    lineHeight: 1.5,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {bodyShort}
                  </div>
                  {t.action?.type === 'open-calendar' && (
                    <div style={{ marginTop: 2 }}>
                      <button
                        onClick={() => {
                          dismissToast(t.id);
                          // 同时做个保守动作：关闭 BobMail 弹层
                          closePopup();
                        }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          padding: '4px 10px',
                          border: `1px solid var(--info)`,
                          borderRadius: 4,
                          background: 'var(--info-soft)',
                          color: 'var(--info)',
                          cursor: 'pointer',
                          fontSize: '0.733333rem',
                          fontWeight: 700,
                        }}
                      >
                        <CalendarDays size={11} />
                        Open Calendar
                      </button>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => dismissToast(t.id)}
                  title="Dismiss"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 2,
                    color: 'var(--ink-faint)',
                    display: 'inline-flex',
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ink-muted)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ink-faint)'; }}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateY(-6px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes dosBlink {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0; }
        }
      `}</style>

    </>
  );
}
