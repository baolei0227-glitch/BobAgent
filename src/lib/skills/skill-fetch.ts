/**
 * skills/skill-fetch.ts — 技能自动获取（Skill Auto-Fetch）服务端模块
 *
 * 运行时按需技能获取：任务出现能力缺口时，在受控 registry 清单内检索并安装技能。
 * 三条原则：来源受控（只装 vetted 条目）、判断可证（reason 模板 + 匹配分复检）、
 * 失败安全（任一环节不通过即中止）。
 *
 * Phase 1（MVP）：内置快照 registry.snapshot.json，规则版打分，审计文件。
 * Phase 2（预留）：GitCode Raw 远程清单拉取与合并。
 *
 * 仅在服务端路由 handler 内部 import，不使用 `server-only` 哨兵包。
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { resolveAppRoot } from '../app-root';

// ==================== 配置 ====================

export interface AutoFetchConfig {
  enabled: boolean;
  confirmMode: 'notify' | 'ask';
  minMatchScore: number;
  requireFailedAttempt: boolean;
  maxInstallsPerTask: number;
  registry: {
    builtin: string;
    remote: string;
    refresh: 'manual' | 'on_boot';
  };
}

export const DEFAULT_AUTO_FETCH: AutoFetchConfig = {
  enabled: true,
  confirmMode: 'notify',
  minMatchScore: 0.6,
  requireFailedAttempt: true,
  maxInstallsPerTask: 2,
  registry: {
    builtin: 'registry.snapshot.json',
    remote: 'https://raw.gitcode.com/bob/bobwork-skills/main/registry.json',
    refresh: 'manual',
  },
};

/** 从 .settings.json 读取 autoFetch 配置（未配置时走默认值） */
export async function getAutoFetchConfig(): Promise<AutoFetchConfig> {
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const settings = await readSettingsFromFile();
    const auto = settings.skills?.autoFetch;
    if (!auto) return DEFAULT_AUTO_FETCH;
    return {
      ...DEFAULT_AUTO_FETCH,
      ...auto,
      registry: { ...DEFAULT_AUTO_FETCH.registry, ...(auto.registry ?? {}) },
    };
  } catch {
    return DEFAULT_AUTO_FETCH;
  }
}

// ==================== Registry 条目 ====================

export interface RegistrySource {
  type: 'zip';
  url: string;
  mirror?: string;
  subpath?: string;
}

export interface RegistryEntry {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  source: RegistrySource;
  version: string;
  sha256?: string;
  license?: string;
  /** 是否经过人工核验。仅 vetted=true 可被自动安装 */
  vetted?: boolean;
  /** 已知不可信标记（搜索打分惩罚） */
  untrusted?: boolean;
}

const BUILTIN_REGISTRY = path.resolve(
  process.cwd(),
  'assets',
  'skills',
  'registry.snapshot.json',
);

/**
 * 加载合并后的 registry 候选集（Phase 1 只读内置快照；
 * Phase 2 在此处合并远程清单，远程条目必须带 vetted:true 才可自动安装）。
 */
export async function loadRegistryEntries(): Promise<RegistryEntry[]> {
  try {
    const raw = await fs.promises.readFile(BUILTIN_REGISTRY, 'utf-8');
    const parsed = JSON.parse(raw);
    const list: unknown[] = Array.isArray(parsed) ? parsed : parsed?.skills ?? [];
    return list.filter((e): e is RegistryEntry => !!e && typeof (e as RegistryEntry).id === 'string');
  } catch (e) {
    console.warn('[skill-fetch] 读取内置 registry 快照失败:', e instanceof Error ? e.message : String(e));
    return [];
  }
}

// ==================== 规则版打分（MVP） ====================

export interface SearchScore {
  matchScore: number;
  matchReasons: string[];
}

