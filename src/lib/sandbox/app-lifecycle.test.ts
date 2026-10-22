/**
 * 小程序「连接点」安全与生命周期回归（2026-10-10）。
 *
 * 背景（评估 P0）：删除小程序原来只 `rm -rf apps/<id>/`，而
 *   ① `DELETE /api/sandbox` 的 id 未净化 → `id:"../../"` 可递归删掉 ~/BobWork；
 *   ② `manifest.entry` 未做包含性校验 → 导入 ZIP 可任意文件读 + 任意文本覆写；
 *   ③ 桥是无状态的、appId 由客户端自报 → 删除后已打开的页面仍能调命令，saveAppData 还会
 *      把目录复活成无 manifest 的幽灵目录。
 * 本组锁住：id/子路径守卫、entry 越界、存在性闸（删除即断连 + 不复活）、删除级联与回收站。
 *
 * 注意：`lib/project/project-manager.ts` 在**模块加载时**缓存 APP_ROOT，所以必须先设置
 * BOBWORK_HOME 再动态 import 会间接引入它的模块（app-lifecycle / bridge）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sanitizeAppId, safeChildPath } from './apps';

const ROOT = mkdtempSync(join(tmpdir(), 'bobwork-lifecycle-'));
const PREV_HOME = process.env.BOBWORK_HOME;
process.env.BOBWORK_HOME = ROOT; // 供 resolveAppRoot()（运行时读取）

const APPS = join(ROOT, 'bob-sandbox', 'apps');
const CANARY = join(ROOT, 'canary.txt');
const APP_LIVE = 'app_live_1';
const APP_EVIL = 'app_evil_1';
const NODE_FILE = join(ROOT, 'BobWorkspace', 'p1', 'notes-memory', 'n1.md');

function makeApp(id: string, entry = 'index.html'): void {
  const dir = join(APPS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ id, name: `App ${id}`, description: '', createdAt: '', updatedAt: '', entry }),
    'utf-8',
  );
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>ok</body></html>', 'utf-8');
}

beforeAll(() => {
  writeFileSync(CANARY, 'CANARY', 'utf-8');
  makeApp(APP_LIVE);
  makeApp(APP_EVIL, '../../../canary.txt'); // 恶意 entry：指向 app 目录之外
  // 授权表残留（删除级联需要清掉）
  writeFileSync(
    join(ROOT, '.settings.json'),
    JSON.stringify({
      version: 1,
      sandboxChatPermissions: { [APP_LIVE]: 'permanent', app_other_1: 'permanent' },
      sandboxGraphPermissions: { [APP_LIVE]: 'control' },
    }),
    'utf-8',
  );
  // 项目 + 引用该小程序的节点（删除级联需要解绑）
  mkdirSync(join(ROOT, 'BobWorkspace', 'p1', 'notes-memory'), { recursive: true });
  writeFileSync(
    join(ROOT, '.projects.json'),
    JSON.stringify({
      current_project_id: 'p1',
      projects: [
        {
          id: 'p1',
          name: 'P1',
          path: join(ROOT, 'BobWorkspace', 'p1'),
          created_at: '2026-10-01T00:00:00.000Z',
          last_accessed_at: '2026-10-01T00:00:00.000Z',
        },
      ],
    }),
    'utf-8',
  );
  writeFileSync(
    NODE_FILE,
    ['---', 'node_id: n1', 'title: 测试节点', `sandbox_app_id: ${APP_LIVE}`, 'created_at: 2026-10-01T00:00:00.000Z', '---', '', '正文内容', ''].join('\n'),
    'utf-8',
  );
});

/**
 * 桥的重依赖图（bridge → host-tools → tools/index）首次 import 在测试环境是数秒级成本。
 * 预热到 beforeAll：**必须排在上面那份 env/文件夹具之后**（vitest 按声明顺序执行，
 * bridge 会间接引入 project-manager，而它在模块加载时缓存 APP_ROOT）。
 * 原先两个用例都在 it() 体内首次 import，稳定撞上 5s 预算而超时。
 */
let bridge: typeof import('./bridge');
beforeAll(async () => {
  bridge = await import('./bridge');
}, 60_000);

afterAll(() => {
  if (PREV_HOME === undefined) delete process.env.BOBWORK_HOME;
  else process.env.BOBWORK_HOME = PREV_HOME;
  rmSync(ROOT, { recursive: true, force: true });
});

