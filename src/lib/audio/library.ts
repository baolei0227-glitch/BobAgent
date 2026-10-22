/**
 * 应用自有音频库（**不进 workspace**）：用户从本地选中的音频复制一份进来再编辑。
 *
 * 布局（全局库 + 复用指纹）：
 *   `<APP_ROOT>/.audio-library/<源名>-<内容指纹>/`
 *     ├── source.<ext>           ← 源音频文件
 *     ├── source.marks.json      ← 源的打点（sidecar 机制不变）
 *     ├── source.peaks.json      ← 源的波形峰值缓存（见 lib/audio/peaks.ts，可随时删）
 *     ├── .clips.json            ← 片段清单 lineage
 *     ├── 片段 - ….webm          ← 切片文件
 *     └── 片段 - ….marks.json    ← 切片打点
 *
 *   - 指纹 = sha1(文件内容) 前 10 位 —— **同一份音频重复导入会命中同一个目录**，
 *     既不堆重复副本，也让此前在它上面打的点 / 截的片段自动接上；
 *   - 每个源音频一个自包含目录：源、打点、片段同居一处，删除即整体清理；
 *   - 外部源（项目 materials / 本地任意路径）的片段也放库内**影子目录**
 *     `<源名>-<路径指纹>/`（无 source.* 文件，不出现在浏览列表中）；
 *   - 点前缀隐藏目录，与 `.stt` / `.tts` 同款，和用户的项目 / 资料 / 作业文件彻底隔离；
 *   - 只接受 AUDIO_EXTS 里的扩展名（与打点/截取同口径），否则编辑器读不了。
 *
 * 只在**服务端**使用（路由层）。
 */
import { basename, dirname, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { resolveAppRoot } from '@/lib/app-root';
import { safeBaseName, AUDIO_EXTS } from './naming';
import { parseClips, serializeClips, sidecarPath, type AudioClipRef } from './marks';
import { parseTranscriptSidecar, type AudioTranscript } from './transcript';
import { isAudioOrigin, type AudioOrigin } from './origin';

/** 应用自有音频库目录名（隐藏，与 .stt / .tts 同款） */
const AUDIO_LIBRARY_DIRNAME = '.audio-library';
/** 每个源目录里的片段清单文件名 */
const INDEX_NAME = '.clips.json';

/** 音频库根目录：<APP_ROOT>/.audio-library */
export function libraryRoot(): string {
  return join(resolveAppRoot(), AUDIO_LIBRARY_DIRNAME);
}

/**
 * 把一份音频内容存进音频库，返回落盘后的**绝对路径**（`<dir>/source.<ext>`）。
 * 同名同内容 → 复用已有目录（幂等）；扩展名不在白名单 → 抛错。
 */
export async function saveToLibrary(originalName: string, data: Buffer): Promise<string> {
  const ext = extname(originalName).toLowerCase();
  if (!AUDIO_EXTS.includes(ext)) throw new Error('only audio files are supported');
  const root = libraryRoot();
  const base = safeBaseName(originalName) || 'audio';
  const hash = createHash('sha1').update(data).digest('hex').slice(0, 10);
  const entryDir = join(root, `${base}-${hash}`);
  const sourceAbs = join(entryDir, `source${ext}`);
  try {
    await fs.access(sourceAbs);
    return sourceAbs; // 同一份音频已在库里，直接复用
  } catch {
    /* 不存在 → 写入 */
  }
  await fs.mkdir(entryDir, { recursive: true });
  await fs.writeFile(sourceAbs, data);
  return sourceAbs;
}

/** 流式计算文件内容指纹（前 10 位；与 `saveToLibrary` 的 Buffer 口径一致） */
function sha1File(fileAbs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1');
    createReadStream(fileAbs)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex').slice(0, 10)));
  });
}

/**
 * 把**磁盘上已有**的一份音频收进音频库（`fork_clip` 用：先 ffmpeg 渲到临时文件，再入库）。
 *
 * 与 `saveToLibrary` 的分工：那个收内存 Buffer（导入小文件）；这个收临时文件（可能是几十 MB 的片段），
 * 不整份读内存 —— 流式算指纹 + rename（跨卷时退回复制）。
 * 同内容已在库里 ⇒ 直接复用已有 `source.*` 并删掉临时文件（fork 同一段两次不会堆副本）。
 */
