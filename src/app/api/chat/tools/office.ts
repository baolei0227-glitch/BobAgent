/**
 * Office 场景工具：docx 模板扫描 / 批量填充（依赖 docx-template-mcp 独立包内的 python 脚本）。
 * 从 tools/index.ts 抽出，导入路径保持不变（index.ts 通过 ...officeToolDefs 聚合）。
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { resolveDocxTemplateScript } from '@/lib/docx-template-mcp';
import type { Tool } from './index';
import { getProjectRootPath, getWorkspacePath, truncate } from './shared';

const execAsync = promisify(exec);

/** P2-2-2 scan_docx_templates 进程级缓存（按 dir + files mtime 签名，TTL 5min） */
const _scanCache: Map<string, { value: string; expireAt: number }> = new Map();
function _pruneScanCache(now: number) {
  if (_scanCache.size > 128) {
    for (const k of _scanCache.keys()) {
      const e = _scanCache.get(k);
      if (!e || e.expireAt < now) _scanCache.delete(k);
      if (_scanCache.size <= 64) break;
    }
  }
}
/** 计算 scene-dir 下所有 docx 的最新 mtime + 文件列表签名（作为 cache key 一部分） */
function _scanDirSig(dir: string): string {
  const fs = require('fs');
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return `nodir`; }
  const docxs = files
    .filter((f: string) => /\.docx$/i.test(f) && !f.startsWith('~$'))
    .sort();
  let latest = 0;
  for (const f of docxs) {
    try {
      const s = fs.statSync(join(dir, f));
      if (s.mtimeMs > latest) latest = s.mtimeMs;
    } catch { /* ignore */ }
  }
  return `${docxs.length}:${docxs.join(',')}:${latest.toFixed(0)}`;
}

/** scan_docx_templates 工具：扫描一份/多份/场景文件夹下的 docx 模板，列出所有 {{ }} 占位符。
 *  用途：AI 在和用户确认要填哪些字段时，先调用这个工具得到字段表。
 */
async function toolScanDocxTemplates(args: Record<string, unknown>): Promise<string> {
  const script = resolveDocxTemplateScript('scan_placeholders.py');
  if (!script) return 'Error: 未找到 scan_placeholders.py（docx-template-mcp 独立包未安装）。';

  const dir = (args.dir as string) || '';       // 模板目录绝对路径
  const filesRaw = args.files;
  const files: string[] = Array.isArray(filesRaw)
    ? (filesRaw as unknown[]).filter((x): x is string => typeof x === 'string')
    : typeof filesRaw === 'string' ? [filesRaw] : [];

  // 定位目录：仅支持 dir（自定义模板目录）；files 显式列表兼容保留
  const chosenDir = dir || '';

  // P2-2-2 命中缓存：dir 模式签名相同则直接返回（避免反复启动 python 子进程）
  if (chosenDir && files.length === 0) {
    const sig = `${chosenDir}::${_scanDirSig(chosenDir)}`;
    const now = Date.now();
    const entry = _scanCache.get(sig);
    _pruneScanCache(now);
    if (entry && entry.expireAt >= now) return entry.value;
    // 执行完写入缓存时带此 sig
    (toolScanDocxTemplates as unknown as { _pendingCacheKey?: string })._pendingCacheKey = sig;
  }

  const parts: string[] = [script];
  if (chosenDir) parts.push('--dir', `"${chosenDir}"`);
  for (const f of files) {
    if (f && typeof f === 'string') parts.push(`"${f}"`);
  }
  if (parts.length === 1) return 'Error: 请提供 dir 或 files 参数之一';

  const SCRIPT_TIMEOUT = 30_000;
  try {
    const cmd = ['/usr/bin/python3', ...parts].join(' ');
    const envChild = {
      ...process.env,
      PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(':'),
    };
    const { stdout, stderr } = await execAsync(cmd, { cwd: await getWorkspacePath(), timeout: SCRIPT_TIMEOUT, maxBuffer: 1024 * 1024, env: envChild });
    let out = (stdout || '').trim();
    if (!out) {
      try { out = JSON.stringify({ error: (stderr || 'empty output').trim() }, null, 2); } catch { out = stderr || 'empty'; }
    }
    const final = truncate(out, 8000);
    // P2-2-2 写入缓存：scene-dir 纯目录扫描模式（无 files 指定）且结果非 Error 才存
    const pkey = (toolScanDocxTemplates as unknown as { _pendingCacheKey?: string })._pendingCacheKey;
    if (pkey && final && !final.startsWith('Error:')) {
      _scanCache.set(pkey, { value: final, expireAt: Date.now() + 5 * 60 * 1000 });
      (toolScanDocxTemplates as unknown as { _pendingCacheKey?: string })._pendingCacheKey = undefined;
    }
    return final;
  } catch (e) {
    const err = e as { killed?: boolean; stdout?: string; stderr?: string; message?: string };
    (toolScanDocxTemplates as unknown as { _pendingCacheKey?: string })._pendingCacheKey = undefined;
    if (err.killed) return `Error: 模板扫描超时 (${SCRIPT_TIMEOUT / 1000}s)`;
    let msg = (err.stdout || '') + (err.stderr ? `\n[stderr]\n${err.stderr}` : '');
    if (!msg.trim()) msg = err.message || String(e);
    return `Error: ${truncate(msg, 5000)}`;
  }
}

