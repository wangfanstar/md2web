const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('reference folder link resolves beneath html despite the page base tag', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'reference_library.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'web', 'reference-library.js'), 'utf8');
  assert.match(html, /<base href="\.\.\/">/);
  assert.match(script, /var href = folder \? 'html\/reference_library\.html\?kind='/);
  assert.match(script, /: state\.kind \+ '\/' \+ item\.path\.split\('\/'\)/);
  assert.match(script, /new URL\('html\/reference_library\.html\?kind='/);
  const target = new URL('html/reference_library.html?kind=pdf&path=%E6%A0%87%E5%87%86%2F%E5%AD%90%E7%9B%AE%E5%BD%95', 'http://localhost:8882/');
  assert.equal(target.pathname, '/html/reference_library.html');
  assert.equal(target.searchParams.get('path'), '标准/子目录');
});
