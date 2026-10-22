/**
 * 文件自动整理 —— 设置面板的数据源（历史 / 失败原因 / 一键重试）。
 *
 *  GET  /api/core/file-organizer
 *      返回：开关与目录、既有分类目录、待处理清单（含失败原因与重试次数）、最近整理记录。
 *  POST /api/core/file-organizer
 *      { action: 'retry', path?: string }   清掉某文件（缺省 = 全部失败项）的内容指纹，
 *      下一轮 watcher 会重新判定；同时把 _待处理 里的文件搬回投递箱根部。
 *
 * 设计取舍：不新增任何常驻进程，全部复用 watcher/CLI 同一套 core 流程与状态文件。
 */
import { promises as fs } from 'fs';
import { basename, isAbsolute, join, resolve } from 'path';

import { readSettingsFromFile } from '@/lib/settings-server';
import { discoverExistingCategories, retryFile } from '../../../../../tools/organize/core';
import { normalizeCategories, PENDING_DIR } from '../../../../../tools/organize/model';
import { normalizeNaming, readLog, shouldSkip } from '../../../../../tools/organize/naming';
import { readState, type StateEntry } from '../../../../../tools/organize/state';

/** 历史记录返回条数上限 */
const HISTORY_LIMIT = 60;

/** 读取设置里的投递箱绝对路径（未配置/未开启 → null） */
async function inboxRoot(): Promise<{ root: string; enabled: boolean; categories: string[] } | null> {
  const settings = await readSettingsFromFile();
  const fo = settings.fileOrganizer ?? {};
  const dir = (fo.inboxDir ?? '').trim();
  if (!dir) return null;
  return {
    root: isAbsolute(dir) ? dir : resolve(process.cwd(), dir),
    enabled: fo.enabled === true,
    categories: normalizeCategories(fo.categories),
  };
}

export async function GET(): Promise<Response> {
  const cfg = await inboxRoot();
  if (!cfg) {
    return Response.json({ ok: true, configured: false });
  }
  const { root } = cfg;
  const state = await readState(root);

  // _待处理 里的文件：状态里有失败原因与重试次数，没有状态的（老数据）按「未知」展示
  const byPath = new Map<string, StateEntry>();
  for (const e of state.entries) byPath.set(e.lastPath, e);
  const pendingDir = join(root, PENDING_DIR);
  const pendingFiles = await fs.readdir(pendingDir).catch(() => [] as string[]);
  const pending = await Promise.all(
    pendingFiles
      .filter((f) => !shouldSkip(f))
      .map(async (f) => {
        const p = join(pendingDir, f);
        const st = await fs.stat(p).catch(() => null);
        const entry = byPath.get(p);
        return {
          name: f,
          path: p,
          size: st?.size ?? 0,
          mtime: st?.mtime?.toISOString() ?? '',
          failure: entry?.failure ?? '',
          attempts: entry?.attempts ?? 0,
          method: entry?.method ?? '',
          model: entry?.model ?? '',
          updatedAt: entry?.updatedAt ?? '',
        };
      }),
  );
  pending.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));

  // 最近整理记录（日志倒序）
  const log = await readLog(root);
  const history = [...log.entries]
    .reverse()
    .slice(0, HISTORY_LIMIT)
    .map((e) => ({
      at: e.at,
      from: basename(e.from),
      category: e.category,
      topic: e.topic,
      version: e.version,
      verdict: e.verdict,
      note: e.note,
      model: e.model,
      tokens: e.tokens,
      retries: e.retries,
    }));

  const existing = await discoverExistingCategories(root);
  return Response.json({
    ok: true,
    configured: true,
    enabled: cfg.enabled,
    root,
    categories: cfg.categories,
    existing,
    pending,
    history,
  });
}

export async function POST(req: Request): Promise<Response> {
  let body: { action?: string; path?: string };
  try {
    body = (await req.json()) as { action?: string; path?: string };
  } catch {
    return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const cfg = await inboxRoot();
  if (!cfg) return Response.json({ ok: false, error: 'inbox not configured' }, { status: 400 });
  const { root } = cfg;

  if (body.action !== 'retry') {
    return Response.json({ ok: false, error: `unknown action: ${body.action ?? '(none)'}` }, { status: 400 });
  }

  // 只允许操作投递箱内部的路径：避免这个入口变成任意文件读写的口子
  const requested = body.path ? resolve(body.path) : '';
  if (requested && !(requested === root || requested.startsWith(root + '/'))) {
    return Response.json({ ok: false, error: 'path outside inbox' }, { status: 400 });
  }

  // 待处理文件先搬回投递箱根部，watcher 才看得到它；再清指纹允许重判
  const pendingDir = join(root, PENDING_DIR);
  const targets = requested
    ? [requested]
    : (await fs.readdir(pendingDir).catch(() => [] as string[]))
        .filter((f) => !shouldSkip(f))
        .map((f) => join(pendingDir, f));

  let moved = 0;
  let cleared = 0;
  const failures: string[] = [];
  for (const p of targets) {
    // 先按内容指纹清除历史结论（文件还在原位时算得出哈希），再把它搬回投递箱根部
    cleared += await retryFile(root, p).catch(() => 0);
    if (p.startsWith(pendingDir + '/')) {
      try {
        await fs.rename(p, join(root, basename(p)));
        moved++;
      } catch (e) {
        // 根目录已有同名文件：保留在 _待处理，但依然允许重判
        failures.push(`${basename(p)}: ${(e as Error)?.message || e}`);
      }
    }
  }
  return Response.json({
    ok: true,
    moved,
    cleared,
    failures,
    naming: normalizeNaming((await readSettingsFromFile()).fileOrganizer?.naming),
  });
}
