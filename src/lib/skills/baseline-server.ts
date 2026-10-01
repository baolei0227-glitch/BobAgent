/**
 * skills/baseline-server.ts — 技能安装基线（官方更新检测）
 *
 * 仅在 Next.js 服务端路由 handler（app/api/* / route.ts）内部 import，
 * 不可被客户端组件导入。
 *
 * 为什么需要基线：只比对「已装副本 vs 随包源」只能知道"两边不一样"，
 * 无法分辨差异来自官方更新还是用户自己改的。因此在每次从随包源物化安装时，
 * 记下当时源目录的内容哈希作为基线，之后：
 *   - 源哈希 ≠ 基线，副本哈希 = 基线 → 官方更新（update）
 *   - 源哈希 = 基线，副本哈希 ≠ 基线 → 本地修改（edited）
 *   - 两者都变                          → 冲突（conflict）
 *
 * 基线集中存放于 <APP_ROOT>/extensions/skills-baseline.json，不写入技能目录本身，
 * 让技能目录保持干净、可自由拷贝/编辑/迁移；基线缺失时按「无法判定」处理（不亮徽标），
 * 待下次物化安装或「副本与源一致」时自动补记。
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { resolveAppRoot } from '../app-root';
import { BUILTIN_SKILLS_DIR, USER_SKILLS_DIR } from './loader-server';

/** 技能更新状态：update=官方有更新 / edited=本地已改 / conflict=两者都变 */
export type SkillUpdateState = 'synced' | 'update' | 'edited' | 'conflict';

/** 技能名校验（与 loader-server / installer-server 一致，用于防路径穿越） */
const VALID_NAME_RE = /^[a-z0-9_-]+$/;

/** 基线清单文件：<APP_ROOT>/extensions/skills-baseline.json */
export function baselineFile(): string {
  return path.join(resolveAppRoot(), 'extensions', 'skills-baseline.json');
}

interface BaselineEntry {
  /** 安装当时随包源目录的内容哈希 */
  hash: string;
  /** 记录时间（ISO） */
  at: string;
  /** 来源标记（builtin = 随包源物化） */
  source: string;
}

type BaselineMap = Record<string, BaselineEntry>;

/**
 * 目录内容哈希：递归收集文件（相对路径 + 内容），按相对路径排序后统一 sha256。
 * 跳过点号开头的条目（.DS_Store / .git / .workbuddy 等）：这些是工具链噪音与
 * 作者侧草稿，不属于技能内容，纳入哈希会造成「两侧内容相同却判定为有差异」的误报。
 * 目录不存在返回 null。
 */
export function hashDirectory(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;

  const files: string[] = [];
  const walk = (cur: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(cur, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) files.push(r);
    }
  };
  walk(dir, '');
  files.sort();

  const h = createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    try { h.update(fs.readFileSync(path.join(dir, rel))); } catch { /* 读取失败按空内容参与，不阻断 */ }
    h.update('\0');
  }
  return h.digest('hex');
}

function readBaseline(): BaselineMap {
  try {
    const parsed = JSON.parse(fs.readFileSync(baselineFile(), 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as BaselineMap) : {};
  } catch {
    return {};
  }
}

/** 原子写（tmp + rename），与项目其它落盘约定一致 */
function writeBaseline(map: BaselineMap): void {
  const file = baselineFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn('[skills] baseline 写入失败:', e);
  }
}

/** 记录某技能当前随包源哈希为安装基线（物化安装 / 重装后调用） */
export function recordBaseline(name: string, source = 'builtin'): void {
  if (!VALID_NAME_RE.test(name)) return;
  const hash = hashDirectory(path.join(BUILTIN_SKILLS_DIR, name));
  if (!hash) return;
  const map = readBaseline();
  map[name] = { hash, at: new Date().toISOString(), source };
  writeBaseline(map);
}

/** 移除某技能的安装基线（卸载时调用） */
export function removeBaseline(name: string): void {
  const map = readBaseline();
  if (!(name in map)) return;
  delete map[name];
  writeBaseline(map);
}

/**
 * 批量计算更新状态（一次读取基线清单，供列表接口使用）。
 * 只返回「非 synced」的条目：无随包源 / 无基线 / 无已装副本 → 不产生状态（不亮徽标）。
 *
 * 自愈补记：当已装副本与随包源完全一致时，说明此刻处于同步点（用户没改过），
 * 顺手补记基线，让后续的官方更新能被检测到（老用户无需重装即可纳入监测）。
 */
export function computeSkillStatuses(names: string[]): Record<string, SkillUpdateState> {
  const baseline = readBaseline();
  const out: Record<string, SkillUpdateState> = {};
  let backfilled = false;

  for (const name of names) {
    if (!VALID_NAME_RE.test(name)) continue;
    const srcHash = hashDirectory(path.join(BUILTIN_SKILLS_DIR, name));
    if (!srcHash) continue;
    const localHash = hashDirectory(path.join(USER_SKILLS_DIR, name));
    if (!localHash) continue;

    const base = baseline[name];
    if (!base) {
      if (srcHash === localHash) {
        baseline[name] = { hash: srcHash, at: new Date().toISOString(), source: 'builtin' };
        backfilled = true;
      }
      continue; // 无基线且两侧不一致 → 无法判定来源，不亮徽标
    }

    const sourceChanged = srcHash !== base.hash;
    const localChanged = localHash !== base.hash;
    if (sourceChanged && localChanged) out[name] = 'conflict';
    else if (sourceChanged) out[name] = 'update';
    else if (localChanged) out[name] = 'edited';
  }

  if (backfilled) writeBaseline(baseline);
  return out;
}
