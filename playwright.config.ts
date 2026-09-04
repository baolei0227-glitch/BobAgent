import { defineConfig } from '@playwright/test';

/**
 * BobWork e2e 测试配置
 *
 * 默认连接本地打包版应用的 next-server（http://localhost:8321）。
 * 若需独立运行，可设置 BASE_URL 指向 dev server（如 http://localhost:3000）。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  // e2e 共享同一份真实数据（授权根/节点/边），必须串行避免互相踩踏
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:8321',
    // 使用系统 Chrome，避免等待 Playwright 内置 chromium 下载
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
});
