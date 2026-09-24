const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadTextFind() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'text-find.js'), 'utf8');
  const window = {};
  const context = vm.createContext({ window, console });
  vm.runInContext(source, context, { filename: 'text-find.js' });
  return window.TextFind;
}

const basic = { caseSensitive: false, wholeWord: false, regex: false };

test('findMatches finds every occurrence and is case-insensitive by default', () => {
  const textFind = loadTextFind();
  const matches = textFind.findMatches('Alpha alpha ALPHA', 'alpha', basic).matches;
  assert.deepEqual(Array.from(matches, (item) => item.start), [0, 6, 12]);
  assert.deepEqual(Array.from(matches, (item) => item.end), [5, 11, 17]);
});

test('findMatches respects case sensitivity', () => {
  const textFind = loadTextFind();
  const matches = textFind.findMatches('Alpha alpha', 'alpha', { ...basic, caseSensitive: true }).matches;
  assert.equal(matches.length, 1);
  assert.equal(matches[0].start, 6);
});

test('findMatches whole word ignores matches inside longer identifiers', () => {
  const textFind = loadTextFind();
  const text = 'reg reg_ctrl register REG';
  const matches = textFind.findMatches(text, 'reg', { ...basic, wholeWord: true }).matches;
  assert.deepEqual(Array.from(matches, (item) => text.slice(item.start, item.end)), ['reg', 'REG']);
});

test('findMatches treats CJK text as whole word friendly', () => {
  const textFind = loadTextFind();
  const text = '时钟树设计 时钟';
  const matches = textFind.findMatches(text, '时钟', { ...basic, wholeWord: true }).matches;
  assert.equal(matches.length, 2);
});

test('findMatches supports regular expressions and reports invalid patterns', () => {
  const textFind = loadTextFind();
  const matches = textFind.findMatches('a1 b2 c3', '\\w\\d', { ...basic, regex: true }).matches;
  assert.equal(matches.length, 3);
  const invalid = textFind.findMatches('text', '([', { ...basic, regex: true });
  assert.equal(invalid.error, 'invalid_regex');
  assert.equal(invalid.matches.length, 0);
});

test('findMatches ignores empty queries and zero-length matches', () => {
  const textFind = loadTextFind();
  assert.equal(textFind.findMatches('abc', '', basic).matches.length, 0);
  const zero = textFind.findMatches('abc', 'x*', { ...basic, regex: true });
  assert.equal(zero.matches.length, 0);
});

test('replaceAll replaces every match and counts them', () => {
  const textFind = loadTextFind();
  const result = textFind.replaceAll('a b a b', 'a', 'X', basic);
  assert.equal(result.count, 2);
  assert.equal(result.text, 'X b X b');
});

test('replaceAll expands capture groups in regex mode', () => {
  const textFind = loadTextFind();
  const result = textFind.replaceAll('v1.2 v3.4', 'v(\\d+)\\.(\\d+)', 'v$2-$1', { ...basic, regex: true });
  assert.equal(result.text, 'v2-1 v4-3');
  assert.equal(result.count, 2);
});

test('replaceAll keeps whole word matching', () => {
  const textFind = loadTextFind();
  const result = textFind.replaceAll('reg reg_ctrl', 'reg', 'REG', { ...basic, wholeWord: true });
  assert.equal(result.text, 'REG reg_ctrl');
});

test('replaceAll returns an error for invalid regex', () => {
  const textFind = loadTextFind();
  const result = textFind.replaceAll('text', '([', 'x', { ...basic, regex: true });
  assert.equal(result.error, 'invalid_regex');
});

test('replaceAll rejects empty queries', () => {
  const textFind = loadTextFind();
  const result = textFind.replaceAll('text', '', 'x', basic);
  assert.equal(result.error, 'empty_query');
});
