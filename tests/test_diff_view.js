const test = require('node:test');
const assert = require('node:assert/strict');
const diff = require('../web/diff-worker.js');
test('aligned diff reconstructs both texts, including repeated Chinese lines', () => {
  for (const [a,b] of [['','x'],['x',''],['甲\n乙\n甲','甲\n改\n甲'],['a\r\nb','a\nb'],['a\nb','b\na']]) {
    const result = diff.compare(a,b,{});
    assert.equal(result.rows.filter(r=>r.left!==null).map(r=>r.left).join('\n'), a.replace(/\r\n/g,'\n'));
    assert.equal(result.rows.filter(r=>r.right!==null).map(r=>r.right).join('\n'), b.replace(/\r\n/g,'\n'));
  }
});
test('whitespace option does not rewrite originals',()=>{
  const r=diff.compare('a  b','a b',{ignoreWhitespace:true});
  assert.equal(r.rows[0].kind,'equal'); assert.equal(r.rows[0].left,'a  b');
});
test('oversized inputs degrade without truncating source',()=>{
  assert.equal(diff.compare('x'.repeat(100),'y',{maxInteractiveBytes:50}).fallback,true);
});
