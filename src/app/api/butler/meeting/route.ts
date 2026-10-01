/**
 * /api/butler/meeting — 会议模式状态通道
 *
 * GET  读取会议快照（活动状态 / 标题 / 计时起点 / 已记录条数 / 实时字幕流 / 产物落点），供中栏会议控制台轮询。
 * POST 会议动作：
 *   - { action: 'start', title?, outputKind?, outputDir? } → 开启会议（默认落点：butler/meetings）
 *   - { action: 'append', text, type?, label? } → 追加一段转写（顺带刷新静默计时）
 *   - { action: 'write', path, content, encoding? } → 把录音等产物写入 butler 根目录（相对路径）
 *   - { action: 'end' }                        → 结束会议（**不调模型**），返回 { title, transcript, segments, autoSummarize, outputKind, outputDir }
 *   - { action: 'summarize', title, text }     → 实时会议结束后单独整理纪要（与导入的 import_finish 同出口，不落盘）
 *                                                这样面板能先跳到 History 显示「Generating…」，不必等模型跑完
 *   - { action: 'punctuate', texts }            → 批量补标点（会议结束后统一给语音段补句读；未装标点模型则原样返回）
 *   - { action: 'retranscribe', source, path }  → 结束后用录音整体重转（合并分片 → 离线**批量**模型按 25 分钟窗口串行重转，
 *                                                 顺带按会议设置跑说话人分离）；超 100MB 时先切片再转写、时间戳平移回合并音频。
 *                                                 返回 **NDJSON 流**：{t:'progress'} … 收尾 {t:'done'} 或 {t:'skip',reason}
 *   - { action: 'settings_get' / 'settings_set' } → 读写会议专属设置（录音源 / 参会人数 / 会后自动整理）
 *   - { action: 'import_probe', audioPath }        → 导入录音：探测时长（ffmpeg 不可用返回 null），
 *                                                     并对整段音频跑一次说话人分离（结果缓存复用；未下载分离资产则跳过）
 *   - { action: 'import_segment', audioPath, startSec?, endSec? } → 导入录音：转写一个时间窗（纯正文）
 *   - { action: 'import_finish', title, text }     → 导入录音：按会议设置出纪要（或只留档全文转写）
 *   - { action: 'podcast_generate', sourcePath, title?, form?, voiceA?, voiceB? } → 文本转播客：读 materials 下的 md/txt →
 *                                                     模型改写成双主播脚本（form = qa|relay|debate|chat，
 *                                                     默认 qa；只换互动方式，不影响音色与拼接）→
 *                                                     逐句 TTS（voiceA/voiceB 为两位主播音色 id，缺省走自动派生）→
 *                                                     ffmpeg 拼成一段音频落 butler/podcast/。返回 **NDJSON 流**：
 *                                                     {t:'progress',phase:'script'|'tts'|'concat'} … 收尾
 *                                                     {t:'done',title,md,audio,note?} 或 {t:'error',error}
 *                                                     （客户端拿 md + audio.rel 写进落点，进 History 可回放）
 *   - { action: 'podcast_voices' }                 → 文本转播客：列举当前 TTS 引擎下两位主播的可选音色
 *                                                     （TTS 配置与本地模型都在服务端，客户端只能从这里取清单）
 *   - { action: 'history' }                        → 过往会议产物（扫 butler 根 + 当前项目根，供面板 History 列表点开）
 *   - { action: 'search', query?, limit? }          → 会议归档检索（**记录员 Recorder 专用**）：无 query = 最近会议清单；
 *                                                     有 query = 跨会议正文检索（大小写不敏感子串，多词 AND）
 *   - { action: 'read', source, path }              → 会议归档阅读（**记录员 Recorder 专用**）：取某场全文（剥音频指针与时间戳）
 *   - { action: 'delete', source, path }           → 删除一条历史产物（只删这一份 md；路径须落在对应根内且为会议产物）
 *   - { action: 'replay_audio', source, path }     → 回放：取该产物的带戳转写 + 录音分片清单（+ 已合并件）
 *                                                     并附说话人名单 speakers（库里有名字就带上，见 speakerRoster）
 *   - { action: 'speaker_name', source, path, speaker, name } → 给某说话人命名：质心写进项目声纹库，回传新名单
 *   - { action: 'speaker_identify', source, path } → 回放：为「当年没算过声纹」的老录音补跑一次分离，回传新名单
 *                                                     （replay_audio 只读缓存，故旧录音要用户点一下才分析）
 *   - { action: 'concat_audio', source, path }     → 回放：把分片合并成一个 webm（ffmpeg；不可用则失败）
 *
 * 说明：butler 目标的录音/纪要落盘走本路由的 'write'（服务端固定根 = butlerRoot，做穿越防护）；
 * 项目目标的落盘由客户端直接调 /api/projects?action=write_file 完成。
 */
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { getMeetingSnapshot, appendToMeeting, startMeeting, endMeeting, formatTimestampedTranscript, type MeetingMessage } from '@/lib/core/meeting-session';
import { finalizeMeetingText, recordTranscriptText } from '@/lib/core/meeting-finalize';
import { butlerRoot } from '@/lib/butler/storage';
import { meetingSettingsOf, type TtsSettings } from '@/lib/settings';
import { readSettingsFromFile, writeSettingsToFile } from '@/lib/settings-server';
import { getCurrentProject } from '@/lib/project/project-manager';

/**
 * 导入录音模式的路径解析：只允许项目 `materials/` 下的相对路径。
 * 为什么限定 materials：导入的音频就是「输入框上传附件」的落点（附件即项目资料），
 * 不给会议面板开一条能读项目任意文件的口子。
 */
async function resolveMaterialsAudio(rel: string): Promise<{ abs: string; projectRoot: string }> {
  const project = await getCurrentProject();
  const cleaned = String(rel || '').replace(/^\/+/, '');
  if (!cleaned.startsWith('materials/')) throw new Error('Only audio under materials/ can be imported');
  const root = resolve(project.path, 'materials');
  const abs = resolve(project.path, cleaned);
  if (abs !== root && !abs.startsWith(root + '/')) throw new Error('path escapes materials');
  return { abs, projectRoot: project.path };
}

/** 文本转播客认可的扩展名（资料即文字稿：Markdown 与纯文本） */
const DOC_EXTS = ['.md', '.markdown', '.txt'];

/** 送模型的源文件大小上限（4MB 纯文本已远超播客能承载的篇幅，再大必是误选） */
const DOC_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 文本转播客的路径解析：与录音导入同一收口——只允许 `materials/` 下的 md/txt。
 * 为什么要限扩展名：这条链路会把文件内容送进模型，不该变成「读项目任意文件」的口子。
 */
async function resolveMaterialsText(rel: string): Promise<{ abs: string; name: string }> {
  const project = await getCurrentProject();
  const cleaned = String(rel || '').replace(/^\/+/, '');
  if (!cleaned.startsWith('materials/')) throw new Error('Only documents under materials/ can be turned into a podcast');
  const ext = cleaned.slice(cleaned.lastIndexOf('.')).toLowerCase();
  if (!DOC_EXTS.includes(ext)) throw new Error(`Unsupported document type: ${ext || '(none)'} — pick a .md or .txt file`);
  const root = resolve(project.path, 'materials');
  const abs = resolve(project.path, cleaned);
  if (abs !== root && !abs.startsWith(root + '/')) throw new Error('path escapes materials');
  const size = await fs.stat(abs).then((s) => s.size).catch(() => 0);
  if (size > DOC_MAX_BYTES) {
    throw new Error(`The source file is too large (${Math.round(size / 1024 / 1024)}MB > 4MB) — split it first`);
  }
  return { abs, name: basename(cleaned) };
}

/** 会议产物文件名（与 MeetingConsole / MeetingStart 的落盘口径一致：`会议纪要|会议记录|播客 - <标题>.md`） */
const MEETING_FILE_RE = /^(会议纪要|会议记录|播客) - (.+)\.md$/;

/** 产物类型：纪要 / 全文转写 / 播客（播客是同一套「产物 + 音频指针 + History 回放」机制里的第三种） */
type MeetingKind = 'minutes' | 'transcript' | 'podcast';

/** 文件名前缀 → 产物类型 */
function kindOfPrefix(prefix: string): MeetingKind {
  return prefix === '会议纪要' ? 'minutes' : prefix === '播客' ? 'podcast' : 'transcript';
}

