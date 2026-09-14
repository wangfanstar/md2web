"""将 Markdown 文件夹转成 Docsify 离线文档站。"""

import argparse
import hashlib
import html
import json
import re
import shutil
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).parent
DOCS_DIR = ROOT / "docs"
LIB_DIR = DOCS_DIR / "lib"

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico"}
RESERVED_GROUP_DIRS = {"lib"}
WINDOWS_RESERVED_NAMES = {
    "con", "prn", "aux", "nul",
    *(f"com{number}" for number in range(1, 10)),
    *(f"lpt{number}" for number in range(1, 10)),
}


class BuildError(Exception):
    """构建期间的致命错误，由 main 统一打印并退出。"""


@dataclass
class SourceSpec:
    raw_path: str
    base_dir: Path
    label: str = ""
    dir: str = ""
    explicit_dir: bool = False
    origin: str = "cli"


@dataclass
class Source:
    root: Path
    label: str
    dir: str
    spec: SourceSpec
    md_files: list = field(default_factory=list)
    asset_files: list = field(default_factory=list)


def parse_args(argv=None):
    """解析命令行参数：配置文件 + 可重复 --source-md + 兼容旧位置参数。"""
    parser = argparse.ArgumentParser(
        description="将 Markdown 文件夹转成离线可用的 Docsify 文档站。"
    )
    parser.add_argument(
        "source_md_dir_pos",
        nargs="?",
        type=Path,
        metavar="源md文件夹",
        help="源 Markdown 根目录，默认使用脚本同级的 md/",
    )
    parser.add_argument(
        "output_docs_dir_pos",
        nargs="?",
        type=Path,
        metavar="输出docs文件夹",
        help="输出 Docsify 站点目录，默认使用脚本同级的 docs/",
    )
    parser.add_argument(
        "--source-md",
        "--md-dir",
        dest="source_md_dirs",
        action="append",
        type=Path,
        default=[],
        metavar="源md文件夹",
        help="追加一个源 Markdown 目录，可重复；与 md_sources.json 叠加",
    )
    parser.add_argument(
        "--output-docs",
        "--docs-dir",
        dest="output_docs_dir_opt",
        type=Path,
        help="输出 Docsify 站点目录",
    )
    parser.add_argument(
        "--config",
        dest="config_path",
        type=Path,
        help="源文件夹配置文件，默认读取脚本同级的 md_sources.json",
    )
    parser.add_argument(
        "--no-config",
        action="store_true",
        dest="no_config",
        help="忽略 md_sources.json",
    )
    parser.add_argument(
        "--index-only",
        "--refresh-index-only",
        action="store_true",
        dest="index_only",
        help="仅同步文档并重新生成搜索索引与离线数据，跳过依赖下载和站点文件生成",
    )

    args = parser.parse_args(argv)
    if args.output_docs_dir_pos and args.output_docs_dir_opt:
        parser.error("输出目录请只使用位置参数或 --output-docs 其中一种")

    source_dirs = []
    if args.source_md_dir_pos:
        source_dirs.append(args.source_md_dir_pos)
    source_dirs.extend(args.source_md_dirs)
    return argparse.Namespace(
        source_md_dirs=source_dirs,
        output_docs_dir=args.output_docs_dir_opt or args.output_docs_dir_pos,
        config_path=args.config_path,
        no_config=args.no_config,
        index_only=args.index_only,
    )


