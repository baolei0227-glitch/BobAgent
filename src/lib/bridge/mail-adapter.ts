/**
 * 邮件感知适配器 —— 把一封邮件头**归一化**为 Butler 收件箱条目（2026-10-10 感知面 ①）
 *
 * 定位：与 `feishu-adapter.ts` 同层（协议/判定），但本文件**更纯**——不含任何 IO、网络、
 * 凭证或调度；判定逻辑必须能被单测直接遍历（见 `mail-adapter.test.ts`）。
 * IMAP 连接与落库在 `mail-poll.ts`，本文件只回答一个问题：
 *
 *   「这封邮件，是不是**别人主动找用户**、值得让 Butler 知道？」
 *
 * 判据（对齐工单 §二「是否直接给用户 / 是否需回复」）：
 *   - 是 → 返回条目（人工来信、客户/同事来邮、含待办的业务邮件）；
 *   - 否 → 返回 null（**营销 / 邮件列表 / 系统退信 / 自动回复 / 通知水军**）。
 *
 * 为什么要拦：Butler 的价值是「先知道，再决定说不说」。若把 newsletter 与退信也灌进收件箱，
 * 用户每天会被几十条噪音淹没，反而比「自己讲一遍」更烦——所以**误收比漏收更贵**，判据宁严勿宽。
 */

import type { ButlerNoticeItem } from '@/lib/bus';

/** 幂等键前缀：`mail:<Message-ID>`（全局唯一，供 inbox dedupeKey 使用） */
export const MAIL_DEDUPE_PREFIX = 'mail:';

/** IMAP 侧取回的最小邮件活动：**只取信封级字段**（不下载正文，省流量也少碰隐私正文） */
export interface RawMailActivity {
  /** Message-ID 头（已去尖括号）；缺失时由 from+subject+receivedAt 合成一个稳定键 */
  messageId?: string;
  /** From 头原文，形如 `Zhang San <zhang@example.com>`；为空 → 无法归属，直接判不合格 */
  from: string;
  /** Subject 头原文（可为空串） */
  subject: string;
  /** 服务器投递时刻（ms；取 IMAP INTERNALDATE，跨次拉取稳定） */
  receivedAt: number;
  /** 纯文本摘要（可空；仅用于通知正文，不参与判定） */
  snippet?: string;
  /** 是否带 List-Unsubscribe 头（邮件列表 / 营销的强信号） */
  hasListUnsubscribe?: boolean;
  /** Precedence 头（bulk / junk / list） */
  precedence?: string;
  /** Auto-Submitted 头（auto-replied / auto-generated） */
  autoSubmitted?: string;
}

/**
 * 非人类发件人的 local part（@ 前那段）——命中即视为「机器发的，不需回复」。
 *
 * 只放**强信号**词：noreply 家族、退信角色信箱、通知/营销专用信箱。
 * 刻意**不**放 info@ / support@ / admin@ 之类——这些常是真人或真人轮值的业务信箱，
 * 误拦会丢真实来信（宁漏勿错的另一面：这类宁可让用户看到）。
 */
const NON_HUMAN_SENDER_RE =
  /^(no-?reply|donot-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|bounces|notifications?|newsletter|newsletters|marketing|subscribe|no_reply|automated|auto-?confirm)/i;

/** 系统退信 / 投递失败类主题——机器产物，收件箱不该出现 */
const BOUNCE_SUBJECT_RE =
  /(undeliverable|undelivered mail|delivery status notification|delivery has failed|mail delivery (failed|subsystem)|returned mail|failure notice|退信|投递失败|邮件投递失败|无法投递)/i;

/** 自动回复 / 假期回复类主题——「我不在办公室」不是需要 Butler 提醒的事 */
const AUTO_REPLY_SUBJECT_RE = /(out of office|auto[- ]?reply|automatic reply|autoresponse|自动回复|自动回覆|离开办公室|休假回复)/i;

/** 从 `Name <addr@host>` 里抠出地址；抠不到则原样返回（可能是裸地址） */
export function extractAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim().toLowerCase();
}

/** local part（@ 前那段）；无 @ 时返回整串 */
function localPart(address: string): string {
  const at = address.indexOf('@');
  return at > 0 ? address.slice(0, at) : address;
}

/**
 * 该发件地址是否「非人类」（noreply / mailer-daemon / newsletter…）。
 * 导出供 `mail-poll.ts` 日志与测试复用（同一口径，避免两处各写一份正则）。
 */
export function isNonHumanSender(from: string): boolean {
  return NON_HUMAN_SENDER_RE.test(localPart(extractAddress(from)));
}

/** 本地时区 `MM/DD HH:mm`（与 event-reminder 的展示口径一致，便于收件箱内视觉统一） */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 邮件活动的**幂等键**：`mail:<Message-ID>`（缺失 Message-ID 时按 from+subject+receivedAt 合成）。
 *
 * 合成的兜底键在「同一封邮件被反复拉取」时保持稳定（receivedAt 取服务器 INTERNALDATE，
 * 不随本地时钟漂移），故仍能走 `inbox.dedupeKey` 的全局唯一去重路径。
 */
export function mailDedupeKey(raw: RawMailActivity): string {
  const id =
    (raw.messageId ?? '').trim().replace(/^<|>$/g, '') ||
    `${extractAddress(raw.from)}|${(raw.subject ?? '').trim()}|${raw.receivedAt}`;
  return `${MAIL_DEDUPE_PREFIX}${id}`;
}

/**
 * 归一化一封邮件为收件箱条目；判定为「不需要用户知道」时返回 null。
 *
 * 判 null 的顺序（**先机械信号，后角色信号**，越机械越可靠）：
 *   ① 无发件人            → null（无法归属，无法回复）
 *   ② Auto-Submitted 头   → null（auto-replied / auto-generated，机器自动发）
 *   ③ List-Unsubscribe 头 → null（邮件列表 / 营销的标准退订头）
 *   ④ Precedence 头       → null（bulk / junk / list）
 *   ⑤ 退信 / 自动回复主题 → null
 *   ⑥ 非人类发件人        → null（noreply / mailer-daemon / newsletter…）
 *   其余 → 合格条目。
 */
export function normalizeMailActivity(raw: RawMailActivity): ButlerNoticeItem | null {
  const from = (raw.from ?? '').trim();
  if (!from) return null;

  const auto = (raw.autoSubmitted ?? '').trim().toLowerCase();
  if (auto.startsWith('auto-')) return null; // auto-replied / auto-generated

  if (raw.hasListUnsubscribe) return null;

  const prec = (raw.precedence ?? '').trim().toLowerCase();
  if (prec === 'bulk' || prec === 'junk' || prec === 'list') return null;

  const subject = (raw.subject ?? '').trim();
  if (BOUNCE_SUBJECT_RE.test(subject)) return null;
  if (AUTO_REPLY_SUBJECT_RE.test(subject)) return null;

  if (isNonHumanSender(from)) return null;

  const receivedAt = Number.isFinite(raw.receivedAt) ? raw.receivedAt : Date.now();
  return {
    key: mailDedupeKey(raw),
    title: subject || '(no subject)',
    time: fmtTime(receivedAt),
    startMs: receivedAt,
  };
}
