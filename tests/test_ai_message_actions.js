const test=require('node:test');
const assert=require('node:assert/strict');
const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../web/ai-assistant.js'),'utf8');
const helper=source.slice(source.indexOf('  function quoteMessage('),source.indexOf('  function addMessageActions('));
function setup(initial,confirmation=true){
  const input={value:initial,focus(){this.focused=true;},dispatchEvent(){this.changed=true;}};
  let asked=false;
  const actions=new Function('state','setStatus','confirm',helper+';return {quoteMessage,putMessageInInput};')({inputEl:input},()=>{},()=>{asked=true;return confirmation;});
  return {input,actions,asked:()=>asked};
}
test('quoting preserves draft and creates a multiline Markdown blockquote',()=>{
  const {input,actions}=setup('existing draft');
  actions.putMessageInInput('line one\nline two',true);
  assert.equal(input.value,'existing draft\n\n> line one\n> line two\n\n');
  assert.equal(input.focused,true);
  assert.equal(input.changed,true);
});
test('declining replacement preserves unsent text',()=>{
  const state=setup('keep me',false);
  state.actions.putMessageInInput('old message',false);
  assert.equal(state.input.value,'keep me');
  assert.equal(state.asked(),true);
});
test('returning a message to an empty composer needs no confirmation',()=>{
  const state=setup('');
  state.actions.putMessageInInput('original **Markdown**',false);
  assert.equal(state.input.value,'original **Markdown**');
  assert.equal(state.asked(),false);
  assert.equal(state.input.selectionEnd,state.input.value.length);
});
