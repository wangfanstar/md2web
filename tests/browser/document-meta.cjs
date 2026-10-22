const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const assert=require('node:assert/strict');
(async()=>{
 const server=spawn(process.env.MD2WEB_PYTHON||'C:/Users/wangfan/AppData/Local/Temp/md2web-py368/python.exe',['tests/browser/site-math-server.py'],{env:{...process.env,MD2WEB_MATH_SOURCE:'# Author\n\nContent',MD2WEB_META_AUTHOR:'1'},stdio:['pipe','pipe','pipe']});
 let browser,stderr='';server.stderr.on('data',d=>stderr+=d);
 try{
  const base=await new Promise((resolve,reject)=>{readline.createInterface({input:server.stdout}).on('line',line=>{try{const d=JSON.parse(line);if(d.url)resolve(d.url);}catch{}});server.on('exit',()=>reject(new Error(stderr)));});
  browser=await chromium.launch({headless:true,executablePath:process.env.MD2WEB_BROWSER});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/html/index_server_only.html#/md/old/math');
  await page.waitForFunction(()=>document.querySelector('.workspace-doc-updated')?.textContent.includes('作者：admin'));
  assert.match(await page.locator('.workspace-doc-updated').innerText(),/最后更新：\d{4}-\d{2}-\d{2} · 作者：admin（本地文件）/);
  await page.route('**/__doc-meta?*',route=>route.fulfill({json:{ok:true,meta:{updatedAt:'2026-10-22',source:'svn',author:'<img src=x onerror=alert(1)>'}}}));
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('.workspace-doc-updated')?.textContent.includes('<img'));
  assert.equal(await page.locator('.workspace-doc-updated img').count(),0);
  assert.deepEqual(errors,[]);console.log('anonymous reading displays author/time; author renders as safe text: PASS');
 }finally{if(browser)await browser.close();if(server.exitCode===null){const done=new Promise(resolve=>server.on('exit',resolve));server.stdin.end('\n');assert.equal(await done,0,stderr);}}
})().catch(e=>{console.error(e);process.exitCode=1;});