export async function importFileToLibrary(originalName: string, fileAbs: string): Promise<string> {
  const ext = extname(originalName).toLowerCase();
  if (!AUDIO_EXTS.includes(ext)) throw new Error('only audio files are supported');
  const root = libraryRoot();
  const base = safeBaseName(originalName) || 'audio';
  const hash = await sha1File(fileAbs);
  const entryDir = join(root, `${base}-${hash}`);
  const sourceAbs = join(entryDir, `source${ext}`);
  try {
    await fs.access(sourceAbs);
    await fs.rm(fileAbs, { force: true }); // 已有同内容：临时文件没用了
    return sourceAbs;
  } catch {
    /* 不存在 → 落盘 */
  }
  await fs.mkdir(entryDir, { recursive: true });
  try {
    await fs.rename(fileAbs, sourceAbs);
  } catch {
    // 临时目录与库不在同一卷时 rename 会 EXDEV：退回复制 + 删临时文件
    await fs.copyFile(fileAbs, sourceAbs);
    await fs.rm(fileAbs, { force: true });
  }
  return sourceAbs;
}

/**
 * 某源音频专属的目录（源 + 打点 + 片段同居一处）。
 *
 * - 库内音频（落在 .audio-library/ 下）：dirname(srcAbs) —— 源文件自己的目录；
 * - 外部音频（项目 materials / 本地路径）：影子目录 `<源名>-<路径指纹>/`
 *   （无 source.* 文件，不出现在浏览列表中，仅存它的打点与片段）；
 * - ensure=true 时创建目录。
 */
export async function sourceDir(srcAbs: string, ensure = false): Promise<string> {
  const root = libraryRoot();
  if (srcAbs.startsWith(root + '/')) {
    return dirname(srcAbs); // 库内音频：源文件自己的目录
  }
  // 外部音频：影子目录
  const prefix = safeBaseName(basename(srcAbs)) || 'audio';
  const key = createHash('sha1').update(srcAbs).digest('hex').slice(0, 12);
  const dir = join(root, `${prefix}-${key}`);
  if (ensure) {
    await fs.mkdir(dir, { recursive: true });
    await rememberSourceRef(dir, srcAbs);
  }
  return dir;
}

/** 影子目录里记下来源路径的文件名（用于「清理无主影子目录」判断源是否还在） */
const SOURCE_REF_NAME = '.source-ref.json';

/**
 * 在影子目录里记一次"我是给哪个源音频用的"。
 *
 * 为什么需要：影子目录名里的指纹是 **sha1(绝对路径)**，**不可逆** —— 没有这份记录，
 * 库里那些没有 `source.*` 的目录就无法判断"它的源还在不在"，只能一律当未知。
 * 记录**只在写产物时**落（`sourceDir(..., ensure=true)`），不会出现在只读路径上。
 * 早期目录没有这个文件 ⇒ 一律按"未知"呈现（仍可手动删），不做推测。
 */
async function rememberSourceRef(dirAbs: string, srcAbs: string): Promise<void> {
  const file = join(dirAbs, SOURCE_REF_NAME);
  try {
    const prev = JSON.parse(await fs.readFile(file, 'utf-8')) as { path?: unknown };
    if (prev?.path === srcAbs) return; // 没变就不重写
  } catch {
    /* 不存在/坏了：重写 */
  }
  try {
    await fs.writeFile(file, JSON.stringify({ path: srcAbs, at: new Date().toISOString() }), 'utf-8');
  } catch {
    /* 记不上不影响主流程 */
  }
}

/** fork 来源 sidecar 的文件名（与打点/峰值同级；一个源目录一份） */
const ORIGIN_NAME = '.origin.json';

/**
 * 读某个音频的 fork 来源（没有 / 脏数据 → null）。
 * 只读**产物目录**：库内音频 = 源文件所在目录；库外音频 = 影子目录。
 */
