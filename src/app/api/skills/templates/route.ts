/**
 * /api/skills/templates — 全局合同模板库
 *
 * 模板物理位置：~/.docx-template-mcp/template-library/<场景名>/*.docx（仅支持 .docx）
 * （独立 docx-template-mcp 模板库，与 scan_docx_templates / fill_docx_templates 工具及 MCP server 共享）
 *
 * GET    列出所有场景及模板（场景名 + 文件列表 + 字段清单 + 根路径）
 * POST   上传一个 .docx 到指定场景（FormData 或 JSON base64，双通道兼容 Turbopack）
 * DELETE 删除指定场景下的某个模板
 */
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { join, extname, basename, resolve } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { docxTemplateLibraryRoot, sanitizeDocxScene, resolveDocxTemplateScript } from '@/lib/docx-template-mcp';
import { pythonBin, shellArg, toolPathEnv } from '@/lib/platform';

const execAsync = promisify(exec);

export const maxDuration = 60;

const MAX_SIZE = 100 * 1024 * 1024; // 100MB 上限

/** 模板库根目录：~/.docx-template-mcp/template-library/（DOCX_TEMPLATE_MCP_HOME 可覆盖） */
function templatesRoot(): string {
  return docxTemplateLibraryRoot();
}

/** 场景名安全化（与 docx-template-mcp 包的 sanitizeScene 一致；空名抛错） */
function sanitizeScene(scene: string): string {
  const s = sanitizeDocxScene(scene);
  if (!s) throw new Error('场景名不能为空');
  return s;
}

// ===== P2-2-1 占位符字段识别（统一走独立 docx-template-mcp 包的 scan_placeholders.py，避免 TS/Python 双份维护）=====
// 上层仍保留 .fields-cache.json（mtime 级缓存，与 MCP server 的 storage.ts 共享同一缓存文件），
// 首次识别后后续 GET/POST 直接命中缓存，性能无实际下降。

/** 按扩展名识别模板字段（统一委托 scan_placeholders.py）。
 *  返回 null 表示识别不可用（脚本缺失），调用方不应写入缓存，避免永久空缓存 */
