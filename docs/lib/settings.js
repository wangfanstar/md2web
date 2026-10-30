(function () {
  'use strict';

  var state = { overlay: null, config: null, busy: false, documents: null,
    docSort: { key: "mtime", dir: -1 }, tab: null };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function auth() {
    return window.SiteAuth || null;
  }

  function isAdmin() {
    var siteAuth = auth();
    return !!(siteAuth && siteAuth.isAdmin && siteAuth.isAdmin());
  }

  function snapshot() {
    var siteAuth = auth();
    return siteAuth && siteAuth.snapshot ? siteAuth.snapshot() : { available: false, fileMode: false, authenticated: false };
  }

  function api(path, options) {
    var siteAuth = auth();
    var headers = Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {});
    if (siteAuth && siteAuth.csrfToken()) {
      headers['X-CSRF-Token'] = siteAuth.csrfToken();
    }
    return fetch(path, Object.assign({}, options, { headers: headers })).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok || payload.ok === false) {
          if (siteAuth && siteAuth.handleResponse) siteAuth.handleResponse(response, payload);
          var error = new Error(payload.error || ('HTTP ' + response.status));
          error.status = response.status;
          error.code = payload.code || '';
          throw error;
        }
        return payload;
      });
    });
  }

  function setStatus(text, isError) {
    var element = state.overlay && state.overlay.querySelector('[data-settings-status]');
    if (element) {
      element.textContent = text || '';
      element.classList.toggle('is-error', !!isError);
    }
  }

  // ---------- 表单 ----------

  // 本弹窗只编辑仓库的少量字段，其余字段（来源类型、软链接目标、权限、分组等）
  // 保存时必须原样带回，否则整体保存会把本地/软链接仓库误当成 SVN 仓库。
  var REPO_PRESERVED_FIELDS = ['sourceMode', 'linkTarget', 'displayName', 'entrySlug',
    'group', 'readOnly', 'allowCommit'];

  function repoModeLabel(mode) {
    if (mode === 'symlink') {
      return '软链接';
    }
    if (mode === 'local') {
      return '本地文件夹';
    }
    return 'SVN 库';
  }

  function repositoryRow(repo) {
    var item = repo || { id: '', mount: '', url: '' };
    var sourceMode = item.sourceMode || 'svn';
    var svnMode = sourceMode === 'svn';
    var urlPlaceholder = svnMode ? 'SVN 地址 https://…' : repoModeLabel(sourceMode) + '（无 SVN 地址）';
    return [
      '<div class="settings-repo-row" data-repo-mode="' + escapeHtml(sourceMode) + '">',
      '<input type="text" data-repo="id" placeholder="id（如 hardware）" value="' + escapeHtml(item.id) + '">',
      '<input type="text" data-repo="mount" placeholder="docs 下的目录（如 md/硬件设计）" value="' + escapeHtml(item.mount) + '">',
      '<input type="text" data-repo="url" placeholder="' + escapeHtml(urlPlaceholder) + '"'
        + (svnMode ? '' : ' disabled') + ' value="' + escapeHtml(item.url || '') + '">',
      '<input type="text" data-repo="credential_group" placeholder="凭据分组（可选）" value="' + escapeHtml(item.credential_group || '') + '">',
      '<input type="number" min="0" step="30" data-repo="syncIntervalSeconds" placeholder="更新频率（秒，0=不同步）" value="'
        + escapeHtml(item.syncIntervalSeconds === null || item.syncIntervalSeconds === undefined ? '' : String(item.syncIntervalSeconds)) + '"'
        + (svnMode ? '' : ' disabled') + '>',
      '<span class="settings-repo-mode" title="来源类型">' + escapeHtml(repoModeLabel(sourceMode)) + '</span>',
      '<button type="button" data-settings-action="remove-repo" title="删除">×</button>',
      '</div>'
    ].join('');
  }

  function personalAiSection() {
    return '<section class="settings-section" data-settings-tab="ai"><p>所有用户统一使用管理员公共 AI 配置。在 AI 问答面板选择代码库；管理员可通过面板的配置入口管理 Claude 和 SVN 代码库。</p>' + (isAdmin() ? '<button type="button" data-settings-action="open-code-ai">管理公共 Claude 与代码库</button>' : '') + '</section>';
  }

  function availableTabs() {
    var body = state.overlay && state.overlay.querySelector('[data-settings-body]');
    if (!body) {
      return [];
    }
    var present = {};
    Array.prototype.forEach.call(body.querySelectorAll('[data-settings-tab]'), function (node) {
      present[node.getAttribute('data-settings-tab')] = true;
    });
    return TABS.filter(function (item) { return present[item.id]; });
  }

  function switchTab(id) {
    var body = state.overlay && state.overlay.querySelector('[data-settings-body]');
    if (!body) {
      return;
    }
    var tabs = availableTabs();
    var wanted = tabs.some(function (item) { return item.id === id; }) ? id : (tabs[0] && tabs[0].id);
    if (!wanted) {
      return;
    }
    state.tab = wanted;
    Array.prototype.forEach.call(body.querySelectorAll('[data-settings-tab]'), function (node) {
      node.hidden = node.getAttribute('data-settings-tab') !== wanted;
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-settings-tab-button]'), function (button) {
      var active = button.getAttribute('data-settings-tab-button') === wanted;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    var saveButton = state.overlay.querySelector('[data-settings-save]');
    if (saveButton) {
      saveButton.hidden = !(wanted === 'ai' || wanted === 'repo');
    }
    try {
      window.localStorage.setItem(TAB_STORAGE, wanted);
    } catch (error) { /* 隐私模式忽略 */ }
    if (wanted === 'query') {
      loadUsage();
      loadDocuments();
    }
  }

  function renderTabs() {
    var body = state.overlay && state.overlay.querySelector('[data-settings-body]');
    if (!body) {
      return;
    }
    var tabs = availableTabs();
    if (!tabs.length) {
      return;
    }
    var bar = body.querySelector('.settings-tabs');
    if (!bar) {
      bar = document.createElement('nav');
      bar.className = 'settings-tabs';
      bar.setAttribute('role', 'tablist');
      body.insertBefore(bar, body.firstChild);
    }
    bar.innerHTML = tabs.map(function (item) {
      return '<button type="button" role="tab" data-settings-tab-button="' + item.id + '"'
        + ' aria-selected="false">' + escapeHtml(item.label) + '</button>';
    }).join('');
    var saved = null;
    try {
      saved = window.localStorage.getItem(TAB_STORAGE);
    } catch (error) {
      saved = null;
    }
    switchTab(state.tab || saved || tabs[0].id);
  }

  function renderForm() {
    var overlay = state.overlay;
    var body = overlay.querySelector('[data-settings-body]');
    var siteAuth = auth();
    var info = snapshot();

    if (info.fileMode) {
      body.innerHTML = personalAiSection()
        + '<section class="settings-section"><h4>服务端设置</h4>'
        + '<p class="settings-note">离线浏览（file://）为只读模式，无法修改服务端配置。请通过'
        + ' <code>python serve.py</code> 启动认证服务后访问。</p></section>';
      overlay.querySelector('[data-settings-save]').hidden = true;
      renderTabs();
      return;
    }
    if (!info.available) {
      body.innerHTML = personalAiSection()
        + '<section class="settings-section"><h4>服务端设置</h4>'
        + '<p class="settings-note">当前是只读预览模式：服务端配置需要认证服务。</p>'
        + '<ol class="settings-steps">'
        + '<li><code>python -m pip install -r server/requirements.txt</code></li>'
        + '<li><code>python serve.py</code>（配置不存在会自动生成）</li>'
        + '<li>刷新页面后在本窗口用管理员账号登录，填写 SVN 认证路径与仓库映射</li>'
        + '</ol>'
        + '<p class="settings-note">默认管理员账号：<code>admin / admin</code>（首次登录后请尽快修改密码）。</p></section>';
      overlay.querySelector('[data-settings-save]').hidden = true;
      renderTabs();
      return;
    }
    if (!(siteAuth && siteAuth.isAdmin())) {
      body.innerHTML = personalAiSection()
        + '<section class="settings-section" data-settings-tab="account"><h4>服务端设置（管理员）</h4>'
        + '<p class="settings-note">SVN 认证路径、仓库映射与全站 AI 默认值需要管理员账号登录。</p>'
        + '<div class="settings-row-actions"><button type="button" data-settings-action="open-login">登录（本机管理员或 SVN 账号）</button></div>'
        + '<p class="settings-note">默认管理员账号 <code>admin / admin</code>（本机账号，仅本地编辑；合入 SVN 时再提供 SVN 账号）。</p></section>';
      overlay.querySelector('[data-settings-save]').hidden = true;
      renderTabs();
      return;
    }

    var config = state.config || {};
    var authConfig = config.auth || {};
    var sync = config.sync || {};
    body.innerHTML = personalAiSection() + [
      '<section class="settings-section" data-settings-tab="repo">',
      '<h4>SVN 认证路径</h4>',
      '<p class="settings-note">必须是<b>强制账号密码认证</b>的 SVN 路径（允许匿名访问的路径会被拒绝）。例如只读的 <code>/svn/accounts/auth-check/</code>。</p>',
      '<label>认证路径 URL<input type="text" data-config="auth.url" placeholder="https://svn.example.com/svn/accounts/auth-check/" value="' + escapeHtml(authConfig.url || '') + '"></label>',
      '<div class="settings-grid">',
      '<label>凭据分组<input type="text" data-config="auth.credential_group" value="' + escapeHtml(authConfig.credential_group || '') + '"></label>',
      '<label>会话时长（小时）<input type="number" step="1" min="1" data-config="auth.session_hours" value="' + escapeHtml(String(authConfig.session_hours || 8)) + '"></label>',
      '<label>闲置超时（分钟）<input type="number" step="5" min="5" data-config="auth.idle_minutes" value="' + escapeHtml(String(authConfig.idle_minutes || 30)) + '"></label>',
      '</div>',
      '<div class="settings-row-actions"><button type="button" data-settings-action="test-auth">测试认证路径</button></div>',
      '</section>',
      '<section class="settings-section" data-settings-tab="repo">',
      '<h4>仓库映射（docs 目录 ↔ SVN）</h4>',
      '<p class="settings-note">每个文件夹都可以单独映射到一个 SVN 库（可添加多条，按目录段最长前缀匹配，嵌套目录优先更具体的挂载点）。提交时按文档所在目录自动选择对应仓库。</p>',
      '<div data-settings-repos>' + (config.repositories || []).map(repositoryRow).join('') + '</div>',
      '<p class="settings-note">「更新频率（秒）」留空表示用下方「默认更新频率」；填 0 表示该库不自动同步。自动同步会跳过正在编辑（有活动草稿）的文档并提示合并。</p>',
      '<p class="settings-note">标注为「本地文件夹 / 软链接」的仓库没有 SVN 地址，其目标目录与权限请在「仓库配置」页维护；此处保存会原样保留这些仓库的来源类型与权限设置。</p>',
      '<div class="settings-row-actions"><button type="button" data-settings-action="add-repo">+ 添加映射</button><button type="button" data-settings-action="sync-now">立即同步 SVN 库</button></div>',
      '</section>',
      '<section class="settings-section" data-settings-tab="ai">',
      '<h4>服务器 Claude CLI</h4>',
      '<p class="settings-note">使用 Linux 服务账号已配置好的 claude，在 docs 目录传入所选目录和问题并收集回答。md2web 无需配置 API 地址、Key、服务商或模型。</p>',
      '<details class="settings-details" open><summary>AI 配置 JSON（配置文件 <code>ai</code> 段，可直接编辑）</summary>',
      '<p class="settings-note">下面就是服务器配置文件里的 <code>claude</code> 段内容：点「应用 JSON」把内容写回当前配置，再点右上角「保存配置」写入 JSON 文件。必须保留 <code>"enabled": true</code> 才会启用问答；命令、超时、目录与代码库也可在 AI 面板的「⚙ 配置」中维护。'
        + '文件位置：<code>docs/html/md2web_config.json</code>（站点目录，静态访问已屏蔽）与 <code>data/config-profiles/md2web_config.json</code>（私有副本）。</p>',
      '<textarea class="settings-json" data-ai-json rows="10" spellcheck="false"></textarea>',
      '<div class="settings-row-actions"><button type="button" data-settings-action="apply-ai-json">应用 JSON</button>'
        + '<button type="button" data-settings-action="reload-ai-json">重新读取</button></div>',
      '</details>',
      '</section>',
      usageSection(),
      documentsSection(),
      '<section class="settings-section" data-settings-tab="account">',
      '<h4>修改管理员密码</h4>',
      '<div class="settings-grid">',
      '<label>当前密码<input type="password" data-admin="current" autocomplete="off"></label>',
      '<label>新密码<input type="password" data-admin="password" autocomplete="off" placeholder="至少 5 位"></label>',
      '</div>',
      '<div class="settings-row-actions"><button type="button" data-settings-action="change-password">修改密码</button></div>',
      '</section>',
      '<section class="settings-section" data-settings-tab="repo">',
      '<h4>其他</h4>',
      '<div class="settings-grid">',
      '<label>同步凭据环境变量<input type="text" data-config="sync.credential_name" placeholder="如 MD2WEB_SVN_READONLY" value="' + escapeHtml(sync.credential_name || '') + '"></label>',
      '<label>默认更新频率（秒）<input type="number" step="10" min="10" data-config="sync.interval_seconds" value="' + escapeHtml(String(sync.interval_seconds || 120)) + '"></label>',
      '</div>',
      '</section>'
    ].join('');
    renderTabs();
    renderAiJson();
  }

  function aiJsonBox() {
    return state.overlay && state.overlay.querySelector('[data-ai-json]');
  }

  function renderAiJson() {
    var box = aiJsonBox();
    if (!box) {
      return;
    }
    var ai = (state.config && state.config.ai) || {};
    box.value = JSON.stringify({claude: ai.claude || {}}, null, 2);
  }

  function applyAiJson() {
    var box = aiJsonBox();
    if (!box) {
      return;
    }
    var parsed;
    try {
      parsed = JSON.parse(box.value || '{}');
    } catch (error) {
      setStatus('AI 配置 JSON 解析失败：' + error.message, true);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setStatus('AI 配置 JSON 必须是对象', true);
      return;
    }
    var allowed = ['claude'];
    var unknown = Object.keys(parsed).filter(function (key) { return allowed.indexOf(key) < 0; });
    if (unknown.length) {
      setStatus('AI 配置 JSON 含未知字段：' + unknown.join('、'), true);
      return;
    }
    state.config = state.config || {};
    state.config.ai = { claude: parsed.claude || {} };
    renderAiJson();
    setStatus('AI 配置 JSON 已应用，点「保存配置」写入配置文件');
  }

  function reloadAiJson() {
    renderAiJson();
    setStatus('已重新读取配置文件中的 AI 配置');
  }

  function usageSection() {
    var siteAuth = auth();
    if (!(siteAuth && siteAuth.isAdmin && siteAuth.isAdmin())) {
      return '';
    }
    return [
      '<section class="settings-section" data-settings-tab="query">',
      '<h4>使用情况（管理员）</h4>',
      '<p class="settings-note">按 IP 与账号查看登录记录、账号使用量、最近提交与在线会话；数据来自本机审计表，最多保留在数据库里。</p>',
      '<div class="settings-row-actions">',
      '<label class="settings-inline">统计天数<input type="number" min="1" max="90" value="7" data-usage-days></label>',
      '<button type="button" data-settings-action="load-usage">刷新使用情况</button>',
      '</div>',
      '<div class="settings-usage" data-admin-usage><p class="settings-note">点击「刷新使用情况」加载。</p></div>',
      '</section>'
    ].join('');
  }

  function usageTable(title, columns, rows) {
    if (!rows.length) {
      return '<div class="settings-usage-block"><strong>' + escapeHtml(title) + '</strong>'
        + '<p class="settings-note">暂无记录</p></div>';
    }
    return '<div class="settings-usage-block"><strong>' + escapeHtml(title) + '</strong>'
      + '<table class="settings-usage-table"><thead><tr>'
      + columns.map(function (column) { return '<th>' + escapeHtml(column) + '</th>'; }).join('')
      + '</tr></thead><tbody>'
      + rows.map(function (cells) {
        return '<tr>' + cells.map(function (cell) {
          return '<td>' + escapeHtml(cell === null || cell === undefined ? '' : String(cell)) + '</td>';
        }).join('') + '</tr>';
      }).join('')
      + '</tbody></table></div>';
  }

  function renderUsage(payload) {
    var host = state.overlay && state.overlay.querySelector('[data-admin-usage]');
    if (!host) {
      return;
    }
    var logins = (payload.logins || []).map(function (item) {
      return [item.client_ip || '未知', item.resource || '', item.result || '', item.count, formatTime(item.last_at)];
    });
    var users = (payload.users || []).map(function (item) {
      return [item.username, item.role === 'admin' ? '管理员' : '用户',
        item.last_login_at ? formatTime(item.last_login_at) : '未登录',
        item.drafts, item.revisions, item.operations, item.last_state || '', item.last_revision || ''];
    });
    var operations = (payload.operations || []).map(function (item) {
      return [formatTime(item.created_at), item.username || '', item.path || '', item.state || '',
        item.svn_revision || '', item.error_code || ''];
    });
    var sessions = (payload.sessions || []).map(function (item) {
      return [item.username || '', formatTime(item.created_at), formatTime(item.last_seen_at),
        formatTime(item.expires_at), (item.user_agent || '').slice(0, 40)];
    });
    var audit = (payload.audit || []).map(function (item) {
      return [formatTime(item.created_at), item.username || (item.role === 'admin' ? '管理员' : ''),
        item.action || '', item.resource || '', item.result || '', item.client_ip || ''];
    });
    var count = payload.userCount || { total: 0, disabled: 0 };
    host.innerHTML = [
      '<p class="settings-note">用户总数：<b>' + count.total + '</b>（停用 ' + count.disabled + '）'
        + ' · 在线会话：<b>' + sessions.length + '</b> · 仓库映射：<b>' + (payload.repositoryCount || 0) + '</b></p>',
      usageTable('登录记录（按 IP/账号/结果聚合，近 ' + (payload.days || 7) + ' 天）',
        ['IP', '账号', '结果', '次数', '最近一次'], logins),
      usageTable('账号使用情况', ['账号', '角色', '最后登录', '草稿', '版本', '提交次数', '最近提交状态', '最近版本'], users),
      usageTable('最近提交', ['时间', '账号', '文档', '状态', 'SVN 版本', '错误码'], operations),
      usageTable('详细操作记录（审计，最近 200 条）', ['时间', '账号', '操作', '对象', '结果', 'IP'], audit),
      usageTable('在线会话', ['账号', '登录时间', '最近活动', '过期时间', '浏览器'], sessions)
    ].join('');
  }

  function loadUsage() {
    var host = state.overlay && state.overlay.querySelector('[data-usage-days]');
    var days = host ? Number(host.value) || 7 : 7;
    setStatus('正在加载使用情况…');
    api('__admin/usage?days=' + encodeURIComponent(days)).then(function (payload) {
      renderUsage(payload);
      setStatus('已更新使用情况（近 ' + (payload.days || days) + ' 天）');
    }).catch(function (error) {
      setStatus('加载使用情况失败：' + error.message, true);
    });
  }

  function documentsSection() {
    var siteAuth = auth();
    if (!(siteAuth && siteAuth.isAdmin && siteAuth.isAdmin())) {
      return '';
    }
    return [
      '<section class="settings-section" data-settings-tab="query">',
      '<h4>文档统计（管理员）</h4>',
      '<p class="settings-note">每个文档的大小、更新时间与更新次数（更新次数来自已发布提交）；文件夹大小按层级累加；增删记录由服务后台每 10 秒扫描 docs/md 记录。点击表头可排序。</p>',
      '<div class="settings-row-actions">',
      '<button type="button" data-settings-action="load-documents">刷新文档统计</button>',
      '</div>',
      '<div class="settings-usage" data-admin-documents><p class="settings-note">点击「刷新文档统计」加载。</p></div>',
      '</section>'
    ].join('');
  }

  function sortDocuments(rows) {
    var sort = state.docSort || { key: 'mtime', dir: -1 };
    var key = sort.key;
    var dir = sort.dir || -1;
    return rows.slice().sort(function (left, right) {
      var a = left[key];
      var b = right[key];
      if (typeof a === 'string' || typeof b === 'string') {
        a = String(a === null || a === undefined ? '' : a);
        b = String(b === null || b === undefined ? '' : b);
        return a.localeCompare(b, 'zh-Hans-CN') * dir;
      }
      a = Number(a || 0);
      b = Number(b || 0);
      return (a - b) * dir;
    });
  }

  function formatBytes(value) {
    var size = Number(value || 0);
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function formatTime(value) {
    if (!value) return '';
    if (typeof value === 'number') {
      return new Date(value * 1000).toLocaleString('zh-CN', { hour12: false });
    }
    var text = String(value);
    var parsed = new Date(text);
    if (!isNaN(parsed.getTime())) {
      return parsed.toLocaleString('zh-CN', { hour12: false });
    }
    return text;
  }

  function sortableHeader(label, key) {
    var sort = state.docSort || {};
    var marker = sort.key === key ? (sort.dir === -1 ? ' ▼' : ' ▲') : '';
    return '<th><button type="button" class="settings-sort" data-doc-sort="' + key + '">'
      + escapeHtml(label + marker) + '</button></th>';
  }

  function renderDocuments() {
    var host = state.overlay && state.overlay.querySelector('[data-admin-documents]');
    if (!host || !state.documents) {
      return;
    }
    var payload = state.documents;
    var rows = sortDocuments(payload.documents || []);
    var documents = rows.map(function (item) {
      return [item.path, formatBytes(item.size), formatTime(item.mtime), item.updates,
        formatTime(item.lastCommitAt), item.lastRevision === null || item.lastRevision === undefined ? '' : item.lastRevision];
    });
    var folders = (payload.folders || []).map(function (item) {
      return [item.path, formatBytes(item.size), item.files];
    });
    var events = (payload.events || []).map(function (item) {
      return [formatTime(item.created_at), item.kind === 'added' ? '新增' : (item.kind === 'removed' ? '删除' : '修改'),
        item.path, item.size === null || item.size === undefined ? '' : formatBytes(item.size)];
    });
    var documentTable = '<div class="settings-usage-block"><strong>文档（共 '
      + (payload.totalDocuments || 0) + ' 个，合计 ' + formatBytes(payload.totalBytes) + '）</strong>'
      + '<table class="settings-usage-table"><thead><tr>'
      + sortableHeader('文档', 'path')
      + sortableHeader('大小', 'size')
      + sortableHeader('更新时间', 'mtime')
      + sortableHeader('更新次数', 'updates')
      + '<th>最近提交</th><th>版本</th>'
      + '</tr></thead><tbody>'
      + (documents.length ? documents.map(function (cells) {
        return '<tr>' + cells.map(function (cell) {
          return '<td>' + escapeHtml(cell === null || cell === undefined ? '' : String(cell)) + '</td>';
        }).join('') + '</tr>';
      }).join('') : '<tr><td colspan="6">暂无文档</td></tr>')
      + '</tbody></table></div>';
    host.innerHTML = documentTable
      + usageTable('文件夹大小（含子目录）', ['文件夹', '大小', '文档数'], folders)
      + usageTable('文档增删记录（最近 200 条）', ['时间', '类型', '路径', '大小'], events);
  }

  function loadDocuments() {
    setStatus('正在加载文档统计…');
    api('__admin/documents').then(function (payload) {
      state.documents = payload;
      renderDocuments();
      setStatus('已更新文档统计（' + (payload.totalDocuments || 0) + ' 个文档）');
    }).catch(function (error) {
      setStatus('加载文档统计失败：' + error.message, true);
    });
  }

  function syncNow() {
    setStatus('正在同步 SVN 库（跳过正在编辑的文档）…');
    api('__admin/sync', { method: 'POST', body: JSON.stringify({}) }).then(function (payload) {
      var results = payload.results || [];
      if (!results.length) {
        setStatus('没有到期的仓库（或未配置仓库映射）');
        return;
      }
      var lines = results.map(function (item) {
        if (item.error) {
          return item.binding + '：失败（' + item.error + '）';
        }
        return item.binding + '：r' + (item.revision || '?')
          + '，更新 ' + ((item.files || []).length) + ' 个文件'
          + ((item.conflicts || []).length ? '，冲突 ' + item.conflicts.length + ' 个（正在编辑，未覆盖）' : '');
      });
      setStatus('同步完成：' + lines.join('；'));
    }).catch(function (error) {
      setStatus('同步失败：' + error.message, true);
    });
  }

  function savedRepositories() {
    var map = {};
    ((state.config && state.config.repositories) || []).forEach(function (item) {
      if (item && item.id) {
        map[String(item.id).trim()] = item;
      }
    });
    return map;
  }

  function readConfig() {
    var overlay = state.overlay;
    var config = JSON.parse(JSON.stringify(state.config || {}));
    function field(name) {
      var input = overlay.querySelector('[data-config="' + name + '"]');
      return input ? input.value.trim() : '';
    }
    config.auth = config.auth || {};
    config.auth.url = field('auth.url');
    config.auth.credential_group = field('auth.credential_group') || 'default';
    config.auth.session_hours = Number(field('auth.session_hours')) || 8;
    config.auth.idle_minutes = Number(field('auth.idle_minutes')) || 30;
    config.ai = config.ai || {};
    config.sync = config.sync || {};
    config.sync.credential_name = field('sync.credential_name');
    config.sync.interval_seconds = Number(field('sync.interval_seconds')) || 120;
    var saved = savedRepositories();
    config.repositories = Array.prototype.slice.call(overlay.querySelectorAll('.settings-repo-row')).map(function (row) {
      function rowValue(name) {
        var input = row.querySelector('[data-repo="' + name + '"]');
        return input ? String(input.value || '').trim() : '';
      }
      var id = rowValue('id');
      var repo = {};
      var previous = saved[id];
      if (previous) {
        // 保留本弹窗不编辑的字段：来源类型/软链接目标/权限/分组等。
        REPO_PRESERVED_FIELDS.forEach(function (name) {
          if (previous[name] !== undefined && previous[name] !== null) {
            repo[name] = previous[name];
          }
        });
      }
      repo.id = id;
      repo.mount = rowValue('mount');
      repo.url = rowValue('url');
      repo.credential_group = rowValue('credential_group');
      repo.sourceMode = repo.sourceMode || 'svn';
      repo.syncIntervalSeconds = (function () {
        var value = rowValue('syncIntervalSeconds');
        return value === '' ? null : Number(value);
      }());
      return repo;
    }).filter(function (repo) { return repo.id || repo.mount || repo.url; });
    return config;
  }

  function loadConfig() {
    setStatus('正在读取配置…');
    return api('__config').then(function (payload) {
      state.config = payload.config;
      renderForm();
      setStatus('');
      return payload;
    }).catch(function (error) {
      setStatus('读取配置失败：' + error.message, true);
    });
  }

  function saveConfig() {
    if (state.busy) {
      return;
    }
    var payload = readConfig();
    state.busy = true;
    setStatus('正在保存并应用…');
    api('__config', { method: 'PUT', body: JSON.stringify(payload) }).then(function (result) {
      state.config = result.config;
      var siteAuth = auth();
      if (siteAuth && siteAuth.refresh) {
        siteAuth.refresh();
      }
      renderForm();
      setStatus('已保存并生效' + (result.authConfigured ? '：SVN 登录已可用' : '：SVN 认证路径仍为空'));
    }).catch(function (error) {
      if (error.code === 'config_conflict') {
        // 配置在别处被改动过：自动重新读取，用户再点一次「保存配置」即可。
        loadConfig().then(function () {
          setStatus('保存失败：' + error.message + '（已重新读取配置，请再点一次「保存配置」）', true);
        });
        return;
      }
      setStatus('保存失败：' + error.message, true);
    }).then(function () {
      state.busy = false;
    });
  }

  function testAuth() {
    var overlay = state.overlay;
    var url = overlay.querySelector('[data-config="auth.url"]').value.trim();
    setStatus('正在测试认证路径…');
    api('__config/test-auth', { method: 'POST', body: JSON.stringify({ url: url }) }).then(function (payload) {
      setStatus('认证路径可用：' + (payload.result.message || '可以登录'));
    }).catch(function (error) {
      setStatus('认证路径不可用：' + error.message, true);
    });
  }

  function changePassword() {
    var overlay = state.overlay;
    var current = overlay.querySelector('[data-admin="current"]').value;
    var next = overlay.querySelector('[data-admin="password"]').value;
    setStatus('正在修改密码…');
    api('__admin/password', { method: 'POST', body: JSON.stringify({ current: current, password: next }) }).then(function () {
      overlay.querySelector('[data-admin="current"]').value = '';
      overlay.querySelector('[data-admin="password"]').value = '';
      setStatus('管理员密码已修改');
    }).catch(function (error) {
      setStatus('修改密码失败：' + error.message, true);
    });
  }

  // ---------- 界面 ----------

  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.className = 'settings-dialog';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', '服务设置');
    overlay.innerHTML = [
      '<div class="settings-backdrop" data-settings-close></div>',
      '<section class="settings-panel">',
      '<header class="settings-head">',
      '<span class="settings-title">服务设置</span>',
      '<span class="settings-badge" data-settings-badge></span>',
      '<span class="settings-spacer"></span>',
      '<button type="button" data-settings-action="reload">重新读取</button>',
      '<button type="button" data-settings-save>保存配置</button>',
      '<button type="button" data-settings-close>关闭</button>',
      '</header>',
      '<div class="settings-body" data-settings-body></div>',
      '<div class="settings-status" data-settings-status></div>',
      '</section>'
    ].join('');
    document.body.appendChild(overlay);
    state.overlay = overlay;
    bindOverlay();
  }

  function bindOverlay() {
    var overlay = state.overlay;
    overlay.addEventListener('click', function (event) {
      var target = event.target;
      var action = target.getAttribute && target.getAttribute('data-settings-action');
      if (target.hasAttribute && target.hasAttribute('data-settings-close')) {
        close();
        return;
      }
      if (action === 'open-login') {
        close();
        if (window.SiteAuth) {
          window.SiteAuth.openLogin();
        }
      } else if (action === 'open-code-ai') {
        window.AIAssistant.openConfig();
      } else if (action === 'apply-ai-json') {
        applyAiJson();
      } else if (action === 'reload-ai-json') {
        reloadAiJson();
      } else if (action === 'reload') {
        loadConfig();
      } else if (action === 'add-repo') {
        var holder = overlay.querySelector('[data-settings-repos]');
        holder.insertAdjacentHTML('beforeend', repositoryRow());
      } else if (action === 'remove-repo') {
        var row = target.closest('.settings-repo-row');
        if (row) {
          row.remove();
        }
      } else if (action === 'test-auth') {
        testAuth();
      } else if (action === 'load-usage') {
        loadUsage();
      } else if (target.getAttribute && target.getAttribute('data-settings-tab-button')) {
        switchTab(target.getAttribute('data-settings-tab-button'));
      } else if (action === 'sync-now') {
        syncNow();
      } else if (action === 'load-documents') {
        loadDocuments();
      } else if (target.getAttribute && target.getAttribute('data-doc-sort')) {
        var key = target.getAttribute('data-doc-sort');
        var sort = state.docSort || { key: 'mtime', dir: -1 };
        state.docSort = { key: key, dir: sort.key === key ? -sort.dir : -1 };
        renderDocuments();
      } else if (action === 'change-password') {
        changePassword();
      }
    });
    overlay.querySelector('[data-settings-save]').addEventListener('click', saveConfig);
    overlay.addEventListener('submit', function (event) {
      event.preventDefault();
      var form = event.target;
      if (!form.hasAttribute('data-settings-admin-form')) {
        return;
      }
      var siteAuth = auth();
      setStatus('正在验证管理员账号…');
      siteAuth.login(form.adminUser.value.trim(), form.adminPassword.value, 'admin').then(function () {
        setStatus('管理员登录成功');
        loadConfig();
      }).catch(function (error) {
        setStatus('管理员登录失败：' + error.message, true);
      });
    });
  }

  function updateBadge() {
    if (!state.overlay) {
      return;
    }
    var info = snapshot();
    var badge = state.overlay.querySelector('[data-settings-badge]');
    if (!info.available) {
      badge.textContent = '只读预览';
    } else if (siteIsAdmin(info)) {
      badge.textContent = '管理员 ' + ((info.user && info.user.username) || '');
    } else {
      badge.textContent = '需要管理员登录';
    }
  }

  function siteIsAdmin(info) {
    return !!(info && info.authenticated && info.role === 'admin');
  }

  function open() {
    window.location.href = 'html/md2web_config.html';
  }

  function close() {
    if (state.overlay) {
      state.overlay.classList.remove('is-open');
    }
  }

  function init() {
    document.addEventListener('siteauth:change', function () {
      updateBadge();
      if (state.overlay && state.overlay.classList.contains('is-open')) {
        var info = snapshot();
        if (info.available && siteIsAdmin(info) && !state.config) {
          loadConfig();
        } else if (!siteIsAdmin(info)) {
          state.config = null;
          renderForm();
        }
      }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.overlay && state.overlay.classList.contains('is-open')) {
        close();
      }
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.Settings = { open: open, close: close, load: loadConfig, save: saveConfig };
}());
