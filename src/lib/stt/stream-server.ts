/**
 * lib/stt/stream-server.ts — 常驻流式引擎进程（sherpa-onnx-online-websocket-server）
 *
 * sherpa-onnx-online-websocket-server 是**常驻 WS 服务**（不是一次性命令）：起一次、多个连接复用。
 * 本模块只管它特有的三件事——**端口分配**（listen(0) 取号，spawn 后以 TCP 探测确认真在听）、
 * **就绪判定**（TCP 可连 + 失败时回读 stderr 尾巴）、**启动参数**（模型参数 + 日志文件）；
 * 复用、空闲回收、孤儿清理、失败回收这套生命周期与标点服务同构，已抽到 resident-process。
 *
 * 与模型解耦：本模块不认识模型，调用方（sherpa.ts）把二进制路径、dylib 目录、模型参数与日志路径交给它。
 */
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { createResidentManager, type ResidentInstance } from '@/lib/stt/resident-process';
import { sharedLibEnv } from '../platform';

/** 空闲多久自动回收常驻服务端：每次 start 续期，避免录音结束后进程长期驻留 */
const STREAM_IDLE_MS = 3 * 60 * 1000;
/** 模型加载 + 监听就绪的上限（int8 zipformer 首次加载较慢） */
const STREAM_READY_TIMEOUT_MS = 30_000;

/** 启动一份常驻流式服务端所需的全部外部信息 */
export interface StreamServerSpec {
  /** 模型 id：同 id 且存活即复用，换 id 则先回收再重启 */
  modelId: string;
  /** 服务端可执行文件路径（也用于精确匹配孤儿进程的 argv） */
  binaryPath: string;
  /** dylib 目录（子进程靠 DYLD_LIBRARY_PATH 找 shared 包依赖） */
  libDir: string;
  /** 模型参数（--tokens / --encoder / --decoder / --joiner 等） */
  args: string[];
  /** 服务端日志文件路径 */
  logPath: string;
}

/** renderer 直连所需的连接信息 */
export interface StreamServer {
  port: number;
  modelId: string;
}

interface StreamState extends ResidentInstance {
  port: number;
  modelId: string;
}

/** 让 OS 分配一个空闲端口（先 listen(0) 取号再关闭；极小概率被抢占，以 spawn 后探测为准） */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('Could not allocate a free port'))));
    });
  });
}

/**
 * 轮询 TCP 可连，判断服务端是否已就绪。
 * signal 中止（子进程已退出/报错）时立即返回 false——否则要干等满超时才知道起不来。
 */
function waitForPort(port: number, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        sock.destroy();
        if (signal.aborted) resolve(false);
        else if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

const resident = createResidentManager<StreamServerSpec & { key: string }, StreamState>({
  storeKey: '__bobLocalSttStream',
  idleMs: STREAM_IDLE_MS,
  spawn: async (spec) => {
    const port = await pickFreePort();
    await fs.mkdir(path.dirname(spec.logPath), { recursive: true });
    const child = spawn(
      spec.binaryPath,
      [
        `--port=${port}`,
        '--num-work-threads=2',
        ...spec.args,
        `--log-file=${spec.logPath}`,
      ],
      {
        env: {
          ...process.env,
          ...sharedLibEnv(spec.libDir),
        },
        // 服务端把启动/连接日志写到 stderr，stdout 无内容
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    return { child, port, modelId: spec.modelId, logTail: [] };
  },
  waitReady: async (state, signal) => {
    const ready = await waitForPort(state.port, STREAM_READY_TIMEOUT_MS, signal);
    if (ready) return;
    throw new Error(
      signal.aborted
        ? 'Streaming STT server exited before it started listening'
        : `Streaming STT server did not become ready within ${STREAM_READY_TIMEOUT_MS / 1000}s`,
    );
  },
});

/**
 * 主动回收流式服务端（幂等）；删除模型 / 卸载引擎 / 退出时调用，避免常驻进程占着已删的文件。
 * 传 modelId 时只在当前正是该模型才回收（删除某个模型时别误伤正在跑的另一模型）。
 */
export function stopStreamServer(modelId?: string): boolean {
  return resident.stop(modelId);
}

/**
 * 启动（或复用）流式服务端，返回 renderer 的直连端口。
 * 同一模型且存活时直接复用并续期；换模型或已退出则先回收再重启。
 */
export async function startStreamServer(spec: StreamServerSpec): Promise<StreamServer> {
  const state = await resident.acquire({ ...spec, key: spec.modelId });
  return { port: state.port, modelId: state.modelId };
}