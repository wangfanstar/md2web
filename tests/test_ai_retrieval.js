const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

require(path.join(__dirname, '..', 'web', 'ai-retrieval.js'));
const AIRetrieval = globalThis.AIRetrieval;

const CONTENT = {
  'README.md': '# 项目文档\n\n这里是首页说明。\n\n## 目录\n\n- 说明\n',
  'md/硬件设计/时钟树设计.md': [
    '# 时钟树设计',
    '',
    '## PLL 配置',
    '',
    'PLL 倍频系数写入配置寄存器后需要等待锁定指示位。',
    '',
    '## 低功耗模式',
    '',
    '时钟门控可以在低功耗模式下关闭外设时钟。',
    ''
  ].join('\n'),
  'md/使用说明/快速开始.md': [
    '# 快速开始',
    '',
    '把 Markdown 放进 docs/md/，运行构建脚本即可。',
    '',
    '## 构建与预览',
    '',
    'python setup_docsify.py 然后 python serve.py。',
    ''
  ].join('\n')
};

const SEARCH_INDEX = {
  '/md/硬件设计/时钟树设计.md': {
    '/md/硬件设计/时钟树设计.md?id=pll配置': {
      slug: '/md/硬件设计/时钟树设计.md?id=pll配置',
      title: 'PLL配置',
      body: 'PLL 倍频系数写入配置寄存器后需要等待锁定指示位。',
      route: '/md/硬件设计/时钟树设计.md',
      pageTitle: '时钟树设计',
      headingTitle: 'PLL配置'
    },
    '/md/硬件设计/时钟树设计.md?id=低功耗模式': {
      slug: '/md/硬件设计/时钟树设计.md?id=低功耗模式',
      title: '低功耗模式',
      body: '时钟门控可以在低功耗模式下关闭外设时钟。',
      route: '/md/硬件设计/时钟树设计.md',
      pageTitle: '时钟树设计',
      headingTitle: '低功耗模式'
    }
  }
};

test('tokenize splits CJK into chars and bigrams and keeps ascii words', () => {
  const tokens = AIRetrieval.tokenize('PLL 倍频系数 how to configure');
  assert.ok(tokens.includes('pll'));
  assert.ok(tokens.includes('configure'));
  assert.ok(tokens.includes('倍频'));
  assert.ok(tokens.includes('系'));
  assert.ok(!tokens.includes('的'), 'stop words are removed');
});

test('buildCorpus prefers the search index', () => {
  const corpus = AIRetrieval.buildCorpus({ searchIndex: SEARCH_INDEX, content: CONTENT });
  assert.strictEqual(corpus.size, 2);
  assert.ok(corpus.sections.every((section) => section.pageTitle === '时钟树设计'));
});

test('buildCorpus falls back to markdown content when index is empty', () => {
  const corpus = AIRetrieval.buildCorpus({ content: CONTENT });
  assert.ok(corpus.size >= 4);
  const titles = corpus.sections.map((section) => section.headingTitle);
  assert.ok(titles.includes('PLL 配置'));
  assert.ok(titles.includes('构建与预览'));
  assert.ok(titles.includes('快速开始'));
});

test('search finds the right section for a CJK question', () => {
  const corpus = AIRetrieval.buildCorpus({ searchIndex: SEARCH_INDEX, content: CONTENT });
  const hits = AIRetrieval.search(corpus, 'PLL 锁定指示位在哪里？', { limit: 3 });
  assert.ok(hits.length >= 1);
  assert.strictEqual(hits[0].section.headingTitle, 'PLL配置');
});

test('search prefers title matches over body matches', () => {
  const corpus = AIRetrieval.buildCorpus({ content: CONTENT });
  const hits = AIRetrieval.search(corpus, '低功耗模式', { limit: 2 });
  assert.strictEqual(hits[0].section.headingTitle, '低功耗模式');
});

test('search returns empty for blank queries', () => {
  const corpus = AIRetrieval.buildCorpus({ content: CONTENT });
  assert.deepStrictEqual(AIRetrieval.search(corpus, '   '), []);
  assert.deepStrictEqual(AIRetrieval.search(null, 'PLL'), []);
});

