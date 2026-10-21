const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const assert=require('node:assert/strict');
(async()=>{
  const server=spawn(process.env.MD2WEB_PYTHON||'C:/Users/wangfan/AppData/Local/Temp/md2web-py368/python.exe',['tests/browser/site-math-server.py'],{env:{...process.env,MD2WEB_MATH_SOURCE:'# Reading statistics\n\nContent'},stdio:['pipe','pipe','pipe']});
  let stderr='',browser;server.stderr.on('data',d=>stderr+=d);
  try{
    const base=await new Promise((resolve,reject)=>{readline.createInterface({input:server.stdout}).on('line',line=>{try{const d=JSON.parse(line);if(d.url)resolve(d.url);}catch{}});server.on('exit',()=>reject(new Error(stderr)));});
    browser=await chromium.launch({headless:true,executablePath:process.env.MD2WEB_BROWSER});
    const page=await browser.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.request.post(base+'/__auth/login',{data:{username:'admin',password:'admin'}});
    const visit=page.waitForResponse(r=>r.url().endsWith('/__md/visit')&&r.request().method()==='POST');
    await page.goto(base+'/html/index_server_only.html#/md/old/math');
    assert.equal((await visit).status(),200);
    await page.waitForTimeout(700);
    let data=await (await page.request.get(base+'/__admin/user-records')).json();
    assert.equal(data.users[0].visits,1);assert.equal(data.users[0].articles,1);
    const next=page.waitForResponse(r=>r.url().endsWith('/__md/visit')&&r.request().method()==='POST');
    await page.reload();assert.equal((await next).status(),200);
    data=await (await page.request.get(base+'/__admin/user-records')).json();
    assert.equal(data.users[0].visits,2);assert.equal(data.users[0].articles,1);
    const visitor=await browser.newPage();
    const anonymousVisit=visitor.waitForResponse(r=>r.url().endsWith('/__md/visit')&&r.request().method()==='POST');
    await visitor.goto(base+'/html/index_server_only.html#/md/old/math');
    assert.equal((await anonymousVisit).status(),200);
    data=await (await page.request.get(base+'/__admin/user-records')).json();
    assert.equal(data.articles[0].visits,3);
    assert.ok(data.ips.some(r=>r.username==='未登录访客'&&r.action==='article_visit'));
    assert.ok(data.ips.some(r=>r.username==='未登录访客'&&r.action==='site_visit'));
    await visitor.close();
    assert.deepEqual(errors,[]);
    console.log('actual article open/reload: visits=2, distinct articles=1, no duplicate render events: PASS');
  }finally{
    if(browser)await browser.close();
    if(server.exitCode===null){const exited=new Promise(resolve=>server.on('exit',resolve));server.stdin.end('\n');assert.equal(await exited,0,stderr);}
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
