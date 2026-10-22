/**
 * /api/skills/templates/fill — 模板字段表单提交 → 生成文档
 *
 * 支持两种请求格式：
 *   A) 单套数据（兼容旧版）：{ scene, template?, data: {字段: 值} }
 *   B) 批量多套（P1-1-4）：{ scene, templates?: string[], rows: object[] }
 *     - rows 为多套数据数组，每套生成 N 份文档（N = templates.length 或场景下全部）
 *
 * scene 为空时（P0-1-2 向后兼容降级）：遍历模板库所有场景，按 template / templates 名反查文件。
 *
 * 模板来源：独立 docx-template-mcp 模板库 ~/.docx-template-mcp/template-library/<场景>/
 * （与 scan_docx_templates / fill_docx_templates 工具一致）
 *
 * 输出：生成的 .docx 写入 <项目>/homework/template/（交付物统一进 homework，Finder 可见），
 * 返回相对路径供下载（/api/attachments 仅作通用文件服务）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { join, basename, resolve } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getCurrentProject } from '@/lib/project/project-manager';
import { docxTemplateLibraryRoot, sanitizeDocxScene, resolveDocxTemplateScript } from '@/lib/docx-template-mcp';
import { pythonBin, shellArg } from '@/lib/platform';

const execAsync = promisify(exec);
export const maxDuration = 120;

interface ResolveOptions { scene: string; template?: string; templates?: string[] }

/**
 * 统一解析模板文件列表。
 * - scene 非空 + template(s) 指定：在场景目录下查找
 * - scene 非空 + 无指定模板：场景下全部 .docx
 * - scene 空 + template(s) 指定：全场景降级反查
 * - 两者都空：返回错误
 */
async function resolveTemplateFiles(opts: ResolveOptions): Promise<{ files: string[]; error?: { msg: string; status: number } }> {
  const { scene, template, templates } = opts;
  const explicitNames = templates && Array.isArray(templates) && templates.length > 0
    ? templates.map((t) => basename(String(t))).filter(Boolean) // P0-7-1 basename 双保险
    : template ? [basename(template)] : [];

  if (scene) {
    const dir = join(docxTemplateLibraryRoot(), sanitizeDocxScene(scene));
    let st;
    try { st = await fs.stat(dir); } catch {
      return { files: [], error: { msg: `未找到场景「${scene}」`, status: 404 } };
    }
    if (!st.isDirectory()) {
      return { files: [], error: { msg: `未找到场景「${scene}」`, status: 404 } };
    }
    if (explicitNames.length > 0) {
      const found: string[] = [];
      for (const name of explicitNames) {
        const p = join(dir, name);
        try { if ((await fs.stat(p)).isFile()) found.push(p); }
        catch { return { files: [], error: { msg: `模板不存在：${name}`, status: 404 } }; }
      }
      return { files: found };
    }
    // 场景下全部 .docx
    let names: string[];
    try { names = await fs.readdir(dir); } catch { names = []; }
    const all = names
      .filter((n) => /\.docx$/i.test(n) && !n.startsWith('~$'))
      .map((n) => join(dir, n));
    if (all.length === 0) return { files: [], error: { msg: '该场景下没有 .docx 模板', status: 400 } };
    return { files: all };
  }

  // scene 空：降级模式，必须显式指定模板名
  if (explicitNames.length === 0) {
    return { files: [], error: { msg: 'scene 为空时必须指定 template(s) 文件名', status: 400 } };
  }
  const found: string[] = [];
  for (const name of explicitNames) {
    const abs = await resolveTemplateFileAcrossScenes(name);
    if (abs) found.push(abs);
    else return { files: [], error: { msg: `所有场景下均未找到模板：${name}`, status: 404 } };
  }
  return { files: found };
}