test('buildContext keeps citations and respects the budget', () => {
  const corpus = AIRetrieval.buildCorpus({ searchIndex: SEARCH_INDEX, content: CONTENT });
  const hits = AIRetrieval.search(corpus, 'PLL 锁定', { limit: 5 });
  const text = AIRetrieval.buildContext(hits, 200);
  assert.ok(text.indexOf('时钟树设计') >= 0);
  assert.ok(text.length <= 240);
});

test('buildMessages orders system, history and the question with context', () => {
  const messages = AIRetrieval.buildMessages({
    systemPrompt: 'SYS',
    context: 'CTX',
    history: [{ role: 'user', content: '上一条' }, { role: 'assistant', content: '上一次回答' }],
    question: '新问题'
  });
  assert.strictEqual(messages[0].role, 'system');
  assert.strictEqual(messages[1].content, '上一条');
  const last = messages[messages.length - 1];
  assert.strictEqual(last.role, 'user');
  assert.ok(last.content.indexOf('CTX') >= 0);
  assert.ok(last.content.indexOf('新问题') >= 0);
});

test('listSources produces navigable labels', () => {
  const corpus = AIRetrieval.buildCorpus({ searchIndex: SEARCH_INDEX, content: CONTENT });
  const hits = AIRetrieval.search(corpus, 'PLL', { limit: 1 });
  const sources = AIRetrieval.listSources(hits);
  assert.strictEqual(sources.length, 1);
  assert.strictEqual(sources[0].slug, '/md/硬件设计/时钟树设计.md?id=pll配置');
  assert.ok(sources[0].label.indexOf('时钟树设计') >= 0);
});

test('search respects the scope filter', () => {
  const corpus = AIRetrieval.buildCorpus({ content: CONTENT });
  assert.ok(AIRetrieval.search(corpus, 'PLL', { limit: 5 }).length >= 1);
  assert.deepStrictEqual(AIRetrieval.search(corpus, 'PLL', { limit: 5, scope: ['/md/使用说明/'] }), []);
  assert.ok(AIRetrieval.search(corpus, 'PLL', { limit: 5, scope: ['/md/硬件设计/'] }).length >= 1);
});

test('uploaded documents join the corpus and can be scoped', () => {
  const base = AIRetrieval.buildCorpus({ content: CONTENT });
  const uploads = AIRetrieval.buildFromUploads([
    { name: '现场笔记.md', text: '# 现场笔记\n\n## 温度补偿\n\n温度补偿需要先校正基准电压。\n' }
  ]);
  assert.strictEqual(uploads.length, 2);
  assert.strictEqual(uploads[0].route, 'upload://现场笔记.md');
  const merged = AIRetrieval.mergeCorpus(base, uploads);
  assert.strictEqual(merged.size, base.size + 2);
  const hits = AIRetrieval.search(merged, '温度补偿 基准电压', { limit: 3 });
  assert.strictEqual(hits[0].section.route, 'upload://现场笔记.md');
  assert.ok(AIRetrieval.search(merged, '温度补偿', { limit: 3, scope: ['upload://'] }).length >= 1);
  const sources = AIRetrieval.listSources(hits);
  assert.strictEqual(sources[0].upload, true);
  assert.ok(sources[0].label.indexOf('现场笔记') >= 0);
});

test('scopeTree groups pages by folder and marks uploads', () => {
  const corpus = AIRetrieval.buildCorpus({ content: CONTENT });
  const uploads = AIRetrieval.buildFromUploads([{ name: '笔记.md', text: '# 笔记\n\n正文\n' }]);
  const tree = AIRetrieval.scopeTree(AIRetrieval.mergeCorpus(corpus, uploads), []);
  const prefixes = tree.map((item) => item.prefix);
  assert.ok(prefixes.includes('/md/硬件设计/'));
  const hardware = tree.find((item) => item.prefix === '/md/硬件设计/');
  assert.ok(hardware.pages.some((page) => page.route.endsWith('时钟树设计.md')));
  const uploadFolder = tree.find((item) => item.prefix === 'upload://');
  assert.ok(uploadFolder && uploadFolder.pages[0].route === 'upload://笔记.md');
});
