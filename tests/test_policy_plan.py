from test_server import AuthTests, server_auth


class PersistentPolicyTests(AuthTests):
    def test_disable_then_enable_cannot_restore_old_session(self):
        login = self.auth.login('alice', 'good', 'same-ip', remember=True)
        entry = dict(authSourceId=self.auth.auth_source_id, username='alice', role='user', enabled=False)
        self.config['authorization'] = {'users': [entry]}
        self.auth.on_config_changed()
        entry['enabled'] = True
        self.auth.on_config_changed()
        self.assertIsNone(self.auth.resolve(login['token']))

    def test_remember_session_survives_restart_but_normal_does_not(self):
        kept = self.auth.login('alice', 'good', 'same-ip', remember=True)
        ordinary = self.auth.login('bob', 'good', 'same-ip')
        restarted = server_auth.AuthService(self.conn, self.svn, self.config)
        restarted.on_startup()
        self.assertIsNotNone(restarted.resolve(kept['token']))
        self.assertIsNone(restarted.resolve(ordinary['token']))

    def test_permissions_apply_on_each_request_and_auth_source_revokes_admin(self):
        login = self.auth.login('alice', 'good', 'same-ip')
        policy = dict(authSourceId=self.auth.auth_source_id, username='alice', role='admin', enabled=True)
        self.config['authorization'] = {'users': [policy]}
        self.assertEqual(self.auth.resolve(login['token'])['user']['role'], 'admin')
        policy['enabled'] = False
        self.assertIsNone(self.auth.resolve(login['token']))
        policy['enabled'] = True
        login = self.auth.login('alice', 'good', 'same-ip')
        self.auth.revoke_svn_sessions()
        self.assertIsNone(self.auth.resolve(login['token']))
