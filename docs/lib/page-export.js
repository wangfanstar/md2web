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
    'hr { border: 0; border-top: 1px solid #e3e8ee; margin: 28px 0; }',
    'body { margin: 0 0 0 268px; }',
    '.page-toc { background: #fbfcfe; border-right: 1px solid #e3e8ee; bottom: 0; left: 0;',
    '  overflow: auto; padding: 22px 16px 32px; position: fixed; top: 0; width: 268px; }',
    '.page-toc strong { color: #24344a; display: block; font-size: 13px; margin-bottom: 10px; }',
    '.page-toc ol { list-style: none; margin: 0; padding: 0; }',
    '.page-toc li { margin: 0 0 2px; }',
    '.page-toc a { border-radius: 5px; color: #44556b; display: block; font-size: 12.5px;',
    '  line-height: 1.5; overflow: hidden; padding: 3px 6px; text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }',
    '.page-toc a:hover { background: #eef2f6; color: #1f6feb; }',
    '.page-toc .toc-level-3 { padding-left: 14px; }',
    '.page-toc .toc-level-4 { padding-left: 28px; }',
    '.page { margin: 0 auto; max-width: 1000px; padding: 30px 40px 60px; }',
    '@media (max-width: 900px) {',
    '  .page-toc { border-bottom: 1px solid #e3e8ee; border-right: 0; position: static; width: auto; }',
    '  body { margin-left: 0; }',
    '  .page { padding: 20px 18px 48px; }',
    '}'
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
    if (window.PacketDiagEnsureRendered) {
      window.PacketDiagEnsureRendered(section);
    }
    if(window.SiteNumbering)window.SiteNumbering.apply();
    var clone = section.cloneNode(true);
    Array.prototype.forEach.call(
      clone.querySelectorAll('.workspace-breadcrumb, .workspace-page-actions, .workspace-svn-controls, .search-reading-toolbar, .workspace-copy-code, .search-section-arrow, .search-section-badge, .search-section-body'),
      function (node) { node.remove(); }
    );
    Array.prototype.forEach.call(clone.querySelectorAll('canvas'), function (canvas) {
      var image = document.createElement('img');
      var dataUrl = '';
      var figure = canvas.closest ? canvas.closest('.packetdiag-figure') : null;
      if (figure && window.PacketDiagRerender) {
        // 重新绘制一份，避免导出时画布尚未绘制导致的空白图
        dataUrl = window.PacketDiagRerender(figure, Math.max(560, figure.clientWidth || 864));
      }
      if (!dataUrl) {
        try {
          dataUrl = canvas.toDataURL('image/png');
        } catch (error) {
          dataUrl = '';
        }
      }
      image.src = dataUrl;
      image.alt = canvas.getAttribute('aria-label') || '图形';
      if (canvas.width) {
        image.setAttribute('width', String(canvas.width));
      }
      canvas.parentNode.replaceChild(image, canvas);
    });
    Array.prototype.forEach.call(clone.querySelectorAll('h1 > .anchor, h2 > .anchor, h3 > .anchor, h4 > .anchor, h5 > .anchor, h6 > .anchor'), function (anchor) {
      var heading = anchor.parentNode;
      if (heading && heading.id) {
        anchor.setAttribute('href', '#' + heading.id);
      }
    });
    Array.prototype.forEach.call(clone.querySelectorAll('[data-workspace-number]'),function(heading){heading.insertBefore(document.createTextNode(heading.getAttribute('data-workspace-number')+' '),heading.firstChild);});
    return clone;
  }

  function buildToc(root) {
    var headings = Array.prototype.slice.call(root.querySelectorAll('h1[data-workspace-number], h2, h3, h4, h5[data-workspace-number], h6[data-workspace-number]')).filter(function (heading) {
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
        buildToc(article),
        '<article class="page">',
        '<h1>' + escapeHtml(title) + '</h1>',
        '<p class="page-meta">来源：docs/md/' + escapeHtml(route) + ' · 导出于 ' +
          escapeHtml(new Date().toLocaleString()) + '</p>',
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

// Formatted clipboard support shares this existing asset for deployed entry pages.
(function () {
  'use strict';

  var CHROME = '.workspace-breadcrumb, .workspace-page-actions, .workspace-svn-controls, .workspace-doc-updated, .search-reading-toolbar, .workspace-copy-code, .search-section-arrow, .search-section-badge';
  var STYLES = {
    h1: 'font-size:26pt;font-weight:bold;margin:18pt 0 12pt;',
    h2: 'font-size:20pt;font-weight:bold;margin:16pt 0 10pt;',
    h3: 'font-size:16pt;font-weight:bold;margin:14pt 0 8pt;',
    h4: 'font-size:14pt;font-weight:bold;margin:12pt 0 6pt;',
    p: 'margin:0 0 10pt;line-height:1.6;',
    table: 'border-collapse:collapse;margin:10pt 0;width:100%;',
    th: 'border:1px solid #b8c2cc;padding:6pt 8pt;background-color:#f2f4f7;font-weight:bold;text-align:left;',
    td: 'border:1px solid #b8c2cc;padding:6pt 8pt;vertical-align:top;',
    pre: 'white-space:pre-wrap;background-color:#f6f8fa;padding:10pt;font-family:Consolas,monospace;',
    code: 'font-family:Consolas,monospace;white-space:pre-wrap;',
    blockquote: 'margin:8pt 0;padding-left:12pt;border-left:3px solid #c5cdd5;color:#506174;',
    ul: 'margin:0 0 10pt;padding-left:24pt;',
    ol: 'margin:0 0 10pt;padding-left:24pt;',
    li: 'margin:3pt 0;',
    a: 'color:#1f6feb;text-decoration:underline;',
    img: 'max-width:100%;vertical-align:middle;'
  };
  function nodes(root, selector) { return Array.prototype.slice.call(root.querySelectorAll(selector)); }
  function dataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  function imageFor(url, width, height, alt) {
    var image = document.createElement('img');
    image.src = url;
    image.alt = alt || '图形';
    if (width) image.width = Math.max(1, Math.round(width));
    if (height) image.height = Math.max(1, Math.round(height));
    image.style.cssText = STYLES.img;
    return image;
  }
  function rasterMath(node) {
    var math = node.querySelector('math');
    if (!math) return Promise.reject(new Error('公式缺少 MathML'));
    var copy = math.cloneNode(true), annotation = copy.querySelector('annotation');
    var alt = annotation ? annotation.textContent : copy.textContent;
    nodes(copy, 'annotation, annotation-xml').forEach(function (n) { n.remove(); });
    copy.setAttribute('xmlns', 'http://www.w3.org/1998/Math/MathML');
    // Native MathML keeps formula layout without depending on KaTeX web fonts
    // in the receiving application. Copy the result as a high-resolution PNG.
    var holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:max-content;padding:4px;background:white;color:black;font-size:18px;';
    holder.appendChild(copy);
    document.body.appendChild(holder);
    var box = holder.getBoundingClientRect(), width = Math.ceil(box.width), height = Math.ceil(box.height);
    var markup = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="padding:4px;background:white;color:black;font-size:18px;">' + new XMLSerializer().serializeToString(copy) + '</div></foreignObject></svg>';
    holder.remove();
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = width * 2; canvas.height = height * 2;
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(imageFor(canvas.toDataURL('image/png'), width, height, alt));
        } catch (error) { reject(error); }
      };
      image.onerror = function () { reject(new Error('公式图片生成失败')); };
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    });
  }
  function plainText(root) {
    var copy = root.cloneNode(true);
    nodes(copy, 'img').forEach(function (image) { image.replaceWith(document.createTextNode(image.alt || '')); });
    copy.style.cssText += ';position:fixed;left:-100000px;top:0;width:900px;';
    document.body.appendChild(copy);
    var text = copy.innerText;
    copy.remove();
    return text;
  }
  function prepare() {
    var section = document.querySelector('.markdown-section');
    if (!section) return Promise.reject(new Error('当前没有可复制的正文'));
    if(window.SiteNumbering)window.SiteNumbering.apply();
    if (window.PacketDiagEnsureRendered) window.PacketDiagEnsureRendered(section);
    var root = section.cloneNode(true), originals = nodes(section, '*'), copies = nodes(root, '*');
    // Carry text colors (including syntax highlighting) without the site's
    // layout, CSS variables, sticky controls or dark backgrounds.
    copies.forEach(function (node, i) {
      if (node.namespaceURI === 'http://www.w3.org/2000/svg') {
        if (node.tagName.toLowerCase() === 'svg') {
          var size = originals[i].getBoundingClientRect();
          if (size.width) { node.setAttribute('width', size.width); node.setAttribute('height', size.height); }
        }
        return;
      }
      var style = getComputedStyle(originals[i]);
      node.removeAttribute('style');
      node.style.cssText = STYLES[node.tagName.toLowerCase()] || '';
      if (node.classList.contains('katex-display')) node.style.cssText += 'display:block;text-align:center;margin:10pt 0;';
      if (/^(SPAN|STRONG|EM|DEL|CODE)$/.test(node.tagName)) {
        node.style.color = style.color;
        node.style.fontWeight = style.fontWeight;
        node.style.fontStyle = style.fontStyle;
        node.style.textDecoration = style.textDecorationLine;
      }
      if (node.tagName === 'IMG') {
        var rect = originals[i].getBoundingClientRect();
        node.src = originals[i].src;
        if (rect.width) { node.width = Math.round(rect.width); node.height = Math.round(rect.height); }
      }
    });
    var jobs = [], warnings = 0;
    nodes(root, 'canvas').forEach(function (canvas, i) {
      try {
        var original = section.querySelectorAll('canvas')[i];
        canvas.replaceWith(imageFor(original.toDataURL('image/png'), original.clientWidth || original.width, original.clientHeight || original.height, original.getAttribute('aria-label')));
      } catch (error) { warnings++; canvas.replaceWith(document.createTextNode('[画布无法复制]')); }
    });
    nodes(root, '.katex').forEach(function (math) {
      jobs.push(rasterMath(math).then(function (image) { math.replaceWith(image); }).catch(function () {
        var annotation = math.querySelector('annotation');
        math.replaceWith(document.createTextNode(annotation ? annotation.textContent : math.textContent));
        warnings++;
      }));
    });
    nodes(root, 'svg').filter(function (svg) { return !svg.closest('.katex'); }).forEach(function (svg) {
      if (!window.MediaViewer || !window.MediaViewer.svgToPngBlob) { warnings++; return; }
      var box = svg.viewBox && svg.viewBox.baseVal;
      var width = parseFloat(svg.getAttribute('width')) || (box && box.width) || 800;
      var height = parseFloat(svg.getAttribute('height')) || (box && box.height) || 300;
      width = Math.min(width, 900);
      if (box && box.width) height = width * box.height / box.width;
      jobs.push(window.MediaViewer.svgToPngBlob(svg, width, height, 2).then(dataUrl).then(function (url) {
        svg.replaceWith(imageFor(url, width, height, '图表'));
      }).catch(function () { warnings++; }));
    });
    nodes(root, CHROME + ', script, style, iframe, object, embed, button, textarea, select').forEach(function (n) { n.remove(); });
    // Keep all paragraphs in collapsible sections, including collapsed ones.
    nodes(root, '.search-section-body').forEach(function (wrapper) { wrapper.replaceWith.apply(wrapper, Array.prototype.slice.call(wrapper.childNodes)); });
    nodes(root, 'input').forEach(function (input) { input.replaceWith(document.createTextNode(input.type === 'checkbox' ? (input.checked ? '☑ ' : '☐ ') : '')); });
    nodes(root, 'h1 > a.anchor, h2 > a.anchor, h3 > a.anchor, h4 > a.anchor, h5 > a.anchor, h6 > a.anchor').forEach(function (anchor) { anchor.replaceWith.apply(anchor, Array.prototype.slice.call(anchor.childNodes)); });
    if (window.SiteNumbering) {
      nodes(root,'h1[data-workspace-number],h2[data-workspace-number],h3[data-workspace-number],h4[data-workspace-number],h5[data-workspace-number],h6[data-workspace-number]').forEach(function(heading){
        heading.insertBefore(document.createTextNode(heading.getAttribute('data-workspace-number')+' '),heading.firstChild);
      });
    } else if (!document.body.classList.contains('hide-heading-numbers')) {
      var counts = [0, 0, 0];
      nodes(root, 'h2, h3, h4').forEach(function (heading) {
        var level = Number(heading.tagName.slice(1)) - 2;
        counts[level]++;
        for (var deeper = level + 1; deeper < 3; deeper++) counts[deeper] = 0;
        heading.insertBefore(document.createTextNode(counts.slice(0, level + 1).join('.') + (level === 0 ? '. ' : ' ')), heading.firstChild);
      });
    }
    nodes(root, 'a[href]').forEach(function (link) {
      var value = link.getAttribute('href');
      try { var url = new URL(value, document.baseURI); if (/^(https?:|file:|mailto:)$/.test(url.protocol)) link.href = url.href; else link.removeAttribute('href'); }
      catch (error) { link.removeAttribute('href'); }
    });
    nodes(root, '*').forEach(function (node) {
      Array.prototype.slice.call(node.attributes).forEach(function (attr) { if (/^(on|data-)/i.test(attr.name) || /^(id|class|hidden|contenteditable)$/.test(attr.name)) node.removeAttribute(attr.name); });
    });
    root.removeAttribute('id'); root.removeAttribute('class');
    root.style.cssText = 'font-family:"Microsoft YaHei",Calibri,Arial,sans-serif;font-size:11pt;color:#1f2a37;background:white;line-height:1.6;';
    return Promise.all(jobs).then(function () {
      return Promise.all(nodes(root, 'img').map(function (image) {
        if (!image.src || /^data:/i.test(image.src)) return;
        return fetch(image.src).then(function (response) { if (!response.ok) throw new Error('图片读取失败'); return response.blob(); }).then(dataUrl).then(function (url) { image.src = url; }).catch(function () { warnings++; });
      }));
    }).then(function () {
      return {html: '<html><head><meta charset="utf-8"></head><body><!--StartFragment-->' + root.outerHTML + '<!--EndFragment--></body></html>', text: plainText(root), warnings: warnings};
    });
  }
  function legacyCopy(data) {
    var selection = window.getSelection(), ranges = [], focus = document.activeElement;
    if (selection) for (var i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange());
    var holder = document.createElement('div');
    holder.contentEditable = 'true';
    holder.style.cssText = 'position:fixed;left:-100000px;top:0;';
    holder.innerHTML = data.html;
    var handled = false;
    function onCopy(event) {
      if (!event.clipboardData) return;
      event.clipboardData.setData('text/html', data.html);
      event.clipboardData.setData('text/plain', data.text);
      event.preventDefault(); handled = true;
    }
    try {
      document.body.appendChild(holder);
      var range = document.createRange(); range.selectNodeContents(holder);
      selection.removeAllRanges(); selection.addRange(range);
      document.addEventListener('copy', onCopy);
      if (!document.execCommand('copy') || !handled) throw new Error('浏览器未允许复制，请选中正文后按 Ctrl+C');
    } finally {
      document.removeEventListener('copy', onCopy); holder.remove();
      if (focus && focus.focus) focus.focus({preventScroll:true});
      if (selection) { selection.removeAllRanges(); ranges.forEach(function (saved) { selection.addRange(saved); }); }
    }
    return data;
  }
  function copy(button) {
    if (button && button.disabled) return Promise.resolve();
    var label = '复制本页内容';
    if (button) { clearTimeout(button._copyResetTimer); button.disabled = true; button.textContent = '正在复制…'; }
    var prepared;
    try { prepared = prepare(); } catch (error) { prepared = Promise.reject(error); }
    var result;
    try {
      if (!navigator.clipboard || !navigator.clipboard.write || !window.ClipboardItem) throw new Error('使用兼容复制');
      var item = new window.ClipboardItem({
        'text/html': prepared.then(function (data) { return new Blob([data.html], {type:'text/html'}); }),
        'text/plain': prepared.then(function (data) { return new Blob([data.text], {type:'text/plain'}); })
      });
      result = navigator.clipboard.write([item]).then(function () { return prepared; }).catch(function () { return prepared.then(legacyCopy); });
    } catch (error) { result = prepared.then(legacyCopy); }
    return result.then(function (data) {
      if (button) { button.textContent = data.warnings ? '已复制（部分图形未内嵌）' : '已复制，保留格式粘贴'; button.title = '在 Word 中粘贴时选择“保留源格式”'; }
      return data;
    }).catch(function (error) {
      if (button) { button.textContent = '复制失败，请重试'; button.title = error.message; }
      else throw error;
    }).then(function (data) {
      if (button) { button.disabled = false; button._copyResetTimer = setTimeout(function () { button.textContent = label; }, 4000); }
      return data;
    });
  }
  window.PageCopy = {copy:copy, prepare:prepare};
}());
