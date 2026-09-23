/**
 * 独立 docx-template-mcp 包定位（脚本路径 + 模板库路径）
 *
 * 该包为独立 MCP server（docx-template-mcp/），与 BobWork 解耦：
 *   - 模板库：~/.docx-template-mcp/template-library/<场景名>/*.docx（DOCX_TEMPLATE_MCP_HOME 可覆盖）
 *   - Python 脚本：<包>/assets/scripts/scan_placeholders.py 与 fill_template.py
 *
 * 定位顺序（scripts）：
 *   1) DOCX_TEMPLATE_MCP_DIR 环境变量（显式指向包根目录）
 *   2) 开发态：与 projects/ 同级的 docx-template-mcp/
 *   3) 打包态：<appRoot>/docx-template-mcp/ 或其上级
 */
import { homedir } from 'os';
import * as fs from 'fs';
import { join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';

/** 独立模板库根目录：~/.docx-template-mcp/template-library/ */
export function docxTemplateLibraryRoot(): string {
  const home = process.env.DOCX_TEMPLATE_MCP_HOME || join(homedir(), '.docx-template-mcp');
  return join(home, 'template-library');
}

/** 场景名安全化（与 docx-template-mcp 包的 sanitizeScene 一致）：过滤路径字符 + 截断 40 */
export function sanitizeDocxScene(scene: string): string {
  return (scene || '').trim().replace(/[\\/:*?"<>|\n\r\t]/g, '').slice(0, 40);
}

/** 定位独立包 assets/scripts/<scriptFile>；找不到返回 null */
export function resolveDocxTemplateScript(scriptFile: string): string | null {
  const candidates = [
    process.env.DOCX_TEMPLATE_MCP_DIR ? join(process.env.DOCX_TEMPLATE_MCP_DIR, 'assets', 'scripts', scriptFile) : null,
    // 开发态：docx-template-mcp/ 与 projects/ 同级
    join(process.cwd(), '..', 'docx-template-mcp', 'assets', 'scripts', scriptFile),
    join(process.cwd(), 'docx-template-mcp', 'assets', 'scripts', scriptFile),
    // 打包态：随应用分发（<appRoot>/ 内或上级）
    join(resolveAppRoot(), '..', 'docx-template-mcp', 'assets', 'scripts', scriptFile),
    join(resolveAppRoot(), 'docx-template-mcp', 'assets', 'scripts', scriptFile),
  ].filter((x): x is string => !!x);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}
