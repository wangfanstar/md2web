const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadSearch(pathname = '/html/index_all.html') {
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'custom-search.js'), 'utf8');
  const window = {
    __CUSTOM_SEARCH_TEST__: true,
    location: { hash: '#/md/guide/a.md', pathname, protocol: 'file:' },
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
  assert.match(source, /data-repo-name/);
  assert.match(source, /data-role="repo-current"/);
  assert.doesNotMatch(source, /type="radio" name="search-repo"/);
});

test('refreshing the merged page fetches the generated README under html', () => {
  const api = loadSearch();
  assert.equal(api.routeToResource('/'), 'html/README.md');
  assert.equal(api.routeToResource('/md/guide/a.md'), 'md/guide/a.md');
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

test('all repositories preset checks every repository in the menu', () => {
  const api = loadSearch();
  api.state.index = {
    '/md/硬件设计/a.md': {},
    '/md/验证指南/b.md': {},
  };
  api.selectRepoPreset('all');
  assert.deepEqual(Array.from(api.state.repoFilter).sort(), ['硬件设计', '验证指南'].sort());
  const list = { innerHTML: '' };
  const host = { querySelector(selector) {
    if (selector === '[data-role="repo-list"]') return list;
    if (selector === '[data-role="repo-label"]') return { textContent: '' };
    if (selector === '[data-role="repo-toggle"]') return { classList: { toggle() {} } };
    return null;
  } };
  api.renderRepoMenu(host);
  assert.equal((list.innerHTML.match(/ checked/g) || []).length, 2);
});

test('current repository preset checks only the repository on an encoded entry page', () => {
  const api = loadSearch('/html/index_%E7%A1%AC%E4%BB%B6%E8%AE%BE%E8%AE%A1.html');
  api.state.index = {
    '/md/硬件设计/a.md': { site: 'html/index_硬件设计.html', '/md/硬件设计/a.md': { route: '/md/硬件设计/a.md', body: 'DMA' } },
    '/md/验证指南/b.md': { site: 'html/index_验证指南.html', '/md/验证指南/b.md': { route: '/md/验证指南/b.md', body: 'DMA' } },
  };
  api.state.items = api.flattenIndex(api.state.index);
  api.selectRepoPreset('current');
  assert.deepEqual(Array.from(api.state.repoFilter), ['硬件设计']);
  const list = { innerHTML: '' };
  const host = { querySelector(selector) {
    if (selector === '[data-role="repo-list"]') return list;
    if (selector === '[data-role="repo-label"]') return { textContent: '' };
    if (selector === '[data-role="repo-toggle"]') return { classList: { toggle() {} } };
    return null;
  } };
  api.renderRepoMenu(host);
  assert.match(list.innerHTML, /data-repo-name="硬件设计" checked/);
  assert.doesNotMatch(list.innerHTML, /data-repo-name="验证指南" checked/);
});

test('refreshing the search index retains entry pages for the current repository preset', () => {
  const api = loadSearch('/html/index_%E7%A1%AC%E4%BB%B6%E8%AE%BE%E8%AE%A1.html');
  api.state.index = {
    '/md/硬件设计/a.md': { site: 'html/index_硬件设计.html' },
  };
  const refreshed = api.buildSearchIndex(
    { 'md/硬件设计/a.md': '# A\nDMA' },
    ['/md/硬件设计/a.md']
  );
  assert.equal(refreshed['/md/硬件设计/a.md'].site, 'html/index_硬件设计.html');
});
