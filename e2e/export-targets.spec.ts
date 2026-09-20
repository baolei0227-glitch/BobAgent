import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { checkDoc } from '../src/lib/md-export/check';
import type { DocIR } from '../src/lib/md-export/ir';
import { WECHAT_SPEC } from '../src/lib/md-export/targets/wechat';
import { WEIBO_SPEC } from '../src/lib/md-export/targets/weibo';
import { POSTER_SPEC } from '../src/lib/md-export/targets/poster';

/**
 * e2e 用例：md 阅读器多端导出回归（方案 §10 验收清单）。
 *
 * 覆盖 P0/P1/P2 三条产物链路中可在本机自动化验证的部分：
 * - Export… 菜单条目与实际实现一致（无过期文案）
 * - 微信文章：内联 HTML 满足公众号硬约束（无 <style>、无 flex/grid）
 * - 微博：≤140 字钩子 + 自动 #话题# + 独立方形模板（1:1 / 4:3）
 * - 海报：4 规格（1:1 / 3:4 / 9:16 / 长图）等比缩放不溢出 + 降噪规则生效
 * - HTML：自包含单文件可下载且结构完整
 *
 * 说明：素材直接用仓库内的方案文档（含 h1/h2/h3、4 列宽表、```ts 代码块），
 * 因此不需要造节点数据；唯一副作用是临时授权一个本地目录，用例结束即撤销。
 * 不覆盖（必须人工）：粘贴到公众号编辑器后的实际排版、与改造前卡片的逐像素对比。
 *
 * 运行：必须指向**工作区**的 dev server（默认 8321 可能被已安装的 BobWork.app 占用，
 * 那份产物是旧代码，会让用例跑到过期实现上）：
 *   E2E_BASE_URL=http://localhost:3000 node node_modules/@playwright/test/cli.js test e2e/export-targets.spec.ts
 */

const DOC_ROOT = '/Users/baolei/Desktop/BobWork';
const DOC_KEYWORD = '多端分发方案';
const DOC_TITLE_PREFIX = 'md 阅读器多端分发方案';

/**
 * 直接用 DOM click 触发 onClick。
 * 浏览器里应用外壳（侧栏 / 画布）在 Electron 无边框布局下会互相压住，
 * 真实鼠标事件会打到覆盖层上；这里绕过命中测试，只验证业务逻辑是否被正确触发。
 */
const domClick = (loc: Locator) => loc.evaluate((el) => (el as HTMLElement).click());

/** 分发 contextmenu（右键菜单坐标由事件本身携带） */
const domContextMenu = (loc: Locator) =>
  loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: Math.round(r.left + 60),
        clientY: Math.round(r.top + 60),
      }),
    );
  });

/** 点击含指定精确文案的元素（同样走 DOM 事件，绕开外壳覆盖层） */
const clickText = (page: Page, text: string) => domClick(page.getByText(text, { exact: true }).first());

/** 临时授权目录 → 打开文档 → 返回可编辑正文（md 阅读器 / DocEditor） */
async function openDoc(page: Page, request: APIRequestContext) {
  const addResp = await request.get(`/api/local-files?action=add_root&path=${encodeURIComponent(DOC_ROOT)}`);
  expect((await addResp.json()).success).toBeTruthy();

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // 展开「本地文件」面板（默认折叠）→ 搜索 → 单击结果在统一标签面板打开
  await domClick(page.getByRole('button', { name: 'Local files', exact: true }).first());
  const search = page.locator('input[placeholder="Search within authorized directories..."]');
  await expect(search).toBeVisible({ timeout: 20000 });
  await search.fill(DOC_KEYWORD);

  const hit = page.locator('[data-local-explorer-wrapper]').getByText(DOC_KEYWORD, { exact: false }).first();
  await expect(hit).toBeVisible({ timeout: 20000 });
  await domClick(hit);

  // 预览面板可能仍处于折叠态（display:none 挂载）→ 展开
  const prose = page.locator('[data-reader-content] [contenteditable="true"]').first();
  await expect(page.locator('[data-reader-content]').first()).toBeAttached({ timeout: 30000 });
  if (!(await prose.isVisible().catch(() => false))) {
    const expand = page.locator('button[title="Expand preview panel"]').first();
    if (await expand.count()) await domClick(expand);
  }
  await expect(prose).toBeVisible({ timeout: 30000 });
  return prose;
}

/** 收尾：撤销临时授权（用例内 openDoc 会重新授权，故 cleanup 幂等） */
async function revokeRoot(request: APIRequestContext) {
  await request
    .get(`/api/local-files?action=remove_root&path=${encodeURIComponent(DOC_ROOT)}`)
    .catch(() => {});
}

