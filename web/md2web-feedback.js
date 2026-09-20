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
        ? (state.user.displayName || state.user.username) + (state.isAdmin ? '（管理员）' : '（读者）')
        : '未登录 · 仅查看';
      if (label.classList && label.classList.contains('fd-chip')) {
        label.classList.toggle('is-user', !!state.user);
      }
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

  var FEEDBACK_ICON = '<svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true">'
    + '<path d="M2.5 3.2h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.2L4 13.6v-2.4H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"'
    + ' fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'
    + '<path d="M5 6.4h6M5 8.4h4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

  function dialogMarkup() {
    return [
      '<div class="feedback-dialog-backdrop" data-action="close-dialog"></div>',
      '<section class="feedback-dialog-panel" role="dialog" aria-modal="true" aria-label="读者反馈">',
      '<header class="fd-head">',
      '<span class="fd-head-icon">' + FEEDBACK_ICON + '</span>',
      '<div class="fd-head-title"><strong>读者反馈</strong><span>提交问题、查看处理进度</span></div>',
      '<span class="fd-spacer"></span>',
      '<span class="fd-chip" data-user-label>正在读取登录状态…</span>',
      '<div class="fd-actions">',
      '<button type="button" class="fd-btn" data-action="login">登录</button>',
      '<button type="button" class="fd-btn" data-action="logout" hidden>退出</button>',
      '<a class="fd-btn" href="md2web_feedback.html" target="_blank" rel="noopener">独立页面</a>',
      '<button type="button" class="fd-btn" data-action="close-dialog" title="关闭（Esc）">关闭</button>',
      '</div>',
      '</header>',
      '<div class="status" data-status hidden></div>',
      '<div class="fd-body">',
      '<section class="fd-section fd-login" data-login-panel hidden>',
      '<div class="fd-field"><span>用户名</span><input type="text" data-login-username autocomplete="username"'
      + ' placeholder="SVN 账号或本机管理员"></div>',
      '<div class="fd-field"><span>密码</span><input type="password" data-login-password autocomplete="current-password"></div>',
      '<div class="fd-field fd-field-action"><span>&nbsp;</span>'
      + '<button class="fd-btn primary" type="button" data-action="do-login">登录</button></div>',
      '</section>',
      '<section class="fd-section">',
      '<div class="fd-section-head"><strong>提交反馈</strong><span class="fd-hint" data-submit-hint>登录后即可提交反馈。</span></div>',
      '<div class="fd-form-grid">',
      '<div class="fd-field"><span>标题</span><input type="text" data-feedback-title placeholder="一句话描述问题" disabled></div>',
      '<div class="fd-field"><span>相关页面</span><input type="text" data-feedback-page placeholder="md/…（自动带入）" disabled></div>',
      '<div class="fd-field fd-field-wide"><span>问题描述</span>'
      + '<textarea data-feedback-body placeholder="复现步骤、期望结果、实际结果…" disabled></textarea></div>',
      '</div>',
      '<div class="fd-actions fd-actions-right">',
      '<button class="fd-btn primary" type="button" data-action="submit" disabled>提交反馈</button>',
      '</div>',
      '</section>',
      '<section class="fd-section">',
      '<div class="fd-section-head"><strong>反馈列表与进度</strong>'
      + '<span class="fd-count" data-feedback-count>0 条</span></div>',
      '<div data-feedback-list><p class="fd-empty">正在加载…</p></div>',
      '</section>',
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
    /* 固定右上角入口（无 AI 设置图标的页面） */
    '.feedback-fixed-entry{align-items:center;background:linear-gradient(135deg,#1f6feb,#3b82f6);border:0;',
    'border-radius:999px;bottom:18px;box-shadow:0 10px 24px rgba(31,111,235,.35);color:#fff;cursor:pointer;',
    'display:inline-flex;font:inherit;font-size:13px;font-weight:600;gap:6px;padding:9px 16px;position:fixed;',
    'right:18px;transition:transform .15s,box-shadow .15s;z-index:1100;}',
    '.feedback-fixed-entry:hover{box-shadow:0 14px 28px rgba(31,111,235,.42);transform:translateY(-1px);}',
    '.feedback-fixed-entry svg{height:15px;width:15px;}',
    /* 弹窗骨架 */
    '.feedback-dialog{inset:0;position:fixed;z-index:1300;}',
    '.feedback-dialog[hidden]{display:none;}',
    '.feedback-dialog *{box-sizing:border-box;}',
    '.feedback-dialog-backdrop{background:rgba(15,23,42,.5);inset:0;position:absolute;}',
    '.feedback-dialog-panel{background:#fff;border-radius:14px;box-shadow:0 24px 64px rgba(15,23,42,.35);',
    'color:#1f2a37;display:flex;flex-direction:column;left:50%;max-height:88vh;overflow:hidden;position:absolute;',
    'top:50%;transform:translate(-50%,-50%);width:min(94vw,900px);}',
    /* 头部 */
    '.fd-head{align-items:center;background:linear-gradient(135deg,#f8fbff,#eef4fd);border-bottom:1px solid #e3e8ee;',
    'display:flex;flex-wrap:wrap;gap:10px;padding:14px 18px;}',
    '.fd-head-icon{align-items:center;background:linear-gradient(135deg,#1f6feb,#3b82f6);border-radius:10px;color:#fff;',
    'display:inline-flex;height:34px;justify-content:center;width:34px;}',
    '.fd-head-title{display:flex;flex-direction:column;gap:2px;}',
    '.fd-head-title strong{font-size:15px;}',
    '.fd-head-title span{color:#64748b;font-size:11.5px;}',
    '.fd-spacer{flex:1;}',
    '.fd-chip{background:#fff;border:1px solid #dbe4ee;border-radius:999px;color:#475569;font-size:11.5px;padding:4px 10px;}',
    '.fd-chip.is-user{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8;}',
    '.fd-actions{align-items:center;display:flex;flex-wrap:wrap;gap:8px;}',
    '.fd-actions-right{justify-content:flex-end;margin-top:10px;}',
    '.fd-btn{align-items:center;background:#fff;border:1px solid #d5dee8;border-radius:8px;color:#334155;cursor:pointer;',
    'display:inline-flex;font:inherit;font-size:12.5px;gap:5px;padding:6px 12px;text-decoration:none;transition:all .15s;}',
    '.fd-btn:hover{border-color:#1f6feb;color:#1f6feb;}',
    '.fd-btn.primary{background:linear-gradient(135deg,#1f6feb,#3b82f6);border-color:transparent;color:#fff;',
    'box-shadow:0 6px 14px rgba(31,111,235,.28);}',
    '.fd-btn.primary:hover{color:#fff;filter:brightness(1.05);}',
    '.fd-btn.danger{border-color:#fecaca;color:#b91c1c;}',
    '.fd-btn.danger:hover{background:#fef2f2;border-color:#ef4444;color:#b91c1c;}',
    '.fd-btn:disabled{cursor:not-allowed;opacity:.5;}',
    /* 主体与分区 */
    '.fd-body{background:#f7f9fb;display:flex;flex-direction:column;gap:14px;overflow:auto;padding:16px 18px 20px;}',
    '.fd-section{background:#fff;border:1px solid #e6ecf3;border-radius:12px;padding:14px 16px;}',
    '.fd-section-head{align-items:baseline;display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;}',
    '.fd-section-head strong{font-size:13.5px;}',
    '.fd-count{background:#eef2f7;border-radius:999px;color:#64748b;font-size:11px;padding:2px 8px;}',
    '.fd-hint{color:#6b7a89;font-size:12px;}',
    '.fd-empty{align-items:center;color:#94a3b8;display:flex;flex-direction:column;gap:8px;padding:26px 0;text-align:center;}',
    '.fd-empty svg{height:22px;opacity:.6;width:22px;}',
    '.fd-login{align-items:flex-end;display:flex;flex-wrap:wrap;gap:12px;}',
    '.fd-login .fd-field{flex:1 1 200px;}',
    '.fd-login .fd-field-action{flex:0 0 auto;}',
    /* 表单 */
    '.fd-field{color:#475569;display:flex;flex-direction:column;font-size:11.5px;gap:5px;min-width:0;}',
    '.fd-field>span{font-weight:600;letter-spacing:.02em;}',
    '.fd-field input,.fd-field textarea,.fd-field select{background:#fff;border:1px solid #d5dee8;border-radius:8px;',
    'color:#1f2a37;font:inherit;font-size:13px;min-width:0;padding:8px 10px;transition:border-color .15s,box-shadow .15s;width:100%;}',
    '.fd-field input:focus,.fd-field textarea:focus,.fd-field select:focus{border-color:#1f6feb;',
    'box-shadow:0 0 0 3px rgba(31,111,235,.12);outline:none;}',
    '.fd-field textarea{line-height:1.6;min-height:110px;resize:vertical;}',
    '.fd-form-grid{display:grid;gap:10px 14px;grid-template-columns:1fr 1fr;}',
    '.fd-field-wide{grid-column:1 / -1;}',
    /* 状态条 */
    '.feedback-dialog .status{border-radius:8px;display:none;font-size:12.5px;margin:12px 18px 0;padding:8px 12px;}',
    '.feedback-dialog .status.ok{background:#ecfdf5;color:#047857;display:block;}',
    '.feedback-dialog .status.error{background:#fef2f2;color:#b91c1c;display:block;}',
    /* 反馈卡片（独立页与弹窗共用） */
    '.feedback-card{background:#fff;border:1px solid #e6ecf3;border-left:4px solid #cbd5e1;border-radius:10px;',
    'margin-bottom:12px;padding:12px 14px;transition:box-shadow .15s;}',
    '.feedback-card:hover{box-shadow:0 6px 18px rgba(15,23,42,.07);}',
    '.feedback-card.status-open{border-left-color:#f59e0b;}',
    '.feedback-card.status-in_progress{border-left-color:#3b82f6;}',
    '.feedback-card.status-resolved{border-left-color:#10b981;}',
    '.feedback-card.status-closed{border-left-color:#94a3b8;}',
    '.feedback-card-head{align-items:flex-start;display:flex;gap:10px;}',
    '.feedback-avatar{align-items:center;background:linear-gradient(135deg,#dbeafe,#bfdbfe);border-radius:50%;color:#1d4ed8;',
    'display:inline-flex;flex:0 0 30px;font-size:12.5px;font-weight:600;height:30px;justify-content:center;width:30px;}',
    '.feedback-title-block{display:flex;flex:1;flex-direction:column;gap:3px;min-width:0;}',
    '.feedback-title-block strong{font-size:13.5px;line-height:1.45;}',
    '.feedback-meta{color:#6b7a89;display:flex;flex-wrap:wrap;font-size:11.5px;gap:4px 10px;}',
    '.feedback-meta a{color:#1f6feb;text-decoration:none;}',
    '.feedback-meta a:hover{text-decoration:underline;}',
    '.feedback-badge{border-radius:999px;flex:0 0 auto;font-size:11px;font-weight:600;padding:3px 10px;white-space:nowrap;}',
    '.feedback-badge.open{background:#fff7ed;color:#b45309;}',
    '.feedback-badge.in_progress{background:#eef4fd;color:#1f6feb;}',
    '.feedback-badge.resolved{background:#ecfdf5;color:#047857;}',
    '.feedback-badge.closed{background:#f1f5f9;color:#64748b;}',
    '.feedback-body-text{color:#334155;font-size:13px;line-height:1.7;margin:9px 0 0;white-space:pre-wrap;word-break:break-word;}',
    '.feedback-note-box{background:#f0f7ff;border-radius:8px;color:#1e3a8a;font-size:12.5px;line-height:1.6;margin-top:10px;',
    'padding:8px 11px;}',
    '.feedback-note-box b{color:#1d4ed8;font-weight:600;}',
    '.feedback-foot{align-items:center;display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:10px;}',
    '.feedback-admin{align-items:center;background:#f8fafc;border:1px dashed #dbe4ee;border-radius:8px;display:flex;',
    'flex:1 1 auto;flex-wrap:wrap;gap:6px;padding:6px 8px;}',
    '.feedback-admin select,.feedback-admin input{border:1px solid #d5dee8;border-radius:6px;font:inherit;font-size:12px;',
    'padding:5px 8px;}'
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
    button.innerHTML = FEEDBACK_ICON + '<span>反馈</span>';
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

  function pageHref(page) {
    var value = String(page || '').trim().replace(/^#\/?/, '').replace(/\.md$/i, '');
    return value ? 'index_all.html#/' + encodeURI(value) : '';
  }

  function canDelete(item) {
    if (state.isAdmin) {
      return true;
    }
    return !!(state.user && item.author_id && state.user.id === item.author_id);
  }

  function feedbackCard(item) {
    var status = state.statuses[item.status] ? item.status : 'open';
    var author = item.author_name || '读者';
    var meta = [
      '<span>#' + item.id + '</span>',
      '<span>' + escapeHtml(author) + '</span>',
      '<span>' + escapeHtml(formatTime(item.created_at)) + '</span>'
    ];
    if (item.page) {
      meta.push('<a href="' + escapeHtml(pageHref(item.page)) + '" target="_blank" rel="noopener" title="打开相关页面">'
        + escapeHtml(item.page) + '</a>');
    }
    var adminTools = state.isAdmin
      ? '<div class="feedback-admin" data-feedback-admin="' + item.id + '">'
        + '<select data-feedback-status>'
        + Object.keys(state.statuses).map(function (key) {
          return '<option value="' + key + '"' + (item.status === key ? ' selected' : '') + '>'
            + escapeHtml(state.statuses[key].label) + '</option>';
        }).join('')
        + '</select>'
        + '<input type="text" data-feedback-note placeholder="处理说明（可选）" value="' + escapeHtml(item.note || '') + '">'
        + '<button type="button" class="fd-btn" data-action="save-progress" data-id="' + item.id + '">保存进度</button>'
        + '</div>'
      : '';
    var deleteButton = canDelete(item)
      ? '<button type="button" class="fd-btn danger" data-action="delete-feedback" data-id="' + item.id + '"'
        + ' title="删除这条反馈（不可恢复）">删除</button>'
      : '';
    return [
      '<article class="feedback-card status-' + escapeHtml(status) + '">',
      '<div class="feedback-card-head">',
      '<span class="feedback-avatar" aria-hidden="true">' + escapeHtml(author.slice(0, 1).toUpperCase()) + '</span>',
      '<div class="feedback-title-block">',
      '<strong>' + escapeHtml(item.title) + '</strong>',
      '<div class="feedback-meta">' + meta.join('') + '</div>',
      '</div>',
      '<span class="feedback-badge ' + escapeHtml(status) + '">' + escapeHtml(statusLabel(item.status)) + '</span>',
      '</div>',
      '<p class="feedback-body-text">' + escapeHtml(item.body) + '</p>',
      item.note
        ? '<div class="feedback-note-box"><b>处理说明：</b>' + escapeHtml(item.note)
          + '<br><span class="feedback-meta">更新于 ' + escapeHtml(formatTime(item.updated_at)) + '</span></div>'
        : '',
      (adminTools || deleteButton) ? '<div class="feedback-foot">' + adminTools + deleteButton + '</div>' : '',
      '</article>'
    ].join('');
  }

  function renderList() {
    var host = query('[data-feedback-list]');
    if (!host) {
      return;
    }
    var count = query('[data-feedback-count]');
    if (count) {
      count.textContent = state.items.length + ' 条';
    }
    if (!state.items.length) {
      host.innerHTML = '<div class="fd-empty">' + FEEDBACK_ICON + '<span>还没有反馈，欢迎提交第一条。</span></div>';
      return;
    }
    host.innerHTML = state.items.map(feedbackCard).join('');
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

  function deleteFeedback(button) {
    var id = Number(button.getAttribute('data-id'));
    var item = state.items.filter(function (entry) { return entry.id === id; })[0];
    var label = item ? '#' + id + '「' + item.title + '」' : '#' + id;
    if (!window.confirm('确定删除反馈 ' + label + '？删除后不可恢复。')) {
      return;
    }
    setStatus('正在删除 ' + label + ' …');
    api('__feedback/delete', { method: 'POST', body: JSON.stringify({ id: id }) }).then(function () {
      setStatus('已删除反馈 ' + label);
      return loadList();
    }).catch(function (error) {
      setStatus('删除失败：' + friendlyError(error), true);
    });
  }

  function saveProgress(button) {
    var id = button.getAttribute('data-id');
    var tools = query('[data-feedback-admin="' + id + '"]');
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
    } else if (action === 'delete-feedback') {
      deleteFeedback(target);
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
