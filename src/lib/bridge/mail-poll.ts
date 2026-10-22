/**
 * 邮件感知层 —— IMAP 后台拉取 + 收件箱落库 + 外部通道播报（2026-10-10 感知面 ①）
 *
 * 职责（**只做编排**，判定在 `mail-adapter.ts`、落库在 `lib/core/inbox.ts`、出站在 `lib/core/push-out.ts`）：
 *   1. 从设置读邮箱凭证（`AppSettings.mail`，通用 IMAP 手填；未配置 → 静默 idle，不建连不报错）；
 *   2. 常驻 IMAP 连接**复用**（不每轮重登 —— 163 / QQ 等对频繁登录会限流），按水位线增量拉新邮件；
 *   3. 用 `normalizeMailActivity` 过滤掉营销 / 退信 / 自动回复，合格邮件写 Butler 收件箱；
 *   4. 同一轮的多封合并成**一条**外发（走 `pushToBridges(text,'report')`，免打扰/单日上限由出站口统一裁决）。
 *
 * 为什么**自带调度器**：`eslint import/no-cycle` 把动态 `import()` 也算依赖边。本模块静态依赖
 * `lib/core/*` 与 `lib/butler/storage`，若反过来被 core/butler 引用就会成环 —— 故调度器长在这里、
 * 由 `src/instrumentation.ts` 在启动时拉起（与 `event-reminder` / `evening-report` 同形）。
 *
 * 幂等与水位线（两道保险）：
 *   - `inbox.dedupeKey = mail:<Message-ID>`（全局唯一）——重复投递同一封邮件不会产生第二条；
 *   - 状态文件 `butler/.state/mail-poll.json` 记录 `{ uidValidity, lastUid }` 水位线 —— **避免
 *     同一封未读邮件在每个轮询周期都被重新外发**（我们不设置 \Seen，不改动用户邮箱）。
 *     首次运行（或 UIDVALIDITY 变化）只做**基线**：记下当前最大 UID、不播报存量，防止把邮箱里
 *     几百封历史未读一次性倒给用户。
 *
 * 隐私边界（对齐工单 §七）：只取**信封级字段**（发件人 / 主题 / 时间 / 三个判定用头），
 * 不下载正文、不写回邮箱、不动已读状态；他人私聊类内容不涉及。
 */
import { join } from 'path';
import { promises as fs } from 'fs';
import { STATE_DIR, NOTIFY_THREAD_ID } from '@/lib/butler/storage';
import { normalizeMailActivity, type RawMailActivity } from './mail-adapter';

/** 模块级状态（供 context.ts 的可见源注入读取；与桥同款同步 getStatus，不触发任何取数） */
export interface MailStatus {
  /** 调度器是否在运行（已启动且未空转） */
  running: boolean;
  /** 是否已配置凭证（未配置 = 未接入） */
  bound: boolean;
  /** 最近一轮未读命中数（展示用，非精确） */
  unreadCount: number;
  lastError?: string;
}

/** 邮箱凭证（来自设置 `AppSettings.mail`；无 SMTP —— 对外代发属「手」，本期不做） */
interface MailCredentials {
  address: string;
  password: string;
  imapHost: string;
  imapPort: number;
}

const POLL_INTERVAL_MS = 120_000;
const STATE_FILE = join(STATE_DIR, 'mail-poll.json');

/** 拉取时请求的邮件头（判定所需的全部信号；不请求正文） */
const WANTED_HEADERS = ['list-unsubscribe', 'precedence', 'auto-submitted'];

interface MailPollState {
  /** IMAP UIDVALIDITY：变化即水位线失效，需重新基线 */
  uidValidity: number;
  /** 已处理到的最大 UID：只拉 uid > lastUid 的邮件 */
  lastUid: number;
}

/** globalThis 单例 —— Turbopack 会把 instrumentation 与 route handler 编译成不同 chunk，
 *  模块级变量会各自实例化；挂到 globalThis 才能让 context.ts 读到调度器写入的真实状态。 */
