(function () {
  'use strict';
  var params = new URLSearchParams(window.location.search || '');
  var state = { kind: params.get('kind') || 'pdf', path: params.get('path') || '', query: '' };
  if (!/^(pdf|word|excel|ppt)$/.test(state.kind)) { state.kind = 'pdf'; }
  var labels = { pdf: 'PDF 标准', word: 'Word 文档', excel: 'Excel 表格', ppt: 'PPT 演示' };
  var list = document.querySelector('[data-list]');
  var status = document.querySelector('[data-status]');
  var stats = document.querySelector('[data-stats]');
  var title = document.querySelector('[data-title]');
  var crumb = document.querySelector('[data-breadcrumb]');
  var preview = document.querySelector('[data-preview]');
  var previewBody = document.querySelector('[data-preview-body]');
  var previewTitle = document.querySelector('[data-preview-title]');
  var authInfo = document.querySelector('[data-auth-info]');
  var authForm = document.querySelector('[data-auth-form]');
  var authUsername = document.querySelector('[data-auth-username]');
  var authPassword = document.querySelector('[data-auth-password]');
  var authLogin = document.querySelector('[data-auth-login]');
  var authLogout = document.querySelector('[data-auth-logout]');
  var searchForm = document.querySelector('[data-search-form]');
  var searchInput = document.querySelector('[data-search]');
  var searchClear = document.querySelector('[data-search-clear]');
  var searchSerial = 0;
  var offlineData = window.__MD2WEB_REFERENCE_DATA__ || null;
  var offlineMode = window.location.protocol === 'file:';

  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function setStatus(message, error) { status.textContent = message || ''; status.className = 'status' + (error ? ' error' : ''); }
  function renderAuth(event) {
    var snapshot = event && event.detail ? event.detail : (window.SiteAuth && SiteAuth.snapshot ? SiteAuth.snapshot() : {});
    var user = snapshot.user;
    authInfo.textContent = user ? '已登录：' + (user.displayName || user.username) : '未登录 · 浏览公开资料，登录后可管理文件';
    authInfo.classList.toggle('is-user', !!user);
    authUsername.hidden = !!user;
    authPassword.hidden = !!user;
    authLogin.hidden = !!user;
    authLogout.hidden = !user;
  }
  function promptLogin() {
    setStatus('请先登录后再管理参考文献。', true);
    if (authUsername && !authUsername.hidden) { authUsername.focus(); }
  }
  function api(url, options) {
    var headers = Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {});
    if (window.SiteAuth && SiteAuth.csrfToken()) { headers['X-CSRF-Token'] = SiteAuth.csrfToken(); }
    return fetch(url, Object.assign({}, options || {}, { headers: headers })).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok || payload.ok === false) { throw new Error(payload.error || ('HTTP ' + response.status)); }
        return payload;
      });
    });
  }
  function typeLabel(ext, isFolder) { return isFolder ? '文件夹' : ({ '.pdf': 'PDF', '.doc': 'Word', '.docx': 'Word', '.xls': 'Excel', '.xlsx': 'Excel', '.ppt': 'PPT', '.pptx': 'PPT' }[ext] || '文件'); }
  function timeLabel(value) { if (!value) return '—'; var date = new Date(Number(value) * 1000); return isNaN(date.getTime()) ? '—' : date.toLocaleDateString(); }
  function sizeLabel(value) { var size = Number(value) || 0; if (size < 1024) return size + ' B'; if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'; if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(2) + ' MB'; return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB'; }
  function pageLabel(item, folder) { if (folder) return '—'; if (item.pages == null) return '页数未知'; return item.pages + ' ' + (item.pageUnit || '页'); }
  function localChildren(kind, path) {
    var items = offlineData && offlineData[kind] || [];
    var parent = String(path || '').replace(/\/+$/, '');
    return items.filter(function (item) {
      var slash = item.path.lastIndexOf('/');
      return (slash < 0 ? '' : item.path.slice(0, slash)) === parent;
    });
  }
  function localSearch(query) {
    var text = query.toLocaleLowerCase();
    var results = [];
    Object.keys(offlineData || {}).forEach(function (kind) {
      (offlineData[kind] || []).forEach(function (item) {
        if (item.kind === 'file' && item.name.toLocaleLowerCase().indexOf(text) !== -1) {
          var copy = Object.assign({}, item); copy.referenceKind = kind; results.push(copy);
        }
      });
    });
    var order = { pdf: 0, word: 1, excel: 2, ppt: 3 };
    return results.sort(function (a, b) { return (order[a.referenceKind] - order[b.referenceKind]) || a.name.localeCompare(b.name); });
  }
  function updateUrl() { history.replaceState(null, '', new URL('html/reference_library.html?kind=' + encodeURIComponent(state.kind) + (state.path ? '&path=' + encodeURIComponent(state.path) : ''), document.baseURI)); }
  function render(items, searching) {
    list.innerHTML = items.map(function (item) {
      var folder = item.kind === 'folder';
      var sourceKind = item.referenceKind || state.kind;
      var href = folder ? 'html/reference_library.html?kind=' + encodeURIComponent(sourceKind) + '&path=' + encodeURIComponent(item.path) : sourceKind + '/' + item.path.split('/').map(encodeURIComponent).join('/');
      var sourceAttr = ' data-reference-kind="' + esc(sourceKind) + '"';
      var previewAttr = folder || item.ext === '.pdf' ? '' : ' data-preview-file="' + esc(item.path) + '"' + sourceAttr;
      var newTabAttr = item.ext === '.pdf' ? ' target="_blank" rel="noopener"' : '';
      var actions = offlineMode ? '' : '<button type="button" data-rename="' + esc(item.path) + '"' + sourceAttr + '>重命名</button><button type="button" class="danger" data-delete="' + esc(item.path) + '"' + sourceAttr + '>删除</button>';
      return '<div class="item"><div class="name"><span class="icon ' + (folder ? '' : 'file') + '">' + (folder ? '▰' : '▤') + '</span><a href="' + esc(href) + '"' + previewAttr + newTabAttr + '>' + esc(item.name) + '</a></div><div class="muted">' + (searching ? esc(sourceKind.toUpperCase()) + ' · ' : '') + typeLabel(item.ext, folder) + '<br>' + sizeLabel(item.size) + ' · ' + pageLabel(item, folder) + '</div><div class="muted">' + timeLabel(item.mtime) + '</div><div class="actions-cell">' + actions + '</div></div>';
    }).join('') || '<div class="empty"><strong>' + (searching ? '没有找到匹配的文件' : '这个文件夹还没有资料') + '</strong><span>' + (searching ? '请尝试文件名中的其他关键词。' : '可以上传文件，或先新建一个子文件夹。') + '</span></div>';
    stats.textContent = searching ? '找到 ' + items.length + ' 个文件 · 已按 PDF、Word、Excel、PPT 汇总' : items.length + ' 个项目 · 文件夹可继续展开，文件点击后在新窗口预览或下载';
  }
  function searchReferences() {
    var serial = ++searchSerial;
    var query = state.query.trim();
    searchClear.hidden = !query;
    if (!query) { load(); return; }
    title.textContent = '搜索结果';
    crumb.textContent = '全部资料 · ' + query;
    setStatus('正在搜索…');
    if (offlineMode && offlineData) { render(localSearch(query), true); setStatus(''); return; }
    api('__references/search?q=' + encodeURIComponent(query) + '&kind=all').then(function (payload) { if (serial !== searchSerial) return; render((payload.results || []).map(function (item) { item.referenceKind = item.kind; item.kind = 'file'; return item; }), true); setStatus(''); }).catch(function (error) { if (serial !== searchSerial) return; render([], true); setStatus(error.message, true); });
  }
  function load() {
    if (state.query.trim()) { searchReferences(); return; }
    title.textContent = labels[state.kind];
    document.querySelectorAll('[data-kind-nav]').forEach(function (node) { node.classList.toggle('active', node.getAttribute('data-kind-nav') === state.kind); });
    crumb.textContent = state.path || '根目录';
    setStatus('');
    if (offlineMode && offlineData) { render(localChildren(state.kind, state.path), false); setStatus('离线目录快照 · 管理操作需通过服务地址打开'); return; }
    api('__references/list?kind=' + encodeURIComponent(state.kind) + '&path=' + encodeURIComponent(state.path)).then(function (payload) { render(payload.listing.items || [], false); }).catch(function (error) { list.innerHTML = '<div class="empty"><strong>暂时无法读取资料</strong><span>' + esc(error.message) + '</span></div>'; setStatus(error.message, true); });
  }
  function mutate(url, body) {
    if (window.SiteAuth && !SiteAuth.isAuthenticated()) {
      promptLogin();
      return Promise.resolve();
    }
    return api(url, { method: 'POST', body: JSON.stringify(body) }).then(function () { setStatus('操作完成'); load(); }).catch(function (error) {
      if (error.message === 'HTTP 401' && window.SiteAuth) { SiteAuth.openLogin(); }
      setStatus('操作失败：' + error.message, true);
    });
  }
  document.querySelectorAll('[data-kind-nav]').forEach(function (node) { node.addEventListener('click', function () { state.kind = node.getAttribute('data-kind-nav'); state.path = ''; state.query = ''; searchInput.value = ''; updateUrl(); load(); }); });
  document.querySelector('[data-root]').addEventListener('click', function () { state.path = ''; state.query = ''; searchInput.value = ''; updateUrl(); load(); });
  document.querySelector('[data-up]').addEventListener('click', load);
  searchForm.addEventListener('submit', function (event) { event.preventDefault(); searchReferences(); });
  searchInput.addEventListener('input', function () { state.query = searchInput.value; searchReferences(); });
  searchForm.addEventListener('reset', function () { window.setTimeout(function () { state.query = ''; searchInput.value = ''; load(); }, 0); });
  authForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var username = authUsername.value.trim();
    var password = authPassword.value;
    if (!username || !password) { setStatus('请输入 SVN 用户名和密码。', true); return; }
    authLogin.disabled = true;
    setStatus('正在登录…');
    SiteAuth.login(username, password).then(function () {
      authPassword.value = '';
      setStatus('登录成功');
      load();
    }).catch(function (error) {
      setStatus(error && error.message ? error.message : '登录失败', true);
    }).then(function () { authLogin.disabled = false; });
  });
  authLogout.addEventListener('click', function () { SiteAuth.logout().then(function () { renderAuth(); }); });
  document.addEventListener('siteauth:change', renderAuth);
  document.querySelector('[data-mkdir]').addEventListener('click', function () { var name = window.prompt('输入新文件夹名称'); if (name) mutate('__references/mkdir', { kind: state.kind, parent: state.path, name: name }); });
  document.querySelector('[data-upload]').addEventListener('click', function () { document.querySelector('[data-file]').click(); });
  document.querySelector('[data-file]').addEventListener('change', function () {
    var input = this;
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return;
    if (window.SiteAuth && !SiteAuth.isAuthenticated()) {
      promptLogin();
      input.value = '';
      return;
    }
    var form = new FormData(); form.append('kind', state.kind); form.append('path', state.path);
    files.forEach(function (file) { form.append('file', file, file.name); });
    setStatus('正在上传 ' + files.length + ' 个文件…');
    var headers = {}; if (window.SiteAuth && SiteAuth.csrfToken()) headers['X-CSRF-Token'] = SiteAuth.csrfToken();
    fetch('__references/upload', { method: 'POST', headers: headers, body: form }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok || payload.ok === false) { throw new Error(payload.error || ('上传失败（HTTP ' + response.status + '）')); }
        return payload;
      });
    }).then(function (payload) {
      var results = payload.results || [];
      var failed = results.filter(function (item) { return !item.ok; });
      if (failed.length) {
        setStatus('已上传 ' + (results.length - failed.length) + ' 个，失败 ' + failed.length + ' 个：' + failed.map(function (item) { return item.name + '（' + item.error + '）'; }).join('、'), true);
      } else {
        setStatus('已上传 ' + results.length + ' 个文件');
      }
      load();
    }).catch(function (error) { setStatus(error.message, true); }).then(function () { input.value = ''; });
  });
  document.addEventListener('click', function (event) {
    var node = event.target;
    if (node.hasAttribute('data-preview-file')) { event.preventDefault(); openPreview(node.getAttribute('data-preview-file'), node.textContent, node.getAttribute('data-reference-kind') || state.kind); }
    if (node.hasAttribute('data-rename')) { var name = window.prompt('输入新名称'); if (name) mutate('__references/rename', { kind: node.getAttribute('data-reference-kind') || state.kind, path: node.getAttribute('data-rename'), name: name }); }
    if (node.hasAttribute('data-delete') && window.confirm('删除后会进入回收站，确认继续？')) { mutate('__references/delete', { kind: node.getAttribute('data-reference-kind') || state.kind, path: node.getAttribute('data-delete') }); }
  });
  document.querySelector('[data-preview-close]').addEventListener('click', function () { preview.hidden = true; previewBody.innerHTML = ''; });
  preview.addEventListener('click', function (event) { if (event.target === preview) { preview.hidden = true; previewBody.innerHTML = ''; } });
  function openPreview(filePath, name, sourceKind) {
    var ext = filePath.split('.').pop().toLowerCase();
    sourceKind = sourceKind || state.kind;
    var url = sourceKind + '/' + filePath.split('/').map(encodeURIComponent).join('/');
    previewTitle.textContent = name || filePath; preview.hidden = false; previewBody.innerHTML = '';
    if (ext === 'pdf') { var frame = document.createElement('iframe'); frame.src = url; frame.style.cssText = 'border:0;height:100%;width:100%'; previewBody.appendChild(frame); return; }
    function fallback() { previewBody.innerHTML = '<div class="preview-message">当前浏览器无法直接预览该 Office 文件。<br><a href="' + esc(url) + '" target="_blank" rel="noopener">打开或下载原文件</a></div>'; }
    if (!window.Md2webOffice || !window.Md2webOffice.mount) { fallback(); return; }
    var host = document.createElement('div'); previewBody.appendChild(host);
    window.Md2webOffice.mount(host, { type: ext, src: url, onError: fallback });
  }
  renderAuth();
  if (window.SiteAuth) { SiteAuth.refresh().then(function () { renderAuth(); load(); }); } else { load(); }
}());
