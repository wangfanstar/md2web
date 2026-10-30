const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// 执行原脚本并暴露内部函数；用小型 DOM 夹具驱动真实的配置序列化逻辑。
function load(options) {
  const opts = options || {};
  const listeners = {};
  const document = {
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
    querySelector: () => null,
    querySelectorAll: () => [],
    readyState: 'complete',
  };
  const saved = [];
  const window = {
    addEventListener: () => {},
    setInterval: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { protocol: 'http:' },
    AIAssistant: {
      getConfig: () => ({}),
      configure: config => { saved.push(config); return Promise.resolve(true); },
    },
  };
  if (opts.siteAuth) {
    window.SiteAuth = opts.siteAuth;
  }
  const context = vm.createContext({
    document, window, console,
    fetch: opts.fetch || (() => Promise.reject(new Error('no network'))),
  });
  const source = fs.readFileSync(path.join(__dirname, '../web/settings.js'), 'utf8');
  vm.runInContext(source.replace(
    '  window.Settings = { open: open, close: close, load: loadConfig, save: saveConfig };',
    '  globalThis.subject = { readConfig: readConfig, repositoryRow: repositoryRow, state: state,\n'
    + '    applyAiJson: applyAiJson, renderAiJson: renderAiJson, savePersonalAi: savePersonalAi };'
    + '\n  window.Settings = {};'), context);
  context.saved = saved;
  return context.subject;
}

// 构造 settings-dialog 的最小 DOM：仓库行 + [data-config]/[data-ai-chip] 字段 + AI JSON 文本框。
function overlay(rows, fields, extra) {
  const values = Object.assign({}, fields);
  const objects = {};
  Object.keys(values).forEach(key => {
    let raw = values[key];
    // 真实 DOM 里 input.value 总是字符串。
    objects[key] = {
      get value() { return raw; },
      set value(next) { raw = next === undefined || next === null ? '' : String(next); },
    };
  });
  const box = { value: (extra && extra.json) || '' };
  const status = { textContent: '', classList: { toggle: () => {} } };
  const repoRows = rows.map(item => ({
    querySelector: selector => {
      const match = selector.match(/^\[data-repo="([^"]+)"\]$/);
      if (!match) return null;
      const key = match[1];
      if (!(key in item)) return null;
      return { value: item[key] === undefined || item[key] === null ? '' : String(item[key]) };
    },
  }));
  return {
    querySelector: selector => {
      const configMatch = selector.match(/^\[(?:data-config|data-ai-chip)="([^"]+)"\]$/);
      if (configMatch) return objects[configMatch[1]] || null;
      if (selector === '[data-ai-json]') return box;
      if (selector === '[data-settings-status]') return status;
      return null;
    },
    querySelectorAll: selector => (selector === '.settings-repo-row' ? repoRows : []),
    box, status,
  };
}

function config(repositories) {
  return {
    auth: { url: 'https://svn.example.invalid/auth/', credential_group: 'default' },
    ai: { provider: 'openai', baseUrl: '', model: '', apiKey: '', useProxy: 'auto', contextChars: 6000 },
    sync: { credential_name: '', interval_seconds: 120 },
    repositories,
  };
}

test('saving from the settings dialog keeps local repositories intact', () => {
  const subject = load();
  subject.state.config = config([
    { id: 'local', mount: 'md/local', sourceMode: 'local', url: '', readOnly: true,
      allowCommit: false, group: '硬件', credential_group: 'default' },
    { id: 'svn', mount: 'md/svn', sourceMode: 'svn', url: 'https://svn.example.invalid/svn/x/',
      credential_group: 'default', syncIntervalSeconds: 300 },
  ]);
  subject.state.overlay = overlay([
    { id: 'local', mount: 'md/local', url: '', credential_group: 'default', syncIntervalSeconds: '' },
    { id: 'svn', mount: 'md/svn', url: 'https://svn.example.invalid/svn/x/', credential_group: 'default',
      syncIntervalSeconds: '300' },
  ], {});

  const result = subject.readConfig();
  const local = result.repositories.find(item => item.id === 'local');
  assert.equal(local.sourceMode, 'local');
  assert.equal(local.readOnly, true);
  assert.equal(local.allowCommit, false);
  assert.equal(local.group, '硬件');
  assert.equal(local.url, '');

  const svn = result.repositories.find(item => item.id === 'svn');
  assert.equal(svn.sourceMode, 'svn');
  assert.equal(svn.syncIntervalSeconds, 300);
});

