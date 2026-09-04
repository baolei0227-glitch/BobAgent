/**
 * 临时脚本：内置工具清单 + 场景标注 + 单工具 token 估算（按 token 降序）
 * 用法：cd projects && npx tsx scripts/list-builtin-tools.ts
 */
import { listAllToolDefs, getToolDefinitions } from '../src/app/api/chat/tools';

const all = listAllToolDefs();
const defs = getToolDefinitions(); // 全量（未过滤）

const defByName = new Map<string, { function?: { name?: string; description?: string; parameters?: unknown } }>();
for (const d of defs as Array<{ function?: { name?: string } }>) {
  defByName.set((d.function?.name ?? ''), d as never);
}

// 只输出内置工具（listAllToolDefs 包含 MCP/自定义，用 defs 过滤出 builtin 名）
const builtinNames = new Set(all.map((t) => t.name));
const rows = all
  .map((t) => {
    const d = defByName.get(t.name) as { function?: { description?: string } } | undefined;
    const descLen = d?.function?.description?.length ?? 0;
    const tokens = Math.ceil(JSON.stringify(defByName.get(t.name)).length / 2.5) || 0;
    return { name: t.name, scenes: t.scenes?.join(',') || 'general', tokens, descLen };
  })
  .filter((r) => r.tokens > 0)
  .sort((a, b) => b.tokens - a.tokens);

let total = 0;
console.log('内置工具（按 token 降序）：');
for (const r of rows) {
  total += r.tokens;
  const d = defByName.get(r.name) as { function?: { description?: string } } | undefined;
  const desc = (d?.function?.description || '').slice(0, 60).replace(/\n/g, ' ');
  console.log(`  ${String(r.tokens).padStart(6)}  ${r.name.padEnd(32)} [${r.scenes.padEnd(28)}] ${desc}`);
}
console.log(`\n内置工具合计: ${rows.length} 个, token ≈ ${total}`);
