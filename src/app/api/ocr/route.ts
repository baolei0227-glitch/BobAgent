import { NextRequest, NextResponse } from 'next/server';
import { resolve, isAbsolute, join } from 'path';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { getCurrentProject } from '@/lib/project/project-manager';
import { SANDBOX_DIRNAME } from '@/lib/app-root';

/**
 * POST /api/ocr — 独立 OCR 端点（轻量 API，与 ocr_document 工具共享 ocr-service 引擎）
 *
 * body: { path: string, upgrade?: 'off'|'auto'|'always' }  文件路径：
 *   - 绝对路径 / ~/ 路径（用户已授权目录内）
 *   - attachments/、homework/ 相对路径（从项目根解析）
 *   upgrade 可选：off=纯本地（默认）；auto=质量低/勾稽异常自动升级视觉大模型；always=全部升级（需配置 Vision Model）
 *
 * 返回: { success, method, text, pageCount, pages: [{index,text,qualityScore,ledgerVerified,rotated,enhanced,upgraded,upgradeChain,upgradeModel}], upgradedCount, error? }
 *   upgradeChain: 'online-ocr'|'vlm-upgrade'（该页采用在线模型时的链路）；upgradeModel: 实际采用的模型 id
 */

/** 当前项目根路径（无激活项目时回退 ~/BobWork/.sandbox 兜底） */
async function projectRootPath(): Promise<string> {
  try {
    const project = await getCurrentProject();
    return project.path;
  } catch {
    return join(homedir(), 'BobWork', SANDBOX_DIRNAME);
  }
}

/** 与 tools.ts resolvePath 一致的路径解析（轻量版） */
async function resolveInputPath(input: string): Promise<string> {
  let p = input;
  if (p === '~') p = homedir();
  else if (p.startsWith('~/')) p = `${homedir()}/${p.slice(2)}`;
  if (isAbsolute(p)) return resolve(p);
  const root = await projectRootPath();
  const normalized = p.replace(/\\/g, '/');
  if (normalized.startsWith('attachments/') || normalized === 'attachments') {
    return resolve(join(root, p));
  }
  if (normalized.startsWith('homework/') || normalized === 'homework') {
    return resolve(join(root, p));
  }
  return resolve(join(root, p));
}

/**
 * GET /api/ocr?action=setup-status — 探测 bob-ocr-mcp 常驻服务，返回配置页地址
 * （settingsUrl 自带 token，供 BobWork 设置里"Open Config"一键打开插件配置页）。
 */
export async function GET() {
  try {
    const { getOcrSetupStatus } = await import('@/lib/mcp/ocr-client');
    const status = await getOcrSetupStatus();
    return NextResponse.json({ success: true, ...status });
  } catch (e) {
    return NextResponse.json(
      { success: false, mcpOnline: false, settingsUrl: null, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const pathArg = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!pathArg) {
      return NextResponse.json({ success: false, error: 'path is required' }, { status: 400 });
    }

    const filePath = await resolveInputPath(pathArg);
    const st = await fs.stat(filePath).catch(() => null);
    if (!st?.isFile()) {
      return NextResponse.json({ success: false, error: `File not found or unreadable: ${pathArg}` }, { status: 404 });
    }

    const { ocrFile } = await import('@/lib/pdf/ocr-service');
    // upgrade 策略（可选）：off/auto/always，非法值回退 off
    const upgradeArg = typeof body?.upgrade === 'string' ? body.upgrade.trim() : '';
    const upgrade = upgradeArg === 'auto' || upgradeArg === 'always' ? upgradeArg : 'off';
    const result = await ocrFile(filePath, { upgrade });
    if (!result.success) {
      return NextResponse.json(result, { status: 422 });
    }

    // OCR 结果写入解析缓存（{project}/.cache/parse/{hash}.json，按内容 hash 键控）：
    // 此后 BobWork 聊天 PDF 注入预热 / read_attachment 工具按同款 hash+projectPath 直接命中，
    // 无需对同一文件二次 OCR。写入失败不影响本次响应。
    try {
      if (filePath.toLowerCase().endsWith('.pdf')) {
        const [{ computeFileHash }, { setCache }] = await Promise.all([
          import('@/lib/parse/image-parser'),
          import('@/lib/parse/cache'),
        ]);
        const hash = await computeFileHash(filePath);
        const projectPath = await projectRootPath();
        await setCache(hash, {
          file_name: filePath.split('/').pop() || 'document.pdf',
          file_type: 'pdf',
          mime_type: 'application/pdf',
          extracted_text: result.text,
          parse_method: 'text_extract',
          parsed_at: new Date().toISOString(),
          file_hash: hash,
        }, projectPath);
      }
    } catch { /* 缓存写入失败不影响 OCR 主流程 */ }

    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
