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

  function formatBytes(bytes) {
    var value = Number(bytes) || 0;
    if (value < 1024) {
      return value + ' B';
    }
    var units = ['KB', 'MB', 'GB', 'TB'];
    var index = -1;
    do {
      value = value / 1024;
      index += 1;
    } while (value >= 1024 && index < units.length - 1);
    return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[index];
  }

  function formatTime(value) {
    if (!value) {
      return '';
    }
    var text = String(value);
    var parsed = new Date(text);
    if (!isNaN(parsed.getTime())) {
      return parsed.toLocaleString('zh-CN', { hour12: false });
    }
    return text.replace('T', ' ').replace('Z', '').slice(0, 16);
  }

  function latestUpdateCell(folder) {
    var update = (folder && folder.latestUpdate) || null;
    if (!update) {
      return '<span class="hint">—</span>';
    }
    var author = update.author ? escapeHtml(update.author) : '<span class="hint">—</span>';
    var note = update.source === 'publish'
      ? (update.path ? '最近提交：' + update.path : '最近发布记录')
      : '没有发布记录，按最新文件修改时间';
    return author + '<br><span class="hint" title="' + escapeHtml(note) + '">'
      + escapeHtml(formatTime(update.at)) + '</span>';
  }

  function initialBadge(item, svnEnabled) {
    if (!item.id) {
      return '（未配置）';
    }
    if (!svnEnabled) {
      return '（本地模式）';
    }
    return state.editable ? '（待检查）' : '（登录管理员后自动检查）';
  }

  function sizeCell(folder) {
    if (!folder) {
      return '<span class="hint">—</span>';
    }
    var lines = ['<strong>' + formatBytes(folder.sizeBytes) + '</strong>'
      + ' <span class="hint">共 ' + (folder.files || 0) + ' 个文件</span>'];
    lines.push('<span class="hint">文档 ' + (folder.mdFiles || 0) + ' 个 · '
      + formatBytes(folder.mdBytes || 0) + '</span>');
    lines.push('<span class="hint">附件 ' + (folder.otherFiles || 0) + ' 个 · '
      + formatBytes(folder.otherBytes || 0) + '</span>');
    if (folder.subfolders) {
      lines.push('<span class="hint" title="子文件夹内的文件已计入上面的文档/附件">子文件夹 '
        + folder.subfolders + ' 个（含 ' + (folder.nestedFiles || 0) + ' 个文件 · '
        + formatBytes(folder.nestedBytes || 0) + '）</span>');
    }
    return lines.join('<br>');
  }

  function repoRow(repo, folder, index) {
    var item = repo || {};
    var disabled = state.editable ? '' : ' disabled';
    var pair = 'repo-' + index;
    var interval = item.syncIntervalSeconds === null || item.syncIntervalSeconds === undefined
      ? '' : String(item.syncIntervalSeconds);
    var mount = (folder && folder.path) || item.mount || '';
    var manual = !folder;
    var svnEnabled = item.sourceMode ? item.sourceMode === 'svn' : !!item.id;
    // 入口页：已配置仓库用仓库 ID；未配置的文件夹用文件夹名（构建会生成同名入口页）
    var linkKey = item.id || (folder && folder.name) || '';
    return [
      '<tr data-repo-row data-pair="' + pair + '" data-mount="' + escapeHtml(mount) + '"'
        + ' data-name="' + escapeHtml((folder && folder.name) || '') + '">',
      '<td>' + (manual
        ? '<input type="text" data-repo="mount" value="' + escapeHtml(item.mount || '') + '" placeholder="md/文件夹名"' + disabled + '>'
        : '<code>' + escapeHtml((folder && folder.name) || mount.replace(/^md\//, ''))
          + '</code><input type="hidden" data-repo="mount" value="' + escapeHtml(mount) + '">')
        + '</td>',
      '<td data-entry-cell>' + (linkKey
        ? '<a class="entry-link" href="' + escapeHtml(entryPage(linkKey)) + '" target="_blank"'
          + ' rel="noopener" title="打开该文件夹的入口页">' + escapeHtml(entryPage(linkKey)) + '</a>'
        : '<span class="hint">—</span>') + '</td>',
      '<td>' + latestUpdateCell(folder) + '</td>',
      '<td>' + sizeCell(folder) + '</td>',
      '<td><span class="repo-health" data-health-badge>' + initialBadge(item, svnEnabled) + '</span>'
        + '<br><span class="hint" data-mode-cell>'
        + (item.id && !svnEnabled ? '本地模式：' + escapeHtml(item.id) : '') + '</span></td>',
      '<td><label class="flag"><input type="checkbox" data-repo="svnEnabled"'
        + (svnEnabled ? ' checked' : '') + '>配置 SVN</label></td>',
      '</tr>',
      '<tr data-pair-detail="' + pair + '"' + (svnEnabled ? '' : ' hidden') + '>',
      '<td colspan="6"><div class="repo-detail">',
      '<label>仓库 ID<input type="text" data-repo="id" value="' + escapeHtml(item.id)
        + '" placeholder="如 hardware"' + disabled + '></label>',
      '<label>SVN 地址<input type="text" data-repo="url" value="' + escapeHtml(item.url)
        + '" placeholder="https://svn.example.com/svn/xxx/trunk/docs/"' + disabled + '></label>',
      '<label>分组<input type="text" data-repo="group" value="' + escapeHtml(item.group || '默认')
        + '" placeholder="默认"' + disabled + '></label>',
      '<label>更新频率（秒）<input type="number" min="0" step="30" data-repo="syncIntervalSeconds" value="'
        + escapeHtml(interval) + '" placeholder="默认"' + disabled + '></label>',
      '<label class="flag"><input type="checkbox" data-repo="readOnly"'
        + (item.readOnly ? ' checked' : '') + disabled + '>只读</label>',
      '<label class="flag"><input type="checkbox" data-repo="allowCommit"'
        + (item.allowCommit === false ? '' : ' checked') + disabled + '>允许合入</label>',
      '</div>',
      '<div class="actions">'
        + '<button type="button" data-action="repo-credential"' + disabled + '>同步凭据…</button>'
        + '<button type="button" data-action="health"' + disabled + '>检查</button>'
        + '<button type="button" data-action="repair"' + disabled + '>修复</button>'
        + '<button type="button" data-action="recreate"' + disabled + '>删除重建</button>'
        + '<button type="button" data-action="provision"' + disabled + '>创建并拉取</button>'
        + '<button type="button" class="danger" data-action="remove-repo"' + disabled + '>移除配置</button>'
        + '</div></td></tr>'
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
    var rows = [];
    var index = 0;
    folders.forEach(function (folder) {
      var repo = null;
      for (var i = 0; i < repos.length; i += 1) {
        if (repos[i].mount === folder.path) {
          repo = repos[i];
          used[repos[i].mount] = true;
          break;
        }
      }
      rows.push(repoRow(repo, folder, index));
      index += 1;
    });
    repos.forEach(function (repo) {
      if (!used[repo.mount]) {
        rows.push(repoRow(repo, null, index));
        index += 1;
      }
    });
    body.innerHTML = rows.join('')
      || '<tr><td colspan="6" class="hint">docs/md 下还没有文件夹，可先用编辑器右键新建文件夹。</td></tr>';
  }

  function pairOf(node) {
    var row = node.closest ? (node.closest('[data-pair-detail]') || node.closest('[data-repo-row]')) : null;
    if (!row) {
      return null;
    }
    var pair = row.getAttribute('data-pair') || row.getAttribute('data-pair-detail');
    return {
      summary: query('[data-repo-row][data-pair="' + pair + '"]'),
      detail: query('[data-pair-detail="' + pair + '"]')
    };
  }

  function pairField(entry, name) {
    var input = entry && entry.detail ? entry.detail.querySelector('[data-repo="' + name + '"]') : null;
    return input ? input.value.trim() : '';
  }

  function rowForRepoId(repoId) {
    var rows = all('[data-repo-row]');
    for (var index = 0; index < rows.length; index += 1) {
      var entry = pairOf(rows[index]);
      if (entry && pairField(entry, 'id') === repoId) {
        return entry;
      }
    }
    return null;
  }

  function updateSummary(entry) {
    if (!entry || !entry.summary) {
      return;
    }
    var id = pairField(entry, 'id') || entry.summary.getAttribute('data-name') || '';
    var toggle = entry.summary.querySelector('[data-repo="svnEnabled"]');
    var linkCell = entry.summary.querySelector('[data-entry-cell]');
    if (linkCell) {
      linkCell.innerHTML = id
        ? '<a class="entry-link" href="' + escapeHtml(entryPage(id)) + '" target="_blank"'
          + ' rel="noopener" title="打开该文件夹的入口页">' + escapeHtml(entryPage(id)) + '</a>'
        : '<span class="hint">—</span>';
    }
    var repoId = pairField(entry, 'id');
    var modeCell = entry.summary.querySelector('[data-mode-cell]');
    if (modeCell) {
      modeCell.textContent = repoId && toggle && !toggle.checked ? '本地模式：' + repoId : '';
    }
  }

  function readRepos() {
    return all('[data-repo-row]').map(function (row) {
      var entry = pairOf(row);
      var toggle = row.querySelector('[data-repo="svnEnabled"]');
      var svnEnabled = !!(toggle && toggle.checked);
      var interval = pairField(entry, 'syncIntervalSeconds');
      var repo = {
        id: pairField(entry, 'id'),
        mount: pairField(entry, 'mount') || row.getAttribute('data-mount') || '',
        group: pairField(entry, 'group') || '默认',
        sourceMode: svnEnabled ? 'svn' : 'local',
        url: svnEnabled ? pairField(entry, 'url') : '',
        readOnly: !!(entry && entry.detail.querySelector('[data-repo="readOnly"]').checked),
        allowCommit: !!(entry && entry.detail.querySelector('[data-repo="allowCommit"]').checked)
      };
      repo.credential_group = repo.group;
      if (svnEnabled && interval !== '') {
        repo.syncIntervalSeconds = Number(interval);
      }
      return repo;
    }).filter(function (repo) {
      return !!(repo.id || repo.url);
    });
  }

  function validateRepos(repos) {
    for (var index = 0; index < repos.length; index += 1) {
      var repo = repos[index];
      if (!repo.id) {
        return '第 ' + (index + 1) + ' 行缺少仓库 ID（不需要该仓库请点「移除配置」）。';
      }
      if (repo.sourceMode === 'svn' && !repo.url) {
        return '仓库 ' + repo.id + ' 勾选了 SVN 但缺少地址：请填写 SVN 地址，或取消勾选使用本地模式。';
      }
    }
    return '';
  }

  function switchedToLocal(repos) {
    var previous = {};
    ((state.config && state.config.repositories) || []).forEach(function (item) {
      previous[item.id] = item;
    });
    return repos.filter(function (repo) {
      var old = previous[repo.id];
      return old && old.sourceMode !== 'local' && repo.sourceMode === 'local';
    });
  }

  function entryPage(repoId) {
    // 与构建脚本 repo_page_name() 保持一致的命名规则（保留中文等 CJK 字符）
    var safe = String(repoId || '').replace(/[^0-9A-Za-z._㐀-䶿一-鿿-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'repo';
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
      var entry = rowForRepoId(report.id);
      badge = entry && entry.summary ? entry.summary.querySelector('[data-health-badge]') : null;
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
    var repos = readRepos();
    var problem = validateRepos(repos);
    if (problem) {
      setStatus(problem, true);
      return;
    }
    var switched = switchedToLocal(repos);
    if (switched.length && !window.confirm('以下仓库将改为本地模式（清空 SVN 地址，不再从 SVN 自动同步）：'
        + switched.map(function (repo) { return repo.id; }).join('、') + '。确定继续？')) {
      return;
    }
    var payload = JSON.parse(JSON.stringify(state.config));
    payload.siteBackup = readSiteBackup();
    payload.repositories = repos.map(function (repo) {
      var item = {
        id: repo.id, mount: repo.mount, group: repo.group,
        sourceMode: repo.sourceMode, url: repo.url
      };
      if (repo.sourceMode === 'svn' && repo.syncIntervalSeconds !== undefined
          && repo.syncIntervalSeconds !== null) {
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
    var repoId = pairField(pairOf(button), 'id');
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

  function refreshFolders() {
    setStatus('正在重新统计文件夹信息…');
    return api('__folders').then(function (payload) {
      state.folders = payload.folders || [];
      renderRepos();
      setStatus('文件夹信息已更新（大小/文件数/最新更新）。');
      if (state.editable) {
        checkHealth(null, true);
      }
    }).catch(function (error) {
      setStatus('刷新失败：' + error.message, true);
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
      var nextIndex = all('[data-repo-row]').length;
      body.insertAdjacentHTML('beforeend', repoRow({ group: '默认', allowCommit: true }, null, nextIndex));
    } else if (action === 'remove-repo') {
      var entry = pairOf(target);
      if (entry && entry.detail && window.confirm('移除该文件夹的仓库配置（保存后生效）？')) {
        var idInput = entry.detail.querySelector('[data-repo="id"]');
        var urlInput = entry.detail.querySelector('[data-repo="url"]');
        if (idInput) {
          idInput.value = '';
        }
        if (urlInput) {
          urlInput.value = '';
        }
        var toggle = entry.summary ? entry.summary.querySelector('[data-repo="svnEnabled"]') : null;
        if (toggle) {
          toggle.checked = false;
        }
        entry.detail.hidden = true;
        updateSummary(entry);
        setStatus('已移除该文件夹的仓库配置（点「保存配置并重建站点」后生效）。');
      }
    } else if (action === 'refresh-folders') {
      refreshFolders();
    } else if (action === 'health-all') {
      checkHealth(null, false);
    } else if (action === 'health-site') {
      checkHealth('site-backup', false);
    } else if (action === 'repair-site' || action === 'recreate-site') {
      repairRepo('site-backup', action === 'recreate-site');
    } else if (action === 'health' || action === 'repair' || action === 'recreate') {
      var targetId = pairField(pairOf(target), 'id');
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
      var entry = pairOf(target);
      var repoId = pairField(entry, 'id');
      var mount = pairField(entry, 'mount');
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

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.getAttribute) {
      return;
    }
    var name = target.getAttribute('data-repo');
    if (name !== 'svnEnabled' && name !== 'id') {
      return;
    }
    var entry = pairOf(target);
    if (!entry || !entry.detail) {
      return;
    }
    if (name === 'svnEnabled') {
      entry.detail.hidden = !target.checked;
      if (target.checked) {
        var idInput = entry.detail.querySelector('[data-repo="id"]');
        var urlInput = entry.detail.querySelector('[data-repo="url"]');
        if (idInput && !idInput.value.trim()) {
          idInput.focus();
        } else if (urlInput && !urlInput.value.trim()) {
          urlInput.focus();
        }
      } else if (pairField(entry, 'id')) {
        setStatus('取消勾选后该仓库将按本地模式（SQLite 主库）保存，SVN 地址会被清空。');
      }
      updateSummary(entry);
      return;
    }
    var badge = entry.summary ? entry.summary.querySelector('[data-health-badge]') : null;
    if (badge) {
      badge.className = 'repo-health';
      badge.textContent = '（保存后重新检查）';
      badge.title = '';
    }
    updateSummary(entry);
  });

  showPanels();
  loadConfig();
}());
