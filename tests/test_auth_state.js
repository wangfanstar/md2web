const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function load(){
  const requests=[],events={},timers=[],timeouts=[];
  const window={location:{protocol:'http:',hash:'#/md/A/a'},addEventListener:(n,f)=>events[n]=f,setInterval:f=>{timers.push(f);return timers.length;},setTimeout:f=>{timeouts.push(f);return timeouts.length;},clearTimeout(){},clearInterval(){}};
  const document={readyState:'loading',body:null,hidden:false,addEventListener:(n,f)=>events[n]=f,dispatchEvent(){}};
  vm.runInNewContext(fs.readFileSync('web/auth.js','utf8'),{window,document,CustomEvent:function(){},localStorage:{setItem(){},removeItem(){}},fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve:(data,status=200)=>resolve({ok:status<400,status,json:async()=>data}),reject})),console});
  return {auth:window.SiteAuth,requests,events,timers,timeouts};
}
const session={authenticated:true,user:{username:'alice',role:'admin'},csrfToken:'token',features:{editDraft:true},site:{ai:{enabled:true}}};
test('failed session verification clears stale login and private state',async()=>{
  const t=load();let p=t.auth.refresh();t.requests.shift().resolve(session);await p;
  assert.equal(t.auth.isAuthenticated(),true);
  p=t.auth.refresh();const r=t.requests.shift();assert.equal(r.options.cache,'no-store');r.reject(new Error('server restarting'));await p;
  assert.equal(t.auth.isAuthenticated(),false);assert.equal(t.auth.csrfToken(),null);assert.equal(t.auth.aiDefaults(),null);assert.equal(t.auth.features().editDraft,false);
});
test('a late session response cannot undo logout',async()=>{
  const t=load();let p=t.auth.refresh();t.requests.shift().resolve(session);await p;
  const refresh=t.auth.refresh(),old=t.requests.shift();
  const logout=t.auth.logout();t.requests.shift().resolve({ok:true});await logout;
  old.resolve(session);await refresh;assert.equal(t.auth.isAuthenticated(),false);
});
test('unauthorized writes clear login immediately and trigger revalidation',async()=>{
  const t=load();let p=t.auth.refresh();t.requests.shift().resolve(session);await p;
  const handled=t.auth.handleResponse({status:401},{code:'login_required'});
  assert.equal(t.auth.isAuthenticated(),false);
  t.requests.shift().resolve({authenticated:false});await handled;assert.equal(t.auth.csrfToken(),null);
});
test('open pages revalidate on focus and periodically while visible',async()=>{
  const t=load();t.events.DOMContentLoaded();t.requests.shift().resolve({authenticated:false});await new Promise(r=>setImmediate(r));
  assert.ok(t.timers.length);t.events.focus();assert.equal(t.requests.length,1);t.requests.shift().resolve({authenticated:false});
});
test('login is not reported successful unless the session cookie is verified',async()=>{
  const t=load();const p=t.auth.login('alice','good');
  t.requests.shift().resolve({user:session.user,csrfToken:'token'});
  await new Promise(r=>setImmediate(r));t.requests.shift().resolve({authenticated:false});
  await assert.rejects(p,/登录会话未能确认/);assert.equal(t.auth.isAuthenticated(),false);
});
test('anonymous session response cannot retain old user or editing permissions',async()=>{
  const t=load();let p=t.auth.refresh();t.requests.shift().resolve(session);await p;
  p=t.auth.refresh();t.requests.shift().resolve({authenticated:false,features:{editDraft:true}});await p;
  assert.equal(t.auth.snapshot().user,null);assert.equal(t.auth.features().editDraft,false);
});
test('overlapping session checks share one request and cannot race the login result',async()=>{
  const t=load();const one=t.auth.refresh(),two=t.auth.refresh();assert.equal(t.requests.length,1);
  t.requests.shift().resolve(session);await Promise.all([one,two]);assert.equal(t.auth.isAuthenticated(),true);
});
test('a session check timeout clears login even if its old request later succeeds',async()=>{
  const t=load();let p=t.auth.refresh();t.requests.shift().resolve(session);await p;
  p=t.auth.refresh();const old=t.requests.shift();t.timeouts.pop()();await p;
  assert.equal(t.auth.isAuthenticated(),false);old.resolve(session);await new Promise(r=>setImmediate(r));assert.equal(t.auth.isAuthenticated(),false);
});
test('an old unauthorized write cannot cancel a login in progress',async()=>{
  const t=load();const p=t.auth.login('alice','good');await t.auth.handleResponse({status:401});
  t.requests.shift().resolve({user:session.user,csrfToken:'token'});await new Promise(r=>setImmediate(r));
  t.requests.shift().resolve(session);await p;assert.equal(t.auth.isAuthenticated(),true);
});
