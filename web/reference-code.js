(function () {
  'use strict';
  // Existing HTML may still be cached when the service refreshes asset hashes.
  // Add the newer controls before binding events to support those pages as well.
  function ensureControls() {
    var header = document.querySelector('.code-file-header');
    var sidebar = document.querySelector('.code-sidebar');
    if (sidebar) sidebar.id = 'code-directory';
    if (!document.getElementById('toggle-tree')) {
      var toggle = document.createElement('button'); toggle.id = 'toggle-tree'; toggle.type = 'button';
      toggle.textContent = '隐藏目录'; toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-controls', 'code-directory');
      document.getElementById('root').insertAdjacentElement('afterend', toggle);
    }
    if (!document.getElementById('copy-source')) {
      var copy = document.createElement('button'); copy.id = 'copy-source'; copy.type = 'button'; copy.disabled = true;
      copy.textContent = '复制源码'; document.getElementById('ask').insertAdjacentElement('beforebegin', copy);
    }
    if (!document.getElementById('file-meta')) {
      var meta = document.createElement('small'); meta.id = 'file-meta';
      document.getElementById('path').insertAdjacentElement('afterend', meta);
    }
    if (!document.getElementById('jump-form')) {
      var jump = document.createElement('form'); jump.id = 'jump-form'; jump.className = 'code-line-tools';
      jump.innerHTML = '<label>跳转行号 <input id="line-jump" type="number" min="1" placeholder="行号" required disabled></label><button type="submit" disabled>跳转</button>';
      header.insertAdjacentElement('afterend', jump);
    }
    if (!document.getElementById('retry-load')) {
      var retry = document.createElement('button'); retry.id = 'retry-load'; retry.type = 'button';
      retry.textContent = '重新加载'; retry.hidden = true;
      document.getElementById('root').insertAdjacentElement('afterend', retry);
    }
  }
  ensureControls();
  var repo = document.getElementById('repo');
  var tree = document.getElementById('tree');
  var source = document.getElementById('source');
  var params = new URLSearchParams(location.search);
  var selectedPath = '', revision = '', identity = '';
  var generation = 0, fileRequest = 0, searchRequest = 0;
  var searchAbort = null, searchTimer = null, composing = false;
  var initializing = false;
  var navigation = [];
  var symbolRequest = 0;
  var symbolData = null;
  var symbolOrigin = null;
  var fileRevision = '';
  var contextMenu = null;
  var fileCache = new Map();
  var fileAbort = null;
  var sourceLines = [];
  var sourceText = '';
  var windowStart = -1, windowEnd = -1, scrollFrame = null;
  var rowHeight = 23;
  var activeLine = 1;
  var MAX_CACHE_BYTES = 12 * 1024 * 1024;
  var quickInput = document.getElementById('quick-symbol');
  var quickResults = document.getElementById('quick-symbol-results');
  var quickBusy = false;
  var quickRequest = 0, quickAbort = null, quickTimer = null, quickActive = -1, quickComposing = false;

  var LANGUAGES = {
    c: {grammar: 'c', symbols: true}, h: {grammar: 'c', symbols: true},
    cpp: {grammar: 'cpp', symbols: true}, cc: {grammar: 'cpp', symbols: true},
    cxx: {grammar: 'cpp', symbols: true}, hpp: {grammar: 'cpp', symbols: true},
    hh: {grammar: 'cpp', symbols: true}, hxx: {grammar: 'cpp', symbols: true},
    py: {grammar: 'python', symbols: true}, pyw: {grammar: 'python', symbols: true},
    sh: {grammar: 'bash', symbols: true}, bash: {grammar: 'bash', symbols: true},
    zsh: {grammar: 'bash', symbols: true}
  };
  var NO_SYMBOL_TOKEN = /^(comment|string|char|regex|url|keyword|number|boolean|directive|macro|operator)$/;

  function languageFor(path) {
    var name = String(path || '').split('/').pop();
    var index = name.lastIndexOf('.');
    return index < 0 ? null : LANGUAGES[name.slice(index + 1).toLowerCase()] || null;
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c];
    });
  }
  function escapeAttribute(value) { return escapeHtml(value); }

  function flattenTokens(items, classes, output) {
    if (typeof items === 'string') {
      if (items) output.push({text: items, classes: classes});
      return;
    }
    if (Array.isArray(items)) {
      items.forEach(function (item) { flattenTokens(item, classes, output); });
      return;
    }
    if (items && typeof items === 'object' && items.type) {
      flattenTokens(items.content, classes.concat(items.type), output);
    }
  }
  function tokenClass(classes) { return classes.length ? 'token ' + classes.join(' ') : ''; }
  function allowsSymbols(classes) {
    for (var i = 0; i < classes.length; i++) {
      if (NO_SYMBOL_TOKEN.test(classes[i])) return false;
    }
    return true;
  }
  function segmentHtml(value, classes, symbols) {
    var cls = tokenClass(classes), plain = escapeHtml(value);
    if (!symbols || !value) return cls ? '<span class="' + cls + '">' + plain + '</span>' : plain;
    var pieces = value.split(/([A-Za-z_][A-Za-z0-9_]{0,127})/), html = '';
    pieces.forEach(function (piece) {
      if (!piece) return;
      if (/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(piece)) {
        html += '<a class="code-symbol' + (cls ? ' ' + cls : '') + '" href="#" data-symbol="'
          + escapeAttribute(piece) + '" title="查看 ' + escapeAttribute(piece) + ' 的定义与引用">'
          + escapeHtml(piece) + '</a>';
      } else {
        html += cls ? '<span class="' + cls + '">' + escapeHtml(piece) + '</span>' : escapeHtml(piece);
      }
    });
    return html;
  }

  function renderSource(text, path) {
    var language = languageFor(path), output = [];
    var grammar = language && window.Prism && Prism.languages[language.grammar];
    if (grammar) {
      try { flattenTokens(Prism.tokenize(text, grammar), [], output); } catch (error) { output = []; }
    }
    if (!output.length) output = [{text: text, classes: []}];
    // Only visible rows become DOM nodes, so large files retain clickable symbols.
    var symbols = !!(language && language.symbols);
    var lines = [''];
    output.forEach(function (run) {
      var pieces = run.text.split('\n');
      var allow = symbols && allowsSymbols(run.classes);
      for (var index = 0; index < pieces.length; index++) {
        if (index) lines.push('');
        if (pieces[index]) lines[lines.length - 1] += segmentHtml(pieces[index], run.classes, allow);
      }
    });
    return lines;
  }

  function renderWindow(force) {
    if (!sourceLines.length || source.hidden) return;
    var virtual = sourceLines.length > 1000;
    var start = virtual ? Math.max(0, Math.floor(source.scrollTop / rowHeight) - 40) : 0;
    var end = virtual ? Math.min(sourceLines.length, start + Math.ceil(source.clientHeight / rowHeight) + 100) : sourceLines.length;
    if (!force && start === windowStart && end === windowEnd) return;
    windowStart = start; windowEnd = end;
    var html = [];
    if (start) html.push('<span class="code-spacer" aria-hidden="true" style="height:' + (start * rowHeight) + 'px"></span>');
    for (var index = start; index < end; index++) {
      var line = index + 1;
      html.push('<span class="code-line' + (line === activeLine ? ' is-selected' : '') + '" id="L' + line + '"><a class="code-line-number" href="'
        + escapeAttribute(fileLink(selectedPath, line)) + '" data-line="' + line + '">' + line + '</a><code>' + sourceLines[index] + '</code></span>');
    }
    if (end < sourceLines.length) html.push('<span class="code-spacer" aria-hidden="true" style="height:' + ((sourceLines.length - end) * rowHeight) + 'px"></span>');
    source.innerHTML = html.join('');
  }

  source.addEventListener('scroll', function () {
    if (scrollFrame !== null) return;
    scrollFrame = requestAnimationFrame(function () { scrollFrame = null; renderWindow(false); });
  });
  window.addEventListener('resize', function () { renderWindow(true); });

  function clearSource() {
    sourceLines = []; sourceText = ''; windowStart = -1; windowEnd = -1;
    source.textContent = ''; source.hidden = true;
    document.getElementById('file-meta').textContent = '';
  }

  function formatDate(value) {
    if (!value) return '';
    var date = new Date(value);
    if (isNaN(date.getTime())) return String(value).slice(0, 10);
    function pad(number) { return (number < 10 ? '0' : '') + number; }
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
      + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }
  function showRevision(value, date) {
    revision = value || revision;
    document.getElementById('revision').textContent = !revision || revision === 'local'
      ? '本地代码' : 'SVN r' + revision + (date ? ' · ' + formatDate(date) : '');
  }

  function showSymbolResults(kind) {
    if (!symbolData) return;
    var host = document.getElementById('symbol-results'); host.textContent = '';
    document.getElementById('symbol-definitions').setAttribute('aria-pressed', String(kind === 'definitions'));
    document.getElementById('symbol-references').setAttribute('aria-pressed', String(kind === 'references'));
    var hits = symbolData[kind];
    hits.forEach(function (hit) {
      var result = document.createElement('a'); result.className = 'code-search-hit'; result.href = fileLink(hit.path, hit.line, symbolData.revision);
      var label = document.createElement('strong'); label.textContent = hit.path + ':' + hit.line;
      var excerpt = document.createElement('span'); excerpt.textContent = hit.text;
      result.appendChild(label); result.appendChild(excerpt);
      result.onclick = function (event) {
        event.preventDefault();
        navigation.push(symbolOrigin);
        document.getElementById('back-location').disabled = false;
        openFile(hit.path, hit.line, symbolData.revision);
      };
      host.appendChild(result);
    });
    if (!hits.length) host.textContent = kind === 'definitions' && !symbolData.indexed
      ? '尚无 GNU Global 符号索引，请管理员点击「更新 gtags 索引」。可以先查看文本出现位置。' : '没有找到匹配位置。';
  }

  function lookupSymbol(symbol, line) {
    var request = ++symbolRequest, token = generation;
    symbolOrigin = { path: selectedPath, line: line, revision: fileRevision, scroll: source.scrollTop };
    document.getElementById('symbols').hidden = false;
    document.getElementById('symbol-title').textContent = symbol;
    document.getElementById('symbol-status').textContent = '正在查询定义与引用…';
    document.getElementById('symbol-results').textContent = '';
    symbolData = null;
    api('symbol', { symbol: symbol, rev: fileRevision }).then(function (data) {
      if (request !== symbolRequest || token !== generation) return;
      symbolData = data;
      document.getElementById('symbol-status').textContent = data.engine + (data.indexed ? '' : ' · 当前显示文本出现位置');
      document.getElementById('symbol-definitions').textContent = '定义 (' + data.definitions.length + ')';
      document.getElementById('symbol-references').textContent = (data.indexed ? '引用' : '出现位置') + ' (' + data.references.length + ')';
      showSymbolResults(data.definitions.length ? 'definitions' : 'references');
    }).catch(function (error) {
      if (request === symbolRequest && token === generation) document.getElementById('symbol-status').textContent = error.message;
    });
  }

  function status(message) { document.getElementById('status').textContent = message; }
  function api(action, extra, options) {
    var query = new URLSearchParams(Object.assign({ repo: repo.value }, extra || {}));
    var init = { credentials: 'same-origin', cache: 'no-store' };
    var externalSignal = options && options.signal;
    var controller = window.AbortController ? new AbortController() : null;
    function cancel() { if (controller) controller.abort(); }
    if (controller) {
      init.signal = controller.signal;
      if (externalSignal) {
        if (externalSignal.aborted) cancel();
        else externalSignal.addEventListener('abort', cancel, { once: true });
      }
    } else if (externalSignal) init.signal = externalSignal;
    var timer;
    function cleanup() {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', cancel);
    }
    var timeout = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        reject(new Error('请求超时，请点击重新加载或重试')); cancel();
      }, 20000);
    });
    var request = fetch('__code/' + action + '?' + query, init).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) throw new Error(data.message || data.error || '读取失败，请重试');
        return data;
      });
    });
    return Promise.race([request, timeout]).then(function (data) {
      cleanup(); return data;
    }, function (error) { cleanup(); throw error; });
  }
  function button(text, handler) {
    var element = document.createElement('button');
    element.type = 'button'; element.textContent = text; element.onclick = handler;
    return element;
  }
  function fileLink(path, line, version) {
    var targetRevision = version || (path === selectedPath && fileRevision ? fileRevision : revision);
    return 'html/reference_code.html?' + new URLSearchParams({ repo: repo.value, path: path, rev: targetRevision }) + '#L' + line;
  }
  function selectedLine() {
    var match = /^#L(\d+)$/.exec(location.hash);
    return match ? Number(match[1]) : 1;
  }
  function highlightLine(line, scroll) {
    activeLine = Math.max(1, Math.min(line, sourceLines.length || 1));
    document.getElementById('line-jump').value = activeLine;
    if (sourceLines.length > 1000 && scroll) {
      source.scrollTop = Math.max(0, (activeLine - 1) * rowHeight - source.clientHeight / 2);
      renderWindow(true);
    }
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
    document.getElementById('copy-source').disabled = !enabled;
    document.getElementById('line-jump').disabled = !enabled;
    document.querySelector('#jump-form button').disabled = !enabled;
  }
  function rememberFile(key, data) {
    fileCache.delete(key);
    var renderedSize = data.renderedLines ? data.renderedLines.reduce(function (total, line) { return total + line.length * 2; }, 0) : 0;
    if (renderedSize + data.text.length * 2 > MAX_CACHE_BYTES) delete data.renderedLines;
    data.cacheBytes = data.text.length * 2 + (data.renderedLines ? renderedSize : 0);
    if (!data.cachedAt) data.cachedAt = Date.now();
    fileCache.set(key, data);
    var total = 0;
    fileCache.forEach(function (entry) { total += entry.cacheBytes; });
    while (fileCache.size > 8 || total > MAX_CACHE_BYTES) {
      var oldest = fileCache.keys().next().value;
      total -= fileCache.get(oldest).cacheBytes;
      fileCache.delete(oldest);
    }
  }
  var tagbar = document.getElementById('file-tagbar');
  var tagToggle = document.getElementById('toggle-tagbar');
  function renderFileTags() {
    var host = document.getElementById('file-tags');
    host.textContent = '';
    var lines = sourceText.split(/\r?\n/), count = 0;
    // Match common source declarations. This local outline also works without gtags.
    var patterns = [
      { label: '函数', regex: /^\s*(?:(?:async\s+)?def|function)\s+([A-Za-z_]\w*)\s*\(/ },
      { label: '类型', regex: /^\s*(?:export\s+)?(?:class|struct|enum|union|interface)\s+([A-Za-z_]\w*)/ },
      { label: '宏', regex: /^\s*#\s*define\s+([A-Za-z_]\w*)/ },
      { label: '函数', regex: /^\s*(?:[A-Za-z_]\w*[\s*&]+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:\{|$)/ }
    ];
    var groups = {};
    lines.forEach(function (line, index) {
      patterns.some(function (pattern) {
        var match = pattern.regex.exec(line);
        if (!match || /^(if|for|while|switch|return|catch)$/.test(match[1])) return false;
        if (!groups[pattern.label]) groups[pattern.label] = [];
        groups[pattern.label].push({ name: match[1], line: index + 1 });
        return true;
      });
    });
    Object.keys(groups).forEach(function (kind) {
      var group = document.createElement('details'), heading = document.createElement('summary');
      group.open = true;
      heading.textContent = kind + ' (' + groups[kind].length + ')';
      group.appendChild(heading);
      groups[kind].forEach(function (tag) {
        var link = document.createElement('a');
        link.textContent = tag.name + ' · ' + tag.line;
        link.href = fileLink(selectedPath, tag.line);
        link.title = lines[tag.line - 1].trim();
        link.onclick = function (event) {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          highlightLine(tag.line, true);
          history.replaceState(null, '', fileLink(selectedPath, tag.line));
          source.focus();
        };
        group.appendChild(link); count++;
      });
      host.appendChild(group);
    });
    if (!count) host.textContent = '未识别到符号';
  }
  tagToggle.onclick = function () {
    tagbar.hidden = !tagbar.hidden;
    tagToggle.setAttribute('aria-expanded', String(!tagbar.hidden));
    if (!tagbar.hidden) renderFileTags();
  };
  function openFile(path, line, expectedRevision) {
    var token = generation, request = ++fileRequest;
    var expected = expectedRevision || '';
    var cacheKey = path + '@' + (expected || revision);
    if (fileAbort) fileAbort.abort();
    fileAbort = window.AbortController ? new AbortController() : null;
    hideContextMenu();
    closeQuickSearch();
    source.hidden = true; setFileActions(false);
    tagToggle.disabled = true; document.getElementById('file-tags').textContent = '';
    var empty = document.getElementById('empty');
    empty.hidden = false; empty.textContent = '正在读取 ' + path + '…';
    status('正在读取文件…');
    function show(data) {
      if (token !== generation || request !== fileRequest) return;
      selectedPath = path; revision = data.revision; fileRevision = data.revision;
      showRevision(revision, data.revisionDate);
      document.getElementById('path').textContent = path;
      document.getElementById('path').title = path;
      if (!data.renderedLines) data.renderedLines = renderSource(data.text, path);
      sourceLines = data.renderedLines; sourceText = data.text;
      tagToggle.disabled = false;
      if (!tagbar.hidden) renderFileTags();
      windowStart = -1; windowEnd = -1; source.scrollTop = 0;
      source.hidden = false; empty.hidden = true; setFileActions(true);
      rowHeight = parseFloat(getComputedStyle(source).lineHeight) || 23;
      var target = Math.max(1, Math.min(line || 1, sourceLines.length));
      activeLine = target;
      renderWindow(true);
      document.getElementById('line-jump').max = sourceLines.length;
      document.getElementById('file-meta').textContent = sourceLines.length.toLocaleString() + ' 行 · ' + (sourceLines.length > 1000 ? '按可见区域加载，可直接跳转行号' : '点击符号查看定义与引用');
      history.replaceState(null, '', fileLink(path, target));
      highlightLine(target, target > 1);
      tree.querySelectorAll('[data-file]').forEach(function (item) { item.classList.toggle('is-active', item.dataset.file === path); });
      status('已打开 ' + path + ' · 点击行号选择位置，右键可向 AI 提问');
      rememberFile(path + '@' + data.revision, data);
    }
    var cached = fileCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < 30000) {
      show(cached);
      return Promise.resolve();
    }
    return api('file', { path: path, rev: expected }, { signal: fileAbort && fileAbort.signal }).then(function (data) {
      show(data);
    }).catch(function (error) {
      if (token !== generation || request !== fileRequest || error.name === 'AbortError') return;
      empty.textContent = error.message; status(error.message);
    });
  }
  function loadTree(folder, host) {
    if (host.dataset.loading === String(generation)) return Promise.resolve();
    host.dataset.loading = String(generation);
    var token = generation;
    host.textContent = '正在加载…';
    return api('tree', { path: folder }).then(function (data) {
      if (token !== generation) return;
      delete host.dataset.loading;
      host.textContent = ''; host.dataset.loaded = 'true'; showRevision(data.revision, data.revisionDate);
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
          var file = button(item.name, function () {
            symbolRequest++;
            document.getElementById('symbols').hidden = true;
            document.getElementById('search-results').hidden = true;
            openFile(item.path, 1);
          });
          file.className = 'code-tree-file'; file.dataset.file = item.path; file.title = item.path; row.appendChild(file);
        }
        host.appendChild(row);
      });
      if (!selectedPath) status('展开左侧目录，选择文件阅读源码');
    }).catch(function (error) {
      if (token !== generation) return;
      delete host.dataset.loading; delete host.dataset.loaded; host.textContent = error.message + ' ';
      host.appendChild(button('重试', function () { loadTree(folder, host); })); status(error.message);
    });
  }
  function changeRepository() {
    hideContextMenu();
    closeQuickSearch();
    quickRequest++; if (quickAbort) { quickAbort.abort(); quickAbort = null; }
    navigation = []; symbolRequest++; symbolData = null;
    document.getElementById('symbols').hidden = true;
    document.getElementById('back-location').disabled = true;
    generation++; selectedPath = ''; clearSource(); setFileActions(false);
    fileCache.clear();
    document.getElementById('path').textContent = '选择一个代码文件';
    document.getElementById('empty').hidden = false;
    document.getElementById('empty').textContent = '展开左侧目录选择文件，或使用上方搜索。';
    document.getElementById('search-results').hidden = true;
    return loadTree('', tree);
  }
  repo.onchange = function () {
    params = new URLSearchParams();
    history.replaceState(null, '', 'html/reference_code.html?' + new URLSearchParams({ repo: repo.value }));
    fileCache.clear();
    changeRepository();
  };
  document.getElementById('root').onclick = function () {
    if (!repo.value) { document.getElementById('retry-load').click(); return; }
    fileCache.clear();
    return loadTree('', tree).then(function () { if (selectedPath) return openFile(selectedPath, selectedLine()); });
  };
  document.getElementById('toggle-tree').onclick = function () {
    var directory = document.getElementById('code-directory');
    directory.hidden = !directory.hidden;
    document.querySelector('.code-layout').classList.toggle('tree-collapsed', directory.hidden);
    this.setAttribute('aria-expanded', String(!directory.hidden));
    this.textContent = directory.hidden ? '显示目录' : '隐藏目录';
    renderWindow(true);
  };
  document.getElementById('jump-form').onsubmit = function (event) {
    event.preventDefault();
    var line = Math.max(1, Math.min(Number(document.getElementById('line-jump').value) || 1, sourceLines.length));
    history.replaceState(null, '', fileLink(selectedPath, line)); highlightLine(line, true);
  };
  document.getElementById('copy-source').onclick = function () {
    var copy = navigator.clipboard ? navigator.clipboard.writeText(sourceText) : Promise.reject(new Error('clipboard unavailable'));
    copy.then(function () { status('完整源码已复制'); }).catch(function () { window.prompt('复制完整源码', sourceText); });
  };
  document.getElementById('reindex').onclick = function () {
    var control = this, token = generation;
    control.disabled = true; status('正在更新 GNU Global（gtags）符号索引，请稍候…');
    fetch('__code/index?' + new URLSearchParams({ repo: repo.value }), {
      method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': SiteAuth.csrfToken() }
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) throw new Error(data.message || data.error);
        if (token === generation) {
          status(data.indexStatus);
          if (document.getElementById('q').value.trim()) scheduleSearch();
        }
      });
    }).catch(function (error) { if (token === generation) status(error.message); }).then(function () { control.disabled = false; });
  };
  document.getElementById('symbol-definitions').onclick = function () { showSymbolResults('definitions'); };
  document.getElementById('symbol-references').onclick = function () { showSymbolResults('references'); };
  document.getElementById('close-symbols').onclick = function () { document.getElementById('symbols').hidden = true; };
  document.getElementById('back-location').onclick = function () {
    var origin = navigation.pop();
    if (!origin) return;
    openFile(origin.path, origin.line, origin.revision).then(function () { source.scrollTop = origin.scroll; });
    document.getElementById('back-location').disabled = navigation.length === 0;
  };
  document.getElementById('close-results').onclick = function () { document.getElementById('search-results').hidden = true; };
  document.getElementById('login').onclick = function () { window.SiteAuth.openLogin(); };

  function searchThreshold(mode) { return 2; }
  function clearSearchTimer() {
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  }
  function scheduleSearch() {
    clearSearchTimer();
    if (composing) return;
    var input = document.getElementById('q'), mode = document.getElementById('mode').value;
    var query = input.value.trim();
    if (!query || query.length < searchThreshold(mode)) {
      if (searchAbort) { searchAbort.abort(); searchAbort = null; }
      searchRequest++;
      document.getElementById('search-results').hidden = true;
      if (query) status('继续输入以搜索（至少 ' + searchThreshold(mode) + ' 个字符）');
      return;
    }
    searchTimer = setTimeout(runSearch, 260);
  }
  function runSearch() {
    clearSearchTimer();
    var input = document.getElementById('q'), mode = document.getElementById('mode').value;
    var query = input.value.trim();
    if (!query) return;
    var token = generation, request = ++searchRequest;
    if (searchAbort) searchAbort.abort();
    var controller = window.AbortController ? new AbortController() : null;
    searchAbort = controller;
    status('正在检索…');
    api('search', { q: query, mode: mode }, controller ? { signal: controller.signal } : null).then(function (data) {
      if (token !== generation || request !== searchRequest) return;
      searchAbort = null;
      showRevision(data.revision, data.revisionDate);
      var host = document.getElementById('results'); host.textContent = '';
      document.getElementById('search-results').hidden = false;
      document.getElementById('result-title').textContent = data.hits.length + ' 个搜索结果';
      data.hits.forEach(function (hit) {
        var result = document.createElement('a'); result.className = 'code-search-hit'; result.href = fileLink(hit.path, hit.line, data.revision);
        var label = document.createElement('strong'); label.textContent = hit.path + ':' + hit.line;
        var excerpt = document.createElement('span'); excerpt.textContent = hit.text;
        result.appendChild(label); result.appendChild(excerpt);
        result.onclick = function (event) { event.preventDefault(); openFile(hit.path, hit.line, data.revision); };
        host.appendChild(result);
      });
      if (!data.hits.length) host.textContent = '没有找到匹配内容，请尝试其他关键词或搜索方式。';
      status(data.hits.length + ' 个结果，最多返回 200 条 · ' + (data.engine || '文件检索') + '（实时搜索）');
    }).catch(function (error) {
      if (error && error.name === 'AbortError') return;
      if (token === generation && request === searchRequest) status(error.message);
    });
  }
  function quickSymbolName(text, query) {
    var tokens = String(text || '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    var needle = String(query || '').toLowerCase(), fallback = '';
    for (var index = 0; index < tokens.length; index++) {
      var lower = tokens[index].toLowerCase();
      if (lower.indexOf(needle) === 0) return tokens[index];
      if (!fallback && lower.indexOf(needle) >= 0) fallback = tokens[index];
    }
    return fallback;
  }
  function closeQuickSearch() {
    if (quickTimer) { clearTimeout(quickTimer); quickTimer = null; }
    quickRequest++;
    quickActive = -1;
    if (quickResults) {
      quickResults.hidden = true;
      quickInput.setAttribute('aria-expanded', 'false');
    }
  }
  function quickItems() {
    return Array.prototype.slice.call(quickResults.querySelectorAll('.code-suggest-item'));
  }
  function setQuickActive(index, scroll) {
    var items = quickItems();
    if (!items.length) { quickActive = -1; return; }
    quickActive = (index + items.length) % items.length;
    items.forEach(function (item, position) {
      var selected = position === quickActive;
      item.classList.toggle('is-active', selected);
      item.setAttribute('aria-selected', String(selected));
    });
    if (scroll !== false) items[quickActive].scrollIntoView({ block: 'nearest' });
  }
  function useMainSearch(query) {
    document.getElementById('q').value = query;
    document.getElementById('mode').value = 'symbol';
    closeQuickSearch();
    runSearch();
    document.getElementById('search-results').scrollIntoView({ block: 'nearest' });
  }
  function renderQuickResults(data, query) {
    quickResults.textContent = '';
    quickResults.hidden = false;
    quickInput.setAttribute('aria-expanded', 'true');
    quickActive = -1;
    if (!data.hits.length) {
      var empty = document.createElement('p');
      empty.className = 'code-suggest-empty';
      empty.textContent = data.limited ? '快速检索范围内没有匹配项' : '没有找到匹配的函数或符号';
      quickResults.appendChild(empty);
    }
    var shown = data.hits.slice(0, 8);
    shown.forEach(function (hit, index) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'code-suggest-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      var name = document.createElement('strong');
      name.textContent = quickSymbolName(hit.text, query) || hit.path.split('/').pop();
      var meta = document.createElement('span');
      meta.className = 'code-suggest-meta';
      meta.textContent = hit.path + ':' + hit.line;
      var excerpt = document.createElement('span');
      excerpt.className = 'code-suggest-excerpt';
      excerpt.textContent = hit.text;
      item.appendChild(name); item.appendChild(meta); item.appendChild(excerpt);
      item.onclick = function () {
        closeQuickSearch();
        openFile(hit.path, hit.line, data.revision);
      };
      item.onmouseenter = function () { setQuickActive(index, false); };
      quickResults.appendChild(item);
    });
    if (data.limited || data.hits.length > shown.length) {
      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'code-suggest-more';
      more.textContent = data.limited ? '在整个仓库中搜索此符号' : '在下方查看全部 ' + data.hits.length + ' 条结果';
      more.onclick = function () { useMainSearch(query); };
      quickResults.appendChild(more);
    }
  }
  function runQuickSearch() {
    if (quickTimer) { clearTimeout(quickTimer); quickTimer = null; }
    var query = quickInput.value.trim();
    if (query.length < 2) { closeQuickSearch(); return; }
    if (!/^[A-Za-z_][A-Za-z0-9_]{1,127}$/.test(query)) { closeQuickSearch(); return; }
    if (quickBusy) { quickTimer = setTimeout(runQuickSearch, 400); return; }
    quickBusy = true;
    var token = generation, request = ++quickRequest;
    if (quickAbort) quickAbort.abort();
    var controller = window.AbortController ? new AbortController() : null;
    quickAbort = controller;
    quickResults.hidden = false;
    quickResults.textContent = '正在搜索函数 / 符号…';
    quickInput.setAttribute('aria-expanded', 'true');
    api('search', { q: query, mode: 'symbol', quick: '1', current: selectedPath || '' }, controller ? { signal: controller.signal } : null).then(function (data) {
      if (token !== generation || request !== quickRequest) return;
      quickAbort = null;
      showRevision(data.revision, data.revisionDate);
      if (!data || !Array.isArray(data.hits)) throw new Error('符号结果格式无效，请重试');
      if (quickInput.value.trim() === query) renderQuickResults(data, query);
    }).catch(function (error) {
      if (error && error.name === 'AbortError') return;
      if (token === generation && request === quickRequest) {
        quickResults.hidden = false;
        quickResults.textContent = error.message;
      }
    }).then(function () { quickBusy = false; }, function () { quickBusy = false; });
  }
  function scheduleQuickSearch() {
    quickRequest++;
    if (quickComposing) return;
    if (quickTimer) clearTimeout(quickTimer);
    quickTimer = setTimeout(runQuickSearch, 400);
  }
  quickInput.addEventListener('input', scheduleQuickSearch);
  quickInput.addEventListener('compositionstart', function () { quickComposing = true; });
  quickInput.addEventListener('compositionend', function () { quickComposing = false; scheduleQuickSearch(); });
  quickInput.addEventListener('focus', function () {
    if (this.value.trim().length >= 2 && quickResults.hidden) scheduleQuickSearch();
  });
  quickInput.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (quickResults.hidden) { runQuickSearch(); return; }
      setQuickActive(quickActive + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      var items = quickItems();
      if (!items.length) { if (this.value.trim().length >= 2) useMainSearch(this.value.trim()); return; }
      (items[quickActive] || items[0]).click();
    } else if (event.key === 'Escape') {
      if (!quickResults.hidden) { event.preventDefault(); closeQuickSearch(); }
      else if (this.value) { this.value = ''; closeQuickSearch(); }
    }
  });
  document.addEventListener('click', function (event) {
    var host = document.querySelector('[data-quick-search]');
    if (host && !host.contains(event.target)) closeQuickSearch();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    var active = document.activeElement, tag = (active && active.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (active && active.isContentEditable)) return;
    event.preventDefault();
    quickInput.focus();
    quickInput.select();
  });
  document.getElementById('q').addEventListener('input', scheduleSearch);
  document.getElementById('q').addEventListener('compositionstart', function () { composing = true; });
  document.getElementById('q').addEventListener('compositionend', function () { composing = false; scheduleSearch(); });
  document.getElementById('q').addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      this.value = ''; scheduleSearch();
    }
  });
  document.getElementById('mode').onchange = scheduleSearch;
  document.getElementById('search').onsubmit = function (event) {
    event.preventDefault();
    runSearch();
  };

  function selectedSourceText() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return '';
    var range = selection.getRangeAt(0);
    if (!source.contains(range.commonAncestorContainer)) return '';
    return selection.toString().trim().slice(0, 1200);
  }
  function lineNumber(row) { return row ? Number(String(row.id || '').slice(1)) || 1 : selectedLine(); }
  function askQuestion(line, symbol, selection) {
    var question = '请解释代码仓库 ' + repo.value + ' 中的 ' + selectedPath + ' 第 ' + line + ' 行';
    if (symbol) question += '，重点说明符号 ' + symbol + ' 的定义、作用及调用关系。';
    else question += '附近的实现。';
    if (selection) question += '\n相关代码：\n```\n' + selection + '\n```';
    return question;
  }
  function askAI(question) {
    location.href = 'index.html?' + new URLSearchParams({ aiQuestion: question, aiRepo: repo.value });
  }
  function hideContextMenu() {
    if (contextMenu) contextMenu.hidden = true;
  }
  function copyLineLink(line) {
    var url = new URL(fileLink(selectedPath, line), document.baseURI).href;
    var copy = navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject(new Error('clipboard unavailable'));
    copy.then(function () { status('行号链接已复制'); }).catch(function () { window.prompt('复制行号链接', url); });
  }
  function showContextMenu(event) {
    if (!selectedPath) return;
    var target = event.target;
    var row = target.closest ? target.closest('.code-line') : null;
    var symbol = target.closest ? target.closest('.code-symbol') : null;
    var line = lineNumber(row);
    var selection = selectedSourceText();
    var name = symbol ? symbol.dataset.symbol : '';
    if (!contextMenu) {
      contextMenu = document.createElement('div');
      contextMenu.id = 'code-context-menu';
      contextMenu.className = 'code-context-menu';
      contextMenu.setAttribute('role', 'menu');
      document.body.appendChild(contextMenu);
      document.addEventListener('click', function (click) {
        if (contextMenu && !contextMenu.contains(click.target)) hideContextMenu();
      });
      document.addEventListener('keydown', function (key) { if (key.key === 'Escape') hideContextMenu(); });
      window.addEventListener('resize', hideContextMenu);
      source.addEventListener('scroll', hideContextMenu);
    }
    contextMenu.textContent = '';
    if (name) {
      contextMenu.appendChild(button('问 AI：解释 ' + name, function () { askAI(askQuestion(line, name, selection)); }));
      contextMenu.appendChild(button('查找 ' + name + ' 的定义与引用', function () { lookupSymbol(name, line); }));
    }
    if (selection) {
      contextMenu.appendChild(button('问 AI：解释选中代码', function () { askAI(askQuestion(line, '', selection)); }));
    }
    contextMenu.appendChild(button('问 AI：解释第 ' + line + ' 行', function () { askAI(askQuestion(line, name, selection)); }));
    contextMenu.appendChild(button('复制行号链接', function () { copyLineLink(line); }));
    if (name) {
      contextMenu.appendChild(button('复制符号名 ' + name, function () {
        var copy = navigator.clipboard ? navigator.clipboard.writeText(name) : Promise.reject(new Error('clipboard unavailable'));
        copy.then(function () { status('符号名已复制'); }).catch(function () { window.prompt('复制符号名', name); });
      }));
    }
    contextMenu.hidden = false;
    contextMenu.style.left = '0px'; contextMenu.style.top = '0px';
    var rect = contextMenu.getBoundingClientRect();
    contextMenu.style.left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8)) + 'px';
    contextMenu.style.top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8)) + 'px';
    event.preventDefault();
  }
  var hoverPanel = document.getElementById('symbols'), hoverTimer;
  source.addEventListener('mouseover', function (event) {
    var symbol = event.target.closest('.code-symbol');
    if (!symbol || symbol.contains(event.relatedTarget)) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(function () {
      hoverPanel.classList.add('is-hover');
      lookupSymbol(symbol.dataset.symbol, lineNumber(symbol.closest('.code-line')));
    }, 400);
  });
  source.addEventListener('mouseout', function (event) {
    if (event.target.closest('.code-symbol')) clearTimeout(hoverTimer);
  });
  source.addEventListener('scroll', function () {
    clearTimeout(hoverTimer);
    if (hoverPanel.classList.contains('is-hover')) hoverPanel.hidden = true;
  });
  source.addEventListener('click', function () { hoverPanel.classList.remove('is-hover'); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { clearTimeout(hoverTimer); hoverPanel.hidden = true; }
  });
  source.addEventListener('contextmenu', showContextMenu);
  source.addEventListener('click', function (event) {
    var symbol = event.target.closest ? event.target.closest('.code-symbol') : null;
    if (symbol) {
      event.preventDefault();
      lookupSymbol(symbol.dataset.symbol, lineNumber(symbol.closest('.code-line')));
      return;
    }
    var number = event.target.closest ? event.target.closest('.code-line-number') : null;
    if (number) {
      event.preventDefault();
      var line = lineNumber(number.closest('.code-line'));
      history.replaceState(null, '', fileLink(selectedPath, line));
      highlightLine(line, false);
    }
  });

  document.getElementById('copy').onclick = function () { copyLineLink(selectedLine()); };
  document.getElementById('ask').onclick = function () { askAI(askQuestion(selectedLine(), '', selectedSourceText())); };
  function initialize() {
    if (initializing) return;
    initializing = true;
    status('正在读取代码仓库…');
    document.getElementById('retry-load').hidden = true;
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
      if (token === generation) {
        identity = ''; status(error.message);
        document.getElementById('retry-load').hidden = false;
      }
    }).then(function () {
      initializing = false;
      if (token !== generation && identity && repo.disabled) initialize();
    });
  }
  document.getElementById('retry-load').onclick = function () {
    if (!window.SiteAuth) { location.reload(); return; }
    identity = '';
    status('正在重新确认登录状态…');
    SiteAuth.refresh().then(sessionChanged);
  };
  function sessionChanged(info) {
    document.getElementById('reindex').hidden = !info.authenticated || (info.user || {}).role !== 'admin';
    document.getElementById('login').hidden = !!info.authenticated;
    if (!info.authenticated) {
      identity = ''; generation++; repo.textContent = ''; repo.disabled = true;
      fileCache.clear(); closeQuickSearch();
      quickRequest++; if (quickAbort) { quickAbort.abort(); quickAbort = null; }
      if (quickInput) quickInput.value = '';
      tree.textContent = '请登录后浏览代码目录'; clearSource(); setFileActions(false);
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
  else {
    status('登录组件未加载，请刷新页面重试');
    document.getElementById('retry-load').hidden = false;
  }
  document.documentElement.dataset.codeReady = 'true';
}());
