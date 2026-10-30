import json
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from server import config, config_profiles as profiles


class ConfigProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.docs = self.root / 'docs'
        (self.docs / 'md').mkdir(parents=True)
        self.path = self.root / 'config' / 'server.local.json'
        self.loaded = config.save_config(self.path, config.default_config(), self.docs)

    def tearDown(self):
        self.temp.cleanup()

    def test_mirror_excludes_secrets_and_runtime_paths(self):
        data = json.loads((self.docs / 'html/md2web_config.json').read_text(encoding='utf-8'))
        self.assertNotIn('security', data)
        self.assertNotIn('storage', data)
        self.assertNotIn('server', data)
        self.assertIn('credentials', data)

    def test_switch_save_and_restore_keep_runtime_identity(self):
        key = self.loaded['security']['secretKey']
        alternate = profiles.select(self.loaded, self.docs, 'md2web_config_lab.json', create=True)
        payload = config.config_to_json(alternate)
        payload['folderGroups'] = {'md/lab': '实验室'}
        alternate = config.save_config(self.path, payload, self.docs, create_mounts=False)
        mirror = self.docs / 'html/md2web_config_lab.json'
        self.assertEqual(json.loads(mirror.read_text(encoding='utf-8'))['folderGroups'], {'md/lab': '实验室'})
        base = profiles.select(alternate, self.docs, 'md2web_config.json')
        self.assertEqual(base['folder_groups'], {})
        restored = profiles.select(base, self.docs, 'md2web_config_lab.json')
        self.assertEqual(restored['folder_groups'], {'md/lab': '实验室'})
        self.assertEqual(restored['security']['secretKey'], key)
        self.assertEqual(restored['storage']['database'], self.loaded['storage']['database'])

    def test_recover_missing_configuration_and_mirror(self):
        self.path.unlink()
        (self.docs / 'html/md2web_config.json').unlink()
        self.assertTrue(profiles.recover_runtime(self.path, self.docs))
        recovered = config.load_config(self.path, self.docs, allow_incomplete=True)
        self.assertEqual(recovered['security']['secretKey'], self.loaded['security']['secretKey'])
        restored = profiles.select(recovered, self.docs, profiles.DEFAULT_NAME)
        self.assertEqual(restored['profile_name'], profiles.DEFAULT_NAME)
        self.assertTrue((self.docs / 'html/md2web_config.json').exists())

    def test_invalid_names_and_secret_import_rejected(self):
        for name in ('../server.local.json', 'search-index.json', 'md2web_config/evil.json'):
            with self.assertRaises(config.ConfigError):
                profiles.select(self.loaded, self.docs, name, create=True)
        mirror = self.docs / 'html/md2web_config_bad.json'
        mirror.write_text('{"security":{"secretKey":"untrusted"}}', encoding='utf-8')
        with self.assertRaises(config.ConfigError):
            profiles.select(self.loaded, self.docs, mirror.name)
        self.assertEqual(config.load_config(self.path, self.docs, allow_incomplete=True)['security']['secretKey'],
                         self.loaded['security']['secretKey'])

    def test_previous_version_is_recoverable(self):
        payload = config.config_to_json(self.loaded)
        payload['folderGroups'] = {'md/lab': 'new'}
        updated = config.save_config(self.path, payload, self.docs, create_mounts=False)
        restored = profiles.restore_previous(updated, self.docs)
        self.assertEqual(restored['folder_groups'], {})

    def test_failed_mirror_write_does_not_switch_or_lose_previous_config(self):
        before = self.path.read_bytes()
        original = profiles.atomic_json
        def fail_mirror(path, data):
            if path.parent == self.docs / 'html':
                raise OSError('disk full')
            return original(path, data)
        with mock.patch.object(profiles, 'atomic_json', side_effect=fail_mirror):
            with self.assertRaises(config.ConfigError):
                profiles.select(self.loaded, self.docs, 'md2web_config_fail.json', create=True)
        self.assertEqual(before, self.path.read_bytes())
        self.assertFalse((profiles.private_dir(self.docs) / 'md2web_config_fail.json').exists())

    def test_new_runtime_does_not_overwrite_existing_profile(self):
        mirror = self.docs / 'html/md2web_config.json'
        data = json.loads(mirror.read_text(encoding='utf-8'))
        data['folderGroups'] = {'md/lab': '保留配置'}
        mirror.write_text(json.dumps(data), encoding='utf-8')
        fresh = config.save_config(self.path, config.default_config(), self.docs, sync_profiles=False)
        restored = profiles.initialize(fresh, self.docs)
        self.assertEqual(restored['folder_groups'], {'md/lab': '保留配置'})

    def test_plaintext_credentials_auth_and_ai_round_trip_without_public_leak(self):
        payload = config.config_to_json(self.loaded)
        payload['credentials'] = {'__default__': {'username': 'test-user', 'password': ' test password '}}
        payload['auth']['url'] = 'https://svn.example.com/auth'
        payload['ai']['claude']['timeoutSeconds'] = 88
        saved = config.save_config(self.path, payload, self.docs)
        data = profiles.read_profile(self.docs, profiles.DEFAULT_NAME)
        self.assertEqual(data['credentials']['__default__']['password'], ' test password ')
        self.assertEqual(data['auth']['url'], payload['auth']['url'])
        self.assertEqual(data['ai']['claude']['timeoutSeconds'], 88)
        restored = profiles.initialize(saved, self.docs)
        self.assertEqual(restored['credentials'], payload['credentials'])
        self.assertNotIn('test password', json.dumps(config.public_config(restored)))

    def test_startup_recovers_malformed_profile_from_last_saved_copy(self):
        mirror = self.docs / 'html/md2web_config.json'
        mirror.write_text('{broken', encoding='utf-8')
        restored = profiles.initialize(self.loaded, self.docs)
        self.assertEqual(restored['folder_groups'], {})
        self.assertEqual((profiles.private_dir(self.docs) / 'md2web_config.json.rejected').read_text(encoding='utf-8'), '{broken')
        self.assertEqual(profiles.read_profile(self.docs, profiles.DEFAULT_NAME)['folderGroups'], {})

    def test_listing_exposes_three_preset_profiles_with_labels(self):
        result = profiles.listing(self.loaded, self.docs)
        names = [item['name'] for item in result['profiles']]
        for preset in profiles.PRESET_NAMES:
            self.assertIn(preset, names)
        labels = {item['name']: item['label'] for item in result['profiles']}
        self.assertEqual(labels['md2web_config_default.json'], '默认配置')
        self.assertEqual(labels['md2web_config_backup.json'], '备份配置')
        for preset in ('md2web_config_default.json', 'md2web_config_backup.json'):
            self.assertTrue((self.docs / 'html' / preset).is_file())
            self.assertTrue((profiles.private_dir(self.docs) / preset).is_file())
        # 三套预设都能被选中加载
        for preset in profiles.PRESET_NAMES:
            self.assertEqual(profiles.select(self.loaded, self.docs, preset)['profile_name'], preset)

    def test_existing_preset_files_are_not_overwritten(self):
        mirror = self.docs / 'html/md2web_config_backup.json'
        data = profiles.profile_data(self.loaded)
        data['folderGroups'] = {'md/keep': '保留'}
        mirror.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        profiles.ensure_presets(self.loaded, self.docs)
        self.assertEqual(json.loads(mirror.read_text(encoding='utf-8'))['folderGroups'], {'md/keep': '保留'})


if __name__ == '__main__':
    unittest.main()
