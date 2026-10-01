'use client';

/**
 * 语音输入（微信式）——录音 → 转写 → 回填输入框。
 *
 * 为什么抽成公共模块：画布聊天节点的输入框与助理抽屉中栏的输入框是同一件事
 * （按一下开始说、说完把文字追加进草稿框），原先只有前者有这套逻辑，
 * 两处各写一份「录音 + 计时 + 取消/完成」状态机没有意义。
 *
 * 本 hook 只做**编排**：建/共用采集（麦克风、AudioContext、实时波形），按能力挑一条
 * 转写链路，并把结果交给调用方。两条链路本身的采集接线与收尾都在 provider 里
 * （见 lib/stt/voice-providers.ts）——新增一条链路不必改这里。自动择一，用户无需配置：
 *   A. **本地实时**（下载了 realtime 模型时）：provider `realtime`，中间结果边说边写进草稿；
 *   B. **录制后转写**（默认）：provider `recorder`，录成 Blob → /api/transcribe → 回填。
 *
 * 三条不可改的约定（沿用 B4 尾批的原行为）：
 *   ① 录音**不落盘**：语音只用于回填文字，不进 materials/、不进附件列表。
 *   ② **不自动发送**：转写结果由调用方追加到草稿之后，发不发由用户按发送键。
 *   ③ 转写中麦克风旁的录音条一直占位，所以请求带超时上限，超时按失败处理
 *      （否则那条「Transcribing…」会永远挂在那里）。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Check, X } from 'lucide-react';
import {
  VOICE_SAMPLE_RATE,
  createRecorderProvider,
  createRealtimeProvider,
  type SttProvider,
  type VoiceRuntime,
} from '@/lib/stt/voice-providers';

/**
 * getUserMedia 失败 → 一句用户能照做的说明。
 * 为什么要分类：这几种失败的处置方式完全不同（改站点权限 / 插麦克风 / 关掉占用它的程序），
 * 而原始 DOMException 名字（NotAllowedError）对用户毫无信息量。
 */
function describeMicFailure(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  const detail = e instanceof Error && e.message ? e.message : String(e);
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      // 站点权限被拒（浏览器地址栏的麦克风图标 → 允许），或预览内嵌框架没放行麦克风
      return `Microphone access was denied. Allow the microphone for this page in the browser's site settings, then click again. (${detail})`;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return `No microphone was found. Connect one and try again. (${detail})`;
    case 'NotReadableError':
    case 'TrackStartError':
      return `The microphone is already in use by another app. Close it and try again. (${detail})`;
    case 'OverconstrainedError':
      return `The available microphone does not satisfy the recording settings. (${detail})`;
    default:
      return `Could not start recording. (${detail})`;
  }
}

/** 把语音文本接到草稿之后（草稿为空时就是文本本身；已有内容则补一个换行）。
 *  两个调用方（画布节点输入框、助理抽屉输入框）与流式实时预填共用同一口径，故抽到这里。 */
export function appendVoiceText(base: string, text: string): string {
  return base.trim() ? `${base}${base.endsWith('\n') ? '' : '\n'}${text}` : text;
}

export interface VoiceInputOptions {
  /** 转写成功：把文字交给调用方（追加到它自己的草稿框） */
  onText: (text: string) => void;
  /** 转写失败的原因（调用方用自己的弹层讲清楚）；不传则只 console.warn */
  onError?: (reason: string) => void;
  /** 录音**没能起来**的原因（无 getUserMedia / 权限被拒 / 无设备 / 被其他程序占用）；
   *  不传则退回 onError。这类失败原先只落在 console.warn 上——界面毫无反应，
   *  看上去就是「点了没反应」，所以必须让调用方有机会讲出来。 */
  onStartError?: (reason: string) => void;
  /** 当前是否允许开始录音（如流式回复中不允许）；缺省允许 */
  canStart?: boolean;
  /** 流式链路的实时中间文本（本地 WS 每次出新结果回调一次，**边说边写进草稿框**）。
   *  调用方自己管「录音前的草稿基线」：首次回调时快照，之后写成「基线 + 本参数」。
   *  录制链路不回调（那一路只在定稿时有文字）。 */
  onPartial?: (text: string) => void;
  /** 本次录音作废（✕ 取消 / 没识别出文字 / 流式没起来退回录制链路 / 组件卸载）：
   *  调用方把草稿还原成录音前的样子。没做过实时预填时是无害的空操作。 */
  onDiscard?: () => void;
  /** 外部注入的音频流（会议模式按「录音源」合成好的流）：给了就用它采集，
   *  且**不**由本 hook 停止其轨道（生命周期归调用方）。返回 null / 不传 = 自建麦克风流。 */
  getMediaStream?: () => MediaStream | null;
  /** 收尾不做「离线重转定稿」（改用实时结果 + 标点），会议模式用：
   *  45s 一段时重转只会拖慢分段并白攒 PCM，标点仍照做（每段字幕都带句读）。
   *  缺省 false = 原行为（按 ✓ 用离线模型重转定稿）。仅对本地实时链路有效。 */
  skipFinalizeRefine?: boolean;
  /** 按句交出结果（会议字幕「一行一句」用）：本地实时链路每次判出说话人停顿就回调 onSegment；
   *  收尾的 onText 只再交「还没按句发过的余量」。缺省 false = 全部攒到收尾一次走 onText。 */
  emitSegments?: boolean;
  /** 按句定稿的一句（仅 emitSegments 链路回调）。 */
  onSegment?: (text: string) => void;
  /** 流式链路的会话**意外**中断（本地引擎被空闲回收 / 崩溃 / 卡死无响应）。
   *  会议模式据此收尾当前段并重开一轮——否则一场会议剩下的时间会静默地不再转写。 */
  onSessionLost?: (reason: string) => void;
}

