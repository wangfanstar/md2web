(function () {
  'use strict';

  var state = {
    overlay: null,
    textarea: null,
    titleEl: null,
    statusEl: null,
    resource: '',
    original: '',
    lastFocus: null
  };

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
    var value = resource === 'README.md' ? 'README.md' : resource;
    return value === 'README.md' ? 'docs/README.md' : 'docs/md/' + value.replace(/^md\//, '');
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

  function isModified() {
    return !!state.textarea && state.textarea.value !== state.original;
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

  function fileName() {
    return state.resource.split('/').pop() || 'document.md';
  }

  function downloadEditorSource() {
    saveBlob(new Blob([state.textarea.value], { type: 'text/markdown;charset=utf-8' }), fileName());
    state.statusEl.textContent = '已下载 ' + fileName();
  }

  function saveToFile() {
    if (!window.showSaveFilePicker) {
      downloadEditorSource();
      return;
    }
    window.showSaveFilePicker({
      suggestedName: fileName(),
      types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }]
    }).then(function (handle) {
      return handle.createWritable().then(function (writable) {
        return writable.write(state.textarea.value).then(function () {
          return writable.close();
        });
      }).then(function () {
        return handle.name;
      });
    }).then(function (savedName) {
      state.original = state.textarea.value;
      state.statusEl.textContent = '已保存 ' + savedName + '（保存到 docs/md 时服务会自动重建）';
    }).catch(function () { /* 用户取消保存 */ });
  }

  function copySource() {
    var text = state.textarea.value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        state.statusEl.textContent = '已复制到剪贴板';
      }, function () {
        state.statusEl.textContent = '复制失败，请手动选择文本';
      });
    } else {
      state.statusEl.textContent = '当前浏览器不支持剪贴板，请手动选择文本';
    }
  }

  function bindOverlay() {
    state.overlay.addEventListener('click', function (event) {
      var action = event.target.getAttribute && event.target.getAttribute('data-editor-action');
      if (event.target.hasAttribute && event.target.hasAttribute('data-editor-close')) {
        close();
        return;
      }
      if (action === 'download') {
        downloadEditorSource();
      } else if (action === 'save-file') {
        saveToFile();
      } else if (action === 'copy') {
        copySource();
      } else if (action === 'revert') {
        state.textarea.value = state.original;
        state.statusEl.textContent = '已还原为打开时的内容';
      } else if (action === 'close') {
        close();
      }
    });
    state.textarea.addEventListener('input', function () {
      state.statusEl.textContent = isModified() ? '已修改（下载或保存后需重新构建）' : '';
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.overlay.classList.contains('is-open')) {
        event.stopPropagation();
        close();
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
    overlay.innerHTML = [
      '<div class="md-editor-backdrop" data-editor-close></div>',
      '<section class="md-editor-panel">',
      '<header class="md-editor-head">',
      '<strong class="md-editor-title" data-editor-title></strong>',
      '<span class="md-editor-status" data-editor-status></span>',
      '<span class="md-editor-spacer"></span>',
      '<button type="button" data-editor-action="save-file">保存到文件…</button>',
      '<button type="button" data-editor-action="download">下载 MD</button>',
      '<button type="button" data-editor-action="copy">复制</button>',
      '<button type="button" data-editor-action="revert">还原</button>',
      '<button type="button" data-editor-action="close">关闭</button>',
      '</header>',
      '<textarea class="md-editor-text" spellcheck="false" aria-label="Markdown 源文本"></textarea>',
      '</section>'
    ].join('');
    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.textarea = overlay.querySelector('.md-editor-text');
    state.titleEl = overlay.querySelector('[data-editor-title]');
    state.statusEl = overlay.querySelector('[data-editor-status]');
    bindOverlay();
  }

  function open() {
    state.resource = currentResource();
    state.lastFocus = document.activeElement;
    if (!state.overlay) {
      buildOverlay();
    }
    state.titleEl.textContent = displayPath(state.resource);
    state.original = '';
    state.textarea.value = '';
    state.statusEl.textContent = '正在读取源文档…';
    state.overlay.classList.add('is-open');
    document.body.classList.add('md-editor-open');
    state.overlay.focus();
    loadSource(state.resource).then(function (result) {
      state.resource = result.resource;
      state.titleEl.textContent = displayPath(state.resource);
      state.original = result.text;
      state.textarea.value = result.text;
      state.statusEl.textContent = state.resource === 'README.md'
        ? '站点首页由构建生成；如需长期修改请编辑 docs/md 下的源文档'
        : '';
      state.textarea.focus();
    }).catch(function (error) {
      state.statusEl.textContent = '读取失败：' + (error && error.message ? error.message : error);
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

  window.MdEditor = { open: open, download: download };
}());
