"""Harness tests only; these do not substitute for the live boundary suite."""
import contextlib
import io
import os
import unittest
from unittest.mock import Mock, patch

import requests
import authz_check as authz


class AuthorizationHarnessTests(unittest.TestCase):
    def setUp(self):
        self.suite = authz.BoundaryChecks("https://app.example", "https://db.example", "anon", "service")

    def test_no_fallback_to_application_credentials(self):
        with patch.object(authz, "load_dotenv"), patch.dict(os.environ, {
            "NEXT_PUBLIC_SUPABASE_URL": "https://production.example", "SUPABASE_SERVICE_ROLE_KEY": "production"
        }, clear=True), self.assertRaises(authz.CheckFailed):
            authz.configuration()

    def test_configuration_rejects_insecure_or_credential_bearing_urls(self):
        for url in ("http://app.example", "https://user:password@app.example", "https://app.example/path",
                    "https://app.example?secret=token", "https://app.example#fragment"):
            with self.subTest(url=url), patch.object(authz, "load_dotenv"), patch.dict(os.environ, {
                "AUTHZ_APP_URL": url, "AUTHZ_SUPABASE_URL": "https://db.example",
                "AUTHZ_SUPABASE_ANON_KEY": "anon", "AUTHZ_SUPABASE_SERVICE_ROLE_KEY": "service"
            }, clear=True), self.assertRaises(authz.CheckFailed):
                authz.configuration()

    @patch.object(authz.requests, "request")
    def test_probes_do_not_use_service_role_or_follow_redirects(self, request):
        self.suite.request("GET", "/rest/v1/projects", "user")
        kwargs = request.call_args.kwargs
        self.assertEqual(kwargs["headers"], {"apikey": "anon", "Authorization": "Bearer user"})
        self.assertFalse(kwargs["allow_redirects"])
        self.assertEqual(kwargs["timeout"], 30)
        self.suite.request("GET", "/api/projects", "user", app=True)
        self.assertEqual(request.call_args.kwargs["headers"], {"Authorization": "Bearer user"})
        self.suite.request("GET", "/rest/v1/projects")
        self.assertEqual(request.call_args.kwargs["headers"], {"apikey": "anon"})

    def test_only_permission_errors_pass_rpc_denial(self):
        for status, code in ((404, "PGRST202"), (400, "22P02"), (500, "42501"), (401, "PGRST301"), (200, None)):
            with self.subTest(status=status, code=code), self.assertRaises(authz.CheckFailed):
                self.suite.denied(Mock(status_code=status, json=lambda: {"code": code}), "RPC")
        self.suite.denied(Mock(status_code=403, json=lambda: {"code": "42501"}), "RPC")

    def test_owner_positive_control_rejects_universal_denial(self):
        with self.assertRaises(authz.CheckFailed):
            self.suite.expect(Mock(status_code=401), 200, "Owner read")

    def test_victim_snapshot_detects_denied_write_side_effects(self):
        self.suite.users = [{"id": "a"}, {"id": "b"}]
        with contextlib.ExitStack() as stack:
            for method in ("setup", "anonymous_checks", "app_checks", "database_checks", "storage_checks", "rpc_checks"):
                stack.enter_context(patch.object(self.suite, method))
            stack.enter_context(patch.object(self.suite, "snapshot", side_effect=[{"data": "intact"}, {"data": "changed"}]))
            with self.assertRaisesRegex(authz.CheckFailed, "Foreign fixture changed"):
                self.suite.run()

    def test_network_errors_do_not_disclose_signed_tokens(self):
        with patch.object(authz.requests, "request", side_effect=requests.ConnectionError("URL?token=secret")):
            with self.assertRaises(authz.CheckFailed) as caught:
                self.suite.request("PUT", "/upload?token=secret")
        self.assertNotIn("secret", str(caught.exception))

    def test_cleanup_continues_after_failures_and_is_fixture_scoped(self):
        self.suite.users = [{"id": "user-a"}, {"id": "user-b"}]
        self.suite.paths = ["user-a/project/doc/authz.txt"]
        with patch.object(self.suite, "request", side_effect=[authz.CheckFailed("network"), Mock(status_code=500),
                          Mock(status_code=204), Mock(status_code=200), Mock(status_code=200)]) as request:
            self.assertEqual(len(self.suite.cleanup()), 2)
        self.assertEqual(request.call_count, 5)
        self.assertEqual(request.call_args_list[1].kwargs["params"], {"user_id": "eq.user-a"})
        self.assertEqual(request.call_args_list[2].kwargs["params"], {"user_id": "eq.user-b"})

    def test_probe_failure_always_cleans_up_and_exits_nonzero(self):
        with patch.object(authz, "configuration", return_value=("app", "db", "anon", "service")), \
             patch.object(authz, "BoundaryChecks") as constructor, contextlib.redirect_stdout(io.StringIO()):
            constructor.return_value.run.side_effect = authz.CheckFailed("denial failed")
            constructor.return_value.cleanup.return_value = []
            self.assertEqual(authz.main(), 1)
            constructor.return_value.cleanup.assert_called_once()

    def test_cleanup_failure_prevents_success(self):
        with patch.object(authz, "configuration", return_value=("app", "db", "anon", "service")), \
             patch.object(authz, "BoundaryChecks") as constructor, contextlib.redirect_stdout(io.StringIO()) as output:
            constructor.return_value.cleanup.return_value = ["HTTP 500"]
            self.assertEqual(authz.main(), 1)
            self.assertNotIn("PASS:", output.getvalue())


if __name__ == "__main__":
    unittest.main()
