// Run with Playwright installed (MD2WEB_BROWSER optionally selects a Chromium executable).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({headless: true,
    ...(process.env.MD2WEB_BROWSER ? {executablePath: process.env.MD2WEB_BROWSER} : {})});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 800}});
    await page.route('https://editor.test/**', route => route.fulfill({body: '<html><body></body></html>', contentType: 'text/html'}));
    await page.goto('https://editor.test/#/md/local/a');
    for (const css of ['docs/lib/prism.min.css', 'docs/lib/docsify.min.css', 'web/custom-search.css', 'web/workspace.css']) {
      await page.addStyleTag({path: path.resolve(css)});
    }
    // Exercise classic scrollbars, including systems which otherwise use overlay scrollbars.
    await page.addStyleTag({content: '.md-editor-text { scrollbar-gutter: stable; }'});
    await page.evaluate(() => {
      window.fetch = async () => ({ok: true, text: async () => '# Title\ntext\n'});
    });
    await page.addScriptTag({path: path.resolve('web/md-editor.js')});
    await page.evaluate(() => window.MdEditor.openLocal());
    const input = page.locator('.md-editor-text');
    await input.waitFor({state: 'visible'});
    await page.waitForFunction(() => document.querySelector('.md-editor-text').value.includes('Title'));
    for (const width of [1280, 900]) {
      await page.setViewportSize({width, height: 700});
      const source = '# 中文 Heading\n**bold** *italic*\n\t' + 'longWord中文'.repeat(60) + '\n' + 'line 中文\n'.repeat(90);
      await input.fill(source);
      await page.waitForTimeout(150);
      const metrics = await page.evaluate(() => {
        const t = document.querySelector('.md-editor-text');
        const h = document.querySelector('.md-editor-highlight');
        const ts = getComputedStyle(t), hs = getComputedStyle(h);
        return {font: [ts.fontFamily, hs.fontFamily], line: [ts.lineHeight, hs.lineHeight],
          width: [t.clientWidth, h.clientWidth], text: h.textContent, value: t.value,
          height: [t.scrollHeight, h.scrollHeight]};
      });
      assert.equal(metrics.font[0], metrics.font[1], 'textarea and highlight fonts differ');
      assert.equal(metrics.line[0], metrics.line[1], 'line height differs');
      assert.equal(metrics.width[0], metrics.width[1], 'scrollbar changes wrapping width');
      assert.equal(metrics.text, metrics.value + '\n', 'highlight must preserve visible source');
      assert.ok(Math.abs(metrics.height[0] - metrics.height[1]) <= 2, JSON.stringify(metrics.height));
      await input.evaluate(t => { t.scrollTop = 0; t.dispatchEvent(new Event('scroll')); });
      const caret = await page.evaluate(() => {
        const t = document.querySelector('.md-editor-text');
        const h = document.querySelector('.md-editor-highlight');
        const expected = t.value.indexOf('longWord') + 120;
        const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
        let remaining = expected, node;
        while ((node = walker.nextNode())) {
          if (remaining < node.length) break;
          remaining -= node.length;
        }
        const range = document.createRange();
        range.setStart(node, remaining); range.setEnd(node, remaining + 1);
        const rect = range.getBoundingClientRect();
        return {expected, x: rect.x + rect.width * 0.15, y: rect.y + rect.height / 2};
      });
      await page.mouse.click(caret.x, caret.y);
      assert.equal(await input.evaluate(t => t.selectionStart), caret.expected, 'click on visible wrapped text must place caret there');
      await page.keyboard.insertText('Z');
      assert.equal(await page.evaluate(() => document.querySelector('.md-editor-highlight').textContent),
        await input.inputValue() + '\n', 'typing must update visible text immediately');
      await input.evaluate(t => { t.scrollTop = t.scrollHeight; t.dispatchEvent(new Event('scroll')); });
      const scroll = await page.evaluate(() => [document.querySelector('.md-editor-text').scrollTop, document.querySelector('.md-editor-highlight').scrollTop]);
      assert.ok(Math.abs(scroll[0] - scroll[1]) <= 1, 'scroll positions differ');
    }
    await page.evaluate(() => {
      window.confirm = () => true;
      window.MdEditor.close();
      window.SiteAuth = {isAuthenticated: () => true, csrfToken: () => 'test'};
      window.fetch = async url => {
        const u = new URL(url, location.href);
        let payload = {ok: true};
        if (u.pathname.endsWith('/__md/document')) payload.document = {path: 'md/local/a.md', binding: {source_mode: 'local'}, published: {text: '# current\n', hash: 'test'}};
        if (u.pathname.endsWith('/__md/history')) {
          if (u.searchParams.get('mode') !== 'local') throw new Error('Missing local history mode');
          payload.history = {revisions: [{id: 'local:2', isHead: true, createdAt: '2026-10-15', size: 10}]};
        }
        if (u.pathname.endsWith('/__md/diff')) {
          if (u.searchParams.get('from') !== 'previous' || u.searchParams.get('to') !== 'published') throw new Error('Wrong diff versions');
          payload.diff = {from: {label: '上一版本'}, to: {label: '当前已保存版本'}, diff: '-old\n+current'};
        }
        return {ok: true, json: async () => payload};
      };
      window.MdEditor.open();
    });
    await page.waitForFunction(() => document.querySelector('.md-editor-text').value === '# current\n');
    await page.locator('[data-editor-action="history"]').click();
    await page.waitForFunction(() => document.querySelector('[data-editor-history-list]').textContent.includes('local:2'));
    await page.locator('[data-editor-action="diff"]').click();
    await page.waitForFunction(() => document.querySelector('[data-editor-diff]').textContent.includes('上一版本 → 当前已保存版本'));
    console.log('Editor geometry, native caret placement, immediate typing and local history/diff UI passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
