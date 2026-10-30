(function () {
  'use strict';

  if (!window.AIRetrieval) {
    return;
  }

  var STORAGE_KEY = 'md2web:ai-config';
  var GUEST_STORAGE_KEY = 'md2web:ai-config:guest';

  function accountIdentity() {
    var user = window.SiteAuth && SiteAuth.snapshot().user;
    return user ? String(user.id || (user.authSourceId || '') + ':' + user.username) : '';
  }
  function syncPersonalConfig() {
    // 清除已停用的浏览器端 AI 服务配置（旧版本遗留），不再读取。
    try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(GUEST_STORAGE_KEY); } catch (_) {}
    state.config = defaults();
    if (!isAdmin() && state.configOverlay) closeConfig();
    return Promise.resolve(true);
  }

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

  function isAdmin() {
    var siteAuth = window.SiteAuth;
    return !!(siteAuth && siteAuth.isAdmin && siteAuth.isAdmin());
  }

  function defaults() { return { scope: [], uploads: [] }; }

  function loadConfig() { return defaults(); }

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

  function compactScopes(paths) {
    return paths.filter(function(path,index){return paths.indexOf(path)===index && !paths.some(function(parent){return parent!==path && path.indexOf(parent+'/')===0;});});
  }

  function syncScopeTree(host) {
    var nodes=Array.prototype.slice.call(host.querySelectorAll('.ai-tree-node')).reverse();
    nodes.forEach(function(node){
      var input=node._input,children=node._children.filter(function(child){return !child._input.disabled;});
      if(!children.length)return;
      var all=children.every(function(child){return child._input.checked&&!child._input.indeterminate;});
      var any=children.some(function(child){return child._input.checked||child._input.indeterminate;});
      input.checked=all;input.indeterminate=!all&&any;
    });
  }

  function filterScopeTree(picker) {
    var query=picker.querySelector('input[type=search]').value.trim().toLowerCase();
    Array.prototype.slice.call(picker.querySelectorAll('.ai-tree-node')).reverse().forEach(function(node){
      var own=node._input.value.toLowerCase().indexOf(query)>=0;
      var childMatch=node._children.some(function(child){return !child.hidden;});
      node.hidden=!!query&&!own&&!childMatch;
      node._body.hidden=query?!childMatch:!node._expanded;
      node._toggle.setAttribute('aria-expanded',String(!node._body.hidden));
      node._toggle.setAttribute('aria-label',(node._body.hidden?'展开 ':'折叠 ')+node._input.value);
      node._toggle.textContent=node._body.hidden?'▸':'▾';
    });
  }

  function renderScopeTree(host, folders, selected, attribute) {
    var tree=document.createElement('div');tree.className='ai-scope-tree';
    var nodes=Object.create(null);
    folders.slice().sort(function(a,b){return a.path.localeCompare(b.path);}).forEach(function(folder){
      var node=document.createElement('div');node.className='ai-tree-node';
      var row=document.createElement('div');row.className='ai-tree-row';
      var toggle=document.createElement('button');toggle.type='button';toggle.className='ai-tree-toggle';toggle.textContent='▸';toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','展开 '+folder.path);
      var label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.setAttribute(attribute,'');input.value=folder.path;input.disabled=folder.available===false;
      input.checked=Object.keys(selected).some(function(path){return selected[path]&&(folder.path===path||folder.path.indexOf(path+'/')===0);});
      label.title=folder.path;label.appendChild(input);label.appendChild(document.createTextNode(folder.name||folder.path.split('/').pop()));
      var body=document.createElement('div');body.className='ai-tree-children';body.hidden=true;
      row.appendChild(toggle);row.appendChild(label);node.appendChild(row);node.appendChild(body);
      node._input=input;node._toggle=toggle;node._body=body;node._children=[];node._expanded=false;nodes[folder.path]=node;
      toggle.onclick=function(){node._expanded=!node._expanded;body.hidden=!node._expanded;toggle.textContent=node._expanded?'▾':'▸';toggle.setAttribute('aria-expanded',String(node._expanded));toggle.setAttribute('aria-label',(node._expanded?'折叠 ':'展开 ')+folder.path);};
      input.onchange=function(){var checked=input.checked;node.querySelectorAll('input[type=checkbox]').forEach(function(child){if(!child.disabled){child.checked=checked;child.indeterminate=false;}});syncScopeTree(tree);};
    });
    Object.keys(nodes).forEach(function(path){var node=nodes[path],parent=path;do{parent=parent.slice(0,parent.lastIndexOf('/'));}while(parent.indexOf('/')>=0&&!nodes[parent]);
      if(nodes[parent]&&parent!==path){nodes[parent]._body.appendChild(node);nodes[parent]._children.push(node);}else{tree.appendChild(node);node._input.parentNode.lastChild.textContent=folders.filter(function(f){return f.path===path;})[0].name||path;}
    });
    Object.keys(nodes).forEach(function(path){var node=nodes[path];if(!node._children.length){node._toggle.style.visibility='hidden';node._toggle.tabIndex=-1;}});
    host.appendChild(tree);syncScopeTree(tree);
  }

  function addScopeActions(host) {
    var bar=document.createElement('div');bar.className='ai-scope-bulk';
    [['全选',true],['清空',false]].forEach(function(action){var button=document.createElement('button');button.type='button';button.textContent=action[0];button.onclick=function(){
      var picker=state.overlay.querySelector('.ai-scope-picker'),query=picker.querySelector('input[type=search]').value.trim().toLowerCase();
      host.querySelectorAll('input[type=checkbox]').forEach(function(input){if(!input.disabled&&input.value.toLowerCase().indexOf(query)>=0){input.checked=action[1];input.indeterminate=false;}});syncScopeTree(host);
    };bar.appendChild(button);});host.appendChild(bar);
  }

  function ask(question) {
    var text = String(question || '').trim();
    if (!text || state.busy) return Promise.resolve();
    if (!state.overlay) buildOverlay();
    if (location.protocol === 'file:') { setStatus('离线页面无法问答，请打开服务器站点'); return Promise.resolve(); }
    if (!accountIdentity()) { setStatus('请先登录后使用公共 AI 问答'); return Promise.resolve(); }
    var folders=Array.prototype.map.call(state.overlay.querySelectorAll('[data-document-folder]:checked'),function(input){return input.value;});
    var selected=state.overlay.querySelector('[data-code-repository]');
    var codeFolders=Array.prototype.map.call(state.overlay.querySelectorAll('[data-code-folder]:checked'),function(input){return input.value;});
    folders=compactScopes(folders);codeFolders=compactScopes(codeFolders);
    var scopeKey=JSON.stringify([accountIdentity(),codeFolders,folders]);
    var current=ensureConversation();
    if(current.scopeKey!==scopeKey && state.messages.length)current=startConversation();
    current.scopeKey=scopeKey;
    appendMessage('user', text); state.inputEl.value = ''; state.busy = true;
    var bubble = appendMessage('assistant', '正在检索并请求 Claude…');
    var selected = state.overlay.querySelector('[data-code-repository]');
    return fetch('__ai/chat', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':SiteAuth.csrfToken()},
      body:JSON.stringify({messages:state.messages.slice(-8).concat([{role:'user',content:text}]),codeRepositoryId:selected ? selected.value : '',documentFolders:folders,codeFolders:codeFolders})})
       .then(function(r){
        if(!r.ok)return r.json().then(function(data){throw new Error(data.message||data.error);});
        var reader=r.body.getReader(),decoder=new TextDecoder(),buffer='',result=null,partial='';
        function pump(){return reader.read().then(function(part){
          buffer+=decoder.decode(part.value||new Uint8Array(),{stream:!part.done});
          var split;while((split=buffer.indexOf('\n\n'))>=0){var event=buffer.slice(0,split);buffer=buffer.slice(split+2);var kind=/event: (.*)/.exec(event),data=/data: (.*)/.exec(event);if(!data)continue;var value=JSON.parse(data[1]);
            if(kind&&kind[1]==='start')state.jobId=value.jobId;
            if(kind&&kind[1]==='delta'){partial+=value.text||'';bubble.style.whiteSpace='pre-wrap';bubble.textContent=partial;state.messagesEl.scrollTop=state.messagesEl.scrollHeight;}
            if(kind&&kind[1]==='error')throw new Error(value.message);
            if(kind&&kind[1]==='complete')result=value;
          }
          if(part.done){if(!result)throw new Error('问答连接中断');return result;}return pump();
        });}return pump();
      })
      .then(function(data){bubble.style.whiteSpace='';bubble.innerHTML=safeMarkdown(data.answer);enhance(bubble);
        var source=document.createElement('p');source.textContent=(data.repository ? '代码库 '+data.repository+' @ '+(data.revision==='local'?'local':'r'+data.revision)+'；' : '未使用代码库；')+'文档范围：'+(data.documentFolders||[]).join('、')+'；文件引用请见 Claude 回答';bubble.appendChild(source);
        state.messages.push({role:'user',content:text},{role:'assistant',content:data.answer});persistMessages();setStatus('');})
      .catch(function(e){var partial=bubble.textContent;bubble.textContent=(partial&&partial.indexOf('正在检索')!==0?partial+'\n\n':'')+'请求失败：'+message(e);}).then(function(){state.busy=false;state.jobId=null;});
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
      '<details class="ai-scope-picker"><summary>选择代码仓库与知识库范围 ▾</summary><input type="search" placeholder="筛选目录""><label hidden>代码库 <select data-code-repository><option value="">不使用代码库（默认）</option></select></label>',
      '<fieldset data-code-scopes><legend>代码仓库（可多选到子目录）</legend></fieldset><fieldset data-document-scopes><legend>文档范围（docs/ 下）</legend><label><input type="checkbox" data-document-folder value="md" checked>md（默认）</label></fieldset></details>',
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
    var picker=overlay.querySelector('.ai-scope-picker');
    var scopeButton=document.createElement('button');scopeButton.type='button';scopeButton.textContent='选择知识库 / 代码仓库 / 子文件夹 ▾';
    scopeButton.className='ai-scope-trigger';
    var scopeDialog=document.createElement('dialog');scopeDialog.className='ai-scope-dialog';scopeDialog.setAttribute('aria-label','选择 AI 查询范围');
    picker.parentNode.insertBefore(scopeButton,picker);picker.parentNode.insertBefore(scopeDialog,picker);scopeDialog.appendChild(picker);picker.open=true;
    picker.querySelector('summary').hidden=true;
    picker.querySelector('input[type=search]').oninput=function(){filterScopeTree(picker);};
    var heading=document.createElement('header');heading.className='ai-scope-header';heading.innerHTML='<h2>选择查询范围</h2><p>选择知识库或代码仓库；展开仓库可指定子目录。默认折叠，点击箭头展开；勾选父目录会选中全部子目录，部分选中显示半选。</p>';scopeDialog.insertBefore(heading,picker);
    var scopeFooter=document.createElement('footer');scopeFooter.className='ai-scope-footer';scopeDialog.appendChild(scopeFooter);
    addScopeActions(picker);var globalActions=picker.lastChild;scopeFooter.appendChild(globalActions);globalActions.querySelectorAll('button')[0].textContent='全选范围';globalActions.querySelectorAll('button')[1].textContent='清空选择';
    var done=document.createElement('button');done.type='button';done.textContent='完成选择';done.className='ai-scope-primary';scopeFooter.appendChild(done);
    scopeButton.onclick=function(){scopeDialog.showModal();};done.onclick=function(){scopeDialog.close();var count=picker.querySelectorAll('input:checked').length;scopeButton.textContent='查询范围：已选 '+count+' 项 · 修改 ▾';};

    var panel=overlay.querySelector('.ai-panel'),grip=document.createElement('div');grip.className='ai-resize-grip';grip.tabIndex=0;grip.setAttribute('role','separator');grip.setAttribute('aria-orientation','vertical');grip.setAttribute('aria-label','调整 AI 助手宽度，左右方向键微调');panel.appendChild(grip);
    function setWidth(width){width=Math.max(360,Math.min(window.innerWidth-36,width));panel.style.width=width+'px';grip.setAttribute('aria-valuenow',Math.round(width));return width;}
    try{var saved=Number(localStorage.getItem('md2web:ai-panel-width'));if(saved>0)setWidth(saved);}catch(e){}
    function remember(){try{localStorage.setItem('md2web:ai-panel-width',String(panel.getBoundingClientRect().width));}catch(e){}}
    grip.addEventListener('pointerdown',function(e){if(e.button!==0)return;e.preventDefault();var start=e.clientX,width=panel.getBoundingClientRect().width;grip.setPointerCapture(e.pointerId);document.body.classList.add('ai-is-resizing');function move(event){setWidth(width+start-event.clientX);}function finish(){document.body.classList.remove('ai-is-resizing');remember();grip.removeEventListener('pointermove',move);grip.removeEventListener('pointerup',finish);grip.removeEventListener('pointercancel',finish);grip.removeEventListener('lostpointercapture',finish);}grip.addEventListener('pointermove',move);grip.addEventListener('pointerup',finish);grip.addEventListener('pointercancel',finish);grip.addEventListener('lostpointercapture',finish);});
    grip.addEventListener('keydown',function(e){if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setWidth(panel.getBoundingClientRect().width+(e.key==='ArrowLeft'?24:-24));remember();}});
    window.addEventListener('resize',function(){if(window.innerWidth>640)setWidth(panel.getBoundingClientRect().width);});
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

  function repositoryLabel(repo) {
    var folder=repo.folder || repo.path || repo.id || '';
    return repo.name && repo.name !== folder && repo.name !== folder.split('/').pop() ? folder + '（' + repo.name + '）' : folder;
  }

  function openPanel() {
    setTimeout(function(){
      if(!state.overlay)return;
      var select=state.overlay.querySelector('[data-code-repository]');
      var cancelButton=state.overlay.querySelector('[data-ai-cancel]');if(cancelButton)cancelButton.onclick=function(){if(state.jobId)fetch('__ai/jobs/'+state.jobId+'/cancel',{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':SiteAuth.csrfToken()}});};
      var configButton=state.overlay.querySelector('[data-ai-action="config"]');if(configButton)configButton.hidden=!isAdmin();
      if(location.protocol==='file:' || !accountIdentity())return;
      fetch('__ai/public',{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(data){
        if(!select)return;select.textContent='';
        var chosen={};Array.prototype.forEach.call(state.overlay.querySelectorAll('[data-document-folder]'),function(input){if(input.checked)chosen[input.value]=true;});
        var empty=document.createElement('option');empty.value='';empty.textContent='不使用代码库（默认）';select.appendChild(empty);
        (data.repositories||[]).forEach(function(repo){var option=document.createElement('option');option.value=repo.id;option.textContent=repositoryLabel(repo)+(repo.ready?' @ '+repo.revision:'（目录未就绪）');select.appendChild(option);});select.value='';
        var codes=state.overlay.querySelector('[data-code-scopes]');
        var previous={};codes.querySelectorAll('input:checked').forEach(function(e){previous[e.value]=true;});
        codes.textContent='';var codeLegend=document.createElement('legend');codeLegend.textContent='代码仓库（可多选到子目录）';codes.appendChild(codeLegend);addScopeActions(codes);
        (data.repositories||[]).forEach(function(repo){
          renderScopeTree(codes,[{path:repo.path,name:repositoryLabel(repo)+(repo.ready?'':'（目录未就绪）'),available:repo.ready}].concat((repo.folders||[]).map(function(path){return {path:path,available:repo.ready};})),previous,'data-code-folder');
        });
        if(!(data.repositories||[]).length){var emptyCode=document.createElement('p');emptyCode.className='ai-scope-empty';emptyCode.textContent='尚未配置代码仓库，请在仓库管理中识别并加入。';codes.appendChild(emptyCode);}
        var scopes=state.overlay.querySelector('[data-document-scopes]');scopes.textContent='';
        var legend=document.createElement('legend');legend.textContent='文档范围（docs/ 下）';scopes.appendChild(legend);addScopeActions(scopes);
        renderScopeTree(scopes,data.documentFolders||[{path:'md',available:true}],chosen,'data-document-folder');
        filterScopeTree(state.overlay.querySelector('.ai-scope-picker'));
        if(data.enabled===false)setStatus('管理员尚未启用 Claude 问答，请联系管理员在「配置」中启用。');
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
    window.location.href='html/md2web_config.html#tab=ai';return;
    if (!isAdmin()) { setStatus('AI 服务由管理员统一配置，请选择文档范围后提问'); return; }
    if (state.configOverlay) state.configOverlay.remove();
    var box=document.createElement('div');box.className='ai-config-dialog is-open';
    box.innerHTML='<div class="ai-config-backdrop"></div><section class="ai-config-panel"><header class="ai-config-head">公共 Claude 与检索范围 <button data-close>关闭</button></header><div class="ai-config-body">'
      +'<p>调用服务账号已配置好的 claude，在 docs 目录传入所选目录和问题并收集回答；无需 API 地址、Key 或模型设置。以下目录与 SVN 账号配置保存到私有 JSON。默认仅使用 docs/md。</p>'
      +'<label><input type="checkbox" data-claude-enabled>启用 Claude 问答（未启用时普通用户提问会被拒绝）</label>'
      +'<label>Claude 命令<input data-claude-executable value="claude" placeholder="claude 或绝对路径"></label>'
      +'<label>超时（秒，5–600）<input type="number" min="5" max="600" step="5" data-claude-timeout value="120"></label>'
      +'<label>代码根目录（相对 docs，code 或 code/子目录）<input data-code-folder value="code"></label>'
      +'<label>开放给用户的文档目录（相对 docs，每行一个；md 始终可选）<textarea data-document-folders rows="3">md</textarea></label>'
      +'<label><input type="checkbox" data-daily-enabled checked>启用 SVN 每日更新</label> <label>更新时间（北京时间）<input type="time" data-daily-time value="03:00"></label>'
      +'<p>每个版本目录可以填写 SVN URL、revision（HEAD 或数字）及同步账号。URL 留空表示已有本地代码目录；账号和密码同时留空时沿用默认同步凭据。</p>'
      +'<div data-repos></div><button data-add-repo>新增代码版本目录</button>'
      +'<details open><summary>公共 AI 配置 JSON（可直接编辑）</summary><textarea data-json rows="16" style="width:100%;font-family:monospace"></textarea></details>'
      +'<button data-save>保存公共配置</button><button data-purge>清理停用的个人配置</button><p data-status role="status"></p></div></section>';
    document.body.appendChild(box);state.configOverlay=box;
    box.querySelector('[data-close]').onclick=closeConfig;
    var area=box.querySelector('[data-json]'),status=box.querySelector('[data-status]'),version='',syncState={};
    function api(url,method,body){return fetch(url,{method:method||'GET',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':SiteAuth.csrfToken()},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.message||d.error);return d;});});}
    function read(){var value=JSON.parse(area.value);if(Object.keys(value).some(function(key){return key!=='claude';}))throw new Error('这里只配置 claude 命令与目录，不配置 API');value.claude=value.claude||{};value.claude.repositories=value.claude.repositories||[];return value;}
    function write(value){area.value=JSON.stringify(value,null,2);}
    function render(){
      var value=read(),settings=value.claude;
      box.querySelector('[data-claude-enabled]').checked=settings.enabled===true;
      box.querySelector('[data-claude-executable]').value=settings.executable||'claude';
      box.querySelector('[data-claude-timeout]').value=settings.timeoutSeconds||120;
      box.querySelector('[data-code-folder]').value=settings.codeFolder||'code';
      box.querySelector('[data-document-folders]').value=(settings.documentFolders||['md']).join('\n');
      box.querySelector('[data-daily-enabled]').checked=settings.dailySyncEnabled!==false;
      box.querySelector('[data-daily-time]').value=settings.dailySyncTime||'03:00';
      var host=box.querySelector('[data-repos]');host.textContent='';
      settings.repositories.forEach(function(repo,index){
        var card=document.createElement('fieldset'),legend=document.createElement('legend');legend.textContent='代码仓库 '+repositoryLabel(repo);card.appendChild(legend);
        [['id','ID'],['name','名称'],['folder','代码根目录下的相对目录'],['url','SVN URL（本地目录留空）'],['revision','SVN 版本'],['username','同步账号'],['password','同步密码']].forEach(function(field){
          var label=document.createElement('label'),input=document.createElement('input');label.textContent=field[1]+' ';input.type=field[0]==='password'?'password':'text';input.autocomplete='off';input.value=repo[field[0]]||'';input.setAttribute('data-code-repo-field',field[0]);
          input.oninput=function(){try{var current=read();current.claude.repositories[index][field[0]]=input.value;write(current);}catch(e){status.textContent='请先修正 JSON：'+e.message;}};label.appendChild(input);card.appendChild(label);
        });
        var daily=document.createElement('input'),label=document.createElement('label');daily.type='checkbox';daily.checked=repo.dailySync!==false;daily.onchange=function(){var current=read();current.claude.repositories[index].dailySync=daily.checked;write(current);};label.appendChild(daily);label.appendChild(document.createTextNode('此 SVN 库每日更新'));card.appendChild(label);
        var sync=document.createElement('button');sync.textContent='同步已保存的 SVN 配置';sync.disabled=!repo.url;sync.onclick=function(){sync.disabled=true;status.textContent='正在更新已保存配置对应的 SVN 库…';api('__admin/code-repositories/'+encodeURIComponent(repo.id)+'/sync','POST',{}).then(function(d){status.textContent='同步成功 r'+d.revision;}).catch(function(e){status.textContent=e.message;}).then(function(){sync.disabled=!repo.url;});};card.appendChild(sync);
        var remove=document.createElement('button');remove.textContent='移除配置（保留磁盘目录）';remove.onclick=function(){var current=read();current.claude.repositories.splice(index,1);current.claude.defaultRepository='';write(current);render();};card.appendChild(remove);
        var info=document.createElement('p'),record=syncState[repo.id]||{};info.textContent=record.error|| (record.lastSuccessDate?'最近成功：'+record.lastSuccessDate+'，版本 '+record.revision:'尚无更新记录');card.appendChild(info);host.appendChild(card);
      });
    }
    function controls(){try{var value=read();value.claude.enabled=box.querySelector('[data-claude-enabled]').checked;value.claude.executable=box.querySelector('[data-claude-executable]').value.trim()||'claude';var timeout=Math.round(Number(box.querySelector('[data-claude-timeout]').value));value.claude.timeoutSeconds=isFinite(timeout)&&timeout?Math.min(600,Math.max(5,timeout)):120;value.claude.codeFolder=box.querySelector('[data-code-folder]').value.trim();value.claude.documentFolders=box.querySelector('[data-document-folders]').value.split(/\r?\n/).map(function(p){return p.trim();}).filter(Boolean);value.claude.dailySyncEnabled=box.querySelector('[data-daily-enabled]').checked;value.claude.dailySyncTime=box.querySelector('[data-daily-time]').value;write(value);}catch(e){status.textContent='请先修正 JSON：'+e.message;}}
    ['[data-claude-enabled]','[data-claude-executable]','[data-claude-timeout]','[data-code-folder]','[data-document-folders]','[data-daily-enabled]','[data-daily-time]'].forEach(function(selector){box.querySelector(selector).oninput=controls;});
    area.onchange=function(){try{render();}catch(e){status.textContent='JSON 格式错误：'+e.message;}};
    box.querySelector('[data-add-repo]').onclick=function(){try{var value=read(),number=value.claude.repositories.length+1,id='code-'+number;while(value.claude.repositories.some(function(r){return r.id===id;})){id='code-'+(++number);}value.claude.repositories.push({id:id,name:'代码版本 '+number,folder:id,url:'',revision:'HEAD',username:'',password:'',dailySync:true});write(value);render();}catch(e){status.textContent=e.message;}};
    api('__config').then(function(data){version=(data.config||data).expectedConfigVersion||'';var ai={claude:((data.config||data).ai||{}).claude};ai.claude=ai.claude||{enabled:false,executable:'claude',timeoutSeconds:120,repositories:[]};write(ai);render();return api('__admin/code-repositories');}).then(function(data){syncState=data.state||{};render();}).catch(function(e){status.textContent=e.message;});
    box.querySelector('[data-purge]').onclick=function(){api('__admin/ai/personal-configs/clear','POST',{}).then(function(d){status.textContent='已清理 '+d.cleared+' 项旧个人配置';}).catch(function(e){status.textContent=e.message;});};
    box.querySelector('[data-save]').onclick=function(){try{var value=read();value.claude.defaultRepository='';value.expectedConfigVersion=version;api('__admin/ai','PUT',value).then(function(data){version=(data.config||{}).expectedConfigVersion||version;write({claude:data.ai.claude});render();status.textContent='已保存到私有 JSON，Claude 问答与每日更新配置立即生效';}).catch(function(e){status.textContent=e.message;});}catch(e){status.textContent='JSON 格式错误：'+e.message;}};
  }

  function closeConfig() {
    if (state.configOverlay) { state.configOverlay.remove();state.configOverlay=null; }
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
        var scopeDialog=state.overlay && state.overlay.querySelector('.ai-scope-dialog[open]');if(scopeDialog){scopeDialog.close();event.preventDefault();return;}
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
    ready: function(){return syncPersonalConfig();},
    buildContext: function (question, limit) {
      return retrieve(question, limit).then(function (hits) {
        return { hits: hits, context: window.AIRetrieval.buildContext(hits, 6000) };
      });
    },
    scopeTree: function () {
      return loadCorpus().then(function () {
        return window.AIRetrieval.scopeTree(mergedCorpus(), state.config.uploads);
      });
    }
  };
}());