/** 历史条目：够渲染（标题/类型/时间/落点）+ 直接打开文件（source + path） */
interface MeetingHistoryEntry {
  name: string;
  title: string;
  kind: MeetingKind;
  source: 'project' | 'local';
  /** project = 相对项目根；local = 绝对路径（与 fileOpen 事件的两种口径一致） */
  path: string;
  /** 落点的人类可读说法（列表副行展示） */
  place: string;
  /** 文件 mtime（毫秒；排序与展示用） */
  time: number;
  /** 是否有可回放的录音（决定 History 行是否出播放入口；真实回放仍以 replay_audio 为准） */
  hasAudio: boolean;
}

/** 扫描时跳过的内部目录（与 /api/projects 的文件树口径一致） */
const SKIP_DIRS = new Set(['node_modules', 'sticky-notes', 'notes-memory', 'butler', '.git']);

const execFileAsync = promisify(execFile);

/** 合并分片的超时（1 小时录音 ≈ 40 片；copy 模式秒级，重编码留足余量） */
const CONCAT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 转写 md 首行的音频指针：`<!-- bob-audio: <source>:<path-glob> -->`。
 * source = local（相对 butler 根）| project（相对当前项目根）；
 * path-glob 含 `*` 时按分片通配（Live：`录音 - <标题> - part-*.webm`），否则是单个音频文件（Import）。
 */
const AUDIO_HINT_RE = /^<!--\s*bob-audio:\s*(local|project):(.+?)\s*-->/m;

/** 分片名里的 part 序号（`part-003`）；没有序号排到最后（不假设连续） */
function partNo(name: string): number {
  const m = /part-(\d+)\./i.exec(name);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** 一次 history / 回放请求内的目录列表缓存（避免对同一目录反复 readdir） */
type DirCache = Map<string, string[]>;

async function readdirCached(dir: string, cache: DirCache): Promise<string[]> {
  const hit = cache.get(dir);
  if (hit) return hit;
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  cache.set(dir, names);
  return names;
}

/** 只读文件头部若干字节（嗅探首行指针；不把大文件整读进内存） */
async function readHead(abs: string, bytes = 200): Promise<string> {
  try {
    const fh = await fs.open(abs, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead).toString('utf-8');
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

/** 产物文件名 → 类型与标题（`会议纪要|会议记录|播客 - <标题>.md`）；不匹配返回 null */
function parseMeetingFileName(name: string): { kind: MeetingKind; title: string } | null {
  const m = MEETING_FILE_RE.exec(name);
  if (!m) return null;
  return { kind: kindOfPrefix(m[1]), title: m[2] };
}

/** 转写正文里的相对时间戳 `[mm:ss]`（跨 100 分钟进位成三位，见 formatTimestampedTranscript） */
const TRANSCRIPT_TS_RE = /\[\d{1,3}:\d{2}\]\n?/g;

/**
 * 剥离「机器标记」→ 纯文本：首行音频指针 `<!-- bob-audio: … -->` + 转写时间戳 `[mm:ss]`。
 * 这两样只对回放器有意义；检索命中与送模型总结都必须是纯正文（时间戳喂进模型只会干扰行文）。
 */
function stripMeetingMarkup(text: string): string {
  return text.replace(AUDIO_HINT_RE, '').replace(TRANSCRIPT_TS_RE, '').trim();
}

/** 命中片段：正文压成单行后，取**最早命中词**前后各一段（上限 140 字符，够模型判断是不是它） */
function makeSnippet(flat: string, terms: string[], max = 140): string {
  const lower = flat.toLowerCase();
  let best = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  if (best < 0) return '';
  const start = Math.max(0, best - Math.floor(max / 2));
  const end = Math.min(flat.length, start + max);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

/** 检索结果里的一条会议：只发检索需要的字段（name / hasAudio 与检索无关） */
const briefEntry = (m: MeetingHistoryEntry) => ({
  title: m.title,
  kind: m.kind,
  source: m.source,
  path: m.path,
  place: m.place,
  time: m.time,
});

/**
 * 回放侧的根目录 + 「绝对路径 → 客户端可用路径」换算。
 * local = butler 根（客户端用 LocalSource.proxy(abs)）；project = 当前项目根（客户端用 ProjectSource.proxy(rel)）。
 */
async function replaySide(source: 'local' | 'project'): Promise<{ root: string; toClient: (abs: string) => string }> {
  if (source === 'project') {
    const project = await getCurrentProject();
    return { root: project.path, toClient: (abs) => relative(project.path, abs) };
  }
  const root = butlerRoot();
  return { root, toClient: (abs) => abs };
}

/** 解析某侧内的路径为绝对路径（越界即抛；白名单口径与 listMeetingHistory 一致） */
async function resolveInSide(source: 'local' | 'project', rel: string): Promise<{ abs: string; toClient: (abs: string) => string }> {
  const { root, toClient } = await replaySide(source);
  const raw = String(rel || '');
  // local 侧 History 给的是**绝对路径**，project 侧给的是项目内相对路径 —— 两种都要能解析
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw.replace(/^\/+/, ''));
  if (abs !== root && !abs.startsWith(root + '/')) throw new Error('path escapes the meeting root');
  return { abs, toClient };
}

/** 展开音频指针 → 实际存在的绝对路径（按 part 序号排序；非通配时即「该文件是否存在」） */
async function expandAudioGlob(side: 'local' | 'project', glob: string, cache: DirCache): Promise<string[]> {
  const { root } = await replaySide(side);
  const abs = isAbsolute(glob) ? resolve(glob) : resolve(root, glob.replace(/^\/+/, ''));
  if (!glob.includes('*')) {
    try {
      await fs.access(abs);
      return [abs];
    } catch {
      return [];
    }
  }
  const dir = dirname(abs);
  const base = basename(abs);
  const star = base.indexOf('*');
  const pre = base.slice(0, star);
  const suf = base.slice(star + 1);
  const names = await readdirCached(dir, cache);
  return names
    .filter((n) => n.startsWith(pre) && n.endsWith(suf))
    .sort((a, b) => partNo(a) - partNo(b))
    .map((n) => join(dir, n));
}

/** 读 md 首行指针并确认音频存在；无指针 → null（上层继续回退），有指针但落空 → false */
async function audioByHint(abs: string, cache: DirCache): Promise<boolean | null> {
  const hint = AUDIO_HINT_RE.exec(await readHead(abs));
  if (!hint) return null;
  return (await expandAudioGlob(hint[1] as 'local' | 'project', hint[2].trim(), cache)).length > 0;
}

/** 该条历史是否有可回放的音频：先嗅探指针，纪要再看同目录转写，最后回退「同目录 + 同标题」 */
async function detectHasAudio(mdAbs: string, title: string, cache: DirCache): Promise<boolean> {
  const own = await audioByHint(mdAbs, cache);
  if (own !== null) return own;
  const sib = await audioByHint(join(dirname(mdAbs), `会议记录 - ${title}.md`), cache);
  if (sib !== null) return sib;
  const names = await readdirCached(dirname(mdAbs), cache);
  return names.some((n) => n.startsWith(`录音 - ${title} - part-`) && n.endsWith('.webm')) || names.includes(`录音 - ${title}.webm`);
}

/**
 * 收集一份会议产物引用的本地音频（绝对路径，已去重）——删除产物时一并回收，不留孤儿文件。
 * 只认两类来源，其余一律不碰：
 *   1. md 首行音频指针 `<!-- bob-audio: … -->` 指到的那批：Live 的录音分片/合并件（通配正好覆盖 part-*）
 *      与播客音频（`local:podcast/*.wav`）都挂在这条指针上；
 *   2. 指针落空时的同目录兜底：`录音 - <标题> - part-*.webm` 与 `录音 - <标题>.webm`（老产物可能没指针）。
 * ⚠️ 明确排除用户的原始材料：指针落在 materials/ 下时（导入录音指向的就是原件）不删——那是资料不是产物。
 */
async function collectMeetingAudio(mdAbs: string, title: string): Promise<string[]> {
  const cache: DirCache = new Map();
  const out = new Set<string>();
  const hint = AUDIO_HINT_RE.exec(await readHead(mdAbs));
  if (hint) {
    const side = hint[1] as 'local' | 'project';
    const materialsRoot = side === 'project' ? join((await getCurrentProject()).path, 'materials') : '';
    for (const p of await expandAudioGlob(side, hint[2].trim(), cache)) {
      if (materialsRoot && (p === materialsRoot || p.startsWith(materialsRoot + '/'))) continue;
      out.add(p);
    }
  }
  const dir = dirname(mdAbs);
  for (const n of await readdirCached(dir, cache)) {
    if (n === `录音 - ${title}.webm` || (n.startsWith(`录音 - ${title} - part-`) && n.endsWith('.webm'))) {
      out.add(join(dir, n));
    }
  }
  return [...out];
}

/** 逐个删除音频，返回实际删掉的文件名（单个失败不阻断其余，例如已被手工清理过） */
async function removeMeetingAudio(paths: string[]): Promise<string[]> {
  const done: string[] = [];
  for (const p of paths) {
    try {
      await fs.rm(p, { force: true });
      done.push(basename(p));
    } catch { /* 忽略单个失败 */ }
  }
  return done;
}

/** 回放用的一条音频（abs 仅服务端使用；响应里只发 source/path/name/size） */
interface ReplayAudio {
  source: 'local' | 'project';
  /** 服务端绝对路径（ffmpeg 合并用） */
  abs: string;
  /** 客户端可用路径（local = 绝对路径；project = 项目内相对路径） */
  path: string;
  name: string;
  size: number;
}

async function audioEntry(side: 'local' | 'project', toClient: (abs: string) => string, abs: string): Promise<ReplayAudio> {
  let size = 0;
  try {
    size = (await fs.stat(abs)).size;
  } catch { /* 取不到按 0 */ }
  return { source: side, abs, path: toClient(abs), name: basename(abs), size };
}

/** 合并件（`录音 - <标题>.webm`，与分片同目录）；不存在返回 null */
async function findMerged(dir: string, title: string, side: 'local' | 'project', toClient: (abs: string) => string): Promise<ReplayAudio | null> {
  const abs = join(dir, `录音 - ${title}.webm`);
  try {
    await fs.access(abs);
  } catch {
    return null;
  }
  return audioEntry(side, toClient, abs);
}

/**
 * 合并分片成一个 webm（写回分片同目录的 `录音 - <标题>.webm`）。
 * concat_audio 与 retranscribe 共用：先流拷贝（快），失败再重编码为 opus（慢但稳）。
 * 返回合并后的绝对路径；「已有合并件」由调用方先查（同一份文件复用 → 内容 hash 稳定 → 转写缓存能命中）。
 */
async function mergeParts(
  parts: ReplayAudio[],
  title: string,
  ffmpegPath: string,
  dir: string,
): Promise<string> {
  const outAbs = join(dir, `录音 - ${title}.webm`);
  const listFile = join(tmpdir(), `bob-concat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  try {
    // concat demuxer 的 list 语法：单引号包裹路径，内部单引号转义为 '\''
    await fs.writeFile(listFile, parts.map((a) => `file '${a.abs.replace(/'/g, "'\\''")}'`).join('\n'), 'utf-8');
    const base = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile];
    try {
      // MediaRecorder 的分片若容器头兼容，直接流拷贝（快）
      await execFileAsync(ffmpegPath, [...base, '-c', 'copy', outAbs], { timeout: CONCAT_TIMEOUT_MS });
    } catch {
      // 否则重编码为 opus（慢但稳）
      await execFileAsync(ffmpegPath, [...base, '-c:a', 'libopus', '-vn', outAbs], { timeout: CONCAT_TIMEOUT_MS });
    }
  } finally {
    await fs.rm(listFile, { force: true }).catch(() => undefined);
  }
  return outAbs;
}

