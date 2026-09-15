#!/usr/bin/env python3
"""
Convert a Markdown file into a standalone HTML page with sidebar TOC navigation.
Zero dependencies - Python standard library only.
"""
import argparse
import html
import re
import sys
from datetime import datetime
from pathlib import Path

def slugify(title):
    """Generate an HTML anchor ID from a heading title."""
    slug = title.lower()
    slug = re.sub(r'[^\w\s\-]', '', slug)
    slug = re.sub(r'\s+', '-', slug)
    return slug


def extract_first_h1(md_text):
    """Return the text of the first h1 heading, or None if the document has none."""
    in_fence = False
    for line in md_text.split('\n'):
        s = line.strip()
        if s.startswith('```') or s.startswith('~~~'):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = re.match(r'^#\s+(.+)$', line)
        if m:
            return m.group(1).strip()
    return None


# ------------------------------------------------------------
# Markdown -> HTML converter (standard library only)
# ------------------------------------------------------------
_INLINE_RE = re.compile(
    r'(</?[A-Za-z][^>\n]*>)'          # raw inline HTML passthrough
    r'|(!\[[^\]]*\]\([^)\s]+\))'      # image
    r'|(\[[^\]]+\]\([^)\s]+\))'       # link
    r'|(`[^`\n]+`)'                   # code span
    r'|(\*\*[^*\n]+\*\*)'             # bold
    r'|(\*[^*\n]+\*)'                 # italic (asterisk)
    r'|((?<!\w)_[^_\n]+_(?!\w))'      # italic (underscore, word-bounded)
)
_HEADING_RE = re.compile(r'^(#{1,6})\s+(.*)$')
_FENCE_RE = re.compile(r'^\s{0,3}(`{3,}|~{3,})\s*(.*)$')
_HR_RE = re.compile(r'^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$')
_LIST_RE = re.compile(r'^(\s*)([-*+]|\d+[.)])\s+(.*)$')
_TABLE_DELIM_RE = re.compile(
    r'^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$')


def _escape_html(text):
    return (text.replace('&', '&amp;')
                .replace('<', '&lt;')
                .replace('>', '&gt;')
                .replace('"', '&quot;'))


def _render_inline(text):
    out = []
    for tok in _INLINE_RE.split(text):
        if not tok:
            continue
        m = re.fullmatch(r'</?[A-Za-z][^>\n]*>', tok)
        if m:
            out.append(tok)
            continue
        m = re.fullmatch(r'!\[([^\]]*)\]\(([^)\s]+)\)', tok)
        if m:
            out.append(f'<img src="{_escape_html(m.group(2))}" '
                       f'alt="{_escape_html(m.group(1))}">')
            continue
        m = re.fullmatch(r'\[([^\]]+)\]\(([^)\s]+)\)', tok)
        if m:
            out.append(f'<a href="{_escape_html(m.group(2))}">'
                       f'{_render_inline(m.group(1))}</a>')
            continue
        m = re.fullmatch(r'`([^`\n]+)`', tok)
        if m:
            out.append('<code>' + _escape_html(m.group(1)) + '</code>')
            continue
        m = re.fullmatch(r'\*\*([^*\n]+)\*\*', tok)
        if m:
            out.append('<strong>' + _render_inline(m.group(1)) + '</strong>')
            continue
        m = re.fullmatch(r'\*([^*\n]+)\*', tok)
        if m:
            out.append('<em>' + _render_inline(m.group(1)) + '</em>')
            continue
        m = re.fullmatch(r'(?<!\w)_([^_\n]+)_(?!\w)', tok)
        if m:
            out.append('<em>' + _render_inline(m.group(1)) + '</em>')
            continue
        out.append(_escape_html(tok))
    return ''.join(out)


_HL_ALIASES = {
    'py': 'python', 'python3': 'python',
    'sh': 'bash', 'shell': 'bash', 'zsh': 'bash',
    'c++': 'cpp', 'cxx': 'cpp', 'cc': 'cpp',
    'js': 'javascript', 'ts': 'javascript',
    'yml': 'yaml',
    'cmd': 'bat', 'dosbatch': 'bat',
    'xml': 'html',
}