test('symlink repositories keep their link target when the dialog saves', () => {
  const subject = load();
  subject.state.config = config([
    { id: 'link', mount: 'md/link', sourceMode: 'symlink', url: '',
      linkTarget: 'D:/repo/firmware', readOnly: true, allowCommit: false },
  ]);
  subject.state.overlay = overlay([
    { id: 'link', mount: 'md/link', url: '', credential_group: '', syncIntervalSeconds: '' },
  ], {});

  const result = subject.readConfig();
  assert.equal(result.repositories[0].sourceMode, 'symlink');
  assert.equal(result.repositories[0].linkTarget, 'D:/repo/firmware');
});

test('new repository rows default to SVN mode', () => {
  const subject = load();
  subject.state.config = config([]);
  subject.state.overlay = overlay([{ id: 'new', mount: 'md/new', url: '' }], {});

  const result = subject.readConfig();
  assert.equal(result.repositories[0].sourceMode, 'svn');
});

test('repository rows mark the source mode and disable SVN-only fields', () => {
  const subject = load();
  const html = subject.repositoryRow({ id: 'local', mount: 'md/local', sourceMode: 'local', url: '' });
  assert.match(html, /data-repo-mode="local"/);
  assert.match(html, /本地文件夹/);
  assert.match(html, /data-repo="url"[^>]*disabled/);

  const svn = subject.repositoryRow({ id: 'svn', mount: 'md/svn', sourceMode: 'svn', url: 'https://x/' });
  assert.doesNotMatch(svn, /data-repo="url"[^>]*disabled/);
});

test('AI 配置 JSON 可直接编辑并填回表单', () => {
  const subject = load();
  subject.state.config = config([]);
  subject.state.config.ai = { provider: 'openai', model: 'old', contextChars: 6000 };
  const view = overlay([], { 'ai.model': 'old', 'ai.contextChars': '6000' }, {
    json: JSON.stringify({ provider: 'openai', model: 'deepseek-v4-flash', temperature: 0.7,
      systemPrompt: '你是文档助手' }, null, 2),
  });
  subject.state.overlay = view;

  subject.applyAiJson();
  assert.equal(subject.state.config.ai.model, 'deepseek-v4-flash');
  assert.equal(subject.state.config.ai.temperature, 0.7);
  assert.equal(subject.state.config.ai.systemPrompt, '你是文档助手');
  assert.equal(view.querySelector('[data-config="ai.model"]').value, 'deepseek-v4-flash');
  // 表单保存时仍带上 JSON 里的额外字段
  const saved = subject.readConfig();
  assert.equal(saved.ai.temperature, 0.7);
  assert.equal(saved.ai.systemPrompt, '你是文档助手');
});

test('AI 配置 JSON 含未知字段时不应用', () => {
  const subject = load();
  subject.state.config = config([]);
  subject.state.config.ai = { provider: 'openai', model: 'old' };
  const view = overlay([], {}, { json: JSON.stringify({ model: 'x', evil: 1 }) });
  subject.state.overlay = view;

  subject.applyAiJson();
  assert.equal(subject.state.config.ai.model, 'old');
  assert.match(view.status.textContent, /未知字段/);
});

test('管理员保存我的 AI 设置时同时写入服务器配置 JSON', async () => {
  const calls = [];
  const subject = load({
    siteAuth: { isAdmin: () => true, csrfToken: () => 'csrf-1' },
    fetch: (url, options) => {
      calls.push({ url, options });
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ ok: true, ai: { model: 'deepseek-v4-flash' } }),
      });
    },
  });
  subject.state.config = config([]);
  const view = overlay([], {
    provider: 'openai', model: 'deepseek-v4-flash',
    baseUrl: 'https://api.example.invalid/v1', apiKey: 'sk-test',
    useProxy: 'auto', contextChars: '100000',
    sourcePath: 'D:/repo', writeServer: 'on',
  });
  view.querySelector = ((original) => selector => {
    const match = selector.match(/^\[data-ai-chip="([^"]+)"\]$/);
    if (match && match[1] === 'writeServer') {
      return { checked: true, value: 'on' };
    }
    return original(selector);
  })(view.querySelector);
  subject.state.overlay = view;

  subject.savePersonalAi();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '__admin/ai');
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[0].options.headers['X-CSRF-Token'], 'csrf-1');
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.model, 'deepseek-v4-flash');
  assert.equal(payload.baseUrl, 'https://api.example.invalid/v1');
  assert.match(view.status.textContent, /服务器配置/);
});

test('非管理员保存个人 AI 设置不修改公共 JSON', async () => {
  const calls = [];
  const subject = load({
    siteAuth: { isAdmin: () => false, csrfToken: () => 'csrf-1' },
    fetch: (url, options) => {
      calls.push({ url, options });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    },
  });
  subject.state.config = config([]);
  const view = overlay([], { model: 'deepseek-v4-flash' });
  subject.state.overlay = view;

  subject.savePersonalAi();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.length, 0);
  assert.match(view.status.textContent, /未写入服务器配置/);
});
