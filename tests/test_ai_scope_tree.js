const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/ai-assistant.js'), 'utf8');
const helpers = source.slice(source.indexOf('  function compactScopes('), source.indexOf('  function filterScopeTree('));
const {syncScopeTree, compactScopes} = new Function(helpers + ';return {syncScopeTree,compactScopes};')();
function node(checked, children=[], disabled=false) { return {_input:{checked,indeterminate:false,disabled},_children:children}; }
function host(nodes) { return {querySelectorAll(){return nodes;}}; }
test('a partially selected descendant propagates half-selection through every ancestor',()=>{
  const a=node(true), b=node(false), branch=node(true,[a,b]), root=node(true,[branch]);
  syncScopeTree(host([root,branch,a,b]));
  assert.equal(branch._input.indeterminate,true);
  assert.equal(root._input.indeterminate,true);
  assert.equal(root._input.checked,false);
});
test('selecting all enabled children checks ancestors; disabled folders do not block selection',()=>{
  const a=node(true), b=node(false,[],true), root=node(false,[a,b]);
  syncScopeTree(host([root,a,b]));
  assert.equal(root._input.checked,true);
  assert.equal(root._input.indeterminate,false);
});
test('clearing descendants clears every ancestor',()=>{
  const leaf=node(false), branch=node(true,[leaf]), root=node(true,[branch]);
  syncScopeTree(host([root,branch,leaf]));
  assert.equal(root._input.checked,false);
  assert.equal(branch._input.checked,false);
});
test('query scopes retain distinct repositories but remove selected descendants',()=>{
  assert.deepEqual(compactScopes(['code/a','code/a/src','code/ab/src','md/topic','md/topic/sub']),['code/a','code/ab/src','md/topic']);
});
