const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('new repository rows read mount from the summary row before saving', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'web', 'md2web-config.js'), 'utf8');
  assert.match(script, /var mountField = row\.querySelector\('\[data-repo="mount"\]'\)/);
  assert.match(script, /mountField \? mountField\.value\.trim\(\) : ''\) \|\| pairField\(entry, 'mount'\)/);
});
