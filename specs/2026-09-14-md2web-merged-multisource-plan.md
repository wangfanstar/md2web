# md2web 合并架构与多源支持 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 webtool 离线依赖并入 `docs/`，支持多个源文件夹合并成一个可离线浏览/搜索的 Docsify 站点，并新增跨平台预览与离线回归测试。

**Architecture:** 单产物目录 `docs/`（站点 + 离线依赖）。`setup_docsify.py` 解析 `md_sources.json` 与命令行源 → 扫描 → 镜像同步到 `docs/<分组>/` → 生成侧边栏/首页/搜索索引/离线数据；依赖在 `docs/lib/` 内复用，缺失才联网补齐。`serve.py` 提供 Windows/Linux 通用预览。

**Tech Stack:** Python 3.8+ 标准库（argparse/pathlib/http.server/unittest）；Docsify 4.13.1、Prism 1.29.0（已离线存放在仓库中）。

**设计文档:** `specs/2026-09-14-md2web-merged-multisource-design.md`

---

## 执行前须知

- 工作目录：`E:\MCP_PROJECT\md2web`，Shell 为 Windows PowerShell 5.1；所有命令都在该目录执行。
- 本机 Python 为 3.12；测试命令统一为 `python -m unittest discover -s tests -v`。
- **不要改动** `setup_docsify.py` 中三处内嵌字符串：`CUSTOM_SEARCH_JS`、`CUSTOM_SEARCH_CSS`、`OFFLINE_FILE_JS`（分别约 143–1981、1982–2768、2769–2942 行）。本计划只改 Python 逻辑。
- **中间态说明：** 任务 2 起脚本处于重构中间态，`python setup_docsify.py` 暂时不可用；每个任务的验证以单元测试为准，任务 8 完成后恢复完整功能。
- 每个任务完成后提交一次；提交信息用任务里给出的原文。
- 测试不访问网络：所有下载函数用 `unittest.mock` 替换或在临时目录预置伪依赖。

---

### Task 1: 目录迁移（webtool → docs/lib）

**Files:**
- Move: `webtool/lib/**` → `docs/lib/**`
- Delete: `webtool/`

- [ ] **Step 1: 执行迁移**

```powershell
New-Item -ItemType Directory -Force docs\lib | Out-Null
Move-Item -Path webtool\lib\* -Destination docs\lib\ -Force
Remove-Item webtool -Recurse -Force
```

- [ ] **Step 2: 验证结果**

```powershell
Get-ChildItem docs\lib | Select-Object Name
Test-Path webtool
```

Expected: 列出 15 个条目（含 `offline-data.js`、`components` 目录）；`Test-Path` 输出 `False`。

- [ ] **Step 3: 提交**

```powershell
git add -A
git commit -m "迁移：webtool 离线资源并入 docs/lib"
```

---

### Task 2: 配置解析与 CLI 源

**Files:**
- Modify: `setup_docsify.py`（文件头部常量与 `parse_args`，新增配置函数）
- Create: `tests/__init__.py`
- Create: `tests/test_setup_docsify.py`（测试基类 + `ConfigTests`）
- Create: `md_sources.json`

- [ ] **Step 1: 写失败测试**

创建 `tests/__init__.py`（空文件），创建 `tests/test_setup_docsify.py`：

```python
import argparse
import importlib.util
import io
import json
import shutil
import tempfile
import threading
import unittest
import urllib.request
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TempDirTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="md2web-test-"))
        self.module = load_module("setup_docsify", "setup_docsify.py")
        self.docs = self.tmp / "docs"
        self.module.DOCS_DIR = self.docs
        self.module.LIB_DIR = self.docs / "lib"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def make_source(self, name, files):
        root = self.tmp / name
        for rel, content in files.items():
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        return root

    def make_spec(self, root, label="", dir="", explicit=False):
        return self.module.SourceSpec(
            raw_path=str(root),
            base_dir=Path.cwd(),
            label=label,
            dir=dir,
            explicit_dir=explicit,
        )

    def resolve(self, specs):
        with redirect_stdout(io.StringIO()):
            sources = self.module.resolve_sources(specs, self.docs)
            self.module.assign_group_dirs(sources)
        return sources

    def make_args(self, sources=(), config=None, no_config=True):
        return argparse.Namespace(
            source_md_dirs=[Path(item) for item in sources],
            output_docs_dir=None,
            config_path=Path(config) if config else None,
            no_config=no_config,
            index_only=False,
        )


class ConfigTests(TempDirTestCase):
    def test_load_config_object_form(self):
        config = self.tmp / "md_sources.json"
        config.write_text(
            json.dumps(
                {
                    "title": "T",
                    "sources": [{"path": "md", "label": "文档", "dir": "d1"}, "refs"],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        title, specs = self.module.load_config_file(config)
        self.assertEqual(title, "T")
        self.assertEqual([item.raw_path for item in specs], ["md", "refs"])
        self.assertEqual(specs[0].label, "文档")
        self.assertEqual(specs[0].dir, "d1")
        self.assertTrue(specs[0].explicit_dir)
        self.assertFalse(specs[1].explicit_dir)
        self.assertEqual(specs[0].base_dir, config.parent.resolve())

    def test_load_config_array_form(self):
        config = self.tmp / "list.json"
        config.write_text(json.dumps(["a", "b"]), encoding="utf-8")
        title, specs = self.module.load_config_file(config)
        self.assertIsNone(title)
        self.assertEqual([item.raw_path for item in specs], ["a", "b"])

    def test_load_config_invalid_json(self):
        config = self.tmp / "bad.json"
        config.write_text("{not json", encoding="utf-8")
        with self.assertRaises(self.module.BuildError):
            self.module.load_config_file(config)

    def test_load_config_missing_path_field(self):
        config = self.tmp / "bad2.json"
        config.write_text(json.dumps({"sources": [{"label": "x"}]}), encoding="utf-8")
        with self.assertRaises(self.module.BuildError):
            self.module.load_config_file(config)

    def test_load_source_specs_combines_config_and_cli(self):
        config = self.tmp / "md_sources.json"
        config.write_text(
            json.dumps({"sources": [{"path": "from-config"}]}), encoding="utf-8"
        )
        args = self.make_args(sources=["from-cli"], config=config, no_config=False)
        title, specs = self.module.load_source_specs(args)
        self.assertEqual(title, "文档中心")
        self.assertEqual([item.raw_path for item in specs], ["from-config", "from-cli"])
        self.assertEqual([item.origin for item in specs], ["config", "cli"])

    def test_load_source_specs_defaults_to_md(self):
        args = self.make_args()
        title, specs = self.module.load_source_specs(args)
        self.assertEqual(title, "文档中心")
        self.assertEqual(len(specs), 1)
        self.assertEqual(specs[0].raw_path, "md")
        self.assertEqual(specs[0].base_dir, self.module.ROOT)

    def test_load_source_specs_explicit_config_missing(self):
        args = self.make_args(config=self.tmp / "nope.json", no_config=False)
        with self.assertRaises(self.module.BuildError):
            self.module.load_source_specs(args)
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python -m unittest discover -s tests -v`
Expected: ERROR / FAIL（`module has no attribute 'SourceSpec'` 或 `BuildError`）。

- [ ] **Step 3: 实现**

修改 `setup_docsify.py`：

3a. 替换文件头导入与常量（原第 1–15 行）：

