/**
 * src/lib/nodes/outcome-source-check.ts
 * 成果块材料来源的**页码**校验（R-3 补强）
 *
 * 路径部分本来就有兜底（`materials/` 前缀即合法形状），页码过去完全靠模型自觉：
 * prompt 只承诺「页码用检索命中的真实页码」，校验层只校路径形状 → 模型写对路径、编造页码也能放行。
 * 这里对着内容索引核一遍：页码必须落在该文件的**可寻址页集合**内（索引逐页文本的实际页数），
 * 否则降级为 `#p页码待核实` —— 保留出处、不冒充已核实，且 R-3 仍接受该标记（见 outcome.ts）。
 *
 * 索引缺失（未索引 / 索引过期 / 文件已删）同样降级：页码的唯一合法来源是索引命中，
 * 没有索引就没有「真实页码」可言。
 *
 * 只处理带 `#p数字` 的标记；省略页码的形式（`[来源: 材料:materials/x.pdf]`）原样保留。
 */
import { getIndexedMaterial } from '@/lib/materials/indexer';
import { PAGE_UNVERIFIED, type Outcome } from '@/lib/nodes/outcome';

/** 带页码的材料来源标记：捕获材料项目相对路径与页码 */
const MATERIAL_PAGE_RE = /\[来源:\s*材料:(materials\/[^\]\n#]+)#p(\d+)\]/g;

export interface SourcePageCheckResult {
  outcome: Outcome;
  /** 被降级的页码数（供日志与测试断言） */
  degraded: number;
}

/** 取出并降级不符合索引的页码（不修改传入对象） */
export async function checkOutcomeSourcePages(
  outcome: Outcome,
  projectPath: string | undefined,
): Promise<SourcePageCheckResult> {
  if (!projectPath) return { outcome, degraded: 0 };
  const src = outcome as unknown as Record<string, string>;
  const next: Outcome = { ...outcome };
  const record = next as unknown as Record<string, string>;
  /** 材料项目相对路径 → 可寻址页数（0 = 无索引，任何页码都不算命中） */
  const pageLimit = new Map<string, number>();
  let degraded = 0;

  const limitFor = async (projectRelPath: string): Promise<number> => {
    const cached = pageLimit.get(projectRelPath);
    if (cached !== undefined) return cached;
    let limit = 0;
    try {
      // 标记里写的是项目相对路径（materials/…），manifest 的键是 materials 相对路径
      const material = await getIndexedMaterial(projectPath, projectRelPath.replace(/^materials\//, ''));
      if (material) limit = material.pages.length;
    } catch {
      limit = 0;
    }
    pageLimit.set(projectRelPath, limit);
    return limit;
  };

  for (const key of ['facts', 'basis'] as const) {
    const value = src[key] ?? '';
    const matches = [...value.matchAll(MATERIAL_PAGE_RE)];
    if (matches.length === 0) continue;
    // 倒序替换：从后往前改，前面的匹配下标不受影响
    let out = value;
    for (const m of matches.reverse()) {
      const index = m.index ?? 0;
      const limit = await limitFor(m[1]);
      if (Number(m[2]) <= limit) continue;
      degraded++;
      out =
        out.slice(0, index) +
        `[来源: 材料:${m[1]}#p${PAGE_UNVERIFIED}]` +
        out.slice(index + m[0].length);
    }
    record[key] = out;
  }

  return { outcome: next, degraded };
}