_HL_SPECS = {
    'python': {
        'comment': r'#[^\n]*',
        'strings': [
            r'(?:[rbfu]{0,2})"(?:[^"\\\n]|\\.)*"',
            r"(?:[rbfu]{0,2})'(?:[^'\\\n]|\\.)*'",
            r'(?:[rbfu]{0,2})"""(?:[^"\\]|\\[\s\S]|"(?!""))*"""',
            r"(?:[rbfu]{0,2})'''(?:[^'\\]|\\[\s\S]|'(?!''))*'''",
        ],
        'keywords': ['def', 'class', 'return', 'if', 'elif', 'else', 'for',
                     'while', 'in', 'not', 'and', 'or', 'import', 'from', 'as',
                     'try', 'except', 'finally', 'raise', 'with', 'lambda',
                     'yield', 'pass', 'break', 'continue', 'global', 'nonlocal',
                     'del', 'assert', 'is', 'None', 'True', 'False', 'async',
                     'await'],
        'builtins': ['print', 'len', 'range', 'str', 'int', 'float', 'list',
                     'dict', 'set', 'tuple', 'bool', 'type', 'open', 'input',
                     'sum', 'min', 'max', 'sorted', 'enumerate', 'zip', 'map',
                     'filter', 'any', 'all', 'isinstance', 'issubclass',
                     'super', 'self'],
        'decorator': r'@[\w.]+',
    },
    'bash': {
        'comment': r'#[^\n]*',
        'strings': [r'"(?:[^"\\\n]|\\.)*"', r"'(?:[^'\\\n]|\\.)*'"],
        'keywords': ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do',
                     'done', 'case', 'esac', 'in', 'function', 'local',
                     'export', 'return', 'exit'],
        'builtins': ['echo', 'cd', 'ls', 'grep', 'sed', 'awk', 'cat', 'mkdir',
                     'rm', 'cp', 'mv', 'chmod', 'chown', 'printf', 'source',
                     'set', 'unset', 'readonly', 'read', 'true', 'false',
                     'command', 'exec', 'which', 'find', 'xargs', 'curl',
                     'wget', 'tar', 'sudo', 'pip', 'python', 'python3', 'git'],
        'variable': r'\$[\w{}]+',
    },
    'yaml': {
        'comment': r'#[^\n]*',
        'strings': [r'"(?:[^"\\\n]|\\.)*"', r"'(?:[^'\\\n]|\\.)*'"],
        'keywords': ['true', 'false', 'null', 'yes', 'no'],
        'variable': r'^[\s\-]*[\w.-]+(?=\s*:)',
    },
    'json': {
        'strings': [r'"(?:[^"\\\n]|\\.)*"'],
        'keywords': ['true', 'false', 'null'],
    },
    'sql': {
        'comment': r'--[^\n]*',
        'strings': [r"'(?:[^'\\\n]|\\.)*'", r'"(?:[^"\\\n]|\\.)*"'],
        'keywords': ['SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES',
                     'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'DROP',
                     'ALTER', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON',
                     'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'AND', 'OR',
                     'NOT', 'NULL', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG',
                     'MIN', 'MAX', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES',
                     'INDEX', 'UNIQUE', 'DEFAULT', 'INT', 'VARCHAR', 'TEXT',
                     'IF', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END'],
        'funcs': False,
    },
    'c': {
        'comment': r'//[^\n]*',
        'strings': [r'"(?:[^"\\\n]|\\.)*"', r"'(?:[^'\\\n]|\\.)*'"],
        'keywords': ['int', 'char', 'float', 'double', 'void', 'return', 'if',
                     'else', 'for', 'while', 'do', 'switch', 'case', 'break',
                     'continue', 'struct', 'typedef', 'const', 'static',
                     'unsigned', 'long', 'short', 'sizeof', 'enum', 'union',
                     'extern', 'volatile', 'register', 'signed', 'goto',
                     'NULL'],
    },
    'cpp': {
        'comment': r'//[^\n]*',
        'strings': [r'"(?:[^"\\\n]|\\.)*"', r"'(?:[^'\\\n]|\\.)*'"],
        'keywords': ['int', 'char', 'float', 'double', 'void', 'return', 'if',
                     'else', 'for', 'while', 'do', 'switch', 'case', 'break',
                     'continue', 'struct', 'typedef', 'const', 'static',
                     'unsigned', 'long', 'short', 'sizeof', 'enum', 'union',
                     'extern', 'volatile', 'register', 'signed', 'class',
                     'public', 'private', 'protected', 'namespace', 'template',
                     'typename', 'new', 'delete', 'this', 'virtual', 'override',
                     'using', 'bool', 'true', 'false', 'auto', 'nullptr',
                     'try', 'catch', 'throw', 'constexpr'],
    },
    'javascript': {
        'comment': r'//[^\n]*',
        'strings': [r'"(?:[^"\\\n]|\\.)*"', r"'(?:[^'\\\n]|\\.)*'",
                    r'`(?:[^`\\\n]|\\.)*`'],
        'keywords': ['var', 'let', 'const', 'function', 'return', 'if', 'else',
                     'for', 'while', 'do', 'switch', 'case', 'break',
                     'continue', 'class', 'new', 'this', 'typeof',
                     'instanceof', 'import', 'export', 'from', 'async',
                     'await', 'try', 'catch', 'finally', 'throw', 'true',
                     'false', 'null', 'undefined', 'delete', 'in', 'of',
                     'extends', 'super', 'default'],
    },
    'bat': {
        'comment': r'(?i)::[^\n]*|(?i)rem\s[^\n]*',
        'strings': [r'"(?:[^"\\\n]|\\.)*"'],
        'keywords': ['echo', 'set', 'if', 'else', 'for', 'goto', 'call', 'exit',
                     'setlocal', 'endlocal', 'where', 'errorlevel', 'in', 'do',
                     'not', 'pause', 'findstr', 'start', 'shift', 'pushd',
                     'popd'],
        'variable': r'%[^%\n]*%',
    },
    'html': {
        'comment': r'<!--[\s\S]*?-->',
        'strings': [r'"[^"\n]*"', r"'[^'\n]*'"],
        'tag': r'</?[A-Za-z][^>\n]*>',
        'keywords': ['DOCTYPE', 'html', 'head', 'body', 'meta', 'title', 'link',
                     'script', 'style', 'div', 'span', 'p', 'a', 'img', 'ul',
                     'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
                     'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'pre',
                     'code', 'button', 'form', 'input', 'label', 'nav', 'main',
                     'aside', 'header', 'footer', 'section', 'article',
                     'strong', 'em', 'blockquote'],
    },
}


def _build_hl_regex(spec):
    parts = []
    if 'comment' in spec:
        parts.append(r'(?P<c>%s)' % spec['comment'])
    for idx, s in enumerate(spec.get('strings', [])):
        parts.append(r'(?P<s%d>%s)' % (idx, s))
    if spec.get('keywords'):
        parts.append(r'(?P<k>\b(?:%s)\b)'
                     % '|'.join(sorted(spec['keywords'], key=len, reverse=True)))
    if spec.get('builtins'):
        parts.append(r'(?P<b>\b(?:%s)\b)'
                     % '|'.join(sorted(spec['builtins'], key=len, reverse=True)))
    if spec.get('variable'):
        parts.append(r'(?P<v>%s)' % spec['variable'])
    if spec.get('decorator'):
        parts.append(r'(?P<d>%s)' % spec['decorator'])
    if spec.get('tag'):
        parts.append(r'(?P<t>%s)' % spec['tag'])
    parts.append(r'(?P<m>\b\d+(?:\.\d+)?\b)')
    if spec.get('funcs', True):
        parts.append(r'(?P<f>\b\w+(?=\())')
    return re.compile('|'.join(parts))


