(function () {
  'use strict';

  var state = { csrf: '', user: null, isAdmin: false, statuses: {}, items: [],
    root: null, pageRoot: null, dialog: null };

  function query(selector) {
    return (state.root || document).querySelector(selector);
  }

  function all(selector) {
    return Array.prototype.slice.call((state.root || document).querySelectorAll(selector));
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function setStatus(text, isError) {
    var node = query('[data-status]');
    if (!node) {
      return;
    }
    node.hidden = !text;
    node.className = 'status' + (isError ? ' error' : ' ok');
    node.textContent = text || '';
  }

  function api(path, options) {
    var headers = Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {});
    if (state.csrf) {
      headers['X-CSRF-Token'] = state.csrf;
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

  function pageFromQuery() {
    var params = new URLSearchParams(window.location.search || '');
    var page = params.get('page') || '';
    if (page) {
      return page;
    }
    var hash = String(window.location.hash || '').replace(/^#\/?/, '');
    return hash ? decodeURIComponent(hash) : '';
  }

  function renderUser() {
    var label = query('[data-user-label]');
    if (label) {
      label.textContent = state.user
        ? '已登录：' + (state.user.displayName || state.user.username)
          + (state.isAdmin ? '（管理员，可更新进度）' : '（读者，可提交反馈）')
        : '未登录：只能查看反馈（登录后可提交）';
    }
    query('[data-action="login"]').hidden = !!state.user;
    query('[data-action="logout"]').hidden = !state.user;
    query('[data-login-panel]').hidden = !!state.user;
    var hint = query('[data-submit-hint]');
    if (hint) {
      hint.textContent = state.user ? '提交后管理员会更新处理进度。' : '登录后即可提交反馈。';
    }
    ['[data-feedback-title]', '[data-feedback-body]', '[data-feedback-page]', '[data-action="submit"]'].forEach(function (selector) {
      var node = query(selector);
      if (node) {
        node.disabled = !state.user;
      }
    });
    var pageInput = query('[data-feedback-page]');
    if (pageInput && !pageInput.value) {
      pageInput.value = pageFromQuery();
    }
  }

  function statusLabel(status) {
    return (state.statuses[status] && state.statuses[status].label) || status;
  }

  function formatTime(value) {
    return String(value || '').replace('T', ' ').replace('Z', '').slice(0, 19);
  }

  // ---------- 反馈弹窗（侧栏图标 / 固定右上角按钮共用） ----------

  function dialogMarkup() {
    return [
      '<div class="feedback-dialog-backdrop" data-action="close-dialog"></div>',
      '<section class="feedback-dialog-panel" role="dialog" aria-modal="true" aria-label="读者反馈">',
      '<header class="feedback-dialog-head">',
      '<strong>读者反馈</strong>',
      '<span class="hint" data-user-label>正在读取登录状态…</span>',
      '<span class="feedback-dialog-spacer"></span>',
      '<button type="button" data-action="login">登录</button>',
      '<button type="button" data-action="logout" hidden>退出</button>',
      '<a href="md2web_feedback.html" target="_blank" rel="noopener"><button type="button">独立页面</button></a>',
      '<button type="button" data-action="close-dialog">关闭</button>',
      '</header>',
      '<div class="status" data-status hidden></div>',
      '<div class="feedback-dialog-body">',
      '<div class="row" data-login-panel hidden>',
      '<label>用户名<input type="text" data-login-username autocomplete="username" placeholder="SVN 账号或本机管理员"></label>',
      '<label>密码<input type="password" data-login-password autocomplete="current-password"></label>',
      '<button class="primary" type="button" data-action="do-login">登录</button>',
      '</div>',
      '<p class="hint" data-submit-hint>登录后即可提交反馈。</p>',
      '<div class="row">',
      '<label>标题<input type="text" data-feedback-title placeholder="一句话描述问题" disabled></label>',
      '</div>',
      '<label>问题描述<textarea data-feedback-body placeholder="复现步骤、期望结果、实际结果…" disabled></textarea></label>',
      '<label>相关页面<input type="text" data-feedback-page placeholder="如 md/硬件设计/时钟树设计.md（自动带入）" disabled></label>',
      '<div class="actions"><button class="primary" type="button" data-action="submit" disabled>提交反馈</button></div>',
      '<h4 class="feedback-dialog-subtitle">反馈列表与进度</h4>',
      '<div data-feedback-list><p class="hint">正在加载…</p></div>',
      '</div>',
      '</section>'
    ].join('');
  }

  function openDialog() {
    if (state.dialog) {
      state.dialog.hidden = false;
      state.root = state.dialog;
      renderUser();
      refreshSession().then(function () { return loadList(); });
      return;
    }
    var dialog = document.createElement('div');
    dialog.className = 'feedback-dialog';
    dialog.innerHTML = dialogMarkup();
    document.body.appendChild(dialog);
    state.dialog = dialog;
    state.root = dialog;
    var pageInput = query('[data-feedback-page]');
    if (pageInput) {
      pageInput.value = pageFromQuery() || document.title || '';
    }
    renderUser();
    refreshSession().then(function () { return loadList(); });
  }

  function closeDialog() {
    if (!state.dialog) {
      return;
    }
    state.dialog.hidden = true;
    state.root = state.pageRoot;
    renderUser();
  }

  function friendlyError(error) {
    var status = error && error.status;
    if (window.location.protocol === 'file:') {
      return '离线（file://）打开不支持提交反馈，请通过服务地址访问';
    }
    if (status === 405 || status === 403) {
      return '当前服务不支持提交反馈（只读预览模式），请用认证服务启动后再试';
    }
    if (status === 404) {
      return '服务端未启用反馈接口，请升级到包含反馈功能的最新版本';
    }
    return (error && error.message) || '未知错误';
  }

  var FEEDBACK_STYLE_ID = 'feedback-dialog-style';
  var FEEDBACK_STYLE = [
    '.feedback-fixed-entry{background:var(--docs-accent,#1f6feb);border:0;border-radius:999px;',
    'bottom:18px;box-shadow:0 8px 20px rgba(15,23,42,.25);color:#fff;cursor:pointer;font:inherit;',
    'font-size:13px;padding:8px 16px;position:fixed;right:18px;z-index:1100;}',
    '.feedback-dialog{inset:0;position:fixed;z-index:1300;}',
    '.feedback-dialog[hidden]{display:none;}',
    '.feedback-dialog-backdrop{background:rgba(15,23,42,.45);inset:0;position:absolute;}',
    '.feedback-dialog-panel{background:#fff;border-radius:10px;box-shadow:0 18px 48px rgba(15,23,42,.3);',
    'display:flex;flex-direction:column;left:50%;max-height:86vh;max-width:860px;overflow:hidden;',
    'position:absolute;top:50%;transform:translate(-50%,-50%);width:min(94vw,860px);}',
    '.feedback-dialog-head{align-items:center;border-bottom:1px solid var(--docs-border,#e3e8ee);display:flex;',
    'flex-wrap:wrap;gap:8px;padding:10px 14px;}',
    '.feedback-dialog-head strong{font-size:14px;}',
    '.feedback-dialog-spacer{flex:1;}',
    '.feedback-dialog-body{overflow:auto;padding:12px 14px 18px;}',
    '.feedback-dialog-subtitle{border-top:1px dashed var(--docs-border,#e3e8ee);font-size:13px;',
    'margin:14px 0 8px;padding-top:10px;}',
    '.feedback-dialog .status{margin:8px 14px 0;}'
  ].join('');

  function ensureStyles() {
    if (document.getElementById(FEEDBACK_STYLE_ID)) {
      return;
    }
    var style = document.createElement('style');
    style.id = FEEDBACK_STYLE_ID;
    style.textContent = FEEDBACK_STYLE;
    document.head.appendChild(style);
  }

  function ensureFixedEntry() {
    if (document.querySelector('[data-feedback-list]') || document.querySelector('[data-sidebar-ai]')
        || document.querySelector('.feedback-fixed-entry')) {
      return;
    }
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'feedback-fixed-entry';
    button.setAttribute('data-action', 'open-dialog');
    button.setAttribute('title', '反馈问题（登录后可提交）');
    button.textContent = '反馈';
    document.body.appendChild(button);
    // docsify 侧栏（含 AI 设置图标）稍后才渲染：出现后收起右上角入口，避免重复
    var attempts = 0;
    var timer = setInterval(function () {
      attempts += 1;
      if (document.querySelector('[data-sidebar-ai]')) {
        button.remove();
        clearInterval(timer);
      } else if (attempts >= 10) {
        clearInterval(timer);
      }
    }, 600);
  }

  function renderList() {
    var host = query('[data-feedback-list]');
    if (!host) {
      return;
    }
    if (!state.items.length) {
      host.innerHTML = '<p class="hint">还没有反馈。</p>';
      return;
    }
    host.innerHTML = state.items.map(function (item) {
      var adminTools = state.isAdmin
        ? '<div class="admin-tools" data-feedback-admin="' + item.id + '">'
          + '<select data-feedback-status>'
          + Object.keys(state.statuses).map(function (key) {
            return '<option value="' + key + '"' + (item.status === key ? ' selected' : '') + '>'
              + escapeHtml(state.statuses[key].label) + '</option>';
          }).join('')
          + '</select>'
          + '<input type="text" data-feedback-note placeholder="处理说明（可选）" value="' + escapeHtml(item.note || '') + '">'
          + '<button type="button" data-action="save-progress" data-id="' + item.id + '">保存进度</button>'
          + '</div>'
        : '';
      return '<div class="feedback-item">'
        + '<div class="feedback-head">'
        + '<span class="badge ' + escapeHtml(item.status) + '">' + escapeHtml(statusLabel(item.status)) + '</span>'
        + '<strong>#' + item.id + ' ' + escapeHtml(item.title) + '</strong>'
        + '<span class="feedback-meta">' + escapeHtml(item.author_name || '') + ' · '
        + escapeHtml(formatTime(item.created_at)) + (item.page ? ' · ' + escapeHtml(item.page) : '') + '</span>'
        + '</div>'
        + '<div class="feedback-body">' + escapeHtml(item.body) + '</div>'
        + (item.note ? '<div class="feedback-note">处理说明：' + escapeHtml(item.note)
          + '（更新于 ' + escapeHtml(formatTime(item.updated_at)) + '）</div>' : '')
        + adminTools
        + '</div>';
    }).join('');
  }

  function loadList() {
    var filter = query('[data-feedback-filter]');
    var status = filter ? filter.value : '';
    return api('__feedback' + (status ? '?status=' + encodeURIComponent(status) : '')).then(function (payload) {
      state.statuses = {};
      (payload.statuses || []).forEach(function (item) { state.statuses[item.id] = item; });
      state.items = payload.feedback || [];
      renderList();
      return state.items;
    }).catch(function (error) {
      setStatus('加载反馈失败：' + friendlyError(error), true);
    });
  }

  function refreshSession() {
    return api('__auth/session').then(function (payload) {
      state.user = payload.authenticated ? payload.user : null;
      state.isAdmin = !!(state.user && state.user.role === 'admin');
      state.csrf = payload.csrfToken || '';
      renderUser();
      return state.user;
    }).catch(function () {
      state.user = null;
      renderUser();
    });
  }

  function doLogin() {
    var username = query('[data-login-username]').value.trim();
    var password = query('[data-login-password]').value;
    if (!username || !password) {
      setStatus('请输入用户名与密码', true);
      return;
    }
    setStatus('正在登录…');
    fetch('__auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok || payload.ok === false) {
          throw new Error(payload.error || ('HTTP ' + response.status));
        }
        return payload;
      });
    }).then(function () {
      setStatus('登录成功');
      return refreshSession();
    }).then(function () {
      return loadList();
    }).catch(function (error) {
      setStatus('登录失败：' + error.message, true);
    });
  }

  function doLogout() {
    api('__auth/logout', { method: 'POST', body: JSON.stringify({}) }).then(function () {
      setStatus('已退出登录');
      return refreshSession();
    }).then(function () {
      return loadList();
    }).catch(function (error) {
      setStatus('退出失败：' + error.message, true);
    });
  }

  function submit() {
    var title = query('[data-feedback-title]').value.trim();
    var body = query('[data-feedback-body]').value.trim();
    var page = query('[data-feedback-page]').value.trim();
    if (title.length < 2 || !body) {
      setStatus('请填写标题（至少 2 个字）与问题描述', true);
      return;
    }
    setStatus('正在提交…');
    api('__feedback', { method: 'POST', body: JSON.stringify({ title: title, body: body, page: page }) })
      .then(function (payload) {
        setStatus('已提交反馈 #' + payload.id + '，管理员会更新处理进度');
        query('[data-feedback-title]').value = '';
        query('[data-feedback-body]').value = '';
        return loadList();
      })
      .catch(function (error) {
        setStatus('提交失败：' + friendlyError(error), true);
      });
  }

  function saveProgress(button) {
    var id = button.getAttribute('data-id');
    var tools = document.querySelector('[data-feedback-admin="' + id + '"]');
    if (!tools) {
      return;
    }
    var status = tools.querySelector('[data-feedback-status]').value;
    var note = tools.querySelector('[data-feedback-note]').value.trim();
    setStatus('正在保存 #' + id + ' 的进度…');
    api('__admin/feedback', { method: 'POST', body: JSON.stringify({ id: Number(id), status: status, note: note }) })
      .then(function () {
        setStatus('已更新 #' + id + '：' + statusLabel(status));
        return loadList();
      })
      .catch(function (error) {
        setStatus('更新失败：' + error.message, true);
      });
  }

  document.addEventListener('click', function (event) {
    var target = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!target) {
      return;
    }
    var action = target.getAttribute('data-action');
    if (action === 'login') {
      query('[data-login-panel]').hidden = false;
      query('[data-login-username]').focus();
    } else if (action === 'do-login') {
      doLogin();
    } else if (action === 'logout') {
      doLogout();
    } else if (action === 'open-dialog') {
      openDialog();
    } else if (action === 'close-dialog') {
      closeDialog();
    } else if (action === 'reload') {
      loadList();
    } else if (action === 'submit') {
      submit();
    } else if (action === 'save-progress') {
      saveProgress(target);
    }
  });

  var filter = query('[data-feedback-filter]');
  if (filter) {
    filter.addEventListener('change', loadList);
  }

  state.pageRoot = document.querySelector('.wrap') || document.body;
  state.root = state.pageRoot;
  ensureStyles();
  ensureFixedEntry();
  window.FeedbackDialog = { open: openDialog, close: closeDialog };
  refreshSession().then(function () {
    return loadList();
  });
}());
