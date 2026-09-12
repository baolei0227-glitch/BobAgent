import { test, expect } from '@playwright/test';

/**
 * 设置弹窗（SettingsModal 左右两栏重构）模拟操作验证
 *
 * 覆盖：左栏四面板切换 / 厂商 tab / 角色派发下拉联动 / 应用图标双选择 /
 *       架构图展示 / 脏标记与保存 / 未保存取消确认。
 *
 * 浏览器环境无 Electron preload，通过 addInitScript 注入 mock window.api，
 * settings 读写走 localStorage 降级通道。
 */

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const MOCK_AVATARS = [
  { id: 'builtin/pumpkin-a.png', name: 'pumpkin-a.png', dataUrl: PIXEL, builtin: true },
  { id: 'builtin/pumpkin-b.png', name: 'pumpkin-b.png', dataUrl: PIXEL, builtin: true },
  { id: 'custom/my-logo.png', name: 'my-logo.png', dataUrl: PIXEL, builtin: false },
];

const MOCK_SETTINGS = {
  version: 1,
  providers: [
    {
      type: 'deepseek',
      apiKey: 'sk-deepseek-mock',
      baseUrl: '',
      selectedModels: [
        { modelId: 'deepseek-v4-flash', thinking: true },
        { modelId: 'deepseek-v4-pro', thinking: true },
      ],
    },
    {
      type: 'qwen',
      apiKey: 'sk-qwen-mock',
      baseUrl: '',
      selectedModels: [
        { modelId: 'qwen-vl-max', thinking: false },
        { modelId: 'qwen-vl-plus', thinking: false },
      ],
    },
  ],
  search: { apiKey: '', baseUrl: '' },
  vision: {
    apiKey: 'sk-deepseek-mock',
    defaultModel: 'qwen-vl-max',
    defaultProvider: 'deepseek',
    auxiliaryApiKey: 'sk-qwen-mock',
    auxiliaryModel: 'qwen-vl-plus',
    auxiliaryProvider: 'qwen',
  },
  taskModel: { apiKey: '', defaultModel: '', defaultProvider: 'glm' },
  outcomeModel: { apiKey: '', defaultModel: '', defaultProvider: 'glm' },
  stt: { provider: 'doubao-stream', model: '', apiKey: '', baseUrl: '' },
  ui: {},
  general: {},
  textPresets: [],
  customTools: [],
  mcpServers: [],
  avatar: { mode: 'fixed', selected: 'builtin/pumpkin-a.png' },
  brandLogo: 'custom/my-logo.png',
};

