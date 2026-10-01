'use client';

/**
 * MeetingReplay —— 会议回放（录音播放器 + 字幕联动）
 *
 * 上方播放器、下方带时间戳的转写：点一句跳到那一刻，播放时高亮当前句并自动跟随滚动（对标飞书妙记）。
 *
 * 音频来源（按优先级降级，全程不依赖 HTTP Range —— 项目里的文件代理不支持 206）：
 *   1) 已合并件 `录音 - <标题>.webm` → 直接抓成 Blob 播；
 *   2) 多于一片 → 请服务端 ffmpeg 合并（快，且产物落盘下次直接复用）；
 *   3) 服务端合并不可用 → **客户端按序拼接**分片（同一次 MediaRecorder 会话的分片顺序拼接可播，
 *      代价是时长元数据缺失 → 用 `currentTime = 1e101 → 0` 触发时长推断，seek 可能略有偏差）；
 *   4) 分片全丢 → 纯转写模式 + 顶部提示，不报错。
 *
 * 字幕来源：`replay_audio` 一并返回的带戳转写（点的是纪要时服务端已换成同目录的「会议记录」）。
 * 戳的粒度是段级（Live 45s / Import 60s），因此高亮以「段」为单位，段内不做插值。
 *
 * 说话人身份层：播放器下方是名单（色块 + 可编辑名字 + 认出程度），字幕段首按名单显示人名。
 * 文稿里的 `[说话人 N]` 一字不改——名字只在渲染时映射，故库里改名后翻旧录音也会跟着变。
 * 名单由 `replay_audio` 只读分离缓存得来；老录音（升级前没有声纹缓存）名单为空，
 * 此时显示 Identify speakers 按钮，由用户点了才补跑一次分离（几十秒的重活不替用户决定）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, Loader2, Users } from 'lucide-react';
import { bus, BusEvents } from '@/lib/bus';
import { parseTranscriptSegments } from '@/lib/core/meeting-transcript';

/** 与 MeetingStart / MeetingConsole 同款分割线 */
const DIVIDER_SOFT = '1px solid color-mix(in oklab, var(--line-soft) 40%, transparent)';

/** 回放侧的一条音频（口径与 /api/butler/meeting 的 replay_audio 一致） */
export interface ReplayAudioRef {
  source: 'local' | 'project';
  path: string;
  name: string;
  size: number;
}

/** 说话人名单的一项（口径与 /api/butler/meeting 的 speakerRoster 一致） */
export interface SpeakerRosterEntry {
  /** 0 基簇号：命名时按它写回（文稿里显示的是 n） */
  speaker: number;
  /** 1 基显示号，与文稿里的 `[说话人 N]` 同口径 */
  n: number;
  /** 声纹库里认出的名字；null = 认不出（显示匿名 Speaker N） */
  name: string | null;
  /** 与库中质心的余弦相似度（0~1）；未认出为 null */
  similarity: number | null;
  /** 聚类置信度（0~1）；引擎没给为 null */
  confidence: number | null;
}

interface ReplayData {
  title: string;
  name: string;
  transcript: string;
  transcriptPath: string;
  audio: ReplayAudioRef[];
  merged: ReplayAudioRef | null;
  missing: boolean;
  /** 说话人名单（只读分离缓存得来；老录音没有缓存时为空 → 显示 Identify speakers） */
  speakers?: SpeakerRosterEntry[];
}

/** 说话人色板（循环取用）：中明度，浅色底与深色底上都能读清 */
const SPEAKER_COLORS = ['#0ea5e9', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#14b8a6', '#6366f1'];
const speakerColor = (s: number) => SPEAKER_COLORS[s % SPEAKER_COLORS.length];

/** 秒 → `mm:ss`（与引擎转写时间戳同口径，>99 分钟自然进位） */
function mmss(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 文件大小 → 人类可读（顶栏元信息） */
function formatSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}



/** 代理 URL：local 走 /api/local-files，project 走 /api/projects（都需要当前项目 id） */
async function proxyUrl(a: ReplayAudioRef): Promise<string> {
  if (a.source === 'local') return `/api/local-files?action=file_proxy&path=${encodeURIComponent(a.path)}`;
  const projectId = await fetch('/api/projects')
    .then((r) => r.json())
    .then((d) => String(d?.current_id || ''))
    .catch(() => '');
  return `/api/projects?action=file_proxy&project_id=${encodeURIComponent(projectId)}&file_path=${encodeURIComponent(a.path)}`;
}

/** 扩展名 → MIME（文件代理对 .webm/.m4a 等返回 application/octet-stream，需按扩展名纠正） */
const AUDIO_MIME: Record<string, string> = {
  '.webm': 'audio/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
};

function mimeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && AUDIO_MIME[name.slice(dot).toLowerCase()]) || 'audio/webm';
}