interface MailPollSingleton {
  started: boolean;
  status: MailStatus;
  client: unknown | null;
  clientKey: string;
}
declare global {
  // eslint-disable-next-line no-var
  var __mailPollSingleton__: MailPollSingleton | undefined;
}

function singleton(): MailPollSingleton {
  return (globalThis.__mailPollSingleton__ ??= {
    started: false,
    status: { running: false, bound: false, unreadCount: 0 },
    client: null,
    clientKey: '',
  });
}

/** 同步状态查询（context.ts 的可见源注入用；与 wechat/feishu 桥的 getStatus 同款，零 IO） */
export function getMailStatus(): MailStatus {
  const s = singleton().status;
  return { running: s.running, bound: s.bound, unreadCount: s.unreadCount, lastError: s.lastError };
}

// ============================================================
// 凭证
// ============================================================

/** 从 `.settings.json` 读邮箱凭证；缺任一必填项返回 null（= 未接入，调用方静默降级） */
async function loadMailCredentials(): Promise<MailCredentials | null> {
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const s = await readSettingsFromFile();
    const m = s.mail;
    const address = (m?.address ?? '').trim();
    const password = (m?.password ?? '').trim();
    const imapHost = (m?.imapHost ?? '').trim();
    if (!address || !password || !imapHost) return null;
    const port = Number(m?.imapPort);
    return { address, password, imapHost, imapPort: Number.isFinite(port) && port > 0 ? port : 993 };
  } catch (e) {
    console.warn('[mail-poll] 读取邮箱凭证失败:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

// ============================================================
// 水位线状态
// ============================================================

async function readState(): Promise<MailPollState | null> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MailPollState>;
    if (typeof parsed?.uidValidity !== 'number' || typeof parsed?.lastUid !== 'number') return null;
    return { uidValidity: parsed.uidValidity, lastUid: parsed.lastUid };
  } catch {
    return null;
  }
}

async function writeState(state: MailPollState): Promise<void> {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state), 'utf-8');
  } catch (e) {
    console.warn('[mail-poll] 写入水位线失败:', e instanceof Error ? e.message : String(e));
  }
}

// ============================================================
// 邮件头解析（imapflow 把请求的头拼成一段原始 Buffer）
// ============================================================

function headerBlock(buf: unknown): string {
  if (Buffer.isBuffer(buf)) return buf.toString('utf-8');
  return typeof buf === 'string' ? buf : '';
}

function hasHeader(block: string, name: string): boolean {
  return new RegExp(`^${name}:`, 'im').test(block);
}

function getHeader(block: string, name: string): string {
  const m = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(block);
  return m ? m[1].trim() : '';
}

/** 信封发件人 → `Name <addr>`；无 name 时只给地址 */
function formatFrom(from: unknown): string {
  const list = Array.isArray(from) ? from : [];
  const first = list[0] as { name?: string; address?: string } | undefined;
  if (!first) return '';
  const addr = (first.address ?? '').trim();
  const name = (first.name ?? '').trim();
  return name ? `${name} <${addr}>` : addr;
}

// ============================================================
// 单轮拉取
// ============================================================

/** 该轮拉到的合格邮件（供落库 + 外发） */
interface EligibleMail {
  item: NonNullable<ReturnType<typeof normalizeMailActivity>>;
  from: string;
}

/**
 * 执行一轮：连接（复用） → 增量搜索未读 → 落库 → 合并外发。
 * 返回本轮**新增**的合格邮件数；未配置凭证返回 0 且不建连。
 */