def load_config_file(config_path: Path):
    """读取 md_sources.json，返回 (title, specs)。"""
    try:
        text = Path(config_path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise BuildError(f"配置文件读取失败: {config_path} ({error})") from error
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as error:
        raise BuildError(f"配置文件不是合法 JSON: {config_path} ({error})") from error
    if isinstance(raw, list):
        raw = {"sources": raw}
    if not isinstance(raw, dict):
        raise BuildError(f"配置文件根节点必须是对象或数组: {config_path}")
    entries = raw.get("sources")
    if not isinstance(entries, list):
        raise BuildError(f"配置文件缺少 sources 数组: {config_path}")
    base_dir = Path(config_path).resolve().parent
    specs = []
    for index, entry in enumerate(entries, 1):
        if isinstance(entry, str):
            specs.append(SourceSpec(raw_path=entry, base_dir=base_dir, origin="config"))
            continue
        if not isinstance(entry, dict):
            raise BuildError(f"sources[{index}] 必须是字符串或对象: {config_path}")
        path = entry.get("path")
        if not path or not isinstance(path, str):
            raise BuildError(f"sources[{index}] 缺少字符串字段 path: {config_path}")
        dir_value = entry.get("dir")
        specs.append(
            SourceSpec(
                raw_path=path,
                base_dir=base_dir,
                label=str(entry.get("label") or ""),
                dir=str(dir_value) if dir_value else "",
                explicit_dir=bool(dir_value),
                origin="config",
            )
        )
    return (raw.get("title") or None), specs


def load_source_specs(args):
    """合并配置文件与命令行源，返回 (title, specs)。"""
    specs = []
    title = "文档中心"
    config_path = None
    if not args.no_config:
        config_path = args.config_path
        if config_path is None:
            candidate = ROOT / "md_sources.json"
            config_path = candidate if candidate.exists() else None
    if config_path is not None:
        config_path = Path(config_path).expanduser()
        if not config_path.exists():
            raise BuildError(f"配置文件不存在: {config_path}")
        config_title, config_specs = load_config_file(config_path)
        if config_title:
            title = str(config_title)
        specs.extend(config_specs)
    for raw in args.source_md_dirs:
        specs.append(SourceSpec(raw_path=str(raw), base_dir=Path.cwd(), origin="cli"))
    if not specs:
        specs.append(SourceSpec(raw_path="md", base_dir=ROOT, origin="default"))
    return title, specs


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def sanitize_dir_name(name: str) -> str:
    cleaned = re.sub(r"[^\w.-]", "-", str(name), flags=re.UNICODE)
    cleaned = re.sub(r"-{2,}", "-", cleaned)
    return cleaned.strip("-. ")


def scan_source(source: Source) -> None:
    md_files = []
    asset_files = []
    for path in sorted(source.root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(source.root)
        if any(part.startswith(".") for part in rel.parts):
            continue
        rel_posix = rel.as_posix()
        if path.suffix.lower() == ".md":
            md_files.append(rel_posix)
        elif any(part.casefold() == "images" for part in rel.parts[:-1]) or path.suffix.lower() in IMAGE_EXTENSIONS:
            asset_files.append(rel_posix)
    source.md_files = md_files
    source.asset_files = asset_files


def resolve_sources(specs, docs_dir):
    """解析、去重、校验并扫描源，返回可用源列表。"""
    seen = set()
    sources = []
    for spec in specs:
        raw = Path(spec.raw_path).expanduser()
        root = (raw if raw.is_absolute() else spec.base_dir / raw).resolve()
        if root in seen:
            print(f"  [跳过] 重复源: {display_path(root)}")
            continue
        seen.add(root)
        if not root.is_dir():
            print(f"  [警告] 源目录不存在或不是文件夹，已跳过: {display_path(root)}")
            continue
        sources.append(Source(root=root, label=spec.label or root.name, dir="", spec=spec))

    for index, source in enumerate(sources):
        for other in sources[index + 1:]:
            if _is_relative_to(source.root, other.root):
                raise BuildError(
                    f"源目录不能互相嵌套: {display_path(source.root)} 位于 {display_path(other.root)} 内"
                )
            if _is_relative_to(other.root, source.root):
                raise BuildError(
                    f"源目录不能互相嵌套: {display_path(other.root)} 位于 {display_path(source.root)} 内"
                )

    docs_resolved = Path(docs_dir).resolve()
    for source in sources:
        if _is_relative_to(source.root, docs_resolved):
            raise BuildError(
                f"源目录不能位于输出目录内: {display_path(source.root)} 位于 {display_path(docs_resolved)} 内"
            )
        if _is_relative_to(docs_resolved, source.root):
            raise BuildError(
                f"输出目录不能位于源目录内: {display_path(docs_resolved)} 位于 {display_path(source.root)} 内"
            )

    for source in sources:
        scan_source(source)

    kept = []
    for source in sources:
        if not source.md_files:
            print(f"  [警告] 源中没有 .md 文件，已跳过: {display_path(source.root)}")
            continue
        kept.append(source)
    if not kept:
        raise BuildError("没有可用的源文档：请检查源目录是否存在并包含 .md 文件")
    return kept


def assign_group_dirs(sources) -> None:
    """为每个源分配站点内分组目录，处理冲突与保留名。"""
    used = set(RESERVED_GROUP_DIRS) | WINDOWS_RESERVED_NAMES
    for index, source in enumerate(sources, 1):
        if source.spec.explicit_dir:
            raw = source.spec.dir
            candidate = sanitize_dir_name(raw)
            if not candidate or candidate != raw.strip():
                raise BuildError(
                    f"分组目录名包含非法字符或为空: {raw}（源: {display_path(source.root)}），"
                    "请只使用中英文、数字、-_. 组成的名称"
                )
        else:
            candidate = sanitize_dir_name(source.root.name) or f"source-{index}"
        if candidate.casefold() in used:
            if source.spec.explicit_dir:
                raise BuildError(
                    f"分组目录名冲突或为保留名: {candidate}（源: {display_path(source.root)}），"
                    "请在配置中更换 dir"
                )
            base = candidate
            number = 2
            while f"{base}-{number}".casefold() in used:
                number += 1
            candidate = f"{base}-{number}"
            print(f"  [警告] 分组目录名 {base} 已占用，改用 {candidate}")
        used.add(candidate.casefold())
        source.dir = candidate


def sync_sources(sources, docs_dir) -> None:
    """镜像同步：先删分组目录再复制，保证产物与源一致；清理过期分组。"""
    docs_path = Path(docs_dir)
    docs_path.mkdir(parents=True, exist_ok=True)
    active = {source.dir for source in sources}
    for source in sources:
        dest_root = docs_path / source.dir
        try:
            if dest_root.exists():
                shutil.rmtree(dest_root)
            dest_root.mkdir(parents=True, exist_ok=True)
            for rel in source.md_files + source.asset_files:
                dest_path = dest_root / rel
                dest_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source.root / rel, dest_path)
        except OSError as error:
            raise BuildError(
                f"同步源失败: {display_path(source.root)} -> {display_path(dest_root)}/ ({error})"
            ) from error
        print(
            f"  [同步] {display_path(source.root)} -> {display_path(dest_root)}/ "
            f"({len(source.md_files)} 个文档)"
        )

    reserved = {name.casefold() for name in RESERVED_GROUP_DIRS}
    for entry in sorted(docs_path.iterdir()):
        if not entry.is_dir() or entry.name.startswith(".") or entry.name.casefold() in reserved:
            continue
        if entry.name not in active:
            shutil.rmtree(entry)
            print(f"  [清理] 移除过期分组 {display_path(entry)}/")


def _resolve_config_path(path: Path = None, default: Path = None) -> Path:
    return (Path(path).expanduser() if path else default).resolve()


def configure_paths(source_md_dir: Path = None, output_docs_dir: Path = None):
    """根据命令行参数更新输入、输出和离线资源目录。"""
    global MD_DIR, DOCS_DIR, LIB_DIR
    MD_DIR = _resolve_config_path(source_md_dir, ROOT / "md")
    DOCS_DIR = _resolve_config_path(output_docs_dir, ROOT / "docs")
    LIB_DIR = DOCS_DIR / "lib"


def display_path(path: Path) -> str:
    """优先显示相对仓库路径；仓库外目录显示绝对路径。"""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def preview_server_command(docs_dir):
    """返回可从局域网 IP 访问的本地预览命令。"""
    return f"cd {docs_dir} && python -m http.server 3000 --bind 0.0.0.0"


# ---- 离线资源（jsdelivr CDN）----
ASSETS = {
    # Docsify 核心
    "docsify.min.js": "https://cdn.jsdelivr.net/npm/docsify@4.13.1/lib/docsify.min.js",
    "docsify.min.css": "https://cdn.jsdelivr.net/npm/docsify@4.13.1/lib/themes/vue.css",
    # 插件
    "zoom-image.min.js": "https://cdn.jsdelivr.net/npm/docsify@4.13.1/lib/plugins/zoom-image.min.js",
    "front-matter.min.js": "https://cdn.jsdelivr.net/npm/docsify@4.13.1/lib/plugins/front-matter.min.js",
    # Prism 代码高亮
    "prism.min.js": "https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js",
    "prism.min.css": "https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism.min.css",
    "prism-autoloader.min.js": "https://cdn.jsdelivr.net/npm/prismjs@1.29.0/plugins/autoloader/prism-autoloader.min.js",
}

# Prism 语言组件（autoloader 运行时按需加载，需下载到本地实现离线）
PRISM_COMPONENTS_CDN = "https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/"
PRISM_CORE_LANGS = {"markup", "css", "clike", "javascript"}  # 已内置于 prism.min.js

# autoloader 内置依赖表（1.29.0）的缺漏补充：这些组件依赖其他组件但表里没有
PRISM_EXTRA_DEPS = {
    "cuda": ["cpp"],
}

# autoloader 依赖表/别名表提取失败时的兜底（常见语言）
FALLBACK_PRISM_DEPS = {
    "c": ["clike"], "cpp": ["c"], "csharp": ["clike"], "java": ["clike"],
    "javascript": ["clike"], "typescript": ["javascript"], "kotlin": ["clike"],
    "go": ["clike"], "rust": [], "swift": ["clike"], "php": ["markup-templating"],
    "ruby": ["clike"], "scala": ["java"], "sql": [], "yaml": [], "python": [],
    "bash": [], "markdown": ["markup"], "json": [],
}
FALLBACK_PRISM_ALIASES = {
    "py": "python", "sh": "bash", "shell": "bash", "zsh": "bash",
    "yml": "yaml", "html": "markup", "xml": "markup", "svg": "markup",
    "js": "javascript", "ts": "typescript", "cs": "csharp",
}

# Prism 没有对应组件的语言 → 用最接近的语法高亮（构建时改围栏语言，不影响源文件）
PRISM_LANG_FALLBACK = {
    "cuda": "cpp",
    "p4": "c",
    "asm": "nasm",
}

SEARCH_DEPTH = 4

CUSTOM_SEARCH_JS = r"""(function () {
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

  function routeToHash(slug) {
    if (!slug || slug === '/') {
      return '#/';
    }
    if (slug.charAt(0) === '#') {
      return slug;
    }
    return '#' + slug;
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
        group = { route: item.route, pageTitle: item.pageTitle, entries: [], bestScore: -Infinity };
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
    var tokens = tokenize(query);
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
        '<span class="custom-search-group-title">' + escapeHtml(group.pageTitle) + '</span>',
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
        var groups = capGroups(groupResults(state.results), view.max);
        statusText = '找到 ' + state.results.length + ' 条结果 · ' + groups.length + ' 个文档';
        contentHtml = groupsHtml(view, groups);
      } else {
        statusText = '没有找到结果';
        contentHtml = '<div class="custom-search-empty">换个更精确的寄存器、信号名或章节关键词试试。</div>';
      }
    }

    view.statusEl.textContent = statusText;
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
    toc.innerHTML = [
      '<div class="docs-page-toc-title">' + escapeHtml(tocConfig.title || '本文目录') + '</div>',
      '<div class="docs-page-toc-links">',
      headings.map(function (heading) {
        var level = parseInt(heading.tagName.slice(1), 10);
        var href = base + '?id=' + encodeURIComponent(heading.id);
        return [
          '<a class="docs-page-toc-link level-' + level + '" data-page-toc-id="' + escapeHtml(heading.id) + '" href="' + escapeHtml(href) + '">',
          escapeHtml(heading.textContent),
          '</a>'
        ].join('');
      }).join(''),
      '</div>'
    ].join('');
    toc.classList.add('has-items');
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
    var fenceRe = /^(`{3,}|~{3,})/;
    var seen = Object.create(null);
    var inFence = false;
    var fenceChar = '';
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
        var markerChar = fenceMatch[1].charAt(0);
        if (inFence && markerChar === fenceChar) {
          inFence = false;
          fenceChar = '';
        } else if (!inFence) {
          inFence = true;
          fenceChar = markerChar;
        }
        return;
      }
      if (inFence) {
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
      flushSection();
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
          url: routeToHash(slug),
          route: route,
          pageTitle: pageTitle,
          headingTitle: headingTitle,
          title: title,
          body: body,
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

  function search(query) {
    if (!state.loaded || !hasEnoughQuery(query)) {
      return [];
    }
    var tokens = tokenize(query);
    if (!tokens.length) {
      return [];
    }

    return state.items
      .filter(function (item) {
        return tokens.every(function (token) {
          return item.combinedText.indexOf(token) !== -1;
        });
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
    var trimmed = String(query || '').trim();
    if (trimmed) {
      terms.unshift(trimmed);
    }
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

  function applyReadingHighlight() {
    if (!(window.CSS && CSS.highlights)) {
      return;
    }
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
    var tokens = tokenize(query);
    if (!section || !query || !state.loaded || !tokens.length) {
      if (reading.active) {
        clearReadingMode();
      }
      return;
    }
    var routeHit = state.items.some(function (item) {
      return item.route === route && tokens.every(function (token) {
        return item.combinedText.indexOf(token) !== -1;
      });
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

  function createSidebarSearch(aside) {
    var wrapper = document.createElement('div');
    wrapper.className = 'docs-custom-search';
    wrapper.innerHTML = [
      '<div class="custom-search-top-row">',
      '<a class="custom-sidebar-home-link" href="../../index.html">返回首页</a>',
      '<button type="button" class="custom-search-kbd-hint" title="打开全局搜索">Ctrl+K</button>',
      '</div>',
      '<div class="custom-search-input-row">',
      '<span class="custom-search-input-icon">🔍</span>',
      '<input type="search" class="custom-search-sidebar-input" placeholder="搜索文档，Ctrl+K 全局搜索" aria-label="搜索文档">',
      '<button type="button" class="custom-search-input-btn" data-role="clear-search" aria-label="清空搜索">×</button>',
      '</div>',
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
      showSnippet: false,
      autocompleteHidden: false,
      flat: [],
      activeIndex: 0
    };
    var view = state.sidebar;

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
      if (event.key === '/' && !isEditable(event.target)) {
        event.preventDefault();
        openDialog();
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
    window.addEventListener('hashchange', scheduleReadingModeBuild);
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
      createDialog();
      bindGlobalShortcuts();
      observePageContent();
      loadIndex();
      renderAll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
"""

CUSTOM_SEARCH_CSS = r""":root {
  --docs-sidebar-width: 300px;
  --docs-toc-width: 240px;
  --docs-toc-gap: 24px;
}

.custom-sidebar-resizer {
  display: none;
}

.docs-page-toc {
  display: none;
}

@media (min-width: 769px) {
  .sidebar {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    width: var(--docs-sidebar-width);
  }

  .docs-sidebar-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  .content {
    left: var(--docs-sidebar-width);
  }

  body.close .content {
    left: 0;
  }

  .sidebar-toggle {
    width: calc(var(--docs-sidebar-width) - 16px);
  }

  body.close .sidebar {
    transform: translateX(calc(-1 * var(--docs-sidebar-width)));
  }

  .custom-sidebar-resizer {
    bottom: 0;
    cursor: col-resize;
    display: block;
    position: absolute;
    right: -5px;
    top: 0;
    width: 10px;
    z-index: 35;
  }

  .custom-sidebar-resizer::after {
    background: transparent;
    bottom: 0;
    content: "";
    left: 4px;
    position: absolute;
    top: 0;
    transition: background .15s ease;
    width: 2px;
  }

  .custom-sidebar-resizer:hover::after,
  .custom-sidebar-resizer:focus-visible::after,
  body.is-resizing-sidebar .custom-sidebar-resizer::after {
    background: var(--theme-color, #42b983);
  }

  body.is-resizing-sidebar {
    cursor: col-resize;
    user-select: none;
  }
}

@media (min-width: 1100px) {
  .content {
    right: calc(var(--docs-toc-width) + var(--docs-toc-gap) * 2);
  }

  .docs-page-toc.has-items {
    bottom: 24px;
    display: block;
    overflow: auto;
    position: fixed;
    right: var(--docs-toc-gap);
    top: 86px;
    width: var(--docs-toc-width);
    z-index: 20;
  }

  .docs-page-toc-title {
    color: #2c3e50;
    font-size: 13px;
    font-weight: 700;
    padding: 0 0 10px;
  }

  .docs-page-toc-links {
    border-left: 1px solid #e8edf2;
    display: grid;
    gap: 2px;
    padding-left: 10px;
  }

  .docs-page-toc-link {
    border-radius: 6px;
    color: #66717f;
    display: block;
    font-size: 13px;
    line-height: 1.35;
    overflow: hidden;
    padding: 5px 8px;
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .docs-page-toc-link:hover {
    background: rgba(66, 185, 131, .1);
    color: var(--theme-color, #42b983);
  }

  .docs-page-toc-link.level-3 {
    padding-left: 18px;
  }

  .docs-page-toc-link.level-4 {
    padding-left: 30px;
  }
}

/* ---------- 侧边栏搜索区 ---------- */

.docs-custom-search {
  background: #fff;
  border-bottom: 1px solid #e8edf2;
  flex: 0 0 auto;
  padding: 10px 12px 12px;
  position: relative;
  z-index: 30;
}

.custom-search-top-row {
  align-items: center;
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}

.custom-sidebar-home-link {
  border-radius: 6px;
  color: var(--theme-color, #42b983);
  font-size: 13px;
  font-weight: 600;
  padding: 5px 7px;
  text-decoration: none;
}

.custom-sidebar-home-link:hover {
  background: rgba(66, 185, 131, .1);
}

.custom-search-kbd-hint {
  background: transparent;
  border: 1px solid #dfe7ef;
  border-radius: 6px;
  color: #7f8c8d;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  margin-left: auto;
  padding: 3px 7px;
}

.custom-search-kbd-hint:hover {
  border-color: var(--theme-color, #42b983);
  color: var(--theme-color, #42b983);
}

.custom-search-input-row {
  align-items: center;
  background: #f7f9fb;
  border: 1px solid #dfe7ef;
  border-radius: 8px;
  display: flex;
  gap: 4px;
  padding: 0 6px 0 8px;
}

.custom-search-input-row:focus-within {
  border-color: var(--theme-color, #42b983);
  box-shadow: 0 0 0 3px rgba(66, 185, 131, .14);
}

.custom-search-input-icon {
  color: #9aa5b1;
  font-size: 12px;
}

.custom-search-sidebar-input,
.custom-search-dialog-input {
  background: transparent;
  border: 0;
  color: #2c3e50;
  font: inherit;
  outline: none;
  width: 100%;
}

.custom-search-sidebar-input {
  font-size: 12px;
  padding: 9px 0;
}

.custom-search-input-btn {
  background: transparent;
  border: 0;
  color: #9aa5b1;
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  line-height: 1;
  padding: 5px 4px;
}

.custom-search-input-btn:hover {
  color: #2c3e50;
}

.custom-search-refresh {
  background: rgba(66, 185, 131, .08);
  border: 1px solid rgba(66, 185, 131, .35);
  border-radius: 6px;
  color: var(--theme-color, #42b983);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  margin-top: 8px;
  padding: 6px 10px;
  width: 100%;
}

.custom-search-refresh:hover {
  background: rgba(66, 185, 131, .16);
}

.custom-search-refresh:disabled {
  cursor: wait;
  opacity: .65;
}

.custom-search-dialog-refresh {
  background: transparent;
  border: 1px solid #dfe7ef;
  border-radius: 6px;
  color: #2e8b57;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  padding: 4px 9px;
  white-space: nowrap;
}

.custom-search-dialog-refresh:hover {
  border-color: var(--theme-color, #42b983);
}

.custom-search-dialog-refresh:disabled {
  cursor: wait;
  opacity: .65;
}

.custom-search-refresh-status {
  color: #7f8c8d;
  display: none;
  font-size: 11px;
  line-height: 1.35;
  padding: 5px 2px 0;
}

.custom-search-refresh-status.is-loading,
.custom-search-refresh-status.is-success,
.custom-search-refresh-status.is-error {
  display: block;
}

.custom-search-refresh-status.is-success {
  color: #2e8b57;
}

.custom-search-refresh-status.is-error {
  color: #c0392b;
}

.custom-search-status {
  color: #7f8c8d;
  font-size: 12px;
  line-height: 1.4;
  padding: 7px 2px 6px;
}

/* ---------- 搜索历史 ---------- */

.custom-search-history {
  display: grid;
  gap: 2px;
}

.custom-search-history-item {
  align-items: center;
  border-radius: 7px;
  cursor: pointer;
  display: flex;
  gap: 8px;
  padding: 7px 8px;
}

.custom-search-history-item:hover,
.custom-search-history-item.is-active {
  background: rgba(66, 185, 131, .1);
}

.custom-search-history-icon {
  color: #9aa5b1;
  font-size: 12px;
}

.custom-search-history-query {
  color: #2c3e50;
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.custom-search-history-time {
  color: #9aa5b1;
  font-size: 11px;
  white-space: nowrap;
}

.custom-search-history-remove {
  background: transparent;
  border: 0;
  color: #9aa5b1;
  cursor: pointer;
  font: inherit;
  font-size: 15px;
  line-height: 1;
  padding: 2px 4px;
}

.custom-search-history-remove:hover {
  color: #c0392b;
}

.custom-search-history-actions {
  padding: 6px 8px 2px;
}

.custom-search-history-clear {
  background: transparent;
  border: 0;
  color: #7f8c8d;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  padding: 2px 0;
}

.custom-search-history-clear:hover {
  color: var(--theme-color, #42b983);
}

/* ---------- 输入补全下拉 ---------- */

.custom-search-drop {
  display: none;
  left: 12px;
  position: absolute;
  right: 12px;
  top: auto;
  z-index: 40;
}

.custom-search-drop.is-visible {
  display: block;
}

.custom-search-autocomplete {
  background: #fff;
  border: 1px solid #e2e8ee;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(25, 35, 45, .14);
  margin-top: 4px;
  overflow: hidden;
  padding: 4px;
}

.custom-search-autocomplete-item {
  align-items: center;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  gap: 8px;
  padding: 7px 8px;
}

.custom-search-autocomplete-item:hover,
.custom-search-autocomplete-item.is-active {
  background: rgba(66, 185, 131, .1);
}

.custom-search-autocomplete-query {
  color: #2c3e50;
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.custom-search-autocomplete-hint {
  color: #9aa5b1;
  font-size: 11px;
}

/* ---------- 分组结果 ---------- */

.custom-search-results {
  display: grid;
  gap: 4px;
}

.custom-search-group {
  display: grid;
  gap: 2px;
}

.custom-search-group-header {
  align-items: center;
  background: #f0f7f3;
  border-radius: 7px;
  cursor: pointer;
  display: flex;
  gap: 7px;
  padding: 7px 8px;
  user-select: none;
}

.custom-search-group-header:hover {
  background: #e6f3ec;
}

.custom-search-group-icon {
  font-size: 12px;
}

.custom-search-group-title {
  color: #2c3e50;
  flex: 1;
  font-size: 13px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.custom-search-group-count {
  color: #2e8b57;
  font-size: 11px;
  white-space: nowrap;
}

.custom-search-group-toggle {
  color: #9aa5b1;
  font-size: 10px;
}

.custom-search-group-entries {
  display: grid;
  gap: 2px;
  padding: 2px 0 4px 10px;
}

.custom-search-result {
  align-items: flex-start;
  border-left: 2px solid transparent;
  border-radius: 6px;
  color: inherit;
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  text-decoration: none;
}

.custom-search-result:hover,
.custom-search-result.is-active {
  background: rgba(66, 185, 131, .1);
  border-left-color: var(--theme-color, #42b983);
}

.custom-search-badge {
  border-radius: 5px;
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  margin-top: 2px;
  padding: 3px 4px;
  text-align: center;
  width: 12px;
}

.custom-search-badge.badge-h {
  background: #e8f6ef;
  color: #2e8b57;
}

.custom-search-badge.badge-t {
  background: #eef1f5;
  color: #7f8c8d;
}

.custom-search-result-title {
  color: #2c3e50;
  flex: 1;
  font-size: 13px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.custom-search-result-snippet {
  color: #505d6b;
  display: block;
  flex-basis: 100%;
  font-size: 12px;
  line-height: 1.5;
  margin-left: 22px;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.custom-search-result mark {
  background: rgba(255, 214, 10, .5);
  border-radius: 3px;
  color: inherit;
  padding: 0 2px;
}

.custom-search-empty {
  color: #505d6b;
  font-size: 13px;
  line-height: 1.45;
}

/* ---------- Ctrl+K 弹窗 ---------- */

.custom-search-dialog {
  display: none;
  inset: 0;
  position: fixed;
  z-index: 99999;
}

.custom-search-dialog.is-open {
  display: block;
}

.custom-search-backdrop {
  background: rgba(25, 35, 45, .42);
  inset: 0;
  position: absolute;
}

.custom-search-panel {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 18px 60px rgba(25, 35, 45, .24);
  left: 50%;
  max-height: min(720px, calc(100vh - 56px));
  max-width: 760px;
  overflow: hidden;
  position: absolute;
  top: 42px;
  transform: translateX(-50%);
  width: calc(100vw - 32px);
}

.custom-search-dialog-head {
  align-items: center;
  border-bottom: 1px solid #edf1f5;
  display: flex;
  gap: 10px;
  padding: 13px 16px;
}

.custom-search-dialog-input {
  font-size: 17px;
}

.custom-search-dialog-close {
  background: #f1f4f7;
  border: 0;
  border-radius: 6px;
  color: #7f8c8d;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  padding: 4px 9px;
}

.custom-search-dialog-close:hover {
  background: #e6eaef;
  color: #2c3e50;
}

.custom-search-dialog .custom-search-drop {
  left: 0;
  right: 0;
  top: auto;
}

.custom-search-dialog .custom-search-status {
  font-size: 12px;
  padding-left: 16px;
  padding-right: 16px;
}

.custom-search-dialog .custom-search-results {
  max-height: calc(100vh - 250px);
  overflow: auto;
  padding: 0 12px 12px;
}

.custom-search-dialog .custom-search-result {
  padding: 9px 12px;
}

.custom-search-dialog .custom-search-result-title {
  font-size: 14px;
  white-space: normal;
}

.custom-search-dialog .custom-search-result-snippet {
  font-size: 13px;
  white-space: normal;
}

.custom-search-footer {
  align-items: center;
  background: #fafbfc;
  border-top: 1px solid #eef1f4;
  color: #9aa5b1;
  display: flex;
  font-size: 11px;
  gap: 16px;
  padding: 8px 16px;
}

@media (max-width: 768px) {
  .docs-page-toc {
    display: none;
  }

  .docs-custom-search {
    padding: 10px;
  }

  .custom-search-panel {
    border-radius: 10px 10px 0 0;
    bottom: 0;
    left: 0;
    max-height: calc(100vh - 20px);
    top: auto;
    transform: none;
    width: 100vw;
  }

  .custom-search-dialog .custom-search-results {
    max-height: calc(100vh - 220px);
  }

  .custom-search-footer {
    display: none;
  }
}

/* ---------- 文档内命中阅读模式 ---------- */

.search-reading-toolbar {
  align-items: center;
  background: #f2fbf7;
  border: 1px solid #dcefe5;
  border-radius: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 16px;
  padding: 8px 12px;
  position: sticky;
  top: 0;
  z-index: 25;
}

.search-reading-info {
  color: #2e8b57;
  font-size: 13px;
  font-weight: 700;
}

.search-reading-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.search-reading-btn {
  background: #fff;
  border: 1px solid #d5e3da;
  border-radius: 6px;
  color: #2c3e50;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  padding: 3px 9px;
}

.search-reading-btn:hover {
  border-color: var(--theme-color, #42b983);
  color: #2e8b57;
}

.search-reading-fold {
  color: #2e8b57;
}

.search-section-heading {
  cursor: pointer;
}

.search-section-arrow {
  color: #2e8b57;
  display: inline-block;
  font-size: 11px;
  margin-right: 6px;
  vertical-align: middle;
}

.search-section-badge {
  background: #e8f6ef;
  border-radius: 9px;
  color: #2e8b57;
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  margin-left: 8px;
  padding: 1px 7px;
  vertical-align: middle;
}

::highlight(docsify-search-hl) {
  background: rgba(255, 214, 10, .55);
}

::highlight(docsify-search-current) {
  background: #ffb84d;
}

@media (max-width: 768px) {
  .search-reading-toolbar {
    top: 0;
  }
}
"""


OFFLINE_FILE_JS = r"""(function () {
  var data = window.__DOCSIFY_OFFLINE_DATA__;
  if (!data || !data.content) {
    return;
  }

  // file:// 下直接读内嵌内容；http(s) 下先走原生请求，失败（如服务器屏蔽 .md
  // 文件或部署缺文件）时回退到内嵌内容，保证站点拷贝到任意环境都能打开。
  var content = data.content || {};
  var NativeXHR = window.XMLHttpRequest;

  function localKey(url) {
    var parsed;
    var base;
    var path;
    try {
      parsed = new URL(String(url), window.location.href);
      if (parsed.origin !== new URL(window.location.href).origin) {
        return null;
      }
      base = decodeURIComponent(new URL('.', window.location.href).pathname);
      path = decodeURIComponent(parsed.pathname);
    } catch (error) {
      return null;
    }
    if (path.indexOf(base) !== 0) {
      return null;
    }
    return path.slice(base.length).replace(/^\/+/, '');
  }

  function OfflineXHR() {
    this._listeners = {};
    this._native = null;
    this._key = null;
    this._mode = 'native';
    this._headers = {};
    this._aborted = false;
    this.readyState = 0;
    this.status = 0;
    this.statusText = '';
    this.response = null;
    this.responseText = '';
    this.responseType = '';
  }

  OfflineXHR.prototype.addEventListener = function (type, listener) {
    if (this._mode === 'native') {
      this._native.addEventListener(type, listener);
      return;
    }
    if (!this._listeners[type]) {
      this._listeners[type] = [];
    }
    this._listeners[type].push(listener);
  };

  OfflineXHR.prototype.removeEventListener = function (type, listener) {
    if (this._mode === 'native') {
      this._native.removeEventListener(type, listener);
      return;
    }
    this._listeners[type] = (this._listeners[type] || []).filter(function (item) {
      return item !== listener;
    });
  };

  OfflineXHR.prototype._emit = function (type) {
    var event = { type: type, target: this };
    (this._listeners[type] || []).slice().forEach(function (listener) {
      listener.call(this, event);
    }, this);
    if (typeof this['on' + type] === 'function') {
      this['on' + type].call(this, event);
    }
  };

  OfflineXHR.prototype._finish = function (status, statusText, text) {
    this.status = status;
    this.statusText = statusText;
    this.response = text;
    this.responseText = text;
    this.readyState = 4;
    this._emit('readystatechange');
    this._emit('load');
    this._emit('loadend');
  };

  OfflineXHR.prototype.open = function (method, url) {
    this._key = localKey(url);
    this._mode = this._key === null
      ? 'native'
      : (window.location.protocol === 'file:' ? 'embedded' : 'fallback');
    if (this._mode !== 'embedded') {
      this._native = new NativeXHR();
      this._native.open(method, url);
      return;
    }
    this._method = method;
    this._url = url;
    this.readyState = 1;
  };

  OfflineXHR.prototype.setRequestHeader = function (name, value) {
    if (this._mode === 'fallback') {
      this._headers[name] = value;
    } else if (this._mode === 'native') {
      this._native.setRequestHeader(name, value);
    }
  };

  OfflineXHR.prototype.getResponseHeader = function (name) {
    return this._mode !== 'embedded' && this._native ? this._native.getResponseHeader(name) : null;
  };

  OfflineXHR.prototype.send = function () {
    var self = this;
    if (this._mode === 'native') {
      this._native.send();
      return;
    }
    if (this._mode === 'embedded') {
      setTimeout(function () {
        var found;
        if (self._aborted) {
          return;
        }
        found = self._key !== null && Object.prototype.hasOwnProperty.call(content, self._key);
        self._finish(found ? 200 : 404, found ? 'OK' : 'Not Found', found ? content[self._key] : '');
      }, 0);
      return;
    }

    Object.keys(self._headers).forEach(function (name) {
      self._native.setRequestHeader(name, self._headers[name]);
    });
    self._native.addEventListener('load', function () {
      if (self._aborted) {
        return;
      }
      var status = self._native.status;
      if (status < 400) {
        self._finish(status, self._native.statusText, self._native.responseText);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(content, self._key)) {
        self._finish(200, 'OK', content[self._key]);
        return;
      }
      self._finish(status, self._native.statusText, self._native.responseText);
    });
    self._native.addEventListener('error', function () {
      if (self._aborted) {
        return;
      }
      if (Object.prototype.hasOwnProperty.call(content, self._key)) {
        self._finish(200, 'OK', content[self._key]);
        return;
      }
      self._emit('error');
    });
    self._native.send();
  };

  OfflineXHR.prototype.abort = function () {
    this._aborted = true;
    if (this._mode !== 'embedded' && this._native) {
      this._native.abort();
    }
  };

  window.XMLHttpRequest = OfflineXHR;
}());
"""


def _download(url: str, dest: Path) -> bool:
    """下载到 .part 临时文件后原子替换，失败返回 False。"""
    tmp = dest.with_name(dest.name + ".part")
    try:
        with urllib.request.urlopen(url, timeout=30) as response, tmp.open("wb") as handle:
            shutil.copyfileobj(response, handle)
            expected = response.headers.get("Content-Length")
            if expected is not None and handle.tell() != int(expected):
                raise OSError(f"下载不完整: {handle.tell()}/{expected} 字节")
        tmp.replace(dest)
        return True
    except Exception as error:
        print(f"  [错误] 下载 {dest.name} 失败: {error} ({url})")
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        return False


def ensure_assets() -> None:
    """确保 docs/lib 下离线依赖齐全：存在即复用，缺失才下载。"""
    LIB_DIR.mkdir(parents=True, exist_ok=True)
    missing = []
    for filename, url in ASSETS.items():
        dest = LIB_DIR / filename
        if dest.exists() and dest.stat().st_size > 0:
            print(f"  [复用] {filename}")
            continue
        print(f"  [下载] {filename} <- {url}")
        if not _download(url, dest):
            missing.append(filename)
    if missing:
        raise BuildError(
            "以下离线依赖缺失且下载失败:\n    - "
            + "\n    - ".join(missing)
            + f"\n  请联网后重新运行，或将完整依赖复制到 {display_path(LIB_DIR)}/"
        )


def patch_docsify_file_router():
    """避免 Docsify 在 file:// 下用 location.replace 标准化 hash 路由。"""
    docsify_path = LIB_DIR / "docsify.min.js"
    if not docsify_path.exists():
        return

    source = docsify_path.read_text(encoding="utf-8", errors="ignore")
    original = (
        'function N(e){var n=location.href.indexOf("#");'
        'location.replace(location.href.slice(0,0<=n?n:0)+"#"+e)}'
    )
    replacement = (
        'function N(e){if("file:"===location.protocol){'
        'if(location.hash!=="#"+e){'
        'location.hash=e}return}'
        'var n=location.href.indexOf("#");'
        'location.replace(location.href.slice(0,0<=n?n:0)+"#"+e)}'
    )
    new_branch = 'if("file:"===location.protocol){if(location.hash!=="#"+e){location.hash=e}return}'
    if new_branch in source:
        print("  [跳过] docsify.min.js 已包含 file:// 路由兼容")
        return
    if '"file:"===location.protocol' in source:
        old_replacement = (
            'function N(e){if("file:"===location.protocol){'
            'if(location.hash!=="#"+e){'
            'try{history.replaceState(null,"","#"+e)}catch(n){location.hash=e}}return}'
            'var n=location.href.indexOf("#");'
            'location.replace(location.href.slice(0,0<=n?n:0)+"#"+e)}'
        )
        if old_replacement in source:
            docsify_path.write_text(source.replace(old_replacement, replacement, 1), encoding="utf-8")
            print("  [修补] docsify.min.js 已更新 file:// hash 路由兼容")
        else:
            print("  [警告] Docsify 已有未知的 file:// 路由补丁，未覆盖")
        return
    if original not in source:
        print("  [警告] 未找到 Docsify hash 路由函数，无法添加 file:// 兼容")
        return

    docsify_path.write_text(source.replace(original, replacement, 1), encoding="utf-8")
    print("  [修补] docsify.min.js 已添加 file:// hash 路由兼容")


def patch_docsify_css():
    """移除主题 CSS 中的外部字体 @import，避免断网时请求 Google Fonts。"""
    css_path = LIB_DIR / "docsify.min.css"
    if not css_path.exists():
        return
    css = css_path.read_text(encoding="utf-8", errors="ignore")
    patched = re.sub(r'@import\s+url\([^)]*fonts\.googleapis[^)]*\);?', "", css)
    patched = re.sub(
        r'@import\s+(?:"|\')https?://[^"\']+(?:"|\');?', "", patched
    )
    if patched != css:
        css_path.write_text(patched, encoding="utf-8")
        print("  [修补] docsify.min.css 已移除外部字体 @import")
    else:
        print("  [跳过] docsify.min.css 无外部 @import")


def extract_autoloader_maps():
    """从 prism-autoloader.min.js 提取语言依赖表和别名表（与其内置逻辑保持一致）。"""
    autoloader_path = LIB_DIR / "prism-autoloader.min.js"
    if not autoloader_path.exists():
        return dict(FALLBACK_PRISM_DEPS), dict(FALLBACK_PRISM_ALIASES)

    def to_json(obj_text):
        return re.sub(r'([{,])([A-Za-z0-9_-]+):', r'\1"\2":', obj_text)

    try:
        text = autoloader_path.read_text(encoding="utf-8", errors="ignore")
        deps_start = text.index('={javascript:"clike"') + 1
        alias_start = text.index(",a={html:", deps_start) + 3
        end = text.index("},r={},s=\"components/\"", alias_start)
        deps = json.loads(to_json(text[deps_start:alias_start - 3]))
        aliases = json.loads(to_json(text[alias_start:end + 1]))
        return deps, aliases
    except (ValueError, json.JSONDecodeError) as e:
        print(f"  [警告] 解析 autoloader 依赖表失败({e})，使用兜底映射")
        return dict(FALLBACK_PRISM_DEPS), dict(FALLBACK_PRISM_ALIASES)


def collect_fence_languages(sources) -> set:
    """扫描所有源的 Markdown，收集代码围栏中出现的语言名。"""
    langs = set()
    fence_re = re.compile(r"^[ \t]*(?:`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#.-]+)", re.M)
    for source in sources:
        for rel in source.md_files:
            text = (source.root / rel).read_text(encoding="utf-8", errors="ignore")
            for match in fence_re.finditer(text):
                langs.add(match.group(1).lower())
    return langs


def resolve_prism_languages(fence_langs, deps, aliases):
    """将围栏语言解析为组件名闭包（近似映射 + 别名归一化 + 依赖闭包）。"""
    def deps_of(name):
        raw = PRISM_EXTRA_DEPS.get(name, deps.get(name, []))
        return [raw] if isinstance(raw, str) else list(raw)

    resolved = set()
    pending = []
    for name in fence_langs:
        canonical = aliases.get(name, name)
        pending.append(PRISM_LANG_FALLBACK.get(canonical, canonical))
    while pending:
        name = pending.pop(0)
        if name in resolved or name in PRISM_CORE_LANGS:
            continue
        resolved.add(name)
        for dep in deps_of(name):
            if dep not in resolved:
                pending.append(dep)
    return resolved


def ensure_prism_components(sources) -> None:
    """按文档实际用到的语言准备 Prism 组件，缺失才下载，失败仅警告。"""
    fence_langs = collect_fence_languages(sources)
    if not fence_langs:
        print("  [跳过] 未发现代码块语言，无需语言组件")
        return

    deps, aliases = extract_autoloader_maps()
    components = resolve_prism_languages(fence_langs, deps, aliases)
    components_dir = LIB_DIR / "components"
    components_dir.mkdir(parents=True, exist_ok=True)

    for name in sorted(components):
        dest = components_dir / f"prism-{name}.min.js"
        if dest.exists() and dest.stat().st_size > 0:
            print(f"  [复用] prism-{name}.min.js")
            continue
        url = f"{PRISM_COMPONENTS_CDN}prism-{name}.min.js"
        print(f"  [下载] prism-{name}.min.js <- {url}")
        if not _download(url, dest):
            print(f"  [警告] prism-{name}.min.js 下载失败，该语言暂不高亮（联网后重跑可重试）")
    print("  Prism 语言组件处理完成。\n")


def generate_custom_search_assets():
    """生成自定义离线搜索资源。"""
    LIB_DIR.mkdir(parents=True, exist_ok=True)
    (LIB_DIR / "custom-search.js").write_text(CUSTOM_SEARCH_JS, encoding="utf-8")
    (LIB_DIR / "custom-search.css").write_text(CUSTOM_SEARCH_CSS, encoding="utf-8")
    print("  [生成] custom-search.js / custom-search.css")


def collect_search_paths(subfolders):
    """收集所有可搜索的 Docsify 路由路径。"""
    paths = ["/"]
    for sub in subfolders:
        for md_file in sorted(sub.glob("*.md")):
            paths.append(f"/{sub.name}/{md_file.name}")
    return paths


def compute_search_namespace(subfolders):
    """根据文档列表生成 namespace，重建时自动失效旧缓存。"""
    parts = []
    for sub in subfolders:
        for md_file in sorted(sub.glob("*.md")):
            rel = md_file.relative_to(MD_DIR).as_posix()
            parts.append(f"{rel}:{md_file.stat().st_size}")
    digest = hashlib.md5("\n".join(parts).encode("utf-8")).hexdigest()[:10]
    return f"docs-{digest}"


# Docsify 4.13.1 slugify 实际删除的标点集合（docsify.min.js 中的 En 正则），
# 中文标点（、：（）等）会被保留在 id 中，不能用“删除所有标点”近似。
DOCSIFY_SLUG_STRIP_RE = re.compile(
    "[\u2000-\u206F\u2E00-\u2E7F\\'\"!#$%&()*+,./:;<=>?@\\[\\]^`{|}~]"
)


def _slugify_heading(text: str, seen: dict) -> str:
    """精确复刻 Docsify 4.13.1 的 slugify，保证搜索锚点与页面标题 id 一致。

    seen 为单页重复计数器，同名标题依次追加 -1、-2 后缀（与 docsify 一致）。
    """
    text = re.sub(r"<!--.*?-->", "", text)
    text = re.sub(r"\{docsify-ignore(?:-all)?\}", "", text)
    text = text.strip()
    # Marked escapes literal quotes before Docsify receives heading text;
    # slugify then removes '&', ';' but keeps the entity name (e.g. quot).
    text = text.replace('"', "&quot;").replace("'", "&#39;")
    text = re.sub(r"[A-Z]+", lambda match: match.group(0).lower(), text)
    text = re.sub(r"<[^>]+>", "", text)
    text = DOCSIFY_SLUG_STRIP_RE.sub("", text)
    text = re.sub(r"\s", "-", text)
    text = re.sub(r"-+", "-", text)
    text = re.sub(r"^([0-9])", r"_\1", text)
    count = seen[text] + 1 if text in seen else 0
    seen[text] = count
    return f"{text}-{count}" if count else text


def build_page_index(route_path: str, content: str, depth: int, page_title: str = None) -> dict:
    """为单个页面构建 Docsify 搜索索引结构。"""
    index = {}
    heading_re = re.compile(r"^(#{1,6})\s+(.+)$")
    fence_re = re.compile(r"^(`{3,}|~{3,})")
    seen = {}
    in_fence = False
    fence_char = ""
    default_title = route_path.split("/")[-1].replace(".md", "") or "Home Page"
    page_title = page_title or ("文档中心" if route_path == "/" else default_title)
    current_title = default_title
    current_slug = route_path
    current_body = []
    saw_heading = False

    def make_entry(slug: str, title: str, body: str) -> dict:
        return {
            "slug": slug,
            "title": title,
            "body": body,
            "route": route_path,
            "pageTitle": page_title,
            "headingTitle": title,
        }

    def flush_section():
        nonlocal current_body
        body = "\n".join(current_body).strip()
        if current_slug not in index or body:
            index[current_slug] = make_entry(current_slug, current_title, body)
        current_body = []

    for line in content.splitlines():
        # 跳过围栏代码块，避免代码中的 # 注释行被当成标题
        fence_match = fence_re.match(line.lstrip())
        if fence_match:
            marker_char = fence_match.group(1)[0]
            if in_fence and marker_char == fence_char:
                in_fence = False
                fence_char = ""
            elif not in_fence:
                in_fence = True
                fence_char = marker_char
            continue
        if in_fence:
            continue

        match = heading_re.match(line)
        if match:
            heading_id = _slugify_heading(match.group(2).strip(), seen)
            if len(match.group(1)) > depth:
                # 超出索引深度的标题仅同步重复计数，正文保留原文以便搜索
                current_body.append(line)
                continue
            flush_section()
            saw_heading = True
            current_title = match.group(2).strip()
            current_slug = (
                f"{route_path}?id={heading_id}" if heading_id else route_path
            )
            continue
        current_body.append(line)

    flush_section()

    if not saw_heading and route_path not in index:
        title = "Home Page" if route_path == "/" else default_title
        index[route_path] = make_entry(route_path, title, content.strip())

    return index


def generate_search_index(subfolders, depth=SEARCH_DEPTH):
    """在构建时生成 search-index.json，避免浏览器 localStorage 配额限制。"""
    index = {}
    readme = DOCS_DIR / "README.md"
    if readme.exists():
        index["/"] = build_page_index(
            "/", readme.read_text(encoding="utf-8"), depth, "文档中心"
        )

    for sub in subfolders:
        for md_file in sorted(sub.glob("*.md")):
            route = f"/{sub.name}/{md_file.name}"
            content = md_file.read_text(encoding="utf-8")
            index[route] = build_page_index(route, content, depth, md_file.stem)

    index_path = DOCS_DIR / "search-index.json"
    index_path.write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    size_mb = index_path.stat().st_size / (1024 * 1024)
    print(f"  [生成] search-index.json ({len(index)} 页, {size_mb:.1f} MB)")


def generate_offline_data():
    """内嵌 Markdown 和搜索索引，使 file:// 直接打开时绕过 XHR/fetch 限制。"""
    content = {}
    for md_file in sorted(
        DOCS_DIR.rglob("*.md"),
        key=lambda path: path.relative_to(DOCS_DIR).as_posix(),
    ):
        relative = md_file.relative_to(DOCS_DIR).as_posix()
        content[relative] = md_file.read_text(encoding="utf-8")

    search_index = {}
    search_index_path = DOCS_DIR / "search-index.json"
    if search_index_path.exists():
        search_index = json.loads(search_index_path.read_text(encoding="utf-8"))

    payload = {"content": content, "searchIndex": search_index}
    data_path = LIB_DIR / "offline-data.js"
    data_path.write_text(
        "window.__DOCSIFY_OFFLINE_DATA__ = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    (LIB_DIR / "offline-file.js").write_text(OFFLINE_FILE_JS, encoding="utf-8")
    size_mb = data_path.stat().st_size / (1024 * 1024)
    print(f"  [生成] offline-data.js / offline-file.js ({size_mb:.1f} MB)")


def generate_sidebar(subfolders):
    """生成 _sidebar.md 侧边栏文件"""
    lines = ["- **文档列表**"]
    for sub in subfolders:
        md_files = sorted(sub.glob("*.md"))
        if not md_files:
            continue
        if len(md_files) == 1:
            # 单文件：直接链接
            mdf = md_files[0]
            lines.append(f"  - [{mdf.stem}](/{sub.name}/{mdf.name})")
        else:
            # 多文件：分组标题 + 平列所有文档
            lines.append(f"  - **{sub.name}**")
            for mdf in md_files:
                lines.append(f"    - [{mdf.stem}](/{sub.name}/{mdf.name})")

    sidebar_path = DOCS_DIR / "_sidebar.md"
    sidebar_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"  [生成] _sidebar.md ({len(lines) - 1} 项)")


def generate_readme(subfolders):
    """生成 README.md 作为首页索引"""
    lines = ["# 文档中心", "", "## 文档列表", ""]
    for sub in subfolders:
        md_files = sorted(sub.glob("*.md"))
        if not md_files:
            continue
        if len(md_files) == 1:
            mdf = md_files[0]
            lines.append(f"- [{mdf.stem}]({sub.name}/{mdf.name})")
        else:
            lines.append(f"- **{sub.name}**")
            for mdf in md_files:
                lines.append(f"  - [{mdf.stem}]({sub.name}/{mdf.name})")

    readme_path = DOCS_DIR / "README.md"
    readme_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"  [生成] README.md (首页索引)")


