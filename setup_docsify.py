"""将 Markdown 文件夹转成 Docsify 离线文档站。"""

import argparse
import html
import hashlib
import json
import re
import shutil
import sys
import urllib.error
import urllib.request
from urllib.parse import quote
from pathlib import Path

ROOT = Path(__file__).parent
DOCS_DIR = ROOT / "docs"
LIB_DIR = DOCS_DIR / "lib"
MD_DIR = DOCS_DIR / "md"
# 站点页面与数据统一放在 docs/html/，docs 根目录只保留总览 index.html
HTML_DIR = DOCS_DIR / "html"
# html/ 下页面用 <base href="../"> 让所有相对路径（含 API）都相对站点根解析
HTML_BASE = "../"
# docsify 取 md/侧栏文件的基准：从 html/ 回到 docs/
DOCSIFY_BASE_PATH = "../"
HTML_PREFIX = "html/"


class BuildError(Exception):
    """构建期间的致命错误，由 main 统一打印并退出。"""


def parse_args(argv=None):
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(
        description="将 docs/md 下的 Markdown 转成离线可用的 Docsify 文档站。"
    )
    parser.add_argument("--title", default="文档中心", help="站点标题，默认「文档中心」")
    parser.add_argument("--offline", action="store_true", help="严格离线构建：依赖缺失时提示，不尝试网络下载")
    parser.add_argument(
        "--index-only",
        "--refresh-index-only",
        action="store_true",
        dest="index_only",
        help="仅重建搜索索引与离线数据，跳过依赖检查与站点文件生成",
    )
    return parser.parse_args(argv)


def display_path(path: Path) -> str:
    """优先显示相对仓库路径；仓库外目录显示绝对路径。"""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def scan_markdown(md_dir) -> list:
    """递归收集 docs/md 下的 .md 相对路径（posix），跳过隐藏路径。

    仅收集小写 .md 扩展名：docsify 按大小写敏感匹配扩展名，
    .MD 等变体虽可收集但页面会 404，因此打印警告并跳过。
    """
    root = Path(md_dir)
    if not root.is_dir():
        raise BuildError(
            f"源文档目录不存在: {display_path(root)}，请创建该目录并放入 .md 文档"
        )
    files = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if any(part.startswith(".") for part in rel.parts):
            continue
        if path.suffix == ".md":
            files.append(rel.as_posix())
        elif path.suffix.lower() == ".md":
            print(f"  [警告] 跳过非小写扩展名文档: {display_path(path)}（请重命名为 .md）")
    if not files:
        raise BuildError(
            f"源文档目录中没有 .md 文件: {display_path(root)}，请放入文档后重试"
        )
    return files


def read_markdown(path: Path) -> str:
    """读取 Markdown 文档，失败时抛出带文件路径的 BuildError。"""
    try:
        return Path(path).read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        raise BuildError(f"文档不是 UTF-8 编码: {display_path(path)} ({error})") from error
    except OSError as error:
        raise BuildError(f"读取文档失败: {display_path(path)} ({error})") from error


# ---- 离线资源（jsdelivr CDN）----
ASSETS = {
    # Docsify 核心
    "docsify.min.js": "https://cdn.jsdelivr.net/npm/docsify@4.13.1/lib/docsify.min.js",
    "docsify.min.css": "https://cdn.jsdelivr.net/npm/docsify@4.13.1/lib/themes/vue.css",
    # 插件
    "zoom-image.min.js": "https://cdn.jsdelivr.net/npm/docsify@4.13.1/lib/plugins/zoom-image.min.js",
    "front-matter.min.js": "https://cdn.jsdelivr.net/npm/docsify@4.13.1/lib/plugins/front-matter.min.js",
    # Prism 代码高亮（Prism 核心由 docsify 内置，只需样式与按需加载插件）
    "prism.min.css": "https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism.min.css",
    "prism-autoloader.min.js": "https://cdn.jsdelivr.net/npm/prismjs@1.29.0/plugins/autoloader/prism-autoloader.min.js",
    # Mermaid 图形渲染（离线）
    "mermaid.min.js": "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js",
    # Markdown 渲染（编辑器实时预览，离线）
    "marked.min.js": "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js",
    # 前端内容净化（登录编辑前的阅读页/预览页统一净化）
    "purify.min.js": "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js",
    # KaTeX 数学公式（离线，含 20 个 woff2 字体）
    "katex/katex.min.js": "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js",
    "katex/katex.min.css": "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css",
    "katex/auto-render.min.js": "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js",
    **{
        f"katex/fonts/{name}.woff2": f"https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/{name}.woff2"
        for name in (
            "KaTeX_AMS-Regular",
            "KaTeX_Caligraphic-Bold",
            "KaTeX_Caligraphic-Regular",
            "KaTeX_Fraktur-Bold",
            "KaTeX_Fraktur-Regular",
            "KaTeX_Main-Bold",
            "KaTeX_Main-BoldItalic",
            "KaTeX_Main-Italic",
            "KaTeX_Main-Regular",
            "KaTeX_Math-BoldItalic",
            "KaTeX_Math-Italic",
            "KaTeX_SansSerif-Bold",
            "KaTeX_SansSerif-Italic",
            "KaTeX_SansSerif-Regular",
            "KaTeX_Script-Regular",
            "KaTeX_Size1-Regular",
            "KaTeX_Size2-Regular",
            "KaTeX_Size3-Regular",
            "KaTeX_Size4-Regular",
            "KaTeX_Typewriter-Regular",
        )
    },
}

# Prism 语言组件（autoloader 运行时按需加载，需下载到本地实现离线）
PRISM_COMPONENTS_CDN = "https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/"
PRISM_CORE_LANGS = {"markup", "css", "clike", "javascript"}  # docsify 内置的 Prism 已包含

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

# 由前端插件渲染、不交给 Prism 的语言
IGNORED_FENCE_LANGS = {"mermaid", "packetdiag"}
# 纯文本围栏由 Prism 核心处理，不需要下载组件（prism-text/plain 并不存在，会 404）
PLAIN_FENCE_LANGS = {"text", "plain", "plaintext", "txt"}

SEARCH_DEPTH = 4

WEB_DIR = ROOT / "web"
CUSTOM_SEARCH_JS = (WEB_DIR / "custom-search.js").read_text(encoding="utf-8")
CUSTOM_SEARCH_CSS = (WEB_DIR / "custom-search.css").read_text(encoding="utf-8")

