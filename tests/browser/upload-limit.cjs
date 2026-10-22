const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const assert=require('node:assert/strict');
(async()=>{
 const server=spawn(process.env.MD2WEB_PYTHON||'C:/Users/wangfan/AppData/Local/Temp/md2web-py368/python.exe',['tests/browser/site-math-server.py'],{env:{...process.env,MD2WEB_MATH_SOURCE:'# Upload',MD2WEB_REFERENCE_UPLOAD:'1'},stdio:['pipe','pipe','pipe']});
 let browser,stderr='';server.stderr.on('data',d=>stderr+=d);
 try{
  const base=await new Promise((resolve,reject)=>{readline.createInterface({input:server.stdout}).on('line',line=>{try{const d=JSON.parse(line);if(d.url)resolve(d.url);}catch{}});server.on('exit',()=>reject(new Error(stderr)));});
  browser=await chromium.launch({headless:true,executablePath:process.env.MD2WEB_BROWSER});
  const page=await browser.newPage(),errors=[];let uploads=0;
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.url().endsWith('/__references/upload'))uploads++;});
  await page.request.post(base+'/__auth/login',{data:{username:'admin',password:'admin'}});
  await page.goto(base+'/html/reference_library.html');
  await page.waitForFunction(()=>document.querySelector('[data-upload]').textContent.includes('1 MB'));
  await page.locator('[data-file]').setInputFiles([
   {name:'one.pdf',mimeType:'application/pdf',buffer:Buffer.alloc(700*1024,120)},
   {name:'two.pdf',mimeType:'application/pdf',buffer:Buffer.alloc(700*1024,120)},
   {name:'too-large.pdf',mimeType:'application/pdf',buffer:Buffer.alloc(1024*1024+1,120)}
  ]);
  await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('已上传 2 个，失败 1 个'));
  assert.match(await page.locator('[data-status]').innerText(),/too-large.pdf.*上限 1 MB/);
  assert.equal(uploads,2,'valid files split into requests below combined limit');
  const listing=await (await page.request.get(base+'/__references/list?kind=pdf')).json();
  assert.ok(listing.listing.items.some(item=>item.name==='one.pdf'));
  assert.ok(listing.listing.items.some(item=>item.name==='two.pdf'));
  assert.ok(!listing.listing.items.some(item=>item.name==='too-large.pdf'));
  await page.waitForFunction(()=>document.querySelector('[data-list]').textContent.includes('two.pdf'));
  assert.match(await page.locator('[data-status]').innerText(),/too-large.pdf/,'list refresh preserves upload failure reason');
  await page.route('**/__references/upload',route=>route.fulfill({status:413,json:{ok:false,error:'服务器具体限制：请稍后上传'}}));
  await page.locator('[data-file]').setInputFiles([{name:'server-error.pdf',mimeType:'application/pdf',buffer:Buffer.from('test')}]);
  await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('服务器具体限制'));
  assert.match(await page.locator('[data-status]').innerText(),/失败 1 个.*server-error.pdf.*服务器具体限制/);
  assert.deepEqual(errors,[]);console.log('configured limit, multi-file batching, oversize rejection and retained per-file errors: PASS');
 }finally{if(browser)await browser.close();if(server.exitCode===null){const done=new Promise(resolve=>server.on('exit',resolve));server.stdin.end('\n');assert.equal(await done,0,stderr);}}
})().catch(e=>{console.error(e);process.exitCode=1;});
