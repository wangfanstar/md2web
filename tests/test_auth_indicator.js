const test=require('node:test');
const assert=require('node:assert/strict');
const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../web/auth.js'),'utf8');
test('sidebar reconstruction restores the verified user without repeated DOM writes',()=>{
  function host(){const attrs={};return {writes:0,firstChild:null,getAttribute(k){return attrs[k];},setAttribute(k,v){attrs[k]=v;},set innerHTML(v){this.html=v;this.firstChild={};this.writes++;},querySelector(){return {addEventListener(){}};}};}
  let active=host();
  const state={authenticated:true,user:{username:'alice',role:'admin'}};
  const document={body:{}};
  const code=source.slice(source.indexOf('  function renderIndicator('),source.indexOf('  function escapeHtml('));
  const render=new Function('document','state','hostRow','removeFixedHost','fixedHost','isFileMode','escapeHtml','openLogin','logout',code+';return renderIndicator;')(document,state,()=>({querySelector:()=>active}),()=>{},()=>{},()=>false,String,()=>{},()=>{});
  render();assert.match(active.html,/alice/);assert.equal(active.writes,1);
  render();assert.equal(active.writes,1);
  active=host();render();assert.match(active.html,/alice/);assert.equal(active.writes,1);
  state.authenticated=false;render();assert.doesNotMatch(active.html,/alice/);
});
test('sidebar changes remain observed after initial startup',()=>{
  let callback,observed,renders=0;
  const window={MutationObserver:class{constructor(fn){callback=fn;}observe(target,options){observed=options;}}};
  const code=source.slice(source.indexOf('  function watchForSidebar('),source.indexOf('  function renderIndicator('));
  const watch=new Function('window','document','renderIndicator',code+';return watchForSidebar;')(window,{body:{}},()=>renders++);
  watch();assert.equal(observed.subtree,true);
  callback([{target:{closest:()=>({})},addedNodes:[],removedNodes:[]}]);
  callback([{target:{closest:()=>({})},addedNodes:[],removedNodes:[]}]);
  assert.equal(renders,2);
});