OFFLINE_FILE_JS = r"""(function () {
  var data = window.__DOCSIFY_OFFLINE_DATA__;
  if (!data || !data.content) {
    return;
  }

  // file:// 下直接读内嵌内容；http(s) 下先走原生请求，失败（如服务器屏蔽 .md
  // 文件或部署缺文件）时回退到内嵌内容，保证站点拷贝到任意环境都能打开。
  var content = data.content || {};
  var NativeXHR = window.XMLHttpRequest;

  // 站点根目录（lib/ 的上一级）：页面可能在 html/ 子目录，内嵌数据的键统一以站点根为基准
  function siteBase() {
    var script = document.currentScript;
    var tags;
    var index;
    if (script && script.src) {
      try {
        return decodeURIComponent(new URL('../', script.src).pathname);
      } catch (error) { /* 回退到扫描 script 标签 */ }
    }
    tags = document.getElementsByTagName('script');
    for (index = tags.length - 1; index >= 0; index -= 1) {
      if (/offline-file\.js/.test(tags[index].src || '')) {
        try {
          return decodeURIComponent(new URL('../', tags[index].src).pathname);
        } catch (error) { /* 继续 */ }
      }
    }
    return decodeURIComponent(new URL('.', window.location.href).pathname);
  }

  var SITE_BASE = siteBase();

  function localKey(url) {
    var parsed;
    var path;
    try {
      parsed = new URL(String(url), window.location.href);
      if (parsed.origin !== new URL(window.location.href).origin) {
        return null;
      }
      path = decodeURIComponent(parsed.pathname);
    } catch (error) {
      return null;
    }
    if (path.indexOf(SITE_BASE) !== 0) {
      return null;
    }
    return path.slice(SITE_BASE.length).replace(/^\/+/, '');
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


def ensure_assets(offline=False) -> None:
    """确保 docs/lib 下离线依赖齐全：存在即复用，缺失才下载。"""
    LIB_DIR.mkdir(parents=True, exist_ok=True)
    missing = []
    for filename, url in ASSETS.items():
        dest = LIB_DIR / filename
        if dest.exists() and dest.stat().st_size > 0:
            print(f"  [复用] {filename}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not offline:
            print(f"  [下载] {filename} <- {url}")
        if offline or not _download(url, dest):
            missing.append(filename)
    if missing:
        raise BuildError(
            ("严格离线模式下缺少以下依赖:\n    - " if offline else "以下离线依赖缺失且下载失败:\n    - ")
            + "\n    - ".join(missing)
            + f"\n  请联网后重新运行，或将完整依赖复制到 {display_path(LIB_DIR)}/"
        )


def patch_docsify_file_router():
    """避免 Docsify 在 file:// 下用 location.replace 标准化 hash 路由。"""
    docsify_path = LIB_DIR / "docsify.min.js"
    if not docsify_path.exists():
        return

    source = docsify_path.read_text(encoding="utf-8", errors="ignore")
    banner = (
        "/*! docsify v4.13.1 | MIT License | https://github.com/docsifyjs/docsify\n"
        " *  本项目基于 docsify 构建并做了本地修改（file:// 路由兼容补丁）；\n"
        " *  第三方组件与许可见仓库根目录 THIRD-PARTY-NOTICES.md。\n"
        " */\n"
    )
    if not source.startswith("/*!"):
        docsify_path.write_text(banner + source, encoding="utf-8")
        source = banner + source
        print("  [修补] docsify.min.js 已写入版权/许可横幅")
    original = (
        'function N(e){var n=location.href.indexOf("#");'
        'location.replace(location.href.slice(0,0<=n?n:0)+"#"+e)}'
    )
    # 页面带 <base href="../"> 时，相对 "#/" 会被解析成站点根：必须切片到 href 末尾
    replacement = (
        'function N(e){if("file:"===location.protocol){'
        'if(location.hash!=="#"+e){'
        'location.hash=e}return}'
        'var n=location.href.indexOf("#");'
        'location.replace(location.href.slice(0,0<=n?n:location.href.length)+"#"+e)}'
    )
    new_branch = 'if("file:"===location.protocol){if(location.hash!=="#"+e){location.hash=e}return}'
    base_slice_old = 'location.replace(location.href.slice(0,0<=n?n:0)+"#"+e)'
    base_slice_new = 'location.replace(location.href.slice(0,0<=n?n:location.href.length)+"#"+e)'
    if new_branch in source:
        if base_slice_old in source:
            docsify_path.write_text(source.replace(base_slice_old, base_slice_new, 1), encoding="utf-8")
            print("  [修补] docsify.min.js 已修正 <base> 下的 hash 规范化")
        else:
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


def collect_fence_languages(md_dir, md_files) -> set:
    """扫描 docs/md 下的 Markdown，收集代码围栏中出现的语言名。"""
    langs = set()
    fence_re = re.compile(r"^[ \t]*(?:`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#.-]+)", re.M)
    for rel in md_files:
        text = (Path(md_dir) / rel).read_text(encoding="utf-8", errors="ignore")
        for match in fence_re.finditer(text):
            lang = match.group(1).lower()
            if lang in IGNORED_FENCE_LANGS or lang in PLAIN_FENCE_LANGS:
                continue
            langs.add(lang)
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


def ensure_prism_components(md_dir, md_files, offline=False) -> None:
    """按文档实际用到的语言准备 Prism 组件，缺失才下载，失败仅警告。"""
    fence_langs = collect_fence_languages(md_dir, md_files)
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
        if offline:
            print(f"  [警告] 离线模式缺少 prism-{name}.min.js，该语言暂不高亮；可从完整依赖目录复制")
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
    for name in (
        "workspace.js",
        "workspace.css",
        "mermaid-init.js",
        "media-viewer.js",
        "packetdiag.js",
        "packetdiag-init.js",
        "page-export.js",
        "plot-playground.html",
        "md-editor.js",
        "math-init.js",
        "prism-init.js",
        "ai-retrieval.js",
        "ai-assistant.js",
        "ai-assistant.css",
        "sanitize.js",
        "auth.js",
        "auth.css",
        "settings.js",
        "settings.css",
        "folder-view.js",
    ):
        shutil.copyfile(WEB_DIR / name, LIB_DIR / name)
    print("  [生成] custom-search.* / workspace.* / mermaid-init.js / media-viewer.js / packetdiag* / page-export.js / plot-playground.html / md-editor.js / math-init.js / prism-init.js / ai-*.js|css / sanitize.js / auth.* / settings.*")


