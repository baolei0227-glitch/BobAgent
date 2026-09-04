/**
 * Bob Sandbox 小程序清单管理（服务端）
 *
 * 小程序存储于 {appRoot}/bob-sandbox/apps/<appId>/ 目录：
 *   - manifest.json：清单（id/name/description/entry/时间戳）
 *   - index.html 等：入口文件（静态小程序，直接由 preview 接口返回）
 * 节点 AI 可通过 write_file（绝对/相对路径）修改这些文件实现 coding 迭代。
 */

import { join, dirname, basename, sep } from 'path';
import { mkdir, readdir, readFile, writeFile, rm, rename } from 'fs/promises';
import { resolveAppRoot, BOB_SANDBOX_DIRNAME } from '@/lib/app-root';
import { APP_TEMPLATES, type SandboxTemplateId } from './templates';

export interface SandboxApp {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  /** 入口文件名（默认 index.html） */
  entry: string;
  /** 是否在小程序预览右上角自动注入 AI 状态指示器（宿主统一兜底，默认 true） */
  aiBadge?: boolean;
}

function appsRoot(): string {
  return join(resolveAppRoot(), BOB_SANDBOX_DIRNAME, 'apps');
}

async function ensureAppsRoot(): Promise<string> {
  const root = appsRoot();
  await mkdir(root, { recursive: true });
  return root;
}

/** 列出全部小程序（按创建时间倒序） */
export async function listApps(): Promise<SandboxApp[]> {
  const root = await ensureAppsRoot();
  const entries = await readdir(root, { withFileTypes: true });
  const apps: SandboxApp[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const mf = JSON.parse(await readFile(join(root, e.name, 'manifest.json'), 'utf-8')) as SandboxApp;
      if (mf && typeof mf.id === 'string') apps.push(mf);
    } catch {
      // 无 manifest 或损坏：跳过
    }
  }
  return apps.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** 新建小程序：写入 manifest + 模板文件 */
