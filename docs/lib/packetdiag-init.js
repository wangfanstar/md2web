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
      figure.setAttribute('data-source', code.textContent);
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

  // 供导出/打印使用：按 figure 上的 data-source 现场重绘一张画布，返回 data URL
  window.PacketDiagRerender = function (figure, width) {
    if (!figure || !window.PacketDiag || !window.PacketDiag.parse) {
      return '';
    }
    var source = figure.getAttribute('data-source');
    if (!source) {
      return '';
    }
    try {
      var canvas = document.createElement('canvas');
      var parsed = window.PacketDiag.parse(window.PacketDiag.extractSource(source));
      window.PacketDiag.render(parsed, canvas, { fitWidth: true, width: width || 864 });
      return canvas.toDataURL('image/png');
    } catch (error) {
      return '';
    }
  };

  // 导出前确保画布已绘制：空白画布重新渲染一次
  window.PacketDiagEnsureRendered = function (root) {
    var scope = root || document;
    var figures = Array.prototype.slice.call(scope.querySelectorAll('.packetdiag-figure'));
    var repaired = 0;
    figures.forEach(function (figure) {
      var canvas = figure.querySelector('canvas');
      if (!canvas || !canvas.width || !canvas.height) {
        return;
      }
      var blank = true;
      try {
        var data = canvas.getContext('2d').getImageData(0, 0, Math.min(canvas.width, 260), Math.min(canvas.height, 160)).data;
        for (var index = 3; index < data.length; index += 4 * 23) {
          if (data[index] !== 0) {
            blank = false;
            break;
          }
        }
      } catch (error) {
        blank = false;
      }
      if (!blank) {
        return;
      }
      var dataUrl = window.PacketDiagRerender(figure, Math.max(560, figure.clientWidth || 864));
      if (!dataUrl) {
        return;
      }
      var image = new Image();
      image.src = dataUrl;
      var context = canvas.getContext('2d');
      context.clearRect(0, 0, canvas.width, canvas.height);
      image.onload = function () {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
      };
      repaired += 1;
    });
    return repaired;
  };

  window.$docsify = window.$docsify || {};
  window.$docsify.plugins = (window.$docsify.plugins || []).concat(function (hook) {
    hook.doneEach(function () {
      renderPacketBlocks();
    });
  });
}());