/** 抓一份音频为 Blob（无 Range 支持 → 整份抓下来再播；blob URL 可任意 seek） */
async function fetchBlob(a: ReplayAudioRef): Promise<Blob> {
  const resp = await fetch(await proxyUrl(a));
  if (!resp.ok) throw new Error(`Failed to load ${a.name}`);
  const raw = await resp.blob();
  // 代理给的是 octet-stream 时按扩展名纠正 MIME，否则 <audio> 可能直接拒绝播放
  return raw.type && raw.type !== 'application/octet-stream' ? raw : new Blob([raw], { type: mimeOf(a.name) });
}

/** 调 /api/butler/meeting 的薄封装（失败返回 null） */
async function postMeeting(payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetch('/api/butler/meeting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await resp.json();
  } catch {
    return null;
  }
}

export function MeetingReplay({
  source,
  path,
  name,
  onBack,
}: {
  /** 点开的产物所在侧 */
  source: 'local' | 'project';
  /** 点开的产物路径（local = 绝对路径；project = 项目内相对路径） */
  path: string;
  /** 产物文件名（顶栏兜底标题 + Open file） */
  name: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<ReplayData | null>(null);
  const [preparing, setPreparing] = useState(true);
  /** 降级/异常的一句提示（无音频、浏览器拼接、加载失败都走它，绝不整屏报错） */
  const [note, setNote] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [active, setActive] = useState(-1);
  /** 是否跟随播放自动滚动（用户上滑看前文即解除） */
  const [pinned, setPinned] = useState(true);
  /** 说话人名单：库认出的名字/相似度，外加「正在分析」「分析过但还是没有」两个状态 */
  const [roster, setRoster] = useState<SpeakerRosterEntry[]>([]);
  const [identifying, setIdentifying] = useState(false);
  const [identifyTried, setIdentifyTried] = useState(false);
  /** 正在编辑、尚未提交的名字（按簇号存）；提交后清空，改回以 roster 为准 */
  const [draft, setDraft] = useState<Record<number, string>>({});
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const segments = useMemo(() => (data ? parseTranscriptSegments(data.transcript) : []), [data]);
  /** 这场录音有没有贴过说话人标签（老产物 / 单人录音都没有 → 整个名单区不出现）。
   *  标签只来自**会后的整段重转**：会议进行中不做说话人识别。 */
  const labeled = useMemo(() => segments.some((s) => s.speaker !== null), [segments]);
  /** 簇号 → 名字/显示名（渲染字幕用） */
  const nameOf = useCallback(
    (s: number) => roster.find((r) => r.speaker === s)?.name || `Speaker ${s + 1}`,
    [roster],
  );

  // 加载：转写 + 音频清单 → 取音频（合并件 → 服务端合并 → 客户端拼接 → 纯转写）
  useEffect(() => {
    let dead = false;
    let created: string | null = null;
    setPreparing(true);
    setNote(null);
    setAudioUrl('');
    setActive(-1);
    setPinned(true);
    setRoster([]);
    setIdentifying(false);
    setIdentifyTried(false);
    setDraft({});
    void (async () => {
      try {
        const d = await postMeeting({ action: 'replay_audio', source, path });
        if (!d?.success) throw new Error(String(d?.error || 'Could not load this meeting'));
        if (dead) return;
        const info = d as unknown as ReplayData;
        setData(info);
        setRoster(info.speakers ?? []);

        let target: ReplayAudioRef | null = info.merged;
        if (!target && info.audio.length > 1) {
          // 服务端合并：快且产物落盘，下次直接复用
          const c = await postMeeting({ action: 'concat_audio', source, path });
          if (dead) return;
          if (c?.success && c.merged) target = c.merged as ReplayAudioRef;
        }

        let blob: Blob | null = null;
        if (target) {
          blob = await fetchBlob(target);
        } else if (info.audio.length > 1) {
          // 客户端顺序拼接（同一次 MediaRecorder 会话的分片按序拼可播）
          const parts = await Promise.all(info.audio.map(fetchBlob));
          if (dead) return;
          blob = new Blob(parts, { type: parts[0]?.type || 'audio/webm' });
          setNote('Merged in the browser — seeking may be slightly off.');
        } else if (info.audio.length === 1) {
          blob = await fetchBlob(info.audio[0]);
        }
        if (dead) return;
        if (!blob) {
          setNote('The recording is missing — showing the transcript only.');
          return;
        }
        created = URL.createObjectURL(blob);
        setAudioUrl(created);
      } catch (e) {
        if (!dead) setNote(e instanceof Error ? e.message : 'Failed to load this meeting');
      } finally {
        if (!dead) setPreparing(false);
      }
    })();
    return () => {
      dead = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [source, path]);

  /** MediaRecorder 产物常无时长元数据：用一次越界 seek 逼浏览器算出真实时长（否则进度条不可拖） */
  const onLoadedMetadata = useCallback(() => {
    const el = audioElRef.current;
    if (!el || el.duration !== Infinity) return;
    const onSeeked = () => {
      el.currentTime = 0;
      el.removeEventListener('seeked', onSeeked);
    };
    el.addEventListener('seeked', onSeeked);
    el.currentTime = 1e101;
  }, []);

  /** 播放推进 → 二分找当前段（最后一个 t ≤ currentTime 的段） */
  const onTimeUpdate = useCallback(() => {
    const el = audioElRef.current;
    if (!el || segments.length === 0) return;
    const t = el.currentTime;
    let lo = 0;
    let hi = segments.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid].t <= t) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    setActive((prev) => (prev === idx ? prev : idx));
  }, [segments]);

  // 跟随：贴底态下把当前段滚到可视区中间（用户上滑后 pinned=false，不再抢滚动）
  useEffect(() => {
    if (!pinned || active < 0) return;
    rowRefs.current[active]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [active, pinned]);

  /** 字幕流是否贴底（判定阈值与 MeetingConsole 一致） */
  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 32);
  }, []);

  /** 点一句 → 跳到那一刻并播放 */
  const seek = useCallback(
    (t: number) => {
      const el = audioElRef.current;
      if (!el || !audioUrl) return;
      el.currentTime = t;
      setPinned(true);
      void el.play().catch(() => undefined);
    },
    [audioUrl],
  );

  /**
   * 给老录音补跑一次说话人分离（replay_audio 的名单只读缓存，所以这一步必须用户点头）。
   * 要等几十秒——期间按钮位显示进度提示，不是静默卡住。
   */
  const identify = useCallback(async () => {
    setIdentifying(true);
    try {
      const d = await postMeeting({ action: 'speaker_identify', source, path });
      const list = d?.success && Array.isArray(d.speakers) ? (d.speakers as SpeakerRosterEntry[]) : [];
      setRoster(list);
      setIdentifyTried(true);
      if (list.length === 0) {
        setNote(String(d?.error || 'No speakers could be identified in this recording.'));
      }
    } finally {
      setIdentifying(false);
    }
  }, [source, path]);

  /** 提交一个说话人的名字：该簇质心写进项目声纹库，同一人在别的录音里也能被认出 */
  const commitName = useCallback(
    async (s: number) => {
      const raw = (draft[s] ?? '').trim();
      if (!raw) {
        // 清空 = 不改名：把这一格的草稿丢掉，显示回库里那条名字（避免输入框一直空着）
        setDraft((p) => {
          const next = { ...p };
          delete next[s];
          return next;
        });
        return;
      }
      const d = await postMeeting({ action: 'speaker_name', source, path, speaker: s, name: raw });
      if (d?.success && Array.isArray(d.speakers)) {
        setRoster(d.speakers as SpeakerRosterEntry[]);
        setDraft({});
      } else {
        setNote(String(d?.error || 'Could not save that speaker name.'));
      }
    },
    [draft, source, path],
  );

  const parts = data?.audio.length ?? 0;
  const meta = [`${parts} part${parts === 1 ? '' : 's'}`, formatSize((data?.merged || data?.audio[0])?.size || 0)]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ backgroundColor: 'var(--panel-bg)' }}>
      {/* 顶栏：返回 + 标题 + Open file */}
      <div className="flex items-center gap-1.5 px-3 py-2" style={{ borderBottom: DIVIDER_SOFT }}>
        <button
          type="button"
          onClick={onBack}
          className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-10 font-medium transition-colors hover:bg-[var(--paper-hover)]"
          style={{ color: 'var(--ink-muted)' }}
        >
          <ArrowLeft className="h-3 w-3" />
          Back
        </button>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold" style={{ color: 'var(--ink-strong)' }} title={data?.title || name}>
          {data?.title || name}
        </span>
        <button
          type="button"
          onClick={() => bus.publish(BusEvents.fileOpen, { source, path, name })}
          className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-10 font-medium transition-colors hover:bg-[var(--paper-hover)]"
          style={{ color: 'var(--primary-strong)' }}
        >
          Open file
          <ExternalLink className="h-3 w-3" />
        </button>
      </div>

      {/* 播放器（吸顶）：准备中 → 转圈；有音频 → 原生控件；无音频 → 一句提示 */}
      <div className="px-3 py-2" style={{ borderBottom: DIVIDER_SOFT }}>
        {preparing ? (
          <div className="flex items-center gap-1.5 text-10" style={{ color: 'var(--ink-muted)' }}>
            <Loader2 className="h-3 w-3 animate-spin" /> Preparing audio…
          </div>
        ) : audioUrl ? (
          <audio
            ref={audioElRef}
            src={audioUrl}
            controls
            className="w-full"
            onTimeUpdate={onTimeUpdate}
            onLoadedMetadata={onLoadedMetadata}
          />
        ) : (
          <p className="text-10 leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            {note || 'Audio is unavailable for this meeting.'}
          </p>
        )}
        {audioUrl && note && (
          <p className="mt-1 text-10" style={{ color: 'var(--ink-faint)' }}>{note}</p>
        )}
        {!!meta && !preparing && (
          <p className="mt-1 text-10" style={{ color: 'var(--ink-faint)' }}>{meta}</p>
        )}
      </div>

      {/* 说话人名单：改了名字即写进项目声纹库，字幕里的称呼随之更新（文稿不改） */}
      {labeled && !preparing && (
        <div className="px-3 py-1.5" style={{ borderBottom: DIVIDER_SOFT }}>
          {identifying ? (
            <div className="flex items-center gap-1.5 text-10" style={{ color: 'var(--ink-muted)' }}>
              <Loader2 className="h-3 w-3 animate-spin" /> Analyzing speakers…
            </div>
          ) : roster.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {roster.map((r) => {
                // 认出程度只放进 tooltip：名单本身要保持极简（相似度低 = 心里有数，不必常显）
                const bits = [
                  r.similarity !== null ? `${Math.round(r.similarity * 100)}% match` : '',
                  r.confidence !== null ? `${Math.round(r.confidence * 100)}% clustering confidence` : '',
                ].filter(Boolean);
                return (
                  <label key={r.speaker} className="flex min-w-0 items-center gap-1.5" title={bits.join(' · ') || 'Not recognized'}>
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: speakerColor(r.speaker) }} />
                    <input
                      value={draft[r.speaker] ?? r.name ?? ''}
                      placeholder={`Speaker ${r.n}`}
                      spellCheck={false}
                      onChange={(e) => setDraft((p) => ({ ...p, [r.speaker]: e.target.value }))}
                      onBlur={() => void commitName(r.speaker)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                      }}
                      className="w-24 min-w-0 rounded-sm bg-transparent px-1 py-0.5 text-10 outline-none transition-colors hover:bg-[var(--paper-hover)] focus:bg-[var(--paper-hover)]"
                      style={{ color: 'var(--ink-strong)' }}
                    />
                  </label>
                );
              })}
            </div>
          ) : identifyTried ? (
            <p className="text-10" style={{ color: 'var(--ink-faint)' }}>No speakers could be identified.</p>
          ) : (
            <button
              type="button"
              onClick={() => void identify()}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-10 font-medium transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--primary-strong)' }}
            >
              <Users className="h-3 w-3" />
              Identify speakers
            </button>
          )}
        </div>
      )}

      {/* 字幕：点一句跳转；播放时高亮当前段并跟随 */}
      <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {!data && preparing && (
          <div className="flex items-center gap-1.5 text-10" style={{ color: 'var(--ink-faint)' }}>
            <Loader2 className="h-3 w-3 animate-spin" /> Loading transcript…
          </div>
        )}
        {data && segments.length === 0 && (
          <p className="whitespace-pre-wrap text-xs leading-relaxed" style={{ color: 'var(--ink)' }}>
            {data.transcript}
          </p>
        )}
        {segments.map((s, i) => {
          const on = i === active;
          return (
            <button
              key={`${s.t}-${i}`}
              ref={(el) => { rowRefs.current[i] = el; }}
              type="button"
              onClick={() => seek(s.t)}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
              style={{ backgroundColor: on ? 'color-mix(in oklab, var(--primary) 10%, transparent)' : undefined }}
            >
              <span
                className="mt-0.5 shrink-0 font-mono text-10"
                style={{ color: on ? 'var(--primary-strong)' : 'var(--ink-faint)' }}
              >
                {mmss(s.t)}
              </span>
              <span className="min-w-0 flex-1">
                {s.speaker !== null && (
                  <span className="block text-10 font-medium" style={{ color: speakerColor(s.speaker) }}>
                    {nameOf(s.speaker)}
                  </span>
                )}
                <span
                  className="block whitespace-pre-wrap text-xs leading-relaxed"
                  style={{ color: on ? 'var(--ink-strong)' : 'var(--ink)' }}
                >
                  {s.text}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}