```python
"""将 Markdown 文件夹转成 Docsify 离线文档站。"""

import argparse
import hashlib
import html
import json
import re
import shutil
import sys
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
```

3b. 用下面的实现整体替换原 `parse_args`（原第 18–69 行）：

```python
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
```

3c. 在 `parse_args` 之后新增：

```python
def load_config_file(config_path: Path):
    """读取 md_sources.json，返回 (title, specs)。"""
    try:
        raw = json.loads(Path(config_path).read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise BuildError(f"配置文件不是合法 JSON: {config_path} ({error})")
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
```

3d. 创建 `md_sources.json`：

```json
{
  "title": "文档中心",
  "sources": [
    { "path": "md", "label": "文档", "dir": "md" }
  ]
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `python -m unittest discover -s tests -v`
Expected: `ConfigTests` 全部 `ok`（7 个用例）。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat: 支持 md_sources.json 与可重复 --source-md 参数"
```

---

### Task 3: 源解析、分组目录与扫描

**Files:**
- Modify: `setup_docsify.py`（新增函数，放在 `load_source_specs` 之后）
- Modify: `tests/test_setup_docsify.py`（追加 `SourceTests`）

- [ ] **Step 1: 写失败测试**

在 `tests/test_setup_docsify.py` 末尾追加：

```python
class SourceTests(TempDirTestCase):
    def test_sanitize_dir_name(self):
        sanitize = self.module.sanitize_dir_name
        self.assertEqual(sanitize("a b:c/d"), "a-b-c-d")
        self.assertEqual(sanitize("  .name. "), "name")
        self.assertEqual(sanitize("***"), "")
        self.assertEqual(sanitize("中文 目录"), "中文-目录")

    def test_scan_collects_md_and_assets(self):
        root = self.make_source(
            "src",
            {
                "a.md": "# A",
                "sub/b.md": "# B",
                "sub/images/pic.png": "x",
                "sub/images/data.bin": "x",
                "loose.jpg": "x",
                ".hidden/c.md": "# C",
                "note.txt": "x",
            },
        )
        sources = self.resolve([self.make_spec(root)])
        self.assertEqual(sources[0].dir, "src")
        self.assertEqual(sources[0].md_files, ["a.md", "sub/b.md"])
        self.assertEqual(
            sources[0].asset_files,
            ["loose.jpg", "sub/images/data.bin", "sub/images/pic.png"],
        )

    def test_resolve_skips_missing_and_duplicate(self):
        root = self.make_source("keep", {"a.md": "# A"})
        specs = [
            self.make_spec(root),
            self.make_spec(root),
            self.make_spec(self.tmp / "nope"),
        ]
        sources = self.resolve(specs)
        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0].root, root.resolve())

    def test_resolve_nested_sources_error(self):
        outer = self.make_source("outer", {"a.md": "# A"})
        inner = outer / "inner"
        (inner / "b.md").parent.mkdir(parents=True, exist_ok=True)
        (inner / "b.md").write_text("# B", encoding="utf-8")
        with self.assertRaises(self.module.BuildError):
            self.resolve([self.make_spec(outer), self.make_spec(inner)])

    def test_resolve_docs_nesting_error(self):
        inside = self.docs / "inner"
        inside.mkdir(parents=True)
        (inside / "x.md").write_text("# x", encoding="utf-8")
        with self.assertRaises(self.module.BuildError):
            self.resolve([self.make_spec(inside)])

    def test_resolve_all_empty_error(self):
        root = self.make_source("empty", {"images/pic.png": "x"})
        with self.assertRaises(self.module.BuildError):
            self.resolve([self.make_spec(root)])

    def test_assign_dirs_collision_suffix(self):
        first = self.make_source("a/notes", {"x.md": "x"})
        second = self.make_source("b/notes", {"y.md": "y"})
        sources = self.resolve([self.make_spec(first), self.make_spec(second)])
        self.assertEqual([item.dir for item in sources], ["notes", "notes-2"])

    def test_assign_dirs_explicit_collision_error(self):
        first = self.make_source("a/one", {"x.md": "x"})
        second = self.make_source("b/two", {"y.md": "y"})
        specs = [
            self.make_spec(first, dir="same", explicit=True),
            self.make_spec(second, dir="same", explicit=True),
        ]
        with self.assertRaises(self.module.BuildError):
            self.resolve(specs)

    def test_assign_dirs_reserved_lib_suffix(self):
        root = self.make_source("lib", {"x.md": "x"})
        sources = self.resolve([self.make_spec(root)])
        self.assertEqual(sources[0].dir, "lib-2")

    def test_assign_dirs_explicit_invalid_dir_error(self):
        root = self.make_source("src", {"x.md": "x"})
        for bad in ["../escape", "a/b", "***", "."]:
            with self.assertRaises(self.module.BuildError):
                self.resolve([self.make_spec(root, dir=bad, explicit=True)])

    def test_assign_dirs_explicit_reserved_names_error(self):
        root = self.make_source("src", {"x.md": "x"})
        for bad in ["lib", "nul", "COM1"]:
            with self.assertRaises(self.module.BuildError):
                self.resolve([self.make_spec(root, dir=bad, explicit=True)])

    def test_assign_dirs_case_insensitive_collision(self):
        first = self.make_source("a/Notes", {"x.md": "x"})
        second = self.make_source("b/notes", {"y.md": "y"})
        sources = self.resolve([self.make_spec(first), self.make_spec(second)])
        self.assertEqual([item.dir for item in sources], ["Notes", "notes-2"])

    def test_scan_uppercase_md_and_images_dir(self):
        root = self.make_source(
            "src",
            {"A.MD": "# A", "Images/data.bin": "x", "sub/IMG.PNG": "x"},
        )
        sources = self.resolve([self.make_spec(root)])
        self.assertEqual(sources[0].md_files, ["A.MD"])
        self.assertEqual(sources[0].asset_files, ["Images/data.bin", "sub/IMG.PNG"])

    def test_resolve_docs_inside_source_error(self):
        root = self.make_source("src", {"a.md": "# A"})
        docs_inside = root / "out"
        with self.assertRaises(self.module.BuildError):
            with redirect_stdout(io.StringIO()):
                self.module.resolve_sources([self.make_spec(root)], docs_inside)
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python -m unittest discover -s tests -v`
Expected: `SourceTests` ERROR（`module has no attribute 'sanitize_dir_name'`）。

- [ ] **Step 3: 实现**

在 `load_source_specs` 之后新增：

```python
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
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `python -m unittest discover -s tests -v`
Expected: `ConfigTests` + `SourceTests` 全部 `ok`。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat: 多源解析、分组目录与递归扫描"
```

---

### Task 4: 镜像同步

**Files:**
- Modify: `setup_docsify.py`（新增 `sync_sources`；删除旧 `sync_md_files`）
- Modify: `tests/test_setup_docsify.py`（追加 `SyncTests`）

- [ ] **Step 1: 写失败测试**

在文件头部导入区补充 `from unittest import mock`，然后追加：

