import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ParseResult, VisionConfig } from './types';
import { describeImage } from './vision-adapter';
import { getCache, setCache } from './cache';
export function getMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.avif': 'image/avif',
  };
  return map[ext] ?? 'image/png';
}

export async function fileToBase64(filePath: string): Promise<{ data: string; mimeType: string }> {
  const buffer = await fs.readFile(filePath);
  const mimeType = getMimeTypeFromPath(filePath);
  return {
    data: buffer.toString('base64'),
    mimeType,
  };
}

export async function computeFileHash(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function parseImage(
  filePath: string,
  projectPath: string,
  config: VisionConfig
): Promise<ParseResult> {
  const fileName = path.basename(filePath);
  const mimeType = getMimeTypeFromPath(filePath);

  const { data: base64Data } = await fileToBase64(filePath);
  const fileHash = await computeFileHash(filePath);

  const cached = await getCache(fileHash, projectPath);
  if (cached) {
    return {
      ...cached.result,
      file_name: fileName,
      mime_type: mimeType,
      parsed_at: cached.result.parsed_at,
    };
  }

  const visionStart = Date.now();
  const visionResult = await describeImage(
    { type: 'base64', data: base64Data, mimeType },
    config
  );
  const visionDuration = Date.now() - visionStart;

  const result: ParseResult = {
    file_name: fileName,
    file_type: 'image',
    mime_type: mimeType,
    extracted_text: visionResult.description,
    parse_method: 'vision',
    parsed_at: new Date().toISOString(),
    stats: {
      duration_ms: visionDuration,
      input_tokens: visionResult.input_tokens,
      output_tokens: visionResult.output_tokens,
    },
    file_hash: fileHash,
  };

  await setCache(fileHash, result, projectPath);

  return result;
}

export async function parseImages(
  filePaths: string[],
  projectPath: string,
  config: VisionConfig
): Promise<ParseResult[]> {
  const results: ParseResult[] = [];
  for (const filePath of filePaths) {
    results.push(await parseImage(filePath, projectPath, config));
  }
  return results;
}