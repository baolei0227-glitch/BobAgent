'use client';

/**
 * MeetingConsole —— 会议模式控制台（Butler 抽屉中栏的会议视图）
 *
 * 会议进行中，中栏从「聊天时间线」让位给本控制台：顶部条（红点 + 波形 + 计时 + 已记录条数 +
 * Pause / End）+ 实时字幕流。输入框仍在下方——会议中的任何输入同样会被记入缓冲（见 executor）。
 *
 * 字幕流分两层：**已定稿**条目来自本地流式引擎每次判出的停顿（onSegment → 落库 → 快照），
 * 一行一句；**实时草稿行**来自同一路链路的中间结果（onPartial，边说边写），只显示当前正在说的
 * 这一句，停顿定稿时被上面的正式条目替换。云端 STT 走录制链路、不产中间结果，此时只有定稿条目。
 *
 * **会议进行中不做说话人识别**：字幕不带说话人，`[说话人 N]` 只可能来自会后的整段重转
 * （见 doEnd 的 retranscribe）。实时分人那条链路（旁挂 PCM 采样 + 滚动窗口分离 + 回填标签）
 * 已整体下线——十几秒窗口的聚类不稳，且每轮都要起一整个分离 CLI 与流式转写抢 CPU，
 * 观感是「说话人乱跳 + 字幕卡」。
 *
 * 标点即时、定稿延后：会议期间转写走 skipFinalizeRefine（见下），**只跳过离线重转** ——
 * 每次停顿定稿都用常驻标点服务给该句补句读（~3ms，字幕就是飞书那种带标点的观感），
 * 但不跑离线重转（分段太频繁，重转只会拖慢分段并白攒 38MB PCM）。结束后由 doEnd 在后台统一收尾：
 * 优先用**录音整体重转**（离线批量模型，更准且时间轴与录音对齐），不可用时退化为只给
 * 语音段补标点；手打的文本消息两种路径都不会被改写。
 *
 * 两条独立的麦克风通道（互不干扰）：
 *   1) 转写（本文件复用 useVoiceInput）：一句话一落库（emitSegments → 停顿即 onSegment → append），
 *      字幕因此边录边出。**整场会议只开一条会话**：不再每 SEGMENT_MS 主动收尾换块——
 *      收尾会关掉采集用的 AudioContext，空窗里的麦克风音频是彻底丢字（用户报的「卡顿、不识别」
 *      主因），而换块原本只是为了绕开 provider 的单次录音上限（FINALIZE_MAX_SAMPLES 10 分钟），
 *      会议模式走 skipFinalizeRefine 根本不累积 PCM，该上限不适用。转写会话只在暂停/结束时收尾。
 *      伴生两条兜底（一条会话就是唯一命脉）：provider 每 60s 发一次 keepalive 续期常驻引擎
 *      （否则空闲 3 分钟就被回收）；链路意外断/卡死 → onSessionLost 收尾当前轮并重开一轮（见下）。
 *   2) 录音落盘（**本文件自建 MediaRecorder，不复用 useVoiceInput**）：整场会议保持一条麦克风流，
 *      MediaRecorder(stream).start(SEGMENT_MS) 每段产出一个 webm 分片，写入会议输出目录
 *      （`录音 - <标题> - part-00N.webm`）。为何不共用 useVoiceInput：它每段收尾都会 stop tracks
 *      （约定「录音不落盘」），拿不到可持续的流。**分片长度与字幕换行无关**。
 *
 * 结束：等最后一段转写落库 + 最后一个录音分片落盘 → POST action=end（服务端只结束会话、不跑模型）→
 * 先把全文转写落到**会议输出目录**（项目内 or butler），随后控制台让位、面板跳到 History。
 * 纪要由后台单独调 action=summarize 生成后补落，期间 History 显示「Generating…」提示（见 MeetingWrapUp）。
 * 落盘失败才回退「未保存」（transient）暂存，不再自动打开文件。
 *
 * 录音源（会议设置 · recordingSource）：麦克风 / 系统音频 / 两者。挂载时按设置打开采集流并**两条通道共用**——
 *   转写通道经 useVoiceInput 的 getMediaStream 注入同一条流；录音通道交给 MediaRecorder。
 *   系统音频走 getDisplayMedia({audio})（Electron 主进程已注册 loopback handler，macOS 14.2+ / Windows 可用）；
 *   两者 = 用 AudioContext 把麦克风与系统音频混成一路。采集失败时提示并回退到麦克风（转写仍可用）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Loader2, Pause, Play, Square } from 'lucide-react';
import { useVoiceInput } from '@/components/ui/voice-input';
import { putTransientFile } from '@/lib/files/sources';
import type { MeetingRecordingSource } from '@/lib/settings';

/**
 * 单个**录音分片**时长：到点即换一块上传续录（远小于 provider 的 10 分钟上限）。
 * 它**只**决定录音文件怎么分片（`录音 - <标题> - part-00N.webm`），与字幕换行无关——
 * 字幕的「句」由引擎判停决定（见文件头）。
 */
const SEGMENT_MS = 45_000;
/** 中栏工具行 / 控制台的分割线（与 ButlerDrawer 同款，避免跨文件共享常量） */
const DIVIDER_SOFT = '1px solid color-mix(in oklab, var(--line-soft) 40%, transparent)';

