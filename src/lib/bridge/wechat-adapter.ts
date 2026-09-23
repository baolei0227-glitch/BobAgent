/**
 * 微信 iLink 协议适配器
 *
 * 基于《微信 iLink 桥接架构笔记》移植（HanaAgent server bundle 反推骨架）：
 *   - QR 绑定状态机：wait → scaned → confirmed / expired，40s 长轮询 + 2s 间隔
 *   - 长轮询收消息：get_updates_buf 双向游标，增量拉取、防重放
 *   - 错误码哨兵：errcode=-14 会话失效，停止轮询、不自动重登
 *   - 退避重试：[2s, 5s, 30s] × 3，AbortError(超时) 与真实错误区分
 *   - 凭证持久化：botToken 独立文件 0600，启动校验存在则跳过扫码恢复会话
 *
 * 设计原则：上层只看到 sendReply / sendMedia / sendTypingIndicator，
 * 协议细节全部封死在本文件内。更换平台时只替换 adapter。
 */
import { readFile, writeFile, mkdir, access, chmod, unlink } from 'fs/promises';
import { join, extname } from 'path';
import { homedir } from 'os';
import { randomBytes, randomUUID } from 'crypto';

const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3'; // 个人号
const CHANNEL_VERSION = '1.0.0';
const LONG_POLL_TIMEOUT = 40_000; // 单次长轮询上限
const POLL_INTERVAL = 2_000; // 轮询扫码状态间隔
const BACKOFF = [2_000, 5_000, 30_000]; // 退避序列
const MAX_CONSECUTIVE_FAILURES = 3;
const BATCH_CHAR_LIMIT = 4000; // 单条消息长度上限

/** iLink 媒体类型 */
export const ILINK_MSG_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

/** 适配器能力自描述（Bridge 据此做能力协商，而非硬编码） */
export interface AdapterCapabilities {
  platform: 'wechat';
  media: {
    text: boolean;
    image: boolean;
    voice: boolean;
    file: boolean;
    video: boolean;
  };
}

/** 入站媒体信息（图片/语音/文件/视频）：含原始下载地址与元信息 */
export interface InboundMedia {
  type: number; // ILINK_MSG_TYPE
  downloadUrl: string;
  fileName?: string;
  fileType?: string; // 协议内 file_type 字符串（如有）
  fileSize?: number;
  raw: unknown;
}

/** 收到的消息（已解析的纯文本形态，媒体降级为元信息） */
export interface InboundMessage {
  /** 服务端消息唯一 id（存在时优先用于幂等去重；不同网关字段名不同，兼容提取） */
  id?: string;
  from: string;
  text: string;
  mediaType: number | null; // ILINK_MSG_TYPE 或 null
  /** 首个非文本媒体的完整下载/元信息（入站媒体处理用） */
  media?: InboundMedia;
  contextToken: string; // 回复必须带，维持会话
  raw: unknown;
}

/** 会话凭证 */
export interface WechatCredentials {
  botToken: string;
  botId: string;
  userId: string;
  baseUrl?: string;
  /** 首次消息欢迎语是否已发送（持久化，重启不重复） */
  welcomeSent?: boolean;
  /** get_updates_buf 游标：上次拉到的最新位置；重启续拉避免丢消息 */
  lastCursor?: string;
}

export type QrStatus = 'waiting' | 'scanned' | 'confirmed' | 'expired';

export interface QrPollResult {
  status: QrStatus;
  credentials?: WechatCredentials;
}

/** get_qrcode_status 原始响应（iLink 字段原样，未归一化） */
interface QrStatusResponse {
  status?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
}

// ============================================================
// 凭证存储
// ============================================================

/** 凭证文件：~/BobWork/.wechat-credentials.json（0600） */
function credentialsPath(): string {
  const env = (process.env.BOBWORK_HOME || '').trim();
  const root = env && env.startsWith('/') ? env : join(homedir(), 'BobWork');
  return join(root, '.wechat-credentials.json');
}

