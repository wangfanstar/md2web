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