```python
class SyncTests(TempDirTestCase):
    def test_sync_copies_tree_and_assets_and_removes_deleted(self):
        root = self.make_source(
            "src",
            {"a.md": "# A", "sub/b.md": "# B", "sub/images/pic.png": "img"},
        )
        sources = self.resolve([self.make_spec(root)])
        with redirect_stdout(io.StringIO()):
            self.module.sync_sources(sources, self.docs)
        self.assertTrue((self.docs / "src" / "a.md").exists())
        self.assertTrue((self.docs / "src" / "sub" / "b.md").exists())
        self.assertTrue((self.docs / "src" / "sub" / "images" / "pic.png").exists())

        (root / "sub" / "b.md").unlink()
        self.module.scan_source(sources[0])
        with redirect_stdout(io.StringIO()):
            self.module.sync_sources(sources, self.docs)
        self.assertFalse((self.docs / "src" / "sub" / "b.md").exists())

    def test_sync_removes_stale_group_keeps_lib(self):
        (self.docs / "lib").mkdir(parents=True)
        (self.docs / "lib" / "keep.js").write_text("x", encoding="utf-8")
        (self.docs / "old").mkdir(parents=True)
        (self.docs / "old" / "x.md").write_text("# x", encoding="utf-8")
        root = self.make_source("src", {"a.md": "# A"})
        sources = self.resolve([self.make_spec(root)])
        with redirect_stdout(io.StringIO()):
            self.module.sync_sources(sources, self.docs)
        self.assertFalse((self.docs / "old").exists())
        self.assertTrue((self.docs / "lib" / "keep.js").exists())

    def test_sync_multiple_sources_and_stale_cleanup(self):
        first = self.make_source("one", {"a.md": "# A"})
        second = self.make_source("two", {"b.md": "# B"})
        (self.docs / "stale").mkdir(parents=True)
        (self.docs / "stale" / "old.md").write_text("# old", encoding="utf-8")
        (self.docs / "keep.txt").write_text("keep", encoding="utf-8")
        sources = self.resolve([self.make_spec(first), self.make_spec(second)])
        with redirect_stdout(io.StringIO()):
            self.module.sync_sources(sources, self.docs)
        self.assertTrue((self.docs / "one" / "a.md").exists())
        self.assertTrue((self.docs / "two" / "b.md").exists())
        self.assertFalse((self.docs / "stale").exists())
        self.assertTrue((self.docs / "keep.txt").exists())

    def test_sync_keeps_hidden_directories(self):
        (self.docs / ".git").mkdir(parents=True)
        (self.docs / ".git" / "config").write_text("x", encoding="utf-8")
        root = self.make_source("src", {"a.md": "# A"})
        sources = self.resolve([self.make_spec(root)])
        with redirect_stdout(io.StringIO()):
            self.module.sync_sources(sources, self.docs)
        self.assertTrue((self.docs / ".git" / "config").exists())

    def test_sync_wraps_oserror(self):
        (self.docs / "src").mkdir(parents=True)
        root = self.make_source("src", {"a.md": "# A"})
        sources = self.resolve([self.make_spec(root)])
        with mock.patch.object(self.module.shutil, "rmtree", side_effect=OSError("locked")):
            with redirect_stdout(io.StringIO()):
                with self.assertRaises(self.module.BuildError):
                    self.module.sync_sources(sources, self.docs)

    def test_sync_wraps_cleanup_oserror(self):
        (self.docs / "src").mkdir(parents=True)
        (self.docs / "src" / "old.md").write_text("# old", encoding="utf-8")
        (self.docs / "stale").mkdir()
        root = self.make_source("src", {"a.md": "# A"})
        sources = self.resolve([self.make_spec(root)])
        real_rmtree = self.module.shutil.rmtree

        def flaky_rmtree(path, *args, **kwargs):
            if Path(path) == self.docs / "stale":
                raise OSError("locked")
            return real_rmtree(path, *args, **kwargs)

        with mock.patch.object(self.module.shutil, "rmtree", flaky_rmtree):
            with redirect_stdout(io.StringIO()):
                with self.assertRaises(self.module.BuildError):
                    self.module.sync_sources(sources, self.docs)
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python -m unittest discover -s tests -v`
Expected: `SyncTests` ERROR（`module has no attribute 'sync_sources'`）。

- [ ] **Step 3: 实现**

在 `assign_group_dirs` 之后新增 `sync_sources`，并**删除**原 `sync_md_files` 函数（原第 3115–3146 行附近）：

```python
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
            try:
                shutil.rmtree(entry)
            except OSError as error:
                raise BuildError(
                    f"清理过期分组失败: {display_path(entry)}/ ({error})"
                ) from error
            print(f"  [清理] 移除过期分组 {display_path(entry)}/")
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `python -m unittest discover -s tests -v`
Expected: 全部 `ok`。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat: 多源镜像同步与过期分组清理"
```

---

### Task 5: 离线依赖确保

**Files:**
- Modify: `setup_docsify.py`（新增 `_download`、`ensure_assets`；删除旧 `download_assets`）
- Modify: `tests/test_setup_docsify.py`（追加 `AssetTests`）

- [ ] **Step 1: 写失败测试**

在文件头部导入区补充 `from unittest import mock`，然后追加：

```python
class AssetTests(TempDirTestCase):
    def test_ensure_assets_reuses_existing(self):
        (self.docs / "lib").mkdir(parents=True)
        for filename in self.module.ASSETS:
            (self.docs / "lib" / filename).write_text("x", encoding="utf-8")
        with mock.patch.object(self.module, "_download") as download:
            with redirect_stdout(io.StringIO()):
                self.module.ensure_assets()
        download.assert_not_called()

    def test_ensure_assets_reports_missing(self):
        with mock.patch.object(self.module, "_download", return_value=False):
            with redirect_stdout(io.StringIO()):
                with self.assertRaises(self.module.BuildError) as ctx:
                    self.module.ensure_assets()
        self.assertIn("docsify.min.js", str(ctx.exception))

    def test_download_writes_file(self):
        dest = self.tmp / "out.js"

        class FakeResponse(io.BytesIO):
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_urlopen(url, timeout=None):
            self.assertEqual(timeout, 30)
            return FakeResponse(b"data")

        with mock.patch.object(self.module.urllib.request, "urlopen", fake_urlopen):
            self.assertTrue(self.module._download("https://example.invalid/x.js", dest))
        self.assertEqual(dest.read_bytes(), b"data")
        self.assertFalse((self.tmp / "out.js.part").exists())

    def test_download_failure_keeps_existing_file(self):
        dest = self.tmp / "out.js"
        dest.write_bytes(b"old")

        def fake_urlopen(url, timeout=None):
            raise self.module.urllib.error.URLError("boom")

        with mock.patch.object(self.module.urllib.request, "urlopen", fake_urlopen):
            with redirect_stdout(io.StringIO()):
                self.assertFalse(self.module._download("https://example.invalid/x.js", dest))
        self.assertEqual(dest.read_bytes(), b"old")
        self.assertFalse((self.tmp / "out.js.part").exists())

    def test_download_rejects_truncated_response(self):
        dest = self.tmp / "out.js"
        dest.write_bytes(b"old")

        class TruncatedResponse(io.BytesIO):
            headers = {"Content-Length": "100"}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_urlopen(url, timeout=None):
            return TruncatedResponse(b"0123456789")

        with mock.patch.object(self.module.urllib.request, "urlopen", fake_urlopen):
            with redirect_stdout(io.StringIO()):
                self.assertFalse(self.module._download("https://example.invalid/x.js", dest))
        self.assertEqual(dest.read_bytes(), b"old")
        self.assertFalse((self.tmp / "out.js.part").exists())

    def test_ensure_assets_redownloads_empty_file(self):
        (self.docs / "lib").mkdir(parents=True)
        for filename in self.module.ASSETS:
            (self.docs / "lib" / filename).write_text("x", encoding="utf-8")
        (self.docs / "lib" / "docsify.min.js").write_text("", encoding="utf-8")
        with mock.patch.object(self.module, "_download", return_value=True) as download:
            with redirect_stdout(io.StringIO()):
                self.module.ensure_assets()
        self.assertEqual(download.call_count, 1)
        self.assertEqual(download.call_args.args[1].name, "docsify.min.js")
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python -m unittest discover -s tests -v`
Expected: `AssetTests` ERROR（`module has no attribute '_download'`）。

