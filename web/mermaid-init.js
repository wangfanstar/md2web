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
    flowchart: { curve: 'basis', useMaxWidth: true },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true }
  });

  function isMermaidBlock(code) {
    var className = ' ' + String(code.className || '') + ' ';
    return / (language|lang)-mermaid /.test(className);
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
    var containers = blocks.map(function (code) {
      var pre = code.parentNode;
      var container = document.createElement('div');
      container.className = 'mermaid';
      container.textContent = code.textContent;
      pre.parentNode.replaceChild(container, pre);
      return container;
    });
    window.mermaid.run({ nodes: containers, suppressErrors: true }).catch(function (error) {
      if (window.console && console.warn) {
        console.warn('mermaid 渲染失败', error);
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
