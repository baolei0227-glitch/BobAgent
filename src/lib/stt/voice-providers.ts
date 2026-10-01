/**
 * lib/stt/voice-providers.ts — 语音输入的转写链路实现（renderer / 浏览器侧）
 *
 * 为什么单独成文件：麦克风语音输入有两条互斥的转写链路，此前两条链路的状态机、选路判断
 * 与收尾分支全堆在 components/ui/voice-input.tsx 一个 hook 里。这里把「链路」抽象成
 * SttProvider——每个实现只管自己的采集接线、实时产出与收尾；hook 只保留两条链路共用的
 * 采集（麦克风 / AudioContext / 波形）与编排（探测 → 选链路 → 收尾）。新增一条链路时，
 * 只需在这里加一个实现，不必改 hook。
 *
 * 两条链路：
 *   realtime 本地实时：AudioWorklet 采 16k 单声道 PCM → **直连**本地 sherpa-onnx 流式 WS
 *            服务端 → 中间结果「边说边写」进草稿；停顿处补标点；按 ✓ 时整段录音再交本地
 *            离线引擎重转一次作为定稿（实时图快、定稿图准）。音频不出网。
 *   recorder 录制后转写（默认）：MediaRecorder 录成 Blob → /api/transcribe → 回填。
 *
 * 三条不可改的约定（沿用原实现）：
 *   ① 录音**不落盘**：realtime 的 PCM 只进本地 WS，recorder 的 Blob 只在内存里走完接口即丢；
 *   ② **不自动发送**：转写结果交给调用方追加到草稿，发不发由用户决定；
 *   ③ 转写**有超时上限**：否则「Transcribing…」会永远挂在那里。
 */
import { fileToBase64 } from '@/components/canvas/composer/useComposer';

/** 录音码率：MediaRecorder 默认 AAC 码率偏低，会明显拖低转写准确率，显式提到 128 kbps */
const RECORD_BITS_PER_SECOND = 128_000;

/** 流式链路：sherpa-onnx 流式服务端只吃 16kHz 单声道 float32，故 AudioContext 按此采样率建 */
export const VOICE_SAMPLE_RATE = 16_000;
/** 一帧 = 100ms：越小首字越快，越大发包越少（服务端对任意帧长都能处理） */
const STREAM_FRAME_SAMPLES = VOICE_SAMPLE_RATE / 10;
/** 'Done' 之后等服务端跑完剩余音频的上限 */
const STREAM_FINALIZE_TIMEOUT_MS = 15_000;
/**
 * 「会话卡死」判定：流式服务端**每收到音频都会回一条**（实测连续语音 ~0.6s 一条、静音里也有），
 * 所以整整 8 秒一条不回只可能是链路死了（引擎被空闲回收 / 崩溃 / 线程被饿死）。
 * 这时主动断开并让调用方重开一轮，而不是让字幕静静地停在原地不动。
 */
const STREAM_STALL_MS = 8_000;
/**
 * 会话保活间隔：常驻流式引擎**空闲 3 分钟**就被回收（见 lib/stt/stream-server），
 * 而会议模式一整场只开一条 WS 会话——没有心跳的话，开录 3 分钟后引擎会被回收掉。
 * 由本 provider 自己发（它是会话持有者）：只在真的走实时链路时才续期，
 * 不会在「已回退到录制链路」时白白吊着一个流式引擎进程。
 */
const STREAM_KEEPALIVE_MS = 60_000;
/** /api/transcribe、/api/stt/finalize、/api/stt/punctuate 与本地服务端拉起的上限 */
const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** 收尾定稿最多保留的录音时长：16k 单声道 float32 ≈ 64KB/s，10 分钟约 38MB，可接受 */
const FINALIZE_MAX_SAMPLES = VOICE_SAMPLE_RATE * 60 * 10;
/** 太短的录音不值得再跑一次离线模型（也避免静音段触发模型幻觉） */
const FINALIZE_MIN_SAMPLES = VOICE_SAMPLE_RATE * 0.3;

