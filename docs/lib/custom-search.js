(function () {
  var defaults = {
    indexPath: 'search-index.json',
    maxSidebarResults: 8,
    maxDialogResults: 50,
    minQueryLength: 2,
    searchDepth: 4,
    sidebarWidthStorageKey: 'docsify.sidebar.width',
    defaultSidebarWidth: 300,
    minSidebarWidth: 240,
    maxSidebarWidth: 560,
    historyStorageKey: 'docsify.search.history',
    maxHistoryEntries: 10
  };
  var tocDefaults = {
    enabled: true,
    minLevel: 2,
    maxLevel: 4,
    title: '本文目录'
  };

  var config = Object.assign({}, defaults, (window.$docsify && window.$docsify.customSearch) || {});
  var tocConfig = Object.assign({}, tocDefaults, (window.$docsify && window.$docsify.customToc) || {});
  var state = {
    loaded: false,
    error: '',
    items: [],
    index: {},
    results: [],
    query: '',
    searchMode: 'full',
    searchScope: 'all',
    composing: false,
    queryTimer: null,
    history: [],
    collapsedGroups: {},
    sidebar: null,
    dialog: null,
    sidebarResizer: null,
    pageToc: null,
    tocObserver: null,
    tocTimer: null
  };

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function (char) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[char];
    });
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeText(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[_\-./\\:[\](){},;|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function compactText(value) {
    return normalizeText(value).replace(/\s+/g, '');
  }

  function isLikelyChineseQuery(query) {
    return /[一-鿿]/.test(query || '');
  }

  function tokenize(query) {
    var normalized = normalizeText(query);
    if (!normalized) {
      return [];
    }
    return normalized.split(' ').filter(Boolean);
  }

  // Parse a small, deterministic query language shared by full and file search:
  // whitespace means AND, quoted text is a phrase, and a leading '-' excludes.
  // We keep the original query for history/highlighting but only return positive
  // terms to the reading highlighter.
  function parseQuery(query) {
    var source = String(query || '').trim();
    var positive = [];
    var negative = [];
    var match;
    var re = /(-)?(?:"([^"]+)"|'([^']+)'|([^\s"]+))/g;
    while ((match = re.exec(source))) {
      var value = match[2] || match[3] || match[4] || '';
      var normalized = normalizeText(value);
      if (!normalized) {
        continue;
      }
      (match[1] ? negative : positive).push(normalized);
    }
    return { positive: positive, negative: negative };
  }

  function queryTerms(query) {
    return parseQuery(query).positive.reduce(function (all, term) {
      return all.concat(term.split(' ').filter(Boolean));
    }, []);
  }

  function hasEnoughQuery(query) {
    var trimmed = String(query || '').trim();
    if (!trimmed) {
      return false;
    }
    if (isLikelyChineseQuery(trimmed)) {
      return trimmed.length >= 1;
    }
    return compactText(trimmed).length >= config.minQueryLength;
  }

  function homeLink() {
    // 每个页面的「返回首页」目标：仓库页回 index_all.html，合并视图回总览 index.html
    var config = window.$docsify || {};
    return config.homeLink || 'index.html';
  }

  function routeToHash(slug, site) {
    // 多仓库站点：结果条目带 site（index_<仓库>.html），跨仓库时先切到对应入口页
    var hash = '#/';
    if (slug && slug !== '/') {
      hash = slug.charAt(0) === '#' ? slug : '#' + slug;
    }
    var page = String(site || '').trim();
    if (page && page !== 'index_all.html') {
      var current = String(window.location.pathname || '').split('/').pop() || 'index.html';
      if (page !== current) {
        return page + hash;
      }
    }
    return hash;
  }

  function titleFromRoute(route) {
    var clean = String(route || '').split('?')[0].replace(/\/$/, '');
    var file = clean.split('/').pop() || 'Home Page';
    return file.replace(/\.md$/i, '') || 'Home Page';
  }

  function currentRouteBase() {
    var hash = window.location.hash || '#/';
    var anchorIndex = hash.indexOf('?id=');
    if (anchorIndex !== -1) {
      hash = hash.slice(0, anchorIndex);
    }
    return hash === '#' ? '#/' : hash;
  }

  // ---------- 搜索历史 ----------

  function loadHistory() {
    try {
      state.history = JSON.parse(localStorage.getItem(config.historyStorageKey)) || [];
    } catch (error) {
      state.history = [];
    }
    if (!Array.isArray(state.history)) {
      state.history = [];
    }
  }

  function persistHistory() {
    try {
      localStorage.setItem(config.historyStorageKey, JSON.stringify(state.history));
    } catch (error) {
      // 隐私模式下存储失败时静默降级，不影响搜索
    }
  }

  function recordHistory(query, url) {
    var trimmed = String(query || '').trim();
    if (!trimmed) {
      return;
    }
    state.history = state.history.filter(function (entry) {
      return entry && entry.query !== trimmed;
    });
    state.history.unshift({ query: trimmed, url: String(url || ''), at: Date.now() });
    if (state.history.length > config.maxHistoryEntries) {
      state.history.length = config.maxHistoryEntries;
    }
    persistHistory();
    renderAll();
  }

  function removeHistoryEntry(query) {
    state.history = state.history.filter(function (entry) {
      return entry.query !== query;
    });
    persistHistory();
    renderAll();
  }

  function clearHistory() {
    state.history = [];
    persistHistory();
    renderAll();
  }

  function timeAgo(at) {
    var diff = Date.now() - Number(at || 0);
    if (diff < 60000) {
      return '刚刚';
    }
    if (diff < 3600000) {
      return Math.floor(diff / 60000) + ' 分钟前';
    }
    if (diff < 86400000) {
      return Math.floor(diff / 3600000) + ' 小时前';
    }
    if (diff < 7 * 86400000) {
      return Math.floor(diff / 86400000) + ' 天前';
    }
    try {
      return new Date(at).toLocaleDateString();
    } catch (error) {
      return '';
    }
  }

  function autocompleteMatches(query) {
    var compact = compactText(query);
    if (!compact) {
      return [];
    }
    return state.history.filter(function (entry) {
      return compactText(entry.query).indexOf(compact) !== -1;
    }).slice(0, 5);
  }

  // ---------- 渲染 ----------

  function matchType(item, query) {
    var compact = compactText(query);
    if (compact && compactText(item.headingTitle + ' ' + item.title).indexOf(compact) !== -1) {
      return 'h';
    }
    return 't';
  }

  function groupResults(results) {
    var groups = [];
    var byRoute = {};
    results.forEach(function (item) {
      var group = byRoute[item.route];
      if (!group) {
        group = { route: item.route, pageTitle: item.pageTitle, path: item.path, entries: [], bestScore: -Infinity };
        byRoute[item.route] = group;
        groups.push(group);
      }
      group.entries.push(item);
      if (item.score > group.bestScore) {
        group.bestScore = item.score;
      }
    });
    groups.sort(function (left, right) {
      return right.bestScore - left.bestScore;
    });
    groups.forEach(function (group) {
      group.entries.sort(function (left, right) {
        return right.score - left.score;
      });
    });
    return groups;
  }

  function capGroups(groups, max) {
    var shown = 0;
    var capped = [];
    groups.forEach(function (group) {
      if (shown >= max) {
        return;
      }
      var take = Math.min(group.entries.length, max - shown);
      capped.push({
        route: group.route,
        pageTitle: group.pageTitle,
        path: group.path,
        total: group.entries.length,
        entries: group.entries.slice(0, take)
      });
      shown += take;
    });
    return capped;
  }

  function autocompleteHtml(view, matches) {
    return '<div class="custom-search-autocomplete">' + matches.map(function (entry) {
      var index = view.flat.length;
      view.flat.push({ kind: 'fill', item: entry });
      return [
        '<div class="custom-search-autocomplete-item" data-flat-index="' + index + '">',
        '<span class="custom-search-history-icon">🕘</span>',
        '<span class="custom-search-autocomplete-query">' + highlight(entry.query, [state.query], state.query) + '</span>',
        '<span class="custom-search-autocomplete-hint">填入搜索</span>',
        '</div>'
      ].join('');
    }).join('') + '</div>';
  }

  function historyPanelHtml(view) {
    var items = state.history.map(function (entry) {
      var index = view.flat.length;
      view.flat.push({ kind: 'open', item: entry });
      return [
        '<div class="custom-search-history-item" data-flat-index="' + index + '">',
        '<span class="custom-search-history-icon">🕘</span>',
        '<span class="custom-search-history-query">' + escapeHtml(entry.query) + '</span>',
        '<span class="custom-search-history-time">' + escapeHtml(timeAgo(entry.at)) + '</span>',
        '<button type="button" class="custom-search-history-remove" data-role="history-remove" data-query="' + escapeHtml(entry.query) + '" aria-label="删除这条记录">×</button>',
        '</div>'
      ].join('');
    }).join('');
    return [
      '<div class="custom-search-history">',
      items,
      '<div class="custom-search-history-actions">',
      '<button type="button" class="custom-search-history-clear" data-role="history-clear">清除全部</button>',
      '</div>',
      '</div>'
    ].join('');
  }

  function groupsHtml(view, groups) {
    var query = state.query;
    var tokens = queryTerms(query);
    var parsed = parseQuery(query);
    return groups.map(function (group) {
      var collapsed = state.collapsedGroups[group.route];
      var entries = collapsed ? '' : '<div class="custom-search-group-entries">' + group.entries.map(function (item) {
        var type = matchType(item, query);
        var index = view.flat.length;
        view.flat.push({ kind: 'result', item: item });
        var snippet = view.showSnippet
          ? '<span class="custom-search-result-snippet">' + makeSnippet(item, tokens, query) + '</span>'
          : '';
        return [
          '<a class="custom-search-result" data-flat-index="' + index + '" href="' + escapeHtml(item.url) + '">',
          '<span class="custom-search-badge badge-' + type + '" title="' + (type === 'h' ? '标题命中' : '正文命中') + '">' + (type === 'h' ? 'H' : 'T') + '</span>',
          '<span class="custom-search-result-title">' + highlight(item.headingTitle || item.title, tokens, query) + '</span>',
          snippet,
          '</a>'
        ].join('');
      }).join('') + '</div>';
      return [
        '<div class="custom-search-group' + (collapsed ? ' is-collapsed' : '') + '">',
        '<div class="custom-search-group-header" data-role="group-header" data-route="' + escapeHtml(group.route) + '">',
        '<span class="custom-search-group-icon">📄</span>',
        '<span class="custom-search-group-title">' + escapeHtml(group.path || group.pageTitle) + '</span>',
        '<span class="custom-search-group-count">' + group.total + (view.compact ? '' : ' 条命中') + '</span>',
        '<span class="custom-search-group-toggle">' + (collapsed ? '▸' : '▾') + '</span>',
        '</div>',
        entries,
        '</div>'
      ].join('');
    }).join('');
  }

  function applyActive(view) {
    var containers = [view.dropEl, view.resultsEl];
    containers.forEach(function (container) {
      if (!container) {
        return;
      }
      Array.prototype.forEach.call(container.querySelectorAll('.is-active'), function (el) {
        el.classList.remove('is-active');
      });
    });
    var target = (view.dropEl && view.dropEl.querySelector('[data-flat-index="' + view.activeIndex + '"]')) ||
      view.resultsEl.querySelector('[data-flat-index="' + view.activeIndex + '"]');
    if (target) {
      target.classList.add('is-active');
    }
  }

  function renderView(view) {
    var query = state.query;
    var statusText = '';
    var contentHtml = '';
    var dropHtml = '';
    var matches = [];
    view.flat = [];
    view.activeIndex = 0;

    if (!state.loaded) {
      statusText = '正在加载搜索索引...';
    } else if (state.error) {
      statusText = state.error;
    } else if (!query) {
      statusText = state.history.length ? '最近搜索' : '输入关键词开始搜索';
      contentHtml = state.history.length ? historyPanelHtml(view) : '';
    } else if (!hasEnoughQuery(query)) {
      statusText = isLikelyChineseQuery(query) ? '搜索中...' : '请至少输入 ' + config.minQueryLength + ' 个字符';
    } else {
      matches = view.autocompleteHidden ? [] : autocompleteMatches(query);
      dropHtml = matches.length ? autocompleteHtml(view, matches) : '';
      if (state.results.length) {
        var allGroups = groupResults(state.results);
        var groups = capGroups(allGroups, view.max);
        statusText = '找到 ' + state.results.length + ' 条命中 · ' + allGroups.length + ' 个文档' +
          (groups.reduce(function (total, group) { return total + group.entries.length; }, 0) < state.results.length ? '（显示前 ' + groups.reduce(function (total, group) { return total + group.entries.length; }, 0) + ' 条）' : '');
        contentHtml = groupsHtml(view, groups);
      } else {
        statusText = '没有找到结果';
        contentHtml = '<div class="custom-search-empty">换个更精确的寄存器、信号名或章节关键词试试。</div>';
      }
    }

    view.statusEl.textContent = statusText;
    if (view.root) {
      var scopeSelect = view.root.querySelector('[data-role="search-scope"]');
      var modeSelect = view.root.querySelector('[data-role="search-mode"]');
      if (scopeSelect) scopeSelect.value = state.searchScope;
      if (modeSelect) modeSelect.value = state.searchMode;
    }
    view.resultsEl.innerHTML = contentHtml;
    if (view.dropEl) {
      view.dropEl.innerHTML = dropHtml;
      view.dropEl.classList.toggle('is-visible', dropHtml.length > 0);
    }
    if (view.footerEl) {
      view.footerEl.style.display = view.flat.length ? '' : 'none';
    }
    applyActive(view);
  }

  function renderAll() {
    if (state.sidebar) {
      renderView(state.sidebar);
    }
    if (state.dialog) {
      renderView(state.dialog);
    }
    syncSidebarMode();
  }

  function syncSidebarMode() {
    document.body.classList.toggle('is-sidebar-searching', !!state.query);
  }

  // ---------- 交互 ----------

  function navigateToUrl(url) {
    window.location.href = url;
    if (window.location.protocol === 'file:') {
      scrollToSearchTarget(url);
    }
  }

  function openFlat(view, index) {
    var entry = view.flat[index];
    if (!entry) {
      return;
    }
    if (entry.kind === 'fill') {
      var query = entry.item.query;
      if (view.input) {
        view.input.value = query;
      }
      setQuery(query);
      view.autocompleteHidden = true;
      renderView(view);
    } else if (entry.kind === 'open') {
      if (view === state.dialog) {
        closeDialog();
      }
      reading.dismissed = null;
      navigateToUrl(entry.item.url);
      scheduleReadingModeBuild();
    } else if (entry.kind === 'result') {
      recordHistory(state.query, entry.item.url);
      if (view === state.dialog) {
        closeDialog();
      }
      reading.dismissed = null;
      navigateToUrl(entry.item.url);
      scheduleReadingModeBuild();
    }
  }

  function moveFlat(view, delta) {
    if (!view.flat.length) {
      return;
    }
    var max = view.flat.length - 1;
    view.activeIndex = Math.max(0, Math.min(max, view.activeIndex + delta));
    applyActive(view);
  }

  function setQuery(query) {
    state.query = String(query || '').trim();
    reading.dismissed = null;
    if (!state.query) {
      clearReadingMode(true);
    }
    if (state.sidebar) {
      state.sidebar.autocompleteHidden = false;
    }
    if (state.dialog) {
      state.dialog.autocompleteHidden = false;
    }
    renderAll();
    if (state.composing) {
      return;
    }
    clearTimeout(state.queryTimer);
    state.queryTimer = setTimeout(function () {
      state.results = search(state.query);
      renderAll();
    }, 120);
  }

  function clearSearch(view) {
    state.results = [];
    state.query = '';
    if (view && view.input) {
      view.input.value = '';
      view.input.focus();
    }
    clearReadingMode(true);
    renderAll();
  }

  function handleViewKeydown(view, event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFlat(view, 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFlat(view, -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openFlat(view, view.activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (view.dropEl && view.dropEl.classList.contains('is-visible')) {
        view.autocompleteHidden = true;
        renderView(view);
      } else if (view === state.dialog) {
        closeDialog();
      } else {
        clearSearch(view);
      }
    }
  }

  function handleViewClick(view, event) {
    var target = event.target;
    var role = target.getAttribute && target.getAttribute('data-role');
    if (role === 'history-remove') {
      removeHistoryEntry(target.getAttribute('data-query'));
      return;
    }
    if (role === 'history-clear') {
      clearHistory();
      return;
    }
    if (role === 'group-header') {
      var route = target.getAttribute('data-route');
      state.collapsedGroups[route] = !state.collapsedGroups[route];
      renderView(view);
      return;
    }
    var link = target.closest && target.closest('.custom-search-result');
    if (link) {
      openFlat(view, parseInt(link.getAttribute('data-flat-index'), 10));
      return;
    }
    var item = target.closest && target.closest('[data-flat-index]');
    if (item) {
      openFlat(view, parseInt(item.getAttribute('data-flat-index'), 10));
    }
  }

  function openDialog() {
    if (!state.dialog) {
      return;
    }
    state.dialog.root.classList.add('is-open');
    state.dialog.root.setAttribute('aria-hidden', 'false');
    renderView(state.dialog);
    setTimeout(function () {
      state.dialog.input && state.dialog.input.focus();
      state.dialog.input && state.dialog.input.select();
    }, 0);
  }

  function closeDialog() {
    if (!state.dialog) {
      return;
    }
    state.dialog.root.classList.remove('is-open');
    state.dialog.root.setAttribute('aria-hidden', 'true');
  }

  // ---------- 本文目录 ----------

  function getTocHeadingSelector() {
    var minLevel = Math.max(1, Math.min(6, parseInt(tocConfig.minLevel, 10) || 2));
    var maxLevel = Math.max(minLevel, Math.min(6, parseInt(tocConfig.maxLevel, 10) || 4));
    if (minLevel === 2 && maxLevel === 4) {
      return 'h2, h3, h4';
    }

    var selectors = [];
    for (var level = minLevel; level <= maxLevel; level += 1) {
      selectors.push('h' + level);
    }
    return selectors.join(', ');
  }

  function ensurePageToc() {
    if (!tocConfig.enabled) {
      return null;
    }
    if (state.pageToc && document.body.contains(state.pageToc)) {
      return state.pageToc;
    }

    var toc = document.createElement('nav');
    toc.className = 'docs-page-toc';
    toc.setAttribute('aria-label', String(tocConfig.title || '本文目录'));
    document.body.appendChild(toc);
    state.pageToc = toc;
    return toc;
  }


  var TOC_HIDDEN_KEY = 'md2web:hide-page-toc';

  var TOC_COLLAPSED_KEY = 'md2web:toc-collapsed';

  function loadTocCollapsedMap() {
    try {
      var parsed = JSON.parse(localStorage.getItem(TOC_COLLAPSED_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function saveTocCollapsedMap(map) {
    try {
      localStorage.setItem(TOC_COLLAPSED_KEY, JSON.stringify(map));
    } catch (error) { /* 忽略隐私模式 */ }
  }

  function loadTocCollapsed() {
    var map = loadTocCollapsedMap();
    return map[currentRouteBase()] || [];
  }

  var TOC_WIDTH_KEY = 'md2web:toc-width';
  var TOC_DEFAULT_WIDTH = 240;
  var TOC_MIN_WIDTH = 180;
  var TOC_MAX_WIDTH = 480;

  function readTocWidth() {
    try {
      var value = parseInt(localStorage.getItem(TOC_WIDTH_KEY) || '', 10);
      if (Number.isFinite(value) && value >= TOC_MIN_WIDTH && value <= TOC_MAX_WIDTH) {
        return value;
      }
    } catch (error) { /* 忽略 */ }
    return TOC_DEFAULT_WIDTH;
  }

  function applyTocWidth(width) {
    var value = Math.min(TOC_MAX_WIDTH, Math.max(TOC_MIN_WIDTH, Math.round(width || readTocWidth())));
    document.documentElement.style.setProperty('--docs-toc-width', value + 'px');
    return value;
  }

  function setupTocResize(toc) {
    if (toc.querySelector('.docs-page-toc-resizer')) {
      applyTocWidth();
      return;
    }
    var handle = document.createElement('div');
    handle.className = 'docs-page-toc-resizer';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', '拖动调整本文目录宽度');
    handle.title = '拖动调整目录宽度';
    toc.appendChild(handle);
    applyTocWidth();
    handle.addEventListener('mousedown', function (event) {
      event.preventDefault();
      var startX = event.clientX;
      var startWidth = toc.getBoundingClientRect().width || readTocWidth();
      handle.classList.add('is-dragging');
      document.body.classList.add('toc-resizing');
      function onMove(moveEvent) {
        // 右侧固定，向左拖动变宽、向右拖动变窄
        applyTocWidth(startWidth - (moveEvent.clientX - startX));
      }
      function onUp() {
        handle.classList.remove('is-dragging');
        document.body.classList.remove('toc-resizing');
        try {
          localStorage.setItem(TOC_WIDTH_KEY, String(Math.round(toc.getBoundingClientRect().width)));
        } catch (error) { /* 忽略 */ }
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function setTocHidden(hidden) {
    document.body.classList.toggle('hide-page-toc', !!hidden);
    ensureTocRestoreChip();
    if (!hidden) {
      applyTocWidth();
    }
    try {
      localStorage.setItem(TOC_HIDDEN_KEY, hidden ? '1' : '');
    } catch (error) { /* 忽略隐私模式 */ }
  }

  function restoreTocPreference() {
    try {
      if (localStorage.getItem(TOC_HIDDEN_KEY) === '1') {
        document.body.classList.add('hide-page-toc');
      }
    } catch (error) { /* 忽略 */ }
    ensureTocRestoreChip();
  }

  function ensureTocRestoreChip() {
    var existing = document.querySelector('.docs-page-toc-restore');
    if (existing) {
      return existing;
    }
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'docs-page-toc-restore';
    chip.title = '显示本文目录';
    chip.textContent = '目录';
    chip.addEventListener('click', function () {
      setTocHidden(false);
    });
    document.body.appendChild(chip);
    return chip;
  }

  function buildPageToc() {
    var toc = ensurePageToc();
    if (!toc) {
      return;
    }

    var section = document.querySelector('.markdown-section');
    if (!section) {
      toc.innerHTML = '';
      toc.classList.remove('has-items');
      return;
    }

    var headings = Array.prototype.slice.call(section.querySelectorAll(getTocHeadingSelector()))
      .filter(function (heading) {
        return heading.id && String(heading.textContent || '').trim();
      });

    if (!headings.length) {
      toc.innerHTML = '';
      toc.classList.remove('has-items');
      return;
    }

    var base = currentRouteBase();
    var counters = { 2: 0, 3: 0, 4: 0 };
    var collapsed = loadTocCollapsed();
    var rootItems = [];
    var stack = [];
    headings.forEach(function (heading) {
      var level = parseInt(heading.tagName.slice(1), 10);
      var href = base + '?id=' + encodeURIComponent(heading.id);
      var number = '';
      if (level >= 2 && level <= 4) {
        counters[level] += 1;
        for (var deeper = level + 1; deeper <= 4; deeper += 1) {
          counters[deeper] = 0;
        }
        var parts = [];
        for (var current = 2; current <= level; current += 1) {
          parts.push(counters[current]);
        }
        number = '<span class="docs-page-toc-index">' + parts.join('.') + '</span>';
      }
      var item = {
        id: heading.id,
        level: level,
        hasChildren: false,
        linkHtml: '<a class="docs-page-toc-link level-' + level + '" data-page-toc-id="' + escapeHtml(heading.id)
          + '" href="' + escapeHtml(href) + '">' + number + escapeHtml(heading.textContent) + '</a>',
        children: []
      };
      while (stack.length && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      if (stack.length) {
        stack[stack.length - 1].children.push(item);
        stack[stack.length - 1].hasChildren = true;
      } else {
        rootItems.push(item);
      }
      stack.push(item);
    });

    function renderTocItems(items) {
      return items.map(function (item) {
        var isCollapsed = item.hasChildren && collapsed.indexOf(item.id) >= 0;
        return '<div class="docs-page-toc-item level-' + item.level + (isCollapsed ? ' is-collapsed' : '') + '"'
          + ' data-toc-id="' + escapeHtml(item.id) + '">'
          + '<div class="docs-page-toc-row">'
          + (item.hasChildren
            ? '<button type="button" class="docs-page-toc-toggle" data-toc-toggle="' + escapeHtml(item.id) + '" title="折叠/展开该章节">' + (isCollapsed ? '▸' : '▾') + '</button>'
            : '<span class="docs-page-toc-toggle is-placeholder"></span>')
          + item.linkHtml
          + '</div>'
          + (item.hasChildren ? '<div class="docs-page-toc-children">' + renderTocItems(item.children) + '</div>' : '')
          + '</div>';
      }).join('');
    }

    toc.innerHTML = [
      '<div class="docs-page-toc-scroll">',
      '<div class="docs-page-toc-title"><span>' + escapeHtml(tocConfig.title || '本文目录')
        + '</span><button type="button" class="docs-page-toc-hide" title="隐藏本文目录">隐藏</button></div>',
      '<div class="docs-page-toc-links">',
      renderTocItems(rootItems),
      '</div>',
      '</div>'
    ].join('');
    if (toc.getAttribute('data-toc-toggle-bound') !== '1') {
      toc.setAttribute('data-toc-toggle-bound', '1');
      toc.addEventListener('click', function (event) {
        var toggle = event.target.closest && event.target.closest('[data-toc-toggle]');
        if (!toggle) {
          return;
        }
        event.preventDefault();
        var item = toggle.closest('.docs-page-toc-item');
        if (!item) {
          return;
        }
        var isCollapsed = item.classList.toggle('is-collapsed');
        toggle.textContent = isCollapsed ? '▸' : '▾';
        var map = loadTocCollapsedMap();
        var route = currentRouteBase();
        var list = map[route] || [];
        var id = item.getAttribute('data-toc-id');
        if (isCollapsed) {
          if (list.indexOf(id) === -1) {
            list.push(id);
          }
        } else {
          list = list.filter(function (value) { return value !== id; });
        }
        map[route] = list;
        saveTocCollapsedMap(map);
      });
    }
    var tocHideButton = toc.querySelector('.docs-page-toc-hide');
    if (tocHideButton) {
      tocHideButton.addEventListener('click', function () {
        setTocHidden(true);
      });
    }
    toc.classList.add('has-items');
    setupTocResize(toc);
    updateActiveTocLink();
  }

  var tocActiveTimer = 0;

  function updateActiveTocLink() {
    var toc = state.pageToc;
    if (!toc || !toc.classList.contains('has-items')) {
      return;
    }
    var links = Array.prototype.slice.call(toc.querySelectorAll('.docs-page-toc-link'));
    if (!links.length) {
      return;
    }
    var offset = 140;
    var activeId = null;
    links.forEach(function (link) {
      var id = link.getAttribute('data-page-toc-id');
      var heading = id ? document.getElementById(id) : null;
      if (heading && heading.getBoundingClientRect().top <= offset) {
        activeId = id;
      }
    });
    if (!activeId) {
      activeId = links[0].getAttribute('data-page-toc-id');
    }
    links.forEach(function (link) {
      var isActive = link.getAttribute('data-page-toc-id') === activeId;
      link.classList.toggle('is-active', isActive);
      if (!isActive) {
        return;
      }
      var item = link.closest ? link.closest('.docs-page-toc-item') : null;
      var previous = null;
      while (item && item !== previous) {
        item.classList.remove('is-collapsed');
        var toggle = item.querySelector(':scope > .docs-page-toc-row > .docs-page-toc-toggle');
        if (toggle && !toggle.classList.contains('is-placeholder')) {
          toggle.textContent = '▾';
        }
        previous = item;
        item = item.parentElement && item.parentElement.closest ? item.parentElement.closest('.docs-page-toc-item') : null;
      }
      var scroller = toc.querySelector('.docs-page-toc-scroll');
      if (scroller) {
        var linkTop = link.offsetTop;
        var linkBottom = linkTop + link.offsetHeight;
        if (linkTop < scroller.scrollTop) {
          scroller.scrollTop = Math.max(0, linkTop - 24);
        } else if (linkBottom > scroller.scrollTop + scroller.clientHeight) {
          scroller.scrollTop = linkBottom - scroller.clientHeight + 8;
        }
      }
    });
  }

  function scheduleActiveToc() {
    window.clearTimeout(tocActiveTimer);
    tocActiveTimer = window.setTimeout(updateActiveTocLink, 120);
  }

  function handleFilePageTocClick(event) {
    if (window.location.protocol !== 'file:') {
      return;
    }
    var link = event.target.closest && event.target.closest('.docs-page-toc-link');
    var id = link && link.getAttribute('data-page-toc-id');
    var heading = id && document.getElementById(id);
    if (!heading) {
      return;
    }

    // Chrome blocks Docsify's location.replace hash normalization for file:// pages.
    event.preventDefault();
    event.stopPropagation();
    scrollToHeadingEl(heading);
  }

  function scrollToHeadingEl(heading) {
    var top = heading.getBoundingClientRect().top + (window.pageYOffset || document.documentElement.scrollTop || 0);
    window.scrollTo(0, Math.max(0, top - 16));
  }

  function scrollToSearchTarget(url) {
    var queryIndex = String(url || '').indexOf('?id=');
    if (queryIndex === -1) {
      return;
    }
    var id = decodeURIComponent(String(url).slice(queryIndex + 4).split('&')[0]);
    var attempts = 0;
    var timer = setInterval(function () {
      var heading = document.getElementById(id);
      attempts += 1;
      if (heading) {
        clearInterval(timer);
        scrollToHeadingEl(heading);
        // file:// 下 docsify 的 ?id= 自动滚动失效，若 auto2top 随后把页面拉回顶部则重新定位
        [800, 1400].forEach(function (delay) {
          setTimeout(function () {
            var el = document.getElementById(id);
            if (el && (window.pageYOffset || document.documentElement.scrollTop || 0) < 50) {
              scrollToHeadingEl(el);
            }
          }, delay);
        });
      } else if (attempts > 80) {
        clearInterval(timer);
      }
    }, 50);
  }

  function handleSearchResultClick(event) {
    if (window.location.protocol !== 'file:') {
      return;
    }
    var link = event.target.closest && event.target.closest('.custom-search-result');
    if (!link) {
      return;
    }
    // file:// 下 docsify 不会自动滚动到 ?id= 锚点，手动等待渲染完成后定位
    scrollToSearchTarget(link.getAttribute('href'));
  }

  function schedulePageTocBuild() {
    if (!tocConfig.enabled) {
      return;
    }
    clearTimeout(state.tocTimer);
    state.tocTimer = setTimeout(buildPageToc, 80);
  }

  function observePageContent() {
    if (!tocConfig.enabled) {
      return;
    }
    window.addEventListener('hashchange', schedulePageTocBuild);

    if (state.tocObserver || !window.MutationObserver) {
      schedulePageTocBuild();
      return;
    }

    var target = document.querySelector('.content') || document.body;
    state.tocObserver = new MutationObserver(schedulePageTocBuild);
    state.tocObserver.observe(target, {
      childList: true,
      subtree: true
    });
    schedulePageTocBuild();
  }

  function docsifySlugifyHeading(text, seen) {
    var slug = String(text || '')
      .replace(/<!--.*?-->/g, '')
      .replace(/\{docsify-ignore(?:-all)?\}/g, '')
      .trim()
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/[A-Z]+/g, function (value) { return value.toLowerCase(); })
      .replace(/<[^>]+>/g, '')
      .replace(/[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
      .replace(/\s/g, '-')
      .replace(/-+/g, '-')
      .replace(/^([0-9])/, '_$1');
    var count = Object.prototype.hasOwnProperty.call(seen, slug) ? seen[slug] + 1 : 0;
    seen[slug] = count;
    return count ? slug + '-' + count : slug;
  }

  // ---------- 搜索索引 ----------

  function buildSearchPage(route, content, depth) {
    var index = {};
    var headingRe = /^(#{1,6})\s+(.+)$/;
    var fenceRe = /^(`{3,}|~{3,})(.*)$/;
    var seen = Object.create(null);
    var inFence = false;
    var fenceChar = '';
    var fenceLength = 0;
    var defaultTitle = String(route || '').split('/').pop() || 'Home Page';
    defaultTitle = defaultTitle.replace(/\.md$/i, '') || 'Home Page';
    var pageTitle = route === '/' ? '文档中心' : defaultTitle;
    var currentTitle = defaultTitle;
    var currentSlug = route;
    var currentBody = [];
    var sawHeading = false;

    function makeEntry(slug, title, body) {
      return {
        slug: slug,
        title: title,
        body: body,
        route: route,
        pageTitle: pageTitle,
        headingTitle: title
      };
    }

    function flushSection() {
      var body = currentBody.join('\n').trim();
      if (!Object.prototype.hasOwnProperty.call(index, currentSlug) || body) {
        index[currentSlug] = makeEntry(currentSlug, currentTitle, body);
      }
      currentBody = [];
    }

    String(content || '').split(/\r?\n/).forEach(function (line) {
      var fenceMatch = fenceRe.exec(line.replace(/^\s+/, ''));
      if (fenceMatch) {
        var marker = fenceMatch[1];
        var markerChar = marker.charAt(0);
        var tail = String(fenceMatch[2] || '');
        if (inFence && markerChar === fenceChar && marker.length >= fenceLength && /^\s*$/.test(tail)) {
          currentBody.push(line);
          inFence = false;
          fenceChar = '';
          fenceLength = 0;
        } else if (!inFence) {
          currentBody.push(line);
          inFence = true;
          fenceChar = markerChar;
          fenceLength = marker.length;
        } else {
          currentBody.push(line);
        }
        return;
      }
      if (inFence) {
        currentBody.push(line);
        return;
      }

      var match = headingRe.exec(line);
      if (!match) {
        currentBody.push(line);
        return;
      }

      var headingId = docsifySlugifyHeading(match[2].trim(), seen);
      if (match[1].length > depth) {
        currentBody.push(line);
        return;
      }
      if (sawHeading || currentBody.join('').trim()) {
        flushSection();
      }
      sawHeading = true;
      currentTitle = match[2].trim();
      currentSlug = headingId ? route + '?id=' + headingId : route;
    });

    flushSection();
    if (!sawHeading && !Object.prototype.hasOwnProperty.call(index, route)) {
      index[route] = makeEntry(route, route === '/' ? 'Home Page' : defaultTitle, String(content || '').trim());
    }
    return index;
  }

  function buildSearchIndex(contents, routes) {
    var index = {};
    var depth = Math.max(1, Math.min(6, parseInt(config.searchDepth, 10) || 4));
    routes.forEach(function (route) {
      var resource = route === '/' ? 'README.md' : route.replace(/^\/+/, '');
      if (Object.prototype.hasOwnProperty.call(contents, resource)) {
        index[route] = buildSearchPage(route, contents[resource], depth);
      }
    });
    return index;
  }

  function routeToResource(route) {
    return route === '/' ? 'README.md' : route.replace(/^\/+/, '');
  }

  function getSearchRoutes() {
    var routes = Object.keys(state.index || {});
    if (routes.length) {
      return routes;
    }

    var offlineData = window.__DOCSIFY_OFFLINE_DATA__;
    var content = offlineData && offlineData.content;
    return Object.keys(content || {}).filter(function (resource) {
      return resource !== '_sidebar.md' && /\.md$/i.test(resource);
    }).map(function (resource) {
      return resource === 'README.md' ? '/' : '/' + resource;
    });
  }

  function applySearchIndex(index) {
    state.index = index || {};
    state.items = flattenIndex(state.index);
    state.loaded = true;
    state.error = '';
    state.results = search(state.query);
    [state.sidebar, state.dialog].forEach(function (view) {
      if (!view || !view.root) return;
      var old = view.root.querySelector('[data-role="search-scope"]');
      if (old) {
        var value = state.searchScope;
        old.innerHTML = searchScopeOptions();
        old.value = value;
      }
    });
    renderAll();
    scheduleReadingModeBuild();
  }

  function refreshSearchIndex(sourceView) {
    var sidebarButton = state.sidebar && state.sidebar.refreshButton;
    var dialogButton = state.dialog && state.dialog.refreshButton;
    if (sidebarButton && sidebarButton.disabled) {
      return;
    }

    var routes = getSearchRoutes();
    var offlineData = window.__DOCSIFY_OFFLINE_DATA__;
    var promise;
    if (window.location.protocol === 'file:' && offlineData && offlineData.content) {
      promise = Promise.resolve(buildSearchIndex(offlineData.content, routes));
    } else {
      var contents = {};
      promise = Promise.all(routes.map(function (route) {
        var resource = routeToResource(route);
        return fetch(resource, { cache: 'no-cache' })
          .then(function (response) {
            if (!response.ok) {
              throw new Error('HTTP ' + response.status + ': ' + resource);
            }
            return response.text();
          })
          .then(function (text) {
            contents[resource] = text;
          });
      })).then(function () {
        return buildSearchIndex(contents, routes);
      });
    }

    var buttons = [sidebarButton, dialogButton].filter(Boolean);
    buttons.forEach(function (button) {
      button.disabled = true;
      button.classList.add('is-loading');
    });
    if (state.sidebar && state.sidebar.refreshStatus) {
      state.sidebar.refreshStatus.className = 'custom-search-refresh-status is-loading';
      state.sidebar.refreshStatus.textContent = '正在更新搜索索引...';
    }
    if (sourceView && sourceView.statusEl) {
      sourceView.statusEl.textContent = '正在更新搜索索引...';
    }
    promise
      .then(function (index) {
        applySearchIndex(index);
        var pages = Object.keys(index || {}).length;
        var entries = Object.keys(index || {}).reduce(function (total, route) {
          return total + Object.keys(index[route] || {}).length;
        }, 0);
        if (state.sidebar && state.sidebar.refreshStatus) {
          state.sidebar.refreshStatus.className = 'custom-search-refresh-status is-success';
          state.sidebar.refreshStatus.textContent = '更新成功：' + pages + ' 个文档页，' + entries + ' 条索引';
        }
        if (sourceView && sourceView.statusEl) {
          sourceView.statusEl.textContent = '更新成功：' + pages + ' 个文档页，' + entries + ' 条索引';
        }
      })
      .catch(function (error) {
        state.error = '搜索索引更新失败' + (error && error.message ? '：' + error.message : '');
        renderAll();
        if (state.sidebar && state.sidebar.refreshStatus) {
          state.sidebar.refreshStatus.className = 'custom-search-refresh-status is-error';
          state.sidebar.refreshStatus.textContent = '更新失败：' + (error && error.message ? error.message : '未知错误');
        }
        if (sourceView && sourceView.statusEl) {
          sourceView.statusEl.textContent = '更新失败：' + (error && error.message ? error.message : '未知错误');
        }
      })
      .then(function () {
        buttons.forEach(function (button) {
          button.disabled = false;
          button.classList.remove('is-loading');
        });
      });
  }

  function flattenIndex(index) {
    var items = [];
    Object.keys(index || {}).forEach(function (routeKey) {
      var page = index[routeKey] || {};
      Object.keys(page).forEach(function (slugKey) {
        var entry = page[slugKey] || {};
        var slug = entry.slug || slugKey;
        var route = entry.route || routeKey || String(slug).split('?')[0];
        var pageTitle = entry.pageTitle || titleFromRoute(route);
        var headingTitle = entry.headingTitle || entry.title || pageTitle;
        var title = entry.title || headingTitle || pageTitle;
        var body = entry.body || '';
        var raw = [route, pageTitle, headingTitle, title, body].join('\n');

        items.push({
          slug: slug,
          url: routeToHash(slug, page && page.site),
          route: route,
          pageTitle: pageTitle,
          headingTitle: headingTitle,
          title: title,
          body: body,
          path: route === '/' ? 'README.md' : route.replace(/^\/+md\//, '').replace(/^\//, ''),
          rawLower: raw.toLowerCase(),
          routeText: normalizeText(route),
          pageTitleText: normalizeText(pageTitle),
          headingText: normalizeText(headingTitle + ' ' + title),
          bodyText: normalizeText(body),
          combinedText: normalizeText(raw)
        });
      });
    });
    return items;
  }

  function scoreItem(item, tokens, query) {
    var rawQuery = String(query || '').toLowerCase();
    var compactQuery = compactText(query);
    var score = 0;

    if (item.rawLower.indexOf(rawQuery) !== -1) {
      score += 80;
    }
    if (compactQuery && compactText(item.route).indexOf(compactQuery) !== -1) {
      score += 120;
    }
    if (compactQuery && compactText(item.headingTitle + ' ' + item.title).indexOf(compactQuery) !== -1) {
      score += 150;
    }

    tokens.forEach(function (token) {
      if (item.routeText.indexOf(token) !== -1) {
        score += 35;
      }
      if (item.pageTitleText.indexOf(token) !== -1) {
        score += 45;
      }
      if (item.headingText.indexOf(token) !== -1) {
        score += 60;
      }
      if (item.bodyText.indexOf(token) !== -1) {
        score += 10;
      }
    });

    if (item.body.length > 12000) {
      score -= Math.min(25, Math.floor(item.body.length / 12000));
    }
    return score;
  }

  function routeWithoutAnchor(route) {
    return String(route || '').split('?')[0].replace(/\/$/, '') || '/';
  }

  function itemInScope(item) {
    var scope = String(state.searchScope || 'all');
    if (scope === 'all') {
      return true;
    }
    if (scope === 'current') {
      return routeWithoutAnchor(item.route) === routeWithoutAnchor(currentRouteBase().replace(/^#/, ''));
    }
    if (scope.indexOf('folder:') === 0) {
      var folder = routeWithoutAnchor(scope.slice(7));
      var route = routeWithoutAnchor(item.route);
      return folder === '/' ? true : (route === folder || route.indexOf(folder + '/') === 0);
    }
    return true;
  }

  function searchableText(item) {
    if (state.searchMode === 'file') {
      return [item.path, item.route, item.pageTitle, item.headingTitle, item.title].join('\n');
    }
    return item.combinedText;
  }

  function search(query) {
    if (!state.loaded || !hasEnoughQuery(query)) {
      return [];
    }
    var parsed = parseQuery(query);
    var tokens = queryTerms(query);
    if (!tokens.length) {
      return [];
    }

    return state.items
      .filter(function (item) {
        if (!itemInScope(item)) {
          return false;
        }
        var text = normalizeText(searchableText(item));
        var phraseOk = parsed.positive.every(function (phrase) { return text.indexOf(phrase) !== -1; });
        var excluded = parsed.negative.some(function (term) { return text.indexOf(term) !== -1; });
        return phraseOk && !excluded;
      })
      .map(function (item) {
        return Object.assign({ score: scoreItem(item, tokens, query) }, item);
      })
      .sort(function (left, right) {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.route.localeCompare(right.route);
      });
  }

  function makeSnippet(item, tokens, query) {
    var source = String(item.body || item.headingTitle || item.pageTitle || '').replace(/\s+/g, ' ').trim();
    if (!source) {
      return '';
    }

    var lower = source.toLowerCase();
    var queryIndex = lower.indexOf(String(query || '').toLowerCase());
    var firstTokenIndex = -1;
    tokens.forEach(function (token) {
      var index = lower.indexOf(token);
      if (index !== -1 && (firstTokenIndex === -1 || index < firstTokenIndex)) {
        firstTokenIndex = index;
      }
    });
    var index = queryIndex !== -1 ? queryIndex : firstTokenIndex;
    var start = index > 70 ? index - 70 : 0;
    var end = Math.min(source.length, start + 190);
    var snippet = (start > 0 ? '...' : '') + source.slice(start, end) + (end < source.length ? '...' : '');
    return highlight(snippet, tokens, query);
  }

  function highlight(text, tokens, query) {
    var escaped = escapeHtml(text);
    var terms = tokens.slice();
    parseQuery(query).positive.forEach(function (term) { terms.unshift(term); });
    terms
      .filter(function (term, index, all) {
        return term && all.indexOf(term) === index;
      })
      .sort(function (left, right) {
        return right.length - left.length;
      })
      .forEach(function (term) {
        escaped = escaped.replace(new RegExp(escapeRegExp(escapeHtml(term)), 'gi'), '<mark>$&</mark>');
      });
    return escaped;
  }

  // ---------- 侧边栏宽度调节 ----------

  function isDesktopSidebar() {
    return window.matchMedia('(min-width: 769px)').matches;
  }

  function clampSidebarWidth(width) {
    var viewportLimit = Math.max(config.minSidebarWidth, window.innerWidth - 360);
    var maxWidth = Math.min(config.maxSidebarWidth, viewportLimit);
    return Math.max(config.minSidebarWidth, Math.min(maxWidth, Math.round(width)));
  }

  function applySidebarWidth(width, persist) {
    if (!isDesktopSidebar()) {
      document.documentElement.style.removeProperty('--docs-sidebar-width');
      return;
    }
    var clamped = clampSidebarWidth(width);
    document.documentElement.style.setProperty('--docs-sidebar-width', clamped + 'px');
    if (persist) {
      try {
        localStorage.setItem(config.sidebarWidthStorageKey, String(clamped));
      } catch (error) {
        // Ignore storage failures; dragging should still work for this session.
      }
    }
  }

  function readStoredSidebarWidth() {
    try {
      var stored = parseInt(localStorage.getItem(config.sidebarWidthStorageKey), 10);
      return Number.isFinite(stored) ? stored : config.defaultSidebarWidth;
    } catch (error) {
      return config.defaultSidebarWidth;
    }
  }

  function setupSidebarResize(aside) {
    if (state.sidebarResizer || aside.querySelector('.custom-sidebar-resizer')) {
      applySidebarWidth(readStoredSidebarWidth(), false);
      return;
    }

    var handle = document.createElement('div');
    handle.className = 'custom-sidebar-resizer';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', '调整侧边栏宽度');
    handle.tabIndex = 0;
    aside.appendChild(handle);
    state.sidebarResizer = handle;
    applySidebarWidth(readStoredSidebarWidth(), false);

    function resizeFromClientX(clientX, persist) {
      var left = aside.getBoundingClientRect().left;
      applySidebarWidth(clientX - left, persist);
    }

    function stopResize() {
      document.body.classList.remove('is-resizing-sidebar');
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    }

    function onPointerMove(event) {
      event.preventDefault();
      resizeFromClientX(event.clientX, true);
    }

    function onPointerUp(event) {
      resizeFromClientX(event.clientX, true);
      stopResize();
    }

    handle.addEventListener('pointerdown', function (event) {
      if (!isDesktopSidebar()) {
        return;
      }
      event.preventDefault();
      document.body.classList.add('is-resizing-sidebar');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    });

    handle.addEventListener('keydown', function (event) {
      if (!isDesktopSidebar()) {
        return;
      }
      var current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--docs-sidebar-width'), 10) || readStoredSidebarWidth();
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        applySidebarWidth(current - 20, true);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        applySidebarWidth(current + 20, true);
      } else if (event.key === 'Home') {
        event.preventDefault();
        applySidebarWidth(config.minSidebarWidth, true);
      } else if (event.key === 'End') {
        event.preventDefault();
        applySidebarWidth(config.maxSidebarWidth, true);
      }
    });

    window.addEventListener('resize', function () {
      applySidebarWidth(readStoredSidebarWidth(), false);
    });
  }

  // ---------- 文档内命中阅读模式 ----------

  var reading = {
    active: false,
    query: '',
    route: '',
    matches: [],
    marks: [],
    current: -1,
    wrapped: [],
    foldedNonHits: false,
    buildTimer: null,
    dismissed: null
  };

  function getRouteFromHash() {
    var hash = window.location.hash || '#/';
    var anchorIndex = hash.indexOf('?id=');
    if (anchorIndex !== -1) {
      hash = hash.slice(0, anchorIndex);
    }
    hash = hash === '#' ? '/' : hash.slice(1);
    try {
      return decodeURIComponent(hash);
    } catch (error) {
      return hash;
    }
  }

  function clearReadingMode(userInitiated) {
    if (userInitiated) {
      // 用户主动清除：在搜索词或文档变化前不再自动重建（避免 MutationObserver 立即重新激活）
      reading.dismissed = { route: getRouteFromHash(), query: state.query };
    }
    var section = document.querySelector('.markdown-section');
    if (section) {
      var toolbar = section.querySelector('.search-reading-toolbar');
      if (toolbar) {
        toolbar.parentNode.removeChild(toolbar);
      }
    }
    document.body.classList.remove('search-reading');
    clearReadingMarks();
    reading.wrapped.forEach(function (entry) {
      var wrapper = entry.wrapper;
      if (wrapper.isConnected && wrapper.parentNode) {
        var parent = wrapper.parentNode;
        while (wrapper.firstChild) {
          parent.insertBefore(wrapper.firstChild, wrapper);
        }
        parent.removeChild(wrapper);
      }
      var heading = entry.heading;
      if (heading.isConnected) {
        heading.classList.remove('is-collapsed', 'has-match-badge', 'search-section-heading');
        if (entry.arrow && entry.arrow.parentNode) {
          entry.arrow.parentNode.removeChild(entry.arrow);
        }
        if (entry.badge && entry.badge.parentNode) {
          entry.badge.parentNode.removeChild(entry.badge);
        }
        if (heading._readingClick) {
          heading.removeEventListener('click', heading._readingClick);
          heading._readingClick = null;
        }
      }
    });
    reading.wrapped = [];
    try {
      if (window.CSS && CSS.highlights) {
        CSS.highlights.delete('docsify-search-hl');
        CSS.highlights.delete('docsify-search-current');
      }
    } catch (error) {
      // 浏览器不支持 Highlight API 时静默
    }
    reading.active = false;
    reading.matches = [];
    reading.current = -1;
    reading.foldedNonHits = false;
  }

  function collectReadingRanges(section, query, tokens) {
    var ranges = [];
    var rawLower = String(query).toLowerCase();
    var walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent || parent.closest('pre, code, .anchor, .search-reading-toolbar')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var textNodes = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }
    textNodes.forEach(function (node) {
      var text = node.nodeValue || '';
      var lower = text.toLowerCase();
      var terms = lower.indexOf(rawLower) !== -1 ? [rawLower] : tokens;
      terms.forEach(function (term) {
        var index = 0;
        while (true) {
          index = lower.indexOf(term, index);
          if (index === -1) {
            break;
          }
          var range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + term.length);
          ranges.push(range);
          index += term.length;
        }
      });
    });
    ranges.sort(function (left, right) {
      return left.compareBoundaryPoints(Range.START_TO_START, right);
    });
    return ranges;
  }

  function supportsHighlightApi() {
    return !!(window.CSS && CSS.highlights && window.Highlight);
  }

  function wrapReadingMatches() {
    reading.marks = [];
    for (var i = reading.matches.length - 1; i >= 0; i -= 1) {
      var range = reading.matches[i];
      var mark = document.createElement('mark');
      mark.className = 'search-reading-mark';
      try {
        range.surroundContents(mark);
        reading.marks[i] = mark;
      } catch (error) {
        reading.marks[i] = null;
      }
    }
  }

  function clearReadingMarks() {
    (reading.marks || []).forEach(function (mark) {
      if (!mark || !mark.isConnected || !mark.parentNode) {
        return;
      }
      var parent = mark.parentNode;
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      parent.normalize();
    });
    reading.marks = [];
  }

  function updateCurrentMark() {
    (reading.marks || []).forEach(function (mark) {
      if (mark) {
        mark.classList.remove('is-current');
      }
    });
    var current = reading.marks && reading.marks[reading.current];
    if (current) {
      current.classList.add('is-current');
    }
  }

  function applyReadingHighlight() {
    if (!supportsHighlightApi()) {
      updateCurrentMark();
      return;
    }
    CSS.highlights.delete('docsify-search-hl');
    CSS.highlights.delete('docsify-search-current');
    if (reading.matches.length) {
      var highlight = new Highlight();
      reading.matches.forEach(function (range) {
        highlight.add(range);
      });
      CSS.highlights.set('docsify-search-hl', highlight);
    }
    var current = reading.matches[reading.current];
    if (current) {
      var currentHighlight = new Highlight();
      currentHighlight.add(current);
      CSS.highlights.set('docsify-search-current', currentHighlight);
    }
  }

  function updateReadingFoldButton() {
    var button = document.querySelector('.search-reading-toolbar [data-role="fold-nonhits"]');
    if (!button) {
      return;
    }
    var anyCollapsed = reading.wrapped.some(function (entry) {
      return entry.wrapper.style.display === 'none';
    });
    button.textContent = anyCollapsed ? '展开全部' : '折叠非命中';
  }

  function computeSectionCounts(headings, matches) {
    var counts = headings.map(function () { return 0; });
    matches.forEach(function (range) {
      var node = range.startContainer;
      var owner = -1;
      headings.forEach(function (heading, index) {
        // heading 位于该命中之前（PRECEDING）→ 命中属于该章节；取最后一个满足的标题
        if (node.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_PRECEDING) {
          owner = index;
        }
      });
      if (owner !== -1) {
        counts[owner] += 1;
      }
    });
    return counts;
  }

  function wrapReadingSections(section, counts) {
    var headings = Array.prototype.slice.call(section.querySelectorAll('h2, h3, h4'));
    headings.forEach(function (heading, index) {
      var level = parseInt(heading.tagName.slice(1), 10);
      var bodyNodes = [];
      var sibling = heading.nextElementSibling;
      while (sibling) {
        if (/^H[1-6]$/.test(sibling.tagName) && parseInt(sibling.tagName.slice(1), 10) <= level) {
          break;
        }
        bodyNodes.push(sibling);
        sibling = sibling.nextElementSibling;
      }
      if (!bodyNodes.length) {
        return;
      }
      var wrapper = document.createElement('div');
      wrapper.className = 'search-section-body';
      bodyNodes.forEach(function (node) {
        wrapper.appendChild(node);
      });
      heading.parentNode.insertBefore(wrapper, heading.nextSibling);

      var arrow = document.createElement('span');
      arrow.className = 'search-section-arrow';
      arrow.textContent = '▾';
      heading.insertBefore(arrow, heading.firstChild);

      var count = counts ? counts[index] : 0;
      var badge = null;
      if (count > 0) {
        badge = document.createElement('span');
        badge.className = 'search-section-badge';
        badge.textContent = String(count);
        heading.insertBefore(badge, heading.firstChild);
        heading.classList.add('has-match-badge');
      }

      var entry = { heading: heading, wrapper: wrapper, arrow: arrow, badge: badge, count: count };
      reading.wrapped.push(entry);

      var onClick = function () {
        var collapsed = wrapper.style.display === 'none';
        wrapper.style.display = collapsed ? '' : 'none';
        heading.classList.toggle('is-collapsed', !collapsed);
        arrow.textContent = collapsed ? '▾' : '▸';
        updateReadingFoldButton();
      };
      heading._readingClick = onClick;
      heading.addEventListener('click', onClick);
      heading.classList.add('search-section-heading');
    });
  }

  function buildReadingToolbar(section) {
    var toolbar = document.createElement('div');
    toolbar.className = 'search-reading-toolbar';
    document.body.classList.add('search-reading');
    window.requestAnimationFrame(function () {
      var height = Math.round(toolbar.getBoundingClientRect().height);
      if (height > 0) {
        document.documentElement.style.setProperty('--reading-toolbar-h', (height + 8) + 'px');
      }
    });
    toolbar.innerHTML = [
      '<div class="search-reading-info">🔍 ' + escapeHtml(reading.query) + ' · ' + reading.matches.length + ' 处命中</div>',
      '<div class="search-reading-actions">',
      '<button type="button" class="search-reading-btn" data-role="prev-match" title="上一个命中 (Shift+F3)">↑</button>',
      '<button type="button" class="search-reading-btn" data-role="next-match" title="下一个命中 (F3)">↓</button>',
      '<button type="button" class="search-reading-btn search-reading-fold" data-role="fold-nonhits">折叠非命中</button>',
      '<button type="button" class="search-reading-btn" data-role="clear-reading" title="清除 (Esc)">✕ 清除</button>',
      '</div>'
    ].join('');
    section.insertBefore(toolbar, section.firstChild);
    toolbar.addEventListener('click', function (event) {
      var role = event.target.getAttribute && event.target.getAttribute('data-role');
      if (role === 'prev-match') {
        readingNavigate(-1);
      } else if (role === 'next-match') {
        readingNavigate(1);
      } else if (role === 'fold-nonhits') {
        toggleFoldNonHits();
      } else if (role === 'clear-reading') {
        clearReadingMode(true);
      }
    });
  }

  function readingNavigate(delta) {
    if (!reading.active || !reading.matches.length) {
      return;
    }
    var count = reading.matches.length;
    reading.current = (reading.current + delta + count) % count;
    applyReadingHighlight();
    var range = reading.matches[reading.current];
    var container = range.startContainer;
    var node = container.nodeType === 1 ? container : container.parentElement;
    var bodyEl = node && node.closest ? node.closest('.search-section-body') : null;
    if (bodyEl && bodyEl.style.display === 'none') {
      var heading = bodyEl.previousElementSibling;
      bodyEl.style.display = '';
      if (heading) {
        heading.classList.remove('is-collapsed');
        var arrow = heading.querySelector('.search-section-arrow');
        if (arrow) {
          arrow.textContent = '▾';
        }
      }
      updateReadingFoldButton();
    }
    var rect = range.getBoundingClientRect();
    window.scrollTo(0, Math.max(0, window.pageYOffset + rect.top - 140));
  }

  function toggleFoldNonHits() {
    if (reading.foldedNonHits) {
      reading.wrapped.forEach(function (entry) {
        entry.wrapper.style.display = '';
        entry.heading.classList.remove('is-collapsed');
        entry.arrow.textContent = '▾';
      });
      reading.foldedNonHits = false;
    } else {
      reading.wrapped.forEach(function (entry) {
        if (entry.count === 0) {
          entry.wrapper.style.display = 'none';
          entry.heading.classList.add('is-collapsed');
          entry.arrow.textContent = '▸';
        }
      });
      reading.foldedNonHits = true;
    }
    updateReadingFoldButton();
  }

  function updateReadingCurrentForAnchor() {
    var hash = window.location.hash || '';
    var idIndex = hash.indexOf('?id=');
    if (idIndex === -1 || !reading.matches.length) {
      return;
    }
    var id = decodeURIComponent(hash.slice(idIndex + 4).split('&')[0]);
    var heading = document.getElementById(id);
    if (!heading) {
      return;
    }
    var firstMatch = -1;
    for (var i = 0; i < reading.matches.length; i += 1) {
      var container = reading.matches[i].startContainer;
      var node = container.nodeType === 1 ? container : container.parentElement;
      if (node && heading.contains(node)) {
        firstMatch = i;
        break;
      }
    }
    if (firstMatch === -1) {
      var headingRange = document.createRange();
      headingRange.selectNode(heading);
      for (var j = 0; j < reading.matches.length; j += 1) {
        if (reading.matches[j].compareBoundaryPoints(Range.START_TO_START, headingRange) >= 0) {
          firstMatch = j;
          break;
        }
      }
    }
    if (firstMatch !== -1) {
      reading.current = firstMatch;
      applyReadingHighlight();
    }
  }

  function scheduleReadingModeBuild() {
    clearTimeout(reading.buildTimer);
    reading.buildTimer = setTimeout(buildReadingMode, 120);
  }

  function buildReadingMode() {
    var section = document.querySelector('.markdown-section');
    var query = state.query;
    var route = getRouteFromHash();
    var tokens = queryTerms(query);
    var parsed = parseQuery(query);
    if (!section || !query || !state.loaded || !tokens.length) {
      if (reading.active) {
        clearReadingMode();
      }
      return;
    }
    var routeHit = state.items.some(function (item) {
      if (routeWithoutAnchor(item.route) !== routeWithoutAnchor(route)) {
        return false;
      }
      var text = normalizeText(searchableText(item));
      return parsed.positive.every(function (term) { return text.indexOf(term) !== -1; }) &&
        !parsed.negative.some(function (term) { return text.indexOf(term) !== -1; });
    });
    if (!routeHit) {
      if (reading.active) {
        clearReadingMode();
      }
      return;
    }
    if (reading.dismissed && reading.dismissed.route === route && reading.dismissed.query === query) {
      return;
    }
    if (reading.active && reading.route === route && reading.query === query) {
      // 仅当工具条和包装仍然存在时才认为是同一份已渲染文档（锚点跳转）；
      // 若 docsify 重新渲染导致 DOM 被替换，则需要完整重建
      var toolbar = section.querySelector('.search-reading-toolbar');
      var domIntact = !!toolbar && reading.wrapped.every(function (entry) {
        return entry.heading.isConnected && entry.wrapper.isConnected;
      });
      if (domIntact) {
        updateReadingCurrentForAnchor();
        return;
      }
    }
    if (reading.active) {
      clearReadingMode();
    }

    reading.active = true;
    reading.query = query;
    reading.route = route;
    reading.matches = collectReadingRanges(section, query, tokens);
    reading.marks = [];
    if (!supportsHighlightApi()) {
      wrapReadingMatches();
    }
    reading.current = -1;
    reading.wrapped = [];
    reading.foldedNonHits = false;

    var headings = Array.prototype.slice.call(section.querySelectorAll('h2, h3, h4'));
    var sectionCounts = computeSectionCounts(headings, reading.matches);
    wrapReadingSections(section, sectionCounts);
    buildReadingToolbar(section);
    applyReadingHighlight();
    updateReadingCurrentForAnchor();
    if (reading.current === -1 && reading.matches.length) {
      reading.current = 0;
      applyReadingHighlight();
    }
  }

  // ---------- 界面构建 ----------

  function searchScopeOptions() {
    var routes = getSearchRoutes();
    var folders = {};
    routes.forEach(function (route) {
      var path = routeWithoutAnchor(route).replace(/^\/+/, '');
      var parts = path.split('/');
      parts.pop();
      var prefix = '';
      parts.forEach(function (part) {
        prefix += (prefix ? '/' : '') + part;
        if (prefix && prefix !== 'md') {
          folders['/md/' + prefix] = true;
        }
      });
    });
    return ['<option value="all">全部文档</option>', '<option value="current">当前文档</option>']
      .concat(Object.keys(folders).sort().map(function (folder) {
        return '<option value="folder:' + escapeHtml(folder) + '">文件夹：' + escapeHtml(folder.replace(/^\/md\//, '')) + '</option>';
      })).join('');
  }

  var SEARCH_FILTERS_KEY = 'md2web:search-filters-open';

  function searchFiltersHtml() {
    return '<div class="custom-search-filters" data-role="search-filters" hidden>' +
      '<label>范围 <select data-role="search-scope" aria-label="搜索范围">' + searchScopeOptions() + '</select></label>' +
      '<label>模式 <select data-role="search-mode" aria-label="搜索模式"><option value="full">全文</option><option value="file">文件名/路径</option></select></label>' +
      '</div>';
  }

  function bindSearchFilters(view, root) {
    var filters = root.querySelector('[data-role="search-filters"]');
    var toggle = root.querySelector('[data-role="filter-toggle"]');
    if (toggle && filters) {
      var stored = null;
      try {
        stored = localStorage.getItem(SEARCH_FILTERS_KEY);
      } catch (error) { /* 忽略隐私模式 */ }
      filters.hidden = stored !== '1';
      toggle.setAttribute('aria-expanded', filters.hidden ? 'false' : 'true');
      toggle.addEventListener('click', function () {
        filters.hidden = !filters.hidden;
        toggle.setAttribute('aria-expanded', filters.hidden ? 'false' : 'true');
        try {
          localStorage.setItem(SEARCH_FILTERS_KEY, filters.hidden ? '' : '1');
        } catch (error) { /* 忽略 */ }
      });
    }
    function refreshToggleState() {
      if (!toggle) {
        return;
      }
      var active = state.searchScope !== 'all' || state.searchMode !== 'full';
      toggle.classList.toggle('is-active', active);
      toggle.title = active ? '搜索范围/模式已筛选（点击展开）' : '搜索范围与模式';
    }
    refreshToggleState();
    var scope = root.querySelector('[data-role="search-scope"]');
    var mode = root.querySelector('[data-role="search-mode"]');
    if (scope) {
      scope.value = state.searchScope;
      scope.addEventListener('change', function () {
        state.searchScope = scope.value;
        state.results = search(state.query);
        refreshToggleState();
        renderAll();
      });
    }
    if (mode) {
      mode.value = state.searchMode;
      mode.addEventListener('change', function () {
        state.searchMode = mode.value;
        state.results = search(state.query);
        refreshToggleState();
        renderAll();
      });
    }
  }

  var SIDEBAR_HOME_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.4 7.1 8 2.4l5.6 4.7v5.6a.9.9 0 0 1-.9.9h-3.2V9.8H6.5v3.8H3.3a.9.9 0 0 1-.9-.9z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  var SIDEBAR_AI_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="2.1" y="4.4" width="11.8" height="9.1" rx="2.1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.4V2.3M5.7 8.3h.01M10.3 8.3h.01M5.9 11h4.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

  // 把侧栏顶部站点名替换为 HOME 图标，并在其右侧加入 AI 配置入口
  function installSidebarIcons(aside) {
    var root = aside || document.querySelector('aside.sidebar') || document.querySelector('.sidebar');
    if (!root) {
      return;
    }
    var appName = root.querySelector('.app-name');
    if (!appName || appName.getAttribute('data-custom-icons') === '1') {
      return;
    }
    var title = String(appName.textContent || '').trim() || '文档中心';
    appName.setAttribute('data-custom-icons', '1');
    appName.innerHTML = [
      '<span class="custom-sidebar-icons">',
      '<a class="custom-sidebar-icon" href="#/" title="' + escapeHtml(title) + '（Home）" aria-label="返回首页">',
      SIDEBAR_HOME_ICON,
      '</a>',
      '<button type="button" class="custom-sidebar-icon" data-sidebar-ai title="设置（含 AI 配置）" aria-label="设置">',
      SIDEBAR_AI_ICON,
      '</button>',
      '</span>'
    ].join('');
    appName.querySelector('[data-sidebar-ai]').addEventListener('click', function () {
      if (window.Settings) {
        window.Settings.open('ai');
      } else if (window.AIAssistant) {
        window.AIAssistant.openConfig();
      }
    });
  }

  function createSidebarSearch(aside) {
    var wrapper = document.createElement('div');
    wrapper.className = 'docs-custom-search';
    wrapper.innerHTML = [
      '<div class="custom-search-top-row">',
      '<a class="custom-sidebar-home-link" href="' + homeLink() + '">返回首页</a>',
      '<a class="custom-sidebar-home-link custom-sidebar-tool" href="lib/plot-playground.html" target="_blank" rel="noopener" title="绘图在线预览（Mermaid / PacketDiag）"><svg class="custom-tool-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2.2 13.8l3.4-.7L13.9 4.8a1.5 1.5 0 0 0 0-2.1l-.6-.6a1.5 1.5 0 0 0-2.1 0L2.9 10.4l-.7 3.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M10.2 3.2l2.6 2.6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>绘图预览</a>',
      '<a class="custom-sidebar-home-link custom-sidebar-tool" href="md2web_feedback.html" target="_blank" rel="noopener" title="反馈问题（登录后可提交）">反馈</a>',
      '<button type="button" class="custom-search-kbd-hint" title="打开全局搜索">Ctrl+K</button>',
      '</div>',
      '<div class="custom-search-input-row">',
      '<span class="custom-search-input-icon">🔍</span>',
      '<button type="button" class="custom-search-filter-toggle" data-role="filter-toggle" title="搜索范围与模式" aria-label="搜索范围与模式" aria-expanded="false">⚙</button>',
      '<input type="search" class="custom-search-sidebar-input" placeholder="搜索文档（/ 聚焦，Ctrl+K 全局）" aria-label="搜索文档">',
      '<button type="button" class="custom-search-input-btn" data-role="clear-search" aria-label="清空搜索">×</button>',
      '</div>',
      searchFiltersHtml(),
      '<button type="button" class="custom-search-refresh" title="重新扫描文档并更新搜索索引">⟳ 更新搜索索引</button>',
      '<div class="custom-search-refresh-status" role="status" aria-live="polite"></div>',
      '<div class="custom-search-drop"></div>',
      '<div class="custom-search-status">正在加载搜索索引...</div>',
      '<div class="custom-search-results"></div>'
    ].join('');
    aside.insertBefore(wrapper, aside.firstChild);

    state.sidebar = {
      root: wrapper,
      input: wrapper.querySelector('input'),
      statusEl: wrapper.querySelector('.custom-search-status'),
      resultsEl: wrapper.querySelector('.custom-search-results'),
      dropEl: wrapper.querySelector('.custom-search-drop'),
      refreshButton: wrapper.querySelector('.custom-search-refresh'),
      refreshStatus: wrapper.querySelector('.custom-search-refresh-status'),
      footerEl: null,
      max: config.maxSidebarResults,
      compact: true,
      showSnippet: true,
      autocompleteHidden: false,
      flat: [],
      activeIndex: 0
    };
    var view = state.sidebar;
    bindSearchFilters(view, wrapper);

    view.input.addEventListener('input', function () {
      setQuery(view.input.value);
    });
    view.input.addEventListener('compositionstart', function () {
      state.composing = true;
    });
    view.input.addEventListener('compositionend', function () {
      state.composing = false;
      setQuery(view.input.value);
    });
    view.input.addEventListener('focus', function () {
      renderView(view);
    });
    view.input.addEventListener('keydown', function (event) {
      handleViewKeydown(view, event);
    });
    wrapper.querySelector('[data-role="clear-search"]').addEventListener('click', function () {
      clearSearch(view);
    });
    view.refreshButton.addEventListener('click', function () {
      refreshSearchIndex(view);
    });
    wrapper.querySelector('.custom-search-kbd-hint').addEventListener('click', openDialog);
    wrapper.addEventListener('click', function (event) {
      handleViewClick(view, event);
    });
  }

  function setupSidebarScrollArea(aside) {
    if (aside.querySelector('.docs-sidebar-scroll')) {
      return;
    }

    var scrollArea = document.createElement('div');
    scrollArea.className = 'docs-sidebar-scroll';
    var children = Array.prototype.slice.call(aside.children).filter(function (child) {
      return !child.classList.contains('docs-custom-search') &&
        !child.classList.contains('custom-sidebar-resizer') &&
        !child.classList.contains('docs-sidebar-scroll');
    });

    if (!children.length) {
      return;
    }

    aside.insertBefore(scrollArea, state.sidebarResizer && state.sidebarResizer.parentNode === aside ? state.sidebarResizer : null);
    children.forEach(function (child) {
      scrollArea.appendChild(child);
    });
  }

  function createDialog() {
    var dialog = document.createElement('div');
    dialog.className = 'custom-search-dialog';
    dialog.setAttribute('aria-hidden', 'true');
    dialog.innerHTML = [
      '<div class="custom-search-backdrop" data-close-search></div>',
      '<section class="custom-search-panel" role="dialog" aria-modal="true" aria-label="全局搜索">',
      '<div class="custom-search-dialog-head">',
      '<span class="custom-search-input-icon">🔍</span>',
      '<input type="search" class="custom-search-dialog-input" placeholder="搜索寄存器、信号、章节或文件名" aria-label="全局搜索">',
      '<button type="button" class="custom-search-dialog-refresh" title="重新扫描文档并更新搜索索引">更新索引</button>',
      '<button type="button" class="custom-search-dialog-close" data-close-search aria-label="关闭搜索">Esc</button>',
      '</div>',
      searchFiltersHtml(),
      '<div class="custom-search-drop"></div>',
      '<div class="custom-search-status">正在加载搜索索引...</div>',
      '<div class="custom-search-results"></div>',
      '<div class="custom-search-footer"><span>↑↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span></div>',
      '</section>'
    ].join('');
    document.body.appendChild(dialog);

    state.dialog = {
      root: dialog,
      input: dialog.querySelector('input'),
      statusEl: dialog.querySelector('.custom-search-status'),
      resultsEl: dialog.querySelector('.custom-search-results'),
      dropEl: dialog.querySelector('.custom-search-drop'),
      footerEl: dialog.querySelector('.custom-search-footer'),
      refreshButton: dialog.querySelector('.custom-search-dialog-refresh'),
      max: config.maxDialogResults,
      compact: false,
      showSnippet: true,
      autocompleteHidden: false,
      flat: [],
      activeIndex: 0
    };
    var view = state.dialog;
    bindSearchFilters(view, dialog);

    view.input.addEventListener('input', function () {
      setQuery(view.input.value);
    });
    view.input.addEventListener('compositionstart', function () {
      state.composing = true;
    });
    view.input.addEventListener('compositionend', function () {
      state.composing = false;
      setQuery(view.input.value);
    });
    view.input.addEventListener('keydown', function (event) {
      handleViewKeydown(view, event);
    });
    view.refreshButton.addEventListener('click', function () {
      refreshSearchIndex(view);
    });
    dialog.addEventListener('click', function (event) {
      if (event.target.hasAttribute('data-close-search')) {
        closeDialog();
        return;
      }
      handleViewClick(view, event);
    });
  }

  function isEditable(target) {
    if (!target) {
      return false;
    }
    var tag = target.tagName;
    return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function bindGlobalShortcuts() {
    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openDialog();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        state.searchMode = 'file';
        openDialog();
        renderAll();
        return;
      }
      if (event.key === '/' && !isEditable(event.target)) {
        event.preventDefault();
        if (state.sidebar && state.sidebar.input) {
          state.sidebar.input.focus();
          state.sidebar.input.select();
        } else {
          openDialog();
        }
      }
      if (event.key === 'F3' && reading.active && !isEditable(event.target)) {
        event.preventDefault();
        readingNavigate(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === 'Escape' && state.dialog && state.dialog.root.classList.contains('is-open')) {
        event.preventDefault();
        closeDialog();
      } else if (event.key === 'Escape' && reading.active && !isEditable(event.target)) {
        event.preventDefault();
        clearReadingMode(true);
      }
    });
  }

  function loadIndex() {
    var offlineData = window.__DOCSIFY_OFFLINE_DATA__;
    if (window.location.protocol === 'file:' && offlineData && offlineData.searchIndex) {
      applySearchIndex(offlineData.searchIndex);
      return;
    }

    fetch(config.indexPath, { cache: 'no-cache' })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }
        return response.json();
      })
      .then(function (index) {
        applySearchIndex(index);
      })
      .catch(function () {
        // 服务器上 search-index.json 被屏蔽或缺失时，回退到内嵌索引
        if (offlineData && offlineData.searchIndex) {
          applySearchIndex(offlineData.searchIndex);
        } else {
          state.error = '搜索索引加载失败';
          renderAll();
        }
      });
  }

  function waitForSidebar(callback) {
    var attempts = 0;
    var timer = setInterval(function () {
      var aside = document.querySelector('aside.sidebar');
      attempts += 1;
      if (aside) {
        clearInterval(timer);
        callback(aside);
      } else if (attempts > 80) {
        clearInterval(timer);
      }
    }, 50);
  }

  function init() {
    document.addEventListener('click', handleFilePageTocClick);
    document.addEventListener('click', handleSearchResultClick);
    loadHistory();
    restoreTocPreference();
    window.addEventListener('hashchange', scheduleReadingModeBuild);
    window.addEventListener('scroll', scheduleActiveToc, true);
    window.addEventListener('resize', function () { applyTocWidth(); });
    window.addEventListener('hashchange', scheduleActiveToc);
    window.addEventListener('hashchange', function () {
      window.setTimeout(function () { installSidebarIcons(); }, 0);
    });
    if (window.MutationObserver) {
      var readingTarget = document.querySelector('.content') || document.body;
      state.readingObserver = new MutationObserver(scheduleReadingModeBuild);
      state.readingObserver.observe(readingTarget, { childList: true, subtree: true });
    }
    waitForSidebar(function (aside) {
      setupSidebarResize(aside);
      if (!aside.querySelector('.docs-custom-search')) {
        createSidebarSearch(aside);
      }
      setupSidebarScrollArea(aside);
      installSidebarIcons(aside);
      createDialog();
      bindGlobalShortcuts();
      observePageContent();
      loadIndex();
      renderAll();
    });
  }

  if (window.__CUSTOM_SEARCH_TEST__) {
    window.__CUSTOM_SEARCH_TEST_API__ = {
      parseQuery: parseQuery,
      buildSearchPage: buildSearchPage,
      flattenIndex: flattenIndex,
      search: search,
      state: state,
      normalizeText: normalizeText
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
