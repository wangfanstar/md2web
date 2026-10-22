const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadWorkspace(repoInfo, repoList) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'workspace.js'), 'utf8');
  const window = {
    __WORKSPACE_TEST__: true,
    location: { hash: '#/md/硬件设计/时钟树.md', protocol: 'file:' },
    $docsify: { repoInfo: repoInfo || {}, repoList: repoList || [] },
    addEventListener() {}
  };
  const document = { readyState: 'loading', addEventListener() {} };
  const context = vm.createContext({ window, document, console, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: 'workspace.js' });
  return window.__WORKSPACE_TEST_API__;
}

test('document update metadata includes plain author text and handles missing authors', () => {
  const api = loadWorkspace();
  assert.equal(api.updatedMetaText({updatedAt:'2026-10-22T01:02:03Z',source:'svn',author:'张三'}),
    '最后更新：2026-10-22 · 作者：张三（SVN 库）');
  assert.equal(api.updatedMetaText({updatedAt:'2026-10-22',source:'file'}),
    '最后更新：2026-10-22 · 作者：未知（本地文件）');
  assert.equal(api.updatedMetaText({updatedAt:'',author:'张三'}), '');
});

test('SVN controls identify root and nested repositories and show synchronization state', () => {
  const api = loadWorkspace({id: 'root', mount: 'md/A', url: 'https://svn.example/A', source_mode: 'svn'},
    [{id: 'nested', mount: 'md/A/B', url: 'https://svn.example/B', sourceMode: 'svn'}]);
  assert.equal(api.svnRepository('').id, 'root');
  assert.equal(api.svnRepository('md/A/B/file').id, 'nested');
  assert.equal(api.svnRepository('md/unrelated/file'), null);
  assert.match(api.syncDescription({intervalSeconds: 0, state: 'running'}), /关闭.*正在更新/);
  assert.match(api.syncDescription({intervalSeconds: 120, error: 'auth_failed'}), /120 秒.*auth_failed/);
});

test('SVN copy URL joins the configured repository URL and document path', () => {
  const api = loadWorkspace({ mount: 'md/硬件设计', url: 'https://svn.example/docs/' });
  assert.equal(
    api.svnUrlForRoute('md/硬件设计/时钟树.md'),
    'https://svn.example/docs/%E6%97%B6%E9%92%9F%E6%A0%91.md'
  );
});

test('SVN copy URL is empty for local repositories', () => {
  const api = loadWorkspace({}, [{ mount: 'md/硬件设计', url: '', sourceMode: 'local' }]);
  assert.equal(api.svnUrlForRoute('md/硬件设计/时钟树.md'), '');
});

test('SVN document routes are distinguished from repository entry pages', () => {
  const api = loadWorkspace({ mount: 'md/硬件设计', url: 'https://svn.example/docs/' });
  const repo = { mount: 'md/硬件设计', url: 'https://svn.example/docs/' };
  assert.equal(api.isSvnDocumentRoute('md/硬件设计/时钟树', repo), true);
  assert.equal(api.isSvnDocumentRoute('md/硬件设计/时钟树.md', repo), true);
  assert.equal(api.isSvnDocumentRoute('', repo), false);
  assert.equal(api.isSvnDocumentRoute('md/硬件设计', repo), false);
  assert.equal(api.isSvnDocumentRoute('md/硬件设计/', repo), false);
  assert.equal(api.isSvnDocumentRoute('md/其他/时钟树', repo), false);
  assert.equal(api.isSvnDocumentRoute('md/硬件设计/时钟树', null), false);
});

test('SVN copy restores the md suffix omitted by Docsify and excludes section queries', () => {
  const api = loadWorkspace({ mount: 'md/硬件设计', url: 'https://svn.example/docs/' });
  for (const route of ['md/硬件设计/接口 说明.v2', '#/md/硬件设计/接口 说明.v2?id=章节', 'md/硬件设计/接口 说明.v2.md']) {
    assert.equal(api.svnUrlForRoute(route), 'https://svn.example/docs/' + encodeURIComponent('接口 说明.v2.md'));
  }
});

test('SVN copy retains longest repository mapping and does not invent a document at its root', () => {
  const api = loadWorkspace({}, [
    { mount: 'md/docs', url: 'https://svn.example/root/' },
    { mount: 'md/docs/sub', url: 'https://svn.example/nested/' }
  ]);
  assert.equal(api.svnUrlForRoute('md/docs/sub/guide'), 'https://svn.example/nested/guide.md');
  assert.equal(api.svnUrlForRoute('md/docs/sub'), '');
});

test('document actions show on md pages but not on index entry/root views', () => {
  const api = loadWorkspace({});
  const plain = { querySelector: () => null };
  assert.equal(api.isDocumentView('md/硬件设计/时钟树', plain), true);
  assert.equal(api.isDocumentView('md/硬件设计/时钟树.md', plain), true);
  assert.equal(api.isDocumentView('', plain), false);
  assert.equal(api.isDocumentView('md/硬件设计', plain), false);
  assert.equal(api.isDocumentView('md/硬件设计/', plain), false);
  assert.equal(api.isDocumentView('md/硬件设计/子目录', { querySelector: () => ({}) }), false);
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'workspace.js'), 'utf8');
  assert.match(source, /isDocumentView/);
  for (const needle of ['data-workspace-source', 'data-workspace-edit', 'data-workspace-download-md']) {
    assert.ok(source.includes(needle), needle);
  }
});