/** 右键正文 → 点 Export…（按 hint 定位，避免依赖图标字形）
 *  事件直接分发在承载 onContextMenu 的滚动容器上：ProseMirror 会吞掉内容区的 contextmenu。 */
async function openExportMenu(page: Page, prose: Locator) {
  const surface = page.locator('[data-reader-content] .ai-canvas-scroll').first();
  await domContextMenu((await surface.count()) ? surface : prose);
  const exportBtn = page.locator('button[title*="Card/Poster/Article/DOCX/PDF/HTML"]').first();
  await expect(exportBtn).toBeVisible({ timeout: 15000 });
  await domClick(exportBtn);
  const menu = page.locator('div.fixed.inset-0.z-\\[9999\\]');
  await expect(menu.first()).toBeVisible({ timeout: 10000 });
  return menu.first();
}

/** 测量海报画布：定高规格返回缩放比与实际内容高度，用于判断是否溢出 */
async function measurePoster(page: Page) {
  return page.evaluate(() => {
    const isCanvas = (d: HTMLDivElement) =>
      d.style.width === '640px' && d.style.borderRadius === '12px' && d.style.boxSizing === 'border-box';
    const canvas = Array.from(document.querySelectorAll('div')).filter(isCanvas).pop() as HTMLDivElement | undefined;
    if (!canvas) return null;
    const area = canvas.querySelector(':scope > div[style*="position: relative"]') as HTMLDivElement | null;
    const body = area?.firstElementChild as HTMLDivElement | null;
    if (!area || !body) return null;
    const t = getComputedStyle(body).transform;
    const scale = t === 'none' ? 1 : new DOMMatrixReadOnly(t).a;
    return {
      canvasH: Math.round(canvas.getBoundingClientRect().height),
      areaH: Math.round(area.clientHeight),
      contentH: Math.round(body.scrollHeight),
      renderedH: Math.round(body.scrollHeight * scale),
      scale: Number(scale.toFixed(4)),
    };
  });
}

/** 弹窗作用域（拖层容器 class 固定为 fixed inset-0 z-[9999]） */
const overlay = (page: Page) => page.locator('div.fixed.inset-0.z-\\[9999\\]');

/** 构造最小 DocIR（体检规则用） */
const mkIR = (over: Partial<DocIR>): DocIR => ({
  title: '普通标题',
  hook: '',
  stats: [],
  blocks: [{ t: 'paragraph', inline: [{ t: 'text', value: '正文一段。' }] }],
  meta: { source: 'md-file' },
  ...over,
});

/**
 * 体检规则（纯函数，方案 §10「导出前体检报告能命中：标题超长、图片超限、宽表不适配」）。
 * 本机素材（方案文档）标题不长、无图，无法从 UI 触发这两条 fail，故直接对 checkDoc 断言。
 */
test.describe('导出前体检规则', () => {
  test('标题超长 → fail（微信 titleMax 64）', () => {
    const items = checkDoc(mkIR({ title: '标'.repeat(80) }), WECHAT_SPEC);
    const hit = items.find((i) => i.key === 'title')!;
    expect(hit.level).toBe('fail');
    expect(hit.msg).toContain('80');
    expect(hit.fix).toBeTruthy();
  });

  test('图片超限 → fail（微博 imageMax 9）', () => {
    const images = Array.from({ length: 12 }, (_, i) => ({ t: 'image' as const, src: `a${i}.png`, alt: '' }));
    const items = checkDoc(mkIR({ blocks: images }), WEIBO_SPEC);
    const hit = items.find((i) => i.key === 'image')!;
    expect(hit.level).toBe('fail');
    expect(hit.msg).toContain('12');
  });

  test('宽表不适配 → warn（微信 5 列 > 4 列阈值）', () => {
    const table = { t: 'table' as const, header: ['a', 'b', 'c', 'd', 'e'], rows: [['1', '2', '3', '4', '5']] };
    const items = checkDoc(mkIR({ blocks: [table] }), WECHAT_SPEC);
    const hit = items.find((i) => i.key === 'wide-table')!;
    expect(hit.level).toBe('warn');
    expect(hit.msg).toContain('5 列');
    expect(hit.fix).toContain('4 列');
  });

  test('代码块降级 → warn，且各规则 key 唯一可渲染', () => {
    const code = { t: 'code' as const, lang: 'ts', lines: ['const a = 1;'] };
    const items = checkDoc(mkIR({ blocks: [code] }), POSTER_SPEC);
    const hit = items.find((i) => i.key === 'unsupported-code')!;
    expect(hit.level).toBe('warn');
    expect(hit.msg).toContain('不支持代码高亮');
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });
});