- [ ] **Step 3: 实现**

用下面的实现整体替换原 `download_assets`（原第 2945–2958 行附近）：

```python
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
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `python -m unittest discover -s tests -v`
Expected: 全部 `ok`。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat: 离线依赖复用与缺失明确报错"
```

---

### Task 6: 多源 Prism 语言组件

**Files:**
- Modify: `setup_docsify.py`（`collect_fence_languages` 改为接收 sources；`download_prism_components` 改为 `ensure_prism_components`）
- Modify: `tests/test_setup_docsify.py`（追加 `PrismTests`）

- [ ] **Step 1: 写失败测试**

追加：

```python
class PrismTests(TempDirTestCase):
    def test_collect_fence_languages_from_sources(self):
        root = self.make_source(
            "src", {"a.md": "```python\nprint(1)\n```\n\n```cuda\nx\n```"}
        )
        sources = self.resolve([self.make_spec(root)])
        self.assertEqual(self.module.collect_fence_languages(sources), {"python", "cuda"})

    def test_ensure_prism_components_reuses_and_warns(self):
        components = self.docs / "lib" / "components"
        components.mkdir(parents=True)
        (components / "prism-python.min.js").write_text("x", encoding="utf-8")
        root = self.make_source(
            "src", {"a.md": "```python\nprint(1)\n```\n\n```rust\nx\n```"}
        )
        sources = self.resolve([self.make_spec(root)])
        with mock.patch.object(self.module, "_download", return_value=False) as download:
            with redirect_stdout(io.StringIO()) as output:
                self.module.ensure_prism_components(sources)
        requested = " ".join(str(call.args[0]) for call in download.call_args_list)
        self.assertIn("prism-rust.min.js", requested)
        self.assertNotIn("prism-python.min.js", requested)
        self.assertIn("警告", output.getvalue())

    def test_collect_fence_languages_from_multiple_sources(self):
        first = self.make_source("one", {"a.md": "```python\nprint(1)\n```"})
        second = self.make_source("two", {"b.md": "```go\npackage main\n```"})
        sources = self.resolve([self.make_spec(first), self.make_spec(second)])
        self.assertEqual(
            self.module.collect_fence_languages(sources), {"python", "go"}
        )

    def test_ensure_prism_components_skips_without_languages(self):
        root = self.make_source("src", {"a.md": "# 无代码块"})
        sources = self.resolve([self.make_spec(root)])
        with mock.patch.object(self.module, "_download") as download:
            with redirect_stdout(io.StringIO()) as output:
                self.module.ensure_prism_components(sources)
        download.assert_not_called()
        self.assertIn("跳过", output.getvalue())

    def test_ensure_prism_components_resolves_fallback_closure(self):
        root = self.make_source("src", {"a.md": "```cuda\nx\n```"})
        sources = self.resolve([self.make_spec(root)])
        with mock.patch.object(self.module, "_download", return_value=True) as download:
            with redirect_stdout(io.StringIO()):
                self.module.ensure_prism_components(sources)
        requested = " ".join(str(call.args[0]) for call in download.call_args_list)
        self.assertIn("prism-cpp.min.js", requested)
        self.assertIn("prism-c.min.js", requested)
        self.assertNotIn("prism-cuda", requested)
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python -m unittest discover -s tests -v`
Expected: `PrismTests` FAIL/ERROR（`collect_fence_languages() takes 0 positional arguments` / `no attribute 'ensure_prism_components'`）。

- [ ] **Step 3: 实现**

3a. 用下面实现整体替换原 `collect_fence_languages`（原第 3044–3054 行附近）：

```python
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
```

3b. 用下面实现整体替换原 `download_prism_components`（原第 3079–3104 行附近）：

```python
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
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `python -m unittest discover -s tests -v`
Expected: 全部 `ok`。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat: 多源 Prism 语言组件按需准备"
```

---

### Task 7: 导航、首页与搜索生成

**Files:**
- Modify: `setup_docsify.py`（替换 `collect_search_paths`、`compute_search_namespace`、`generate_search_index`、`generate_sidebar`、`generate_readme`、`generate_index_html`）
- Modify: `tests/test_setup_docsify.py`（追加 `GenerationTests`）

- [ ] **Step 1: 写失败测试**

追加：

