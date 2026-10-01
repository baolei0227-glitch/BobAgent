/**
 * 飞书（Feishu / Lark）长连接适配器
 *
 * 与 wechat-adapter.ts 同层职责：只做协议与凭证，不含业务编排。上层只看到
 * verifyCredentials / sendText / normalizeInbound 三个动作，SDK 细节封死在本文件内。
 *
 *   - 凭证：`<appRoot>/.feishu-credentials.json`（0600，tmp→rename 原子写）
 *   - 校验：取一次 tenant_access_token，失败即把 code/msg 原样抛出（connect 前置校验用）
 *   - 出站：`im.message.reply`（回复入站消息）/ `im.message.create`（主动推送），超长按 4000 字符续发
 *   - 入站：`im.message.receive_v1` 事件归一化 + 过滤（非真人、非私聊直接丢弃）
 *
 * 传输只走官方 SDK 的长连接（WebSocket）——桌面端没有公网地址，Webhook 方案不可用；
 * 飞书长连接**仅支持企业自建应用**。
 */
import { readFile, writeFile, mkdir, access, chmod, rename, unlink } from 'fs/promises';
import { join } from 'path';
import { Client, WSClient, LoggerLevel } from '@larksuiteoapi/node-sdk';
import type { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { resolveAppRoot } from '@/lib/app-root';

/** 单条消息文本上限：飞书文本 content 上限约 30KB，取 4000 字符留足 JSON 包装与多字节余量 */
const BATCH_CHAR_LIMIT = 4000;

/** App ID 格式。SDK 内部按此校验（不匹配会**静默不建连**），故提前拦截并给出明确提示 */
const APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/;

/** 长连接建立握手超时上限；SDK 缺省不设超时，卡住的 DNS / 代理会让连接永久悬挂 */
const HANDSHAKE_TIMEOUT_MS = 15_000;

// ============================================================
// 类型
// ============================================================

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  /** 首次消息欢迎语是否已发送（持久化，重启不重复） */
  welcomeSent?: boolean;
  /** 最近一次会话的 chat_id：主动推送（日程提醒）收件人；重启后未收到入站消息时退回它 */
  lastChatId?: string;
}

/** 归一化后的入站消息（媒体降级为 unsupportedType，由桥决定如何回话） */
export interface InboundFeishuMessage {
  /** message_id：幂等去重键，也是回复时的 path 参数 */
  id: string;
  chatId: string;
  chatType: string;
  /** 发送者 open_id */
  senderId: string;
  /** 纯文本（text 消息解析 / post 富文本拍平）；非文本消息为空串 */
  text: string;
  /** 非文本消息类型（image / file / audio / media 等），供桥回「暂不支持」 */
  unsupportedType?: string;
  raw: unknown;
}

// ============================================================
// 凭证存储
// ============================================================

/** 凭证文件：<appRoot>/.feishu-credentials.json（0600） */
function credentialsPath(): string {
  return join(resolveAppRoot(), '.feishu-credentials.json');
}

/** 读取凭证；不存在 / 字段残缺返回 null */
export async function loadCredentials(): Promise<FeishuCredentials | null> {
  try {
    const raw = await readFile(credentialsPath(), 'utf-8');
    const data = JSON.parse(raw);
    if (!data?.appId || !data?.appSecret) return null;
    return {
      appId: String(data.appId),
      appSecret: String(data.appSecret),
      welcomeSent: !!data.welcomeSent,
      lastChatId: typeof data.lastChatId === 'string' ? data.lastChatId : undefined,
    };
  } catch {
    return null;
  }
}

/** 保存凭证（0600，先写临时文件再 rename，避免半截文件） */
export async function saveCredentials(creds: FeishuCredentials): Promise<void> {
  const path = credentialsPath();
  const dir = path.substring(0, path.lastIndexOf('/'));
  try {
    await access(dir);
  } catch {
    await mkdir(dir, { recursive: true });
  }
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(creds, null, 2), 'utf-8');
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/** 清除凭证（解绑） */
export async function clearCredentials(): Promise<void> {
  try {
    await unlink(credentialsPath());
  } catch { /* 不存在则忽略 */ }
}

// ============================================================
// SDK 客户端
// ============================================================

/**
 * 构造 SDK 客户端（长连接与消息收发共用一套凭证）。
 * loggerLevel 降到 warn：默认 info 会持续打印 `[info]: [ 'client ready' ]` 等噪声。
 */
export function createClient(creds: FeishuCredentials): Client {
  return new Client({
    appId: creds.appId,
    appSecret: creds.appSecret,
    loggerLevel: LoggerLevel.warn,
  });
}

/** 构造长连接客户端；状态回调由桥注入（用于同步 running / lastError） */
export function createWsClient(
  creds: FeishuCredentials,
  handlers?: {
    onReady?: () => void;
    onError?: (err: Error) => void;
    onReconnecting?: () => void;
    onReconnected?: () => void;
  },
): WSClient {
  return new WSClient({
    appId: creds.appId,
    appSecret: creds.appSecret,
    loggerLevel: LoggerLevel.warn,
    autoReconnect: true,
    handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    ...handlers,
  });
}

