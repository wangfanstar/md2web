(function () {
  'use strict';

  if (!window.AIRetrieval) {
    return;
  }

  var STORAGE_KEY = 'md2web:ai-config';
  var GUEST_STORAGE_KEY = 'md2web:ai-config:guest';
  var configIdentity = '', configEpoch = 0, configReady = false, configLoad = Promise.resolve(), saveQueue = Promise.resolve(), hasPersonalConfig=false, publicSignature='', legacyImportPending=false;

  function accountIdentity() {
    var user = window.SiteAuth && SiteAuth.snapshot().user;
    return user ? String(user.id || (user.authSourceId || '') + ':' + user.username) : '';
  }
  function syncPersonalConfig() {
    try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(GUEST_STORAGE_KEY); } catch (_) {}
    state.config = defaults(); configReady = true;
    if (!isAdmin() && state.configOverlay) closeConfig();
    return Promise.resolve(true);
  }


  var HISTORY_LIMIT = 8;
  var UPLOAD_FILE_LIMIT = 256 * 1024;
  var UPLOAD_TOTAL_LIMIT = 512 * 1024;
  var DEFAULT_SYSTEM = '你是文档站助手。只依据「参考资料」回答问题，给出简洁准确的中文回答；资料不足时明确说明，不要编造。回答末尾无需重复资料清单。';

  var PROVIDERS = {
    openai: {
      label: 'OpenAI 兼容（OpenAI/DeepSeek/Moonshot/vLLM/one-api…）',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      style: 'openai'
    },
    deepseek: {
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat',
      style: 'openai'
    },
    ollama: {
      label: 'Ollama（本机，无需 Key）',
      baseUrl: 'http://127.0.0.1:11434/v1/chat/completions',
      model: 'qwen2.5:7b',
      style: 'openai'
    },
    anthropic: {
      label: 'Anthropic Claude',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      model: 'claude-3-5-sonnet-latest',
      style: 'anthropic'
    },
    custom: { label: '自定义（OpenAI 兼容）', baseUrl: '', model: '', style: 'openai' }
  };

  var state = {
    overlay: null,
    configOverlay: null,
    messagesEl: null,
    statusEl: null,
    inputEl: null,
    config: null,
    messages: [],
    corpusBase: null,
    corpusPromise: null,
    busy: false
  };

  function serverAiDefaults() {
    return (window.SiteAuth && window.SiteAuth.aiDefaults && window.SiteAuth.aiDefaults()) || null;
  }

  function isAdmin() {
    var siteAuth = window.SiteAuth;
    return !!(siteAuth && siteAuth.isAdmin && siteAuth.isAdmin());
  }

  function defaults() {
    var external = window.AI_ASSISTANT_CONFIG || {};
    var base = {
      provider: 'openai',
      baseUrl: PROVIDERS.openai.baseUrl,
      model: PROVIDERS.openai.model,
      apiKey: '',
      temperature: 0.2,
      contextChars: 6000,
      systemPrompt: DEFAULT_SYSTEM,
      useProxy: 'auto',
      sourcePath: '',
      scope: [],
      uploads: []
    };
    // 服务端设置（管理员在「设置」中配置）优先于内置默认值，浏览器本地配置优先级最高
    var server = serverAiDefaults();
    if (server) {
      Object.keys(PROVIDERS).forEach(function (name) {
        if (server.provider === name) {
          base.provider = name;
        }
      });
      if (server.baseUrl) {
        base.baseUrl = server.baseUrl;
      }
      if (server.model) {
        base.model = server.model;
      }
      if (server.apiKey) {
        base.apiKey = server.apiKey;
      }
      if (server.useProxy) {
        base.useProxy = server.useProxy;
      }
      if (server.contextChars) {
        base.contextChars = server.contextChars;
      }
      if (server.sourcePath) {
        base.sourcePath = server.sourcePath;
      }
      if (server.temperature !== undefined && server.temperature !== null && server.temperature !== '') {
        base.temperature = Number(server.temperature);
      }
      if (server.systemPrompt) {
        base.systemPrompt = server.systemPrompt;
      }
    }
    Object.keys(PROVIDERS).forEach(function (name) {
      if (external.provider === name) {
        base.provider = name;
      }
    });
    return Object.assign(base, external);
  }

  function loadConfig() { return defaults(); }


  function persistConfig() {
    if (!isAdmin()) return Promise.resolve(false);
    return fetch('__admin/ai', {method:'PUT', credentials:'same-origin', headers:{'Content-Type':'application/json','X-CSRF-Token':SiteAuth.csrfToken()},body:JSON.stringify(state.config)})
      .then(function(r){if(!r.ok)throw new Error('公共配置保存失败');return true;});
  }


  function configured() { return !!accountIdentity() && location.protocol !== 'file:'; }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function message(error) {
    return error && error.message ? error.message : String(error);
  }

  // ---------- 离线检索 ----------

  function currentRoute() {
    var hash = String(window.location.hash || '#/').replace(/^#/, '').split('?')[0];
    try {
      return decodeURIComponent(hash);
    } catch (error) {
      return hash;
    }
  }

  function loadCorpus() {
    if (state.corpusPromise) {
      return state.corpusPromise;
    }
    var offline = window.__DOCSIFY_OFFLINE_DATA__;
    if (offline && ((offline.searchIndex && Object.keys(offline.searchIndex).length) || offline.content)) {
      state.corpusBase = window.AIRetrieval.buildCorpus({ searchIndex: offline.searchIndex, content: offline.content });
      state.corpusPromise = Promise.resolve(state.corpusBase);
      return state.corpusPromise;
    }
    state.corpusPromise = fetch('html/search-index.json', { cache: 'no-cache' }).then(function (response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      return response.json();
    }).then(function (index) {
      state.corpusBase = window.AIRetrieval.buildCorpus({ searchIndex: index });
      return state.corpusBase;
    }).catch(function (error) {
      state.corpusBase = { sections: [], documentFrequency: {}, size: 0 };
      if (window.console && console.warn) {
        console.warn('AI 助手：无法读取文档索引', error);
      }
      return state.corpusBase;
    });
    return state.corpusPromise;
  }

  function mergedCorpus() {
    return window.AIRetrieval.mergeCorpus(
      state.corpusBase,
      window.AIRetrieval.buildFromUploads(state.config.uploads || [])
    );
  }

  function retrieve(question, limit) {
    return loadCorpus().then(function () {
      var corpus = mergedCorpus();
      var scope = state.config.scope || [];
      var hits = window.AIRetrieval.search(corpus, question, { limit: limit || 5, scope: scope });
      hits.forEach(function (hit) { hit.query = question; });
      var route = currentRoute();
      var samePage = corpus.sections.filter(function (section) {
        return section.route === route && window.AIRetrieval.inScope(section, scope);
      }).slice(0, 2).map(function (section) {
        return { section: section, score: 0.1, query: question };
      });
      samePage.forEach(function (hit) {
        if (!hits.some(function (item) { return item.section.slug === hit.section.slug; })) {
          hits.push(hit);
        }
      });
      return hits;
    });
  }

  // ---------- 请求组装与流式解析 ----------

  function renderMarkdown(text) {
    if (!window.marked) {
      return escapeHtml(text).replace(/\n/g, '<br>');
    }
    try {
      return window.marked.parse(text, { gfm: true, breaks: false });
    } catch (error) {
      return escapeHtml(text);
    }
  }

  function safeMarkdown(text) {
    var html = renderMarkdown(text);
    return window.Sanitize ? window.Sanitize.html(html) : html;
  }

  function enhance(root) {
    if (!root) {
      return;
    }
    if (window.Prism && Prism.highlightAllUnder) {
      Prism.highlightAllUnder(root);
    }
    if (window.MathRender && window.MathRender.render) {
      window.MathRender.render(root);
    }
  }

  function setStatus(text) {
    var targets = [state.statusEl, state.configOverlay && state.configOverlay.querySelector('[data-ai-config-status]')];
    targets.forEach(function (element) {
      if (element) {
        element.textContent = text || '';
      }
    });
  }

  function appendMessage(role, content) {
    var bubble = document.createElement('div');
    bubble.className = 'ai-message ai-message-' + role;
    bubble.innerHTML = role === 'user' ? escapeHtml(content).replace(/\n/g, '<br>') : safeMarkdown(content);
    state.messagesEl.appendChild(bubble);
    state.messagesEl.scrollTop = state.messagesEl.scrollHeight;
    if (role === 'assistant') {
      enhance(bubble);
    }
    return bubble;
  }

  function appendSources(hits) {
    var sources = window.AIRetrieval.listSources(hits);
    if (!sources.length) {
      return;
    }
    var box = document.createElement('div');
    box.className = 'ai-sources';
    sources.forEach(function (item) {
      var link = document.createElement('a');
      link.className = 'ai-source';
      if (item.upload) {
        var upload = (state.config.uploads || []).filter(function (entry) { return item.route === 'upload://' + entry.name; })[0];
        link.href = upload ? URL.createObjectURL(new Blob([upload.text], { type: 'text/markdown;charset=utf-8' })) : '#';
        link.target = '_blank';
        link.rel = 'noopener';
        link.title = '上传文档（本地）';
      } else {
        link.href = '#' + item.slug;
        link.addEventListener('click', function () {
          closePanel();
        });
      }
      link.textContent = item.label;
      box.appendChild(link);
    });
    state.messagesEl.appendChild(box);
    state.messagesEl.scrollTop = state.messagesEl.scrollHeight;
  }

  function ask(question) {
    var text = String(question || '').trim();
    if (!text || state.busy) return Promise.resolve();
    if (!state.overlay) buildOverlay();
    if (location.protocol === 'file:') { setStatus('离线页面无法问答，请打开服务器站点'); return Promise.resolve(); }
    if (!accountIdentity()) { setStatus('请先登录后使用公共 AI 问答'); return Promise.resolve(); }
    appendMessage('user', text); state.inputEl.value = ''; state.busy = true;
    var bubble = appendMessage('assistant', '正在检索并请求 Claude…');
    var selected = state.overlay.querySelector('[data-code-repository]');
    return fetch('__ai/chat', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':SiteAuth.csrfToken()},
      body:JSON.stringify({messages:state.messages.slice(-8).concat([{role:'user',content:text}]),codeRepositoryId:selected ? selected.value : ''})})
       .then(function(r){
        if(!r.ok)return r.json().then(function(data){throw new Error(data.message||data.error);});
        var reader=r.body.getReader(),decoder=new TextDecoder(),buffer='',result=null;
        function pump(){return reader.read().then(function(part){
          buffer+=decoder.decode(part.value||new Uint8Array(),{stream:!part.done});
          var split;while((split=buffer.indexOf('\n\n'))>=0){var event=buffer.slice(0,split);buffer=buffer.slice(split+2);var kind=/event: (.*)/.exec(event),data=/data: (.*)/.exec(event);if(!data)continue;var value=JSON.parse(data[1]);
            if(kind&&kind[1]==='start')state.jobId=value.jobId;
            if(kind&&kind[1]==='error')throw new Error(value.message);
            if(kind&&kind[1]==='complete')result=value;
          }
          if(part.done){if(!result)throw new Error('问答连接中断');return result;}return pump();
        });}return pump();
      })
      .then(function(data){bubble.innerHTML=safeMarkdown(data.answer);enhance(bubble);
        var source=document.createElement('p');source.textContent='代码库 '+data.repository+' @ r'+data.revision+'；来源：'+data.sources.join('、');bubble.appendChild(source);
        state.messages.push({role:'user',content:text},{role:'assistant',content:data.answer});persistMessages();setStatus('');})
      .catch(function(e){bubble.textContent='请求失败：'+message(e);}).then(function(){state.busy=false;state.jobId=null;});
  }


  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.className = 'ai-assistant';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'AI 文档助手');
    overlay.innerHTML = [
      '<div class="ai-assistant-backdrop" data-ai-close></div>',
      '<section class="ai-panel">',
      '<header class="ai-head">',
      '<span class="ai-title">AI 文档助手</span>',
      '<span class="ai-badge" data-ai-badge></span>',
      '<span class="ai-head-spacer"></span>',
      '<button type="button" data-ai-action="config" title="AI 配置">⚙ 配置</button>',
      '<button type="button" data-ai-action="history">历史</button>',
      '<button type="button" data-ai-action="newChat">新对话</button>',
      '<button type="button" data-ai-cancel>取消请求</button>',
      '<button type="button" data-ai-action="clear">清空</button>',
      '<button type="button" data-ai-action="close">关闭</button>',
      '</header>',
      '<label>代码库 <select data-code-repository><option value="">管理员默认代码库</option></select></label>',
      '<div class="ai-messages" data-ai-messages></div>',
      '<div class="ai-status" data-ai-status></div>',
      '<div class="ai-actions">',
      '<button type="button" data-ai-quick="总结本页">总结本页</button>',
      '<button type="button" data-ai-quick="这篇文档讲了什么？">文档概览</button>',
      '<button type="button" data-ai-quick="解释选中的内容">解释选中</button>',
      '</div>',
      '<div class="ai-history" data-ai-history hidden></div>',
      '<div class="ai-compose">',
      '<textarea rows="2" placeholder="就文档内容提问（Ctrl+Enter 发送）" data-ai-input></textarea>',
      '<button type="button" data-ai-action="send">发送</button>',
      '</div>',
      '</section>'
    ].join('');
    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.messagesEl = overlay.querySelector('[data-ai-messages]');
    state.statusEl = overlay.querySelector('[data-ai-status]');
    state.inputEl = overlay.querySelector('[data-ai-input]');
    bindOverlay();
  }

  function bindOverlay() {
    var overlay = state.overlay;
    overlay.addEventListener('click', function (event) {
      var target = event.target;
      var action = target.getAttribute && target.getAttribute('data-ai-action');
      var quick = target.getAttribute && target.getAttribute('data-ai-quick');
      if (target.hasAttribute && target.hasAttribute('data-ai-close')) {
        closePanel();
        return;
      }
      if (quick) {
        if (quick === '解释选中的内容') {
          var selection = String(window.getSelection ? window.getSelection().toString() : '').trim();
          ask(selection ? '请结合文档解释以下内容：' + selection : '请解释本文档的核心概念');
          return;
        }
        ask(quick);
        return;
      }
      if (action === 'config') {
        openConfig();
      } else if (action === 'history') {
        toggleHistory();
      } else if (action === 'newChat') {
        startConversation();
      } else if (action === 'close') {
        closePanel();
      } else if (action === 'send') {
        ask(state.inputEl.value);
      } else if (action === 'clear') {
        state.messages = [];
        state.messagesEl.innerHTML = '';
        var conversation = activeConversation();
        if (conversation) {
          conversation.messages = [];
        }
        saveHistoryStore();
        renderHistory();
        setStatus('已清空当前对话（历史记录保留）');
      }
    });
    overlay.addEventListener('click', function (event) {
      var historyId = event.target.getAttribute && event.target.getAttribute('data-ai-history-id');
      var historyDelete = event.target.getAttribute && event.target.getAttribute('data-ai-history-delete');
      if (historyDelete) {
        deleteConversation(historyDelete);
        return;
      }
      if (historyId) {
        switchConversation(historyId);
      }
    });
    state.inputEl.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        ask(state.inputEl.value);
      }
    });
  }

  // ---------- 对话历史（本机 localStorage） ----------

  var HISTORY_KEY = 'md2web:ai-conversations';
  var HISTORY_LIMIT = 20;
  var HISTORY_MESSAGES = 60;

  function loadHistoryStore() {
    try {
      var parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || 'null');
      if (parsed && Array.isArray(parsed.conversations)) {
        return parsed;
      }
    } catch (error) { /* 忽略损坏数据 */ }
    return { conversations: [], activeId: '' };
  }

  function saveHistoryStore() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify({
        conversations: state.conversations.slice(-HISTORY_LIMIT),
        activeId: state.activeId
      }));
    } catch (error) {
      if (window.console && console.warn) {
        console.warn('AI 对话历史保存失败（可能超出配额）', error);
      }
    }
  }

  function activeConversation() {
    return state.conversations.filter(function (item) { return item.id === state.activeId; })[0] || null;
  }

  function ensureConversation() {
    var current = activeConversation();
    if (current) {
      return current;
    }
    return startConversation();
  }

  function startConversation() {
    var now = new Date().toISOString();
    var conversation = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: '新对话', createdAt: now, updatedAt: now, messages: [] };
    state.conversations.push(conversation);
    state.conversations = state.conversations.slice(-HISTORY_LIMIT);
    state.activeId = conversation.id;
    state.messages = conversation.messages;
    saveHistoryStore();
    if (state.messagesEl) {
      state.messagesEl.innerHTML = '';
    }
    renderHistory();
    setStatus('已开始新对话');
    return conversation;
  }

  function persistMessages() {
    var conversation = ensureConversation();
    conversation.messages = state.messages.slice(-HISTORY_MESSAGES);
    conversation.updatedAt = new Date().toISOString();
    if (conversation.title === '新对话') {
      var firstUser = state.messages.filter(function (item) { return item.role === 'user'; })[0];
      if (firstUser) {
        conversation.title = String(firstUser.content).slice(0, 24);
      }
    }
    state.messages = conversation.messages;
    saveHistoryStore();
    renderHistory();
  }

  function switchConversation(id) {
    var conversation = state.conversations.filter(function (item) { return item.id === id; })[0];
    if (!conversation) {
      return;
    }
    state.activeId = id;
    state.messages = conversation.messages;
    saveHistoryStore();
    renderMessages();
    renderHistory();
    toggleHistory(false);
  }

  function deleteConversation(id) {
    state.conversations = state.conversations.filter(function (item) { return item.id !== id; });
    if (state.activeId === id) {
      state.activeId = '';
      state.messages = [];
      ensureConversation();
      renderMessages();
    }
    saveHistoryStore();
    renderHistory();
  }

  function renderMessages() {
    if (!state.messagesEl) {
      return;
    }
    state.messagesEl.innerHTML = '';
    state.messages.forEach(function (item) {
      var bubble = document.createElement('div');
      bubble.className = 'ai-message ai-message-' + item.role;
      bubble.innerHTML = item.role === 'user'
        ? escapeHtml(item.content).replace(/\n/g, '<br>')
        : safeMarkdown(item.content);
      state.messagesEl.appendChild(bubble);
      if (item.role === 'assistant') {
        enhance(bubble);
      }
    });
    state.messagesEl.scrollTop = state.messagesEl.scrollHeight;
  }

  function renderHistory() {
    if (!state.overlay) {
      return;
    }
    var list = state.overlay.querySelector('[data-ai-history]');
    if (!list) {
      return;
    }
    if (!state.conversations.length) {
      list.innerHTML = '<p class="ai-history-empty">暂无历史对话</p>';
      return;
    }
    list.innerHTML = state.conversations.slice().reverse().map(function (item) {
      var date = String(item.updatedAt || '').replace('T', ' ').slice(0, 16);
      return '<div class="ai-history-item' + (item.id === state.activeId ? ' is-active' : '') + '" data-ai-history-id="' + escapeHtml(item.id) + '">'
        + '<span class="ai-history-title">' + escapeHtml(item.title || '新对话') + '</span>'
        + '<span class="ai-history-date">' + escapeHtml(date) + '</span>'
        + '<button type="button" data-ai-history-delete="' + escapeHtml(item.id) + '" title="删除">×</button>'
        + '</div>';
    }).join('');
  }

  function toggleHistory(force) {
    var list = state.overlay.querySelector('[data-ai-history]');
    if (!list) {
      return;
    }
    var show = typeof force === 'boolean' ? force : list.hidden;
    list.hidden = !show;
    if (show) {
      renderHistory();
    }
  }

  function updateBadge() {
    if (!state.overlay) {
      return;
    }
    var badge = state.overlay.querySelector('[data-ai-badge]');
    var scope = (state.config.scope || []).length;
    badge.textContent = (configured() ? '公共 Claude' : '请登录服务器')
      + (scope ? ' · 范围 ' + scope : '');
  }

  function openPanel() {
    setTimeout(function(){
      if(!state.overlay)return;
      var select=state.overlay.querySelector('[data-code-repository]');
      var cancelButton=state.overlay.querySelector('[data-ai-cancel]');if(cancelButton)cancelButton.onclick=function(){if(state.jobId)fetch('__ai/jobs/'+state.jobId+'/cancel',{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':SiteAuth.csrfToken()}});};
      var configButton=state.overlay.querySelector('[data-ai-action="config"]');if(configButton)configButton.hidden=!isAdmin();
      if(location.protocol==='file:' || !accountIdentity())return;
      fetch('__ai/public',{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(data){
        if(!select)return;select.textContent='';(data.repositories||[]).forEach(function(repo){var option=document.createElement('option');option.value=repo.id;option.textContent=repo.name+(repo.ready?' @ r'+repo.revision:'（未拉取）');select.appendChild(option);});select.value=data.defaultRepository||'';
      }).catch(function(){setStatus('公共 AI 状态读取失败');});
    },0);
    if (!state.overlay) {
      buildOverlay();
    }
    ensureConversation();
    state.messages = activeConversation().messages;
    renderMessages();
    renderHistory();
    updateBadge();
    state.overlay.classList.add('is-open');
    if (!configured()) {
      openConfig();
    }
    state.inputEl.focus();
  }

  function closePanel() {
    if (state.overlay) {
      state.overlay.classList.remove('is-open');
    }
  }

  // ---------- AI 配置弹窗（独立于聊窗） ----------

  function openConfig() {
    if (!isAdmin()) { setStatus('AI 服务由管理员统一配置，请直接选择代码库提问'); return; }
    if (state.configOverlay) state.configOverlay.remove();
    var box=document.createElement('div');box.className='ai-config-dialog is-open';
    box.innerHTML='<div class="ai-config-backdrop"></div><section class="ai-config-panel"><header class="ai-config-head">公共 Claude 配置 <button data-close>关闭</button></header><div class="ai-config-body"><p>仅管理员可配置。baseUrl 为 Windows 中转根地址，apiKey 为中转令牌。代码库使用默认 SVN 同步凭据。保存后点击同步拉取指定版本。</p><textarea data-json rows="22" style="width:100%;font-family:monospace"></textarea><button data-save>保存公共配置</button><button data-purge>清理停用的个人配置</button><div data-repos></div><p data-status></p></div></section>';
    document.body.appendChild(box);state.configOverlay=box;
    box.querySelector('[data-close]').onclick=function(){box.remove();state.configOverlay=null;};
    var area=box.querySelector('[data-json]'),status=box.querySelector('[data-status]'),version='';
    function api(url,method,body){return fetch(url,{method:method||'GET',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':SiteAuth.csrfToken()},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.message||d.error);return d;});});}
    api('__config').then(function(data){version=(data.config||data).expectedConfigVersion||'';var ai=data.config ? data.config.ai : data.ai;area.value=JSON.stringify(ai || {},null,2);
      if(!ai.claude || !ai.claude.repositories.length){var value=ai || {};value.claude={enabled:false,executable:'claude',timeoutSeconds:120,defaultRepository:'example',repositories:[{id:'example',name:'示例代码库',folder:'example',url:'https://svn.example.com/repo',revision:'HEAD'}]};area.value=JSON.stringify(value,null,2);}
      ((ai.claude||{}).repositories||[]).forEach(function(repo){var btn=document.createElement('button');btn.textContent='同步 '+(repo.name||repo.id);btn.onclick=function(){btn.disabled=true;status.textContent='正在拉取…';api('__admin/code-repositories/'+encodeURIComponent(repo.id)+'/sync','POST',{}).then(function(d){status.textContent='同步成功 r'+d.revision;}).catch(function(e){status.textContent=e.message;}).then(function(){btn.disabled=false;});};box.querySelector('[data-repos]').appendChild(btn);});
    }).catch(function(e){status.textContent=e.message;});
    box.querySelector('[data-purge]').onclick=function(){api('__admin/ai/personal-configs/clear','POST',{}).then(function(d){status.textContent='已清理 '+d.cleared+' 项旧个人配置';}).catch(function(e){status.textContent=e.message;});};
    box.querySelector('[data-save]').onclick=function(){try{var value=JSON.parse(area.value);value.expectedConfigVersion=version;api('__admin/ai','PUT',value).then(function(data){version=(data.config||{}).expectedConfigVersion||version;status.textContent='已保存。重新打开配置可同步新代码库';}).catch(function(e){status.textContent=e.message;});}catch(e){status.textContent='JSON 格式错误：'+e.message;}};
  }


  function closeConfig() {
    if (state.configOverlay) { state.configOverlay.remove();state.configOverlay=null; }
  }

  function configure(config) {
    state.config = Object.assign({}, state.config || defaults(), config || {});
    if(!isAdmin())return Promise.resolve(false);
    var saving=persistConfig();
    return saving;
  }

  function init() {
    state.config = loadConfig();
    var store = loadHistoryStore();
    state.conversations = store.conversations;
    state.activeId = store.activeId;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-assistant-button';
    button.title = 'AI 文档助手（Ctrl+Shift+A）';
    button.textContent = 'AI 助手';
    button.addEventListener('click', openPanel);
    document.body.appendChild(button);
    if (activeConversation()) {
      state.messages = activeConversation().messages;
    }
    document.addEventListener('siteauth:change', function () {
      syncPersonalConfig();
    });
    syncPersonalConfig();
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (state.configOverlay && state.configOverlay.classList.contains('is-open')) {
          closeConfig();
        } else if (state.overlay && state.overlay.classList.contains('is-open')) {
          closePanel();
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'a' || event.key === 'A')) {
        event.preventDefault();
        openPanel();
      }
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.AIAssistant = {
    open: openPanel,
    close: closePanel,
    openConfig: openConfig,
    closeConfig: closeConfig,
    ask: ask,
    configure: configure,
    ready: function(){return syncPersonalConfig();},
    addUploads: function () { return Promise.resolve(false); },
    getConfig: function () { return state.config; },
    providers: PROVIDERS,
    buildContext: function (question, limit) {
      return retrieve(question, limit).then(function (hits) {
        return { hits: hits, context: window.AIRetrieval.buildContext(hits, state.config.contextChars) };
      });
    },
    scopeTree: function () {
      return loadCorpus().then(function () {
        return window.AIRetrieval.scopeTree(mergedCorpus(), state.config.uploads);
      });
    }
  };
}());
