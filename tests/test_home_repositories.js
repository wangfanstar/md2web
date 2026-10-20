const test=require('node:test');
const assert=require('node:assert/strict');
const home=require('../web/home-repositories.js');
test('live folders absent from embedded snapshot are included with stable config identity',()=>{
  const items=home.fromLegacy([{path:'md/使用说明',name:'使用说明'},{path:'md/原有资料',name:'原有资料'}],
    [{id:'stable',mount:'md/原有资料',group:'原分组',displayName:'资料库',sourceMode:'svn'}]);
  assert.equal(items.length,2);assert.equal(items[0].id,'stable');
  const html=home.render(items);assert.match(html,/资料库/);assert.match(html,/原分组/);
  assert.match(html,/html\/index_all.html#\/md\//);
});
test('public cards escape text and reject arbitrary href schemes',()=>{
  const html=home.render([{id:'<script>',mount:'md/example',href:'javascript:alert(1)',group:'<b>group</b>'}]);
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('javascript:'));assert.ok(html.includes('&lt;b&gt;'));
});
