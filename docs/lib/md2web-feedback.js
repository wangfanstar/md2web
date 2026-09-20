(function () {
  'use strict';

  var state = { csrf: '', user: null, isAdmin: false, statuses: {}, items: [] };

  function query(selector) {
    return document.querySelector(selector);
  }

  function all(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
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
      setStatus('加载反馈失败：' + error.message, true);
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
        setStatus('提交失败：' + error.message, true);
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

  refreshSession().then(function () {
    return loadList();
  });
}());