/**
 * MVP 规则版打分：
 * - query 拆词后，capabilities 命中 +1/词，description 关键词命中 +0.5
 * - 命中已知不可信标记的条目降权
 * - 总分归一化到 0-1
 */
export function scoreRegistryEntry(entry: RegistryEntry, query: string): SearchScore {
  const words = query.toLowerCase().split(/[\s,，、/;；]+/).filter(Boolean);
  if (!words.length) return { matchScore: 0, matchReasons: [] };

  const caps = (entry.capabilities ?? []).map((c) => c.toLowerCase());
  const desc = entry.description.toLowerCase();
  let hits = 0;
  const reasons: string[] = [];

  for (const w of words) {
    if (caps.includes(w)) {
      hits += 1;
      reasons.push(`${w}=命中能力`);
    } else if (desc.includes(w)) {
      hits += 0.5;
      reasons.push(`${w}=描述命中`);
    } else {
      reasons.push(`${w}=缺失`);
    }
  }

  let score = hits / words.length;
  if (entry.untrusted) score -= 0.2;
  score = Math.max(0, Math.min(1, score));

  return { matchScore: Math.round(score * 1000) / 1000, matchReasons: reasons };
}

// ==================== 安装速率限制（maxInstallsPerTask 近似） ====================

const INSTALL_WINDOW_MS = 5 * 60 * 1000; // 5 分钟窗口
const installTimestamps: number[] = [];

/** 窗口内安装次数是否已超限（超过后本次任务不再自动获取） */
export function installRateLimited(maxInstalls: number): boolean {
  const now = Date.now();
  while (installTimestamps.length && installTimestamps[0] < now - INSTALL_WINDOW_MS) {
    installTimestamps.shift();
  }
  return installTimestamps.length >= maxInstalls;
}

export function recordInstall(): void {
  installTimestamps.push(Date.now());
}

// ==================== 下载与校验 ====================

/** 下载 zip（15s 超时），mirror 优先由调用方依次尝试 */
async function downloadZip(url: string, timeoutMs = 15000): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

// ==================== 审计 ====================

const AUDIT_DIR = path.join(resolveAppRoot(), 'skills', '.audit');
const AUDIT_FILE = path.join(AUDIT_DIR, 'skill-installs.md');

export interface AuditRecord {
  time: string;
  source: string;
  triggerTask: string;
  matchBasis: string;
  matchScore: number;
  status: string;
}

/** 追加一条审计记录（无条件记录，不因静默模式跳过） */
export async function appendAuditRecord(record: AuditRecord): Promise<string> {
  await fs.promises.mkdir(AUDIT_DIR, { recursive: true });
  const block =
    `\n## 技能安装 ${record.source.split('#')[1] ?? 'unknown'}\n` +
    `- 时间: ${record.time}\n` +
    `- 来源: ${record.source}\n` +
    `- 触发任务: ${record.triggerTask || '无'}\n` +
    `- 匹配依据: ${record.matchBasis}\n` +
    `- 匹配分: ${record.matchScore.toFixed(2)}\n` +
    `- 状态: ${record.status}\n`;
  await fs.promises.appendFile(AUDIT_FILE, block, 'utf-8');
  return AUDIT_FILE;
}

// ==================== 对外安装流程 ====================

export interface InstallFromRegistryResult {
  success: boolean;
  skillName?: string;
  installDir?: string;
  auditNode?: string;
  error?: string;
}

/**
 * 完整安装链：条目校验 → 下载（mirror 优先，失败回退 url）→ sha256 → 安装 → 审计。
 * 任一环节不通过即中止，安装只发生在全部校验通过之后。
 *
 * @param force 绕过 maxInstallsPerTask 上限（仅限已征得用户同意后使用）
 */