async function extractTemplateFields(filePath: string): Promise<string[] | null> {
  const ext = extname(filePath).toLowerCase();
  if (ext !== '.docx') return [];
  const script = resolveDocxTemplateScript('scan_placeholders.py');
  if (!script) {
    console.error('[docx-template] scan_placeholders.py 未找到 — 当前构建缺少 docx-template-mcp 脚本，字段识别不可用');
    return null;
  }
  try {
    const cmd = [shellArg(pythonBin('模板字段识别')), `"${script}"`, `"${filePath}"`].join(' ');
    const envChild = {
      ...process.env,
      PATH: toolPathEnv(),
    };
    const { stdout, stderr } = await execAsync(cmd, { timeout: 25_000, maxBuffer: 1024 * 1024, env: envChild });
    const out = (stdout || '').trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    // 兼容 scan_placeholders.py 的几种 JSON 形状：
    //   - 单文件：{ fields: [...] } 或 [{ file, fields }]
    //   - 多文件：{ templates: [{ file, fields }] } 或直接数组
    // 字段项可能是字符串（旧缓存格式）或 { key, raw, kind } 对象（脚本输出），统一取 key
    let fields: unknown[] | undefined;
    if (parsed && Array.isArray(parsed)) {
      const first = parsed.find((x: unknown) => !!x && typeof x === 'object' && (x as { file?: unknown }).file === basename(filePath));
      const cand = first || parsed[0];
      if (cand && Array.isArray((cand as { fields?: unknown[] }).fields)) fields = (cand as { fields: unknown[] }).fields;
    } else if (parsed) {
      if (Array.isArray(parsed.fields)) {
        fields = parsed.fields as unknown[];
      } else if (Array.isArray(parsed.templates)) {
        const tpl = parsed.templates.find((t: unknown) => !!t && typeof t === 'object' && (t as { file?: unknown }).file === basename(filePath))
          || parsed.templates[0];
        if (tpl && Array.isArray((tpl as { fields?: unknown[] }).fields)) fields = (tpl as { fields: unknown[] }).fields;
      }
    }
    if (!fields) return [];
    return fields
      .map((x) => (typeof x === 'string' ? x : (x as { key?: unknown }).key))
      .filter((x): x is string => !!x && typeof x === 'string')
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ===== 字段识别缓存（首次识别后存盘，mtime 未变直接复用，避免每次重新解包/转换）=====
const FIELDS_CACHE_NAME = '.fields-cache.json';

interface FieldsCache {
  version: 1;
  files: Record<string, { mtime: number; fields: string[] }>;
}

/** 读取缓存文件；损坏或缺失返回空缓存 */
async function readFieldsCache(root: string): Promise<FieldsCache> {
  try {
    const raw = await fs.readFile(join(root, FIELDS_CACHE_NAME), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === 'object') {
      return parsed as FieldsCache;
    }
  } catch { /* ignore */ }
  return { version: 1, files: {} };
}

/** 写入缓存文件（失败静默，不影响主流程） */
async function writeFieldsCache(root: string, cache: FieldsCache): Promise<void> {
  try {
    await fs.writeFile(join(root, FIELDS_CACHE_NAME), JSON.stringify(cache, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

export async function GET() {
  try {
    const root = templatesRoot();
    const scenes: { name: string; templates: { name: string; size: number; mtime: number; fields: string[] }[] }[] = [];
    let entries: string[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true }).then((d) => d.map((x) => x.name));
    } catch {
      return NextResponse.json({ success: true, scenes: [] });
    }
    // 加载字段缓存（全局模板库根目录一个缓存文件）
    const cache = await readFieldsCache(root);
    let cacheDirty = false;
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const dir = join(root, name);
      let stat;
      try { stat = await fs.stat(dir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      let files: string[];
      try { files = await fs.readdir(dir); } catch { continue; }
      const templates: { name: string; size: number; mtime: number; fields: string[] }[] = [];
      for (const f of files) {
        if (f.startsWith('.') || !['.docx'].includes(extname(f).toLowerCase())) continue;
        const full = join(dir, f);
        try {
          const s = await fs.stat(full);
          // 命中缓存且 mtime 未变 → 直接复用字段；否则重新识别并更新缓存
          const hit = cache.files[full];
          let fields: string[];
          if (hit && hit.mtime === s.mtimeMs) {
            fields = hit.fields;
          } else {
            const detected = await extractTemplateFields(full);
            if (detected === null) {
              // 识别不可用（脚本缺失）：不写入缓存，避免安装新版本后仍命中空缓存
              fields = [];
            } else {
              fields = detected;
              cache.files[full] = { mtime: s.mtimeMs, fields: detected };
              cacheDirty = true;
            }
          }
          templates.push({ name: f, size: s.size, mtime: s.mtimeMs, fields });
        } catch { /* skip */ }
      }
      templates.sort((a, b) => b.mtime - a.mtime);
      scenes.push({ name, templates });
    }
    scenes.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    if (cacheDirty) await writeFieldsCache(root, cache);
    return NextResponse.json({ success: true, root: templatesRoot(), scenes });
  } catch (e) {
    console.error('模板库列表失败:', e);
    return NextResponse.json({ error: 'Failed to list templates' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || '';
    // 场景管理动作（JSON body）：rename_scene 重命名场景目录
    if (contentType.includes('application/json')) {
      const body = await request.json();
      if (body.action === 'rename_scene') {
        const oldScene = sanitizeScene(String(body.scene || ''));
        const newScene = sanitizeScene(String(body.newScene || ''));
        if (!oldScene || !newScene) {
          return NextResponse.json({ error: 'scene and newScene are required' }, { status: 400 });
        }
        const root = resolve(templatesRoot());
        const from = resolve(join(root, oldScene));
        const to = resolve(join(root, newScene));
        if (!from.startsWith(root + '/') || !to.startsWith(root + '/') || from === to) {
          return NextResponse.json({ error: '非法场景路径' }, { status: 400 });
        }
        try {
          await fs.access(to);
          return NextResponse.json({ error: '目标场景已存在' }, { status: 400 });
        } catch { /* 目标不存在，可重命名 */ }
        await fs.rename(from, to);
        return NextResponse.json({ success: true, scene: newScene });
      }
    }
    let scene: string;
    let fileName: string;
    let buffer: Buffer;

    if (contentType.includes('application/json')) {
      const body = await request.json();
      scene = body.scene || '';
      fileName = body.fileName || '';
      buffer = Buffer.from(body.data || '', 'base64');
      if (!body.data) {
        return NextResponse.json({ error: 'data (base64) is required' }, { status: 400 });
      }
    } else {
      const formData = await request.formData();
      scene = (formData.get('scene') as string) || '';
      const file = formData.get('file') as File | null;
      if (!file) {
        return NextResponse.json({ error: 'file is required' }, { status: 400 });
      }
      fileName = file.name;
      buffer = Buffer.from(await file.arrayBuffer());
    }

    let safeScene: string;
    try {
      safeScene = sanitizeScene(scene);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'scene is required' }, { status: 400 });
    }

    if (!fileName || !['.docx'].includes(extname(fileName).toLowerCase())) {
      return NextResponse.json({ error: '只支持 .docx 模板文件' }, { status: 400 });
    }
    if (buffer.length === 0 || buffer.length > MAX_SIZE) {
      return NextResponse.json({ error: '文件为空或超过 100MB 限制' }, { status: 400 });
    }

    const root = resolve(templatesRoot());
    const dir = resolve(join(root, safeScene));
    // P0-7-1 双保险：确保场景目录仍在模板库根目录内（防 ../../ 穿越，sanitizeScene 已过滤 / 再兜底一次）
    if (!dir.startsWith(root + '/') && dir !== root) {
      return NextResponse.json({ error: '非法场景路径' }, { status: 400 });
    }
    await fs.mkdir(dir, { recursive: true });

    // P0-7-1 basename 双保险：先过 basename 剥掉路径前缀，再非法字符替换
    const safeName = basename(basename(fileName)).replace(/[\\/:*?"<>|\n\r\t]/g, '_') || '未命名.docx';
    if (!['.docx'].includes(extname(safeName).toLowerCase())) {
      // 前面扩展名校验通过才到这里，兜底防止 basename(".doc") 这类极端输入
      return NextResponse.json({ error: '只支持 .docx 模板文件' }, { status: 400 });
    }
    const ext = extname(safeName);
    const base = safeName.slice(0, safeName.length - ext.length) || '模板';
    // 冲突时加数字后缀：name.docx -> name (1).docx
    let destName = safeName;
    let counter = 1;
    while (true) {
      try {
        await fs.access(join(dir, destName));
        destName = `${base} (${counter})${ext}`;
        counter++;
      } catch {
        break;
      }
    }
    const destPath = resolve(join(dir, destName));
    if (!destPath.startsWith(dir + '/') && destPath !== dir) {
      // 理论上不会命中（safeScene/safeName 都清理过），加一道防止构造特殊字符
      return NextResponse.json({ error: '非法目标文件名' }, { status: 400 });
    }
    await fs.writeFile(destPath, buffer);

    // 上传后立即识别字段清单，UI 可直接展示
    const fields = await extractTemplateFields(destPath);

    return NextResponse.json({
      success: true,
      scene: safeScene,
      filename: destName,
      path: destPath,
      fields,
    });
  } catch (e) {
    console.error('模板上传失败:', e);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { scene, filename } = body as { scene?: string; filename?: string };
    if (!scene) {
      return NextResponse.json({ error: 'scene is required' }, { status: 400 });
    }
    const safeScene = sanitizeScene(scene);
    const root = resolve(templatesRoot());
    if (filename) {
      // 删除单个模板文件
      const safeName = basename(filename);
      if (!['.docx'].includes(extname(safeName).toLowerCase())) {
        return NextResponse.json({ error: '只支持删除 .docx 模板' }, { status: 400 });
      }
      const destPath = resolve(join(root, safeScene, safeName));
      // 防穿越：确认目标仍在模板库根目录内
      if (!destPath.startsWith(root + '/')) {
        return NextResponse.json({ error: '非法路径' }, { status: 400 });
      }
      await fs.unlink(destPath);
      return NextResponse.json({ success: true, scene: safeScene, filename: safeName });
    }
    // 删除整个场景目录（含其下全部模板）
    const scenePath = resolve(join(root, safeScene));
    if (!scenePath.startsWith(root + '/') && scenePath !== root) {
      return NextResponse.json({ error: '非法场景路径' }, { status: 400 });
    }
    await fs.rm(scenePath, { recursive: true, force: true });
    return NextResponse.json({ success: true, scene: safeScene });
  } catch (e) {
    console.error('模板删除失败:', e);
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }
}
