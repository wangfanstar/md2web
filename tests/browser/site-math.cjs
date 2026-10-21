const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const source = '### 发送前：检查是否有足够 credit\n\n以每 VC 限额模式为例：\n\n$$\n\\text{S\\_VC\\_CU}[x]+\\text{pktCredits}\n\\leq\n\\text{S\\_VC\\_CL}[x]\n$$\n\n其中：\n\n- `CU`：Credits in Use。\n\n$$\n\\text{S\\_P\\_CU}+\\text{pktCredits}\n\\leq\n\\text{S\\_P\\_CL}\n$$';
(async () => {
  const server = spawn(process.env.MD2WEB_PYTHON||'C:/Users/wangfan/AppData/Local/Temp/md2web-py368/python.exe',
    ['tests/browser/site-math-server.py'],{env:{...process.env,MD2WEB_MATH_SOURCE:source},stdio:['pipe','pipe','pipe']});
  let stderr='';server.stderr.on('data',data=>stderr+=data);
  const base=await new Promise((resolve,reject)=>{
    readline.createInterface({input:server.stdout}).on('line',line=>{try{const data=JSON.parse(line);if(data.url)resolve(data.url);}catch{}});
    server.on('exit',()=>reject(new Error(stderr)));
  });
  const browser = await chromium.launch({headless:true,executablePath:process.env.MD2WEB_BROWSER});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    const response=await page.goto(base+'/html/index_server_only.html#/md/old/math');
    assert.ok(!(await response.text()).includes('?v=stale'),'server refreshes asset versions without rebuilding server-only page');
    await page.waitForFunction(()=>document.querySelectorAll('.markdown-section .katex-display').length===2);
    assert.equal(await page.locator('.markdown-section .katex-error').count(),0);
    await page.evaluate(()=>window.MdEditor.openLocal());
    await page.waitForFunction(()=>document.querySelectorAll('.md-editor-preview .katex-display').length===2);
    assert.equal(await page.locator('.md-editor-preview .katex-error').count(),0);
    assert.match(await page.locator('.md-editor-preview annotation').first().textContent(),/\\text\{S\\_VC\\_CU\}/);
    await page.screenshot({path:path.join(process.env.TEMP||'.','md2web-site-math.png')});
    assert.deepEqual(errors,[]);
    console.log('generated page, full script order, reading and editor, screenshot formulas: PASS');
  } finally {
    await browser.close();
    const exited=new Promise(resolve=>server.on('exit',resolve));
    server.stdin.end('\n');
    assert.equal(await exited,0,stderr);
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
