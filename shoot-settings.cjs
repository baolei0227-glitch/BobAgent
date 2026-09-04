const { chromium } = require('/Users/baolei/Desktop/BobWork/projects/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core');
const fs = require('fs');

(async () => {
  const outDir = '/Users/baolei/Desktop/BobWork/projects/settings-shots';
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  const clickByText = (text) => page.evaluate((t) => {
    const els = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="tab"]'));
    const el = els.find((e) => (e.textContent || '').trim().includes(t));
    if (el) { el.click(); return true; }
    return false;
  }, text);

  try {
    await page.goto('http://localhost:5020/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(5000);

    // 打开设置弹窗（聚焦 roles = Role Assignment）
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('open-settings', { detail: { section: 'roles' } }));
    });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: outDir + '/1-role-assignment.png' });
    console.log('saved 1-role-assignment.png');

    // 切到 Model Pool
    await clickByText('Model Pool');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: outDir + '/2-model-pool.png' });
    console.log('saved 2-model-pool.png');

    // 打开 Manage Models 弹窗
    await clickByText('Manage Models (Fetch + Select)');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: outDir + '/3-manage-models.png' });
    console.log('saved 3-manage-models.png');

    // 弹窗内输入一个 key 看列表状态（输入无效 key 触发 fetch）
    const typed = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).filter((i) => {
        const r = i.getBoundingClientRect(); return r.width > 0;
      });
      const pw = inputs.find((i) => i.type === 'password');
      if (!pw) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(pw, 'sk-test');
      pw.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    });
    await page.waitForTimeout(300);
    await clickByText('Fetch Models');
    await page.waitForTimeout(3500);
    await page.screenshot({ path: outDir + '/4-manage-models-after-fetch.png' });
    console.log('saved 4-manage-models-after-fetch.png (typed=' + typed + ')');
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  await browser.close();
})();