# Docsify 4.13.1 slugify 实际删除的标点集合（docsify.min.js 中的 En 正则），
# 中文标点（、：（）等）会被保留在 id 中，不能用“删除所有标点”近似。
DOCSIFY_SLUG_STRIP_RE = re.compile(
    "[\u2000-\u206F\u2E00-\u2E7F\\'\"!#$%&()*+,./:;<=>?@\\[\\]^`{|}~]"
)


def load_repositories():
    """读取 config/server.local.json 里的仓库映射（缺失时返回空列表）。

    返回 [{id, mount, url, group, read_only, allow_commit, sync_interval}]
    """
    candidates = [ROOT / "config" / "server.local.json", ROOT / "config" / "server.example.json"]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        items = raw.get("repositories") or []
        repos = []
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            repo_id = str(item.get("id") or "").strip()
            mount = str(item.get("mount") or "").strip().strip("/")
            if not repo_id or not mount:
                continue
            repos.append({
                "id": repo_id,
                "mount": mount,
                "url": str(item.get("url") or "").strip(),
                "group": str(item.get("group") or item.get("credential_group") or "默认").strip() or "默认",
                "read_only": bool(item.get("readOnly", False)),
                "allow_commit": bool(item.get("allowCommit", True)),
                "sync_interval": item.get("syncIntervalSeconds"),
            })
        folder_groups = raw.get("folderGroups") if isinstance(raw.get("folderGroups"), dict) else {}
        for repo in repos:
            override = folder_groups.get(repo["mount"])
            if override and str(override).strip():
                repo["group"] = str(override).strip()
        if repos or items == []:
            return repos
    return []


def mount_subpath(mount):
    """把 md/<子目录> 归一为 <子目录>（去掉开头的 md/）。"""
    value = str(mount or "").strip().strip("/")
    if value.startswith("md/"):
        value = value[3:]
    return value.strip("/")


def repo_for_route(route, repos):
    """按目录段最长前缀匹配文档所属仓库；返回 (repo, 相对仓库的路径) 或 (None, route)。"""
    rel = str(route or "").strip().lstrip("/")
    if rel.startswith("md/"):
        rel = rel[3:]
    best = None
    best_sub = ""
    for repo in repos or []:
        sub = mount_subpath(repo["mount"])
        if not sub:
            continue
        if rel == sub or rel.startswith(sub + "/"):
            if len(sub) > len(best_sub):
                best = repo
                best_sub = sub
    if best is None:
        return None, rel
    relative = rel[len(best_sub):].lstrip("/")
    return best, relative


def repo_page_name(repo_id):
    """每个仓库一个入口页：index_<仓库名>.html（保留中文等 CJK 字符，其余换成 -）。"""
    safe = re.sub("[^0-9A-Za-z._\\-㐀-䶿一-鿿]+", "-",
                  str(repo_id or "")).strip("-") or "repo"
    return "index_" + safe + ".html"


def load_all_repos():
    """仓库列表 = 配置的仓库 + 未配置文件夹的自动入口页（本地模式默认页）。"""
    repos = load_repositories()
    auto = auto_folder_repos(repos)
    if auto:
        print("  [提示] 未配置仓库的文件夹将生成入口页：%s" % "、".join(item["id"] for item in auto))
    return repos + auto


def first_level_folders():
    """docs/md 下的一级文件夹名（不含隐藏目录）。"""
    if not MD_DIR.is_dir():
        return []
    return sorted(path.name for path in MD_DIR.iterdir()
                  if path.is_dir() and not path.name.startswith("."))


def load_folder_groups():
    """读取 folderGroups（md/<文件夹> → 分组），供未配置 SVN 的文件夹也参与分组。"""
    candidates = [ROOT / "config" / "server.local.json", ROOT / "config" / "server.example.json"]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        groups = raw.get("folderGroups")
        if isinstance(groups, dict):
            return {str(key): str(value) for key, value in groups.items() if str(value).strip()}
        return {}
    return {}


def auto_folder_repos(repos):
    """未配置仓库的一级文件夹：自动生成入口页（本地模式默认页）。

    返回的条目与 load_repositories() 结构一致，额外带 auto=True。
    """
    groups = load_folder_groups()
    configured = set()
    for repo in repos:
        sub = mount_subpath(repo["mount"])
        if sub:
            configured.add(sub.split("/")[0])
    reserved = {"index.html", "index_all.html", "md2web_config.html"}
    auto = []
    for name in first_level_folders():
        if name in configured:
            continue
        if repo_page_name(name) in reserved:
            continue
        auto.append({
            "id": name,
            "mount": "md/" + name,
            "url": "",
            "group": groups.get("md/" + name, "默认"),
            "read_only": False,
            "allow_commit": True,
            "sync_interval": None,
            "auto": True,
        })
    return auto


def files_for_mount(md_files, mount):
    sub = mount_subpath(mount)
    if not sub:
        return []
    return [rel for rel in md_files if rel == sub or rel.startswith(sub + "/")]


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
    fence_length = 0
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
        # 代码属于可搜索正文，但其中的 # 注释不能成为标题。
        fence_match = fence_re.match(line.lstrip())
        if fence_match:
            marker_char = fence_match.group(1)[0]
            marker_length = len(fence_match.group(1))
            tail = line.lstrip()[marker_length:]
            if (in_fence and marker_char == fence_char
                    and marker_length >= fence_length and not tail.strip()):
                in_fence = False
                fence_char = ""
            elif not in_fence:
                in_fence = True
                fence_char = marker_char
                fence_length = marker_length
            else:
                current_body.append(line)
            continue
        if in_fence:
            current_body.append(line)
            continue

        match = heading_re.match(line)
        if match:
            heading_id = _slugify_heading(match.group(2).strip(), seen)
            if len(match.group(1)) > depth:
                # 超出索引深度的标题仅同步重复计数，正文保留原文以便搜索
                current_body.append(line)
                continue
            if current_body or saw_heading:
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


