(function (root) {
  'use strict';
  function escape(value) {
    return String(value || '').replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c];
    });
  }
  function fallbackHref(mount) {
    return 'html/index_all.html#/' + String(mount).split('/').map(encodeURIComponent).join('/') + '/';
  }
  function normalize(items) {
    if (!Array.isArray(items)) throw new Error('仓库清单格式无效');
    return items.map(function (item) {
      var mount = String(item.mount || '');
      if (!/^md\/[^/]+/.test(mount) || mount.split('/').some(function (p) { return !p || p.charAt(0) === '.'; })) throw new Error('仓库路径无效');
      var href = String(item.href || '');
      if (!/^html\/index_[^/?#]+\.html(?:#\/md\/.*)?$/.test(href)) href = fallbackHref(mount);
      return {id:String(item.id || mount.slice(3)), mount:mount,
        display_name:String(item.display_name || item.displayName || item.id || mount.slice(3)),
        href:href, group:String(item.group || '默认'),
        source_mode:item.source_mode || item.sourceMode || 'local',
        read_only:!!(item.read_only || item.readOnly), allow_commit:item.allow_commit !== false && item.allowCommit !== false};
    });
  }
  function render(items) {
    var groups = new Map();
    normalize(items).forEach(function (repo) { if (!groups.has(repo.group)) groups.set(repo.group, []); groups.get(repo.group).push(repo); });
    var html = '';
    Array.from(groups.keys()).sort().forEach(function (group) {
      html += '<h2>' + escape(group) + '</h2><div class="cards">';
      groups.get(group).forEach(function (repo) {
        var source = repo.source_mode === 'svn' ? 'SVN 库' : repo.source_mode === 'symlink' ? '↗ 软链接' : '本地文件夹';
        var style = repo.source_mode === 'svn' ? 'svn' : repo.source_mode === 'symlink' ? 'symlink' : 'local';
        html += '<a class="card" href="' + escape(repo.href) + '"><strong>' + escape(repo.display_name)
          + '<span class="badge ' + style + '">' + source + '</span>'
          + (repo.read_only ? '<span class="badge readonly">只读</span>' : '')
          + (!repo.allow_commit ? '<span class="badge readonly">禁止合入</span>' : '')
          + '</strong><span>目录：' + escape(repo.mount) + '</span></a>';
      });
      html += '</div>';
    });
    return html || '<p class="empty">当前没有仓库，请在仓库配置中添加。</p>';
  }
  function fromLegacy(folders, configured) {
    var byMount = new Map();
    (configured || []).forEach(function (repo) { byMount.set(repo.mount, repo); });
    (folders || []).forEach(function (folder) {
      if (!byMount.has(folder.path)) byMount.set(folder.path, Object.assign({}, folder.repo || {}, {
        id:(folder.repo || {}).id || folder.name, mount:folder.path, sourceMode:folder.sourceMode || 'local'
      }));
    });
    return normalize(Array.from(byMount.values()));
  }
  if (typeof module !== 'undefined') { module.exports = {normalize:normalize, render:render, fromLegacy:fromLegacy}; return; }
  if (!root || root.location.protocol === 'file:') return;
  var busy = false;
  function read(path) {
    return root.fetch(path, {cache:'no-store', credentials:'same-origin'}).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
  }
  function refresh() {
    var host = document.querySelector('[data-master-repositories]');
    if (!host || busy) return;
    busy = true;
    return read('__site/repositories').then(function (data) {
      if (!data.ok) throw new Error('读取仓库失败');
      return normalize(data.repositories);
    }).catch(function () {
      // Support an authenticated service that has not been restarted after deployment.
      return Promise.all([read('__folders'), read('__auth/session')]).then(function (values) {
        if (!values[0].ok || !Array.isArray(values[0].folders) || !values[1].ok) throw new Error('读取仓库失败');
        return fromLegacy(values[0].folders, (values[1].site || {}).repositories);
      });
    }).catch(function () {
      // A static server also has a public build inventory. This file belongs to
      // the deployed document tree, rather than the machine that supplied index.html.
      return Promise.all([read('lib/source-folders.json'), read('html/navigation-map.json').catch(function () { return {}; })]).then(function (values) {
        var data = values[0], navigation = values[1].folders || {};
        if (!Array.isArray(data.folders)) throw new Error('目录快照无效');
        var mounts = data.folders.filter(function (mount) { return /^md\/[^/]+$/.test(mount); });
        var configured = (root.__MD2WEB_REPOS__ || []).filter(function (repo) { return mounts.indexOf(repo.mount) !== -1; });
        return fromLegacy(mounts.map(function (mount) { return {path:mount,name:mount.slice(3)}; }), configured).map(function (item) {
          var target = navigation[item.mount];
          if (target && target.href) item.href = target.href;
          else {
            var name = item.id.replace(/[^0-9A-Za-z._㐀-䶿一-鿿-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
            item.href = 'html/index_' + name + '.html';
          }
          return item;
        });
      });
    }).then(function (items) {
      host.innerHTML = render(items);
      root.dispatchEvent(new CustomEvent('md2web:repositories', {detail:items}));
    }).catch(function () { /* Static hosting or temporary network failure: retain the complete offline snapshot. */ })
      .then(function () { busy = false; });
  }
  root.addEventListener('focus', refresh);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
  else refresh();
})(typeof window !== 'undefined' ? window : null);
