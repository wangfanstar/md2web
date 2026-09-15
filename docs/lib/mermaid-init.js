(function () {
  'use strict';

  if (!window.mermaid) {
    return;
  }

  // mermaid 围栏由本插件渲染；预注册语言可避免 Prism autoloader 请求不存在的 prism-mermaid 组件
  if (window.Prism && Prism.languages && !Prism.languages.mermaid) {
    Prism.languages.mermaid = Prism.languages.markup;
  }

  window.mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: {
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif',
      primaryColor: '#eef4fd',
      primaryBorderColor: '#1f6feb',
      primaryTextColor: '#1f2a37',
      lineColor: '#5b6b7c',
      secondaryColor: '#f4f7fa',
      tertiaryColor: '#ffffff'
    },
    flowchart: { curve: 'basis', useMaxWidth: true, htmlLabels: false },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true }
  });

  function isMermaidBlock(code) {
    var className = ' ' + String(code.className || '') + ' ';
    return / (language|lang)-mermaid /.test(className);
  }

  function restoreMermaidBlock(entry) {
    if (!entry.container.isConnected || !entry.container.parentNode) {
      return;
    }
    var pre = document.createElement('pre');
    pre.setAttribute('data-lang', 'mermaid');
    var code = document.createElement('code');
    code.className = 'lang-mermaid';
    code.textContent = entry.text;
    pre.appendChild(code);
    entry.container.parentNode.replaceChild(pre, entry.container);
  }

  function renderMermaidBlocks() {
    var section = document.querySelector('.markdown-section');
    if (!section) {
      return;
    }
    var blocks = Array.prototype.slice.call(section.querySelectorAll('pre > code')).filter(isMermaidBlock);
    if (!blocks.length) {
      return;
    }
    var entries = blocks.map(function (code) {
      var pre = code.parentNode;
      var container = document.createElement('div');
      container.className = 'mermaid';
      container.textContent = code.textContent;
      pre.parentNode.replaceChild(container, pre);
      return { container: container, text: code.textContent };
    });
    function fallbackToSource() {
      entries.forEach(function (entry) {
        if (!entry.container.querySelector('svg')) {
          restoreMermaidBlock(entry);
        }
      });
    }
    window.mermaid.run({
      nodes: entries.map(function (entry) { return entry.container; }),
      suppressErrors: true
    }).then(fallbackToSource).catch(function (error) {
      fallbackToSource();
      if (window.console && console.warn) {
        console.warn('mermaid 渲染失败，已回退显示源码', error);
      }
    });
  }

  window.$docsify = window.$docsify || {};
  window.$docsify.plugins = (window.$docsify.plugins || []).concat(function (hook) {
    hook.doneEach(function () {
      renderMermaidBlocks();
    });
  });
}());
