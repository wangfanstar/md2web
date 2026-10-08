(function () {
  'use strict';
  function search(items, query) {
    var terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(function (item) {
      var haystack = [item.title, item.path, item.text].join(' ').toLowerCase();
      return terms.every(function (term) { return haystack.indexOf(term) !== -1; });
    });
  }
  function excerpt(text, query) {
    text = String(text || '');
    var term = String(query || '').trim().toLowerCase().split(/\s+/)[0];
    var position = term ? text.toLowerCase().indexOf(term) : 0;
    var start = Math.max(0, position - 45);
    return (start ? '…' : '') + text.slice(start, start + 180) + (text.length > start + 180 ? '…' : '');
  }
  window.ReferenceWeb = { search: search, excerpt: excerpt };
  var input = document.getElementById('web-query');
  if (!input) return;
  var items = window.__REFERENCE_WEB_DATA__ || [];
  var results = document.getElementById('web-results');
  var count = document.getElementById('web-count');
  var empty = document.getElementById('web-empty');
  function render() {
    var found = search(items, input.value);
    results.textContent = '';
    count.textContent = input.value.trim() ? '找到 ' + found.length + ' / ' + items.length + ' 个网页' : '共 ' + items.length + ' 个网页';
    empty.hidden = found.length > 0;
    empty.textContent = items.length ? '没有匹配的网页，请尝试其他关键词或清空搜索。' : '还没有参考网页。将 HTML 文件放入 docs/html/ref/ 后点击“更新索引”。';
    found.forEach(function (item) {
      var card = document.createElement('a');
      card.className = 'web-result';
      card.href = item.url;
      card.target = '_blank';
      card.rel = 'noopener';
      var title = document.createElement('h2');
      title.textContent = item.title;
      var path = document.createElement('p');
      path.className = 'web-path';
      path.textContent = item.path + ' · ' + Math.max(1, Math.ceil(item.size / 1024)) + ' KB';
      var snippet = document.createElement('p');
      snippet.textContent = excerpt(item.text, input.value);
      card.appendChild(title);
      card.appendChild(path);
      card.appendChild(snippet);
      results.appendChild(card);
    });
  }
  input.addEventListener('input', render);
  var form = document.getElementById('reference-web-search');
  form.addEventListener('submit', function (event) { event.preventDefault(); render(); });
  form.addEventListener('reset', function (event) {
    event.preventDefault(); input.value = ''; render(); input.focus();
  });
  var refresh = document.getElementById('web-refresh');
  var status = document.getElementById('web-update-status');
  var folderInput = document.getElementById('web-folder');
  var download = document.getElementById('web-download');
  function request(url, options) {
    return fetch(url, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok || !payload.ok) throw new Error(payload.error || '服务不支持更新索引，请升级并重启服务（HTTP ' + response.status + '）');
        return payload;
      });
    });
  }
  refresh.addEventListener('click', function () {
    if (window.location.protocol === 'file:') {
      status.textContent = '请选择当前页面所在的 ref 文件夹，浏览器需要您授权读取本地文件。';
      folderInput.value = '';
      folderInput.click();
      return;
    }
    refresh.disabled = true;
    status.textContent = '正在扫描参考网页…';
    request('__reference-web/list', { cache: 'no-store' }).then(function (payload) {
      items = payload.items || [];
      render();
      return window.SiteAuth && window.SiteAuth.refresh ? window.SiteAuth.refresh() : null;
    }).then(function () {
      if (!window.SiteAuth || !window.SiteAuth.isAuthenticated()) {
        status.textContent = '已更新 ' + items.length + ' 个网页。登录认证编辑服务后再次点击，可保存到索引页。';
        return;
      }
      return request('__reference-web/refresh', {
        method: 'POST', headers: { 'X-CSRF-Token': window.SiteAuth.csrfToken() }
      }).then(function (payload) {
        items = payload.items || [];
        render();
        status.textContent = '已更新并保存 ' + items.length + ' 个网页的索引和链接。';
      });
    }).catch(function (error) {
      status.textContent = '更新失败：' + error.message;
    }).then(function () { refresh.disabled = false; });
  });
  folderInput.addEventListener('change', function () {
    var files = Array.prototype.slice.call(folderInput.files || []);
    if (!files.length) return;
    refresh.disabled = true;
    status.textContent = '正在读取所选文件夹…';
    Promise.all(files.filter(function (file) {
      var path = file.webkitRelativePath.split('/').slice(1).join('/');
      return /\.html?$/i.test(path) && path.toLowerCase() !== 'index_html.html'
        && !path.split('/').some(function (part) { return part.charAt(0) === '.' || part === '回收站'; });
    }).map(function (file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onerror = function () { reject(new Error('无法读取 ' + file.name)); };
        reader.onload = function () {
          var doc = new DOMParser().parseFromString(reader.result, 'text/html');
          Array.prototype.forEach.call(doc.querySelectorAll('script,style,template,noscript'), function (node) { node.remove(); });
          var path = file.webkitRelativePath.split('/').slice(1).join('/');
          resolve({ title: doc.title.trim() || file.name, path: path,
            url: 'html/ref/' + path.split('/').map(encodeURIComponent).join('/'),
            text: (doc.body.textContent || '').replace(/\s+/g, ' ').trim(), size: file.size });
        };
        reader.readAsText(file);
      });
    })).then(function (found) {
      items = found.sort(function (a, b) { return a.path.localeCompare(b.path); });
      render();
      download.hidden = false;
      status.textContent = '已更新 ' + items.length + ' 个网页。可下载索引页并替换 ref/index_html.html，以保存此次更新。';
    }).catch(function (error) { status.textContent = '更新失败：' + error.message; })
      .then(function () { refresh.disabled = false; });
  });
  download.addEventListener('click', function () {
    var query = input.value;
    input.value = '';
    render();
    var clone = document.documentElement.cloneNode(true);
    input.value = query;
    render();
    var dataScript = clone.querySelector('script[src*="reference-web-data.js"]') || clone.querySelector('script[data-reference-snapshot]');
    dataScript.removeAttribute('src');
    dataScript.setAttribute('data-reference-snapshot', '');
    dataScript.textContent = 'window.__REFERENCE_WEB_DATA__ = ' + JSON.stringify(items).replace(/</g, '\\u003c') + ';';
    clone.querySelector('#web-update-status').textContent = '';
    clone.querySelector('#web-download').hidden = true;
    var url = URL.createObjectURL(new Blob(['<!doctype html>\n' + clone.outerHTML], { type: 'text/html;charset=utf-8' }));
    var link = document.createElement('a');
    link.href = url; link.download = 'index_html.html'; link.click();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
  render();
}());
