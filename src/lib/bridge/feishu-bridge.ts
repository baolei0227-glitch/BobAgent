/**
 * 飞书（Feishu / Lark）↔ Butler 桥接层
 *
 * 与 wechat-bridge.ts 同构，只保留长连接通道真正需要的部分：
 *   - 启动读凭证 → 有则恢复长连接；无则 idle 等待用户在设置里填 App ID / Secret
 *   - 收到私聊消息 → 归一化 → 交给**统一会话层**（`/api/butler/threads`，线程层 SSOT）→ 回复
 *   - 暴露连接状态（供 /api/feishu 与前端 UI 查询）
 *
 * 协议细节在 feishu-adapter.ts；本文件只做编排，不写业务逻辑。
 *
 * 刻意**不做**（对齐微信桥的能力裁剪，首版保持简单）：
 *   - 媒体下载与识别（图片/文件/语音一律回「暂不支持，请发文字」）
 *   - 「B5 中途改」打断重跑、90s 进度提示
 *   - `/meeting` 与会议进行中分支（会议缓冲是宿主进程内状态，飞书侧不参与）
 */
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  verifyCredentials,
  createClient,
  createWsClient,
  startWs,
  stopWs,
  sendText,
  normalizeInbound,
  type FeishuCredentials,
} from './feishu-adapter';
import { Client, EventDispatcher, LoggerLevel, type WSClient } from '@larksuiteoapi/node-sdk';
import { stripThinkTags } from '@/lib/bus';
import { buildHelpText, normalizeSlashInput } from '@/lib/core/commands';
import { NOTIFY_THREAD_ID } from '@/lib/butler/storage';
import { acquireMessageLock, releaseMessageLock } from './msg-dedupe';

/** 桥接运行状态（供 API / UI 查询） */
export interface FeishuStatus {
  bound: boolean;
  running: boolean;
  lastError?: string;
  /** 脱敏后的 App ID（前 8 位 + …） */
  appId?: string;
}

class FeishuBridge {
  private credentials: FeishuCredentials | null = null;
  private client: Client | null = null;
  private ws: WSClient | null = null;
  private dispatcher: EventDispatcher | null = null;
  private running = false;
  private lastError?: string;
  private welcomeSent = false;
  private lastChatId?: string;
  private baseUrl: string;

  constructor() {
    // Node 端 self 地址，用于调用本地 Butler API
    const port = process.env.PORT || '5000';
    this.baseUrl = `http://localhost:${port}`;
  }

  /**
   * 启动：读凭证 → 有则恢复长连接；无则 idle 等待用户在设置里填写。
   * 可安全重复调用：凭证已存在但连接未运行时会重新拉起（重启后冷恢复场景）。
   */
  async start(): Promise<void> {
    this.credentials = await loadCredentials();
    if (!this.credentials) return;
    if (this.running) return;
    this.launch(this.credentials);
  }

  /** 有凭证但连接已停（cold start 后未跑 / 致命错误退出）时恢复；供 status API 调用 */
  async ensureRunning(): Promise<void> {
    if (this.credentials && this.running) return;
    const creds = this.credentials ?? (await loadCredentials());
    if (!creds) return;
    this.credentials = creds;
    if (this.running) return;
    this.launch(creds);
  }

  /**
   * 连接：先校验凭证（取一次 tenant_access_token），通过才落盘并建立长连接。
   * 校验失败抛错，由 API 层转成用户可读提示 —— 不落盘意味着填错不会污染已有配置。
   */
  async connect(appId: string, appSecret: string): Promise<void> {
    const creds: FeishuCredentials = {
      appId: appId.trim(),
      appSecret: appSecret.trim(),
      welcomeSent: this.credentials?.appId === appId.trim() ? this.credentials.welcomeSent : false,
      lastChatId: this.credentials?.appId === appId.trim() ? this.credentials.lastChatId : undefined,
    };
    await verifyCredentials(creds);

    // 换绑：先拆掉旧连接，避免同一个应用起两条长连接
    this.teardown();
    await saveCredentials(creds);
    this.credentials = creds;
    this.launch(creds);
  }

  /** 解绑：关连接 + 清凭证 */
  async unbind(): Promise<void> {
    this.teardown();
    this.credentials = null;
    this.lastError = undefined;
    this.welcomeSent = false;
    this.lastChatId = undefined;
    await clearCredentials();
  }

  /** 停止（进程退出 / 关闭连接用） */
  stop(): void {
    this.teardown();
  }

  getStatus(): FeishuStatus {
    return {
      bound: !!this.credentials,
      running: this.running,
      lastError: this.lastError,
      appId: this.credentials ? `${this.credentials.appId.slice(0, 8)}…` : undefined,
    };
  }