/** 读取凭证；不存在返回 null */
export async function loadCredentials(): Promise<WechatCredentials | null> {
  try {
    const raw = await readFile(credentialsPath(), 'utf-8');
    const data = JSON.parse(raw);
    if (!data?.botToken) return null;
    return {
      botToken: data.botToken,
      botId: data.botId,
      userId: data.userId,
      baseUrl: data.baseUrl,
      welcomeSent: !!data.welcomeSent,
      lastCursor: typeof data.lastCursor === 'string' ? data.lastCursor : undefined,
    };
  } catch {
    return null;
  }
}

/** 保存凭证（0600，先写临时文件再 rename） */
export async function saveCredentials(creds: WechatCredentials): Promise<void> {
  const path = credentialsPath();
  const dir = path.substring(0, path.lastIndexOf('/'));
  try {
    await access(dir);
  } catch {
    await mkdir(dir, { recursive: true });
  }
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(creds, null, 2), 'utf-8');
  await chmod(tmp, 0o600);
  await import('fs/promises').then((fs) => fs.rename(tmp, path));
}

/** 清除凭证（解绑） */
export async function clearCredentials(): Promise<void> {
  try {
    await import('fs/promises').then((fs) => fs.unlink(credentialsPath()));
  } catch { /* 不存在则忽略 */ }
}

// ============================================================
// 请求封装
// ============================================================

/** 每次请求随机 4 字节 base64，匿名标识 */
function randomUin(): string {
  return randomBytes(4).toString('base64');
}

function authedHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomUin(),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/** iLink 会话失效哨兵：errcode=-14 */
function isSessionExpired(err: unknown): boolean {
  return /(?:ret|errcode)=-14\b/.test(String(err instanceof Error ? err.message : err));
}