def generate_search_index(md_files, title="文档中心", depth=SEARCH_DEPTH, path=None, repos=None, include_readme=True, site=None):
    """在构建时生成 search-index.json，避免浏览器 localStorage 配额限制。"""
    index = {}
    readme = HTML_DIR / "README.md"
    if include_readme and readme.exists():
        index["/"] = build_page_index("/", read_markdown(readme), depth, title)

    for rel in md_files:
        route = f"/md/{rel}"
        index[route] = build_page_index(
            route, read_markdown(MD_DIR / rel), depth, Path(rel).stem
        )
        entry = index[route]
        if repos:
            repo, _ = repo_for_route(route, repos)
        else:
            repo = None
        entry['site'] = site or (HTML_PREFIX + repo_page_name(repo['id']) if repo else HTML_PREFIX + 'index_all.html')

    index_path = Path(path) if path else (HTML_DIR / "search-index.json")
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    size_mb = index_path.stat().st_size / (1024 * 1024)
    print(f"  [生成] {index_path.name} ({len(index)} 页, {size_mb:.1f} MB)")


def generate_offline_data(md_files, path=None, search_index_path=None, sidebar="_sidebar.md", include_readme=True):
    """内嵌 Markdown 和搜索索引，使 file:// 直接打开时绕过 XHR/fetch 限制。"""
    LIB_DIR.mkdir(parents=True, exist_ok=True)
    content = {}
    names = ([HTML_PREFIX + "README.md"] if include_readme else []) + [sidebar]
    for name in names:
        item = DOCS_DIR / name
        if item.exists():
            content[name] = read_markdown(item)
    for rel in md_files:
        content[f"md/{rel}"] = read_markdown(MD_DIR / rel)

    search_index = {}
    index_path = Path(search_index_path) if search_index_path else (HTML_DIR / "search-index.json")
    if index_path.exists():
        search_index = json.loads(index_path.read_text(encoding="utf-8"))

    payload = {"content": content, "searchIndex": search_index}
    data_path = Path(path) if path else (LIB_DIR / "offline-data.js")
    data_path.write_text(
        "window.__DOCSIFY_OFFLINE_DATA__ = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    (LIB_DIR / "offline-file.js").write_text(OFFLINE_FILE_JS, encoding="utf-8")
    size_mb = data_path.stat().st_size / (1024 * 1024)
    print(f"  [生成] offline-data.js / offline-file.js ({size_mb:.1f} MB)")


def build_doc_tree(rel_paths):
    """把相对路径列表构造成 {files, dirs} 嵌套树。"""
    root = {"files": [], "dirs": {}}
    for rel in rel_paths:
        parts = rel.split("/")
        node = root
        for part in parts[:-1]:
            node = node["dirs"].setdefault(part, {"files": [], "dirs": {}})
        node["files"].append(parts[-1])
    return root


def render_doc_tree(node, route_prefix, indent, lines, link, preserve_folders=False, dir_link=None):
    """递归渲染；站点保留目录身份，默认保留旧调用的折叠行为。

    dir_link(name) 返回一级目录的链接（如仓库入口页）；返回空则不生成链接。
    """
    for name in sorted(node["dirs"]):
        child = node["dirs"][name]
        child_files = child["files"]
        if not preserve_folders and len(child_files) == 1 and not child["dirs"]:
            filename = child_files[0]
            lines.append(
                f"{indent}- [{Path(filename).stem}]"
                f"({link(route_prefix + '/' + name + '/' + filename)})"
            )
            continue
        label = f"**{html.escape(name)}**"
        target = dir_link(name) if dir_link else ""
        if target:
            # 原始 HTML 锚点：Markdown 链接会被 docsify 重写成 hash 路由
            lines.append(
                f'{indent}- <a class="sidebar-group-link" href="{html.escape(target, quote=True)}">'
                f"{label}</a>"
            )
        else:
            lines.append(f"{indent}- {label}")
        render_doc_tree(child, route_prefix + "/" + name, indent + "  ", lines, link, preserve_folders)
    for filename in sorted(node["files"]):
        lines.append(
            f"{indent}- [{html.escape(Path(filename).stem)}]({link(route_prefix + '/' + filename)})"
        )


def generate_sidebar(md_files, path=None, heading="目录", link_first_level=False):
    """生成 _sidebar.md 侧边栏文件；link_first_level=True 时一级分组名链接到仓库入口页。"""
    # 侧栏第一行固定为「所有文档」，链接回全部文档合并视图
    lines = ['- <a class="sidebar-group-link" href="' + HTML_PREFIX
             + 'index_all.html">**所有文档**</a>']
    tree = build_doc_tree(md_files)
    dir_link = None
    if link_first_level:
        dir_link = lambda name: HTML_PREFIX + repo_page_name(name)
    render_doc_tree(tree, "/md", "  ", lines, lambda route: route, preserve_folders=True, dir_link=dir_link)

    sidebar_path = Path(path) if path else (HTML_DIR / "_sidebar.md")
    sidebar_path.parent.mkdir(parents=True, exist_ok=True)
    sidebar_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"  [生成] _sidebar.md ({len(lines) - 1} 项)")


