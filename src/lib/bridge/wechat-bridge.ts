/**
 * 微信 iLink ↔ Butler 桥接层
 *
 * 职责：
 *   - 启动时读凭证，有则恢复轮询；无则等待扫码绑定
 *   - 收到微信消息 → 解析指令 → 交给**统一会话层**（管家画像，与悬浮球/⌘F 同一入口）→ 回复
 *   - 暴露绑定状态机（供 /api/wechat 与前端 UI 轮询）
 *
 * 设计（P0 统一入口）：协议细节在 wechat-adapter.ts；对话在 /api/butler/threads（线程层 SSOT）；
 * 仅 /meeting 与会议进行中暂留宿主 executor（会议缓冲是进程内状态，P1 才工具化）；
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
import { executeButlerCommand, type ExecResult } from '@/lib/core/executor';
import { finalizeMeeting, recordMeetingTranscript } from '@/lib/core/meeting-finalize';
import { consumeExpiredMeeting, getMeetingState, isMeetingActive, isMeetingRemindDue, markMeetingReminded } from '@/lib/core/meeting-session';
import { stripThinkTags } from '@/lib/bus';
import { buildHelpText, detectCommand, mergeSteeringInput, normalizeSlashInput } from '@/lib/core/commands';
import { NOTIFY_THREAD_ID } from '@/lib/butler/storage';
import { readSettingsFromFile } from '@/lib/settings-server';
// 会议专属设置（录音源/参会人数/会后自动整理）：超时收尾须尊重 autoSummarize，故读同一份 settings.json
import { meetingSettingsOf } from '@/lib/settings';
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
  /**
   * B5「中途改」：在飞任务登记表（key = 用户 id）。
   * 轮询是 fire-and-forget（`wechat-adapter.ts:381` 不 await），所以长任务没跑完时
   * 后到的消息会立刻进 onMessage —— 改前是**并发再起一个任务**（两个长任务各回执一次）。
   * 有了这张表：新消息可以先把旧任务打断，再按「原任务 + 补充要求」重跑。
   * `steerable` 标记该任务是否在可打断路径上（统一入口后会话层链路均可打断 → 恒真，
   * 会议分支虽走 executor 但累积是瞬时的，打断无害；见下方入表处）。
   */
  private inflightTasks = new Map<string, { abort: AbortController; startedAt: number; input: string; steerable: boolean }>();

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

  /**
   * B5「中途改」：结算该用户可能存在的在飞任务，算出本次真正要执行的输入。
   *
   * 返回：
   *   - `input`：本次执行的输入（无打断时原样返回）
   *   - `note` ：需要先推给用户的打断说明（无打断返回 ''）
   *
   * 规则（确定性，不做语义猜测）：
   *   1. 上一条**不在可打断路径**上（如 `/todo`）→ 不干预，两条各自跑完各自回执（= 改前行为）。
   *   2. 新消息以已知指令开头（`/todo` `/note` …）→ 视为**新指令**：只打断，不合并。
   *   3. 否则视为对上一条的**补充要求** → 与原任务合并重跑。
   *      这一步必须合并而不是直接跑新文本：否则「改成 3 页」会丢掉原任务，用户得重述一遍。
   */
  private supersedeInflight(to: string, input: string): { input: string; note: string } {
    const prior = this.inflightTasks.get(to);
    if (!prior || !prior.steerable) return { input, note: '' };

    prior.abort.abort(new Error('superseded by a newer message'));
    this.inflightTasks.delete(to);

    if (detectCommand(input)) {
      return { input, note: '⏹️ 已打断上一条（它还没跑完），先按这条新指令执行。' };
    }

    return {
      input: mergeSteeringInput(prior.input, input),
      note: '⏹️ 已打断上一条，按你的补充要求重跑（原任务 + 新要求）。',
    };
  }

  constructor() {
    // Node 端 self 地址，用于调用本地 Butler API
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
    // B5：解绑/停止时一并打断在飞任务并清表，避免登记项与其上游 fetch 悬空、
    // 或下一轮绑定后被一条来自上一会话的「补充要求」误合并。
    for (const t of this.inflightTasks.values()) {
      try { t.abort.abort(new Error('bridge stopped')); } catch { /* ignore */ }
    }
    this.inflightTasks.clear();
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
   * 服务端主动推送文本（日程提醒 / 定时报告 / 关闭前总结用）。
   *
   * 收件人优先取最近一次会话，其次退回凭证里绑定的用户 id —— 应用重启后还没收到过入站消息时
   * `lastFrom` 仍是空的，只看它会让「重启后的第一条日程提醒」静默丢推（这正是微信端收不到
   * 日程通知的一个原因）。未绑定 / 无收件人 / 轮询未运行时返回 false。
   */
  async pushText(text: string): Promise<boolean> {
    const to = this.lastFrom?.to || this.credentials?.userId;
    if (!this.credentials || !to || !this.running) return false;
    try {
      // 主动推送无消息上下文，contextToken 传空串即可
      await sendMessage(this.credentials, to, text, this.lastFrom?.token || '');
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /**
   * 出站媒体探针（B4 门禁）：向最近一次会话依次发送 文本标记 → 语音 → 文件 三条消息。
   *
   * 目的：验证 iLink 上行 voice_item / file_item 协议（sendVoice / sendFile 的字段结构是推定的，
   * 见 wechat-adapter.ts 注释）。用户在手机微信端看实际收到什么，回报结果——
   *   - 三条都收到 → 协议成立，B4 语音/文件推送全量推进；
   *   - 只收到文本 → iLink 不接受该 voice/file 结构 → 降级方案（文本+文件说明）。
   *
   * 前置：已绑定（credentials）且 lastFrom 就位（绑定后至少收到过一条微信消息）。
   * 素材程序生成（1 秒静音 WAV + 小文本文件），不依赖 TTS 配置；产物落临时目录用后即删。
   */
  async probeOutboundMedia(): Promise<{
    ok: boolean;
    reason?: string;
    results: Array<{ kind: 'text' | 'voice' | 'file'; sent: boolean; error?: string }>;
  }> {
    if (!this.credentials || !this.lastFrom) {
      return { ok: false, reason: '未绑定或尚无会话：请先扫码绑定，并在微信里给 bot 发一条消息，再运行探针', results: [] };
    }
    const { sendMessage, sendVoice, sendFile } = await import('./wechat-adapter');
    const { writeFile, unlink, mkdir } = await import('fs/promises');
    const { join } = await import('path');
    // 走 resolveAppRoot() 而非硬编码 homedir/BobWork —— 后者会绕开 BOBWORK_HOME 覆盖，
    // 导致开发隔离（dev isolation）下把产物写到真实用户目录。
    const { resolveAppRoot } = await import('@/lib/app-root');

    const results: Array<{ kind: 'text' | 'voice' | 'file'; sent: boolean; error?: string }> = [];
    const tmpDir = join(resolveAppRoot(), 'butler', 'tts');
    await mkdir(tmpDir, { recursive: true });
    const stamp = Date.now();
    const wavPath = join(tmpDir, `probe-${stamp}.wav`);
    const txtPath = join(tmpDir, `probe-${stamp}.txt`);

    // 1 秒静音 16kHz 16bit 单声道 WAV（44 字节头 + 32000 数据字节），程序生成、零依赖
    const sampleRate = 16000;
    const dataBytes = sampleRate * 2;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // 单声道
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataBytes, 40);
    await writeFile(wavPath, Buffer.concat([header, Buffer.alloc(dataBytes)]));
    await writeFile(txtPath, `BobWork outbound probe ${new Date().toISOString()}\n这是探针文件：若你在微信里看到它，说明 file_item 上行协议成立。\n`, 'utf-8');

    const to = this.lastFrom.to;
    const token = this.lastFrom.token || '';
    try {
      // ① 文本标记（基线：sendMessage 是已验证链路，它失败说明会话/token 问题，不是媒体协议问题）
      try {
        await sendMessage(this.credentials, to, `🔧 探针开始（${new Date().toLocaleTimeString('zh-CN')}）：接下来 10 秒内应收到 1 条语音 + 1 个文件`, token);
        results.push({ kind: 'text', sent: true });
      } catch (e) {
        results.push({ kind: 'text', sent: false, error: e instanceof Error ? e.message : String(e) });
      }

      // ② 语音（待验证协议）
      try {
        await sendVoice(this.credentials, to, wavPath, token);
        results.push({ kind: 'voice', sent: true });
      } catch (e) {
        results.push({ kind: 'voice', sent: false, error: e instanceof Error ? e.message : String(e) });
      }

      // ③ 文件（待验证协议）
      try {
        await sendFile(this.credentials, to, txtPath, token);
        results.push({ kind: 'file', sent: true });
      } catch (e) {
        results.push({ kind: 'file', sent: false, error: e instanceof Error ? e.message : String(e) });
      }

      const ok = results.every((r) => r.sent);
      if (!ok) this.lastError = results.find((r) => !r.sent)?.error;
      return { ok, results };
    } finally {
      // 探针素材用后即删（失败也删，避免 butler/tts 里堆 probe-* 垃圾）
      await unlink(wavPath).catch(() => {});
      await unlink(txtPath).catch(() => {});
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
   *  2) 距最后消息 ≥10 分钟 → 自动收尾：AI 整理纪要 → Butler 收件箱 + 推送纪要摘要到微信
   */
  private async tickMeetingSession(): Promise<void> {
    if (!this.credentials || !this.lastFrom || !this.running) return;
    try {
      // 1) 5 分钟静默提醒（提醒后用户继续发言会重置，进入下一轮计时）
      if (await isMeetingRemindDue()) {
        await markMeetingReminded();
        const st = await getMeetingState();
        await sendMessage(
          this.credentials,
          this.lastFrom.to,
          `⏳ 会议「${st.title}」已 5 分钟无新消息，5 分钟后将自动结束并整理纪要。可继续输入补充，或输入 /meeting out 立即整理。`,
          this.lastFrom.token || '',
        );
        return;
      }
      // 2) 10 分钟静默超时：自动收尾，并推送结果
      const expired = await consumeExpiredMeeting();
      if (expired) {
        // 尊重会议设置「会后自动整理」：关 = 只留全文转写，不调模型
        const settings = meetingSettingsOf(await readSettingsFromFile());
        let reply: string;
        if (settings.autoSummarize) {
          const minutes = await finalizeMeeting(expired, this.baseUrl, settings.speakers);
          reply = `会议「${expired.title}」已超时自动结束，纪要已发送到 Butler：${minutes ? `\n\n${minutes}` : '\n\n（纪要整理失败，请稍后在面板重试）'}`;
        } else {
          await recordMeetingTranscript(expired);
          reply = `会议「${expired.title}」已超时自动结束，未生成纪要（会议设置里「会后自动整理」已关闭）；全文转写已发送到 Butler。`;
        }
        await sendMessage(this.credentials, this.lastFrom.to, reply, this.lastFrom.token || '');
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
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      console.error('[wechat-bridge] startBinding error:', message || e);
      this.bindingState = { phase: 'error', error: message || 'Failed to fetch QR code' };
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
      } catch (e) {
        this.lastError = (e instanceof Error ? e.message : '') || 'Polling exited unexpectedly';
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
        // 欢迎语**直接复用 buildHelpText()**（commands.ts 的 BUTLER_COMMANDS 是唯一真源），
        // 不再手写一份指令清单 —— 手写副本会与实现漂移：旧文案曾声称「发消息即自动解析」、
        // 「直接问日程」，但 executor 的无指令分支早已改为**硬性拒绝**（AI 语义路由 2026-08 移除），
        // 导致新用户按欢迎语操作必然失败。复用它以后，增删命令/改子命令都会自动同步。
        const welcome = 'BobWork connected!\n\n' + buildHelpText();
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
          } catch (dlErr) {
            const detail = dlErr instanceof Error ? dlErr.message : String(dlErr);
            await sendMessage(creds, msg.from,
              `⚠️ ${typeName}下载/识别失败：${detail}。请重新发送或改发文字版本。`,
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

      const to = msg.from;
      const contextToken = msg.contextToken;

      // ── B5「中途改」：上一条还在跑就先打断，再按新要求重跑（详见 supersedeInflight） ──
      const steering = this.supersedeInflight(to, finalInput);
      const runInput = steering.input;
      if (steering.note) {
        try {
          await sendMessage(creds, to, steering.note, contextToken);
        } catch { /* 打断说明送达失败不影响主流程 */ }
      }

      // 执行超时保护：90s 内未完成先回一句"正在整理…"，完成后再异步推送结果。
      // 避免用户发"写一份 100 页合同"等任务让 typing 卡死、以为服务挂掉。
      const EXEC_TIMEOUT_MS = 90_000;
      const ac = new AbortController();
      // 统一入口（P0）：微信里所有输入都交给**管家**（会话层），斜杠命令先归一化成
      // 「意图：…」+ 正文（normalizeSlashInput），由管家按命令表调用自己的工具。
      // 暂留宿主 executor（P2 收敛后为宿主服务函数）的只有两类：
      //   · /meeting：会议缓冲是全局单场状态（非模型意图，需宿主直接读写）；
      //   · 会议进行中：一切输入都要累积进会议。
      const firstCmd = detectCommand(runInput);
      const execOnly =
        firstCmd?.id === 'meeting' ||
        (await isMeetingActive());
      this.inflightTasks.set(to, {
        abort: ac,
        startedAt: Date.now(),
        input: runInput,
        // 会话层链路均可打断（恒真）：会议分支虽走 executor，但累积是瞬时的，打断无害
        steerable: true,
      });
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
        if (execOnly) {
          result = await executeButlerCommand(runInput, { baseUrl: this.baseUrl });
        } else {
          // 会话层（/api/butler/threads → askButler）：恒管家身份 + channel='wechat'
          // （该通道按 WECHAT_ALLOWED_WRITES 白名单放行排程三件套/便签，其余写类只回话不执行）。
          // threadIdHint 固定为常驻通知助理「Bobby」线程（2026-09-28 起，原先的独立「Bobby」联系人退役，
          // 其名字与形象由通知助理沿用）：
          // 微信里说的话与桌面打开「Bobby」看到的是同一条会话 —— 跨端续聊共享上下文，且系统推送类
          // 通知（日程提醒等）也归在同一条流里，手机端天然能看到自己的这条会话。
          // **不再**借用「当前活动的桌面线程」（那会把微信消息串进用户正开着的好友会话，
          // 且桌面 30min 无活动就会话过期消失，用户回桌面找不到）。
          // source='panel' 让这条常驻会话长期保留（永不过期）；通道能力靠上面的 channel 显式给
          // —— 二者解耦（source 只管 TTL），node-chat 里 channel 优先取显式入参。
          const resp = await fetch(`${this.baseUrl}/api/butler/threads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: ac.signal,
            body: JSON.stringify({
              text: normalizeSlashInput(runInput),
              source: 'panel',
              channel: 'wechat',
              threadIdHint: NOTIFY_THREAD_ID,
            }),
          });
          const data = (await resp.json()) as {
            success?: boolean; reply?: string; threadId?: string; aborted?: boolean; error?: string;
          };
          result = data.success
            ? { ok: true, reply: data.reply ?? '', command: null, threadId: data.threadId }
            : {
                ok: false,
                reply: data.error ?? '请求失败，请稍后重试',
                command: null,
                aborted: data.aborted === true,
                threadId: data.threadId,
              };
        }
      } finally {
        clearTimeout(timeoutHandle);
        // 仅当登记项仍是「自己」时才清理（若已被后来者替换，映射里已是新任务，不能误删）
        if (this.inflightTasks.get(to)?.abort === ac) this.inflightTasks.delete(to);
        // 执行完成（无论成功失败）：释放 inflight 强锁，避免后续异常导致锁泄漏
        await this.releaseInflightMessage(msg);
      }
      // 被主动打断（用户改需求）→ 本次不回执：重跑的那次会给结果，否则用户会先收到一条无意义回执
      if (result.aborted) return;
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
        // 主动回推失败时记录，用于用户手动查看 Butler 抽屉结果
        this.lastError = `Failed to push reply: ${se instanceof Error ? se.message : String(se)}`;
      }
    } catch (e) {
      this.lastError = (e instanceof Error ? e.message : '') || 'Message processing failed';
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

declare global {
  // eslint-disable-next-line no-var
  var __wechatBridgeSingleton__: WechatBridge | undefined;
}

export const wechatBridge: WechatBridge =
  globalThis.__wechatBridgeSingleton__ ??= new WechatBridge();