/** 在模板库所有场景下反查某个文件名对应的绝对路径（找到立即返回） */
async function resolveTemplateFileAcrossScenes(name: string): Promise<string | null> {
  const safe = basename(name); // 双保险：去穿越
  if (!safe) return null;
  const root = docxTemplateLibraryRoot();
  let scenes: string[];
  try { scenes = await fs.readdir(root); } catch { return null; }
  for (const s of scenes) {
    const p = join(root, s, safe);
    try { if ((await fs.stat(p)).isFile()) return p; } catch { /* continue */ }
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const scene = (body.scene || '').toString().trim();
    const template = (body.template || '').toString().trim();
    const templatesRaw = body.templates;
    const templates: string[] | undefined = Array.isArray(templatesRaw)
      ? (templatesRaw as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;
    const data = body.data;
    const rows = body.rows;

    // P1-1-4 格式 B：rows 数组
    const isBatch = Array.isArray(rows) && rows.length > 0;
    let normalizedRows: Record<string, unknown>[] = [];

    if (isBatch) {
      normalizedRows = rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
      if (normalizedRows.length === 0) {
        return NextResponse.json({ ok: false, error: 'rows 必须是非空对象数组' }, { status: 400 });
      }
    } else {
      // 格式 A：data 单套
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return NextResponse.json({ ok: false, error: 'data 必须为字段对象' }, { status: 400 });
      }
      normalizedRows = [data as Record<string, unknown>];
    }

    const script = resolveDocxTemplateScript('fill_template.py');
    if (!script) {
      return NextResponse.json({ ok: false, error: '未找到 fill_template.py 脚本' }, { status: 500 });
    }

    const resolved = await resolveTemplateFiles({ scene, template, templates });
    if (resolved.error) {
      return NextResponse.json({ ok: false, error: resolved.error.msg }, { status: resolved.error.status });
    }
    const tplFiles = resolved.files;

    // 输出到项目 homework/template/<批次子目录>/（交付物统一进 homework 体系，Finder 可见；
    // 每个批次独立子目录，避免多次生成的文件混在同一目录难以区分）
    const project = await getCurrentProject();
    const templateRoot = join(project.path, 'homework', 'template');
    const ts = Date.now();
    const batchDir = `template-fill-${ts}`;
    const outDir = join(templateRoot, batchDir);
    await fs.mkdir(outDir, { recursive: true });

    const dataJson = join(outDir, `.data-${ts}.json`);
    const rowsJson = join(outDir, `.rows-${ts}.json`);
    const zipPath = join(outDir, `模板填充-${ts}.zip`);

    let tempDataFile: string | null = null;
    try {
      const argParts = [script];
      for (const f of tplFiles) argParts.push(`"${f}"`);

      if (isBatch) {
        await fs.writeFile(rowsJson, JSON.stringify(normalizedRows));
        argParts.push('--rows-json', `"${rowsJson}"`);
        tempDataFile = rowsJson;
      } else {
        await fs.writeFile(dataJson, JSON.stringify(normalizedRows[0]));
        argParts.push('--data-json', `"${dataJson}"`);
        tempDataFile = dataJson;
      }
      argParts.push('--out-dir', `"${outDir}"`);
      argParts.push('--zip', `"${zipPath}"`);
      // 每套数据一个子目录（set_000/、set_001/...）：同套多个模板文件归入同一子目录，与批次目录双层隔离
      argParts.push('--row-subdir', 'set');

      const cmd = [shellArg(pythonBin('模板批量填充')), ...argParts.map((p) => (p.startsWith('/') || p.startsWith('"')) ? p : `"${p}"`)].join(' ');
      const { stdout } = await execAsync(cmd, { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
      const res = JSON.parse(stdout || '{}');
      if (!res.ok) {
        return NextResponse.json({ ok: false, error: (res.errors && res.errors.length > 0) ? res.errors[0].error || '填充失败' : '填充失败' }, { status: 500 });
      }
      const generated = (res.generated || []).map((g: { file: string; size: number }) => ({
        file: g.file,
        size: g.size,
        path: `homework/template/${batchDir}/${g.file}`,
      }));
      return NextResponse.json({
        ok: true,
        message: `模板填充完成：${generated.length} 个文档已生成，保存在 homework/template/${batchDir}/ 目录。读取时请使用 homework/template/ 前缀相对路径（如 read_file(path="homework/template/${batchDir}/${generated[0]?.file || '<文件名>'}")）。`,
        generated,
        zip: res.zip ? { name: basename(zipPath), path: `homework/template/${batchDir}/${basename(zipPath)}` } : null,
      });
    } finally {
      for (const p of [dataJson, rowsJson]) if (p) await fs.unlink(p).catch(() => { /* ignore */ });
    }
  } catch (e) {
    console.error('模板填充失败:', e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