_HL_CLASSES = {'c': 'c1', 'k': 'k', 'b': 'nb', 'm': 'mi',
               'f': 'nf', 'd': 'nf', 'v': 'nv', 't': 'nc'}


def _highlight_line(line, cre):
    out = []
    pos = 0
    for m in cre.finditer(line):
        if m.start() > pos:
            out.append(_escape_html(line[pos:m.start()]))
        g = m.lastgroup
        if g and g[0] == 's':
            cls = 's1' if g[-1] in '02' else 's2'
        else:
            cls = _HL_CLASSES[g[0]]
        out.append(f'<span class="{cls}">{_escape_html(m.group())}</span>')
        pos = m.end()
    if pos < len(line):
        out.append(_escape_html(line[pos:]))
    return ''.join(out)


def highlight_code(code, lang):
    """Highlight code for the given language; unknown language -> escaped
    plain text. Always escapes input (XSS-safe)."""
    key = (lang or '').lower()
    spec = _HL_SPECS.get(_HL_ALIASES.get(key, key))
    if spec is None:
        return _escape_html(code)
    try:
        cre = _build_hl_regex(spec)
        return '\n'.join(_highlight_line(line, cre) for line in code.split('\n'))
    except Exception:
        return _escape_html(code)


def markdown_to_html(md_text):
    lines = md_text.split('\n')
    out = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        hm = _HEADING_RE.match(line)
        if hm:
            level = len(hm.group(1))
            title = re.sub(r'\s+#+\s*$', '', hm.group(2)).strip()
            out.append(f'<h{level}>{_render_inline(title)}</h{level}>')
            i += 1
            continue
        fm = _FENCE_RE.match(line)
        if fm and len(fm.group(1)) >= 3:
            fence_char = fm.group(1)[0]
            lang = fm.group(2).strip()
            i += 1
            buf = []
            close_re = re.compile(r'^\s{0,3}' + re.escape(fence_char) + r'{3,}\s*$')
            while i < n and not close_re.match(lines[i]):
                buf.append(lines[i])
                i += 1
            if i < n:
                i += 1
            code = '\n'.join(buf)
            lang_class = f' class="language-{lang}"' if lang else ''
            out.append(f'<div class="highlight"><pre><code{lang_class}>'
                       f'{highlight_code(code, lang)}</code></pre></div>')
            continue
        if _HR_RE.match(line):
            out.append('<hr>')
            i += 1
            continue
        if line.strip().startswith('>'):
            buf = []
            while i < n and lines[i].strip().startswith('>'):
                buf.append(re.sub(r'^\s{0,3}>\s?', '', lines[i]))
                i += 1
            out.append('<blockquote>\n' + markdown_to_html('\n'.join(buf))
                       + '\n</blockquote>')
            continue
        lm = _LIST_RE.match(line)
        if lm:
            html, i = _parse_list(lines, i)
            out.append(html)
            continue
        if '|' in line and i + 1 < n and _TABLE_DELIM_RE.match(lines[i + 1]):
            html, i = _parse_table(lines, i)
            out.append(html)
            continue
        buf = [line]
        i += 1
        while i < n and lines[i].strip():
            if (_HEADING_RE.match(lines[i]) or _FENCE_RE.match(lines[i])
                    or _HR_RE.match(lines[i]) or _LIST_RE.match(lines[i])
                    or lines[i].strip().startswith('>')):
                break
            if ('|' in lines[i] and i + 1 < n
                    and _TABLE_DELIM_RE.match(lines[i + 1])):
                break
            buf.append(lines[i])
            i += 1
        out.append('<p>' + '<br>'.join(_render_inline(b) for b in buf) + '</p>')
    return '\n'.join(out)


def _parse_list(lines, i):
    """Parse one list starting at lines[i]; returns (html, next_index)."""
    first = _LIST_RE.match(lines[i])
    indent = len(first.group(1))
    ordered = first.group(2)[0].isdigit()
    tag = 'ol' if ordered else 'ul'
    n = len(lines)
    out = [f'<{tag}>\n']
    while i < n:
        m = _LIST_RE.match(lines[i])
        if (not m or len(m.group(1)) != indent
                or ordered != m.group(2)[0].isdigit()):
            break
        content = [m.group(3)]
        i += 1
        sub_html = ''
        while i < n:
            line = lines[i]
            if not line.strip():
                i += 1
                break
            lm = _LIST_RE.match(line)
            if lm and len(lm.group(1)) <= indent:
                break
            if lm and len(lm.group(1)) > indent:
                sub_html, i = _parse_list(lines, i)
                continue
            content.append(line[indent:] if len(line) > indent else line.lstrip())
            i += 1
        out.append(_render_list_item(content, sub_html))
    out.append(f'</{tag}>\n')
    return ''.join(out), i


def _render_list_item(content, sub_html):
    text = '\n'.join(content).strip('\n')
    if '\n' not in text:
        return f'<li>{_render_inline(text)}{sub_html}</li>\n'
    return f'<li>{markdown_to_html(text)}{sub_html}</li>\n'


def _parse_table(lines, i):
    header = _split_cells(lines[i])
    i += 2  # skip header + delimiter row
    rows = []
    n = len(lines)
    while i < n and lines[i].strip() and '|' in lines[i]:
        rows.append(_split_cells(lines[i]))
        i += 1
    thead = ('<thead>\n<tr>\n'
             + ''.join(f'<th>{_render_inline(c)}</th>\n' for c in header)
             + '</tr>\n</thead>\n')
    tbody = ('<tbody>\n'
             + ''.join('<tr>\n'
                       + ''.join(f'<td>{_render_inline(c)}</td>\n' for c in row)
                       + '</tr>\n' for row in rows)
             + '</tbody>\n')
    return f'<table>\n{thead}{tbody}</table>\n', i


