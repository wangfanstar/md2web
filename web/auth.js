(function () {
  'use strict';

  var STORAGE_MARKER = 'md2web:auth:hint';
  var generation = 0, authBusy = false, refreshPending = null;
  var state = {
    loaded: false,
    available: false,
    authenticated: false,
    user: null,
    csrfToken: null,
    features: { editDraft: false, svnCommit: false, localPublish: false },
    site: { repositories: [] },
    ai: null,
    svnCredential: false,
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

  // 独立页面（如 docs/lib/plot-playground.html）通过 window.MD2WEB_BASE 指定站点根前缀
  function assetBase() {
    return String(window.MD2WEB_BASE || '');
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
      svnCredential: state.svnCredential,
      fileMode: isFileMode()
    };
  }

  function request(path, options) {
    return fetch(assetBase() + path, Object.assign({cache:'no-store', credentials:'same-origin'}, options)).then(function (response) {
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
    state.authenticated = !!(payload.authenticated && payload.user && payload.csrfToken);
    state.user = state.authenticated ? payload.user : null;
    state.csrfToken = state.authenticated ? payload.csrfToken : null;
    state.features = state.authenticated ? (payload.features || {}) : {editDraft:false, svnCommit:false, localPublish:false};
    state.site = payload.site || {repositories:[]};
    state.ai = state.authenticated ? ((payload.site && payload.site.ai) || null) : null;
    state.svnCredential = state.authenticated && !!payload.svnCredential;
  }

  function clearSession() {
    state.authenticated = false;
    state.user = null;
    state.csrfToken = null;
    state.features = {editDraft:false, svnCommit:false, localPublish:false};
    state.ai = null;
    state.svnCredential = false;
    state.site = {repositories:[]};
  }

  function refresh() {
    if (authBusy) return Promise.resolve(snapshot());
    if (refreshPending && refreshPending.version === generation) return refreshPending.promise;
    var version = ++generation;
    if (isFileMode()) {
      clearSession();
      state.loaded = true;
      state.available = false;
      emit();
      return Promise.resolve(snapshot());
    }
    var timer;
    var timeout = new Promise(function (resolve, reject) {
      timer = window.setTimeout(function () { reject(new Error('会话校验超时')); }, 10000);
    });
    var promise = Promise.race([request('__auth/session'), timeout]).then(function (payload) {
      if (version !== generation) return snapshot();
      applySession(payload);
      emit();
      return snapshot();
    }).catch(function (error) {
      if (version !== generation) return snapshot();
      clearSession();
      state.loaded = true;
      state.available = error.status === 401 || error.status === 403;
      emit();
      return snapshot();
    });
    var pending = {version:version, promise:promise};
    refreshPending = pending;
    promise.then(function () { window.clearTimeout(timer); if (refreshPending === pending) refreshPending = null; });
    return promise;
  }

  function login(username, password, mode, preferences) {
    var version = ++generation;
    refreshPending = null;
    authBusy = true;
    return request('__auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password, mode: mode || '',
        rememberSession: !!(preferences && preferences.rememberSession), rememberUsername: !!(preferences && preferences.rememberUsername) })
    }).then(function (payload) {
      if (version !== generation) return snapshot();
      authBusy = false;
      try { localStorage.setItem(STORAGE_MARKER, payload.user && payload.user.username || ''); } catch (error) {}
      return refresh().then(function (info) {
        if (!info.authenticated) throw new Error('登录会话未能确认，请检查网络和浏览器 Cookie 后重试');
        return info;
      });
    }).catch(function (error) {
      if (version === generation) { authBusy = false; clearSession(); emit(); }
      throw error;
    });
  }

  function logout() {
    var version = ++generation;
    refreshPending = null;
    var token = state.csrfToken;
    if (!state.authenticated) {
      authBusy = false;
      clearSession(); emit();
      return Promise.resolve();
    }
    authBusy = true;
    clearSession(); emit();
    return request('__auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token || '' },
      body: '{}'
    }).catch(function () { /* 即使失败也清理前端状态 */ }).then(function () {
      if (version === generation) { authBusy = false; emit(); }
    });
  }

  // ---------- 界面 ----------

  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.className = 'site-auth';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', '登录知识库');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = [
      '<div class="site-auth-backdrop" data-auth-close></div>',
      '<form class="site-auth-panel">',
      '<span class="site-auth-eyebrow">文档知识库</span><h3>欢迎回来</h3>',
      '<p class="site-auth-hint">登录后编辑文档、保存修改，与团队共享知识。</p>',
      '<label>用户名<input type="text" name="username" autocomplete="username" required></label>',
      '<label>密码<input type="password" name="password" autocomplete="current-password" required></label>',
      '<div class="site-auth-preferences"><label><input type="checkbox" name="rememberSession">保持登录</label>',
      '<label><input type="checkbox" name="rememberUsername" checked>记住用户名</label></div>',
      '<button type="button" data-forget-device>忘记此设备</button>',
      '<p class="site-auth-error" data-auth-error role="status" aria-live="polite"></p>',
      '<div class="site-auth-actions">',
      '<button type="submit" class="is-primary">登录</button>',
      '<button type="button" data-auth-close>取消</button>',
      '</div>',
      '<p class="site-auth-footnote">使用 SVN 账号或本地管理员账号登录。已提升权限的用户仍使用原 SVN 密码。</p></form>'
    ].join('');
    document.body.appendChild(overlay);
    state.overlay = overlay;
    overlay.querySelector('[data-forget-device]').addEventListener('click', function () {
      request('__auth/forget-device', {method: 'POST', headers: {'X-CSRF-Token': state.csrfToken || ''}}).then(function () {
        overlay.querySelector('[name="username"]').value = '';
        return refresh();
      }).catch(function (error) { overlay.querySelector('[data-auth-error]').textContent = error.message; });
    });
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
      login(username, password, '', {rememberSession: form.rememberSession.checked, rememberUsername: form.rememberUsername.checked}).then(function () {
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
      return refresh().then(function (info) {
        if (info.available) openLogin();
        else alert('暂时无法连接认证服务，或当前为只读预览。请确认认证服务已启动后重试。');
      });
    }
    if (!state.overlay) {
      buildOverlay();
    }
    state.overlay.classList.add('is-open');
    var input = state.overlay.querySelector('input[name="username"]');
    if (input) {
      request('__auth/login-hint').then(function (data) { if (!input.value) input.value = data.username || ''; }).catch(function () {});
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

  function fixedHost() {
    var host = document.querySelector('[data-site-auth-fixed]');
    if (host) {
      return host;
    }
    host = document.createElement('div');
    host.className = 'site-auth-fixed';
    host.setAttribute('data-site-auth-fixed', '');
    document.body.appendChild(host);
    watchForSidebar();
    return host;
  }

  function removeFixedHost() {
    var host = document.querySelector('[data-site-auth-fixed]');
    if (host && host.parentNode) {
      host.parentNode.removeChild(host);
    }
  }

  // docsify 侧栏（含登录指示器）稍后才渲染：出现后收起固定入口，避免重复
  function watchForSidebar() {
    if (watchForSidebar.timer) {
      return;
    }
    var attempts = 0;
    watchForSidebar.timer = window.setInterval(function () {
      attempts += 1;
      if (hostRow()) {
        window.clearInterval(watchForSidebar.timer);
        watchForSidebar.timer = null;
        renderIndicator();
      } else if (attempts >= 10) {
        window.clearInterval(watchForSidebar.timer);
        watchForSidebar.timer = null;
      }
    }, 600);
  }

  function renderIndicator() {
    if (!document.body) {
      return;
    }
    var row = hostRow();
    if (row) {
      removeFixedHost();
    } else {
      row = fixedHost();
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
    var isAdmin = !!(state.user && state.user.role === 'admin');
    var label = isAdmin ? name + '（本机）' : name;
    var hint = isAdmin
      ? '本机管理员：可本地编辑（草稿）；合入 SVN 需要 SVN 账号'
      : '已登录';
    host.innerHTML = '<span class="site-auth-user" title="' + escapeHtml(hint) + '">' + escapeHtml(label) + '</span>'
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
      refresh();
    });
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    if (!isFileMode()) window.setInterval(function () { if (!document.hidden) refresh(); }, 30000);
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
    handleResponse: function (response) {
      if (response.status !== 401 && response.status !== 403) return Promise.resolve(snapshot());
      // A response from an older write must not cancel a login/logout in flight.
      if (authBusy) return Promise.resolve(snapshot());
      if (response.status === 401) { generation++; clearSession(); emit(); }
      return refresh();
    },
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
