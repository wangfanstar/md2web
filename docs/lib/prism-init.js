(function () {
  'use strict';

  if (!window.Prism || !window.Prism.plugins || !window.Prism.plugins.autoloader) {
    return;
  }

  var autoloader = window.Prism.plugins.autoloader;

  // 纯文本围栏（text/plain/txt）由 Prism 核心处理：注册空语法，
  // 避免 autoloader 在运行时请求并不存在的 prism-text.min.js
  ['text', 'plain', 'plaintext', 'txt'].forEach(function (name) {
    if (!Prism.languages[name]) {
      Prism.languages[name] = {};
    }
  });

  // docsify 的代码渲染直接在渲染期调用 Prism.highlight，
  // 因此必须在 beforeEach 阶段先把围栏语言组件载入，否则只会回退为 markup 高亮。
  function fenceLanguages(markdown) {
    var found = [];
    var pattern = /^[ \t]*(?:```|~~~)[ \t]*([A-Za-z0-9_+#.-]+)/gm;
    var match;
    while ((match = pattern.exec(String(markdown || '')))) {
      var name = match[1].toLowerCase();
      if (name && name !== 'mermaid' && name !== 'packetdiag' && ['text', 'plain', 'plaintext', 'txt'].indexOf(name) === -1 && found.indexOf(name) === -1) {
        found.push(name);
      }
    }
    return found;
  }

  window.$docsify = window.$docsify || {};
  window.$docsify.plugins = (window.$docsify.plugins || []).concat(function (hook) {
    hook.beforeEach(function (markdown, next) {
      var missing = fenceLanguages(markdown).filter(function (name) {
        return !Prism.languages[name];
      });
      if (!missing.length) {
        next(markdown);
        return;
      }
      autoloader.loadLanguages(missing, function () {
        next(markdown);
      }, function () {
        next(markdown);
      });
    });
  });
}());
