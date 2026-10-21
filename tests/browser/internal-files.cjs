const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const server=spawn(process.env.MD2WEB_PYTHON||'C:/Users/wangfan/AppData/Local/Temp/md2web-py368/python.exe',['tests/browser/site-math-server.py'],{env:{...process.env,MD2WEB_MATH_SOURCE:'# Files\n\n<a href="html/internal-report.html" target="_blank" rel="noopener noreferrer" data-site-file="true">Report</a>',MD2WEB_INTERNAL_FILES:'1'},stdio:['pipe','pipe','pipe']});
 let browser,stderr='';server.stderr.on('data',d=>stderr+=d);
 try {
  const base=await new Promise((resolve,reject)=>{readline.createInterface({input:server.stdout}).on('line',line=>{try{const d=JSON.parse(line);if(d.url)resolve(d.url);}catch{}});server.on('exit',()=>reject(new Error(stderr)));});
  browser=await chromium.launch({headless:true,executablePath:process.env.MD2WEB_BROWSER});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  assert.equal((await page.request.get(base+'/__md/internal-files')).status(),401);
  await page.goto(base+'/html/index_server_only.html#/md/old/math');
  const readingLink=page.locator('.markdown-section a[data-site-file]');await readingLink.waitFor();
  assert.equal(await readingLink.evaluate(n=>n.href),base+'/html/internal-report.html');
  assert.equal(await readingLink.getAttribute('target'),'_blank');
  await page.waitForFunction(()=>window.SiteAuth);
  await page.evaluate(()=>window.SiteAuth.openLogin());
  await page.locator('.site-auth.is-open').waitFor();
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:844});
    assert.ok(await page.locator('.site-auth-panel').evaluate(n=>n.getBoundingClientRect().right<=innerWidth));
    await page.screenshot({path:path.join(process.env.TEMP||'.','md2web-login-'+width+'.png')});
  }
  await page.locator('.site-auth [name=username]').fill('admin');
  await page.locator('.site-auth [name=password]').fill('admin');
  await page.locator('.site-auth button[type=submit]').click();
  await page.waitForFunction(()=>window.SiteAuth.isAuthenticated());
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>window.MdEditor.openLocal());
  await page.locator('.md-editor-text').waitFor({state:'visible'});
  await page.getByRole('button',{name:'引用站内文件',exact:true}).click();
  await page.getByRole('searchbox',{name:'搜索站内文件'}).fill('internal-report');
  await page.locator('.md-internal-results button').filter({hasText:'internal-report.html'}).click();
  assert.match(await page.locator('.md-editor-text').inputValue(),/target="_blank"/);
  const link=page.locator('.md-editor-preview a[data-site-file]').last();
  await link.waitFor();assert.equal(await link.getAttribute('href'),base+'/html/internal-report.html');
  const popupPromise=page.waitForEvent('popup');await link.click();const popup=await popupPromise;
  await popup.waitForLoadState();assert.match(await popup.locator('body').innerText(),/Internal report/);await popup.close();
  await page.locator('.md-editor-text').focus();await page.keyboard.press('Control+Alt+l');
  await page.getByRole('searchbox',{name:'搜索站内文件'}).fill('协议');
  await page.locator('.md-internal-results button').filter({hasText:'协议 #1.pdf'}).waitFor();
  await page.screenshot({path:path.join(process.env.TEMP||'.','md2web-internal-files.png')});
  await page.keyboard.press('Escape');await page.locator('.md-internal-picker').waitFor({state:'detached'});
  assert.equal(await page.locator('.md-editor.is-open').count(),1);
  assert.deepEqual(errors,[]);console.log('login desktop/mobile, internal search, insert, popup, shortcut and Escape: PASS');
 } finally {if(browser)await browser.close();if(server.exitCode===null){const done=new Promise(resolve=>server.on('exit',resolve));server.stdin.end('\n');assert.equal(await done,0,stderr);}}
})().catch(e=>{console.error(e);process.exitCode=1;});