def generate_readme(md_files, title="文档中心", path=None, repos=None):
    """生成 README.md 作为首页索引"""
    folders = {str(parent) for rel in md_files for parent in Path(rel).parents if str(parent) != "."}
    lines = [f"# {html.escape(title)}", "", '<div class="workspace-home">',
             '<p class="workspace-eyebrow">ENGINEERING KNOWLEDGE BASE</p>',
             '<p class="workspace-intro">从目录浏览，或直接搜索文件、命令与技术细节。</p>',
             f'<div class="workspace-stats"><span>{len(md_files)} 篇文档</span><span>{len(folders)} 个文件夹</span><span>离线可用</span></div>',
             '</div>', "", "## 文件夹", "", '<div class="workspace-folder-grid">']
    groups = {}
    for rel in md_files:
        group = rel.split("/")[0] if "/" in rel else ""
        groups.setdefault(group, []).append(rel)
    for group, files in sorted(groups.items()):
        first = sorted(files)[0]
        route = "#/md/" + quote(first, safe="/")
        label = html.escape(group or "根目录")
        preview = " · ".join(html.escape(Path(rel).stem) for rel in sorted(files)[:3])
        lines.extend([
            f'<a class="workspace-folder-card" href="{route}">',
            f'<span class="workspace-folder-count">{len(files)} 篇文档</span>',
            f'<h3>{label}</h3>',
            f'<span class="workspace-folder-preview">{preview}</span>', '</a>',
        ])
    lines.extend(['</div>', '', '## 快速查阅', '',
                  '- **Ctrl/Cmd + K** 或 **/**：全文搜索；**Ctrl/Cmd + P**：按文件名或路径打开。',
                  '- 在搜索框下选择文件夹或当前文档缩小范围，多词同时匹配；`"exact phrase"` 精确短语，`-排除词` 排除内容。',
                  '- 阅读搜索结果后用 **F3 / Shift+F3** 跳转命中；**Esc** 关闭搜索或退出命中阅读。',
                  '- 侧栏筛选文件名与路径，使用「定位当前」返回当前文件；拖动侧栏边缘调整宽度。',
                  '- 阅读区右上角「下载本页」可把当前文档导出为独立 HTML（样式内联、图片与图形内嵌）。',
                  '', '## 绘图工具', '',
                  '- [绘图语法示例](md/使用说明/绘图示例.md)：Mermaid 与 PacketDiag 的语法与示例。',
                  '- <a href="lib/plot-playground.html" target="_blank" rel="noopener">绘图在线预览</a>：编辑语法实时预览，可下载 SVG / PNG。',
                  '', '## 离线维护', '',
                  '直接双击 `index.html` 即可查阅，分发时复制整个 `docs/` 文件夹。源文档放在 `docs/md/`，可以按项目、模块建立多层目录。', '',
                  '新增、删除或编辑文档后运行 `python setup_docsify.py`，再刷新页面。页面「重读索引」只更新已知文档或当前内嵌快照，不扫描磁盘新增文件。依赖齐全时构建不联网。', '',
                  '<details class="workspace-all-docs">', '<summary>完整文档索引</summary>', '', '## 文档列表', ''])
    tree = build_doc_tree(md_files)
    render_doc_tree(tree, "md", "", lines, lambda route: route, preserve_folders=True)
    lines.extend(['', '</details>', ''])

    if repos:
        lines = [f"# {title}", "", "按分组浏览各文档文件夹（每个文件夹一个入口页）：", ""]
        groups = {}
        for repo in repos:
            groups.setdefault(repo["group"], []).append(repo)
        for group in sorted(groups):
            lines.append(f"## {group}")
            lines.append("")
            for repo in groups[group]:
                flags = []
                if repo.get("read_only"):
                    flags.append("只读")
                if not repo.get("allow_commit", True):
                    flags.append("禁止合入")
                suffix = ("（" + "、".join(flags) + "）") if flags else ""
                page = HTML_PREFIX + repo_page_name(repo["id"])
                lines.append(f'- <a href="{page}">{repo["id"]}</a> · `{repo["mount"]}`{suffix}')
            lines.append("")
        lines += ["## 其他", "", f"- [全部文档（合并视图）]({HTML_PREFIX}index_all.html)", ""]
        readme_path = Path(path) if path else (HTML_DIR / "README.md")
        readme_path.parent.mkdir(parents=True, exist_ok=True)
        readme_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print("  [生成] README.md（分组总览）")
        return

    readme_path = Path(path) if path else (HTML_DIR / "README.md")
    readme_path.parent.mkdir(parents=True, exist_ok=True)
    readme_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("  [生成] README.md (首页索引)")


def version_asset_urls(html_text):
    """给本地 lib/*.js|css 引用加内容版本号（?v=<sha1 前 10 位>），避免浏览器缓存旧脚本。"""
    def replace(match):
        prefix, path, suffix = match.group(1), match.group(2), match.group(3)
        candidate = DOCS_DIR / path
        if not candidate.is_file():
            return match.group(0)
        digest = hashlib.sha1(candidate.read_bytes()).hexdigest()[:10]
        return prefix + path + "?v=" + digest + suffix

    return re.sub(r'(src="|href=")(lib/[^"?]+\.(?:js|css))(")', replace, html_text)