/**
 * 采集用 AudioWorklet：把麦克风的 128 采样块原样抛回主线程。
 * 重采样不做在这里——AudioContext 按 16k 建，浏览器已把输入重采样到该采样率；
 * worklet 只负责搬运，逻辑越少越不容易出错。
 */
export const PCM_WORKLET_CODE = `
class BobPcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('bob-pcm-capture', BobPcmCapture);
`;
const PCM_PROCESSOR = 'bob-pcm-capture';

/** 待发 PCM 队列：worklet 的 128 采样小块拼成 100ms 一帧再发 */
interface PcmQueue {
  chunks: Float32Array[];
  len: number;
}

/** 取队列头部恰好 n 个采样并出队（跨块拼接），返回可直发的 ArrayBuffer */
function takeFrame(queue: PcmQueue, n: number): ArrayBuffer {
  const out = new Float32Array(n);
  let filled = 0;
  while (filled < n) {
    const head = queue.chunks[0];
    if (!head) break;
    const need = n - filled;
    if (head.length <= need) {
      out.set(head, filled);
      queue.chunks.shift();
      filled += head.length;
    } else {
      out.set(head.subarray(0, need), filled);
      queue.chunks[0] = head.subarray(need);
      filled += need;
    }
  }
  queue.len -= n;
  return out.buffer;
}

/**
 * 把已采到的 16k 单声道 float32 PCM 打包成 16-bit PCM 的 WAV。
 * 收尾定稿要把整段录音交给离线引擎（sherpa-onnx-offline 只吃 wav 文件），故在本地拼一个标准头，
 * 不走 ffmpeg：源就是 16k 单声道，没有任何需要转码的地方。
 */
