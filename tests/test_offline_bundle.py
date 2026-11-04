"""Guards for a fully self-contained offline installation.

The deployed tree is often copied to a server without internet access.  Every
browser asset and Python wheel needed by a supported interpreter therefore has
to be committed, not merely downloadable at build time.
"""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class OfflineBundleTests(unittest.TestCase):
    def test_all_registered_assets_are_present(self):
        import setup_docsify
        missing = []
        for name in setup_docsify.ASSETS:
            path = ROOT / "docs" / "lib" / name
            if not path.is_file() or path.stat().st_size == 0:
                missing.append(name)
        self.assertEqual(missing, [], "缺少离线资源: " + ", ".join(missing))

    def test_prism_bundle_covers_every_known_language(self):
        import setup_docsify
        deps, aliases = setup_docsify.extract_autoloader_maps()
        names = (set(deps) | set(aliases.values()) |
                 set(setup_docsify.FALLBACK_PRISM_DEPS) |
                 set(setup_docsify.FALLBACK_PRISM_ALIASES.values()))
        components = ROOT / "docs" / "lib" / "components"
        missing = [name for name in sorted(names)
                   if name not in setup_docsify.PRISM_CORE_LANGS
                   and not (components / ("prism-%s.min.js" % name)).is_file()]
        self.assertEqual(missing, [], "缺少 Prism 语言组件: " + ", ".join(missing))
        # json 是实际部署中曾缺失的组件，保留显式回归。
        self.assertTrue((components / "prism-json.min.js").is_file())
        self.assertGreaterEqual(len(list(components.glob("prism-*.min.js"))), 250)

    def test_current_documents_have_all_prism_components(self):
        import setup_docsify
        md_files = setup_docsify.scan_markdown(setup_docsify.MD_DIR, allow_empty=True)
        languages = setup_docsify.collect_fence_languages(setup_docsify.MD_DIR, md_files)
        deps, aliases = setup_docsify.extract_autoloader_maps()
        needed = setup_docsify.resolve_prism_languages(languages, deps, aliases)
        missing = [name for name in needed
                   if not (ROOT / "docs" / "lib" / "components" / ("prism-%s.min.js" % name)).is_file()]
        self.assertEqual(missing, [])

    def test_markupsafe_wheels_cover_supported_pythons_and_platforms(self):
        requirement = (ROOT / "server" / "requirements.txt").read_text(encoding="ascii")
        self.assertIn('MarkupSafe==2.0.1; python_version < "3.11"', requirement)
        self.assertIn('MarkupSafe==2.1.5; python_version >= "3.11"', requirement)
        wheels = [path.name.lower() for path in (ROOT / "server" / "wheels").glob("*.whl")]
        expected = []
        for tag in ("cp36-cp36m", "cp37-cp37m", "cp38-cp38", "cp39-cp39", "cp310-cp310"):
            expected.append(("markupsafe-2.0.1-" + tag.lower() + "-manylinux", tag))
            expected.append(("markupsafe-2.0.1-" + tag.lower() + "-win_amd64", tag))
        for tag in ("cp311-cp311", "cp312-cp312"):
            expected.append(("markupsafe-2.1.5-" + tag.lower() + "-manylinux", tag))
            expected.append(("markupsafe-2.1.5-" + tag.lower() + "-win_amd64", tag))
        missing = [prefix for prefix, _ in expected
                   if not any(wheel.startswith(prefix) for wheel in wheels)]
        self.assertEqual(missing, [], "离线 wheel 缺少: " + ", ".join(missing))


if __name__ == "__main__":
    unittest.main()
