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
