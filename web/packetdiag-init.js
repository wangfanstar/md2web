(function () {
  'use strict';

  if (!window.PacketDiag) {
    return;
  }

  // packetdiag 围栏由本插件渲染；预注册语言避免 Prism autoloader 请求不存在的组件
  if (window.Prism && Prism.languages && !Prism.languages.packetdiag) {
    Prism.languages.packetdiag = Prism.languages.markup;
  }

  var figures = [];
  var resizeTimer = 0;

  function isPacketBlock(code) {
    var className = ' ' + String(code.className || '') + ' ';
    return / (language|lang)-packetdiag /.test(className);
  }

  function renderFigure(entry) {
    if (!entry.figure.isConnected) {
      return false;
    }
    var width = Math.max(560, entry.figure.clientWidth - 2);
    try {
      var parsed = window.PacketDiag.parse(window.PacketDiag.extractSource(entry.source));
      window.PacketDiag.render(parsed, entry.canvas, { fitWidth: true, width: width });
      entry.figure.classList.remove('has-error');
      entry.figure.removeAttribute('data-error');
      return true;
    } catch (error) {
      entry.figure.classList.add('has-error');
      entry.figure.setAttribute('data-error', error && error.message ? error.message : String(error));
      return false;
    }
  }

  function restoreSource(entry) {
    if (!entry.figure.isConnected || !entry.figure.parentNode) {
      return;
    }
    var pre = document.createElement('pre');
    pre.setAttribute('data-lang', 'packetdiag');
    var code = document.createElement('code');
    code.className = 'lang-packetdiag';
    code.textContent = entry.source;
    pre.appendChild(code);
    entry.figure.parentNode.replaceChild(pre, entry.figure);
  }

  function renderPacketBlocks() {
    var section = document.querySelector('.markdown-section');
    if (!section) {
      return;
    }
    var blocks = Array.prototype.slice.call(section.querySelectorAll('pre > code')).filter(isPacketBlock);
    if (!blocks.length) {
      return;
    }
    blocks.forEach(function (code) {
      var pre = code.parentNode;
      var figure = document.createElement('figure');
      figure.className = 'packetdiag-figure';
      var canvas = document.createElement('canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'PacketDiag 图形');
      figure.appendChild(canvas);
      var entry = { figure: figure, canvas: canvas, source: code.textContent };
      pre.parentNode.replaceChild(figure, pre);
      if (!renderFigure(entry)) {
        restoreSource(entry);
        return;
      }
      figures.push(entry);
    });
  }

  function rerenderFigures() {
    figures = figures.filter(function (entry) { return entry.figure.isConnected; });
    figures.forEach(renderFigure);
  }

  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rerenderFigures, 150);
  });

  window.$docsify = window.$docsify || {};
  window.$docsify.plugins = (window.$docsify.plugins || []).concat(function (hook) {
    hook.doneEach(function () {
      renderPacketBlocks();
    });
  });
}());
