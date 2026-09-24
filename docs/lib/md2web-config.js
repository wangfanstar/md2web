(function () {
  'use strict';

  var state = { config: null, csrf: '', authenticated: false, editable: false, busy: false, user: null,
    credentials: {}, defaultCredential: { configured: false, username: '' }, authFingerprint: '' };

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
      + ' [data-action="repair-site"], [data-action="recreate-site"],'
      + ' [data-action="auth-save"], [data-action="auth-test"],'
      + ' [data-action="default-credential"],'
      + ' [data-action="verify-account"], [data-action="verify-switch"]').forEach(function (button) {
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
    var credential = credentialInfo(item.id);
    // 入口页命名：已配置仓库用仓库 ID；未配置文件夹用文件夹名（与构建生成规则一致）
    var linkKey = item.id || (folder && folder.name) || '';
    var allow = !(item.allowCommit === false || item.readOnly);
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
      '<td><input type="text" class="folder-group-input" data-folder-group="' + escapeHtml(mount)
        + '" value="' + escapeHtml(folderGroup(mount)) + '" placeholder="默认"' + disabled + '></td>',
      '<td>' + latestUpdateCell(folder) + '</td>',
      '<td>' + sizeCell(folder) + '</td>',
      '<td><span class="repo-health" data-health-badge>' + initialBadge(item, svnEnabled) + '</span>'
        + '<br><span class="hint" data-mode-cell>'
        + (!svnEnabled && (item.id || autoRepoId(folder, item))
          ? '本地模式：' + escapeHtml(item.id || autoRepoId(folder, item)) : '') + '</span>'
        + (allow ? '' : '<br><span class="repo-readonly">只读：由服务器自动更新</span>') + '</td>',
      '<td><label class="flag"><input type="checkbox" data-repo="svnEnabled"'
        + (svnEnabled ? ' checked' : '') + '>启用 SVN</label></td>',
      '</tr>',
      '<tr data-pair-detail="' + pair + '"' + (svnEnabled ? '' : ' hidden') + '>',
      '<td colspan="7"><div class="repo-detail">',
      '<input type="hidden" data-repo="id" value="' + escapeHtml(item.id || '') + '">',
      '<label class="repo-field repo-field-url"><span>SVN 地址</span><input type="text" data-repo="url" value="' + escapeHtml(item.url)
        + '" placeholder="https://svn.example.com/svn/xxx/trunk/docs/"' + disabled + '></label>',
      '<label class="repo-field repo-field-interval"><span>更新频率（秒）</span><input type="number" min="0" step="30" data-repo="syncIntervalSeconds" value="'
        + escapeHtml(interval) + '" placeholder="默认"' + disabled + '></label>',
      '<div class="repo-credential">',
      '<label class="repo-field"><span>同步账号</span><input type="text" data-repo="credUsername" placeholder="SVN 用户名" autocomplete="off" value="'
        + escapeHtml(credential.username) + '"' + disabled + '></label>',
      '<label class="repo-field"><span>密码</span><input type="password" data-repo="credPassword" placeholder="保存时填写，不回显" autocomplete="new-password"'
        + disabled + '></label>',
      '<div class="repo-credential-actions">',
      '<button type="button" data-action="repo-credential"' + disabled + '>保存凭据</button>',
      '<span class="hint repo-credential-status' + (credential.cls ? ' ' + credential.cls : '') + '">'
        + escapeHtml(credential.status) + '</span>',
      '</div>',
      '</div>',
      '<div class="repo-flags">',
      '<label class="flag" title="' + (svnEnabled
        ? '勾选后允许登录用户把草稿合入 SVN 库；取消勾选则网页只读，内容由服务器定时同步更新'
        : '勾选后允许登录用户在线编辑并发布到本地库；取消勾选则网页只读，内容由服务器自动更新') + '">'
        + '<input type="checkbox" data-repo="allowCommit"'
        + (allow ? ' checked' : '') + disabled + '>'
        + (svnEnabled ? '允许合入 SVN 库' : '允许在线修改') + '</label>',
      '<span class="hint perm-hint" data-perm-hint>'
        + (allow ? '' : '未勾选：网页为只读，内容由服务器自动更新') + '</span>',
      '</div>',
      '</div>',
      '<div class="actions">'
        + '<button type="button" data-action="health"' + disabled + '>检查</button>'
        + '<button type="button" data-action="repair"' + disabled + '>修复</button>'
        + '<button type="button" data-action="recreate"' + disabled + '>删除重建</button>'
        + '<button type="button" data-action="provision"' + disabled + '>创建并拉取</button>'
        + '<button type="button" class="danger" data-action="remove-repo"' + disabled + '>移除映射</button>'
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
    var usedIds = Object.create(null);
    usedIds['site-backup'] = true;
    usedIds['__default__'] = true;  // 默认同步凭据的保留 id，自动生成仓库 ID 时避开
    var existing = (state.config && state.config.repositories) || [];
    existing.forEach(function (item) { if (item.id) { usedIds[item.id] = true; } });
    return all('[data-repo-row]').map(function (row) {
      var entry = pairOf(row);
      var toggle = row.querySelector('[data-repo="svnEnabled"]');
      var svnEnabled = !!(toggle && toggle.checked);
      var interval = pairField(entry, 'syncIntervalSeconds');
      var allow = !!(entry && entry.detail.querySelector('[data-repo="allowCommit"]').checked);
      var mount = pairField(entry, 'mount') || row.getAttribute('data-mount') || '';
      if (!mount) {
        mount = row.getAttribute('data-mount') || '';
      }
      // 仓库 ID 一律由系统生成：既有仓库沿用保存的 ID，新文件夹按名称生成（本地/SVN 一致）
      var repoId = pairField(entry, 'id');
      if (row.getAttribute('data-repo-removed') === '1') {
        return null;
      }
      if (!repoId) {
        var folderName = row.getAttribute('data-name') || mount.replace(/^md\//, '');
        repoId = folderName ? slugId(folderName) : '';
        var baseId = repoId;
        var suffix = 2;
        while (repoId && usedIds[repoId]) {
          repoId = baseId + '-' + suffix;
          suffix += 1;
        }
      }
      if (!repoId && !svnEnabled && !allow) {
        return null;  // 未配置 SVN 且只读：不创建映射（仅保留分组）
      }
      var repo = {
        id: repoId,
        mount: mount,
        group: folderGroup(mount) || '默认',
        sourceMode: svnEnabled ? 'svn' : 'local',
        url: svnEnabled ? pairField(entry, 'url') : '',
        // 单一权限开关：勾选=允许（合入 SVN / 在线修改），未勾选=只读（服务器自动更新）
        readOnly: !allow,
        allowCommit: allow
      };
      repo.credential_group = repo.group;
      if (repoId) { usedIds[repoId] = true; }
      if (svnEnabled && interval !== '') {
        repo.syncIntervalSeconds = Number(interval);
      }
      return repo;
    }).filter(function (repo) {
      return !!repo && !!(repo.id || repo.url);
    });
  }

  function validateRepos(repos) {
    for (var index = 0; index < repos.length; index += 1) {
      var repo = repos[index];
      if (repo.syncIntervalSeconds !== undefined && repo.syncIntervalSeconds !== null
          && repo.syncIntervalSeconds !== ''
          && (!isFinite(Number(repo.syncIntervalSeconds)) || Number(repo.syncIntervalSeconds) < 0)) {
        return '仓库 ' + repo.id + ' 的更新频率必须是大于等于 0 的有限数值。';
      }
      if (!repo.id) {
        return '第 ' + (index + 1) + ' 行无法生成仓库 ID：请检查文件夹名，或点「移除映射」。';
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

  function folderGroup(mount) {
    var groups = (state.config && state.config.folderGroups) || {};
    if (groups[mount]) {
      return groups[mount];
    }
    var repos = (state.config && state.config.repositories) || [];
    for (var index = 0; index < repos.length; index += 1) {
      if (repos[index].mount === mount) {
        return repos[index].group || '默认';
      }
    }
    return '默认';
  }

  // 仓库 ID 由系统生成：已配置的仓库保留原 ID（避免绑定/凭据失效），新文件夹按名称生成
  function autoRepoId(folder, item) {
    if (item && item.id) {
      return item.id;
    }
    var name = (folder && folder.name) || String((item && item.mount) || '').replace(/^md\//, '');
    return name ? slugId(name) : '';
  }

  function slugId(value) {
    // 与 entryPage()/repo_page_name() 一致：保留中文等 CJK 字符（否则中文文件夹名会全部塌缩成 local）
    return String(value || '').trim().replace(/[^0-9A-Za-z._㐀-䶿一-鿿-]+/g, '-').replace(/^-+|-+$/g, '') || 'local';
  }

  function entryPage(repoId) {
    // 与构建脚本 repo_page_name() 保持一致的命名规则（保留中文等 CJK 字符）
    var safe = String(repoId || '').replace(/[^0-9A-Za-z._㐀-䶿一-鿿-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'repo';
    // 站点页面在 docs/html/ 下，用站点根相对路径（页面带 <base href="../">）
    return 'html/index_' + safe + '.html';
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

  function loadDefaultCredential() {
    if (!state.authenticated) {
      state.defaultCredential = { configured: false, username: '' };
      return Promise.resolve(state.defaultCredential);
    }
    return api('__admin/default-credential').then(function (payload) {
      state.defaultCredential = payload.credential || { configured: false, username: '' };
      return state.defaultCredential;
    }).catch(function () {
      state.defaultCredential = { configured: false, username: '' };
      return state.defaultCredential;
    });
  }

  function credentialInfo(repoId) {
    var own = (state.credentials && state.credentials[repoId]) || '';
    if (own) {
      return { username: own, status: '已单独配置：' + own, cls: 'is-own' };
    }
    var fallback = (state.defaultCredential && state.defaultCredential.username) || '';
    if (fallback) {
      return { username: '', status: '跟随默认凭据（' + fallback + '）', cls: 'is-default' };
    }
    return { username: '', status: '未配置（同步时回退环境变量）', cls: '' };
  }

  function updateCredentialStatus(entry) {
    if (!entry || !entry.detail) {
      return;
    }
    var info = credentialInfo(pairField(entry, 'id'));
    var status = entry.detail.querySelector('.repo-credential-status');
    if (status) {
      status.textContent = info.status;
      status.className = 'hint repo-credential-status' + (info.cls ? ' ' + info.cls : '');
    }
    var username = entry.detail.querySelector('[data-repo="credUsername"]');
    if (username && !username.value && info.username) {
      username.value = info.username;
    }
  }

  function renderSiteCredentialStatus() {
    var usernameNode = query('[data-site-credential="username"]');
    var label = query('[data-site-credential-label]');
    var own = (state.credentials && state.credentials['site-backup']) || '';
    var fallback = (state.defaultCredential && state.defaultCredential.username) || '';
    if (usernameNode && !usernameNode.value && own) {
      usernameNode.value = own;
    }
    if (label) {
      label.textContent = own
        ? '已单独配置：' + own
        : (fallback ? '未单独配置：跟随默认凭据（' + fallback + '）' : '未配置凭据（回退环境变量）');
    }
  }

  function refreshCredentialStatuses() {
    all('[data-repo-row]').forEach(function (row) {
      updateCredentialStatus(pairOf(row));
    });
    renderSiteCredentialStatus();
  }

  function saveRepoCredential(button) {
    if (!state.editable) {
      setStatus('请先用管理员账号登录后再保存同步凭据。', true);
      return;
    }
    var entry = pairOf(button);
    var repoId = pairField(entry, 'id');
    var label = pairField(entry, 'mount') || repoId;
    if (!repoId) {
      setStatus('仓库 ID 由系统按文件夹名生成，请先保存配置后再保存同步凭据。', true);
      return;
    }
    var usernameInput = entry.detail.querySelector('[data-repo="credUsername"]');
    var passwordInput = entry.detail.querySelector('[data-repo="credPassword"]');
    var username = usernameInput ? usernameInput.value.trim() : '';
    var password = passwordInput ? passwordInput.value : '';
    if (!username || !password) {
      setStatus('请填写 ' + label + ' 的同步账号与密码（保存后优先于默认凭据）。', true);
      return;
    }
    api('__admin/repo-credential', {
      method: 'POST',
      body: JSON.stringify({ id: repoId, username: username, password: password })
    }).then(function () {
      state.credentials[repoId] = username;
      if (passwordInput) {
        passwordInput.value = '';
      }
      updateCredentialStatus(entry);
      setStatus('已保存 ' + label + ' 的同步凭据：' + username + '（优先于默认凭据）');
    }).catch(function (error) {
      setStatus('保存同步凭据失败：' + error.message, true);
    });
  }

  function saveSiteCredential() {
    if (!state.editable) {
      setStatus('请先用管理员账号登录后再保存备份凭据。', true);
      return;
    }
    var usernameNode = query('[data-site-credential="username"]');
    var passwordNode = query('[data-site-credential="password"]');
    var username = usernameNode ? usernameNode.value.trim() : '';
    var password = passwordNode ? passwordNode.value : '';
    if (!username || !password) {
      setStatus('请填写网站备份的同步账号与密码。', true);
      return;
    }
    api('__admin/repo-credential', {
      method: 'POST',
      body: JSON.stringify({ id: 'site-backup', username: username, password: password })
    }).then(function () {
      state.credentials['site-backup'] = username;
      if (passwordNode) {
        passwordNode.value = '';
      }
      renderSiteCredentialStatus();
      setStatus('已保存网站备份凭据：' + username);
    }).catch(function (error) {
      setStatus('保存备份凭据失败：' + error.message, true);
    });
  }

  function renderDefaultCredentialPanel() {
    var urlInput = query('[data-default="url"]');
    var usernameInput = query('[data-default="username"]');
    var passwordInput = query('[data-default="password"]');
    var label = query('[data-default-credential-label]');
    var auth = (state.config && state.config.auth) || {};
    if (urlInput) {
      urlInput.value = state.editable ? (auth.url || '') : '';
      urlInput.disabled = !state.editable;
      urlInput.placeholder = state.editable
        ? 'https://svn.example.com/svn/accounts/auth-check/'
        : '登录管理员后可查看/修改';
    }
    if (usernameInput) {
      usernameInput.value = (state.defaultCredential && state.defaultCredential.username) || '';
      usernameInput.disabled = !state.editable;
    }
    if (passwordInput) {
      passwordInput.disabled = !state.editable;
    }
    if (label) {
      label.textContent = (state.defaultCredential && state.defaultCredential.username)
        ? '已配置默认凭据：' + state.defaultCredential.username
        : (state.authenticated ? '未配置默认凭据（同步时回退环境变量）' : '登录管理员后可配置默认同步凭据');
    }
  }

  function saveDefaultCredential() {
    if (!state.editable) {
      setStatus('请先用管理员账号登录后再保存默认同步凭据。', true);
      return;
    }
    var urlNode = query('[data-default="url"]');
    var usernameNode = query('[data-default="username"]');
    var passwordNode = query('[data-default="password"]');
    var url = urlNode ? urlNode.value.trim() : '';
    var username = usernameNode ? usernameNode.value.trim() : '';
    var password = passwordNode ? passwordNode.value : '';
    if (!username || !password) {
      setStatus('请填写默认同步账号与密码（保存前会用 SVN 认证路径校验）。', true);
      return;
    }
    var currentUrl = ((state.config && state.config.auth) || {}).url || '';
    var chain = Promise.resolve();
    if (url && url !== currentUrl) {
      var payload = JSON.parse(JSON.stringify(state.config));
      payload.auth = Object.assign({}, payload.auth || {}, { url: url });
      setStatus('正在保存 SVN 认证路径…');
      chain = api('__config', { method: 'PUT', body: JSON.stringify(payload) }).then(function (result) {
        state.config = result.config || state.config;
      });
    }
    chain.then(function () {
      setStatus('正在通过 SVN 认证路径校验账号 ' + username + ' …');
      return api('__admin/default-credential', {
        method: 'POST',
        body: JSON.stringify({ username: username, password: password })
      });
    }).then(function (payload) {
      state.defaultCredential = { configured: true, username: payload.username || username };
      if (passwordNode) {
        passwordNode.value = '';
      }
      renderDefaultCredentialPanel();
      renderAuthPanel();
      refreshCredentialStatuses();
      setStatus(payload.message || ('默认同步凭据已保存：' + state.defaultCredential.username));
    }).catch(function (error) {
      setStatus('保存默认同步凭据失败：' + error.message, true);
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
    var siteUser = query('[data-site-credential="username"]');
    if (siteUser) {
      siteUser.value = (state.credentials && state.credentials['site-backup']) || '';
    }
    all('[data-site-credential]').forEach(function (node) {
      node.disabled = !state.editable;
    });
    renderSiteCredentialStatus();
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

  function authFingerprint(user, authenticated) {
    return (authenticated ? '1' : '0') + '|' + ((user && user.username) || '') + '|' + ((user && user.role) || '');
  }

  function loadConfig() {
    return api('__auth/session').then(function (payload) {
      state.user = payload.user || null;
      state.authenticated = !!payload.authenticated && !!(payload.user && payload.user.role === 'admin');
      state.csrf = payload.csrfToken || '';
      state.authFingerprint = authFingerprint(payload.user, payload.authenticated);
      if (!state.authenticated) {
        // 未登录：用公开配置先展示所有仓库（只读），登录后即可编辑
        state.editable = false;
        state.credentials = {};
        state.defaultCredential = { configured: false, username: '' };
        state.config = { repositories: (payload.site && payload.site.repositories) || [] };
        return loadFolders().then(function () {
          renderRepos();
          renderSiteBackup();
          renderAuthPanel();
          renderDefaultCredentialPanel();
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
          return loadDefaultCredential();
        }).then(function () {
          renderRepos();
          renderSiteBackup();
          renderAuthPanel();
          renderDefaultCredentialPanel();
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
    var siteAuth = window.SiteAuth;
    setStatus('正在登录…');
    var attempt = siteAuth && siteAuth.login
      ? siteAuth.login(username, password, 'admin')
      : fetch('__auth/login', {
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
      });
    attempt.then(function () {
      setStatus('登录成功，正在读取配置…');
      if (siteAuth && siteAuth.login) {
        return null;  // siteauth:change 监听器会重新读取配置并刷新页面状态
      }
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
    var folderGroups = {};
    all('[data-folder-group]').forEach(function (input) {
      var mount = input.getAttribute('data-folder-group');
      var value = input.value.trim();
      if (mount) {
        folderGroups[mount] = value || '默认';
      }
    });
    payload.folderGroups = folderGroups;
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
    var seenIds = {};
    var seenMounts = {};
    for (var index = 0; index < payload.repositories.length; index += 1) {
      var item = payload.repositories[index];
      if (item.id && seenIds[item.id]) {
        setStatus('仓库 id 重复：' + item.id + '（请修改后再保存）', true);
        return;
      }
      if (item.mount && seenMounts[item.mount]) {
        setStatus('文件夹重复映射：' + item.mount + '（请修改后再保存）', true);
        return;
      }
      seenIds[item.id] = true;
      seenMounts[item.mount] = true;
    }
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
      setStatus('仓库 ID 由系统按文件夹名生成，请先保存配置后再点「创建并拉取」。', true);
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

  function renderAuthPanel() {
    var urlInput = query('[data-auth="url"]');
    var auth = (state.config && state.config.auth) || {};
    if (urlInput) {
      urlInput.value = state.editable ? (auth.url || '') : '';
      urlInput.disabled = !state.editable;
      urlInput.placeholder = state.editable
        ? 'https://svn.example.com/svn/accounts/auth-check/'
        : '登录管理员后可查看/修改';
    }
    var current = query('[data-auth="current"]');
    if (current) {
      var user = state.user;
      current.value = user
        ? (user.username + '（' + (user.role === 'admin' ? '管理员' : 'SVN 用户') + '）')
        : '未登录（下方可用已配置的认证路径验证账号）';
    }
  }

  function saveAuthPath() {
    if (!state.editable) {
      setStatus('请先用管理员账号登录后再修改认证路径。', true);
      return;
    }
    var input = query('[data-auth="url"]');
    var url = input ? input.value.trim() : '';
    if (!url) {
      setStatus('请填写 SVN 认证路径（必须是强制账号密码认证的路径）。', true);
      return;
    }
    var payload = JSON.parse(JSON.stringify(state.config));
    payload.auth = Object.assign({}, payload.auth || {}, { url: url });
    setStatus('正在保存 SVN 认证路径…');
    api('__config', { method: 'PUT', body: JSON.stringify(payload) }).then(function (result) {
      state.config = result.config || state.config;
      renderAuthPanel();
      renderDefaultCredentialPanel();
      setStatus('SVN 认证路径已保存并生效（SVN 用户会话失效，管理员会话保留）。');
    }).catch(function (error) {
      setStatus('保存认证路径失败：' + error.message, true);
    });
  }

  function testAuthPath() {
    var input = query('[data-auth="url"]');
    var url = input ? input.value.trim() : '';
    setStatus('正在测试认证路径…');
    api('__config/test-auth', { method: 'POST', body: JSON.stringify({ url: url }) }).then(function (payload) {
      var result = payload.result || {};
      setStatus('认证路径可用：' + (result.message || '可以用于登录验证'));
    }).catch(function (error) {
      setStatus('认证路径不可用：' + error.message, true);
    });
  }

  function logout() {
    setStatus('正在退出登录…');
    api('__auth/logout', { method: 'POST', body: JSON.stringify({}) }).then(function () {
      window.location.reload();
    }).catch(function () {
      window.location.reload();
    });
  }

  function verifyAccount(alsoLogin) {
    var usernameNode = query('[data-auth="username"]');
    var passwordNode = query('[data-auth="password"]');
    var username = usernameNode ? usernameNode.value.trim() : '';
    var password = passwordNode ? passwordNode.value : '';
    if (!username || !password) {
      setStatus('请填写要验证的账号与密码。', true);
      return;
    }
    setStatus('正在通过 SVN 认证路径验证账号 ' + username + ' …');
    api('__admin/verify-account', {
      method: 'POST',
      body: JSON.stringify({ username: username, password: password })
    }).then(function (payload) {
      var result = payload.result || {};
      if (!alsoLogin) {
        setStatus('✔ ' + (result.message || '账号验证通过'));
        return null;
      }
      return api('__auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: username, password: password })
      }).then(function (loginPayload) {
        var name = (loginPayload.user && loginPayload.user.username) || username;
        setStatus('账号验证通过，已切换为 ' + name + '；页面将刷新为只读视图。');
        window.setTimeout(function () { window.location.reload(); }, 900);
      });
    }).catch(function (error) {
      setStatus('账号验证失败：' + error.message, true);
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

  function syncPermLabel(detail, svnEnabled) {
    if (!detail) {
      return;
    }
    var label = detail.querySelector('.repo-flags .flag');
    var text = svnEnabled ? '允许合入 SVN 库' : '允许在线修改';
    if (label && label.lastChild && label.lastChild.nodeType === 3) {
      label.lastChild.nodeValue = text;
    }
    if (label) {
      label.setAttribute('title', svnEnabled
        ? '勾选后允许登录用户把草稿合入 SVN 库；取消勾选则网页只读，内容由服务器定时同步更新'
        : '勾选后允许登录用户在线编辑并发布到本地库；取消勾选则网页只读，内容由服务器自动更新');
    }
  }

  document.addEventListener('change', function (event) {
    var target = event.target;
    var allow = target.closest ? target.closest('[data-repo="allowCommit"]') : null;
    if (allow) {
      var host = allow.closest('.repo-flags');
      var hint = host ? host.querySelector('[data-perm-hint]') : null;
      if (hint) {
        hint.textContent = allow.checked ? '' : '未勾选：网页为只读，内容由服务器自动更新';
      }
      return;
    }
    var svnToggle = target.closest ? target.closest('[data-repo="svnEnabled"]') : null;
    if (svnToggle) {
      var pair = svnToggle.closest('[data-repo-row]');
      var detail = document.querySelector('[data-pair-detail="' + (pair ? pair.getAttribute('data-pair') : '') + '"]');
      syncPermLabel(detail, !!svnToggle.checked);
    }
  });

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
        if (entry.summary) {
          entry.summary.setAttribute('data-repo-removed', '1');
        }
        updateSummary(entry);
        setStatus('已移除该文件夹的仓库配置（点「保存配置并重建站点」后生效）。');
      }
    } else if (action === 'auth-save') {
      saveAuthPath();
    } else if (action === 'auth-test') {
      testAuthPath();
    } else if (action === 'logout') {
      logout();
    } else if (action === 'verify-account') {
      verifyAccount(false);
    } else if (action === 'verify-switch') {
      verifyAccount(true);
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
        setStatus('仓库 ID 由系统按文件夹名生成，请先保存配置。', true);
        return;
      }
      if (action === 'health') {
        checkHealth(targetId, false);
      } else {
        repairRepo(targetId, action === 'recreate');
      }
    } else if (action === 'repo-credential') {
      saveRepoCredential(target);
    } else if (action === 'site-credential') {
      saveSiteCredential();
    } else if (action === 'default-credential') {
      saveDefaultCredential();
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
        if (urlInput && !urlInput.value.trim()) {
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

  // SiteAuth（auth.js）登录/退出后刷新页面：管理员登录面板与只读状态跟随变化
  document.addEventListener('siteauth:change', function (event) {
    var info = event.detail || {};
    var next = authFingerprint(info.user, info.authenticated);
    if (state.authFingerprint === next) {
      return;
    }
    state.authFingerprint = next;
    loadConfig();
  });

  showPanels();
  loadConfig();
}());
