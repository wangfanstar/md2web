(function () {
  'use strict';

  var state = { config: null, csrf: '', authenticated: false, editable: false, busy: false };

  function query(selector, root) {
    return (root || document).querySelector(selector);
  }

  function all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
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

  function showPanels() {
    var fileMode = window.location.protocol === 'file:';
    query('[data-config-file]').hidden = !fileMode;
    query('[data-config-main]').hidden = fileMode;
    query('[data-config-login]').hidden = fileMode || state.authenticated;
    var hint = query('[data-edit-hint]');
    if (hint) {
      hint.hidden = state.editable;
    }
    all('[data-action="save"], [data-action="sync"], [data-action="add-repo"]').forEach(function (button) {
      button.disabled = !state.editable;
    });
  }

  function repoRow(repo, folder) {
    var item = repo || {};
    var disabled = state.editable ? '' : ' disabled';
    var interval = item.syncIntervalSeconds === null || item.syncIntervalSeconds === undefined
      ? '' : String(item.syncIntervalSeconds);
    var mount = (folder && folder.path) || item.mount || '';
    var stateLabel = item.id ? '<span class="status-ok">已配置</span>' : '<span class="status-none">未配置</span>';
    return [
      '<tr data-repo-row>',
      '<td><code>' + escapeHtml(mount) + '</code>'
        + (folder ? '<br><span class="hint">文档 ' + folder.documents + ' 个</span>' : '')
        + '<input type="hidden" data-repo="mount" value="' + escapeHtml(mount) + '">'
        + '<br>' + stateLabel + '</td>',
      '<td><input type="text" data-repo="id" value="' + escapeHtml(item.id) + '" placeholder="如 hardware"' + disabled + '></td>',
      '<td><input type="text" data-repo="url" value="' + escapeHtml(item.url) + '" placeholder="https://svn.example.com/svn/xxx/trunk/docs/"' + disabled + '></td>',
      '<td><input type="text" data-repo="group" value="' + escapeHtml(item.group || '默认') + '" placeholder="默认"' + disabled + '></td>',
      '<td><input type="number" min="0" step="30" data-repo="syncIntervalSeconds" value="' + escapeHtml(interval) + '" placeholder="默认"' + disabled + '></td>',
      '<td><label class="flag"><input type="checkbox" data-repo="readOnly"' + (item.readOnly ? ' checked' : '') + disabled + '>只读</label></td>',
      '<td><label class="flag"><input type="checkbox" data-repo="allowCommit"' + (item.allowCommit === false ? '' : ' checked') + disabled + '>允许合入</label></td>',
      '<td><div class="actions">'
        + '<button type="button" data-action="provision"' + disabled + '>创建并拉取</button>'
        + '<button type="button" class="danger" data-action="remove-repo"' + disabled + '>删除</button>'
        + '</div></td>',
      '</tr>'
    ].join('');
  }

  function renderRepos() {
    var body = query('[data-repo-rows]');
    if (!body) {
      return;
    }
    var repos = (state.config && state.config.repositories) || [];
    var folders = state.folders || [];
    var used = {};
    var rows = folders.map(function (folder) {
      var repo = null;
      for (var index = 0; index < repos.length; index += 1) {
        if (repos[index].mount === folder.path) {
          repo = repos[index];
          used[repos[index].mount] = true;
          break;
        }
      }
      return repoRow(repo, folder);
    });
    repos.forEach(function (repo) {
      if (!used[repo.mount]) {
        rows.push(repoRow(repo, null));
      }
    });
    body.innerHTML = rows.join('')
      || '<tr><td colspan="8" class="hint">docs/md 下还没有文件夹，可先用编辑器右键新建文件夹。</td></tr>';
  }

  function readRepos() {
    return all('[data-repo-row]').map(function (row) {
      function field(name) {
        var input = row.querySelector('[data-repo="' + name + '"]');
        return input ? input.value.trim() : '';
      }
      var interval = field('syncIntervalSeconds');
      return {
        id: field('id'),
        mount: field('mount'),
        url: field('url'),
        group: field('group') || '默认',
        credential_group: field('group') || 'default',
        syncIntervalSeconds: interval === '' ? null : Number(interval),
        readOnly: !!row.querySelector('[data-repo="readOnly"]').checked,
        allowCommit: !!row.querySelector('[data-repo="allowCommit"]').checked
      };
    }).filter(function (repo) {
      return !!(repo.id || repo.url);
    });
  }

  function loadFolders() {
    return api('__folders').then(function (payload) {
      state.folders = payload.folders || [];
      return state.folders;
    }).catch(function () {
      state.folders = [];
      return state.folders;
    });
  }

  function loadConfig() {
    return api('__auth/session').then(function (payload) {
      state.authenticated = !!payload.authenticated && !!(payload.user && payload.user.role === 'admin');
      state.csrf = payload.csrfToken || '';
      if (!state.authenticated) {
        // 未登录：用公开配置先展示所有仓库（只读），登录后即可编辑
        state.editable = false;
        state.config = { repositories: (payload.site && payload.site.repositories) || [] };
        return loadFolders().then(function () {
          renderRepos();
          showPanels();
          setStatus('当前为只读展示：登录管理员账号后可直接修改并保存。');
          return state.config;
        });
      }
      return api('__config').then(function (configPayload) {
        state.config = configPayload.config || {};
        state.editable = true;
        return loadFolders().then(function () {
          renderRepos();
          showPanels();
          return state.config;
        });
      });
    }).catch(function (error) {
      setStatus('读取配置失败：' + error.message, true);
      showPanels();
      return null;
    });
  }

  function login() {
    var username = query('[data-login-username]').value.trim();
    var password = query('[data-login-password]').value;
    setStatus('正在登录…');
    fetch('__auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password, mode: 'admin' })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok || payload.ok === false) {
          throw new Error(payload.error || ('HTTP ' + response.status));
        }
        return payload;
      });
    }).then(function () {
      setStatus('登录成功，正在读取配置…');
      return loadConfig();
    }).catch(function (error) {
      setStatus('登录失败：' + error.message, true);
    });
  }

  function save() {
    if (!state.config) {
      return;
    }
    var payload = JSON.parse(JSON.stringify(state.config));
    payload.repositories = readRepos().map(function (repo) {
      var item = { id: repo.id, mount: repo.mount, url: repo.url, group: repo.group };
      if (repo.syncIntervalSeconds !== null) {
        item.syncIntervalSeconds = repo.syncIntervalSeconds;
      }
      if (repo.readOnly) {
        item.readOnly = true;
      }
      if (!repo.allowCommit) {
        item.allowCommit = false;
      }
      return item;
    });
    setStatus('正在保存配置…');
    api('__config', { method: 'PUT', body: JSON.stringify(payload) }).then(function (result) {
      state.config = result.config || state.config;
      return loadFolders();
    }).then(function () {
      renderRepos();
      setStatus('配置已保存，站点正在按新仓库重建（几秒后刷新总览页即可看到入口页）。');
    }).catch(function (error) {
      setStatus('保存失败：' + error.message, true);
    });
  }

  function provision(button) {
    var row = button.closest('[data-repo-row]');
    var repoId = row ? row.querySelector('[data-repo="id"]').value.trim() : '';
    if (!repoId) {
      setStatus('请先填写仓库 ID 再点「创建并拉取」。', true);
      return;
    }
    setStatus('正在创建目录并从 SVN 拉取 ' + repoId + ' …');
    api('__admin/provision', { method: 'POST', body: JSON.stringify({ id: repoId }) }).then(function (payload) {
      var result = payload.result || {};
      setStatus('已拉取 ' + repoId + '：版本 r' + (result.revision || '?')
        + '，目录 ' + (result.mount || '') + '，文件 ' + ((result.files || []).length) + ' 个。');
    }).catch(function (error) {
      setStatus('拉取失败：' + error.message, true);
    });
  }

  function syncNow() {
    setStatus('正在同步所有仓库…');
    api('__admin/sync', { method: 'POST', body: JSON.stringify({}) }).then(function (payload) {
      var results = payload.results || [];
      setStatus(results.length
        ? '同步完成：' + results.map(function (item) {
          return item.binding + ' → ' + (item.error ? ('失败（' + item.error + '）') : ('r' + item.revision));
        }).join('；')
        : '没有到期的仓库。');
    }).catch(function (error) {
      setStatus('同步失败：' + error.message, true);
    });
  }

  document.addEventListener('click', function (event) {
    var target = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!target) {
      return;
    }
    var action = target.getAttribute('data-action');
    if (action === 'login') {
      login();
    } else if (action === 'add-repo') {
      var body = query('[data-repo-rows]');
      body.insertAdjacentHTML('beforeend', repoRow({ group: '默认', allowCommit: true }));
    } else if (action === 'remove-repo') {
      var row = target.closest('[data-repo-row]');
      if (row) {
        row.remove();
      }
    } else if (action === 'provision') {
      provision(target);
    } else if (action === 'save') {
      save();
    } else if (action === 'sync') {
      syncNow();
    }
  });

  showPanels();
  loadConfig();
}());
