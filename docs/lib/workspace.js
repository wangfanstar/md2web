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
    all('.workspace-folder-toggle, .workspace-folder-count', clone).forEach(function (node) { node.remove(); });
    return text(clone);
  }
  function folderKey(li) {
    var labels = [], node = li;
    while (node && node.tagName === 'LI') { labels.unshift(folderLabel(node)); node = node.parentElement && node.parentElement.closest('li'); }
    return 'folder:' + labels.join('/').toLowerCase();
  }
  function isFolder(li) { return !!li.querySelector(':scope > ul'); }

  function decorateTree() {
    var nav = document.querySelector('.sidebar-nav');
    if (!nav) return;
    var root = nav.querySelector(':scope > ul') || nav.querySelector('ul');
    if (!root) return;
    var collapsed = readCollapsed();
    all('li', root).forEach(function (li) {
      if (!isFolder(li)) return;
      var child = li.querySelector(':scope > ul');
      var label = li.querySelector(':scope > strong, :scope > a, :scope > span');
      if (!label) label = li.firstElementChild;
      if (!label || !label.querySelector(':scope > .workspace-folder-toggle')) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'workspace-folder-toggle';
        button.setAttribute('aria-label', '展开或折叠目录');
        if (label) label.insertBefore(button, label.firstChild);
        else li.insertBefore(button, child);
        button.addEventListener('click', function (event) {
          event.preventDefault(); event.stopPropagation();
          var close = !li.classList.contains('is-collapsed');
          setCollapsed(li, close);
          collapsed[folderKey(li)] = close;
          saveCollapsed(collapsed);
        });
      }
      if (!label || !label.querySelector(':scope > .workspace-folder-count')) {
        var count = document.createElement('span');
        count.className = 'workspace-folder-count';
        count.textContent = String(all(':scope a[href]', li).length);
        var target = label || li;
        target.appendChild(count);
      }
      if (Object.prototype.hasOwnProperty.call(collapsed, folderKey(li))) {
        setCollapsed(li, !!collapsed[folderKey(li)]);
      } else if (!li.classList.contains('is-collapsed')) {
        setCollapsed(li, false);
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
      tools.querySelector('input').addEventListener('input', function () { state.filter = this.value.trim().toLowerCase(); filterTree(root); });
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
    var routeChanged = state.lastRoute !== currentRoute();
    if (routeChanged) { state.lastRoute = currentRoute(); locateCurrent(root, false); }
  }

  function filterTree(root) {
    var query = state.filter;
    function visit(ul) {
      var any = false;
      all(':scope > li', ul).forEach(function (li) {
        var own = text(li.querySelector(':scope > a')) .toLowerCase();
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

  function addBreadcrumb() {
    var section = document.querySelector('.markdown-section');
    if (!section) return;
    var route = currentRoute();
    var parts = route ? route.split('/').filter(Boolean) : [];
    var crumb = section.querySelector(':scope > .workspace-breadcrumb');
    if (!crumb) { crumb = document.createElement('nav'); crumb.className = 'workspace-breadcrumb'; crumb.setAttribute('aria-label', '当前位置'); section.insertBefore(crumb, section.firstChild); }
    var labels = ['首页'].concat(parts);
    if (crumb.getAttribute('data-route') !== route) {
      crumb.innerHTML = labels.map(function (part, index) {
        var label = part.replace(/\.md$/i, '');
        if (index === labels.length - 1) return '<span aria-current="page">' + escape(label) + '</span>';
        if (index === 0) return '<a href="#/">' + escape(label) + '</a><span class="workspace-breadcrumb-sep">/</span>';
        return '<span>' + escape(label) + '</span><span class="workspace-breadcrumb-sep">/</span>';
      }).join('');
      crumb.setAttribute('data-route', route);
    }
    var actions = section.querySelector(':scope > .workspace-page-actions');
    if (!actions) { actions = document.createElement('div'); actions.className = 'workspace-page-actions'; section.insertBefore(actions, crumb.nextSibling); }
    if (!actions.querySelector('[data-workspace-copy-path]')) {
      var numbersHidden = document.body.classList.contains('hide-heading-numbers');
      actions.innerHTML = '<button type="button" data-workspace-copy-path>复制路径</button><button type="button" data-workspace-export>下载本页</button><button type="button" data-workspace-wide>' + (document.body.classList.contains('workspace-wide') ? '退出宽屏' : '宽屏阅读') + '</button><button type="button" data-workspace-numbers>' + (numbersHidden ? '显示序号' : '隐藏序号') + '</button>';
      actions.querySelector('[data-workspace-copy-path]').addEventListener('click', function () { copyText(route ? 'docs/' + route + (/.md$/i.test(route) ? '' : '.md') : 'docs/README.md', this); });
      actions.querySelector('[data-workspace-export]').addEventListener('click', function () { if (window.PageExport) { window.PageExport.download(); } });
      actions.querySelector('[data-workspace-wide]').addEventListener('click', function () { document.body.classList.toggle('workspace-wide'); try { localStorage.setItem(STORAGE.wide, document.body.classList.contains('workspace-wide') ? '1' : ''); } catch (_) {} var toggle = actions.querySelector('[data-workspace-wide]'); toggle.textContent = document.body.classList.contains('workspace-wide') ? '退出宽屏' : '宽屏阅读'; });
      actions.querySelector('[data-workspace-numbers]').addEventListener('click', function () { var hidden = document.body.classList.toggle('hide-heading-numbers'); try { localStorage.setItem(STORAGE.numbers, hidden ? '0' : '1'); } catch (_) {} this.textContent = hidden ? '显示序号' : '隐藏序号'; });
    }
  }
  function escape(value) { return String(value).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
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
  function enhance() { decorateTree(); addBreadcrumb(); addCodeButtons(); }
  function schedule() { clearTimeout(state.timer); state.timer = setTimeout(enhance, 40); }
  function init() {
    try { if (localStorage.getItem(STORAGE.wide) === '1') document.body.classList.add('workspace-wide'); } catch (_) {}
    try { if (localStorage.getItem(STORAGE.numbers) === '0') document.body.classList.add('hide-heading-numbers'); } catch (_) {}
    enhance();
    state.observer = new MutationObserver(schedule);
    state.observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('hashchange', schedule);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
