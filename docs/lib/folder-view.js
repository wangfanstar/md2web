(function () {
  'use strict';

  // index_all.html：正文只显示当前文件夹信息（不显示文档内容与本文目录）；
  // 所有页面：在文件夹/文档条目上右键可新建、重命名、删除、设置分组。
  var config = window.$docsify || {};
  var repos = config.repoList || [];

  function currentRoute() {
    var hash = String(window.location.hash || '#/').replace(/^#\/?/, '');
    var route = hash.split('?')[0].replace(/^\/+/, '');
    try {
      route = decodeURIComponent(route);
    } catch (error) { /* 保留原值 */ }
    return route;
  }

  function repoForRoute(route) {
    var rel = route.indexOf('md/') === 0 ? route.slice(3) : route;
    var best = null;
    var bestLength = -1;
    repos.forEach(function (repo) {
      var sub = String(repo.sub || '').replace(/^\/+|\/+$/g, '');
      if (sub && (rel === sub || rel.indexOf(sub + '/') === 0) && sub.length > bestLength) {
        best = repo;
        bestLength = sub.length;
      }
    });
    return best;
  }

  function folderPathOf(route) {
    var parts = String(route || '').split('/');
    parts.pop();
    var folder = parts.join('/');
    return folder || 'md';
  }

  function formatBytes(size) {
    var value = Number(size || 0);
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    return (value / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function formatTime(stamp) {
    if (!stamp) return '';
    var date = new Date(Number(stamp) * 1000);
    if (isNaN(date.getTime())) return String(stamp);
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function siteForPath(path) {
    var repo = repoForRoute(path);
    return repo ? 'html/index_' + repo.id + '.html' : 'html/index_all.html';
  }

  function renderFolderView(folder) {
    var article = document.querySelector('.markdown-section');
    if (!article) {
      return;
    }
    document.body.classList.add('folder-view-active');
    var rows = (folder.documents || []).map(function (item) {
      return '<tr>'
        + '<td><a href="' + escapeHtml(siteForPath(item.path)) + '#/' + escapeHtml(item.path) + '">'
        + escapeHtml(item.name) + '</a></td>'
        + '<td>' + escapeHtml(formatBytes(item.size)) + '</td>'
        + '<td>' + escapeHtml(formatTime(item.mtime)) + '</td>'
        + '<td><button type="button" data-folder-action="menu" data-path="' + escapeHtml(item.path)
        + '">操作</button></td>'
        + '</tr>';
    }).join('');
    var folders = (folder.folders || []).map(function (item) {
      return '<li><a href="#/' + escapeHtml(item.path) + '/">' + escapeHtml(item.name) + '/</a>'
        + '<button type="button" data-folder-action="menu" data-path="' + escapeHtml(item.path)
        + '" aria-label="操作 ' + escapeHtml(item.name) + '">操作</button></li>';
    }).join('');
    var trashMount = (config.repoInfo && config.repoInfo.all) ? 'md' : ((config.repoInfo && config.repoInfo.mount) || folder.path);
    article.innerHTML = [
      '<div class="folder-view" data-folder-view>',
      '<h1>' + escapeHtml(folder.name || '') + '</h1>',
      '<div class="folder-view-actions"><button type="button" data-folder-action="menu" data-path="' + escapeHtml(folder.path)
        + '">新建文档或文件夹</button><button type="button" data-folder-action="trash" data-mount="' + escapeHtml(trashMount)
        + '">回收站</button></div>',
      '<p class="folder-view-meta">目录：<code>' + escapeHtml(folder.path || '') + '</code>'
        + ' · 文档 ' + ((folder.documents || []).length) + ' 个 · 合计 '
        + escapeHtml(formatBytes(folder.totalBytes)) + '</p>',
      (folders ? '<h2>子文件夹</h2><ul class="folder-view-folders">' + folders + '</ul>' : ''),
      '<h2>文档</h2>',
      '<table class="folder-view-table"><thead><tr><th>名称</th><th>大小</th><th>更新时间</th><th></th></tr></thead>'
        + '<tbody>' + (rows || '<tr><td colspan="4">该文件夹暂无文档</td></tr>') + '</tbody></table>',
      '<p class="folder-view-hint">在条目上右键（或点「操作」）可新建、重命名、删除、设置分组；'
        + '点击文档名会在对应仓库入口页打开。</p>',
      '</div>'
    ].join('');
  }

  function isFolderRoute(route) {
    // 文档路由（以 .md 结尾或指向具体文件）保持正文与右侧本文目录；
    // 仅“文件夹路由”（目录、以 / 结尾）才显示文件夹视图。
    var value = String(route || '').split('?')[0];
    if (!value) {
      return false;
    }
    if (/\.md$/i.test(value)) {
      return false;
    }
    return value.charAt(value.length - 1) === '/' || value.indexOf('/') === -1;
  }

  function loadFolderView() {
    if (!config.folderView) {
      return;
    }
    var route = currentRoute();
    var repoInfo = config.repoInfo || {};
    var rootFolder = repoInfo.all ? 'md' : (repoInfo.mount || '');
    if (!route || route === 'README.md' || route === '/') {
      if (!rootFolder) {
        document.body.classList.remove('folder-view-active');
        return;
      }
      route = rootFolder + '/';
    }
    if (!isFolderRoute(route)) {
      // 文档页：恢复正文与本文目录
      document.body.classList.remove('folder-view-active');
      return;
    }
    var folder = folderPathOf(route);
    if (folder === 'md' && route.indexOf('/') === -1) {
      document.body.classList.remove('folder-view-active');
      return;
    }
    fetch('__folder?path=' + encodeURIComponent(folder) + '&recursive=1').then(function (response) {
      return response.json();
    }).then(function (payload) {
      if (payload && payload.ok) {
        renderFolderView(payload.folder);
      }
    }).catch(function () { /* 只读预览等场景保持原文 */ });
  }

  // ---------- 右键菜单 ----------

  var menu = null;

  function closeMenu() {
    if (menu) {
      menu.remove();
      menu = null;
    }
  }

  function api(path, options) {
    var siteAuth = window.SiteAuth;
    var headers = Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {});
    if (siteAuth && siteAuth.csrfToken && siteAuth.csrfToken()) {
      headers['X-CSRF-Token'] = siteAuth.csrfToken();
    }
    return fetch(path, Object.assign({}, options, { headers: headers })).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok || payload.ok === false) {
          var error = new Error(payload.error || ('HTTP ' + response.status));
          error.code = payload.code || '';
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    });
  }

  function requireLogin() {
    var siteAuth = window.SiteAuth;
    if (siteAuth && siteAuth.isAuthenticated && siteAuth.isAuthenticated()) {
      return true;
    }
    if (siteAuth && siteAuth.openLogin) {
      siteAuth.openLogin();
    } else {
      window.alert('请先登录后再执行该操作');
    }
    return false;
  }

  function reloadSoon(message) {
    if (message) {
      window.alert(message);
    }
    window.setTimeout(function () { window.location.reload(); }, 400);
  }

  function operationNotice(prefix, result) {
    var revision = result && result.svnRevision ? '（已提交 SVN r' + result.svnRevision + '）' : '（本地已更新）';
    return prefix + revision;
  }

  function openTrash(mount) {
    api('__trash?mount=' + encodeURIComponent(mount), { method: 'GET' }).then(function (payload) {
      closeMenu();
      var dialog = document.createElement('div');
      dialog.className = 'folder-trash-dialog';
      var entries = payload.entries || [];
      dialog.innerHTML = '<div class="folder-trash-card"><div class="folder-trash-head"><strong>回收站</strong>'
        + '<button type="button" data-trash-close>关闭</button></div>'
        + '<p class="folder-trash-hint">删除的文档、引用的图片和附件会保留在这里，恢复后回到原路径。</p>'
        + '<div class="folder-trash-list">' + (entries.length ? entries.map(function (item) {
          return '<div class="folder-trash-row"><span><strong>' + escapeHtml(item.name || item.path) + '</strong>'
            + '<small>' + escapeHtml(item.path || '') + '</small></span><button type="button" data-trash-restore="'
            + escapeHtml(item.id) + '">恢复</button></div>';
        }).join('') : '<p class="folder-trash-empty">回收站为空</p>') + '</div>'
        + (entries.length ? '<button type="button" class="folder-trash-empty-action" data-trash-empty>清空回收站</button>' : '')
        + '</div>';
      document.body.appendChild(dialog);
      dialog.addEventListener('click', function (event) {
        if (event.target === dialog || event.target.closest('[data-trash-close]')) {
          dialog.remove();
          return;
        }
        var restore = event.target.closest('[data-trash-restore]');
        if (restore) {
          mutate('__md/restore', { mount: mount, entryId: restore.getAttribute('data-trash-restore') })
            .then(function (result) { dialog.remove(); reloadSoon(operationNotice('已恢复文档', result.result)); })
            .catch(function (error) { window.alert('恢复失败：' + error.message); });
          return;
        }
        if (event.target.closest('[data-trash-empty]')) {
          if (!window.confirm('清空后将永久删除回收站中的内容，确定继续？')) return;
          mutate('__md/trash-empty', { mount: mount })
            .then(function (result) { dialog.remove(); reloadSoon(operationNotice('回收站已清空', result.result)); })
            .catch(function (error) { window.alert('清空失败：' + error.message); });
        }
      });
    }).catch(function (error) { window.alert('读取回收站失败：' + error.message); });
  }

  function runAction(action, path, isFolder) {
    var parent = isFolder ? (path || currentRoute()) : folderPathOf(path || currentRoute());
    if (action === 'new-document') {
      var docName = window.prompt('新建文档名称（不含 .md）', '新文档');
      if (!docName) return;
      mutate('__md/create', { parent: parent, kind: 'document', name: docName })
        .then(function (payload) { reloadSoon(operationNotice('已创建文档：' + docName, payload.result)); })
        .catch(function (error) { window.alert('创建失败：' + error.message); });
      return;
    }
    if (action === 'new-folder') {
      var folderName = window.prompt('新建文件夹名称', '新文件夹');
      if (!folderName) return;
      mutate('__md/create', { parent: parent, kind: 'folder', name: folderName })
        .then(function (payload) { reloadSoon(operationNotice('已创建文件夹：' + folderName, payload.result)); })
        .catch(function (error) { window.alert('创建失败：' + error.message); });
      return;
    }
    if (action === 'rename') {
      var newName = window.prompt('重命名为（' + (isFolder ? '文件夹' : '文档，可不带 .md') + '）',
        String(path || '').split('/').pop());
      if (!newName) return;
      mutate('__md/rename', { path: path, name: newName })
        .then(function (payload) { reloadSoon(operationNotice('已重命名，请检查文档中的引用链接', payload.result)); })
        .catch(function (error) { window.alert('重命名失败：' + error.message); });
      return;
    }
    if (action === 'delete') {
      if (!window.confirm('确定删除 ' + path + ' ？（会移动到回收站，可恢复）')) return;
      mutate('__md/delete', { path: path })
        .then(function (payload) { reloadSoon(operationNotice('已删除（已移动到 data/trash）', payload.result)); })
        .catch(function (error) { window.alert('删除失败：' + error.message); });
      return;
    }
    if (action === 'group') {
      var repo = repoForRoute(path || currentRoute());
      if (!repo) {
        window.alert('该文件夹未配置为 SVN 仓库，无法设置分组（请先在仓库配置页添加映射）');
        return;
      }
      var group = window.prompt('设置分组名称（用于总览页分组）', repo.group || '默认');
      if (!group) return;
      api('__admin/group', { method: 'POST', body: JSON.stringify({ id: repo.id, group: group }) })
        .then(function () { reloadSoon('已设置分组：' + group + '（站点正在重建）'); })
        .catch(function (error) { window.alert('设置分组失败：' + error.message); });
    }
  }

  function mutate(url, data) {
    data.requestId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '') :
      (Date.now().toString(16) + Math.random().toString(16).slice(2) + '00000000000000000000000000000000').slice(0, 32);
    return api(url, { method: 'POST', body: JSON.stringify(data) }).catch(function (error) {
      if (error.code !== 'svn_credentials_required') throw error;
      var username = window.prompt('该 SVN 库需要账号，用户名：', '');
      if (!username) throw error;
      var password = window.prompt('SVN 口令（仅本次操作使用）：', '');
      if (password === null) throw error;
      data.svnUsername = username;
      data.svnPassword = password;
      return api(url, { method: 'POST', body: JSON.stringify(data) });
    });
  }

  function openMenu(x, y, path, isFolder) {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'folder-context-menu';
    menu.innerHTML = [
      '<button type="button" data-menu-action="new-document">新建文档</button>',
      '<button type="button" data-menu-action="new-folder">新建文件夹</button>',
      '<button type="button" data-menu-action="rename">重命名</button>',
      '<button type="button" data-menu-action="delete">删除</button>',
      '<button type="button" data-menu-action="group">设置分组…</button>'
    ].join('');
    document.body.appendChild(menu);
    var rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
    menu.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('[data-menu-action]') : null;
      if (!button) {
        return;
      }
      var action = button.getAttribute('data-menu-action');
      closeMenu();
      if (!requireLogin()) {
        return;
      }
      runAction(action, path, isFolder);
    });
  }

  function pathFromElement(node) {
    var link = node.closest ? node.closest('a[href*="md/"]') : null;
    var raw = link ? (link.getAttribute('href') || '') : (node.getAttribute('data-path') || '');
    raw = raw.replace(/^#/, '');
    var hashIndex = raw.indexOf('md/');
    if (hashIndex !== -1) {
      var path = raw.slice(hashIndex).split('?')[0].replace(/\/$/, '');
      try {
        path = decodeURIComponent(path);
      } catch (error) { /* 保留原值 */ }
      return path || null;
    }
    // 分组节点（所有文档 / 仓库分组 / 子文件夹分组）：生成侧栏时写入 data-folder，精确指向该目录
    var group = node.closest ? node.closest('[data-folder]') : null;
    if (group) {
      return group.getAttribute('data-folder') || null;
    }
    // 兜底（旧产物没有 data-folder）：用分组下第一个文档链接推导所属目录
    var sidebarItem = node.closest ? node.closest('.sidebar-nav li') : null;
    var child = sidebarItem && sidebarItem.querySelector('a[href*="md/"]');
    if (!child) {
      return null;
    }
    raw = child.getAttribute('href') || '';
    hashIndex = raw.indexOf('md/');
    if (hashIndex === -1) {
      return null;
    }
    var childPath = raw.slice(hashIndex).split('?')[0].replace(/\/$/, '');
    var slash = childPath.lastIndexOf('/');
    return slash > 2 ? childPath.slice(0, slash) : null;
  }

  document.addEventListener('contextmenu', function (event) {
    var path = pathFromElement(event.target);
    if (!path) {
      return;
    }
    event.preventDefault();
    var isFolder = !/\.md$/i.test(path);
    openMenu(event.clientX, event.clientY, path, isFolder);
  });
  document.addEventListener('click', function (event) {
    var trigger = event.target.closest ? event.target.closest('[data-folder-action="menu"]') : null;
    if (trigger) {
      var path = trigger.getAttribute('data-path');
      var rect = trigger.getBoundingClientRect();
      openMenu(rect.left, rect.bottom + 4, path, !/\.md$/i.test(path));
      return;
    }
    var trash = event.target.closest ? event.target.closest('[data-folder-action="trash"]') : null;
    if (trash) {
      openTrash(trash.getAttribute('data-mount') || 'md');
      return;
    }
    if (menu && !menu.contains(event.target)) {
      closeMenu();
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      closeMenu();
    }
  });
  window.addEventListener('scroll', closeMenu, true);

  if (window.$docsify.plugins) {
    window.$docsify.plugins = window.$docsify.plugins.concat(function (hook) {
      hook.doneEach(function () { window.setTimeout(loadFolderView, 120); });
    });
  }
  window.addEventListener('hashchange', function () { window.setTimeout(loadFolderView, 120); });
  window.FolderView = { isFolderRoute: isFolderRoute, reload: loadFolderView, pathFromElement: pathFromElement };
  window.setTimeout(loadFolderView, 200);
}());
