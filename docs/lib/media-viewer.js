(function () {
  'use strict';

  var MIN_SCALE = 0.1;
  var MAX_SCALE = 8;
  var ZOOM_STEP = 1.25;

  var state = {
    overlay: null,
    stage: null,
    content: null,
    svg: null,
    canvasSource: null,
    isDiagram: false,
    diagramIndex: 0,
    scale: 1,
    x: 0,
    y: 0,
    natural: { width: 800, height: 600 },
    pointers: {},
    drag: null,
    pinch: null,
    moved: false,
    lastFocus: null
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function isZoomable(target) {
    if (!target || !target.closest || target.closest('.media-viewer')) {
      return null;
    }
    var img = target.closest('.markdown-section img');
    if (img && !img.closest('a')) {
      return img;
    }
    var diagram = target.closest('.markdown-section .mermaid');
    if (diagram && diagram.querySelector('svg')) {
      return diagram;
    }
    var canvas = target.closest('.markdown-section canvas');
    if (canvas) {
      return canvas;
    }
    return null;
  }

  function naturalSize(source) {
    if (source.tagName === 'CANVAS') {
      var canvasRect = source.getBoundingClientRect();
      return {
        width: canvasRect.width || source.width || 800,
        height: canvasRect.height || source.height || 600
      };
    }
    var svg = source.tagName === 'svg' ? source : source.querySelector('svg');
    if (svg) {
      var viewBox = svg.getAttribute('viewBox');
      if (viewBox) {
        var parts = viewBox.split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          return { width: parts[2], height: parts[3] };
        }
      }
      var svgRect = svg.getBoundingClientRect();
      return { width: svgRect.width || 800, height: svgRect.height || 600 };
    }
    var img = source.tagName === 'IMG' ? source : source.querySelector('img');
    if (img) {
      if (img.naturalWidth && img.naturalHeight) {
        return { width: img.naturalWidth, height: img.naturalHeight };
      }
      var imgRect = img.getBoundingClientRect();
      return { width: imgRect.width || 800, height: imgRect.height || 600 };
    }
    var rect = source.getBoundingClientRect();
    return { width: rect.width || 800, height: rect.height || 600 };
  }

  function buildContent(source) {
    var wrapper = document.createElement('div');
    wrapper.className = 'media-viewer-content';
    if (source.tagName === 'CANVAS') {
      var canvasImage = document.createElement('img');
      try {
        canvasImage.src = source.toDataURL('image/png');
      } catch (error) {
        canvasImage.src = '';
      }
      canvasImage.style.width = state.natural.width + 'px';
      canvasImage.style.height = 'auto';
      wrapper.appendChild(canvasImage);
      return wrapper;
    }
    var svg = source.tagName === 'svg' ? source : source.querySelector('svg');
    if (svg) {
      var svgClone = svg.cloneNode(true);
      svgClone.removeAttribute('width');
      svgClone.removeAttribute('height');
      svgClone.style.maxWidth = 'none';
      svgClone.style.width = state.natural.width + 'px';
      svgClone.style.height = state.natural.height + 'px';
      wrapper.appendChild(svgClone);
      return wrapper;
    }
    var img = source.tagName === 'IMG' ? source : source.querySelector('img');
    if (img) {
      var imgClone = img.cloneNode(true);
      imgClone.style.maxWidth = 'none';
      imgClone.style.maxHeight = 'none';
      imgClone.style.width = state.natural.width + 'px';
      imgClone.style.height = 'auto';
      wrapper.appendChild(imgClone);
    }
    return wrapper;
  }

  function stageSize() {
    var rect = state.stage.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  function fitScale() {
    var stage = stageSize();
    return Math.min(stage.width / state.natural.width, stage.height / state.natural.height);
  }

  function applyTransform() {
    if (!state.content) {
      return;
    }
    state.content.style.transform =
      'translate(' + state.x + 'px, ' + state.y + 'px) scale(' + state.scale + ')';
    var scaleEl = state.overlay.querySelector('[data-viewer-scale]');
    if (scaleEl) {
      scaleEl.textContent = Math.round(state.scale * 100) + '%';
    }
  }

  function setScale(next, originX, originY) {
    var scale = clamp(next, MIN_SCALE, MAX_SCALE);
    if (originX === undefined || originY === undefined) {
      state.x = 0;
      state.y = 0;
    } else {
      var stage = stageSize();
      var cx = originX - stage.width / 2;
      var cy = originY - stage.height / 2;
      var factor = scale / state.scale;
      state.x = cx - (cx - state.x) * factor;
      state.y = cy - (cy - state.y) * factor;
    }
    state.scale = scale;
    applyTransform();
  }

  function close() {
    if (!state.overlay || !state.overlay.classList.contains('is-open')) {
      return;
    }
    state.overlay.classList.remove('is-open');
    state.overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('media-viewer-open');
    state.stage.innerHTML = '';
    state.content = null;
    state.svg = null;
    state.canvasSource = null;
    state.isDiagram = false;
    state.pointers = {};
    state.drag = null;
    state.pinch = null;
    if (state.lastFocus && state.lastFocus.focus) {
      state.lastFocus.focus();
    }
  }

  function pageName() {
    var hash = String(window.location.hash || '').replace(/^#/, '').split('?')[0];
    var segment = hash.split('/').filter(Boolean).pop() || '';
    try { segment = decodeURIComponent(segment); } catch (error) { /* keep original */ }
    segment = segment.replace(/\.md$/i, '') || 'diagram';
    return segment.replace(/[\\/:*?"<>|]+/g, '-');
  }

  function diagramIndex(source) {
    var all = Array.prototype.slice.call(document.querySelectorAll('.markdown-section .mermaid'));
    var index = all.indexOf(source);
    return index === -1 ? 1 : index + 1;
  }

  function downloadName(extension) {
    return pageName() + '-图' + state.diagramIndex + '.' + extension;
  }

  function simplifyForeignObjects(root) {
    var nodes = Array.prototype.slice.call(root.querySelectorAll('foreignObject'));
    nodes.forEach(function (foreignObject) {
      var parent = foreignObject.parentNode;
      if (!parent) {
        return;
      }
      var width = parseFloat(foreignObject.getAttribute('width')) || 0;
      var height = parseFloat(foreignObject.getAttribute('height')) || 0;
      var html = String(foreignObject.innerHTML || '').replace(/<br\s*\/?>/gi, '\n');
      var holder = document.createElement('div');
      holder.innerHTML = html;
      var lines = String(holder.textContent || '')
        .split('\n')
        .map(function (line) { return line.replace(/\s+/g, ' ').trim(); })
        .filter(function (line) { return line.length > 0; });
      if (!lines.length) {
        parent.removeChild(foreignObject);
        return;
      }
      var fontSize = 13;
      try {
        var sample = foreignObject.querySelector('p, span, div');
        if (sample) {
          var computed = window.getComputedStyle(sample);
          if (computed && computed.fontSize) {
            fontSize = parseFloat(computed.fontSize) || fontSize;
          }
        }
      } catch (error) { /* keep default size */ }
      var lineHeight = fontSize * 1.35;
      var centerX = width / 2;
      var startY = height / 2 - (lines.length - 1) * lineHeight / 2;
      var text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      text.setAttribute('font-size', String(fontSize));
      text.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif');
      text.setAttribute('fill', '#1f2a37');
      lines.forEach(function (line, index) {
        var tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
        tspan.setAttribute('x', String(centerX));
        tspan.setAttribute('y', String(startY + index * lineHeight));
        tspan.textContent = line;
        text.appendChild(tspan);
      });
      parent.replaceChild(text, foreignObject);
    });
  }

  function serializeSvg() {
    if (!state.svg) {
      return '';
    }
    var clone = state.svg.cloneNode(true);
    // 导出前把 HTML 标签（foreignObject）转为 SVG 文本：画布不污染、第三方工具可正常打开
    simplifyForeignObjects(clone);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    clone.setAttribute('width', state.natural.width);
    clone.setAttribute('height', state.natural.height);
    clone.style.maxWidth = 'none';
    var text = new XMLSerializer().serializeToString(clone);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + text;
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function downloadSvg() {
    var text = serializeSvg();
    if (!text) {
      return;
    }
    saveBlob(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }), downloadName('svg'));
  }

  function svgToPngBlob(svgElement, width, height, scale) {
    return new Promise(function (resolve, reject) {
      var clone = svgElement.cloneNode(true);
      simplifyForeignObjects(clone);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
      var text = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
      var svgUrl = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
      var image = new Image();
      image.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          var context = canvas.getContext('2d');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(svgUrl);
          canvas.toBlob(function (blob) {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('PNG 编码失败'));
            }
          }, 'image/png');
        } catch (error) {
          URL.revokeObjectURL(svgUrl);
          reject(error);
        }
      };
      image.onerror = function () {
        URL.revokeObjectURL(svgUrl);
        reject(new Error('SVG 加载失败'));
      };
      image.src = svgUrl;
    });
  }

  function downloadPng() {
    if (state.canvasSource) {
      try {
        state.canvasSource.toBlob(function (blob) {
          if (blob) {
            saveBlob(blob, downloadName('png'));
          }
        }, 'image/png');
      } catch (error) {
        if (window.console && console.warn) {
          console.warn('PNG 导出失败', error);
        }
      }
      return;
    }
    if (!state.svg) {
      return;
    }
    svgToPngBlob(state.svg, state.natural.width, state.natural.height, 2).then(function (blob) {
      saveBlob(blob, downloadName('png'));
    }).catch(function () {
      downloadSvg();
    });
  }

  function open(source) {
    state.natural = naturalSize(source);
    state.lastFocus = document.activeElement;
    if (!state.overlay) {
      state.overlay = document.createElement('div');
      state.overlay.className = 'media-viewer';
      state.overlay.setAttribute('role', 'dialog');
      state.overlay.setAttribute('aria-modal', 'true');
      state.overlay.setAttribute('aria-label', '图片查看');
      state.overlay.tabIndex = -1;
      state.overlay.innerHTML = [
        '<div class="media-viewer-backdrop" data-viewer-close></div>',
        '<div class="media-viewer-stage" data-viewer-stage></div>',
        '<div class="media-viewer-toolbar">',
        '<button type="button" data-viewer-action="out" aria-label="缩小">−</button>',
        '<span class="media-viewer-scale" data-viewer-scale>100%</span>',
        '<button type="button" data-viewer-action="in" aria-label="放大">+</button>',
        '<button type="button" data-viewer-action="fit">适应</button>',
        '<button type="button" data-viewer-action="actual">1:1</button>',
        '<button type="button" class="media-viewer-download" data-viewer-action="svg">下载 SVG</button>',
        '<button type="button" class="media-viewer-download" data-viewer-action="png">下载 PNG</button>',
        '<button type="button" data-viewer-action="close" aria-label="关闭">✕</button>',
        '</div>'
      ].join('');
      document.body.appendChild(state.overlay);
      state.stage = state.overlay.querySelector('[data-viewer-stage]');
      bindOverlay();
    }
    state.stage.innerHTML = '';
    state.content = buildContent(source);
    state.stage.appendChild(state.content);
    state.svg = state.content.querySelector('svg');
    state.canvasSource = source.tagName === 'CANVAS' ? source : null;
    state.isDiagram = !!state.svg || !!state.canvasSource;
    state.diagramIndex = state.isDiagram ? diagramIndex(source) : 0;
    state.overlay.classList.toggle('is-diagram', state.isDiagram);
    state.overlay.classList.toggle('is-canvas', !!state.canvasSource);
    state.overlay.classList.add('is-open');
    state.overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('media-viewer-open');
    state.x = 0;
    state.y = 0;
    var isDiagram = source.tagName === 'svg' || !!source.querySelector('svg');
    var initial;
    if (isDiagram) {
      // 图形按 100% 打开，保证文字可读；过大时可用平移或「适应」查看全貌
      initial = 1;
    } else {
      var stage = stageSize();
      initial = Math.min(
        1,
        Math.max(stage.width / state.natural.width, stage.height / state.natural.height)
      );
    }
    state.scale = clamp(initial, MIN_SCALE, MAX_SCALE);
    applyTransform();
    state.overlay.focus();
  }

  function onStageClick(event) {
    if (event.target !== state.stage) {
      return;
    }
    if (state.moved) {
      state.moved = false;
      return;
    }
    close();
  }

  function onPointerDown(event) {
    if (event.target.closest && event.target.closest('.media-viewer-toolbar')) {
      return;
    }
    state.pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
    var ids = Object.keys(state.pointers);
    if (ids.length === 1) {
      state.moved = false;
      state.drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        baseX: state.x,
        baseY: state.y
      };
    } else if (ids.length === 2) {
      var points = ids.map(function (id) { return state.pointers[id]; });
      state.pinch = {
        distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y),
        scale: state.scale
      };
      state.drag = null;
    }
    if (state.stage.setPointerCapture) {
      try { state.stage.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
    }
  }

  function onPointerMove(event) {
    if (!state.pointers[event.pointerId]) {
      return;
    }
    state.pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
    var ids = Object.keys(state.pointers);
    if (state.pinch && ids.length >= 2) {
      var points = ids.map(function (id) { return state.pointers[id]; });
      var distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (state.pinch.distance > 0) {
        setScale(state.pinch.scale * distance / state.pinch.distance);
      }
      return;
    }
    if (state.drag && state.drag.id === event.pointerId) {
      var dx = event.clientX - state.drag.startX;
      var dy = event.clientY - state.drag.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        state.moved = true;
      }
      state.x = state.drag.baseX + dx;
      state.y = state.drag.baseY + dy;
      applyTransform();
    }
  }

  function onPointerUp(event) {
    delete state.pointers[event.pointerId];
    if (state.drag && state.drag.id === event.pointerId) {
      state.drag = null;
    }
    if (Object.keys(state.pointers).length < 2) {
      state.pinch = null;
    }
  }

  function bindOverlay() {
    state.overlay.addEventListener('click', function (event) {
      var action = event.target.getAttribute && event.target.getAttribute('data-viewer-action');
      if (event.target.hasAttribute && event.target.hasAttribute('data-viewer-close')) {
        close();
        return;
      }
      if (action === 'in') {
        setScale(state.scale * ZOOM_STEP);
      } else if (action === 'out') {
        setScale(state.scale / ZOOM_STEP);
      } else if (action === 'fit') {
        setScale(fitScale());
      } else if (action === 'actual') {
        setScale(1);
      } else if (action === 'svg') {
        downloadSvg();
      } else if (action === 'png') {
        downloadPng();
      } else if (action === 'close') {
        close();
      }
    });
    state.stage.addEventListener('click', onStageClick);
    state.stage.addEventListener('pointerdown', onPointerDown);
    state.stage.addEventListener('pointermove', onPointerMove);
    state.stage.addEventListener('pointerup', onPointerUp);
    state.stage.addEventListener('pointercancel', onPointerUp);
    state.stage.addEventListener('dragstart', function (event) { event.preventDefault(); });
    state.stage.addEventListener('dblclick', function (event) {
      if (event.target.closest && event.target.closest('.media-viewer-toolbar')) {
        return;
      }
      setScale(Math.abs(state.scale - 1) < 0.01 ? fitScale() : 1);
    });
    state.stage.addEventListener('wheel', function (event) {
      event.preventDefault();
      var rect = state.stage.getBoundingClientRect();
      var factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setScale(state.scale * factor, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
  }

  document.addEventListener('click', function (event) {
    var source = isZoomable(event.target);
    if (!source) {
      return;
    }
    event.preventDefault();
    open(source);
  });

  document.addEventListener('keydown', function (event) {
    if (!state.overlay || !state.overlay.classList.contains('is-open')) {
      return;
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    } else if (event.key === '+' || event.key === '=') {
      event.stopPropagation();
      setScale(state.scale * ZOOM_STEP);
    } else if (event.key === '-') {
      event.stopPropagation();
      setScale(state.scale / ZOOM_STEP);
    } else if (event.key === '0') {
      event.stopPropagation();
      setScale(fitScale());
    } else if (event.key === '1') {
      event.stopPropagation();
      setScale(1);
    }
  }, true);

  // 供在线预览页复用：HTML 标签转 SVG 文本、SVG 转 PNG
  window.MediaViewer = {
    simplifyForeignObjects: simplifyForeignObjects,
    svgToPngBlob: svgToPngBlob
  };
}());
