const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadSearch() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'custom-search.js'), 'utf8');
  const window = {
    __CUSTOM_SEARCH_TEST__: true,
    location: { hash: '#/md/guide/a.md', protocol: 'file:' },
    $docsify: {},
    addEventListener() {}
  };
  const document = { readyState: 'loading', addEventListener() {} };
  const context = vm.createContext({ window, document, console, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: 'custom-search.js' });
  return window.__CUSTOM_SEARCH_TEST_API__;
}

test('query parser supports phrases and exclusions', () => {
  const api = loadSearch();
  assert.deepEqual(api.parseQuery('"DMA ctrl" -debug ready'), {
    positive: ['dma ctrl', 'ready'],
    negative: ['debug']
  });
});

test('search includes code fences but does not treat code headings as sections', () => {
  const api = loadSearch();
  const page = api.buildSearchPage('/md/guide/a.md', '# Intro\n```c\n# code_heading\nDMA_CTRL = 1\n```\ntext', 4);
  const entries = Object.values(page);
  assert.equal(entries.length, 1);
  assert.match(entries[0].body, /DMA_CTRL/);
  assert.doesNotMatch(entries[0].title, /code_heading/);
});

test('search applies exact folder boundary and file mode', () => {
  const api = loadSearch();
  api.state.loaded = true;
  api.state.searchScope = 'folder:/md/guide';
  api.state.searchMode = 'file';
  api.state.items = api.flattenIndex({
    '/md/guide/a.md': {'/md/guide/a.md': {route:'/md/guide/a.md', pageTitle:'a.md', title:'A', body:'target'}},
    '/md/guides/b.md': {'/md/guides/b.md': {route:'/md/guides/b.md', pageTitle:'b.md', title:'B', body:'target'}},
  });
  assert.deepEqual(api.search('a.md').map(item => item.path), ['guide/a.md']);
  assert.deepEqual(api.search('b.md'), []);
});

test('full mode uses AND and excludes matching documents', () => {
  const api = loadSearch();
  api.state.loaded = true;
  api.state.searchScope = 'all';
  api.state.searchMode = 'full';
  api.state.items = api.flattenIndex({
    '/md/a.md': {'/md/a.md': {route:'/md/a.md', pageTitle:'a.md', title:'A', body:'DMA control ready'}},
    '/md/b.md': {'/md/b.md': {route:'/md/b.md', pageTitle:'b.md', title:'B', body:'DMA debug ready'}},
  });
  assert.deepEqual(api.search('DMA ready -debug').map(item => item.path), ['a.md']);
});