def generate_index_html(title="文档中心", path=None, page_name="index.html", site_name=None,
                         sidebar="_sidebar.md", search_index="search-index.json",
                         offline_data="lib/offline-data.js", homepage=None,
                         read_only=False, allow_commit=True, repo=None, repos=None,
                         route_sidebar=False, home_link=None, in_html_dir=None):
    """生成 index.html"""
    prism_lang_map_js = json.dumps(PRISM_LANG_FALLBACK, ensure_ascii=False)
    title_html = html.escape(title)
    title_js = json.dumps(title, ensure_ascii=False).replace("<", "\\u003c")
    name_js = json.dumps(site_name or title, ensure_ascii=False).replace("<", "\\u003c")
    index_path = Path(path) if path else (DOCS_DIR / "index.html")
    if in_html_dir is None:
        in_html_dir = index_path.parent.resolve() == HTML_DIR.resolve()
    sidebar_path = "/" + str(sidebar).lstrip("/")
    search_index_path = (HTML_PREFIX if in_html_dir else "") + str(search_index).lstrip("/")
    offline_data_path = str(offline_data)
    base_href = HTML_BASE if in_html_dir else ""
    base_tag = f'  <base href="{base_href}">\n' if base_href else ""
    base_path_js = json.dumps(DOCSIFY_BASE_PATH if in_html_dir else "")
    sidebar_file = (HTML_PREFIX + sidebar_path.lstrip("/")) if in_html_dir else sidebar_path
    route_sidebar_js = "true" if route_sidebar else "false"
    folder_view_js = "true" if route_sidebar else "false"
    home_link_js = json.dumps(home_link or "index.html", ensure_ascii=False)
    repo_list_js = json.dumps([
        {"id": item["id"], "sub": mount_subpath(item["mount"]),
         "sidebar": f"_sidebar_{item['id']}.md"}
        for item in (repos or [])
    ], ensure_ascii=False).replace("<", "\\u003c")
    homepage_js = json.dumps(str(homepage), ensure_ascii=False) if homepage else "false"
    read_only_js = "true" if read_only else "false"
    allow_commit_js = "true" if allow_commit else "false"
    repo_js = json.dumps(repo or {}, ensure_ascii=False).replace("<", "\\u003c")
    html_text = f"""<!DOCTYPE html>
<!-- 基于 docsify 4.13.1（MIT，https://github.com/docsifyjs/docsify）构建，含本地修改；
     第三方组件与许可见 THIRD-PARTY-NOTICES.md -->
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
{base_tag}  <title>{title_html}</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231f6feb'/%3E%3Cpath d='M9 8.5h14v2.6H9zm0 6h14v2.6H9zm0 6h9v2.6H9z' fill='%23fff'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="lib/prism.min.css">
  <link rel="stylesheet" href="lib/katex/katex.min.css">
  <link rel="stylesheet" href="lib/docsify.min.css">
  <link rel="stylesheet" href="lib/custom-search.css">
  <link rel="stylesheet" href="lib/workspace.css">
  <link rel="stylesheet" href="lib/ai-assistant.css">
  <link rel="stylesheet" href="lib/auth.css">
  <link rel="stylesheet" href="lib/settings.css">
</head>
<body>
  <script src="{offline_data_path}"></script>
  <script src="lib/offline-file.js"></script>
  <div id="app">加载中...</div>
  <script>
    window.$docsify = {{
      name: {name_js},
      repo: '',
      loadSidebar: true,
      alias: {{
        '/_sidebar.md': '{sidebar_file}',
        '/.*/_sidebar.md': '{sidebar_file}',
      }},
      homepage: {homepage_js},
      coverpage: false,
      routeSidebar: {route_sidebar_js},
      folderView: {folder_view_js},
      homeLink: {home_link_js},
      basePath: {base_path_js},
      relativePath: {route_sidebar_js},
      repoList: {repo_list_js},
      repoReadOnly: {read_only_js},
      repoAllowCommit: {allow_commit_js},
      repoInfo: {repo_js},
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
        indexPath: '{search_index_path}',
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
  <script src="lib/docsify.min.js?v=file-router-3"></script>
  <script src="lib/prism-autoloader.min.js"></script>
  <script>
    // docsify 会覆盖 window.Prism，因此 autoloader 必须在 docsify 之后加载；
    // 语言组件改从本地 lib/components/ 加载，运行时不请求 CDN
    if (window.Prism && Prism.plugins && Prism.plugins.autoloader) {{
      Prism.plugins.autoloader.languages_path = 'lib/components/';
    }}
  </script>
  <script src="lib/prism-init.js"></script>
  <script src="lib/front-matter.min.js"></script>
  <script src="lib/marked.min.js"></script>
  <script src="lib/purify.min.js"></script>
  <script src="lib/sanitize.js"></script>
  <script src="lib/katex/katex.min.js"></script>
  <script src="lib/katex/auto-render.min.js"></script>
  <script src="lib/math-init.js"></script>
  <script src="lib/custom-search.js"></script>
  <script src="lib/workspace.js"></script>
  <script src="lib/mermaid.min.js"></script>
  <script src="lib/mermaid-init.js"></script>
  <script src="lib/packetdiag.js"></script>
  <script src="lib/packetdiag-init.js"></script>
  <script src="lib/media-viewer.js"></script>
  <script src="lib/page-export.js"></script>
  <script src="lib/md-editor.js"></script>
  <script src="lib/ai-retrieval.js"></script>
  <script src="lib/ai-assistant.js"></script>
  <script src="lib/auth.js"></script>
  <script src="lib/settings.js"></script>
  <script src="lib/folder-view.js"></script>
  <script src="lib/md2web-feedback.js"></script>
</body>
</html>
"""
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(version_asset_urls(html_text), encoding="utf-8")
    print(f"  [生成] {index_path.name}")


MASTER_STYLE = """
  :root { color-scheme: light; }
  body { background: #f7f9fb; color: #1f2a37; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 28px 20px 60px; }
  .wrap { margin: 0 auto; max-width: 1080px; }
  h1 { font-size: 24px; margin: 0 0 6px; }
  .sub { color: #57606a; font-size: 13px; margin: 0 0 18px; }
  .tools { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
  .tools input { border: 1px solid #d5dee8; border-radius: 8px; flex: 1 1 260px; font: inherit; padding: 8px 12px; }
  .tools a, .tools button { background: #fff; border: 1px solid #d5dee8; border-radius: 8px; color: #1f6feb; cursor: pointer; font: inherit; padding: 8px 14px; text-decoration: none; }
  .tools a:hover, .tools button:hover { border-color: #1f6feb; }
  h2 { font-size: 15px; margin: 22px 0 10px; color: #57606a; }
  .cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
  .card { background: #fff; border: 1px solid #e3e8ee; border-radius: 10px; color: inherit; display: block; padding: 14px 16px; text-decoration: none; }
  .card:hover { border-color: #1f6feb; box-shadow: 0 6px 18px rgba(15, 23, 42, .08); }
  .card strong { display: block; font-size: 15px; margin-bottom: 4px; }
  .card span { color: #57606a; display: block; font-size: 12.5px; overflow-wrap: anywhere; }
  .badge { background: #eef4fd; border-radius: 999px; color: #1f6feb; display: inline-block; font-size: 11px; margin-left: 6px; padding: 1px 8px; }
  .badge.readonly { background: #fff7ed; color: #b45309; }
  .results { margin: 6px 0 18px; }
  .results a { background: #fff; border: 1px solid #e3e8ee; border-radius: 8px; color: inherit; display: block; margin-bottom: 6px; padding: 8px 12px; text-decoration: none; }
  .results a:hover { border-color: #1f6feb; }
  .results small { color: #6b7a89; display: block; }
  .empty { color: #57606a; font-size: 13px; }
  .hint { color: #57606a; font-size: 12.5px; margin: -8px 0 16px; }
  .hint a { color: #1f6feb; }
"""

