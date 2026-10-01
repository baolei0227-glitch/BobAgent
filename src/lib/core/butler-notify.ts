/**
 * Butler 常驻「通知助理」会话（butler-notify.ts）
 *
 * 抽屉改成「微信式联系人」模型后，日程 / 每日报告 / 跨项目检查这类**系统推送类通知**
 * 需要一个可归属的常驻联系人：它既是联系人列里永远置顶的一行，也是左栏「详情」的合并入口
 * （待处理 / 已归档 + 批量选择 + 正文整套跟着它走）。
 *
 * 存储复用 Butler 线程（`.state/threads/`，见 lib/butler/threads.ts）：预留常驻 thread（NOTIFY_THREAD_ID），
 * source='notify'（永不过期），用户在这个联系人里追问 = 和普通线程一样的完整 Butler 能力。
 *
 * 通知本身仍存 inbox 行（done / read / items / dedupe_key 都在那里，Today 快照与角标依赖它），
 * 落库时补 thread_id = NOTIFY_THREAD_ID（见 /api/butler/inbox 的 POST 兜底）。
 *
 * 本模块 server-only（经 inbox 触达 better-sqlite3、经 threads 触达文件存储），仅供服务端路由引用。
 */
import { adoptInboxThread, listInboxByThread } from '@/lib/core/inbox';
import { readThread, upsertThread, type ButlerThreadSummary } from '@/lib/butler/threads';
import { NOTIFY_THREAD_ID, NOTIFY_TITLE } from '@/lib/butler/storage';

/** 常驻线程 ID / 显示名真源在 lib/butler/storage.ts（那里同时用它解析角色目录），此处再导出保持既有引用可用 */
export { NOTIFY_THREAD_ID, NOTIFY_TITLE };

/** 系统推送类通知：其余 kind 是用户主动操作的回执（只弹 toast 或归属各自会话），不进这个联系人。
 *  meeting（会议纪要 / 会议记录）由 meeting-finalize 直写 inbox、没有自己的会话，2026-09-27 并入本范围：
 *  否则它 thread_id 为空、既不属于任何联系人，又会被角标计入 → 「Bobby 没有未读项却亮着角标」。 */
const NOTIFY_KINDS = ['daily-report', 'calendar', 'inspect', 'meeting'];
const NOTIFY_KIND_SET = new Set(NOTIFY_KINDS);

export function isNotifyKind(kind: string): boolean {
  return NOTIFY_KIND_SET.has(kind);
}

/** 存量归位只做一次（进程内）：幂等但没必要每次列会话都跑一条 UPDATE */
let _adopted = false;

/**
 * 常驻会话不存在时建一条空行（幂等），并把**上线前落的**系统推送类通知划入该线程（一次性迁移）。
 * 列表接口与 GET ?threadId= 都先调它——否则「通知助理」在联系人列与详情入口会时有时无。
 */
export async function ensureButlerNotifySession(): Promise<void> {
  if (!_adopted) {
    _adopted = true;
    try {
      await adoptInboxThread(NOTIFY_KINDS, NOTIFY_THREAD_ID);
    } catch (e) {
      _adopted = false; // 失败下次重试（迁移是最佳努力，不能拖垮列表接口）
      console.warn('[butler-notify] 存量通知归位失败:', e instanceof Error ? e.message : String(e));
    }
  }
  if (await readThread(NOTIFY_THREAD_ID)) return;
  await upsertThread(NOTIFY_THREAD_ID, [], 'notify');
}

/**
 * 常驻联系人摘要（联系人列置顶行）。
 * 字段沿用 ButlerThreadSummary 语义：标题固定「通知助理」；副标题取最新一条**未归档**通知的标题
 * （没有未归档则取最新一条）；updatedAt 取「该线程最新通知」与「该线程消息更新时间」的较新者。
 * 不带角标：联系人行的未读角标由前端 store 现算（见 ButlerDrawer 的 unreadNoticesByThread），
 * 才能「点开那张卡片当场清零」——服务端算的话，本地点开后还要等一次往返才灭。
 */
export async function buildNotifySummary(): Promise<ButlerThreadSummary & { pinned: true }> {
  await ensureButlerNotifySession();
  const [session, rows] = await Promise.all([
    readThread(NOTIFY_THREAD_ID),
    listInboxByThread(NOTIFY_THREAD_ID, 200),
  ]);
  const newest = [...rows].sort((a, b) => b.time - a.time);
  const latest = newest.find((r) => !r.done) ?? newest[0] ?? null;
  const hasChats = (session?.messages.length ?? 0) > 0;
  return {
    threadId: NOTIFY_THREAD_ID,
    source: 'notify',
    lifecycle: session?.lifecycle ?? 'active',
    createdAt: session?.createdAt ?? Date.now(),
    // 只有追问过才让会话本身的时间参与（否则常驻行刚建出来的时间会把「最近一条通知的时间」顶掉）
    updatedAt: hasChats ? Math.max(session?.updatedAt ?? 0, latest?.time ?? 0) : latest?.time ?? session?.updatedAt ?? Date.now(),
    messageCount: session?.messages.length ?? 0,
    title: NOTIFY_TITLE,
    preview: latest?.title ?? '日程 / 待办 / 报告都会汇总到这里',
    // 会话级人设（与 chat_sessions 同行）：首次打开该联系人时据此判断是否需要引导用户设定性格
    persona: session?.persona ?? null,
    // 这一行的角标走「未读回执」（前端按 store 现算），不是会话消息口径 →
    // 摘要里恒为 0，避免同一行两个数字打架；回执未读仍会进悬浮球总数（见 lib/butler/today.ts）
    unread: 0,
    pinned: true,
    systemRole: 'notify',
  };
}