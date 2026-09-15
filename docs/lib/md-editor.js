(function () {
  'use strict';

  var INDENT = '  ';
  var SPLIT_STORAGE = 'md2web:md-editor:split';

  var state = {
    overlay: null,
    textarea: null,
    highlight: null,
    preview: null,
    titleEl: null,
    statusEl: null,
    metricsEl: null,
    modeEl: null,
    resource: '',
    original: '',
    baseHash: null,
    fileHandle: null,
    forceSave: false,
    lastFocus: null,
    split: 50,
    dragging: false,
    previewTimer: 0,
    highlightTimer: 0,
    previewToken: 0
  };

  // ---------- 路由与源文件读取 ----------

  function currentRoute() {
    var hash = String(window.location.hash || '#/').replace(/^#/, '').split('?')[0];
    try {
      return decodeURIComponent(hash);
    } catch (error) {
      return hash;
    }
  }

  function currentResource() {
    return currentRoute().replace(/^\/+/, '').replace(/\/+$/, '') || 'README.md';
  }

  // docsify 路由会去掉 .md 后缀（file-router 补丁），取源文件时需按 docsify 的 ext 规则补回
  function candidateResources(resource) {
    var value = String(resource || '');
    var candidates = [value];
    if (!/\.[A-Za-z0-9]+$/.test(value)) {
      candidates.push(value + '.md');
    }
    return candidates.filter(function (item, index) { return candidates.indexOf(item) === index; });
  }

  function displayPath(resource) {
    return resource === 'README.md' ? 'docs/README.md' : 'docs/md/' + resource.replace(/^md\//, '');
  }

  function fetchResource(resource) {
    return fetch(resource, { cache: 'no-cache' }).then(function (response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      return response.text();
    }, function () {
      var offline = window.__DOCSIFY_OFFLINE_DATA__;
      var embedded = offline && offline.content ? offline.content[resource] : undefined;
      if (typeof embedded === 'string') {
        return embedded;
      }
      throw new Error('无法读取 ' + resource);
    });
  }

  function loadSource(resource) {
    var candidates = candidateResources(resource);
    var index = 0;
    function attempt() {
      return fetchResource(candidates[index]).catch(function (error) {
        index += 1;
        if (index < candidates.length) {
          return attempt();
        }
        throw error;
      });
    }
    return attempt().then(function (text) {
      return { resource: candidates[index], text: text };
    });
  }

  function sha256(text) {
    var subtle = window.crypto && window.crypto.subtle;
    if (!subtle) {
      return Promise.resolve(null);
    }
    var data = new TextEncoder().encode(String(text).replace(/\r\n?/g, '\n'));
    return subtle.digest('SHA-256', data).then(function (buffer) {
      return Array.prototype.map.call(new Uint8Array(buffer), function (byte) {
        return byte.toString(16).padStart(2, '0');
      }).join('');
    }, function () {
      return null;
    });
  }

  // ---------- 下载与保存 ----------

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function fileName() {
    return state.resource.split('/').pop() || 'document.md';
  }

  function serverAvailable() {
    return /^https?:$/.test(window.location.protocol);
  }

  function saveModeLabel() {
    if (serverAvailable()) {
      return '直连保存';
    }
    if (window.showSaveFilePicker) {
      return '保存到文件';
    }
    return '仅下载';
  }

  function downloadEditorSource() {
    saveBlob(new Blob([state.textarea.value], { type: 'text/markdown;charset=utf-8' }), fileName());
    setStatus('已下载 ' + fileName());
  }

  function postSave(content, force) {
    return fetch('__md/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: state.resource,
        content: content,
        baseHash: state.baseHash,
        force: !!force
      })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok || !payload.ok) {
          var error = new Error(payload.error || ('HTTP ' + response.status));
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    });
  }

  function writeWithHandle(handle) {
    return handle.createWritable().then(function (writable) {
      return writable.write(state.textarea.value).then(function () {
        return writable.close();
      });
    }).then(function () {
      return handle;
    });
  }

  function saveToFile(saveAs) {
    if (!window.showSaveFilePicker) {
      downloadEditorSource();
      return;
    }
    var promise;
    if (state.fileHandle && !saveAs) {
      promise = writeWithHandle(state.fileHandle);
    } else {
      promise = window.showSaveFilePicker({
        suggestedName: fileName(),
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }]
      }).then(function (handle) {
        state.fileHandle = handle;
        return writeWithHandle(handle);
      });
    }
    promise.then(function (handle) {
      state.original = state.textarea.value;
      state.forceSave = false;
      refreshModifiedState();
      setStatus('已保存 ' + handle.name);
    }).catch(function () { /* 用户取消 */ });
  }

  function save() {
    if (serverAvailable()) {
      setStatus('正在保存…');
      postSave(state.textarea.value, state.forceSave).then(function (result) {
        state.original = state.textarea.value;
        state.baseHash = result.hash;
        state.forceSave = false;
        refreshModifiedState();
        setStatus('已保存到 ' + displayPath(state.resource) + '，站点将在数秒内自动重建');
      }).catch(function (error) {
        if (error.status === 409) {
          state.forceSave = true;
          setStatus('文件已被外部修改：再点「保存」将强制覆盖；或点「重新加载」放弃本地修改');
        } else if (error.status === 404 || error.status === undefined) {
          saveToFile(false);
        } else {
          setStatus('保存失败：' + error.message);
        }
      });
      return;
    }
    saveToFile(false);
  }

  function reloadSource() {
    if (isModified() && !window.confirm('放弃本地修改并重新加载源文件？')) {
      return;
    }
    setStatus('正在重新加载…');
    loadSource(state.resource).then(function (result) {
      state.resource = result.resource;
      state.original = result.text;
      state.textarea.value = result.text;
      state.forceSave = false;
      state.titleEl.textContent = displayPath(state.resource);
      setStatus('已重新加载源文件');
      afterContentChanged(true);
    }).catch(function (error) {
      setStatus('加载失败：' + message(error));
    });
  }

  function download() {
    loadSource(currentResource()).then(function (result) {
      saveBlob(new Blob([result.text], { type: 'text/markdown;charset=utf-8' }), result.resource.split('/').pop() || 'document.md');
    }).catch(function (error) {
      if (window.console && console.warn) {
        console.warn('下载 Markdown 失败', error);
      }
    });
  }

  // ---------- 状态与提示 ----------

  function message(error) {
    return error && error.message ? error.message : String(error);
  }

  function setStatus(text) {
    if (state.statusEl) {
      state.statusEl.textContent = text || '';
    }
  }

  function isModified() {
    return !!state.textarea && state.textarea.value !== state.original;
  }

  function refreshModifiedState() {
    if (isModified()) {
      setStatus(state.forceSave ? state.statusEl.textContent : '已修改（Ctrl+S 保存）');
    } else if (state.statusEl && /已修改/.test(state.statusEl.textContent)) {
      setStatus('');
    }
  }

  function updateMetrics() {
    if (!state.metricsEl || !state.textarea) {
      return;
    }
    var value = state.textarea.value;
    var index = state.textarea.selectionStart || 0;
    var before = value.slice(0, index);
    var line = before.split('\n').length;
    var column = index - before.lastIndexOf('\n');
    state.metricsEl.textContent = '行 ' + line + ' · 列 ' + column + ' · ' + value.length + ' 字';
  }

  // ---------- Markdown 语法高亮（左侧层级区分） ----------

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function highlightInline(text) {
    var html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, '<span class="md-code-inline">`$1`</span>');
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<span class="md-img">![$1]<span class="md-url">($2)</span></span>');
    html = html.replace(/\[([^\]]*)\]\(([^)]+)\)/g, '<span class="md-link">[$1]</span><span class="md-url">($2)</span>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<span class="md-strong">**$1**</span>');
    html = html.replace(/~~([^~]+)~~/g, '<span class="md-del">~~$1~~</span>');
    html = html.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<span class="md-em">*$2*</span>');
    html = html.replace(/\$([^$\n]+)\$/g, '<span class="md-math-inline">$$$1$$</span>');
    return html;
  }

  function highlightMarkdown(text) {
    var lines = String(text || '').split('\n');
    var output = [];
    var inFence = false;
    var fenceTag = 'md-code';
    var inMath = false;
    var inFront = /^---\s*$/.test(lines[0] || '');
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      if (inFront) {
        output.push('<span class="md-fm">' + escapeHtml(line) + '</span>');
        if (i > 0 && /^---\s*$/.test(line)) {
          inFront = false;
        }
      } else if (inFence) {
        if (/^\s*```/.test(line)) {
          inFence = false;
          output.push('<span class="md-fence">' + escapeHtml(line) + '</span>');
        } else {
          output.push('<span class="' + fenceTag + '">' + escapeHtml(line) + '</span>');
        }
      } else if (inMath) {
        output.push('<span class="md-math-block">' + escapeHtml(line) + '</span>');
        if (/\$\$\s*$/.test(line)) {
          inMath = false;
        }
      } else {
        var fence = /^(\s*)```(.*)$/.exec(line);
        var heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (fence) {
          inFence = true;
          fenceTag = /mermaid/.test(fence[2]) ? 'md-mermaid' : (/packetdiag/.test(fence[2]) ? 'md-packetdiag' : 'md-code');
          output.push('<span class="md-fence">' + highlightInline(line) + '</span>');
        } else if (/^\s*\$\$\s*$/.test(line)) {
          inMath = true;
          output.push('<span class="md-math-block">' + escapeHtml(line) + '</span>');
        } else if (heading) {
          output.push('<span class="md-h md-h' + heading[1].length + '">' + highlightInline(line) + '</span>');
        } else if (/^\s*>\s?/.test(line)) {
          output.push('<span class="md-quote">' + highlightInline(line) + '</span>');
        } else if (/^\s*([-*+]|\d+[.)])\s+\[[ xX]\]/.test(line)) {
          output.push('<span class="md-task">' + highlightInline(line) + '</span>');
        } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
          output.push('<span class="md-list">' + highlightInline(line) + '</span>');
        } else if (/^\s*\|.*\|\s*$/.test(line)) {
          output.push('<span class="md-table">' + highlightInline(line) + '</span>');
        } else if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && line.replace(/[\s\-*_]/g, '') === '') {
          output.push('<span class="md-hr">' + escapeHtml(line) + '</span>');
        } else {
          output.push(highlightInline(line));
        }
      }
      output.push('\n');
    }
    return output.join('') + '\n';
  }

  function updateHighlight() {
    if (!state.highlight || !state.textarea) {
      return;
    }
    if (state.textarea.value.length > 300000) {
      state.highlight.textContent = state.textarea.value;
    } else {
      state.highlight.innerHTML = highlightMarkdown(state.textarea.value);
    }
    state.highlight.scrollTop = state.textarea.scrollTop;
    state.highlight.scrollLeft = state.textarea.scrollLeft;
  }

  // ---------- 实时预览（marked + Prism + Mermaid + PacketDiag + KaTeX） ----------

  function enhancePreview(token) {
    var preview = state.preview;
    if (!preview) {
      return;
    }
    var codes = Array.prototype.slice.call(preview.querySelectorAll('pre > code'));
    var mermaidNodes = [];
    codes.forEach(function (code) {
      var language = /(?:language|lang)-([\w-]+)/.exec(code.className || '');
      var name = language ? language[1].toLowerCase() : '';
      var pre = code.parentNode;
      if (name === 'mermaid') {
        var container = document.createElement('div');
        container.className = 'mermaid';
        container.textContent = code.textContent;
        pre.parentNode.replaceChild(container, pre);
        mermaidNodes.push(container);
      } else if (name === 'packetdiag' && window.PacketDiag) {
        var figure = document.createElement('figure');
        figure.className = 'packetdiag-figure';
        var canvas = document.createElement('canvas');
        canvas.setAttribute('role', 'img');
        figure.appendChild(canvas);
        pre.parentNode.replaceChild(figure, pre);
        try {
          var parsed = window.PacketDiag.parse(window.PacketDiag.extractSource(code.textContent));
          window.PacketDiag.render(parsed, canvas, { fitWidth: true, width: Math.max(320, preview.clientWidth - 60) });
        } catch (error) {
          figure.classList.add('has-error');
          figure.setAttribute('data-error', message(error));
          var pre2 = document.createElement('pre');
          var code2 = document.createElement('code');
          code2.textContent = code.textContent;
          pre2.appendChild(code2);
          figure.parentNode.replaceChild(pre2, figure);
        }
      }
    });
    if (window.Prism && Prism.highlightAllUnder) {
      Prism.highlightAllUnder(preview);
    }
    if (window.MathRender && window.MathRender.render) {
      window.MathRender.render(preview);
    } else if (window.renderMathInElement) {
      window.renderMathInElement(preview, { throwOnError: false });
    }
    if (mermaidNodes.length && window.mermaid) {
      window.mermaid.run({ nodes: mermaidNodes, suppressErrors: true }).catch(function (error) {
        if (window.console && console.warn) {
          console.warn('Mermaid 渲染失败', error);
        }
      });
    }
    return token;
  }

  function updatePreview() {
    if (!state.preview) {
      return;
    }
    if (!window.marked) {
      state.preview.innerHTML = '<p class="md-editor-preview-hint">预览不可用：未加载 marked.min.js</p>';
      return;
    }
    var token = state.previewToken + 1;
    state.previewToken = token;
    var html;
    try {
      html = window.marked.parse(state.textarea.value, { gfm: true, breaks: false, async: false });
    } catch (error) {
      state.preview.innerHTML = '<p class="md-editor-preview-hint">渲染失败：' + escapeHtml(message(error)) + '</p>';
      return;
    }
    state.preview.innerHTML = html;
    enhancePreview(token);
  }

  function schedulePreview() {
    window.clearTimeout(state.previewTimer);
    state.previewTimer = window.setTimeout(updatePreview, 260);
  }

  function scheduleHighlight() {
    window.clearTimeout(state.highlightTimer);
    state.highlightTimer = window.setTimeout(updateHighlight, 70);
  }

  function afterContentChanged(immediate) {
    updateMetrics();
    refreshModifiedState();
    if (immediate) {
      updateHighlight();
      updatePreview();
    } else {
      scheduleHighlight();
      schedulePreview();
    }
  }

  // ---------- 编辑动作（工具栏 / 快捷键共用） ----------

  function syncAfterEdit() {
    afterContentChanged(false);
    state.textarea.focus();
  }

  function replaceRange(start, end, text, selectionStart, selectionEnd) {
    var value = state.textarea.value;
    state.textarea.value = value.slice(0, start) + text + value.slice(end);
    state.textarea.setSelectionRange(
      selectionStart === undefined ? start + text.length : selectionStart,
      selectionEnd === undefined ? start + text.length : selectionEnd
    );
  }

  function surround(before, after, placeholder, toggle) {
    var textarea = state.textarea;
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var value = textarea.value;
    var selected = value.slice(start, end);
    if (toggle && selected.length > 0) {
      var outerStart = Math.max(0, start - before.length);
      var outerEnd = Math.min(value.length, end + after.length);
      if (value.slice(outerStart, start) === before && value.slice(end, outerEnd) === after) {
        replaceRange(outerStart, outerEnd, selected, outerStart, outerStart + selected.length);
        syncAfterEdit();
        return;
      }
    }
    if (selected.length > before.length + after.length && selected.slice(0, before.length) === before && selected.slice(-after.length) === after) {
      var inner = selected.slice(before.length, selected.length - after.length);
      replaceRange(start, end, inner, start, start + inner.length);
      syncAfterEdit();
      return;
    }
    var body = selected || placeholder || '';
    replaceRange(start, end, before + body + after, start + before.length, start + before.length + body.length);
    syncAfterEdit();
  }

  function lineBounds() {
    var textarea = state.textarea;
    var value = textarea.value;
    var start = value.lastIndexOf('\n', textarea.selectionStart - 1) + 1;
    var end = value.indexOf('\n', textarea.selectionEnd);
    if (end === -1) {
      end = value.length;
    }
    return { start: start, end: end };
  }

  function prefixLines(kind) {
    var textarea = state.textarea;
    var bounds = lineBounds();
    var block = textarea.value.slice(bounds.start, bounds.end);
    var lines = block.split('\n');
    var pattern;
    if (kind === 'ul') {
      pattern = /^\s*[-*+]\s+/;
    } else if (kind === 'ol') {
      pattern = /^\s*\d+[.)]\s+/;
    } else if (kind === 'task') {
      pattern = /^\s*[-*+]\s+\[[ xX]\]\s*/;
    } else {
      pattern = /^\s*>\s?/;
    }
    var prefixed = lines.filter(function (line) { return line.trim(); }).every(function (line) { return pattern.test(line); });
    var next = lines.map(function (line, index) {
      if (!line.trim()) {
        return line;
      }
      if (prefixed) {
        return line.replace(pattern, '');
      }
      if (kind === 'ul') {
        return '- ' + line;
      }
      if (kind === 'ol') {
        return (index + 1) + '. ' + line;
      }
      if (kind === 'task') {
        return '- [ ] ' + line;
      }
      return '> ' + line;
    }).join('\n');
    replaceRange(bounds.start, bounds.end, next, bounds.start, bounds.start + next.length);
    syncAfterEdit();
  }

  function toggleHeading(level) {
    var textarea = state.textarea;
    var bounds = lineBounds();
    var line = textarea.value.slice(bounds.start, bounds.end);
    var current = /^(#{1,6})\s+/.exec(line);
    var text = line.replace(/^#{1,6}\s+/, '');
    var next = (current && current[1].length === level ? '' : new Array(level + 1).join('#') + ' ') + text;
    replaceRange(bounds.start, bounds.end, next, bounds.start, bounds.start + next.length);
    syncAfterEdit();
  }

  function insertBlock(text, selectionStart, selectionEnd) {
    var textarea = state.textarea;
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var value = textarea.value;
    var before = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
    var after = end < value.length && value[end] !== '\n' ? '\n' : '';
    var payload = before + text + after;
    var offset = before.length;
    replaceRange(
      start,
      end,
      payload,
      selectionStart === undefined ? start + payload.length : start + offset + selectionStart,
      selectionEnd === undefined ? start + payload.length : start + offset + selectionEnd
    );
    syncAfterEdit();
  }

  function insertFence(language, skeleton) {
    var textarea = state.textarea;
    var selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    var body = selected || skeleton || '';
    var text = '```' + (language || '') + '\n' + body + '\n```\n';
    var bodyStart = text.indexOf('\n') + 1;
    insertBlock(text, bodyStart, bodyStart + body.length);
  }

  var TABLE_SKELETON = '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n';

  function indentSelection(outdent) {
    var textarea = state.textarea;
    var bounds = lineBounds();
    var block = textarea.value.slice(bounds.start, bounds.end);
    var lines = block.split('\n');
    var next = lines.map(function (line) {
      if (!line.length) {
        return line;
      }
      if (outdent) {
        return line.replace(new RegExp('^( {1,' + INDENT.length + '}|\t)'), '');
      }
      return INDENT + line;
    }).join('\n');
    replaceRange(bounds.start, bounds.end, next, bounds.start, bounds.start + next.length);
    syncAfterEdit();
  }

  function moveLines(direction) {
    var textarea = state.textarea;
    var value = textarea.value;
    var bounds = lineBounds();
    var start = bounds.start;
    var end = bounds.end;
    if (direction < 0) {
      if (start === 0) {
        return;
      }
      var prevStart = value.lastIndexOf('\n', start - 2) + 1;
      var prev = value.slice(prevStart, start - 1);
      var current = value.slice(start, end);
      replaceRange(prevStart, end, current + '\n' + prev, prevStart, prevStart + current.length);
    } else {
      if (end >= value.length) {
        return;
      }
      var nextEnd = value.indexOf('\n', end + 1);
      if (nextEnd === -1) {
        nextEnd = value.length;
      }
      var nextLine = value.slice(end + 1, nextEnd);
      var currentLine = value.slice(start, end);
      replaceRange(start, nextEnd, nextLine + '\n' + currentLine, start + nextLine.length + 1, start + nextLine.length + 1 + currentLine.length);
    }
    syncAfterEdit();
  }

  function applyAction(action) {
    if (!state.textarea) {
      return;
    }
    var actions = {
      bold: function () { surround('**', '**', '加粗文本', true); },
      italic: function () { surround('*', '*', '斜体文本', true); },
      strike: function () { surround('~~', '~~', '删除线', true); },
      code: function () { surround('`', '`', '行内代码', true); },
      link: function () { surround('[', '](https://)', '链接文字'); },
      image: function () { surround('![', '](images/example.png)', '图片说明'); },
      math: function () { surround('$', '$', 'E = mc^2'); },
      mathBlock: function () { insertBlock('$$\nE = mc^2\n$$\n', 3, 3); },
      h1: function () { toggleHeading(1); },
      h2: function () { toggleHeading(2); },
      h3: function () { toggleHeading(3); },
      ul: function () { prefixLines('ul'); },
      ol: function () { prefixLines('ol'); },
      task: function () { prefixLines('task'); },
      quote: function () { prefixLines('quote'); },
      fence: function () { insertFence('', '代码'); },
      mermaid: function () { insertFence('mermaid', 'flowchart LR\n  A[开始] --> B[结束]'); },
      packetdiag: function () { insertFence('packetdiag', 'packetdiag {\n  colwidth = 32;\n  0-15: Field A;\n  16-31: Field B;\n}'); },
      table: function () { insertBlock(TABLE_SKELETON); },
      hr: function () { insertBlock('---\n'); },
      save: function () { save(); },
      saveAs: function () { saveToFile(true); },
      download: function () { downloadEditorSource(); },
      copy: function () { copySource(); },
      reload: function () { reloadSource(); },
      revert: function () { revert(); },
      help: function () { toggleHelp(); },
      close: function () { close(); }
    };
    if (actions[action]) {
      actions[action]();
    }
  }

  var TOOLBAR = [
    { action: 'bold', label: 'B', title: '加粗（Ctrl+B）', className: 'is-bold' },
    { action: 'italic', label: 'I', title: '斜体（Ctrl+I）', className: 'is-italic' },
    { action: 'strike', label: 'S', title: '删除线（Ctrl+Shift+X）', className: 'is-strike' },
    { action: 'code', label: '<>', title: '行内代码（Ctrl+E）' },
    { action: 'link', label: '链接', title: '链接（Ctrl+K）' },
    { action: 'image', label: '图片', title: '图片' },
    { divider: true },
    { action: 'h1', label: 'H1', title: '一级标题（Ctrl+Alt+1）' },
    { action: 'h2', label: 'H2', title: '二级标题（Ctrl+Alt+2）' },
    { action: 'h3', label: 'H3', title: '三级标题（Ctrl+Alt+3）' },
    { divider: true },
    { action: 'ul', label: '• 列表', title: '无序列表（Ctrl+Shift+U）' },
    { action: 'ol', label: '1. 列表', title: '有序列表（Ctrl+Shift+O）' },
    { action: 'task', label: '☑ 任务', title: '任务列表（Ctrl+Shift+K）' },
    { action: 'quote', label: '引用', title: '引用（Ctrl+Shift+Q）' },
    { divider: true },
    { action: 'fence', label: '代码块', title: '代码块（Ctrl+Shift+C）' },
    { action: 'mermaid', label: 'Mermaid', title: 'Mermaid 图形（Ctrl+Shift+G）' },
    { action: 'packetdiag', label: 'PacketDiag', title: 'PacketDiag 报文图（Ctrl+Shift+D）' },
    { action: 'table', label: '表格', title: '表格（Ctrl+Shift+T）' },
    { action: 'hr', label: '分隔线', title: '分隔线' },
    { divider: true },
    { action: 'math', label: 'Σ 行内公式', title: '行内公式 $...$（Ctrl+M）' },
    { action: 'mathBlock', label: 'Σ 公式块', title: '公式块 $$...$$（Ctrl+Shift+M）' },
    { divider: true },
    { action: 'help', label: '快捷键', title: '快捷键说明（Ctrl+/）' }
  ];

  var SHORTCUTS = [
    { key: 'b', ctrl: true, action: 'bold' },
    { key: 'i', ctrl: true, action: 'italic' },
    { key: 'x', ctrl: true, shift: true, action: 'strike' },
    { key: 'e', ctrl: true, action: 'code' },
    { key: 'k', ctrl: true, action: 'link' },
    { key: 'm', ctrl: true, action: 'math' },
    { key: 'm', ctrl: true, shift: true, action: 'mathBlock' },
    { key: 'u', ctrl: true, shift: true, action: 'ul' },
    { key: 'o', ctrl: true, shift: true, action: 'ol' },
    { key: 'k', ctrl: true, shift: true, action: 'task' },
    { key: 'q', ctrl: true, shift: true, action: 'quote' },
    { key: 'c', ctrl: true, shift: true, action: 'fence' },
    { key: 'g', ctrl: true, shift: true, action: 'mermaid' },
    { key: 'd', ctrl: true, shift: true, action: 'packetdiag' },
    { key: 't', ctrl: true, shift: true, action: 'table' },
    { key: 'l', ctrl: true, shift: true, action: 'hr' },
    { key: 's', ctrl: true, action: 'save' },
    { key: 's', ctrl: true, shift: true, action: 'saveAs' },
    { key: '/', ctrl: true, action: 'help' },
    { key: '1', ctrl: true, alt: true, action: 'h1' },
    { key: '2', ctrl: true, alt: true, action: 'h2' },
    { key: '3', ctrl: true, alt: true, action: 'h3' }
  ];

  function matchShortcut(event) {
    var key = String(event.key || '').toLowerCase();
    for (var i = 0; i < SHORTCUTS.length; i += 1) {
      var item = SHORTCUTS[i];
      if (item.key === key
        && !!item.ctrl === (event.ctrlKey || event.metaKey)
        && !!item.shift === event.shiftKey
        && !!item.alt === event.altKey) {
        return item.action;
      }
    }
    return null;
  }

  function copySource() {
    var text = state.textarea.value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        setStatus('已复制到剪贴板');
      }, function () {
        setStatus('复制失败，请手动选择文本');
      });
    } else {
      state.textarea.select();
      setStatus('已全选，请按 Ctrl+C 复制');
    }
  }

  function revert() {
    state.textarea.value = state.original;
    state.forceSave = false;
    setStatus('已还原为打开时的内容');
    afterContentChanged(true);
  }

  function toggleHelp() {
    var help = state.overlay.querySelector('.md-editor-help');
    if (help) {
      help.hidden = !help.hidden;
    }
  }

  function close() {
    if (!state.overlay || !state.overlay.classList.contains('is-open')) {
      return;
    }
    if (isModified() && !window.confirm('有未保存的修改，确定关闭编辑器？')) {
      return;
    }
    state.overlay.classList.remove('is-open');
    document.body.classList.remove('md-editor-open');
    if (state.lastFocus && state.lastFocus.focus) {
      state.lastFocus.focus();
    }
  }

  // ---------- 布局与事件 ----------

  function applySplit(percent) {
    state.split = Math.min(78, Math.max(22, percent));
    var body = state.overlay.querySelector('.md-editor-body');
    if (body) {
      body.style.gridTemplateColumns = state.split + '% 6px ' + (100 - state.split) + '%';
    }
    try {
      localStorage.setItem(SPLIT_STORAGE, String(state.split));
    } catch (_) { /* 忽略隐私模式 */ }
  }

  function loadSplit() {
    var saved = 0;
    try {
      saved = parseInt(localStorage.getItem(SPLIT_STORAGE) || '', 10);
    } catch (_) {
      saved = 0;
    }
    return saved >= 22 && saved <= 78 ? saved : 50;
  }

  function bindOverlay() {
    state.overlay.addEventListener('click', function (event) {
      var target = event.target;
      var action = target.getAttribute && target.getAttribute('data-editor-action');
      if (target.hasAttribute && target.hasAttribute('data-editor-close')) {
        close();
        return;
      }
      if (action) {
        applyAction(action);
      }
    });

    state.textarea.addEventListener('input', function () {
      state.forceSave = false;
      afterContentChanged(false);
    });
    state.textarea.addEventListener('scroll', function () {
      if (state.highlight) {
        state.highlight.scrollTop = state.textarea.scrollTop;
        state.highlight.scrollLeft = state.textarea.scrollLeft;
      }
    });
    ['click', 'keyup', 'select'].forEach(function (name) {
      state.textarea.addEventListener(name, updateMetrics);
    });

    var divider = state.overlay.querySelector('.md-editor-divider');
    divider.addEventListener('mousedown', function (event) {
      state.dragging = true;
      event.preventDefault();
    });
    document.addEventListener('mousemove', function (event) {
      if (!state.dragging) {
        return;
      }
      var bodyRect = state.overlay.querySelector('.md-editor-body').getBoundingClientRect();
      applySplit(((event.clientX - bodyRect.left) / bodyRect.width) * 100);
    });
    document.addEventListener('mouseup', function () {
      state.dragging = false;
    });

    document.addEventListener('keydown', function (event) {
      if (!state.overlay.classList.contains('is-open')) {
        return;
      }
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }
      var action = matchShortcut(event);
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        applyAction(action);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        indentSelection(event.shiftKey);
        return;
      }
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        moveLines(event.key === 'ArrowUp' ? -1 : 1);
      }
    }, true);
  }

  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.className = 'md-editor';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '编辑 Markdown 源文档');
    overlay.tabIndex = -1;
    var toolbar = TOOLBAR.map(function (item) {
      if (item.divider) {
        return '<span class="md-editor-tool-divider" role="separator"></span>';
      }
      return '<button type="button" class="md-editor-tool' + (item.className ? ' ' + item.className : '') + '" data-editor-action="' + item.action + '" title="' + escapeHtml(item.title) + '">' + escapeHtml(item.label) + '</button>';
    }).join('');
    overlay.innerHTML = [
      '<div class="md-editor-backdrop" data-editor-close></div>',
      '<section class="md-editor-panel">',
      '<header class="md-editor-head">',
      '<strong class="md-editor-title" data-editor-title></strong>',
      '<span class="md-editor-mode" data-editor-mode></span>',
      '<span class="md-editor-status" data-editor-status></span>',
      '<span class="md-editor-spacer"></span>',
      '<button type="button" data-editor-action="save">保存</button>',
      '<button type="button" data-editor-action="saveAs">另存为…</button>',
      '<button type="button" data-editor-action="download">下载 MD</button>',
      '<button type="button" data-editor-action="copy">复制</button>',
      '<button type="button" data-editor-action="reload">重新加载</button>',
      '<button type="button" data-editor-action="revert">还原</button>',
      '<button type="button" data-editor-action="close">关闭</button>',
      '</header>',
      '<div class="md-editor-toolbar">', toolbar, '</div>',
      '<div class="md-editor-body">',
      '<div class="md-editor-pane md-editor-pane-source">',
      '<pre class="md-editor-highlight" aria-hidden="true"></pre>',
      '<textarea class="md-editor-text" spellcheck="false" aria-label="Markdown 源文本" wrap="soft"></textarea>',
      '</div>',
      '<div class="md-editor-divider" role="separator" aria-label="拖动调整分栏" title="拖动调整左右宽度"></div>',
      '<div class="md-editor-pane md-editor-pane-preview">',
      '<div class="markdown-section md-editor-preview"></div>',
      '</div>',
      '</div>',
      '<div class="md-editor-help" hidden>',
      '<strong>快捷键</strong>',
      '<ul>',
      '<li><code>Ctrl+B</code> 加粗 · <code>Ctrl+I</code> 斜体 · <code>Ctrl+Shift+X</code> 删除线 · <code>Ctrl+E</code> 行内代码</li>',
      '<li><code>Ctrl+K</code> 链接 · <code>Ctrl+M</code> 行内公式 · <code>Ctrl+Shift+M</code> 公式块</li>',
      '<li><code>Ctrl+Alt+1/2/3</code> 一/二/三级标题</li>',
      '<li><code>Ctrl+Shift+U</code> 无序列表 · <code>Ctrl+Shift+O</code> 有序列表 · <code>Ctrl+Shift+K</code> 任务列表</li>',
      '<li><code>Ctrl+Shift+Q</code> 引用 · <code>Ctrl+Shift+C</code> 代码块 · <code>Ctrl+Shift+T</code> 表格 · <code>Ctrl+Shift+L</code> 分隔线</li>',
      '<li><code>Ctrl+Shift+G</code> Mermaid · <code>Ctrl+Shift+D</code> PacketDiag</li>',
      '<li><code>Tab</code> / <code>Shift+Tab</code> 缩进 · <code>Alt+↑/↓</code> 移动行</li>',
      '<li><code>Ctrl+S</code> 保存 · <code>Ctrl+Shift+S</code> 另存为 · <code>Esc</code> 关闭</li>',
      '</ul>',
      '</div>',
      '<footer class="md-editor-foot">',
      '<span class="md-editor-metrics" data-editor-metrics></span>',
      '<span class="md-editor-spacer"></span>',
      '<span>左：Markdown 源码（格式分色） · 右：实时预览（Mermaid / PacketDiag / KaTeX 公式）</span>',
      '</footer>',
      '</section>'
    ].join('');
    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.textarea = overlay.querySelector('.md-editor-text');
    state.highlight = overlay.querySelector('.md-editor-highlight');
    state.preview = overlay.querySelector('.md-editor-preview');
    state.titleEl = overlay.querySelector('[data-editor-title]');
    state.statusEl = overlay.querySelector('[data-editor-status]');
    state.modeEl = overlay.querySelector('[data-editor-mode]');
    state.metricsEl = overlay.querySelector('[data-editor-metrics]');
    applySplit(loadSplit());
    bindOverlay();
  }

  function open() {
    state.resource = currentResource();
    state.lastFocus = document.activeElement;
    state.fileHandle = null;
    state.forceSave = false;
    if (!state.overlay) {
      buildOverlay();
    }
    state.titleEl.textContent = displayPath(state.resource);
    state.modeEl.textContent = saveModeLabel();
    state.original = '';
    state.textarea.value = '';
    state.highlight.innerHTML = '';
    state.preview.innerHTML = '';
    setStatus('正在读取源文档…');
    state.overlay.classList.add('is-open');
    document.body.classList.add('md-editor-open');
    state.overlay.focus();
    loadSource(state.resource).then(function (result) {
      state.resource = result.resource;
      state.titleEl.textContent = displayPath(state.resource);
      state.original = result.text;
      state.textarea.value = result.text;
      state.forceSave = false;
      afterContentChanged(true);
      state.textarea.focus();
      setStatus(state.resource === 'README.md'
        ? '站点首页由构建生成；如需长期修改请编辑 docs/md 下的源文档'
        : '');
      return sha256(state.textarea.value);
    }).then(function (hash) {
      state.baseHash = hash;
    }).catch(function (error) {
      setStatus('读取失败：' + message(error));
    });
  }

  window.MdEditor = { open: open, download: download, save: save, close: close };
}());
