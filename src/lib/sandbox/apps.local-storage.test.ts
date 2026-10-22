import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let root = '';
const appId = 'app_local_1';

vi.mock('@/lib/app-root', () => ({
  resolveAppRoot: () => root,
  BOB_SANDBOX_DIRNAME: 'bob-sandbox',
}));

import { readAppLocalStorage, writeAppLocalStorage } from './apps';

const key = (suffix: string) => `bob_sb_${appId}_${suffix}`;

describe('Layer-1 local storage proxy', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bw-local-state-'));
    const dir = join(root, 'bob-sandbox', 'apps', appId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id: appId, name: 'Test', entry: 'index.html' }), 'utf-8');
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes, reads and removes keys that survive a reload', async () => {
    const ok = await writeAppLocalStorage(appId, [
      { key: key('theme'), value: 'dark' },
      { key: key('model'), value: 'deepseek-flash' },
    ]);
    expect(ok).toBe(true);
    await expect(readAppLocalStorage(appId)).resolves.toEqual({
      [key('theme')]: 'dark',
      [key('model')]: 'deepseek-flash',
    });

    await expect(writeAppLocalStorage(appId, [{ key: key('theme'), value: null }])).resolves.toBe(true);
    await expect(readAppLocalStorage(appId)).resolves.toEqual({ [key('model')]: 'deepseek-flash' });
  });

  it('rejects invalid app ids / keys and drops oversized values', async () => {
    await expect(writeAppLocalStorage('../evil', [{ key: key('x'), value: '1' }])).resolves.toBe(false);
    await expect(
      writeAppLocalStorage(appId, [{ key: 'bad\nkey', value: '1' }]),
    ).resolves.toBe(false);
    await expect(
      writeAppLocalStorage(appId, [{ key: key('huge'), value: 'x'.repeat(100 * 1024 + 1) }]),
    ).resolves.toBe(false);
    await expect(readAppLocalStorage(appId)).resolves.toEqual({ [key('model')]: 'deepseek-flash' });
  });
});
