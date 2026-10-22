/**
 * 通用音频截取 + 打点 API（画布音频查看器用）。
 *
 * 与会议路由的 clip_audio / save_marks 分工：
 *   - 会议路由的版本走 loadReplay（先读转写 .md 再按 bob-audio 指针找音频），
 *     只认识会议产物那套命名约定与指针格式；
 *   - 本路由接受**任意音频文件路径**（materials/foo.mp3、截出来的 片段-….webm 等），
 *     直接对文件做 ffmpeg 截取、打点写在应用自有目录的 .marks.json 里
 *     （库内音频就地、库外音频进影子目录，见 lib/audio/library.ts 的 marksFileFor）。
 *
 * 截取产物落在**源音频的库目录** `<APP_ROOT>/.audio-library/<源名>-<指纹>/`（**不进 workspace**，
 * 见 lib/audio/library.ts）：主名默认 `片段 - <标题> - <起-止>`（请求里带 name 则可自定义），
 * 扩展名跟随**源容器**（见 lib/audio/clip.ts —— 不再一律写 .webm，否则 mp3 源只能重编码）。
 * 成功后在源目录的 `.clips.json` 记一条 lineage（改名也不丢归属），并随响应回传最新清单；
 * 用户在界面上「下载」片段即可把它另存到自己的位置。
 *
 * 库浏览 / 管理：`list_library` 列出所有库内音频（仅含 source.* 的目录），
 * `delete_library` 删除某源音频的整个目录（源 + 打点 + 片段 + 清单一并清理），
 * `rename_clip` 重命名某个片段（改磁盘文件名 + 同步清单），
 * `update_clip_range` **只改清单里的 start/end**（不跑 ffmpeg、不覆写文件 —— 区间是唯一真源），
 * `reclip` 按当前区间**现渲染**一次片段文件（导出/下载前调用，保证文件与区间一致），
 * `delete_clip` 删除某个片段（删文件 + 它的打点 + 从清单移除）。
 *
 * 库分组：`list_groups` / `create_group` / `rename_group` / `delete_group` / `assign_group`
 * 维护用户自建的分组与条目归属（状态落盘 `.audio-library/.groups.json`，见 lib/audio/groups.ts）；
 * 删除条目时其归属一并抹掉。
 *
 * 转写稿：`load_transcript` 读 sidecar、`transcribe` 生成、`save_transcript` **只改一句文字**
 * （原地编辑：不跑 STT、不动 `t`/`end`/`speaker`；校验规则与前端共用 `updateSegmentText`）；
 * 说话人手工纠正三条路：`assign_speaker` 改**一批段**的归属、`rename_speaker` 改一个显示名、
 * `rename_speakers` 批量改显示名（一次读改写，见各自的说明）。
 *
 * 波形数据：`peaks` 返回该音频的波形峰值（带 `.peaks.json` 缓存），供前端交给 WaveSurfer
 * 直接绘制——**免掉「整份下载」与「全量解码」**，这是长录音不再吃掉几百 MB 内存的关键
 * （原理、实测与三态返回口径见 lib/audio/peaks.ts）。
 *
 * 路径安全：project 侧必须落在当前项目根内（越界即抛）；local 侧允许任意本地路径
 * （与 /api/local-files 的「人类 UI 侧自由读」同口径），但一律要求音频扩展名。
 */
import { NextRequest, NextResponse } from 'next/server';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promises as fs } from 'node:fs';
import { getCurrentProject } from '@/lib/project/project-manager';
import { upsertClipRef, readMarksFile, writeMarksFile, type AudioMark, type AudioClipRef } from '@/lib/audio/marks';
import {
  deleteShadowDir,
  listShadowDirs,
  sourceDir,
  readClips,
  writeClips,
  listLibrary,
  deleteEntry,
  renameClip,
  deleteClip,
  marksFileFor,
  transcriptFileFor,
  readTranscriptFile,
  writeTranscriptFile,
  importFileToLibrary,
  readOrigin,
  writeOrigin,
} from '@/lib/audio/library';
import {
  assignEntry,
  createGroup,
  deleteGroup,
  forgetEntry,
  readGroupState,
  renameGroup,
} from '@/lib/audio/groups';
import type { AudioOrigin } from '@/lib/audio/origin';
import { audioTitle, clipBaseName, safeBaseName, AUDIO_EXTS } from '@/lib/audio/naming';
import { clipAudio } from '@/lib/audio/clip';
import {
  ensureFinePeaks,
  generatePeaks,
  readPeaksCache,
  writePeaksCache,
  PEAKS_BUCKETS,
  PEAKS_MIN_BYTES,
  PEAKS_MIN_WINDOW_SEC,
} from '@/lib/audio/peaks';
import { sliceFineWindow } from '@/lib/audio/peaks-codec';
import {
  segmentsForEditor,
  insertPolishedTurnAfter,
  insertSegmentAfter,
  deletePolishedTurn,
  deleteSegment,
  updateSegmentText,
  updateSegmentStart,
  updatePolishedTurnText,
  updateSegmentSpeakers,
  updateSpeakerName,
  updateSpeakerNames,
  MAX_SPEAKER_NAMES,
  validRange,
  isTranscriptPolish,
  TRANSCRIPT_VERSION,
  type AudioTranscript,
} from '@/lib/audio/transcript';
import { clampWindowSec, mergeSegments, planWindows, runWindows } from '@/lib/audio/windowed';
import { hasTranscriptInRange, transcriptToMarkdown, type TranscriptMarkdownRange } from '@/lib/audio/markdown';
import { ensureDiarization, speakerForRange, type DiarMode } from '@/lib/stt/diarize';
import { parseProjectRoot } from '@/lib/parse/project-root';

/**
 * 路由时限。转写是这条路由里唯一的**分钟级**动作，而**窗口化的长音频会更久**
 * （57 分钟录音 ⇒ 3 个 20 分钟窗口，云端 STT 逐个跑）。给 1800s，与
 * `api/butler/meeting/route.ts:634` 同口径 —— 那条路由跑的是同一类活（会议整段重转）。
 *
 * 即便如此也**不能假设一次就能跑完**：每完成一窗都会增量写 sidecar（`partial` + `coveredUntilSec`），
 * 请求真被掐断时前端能接着跑，而不是从头再花一次钱。
 */
export const maxDuration = 3600; // 3.6h 长音频分段分离 + 长转写可能超过 30 分钟

/** 单次批量截取的区间数上限（防误触跑成几分钟的串行 ffmpeg 队列） */
const MAX_CLIP_BATCH = 20;
/** 一轮发言的段数上限（超长独白也只几百段；`assign_speaker` 用它挡住畸形请求） */
const MAX_TURN_SEGMENTS = 2000;
/** 单个区间的最短跨度（与单区间 `clip` 分支同口径） */
const MIN_CLIP_SPAN_SEC = 0.1;

/** 路径解析（~ 展开为主目录；与 /api/local-files 的 resolvePath 同口径） */
function expandPath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return resolve(input);
}

/**
 * 解析音频路径并做安全校验（越界/非音频即抛）：
 * - project：必须落在**当前项目根**内（不许跨出项目）；
 * - local  ：允许任意本地路径 —— 与 /api/local-files 的「人类 UI 侧：任意本地路径自由读」同口径
 *   （画布「电脑目录」里的音频本来就是用户自己挑的任意路径，限死在 butlerRoot 会让
 *   本地音频的打点/截取静默失败）。非音频扩展名一律拒绝，收窄这个口子的能力。
 */
async function resolveAudio(source: 'local' | 'project', rel: string): Promise<string> {
  const raw = String(rel || '').trim();
  if (!raw) throw new Error('path is required');
  if (source === 'project') {
    const root = (await getCurrentProject()).path;
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw.replace(/^\/+/, ''));
    if (abs !== root && !abs.startsWith(root + '/')) throw new Error('path escapes the project root');
    return abs;
  }
  const abs = expandPath(raw);
  if (!AUDIO_EXTS.includes(extname(abs).toLowerCase())) throw new Error('only audio files are supported');
  return abs;
}

