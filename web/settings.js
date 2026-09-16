(function () {
  'use strict';

  var state = { overlay: null, config: null, busy: false };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function auth() {
    return window.SiteAuth || null;
  }

  function snapshot() {
    var siteAuth = auth();
    return siteAuth && siteAuth.snapshot ? siteAuth.snapshot() : { available: false, fileMode: false, authenticated: false };
  }

  function api(path, options) {
    var siteAuth = auth();
    var headers = Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {});
    if (siteAuth && siteAuth.csrfToken()) {
      headers['X-CSRF-Token'] = siteAuth.csrfToken();
    }
    return fetch(path, Object.assign({}, options, { headers: headers })).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok || payload.ok === false) {
          var error = new Error(payload.error || ('HTTP ' + response.status));
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    });
  }

  function setStatus(text, isError) {
    var element = state.overlay && state.overlay.querySelector('[data-settings-status]');
    if (element) {
      element.textContent = text || '';
      element.classList.toggle('is-error', !!isError);
    }
  }

  // ---------- 表单 ----------

  function repositoryRow(repo) {
    var item = repo || { id: '', mount: '', url: '' };
    return [
      '<div class="settings-repo-row">',
      '<input type="text" data-repo="id" placeholder="id（如 hardware）" value="' + escapeHtml(item.id) + '">',
      '<input type="text" data-repo="mount" placeholder="docs 下的目录（如 md/硬件设计）" value="' + escapeHtml(item.mount) + '">',
      '<input type="text" data-repo="url" placeholder="SVN 地址 https://…" value="' + escapeHtml(item.url) + '">',
      '<button type="button" data-settings-action="remove-repo" title="删除">×</button>',
      '</div>'
    ].join('');
  }

  function providerOptions(selected) {
    var providers = (window.AIAssistant && window.AIAssistant.providers) || {};
    return Object.keys(providers).map(function (name) {
      return '<option value="' + name + '"' + (name === selected ? ' selected' : '') + '>'
        + escapeHtml(providers[name].label || name) + '</option>';
    }).join('');
  }

  function personalAiSection() {
    if (!(window.AIAssistant && window.AIAssistant.getConfig)) {
      return '';
    }
    var config = window.AIAssistant.getConfig() || {};
    return [
      '<section class="settings-section">',
      '<h4>AI 助手（我的设置，仅本机浏览器）</h4>',
      '<p class="settings-note">接口与 Key 只保存在浏览器 localStorage；「参考源码路径」会随提问发给模型，便于引用代码库中的位置。</p>',
      '<div class="settings-grid">',
      '<label>服务商<select data-ai-chip="provider">' + providerOptions(config.provider) + '</select></label>',
      '<label>模型<input type="text" data-ai-chip="model" placeholder="如 deepseek-chat" value="' + escapeHtml(config.model || '') + '"></label>',
      '</div>',
      '<label>接口地址<input type="text" data-ai-chip="baseUrl" placeholder="https://api.deepseek.com/chat/completions" value="' + escapeHtml(config.baseUrl || '') + '"></label>',
      '<div class="settings-grid">',
      '<label>API Key<input type="password" data-ai-chip="apiKey" autocomplete="off" placeholder="仅保存在本机" value="' + escapeHtml(config.apiKey || '') + '"></label>',
      '<label>请求方式<select data-ai-chip="useProxy">'
        + '<option value="auto"' + (config.useProxy === 'auto' ? ' selected' : '') + '>自动</option>'
        + '<option value="always"' + (config.useProxy === 'always' ? ' selected' : '') + '>始终走本机代理</option>'
        + '<option value="never"' + (config.useProxy === 'never' ? ' selected' : '') + '>只允许直连</option>'
        + '</select></label>',
      '<label>资料上限（字符）<input type="number" step="500" min="1000" data-ai-chip="contextChars" value="' + escapeHtml(String(config.contextChars || 6000)) + '"></label>',
      '</div>',
      '<label>参考源码路径<input type="text" data-ai-chip="sourcePath" placeholder="如 D:/repo/firmware 或 /srv/src/project（可选）" value="' + escapeHtml(config.sourcePath || '') + '"></label>',
      '<div class="ai-scope-head"><strong>资料范围</strong><span>勾选后 AI 只在所选范围检索</span>'
        + '<button type="button" data-settings-action="scopeAll">全选</button>'
        + '<button type="button" data-settings-action="scopeNone">全不选</button></div>',
      '<div class="ai-scope-tree" data-personal-scope>正在加载文档索引…</div>',
      '<div class="settings-row-actions"><button type="button" data-settings-action="save-personal-ai">保存我的 AI 设置</button></div>',
      '</section>'
    ].join('');
  }

  function renderForm() {
    var overlay = state.overlay;
    var body = overlay.querySelector('[data-settings-body]');
    var siteAuth = auth();
    var info = snapshot();

    if (info.fileMode) {
      body.innerHTML = personalAiSection()
        + '<section class="settings-section"><h4>服务端设置</h4>'
        + '<p class="settings-note">离线浏览（file://）为只读模式，无法修改服务端配置。请通过'
        + ' <code>python serve.py</code> 启动认证服务后访问。</p></section>';
      overlay.querySelector('[data-settings-save]').hidden = true;
      renderPersonalScope();
      return;
    }
    if (!info.available) {
      body.innerHTML = personalAiSection()
        + '<section class="settings-section"><h4>服务端设置</h4>'
        + '<p class="settings-note">当前是只读预览模式：服务端配置需要认证服务。</p>'
        + '<ol class="settings-steps">'
        + '<li><code>python -m pip install -r server/requirements.txt</code></li>'
        + '<li><code>python serve.py</code>（配置不存在会自动生成）</li>'
        + '<li>刷新页面后在本窗口用管理员账号登录，填写 SVN 认证路径与仓库映射</li>'
        + '</ol>'
        + '<p class="settings-note">默认管理员账号：<code>admin / admin</code>（首次登录后请尽快修改密码）。</p></section>';
      overlay.querySelector('[data-settings-save]').hidden = true;
      renderPersonalScope();
      return;
    }
    if (!(siteAuth && siteAuth.isAdmin())) {
      body.innerHTML = personalAiSection()
        + '<section class="settings-section"><h4>服务端设置（管理员）</h4>'
        + '<p class="settings-note">SVN 认证路径、仓库映射与全站 AI 默认值需要管理员账号登录。</p>'
        + '<div class="settings-row-actions"><button type="button" data-settings-action="open-login">登录（本机管理员或 SVN 账号）</button></div>'
        + '<p class="settings-note">默认管理员账号 <code>admin / admin</code>（本机账号，仅本地编辑；合入 SVN 时再提供 SVN 账号）。</p></section>';
      overlay.querySelector('[data-settings-save]').hidden = true;
      renderPersonalScope();
      return;
    }

    var config = state.config || {};
    var authConfig = config.auth || {};
    var ai = config.ai || {};
    var sync = config.sync || {};
    body.innerHTML = personalAiSection() + [
      '<section class="settings-section">',
      '<h4>SVN 认证路径</h4>',
      '<p class="settings-note">必须是<b>强制账号密码认证</b>的 SVN 路径（允许匿名访问的路径会被拒绝）。例如只读的 <code>/svn/accounts/auth-check/</code>。</p>',
      '<label>认证路径 URL<input type="text" data-config="auth.url" placeholder="https://svn.example.com/svn/accounts/auth-check/" value="' + escapeHtml(authConfig.url || '') + '"></label>',
      '<div class="settings-grid">',
      '<label>凭据分组<input type="text" data-config="auth.credential_group" value="' + escapeHtml(authConfig.credential_group || '') + '"></label>',
      '<label>会话时长（小时）<input type="number" step="1" min="1" data-config="auth.session_hours" value="' + escapeHtml(String(authConfig.session_hours || 8)) + '"></label>',
      '<label>闲置超时（分钟）<input type="number" step="5" min="5" data-config="auth.idle_minutes" value="' + escapeHtml(String(authConfig.idle_minutes || 30)) + '"></label>',
      '</div>',
      '<div class="settings-row-actions"><button type="button" data-settings-action="test-auth">测试认证路径</button></div>',
      '</section>',
      '<section class="settings-section">',
      '<h4>仓库映射（docs 目录 ↔ SVN）</h4>',
      '<p class="settings-note">按目录段最长前缀匹配；嵌套目录优先匹配更具体的挂载点。</p>',
      '<div data-settings-repos>' + (config.repositories || []).map(repositoryRow).join('') + '</div>',
      '<div class="settings-row-actions"><button type="button" data-settings-action="add-repo">+ 添加映射</button></div>',
      '</section>',
      '<section class="settings-section">',
      '<h4>AI 助手（全站默认值）</h4>',
      '<p class="settings-note">这里配置的值会下发给所有登录用户；未填写的项沿用各人浏览器中的本地配置。API Key 建议使用团队内共享的低权限 Key。</p>',
      '<div class="settings-grid">',
      '<label>服务商<select data-config="ai.provider">' + providerOptions(ai.provider) + '</select></label>',
      '<label>模型<input type="text" data-config="ai.model" placeholder="如 deepseek-chat" value="' + escapeHtml(ai.model || '') + '"></label>',
      '</div>',
      '<label>接口地址<input type="text" data-config="ai.baseUrl" placeholder="https://api.deepseek.com/chat/completions" value="' + escapeHtml(ai.baseUrl || '') + '"></label>',
      '<div class="settings-grid">',
      '<label>API Key<input type="password" data-config="ai.apiKey" autocomplete="off" placeholder="可留空" value="' + escapeHtml(ai.apiKey || '') + '"></label>',
      '<label>请求方式<select data-config="ai.useProxy">'
        + '<option value="auto"' + (ai.useProxy === 'auto' ? ' selected' : '') + '>自动</option>'
        + '<option value="always"' + (ai.useProxy === 'always' ? ' selected' : '') + '>始终走本机代理</option>'
        + '<option value="never"' + (ai.useProxy === 'never' ? ' selected' : '') + '>只允许直连</option>'
        + '</select></label>',
      '<label>资料上限（字符）<input type="number" step="500" min="1000" data-config="ai.contextChars" value="' + escapeHtml(String(ai.contextChars || 6000)) + '"></label>',
      '</div>',
      '<label>参考源码路径<input type="text" data-config="ai.sourcePath" placeholder="如 D:/repo/firmware（可选，下发所有用户）" value="' + escapeHtml(ai.sourcePath || '') + '"></label>',
      '</section>',
      '<section class="settings-section">',
      '<h4>修改管理员密码</h4>',
      '<div class="settings-grid">',
      '<label>当前密码<input type="password" data-admin="current" autocomplete="off"></label>',
      '<label>新密码<input type="password" data-admin="password" autocomplete="off" placeholder="至少 5 位"></label>',
      '</div>',
      '<div class="settings-row-actions"><button type="button" data-settings-action="change-password">修改密码</button></div>',
      '</section>',
      '<section class="settings-section">',
      '<h4>其他</h4>',
      '<div class="settings-grid">',
      '<label>同步凭据环境变量<input type="text" data-config="sync.credential_name" placeholder="如 MD2WEB_SVN_READONLY" value="' + escapeHtml(sync.credential_name || '') + '"></label>',
      '<label>检查间隔（秒）<input type="number" step="10" min="10" data-config="sync.interval_seconds" value="' + escapeHtml(String(sync.interval_seconds || 120)) + '"></label>',
      '</div>',
      '</section>'
    ].join('');
    overlay.querySelector('[data-settings-save]').hidden = false;
    renderPersonalScope();
  }

  function personalAiConfig() {
    return (window.AIAssistant && window.AIAssistant.getConfig && window.AIAssistant.getConfig()) || { scope: [] };
  }

  function renderPersonalScope() {
    var host = state.overlay && state.overlay.querySelector('[data-personal-scope]');
    if (!host || !(window.AIAssistant && window.AIAssistant.scopeTree)) {
      return;
    }
    var scope = personalAiConfig().scope || [];
    window.AIAssistant.scopeTree().then(function (tree) {
      if (!tree || !tree.length) {
        host.textContent = '没有可用文档';
        return;
      }
      host.innerHTML = tree.map(function (folder) {
        var checked = scope.indexOf(folder.prefix) >= 0;
        var pages = folder.pages.map(function (page) {
          var pageChecked = checked || scope.indexOf(page.route) >= 0;
          return '<label class="ai-scope-page" title="' + escapeHtml(page.route) + '">'
            + '<input type="checkbox" data-personal-scope-value="' + escapeHtml(page.route) + '"' + (pageChecked ? ' checked' : '') + '>'
            + '<span>' + escapeHtml(page.label) + (page.upload ? '（上传）' : '') + '</span></label>';
        }).join('');
        return '<details class="ai-scope-folder"' + (checked ? ' open' : '') + '>'
          + '<summary><label><input type="checkbox" data-personal-scope-value="' + escapeHtml(folder.prefix) + '"' + (checked ? ' checked' : '') + '><span>' + escapeHtml(folder.label) + '</span></label></summary>'
          + pages + '</details>';
      }).join('');
    }).catch(function (error) {
      host.textContent = '读取文档索引失败：' + error.message;
    });
  }

  function readPersonalAi() {
    var overlay = state.overlay;
    function field(name) {
      var input = overlay.querySelector('[data-ai-chip="' + name + '"]');
      return input ? input.value.trim() : '';
    }
    return {
      provider: field('provider') || 'openai',
      baseUrl: field('baseUrl'),
      model: field('model'),
      apiKey: field('apiKey'),
      useProxy: field('useProxy') || 'auto',
      contextChars: Number(field('contextChars')) || 6000,
      sourcePath: field('sourcePath')
    };
  }

  function savePersonalAi() {
    if (!(window.AIAssistant && window.AIAssistant.configure)) {
      return;
    }
    var patch = readPersonalAi();
    window.AIAssistant.configure(patch);
    setStatus('已保存本机 AI 设置' + (patch.sourcePath ? '（参考源码路径：' + patch.sourcePath + '）' : ''));
  }

  function updatePersonalScope(scopeValue, checked) {
    var scope = (personalAiConfig().scope || []).filter(function (item) { return item !== scopeValue; });
    if (checked) {
      scope.push(scopeValue);
    }
    window.AIAssistant.configure({ scope: scope });
    renderPersonalScope();
  }

  function readConfig() {
    var overlay = state.overlay;
    var config = JSON.parse(JSON.stringify(state.config || {}));
    function field(name) {
      var input = overlay.querySelector('[data-config="' + name + '"]');
      return input ? input.value.trim() : '';
    }
    config.auth = config.auth || {};
    config.auth.url = field('auth.url');
    config.auth.credential_group = field('auth.credential_group') || 'default';
    config.auth.session_hours = Number(field('auth.session_hours')) || 8;
    config.auth.idle_minutes = Number(field('auth.idle_minutes')) || 30;
    config.ai = config.ai || {};
    config.ai.provider = field('ai.provider') || 'openai';
    config.ai.baseUrl = field('ai.baseUrl');
    config.ai.model = field('ai.model');
    config.ai.apiKey = field('ai.apiKey');
    config.ai.useProxy = field('ai.useProxy') || 'auto';
    config.ai.contextChars = Number(field('ai.contextChars')) || 6000;
    config.sync = config.sync || {};
    config.sync.credential_name = field('sync.credential_name');
    config.sync.interval_seconds = Number(field('sync.interval_seconds')) || 120;
    config.repositories = Array.prototype.slice.call(overlay.querySelectorAll('.settings-repo-row')).map(function (row) {
      return {
        id: row.querySelector('[data-repo="id"]').value.trim(),
        mount: row.querySelector('[data-repo="mount"]').value.trim(),
        url: row.querySelector('[data-repo="url"]').value.trim()
      };
    }).filter(function (repo) { return repo.id || repo.mount || repo.url; });
    return config;
  }

  function loadConfig() {
    setStatus('正在读取配置…');
    return api('__config').then(function (payload) {
      state.config = payload.config;
      renderForm();
      setStatus('');
      return payload;
    }).catch(function (error) {
      setStatus('读取配置失败：' + error.message, true);
    });
  }

  function saveConfig() {
    if (state.busy) {
      return;
    }
    var payload = readConfig();
    state.busy = true;
    setStatus('正在保存并应用…');
    api('__config', { method: 'PUT', body: JSON.stringify(payload) }).then(function (result) {
      state.config = result.config;
      var siteAuth = auth();
      if (siteAuth && siteAuth.refresh) {
        siteAuth.refresh();
      }
      renderForm();
      setStatus('已保存并生效' + (result.authConfigured ? '：SVN 登录已可用' : '：SVN 认证路径仍为空'));
    }).catch(function (error) {
      setStatus('保存失败：' + error.message, true);
    }).then(function () {
      state.busy = false;
    });
  }

  function testAuth() {
    var overlay = state.overlay;
    var url = overlay.querySelector('[data-config="auth.url"]').value.trim();
    setStatus('正在测试认证路径…');
    api('__config/test-auth', { method: 'POST', body: JSON.stringify({ url: url }) }).then(function (payload) {
      setStatus('认证路径可用：' + (payload.result.message || '可以登录'));
    }).catch(function (error) {
      setStatus('认证路径不可用：' + error.message, true);
    });
  }

  function changePassword() {
    var overlay = state.overlay;
    var current = overlay.querySelector('[data-admin="current"]').value;
    var next = overlay.querySelector('[data-admin="password"]').value;
    setStatus('正在修改密码…');
    api('__admin/password', { method: 'POST', body: JSON.stringify({ current: current, password: next }) }).then(function () {
      overlay.querySelector('[data-admin="current"]').value = '';
      overlay.querySelector('[data-admin="password"]').value = '';
      setStatus('管理员密码已修改');
    }).catch(function (error) {
      setStatus('修改密码失败：' + error.message, true);
    });
  }

  // ---------- 界面 ----------

  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.className = 'settings-dialog';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', '服务设置');
    overlay.innerHTML = [
      '<div class="settings-backdrop" data-settings-close></div>',
      '<section class="settings-panel">',
      '<header class="settings-head">',
      '<span class="settings-title">服务设置</span>',
      '<span class="settings-badge" data-settings-badge></span>',
      '<span class="settings-spacer"></span>',
      '<button type="button" data-settings-action="reload">重新读取</button>',
      '<button type="button" data-settings-save>保存配置</button>',
      '<button type="button" data-settings-close>关闭</button>',
      '</header>',
      '<div class="settings-body" data-settings-body></div>',
      '<div class="settings-status" data-settings-status></div>',
      '</section>'
    ].join('');
    document.body.appendChild(overlay);
    state.overlay = overlay;
    bindOverlay();
  }

  function bindOverlay() {
    var overlay = state.overlay;
    overlay.addEventListener('click', function (event) {
      var target = event.target;
      var action = target.getAttribute && target.getAttribute('data-settings-action');
      if (target.hasAttribute && target.hasAttribute('data-settings-close')) {
        close();
        return;
      }
      if (action === 'open-login') {
        close();
        if (window.SiteAuth) {
          window.SiteAuth.openLogin();
        }
      } else if (action === 'save-personal-ai') {
        savePersonalAi();
      } else if (action === 'scopeAll') {
        if (window.AIAssistant && window.AIAssistant.scopeTree) {
          window.AIAssistant.scopeTree().then(function (tree) {
            window.AIAssistant.configure({ scope: tree.map(function (folder) { return folder.prefix; }) });
            renderPersonalScope();
          });
        }
      } else if (action === 'scopeNone') {
        window.AIAssistant.configure({ scope: [] });
        renderPersonalScope();
      } else if (action === 'reload') {
        loadConfig();
      } else if (action === 'add-repo') {
        var holder = overlay.querySelector('[data-settings-repos]');
        holder.insertAdjacentHTML('beforeend', repositoryRow());
      } else if (action === 'remove-repo') {
        var row = target.closest('.settings-repo-row');
        if (row) {
          row.remove();
        }
      } else if (action === 'test-auth') {
        testAuth();
      } else if (action === 'change-password') {
        changePassword();
      }
    });
    overlay.addEventListener('change', function (event) {
      var scopeValue = event.target.getAttribute && event.target.getAttribute('data-personal-scope-value');
      if (scopeValue) {
        updatePersonalScope(scopeValue, event.target.checked);
      }
    });
    overlay.querySelector('[data-settings-save]').addEventListener('click', saveConfig);
    overlay.addEventListener('submit', function (event) {
      event.preventDefault();
      var form = event.target;
      if (!form.hasAttribute('data-settings-admin-form')) {
        return;
      }
      var siteAuth = auth();
      setStatus('正在验证管理员账号…');
      siteAuth.login(form.adminUser.value.trim(), form.adminPassword.value, 'admin').then(function () {
        setStatus('管理员登录成功');
        loadConfig();
      }).catch(function (error) {
        setStatus('管理员登录失败：' + error.message, true);
      });
    });
  }

  function updateBadge() {
    if (!state.overlay) {
      return;
    }
    var info = snapshot();
    var badge = state.overlay.querySelector('[data-settings-badge]');
    if (!info.available) {
      badge.textContent = '只读预览';
    } else if (siteIsAdmin(info)) {
      badge.textContent = '管理员 ' + ((info.user && info.user.username) || '');
    } else {
      badge.textContent = '需要管理员登录';
    }
  }

  function siteIsAdmin(info) {
    return !!(info && info.authenticated && info.role === 'admin');
  }

  function open() {
    if (!state.overlay) {
      buildOverlay();
    }
    updateBadge();
    state.overlay.classList.add('is-open');
    var info = snapshot();
    if (info.available && siteIsAdmin(info)) {
      loadConfig();
    } else {
      renderForm();
      setStatus('');
    }
  }

  function close() {
    if (state.overlay) {
      state.overlay.classList.remove('is-open');
    }
  }

  function init() {
    document.addEventListener('siteauth:change', function () {
      updateBadge();
      if (state.overlay && state.overlay.classList.contains('is-open')) {
        var info = snapshot();
        if (info.available && siteIsAdmin(info) && !state.config) {
          loadConfig();
        } else if (!siteIsAdmin(info)) {
          state.config = null;
          renderForm();
        }
      }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.overlay && state.overlay.classList.contains('is-open')) {
        close();
      }
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.Settings = { open: open, close: close, load: loadConfig, save: saveConfig };
}());
