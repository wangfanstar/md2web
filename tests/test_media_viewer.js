const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Only DOM plumbing is simulated here; open/close, async rendering, sizing and
// zoom run from the production script. Actual Mermaid/CSS are checked in-browser.
class Element {
  constructor(tagName = 'DIV') {
    this.tagName = tagName;
    this.children = [];
    this.style = {};
    this.attributes = {};
    this.className = '';
    this.classList = {
      contains: name => this.className.split(' ').includes(name),
      toggle: (name, enabled) => {
        const names = new Set(this.className.split(' ').filter(Boolean));
        if (enabled) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
      },
      add: name => this.classList.toggle(name, true),
      remove: name => this.classList.toggle(name, false)
    };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] || null; }
  removeAttribute(name) { delete this.attributes[name]; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  closest(selector) { return selector === '.mermaid' && this.classList.contains('mermaid') ? this : null; }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.tagName.toLowerCase() === selector ||
          (selector[0] === '.' && child.classList.contains(selector.slice(1)))) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { width: 1000, height: 600 }; }
  addEventListener() {}
  focus() {}
  set innerHTML(value) {
    this.children = [];
    const viewBox = /<svg[^>]*viewBox="([^"]+)"/.exec(value);
    if (viewBox) {
      const svg = this.appendChild(new Element('svg'));
      svg.setAttribute('viewBox', viewBox[1]);
    }
  }
  cloneNode() {
    const clone = new Element(this.tagName);
    clone.attributes = { ...this.attributes };
    clone.style = { ...this.style };
    this.children.forEach(child => clone.appendChild(child.cloneNode(true)));
    return clone;
  }
}

function loadViewer() {
  const renders = [];
  const window = {
    location: { hash: '#/test' },
    MermaidRender: { render: () => new Promise((resolve, reject) => renders.push({ resolve, reject })) }
  };
  const document = {
    body: new Element(), activeElement: null,
    createElement: tag => new Element(tag.toUpperCase()),
    addEventListener() {}, querySelectorAll: () => []
  };
  const source = fs.readFileSync(path.join(__dirname, '../web/media-viewer.js'), 'utf8');
  const context = vm.createContext({ window, document, console, setTimeout });
  vm.runInContext(source.replace(/\}\(\)\);\s*$/, 'window.testViewer = { open, close, state, setScale, fitScale }; }());'), context);
  const api = window.testViewer;
  api.state.overlay = new Element();
  api.state.stage = new Element();
  return { ...api, renders };
}

function diagram(viewBox = '-50 -10 450 259') {
  const source = new Element();
  source.className = 'mermaid';
  source.setAttribute('data-source', 'sequenceDiagram\nA->>B: request');
  source.innerHTML = '<svg viewBox="' + viewBox + '"></svg>';
  return source;
}

test('fresh Mermaid dimensions replace the inline dimensions and preserve its viewBox', async () => {
  const viewer = loadViewer();
  viewer.open(diagram('0 0 662 172'));
  const pending = viewer.state.pendingRender;
  viewer.renders[0].resolve('<svg viewBox="-50 -10 1280 172"></svg>');
  await pending;
  const svg = viewer.state.content.querySelector('svg');
  const surface = viewer.state.content.querySelector('.media-viewer-diagram');
  assert.equal(viewer.state.natural.width, 1280);
  assert.equal(viewer.state.natural.height, 172);
  assert.equal(svg.getAttribute('viewBox'), '-50 -10 1280 172');
  assert.equal(svg.style.width, '1280px');
  assert.equal(surface.style.width, '1280px');
  assert.equal(surface.style.height, '172px');
  assert.equal(viewer.state.scale, 1000 / 1280);
});

test('completed render activates the current SVG and diagram downloads', async () => {
  const viewer = loadViewer();
  viewer.open(diagram());
  const pending = viewer.state.pendingRender;
  viewer.renders[0].resolve('<svg viewBox="-50 -10 450 259"></svg>');
  await pending;
  assert.equal(viewer.state.svg, viewer.state.content.querySelector('svg'));
  assert.equal(viewer.state.isDiagram, true);
  assert.equal(viewer.state.overlay.classList.contains('is-diagram'), true);
  assert.equal(viewer.state.diagramIndex, 1);
});

test('a very wide or tall fresh diagram opens fully fitted, even below 10%', async () => {
  const viewer = loadViewer();
  viewer.open(diagram());
  const pending = viewer.state.pendingRender;
  viewer.renders[0].resolve('<svg viewBox="0 0 20000 12000"></svg>');
  await pending;
  assert.equal(viewer.state.scale, 0.05);
  viewer.setScale(viewer.fitScale());
  assert.equal(viewer.state.scale, 0.05, 'fit action must also show the entire diagram');
});

test('opening a normal image clears the old pending render and cannot be overwritten', async () => {
  const viewer = loadViewer();
  viewer.open(diagram());
  const pending = viewer.state.pendingRender;
  viewer.close();
  const image = new Element('IMG');
  image.naturalWidth = 300;
  image.naturalHeight = 200;
  viewer.open(image);
  viewer.setScale(2);
  viewer.renders[0].resolve('<svg viewBox="0 0 9000 8000"></svg>');
  await pending;
  assert.equal(viewer.state.pendingRender, null);
  assert.equal(viewer.state.natural.width, 300);
  assert.equal(viewer.state.scale, 2);
  assert.equal(viewer.state.svg, null);
  assert.equal(viewer.state.isDiagram, false);
});

test('out-of-order renders cannot replace or refit the current diagram', async () => {
  const viewer = loadViewer();
  viewer.open(diagram());
  const first = viewer.state.pendingRender;
  viewer.close();
  viewer.open(diagram('0 0 500 500'));
  const second = viewer.state.pendingRender;
  viewer.renders[1].resolve('<svg viewBox="0 0 600 600"></svg>');
  await second;
  viewer.setScale(2);
  const currentSvg = viewer.state.svg;
  viewer.renders[0].resolve('<svg viewBox="0 0 9000 8000"></svg>');
  await first;
  assert.ok(currentSvg);
  assert.equal(viewer.state.svg, currentSvg);
  assert.equal(viewer.state.natural.width, 600);
  assert.equal(viewer.state.scale, 2);
});

test('closing while rendering leaves the viewer empty and clears pending state', async () => {
  const viewer = loadViewer();
  viewer.open(diagram());
  const pending = viewer.state.pendingRender;
  viewer.close();
  viewer.renders[0].resolve('<svg viewBox="0 0 9000 8000"></svg>');
  await pending;
  assert.equal(viewer.state.pendingRender, null);
  assert.equal(viewer.state.content, null);
  assert.equal(viewer.state.svg, null);
  assert.equal(viewer.state.stage.children.length, 0);
});
