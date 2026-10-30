const test=require('node:test');
const assert=require('node:assert/strict');
const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../web/ai-assistant.js'),'utf8');
const fn=source.slice(source.indexOf('  function historyAction('),source.indexOf('  function lastTurnIndex('));
const historyAction=new Function(fn+';return historyAction;')();
test('clicking a nested history title resolves its containing conversation',()=>{
  const target={closest(selector){return selector==='[data-ai-history-id]'?{getAttribute(){return 'saved-conversation';}}:null;}};
  assert.deepEqual(historyAction(target),{id:'saved-conversation'});
});
test('delete takes priority over selecting the containing history row',()=>{
  const target={closest(){return {getAttribute(){return 'deleted-conversation';}};}};
  assert.deepEqual(historyAction(target),{remove:'deleted-conversation'});
});
test('clicking outside history does not switch conversations',()=>{
  assert.deepEqual(historyAction({closest(){return null;}}),{});
});
