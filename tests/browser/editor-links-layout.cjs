const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const server=spawn(process.env.MD2WEB_PYTHON||'C:/Users/wangfan/AppData/Local/Temp/md2web-py368/python.exe',['tests/browser/site-math-server.py'],{env:{...process.env,MD2WEB_MATH_SOURCE:'# Editor\n\nText',MD2WEB_LINK_TARGETS:'1'},stdio:['pipe','pipe','pipe']});
 let browser,stderr='';server.stderr.on('data',d=>stderr+=d);
 try{
  const base=await new Promise((resolve,reject)=>{readline.createInterface({input:server.stdout}).on('line',line=>{try{const d=JSON.parse(line);if(d.url)resolve(d.url);}catch{}});server.on('exit',()=>reject(new Error(stderr)));});
  browser=await chromium.launch({headless:true,executablePath:process.env.MD2WEB_BROWSER});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.request.post(base+'/__auth/login',{data:{username:'admin',password:'admin'}});
  await page.goto(base+'/html/index_server_only.html#/md/old/math');
  await page.waitForFunction(()=>window.SiteAuth&&window.SiteAuth.isAuthenticated());
  await page.evaluate(()=>window.MdEditor.openLocal());await page.locator('.md-editor-text').waitFor();
  await page.getByRole('button',{name:'站内文档链接',exact:true}).click();
  const search=page.getByRole('searchbox',{name:'搜索站内文件'});await search.fill('Link target');
  await page.waitForFunction(()=>document.querySelectorAll('.md-internal-results button').length===1);
  assert.doesNotMatch(await page.locator('.md-internal-results').innerText(),/章节标题/);
  await page.locator('.md-internal-results button').click();
  await search.fill('Duplicate');
  await page.waitForFunction(()=>document.querySelectorAll('.md-internal-results button').length===2);
  await page.locator('.md-internal-results button').nth(1).click();
  const link=page.locator('.md-editor-preview a[data-site-file]');await link.waitFor();
  assert.match(await link.getAttribute('href'),/target\.md\?id=duplicate-1$/);
  const opened=page.waitForEvent('popup');await link.click();const target=await opened;
  await target.waitForFunction(()=>document.getElementById('duplicate-1'));
  assert.ok(target.url().includes('id=duplicate-1'));await target.close();
  await page.locator('.md-editor-text').focus();await page.keyboard.press('Control+Alt+Shift+l');
  await page.getByRole('searchbox',{name:'搜索站内文件'}).fill('Link target');
  await page.locator('.md-internal-results button').filter({hasText:'整篇文档'}).click();
  await page.getByRole('button',{name:'← 返回文档列表'}).click();
  assert.equal(await search.inputValue(),'Link target');
  await page.locator('.md-internal-results button').filter({hasText:'整篇文档'}).click();
  await search.fill('no-such-heading');
  await page.waitForFunction(()=>document.querySelector('[data-info]').textContent.includes('没有匹配的章节'));
  await page.getByRole('button',{name:'插入整篇文档',exact:true}).click();
  for(const width of [1440,1024,390]){
   await page.setViewportSize({width,height:1000});
   const before=await page.locator('.md-editor-primary button').evaluateAll(nodes=>nodes.map(n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y})));
   await page.locator('[data-editor-status]').evaluate(n=>n.textContent='很长的保存状态消息'.repeat(80));
   const after=await page.locator('.md-editor-primary button').evaluateAll(nodes=>nodes.map(n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y})));
   assert.deepEqual(after,before,'status text cannot move primary controls');
   assert.equal(new Set(after.map(p=>p.y)).size,1,'buttons stay on one row');
   await page.screenshot({path:path.join(process.env.TEMP||'.','md2web-editor-fixed-'+width+'.png')});
  }
  assert.deepEqual(errors,[]);console.log('document/duplicate heading targets, new tab, shortcut, stable controls at 1440/1024/390: PASS');
 }finally{if(browser)await browser.close();if(server.exitCode===null){const done=new Promise(resolve=>server.on('exit',resolve));server.stdin.end('\n');assert.equal(await done,0,stderr);}}
})().catch(e=>{console.error(e);process.exitCode=1;});
