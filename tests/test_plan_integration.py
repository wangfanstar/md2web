import hashlib
import json
import threading
from unittest import mock
from test_server import ServerTestBase, FakeSvn, server_config, server_database, server_auth
from server import policy, repository_rename, local_history
from server.cache import MetadataCache, static_policy


class PlanIntegrationTests(ServerTestBase):
    def setUp(self):
        super().setUp()
        self.config = server_config.load_config(self.write_config({'repositories': [
            {'id': 'stable', 'mount': 'md/old', 'sourceMode': 'local', 'displayName': 'Display'}]}), self.docs)
        self.conn = server_database.connect(self.tmp/'data/db.sqlite3')
        server_database.migrate(self.conn)
        server_database.ensure_admin(self.conn)
        self.auth = server_auth.AuthService(self.conn, FakeSvn(), self.config)
        from server.app import create_app
        self.app = create_app(self.config, self.conn, self.auth, self.docs)
        self.client = self.app.test_client()
        (self.docs/'md/old').mkdir()
        (self.docs/'md/old/a.md').write_text('current', encoding='utf-8')

    def tearDown(self):
        self.conn.close()
        super().tearDown()

    def admin(self):
        data = self.client.post('/__auth/login', json={'username':'admin','password':'admin','rememberSession':True}).get_json()
        return {'X-CSRF-Token': data['csrfToken']}

    def rename_payload(self):
        return dict(repositoryId='stable', newName='new', expectedMount='md/old',
                    expectedConfigVersion=policy.version(server_config.config_to_json(self.config)), requestId='a'*32)

    def test_rename_preserves_history_identity_and_is_idempotent(self):
        with self.conn:
            local_history.record(self.conn, 'md/old/a.md', 'before', 'current', None)
        data = self.rename_payload()
        result = repository_rename.rename(self.config,self.conn,self.auth._db_lock,self.docs,data)
        self.assertEqual(result['id'],'stable')
        self.assertTrue((self.docs/'md/new/a.md').exists())
        self.assertEqual(self.conn.execute('SELECT path FROM local_document_versions LIMIT 1').fetchone()[0], 'md/new/a.md')
        self.assertEqual(self.config['pathAliases']['md/old'],'md/new')
        self.assertEqual(repository_rename.rename(self.config,self.conn,self.auth._db_lock,self.docs,data),result)

    def test_rename_config_failure_restores_directory_and_history(self):
        with self.conn:
            local_history.record(self.conn,'md/old/a.md','before','current',None)
        with mock.patch('server.config.save_config', side_effect=OSError('injected')):
            with self.assertRaises(OSError):
                repository_rename.rename(self.config,self.conn,self.auth._db_lock,self.docs,self.rename_payload())
        self.assertTrue((self.docs/'md/old/a.md').exists())
        self.assertFalse((self.docs/'md/new').exists())
        self.assertEqual(self.conn.execute('SELECT path FROM local_document_versions LIMIT 1').fetchone()[0], 'md/old/a.md')

    def test_permission_api_and_recovery_admin_protection(self):
        self.auth.login('alice','good','same-ip')
        headers=self.admin()
        self.assertEqual(self.client.post('/__admin/users/permission',json={}).status_code,403)
        version=self.client.get('/__admin/users').get_json()['expectedConfigVersion']
        payload=dict(authSourceId=self.auth.auth_source_id,username='alice',role='admin',enabled=True,expectedConfigVersion=version)
        response=self.client.post('/__admin/users/permission',json=payload,headers=headers)
        self.assertEqual(response.status_code,200,response.get_json())
        self.assertEqual(self.client.post('/__admin/users/permission',json=payload,headers=headers).status_code,409)
        payload.update(authSourceId='local-admin',username='admin',enabled=False,expectedConfigVersion=response.get_json()['expectedConfigVersion'])
        self.assertEqual(self.client.post('/__admin/users/permission',json=payload,headers=headers).status_code,400)
        loaded=server_config.load_config(self.config['path'],self.docs)
        self.assertEqual(loaded['authorization']['users'][0]['role'],'admin')

    def test_shared_ip_does_not_share_device_hint(self):
        self.client.post('/__auth/login',json={'username':'alice','password':'good','rememberUsername':True})
        self.assertEqual(self.client.get('/__auth/login-hint').get_json()['username'],'alice')
        self.assertEqual(self.app.test_client().get('/__auth/login-hint').get_json()['username'],'')

    def test_compare_path_validation_and_private_cache(self):
        with self.conn:
            local_history.record(self.conn,'md/old/a.md','before','current',None)
        self.admin()
        good=self.client.get('/__md/compare?path=md/old/a.md&left=local:1&right=published')
        self.assertEqual(good.status_code,200,good.get_json())
        self.assertEqual(good.get_json()['left']['content'],'before')
        self.assertEqual(good.headers['Cache-Control'],'private, no-store')
        self.assertEqual(self.client.get('/__md/compare?path=md/old/other.md&left=local:1').status_code,404)

    def test_cache_bounds_ttl_and_version_validation(self):
        clock=[0]
        cache=MetadataCache(2,100,10,lambda:clock[0])
        calls=[]
        compute=lambda: calls.append(1) or 'value'
        self.assertEqual(cache.get_or_compute('a',compute),'value')
        cache.get_or_compute('a',compute)
        self.assertEqual(len(calls),1)
        clock[0]=11
        cache.get_or_compute('a',compute)
        self.assertEqual(len(calls),2)
        for i in range(8):cache.get_or_compute(i,lambda:'x'*30)
        self.assertLessEqual(len(cache.items),2)
        self.assertLessEqual(cache.bytes,100)
        path=self.docs/'test.js';path.write_text('hello')
        self.assertEqual(static_policy(path,'wrong'),'no-cache')
        self.assertIn('immutable',static_policy(path,hashlib.sha1(path.read_bytes()).hexdigest()[:10]))
