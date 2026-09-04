/**
 * GET /api/projects/events — 项目变更 SSE 推送
 *
 * 后端 watcher 对账出变更后，通过 project-events 广播，本路由推送给订阅的浏览器端（侧边栏）：
 *  - `projects-changed`：项目列表变化（手动拖入/删除工作区目录等）→ 刷新项目列表
 *  - `files-changed`：项目内文件树可见内容变化（Finder 里直接增删改 homework/materials 等）
 *    → 刷新已展开项目的文件树
 * 连接断开自动清理订阅。
 */
import { onProjectsChanged, onProjectFilesChanged } from '@/lib/project/project-events';

export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();

/** 每个 SSE 连接对应的清理函数（cancel 时调用，避免连接泄漏） */
const cleanups = new WeakMap<ReadableStreamDefaultController<Uint8Array>, () => void>();

export async function GET() {
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      const unsubProjects = onProjectsChanged(() => {
        send('event: projects-changed\ndata: {}\n\n');
      });
      const unsubFiles = onProjectFilesChanged(() => {
        send('event: files-changed\ndata: {}\n\n');
      });

      const heartbeat = setInterval(() => {
        send(': keepalive\n\n');
      }, 25000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubProjects();
        unsubFiles();
      };
      cleanups.set(controller, cleanup);

      // 建立后立即发送一次初始事件，让前端在重连时也能马上刷新
      send('event: projects-changed\ndata: {}\n\n');
    },
    cancel(controller) {
      cleanups.get(controller)?.();
      cleanups.delete(controller);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