```python
class GenerationTests(TempDirTestCase):
    def build_site(self):
        root = self.make_source(
            "src",
            {
                "指南/入门.md": "# 入门\n\n## 安装\n\n内容",
                "指南/进阶.md": "# 进阶",
                "常见问题.md": "# FAQ",
            },
        )
        sources = self.resolve([self.make_spec(root, label="文档")])
        with redirect_stdout(io.StringIO()):
            self.module.sync_sources(sources, self.docs)
            self.module.generate_sidebar(sources)
            self.module.generate_readme(sources, "测试站点")
            self.module.generate_search_index(sources, "测试站点")
            self.module.generate_offline_data()
        return sources

    def test_sidebar_tree(self):
        self.build_site()
        sidebar = (self.docs / "_sidebar.md").read_text(encoding="utf-8")
        self.assertIn("- **文档**", sidebar)
        self.assertIn("- **指南**", sidebar)
        self.assertIn("[入门](/src/指南/入门.md)", sidebar)
        self.assertIn("[常见问题](/src/常见问题.md)", sidebar)

    def test_readme_index(self):
        self.build_site()
        readme = (self.docs / "README.md").read_text(encoding="utf-8")
        self.assertIn("# 测试站点", readme)
        self.assertIn("[入门](src/指南/入门.md)", readme)

    def test_search_index_routes(self):
        self.build_site()
        index = json.loads((self.docs / "search-index.json").read_text(encoding="utf-8"))
        self.assertIn("/", index)
        self.assertIn("/src/指南/入门.md", index)
        entry = index["/src/指南/入门.md"]["/src/指南/入门.md?id=安装"]
        self.assertEqual(entry["route"], "/src/指南/入门.md")

    def test_offline_data_contains_all_md(self):
        self.build_site()
        text = (self.docs / "lib" / "offline-data.js").read_text(encoding="utf-8")
        payload = json.loads(text.split("=", 1)[1].rstrip().rstrip(";"))
        self.assertIn("src/指南/入门.md", payload["content"])
        self.assertIn("_sidebar.md", payload["content"])
        self.assertIn("searchIndex", payload)

    def test_namespace_changes_with_files(self):
        root = self.make_source("src", {"a.md": "# A"})
        sources = self.resolve([self.make_spec(root)])
        first = self.module.compute_search_namespace(sources)
        (root / "b.md").write_text("# B", encoding="utf-8")
        self.module.scan_source(sources[0])
        second = self.module.compute_search_namespace(sources)
        self.assertNotEqual(first, second)

    def test_sidebar_single_file_dir_folds_to_link(self):
        root = self.make_source("src", {"单独/只有一篇.md": "# 只有一篇"})
        sources = self.resolve([self.make_spec(root)])
        with redirect_stdout(io.StringIO()):
            self.module.sync_sources(sources, self.docs)
            self.module.generate_sidebar(sources)
        sidebar = (self.docs / "_sidebar.md").read_text(encoding="utf-8")
        self.assertIn("[只有一篇](/src/单独/只有一篇.md)", sidebar)
        self.assertNotIn("- **单独**", sidebar)

    def test_multi_source_navigation_and_search(self):
        first = self.make_source("one", {"a.md": "# A"})
        second = self.make_source("two", {"sub/b.md": "# B"})
        sources = self.resolve(
            [self.make_spec(first, label="甲"), self.make_spec(second, label="乙")]
        )
        with redirect_stdout(io.StringIO()):
            self.module.sync_sources(sources, self.docs)
            self.module.generate_sidebar(sources)
            self.module.generate_readme(sources, "多源站点")
            self.module.generate_search_index(sources, "多源站点")
        sidebar = (self.docs / "_sidebar.md").read_text(encoding="utf-8")
        self.assertIn("- **甲**", sidebar)
        self.assertIn("- **乙**", sidebar)
        self.assertIn("[b](/two/sub/b.md)", sidebar)
        readme = (self.docs / "README.md").read_text(encoding="utf-8")
        self.assertIn("[b](two/sub/b.md)", readme)
        index = json.loads((self.docs / "search-index.json").read_text(encoding="utf-8"))
        self.assertIn("/one/a.md", index)
        self.assertIn("/two/sub/b.md", index)

    def test_index_html_escapes_title(self):
        self.docs.mkdir(parents=True, exist_ok=True)
        title = "文档</script><script>alert(1)</script>"
        with redirect_stdout(io.StringIO()):
            self.module.generate_index_html(["/"], "docs-test", title)
        html_text = (self.docs / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("</script><script>alert(1)", html_text)
        self.assertIn("\\u003c/script", html_text)
        self.assertIn("&lt;/script&gt;", html_text)
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python -m unittest discover -s tests -v`
Expected: `GenerationTests` ERROR（`generate_sidebar() takes 1 positional argument` 或类似）。

- [ ] **Step 3: 实现**

3a. 用下面实现整体替换原 `collect_search_paths` 与 `compute_search_namespace`（原第 3149–3166 行附近）：

```python
def collect_search_paths(sources):
    """收集所有可搜索的 Docsify 路由路径。"""
    paths = ["/"]
    for source in sources:
        for rel in source.md_files:
            paths.append(f"/{source.dir}/{rel}")
    return paths


def compute_search_namespace(sources):
    """根据文档列表生成 namespace，重建时自动失效旧缓存。"""
    parts = []
    for source in sources:
        for rel in source.md_files:
            parts.append(f"{source.dir}/{rel}:{(source.root / rel).stat().st_size}")
    digest = hashlib.md5("\n".join(parts).encode("utf-8")).hexdigest()[:10]
    return f"docs-{digest}"
```

3b. 用下面实现整体替换原 `generate_search_index`（原第 3270–3291 行附近）：

```python
def generate_search_index(sources, title="文档中心", depth=SEARCH_DEPTH):
    """在构建时生成 search-index.json，避免浏览器 localStorage 配额限制。"""
    index = {}
    readme = DOCS_DIR / "README.md"
    if readme.exists():
        index["/"] = build_page_index(
            "/", readme.read_text(encoding="utf-8"), depth, title
        )

    for source in sources:
        for rel in source.md_files:
            route = f"/{source.dir}/{rel}"
            content = (source.root / rel).read_text(encoding="utf-8")
            index[route] = build_page_index(route, content, depth, Path(rel).stem)

    index_path = DOCS_DIR / "search-index.json"
    index_path.write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    size_mb = index_path.stat().st_size / (1024 * 1024)
    print(f"  [生成] search-index.json ({len(index)} 页, {size_mb:.1f} MB)")
```

3c. 用下面实现整体替换原 `generate_sidebar` 与 `generate_readme`（原第 3322–3361 行附近）：

```python
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


def render_doc_tree(node, route_prefix, indent, lines, link):
    """递归渲染文档树；单文件叶子目录折叠为直接链接。"""
    for name in sorted(node["dirs"]):
        child = node["dirs"][name]
        child_files = child["files"]
        if len(child_files) == 1 and not child["dirs"]:
            filename = child_files[0]
            lines.append(
                f"{indent}- [{Path(filename).stem}]"
                f"({link(route_prefix + '/' + name + '/' + filename)})"
            )
            continue
        lines.append(f"{indent}- **{name}**")
        render_doc_tree(child, route_prefix + "/" + name, indent + "  ", lines, link)
    for filename in sorted(node["files"]):
        lines.append(
            f"{indent}- [{Path(filename).stem}]({link(route_prefix + '/' + filename)})"
        )


def generate_sidebar(sources):
    """生成 _sidebar.md 侧边栏文件"""
    lines = ["- **文档列表**"]
    for source in sources:
        lines.append(f"  - **{source.label}**")
        tree = build_doc_tree(source.md_files)
        render_doc_tree(tree, f"/{source.dir}", "    ", lines, lambda route: route)

    sidebar_path = DOCS_DIR / "_sidebar.md"
    sidebar_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"  [生成] _sidebar.md ({len(lines) - 1} 项)")


def generate_readme(sources, title="文档中心"):
    """生成 README.md 作为首页索引"""
    lines = [f"# {title}", "", "## 文档列表", ""]
    for source in sources:
        lines.append(f"- **{source.label}**")
        tree = build_doc_tree(source.md_files)
        render_doc_tree(tree, source.dir, "  ", lines, lambda route: route)

    readme_path = DOCS_DIR / "README.md"
    readme_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("  [生成] README.md (首页索引)")
```

3d. 用下面实现整体替换原 `generate_index_html` 的开头与标题部分（原第 3364–3447 行；其余 HTML 模板保持不变）：

```python
def generate_index_html(search_paths, namespace, title="文档中心"):
    """生成 index.html"""
    prism_lang_map_js = json.dumps(PRISM_LANG_FALLBACK, ensure_ascii=False)
    title_html = html.escape(title)
    title_js = json.dumps(title, ensure_ascii=False).replace("<", "\\u003c")
    html_text = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{title_html}</title>
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
      name: {title_js},
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
    index_path.write_text(html_text, encoding="utf-8")
    print(f"  [生成] index.html (搜索路径 {len(search_paths)} 条, namespace {namespace})")
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `python -m unittest discover -s tests -v`
Expected: 全部 `ok`。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat: 分组导航、首页与搜索索引生成"
```

---

### Task 8: 主流程整合

**Files:**
- Modify: `setup_docsify.py`（替换 `configure_paths`、`main`；删除 `preview_server_command`、旧 `download_assets`/`download_prism_components` 残留）
- Modify: `tests/test_setup_docsify.py`（追加 `EndToEndTests`）

- [ ] **Step 1: 写失败测试**

追加：

