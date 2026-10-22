import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let root = '';

vi.mock('@/lib/app-root', () => ({
  resolveAppRoot: () => root,
  BOB_SANDBOX_DIRNAME: 'bob-sandbox',
}));

import { appendCodingTelemetry } from './telemetry';

describe('coding telemetry', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bw-telemetry-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('appends one sanitized JSONL line with numeric metrics only', async () => {
    await appendCodingTelemetry({
      appId: 'app_test_123',
      modelId: 'deepseek-flash',
      durationMs: 1234.6,
      firstCodeMs: 200,
      firstPreviewMs: 900,
      toolCalls: 4,
      toolErrors: 1,
      autoRepair: true,
      consoleErrors: 2,
    });
    const text = await readFile(join(root, 'bob-sandbox', 'telemetry.jsonl'), 'utf-8');
    const line = JSON.parse(text.trim()) as Record<string, unknown>;
    expect(line.appId).toBe('app_test_123');
    expect(line.modelId).toBe('deepseek-flash');
    expect(line.durationMs).toBe(1235);
    expect(line.firstCodeMs).toBe(200);
    expect(line.firstPreviewMs).toBe(900);
    expect(line.toolCalls).toBe(4);
    expect(line.toolErrors).toBe(1);
    expect(line.autoRepair).toBe(true);
    expect(line.consoleErrors).toBe(2);
    expect(typeof line.at).toBe('string');
    // 只记录指标：不应该出现任何用户愿望/代码字段
    expect(Object.keys(line).sort()).toEqual([
      'appId', 'at', 'autoRepair', 'consoleErrors', 'durationMs', 'firstCodeMs', 'firstPreviewMs', 'modelId', 'toolCalls', 'toolErrors',
    ]);
  });

  it('drops an invalid app id instead of writing a traversal-ish value', async () => {
    await appendCodingTelemetry({ appId: '../evil', durationMs: 1 });
    const text = await readFile(join(root, 'bob-sandbox', 'telemetry.jsonl'), 'utf-8');
    const last = JSON.parse(text.trim().split('\n').pop() || '{}') as Record<string, unknown>;
    expect(last.appId).toBeUndefined();
    expect(last.durationMs).toBe(1);
  });
});