export interface MeetingMessageItem {
  type: string;
  label: string;
  text: string;
  time: number;
}

export interface MeetingSnapshot {
  active: boolean;
  title: string | null;
  startedAt: number;
  count: number;
  messages: MeetingMessageItem[];
  /** 产物落点：'project' = 当前项目内；'butler' = butler 根下 */
  outputKind: 'project' | 'butler';
  /** 产物目录（相对路径，空 = 默认） */
  outputDir: string;
}

/** 秒 → mm:ss（会议计时 / 字幕时间戳共用） */
function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 文件名安全化：会议标题里的 `:` 等文件系统非法字符在落盘时会出问题，统一替换为 `-`（导出给 MeetingStart 复用） */
export function safeName(s: string): string {
  const name = s.replace(/[\\/:*?"<>|\n\r\t]+/g, '-').trim();
  return name || 'Meeting';
}

/** 相对路径拼接（目录可为空） */
function relPath(dir: string, fileName: string): string {
  const d = dir.replace(/\/+$/, '');
  return d ? `${d}/${fileName}` : fileName;
}

/**
 * 写一份产物到会议输出目录，返回可直接打开的文件引用。
 * - project：走 /api/projects?action=write_file（需当前项目 id）
 * - butler ：走 /api/butler/meeting?action=write（服务端固定根 = butlerRoot，做穿越防护）
 * 落盘失败即抛错，由调用方决定回退（纪要）或提示（录音）。
 * 导出给 MeetingStart 的导入录音模式复用（产物落盘口径必须与实时模式一致）。
 */
export async function writeOutput(
  kind: 'project' | 'butler',
  dir: string,
  fileName: string,
  content: string,
  encoding?: 'base64',
): Promise<{ source: 'project' | 'local'; path: string; name: string }> {
  const rel = relPath(dir, fileName);
  if (kind === 'project') {
    const projectId = await fetch('/api/projects')
      .then((r) => r.json())
      .then((d) => String(d?.current_id || ''))
      .catch(() => '');
    if (!projectId) throw new Error('No current project');
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'write_file',
        project_id: projectId,
        file_path: rel,
        content,
        ...(encoding ? { encoding } : {}),
      }),
    });
    const data = await resp.json();
    if (!data?.success) throw new Error(String(data?.error || 'Failed to write file'));
    return { source: 'project', path: String(data.path || rel), name: fileName };
  }
  const resp = await fetch('/api/butler/meeting', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'write', path: rel, content, ...(encoding ? { encoding } : {}) }),
  });
  const data = await resp.json();
  if (!data?.success) throw new Error(String(data?.error || 'Failed to write file'));
  return { source: 'local', path: String(data.absPath || ''), name: fileName };
}

/**
 * 会议收尾的跨卸载状态（模块级，活在 React 组件之外）。
 *
 * 为什么需要：结束后控制台会**立即卸载**（让位给 MeetingStart），而纪要生成（调模型）还在后台跑。
 * 生成的 Promise 继续在闭包里推进（只需 fetch + writeOutput），这里用一个模块级状态把「还在生成」
 * 告诉 MeetingStart：它据此在过往会议列表顶部显示 Generating… 占位，生成完再收到通知刷新列表。
 */
export interface MeetingWrapUp {
  /** 会议标题（History 的生成提示里展示） */
  title: string;
  /** 后台是否仍在生成纪要 */
  summarizing: boolean;
  /**
   * 后台「用录音整体重转」的进度（秒）；null = 未在重转。
   * 重转要跑几十秒到几分钟，没有它用户会以为卡死——History 顶部据此显示百分比。
   */
  progress: { doneSec: number; totalSec: number } | null;
}

let wrapUp: MeetingWrapUp | null = null;
const wrapUpListeners = new Set<() => void>();
const emitWrapUp = () => { wrapUpListeners.forEach((l) => l()); };

/** 结束会议时登记收尾状态（由控制台的收尾流程调用） */
export function beginMeetingWrapUp(w: MeetingWrapUp): void {
  wrapUp = w;
  emitWrapUp();
}

/** 重转进度更新（服务端 NDJSON 流每完成一个窗口推一次） */
export function setMeetingWrapUpProgress(progress: { doneSec: number; totalSec: number } | null): void {
  if (!wrapUp) return;
  wrapUp = { ...wrapUp, progress };
  emitWrapUp();
}

/** 后台收尾（重转 + 纪要生成）全部结束时调用：撤下提示，通知面板刷新列表 */
export function endMeetingWrapUp(): void {
  if (!wrapUp) return;
  // 无条件 emit：收尾阶段可能重写过会议记录（重转/补标点），要保证面板**最终**再拉一次列表，
  // 否则「关闭自动整理」这条路径下新正文看不到（那条路径 summarizing 本就是 false，早退会吞掉这次刷新）。
  wrapUp = { ...wrapUp, summarizing: false, progress: null };
  emitWrapUp();
}

export function getMeetingWrapUp(): MeetingWrapUp | null {
  return wrapUp;
}

/** retranscribe 的流式结局：done = 拿到重转正文；skip = 不可用（保留流式原文） */
type RetranscribeOutcome =
  | { kind: 'done'; transcript: string; plain: string }
  | { kind: 'skip'; reason: string };