/** POST 到 iLink API，支持超时 */
async function apiPost<T = unknown>(
  path: string,
  body: unknown,
  token?: string,
  timeout = LONG_POLL_TIMEOUT,
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const resp = await fetch(`${ILINK_BASE}${path}`, {
      method: 'POST',
      headers: authedHeaders(token),
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!resp.ok) {
      throw new Error(`iLink HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`);
    }
    return (await resp.json()) as T;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('ABORT');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// 绑定：扫码 + QR 状态机
// ============================================================

export interface QrCodeData {
  qrcodeId: string;
  qrcodeUrl: string; // dataURL，直接渲染
}

/** ① 取二维码（服务端转 dataURL，客户端零依赖渲染） */
export async function getQrcode(): Promise<QrCodeData> {
  const data = await apiPost<{ qrcode?: string; qrcode_img_content?: string }>(
    `/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
    {},
    undefined,
    15_000,
  );
  if (!data.qrcode) throw new Error('服务器未返回二维码');
  const qrcodeUrl = data.qrcode_img_content
    ? await toQrcodeUrl(data.qrcode_img_content)
    : '';
  return { qrcodeId: data.qrcode, qrcodeUrl };
}

/** ② 单次查询扫码状态（40s 长轮询，超时静默返回 waiting） */
export async function pollQrStatus(qrcodeId: string): Promise<QrPollResult> {
  let res: QrStatusResponse;
  try {
    res = await apiPost<QrStatusResponse>(
      `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`,
      {},
      undefined,
      LONG_POLL_TIMEOUT,
    );
  } catch (e) {
    if (e instanceof Error && e.message === 'ABORT') {
      return { status: 'waiting' }; // 超时不算失败，继续轮
    }
    throw e;
  }

  switch (res?.status) {
    case 'wait':
      return { status: 'waiting' };
    case 'scaned':
      return { status: 'scanned' };
    case 'confirmed':
      if (!res.bot_token || !res.ilink_bot_id) {
        throw new Error('登录成功但未返回凭证');
      }
      return {
        status: 'confirmed',
        credentials: {
          botToken: res.bot_token,
          botId: res.ilink_bot_id,
          userId: res.ilink_user_id || '',
          baseUrl: res.baseurl,
        },
      };
    case 'expired':
      return { status: 'expired' };
    default:
      return { status: 'waiting' };
  }
}

/**
 * 持续轮询扫码状态直到 confirmed / expired。
 * 在扫码完成前返回，供 Bridge 驱动 UI 展示。
 */
export async function waitForScan(
  qrcodeId: string,
  onStatus?: (status: QrStatus) => void,
): Promise<QrPollResult> {
  // 轮询最多 120s（二维码有效期通常 2 分钟）
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await pollQrStatus(qrcodeId);
    onStatus?.(result.status);
    if (result.status === 'confirmed' || result.status === 'expired') {
      return result;
    }
    await sleep(POLL_INTERVAL);
  }
  return { status: 'expired' };
}

// ============================================================
// 消息收发：长轮询 + 游标
// ============================================================

/** iLink 入站消息中的媒体载荷（字段名随网关/类型而异，做兼容提取） */
interface IlinkRawMediaPayload {
  download_url?: string;
  downloadUrl?: string;
  url?: string;
  media_url?: string;
  resource_url?: string;
  file_name?: string;
  name?: string;
  file_type?: string;
  file_size?: number;
  size?: number;
}

/** iLink 入站消息中的 item（文本/媒体等） */
interface IlinkRawItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: IlinkRawMediaPayload;
  voice_item?: IlinkRawMediaPayload;
  file_item?: IlinkRawMediaPayload;
  video_item?: IlinkRawMediaPayload;
}

/** iLink getupdates 返回的单条原始消息 */
interface IlinkRawMessage {
  from_user_id?: string;
  item_list?: IlinkRawItem[];
  message_id?: string;
  msg_id?: string;
  msgid?: string;
  id?: string;
  client_msg_id?: string;
  client_id?: string;
  context_token?: string;
}

interface GetUpdatesResponse {
  get_updates_buf?: string;
  msgs?: IlinkRawMessage[];
}

/**
 * 收消息轮询循环。
 * @param getUpdatesBuf 初始游标（断点续拉），0 = 从最新开始
 * @param handleMessage 每收到一条消息调用一次
 * @param shouldStop 返回 true 停止（如会话失效或手动停止）
 * @param onCursorUpdate 每拿到服务端新 cursor 时调用（用于持久化，避免重启丢消息）
 * @returns 退出原因：'session-expired' | 'stopped' | 'fatal' | 'no-cred' | 'error'
 */
export async function pollLoop(
  creds: WechatCredentials,
  getUpdatesBuf: string,
  handleMessage: (msg: InboundMessage) => void,
  shouldStop?: () => boolean,
  onCursorUpdate?: (cursor: string) => void,
): Promise<'session-expired' | 'stopped' | 'fatal' | 'no-cred' | 'error'> {
  if (!creds.botToken) return 'no-cred';

  let cursor = getUpdatesBuf;
  let failures = 0;

  while (true) {
    if (shouldStop?.()) return 'stopped';
    try {
      const data = await apiPost<GetUpdatesResponse>(
        '/ilink/bot/getupdates',
        {
          get_updates_buf: cursor,
          base_info: { channel_version: CHANNEL_VERSION },
        },
        creds.botToken,
        LONG_POLL_TIMEOUT,
      );

      failures = 0;
      if (data.get_updates_buf && data.get_updates_buf !== cursor) {
        cursor = data.get_updates_buf;
        try { onCursorUpdate?.(cursor); } catch { /* 持久化失败不阻塞收消息 */ }
      }

      for (const msg of data.msgs ?? []) {
        try {
          const parsed = parseInbound(msg);
          if (parsed) handleMessage(parsed);
        } catch {
          // 单条解析失败不中断循环
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'ABORT') continue; // 长轮询超时，正常
      if (isSessionExpired(e)) return 'session-expired';
      if (++failures >= MAX_CONSECUTIVE_FAILURES) {
        console.error('[wechat-adapter] 连续失败，退出轮询:', e);
        return 'error';
      }
      await sleep(BACKOFF[Math.min(failures - 1, BACKOFF.length - 1)]);
    }
  }
}

/** 解析入站消息：提取文本、跳过 bot 自身、缓存 context_token */
function parseInbound(msg: IlinkRawMessage): InboundMessage | null {
  const from = String(msg?.from_user_id ?? '');
  if (!from || from.endsWith('@im.bot')) return null; // 跳过 bot 自己

  const text =
    (msg?.item_list ?? [])
      .filter((i) => i?.type === ILINK_MSG_TYPE.TEXT)
      .map((i) => i?.text_item?.text ?? '')
      .join('') ?? '';

  // 提取媒体类型（非文本 item）与下载/元信息
  const mediaItem = (msg?.item_list ?? []).find((i) => i?.type && i.type !== ILINK_MSG_TYPE.TEXT);
  const mediaType = mediaItem?.type ?? null;
  let media: InboundMedia | undefined;
  if (mediaItem && typeof mediaItem.type === 'number') {
    const type = mediaItem.type;
    const key =
      type === ILINK_MSG_TYPE.IMAGE ? 'image_item'
        : type === ILINK_MSG_TYPE.VOICE ? 'voice_item'
          : type === ILINK_MSG_TYPE.FILE ? 'file_item'
            : type === ILINK_MSG_TYPE.VIDEO ? 'video_item'
              : null;
    const payload = key ? mediaItem[key] : null;
    const url =
      payload?.download_url || payload?.downloadUrl || payload?.url || payload?.media_url
        || payload?.resource_url || '';
    if (url) {
      media = {
        type,
        downloadUrl: url,
        fileName: payload?.file_name ?? payload?.name ?? undefined,
        fileType: typeof payload?.file_type === 'string' ? payload.file_type : undefined,
        fileSize: typeof payload?.file_size === 'number' ? payload.file_size
          : typeof payload?.size === 'number' ? payload.size : undefined,
        raw: mediaItem,
      };
    }
  }

  return {
    // 多字段兼容提取服务端消息唯一 id；无 id 时 undefined，由上层走内容签名兜底
    id:
      (msg?.message_id as string | undefined)
      ?? (msg?.msg_id as string | undefined)
      ?? (msg?.msgid as string | undefined)
      ?? (msg?.id as string | undefined)
      ?? (msg?.client_msg_id as string | undefined)
      ?? (msg?.client_id as string | undefined)
      ?? undefined,
    from,
    text,
    mediaType: text ? null : mediaType, // 有文本则忽略媒体标记（纯媒体分支不触发）
    media,
    contextToken: String(msg?.context_token ?? ''),
    raw: msg,
  };
}

/** 构造回复消息 items（文本，4000 字符切片） */
export function buildTextItems(text: string): Array<{ type: number; text_item: { text: string } }> {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += BATCH_CHAR_LIMIT) {
    chunks.push(text.slice(i, i + BATCH_CHAR_LIMIT));
  }
  return chunks.map((chunk) => ({
    type: ILINK_MSG_TYPE.TEXT,
    text_item: { text: chunk },
  }));
}

/** 发消息（batch：按 4000 字符切片，一次发完更稳） */
export async function sendMessage(
  creds: WechatCredentials,
  toUser: string,
  text: string,
  contextToken: string,
): Promise<void> {
  const items = buildTextItems(text);
  for (const item of items) {
    await apiPost(
      '/ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: toUser,
          client_id: randomUUID(),
          message_type: 2, // BOT
          message_state: 2, // FINISH
          item_list: [item],
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      },
      creds.botToken,
      15_000,
    );
  }
}

/** 发送 typing 指示（1 开始 / 2 取消） */
export async function sendTypingIndicator(
  creds: WechatCredentials,
  toUser: string,
  status: 1 | 2,
): Promise<void> {
  try {
    await apiPost(
      '/ilink/bot/sendtyping',
      {
        to_user_id: toUser,
        status,
        base_info: { channel_version: CHANNEL_VERSION },
      },
      creds.botToken,
      10_000,
    );
  } catch {
    // typing 失败不阻塞主流程
  }
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 将 iLink 返回的二维码内容转为可渲染的 dataURL / URL：
 * - base64 图片数据 → 补全 data: 前缀直接使用
 * - HTTP(S) 链接（iLink 返回的是 liteapp 扫码页 URL）→ 用 qrcode 库编码为二维码图
 */
async function toQrcodeUrl(content: string): Promise<string> {
  if (/^data:image\//i.test(content)) return content;
  const cleaned = content.replace(/^data:image\/\w+;base64,/, '');
  // 形如 base64（无前缀的裸 base64 图片数据）→ 直接补前缀
  if (/^[A-Za-z0-9+/=]+$/.test(cleaned) && cleaned.length > 200) {
    return `data:image/png;base64,${cleaned}`;
  }
  // 否则视为 URL：编码为二维码图（用户用微信扫码 → 打开 liteapp 绑定页）
  const QRCode = (await import('qrcode')).default;
  return await QRCode.toDataURL(cleaned, { width: 360, margin: 1 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// 媒体处理：入站下载 + 出站发送
// ============================================================

/** 媒体临时根：~/BobWork/.sandbox/wechat-media/，按日期分子目录 */
function mediaRoot(): string {
  const env = (process.env.BOBWORK_HOME || '').trim();
  const root = env && env.startsWith('/') ? env : join(homedir(), 'BobWork');
  return join(root, SANDBOX_DIRNAME_MEDIA);
}
const SANDBOX_DIRNAME_MEDIA = '.sandbox/wechat-media';

/** 根据 ILINK 媒体类型 + 后缀推断扩展名 */
function inferMediaExtension(media: InboundMedia): string {
  // 优先：file_name 自带扩展名
  if (media.fileName) {
    const m = media.fileName.match(/\.([A-Za-z0-9]{1,8})(?:[?#].*)?$/);
    if (m) return '.' + m[1].toLowerCase();
  }
  // 其次：协议 file_type（如 'jpg' 'amr' 'mp4'）
  if (media.fileType && /^[A-Za-z0-9]{1,8}$/.test(media.fileType)) {
    return '.' + media.fileType.toLowerCase();
  }
  // 最后：按类型兜底
  switch (media.type) {
    case ILINK_MSG_TYPE.IMAGE: return '.jpg';
    case ILINK_MSG_TYPE.VOICE: return '.amr';
    case ILINK_MSG_TYPE.FILE: return '.bin';
    case ILINK_MSG_TYPE.VIDEO: return '.mp4';
    default: return '.bin';
  }
}

/**
 * 下载入站媒体文件到本地临时目录。
 * @returns 本地绝对路径
 */
export async function downloadMediaItem(media: InboundMedia): Promise<string> {
  const dir = join(mediaRoot(), new Date().toISOString().slice(0, 10));
  await mkdir(dir, { recursive: true });
  const ext = inferMediaExtension(media);
  const name = `${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
  const dest = join(dir, name);

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 60_000);
  try {
    const resp = await fetch(media.downloadUrl, { signal: ac.signal });
    if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) throw new Error('下载内容为空');
    await writeFile(dest, buf);
    return dest;
  } finally {
    clearTimeout(t);
  }
}

/** 构造单个任意类型 item（供 sendRawItems 批量发送） */
type OutboundItem =
  | { type: number; text_item?: { text: string }; image_item?: { content_base64?: string; url?: string; mime?: string } };

/**
 * 通用发消息：按 item 列表逐条发送。
 * 单条 item_list 建议一个 item，兼容协议行为。
 */
export async function sendRawItems(
  creds: WechatCredentials,
  toUser: string,
  items: OutboundItem[],
  contextToken: string,
): Promise<void> {
  for (const item of items) {
    await apiPost(
      '/ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: toUser,
          client_id: randomUUID(),
          message_type: 2,
          message_state: 2,
          item_list: [item],
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      },
      creds.botToken,
      30_000,
    );
  }
}

/** 出站发送图片：本地文件读 base64 作为 image_item.content_base64 发出 */
export async function sendImage(
  creds: WechatCredentials,
  toUser: string,
  imageFilePath: string,
  contextToken: string,
): Promise<void> {
  const buf = await readFile(imageFilePath);
  const ext = extname(imageFilePath).toLowerCase().replace('.', '');
  const mime = (
    ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)
      ? `image/${ext === 'jpg' ? 'jpeg' : ext}`
      : 'image/jpeg'
  );
  const b64 = buf.toString('base64');
  const item: OutboundItem = {
    type: ILINK_MSG_TYPE.IMAGE,
    image_item: { content_base64: b64, mime },
  };
  await sendRawItems(creds, toUser, [item], contextToken);
}

/** 适配器能力声明 */
export const WECHAT_CAPABILITIES: AdapterCapabilities = {
  platform: 'wechat',
  media: {
    text: true,
    image: true,  // 入站：下载→OCR→文本化；出站：sendImage base64
    voice: true,  // 入站：下载→STT→文本化
    file: true,   // 入站：PDF→OCR；其余格式提示暂不支持
    video: false, // MVP：仍拒绝
  },
};
