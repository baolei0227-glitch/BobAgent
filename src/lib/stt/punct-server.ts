/**
 * lib/stt/punct-server.ts — 常驻标点服务（把 CT-Transformer 标点模型加载一次、反复复用）
 *
 * 为什么需要它：标点模型走 CLI 时**每次调用都要重新加载 75MB 模型**，实测 ~135ms/段、
 * 其中推理仅 6ms；实时字幕每段定稿都要补句读，这个开销必须去掉。这里把「加载一次、逐段复用」
 * 的常驻服务（native/punct_server.c）管起来，本模块负责它特有的部分：
 *   ① **按需构建**：首次使用时用 clang 把 C 源码编成 `.stt/bin/punct-server`，以 mtime 比对做
 *      幂等缓存（源码未改就不重编）；构建/工具链缺失即抛错，调用方回退 CLI；
 *   ② **逐行协议**：stdin 一行一条文本（换行转义），stdout 依次给 `OK <text>` / `ERR <msg>`，
 *      按 FIFO 与请求一一配对；单条超时即重启（配对可能已错位，别让后续请求跟着错位）。
 * 复用、空闲回收、孤儿清理、失败回收这套生命周期与流式服务同构，见 resident-process。
 *
 * 协议细节（与 native/punct_server.c 一一对应）：文本里的 `\n` `\r` `\` 以 `\\n` `\\r` `\\` 转义，
 * 保证请求与响应恒为单行；转义/反转义在本文件与 C 侧各实现一次，两边必须同步修改。
 */
import { promises as fs } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { createResidentManager, sleep, type ResidentInstance } from '@/lib/stt/resident-process';

/** 空闲多久回收常驻服务：每次请求续期（会议里每 45s 一段，天然保持热态） */
const PUNCT_IDLE_MS = 3 * 60 * 1000;
/** 模型加载 + READY 的上限（int8 CT-Transformer 加载实测 ~0.2s，给足余量） */
const PUNCT_READY_TIMEOUT_MS = 20_000;
/** 单条请求上限：正常 ~3ms，超时说明服务异常，直接重启而不是干等 */
const PUNCT_REQUEST_TIMEOUT_MS = 15_000;
/** clang 编译上限 */
const BUILD_TIMEOUT_MS = 120_000;

/** 拉起一份常驻标点服务所需的全部外部信息 */
export interface PunctuationServerSpec {
  /** 可执行文件路径（也用于精确匹配孤儿进程的 argv），如 .stt/bin/punct-server */
  binaryPath: string;
  /** dylib 目录（dlopen 绝对路径 + DYLD_LIBRARY_PATH 找依赖，如 libonnxruntime.dylib） */
  libDir: string;
  /** 标点模型 model.int8.onnx 的绝对路径（同目录 tokens.json 由引擎自动加载） */
  modelPath: string;
  /** 推理线程数（缺省 2） */
  numThreads?: number;
}

