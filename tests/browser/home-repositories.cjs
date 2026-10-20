const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const assert=require('node:assert/strict');
const root=path.resolve('docs');
let mode='live';
const repositories=[{id:'使用说明',mount:'md/使用说明',group:'默认',source_mode:'local',href:'html/index_all.html#/md/使用说明/'},
  {id:'stable-a',mount:'md/原有库甲',display_name:'原有库甲',group:'原分组',source_mode:'svn',href:'html/index_all.html#/md/原有库甲/'},
  {id:'stable-b',mount:'md/原有库乙',display_name:'原有库乙',group:'另一组',source_mode:'local',href:'html/index_all.html#/md/原有库乙/'}];
const server=http.createServer((req,res)=>{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  function json(value){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}
  if(name==='/__site/repositories'&&mode==='live'){json({ok:true,repositories});return;}
  if(name==='/__folders'&&mode==='legacy'){json({ok:true,folders:repositories.map(r=>({path:r.mount,name:r.id,repo:{id:r.id,group:r.group,sourceMode:r.source_mode}}))});return;}
  if(name==='/__auth/session'){json({ok:true,authenticated:false,site:{repositories:mode==='legacy'?repositories:[]}});return;}
  if(name.startsWith('/__')){res.statusCode=404;res.end('{}');return;}
  if(name==='/lib/source-folders.json'){
    if(mode==='broken'){res.statusCode=503;res.end();return;}
    json({folders:repositories.map(r=>r.mount)});return;
  }
  const file=path.resolve(root,'.'+(name==='/'?'/index.html':name));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.json':'application/json','.css':'text/css'})[path.extname(file)]||'text/plain');
  res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,executablePath:process.env.MD2WEB_BROWSER});
  try{
    for(mode of ['live','legacy','static','broken']){
      const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto('http://127.0.0.1:'+server.address().port+'/');
      if(mode==='broken'){
        await page.waitForTimeout(350);
        assert.ok(await page.locator('[data-master-repositories] .card').count()>=1,'failed refresh preserves offline cards');
      }else{
        await page.waitForFunction(()=>document.querySelectorAll('[data-master-repositories] .card').length===3);
        assert.ok((await page.locator('[data-master-repositories]').innerText()).includes('原有库甲'));
        await page.locator('[data-master-repo-toggle]').click();
        assert.equal(await page.locator('[data-master-repo-list] input').count(),3,'search filters receive server repositories');
        const card=page.locator('[data-master-repositories] a').filter({hasText:'原有库甲'});
        assert.ok((await card.getAttribute('href')).startsWith(mode==='static'?'html/index_':'html/index_all.html#/md/'));
        if(mode==='live')assert.ok((await page.locator('[data-master-repositories]').innerText()).includes('原分组'));
      }
      assert.deepEqual(errors,[]);
      await page.close();
    }
    console.log('homepage: live / legacy / static catalog restores other repositories; failure retains snapshot: PASS');
  }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