/** fill_docx_templates 工具：用一套/多套数据填写 docx 模板。
 *  输入：dir（模板目录）或 files（模板文件列表），
 *  加上 context（单套数据 object） 或 rows（多套数据 object[]）。
 *  输出 JSON，包含生成的每个文件绝对路径及 zip 下载路径。
 */
async function toolFillDocxTemplates(args: Record<string, unknown>): Promise<string> {
  const script = resolveDocxTemplateScript('fill_template.py');
  if (!script) return 'Error: 未找到 fill_template.py（docx-template-mcp 独立包未安装）。';

  const dir = (args.dir as string) || '';
  const filesRaw = args.files;
  const files: string[] = Array.isArray(filesRaw)
    ? (filesRaw as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const context = args.context as Record<string, unknown> | undefined;
  const rowsRaw = args.rows;
  const rows: Record<string, unknown>[] | undefined = Array.isArray(rowsRaw)
    ? (rowsRaw as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : undefined;

  const ws = await getWorkspacePath();
  const path = require('path');
  const fs = require('fs');

  // 组装 python 命令参数：dir/files 指定模板目录/文件（附件场景）
  const argParts: string[] = [script];
  if (dir) argParts.push('--dir', `"${dir}"`);
  for (const f of files) if (f && typeof f === 'string') argParts.push(`"${f}"`);

  // 写数据到临时 JSON，避免命令行转义地狱
  const ts = Date.now();
  let dataFile: string | null = null;
  try {
    if (rows && Array.isArray(rows)) {
      const rowsPath = path.join(ws, `.bob_docx_rows_${ts}.json`);
      await writeFile(rowsPath, JSON.stringify(rows, null, 2), 'utf-8');
      dataFile = rowsPath;
      argParts.push('--rows-json', `"${rowsPath}"`);
    } else if (context && typeof context === 'object') {
      const ctxPath = path.join(ws, `.bob_docx_ctx_${ts}.json`);
      await writeFile(ctxPath, JSON.stringify(context, null, 2), 'utf-8');
      dataFile = ctxPath;
      argParts.push('--data-json', `"${ctxPath}"`);
    } else {
      return 'Error: 必须提供 context (object) 或 rows (object[]) 参数';
    }
  } catch (e) {
    return `Error: 写入临时数据文件失败: ${e instanceof Error ? e.message : String(e)}`;
  }

  // 输出目录 + zip：统一到项目 homework/template/（与插件模式 fill/route.ts 同目录，Finder 可见、侧边栏分组可见）。
  // AI 工具产物放在 docx_fill_<scene>_<stamp>/ 子目录，避免与插件模式根目录文件重名冲突。
  const projectRoot = await getProjectRootPath();
  const templateRoot = join(projectRoot, 'homework', 'template');
  try { fs.mkdirSync(templateRoot, { recursive: true }); } catch { /* ignore */ }
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '_' + Date.now().toString().slice(-6);
  const outDir = join(templateRoot, `docx_fill_custom_${stamp}`);
  try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* ignore */ }
  argParts.push('--out-dir', `"${outDir}"`);
  const zipPath = join(templateRoot, `docx_fill_custom_${stamp}.zip`);
  argParts.push('--zip', `"${zipPath}"`);
  // 每套数据一个子目录（set_000/、set_001/...）：与批次目录双层隔离，同套多个模板归入同一子目录
  argParts.push('--row-subdir', 'set');

  // 自定义命名规则（可选）
  const namingRule = args.namingRule as string | undefined;
  if (namingRule) argParts.push('--naming-rule', `"${namingRule.replace(/"/g, "'")}"`);

  const SCRIPT_TIMEOUT = 120_000;
  try {
    const cmd = ['/usr/bin/python3', ...argParts].join(' ');
    const envChild = {
      ...process.env,
      PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(':'),
    };
    const { stdout, stderr } = await execAsync(cmd, { cwd: ws, timeout: SCRIPT_TIMEOUT, maxBuffer: 5 * 1024 * 1024, env: envChild });
    let out = (stdout || '').trim();
    if (!out) {
      out = JSON.stringify({ ok: false, error: (stderr || 'empty output').trim() }, null, 2);
    }
    return truncate(out, 8000);
  } catch (e) {
    const err = e as { killed?: boolean; stdout?: string; stderr?: string; message?: string };
    if (err.killed) return `Error: 模板填充超时 (${SCRIPT_TIMEOUT / 1000}s)`;
    let msg = (err.stdout || '') + (err.stderr ? `\n[stderr]\n${err.stderr}` : '');
    if (!msg.trim()) msg = err.message || String(e);
    return `Error: ${truncate(msg, 5000)}`;
  } finally {
    if (dataFile) try { await unlink(dataFile); } catch { /* ignore */ }
  }
}

export const officeToolDefs: Tool[] = [
  {
    name: 'scan_docx_templates',
    description: '扫描 Word 模板（.docx）中的 Jinja2 占位符（{{ 字段名 }}）。支持自定义目录 dir="…" 或显式文件列表 files=[…]（如用户上传 .docx 模板附件后扫描字段）。返回 JSON：每模板字段列表（key/raw/kind）+ 合并去重后的 unique_placeholders 总表。与用户确认字段前必须先调此工具，避免漏字段/填错字段名。仅 .docx。',
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: '自定义模板文件夹绝对路径（包含 .docx 文件）。',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '显式列出单个或多个 .docx 文件路径（如 attachments/{nodeId}/{filename}）。和 dir 同时提供时会合并去重。',
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolScanDocxTemplates,
    maxOutput: 8000,
  },
  {
    name: 'fill_docx_templates',
    description: '用 JSON 数据批量填写 Word 模板（仅 .docx）。1) 选模板：dir（模板目录）或 files（模板文件列表，如 attachments/{nodeId}/{filename}）；2) 给数据：context={...} 单套 或 rows=[{...},...] 多套批量；3) 可选 namingRule 自定义输出名（str.format 风格）。返回 JSON：所有生成文件绝对路径、大小与自动打包 zip 路径。文件落在 homework/template/docx_fill_*/ 并自动前端展示。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '自定义模板目录绝对路径' },
        files: { type: 'array', items: { type: 'string' }, description: '显式列出的模板文件路径数组（如 attachments/{nodeId}/{filename}）' },
        context: {
          type: 'object',
          description: '单套数据（键值对），如 {"contractNo":"CG-001","甲方名称":"北京XX公司"}。与 rows 二选一，优先 context。',
        },
        rows: {
          type: 'array',
          items: { type: 'object' },
          description: '批量多套数据（N 份），每一行一套完整字段。N 行 × M 模板 = N×M 份输出文件。',
        },
        namingRule: {
          type: 'string',
          description: '输出文件名规则（Python str.format，单花括号）。可用变量：{templatePrefix}、{templateBasename}、{templateBasenameOrig}、{templateNo}、{rowIndex}（0 起）、{contractNo}、{signDate}。默认："{templatePrefix}_{templateBasename}__R{rowIndex:03d}__{contractNo}.docx"',
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolFillDocxTemplates,
    maxOutput: 8000,
  },
];
