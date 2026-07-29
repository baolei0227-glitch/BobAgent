import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import type { IpcResult, ParseCacheRecord, ParseMode, ParseResult, VisionConfig } from '../../src/lib/parse/types';
import { parseImage } from '../../src/lib/parse/image-parser';
import { getCache, clearCache } from '../../src/lib/parse/cache';
import {
  getCurrentProject,
  getProjectVisionModel,
  buildVisionModelConfig,
} from '../../src/lib/project/project-manager';

const ALLOWED_MODES: ParseMode[] = ['general', 'document', 'screenshot', 'chart', 'casual'];
const HASH_REGEX = /^[a-f0-9]{64}$/i;

function error<T>(code: string, message: string): IpcResult<T> {
  return {
    success: false,
    error: { code, message },
  };
}

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data };
}

function validateFilePath(filePath: unknown): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return null;
  }
  const normalized = path.normalize(filePath);
  if (!path.isAbsolute(normalized) || normalized.includes('..')) {
    return null;
  }
  return normalized;
}

async function getCurrentProjectContext(): Promise<{
  projectPath: string;
  visionModelId: string;
}> {
  const project = await getCurrentProject();
  if (!project) {
    throw new Error('NO_ACTIVE_PROJECT');
  }
  const visionModelId = await getProjectVisionModel(project.id);
  return { projectPath: project.path, visionModelId };
}

async function buildVisionConfig(
  modelId: string,
  mode: ParseMode
): Promise<VisionConfig> {
  const { getProjectVisionApiKey, getProjectVisionBaseUrl } = await import('@/lib/project/project-manager');
  const project = await getCurrentProject();
  const apiKey = await getProjectVisionApiKey(project.id);
  if (!apiKey) {
    throw new Error('请在项目设置中配置视觉模型 API Key');
  }
  const baseUrl = await getProjectVisionBaseUrl(project.id);
  const modelConfig = await buildVisionModelConfig(modelId, apiKey, baseUrl || undefined);
  return {
    model: modelConfig.model,
    apiKey: modelConfig.apiKey,
    baseUrl: modelConfig.baseUrl,
    mode,
  };
}

export async function handleParseImage(
  _event: IpcMainInvokeEvent,
  filePath: unknown,
  mode: unknown = 'general'
): Promise<IpcResult<ParseResult>> {
  try {
    const validPath = validateFilePath(filePath);
    if (!validPath) {
      return error('INVALID_FILE_PATH', '文件路径无效或包含非法字符');
    }

    if (typeof mode !== 'string' || !ALLOWED_MODES.includes(mode as ParseMode)) {
      return error('INVALID_MODE', `解析模式无效，必须是: ${ALLOWED_MODES.join(', ')}`);
    }

    const { projectPath, visionModelId } = await getCurrentProjectContext();
    const config = await buildVisionConfig(visionModelId, mode as ParseMode);
    const result = await parseImage(validPath, projectPath, config);
    return ok(result);
  } catch (err) {
    const code = err instanceof Error ? err.message : 'UNKNOWN_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    return error(code, message);
  }
}

export async function handleParseGetCache(
  _event: IpcMainInvokeEvent,
  hash: unknown
): Promise<IpcResult<ParseCacheRecord | null>> {
  try {
    if (typeof hash !== 'string' || !HASH_REGEX.test(hash)) {
      return error('INVALID_HASH', 'hash 必须是 64 位十六进制字符串');
    }

    const { projectPath } = await getCurrentProjectContext();
    const record = await getCache(hash, projectPath);
    return ok(record);
  } catch (err) {
    const code = err instanceof Error ? err.message : 'UNKNOWN_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    return error(code, message);
  }
}

export async function handleParseClearCache(
  _event: IpcMainInvokeEvent
): Promise<IpcResult<void>> {
  try {
    const { projectPath } = await getCurrentProjectContext();
    await clearCache(projectPath);
    return ok(undefined);
  } catch (err) {
    const code = err instanceof Error ? err.message : 'UNKNOWN_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    return error(code, message);
  }
}