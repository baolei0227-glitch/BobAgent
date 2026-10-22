import { NextRequest } from 'next/server';
import { join } from 'path';
import { promises as fs } from 'fs';
import AdmZip from 'adm-zip';
import { resolveAppRoot, BOB_SANDBOX_DIRNAME } from '@/lib/app-root';
import { guardRequestSource } from '@/lib/http/loopback-guard';

/**
 * Export a mini-app as a ZIP file.
 * GET /api/sandbox/export/<appId>
 *
 * Packs the entire .sandbox/apps/<appId>/ directory (manifest.json + index.html + data/ etc.)
 * into a ZIP and returns it as a downloadable file.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guardRequestSource(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    // Basic sanity on appId to prevent path traversal
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
    const appDir = join(resolveAppRoot(), BOB_SANDBOX_DIRNAME, 'apps', safeId);

    // Check directory exists
    try {
      await fs.access(appDir);
    } catch {
      return new Response('App not found', { status: 404 });
    }

    const zip = new AdmZip();
    // Add all files/dirs inside appDir, preserving relative paths.
    // 2026-10-10 评估：默认排除 .history（历史版本 = 一堆中间态快照，占体积且含被删掉的旧内容）。
    const entries = await fs.readdir(appDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.history' || entry.name === '.state') continue;
      const fullPath = join(appDir, entry.name);
      if (entry.isDirectory()) {
        zip.addLocalFolder(fullPath, entry.name);
      } else {
        zip.addLocalFile(fullPath);
      }
    }

    const zipBuffer = zip.toBuffer();
    const filename = `${safeId}.zip`;

    return new Response(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return new Response(`Error: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
  }
}
