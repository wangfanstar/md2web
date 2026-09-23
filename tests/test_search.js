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
  const parsed = api.parseQuery('"DMA ctrl" -debug ready');
  assert.deepEqual(
    { positive: Array.from(parsed.positive), negative: Array.from(parsed.negative) },
    { positive: ['dma ctrl', 'ready'], negative: ['debug'] }
  );
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
  assert.deepEqual(Array.from(api.search('a.md'), (item) => item.path), ['guide/a.md']);
  assert.equal(api.search('b.md').length, 0);
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
  assert.deepEqual(Array.from(api.search('DMA ready -debug'), (item) => item.path), ['a.md']);
});

test('default search combines document names and full text with match groups', () => {
  const api = loadSearch();
  api.state.loaded = true;
  api.state.items = api.flattenIndex({
    '/md/a.md': {'/md/a.md': {route:'/md/a.md', pageTitle:'a.md', title:'DMA guide', body:'other text'}},
    '/md/b.md': {'/md/b.md': {route:'/md/b.md', pageTitle:'b.md', title:'Other', body:'DMA control text'}},
  });
  assert.equal(api.state.searchMode, 'both');
  const results = api.search('DMA');
  assert.deepEqual(Array.from(results, item => item.matchMode), ['file', 'full']);
});

test('repository filter exposes all repositories and current repository options', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'custom-search.js'), 'utf8');
  assert.doesNotMatch(source, /data-role="search-scope"/);
  assert.match(source, /全部仓库/);
  assert.match(source, /本仓库/);
});

test('reading route matching ignores the optional markdown extension', () => {
  const api = loadSearch();
  assert.equal(
    api.routeWithoutAnchor('/md/guide/a.md'),
    api.routeWithoutAnchor('/md/guide/a')
  );
});

test('repo filter limits results to selected repos (multi-select)', () => {
  const api = loadSearch();
  api.state.loaded = true;
  api.state.searchScope = 'all';
  api.state.searchMode = 'full';
  api.state.items = api.flattenIndex({
    '/md/硬件设计/a.md': {'/md/硬件设计/a.md': {route:'/md/硬件设计/a.md', pageTitle:'a.md', title:'A', body:'DMA control'}},
    '/md/验证指南/b.md': {'/md/验证指南/b.md': {route:'/md/验证指南/b.md', pageTitle:'b.md', title:'B', body:'DMA control'}},
    '/md/使用说明/c.md': {'/md/使用说明/c.md': {route:'/md/使用说明/c.md', pageTitle:'c.md', title:'C', body:'DMA control'}},
  });
  api.state.repoFilter = ['硬件设计'];
  assert.deepEqual(Array.from(api.search('DMA'), (item) => item.path), ['硬件设计/a.md']);
  api.state.repoFilter = ['硬件设计', '验证指南'];
  assert.deepEqual(
    Array.from(api.search('DMA'), (item) => item.path).sort(),
    ['硬件设计/a.md', '验证指南/b.md']
  );
  api.state.repoFilter = [];
  assert.equal(api.search('DMA').length, 3);
});

test('repo filter also applies to folder scope and file mode', () => {
  const api = loadSearch();
  api.state.loaded = true;
  api.state.searchScope = 'folder:/md';
  api.state.searchMode = 'file';
  api.state.items = api.flattenIndex({
    '/md/硬件设计/a.md': {'/md/硬件设计/a.md': {route:'/md/硬件设计/a.md', pageTitle:'a.md', title:'A', body:'x'}},
    '/md/验证指南/b.md': {'/md/验证指南/b.md': {route:'/md/验证指南/b.md', pageTitle:'b.md', title:'B', body:'x'}},
  });
  api.state.repoFilter = ['验证指南'];
  assert.deepEqual(Array.from(api.search('b.md'), (item) => item.path), ['验证指南/b.md']);
  assert.equal(api.search('a.md').length, 0);
});
