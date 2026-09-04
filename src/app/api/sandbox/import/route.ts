import { NextRequest } from 'next/server';
import { join } from 'path';
import { promises as fs } from 'fs';
import AdmZip from 'adm-zip';
import { resolveAppRoot, BOB_SANDBOX_DIRNAME } from '@/lib/app-root';
import { listApps } from '@/lib/sandbox/apps';

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
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file || !(file instanceof File)) {
      return Response.json({ success: false, error: 'No file uploaded' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const zip = new AdmZip(buffer);

    // Find manifest.json — could be at root or inside a single top-level dir
    const entries = zip.getEntries();
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

    // Extract all entries, stripping the manifestDir prefix
    for (const entry of entries) {
      // Skip directories (they'll be created by file writes)
      if (entry.isDirectory) continue;

      let relativePath = entry.entryName;
      if (manifestDir && relativePath.startsWith(manifestDir + '/')) {
        relativePath = relativePath.slice(manifestDir.length + 1);
      }
      if (!relativePath) continue;

      // Prevent path traversal
      if (relativePath.includes('..')) continue;

      const destPath = join(targetDir, relativePath);
      const destDir = join(destPath, '..');
      await fs.mkdir(destDir, { recursive: true });
      await fs.writeFile(destPath, entry.getData());
    }

    // Update manifest with the new appId
    manifest.id = appId;
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
