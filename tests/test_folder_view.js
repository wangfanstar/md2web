const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// 只加载 folder-view.js 的纯函数（右键菜单用它解析目标路径）。
function loadFolderView(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'folder-view.js'), 'utf8');
  const window = {
    $docsify: { repoList: [] },
    location: { hash: '#/' },
    addEventListener() {},
    setTimeout() {}
  };
  const document = {
    readyState: 'loading',
    addEventListener() {},
    querySelector: () => null,
    body: { classList: { add() {}, remove() {} } }
  };
  const context = vm.createContext({
    window, document, console, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => Promise.reject(new Error('not used')),
    ...overrides
  });
  vm.runInContext(source, context, { filename: 'folder-view.js' });
  return (overrides.window || window).FolderView;
}

test('create request refreshes session and uses the latest CSRF token', async () => {
  let refreshed = false;
  const requests = [];
  const window = {
    $docsify: {}, location: { protocol: 'http:' }, addEventListener() {}, setTimeout() {},
    SiteAuth: {
      refresh: async () => { refreshed = true; },
      isAuthenticated: () => true,
      csrfToken: () => refreshed ? 'new-token' : 'old-token'
    }
  };
  const view = loadFolderView({ window, fetch: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, result: { path: 'md/test/a.md' } }) };
  } });
  const result = await view.createEntry('md/test', 'document', ' a.MD ');
  assert.equal(result.path, 'md/test/a.md');
  assert.equal(requests[0].options.headers['X-CSRF-Token'], 'new-token');
  assert.equal(JSON.parse(requests[0].options.body).name, 'a.md');
});

test('create rejects invalid names before sending a write request', async () => {
  const view = loadFolderView();
  await assert.rejects(view.createEntry('md/test', 'document', '../a'), /名称/);
});

test('create surfaces server errors without hiding the reason', async () => {
  const window = {
    $docsify: {}, location: { protocol: 'http:' }, addEventListener() {}, setTimeout() {},
    SiteAuth: { isAuthenticated: () => true, csrfToken: () => 'token' }
  };
  const view = loadFolderView({ window, fetch: async () => ({
    ok: false, status: 409, json: async () => ({ ok: false, error: '同名目标已存在', code: 'entry_error' })
  }) });
  await assert.rejects(view.createEntry('md/test', 'document', 'a'), /同名目标已存在/);
});

test('expired login opens the login dialog without attempting a write', async () => {
  let opened = false;
  const window = {
    $docsify: {}, location: { protocol: 'http:' }, addEventListener() {}, setTimeout() {},
    SiteAuth: { isAuthenticated: () => false, openLogin: () => { opened = true; } }
  };
  const view = loadFolderView({ window });
  await assert.rejects(view.createEntry('md/test', 'document', 'a'), /名称已保留/);
  assert.equal(opened, true);
});

function fakeLink(href) {
  return { getAttribute: (name) => (name === 'href' ? href : null) };
}

test('document links resolve to the document path', () => {
  const view = loadFolderView();
  const node = {
    getAttribute: () => null,
    closest: (selector) => (selector === 'a[href*="md/"]' ? fakeLink('#/md/使用说明/快速开始') : null)
  };
  assert.equal(view.pathFromElement(node), 'md/使用说明/快速开始');
});

test('group labels resolve through data-folder instead of the first child document', () => {
  const view = loadFolderView();
  const node = {
    getAttribute: () => null,
    closest: (selector) => {
      if (selector === 'a[href*="md/"]') return null;
      if (selector === '[data-folder]') return { getAttribute: () => 'md/使用说明/子目录' };
      return null;
    }
  };
  assert.equal(view.pathFromElement(node), 'md/使用说明/子目录');
});

test('repository group anchors use their own data-folder', () => {
  const view = loadFolderView();
  const anchor = { getAttribute: (name) => (name === 'data-folder' ? 'md/硬件设计' : '#') };
  const node = {
    getAttribute: () => null,
    closest: (selector) => {
      if (selector === 'a[href*="md/"]') return null;
      if (selector === '[data-folder]') return anchor;
      return null;
    }
  };
  assert.equal(view.pathFromElement(node), 'md/硬件设计');
});

test('legacy sidebars without data-folder fall back to the first child document folder', () => {
  const view = loadFolderView();
  const node = {
    getAttribute: () => null,
    closest: (selector) => {
      if (selector === '.sidebar-nav li') {
        return { querySelector: () => fakeLink('#/md/硬件设计/时钟树设计') };
      }
      return null;
    }
  };
  assert.equal(view.pathFromElement(node), 'md/硬件设计');
});

test('empty groups without data-folder and without documents resolve to null', () => {
  const view = loadFolderView();
  const node = {
    getAttribute: () => null,
    closest: (selector) => (selector === '.sidebar-nav li' ? { querySelector: () => null } : null)
  };
  assert.equal(view.pathFromElement(node), null);
});

test('menu buttons keep working through data-path', () => {
  const view = loadFolderView();
  const node = {
    getAttribute: (name) => (name === 'data-path' ? 'md/软件工具链/编译工具链' : null),
    closest: () => null
  };
  assert.equal(view.pathFromElement(node), 'md/软件工具链/编译工具链');
});

test('empty folder state exposes direct create buttons', () => {
  const view = loadFolderView();
  const html = view.emptyStateHtml('md/test');
  assert.match(html, /该文件夹还没有文档/);
  assert.match(html, /data-folder-action="new-document"/);
  assert.match(html, /data-folder-action="new-folder"/);
  assert.match(html, /data-path="md\/test"/);
});

test('empty folder state hides create buttons for read-only repositories', () => {
  const view = loadFolderView();
  const html = view.emptyStateHtml('md/test', true);
  assert.doesNotMatch(html, /data-folder-action="new-document"/);
  assert.match(html, /只读/);
});

test('groupDocuments groups documents by parent folder in path order', () => {
  const view = loadFolderView();
  const sections = view.groupDocuments([
    { name: 'b.md', path: 'md/硬件设计/子目录/b.md', group: '硬件' },
    { name: 'a.md', path: 'md/硬件设计/a.md', group: '硬件' },
    { name: 'c.md', path: 'md/硬件设计/子目录/更深/c.md', group: '硬件' },
    { name: 'a2.md', path: 'md/硬件设计/子目录/a2.md', group: '硬件' }
  ]);
  assert.equal(sections.length, 3);
  assert.deepEqual(Array.from(sections, (section) => section.folder),
    ['md/硬件设计', 'md/硬件设计/子目录', 'md/硬件设计/子目录/更深']);
  assert.equal(sections[0].group, '硬件');
  assert.deepEqual(Array.from(sections[1].documents, (item) => item.name), ['a2.md', 'b.md']);
});

test('groupDocuments keeps documents without group info', () => {
  const view = loadFolderView();
  const sections = view.groupDocuments([{ name: 'a.md', path: 'md/其他/a.md' }]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].group, '');
  assert.equal(sections[0].folder, 'md/其他');
});
