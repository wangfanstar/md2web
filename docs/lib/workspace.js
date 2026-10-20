(function () {
  'use strict';

  var STORAGE = {
    collapsed: 'md2web.workspace.collapsed',
    wide: 'md2web.workspace.wide',
    numbers: 'md2web.workspace.numbers'
  };
  var state = { filter: '', observer: null, timer: 0, lastRoute: null };

  function all(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
  function text(node) { return String((node && node.textContent) || '').replace(/\s+/g, ' ').trim(); }
  function routeOf(href) {
    var value = String(href || '');
    if (value.indexOf('#') !== -1) value = value.slice(value.indexOf('#') + 1);
    value = value.split('?')[0].replace(/^\/+/, '').replace(/\/$/, '');
    try { value = decodeURIComponent(value); } catch (_) { /* keep the original */ }
    return value;
  }
  function currentRoute() {
    return routeOf(window.location.hash || '#/');
  }
  function normalizeRoute(route) { return String(route || '').replace(/\.md$/i, '').replace(/\/$/, ''); }
  function saveCollapsed(map) {
    try { localStorage.setItem(STORAGE.collapsed, JSON.stringify(map)); } catch (_) {}
  }
  function readCollapsed() {
    try { var value = JSON.parse(localStorage.getItem(STORAGE.collapsed) || '{}'); return value && typeof value === 'object' ? value : {}; } catch (_) { return {}; }
  }
  function setCollapsed(li, closed) {
    var label = li.querySelector(':scope > strong, :scope > a, :scope > span');
    var button = label && label.querySelector(':scope > .workspace-folder-toggle');
    var child = li.querySelector(':scope > ul');
    if (!button || !child) return;
    li.classList.toggle('is-collapsed', closed);
    if (child.hidden !== !!closed) child.hidden = !!closed;
    var expanded = closed ? 'false' : 'true';
    if (button.getAttribute('aria-expanded') !== expanded) button.setAttribute('aria-expanded', expanded);
    var glyph = closed ? '▸' : '▾';
    if (button.textContent !== glyph) button.textContent = glyph;
  }

  function folderLabel(li) {
    var label = li.querySelector(':scope > strong, :scope > a, :scope > span');
    if (!label) return text(li);
    var clone = label.cloneNode(true);
    all('.workspace-folder-toggle, .workspace-folder-count, .workspace-tree-index, .workspace-tree-marker', clone).forEach(function (node) { node.remove(); });
    return text(clone);
  }
  // 文档链接文本要去掉层级序号与前导标记，过滤时只按真实名称匹配
  function linkLabel(a) {
    if (!a) return '';
    var clone = a.cloneNode(true);
    all('.workspace-tree-index, .workspace-tree-marker', clone).forEach(function (node) { node.remove(); });
    return text(clone);
  }
  function isGroupLabel(label) {
    return !!(label && (label.classList.contains('sidebar-group-link') || label.classList.contains('sidebar-group-name')));
  }
  function folderKey(li) {
    var labels = [], node = li;
    while (node && node.tagName === 'LI') { labels.unshift(folderLabel(node)); node = node.parentElement && node.parentElement.closest('li'); }
    return 'folder:' + labels.join('/').toLowerCase();
  }
  function isFolder(li) { return !!li.querySelector(':scope > ul'); }

  // 按 md 层级给左侧导航加序号（1 / 1.1 / 1.1.1）：顶层「所有文档/仓库」分组不加序号，
  // 从下一层子文件夹开始编号；过滤后只对可见条目连续编号
  function addTreeNumbers(root) {
    function walk(ul, prefix, depth) {
      var index = 0;
      all(':scope > li', ul).forEach(function (li) {
        var label = li.querySelector(':scope > strong, :scope > a, :scope > span') || li.firstElementChild;
        var badge = label && label.querySelector(':scope > .workspace-tree-index');
        if (li.style.display === 'none') {
          // 被过滤掉的条目移除序号，避免再次显示时出现重复编号
          if (badge) badge.remove();
          return;
        }
        var child = li.querySelector(':scope > ul');
        if (depth === 0) {
          if (badge) badge.remove();
          if (child) walk(child, prefix, depth + 1);
          return;
        }
        index += 1;
        var path = prefix.concat(index);
        if (label) {
          var value = path.join('.');
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'workspace-tree-index';
            var anchor = label.querySelector(':scope > .workspace-folder-toggle')
              || label.querySelector(':scope > .workspace-tree-marker');
            if (anchor) label.insertBefore(badge, anchor.nextSibling);
            else label.insertBefore(badge, label.firstChild);
            badge.textContent = value;
          } else if (badge.textContent !== value) {
            badge.textContent = value;
          }
        }
        if (child) walk(child, path, depth + 1);
      });
    }
    walk(root, [], 0);
  }

  function decorateTree() {
    var nav = document.querySelector('.sidebar-nav');
    if (!nav) return;
    var root = nav.querySelector(':scope > ul') || nav.querySelector('ul');
    if (!root) return;
    var collapsed = readCollapsed();
    all('li', root).forEach(function (li) {
      var child = li.querySelector(':scope > ul');
      var label = li.querySelector(':scope > strong, :scope > a, :scope > span');
      if (!label) label = li.firstElementChild;
      if (!label) return;
      if (child) {
        if (!label.querySelector(':scope > .workspace-folder-toggle')) {
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'workspace-folder-toggle';
          button.setAttribute('aria-label', '展开或折叠目录');
          label.insertBefore(button, label.firstChild);
          button.addEventListener('click', function (event) {
            event.preventDefault(); event.stopPropagation();
            var close = !li.classList.contains('is-collapsed');
            setCollapsed(li, close);
            collapsed[folderKey(li)] = close;
            saveCollapsed(collapsed);
          });
        }
        if (!label.querySelector(':scope > .workspace-folder-count')) {
          var count = document.createElement('span');
          count.className = 'workspace-folder-count';
          count.textContent = String(all(':scope > ul a[href]', li).filter(function (a) {
            // 只统计文档链接（分组名链接指向 index_*.html，不计入文件数量）
            return (a.getAttribute('href') || '').indexOf('.html') === -1;
          }).length);
          label.appendChild(count);
        }
        if (Object.prototype.hasOwnProperty.call(collapsed, folderKey(li))) {
          setCollapsed(li, !!collapsed[folderKey(li)]);
        } else if (!li.classList.contains('is-collapsed')) {
          setCollapsed(li, false);
        }
      } else if (!label.querySelector(':scope > .workspace-tree-marker, :scope > .workspace-folder-toggle')) {
        // 空文件夹与文档：用固定宽度的前导标记占位，保证与可展开目录、同级文件缩进一致
        var marker = document.createElement('span');
        marker.className = 'workspace-tree-marker';
        marker.setAttribute('aria-hidden', 'true');
        marker.textContent = isGroupLabel(label) ? '▫' : '·';
        label.insertBefore(marker, label.firstChild);
      }
    });
    if (!document.querySelector('.workspace-tree-tools')) {
      var tools = document.createElement('div');
      tools.className = 'workspace-tree-tools';
      tools.innerHTML = '<div class="workspace-tree-tools-row">' +
        '<input type="search" class="workspace-tree-filter-input" placeholder="过滤目录" aria-label="按文件名过滤目录">' +
        '<button type="button" class="workspace-tree-more" aria-label="更多目录操作" aria-expanded="false">⋯</button>' +
        '<div class="workspace-tree-menu" hidden>' +
        '<button type="button" data-workspace-action="expand">全部展开</button>' +
        '<button type="button" data-workspace-action="collapse">全部收起</button>' +
        '<button type="button" data-workspace-action="locate">定位当前</button>' +
        '</div></div>';
      var scroll = nav.closest('.docs-sidebar-scroll') || nav.parentNode;
      scroll.insertBefore(tools, nav);
      tools.querySelector('input').addEventListener('input', function () { state.filter = this.value.trim().toLowerCase(); filterTree(root); addTreeNumbers(root); });
      var more = tools.querySelector('.workspace-tree-more');
      var menu = tools.querySelector('.workspace-tree-menu');
      function closeMenu() { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); }
      more.addEventListener('click', function (event) {
        event.stopPropagation();
        var open = menu.hidden;
        menu.hidden = !open;
        more.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      document.addEventListener('click', function (event) {
        if (!menu.hidden && !tools.contains(event.target)) closeMenu();
      });
      tools.addEventListener('click', function (event) {
        var action = event.target.getAttribute('data-workspace-action');
        if (!action) return;
        closeMenu();
        var currentRoot = (document.querySelector('.sidebar-nav') || nav).querySelector(':scope > ul') || root;
        if (action === 'locate') { locateCurrent(currentRoot, true); return; }
        all('li', currentRoot).filter(isFolder).forEach(function (li) { setCollapsed(li, action === 'collapse'); });
        saveCollapsed({});
      });
    }
    var input = document.querySelector('.workspace-tree-filter-input');
    if (input && input.value !== state.filter) input.value = state.filter;
    filterTree(root);
    addTreeNumbers(root);
    var routeChanged = state.lastRoute !== currentRoute();
    if (routeChanged) { state.lastRoute = currentRoute(); locateCurrent(root, false); }
  }

  function filterTree(root) {
    var query = state.filter;
    function visit(ul) {
      var any = false;
      all(':scope > li', ul).forEach(function (li) {
        var own = linkLabel(li.querySelector(':scope > a')).toLowerCase();
        var match = !query || own.indexOf(query) !== -1 || folderLabel(li).toLowerCase().indexOf(query) !== -1;
        var childMatch = isFolder(li) ? visit(li.querySelector(':scope > ul')) : false;
        var visible = match || childMatch;
        li.style.display = visible ? '' : 'none';
        if (query && childMatch) setCollapsed(li, false);
        any = any || visible;
      });
      return any;
    }
    visit(root);
  }

  function locateCurrent(root, force) {
    var route = currentRoute();
    all('a[href]', root).forEach(function (a) {
      var active = route && normalizeRoute(routeOf(a.getAttribute('href'))) === normalizeRoute(route);
      a.classList.toggle('workspace-current', active);
      if (!active) return;
      var parent = a.parentElement;
      while (parent && parent !== root) {
        if (parent.tagName === 'LI' && isFolder(parent)) setCollapsed(parent, false);
        parent = parent.parentElement;
      }
      if (force || a.dataset.workspaceScrolled !== route) {
        a.dataset.workspaceScrolled = route;
        window.setTimeout(function () { try { a.scrollIntoView({ block: 'nearest' }); } catch (_) {} }, 0);
      }
    });
  }

  function repositoryCandidates() {
    var docsify = window.$docsify || {};
    var candidates = [];
    if (docsify.repoInfo && docsify.repoInfo.mount) {
      candidates.push(docsify.repoInfo);
    }
    (docsify.repoList || []).forEach(function (repo) { candidates.push(repo); });
    if (window.SiteAuth && window.SiteAuth.repositories) {
      (window.SiteAuth.repositories() || []).forEach(function (repo) { candidates.push(repo); });
    }
    return candidates;
  }

  function svnUrlForRoute(route) {
    var clean = String(route || '').replace(/^#/, '').split('?')[0].replace(/^\/+|\/+$/g, '');
    if (!clean || clean === 'README.md') {
      return '';
    }
    var best = null;
    repositoryCandidates().forEach(function (repo) {
      var mount = String(repo && repo.mount || '').replace(/^\/+|\/+$/g, '');
      var url = String(repo && repo.url || '').trim();
      var sourceMode = String(repo && (repo.sourceMode || repo.source_mode) || 'svn').toLowerCase();
      if (!mount || !url || sourceMode === 'local') {
        return;
      }
      if ((clean === mount || clean.indexOf(mount + '/') === 0) && (!best || mount.length > best.mount.length)) {
        best = { mount: mount, url: url.replace(/\/+$/, '') };
      }
    });
    if (!best || clean === best.mount) {
      return '';
    }
    var relative = clean.slice(best.mount.length).replace(/^\/+/, '');
    // Docsify 阅读路由省略 .md，但 SVN 地址必须指向真实文件。
    if (!/\.md$/i.test(relative)) relative += '.md';
    return best.url + '/' + relative.split('/').map(function (part) { return encodeURIComponent(part); }).join('/');
  }

  function updateSvnCopyAction(actions, route) {
    var button = actions.querySelector('[data-workspace-copy-svn]');
    var link = svnUrlForRoute(route);
    if (!link) {
      if (button) { button.parentNode.removeChild(button); }
      return;
    }
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-workspace-copy-svn', '');
      button.title = '复制当前文档的 SVN 地址';
      button.textContent = '复制 SVN 链接';
      button.addEventListener('click', function () {
        copyText(svnUrlForRoute(currentRoute()), button);
      });
      var exportButton = actions.querySelector('[data-workspace-export]');
      actions.insertBefore(button, exportButton || null);
    }
  }

  function addBreadcrumb() {
    var section = document.querySelector('.markdown-section');
    if (!section) return;
    var route = currentRoute();
    var parts = route ? route.split('/').filter(Boolean) : [];
    var crumb = section.querySelector(':scope > .workspace-breadcrumb');
    if (!crumb) { crumb = document.createElement('nav'); crumb.className = 'workspace-breadcrumb'; crumb.setAttribute('aria-label', '当前位置'); section.insertBefore(crumb, section.firstChild); }
    var labels = ['首页'].concat(parts);
    {
      crumb.innerHTML = labels.map(function (part, index) {
        var label = part.replace(/\.md$/i, '');
        if (index === labels.length - 1) return '<span aria-current="page">' + escape(label) + '</span>';
        var folders = (window.MD2WEB_NAVIGATION || {}).folders || {};
        var item = folders[parts.slice(0, index).join('/')];
        var href = index === 0 ? 'index.html' : (index === 1 && part === 'md' ? 'html/index_all.html' : item && item.href);
        if (item && item.label) label = item.label;
        return (href ? '<a href="' + escape(href) + '">' + escape(label) + '</a>' : '<span>' + escape(label) + '</span>') + '<span class="workspace-breadcrumb-sep">/</span>';
      }).join('');
      crumb.setAttribute('data-route', route);
    }
    var actions = section.querySelector(':scope > .workspace-page-actions');
    if (!actions) { actions = document.createElement('div'); actions.className = 'workspace-page-actions'; section.insertBefore(actions, crumb.nextSibling); }
    if (!actions.querySelector('[data-workspace-copy-path]')) {
      var numbersHidden = document.body.classList.contains('hide-heading-numbers');
      actions.innerHTML = '<button type="button" data-workspace-copy-path title="复制当前页面链接（含 #/ 路由，可直接分享）">复制链接</button><button type="button" data-workspace-export>下载本页</button><button type="button" data-workspace-numbers>' + (numbersHidden ? '显示序号' : '隐藏序号') + '</button>';
      actions.querySelector('[data-workspace-copy-path]').addEventListener('click', function () {
        // 复制当前链接地址（含 #/ 路由，可直接分享）；中文保持可读，file:// 也能正确拼接
        copyText(readableLink(shareLink()), this);
      });
      actions.querySelector('[data-workspace-export]').addEventListener('click', function () { if (window.PageExport) { window.PageExport.download(); } });
      actions.querySelector('[data-workspace-numbers]').addEventListener('click', function () { var hidden = document.body.classList.toggle('hide-heading-numbers'); try { localStorage.setItem(STORAGE.numbers, hidden ? '0' : '1'); } catch (_) {} this.textContent = hidden ? '显示序号' : '隐藏序号'; });
    }
    updateSvnCopyAction(actions, route);
    addSvnDocumentUpdateAction(actions, route);
    updateDocActions(actions, route);
  }

  // 仅在实际文档页显示「查看源码 / 编辑 MD / 下载 MD」；
  // 各入口页 index_*.html（含 index_all.html）的首页与文件夹列表不显示。
  function isDocumentView(route, section) {
    if (!route || route.indexOf('md/') !== 0 || route.charAt(route.length - 1) === '/') return false;
    if (route.replace(/\.md$/i, '').split('/').length < 3) return false;
    if (repositoryCandidates().some(function (repo) { return String(repo.mount || '').replace(/^\/+|\/+$/g, '') === route; })) return false;
    var root = section || document.querySelector('.markdown-section');
    return !(root && root.querySelector('.folder-view'));
  }

  function updateEditLabel(actions) {
    var button = actions ? actions.querySelector('[data-workspace-edit]') : document.querySelector('[data-workspace-edit]');
    if (!button) return;
    var auth = window.SiteAuth && window.SiteAuth.snapshot ? window.SiteAuth.snapshot() : null;
    if (!auth || auth.fileMode) { button.textContent = '编辑 MD'; return; }
    if (!auth.available) { button.textContent = '只读预览'; }
    else if (!auth.authenticated) { button.textContent = '登录后编辑'; }
    else { button.textContent = '编辑 MD'; }
  }

  function editDocument(actions) {
    var auth = window.SiteAuth && window.SiteAuth.snapshot ? window.SiteAuth.snapshot() : null;
    if (auth && !auth.fileMode) {
      if (!auth.available) {
        updateEditLabel(actions);
        if (window.SiteAuth.openLogin) window.SiteAuth.openLogin();
        return;
      }
      if (!auth.authenticated) { window.SiteAuth.openLogin(); return; }
    } else if (window.SiteAuth && window.SiteAuth.isAuthenticated && !window.SiteAuth.isAuthenticated() && window.location.protocol !== 'file:') {
      window.SiteAuth.openLogin();
      return;
    }
    if (window.MdEditor) window.MdEditor.open();
  }

  function updateDocActions(actions, route) {
    var section = document.querySelector('.markdown-section');
    var names = ['source', 'edit', 'download'];
    var buttons = {
      source: actions.querySelector('[data-workspace-source]'),
      edit: actions.querySelector('[data-workspace-edit]'),
      download: actions.querySelector('[data-workspace-download-md]')
    };
    if (!isDocumentView(route, section)) {
      names.forEach(function (name) { if (buttons[name]) buttons[name].remove(); });
      return;
    }
    var exportButton = actions.querySelector('[data-workspace-export]');
    if (!buttons.source) {
      buttons.source = document.createElement('button');
      buttons.source.type = 'button';
      buttons.source.setAttribute('data-workspace-source', '');
      buttons.source.textContent = '查看源码';
      buttons.source.addEventListener('click', function () { if (window.MdEditor && window.MdEditor.openLocal) window.MdEditor.openLocal(); });
      actions.insertBefore(buttons.source, exportButton || null);
    }
    if (!buttons.edit) {
      buttons.edit = document.createElement('button');
      buttons.edit.type = 'button';
      buttons.edit.setAttribute('data-workspace-edit', '');
      buttons.edit.textContent = '编辑 MD';
      buttons.edit.addEventListener('click', function () { editDocument(actions); });
      actions.insertBefore(buttons.edit, exportButton || null);
      updateEditLabel(actions);
    }
    if (!buttons.download) {
      buttons.download = document.createElement('button');
      buttons.download.type = 'button';
      buttons.download.setAttribute('data-workspace-download-md', '');
      buttons.download.textContent = '下载 MD';
      buttons.download.addEventListener('click', function () { if (window.MdEditor) window.MdEditor.download(); });
      actions.insertBefore(buttons.download, exportButton || null);
    }
  }
  document.addEventListener('siteauth:change', function () { updateEditLabel(); });
  function escape(value) { return String(value).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  // 复制出来的链接保留中文：只解码包含非 ASCII 字符的 %XX 片段，%20 等 ASCII 转义保持不变
  function readableLink(value) {
    return String(value || '').replace(/(?:%[0-9A-Fa-f]{2})+/g, function (match) {
      try {
        var decoded = decodeURIComponent(match);
        return /[^\x00-\x7F]/.test(decoded) ? decoded : match;
      } catch (_) {
        return match;
      }
    });
  }
  // 当前页面的分享链接：不依赖 location.origin（file:// 下为 "null"），并补齐 #/ 路由
  function shareLink() {
    var href = String(window.location.href || '');
    var hashAt = href.indexOf('#');
    var base = hashAt === -1 ? href : href.slice(0, hashAt);
    var hash = hashAt === -1 ? '' : href.slice(hashAt);
    var route = currentRoute();
    if (!route) return href;
    var encoded = '#/' + route.split('/').map(function (part) { return encodeURIComponent(part); }).join('/');
    if (hash.indexOf('#/' + route) !== -1 || hash.indexOf(encoded) !== -1) return href;
    return base + encoded;
  }
  function copyText(value, button) {
    var done = function () { if (button) { var old = button.textContent; button.textContent = '已复制'; setTimeout(function () { button.textContent = old; }, 1200); } };
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(value).then(done, function () { fallback(value, done); }); } else fallback(value, done);
  }
  function fallback(value, done) { var input = document.createElement('textarea'); input.value = value; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.appendChild(input); input.select(); try { if (document.execCommand('copy')) done(); } catch (_) {} document.body.removeChild(input); }

  function addCodeButtons() {
    var section = document.querySelector('.markdown-section');
    if (!section) return;
    all('pre', section).forEach(function (pre) {
      if (pre.querySelector(':scope > .workspace-copy-code')) return;
      var button = document.createElement('button'); button.type = 'button'; button.className = 'workspace-copy-code'; button.textContent = '复制'; button.setAttribute('aria-label', '复制代码');
      button.addEventListener('click', function () { var code = pre.querySelector('code'); copyText(code ? code.textContent : pre.textContent, button); });
      pre.appendChild(button);
    });
  }
  function docDirectory() {
    var route = currentRoute().replace(/^#/, '').split('?')[0];
    if (!route || route === '/') return '';
    var parts = route.split('/');
    parts.pop();
    if (!parts.length || parts[0] !== 'md') return '';
    return parts.join('/');
  }

  // docsify 会把文档里的相对图片改写成站点根（/images/x.png），这里改回文档所在目录，
  // 保证「图片放在文档同级 images/ 并用相对路径引用」的约定在站点上可用
  function resolveRelativeImages() {
    var directory = docDirectory();
    if (!directory) return;
    var base = directory + '/';
    all('.markdown-section img[src]').forEach(function (image) {
      if (image.getAttribute('data-md2web-resolved') === '1') return;
      var source = image.getAttribute('src') || '';
      var resolved = null;
      if (/^\/images\//.test(source)) {
        resolved = base + source.slice(1);
      } else if (/^\.\/images\//.test(source)) {
        resolved = base + source.slice(2);
      } else if (/^images\//.test(source)) {
        resolved = base + source;
      }
      if (resolved) {
        image.setAttribute('src', resolved);
        image.setAttribute('data-md2web-resolved', '1');
      }
    });
  }

  // 文档正文顶部显示最后更新日期：SVN 库用 SVN 上的时间，其余用文件时间（需认证服务）
  function addUpdatedMeta() {
    var section = document.querySelector('.markdown-section');
    if (!section) return;
    var route = currentRoute();
    var box = section.querySelector(':scope > .workspace-doc-updated');
    // docsify 路由会去掉 .md 后缀（如 md/使用说明/快速开始），接口侧会补回扩展名
    var isDocument = route && route.indexOf('md/') === 0 && route.charAt(route.length - 1) !== '/';
    if (!isDocument) {
      if (box && box.parentNode) box.parentNode.removeChild(box);
      return;
    }
    if (box && box.getAttribute('data-route') === route) return;
    if (!box) {
      box = document.createElement('div');
      box.className = 'workspace-doc-updated';
      var crumb = section.querySelector(':scope > .workspace-breadcrumb');
      section.insertBefore(box, crumb ? crumb.nextSibling : section.firstChild);
    }
    box.setAttribute('data-route', route);
    box.textContent = '最后更新：读取中…';
    if (!window.fetch) { box.textContent = ''; return; }
    fetch('__doc-meta?path=' + encodeURIComponent(route), { credentials: 'same-origin' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        var meta = payload && payload.meta;
        if (!meta || box.getAttribute('data-route') !== route) return;
        var date = String(meta.updatedAt || '').slice(0, 10);
        box.textContent = date
          ? '最后更新：' + date + (meta.source === 'svn' ? '（SVN 库）' : '（本地文件）')
          : '';
      })
      .catch(function () { box.textContent = ''; });
  }

  // 侧栏始终显示全部文档（index_all 合并视图进入文档后也不再过滤，便于跨仓库跳转）
  function svnRepository(route) {
    var best = null;
    repositoryCandidates().forEach(function (repo) {
      var mount = String(repo.mount || '').replace(/^\/+|\/+$/g, '');
      if ((repo.sourceMode || repo.source_mode || 'svn') !== 'svn' || !repo.url || !mount) return;
      if ((route === mount || route.indexOf(mount + '/') === 0) && (!best || mount.length > best.mount.length)) best = repo;
    });
    var root = (window.$docsify || {}).repoInfo;
    if (!best && root && root.url && (root.sourceMode || root.source_mode || 'svn') === 'svn'
        && (!route || route.indexOf('html/_home_') === 0 || route === 'README.md')) best = root;
    return best;
  }

  function syncDescription(info) {
    function date(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无'; }
    return (Number(info.intervalSeconds) > 0 ? '自动更新：每 ' + info.intervalSeconds + ' 秒' : '自动更新：关闭（可手动更新）')
      + ' · 上次仓库同步：' + date(info.lastSuccessAt)
      + (info.lastFileUpdateAt ? ' · 本文手动更新：' + date(info.lastFileUpdateAt) : '')
      + ' · 状态：' + (info.state === 'running' ? '正在更新…' : (info.error ? '更新异常（' + info.error + '）' : (info.lastSuccessAt ? '同步完成' : '尚未同步')));
  }

  // 路由是否指向仓库中的某篇 Markdown 文档（而不是仓库入口页/文件夹列表）
  function isSvnDocumentRoute(route, repo) {
    return !!repo && route.indexOf(repo.mount + '/') === 0 && route.slice(-1) !== '/';
  }

  function isSvnDocumentPage(route, repo, section) {
    if (!isSvnDocumentRoute(route, repo)) return false;
    var root = section || document.querySelector('.markdown-section');
    return !(root && root.querySelector('.folder-view'));
  }

  function refreshSvnStatus() {
    var bar = document.querySelector('[data-svn-controls]');
    if (!bar || window.location.protocol === 'file:') return;
    fetch('__svn/sync-status?binding=' + encodeURIComponent(bar.getAttribute('data-binding')) + '&path=' + encodeURIComponent(bar.getAttribute('data-route')), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; }).then(function (result) {
        var label = bar.querySelector('[data-svn-status]');
        if (label && result && result.status) label.textContent = syncDescription(result.status);
        var info = result && result.status;
        var state = !info ? 'idle' : (info.state === 'running' ? 'running' : (info.error ? 'error' : (info.lastSuccessAt ? 'ok' : 'idle')));
        bar.setAttribute('data-state', state);
      }).catch(function () {});
  }

  // 恢复上一次更新的结果（整页刷新后从 sessionStorage 取回），仅消费一次
  function consumeSvnNotice(target) {
    try {
      var notice = JSON.parse(sessionStorage.getItem('md2web:svn-update-notice') || 'null');
      if (notice && notice.href === window.location.href && Date.now() - notice.at < 60000) {
        if (target) target.textContent = notice.message || '';
        sessionStorage.removeItem('md2web:svn-update-notice');
        return notice;
      }
    } catch (_) {}
    return null;
  }

  // 手动以远端覆盖本地：免登录（使用服务器配置的同步账号），负责确认、结果提示与页面刷新
  function performSvnUpdate(repo, path, message, button, route) {
    function say(value) { if (message) message.textContent = value; }
    if (document.body.classList.contains('md-editor-open')) {
      say('请先下载编辑器中的内容并关闭编辑器，再执行 SVN 更新。'); return;
    }
    if (!window.confirm('将以 SVN 最新版本覆盖' + (path ? '文档：' + path : '整个仓库：' + repo.id)
      + '。请先下载保存当前 MD 或个人草稿。原文件会备份到服务器，草稿保留。继续更新？')) return;
    if (button) button.disabled = true;
    say('正在获取 SVN 最新版本，请等待…');
    fetch('__auth/session', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (session) {
      var headers = { 'Content-Type': 'application/json' };
      if (session && session.authenticated && session.csrfToken) headers['X-CSRF-Token'] = session.csrfToken;
      return fetch('__svn/update', { method: 'POST', headers: headers,
        body: JSON.stringify({ binding: repo.id, path: path || null, remoteWins: true }) });
    }).then(function (r) { return r.json().then(function (data) { if (!r.ok || !data.ok) throw new Error(data.error || '更新失败'); return data; }); })
      .then(function (data) {
        var result = data.result;
        say('已更新到 r' + result.revision + '，覆盖 ' + result.overwritten.length + ' 个文件。备份：' + result.backup
          + (result.drafts.length ? '；有 ' + result.drafts.length + ' 个个人草稿，请下载保存，勿直接提交旧草稿。' : '')
          + (data.rebuilt ? '。已更新正文、导航和搜索索引。' : '。页面重建失败，请检查服务日志后重建。'));
        refreshSvnStatus();
        document.dispatchEvent(new CustomEvent('md2web:documents-changed'));
        if (data.rebuilt && currentRoute() === route && window.MdEditor && window.MdEditor.reloadAfterSvnUpdate) {
          try { sessionStorage.setItem('md2web:svn-update-notice', JSON.stringify({ href: window.location.href,
            at: Date.now(), scrollY: window.scrollY, message: message ? message.textContent : '' })); } catch (_) {}
          if (window.MdEditor.reloadAfterSvnUpdate()) return;
        }
        if (data.rebuilt) {
          var refresh = document.createElement('button'); refresh.textContent = '刷新当前页面';
          refresh.onclick = function () { window.location.reload(); };
          if (message) message.appendChild(refresh);
        }
      }).catch(function (error) { say(error.message); })
      .then(function () { if (button) button.disabled = false; });
  }

  // 仓库入口页（index_<仓库>.html）：显示自动更新状态，并提供整库/指定文档更新
  function addSvnControls() {
    var section = document.querySelector('.markdown-section');
    if (!section) return;
    var route = currentRoute();
    var repo = svnRepository(route);
    var old = section.querySelector('[data-svn-controls]');
    if (!repo || isSvnDocumentPage(route, repo, section)) { if (old) old.remove(); return; }
    if (old && old.getAttribute('data-route') === route) return;
    if (old) old.remove();
    var bar = document.createElement('div');
    bar.className = 'workspace-svn-controls';
    bar.setAttribute('data-svn-controls', '');
    bar.setAttribute('data-route', route);
    bar.setAttribute('data-binding', repo.id);
    bar.innerHTML = '<div class="workspace-svn-head">'
      + '<span class="workspace-svn-title">SVN 手动更新</span>'
      + '<span class="workspace-svn-status" data-svn-status>状态读取中…</span>'
      + '</div><div class="workspace-svn-actions">'
      + '<button type="button" class="workspace-svn-primary" data-svn-repo>更新整个 SVN 仓库</button>'
      + '<input data-svn-path list="svn-document-options" placeholder="输入或选择仓库内的 .md 路径" aria-label="指定 SVN 文档">'
      + '<datalist id="svn-document-options"></datalist><button type="button" data-svn-file>更新指定文档</button></div>'
      + '<p class="workspace-svn-note">手动更新以 SVN 库为准；如有未提交修改，请先下载保存。覆盖前服务器会备份原文档，个人草稿仍保留。</p>'
      + '<div class="workspace-svn-message" data-svn-message role="status"></div>';
    section.insertBefore(bar, section.querySelector('.workspace-page-actions') ? section.querySelector('.workspace-page-actions').nextSibling : section.firstChild);
    var notice = consumeSvnNotice(bar.querySelector('[data-svn-message]'));
    if (notice) window.setTimeout(function () { window.scrollTo(0, notice.scrollY || 0); }, 120);
    if (window.location.protocol === 'file:') {
      bar.querySelector('[data-svn-status]').textContent = '离线浏览：连接认证服务后可查看状态和更新 SVN。';
      Array.prototype.forEach.call(bar.querySelectorAll('button, input'), function (node) { node.disabled = true; });
      return;
    }
    bar.querySelector('[data-svn-path]').addEventListener('focus', function () {
      if (bar.getAttribute('data-loaded')) return;
      fetch('__folder?path=' + encodeURIComponent(repo.mount) + '&recursive=1').then(function (r) { return r.json(); }).then(function (data) {
        var folder = data.folder || data;
        bar.querySelector('datalist').innerHTML = (folder.documents || []).map(function (item) {
          return '<option value="' + escape(item.path.slice(repo.mount.length + 1)) + '"></option>';
        }).join('');
        bar.setAttribute('data-loaded', '1');
      }).catch(function () {});
    });
    bar.addEventListener('click', function (event) {
      var target = event.target;
      if (!target.matches('[data-svn-repo], [data-svn-file]')) return;
      var path = '';
      if (target.hasAttribute('data-svn-file')) {
        path = bar.querySelector('[data-svn-path]').value.trim();
        if (!path) { bar.querySelector('[data-svn-message]').textContent = '请先输入或选择要更新的文档。'; return; }
        if (path.indexOf('md/') !== 0) path = repo.mount + '/' + path;
        if (!/\.md$/i.test(path)) path += '.md';
      }
      performSvnUpdate(repo, path, bar.querySelector('[data-svn-message]'), target, route);
    });
    refreshSvnStatus();
  }

  // 文档页：在「复制链接」旁提供「更新当前 SVN 文档」，不再显示自动更新信息块
  function addSvnDocumentUpdateAction(actions, route) {
    var button = actions.querySelector('[data-workspace-update-svn]');
    var status = actions.querySelector('[data-workspace-svn-status]');
    var repo = svnRepository(route);
    var documentPage = window.location.protocol !== 'file:'
      && isSvnDocumentPage(route, repo, document.querySelector('.markdown-section'));
    if (!documentPage) {
      if (button && button.parentNode) button.parentNode.removeChild(button);
      if (status && status.parentNode) status.parentNode.removeChild(status);
      return;
    }
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-workspace-update-svn', '');
      button.title = '从 SVN 库手动更新当前文档（以远端为准覆盖本地，覆盖前备份）';
      button.textContent = '更新当前 SVN 文档';
      var copy = actions.querySelector('[data-workspace-copy-path]');
      if (copy) actions.insertBefore(button, copy.nextSibling);
      else actions.insertBefore(button, actions.firstChild);
      status = document.createElement('span');
      status.className = 'workspace-svn-doc-status';
      status.setAttribute('data-workspace-svn-status', '');
      status.setAttribute('role', 'status');
      actions.insertBefore(status, button.nextSibling);
      button.addEventListener('click', function () {
        var current = svnRepository(currentRoute());
        if (!current) return;
        var docRoute = currentRoute();
        performSvnUpdate(current, docRoute, status, button, docRoute);
      });
    }
    // 切换文档时清掉上一篇的更新结果
    if (actions.getAttribute('data-svn-doc-route') !== route) {
      actions.setAttribute('data-svn-doc-route', route);
      if (status) status.textContent = '';
    }
    consumeSvnNotice(status);
  }

  function enhance() { decorateTree(); addBreadcrumb(); addUpdatedMeta(); addSvnControls(); addCodeButtons(); resolveRelativeImages(); }
  function schedule() { clearTimeout(state.timer); state.timer = setTimeout(enhance, 40); }

  // 指向独立页面（index_*.html、lib/*.html 等）的相对链接：交给浏览器正常跳转，
  // 不能被 docsify 的路由点击处理拦截（否则点入口页链接不会跳转）。
  function isStaticPageHref(href) {
    return /\.html(?:[?#]|$)/i.test(href) && !/^[a-z][a-z0-9+.-]*:/i.test(href);
  }

  // 页面带 <base href="../"> 时，纯 hash 链接（#/md/...、#id）会被浏览器解析到站点根，
  // 导致点击侧栏/目录时整页跳走；这里改为只改当前文档的 hash（docsify 路由仍能收到 hashchange）。
  function handleHashLinkClick(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) {
      return;
    }
    var href = anchor.getAttribute('href') || '';
    if (href.charAt(0) !== '#' || href === '#') {
      if (isStaticPageHref(href)) {
        event.stopPropagation();
      }
      return;
    }
    event.preventDefault();
    if (window.location.hash !== href) {
      window.location.hash = href;
    }
  }

  function init() {
    try { if (localStorage.getItem(STORAGE.numbers) === '0') document.body.classList.add('hide-heading-numbers'); } catch (_) {}
    document.addEventListener('click', handleHashLinkClick, true);
    enhance();
    state.observer = new MutationObserver(schedule);
    state.observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('hashchange', schedule);
    window.setInterval(function () { if (!document.hidden) refreshSvnStatus(); }, 15000);
  }
  if (window.__WORKSPACE_TEST__) {
    window.__WORKSPACE_TEST_API__ = {
      repositoryCandidates: repositoryCandidates,
      svnUrlForRoute: svnUrlForRoute,
      svnRepository: svnRepository,
      isSvnDocumentRoute: isSvnDocumentRoute,
      isSvnDocumentPage: isSvnDocumentPage,
      isDocumentView: isDocumentView,
      addTreeNumbers: addTreeNumbers,
      readableLink: readableLink,
      isStaticPageHref: isStaticPageHref,
      syncDescription: syncDescription
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
