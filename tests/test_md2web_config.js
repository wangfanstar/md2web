const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// 执行原脚本，替换启动联网部分；用小型 DOM 夹具驱动真实的事件与序列化逻辑。
function page(items, repositories = []) {
  const listeners = {};
  const entries = items.map((item, index) => {
    const attrs = { 'data-pair': 'repo-' + index, 'data-name': item.name || '',
      'data-mount': item.mount || '', 'data-saved-id': item.id || '' };
    const fields = {};
    for (const key of ['id', 'mount', 'url', 'syncIntervalSeconds']) {
      fields[key] = { value: String(item[key] ?? ''), focus() { this.focused = true; } };
    }
    fields.svnEnabled = { checked: item.svn !== false };
    fields.allowCommit = { checked: item.allow !== false };
    const display = { textContent: '' };
    const cells = { '[data-repo-id-auto]': display, '[data-entry-cell]': {}, '[data-mode-cell]': {},
      '[data-health-badge]': {}, '[data-folder-group]': { value: '默认', setAttribute() {} } };
    const select = (selector, summary) => {
      const match = selector.match(/^\[data-repo="([^"]+)"\]$/);
      if (match) return (['mount', 'svnEnabled'].includes(match[1]) === summary) ? fields[match[1]] : null;
      return cells[selector] || null;
    };
    const summary = { getAttribute: key => attrs[key] || null, setAttribute: (key, val) => { attrs[key] = val; },
      removeAttribute: key => { delete attrs[key]; }, querySelector: s => select(s, true),
      closest: s => s === '[data-repo-row]' ? summary : null };
    const detail = { hidden: false, getAttribute: key => key === 'data-pair-detail' ? attrs['data-pair'] : null,
      querySelector: s => select(s, false), closest: s => s === '[data-pair-detail]' ? detail : null };
    return { summary, detail, fields, display };
  });
  const document = { addEventListener: (name, fn) => (listeners[name] ||= []).push(fn),
    querySelectorAll: selector => selector === '[data-repo-row]' ? entries.map(e => e.summary) : [],
    querySelector: selector => {
      const match = selector.match(/repo-(\d+)/);
      return match ? entries[Number(match[1])][selector.startsWith('[data-repo-row]') ? 'summary' : 'detail'] : null;
    } };
  const context = vm.createContext({ document, window: { location: { protocol: 'http:' }, confirm: () => true }, console });
  const source = fs.readFileSync(path.join(__dirname, '../web/md2web-config.js'), 'utf8');
  vm.runInContext(source.replace('  showPanels();\r\n  loadConfig();\r\n}());',
    '  globalThis.subject = { state, readRepos, pairField, repoRow, validateRepos, updateSummary };\r\n}());'), context);
  const subject = context.subject;
  subject.state.config = { repositories };
  subject.state.editable = true;
  return { ...subject, entries, click(action, index = 0) {
    const target = { getAttribute: () => action, closest: selector => selector === '[data-action]' ? target : entries[index].detail.closest(selector) };
    listeners.click.forEach(fn => fn({ target }));
  } };
}

test('new manual repository reads mount from summary and derives ID', () => {
  const p = page([{ mount: 'md/新目录', url: 'https://svn.example.com/docs' }]);
  const repo = p.readRepos()[0];
  assert.equal(repo.mount, 'md/新目录');
  assert.equal(repo.id, '新目录');
});

test('automatic IDs avoid saved IDs, normalized entry names and backup reserved ID', () => {
  const saved = { id: 'a-b', mount: 'md/saved' };
  const p = page([
    { name: 'a b', mount: 'md/a b' }, { name: 'a+b', mount: 'md/a+b' },
    { name: 'site-backup', mount: 'md/site-backup' }, { ...saved, name: 'saved' },
    { name: 'constructor', mount: 'md/constructor' }
  ], [saved]);
  const repos = p.readRepos();
  assert.equal(repos[3].id, 'a-b');
  assert.equal(new Set(repos.map(r => r.id)).size, repos.length);
  assert.notEqual(repos[2].id, 'site-backup');
  assert.equal(repos[4].id, 'constructor');
});

test('removing a mapping does not recreate it when saving', () => {
  const p = page([{ id: 'old-id', name: 'folder', mount: 'md/folder' }]);
  p.click('remove-repo');
  assert.equal(p.readRepos().length, 0);
});

test('SVN intervals reject negative and nonfinite values, blank and zero remain valid', () => {
  const repo = { id: 'r', sourceMode: 'svn', url: 'https://svn.example.com/r' };
  for (const syncIntervalSeconds of [-1, NaN, Infinity]) {
    assert.match(page([]).validateRepos([{ ...repo, syncIntervalSeconds }]), /频率/);
  }
  assert.equal(page([]).validateRepos([repo, { ...repo, syncIntervalSeconds: 0 }]), '');
});

test('saved ID survives source mode changes and local mode drops SVN fields', () => {
  const p = page([{ id: 'legacy', mount: 'md/new-name', svn: false, url: 'https://svn.example.com/r', syncIntervalSeconds: 30 }]);
  const repo = p.readRepos()[0];
  assert.equal(repo.id, 'legacy');
  assert.equal(repo.sourceMode, 'local');
  assert.equal(repo.url, '');
  assert.equal(repo.syncIntervalSeconds, undefined);
});

test('automatic IDs avoid the default sync credential reserved ID', () => {
  const p = page([{ name: '__default__', mount: 'md/__default__' }]);
  assert.notEqual(p.readRepos()[0].id, '__default__');
});

test('repository detail renders inline credential inputs and status', () => {
  const p = page([]);
  const html = p.repoRow({ id: 'legacy', mount: 'md/folder' }, null, 0);
  assert.match(html, /data-repo="credUsername"/);
  assert.match(html, /data-repo="credPassword"/);
  assert.match(html, /data-action="repo-credential"/);
  assert.match(html, /repo-credential-status/);
});

test('sync credentials are edited inline without browser prompts', () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/md2web-config.js'), 'utf8');
  assert.doesNotMatch(source, /window\.prompt/);
  for (const needle of ['saveRepoCredential', 'saveSiteCredential', 'saveDefaultCredential',
                        'data-action="default-credential"', '__admin/default-credential',
                        'data-site-credential']) {
    assert.ok(source.includes(needle), needle);
  }
});

test('repository detail keeps ID hidden and exposes only SVN address and interval', () => {
  const p = page([]);
  const html = p.repoRow({ id: 'legacy', mount: 'md/folder', url: 'https://svn.example.com/r' },
    { name: 'folder', path: 'md/folder' }, 0);
  assert.doesNotMatch(html, /仓库 ID（自动生成）/);
  assert.match(html, /data-repo="id"/);
  assert.match(html, /SVN 地址/);
  assert.match(html, /更新频率（秒）/);
});