/**
 * 校验凭证：取一次 tenant_access_token。
 * 失败时把飞书返回的 `code: msg` 原样抛出（connect 前置校验用，不落盘）。
 */
export async function verifyCredentials(creds: FeishuCredentials): Promise<void> {
  if (!APP_ID_PATTERN.test(creds.appId)) {
    throw new Error('App ID 格式不正确（应为 cli_ 加 16 位十六进制字符）');
  }
  const client = createClient(creds);
  const res = await client.auth.tenantAccessToken.internal({
    data: { app_id: creds.appId, app_secret: creds.appSecret },
  });
  if (res?.code !== 0 || !res?.data?.tenant_access_token) {
    throw new Error(res?.msg ? `${res.msg} (code ${res?.code})` : `凭证校验失败 (code ${res?.code ?? 'unknown'})`);
  }
}

// ============================================================
// 出站：发消息
// ============================================================

/** 按 4000 字符切分（多字节字符按 JS 码元切，飞书服务端按字符计，不会截断 UTF-8） */
function chunkText(text: string): string[] {
  if (text.length <= BATCH_CHAR_LIMIT) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += BATCH_CHAR_LIMIT) {
    chunks.push(text.slice(i, i + BATCH_CHAR_LIMIT));
  }
  return chunks;
}

/**
 * 发送文本。
 * @param replyToMessageId 入站消息 id：有则以「回复那条消息」的方式发出（会话内挂在上文下），
 *        续发的第 2..n 段与主动推送走 `im.message.create`（receive_id_type = chat_id）。
 */
export async function sendText(
  client: Client,
  chatId: string,
  text: string,
  replyToMessageId?: string,
): Promise<void> {
  const chunks = chunkText(text);
  for (let i = 0; i < chunks.length; i++) {
    const content = JSON.stringify({ text: chunks[i] });
    if (i === 0 && replyToMessageId) {
      await client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'text' },
      });
      continue;
    }
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, content, msg_type: 'text' },
    });
  }
}

// ============================================================
// 入站：事件归一化
// ============================================================

/** 飞书事件在 SDK 内已按 `{...event, event_type}` 拍平，故直接读顶层 sender / message */
interface RawFeishuEvent {
  sender?: {
    sender_type?: string;
    sender_id?: { open_id?: string; union_id?: string; user_id?: string };
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
  };
}

/** post 富文本段落节点（tag: text / a / at / emotion 等） */
interface PostSegment {
  tag?: string;
  text?: string;
  href?: string;
  user_name?: string;
  user_id?: string;
}

/** post 富文本 → 纯文本：段落换行，段内节点顺次拼接 */
function flattenPost(content: unknown): string {
  const body = content as { title?: string; content?: PostSegment[][] } | null;
  if (!body) return '';
  const lines: string[] = [];
  if (body.title) lines.push(body.title);
  for (const paragraph of body.content ?? []) {
    if (!Array.isArray(paragraph)) continue;
    lines.push(
      paragraph
        .map((seg) => {
          if (seg?.tag === 'a') return seg.href ? `${seg.text ?? ''}(${seg.href})` : (seg.text ?? '');
          if (seg?.tag === 'at') return `@${seg.user_name || seg.user_id || ''}`;
          return seg?.text ?? '';
        })
        .join(''),
    );
  }
  return lines.join('\n').trim();
}

/**
 * 归一化 `im.message.receive_v1` 事件。
 *
 * 过滤（返回 null 丢弃）：
 *   - `sender.sender_type !== 'user'`：机器人/应用自己发的事件，防自回环；
 *   - `chat_type !== 'p2p'`：群聊不服务（首版只做机器人私聊）。
 */
export function normalizeInbound(data: unknown): InboundFeishuMessage | null {
  const evt = (data ?? {}) as RawFeishuEvent;
  const msg = evt.message;
  if (!msg?.message_id || !msg.chat_id) return null;
  if (evt.sender?.sender_type !== 'user') return null;
  if (msg.chat_type !== 'p2p') return null;

  const type = msg.message_type ?? '';
  let text = '';
  let unsupportedType: string | undefined;

  if (type === 'text') {
    try {
      text = (JSON.parse(msg.content ?? '{}') as { text?: string })?.text ?? '';
    } catch {
      text = '';
    }
  } else if (type === 'post') {
    try {
      text = flattenPost(JSON.parse(msg.content ?? '{}'));
    } catch {
      text = '';
    }
  } else {
    unsupportedType = type || 'unknown';
  }

  return {
    id: msg.message_id,
    chatId: msg.chat_id,
    chatType: msg.chat_type,
    senderId: evt.sender?.sender_id?.open_id ?? '',
    text: text.trim(),
    unsupportedType,
    raw: data,
  };
}

// ============================================================
// 长连接启停
// ============================================================

/** 启动长连接（事件分发器由桥注册好 handler 后传入） */
export async function startWs(ws: WSClient, dispatcher: EventDispatcher): Promise<void> {
  await ws.start({ eventDispatcher: dispatcher });
}

/** 关闭长连接 */
export function stopWs(ws: WSClient): void {
  try {
    ws.close({ force: true });
  } catch { /* 已关闭则忽略 */ }
}