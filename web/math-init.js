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

  // Chinese labels often end in punctuation immediately followed by CJK text,
  // or contain a space before **. Both are rejected by standard emphasis rules.
  // Normalize only these plain-text labels; leave code, raw HTML and URLs alone.
  // Intraword asterisks (4*k, 参数*变量) are literal characters, but marked 1.x
  // still treats them as emphasis delimiters and breaks the surrounding strong.
  function escapeIntrawordAsterisks(text) {
    return text.replace(/([\u3400-\u9fffA-Za-z0-9])\*(?=[\u3400-\u9fffA-Za-z0-9])/g, '$1\\*');
  }

  function prepareStrong(source) {
    var pattern = /(^(?: {0,3}> ?)* {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^(?: {0,3}> ?)* {0,3}\2[~`]*[ \t]*(?:\n|$)|(?![\s\S])))|(^[ \t]{4}[^\n]*|^\t[^\n]*)|(`+)[\s\S]*?\4(?!`)|<(pre|code|script|style|textarea)\b[^>]*>[\s\S]*?<\/\5\s*>|<[^>\n]*>|\]\([^\n]*?\)|^ {0,3}\[[^\]\n]+\]:[^\n]*|\\[\s\S]|\*\*((?:(?!\*\*)[^<>`\n])+)\*\*/gmi;
    return source.replace(pattern, function (whole, fence, fenceMark, indent, ticks, tag, label, offset) {
      if (label === undefined || source.charAt(offset - 1) === '*' || source.charAt(offset + whole.length) === '*') return whole;
      var text = label.trim();
      if (!text) return whole;
      var next = source.charAt(offset + whole.length);
      var escaped = escapeIntrawordAsterisks(label);
      var hasIntraword = escaped !== label;
      // Labels with only emphasis asterisks keep the parser's normal nested markup.
      if (!hasIntraword && !/[\u3400-\u9fff]/.test(text)) return whole;
      var normalize = text !== label || (/[：，。！？；、）】》」』]$/.test(text) && /[\u3400-\u9fffA-Za-z0-9]/.test(next));
      if (normalize) return '<strong>' + text + '</strong>';
      return hasIntraword ? '**' + escaped + '**' : whole;
    });
  }

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
      markdown: prepareStrong(output),
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
