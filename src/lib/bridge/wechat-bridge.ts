/**
 * 微信 iLink ↔ WANTED 桥接层
 *
 * 职责：
 *   - 启动时读凭证，有则恢复轮询；无则等待扫码绑定
 *   - 收到微信消息 → 解析指令 → 调用共享执行器（与 WANTED 面板同逻辑）→ 回复确认
 *   - 暴露绑定状态机（供 /api/wechat 与前端 UI 轮询）
 *
 * 设计：协议细节在 wechat-adapter.ts；指令执行在 executor.ts；
 * 本文件只做编排，不写任何业务逻辑。
 */
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  getQrcode,
  waitForScan,
  pollLoop,
  sendMessage,
  sendTypingIndicator,
  downloadMediaItem,
  sendImage,
  ILINK_MSG_TYPE,
  type WechatCredentials,
  type QrStatus,
  type InboundMessage,
  type InboundMedia,
} from './wechat-adapter.ts';
import { executeWantedCommand, finalizeMeeting, type ExecResult } from '@/lib/wanted/executor';
import { consumeExpiredMeeting, getMeetingState, isMeetingRemindDue, markMeetingReminded } from '@/lib/wanted/meeting-session';
import { stripThinkTags } from '@/lib/bus';
import { buildHelpText } from '@/lib/wanted/commands';
import { readSettingsFromFile } from '@/lib/settings-server';
import { acquireMessageLock, releaseMessageLock } from './msg-dedupe';
import { extname, basename } from 'path';
import { unlink } from 'fs/promises';
import { createHash } from 'crypto';
const crypto = { createHash };

/** 绑定会话状态（供 API / UI 查询） */
export interface BindingState {
  phase: 'idle' | 'fetching' | 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';
  qrcodeUrl?: string;
  error?: string;
}

/** 桥接运行状态 */
export interface BridgeStatus {
  bound: boolean;
  running: boolean;
  lastError?: string;
  binding?: BindingState;
  boundAs?: string; // 绑定的微信用户 id（脱敏）
}

const MAX_SCAN_ATTEMPTS = 60; // 等待扫码最多 120s（2s 间隔）
/** 轮询瞬态失败后的自动重连退避（封顶 60s，无限重试直至 stopRequested） */
const RETRY_BACKOFF = [5_000, 15_000, 60_000];

class WechatBridge {
  private credentials: WechatCredentials | null = null;
  private running = false;
  private stopRequested = false;
  private bindingState: BindingState = { phase: 'idle' };
  private lastError?: string;
  private boundUserId?: string;
  private welcomeSent = false;
  private lastFrom: { to: string; token: string } | null = null;
  private baseUrl: string;
  /** 会议静默提醒/自动收尾定时器（每 30s tick） */
  private meetingTimer: ReturnType<typeof setInterval> | null = null;

  /** 计算消息指纹：优先用服务端 msg.id；否则走内容签名兜底 */
  private messageFingerprint(msg: InboundMessage): string {
    if (msg.id) return `id:${msg.id}`;
    const mediaSig = msg.media ? `${msg.media.type}|${msg.media.downloadUrl}|${msg.media.fileName ?? ''}|${msg.media.fileSize ?? 0}` : '';
    const base = `${msg.from}\n${msg.contextToken}\n${msg.text}\n${msg.mediaType ?? ''}\n${mediaSig}`;
    return `sig:${crypto.createHash('sha256').update(base).digest('hex')}`;
  }

  /** 幂等判定（跨实例，DB 级）：首次返回 true；15 分钟内重复或正在执行中的消息返回 false 并跳过。
   *  see msg-dedupe.ts：全局 SQLite 表锁，多实例共享，杜绝同一条消息被多个实例各执行一次。 */
  private async tryAcquireMessage(msg: InboundMessage): Promise<boolean> {
    return acquireMessageLock(this.messageFingerprint(msg));
  }

  private async releaseInflightMessage(msg: InboundMessage): Promise<void> {
    await releaseMessageLock(this.messageFingerprint(msg));
  }

  constructor() {
    // Node 端 self 地址，用于调用本地 wanted API
    const port = process.env.PORT || '5000';
    this.baseUrl = `http://localhost:${port}`;
  }