  /**
   * 服务端主动推送文本（日程提醒等）。
   * 收件人优先取最近一次会话，其次退回凭证里持久化的 chat_id —— 应用重启后还没收到过入站消息时
   * `lastChatId` 内存态是空的，只看它会让「重启后的第一条日程提醒」静默丢推。
   * 未绑定 / 无收件人 / 连接未运行时返回 false。
   */
  async pushText(text: string): Promise<boolean> {
    const chatId = this.lastChatId || this.credentials?.lastChatId;
    if (!this.client || !chatId || !this.running) return false;
    try {
      await sendText(this.client, chatId, text);
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  // ============================================================
  // 内部：连接生命周期
  // ============================================================

  /** 建立长连接并注册事件处理（幂等：调用前先 teardown） */
  private launch(creds: FeishuCredentials): void {
    this.lastError = undefined;
    this.welcomeSent = !!creds.welcomeSent;
    this.lastChatId = creds.lastChatId;

    this.client = createClient(creds);
    this.ws = createWsClient(creds, {
      onReady: () => {
        this.running = true;
        this.lastError = undefined;
      },
      onReconnecting: () => {
        this.lastError = 'Feishu connection lost, reconnecting…';
      },
      onReconnected: () => {
        this.running = true;
        this.lastError = undefined;
      },
      onError: (err) => {
        this.running = false;
        this.lastError = err?.message || 'Feishu connection failed';
      },
    });
    this.dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.warn }).register({
      // 3 秒 ACK 硬约束：飞书长连接要求事件处理 3s 内返回，否则触发重推。
      // 因此这里**不 await** 实际处理，只 fire-and-forget（重推由 msg-dedupe 兜住）。
      'im.message.receive_v1': (data) => {
        void this.onMessage(creds, data);
      },
    });

    const ws = this.ws;
    const dispatcher = this.dispatcher;
    this.running = true;
    void startWs(ws, dispatcher).catch((e) => {
      this.running = false;
      this.lastError = e instanceof Error ? e.message : String(e);
    });
  }

  /** 关连接 + 释放引用（不碰凭证） */
  private teardown(): void {
    this.running = false;
    if (this.ws) stopWs(this.ws);
    this.ws = null;
    this.dispatcher = null;
    this.client = null;
  }

  // ============================================================
  // 内部：消息处理
  // ============================================================

  /** 幂等判定（跨实例，DB 级）：首次返回 true；15 分钟内重复或正在执行中返回 false */
  private async tryAcquire(messageId: string): Promise<boolean> {
    return acquireMessageLock(`feishu:msg:${messageId}`);
  }

  private async releaseInflight(messageId: string): Promise<void> {
    await releaseMessageLock(`feishu:msg:${messageId}`);
  }

  /** 收到飞书私聊消息：归一化 → 指令路由（统一会话层）→ 回复 */
  private async onMessage(creds: FeishuCredentials, raw: unknown): Promise<void> {
    const msg = normalizeInbound(raw);
    if (!msg) return; // 非真人 / 非私聊 / 缺字段：静默丢弃

    // 幂等（跨实例 DB 锁）：SDK 自身不去重，重推 / 多实例并存时会重复投递
    if (!(await this.tryAcquire(msg.id))) return;
    try {
      const client = this.client;
      if (!client) return;

      // 记录最近会话（供 pushText 主动推送）；持久化以便重启后仍有收件人
      if (this.lastChatId !== msg.chatId) {
        this.lastChatId = msg.chatId;
        if (this.credentials === creds) {
          creds.lastChatId = msg.chatId;
          saveCredentials(creds).catch(() => {});
        }
      }

      // 首次消息：先发欢迎语 + 指令说明（持久化 welcomeSent，重启不重复）
      if (!this.welcomeSent) {
        this.welcomeSent = true;
        if (this.credentials === creds) {
          creds.welcomeSent = true;
          saveCredentials(creds).catch(() => {});
        }
        await sendText(client, msg.chatId, 'BobWork connected!\n\n' + buildHelpText(), msg.id);
      }

      // v1 只做文本：图片/文件/语音一律回一句，不下载不识别
      if (msg.unsupportedType) {
        await sendText(client, msg.chatId, `⚠️ 暂不支持该消息类型（${msg.unsupportedType}），请发文字。`, msg.id);
        return;
      }
      if (!msg.text) return;

      // 统一入口：飞书里所有输入都交给**管家**（会话层）。斜杠命令先归一化成
      // 「意图：…」+ 正文（normalizeSlashInput），由管家按命令表调用自己的工具。
      // threadIdHint 固定为常驻通知助理「Bobby」线程 —— 与微信桥、桌面端看到的是同一条会话，
      // 系统推送类通知（日程提醒等）也归在同一条流里。
      // source='panel' 让这条常驻会话长期保留（永不过期）；通道能力靠 channel 显式给
      // —— 二者解耦（source 只管 TTL）。
      const resp = await fetch(`${this.baseUrl}/api/butler/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: normalizeSlashInput(msg.text),
          source: 'panel',
          channel: 'feishu',
          threadIdHint: NOTIFY_THREAD_ID,
        }),
      });
      const data = (await resp.json()) as { success?: boolean; reply?: string; error?: string };
      const reply = data.success ? stripThinkTags(data.reply ?? '') : `❌ ${data.error ?? '请求失败，请稍后重试'}`;
      // reply 为空（如纯状态变更）→ 不回推任何消息，保持安静
      if (reply) await sendText(client, msg.chatId, reply, msg.id);
    } catch (e) {
      this.lastError = (e instanceof Error ? e.message : '') || 'Message processing failed';
      try {
        if (this.client) await sendText(this.client, msg.chatId, '❌ Processing failed, please try again later.');
      } catch { /* 回复失败忽略 */ }
    } finally {
      // 执行完成（无论成功失败）：释放 inflight 强锁，避免异常导致锁泄漏
      await this.releaseInflight(msg.id);
    }
  }
}

/** 全局单例（instrumentation 与 API 路由共用） */
// Turbopack 将 instrumentation 与 route handler 编译为不同 chunk，模块级单例会各自实例化；
// 用 globalThis 挂载，确保无论哪个 chunk 引用，拿到的都是同一个桥实例。
declare global {
  // eslint-disable-next-line no-var
  var __feishuBridgeSingleton__: FeishuBridge | undefined;
}

export const feishuBridge: FeishuBridge =
  globalThis.__feishuBridgeSingleton__ ??= new FeishuBridge();