/**
 * /api/butler/threads —— Butler 线程入口（会话身体，Phase 4）
 *
 * POST 发消息：接收问题文本 → 交给 Butler 对话入口（自有线程存储 `.state/threads/`）
 *   → 聚合回复返回（或 stream=true 时 SSE 透传）。浏览器端与微信桥（Node 端）共用。
 *
 * 线程复用机制：
 *   body.reuseThreadId = 调用方指定的复用 threadId → 复用该线程历史（保持 LLM 上下文）
 *   body.threadIdHint  = 调用方传入的权威线程 ID（优先）
 *   未传或线程已过期 → 自动新建线程（前缀 b-）
 * 执行模式：
 *   - 缺省（聚合）：读到流结束聚合为一个 JSON 回复（微信桥沿用）
 *   - body.stream=true（流式）：**身份=butler 的完整画像**，SSE 原样透传 →
 *     前端边读边渲染，butler_confirm 挂起确认卡才能落到用户手里
 * 生命周期：
 *   线程决议由调用方给（threadIdHint / reuseThreadId），缺省新建
 *   wechat 线程 24 小时过期 / panel 线程长期保留（threads.ts，60s sweep 兜底清理）
 *
 * GET  线程历史：无参数列线程摘要，?threadId= 取单条全文（Butler 抽屉「Chats」面板）
 * DELETE 删除线程：?threadId= 删单条；无参数兼容旧调用（只清过期）
 */
