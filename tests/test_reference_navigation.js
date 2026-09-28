const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('reference folder link resolves beneath html despite the page base tag', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'reference_library.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'web', 'reference-library.js'), 'utf8');
  assert.match(html, /<base href="\.\.\/">/);
  assert.match(html, /data-file multiple/);
  assert.match(html, /data-search/);
  assert.match(html, /lib\/reference-data\.js/);
  assert.match(script, /var href = folder \? 'html\/reference_library\.html\?kind='/);
  assert.match(script, /: sourceKind \+ '\/' \+ item\.path\.split\('\/'\)/);
  assert.match(script, /new URL\('html\/reference_library\.html\?kind='/);
  assert.match(script, /files\.forEach\(function \(file\) \{ form\.append\('file', file, file\.name\); \}\)/);
  assert.match(script, /payload\.error \|\| \('上传失败（HTTP ' \+ response\.status \+ '）'\)/);
  assert.match(script, /__references\/search\?q=/);
  assert.match(script, /sourceKind = item\.referenceKind \|\| state\.kind/);
  assert.match(script, /var searchSerial = 0/);
  assert.match(script, /window\.location\.protocol === 'file:'/);
  assert.match(script, /sizeLabel\(item\.size\)/);
  assert.match(script, /pageLabel\(item, folder\)/);
  const target = new URL('html/reference_library.html?kind=pdf&path=%E6%A0%87%E5%87%86%2F%E5%AD%90%E7%9B%AE%E5%BD%95', 'http://localhost:8882/');
  assert.equal(target.pathname, '/html/reference_library.html');
  assert.equal(target.searchParams.get('path'), '标准/子目录');
});

test('reference page keeps login fields beside the login action', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'reference_library.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'web', 'reference-library.js'), 'utf8');
  assert.match(html, /<form[^>]*data-auth-form[^>]*>[\s\S]*data-auth-username[\s\S]*data-auth-password[\s\S]*data-auth-login[\s\S]*<\/form>/);
  assert.match(script, /SiteAuth\.login\(username, password\)/);
});

test('PDF file links open in a new browser tab', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'web', 'reference-library.js'), 'utf8');
  assert.match(script, /var newTabAttr = folder \? '' : ' target="_blank" rel="noopener"'/);
  assert.match(script, /item\.ext !== '\.pdf'/);
  assert.doesNotMatch(script, /data-preview-file/);
});

test('Office file links open the local preview page in a new tab', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'web', 'reference-library.js'), 'utf8');
  const viewer = fs.readFileSync(path.join(__dirname, '..', 'web', 'reference_preview.html'), 'utf8');
  assert.match(script, /html\/reference_preview\.html\?kind=/);
  assert.match(script, /target="_blank" rel="noopener"/);
  assert.match(viewer, /lib\/reference-office\.bundle\.js/);
});
