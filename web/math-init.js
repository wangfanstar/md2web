(function () {
  'use strict';

  if (!window.renderMathInElement) {
    return;
  }

  // 与编辑器预览共用同一套分隔符配置：$...$、$$...$$、\(...\)、\[...\]
  var DELIMITERS = [
    { left: '$$', right: '$$', display: true },
    { left: '\\[', right: '\\]', display: true },
    { left: '$', right: '$', display: false },
    { left: '\\(', right: '\\)', display: false }
  ];

  function renderMath(root) {
    if (!root || !window.renderMathInElement) {
      return;
    }
    try {
      window.renderMathInElement(root, {
        delimiters: DELIMITERS,
        throwOnError: false,
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option']
      });
    } catch (error) {
      if (window.console && console.warn) {
        console.warn('数学公式渲染失败', error);
      }
    }
  }

  window.MathRender = {
    delimiters: DELIMITERS,
    render: renderMath
  };

  window.$docsify = window.$docsify || {};
  window.$docsify.plugins = (window.$docsify.plugins || []).concat(function (hook) {
    hook.doneEach(function () {
      renderMath(document.querySelector('.markdown-section'));
    });
  });
}());