MASTER_SCRIPT = """
  var repos = window.__MD2WEB_REPOS__ || [];
  var index = null;
  var input = document.querySelector('[data-master-search]');
  var results = document.querySelector('[data-master-results]');
  function load() {
    if (index) { return Promise.resolve(index); }
    return fetch('html/search-index.json').then(function (r) { return r.json(); }).then(function (data) {
      index = data; return data;
    }).catch(function () { index = {}; return index; });
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }
  function search(query) {
    load().then(function (data) {
      var keyword = String(query || '').trim().toLowerCase();
      if (keyword.length < 2) { results.innerHTML = ''; return; }
      var hits = [];
      Object.keys(data).forEach(function (route) {
        var page = data[route] || {};
        var title = page.title || route;
        var headings = (page.headings || []).map(function (item) { return item.text || ''; }).join(' ');
        if ((title + ' ' + headings + ' ' + route).toLowerCase().indexOf(keyword) === -1) { return; }
        hits.push({ route: route, title: title, site: page.site || 'index_all.html', headings: headings.slice(0, 80) });
      });
      hits = hits.slice(0, 40);
      results.innerHTML = hits.length
        ? hits.map(function (hit) {
          var href = hit.site + '#/' + hit.route.replace(/^\\//, '');
          return '<a href="' + escapeHtml(href) + '"><strong>' + escapeHtml(hit.title) + '</strong>'
            + '<small>' + escapeHtml(hit.site) + ' · ' + escapeHtml(hit.route) + '</small>'
            + (hit.headings ? '<small>' + escapeHtml(hit.headings) + '</small>' : '') + '</a>';
        }).join('')
        : '<p class="empty">没有匹配的文档</p>';
    });
  }
  if (input) {
    input.addEventListener('input', function () { search(input.value); });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        var first = results.querySelector('a');
        if (first) { window.location.href = first.getAttribute('href'); }
      }
    });
  }
"""


LEGACY_ROOT_ARTIFACTS = (
    "index_all.html", "md2web_config.html", "md2web_feedback.html", "README.md",
    "_sidebar.md", "search-index.json",
)


def cleanup_legacy_root_artifacts():
    """旧布局在 docs 根目录留下的页面/数据文件：迁移到 docs/html/ 后删除。"""
    removed = []
    for name in LEGACY_ROOT_ARTIFACTS:
        path = DOCS_DIR / name
        if path.is_file():
            try:
                path.unlink()
                removed.append(name)
            except OSError:
                pass
    for pattern in ("index_*.html", "_sidebar_*.md", "search-index_*.json"):
        for path in sorted(DOCS_DIR.glob(pattern)):
            if path.name == "index.html":
                continue
            try:
                path.unlink()
                removed.append(path.name)
            except OSError:
                pass
    if removed:
        print(f"  [清理] 旧布局残留 {len(removed)} 个：{', '.join(removed[:6])}")


def cleanup_repo_artifacts(repos):
    """删除已不在配置里的仓库入口页/侧栏/索引/离线数据，避免遗留旧仓库页面。"""
    cleanup_legacy_root_artifacts()
    HTML_DIR.mkdir(parents=True, exist_ok=True)
    keep = {repo["id"] for repo in repos}
    removed = []
    patterns = [
        ("index_*.html", lambda name: name[len("index_"):-len(".html")]),
        ("_sidebar_*.md", lambda name: name[len("_sidebar_"):-len(".md")]),
        ("search-index_*.json", lambda name: name[len("search-index_"):-len(".json")]),
    ]
    for pattern, extract in patterns:
        for path in sorted(HTML_DIR.glob(pattern)):
            if path.name in ("index_all.html",):
                continue
            repo_id = extract(path.name)
            if repo_id not in keep:
                try:
                    path.unlink()
                    removed.append(path.name)
                except OSError:
                    pass
    for path in sorted(LIB_DIR.glob("offline-data_*.js")):
        repo_id = path.name[len("offline-data_"):-len(".js")]
        if repo_id not in keep:
            try:
                path.unlink()
                removed.append(path.name)
            except OSError:
                pass
    if removed:
        print(f"  [清理] 已删除 {len(removed)} 个不再使用的仓库产物：{', '.join(removed[:6])}")


def generate_master_index_html(repos, title="文档中心", all_page="index_all.html", config_page="md2web_config.html"):
    """生成总览首页 index.html：按仓库分组列出各仓库入口页，并提供跨仓库搜索。"""
    groups = {}
    for repo in repos:
        groups.setdefault(repo["group"], []).append(repo)
    sections = []
    for group in sorted(groups):
        cards = []
        for repo in groups[group]:
            badges = ''
            if repo.get("auto"):
                badges += '<span class="badge readonly">未配置 SVN</span>'
            if repo.get("read_only"):
                badges += '<span class="badge readonly">只读</span>'
            if not repo.get("allow_commit", True):
                badges += '<span class="badge readonly">禁止合入</span>'
            note = repo.get("url") or ("本地文件夹（不连接 SVN）" if repo.get("auto") else "（未填写 SVN 地址）")
            cards.append(
                '<a class="card" href="' + HTML_PREFIX + repo_page_name(repo["id"]) + '">'
                + '<strong>' + html.escape(str(repo["id"])) + badges + '</strong>'
                + '<span>目录：' + html.escape(str(repo["mount"])) + '</span>'
                + '<span>' + html.escape(str(note)) + '</span>'
                + '</a>'
            )
        sections.append('<h2>' + html.escape(str(group)) + '</h2><div class="cards">' + ''.join(cards) + '</div>')
    if not repos:
        sections.append('<p class="empty">还没有配置仓库：请在 <a href="' + config_page + '">' + config_page
                        + '</a> 中添加 SVN 仓库与目录映射，然后重新构建或等待自动同步。</p>')
    page = f"""<!DOCTYPE html>
<!-- 站点基于 docsify 4.13.1（MIT，https://github.com/docsifyjs/docsify）构建；
     第三方组件与许可见 THIRD-PARTY-NOTICES.md -->
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{html.escape(title)}</title>
  <style>{MASTER_STYLE}</style>
</head>
<body>
  <div class="wrap">
    <h1>{html.escape(title)}</h1>
    <p class="sub">按仓库分组浏览：每个仓库一个独立入口页（含独立搜索索引）。</p>
    <div class="tools">
      <input type="search" placeholder="仅按文件名/标题搜索（搜索文件内容请到全部文档）" data-master-search
             aria-label="仅按文件名或标题搜索">
      <a href="{HTML_PREFIX}{all_page}">全部文档（合并视图）</a>
      <a href="{HTML_PREFIX}{config_page}">仓库配置</a>
      <a href="{HTML_PREFIX}md2web_feedback.html">读者反馈</a>
    </div>
    <p class="hint">本页搜索<strong>只匹配文件名与标题</strong>；需要搜索<strong>文件内容（全文检索）</strong>请到
      <a href="{HTML_PREFIX}{all_page}">全部文档（{all_page}）</a>。</p>
    <div class="results" data-master-results></div>
    {''.join(sections)}
  </div>
  <script>window.__MD2WEB_REPOS__ = {json.dumps(repos, ensure_ascii=False)};</script>
  <script>{MASTER_SCRIPT}</script>
  <script src="lib/md2web-feedback.js"></script>
</body>
</html>
"""
    index_path = DOCS_DIR / "index.html"
    index_path.write_text(page, encoding="utf-8")
    print(f"  [生成] index.html（总览：{len(repos)} 个仓库 / {len(groups)} 个分组）")