test('settings: 四面板切换 / 厂商tab / 角色联动 / 图标 / 架构图 / 保存 / 取消确认', async ({ page }) => {
  // ── 注入 mock 环境 ──
  await page.addInitScript(
    ([avatars, settings]) => {
      (window as any).localStorage.setItem('bob-work-settings', JSON.stringify(settings));
      // 确保旧迁移键不存在（migrateOldSettingsIfNeeded 走空路径）
      (window as any).localStorage.removeItem('ai-canvas-providers');
      (window as any).localStorage.removeItem('ai-canvas-search');
      (window as any).api = {
        avatar: {
          list: async () => avatars,
          add: async () => ({ success: true, avatars }),
          delete: async (id: string) => ({
            success: true,
            avatars: avatars.filter((a: any) => a.id !== id),
          }),
        },
      };
    },
    [MOCK_AVATARS, MOCK_SETTINGS] as const,
  );

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  let confirmMsg = '';
  page.on('dialog', async (d) => {
    confirmMsg = d.message();
    await d.accept();
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('.react-flow__pane', { timeout: 20000 });
  // dev 模式下 Next.js Dev Tools 浮动按钮会覆盖侧边栏底部，隐藏以免拦截点击
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });

  // ── 打开设置弹窗：点击 BobWork logo（原齿轮菜单已融合） ──
  const logoBtn = page.locator('button:has(img[alt="BobWork"])').first();
  await logoBtn.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await page.screenshot({ path: 'e2e/artifacts/settings-1-open.png' });

  // ── 1. 左栏导航四项（左栏 button 含徽标数字，name 以目录名开头） ──
  for (const nav of ['Chat Models', 'Role Assignment', 'App Icons', 'Architecture']) {
    await expect(dialog.getByRole('button', { name: new RegExp(`^${nav}`) })).toBeVisible();
  }

  // ── 2. chat 面板：6 厂商 tab + 默认 DeepSeek 数据回填 ──
  for (const tab of ['DeepSeek', 'GLM', 'Moonshot', 'Qwen', 'OpenAI', 'Doubao']) {
    await expect(dialog.getByRole('button', { name: new RegExp(`^${tab}`) })).toBeVisible();
  }
  await expect(dialog.getByPlaceholder('Enter DeepSeek API Key')).toHaveValue('sk-deepseek-mock');

  // 切换厂商 tab → 标题联动
  await dialog.getByRole('button', { name: /^GLM/ }).click();
  await expect(dialog.getByRole('heading', { name: 'GLM' })).toBeVisible();
  await page.screenshot({ path: 'e2e/artifacts/settings-2-chat-glm.png' });
  // 切回 DeepSeek
  await dialog.getByRole('button', { name: /^DeepSeek/ }).click();

  // ── 3. 角色派发面板：四区块 + 下拉联动 ──
  await dialog.getByRole('button', { name: /^Role Assignment/ }).click();
  await expect(dialog.getByRole('heading', { name: 'Role Assignment' })).toBeVisible();
  // renderRoleSelect 的 <label> 与 <select> 是兄弟节点，用 XPath 关联
  const roleSelect = (label: string) =>
    dialog.locator(`label:has-text("${label}")`).locator('xpath=following-sibling::select');
  const visionSel = roleSelect('Primary Vision Model');
  await expect(visionSel).toBeVisible();
  await expect(visionSel).toHaveValue('qwen-vl-max');
  // 下拉选项来自已勾选聊天模型（visionOnly → 仅 qwen-vl-*）
  const optTexts = await visionSel.locator('option').allTextContents();
  expect(optTexts.join(' ')).toContain('qwen-vl-max');
  expect(optTexts.join(' ')).toContain('qwen-vl-plus');
  expect(optTexts.join(' ')).not.toContain('deepseek');
  // 联动：切换主视觉模型 → 值更新
  await visionSel.selectOption('qwen-vl-plus');
  await expect(visionSel).toHaveValue('qwen-vl-plus');
  // 备用视觉 + 任务归纳 + 成果块 + STT 区块可见
  await expect(roleSelect('Backup Vision Model')).toHaveValue('qwen-vl-plus');
  await expect(roleSelect('Summarization Model')).toBeVisible();
  await expect(roleSelect('Outcome Editor Model')).toBeVisible();
  await expect(dialog.getByText('Audio STT Model', { exact: true })).toBeVisible();
  await expect(dialog.getByPlaceholder('API Key (required)')).toBeVisible();
  await page.screenshot({ path: 'e2e/artifacts/settings-3-roles.png' });

  // ── 4. 应用图标面板：欢迎窗口 + 侧边栏 + 头像池 ──
  await dialog.getByRole('button', { name: /^App Icons/ }).click();
  // 欢迎窗口：fixed 模式（mock 数据）+ 切换按钮
  await expect(dialog.getByText('Fixed', { exact: true })).toBeVisible();
  const toggleAvatar = dialog.getByRole('button', { name: 'Switch to Random' });
  await toggleAvatar.click();
  await expect(dialog.getByText('Random', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Switch to Fixed' })).toBeVisible();
  // 侧边栏：自定义 logo（mock brandLogo）→ 恢复默认
  // 注意 Custom 标签也出现在头像池（自定义头像下方），故取 first
  await expect(dialog.getByText('Custom', { exact: true }).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Restore Default' }).click();
  // Default 仅出现在侧边栏状态（品牌 logo 回退默认）
  await expect(dialog.getByText('Default', { exact: true })).toBeVisible();
  // 头像池：3 个头像（2 内置 + 1 自定义）+ 添加按钮（title 在欢迎窗口/侧边栏/池中重复，取 first）
  await expect(dialog.getByTitle(/pumpkin-a\.png \(Built-in\)/).first()).toBeVisible();
  await expect(dialog.getByTitle(/pumpkin-b\.png \(Built-in\)/).first()).toBeVisible();
  await expect(dialog.getByTitle(/my-logo\.png \(Custom\)/).first()).toBeVisible();
  await expect(dialog.getByTitle('Add Custom Avatar')).toBeVisible();
  await page.screenshot({ path: 'e2e/artifacts/settings-4-icons.png' });

  // ── 5. 架构图面板：SVG 渲染且无 Back 按钮 ──
  await dialog.getByRole('button', { name: /^Architecture/ }).click();
  await expect(dialog.locator('svg').first()).toBeVisible();
  await expect(dialog.getByText('Back', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'e2e/artifacts/settings-5-diagram.png' });

  // ── 6. 脏标记 → 保存 → Saved ──
  await dialog.getByRole('button', { name: /^Chat Models/ }).click();
  const keyInput = dialog.getByPlaceholder('Enter DeepSeek API Key');
  await keyInput.fill('sk-deepseek-mock-2');
  await expect(dialog.getByText('Unsaved changes')).toBeVisible();
  const saveBtn = dialog.getByRole('button', { name: 'Save', exact: true });
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  await expect(dialog.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: 'e2e/artifacts/settings-6-saved.png' });

  // ── 7. 未保存修改 → 取消 → confirm 确认关闭 ──
  await keyInput.fill('sk-deepseek-mock-3');
  await expect(dialog.getByText('Unsaved changes')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(confirmMsg).toContain('You have unsaved changes');
  await expect(dialog).toHaveCount(0);

  // ── 页面级报错归零 ──
  // 忽略两类测试环境噪音：favicon、资源加载 500（calendar/edges 接口在纯浏览器
  // 直连时无 Electron 数据源必然 500，与设置弹窗无关）；仍严格断言 JS 异常归零。
  const realErrors = errors.filter((e) => !e.includes('favicon') && !e.includes('Failed to load resource'));
  expect(realErrors).toEqual([]);
});
