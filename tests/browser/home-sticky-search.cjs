const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const assert=require('node:assert/strict');
(async()=>{
  const server=spawn(process.env.MD2WEB_PYTHON||'C:/Users/wangfan/AppData/Local/Temp/md2web-py368/python.exe',['tests/browser/site-math-server.py'],{env:{...process.env,MD2WEB_MATH_SOURCE:'# Sticky test'},stdio:['pipe','pipe','pipe']});
  let stderr='';server.stderr.on('data',d=>stderr+=d);
  const base=await new Promise((resolve,reject)=>{readline.createInterface({input:server.stdout}).on('line',line=>{try{const d=JSON.parse(line);if(d.url)resolve(d.url);}catch{}});server.on('exit',()=>reject(new Error(stderr)));});
  const browser=await chromium.launch({headless:true,executablePath:process.env.MD2WEB_BROWSER});
  try{
    const page=await browser.newPage();
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:850});
      await page.goto(base+'/index.html');
      await page.locator('[data-master-search]').waitFor();
      await page.evaluate(()=>{const extra=document.createElement('div');extra.innerHTML=Array.from({length:80},(_,i)=>'<p style="height:50px">滚动测试 '+i+'</p>').join('');document.querySelector('.wrap').appendChild(extra);window.scrollTo(0,850);});
      await page.waitForFunction(()=>{const n=document.querySelector('.tools');return Math.abs(n.getBoundingClientRect().top-parseFloat(getComputedStyle(n).top))<1;},{},{timeout:2000});
      const metrics=await page.locator('.tools').evaluate(n=>({top:n.getBoundingClientRect().top,right:n.getBoundingClientRect().right,width:innerWidth}));
      assert.ok(metrics.right<=metrics.width,'toolbar fits viewport');
      assert.equal(await page.locator('[data-master-search]').evaluate(n=>{const r=n.getBoundingClientRect();return document.elementFromPoint(r.right-8,r.top+r.height/2)===n;}),true,'fixed login must not obscure the search input');
      await page.locator('[data-master-search]').fill('绘图');
      await page.waitForFunction(()=>document.querySelector('[data-master-results] a'));
      await page.locator('[data-master-repo-toggle]').click();
      const menu=page.locator('[data-master-repo-menu]');assert.equal(await menu.isVisible(),true);
      const hit=await menu.evaluate(n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.left+10,r.top+10));});
      assert.equal(hit,true,'repository menu remains clickable over scrolled content');
      await page.screenshot({path:require('node:path').join(process.env.TEMP||'.','md2web-home-sticky-'+width+'.png')});
      await page.locator('[data-master-repo-toggle]').click();
      await page.evaluate(()=>window.scrollTo(0,0));
      assert.equal(await page.locator('[data-master-search]').inputValue(),'绘图');
    }
    await page.goto(require('node:url').pathToFileURL(require('node:path').resolve('docs/html/index_使用说明.html')).href+'#/md/使用说明/快速开始');
    await page.waitForFunction(()=>document.querySelectorAll('.markdown-section .katex-display').length===2);
    assert.equal(await page.locator('.markdown-section .katex-error').count(),0,'updated guide formulas render offline');
    assert.match(await page.locator('.markdown-section').innerText(),/首页浏览与搜索/);
    console.log('desktop/mobile sticky homepage toolbar, search results, repository dropdown and input retention: PASS');
  }finally{await browser.close();const exited=new Promise(resolve=>server.on('exit',resolve));server.stdin.end('\n');assert.equal(await exited,0,stderr);}
})().catch(e=>{console.error(e);process.exitCode=1;});
