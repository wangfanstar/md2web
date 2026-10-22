import base64
import io
import unittest
from tests import test_server


class UploadLimitTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_server.AppTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)

    def test_upload_configuration_default_round_trip_and_validation(self):
        f = self.fixture
        self.assertEqual(f.config['uploads']['maxFileMB'], 500)
        payload = test_server.server_config.config_to_json(f.config)
        payload['uploads'] = {'maxFileMB': 12}
        loaded = test_server.server_config.save_config(f.config['path'], payload, f.docs)
        self.assertEqual(loaded['uploads']['maxFileMB'], 12)
        from server import config_profiles
        self.assertEqual(config_profiles.read_profile(f.docs, loaded['profile_name'])['uploads']['maxFileMB'], 12)
        for value in (0, 501, True, 1.5, '20'):
            payload['uploads']['maxFileMB'] = value
            with self.assertRaises(test_server.server_config.ConfigError):
                test_server.server_config.save_config(f.config['path'], payload, f.docs)

    def test_multipart_per_file_limit_and_base64_headroom_apply_live(self):
        f = self.fixture
        csrf = f.login()
        f.config['uploads'] = {'maxFileMB': 1}
        headers = {'X-CSRF-Token': csrf}
        data = b'x' * (1024 * 1024)
        response = f.client.post('/__references/upload', data={'kind':'pdf', 'file':[
            (io.BytesIO(data), 'at-limit.pdf'), (io.BytesIO(b'x'), 'small.pdf')]}, headers=headers)
        self.assertTrue(all(item['ok'] for item in response.get_json()['results']))
        response = f.client.post('/__references/upload', data={'kind':'pdf', 'file':
            (io.BytesIO(data + b'x'), 'too-big.pdf')}, headers=headers)
        self.assertFalse(response.get_json()['results'][0]['ok'])
        self.assertIn('1 MB', response.get_json()['results'][0]['error'])
        self.assertFalse((f.docs/'pdf/too-big.pdf').exists())
        response = f.client.post('/__feedback/attachment', json={'name':'data.pdf',
            'data':base64.b64encode(data).decode('ascii')}, headers=headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        response = f.client.post('/__feedback/attachment', json={'name':'large.pdf',
            'data':base64.b64encode(data + b'x').decode('ascii')}, headers=headers)
        self.assertEqual(response.status_code, 413)
        self.assertIn('1 MB', response.get_json()['error'])
        self.assertEqual(f.client.get('/__auth/session').get_json()['site']['uploads']['maxFileMB'], 1)
        response = f.client.post('/__feedback/attachment', data=b'x' * (3*1024*1024),
                                 content_type='application/json', headers=headers)
        self.assertEqual(response.status_code, 413)
        self.assertIn('分批', response.get_json()['error'])