```python
class EndToEndTests(TempDirTestCase):
    def test_full_build_offline(self):
        root = self.make_source(
            "src", {"a.md": "# A\n\n```python\nprint(1)\n```", "sub/b.md": "# B"}
        )
        components = self.docs / "lib" / "components"
        components.mkdir(parents=True)
        for filename in self.module.ASSETS:
            (self.docs / "lib" / filename).write_text("x", encoding="utf-8")
        (components / "prism-python.min.js").write_text("x", encoding="utf-8")
        config = self.tmp / "md_sources.json"
        config.write_text(
            json.dumps({"title": "E2E", "sources": [{"path": str(root), "label": "文档"}]}),
            encoding="utf-8",
        )
        with mock.patch.object(self.module, "_download") as download:
            with redirect_stdout(io.StringIO()):
                self.module.main(
                    ["--config", str(config), "--output-docs", str(self.docs)]
                )
        download.assert_not_called()
        self.assertTrue((self.docs / "index.html").exists())
        self.assertTrue((self.docs / "_sidebar.md").exists())
        self.assertTrue((self.docs / "README.md").exists())
        self.assertTrue((self.docs / "search-index.json").exists())
        self.assertTrue((self.docs / "src" / "a.md").exists())
        self.assertIn(
            "<title>E2E</title>", (self.docs / "index.html").read_text(encoding="utf-8")
        )

    def test_index_only_skips_site_files(self):
        root = self.make_source("src", {"a.md": "# A"})
        config = self.tmp / "md_sources.json"
        config.write_text(
            json.dumps({"sources": [{"path": str(root)}]}), encoding="utf-8"
        )
        with redirect_stdout(io.StringIO()):
            self.module.main(
                [
                    "--config",
                    str(config),
                    "--output-docs",
                    str(self.docs),
                    "--index-only",
                ]
            )
        self.assertTrue((self.docs / "search-index.json").exists())
        self.assertFalse((self.docs / "index.html").exists())

    def test_empty_sources_raises(self):
        empty = self.tmp / "empty"
        empty.mkdir()
        config = self.tmp / "md_sources.json"
        config.write_text(
            json.dumps({"sources": [{"path": str(empty)}]}), encoding="utf-8"
        )
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                self.module.main(
                    ["--config", str(config), "--output-docs", str(self.docs)]
                )

    def test_full_build_multi_source(self):
        first = self.make_source("one", {"a.md": "# A"})
        second = self.make_source("two", {"sub/b.md": "# B"})
        components = self.docs / "lib" / "components"
        components.mkdir(parents=True)
        for filename in self.module.ASSETS:
            (self.docs / "lib" / filename).write_text("x", encoding="utf-8")
        config = self.tmp / "md_sources.json"
        config.write_text(
            json.dumps(
                {
                    "sources": [
                        {"path": str(first), "label": "甲"},
                        {"path": str(second), "label": "乙"},
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        with redirect_stdout(io.StringIO()):
            self.module.main(["--config", str(config), "--output-docs", str(self.docs)])
        self.assertTrue((self.docs / "one" / "a.md").exists())
        self.assertTrue((self.docs / "two" / "sub" / "b.md").exists())
        sidebar = (self.docs / "_sidebar.md").read_text(encoding="utf-8")
        self.assertIn("- **甲**", sidebar)
        self.assertIn("- **乙**", sidebar)
        index = json.loads((self.docs / "search-index.json").read_text(encoding="utf-8"))
        self.assertIn("/one/a.md", index)
        self.assertIn("/two/sub/b.md", index)

    def test_dependency_failure_exits(self):
        root = self.make_source("src", {"a.md": "# A"})
        config = self.tmp / "md_sources.json"
        config.write_text(
            json.dumps({"sources": [{"path": str(root)}]}), encoding="utf-8"
        )
        with mock.patch.object(self.module, "_download", return_value=False):
            with redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    self.module.main(
                        ["--config", str(config), "--output-docs", str(self.docs)]
                    )

    def test_sync_failure_exits(self):
        root = self.make_source("src", {"a.md": "# A"})
        components = self.docs / "lib" / "components"
        components.mkdir(parents=True)
        for filename in self.module.ASSETS:
            (self.docs / "lib" / filename).write_text("x", encoding="utf-8")
        config = self.tmp / "md_sources.json"
        config.write_text(
            json.dumps({"sources": [{"path": str(root)}]}), encoding="utf-8"
        )
        with mock.patch.object(
            self.module, "sync_sources", side_effect=self.module.BuildError("同步失败")
        ):
            with redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    self.module.main(
                        ["--config", str(config), "--output-docs", str(self.docs)]
                    )

    def test_unicode_error_exits(self):
        root = self.make_source("src", {"a.md": "# A"})
        (root / "bad.md").write_bytes(b"\xff\xfe\x00bad")
        components = self.docs / "lib" / "components"
        components.mkdir(parents=True)
        for filename in self.module.ASSETS:
            (self.docs / "lib" / filename).write_text("x", encoding="utf-8")
        config = self.tmp / "md_sources.json"
        config.write_text(
            json.dumps({"sources": [{"path": str(root)}]}), encoding="utf-8"
        )
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                self.module.main(
                    ["--config", str(config), "--output-docs", str(self.docs)]
                )
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python -m unittest discover -s tests -v`
Expected: `EndToEndTests` FAIL（旧 `main` 不认识 `--config`，且旧流程使用 `MD_DIR`）。

- [ ] **Step 3: 实现**

3a. 用下面实现整体替换原 `configure_paths`（原第 76–81 行附近）：

```python
def configure_paths(output_docs_dir: Path = None):
    """根据命令行参数更新输出目录与离线资源目录。"""
    global DOCS_DIR, LIB_DIR
    DOCS_DIR = _resolve_config_path(output_docs_dir, ROOT / "docs")
    LIB_DIR = DOCS_DIR / "lib"
```

3b. 删除 `preview_server_command`（原第 92–94 行附近）。

3c. 删除旧 `download_assets`（若任务 5 已替换为 `ensure_assets`，确认没有重复定义）与旧 `download_prism_components`（若任务 6 已替换，确认没有重复定义）。

3d. 用下面实现整体替换原 `main`（原第 3450–3502 行附近）：

```python
def main(argv=None):
    args = parse_args(argv)
    configure_paths(args.output_docs_dir)

    print("=== Docsify 离线文档站 构建工具 ===\n")
    try:
        title, specs = load_source_specs(args)
        sources = resolve_sources(specs, DOCS_DIR)
        assign_group_dirs(sources)
    except BuildError as error:
        print(f"  错误: {error}")
        sys.exit(1)

    print(f"输出文档站目录: {display_path(DOCS_DIR)}")
    print(f"站点标题: {title}")
    print("有效源:")
    for source in sources:
        print(
            f"  - {display_path(source.root)} -> /{source.dir}/ "
            f"({len(source.md_files)} 个文档, 标签: {source.label})"
        )
    print()

    try:
        if args.index_only:
            print("=== 仅刷新搜索索引（跳过依赖与站点文件生成） ===\n")
            print("1. 同步 Markdown 文件和图片...")
            sync_sources(sources, DOCS_DIR)
            print("2. 重新生成搜索索引与离线数据...")
            generate_search_index(sources, title)
            LIB_DIR.mkdir(parents=True, exist_ok=True)
            generate_offline_data()
            print("\n=== 搜索索引刷新完成 ===")
            return

        print("1. 检查离线依赖...")
        ensure_assets()
        patch_docsify_file_router()
        patch_docsify_css()
        ensure_prism_components(sources)
        generate_custom_search_assets()

        print("2. 同步 Markdown 文件和图片...")
        sync_sources(sources, DOCS_DIR)

        print("3. 生成导航、首页与搜索索引...")
        generate_sidebar(sources)
        generate_readme(sources, title)
        generate_search_index(sources, title)
        generate_offline_data()
        generate_index_html(
            collect_search_paths(sources),
            compute_search_namespace(sources),
            title,
        )

        print("\n=== 构建完成 ===")
        print("\n启动本地预览: python serve.py")
        print("本机打开: http://localhost:3000")
        print("局域网访问: http://<这台机器的IP>:3000")
    except (BuildError, OSError, UnicodeDecodeError) as error:
        print(f"  错误: {error}")
        sys.exit(1)
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `python -m unittest discover -s tests -v`
Expected: 全部 `ok`。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat: 整合多源构建主流程"
```

