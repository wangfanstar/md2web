// Isolated HTTP fixtures: never writes user Markdown or contacts SVN.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {pathToFileURL}=require('node:url');
const root=path.resolve('docs');
const sourceRoot=path.resolve('web');
const markdown='# 文档\n\n## 第一节\n\n内容\n';
const nav={folders:{'md/仓库':{href:'html/index_repo.html',label:'仓库'},'md/仓库/子目录':{href:'html/index_repo_child.html',label:'子目录'}}};
const compared=[];
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const route=decodeURIComponent(url.pathname);
  const isSvn=(url.searchParams.get('path')||'').endsWith('/SVN.md');
  function json(data,status=200){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}
  if(route==='/__auth/session'){json({authenticated:true,user:{username:'test'},csrfToken:'fixture'});return;}
  if(route==='/__svn/log'){
    if(isSvn)json({ok:true,entries:[{revision:12,message:'提交说明'}],olderRevision:5});
    else json({ok:false,code:'no_binding'},400);
    return;
  }
  if(route==='/__md/history'){
    const older=url.searchParams.has('cursor');
    json({ok:true,history:{nextCursor:older?null:9,revisions:[older
      ?{id:'local:4',draftVersion:4,previousId:null}
      :{id:'local:9',draftVersion:9,previousId:'local:4'}]}});
    return;
  }
  if(route==='/__md/compare'){
    const left=url.searchParams.get('left'),right=url.searchParams.get('right');
    compared.push([left,right]);
    json({ok:true,left:{ref:left,content:'旧内容'},right:{ref:right,content:'新内容'}});
    return;
  }
  if(route==='/__folder'){
    const subfolder={path:'md/仓库',name:'仓库'};
    json({ok:true,folder:{path:'md/.',name:'全部文档',folders:[subfolder],allFolders:[
      {path:'md/.'},subfolder,{path:'md/仓库/子目录'}
    ],documents:[{path:'md/root.md',name:'root.md'},{path:'md/仓库/子目录/a.md',name:'a.md'}]}});
    return;
  }
  if(route==='/html/navigation-map.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(nav));return;}
  if(route==='/lib/navigation-data.js'){res.setHeader('Content-Type','text/javascript');res.end('window.MD2WEB_NAVIGATION='+JSON.stringify(nav));return;}
  if(route.startsWith('/md/')){res.end(markdown);return;}
  if(['/html/index_repo.html','/html/index_repo_child.html'].includes(route)){res.end('<h1>destination</h1>');return;}
  let file=path.resolve(root,'.'+route);
  if(route.startsWith('/lib/')&&fs.existsSync(path.join(sourceRoot,path.basename(route))))file=path.join(sourceRoot,path.basename(route));
  if(!file.startsWith(path.resolve('.')+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json'})[path.extname(file)]||'text/plain');
  res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,executablePath:process.env.MD2WEB_BROWSER});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    const base='http://127.0.0.1:'+server.address().port;
    const start=base+'/html/index_all.html#/md/仓库/子目录/文档';
    for(const [label,destination] of [['仓库','index_repo.html'],['子目录','index_repo_child.html']]){
      await page.goto(start);
      await page.locator('.workspace-breadcrumb a').filter({hasText:label}).waitFor();
      await page.evaluate(()=>window.savedCrumb=document.querySelector('.workspace-breadcrumb a'));
      await page.waitForTimeout(500);
      assert.ok(await page.evaluate(()=>window.savedCrumb===document.querySelector('.workspace-breadcrumb a')),'breadcrumb DOM remains stable');
      await page.locator('.workspace-breadcrumb a').filter({hasText:label}).click({delay:150});
      await page.waitForURL('**/'+destination);
    }
    await page.goto(start);
    await page.waitForFunction(()=>!!window.DiffView);
    await page.evaluate(()=>DiffView.open({ref:'a',label:'旧版本',content:'甲\n乙\n<script>window.bad=1</script>'},
      {ref:'b',label:'新版本',content:'甲\n修改乙\n<script>window.bad=1</script>'}));
    await page.waitForFunction(()=>document.querySelector('.diff-view p').textContent.includes('处差异'));
    assert.equal(await page.locator('.diff-row').count(),3);
    assert.ok(await page.locator('.diff-cell mark').count()>=2);
    assert.equal(await page.evaluate(()=>window.bad),undefined);
    await page.getByRole('button',{name:'下一差异',exact:true}).click();
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    assert.equal(await page.locator('.diff-view').count(),0);
    for(const [url,heading,labels,refs] of [
      [start,'SQLite 已保存版本',['版本 4','版本 9'],['local:4','local:9']],
      [start.replace(/文档$/,'SVN'),'SVN 提交记录',['r5','r12'],['svn:r5','svn:r12']]
    ]){
      await page.goto(url);
      await page.getByRole('button',{name:'查看历史记录',exact:true}).click();
      const history=page.locator('.workspace-history-dialog');
      await history.getByRole('heading',{name:heading,exact:true}).waitFor();
      const button=history.getByRole('button',{name:'与上一版本对比',exact:true}).first();
      await button.click();
      const diff=page.locator('dialog.diff-view[open]');
      await diff.waitFor();
      assert.deepEqual(await diff.locator('.diff-heads strong').allTextContents(),labels);
      await diff.locator('.diff-row').first().waitFor();
      assert.deepEqual(compared.at(-1),refs);
      await page.keyboard.press('Escape');
      await diff.waitFor({state:'hidden'});
      assert.equal(await history.isVisible(),true);
      assert.equal(await button.evaluate(el=>el===document.activeElement),true);
      if(refs[0].startsWith('local:')){
        await history.getByRole('button',{name:'加载更多',exact:true}).click();
        await history.getByText('无更早版本',{exact:true}).waitFor();
        assert.equal(await history.getByRole('button',{name:'与上一版本对比',exact:true}).last().isDisabled(),true);
      }
      await history.getByRole('button',{name:'关闭',exact:true}).click();
    }
    await page.goto(base+'/html/index_all.html');
    await page.locator('[data-folder-document-counts]').waitFor();
    assert.match(await page.locator('.folder-view').innerText(), /子文件夹共 2 个 · 文档共 2 篇/);
    assert.match(await page.locator('[data-folder-document-counts]').innerText(), /当前文件夹 1 篇 · 所有子文件夹 1 篇/);
    assert.match(await page.locator('.folder-view-folders li').innerText(), /子文件夹 1 个 · 文档 1 篇（本层 0 篇）/);
    const offline=await browser.newPage();
    await offline.addInitScript(({markdown,nav})=>{
      let data;
      Object.defineProperty(window,'__DOCSIFY_OFFLINE_DATA__',{get:()=>data,set(v){data=v;v.content['md/仓库/子目录/文档.md']=markdown;}});
      Object.defineProperty(window,'MD2WEB_NAVIGATION',{get:()=>nav,set(){}});
    },{markdown,nav:{folders:{'md/仓库':{href:'html/index_all.html',label:'仓库'},
      'md/仓库/子目录':{href:'html/index_使用说明.html',label:'子目录'}}}});
    const fileStart=pathToFileURL(path.join(root,'html/index_all.html')).href+'#/md/仓库/子目录/文档';
    for(const [label,file] of [['仓库','index_all.html'],['子目录','index_使用说明.html']]){
      await offline.goto(fileStart);
      await offline.locator('.workspace-breadcrumb a').filter({hasText:label}).click({delay:150});
      await offline.waitForURL(url=>decodeURIComponent(url.pathname).endsWith('/'+file)&&!url.hash);
    }
    await offline.close();
    const snapshot=await browser.newPage();
    await snapshot.goto(pathToFileURL(path.join(root,'html/index_使用说明.html')).href);
    await snapshot.locator('[data-folder-snapshot-counts]').waitFor();
    assert.match(await snapshot.locator('[data-folder-snapshot-counts]').innerText(), /子文件夹共 0 个 · 文档共 2 篇/);
    await snapshot.close();
    assert.deepEqual(errors,[]);
    console.log('HTTP + file breadcrumbs / previous SQLite + SVN revisions / folder totals: PASS');
  }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
