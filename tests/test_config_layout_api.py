from test_plan_integration import PlanIntegrationTests
from server.app import create_app


class ConfigLayoutApiTests(PlanIntegrationTests):
    def test_save_distinguishes_config_commit_from_failed_rebuild(self):
        app = create_app(self.config, self.conn, self.auth, self.docs, on_config_changed=lambda: False)
        client = app.test_client()
        login = client.post('/__auth/login', json={'username': 'admin', 'password': 'admin'}).get_json()
        payload = client.get('/__config').get_json()['config']
        payload['ai']['model'] = 'saved-despite-build-error'
        response = client.put('/__config', json=payload, headers={'X-CSRF-Token': login['csrfToken']})
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertFalse(response.get_json()['rebuilt'])
        self.assertEqual(client.get('/__config').get_json()['config']['ai']['model'], 'saved-despite-build-error')

    def test_stale_profile_application_does_not_overwrite_current_config(self):
        headers = self.admin()
        response = self.client.post('/__config/profiles', headers=headers,
                                    json={'action': 'select', 'name': 'md2web_config_default.json',
                                          'expectedConfigVersion': 'outdated'})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.config['repositories'][0]['id'], 'stable')

    def test_profile_preview_does_not_apply_configuration(self):
        self.admin()
        self.assertEqual(self.client.get('/__config/profiles').status_code, 200)
        before = self.client.get('/__config').get_json()['config']
        response = self.client.get('/__config/profile-content?name=md2web_config_default.json')
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(before, self.client.get('/__config').get_json()['config'])
