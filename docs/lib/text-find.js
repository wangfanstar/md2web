(function (global) {
  'use strict';

  // 纯逻辑的查找/替换核心：离线可用、可单测（编辑器 UI 只做接线）。
  var WORD_CHAR = /[0-9A-Za-z_]/;

  function escapeRegExp(value) {
    return String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function compile(query, options) {
    var settings = options || {};
    var source = String(query == null ? '' : query);
    if (!source) {
      return { regex: null, error: 'empty_query' };
    }
    if (!settings.regex) {
      source = escapeRegExp(source);
    }
    try {
      return { regex: new RegExp(source, settings.caseSensitive ? 'g' : 'gi'), error: '' };
    } catch (error) {
      return { regex: null, error: 'invalid_regex' };
    }
  }

  function isWordChar(character) {
    return !!character && WORD_CHAR.test(character);
  }

  // 整词：前后不能是 ASCII 单词字符（CJK 不参与词边界，避免 \b 对中文失效）
  function isWholeWord(value, start, end) {
    return !isWordChar(value.charAt(start - 1)) && !isWordChar(value.charAt(end));
  }

  function findMatches(text, query, options) {
    var settings = options || {};
    var compiled = compile(query, settings);
    if (compiled.error) {
      return { matches: [], error: compiled.error };
    }
    var value = String(text == null ? '' : text);
    var regex = compiled.regex;
    var matches = [];
    var match;
    while ((match = regex.exec(value)) !== null) {
      var start = match.index;
      var end = start + match[0].length;
      if (end > start && (!settings.wholeWord || isWholeWord(value, start, end))) {
        matches.push({ start: start, end: end });
      }
      if (match[0].length === 0) {
        regex.lastIndex += 1;
      }
    }
    return { matches: matches, error: '' };
  }

  function expandReplacement(replacement, match) {
    return String(replacement == null ? '' : replacement).replace(/\$(\$|&|\d{1,2})/g, function (token, name) {
      if (name === '$') {
        return '$';
      }
      if (name === '&') {
        return match[0];
      }
      var index = Number(name);
      return index > 0 && index < match.length && match[index] !== undefined ? match[index] : token;
    });
  }

  function replaceAll(text, query, replacement, options) {
    var settings = options || {};
    var value = String(text == null ? '' : text);
    var compiled = compile(query, settings);
    if (compiled.error) {
      return { text: value, count: 0, error: compiled.error };
    }
    var regex = compiled.regex;
    var output = '';
    var cursor = 0;
    var count = 0;
    var match;
    while ((match = regex.exec(value)) !== null) {
      var start = match.index;
      var end = start + match[0].length;
      if (end > start && (!settings.wholeWord || isWholeWord(value, start, end))) {
        output += value.slice(cursor, start) + expandReplacement(replacement, match);
        cursor = end;
        count += 1;
      }
      if (match[0].length === 0) {
        regex.lastIndex += 1;
      }
    }
    if (!count) {
      return { text: value, count: 0, error: '' };
    }
    return { text: output + value.slice(cursor), count: count, error: '' };
  }

  global.TextFind = {
    escapeRegExp: escapeRegExp,
    findMatches: findMatches,
    replaceAll: replaceAll
  };
}(typeof window !== 'undefined' ? window : this));
