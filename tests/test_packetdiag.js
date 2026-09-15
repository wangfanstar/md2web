const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadPacketDiag() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'packetdiag.js'), 'utf8');
  const context = { console, window: {}, document: { getElementById() { return null; } } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'packetdiag.js' });
  return context.window.PacketDiag;
}

test('parse reads config and fields', () => {
  const api = loadPacketDiag();
  const parsed = api.parse('packetdiag {\n  colwidth = 48;\n  0-3: Version;\n  4-7: IHL [color = "#dbeafe"];\n}');
  assert.equal(parsed.config.colwidth, 48);
  assert.equal(parsed.fields.length, 2);
  assert.equal(parsed.fields[0].label, 'Version');
  assert.equal(parsed.fields[0].start, 0);
  assert.equal(parsed.fields[0].end, 3);
  assert.equal(parsed.fields[1].options.color, '#dbeafe');
  assert.equal(parsed.warnings.length, 0);
});

test('presets parse with fields and no warnings', () => {
  const api = loadPacketDiag();
  Object.keys(api.presets).forEach((name) => {
    const parsed = api.parse(api.presets[name]);
    assert.ok(parsed.fields.length > 0, name + ' should have fields');
    assert.equal(parsed.warnings.length, 0, name + ' warnings: ' + JSON.stringify(parsed.warnings));
  });
});

test('render and default source are exposed', () => {
  const api = loadPacketDiag();
  assert.equal(typeof api.render, 'function');
  assert.equal(typeof api.defaultSource, 'string');
  assert.ok(api.defaultSource.indexOf('packetdiag {') !== -1);
});
