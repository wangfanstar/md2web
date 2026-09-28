(function () {
  'use strict';
  var params = new URLSearchParams(window.location.search || '');
  var kind = params.get('kind') || '';
  var path = params.get('path') || '';
  var title = document.querySelector('[data-title]');
  var meta = document.querySelector('[data-meta]');
  var notice = document.querySelector('[data-notice]');
  var host = document.getElementById('office-viewer');
  var download = document.querySelector('[data-download]');
  var allowedKinds = { word: true, excel: true, ppt: true };
  var allowedExt = { '.doc': true, '.docx': true, '.xls': true, '.xlsx': true, '.ppt': true, '.pptx': true };
  var labels = { word: 'Word 文档', excel: 'Excel 表格', ppt: 'PPT 演示' };

  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function validPath(value) { return !!value && value.indexOf('\\') === -1 && value.charAt(0) !== '/' && value.split('/').every(function (part) { return !!part && part !== '.' && part !== '..'; }); }
  function fileUrl(value) { return kind + '/' + value.split('/').map(encodeURIComponent).join('/'); }
  function showError(message) {
    notice.className = 'notice error';
    notice.innerHTML = esc(message) + (download.hidden ? '' : '　<a href="' + esc(download.href) + '" target="_blank" rel="noopener">打开原文件</a>');
  }
  var ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  var valid = allowedKinds[kind] && validPath(path) && allowedExt[ext];
  if (!valid) {
    title.textContent = '无法预览文件';
    meta.textContent = '参数无效';
    showError('文件类型或路径无效。');
    return;
  }
  var url = fileUrl(path);
  title.textContent = path.split('/').pop();
  meta.textContent = labels[kind] + ' · 本地离线预览';
  download.href = url;
  download.target = '_blank';
  download.rel = 'noopener';
  download.hidden = false;
  if (!window.Md2webOffice || typeof window.Md2webOffice.mount !== 'function') {
    showError('本地预览组件未加载，请检查 docs/lib/reference-office.bundle.js。');
    return;
  }
  try {
    window.Md2webOffice.mount(host, {
      type: ext.slice(1),
      src: url,
      onRendered: function () { notice.className = 'notice'; notice.textContent = '已加载本地预览 · 文件不会上传到网络'; },
      onError: function () { showError('当前格式暂时无法在浏览器中预览，请打开或下载原文件。'); }
    });
  } catch (error) {
    showError('预览失败：' + (error && error.message ? error.message : '未知错误'));
  }
}());
