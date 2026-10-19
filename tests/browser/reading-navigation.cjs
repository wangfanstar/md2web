const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.MD2WEB_BROWSER ? { executablePath: process.env.MD2WEB_BROWSER } : {}) });
  try {
    for (const protocol of ['file', 'http']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
      if (protocol === 'http') {
        await page.route('http://reading.test/**', route => {
          const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
          const file = path.resolve('docs', '.' + pathname);
          const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };
          return fs.existsSync(file) && fs.statSync(file).isFile()
            ? route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'text/plain' })
            : route.fulfill({ status: 404, body: '' });
        });
      }
      const base = protocol === 'file' ? 'file:///' + path.resolve('docs/html/index_all.html').replace(/\\/g, '/') : 'http://reading.test/html/index_all.html';
      await page.goto(base + '#/md/RLM_TEST_CASES');
      await page.locator('.docs-page-toc.has-items').waitFor();
      const manual = page.locator('.markdown-section a').filter({ hasText: '寄存器直读 / 直写用例' }).first();
      await manual.click();
      await page.waitForTimeout(500);
      assert.ok(await page.evaluate(() => window.scrollY > 500), protocol + ': manual anchor scrolls');
      assert.ok(page.url().includes('/md/RLM_TEST_CASES'), protocol + ': stays on document');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(400);
      const scroller = page.locator('.docs-page-toc-scroll');
      await scroller.hover();
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(400);
      assert.ok(await scroller.evaluate(el => el.scrollTop > 100), protocol + ': TOC retains manual scroll');
      await page.close();
    }
    console.log('HTTP and file navigation passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