def generate_index_html(search_paths, namespace):
    """生成 index.html"""
    prism_lang_map_js = json.dumps(PRISM_LANG_FALLBACK, ensure_ascii=False)
    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>文档中心</title>
  <link rel="stylesheet" href="lib/prism.min.css">
  <link rel="stylesheet" href="lib/docsify.min.css">
  <link rel="stylesheet" href="lib/custom-search.css">
</head>
<body>
  <script src="lib/offline-data.js"></script>
  <script src="lib/offline-file.js"></script>
  <div id="app">加载中...</div>
  <script>
    window.$docsify = {{
      name: '文档中心',
      repo: '',
      loadSidebar: true,
      coverpage: false,
      subMaxLevel: 0,
      auto2top: true,
      noEmoji: true,
      plugins: [function (hook) {{
        // Prism 无对应组件的语言（cuda/p4/asm 等）改用近似语法高亮，源 md 不受影响
        var langMap = {prism_lang_map_js};
        hook.beforeEach(function (content) {{
          var inFence = false, fenceChar = '';
          return content.split('\\n').map(function (line) {{
            var m = line.match(/^\\s*(`{{3,}}|~{{3,}})(.*)$/);
            if (m) {{
              var marker = m[1].charAt(0);
              if (!inFence) {{
                inFence = true; fenceChar = marker;
                var lm = m[2].match(/^\\s*([A-Za-z0-9_+#.-]+)/);
                if (lm) {{
                  var target = langMap[lm[1].toLowerCase()];
                  if (target) {{
                    return line.replace(lm[1], target);
                  }}
                }}
              }} else if (marker === fenceChar) {{
                inFence = false; fenceChar = '';
              }}
            }}
            return line;
          }}).join('\\n');
        }});
      }}],
      customSearch: {{
        indexPath: 'search-index.json',
        maxSidebarResults: 8,
        maxDialogResults: 50,
        minQueryLength: 2,
      }},
      customToc: {{
        enabled: true,
        minLevel: 2,
        maxLevel: 4,
        title: '本文目录',
      }},
    }}
  </script>
  <script src="lib/prism.min.js"></script>
  <script src="lib/prism-autoloader.min.js"></script>
  <script>
    // 语言组件改从本地 lib/components/ 加载，运行时不请求 CDN
    if (window.Prism && Prism.plugins && Prism.plugins.autoloader) {{
      Prism.plugins.autoloader.languages_path = 'lib/components/';
    }}
  </script>
  <script src="lib/docsify.min.js?v=file-router-3"></script>
  <script src="lib/zoom-image.min.js"></script>
  <script src="lib/front-matter.min.js"></script>
  <script src="lib/custom-search.js"></script>
</body>
</html>
"""
    index_path = DOCS_DIR / "index.html"
    index_path.write_text(html, encoding="utf-8")
    print(f"  [生成] index.html (搜索路径 {len(search_paths)} 条)")


def main(argv=None):
    args = parse_args(argv)
    configure_paths(args.source_md_dir, args.output_docs_dir)

    print("=== Docsify 离线文档站 构建工具 ===\n")
    print(f"源 Markdown 目录: {MD_DIR}")
    print(f"输出文档站目录: {DOCS_DIR}\n")

    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    if not MD_DIR.exists():
        print(f"  错误: 源 Markdown 目录不存在: {MD_DIR}")
        print("  请检查 --source-md 路径是否正确，或先创建该目录并放入文档。")
        sys.exit(1)

    if args.index_only:
        print("=== 仅刷新搜索索引（跳过资源下载与站点文件生成） ===\n")
        print("1. 同步 Markdown 文件和图片...")
        subfolders = sync_md_files()
        print("2. 重新生成搜索索引与离线数据...")
        if subfolders:
            generate_search_index(subfolders)
        LIB_DIR.mkdir(parents=True, exist_ok=True)
        generate_offline_data()
        print("\n=== 搜索索引刷新完成 ===")
        return

    print("1. 下载离线资源...")
    download_assets()
    patch_docsify_file_router()
    patch_docsify_css()
    generate_custom_search_assets()

    print("2. 同步 Markdown 文件和图片...")
    subfolders = sync_md_files()

    print("3. 下载 Prism 语言组件（离线高亮）...")
    download_prism_components()

    print("4. 生成配置文件和首页...")
    search_paths = collect_search_paths(subfolders) if subfolders else ["/"]
    namespace = compute_search_namespace(subfolders) if subfolders else "docs-empty"
    if subfolders:
        generate_sidebar(subfolders)
        generate_readme(subfolders)
        generate_search_index(subfolders)
    generate_offline_data()
    generate_index_html(search_paths, namespace)

    print("\n=== 构建完成 ===")
    print(f"\n启动本地预览: {preview_server_command(DOCS_DIR)}")
    print("本机打开: http://localhost:3000")
    print("局域网访问: http://<这台机器的IP>:3000")


if __name__ == "__main__":
    main()