test('sidebar numbering follows the md hierarchy (1 / 2 / 2.1 / 2.2)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'workspace.js'), 'utf8');
  function el(tag, className) {
    return {
      tagName: String(tag).toUpperCase(), children: [], parentNode: null, style: {},
      className: className || '',
      get textContent() { return this.children.map((c) => c.textContent || '').join(''); },
      set textContent(value) { this.children = [{ textContent: String(value), children: [] }]; },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      insertBefore(child, ref) {
        child.parentNode = this;
        const index = ref ? this.children.indexOf(ref) : -1;
        if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
        return child;
      },
      querySelectorAll(selector) {
        const out = [];
        String(selector).split(',').map((part) => part.trim().replace(/^:scope\s*>\s*/, '')).forEach((part) => {
          this.children.forEach((child) => {
            if (part.charAt(0) === '.') { if (String(child.className).split(' ').indexOf(part.slice(1)) !== -1) out.push(child); }
            else if (child.tagName === part.toUpperCase()) out.push(child);
          });
        });
        return out;
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      remove() {
        if (this.parentNode) {
          const index = this.parentNode.children.indexOf(this);
          if (index >= 0) this.parentNode.children.splice(index, 1);
        }
      }
    };
  }
  const documentLi = (text) => { const node = el('li'); const link = el('a'); link.textContent = text; node.appendChild(link); return node; };
  const folderLi = (text, list) => {
    const node = el('li');
    const strong = el('strong'); strong.textContent = text; node.appendChild(strong);
    node.appendChild(list);
    return node;
  };
  const subList = el('ul');
  subList.appendChild(documentLi('文档二'));
  subList.appendChild(documentLi('文档三'));
  const inner = el('ul');
  inner.appendChild(documentLi('文档一'));
  inner.appendChild(folderLi('子目录', subList));
  const topStrong = el('strong'); topStrong.textContent = '所有文档';
  const topLi = el('li');
  topLi.appendChild(topStrong);
  topLi.appendChild(inner);
  const root = el('ul');
  root.appendChild(topLi);
  const document = { readyState: 'loading', addEventListener() {}, querySelector: () => null,
    createElement: (tag) => el(tag), body: { classList: { add() {}, remove() {} } } };
  const window = { __WORKSPACE_TEST__: true, location: { hash: '#/', protocol: 'file:' }, $docsify: {}, addEventListener() {} };
  const context = vm.createContext({ window, document, console, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: 'workspace.js' });
  context.window.__WORKSPACE_TEST_API__.addTreeNumbers(root);
  const numbers = [];
  (function collect(node) {
    node.children.forEach((child) => {
      if (child.className === 'workspace-tree-index') numbers.push(child.textContent);
      collect(child);
    });
  })(root);
  // 顶层「所有文档」分组不出序号，子层级从 1 开始
  assert.deepEqual(numbers, ['1', '2', '2.1', '2.2']);
  assert.equal(topStrong.querySelector(':scope > .workspace-tree-index'), null);
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'workspace.css'), 'utf8');
  assert.match(css, /\.sidebar-nav \.workspace-tree-index/);
  assert.match(css, /body\.hide-heading-numbers \.sidebar-nav \.workspace-tree-index/);
});

test('sidebar reserves a fixed leading marker so same-level items align', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'web', 'workspace.js'), 'utf8');
  assert.match(js, /workspace-tree-marker/);
  assert.match(js, /function isGroupLabel/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'workspace.css'), 'utf8');
  assert.match(css, /\.sidebar-nav \.workspace-tree-marker/);
  // 展开箭头与前导标记同宽并留出相同间距
  assert.match(css, /\.sidebar-nav \.workspace-folder-toggle \{[^}]*margin-right: 4px/);
  assert.match(css, /\.sidebar-nav \.workspace-tree-marker \{[^}]*width: 16px/);
});

test('copied links keep readable Chinese and leave ASCII escapes alone', () => {
  const api = loadWorkspace({});
  assert.equal(
    api.readableLink('file:///C:/x/html/index_%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.html#/'),
    'file:///C:/x/html/index_使用说明.html#/'
  );
  assert.equal(
    api.readableLink('http://h/html/index_%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.html'
      + '#/md/%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E/%E5%BF%AB%E9%80%9F%E5%BC%80%E5%A7%8B'),
    'http://h/html/index_使用说明.html#/md/使用说明/快速开始'
  );
  assert.equal(api.readableLink('http://h/a%20b%23c'), 'http://h/a%20b%23c');
  assert.equal(api.readableLink('http://h/a%E4'), 'http://h/a%E4');
});

test('static entry-page links bypass the docsify router', () => {
  const api = loadWorkspace({});
  for (const href of ['html/index_使用说明.html', 'html/index_使用说明_子目录.html#/',
    'html/index_使用说明_子目录.html#repository-trash', 'lib/plot-playground.html', '/html/index_all.html']) {
    assert.equal(api.isStaticPageHref(href), true, href);
  }
  for (const href of ['#/md/使用说明/快速开始', 'md/使用说明/快速开始.md', '',
    'https://example.com/a.html', 'http://h/html/index_all.html', '//other.example/a.html', '#/md/a.html']) {
    assert.equal(api.isStaticPageHref(href), false, href);
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'workspace.js'), 'utf8');
  assert.match(source, /window\.addEventListener\('click', handleStaticPageClick, true\)/);
  assert.match(source, /window\.location\.href = anchor\.href/);
});