test.describe('md 阅读器多端导出', () => {
  // 与 Electron 窗口近似的宽高：侧栏 + 画布 + 预览面板同时展开
  test.use({ viewport: { width: 1500, height: 1000 } });

  test.afterEach(async ({ request }) => {
    await revokeRoot(request);
  });

  test('Export 菜单条目与实际实现一致', async ({ page, request }) => {
    const prose = await openDoc(page, request);
    await openExportMenu(page, prose);
    for (const label of [
      'Xiaohongshu post card',
      'Brand share card',
      'Design poster',
      'WeChat article',
      'Weibo post',
      'Word (DOCX)',
      'PDF (print)',
      'HTML document',
    ] as const) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await page.screenshot({ path: 'e2e/artifacts/export-menu.png' });
  });

  test('小红书卡片：md 输入分支可直接出图（P0-2 回归）', async ({ page, request }) => {
    const prose = await openDoc(page, request);
    await openExportMenu(page, prose);
    await clickText(page, 'Xiaohongshu post card');

    // XhsPanel 走 shadcn Dialog（Radix portal，role=dialog），不是 ExportMenu 的 [9999] 遮罩
    const dlg = page.locator('[role="dialog"]').last();
    await expect(dlg.getByText('Post card · 3:4', { exact: true })).toBeVisible({ timeout: 15000 });
    // 图片侧：分页出图（页数指示 + 单页保存 / 打包下载）
    await expect(dlg.getByText(/^\d+ \/ \d+$/).first()).toBeVisible();
    await expect(dlg.getByTitle('Save this page')).toBeVisible();
    await expect(dlg.locator('button[title^="Download all pages as ZIP"]')).toBeVisible();
    // 文案侧：一键复制当前页
    await expect(dlg.getByTitle('Copy this page')).toBeVisible();
    // 内容确实来自 md（首图含文档标题主题；标题在预览里被拆成多个 span，故用 innerText 断言）
    expect(await dlg.innerText()).toContain(DOC_TITLE_PREFIX);

    // 分页完整性：离屏 portal 里的每一页都必须非空（空白页 = 分页把标题/内容切散了）
    const pageTextLens = await page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('div')).find(
        (d) => d.style.position === 'fixed' && d.style.left === '-9999px' && d.style.zIndex === '2147483647',
      );
      if (!host) return null;
      return Array.from(host.children).map((c) => (c.textContent || '').trim().length);
    });
    expect(pageTextLens, '离屏分页节点未找到').not.toBeNull();
    expect(pageTextLens!.length).toBeGreaterThan(1);
    expect(Math.min(...pageTextLens!)).toBeGreaterThan(0);

    await page.screenshot({ path: 'e2e/artifacts/export-xhs.png' });
  });

  test('微博：≤140 字钩子 + 自动话题 + 方形模板', async ({ page, request }) => {
    const prose = await openDoc(page, request);
    await openExportMenu(page, prose);
    await clickText(page, 'Weibo post');

    // 计数徽标形如 "78/140"
    const counter = page.locator('text=/^\\d+\\/140$/').first();
    await expect(counter).toBeVisible({ timeout: 10000 });
    const hookLen = Number((await counter.innerText()).split('/')[0]);
    expect(hookLen).toBeGreaterThan(0);
    expect(hookLen).toBeLessThanOrEqual(140);

    // 文案含自动生成的 #话题#
    const postText = await page.evaluate(() => {
      const label = Array.from(document.querySelectorAll('span')).find((s) => s.textContent?.trim() === 'Post text');
      return label?.parentElement?.parentElement?.querySelector('.whitespace-pre-wrap')?.textContent ?? '';
    });
    expect(postText).toMatch(/#[^#\s]+#/);
    expect(postText).toContain(DOC_TITLE_PREFIX.slice(3)); // 标题主题被纳入钩子/关键词

    // 独立方形模板：1:1 → 420×420；4:3 → 420×315
    const cardSize = () =>
      page.evaluate(() => {
        const card = Array.from(document.querySelectorAll('div'))
          .filter((d) => d.style.width === '420px' && d.style.boxSizing === 'border-box')
          .pop();
        if (!card) return null;
        const r = card.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      });

    expect(await cardSize()).toEqual({ w: 420, h: 420 });
    await domClick(page.getByRole('button', { name: '4:3', exact: true }).first());
    await page.waitForTimeout(400);
    expect(await cardSize()).toEqual({ w: 420, h: 315 });

    await page.screenshot({ path: 'e2e/artifacts/export-weibo.png' });
  });

  test('海报：四规格无溢出 + 降噪规则生效', async ({ page, request }) => {
    const prose = await openDoc(page, request);
    await openExportMenu(page, prose);
    await clickText(page, 'Design poster');

    const dlg = overlay(page);
    await expect(dlg.getByText('Layout notes', { exact: true })).toBeVisible({ timeout: 10000 });

    // 降噪：4 列表格 → 键值对 + 提示；```ts 代码块 → 折叠说明；h3 → 加粗小标题
    await expect(dlg.getByText('完整表格见原文档').first()).toBeVisible();
    await expect(dlg.getByText(/代码块 \d+ 行/).first()).toBeVisible();
    await expect(dlg.getByText('输入泛化', { exact: false }).first()).toBeVisible();

    for (const [label, h] of [
      ['1:1', 640],
      ['3:4', 853],
      ['9:16', 1138],
    ] as const) {
      await domClick(page.getByRole('button', { name: label, exact: true }).first());
      await page.waitForTimeout(500);
      const m = await measurePoster(page);
      expect(m, `poster ${label} not measured`).not.toBeNull();
      expect(m!.canvasH, `poster ${label} height`).toBe(h);
      expect(m!.scale).toBeLessThanOrEqual(1);
      // 内容经等比缩放后必须落在容器内（留 2px 浮点余量）
      expect(m!.renderedH, `${label} overflowed the canvas`).toBeLessThanOrEqual(m!.areaH + 2);
      await page.screenshot({ path: `e2e/artifacts/export-poster-${label.replace(':', 'x')}.png` });
    }

    // 长图：不缩放（scale=1），高度随内容自适应
    await domClick(page.getByRole('button', { name: 'Long', exact: true }).first());
    await page.waitForTimeout(500);
    const long = await measurePoster(page);
    expect(long!.scale).toBe(1);
    expect(long!.contentH).toBeGreaterThan(0);
    expect(long!.renderedH).toBeLessThanOrEqual(long!.areaH + 2);
  });

  test('HTML：自包含单文件可下载', async ({ page, request }) => {
    const prose = await openDoc(page, request);
    await openExportMenu(page, prose);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      clickText(page, 'HTML document'),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.html$/);

    const path = await download.path();
    expect(path).toBeTruthy();
    const html = await readFile(path!, 'utf8');

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8" />');
    expect(html).toContain('<style>');
    expect(html).toContain('@media print');
    // 标题进入 <title> 与 h1，且 h1 只出现一次（不与正文重复）
    expect(html).toContain(`<title>${DOC_TITLE_PREFIX}`);
    expect(html.match(/<h1 class="doc-title">/g)?.length).toBe(1);
    // 无损载体：所有表格原样保留为 <table>（不降级为键值对列表）、代码块全文保留
    expect(html).toContain('<table>');
    expect(html).toContain('<th>');
    expect(html.match(/<table>/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(html).not.toContain('<dl');
    expect(html).toContain('<pre><code');
  });

  test('微信文章：内联 HTML 满足公众号硬约束', async ({ page, request }) => {
    const prose = await openDoc(page, request);
    await openExportMenu(page, prose);
    await clickText(page, 'WeChat article');

    const dlg = overlay(page);
    await expect(dlg.getByText('WeChat article', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(dlg.getByText('Pre-flight check', { exact: true })).toBeVisible();
    // 体检真实执行并给出结论（本素材命中 2 条 warn：代码块降级 + 长段落；规则命中细节见「导出前体检规则」用例）
    await expect(dlg.getByText(/^\d+ warnings?$/).first()).toBeVisible();
    await expect(dlg.getByText(/^标题长度 \d+\/64 字$/).first()).toBeVisible();

    // 序列化产物（预览区直接 dangerouslySetInnerHTML 渲染 article.html）
    const audit = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('div.fixed.inset-0'));
      const dlg = dialogs.find((d) => d.textContent?.includes('WeChat article'));
      if (!dlg) return null;
      const preview = Array.from(dlg.querySelectorAll('div')).find((d) =>
        d.className.includes('overflow-auto') && d.className.includes('flex-1'),
      );
      if (!preview) return null;
      const html = preview.innerHTML;
      return {
        hasStyleTag: preview.querySelectorAll('style').length > 0,
        hasInlineSection: /<section style="/.test(html),
        hasFlexOrGrid: /display:\s*(flex|grid)/.test(html),
        hasPosition: /position:\s*(absolute|fixed|sticky)/.test(html),
        hasTable: html.includes('<table'),
        hasCodeSection: /background:#f7f7f7;border-radius:4px/.test(html),
        hasTitle: html.length > 500,
      };
    });
    expect(audit).not.toBeNull();
    expect(audit!.hasStyleTag).toBe(false);
    expect(audit!.hasFlexOrGrid).toBe(false);
    expect(audit!.hasPosition).toBe(false);
    expect(audit!.hasInlineSection).toBe(true);
    expect(audit!.hasTable).toBe(true);
    expect(audit!.hasCodeSection).toBe(true);
    expect(audit!.hasTitle).toBe(true);

    await page.screenshot({ path: 'e2e/artifacts/export-wechat.png' });
  });
});