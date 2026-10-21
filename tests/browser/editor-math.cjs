const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.MD2WEB_BROWSER});
  try {
    const page = await browser.newPage();
    await page.route('https://editor.test/**', route => route.fulfill({body:'<!doctype html><html><body></body></html>',contentType:'text/html'}));
    await page.goto('https://editor.test/#/md/local/a');
    for (const file of ['docs/lib/marked.min.js','docs/lib/purify.min.js','web/sanitize.js','docs/lib/katex/katex.min.js','docs/lib/katex/auto-render.min.js','web/math-init.js','web/md-editor.js']) {
      await page.addScriptTag({path:path.resolve(file)});
    }
    await page.evaluate(() => {window.fetch = async () => ({ok:true,text:async () => '# Math'}); window.MdEditor.openLocal();});
    const input = page.locator('.md-editor-text');
    await input.waitFor({state:'visible'});
    await page.waitForFunction(() => document.querySelector('.md-editor-text').value.includes('Math'));
    const source = '$$ \\text{S\\_VC\\_CU}[x]+\\text{pktCredits}\n\\leq\n\n\\text{S\\_VC\\_CL}[x]\n$$';
    await input.fill(source);
    await page.waitForFunction(() => document.querySelector('.md-editor-preview .katex-display'));
    assert.equal(await page.locator('.md-editor-preview .katex-error').count(),0);
    assert.equal(await page.locator('.md-editor-preview annotation').textContent(),source.slice(2,-2));
    // Reading page uses the same pre/post Markdown hooks.
    const result = await page.evaluate(source => {
      let before,after;
      window.$docsify.plugins[0]({beforeEach:f=>before=f,afterEach:f=>after=f,doneEach:()=>{}});
      const root=document.createElement('div');
      root.innerHTML=after(window.marked.parse(before(source)));
      window.MathRender.render(root);
      return {count:root.querySelectorAll('.katex-display').length,errors:root.querySelectorAll('.katex-error').length};
    },source);
    assert.deepEqual(result,{count:1,errors:0});
    await input.fill(source.replace('\\leq','\\leg'));
    await page.waitForFunction(() => document.querySelector('.md-editor-preview annotation').textContent.includes('\\leg'));
    assert.match(await page.locator('.md-editor-preview').innerText(),/\\leg/,'unknown command is not silently changed');
    console.log('editor and reading page multiline TeX / escaped underscores / unknown command: PASS');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