describe('appId 与子路径守卫', () => {
  it('sanitizeAppId 只放行 [A-Za-z0-9_-]', () => {
    expect(sanitizeAppId('app_mt0we0ph_iw5n0i')).toBe('app_mt0we0ph_iw5n0i');
    expect(sanitizeAppId('app_x-1')).toBe('app_x-1');
    for (const bad of ['../../', '..', '../x', 'a/b', 'a.b', '', '  ', 'x'.repeat(65), null, undefined, 'a\0b']) {
      expect(sanitizeAppId(bad)).toBeNull();
    }
  });

  it('safeChildPath 拒绝越界与绝对路径', () => {
    const appDir = join(APPS, APP_LIVE);
    expect(safeChildPath(appDir, 'index.html')).toBe(join(appDir, 'index.html'));
    expect(safeChildPath(appDir, 'css/style.css')).toBe(join(appDir, 'css', 'style.css'));
    for (const bad of ['../canary.txt', '../../etc/passwd', '/etc/passwd', '', 'a\0b']) {
      expect(safeChildPath(appDir, bad), String(bad)).toBeNull();
    }
  });
});

describe('删除与 entry 越界不得逃出小程序目录', () => {
  it('非法 id 不删任何东西（原来的 ../../ 穿越就是从这里进来的）', async () => {
    const { removeApp, trashApp } = await import('./apps');
    expect(await removeApp('../../canary')).toBe(false);
    expect(await removeApp('..')).toBe(false);
    expect((await trashApp('../../canary')).ok).toBe(false);
    expect(existsSync(CANARY)).toBe(true);
    expect(readFileSync(CANARY, 'utf-8')).toBe('CANARY');
  });

  it('恶意 manifest.entry 读不到、也写不到 app 目录之外', async () => {
    const { readAppEntry, updateAppEntry } = await import('./apps');
    expect(await readAppEntry(APP_EVIL)).toBeNull();
    expect(await updateAppEntry(APP_EVIL, 'HACKED')).toBe(false);
    expect(readFileSync(CANARY, 'utf-8')).toBe('CANARY');
  });
});

describe('存在性闸：删除即断连，且不复活幽灵目录', () => {
  it('不存在的小程序一律拒绝（原来任意随机 appId 都能用）', async () => {
    const { handleBridgeRequest } = bridge;
    await expect(handleBridgeRequest('getTheme', { _appId: 'app_missing_9' })).rejects.toThrow(/not found|id is required/);
    await expect(handleBridgeRequest('getTheme', {})).rejects.toThrow(/id is required/);
  });

  it('删除后：桥全部拒绝、目录不被重建、级联清干净、回收站可恢复', async () => {
    const { appExists, listTrash, restoreApp, purgeTrashItem } = await import('./apps');
    const { handleBridgeRequest } = bridge;
    const { deleteAppCascade } = await import('./app-lifecycle');

    expect(await appExists(APP_LIVE)).toBe(true);
    await expect(handleBridgeRequest('getTheme', { _appId: APP_LIVE })).resolves.toBeTruthy();

    const res = await deleteAppCascade(APP_LIVE);
    expect(res.ok).toBe(true);
    expect(res.nodesUnbound).toBe(1);
    expect(res.permissionsCleared).toBe(true);

    // ① 目录进回收站
    expect(existsSync(join(APPS, APP_LIVE))).toBe(false);
    const trash = await listTrash();
    expect(trash.length).toBe(1);
    expect(trash[0].appId).toBe(APP_LIVE);

    // ② 授权表：只清该 app，其它小程序不受影响
    const settings = JSON.parse(readFileSync(join(ROOT, '.settings.json'), 'utf-8')) as {
      sandboxChatPermissions?: Record<string, string>;
      sandboxGraphPermissions?: Record<string, string>;
    };
    expect(settings.sandboxChatPermissions?.[APP_LIVE]).toBeUndefined();
    expect(settings.sandboxGraphPermissions?.[APP_LIVE]).toBeUndefined();
    expect(settings.sandboxChatPermissions?.app_other_1).toBe('permanent');

    // ③ 节点解绑：sandbox_app_id 行没了，其余 frontmatter 与正文保留
    const node = readFileSync(NODE_FILE, 'utf-8');
    expect(node).not.toContain('sandbox_app_id');
    expect(node).toContain('title: 测试节点');
    expect(node).toContain('正文内容');

    // ④ 删除后桥一律拒绝（已打开的预览页下一次调用即失效）
    await expect(handleBridgeRequest('getTheme', { _appId: APP_LIVE })).rejects.toThrow(/not found/);
    await expect(
      handleBridgeRequest('saveAppData', { appId: APP_LIVE, key: 'ghost', value: { x: 1 }, _appId: APP_LIVE }),
    ).rejects.toThrow(/not found/);
    expect(existsSync(join(APPS, APP_LIVE))).toBe(false); // 幽灵目录不得复活

    // ⑤ 回收站可恢复
    expect((await restoreApp(trash[0].trashId)).ok).toBe(true);
    expect(await appExists(APP_LIVE)).toBe(true);
    await expect(handleBridgeRequest('getTheme', { _appId: APP_LIVE })).resolves.toBeTruthy();

    // ⑥ 再次删除后彻底清除
    const again = await deleteAppCascade(APP_LIVE);
    expect(again.ok).toBe(true);
    expect(await purgeTrashItem(again.trashId)).toBe(true);
    expect((await listTrash()).length).toBe(0);
  });
});
