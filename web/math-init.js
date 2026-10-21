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

  // Hide TeX from the Markdown parser: blank lines and backslash escapes belong
  // to TeX, not Markdown. Restore escaped text only after Markdown has rendered.
  function prepare(source) {
    source = String(source);
    var prefix = 'MD2WEBMATHTOKEN';
    while (source.indexOf(prefix) !== -1) prefix += 'X';
    var values = [];
    function escaped(index) {
      var count = 0;
      while (index > 0 && source.charAt(--index) === '\\') count++;
      return count % 2 === 1;
    }
    var pattern = /(^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2[~`]*[ \t]*(?:\n|$)|(?![\s\S])))|(`+)([^\n]*?)\3|\$\$|\\\[|\\\(|\$/gm;
    var output = '', cursor = 0, match;
    while ((match = pattern.exec(source))) {
      if (match[1] || match[3] || escaped(match.index)) continue;
      var left = match[0], right = left === '\\[' ? '\\]' : left === '\\(' ? '\\)' : left;
      var start = pattern.lastIndex, end = source.indexOf(right, start);
      while (end !== -1 && escaped(end)) end = source.indexOf(right, end + right.length);
      if (end === -1 || (left === '$' && source.slice(start, end).indexOf('\n') !== -1)) continue;
      var finish = end + right.length;
      values.push(source.slice(match.index, finish));
      output += source.slice(cursor, match.index) + prefix + (values.length - 1) + 'END';
      cursor = finish;
      pattern.lastIndex = finish;
    }
    output += source.slice(cursor);
    return {
      markdown: output,
      restore: function (html) {
        return html.replace(new RegExp(prefix + '(\\d+)END', 'g'), function (token, index) {
          if (values[index] === undefined) return token;
          return values[index].replace(/[&<>"']/g, function (c) {
            return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c];
          });
        });
      }
    };
  }

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
    prepare: prepare,
    render: renderMath
  };

  window.$docsify = window.$docsify || {};
  window.$docsify.plugins = (window.$docsify.plugins || []).concat(function (hook) {
    var prepared;
    hook.beforeEach(function (content) {
      prepared = prepare(content);
      return prepared.markdown;
    });
    hook.afterEach(function (html) {
      return prepared ? prepared.restore(html) : html;
    });
    hook.doneEach(function () {
      renderMath(document.querySelector('.markdown-section'));
    });
  });
}());
