(function () {
  'use strict';

  var STORAGE_MARKER = 'md2web:auth:hint';
  var state = {
    loaded: false,
    available: false,
    authenticated: false,
    user: null,
    csrfToken: null,
    features: { editDraft: false, svnCommit: false, localPublish: false },
    site: { repositories: [] },
    ai: null,
    overlay: null,
    error: ''
  };

  function routeResource() {
    var hash = String(window.location.hash || '#/').replace(/^#/, '').split('?')[0];
    try {
      return decodeURIComponent(hash).replace(/^\/+/, '').replace(/\/+$/, '') || 'README.md';
    } catch (error) {
      return 'README.md';
    }
  }

  function isFileMode() {
    return window.location.protocol === 'file:';
  }

  function emit() {
    try {
      document.dispatchEvent(new CustomEvent('siteauth:change', { detail: snapshot() }));
    } catch (error) { /* 旧浏览器忽略 */ }
    renderIndicator();
  }

  function snapshot() {
    return {
      available: state.available,
      authenticated: state.authenticated,
      user: state.user,
      role: (state.user && state.user.role) || '',
      features: state.features,
      ai: state.ai,
      fileMode: isFileMode()
    };
  }

  function request(path, options) {
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) {
          var error = new Error(payload.error || ('HTTP ' + response.status));
          error.status = response.status;
          error.payload = payload;
          throw error;
        }
        return payload;
      });
    });
  }

  function applySession(payload) {
    state.loaded = true;
    state.available = true;
    state.authenticated = !!payload.authenticated;
    state.user = payload.user || null;
    state.csrfToken = payload.csrfToken || null;
    state.features = payload.features || state.features;
    state.site = payload.site || state.site;
    state.ai = (payload.site && payload.site.ai) || null;
  }

  function refresh() {
    if (isFileMode()) {
      state.loaded = true;
      state.available = false;
      emit();
      return Promise.resolve(snapshot());
    }
    return request('__auth/session').then(function (payload) {
      applySession(payload);
      emit();
      return snapshot();
    }).catch(function () {
      state.loaded = true;
      state.available = false;
      emit();
      return snapshot();
    });
  }

  function login(username, password, mode) {
    return request('__auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password, mode: mode || '' })
    }).then(function (payload) {
      state.authenticated = true;
      state.user = payload.user;
      state.csrfToken = payload.csrfToken;
      try { localStorage.setItem(STORAGE_MARKER, payload.user && payload.user.username || ''); } catch (error) {}
      emit();
      return refresh();
    });
  }

  function logout() {
    if (!state.authenticated) {
      return Promise.resolve();
    }
    return request('__auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
      body: '{}'
    }).catch(function () { /* 即使失败也清理前端状态 */ }).then(function () {
      state.authenticated = false;
      state.user = null;
      state.csrfToken = null;
      emit();
    });
  }

  // ---------- 界面 ----------

  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.className = 'site-auth';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', '登录 SVN 账号');
    overlay.innerHTML = [
      '<div class="site-auth-backdrop" data-auth-close></div>',
      '<form class="site-auth-panel">',
      '<h3>登录 SVN 账号</h3>',
      '<p class="site-auth-hint">普通用户用 SVN 账号密码登录（仅用于向 SVN 服务器验证，不写入本应用数据库）；管理员可用本机管理员账号（默认 <b>admin / admin</b>）登录。</p>',
      '<label>用户名<input type="text" name="username" autocomplete="username" required></label>',
      '<label>密码<input type="password" name="password" autocomplete="current-password" required></label>',
      '<p class="site-auth-error" data-auth-error></p>',
      '<div class="site-auth-actions">',
      '<button type="submit" class="is-primary">登录</button>',
      '<button type="button" data-auth-close>取消</button>',
      '</div>',
      '</form>'
    ].join('');
    document.body.appendChild(overlay);
    state.overlay = overlay;
    overlay.addEventListener('click', function (event) {
      if (event.target.hasAttribute && event.target.hasAttribute('data-auth-close')) {
        closeLogin();
      }
    });
    overlay.querySelector('form').addEventListener('submit', function (event) {
      event.preventDefault();
      var form = event.target;
      var username = form.username.value.trim();
      var password = form.password.value;
      var errorEl = overlay.querySelector('[data-auth-error]');
      errorEl.textContent = '正在验证…';
      login(username, password).then(function () {
        closeLogin();
      }).catch(function (error) {
        errorEl.textContent = error && error.message ? error.message : '登录失败';
      });
    });
  }

  function openLogin() {
    if (isFileMode()) {
      alert('离线浏览（file://）为只读模式。请运行 python serve.py --config config/server.local.json 后通过服务地址登录编辑。');
      return;
    }
    if (state.loaded && !state.available) {
      alert('当前是只读预览模式：请使用 python serve.py --config config/server.local.json 启动认证编辑服务后再登录。');
      return;
    }
    if (!state.overlay) {
      buildOverlay();
    }
    state.overlay.classList.add('is-open');
    var input = state.overlay.querySelector('input[name="username"]');
    if (input) {
      input.focus();
    }
  }

  function closeLogin() {
    if (state.overlay) {
      state.overlay.classList.remove('is-open');
    }
  }

  function hostRow() {
    var row = document.querySelector('.custom-search-top-row');
    if (row) {
      return row;
    }
    var aside = document.querySelector('aside.sidebar') || document.querySelector('.sidebar');
    if (!aside) {
      return null;
    }
    var appName = aside.querySelector('.app-name');
    if (!appName) {
      return null;
    }
    var extra = appName.parentNode.querySelector('.site-auth-row');
    if (!extra) {
      extra = document.createElement('div');
      extra.className = 'site-auth-row';
      appName.parentNode.insertBefore(extra, appName.nextSibling);
    }
    return extra;
  }

  function renderIndicator() {
    var row = hostRow();
    if (!row) {
      return;
    }
    var host = row.querySelector('[data-site-auth]');
    if (!host) {
      host = document.createElement('span');
      host.className = 'site-auth-indicator';
      host.setAttribute('data-site-auth', '');
      row.appendChild(host);
    }
    if (isFileMode()) {
      host.innerHTML = '<span class="site-auth-badge" title="离线只读">离线只读</span>';
      return;
    }
    if (!state.authenticated) {
      host.innerHTML = '<button type="button" class="site-auth-login" title="登录后可编辑">登录</button>';
      host.querySelector('.site-auth-login').addEventListener('click', openLogin);
      return;
    }
    var name = state.user && (state.user.displayName || state.user.username) || '已登录';
    host.innerHTML = '<span class="site-auth-user" title="已登录">' + escapeHtml(name) + '</span>'
      + '<button type="button" class="site-auth-login" title="退出登录">退出</button>';
    host.querySelector('.site-auth-login').addEventListener('click', function () {
      logout();
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function init() {
    refresh();
    window.addEventListener('hashchange', function () {
      window.setTimeout(renderIndicator, 0);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.overlay && state.overlay.classList.contains('is-open')) {
        closeLogin();
      }
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.SiteAuth = {
    refresh: refresh,
    login: login,
    logout: logout,
    openLogin: openLogin,
    closeLogin: closeLogin,
    snapshot: snapshot,
    isAuthenticated: function () { return !!state.authenticated; },
    isAdmin: function () { return !!state.authenticated && (state.user && state.user.role) === 'admin'; },
    aiDefaults: function () { return state.ai; },
    csrfToken: function () { return state.csrfToken; },
    features: function () { return state.features; },
    repositories: function () { return state.site.repositories || []; },
    loginRequired: function () {
      if (isFileMode()) {
        return '离线浏览（file://）为只读模式，请改用 python serve.py --config 启动认证服务';
      }
      return '请先登录 SVN 账号后再编辑或保存';
    }
  };
}());