export async function readOrigin(srcAbs: string): Promise<AudioOrigin | null> {
  const dir = await sourceDir(srcAbs, false);
  try {
    const raw: unknown = JSON.parse(await fs.readFile(join(dir, ORIGIN_NAME), 'utf-8'));
    return isAudioOrigin(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 写 fork 来源（只在 `fork_clip` 新建独立音频时写一次） */
export async function writeOrigin(srcAbs: string, origin: AudioOrigin): Promise<void> {
  const dir = await sourceDir(srcAbs, true);
  await fs.writeFile(join(dir, ORIGIN_NAME), JSON.stringify(origin), 'utf-8');
}

/** 一个**影子目录**（库内没有 `source.*` 的目录：只放库外音频的产物） */
export interface ShadowEntry {
  /** 目录名（含路径指纹，用于展示） */
  dir: string;
  /** 目录绝对路径（删除时用它） */
  path: string;
  /** 目录内文件清单（名 + 字节） */
  files: Array<{ name: string; size: number }>;
  /** 总字节 */
  size: number;
  /** 最后修改时间（ms） */
  mtimeMs: number;
  /** 记录下来的源音频绝对路径（早期目录没有 ⇒ null） */
  sourcePath: string | null;
  /** 源音频是否还在（null = 无记录，无法判断） */
  sourceExists: boolean | null;
}

/**
 * 列出库内的**影子目录**（库外音频的产物）。
 *
 * 为什么要这个接口：影子目录**故意不出现在 Library 列表里**（列表只认带 `source.*` 的条目），
 * 于是源文件被删/移动之后，它们的打点/峰值/片段会**永远留在库里且界面上删不掉**。
 * 这里只做"列出 + 判断源是否还在"，删不删由用户决定（删除走 `deleteShadowDir`）。
 */
export async function listShadowDirs(): Promise<ShadowEntry[]> {
  const root = libraryRoot();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: ShadowEntry[] = [];
  for (const name of names) {
    const dirAbs = join(root, name);
    let stat;
    try {
      stat = await fs.stat(dirAbs);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let files: string[];
    try {
      files = await fs.readdir(dirAbs);
    } catch {
      continue;
    }
    // 有 source.<音频扩展名> ⇒ 这是**正式库条目**，不属于影子目录（也绝不允许从这里删）
    const isRealEntry = files.some((f) => {
      if (!f.startsWith('source.')) return false;
      return AUDIO_EXTS.includes(extname(f).toLowerCase());
    });
    if (isRealEntry) continue;

    const listed: Array<{ name: string; size: number }> = [];
    let total = 0;
    for (const f of files) {
      try {
        const st = await fs.stat(join(dirAbs, f));
        if (!st.isFile()) continue;
        listed.push({ name: f, size: st.size });
        total += st.size;
      } catch {
        /* 跳过读不到的 */
      }
    }
    let sourcePath: string | null = null;
    try {
      const ref = JSON.parse(await fs.readFile(join(dirAbs, SOURCE_REF_NAME), 'utf-8')) as { path?: unknown };
      if (typeof ref?.path === 'string' && ref.path) sourcePath = ref.path;
    } catch {
      /* 无记录 */
    }
    let sourceExists: boolean | null = null;
    if (sourcePath) {
      sourceExists = await fs
        .stat(sourcePath)
        .then(() => true)
        .catch(() => false);
    }
    out.push({
      dir: name,
      path: dirAbs,
      files: listed.sort((a, b) => a.name.localeCompare(b.name)),
      size: total,
      mtimeMs: stat.mtimeMs,
      sourcePath,
      sourceExists,
    });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 删一个**影子目录**（连同里面的打点/峰值/转写/片段）。
 *
 * 两条安全护栏（都会抛错，不做"尽力而为"）：
 *   ① 目标必须在 `<APP_ROOT>/.audio-library/` 之内（防止借这个接口删任意目录）；
 *   ② 目录里**不能有 `source.*`**（那是正式库条目，删它会把用户导入的音频一起删掉 —— 必须走 `deleteEntry`）。
 * ⚠️ 只删库内产物，**不动源音频文件本身**。
 */
export async function deleteShadowDir(dirAbs: string): Promise<void> {
  const root = libraryRoot();
  const target = dirAbs.endsWith('/') ? dirAbs.slice(0, -1) : dirAbs;
  if (!target.startsWith(root + '/') || target === root) {
    throw new Error('refusing to delete outside the audio library');
  }
  let files: string[];
  try {
    files = await fs.readdir(target);
  } catch {
    throw new Error('shadow directory not found');
  }
  const hasSource = files.some((f) => {
    if (!f.startsWith('source.')) return false;
    return AUDIO_EXTS.includes(extname(f).toLowerCase());
  });
  if (hasSource) throw new Error('refusing to delete a library entry here (use the library list instead)');
  await fs.rm(target, { recursive: true, force: true });
}

/**
 * 某音频的**打点文件路径**：库里音频就地放（与源同居一处），
 * 库外音频（项目 materials / 本地路径）放**影子目录**。
 *
 * 打点是应用产物，一律不进 workspace —— 否则会生成 `materials/录音.marks.json`
 * 这样的文件，明晃晃出现在资料树里。
 */
export async function marksFileFor(audioAbs: string): Promise<string> {
  return join(await sourceDir(audioAbs), basename(sidecarPath(audioAbs)));
}

/**
 * 某音频的**波形峰值缓存路径**：与打点同款（库里音频就地放、库外音频进影子目录），
 * 理由也一样 —— 它是应用产物/派生缓存，绝不落进 workspace，且随源目录一起被
 * `deleteEntry` 清理。文件名 `<主名>.peaks.json`（`source.m4a` → `source.peaks.json`）。
 *
 * 注意 `listLibrary` 只认 `source.<音频扩展名>`，该文件的 `.json` 不在白名单里，
 * 不会被误当成源音频。
 */
export async function peaksFileFor(audioAbs: string): Promise<string> {
  const base = basename(audioAbs).replace(/\.[^.]+$/, '');
  return join(await sourceDir(audioAbs), `${base}.peaks.json`);
}

/**
 * 某音频的**转写 sidecar 路径**：与打点/peaks 同款（库里音频就地放、库外音频进影子目录）。
 * 文件名 `<主名>.transcript.json`（`source.m4a` → `source.transcript.json`）。
 *
 * 为什么编辑器要自己存一份，而不用 `parseAudio` 的 `getCache`：
 *   - parse 缓存（`<project>/.cache/parse/`，`parse/cache.ts:82`）**落在 workspace 内**，
 *     而编辑器的应用产物口径是"绝不进 workspace"（见本文件头）；
 *   - parse 缓存只保证"不用重复付 STT 的钱"，但每次打开都要重算文件 hash + 读设置，
 *     而 sidecar 让面板一进来就能立刻渲染（**两份数据分工不同，都保留，不合并**）。
 *
 * 与 `peaksFileFor` 一样，`listLibrary` 只认 `source.<音频扩展名>`，`.json` 不会被误当源音频。
 */
export async function transcriptFileFor(audioAbs: string): Promise<string> {
  const base = basename(audioAbs).replace(/\.[^.]+$/, '');
  return join(await sourceDir(audioAbs), `${base}.transcript.json`);
}

/** 音频文件的当前指纹（转写失效对账用） */
export interface AudioFingerprint {
  size: number;
  mtimeMs: number;
}

/**
 * 读转写 sidecar，并与**当前音频指纹**对账。
 *
 * 返回 null 的所有情形（调用方一律当"没转过"，绝不当错误）：
 *   - 文件不存在 / 非法 JSON / 结构版本不符 / 全是脏段（`parseTranscriptSidecar` 兜住）；
 *   - sidecar 记了指纹，而当前音频指纹不符 ⇒ 音频被替换过，**绝不能展示过期文稿**
 *     （否则用户会拿旧转写去打点，点位与声音对不上，且看不出原因）；
 *   - sidecar 记了指纹，但 `current` 为 null（音频文件已不在）。
 *
 * 唯一放行的情况：sidecar **没记**指纹（手工放进来的/老文件）—— 无法对账就不惩罚，按可信处理。
 */
export async function readTranscriptFile(
  transcriptAbs: string,
  current: AudioFingerprint | null,
): Promise<AudioTranscript | null> {
  let text: string;
  try {
    text = await fs.readFile(transcriptAbs, 'utf-8');
  } catch {
    return null;
  }
  const parsed = parseTranscriptSidecar(text);
  if (!parsed) return null;
  if (parsed.source) {
    if (!current) return null;
    if (parsed.source.size !== current.size || parsed.source.mtimeMs !== current.mtimeMs) return null;
  }
  return parsed;
}

/**
 * 写转写 sidecar。
 *
 * ⚠️ 自己 `mkdir -p`：库外音频（项目 materials / 任意本地路径）的 sidecar 落在**影子目录**里，
 * 而该目录只在"导出过片段/算过波形缓存/存过打点"之后才存在 —— 直接 writeFile 会 ENOENT。
 * 这是 `writeMarksFile` 踩过的同一个坑（`marks.ts` 里那段注释），此处不再犯。
 * 与 peaks 缓存的"失败静默"不同：转写是**花了钱与时间**的结果，写不进去必须让调用方知道。
 */
export async function writeTranscriptFile(transcriptAbs: string, transcript: AudioTranscript): Promise<void> {
  await fs.mkdir(dirname(transcriptAbs), { recursive: true });
  await fs.writeFile(transcriptAbs, JSON.stringify(transcript), 'utf-8');
}

// ──────────────────────────────────────────────────────────────
// 片段清单（lineage）—— 原 clip-store.ts 的逻辑并入此处
// ──────────────────────────────────────────────────────────────

/** 读某源的片段清单（目录/文件不存在或解析失败 → 空数组） */
export async function readClips(srcAbs: string): Promise<AudioClipRef[]> {
  try {
    const dir = await sourceDir(srcAbs);
    const text = await fs.readFile(join(dir, INDEX_NAME), 'utf-8');
    return parseClips(text);
  } catch {
    return [];
  }
}

/** 写某源的片段清单（空数组时删除索引文件；目录保留，片段文件可能已被用户下载走） */
export async function writeClips(srcAbs: string, clips: AudioClipRef[]): Promise<void> {
  const dir = await sourceDir(srcAbs, clips.length > 0);
  const p = join(dir, INDEX_NAME);
  if (clips.length === 0) {
    try { await fs.unlink(p); } catch { /* 不存在就不管 */ }
    return;
  }
  await fs.writeFile(p, serializeClips(clips), 'utf-8');
}

// ──────────────────────────────────────────────────────────────
// 库浏览 / 管理
// ──────────────────────────────────────────────────────────────

/** 库内一条音频条目（仅含 source.* 的目录；影子目录不出现） */
export interface LibraryEntry {
  /** 源音频目录的绝对路径 */
  dir: string;
  /** 源音频文件的绝对路径（<dir>/source.<ext>） */
  path: string;
  /** 源音频文件名（source.<ext>） */
  name: string;
  /** 字节数 */
  size: number;
  /**
   * **加入库的时间**（源文件的 mtime，ms）—— 列表按它从新到旧排序。
   *
   * 为什么不用目录 mtime：目录会在写入打点/峰值/片段时被刷新，那反映的是"最后一次编辑"，
   * 不是"什么时候收进来的"；而 `source.<ext>` 只在入库那一刻写一次，
   * 后续的打点/片段/转写都是**另起 sidecar**，不碰源文件 ⇒ 源 mtime 才是稳定的"添加时间"。
   */
  mtimeMs: number;
}

/**
 * 列出库里所有音频（仅含 source.* 文件的目录；影子目录不含 source.* 不出现）。
 * 目录不存在 → 空数组。**按加入库的时间从新到旧排序**（新的在最上面）。
 */
export async function listLibrary(): Promise<LibraryEntry[]> {
  const root = libraryRoot();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: LibraryEntry[] = [];
  for (const name of names) {
    const dir = join(root, name);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch { continue; }
    if (!stat.isDirectory()) continue;
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch { continue; }
    // 找 source.<音频扩展名> 文件（排除 source.marks.json 等 sidecar）
    const sourceFile = files.find((f) => {
      if (!f.startsWith('source.')) return false;
      const ext = extname(f).toLowerCase();
      return AUDIO_EXTS.includes(ext);
    });
    if (!sourceFile) continue; // 影子目录无 source.* 文件
    const sourceAbs = join(dir, sourceFile);
    const sStat = await fs.stat(sourceAbs).catch(() => null);
    out.push({
      dir,
      path: sourceAbs,
      name: sourceFile,
      size: sStat?.size ?? 0,
      mtimeMs: sStat?.mtimeMs ?? 0,
    });
  }
  // 时钟相同的两条（同一批导入）保持稳定顺序：以目录名兜底，避免刷新一次换个位置
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.dir.localeCompare(b.dir));
}

/**
 * 删除某源音频的整个目录（源 + 打点 + 片段 + 清单一并清理）。
 * 影子目录同样适用（删除外部源的片段与清单）。
 */
export async function deleteEntry(srcAbs: string): Promise<void> {
  const dir = await sourceDir(srcAbs);
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * 重命名某个片段：改磁盘文件名（连同同名 marks sidecar），并同步 .clips.json 里的 path/name。
 *
 * - 只认**当前源目录内**的片段（防止借一个路径改名任意文件）；
 * - 扩展名沿用原片段（容器不变）；新名经过 safeBaseName（剥扩展名 / 洗非法字符）；
 * - 目标名已存在（含源音频、别的片段）→ 抛错，不覆盖；
 * - 返回更新后的片段清单 + 新片段绝对路径（调用方据此修正正在播放的对象）。
 */
export async function renameClip(
  srcAbs: string,
  clipAbs: string,
  newBaseName: string,
): Promise<{ clips: AudioClipRef[]; path: string }> {
  const dir = await sourceDir(srcAbs);
  if (dirname(clipAbs) !== dir) throw new Error('clip is not in the source directory');
  const clips = await readClips(srcAbs);
  if (!clips.some((c) => c.path === clipAbs)) throw new Error('clip not found');

  const base = safeBaseName(newBaseName);
  if (!base) throw new Error('name is required');
  const targetAbs = join(dir, `${base}${extname(clipAbs)}`);
  if (targetAbs === clipAbs) return { clips, path: clipAbs }; // 没变
  const exists = await fs.access(targetAbs).then(() => true).catch(() => false);
  if (exists) throw new Error('a file with that name already exists');

  await fs.rename(clipAbs, targetAbs);
  // 片段自己的打点 sidecar 同步改名（没有就跳过）
  try {
    await fs.rename(sidecarPath(clipAbs), sidecarPath(targetAbs));
  } catch { /* 该片段没有打点 */ }

  const next = clips.map((c) =>
    c.path === clipAbs ? { ...c, path: targetAbs, name: basename(targetAbs) } : c,
  );
  await writeClips(srcAbs, next);
  return { clips: next, path: targetAbs };
}

/**
 * 删除某个片段：删磁盘文件（连同它的 marks sidecar），并从 .clips.json 移除该条。
 *
 * - 只认**当前源目录内**的片段（防止借一个路径删任意文件）；
 * - 返回更新后的片段清单（调用方据此刷新列表）；
 * - 源音频本身不在这里删（那是 deleteEntry 的事）。
 */
export async function deleteClip(srcAbs: string, clipAbs: string): Promise<AudioClipRef[]> {
  const dir = await sourceDir(srcAbs);
  if (dirname(clipAbs) !== dir) throw new Error('clip is not in the source directory');
  const clips = await readClips(srcAbs);
  if (!clips.some((c) => c.path === clipAbs)) throw new Error('clip not found');

  await fs.rm(clipAbs, { force: true });
  try {
    await fs.unlink(sidecarPath(clipAbs));
  } catch { /* 该片段没有打点 */ }

  const next = clips.filter((c) => c.path !== clipAbs);
  await writeClips(srcAbs, next);
  return next;
}
