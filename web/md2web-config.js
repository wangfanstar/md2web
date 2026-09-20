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
    all('[data-action="save"], [data-action="sync"], [data-action="add-repo"],'
      + ' [data-action="health-all"], [data-action="health-site"],'
      + ' [data-action="repair-site"], [data-action="recreate-site"]').forEach(function (button) {
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
        + '<br>' + stateLabel
        + (item.id ? ' <a class="entry-link" href="' + escapeHtml(entryPage(item.id)) + '" target="_blank"'
            + ' rel="noopener" title="打开该仓库入口页">入口页</a>' : '')
        + '<br><span class="repo-health" data-health-badge>'
        + (item.id ? (state.editable ? '（待检查）' : '（登录管理员后自动检查）') : '（未配置）') + '</span></td>',
      '<td><input type="text" data-repo="id" value="' + escapeHtml(item.id) + '" placeholder="如 hardware"' + disabled + '></td>',
      '<td><input type="text" data-repo="url" value="' + escapeHtml(item.url) + '" placeholder="https://svn.example.com/svn/xxx/trunk/docs/"' + disabled + '></td>',
      '<td><input type="text" data-repo="group" value="' + escapeHtml(item.group || '默认') + '" placeholder="默认"' + disabled + '></td>',
      '<td><input type="number" min="0" step="30" data-repo="syncIntervalSeconds" value="' + escapeHtml(interval) + '" placeholder="默认"' + disabled + '></td>',
      '<td><label class="flag"><input type="checkbox" data-repo="readOnly"' + (item.readOnly ? ' checked' : '') + disabled + '>只读</label></td>',
      '<td><label class="flag"><input type="checkbox" data-repo="allowCommit"' + (item.allowCommit === false ? '' : ' checked') + disabled + '>允许合入</label></td>',
      '<td><div class="actions">'
        + '<button type="button" data-action="repo-credential"' + disabled + '>同步凭据…</button>'
        + '<button type="button" data-action="health"' + disabled + '>检查</button>'
        + '<button type="button" data-action="repair"' + disabled + '>修复</button>'
        + '<button type="button" data-action="recreate"' + disabled + '>删除重建</button>'
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

  function entryPage(repoId) {
    // 与构建脚本 repo_page_name() 保持一致的命名规则
    var safe = String(repoId || '').replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
    return 'index_' + safe + '.html';
  }

  function savedRepo(repoId) {
    var repos = (state.config && state.config.repositories) || [];
    return repos.some(function (repo) { return repo.id === repoId; });
  }

  function healthLabel(report) {
    return report.id === 'site-backup' ? '网站备份' : report.id;
  }

  function renderHealth(report) {
    var badge = null;
    if (report.id === 'site-backup') {
      badge = query('[data-site-health]');
    } else {
      var rows = all('[data-repo-row]');
      for (var index = 0; index < rows.length; index += 1) {
        var idInput = rows[index].querySelector('[data-repo="id"]');
        if (idInput && idInput.value.trim() === report.id) {
          badge = rows[index].querySelector('[data-health-badge]');
          break;
        }
      }
    }
    if (!badge) {
      return;
    }
    var marker = report.level === 'ok' ? '✔' : (report.level === 'warn' ? '⚠' : '✖');
    badge.textContent = marker + ' ' + report.status + (report.detail ? '（' + report.detail + '）' : '');
    badge.className = 'repo-health is-' + (report.level || 'ok');
    badge.title = [report.detail].concat(report.hints || []).join('\n');
  }

  function checkHealth(repoId, quiet) {
    if (!state.editable) {
      if (!quiet) {
        setStatus('请先用管理员账号登录后再检查仓库状态。', true);
      }
      return Promise.resolve();
    }
    if (repoId && repoId !== 'site-backup' && !savedRepo(repoId)) {
      setStatus('仓库 ' + repoId + ' 还没有保存到配置：请先点「保存配置并重建站点」，再检查/修复。', true);
      return Promise.resolve();
    }
    if (!quiet) {
      setStatus('正在检查' + (repoId ? ' ' + (repoId === 'site-backup' ? '网站备份工作副本' : repoId) : '全部仓库') + ' …');
    }
    return api('__admin/repo-health', {
      method: 'POST',
      body: JSON.stringify(repoId ? { id: repoId } : {})
    }).then(function (payload) {
      (payload.reports || []).forEach(renderHealth);
      if (!quiet) {
        var reports = payload.reports || [];
        if (!reports.length) {
          setStatus(repoId === 'site-backup'
            ? '网站数据备份未配置：填写仓库地址并启用后，才能检查备份状态。'
            : '没有可检查的仓库：请先填写 SVN 地址并保存配置。', true);
        } else {
          var bad = reports.filter(function (item) { return item.level !== 'ok'; });
          setStatus(bad.length
            ? '检查完成：' + bad.length + ' 项需要注意（' + bad.map(function (item) {
              return healthLabel(item) + '：' + item.status;
            }).join('；') + '）'
            : '检查完成：全部正常');
        }
      }
      return payload.reports;
    }).catch(function (error) {
      if (!quiet) {
        setStatus('检查失败：' + error.message, true);
      }
    });
  }

  function repairRepo(repoId, recreate) {
    if (!state.editable) {
      setStatus('请先用管理员账号登录后再修复。', true);
      return;
    }
    var isSite = repoId === 'site-backup';
    if (!isSite && !savedRepo(repoId)) {
      setStatus('仓库 ' + repoId + ' 还没有保存到配置：请先点「保存配置并重建站点」，再检查/修复。', true);
      return;
    }
    var label = recreate ? '删除重建' : '修复';
    var message = recreate
      ? (isSite
        ? '将把网站备份工作副本移动到 data/trash，并立即重新检出、备份一次，确定继续？'
        : '将把本地目录（含未提交的本地修改）移动到 data/trash，再重新从 SVN 拉取 ' + repoId + '。确定继续？')
      : (isSite
        ? '将对网站备份工作副本执行 svn cleanup（修不好会自动移入 data/trash），确定继续？'
        : '将对 ' + repoId + ' 执行 svn cleanup 并强制重新拉取远端内容（覆盖同名文档），确定继续？');
    if (!window.confirm(message)) {
      return;
    }
    setStatus('正在' + label + (isSite ? '网站备份工作副本' : ' ' + repoId) + ' …');
    api(recreate ? '__admin/repo-recreate' : '__admin/repo-repair', {
      method: 'POST',
      body: JSON.stringify({ id: repoId })
    }).then(function (payload) {
      var notes = payload.notes || [];
      setStatus('已' + label + '：' + notes.join('；'));
      return checkHealth(repoId, true);
    }).catch(function (error) {
      setStatus(label + '失败：' + error.message, true);
    });
  }

  function loadCredentials() {
    if (!state.authenticated) {
      state.credentials = {};
      return Promise.resolve(state.credentials);
    }
    return api('__admin/credentials').then(function (payload) {
      state.credentials = payload.credentials || {};
      return state.credentials;
    }).catch(function () {
      state.credentials = {};
      return state.credentials;
    });
  }

  function setCredential(repoId, label) {
    if (!state.editable) {
      setStatus('请先用管理员账号登录后再设置同步凭据。', true);
      return;
    }
    var username = window.prompt('同步账号（' + label + '）用户名', state.credentials[repoId] || '');
    if (!username) {
      return;
    }
    var password = window.prompt('同步账号（' + label + '）密码（加密保存到数据库）');
    if (!password) {
      return;
    }
    api('__admin/repo-credential', {
      method: 'POST',
      body: JSON.stringify({ id: repoId, username: username, password: password })
    }).then(function () {
      setStatus('已保存 ' + label + ' 的同步凭据：' + username);
      return loadCredentials();
    }).catch(function (error) {
      setStatus('保存同步凭据失败：' + error.message, true);
    });
  }

  function renderSiteBackup() {
    var settings = (state.config && state.config.siteBackup) || {};
    var enabled = query('[data-site-backup="enabled"]');
    var url = query('[data-site-backup="url"]');
    var interval = query('[data-site-backup="intervalSeconds"]');
    var message = query('[data-site-backup="message"]');
    if (!enabled) {
      return;
    }
    enabled.checked = !!settings.enabled;
    url.value = settings.url || '';
    interval.value = settings.intervalSeconds === null || settings.intervalSeconds === undefined
      ? 3600 : String(settings.intervalSeconds);
    message.value = settings.message || 'site backup';
    var disabled = state.editable ? '' : ' disabled';
    [enabled, url, interval, message].forEach(function (node) {
      if (node) {
        node.disabled = !state.editable;
      }
    });
    var label = query('[data-site-credential-label]');
    if (label) {
      label.textContent = state.credentials && state.credentials['site-backup']
        ? '已配置凭据：' + state.credentials['site-backup'] : '未配置凭据（回退环境变量）';
    }
    all('[data-action="site-credential"], [data-action="site-backup-now"]').forEach(function (button) {
      button.disabled = !state.editable;
    });
  }

  function readSiteBackup() {
    var enabled = query('[data-site-backup="enabled"]');
    var url = query('[data-site-backup="url"]');
    var interval = query('[data-site-backup="intervalSeconds"]');
    var message = query('[data-site-backup="message"]');
    return {
      enabled: !!(enabled && enabled.checked),
      url: url ? url.value.trim() : '',
      intervalSeconds: interval && interval.value.trim() !== '' ? Number(interval.value.trim()) : 3600,
      include: (state.config && state.config.siteBackup && state.config.siteBackup.include) || ['docs'],
      message: message ? message.value.trim() || 'site backup' : 'site backup'
    };
  }

  function siteBackupNow() {
    setStatus('正在备份网站数据到 SVN…');
    api('__admin/site-backup', { method: 'POST', body: JSON.stringify({}) }).then(function (payload) {
      var result = payload.result || {};
      setStatus(result.updated
        ? '已备份到 SVN：r' + (result.revision || '?') + '（' + (result.files || []).join('、') + '）'
        : '没有需要提交的变更（' + (result.message || '') + '）');
    }).catch(function (error) {
      setStatus('备份失败：' + error.message, true);
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
          renderSiteBackup();
          showPanels();
          var siteBadge = query('[data-site-health]');
          if (siteBadge) {
            siteBadge.textContent = '（登录管理员后自动检查）';
          }
          setStatus('当前为只读展示：登录管理员账号后可直接修改并保存。');
          return state.config;
        });
      }
      return api('__config').then(function (configPayload) {
        state.config = configPayload.config || {};
        state.editable = true;
        return loadFolders().then(function () {
          return loadCredentials();
        }).then(function () {
          renderRepos();
          renderSiteBackup();
          showPanels();
          checkHealth(null, true);
          return state.config;
        });
      });
    }).catch(function (error) {
      setStatus(error.status === 404
        ? '当前服务未启用配置接口（只读预览）：请用 python serve.py 启动认证服务后再打开本页。'
        : '读取配置失败：' + error.message, true);
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
    payload.siteBackup = readSiteBackup();
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
      renderSiteBackup();
      setStatus('配置已保存，站点正在按新仓库重建（几秒后刷新总览页即可看到入口页）。');
      checkHealth(null, true);
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
    if (!savedRepo(repoId)) {
      setStatus('仓库 ' + repoId + ' 还没有保存到配置：请先点「保存配置并重建站点」，再「创建并拉取」。', true);
      return;
    }
    setStatus('正在创建目录并从 SVN 拉取 ' + repoId + ' …');
    api('__admin/provision', { method: 'POST', body: JSON.stringify({ id: repoId }) }).then(function (payload) {
      var result = payload.result || {};
      setStatus('已拉取 ' + repoId + '：版本 r' + (result.revision || '?')
        + '，目录 ' + (result.mount || '') + '，文件 ' + ((result.files || []).length) + ' 个。');
      return checkHealth(repoId, true);
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
    } else if (action === 'health-all') {
      checkHealth(null, false);
    } else if (action === 'health-site') {
      checkHealth('site-backup', false);
    } else if (action === 'repair-site' || action === 'recreate-site') {
      repairRepo('site-backup', action === 'recreate-site');
    } else if (action === 'health' || action === 'repair' || action === 'recreate') {
      var targetRow = target.closest('[data-repo-row]');
      var targetId = targetRow ? targetRow.querySelector('[data-repo="id"]').value.trim() : '';
      if (!targetId) {
        setStatus('请先填写仓库 ID。', true);
        return;
      }
      if (action === 'health') {
        checkHealth(targetId, false);
      } else {
        repairRepo(targetId, action === 'recreate');
      }
    } else if (action === 'repo-credential') {
      var row = target.closest('[data-repo-row]');
      var repoId = row ? row.querySelector('[data-repo="id"]').value.trim() : '';
      var mount = row ? row.querySelector('[data-repo="mount"]').value.trim() : '';
      if (!repoId) {
        setStatus('请先填写仓库 ID 再设置同步凭据。', true);
        return;
      }
      setCredential(repoId, mount || repoId);
    } else if (action === 'site-credential') {
      setCredential('site-backup', '网站数据备份');
    } else if (action === 'site-backup-now') {
      siteBackupNow();
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
