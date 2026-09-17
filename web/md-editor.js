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
    draftVersion: 0,
    document: null,
    binding: null,
    conflict: null,
    prepareOperation: null,
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

  function authAvailable() {
    return !!(window.SiteAuth && window.SiteAuth.isAuthenticated());
  }

  function saveModeLabel() {
    if (authAvailable()) {
      return '草稿保存';
    }
    if (/^https?:$/.test(window.location.protocol)) {
      return '登录后编辑';
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
      refreshModifiedState();
      setStatus('已保存 ' + handle.name);
    }).catch(function () { /* 用户取消 */ });
  }

  // 阶段一：登录后保存个人草稿（接口在阶段二实现，501 时给出明确提示）
  function authApi(path, options) {
    var headers = Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {});
    if (window.SiteAuth && window.SiteAuth.csrfToken()) {
      headers['X-CSRF-Token'] = window.SiteAuth.csrfToken();
    }
    return fetch(path, Object.assign({}, options, { headers: headers })).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok || payload.ok === false) {
          var error = new Error(payload.error || ('HTTP ' + response.status));
          error.status = response.status;
          error.payload = payload;
          throw error;
        }
        return payload;
      });
    });
  }

  // 登录后：从服务端读取编辑基线（已发布内容 + 个人草稿）
  function loadDocumentFromServer() {
    return authApi('__md/document?path=' + encodeURIComponent(state.resource)).then(function (payload) {
      var doc = payload.document || {};
      if (doc.path && doc.path !== state.resource) {
        // 服务端会补回 .md 后缀（docsify 路由不带扩展名）
        state.resource = doc.path;
        state.titleEl.textContent = displayPath(state.resource);
      }
      state.document = doc;
      state.baseHash = (doc.published && doc.published.hash) || null;
      state.binding = doc.binding || null;
      state.original = doc.draft ? doc.draft.content : (doc.published ? doc.published.text : '');
      state.draftVersion = doc.draft ? doc.draft.version : 0;
      state.textarea.value = state.original;
      updateBindingLabel();
      afterContentChanged(true);
      setStatus(doc.draft
        ? '已载入个人草稿 v' + doc.draft.version + '（未提交 SVN）'
        : '已载入已发布版本');
      historyReset(state.textarea.value);
      return doc;
    });
  }

  function saveDraft() {
    var content = state.textarea.value;
    setStatus('正在保存草稿…');
    return authApi('__md/draft', {
      method: 'PUT',
      body: JSON.stringify({
        path: state.resource,
        content: content,
        expectedVersion: state.draftVersion || 0,
        baseHash: state.baseHash
      })
    }).then(function (payload) {
      state.original = content;
      state.draftVersion = payload.version;
      refreshModifiedState();
      setStatus('已保存个人草稿 v' + payload.version + '（尚未提交 SVN）');
      return payload;
    });
  }

  function save() {
    if (state.localMode) {
      downloadEditorSource();
      return;
    }
    if (state.readOnlyHome) {
      setStatus('站点首页由构建生成，无法保存；请编辑 docs/md 下的文档。');
      return;
    }
    if (authAvailable()) {
      saveDraft().catch(function (error) {
        if (error.status === 401) {
          setStatus('会话已过期：' + error.message + '（内容已保留，可先下载 MD 再重新登录）');
          window.SiteAuth.openLogin();
          return;
        }
        if (error.status === 409) {
          state.conflict = error.payload || {};
          showDiffPanel('草稿版本冲突：' + error.message + '\n可点「载入最新」放弃本地修改，或点「差异」比对后手动合并。');
          setStatus('草稿版本冲突（不会静默覆盖）：请查看差异后处理');
          return;
        }
        setStatus('保存失败：' + error.message);
      });
      return;
    }
    if (/^https?:$/.test(window.location.protocol)) {
      setStatus('请先登录 SVN 账号后再保存（内容已保留，可先下载 MD）');
      if (window.SiteAuth) {
        window.SiteAuth.openLogin();
      }
      return;
    }
    saveToFile(false);
  }

  // ---------- 版本历史与差异 ----------

  function updateBindingLabel() {
    var el = state.overlay && state.overlay.querySelector('[data-editor-binding]');
    if (!el) {
      return;
    }
    if (!authAvailable()) {
      el.textContent = '未登录（只读）';
      return;
    }
    if (!state.binding) {
      el.textContent = '未关联 SVN';
      return;
    }
    var label = '目标库 ' + state.binding.id + ' · ' + state.binding.mount;
    var status = state.syncStatus;
    if (status) {
      var revision = status.remoteRevision || status.publishedRevision;
      if (revision) {
        label += ' · r' + revision;
      }
      if (status.needsMerge) {
        label += ' · 远端已更新，请先合并（远端差异）';
      } else if (status.syncError && status.syncError !== 'conflicts') {
        label += ' · 同步异常（' + status.syncError + '）';
      }
    }
    el.textContent = label;
  }

  function refreshSyncStatus() {
    if (!authAvailable() || state.localMode || state.readOnlyHome) {
      state.syncStatus = null;
      updateBindingLabel();
      return Promise.resolve(null);
    }
    return authApi('__svn/status?path=' + encodeURIComponent(state.resource)).then(function (payload) {
      state.syncStatus = payload.status || null;
      updateBindingLabel();
      return state.syncStatus;
    }).catch(function () {
      state.syncStatus = null;
      updateBindingLabel();
      return null;
    });
  }

  function showRemoteDiff() {
    setStatus('正在读取远端差异…');
    return authApi('__svn/remote-diff?path=' + encodeURIComponent(state.resource)).then(function (payload) {
      showDiffPanel(payload.diff || '（远端与本地内容一致）',
        '远端 r' + (payload.remoteRevision || '?') + ' ↔ 本地');
      setStatus('远端差异已打开（合并后保存草稿并提交）');
    }).catch(function (error) {
      showDiffPanel('读取远端差异失败：' + error.message, '远端差异');
      setStatus('读取远端差异失败：' + error.message);
    });
  }

  function ensurePanels() {
    return state.overlay ? state.overlay.querySelector('[data-editor-panels]') : null;
  }

  function showDiffPanel(text, title) {
    var panels = ensurePanels();
    if (!panels) {
      return;
    }
    panels.hidden = false;
    panels.querySelector('[data-editor-panels-title]').textContent = title || '版本差异';
    panels.querySelector('[data-editor-history-list]').hidden = true;
    var area = panels.querySelector('[data-editor-diff]');
    area.hidden = false;
    area.querySelector('pre').textContent = text || '（无差异）';
  }

  function showHistoryPanel() {
    var panels = ensurePanels();
    if (!panels) {
      return Promise.resolve();
    }
    panels.hidden = false;
    panels.querySelector('[data-editor-panels-title]').textContent = '修改历史（个人草稿）';
    panels.querySelector('[data-editor-diff]').hidden = true;
    var list = panels.querySelector('[data-editor-history-list]');
    list.hidden = false;
    list.textContent = '正在读取历史…';
    return authApi('__md/history?path=' + encodeURIComponent(state.resource)).then(function (payload) {
      var revisions = (payload.history && payload.history.revisions) || [];
      if (!revisions.length) {
        list.textContent = '还没有草稿版本：Ctrl+S 保存一次草稿后即可看到历史。';
        return;
      }
      list.innerHTML = revisions.map(function (item) {
        var date = String(item.createdAt || '').replace('T', ' ').slice(0, 19);
        return '<div class="md-editor-history-row">'
          + '<span class="md-editor-history-title">#' + item.id + (item.isHead ? '（当前）' : '')
          + ' · v' + item.draftVersion + ' · ' + escapeHtml(date) + '</span>'
          + '<span class="md-editor-history-size">' + Math.round((item.size || 0) / 1024) + ' KB</span>'
          + '<button type="button" data-editor-action="load-revision" data-revision="' + item.id + '">载入</button>'
          + '<button type="button" data-editor-action="diff-revision" data-revision="' + item.id + '">与当前比对</button>'
          + '</div>';
      }).join('');
    }).catch(function (error) {
      list.textContent = '读取历史失败：' + error.message;
    });
  }

  function diffWith(reference) {
    setStatus('正在生成差异…');
    return authApi('__md/diff?path=' + encodeURIComponent(state.resource)
      + '&from=' + encodeURIComponent(reference) + '&to=draft').then(function (payload) {
      var diff = payload.diff || {};
      var header = diff.from && diff.to ? diff.from.label + ' → ' + diff.to.label + '\n\n' : '';
      showDiffPanel(header + (diff.diff || ''), '版本差异');
      setStatus(diff.identical ? '内容一致，没有差异' : '');
    }).catch(function (error) {
      showDiffPanel('生成差异失败：' + error.message);
    });
  }

  function loadRevisionContent(revisionId) {
    return authApi('__md/revision?id=' + encodeURIComponent(revisionId)).then(function (payload) {
      state.textarea.value = payload.revision.content;
      setStatus('已载入版本 #' + revisionId + '（未保存；Ctrl+S 会另存为新版本）');
      afterContentChanged(true);
    }).catch(function (error) {
      setStatus('载入版本失败：' + error.message);
    });
  }

  function discardDraft() {
    if (!window.confirm('放弃当前草稿并回到已发布版本？（历史版本仍保留）')) {
      return;
    }
    authApi('__md/discard', { method: 'POST', body: JSON.stringify({ path: state.resource }) }).then(function () {
      setStatus('已放弃草稿，正在重新载入已发布版本…');
      var panels = ensurePanels();
      if (panels) {
        panels.hidden = true;
      }
      return loadDocumentFromServer();
    }).catch(function (error) {
      setStatus('放弃草稿失败：' + error.message);
    });
  }

  function promptCredentials(reason) {
    var prefix = reason ? reason + '\n' : '';
    var username = window.prompt(prefix + '请输入用于本次合入的 SVN 账号（本机管理员账号无法合入 SVN）');
    if (!username) {
      return null;
    }
    var password = window.prompt(prefix + '的密码（加密保存到本机数据库，供后续提交复用；换密码后重新登录会自动更新）');
    if (!password) {
      return null;
    }
    return { svnUsername: username, svnPassword: password };
  }

  function commitWithCredentials(operationId, credentials) {
    return authApi('__svn/commit', {
      method: 'POST',
      body: JSON.stringify(Object.assign({ operationId: operationId }, credentials || {}))
    });
  }

  function startSvnCommit() {
    if (!authAvailable()) {
      setStatus('请先登录后再提交 SVN');
      return;
    }
    if (state.readOnlyHome) {
      setStatus('站点首页由构建生成，无法提交；请编辑 docs/md 下的文档。');
      return;
    }
    var message = window.prompt('提交说明（将写入 SVN 日志）', 'docs: 更新 ' + state.resource.split('/').pop());
    if (!message) {
      return;
    }
    setStatus('正在准备提交（核对基线与差异）…');
    authApi('__svn/prepare', {
      method: 'POST',
      body: JSON.stringify({ path: state.resource, message: message, expectedVersion: state.draftVersion || 0 })
    }).then(function (payload) {
      state.prepareOperation = payload;
      showDiffPanel(
        '目标库：' + payload.manifest.repositoryId + '（' + payload.manifest.mount + '）\n'
        + '提交说明：' + payload.manifest.message + '\n\n'
        + (payload.diff || '（无差异）')
        + '\n\n点击下方「确认提交」写入 SVN；点「关闭」可稍后再提交。',
        '审阅提交（确认后写入 SVN）'
      );
      var panels = ensurePanels();
      if (panels) {
        var head = panels.querySelector('.md-editor-panels-head');
        if (head && !head.querySelector('[data-editor-action="svn-confirm"]')) {
          var confirmButton = document.createElement('button');
          confirmButton.type = 'button';
          confirmButton.setAttribute('data-editor-action', 'svn-confirm');
          confirmButton.textContent = '确认提交';
          head.insertBefore(confirmButton, head.querySelector('[data-editor-action="discard-draft"]'));
        }
      }
      setStatus('已生成审阅清单，请确认差异后提交');
    }).catch(function (error) {
      setStatus('准备提交失败：' + error.message);
    });
  }

  function confirmSvnCommit() {
    if (!state.prepareOperation) {
      setStatus('没有待提交的审阅清单');
      return;
    }
    var operationId = state.prepareOperation.operationId;
    var snapshot = window.SiteAuth && window.SiteAuth.snapshot ? window.SiteAuth.snapshot() : {};
    if (!snapshot.svnCredential) {
      var reason = '本机管理员账号只能本地编辑（草稿），合入 SVN 需要 SVN 账号。';
      setStatus(reason + '请在提示框中输入用于本次合入的账号密码。');
      var credentials = promptCredentials(reason);
      if (!credentials) {
        setStatus('已取消合入：需要 SVN 账号才能写入仓库（草稿已保留）');
        return;
      }
      setStatus('正在提交 SVN…');
      commitWithCredentials(operationId, credentials).then(function (payload) {
        state.prepareOperation = null;
        var result = payload.result || {};
        window.SiteAuth.refresh();
        setStatus('已提交 SVN：r' + result.svnRevision + '（站点将在重建后更新）');
        afterCommit(result);
      }).catch(function (error) {
        setStatus('提交失败：' + error.message);
      });
      return;
    }
    setStatus('正在提交 SVN…');
    commitWithCredentials(operationId).then(function (payload) {
      state.prepareOperation = null;
      var result = payload.result || {};
      setStatus('已提交 SVN：r' + result.svnRevision + '（站点将在重建后更新）');
      afterCommit(result);
    }).catch(function (error) {
      if (error.status === 401) {
        var credentials = promptCredentials();
        if (!credentials) {
          setStatus('已取消提交（需要 SVN 账号密码）');
          return;
        }
        commitWithCredentials(operationId, credentials).then(function (payload) {
          state.prepareOperation = null;
          var result = payload.result || {};
          setStatus('已提交 SVN：r' + result.svnRevision + '（站点将在重建后更新）');
          afterCommit(result);
        }).catch(function (retryError) {
          setStatus('提交失败：' + retryError.message);
        });
        return;
      }
      setStatus('提交失败：' + error.message);
    });
  }

  function afterCommit(result) {
    var head = '提交成功：r' + result.svnRevision + '\n' + (result.message || '')
      + '\n' + result.path + '\n';
    if (result.diff) {
      showDiffPanel(head + '\n本次提交差异：\n' + result.diff, '本次提交差异（已写入 SVN）');
    } else {
      showDiffPanel(head + '\n（本次没有文本差异）', '本次提交结果');
    }
    refreshSyncStatus().then(function (status) {
      var button = state.overlay.querySelector('[data-editor-action="remote-diff"]');
      if (button) {
        button.hidden = !(status && status.needsMerge);
      }
    });
  }

  function showSvnLog() {
    setStatus('正在读取 SVN 日志…');
    authApi('__svn/log?path=' + encodeURIComponent(state.resource) + '&limit=20').then(function (payload) {
      var entries = payload.entries || [];
      var text = entries.map(function (entry) {
        return 'r' + entry.revision + '  ' + String(entry.date || '').replace('T', ' ').slice(0, 19)
          + '  ' + entry.author + '\n    ' + (entry.message || '').split('\n').join('\n    ');
      }).join('\n\n');
      showDiffPanel(text || '（暂无日志）', 'SVN 日志（当前账号可读范围）');
      setStatus('');
    }).catch(function (error) {
      setStatus('读取 SVN 日志失败：' + error.message);
    });
  }

  function handlePanelAction(target, action) {
    if (action === 'svn-commit') {
      startSvnCommit();
      return true;
    }
    if (action === 'svn-confirm') {
      confirmSvnCommit();
      return true;
    }
    if (action === 'svn-log') {
      showSvnLog();
      return true;
    }
    if (action === 'history') {
      showHistoryPanel();
      return true;
    }
    if (action === 'diff') {
      diffWith('published');
      return true;
    }
    if (action === 'load-latest') {
      if (!isModified() || window.confirm('放弃本地修改并载入最新草稿/已发布版本？')) {
        loadDocumentFromServer().catch(function (error) {
          setStatus('载入失败：' + error.message);
        });
      }
      return true;
    }
    if (action === 'discard-draft') {
      discardDraft();
      return true;
    }
    if (action === 'panels-close') {
      var panels = ensurePanels();
      if (panels) {
        panels.hidden = true;
      }
      return true;
    }
    if (action === 'load-revision') {
      var revisionId = target.getAttribute('data-revision');
      if (!isModified() || window.confirm('用该版本覆盖编辑器内容？（未保存修改将丢失）')) {
        loadRevisionContent(revisionId);
      }
      return true;
    }
    if (action === 'diff-revision') {
      diffWith(target.getAttribute('data-revision'));
      return true;
    }
    return false;
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
      setStatus('已修改（Ctrl+S 保存）');
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
    updateOutlineActive();
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

  // ---------- 粘贴图片（写入文档同级 images/） ----------

  var IMAGE_MIME_FALLBACK = 'image/png';

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('读取图片失败')); };
      reader.readAsDataURL(file);
    });
  }

  function clipboardImageFiles(dataTransfer) {
    var files = [];
    if (!dataTransfer) {
      return files;
    }
    if (dataTransfer.items && dataTransfer.items.length) {
      Array.prototype.forEach.call(dataTransfer.items, function (item) {
        if (item.kind === 'file' && /^image\//i.test(item.type || '')) {
          var file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      });
    }
    if (!files.length && dataTransfer.files) {
      Array.prototype.forEach.call(dataTransfer.files, function (file) {
        if (/^image\//i.test(file.type || '')) {
          files.push(file);
        }
      });
    }
    return files;
  }

  function imageAltText(file) {
    var name = String((file && file.name) || '').replace(/\.[^.]+$/, '');
    return name || '图片';
  }

  function insertImageMarkdown(relativePath, altText) {
    insertBlock('![' + (altText || '图片') + '](' + relativePath + ')\n');
  }

  function insertEmbeddedImage(dataUrl, altText, note) {
    insertBlock('![' + (altText || '图片') + '](' + dataUrl + ')\n');
    setStatus(note);
  }

  function uploadImage(file, altText) {
    var type = file.type || IMAGE_MIME_FALLBACK;
    var alt = altText || imageAltText(file);
    if (file.size > 8 * 1024 * 1024) {
      setStatus('图片过大（上限 8 MB）：' + (file.name || ''));
      return Promise.reject(new Error('图片过大'));
    }
    if (state.localMode) {
      return readFileAsDataUrl(file).then(function (dataUrl) {
        insertEmbeddedImage(dataUrl, alt, '本地模式：图片已内嵌为 data URL（未写入 images/ 目录）');
        return { embedded: true };
      });
    }
    if (!authAvailable()) {
      setStatus('请先用 SVN 账号登录后再粘贴图片：图片会保存到文档同级 images/ 并插入引用');
      return Promise.reject(new Error('需要登录后才能上传图片'));
    }
    setStatus('正在上传图片' + (file.name ? ' ' + file.name : '') + ' …');
    return readFileAsDataUrl(file).then(function (dataUrl) {
      return authApi('__md/image', {
        method: 'POST',
        body: JSON.stringify({ path: state.resource, type: type, data: dataUrl })
      });
    }).then(function (payload) {
      insertImageMarkdown(payload.path, alt);
      setStatus('已插入图片 ' + payload.path + '（序号 ' + payload.sequence + '）');
      return payload;
    }).catch(function (error) {
      var status = error && error.status;
      if (status === 401 || status === 403 || status === 404 || status === 501 || !status) {
        return readFileAsDataUrl(file).then(function (dataUrl) {
          insertEmbeddedImage(dataUrl, alt, '未登录或只读模式：图片已内嵌为 data URL（未写入 images/ 目录）');
          return { embedded: true };
        });
      }
      setStatus('图片上传失败：' + message(error));
      throw error;
    });
  }

  function handleImageFiles(files, altText) {
    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        return uploadImage(file, altText || imageAltText(file));
      });
    });
    return chain.catch(function () { /* 失败信息已在状态栏提示 */ });
  }

  // ---------- 撤销 / 恢复 ----------

  var HISTORY_LIMIT = 200;
  var OUTLINE_PREF = 'md2web:editor-outline';

  function historyReset(value) {
    state.history = [value];
    state.historyIndex = 0;
  }

  function historyRecord() {
    if (!state.textarea) {
      return;
    }
    var value = state.textarea.value;
    var stack = state.history || [];
    if (stack[state.historyIndex] === value) {
      return;
    }
    stack = stack.slice(0, (state.historyIndex || 0) + 1);
    stack.push(value);
    if (stack.length > HISTORY_LIMIT) {
      stack = stack.slice(stack.length - HISTORY_LIMIT);
    }
    state.history = stack;
    state.historyIndex = stack.length - 1;
  }

  function scheduleHistory() {
    window.clearTimeout(state.historyTimer);
    state.historyTimer = window.setTimeout(historyRecord, 400);
  }

  function applyHistory(index) {
    var stack = state.history || [];
    if (index < 0 || index >= stack.length) {
      return false;
    }
    state.historyIndex = index;
    state.textarea.value = stack[index];
    state.textarea.setSelectionRange(stack[index].length, stack[index].length);
    afterContentChanged(true);
    return true;
  }

  function undo() {
    if (state.historyTimer) {
      window.clearTimeout(state.historyTimer);
      historyRecord();
    }
    if (applyHistory((state.historyIndex || 0) - 1)) {
      setStatus('已撤销（Ctrl+Y 恢复）');
    } else {
      setStatus('没有可撤销的操作');
    }
  }

  function redo() {
    if (applyHistory((state.historyIndex || 0) + 1)) {
      setStatus('已恢复');
    } else {
      setStatus('没有可恢复的操作');
    }
  }

  // ---------- 大纲导航（快速跳转章节） ----------

  function collectHeadings() {
    var value = state.textarea ? state.textarea.value : '';
    var lines = value.split('\n');
    var headings = [];
    var offset = 0;
    var inFence = false;
    lines.forEach(function (line) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
      } else if (!inFence) {
        var match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (match) {
          headings.push({
            level: match[1].length,
            text: match[2].replace(/[*_`~]/g, '').trim(),
            start: offset,
            end: offset + line.length,
            line: headings.length
          });
        }
      }
      offset += line.length + 1;
    });
    return headings;
  }

  function refreshOutline() {
    if (!state.outline) {
      return;
    }
    state.headings = collectHeadings();
    if (!state.headings.length) {
      state.outline.innerHTML = '<p class="md-editor-outline-empty">当前文档没有标题（用 H1–H3 分级）</p>';
      return;
    }
    state.outline.innerHTML = state.headings.map(function (heading, index) {
      return '<button type="button" class="md-editor-outline-item level-' + heading.level + '"'
        + ' data-outline-index="' + index + '" title="' + escapeHtml(heading.text) + '">'
        + escapeHtml(heading.text) + '</button>';
    }).join('');
    updateOutlineActive();
  }

  function scheduleOutline() {
    window.clearTimeout(state.outlineTimer);
    state.outlineTimer = window.setTimeout(refreshOutline, 200);
  }

  function closeOutline() {
    if (state.outline) {
      state.outline.hidden = true;
    }
  }

  function toggleOutline() {
    if (!state.outline) {
      return;
    }
    if (state.outline.hidden) {
      refreshOutline();
      state.outline.hidden = false;
    } else {
      closeOutline();
    }
    try {
      window.localStorage.setItem(OUTLINE_PREF, state.outline.hidden ? '0' : '1');
    } catch (error) { /* 隐私模式忽略 */ }
  }

  function updateOutlineActive() {
    if (!state.outline || state.outline.hidden || !state.headings || !state.textarea) {
      return;
    }
    var caret = state.textarea.selectionStart || 0;
    var active = 0;
    state.headings.forEach(function (heading, index) {
      if (heading.start <= caret) {
        active = index;
      }
    });
    var items = state.outline.querySelectorAll('[data-outline-index]');
    Array.prototype.forEach.call(items, function (item) {
      var isActive = Number(item.getAttribute('data-outline-index')) === active;
      item.classList.toggle('is-active', isActive);
      if (isActive && item.scrollIntoView) {
        item.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function headingContentOffset(heading) {
    var pre = state.highlight;
    if (!pre) {
      return null;
    }
    try {
      var walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT, null);
      var consumed = 0;
      var node = walker.nextNode();
      while (node) {
        var length = node.nodeValue.length;
        if (heading.start <= consumed + length) {
          var range = document.createRange();
          range.setStart(node, Math.max(0, heading.start - consumed));
          range.setEnd(node, Math.max(0, heading.start - consumed));
          var rect = range.getBoundingClientRect();
          var preRect = pre.getBoundingClientRect();
          return rect.top - preRect.top + pre.scrollTop;
        }
        consumed += length;
        node = walker.nextNode();
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function gotoHeading(heading) {
    var textarea = state.textarea;
    if (!textarea || !heading) {
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(heading.start, heading.end);
    var offset = headingContentOffset(heading);
    if (offset !== null) {
      var top = Math.max(0, offset - textarea.clientHeight * 0.3);
      textarea.scrollTop = top;
      if (state.highlight) {
        state.highlight.scrollTop = top;
      }
    }
    updateMetrics();
    updateOutlineActive();
    setStatus('已跳到：' + heading.text);
  }

  function bindOutlineEvents() {
    if (!state.outline) {
      return;
    }
    state.outline.addEventListener('click', function (event) {
      var item = event.target.closest ? event.target.closest('[data-outline-index]') : null;
      if (!item) {
        return;
      }
      event.preventDefault();
      var index = Number(item.getAttribute('data-outline-index'));
      gotoHeading((state.headings || [])[index]);
    });
  }

  // ---------- 实时预览（marked + Prism + Mermaid + PacketDiag + KaTeX） ----------

  function documentBaseUrl() {
    var parts = String(state.resource || '').split('/');
    parts.pop();
    if (!parts.length) {
      return '';
    }
    return parts.map(encodeURIComponent).join('/') + '/';
  }

  function resolvePreviewAssets() {
    var preview = state.preview;
    if (!preview) {
      return;
    }
    var base = documentBaseUrl();
    if (!base) {
      return;
    }
    var nodes = preview.querySelectorAll('img[src], a[href]');
    Array.prototype.forEach.call(nodes, function (node) {
      var attribute = node.tagName === 'IMG' ? 'src' : 'href';
      var value = node.getAttribute(attribute) || '';
      if (!value || /^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(value)) {
        return;
      }
      node.setAttribute(attribute, base + value);
    });
  }

  function enhancePreview(token) {
    var preview = state.preview;
    if (!preview) {
      return;
    }
    resolvePreviewAssets();
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
        container.setAttribute('data-source', code.textContent);
        pre.parentNode.replaceChild(container, pre);
        mermaidNodes.push(container);
      } else if (name === 'packetdiag' && window.PacketDiag) {
        var figure = document.createElement('figure');
        figure.className = 'packetdiag-figure';
        figure.setAttribute('data-source', code.textContent);
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
    state.preview.innerHTML = window.Sanitize ? window.Sanitize.html(html) : html;
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
    scheduleHistory();
    if (state.outline && !state.outline.hidden) {
      scheduleOutline();
    }
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
      undo: function () { undo(); },
      redo: function () { redo(); },
      outline: function () { toggleOutline(); },
      'remote-diff': function () { showRemoteDiff(); },
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
    { action: 'undo', label: '↶', title: '撤销（Ctrl+Z）' },
    { action: 'redo', label: '↷', title: '恢复（Ctrl+Y / Ctrl+Shift+Z）' },
    { divider: true },
    { action: 'outline', label: '目录', title: '大纲导航：跳转到章节（Ctrl+Shift+H）' },
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
    { key: 'h', ctrl: true, shift: true, action: 'outline' },
    { key: 'z', ctrl: true, action: 'undo' },
    { key: 'z', ctrl: true, shift: true, action: 'redo' },
    { key: 'y', ctrl: true, action: 'redo' },
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
      if (handlePanelAction(target, action)) {
        return;
      }
      if (action) {
        applyAction(action);
      }
    });

    state.textarea.addEventListener('input', function () {
      afterContentChanged(false);
    });
    state.textarea.addEventListener('paste', function (event) {
      var files = clipboardImageFiles(event.clipboardData);
      if (!files.length) {
        return;
      }
      event.preventDefault();
      handleImageFiles(files, files.length === 1 ? imageAltText(files[0]) : '');
    });
    state.textarea.addEventListener('dragover', function (event) {
      if (clipboardImageFiles(event.dataTransfer).length) {
        event.preventDefault();
      }
    });
    state.textarea.addEventListener('drop', function (event) {
      var files = clipboardImageFiles(event.dataTransfer);
      if (!files.length) {
        return;
      }
      event.preventDefault();
      handleImageFiles(files, files.length === 1 ? imageAltText(files[0]) : '');
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

    bindOutlineEvents();

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
        if (state.outline && !state.outline.hidden) {
          closeOutline();
          return;
        }
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
      '<span class="md-editor-binding" data-editor-binding></span>',
      '<button type="button" data-editor-action="history">历史</button>',
      '<button type="button" data-editor-action="diff">差异</button>',
      '<button type="button" data-editor-action="load-latest">载入最新</button>',
      '<button type="button" data-editor-action="svn-commit">提交 SVN…</button>',
      '<button type="button" data-editor-action="svn-log">SVN 日志</button>',
      '<button type="button" data-editor-action="remote-diff" hidden>远端差异</button>',
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
      '<aside class="md-editor-outline" data-editor-outline aria-label="文档大纲"></aside>',
      '<div class="md-editor-pane md-editor-pane-source">',
      '<pre class="md-editor-highlight" aria-hidden="true"></pre>',
      '<textarea class="md-editor-text" spellcheck="false" aria-label="Markdown 源文本" wrap="soft"></textarea>',
      '</div>',
      '<div class="md-editor-divider" role="separator" aria-label="拖动调整分栏" title="拖动调整左右宽度"></div>',
      '<div class="md-editor-pane md-editor-pane-preview">',
      '<div class="markdown-section md-editor-preview"></div>',
      '</div>',
      '</div>',
      '<div class="md-editor-panels" data-editor-panels hidden>',
      '<div class="md-editor-panels-head">',
      '<strong data-editor-panels-title>版本差异</strong>',
      '<span class="md-editor-spacer"></span>',
      '<button type="button" data-editor-action="discard-draft">放弃草稿</button>',
      '<button type="button" data-editor-action="panels-close">关闭</button>',
      '</div>',
      '<div class="md-editor-diff" data-editor-diff hidden><pre></pre></div>',
      '<div class="md-editor-history-list" data-editor-history-list hidden></div>',
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
      '<li><code>Ctrl+Z</code> 撤销 · <code>Ctrl+Y</code>/<code>Ctrl+Shift+Z</code> 恢复 · <code>Ctrl+Shift+H</code> 大纲导航</li>',
      '<li>直接粘贴或拖入图片会自动上传到文档同级 <code>images/</code></li>',
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
    state.outline = overlay.querySelector('[data-editor-outline]');
    applySplit(loadSplit());
    bindOverlay();
  }

  function open(options) {
    state.localMode = !!(options && options.local);
    state.resource = currentResource();
    state.lastFocus = document.activeElement;
    state.fileHandle = null;
    var serverButtons = ['history', 'diff', 'load-latest', 'svn-commit', 'svn-log'];
    var saveButton = null;
    if (!state.overlay) {
      buildOverlay();
    }
    state.titleEl.textContent = displayPath(state.resource);
    state.modeEl.textContent = state.localMode ? '仅本地查看源码' : saveModeLabel();
    if (state.overlay) {
      saveButton = state.overlay.querySelector('[data-editor-action="save"]');
      if (saveButton) {
        saveButton.textContent = state.localMode ? '保存到本地' : '保存';
      }
      serverButtons.forEach(function (name) {
        var button = state.overlay.querySelector('[data-editor-action="' + name + '"]');
        if (button) {
          button.hidden = state.localMode;
        }
      });
    }
    state.original = '';
    state.textarea.value = '';
    state.highlight.innerHTML = '';
    state.preview.innerHTML = '';
    historyReset('');
    if (state.outline) {
      state.outline.hidden = window.localStorage && window.localStorage.getItem(OUTLINE_PREF) === '0';
      refreshOutline();
    }
    setStatus('正在读取源文档…');
    state.overlay.classList.add('is-open');
    document.body.classList.add('md-editor-open');
    state.overlay.focus();
    updateBindingLabel();
    if (state.localMode) {
      loadSource(state.resource).then(function (result) {
        state.resource = result.resource;
        state.titleEl.textContent = displayPath(state.resource);
        state.original = result.text;
        state.textarea.value = result.text;
        afterContentChanged(true);
        state.textarea.focus();
        setStatus('本地查看模式：可编辑与预览，保存到本地不会改动服务端文档。');
      }).catch(function (error) {
        setStatus('读取失败：' + message(error));
      });
      return;
    }
    if (state.resource === 'README.md') {
      // 首页由构建生成：只读预览，不提供保存/提交
      state.readOnlyHome = true;
      setStatus('站点首页由构建生成，无法编辑源文档；请从左侧目录打开 docs/md 下的文档。');
      loadSource(state.resource).then(function (result) {
        state.original = result.text;
        state.textarea.value = result.text;
        afterContentChanged(true);
        setStatus('站点首页由构建生成，无法编辑源文档；请从左侧目录打开 docs/md 下的文档。');
      }).catch(function (error) {
        setStatus('读取失败：' + message(error));
      });
      var homeCommit = state.overlay.querySelector('[data-editor-action="svn-commit"]');
      if (homeCommit) {
        homeCommit.hidden = true;
      }
      var homeLog = state.overlay.querySelector('[data-editor-action="svn-log"]');
      if (homeLog) {
        homeLog.hidden = true;
      }
      return;
    }
    state.readOnlyHome = false;
    var commitButton = state.overlay.querySelector('[data-editor-action="svn-commit"]');
    var logButton = state.overlay.querySelector('[data-editor-action="svn-log"]');
    if (commitButton) {
      commitButton.hidden = !authAvailable();
    }
    if (logButton) {
      logButton.hidden = !authAvailable();
    }
    if (authAvailable()) {
      loadDocumentFromServer().then(function () {
        state.textarea.focus();
        return refreshSyncStatus();
      }).then(function (status) {
        var button = state.overlay.querySelector('[data-editor-action="remote-diff"]');
        if (button) {
          button.hidden = !(status && status.needsMerge);
        }
        if (status && status.needsMerge) {
          setStatus('远端已有新版本（r' + (status.remoteRevision || '?') + '），你的草稿基于旧版本：请点「远端差异」查看后合并');
        }
      }).catch(function (error) {
        setStatus('读取服务端基线失败：' + message(error));
      });
      return;
    }
    loadSource(state.resource).then(function (result) {
      state.resource = result.resource;
      state.titleEl.textContent = displayPath(state.resource);
      state.original = result.text;
      state.textarea.value = result.text;
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

  window.MdEditor = {
    open: open,
    openLocal: function () { open({ local: true }); },
    download: download,
    save: save,
    close: close,
    uploadImage: uploadImage,
    undo: undo,
    redo: redo,
    headings: collectHeadings,
    gotoHeading: gotoHeading,
    toggleOutline: toggleOutline
  };
}());
