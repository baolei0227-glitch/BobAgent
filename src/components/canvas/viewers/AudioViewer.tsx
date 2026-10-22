'use client';

/**
 * AudioViewer —— 画布预览面板里的音频查看器（波形 + 打点 + 截取 + 转写 + 导入 + 库浏览）。
 *
 * 共用 MeetingReplay 同款 AudioMarkTrack（波形 / 打点圆点 / 拖拽选区 / ffmpeg 截取），
 * 但持久化走不同的路：
 *   - 会议录音：打点挂在转写 md 的注释行上（MeetingReplay 走 /api/butler/meeting）
 *   - 画布音频：打点、片段清单与**转写**都存在应用自有音频库目录里（库内音频就地、库外音频影子目录，
 *     见 lib/audio/library.ts），一律不落进 workspace；本组件走 /api/audio/clip 与 /api/audio/ai
 *
 * 打点 / 截取的智能化（2026-10-11 二轮，2026-10-17 收敛）—— 链路是一条：
 *   `Understand this audio`（转写，`action:'transcribe'`）→ sidecar `<base>.transcript.json`
 *   → `TranscriptPanel`（**看稿 + 定位**：对话稿形式 + 点句/点轮首跳转）
 *   → ① AI 精选挑出的区间可**手动落成打点**（`marksFromRanges`，追加 + 幂等去重 + 带 `auto` 位）；
 *      ② `Split at marks` / AI 精选：都汇到 `action:'clip_many'`（一次请求导出多个）；
 *      ③ 片段默认名取区间转写文本前 12 字，`✦` 可让模型给个 ≤12 字标题（`/api/audio/ai`）；
 *   `Polish`：用 DSH 任务模型（deepseek-flash）把 ASR 原文整理成可读对话轮，
 *      只改 text、不动 speaker/时间，并保留 `Raw` 原文可切回。
 *
 * 2026-10-17 收敛：`Transcript` 页签定位为**阅读面**为主（用户原话"用户可以查看文字对话稿，
 *   点击后，时间线出现在音轨对应位置"）——逐行的勾选 / `＋` 打点 / `✂` 截取与顶部 `Clip N`
 *   全部移除；打点与截取仍在别处：音轨上拖选 + 选区按钮、AI 精选（勾选后可**落点** / 导出）、`Split at marks`。
 *   同日删：`Generate marks`（按转写逐段铺点）—— 对话稿本身已能定位，逐段铺点只是噪音；
 *   那些点在音轨上也改用**青色**与手打点（琥珀）分开（见 globals.css `--mark-line-ai`）。
 *   同日补：句子的**文字可原地改**（正文即输入框：点正文落光标直接改，Enter 保存 / Esc 还原），
 *   走 `action:'save_transcript'` 写回 sidecar；只改 `text`、不动时间轴，故已有打点与片段不失位。
 *
 * 四条设计纪律（改动本文件前先读）：
 *   - **转写是增强项**：读不到就退化成原来的纯手工编辑器，绝不阻断、绝不显示错误痕迹；
 *   - **AI 只给建议**：精选区间一律硬校验（越界即丢弃）、勾选后才导出，**绝不自动落盘**；
 *   - **打点改动只有一个落盘口**（`applyMarks`）：乐观上屏 + 撤销栈 + await 结果并如实报错；
 *   - **新 UI 一律排在 `{marks}` 之后**（转写面板 / 建议卡 / 片段区），且自带滚动或高度有界
 *     —— 否则会重现"持久列表被交互推走"的老缺陷（见 AudioMarkTrack 文件头的行序口径）。
 *
 * 导入：面板内可直接选一个本地音频 → **复制进应用自有音频库**（`<APP_ROOT>/.audio-library/`，
 * 见 lib/audio/library.ts），随即作为新的源音频载入编辑；不落 workspace 的 materials / homework。
 *
 * 库浏览：点 Library 列出库内全部音频（全局库，仅含 source.* 的目录），点击载入、可删除。
 *
 * 片段：截出来同样**不进 workspace**，与源音频同居一处（`<APP_ROOT>/.audio-library/<源名>-<指纹>/`，
 * 见 lib/audio/library.ts），归属靠 lineage 记录。
 *
 * **关系（2026-10-17 晚，一主多摘）**：主音频是唯一实体；片段是它上面的一个**命名区间**（+ 一次导出）。
 * 打开源音频即在波形下方列出它的全部区间：选中 = 聚光该段，可**播放 / 改名 / 导出 / 删除**；
 * 拖两端只改区间（`update_clip_range`，不跑 ffmpeg、不覆写文件），导出时才按当前区间现渲染。
 * 片段没有自己的时间轴 —— 要独立编辑，必须显式 fork 成一条新的主音频（后续项）。
 *
 * 音频源：project 侧沿用调度层给的 proxyUrl（它用相对 filePath）；本地音频（导入的库内文件、
 * 片段）都是绝对路径，走 /api/local-files 的 file_proxy。代理不可用时退回"用默认程序打开"。
 *
 * 加载方式（两条，由服务端判定，见下方 loadAudio）：
 *   - **大文件**：先问服务端要波形峰值（`action=peaks`），播放交给 `<audio src=代理URL>`
 *     走 HTTP Range 按需拉取 —— 不整份下载、不全量解码，长录音不再吃掉几百 MB 内存
 *     （原理与实测见 lib/audio/peaks.ts）；
 *   - **小文件**：整份抓成 Blob 再播（原来的路径），小文件上更省事、波形也更密。
 *
 * 版式口径（字号主次，2026-10-11 定）：
 *   L1 操作 —— 可点击的**文字标签**一律 `text-12`（12px@M），在尺寸通道上高于 L2/L3；
 *   L2 状态 —— 实时读数 `text-10`、状态条 `text-xs`（失败另加 `--danger` + `--danger-soft` 底）；
 *   L3 刻度 —— 时间刻度等纯参考数据 `text-10`（配 `--ink-faint`）。
 *   判定规则：**同一视觉行内，任何可点击文字的字号必须 > 任何不可点击文字的字号**。
 *   ⚠️ 微字号一律用 tailwind.config.js 的 `text-N` 刻度（rem），**禁止 `text-[Npx]`** —— 任意值走 px
 *     基线，绕开 html{font-size:var(--fs-md)}，`data-fontscale` 切档时不跟随（RELEASES v0.5.399 已全站清过一次）。
 *   ⚠️ `text-10/11/12` **不设 line-height**（行盒沿用 `--lh-md`），而 `text-xs/text-sm` 自带行高
 *     —— 跨这两组换 token 会静默改行高（例：`text-11`→`text-xs` 会把行盒 21px 压到 15px）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Bookmark, Check, ChevronLeft, ChevronRight, Crosshair, Download, ExternalLink, FileText, Folder, FolderPlus, GitFork, Library as LibraryIcon, Loader2, Lock, Maximize2, MoreVertical, Music, Pencil, Play, Scissors, SlidersHorizontal, Sparkles, Trash2, Undo2, Upload, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { ViewerRenderProps } from './types';
import { desktop } from '@/lib/desktop-adapter';
import { AudioMarkTrack, type AudioMarkTrackHandle, type AudioTrackViewState, type PrecomputedWaveform } from '@/components/audio/AudioMarkTrack';
import { AudioClipTrack, type ClipDragReport } from '@/components/audio/AudioClipTrack';
import { TranscriptPanel, type ClipRequest } from '@/components/audio/TranscriptPanel';
import type { AudioMark, AudioClipRef } from '@/lib/audio/marks';
import type { ShadowEntry } from '@/lib/audio/library';
import { dropAutoMarks, markLabelFromText, marksFromRanges, ruleHighlights, splitRangesAtMarks } from '@/lib/audio/mark-ops';
import { audioTitle, AUDIO_EXTS } from '@/lib/audio/naming';
import { readApiResult } from '@/lib/audio/api-result';
import { VIEW_MIN_SEC, mmss } from '@/lib/audio/timeline';
import {
  groupSegmentTurns,
  updateSegmentText as applySegmentText,
  updateSegmentStart as applySegmentStart,
  updatePolishedTurnText as applyPolishedTurnText,
  updateSegmentSpeakers as applySegmentSpeakers,
  updateSpeakerName as applySpeakerName,
  normalizeSpeakerName,
  type AudioTranscript,
  type HighlightSuggestion,
  type PolishedTurn,
} from '@/lib/audio/transcript';
import { isAudioOrigin, type AudioOrigin } from '@/lib/audio/origin';

/** file input 的 accept：宽泛 audio/* + 精确扩展名双保险 */
const AUDIO_ACCEPT = ['audio/*', ...AUDIO_EXTS].join(',');

/**
 * 音轨下方详情区的页签（2026-10-17 视觉双轨）。
 * 顺序 = Transcript · Suggested · Excerpts。
 *
 * `Source` 不再是页签：上轨（波形）本身就是源 —— 没有"切回源"这一步，也就没有它自己的区块。
 *
 * `Excerpts` 页签与**片段区间带**是**同一份数据的两视图**，不是二选一：
 *   - 页签 = 一屏清单（播放 / 改名 / 导出 / 删除一次看全）；
 *   - 区间带 = 这些片段在源时间轴上的位置（拖两端改区间，见 `AudioClipTrack`）。
 *   两边共用 `activeClipPath`，点谁都是选中同一个片段；区间是唯一真源，文件是导出时的产物。
 */
type DetailTab = 'transcript' | 'suggested' | 'clips';

/** 说话人模式：auto 让模型决定；duo/group 是用户明确声明人数（CLI 会按人数/更松阈值聚类） */
type SpeakerMode = 'auto' | 'duo' | 'group';

/**
 * 状态条内容。`note` 同时承载「操作失败原因」与「操作成功」，故**显式区分种类** ——
 * 13 个写入点里 11 个是失败，若两者同款渲染，失败提示读起来会和中性说明一模一样。
 * `null` = 无状态（表示「最近一次操作成功且无需告知」或「刚切了目标音频」）。
 */
type NoteState = { kind: 'error' | 'info'; text: string } | null;

/** 失败：红字 + 浅红底 */
const noteError = (text: string): NoteState => ({ kind: 'error', text });
/** 成功 / 中性说明：墨色 muted，无底 */
const noteInfo = (text: string): NoteState => ({ kind: 'info', text });

/**
 * 状态条 —— `note` 的**唯一**渲染器（主视图 / 库面板 / 失败空态三处共用，样式不会各自漂移）。
 *
 * 两种 kind 用**形状**（有无底色）区分而不只是颜色：`note` 与次级动作
 * `Open with default program` 同为 `text-xs` + `--ink-muted`，只有底色能把「系统在告诉你一件事」
 * 与「这里还有一个按钮」分开。两种 kind 的 padding 完全相同 ⇒ 高度不随 kind 变。
 *
 * `reserve` —— 无内容时也保留一行高度（`invisible` 占位）。主视图用它，免得状态条出现/消失
 * 把下方的片段清单推来推去。**用同一个元素占位**而不是外包一层 `min-h-*`：`min-h-6` 是
 * 22.5px@M，而本行的自然高是 23px（`text-xs` 行高 1rem=15px + `py-1` 8px）⇒ 0.5px 的净位移；
 * 同一元素占位则任何字号档位下都严格等高（字号可被 `data-fontscale` 改成 17/19px 根字号，
 * 写死的 `min-h` 都要么偏小要么白留）。
 */
function StatusLine({ note, reserve }: { note: NoteState; reserve?: boolean }) {
  if (!note && !reserve) return null;
  const isError = note?.kind === 'error';
  return (
    <p
      className={`w-fit rounded-md px-2 py-1 text-xs${note ? '' : ' invisible'}`}
      style={{
        color: isError ? 'var(--danger)' : 'var(--ink-muted)',
        backgroundColor: isError ? 'var(--danger-soft)' : 'transparent',
      }}
      role={isError ? 'alert' : undefined}
    >
      {/* ⚠️ 占位必须放一个字符（nbsp），不能给空串：**空元素不生成行盒**，`line-height` 不生效，
          高度只剩 `py-1` 的 7.5px（实测 @M）而不是一行的 22.5px ⇒ 状态条一出现就仍会推下方内容。 */}
      {note ? note.text : '\u00A0'}
    </p>
  );
}

/** 当前正在编辑的音频（首项 = 打开的源音频/导入的库内音频，其余 = 它的片段） */
interface Target {
  /** API 口径的来源侧：project = 项目内文件；local = 本地绝对路径（导入的库内文件 / 片段） */
  source: 'local' | 'project';
  /** API 口径路径 */
  path: string;
  /** 文件名（顶栏标题 + 默认片段名 + 下载文件名） */
  name: string;
  /** 字节数（仅源音频/导入时已知；片段没有） */
  size?: number;
}

/** 库内一条音频（list_library 返回） */
interface LibraryEntry {
  /** 源音频目录的绝对路径 */
  dir: string;
  /** 源音频文件的绝对路径 */
  path: string;
  /** 源音频文件名 */
  name: string;
  /** 字节数 */
  size: number;
  /** 加入库的时间（源文件 mtime，ms）；服务端已按它从新到旧排序，前端只需保序 */
  mtimeMs: number;
}

/**
 * 库分组（list_groups 返回）。
 *
 * 与后端 `AudioGroup` **同形但本地重声明**：`lib/audio/groups.ts` 里带 `node:fs` 等
 * 服务端专属导入，值引入会把 node 内置模块拖进浏览器包（与 `LibraryEntry` 同款处理）。
 */
interface AudioGroup {
  /** 稳定 id；重命名不改，归属靠它引用 */
  id: string;
  /** 展示名 */
  name: string;
}

/**
 * 拖拽时"未分组"定位用的伪组 id。
 * 与真实组 id（`g_` 前缀）永不冲突 ⇒ 可以安全地塞进同一个 `dropTarget` 状态做高亮。
 */
const UNGROUPED_DROP = '__ungrouped__';

function formatSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 秒 → mm:ss（片段清单里的区间标注） */
function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 本地文件的代理 URL（读流 / 下载都走它） */
function localProxy(path: string): string {
  return `/api/local-files?action=file_proxy&path=${encodeURIComponent(path)}`;
}

/** 把代理 URL 抓成 Blob URL（小文件的回退路径：整份下载后任意 seek） */
async function fetchBlob(proxyUrl: string): Promise<string> {
  const resp = await fetch(proxyUrl);
  if (!resp.ok) throw new Error('Failed to load audio');
  const raw = await resp.blob();
  return URL.createObjectURL(raw);
}

/** 一次加载的结果：播放 URL + （可能的）预计算波形；blob 决定卸载时是否需要 revoke */
interface LoadedAudio {
  url: string;
  precomputed: PrecomputedWaveform | null;
  /** true = url 是 Blob URL，必须 revoke；false = 代理 URL，直接交给 <audio>/WaveSurfer */
  blob: boolean;
}

/**
 * 加载一段音频，**优先走「预计算峰值 + Range 直连」**（见文件头与 lib/audio/peaks.ts）。
 *
 * 服务端三态返回（小文件 / 分析不出来）与请求失败一律**退回抓 Blob** —— 这只是加载策略，
 * 任何一步出问题都不该让音频打不开，最差退化成引入 peaks 之前的行为。
 */
async function loadAudio(proxyUrl: string, t: Target): Promise<LoadedAudio> {
  const d = await postAudio({ action: 'peaks', source: t.source, path: t.path });
  const peaks = Array.isArray(d?.peaks) ? (d.peaks as number[]) : null;
  const duration = Number(d?.duration);
  if (d?.success && peaks && peaks.length > 0 && Number.isFinite(duration) && duration > 0) {
    return { url: proxyUrl, precomputed: { peaks, duration }, blob: false };
  }
  return { url: await fetchBlob(proxyUrl), precomputed: null, blob: true };
}

/**
 * 薄封装。**永不返回 null**：任何失败都转成 `{success:false, error}`。
 *
 * 响应体形态的坑（HTML 错误页 / 空体）统一交给纯函数 `readApiResult` 处理，
 * 这里只负责网络层本身不可达的情形，理由见 `lib/audio/api-result.ts` 的头注释。
 */