export async function installFromRegistry(
  id: string,
  reason: string,
  opts: { force?: boolean } = {},
): Promise<InstallFromRegistryResult> {
  const cfg = await getAutoFetchConfig();
  if (!cfg.enabled) {
    return { success: false, error: 'SKILL_AUTO_FETCH_DISABLED: 技能自动获取已关闭（settings.skills.autoFetch.enabled=false）' };
  }

  // ── 1. reason 模板校验（防装错的核心） ──
  if (!/任务子目标/.test(reason) || !/能力对照/.test(reason) || !/匹配分/.test(reason)) {
    return {
      success: false,
      error:
        'reason 必须按模板填写，缺少"任务子目标"或"能力对照"或"匹配分"字段：\n' +
        '任务子目标: [...]\n能力对照: ...\n匹配分: X.XX',
    };
  }
  const scoreMatch = reason.match(/匹配分[:：]\s*([\d.]+)/);
  if (!scoreMatch || parseFloat(scoreMatch[1]) < cfg.minMatchScore) {
    return { success: false, error: `MATCH_BELOW_THRESHOLD: 匹配分需 ≥ ${cfg.minMatchScore} 才可安装` };
  }

  // ── 2. 条目校验 ──
  const entries = await loadRegistryEntries();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return { success: false, error: `SKILL_NOT_FOUND: registry 中无条目 "${id}"` };
  if (entry.vetted !== true) {
    return { success: false, error: 'SKILL_UNVETTED: 仅 vetted=true 的条目可被自动安装' };
  }

  // ── 3. 速率限制（超限默认拒绝；征得用户同意后带 force=true 可放行） ──
  if (installRateLimited(cfg.maxInstallsPerTask) && !opts.force) {
    return {
      success: false,
      error: `RATE_LIMIT: 最近 5 分钟已安装 ${cfg.maxInstallsPerTask} 个技能（maxInstallsPerTask 上限）。请先向用户说明并询问是否继续安装，用户同意后带 force=true 重试。`,
    };
  }

  // ── 4. 下载：mirror 优先，失败回退 url ──
  const urls = [entry.source.mirror, entry.source.url].filter((u): u is string => !!u);
  let buffer: Buffer | null = null;
  for (const u of urls) {
    try {
      buffer = await downloadZip(u);
      break;
    } catch {
      buffer = null;
    }
  }
  if (!buffer) return { success: false, error: 'DOWNLOAD_FAILED: 下载失败（mirror 与 url 均不可用）' };

  // ── 5. sha256 校验（条目提供 hash 时执行） ──
  if (entry.sha256 && sha256Hex(buffer) !== entry.sha256.toLowerCase()) {
    return { success: false, error: 'HASH_MISMATCH: 下载内容校验失败，已丢弃' };
  }

  // ── 6. 安装（解压 → 校验 → frontmatter 标记 → 落盘） ──
  const { installSkillFromZip } = await import('@/lib/skills/installer-server');
  const installedFrom = `registry#${entry.id}@${entry.version}`;
  const result = await installSkillFromZip(buffer, { installedFrom });
  if (!result.success || !result.skill) {
    return { success: false, error: `INSTALL_FAILED: ${result.error ?? '未知错误'}` };
  }

  recordInstall();

  // ── 7. 审计（无条件记录） ──
  const auditPath = await appendAuditRecord({
    time: new Date().toISOString(),
    source: installedFrom,
    triggerTask: reason.split('\n')[0] ?? '',
    matchBasis: scoreMatch[1] ?? '0',
    matchScore: parseFloat(scoreMatch[1] ?? '0'),
    status: '待复盘',
  });

  return {
    success: true,
    skillName: result.skill.name,
    installDir: result.skill.path,
    auditNode: auditPath,
  };
}

/** 供工具层构建 search 结果 */
export async function searchRegistry(
  query: string,
  limit = 5,
): Promise<Array<RegistryEntry & SearchScore>> {
  const entries = await loadRegistryEntries();
  return entries
    .map((e) => ({ ...e, ...scoreRegistryEntry(e, query) }))
    .filter((e) => e.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, Math.max(1, Math.min(limit, 10)));
}