export interface VoiceInputApi {
  recording: boolean;
  transcribing: boolean;
  /** 录音秒数（录音条计时用） */
  seconds: number;
  /** 波形柱的 DOM 引用（VoiceRecordBar 用；调用方也可自绘） */
  barsRef: RefObject<Array<HTMLSpanElement | null>>;
  start: () => void;
  /** cancel=true 丢弃录音；false 收尾并转写回填 */
  finish: (cancel: boolean) => void;
}

export function useVoiceInput({ onText, onError, onStartError, canStart = true, onPartial, onDiscard, getMediaStream, skipFinalizeRefine = false, emitSegments = false, onSegment, onSessionLost }: VoiceInputOptions): VoiceInputApi {
  const [recording, setRecording] = useState(false);
  /** 收尾转写中（转写完成前输入框浮层保持可见） */
  const [transcribing, setTranscribing] = useState(false);
  const [seconds, setSeconds] = useState(0);

  /** 当前正在使用的转写链路（null = 空闲） */
  const activeRef = useRef<SttProvider | null>(null);
  /** 选链路 / getUserMedia 期间占位，避免连点重复启动 */
  const phaseRef = useRef<'idle' | 'starting'>('idle');

  // 两条链路共用的采集态
  const streamRef = useRef<MediaStream | null>(null);
  /** streamRef 指向的流是否由本 hook 拥有（true 才在收尾时停轨；外部注入的流归调用方管） */
  const ownsStreamRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  /** 采集源节点：波形与 realtime 的 worklet **共用同一个源**（再建一个会让波形振幅翻倍） */
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // 回调走 ref：录音是「开始 → 异步结束」的跨帧过程，onstop 里必须拿到**最新**回调，
  // 否则用的是开始那一刻的闭包。放 ref 后 runtime 就能保持引用恒定。
  const cbRef = useRef({ onText, onError, onStartError, onPartial, onDiscard, onSegment, onSessionLost });
  useEffect(() => {
    cbRef.current = { onText, onError, onStartError, onPartial, onDiscard, onSegment, onSessionLost };
  }, [onText, onError, onStartError, onPartial, onDiscard, onSegment, onSessionLost]);

  /** 录音没起来时的统一出口：控制台留痕 + 让调用方把原因讲给用户（否则界面全无反应） */
  const reportStartFailure = useCallback((reason: string, raw?: unknown) => {
    console.warn('录音未启动:', reason, raw ?? '');
    const cb = cbRef.current;
    (cb.onStartError ?? cb.onError)?.(reason);
  }, []);

  /** 释放本轮的采集资源（麦克风轨 / 计时 / 波形 / AudioContext）；两条链路共用。
   *  worklet 节点的摘除由 realtime provider 自己负责（它才是持有者）。 */
  const teardownAudio = useCallback(() => {
    if (ownsStreamRef.current) streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    analyserRef.current = null;
    const src = sourceRef.current;
    sourceRef.current = null;
    if (src) src.disconnect();
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
  }, []);

  // ---------------------------------------------------------------
  // 实时音量波形：AnalyserNode RMS 驱动 8 根柱（每根叠加相位差，出波浪感）
  // ---------------------------------------------------------------
  const startWaveform = useCallback((ctx: AudioContext, analyser: AnalyserNode, stream: MediaStream) => {
    // 源节点存进 sourceRef：流式链路要挂 worklet，必须复用同一个源（再建一个会让波形振幅翻倍）
    const src = ctx.createMediaStreamSource(stream);
    src.connect(analyser);
    sourceRef.current = src;
    const buf = new Uint8Array(analyser.fftSize);
    let lastResumeAt = 0;
    const tick = () => {
      const an = analyserRef.current;
      if (!an) return;
      // 兜底：若上下文仍停在 suspended（手势判定丢失），每秒重试一次 resume，恢复后立刻出波形
      // （限流，避免每帧调用被浏览器反复拒绝并刷控制台告警）
      const cur = audioCtxRef.current;
      if (cur && cur.state === 'suspended' && performance.now() - lastResumeAt > 1000) {
        lastResumeAt = performance.now();
        void cur.resume().catch(() => undefined);
      }
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const d = (buf[i] - 128) / 128;
        sum += d * d;
      }
      const rms = Math.sqrt(sum / buf.length); // 0~1（说话时典型 0.05-0.4，再放大）
      const t = performance.now() / 1000;
      const bars = barsRef.current;
      for (let i = 0; i < bars.length; i++) {
        const el = bars[i];
        if (!el) continue;
        const wave = Math.abs(Math.sin(t * 2.4 + i * 0.85));
        // 柱高上限 12px：录音条是麦克风旁的一条内联窄条（h-4），不再有覆盖整框的浮层空间。
        const h = 3 + Math.min(1, rms * 3.2) * 12 * (0.3 + 0.7 * wave);
        el.style.height = `${h}px`;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const start = useCallback(() => {
    if (phaseRef.current !== 'idle' || activeRef.current || !canStart) return;
    // 会议模式：外部已按「录音源」合成好流（麦克风 / 系统音频 / 两者），有则直接用，免自建麦克风
    const injected = getMediaStream?.() ?? null;
    if (!injected && (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia)) {
      reportStartFailure(
        'This page cannot access the microphone. Recording requires a secure context (https:// or http://localhost) and must not run inside an embedded preview frame — open the app directly at http://localhost:<port> in your browser.',
      );
      return;
    }
    phaseRef.current = 'starting';
    void (async () => {
      // 波形/采集用的 AudioContext 必须在「用户手势的同步帧内」创建：getUserMedia 是异步的，
      // await 之后手势上下文已失效，此时 new AudioContext() 会停在 suspended，
      // getByteTimeDomainData 恒返回静音（全 128）→ RMS 恒为 0 → 波形柱一动不动。
      // 故先建图，拿到流之后再接 MediaStreamSource。流式要 16k，故直接按 16k 建。
      let ctx: AudioContext | null = null;
      let analyser: AnalyserNode | null = null;
      try {
        const Ctor: typeof AudioContext | undefined =
          typeof window !== 'undefined'
            ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
            : undefined;
        if (Ctor) {
          ctx = new Ctor({ sampleRate: VOICE_SAMPLE_RATE });
          if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
          analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          audioCtxRef.current = ctx;
          analyserRef.current = analyser;
        }
      } catch {
        // Web Audio 不可用（如非安全上下文）：波形柱静止在基线，录音照常
        ctx = null;
        analyser = null;
      }

      let stream: MediaStream | null = null;
      try {
        const media = injected ?? await navigator.mediaDevices.getUserMedia({ audio: true });
        ownsStreamRef.current = !injected;   // 外部注入的流生命周期归调用方，本 hook 不停其轨道
        stream = injected ? null : media;    // 仅供下面的失败清理使用
        streamRef.current = media;
        setRecording(true);
        setSeconds(0);
        setTranscribing(false);
        timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
        if (ctx && analyser) startWaveform(ctx, analyser, media);

        // 交给链路的一切（麦克风 / AudioContext / 源节点 / 回调 / 收尾）
        const runtime: VoiceRuntime = {
          stream: media,
          ctx,
          ensureSource: (c) => {
            if (!sourceRef.current) sourceRef.current = c.createMediaStreamSource(media);
            return sourceRef.current;
          },
          teardown: teardownAudio,
          onPartial: (text) => cbRef.current.onPartial?.(text),
          onText: (text) => cbRef.current.onText(text),
          onError: (reason) => cbRef.current.onError?.(reason),
          onDiscard: () => cbRef.current.onDiscard?.(),
          onSegment: (text) => cbRef.current.onSegment?.(text),
          onSessionLost: (reason) => cbRef.current.onSessionLost?.(reason),
        };

        // 实时优先：本地 realtime 模型就绪 + 浏览器支持 AudioWorklet 才走
        const realtime = createRealtimeProvider({ skipFinalizeRefine, emitSegments });
        const workletOk = !!ctx && typeof AudioWorkletNode !== 'undefined' && !!ctx.audioWorklet;
        if (workletOk && (await realtime.probe())) {
          try {
            await realtime.start(runtime);
            activeRef.current = realtime;
            return; // 已切到实时链路
          } catch (e) {
            // 实时没起来不打断用户：退回「录完再转写」，此刻起录的音频照样能转。
            // 实时若已写出过中间文字，那部分拿不到定稿，故先把草稿还原掉再走录制链路。
            console.warn('本地流式转写不可用，回退到录制后转写:', e);
            realtime.abort();
            runtime.onDiscard();
          }
        }
        const recorder = createRecorderProvider();
        await recorder.start(runtime);
        activeRef.current = recorder;
      } catch (e) {
        // 录音没起来：释放提前建好的 Web Audio 图与已拿到的麦克风，避免留下僵尸资源
        analyserRef.current = null;
        audioCtxRef.current = null;
        if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
        stream?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        setRecording(false);
        setSeconds(0);
        reportStartFailure(describeMicFailure(e), e);
      } finally {
        phaseRef.current = 'idle';
      }
    })();
  }, [canStart, reportStartFailure, startWaveform, teardownAudio, getMediaStream, skipFinalizeRefine, emitSegments]);

  /** 停止录音并落地：cancel=false 时收尾转写，文字交给调用方（由 bundle 里的 provider 回调） */
  const finish = useCallback((cancel: boolean) => {
    const provider = activeRef.current;
    if (!provider) return;
    activeRef.current = null;
    setRecording(false);
    setSeconds(0);
    if (cancel) {
      void provider.finish(true);
      return;
    }
    setTranscribing(true);
    void provider.finish(false).finally(() => setTranscribing(false));
  }, []);

  // 卸载时释放录音资源（进行中录音丢弃）
  useEffect(() => {
    return () => {
      const provider = activeRef.current;
      activeRef.current = null;
      provider?.abort();
      if (timerRef.current) clearInterval(timerRef.current);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (ownsStreamRef.current) streamRef.current?.getTracks().forEach((t) => t.stop());
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
    };
  }, []);

  return { recording, transcribing, seconds, barsRef, start, finish };
}

/**
 * 录音 / 转写条：贴在麦克风按钮**左侧**就地展开的一条窄条，不覆盖输入框。
 * 调用方把它放在麦克风按钮之前（同行 flex / 绝对定位到麦克风左边），它便自然向左挤开空间。
 * 录音＝✕ 取消 + 实时音量波形 + 计时 + ✓ 完成；转写＝转圈 + Transcribing…。
 * 实时文字**不在条里**：流式链路的中间结果直接「边说边写」进输入框（见 onPartial），
 * 条里再放一份只会把同一句话显示两遍。
 * 高度固定 h-7，与工具行按钮同高，故不需要圆角参数（调用方可用 className 微调）。
 */
export function VoiceRecordBar({ voice, className }: { voice: VoiceInputApi; className?: string }) {
  if (!voice.recording && !voice.transcribing) return null;
  return (
    <div
      className={`flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 ${className ?? ''}`}
      onClick={(e) => e.stopPropagation()}
      style={{
        // 混到 --panel-bg 而非透明：抽屉/画布的用法是绝对定位浮在正文之上，半透明会让底下文字穿出来
        backgroundColor: 'color-mix(in oklab, var(--primary) 8%, var(--panel-bg))',
        border: '1px solid color-mix(in oklab, var(--primary) 35%, transparent)',
      }}
    >
      {voice.transcribing && !voice.recording ? (
        <>
          <div
            className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent"
            style={{ color: 'var(--ink-muted)' }}
          />
          {/* 文字已经在输入框里了，这里只留一个"还在收尾"的信号 */}
          <span className="shrink-0 text-xs" style={{ color: 'var(--ink-muted)' }}>
            Transcribing…
          </span>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              voice.finish(true);
            }}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-70"
            style={{ color: 'var(--ink-muted)' }}
            title="Discard recording"
            aria-label="Discard recording"
          >
            <X className="h-3 w-3" />
          </button>
          <div className="flex h-4 shrink-0 items-center gap-[2px]">
            {Array.from({ length: 8 }).map((_, i) => (
              <span
                key={i}
                ref={(el) => {
                  voice.barsRef.current[i] = el;
                }}
                className="w-0.5 rounded-full transition-[height] duration-75"
                style={{ height: '3px', backgroundColor: 'var(--primary)' }}
              />
            ))}
          </div>
          <span className="shrink-0 tabular-nums text-xs" style={{ color: 'var(--ink-muted)' }}>
            {Math.floor(voice.seconds / 60)}:{String(voice.seconds % 60).padStart(2, '0')}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              voice.finish(false);
            }}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-70"
            style={{ color: 'var(--primary-strong)' }}
            title="Finish and transcribe"
            aria-label="Finish and transcribe"
          >
            <Check className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  );
}