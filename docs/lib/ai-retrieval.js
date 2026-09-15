(function (root) {
  'use strict';

  var STOP_WORDS = {
    'the': 1, 'and': 1, 'for': 1, 'are': 1, 'was': 1, 'with': 1, 'this': 1, 'that': 1,
    'what': 1, 'how': 1, 'why': 1, 'when': 1, 'where': 1, 'which': 1, 'can': 1,
    '请': 1, '的': 1, '了': 1, '是': 1, '在': 1, '和': 1, '与': 1, '我': 1, '有': 1,
    '怎么': 1, '如何': 1, '什么': 1, '哪些': 1, '请问': 1, '一下': 1
  };

  function tokenize(text) {
    var tokens = [];
    var normalized = String(text || '').toLowerCase();
    var ascii = normalized.match(/[a-z0-9][a-z0-9_+#.-]{1,}/g) || [];
    ascii.forEach(function (token) {
      if (!STOP_WORDS[token]) {
        tokens.push(token);
      }
    });
    var runs = normalized.match(/[\u3400-\u9fff\u3040-\u30ff]+/g) || [];
    runs.forEach(function (run) {
      for (var i = 0; i < run.length; i += 1) {
        var single = run.charAt(i);
        if (!STOP_WORDS[single]) {
          tokens.push(single);
        }
        if (i + 1 < run.length) {
          tokens.push(run.slice(i, i + 2));
        }
      }
    });
    return tokens;
  }

  function sectionText(section) {
    return [section.pageTitle, section.headingTitle, section.title, section.body].join('\n');
  }

  function addTerms(weights, text, weight) {
    tokenize(text).forEach(function (token) {
      weights[token] = (weights[token] || 0) + weight;
    });
  }

  function makeSection(entry) {
    var section = {
      slug: entry.slug,
      route: entry.route,
      pageTitle: entry.pageTitle,
      headingTitle: entry.headingTitle,
      title: entry.title,
      body: String(entry.body || '').replace(/\s+/g, ' ').trim()
    };
    section.weights = {};
    addTerms(section.weights, section.headingTitle || '', 4);
    addTerms(section.weights, section.title || '', 3);
    addTerms(section.weights, section.pageTitle || '', 2);
    addTerms(section.weights, section.body || '', 1);
    return section;
  }

  function buildFromSearchIndex(searchIndex) {
    var sections = [];
    Object.keys(searchIndex || {}).forEach(function (route) {
      var page = searchIndex[route] || {};
      Object.keys(page).forEach(function (slug) {
        var entry = page[slug];
        if (!entry || typeof entry !== 'object') {
          return;
        }
        sections.push(makeSection({
          slug: entry.slug || slug,
          route: entry.route || route,
          pageTitle: entry.pageTitle || '',
          headingTitle: entry.headingTitle || '',
          title: entry.title || '',
          body: entry.body || ''
        }));
      });
    });
    return sections;
  }

  function splitMarkdown(route, markdown) {
    var lines = String(markdown || '').split('\n');
    var pageTitle = String(route || '/').split('/').pop().replace(/\.md$/i, '') || '文档';
    var sections = [];
    var current = null;
    var inFence = false;
    lines.forEach(function (line) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
      }
      var heading = !inFence && /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        if (current) {
          sections.push(current);
        }
        var title = heading[2].trim();
        if (!sections.length && heading[1].length === 1) {
          pageTitle = title;
        }
        current = {
          slug: route + (title ? '?id=' + title : ''),
          route: route,
          pageTitle: pageTitle,
          headingTitle: title,
          title: title,
          body: ''
        };
        return;
      }
      if (!current) {
        current = { slug: route, route: route, pageTitle: pageTitle, headingTitle: pageTitle, title: pageTitle, body: '' };
      }
      current.body += line + '\n';
    });
    if (current) {
      sections.push(current);
    }
    return sections;
  }

  function buildFromContent(content) {
    var sections = [];
    Object.keys(content || {}).forEach(function (resource) {
      if (!/\.md$/i.test(resource) || resource === '_sidebar.md') {
        return;
      }
      var route = resource === 'README.md' ? '/' : '/' + resource;
      splitMarkdown(route, content[resource]).forEach(function (section) {
        sections.push(makeSection(section));
      });
    });
    return sections;
  }

  function buildCorpus(source) {
    var data = source || {};
    var sections = data.searchIndex && Object.keys(data.searchIndex).length
      ? buildFromSearchIndex(data.searchIndex)
      : buildFromContent(data.content);
    return finalizeCorpus(sections);
  }

  function finalizeCorpus(sections) {
    var documentFrequency = {};
    sections.forEach(function (section) {
      Object.keys(section.weights).forEach(function (token) {
        documentFrequency[token] = (documentFrequency[token] || 0) + 1;
      });
    });
    return { sections: sections, documentFrequency: documentFrequency, size: sections.length };
  }

  function buildFromUploads(uploads) {
    var sections = [];
    (uploads || []).forEach(function (item) {
      var name = String((item && item.name) || '上传文档.md');
      var route = 'upload://' + name;
      splitMarkdown(route, (item && item.text) || '').forEach(function (raw) {
        raw.pageTitle = name;
        var section = makeSection(raw);
        section.upload = true;
        section.route = route;
        sections.push(section);
      });
    });
    return sections;
  }

  function mergeCorpus(base, extraSections) {
    var sections = ((base && base.sections) || []).concat(extraSections || []);
    return finalizeCorpus(sections);
  }

  function inScope(section, scope) {
    if (!scope || !scope.length) {
      return true;
    }
    return scope.some(function (prefix) {
      return section.route === prefix || section.route.indexOf(prefix) === 0;
    });
  }

  function search(corpus, query, options) {
    var settings = options || {};
    var limit = settings.limit || 5;
    var scope = settings.scope || [];
    var tokens = tokenize(query);
    if (!corpus || !tokens.length) {
      return [];
    }
    var total = Math.max(1, corpus.size);
    var scored = [];
    corpus.sections.forEach(function (section) {
      if (!inScope(section, scope)) {
        return;
      }
      var score = 0;
      var matched = 0;
      tokens.forEach(function (token) {
        var weight = section.weights[token];
        if (!weight) {
          return;
        }
        matched += 1;
        var df = corpus.documentFrequency[token] || 1;
        score += weight * Math.log(1 + total / df);
      });
      if (!score) {
        return;
      }
      score = score / Math.sqrt(1 + section.body.length / 400);
      scored.push({ section: section, score: score, matched: matched });
    });
    scored.sort(function (a, b) {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.section.slug.localeCompare(b.section.slug);
    });
    return scored.slice(0, limit);
  }

  function scopeTree(corpus, uploads) {
    var folders = {};
    ((corpus && corpus.sections) || []).forEach(function (section) {
      var route = section.route;
      var folder;
      if (route.indexOf('upload://') === 0) {
        folder = 'upload://';
      } else {
        var parts = route.replace(/^\//, '').split('/');
        folder = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') + '/' : '/';
      }
      if (!folders[folder]) {
        folders[folder] = { prefix: folder, upload: folder === 'upload://', pages: {} };
      }
      if (!folders[folder].pages[route]) {
        folders[folder].pages[route] = { route: route, label: section.pageTitle || route, upload: !!section.upload };
      }
    });
    return Object.keys(folders).sort().map(function (key) {
      var folder = folders[key];
      return {
        prefix: folder.prefix,
        upload: folder.upload,
        label: key === '/' ? '/' : key,
        pages: Object.keys(folder.pages).sort().map(function (route) { return folder.pages[route]; })
      };
    });
  }

  function excerpt(section, query, length) {
    var size = length || 320;
    var body = section.body || '';
    var tokens = tokenize(query).filter(function (token) { return token.length > 1; });
    var index = -1;
    tokens.forEach(function (token) {
      var found = body.toLowerCase().indexOf(token);
      if (found >= 0 && (index === -1 || found < index)) {
        index = found;
      }
    });
    if (index === -1) {
      index = 0;
    }
    var start = Math.max(0, index - Math.floor(size / 3));
    return (start > 0 ? '…' : '') + body.slice(start, start + size) + (start + size < body.length ? '…' : '');
  }

  function buildContext(hits, maxChars) {
    var budget = maxChars || 6000;
    var parts = [];
    var used = 0;
    (hits || []).forEach(function (hit, index) {
      var section = hit.section;
      var header = '[' + (index + 1) + '] 《' + (section.pageTitle || section.route) + '》'
        + (section.headingTitle && section.headingTitle !== section.pageTitle ? ' › ' + section.headingTitle : '')
        + '（路径 ' + section.route + '）';
      var text = header + '\n' + excerpt(section, hit.query || '', 900);
      if (used + text.length > budget && parts.length) {
        return;
      }
      used += text.length;
      parts.push(text);
    });
    return parts.join('\n\n');
  }

  function buildMessages(options) {
    var settings = options || {};
    var messages = [];
    messages.push({ role: 'system', content: settings.systemPrompt || '你是文档助手，只依据提供的资料回答，并使用与提问一致的语言。' });
    var history = (settings.history || []).slice(-6);
    history.forEach(function (item) {
      if (item && item.role && item.content) {
        messages.push({ role: item.role, content: String(item.content).slice(0, 4000) });
      }
    });
    var context = settings.context ? '参考资料：\n' + settings.context + '\n\n' : '';
    messages.push({ role: 'user', content: context + '问题：' + (settings.question || '') });
    return messages;
  }

  function listSources(hits) {
    return (hits || []).map(function (hit) {
      return {
        slug: hit.section.slug,
        route: hit.section.route,
        upload: !!hit.section.upload,
        label: '《' + (hit.section.pageTitle || hit.section.route) + '》'
          + (hit.section.upload
            ? ''
            : (hit.section.headingTitle && hit.section.headingTitle !== hit.section.pageTitle ? ' › ' + hit.section.headingTitle : ''))
      };
    });
  }

  root.AIRetrieval = {
    tokenize: tokenize,
    buildCorpus: buildCorpus,
    buildFromSearchIndex: buildFromSearchIndex,
    buildFromContent: buildFromContent,
    buildFromUploads: buildFromUploads,
    mergeCorpus: mergeCorpus,
    scopeTree: scopeTree,
    inScope: inScope,
    search: search,
    excerpt: excerpt,
    buildContext: buildContext,
    buildMessages: buildMessages,
    listSources: listSources
  };
}(typeof window !== 'undefined' ? window : globalThis));
