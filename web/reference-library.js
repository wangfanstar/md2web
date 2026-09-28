(function () {
  'use strict';
  var params = new URLSearchParams(window.location.search || '');
  var state = { kind: params.get('kind') || 'pdf', path: params.get('path') || '' };
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

  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function setStatus(message, error) { status.textContent = message || ''; status.className = 'status' + (error ? ' error' : ''); }
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
  function updateUrl() { history.replaceState(null, '', new URL('html/reference_library.html?kind=' + encodeURIComponent(state.kind) + (state.path ? '&path=' + encodeURIComponent(state.path) : ''), document.baseURI)); }
  function render(items) {
    list.innerHTML = items.map(function (item) {
      var folder = item.kind === 'folder';
      var href = folder ? 'html/reference_library.html?kind=' + encodeURIComponent(state.kind) + '&path=' + encodeURIComponent(item.path) : state.kind + '/' + item.path.split('/').map(encodeURIComponent).join('/');
      return '<div class="item"><div class="name"><span class="icon ' + (folder ? '' : 'file') + '">' + (folder ? '▰' : '▤') + '</span><a href="' + esc(href) + '"' + (folder ? '' : ' data-preview-file="' + esc(item.path) + '"') + '>' + esc(item.name) + '</a></div><div class="muted">' + typeLabel(item.ext, folder) + '</div><div class="muted">' + timeLabel(item.mtime) + '</div><div class="actions-cell"><button type="button" data-rename="' + esc(item.path) + '">重命名</button><button type="button" class="danger" data-delete="' + esc(item.path) + '">删除</button></div></div>';
    }).join('') || '<div class="empty"><strong>这个文件夹还没有资料</strong><span>可以上传文件，或先新建一个子文件夹。</span></div>';
    stats.textContent = items.length + ' 个项目 · 文件夹可继续展开，文件点击后在新窗口预览或下载';
  }
  function load() {
    title.textContent = labels[state.kind];
    document.querySelectorAll('[data-kind-nav]').forEach(function (node) { node.classList.toggle('active', node.getAttribute('data-kind-nav') === state.kind); });
    crumb.textContent = state.path || '根目录';
    setStatus('');
    api('__references/list?kind=' + encodeURIComponent(state.kind) + '&path=' + encodeURIComponent(state.path)).then(function (payload) { render(payload.listing.items || []); }).catch(function (error) { list.innerHTML = '<div class="empty"><strong>暂时无法读取资料</strong><span>' + esc(error.message) + '</span></div>'; setStatus(error.message, true); });
  }
  function mutate(url, body) {
    if (window.SiteAuth && !SiteAuth.isAuthenticated()) {
      setStatus('请先登录后再管理参考文献。', true);
      SiteAuth.openLogin();
      return Promise.resolve();
    }
    return api(url, { method: 'POST', body: JSON.stringify(body) }).then(function () { setStatus('操作完成'); load(); }).catch(function (error) {
      if (error.message === 'HTTP 401' && window.SiteAuth) { SiteAuth.openLogin(); }
      setStatus('操作失败：' + error.message, true);
    });
  }
  document.querySelectorAll('[data-kind-nav]').forEach(function (node) { node.addEventListener('click', function () { state.kind = node.getAttribute('data-kind-nav'); state.path = ''; updateUrl(); load(); }); });
  document.querySelector('[data-root]').addEventListener('click', function () { state.path = ''; updateUrl(); load(); });
  document.querySelector('[data-up]').addEventListener('click', load);
  document.querySelector('[data-mkdir]').addEventListener('click', function () { var name = window.prompt('输入新文件夹名称'); if (name) mutate('__references/mkdir', { kind: state.kind, parent: state.path, name: name }); });
  document.querySelector('[data-upload]').addEventListener('click', function () { document.querySelector('[data-file]').click(); });
  document.querySelector('[data-file]').addEventListener('change', function () {
    var file = this.files && this.files[0]; if (!file) return;
    var form = new FormData(); form.append('kind', state.kind); form.append('path', state.path); form.append('file', file); setStatus('正在上传…');
    var headers = {}; if (window.SiteAuth && SiteAuth.csrfToken()) headers['X-CSRF-Token'] = SiteAuth.csrfToken();
    fetch('__references/upload', { method: 'POST', headers: headers, body: form }).then(function (response) { if (!response.ok) throw new Error('上传失败（' + response.status + '）'); return response.json(); }).then(function () { setStatus('上传完成'); load(); }).catch(function (error) { setStatus(error.message, true); }); this.value = '';
  });
  document.addEventListener('click', function (event) {
    var node = event.target;
    if (node.hasAttribute('data-preview-file')) { event.preventDefault(); openPreview(node.getAttribute('data-preview-file'), node.textContent); }
    if (node.hasAttribute('data-rename')) { var name = window.prompt('输入新名称'); if (name) mutate('__references/rename', { kind: state.kind, path: node.getAttribute('data-rename'), name: name }); }
    if (node.hasAttribute('data-delete') && window.confirm('删除后会进入回收站，确认继续？')) { mutate('__references/delete', { kind: state.kind, path: node.getAttribute('data-delete') }); }
  });
  document.querySelector('[data-preview-close]').addEventListener('click', function () { preview.hidden = true; previewBody.innerHTML = ''; });
  preview.addEventListener('click', function (event) { if (event.target === preview) { preview.hidden = true; previewBody.innerHTML = ''; } });
  function openPreview(filePath, name) {
    var ext = filePath.split('.').pop().toLowerCase();
    var url = state.kind + '/' + filePath.split('/').map(encodeURIComponent).join('/');
    previewTitle.textContent = name || filePath; preview.hidden = false; previewBody.innerHTML = '';
    if (ext === 'pdf') { var frame = document.createElement('iframe'); frame.src = url; frame.style.cssText = 'border:0;height:100%;width:100%'; previewBody.appendChild(frame); return; }
    if (!window.Md2webOffice || !window.Md2webOffice.mount) { previewBody.innerHTML = '<div class="preview-message">本地预览引擎未加载，请刷新页面或下载原文件。</div>'; return; }
    var host = document.createElement('div'); previewBody.appendChild(host);
    window.Md2webOffice.mount(host, { type: ext, src: url, onError: function () { previewBody.innerHTML = '<div class="preview-message">该文件无法在本地预览，请检查文件是否损坏，然后下载原文件。</div>'; } });
  }
  load();
}());