def generate_standalone_page(html_name, js_name, label):
    """把独立页面（web/<html> + web/<js>）复制到 docs/html/。"""
    html_source = ROOT / "web" / html_name
    if not html_source.is_file():
        return False
    LIB_DIR.mkdir(parents=True, exist_ok=True)
    HTML_DIR.mkdir(parents=True, exist_ok=True)
    js_source = ROOT / "web" / js_name
    if js_source.is_file():
        (LIB_DIR / js_name).write_text(js_source.read_text(encoding="utf-8"), encoding="utf-8")
    (HTML_DIR / html_name).write_text(version_asset_urls(html_source.read_text(encoding="utf-8")),
                                      encoding="utf-8")
    print(f"  [生成] {html_name}（{label}）")
    return True


def generate_config_page():
    """把配置页（web/md2web_config.html + web/md2web-config.js）复制到 docs/。"""
    generate_standalone_page("md2web_config.html", "md2web-config.js", "仓库配置页")


def generate_feedback_page():
    """把读者反馈页（web/md2web_feedback.html + web/md2web-feedback.js）复制到 docs/。"""
    generate_standalone_page("md2web_feedback.html", "md2web-feedback.js", "读者反馈")


def main(argv=None):
    args = parse_args(argv)

    print("=== Docsify 离线文档站 构建工具 ===\n")
    print(f"源文档目录: {display_path(MD_DIR)}")
    print(f"输出目录: {display_path(DOCS_DIR)}")
    print(f"站点标题: {args.title}\n")

    try:
        md_files = scan_markdown(MD_DIR)
        for rel in md_files:
            read_markdown(MD_DIR / rel)
    except (BuildError, OSError, UnicodeDecodeError) as error:
        print(f"  错误: {error}")
        sys.exit(1)

    print(f"共 {len(md_files)} 个文档\n")

    try:
        if args.index_only:
            print("=== 只刷新搜索索引与离线数据（不重新生成站点文件） ===\n")
            repos = load_all_repos()
            HTML_DIR.mkdir(parents=True, exist_ok=True)
            generate_search_index(md_files, args.title, repos=repos)
            generate_offline_data(md_files, sidebar=HTML_PREFIX + "_sidebar.md")
            for repo in repos:
                repo_files = files_for_mount(md_files, repo["mount"])
                search_index = f"search-index_{repo['id']}.json"
                sidebar = f"_sidebar_{repo['id']}.md"
                generate_search_index(repo_files, args.title, path=HTML_DIR / search_index,
                                      repos=repos, include_readme=False,
                                      site=HTML_PREFIX + repo_page_name(repo["id"]))
                generate_offline_data(repo_files, path=LIB_DIR / f"offline-data_{repo['id']}.js",
                                      search_index_path=HTML_DIR / search_index,
                                      sidebar=HTML_PREFIX + sidebar,
                                      include_readme=False)
            print("\n=== 索引刷新完成 ===")
            return

        print("1. 检查离线依赖...")
        ensure_assets(offline=args.offline)
        patch_docsify_file_router()
        patch_docsify_css()
        ensure_prism_components(MD_DIR, md_files, offline=args.offline)
        generate_custom_search_assets()

        print("2. 生成导航、首页、搜索索引...")
        repos = load_all_repos()
        HTML_DIR.mkdir(parents=True, exist_ok=True)
        generate_sidebar(md_files, path=HTML_DIR / "_sidebar.md", link_first_level=True)
        generate_readme(md_files, args.title, repos=repos, path=HTML_DIR / "README.md")
        generate_search_index(md_files, args.title, repos=repos, path=HTML_DIR / "search-index.json")
        generate_offline_data(md_files, sidebar=HTML_PREFIX + "_sidebar.md")

        print("3. 生成多仓库页面（每仓库一个入口 + 总览 + 配置页）...")
        cleanup_repo_artifacts(repos)
        generate_index_html(args.title, path=HTML_DIR / "index_all.html", site_name=args.title,
                            repo={"all": True}, repos=repos, route_sidebar=True,
                            homepage=HTML_PREFIX + "README.md", home_link="index.html")
        for repo in repos:
            sub = mount_subpath(repo["mount"])
            repo_files = files_for_mount(md_files, repo["mount"])
            page = repo_page_name(repo["id"])
            sidebar = f"_sidebar_{repo['id']}.md"
            search_index = f"search-index_{repo['id']}.json"
            offline_data = f"lib/offline-data_{repo['id']}.js"
            generate_sidebar(repo_files, path=HTML_DIR / sidebar, heading=repo["id"])
            generate_search_index(repo_files, args.title, path=HTML_DIR / search_index,
                                  repos=repos, include_readme=False,
                                  site=HTML_PREFIX + page)
            generate_offline_data(repo_files, path=LIB_DIR / f"offline-data_{repo['id']}.js",
                                  search_index_path=HTML_DIR / search_index,
                                  sidebar=HTML_PREFIX + sidebar,
                                  include_readme=False)
            homepage = f"md/{sub}/README.md" if (MD_DIR / sub / "README.md").is_file() else (
                f"md/{repo_files[0]}" if repo_files else None)
            generate_index_html(args.title, path=HTML_DIR / page, page_name=page,
                                site_name=f"{repo['id']} · {args.title}",
                                sidebar=sidebar, search_index=search_index, offline_data=offline_data,
                                homepage=homepage, read_only=repo.get("read_only", False),
                                allow_commit=repo.get("allow_commit", True), repo=repo,
                                home_link=HTML_PREFIX + "index_all.html")
        generate_master_index_html(repos, args.title)
        generate_config_page()
        generate_feedback_page()

        print("\n=== 构建完成 ===")
        print("\n启动本地预览: python serve.py")
        print("本机打开: http://localhost:8882")
        print("局域网访问: http://<这台机器的IP>:8882")
    except (BuildError, OSError, UnicodeDecodeError) as error:
        print(f"  错误: {error}")
        sys.exit(1)


if __name__ == "__main__":
    main()