def _split_cells(line):
    line = line.strip()
    if line.startswith('|'):
        line = line[1:]
    if line.endswith('|'):
        line = line[:-1]
    return [c.strip() for c in line.split('|')]


def build_heading_index(md_text):
    """Extract all headings from markdown, assign section numbers.
    Returns (flat_list, tree_for_toc) where each entry has:
      level, depth, title, slug, num, children[]
    """
    lines = md_text.split('\n')
    flat = []
    counters = [0, 0, 0]  # [h2, h3, h4]

    for line in lines:
        m = re.match(r'^(#{2,4})\s+(.+)$', line)
        if not m:
            continue
        level = len(m.group(1))
        title = m.group(2).strip()
        slug = slugify(title)
        depth = level - 2  # 0=h2, 1=h3, 2=h4

        counters[depth] += 1
        for d in range(depth + 1, 3):
            counters[d] = 0

        parts = [str(counters[d]) for d in range(depth + 1) if counters[d] > 0]
        num = '.'.join(parts)

        flat.append({'level': level, 'depth': depth, 'title': title,
                     'slug': slug, 'num': num, 'children': []})

    # Build tree for TOC
    toc_items = []
    stack = []
    for h in flat:
        while stack and stack[-1]['depth'] >= h['depth']:
            stack.pop()
        if stack:
            stack[-1]['children'].append(h)
        else:
            toc_items.append(h)
        stack.append(h)

    return flat, toc_items


def add_heading_ids(html_body, heading_index):
    """Inject id + section number into h2/h3/h4 tags."""
    # Build lookup: title_text -> num
    # We need to match HTML headings (after tag/entity processing) to markdown headings
    # Strategy: process headings in order; the nth h2/h3/h4 in HTML = nth in heading_index
    idx = [0]  # mutable counter

    def inject_id(m):
        tag = m.group(1)
        title_html = m.group(2)
        plain = re.sub(r'<[^>]+>', '', title_html).strip()
        plain = plain.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
        plain = plain.replace('&#39;', "'").replace('&quot;', '"')
        slug = slugify(plain)

        # Find matching heading in index (by closest slug match)
        i = idx[0]
        num = ''
        # Try exact slug match first, then fuzzy
        for j in range(i, min(i + 5, len(heading_index))):
            if heading_index[j]['slug'] == slug:
                num = heading_index[j]['num']
                idx[0] = j + 1
                break
        if not num and i < len(heading_index):
            num = heading_index[i]['num']
            idx[0] = i + 1

        if num:
            return f'<{tag} id="{slug}"><span class="sec-num">{num}</span> {title_html}</{tag}>'
        return f'<{tag} id="{slug}">{title_html}</{tag}>'

    return re.sub(r'<(h[234])>(.+?)</\1>', inject_id, html_body, flags=re.DOTALL)


def render_toc_html(toc_items):
    """Render sidebar TOC with section numbers."""
    def render(items):
        if not items:
            return ''
        html = '<ul>\n'
        for item in items:
            has_children = len(item['children']) > 0
            cls = ' class="has-children"' if has_children else ''
            html += (f'  <li{cls}><a href="#{item["slug"]}">'
                     f'<span class="toc-num">{item["num"]}</span> {item["title"]}</a>')
            if has_children:
                html += '\n' + render(item['children'])
            html += '</li>\n'
        html += '</ul>\n'
        return html
    return render(toc_items)


def convert(input_path, output_path, title=None):
    input_path = Path(input_path)
    md_text = input_path.read_text(encoding='utf-8')

    if title is None:
        title = extract_first_h1(md_text) or input_path.stem
    title_html = html.escape(title)
    source_name = html.escape(input_path.name)
    footer_date = datetime.now().strftime('%Y-%m')

    # Build heading index with section numbers (shared by TOC and content)
    heading_index, toc_items = build_heading_index(md_text)
    toc_html = render_toc_html(toc_items)

    # Convert markdown to HTML (stdlib converter)
    body_html = markdown_to_html(md_text)

    # Remove the TOC section from body (everything from "目录" h2 through the following hr)
    body_html = re.sub(
        r'<h2>目录</h2>.*?<hr ?/?>\s*',
        '',
        body_html,
        flags=re.DOTALL
    )

    # Inject id + section number into all h2/h3/h4 headings
    body_html = add_heading_ids(body_html, heading_index)

    html_template = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title_html}</title>
<style>
/* ============================================================
   Design Tokens
   ============================================================ */
:root {{
    --sidebar-width: 300px;
    --sidebar-bg: #111318;
    --sidebar-text: #8b949e;
    --sidebar-active: #e6edf3;
    --sidebar-hover: #1a1d25;
    --sidebar-accent: #6cb6ff;
    --sidebar-border: #1e2128;

    --bg: #ffffff;
    --bg-secondary: #f8f9fb;
    --text: #1f2328;
    --text-secondary: #656d76;
    --border: #d0d7de;
    --border-light: #e8ecf1;
    --code-bg: #f6f8fa;
    --table-stripe: #f6f8fa;
    --link: #0969da;
    --heading: #0d1117;
    --inline-code: #bf1a2f;
    --inline-code-bg: #fff0f1;

    --font-mono: "Cascadia Code", "Fira Code", "JetBrains Mono", "SF Mono", "Consolas", "Liberation Mono", monospace;
    --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", Helvetica, Arial, sans-serif;

    --radius-sm: 4px;
    --radius-md: 8px;
    --radius-lg: 12px;
    --shadow-xs: 0 1px 1px rgba(0,0,0,0.03);
    --shadow-sm: 0 1px 3px rgba(0,0,0,0.05);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.08);
}}

@media (prefers-color-scheme: dark) {{
    :root {{
        --bg: #0d1117;
        --bg-secondary: #111820;
        --text: #c9d1d9;
        --text-secondary: #8b949e;
        --border: #30363d;
        --border-light: #21262d;
        --code-bg: #161b22;
        --table-stripe: #0d1117;
        --link: #6cb6ff;
        --heading: #f0f6fc;
        --inline-code: #ff7b72;
        --inline-code-bg: #2d1114;
    }}
}}