/**
 * 读服务端 retranscribe 的 **NDJSON 流**响应。
 *
 * 为什么不用一次性 JSON：长会议要跑几十秒到几分钟，只有流式才能在跑的过程中把进度
 * 推到 History 顶部（服务端每完成一个转写窗口推一行）。
 * 行缓冲负责粘包——网络分块可能把一行截断在两块之间，所以最后一段半行要留到下一轮。
 */
async function readRetranscribe(
  resp: Response,
  onProgress: (p: { doneSec: number; totalSec: number }) => void,
): Promise<RetranscribeOutcome> {
  if (!resp.ok || !resp.body) return { kind: 'skip', reason: `http-${resp.status}` };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let outcome: RetranscribeOutcome = { kind: 'skip', reason: 'stream-ended' };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(s);
      } catch {
        continue; // 坏行不致命：跳过，继续读后面的
      }
      if (msg.t === 'progress') {
        const doneSec = Number(msg.doneSec);
        const totalSec = Number(msg.totalSec);
        if (Number.isFinite(doneSec) && Number.isFinite(totalSec) && totalSec > 0) {
          onProgress({ doneSec, totalSec });
        }
      } else if (msg.t === 'done') {
        outcome = { kind: 'done', transcript: String(msg.transcript || ''), plain: String(msg.plain || '') };
      } else if (msg.t === 'skip') {
        outcome = { kind: 'skip', reason: String(msg.reason || 'skipped') };
      }
    }
  }
  return outcome;
}

export function subscribeMeetingWrapUp(l: () => void): () => void {
  wrapUpListeners.add(l);
  return () => { wrapUpListeners.delete(l); };
}

/** Blob → 纯 base64（去掉 data: 前缀，供 write_file 的 encoding:'base64' 使用） */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * 打开会议采集流（按「录音源」设置）；返回 stream 与一个释放回调（停轨 + 关 AudioContext）。
 * - microphone：仅麦克风
 * - system    ：仅系统音频（Electron 主进程 setDisplayMediaRequestHandler 已静默附 loopback 音轨，
 *              不弹选择器；macOS 14.2+ / Windows 可用，Linux 无 loopback 会失败 → 由调用方提示回退）
 * - both      ：两路经 AudioContext 混成一路（喂给 MediaRecorder / 转写都不能是两轨）
 */
async function openCaptureStream(source: MeetingRecordingSource): Promise<{ stream: MediaStream; stop: () => void }> {
  const opened: MediaStream[] = [];
  let ctx: AudioContext | null = null;

  const openMic = async (): Promise<MediaStream> => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    opened.push(s);
    return s;
  };
  // getDisplayMedia 必须要 video，拿到后立刻释放视频轨，只留音频
  const openSystem = async (): Promise<MediaStream> => {
    const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    s.getVideoTracks().forEach((t) => t.stop());
    opened.push(s);
    return s;
  };

  let stream: MediaStream;
  if (source === 'microphone') {
    stream = await openMic();
  } else if (source === 'system') {
    stream = await openSystem();
  } else {
    const [mic, sys] = [await openMic(), await openSystem()];
    const Ctor: typeof AudioContext | undefined =
      typeof window !== 'undefined'
        ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!Ctor) throw new Error('Web Audio is unavailable for mixing microphone and system audio');
    ctx = new Ctor();
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(mic).connect(dest);
    ctx.createMediaStreamSource(sys).connect(dest);
    stream = dest.stream;
  }

  return {
    stream,
    stop: () => {
      opened.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      stream.getTracks().forEach((t) => t.stop());
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
    },
  };
}

