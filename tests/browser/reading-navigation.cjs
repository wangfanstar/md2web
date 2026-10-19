// Uses an isolated in-memory document; no dependency on user Markdown files.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const fixture = '# Navigation\n\n[Target](#1-target)\n\n[中文](#2-中文--标点)\n\n[重复](#repeat-1)\n\n'
  + Array.from({length: 60}, (_, i) => '## Section ' + i + '\n\nparagraph\n\n'.repeat(6)).join('\n')
  + '## 1. Target\n\n' + 'body\n\n'.repeat(30)
  + '## 2. 中文 / 标点\n\n' + 'body\n\n'.repeat(30)
  + '## Repeat\n\n' + 'body\n\n'.repeat(30) + '## Repeat\n\n' + 'body\n\n'.repeat(30);

async function atHeading(page, id) {
  await page.waitForFunction(id => {
    const heading = document.getElementById(id);
    if (!heading) return false;
    const top = heading.getBoundingClientRect().top;
    return top >= 0 && top < 150;
  }, id).catch(async error => {
    console.error(await page.evaluate(id => ({url: location.href, scroll: scrollY, top: document.getElementById(id)?.getBoundingClientRect().top}), id));
    throw error;
  });
  assert.equal(new URLSearchParams(page.url().split('?')[1]).get('id'), id);
  await page.waitForTimeout(700);
  const top = await page.evaluate(id => document.getElementById(id).getBoundingClientRect().top, id);
  assert.ok(top >= 0 && top < 150, 'anchor remains stable after Docsify animation: ' + top);
}

(async () => {
  const browser = await chromium.launch({headless: true,
    ...(process.env.MD2WEB_BROWSER ? {executablePath: process.env.MD2WEB_BROWSER} : {})});
  const root = path.resolve('docs');
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/md/navigation-test.md') {res.end(fixture); return;}
    const file = path.resolve(root, '.' + pathname);
    const types = {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json'};
    if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.setHeader('Content-Type', types[path.extname(file)] || 'text/plain');
      res.end(fs.readFileSync(file));
    } else {res.statusCode = 404; res.end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const protocol of ['file', 'http']) {
      const context = await browser.newContext({viewport: {width: 1440, height: 800}});
      await context.addInitScript(markdown => {
        let data;
        Object.defineProperty(window, '__DOCSIFY_OFFLINE_DATA__', {
          get: () => data,
          set(value) { data = value; value.content['md/navigation-test.md'] = markdown; }
        });
      }, fixture);
      const page = await context.newPage();
      const base = protocol === 'file' ? pathToFileURL(path.resolve('docs/html/index_all.html')).href
        : 'http://127.0.0.1:' + server.address().port + '/html/index_all.html';
      const start = base + '#/md/navigation-test';
      await page.goto(start);
      await page.locator('.docs-page-toc.has-items').waitFor();
      const manual = page.locator('.markdown-section a').filter({hasText: /^Target$/});
      assert.equal(await manual.getAttribute('href'), start + '?id=_1-target');
      await manual.click();
      await atHeading(page, '_1-target');
      await page.locator('.docs-page-toc-link').filter({hasText: '中文'}).click();
      await atHeading(page, '_2-中文-标点');
      await page.goBack();
      await atHeading(page, '_1-target');
      await page.goForward();
      await atHeading(page, '_2-中文-标点');
      await page.reload();
      await atHeading(page, '_2-中文-标点');
      await page.goto(start + '?id=1-target');
      await atHeading(page, '_1-target');
      await page.goto(start);
      await page.waitForFunction(() => window.scrollY < 50);
      const popupPromise = context.waitForEvent('page');
      await manual.click({modifiers: ['Control']});
      const popup = await popupPromise;
      await popup.bringToFront();
      await atHeading(popup, '_1-target');
      await popup.close();
      await page.bringToFront();
      await page.locator('.markdown-section a').filter({hasText: /^重复$/}).click();
      await atHeading(page, 'repeat-1');
      await page.goto(start);
      await page.waitForFunction(() => window.scrollY < 50);
      await page.waitForTimeout(300);
      const scroller = page.locator('.docs-page-toc-scroll');
      await scroller.hover();
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(400);
      assert.ok(await scroller.evaluate(el => el.scrollTop > 100), protocol + ': independent TOC scroll');
      console.log(protocol + ': canonical links, history, reload, legacy URL, new tab, duplicate headings, TOC scroll passed');
      await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => {console.error(error); process.exitCode = 1;});