/** 播客音频目录：与 butler/tts 分立——那边是 7 天 TTL 的临时件（/api/tts/speak 会顺手清），这里是长期产物 */
function podcastDir(): string {
  return join(butlerRoot(), 'podcast');
}

/** 文件名安全化（播客音频文件名用；与客户端 safeName 同口径） */
function safeFileStem(s: string): string {
  return s.replace(/[\\/:*?"<>|\n\r\t]+/g, '-').trim() || 'podcast';
}

/** 从 WAV 里取出的拼接要素：fmt 原始字节 + 三要素 + 纯 PCM 数据（已按 RIFF 声明长度裁剪） */
interface ParsedWav {
  fmt: Buffer;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  data: Buffer;
}

/**
 * 解析 WAV 头（RIFF/WAVE + fmt + data）。非 PCM WAV、结构异常一律返回 null，由调用方明确报错。
 * 片段由本地引擎产出，都是标准 16-bit PCM，故只取拼接需要的字段。
 */
function parseWav(buf: Buffer): ParsedWav | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt: Buffer | undefined;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buf.length) {
      fmt = buf.subarray(body, body + 16);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (!fmt) return null;
      return { fmt, sampleRate, channels, bitsPerSample, data: buf.subarray(body, body + Math.min(size, buf.length - body)) };
    }
    off = body + size + (size % 2); // RIFF 块按偶数字节对齐
  }
  return null;
}

/**
 * 把逐句合成的片段合并成一段播客音频：直接按 PCM 字节追加，只重写一个 RIFF 头，
 * **不调 ffmpeg**（两位主播同属一个本地模型，采样率/声道/位深必然一致，无需解码重采样）。
 * 格式不一致时明确报错——静默按第一段的参数拼会把后面几段放快放尖（历史教训：
 * 22.05kHz 与 16kHz 混拼，23.4s 的素材只剩 18.2s）。
 * 返回实际写出的绝对路径（`.wav`，与合成片段同格式，回放侧按扩展名即可播放）。
 */
async function concatPodcastAudio(parts: string[], stem: string, dir: string): Promise<string> {
  let head: ParsedWav | undefined;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const clip = parseWav(await fs.readFile(p));
    if (!clip) throw new Error(`Podcast audio merge failed: "${basename(p)}" is not a readable PCM WAV clip.`);
    if (!head) {
      head = clip;
    } else if (
      clip.sampleRate !== head.sampleRate ||
      clip.channels !== head.channels ||
      clip.bitsPerSample !== head.bitsPerSample
    ) {
      throw new Error(
        'Podcast audio merge failed: the clips have different audio formats — both hosts must use the same voice model.',
      );
    }
    chunks.push(clip.data);
  }
  if (!head) throw new Error('Podcast audio merge failed: no synthesized clips to merge.');

  const dataBytes = chunks.reduce((n, c) => n + c.length, 0);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  head.fmt.copy(header, 20);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);

  const out = join(dir, `${stem}.wav`);
  await fs.writeFile(out, Buffer.concat([header, ...chunks]));
  return out;
}

/**
 * 找一份转写对应的录音分片与合并件。
 * 优先读首行 `<!-- bob-audio: … -->` 指针（Import 的音频在 materials/，与 md 不同目录，只能靠指针）；
 * 旧产物没有指针时回退「同目录 + 同标题」匹配。
 */
async function findReplayAudio(
  mdAbs: string,
  mdText: string,
  mdSide: 'local' | 'project',
  title: string,
  cache: DirCache,
): Promise<{ audio: ReplayAudio[]; merged: ReplayAudio | null }> {
  const hint = AUDIO_HINT_RE.exec(mdText);
  if (hint) {
    const side = hint[1] as 'local' | 'project';
    const { toClient } = await replaySide(side);
    const absList = await expandAudioGlob(side, hint[2].trim(), cache);
    const audio = await Promise.all(absList.map((abs) => audioEntry(side, toClient, abs)));
    return { audio, merged: audio.length > 1 ? await findMerged(dirname(absList[0]), title, side, toClient) : null };
  }
  const dir = dirname(mdAbs);
  const { toClient } = await replaySide(mdSide);
  const names = await readdirCached(dir, cache);
  const parts = names
    .filter((n) => n.startsWith(`录音 - ${title} - part-`) && n.endsWith('.webm'))
    .sort((a, b) => partNo(a) - partNo(b));
  const audio = await Promise.all(parts.map((n) => audioEntry(mdSide, toClient, join(dir, n))));
  return { audio, merged: parts.length > 1 ? await findMerged(dir, title, mdSide, toClient) : null };
}