export function MeetingConsole({
  snapshot,
  onRefresh,
  onEnded,
  visible = true,
}: {
  snapshot: MeetingSnapshot;
  /** 追加一段后立即重取快照（字幕不必等下一次轮询） */
  onRefresh: () => void;
  /** 会议已结束（服务端状态已清空）→ 调用方关闭控制台 */
  onEnded: () => void;
  /** 本视图是否可见：控制台常驻挂载（卸载=停录），被切走/收起时由外层置 false 隐藏 */
  visible?: boolean;
}) {
  const [running, setRunning] = useState(true);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 未落库的转写段数：结束时须等它归零，否则最后一句会丢 */
  const pendingRef = useRef(0);
  const [pendingTick, setPendingTick] = useState(0);
  const endedRef = useRef(false);
  /** running / ending 的镜像：链路断掉的回调由组件外部触发，读不到渲染期闭包里的 state */
  const runningRef = useRef(true);
  const endingRef = useRef(false);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { endingRef.current = ending; }, [ending]);
  /**
   * 意外断链的处理入口：provider 的 onSessionLost 在 useVoiceInput 调用时就绑定了，
   * 而它要用到的 finish/endingRef 在那之后才有——故用 ref 转发到最新实现。
   */
  const onSessionLostRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 字幕流是否贴底：用户上滑看前文时置 false，暂停自动滚动（否则新字幕一来就把视图拽回底部） */
  const [pinned, setPinned] = useState(true);
  /** 实时链路的「未定稿」文本：本地流式引擎边说边写，定稿（onText）时清掉、由字幕流接管。
   *  录制链路（云端 STT）不产中间结果，此值恒为空 → 该行不出现。 */
  const [liveDraft, setLiveDraft] = useState('');

  // ---- 录音（按「录音源」打开的采集通道）----
  const captureRef = useRef<{ stream: MediaStream; stop: () => void } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  /** 采集就绪（或已判定失败 → 转写回退自建麦克风）：转写首段须等它，避免抢在注入流之前用自建麦克风 */
  const [captureReady, setCaptureReady] = useState(false);
  /** 已产出的录音分片序号（落盘文件名 part-00N） */
  const partRef = useRef(0);
  /** 串行化录音写入（保证分片按序落盘、且结束前能一次 await 全部写完） */
  const audioChainRef = useRef<Promise<void>>(Promise.resolve());
  /**
   * 当前转写轮的**采集起点**（绝对毫秒）。字幕时间轴用它而不是「转写返回时刻」——
   * 否则每条字幕都会偏晚一次转写往返，暂停后重开还会整轮错位。
   * 按句落库后它只在没有句锚点时兜底（收尾那一刻正在说的那一句）。
   */
  const segStartRef = useRef(Date.now());
  /**
   * 待落库句子的**句首时刻**队列（FIFO，绝对毫秒）。为什么是队列而不是单个值：
   * 定稿要过标点服务（异步 ~3ms），下一句的中间结果可能在这之前就到了——单个 ref 会被
   * 下一句覆盖，使这一句拿到下一句的时间戳；按到达顺序排队、定稿时取队首，就始终取到自己那一句。
   * 句首时刻取「这一句第一个中间结果到达的时刻」：不含转写往返，回放时与录音对得齐。
   */
  const sentStartsRef = useRef<number[]>([]);
  /** 草稿行当前是否有字：用来识别「新一句开始」（从空变非空）→ 记一次句首时刻 */
  const draftActiveRef = useRef(false);
  /** 串行化字幕落库：服务端的 append 是 read-modify-write，并发写会互相覆盖（丢行 / 乱序），必须排队 */
  const appendChainRef = useRef<Promise<void>>(Promise.resolve());
  /** 产物落点（避免录音回调闭包读到陈旧快照；标题/目录在会议期间不变） */
  const outputRef = useRef<{ kind: 'project' | 'butler'; dir: string; title: string }>({
    kind: snapshot.outputKind,
    dir: snapshot.outputDir,
    title: snapshot.title ?? '',
  });
  useEffect(() => {
    outputRef.current = {
      kind: snapshot.outputKind,
      dir: snapshot.outputDir,
      title: snapshot.title ?? '',
    };
  }, [snapshot.outputKind, snapshot.outputDir, snapshot.title]);

  /** 排入一个录音分片的落盘任务（链式串行；失败只提示，不打断录音） */
  const enqueueAudio = useCallback((blob: Blob) => {
    audioChainRef.current = audioChainRef.current.then(async () => {
      const { kind, dir, title } = outputRef.current;
      partRef.current += 1;
      const name = `录音 - ${safeName(title)} - part-${String(partRef.current).padStart(3, '0')}.webm`;
      try {
        const b64 = await blobToBase64(blob);
        await writeOutput(kind, dir, name, b64, 'base64');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save recording');
      }
    });
  }, []);

  // 挂载即按「录音源」打开采集流并开录；卸载收流。整场会议保持同一条流（不随转写分段而停）。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 先读会议设置（录音源）；读不到就回退默认（仅麦克风）
      let source: MeetingRecordingSource = 'microphone';
      try {
        const r = await fetch('/api/butler/meeting', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'settings_get' }),
        });
        const d = await r.json();
        if (d?.success && d.settings?.recordingSource) {
          source = d.settings.recordingSource as MeetingRecordingSource;
        }
      } catch { /* 读设置失败 → 默认麦克风 */ }
      if (cancelled) return;

      try {
        const cap = await openCaptureStream(source);
        if (cancelled) { cap.stop(); return; }
        captureRef.current = cap;
        const rec = new MediaRecorder(cap.stream, { mimeType: 'audio/webm' });
        rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) enqueueAudio(e.data); };
        recorderRef.current = rec;
        rec.start(SEGMENT_MS);
      } catch (e) {
        // 采集失败：提示原因；转写通道会回退自建麦克风（getMediaStream 返回 null），会议不中断
        setError(e instanceof Error ? e.message : 'Failed to open the audio source');
      } finally {
        setCaptureReady(true);
      }
    })();
    return () => {
      cancelled = true;
      const rec = recorderRef.current;
      if (rec && rec.state !== 'inactive') {
        try { rec.stop(); } catch { /* 忽略 */ }
      }
      captureRef.current?.stop();
      captureRef.current = null;
    };
  }, [enqueueAudio]);

  // Pause / Resume 联动录音：暂停不产分片，续录后继续（转写通道由既有逻辑单独控制）
  useEffect(() => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (!running && rec.state === 'recording') rec.pause();
    else if (running && rec.state === 'paused') rec.resume();
  }, [running]);

  /** 停止录音并等最后一枚分片 flush（dataavailable → 入队 → 链尾） */
  const stopRecorder = useCallback(() => new Promise<void>((resolve) => {
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') {
      resolve();
      return;
    }
    rec.addEventListener('stop', () => resolve(), { once: true });
    try { rec.stop(); } catch { resolve(); }
  }), []);

  // 秒表：只在"计时基准"变化时重建 interval（快照每 3s 换新对象，不能进 deps）
  const startedAt = snapshot.startedAt;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const tick = () => setElapsed((Date.now() - startedAt) / 1000);
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  /**
   * 落库一句字幕（type=voice，供服务端区分文字输入与语音）。
   * at = 这一句的**句首时刻**（回放按它对齐录音；缺省用本轮采集起点兜底）。
   * 走 appendChainRef 串行：服务端 append 是 read-modify-write，并发写会互相覆盖丢行。
   */
  const appendSegment = useCallback((raw: string, at?: number) => {
    const text = raw.trim();
    if (!text) return;
    const time = at || segStartRef.current;
    // pendingRef 在入队时同步 +1：doEnd 靠它等「还在排队 / 在飞的落库」，延到链里加会漏等
    pendingRef.current += 1;
    appendChainRef.current = appendChainRef.current.then(async () => {
      try {
        await fetch('/api/butler/meeting', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'append', text, type: 'voice', time }),
        });
      } catch {
        /* 落库失败不打断录音：字幕少一段，但会议可继续 */
      } finally {
        pendingRef.current -= 1;
        setPendingTick((n) => n + 1);
        onRefresh();
      }
    });
  }, [onRefresh]);

  /** 把按录音源合成好的采集流交给转写通道（未就绪 / 采集失败时返回 null → 转写回退自建麦克风） */
  const getMediaStream = useCallback(() => captureRef.current?.stream ?? null, []);

  const { start, finish, recording, transcribing, barsRef } = useVoiceInput({
    // 收尾时交出的**余量**（最后一句还没等到停顿就收尾了）：单独落一行，
    // 用它自己的句首时刻定位；交完清掉句锚点与「草稿有字」标记。
    onText: (text) => {
      setLiveDraft('');
      // 收尾的余量可能把几段「还没来得及按句发出」的文字并成一行，用最早那个句锚点定位，
      // 其余锚点一并清掉——否则会泄漏到下一轮，把下一句配到错误的起点上。
      const at = sentStartsRef.current[0];
      sentStartsRef.current.length = 0;
      draftActiveRef.current = false;
      void appendSegment(text, at);
    },
    onError: (reason) => setError(reason),
    onStartError: (reason) => setError(reason),
    // 实时中间结果（仅本地流式链路回调）：只显示「当前正在说的这一句」（草稿行）。
    // 草稿从空变非空 = 新一句开始 → 记下它的句首时刻（定稿时按 FIFO 取回）。
    onPartial: (text) => {
      const active = text.trim().length > 0;
      if (active && !draftActiveRef.current) sentStartsRef.current.push(Date.now());
      draftActiveRef.current = active;
      setLiveDraft(text);
    },
    // 作废（取消 / 无识别结果 / 流式没起来退回录制链路）：草稿行、句锚点一并撤掉
    onDiscard: () => {
      setLiveDraft('');
      sentStartsRef.current.length = 0;
      draftActiveRef.current = false;
    },
    // 停顿即定稿：本地流式引擎每判出一次停顿 → 这一句单独落一行（字幕的「句」）
    onSegment: (text) => {
      if (!text.trim()) return; // 空段（纯静音定稿）不占句锚点，也不落空行
      const at = sentStartsRef.current.shift();
      draftActiveRef.current = false;
      void appendSegment(text, at);
    },
    // 链路意外中断/卡死：收尾当前段（拿到余量、落库），running 仍为真 → 上面的「续录」effect
    // 会重开一轮。没有这条兜底，一次断链会让这一场剩下的时间静默地不再转写。
    onSessionLost: () => onSessionLostRef.current?.(),
    getMediaStream,
    // 会议期间不做离线重转定稿（收尾重转只会拖慢分段并白攒 PCM）；标点照做——
    // 常驻标点服务 ~3ms/句，每句字幕都带句读。结束后 doEnd 仍会用录音整体重转兜底。
    skipFinalizeRefine: true,
    // 按句交出结果：停顿即 onSegment，收尾余量走 onText
    emitSegments: true,
  });

  // 续录：一轮收尾（转写完毕）且仍在录制态 → 自动开下一轮（等采集就绪再开，避免首轮用错源）。
  // 触发场景只有两个：用户从暂停恢复、链路断掉后重连（正常会议期间不会有周期性的收尾）。
  useEffect(() => {
    if (!running || !captureReady) return;
    if (!recording && !transcribing) {
      segStartRef.current = Date.now(); // 兜底锚点（句锚点缺失时用它给这一句定位）
      start();
    }
  }, [running, captureReady, recording, transcribing, start]);

  /**
   * 转写链路意外中断的恢复（onSessionLost → 这里）：
   * 收尾当前轮（把已收到的余量落库）后**不**停 running —— 上面的「续录」effect 会立刻重开一轮。
   * 只在「正在录」且「不是在结束流程里」时才动，避免和 pause / end 抢。
   */
  useEffect(() => {
    onSessionLostRef.current = () => {
      if (endingRef.current || !runningRef.current) return;
      setError('Live transcription stream dropped — reconnecting…');
      finish(false);
    };
  }, [finish]);

  const pause = useCallback(() => {
    setRunning(false);
    if (recording) finish(false); // 收尾当前轮（保留已说的内容）
  }, [recording, finish]);

  const resume = useCallback(() => {
    setError(null);
    setRunning(true);
  }, []);

  const doEnd = useCallback(async () => {
    if (endedRef.current) return;
    endedRef.current = true;
    setError(null);
    try {
      // 先收音频：最后一次 flush + 等所有分片写完（否则最后一段录音会丢）
      await stopRecorder();
      await audioChainRef.current;

      // 只结束会话 + 取回转写（服务端不再跑模型，返回很快）
      const resp = await fetch('/api/butler/meeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'end' }),
      });
      const data = await resp.json();
      if (!data?.success) {
        endedRef.current = false; // 失败允许重试
        setError(String(data?.error || 'Failed to end the meeting'));
        setEnding(false);
        return;
      }
      const title = String(data.title || snapshot.title || outputRef.current.title || 'Meeting');
      const kind: 'project' | 'butler' = data.outputKind === 'project' ? 'project' : (data.outputKind === 'butler' ? 'butler' : outputRef.current.kind);
      const dir: string = typeof data.outputDir === 'string' ? data.outputDir : outputRef.current.dir;
      const transcript = String(data.transcript || '');
      // segments：服务端逐条给的「时间戳 + 类型 + 正文」。语音段在分段收尾时已由常驻标点服务补过
      // 句读，故重转不可用时这里只兜底那些没带上句读的；手打的文本消息从不送标点模型，避免被改写。
      const segments: Array<{ ts: string; type: string; text: string }> =
        Array.isArray(data.segments) ? data.segments : [];
      // 已带句读的语音段不再送模型：标点模型对已结束的句子会再补一个句号（「。。」），
      // 而分段收尾时已由常驻标点服务补过一次（见 skipFinalizeRefine），这里只兜底漏掉的。
      const voiceIdx = segments
        .map((s, i) => (s.type === 'voice' ? i : -1))
        .filter((i) => i >= 0 && !/[。！？!?…]$/.test(segments[i].text.trim()));
      const needsPunctuate = voiceIdx.length > 0;
      // 是否要生成纪要：autoSummarize 关闭 或 无内容 → 只留全文转写
      const summarize = data.autoSummarize === true && transcript.trim() !== '';
      const stem = safeName(title);
      // 音频指针（首行 HTML 注释，渲染不可见）：回放视图据此找到录音分片。
      // 指针词汇是 local|project（local = butler 根），与产物落点的 butler|project 不同口径，这里做换算。
      // 只有真录到分片才写——没有录音时回放退化为「纯转写」。
      const side = kind === 'project' ? 'project' : 'local';
      const hint = partRef.current > 0
        ? `<!-- bob-audio: ${side}:${dir ? `${dir}/` : ''}录音 - ${stem} - part-*.webm -->\n\n`
        : '';
      // 全文转写**总是**先落一份：它是回放字幕的时间轴来源（纪要里没有时间戳），
      // 也让刚结束的这场会议立刻出现在 History 列表里。后台收尾（重转/补标点）会再重写一次。
      const recordName = `会议记录 - ${stem}.md`;
      const recordContent = `${hint}# 会议记录：${title}\n\n## 全文转写\n\n${transcript || '（EMPTY）'}\n`;
      // 接住落盘句柄：后台重转要用它请服务端定位「这份会议记录的录音」
      // （project 侧是项目内相对路径、local 侧是绝对路径，两种 resolveInSide 都能解析）
      let recordHandle: { source: 'project' | 'local'; path: string } | null = null;
      try {
        const w = await writeOutput(kind, dir, recordName, recordContent);
        recordHandle = { source: w.source, path: w.path };
      } catch {
        // 落盘失败：回退"未保存"暂存（内容仍在），不再自动打开
        putTransientFile(recordName, recordContent, `homework/${recordName}`);
      }

      // 登记收尾状态并让控制台**立刻让位**：面板据此跳到 History（生成中则显示提示），
      // 不再打开 md。纪要生成改为后台进行（模型跑十几秒也不阻塞界面）。
      beginMeetingWrapUp({ title, summarizing: summarize, progress: null });
      onEnded();
      setEnding(false);

      // 后台收尾（控制台此时已卸载；这里只用 fetch + writeOutput，不碰组件 state）。
      // 前移到 summarize 的早退**之前**：否则「关闭自动整理」这条路径永远不会重转/补标点。
      const canRetranscribe = !!recordHandle && partRef.current > 0;
      if (!needsPunctuate && !canRetranscribe && !summarize) return;
      // 剥掉元信息独占行（`[mm:ss]`、以及会后重转可能带的 `[说话人 N]`）：纪要只吃正文
      const stripStamps = (t: string) =>
        t.replace(/^\[\d{1,3}:\d{2}\]\s*$/gm, '').replace(/^\[说话人\s*\d+\]\s*$/gm, '').replace(/\n{2,}/g, '\n').trim();
      const plainOf = (segs: typeof segments) => segs.map((s) => s.text).join('\n').trim();
      const transcriptOf = (segs: typeof segments) => segs.map((s) => `[${s.ts}]\n${s.text}`).join('\n\n');
      // 兜底：万一响应里没有 segments（旧服务端），仍从 transcript 剥戳得到纯文本，别让纪要拿空串
      const plainFallback = stripStamps(transcript);
      void (async () => {
        try {
          let finalStamped = transcript;
          let finalPlain = plainFallback;
          let settled = false;

          // 1) 首选：用录音整体重转（离线**批量**模型，比流式更准；顺带按会议设置跑说话人分离）。
          //    成功后**不再**补标点——重转结果自带句读与引擎时间戳，且时间轴与录音对齐。
          //    响应是 NDJSON 流：跑的过程中每完成一个转写窗口就把进度推到 History 顶部。
          if (canRetranscribe && recordHandle) {
            const resp = await fetch('/api/butler/meeting', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'retranscribe', source: recordHandle.source, path: recordHandle.path }),
            }).catch(() => null);
            const out = resp
              ? await readRetranscribe(resp, (p) => setMeetingWrapUpProgress(p)).catch(() => null)
              : null;
            // 转完立刻撤下百分比（若还要出纪要，提示会切回「Generating minutes…」）
            setMeetingWrapUpProgress(null);
            // skipped（未装批量模型/无录音/切片失败）与失败都走下面的标点兜底
            if (out?.kind === 'done') {
              const re = out.transcript.trim();
              if (re) {
                // 手打消息不在录音里：重转只覆盖语音，故把 text 段按原顺序追加在其后（沿用原戳）
                const typed = segments.filter((s) => s.type !== 'voice');
                finalStamped = typed.length ? `${re}\n\n${transcriptOf(typed)}` : re;
                finalPlain = typed.length
                  ? `${out.plain.trim() || stripStamps(re)}\n${plainOf(typed)}`.trim()
                  : out.plain.trim() || stripStamps(re);
                settled = true;
              }
            }
          }

          // 2) 兜底：重转不可用/被跳过 → 只给语音段补标点（服务端批量；未装标点模型则原样返回）
          if (!settled && needsPunctuate) {
            const p = await fetch('/api/butler/meeting', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'punctuate', texts: voiceIdx.map((i) => segments[i].text) }),
            }).then((r) => r.json()).catch(() => null);
            const out: string[] | null = Array.isArray(p?.texts) ? p.texts : null;
            if (p?.success && out && out.length === voiceIdx.length) {
              const changed = voiceIdx.some((idx, k) => String(out[k]) !== segments[idx].text);
              if (changed) {
                const merged = segments.map((s) => ({ ...s }));
                voiceIdx.forEach((idx, k) => { merged[idx].text = String(out[k] ?? merged[idx].text); });
                finalStamped = transcriptOf(merged);
                finalPlain = plainOf(merged);
                settled = true;
              }
            }
          }

          // 3) 最终文本与首写不同才重写（模板/hint 与首写完全一致：音频指针 + [mm:ss] 独占一行，回放仍可用）
          if (settled && finalStamped !== transcript) {
            const rebuilt = `${hint}# 会议记录：${title}\n\n## 全文转写\n\n${finalStamped || '（EMPTY）'}\n`;
            try {
              await writeOutput(kind, dir, recordName, rebuilt);
            } catch {
              putTransientFile(recordName, rebuilt, `homework/${recordName}`);
            }
          }

          if (!summarize) return;
          // 4) 生成纪要：用最终（重转或补标点后）的纯文本
          const s = await fetch('/api/butler/meeting', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'summarize', title, text: finalPlain || plainFallback }),
          }).then((r) => r.json());
          const minutes = String(s?.minutes || '').trim();
          if (s?.success && minutes) {
            await writeOutput(kind, dir, `会议纪要 - ${stem}.md`, `# 会议纪要：${title}\n\n${minutes}\n`);
          }
        } catch { /* 收尾失败：已落的转写保留，撤下提示让列表回到常态 */ }
        finally {
          endMeetingWrapUp();
        }
      })();
    } catch (e) {
      endedRef.current = false;
      setEnding(false);
      setError(e instanceof Error ? e.message : 'Network request failed');
    }
  }, [snapshot.title, onEnded, stopRecorder]);

  // 结束：停录 → 等当前段转写 + 落库 → 收尾
  const end = useCallback(() => {
    setEnding(true);
    setRunning(false);
    if (recording) finish(false);
  }, [recording, finish]);

  useEffect(() => {
    if (!ending) return;
    if (recording || transcribing || pendingRef.current > 0) return;
    void doEnd();
  }, [ending, recording, transcribing, pendingTick, doEnd]);

  // 新字幕（含实时草稿行增长）到达时贴底——仅在「仍处于贴底」时；用户上滑查看前文后不再打扰（回到底部按钮见下）
  const count = snapshot.messages.length;
  useEffect(() => {
    if (!pinned) return;
    const el = scrollRef.current;
    el?.scrollTo({ top: el.scrollHeight });
  }, [count, liveDraft, pinned]);

  /** 记贴底状态：距底 < 24px 视为贴底（用户手动滑回底部时自动恢复跟随） */
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  }, []);

  // 从隐藏恢复可见（会议视图被切走又切回）：display:none 会清零 scrollTop，贴底态下重新贴回底部
  useEffect(() => {
    if (!visible || !pinned) return;
    const el = scrollRef.current;
    el?.scrollTo({ top: el.scrollHeight });
  }, [visible, pinned]);

  /** 回到底部：恢复跟随并平滑滚到最新一条 */
  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setPinned(true);
  }, []);

  /**
   * 字幕行：落库是一句一条（引擎判停定稿），这里只补上相对会议开始的 `[mm:ss]` 时间戳。
   * **不合并、不贴说话人**：会议进行中不做说话人识别，分块只可能出现在会后的整段重转里。
   */
  const captions = useMemo(
    () => snapshot.messages.map((m, i) => ({
      key: `${m.time}-${i}`,
      time: mmss((m.time - snapshot.startedAt) / 1000),
      text: m.text,
    })),
    [snapshot.messages, snapshot.startedAt],
  );

  // 实时草稿行：仅在录音态显示（暂停/结束时这条未定稿内容会被 onSegment/onText/onDiscard 清掉）。
  // 它只承载「当前正在说的这一句」；时间戳取这一句的句首时刻（sentStartsRef 队尾 = 最新那一句），
  // 与定稿后落库的那一条同口径 —— 草稿被替换成正式条目时时间不跳。
  const liveDraftText = running ? liveDraft.trim() : '';
  const sentStarts = sentStartsRef.current;
  const liveTime = mmss(((sentStarts[sentStarts.length - 1] ?? segStartRef.current) - snapshot.startedAt) / 1000);

  const statusLabel = ending ? 'Finishing…' : running ? 'Recording' : 'Paused';

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* 顶部条：红点 + 状态 + 波形 + 计时 + 条数 + Pause / End */}
      <div
        className="flex shrink-0 items-center gap-2 px-3 py-2"
        style={{ borderBottom: DIVIDER_SOFT, backgroundColor: 'var(--panel-bg)' }}
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full${running ? ' animate-pulse' : ''}`}
          style={{ backgroundColor: running ? 'var(--danger)' : 'var(--ink-faint)' }}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold" style={{ color: 'var(--ink-strong)' }} title={snapshot.title ?? undefined}>
          {snapshot.title}
        </span>
        {/* 波形：barsRef 交给 useVoiceInput 实时驱动高度 */}
        {running && (
          <div className="flex h-4 shrink-0 items-center gap-[2px]">
            {Array.from({ length: 8 }).map((_, i) => (
              <span
                key={i}
                ref={(el) => { barsRef.current[i] = el; }}
                className="w-0.5 rounded-full"
                style={{ height: '3px', backgroundColor: 'var(--primary)' }}
              />
            ))}
          </div>
        )}
        <span className="shrink-0 text-10 tabular-nums" style={{ color: 'var(--ink-muted)' }}>
          {statusLabel} · {mmss(elapsed)} · {snapshot.count}
        </span>
        <button
          type="button"
          onClick={() => (running ? pause() : resume())}
          disabled={ending}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-50"
          style={{ color: running ? 'var(--ink-muted)' : 'var(--primary-strong)' }}
          title={running ? 'Pause recording' : 'Resume recording'}
          aria-label={running ? 'Pause recording' : 'Resume recording'}
        >
          {running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={end}
          disabled={ending}
          className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-10 font-medium transition-colors disabled:opacity-50"
          style={{
            backgroundColor: 'color-mix(in oklab, var(--danger) 12%, transparent)',
            color: 'var(--danger)',
          }}
          title="End meeting and summarize"
        >
          {ending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
          End
        </button>
      </div>

      {/* 实时字幕流：`[mm:ss] label 文本`（上滑查看前文时暂停自动贴底，底部给回到底部按钮） */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        style={{ backgroundColor: 'var(--panel-bg)' }}
      >
        {error && (
          <div className="mb-2 rounded-md px-2 py-1 text-10" style={{ color: 'var(--danger)', backgroundColor: 'color-mix(in oklab, var(--danger) 8%, transparent)' }}>
            {error}
          </div>
        )}
        {captions.length === 0 && !liveDraftText ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs" style={{ color: 'var(--ink-faint)' }}>
            {running ? 'Listening… start speaking' : 'Paused · press play to resume'}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {captions.map((c) => (
              <div key={c.key} className="flex gap-2 text-xs leading-relaxed">
                <span className="shrink-0 tabular-nums" style={{ color: 'var(--ink-faint)' }}>[{c.time}]</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap" style={{ color: 'var(--ink)' }}>{c.text}</span>
              </div>
            ))}
            {/* 实时草稿行：本地流式引擎「边说边写」的未定稿文本，左缘一道主色竖线区别于已定稿字幕。
                定稿（onText）时该行被清掉，同一段文字由上面的正式条目接管。 */}
            {liveDraftText && (
              <div
                className="flex gap-2 text-xs leading-relaxed"
                style={{ borderLeft: '2px solid color-mix(in oklab, var(--primary) 45%, transparent)', paddingLeft: 6 }}
              >
                <span className="shrink-0 tabular-nums" style={{ color: 'var(--ink-faint)' }}>[{liveTime}]</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap" style={{ color: 'var(--ink-muted)' }}>{liveDraftText}</span>
              </div>
            )}
            {transcribing && (
              <div className="flex items-center gap-1.5 text-10" style={{ color: 'var(--ink-muted)' }}>
                <Loader2 className="h-3 w-3 animate-spin" /> Transcribing…
              </div>
            )}
          </div>
        )}
      </div>

      {/* 回到底部：仅在上滑脱离贴底且有字幕时出现（贴底状态由 onScroll 维护） */}
      {!pinned && captions.length > 0 && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full px-2.5 py-1 text-10 font-medium shadow-sm transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--primary-solid)', color: 'var(--primary-fg, oklch(1 0 0))' }}
          title="Jump to latest caption"
        >
          <ArrowDown className="h-3 w-3" />
          Jump to latest
        </button>
      )}
    </div>
  );
}