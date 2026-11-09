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
    let largeFileRequests = 0;
    let summaryRequests = 0, scopeRequests = 0;
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/__code/file' && url.searchParams.get('path') === 'src/nested/large.c') largeFileRequests++;
      if (url.pathname === '/__ai/public') {
        if (url.searchParams.get('summary') === '1') summaryRequests++;
        else scopeRequests++;
      }
    });
    page.on('pageerror', error => errors.push(error.message));
    await context.request.post(base + '/__auth/login', {data:{username:'admin',password:'admin'}});
    await page.goto(base + '/index.html');
    await page.waitForFunction(() => window.SiteAuth && SiteAuth.isAuthenticated());
    assert.equal(await page.locator('[data-master-search], [data-ai-input]').count(), 1);
    await page.locator('[data-code-repository-info] .card').first().waitFor();
    const codeCard = await page.locator('[data-code-repository-info] .card').first().innerText();
    assert.match(codeCard, /SVN 仓库：https:\/\/svn\.example\.com\/project\/trunk/);
    assert.match(codeCard, /当前版本：2026-10-30.*r42/);
    assert.match(codeCard, /2026-10-30/);
    assert.match(codeCard, /提交者：alice/);
    assert.match(codeCard, /浏览代码/);
    await page.evaluate(() => Promise.all([SiteAuth.refresh(), SiteAuth.refresh()]));
    assert.equal(summaryRequests, 1);
    assert.equal(scopeRequests, 0);
    const summaryURL = /\/__ai\/public\?summary=1$/;
    const unavailable = route => route.fulfill({status:503, json:{ok:false}});
    await page.route(summaryURL, unavailable);
    const failedRefresh = page.waitForResponse(response => summaryURL.test(response.url()) && response.status() === 503);
    await page.evaluate(() => {
      const now = Date.now;
      Date.now = () => now() + 31000;
      try { document.dispatchEvent(new CustomEvent('siteauth:change', {detail:SiteAuth.snapshot()})); }
      finally { Date.now = now; }
    });
    await (await failedRefresh).finished();
    assert.equal(await page.locator('[data-code-repository-info] .card').first().innerText(), codeCard);
    await page.unroute(summaryURL, unavailable);
    await page.locator('h1').click();
    await page.keyboard.press('/');
    assert.equal(await page.locator('[data-master-search]').evaluate(input => input === document.activeElement), true);
    await page.locator('[data-master-search]').fill('main');
    await page.locator('[data-home-submit]').click();
    await page.locator('[data-master-results] a').first().waitFor();
    await page.locator('[data-home-mode=ai]').click();
    assert.equal(await page.locator('[data-master-search]').inputValue(), 'main');
    await page.locator('[data-ai-model] option[value=opus]').waitFor({state:'attached'});
    await page.locator('.ai-scope-trigger').click();
    for (const folder of ['pdf', 'word', 'excel', 'ppt']) {
      assert.equal(await page.locator('[data-document-folder][value="' + folder + '"]').isEnabled(), true);
    }
    for (const folder of ['html', 'lib', 'code', 'reference-trash', 'superpowers']) {
      assert.equal(await page.locator('[data-document-folder][value="' + folder + '"]').count(), 0);
    }
    await page.locator('[data-document-folder][value="html/ref"]').check();
    await page.getByRole('button', {name:'完成选择',exact:true}).click();
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
    assert.ok(await page.locator('#source .token.keyword').count() > 0);
    assert.equal(await page.locator('#source .token.comment .code-symbol').count(), 0);
    assert.equal(await page.locator('#source .code-symbol.token.comment, #source .code-symbol.token.keyword').count(), 0);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('siteauth:change', {detail:SiteAuth.snapshot()})));
    assert.equal(await page.locator('#source .code-line').count(), 10);
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
    await page.locator('#source [data-symbol="main"]').click();
    await page.locator('#symbol-definitions').filter({hasText:'(1)'}).waitFor();
    await page.locator('#symbol-results .code-search-hit').click();
    await page.locator('#L2.is-selected').waitFor();
    await page.locator('#symbol-references').click();
    await page.locator('#symbol-results .code-search-hit').click();
    await page.waitForFunction(() => document.getElementById('path').textContent.endsWith('caller.c'));
    await page.locator('#source [data-symbol="call_main"]').click();
    await page.waitForFunction(() => document.getElementById('symbol-status').textContent.includes('文本匹配'));
    await page.locator('#symbol-definitions').click();
    assert.match(await page.locator('#symbol-results').innerText(), /gtags/);
    await page.locator('#source [data-symbol="main"]').last().click();
    await page.locator('#symbol-definitions').filter({hasText:'(1)'}).waitFor();
    await page.locator('#symbol-results .code-search-hit').click();
    await page.waitForFunction(() => document.getElementById('path').textContent.endsWith('main.c'));
    await page.locator('#back-location').click();
    await page.waitForFunction(() => document.getElementById('path').textContent.endsWith('caller.c'));
    await page.locator('#back-location').click();
    await page.waitForFunction(() => document.getElementById('path').textContent.endsWith('main.c'));
    assert.equal(await page.locator('#reindex').isVisible(), true);
    assert.equal(await page.locator('#reindex').innerText(), '更新 gtags 索引');
    const collapsedSrc = page.getByRole('button', {name:'▸ src',exact:true});
    if (await collapsedSrc.count()) {
      await collapsedSrc.click();
      await page.getByRole('button', {name:'▸ nested',exact:true}).waitFor();
    }
    const collapsedNested = page.getByRole('button', {name:'▸ nested',exact:true});
    if (await collapsedNested.count()) await collapsedNested.click();
    await page.getByRole('button', {name:'tool.py',exact:true}).click();
    await page.waitForFunction(() => document.getElementById('path').textContent.endsWith('tool.py'));
    assert.ok(await page.locator('#source .token.keyword').count() > 0);
    assert.ok(await page.locator('#source .code-symbol[data-symbol="build_index"]').count() > 0);
    await page.getByRole('button', {name:'run.sh',exact:true}).click();
    await page.waitForFunction(() => document.getElementById('path').textContent.endsWith('run.sh'));
    assert.ok(await page.locator('#source .token.keyword, #source .token.builtin').count() > 0);
    await page.locator('#toggle-tagbar').click();
    assert.equal(await page.locator('#file-tagbar').isVisible(), true);
    await page.getByRole('button', {name:'tool.py',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('#file-tags').textContent.includes('build_index'));
    await page.locator('#file-tags a').first().click();
    assert.ok(await page.locator('#source .is-selected').count());
    await page.locator('#toggle-tagbar').click();
    assert.equal(await page.locator('#file-tagbar').isHidden(), true);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'quick-symbol');
    await page.locator('#quick-symbol').fill('mai');
    await page.locator('#quick-symbol-results .code-suggest-item').first().waitFor();
    assert.match(await page.locator('#quick-symbol-results .code-suggest-item').first().innerText(), /main/);
    await page.locator('#quick-symbol').fill('main');
    await page.waitForResponse(response => response.url().includes('mode=symbol') && new URL(response.url()).searchParams.get('q') === 'main');
    await page.locator('#quick-symbol-results .code-suggest-item').first().waitFor();
    assert.match(await page.locator('#quick-symbol-results .code-suggest-item').first().innerText(), /main.c:2/);
    await page.locator('#quick-symbol-results .code-suggest-item').first().click();
    await page.waitForFunction(() => document.getElementById('path').textContent.endsWith('main.c'));
    assert.equal(await page.locator('#quick-symbol-results').isHidden(), true);
    await page.locator('#source .code-symbol[data-symbol="main"]').hover();
    await page.waitForFunction(() => {
      const preview = document.querySelector('.code-function-preview');
      return preview && preview.textContent.includes('return 42;');
    });
    assert.match(await page.locator('.code-function-preview').first().innerText(), /int main\(void\) \{[\s\S]*return 42;[\s\S]*\}/);
    assert.equal(await page.locator('.code-search-dock #path .code-path-root').innerText(), '/');
    assert.equal(await page.locator('.code-search-dock #path span').last().innerText(), 'main.c');
    assert.equal(await page.locator('#symbols').evaluate(panel => getComputedStyle(panel).overflowY), 'hidden');
    assert.equal(await page.locator('#symbol-results').evaluate(panel => getComputedStyle(panel).overflowY), 'auto');
    assert.equal(await page.locator('.code-function-preview').first().evaluate(panel => getComputedStyle(panel).overflowY), 'visible');
    await page.screenshot({path: process.env.TEMP + '/md2web-hover-layout.png'});
    const authControl = page.locator('.site-auth-fixed');
    if (await authControl.count()) {
      assert.equal(await authControl.evaluate(panel => {
        const bounds = panel.getBoundingClientRect();
        return panel.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
      }), true);
    }

    await page.keyboard.press('Escape');
    await page.locator('#source .code-symbol[data-symbol="gt_port_speed_t"]').last().hover();
    await page.waitForFunction(() => {
      const preview = document.querySelector('.code-function-preview');
      return preview && preview.textContent.includes('int speed;');
    });
    assert.match(await page.locator('.code-function-preview').first().innerText(), /typedef struct[\s\S]*int mode;[\s\S]*gt_port_speed_t;/);
    await page.keyboard.press('Escape');
    for (const id of ['code-directory', 'file-tagbar']) {
      if (id === 'file-tagbar') await page.locator('#toggle-tagbar').click();
      const panel = page.locator('#' + id);
      const before = (await panel.boundingBox()).width;
      const handle = await panel.locator('.code-width-handle').boundingBox();
      await page.mouse.move(handle.x + 3, handle.y + 20);
      await page.mouse.down();
      await page.mouse.move(handle.x + 63, handle.y + 20);
      await page.mouse.up();
      assert.ok((await panel.boundingBox()).width > before + 40);
      if (id === 'file-tagbar') await page.locator('#toggle-tagbar').click();
    }
    await page.locator('#q').press('Escape');
    await page.locator('#q').fill('return 42');
    await page.locator('#mode').selectOption('text');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('实时搜索'));
    await page.locator('#q').fill('main');
    await page.locator('#mode').selectOption('symbol');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('GNU Global'));
    const largeStart = Date.now();
    await page.getByRole('button', {name:'large.c',exact:true}).click();
    await page.waitForFunction(() => Number(document.getElementById('line-jump').max) === 20001);
    const firstLargeMs = Date.now() - largeStart;
    assert.ok(await page.locator('#source .code-line').count() < 250);
    await page.locator('#line-jump').fill('19000');
    await page.locator('#jump-form button').click();
    await page.locator('#L19000.is-selected').waitFor();
    assert.match(await page.locator('#L19000').innerText(), /function_18999/);
    assert.equal(await page.locator('#L19000 [data-symbol="function_18999"]').count(), 1);
    await page.evaluate(() => { const source = document.getElementById('source'); source.scrollTop = source.scrollHeight; });
    await page.locator('#L20000').waitFor();
    assert.ok(await page.locator('#source .code-line').count() < 250);
    await page.locator('#toggle-tree').click();
    assert.equal(await page.locator('#code-directory').isVisible(), false);
    await page.locator('#toggle-tree').click();
    assert.equal(await page.locator('#code-directory').isVisible(), true);
    await page.locator('#copy-source').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('完整源码已复制'));
    assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes('function_19999'));
    await page.getByRole('button', {name:'main.c',exact:true}).click();
    await page.waitForFunction(() => document.getElementById('path').textContent.endsWith('main.c'));
    const cachedStart = Date.now();
    await page.getByRole('button', {name:'large.c',exact:true}).click();
    await page.waitForFunction(() => Number(document.getElementById('line-jump').max) === 20001);
    assert.equal(largeFileRequests, 1);
    console.log('20,001-line source: first open ' + firstLargeMs + 'ms, cached reopen ' + (Date.now() - cachedStart) + 'ms, DOM rows ' + await page.locator('#source .code-line').count());
    await page.getByRole('button', {name:'main.c',exact:true}).click();
    await page.waitForFunction(() => document.getElementById('path').textContent.endsWith('main.c'));
    await page.locator('#source [data-symbol="main"]').last().click({button:'right'});
    await page.locator('#code-context-menu').waitFor({state:'visible'});
    const menuText = await page.locator('#code-context-menu').innerText();
    assert.match(menuText, /问 AI：解释 main/);
    assert.match(menuText, /查找 main 的定义与引用/);
    await page.locator('#code-context-menu button').filter({hasText:'复制符号名 main'}).click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('符号名已复制'));
    await page.keyboard.press('Escape');
    await page.screenshot({path:process.env.TEMP + '/md2web-code-reader.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', {name:'就此位置问 AI →'}).click();
    await page.waitForURL('**/index.html?aiQuestion=*');
    await page.waitForFunction(() => document.querySelector('[data-master-search]').value.includes('main.c'));
    await page.locator('[data-code-folder][value="code/project/trunk"]').waitFor({state:'attached'});
    assert.equal(await page.locator('[data-code-folder][value="code/project/trunk"]').isChecked(), true);
    assert.equal(await page.locator('[data-home-ai]').isVisible(), true);
    const legacy = await context.newPage();
    const legacyErrors = [];
    legacy.on('pageerror', error => legacyErrors.push(error.message));
    await legacy.route('**/html/reference_code.html', async route => {
      const response = await route.fetch();
      let html = await response.text();
      html = html.replace(/<button id="toggle-tree"[^>]*>[^<]*<\/button>/, '')
        .replace(/<button id="copy-source"[^>]*>[^<]*<\/button>/, '')
        .replace(/<small id="file-meta"><\/small>/, '')
        .replace(/<form id="jump-form"[\s\S]*?<\/form>/, '')
        .replace('id="code-directory" ', '');
      await route.fulfill({response, body:html});
    });
    await legacy.goto(base + '/html/reference_code.html');
    await legacy.getByRole('button', {name:'▸ src',exact:true}).click();
    await legacy.getByRole('button', {name:'▸ nested',exact:true}).click();
    await legacy.getByRole('button', {name:'main.c',exact:true}).click();
    await legacy.locator('#source').waitFor({state:'visible'});
    assert.match(await legacy.locator('#source').innerText(), /return 42/);
    assert.deepEqual(legacyErrors, []);
    await legacy.close();

    const stalled = await context.newPage();
    await stalled.addInitScript(() => {
      const original = window.setTimeout;
      window.setTimeout = (fn, delay, ...args) => original(fn, delay === 20000 ? 25 : delay, ...args);
    });
    let stallOnce = true;
    await stalled.route('**/__code/repos?**', async route => {
      if (stallOnce) { stallOnce = false; await new Promise(resolve => setTimeout(resolve, 200)); }
      try { await route.continue(); } catch {}
    });
    await stalled.goto(base + '/html/reference_code.html');
    await stalled.locator('#retry-load').waitFor({state:'visible'});
    assert.match(await stalled.locator('#status').innerText(), /超时/);
    await stalled.locator('#retry-load').click();
    await stalled.getByRole('button', {name:'▸ src',exact:true}).waitFor();
    await stalled.close();
    const missingScript = await context.newPage();
    await missingScript.addInitScript(() => {
      const original = window.setTimeout;
      window.setTimeout = (fn, delay, ...args) => original(fn, delay === 12000 ? 30 : delay, ...args);
    });
    await missingScript.route('**/lib/reference-code.js*', route => route.abort());
    await missingScript.goto(base + '/html/reference_code.html');
    await missingScript.getByRole('button', {name:'刷新页面',exact:true}).waitFor();
    assert.match(await missingScript.locator('#status').innerText(), /脚本未能启动/);
    await missingScript.close();
    const logoutPage = await context.newPage();
    let releaseSummary;
    const summaryHeld = new Promise(resolve => { releaseSummary = resolve; });
    await logoutPage.route(summaryURL, async route => {
      await summaryHeld;
      await route.fulfill({json:{ok:true,repositories:[{id:'late',name:'late'}]}}).catch(() => {});
    });
    try {
      await Promise.all([
        logoutPage.waitForRequest(request => summaryURL.test(request.url())),
        logoutPage.goto(base + '/index.html')
      ]);
      await logoutPage.evaluate(() => SiteAuth.logout());
      await logoutPage.locator('[data-code-repository-info]').filter({hasText:'登录服务器后查看代码库信息'}).waitFor();
    } finally {
      releaseSummary();
      await logoutPage.unrouteAll({behavior:'wait'});
    }
    assert.equal(await logoutPage.locator('[data-code-repository-info] .card').count(), 0);
    await logoutPage.close();
    assert.deepEqual(errors, []);
    console.log('PASS: source/home flows, large-file rendering, cached HTML compatibility, API timeout/retry and missing-script recovery.');
  } finally {
    if (browser) await browser.close();
    server.stdin.end('\n');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