/**
 * 回放请求的公共前置：定位 md → 定字幕源（点的是纪要时找同目录转写）→ 找音频。
 * replay_audio / concat_audio 共用同一口径，避免「播放器能找到音频、合并却说没有分片」。
 */
async function loadReplay(source: 'local' | 'project', rel: string, cache: DirCache) {
  const { abs, toClient } = await resolveInSide(source, rel);
  const mdText = await fs.readFile(abs, 'utf-8');
  const info = parseMeetingFileName(basename(abs));
  const title = info?.title || basename(abs).replace(/\.md$/i, '');
  // 字幕源：纪要不含时间戳 → 找同目录的「会议记录 - <标题>.md」；找不到就用纪要正文（纯文本模式）
  let transcriptAbs = abs;
  if (info?.kind === 'minutes') {
    const recAbs = join(dirname(abs), `会议记录 - ${title}.md`);
    try {
      await fs.access(recAbs);
      transcriptAbs = recAbs;
    } catch { /* 没有转写文件 */ }
  }
  const transcript = transcriptAbs === abs ? mdText : await fs.readFile(transcriptAbs, 'utf-8');
  const { audio, merged } = await findReplayAudio(transcriptAbs, transcript, source, title, cache);
  return { title, name: basename(abs), transcript, transcriptPath: toClient(transcriptAbs), audio, merged };
}

/** 只发客户端需要的字段（abs 是服务端内部字段） */
const pubAudio = (a: ReplayAudio) => ({ source: a.source, path: a.path, name: a.name, size: a.size });

/**
 * 回放产物 → 认人所需的录音上下文：同一份音频（分离就是按它跑的）、项目根、分离模式。
 * 音频口径与 retranscribe 一致（合并件优先，否则单片）——分离缓存就是按这个文件的哈希写的；
 * 多片且无合并件时定位不到单一音频 → null（退回匿名，不硬猜）。
 * 分离模式为 solo（或未配置）时也返回 null：那场根本没贴过说话人标签，没有可认的对象。
 */
async function replayRecordingContext(source: 'local' | 'project', r: Awaited<ReturnType<typeof loadReplay>>) {
  const audioAbs = r.merged?.abs ?? (r.audio.length === 1 ? r.audio[0].abs : null);
  if (!audioAbs) return null;
  const { diarModeOf } = await import('@/lib/stt/diarize');
  const mode = diarModeOf(meetingSettingsOf(await readSettingsFromFile()).speakers);
  if (!mode) return null;
  const projectRoot = source === 'project' ? (await getCurrentProject()).path : butlerRoot();
  return { audioAbs, projectRoot, mode };
}

/**
 * 「要跑重活」的两个写口（命名 / 点名分析）的公共前置：录音上下文 + ffmpeg。
 * 拿到 ctx 才能知道分离缓存该按哪个文件的哈希去查（见 replayRecordingContext）。
 */
async function replayCtxWithFfmpeg(source: 'local' | 'project', r: Awaited<ReturnType<typeof loadReplay>>) {
  const ctx = await replayRecordingContext(source, r);
  if (!ctx) return { error: 'this recording has no single audio source to identify speakers from' } as const;
  const ffmpegPath = await (await import('@/lib/parse/audio-parser')).resolveFfmpegPath();
  if (!ffmpegPath) return { error: 'ffmpeg is unavailable' } as const;
  return { ctx, ffmpegPath } as const;
}

/**
 * 说话人名单（回放时算）：每簇一行——库里有名字就带上（含相似度），认不出则 name=null，
 * 由客户端显示匿名「Speaker N」。
 *
 * **只读分离缓存、不触发分离**：回放不该替用户决定跑一次几十秒的重活。老录音（DIAR_VERSION
 * 升级后缓存失效）或分离资产未就绪时名单为空，客户端据此显示 Identify speakers 按钮，
 * 由用户点了才走 speaker_identify。
 */
async function speakerRoster(source: 'local' | 'project', r: Awaited<ReturnType<typeof loadReplay>>) {
  const ctx = await replayRecordingContext(source, r);
  if (!ctx) return [];
  const { readDiarClusters } = await import('@/lib/stt/diarize');
  const clusters = await readDiarClusters(ctx.audioAbs, ctx.projectRoot, ctx.mode);
  if (!clusters || clusters.length === 0) return [];
  const { readSpeakerLibrary, matchCluster } = await import('@/lib/stt/speaker-lib');
  const lib = await readSpeakerLibrary(ctx.projectRoot);
  return clusters.map((c) => {
    const hit = matchCluster(c.centroid, lib);
    return {
      speaker: c.speaker, // 0 基簇号（写口回传用）
      n: c.speaker + 1, // 1 基显示号，与文稿里的 `[说话人 N]` 同口径
      name: hit?.name ?? null,
      similarity: hit ? Number(hit.similarity.toFixed(3)) : null,
      confidence: c.confidence === null ? null : Number(c.confidence.toFixed(3)),
    };
  });
}

/**
 * 递归收集某根目录下的会议产物 md（深度受限，跳过隐藏目录与内部目录）。
 * 为什么按文件扫而不是读收件箱：收件箱没存产物路径，撑不起「点开即打开文件」；
 * 而产物本来就在落点目录里，扫盘能拿到真实路径，也天然覆盖本次改动之前已有的历史。
 */
async function collectMeetingFiles(
  dir: string,
  depth: number,
  mk: (abs: string) => { source: 'project' | 'local'; path: string; place: string },
  out: MeetingHistoryEntry[],
  cache: DirCache,
): Promise<void> {
  if (depth < 0) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await collectMeetingFiles(abs, depth - 1, mk, out, cache);
      continue;
    }
    const m = MEETING_FILE_RE.exec(e.name);
    if (!m) continue;
    let time = 0;
    try {
      time = (await fs.stat(abs)).mtimeMs;
    } catch { /* 取不到用 0（排到末尾） */ }
    out.push({
      name: e.name,
      title: m[2],
      kind: kindOfPrefix(m[1]),
      time,
      // 有录音才在 History 行出播放入口（真实回放仍以 replay_audio 的结果为准）
      hasAudio: await detectHasAudio(abs, m[2], cache),
      ...mk(abs),
    });
  }
}

/** 落点说法：`Butler / meetings`、`Project / homework`（直接在根下时不带子目录） */
function placeLabel(prefix: string, relDir: string): string {
  return relDir ? `${prefix} / ${relDir}` : prefix;
}

/** 过往会议产物（新→旧，上限 30 条）：两个落点各扫一遍——butler 根 + 当前项目根 */
async function listMeetingHistory(): Promise<MeetingHistoryEntry[]> {
  const out: MeetingHistoryEntry[] = [];
  const cache: DirCache = new Map();
  const root = butlerRoot();
  await collectMeetingFiles(root, 4, (abs) => ({
    source: 'local',
    path: abs,
    place: placeLabel('Butler', relative(root, dirname(abs))),
  }), out, cache);
  try {
    const project = await getCurrentProject();
    const base = project.path;
    await collectMeetingFiles(base, 4, (abs) => ({
      source: 'project',
      path: relative(base, abs),
      place: placeLabel('Project', relative(base, dirname(abs))),
    }), out, cache);
  } catch { /* 没有当前项目时只给 butler 侧 */ }
  out.sort((a, b) => b.time - a.time);
  return out.slice(0, 30);
}

/**
 * 长任务动作要放宽 maxDuration：批量补标点要串行 spawn 多次标点 CLI（每次 0.15–0.32s，长会议上百段），
 * retranscribe 更重（合并 + 离线批量模型逐窗整段重转，可达数分钟）。其余动作都是毫秒级，不受影响。
 * 注：该值只在 serverless 部署上被强制；本地桌面端不因超时中断。
 */
export const maxDuration = 1800;

