import json
import unittest
from tests import test_server


class UserAiTests(unittest.TestCase):
    def setUp(self):
        self.f = test_server.AppTests()
        self.f.setUp()
        self.addCleanup(self.f.tearDown)

    def test_personal_configuration_is_retired(self):
        f = self.f
        self.assertEqual(f.client.get('/__ai/config').status_code, 401)
        csrf = f.login()
        for method in ('get', 'put', 'delete'):
            response = getattr(f.client, method)('/__ai/config', headers={'X-CSRF-Token': csrf})
            self.assertEqual(response.status_code, 410)
        self.assertEqual(f.conn.execute('SELECT COUNT(*) FROM user_ai_configs').fetchone()[0], 0)

    def test_admin_ai_endpoint_rejects_legacy_fields(self):
        f = self.f
        test_server.server_database.ensure_admin(f.conn)
        f.client.post('/__auth/login',json={'username':'admin','password':'admin','mode':'admin'})
        csrf=f.client.get('/__auth/session').get_json()['csrfToken']
        response=f.client.put('/__admin/ai',json={'contextChars':'bad'},headers={'X-CSRF-Token':csrf})
        self.assertEqual(response.status_code,400,response.get_json())
        self.assertEqual(response.get_json()['code'],'unknown_ai_field')
