(function () {
  'use strict';

  var FALLBACK_ALLOWED_URL = /^(https?:|mailto:|#|\/|\.\/|\.\.\/|[\w\u4e00-\u9fff][^:]*$)/i;
  // 编辑器「文字颜色」用 <span style="color:..."> 实现：只放行 color 属性，其余样式一律移除
  var SAFE_COLOR_STYLE = /^\s*color\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\)|[a-zA-Z]{3,20})\s*;?\s*$/;

  function installStyleHook() {
    if (!window.DOMPurify || window.DOMPurify.__md2webStyleHook) {
      return;
    }
    window.DOMPurify.addHook('afterSanitizeAttributes', function (node) {
      if (!node || typeof node.getAttribute !== 'function' || !node.hasAttribute('style')) {
        return;
      }
      var style = node.getAttribute('style');
      var match = SAFE_COLOR_STYLE.exec(style);
      if (match) {
        node.setAttribute('style', 'color:' + match[1]);
      } else {
        node.removeAttribute('style');
      }
    });
    window.DOMPurify.__md2webStyleHook = true;
  }

  function fallbackSanitize(html) {
    var text = String(html || '');
    text = text.replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
    text = text.replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, '');
    text = text.replace(/<\s*([a-z][a-z0-9-]*)\b[^>]*>/gi, function (tag) {
      return tag.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    });
    text = text.replace(/(href|src)\s*=\s*(?:"|')\s*(javascript|data|vbscript):[^"']*(?:"|')/gi, function (match, attr) {
      return attr + '="#"';
    });
    text = text.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, function (match, quoted) {
      var safe = SAFE_COLOR_STYLE.exec(quoted.slice(1, -1));
      return safe ? ' style="color:' + safe[1] + '"' : '';
    });
    return text;
  }

  function sanitizeHtml(html) {
    if (window.DOMPurify) {
      installStyleHook();
      return window.DOMPurify.sanitize(String(html || ''), {
        USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
        ADD_ATTR: ['target', 'rel', 'colspan', 'rowspan', 'align', 'start'],
        FORBID_ATTR: ['srcset'],
        ALLOW_UNKNOWN_PROTOCOLS: false
      });
    }
    return fallbackSanitize(html);
  }

  function safeUrl(url) {
    var value = String(url || '').trim();
    return FALLBACK_ALLOWED_URL.test(value) ? value : '#';
  }

  window.Sanitize = {
    html: sanitizeHtml,
    url: safeUrl,
    available: function () { return !!window.DOMPurify; }
  };
}());
