(function () {
  'use strict';

  var FALLBACK_ALLOWED_URL = /^(https?:|mailto:|#|\/|\.\/|\.\.\/|[\w\u4e00-\u9fff][^:]*$)/i;

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
    return text;
  }

  function sanitizeHtml(html) {
    if (window.DOMPurify) {
      return window.DOMPurify.sanitize(String(html || ''), {
        USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
        ADD_ATTR: ['target', 'rel', 'colspan', 'rowspan', 'align', 'start'],
        FORBID_ATTR: ['style', 'srcset'],
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
