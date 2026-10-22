/**
 * 数据卫生回归（2026-10-10 评估 P1/P2 批次）：
 *   - 配额判定（原来只有 BobStorage 的 data/ 有配额，入口 HTML/资产可写满磁盘）
 *   - 历史文件名精确解析（原来 endsWith 会把 my-app.js 的备份算成 app.js 的）
 *   - 导出内联判据（原来 `[^"'http]` 会跳过 theme.css/tailwind.css 这类相对资源）
 *   - 审计摘要（必须含工具名与目标，且**不得**带出 content/script 正文）
 *   - .history 清理（实测它曾占小程序目录 83%）
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  APP_FILE_MAX_BYTES,
  APP_TOTAL_QUOTA_BYTES,
  checkAppQuota,
  parseHistoryName,
} from '@/lib/sandbox/apps';
import { isRelativeAssetPath } from '@/app/api/chat/tools/admin';
import { summarizeHostToolCall } from '@/lib/sandbox/bridge';

describe('配额判定', () => {
  it('单文件超限拒绝、目录总量超限拒绝、正常放行', () => {
    expect(checkAppQuota({ fileBytes: APP_FILE_MAX_BYTES + 1, currentTotalBytes: 0, previousFileBytes: 0 }).ok).toBe(false);
    expect(checkAppQuota({ fileBytes: 1024, currentTotalBytes: APP_TOTAL_QUOTA_BYTES + 1, previousFileBytes: 0 }).ok).toBe(false);
    expect(checkAppQuota({ fileBytes: 1024, currentTotalBytes: 2048, previousFileBytes: 1024 }).ok).toBe(true);
  });

  it('覆盖写按 delta 计算（不是简单累加）', () => {
    // 目录已 49MB，覆盖一个 1MB 的文件成 2MB → 变成 50MB，仍在阈值内
    const ok = checkAppQuota({
      fileBytes: 2 * 1024 * 1024,
      currentTotalBytes: 49 * 1024 * 1024,
      previousFileBytes: 1024 * 1024,
    });
    expect(ok.ok).toBe(true);
    // 再加 2MB 就超了
    const bad = checkAppQuota({
      fileBytes: 4 * 1024 * 1024,
      currentTotalBytes: 49 * 1024 * 1024,
      previousFileBytes: 1024 * 1024,
    });
    expect(bad.ok).toBe(false);
  });
});

describe('历史文件名精确解析', () => {
  const stamp = '2026-10-10T08-30-00-000Z';
  it('命中自身、不误伤同目录相近文件名', () => {
    expect(parseHistoryName(`${stamp}-app.js`, 'app.js')).toBe(stamp);
    expect(parseHistoryName(`${stamp}-my-app.js`, 'app.js')).toBeNull(); // 旧实现会命中
    expect(parseHistoryName(`${stamp}-app.js`, 'my-app.js')).toBeNull();
    expect(parseHistoryName('not-a-stamp-app.js', 'app.js')).toBeNull();
  });
});

describe('导出内联判据', () => {
  it('相对资源内联；http(s)/协议相对/绝对路径/data: 不内联', () => {
    for (const ok of ['theme.css', 'css/style.css', 'js/app.js', 'tailwind.css?v=3', 'print.css']) {
      expect(isRelativeAssetPath(ok), ok).toBe(true);
    }
    for (const bad of ['https://cdn.jsdelivr.net/x.css', 'http://x/y.js', '//cdn/x.css', '/assets/x.css', 'data:text/css,body{}', 'mailto:a@b.c']) {
      expect(isRelativeAssetPath(bad), bad).toBe(false);
    }
  });
});

describe('审计摘要', () => {
  it('含工具名与目标，且不泄漏正文', () => {
    const line = summarizeHostToolCall('write_file', {
      path: 'bob-sandbox/apps/app_x_1/index.html',
      content: 'SECRET-CONTENT'.repeat(100),
    });
    expect(line).toContain('write_file');
    expect(line).toContain('bob-sandbox/apps/app_x_1/index.html');
    expect(line).not.toContain('SECRET-CONTENT');
    expect(line).toMatch(/\(\d+B content\)/);

    const cmd = summarizeHostToolCall('run_command', { cmd: 'echo hello' });
    expect(cmd).toBe('run_command cmd=echo hello');

    const script = summarizeHostToolCall('execute_script', { language: 'python', script: 'print(1)' });
    expect(script).toContain('lang=python');
    expect(script).not.toContain('print(1)');
  });
});

describe('.history 清理（sweepIntermediateFiles）', () => {
  const ROOT = mkdtempSync(join(tmpdir(), 'bobwork-hygiene-'));
  const PREV = process.env.BOBWORK_HOME;

  beforeAll(() => {
    process.env.BOBWORK_HOME = ROOT;
    const history = join(ROOT, 'bob-sandbox', 'apps', 'app_hist_1', '.history');
    mkdirSync(history, { recursive: true });
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(history, `2026-10-0${(i % 9) + 1}T00-00-0${i % 10}-000Z-index.html`), `v${i}`, 'utf-8');
    }
    mkdirSync(join(ROOT, 'bob-sandbox', 'apps', 'app_hist_1'), { recursive: true });
    writeFileSync(join(ROOT, 'bob-sandbox', 'apps', 'app_hist_1', 'index.html'), 'current', 'utf-8');
  });

  afterAll(() => {
    if (PREV === undefined) delete process.env.BOBWORK_HOME;
    else process.env.BOBWORK_HOME = PREV;
    rmSync(ROOT, { recursive: true, force: true });
  });

  it('每个 .history 目录裁剪到上限（当前文件本身不动）', async () => {
    const { sweepIntermediateFiles } = await import('@/lib/cleanup/intermediate-cleanup');
    const { readdirSync, existsSync } = await import('fs');
    const before = readdirSync(join(ROOT, 'bob-sandbox', 'apps', 'app_hist_1', '.history')).length;
    expect(before).toBe(25);
    await sweepIntermediateFiles();
    const after = readdirSync(join(ROOT, 'bob-sandbox', 'apps', 'app_hist_1', '.history')).length;
    expect(after).toBeLessThanOrEqual(20);
    expect(existsSync(join(ROOT, 'bob-sandbox', 'apps', 'app_hist_1', 'index.html'))).toBe(true);
  });
});