export async function pollMailOnce(): Promise<number> {
  const singletonRef = singleton();
  const creds = await loadMailCredentials();
  if (!creds) {
    singletonRef.status.bound = false;
    singletonRef.status.unreadCount = 0;
    return 0;
  }
  singletonRef.status.bound = true;

  // 凭证变化（换邮箱 / 改主机）→ 丢弃旧连接，避免拿旧账号继续拉
  const key = `${creds.imapHost}:${creds.imapPort}:${creds.address}`;
  if (singletonRef.client && singletonRef.clientKey !== key) {
    await closeClient(singletonRef);
  }
  const client = await ensureClient(singletonRef, creds, key);
  if (!client) return 0;

  let lock: { release: () => void } | null = null;
  try {
    lock = await client.getMailboxLock('INBOX');
    const uidValidity = Number(client.mailbox?.uidValidity) || 0;
    const uidNext = Number(client.mailbox?.uidNext) || 1;
    const maxUid = Math.max(0, uidNext - 1);

    const state = await readState();
    // 首次运行 / UIDVALIDITY 变化 → 只做基线，不播报存量（防历史未读一次性倒给用户）
    if (!state || state.uidValidity !== uidValidity) {
      await writeState({ uidValidity, lastUid: maxUid });
      singletonRef.status.unreadCount = 0;
      console.log(
        `[mail-poll] 建立水位线基线（uidValidity=${uidValidity}, lastUid=${maxUid}）—— 存量邮件不播报，此后仅增量`,
      );
      return 0;
    }

    const range = state.lastUid + 1;
    // 只取「未读 + 水位线之后」的新邮件；我们不设置 \Seen，故未读状态由用户邮箱自己决定
    const found = await client.search({ seen: false, uid: `${range}:*` }, { uid: true });
    const uids = (Array.isArray(found) ? found : []).filter((u) => typeof u === 'number' && u >= range);
    if (uids.length === 0) {
      singletonRef.status.unreadCount = 0;
      return 0;
    }

    const eligible: EligibleMail[] = [];
    let maxSeenUid = state.lastUid;
    for await (const msg of client.fetch(uids, { envelope: true, internalDate: true, headers: WANTED_HEADERS }, { uid: true })) {
      maxSeenUid = Math.max(maxSeenUid, Number(msg.uid) || 0);
      const envelope = (msg.envelope ?? {}) as { messageId?: string; subject?: string; from?: unknown };
      const block = headerBlock(msg.headers);
      const receivedAt = msg.internalDate instanceof Date ? msg.internalDate.getTime() : Date.now();
      const raw: RawMailActivity = {
        messageId: envelope.messageId,
        from: formatFrom(envelope.from),
        subject: typeof envelope.subject === 'string' ? envelope.subject : '',
        receivedAt,
        hasListUnsubscribe: hasHeader(block, 'list-unsubscribe'),
        precedence: getHeader(block, 'precedence'),
        autoSubmitted: getHeader(block, 'auto-submitted'),
      };
      const item = normalizeMailActivity(raw);
      if (item) eligible.push({ item, from: raw.from });
    }

    singletonRef.status.unreadCount = eligible.length;

    if (eligible.length > 0) {
      await archiveEligible(eligible);
      await announce(eligible);
    }

    // 水位线推进放在处理之后：中途失败则下轮重拉，靠 dedupeKey 兜住重复落库
    await writeState({ uidValidity, lastUid: maxSeenUid });
    return eligible.length;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    singletonRef.status.lastError = message;
    console.warn('[mail-poll] 拉取失败:', message);
    // 连接可能已损坏：丢弃，下轮重连
    await closeClient(singletonRef);
    return 0;
  } finally {
    lock?.release();
  }
}

/** 合格邮件落 Butler 收件箱（幂等：dedupeKey = mail:<Message-ID>） */
async function archiveEligible(eligible: EligibleMail[]): Promise<void> {
  try {
    const { insertInbox } = await import('@/lib/core/inbox');
    for (const { item, from } of eligible) {
      await insertInbox({
        kind: 'mail',
        title: item.title,
        body: `${from} · ${item.time}`,
        items: [item],
        source: 'mail',
        threadId: NOTIFY_THREAD_ID,
        dedupeKey: item.key,
        time: item.startMs,
      });
    }
  } catch (e) {
    console.warn('[mail-poll] 写入收件箱失败:', e instanceof Error ? e.message : String(e));
  }
}

