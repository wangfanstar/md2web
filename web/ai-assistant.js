(function () {
  'use strict';

  if (!window.AIRetrieval) {
    return;
  }

  var STORAGE_KEY = 'md2web:ai-config';
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
      scope: [],
      uploads: []
    };
    Object.keys(PROVIDERS).forEach(function (name) {
      if (external.provider === name) {
        base.provider = name;
      }
    });
    return Object.assign(base, external);
  }

  function loadConfig() {
    var config = defaults();
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        Object.assign(config, saved);
      }
    } catch (error) { /* 忽略损坏的本地配置 */ }
    if (!Array.isArray(config.scope)) {
      config.scope = [];
    }
    if (!Array.isArray(config.uploads)) {
      config.uploads = [];
    }
    return config;
  }

  function persistConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
    } catch (error) {
      setStatus('本地保存失败（可能超出浏览器存储配额），上传文档仅本次会话有效');
    }
  }

  function configured() {
    return !!(state.config && state.config.baseUrl && (state.config.apiKey || /127\.0\.0\.1|localhost/.test(state.config.baseUrl)));
  }

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
    state.corpusPromise = fetch('search-index.json', { cache: 'no-cache' }).then(function (response) {
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

  function buildRequest(messages) {
    var config = state.config;
    var provider = PROVIDERS[config.provider] || PROVIDERS.openai;
    var style = provider.style;
    if (style === 'anthropic') {
      return {
        url: config.baseUrl,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        payload: {
          model: config.model,
          max_tokens: 2048,
          temperature: Number(config.temperature) || 0.2,
          system: messages[0] && messages[0].role === 'system' ? messages[0].content : undefined,
          messages: messages.filter(function (item) { return item.role !== 'system'; }),
          stream: true
        }
      };
    }
    return {
      url: config.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config.apiKey
      },
      payload: {
        model: config.model,
        temperature: Number(config.temperature) || 0.2,
        messages: messages,
        stream: true
      }
    };
  }

  function extractDelta(style, data) {
    if (!data || data === '[DONE]') {
      return { done: true, text: '' };
    }
    var parsed;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      return { done: false, text: '' };
    }
    if (style === 'anthropic') {
      if (parsed.type === 'content_block_delta' && parsed.delta) {
        return { done: false, text: parsed.delta.text || '' };
      }
      if (parsed.type === 'message_stop') {
        return { done: true, text: '' };
      }
      return { done: false, text: '' };
    }
    var choice = parsed.choices && parsed.choices[0];
    var text = choice && choice.delta && choice.delta.content ? choice.delta.content : '';
    if (choice && (choice.finish_reason || parsed.choices === undefined)) {
      return { done: !!choice.finish_reason, text: text };
    }
    return { done: false, text: text };
  }

  function extractFull(style, payload) {
    if (style === 'anthropic') {
      return (payload.content || []).map(function (part) { return part.text || ''; }).join('');
    }
    var choice = payload.choices && payload.choices[0];
    if (choice && choice.message) {
      return choice.message.content || '';
    }
    if (choice && choice.text) {
      return choice.text;
    }
    if (payload.response) {
      return payload.response;
    }
    return '';
  }

  function parseStream(style, response, onDelta) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buffer = '';
    var text = '';
    function pump() {
      return reader.read().then(function (result) {
        if (result.done) {
          return text;
        }
        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(function (line) {
          var trimmed = line.trim();
          if (!trimmed || trimmed.indexOf('data:') !== 0) {
            return;
          }
          var delta = extractDelta(style, trimmed.slice(5).trim());
          if (delta.text) {
            text += delta.text;
            onDelta(text);
          }
        });
        return pump();
      });
    }
    return pump();
  }

  function callDirect(request, onDelta) {
    var style = (PROVIDERS[state.config.provider] || PROVIDERS.openai).style;
    return fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.payload)
    }).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (detail) {
          var error = new Error('HTTP ' + response.status + '：' + detail.slice(0, 300));
          error.status = response.status;
          throw error;
        });
      }
      var contentType = response.headers.get('Content-Type') || '';
      if (contentType.indexOf('text/event-stream') >= 0 && response.body) {
        return parseStream(style, response, onDelta);
      }
      return response.json().then(function (payload) {
        var text = extractFull(style, payload);
        if (!text) {
          throw new Error('接口未返回文本内容');
        }
        onDelta(text);
        return text;
      });
    });
  }

  function callProxy(request, onDelta) {
    var style = (PROVIDERS[state.config.provider] || PROVIDERS.openai).style;
    return fetch('__ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: request.url,
        apiKey: state.config.apiKey,
        headers: request.headers,
        payload: request.payload
      })
    }).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (detail) {
          throw new Error('本机代理失败：' + detail.slice(0, 300));
        });
      }
      var contentType = response.headers.get('Content-Type') || '';
      if (contentType.indexOf('text/event-stream') >= 0 && response.body) {
        return parseStream(style, response, onDelta);
      }
      return response.json().then(function (payload) {
        var text = payload.error ? String(payload.error).slice(0, 300) : extractFull(style, payload);
        if (!text) {
          throw new Error('接口未返回文本内容');
        }
        onDelta(text);
        return text;
      });
    });
  }

  function requestModel(messages, onDelta) {
    var request = buildRequest(messages);
    if (window.location.protocol === 'file:' || state.config.useProxy === 'always') {
      if (window.location.protocol === 'file:') {
        throw new Error('离线模式（file://）无法使用本机代理，请改用 python serve.py 预览');
      }
      return callProxy(request, onDelta);
    }
    return callDirect(request, onDelta).catch(function (error) {
      if (state.config.useProxy === 'never') {
        throw error;
      }
      setStatus('直连失败（可能是跨域），正在尝试本机代理…');
      return callProxy(request, onDelta);
    });
  }

  // ---------- 渲染 ----------

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
    bubble.innerHTML = role === 'user' ? escapeHtml(content).replace(/\n/g, '<br>') : renderMarkdown(content);
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
    if (!text || state.busy) {
      return Promise.resolve();
    }
    if (!state.overlay) {
      buildOverlay();
    }
    if (!configured()) {
      appendMessage('assistant', '尚未配置 AI 接口。点击左侧栏的「AI 配置」图标（或右上角 ⚙）填写接口地址、模型与 API Key；Key 只保存在浏览器本地。');
      openConfig();
      return Promise.resolve();
    }
    appendMessage('user', text);
    state.inputEl.value = '';
    state.busy = true;
    setStatus('正在检索文档…');
    var history = state.messages.slice(-HISTORY_LIMIT).map(function (item) {
      return { role: item.role, content: item.content };
    });
    var bubble = appendMessage('assistant', '…');
    return retrieve(text).then(function (hits) {
      setStatus(hits.length
        ? '已找到 ' + hits.length + ' 条相关资料，正在请求模型…'
        : '未命中本地资料，正在按模型已有知识回答…');
      var context = window.AIRetrieval.buildContext(hits, state.config.contextChars);
      var messages = window.AIRetrieval.buildMessages({
        systemPrompt: state.config.systemPrompt || DEFAULT_SYSTEM,
        context: context,
        history: history,
        question: text
      });
      var rendered = '';
      return requestModel(messages, function (partial) {
        rendered = partial;
        bubble.innerHTML = renderMarkdown(partial);
        state.messagesEl.scrollTop = state.messagesEl.scrollHeight;
      }).then(function (answer) {
        rendered = answer || rendered;
        bubble.innerHTML = renderMarkdown(rendered);
        enhance(bubble);
        appendSources(hits);
        state.messages.push({ role: 'user', content: text });
        state.messages.push({ role: 'assistant', content: rendered });
        setStatus('');
      });
    }).catch(function (error) {
      bubble.className = 'ai-message ai-message-error';
      bubble.textContent = '请求失败：' + message(error);
      setStatus('');
    }).then(function () {
      state.busy = false;
    });
  }

  // ---------- 聊窗 ----------

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
      '<button type="button" data-ai-action="clear">清空</button>',
      '<button type="button" data-ai-action="close">关闭</button>',
      '</header>',
      '<div class="ai-messages" data-ai-messages></div>',
      '<div class="ai-status" data-ai-status></div>',
      '<div class="ai-actions">',
      '<button type="button" data-ai-quick="总结本页">总结本页</button>',
      '<button type="button" data-ai-quick="这篇文档讲了什么？">文档概览</button>',
      '<button type="button" data-ai-quick="解释选中的内容">解释选中</button>',
      '</div>',
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
      } else if (action === 'close') {
        closePanel();
      } else if (action === 'send') {
        ask(state.inputEl.value);
      } else if (action === 'clear') {
        state.messages = [];
        state.messagesEl.innerHTML = '';
        setStatus('');
      }
    });
    state.inputEl.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        ask(state.inputEl.value);
      }
    });
  }

  function updateBadge() {
    if (!state.overlay) {
      return;
    }
    var badge = state.overlay.querySelector('[data-ai-badge]');
    var scope = (state.config.scope || []).length;
    badge.textContent = (configured() ? (state.config.model || state.config.provider) : '未配置')
      + (scope ? ' · 范围 ' + scope : '');
  }

  function openPanel() {
    if (!state.overlay) {
      buildOverlay();
    }
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

  function buildConfigOverlay() {
    var overlay = document.createElement('div');
    overlay.className = 'ai-config-dialog';
    var options = Object.keys(PROVIDERS).map(function (name) {
      return '<option value="' + name + '">' + escapeHtml(PROVIDERS[name].label) + '</option>';
    }).join('');
    overlay.innerHTML = [
      '<div class="ai-config-backdrop" data-ai-config-close></div>',
      '<section class="ai-config-panel">',
      '<header class="ai-config-head">',
      '<span class="ai-title">AI 配置</span>',
      '<span class="ai-head-spacer"></span>',
      '<button type="button" data-ai-action="configClose">关闭</button>',
      '</header>',
      '<div class="ai-config-body">',
      '<div class="ai-config-grid">',
      '<label class="ai-wide">服务商<select data-ai-field="provider">' + options + '</select></label>',
      '<label class="ai-wide">接口地址<input type="text" data-ai-field="baseUrl" placeholder="https://api.example.com/v1/chat/completions"></label>',
      '<label>模型<input type="text" data-ai-field="model" placeholder="模型名"></label>',
      '<label>API Key<input type="password" data-ai-field="apiKey" autocomplete="off" placeholder="仅保存在本机浏览器"></label>',
      '<label>温度<input type="number" step="0.1" min="0" max="2" data-ai-field="temperature"></label>',
      '<label>资料上限（字符）<input type="number" step="500" min="1000" data-ai-field="contextChars"></label>',
      '<label class="ai-wide">请求方式<select data-ai-field="useProxy"><option value="auto">自动（直连失败走本机代理）</option><option value="always">始终走本机代理</option><option value="never">只允许直连</option></select></label>',
      '<label class="ai-wide">系统提示<textarea rows="3" data-ai-field="systemPrompt"></textarea></label>',
      '</div>',
      '<div class="ai-scope">',
      '<div class="ai-scope-head"><strong>资料范围</strong><span>不勾选 = 使用全部文档</span><button type="button" data-ai-action="scopeAll">全选</button><button type="button" data-ai-action="scopeNone">全不选</button></div>',
      '<div class="ai-scope-tree" data-ai-scope-tree></div>',
      '</div>',
      '<div class="ai-uploads">',
      '<div class="ai-scope-head"><strong>上传文档</strong><span>仅本机浏览器保存（.md/.markdown/.txt）</span><label class="ai-upload-button">选择文件<input type="file" multiple accept=".md,.markdown,.txt" data-ai-file></label><button type="button" data-ai-action="uploadClear">清空上传</button></div>',
      '<div class="ai-uploads-list" data-ai-uploads></div>',
      '</div>',
      '<p class="ai-hint">Key 只存在浏览器 localStorage，不会写入仓库或服务端。跨域受限时可保持「自动」，请求会经本机 <code>serve.py</code> 的 <code>/__ai/chat</code> 代理（仅本机可调用）。离线 <code>file://</code> 模式只支持直连。勾选「资料范围」后，回答只依据所选文档/文件夹。</p>',
      '</div>',
      '<footer class="ai-config-foot">',
      '<button type="button" class="ai-primary" data-ai-action="save">保存并测试</button>',
      '<button type="button" class="ai-plain" data-ai-action="reset">清除配置</button>',
      '<span class="ai-status" data-ai-config-status></span>',
      '</footer>',
      '</section>'
    ].join('');
    document.body.appendChild(overlay);
    state.configOverlay = overlay;
    bindConfigOverlay();
  }

  function fillConfigForm() {
    var overlay = state.configOverlay;
    overlay.querySelector('[data-ai-field="provider"]').value = state.config.provider;
    overlay.querySelector('[data-ai-field="baseUrl"]').value = state.config.baseUrl;
    overlay.querySelector('[data-ai-field="model"]').value = state.config.model;
    overlay.querySelector('[data-ai-field="apiKey"]').value = state.config.apiKey;
    overlay.querySelector('[data-ai-field="temperature"]').value = state.config.temperature;
    overlay.querySelector('[data-ai-field="contextChars"]').value = state.config.contextChars;
    overlay.querySelector('[data-ai-field="systemPrompt"]').value = state.config.systemPrompt;
    overlay.querySelector('[data-ai-field="useProxy"]').value = state.config.useProxy;
  }

  function readConfigForm() {
    var overlay = state.configOverlay;
    return Object.assign({}, state.config, {
      provider: overlay.querySelector('[data-ai-field="provider"]').value,
      baseUrl: overlay.querySelector('[data-ai-field="baseUrl"]').value.trim(),
      model: overlay.querySelector('[data-ai-field="model"]').value.trim(),
      apiKey: overlay.querySelector('[data-ai-field="apiKey"]').value.trim(),
      temperature: Number(overlay.querySelector('[data-ai-field="temperature"]').value) || 0.2,
      contextChars: Number(overlay.querySelector('[data-ai-field="contextChars"]').value) || 6000,
      systemPrompt: overlay.querySelector('[data-ai-field="systemPrompt"]').value,
      useProxy: overlay.querySelector('[data-ai-field="useProxy"]').value
    });
  }

  function renderScopeTree() {
    if (!state.configOverlay) {
      return;
    }
    var container = state.configOverlay.querySelector('[data-ai-scope-tree]');
    if (!state.corpusBase) {
      container.textContent = '正在加载文档索引…';
      return;
    }
    var scope = state.config.scope || [];
    var tree = window.AIRetrieval.scopeTree(mergedCorpus(), state.config.uploads);
    if (!tree.length) {
      container.textContent = '没有可用文档';
      return;
    }
    container.innerHTML = tree.map(function (folder) {
      var checked = scope.indexOf(folder.prefix) >= 0;
      var pages = folder.pages.map(function (page) {
        var pageChecked = checked || scope.indexOf(page.route) >= 0;
        return '<label class="ai-scope-page" title="' + escapeHtml(page.route) + '">'
          + '<input type="checkbox" data-ai-scope="' + escapeHtml(page.route) + '"' + (pageChecked ? ' checked' : '') + '>'
          + '<span>' + escapeHtml(page.label) + (page.upload ? '（上传）' : '') + '</span></label>';
      }).join('');
      return '<details class="ai-scope-folder"' + (checked ? ' open' : '') + '>'
        + '<summary><label><input type="checkbox" data-ai-scope="' + escapeHtml(folder.prefix) + '"' + (checked ? ' checked' : '') + '><span>' + escapeHtml(folder.label) + '</span></label></summary>'
        + pages + '</details>';
    }).join('');
    updateScopeHint();
  }

  function updateScopeHint() {
    var count = (state.config.scope || []).length;
    var hint = state.configOverlay.querySelector('[data-ai-scope-count]');
    if (hint) {
      hint.textContent = count ? '已选 ' + count + ' 项' : '全部文档';
    }
    updateBadge();
  }

  function renderUploads() {
    if (!state.configOverlay) {
      return;
    }
    var list = state.configOverlay.querySelector('[data-ai-uploads]');
    var uploads = state.config.uploads || [];
    if (!uploads.length) {
      list.textContent = '尚未上传文档';
      return;
    }
    list.innerHTML = uploads.map(function (item, index) {
      return '<span class="ai-upload-item"><span>' + escapeHtml(item.name) + '</span>'
        + '<span class="ai-upload-size">' + Math.round(item.text.length / 1024) + ' KB</span>'
        + '<button type="button" data-ai-upload-remove="' + index + '" title="移除">×</button></span>';
    }).join('');
  }

  function addUploads(files) {
    var uploads = state.config.uploads || [];
    var total = uploads.reduce(function (sum, item) { return sum + item.text.length; }, 0);
    var pending = Array.prototype.slice.call(files || []);
    var problems = [];
    var tasks = pending.map(function (file) {
      return new Promise(function (resolve) {
        if (file.size > UPLOAD_FILE_LIMIT) {
          problems.push(file.name + ' 超过 256 KB');
          resolve();
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          var text = String(reader.result || '');
          if (total + text.length > UPLOAD_TOTAL_LIMIT) {
            problems.push(file.name + ' 使总大小超过 512 KB');
            resolve();
            return;
          }
          total += text.length;
          uploads.push({ name: file.name, text: text });
          resolve();
        };
        reader.onerror = function () {
          problems.push(file.name + ' 读取失败');
          resolve();
        };
        reader.readAsText(file, 'utf-8');
      });
    });
    return Promise.all(tasks).then(function () {
      state.config.uploads = uploads;
      persistConfig();
      renderUploads();
      renderScopeTree();
      setStatus(problems.length ? '部分文件未加入：' + problems.join('；') : '已加入 ' + uploads.length + ' 个上传文档');
    });
  }

  function bindConfigOverlay() {
    var overlay = state.configOverlay;
    overlay.addEventListener('click', function (event) {
      var target = event.target;
      var action = target.getAttribute && target.getAttribute('data-ai-action');
      var removeIndex = target.getAttribute && target.getAttribute('data-ai-upload-remove');
      if (target.hasAttribute && target.hasAttribute('data-ai-config-close') || action === 'configClose') {
        closeConfig();
        return;
      }
      if (removeIndex !== null && removeIndex !== undefined) {
        state.config.uploads.splice(Number(removeIndex), 1);
        state.config.scope = [];
        persistConfig();
        renderUploads();
        renderScopeTree();
        return;
      }
      if (action === 'scopeAll') {
        state.config.scope = window.AIRetrieval.scopeTree(mergedCorpus(), state.config.uploads).map(function (folder) {
          return folder.prefix;
        });
        persistConfig();
        renderScopeTree();
      } else if (action === 'scopeNone') {
        state.config.scope = [];
        persistConfig();
        renderScopeTree();
      } else if (action === 'save') {
        state.config = readConfigForm();
        persistConfig();
        updateBadge();
        testConnection();
      } else if (action === 'reset') {
        state.config = defaults();
        persistConfig();
        fillConfigForm();
        renderUploads();
        renderScopeTree();
        updateBadge();
        setStatus('已清除本机配置');
      } else if (action === 'uploadClear') {
        state.config.uploads = [];
        state.config.scope = [];
        persistConfig();
        renderUploads();
        renderScopeTree();
        setStatus('已清空上传文档');
      }
    });
    overlay.addEventListener('change', function (event) {
      var target = event.target;
      if (target.getAttribute && target.getAttribute('data-ai-file') !== null && target.getAttribute('data-ai-file') !== undefined && target.type === 'file') {
        addUploads(target.files);
        target.value = '';
        return;
      }
      var scopeValue = target.getAttribute && target.getAttribute('data-ai-scope');
      if (scopeValue) {
        var scope = (state.config.scope || []).filter(function (item) { return item !== scopeValue; });
        if (target.checked) {
          scope.push(scopeValue);
        }
        state.config.scope = scope;
        persistConfig();
        renderScopeTree();
      }
    });
    overlay.querySelector('[data-ai-field="provider"]').addEventListener('change', function () {
      var preset = PROVIDERS[this.value];
      if (preset && preset.baseUrl) {
        overlay.querySelector('[data-ai-field="baseUrl"]').value = preset.baseUrl;
        overlay.querySelector('[data-ai-field="model"]').value = preset.model;
      }
    });
  }

  function testConnection() {
    setStatus('正在测试接口…');
    var request = buildRequest([{ role: 'user', content: 'ping' }]);
    request.payload.stream = false;
    return callDirect(request, function () {}).then(function (text) {
      setStatus('连接成功：' + String(text).slice(0, 40));
    }).catch(function (error) {
      return callProxy(request, function () {}).then(function (text) {
        setStatus('直连失败，本机代理连接成功：' + String(text).slice(0, 40));
      }).catch(function () {
        setStatus('连接失败：' + message(error));
      });
    });
  }

  function openConfig() {
    if (!state.configOverlay) {
      buildConfigOverlay();
    }
    fillConfigForm();
    renderUploads();
    state.configOverlay.classList.add('is-open');
    loadCorpus().then(renderScopeTree);
  }

  function closeConfig() {
    if (state.configOverlay) {
      state.configOverlay.classList.remove('is-open');
    }
  }

  function configure(config) {
    state.config = Object.assign({}, state.config || defaults(), config || {});
    persistConfig();
    if (state.configOverlay) {
      fillConfigForm();
      renderUploads();
      renderScopeTree();
    }
    updateBadge();
    return state.config;
  }

  function init() {
    state.config = loadConfig();
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-assistant-button';
    button.title = 'AI 文档助手（Ctrl+Shift+A）';
    button.textContent = 'AI 助手';
    button.addEventListener('click', openPanel);
    document.body.appendChild(button);
    loadCorpus();
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
    addUploads: addUploads,
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