import { NextRequest, NextResponse } from 'next/server';
import { askButler, streamButlerTurn } from '@/lib/butler/entry';
import {
  deleteThread,
  listThreads,
  readThread,
  sweepThreads,
} from '@/lib/butler/threads';
import { messageTimeAt, parseThinkingLevel } from '@/lib/butler/threads-shared';
import { buildNotifySummary, NOTIFY_THREAD_ID } from '@/lib/core/butler-notify';
import { buildRecorderSummary, RECORDER_THREAD_ID } from '@/lib/core/butler-recorder';
import { buildSearchSummary, SEARCH_THREAD_ID } from '@/lib/core/butler-search';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      text?: string;
      reuseThreadId?: string | null;
      threadIdHint?: string;
      source?: 'panel' | 'wechat';
      /** 通道能力标记（与会话 source 解耦）：微信桥落常驻线程时 source='notify'
       *  但 channel 仍为 'wechat'（写类按白名单收口）。缺省按 source 推导。 */
      channel?: 'panel' | 'wechat' | 'feishu';
      /** Butler 抽屉（悬浮球）流式模式：返回 SSE 透传流而非聚合 JSON。
       *  必须流式，否则 butler_confirm 挂起确认卡永远到不了前端（见 lib/butler/entry.ts 注释）。 */
      stream?: boolean;
      /** 会话级选型（抽屉的模型下拉 / 思考档位）：本轮用它；null = 明确回到自动 / 默认档；
       *  缺省（微信桥等）= 沿用线程里存的选择。清洗见 threads-shared.parseModelTag / parseThinkingLevel。 */
      modelId?: string | null;
      thinkingLevel?: string | null;
    };
    const question = (body.text || '').trim();
    if (!question) {
      return NextResponse.json({ success: false, error: 'Please enter a question for the chat' });
    }

    // 浏览器端为相对路径（baseUrl 为空），Node 端（微信桥）显式传服务地址
    const base = new URL(request.url).origin;

    // ── 流式路径（Butler 抽屉）：身份=butler（完整画像 + 确认卡），SSE 原样透传 ──
    if (body.stream === true) {
      return await streamButlerTurn(question, {
        baseUrl: base,
        reuseThreadId: typeof body.reuseThreadId === 'string' ? body.reuseThreadId : null,
        threadIdHint: typeof body.threadIdHint === 'string' ? body.threadIdHint : undefined,
        source: body.source ?? 'panel',
        // 选型原样下传（清洗在 entry 侧统一做）：undefined 与 null 语义不同——null = 回自动，不可合并
        modelId: body.modelId,
        thinkingLevel: parseThinkingLevel(body.thinkingLevel),
      });
    }

    const result = await askButler(question, {
      baseUrl: base,
      reuseThreadId: typeof body.reuseThreadId === 'string' ? body.reuseThreadId : null,
      threadIdHint: typeof body.threadIdHint === 'string' ? body.threadIdHint : undefined,
      source: body.source,
      channel: body.channel,
      modelId: body.modelId,
      thinkingLevel: parseThinkingLevel(body.thinkingLevel),
      // B5「中途改」：调用方（微信桥）打断请求 → 本次上游 /api/chat 立刻中止，
      // 不写线程、不回执；重跑的那次负责回执。客户端已断开时这个 JSON 也送不到，属预期。
      signal: request.signal,
    });

    if (!result.ok) {
      return NextResponse.json({
        success: false,
        aborted: result.aborted === true,
        error: result.reply,
        threadId: result.threadId,
      });
    }
    return NextResponse.json({
      success: true,
      reply: result.reply,
      messages: result.messages,
      threadId: result.threadId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/threads] 执行失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

/**
 * GET /api/butler/threads — 线程历史（Butler 抽屉联系人列 + 当前联系人时间线）。
 *   ?threadId=xxx → 该线程的消息 + 与之平行的逐条时间戳数组（times，剥 system 后仍对齐）
 *   无参数        → 线程列表摘要；**常驻「通知助理」/「Recorder」合成摘要永远置顶**（pinned: true，
 *                   各带 systemRole 身份标记供前端区分）
 */
export async function GET(request: NextRequest) {
  try {
    const threadId = new URL(request.url).searchParams.get('threadId');
    if (threadId) {
      const thread = await readThread(threadId);
      // 404 = 不存在或已过期（readThread 对过期线程读到即删）→ 前端刷新列表，不改当前线程
      if (!thread) return NextResponse.json({ success: false, error: 'thread not found' }, { status: 404 });
      // 逐条时间戳：通知助理的时间线要把「通知行」与「追问往返」按时间归并，只有 updatedAt 不够用
      const rows = thread.messages
        .map((m, i) => ({
          m,
          t: messageTimeAt(thread.tailTimes, thread.messages.length, thread.updatedAt, i),
          i,
        }))
        .filter((r) => r.m.role !== 'system');
      return NextResponse.json({
        success: true,
        threadId,
        updatedAt: thread.updatedAt,
        // 会话级选型：抽屉切换联系人时用它回填模型下拉 / 档位（null = 未选 → 自动 / 默认档）
        modelId: thread.modelId ?? null,
        thinkingLevel: thread.thinkingLevel ?? null,
        // 会话级工作区：切联系人时回填「锁定操作范围」pill（null = 未指定）
        workspaceFolder: thread.workspaceFolder ?? null,
        messages: rows.map((r) => r.m),
        times: rows.map((r) => r.t),
        // 逐条消息在**服务端 messages 数组**里的下标（与 messages 同序同长），前端拿它拼气泡 id。
        // ⚠️ 只是**提示**，不是删除的凭据：线程会被 trimThreadMessages 裁头，裁过之后旧气泡上的
        //    下标就整体偏大——按它删会删错行。DELETE .../messages 按 role + 正文认领，
        //    这里给的下标只在两条正文逐字相同时帮着认准是哪一条。
        // ⚠️ 不能用「剥掉 system 之后的顺序号」当下标：system 恒在数组里（每轮重注入），
        //    有它没它差一位。
        indexes: rows.map((r) => r.i),
      });
    }
    // 置顶合成「通知助理」+「Recorder」+「小微」+ 其余线程（listThreads 本身不动，这里按 threadId 把它们滤掉，
    // 否则用户在这些常驻线程里追问过之后，它们会以普通线程的身份再出现在列表里）。
    const [notify, recorder, search, threads] = await Promise.all([
      buildNotifySummary(),
      buildRecorderSummary(),
      buildSearchSummary(),
      listThreads(),
    ]);
    return NextResponse.json({
      success: true,
      sessions: [
        notify,
        recorder,
        search,
        ...threads.filter(
          (s) =>
            s.threadId !== NOTIFY_THREAD_ID &&
            s.threadId !== RECORDER_THREAD_ID &&
            s.threadId !== SEARCH_THREAD_ID,
        ),
      ],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/threads] 读取线程失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

/**
 * DELETE /api/butler/threads
 *   ?threadId=xxx → 删除该线程（联系人列里删单条）；常驻「通知助理」/「Recorder」不可删（400）
 *   无参数        → 兼容旧调用：只清理过期线程
 * 生命周期：
 *   - 过期清理：startThreadSweeper 每 60s 扫过期线程
 *   - 启动兜底：instrumentation → startThreadSweeper 先跑一次
 */
export async function DELETE(request: NextRequest) {
  try {
    const threadId = new URL(request.url).searchParams.get('threadId');
    if (threadId) {
      // 常驻联系人（通知助理 / Recorder / 小微）：删掉它就再没有归属入口，一律拒绝
      if (threadId === NOTIFY_THREAD_ID || threadId === RECORDER_THREAD_ID || threadId === SEARCH_THREAD_ID) {
        return NextResponse.json({ success: false, error: 'resident thread cannot be deleted' }, { status: 400 });
      }
      await deleteThread(threadId);
      return NextResponse.json({ success: true });
    }
    await sweepThreads();
    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/threads] 删除线程失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}