export async function GET() {
  try {
    const snapshot = await getMeetingSnapshot();
    return NextResponse.json({ success: true, ...snapshot });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/meeting] 读取会议状态失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      action?: string;
      text?: string;
      type?: MeetingMessage['type'];
      label?: string;
      title?: string;
      outputKind?: 'project' | 'butler';
      outputDir?: string;
      path?: string;
      content?: string;
      encoding?: string;
      settings?: Record<string, unknown>;
      /** 导入录音模式：项目内 materials/ 下的音频相对路径 + 转写时间窗（秒） */
      audioPath?: string;
      /** 文本转播客：项目内 materials/ 下的 md/txt 相对路径 */
      sourcePath?: string;
      /** 文本转播客：双主播互动形式（qa|relay|debate|chat，缺省/非法回落 qa） */
      form?: string;
      /** 文本转播客：两位主播的音色 id（见 podcast_voices；缺省 = 自动派生） */
      voiceA?: string;
      voiceB?: string;
      startSec?: number;
      endSec?: number;
      /** 追加内容在录音时间轴上的发生时刻（绝对毫秒，实时字幕用段起点传入，供回放对齐） */
      time?: number;
      /** 回放：产物所在侧（local = butler 根下相对路径；project = 项目内相对路径） */
      source?: 'local' | 'project';
      /** 归档检索（search）：关键词（多词按 AND）+ 命中上限（默认 10，钳到 30） */
      query?: string;
      limit?: number;
      /** 批量补标点（punctuate）：待处理的正文数组，按序一一对应返回 */
      texts?: string[];
      /** 说话人命名（speaker_name）：0 基簇号（来自 replay_audio 的 speakers[].speaker）+ 新名字 */
      speaker?: number;
      name?: string;
    };
    const action = String(body.action || '');

    // 会议专属设置（录音源 / 参会人数 / 会后自动整理）：整体读写 settings.json 的 meeting 字段
    if (action === 'settings_get') {
      return NextResponse.json({ success: true, settings: meetingSettingsOf(await readSettingsFromFile()) });
    }
    if (action === 'settings_set') {
      const cur = await readSettingsFromFile();
      const merged = meetingSettingsOf({ ...cur, meeting: { ...cur.meeting, ...(body.settings || {}) } as typeof cur.meeting });
      await writeSettingsToFile({ ...cur, meeting: merged });
      return NextResponse.json({ success: true, settings: merged });
    }

    // 过往会议产物（面板 History 列表；打开时才拉，返回新→旧最多 30 条）
    if (action === 'history') {
      return NextResponse.json({ success: true, meetings: await listMeetingHistory() });
    }

    // 会议归档检索（**记录员 Recorder 专用**；面板 History 走上面的 history，不走这里）。
    // 无 query = 最近会议清单；有 query = 跨会议正文检索。
    // 检索是**确定性匹配**（大小写不敏感子串，多词按 AND）——会议量低频，为它单独建向量索引不划算；
    // 性能靠 listMeetingHistory 自身的上限兜底（depth=4、新→旧 30 条），命中到 limit 即停。
    if (action === 'search') {
      const meetings = await listMeetingHistory();
      const limit = Math.min(Math.max(Math.floor(Number(body.limit)) || 10, 1), 30);
      const terms = String(body.query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length === 0) {
        return NextResponse.json({
          success: true,
          total: meetings.length,
          query: '',
          hits: meetings.slice(0, limit).map((m) => ({ ...briefEntry(m), snippet: '' })),
        });
      }
      const hits: Array<ReturnType<typeof briefEntry> & { snippet: string }> = [];
      for (const m of meetings) {
        if (hits.length >= limit) break;
        let text: string;
        try {
          const { abs } = await resolveInSide(m.source, m.path);
          text = stripMeetingMarkup(await fs.readFile(abs, 'utf-8'));
        } catch {
          continue; // 单条读不到（已删/无权限）不影响其余命中
        }
        const flat = text.replace(/\s+/g, ' ').trim();
        const lower = flat.toLowerCase();
        if (!terms.every((t) => lower.includes(t))) continue;
        hits.push({ ...briefEntry(m), snippet: makeSnippet(flat, terms) });
      }
      return NextResponse.json({ success: true, total: meetings.length, query: String(body.query || '').trim(), hits });
    }

    // 会议归档阅读（**记录员 Recorder 专用**）：取某场全文，剥掉音频指针与时间戳。
    // 收口与 delete / replay 同款：路径须落在对应根内（resolveInSide，越界即抛），且文件名必须是会议产物。
    if (action === 'read') {
      const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
      const rel = String(body.path || '').trim();
      if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
      const { abs } = await resolveInSide(source, rel);
      if (!MEETING_FILE_RE.test(basename(abs))) {
        return NextResponse.json({ success: false, error: 'not a meeting record' }, { status: 403 });
      }
      const info = parseMeetingFileName(basename(abs));
      let time = 0;
      try {
        time = (await fs.stat(abs)).mtimeMs;
      } catch { /* 取不到按 0 */ }
      return NextResponse.json({
        success: true,
        title: info?.title ?? basename(abs).replace(/\.md$/i, ''),
        kind: info?.kind ?? 'transcript',
        source,
        path: rel,
        time,
        text: stripMeetingMarkup(await fs.readFile(abs, 'utf-8')),
      });
    }

    // 删除一条历史产物：删这一份 md，并回收它引用的本地音频（不留孤儿文件）。
    // 双重收口：路径必须落在对应根内（resolveInSide，越界即抛），且文件名必须是会议产物，
    // 避免这个动作被当成「删除任意文件」的口子。音频清单必须在删 md 之前算好——指针就在它的首行。
    // 删任一份产物都会一并回收该场次录音（用户拍板：不留孤儿文件；代价是同场次另一份产物的 ▶ 回放入口随之消失）。
    if (action === 'delete') {
      const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
      const rel = String(body.path || '').trim();
      if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
      const { abs } = await resolveInSide(source, rel);
      const self = basename(abs);
      if (!MEETING_FILE_RE.test(self)) {
        return NextResponse.json({ success: false, error: 'not a meeting record' }, { status: 403 });
      }
      const title = parseMeetingFileName(self)?.title || self.replace(/\.md$/i, '');
      const audio = await collectMeetingAudio(abs, title);
      await fs.rm(abs, { force: true });
      return NextResponse.json({ success: true, removed: await removeMeetingAudio(audio) });
    }

    // ---- 回放（录音播放器 + 字幕联动）----
    // path = History 里点开的那份产物（source 决定它在哪一侧）；带戳转写与音频清单一次性返回。
    if (action === 'replay_audio') {
      const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
      const rel = String(body.path || '').trim();
      if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
      const r = await loadReplay(source, rel, new Map());
      return NextResponse.json({
        success: true,
        title: r.title,
        name: r.name,
        transcript: r.transcript,
        transcriptPath: r.transcriptPath,
        audio: r.audio.map(pubAudio),
        merged: r.merged ? pubAudio(r.merged) : null,
        missing: r.audio.length === 0 && !r.merged,
        speakers: await speakerRoster(source, r),
      });
    }

    // ---- 给某场录音的某个说话人命名（身份层写口）----
    // 把该簇的声纹质心写进项目声纹库，于是同一人在**别的**录音里也能被认出来；返回更新后的名单。
    if (action === 'speaker_name') {
      const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
      const rel = String(body.path || '').trim();
      const name = String(body.name || '').trim();
      const speaker = Number(body.speaker);
      if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
      if (!name) return NextResponse.json({ success: false, error: 'name is required' });
      if (!Number.isInteger(speaker) || speaker < 0) return NextResponse.json({ success: false, error: 'speaker is required' });
      const r = await loadReplay(source, rel, new Map());
      const pre = await replayCtxWithFfmpeg(source, r);
      if ('error' in pre) return NextResponse.json({ success: false, error: pre.error });
      const { ctx, ffmpegPath } = pre;
      // 缓存命中则秒回；被容量清理时这里会补跑一次分离（用户显式命名，允许一次较重的等待）
      const { ensureDiarization, readDiarClusters } = await import('@/lib/stt/diarize');
      await ensureDiarization(ctx.audioAbs, ctx.projectRoot, ctx.mode, { ffmpegPath });
      const clusters = await readDiarClusters(ctx.audioAbs, ctx.projectRoot, ctx.mode);
      const target = clusters?.find((c) => c.speaker === speaker);
      if (!target) {
        return NextResponse.json({ success: false, error: 'unknown speaker cluster — this recording may not be labeled by speaker' });
      }
      // 语义是「把这一簇归到这个名字」而非「给库里那条记录改名」：认错人时改成正确的名字，
      // 会挂到那个人的记录上（同名按 count 加权平均），被错认的那条记录不受影响。
      const { readSpeakerLibrary, upsertSpeaker, writeSpeakerLibrary } = await import('@/lib/stt/speaker-lib');
      const lib = upsertSpeaker(await readSpeakerLibrary(ctx.projectRoot), name, target.centroid);
      await writeSpeakerLibrary(ctx.projectRoot, lib);
      return NextResponse.json({ success: true, speakers: await speakerRoster(source, r) });
    }

    // ---- 为老录音补跑一次分离（身份层「点名分析」口）----
    // replay_audio 的名单只读缓存，故升级前录的会议没有 v3 缓存 → 名单为空；用户点按钮才走这里。
    if (action === 'speaker_identify') {
      const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
      const rel = String(body.path || '').trim();
      if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
      const r = await loadReplay(source, rel, new Map());
      const pre = await replayCtxWithFfmpeg(source, r);
      if ('error' in pre) return NextResponse.json({ success: false, error: pre.error });
      const { ctx, ffmpegPath } = pre;
      // 失败（资产未就绪/分离不可用）不报错：名单保持为空，客户端显示一句「分析不出」即可
      const { ensureDiarization } = await import('@/lib/stt/diarize');
      await ensureDiarization(ctx.audioAbs, ctx.projectRoot, ctx.mode, { ffmpegPath });
      return NextResponse.json({ success: true, speakers: await speakerRoster(source, r) });
    }

    // 合并分片成一个 webm（写回分片同目录的 `录音 - <标题>.webm`），供播放器优先加载
    if (action === 'concat_audio') {
      const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
      const rel = String(body.path || '').trim();
      if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
      const r = await loadReplay(source, rel, new Map());
      if (r.merged) return NextResponse.json({ success: true, merged: pubAudio(r.merged) });
      if (r.audio.length === 0) return NextResponse.json({ success: false, error: 'no audio parts found' });
      const ffmpegPath = await (await import('@/lib/parse/audio-parser')).resolveFfmpegPath();
      if (!ffmpegPath) return NextResponse.json({ success: false, error: 'ffmpeg is unavailable' });
      const dir = dirname(r.audio[0].abs);
      const side = r.audio[0].source;
      const { toClient } = await replaySide(side);
      const outAbs = await mergeParts(r.audio, r.title, ffmpegPath, dir);
      return NextResponse.json({ success: true, merged: pubAudio(await audioEntry(side, toClient, outAbs)) });
    }

    if (action === 'start') {
      const ok = await startMeeting(body.title, { kind: body.outputKind, dir: body.outputDir });
      if (!ok) return NextResponse.json({ success: false, error: 'a meeting is already active' });
      return NextResponse.json({ success: true });
    }

    if (action === 'append') {
      const text = String(body.text || '').trim();
      if (!text) return NextResponse.json({ success: false, error: 'empty text' });
      const count = await appendToMeeting({ text, type: body.type ?? 'text', label: body.label, time: body.time });
      if (count < 0) return NextResponse.json({ success: false, error: 'no active meeting' });
      return NextResponse.json({ success: true, count });
    }

    if (action === 'write') {
      const rel = String(body.path || '').trim();
      if (!rel) return NextResponse.json({ success: false, error: 'path is required' });
      const root = butlerRoot();
      const full = resolve(root, rel);
      // 穿越防护：解析后必须仍在 butler 根内
      if (full !== root && !full.startsWith(root + '/')) {
        return NextResponse.json({ success: false, error: 'path escapes butler root' }, { status: 403 });
      }
      if (body.content === undefined) return NextResponse.json({ success: false, error: 'content is required' });
      await fs.mkdir(dirname(full), { recursive: true });
      if (body.encoding === 'base64') {
        await fs.writeFile(full, Buffer.from(String(body.content), 'base64'));
      } else {
        await fs.writeFile(full, String(body.content), 'utf-8');
      }
      // 返回绝对路径（客户端打开文件用）
      return NextResponse.json({ success: true, absPath: full });
    }

    if (action === 'end') {
      const ended = await endMeeting();
      if (!ended) return NextResponse.json({ success: false, error: 'no active meeting' });
      const settings = meetingSettingsOf(await readSettingsFromFile());
      // 带 `[mm:ss]` 时间戳的全文转写：客户端据此落盘（回放字幕的时间轴来源）。
      // 说话人分块不在这里：**会议进行中不做说话人识别**，`[说话人 N]` 一律来自会后的整段重转
      // （见下面的 retranscribe；重转不可用时这份兜底产物自然就没有说话人，这是有意的口径）。
      const transcript = formatTimestampedTranscript(ended);
      // segments：逐条给客户端「时间戳 + 类型 + 正文」——会议结束后只给语音段补标点（手打文本不送模型），
      // 时间戳在服务端算好（与 transcript 同一口径），客户端不必重算时间轴。
      const segments = ended.messages.map((m) => {
        const sec = Math.max(0, Math.floor((m.time - ended.startedAt) / 1000));
        const ts = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
        return { ts, type: m.type, text: m.text };
      });
      const output = { outputKind: ended.outputKind, outputDir: ended.outputDir };
      // 无内容会议：不整理（与 /meeting out 口径一致），仅返回标题
      if (ended.messages.length === 0) {
        return NextResponse.json({ success: true, title: ended.title, transcript: '', segments: [], autoSummarize: false, ...output });
      }
      // 只结束会话并回传转写：纪要生成改由客户端随后单独请求（见下面的 summarize）。
      // 为什么拆开：模型整理可能跑十几秒，拆开后控制台能立刻让位给 History 并显示「生成中」。
      return NextResponse.json({ success: true, title: ended.title, transcript, segments, autoSummarize: settings.autoSummarize, ...output });
    }

    // 会议结束后统一补标点（客户端后台调用）：只给**语音段**的正文补句读。
    // 未装标点模型时 punctuateText 原样返回 = 空操作；单段失败也保留原文，绝不因此丢内容。
    if (action === 'punctuate') {
      const raw = Array.isArray(body.texts) ? body.texts : [];
      // 上限防护：常驻标点服务虽快（~7ms/段），段数/总长过大仍会长时间占住这个请求
      if (raw.length > 500) return NextResponse.json({ success: false, error: 'too many segments (max 500)' });
      const texts = raw.map((t) => String(t ?? ''));
      if (texts.reduce((n, t) => n + t.length, 0) > 200000) {
        return NextResponse.json({ success: false, error: 'text too long (max 200000 chars)' });
      }
      const { punctuateText } = await import('@/lib/stt/sherpa');
      const out: string[] = [];
      for (const t of texts) {
        if (!t.trim()) { out.push(t); continue; }
        try {
          out.push((await punctuateText(t)) || t);
        } catch {
          out.push(t); // 单段失败：保留原文
        }
      }
      return NextResponse.json({ success: true, texts: out });
    }

    // 实时会议结束后的纪要整理（客户端后台单独调用；只回minutes，不落盘——落盘口径与实时模式一致，由客户端写）
    if (action === 'summarize') {
      const title = String(body.title || '').trim() || '未命名会议';
      const text = String(body.text || '').trim();
      const settings = meetingSettingsOf(await readSettingsFromFile());
      // 「会后自动整理」关闭 / 无内容：不调模型、不伪造纪要结构
      if (!text || !settings.autoSummarize) {
        return NextResponse.json({ success: true, minutes: '', summarized: false });
      }
      const minutes = await finalizeMeetingText(title, text, undefined, settings.speakers);
      return NextResponse.json({ success: true, minutes, summarized: true });
    }

    // ---- 结束后用录音整体重转（离线**批量**模型；客户端后台调用）----
    // 流式 zipformer 只给裸字；录音分片本来就在盘上，用批量模型整段重转更准，且引擎时间戳是
    // 「合并音频内部」的时间轴——用户按过 Pause 时，墙钟戳会与录音漂移，重转后回放反而更对齐。
    //
    // 响应是 **NDJSON 流**（不是一次性 JSON）：长会议要跑几十秒到几分钟，客户端据此显示进度。
    // 每行一个对象：{t:'progress',doneSec,totalSec} … 收尾是 {t:'done',transcript,plain} 或
    // {t:'skip',reason}。任何前置条件不满足都走 skip，由客户端保留流式原文——重转是增强项，
    // 绝不阻断会议收尾。
    //
    // 超 100MB 的录音不再直接放弃（parseAudio 的 100MB 上限是对**整段**判的，窗口化绕不过）：
    // 先按实测码率反推一个安全片长，用 ffmpeg 切成多个小片分别转写，再把片内时间戳平移到
    // 合并音频时间轴（shiftTranscriptStamps）。回放仍用原始合并件，转写只读这些临时片。
    if (action === 'retranscribe') {
      const source: 'local' | 'project' = body.source === 'project' ? 'project' : 'local';
      const rel = String(body.path || '').trim();
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (obj: Record<string, unknown>) => {
            // 长流期间客户端可能已经走了（关面板/退出）：enqueue 会抛，吞掉即可，别让收尾逻辑崩
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
            } catch { /* 客户端已断开 */ }
          };
          const skip = (reason: string) => send({ t: 'skip', reason });
          const tempDirs: string[] = [];
          try {
            if (!rel) return skip('no-path');

            const r = await loadReplay(source, rel, new Map());
            if (r.audio.length === 0) return skip('no-audio');
            const parts = r.audio;
            const dir = dirname(parts[0].abs);

            const { probeAudioDurationSec, resolveFfmpegPath } = await import('@/lib/parse/audio-parser');
            const ffmpegPath = await resolveFfmpegPath();
            if (!ffmpegPath) return skip('no-ffmpeg');

            // 选待重转的音频：已有合并件直接复用（不重复合并 → 内容 hash 稳定 → .cache/parse 命中）；
            // 单分片会议没有合并件，直接用那一片。
            let audioAbs: string;
            if (r.merged) {
              audioAbs = r.merged.abs;
            } else if (parts.length > 1) {
              audioAbs = await mergeParts(parts, r.title, ffmpegPath, dir);
            } else {
              audioAbs = parts[0].abs;
            }

            // 与 parseAudio 的 MAX_FILE_BYTES（未导出）同源
            const FILE_CAP = 100 * 1024 * 1024;
            const WIN = 25 * 60; // 单文件内的转写窗口：引擎单次上限 30 分钟，留足余量（与导入录音同口径）

            let size = 0;
            try {
              size = (await fs.stat(audioAbs)).size;
            } catch {
              return skip('audio-missing');
            }
            const fullDur = await probeAudioDurationSec(audioAbs);
            if (fullDur === null || fullDur <= 0) return skip('no-duration');

            // 本地离线**批量**模型就绪校验（parseAudio 走 sherpa-local 时会自己再查一次；这里提前查是为了体面跳过）。
            // 放在切片之前：不可用时直接返回，不必白做一遍 ffmpeg 切分。
            const settings = await readSettingsFromFile();
            const stt = settings.stt;
            const modelId = stt?.provider === 'sherpa-local' ? stt.localModel : undefined;
            const { findLocalModel, isBatchModel, isLocalSttModelReady, isLocalSttBinaryInstalled } = await import('@/lib/stt/sherpa');
            const def = findLocalModel(modelId);
            if (!stt || stt.provider !== 'sherpa-local' || !def || !isBatchModel(def)) return skip('no-batch-model');
            if (!(await isLocalSttBinaryInstalled()) || !(await isLocalSttModelReady(def.id))) return skip('model-not-ready');

            // 切出「待转写片段」：不超限就是整段一个片段（offset 0）；超限则等分成小片。
            // 片长按实测字节/秒反推，取上限的一半——-segment_time 会在下一个关键帧才落刀，
            // 实际片长可能超出设定值，留一倍余量保证任何一片都不碰 100MB 上限。
            const slices: { abs: string; offsetSec: number; durationSec: number }[] = [];
            if (size <= FILE_CAP) {
              slices.push({ abs: audioAbs, offsetSec: 0, durationSec: fullDur });
            } else {
              const segSec = Math.max(
                60,
                Math.min(20 * 60, Math.floor((FILE_CAP / 2) / (size / fullDur))),
              );
              const tmp = join(tmpdir(), `bob-retrans-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
              await fs.mkdir(tmp, { recursive: true });
              tempDirs.push(tmp);
              const pattern = join(tmp, 'seg-%03d.webm');
              const base = ['-y', '-i', audioAbs, '-f', 'segment', '-segment_time', String(segSec)];
              try {
                await execFileAsync(ffmpegPath, [...base, '-c', 'copy', pattern], { timeout: CONCAT_TIMEOUT_MS });
              } catch {
                // 流拷贝失败（容器/关键帧不配合）→ 重编码成 32k 单声道 opus：语音转写足够，体积可控
                await execFileAsync(
                  ffmpegPath,
                  [...base, '-c:a', 'libopus', '-b:a', '32k', '-vn', pattern],
                  { timeout: CONCAT_TIMEOUT_MS },
                );
              }
              const names = (await fs.readdir(tmp)).filter((n) => n.startsWith('seg-')).sort();
              let offset = 0;
              for (const n of names) {
                const abs = join(tmp, n);
                const d = await probeAudioDurationSec(abs);
                if (d === null || d <= 0) continue;
                slices.push({ abs, offsetSec: Math.min(offset, fullDur), durationSec: d });
                offset += d;
              }
              if (slices.length === 0) return skip('split-failed');
              // 兜底：切片仍超限（极端码率/关键帧稀疏）→ 放弃，而不是让 parseAudio 抛错
              for (const s of slices) {
                const sz = (await fs.stat(s.abs)).size;
                if (sz > FILE_CAP) return skip('too-large');
              }
            }

            // parseAudio 只用 projectPath 定位 .cache/parse 与 .cache/diar，故 butler 侧录音也传项目根即可
            const projectRoot = source === 'project' ? (await getCurrentProject()).path : butlerRoot();
            const { parseAudio } = await import('@/lib/parse/audio-parser');
            const { diarModeOf } = await import('@/lib/stt/diarize');
            const { shiftTranscriptStamps } = await import('@/lib/core/meeting-session');
            const mode = diarModeOf(meetingSettingsOf(settings).speakers);

            const totalSec = fullDur;
            const stamped: string[] = [];
            let doneSec = 0;
            send({ t: 'progress', doneSec: 0, totalSec });
            for (const slice of slices) {
              const sliceDur = slice.durationSec;
              for (let s = 0; s < sliceDur; s += WIN) {
                const end = Math.min(s + WIN, sliceDur);
                const res = await parseAudio(slice.abs, projectRoot, {
                  stt,
                  rangeStartSec: s,
                  rangeEndSec: end,
                  ...(mode ? { diarize: mode } : {}),
                });
                // plain_text 已含引擎的 [mm:ss]（窗口请求下即**片内**时间轴）；切片场景再整体平移到合并音频时间轴
                const shifted = shiftTranscriptStamps(String(res.plain_text || '').trim(), slice.offsetSec);
                if (shifted) stamped.push(shifted);
                doneSec = Math.min(slice.offsetSec + end, totalSec);
                send({ t: 'progress', doneSec, totalSec });
              }
            }
            const transcript = stamped.join('\n\n').trim();
            if (!transcript) return skip('empty');
            const plain = transcript.replace(/^\[\d{1,3}:\d{2}\]\s*$/gm, '').replace(/\n{2,}/g, '\n').trim();
            send({ t: 'done', transcript, plain, durationSec: totalSec });
          } catch (e) {
            console.error('retranscribe error:', e);
            skip('error');
          } finally {
            for (const d of tempDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
            try {
              controller.close();
            } catch { /* 已关闭/已断开 */ }
          }
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    // ---- 导入录音模式（会议面板 Import）：选 materials 里的音频 → 分段转写 → 同一出口出纪要 ----
    // 为什么分段交给客户端驱动：长音频（>30 分钟）必须按窗口串行转写，
    // 一次请求跑完整场会既看不到进度、也无法取消（见 MeetingStart 的导入流程）。
    if (action === 'import_probe') {
      const rel = String(body.audioPath || '').trim();
      if (!rel) return NextResponse.json({ success: false, error: 'audioPath is required' });
      const { abs, projectRoot } = await resolveMaterialsAudio(rel);
      const { probeAudioDurationSec, resolveFfmpegPath } = await import('@/lib/parse/audio-parser');
      // ffmpeg 不可用 → null，客户端退化为「单次整段转写」（>30 分钟会被引擎明确拒绝）
      const durationSec = await probeAudioDurationSec(abs);
      // 说话人分离在「探时长」这一步就对**整段**音频跑一次（结果缓存到 .cache/diar/，各窗口只从缓存切片）：
      // ① 长等待集中在这里，后面的窗口转写不再重复分离；② 整段只聚一次类，编号跨窗口才一致。
      // 失败/未下载资产时 ensureDiarization 自己吞错返回 null，这里不影响 durationSec 的返回。
      const settings = meetingSettingsOf(await readSettingsFromFile());
      const { diarModeOf, ensureDiarization } = await import('@/lib/stt/diarize');
      const mode = diarModeOf(settings.speakers);
      if (mode) {
        const ffmpegPath = await resolveFfmpegPath();
        if (ffmpegPath) await ensureDiarization(abs, projectRoot, mode, { ffmpegPath });
      }
      return NextResponse.json({ success: true, durationSec });
    }

    if (action === 'import_segment') {
      const rel = String(body.audioPath || '').trim();
      if (!rel) return NextResponse.json({ success: false, error: 'audioPath is required' });
      const { abs, projectRoot } = await resolveMaterialsAudio(rel);
      const settings = await readSettingsFromFile();
      const { parseAudio } = await import('@/lib/parse/audio-parser');
      // 与 import_probe 用**同一份**会议设置换算分离参数：两处若不同源，同一音频会按不同参数分离两次、编号还可能对不上
      const { diarModeOf } = await import('@/lib/stt/diarize');
      const mode = diarModeOf(meetingSettingsOf(settings).speakers);
      const ranged = typeof body.startSec === 'number' && typeof body.endSec === 'number';
      const result = await parseAudio(abs, projectRoot, {
        stt: settings.stt,
        ...(ranged ? { rangeStartSec: body.startSec, rangeEndSec: body.endSec } : {}),
        ...(mode ? { diarize: mode } : {}),
      });
      // plain_text 已含引擎的段级 `[mm:ss]`（窗口请求下是绝对秒）与可选的 `[说话人 N]`；
      // 时间戳由客户端按需取用/剥离（送模型剥掉、落盘保留），这里不做二次加工。
      return NextResponse.json({ success: true, text: String(result.plain_text || '') });
    }

    if (action === 'import_finish') {
      const title = String(body.title || '').trim() || '未命名会议';
      const text = String(body.text || '').trim();
      if (!text) return NextResponse.json({ success: false, error: 'empty text' });
      const settings = meetingSettingsOf(await readSettingsFromFile());
      // 「会后自动整理」关闭时与实时模式同口径：只留全文转写，不调模型、不伪造纪要结构
      if (!settings.autoSummarize) {
        await recordTranscriptText(title, text);
        return NextResponse.json({ success: true, minutes: '', summarized: false });
      }
      const minutes = await finalizeMeetingText(title, text, undefined, settings.speakers);
      return NextResponse.json({ success: true, minutes, summarized: true });
    }

    // ---- 文本转播客：列举当前引擎下两位主播的可选音色（Meeting 面板的 Host A / Host B 下拉）----
    // TTS 配置在服务端文件里、本地模型定义与内置参考音都是服务端模块，客户端 import 不到，只能由这里探测后回传。
    if (action === 'podcast_voices') {
      const { listPodcastVoices } = await import('@/lib/core/podcast');
      const choices = await listPodcastVoices((await readSettingsFromFile()).tts);
      return NextResponse.json({ success: true, ...choices });
    }

    // ---- 文本转播客（会议面板 Text to podcast）：materials 里的 md/txt → 双人对谈脚本 → 逐句 TTS → 拼成一段音频 ----
    // 响应是 **NDJSON 流**（同 retranscribe）：出脚本 + 几十次合起来要跑几十秒到几分钟，客户端据此显示进度并可 Cancel。
    // 音频落 butler/podcast/（长期产物，与 butler/tts 的 7 天临时件分立）；伴生 md 由客户端写进用户选的落点——
    // md 首行带 `local:podcast/…` 指针，于是 History 列表、▶ 回放、删除守卫全部零改动复用会议那一套。
    if (action === 'podcast_generate') {
      const sourcePath = String(body.sourcePath || '').trim();
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (obj: Record<string, unknown>) => {
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
            } catch { /* 客户端已断开 */ }
          };
          // 逐句合成的中间件（butler/tts 下的临时产物）：无论成功、失败还是取消都要回收
          const parts: string[] = [];
          const dropParts = () => Promise.all(parts.map((p) => fs.rm(p, { force: true }).catch(() => undefined)));
          try {
            const { abs, name } = await resolveMaterialsText(sourcePath);
            const title = String(body.title || '').trim() || name.replace(/\.[^.]+$/, '');
            const { toSpeakableText, chunkForSpeech } = await import('@/lib/tts/plain-text');
            const text = toSpeakableText(await fs.readFile(abs, 'utf-8'));
            if (!text.trim()) {
              send({ t: 'error', error: 'The selected document has no readable text.' });
              return;
            }

            const { generatePodcastScript, resolveHostVoices, speechChunkCharsFor, isPodcastForm } = await import('@/lib/core/podcast');
            send({ t: 'progress', phase: 'script' });
            // 形式（双主播互动方式）：非法/缺省一律回落 qa（与历史行为一致）
            const form = isPodcastForm(body.form) ? body.form : 'qa';
            const { lines } = await generatePodcastScript(title, text, form);
            // 音色在合成前解析：未配置 TTS 会在这里就明确报错，不必等第一句合成失败
            const tts = (await readSettingsFromFile()).tts;
            const { hostA, hostB, note } = await resolveHostVoices(tts, {
              ...(String(body.voiceA || '').trim() ? { hostA: String(body.voiceA).trim() } : {}),
              ...(String(body.voiceB || '').trim() ? { hostB: String(body.voiceB).trim() } : {}),
            });
            if (request.signal.aborted) throw new Error('cancelled');

            // 展开成合成任务：一句可能切成多段（引擎单次 2000 字符上限），但同一句共用一条音色
            const max = speechChunkCharsFor(tts);
            const jobs: Array<{ text: string; voice: TtsSettings }> = [];
            for (const line of lines) {
              const voice = line.speaker === 'B' ? hostB : hostA;
              for (const chunk of chunkForSpeech(line.text, max)) jobs.push({ text: chunk, voice });
            }
            if (jobs.length === 0) {
              send({ t: 'error', error: 'The generated script is empty — try again.' });
              return;
            }

            const { synthesizeSpeech } = await import('@/lib/tts');
            send({ t: 'progress', phase: 'tts', done: 0, total: jobs.length });
            for (let i = 0; i < jobs.length; i++) {
              if (request.signal.aborted) throw new Error('cancelled');
              const res = await synthesizeSpeech(jobs[i].text, jobs[i].voice);
              parts.push(res.filePath);
              send({ t: 'progress', phase: 'tts', done: i + 1, total: jobs.length });
            }

            send({ t: 'progress', phase: 'concat' });
            const dir = podcastDir();
            await fs.mkdir(dir, { recursive: true });
            const outAbs = await concatPodcastAudio(parts, `${safeFileStem(title)}-${Date.now()}`, dir);
            const bytes = await fs.stat(outAbs).then((s) => s.size).catch(() => 0);
            await dropParts(); // 成品已落地：中间件立刻回收，不等 /api/tts/speak 的 7 天 TTL 清理
            const { renderPodcastMarkdown } = await import('@/lib/core/podcast');
            send({
              t: 'done',
              title,
              // 伴生 md 由服务端渲染（指针格式只此一处定义），客户端拿到即 writeOutput 落盘
              md: renderPodcastMarkdown(title, lines, `local:podcast/${basename(outAbs)}`),
              audio: { rel: `podcast/${basename(outAbs)}`, name: basename(outAbs), bytes },
              ...(note ? { note } : {}),
            });
          } catch (e) {
            // 失败/取消：清掉本次已生成的中间件（音频只在拼接成功那一刻写出，故不会有半个成品）
            await dropParts();
            const msg = e instanceof Error ? e.message : String(e);
            const readable =
              e instanceof Error && e.name === 'TtsNotConfiguredError'
                ? 'No speech engine is configured. Pick one in Settings → Roles → Audio TTS Model.'
                : msg === 'cancelled'
                  ? 'Cancelled.'
                  : msg;
            send({ t: 'error', error: readable });
          } finally {
            try {
              controller.close();
            } catch { /* 已关闭/已断开 */ }
          }
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    return NextResponse.json({ success: false, error: `unknown action: ${action}` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/meeting] 会议动作失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}