const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const assert = require('node:assert/strict');

(async () => {
  const server = spawn(process.env.MD2WEB_PYTHON || 'C:/Users/wangfan/AppData/Local/Temp/md2web-py368/python.exe', ['tests/browser/home-code-server.py'], {stdio:['pipe','pipe','pipe']});
  let stderr = '', browser;
  server.stderr.on('data', chunk => stderr += chunk);
  try {
    const base = await new Promise((resolve, reject) => {
      readline.createInterface({input:server.stdout}).on('line', line => {
        try { const data = JSON.parse(line); if (data.url) resolve(data.url); } catch {}
      });
      server.on('exit', () => reject(new Error(stderr)));
    });
    browser = await chromium.launch({headless:true, executablePath:process.env.MD2WEB_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.request.post(base + '/__auth/login', {data:{username:'admin',password:'admin'}});
    await page.goto(base + '/index.html');
    await page.waitForFunction(() => window.SiteAuth && SiteAuth.isAuthenticated());
    assert.equal(await page.locator('[data-master-search], [data-ai-input]').count(), 1);
    await page.locator('[data-master-search]').fill('main');
    await page.locator('[data-master-results] a').first().waitFor();
    await page.locator('[data-home-mode=ai]').click();
    assert.equal(await page.locator('[data-master-search]').inputValue(), 'main');
    await page.locator('[data-ai-model] option[value=opus]').waitFor({state:'attached'});
    assert.equal(await page.locator('.ai-assistant-button').count(), 0);
    assert.equal(await page.locator('.ai-assistant-inline').evaluate(el => getComputedStyle(el).position), 'static');
    await page.locator('[data-home-submit]').click();
    await page.getByText('First streamed paragraph', {exact:true}).waitFor();
    await page.locator('.ai-message-assistant strong').filter({hasText:'Completed answer'}).waitFor();
    await page.locator('[data-home-mode=search]').click();
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('siteauth:change', {detail:SiteAuth.snapshot()})));
    assert.equal(await page.locator('[data-home-mode=search]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-master-search]').fill('retained draft');
    await page.locator('[data-home-mode=ai]').click();
    assert.equal(await page.locator('[data-master-search]').inputValue(), 'retained draft');
    assert.equal(await page.locator('.ai-message-assistant strong').count(), 1);
    await page.screenshot({path:process.env.TEMP + '/md2web-home-inline.png',fullPage:true});

    await page.goto(base + '/html/reference_code.html');
    let failDirectoryOnce = true;
    await page.route('**/__code/tree?**', async route => {
      const url = new URL(route.request().url());
      if (failDirectoryOnce && url.searchParams.get('path') === 'src') {
        failDirectoryOnce = false;
        await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary directory error'})});
      } else await route.continue();
    });
    await page.getByRole('button', {name:'▸ src',exact:true}).click();
    await page.getByRole('button', {name:'重试',exact:true}).click();
    await page.getByRole('button', {name:'▸ nested',exact:true}).click();
    await page.getByRole('button', {name:'main.c',exact:true}).click();
    await page.locator('#source').waitFor({state:'visible'});
    assert.match(await page.locator('#source').innerText(), /return 42/);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('siteauth:change', {detail:SiteAuth.snapshot()})));
    assert.equal(await page.locator('#source .code-line').count(), 5);
    assert.equal(await page.getByRole('button', {name:'▾ nested',exact:true}).count(), 1);
    await page.locator('#q').fill('return 42');
    await page.locator('#mode').selectOption('text');
    await page.locator('#search button').click();
    await page.locator('.code-search-hit').first().click();
    await page.locator('#L3.is-selected').waitFor();
    const deepLink = page.url();
    await context.grantPermissions(['clipboard-read','clipboard-write']);
    await page.locator('#copy').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('已复制'));
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), deepLink);
    await page.reload();
    await page.locator('#L3.is-selected').waitFor();
    assert.equal(page.url(), deepLink);
    await page.screenshot({path:process.env.TEMP + '/md2web-code-reader.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', {name:'就此位置问 AI →'}).click();
    await page.waitForURL('**/index.html?aiQuestion=*');
    await page.waitForFunction(() => document.querySelector('[data-master-search]').value.includes('main.c'));
    await page.locator('[data-code-folder][value="code/project/trunk"]').waitFor({state:'attached'});
    assert.equal(await page.locator('[data-code-folder][value="code/project/trunk"]').isChecked(), true);
    assert.equal(await page.locator('[data-home-ai]').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: unified input, inline SSE, retained draft, nested source browsing, session refresh, search-to-line, deep link, mobile layout and AI handoff.');
  } finally {
    if (browser) await browser.close();
    server.stdin.end('\n');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
