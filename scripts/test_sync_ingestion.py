import unittest
from unittest.mock import Mock, patch

import sync_ingestion as sync


class SyncIngestionTests(unittest.TestCase):
    def test_sql_literal_quotes_values(self):
        self.assertEqual(sync.literal("secret'with-quote"), "'secret''with-quote'")

    @patch.object(sync.requests, "get")
    def test_tunnel_must_forward_to_app_port(self, get):
        get.return_value.json.return_value = {"tunnels": [
            {"public_url": "https://unrelated.example", "config": {"addr": "http://localhost:4000"}},
            {"public_url": "https://app.example", "config": {"addr": "http://localhost:3000"}},
        ]}
        self.assertEqual(sync.tunnel_url(), "https://app.example/api/webhooks/storage")
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

    @patch.object(sync, "query")
    def test_partial_schema_is_rejected_before_any_mutation(self, query):
        query.return_value = [{"hardened": True, "reserved": False, "recovery": False}]
        with self.assertRaises(RuntimeError):
            sync.synchronize("ref", "token", "https://app.example/api/webhooks/storage", "secret")
        self.assertEqual(query.call_count, 1)


if __name__ == "__main__":
    unittest.main()