  /**
   * 启动：读凭证 → 有则恢复轮询；无则 idle 等待扫码。
   * 可安全重复调用：凭证已存在但轮询未运行时会重新拉起（重启后冷恢复场景）。
   */
  async start(): Promise<void> {
    this.credentials = await loadCredentials();
    if (!this.credentials) {
      this.bindingState = { phase: 'idle' };
      return;
    }
    // 幂等防重：已有轮询在跑就跳过
    if (this.running) return;
    this.boundUserId = this.credentials.userId;
    this.welcomeSent = !!this.credentials.welcomeSent;
    this.running = true;
    this.stopRequested = false;
    this.lastError = undefined;
    this.bindingState = { phase: 'idle' };
    this.launchPollLoop(this.credentials);
    this.ensureMeetingTimer();
  }

  /**
   * 有凭证但轮询已停（session dead / cold start 后轮询未跑 / 瞬时失败退出）时恢复轮询。
   * 被 /api/wechat?action=status API 查询时调用，保证前端看到 running=true 对应真实可用的连接。
   */
  async ensureRunning(): Promise<void> {
    if (this.credentials && this.running) return;
    // 凭证文件可能已经存在但 start() 未被当前进程调用过（如 Next.js lazy init 后首次查询）
    const creds = this.credentials ?? await loadCredentials();
    if (!creds) return;
    this.credentials = creds;
    if (this.running) return;
    this.boundUserId = creds.userId;
    this.welcomeSent = !!creds.welcomeSent;
    this.running = true;
    this.stopRequested = false;
    this.lastError = undefined;
    this.bindingState = { phase: 'idle' };
    this.launchPollLoop(creds);
    this.ensureMeetingTimer();
  }

  /** 停止（解绑时调用） */
  async stop(): Promise<void> {
    this.stopMeetingTimer();
    this.stopRequested = true;
    this.running = false;
    this.credentials = null;
    this.boundUserId = undefined;
  }

  getStatus(): BridgeStatus {
    return {
      bound: !!this.credentials,
      running: this.running,
      lastError: this.lastError,
      binding: this.bindingState.phase !== 'idle' ? this.bindingState : undefined,
      boundAs: this.boundUserId ? `${this.boundUserId.slice(0, 4)}…` : undefined,
    };
  }