interface PunctPending {
  resolve: (text: string) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PunctState extends ResidentInstance {
  /** READY 是否已收到（模型加载完成） */
  ready: boolean;
  /** stdout 行缓冲（一次 data 可能含多行 / 半行） */
  buf: string;
  /** 在途请求队列：与响应严格同序 */
  pending: PunctPending[];
}

// ============================================================
// 转义（与 native/punct_server.c 的 unescape/escape_out 严格互逆）
// ============================================================

function escapeLine(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function unescapeLine(text: string): string {
  return text.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

// ============================================================
// 按需构建（C 源码 → .stt/bin/punct-server）
// ============================================================

/** 构建失败在进程内只记一次（编译失败是确定性的：没装 clang / 源码有错），避免每次请求都重试 clang */
let buildError: string | null = null;

const execFileAsync = promisify(execFile);

/**
 * C 源码候选路径（按存在性取第一个），与 pdf/docx 脚本同口径（见 app/api/docx/revise/route.ts）：
 *   1. `cwd/scripts/punct_server.c` —— 打包版：由 package-release.sh 复制进 next-standalone/scripts/
 *      （打包版 cwd = <Resources>/next-standalone）。**不能只靠 outputFileTracingIncludes**：
 *      它会把源码放进 next-standalone/src/，而打包收尾会整棵删掉 src，源码随之丢失。
 *   2. `cwd/src/lib/stt/native/punct_server.c` —— dev 下 cwd = projects 根；
 *      也覆盖「直接就地跑 .next/standalone」的场景（那里没被收尾脚本删过 src）
 *   3. `__dirname/native/...` —— CJS/tsup 产物内的相对位置
 */
function sourceCandidates(): string[] {
  const list = [
    path.join(process.cwd(), 'scripts/punct_server.c'),
    path.join(process.cwd(), 'src/lib/stt/native/punct_server.c'),
  ];
  if (typeof __dirname !== 'undefined') list.push(path.join(__dirname, 'native/punct_server.c'));
  return list;
}

async function resolveSourcePath(): Promise<string> {
  for (const c of sourceCandidates()) {
    try {
      await fs.access(c);
      return c;
    } catch {
      /* 试下一个候选 */
    }
  }
  throw new Error(`punct-server source not found (tried: ${sourceCandidates().join(', ')})`);
}

/** 幂等构建：二进制比源码新就直接复用；否则 clang 编译后原子落位 */
async function ensureBuilt(binaryPath: string): Promise<void> {
  if (buildError) throw new Error(buildError);
  const src = await resolveSourcePath();
  const [srcStat, binStat] = await Promise.all([
    fs.stat(src),
    fs.stat(binaryPath).catch(() => null),
  ]);
  if (binStat && binStat.size > 0 && binStat.mtimeMs >= srcStat.mtimeMs) return;
  const tmp = `${binaryPath}.tmp-${process.pid}`;
  try {
    await fs.mkdir(path.dirname(binaryPath), { recursive: true });
    await execFileAsync('/usr/bin/clang', ['-O2', '-o', tmp, src], { timeout: BUILD_TIMEOUT_MS });
    await fs.chmod(tmp, 0o755);
    await fs.rename(tmp, binaryPath);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    buildError = `could not build punct-server: ${e instanceof Error ? e.message : String(e)}`;
    throw new Error(buildError);
  }
}

// ============================================================
// 逐行协议与进程生命周期
// ============================================================

/** 挂上 stdout 行协议、stdin 错误兜底；一行响应与队首请求配对 */
function attachProtocol(state: PunctState): void {
  const onLine = (line: string) => {
    if (line === 'READY') {
      state.ready = true;
      return;
    }
    if (line === 'OK' || line.startsWith('OK ')) {
      const p = state.pending.shift();
      if (!p) return;
      if (p.timer) clearTimeout(p.timer);
      p.resolve(unescapeLine(line.slice(3)));
      return;
    }
    if (line.startsWith('ERR')) {
      const p = state.pending.shift();
      if (p?.timer) clearTimeout(p.timer);
      p?.reject(new Error(line.slice(4).trim() || 'punctuation failed'));
      return;
    }
    // 未知行（如引擎自身的日志冒到 stdout）：忽略，不影响配对
  };

  state.child.stdout?.on('data', (d: Buffer) => {
    state.buf += d.toString();
    for (let idx = state.buf.indexOf('\n'); idx >= 0; idx = state.buf.indexOf('\n')) {
      const line = state.buf.slice(0, idx).replace(/\r$/, '');
      state.buf = state.buf.slice(idx + 1);
      onLine(line);
    }
  });
  // stdin 写失败（EPIPE）由请求侧的错误处理兜底，这里只是别让它冒成 uncaught
  state.child.stdin?.on('error', () => undefined);
}

/** 回收当前实例时拒掉所有在途请求（进程没了，它们不可能再有响应） */
function failPending(state: PunctState): void {
  for (const p of state.pending.splice(0)) {
    if (p.timer) clearTimeout(p.timer);
    p.reject(new Error('punctuation server stopped'));
  }
}

const resident = createResidentManager<PunctuationServerSpec & { key: string }, PunctState>({
  storeKey: '__bobLocalSttPunct',
  idleMs: PUNCT_IDLE_MS,
  spawn: async (spec) => {
    await ensureBuilt(spec.binaryPath);
    const child = spawn(spec.binaryPath, [spec.modelPath, spec.libDir, String(spec.numThreads ?? 2)], {
      env: {
        ...process.env,
        // 依赖库（libonnxruntime 等）经 @rpath 解析，用库搜索路径指到同一目录
        DYLD_LIBRARY_PATH: [spec.libDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':'),
        LD_LIBRARY_PATH: [spec.libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const state: PunctState = { child, logTail: [], ready: false, buf: '', pending: [] };
    attachProtocol(state);
    return state;
  },
  waitReady: async (state, signal) => {
    const deadline = Date.now() + PUNCT_READY_TIMEOUT_MS;
    while (!state.ready) {
      if (signal.aborted) throw new Error('punctuation server exited before ready');
      if (Date.now() > deadline) {
        throw new Error(`punctuation server was not ready within ${PUNCT_READY_TIMEOUT_MS / 1000}s`);
      }
      await sleep(50);
    }
  },
  onStop: failPending,
});

/** 主动回收常驻标点服务（幂等）；删模型 / 卸载引擎 / 退出时调用。传 modelPath 时只回收该模型的实例 */
export function stopPunctServer(modelPath?: string): boolean {
  return resident.stop(modelPath);
}

/**
 * 给一段文本补标点（常驻服务）。
 * 失败即抛错（未构建 / 启动失败 / 超时），由调用方决定回退——本模块不吞错。
 */
export async function punctuateViaServer(spec: PunctuationServerSpec, text: string): Promise<string> {
  const state = await resident.acquire({ ...spec, key: spec.modelPath });
  return new Promise<string>((resolve, reject) => {
    const entry: PunctPending = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      // 超时说明服务已异常：响应配对可能错位，直接重启，别让后续请求跟着错位
      reject(new Error('punctuation request timed out'));
      resident.stop(spec.modelPath);
    }, PUNCT_REQUEST_TIMEOUT_MS);
    state.pending.push(entry);
    state.child.stdin?.write(`${escapeLine(text)}\n`, (e) => {
      if (e) {
        const idx = state.pending.indexOf(entry);
        if (idx >= 0) state.pending.splice(idx, 1);
        if (entry.timer) clearTimeout(entry.timer);
        reject(e);
      }
    });
  });
}