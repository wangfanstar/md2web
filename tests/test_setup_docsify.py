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
from unittest import mock

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

    def test_load_config_read_error(self):
        with self.assertRaises(self.module.BuildError):
            self.module.load_config_file(self.tmp)

    def test_parse_args_repeatable_sources(self):
        args = self.module.parse_args(["a", "--source-md", "b", "--md-dir", "c"])
        self.assertEqual(
            args.source_md_dirs, [Path("a"), Path("b"), Path("c")]
        )

    def test_parse_args_defaults(self):
        args = self.module.parse_args([])
        self.assertEqual(args.source_md_dirs, [])
        self.assertIsNone(args.output_docs_dir)
        self.assertIsNone(args.config_path)
        self.assertFalse(args.no_config)
        self.assertFalse(args.index_only)

    def test_parse_args_output_conflict(self):
        with self.assertRaises(SystemExit):
            self.module.parse_args(["src", "--output-docs", "out1", "out2"])


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

        def fake_urlretrieve(url, filename):
            Path(filename).write_bytes(b"data")

        with mock.patch.object(self.module.urllib.request, "urlretrieve", fake_urlretrieve):
            self.assertTrue(self.module._download("https://example.invalid/x.js", dest))
        self.assertEqual(dest.read_bytes(), b"data")
        self.assertFalse((self.tmp / "out.js.part").exists())