  /**
   * 主动向最近一次会话推送文本（定时报告 / 关闭前总结用）。
   * 未绑定 / 尚无会话 / 轮询未运行时不推送，返回 false。
   */
  async pushText(text: string): Promise<boolean> {
    if (!this.credentials || !this.lastFrom || !this.running) return false;
    try {
      // 主动推送无消息上下文，contextToken 传空串即可
      await sendMessage(this.credentials, this.lastFrom.to, text, this.lastFrom.token || '');
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /** 启动会议静默监控定时器（每 30s tick；幂等防重） */
  private ensureMeetingTimer(): void {
    if (this.meetingTimer) return;
    this.meetingTimer = setInterval(() => {
      void this.tickMeetingSession().catch(() => {});
    }, 30_000);
  }

  /** 停止会议静默监控定时器 */
  private stopMeetingTimer(): void {
    if (this.meetingTimer) {
      clearInterval(this.meetingTimer);
      this.meetingTimer = null;
    }
  }

  /**
   * 会议静默监控（每 30s 一次）：
   *  1) 距最后消息 ≥5 分钟且未提醒 → 提醒"5 分钟后自动结束整理"（幂等，只提醒一次）
   *  2) 距最后消息 ≥10 分钟 → 自动收尾：AI 整理纪要 → BobMail + 推送纪要摘要到微信
   */
  private async tickMeetingSession(): Promise<void> {
    if (!this.credentials || !this.lastFrom || !this.running) return;
    try {
      // 1) 5 分钟静默提醒（提醒后用户继续发言会重置，进入下一轮计时）
      if (isMeetingRemindDue()) {
        markMeetingReminded();
        const st = getMeetingState();
        await sendMessage(
          this.credentials,
          this.lastFrom.to,
          `⏳ 会议「${st.title}」已 5 分钟无新消息，5 分钟后将自动结束并整理纪要。可继续输入补充，或输入 /meeting out 立即整理。`,
          this.lastFrom.token || '',
        );
        return;
      }
      // 2) 10 分钟静默超时：自动收尾（AI 整理 → BobMail 收件箱），并推送纪要摘要
      const expired = consumeExpiredMeeting();
      if (expired) {
        const minutes = await finalizeMeeting(expired, this.baseUrl);
        await sendMessage(
          this.credentials,
          this.lastFrom.to,
          `会议「${expired.title}」已超时自动结束，纪要已发送到 BobMail：${minutes ? `\n\n${minutes}` : '\n\n（纪要整理失败，请稍后在面板重试）'}`,
          this.lastFrom.token || '',
        );
      }
    } catch { /* 定时任务失败静默，下轮重试 */ }
  }

  /**
   * 发起扫码绑定：取二维码 → 启动内部轮询等待扫码。
   * 返回二维码 dataURL 供前端渲染。
   */
  async startBinding(): Promise<BindingState> {
    // 会话健康（有凭证且轮询在跑）才拒绝重复绑定；
    // 若凭证还在但轮询已死（如重启后 token 失效），允许重新扫码覆盖凭证
    if (this.credentials && this.running) {
      return { phase: 'confirmed', error: '已绑定，无需重复扫码' };
    }
    this.bindingState = { phase: 'fetching' };
    try {
      const qr = await getQrcode();
      if (!qr.qrcodeUrl) {
        // iLink 返回了 qrcodeId 但未返回图片数据 → 前端无法渲染
        console.error('[wechat-bridge] getQrcode returned empty qrcodeUrl; qrcodeId =', qr.qrcodeId);
        this.bindingState = { phase: 'error', error: 'QR image not returned by iLink server' };
        return this.bindingState;
      }
      this.bindingState = { phase: 'waiting', qrcodeUrl: qr.qrcodeUrl };
      // 异步轮询扫码，不阻塞 API 返回
      void this.scanLoop(qr.qrcodeId);
      return this.bindingState;
    } catch (e: any) {
      console.error('[wechat-bridge] startBinding error:', e?.message || e);
      this.bindingState = { phase: 'error', error: e?.message || 'Failed to fetch QR code' };
      return this.bindingState;
    }
  }

  /** 内部扫码轮询（后台运行，直到 confirmed/expired） */
  private async scanLoop(qrcodeId: string): Promise<void> {
    let attempts = 0;
    while (attempts < MAX_SCAN_ATTEMPTS && this.bindingState.phase !== 'confirmed' && this.bindingState.phase !== 'expired') {
      attempts++;
      const result = await waitForScan(qrcodeId, (status) => {
        if (status === 'scanned') this.bindingState = { ...this.bindingState, phase: 'scanned' };
      });
      if (result.status === 'confirmed' && result.credentials) {
        this.credentials = result.credentials;
        this.boundUserId = result.credentials.userId;
        this.welcomeSent = !!result.credentials.welcomeSent;
        await saveCredentials(result.credentials);
        this.bindingState = { phase: 'confirmed' };
        this.running = true;
        this.stopRequested = false;
        this.launchPollLoop(result.credentials);
        return;
      }
      if (result.status === 'expired') {
        this.bindingState = { phase: 'expired' };
        return;
      }
      // waiting / scanned → 继续（waitForScan 内部已 sleep 2s）
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (this.bindingState.phase === 'waiting' || this.bindingState.phase === 'scanned') {
      this.bindingState = { phase: 'expired' }; // 超时
    }
  }

  /** 启动收消息轮询（瞬态失败自动重连，会话失效则停住并提示重绑） */
  private launchPollLoop(creds: WechatCredentials, retryCount = 0): void {
    void (async () => {
      try {
        const reason = await pollLoop(
          creds,
          creds.lastCursor ?? '', // 断点续拉：从上次位置开始，空串=服务端从最新开始
          (msg) => { void this.onMessage(creds, msg); },
          () => this.stopRequested,
          (cursor) => {
            // cursor 变了立即持久化；重启后能续拉不丢消息
            creds.lastCursor = cursor;
            if (this.credentials === creds) {
              saveCredentials(creds).catch(() => {});
            }
          },
        );
        if (reason === 'session-expired') {
          // bot_token 已失效：无法自愈，停住轮询并暴露重绑入口
          this.running = false;
          this.lastError = 'WeChat session expired (errcode=-14), please re-scan to rebind';
          this.bindingState = { phase: 'expired', error: this.lastError };
          // 紧急通知：用最后一次有效 token 尝试告知用户需重绑；失败静默忽略（Bot 很可能真已失效）
          try {
            if (this.lastFrom) {
              await sendMessage(
                creds,
                this.lastFrom.to,
                '⚠️ BobWork 微信连接已过期（会话失效），请打开 BobWork 设置 → WeChat，重新扫码绑定以恢复服务。',
                this.lastFrom.token,
              );
            }
          } catch { /* token 已失效时发送必然失败，忽略 */ }
        } else if (reason === 'error') {
          // 瞬态失败（网络抖动 / 服务未就绪）：退避自动重连，不终止会话
          const delay = RETRY_BACKOFF[Math.min(retryCount, RETRY_BACKOFF.length - 1)];
          this.lastError = `WeChat connection lost, auto-reconnecting in ${Math.round(delay / 1000)}s`;
          this.running = true;
          setTimeout(() => {
            if (this.stopRequested) {
              this.running = false;
              return;
            }
            this.launchPollLoop(creds, retryCount + 1);
          }, delay);
        } else {
          // stopped / no-cred / fatal / 其他 → 轮询终止
          this.running = false;
          if (reason !== 'stopped') {
            this.lastError = this.lastError || 'WeChat polling exited unexpectedly';
          }
        }
      } catch (e: any) {
        this.lastError = e?.message || 'Polling exited unexpectedly';
        this.running = false;
      }
    })();
  }

  /** 收到微信消息：指令路由 → 执行 → 回复 */
  private async onMessage(creds: WechatCredentials, msg: InboundMessage): Promise<void> {
    // 幂等（跨实例 DB 锁）：5 分钟内重复消息（iLink 重试 / cursor 回退 / 多实例并存）跳过，
    // 避免同一待办写入两次
    if (!(await this.tryAcquireMessage(msg))) return;
    try {
      // 记录最近会话（供 pushText 主动推送定时/关闭前报告）
      this.lastFrom = { to: msg.from, token: msg.contextToken };
      // typing 指示
      await sendTypingIndicator(creds, msg.from, 1);

      // 首次消息：先发欢迎语 + 指令说明（持久化 welcomeSent，重启不重复）
      if (!this.welcomeSent) {
        this.welcomeSent = true;
        await saveCredentials({ ...creds, welcomeSent: true });
        const welcome =
          'BobWork connected! Just send a message — it will be auto-parsed.\n\n' +
          'Default: /todo (AI parses → calendar event + todo list)\n' +
          'For notes/ideas: start with /note\n' +
          'Query schedule: just ask in chat (e.g. "今天有什么安排", "最近三天的日程", "已过期的待办") — AI queries the calendar directly\n' +
          'Ask AI a question: start with /chat\n' +
          'View all commands: send /help';
        await sendMessage(creds, msg.from, welcome, msg.contextToken);
      }

      // 媒体（图片/语音/文件）先文本化：下载 → OCR / STT，拼接到用户文本。
      // 用户若同时附带文字（如"截图+明天开会整理待办"），文字放在识别结果之后交给 executor。
      let extractedFromMedia = '';
      let tempFilePath: string | null = null;
      try {
        if (msg.media) {
          const typeName =
            msg.media.type === ILINK_MSG_TYPE.IMAGE ? '图片'
              : msg.media.type === ILINK_MSG_TYPE.VOICE ? '语音'
                : msg.media.type === ILINK_MSG_TYPE.FILE ? '文件'
                  : msg.media.type === ILINK_MSG_TYPE.VIDEO ? '视频'
                    : '媒体';
          try {
            tempFilePath = await downloadMediaItem(msg.media);
            const parsed = await this.mediaToText(msg.media, tempFilePath);
            if (parsed.text && parsed.text.trim()) {
              extractedFromMedia = `[${typeName}识别结果]\n${parsed.text.trim()}\n`;
              // 出站：OCR/STT 引擎返回的预览图，能转发用户一份更直观（可选）
              if (parsed.previewImagePath) {
                try { await sendImage(creds, msg.from, parsed.previewImagePath, msg.contextToken); } catch { /* ignore */ }
              }
            } else if (parsed.unsupported) {
              await sendMessage(creds, msg.from,
                `⚠️ 暂不支持该${typeName}格式（${parsed.unsupported}）。支持的格式：图片(PDF/PNG/JPG/扫描件)、语音(mp3/wav/m4a/amr 等)、PDF 文件。`,
                msg.contextToken);
              return;
            } else {
              await sendMessage(creds, msg.from,
                `⚠️ ${typeName}内容未识别出可提取文字。如为纯图表/无文字图片，建议加一句文字说明（例："这张图整理成明天的待办"）。`,
                msg.contextToken);
              return;
            }
          } catch (dlErr: any) {
            await sendMessage(creds, msg.from,
              `⚠️ ${typeName}下载/识别失败：${dlErr?.message || String(dlErr)}。请重新发送或改发文字版本。`,
              msg.contextToken);
            return;
          }
        }
      } finally {
        if (tempFilePath) {
          unlink(tempFilePath).catch(() => {});
        }
      }

      const finalInput = (extractedFromMedia + (msg.text || '')).trim();
      if (!finalInput) return;

      // 执行超时保护：90s 内未完成先回一句"正在整理…"，完成后再异步推送结果。
      // 避免用户发"写一份 100 页合同"等任务让 typing 卡死、以为服务挂掉。
      const EXEC_TIMEOUT_MS = 90_000;
      const to = msg.from;
      const contextToken = msg.contextToken;
      let repliedProgress = false;
      const timeoutHandle = setTimeout(() => {
        repliedProgress = true;
        void (async () => {
          try {
            await sendMessage(creds, to, '⏳ 正在整理，请稍候，稍后把结果推送给你…', contextToken);
          } catch { /* ignore */ }
        })();
      }, EXEC_TIMEOUT_MS);

      let result: ExecResult;
      try {
        result = await executeWantedCommand(finalInput, { baseUrl: this.baseUrl, source: 'wechat' });
      } finally {
        clearTimeout(timeoutHandle);
        // 执行完成（无论成功失败）：释放 inflight 强锁，避免后续异常导致锁泄漏
        await this.releaseInflightMessage(msg);
      }
      // 微信通道只回推正文：剥离 <think> 思考块（会话存储仍保留完整，多轮上下文不丢）
      const reply = result.ok ? stripThinkTags(result.reply) : `❌ ${result.reply}`;
      try {
        if (repliedProgress) {
          // 已发过进度提示 → 结果前缀加 ✅ "完成："，与进度提示区分
          await sendMessage(creds, to, `✅ 完成：\n${reply}`, contextToken);
        } else if (reply) {
          // reply 为空（如会议静默记录、纯状态变更）→ 不回推任何消息，保持安静
          await sendMessage(creds, to, reply, contextToken);
        }
      } catch (se) {
        // 主动回推失败时记录，用于用户手动查看 wanted 面板结果
        this.lastError = `Failed to push reply: ${se instanceof Error ? se.message : String(se)}`;
      }
    } catch (e: any) {
      this.lastError = e?.message || 'Message processing failed';
      try {
        await sendMessage(creds, msg.from, '❌ Processing failed, please try again later.', msg.contextToken);
      } catch {
        // 回复失败忽略
      }
    } finally {
      try { await sendTypingIndicator(creds, msg.from, 2); } catch { /* ignore */ }
    }
  }

  /**
   * 媒体 → 文本：
   *   IMAGE → ocrFile（图片+PDF）
   *   VOICE → parseAudio（STT，复用 settings.stt）
   *   FILE  → ext=pdf 走 OCR；docx/txt 走纯文本抽取；其余 unsupported
   * @returns { text, previewImagePath?, unsupported?: 扩展名/原因 }
   */
  private async mediaToText(
    media: InboundMedia,
    localPath: string,
  ): Promise<{ text: string; previewImagePath?: string; unsupported?: string }> {
    const ext = extname(localPath).toLowerCase();
    const sandboxProjectRoot =
      process.env.BOBWORK_HOME && process.env.BOBWORK_HOME.startsWith('/')
        ? `${process.env.BOBWORK_HOME}/.sandbox`
        : `${process.env.HOME ?? ''}/BobWork/.sandbox`;

    if (media.type === ILINK_MSG_TYPE.IMAGE || (media.type === ILINK_MSG_TYPE.FILE && ext === '.pdf') ||
      ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp', '.tiff', '.tif'].includes(ext)) {
      const { ocrFile } = await import('@/lib/pdf/ocr-service');
      const res = await ocrFile(localPath, { upgrade: 'auto', projectPath: sandboxProjectRoot });
      if (!res.success) return { text: '' };
      // 把每页 OCR 文本扁平化；结构化 items 交给 executor 时用纯文本即可
      return { text: res.text || '' };
    }

    if (media.type === ILINK_MSG_TYPE.VOICE || ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus', '.amr', '.mp4'].includes(ext)) {
      const settings = await readSettingsFromFile();
      const { parseAudio } = await import('@/lib/parse/audio-parser');
      const r = await parseAudio(localPath, sandboxProjectRoot, { stt: settings.stt });
      return { text: r.extracted_text || '' };
    }

    if (media.type === ILINK_MSG_TYPE.FILE) {
      if (ext === '.txt' || ext === '.md' || ext === '.csv' || ext === '.json' || ext === '.log' || ext === '.ini' || ext === '.conf') {
        const { readFile } = await import('fs/promises');
        const raw = await readFile(localPath, 'utf-8');
        const head = raw.length > 12000 ? raw.slice(0, 12000) + `\n[已截断前12000字符，共${raw.length}字]` : raw;
        return { text: `[文件:${basename(localPath)}]\n${head}` };
      }
      if (ext === '.docx') {
        try {
          // 走 DOCX 纯文本提取（mammoth .docx→HTML→strip tags；若无 mammoth 则用 zip 解 XML）
          const { readFile: readF } = await import('fs/promises');
          const buf = await readF(localPath);
          let text: string;
          try {
            const mammoth = (await import('mammoth')).extractRawText;
            const r = await mammoth({ buffer: buf });
            text = r.value || '';
          } catch {
            // 本地解 document.xml 的兜底（不用 mammoth）
            const AdmZip = (await import('adm-zip')).default;
            const zip = new AdmZip(buf);
            const xml = zip.readAsText('word/document.xml') || '';
            text = xml
              .replace(/<w:tab[^>]*/g, '\t')
              .replace(/<\/w:p>/g, '\n')
              .replace(/<[^>]+>/g, '')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>');
          }
          const head = text.length > 12000 ? text.slice(0, 12000) + `\n[已截断前12000字符，共${text.length}字]` : text;
          return { text: `[文件:${basename(localPath)}]\n${head}` };
        } catch {
          return { text: '', unsupported: 'docx' };
        }
      }
      return { text: '', unsupported: ext || basename(localPath) };
    }

    return { text: '', unsupported: `type=${media.type}` };
  }

  /** 解绑：清凭证 + 停止轮询 */
  async unbind(): Promise<void> {
    await this.stop();
    await clearCredentials();
    this.bindingState = { phase: 'idle' };
    this.lastError = undefined;
    this.welcomeSent = false;
  }
}

/** 全局单例（instrumentation 与 API 路由共用） */
// Turbopack 将 instrumentation 与 route handler 编译为不同 chunk，模块级单例会各自实例化；
// 用 globalThis 挂载，确保无论哪个 chunk 引用，拿到的都是同一个桥实例。
const GLOBAL_KEY = '__wechatBridgeSingleton__';

declare global {
  // eslint-disable-next-line no-var
  var __wechatBridgeSingleton__: WechatBridge | undefined;
}

export const wechatBridge: WechatBridge =
  (globalThis as any)[GLOBAL_KEY] ??= new WechatBridge();