/* ============================================================
   Reset & Base
   ============================================================ */
*, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
html {{ scroll-behavior: smooth; font-size: 15px; }}
body {{
    font-family: var(--font-sans);
    background: var(--bg);
    color: var(--text);
    line-height: 1.72;
    display: flex;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}}
a {{ color: var(--link); text-decoration: none; }}
a:hover {{ text-decoration: underline; }}

/* ============================================================
   Sidebar — dark panel, always
   ============================================================ */
.sidebar {{
    position: fixed; top: 0; left: 0;
    width: var(--sidebar-width); height: 100vh;
    background: var(--sidebar-bg);
    color: var(--sidebar-text);
    overflow-y: auto; overflow-x: hidden;
    z-index: 100;
    display: flex; flex-direction: column;
    scrollbar-width: thin;
    scrollbar-color: #2a2e38 transparent;
    border-right: 1px solid var(--sidebar-border);
}}
.sidebar::-webkit-scrollbar {{ width: 4px; }}
.sidebar::-webkit-scrollbar-track {{ background: transparent; }}
.sidebar::-webkit-scrollbar-thumb {{ background: #2a2e38; border-radius: 2px; }}

.sidebar-header {{
    padding: 22px 20px 16px;
    border-bottom: 1px solid var(--sidebar-border);
    flex-shrink: 0;
}}
.sidebar-header h2 {{
    font-size: 1rem; font-weight: 700; color: #e6edf3;
    letter-spacing: -0.01em; margin: 0 0 2px;
}}
.sidebar-header .subtitle {{
    font-size: 0.66rem; color: #484f58;
    text-transform: uppercase; letter-spacing: 0.12em; font-weight: 600;
}}

.sidebar-nav {{ padding: 6px 0; flex: 1; overflow-y: auto; }}
.sidebar-nav ul {{ list-style: none; padding: 0; margin: 0; }}
.sidebar-nav li {{ margin: 0; }}

.sidebar-nav a {{
    display: flex; align-items: baseline; gap: 5px;
    padding: 4px 20px;
    color: var(--sidebar-text);
    font-size: 0.8rem; text-decoration: none;
    border-left: 3px solid transparent;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}}
.sidebar-nav a:hover {{
    background: var(--sidebar-hover);
    color: var(--sidebar-active);
    text-decoration: none;
}}

/* Section number badge in sidebar */
.toc-num {{
    display: inline-block; min-width: 22px;
    font-size: 0.66rem; font-weight: 600;
    color: var(--sidebar-accent); opacity: 0.65;
    text-align: right; flex-shrink: 0;
    font-family: var(--font-mono); letter-spacing: -0.03em;
}}
.sidebar-nav a.active .toc-num {{ opacity: 1; }}

/* h2-level links */
.sidebar-nav > ul > li > a {{
    font-weight: 600; font-size: 0.83rem; padding: 6px 20px; color: #c4cdd9;
}}
.sidebar-nav > ul > li > a .toc-num {{ font-size: 0.7rem; min-width: 16px; color: #6cb6ff; }}
/* h3-level links */
.sidebar-nav ul ul a {{ padding-left: 38px; font-size: 0.78rem; }}
.sidebar-nav ul ul a .toc-num {{ font-size: 0.64rem; min-width: 28px; color: #8b949e; }}
/* h4-level links */
.sidebar-nav ul ul ul a {{ padding-left: 56px; font-size: 0.75rem; color: #6e7681; }}
.sidebar-nav ul ul ul a .toc-num {{ font-size: 0.62rem; min-width: 34px; color: #484f58; }}

/* Active state */
.sidebar-nav a.active {{
    background: linear-gradient(90deg, rgba(108,182,255,0.14) 0%, rgba(108,182,255,0.01) 100%);
    border-left-color: var(--sidebar-accent); color: #e6edf3;
}}

.sidebar-footer {{
    padding: 10px 20px; border-top: 1px solid var(--sidebar-border);
    font-size: 0.66rem; color: #484f58; flex-shrink: 0;
}}

/* ============================================================
   Main Content — generous but bounded width for readability
   ============================================================ */
.main {{
    margin-left: var(--sidebar-width);
    flex: 1; min-width: 0;
    padding: 48px 56px 120px;
    max-width: 1240px;
}}

/* ============================================================
   Typography
   ============================================================ */
h1, h2, h3, h4 {{ color: var(--heading); font-weight: 600; line-height: 1.3; position: relative; }}

h1 {{
    font-size: 2rem; font-weight: 700; margin: 0 0 8px;
    padding-bottom: 16px; border-bottom: 2px solid var(--border);
    letter-spacing: -0.03em;
}}
h2 {{
    font-size: 1.45rem; margin: 56px 0 18px;
    padding-bottom: 12px; border-bottom: 1px solid var(--border-light);
    letter-spacing: -0.02em;
}}
h3 {{
    font-size: 1.18rem; margin: 40px 0 14px;
    padding-left: 16px; border-left: 3px solid var(--sidebar-accent);
}}
h4 {{ font-size: 1.04rem; margin: 30px 0 12px; }}

/* Section number in content headings */
.sec-num {{
    display: inline-block; margin-right: 10px;
    font-family: var(--font-mono); font-weight: 600;
    color: var(--sidebar-accent); opacity: 0.72;
    letter-spacing: -0.03em; user-select: none;
}}
h2 .sec-num {{ font-size: 0.78em; opacity: 0.8; }}
h3 .sec-num {{ font-size: 0.82em; }}
h4 .sec-num {{ font-size: 0.86em; }}

p {{ margin: 0 0 16px; }}
strong {{ font-weight: 600; color: var(--heading); }}

/* ============================================================
   Admonition / Callout boxes (via blockquote)
   ============================================================ */
blockquote {{
    margin: 22px 0; padding: 14px 20px;
    border-left: 4px solid;
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
    font-size: 0.9rem; line-height: 1.65;
    position: relative;
}}
blockquote::before {{
    content: '';
    position: absolute; left: 0; top: 0; bottom: 0;
    width: 4px; border-radius: 4px 0 0 4px;
}}
/* Default tip style */
blockquote {{
    background: #f0f7ff;
    border-color: #58a6ff;
    color: #1f6fb0;
}}
@media (prefers-color-scheme: dark) {{
    blockquote {{ background: #0d1f33; color: #79c0ff; }}
}}
/* Warning style: first strong contains "注意"/"重要"/"警告" */
blockquote:has(strong) {{
    background: #fff8e1;
    border-color: #d29922;
    color: #7a5d00;
}}
@media (prefers-color-scheme: dark) {{
    blockquote:has(strong) {{ background: #2d2200; color: #d29922; }}
}}
blockquote p {{ margin-bottom: 6px; }}
blockquote p:last-child {{ margin-bottom: 0; }}

hr {{
    border: none; border-top: 1px solid var(--border-light);
    margin: 40px 0;
}}

/* ============================================================
   Code — inline & blocks
   ============================================================ */
code {{
    font-family: var(--font-mono);
    font-size: 0.87em;
    background: var(--code-bg);
    padding: 2px 7px; border-radius: var(--radius-sm);
}}
pre {{
    margin: 20px 0; border-radius: var(--radius-md);
    overflow-x: auto;
    border: 1px solid var(--border);
    background: var(--code-bg);
    box-shadow: var(--shadow-xs);
    position: relative;
}}
pre code {{
    display: block; padding: 18px 22px;
    border: none; background: transparent;
    font-size: 0.82rem; line-height: 1.6; tab-size: 4;
}}
h1 code, h2 code, h3 code, h4 code {{
    font-size: 0.9em; background: transparent; border: none; padding: 0; color: inherit;
}}

/* Inline code in prose */
p code, li code, td code, th code {{
    background: var(--inline-code-bg);
    color: var(--inline-code);
    border: 1px solid rgba(191,26,47,0.12);
    font-size: 0.85em; padding: 1px 6px;
}}
@media (prefers-color-scheme: dark) {{
    p code, li code, td code, th code {{
        border-color: rgba(255,123,114,0.18);
    }}
}}

/* ============================================================
   Syntax Highlighting (Pygments)
   ============================================================ */
.highlight {{ background: transparent !important; }}
.highlight pre {{ margin: 0; border: none; background: transparent !important; box-shadow: none; }}

@media (prefers-color-scheme: light) {{
    .highlight .k, .highlight .kd {{ color: #cf222e; font-weight: 600; }}
    .highlight .kt {{ color: #cf222e; }}
    .highlight .n  {{ color: #1f2328; }}
    .highlight .s, .highlight .s1, .highlight .s2, .highlight .se {{ color: #0a3069; }}
    .highlight .c, .highlight .c1, .highlight .cm, .highlight .cp {{ color: #6e7781; font-style: italic; }}
    .highlight .p  {{ color: #1f2328; }}
    .highlight .m, .highlight .mi, .highlight .mf {{ color: #0550ae; }}
    .highlight .o  {{ color: #cf222e; }}
    .highlight .nf, .highlight .na {{ color: #8250df; }}
    .highlight .nb, .highlight .bp {{ color: #0550ae; }}
    .highlight .nc {{ color: #8250df; }}
    .highlight .nv {{ color: #953800; }}
    .highlight .cpf {{ color: #0a3069; }}
    .highlight .w  {{ color: #afb8c1; }}
    .highlight .gh {{ color: #0550ae; font-weight: 600; }}
}}

@media (prefers-color-scheme: dark) {{
    .highlight .k, .highlight .kd {{ color: #ff7b72; }}
    .highlight .kt {{ color: #ff7b72; }}
    .highlight .n  {{ color: #c9d1d9; }}
    .highlight .s, .highlight .s1, .highlight .s2, .highlight .se {{ color: #a5d6ff; }}
    .highlight .c, .highlight .c1, .highlight .cm, .highlight .cp {{ color: #8b949e; font-style: italic; }}
    .highlight .p  {{ color: #c9d1d9; }}
    .highlight .m, .highlight .mi, .highlight .mf {{ color: #79c0ff; }}
    .highlight .o  {{ color: #ff7b72; }}
    .highlight .nf, .highlight .na {{ color: #d2a8ff; }}
    .highlight .nb, .highlight .bp {{ color: #79c0ff; }}
    .highlight .nc {{ color: #d2a8ff; }}
    .highlight .nv {{ color: #ffa657; }}
    .highlight .cpf {{ color: #a5d6ff; }}
    .highlight .w  {{ color: #484f58; }}
    .highlight .gh {{ color: #79c0ff; font-weight: 600; }}
}}

/* ============================================================
   Tables — clean & spacious
   ============================================================ */
table {{
    width: 100%; border-collapse: separate; border-spacing: 0;
    margin: 22px 0; font-size: 0.88rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md); overflow: hidden;
}}
thead {{ background: var(--bg-secondary); }}
th {{
    font-weight: 600; text-align: left;
    padding: 12px 16px;
    border-bottom: 2px solid var(--border);
    font-size: 0.78rem; color: var(--text-secondary);
    text-transform: uppercase; letter-spacing: 0.05em;
}}
td {{
    padding: 11px 16px;
    border-bottom: 1px solid var(--border-light);
    vertical-align: top;
}}
tr:last-child td {{ border-bottom: none; }}
tr:nth-child(even) {{ background: var(--table-stripe); }}
td code {{ font-size: 0.81rem; }}

/* ============================================================
   Mobile — collapsible sidebar
   ============================================================ */
.sidebar-toggle {{
    display: none; position: fixed; top: 12px; left: 12px; z-index: 200;
    background: var(--sidebar-bg); color: #c4cdd9;
    border: 1px solid var(--sidebar-border); border-radius: var(--radius-md);
    width: 40px; height: 40px; font-size: 1.1rem; cursor: pointer;
    align-items: center; justify-content: center;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}}
.sidebar-overlay {{ display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 99; }}

@media (max-width: 900px) {{
    .sidebar-toggle {{ display: flex; }}
    .sidebar {{
        transform: translateX(-100%);
        transition: transform 0.25s cubic-bezier(0.4,0,0.2,1);
        width: 290px;
    }}
    .sidebar.open {{ transform: translateX(0); box-shadow: 4px 0 28px rgba(0,0,0,0.35); }}
    .sidebar.open + .sidebar-overlay, .sidebar-overlay.active {{ display: block; }}
    .main {{ margin-left: 0; padding: 24px 18px 60px; max-width: none; }}
    h1 {{ font-size: 1.55rem; }}
    h2 {{ font-size: 1.22rem; }}
    h3 {{ font-size: 1.05rem; padding-left: 12px; }}
    table {{ font-size: 0.78rem; }}
    th, td {{ padding: 7px 10px; }}
    pre code {{ font-size: 0.76rem; padding: 14px 16px; }}
}}
@media (max-width: 500px) {{
    .main {{ padding: 18px 12px 40px; }}
    h1 {{ font-size: 1.35rem; }}
}}

/* ============================================================
   Print
   ============================================================ */
@media print {{
    .sidebar, .sidebar-toggle, .sidebar-overlay {{ display: none !important; }}
    .main {{ margin-left: 0; padding: 0; max-width: 100%; }}
    body {{ font-size: 10pt; color: #000; background: #fff; }}
    pre, code {{ background: #f6f8fa; border: 1px solid #d0d7de; }}
    a {{ color: #000; }}
    h2, h3 {{ page-break-after: avoid; }}
    table, pre {{ page-break-inside: avoid; }}
}}

/* ============================================================
   Animations
   ============================================================ */
@keyframes fadeSlideIn {{
    from {{ opacity: 0; transform: translateY(10px); }}
    to   {{ opacity: 1; transform: translateY(0); }}
}}
.main h2, .main h3, .main h4 {{ animation: fadeSlideIn 0.4s ease both; }}

/* Skip-link for keyboard users */
.skip-link {{
    position: absolute; top: -100px; left: 16px;
    background: var(--sidebar-accent); color: #fff;
    padding: 10px 18px; z-index: 999; border-radius: var(--radius-sm);
    font-size: 0.85rem; font-weight: 500;
}}
.skip-link:focus {{ top: 16px; outline: 2px solid var(--sidebar-accent); outline-offset: 2px; }}
</style>
</head>
<body>

<a href="#main-content" class="skip-link">Skip to content</a>

<!-- Sidebar Toggle (mobile) -->
<button class="sidebar-toggle" id="sidebarToggle" aria-label="Toggle navigation">
    &#9776;
</button>

<!-- Sidebar -->
<aside class="sidebar" id="sidebar">
    <div class="sidebar-header">
        <h2>{title_html}</h2>
        <div class="subtitle">{source_name}</div>
    </div>
    <nav class="sidebar-nav" id="sidebarNav">
{toc_html}
    </nav>
    <div class="sidebar-footer">
        Auto-generated from {source_name} &middot; {footer_date}
    </div>
</aside>
<div class="sidebar-overlay" id="sidebarOverlay"></div>

<!-- Main Content -->
<main class="main" id="main-content">
{body_html}
</main>

<script>
(function() {{
    // =========================================
    // Mobile sidebar toggle
    // =========================================
    var sidebar = document.getElementById('sidebar');
    var toggleBtn = document.getElementById('sidebarToggle');
    var overlay = document.getElementById('sidebarOverlay');

    function openSidebar() {{
        sidebar.classList.add('open');
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    }}

    function closeSidebar() {{
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
        document.body.style.overflow = '';
    }}

    toggleBtn.addEventListener('click', function() {{
        sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
    }});

    overlay.addEventListener('click', closeSidebar);

    // =========================================
    // Active link highlighting on scroll
    // =========================================
    var navLinks = [].slice.call(document.querySelectorAll('.sidebar-nav a'));
    var headings = [].slice.call(document.querySelectorAll('.main h2, .main h3, .main h4'));

    if (navLinks.length && headings.length) {{
        // Build a map: heading id -> nav link element
        var linkMap = {{}};
        navLinks.forEach(function(a) {{
            var href = a.getAttribute('href');
            if (href && href.startsWith('#')) {{
                linkMap[href.substring(1)] = a;
            }}
        }});

        // Collect heading positions
        function getHeadingPositions() {{
            return headings.map(function(h) {{
                return {{ id: h.id, top: h.getBoundingClientRect().top + window.pageYOffset - 80 }};
            }});
        }}

        var headingPositions = getHeadingPositions();

        function updateActive() {{
            var scrollY = window.pageYOffset;
            var activeId = null;

            for (var i = headingPositions.length - 1; i >= 0; i--) {{
                if (scrollY >= headingPositions[i].top) {{
                    activeId = headingPositions[i].id;
                    break;
                }}
            }}

            // Clear all
            navLinks.forEach(function(a) {{ a.classList.remove('active'); }});

            // Set active
            if (activeId && linkMap[activeId]) {{
                linkMap[activeId].classList.add('active');

                // Ensure parent is visible (scroll into view in sidebar)
                var el = linkMap[activeId];
                var sidebarNav = document.getElementById('sidebarNav');
                var elRect = el.getBoundingClientRect();
                var navRect = sidebarNav.getBoundingClientRect();
                if (elRect.bottom > navRect.bottom || elRect.top < navRect.top) {{
                    el.scrollIntoView({{ block: 'center', behavior: 'smooth' }});
                }}
            }}
        }}

        window.addEventListener('scroll', updateActive, {{ passive: true }});

        // Recalculate on resize
        var resizeTimer;
        window.addEventListener('resize', function() {{
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function() {{
                headingPositions = getHeadingPositions();
                updateActive();
            }}, 200);
        }}, {{ passive: true }});

        // Initial state
        updateActive();
    }}

    // =========================================
    // Smooth scroll for sidebar links
    // =========================================
    document.getElementById('sidebarNav').addEventListener('click', function(e) {{
        var target = e.target;
        if (target.tagName === 'A' && target.getAttribute('href').startsWith('#')) {{
            e.preventDefault();
            var id = target.getAttribute('href').substring(1);
            var el = document.getElementById(id);
            if (el) {{
                el.scrollIntoView({{ behavior: 'smooth', block: 'start' }});
                // Close sidebar on mobile after click
                if (window.innerWidth <= 900) {{
                    closeSidebar();
                }}
            }}
        }}
    }});

    // =========================================
    // Keyboard shortcut: Ctrl+\\ to toggle sidebar
    // =========================================
    document.addEventListener('keydown', function(e) {{
        if (e.ctrlKey && e.key === '\\\\') {{
            e.preventDefault();
            sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
        }}
    }});
}})();
</script>

</body>
</html>'''

    with open(output_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(html_template)
    print(f"[OK] Generated: {output_path}")
    print(f"     Size: {len(html_template):,} bytes")
    print(f"     TOC entries: {toc_html.count('<li')}")


def build_parser():
    parser = argparse.ArgumentParser(
        prog='md2html',
        description='Convert a Markdown file into a standalone HTML page '
                    'with sidebar TOC navigation.')
    parser.add_argument(
        'input', nargs='?', default=None,
        help='input .md file, or a directory containing README.md '
             '(default: all .md files in the current directory, '
             'subdirectories excluded)')
    parser.add_argument(
        '-o', '--output', default=None,
        help='output HTML file path (default: same name as the input '
             'with .html extension; README.html in directory mode)')
    parser.add_argument(
        '--title', default=None,
        help='HTML title (default: the first h1 heading in the document, '
             'or the input filename)')
    parser.add_argument(
        '-r', '--recursive', action='store_true',
        help='convert all .md files under the input directory recursively '
             '(requires a directory; cannot be used with -o/--title)')
    return parser


def convert_tree(directory, recursive):
    """Convert all .md files under directory (recursively if recursive),
    skipping hidden files and directories. Returns the process exit code."""
    directory = Path(directory).resolve()
    pattern = '**/*.md' if recursive else '*.md'
    md_files = sorted(
        p for p in directory.glob(pattern)
        if not any(part.startswith('.') for part in p.relative_to(directory).parts)
    )
    if not md_files:
        print(f"ERROR: no .md files found under {directory}", file=sys.stderr)
        return 1
    ok = fail = 0
    for p in md_files:
        try:
            convert(p, p.with_suffix('.html'))
            ok += 1
        except Exception as e:
            print(f"ERROR: {p}: {e}", file=sys.stderr)
            fail += 1
    mode = 'Recursive' if recursive else 'Batch'
    print(f"{mode} conversion done: {ok} ok, {fail} failed")
    return 0 if fail == 0 else 1


def resolve_paths(args, cwd=None):
    """Resolve (input_path, output_path, title) from parsed args.
    args.input is required. Returns None (after printing an error) if the
    input does not exist or the output path is an existing directory.
    """
    cwd = Path(cwd) if cwd is not None else Path.cwd()
    p = Path(args.input)
    input_path = p if p.is_absolute() else cwd / p
    dir_mode = input_path.is_dir()
    if dir_mode:
        input_path = input_path / 'README.md'
    input_path = input_path.resolve()

    if not input_path.exists():
        print(f"ERROR: {input_path} not found", file=sys.stderr)
        return None

    if args.output is not None:
        p = Path(args.output)
        output_path = p if p.is_absolute() else cwd / p
    elif dir_mode:
        output_path = input_path.parent / 'README.html'
    else:
        output_path = input_path.with_suffix('.html')
    output_path = output_path.resolve()

    if output_path.is_dir():
        print(f"ERROR: {output_path} is a directory", file=sys.stderr)
        return None

    return input_path, output_path, args.title


def _setup_console_encoding():
    """Windows consoles default to GBK; reconfigure stdout/stderr to UTF-8."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except (AttributeError, ValueError, OSError):
            pass


def main(argv=None):
    _setup_console_encoding()
    args = build_parser().parse_args(argv)
    if args.input is None:
        if args.output is not None or args.title is not None:
            print("ERROR: -o/--output and --title require an input file "
                  "or directory", file=sys.stderr)
            return 1
        return convert_tree(Path.cwd(), recursive=args.recursive)
    if args.recursive:
        if args.output is not None:
            print("ERROR: -o/--output cannot be used with -r/--recursive",
                  file=sys.stderr)
            return 1
        if args.title is not None:
            print("ERROR: --title cannot be used with -r/--recursive",
                  file=sys.stderr)
            return 1
        cwd = Path.cwd()
        p = Path(args.input)
        dir_path = p if p.is_absolute() else cwd / p
        dir_path = dir_path.resolve()
        if dir_path.is_file():
            print(f"ERROR: -r/--recursive requires a directory, got a file: {dir_path}",
                  file=sys.stderr)
            return 1
        if not dir_path.is_dir():
            print(f"ERROR: {dir_path} not found", file=sys.stderr)
            return 1
        return convert_tree(dir_path, recursive=True)
    resolved = resolve_paths(args)
    if resolved is None:
        return 1
    input_path, output_path, title = resolved
    output_path.parent.mkdir(parents=True, exist_ok=True)
    convert(input_path, output_path, title=title)
    return 0


if __name__ == '__main__':
    sys.exit(main())
