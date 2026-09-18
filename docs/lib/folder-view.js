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
    return repo ? 'index_' + repo.id + '.html' : 'index_all.html';
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
      return '<li><a href="#/' + escapeHtml(item.path) + '/">' + escapeHtml(item.name) + '/</a></li>';
    }).join('');
    article.innerHTML = [
      '<div class="folder-view" data-folder-view>',
      '<h1>' + escapeHtml(folder.name || '') + '</h1>',
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
    if (!route || route === 'README.md' || route === '/') {
      document.body.classList.remove('folder-view-active');
      return;
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
    fetch('__folder?path=' + encodeURIComponent(folder)).then(function (response) {
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
          throw new Error(payload.error || ('HTTP ' + response.status));
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

  function runAction(action, path, isFolder) {
    var parent = folderPathOf(path || currentRoute());
    if (action === 'new-document') {
      var docName = window.prompt('新建文档名称（不含 .md）', '新文档');
      if (!docName) return;
      api('__md/create', { method: 'POST', body: JSON.stringify({ parent: parent, kind: 'document', name: docName }) })
        .then(function () { reloadSoon('已创建文档：' + docName); })
        .catch(function (error) { window.alert('创建失败：' + error.message); });
      return;
    }
    if (action === 'new-folder') {
      var folderName = window.prompt('新建文件夹名称', '新文件夹');
      if (!folderName) return;
      api('__md/create', { method: 'POST', body: JSON.stringify({ parent: parent, kind: 'folder', name: folderName }) })
        .then(function () { reloadSoon('已创建文件夹：' + folderName); })
        .catch(function (error) { window.alert('创建失败：' + error.message); });
      return;
    }
    if (action === 'rename') {
      var newName = window.prompt('重命名为（' + (isFolder ? '文件夹' : '文档，可不带 .md') + '）',
        String(path || '').split('/').pop());
      if (!newName) return;
      api('__md/rename', { method: 'POST', body: JSON.stringify({ path: path, name: newName }) })
        .then(function () { reloadSoon('已重命名'); })
        .catch(function (error) { window.alert('重命名失败：' + error.message); });
      return;
    }
    if (action === 'delete') {
      if (!window.confirm('确定删除 ' + path + ' ？（会移动到 data/trash，可手动找回）')) return;
      api('__md/delete', { method: 'POST', body: JSON.stringify({ path: path }) })
        .then(function () { reloadSoon('已删除（已移动到 data/trash）'); })
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
    if (hashIndex === -1) {
      return null;
    }
    var path = raw.slice(hashIndex).split('?')[0].replace(/\/$/, '');
    try {
      path = decodeURIComponent(path);
    } catch (error) { /* 保留原值 */ }
    return path || null;
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
      openMenu(rect.left, rect.bottom + 4, path, false);
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
  window.FolderView = { isFolderRoute: isFolderRoute, reload: loadFolderView };
  window.setTimeout(loadFolderView, 200);
}());
