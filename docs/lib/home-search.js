(function () {
  'use strict';

  function init() {
    var input = document.querySelector('[data-master-search]');
    var host = document.querySelector('[data-home-ai]');
    if (!input || !host) return;
    var submit = document.querySelector('[data-home-submit]');
    var results = document.querySelector('[data-master-results]');
    var filter = document.querySelector('[data-master-repo-filter]');
    var match = document.querySelector('[data-master-mode]').parentNode;
    var hint = document.querySelector('.home-search .hint');
    var mode = 'search';
    var working = false;

    function selectMode(next, open) {
      mode = next;
      input.dataset.searchMode = mode;
      host.hidden = mode !== 'ai';
      results.hidden = mode === 'ai';
      filter.hidden = mode === 'ai';
      match.hidden = mode === 'ai';
      hint.textContent = mode === 'ai'
        ? '选择模型与查询范围后提问，回答将在下方逐段显示。Enter 发送。'
        : '搜索文档名和全文，可按仓库筛选。按 / 快速定位搜索框。';
      input.placeholder = mode === 'ai' ? '输入问题，结合知识库与代码寻找答案' : '搜索全部仓库（文档名和全文）';
      input.setAttribute('aria-label', mode === 'ai' ? 'AI 问题' : '搜索文档');
      submit.textContent = mode === 'ai' ? (working ? '正在回答…' : 'AI 提问') : '搜索';
      submit.disabled = mode === 'ai' && working;
      document.querySelectorAll('[data-home-mode]').forEach(function (button) {
        button.setAttribute('aria-pressed', String(button.dataset.homeMode === mode));
      });
      if (mode === 'ai' && open) window.AIAssistant.open();
      if (mode === 'search') input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function send() {
      if (mode === 'search') {
        input.dispatchEvent(new Event('md2web:search-submit'));
        return;
      }
      if (working || !input.value.trim()) return;
      working = true;
      selectMode(mode, false);
      Promise.resolve(window.AIAssistant.ask(input.value)).then(function () {
        working = false;
        selectMode(mode, false);
      }, function () {
        working = false;
        selectMode(mode, false);
      });
    }

    document.querySelectorAll('[data-home-mode]').forEach(function (button) {
      button.onclick = function () { selectMode(button.dataset.homeMode, true); };
    });
    document.addEventListener('md2web:ai-open', function () { selectMode('ai', false); });
    document.addEventListener('md2web:ai-close', function () { selectMode('search', false); });
    submit.onclick = send;
    document.addEventListener('keydown', function (event) {
      var editing = event.target.closest && event.target.closest('input,textarea,select,[contenteditable=true]');
      if (event.key === '/' && !editing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); input.focus(); input.select();
      }
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.isComposing && mode === 'ai') {
        event.preventDefault();
        send();
      }
    });
    selectMode('search', false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
