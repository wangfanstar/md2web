const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// 只加载 folder-view.js 的纯函数（右键菜单用它解析目标路径）。
function loadFolderView() {
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
    fetch: () => Promise.reject(new Error('not used'))
  });
  vm.runInContext(source, context, { filename: 'folder-view.js' });
  return window.FolderView;
}

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