/**
 * 统一入口：把 action 主体包进 try/catch。
 *
 * 为什么需要：各 action 分支只对「解析路径」做了小 catch，**写入类操作抛出的 I/O 错误会一路
 * 冒到框架层**（典型：`save_marks` 的 `writeMarksFile` ENOENT）。那时返回的是框架的 HTML 错误页
 * 而非 JSON，客户端 `resp.json()` 直接抛 ⇒ 拿不到任何原因 ⇒ 表现为**打点静默丢失**。
 *
 * 兜成 `{success:false, error}` + 500：状态码如实反映**服务端故障**，响应体仍是 JSON，
 * 客户端能把原因显示出来。与兄弟路由 `api/local-files` 的兜底口径一致（见该文件 :1020-1024）。
 */
export async function POST(req: NextRequest) {
  try {
    return await handlePost(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('audio/clip POST error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

/**
 * 导出**一个**区间（`clip` 与 `clip_many` 共用）。
 *
 * 刻意**不写片段清单**：lineage（`.clips.json`）由调用方在拿到全部结果后统一 upsert + 写一次，
 * 否则批量导出会变成 N 次读改写同一份 JSON（既慢又给并发覆盖留门）。
 * 返回的 ref 带真实落盘名（扩展名由源容器决定，见 lib/audio/clip.ts）。
 */
async function exportOneClip(
  ffmpegPath: string,
  srcAbs: string,
  dir: string,
  title: string,
  range: { startSec: number; endSec: number; name?: string },
): Promise<AudioClipRef> {
  // 用户在点 Clip 时可以先改名；空/非法回退默认名
  const base = safeBaseName(String(range.name || '')) || clipBaseName(title, range.startSec, range.endSec);
  const outAbs = await clipAudio(ffmpegPath, srcAbs, range.startSec, range.endSec, resolve(dir, base));
  return { path: outAbs, name: basename(outAbs), start: range.startSec, end: range.endSec };
}

/** 批量导出里单条的结果（成功带文件名与区间，失败带原因 —— **绝不静默跳过**） */
interface ClipBatchResult {
  ok: boolean;
  name?: string;
  start?: number;
  end?: number;
  error?: string;
}

async function handlePost(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');

  // ---- 截取片段 ----
  if (action === 'clip') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    const startSec = Number(body.startSec);
    const endSec = Number(body.endSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec - startSec < MIN_CLIP_SPAN_SEC) {
      return NextResponse.json({ success: false, error: 'a clip needs a valid range (at least 0.1s)' });
    }

    let srcAbs: string;
    try {
      srcAbs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const { resolveFfmpegPath } = await import('@/lib/parse/audio-parser');
    const ffmpegPath = await resolveFfmpegPath();
    if (!ffmpegPath) return NextResponse.json({ success: false, error: 'ffmpeg is unavailable' });

    // 落点：源音频的库目录（源 + 打点 + 片段同居一处，见 lib/audio/library.ts）
    const dir = await sourceDir(srcAbs, true);
    const title = audioTitle(basename(srcAbs));
    let ref: AudioClipRef;
    try {
      ref = await exportOneClip(ffmpegPath, srcAbs, dir, title, {
        startSec,
        endSec,
        name: String(body.name || ''),
      });
    } catch {
      return NextResponse.json({ success: false, error: 'ffmpeg failed to export this clip' });
    }
    const stat = await fs.stat(ref.path).catch(() => null);
    // 记 lineage：把片段挂到**源音频**的 .clips.json 上（改名也不丢归属），随响应回传最新清单
    const clips = upsertClipRef(await readClips(srcAbs), ref);
    await writeClips(srcAbs, clips);
    return NextResponse.json({
      success: true,
      clip: {
        path: ref.path,
        name: ref.name,
        size: stat?.size ?? 0,
      },
      clips,
    });
  }

  // ---- 只改片区间的元数据（区间带拖两端）----
  //
  // 2026-10-17 晚（一主多摘）：**区间是唯一真源**。本动作只写 `.clips.json` 的 start/end，
  // 不碰 ffmpeg、不覆写片段文件 —— 拖拽因而是瞬时的，也不会把用户已经导出/分享过的文件悄悄换掉。
  // 文件由 `reclip` 在**导出时**按当前区间现渲染（见 AudioViewer.exportClip）。
  if (action === 'update_clip_range') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    const clipPath = String(body.clipPath || '').trim();
    if (!rel || !clipPath) return NextResponse.json({ success: false, error: 'path is required' });
    const startSec = Number(body.startSec);
    const endSec = Number(body.endSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec - startSec < MIN_CLIP_SPAN_SEC) {
      return NextResponse.json({ success: false, error: 'an excerpt needs a valid range (at least 0.1s)' });
    }

    let srcAbs: string;
    try {
      srcAbs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    // 只允许改**该源音频自己库目录里**的片段：挡住"拿这个动作改任意清单"
    const dir = await sourceDir(srcAbs, true);
    if (!resolve(clipPath).startsWith(resolve(dir) + '/')) {
      return NextResponse.json({ success: false, error: 'this excerpt does not belong to that audio' });
    }

    const clips = await readClips(srcAbs);
    const existing = clips.find((c) => c.path === clipPath);
    if (!existing) return NextResponse.json({ success: false, error: 'unknown excerpt' });

    // 与 reclip / clip_many 同一套边界判据（含 0.5s 上界容差，见 transcript.ts 的 validRange 注释）
    const { probeAudioDurationSec } = await import('@/lib/parse/audio-parser');
    const durationSec = await probeAudioDurationSec(srcAbs);
    const ok = validRange(startSec, endSec, durationSec, MIN_CLIP_SPAN_SEC);
    if (!ok) {
      return NextResponse.json({
        success: false,
        error: endSec - startSec < MIN_CLIP_SPAN_SEC ? 'an excerpt needs a valid range (at least 0.1s)' : 'range is outside the audio',
      });
    }

    const next = upsertClipRef(clips, { ...existing, start: ok.start, end: ok.end });
    await writeClips(srcAbs, next);
    return NextResponse.json({
      success: true,
      clip: { ...existing, start: ok.start, end: ok.end },
      clips: next,
    });
  }

  // ---- 重切已有片段（导出/下载前现渲染）----
  //
  // 与 `clip` 的分工：`clip` **新建**一个片段（拖个区间 → 起个名 → 落一个新文件）；
  // 本动作按**当前区间**再从源音频切一次、覆写同一个文件（path 不变 ⇒ 身份/名字/归属都不动），
  // 并把 `.clips.json` 里那一条的 start/end 同步掉。
  // 2026-10-17 晚起它**不再**是"拖两端"的落点：拖动只走 `update_clip_range`；
  // 本动作只在导出/下载前调用，保证用户拿到的文件与屏幕上的区间一致。
  if (action === 'reclip') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    const clipPath = String(body.clipPath || '').trim();
    if (!rel || !clipPath) return NextResponse.json({ success: false, error: 'path is required' });
    const startSec = Number(body.startSec);
    const endSec = Number(body.endSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec - startSec < MIN_CLIP_SPAN_SEC) {
      return NextResponse.json({ success: false, error: 'a clip needs a valid range (at least 0.1s)' });
    }

    let srcAbs: string;
    try {
      srcAbs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    // 只允许重切**该源音频自己库目录里**的片段：挡住"拿这个动作覆写任意文件"
    const dir = await sourceDir(srcAbs, true);
    if (!resolve(clipPath).startsWith(resolve(dir) + '/')) {
      return NextResponse.json({ success: false, error: 'this clip does not belong to that audio' });
    }

    const { resolveFfmpegPath, probeAudioDurationSec } = await import('@/lib/parse/audio-parser');
    const ffmpegPath = await resolveFfmpegPath();
    if (!ffmpegPath) return NextResponse.json({ success: false, error: 'ffmpeg is unavailable' });
    // 与 clip_many 同一套边界判据（含上界容差，见 transcript.ts 的 validRange 注释）
    const durationSec = await probeAudioDurationSec(srcAbs);
    const ok = validRange(startSec, endSec, durationSec, MIN_CLIP_SPAN_SEC);
    if (!ok) {
      return NextResponse.json({
        success: false,
        error: endSec - startSec < MIN_CLIP_SPAN_SEC ? 'a clip needs a valid range (at least 0.1s)' : 'range is outside the audio',
      });
    }

    // 覆写同路径：片段扩展名本就跟随源容器 ⇒ 去掉旧扩展名即得 base，切完的落点正是旧路径
    const outBase = clipPath.slice(0, clipPath.length - extname(clipPath).length);
    let outAbs: string;
    try {
      outAbs = await clipAudio(ffmpegPath, srcAbs, ok.start, ok.end, outBase);
    } catch {
      return NextResponse.json({ success: false, error: 'ffmpeg failed to re-cut this clip' });
    }
    // 容器/扩展名与预期不符（本不该发生）：清掉误建的文件，绝不留下孤儿
    if (outAbs !== clipPath) {
      await fs.rm(outAbs, { force: true }).catch(() => {});
      return NextResponse.json({ success: false, error: 'could not re-cut this clip' });
    }

    const clips = upsertClipRef(await readClips(srcAbs), {
      path: clipPath,
      name: basename(clipPath),
      start: ok.start,
      end: ok.end,
    });
    await writeClips(srcAbs, clips);
    const stat = await fs.stat(clipPath).catch(() => null);
    return NextResponse.json({
      success: true,
      clip: { path: clipPath, name: basename(clipPath), size: stat?.size ?? 0, start: ok.start, end: ok.end },
      clips,
    });
  }

  // ---- 把片段 fork 成独立主音频（显式“单独编辑”入口）----
  //
  // 关系口径（一主多摘）：片段默认只是主音频上的区间；要给它自己的波形/打点/转写/再切，
  // 必须**显式**复制成一条新的主音频 —— 原录音一字不动，新音频在库里是独立条目，并写 `.origin.json`。
  //
  // 为什么从**源音频**重新渲染、而不是直接复制片段的缓存文件：片段区间可能刚被拖过、缓存还是旧内容；
  // 从源 + 当前区间切一次，保证 fork 出来的是屏幕上看到的那一段。
  if (action === 'fork_clip') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    const clipPath = String(body.clipPath || '').trim();
    if (!rel || !clipPath) return NextResponse.json({ success: false, error: 'path is required' });

    let srcAbs: string;
    try {
      srcAbs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    // 只允许 fork **该源音频自己库目录里**的片段
    const dir = await sourceDir(srcAbs, true);
    if (!resolve(clipPath).startsWith(resolve(dir) + '/')) {
      return NextResponse.json({ success: false, error: 'this excerpt does not belong to that audio' });
    }
    const clips = await readClips(srcAbs);
    const ref = clips.find((c) => c.path === clipPath);
    if (!ref) return NextResponse.json({ success: false, error: 'unknown excerpt' });

    const { resolveFfmpegPath, probeAudioDurationSec } = await import('@/lib/parse/audio-parser');
    const ffmpegPath = await resolveFfmpegPath();
    if (!ffmpegPath) return NextResponse.json({ success: false, error: 'ffmpeg is unavailable' });
    const durationSec = await probeAudioDurationSec(srcAbs);
    const ok = validRange(ref.start, ref.end, durationSec, MIN_CLIP_SPAN_SEC);
    if (!ok) return NextResponse.json({ success: false, error: 'range is outside the audio' });

    const base = safeBaseName(audioTitle(basename(clipPath))) || 'excerpt';
    // 临时目录放在源目录里（同一卷，入库时 rename 最快；异常时 finally 清掉）
    const tmpDir = await fs.mkdtemp(join(dir, '.fork-'));
    let outAbs: string;
    try {
      outAbs = await clipAudio(ffmpegPath, srcAbs, ok.start, ok.end, join(tmpDir, base));
    } catch {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return NextResponse.json({ success: false, error: 'ffmpeg failed to make a separate audio' });
    }

    try {
      const displayName = audioTitle(basename(outAbs));
      const newSource = await importFileToLibrary(basename(outAbs), outAbs);
      const origin: AudioOrigin = {
        source,
        sourcePath: srcAbs,
        sourceName: String(body.sourceName || audioTitle(basename(srcAbs))).slice(0, 160),
        start: ok.start,
        end: ok.end,
        createdAt: new Date().toISOString(),
      };
      await writeOrigin(newSource, origin);
      return NextResponse.json({ success: true, path: newSource, name: displayName, origin });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ---- 批量截取（按句 / 按打点切分 / AI 精选都走这里）----
  // 口径三条：
  //   ① 单条失败**不影响其余**（逐条 ffmpeg，逐条回执），只要有一条成功就算成功；
  //   ② 越界/倒置的区间**直接拒绝**，不做边界钳位（钳位会把客户端的算错悄悄吞掉）；
  //   ③ 清单只在末尾写一次（见 exportOneClip 的注释）。
  if (action === 'clip_many') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    const ranges: unknown[] = Array.isArray(body.ranges) ? body.ranges : [];
    if (ranges.length === 0) return NextResponse.json({ success: false, error: 'ranges is required' });
    if (ranges.length > MAX_CLIP_BATCH) {
      return NextResponse.json({ success: false, error: `too many ranges (max ${MAX_CLIP_BATCH} per request)` });
    }

    let srcAbs: string;
    try {
      srcAbs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const { resolveFfmpegPath, probeAudioDurationSec } = await import('@/lib/parse/audio-parser');
    const ffmpegPath = await resolveFfmpegPath();
    if (!ffmpegPath) return NextResponse.json({ success: false, error: 'ffmpeg is unavailable' });

    // 时长只用于**越界拒绝**；探测失败（null）时不做上界校验，其余校验照旧
    const durationSec = await probeAudioDurationSec(srcAbs);
    const dir = await sourceDir(srcAbs, true);
    const title = audioTitle(basename(srcAbs));

    let clips = await readClips(srcAbs);
    const results: ClipBatchResult[] = [];
    for (const raw of ranges) {
      const r = (raw ?? {}) as { startSec?: unknown; endSec?: unknown; name?: unknown };
      const startSec = Number(r.startSec);
      const endSec = Number(r.endSec);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
        results.push({ ok: false, error: 'invalid range (needs at least 0.1s)' });
        continue;
      }
      // 边界校验走与 AI 精选**同一个纯函数**（含 0.5s 上界容差的原因见 transcript.ts 的 validRange 注释）：
      // 两处各写一遍"越界算不算越界"，迟早会漂成两个口径。
      const ok = validRange(startSec, endSec, durationSec, MIN_CLIP_SPAN_SEC);
      if (!ok) {
        results.push({
          ok: false,
          error: endSec - startSec < MIN_CLIP_SPAN_SEC ? 'invalid range (needs at least 0.1s)' : 'range is outside the audio',
        });
        continue;
      }
      try {
        const ref = await exportOneClip(ffmpegPath, srcAbs, dir, title, {
          startSec: ok.start,
          endSec: ok.end,
          name: typeof r.name === 'string' ? r.name : '',
        });
        clips = upsertClipRef(clips, ref);
        results.push({ ok: true, name: ref.name, start: ref.start, end: ref.end });
      } catch {
        results.push({ ok: false, error: 'ffmpeg failed to export this range' });
      }
    }

    const exported = results.filter((r) => r.ok).length;
    if (exported > 0) await writeClips(srcAbs, clips);
    return NextResponse.json({
      success: exported > 0,
      ...(exported > 0 ? {} : { error: 'no range could be exported' }),
      exported,
      failed: results.length - exported,
      clips,
      results,
    });
  }

  // ---- 读片段清单 ----
  if (action === 'load_clips') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const clips = await readClips(abs);
    // fork 来源：没有就是 null；前端据此显示 `‹ 原录音 · 00:12–00:48` 面包屑
    const origin = await readOrigin(abs);
    return NextResponse.json({ success: true, clips, origin });
  }

  // ---- 读波形峰值（peaks）----
  // 前端拿它交给 WaveSurfer：**同时**免掉「整份下载」与「全量解码」两条昂贵路径
  // （原理与实测见 lib/audio/peaks.ts 文件头）。三态返回，调用方据此选加载方式：
  //   - { success, peaks, duration } → 播放走代理 URL 的 HTTP Range，内存只剩峰值数组
  //   - { success, small: true }     → 文件太小，走原来的「整份抓 Blob」更划算
  //   - { success: false }           → 分析不出来（无音轨/ffmpeg 不可用），前端同样退回 Blob
  if (action === 'peaks') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return NextResponse.json({ success: false, error: 'file not found' });
    if (stat.size < PEAKS_MIN_BYTES) {
      return NextResponse.json({ success: true, small: true });
    }

    const cached = await readPeaksCache(abs, stat);
    if (cached) {
      return NextResponse.json({ success: true, peaks: cached.peaks, duration: cached.duration, cached: true });
    }

    const { resolveFfmpegPath } = await import('@/lib/parse/audio-parser');
    const ffmpegPath = await resolveFfmpegPath();
    if (!ffmpegPath) return NextResponse.json({ success: false, error: 'ffmpeg is unavailable' });

    const result = await generatePeaks(ffmpegPath, abs, PEAKS_BUCKETS);
    if (!result) return NextResponse.json({ success: false, error: 'could not analyse this audio' });
    await writePeaksCache(abs, stat, result, PEAKS_BUCKETS);
    return NextResponse.json({ success: true, peaks: result.peaks, duration: result.duration, cached: false });
  }

  // ---- 时间轴缩放：取**窗口切片**的峰值 ----
  //
  // 为什么不把细分辨率整条发给前端：3401s 的细分辨率 ≈ 160KB(二进制)/220KB(base64)，
  // 而每次缩放只需要"当前窗口那几个像素"的量 —— 按窗口取更省、也让前端保持简单。
  // 走的是"窗口模式"（视图窗口即全部），不是 WaveSurfer 的 `zoom()`：
  // 后者首行就 `if (!this.decodedData) throw new Error('No audio loaded')`，
  // 而我们的 peaks-only 路径**故意不解码**（省下 ≈600MB PCM，见 lib/audio/peaks.ts 文件头）。
  if (action === 'peaks_window') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return NextResponse.json({ success: false, error: 'file not found' });

    const startSec = Number(body.startSec);
    const sec = Number(body.sec);
    // 点数默认按"屏宽的两倍"给（等距采样后仍能表现细节）；上限 4000 防止异常请求
    // 上限放宽到 200k：细分辨率是 20ms/桶（3401s ⇒ 170k 点），原先卡 4000 会让长音频放大后仍然只有十几根粗柱。
    const points = Math.min(Math.max(Math.floor(Number(body.points) || 800), 1), 200000);
    if (!Number.isFinite(startSec) || startSec < 0 || !Number.isFinite(sec) || sec < PEAKS_MIN_WINDOW_SEC) {
      return NextResponse.json({ success: false, error: `startSec/sec is invalid (sec >= ${PEAKS_MIN_WINDOW_SEC})` });
    }

    const { resolveFfmpegPath } = await import('@/lib/parse/audio-parser');
    const ffmpegPath = await resolveFfmpegPath();
    if (!ffmpegPath) return NextResponse.json({ success: false, error: 'ffmpeg is unavailable' });

    const fine = await ensureFinePeaks(ffmpegPath, abs, stat, PEAKS_BUCKETS);
    if (!fine) return NextResponse.json({ success: false, error: 'could not analyse this audio' });
    const peaks = sliceFineWindow(fine.fine, fine.fineHz, startSec, sec, points);
    if (peaks.length === 0) return NextResponse.json({ success: false, error: 'window is outside the audio' });
    return NextResponse.json({ success: true, peaks, duration: fine.duration });
  }

  // ---- 读打点 ----
  if (action === 'load_marks') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const marks = await readMarksFile(await marksFileFor(abs));
    return NextResponse.json({ success: true, marks });
  }

  // ---- 写打点 ----
  if (action === 'save_marks') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const marks = (body.marks ?? []) as AudioMark[];
    const side = await marksFileFor(abs);
    await writeMarksFile(side, marks);
    return NextResponse.json({ success: true, marks: await readMarksFile(side) });
  }

  // ---- 重命名片段（改磁盘文件名 + 同步清单，返回新路径） ----
  if (action === 'rename_clip') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    const clipPath = String(body.clipPath || '').trim();
    if (!rel || !clipPath) return NextResponse.json({ success: false, error: 'path is required' });
    let srcAbs: string;
    try {
      srcAbs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    try {
      const { clips, path } = await renameClip(srcAbs, clipPath, String(body.name || ''));
      return NextResponse.json({ success: true, clips, path });
    } catch (e) {
      return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'rename failed' });
    }
  }

  // ---- 删除片段（删文件 + 它的打点，并从清单移除） ----
  if (action === 'delete_clip') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    const clipPath = String(body.clipPath || '').trim();
    if (!rel || !clipPath) return NextResponse.json({ success: false, error: 'path is required' });
    let srcAbs: string;
    try {
      srcAbs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    try {
      const clips = await deleteClip(srcAbs, clipPath);
      return NextResponse.json({ success: true, clips });
    } catch (e) {
      return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'delete failed' });
    }
  }

  // ---- 列出库内音频（仅含 source.* 的目录；影子目录不出现） ----
  if (action === 'list_library') {
    const entries = await listLibrary();
    return NextResponse.json({ success: true, entries });
  }

  // ---- 删除库内音频（整个目录：源 + 打点 + 片段 + 清单） ----
  if (action === 'delete_library') {
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = expandPath(rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    // 只允许删除库内文件（防止误删外部源路径）
    const { libraryRoot } = await import('@/lib/audio/library');
    const root = libraryRoot();
    if (!abs.startsWith(root + '/')) {
      return NextResponse.json({ success: false, error: 'can only delete library entries' });
    }
    await deleteEntry(abs);
    await forgetEntry(abs); // 条目没了，分组归属也一并抹掉（避免留下对不上的键）
    return NextResponse.json({ success: true });
  }

  // ---- 库分组（用户自建的文件夹 + 条目归属；状态落盘 .audio-library/.groups.json）----
  //
  // 五个动作都返回**写盘后的完整状态**（groups + assign），前端据此整份替换，
  // 不必自己推演"局部改了什么"——避免前后端两份状态漂移。
  if (action === 'list_groups') {
    const state = await readGroupState();
    return NextResponse.json({ success: true, groups: state.groups, assign: state.assign });
  }
  if (action === 'create_group') {
    try {
      const state = await createGroup(body.name);
      return NextResponse.json({ success: true, groups: state.groups, assign: state.assign });
    } catch (e) {
      return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'could not create group' });
    }
  }
  if (action === 'rename_group') {
    try {
      const state = await renameGroup(String(body.id || ''), body.name);
      return NextResponse.json({ success: true, groups: state.groups, assign: state.assign });
    } catch (e) {
      return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'could not rename group' });
    }
  }
  if (action === 'delete_group') {
    try {
      const state = await deleteGroup(String(body.id || ''));
      return NextResponse.json({ success: true, groups: state.groups, assign: state.assign });
    } catch (e) {
      return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'could not delete group' });
    }
  }
  if (action === 'assign_group') {
    const dir = String(body.dir || '').trim();
    if (!dir) return NextResponse.json({ success: false, error: 'dir is required' });
    try {
      // group 为空串 = 移出分组；护栏（必须是库内正式条目 / 目标组必须存在）在 lib 层
      const state = await assignEntry(dir, String(body.group || ''));
      return NextResponse.json({ success: true, groups: state.groups, assign: state.assign });
    } catch (e) {
      return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'could not move entry' });
    }
  }

  // ---- 影子目录（库外音频的产物）：列出与清理 ----
  //
  // 为什么需要：影子目录**故意不在 Library 列表里**（列表只认带 `source.*` 的条目），
  // 于是源文件被删/移动后，它们的打点/峰值/转写/片段会永远留在库里且界面上删不掉。
  if (action === 'list_shadows') {
    const shadows = await listShadowDirs();
    return NextResponse.json({ success: true, shadows });
  }
  if (action === 'delete_shadow') {
    const dir = String(body.dir || '').trim();
    if (!dir) return NextResponse.json({ success: false, error: 'dir is required' });
    try {
      await deleteShadowDir(dir);
    } catch (e) {
      // 护栏（库外路径 / 正式库条目）与"目录不存在"都以 400 + 明确原因返回，不静默成功
      return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'could not delete' });
    }
    return NextResponse.json({ success: true });
  }

  // ---- 读转写（编辑器侧；不存在**不是错误**）----
  // 组件挂载时可以直接问，不必先猜"转过没有"。三态：
  //   transcript: AudioTranscript → 有稿（且与当前音频指纹相符）
  //   transcript: null           → 没转过 / sidecar 失效（音频被换过）/ 数据损坏
  //   success: false + error     → 路径非法（真正的错误）
  if (action === 'load_transcript') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const stat = await fs.stat(abs).catch(() => null);
    const transcript = await readTranscriptFile(
      await transcriptFileFor(abs),
      stat ? { size: stat.size, mtimeMs: stat.mtimeMs } : null,
    );
    return NextResponse.json({ success: true, transcript });
  }

  // ---- 改一句文字（转写稿的**原地编辑**；只改文案，不动时间轴）----
  // 与 transcribe 的分工：这条路径绝不跑 STT、绝不碰 `t` / `end` / `speaker`，
  // 所以不需要窗口/时长/计费那套口径，只要把三件事做对：
  //   ① sidecar 必须存在且与**当前音频指纹**对得上；不足时返回业务错误而**不凭空创建** ——
  //      凭空造一份只有一句话的 sidecar 会顶掉用户真正的转写稿（且界面看不出来）；
  //   ② 改动合法性统一走 `updateSegmentText`（与前端同一份规则，杜绝两套口径）；
  //   ③ 回传**整份** transcript：前端拿它覆盖本地 state，避免连续两次编辑时
  //      "本地各改各的、盘上只剩最后一笔"。
  // 刻意**不更新 `at`**：那是「转写发生的时刻」，改一个错字不是重新转写。
  if (action === 'save_transcript') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const index = Number(body.index);
    if (!Number.isInteger(index)) return NextResponse.json({ success: false, error: 'index must be an integer' });
    const text = String(body.text ?? '');
    // 单句上限：正常转写一句几十字，5k 已远超合理范围 —— 用来挡"整段粘贴进一句"的误操作。
    if (text.length > 5000) {
      return NextResponse.json({ success: false, error: 'text is too long (max 5000 chars)' });
    }
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return NextResponse.json({ success: false, error: 'file not found' });

    const transcriptAbs = await transcriptFileFor(abs);
    const current = await readTranscriptFile(transcriptAbs, { size: stat.size, mtimeMs: stat.mtimeMs });
    if (!current) {
      // 没转过 / 音频被替换过 / sidecar 损坏 —— 三种情形都在这里挡住，绝不当成"新建"。
      return NextResponse.json({ success: false, error: 'no transcript for this audio — transcribe it first' });
    }
    const next = updateSegmentText(current, index, text);
    if (!next) return NextResponse.json({ success: false, error: 'invalid segment or no change' });
    // 原文改了，旧润色稿就不再对应当前文本：丢掉它，避免面板继续展示过期对话。
    delete next.polished;
    await writeTranscriptFile(transcriptAbs, next);
    return NextResponse.json({ success: true, transcript: next });
  }

  // ---- 改一句的**起点时间**（转写稿的手工校正；只动时间轴，不动文字/归属）----
  // 与 save_transcript 同属"原地编辑"家族，契约一致：sidecar 必须存在且与当前音频指纹对得上、
  // 回传**整份** transcript、**不更新 `at`**。合法性统一走 `updateSegmentStart`（与前端同一份规则）。
  // 上一段的 `end` 由该纯函数一并重排，保持段时间首尾相接。
  if (action === 'save_segment_time') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const index = Number(body.index);
    if (!Number.isInteger(index)) return NextResponse.json({ success: false, error: 'index must be an integer' });
    const t = Number(body.t);
    if (!Number.isFinite(t) || t < 0) {
      return NextResponse.json({ success: false, error: 't must be a non-negative number' });
    }
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return NextResponse.json({ success: false, error: 'file not found' });

    const transcriptAbs = await transcriptFileFor(abs);
    const current = await readTranscriptFile(transcriptAbs, { size: stat.size, mtimeMs: stat.mtimeMs });
    if (!current) {
      return NextResponse.json({ success: false, error: 'no transcript for this audio — transcribe it first' });
    }
    const next = updateSegmentStart(current, index, t);
    if (!next) return NextResponse.json({ success: false, error: 'invalid time or no change' });
    await writeTranscriptFile(transcriptAbs, next);
    return NextResponse.json({ success: true, transcript: next });
  }

  // ---- 改**一轮**的说话人归属（分离结果的手工纠正；只改 `speaker`，不动文字/时间轴）----
  // 与 save_transcript 的分工：那条改字、这条改人 —— 两条互不干扰的路径（一次只做一件事，
  // 失败回滚也各回各的）。契约与 save_transcript 同源（sidecar 必须存在且与当前音频指纹对得上、
  // 回传**整份** transcript、**不更新 `at`**），因为二者同属"原地编辑"这一个家族。
  // 有意的一处不同：这里**不删** `polished` —— 文本一字未动，润色稿仍然有效，
  // 只需把它的说话人标注刷新一下（`updateSegmentSpeakers` 内部按 `start` 对账完成）。
  // 入参是**一批段下标**而不是一个：界面上的最小操作单位是"一轮"（见 `updateSegmentSpeakers` 的说明）。
  if (action === 'assign_speaker') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const indexes = Array.isArray(body.indexes) ? body.indexes : [];
    if (indexes.length === 0 || indexes.length > MAX_TURN_SEGMENTS) {
      return NextResponse.json({
        success: false,
        error: `indexes must be 1..${MAX_TURN_SEGMENTS} items`,
      });
    }
    // `undefined` / `null` 都表示"改为未归属"（分不出人时的那一档）
    const speaker = body.speaker === null || body.speaker === undefined ? null : Number(body.speaker);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return NextResponse.json({ success: false, error: 'file not found' });

    const transcriptAbs = await transcriptFileFor(abs);
    const current = await readTranscriptFile(transcriptAbs, { size: stat.size, mtimeMs: stat.mtimeMs });
    if (!current) {
      return NextResponse.json({ success: false, error: 'no transcript for this audio — transcribe it first' });
    }
    const next = updateSegmentSpeakers(current, indexes.map((n: unknown) => Number(n)), speaker);
    if (!next) return NextResponse.json({ success: false, error: 'invalid segments or no change' });
    await writeTranscriptFile(transcriptAbs, next);
    return NextResponse.json({ success: true, transcript: next });
  }

  // ---- 给某个说话人起个名（**纯显示层**：只写 `speakerNames`，绝不碰 `segments`）----
  // 与 assign_speaker 的分工同上：改名错了再改一次即可，回滚不该把归属一起动。
  // 名字去空白后为空 = 恢复默认 `Speaker N`（`updateSpeakerName` 里删掉那个键）。
  if (action === 'rename_speaker') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const id = Number(body.id);
    if (!Number.isInteger(id)) return NextResponse.json({ success: false, error: 'id must be an integer' });
    const name = String(body.name ?? '');
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return NextResponse.json({ success: false, error: 'file not found' });

    const transcriptAbs = await transcriptFileFor(abs);
    const current = await readTranscriptFile(transcriptAbs, { size: stat.size, mtimeMs: stat.mtimeMs });
    if (!current) {
      return NextResponse.json({ success: false, error: 'no transcript for this audio — transcribe it first' });
    }
    const next = updateSpeakerName(current, id, name);
    if (!next) return NextResponse.json({ success: false, error: 'invalid speaker or no change' });
    await writeTranscriptFile(transcriptAbs, next);
    return NextResponse.json({ success: true, transcript: next });
  }

  // ---- 批量给说话人起名（对话稿面板的"列出所有人 → 一次改完 → 统一保存"）----
  // 与 rename_speaker 共用 `updateSpeakerName` 那套规则（`updateSpeakerNames` 内部逐条委托），
  // 差别只在**一次读改写**：前端循环调 N 次会写 N 次盘、弹 N 条提示，失败还留下"改了一半"的中间态。
  // 批次上限直接取 `MAX_SPEAKER_NAMES`（那份映射本身的上限）—— 一次改的条数不可能比能存的条数还多。
  if (action === 'rename_speakers') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const raw: unknown[] = Array.isArray(body.entries) ? body.entries : [];
    if (raw.length === 0 || raw.length > MAX_SPEAKER_NAMES) {
      return NextResponse.json({
        success: false,
        error: `entries must be 1..${MAX_SPEAKER_NAMES} items`,
      });
    }
    // 在这里把 JSON 归一成纯函数认得的形状（本路由是唯一的边界，纯函数层不再重复防御）
    const entries = raw.map((e) => {
      const o = (e ?? {}) as Record<string, unknown>;
      return { id: Number(o.id), name: String(o.name ?? '') };
    });
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return NextResponse.json({ success: false, error: 'file not found' });

    const transcriptAbs = await transcriptFileFor(abs);
    const current = await readTranscriptFile(transcriptAbs, { size: stat.size, mtimeMs: stat.mtimeMs });
    if (!current) {
      return NextResponse.json({ success: false, error: 'no transcript for this audio — transcribe it first' });
    }
    const next = updateSpeakerNames(current, entries);
    if (!next) return NextResponse.json({ success: false, error: 'invalid names or no change' });
    await writeTranscriptFile(transcriptAbs, next);
    return NextResponse.json({ success: true, transcript: next });
  }

  // ---- 持久化 DeepSeek 润色稿（Hippo / 预览共享同一份 sidecar）----
  if (action === 'save_polished') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const polished = body.polished;
    if (!isTranscriptPolish(polished)) {
      return NextResponse.json({ success: false, error: 'invalid polished transcript' });
    }
    if (polished.turns.length > 500) {
      return NextResponse.json({ success: false, error: 'too many polished turns (max 500)' });
    }
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return NextResponse.json({ success: false, error: 'file not found' });
    const transcriptAbs = await transcriptFileFor(abs);
    const current = await readTranscriptFile(transcriptAbs, { size: stat.size, mtimeMs: stat.mtimeMs });
    if (!current) {
      return NextResponse.json({ success: false, error: 'no transcript for this audio — transcribe it first' });
    }
    const next: AudioTranscript = { ...current, polished };
    await writeTranscriptFile(transcriptAbs, next);
    return NextResponse.json({ success: true, transcript: next });
  }

  // ---- 在指定行下面**插入一行对话**（原文稿 `insert_segment` / 润色稿 `insert_polished_turn`）----
  // 时间由客户端给（界面默认复制上一行）；只插文案与结构，不动任何已有段的时间。
  // 两条动作都在纯函数里做**双向同步**：原文稿插入会顺带补进润色稿，反之亦然，
  // 这样切视图不会"少一行"（规则见 `insertSegmentAfter` / `insertPolishedTurnAfter`）。
  if (action === 'insert_segment' || action === 'insert_polished_turn') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const afterIndex = Number(body.afterIndex);
    if (!Number.isInteger(afterIndex)) return NextResponse.json({ success: false, error: 'afterIndex must be an integer' });
    const text = String(body.text ?? '');
    if (!text.trim()) return NextResponse.json({ success: false, error: 'text is required' });
    if (text.length > 10000) {
      return NextResponse.json({ success: false, error: 'text is too long (max 10000 chars)' });
    }
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return NextResponse.json({ success: false, error: 'file not found' });
    const transcriptAbs = await transcriptFileFor(abs);
    const current = await readTranscriptFile(transcriptAbs, { size: stat.size, mtimeMs: stat.mtimeMs });
    if (!current) {
      return NextResponse.json({ success: false, error: 'transcript is missing or does not match this audio' });
    }
    const line = {
      speaker: body.speaker === null || body.speaker === undefined ? null : Number(body.speaker),
      t: Number(body.t ?? body.start),
      end: Number(body.end),
      text,
    };
    const next =
      action === 'insert_segment'
        ? insertSegmentAfter(current, afterIndex, line)
        : insertPolishedTurnAfter(current, afterIndex, line);
    if (!next) return NextResponse.json({ success: false, error: 'could not insert at that position' });
    await writeTranscriptFile(transcriptAbs, next);
    return NextResponse.json({ success: true, transcript: next });
  }

  // ---- 删掉一行对话（原文稿 `delete_segment` / 润色稿 `delete_polished_turn`）----
  // 插入的逆操作：只删用户眼前这一行；对侧"时间与文字完全一致"的那一行一并删掉
  // （= 插入时同步过去的那一行，规则见纯函数注释）。原文/润色稿的改写内容不会被连带删。
  if (action === 'delete_segment' || action === 'delete_polished_turn') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const index = Number(body.index);
    if (!Number.isInteger(index)) return NextResponse.json({ success: false, error: 'index must be an integer' });
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return NextResponse.json({ success: false, error: 'file not found' });
    const transcriptAbs = await transcriptFileFor(abs);
    const current = await readTranscriptFile(transcriptAbs, { size: stat.size, mtimeMs: stat.mtimeMs });
    if (!current) {
      return NextResponse.json({ success: false, error: 'transcript is missing or does not match this audio' });
    }
    const next =
      action === 'delete_segment' ? deleteSegment(current, index) : deletePolishedTurn(current, index);
    if (!next) {
      return NextResponse.json({
        success: false,
        error:
          action === 'delete_segment'
            ? 'could not delete that line (invalid index, or at least one line must remain)'
            : 'could not delete that turn',
      });
    }
    await writeTranscriptFile(transcriptAbs, next);
    return NextResponse.json({ success: true, transcript: next });
  }

  // ---- 改**润色稿里一轮**的文字（`view=polished` 的原地编辑）----
  // 与 save_transcript 的分工：润色轮与 `segments` 不是一一对应（多句并一轮），改一轮没法摊回某一句，
  // 所以只改 `polished.turns[index].text`，**不动** `segments` / `t` / `end` / `speaker`。
  // 契约与另外两条原地编辑同源：sidecar 必须存在且与当前音频指纹对得上、回传**整份** transcript。
  if (action === 'save_polished_turn') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const index = Number(body.index);
    if (!Number.isInteger(index)) return NextResponse.json({ success: false, error: 'index must be an integer' });
    const text = String(body.text ?? '');
    if (text.length > 10000) {
      return NextResponse.json({ success: false, error: 'text is too long (max 10000 chars)' });
    }
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return NextResponse.json({ success: false, error: 'file not found' });
    const transcriptAbs = await transcriptFileFor(abs);
    const current = await readTranscriptFile(transcriptAbs, { size: stat.size, mtimeMs: stat.mtimeMs });
    if (!current?.polished) {
      return NextResponse.json({ success: false, error: 'no polished transcript — polish it first' });
    }
    const next = updatePolishedTurnText(current, index, text);
    if (!next) return NextResponse.json({ success: false, error: 'invalid polished turn or no change' });
    await writeTranscriptFile(transcriptAbs, next);
    return NextResponse.json({ success: true, transcript: next });
  }

  // ---- 导出 Markdown（用 BobWork 的 Markdown 阅读器打开；原文/润色二选一）----
  if (action === 'export_markdown') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return NextResponse.json({ success: false, error: 'file not found' });
    const transcriptAbs = await transcriptFileFor(abs);
    const current = await readTranscriptFile(transcriptAbs, { size: stat.size, mtimeMs: stat.mtimeMs });
    if (!current) {
      return NextResponse.json({ success: false, error: 'no transcript for this audio — transcribe it first' });
    }
    const variant = body.variant === 'polished' ? 'polished' : 'raw';
    const title = String(body.title || '').trim() || audioTitle(basename(abs));
    // 片段文稿：只导出该区间的句子，并把时间改成片段内相对时间
    const rs = Number(body.rangeStartSec);
    const re = Number(body.rangeEndSec);
    let range: TranscriptMarkdownRange | undefined;
    if (Number.isFinite(rs) && Number.isFinite(re) && re > rs) {
      range = { start: Math.max(0, rs), end: Math.max(0, re) };
      if (!hasTranscriptInRange(current, range)) {
        return NextResponse.json({ success: false, error: 'No transcript text in this clip' });
      }
    }
    const markdown = transcriptToMarkdown(current, { title, variant, ...(range ? { range } : {}) });

    // 优先落到当前项目 materials/（可被项目树/Markdown 阅读器直接打开）；无项目时落本机缓存。
    let dir: string;
    let savedToProject = false;
    try {
      const project = await getCurrentProject();
      dir = join(project.path, 'materials');
      savedToProject = true;
    } catch {
      dir = join(homedir(), 'BobWork', '.cache', 'transcripts');
    }
    await fs.mkdir(dir, { recursive: true });
    const base = safeBaseName(title) || 'transcript';
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const file = join(dir, `${base} - 对话稿 ${stamp}.md`);
    await fs.writeFile(file, markdown, 'utf-8');
    return NextResponse.json({
      success: true,
      path: file,
      name: basename(file),
      variant,
      ...(range ? { range } : {}),
      savedToProject,
    });
  }

  // ---- 只重跑说话人分离，不重跑 STT（长对话补标签的正确路径）----
  // 旧实现点 "Retry as 2 people" 会 refresh 整段转写：62 分钟录音要重新跑一遍 ASR。
  // 这里复用已有 segments，只把 duo/group 分离结果按时间重叠回填 speaker，成本只剩分离本身。
  if (action === 're_diarize') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const mode: DiarMode = body.mode === 'group' ? 'group' : 'duo';
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return NextResponse.json({ success: false, error: 'file not found' });
    const transcriptAbs = await transcriptFileFor(abs);
    const current = await readTranscriptFile(transcriptAbs, { size: stat.size, mtimeMs: stat.mtimeMs });
    if (!current) {
      return NextResponse.json({ success: false, error: 'no transcript for this audio — transcribe it first' });
    }
    const { resolveFfmpegPath } = await import('@/lib/parse/audio-parser');
    const ffmpegPath = await resolveFfmpegPath();
    if (!ffmpegPath) return NextResponse.json({ success: false, error: 'ffmpeg is unavailable' });
    const projectRoot = await parseProjectRoot();
    const jobId = typeof body.jobId === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(body.jobId) ? body.jobId : '';
    const jobFile = jobId ? join(projectRoot, '.cache', 'diar-jobs', `${jobId}.json`) : '';
    const writeJob = async (payload: Record<string, unknown>) => {
      if (!jobFile) return;
      try {
        await fs.mkdir(join(projectRoot, '.cache', 'diar-jobs'), { recursive: true });
        await fs.writeFile(jobFile, JSON.stringify({ ...payload, at: new Date().toISOString() }), 'utf-8');
      } catch {
        /* 进度只是体验层，写失败不影响分离 */
      }
    };
    await writeJob({ pct: 0, stage: 'starting', done: false });
    // 只分离「稿子实际覆盖的区间」：3.6 小时录音如果只转了前 62 分钟，没必要分离整段。
    const covered = current.segments.length
      ? {
          start: Math.max(0, Math.min(...current.segments.map((seg) => seg.t))),
          end: Math.max(...current.segments.map((seg) => seg.end)),
        }
      : current.range;
    const range =
      covered && Number.isFinite(covered.start) && Number.isFinite(covered.end) && covered.end - covered.start >= 1
        ? covered
        : undefined;
    let lastPct = -1;
    let chunks;
    try {
      chunks = await ensureDiarization(abs, projectRoot, mode, {
        ffmpegPath,
        ...(range ? { range } : {}),
        onProgress: (pct) => {
          const rounded = Math.max(0, Math.min(99, Math.round(pct)));
          if (rounded === lastPct) return;
          lastPct = rounded;
          void writeJob({ pct: rounded, stage: 'separating', done: false });
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Speaker separation failed';
      await writeJob({ pct: 100, stage: 'error', done: true, error: message });
      return NextResponse.json({ success: false, error: message });
    }
    if (!chunks || chunks.length === 0) {
      const message =
        'Speaker separation produced no segments — the audio may be too noisy or overlapped';
      await writeJob({ pct: 100, stage: 'error', done: true, error: message });
      return NextResponse.json({ success: false, error: message });
    }
    const segments = current.segments.map((seg) => ({
      ...seg,
      speaker: speakerForRange(chunks, seg.t, seg.end),
    }));
    const speakers = new Set(
      segments.map((seg) => seg.speaker).filter((sp): sp is number => sp !== null),
    );
    if (speakers.size < 2) {
      const message =
        'Still one speaker after separation — the recording may be a single voice, or the voices overlap too much';
      await writeJob({ pct: 100, stage: 'error', done: true, error: message });
      return NextResponse.json({ success: false, error: message });
    }
    const engine = `${current.engine.replace(/，?未分说话人/g, '').replace(/，?按说话人分块（\d+ 人）/g, '')}，按说话人分块（${speakers.size} 人）`;
    const next: AudioTranscript = {
      ...current,
      segments,
      engine,
      diarize: mode,
      at: new Date().toISOString(),
    };
    // 说话人变了，旧润色稿里的 speaker 不再可信；保留原文，让用户重新润色。
    delete next.polished;
    await writeTranscriptFile(transcriptAbs, next);
    await writeJob({ pct: 100, stage: 'done', done: true });
    return NextResponse.json({ success: true, transcript: next, speakers: speakers.size });
  }

  // 读取长音频分离进度（re_diarize 的 HTTP 请求会阻塞，另开一条轮询通道）
  if (action === 'diarize_status') {
    const jobId =
      typeof body.jobId === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(body.jobId) ? body.jobId : '';
    if (!jobId) return NextResponse.json({ success: false, error: 'invalid jobId' });
    const projectRoot = await parseProjectRoot();
    const file = join(projectRoot, '.cache', 'diar-jobs', `${jobId}.json`);
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>;
      return NextResponse.json({ success: true, ...raw });
    } catch {
      return NextResponse.json({ success: true, pct: 0, stage: 'queued', done: false });
    }
  }

  // ---- 转写（编辑器侧；segments 直接给时间轴用）----
  // 四条设计口径：
  //   ① `refresh:true` = 忽略 sidecar 从头重跑；不带则：完整稿直接返回（**不重复花钱**），
  //      **半截稿（`partial`）从 `coveredUntilSec` 续跑**。
  //      parseAudio 自己还有一层内容 hash 缓存（`<project>/.cache/parse/`，**键含转写范围**），
  //      故续跑时已转过的窗口是"命中缓存立刻回来"，真的不会再调一次 STT。
  //   ② **长音频走窗口化**：整段超 30 分钟（`MAX_DURATION_SEC=1800`）在 parse 层会被拒，
  //      但按范围转写只校验所选范围的长度（`audio-parser.ts:720-726`）。
  //      所以这里把 `[range.start ?? 0, range.end ?? duration]` 按 `DEFAULT_WINDOW_SEC`(20min)
  //      切成无缝无重叠的窗口逐窗跑（`lib/audio/windowed.ts`，纯逻辑已单测），
  //      每完成一窗就**增量写 sidecar**（`partial:true` + `coveredUntilSec`）⇒ 请求被掐断也能续。
  //      用户实际那一例：3401s（57 分钟）⇒ 3 窗。
  //   ③ 「某一窗没有语音」**不是失败**：`NoSpeechError` 转成空数组继续下一窗；
  //      否则一整段静音会让后面的内容永远转不到（长录音里静音是常态）。
  //   ④ 任何失败（未配置引擎 / 静音 / 超限 / 网络）都转成 `{success:false,error}` 的 **200**：
  //      这些是"用户可读的业务原因"，不是服务端故障。框架 500 只留给真正的 I/O 事故
  //      （由外层 POST 包装兜，见本文件 :114-124）。
  if (action === 'transcribe') {
    const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
    const rel = String(body.path || '').trim();
    if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
    let abs: string;
    try {
      abs = await resolveAudio(source, rel);
    } catch {
      return NextResponse.json({ success: false, error: 'invalid path' });
    }
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return NextResponse.json({ success: false, error: 'file not found' });

    // 可选范围（"只转当前选区"）
    let range: { start: number; end: number } | null = null;
    if (body.rangeStartSec !== undefined || body.rangeEndSec !== undefined) {
      const start = Number(body.rangeStartSec);
      const end = Number(body.rangeEndSec);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < MIN_CLIP_SPAN_SEC) {
        return NextResponse.json({ success: false, error: 'invalid range (needs at least 0.1s)' });
      }
      range = { start, end };
    }
    const diarize =
      body.diarize === 'auto' || body.diarize === 'duo' || body.diarize === 'group' ? body.diarize : undefined;
    /** 窗口长度（仅测试/调优用；服务端一律夹到安全区间） */
    const windowSec = clampWindowSec(body.windowSec);

    const transcriptAbs = await transcriptFileFor(abs);
    const fingerprint = { size: stat.size, mtimeMs: stat.mtimeMs };
    /** 可用于续跑的半截稿（完整稿在下面直接返回） */
    let resumeFrom: AudioTranscript | null = null;
    if (body.refresh !== true) {
      const cached = await readTranscriptFile(transcriptAbs, fingerprint);
      if (cached && !cached.partial) return NextResponse.json({ success: true, transcript: cached, cached: true });
      // 只有**同一次请求的形状**才谈得上续跑：范围变了（或从"选区"改成"整段"）就从头来，
      // 否则会把上一段选区的结果当成整段的前半截拼进去。
      const sameRange =
        (!cached?.range && !range) ||
        (!!cached?.range && !!range && cached.range.start === range.start && cached.range.end === range.end);
      if (cached?.partial && sameRange) resumeFrom = cached;
    }

    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const { parseAudio, probeAudioDurationSec, NoSpeechError } = await import('@/lib/parse/audio-parser');
    const settings = await readSettingsFromFile();
    const projectRoot = await parseProjectRoot();

    /** 探总时长：单一真源给窗口计划、末段 end 与 UI 进度用 */
    const probedDuration = await probeAudioDurationSec(abs);

    /**
     * 跑一个窗口 → 段。
     *
     * `swallowNoSpeech`（默认 true）= 把 `NoSpeechError` 转成空数组：
     * **窗口化时必须吞**，否则一整段静音会让后面的内容永远转不到（长录音里静音是常态）。
     * 但**单窗路径（整段短音频 / 选区）不该吞** —— 那里"没语音"就是要原样报给用户的原因，
     * 吞掉只会退化成一句笼统的 "Empty transcript"，把"录音是静音/输入电平太低"这条
     * 真正可操作的线索丢掉（那是引入窗口化之前的行为，不能回退）。
     */
    const runWindow = async (
      w: { start: number; end: number },
      opts?: { swallowNoSpeech?: boolean },
    ) => {
      let plainText = '';
      let engine = '';
      try {
        const result = await parseAudio(abs, projectRoot, {
          stt: settings.stt,
          ...(diarize ? { diarize } : {}),
          rangeStartSec: w.start,
          rangeEndSec: w.end,
        });
        plainText = result.plain_text || '';
        engine = /^音频转写（([^）]*)）/.exec(result.extracted_text || '')?.[1] ?? '';
      } catch (e) {
        if (e instanceof NoSpeechError && opts?.swallowNoSpeech !== false) {
          return { segments: [], plainText: '', engine: '' };
        }
        throw e;
      }
      return { segments: segmentsForEditor(plainText, { endSec: w.end }), plainText, engine };
    };

    const buildTranscript = (
      segments: AudioTranscript['segments'],
      plainText: string,
      engine: string,
      extra: { partial?: true; coveredUntilSec?: number },
    ): AudioTranscript => ({
      version: TRANSCRIPT_VERSION,
      segments,
      plainText,
      durationSec: probedDuration,
      engine,
      range,
      // 记下这次请求的说话人模式：分离失败时 UI 才能说"你要了对话稿，但没分出来"，
      // 而不是把一份单人流水静静当成对话稿（老 sidecar 无此字段，由 engine 文本兜底）
      diarize: diarize ?? null,
      at: new Date().toISOString(),
      source: fingerprint,
      ...extra,
    });

    try {
      // 计划要覆盖的区间：选区优先，否则整段
      const spanStart = range ? range.start : 0;
      const spanEnd = range ? range.end : probedDuration;
      const resumedUntil = resumeFrom?.coveredUntilSec ?? spanStart;
      const plan =
        spanEnd !== null && spanEnd > 0 ? planWindows(spanEnd, windowSec, resumedUntil) : [];

      if (plan.length <= 1) {
        // 短音频 / 选区：**一次调用**，与窗口化引入之前逐字节等价（不引入额外行为）。
        // `swallowNoSpeech:false` ⇒ 静音/无语音时抛 NoSpeechError，由外层如实报出原始原因
        // （"录音是静音 / 输入电平太低"比笼统的 "Empty transcript" 可操作得多）。
        const w = plan[0] ?? { start: spanStart, end: spanEnd ?? spanStart };
        const one = await runWindow(w, { swallowNoSpeech: false });
        if (one.segments.length === 0) {
          return NextResponse.json({ success: false, error: 'Empty transcript — no speech detected.' });
        }
        const transcript = buildTranscript(
          mergeSegments(resumeFrom?.segments ?? [], one.segments),
          one.plainText,
          one.engine,
          {},
        );
        await writeTranscriptFile(transcriptAbs, transcript);
        return NextResponse.json({ success: true, transcript, cached: false, windows: 1 });
      }

      // 长音频：逐窗跑，**每完成一窗就落盘**（partial + coveredUntilSec）⇒ 可续跑
      let lastEngine = resumeFrom?.engine ?? '';
      let lastPlain = resumeFrom?.plainText ?? '';
      const result = await runWindows({
        plan,
        existing: resumeFrom?.segments ?? [],
        transcribeWindow: async (w) => {
          const one = await runWindow(w);
          if (one.segments.length > 0) {
            lastEngine = one.engine || lastEngine;
            lastPlain = lastPlain ? `${lastPlain}\n\n${one.plainText}` : one.plainText;
          }
          return one.segments;
        },
        onProgress: async (p) => {
          await writeTranscriptFile(
            transcriptAbs,
            buildTranscript(p.segments, lastPlain, lastEngine, {
              coveredUntilSec: p.coveredUntilSec,
              ...(p.done < p.total ? { partial: true as const } : {}),
            }),
          );
        },
      });

      if (result.segments.length === 0) {
        return NextResponse.json({ success: false, error: 'Empty transcript — no speech detected.' });
      }
      const transcript = buildTranscript(result.segments, lastPlain, lastEngine, {
        coveredUntilSec: result.coveredUntilSec,
      });
      await writeTranscriptFile(transcriptAbs, transcript);
      return NextResponse.json({ success: true, transcript, cached: false, windows: result.total });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 半途失败时如实告诉用户"已经转了多少、再点一次会接着转"（已完成的窗口已落盘）
      const saved = await readTranscriptFile(transcriptAbs, fingerprint);
      if (saved?.partial && saved.coveredUntilSec) {
        const doneMin = Math.round(saved.coveredUntilSec / 60);
        const totalMin = probedDuration ? Math.round(probedDuration / 60) : null;
        return NextResponse.json({
          success: false,
          error: `${msg}（已保存 ${doneMin}${totalMin ? `/${totalMin}` : ''} 分钟的转写，再点一次「继续转写」会从断点接着跑）`,
          transcript: saved,
        });
      }
      return NextResponse.json({ success: false, error: msg });
    }
  }

  return NextResponse.json({ success: false, error: `unknown action: ${action}` });
}
