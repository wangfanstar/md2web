const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { window: {}, document: { getElementById: () => null } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/reference-web.js'), 'utf8'), context);
const { search, excerpt } = context.window.ReferenceWeb;
const items = [
  { title: '接口指南', path: '协议/UART.html', text: '串口通信 速率设置' },
  { title: '参考', path: 'intro.htm', text: '操作说明' }
];
test('reference search combines title, filename and body terms case-insensitively', () => {
  assert.equal(search(items, 'uart 串口')[0], items[0]);
  assert.equal(search(items, '接口')[0], items[0]);
  assert.equal(search(items, '操作')[0], items[1]);
  assert.equal(search(items, '').length, 2);
  assert.equal(search(items, '串口 操作').length, 0);
});
test('reference snippets include the matching body text', () => {
  const text = '前'.repeat(250) + '串口通信' + '后'.repeat(250);
  assert.match(excerpt(text, '串口'), /串口通信/);
  assert.ok(excerpt(text, '').length <= 181);
});