---

### Task 9: 跨平台预览

**Files:**
- Create: `serve.py`
- Create: `start_windows.bat`
- Create: `start_linux.sh`
- Modify: `tests/test_setup_docsify.py`（追加 `ServeTests`）

- [ ] **Step 1: 写失败测试**

追加：

```python
class ServeTests(unittest.TestCase):
    def test_server_serves_index(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-serve-"))
        try:
            (tmp / "index.html").write_text("ok", encoding="utf-8")
            server, port = serve.make_server(tmp, "127.0.0.1", 0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/index.html"
                ) as response:
                    self.assertEqual(response.read().decode("utf-8"), "ok")
            finally:
                server.shutdown()
                server.server_close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_parse_args_rejects_out_of_range_port(self):
        serve = load_module("serve", "serve.py")
        with self.assertRaises(SystemExit):
            serve.parse_args(["--port", "65536"])
        with self.assertRaises(SystemExit):
            serve.parse_args(["--port", "-1"])

    def test_make_server_falls_back_to_next_port(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-serve-"))
        try:
            (tmp / "index.html").write_text("ok", encoding="utf-8")
            blocker, port = serve.make_server(tmp, "127.0.0.1", 0)
            self.assertEqual(port, blocker.server_address[1])
            try:
                server, actual = serve.make_server(tmp, "127.0.0.1", port)
                try:
                    self.assertEqual(actual, port + 1)
                finally:
                    server.server_close()
            finally:
                blocker.server_close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_main_requires_index_html(self):
        serve = load_module("serve", "serve.py")
        tmp = Path(tempfile.mkdtemp(prefix="md2web-serve-"))
        try:
            with self.assertRaises(SystemExit):
                serve.main(["--dir", str(tmp), "--no-browser"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python -m unittest discover -s tests -v`
Expected: `ServeTests` ERROR（`No module named 'serve'` / 文件不存在）。

- [ ] **Step 3: 实现**

创建 `serve.py`：

```python
"""跨平台本地预览服务器：python serve.py [--port 3000] [--no-browser]"""

import argparse
import errno
import functools
import http.server
import os
import socket
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).parent


class PreviewServer(http.server.ThreadingHTTPServer):
    # Windows 的 SO_REUSEADDR 允许重复绑定同一端口，会掩盖端口占用检测
    allow_reuse_address = os.name != "nt"


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="启动 docs/ 本地预览服务")
    parser.add_argument(
        "--dir", dest="directory", type=Path, default=ROOT / "docs",
        help="要预览的目录，默认脚本同级的 docs/",
    )
    parser.add_argument("--port", type=int, default=3000, help="起始端口，默认 3000（0-65535）")
    parser.add_argument(
        "--bind", default="0.0.0.0",
        help="监听地址，默认 0.0.0.0（局域网可见；仅本机用 127.0.0.1）",
    )
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("端口必须在 0-65535 之间")
    return args


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return None


def make_server(directory, bind, port):
    """从 port 起连续尝试 20 个端口，返回 (server, 实际端口)。"""
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(directory)
    )
    last = min(port + 20, 65536)
    for candidate in range(port, last):
        try:
            server = PreviewServer((bind, candidate), handler)
        except OSError as error:
            if error.errno != errno.EADDRINUSE:
                raise SystemExit(f"错误: 无法监听 {bind}:{candidate} ({error})")
            continue
        return server, server.server_address[1]
    raise SystemExit(f"错误: 端口 {port}-{last - 1} 都被占用")


def main(argv=None):
    args = parse_args(argv)
    directory = args.directory.expanduser().resolve()
    if not (directory / "index.html").exists():
        raise SystemExit(f"错误: {directory} 下没有 index.html，请先运行 python setup_docsify.py")
    server, port = make_server(directory, args.bind, args.port)
    print(f"预览目录: {directory}")
    print(f"本机访问: http://localhost:{port}")
    ip = lan_ip()
    if ip and args.bind == "0.0.0.0":
        print(f"局域网访问: http://{ip}:{port}")
    print("按 Ctrl+C 停止")
    if not args.no_browser:
        timer = threading.Timer(0.5, webbrowser.open, args=(f"http://localhost:{port}",))
        timer.daemon = True
        timer.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
```

创建 `start_windows.bat`：

```bat
@echo off
cd /d "%~dp0"
python serve.py %*
if %errorlevel% equ 9009 py serve.py %*
```

创建 `start_linux.sh`：

```sh
#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then
  exec python3 serve.py "$@"
fi
exec python serve.py "$@"
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `python -m unittest discover -s tests -v`
Expected: 全部 `ok`（62 个用例）。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat: 新增跨平台预览 serve.py 与启动脚本"
```

---

### Task 10: README 重写与最终验证（含测试卫生清理）

**Files:**
- Modify: `README.md`（整体重写）
- Modify: `tests/test_setup_docsify.py`（两处测试卫生清理）
- Modify: `specs/2026-09-14-md2web-merged-multisource-plan.md`（同步 README 与测试块）
- Verify: 全部测试 + 真实目录离线冒烟构建

- [ ] **Step 1: 重写 README.md**

以 `README.md` 为整体重写目标（覆盖旧内容），基础稿如下（可小幅润色，但事实与命令必须一致）：

````markdown
# Markdown 离线文档站生成器（md2web）

把多个文件夹里的 Markdown 一键转换成**完全离线可用**的 Docsify 文档站：产物自包含，拷贝到任意机器双击即可浏览与搜索；需要 Python 3.8+，仅用标准库，无需 pip/Node.js，支持 Windows 与 Linux。

## 特性

- 多源合并：`md_sources.json` 配置任意多个源文件夹，合并为一个站点，统一浏览与搜索
- 完全离线：依赖保存在 `docs/lib/`，运行时零外部请求；依赖存在时重建全程不联网
- 预构建搜索：构建时生成全文索引，支持侧边栏搜索、`Ctrl+K` 全局搜索、标题锚点跳转
- 离线代码高亮：按文档实际用到的语言准备 Prism 组件，cuda/p4/asm 自动近似高亮
- 跨平台预览：`python serve.py` 一键启动，Windows/Linux 通用；也可直接双击 `docs/index.html`
- 镜像同步：源里删除的文件或文件夹不会在产物中残留

## 目录结构

