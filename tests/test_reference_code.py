import tempfile
import unittest
from pathlib import Path
from unittest import mock
from server import reference_code
from tests.test_server import AppTests

class ReferenceCodeTests(unittest.TestCase):
    def test_paths_and_text(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / 'a.c').write_text('int main() {}', encoding='utf-8')
            self.assertEqual(reference_code.text(reference_code.safe_path(root, 'a.c')), 'int main() {}')
            for path in ('../secret', '/etc/passwd', '.git/config', 'GTAGS', 'a\\b'):
                with self.assertRaises(ValueError):
                    reference_code.safe_path(root, path)

    def test_gtags_missing_is_nonfatal(self):
        with mock.patch('server.reference_code.shutil.which', return_value=None):
            self.assertIn('gtags', reference_code.build_index(Path('.')))

    def test_authenticated_browse_and_search(self):
        fixture = AppTests()
        fixture.setUp()
        try:
            fixture.config['ai']['claude'] = {'repositories': [{'id': 'repo', 'folder': 'repo'}]}
            root = fixture.docs / 'code' / 'repo'
            root.mkdir(parents=True)
            (root / 'main.c').write_text('int main() {return 0;}\n', encoding='utf-8')
            self.assertEqual(fixture.client.get('/__code/repos').status_code, 401)
            fixture.login()
            self.assertEqual(fixture.client.get('/__code/file?repo=repo&path=main.c').status_code, 200)
            data = fixture.client.get('/__code/search?repo=repo&q=return&mode=text').get_json()
            self.assertEqual(data['hits'][0]['line'], 1)
            self.assertEqual(fixture.client.get('/__code/file?repo=repo&path=../secret').status_code, 400)
        finally:
            fixture.tearDown()
