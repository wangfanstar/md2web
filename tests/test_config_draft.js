const test=require('node:test');
const assert=require('node:assert/strict');
const Draft=require('../web/config-draft.js');
test('draft retains hidden-tab edits and reverting clears dirty state',()=>{
  const d=new Draft({ai:{model:'old'},auth:{url:'a'}});
  d.update({ai:{model:'new'},auth:{url:'b'}});
  assert.equal(d.changes().length,2);
  d.update({ai:{model:'old'},auth:{url:'a'}});
  assert.equal(d.dirty(),false);
});
test('change review never exposes secrets and copies do not mutate baseline',()=>{
  const d=new Draft({ai:{apiKey:'original'},expectedConfigVersion:'one'});
  d.update({ai:{apiKey:'sensitive'},expectedConfigVersion:'two'});
  const changes=d.changes();assert.equal(changes.length,1);
  assert.ok(!JSON.stringify(changes).includes('sensitive'));
  const payload=d.value();payload.ai.apiKey='mutated';assert.equal(d.value().ai.apiKey,'sensitive');
});
test('failed saves leave current draft intact; reset explicitly discards edits',()=>{
  const d=new Draft({repositories:[{id:'stable',displayName:'old'}]});
  d.update({repositories:[{id:'stable',displayName:'new'}]});
  assert.ok(d.dirty());d.reset();assert.equal(d.value().repositories[0].displayName,'old');
});
