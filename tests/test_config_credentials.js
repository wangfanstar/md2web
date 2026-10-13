const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

for (const action of ['save', 'check']) {
test('new credentials replace the old error after ' + action, async () => {
  const calls = [];
  const events = {};
  const status = {};
  const badge = { textContent: '认证失败' };
  const inputs = {
    id: { value: 'repo' }, mount: { value: 'repo' },
    credUsername: { value: 'alice' }, credPassword: { value: ' pass & word ' }
  };
  const detail = { getAttribute: () => '1', querySelector: selector => {
    const match = selector.match(/data-repo="(.*?)"/);
    return match ? inputs[match[1]] : null;
  } };
  const summary = { closest: () => detail, querySelector: () => badge };
  const document = { addEventListener: (name, handler) => { events[name] = handler; }, querySelectorAll: () => [summary], querySelector: selector => {
    if (selector === '[data-status]') return status;
    return selector.startsWith('[data-pair-detail=') ? detail : summary;
  } };
  const window = {};
  let source = fs.readFileSync(path.join(__dirname, '../web/md2web-config.js'), 'utf8').replace(/\r\n/g, '\n');
  source = source.replace('  showPanels();\n  loadConfig();',
    '  window.testApi = { state: state, save: saveRepoCredential };');
  vm.runInNewContext(source, { window, document, fetch: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => url.endsWith('repo-health')
      ? { ok: true, reports: [{ id: 'repo', level: 'ok', status: '正常' }] } : { ok: true } };
  } });
  Object.assign(window.testApi.state, { editable: true, config: { repositories: [{ id: 'repo' }] } });
  if (action === 'save') await window.testApi.save({ closest: () => detail });
  else {
    const button = { getAttribute: () => 'health', closest: () => detail };
    events.click({ target: { closest: () => button } });
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(calls.map(item => item.url), ['__admin/repo-credential', '__admin/repo-health']);
  assert.equal(calls[0].body.password, ' pass & word ');
  assert.equal(inputs.credPassword.value, '');
  assert.match(badge.textContent, /正常/);
  assert.doesNotMatch(badge.textContent, /认证失败/);
});

}
