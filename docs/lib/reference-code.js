(function () {
  'use strict';
  var repo = document.getElementById('repo');
  var tree = document.getElementById('tree');
  var source = document.getElementById('source');
  var params = new URLSearchParams(location.search);
  var selectedPath = '', revision = '', identity = '';
  var generation = 0, fileRequest = 0, searchRequest = 0;
  var initializing = false;

  function status(message) { document.getElementById('status').textContent = message; }
  function api(action, extra) {
    var query = new URLSearchParams(Object.assign({ repo: repo.value }, extra || {}));
    return fetch('__code/' + action + '?' + query, { credentials: 'same-origin', cache: 'no-store' }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) throw new Error(data.message || data.error || '读取失败，请重试');
        return data;
      });
    });
  }
  function button(text, handler) {
    var element = document.createElement('button');
    element.type = 'button'; element.textContent = text; element.onclick = handler;
    return element;
  }
  function fileLink(path, line) {
    return 'html/reference_code.html?' + new URLSearchParams({ repo: repo.value, path: path, rev: revision }) + '#L' + line;
  }
  function selectedLine() {
    var match = /^#L(\d+)$/.exec(location.hash);
    return match ? Number(match[1]) : 1;
  }
  function highlightLine(line, scroll) {
    source.querySelectorAll('.is-selected').forEach(function (row) { row.classList.remove('is-selected'); });
    var target = document.getElementById('L' + line);
    if (target) {
      target.classList.add('is-selected');
      if (scroll) target.scrollIntoView({ block: 'center' });
    }
  }
  function setFileActions(enabled) {
    document.getElementById('copy').disabled = !enabled;
    document.getElementById('ask').disabled = !enabled;
  }
  function openFile(path, line, expectedRevision) {
    var token = generation, request = ++fileRequest;
    source.hidden = true; setFileActions(false);
    var empty = document.getElementById('empty');
    empty.hidden = false; empty.textContent = '正在读取 ' + path + '…';
    status('正在读取文件…');
    return api('file', { path: path, rev: expectedRevision || '' }).then(function (data) {
      if (token !== generation || request !== fileRequest) return;
      selectedPath = path; revision = data.revision;
      document.getElementById('revision').textContent = revision === 'local' ? '本地代码' : 'SVN r' + revision;
      document.getElementById('path').textContent = path;
      source.textContent = '';
      var fragment = document.createDocumentFragment();
      data.text.split('\n').forEach(function (text, index) {
        var row = document.createElement('span'); row.className = 'code-line'; row.id = 'L' + (index + 1);
        var number = document.createElement('a'); number.className = 'code-line-number';
        number.textContent = index + 1; number.href = fileLink(path, index + 1);
        number.setAttribute('aria-label', '第 ' + (index + 1) + ' 行，点击选择');
        number.onclick = function (event) {
          event.preventDefault(); history.replaceState(null, '', number.href); highlightLine(index + 1, false);
        };
        var content = document.createElement('code'); content.textContent = text || ' ';
        row.appendChild(number); row.appendChild(content); fragment.appendChild(row);
      });
      source.appendChild(fragment); source.hidden = false; empty.hidden = true; setFileActions(true);
      line = Math.max(1, Math.min(line || 1, source.childElementCount));
      history.replaceState(null, '', fileLink(path, line)); highlightLine(line, line > 1);
      tree.querySelectorAll('[data-file]').forEach(function (item) { item.classList.toggle('is-active', item.dataset.file === path); });
      status('已打开 ' + path + ' · 点击行号选择位置，可复制链接或向 AI 提问');
    }).catch(function (error) {
      if (token !== generation || request !== fileRequest) return;
      empty.textContent = error.message; status(error.message);
    });
  }
  function loadTree(folder, host) {
    var token = generation;
    host.textContent = '正在加载…';
    return api('tree', { path: folder }).then(function (data) {
      if (token !== generation) return;
      host.textContent = ''; host.dataset.loaded = 'true'; revision = data.revision;
      document.getElementById('revision').textContent = revision === 'local' ? '本地代码' : 'SVN r' + revision;
      if (!data.entries.length) { host.textContent = '此目录为空'; return; }
      data.entries.forEach(function (item) {
        var row = document.createElement('div');
        if (item.directory) {
          var children = document.createElement('div'); children.className = 'code-tree-children'; children.hidden = true;
          var toggle = button('▸ ' + item.name, function () {
            children.hidden = !children.hidden;
            toggle.setAttribute('aria-expanded', String(!children.hidden));
            toggle.textContent = (children.hidden ? '▸ ' : '▾ ') + item.name;
            if (!children.hidden && !children.dataset.loaded) loadTree(item.path, children);
          });
          toggle.className = 'code-tree-folder'; toggle.setAttribute('aria-expanded', 'false'); toggle.title = item.path;
          row.appendChild(toggle); row.appendChild(children);
        } else {
          var file = button(item.name, function () { openFile(item.path, 1); });
          file.className = 'code-tree-file'; file.dataset.file = item.path; file.title = item.path; row.appendChild(file);
        }
        host.appendChild(row);
      });
      if (!selectedPath) status('展开左侧目录，选择文件阅读源码');
    }).catch(function (error) {
      if (token !== generation) return;
      delete host.dataset.loaded; host.textContent = error.message + ' ';
      host.appendChild(button('重试', function () { loadTree(folder, host); })); status(error.message);
    });
  }
  function changeRepository() {
    generation++; selectedPath = ''; source.textContent = ''; source.hidden = true; setFileActions(false);
    document.getElementById('path').textContent = '选择一个代码文件';
    document.getElementById('empty').hidden = false;
    document.getElementById('empty').textContent = '展开左侧目录选择文件，或使用上方搜索。';
    document.getElementById('search-results').hidden = true;
    return loadTree('', tree);
  }
  repo.onchange = function () {
    params = new URLSearchParams();
    history.replaceState(null, '', 'html/reference_code.html?' + new URLSearchParams({ repo: repo.value }));
    changeRepository();
  };
  document.getElementById('root').onclick = function () { loadTree('', tree); };
  document.getElementById('close-results').onclick = function () { document.getElementById('search-results').hidden = true; };
  document.getElementById('login').onclick = function () { window.SiteAuth.openLogin(); };
  document.getElementById('search').onsubmit = function (event) {
    event.preventDefault();
    var token = generation, request = ++searchRequest;
    status('正在检索…');
    api('search', { q: document.getElementById('q').value, mode: document.getElementById('mode').value }).then(function (data) {
      if (token !== generation || request !== searchRequest) return;
      revision = data.revision;
      var host = document.getElementById('results'); host.textContent = '';
      document.getElementById('search-results').hidden = false;
      document.getElementById('result-title').textContent = data.hits.length + ' 个搜索结果';
      data.hits.forEach(function (hit) {
        var result = document.createElement('a'); result.className = 'code-search-hit'; result.href = fileLink(hit.path, hit.line);
        var label = document.createElement('strong'); label.textContent = hit.path + ':' + hit.line;
        var excerpt = document.createElement('span'); excerpt.textContent = hit.text;
        result.appendChild(label); result.appendChild(excerpt);
        result.onclick = function (event) { event.preventDefault(); openFile(hit.path, hit.line, data.revision); };
        host.appendChild(result);
      });
      if (!data.hits.length) host.textContent = '没有找到匹配内容，请尝试其他关键词。';
      status(data.hits.length + ' 个结果，最多返回 200 条 · ' + (data.engine || '文件检索'));
    }).catch(function (error) { if (token === generation) status(error.message); });
  };
  document.getElementById('copy').onclick = function () {
    var url = new URL(fileLink(selectedPath, selectedLine()), document.baseURI).href;
    var copy = navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject(new Error('clipboard unavailable'));
    copy.then(function () { status('行号链接已复制'); }).catch(function () { window.prompt('复制行号链接', url); });
  };
  document.getElementById('ask').onclick = function () {
    var question = '请解释代码仓库 ' + repo.value + ' 中的 ' + selectedPath + ' 第 ' + selectedLine() + ' 行';
    location.href = 'index.html?' + new URLSearchParams({ aiQuestion: question, aiRepo: repo.value });
  };
  function initialize() {
    if (initializing) return;
    initializing = true;
    var token = generation;
    api('repos').then(function (data) {
      if (token !== generation || !identity) return;
      repo.textContent = '';
      data.repositories.forEach(function (item) {
        var option = document.createElement('option'); option.value = item.id; option.textContent = item.name; repo.appendChild(option);
      });
      repo.disabled = !data.repositories.length;
      if (!data.repositories.length) { status('管理员尚未开放代码仓库'); return; }
      if (data.repositories.some(function (item) { return item.id === params.get('repo'); })) repo.value = params.get('repo');
      changeRepository();
      if (params.get('path')) openFile(params.get('path'), selectedLine(), params.get('rev'));
    }).catch(function (error) {
      if (token === generation) { identity = ''; status(error.message); }
    }).then(function () {
      initializing = false;
      if (token !== generation && identity && repo.disabled) initialize();
    });
  }
  function sessionChanged(info) {
    document.getElementById('login').hidden = !!info.authenticated;
    if (!info.authenticated) {
      identity = ''; generation++; repo.textContent = ''; repo.disabled = true;
      tree.textContent = '请登录后浏览代码目录'; source.textContent = ''; source.hidden = true; setFileActions(false);
      document.getElementById('results').textContent = '';
      status(info.fileMode ? '请通过认证服务打开本页以浏览代码' : '请先登录后浏览参考代码库');
      return;
    }
    var user = info.user || {}, next = String(user.id || user.username || 'authenticated');
    if (next !== identity) { identity = next; initialize(); }
  }
  document.addEventListener('siteauth:change', function (event) { sessionChanged(event.detail); });
  window.addEventListener('hashchange', function () { highlightLine(selectedLine(), true); });
  if (window.SiteAuth) sessionChanged(window.SiteAuth.snapshot());
}());
