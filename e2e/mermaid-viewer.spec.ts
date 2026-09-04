import { test, expect } from '@playwright/test';

/**
 * 排查：UnifiedViewer 中 mermaid 是否渲染
 * 点击节点上的 .md 附件按钮 → 打开节点文档（UnifiedViewer）→ 检查 mermaid 渲染
 */
test.describe('UnifiedViewer mermaid 渲染排查', () => {
  test('打开节点 .md 文档，检查 mermaid 是否渲染为图', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 1. 先点击画布节点激活
    await page.getByText('工伤死亡赔偿金100万的分配规则', { exact: true }).first().click({ timeout: 15000 });
    await page.waitForTimeout(800);

    // 2. 点击节点内的 .md 按钮（打开节点文档 → UnifiedViewer）
    const mdBtn = page.getByText('工伤死亡赔偿金100万的分配规则.md', { exact: true }).first();
    await mdBtn.click({ timeout: 10000 });
    await page.waitForTimeout(2000);

    // 3. 检查渲染结果
    const svgCount = await page.locator('.mermaid-svg svg').count();
    console.log(`=== .mermaid-svg svg count: ${svgCount} ===`);

    // 4. 检查 codeBlock DOM：语言 class 与节点结构
    const domInfo = await page.evaluate('(() => { const blocks = Array.from(document.querySelectorAll(".code-block, .code-block-content, .mermaid-code-block")); return blocks.slice(0, 10).map(b => ({ tag: b.tagName, cls: b.className, text: (b.textContent || "").slice(0, 30) })); })()');
    console.log('=== codeBlock DOM:', JSON.stringify(domInfo, null, 2));

    const bodyText = await page.locator('body').innerText();
    console.log(`=== body contains "flowchart TD": ${bodyText.includes('flowchart TD')} ===`);
    console.log(`=== body contains "widget:mermaid": ${bodyText.includes('widget:mermaid')} ===`);

    await page.screenshot({ path: 'e2e/artifacts/mermaid-viewer.png', fullPage: false }).catch(() => {});
  });

  test('深色主题（abyss）下 widget 自动注入 data-widget-theme=dark', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 切换宿主主题为深色（abyss）
    await page.evaluate('() => { document.documentElement.setAttribute("data-theme", "abyss"); }');
    await page.waitForTimeout(300);

    // 若页面有 widget/mermaid 块，其容器应带 data-widget-theme="dark"（token 深色配色）
    const darkWidgets = await page.locator('[data-widget-theme="dark"]').count();
    console.log(`=== [data-widget-theme="dark"] count: ${darkWidgets} ===`);

    // 切回浅色后不残留
    await page.evaluate('() => { document.documentElement.removeAttribute("data-theme"); }');
    await page.waitForTimeout(300);
  });
});
