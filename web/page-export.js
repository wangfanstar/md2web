(function () {
  'use strict';

  var PAGE_STYLE = [
    ':root { color-scheme: light; }',
    '* { box-sizing: border-box; }',
    'body { background: #fff; color: #1f2a37; font: 15px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif; margin: 0; }',
    '.page { margin: 0 auto; max-width: 900px; padding: 40px 24px 80px; }',
    '.page-meta { color: #6b7a89; font-family: ui-monospace, Consolas, monospace; font-size: 12px; margin: 6px 0 24px; }',
    '.page-toc { background: #f6f8fa; border: 1px solid #e3e8ee; border-radius: 8px; margin: 0 0 28px; padding: 14px 18px; }',
    '.page-toc strong { display: block; font-size: 13px; margin-bottom: 8px; }',
    '.page-toc ol { list-style: none; margin: 0; padding: 0; }',
    '.page-toc li { font-size: 13px; margin: 3px 0; }',
    '.page-toc .toc-level-3 { padding-left: 16px; }',
    '.page-toc .toc-level-4 { padding-left: 32px; }',
    '.page-toc a { color: #1f6feb; text-decoration: none; }',
    'h1, h2, h3, h4 { line-height: 1.35; margin: 1.6em 0 .6em; }',
    'h1 { font-size: 26px; margin-top: 0; }',
    'h2 { border-bottom: 1px solid #e3e8ee; font-size: 21px; padding-bottom: .3em; }',
    'h3 { font-size: 17px; }',
    'h4 { font-size: 15px; }',
    'p, ul, ol, table, pre, blockquote { margin: 0 0 1em; }',
    'a { color: #1f6feb; }',
    'code { background: #f2f4f7; border-radius: 4px; font-family: ui-monospace, Consolas, monospace; font-size: .9em; padding: 2px 5px; }',
    'pre { background: #f6f8fa; border: 1px solid #e3e8ee; border-radius: 8px; overflow: auto; padding: 14px 16px; }',
    'pre code { background: transparent; padding: 0; }',
    'table { border-collapse: collapse; width: 100%; }',
    'th, td { border: 1px solid #e3e8ee; padding: 7px 10px; text-align: left; vertical-align: top; }',
    'th { background: #f6f8fa; }',
    'blockquote { border-left: 3px solid #d7dee6; color: #5b6b7c; margin-left: 0; padding: 4px 0 4px 14px; }',
    'img, svg, canvas { height: auto; max-width: 100%; }',
    '.mermaid, .packetdiag-figure { margin: 18px 0; text-align: center; }',
    'hr { border: 0; border-top: 1px solid #e3e8ee; margin: 28px 0; }'
  ].join('\n');

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function pageTitle() {
    var heading = document.querySelector('.markdown-section h1');
    if (heading && String(heading.textContent || '').trim()) {
      return String(heading.textContent).trim();
    }
    return document.title || '文档';
  }

  function pageRoute() {
    var hash = String(window.location.hash || '').replace(/^#/, '').split('?')[0];
    try {
      return decodeURIComponent(hash.replace(/^\/+/, '')) || 'README.md';
    } catch (error) {
      return hash.replace(/^\/+/, '') || 'README.md';
    }
  }

  function cloneArticle() {
    var section = document.querySelector('.markdown-section');
    if (!section) {
      return null;
    }
    var clone = section.cloneNode(true);
    Array.prototype.forEach.call(
      clone.querySelectorAll('.workspace-breadcrumb, .workspace-page-actions, .search-reading-toolbar, .workspace-copy-code, .search-section-arrow, .search-section-badge, .search-section-body'),
      function (node) { node.remove(); }
    );
    Array.prototype.forEach.call(clone.querySelectorAll('canvas'), function (canvas) {
      var image = document.createElement('img');
      try {
        image.src = canvas.toDataURL('image/png');
      } catch (error) {
        image.src = '';
      }
      image.alt = canvas.getAttribute('aria-label') || '图形';
      canvas.parentNode.replaceChild(image, canvas);
    });
    Array.prototype.forEach.call(clone.querySelectorAll('h1 > .anchor, h2 > .anchor, h3 > .anchor, h4 > .anchor, h5 > .anchor, h6 > .anchor'), function (anchor) {
      var heading = anchor.parentNode;
      if (heading && heading.id) {
        anchor.setAttribute('href', '#' + heading.id);
      }
    });
    return clone;
  }

  function buildToc(root) {
    var headings = Array.prototype.slice.call(root.querySelectorAll('h2, h3, h4')).filter(function (heading) {
      return heading.id;
    });
    if (!headings.length) {
      return '';
    }
    var items = headings.map(function (heading) {
      var level = parseInt(heading.tagName.slice(1), 10);
      return '<li class="toc-level-' + level + '"><a href="#' + escapeHtml(heading.id) + '">' +
        escapeHtml(String(heading.textContent || '').trim()) + '</a></li>';
    });
    return '<nav class="page-toc"><strong>本文目录</strong><ol>' + items.join('') + '</ol></nav>';
  }

  function readAsDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function inlineImages(root) {
    var images = Array.prototype.slice.call(root.querySelectorAll('img'));
    return Promise.all(images.map(function (image) {
      if (!image.src || image.src.indexOf('data:') === 0) {
        return null;
      }
      return fetch(image.src).then(function (response) {
        if (!response.ok) {
          return null;
        }
        return response.blob();
      }).then(function (blob) {
        if (!blob) {
          return null;
        }
        return readAsDataUrl(blob).then(function (dataUrl) { image.src = dataUrl; });
      }).catch(function () { /* 保留原始路径 */ });
    }));
  }

  function saveHtml(html, filename) {
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function download() {
    var article = cloneArticle();
    if (!article) {
      return;
    }
    var title = pageTitle();
    var route = pageRoute();
    inlineImages(article).then(function () {
      var html = [
        '<!DOCTYPE html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        '<title>' + escapeHtml(title) + '</title>',
        '<style>',
        PAGE_STYLE,
        '</style>',
        '</head>',
        '<body>',
        '<article class="page">',
        '<h1>' + escapeHtml(title) + '</h1>',
        '<p class="page-meta">来源：docs/md/' + escapeHtml(route) + ' · 导出于 ' +
          escapeHtml(new Date().toLocaleString()) + '</p>',
        buildToc(article),
        article.innerHTML,
        '</article>',
        '</body>',
        '</html>'
      ].join('\n');
      saveHtml(html, (route.split('/').pop() || 'document').replace(/\.md$/i, '') + '.html');
    });
  }

  window.PageExport = { download: download };
}());
