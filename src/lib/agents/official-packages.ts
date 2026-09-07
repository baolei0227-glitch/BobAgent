/**
 * agents/official-packages.ts — 官方 Agent 市场包（server-only 数据）
 *
 * 2026-09-06 架构定稿：系统内置 Agent 只有 chat / coding（profiles.ts 注册表）。
 * 其余全部走 Agent 市场，其中历史内置的 Kar(笔记) / Planner 以「官方包」形式提供：
 *   - 权威 prompt / coreExclusions 文本仍留在 profiles.ts（字节稳定、可审阅、可热改），
 *     避免把超长模板复制进静态 JSON 造成漂移；
 *   - market-server 把本表并入市场源目录（随包官方源），安装时才物化为
 *     <APP_ROOT>/agents/<id>/agent.json（此后即与用户自装包同权：可卸载/可编辑 prompt）。
 */
import {
  NOTE_BASE_SYSTEM_PROMPT,
  NOTE_CORE_EXCLUSIONS,
  PLANNER_BASE_SYSTEM_PROMPT,
} from './profiles';
import type { AgentPackageManifest } from './market-server';

/** 官方市场包（id 命中即不再读磁盘 assets 源；新增官方包在此追加） */
export const OFFICIAL_PACKAGES: AgentPackageManifest[] = [
  {
    id: 'note',
    name: 'Kar',
    description:
      'Personal knowledge base keeper (Karpathy LLM Wiki). Collects raw notes, compiles interlinked wiki entries, rescues/retires old notes, lint checks, and answers by citing sources. Specialized sub-agent of the bob-notes plugin — the only place with full note read/write/maintain tools.',
    version: '1.0.0',
    fixedScenes: ['general', 'legal', 'node', 'notebook'],
    coreExclusions: [...NOTE_CORE_EXCLUSIONS],
    prompt: NOTE_BASE_SYSTEM_PROMPT,
  },
  {
    id: 'planner',
    name: 'Planner',
    description:
      'Conversational to-do & schedule assistant. Turns statements into stickytodo/calendar events (two-way synced), queries with natural language, guards duplicates/conflicts, and reuses scheduling preferences. Optional plan-tree for multi-step goals.',
    version: '1.0.0',
    fixedScenes: ['general', 'node', 'planner', 'wanted'],
    prompt: PLANNER_BASE_SYSTEM_PROMPT,
  },
];

/** id → 官方包（快速查找） */
export const OFFICIAL_PACKAGE_BY_ID: ReadonlyMap<string, AgentPackageManifest> = new Map(
  OFFICIAL_PACKAGES.map((m) => [m.id, m]),
);
