const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const assert=require('node:assert/strict');
const path=require('node:path');
const source='# 复制格式测试\n\n正文 **加粗**、*斜体*、[文档链接](https://example.com/manual)。\n\n## 表格和列表\n\n| 名称 | 数值 |\n| --- | --- |\n| 示例 | 42 |\n\n1. 第一项\n2. 第二项\n\n```js\nconst credit = 42;\n```\n\n$$\n\\text{S\\_CU}+x \\leq y\n$$\n\n```mermaid\ngraph LR\nA[发送] --> B[接收]\n```\n\n![内嵌图片](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==)\n';
(async()=>{
  const server=spawn(process.env.MD2WEB_PYTHON||'C:/Users/wangfan/AppData/Local/Temp/md2web-py368/python.exe',['tests/browser/site-math-server.py'],{env:{...process.env,MD2WEB_MATH_SOURCE:source},stdio:['pipe','pipe','pipe']});
  let stderr='';server.stderr.on('data',d=>stderr+=d);
  const base=await new Promise((resolve,reject)=>{readline.createInterface({input:server.stdout}).on('line',line=>{try{const d=JSON.parse(line);if(d.url)resolve(d.url);}catch{}});server.on('exit',()=>reject(new Error(stderr)));});
  const browser=await chromium.launch({headless:true,executablePath:process.env.MD2WEB_BROWSER});
  try{
    const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
    const page=await context.newPage();
    await page.goto(base+'/html/index_server_only.html#/md/old/math');
    await page.waitForFunction(()=>document.querySelector('.markdown-section .mermaid svg'));
    assert.equal(await page.evaluate(()=>typeof window.PageCopy),'object','existing entry pages load copy support without a new script tag');
    await page.evaluate(()=>document.querySelectorAll('.search-section-body').forEach(n=>{n.hidden=true;}));
    await page.evaluate(()=>{const c=document.createElement('canvas');c.width=40;c.height=20;c.setAttribute('aria-label','画布回归');c.getContext('2d').fillStyle='red';c.getContext('2d').fillRect(0,0,40,20);document.querySelector('.markdown-section').appendChild(c);});
    const button=page.getByRole('button',{name:'复制本页内容',exact:true});
    await button.click();
    await page.waitForFunction(()=>document.querySelector('[data-workspace-copy-content]').textContent.includes('已复制'));
    const copied=await page.evaluate(async()=>{const items=await navigator.clipboard.read();return {html:await (await items[0].getType('text/html')).text(),text:await (await items[0].getType('text/plain')).text()};});
    assert.match(copied.html,/<h1[^>]*>/i); assert.match(copied.html,/<strong[^>]*>加粗/);
    assert.match(copied.html,/<table[^>]*>/); assert.match(copied.html,/<ol[^>]*>/);
    assert.match(copied.html,/border[^;]*:/); assert.match(copied.text,/const credit = 42/);
    assert.ok((copied.html.match(/data:image\/png/g)||[]).length>=4,'formula, Mermaid, canvas and original image embedded');
    const pixel=await page.evaluate(async html=>{const doc=new DOMParser().parseFromString(html,'text/html');const img=new Image();img.src=doc.querySelector('img[alt="画布回归"]').src;await img.decode();const c=document.createElement('canvas');c.width=40;c.height=20;c.getContext('2d').drawImage(img,0,0);return Array.from(c.getContext('2d').getImageData(2,2,1,1).data);},copied.html);
    assert.deepEqual(pixel,[255,0,0,255],'copy painted canvas pixels, not an empty cloned canvas');
    assert.ok(!copied.html.includes('workspace-page-actions')); assert.ok(!copied.text.includes('复制链接'));
    assert.equal((copied.text.match(/加粗/g)||[]).length,1); assert.match(copied.text,/示例/);
    // Verify native paste consumes the HTML representation.
    await page.evaluate(()=>{const target=document.createElement('div');target.id='paste-target';target.contentEditable='true';target.style.cssText='position:relative;margin:20px 20px 20px 320px;background:white;padding:20px;';document.body.appendChild(target);target.focus();});
    await page.keyboard.press('Control+V');
    await page.waitForFunction(()=>document.querySelector('#paste-target table'));
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('#paste-target img')).every(n=>n.complete));
    await page.locator('#paste-target').screenshot({path:path.join(process.env.TEMP||'.','md2web-page-copy-paste.png')});
    // HTTP/file fallback must also write HTML and preserve the user's selection.
    const fallback=await page.evaluate(async()=>{window.originalClipboard=navigator.clipboard;Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});const range=document.createRange();range.selectNodeContents(document.querySelector('.markdown-section h1'));const s=getSelection();s.removeAllRanges();s.addRange(range);const before=s.toString();await PageCopy.copy();const item=(await originalClipboard.read())[0];return {selection:getSelection().toString(),before,html:await (await item.getType('text/html')).text()};});
    assert.equal(fallback.selection,fallback.before);
    assert.match(fallback.html,/<table/,'legacy copy writes HTML, not only plain text');
    // A rejected copy must report failure, never display a success state.
    await page.evaluate(()=>{document.execCommand=()=>false;});
    await button.click();
    await page.waitForFunction(()=>document.querySelector('[data-workspace-copy-content]').textContent.includes('复制失败'));
    await page.goto(base+'/html/index_server_only.html');
    await page.waitForFunction(()=>document.querySelector('.folder-view'));
    await page.getByRole('button',{name:'复制本页内容',exact:true}).waitFor({state:'visible'});
    assert.equal(await page.locator('[data-workspace-copy-content]').count(),1,'copy available on repository overview, unlike document edit actions');
    const insecure=await context.newPage();
    await insecure.route('http://copy.test/**',async route=>{const url=new URL(route.request().url());const response=await context.request.get(base+url.pathname+url.search);await route.fulfill({response});});
    await insecure.goto('http://copy.test/html/index_server_only.html#/md/old/math');
    await insecure.waitForFunction(()=>document.querySelector('.markdown-section .mermaid svg'));
    assert.equal(await insecure.evaluate(()=>isSecureContext),false);
    await insecure.getByRole('button',{name:'复制本页内容',exact:true}).click();
    await insecure.waitForFunction(()=>document.querySelector('[data-workspace-copy-content]').textContent.includes('已复制'));
    await insecure.close();
    const offline=await context.newPage();
    await offline.goto(require('node:url').pathToFileURL(path.resolve('docs/html/index_all.html')).href+'#/md/使用说明/快速开始');
    await offline.waitForFunction(()=>window.PageCopy&&document.querySelector('[data-workspace-copy-content]'));
    await offline.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});});
    await offline.getByRole('button',{name:'复制本页内容',exact:true}).click();
    await offline.waitForFunction(()=>document.querySelector('[data-workspace-copy-content]').textContent.includes('已复制'));
    await offline.close();
    console.log('formatted HTML/plain clipboard, native paste, embedded diagrams/math, fallback, failure and folder visibility: PASS');
  }finally{await browser.close();const exit=new Promise(resolve=>server.on('exit',resolve));server.stdin.end('\n');assert.equal(await exit,0,stderr);}
})().catch(e=>{console.error(e);process.exitCode=1;});
