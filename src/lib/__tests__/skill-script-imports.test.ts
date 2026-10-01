/**
 * 死代码判定的保护网（T1-3 回归，2026-09-25）。
 *
 * 背景：`projects/tsconfig.json` 的 `exclude` 含 `assets` ⇒ `tsc` **永不检查
 * `assets/skills/**` 下的脚本**。因此删掉这些脚本 import 的模块时**编译期零信号**：
 * 实证 c9fb308（T1-1）删 `src/lib/pdf/core/ledger.ts` 后 tsc 全绿，而
 * `bob-bank-statement` skill 实跑直接 `ERR_MODULE_NOT_FOUND`（入口脚本 :19 静态 import 它）。
 *
 * 本测试把「assets/skills 下脚本的相对导入必须能在磁盘上解析」变成可执行断言，
 * 补上 tsc 的这块盲区。范围仅限 `assets/skills/**` 的**相对**导入：
 *  - 不校验裸包名（走 node_modules 解析，属依赖问题、非本盲区）；
 *  - 不校验 `@/...` 路径别名（依赖 tsconfig paths，跨环境解析成本高）。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve, relative, extname } from 'path';

/** 项目根 = 本文件 → src/lib/__tests__ → 上溯三级 */
const SKILLS_DIR = resolve(__dirname, '..', '..', '..', 'assets', 'skills');

const CANDIDATE_EXTS = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'];

function resolvesOnDisk(base: string): boolean {
  for (const ext of CANDIDATE_EXTS) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return true;
  }
  for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
    if (existsSync(join(base, 'index' + ext))) return true;
  }
  return false;
}

function walkScripts(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkScripts(p, out);
    else if (
      ['.ts', '.tsx', '.js', '.mjs', '.cjs'].includes(extname(ent.name)) &&
      !ent.name.endsWith('.d.ts')
    ) {
      out.push(p);
    }
  }
  return out;
}

/** 抓 from '…' / import('…') / require('…') 里的**相对**说明符 */
const RELATIVE_IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.[^"']+)["']/g;

describe('assets/skills 脚本的相对导入完整性（tsc 盲区保护网）', () => {
  it('skills 目录存在', () => {
    expect(existsSync(SKILLS_DIR)).toBe(true);
  });

  it('所有相对导入都能在磁盘上解析（含 bob-bank-statement 的 ledger 依赖）', () => {
    const unresolved: string[] = [];
    let checked = 0;
    for (const file of walkScripts(SKILLS_DIR)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(RELATIVE_IMPORT_RE)) {
        const spec = m[1];
        checked++;
        if (!resolvesOnDisk(resolve(file, '..', spec))) {
          unresolved.push(`${relative(SKILLS_DIR, file)} -> ${spec}`);
        }
      }
    }
    // checked > 0：防止 skills 目录改名后测试静默空转（保护网失效而不自知）
    expect(checked).toBeGreaterThan(0);
    expect(unresolved).toEqual([]);
  });
});
