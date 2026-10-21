const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const window = {renderMathInElement() {}};
vm.runInNewContext(fs.readFileSync('web/math-init.js', 'utf8'), {window});
const math = window.MathRender;

test('protect multiline formula and escaped underscores before Markdown parsing', () => {
  const source = '$$ \\text{S\\_VC\\_CU}[x]+\\text{pktCredits}\n\\leq\n\n\\text{S\\_VC\\_CL}[x]\n$$';
  const prepared = math.prepare(source);
  assert.ok(!prepared.markdown.includes('\\text'));
  const html = prepared.restore('<p>' + prepared.markdown + '</p>');
  assert.ok(html.includes(source));
  assert.equal(html, '<p>' + source + '</p>');
});

test('leave fenced and inline code, escaped dollars and incomplete math alone', () => {
  const source = '```tex\n$$x$$\n```\n`$x$`\n\\$price\n$$unclosed';
  const prepared = math.prepare(source);
  assert.equal(prepared.markdown, source);
  assert.equal(math.prepare('~~~tex\n$$x$$').markdown, '~~~tex\n$$x$$');
});

test('protect all supported delimiters and HTML-escape formula contents', () => {
  const prepared = math.prepare('$a_b$ and \\(c\\_d\\)\n\\[x < y\\]');
  assert.ok(!prepared.markdown.includes('$a_b$'));
  assert.ok(prepared.restore(prepared.markdown).includes('$a_b$ and \\(c\\_d\\)'));
  assert.ok(prepared.restore(prepared.markdown).includes('x &lt; y'));
  assert.equal(math.prepare('$$\\leg$$').restore('untouched'), 'untouched');
});

test('restoring math inside HTML attributes does not introduce markup or quotes', () => {
  const prepared = math.prepare('$x"<y$');
  assert.equal(prepared.restore('<a title="' + prepared.markdown + '">link</a>'),
    '<a title="$x&quot;&lt;y$">link</a>');
});
