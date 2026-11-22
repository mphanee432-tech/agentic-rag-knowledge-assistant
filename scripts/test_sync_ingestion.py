import unittest
import os
import io
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

import sync_ingestion as sync

READY = {key: True for key in ("extensions_ready", "claim_ready", "failure_ready", "finish_ready",
                             "recovery_ready", "retry_columns_ready", "private_bucket_ready", "enterprise_upload_ready")}


class SyncIngestionTests(unittest.TestCase):
    def test_sql_literal_quotes_values(self):
        self.assertEqual(sync.literal("secret'with-quote"), "'secret''with-quote'")

    @patch.object(sync.requests, "get")
    def test_tunnel_must_forward_to_app_port(self, get):
        get.return_value.json.return_value = {"tunnels": [
            {"public_url": "https://unrelated.example", "config": {"addr": "http://localhost:4000"}},
            {"public_url": "https://app.example", "config": {"addr": "http://localhost:3000"}},
        ]}
        self.assertEqual(sync.tunnel_url(), "https://app.example")
        get.return_value.json.return_value["tunnels"].append(
            {"public_url": "https://second.example", "config": {"addr": "http://localhost:3000"}})
        with self.assertRaises(RuntimeError):
            sync.tunnel_url()

    @patch.object(sync.requests, "post")
    def test_sql_failures_never_echo_secret_bearing_responses(self, post):
        post.return_value = Mock(ok=False, status_code=400, text="secret from SQL error")
        with self.assertRaises(RuntimeError) as caught:
            sync.query("ref", "token", "select 'secret'")
        self.assertNotIn("secret", str(caught.exception))
        self.assertFalse(post.call_args.kwargs["allow_redirects"])

    def test_scoped_projects_never_fall_back_to_classic(self):
        with patch.dict(os.environ, {"NEXT_PUBLIC_SUPABASE_URL": "https://classic.supabase.co"}, clear=True):
            with self.assertRaises(RuntimeError):
                sync.project_ref("personal")
        for workspace, (ref, _) in sync.AGENTIC_PROJECTS.items():
            with patch.dict(os.environ, {f"NEXT_PUBLIC_{workspace.upper()}_SUPABASE_URL": f"https://{ref}.supabase.co"}, clear=True):
                self.assertEqual(sync.project_ref(workspace), ref)

    def test_workspace_urls_require_public_https(self):
        for workspace in sync.AGENTIC_PROJECTS:
            self.assertEqual(sync.webhook_url("https://app.example/", workspace),
                             f"https://app.example/api/webhooks/storage?workspace={workspace}")
        for base in ("http://app.example", "https://localhost", "https://user:secret@app.example", "https://app.example/path", "https://app.example?token=x"):
            with self.subTest(base=base), self.assertRaises(RuntimeError):
                sync.webhook_url(base, "personal")

    @patch.object(sync.requests, "get")
    def test_identity_guard_rejects_classic_before_queries(self, get):
        with self.assertRaises(RuntimeError):
            sync.verify_project("personal", "classic", "token")
        get.assert_not_called()
        ref, _ = sync.AGENTIC_PROJECTS["personal"]
        get.return_value = Mock(ok=True)
        get.return_value.json.return_value = {"id": ref, "name": "Classic RAG"}
        with self.assertRaises(RuntimeError):
            sync.verify_project("personal", ref, "token")

    @patch.object(sync, "verify_project")
    @patch.object(sync, "query")
    def test_partial_schema_is_rejected_before_any_mutation(self, query, verify):
        query.return_value = [{"extensions_ready": True, "retry_columns_ready": False, "enterprise_upload_ready": False}]
        with self.assertRaises(RuntimeError):
            sync.synchronize("personal", "ref", "token", sync.webhook_url("https://app.example", "personal"), "secret")
        self.assertEqual(query.call_count, 1)

    @patch.object(sync, "verify_project")
    @patch.object(sync, "query")
    def test_enterprise_missing_authorization_is_not_repaired_by_dispatch_setup(self, query, verify):
        query.return_value = [{**READY, "enterprise_upload_ready": False}]
        with self.assertRaisesRegex(RuntimeError, "authorization RPCs"):
            sync.synchronize("enterprise", "ref", "token", sync.webhook_url("https://app.example", "enterprise"), "secret")
        self.assertEqual(query.call_count, 1)

    @patch.object(sync, "verify_project")
    @patch.object(sync, "query")
    def test_apply_is_one_atomic_configuration_transaction_without_migrations_or_dispatch(self, query, verify):
        for workspace in sync.AGENTIC_PROJECTS:
            query.reset_mock()
            query.side_effect = [[READY], []]
            output = io.StringIO()
            with redirect_stdout(output):
                sync.synchronize(workspace, "ref", "token", sync.webhook_url("https://app.example", workspace), "secret'quoted")
            self.assertEqual(query.call_count, 2)
            sql = query.call_args.args[2]
            self.assertTrue(sql.startswith("begin;"))
            self.assertTrue(sql.endswith("commit;"))
            self.assertIn(f"?workspace={workspace}", sql)
            self.assertIn("secret''quoted", sql)
            self.assertIn("cron.schedule('recover-document-ingestion'", sql)
            self.assertIn('create trigger "storage.objects.insert" after insert', sql)
            self.assertNotIn("create policy", sql.lower())
            self.assertNotIn("create extension", sql.lower())
            self.assertNotIn("create or replace function public.claim_document_ingestion", sql)
            self.assertNotIn("select public.recover_document_ingestion();\n", sql)
            self.assertNotIn("secret'quoted", output.getvalue())

    @patch.object(sync, "load_dotenv")
    @patch.object(sync, "verify_project")
    @patch.object(sync, "query")
    def test_default_mode_only_inspects_and_never_applies(self, query, verify, load):
        ref, _ = sync.AGENTIC_PROJECTS["personal"]
        query.side_effect = [[{**READY, "enterprise_upload_ready": False}], [{"vault_url_matches": False}]]
        env = {"NEXT_PUBLIC_PERSONAL_SUPABASE_URL": f"https://{ref}.supabase.co", "SUPABASE_ACCESS_TOKEN": "token", "SUPABASE_WEBHOOK_SECRET": "secret"}
        with patch.dict(os.environ, env, clear=True), patch.object(sync.sys, "argv", ["sync_ingestion.py", "--workspace", "personal", "--webhook-base-url", "https://app.example"]), redirect_stdout(io.StringIO()):
            self.assertEqual(sync.main(), 1)
        self.assertEqual(query.call_count, 2)
        for call in query.call_args_list:
            self.assertTrue(call.args[2].lstrip().startswith("select"))


if __name__ == "__main__":
    unittest.main()