```
md2web/
├── md/                       # 默认源（唯一需要手动维护的内容目录）
├── docs/                     # 唯一产物：站点 + 离线依赖，可单独分发
│   ├── lib/                  # 离线 JS/CSS 与生成资源
│   ├── index.html            # 站点入口（生成）
│   ├── README.md             # 站点首页（生成）
│   ├── _sidebar.md           # 侧边栏（生成）
│   ├── search-index.json     # 搜索索引（生成）
│   └── <分组>/…              # 从各源同步的文档
├── specs/                    # 设计文档
├── tests/                    # 离线回归测试
├── setup_docsify.py          # 构建入口
├── serve.py                  # 跨平台预览
├── start_windows.bat / start_linux.sh
├── md_sources.json           # 多源配置（可选）
└── README.md                 # 本文件
```

## 快速开始

### 1. 放文档

默认源为 `md/`，可任意组织子目录：

```
md/
├── 指南/
│   ├── 入门.md
│   └── images/flow.png
└── 常见问题.md
```

图片支持放在 `images/` 目录，或与文档同目录直接引用（`.png/.jpg/.jpeg/.gif/.svg/.webp/.bmp/.ico`）。

### 2. 配置多个文件夹（可选）

`md_sources.json`：

```json
{
  "title": "文档中心",
  "sources": [
    { "path": "md", "label": "文档", "dir": "md" },
    { "path": "D:/work/notes", "label": "工作笔记" },
    "E:/refs"
  ]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `title` | 否 | 站点标题，默认「文档中心」 |
| `path` | 是 | 源文件夹，相对配置文件所在目录或绝对路径 |
| `label` | 否 | 侧边栏/首页分组名，默认取文件夹名 |
| `dir` | 否 | 站点内分组目录，默认取文件夹名安全化结果 |

命令行参数（与配置文件叠加）：

| 场景 | 命令 |
|------|------|
| 默认构建 | `python setup_docsify.py` |
| 追加源（可重复） | `python setup_docsify.py --source-md D:/notes --source-md E:/refs` |
| 指定配置文件 | `python setup_docsify.py --config other.json` |
| 忽略配置文件 | `python setup_docsify.py --no-config` |
| 指定输出目录 | `python setup_docsify.py --output-docs site` |
| 仅刷新搜索索引 | `python setup_docsify.py --index-only` |

> 兼容旧用法：`python setup_docsify.py path/to/md path/to/docs`（位置参数指定源与输出）。
> `--index-only` 会镜像同步文档并刷新搜索索引与离线数据，但不会重建侧边栏与首页；新增文件要出现在导航中需执行一次完整构建。

### 3. 构建与预览

```bash
python setup_docsify.py     # 首次构建需联网下载依赖，之后离线可用
python serve.py             # 打开 http://localhost:3000
```

Windows 可双击 `start_windows.bat`，Linux 可执行 `sh start_linux.sh`。也可以直接双击 `docs/index.html`（file:// 模式，内容与索引内嵌）。

预览服务默认绑定 `0.0.0.0`，同一局域网内可访问，请勿在含敏感内容的文档站上使用；仅本机访问可执行 `python serve.py --bind 127.0.0.1`。用 `--output-docs site` 构建时，预览需执行 `python serve.py --dir site`。

### 4. 分发

只需要拷贝整个 `docs/` 目录；接收方双击 `docs/index.html` 或用任意静态服务器打开即可浏览、搜索、代码高亮。

## 测试

```bash
python -m unittest discover -s tests -v
```

测试全程离线（临时目录 + 伪依赖），覆盖配置解析、多源扫描与镜像同步、依赖复用与报错、导航/首页/搜索生成、主流程端到端与预览服务。

## 常见问题

- **搜索无结果或过时**：搜索索引在构建时生成，修改文档后重新运行 `python setup_docsify.py`
- **依赖缺失且下载失败**：联网重跑，或把完整依赖文件复制到 `docs/lib/`
- **图片不显示**：确认图片在源文件夹内且路径大小写正确，重新构建
- **代码块不高亮**：检查围栏语言标记；Prism 不支持的语言会按近似语法高亮
- **文件名限制**：文件名包含 `#`、`?`、`%` 时链接与搜索路由可能失效，请避免使用这些字符
- **想彻底重建**：删除 `docs/` 后重新构建（需要联网一次重新获取依赖）
````

- [ ] **Step 2: 测试卫生清理**

1. 测试文件导入行 `from contextlib import redirect_stdout` 改为 `from contextlib import redirect_stderr, redirect_stdout`。
2. `test_parse_args_rejects_out_of_range_port` 中两次 `assertRaises(SystemExit)` 分别用 `with redirect_stderr(io.StringIO()):` 包住（argparse 会把 usage/error 写到 stderr，保持测试输出干净）。
3. `test_make_server_falls_back_to_next_port` 中 `self.assertEqual(actual, port + 1)` 改为 `self.assertGreater(actual, port)`（避免依赖 port+1 恰好空闲）。
4. `test_main_requires_index_html` 用 `with redirect_stdout(io.StringIO()):` 包住 `serve.main(...)`。

- [ ] **Step 3: 运行完整测试**

Run: `python -m unittest discover -s tests -v`
Expected: 全部 `ok`（62 个用例）。

- [ ] **Step 4: 真实目录冒烟构建（离线）**

在临时目录构造两个源，并先把现有离线依赖复制到临时输出目录，确保全程无下载：

```powershell
New-Item -ItemType Directory -Force "$env:TEMP\md2web-smoke\src1\子目录", "$env:TEMP\md2web-smoke\src2", "$env:TEMP\md2web-smoke\out" | Out-Null
Set-Content "$env:TEMP\md2web-smoke\src1\a.md" "# A" -Encoding ASCII
Set-Content "$env:TEMP\md2web-smoke\src1\子目录\b.md" "# B" -Encoding ASCII
Set-Content "$env:TEMP\md2web-smoke\src2\c.md" "# C" -Encoding ASCII
Copy-Item docs\lib "$env:TEMP\md2web-smoke\out" -Recurse -Force
python setup_docsify.py --source-md "$env:TEMP\md2web-smoke\src1" --source-md "$env:TEMP\md2web-smoke\src2" --output-docs "$env:TEMP\md2web-smoke\out"
Get-ChildItem "$env:TEMP\md2web-smoke\out" | Select-Object Name
```

Expected: 输出 `构建完成`，依赖均为 `[复用]`；`out/` 下有 `index.html`、`README.md`、`_sidebar.md`、`search-index.json`、`lib`、`src1`、`src2`。

- [ ] **Step 5: 清理冒烟目录**

```powershell
Remove-Item "$env:TEMP\md2web-smoke" -Recurse -Force
```

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "docs: 重写 README 适配合并架构与多源用法"
```

---

## 完成标准

1. `python -m unittest discover -s tests -v` 全部通过（无网络访问）。
2. `docs/` 不再包含 webtool；依赖位于 `docs/lib/`。
3. 多源构建时 `docs/<dir>/` 分组正确，侧边栏、首页、搜索索引覆盖全部源。
4. 源内删除文件/文件夹后重建，产物无残留；过期分组自动清理且保留 `lib/`。
5. 依赖存在时构建零网络；缺失且下载失败时明确报错并列出清单。
6. `python serve.py` 在 Windows/Linux 均可预览；`docs/index.html` 可直接双击使用。
7. README 描述与实际行为一致。