/**
 * 把本轮合格邮件交给「神经」（`lib/core/push-policy.ts`）——由它按窗口折叠成一条 digest 再出站。
 *
 * 2026-10-10（② 事件驱动主动性）：此前本模块自己拼文案直投 `pushToBridges`；改为**只上报事件**
 * （title = 主题、detail = 发件人），推不推 / 推几条 / 是否被免打扰静默，全部交给折叠层与
 * 统一出站口。好处：邮件源与后续其它感知源的事件能在同一窗口内**合并**，且裁决口径只有一处。
 * 收件箱落库（`archiveEligible`）与本调用相互独立 —— 被静默 ≠ 丢内容。
 */
async function announce(eligible: EligibleMail[]): Promise<void> {
  try {
    const { enqueueButlerEvents } = await import('@/lib/core/push-policy');
    enqueueButlerEvents(
      eligible.map((e) => ({
        kind: 'report' as const,
        group: '📧 New mail',
        title: e.item.title,
        detail: e.from,
        at: e.item.startMs,
      })),
    );
  } catch (e) {
    console.warn('[mail-poll] 上报播报事件失败:', e instanceof Error ? e.message : String(e));
  }
}

// ============================================================
// IMAP 连接生命周期（复用连接，失败即丢弃重连）
// ============================================================

/** 连接类型别名：只用到的几个成员，避免把 imapflow 的完整类型带进签名 */
interface MinimalImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  getMailboxLock(path: string): Promise<{ release: () => void }>;
  search(query: Record<string, unknown>, options?: { uid?: boolean }): Promise<unknown>;
  fetch(range: unknown, query: Record<string, unknown>, options?: { uid?: boolean }): AsyncIterable<{
    uid?: number;
    envelope?: unknown;
    internalDate?: Date;
    headers?: unknown;
  }>;
  mailbox?: { uidValidity?: number; uidNext?: number };
  usable?: boolean;
}

async function ensureClient(
  ref: MailPollSingleton,
  creds: MailCredentials,
  key: string,
): Promise<MinimalImapClient | null> {
  const existing = ref.client as MinimalImapClient | null;
  if (existing && ref.clientKey === key && existing.usable) return existing;
  if (existing) await closeClient(ref);

  try {
    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({
      host: creds.imapHost,
      port: creds.imapPort,
      secure: true,
      auth: { user: creds.address, pass: creds.password },
      // 关掉库自身的日志噪声（默认会打印完整 IMAP 交互）
      logger: false,
    }) as unknown as MinimalImapClient;
    await client.connect();
    ref.client = client;
    ref.clientKey = key;
    ref.status.lastError = undefined;
    return client;
  } catch (e) {
    ref.status.lastError = e instanceof Error ? e.message : String(e);
    console.warn('[mail-poll] IMAP 连接失败:', ref.status.lastError);
    return null;
  }
}

async function closeClient(ref: MailPollSingleton): Promise<void> {
  const client = ref.client as MinimalImapClient | null;
  ref.client = null;
  ref.clientKey = '';
  if (!client) return;
  try {
    await client.logout();
  } catch {
    try {
      client.close();
    } catch { /* 已断开，忽略 */ }
  }
}

// ============================================================
// 调度器（instrumentation.ts 启动，幂等）
// ============================================================

const RUNNING_KEY = '__mailPollRunning__';

/**
 * 启动邮件调度：立即执行一轮（拿到首轮状态 / 建立基线），此后每 `POLL_INTERVAL_MS` 一轮。
 * 幂等；未配置凭证时每轮读一次设置，一旦用户在设置里填好即自动开始工作（无需重启）。
 */
export function startMailScheduler(): void {
  const ref = singleton();
  if (ref.started) return;
  ref.started = true;
  ref.status.running = true;

  const tick = () => {
    void pollMailOnce().catch((e) => {
      console.error('[mail-poll] 轮询异常:', e instanceof Error ? e.message : String(e));
    });
  };
  tick();

  const g = globalThis as unknown as { [RUNNING_KEY]?: boolean };
  if (g[RUNNING_KEY]) return;
  g[RUNNING_KEY] = true;
  const loop = () => {
    setTimeout(() => {
      tick();
      loop();
    }, POLL_INTERVAL_MS);
  };
  loop();

  console.log(`[mail-poll] 邮件感知调度已启动（每 ${POLL_INTERVAL_MS / 1000}s 拉取一次未读）`);
}