async function postAudio(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const resp = await fetch('/api/audio/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await readApiResult(resp);
  } catch (e) {
    return { success: false, error: `Request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 模型侧动作（AI 精选 / 片段命名）的薄封装：走**另一条路由**（`/api/audio/ai`，见那里的头注释），
 * 契约与 `postAudio` 完全一致（永不抛、永不返回 null），这样调用点不必区分两套错误形态。
 */
async function postAi(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const resp = await fetch('/api/audio/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await readApiResult(resp);
  } catch (e) {
    return { success: false, error: `Request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** ViewerRenderProps.source → API source 口径 */
function apiSource(s: string): 'local' | 'project' {
  return s === 'project' || s === 'material' ? 'project' : 'local';
}

/** 触发浏览器下载（同源 + download 属性 → 用给定文件名另存，Electron 下走系统保存流程） */
function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 库目录名 → 可读标题（去掉末尾的 -<10位指纹>） */
function libraryTitle(dir: string): string {
  const base = dir.split('/').pop() || 'Audio';
  return base.replace(/-[a-f0-9]{10}$/, '') || base;
}

/**
 * 库条目的**归属键**：目录名的 basename（`<源名>-<指纹>`）。
 * 与后端 `.groups.json` 的 assign 键**同口径**（groups.ts 用 `basename(dir)`）——
 * 两处必须一致，否则归属永远对不上。绝对路径会随 APP_ROOT 失效，故不用它做键。
 */
function libraryKey(dir: string): string {
  return dir.split('/').pop() || '';
}

/**
 * 片段行 `⋮` 菜单的宽度（px）。
 * 与渲染处的 `width: CLIP_MENU_W` **同源**：坐标夹取要用它算左边界，两处各写一个数就会错位。
 */
const CLIP_MENU_W = 184;

/**
 * 片段行 `⋮` 菜单里的一行（图标 + 文案）。
 *
 * 抽出来只为一件事：七个动作的 hover / 禁用 / 危险色必须**同一套口径**，
 * 七份复制粘贴的 className 迟早会走样（`--danger` 那一项尤其不能被漏掉）。
 */
function ClipMenuAction({
  icon,
  label,
  hint,
  disabled,
  danger,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      style={{ color: danger ? 'var(--danger)' : 'var(--ink)' }}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

/**
 * 片段清单里的单行（源音频 / 某条片段）；有 onRename 时可就地改名。
 *
 * 2026-10-18（用户要求）：行尾原先平铺的**七个图标按钮**（播放 / 放大 / 文稿 / 改名 /
 * 导出 / fork / 删除）全部收进一个 `⋮` 菜单 —— 一行只留「名字 + 区间 + ⋮」。
 *   · 为什么：七颗同权重的图标挤在一行里，既没有主次（播放不该和删除等宽），
 *     也把可用宽度吃光（长片段名被压到只剩几个字）；而这一行的真实用法是
 *     「先找名字、再决定做什么」⇒ 名字该是主角，动作该在点开之后。
 *   · 菜单定位用 `fixed` + 打开那一刻的视口坐标：本组件会被渲染进
 *     `max-h-64 overflow-y-auto` 的 Excerpts 列表里（`overflow:auto` 会裁掉 absolute 浮层），
 *     上下又可能被面板壳裁 —— 只有脱离文档流才两处都免疫。代价是滚动/改窗会脱锚，
 *     故一律**收起**而不是跟随重算（见下方 effect）。
 *   · 改名与删除仍复用原有的**行内**输入态 / 二次确认态：菜单只是入口变了，
 *     护栏（改名为空不提交、删除必须确认）不跟着简化。
 */
function ClipRow({
  active,
  name,
  sub,
  onClick,
  onPlay,
  onZoom,
  onTranscript,
  onDownload,
  onRename,
  onFork,
  forkBusy,
  onDelete,
}: {
  active: boolean;
  name: string;
  sub?: string;
  onClick: () => void;
  /**
   * 显式“只播这一段”。没有它时，选中片段会**隐式**把播放收束到该区间
   * （见 `AudioMarkTrack` 的 `toggle`），用户看不出自己是在听片段还是整段；
   * 这颗按钮把同一件事变成明说的动作。
   */
  onPlay?: () => void;
  /**
   * 有值则显示"放大到界面宽度"按钮：把时间轴缩到这一段的宽度（片段铺满一屏）。
   *
   * 只有**可缩放**的文件才给（与标题栏那组缩放控件同一门槛，见 `AudioTrackViewState.zoomable`）——
   * 不缩放的文件给这颗按钮等于摆一个点了没反应的图标。
   */
  onZoom?: () => void;
  /** 有值则显示文稿按钮：只导出这一段区间的对话（片段内相对时间） */
  onTranscript?: () => void;
  /** 有值则显示下载按钮（源音频是用户自己的文件，不需要下载） */
  onDownload?: () => void;
  /** 有值则可改名（源音频不提供） */
  onRename?: (newName: string) => void;
  /**
   * 有值则显示“Make separate audio”：把该片段 fork 成一条新的主音频
   * （自己的波形/打点/转写/再切），原录音不动。见 `forkClip`。
   */
  onFork?: () => void;
  /** 正在 fork 该行（只有被点的那一行转圈，不是整张清单都转） */
  forkBusy?: boolean;
  /** 有值则可删除（源音频不提供） */
  onDelete?: () => void;
}) {
  /** 改名草稿（null = 不在改名态）；预填当前名，提交时才回调 */
  const [draft, setDraft] = useState<string | null>(null);
  /** 删除确认态（删片段是落盘操作，先确认再执行） */
  const [confirming, setConfirming] = useState(false);
  /**
   * `⋮` 菜单的**视口坐标**（null = 关闭）。
   * 存坐标而不是布尔：菜单是 `fixed`（理由见组件 JSDoc），坐标在打开那一刻算一次。
   */
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  /**
   * 打开菜单：右缘贴齐按钮，向下展开；下方装不下就**上翻**，并夹进视口。
   * 高度用**估算**（项数 × 28 + 内边距）—— 只服务于「要不要上翻」这一个判断，
   * 差几像素无碍；换来的是不必先渲染再测量（那会有一拍可见的跳动）。
   */
  const openMenu = () => {
    const btn = menuBtnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const count =
      1 +
      (onZoom ? 1 : 0) +
      (onTranscript ? 1 : 0) +
      (onRename ? 1 : 0) +
      (onDownload ? 1 : 0) +
      (onFork ? 1 : 0) +
      (onDelete ? 1 : 0);
    const estH = count * 34 + 30;
    const left = Math.max(8, Math.min(rect.right - CLIP_MENU_W, window.innerWidth - CLIP_MENU_W - 8));
    let top = rect.bottom + 4;
    if (top + estH > window.innerHeight - 8) top = Math.max(8, rect.top - estH - 4);
    setMenu({ left, top });
  };

  useEffect(() => {
    if (!menu) return;
    /** 点在菜单与 ⋮ 之外 ⇒ 关。⋮ 自己不放这里处理：它由 onClick 负责 toggle */
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || menuBtnRef.current?.contains(t)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    /**
     * 坐标是「打开那一刻」的视口快照 ⇒ 任何滚动/改窗都会让它脱锚。
     * 一律**收起**而不是跟随重算：跟随要重算锚点，而锚点可能在滚动中已经移出可视区。
     * ⚠️ scroll 必须 capture：Excerpts 列表的滚动发生在容器上，冒泡阶段到不了 window。
     * ⚠️ 打开后的 120ms 内不吃 scroll：浏览器把 click 前那次「滚动入视口」的 scroll 事件
     *    **异步派发**在菜单挂载之后，真机验证里就撞上过 —— 菜单刚开就被自己这一拍关掉。
     */
    const openedAt = Date.now();
    const close = () => {
      if (Date.now() - openedAt > 120) setMenu(null);
    };
    /** 改窗不需要时间窗：那一定是"用户正在动窗口"，立即收起 */
    const hardClose = () => setMenu(null);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', hardClose);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', hardClose);
    };
  }, [menu]);

  /**
   * 用**实测高度**再校一次位（`useLayoutEffect` ⇒ 在浏览器绘制前完成，用户看不到跳动）。
   *
   * 为什么估算不够：`openMenu` 里的 estH 只按项数推算，而真实高度还含分隔线、gap 与文本行高
   * （实测 7 项 = 263.5px，估算 268 只能说接近）。矮视口（如 520px）下这点偏差会让「上翻后的
   * 菜单底部压在自己那颗 ⋮ 上」—— 真机验证时就出现过：菜单 bottom=518、按钮 top=480.5。
   * 判据因此写成两条：① 装不下视口 ② 与按钮重叠，任一命中就按实测高度重算。
   * `Math.abs(...) > 0.5` 是收敛闸：第二次算出的值与当前一致时不再 set，避免自激重渲染。
   */
  useLayoutEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    const btn = menuBtnRef.current;
    if (!el || !btn) return;
    const h = el.getBoundingClientRect().height;
    const b = btn.getBoundingClientRect();
    const overflowsViewport = menu.top + h > window.innerHeight - 8;
    const overlapsButton = menu.top < b.bottom && menu.top + h > b.top;
    if (!overflowsViewport && !overlapsButton) return;
    const next = Math.max(8, Math.min(b.top - h - 4, window.innerHeight - 8 - h));
    if (Math.abs(next - menu.top) > 0.5) setMenu({ left: menu.left, top: next });
  }, [menu]);

  const commit = () => {
    const text = (draft ?? '').trim();
    setDraft(null);
    if (text && text !== name) onRename?.(text);
  };

  if (draft !== null) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <Music className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setDraft(null);
          }}
          onBlur={commit}
          className="min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-10 outline-none"
          style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink)' }}
        />
        {sub && (
          <span className="shrink-0 text-11 tabular-nums" style={{ color: 'var(--ink-muted)' }}>
            {sub}
          </span>
        )}
        <button
          type="button"
          onClick={commit}
          title="Rename"
          className="shrink-0 rounded p-1 transition-colors"
          style={{ color: 'var(--primary-strong)' }}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setDraft(null)}
          title="Cancel"
          className="shrink-0 rounded p-1 transition-colors"
          style={{ color: 'var(--ink-muted)' }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  if (confirming && onDelete) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5"
        style={{ backgroundColor: 'var(--danger-soft)' }}
      >
        <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--ink)' }}>
          Delete “{name}”?
        </span>
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            onDelete();
          }}
          title="Confirm delete"
          className="shrink-0 rounded p-1 transition-colors"
          style={{ color: 'var(--danger)' }}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          title="Cancel"
          className="shrink-0 rounded p-1 transition-colors"
          style={{ color: 'var(--ink-muted)' }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex items-center rounded-md"
      style={{ backgroundColor: active ? 'var(--primary-soft)' : 'transparent' }}
    >
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left">
        <Music className="h-3.5 w-3.5 shrink-0" style={{ color: active ? 'var(--primary-strong)' : 'var(--ink-muted)' }} />
        <span className="truncate text-xs font-medium" style={{ color: active ? 'var(--primary-strong)' : 'var(--ink)' }}>
          {name}
        </span>
        {sub && (
          <span className="ml-auto shrink-0 text-11 tabular-nums" style={{ color: 'var(--ink-muted)' }}>
            {sub}
          </span>
        )}
      </button>
      {/* 行内只留一颗 ⋮（七个动作按「播放/视图 → 文稿/改名/导出 → fork → 删除」分组进菜单）。
          菜单是 `fixed` ⇒ 不会被 Excerpts 的 `overflow-y-auto` 与面板壳裁掉（见组件 JSDoc）。 */}
      <button
        ref={menuBtnRef}
        type="button"
        onClick={() => (menu ? setMenu(null) : openMenu())}
        aria-label={`${name} actions`}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
        style={{ color: menu ? 'var(--primary-strong)' : 'var(--ink-muted)' }}
        title="More actions"
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>
      {menu && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`${name} actions`}
          className="fixed z-[100] flex flex-col gap-0.5 rounded-lg p-1.5"
          style={{
            left: menu.left,
            top: menu.top,
            width: CLIP_MENU_W,
            // 视口比菜单还矮时（极端窄窗/大字号档）不硬塞：限高 + 菜单内部滚动，
            // 保证最后一项 Delete 永远可达（宁可滚一下，也不能有一项落在视口外）
            maxHeight: 'calc(100vh - 16px)',
            overflowY: 'auto',
            backgroundColor: 'var(--panel-bg)',
            border: '1px solid var(--line)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
          }}
        >
          {onPlay && (
            <ClipMenuAction
              icon={<Play className="h-3.5 w-3.5 shrink-0" />}
              label="Play excerpt"
              hint="Play this excerpt only"
              onClick={() => {
                setMenu(null);
                onPlay?.();
              }}
            />
          )}
          {onZoom && (
            <ClipMenuAction
              icon={<Maximize2 className="h-3.5 w-3.5 shrink-0" />}
              label="Zoom to clip"
              hint="Zoom the timeline to this clip"
              onClick={() => {
                setMenu(null);
                onZoom?.();
              }}
            />
          )}
          {(onPlay || onZoom) && (onTranscript || onRename || onDownload || onFork || onDelete) && (
            <div className="my-0.5 h-px" style={{ backgroundColor: 'var(--line-soft)' }} />
          )}
          {onTranscript && (
            <ClipMenuAction
              icon={<FileText className="h-3.5 w-3.5 shrink-0" />}
              label="Transcript"
              hint="Open this excerpt's transcript as Markdown (only lines in this range; polished if available)"
              onClick={() => {
                setMenu(null);
                onTranscript?.();
              }}
            />
          )}
          {onRename && (
            <ClipMenuAction
              icon={<Pencil className="h-3.5 w-3.5 shrink-0" />}
              label="Rename"
              hint="Rename this excerpt"
              onClick={() => {
                setMenu(null);
                setDraft(name);
              }}
            />
          )}
          {onDownload && (
            <ClipMenuAction
              icon={<Download className="h-3.5 w-3.5 shrink-0" />}
              label="Export"
              hint="Export this excerpt (renders the current range)"
              onClick={() => {
                setMenu(null);
                onDownload?.();
              }}
            />
          )}
          {onFork && (
            <ClipMenuAction
              icon={
                forkBusy ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : (
                  <GitFork className="h-3.5 w-3.5 shrink-0" />
                )
              }
              label={forkBusy ? 'Making separate audio…' : 'Make separate audio'}
              hint="Make separate audio — own waveform, marks and transcript; the original recording is unchanged"
              disabled={forkBusy}
              onClick={() => {
                setMenu(null);
                onFork?.();
              }}
            />
          )}
          {onDelete && <div className="my-0.5 h-px" style={{ backgroundColor: 'var(--line-soft)' }} />}
          {onDelete && (
            <ClipMenuAction
              icon={<Trash2 className="h-3.5 w-3.5 shrink-0" />}
              label="Delete"
              hint="Delete this excerpt"
              danger
              onClick={() => {
                setMenu(null);
                setConfirming(true);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function AudioViewer({
  fileInfo,
  proxyUrl,
  fileName,
  source,
  onError,
  wide = false,
}: ViewerRenderProps & { wide?: boolean }) {
  const name = fileName || fileInfo?.name || 'Audio';
  /** 播放 URL：Blob URL，或（走 Range 直连时）代理 URL */
  const [playUrl, setPlayUrl] = useState('');
  /** 预计算波形：非空 = 波形由服务端峰值绘制、播放走 Range */
  const [precomputed, setPrecomputed] = useState<PrecomputedWaveform | null>(null);
  /** 音频加载中（与「没有 playUrl」区分：否则加载期会显示成失败/空态兜底页） */
  const [loading, setLoading] = useState(true);
  const [marks, setMarks] = useState<AudioMark[]>([]);
  /** 最近一次操作的状态（失败原因 / 成功回执）；渲染统一走 StatusLine */
  const [note, setNote] = useState<NoteState>(null);
  const [clipping, setClipping] = useState(false);
  /**
   * 正在 fork 的片段路径（null = 没在 fork）。
   * 用**路径**而不是布尔：从 Excerpts 清单点某一行的 GitFork 时，只有那一行该转圈，
   * 不是整张清单一起转；也顺手把“并发 fork 两个片段”挡在外面（配合 `forkInFlightRef`）。
   */
  const [forkingPath, setForkingPath] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  /** 片段清单（挂在源音频上，lineage 记在它的 .clips.json 里） */
  const [clips, setClips] = useState<AudioClipRef[]>([]);
  /**
   * 片段区间带里**选中的片段**（路径；null = 未选中）。
   *
   * 为什么新建一个状态、而不是复用 `target`：`target` 会驱动播放器换源（重抓 Blob/重解码/重载打点），
   * 而这里**上轨恒是主音频**（片段只是主音频的一段区间）⇒ 点块不该换播放器。选中态因此独立出来，
   * 只用于区间带高亮 + 聚光 + 在带下给出该片段的播放/改名/导出/删除。
   */
  const [activeClipPath, setActiveClipPath] = useState<string | null>(null);
  /**
   * 拖区间带手柄时的**整个草稿**（没在拖 = null）：哪个块、拖的哪端、当前区间。
   * 父级拿它做两件事（都只是绘制用的瞬时读数，不落库）：
   *   ① 按 `edge` 取那一端 → **贯穿两轨的竖虚线**（用户要的"上面的原音频也跟着拖动"）；
   *   ② 按 `[start,end]` → **主音轨的聚光区间**，让"亮着的这一段"随拖拽一起长大/收窄。
   */
  const [clipDrag, setClipDrag] = useState<ClipDragReport | null>(null);
  /** 库浏览面板 */
  const [showLibrary, setShowLibrary] = useState(false);
  const [libraryEntries, setLibraryEntries] = useState<LibraryEntry[]>([]);
  /** 影子目录（库外音频的产物）：列表只列带 source.* 的条目，这些只能在这里管理 */
  const [shadows, setShadows] = useState<ShadowEntry[]>([]);
  /** 待确认删除的影子目录（删整目录：打点/峰值/转写/片段） */
  const [confirmShadow, setConfirmShadow] = useState<string | null>(null);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  /** 库内待确认删除的条目（删整个目录：源 + 片段 + 打点，先确认再执行） */
  const [confirmLibPath, setConfirmLibPath] = useState<string | null>(null);
  /** 库分组（用户自建；落盘 .audio-library/.groups.json，见 lib/audio/groups.ts） */
  const [groups, setGroups] = useState<AudioGroup[]>([]);
  /** 条目归属：目录名 → 组 id（键不存在 = 未分组） */
  const [groupAssign, setGroupAssign] = useState<Record<string, string>>({});
  /** 收起的组（id 集合）；默认展开，收起只影响这一个面板、不入库 */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  /** 正在收起的"未分组"区块（同上，仅在库里已有分组时才出现） */
  const [ungroupedCollapsed, setUngroupedCollapsed] = useState(false);
  /** 正在新建分组（true = 顶部出现一个待输入的组名行） */
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupDraft, setGroupDraft] = useState('');
  /** 正在重命名的组 id（null = 没有；同一时刻只允许改一个） */
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  /** 待确认删除的组 id（删组只解散组织，**不动任何音频文件**） */
  const [confirmGroupId, setConfirmGroupId] = useState<string | null>(null);
  /** 拖拽中的条目目录（绝对路径；null = 没在拖）。同一状态兼作落点高亮开关与归组参数 */
  const [draggingDir, setDraggingDir] = useState<string | null>(null);
  /** 当前悬停的落点（组 id 或 UNGROUPED_DROP；null = 无）；仅驱动高亮 */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /**
   * Esc 取消建组/重命名时置位：吃掉紧跟着的那次 `blur` 提交
   * （输入框被卸载时 DOM 会补发 blur，不挡住就会把"取消"又提交成一次改名）。
   */
  const groupInputAbortRef = useRef(false);
  /** 当前音频的转写（null = 没转过/已失效）；由 `load_transcript` 带入，转写完成后就地更新 */
  const [transcript, setTranscript] = useState<AudioTranscript | null>(null);
  /** 正在转写（分钟级，按钮置灰 + 转圈） */
  const [transcribing, setTranscribing] = useState(false);
  /**
   * 是否开启说话人分离（转写入口上的勾选框）。
   * **2026-10-17 改为默认开**：对话稿形态（按说话人分轮）是 `Transcript` 页签的默认读法，
   * 只有真的分出 ≥2 人时轮次才出现，所以默认就把这步带上，免得用户拿到稿子还要自己再勾一次。
   * 代价是转写要对**整段**音频多跑一次声纹（分钟级）—— 嫌慢的用户可在 `⋮` 菜单里关掉。
   */
  /** 波形给的真实时长（AI 校验与"按打点切分"都要它；服务端的 ffprobe 读数是另一个测法） */
  const [duration, setDuration] = useState(0);
  /** 当前播放时刻（转写面板高亮用） */
  const [playTime, setPlayTime] = useState(0);
  /** 打点撤销栈（每个元素是一份完整快照）。上限 20 步，够用且不会无限吃内存 */
  const [markHistory, setMarkHistory] = useState<AudioMark[][]>([]);
  /** AI 精选建议（勾选后批量导出；导出即清空） */
  const [highlights, setHighlights] = useState<HighlightSuggestion[]>([]);
  const [highlightSel, setHighlightSel] = useState<Set<number>>(new Set());
  /** 详情区当前页签（2026-10-17 方案 A）：音轨下方的分区改成标签页，默认落在转写上 */
  const [detailTab, setDetailTab] = useState<DetailTab>('transcript');
  /**
   * 各页签是否可用 —— 与原各分区的出现条件一致（不新增规则）：
   * `Transcript` 常驻；`Suggested` 有 AI 建议才出现；`Excerpts` **常驻**（空态由页签自己交代）。
   * 只有 `Source` 不在页签里 —— 上轨（波形）本身就是源。
   */
  const detailTabAvailable: Record<DetailTab, boolean> = {
    transcript: true,
    suggested: highlights.length > 0,
    // 大屏：Excerpts 清单固定在左栏波形下方，右侧只留对话稿/建议
    clips: !wide,
  };
  /**
   * 实际展示的页签：渲染期**钳制**，不另开 effect。
   * 失效场景 = 停在 Suggested 页签时点了 Dismiss（建议清空），此时自动落回转写，不会停在空页签上。
   */
  const activeDetailTab: DetailTab = detailTabAvailable[detailTab] ? detailTab : 'transcript';
  /** 正在跑模型任务（精选 / 命名） */
  const [aiBusy, setAiBusy] = useState(false);
  const playerRef = useRef<AudioMarkTrackHandle | null>(null);
  /** 区间保存请求的序号：快速连拖时只认最后一次回执（见 updateRange） */
  const rangeSeqRef = useRef(0);
  /** 点片段时主动清掉波形选区 ⇒ 吃掉随之而来的那次 `onSelectionChange(null)`（见 selectClip） */
  const clipSelectingRef = useRef(false);
  /** fork 在途锁：按钮的 disabled 要等一次渲染，连点两下时用它兜住第二个请求 */
  const forkInFlightRef = useRef(false);
  /**
   * 时间轴**视图状态**快照（由 `AudioMarkTrack` 经 `onViewChange` 报上来）。
   *
   * 为什么状态不放在这里、而只留一份快照：缩放的真源在子组件（库的 zoom/scroll + 它镜像的窗口），
   * 父级只负责"把标题栏那组控件画出来"（读数/置灰）与"把点击转成命令"。存两份必然有一天对不上。
   */
  const [trackView, setTrackView] = useState<AudioTrackViewState>({ zoomable: false, view: null, loading: false, follow: true });

  const importInputRef = useRef<HTMLInputElement>(null);
  /** P2-1：转写选项菜单（低频选项收进来，主操作独占一行） */
  const [transcribeMenu, setTranscribeMenu] = useState(false);
  const transcribeMenuRef = useRef<HTMLDivElement | null>(null);
  const transcribeMenuBtnRef = useRef<HTMLButtonElement | null>(null);
  /** 打开菜单那一刻的选区快照（选区归 AudioMarkTrack 所有，父级只有这一刻需要它） */
  const [selSnapshot, setSelSnapshot] = useState<{ start: number; end: number } | null>(null);
  /**
   * 波形**选区**的实时镜像（由 `AudioMarkTrack` 的 `onSelectionChange` 报上来）。
   * 用途：转写面板据此高亮"落在选区内的句子"（见 `highlightRange` 那条 prop）。
   * 值仍归子组件所有，这里只是一份给转写面板看的快照 —— 与 `trackView` 同款分工。
   */
  const [selRange, setSelRange] = useState<{ start: number; end: number } | null>(null);

  // 转写选项菜单：点击外部 / Esc 关闭（沿用项目既有范式：window pointerdown + contains）
  useEffect(() => {
    if (!transcribeMenu) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (transcribeMenuRef.current?.contains(t) || transcribeMenuBtnRef.current?.contains(t)) return;
      setTranscribeMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTranscribeMenu(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [transcribeMenu]);
  /**
   * path → 加载结果缓存：切换 Source↔片段 时不再重来一遍（大文件重算峰值要几秒）。
   * 只在组件卸载时统一 revoke **Blob URL**（Range 直连的代理 URL 无需回收）；
   * 切换 target 时不 revoke，否则回来又得重下。
   */
  const loadedCacheRef = useRef<Map<string, LoadedAudio>>(new Map());

  // 文件路径（用于 API 调用）：local = 绝对路径，project = full_path（绝对，API 侧会归一到项目根）
  const apiPath = fileInfo?.full_path || '';
  const apiSrc = apiSource(source);

  /** 初始音频（打开的那个文件）：片段清单始终挂在它身上，也是「切回」的落点 */
  const [root, setRoot] = useState<Target>(() => ({
    source: apiSrc,
    path: apiPath,
    name,
    size: fileInfo?.size,
  }));
  /** 当前正在编辑的音频：默认 = 源音频，点片段/导入则切换 */
  const [target, setTarget] = useState<Target>(() => ({
    source: apiSrc,
    path: apiPath,
    name,
    size: fileInfo?.size,
  }));
  /**
   * 当前音频如果是 fork 出来的独立副本，这里记它的来源（`‹ 原录音 · 00:12–00:48` 面包屑）。
   * 由 `load_clips` 顺带回传的 `.origin.json` 驱动；没有 = 它就是原始录音。
   */
  const [origin, setOrigin] = useState<AudioOrigin | null>(null);
  /** DeepSeek 润色后的对话轮（null = 还没润色）；以 sidecar 里的 `transcript.polished` 为准 */
  const [polished, setPolished] = useState<PolishedTurn[] | null>(transcript?.polished?.turns ?? null);
  const [polishing, setPolishing] = useState(false);
  const [rediarizing, setRediarizing] = useState(false);
  const [polishProgress, setPolishProgress] = useState<{ done: number; total: number } | null>(null);
  // sidecar 是唯一真源：换稿/重新转写/别的窗口写入后，都从这里同步
  useEffect(() => {
    setPolished(transcript?.polished?.turns ?? null);
  }, [transcript?.polished]);

  /**
   * 时间轴缩放：按窗口向服务端取**细分辨率**峰值切片（`action: 'peaks_window'`）。
   * 组件侧只声明"我需要窗口峰值"，API 口径（source/path）留在这一层 —— 与 `peaks` 同一套 postAudio。
   * 返回 null = 取不到（组件降级：保持旧波形，本次缩放不生效）。
   */
  const requestWindowPeaks = useCallback(
    async (startSec: number, sec: number, points: number): Promise<number[] | null> => {
      if (!target.path) return null;
      const res = await postAudio({
        action: 'peaks_window',
        source: target.source,
        path: target.path,
        startSec,
        sec,
        points,
      });
      const peaks = res.peaks;
      return res.success === true && Array.isArray(peaks) ? (peaks as number[]) : null;
    },
    [target.path, target.source],
  );

  // 打开的是另一个文件时，重置 root/target（同一个查看器实例换文件）
  const prevPathRef = useRef(apiPath);
  useEffect(() => {
    if (prevPathRef.current === apiPath) return;
    prevPathRef.current = apiPath;
    const t: Target = { source: apiSrc, path: apiPath, name, size: fileInfo?.size };
    setRoot(t);
    setTarget(t);
    setOrigin(null);
    setClips([]);
    setActiveClipPath(null);
  }, [apiPath, name, apiSrc, fileInfo?.size]);

  /**
   * 目标音频的代理 URL：
   * - project 侧（源音频）：用调度层给的 proxyUrl —— 它用**相对** filePath，而 full_path 是绝对路径，
   *   直接喂 file_proxy 会把项目根拼在前面；
   * - 其余（导入的库内音频、片段）都是本地绝对路径，走 /api/local-files。
   * 返回 null = 代理还没就绪（调度层异步生成），调用方等 deps 变化后重试。
   */
  const proxyFor = useCallback(
    async (t: Target): Promise<string | null> => {
      if (t.source === 'project' && t.path === apiPath) return proxyUrl;
      return localProxy(t.path);
    },
    [apiPath, proxyUrl],
  );

  // 加载 target 音频（命中缓存则直接复用）+ 读它的打点
  useEffect(() => {
    let dead = false;
    const key = target.path;
    setMarks([]);
    setNote(null);
    /**
     * 空编辑器（无源音频，由左栏 Audio Editor 入口以无路径占位 fileInfo 打开）：
     * **直接落空态**（下方 `!playUrl` 分支里的 Music 图标 + Library + Import audio），
     * 不做任何加载 —— 否则 `proxyFor`/`loadAudio` 会拿空路径去请求，要么失败报
     * "Playback failed"、要么在等待代理就绪时**永远停在 Loading**（旧实现在这里早退但没落 loading=false）。
     */
    if (!key) {
      setPlayUrl('');
      setPrecomputed(null);
      setLoading(false);
      return;
    }
    const cached = key ? loadedCacheRef.current.get(key) : undefined;
    if (cached) {
      setPlayUrl(cached.url);
      setPrecomputed(cached.precomputed);
      setLoading(false);
    } else {
      setPlayUrl('');
      setPrecomputed(null);
      setLoading(true);
    }
    /** 落到状态 + 缓存（缓存供切回该 target 时秒开） */
    const apply = (l: LoadedAudio) => {
      if (key) loadedCacheRef.current.set(key, l);
      setPlayUrl(l.url);
      setPrecomputed(l.precomputed);
      setLoading(false);
    };
    void (async () => {
      try {
        if (!cached) {
          const purl = await proxyFor(target);
          if (!purl) return; // 等代理就绪（proxyUrl 到位后 proxyFor 变身份，effect 会重跑）
          const loaded = await loadAudio(purl, target);
          if (dead) {
            if (loaded.blob) URL.revokeObjectURL(loaded.url); // 本轮已被取代，直接回收
            return;
          }
          apply(loaded);
        }
        // 读该音频自己的 sidecar 打点
        const d = await postAudio({ action: 'load_marks', source: target.source, path: target.path });
        if (!dead && d?.success && Array.isArray(d.marks)) {
          setMarks(d.marks as AudioMark[]);
        }
      } catch {
        if (!dead) {
          setLoading(false);
          setNote(noteError('Playback failed — try opening with the default program'));
          onError('Failed to load audio');
        }
      }
    })();
    return () => {
      dead = true;
    };
  }, [target, proxyFor, onError]);

  // 卸载时统一回收全部缓存的 Blob URL（Range 直连的代理 URL 不归我们管）
  useEffect(() => {
    const cache = loadedCacheRef.current;
    return () => {
      for (const l of cache.values()) if (l.blob) URL.revokeObjectURL(l.url);
      cache.clear();
    };
  }, []);

  // 读源音频的片段清单（lineage）
  useEffect(() => {
    let dead = false;
    if (!root.path) {
      setClips([]);
      return;
    }
    void (async () => {
      const d = await postAudio({ action: 'load_clips', source: root.source, path: root.path });
      if (!dead && d?.success && Array.isArray(d.clips)) {
        setClips(d.clips as AudioClipRef[]);
        setOrigin(isAudioOrigin(d.origin) ? d.origin : null);
      }
    })();
    return () => {
      dead = true;
    };
  }, [root.source, root.path]);

  /**
   * **改打点的唯一落盘口**（所有入口都必须走它：手打点 / 删点 / 改批注 / 按转写生成 / 撤销）。
   *
   * 三件事一起做，不能再拆开：
   *   ① 乐观上屏（交互不等网络）；
   *   ② 压一份快照进撤销栈（删点此前是"立即落盘且不可撤销"的破坏性操作）；
   *   ③ await 落盘结果并**说出来** —— 旧写法 `void postAudio(…)` 发完不管，
   *      失败时打点看着已存、刷新后消失（静默丢数据）。
   *
   * `history=false` 只给"撤销"自己用：撤销不该把自己也压进栈里（否则会来回弹）。
   */
  const applyMarks = useCallback(
    async (next: AudioMark[], opts?: { history?: boolean }) => {
      if (!target.path) return;
      if (opts?.history !== false) setMarkHistory((h) => [...h.slice(-19), marks]);
      setMarks(next);
      const d = await postAudio({ action: 'save_marks', source: target.source, path: target.path, marks: next });
      if (d.success) setNote(null);
      else setNote(noteError(String(d.error || 'Could not save marks.')));
    },
    [marks, target.source, target.path],
  );

  /** 在当前时刻（或转写面板指定的段起点）落一个点 */
  const addMark = useCallback(
    async (t: number, label?: string) => {
      const at = Math.round(t * 10) / 10;
      const next = [...marks, label ? { t: at, label } : { t: at }].sort((a, b) => a.t - b.t);
      await applyMarks(next);
    },
    [marks, applyMarks],
  );

  const changeMarks = useCallback(
    async (next: AudioMark[]) => {
      await applyMarks(next);
    },
    [applyMarks],
  );

  /** 撤销上一步打点改动（整份回写） */
  const undoMarks = useCallback(async () => {
    const prev = markHistory[markHistory.length - 1];
    if (!prev || !target.path) return;
    setMarkHistory((h) => h.slice(0, -1));
    setMarks(prev);
    const d = await postAudio({ action: 'save_marks', source: target.source, path: target.path, marks: prev });
    if (d.success) setNote(noteInfo('Marks reverted.'));
    else setNote(noteError(String(d.error || 'Could not revert marks.')));
  }, [markHistory, target.source, target.path]);

  /**
   * 切音频 → 读它自己的转写 sidecar。
   *
   * `load_transcript` 的三态在服务端就已定死（见 `api/audio/clip/route.ts` 该 action 的注释）：
   * 有稿 / `null`（没转过或已失效）/ 路径非法。这里**只认成功且非空**，其余一律当"没转过"
   * —— 转写是增强项，读不到不该在界面上留任何错误痕迹（用户很可能就是第一次打开这个文件）。
   */
  useEffect(() => {
    let dead = false;
    setTranscript(null);
    setHighlights([]);
    setHighlightSel(new Set());
    if (!target.path) return;
    void (async () => {
      const d = await postAudio({ action: 'load_transcript', source: target.source, path: target.path });
      if (!dead && d?.success && d.transcript) setTranscript(d.transcript as AudioTranscript);
    })();
    return () => {
      dead = true;
    };
  }, [target.source, target.path]);

  /**
   * 转写（分钟级，长音频是**十几分钟级**）。
   *
   * `opts.range` = 只转写这一截；不传则由服务端处置整段 ——
   * 整段超 30 分钟会走**窗口化**（服务端按 20 分钟切、逐窗跑、每窗落盘），
   * 所以这里对用户就是"一次点击 + 进度"。
   *
   * ⚠️ 续跑与重跑的区别全在 `refresh`：
   *   - 半截稿（`transcript.partial`）⇒ **不传 refresh** ⇒ 服务端从 `coveredUntilSec` 接着跑
   *     （已转过的窗口命中 parse 层缓存，不重复付费）；
   *   - 完整稿要重来 ⇒ 传 `refresh:true` ⇒ 从头。
   * 调用方（按钮）已经按这个口径决定传什么，这里不再自己判断。
   */
  const transcribe = useCallback(
    async (opts?: {
      refresh?: boolean;
      range?: { start: number; end: number };
      diarize?: SpeakerMode | null;
    }) => {
      if (!target.path) return;
      setTranscribing(true);
      const startedAt = Date.now();
      try {
        // 默认就是"最优解"：自动分离说话人；只有"没有标签 → 按 2 人重试"才显式覆盖。
        const mode: SpeakerMode | null = opts?.diarize === undefined ? 'auto' : opts.diarize;
        const d = await postAudio({
          action: 'transcribe',
          source: target.source,
          path: target.path,
          ...(opts?.refresh ? { refresh: true } : {}),
          ...(mode ? { diarize: mode } : {}),
          ...(opts?.range ? { rangeStartSec: opts.range.start, rangeEndSec: opts.range.end } : {}),
        });
        // 失败时服务端也会回传"已保存的半截稿"（长音频中途失败）⇒ 一并接管，让进度可见
        const next = d?.transcript as AudioTranscript | undefined;
        if (next) setTranscript(next);
        if (d?.success && next) {
          const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
          const win = Number(d.windows ?? 1);
          setNote(
            noteInfo(
              opts?.range
                ? `Transcribed the selection in ${secs}s.`
                : win > 1
                  ? `Transcribed in ${win} parts in ${secs}s.`
                  : `Transcribed in ${secs}s.`,
            ),
          );
        } else {
          setNote(noteError(String(d?.error || 'Could not transcribe this audio.')));
        }
      } finally {
        setTranscribing(false);
      }
    },
    [target.source, target.path],
  );

  /**
   * “没有说话人标签”时的一键重试：强制两位、从头重转。
   * 为什么是 duo 而不是 auto：用户的录音多是一对一通话，auto 在长音频里更容易把两位同性别
   * 说话人并成一人；duo 让 CLI 直接给 2 簇，且服务端不再做声纹合并（见 lib/stt/diarize.ts）。
   */
  const retryAsDuo = useCallback(async () => {
    if (!target.path || rediarizing) return;
    setRediarizing(true);
    setNote(noteInfo('Separating the existing transcript as 2 people…'));
    // 长音频分段分离可能跑几分钟：另开 status 轮询把「第几段/百分比」显示出来
    const jobId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `diar-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let dead = false;
    const timer = window.setInterval(() => {
      void (async () => {
        const st = await postAudio({ action: 'diarize_status', jobId });
        if (dead || st?.success !== true || typeof st.pct !== 'number') return;
        if (st.done !== true) {
          setNote(noteInfo(`Separating speakers… ${Math.round(Number(st.pct))}%`));
        }
      })();
    }, 1500);
    try {
      // 只重跑说话人分离，复用已有 segments/原文：长对话不必再花一遍 ASR 时间。
      const d = await postAudio({
        action: 're_diarize',
        source: target.source,
        path: target.path,
        mode: 'duo',
        jobId,
      });
      if (d?.success && d.transcript) {
        const next = d.transcript as AudioTranscript;
        setTranscript(next);
        setNote(
          noteInfo(`Separated ${Number(d.speakers ?? 2)} speakers without re-transcribing.`),
        );
      } else {
        setNote(noteError(String(d?.error || 'Could not separate speakers.')));
      }
    } finally {
      dead = true;
      window.clearInterval(timer);
      setRediarizing(false);
    }
  }, [target.source, target.path, rediarizing]);

  /**
   * 转写进行中：每 4s 问一次 sidecar，把**逐窗落盘**的进度显示出来。
   *
   * 为什么用轮询而不是 SSE：服务端每完成一窗就已经把半截稿写进 sidecar 了，
   * 轮询同一个 `load_transcript` 就能拿到真实进度（不用新增协议），
   * 而且请求被掐断时界面上的已转部分**不会回退**。
   */
  useEffect(() => {
    if (!transcribing || !target.path) return;
    let dead = false;
    const timer = setInterval(() => {
      void (async () => {
        const d = await postAudio({ action: 'load_transcript', source: target.source, path: target.path });
        if (!dead && d?.success && d.transcript) setTranscript(d.transcript as AudioTranscript);
      })();
    }, 4000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [transcribing, target.source, target.path]);

  /** 只转当前选区（长音频的入口）：选区归波形组件所有，从它的句柄问出来 */
  const transcribeSelection = useCallback(async () => {
    const sel = playerRef.current?.getSelection() ?? null;
    if (!sel) {
      setNote(noteError('Drag on the waveform to select a range first.'));
      return;
    }
    await transcribe({ range: sel });
  }, [transcribe]);

  /** 有稿子时的"再转一次"：半截稿从断点续跑，完整稿从头重来（口径与原入口按钮一致） */
  const retranscribe = useCallback(() => {
    void transcribe(transcript && !transcript.partial ? { refresh: true } : undefined);
  }, [transcribe, transcript]);

  /**
   * 转写稿保存的**串行链**（理由见 `editSegmentText`：服务端"读 → 改 → 写回"不是原子操作）。
   * 用 `useRef` 而不是 state：它只负责排队，不参与渲染。
   */
  const transcriptSaveChain = useRef<Promise<unknown>>(Promise.resolve());

  /**
   * 原地改一句转写文字（**只改文案，不动时间轴** —— `t` / `end` / `speaker` 原样保留）。
   *
   * 乐观上屏 → 落盘 → 失败回滚，三条理由：
   *   - **敢乐观**：打点与片段一律按时间存（`lib/audio/marks.ts`），改字不会让它们失位；
   *   - **落盘后用服务端回传的整份 transcript 覆盖**：服务端是"读一次 sidecar → 改一句 → 写回"，
   *     连续改两句时本地两次乐观更新各改各的，只有它那份才是盘上的真值；
   *   - **失败必须回滚 + 报错 + 返回 false**：面板据此保留草稿，避免"字打了、看着还在、其实没存"。
   *
   * 回滚只恢复**这一句**（不是整份快照）：期间用户若已改了别的行，不该被这次失败一并抹掉。
   *
   * 写入**串行化**（见下方 `transcriptSaveChain`）：服务端是"读 → 改 → 写回"的非原子读改写，
   * 两条保存重叠时后写的那条基于旧读数，会把前一次改动整段抹掉（丢句子且不报错）。
   *
   * ⚠️ 已知边界：片段默认名取自区间转写前 12 字（见文件头），改字**不会**回改已有片段名。
   */
  const editSegmentText = useCallback(
    async (index: number, text: string): Promise<boolean> => {
      if (!target.path || !transcript) return false;
      const seg = transcript.segments[index];
      if (!seg) return false;
      const next = text.trim();
      if (!next || next === seg.text) return false;
      const prevText = seg.text;

      // 乐观上屏必须走**函数式**更新：排队期间 transcript 可能已被别的保存更新过，
      // 用闭包里的旧对象会把这些改动覆盖回旧值。
      setTranscript((cur) => (cur ? (applySegmentText(cur, index, next) ?? cur) : cur));

      // 串到上一条之后：前一条落地（或失败）后才发这一条
      const run = transcriptSaveChain.current
        .catch(() => undefined) // 前一条失败不阻断后续
        .then(() =>
          postAudio({
            action: 'save_transcript',
            source: target.source,
            path: target.path,
            index,
            text: next,
          }),
        );
      transcriptSaveChain.current = run.catch(() => undefined);
      const d = await run;

      if (d?.success) {
        // 服务端回传整份 transcript：用它对齐本地（不只是改这一句）
        if (d.transcript) setTranscript(d.transcript as AudioTranscript);
        setNote(noteInfo('Line updated.'));
        return true;
      }
      // 精确回滚单句（`applySegmentText` 在"已等于原文"时返回 null ⇒ 保持现状）
      setTranscript((cur) => (cur ? (applySegmentText(cur, index, prevText) ?? cur) : cur));
      setNote(noteError(String(d?.error || 'Could not save that line.')));
      return false;
    },
    [target.path, target.source, transcript],
  );

  /**
   * 原地改一句的**起点时间**（服务端 `action:'save_segment_time'`）。
   *
   * 与 `editSegmentText` 的三条约定同源（乐观上屏 / 串行落盘 / 失败精确回滚），
   * 差别只在回滚字段：这里恢复的是这一句的旧起点（上一段 `end` 由纯函数一并回滚）。
   * 打点与片段按**绝对时间**存，改句首不会带着它们一起挪 —— 这是有意为之：
   * 用户改的是"这句从哪秒开始"，不该顺手移动他自己打的点。
   */
  const editSegmentTime = useCallback(
    async (index: number, t: number): Promise<boolean> => {
      if (!target.path || !transcript) return false;
      const seg = transcript.segments[index];
      if (!seg || !Number.isFinite(t) || t === seg.t) return false;
      const prevT = seg.t;

      setTranscript((cur) => (cur ? (applySegmentStart(cur, index, t) ?? cur) : cur));

      const run = transcriptSaveChain.current
        .catch(() => undefined) // 前一条失败不阻断后续
        .then(() =>
          postAudio({
            action: 'save_segment_time',
            source: target.source,
            path: target.path,
            index,
            t,
          }),
        );
      transcriptSaveChain.current = run.catch(() => undefined);
      const d = await run;

      if (d?.success) {
        if (d.transcript) setTranscript(d.transcript as AudioTranscript);
        setNote(noteInfo('Time updated.'));
        return true;
      }
      setTranscript((cur) => (cur ? (applySegmentStart(cur, index, prevT) ?? cur) : cur));
      setNote(noteError(String(d?.error || 'Could not save that time.')));
      return false;
    },
    [target.path, target.source, transcript],
  );

  /**
   * 原地改**润色稿里一轮**的文字（`view=polished` 的正文输入框）。服务端 `action:'save_polished_turn'`。
   *
   * 与 `editSegmentText` 的三条约定同源（乐观上屏 / 串行落盘 / 失败精确回滚），
   * 唯一区别是落点：润色轮与 `segments` 不是一一对应，改动只写 `transcript.polished.turns[index]`，
   * 原文保持不动（切回 `View original` 仍是 ASR 原文）。
   */
  const editPolishedTurn = useCallback(
    async (index: number, text: string): Promise<boolean> => {
      if (!target.path || !transcript?.polished) return false;
      const turn = transcript.polished.turns[index];
      if (!turn) return false;
      const next = text.trim();
      if (!next || next === turn.text) return false;
      const prevText = turn.text;

      setTranscript((cur) => (cur ? (applyPolishedTurnText(cur, index, next) ?? cur) : cur));

      const run = transcriptSaveChain.current
        .catch(() => undefined) // 前一条失败不阻断后续
        .then(() =>
          postAudio({
            action: 'save_polished_turn',
            source: target.source,
            path: target.path,
            index,
            text: next,
          }),
        );
      transcriptSaveChain.current = run.catch(() => undefined);
      const d = await run;

      if (d?.success) {
        if (d.transcript) setTranscript(d.transcript as AudioTranscript);
        setNote(noteInfo('Turn updated.'));
        return true;
      }
      // 精确回滚这一轮（`applyPolishedTurnText` 在"已等于现文"时返回 null ⇒ 保持现状）
      setTranscript((cur) => (cur ? (applyPolishedTurnText(cur, index, prevText) ?? cur) : cur));
      setNote(noteError(String(d?.error || 'Could not save that turn.')));
      return false;
    },
    [target.path, target.source, transcript],
  );

  /**
   * 在**某一行下面**插入一条对话（原文稿 `insert_segment` / 润色稿 `insert_polished_turn`）。
   *
   * 为什么两个视图走两条 action：润色轮与 `segments` 不是一一对应，插入位置只能按"用户眼前
   * 是哪套行"来解释。服务端的两个纯函数（`insertSegmentAfter` / `insertPolishedTurnAfter`）
   * 都会**双向同步**：原文稿插入顺带补进润色稿，反之亦然 ⇒ 切视图不会少一行、导出也不缺句。
   *
   * 这里**不做乐观更新**：插入会改变之后所有行的下标，本地先插再等服务端回传还要维护"临时行
   * 在哪个下标"；而插入是低频动作（一次点击一条），等回传即可 —— 面板的草稿行会一直挂着，
   * 失败时保留输入（用户再次失焦即重试），与逐句保存同一口径。
   *
   * 时间由面板给（默认复制上一行，`t` / `end` 原样传入）；本函数不碰任何已有段的时间。
   */
  const insertTranscriptLine = useCallback(
    async (
      action: 'insert_segment' | 'insert_polished_turn',
      afterIndex: number,
      line: { speaker: number | null; t: number; end: number; text: string },
    ): Promise<boolean> => {
      if (!target.path || !transcript) return false;
      const text = line.text.trim();
      if (!text) return false;

      const run = transcriptSaveChain.current
        .catch(() => undefined) // 前一条失败不阻断后续
        .then(() =>
          postAudio({
            action,
            source: target.source,
            path: target.path,
            afterIndex,
            speaker: line.speaker,
            t: line.t,
            end: line.end,
            text,
          }),
        );
      transcriptSaveChain.current = run.catch(() => undefined);
      const d = await run;

      if (d?.success) {
        // 服务端回传整份 transcript（含新行与重建后的 plainText）
        if (d.transcript) setTranscript(d.transcript as AudioTranscript);
        setNote(noteInfo(action === 'insert_segment' ? 'Line inserted.' : 'Turn inserted.'));
        return true;
      }
      setNote(noteError(String(d?.error || 'Could not insert that line.')));
      return false;
    },
    [target.path, target.source, transcript],
  );

  /**
   * 删掉**某一行**对话（原文稿 `delete_segment` / 润色稿 `delete_polished_turn`）。
   *
   * 与插入共用一套约定：不做乐观更新（删掉后所有后续下标都会变，等整份 transcript 回传），
   * 串行落盘，失败只提示、不动界面。
   * 逐句删除会被服务端**拒绝删到 0 段**（空稿 sidecar 会整份失效），错误文案会直接显示出来。
   */
  const deleteTranscriptLine = useCallback(
    async (action: 'delete_segment' | 'delete_polished_turn', index: number): Promise<boolean> => {
      if (!target.path || !transcript) return false;

      const run = transcriptSaveChain.current
        .catch(() => undefined) // 前一条失败不阻断后续
        .then(() => postAudio({ action, source: target.source, path: target.path, index }));
      transcriptSaveChain.current = run.catch(() => undefined);
      const d = await run;

      if (d?.success) {
        // 服务端回传整份 transcript（含重建后的 plainText）
        if (d.transcript) setTranscript(d.transcript as AudioTranscript);
        setNote(noteInfo(action === 'delete_segment' ? 'Line deleted.' : 'Turn deleted.'));
        return true;
      }
      setNote(noteError(String(d?.error || 'Could not delete that line.')));
      return false;
    },
    [target.path, target.source, transcript],
  );

  /**
   * 改**一轮**的说话人归属（`null` = 未归属）。服务端 `action:'assign_speaker'`。
   *
   * 与 `editSegmentText` 的三条约定完全同源（乐观上屏 / 串行落盘 / 失败精确回滚），
   * 只有两处不同，都由"改的是归属而不是文字"决定：
   *   - **入参是一批段下标**：界面上的最小操作单位是"一轮"（相邻同人的连续发言）。
   *     只改单句会让那一轮当场被 `groupSegmentTurns` 拆成两轮 —— 用户刚点的那轮散架；
   *   - **回滚要恢复的是一批旧归属**：先在调用侧记下这批下标的旧值，失败时逐个回填
   *     （`applySegmentSpeakers` 一次只认"一批同一归属"，所以是循环逐句回填）。
   *     与改字同口径：**只回滚这一批**，期间用户改的别的行/别的轮一个都不动。
   *
   * `polished` 不在前端处理：服务端按 `start` 把润色稿的说话人标注对回原段（文本没变，润色稿不丢）。
   */
  const assignSpeaker = useCallback(
    async (indexes: number[], speaker: number | null): Promise<boolean> => {
      if (!target.path || !transcript) return false;
      const valid = indexes.filter(
        (i) => Number.isInteger(i) && i >= 0 && i < transcript.segments.length,
      );
      if (valid.length === 0) return false;
      const before = valid.map((i) => transcript.segments[i].speaker);
      // 这一批本来就已经全是这个归属 ⇒ 不写盘（服务端按同一口径也会拒）
      if (before.every((sp) => sp === speaker)) return true;

      // 乐观上屏（函数式：排队期间 transcript 可能已被别的保存更新过）
      setTranscript((cur) => (cur ? (applySegmentSpeakers(cur, valid, speaker) ?? cur) : cur));

      const run = transcriptSaveChain.current
        .catch(() => undefined) // 前一条失败不阻断后续
        .then(() =>
          postAudio({
            action: 'assign_speaker',
            source: target.source,
            path: target.path,
            indexes: valid,
            speaker,
          }),
        );
      transcriptSaveChain.current = run.catch(() => undefined);
      const d = await run;

      if (d?.success) {
        // 服务端回传整份 transcript ⇒ 用它对齐本地（含被刷新过的润色稿）
        if (d.transcript) setTranscript(d.transcript as AudioTranscript);
        setNote(noteInfo('Speaker updated.'));
        return true;
      }
      setTranscript((cur) => {
        if (!cur) return cur;
        let out = cur;
        valid.forEach((i, k) => {
          out = applySegmentSpeakers(out, [i], before[k]) ?? out;
        });
        return out;
      });
      setNote(noteError(String(d?.error || 'Could not update that speaker.')));
      return false;
    },
    [target.path, target.source, transcript],
  );

  /**
   * 给一个说话人起显示名（空名 = 恢复默认 `Speaker N`）。服务端 `action:'rename_speaker'`。
   *
   * 与 `assignSpeaker` 各走各的（只写 `speakerNames` 那个显示映射，绝不碰 `segments`）：
   * 名字改错了再改一次即可，不该把归属一起撤回 —— 反之亦然。
   *
   * 提交前用**服务端的同一份** `normalizeSpeakerName` 判"有没有变化"：否则输入 ` 张三 `
   * （库里已是 `张三`）会被两边判成不同结论，弹出一个"保存失败"却其实什么都没发生。
   */
  const renameSpeaker = useCallback(
    async (id: number, name: string): Promise<boolean> => {
      if (!target.path || !transcript) return false;
      const prev = transcript.speakerNames?.[id] ?? '';
      const next = normalizeSpeakerName(name);
      if (prev === next) return true;

      setTranscript((cur) => (cur ? (applySpeakerName(cur, id, next) ?? cur) : cur));

      const run = transcriptSaveChain.current
        .catch(() => undefined)
        .then(() =>
          postAudio({
            action: 'rename_speaker',
            source: target.source,
            path: target.path,
            id,
            name: next,
          }),
        );
      transcriptSaveChain.current = run.catch(() => undefined);
      const d = await run;

      if (d?.success) {
        if (d.transcript) setTranscript(d.transcript as AudioTranscript);
        setNote(noteInfo('Speaker renamed.'));
        return true;
      }
      // 精确回滚这一个名字（`applySpeakerName` 在"无变化"时返回 null ⇒ 保持现状）
      setTranscript((cur) => (cur ? (applySpeakerName(cur, id, prev) ?? cur) : cur));
      setNote(noteError(String(d?.error || 'Could not rename that speaker.')));
      return false;
    },
    [target.path, target.source, transcript],
  );

  /**
   * **批量**改说话人显示名（对话稿面板"列出所有人 → 一次改完 → 统一保存"）。服务端 `action:'rename_speakers'`。
   *
   * 与单条 `renameSpeaker` 同三条约定，两处差别都由"一次动作"决定：
   *   - 提交前用服务端**同一份** `normalizeSpeakerName` 逐条筛掉没变的，只发真要改的那几条
   *     （全都没变 ⇒ 直接算成功，不白跑一次请求）；
   *   - 失败**整份回滚**，而不是单条那条路的逐个回填 —— 这是一次统一保存，
   *     留半套生效的中间态最难解释（单条那边一次只动一个名字，逐个回填才是对的）；
   *   - 提示按条数给（改 1 个 / 改 N 个），不再一人弹一条。
   */
  const renameSpeakers = useCallback(
    async (entries: Array<{ id: number; name: string }>): Promise<boolean> => {
      if (!target.path || !transcript) return false;
      const prev = transcript.speakerNames ?? {};
      const changed = entries
        .map((e) => ({ id: e.id, name: normalizeSpeakerName(e.name) }))
        .filter((e) => (prev[e.id] ?? '') !== e.name);
      if (changed.length === 0) return true;

      // 乐观上屏（函数式：排队期间 transcript 可能已被别的保存更新过）
      setTranscript((cur) => {
        if (!cur) return cur;
        let out = cur;
        for (const e of changed) out = applySpeakerName(out, e.id, e.name) ?? out;
        return out;
      });

      const run = transcriptSaveChain.current
        .catch(() => undefined) // 前一条失败不阻断后续
        .then(() =>
          postAudio({
            action: 'rename_speakers',
            source: target.source,
            path: target.path,
            entries: changed,
          }),
        );
      transcriptSaveChain.current = run.catch(() => undefined);
      const d = await run;

      if (d?.success) {
        if (d.transcript) setTranscript(d.transcript as AudioTranscript);
        setNote(
          noteInfo(changed.length === 1 ? 'Speaker renamed.' : `${changed.length} speakers renamed.`),
        );
        return true;
      }
      // 整份回滚：名字是纯显示层（与 `segments` 无关），恢复整套映射最准
      setTranscript((cur) => {
        if (!cur) return cur;
        const out: AudioTranscript = { ...cur };
        if (Object.keys(prev).length > 0) out.speakerNames = { ...prev };
        else delete out.speakerNames;
        return out;
      });
      setNote(noteError(String(d?.error || 'Could not rename those speakers.')));
      return false;
    },
    [target.path, target.source, transcript],
  );

  /** 清除自动生成的点（手打点一个不动） */
  const clearAutoMarks = useCallback(async () => {
    const next = dropAutoMarks(marks);
    if (next.length === marks.length) return;
    const removed = marks.length - next.length;
    await applyMarks(next);
    setNote(noteInfo(`Removed ${removed} auto-generated mark${removed === 1 ? '' : 's'}.`));
  }, [marks, applyMarks]);

  /** 区间内的转写文本（片段命名与模型命名的输入） */
  const rangeText = useCallback(
    (start: number, end: number): string => {
      if (!transcript) return '';
      return transcript.segments
        .filter((s) => s.end > start && s.t < end)
        .map((s) => s.text)
        .join(' ')
        .trim();
    },
    [transcript],
  );

  /**
   * 待导出区间的**默认名**：取区间内转写文本的前 12 字。
   * 拿不到（没转写 / 区间内无文本）返回 undefined ⇒ 调用方回退 `片段 - 标题 - 起止`。
   */
  const suggestNameForRange = useCallback(
    (start: number, end: number): string | undefined => {
      const text = rangeText(start, end);
      if (!text) return undefined;
      // 文件名里不要省略号（`markLabelFromText` 截断时会加）
      return markLabelFromText(text, 12)?.replace(/…$/, '') || undefined;
    },
    [rangeText],
  );

  /** `✦` 让模型给区间起名；失败返回 null（**不动用户手上的草稿**） */
  const requestClipName = useCallback(
    async (start: number, end: number): Promise<string | null> => {
      const text = rangeText(start, end);
      if (!text) {
        setNote(noteError('No transcript text in this range — transcribe this audio first.'));
        return null;
      }
      setAiBusy(true);
      try {
        const d = await postAi({ action: 'suggest_clip_name', text });
        if (d?.success && typeof d.name === 'string' && d.name.trim()) return d.name.trim();
        setNote(noteError(String(d?.error || 'Could not suggest a name.')));
        return null;
      } finally {
        setAiBusy(false);
      }
    },
    [rangeText],
  );

  /** AI 精选：模型读转写挑区间 → 卡片（**只给建议，勾选后才导出**） */
  const runHighlights = useCallback(async () => {
    if (!transcript) return;
    setAiBusy(true);
    try {
      const total = duration > 0 ? duration : (transcript.durationSec ?? null);
      const d = await postAi({
        action: 'highlights',
        segments: transcript.segments,
        durationSec: total,
      });
      const items = Array.isArray(d?.highlights) ? (d.highlights as HighlightSuggestion[]) : [];
      if (d?.success && items.length > 0) {
        setHighlights(items);
        setHighlightSel(new Set(items.map((_, i) => i))); // 默认全选，用户再取消不想要的
        // 建议收进页签后，产出这一刻要把页签切过去 —— 否则结果落在看不见的页签里（旧版是就地出现在下方）
        setDetailTab('suggested');
        setNote(noteInfo(`${items.length} suggestion${items.length === 1 ? '' : 's'} — review, then export.`));
      } else {
        // **纯规则降级**：模型没配 / 超时 / 返回不可解析时，用"按说话人切换 / 约 60s 聚合"
        // 给出建议 —— "挑几段剪出来"这件事在**没有任何模型**时也成立，不把用户堵死。
        // 文案必须说清这批是规则给的（用户有权知道建议不是模型挑的）。
        const reason = String(d?.error || 'Could not pick highlights.');
        const rules = ruleHighlights(transcript.segments, total);
        if (rules.length > 0) {
          setHighlights(rules);
          setHighlightSel(new Set(rules.map((_, i) => i)));
          setDetailTab('suggested');
          setNote(
            noteInfo(`AI unavailable (${reason}) Showing ${rules.length} rule-based suggestion${rules.length === 1 ? '' : 's'}.`),
          );
        } else {
          setNote(noteError(reason));
        }
      }
    } finally {
      setAiBusy(false);
    }
  }, [transcript, duration]);

  /**
   * DeepSeek 润色：把 ASR 原文按“对话轮”交给 DSH 任务模型整理成可读稿。
   *
   * 三个克制：
   *   - **落 sidecar**：与转写同一份 `.transcript.json`，Hippo / 预览面板读同一份；原文永远在；
   *   - **只改 text**：speaker/start/end 一律沿用原轮，点击仍能定位；
   *   - **分批**：每批 20 轮，避免一次 prompt/响应超过 AI 路由的 60s；长稿只润色前 240 轮并明说。
   */
  const polishTranscriptFor = useCallback(
    async (source: AudioTranscript) => {
      if (!target.path || polishing) return;
      const turns = groupSegmentTurns(source.segments);
      if (turns.length === 0) {
        setNote(noteError('No transcript text to polish.'));
        return;
      }
      const BATCH = 20;
      const MAX_TURNS = 240;
      const limited = turns.slice(0, MAX_TURNS);
      const total = Math.ceil(limited.length / BATCH);
      setPolishing(true);
      setPolishProgress({ done: 0, total });
      let model = '';
      try {
        const out: PolishedTurn[] = [];
        for (let i = 0; i < limited.length; i += BATCH) {
          const batch = limited.slice(i, i + BATCH);
          const d = await postAi({
            action: 'polish_turns',
            turns: batch.map((t, j) => ({ id: j, speaker: t.speaker, text: t.text })),
          });
          if (d?.success !== true || !Array.isArray(d.turns)) {
            setNote(noteError(String(d?.error || 'Could not polish this transcript.')));
            return;
          }
          if (typeof d.model === 'string') model = d.model;
          const byId = new Map<number, string>();
          for (const item of d.turns as Array<{ id?: unknown; text?: unknown }>) {
            const id = Number(item?.id);
            const text = typeof item?.text === 'string' ? item.text.trim() : '';
            if (Number.isInteger(id) && text) byId.set(id, text);
          }
          batch.forEach((t, j) => out.push({ speaker: t.speaker, start: t.start, end: t.end, text: byId.get(j) ?? t.text }));
          setPolishProgress({ done: Math.floor(i / BATCH) + 1, total });
        }
        // 落 sidecar：Hippo / 预览面板 / 下次打开都读同一份；失败则先留在内存里并如实报错
        const saved = await postAudio({
          action: 'save_polished',
          source: target.source,
          path: target.path,
          polished: {
            at: new Date().toISOString(),
            model: model || 'deepseek',
            turns: out,
          },
        });
        setPolished(out);
        if (saved?.success && saved.transcript) {
          setTranscript(saved.transcript as AudioTranscript);
          setNote(
            noteInfo(
              `Polished ${out.length} turns${model ? ` with ${model}` : ''}${
                turns.length > limited.length ? ` (first ${limited.length})` : ''
              }. Saved with the transcript.`,
            ),
          );
        } else {
          setNote(
            noteError(
              `Polished ${out.length} turns, but could not save them: ${String(
                saved?.error || 'unknown error',
              )}`,
            ),
          );
        }
      } catch (e) {
        setNote(noteError(e instanceof Error ? e.message : 'Could not polish this transcript.'));
      } finally {
        setPolishing(false);
        setPolishProgress(null);
      }
    },
    [target.path, target.source, polishing],
  );

  /** 把当前视图导出成 .md，并交给 Markdown 编辑器打开（桌面端落在画布预览面板，见下） */
  const openAsMarkdown = useCallback(
    async (variant: 'raw' | 'polished') => {
      if (!target.path) return;
      const d = await postAudio({
        action: 'export_markdown',
        source: target.source,
        path: target.path,
        variant,
        title: target.name,
      });
      if (!d?.success || typeof d.path !== 'string') {
        setNote(noteError(String(d?.error || 'Could not export this transcript as Markdown.')));
        return;
      }
      const url = `${window.location.origin}/markdown-view?path=${encodeURIComponent(d.path)}&name=${encodeURIComponent(
        String(d.name || 'Transcript.md'),
      )}`;
      // 桌面端：主进程会收编这条 window.open（hippo-browser.handoffMarkdownToCanvas）——
      // 不发 Hippo 标签，改为转发给画布，落进右侧预览面板的同一个 Markdown 编辑器；
      // 普通浏览器（无桌面桥）则是新标签页里的 /markdown-view。
      // 导出的 .md 是**独立快照**（用户 2026-10-21 确认：不回写）：在 Markdown 编辑器里改文字/说话人
      // 只落这个文件，**不会**同步回 `.transcript.json`。要改稿请回到音频编辑器的对话稿里改
      // （原文与润色稿现在都支持原地编辑）。
      window.open(url, '_blank');
      setNote(noteInfo(`Saved ${d.name} — a standalone snapshot; edits to it don't sync back to the transcript.`));
    },
    [target.source, target.path, target.name],
  );

  /** 片段文稿：只导出该 excerpt 区间；有润色稿就优先用润色稿，否则用原文 */
  const openClipAsMarkdown = useCallback(
    async (c: AudioClipRef) => {
      if (!target.path) return;
      const variant: 'raw' | 'polished' = polished && polished.length > 0 ? 'polished' : 'raw';
      const d = await postAudio({
        action: 'export_markdown',
        source: target.source,
        path: target.path,
        variant,
        title: c.name,
        rangeStartSec: c.start,
        rangeEndSec: c.end,
      });
      if (!d?.success || typeof d.path !== 'string') {
        setNote(noteError(String(d?.error || 'Could not export this excerpt transcript.')));
        return;
      }
      const url = `${window.location.origin}/markdown-view?path=${encodeURIComponent(d.path)}&name=${encodeURIComponent(
        String(d.name || 'Excerpt.md'),
      )}`;
      // 同 openAsMarkdown：桌面端由主进程转发到画布预览面板，浏览器端才真的开新标签
      window.open(url, '_blank');
      setNote(noteInfo(`Saved ${d.name} — a standalone snapshot; edits to it don't sync back.`));
    },
    [target.source, target.path, polished],
  );

  /**
   * 行级 AI 润色（每行的 `✦`）：只把**这一行此刻的文字**交给模型，返回新文本。
   *
   * 刻意**不落盘**：`TranscriptPanel` 把结果放回输入框当草稿，用户 Enter 才保存、Esc 还原 ——
   * 人的修改与 AI 的修改始终可对照（整份润色仍是 ⋯ → Polish）。
   * 失败/无变化一律返回 `null`（这里弹错误条），绝不静默改稿。
   */
  const polishLineText = useCallback(async (text: string): Promise<string | null> => {
    const body = String(text ?? '').trim();
    if (!body) return null;
    try {
      const d = await postAi({ action: 'polish_turns', turns: [{ id: 0, speaker: null, text: body }] });
      if (d?.success !== true || !Array.isArray(d.turns)) {
        setNote(noteError(String(d?.error || 'Could not polish this line.')));
        return null;
      }
      const hit = (d.turns as Array<{ id?: unknown; text?: unknown }>).find((t) => Number(t?.id) === 0);
      const next = typeof hit?.text === 'string' ? hit.text.trim() : '';
      if (!next) {
        setNote(noteError('Could not polish this line.'));
        return null;
      }
      return next;
    } catch (e) {
      setNote(noteError(e instanceof Error ? e.message : 'Could not polish this line.'));
      return null;
    }
  }, []);

  /** 手动入口（⋯ → Polish）：对当前稿子润色一次 —— 润色**只走手动**，转写完成不再自动触发 */
  const polishTranscript = useCallback(() => {
    if (transcript) void polishTranscriptFor(transcript);
  }, [transcript, polishTranscriptFor]);

  const clip = useCallback(
    async (start: number, end: number, name?: string) => {
      if (!target.path) return;
      setClipping(true);
      try {
        const d = await postAudio({
          action: 'clip',
          source: target.source,
          path: target.path,
          startSec: start,
          endSec: end,
          name,
        });
        const c = d?.clip as { name?: string } | undefined;
        if (d?.success && c) {
          setNote(noteInfo(`Saved ${c.name}`));
          // 统一目录结构下，片段与源同居一处，.clips.json 共享 → 始终更新清单
          if (Array.isArray(d.clips)) {
            setClips(d.clips as AudioClipRef[]);
          }
        } else {
          setNote(noteError(String(d?.error || 'Could not export this clip.')));
        }
      } finally {
        setClipping(false);
      }
    },
    [target.source, target.path],
  );

  /**
   * 批量导出若干区间（按句多选 / 按打点切分 / AI 精选都汇到这里）。
   *
   * 单条失败不影响其余：服务端逐条回执，这里把"成功几条、失败几条、第一条失败原因"如实说出来
   * —— 静默跳过是这类批量操作最容易埋的坑（用户以为全导出了）。
   */
  const clipMany = useCallback(
    async (ranges: ClipRequest[]) => {
      if (!target.path || ranges.length === 0) return;
      setClipping(true);
      try {
        const d = await postAudio({
          action: 'clip_many',
          source: target.source,
          path: target.path,
          ranges,
        });
        if (Array.isArray(d?.clips)) setClips(d.clips as AudioClipRef[]);
        const exported = Number(d?.exported ?? 0);
        const failed = Number(d?.failed ?? 0);
        if (d?.success && exported > 0) {
          setNote(noteInfo(`Saved ${exported} clip${exported === 1 ? '' : 's'}${failed > 0 ? ` — ${failed} failed` : ''}.`));
        } else {
          const results = Array.isArray(d?.results) ? (d.results as Array<{ ok?: boolean; error?: string }>) : [];
          const firstError = results.find((r) => !r.ok)?.error;
          setNote(noteError(String(firstError || d?.error || 'Could not export these clips.')));
        }
      } finally {
        setClipping(false);
      }
    },
    [target.source, target.path],
  );

  /**
   * 按打点把整段音频切成 N+1 个片段。
   *
   * 时长优先用**波形给的真实时长**（`duration`，解码得到），没有才退回转写里探测的 `durationSec`
   * —— 两者是不同测法，差几十毫秒会在服务端的越界判据上显形（那里的容差见 transcript.ts）。
   */
  const splitAtMarks = useCallback(async () => {
    const total = duration > 0 ? duration : (transcript?.durationSec ?? 0);
    const ranges = splitRangesAtMarks(marks, total);
    if (ranges.length === 0) {
      setNote(noteError('Need the audio duration (play it once) and at least two marks to split.'));
      return;
    }
    const title = audioTitle(target.name);
    await clipMany(
      ranges.map((r, i) => ({ start: r.start, end: r.end, name: `${title} - ${String(i + 1).padStart(2, '0')}` })),
    );
  }, [duration, transcript, marks, target.name, clipMany]);

  /**
   * 把勾选的精选建议**落成音轨上的打点**（不导出、不动音频）。
   *
   * 为什么要有这一步：精选挑出来的区间原来只有两种去处 —— 导出成片段，或者放着不用；
   * 而"我想在音轨上看见它们、再自己决定切哪段"没有出口（原本的 `Generate marks` 是按转写
   * **逐段铺点**，与"挑出来的重点"不是一回事，且一小时的稿会铺出上百个点）。
   *
   * 落下的点带 `auto` 位 ⇒ 与手打点同屏可分（青色空心环），且随时能 `Clear auto marks` 全撤；
   * 合并去重的规则全在纯函数 `marksFromRanges`（有单测）：追加手打点、幂等、近点跳过。
   * 落完**不清空建议** —— 用户往往接着要 `Export`，清掉等于把刚勾的选择弄丢了。
   */
  const markHighlights = useCallback(async () => {
    const picked = highlights.filter((_, i) => highlightSel.has(i));
    if (picked.length === 0) return;
    const res = marksFromRanges(
      picked.map((h) => ({ start: h.start, label: h.title })),
      marks,
    );
    if (res.added === 0) {
      setNote(
        noteInfo(
          `No new marks — all ${res.skipped} selected suggestion(s) already have a mark at their start.`,
        ),
      );
      return;
    }
    await applyMarks(res.marks);
    setNote(
      noteInfo(
        `Added ${res.added} mark${res.added === 1 ? '' : 's'} from the suggestions` +
          (res.skipped > 0 ? ` (${res.skipped} skipped as duplicates).` : '.'),
      ),
    );
  }, [highlights, highlightSel, marks, applyMarks]);

  /** 导出勾选的精选建议（走与批量截取同一条路），导出后清空卡片 */
  const exportHighlights = useCallback(async () => {
    const picked = highlights.filter((_, i) => highlightSel.has(i));
    if (picked.length === 0) return;
    const total = duration > 0 ? duration : (transcript?.durationSec ?? 0);
    const clamp = (v: number) => (total > 0 ? Math.min(v, total) : v);
    await clipMany(picked.map((h) => ({ start: h.start, end: clamp(h.end), name: h.title })));
    setHighlights([]);
    setHighlightSel(new Set());
    // 建议页签随即失效（钳制会落回转写）⇒ 直接切到 Clips：结果一屏可见（清单）且同一批块也落在下轨上
    setDetailTab('clips');
  }, [highlights, highlightSel, duration, transcript, clipMany]);

  /**
   * 重命名某片段：服务端改磁盘文件名（连同它的打点 sidecar）+ 同步 .clips.json；
   * 若改的正是当前编辑对象，跟着换到新路径（否则播放会指向已消失的旧文件）。
   */
  const renameClip = useCallback(
    async (clipPath: string, newName: string) => {
      const d = await postAudio({
        action: 'rename_clip',
        source: root.source,
        path: root.path,
        clipPath,
        name: newName,
      });
      if (!d?.success) {
        setNote(noteError(String(d?.error || 'Could not rename this clip.')));
        return;
      }
      if (Array.isArray(d.clips)) setClips(d.clips as AudioClipRef[]);
      const nextPath = String(d.path || '');
      if (nextPath) {
        const nextName = nextPath.split('/').pop() || newName;
        setTarget((cur) => (cur.path === clipPath ? { ...cur, path: nextPath, name: nextName } : cur));
        setRoot((cur) => (cur.path === clipPath ? { ...cur, path: nextPath, name: nextName } : cur));
        // 下轨的选中态跟着换到新路径，否则重命名后那一块就"掉选"了
        setActiveClipPath((cur) => (cur === clipPath ? nextPath : cur));
      }
    },
    [root.source, root.path],
  );

  /** 删除某片段（删文件 + 它的打点 + 清单条目）；删的正是当前编辑对象 → 退回源音频 */
  const removeClip = useCallback(
    async (clipPath: string) => {
      const d = await postAudio({
        action: 'delete_clip',
        source: root.source,
        path: root.path,
        clipPath,
      });
      if (!d?.success) {
        setNote(noteError(String(d?.error || 'Could not delete this clip.')));
        return;
      }
      if (Array.isArray(d.clips)) setClips(d.clips as AudioClipRef[]);
      if (target.path === clipPath && root.path !== clipPath) setTarget(root);
      // 删掉的正是下轨选中的那一块 ⇒ 清掉选中态（否则轨下会挂着一行已不存在的片段）
      setActiveClipPath((cur) => (cur === clipPath ? null : cur));
    },
    [root, target.path],
  );

  /**
   * 调某片段的区间（下轨拖两端后提交）。
   *
   * 2026-10-17 晚（一主多摘）：**区间是唯一真源** —— 这里只写 `.clips.json` 的 start/end，
   * **不跑 ffmpeg、不覆写文件**。理由：
   *   - 拖一下手柄就重切一次文件，既慢（每次松手等一次 ffmpeg），又会让“片段文件”变成第二真源
   *     （用户以为在调区间，实际在改一个已经导出/分享过的文件）；
   *   - 文件改成**导出时才现渲染的产物**（见 `exportClip`）⇒ 拖拽是瞬时的，旧文件也不会被悄悄替换。
   *
   * 乐观上屏 + 失败回滚：拖拽必须跟手；请求带序号，快速连拖时只认最后一次的回执。
   * `path` 不变 ⇒ 身份/名字/归属都不动，下轨那一块原地变长/变短，选中态也不会掉。
   */
  const updateRange = useCallback(
    async (clip: AudioClipRef, start: number, end: number) => {
      if (!root.path) return;
      const seq = ++rangeSeqRef.current;
      const prev = { ...clip };
      setClips((cur) => cur.map((c) => (c.path === clip.path ? { ...c, start, end } : c)));
      const d = await postAudio({
        action: 'update_clip_range',
        source: root.source,
        path: root.path,
        clipPath: clip.path,
        startSec: start,
        endSec: end,
      });
      // 期间又拖了一次 ⇒ 这次回执已经过期，不能拿它覆盖更新的草稿
      if (seq !== rangeSeqRef.current) return;
      if (!d?.success) {
        setClips((cur) => cur.map((c) => (c.path === clip.path ? prev : c)));
        setNote(noteError(String(d?.error || 'Could not update this excerpt.')));
        return;
      }
      if (Array.isArray(d.clips)) setClips(d.clips as AudioClipRef[]);
      setNote(null);
    },
    [root.source, root.path],
  );

  /**
   * 导出某片段：**先按当前区间现渲染一次**，再交给浏览器下载。
   *
   * 为什么下载前还要 `reclip`：区间可能刚被拖过（此时文件还是旧内容）；不重切就会把旧文件发出去。
   * 这也是“文件是缓存、区间是真源”的落点 —— 用户看到的区间、导出的文件永远一致。
   */
  const exportClip = useCallback(
    async (clip: AudioClipRef) => {
      if (!root.path) return;
      setClipping(true);
      try {
        const d = await postAudio({
          action: 'reclip',
          source: root.source,
          path: root.path,
          clipPath: clip.path,
          startSec: clip.start,
          endSec: clip.end,
        });
        if (!d?.success) {
          setNote(noteError(String(d?.error || 'Could not export this excerpt.')));
          return;
        }
        if (Array.isArray(d.clips)) setClips(d.clips as AudioClipRef[]);
        // 同路径文件刚被覆写：加时间戳绕开代理/浏览器缓存，确保下载到的是这一次渲染的结果
        triggerDownload(`${localProxy(clip.path)}&v=${Date.now()}`, clip.name);
        setNote(noteInfo(`Exported ${clip.name}.`));
      } finally {
        setClipping(false);
      }
    },
    [root.source, root.path],
  );

  /** 把本地音频复制进应用自有音频库，并把它作为新的源音频载入编辑 */
  const importAudio = useCallback(async (file: File) => {
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const resp = await fetch('/api/audio/import', { method: 'POST', body: fd });
      const d = await resp.json().catch(() => null);
      const f = d?.file as { path?: string; name?: string; size?: number } | undefined;
      if (d?.success && f?.path) {
        const t: Target = { source: 'local', path: f.path, name: f.name || 'Audio', size: f.size };
        setRoot(t);
        setTarget(t);
        setOrigin(null);
        setClips([]);
        setActiveClipPath(null);
      } else {
        setNote(noteError(String(d?.error || 'Could not import this audio.')));
      }
    } catch {
      setNote(noteError('Could not import this audio.'));
    } finally {
      setImporting(false);
    }
  }, []);

  /**
   * 用服务端回传的**完整分组状态**整份替换本地（groups + assign）。
   * 五个分组动作都回传完整状态，前端不推演"局部改了什么" ⇒ 两份状态不会漂移。
   * 返回是否成功（调用方据此决定清草稿 / 报错）。
   */
  const applyGroupState = useCallback((r: Record<string, unknown>): boolean => {
    if (r?.success !== true) return false;
    if (Array.isArray(r.groups)) setGroups(r.groups as AudioGroup[]);
    if (r.assign && typeof r.assign === 'object') setGroupAssign(r.assign as Record<string, string>);
    return true;
  }, []);

  /** 打开库浏览面板并拉取列表 + 分组 */
  const openLibrary = useCallback(async () => {
    setShowLibrary(true);
    setLoadingLibrary(true);
    setCreatingGroup(false);
    setGroupDraft('');
    try {
      const [lib, grp] = await Promise.all([
        postAudio({ action: 'list_library' }),
        postAudio({ action: 'list_groups' }),
      ]);
      if (lib?.success && Array.isArray(lib.entries)) {
        setLibraryEntries(lib.entries as LibraryEntry[]);
      }
      applyGroupState(grp);
    } finally {
      setLoadingLibrary(false);
    }
    void postAudio({ action: 'list_shadows' }).then((r) => {
      const list = Array.isArray(r.shadows) ? (r.shadows as ShadowEntry[]) : [];
      setShadows(list);
    });
  }, [applyGroupState]);

  /** 新建分组（成功即收起输入行） */
  const createLibraryGroup = useCallback(
    async (name: string) => {
      const d = await postAudio({ action: 'create_group', name });
      if (applyGroupState(d)) {
        setCreatingGroup(false);
        setGroupDraft('');
      } else {
        setNote(noteError(typeof d.error === 'string' ? d.error : 'Could not create the group.'));
      }
    },
    [applyGroupState],
  );

  /** 重命名分组（成功即退出编辑态） */
  const renameLibraryGroup = useCallback(
    async (id: string, name: string) => {
      const d = await postAudio({ action: 'rename_group', id, name });
      if (applyGroupState(d)) setRenamingGroupId(null);
      else setNote(noteError(typeof d.error === 'string' ? d.error : 'Could not rename the group.'));
    },
    [applyGroupState],
  );

  /** 删除分组（只解散组织：条目回到未分组，**不动音频文件**） */
  const deleteLibraryGroup = useCallback(
    async (id: string) => {
      setConfirmGroupId(null);
      const d = await postAudio({ action: 'delete_group', id });
      if (applyGroupState(d)) {
        setCollapsedGroups((cur) => {
          if (!cur.has(id)) return cur;
          const next = new Set(cur);
          next.delete(id);
          return next;
        });
      } else {
        setNote(noteError(typeof d.error === 'string' ? d.error : 'Could not delete the group.'));
      }
    },
    [applyGroupState],
  );

  /** 把一条音频移入分组（`groupId` 空串 = 移出分组回到未分组）；拖放落点调用它 */
  const moveEntryToGroup = useCallback(
    async (entryDir: string, groupId: string) => {
      const d = await postAudio({ action: 'assign_group', dir: entryDir, group: groupId });
      if (!applyGroupState(d)) {
        setNote(noteError(typeof d.error === 'string' ? d.error : 'Could not move this audio.'));
      }
    },
    [applyGroupState],
  );

  /** 从库中载入一条音频作为新的源音频 */
  const loadFromLibrary = useCallback((entry: LibraryEntry) => {
    const t: Target = {
      source: 'local',
      path: entry.path,
      name: libraryTitle(entry.dir),
      size: entry.size,
    };
    setRoot(t);
    setTarget(t);
    setOrigin(null);
    setClips([]);
    setActiveClipPath(null);
    setShowLibrary(false);
  }, []);

  /** 从库中删除一条音频（如果删的是当前正在编辑的，清空编辑状态） */
  /** 删一个影子目录（只删库内产物，**不动源音频**；护栏在服务端） */
  const deleteShadow = useCallback(async (dir: string) => {
    setConfirmShadow(null);
    const r = await postAudio({ action: 'delete_shadow', dir });
    setShadows((cur) => (r.success === true ? cur.filter((x) => x.path !== dir) : cur));
    if (r.success !== true) {
      setNote(noteError(typeof r.error === 'string' ? r.error : 'Could not delete these artifacts'));
    }
  }, []);

  const deleteFromLibrary = useCallback(
    async (path: string) => {
      const d = await postAudio({ action: 'delete_library', path });
      if (d?.success) {
        setLibraryEntries((cur) => cur.filter((e) => e.path !== path));
        if (root.path === path) {
          setRoot({ source: 'local', path: '', name: 'Audio' });
          setTarget({ source: 'local', path: '', name: 'Audio' });
          setOrigin(null);
          setShowLibrary(false);
        } else if (origin?.sourcePath === path) {
          // 删的是当前 fork 的原录音：面包屑不能再指向一个已删除的路径
          setOrigin(null);
        }
      }
    },
    [root.path, origin],
  );

  const handleOpen = async () => {
    try {
      if (target.path) await desktop.openFile(target.path);
    } catch {
      console.error('Failed to open file');
    }
  };

  /**
   * 波形给的真实时长。
   *
   * 用 `useCallback` 而不是内联箭头：这几个回调会被 `AudioMarkTrack` 收进它的 `cbRef`
   * （effect 依赖里有它们），内联箭头每次都换身份会让那个 effect 空转 ——
   * 虽然那里只做 ref 赋值（不会重建波形），但没有理由白跑。
   */
  const handleDuration = useCallback((d: number) => setDuration(d), []);
  const handleTimeUpdate = useCallback((t: number) => setPlayTime(t), []);
  /**
   * 点转写句 / 点轮首 → **只定位，不自动播放**。
   *
   * 口径（用户确认）：点文稿是"看这一句在哪、跳过去看看"，不是"从这句开始听"——
   * 所以**不动播放/暂停状态**：原本暂停就停在跳转处，原本在播就从跳转处接着播。
   *
   * 为什么不需要显式分支：`p.seek()` 经 `AudioMarkTrack.seekTo` → `ws.setTime()`（wavesurfer），
   * 定位本身不改变播放状态 ⇒ "暂停保持暂停、播放继续播"是 seek 的天然语义，
   * 不必读 `isPlaying` 再决定要不要 `play()`（多一次判断反而会和状态不同步）。
   */
  const handleSeek = useCallback((t: number) => {
    playerRef.current?.seek(t);
  }, []);

  /**
   * **给没有批注的打点回填批注**（2026-10-12，用户选的优化 C 的第二半）。
   *
   * 为什么需要：实测用户那条 3h38m 的录音上打了 7 个点，**一个批注都没写** —— 写批注要停下打字；
   * 而同一批录音里已经有信息量更大的东西可用：
   *   ① **同名片段**：片段起点常与打点同刻（实测 317.8 / 2619.4 都对得上）⇒ 片段名就是最好的批注；
   *   ② **转写**：该时刻所在段（或 6s 内下一段）的文本，用 `markLabelFromText` 截到 24 字。
   * 先片段后转写：片段名是**你自己起的**，比模型断句更贴近你的说法。
   * 只补"空批注"的点（有名字的一律不动）；结果走 `applyMarks`（乐观上屏 + 压撤销栈 + await 落盘）⇒ 可 Undo。
   */
  const fillEmptyLabels = useCallback(async () => {
    if (!target.path) return;
    const stripExt = (n: string) => n.replace(/\.[^.]+$/, '');
    const fromClip = (t: number): string | undefined => {
      const hit = clips.find((c) => Math.abs(c.start - t) <= 0.3);
      const name = hit ? stripExt(hit.name).trim() : '';
      return name || undefined;
    };
    const fromTranscript = (t: number): string | undefined => {
      const segs = transcript?.segments ?? [];
      const covering = segs.find((sg) => t >= sg.t && t < sg.end);
      const near = covering ?? segs.find((sg) => sg.t >= t - 0.2 && sg.t <= t + 6);
      return near ? markLabelFromText(near.text) : undefined;
    };
    const next = marks.map((m) => {
      if (m.label || m.auto) return m;
      const label = fromClip(m.t) ?? fromTranscript(m.t);
      return label ? { ...m, label } : m;
    });
    const filled = next.filter((m, i) => !marks[i].label && m.label).length;
    if (filled === 0) {
      setNote(noteInfo('Nothing to fill from — transcribe this audio or export a clip at that mark first.'));
      return;
    }
    await applyMarks(next);
    setNote(noteInfo(`Filled ${filled} mark label${filled > 1 ? 's' : ''}.`));
  }, [target.path, clips, transcript, marks, applyMarks]);

  const atRoot = target.path === root.path;

  /**
   * 音频总时长（秒）：优先用**波形解码**拿到的真实值（`duration`），
   * 其次才是转写 sidecar 里 ffprobe 的读数。
   * 用途 = 长音频的窗口化提示（要不要提醒"会跑十几分钟"）与逐窗进度读数。
   */
  const audioTotalSec = duration > 0 ? duration : (transcript?.durationSec ?? 0);

  /** 下轨当前选中的片段：按路径在清单里现查（改名/删除后自然落空，不必额外同步） */
  const activeClip = clips.find((c) => c.path === activeClipPath) ?? null;

  /**
   * 点下轨的块 = 选中 + 跳到该片段的起点。
   *
   * 只 seek、**不换播放器**：第一步里上轨恒是源（片段本就是源的一段区间），点块不该重抓 Blob/重解码。
   * 想听整段片段：点块已把播放头落在起点，直接按走带键 / `Space` —— 选中的片段就是**播放边界**
   * （`spotlight` 区间同时收束播放，见 `AudioMarkTrack` 的 `toggle`），播到片段末端自动停。
   */
  const selectClip = useCallback((c: AudioClipRef) => {
    /**
     * 先清波形选区，再选中片段：两者都是“当前范围”，同屏同时亮会在走带里打架
     * （播放优先级是选区 > 片段，chip 却写着片段，用户看到的与听到的不一致）。
     * `clearSelection()` 触发的 `onSelectionChange(null)` 会在下一拍把 `activeClipPath` 又清掉，
     * 所以用 `clipSelectingRef` 吃掉这一次“因切换而清空”的回调（见 `handleSelectionChange`）。
     */
    if (playerRef.current?.getSelection()) clipSelectingRef.current = true;
    playerRef.current?.clearSelection();
    setSelRange(null);
    setActiveClipPath(c.path);
    playerRef.current?.seek(c.start);
  }, []);

  /**
   * **把片段 fork 成独立主音频**（P2，“Make separate audio”）。
   *
   * 一主多摘的第三条规则：片段默认没有自己的时间轴；要给它自己的打点/转写/再切，
   * 必须显式复制成一条新主音频。原录音一字不动，新音频在库里是独立条目（`.origin.json` 记来源）。
   *
   * 服务端从**源 + 当前区间**重新渲染（不复制可能已过期的缓存文件），所以 fork 出来的是屏幕上那一段。
   * 成功后整屏切换到新音频：新波形、空打点、空片段清单，顶部出现 `‹ 原录音` 面包屑。
   */
  const forkClip = useCallback(
    async (clip: AudioClipRef) => {
      if (!root.path || forkInFlightRef.current) return;
      forkInFlightRef.current = true;
      setForkingPath(clip.path);
      try {
        const d = await postAudio({
          action: 'fork_clip',
          source: root.source,
          path: root.path,
          clipPath: clip.path,
          sourceName: root.name,
        });
        if (!d?.success) {
          setNote(noteError(String(d?.error || 'Could not make a separate audio.')));
          return;
        }
        const path = String(d.path || '');
        const name = String(d.name || clip.name);
        if (!path) {
          setNote(noteError('Could not make a separate audio.'));
          return;
        }
        const t: Target = { source: 'local', path, name };
        // 先清旧文档的清单/选中，再切 target；loading 期间不会短暂画出上一份的片段
        setClips([]);
        setActiveClipPath(null);
        setDetailTab('transcript');
        setRoot(t);
        setTarget(t);
        setOrigin(isAudioOrigin(d.origin) ? d.origin : null);
        setNote(noteInfo(`Opened “${name}” as a separate audio. The original recording is unchanged.`));
      } finally {
        forkInFlightRef.current = false;
        setForkingPath(null);
      }
    },
    [root.path, root.source, root.name],
  );

  /** 面包屑：回到 fork 前的原录音（原录音从未被修改，这里只是切回那份文档） */
  const backToSource = useCallback(() => {
    if (!origin) return;
    const t: Target = { source: origin.source, path: origin.sourcePath, name: origin.sourceName };
    setClips([]);
    setActiveClipPath(null);
    setDetailTab('transcript');
    setRoot(t);
    setTarget(t);
    setOrigin(null);
    setNote(null);
  }, [origin]);

  /** 退出片段选中（清 `activeClipPath`；顺手清波形选区 —— 两处“离开当前选择”同口径） */
  const clearClipSelection = useCallback(() => {
    setActiveClipPath(null);
    playerRef.current?.clearSelection();
  }, []);

  /**
   * 显式播放某片段：**先选中再播**。
   * 只调 `playRange` 不选中，会出现“在播 A、界面还亮着 B”的错位（尤其从 Excerpts 清单里点 ▶）；
   * 先 `selectClip` 保证 chip / 聚光 / 手柄和正在播的区间是同一个。
   */
  const playClip = useCallback(
    (c: AudioClipRef) => {
      selectClip(c);
      playerRef.current?.playRange({ start: c.start, end: c.end });
    },
    [selectClip],
  );

  /**
   * 清除**播放作用域**（走带 chip 上的 ×）：选中的片段与波形选区任一都会收束播放
   * （见 `AudioMarkTrack.toggle` 的优先级），所以两个一起清；清完就是“整段播放”。
   */
  const clearPlayScope = useCallback(() => {
    clearClipSelection();
  }, [clearClipSelection]);

  /**
   * 上轨波形**选区**变化：镜像给转写面板（`highlightRange`），并让**点空白 / 按 ✕ 退出选区**时
   * 顺带退出片段选中 —— 两者都是"离开当前选择"，若只有波形那半消失、片段聚光还亮着，
   * 用户会以为"点了别处没生效"。
   */
  const handleSelectionChange = useCallback((sel: { start: number; end: number } | null) => {
    setSelRange(sel);
    if (sel) {
      // 新选区取代片段选中：同一时刻只允许一个“当前范围”
      clipSelectingRef.current = false;
      setActiveClipPath(null);
      return;
    }
    // 因“选中片段而清掉旧选区”的那一次回调：保留刚选中的片段
    if (clipSelectingRef.current) {
      clipSelectingRef.current = false;
      return;
    }
    setActiveClipPath(null);
  }, []);

  /**
   * 主音轨的**聚光区间**（绝对秒）：选中片段 → 只亮它这一段；正在拖手柄 → 用草稿区间（跟着长大/收窄）。
   * 都没有 = null（不做任何暗化，既有观感不变）。
   */
  const spotlight: { start: number; end: number } | null = clipDrag
    ? { start: clipDrag.start, end: clipDrag.end }
    : activeClip
      ? { start: activeClip.start, end: activeClip.end }
      : null;

  /**
   * 拖拽竖虚线的横向位置（%）：取草稿里**被拖的那一端**。映射与两轨**同源**——
   * 窗口模式用 `trackView.view`，整段用总时长兜底 ⇒ 这条线在上下两轨里的落点是同一个 x。
   * 拖到窗口之外（缩放后）就不画（和块一样，只在可见窗口内有意义）。
   */
  const guideTime = clipDrag ? (clipDrag.edge === 'start' ? clipDrag.start : clipDrag.end) : null;
  const guideX = (() => {
    if (guideTime == null) return null;
    const s = trackView.view ? trackView.view.start : 0;
    const sec = trackView.view ? trackView.view.sec : audioTotalSec;
    if (!(sec > 0)) return null;
    const pct = ((guideTime - s) / sec) * 100;
    return pct < 0 || pct > 100 ? null : pct;
  })();

  /** 隐藏的导入 input（面板内两处入口共用） */
  const importInput = (
    <input
      ref={importInputRef}
      type="file"
      accept={AUDIO_ACCEPT}
      className="hidden"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) void importAudio(f);
        e.target.value = '';
      }}
    />
  );

  // ── 库浏览面板 ──
  if (showLibrary) {
    /**
     * 归组视图派生数据（都在渲染期算，不另开状态）：
     *   - 库里有分组才启用分区块；没有分组就维持原来的平铺列表（不打扰还没用过分组的用户）；
     *   - "未分组"永远兜底承接对不上的归属（组被删/条目在手改的目录里）；
     *   - 拖拽进行中时，"未分组"即使为空也出现 —— 否则用户没法把条目拖出分组。
     */
    const byGroup = new Map<string, LibraryEntry[]>();
    for (const g of groups) byGroup.set(g.id, []);
    const ungrouped: LibraryEntry[] = [];
    for (const e of libraryEntries) {
      const gid = groupAssign[libraryKey(e.dir)];
      const bucket = gid ? byGroup.get(gid) : undefined;
      if (bucket) bucket.push(e);
      else ungrouped.push(e);
    }
    const groupedView = groups.length > 0;
    const showUngrouped = ungrouped.length > 0 || draggingDir !== null;

    const toggleGroup = (id: string) =>
      setCollapsedGroups((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });

    /**
     * 一条音频行：**整行可拖**（拖到任一区块头即归入该组/移出分组），
     * 点标题载入，右侧删除仍走两段确认。拖拽中自身半透明，落点高亮由区块头负责。
     */
    const renderEntry = (e: LibraryEntry) => (
      <div
        key={e.path}
        draggable
        onDragStart={(ev) => {
          setDraggingDir(e.dir);
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', libraryTitle(e.dir));
        }}
        onDragEnd={() => {
          setDraggingDir(null);
          setDropTarget(null);
        }}
        className="flex items-center rounded-md transition-colors hover:bg-[var(--primary-soft)]"
        style={{ opacity: draggingDir === e.dir ? 0.4 : 1, cursor: 'grab' }}
      >
        <button
          onClick={() => loadFromLibrary(e)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left"
        >
          <Music className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
          <span className="truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>
            {libraryTitle(e.dir)}
          </span>
          <span className="ml-auto shrink-0 text-11 tabular-nums" style={{ color: 'var(--ink-muted)' }}>
            {formatSize(e.size)}
          </span>
        </button>
        {confirmLibPath === e.path ? (
          <>
            <button
              type="button"
              onClick={() => {
                setConfirmLibPath(null);
                void deleteFromLibrary(e.path);
              }}
              title="Confirm delete — removes the source, its clips and marks"
              className="mr-1 shrink-0 rounded p-1.5 transition-colors"
              style={{ color: 'var(--danger)' }}
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setConfirmLibPath(null)}
              title="Cancel"
              className="mr-1 shrink-0 rounded p-1.5 transition-colors"
              style={{ color: 'var(--ink-muted)' }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmLibPath(e.path)}
            title="Delete"
            className="mr-1 shrink-0 rounded p-1.5 transition-colors"
            style={{ color: 'var(--ink-muted)' }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );

    /**
     * 一个区块（真实分组 / "未分组"）：区块头是**拖放落点**（也可点收起）——
     * 落在真实分组 = 归入该组，落在"未分组" = 移出分组。真实分组另有改名 / 删除。
     */
    const renderSection = (
      id: string,
      name: string,
      entries: LibraryEntry[],
      collapsed: boolean,
      collapsedToggle: () => void,
      kind: 'group' | 'ungrouped',
    ) => (
      <div
        key={id}
        className="flex flex-col"
        data-role={kind === 'group' ? 'library-group' : 'library-ungrouped'}
        onDragOver={(ev) => {
          if (!draggingDir) return; // 只接本面板自己的拖拽（外部文件拖进来不该高亮）
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'move';
          setDropTarget(id);
        }}
        onDragLeave={(ev) => {
          if (ev.currentTarget.contains(ev.relatedTarget as Node | null)) return; // 掠过子元素不清高亮
          setDropTarget((cur) => (cur === id ? null : cur));
        }}
        onDrop={(ev) => {
          ev.preventDefault();
          const dir = draggingDir;
          setDropTarget(null);
          setDraggingDir(null);
          if (!dir) return;
          void moveEntryToGroup(dir, id === UNGROUPED_DROP ? '' : id);
        }}
      >
        <div
          className="flex items-center gap-1 rounded-md px-2 py-1 transition-colors"
          style={{
            backgroundColor: dropTarget === id ? 'var(--primary-soft)' : undefined,
            outline: dropTarget === id ? '1px dashed var(--primary)' : undefined,
          }}
        >
          {renamingGroupId === id ? (
            <>
              <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
              <input
                autoFocus
                value={groupDraft}
                onChange={(ev) => setGroupDraft(ev.target.value)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') ev.currentTarget.blur();
                  else if (ev.key === 'Escape') {
                    groupInputAbortRef.current = true; // 吃掉卸载时的 blur
                    setRenamingGroupId(null);
                    setGroupDraft('');
                  }
                }}
                onBlur={() => {
                  if (groupInputAbortRef.current) {
                    groupInputAbortRef.current = false;
                    return;
                  }
                  const n = groupDraft.trim();
                  if (n) void renameLibraryGroup(id, n);
                  else setRenamingGroupId(null);
                }}
                className="min-w-0 flex-1 rounded px-1.5 py-0.5 text-11 outline-none"
                style={{ border: '1px solid var(--line-soft)', color: 'var(--ink)', backgroundColor: 'var(--paper)' }}
              />
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={collapsedToggle}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                title={collapsed ? 'Expand' : 'Collapse'}
              >
                <ChevronRight
                  className={`h-3 w-3 shrink-0 transition-transform${collapsed ? '' : ' rotate-90'}`}
                  style={{ color: 'var(--ink-faint)' }}
                />
                <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                <span className="truncate text-11 font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
                  {name}
                </span>
                <span className="shrink-0 text-10 tabular-nums" style={{ color: 'var(--ink-faint)' }}>{entries.length}</span>
              </button>
              {kind === 'group' && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      groupInputAbortRef.current = false;
                      setGroupDraft(name);
                      setRenamingGroupId(id);
                    }}
                    title="Rename group"
                    className="shrink-0 rounded p-1 transition-colors"
                    style={{ color: 'var(--ink-muted)' }}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  {confirmGroupId === id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void deleteLibraryGroup(id)}
                        title="Confirm — the group is removed, your audio files stay"
                        className="shrink-0 rounded p-1 transition-colors"
                        style={{ color: 'var(--danger)' }}
                      >
                        <Check className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmGroupId(null)}
                        title="Cancel"
                        className="shrink-0 rounded p-1 transition-colors"
                        style={{ color: 'var(--ink-muted)' }}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmGroupId(id)}
                      title="Delete group — the group is removed, your audio files stay"
                      className="shrink-0 rounded p-1 transition-colors"
                      style={{ color: 'var(--ink-muted)' }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
        {!collapsed && entries.map(renderEntry)}
        {!collapsed && entries.length === 0 && (
          <p className="px-2.5 pb-1 text-10" style={{ color: 'var(--ink-faint)' }}>
            {kind === 'group' ? 'Drag audio here' : 'Empty'}
          </p>
        )}
      </div>
    );

    return (
    <div className="flex flex-col gap-2 px-6 py-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowLibrary(false)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-12 font-medium transition-colors"
            style={{ color: 'var(--ink-muted)' }}
          >
            <ArrowLeft className="h-3 w-3" />Back
          </button>
          <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Library</p>
          <button
            onClick={() => {
              groupInputAbortRef.current = false;
              setGroupDraft('');
              setCreatingGroup(true);
            }}
            title="Create a group"
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-12 font-medium transition-colors"
            style={{ color: 'var(--ink-muted)' }}
          >
            <FolderPlus className="h-3 w-3" />New group
          </button>
          <button
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-12 font-medium transition-colors"
            style={{ color: 'var(--ink-muted)' }}
          >
            <Upload className="h-3 w-3" />Import
          </button>
        </div>
        {importInput}
        {creatingGroup && (
          <div className="flex items-center gap-1 rounded-md px-2 py-1" style={{ backgroundColor: 'var(--paper-hover)' }}>
            <FolderPlus className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
            <input
              autoFocus
              placeholder="Group name"
              value={groupDraft}
              onChange={(ev) => setGroupDraft(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') ev.currentTarget.blur();
                else if (ev.key === 'Escape') {
                  groupInputAbortRef.current = true; // 吃掉卸载时的 blur
                  setCreatingGroup(false);
                  setGroupDraft('');
                }
              }}
              onBlur={() => {
                if (groupInputAbortRef.current) {
                  groupInputAbortRef.current = false;
                  return;
                }
                const n = groupDraft.trim();
                if (n) void createLibraryGroup(n);
                else {
                  setCreatingGroup(false);
                  setGroupDraft('');
                }
              }}
              className="min-w-0 flex-1 rounded px-1.5 py-0.5 text-xs outline-none"
              style={{ border: '1px solid var(--line-soft)', color: 'var(--ink)', backgroundColor: 'var(--paper)' }}
            />
          </div>
        )}
        {loadingLibrary && (
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>Loading…</p>
        )}
        {!loadingLibrary && libraryEntries.length === 0 && groups.length === 0 && (
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>No audio in the library yet.</p>
        )}
        {!loadingLibrary && (groupedView ? (
          <div className="flex flex-col gap-1">
            {groups.map((g) =>
              renderSection(
                g.id,
                g.name,
                byGroup.get(g.id) ?? [],
                collapsedGroups.has(g.id),
                () => toggleGroup(g.id),
                'group',
              ),
            )}
            {showUngrouped &&
              renderSection(
                UNGROUPED_DROP,
                'Ungrouped',
                ungrouped,
                ungroupedCollapsed,
                () => setUngroupedCollapsed((v) => !v),
                'ungrouped',
              )}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">{libraryEntries.map(renderEntry)}</div>
        ))}
        <StatusLine note={note} />

        {/*
          未托管产物（影子目录）：库外音频（项目 materials / 任意本地路径）的打点/峰值/转写/片段
          都放在库内的影子目录里，而**列表只认带 source.* 的条目** ⇒ 源文件被删/移动后它们会永远留下、
          界面上删不掉。这里给它们一个入口：列出 + 判断源是否还在 + 确认后删除。
          ⚠️ 只删库内产物，绝不动源音频文件。
        */}
        {shadows.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5 pt-2" style={{ borderTop: '1px solid var(--line-soft)' }} data-role="shadows-section">
            <p className="px-2.5 text-11 font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
              Unmanaged artifacts · {shadows.length}
            </p>
            <p className="px-2.5 text-10" style={{ color: 'var(--ink-muted)' }}>
              Artifacts of audio edited outside the library. Deleting these never touches your audio files.
            </p>
            {shadows.map((sh) => (
              <div key={sh.path} className="flex items-center gap-2 rounded-md px-2.5 py-1.5">
                <Music className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-faint)' }} />
                <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--ink)' }} title={sh.sourcePath ?? sh.dir}>
                  {sh.dir}
                </span>
                <span className="shrink-0 text-11 tabular-nums" style={{ color: 'var(--ink-muted)' }}>{formatSize(sh.size)}</span>
                <span
                  data-role="shadow-verdict"
                  className="shrink-0 rounded px-1 text-10"
                  style={{
                    color: sh.sourceExists === false ? 'var(--danger)' : 'var(--ink-muted)',
                    backgroundColor: sh.sourceExists === false ? 'var(--danger-soft)' : 'var(--paper-hover)',
                  }}
                  title={sh.sourcePath ? `Source: ${sh.sourcePath}` : 'No record of which audio this belongs to (older directory)'}
                >
                  {sh.sourceExists === false ? 'source gone' : sh.sourceExists === true ? 'source present' : 'unknown'}
                </span>
                {confirmShadow === sh.path ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void deleteShadow(sh.path)}
                      className="shrink-0 rounded-md px-1.5 py-0.5 text-12 font-medium"
                      style={{ color: 'var(--danger)' }}
                      title="Delete these artifacts"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmShadow(null)}
                      className="shrink-0 rounded p-0.5"
                      style={{ color: 'var(--ink-faint)' }}
                      title="Cancel"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmShadow(sh.path)}
                    className="shrink-0 rounded p-0.5 transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ color: 'var(--ink-faint)' }}
                    title="Delete these artifacts (your audio file is not touched)"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // 加载中：与「失败 / 空」区分（首次打开大文件要先算波形峰值，可能几秒，此前看不出在加载）
  if (loading && !playUrl) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-16">
        {importInput}
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--ink-muted)' }} />
        <div className="max-w-full text-center">
          <p className="truncate text-sm font-medium" style={{ color: 'var(--ink)' }}>{target.name}</p>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>Loading audio…</p>
        </div>
      </div>
    );
  }

  // 没有 playUrl：两种情形共用本块 ——
  //   ① 无源音频（左栏 Audio Editor 打开的空编辑器，`target.path === ''`）⇒ 引导语 + Import/Library；
  //   ② 有文件但加载失败 ⇒ 退回旧版图标 + "Open with default program" + 导入 + 库浏览。
  if (!playUrl) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-16">
        {importInput}
        <div
          className="flex h-16 w-16 items-center justify-center rounded-full"
          style={{ backgroundColor: 'var(--primary-soft)' }}
        >
          <Music className="h-7 w-7" style={{ color: 'var(--primary-strong)' }} />
        </div>
        <div className="max-w-full text-center">
          {/* 无源音频时不显示占位名与 "0 B"，改引导语；两行结构与失败态一致 ⇒ 高度不漂 */}
          <p className="truncate text-sm font-medium" style={{ color: 'var(--ink)' }}>
            {target.path ? target.name : 'Audio Editor'}
          </p>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
            {target.path ? formatSize(target.size || 0) : 'Import an audio file, or pick one from your library, to start editing.'}
          </p>
        </div>
        <StatusLine note={note} />
        <div className="flex items-center gap-2">
          {atRoot && !!target.path && (
            <button
              onClick={handleOpen}
              className="inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-xs font-medium transition-colors"
              style={{ color: 'var(--ink-muted)' }}
            >
              <ExternalLink className="h-3.5 w-3.5" />Open with default program
            </button>
          )}
          <button
            onClick={() => void openLibrary()}
            className="inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-xs font-medium transition-colors"
            style={{ color: 'var(--ink-muted)' }}
          >
            <LibraryIcon className="h-3.5 w-3.5" />Library
          </button>
          <button
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
            className="inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-xs font-medium transition-colors"
            style={{ backgroundColor: 'var(--primary-strong)', color: '#fff' }}
          >
            <Upload className="h-3.5 w-3.5" />Import audio
          </button>
        </div>
      </div>
    );
  }

  /**
   * 竖向留白（2026-10-11 八轮）：`gap-3 py-8` → `gap-2 py-4`（库面板同口径）。
   *
   * 2026-10-12（方案 A+B，"各个部分没有很好区分开"）：这一屏的**边界层级**固定成三档，别再各写各的：
   *   ① 结构性边界 = `1px --line`：标题栏底边线、播放器舞台的描边（把"头部/编辑区"从内容里拎出来）；
   *   ② 分区边界  = `1px --line-soft` + `pt-2`：Transcript / Suggested clips / Source / Excerpts 之间的细线；
   *   ③ 组内关系  = `gap-0.5 ~ gap-1`（4px 量级），组间靠 ② 的线 + 根容器 `gap-2` 拉开。
   * 字号层级同时收口：分区标题 `text-11 uppercase --ink-faint`、行标题 `text-12/13 --ink`、
   *   读数 `text-10 mono --ink-muted`、行内动作 `text-12 --primary-strong`。
   *
   * 2026-10-17（方案 A）：② 的"分区细线 + 小号大写标题"**已被页签取代** ——
   *   分区收成"一条常驻标签条 + 限高的内容区"：Transcript / Suggested / Excerpts。
   *   于是只剩 ① 结构性边界与 ③ 组内关系两档；标签文字接管了原来 `text-11 uppercase` 占的层级位。
   *   目的：标签条高度恒定一行、列表限高 ⇒ 页面不再被 Suggested / Excerpts 无限撑长。
   *
   * 2026-10-17（二次调整）：`Source` 从"Excerpts 页签的首行"改为**标签条之外常驻的一行**
   *   （钉在音轨正下方）—— 它是这一栏的根，被任何一个页签盖住都不对：回源要"先切页签"才两步。
   *   于是 ② **回潮一档**：这一行与下方标签条之间用 `1px --line-soft` + `pb-2` 分开
   *   （它是"根"，与"根下面的分区"之间确实存在一条边界）。
   *
   * ⚠️ 横向 `px-6` **刻意不动**：`音频查看器版式与主次优化工单_20261011.md` 里的"可用内容宽
   * = 面板宽 − 3rem"以及窄面板折行结论全部建立在它上面，动它要重测一整套。
   * ⚠️ 状态条那 23px 占位也**刻意保留**：它是"状态出现时不推动下方"的承重设计，
   * 为省 9px 动它会破坏一条已定稿的位移不变量 —— 省高度只从间距/内边距里要。
   */
  /**
   * 片段清单（改名 / 播放 / 下载 / fork / 删除一次看全）。
   * 宽屏固定在左栏波形下方（音频 + 片段同侧）；窄屏仍回到 Excerpts 页签。
   * 与下轨共用 `activeClipPath` ⇒ 点行 = 选中轨道上同一块，不会出现两个"当前片段"。
   */
  const clipsList = (
    <div className="flex flex-col gap-0.5" data-role="clips-section">
      <div className={wide ? 'flex flex-col gap-0.5' : 'flex max-h-64 flex-col gap-0.5 overflow-y-auto'}>
        {clips.length === 0 && (
          <p className="px-2.5 py-1 text-10" style={{ color: 'var(--ink-faint)' }}>
            No excerpts yet — select a range, then Save excerpt
          </p>
        )}
        {clips.map((c) => (
          <ClipRow
            key={c.path}
            active={activeClipPath === c.path}
            name={c.name}
            sub={`${fmtTime(c.start)}–${fmtTime(c.end)}`}
            onClick={() => selectClip(c)}
            onPlay={() => playClip(c)}
            onZoom={
              trackView.zoomable
                ? () => playerRef.current?.zoomToRange({ start: c.start, end: c.end })
                : undefined
            }
            onTranscript={transcript ? () => void openClipAsMarkdown(c) : undefined}
            onRename={(n) => void renameClip(c.path, n)}
            onDownload={() => void exportClip(c)}
            onFork={() => void forkClip(c)}
            forkBusy={forkingPath === c.path}
            onDelete={() => void removeClip(c.path)}
          />
        ))}
      </div>
    </div>
  );

  return (
    <div
      className={
        wide
          ? 'flex h-full min-h-0 flex-col gap-3 overflow-hidden px-4 py-3'
          : 'flex flex-col gap-2 px-6 py-4'
      }
    >
      {importInput}
      {/* fork 来源面包屑：这份音频是从哪段录音的哪一段复制出来的。
          只有 fork 出来的副本才有；原始录音不显示任何"返回"（它没有上一层）。
          可点击的返回用 text-12，区间/徽标用 text-10 —— 同一行内可点击字号更大。 */}
      {origin && (
        <div
          data-role="origin-crumb"
          className="flex flex-wrap items-center gap-1.5 text-10"
          style={{ color: 'var(--ink-muted)' }}
        >
          <button
            type="button"
            onClick={backToSource}
            className="inline-flex min-w-0 max-w-[70%] items-center gap-1 rounded-md px-1.5 py-0.5 text-12 font-medium transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--primary-strong)' }}
            title={`Back to ${origin.sourceName} (${mmss(origin.start)}–${mmss(origin.end)})`}
          >
            <ArrowLeft className="h-3 w-3 shrink-0" />
            <span className="truncate">{origin.sourceName}</span>
          </button>
          <span className="shrink-0" style={{ color: 'var(--ink-faint)' }}>
            · from {mmss(origin.start)}–{mmss(origin.end)}
          </span>
          <span
            className="shrink-0 rounded-full px-1.5 py-0.5 text-10 font-medium"
            style={{
              color: 'var(--primary-strong)',
              backgroundColor: 'var(--primary-soft)',
              border: '1px solid color-mix(in oklab, var(--primary-strong) 20%, transparent)',
            }}
          >
            separate copy
          </span>
        </div>
      )}
      {/*
        标题栏：文件名 + 大小 + 右侧动作（Library / Import / Open）。
        ⚠️ 两处是**为容纳第三个动作而必须**的（2026-10-11 六轮）：
          · `flex-wrap`：面板壳是 `overflow:hidden`（CanvasFlow.tsx:628），不折行就会把最右侧按钮整块裁掉
            —— 与下方控制行同款问题（那边的实测见 `AudioMarkTrack.tsx` 里 `Play range` 8.62px 那段）；
          · 占位 `flex-1` 取代 `ml-auto`：`ml-auto` 在折行后会把**第二行也推到右侧**，
            而占位撑满第一行后，第二行自然**左对齐**（与控制行折行后的行为一致）。
        另：文件名 `<p>` 补 `min-w-0` —— flex 子项默认 `min-width:auto`，不加就**不会**收缩到内容以下，
        `truncate` 形同虚设，会把右侧按钮整体顶出可视区。
      */}
      {/* ── 标题栏（2026-10-12 方案 A+B）：加一条**结构性**底边线（`--line`，比分区内的 `--line-soft` 重一档），
          让"头部"与下面的内容一眼分开。`pb-2.5` 是给这条线留的气口。 ── */}
      <div
        className="flex flex-wrap items-center gap-1.5 pb-2.5"
        style={{ borderBottom: '1px solid var(--line)' }}
      >
        <Music className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
        {/* ⚠️ `flex-1`（= basis 0%）在这里是**必须**的，不是顺手加的：flex 折行用的是"基础尺寸"，
            `min-w-0` 只管下限 ⇒ 名字哪怕 `truncate` 也会按内容宽参与折行。
            实测 272px：icon+名字+大小+三个图标按钮 = 236px > 可用 225px ⇒ 第三个按钮被挤到第二行（行高翻倍）。
            改成 basis 0 后名字按 0 参与折行、再长也只截断自己（整行 167px）。
            同时去掉原来的 `flex-1` 占位 span：它已无必要，名字自己就会吃掉剩余空间。 */}
        {/* 名字 + 大小**成组**放进那个 `flex-1` 容器：容器 basis 0（折行时按 0 计，再长也只截断自己），
            组内名字可截断、大小 `shrink-0` ⇒ 视觉上大小紧贴名字，而不会飘到右侧按钮旁边。 */}
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <p className="min-w-0 truncate text-sm font-medium" style={{ color: 'var(--ink)' }} title={target.name}>
            {target.name}
          </p>
          {!!target.size && (
            <span className="shrink-0 text-xs" style={{ color: 'var(--ink-muted)' }}>{formatSize(target.size)}</span>
          )}
          {/* 本体标识：这屏的波形是“整段录音”，不是某个片段；片段只是它上面的区间。 */}
          <span
            data-role="source-badge"
            className="shrink-0 self-center rounded-full px-1.5 py-0.5 text-10 font-medium"
            style={{
              color: 'var(--primary-strong)',
              backgroundColor: 'var(--primary-soft)',
              border: '1px solid color-mix(in oklab, var(--primary-strong) 20%, transparent)',
            }}
            title={
              origin
                ? 'A separate copy made from an excerpt. Editing it does not change the original recording.'
                : 'This is the full recording. Excerpts are ranges of it; the file itself is never modified.'
            }
          >
            {origin ? 'Excerpt copy' : 'Source audio'}
          </span>
        </span>
        {/* ── 时间轴缩放（只有大文件出现，`zoomable`）──────────────────────────────
            2026-10-12 按用户要求搬到**标题栏**：浮在波形上会压住数据区，波形下面单开一行又要占高度；
            标题栏是这一屏唯一的常驻行，控件放这里两头都不占。位置在**右侧动作组（Library / Import /
            Open）左边** —— 将来若有 History/Undo 之类的动作也进这一组，缩放天然就在它左侧。
            ⚠️ 状态与命令都归 `AudioMarkTrack`：这里只画控件（`trackView` 决定读数/置灰）、
               点击转成句柄调用（`playerRef.current?.zoomIn()` …）。 */}
        {trackView.zoomable && (
          <div
            className="flex shrink-0 items-center gap-0.5"
            data-role="zoom-bar"
            style={{ opacity: trackView.loading ? 0.6 : 1 }}
          >
            {/* 缩小 / 放大：`factor > 1 = 放大`（minPxPerSec 变大 = 窗口变窄），与滚轮同口径 */}
            <button
              type="button"
              onClick={() => playerRef.current?.zoomOut()}
              disabled={trackView.loading || !trackView.view}
              className="inline-flex shrink-0 items-center justify-center rounded p-0.5 transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ color: 'var(--ink-muted)' }}
              title={`Zoom out (min window ${VIEW_MIN_SEC}s)`}
              aria-label="Zoom out"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => playerRef.current?.zoomIn()}
              disabled={trackView.loading || (trackView.view ? trackView.view.sec <= VIEW_MIN_SEC : false)}
              className="inline-flex shrink-0 items-center justify-center rounded p-0.5 transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ color: 'var(--ink-muted)' }}
              title="Zoom in (or scroll on the waveform)"
              aria-label="Zoom in"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            {/* 平移 + 当前窗口长度（点它 = 整段适配 / Esc）。只在放大后出现 */}
            {trackView.view && (
              <>
                <button
                  type="button"
                  onClick={() => playerRef.current?.panBy(-0.5)}
                  className="inline-flex shrink-0 items-center justify-center rounded p-0.5 transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink-muted)' }}
                  title="Pan left (half a window)"
                  aria-label="Pan left"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => playerRef.current?.fitAll()}
                  className="inline-flex shrink-0 items-center justify-center rounded px-1.5 py-0.5 font-mono text-12 transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--primary-strong)' }}
                  title="Fit the whole audio (Esc)"
                >
                  {mmss(trackView.view.sec)}
                </button>
                <button
                  type="button"
                  onClick={() => playerRef.current?.panBy(0.5)}
                  className="inline-flex shrink-0 items-center justify-center rounded p-0.5 transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink-muted)' }}
                  title="Pan right (half a window)"
                  aria-label="Pan right"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            {/* 跟随播放头：长音频放大后播放，不跟随就"一播就出画" */}
            <button
              type="button"
              onClick={() => playerRef.current?.setFollow(!trackView.follow)}
              className="inline-flex shrink-0 items-center justify-center rounded p-0.5 transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: trackView.follow ? 'var(--primary-strong)' : 'var(--ink-faint)' }}
              title={trackView.follow ? 'Following the playhead (click to stop)' : 'Follow the playhead'}
              aria-label="Follow the playhead"
            >
              <Crosshair className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <button
          onClick={() => void openLibrary()}
          title="Browse the audio library"
          className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 transition-colors hover:bg-[var(--paper-hover)]"
          style={{ color: 'var(--ink-muted)' }}
          aria-label="Browse the audio library"
        >
          <LibraryIcon className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => importInputRef.current?.click()}
          disabled={importing}
          title="Import audio into the library"
          className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 transition-colors hover:bg-[var(--paper-hover)]"
          style={{ color: 'var(--ink-muted)' }}
          aria-label="Import audio into the library"
        >
          <Upload className="h-3.5 w-3.5" />
        </button>
        {/* 用系统默认程序打开源文件。标签只留 `Open`（全称进 title）：本行有三个动作，
            全称约 135px 会把标题栏在常用面板宽下就逼成两行；语义靠 ExternalLink 图标 + title 兜住。 */}
        {atRoot && !!target.path && (
          <button
            onClick={() => void handleOpen()}
            title="Open with default program"
            aria-label="Open with default program"
            className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink-muted)' }}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* 大屏两栏：左 = 波形/片段/打点，右 = 对话稿/建议/片段清单。
          窄屏（Hippo 最小窗口）退化为单栏滚动；非 wide（旧预览）保持原有单栏。 */}
      <div
        className={
          wide
            ? 'grid min-h-0 flex-1 gap-4 overflow-y-auto lg:overflow-visible lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]'
            : 'contents'
        }
      >
      <div className={wide ? 'flex min-h-0 flex-col gap-2 lg:overflow-y-auto lg:pr-1' : 'contents'}>
      {/*
        ── 播放器舞台（2026-10-12 方案 A+B）────────────────────────────────────────
        把"波形 + 刻度 + 走带 + 状态条 + 打点工具"整块收进一张**描边卡片**：
          · 只用 1px `--line` 描边 + 圆角，底色仍是 `--panel-bg`（主题规范：卡片中性、不用彩色底/投影）；
          · 里面的波形自带 `--surface-muted` 圆角底 ⇒ "卡中卡"的层次正好把主角托起来；
          · 横向内边距只给 `px-1.5`（6px）：`px-6` 那套"可用内容宽 = 面板宽 − 3rem"的实测**建立在根容器上**，
            这里再多吃 20px 会让控制行在窄面板更早折行 ⇒ 只留最小气口。
        ⚠️ 位移口径不变：卡片只包住**常驻**行（波形/状态条/打点工具），后两类本来就是"出现/消失允许推动"的那批。
      */}
      <div
        className="flex flex-col gap-2 rounded-lg px-1.5 py-2"
        data-role="player-stage"
        style={{ border: '1px solid var(--line)' }}
      >
        {/* 两轨共用一个 `relative` 容器：拖动时那条贯穿两轨的竖虚线要挂在它上面
            （线的横向位置 = 同一套窗口映射 ⇒ 在上轨与下轨里落在同一个 x）。
            包一层只为给虚线一个锚，`gap-2` 仍是原来两轨之间的距离 ⇒ 不改既有位移口径。 */}
        <div className="relative flex flex-col gap-2" data-role="tracks">
          <AudioMarkTrack
            key={target.path}
            ref={playerRef}
            srcUrl={playUrl}
            precomputed={precomputed}
            marks={marks}
            clipTitle={audioTitle(target.name)}
            busy={clipping}
            // 选中/拖动片段时，只把该区间点亮、其余压暗（"我在编辑哪一段"一眼可见）
            spotlight={spotlight}
            onAddMark={addMark}
            onMarksChange={changeMarks}
            onClip={clip}
            onReady={handleDuration}
            onTimeUpdate={handleTimeUpdate}
            suggestClipName={suggestNameForRange}
            onRequestClipName={requestClipName}
            onRequestWindowPeaks={requestWindowPeaks}
            onViewChange={setTrackView}
            onSelectionChange={handleSelectionChange}
            // 选中片段时，把“播放只到这一段”这条隐式边界显式化（chip 可 × 掉，恢复整段）
            playScope={
              activeClip
                ? { label: `Excerpt · ${mmss(activeClip.start)}–${mmss(activeClip.end)}`, onClear: clearPlayScope }
                : null
            }
          />

          {/* ── 片段区间带（2026-10-17 晚：从“第二音轨”改成“区间标注”）──────────────
              片段**不是**第二条音频：它是主音频上的一个命名区间（+ 一次导出）。
              所以这里不画实心音频块，只画一条区间带 —— 与上轨共用同一条时间轴，
              位置就是它在主音频里的出处：
                · 时间窗直接取自 `trackView.view`（上轨缩放/平移报上来的同一份）⇒ 两轨永远同轴；
                · 播放头用父级的 `playTime`（上轨 `onTimeUpdate` 报上来的同一份）；
                · 点块 = 选中（+ 跳到起点），点空白 = 跳到那一刻 **并退出选中**；
                · **选中的块两端有手柄**：拖它改区间，松手 → `updateRange` **只写清单**（不重切文件）。
              位置刻意留在播放器舞台卡片**内部**：波形 + 区间带合起来才是"这一段录音的编辑器"。 ── */}
          <div className="flex items-baseline justify-between gap-2" data-role="excerpt-lane-head">
            <span className="text-10 font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
              Excerpts{clips.length > 0 ? ` · ${clips.length}` : ''}
            </span>
            <span className="min-w-0 truncate text-10" style={{ color: 'var(--ink-faint)' }}>
              ranges of this recording
            </span>
          </div>
          <AudioClipTrack
            clips={clips}
            durationSec={audioTotalSec}
            view={trackView.view}
            playhead={playTime}
            activePath={activeClipPath}
            onSelect={selectClip}
            onClearSelect={clearClipSelection}
            onSeek={(t) => playerRef.current?.seek(t)}
            onRangeChange={updateRange}
            onDragGuide={setClipDrag}
            busy={clipping}
          />
          {/* 关系声明：一句话把“主音频 vs 片段”钉死。常驻、不可点 ⇒ text-10 + faint，不抢操作层。 */}
          <div
            className="flex items-start gap-1 text-10"
            data-role="excerpt-lane-note"
            style={{ color: 'var(--ink-muted)' }}
          >
            <Lock className="mt-0.5 h-2.5 w-2.5 shrink-0" style={{ color: 'var(--ink-faint)' }} />
            <span>Excerpts are ranges of this recording. The master audio is never modified.</span>
          </div>

          {/* 拖动时的竖虚线：**一条线贯穿两轨**（上轨的源波形也一起走 —— 用户要的"上面也跟着拖"）。
              位置由下轨上报的草稿（`clipDrag` 的 `edge` 那端）+ 同一套窗口映射算出 ⇒ 与上轨波形、下轨块**严格共线**。
              `pointer-events-none` + 高 z：纯视觉参照，既不挡手势，也不会盖住两轨自己的浮层逻辑；
              虚线（而非实线）以区别于播放头（实线）与打点线，一眼能分清"我在拖的那个边缘"。 */}
          {guideX != null && (
            <div
              data-role="drag-guide"
              data-guide-t={guideTime ?? ''}
              className="pointer-events-none absolute inset-y-0 border-l border-dashed"
              style={{
                left: `${guideX}%`,
                zIndex: 60,
                borderColor: 'color-mix(in oklab, var(--primary-strong) 70%, transparent)',
              }}
            />
          )}
        </div>

        {/* 「按打点切分」：它产出片段，本就属于区间带 ⇒ 收在带下（不再放回 `Excerpts` 页签，避免两处重复）。
            只在**至少两个打点**时出现（一个点切不出真正的一段）⇒ 其余时候零占用。 */}
        {marks.length >= 2 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1" />
            <button
              type="button"
              onClick={() => void splitAtMarks()}
              disabled={clipping || !target.path}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
              style={{ color: 'var(--primary-strong)' }}
              title={`Create ${marks.length + 1} excerpts, one per gap between the marks (each is exported now)`}
            >
              <Scissors className="h-3 w-3" />
              Split into {marks.length + 1} excerpts
            </button>
          </div>
        )}

        {/* 选中片段的动作行（播放 / 放大 / 改名 / 导出 / 删除）：贴着区间带，**选中哪块就给哪块**。
            只在**选中了某块**时出现 ⇒ 不选中就零占用（与"存在感越弱越靠下"的行序口径一致）。
            `Excerpts` 页签开着时**收起**：那边整张清单里已经有同一行（还带上下文），
            同屏重复两遍同一颗按钮只会让人犹豫点哪个。
            复用 `ClipRow`：播放/放大/改名/导出/删除五颗按钮的语义与护栏都在这儿。
            `onPlay` 把"选中即收束播放"改成明说的动作；`onExport` 先按当前区间现渲染再下载。
            `onZoom`（2026-10-17 新增，用户要求"一键放大到界面宽度"）：纯**视图**动作 ——
            只把时间轴缩到该区间的宽度，不 seek、不改选中（播放头与选中态都不动）。 */}
        {activeClip && !wide && activeDetailTab !== 'clips' && (
          <ClipRow
            active
            name={activeClip.name}
            sub={`${mmss(activeClip.start)}–${mmss(activeClip.end)}`}
            onClick={() => playerRef.current?.seek(activeClip.start)}
            onPlay={() => playClip(activeClip)}
            onZoom={
              trackView.zoomable
                ? () => playerRef.current?.zoomToRange({ start: activeClip.start, end: activeClip.end })
                : undefined
            }
            onTranscript={transcript ? () => void openClipAsMarkdown(activeClip) : undefined}
            onRename={(n) => void renameClip(activeClip.path, n)}
            onDownload={() => void exportClip(activeClip)}
            onFork={() => void forkClip(activeClip)}
            forkBusy={forkingPath === activeClip.path}
            onDelete={() => void removeClip(activeClip.path)}
          />
        )}

        {/* 状态条：紧跟触发它的波形控制行 —— 13 条文案里 11 条来自 track 动作
            （save_marks / 导出片段），放这里才紧邻产生它的那只手（原位置在片段清单之下）。
            `reserve` 让它无内容时也占一行 ⇒ 出现/消失不推动下方的片段清单。
            代价 = 无状态时留一行空白；若嫌空，去掉 reserve 即可（会恢复一行位移）。 */}
        <StatusLine note={note} reserve />

        {/* ── 打点工具行：撤销 / 清除自动点。**只在有东西可操作时出现**（其余时候零占用） ──
            刻意放在 `{marks}` 之后：它出现/消失允许推动下方内容（那已是既定取舍），
            但绝不能插到打点列表前面去推它（见 AudioMarkTrack 文件头的「行序口径」）。 */}
        {(markHistory.length > 0 ||
          marks.some((m) => m.auto) ||
          // 有"空批注 + 可回填源"时也要露面，否则那颗 Fill 按钮永远没有登场机会
          (marks.some((m) => !m.label && !m.auto) && (clips.length > 0 || (transcript?.segments?.length ?? 0) > 0))) && (
          <div className="flex flex-wrap items-center gap-2">
            {markHistory.length > 0 && (
              <button
                type="button"
                onClick={() => void undoMarks()}
                disabled={!target.path}
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
                style={{ color: 'var(--ink-muted)' }}
                title="Revert the last change to the marks"
              >
                <Undo2 className="h-3 w-3" />
                Undo marks
              </button>
            )}
            {/* 回填空批注：只在"确实有空批注点 且 有可用文本源"时出现（否则不摆一颗点了没用的按钮） */}
            {(() => {
              const empty = marks.filter((m) => !m.label && !m.auto).length;
              const hasSource = clips.length > 0 || (transcript?.segments?.length ?? 0) > 0;
              if (empty === 0 || !hasSource) return null;
              return (
                <button
                  type="button"
                  onClick={() => void fillEmptyLabels()}
                  disabled={!target.path}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
                  style={{ color: 'var(--ink-muted)' }}
                  title="Fill the empty mark labels from clip names / the transcript (only empty ones are touched; Undo still works)"
                >
                  <Sparkles className="h-3 w-3" />
                  Fill {empty} label{empty > 1 ? 's' : ''}
                </button>
              );
            })()}
            {marks.some((m) => m.auto) && (
              <button
                type="button"
                onClick={() => void clearAutoMarks()}
                disabled={!target.path}
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
                style={{ color: 'var(--ink-muted)' }}
                title="Remove the marks that were generated from the transcript (hand-made marks are kept)"
              >
                <Trash2 className="h-3 w-3" />
                Clear {marks.filter((m) => m.auto).length} auto
              </button>
            )}
          </div>
        )}
      </div>

      {wide && (
        <section className="flex flex-col gap-1" data-role="clips-side">
          <div className="flex items-baseline justify-between px-0.5">
            <span className="text-11 font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
              Excerpts · {clips.length}
            </span>
            <span className="text-10" style={{ color: 'var(--ink-faint)' }}>
              ranges of this recording
            </span>
          </div>
          {clipsList}
        </section>
      )}

      </div>
      <div className={wide ? 'flex min-h-0 flex-col gap-2' : 'contents'}>
      {/* ── 详情页签（2026-10-17 视觉双轨）──────────────────────────────────────
          把音轨下方的分区收成"一条常驻标签条 + 限高的内容区"：
          宽屏 = Transcript / Suggested（Excerpts 固定到左栏波形下方）；窄屏/旧预览才把 Excerpts 放回页签。
          只有 `Source` **不在其中**：上轨（波形）本身就是源 —— 没有"切回源"这一步，也就没有它自己的区块。
          `Clips` 与**下轨（片段轨）**是同一份数据的两个视图（清单 vs 时间轴上的位置），
          两边共用 `activeClipPath` ⇒ 点谁都是选中同一个片段，不会出现"清单说 A、轨道亮 B"。
          标签条**高度恒定一行**（行序不随"哪个分区有内容"变化）；宽屏只有 Transcript 一个页签时整条隐藏。
          **列表**单独限高滚动（`max-h-64`）⇒ 页面不再被 Suggested 无限撑长；
          转写页签不加 `overflow`（转写面板自带 `max-h-[70vh]` 滚动，且入口行的 `⋮` 菜单是 absolute ⇒ 加了会裁掉菜单）。
          当前页签失效时由 `activeDetailTab` 兜底回 Transcript（渲染期钳制，不开 effect）。
          ⚠️ 位移口径：标签条与内容区都在播放器舞台之下，本属"允许被推动"的那批。 ── */}
      {/* 大屏只有 Transcript 一个页签时，整条标签栏是纯负担：直接让稿子顶到栏顶。
          Suggested 有内容时才需要标签栏（Transcript / Suggested）。 */}
      {(!wide || detailTabAvailable.suggested) && (
      <div
        role="tablist"
        aria-label="Audio details"
        data-role="detail-tabs"
        className="flex flex-wrap items-center gap-0.5 rounded-lg p-0.5"
        style={{ backgroundColor: 'var(--paper-hover)' }}
      >
        {([
          ['transcript', 'Transcript'],
          ['suggested', `Suggested${highlights.length > 0 ? ` · ${highlights.length}` : ''}`],
          ['clips', `Excerpts${clips.length > 0 ? ` · ${clips.length}` : ''}`],
        ] as [DetailTab, string][])
          .filter(([key]) => detailTabAvailable[key])
          .map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={activeDetailTab === key}
              onClick={() => setDetailTab(key)}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-11 font-medium transition-colors"
              style={{
                backgroundColor: activeDetailTab === key ? 'var(--panel-bg)' : 'transparent',
                color: activeDetailTab === key ? 'var(--ink-strong)' : 'var(--ink-muted)',
              }}
            >
              {label}
            </button>
          ))}
      </div>
      )}

      {/* 转写页签内容。**这一页签刻意不加 `overflow`** —— 转写面板自带 `max-h-[70vh]` 滚动，
          高度本就有限（不受句子数影响）；而入口行的 `⋮` 菜单是 `absolute` 定位，一旦外层有了
          `overflow-y-auto`（x 轴会被一并算成 auto）就会被裁掉。限高与滚动只加在**列表型页签**上。 */}
      {activeDetailTab === 'transcript' && (
      <div
        className={wide ? 'flex min-h-0 flex-1 flex-col gap-1' : 'flex flex-col gap-1'}
        data-role="transcript-section"
      >
        {/* 没有稿子时才显示主入口；有稿子后入口收进面板的 ⋯，头部只剩 Transcript + ⋯ */}
        {!!target.path && !transcript && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void transcribe()}
            disabled={transcribing || !target.path}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
            style={{ color: 'var(--primary-strong)' }}
            title={
              audioTotalSec > 1800
                ? `This recording is ${Math.round(audioTotalSec / 60)} min — it will be transcribed in ${Math.ceil(audioTotalSec / 1200)} parts and may take several minutes`
                : 'Transcribes with speaker separation, then polishes the dialogue with DeepSeek'
            }
          >
            {transcribing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {transcribing ? 'Transcribing…' : 'Understand this audio'}
          </button>
          {/*
            P2-1（2026-10-11 九轮）：原来 `Understand this audio` / `Selection only` / `Separate speakers`
            三个控件平铺占用一整行，而**后两个是低频选项** —— 收进 `⋮` 菜单后本行只剩一个主操作，
            视线落点回到"转写"本身。菜单绝对定位 ⇒ 开合不推动任何行（沿用既有 `pointerdown` + `contains` 范式）。
          */}
          <div ref={transcribeMenuRef} className="relative shrink-0">
          <button
            ref={transcribeMenuBtnRef}
            type="button"
            onClick={() => {
              // 打开时**快照**当前选区：选区状态归 AudioMarkTrack 所有，父级只在开菜单这一刻需要它
              setSelSnapshot(playerRef.current?.getSelection() ?? null);
              setTranscribeMenu((v) => !v);
            }}
            disabled={transcribing || !target.path}
            aria-label="Transcription options"
            aria-expanded={transcribeMenu}
            className="inline-flex shrink-0 items-center justify-center rounded-md p-1 transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
            style={{ color: 'var(--ink-muted)' }}
            title="Transcription options"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>
          {transcribeMenu && (
            <div
              className="absolute left-0 top-full z-40 mt-1 flex w-56 flex-col gap-1 rounded-md p-1.5"
              style={{ backgroundColor: 'var(--panel-bg)', border: '1px solid var(--line)', boxShadow: '0 4px 16px rgba(0,0,0,0.10)' }}
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setTranscribeMenu(false);
                  void transcribeSelection();
                }}
                disabled={transcribing || !selSnapshot}
                className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:text-[var(--ink-faint)] disabled:hover:bg-transparent"
                style={{ color: 'var(--primary-strong)' }}
                title={
                  selSnapshot
                    ? 'Transcribe only the selected range'
                    : 'Drag a range on the waveform first — this transcribes only that part'
                }
              >
                <Scissors className="h-3 w-3" />
                Selection only
              </button>
              {/* 默认即最优解：不在这里摆说话人/人数开关。
                  转写会自动分离说话人；润色是**手动**入口（⋯ → Polish），只有"没分出说话人"时才在稿子下方给一次 2 人重试。 */}
              <p className="px-1.5 text-10" style={{ color: 'var(--ink-faint)' }}>
                Includes speaker separation. DeepSeek polish is available from the ⋯ menu. Long recordings can take a few minutes.
              </p>
            </div>
          )}
          </div>
        </div>
      )}

      {/* 转写面板：**排在所有持久行之后**，自带滚动 ⇒ 展开/收起不推走打点列表 */}
      {transcript && (
        <TranscriptPanel
          transcript={transcript}
          time={playTime}
          highlightRange={selRange}
          busy={transcribing || rediarizing || aiBusy || clipping || polishing}
          onSeek={handleSeek}
          onHighlights={() => void runHighlights()}
          // 原地改一句文字（正文即输入框，点正文落光标；Enter 保存）；服务端 `action:'save_transcript'`
          onUpdateSegment={editSegmentText}
          // 点时间戳旁的编辑入口可改这一句的起点（服务端 `action:'save_segment_time'`）
          onUpdateSegmentTime={editSegmentTime}
          // 润色轮的原地改字：写回 sidecar 的 `polished.turns`，原文保持不动
          onUpdatePolishedTurn={editPolishedTurn}
          // 在某一行下面插入一条对话（时间默认当前播放头）；服务端两个纯函数会双向同步原文/润色稿
          onInsertSegment={(afterIndex, line) => insertTranscriptLine('insert_segment', afterIndex, line)}
          onInsertPolishedTurn={(afterIndex, line) => insertTranscriptLine('insert_polished_turn', afterIndex, line)}
          // 删除某一行（插入的逆操作）：对侧"时间+文字全等"的一行由服务端一并删掉
          onDeleteSegment={(index) => deleteTranscriptLine('delete_segment', index)}
          onDeletePolishedTurn={(index) => deleteTranscriptLine('delete_polished_turn', index)}
          // 行级 AI 润色：只润这一行、结果先当草稿（Enter 落盘 / Esc 还原）
          onPolishText={polishLineText}
          // 说话人手工纠正：改一轮归属（`assign_speaker`）/ 给一簇起名（`rename_speaker`）/
          // 集中批量起名（`rename_speakers`，⋯ 菜单里那个面板）—— 三条路径各自乐观上屏与回滚
          //（打点/片段按时间存，改归属不会让它们失位）
          onUpdateSpeaker={assignSpeaker}
          onRenameSpeaker={renameSpeaker}
          onRenameSpeakers={renameSpeakers}
          // DeepSeek 润色（DSH 任务模型）：只改 text，原文仍可切回
          polished={polished}
          onPolish={() => void polishTranscript()}
          polishing={polishing}
          polishProgress={polishProgress}
          onRetranscribe={retranscribe}
          onTranscribeSelection={() => void transcribeSelection()}
          hasSelection={!!selRange}
          transcribing={transcribing}
          wide={wide}
          onOpenMarkdown={(variant) => void openAsMarkdown(variant)}
          // 没有说话人标签时的一键重试：强制 duo（CLI 2 簇 + 服务端不再声纹合并）
          onRetrySpeakers={retryAsDuo}
          // 这一页签本身已把门（父级只在 `activeDetailTab === 'transcript'` 时渲染本面板）
          // ⇒ 进来就该是展开的稿子，不再让用户"进了页签还要再点一下"
          defaultOpen
        />
        )}
      </div>
      )}

      {/* AI 精选建议：**只是建议** —— 勾选后点 Export 才落盘成片段、点 Mark 才落到音轨上（绝不自动落）。
          原来自成一区（小号大写标题 + 细线 + 气口）；标题退位成 Suggested 页签后，这里只留 Export / Mark / Dismiss 行。 */}
      {activeDetailTab === 'suggested' && (
      <div className="flex flex-col gap-0.5" data-role="suggested-section">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void exportHighlights()}
              disabled={clipping || highlightSel.size === 0}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
              style={{ color: 'var(--primary-strong)' }}
            >
              <Scissors className="h-3 w-3" />
              Export {highlightSel.size}
            </button>
            {/* 把勾选的建议落成**音轨上的点**（青色，见 AudioMarkTrack）：原来只在 Suggested 页签里
                躺着，音轨上却看不见；落点后就能接着 `Split at marks` 切段，或自己拖选再截。
                手打点一律保留（纯函数 `marksFromRanges` 只追加以 `auto` 位标记的点）⇒ 随时可撤销。 */}
            <button
              type="button"
              onClick={() => void markHighlights()}
              disabled={clipping || highlightSel.size === 0}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
              style={{ color: 'var(--mark-line-ai)' }}
              title="Put a mark at the start of each selected suggestion (hand-made marks are kept; undo later with Clear auto marks)"
            >
              <Bookmark className="h-3 w-3" />
              Mark {highlightSel.size}
            </button>
            <button
              type="button"
              onClick={() => {
                setHighlights([]);
                setHighlightSel(new Set());
              }}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-12 font-medium transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink-muted)' }}
            >
              <X className="h-3 w-3" />
              Dismiss
            </button>
          </div>
          {/* 只有**列表**单独成滚动区（`max-h-64`）：上面那行动作留在区外，滚到底也不会被卷走 */}
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {highlights.map((h, i) => (
            <div key={`${h.start}-${i}`} className="flex items-start gap-1.5 rounded-md px-2.5 py-1.5">
              <input
                type="checkbox"
                checked={highlightSel.has(i)}
                onChange={() =>
                  setHighlightSel((cur) => {
                    const next = new Set(cur);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    return next;
                  })
                }
                className="mt-0.5 shrink-0"
              />
              <button
                type="button"
                onClick={() => playerRef.current?.seek(h.start)}
                className="shrink-0 font-mono text-10 transition-colors hover:text-[var(--primary-strong)]"
                style={{ color: 'var(--ink-muted)' }}
                title="Jump to this suggestion"
              >
                {fmtTime(h.start)}–{fmtTime(h.end)}
              </button>
              <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--ink)' }} title={h.reason}>
                {h.title}
              </span>
            </div>
          ))}
          </div>
        </div>
      )}

      {/* 窄屏 Excerpts 页签；宽屏已在左栏常驻（见 clipsList） */}
      {!wide && activeDetailTab === 'clips' && clipsList}
      </div>
      </div>
    </div>
  );
}