function encodeWav(chunks: Float32Array[], total: number): Blob {
  const bytes = new Uint8Array(44 + total * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // 1 = PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, VOICE_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_SAMPLE_RATE * 2, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  ascii(36, 'data');
  view.setUint32(40, total * 2, true);
  let off = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

/** 调本地标点接口给一段裸文本补标点；未就绪 / 失败 / 空文本 → 原样返回（可选增强，绝不阻塞语音输入） */
async function punctuateRaw(text: string): Promise<string> {
  if (!text.trim()) return text;
  try {
    const resp = await fetch('/api/stt/punctuate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    const data = (await resp.json().catch(() => ({}))) as { text?: string };
    if (resp.ok && typeof data.text === 'string' && data.text.trim()) return data.text;
  } catch {
    /* 标点失败：保持原文 */
  }
  return text;
}

/** 收尾定稿：把整段录音交给**本地离线引擎**重转一遍；不可用 / 失败 / 录音太短 → null */
async function finalizeLocal(chunks: Float32Array[], len: number): Promise<string | null> {
  if (len < FINALIZE_MIN_SAMPLES) return null;
  try {
    const wav = encodeWav(chunks, len);
    const base64 = await fileToBase64(new File([wav], 'voice-live.wav', { type: 'audio/wav' }));
    const resp = await fetch('/api/stt/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: base64 }),
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    const data = (await resp.json().catch(() => ({}))) as { text?: string };
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (resp.ok && text) return text;
  } catch {
    /* 定稿失败不影响已有文本：实时链路的结果照常回填 */
  }
  return null;
}

/** 采集运行时：hook 建好麦克风与 AudioContext 后交给 provider 使用 */
export interface VoiceRuntime {
  /** 麦克风流（两条链路共用） */
  stream: MediaStream;
  /** 16k AudioContext（realtime 采集与波形共用）；非安全上下文下可能为 null */
  ctx: AudioContext | null;
  /** 登记/复用采集源节点（realtime 挂 worklet 用；复用可让波形与采集共用同一源，避免振幅翻倍） */
  ensureSource: (ctx: AudioContext) => MediaStreamAudioSourceNode;
  /** 停麦克风轨 / 关 AudioContext / 停计时与波形（收尾时调用一次） */
  teardown: () => void;
  /** 实时中间文本 → 草稿框（边说边写） */
  onPartial: (text: string) => void;
  /** 按句定稿（仅在链路开启 emitSegments 时回调）：说话人一停顿就交出这一句，
   *  会议字幕据此「一行一句」。开了它的链路里，onText 只再交出**没有按句发过的余量**。 */
  onSegment?: (text: string) => void;
  /** 流式链路的会话**意外**中断（本地引擎被回收 / 崩溃 / 卡死）：调用方据此收尾并重开一轮。
   *  没有它的话，一次断链会让这一场剩下的时间静默地不再转写（用户感知就是「字幕不动了」）。 */
  onSessionLost?: (reason: string) => void;
  /** 定稿文本（非空）→ 调用方回填 */
  onText: (text: string) => void;
  /** 转写失败的原因 */
  onError: (reason: string) => void;
  /** 作废本次预填（把草稿还原成录音前的样子） */
  onDiscard: () => void;
}

/** 一条转写链路：探测可用性 → 接管采集 → 收尾。 */
export interface SttProvider {
  /** 探测当前环境是否可用（realtime = 本地服务端/模型就绪）；false = 不选它 */
  probe: () => Promise<boolean>;
  /** 接管采集并开始产出；失败抛错，由调用方决定回退还是报错 */
  start: (rt: VoiceRuntime) => Promise<void>;
  /** 收尾：cancel=true 丢弃；否则产出定稿文本（结果由实现直接回调 runtime） */
  finish: (cancel: boolean) => Promise<void>;
  /** 作废：清掉本链路已产出的中间态（回退到另一链路 / 取消 / 卸载时调用） */
  abort: () => void;
}

// ============================================================
// 链路 A：本地实时（AudioWorklet PCM → 本地 WS 服务端直连）
// ============================================================

/**
 * 两处**模型编辑**可按链路需要分别关掉（缺省都开着 = 原行为）：
 *   - skipSegmentPunctuation：每段定稿（is_final）不做标点，字幕保持引擎原文；
 *   - skipFinalizeRefine：收尾不做离线重转定稿（同时不再累积整段 PCM，省最多 38MB 内存）。
 * 会议模式只关后者：分段收尾频繁，重转既慢又无必要，但标点必须留着——字幕要像飞书那样带句读。
 */
export interface RealtimeProviderOptions {
  /** 每段定稿跳过标点（会议模式不关：实时字幕要带句读） */
  skipSegmentPunctuation?: boolean;
  /** 收尾跳过离线重转定稿（会议模式关掉：45s 一段，重转只会拖慢分段） */
  skipFinalizeRefine?: boolean;
  /** 按句交出结果（会议字幕用）：服务端每次判出停顿（is_final）就把这一句回调给 onSegment，
   *  收尾的 onText 只再交「还没按句发过的余量」。
   *  不开（缺省）时维持原行为：全部结果攒到收尾一次 onText 交出，停顿只刷新草稿。 */
  emitSegments?: boolean;
}

/** 每次录音新建一个实例，故链路状态用闭包变量即可（无需跨渲染的 ref） */
export function createRealtimeProvider(opts: RealtimeProviderOptions = {}): SttProvider {
  const skipSegmentPunctuation = opts.skipSegmentPunctuation === true;
  const skipFinalizeRefine = opts.skipFinalizeRefine === true;
  const emitSegments = opts.emitSegments === true;
  const queue: PcmQueue = { chunks: [], len: 0 };
  /** 本轮录音**全部**已采到的 PCM（与 queue 共用同一批 chunk 引用，不额外拷贝）：按 ✓ 打包定稿用 */
  const sessionPcm: PcmQueue = { chunks: [], len: 0 };
  /** 已定稿的段：raw = 引擎裸文本，punctuated = 标点整理后的文本（未回来 / 失败时为空串） */
  const segments: Array<{ raw: string; punctuated: string }> = [];
  /** 当前未定稿的尾巴（段内累积文本，服务端每次出新结果整体覆盖） */
  let tail = '';
  /** emitSegments 模式下：segments 里**已按句交出**的段数（收尾时只再交剩下的余量） */
  let emittedCount = 0;
  /** emitSegments 模式下的按句发出队列：标点是异步的，串成一条链才能保证句子顺序 */
  let emitChain: Promise<void> = Promise.resolve();
  /** is_eof 是否已收到 */
  let eof = false;
  /** 等待 is_eof 的 resolver（收尾时挂上） */
  let eofResolve: (() => void) | null = null;
  /** 会话序号：每次开始 / 收尾 / 作废递增，用来丢弃「上一轮录音」迟到的标点响应 */
  let session = 0;
  let ws: WebSocket | null = null;
  let worklet: AudioWorkletNode | null = null;
  let rt: VoiceRuntime | null = null;
  /** 本次会话是否由我们主动收尾（finish/abort）：用来区分「正常关闭」与「意外断链」 */
  let closedByUs = false;
  /** 服务端最后一条下行消息的时刻（0 = 还没收到过）：卡死看门狗的唯一依据 */
  let lastServerMsgAt = 0;
  /** 卡死看门狗定时器（浏览器里是 number） */
  let stallTimer: number | null = null;
  /** 保活定时器（见 STREAM_KEEPALIVE_MS） */
  let keepaliveTimer: number | null = null;

  /** 当前实时文本 = 各已定稿段（优先标点版，没回来就用裸文本）+ 未定稿的尾巴 */
  const composeLive = () => {
    let out = '';
    for (const s of segments) out += s.punctuated || s.raw;
    return out + tail;
  };
  /** composeLive 的**裸文本**版（不含标点）：收尾时整体再跑一遍标点，得到一致的定稿文本 */
  const composeRaw = () => {
    let out = '';
    for (const s of segments) out += s.raw;
    return out + tail;
  };
  /** 还没按句交出过的余量（emitSegments 模式收尾用）：已发出的段绝不再交，避免同一句落两行 */
  const residueRaw = () => {
    let out = '';
    for (let i = emittedCount; i < segments.length; i++) out += segments[i].raw;
    return out + tail;
  };
  /** 收尾要交出的文本：按句模式下只交余量，否则仍是整段 */
  const finalText = () => (emitSegments ? residueRaw() : composeRaw());

  /** 把队列里够一帧的 PCM 发出去；WS 没连上就先攒着（onopen 时会再 drain 一次） */
  const drain = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (queue.len >= STREAM_FRAME_SAMPLES) ws.send(takeFrame(queue, STREAM_FRAME_SAMPLES));
  };

  /** 摘掉 worklet 节点（收尾 / 作废时调用），停止它继续往队列里堆 PCM */
  const detachWorklet = () => {
    const node = worklet;
    worklet = null;
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
    }
  };

  /** 停掉卡死看门狗（收尾 / 作废 / 已判死时调用；重复调用无害） */
  const stopStallWatch = () => {
    if (stallTimer !== null) {
      window.clearInterval(stallTimer);
      stallTimer = null;
    }
  };

  /** 停掉会话保活（收尾 / 作废 / 断链时调用；重复调用无害） */
  const stopKeepalive = () => {
    if (keepaliveTimer !== null) {
      window.clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  };

  /**
   * 服务端下行消息 → 实时文本 / 定稿文本（协议见 lib/stt/sherpa 的「流式服务端」注释）：
   * 段内 text 是累积的；`is_final && !is_eof` 表示该段定稿，服务端随即 Reset；
   * `is_eof` 是 'Done' 之后的收尾结果；之后还会补一帧非 JSON 的 "Done!"——直接忽略。
   * 标点：zipformer 只出裸字，故每段定稿即异步跑一次标点模型，把带标点的该段替换进草稿。
   */
  const handleMessage = (data: unknown) => {
    if (typeof data !== 'string' || !data.startsWith('{')) return;
    // 任何一条合法下行都算「链路活着」（看门狗据此判死）
    lastServerMsgAt = Date.now();
    let msg: { text?: unknown; is_final?: unknown; is_eof?: unknown };
    try {
      msg = JSON.parse(data) as typeof msg;
    } catch {
      return;
    }
    const r = rt;
    if (!r) return;
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (msg.is_eof === true) {
      // 收尾结果不在这里写草稿：定稿文本随后由 onText 一次性覆盖（同一段文字不写两遍）
      tail = text;
      eof = true;
      eofResolve?.();
      return;
    }
    if (msg.is_final === true) {
      // 该段定稿（说话人停顿）：入段 + 清空尾巴，并异步跑标点——停顿处即出句读
      const seg = { raw: text, punctuated: '' };
      const idx = segments.length;
      segments.push(seg);
      tail = '';
      // 按句模式：已交出的句子各自成行（由调用方落库），草稿行只留「当前正在说的这一句」，
      // 否则同一句会既在字幕里又留在草稿里显示两遍。
      r.onPartial(emitSegments ? tail : composeLive());
      const s = session;
      const settle = async () => {
        // 会话已收尾 / 作废：这一轮的标点结果不能再回写草稿
        if (s !== session) return;
        // 需要时跳过标点：字幕保持引擎原文（不再每段一次改写）
        const punctuated = skipSegmentPunctuation ? text : await punctuateRaw(text);
        if (s !== session) return;
        seg.punctuated = punctuated;
        if (emitSegments) {
          // 只按顺序发：万一前面有一段没能发出（会话切换），它就留给收尾当余量，不插队
          if (idx === emittedCount) {
            emittedCount = idx + 1;
            // 空段不发：rule1 可以在**纯静音**上定稿（实测），空段若也回调，会白白吃掉一个
            // 「句首时刻」锚点（让下一句拿到错误的时间戳），还会在字幕里落一条空行。
            if ((punctuated || text).trim()) r.onSegment?.(punctuated || text);
          }
          return;
        }
        if (punctuated !== text) r.onPartial(composeLive());
      };
      // 按句模式必须按序发出（两条相邻的段可能前后脚定稿），串成一条链；
      // 非按句模式保持各段并行标点，不引入额外的串行延迟。
      if (emitSegments) emitChain = emitChain.then(settle);
      else void settle();
      return;
    }
    tail = text;
    r.onPartial(emitSegments ? tail : composeLive());
  };

  /** 'Done' 之后等 is_eof；超时或连接断开就用已收到的裸文本兜底 */
  const waitForFinal = (): Promise<string> =>
    new Promise<string>((resolve) => {
      if (eof) {
        resolve(finalText());
        return;
      }
      const timer = window.setTimeout(() => {
        eofResolve = null;
        resolve(finalText());
      }, STREAM_FINALIZE_TIMEOUT_MS);
      eofResolve = () => {
        window.clearTimeout(timer);
        eofResolve = null;
        resolve(finalText());
      };
    });

  /** 清空本链路的所有产出与队列（新会话开始 / 作废时） */
  const reset = () => {
    session += 1;
    segments.length = 0;
    emittedCount = 0;
    tail = '';
    eof = false;
    eofResolve = null;
    queue.chunks = [];
    queue.len = 0;
    sessionPcm.chunks = [];
    sessionPcm.len = 0;
    stopStallWatch();
    stopKeepalive();
    lastServerMsgAt = 0;
    closedByUs = false;
  };

  return {
    async probe() {
      // 本地接口，毫秒级；顺带刷新，模型刚下载完也能立刻用上
      try {
        const res = await fetch('/api/stt/stream');
        const data = (await res.json().catch(() => ({}))) as { available?: boolean };
        return res.ok && data.available === true;
      } catch {
        return false;
      }
    },

    async start(runtime) {
      rt = runtime;
      reset();

      const resp = await fetch('/api/stt/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      });
      const data = (await resp.json().catch(() => ({}))) as { port?: number; error?: string };
      if (!resp.ok || !data.port) throw new Error(data.error || `HTTP ${resp.status}`);
      const port = data.port;

      const ctx = runtime.ctx;
      if (!ctx) throw new Error('AudioWorklet is unavailable in this browser context.');

      // worklet 只挂一次：模块加载与节点创建失败都视为链路不可用
      const url = URL.createObjectURL(new Blob([PCM_WORKLET_CODE], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, PCM_PROCESSOR);
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        const chunk = e.data;
        if (!chunk?.length) return;
        queue.chunks.push(chunk);
        queue.len += chunk.length;
        // 同一批 chunk 引用也留在整段缓冲里（按 ✓ 打包定稿用）；超过时长上限就不再累积。
        // 收尾不跑离线定稿时，攒这份 PCM 只是白占内存（最多 38MB），直接跳过。
        if (!skipFinalizeRefine && sessionPcm.len < FINALIZE_MAX_SAMPLES) {
          const room = FINALIZE_MAX_SAMPLES - sessionPcm.len;
          const keep = chunk.length <= room ? chunk : chunk.subarray(0, room);
          sessionPcm.chunks.push(keep);
          sessionPcm.len += keep.length;
        }
        drain();
      };
      const src = runtime.ensureSource(ctx);
      src.connect(node);
      node.connect(ctx.destination); // worklet 输出恒为静音，仅为让节点进入渲染图、process 被持续调用
      worklet = node;

      // 连本地 WS：连上之前采到的 PCM 已在队列里，onopen 立刻补发
      const sock = new WebSocket(`ws://127.0.0.1:${port}`);
      ws = sock;
      await new Promise<void>((resolve, reject) => {
        sock.onopen = () => {
          resolve();
          drain();
        };
        sock.onerror = () => reject(new Error('Could not connect to the local streaming transcriber.'));
      });
      sock.onmessage = (ev) => handleMessage(ev.data);
      sock.onerror = null;
      sock.onclose = () => {
        // 只处理**当前**会话的关闭：上一轮会话的迟到 onclose 不该动这一轮的状态
        // （定时器 / closedByUs / onSessionLost 都是按会话计的生命周期）。
        if (ws === sock) {
          ws = null;
          stopStallWatch();
          stopKeepalive();
          // 正常收尾（finish/abort）不在此列，否则收尾完又会被拉起来一轮
          if (!closedByUs) rt?.onSessionLost?.('stream-closed');
        }
        // 收尾正在等 is_eof：连接断了就别让它干等满超时
        eofResolve?.();
      };
      // 会话保活：常驻引擎空闲 3 分钟回收，这里每 60s 续一次（见 STREAM_KEEPALIVE_MS）。
      // 音频不走这条 HTTP：它只是「这次会话还活着」的心跳。
      keepaliveTimer = window.setInterval(() => {
        if (ws !== sock) return;
        void fetch('/api/stt/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'keepalive' }),
        }).catch(() => undefined);
      }, STREAM_KEEPALIVE_MS);
      // 卡死看门狗：连续 STREAM_STALL_MS 收不到任何下行 → 主动断开（onclose 走上面那条恢复路径）。
      // 为什么需要它：会议模式一整场只开一条会话（不再每 45s 换块），链路一旦静静地死掉，
      // 没有这条兜底就会「字幕一直不动」直到会议结束。
      lastServerMsgAt = Date.now();
      stallTimer = window.setInterval(() => {
        if (!lastServerMsgAt || Date.now() - lastServerMsgAt < STREAM_STALL_MS) return;
        stopStallWatch();
        try {
          sock.close();
        } catch {
          /* 已关闭 */
        }
      }, 2_000);
    },

    async finish(cancel) {
      const r = rt;
      const sock = ws;
      ws = null;
      closedByUs = true; // 先标记：下面 close 触发的 onclose 不该再报「会话丢失」
      stopStallWatch();
      stopKeepalive();
      detachWorklet();
      r?.teardown();
      session += 1; // 收尾即进入新一轮会话：在途的分段标点响应一律作废

      if (cancel) {
        // 已上传的音频随连接一起丢弃；服务端照旧收 'Done' 以干净释放这条流
        if (sock && sock.readyState === WebSocket.OPEN) sock.send('Done');
        sock?.close();
        segments.length = 0;
        emittedCount = 0;
        tail = '';
        r?.onDiscard(); // 草稿里「边说边写」进去的那段一起撤掉
        return;
      }

      // 定稿与实时收尾**并行**：定稿只依赖已采到的音频，不必等 WS 把尾巴跑完
      const refinePromise = skipFinalizeRefine ? Promise.resolve(null) : finalizeLocal(sessionPcm.chunks, sessionPcm.len);
      let raw = '';
      try {
        if (sock && sock.readyState === WebSocket.OPEN) {
          if (queue.len > 0) sock.send(takeFrame(queue, queue.len)); // 不足一帧的尾巴
          sock.send('Done');
          // 这一步**不能**省：等 is_eof 把最后那段未定稿的尾巴跑完（廉价，不是模型调用），否则末句截断
          raw = await waitForFinal();
        } else {
          raw = finalText();
        }
      } finally {
        sock?.close();
      }
      // 实时结果：整段（含最后那段还没跑过标点的尾巴）再跑一遍标点，得到一致的带标点文本。
      // 会议模式（skipFinalizeRefine）走的正是这条路：标点照做、只是不做离线重转。
      const live = skipSegmentPunctuation ? raw.trim() : (await punctuateRaw(raw)).trim();
      // 本地离线引擎（SenseVoice small 等）重转一次作为更准的定稿；不可用 / 失败则沿用实时结果
      const text = ((await refinePromise) || live).trim();
      if (text) {
        r?.onText(text); // 定稿覆盖草稿里的实时预填（由调用方按同一基线替换）
      } else if (emitSegments) {
        // 按句模式：这一段的句子早已按句交出，收尾没有余量是常态（不是「没识别到」），什么都不用做
      } else {
        r?.onDiscard(); // 没识别出文字：草稿里的实时预填也撤掉，恢复成录音前的样子
        r?.onError('No speech detected.');
      }
    },

    abort() {
      const sock = ws;
      ws = null;
      closedByUs = true;
      stopStallWatch();
      stopKeepalive();
      detachWorklet();
      try {
        sock?.close();
      } catch {
        /* 已关闭 */
      }
      reset();
      rt = null;
    },
  };
}

// ============================================================
// 链路 B：录制后转写（MediaRecorder Blob → /api/transcribe）
// ============================================================

export function createRecorderProvider(): SttProvider {
  let rec: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  /** recorder 停止落盘（onstop 触发）的 Promise，收尾时 await 它 */
  let stopped: Promise<void> = Promise.resolve();
  let rt: VoiceRuntime | null = null;

  return {
    async probe() {
      // 兜底链路：只要麦克风起来了就能录（MediaRecorder 广泛可用）
      return true;
    },

    async start(runtime) {
      rt = runtime;
      // mime 择优：不同浏览器支持不同，按优先级挑第一个可用的
      const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
      const mime =
        typeof MediaRecorder !== 'undefined'
          ? candidates.find((m) => MediaRecorder.isTypeSupported?.(m)) || ''
          : '';
      const r = new MediaRecorder(runtime.stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: RECORD_BITS_PER_SECOND,
      });
      chunks = [];
      rec = r;
      r.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      stopped = new Promise<void>((resolve) => {
        r.onstop = () => resolve();
      });
      r.start(250); // 分片收集，避免长录音内存集中
    },

    async finish(cancel) {
      const r = rec;
      const runtime = rt;
      if (!r) return;
      rec = null;
      if (r.state !== 'inactive') r.stop();
      await stopped;
      runtime?.teardown();
      const got = chunks;
      chunks = [];
      if (cancel) {
        runtime?.onDiscard(); // 录制链路没做过实时预填 → 调用方那边是无害的空操作
        return;
      }
      if (got.length === 0) return; // 没采到任何音频：保持沉默（与原行为一致）
      const type = r.mimeType || 'audio/webm';
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      const blob = new Blob(got, { type });
      const ts = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const name = `voice-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.${ext}`;
      try {
        const base64 = await fileToBase64(new File([blob], name, { type }));
        const resp = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: base64, fileName: name }),
          signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
        });
        const data = (await resp.json().catch(() => ({}))) as { text?: string; error?: string };
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        if (!resp.ok || !text) throw new Error(data.error || `HTTP ${resp.status}`);
        runtime?.onText(text);
      } catch (e) {
        // 转写失败：录音直接丢弃（语音输入不落盘），只把失败原因讲清楚
        console.warn('语音转写失败，录音已丢弃:', e);
        runtime?.onError(e instanceof Error && e.message ? e.message : 'Transcription failed.');
      }
    },

    abort() {
      const r = rec;
      rec = null;
      chunks = [];
      rt = null;
      if (r && r.state !== 'inactive') r.stop(); // 停止但不再转写
    },
  };
}