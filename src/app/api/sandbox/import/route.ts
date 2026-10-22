import { NextRequest } from 'next/server';
import { join } from 'path';
import { promises as fs } from 'fs';
import AdmZip from 'adm-zip';
import { resolveAppRoot, BOB_SANDBOX_DIRNAME } from '@/lib/app-root';
import { listApps, safeChildPath, APP_SCHEMA_VERSION } from '@/lib/sandbox/apps';
import { guardRequestSource } from '@/lib/http/loopback-guard';

/** 导入边界（2026-10-10）：整包与条目上限，避免 zip 炸弹/内存放大打满磁盘 */
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

/**
 * Import a mini-app from a ZIP file.
 * POST /api/sandbox/import
 *
 * Body: FormData with field "file" = uploaded .zip
 *
 * The ZIP should contain manifest.json at its root (or inside a single top-level
 * directory). The contents are extracted into .sandbox/apps/<appId>/.
 * If the appId already exists, a new unique ID is generated to avoid overwriting.
 */
export async function POST(request: NextRequest) {
  const denied = await guardRequestSource(request);
  if (denied) return denied;
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file || !(file instanceof File)) {
      return Response.json({ success: false, error: 'No file uploaded' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > MAX_ZIP_BYTES) {
      return Response.json({ success: false, error: `ZIP 过大（>${Math.floor(MAX_ZIP_BYTES / 1024 / 1024)}MB）` }, { status: 400 });
    }
    const zip = new AdmZip(buffer);

    // Find manifest.json — could be at root or inside a single top-level dir
    const entries = zip.getEntries();
    if (entries.length > MAX_ENTRIES) {
      return Response.json({ success: false, error: `ZIP 条目过多（>${MAX_ENTRIES}）` }, { status: 400 });
    }
    const uncompressed = entries.reduce((n, e) => n + (Number(e.header?.size) || 0), 0);
    if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
      return Response.json({ success: false, error: 'ZIP 解压后体积过大' }, { status: 400 });
    }
    const manifestEntry = entries.find((e) => e.entryName.endsWith('manifest.json'));
    if (!manifestEntry) {
      return Response.json(
        { success: false, error: 'manifest.json not found in ZIP' },
        { status: 400 },
      );
    }

    // Parse manifest to get the original appId
    let manifest: { id?: string; name?: string; [k: string]: unknown };
    try {
      manifest = JSON.parse(manifestEntry.getData().toString('utf-8'));
    } catch {
      return Response.json(
        { success: false, error: 'manifest.json is not valid JSON' },
        { status: 400 },
      );
    }

    const originalId = String(manifest.id || '').replace(/[^a-zA-Z0-9_-]/g, '_');

    // Determine the base path inside the ZIP (strip top-level dir if any)
    const manifestDir = manifestEntry.entryName.includes('/')
      ? manifestEntry.entryName.slice(0, manifestEntry.entryName.lastIndexOf('/'))
      : '';

    // Generate a unique appId — if originalId already exists, create a new one
    const appsRoot = join(resolveAppRoot(), BOB_SANDBOX_DIRNAME, 'apps');
    await fs.mkdir(appsRoot, { recursive: true });

    let appId = originalId || `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const existingApps = await listApps();
    const existingIds = new Set(existingApps.map((a) => a.id));
    if (existingIds.has(appId)) {
      appId = `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    // Create the target directory
    const targetDir = join(appsRoot, appId);
    await fs.mkdir(targetDir, { recursive: true });

    // Extract all entries, stripping the manifestDir prefix.
    // 2026-10-10：整段失败要回滚（原来失败只返回 500，留下无 manifest 的半成品目录 →
    // listApps 静默跳过 → 不可见、不可删、白占磁盘）。
    try {
      for (const entry of entries) {
        // Skip directories (they'll be created by file writes)
        if (entry.isDirectory) continue;

        let relativePath = entry.entryName;
        if (manifestDir && relativePath.startsWith(manifestDir + '/')) {
          relativePath = relativePath.slice(manifestDir.length + 1);
        }
        if (!relativePath) continue;

        // 路径穿越防护：safeChildPath 统一实现（拒绝 `..`、绝对路径、空字节）
        const destPath = safeChildPath(targetDir, relativePath);
        if (!destPath) continue;
        const destDir = join(destPath, '..');
        await fs.mkdir(destDir, { recursive: true });
        await fs.writeFile(destPath, entry.getData());
      }
    } catch (e) {
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      return Response.json(
        { success: false, error: `ZIP 解包失败：${e instanceof Error ? e.message : String(e)}` },
        { status: 400 },
      );
    }

    // 入口校验（2026-10-10）：manifest.entry 是**不可信字段**（ZIP 条目名查了 `..`，这个字段没查），
    // 必须确认它指向 app 目录内真实存在的文件，否则预览/update 就能读写 app 目录之外。
    const entryRel = typeof manifest.entry === 'string' && manifest.entry.trim() ? manifest.entry.trim() : 'index.html';
    const entryPath = safeChildPath(targetDir, entryRel);
    let entryOk = false;
    if (entryPath) {
      try {
        await fs.access(entryPath);
        entryOk = true;
      } catch { /* 入口不存在 */ }
    }
    if (!entryOk) {
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      return Response.json(
        { success: false, error: `manifest.entry 不合法或文件缺失：${entryRel}` },
        { status: 400 },
      );
    }

    // Update manifest with the new appId
    manifest.id = appId;
    manifest.entry = entryRel;
    // 信任分级：导入 = 第三方代码，hostTool 只给只读且限自己目录（评估 A5）
    manifest.origin = 'imported';
    manifest.schemaVersion = APP_SCHEMA_VERSION;
    manifest.updatedAt = new Date().toISOString();
    await fs.writeFile(
      join(targetDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    return Response.json({
      success: true,
      app: manifest,
    });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