export async function createApp(name: string, template: SandboxTemplateId = 'blank'): Promise<SandboxApp> {
  const tpl = APP_TEMPLATES[template] ?? APP_TEMPLATES.blank;
  const now = new Date().toISOString();
  const id = `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(await ensureAppsRoot(), id);
  await mkdir(dir, { recursive: true });
  const app: SandboxApp = {
    id,
    name: name.trim() || 'Untitled App',
    description: tpl.description,
    createdAt: now,
    updatedAt: now,
    entry: tpl.entry,
    aiBadge: true,
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(app, null, 2), 'utf-8');
  for (const [fname, content] of Object.entries(tpl.files)) {
    await writeFile(join(dir, fname), content, 'utf-8');
  }
  return app;
}

/** 删除小程序（目录 + 内容） */
export async function removeApp(id: string): Promise<boolean> {
  const dir = join(await ensureAppsRoot(), id);
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** 读取小程序入口文件内容；不存在返回 null */
export async function readAppEntry(id: string): Promise<{ app: SandboxApp; content: string } | null> {
  const root = await ensureAppsRoot();
  try {
    const mf = JSON.parse(await readFile(join(root, id, 'manifest.json'), 'utf-8')) as SandboxApp;
    const content = await readFile(join(root, id, mf.entry || 'index.html'), 'utf-8');
    return { app: mf, content };
  } catch {
    return null;
  }
}

/**
 * 判断小程序是否已有真实实现（而非仅停留在内置模板初始状态）。
 *
 * 判定规则：入口文件内容与全部内置模板的初始内容逐一比对——
 * 若与某个模板完全一致 → 尚未定制，视为"从零新建"；否则视为"已有实现"（修改场景）。
 * 目录读取失败/无 manifest 一律返回 false（保守按"无实现"处理，走首轮 Spec 采集）。
 *
 * 用途：Coding 节点首轮判定——新建节点修改已有小程序时跳过 Spec 采集，
 * 避免"新节点 + 已有实现"被误判为从零开发而强制弹需求表单。
 */
export async function hasAppImplementation(id: string): Promise<boolean> {
  const root = await ensureAppsRoot();
  const dir = join(root, id);
  try {
    const mf = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf-8')) as SandboxApp;
    const entry = mf.entry || 'index.html';
    const content = await readFile(join(dir, entry), 'utf-8');
    for (const tpl of Object.values(APP_TEMPLATES)) {
      const tplContent = (tpl.files as Record<string, string>)[entry];
      if (typeof tplContent === 'string' && content === tplContent) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取小程序目录内任意文件（支持子目录），供静态文件服务路由使用。
 * @param id 小程序 appId
 * @param relPath 相对 <appId>/ 的路径（如 css/style.css），允许含子目录，禁止 ../ 穿越
 * @returns 文件内容 Buffer；路径穿越或文件不存在返回 null
 */
export async function readAppFile(
  id: string,
  relPath: string,
): Promise<Buffer | null> {
  if (!relPath) return null;
  const root = await ensureAppsRoot();
  const appDir = join(root, id);
  const target = join(appDir, relPath);
  if (!target.startsWith(appDir + sep) && target !== appDir) return null;
  try {
    return await readFile(target);
  } catch {
    return null;
  }
}

/** 更新小程序入口文件内容（AI 编辑器实时保存用） */
export async function updateAppEntry(id: string, content: string): Promise<boolean> {
  const root = await ensureAppsRoot();
  try {
    const mfPath = join(root, id, 'manifest.json');
    const mf = JSON.parse(await readFile(mfPath, 'utf-8')) as SandboxApp;
    await writeFile(join(root, id, mf.entry || 'index.html'), content, 'utf-8');
    // 更新时间戳
    mf.updatedAt = new Date().toISOString();
    await writeFile(mfPath, JSON.stringify(mf, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 同步小程序 manifest.updatedAt 为当前时间。
 * 供 write_file 等直接写盘路径在写入 .sandbox/apps/<appId>/ 后调用，
 * 保证 manifest 与 entry 文件保持一致，避免宿主一致性校验误判为"外部修改"而重置小程序。
 * @param id 小程序 appId（.sandbox/apps/ 下的目录名）
 */
export async function touchAppUpdatedAt(id: string): Promise<boolean> {
  const root = await ensureAppsRoot();
  try {
    const mfPath = join(root, id, 'manifest.json');
    const mf = JSON.parse(await readFile(mfPath, 'utf-8')) as SandboxApp;
    if (!mf || typeof mf.id !== 'string') return false;
    mf.updatedAt = new Date().toISOString();
    await writeFile(mfPath, JSON.stringify(mf, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** 每个小程序历史版本保留上限（保留最近 5 份，超出时覆盖最旧的一份） */
const HISTORY_KEEP = 5;

/**
 * 原子写入小程序文件 + 版本回滚 + 同步 manifest.updatedAt。
 *
 * 相比直接 writeFile，本函数提供三重保障：
 *  1. 原子写入：先写临时文件再 rename，避免写入中途崩溃留下半截文件；
 *  2. 版本回滚：写入前把旧内容备份到 .history/，宿主检测到损坏时可回退到最近有效版本，而非清空；
 *  3. 一致性：写盘后同步 manifest.updatedAt，保证 manifest 与文件状态一致，避免宿主误判重置。
 *
 * 小程序作为 BobWork 功能组件应完全开放：允许小程序目录内任意多级子路径/任意命名文件
 * （如 css/style.css、js/app.js），仅需落在 <appId>/ 目录内并杜绝 ../ 等路径穿越。
 * @param id 小程序 appId
 * @param relPath 相对 <appId>/ 的路径（如 index.html、css/style.css），允许含子目录，禁止 ../ 穿越
 * @param content 新内容
 * @returns 成功返回 true；文件不在小程序目录内、路径穿越或写入失败返回 false
 */
export async function writeAppFileAtomic(
  id: string,
  relPath: string,
  content: string,
): Promise<boolean> {
  // 空路径或路径穿越（引导到 appDir 之外）拒绝
  if (!relPath) return false;
  const root = await ensureAppsRoot();
  const appDir = join(root, id);
  const target = join(appDir, relPath);
  // 穿越校验：target 必须仍落在 appDir 内
  if (!target.startsWith(appDir + sep) && target !== appDir) return false;
  try {
    // 校验小程序存在（manifest 可读）
    const mfPath = join(appDir, 'manifest.json');
    const mf = JSON.parse(await readFile(mfPath, 'utf-8')) as SandboxApp;
    if (!mf || typeof mf.id !== 'string') return false;

    // —— 版本回滚：写入前把旧内容备份到 .history/<相对路径>/ ——
    let oldContent: string | null = null;
    try {
      oldContent = await readFile(target, 'utf-8');
    } catch {
      oldContent = null; // 目标文件尚不存在
    }
    if (oldContent !== null && oldContent !== content) {
      // 历史备份保留相对路径目录结构，避免不同子目录文件互相覆盖
      const historyDir = join(appDir, '.history', dirname(relPath));
      await mkdir(historyDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await writeFile(join(historyDir, `${stamp}-${basename(relPath)}`), oldContent, 'utf-8');
      // 裁剪历史，仅保留最近 HISTORY_KEEP 份
      await pruneHistory(historyDir, basename(relPath));
    }

    // —— 原子写入：先临时文件再 rename ——
    const parentDir = dirname(target);
    if (parentDir && parentDir !== appDir) await mkdir(parentDir, { recursive: true });
    const tmp = join(appDir, `.${basename(relPath)}.${process.pid}.tmp`);
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, target);

    // —— 同步 manifest.updatedAt ——
    mf.updatedAt = new Date().toISOString();
    await writeFile(mfPath, JSON.stringify(mf, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** 清理某文件的历史版本，仅保留最近的 HISTORY_KEEP 份 */
async function pruneHistory(historyDir: string, filename: string): Promise<void> {
  try {
    const entries = await readdir(historyDir, { withFileTypes: true });
    // 匹配 "<timestamp>-<filename>"
    const prefix = `-${filename}`;
    const matched = entries
      .filter((e) => e.isFile() && e.name.endsWith(prefix))
      .map((e) => e.name)
      .sort(); // 时间戳前缀按字典序即时间序
    const excess = matched.length - HISTORY_KEEP;
    if (excess > 0) {
      for (const name of matched.slice(0, excess)) {
        await rm(join(historyDir, name), { force: true });
      }
    }
  } catch {
    // 清理失败不影响主流程
  }
}
