/**
 * lib/extensions/index-server.ts — 宿主侧扩展仓库（方案 A，2026-09-03）
 *
 * ~/BobWork/extensions/ 作为宿主侧"插件/扩展"统一存储与总览：
 *   extensions/
 *     mcp/.audit/      MCP 市场操作审计（原 ~/BobWork/mcp/.audit 一次性迁入）
 *     index.json       扩展总览（技能 / 已接入 MCP / 随包与独立插件登记）
 *
 * BobWork 托管的独立插件（notes/ocr）数据已统一到 extensions/<plugin-id>；
 * 旧自治目录（~/.bob-notes-mcp、~/.bob-ocr-mcp）已废弃，残留由
 * cleanupLegacyPluginDirs 防御性删除；index.json 登记各插件数据目录位置与存在状态。
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { resolveAppRoot } from '@/lib/app-root';
import { USER_SKILLS_DIR } from '@/lib/skills/loader-server';
import { readSettingsFromFile } from '@/lib/settings-server';
import { MCP_PRESETS } from '@/lib/mcp/types';

/** 扩展仓库根：<APP_ROOT>/extensions */
export function extensionsRoot(): string {
  return path.join(resolveAppRoot(), 'extensions');
}

/** MCP 市场审计目录：extensions/mcp/.audit */
export function mcpAuditDir(): string {
  return path.join(extensionsRoot(), 'mcp', '.audit');
}

/** 扩展总览文件：extensions/index.json */
export function extensionsIndexFile(): string {
  return path.join(extensionsRoot(), 'index.json');
}

/**
 * 一次性迁移旧审计（<APP_ROOT>/mcp/.audit → extensions/mcp/.audit），幂等。
 * 旧目录（<APP_ROOT>/mcp）仅承载审计，迁移后整目录删除。
 */
export async function migrateLegacyAudit(): Promise<void> {
  try {
    const legacyDir = path.join(resolveAppRoot(), 'mcp');
    const src = path.join(legacyDir, '.audit');
    if (!fs.existsSync(src)) return;
    const dst = mcpAuditDir();
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      const from = path.join(src, f);
      const to = path.join(dst, f);
      if (!fs.existsSync(to)) fs.copyFileSync(from, to);
    }
    fs.rmSync(legacyDir, { recursive: true, force: true });
  } catch (e) {
    console.warn('[extensions] migrate legacy audit:', e);
  }
}

/** 独立插件登记表：BobWork 托管（随包 spawn / daemon env 注入）插件已统一到 extensions */
function standalonePlugins(): { id: string; dataHome: string; feature: string; exists: boolean }[] {
  const candidates = [
    { id: 'bob-notes-mcp', dataHome: path.join(extensionsRoot(), 'bob-notes-mcp'), feature: 'Notes knowledge base (Kar)' },
    { id: 'bob-ocr-mcp', dataHome: path.join(extensionsRoot(), 'bob-ocr-mcp'), feature: 'OCR / scanned-doc recognition' },
  ];
  return candidates.map((c) => ({ ...c, exists: fs.existsSync(c.dataHome) }));
}

/**
 * 清理已废弃的旧自治数据目录（~/.bob-notes-mcp、~/.bob-ocr-mcp）。
 * 插件数据已全统一到 ~/BobWork/extensions/<id>；此处仅防御性删除旧目录残留
 * （如旧版本 bundle 按历史默认重建的空壳），防止分叉与误读。幂等，不读取任何内容。
 */
export async function cleanupLegacyPluginDirs(): Promise<void> {
  const legacyDirs = [path.join(homedir(), '.bob-notes-mcp'), path.join(homedir(), '.bob-ocr-mcp')];
  for (const legacy of legacyDirs) {
    try {
      if (fs.existsSync(legacy)) {
        console.warn('[extensions] removing legacy plugin dir:', legacy);
        fs.rmSync(legacy, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn('[extensions] cleanup legacy plugin dir:', e);
    }
  }
}

/** 生成扩展总览（实时计算，不落盘） */
export async function generateExtensionsIndex() {
  const registryPath = path.resolve(process.cwd(), 'assets', 'mcp', 'registry.json');
  let registry: { id: string; name: string; group: string; risk: string; auth: boolean }[] = [];
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as typeof registry;
  } catch {
    /* registry 缺失不阻断总览 */
  }

  const settings = await readSettingsFromFile();
  const servers = settings.mcpServers || [];
  const installed = new Set(servers.map((s) => s.id));
  const enabled = new Set(servers.filter((s) => s.enabled).map((s) => s.id));

  let userSkillDirs: string[] = [];
  try {
    userSkillDirs = fs.existsSync(USER_SKILLS_DIR)
      ? fs
          .readdirSync(USER_SKILLS_DIR, { withFileTypes: true })
          .filter((d) => d.isDirectory() && fs.existsSync(path.join(USER_SKILLS_DIR, d.name, 'SKILL.md')))
          .map((d) => d.name)
      : [];
  } catch {
    /* 技能目录缺失不阻断总览 */
  }

  const bundled = MCP_PRESETS.filter((p) => (p.args || []).some((a) => typeof a === 'string' && a.startsWith('{BUNDLED}:'))).map((p) => ({
    id: p.id,
    name: p.name,
    entry: (p.args || []).find((a) => typeof a === 'string' && a.startsWith('{BUNDLED}:')) || '',
  }));

  return {
    generatedAt: new Date().toISOString(),
    root: extensionsRoot(),
    mcpAuditDir: mcpAuditDir(),
    userSkillsDir: USER_SKILLS_DIR,
    summary: {
      marketEntries: registry.length,
      mcpInstalled: installed.size,
      mcpEnabled: enabled.size,
      userSkills: userSkillDirs.length,
      bundledPlugins: bundled.length,
    },
    mcp: registry.map((e) => ({
      ...e,
      installed: installed.has(e.id),
      enabled: enabled.has(e.id),
    })),
    userSkills: userSkillDirs,
    bundledPlugins: bundled,
    standalonePlugins: standalonePlugins(),
  };
}

/** 生成并落盘 extensions/index.json（原子写） */
export async function writeExtensionsIndex(): Promise<void> {
  const root = extensionsRoot();
  fs.mkdirSync(root, { recursive: true });
  const tmp = extensionsIndexFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(await generateExtensionsIndex(), null, 2), 'utf-8');
  fs.renameSync(tmp, extensionsIndexFile());
}
