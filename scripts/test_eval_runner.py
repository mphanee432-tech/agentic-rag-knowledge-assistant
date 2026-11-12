import contextlib
import base64
from concurrent.futures import ThreadPoolExecutor
import threading
import csv
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

with patch("dotenv.load_dotenv"):
    import eval_runner
import security_checks


def setUpModule():
    dotenv_patch = patch.object(eval_runner, "load_dotenv")
    dotenv_patch.start()
    unittest.addModuleCleanup(dotenv_patch.stop)
    http_patch = patch("requests.sessions.Session.request", side_effect=AssertionError("External HTTP forbidden in offline tests"))
    http_patch.start()
    unittest.addModuleCleanup(http_patch.stop)


def fixture_token(role="authenticated", nonce="first", expiry=4000000000, user_id="fixture-user"):
    payload = json.dumps(dict(role=role, sub=user_id, exp=expiry, nonce=nonce)).encode()
    return "header." + base64.urlsafe_b64encode(payload).decode().rstrip("=") + ".signature"


class EvaluationCommandsTest(unittest.TestCase):
    def test_historical_artifacts_cannot_claim_verified_passes(self):
        root = Path(__file__).resolve().parents[1] / "evals"
        rows = json.loads((root / "eval_results.json").read_text(encoding="utf-8"))
        summary = json.loads((root / "eval_telemetry_20.json").read_text(encoding="utf-8"))
        self.assertEqual(rows, summary["queries"])
        self.assertFalse(summary["gate"]["passed"])
        self.assertIsNone(summary["quality_scores"]["citation_reference_validity_pct"])
        with (root / "eval_results.csv").open(newline="", encoding="utf-8") as source:
            csv_rows = list(csv.DictReader(source))
        self.assertEqual(len(rows), len(csv_rows))
        for row, csv_row in zip(rows, csv_rows):
            self.assertFalse(row["passed"])
            self.assertFalse(row["citation_correct"])
            self.assertIsNone(row["judge_score"])
            self.assertEqual(row["validation_status"], "historical_unverified")
            self.assertIn("judge_score", row["legacy_evaluation"])
            self.assertEqual(csv_row["passed"], "False")
            self.assertEqual(csv_row["validation_status"], row["validation_status"])

    def test_valid_retrieved_citation_requires_a_passing_judge(self):
        response = Mock(status_code=200)
        response.json.return_value = dict(text="Answer [Chunk 1]", context="Evidence",
                                          citations=[dict(id="retrieved-chunk-a", index=1)], metrics={})
        for score, expected in [(1, True), (0.5, False)]:
            with self.subTest(score=score), \
                 patch.dict(os.environ, {"EVAL_ACCESS_TOKEN": fixture_token()}, clear=True), \
                 patch.object(eval_runner.requests, "post", return_value=response), \
                 patch.object(eval_runner, "evaluate_with_llm_judge", return_value=(score, "Test judge")):
                result = eval_runner.evaluate_query(dict(id=1, query="Question"), "https://test.invalid",
                                                    False, "strict", "key", "model")
                self.assertTrue(result["citation_correct"])
                self.assertEqual(result["passed"], expected)

    def test_invalid_answers_cannot_reach_judge_or_pass_in_json_or_streaming(self):
        for text, citations in [
            ("", [dict(id="a", index=1)]),
            ("   ", [dict(id="a", index=1)]),
            ("Answer [Chunk 99]", [dict(id="a", index=1)]),
            ("Answer [Chunk 1, Chunk 2]", [dict(id="a", index=1)]),
            ("Answer [Chunk 1]", []),
            ("Answer [Chunk 1]", [dict(id="", index=1)]),
        ]:
            for streaming in (False, True):
                with self.subTest(text=text, citations=citations, streaming=streaming):
                    response = Mock(status_code=200)
                    response.headers = {"Content-Type": "text/event-stream"}
                    response.json.return_value = dict(text=text, context="Evidence", citations=citations, metrics={})
                    events = [dict(type="metadata", citations=citations), dict(type="text", text=text),
                              dict(type="finish", context="Evidence", metrics={})]
                    response.iter_lines.side_effect = lambda **kwargs: iter(
                        b"data: " + json.dumps(event).encode() for event in events)
                    with patch.dict(os.environ, {"EVAL_ACCESS_TOKEN": fixture_token()}, clear=True), \
                         patch.object(eval_runner.requests, "post", return_value=response), \
                         patch.object(eval_runner.time, "sleep"), \
                         patch.object(eval_runner, "evaluate_with_llm_judge", return_value=(1, "Perfect")) as judge:
                        result = eval_runner.evaluate_query(dict(id=1, query="Question"), "https://test.invalid",
                                                            streaming, "strict", "key", "model")
                    self.assertFalse(result["passed"])
                    self.assertEqual(result["judge_score"], 0)
                    judge.assert_not_called()

    def test_percentile_uses_one_method_for_all_sample_sizes(self):
        self.assertEqual(eval_runner.p95([]), 0)
        self.assertEqual(eval_runner.p95([10]), 10)
        self.assertEqual(eval_runner.p95([10, 20]), 20)
        self.assertEqual(eval_runner.p95(list(range(1, 21))), 19)
        self.assertEqual(eval_runner.p95(list(range(1, 51))), 48)

    def test_dataset_validation_needs_no_credentials_or_model_calls(self):
        with patch.dict(os.environ, {}, clear=True), patch("sys.argv", ["eval_runner", "--check-dataset"]), \
             patch.object(eval_runner, "evaluate_query") as query, \
             patch.object(eval_runner, "EvaluationAuth") as auth, \
             patch.object(eval_runner, "load_dotenv") as dotenv, \
             patch.object(eval_runner.requests, "post") as request, contextlib.redirect_stdout(io.StringIO()):
            eval_runner.main()
        query.assert_not_called()
        auth.assert_not_called()
        dotenv.assert_not_called()
        request.assert_not_called()

    def test_judge_receives_expectations_and_requires_both_graded_scores(self):
        signals = {"must_refuse": False, "ground_truth_keywords": ["reference fact"]}
        with patch.object(eval_runner, "call_gemini_judge_rest", return_value=json.dumps(
            {"faithfulness": 3, "relevance": 2.5, "rationale": "Supported and relevant"}
        )) as judge:
            score, _ = eval_runner.evaluate_with_llm_judge("Query", "Answer [Chunk 1]", "Evidence", "Rubric", signals, "key")
            self.assertEqual(score, 2.5 / 3)
            self.assertIn("reference fact", judge.call_args.args[0])
        for result in ({"pass": True, "score": 1, "rationale": "Old schema"},
                       {"faithfulness": True, "relevance": 3, "rationale": "Wrong type"},
                       {"faithfulness": 4, "relevance": 3, "rationale": "Wrong scale"}):
            with patch.object(eval_runner, "call_gemini_judge_rest", return_value=json.dumps(result)):
                self.assertEqual(eval_runner.evaluate_with_llm_judge("Q", "A", "C", "R", {}, "key")[0], 0)
        with patch.object(eval_runner, "call_gemini_judge_rest") as judge:
            self.assertEqual(eval_runner.evaluate_with_llm_judge("Q", "A", "", "R", {}, "key")[0], 0)
            judge.assert_not_called()

    def test_truncated_or_duplicate_streams_fail_and_close_responses(self):
        events = [dict(type="metadata", citations=[dict(id="a", index=1)]),
                  dict(type="text", text="Answer [Chunk 1]"), dict(type="finish", metrics={}, context="Evidence")]
        for broken in (events[:-1], events + [events[-1]], [events[1], events[-1]]):
            response = Mock(status_code=200)
            response.headers = {"Content-Type": "text/event-stream"}
            response.iter_lines.side_effect = lambda **kwargs: iter(b"data: " + json.dumps(event).encode() for event in broken)
            with patch.dict(os.environ, {"EVAL_ACCESS_TOKEN": fixture_token()}, clear=True), \
                 patch.object(eval_runner.requests, "post", return_value=response), patch.object(eval_runner.time, "sleep"), \
                 patch.object(eval_runner, "evaluate_with_llm_judge") as judge:
                result = eval_runner.evaluate_query(dict(id=1, query="Question"), "https://test.invalid", True, "strict", "key", "model")
                self.assertFalse(result["passed"])
                self.assertTrue(result["errors"])
                self.assertEqual(response.close.call_count, 2)
                judge.assert_not_called()

    def test_invalid_json_metadata_cannot_crash_reporting_or_reach_judge(self):
        valid = dict(text="Answer [Chunk 1]", context="Evidence", citations=[dict(id="a", index=1)], metrics={})
        for patch_data in [dict(text=[]), dict(citations=[dict(id="a", index=[])]),
                           dict(metrics={"token_usage": {"prompt": "not-a-number", "completion": 1}}),
                           dict(metrics={"errors": "not-a-list"}), dict(output="Different answer")]:
            response = Mock(status_code=200)
            response.json.return_value = {**valid, **patch_data}
            with patch.dict(os.environ, {"EVAL_ACCESS_TOKEN": fixture_token()}, clear=True), \
                 patch.object(eval_runner.requests, "post", return_value=response), patch.object(eval_runner.time, "sleep"), \
                 patch.object(eval_runner, "evaluate_with_llm_judge") as judge:
                result = eval_runner.evaluate_query(dict(id=1, query="Question"), "https://test.invalid", False, "strict", "key", "model")
                self.assertFalse(result["passed"])
                self.assertTrue(result["errors"])
                self.assertIsInstance(result["prompt_tokens"], int)
                self.assertFalse(result["format_correct"])
                self.assertEqual(result["ttft_ms"], 0)
                response.close.assert_called()
                judge.assert_not_called()

    def run_cli(self, flags, *, judge="test-key", isolation=True, count=50, bad_answer=False):
        with tempfile.TemporaryDirectory() as directory:
            dataset = Path(directory) / "dataset.json"
            output = Path(directory) / "results"
            golden = json.loads((Path(__file__).resolve().parents[1] / "evals/golden_dataset.json").read_text(encoding="utf-8"))
            dataset.write_text(json.dumps(golden[:count]), encoding="utf-8")

            def evaluate(row, **kwargs):
                return dict(id=row["id"], category=row["category"], query=row["query"],
                            citation_correct=not bad_answer, format_correct=True,
                            passed=bool(judge) and not bad_answer, judge_score=1 if judge else 0,
                            embed_ms=10, retrieval_ms=10, ttft_ms=100, total_ms=500,
                            errors=[], retries={}, rationale="Test fixture")

            with patch.dict(os.environ, {"EVAL_ACCESS_TOKEN": fixture_token(), "EVAL_OTHER_ACCESS_TOKEN": fixture_token(user_id="fixture-other")}, clear=True), \
                    patch("sys.argv", ["eval_runner", *flags, "--dataset", str(dataset),
                                       "--output-dir", str(output), "--delay", "0"]), \
                    patch.object(eval_runner, "get_judge_api_key", return_value=judge), \
                    patch.object(eval_runner, "check_isolation", return_value=(isolation, "Fixture isolation")) as isolation_check, \
                    patch.object(eval_runner, "evaluate_query", side_effect=evaluate) as query, \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = 0
                try:
                    eval_runner.main()
                except SystemExit as error:
                    code = error.code
                artifacts = list(output.glob("eval_telemetry_*.json"))
                summary = json.loads(artifacts[0].read_text(encoding="utf-8")) if artifacts else None
                if summary:
                    partial = [json.loads(line) for line in (output / "eval_results.partial.jsonl").read_text(encoding="utf-8").splitlines()]
                    self.assertEqual(len(partial), len(summary["queries"]))
                    trace = json.loads((output / f"ttft_trace_{len(partial)}.json").read_text(encoding="utf-8"))
                    self.assertEqual(trace["trace_version"], 1)
                    self.assertEqual(trace["status"], "passed" if summary["gate"]["passed"] else "failed")
                    self.assertEqual(len(trace["queries"]), len(partial))
                    self.assertNotIn("query", trace["queries"][0])
                    self.assertIsNone(trace["queries"][0]["server_timings"]["server_ttft_ms"])
                    self.assertEqual(trace["observability_status"], "unobserved")
                    self.assertEqual(trace["observability_counts"], dict(complete=0, partial=0, unobserved=len(partial)))
                    self.assertTrue(all(row["trace_completeness"] == "unobserved" for row in trace["queries"]))
                return code, summary, query, isolation_check

    def test_streaming_smoke_exits_zero_without_claiming_release_certification(self):
        code, summary, query, isolation = self.run_cli(["--smoke", "--stream"], judge="")
        self.assertEqual(code, 0)
        self.assertEqual(query.call_count, 5)
        self.assertTrue(all(call.kwargs["stream_mode"] for call in query.call_args_list))
        isolation.assert_not_called()
        self.assertEqual(summary["gate"], dict(mode="smoke", passed=True, response_release_gates_passed=False, release_certified=False, failures=[]))

    def test_release_checks_full_streaming_dataset_and_isolation(self):
        code, summary, query, isolation = self.run_cli(["--full", "--stream", "--release"])
        self.assertEqual(code, 0)
        self.assertEqual(query.call_count, 50)
        isolation.assert_called_once()
        self.assertIsInstance(isolation.call_args.kwargs["auth"], eval_runner.EvaluationAuth)
        self.assertTrue(summary["gate"]["response_release_gates_passed"])
        self.assertFalse(summary["gate"]["release_certified"])

    def test_full_exploration_is_not_implicitly_release_certification(self):
        code, summary, query, isolation = self.run_cli(["--full", "--stream"])
        self.assertEqual(code, 0)
        self.assertEqual(query.call_count, 50)
        isolation.assert_not_called()
        self.assertFalse(summary["gate"]["release_certified"])

    def test_invalid_release_options_fail_before_generation(self):
        for flags in [["--release", "--smoke", "--stream"], ["--release", "--full"],
                      ["--smoke", "--full"], ["--release", "--full", "--stream", "--workers", "2"]]:
            with self.subTest(flags=flags):
                code, _, query, _ = self.run_cli(flags)
                self.assertEqual(code, 2)
                query.assert_not_called()

    def test_missing_release_prerequisites_fail_before_generation(self):
        for options in [dict(judge=""), dict(isolation=False), dict(count=49)]:
            with self.subTest(options=options):
                code, _, query, _ = self.run_cli(["--release", "--full", "--stream"], **options)
                self.assertEqual(code, 2)
                query.assert_not_called()

    def test_gate_failure_exits_nonzero_and_preserves_artifacts(self):
        code, summary, _, _ = self.run_cli(["--smoke", "--stream"], judge="", bad_answer=True)
        self.assertEqual(code, 1)
        self.assertFalse(summary["gate"]["passed"])
        self.assertTrue(summary["gate"]["failures"])

    def test_recovered_transport_errors_are_not_erased(self):
        traces = []
        response = Mock(status_code=200)
        response.headers = {"Content-Type": "text/event-stream"}
        response.iter_lines.return_value = [b"data: " + json.dumps(event).encode() for event in [
            dict(type="metadata", citations=[dict(id="a", index=1)]),
            dict(type="text", text="Answer [Chunk 1]"),
            dict(type="finish", context="Evidence", metrics={}),
        ]]
        with patch.dict(os.environ, {"EVAL_ACCESS_TOKEN": fixture_token()}, clear=True), \
                patch.object(eval_runner.requests, "post", side_effect=[ConnectionError("Temporary failure"), response]), \
                patch.object(eval_runner.time, "sleep"), \
                patch.object(eval_runner.time, "perf_counter", side_effect=[0, 0.01, 0.2, 0.21, 0.27, 0.3, 0.6]), \
                patch.object(eval_runner, "evaluate_with_llm_judge", return_value=(1.0, "Supported")):
            result = eval_runner.evaluate_query(dict(id=1, query="Question"), "https://test.invalid/api/chat",
                                                True, "strict", "test-key", "test-model", trace_sink=traces)
        self.assertEqual(result["errors"], ["Temporary failure"])
        response.iter_lines.assert_called_once_with(chunk_size=1)
        response.close.assert_called_once()
        self.assertFalse(result["passed"])
        self.assertEqual(result["total_ms"], 600)
        self.assertEqual(result["ttft_ms"], 300)
        self.assertEqual(traces[0]["retries"]["request"], 1)
        self.assertEqual(traces[0]["status"], "failed")
        self.assertAlmostEqual(traces[0]["client_timings"]["client_ttft_ms"], 90)
        self.assertIsNone(traces[0]["client_timings"]["client_server_ttft_gap_ms"])

    def test_judge_key_is_sent_in_header_not_error_prone_url(self):
        response = Mock(status_code=200)
        response.json.return_value = {"candidates": [{"content": {"parts": [{"text": "{}"}]}}]}
        with patch.object(eval_runner.requests, "post", return_value=response) as request:
            eval_runner.call_gemini_judge_rest("Test", "test-secret")
        self.assertNotIn("test-secret", request.call_args.args[0])
        self.assertEqual(request.call_args.kwargs["headers"]["x-goog-api-key"], "test-secret")


class TTFTTraceTest(unittest.TestCase):
    interaction = "11111111-1111-4111-8111-111111111111"

    def evaluate(self, *, stream=True, header=True, metadata=True, mismatch=False, broken=False, metrics_patch=None):
        clock = [10.0]
        dispatch = [10.0]
        traces = []
        response = Mock(status_code=200)
        response.headers = {"Content-Type": "text/event-stream"}
        if header:
            response.headers["x-interaction-id"] = self.interaction
        meta = dict(type="metadata", citations=[dict(id="a", index=1)])
        if metadata:
            meta["interactionId"] = "22222222-2222-4222-8222-222222222222" if mismatch else self.interaction
        metrics = dict(server_ttft_ms=180, model_first_text_ms=80, request_parse_ms=2,
                       model_id="gemini-fixture", retrieved_chunk_count=1, context_chars=7,
                       token_usage=dict(prompt=3, completion=2, total=5),
                       retries=dict(embedding=1, retrieval=0, generation=0))
        metrics.update(metrics_patch or {})

        def lines(**kwargs):
            self.assertEqual(kwargs, dict(chunk_size=1))
            for at, event in [(10.15, meta), (10.2, dict(type="text", text="")),
                              (10.3, dict(type="text", text="Answer ")),
                              (10.35, dict(type="text", text="[Chunk 1]")),
                              (10.5, dict(type="error", message="private-error") if broken else
                               dict(type="finish", context="private-document", metrics=metrics))]:
                clock[0] = dispatch[0] + at - 10.0
                yield b"data: " + json.dumps(event).encode()
            clock[0] = dispatch[0] + 0.6

        response.iter_lines.side_effect = lines
        response.json.return_value = dict(text="Answer [Chunk 1]", context="private-document",
                                          citations=[dict(id="a", index=1)], metrics=metrics,
                                          interactionId=self.interaction if metadata else None)

        def post(*args, **kwargs):
            dispatch[0] = clock[0]
            clock[0] = dispatch[0] + 0.1
            kwargs["hooks"]["response"](response)
            if not stream:
                clock[0] = dispatch[0] + 0.6
            return response

        with patch.dict(os.environ, {"EVAL_ACCESS_TOKEN": fixture_token()}, clear=True), \
                patch.object(eval_runner.requests, "post", side_effect=post), \
                patch.object(eval_runner.time, "perf_counter", side_effect=lambda: clock[0]), \
                patch.object(eval_runner.time, "sleep"):
            result = eval_runner.evaluate_query(dict(id=1, category="Fact-Based Lookups", query="private-query"),
                                                "https://test.invalid", stream, "strict", "", "model", trace_sink=traces)
        return result, traces[0]

    def test_headers_metadata_first_nonempty_text_and_complete_stream(self):
        result, trace = self.evaluate()
        self.assertEqual(trace["interaction_id"], self.interaction)
        self.assertEqual(trace["status"], "success")
        self.assertEqual(trace["trace_completeness"], "partial")
        self.assertTrue(trace["interaction_id_verified"])
        for key, expected in dict(client_headers_ms=100, client_first_metadata_ms=150,
                                  client_ttft_ms=300, client_total_ms=600,
                                  client_server_ttft_gap_ms=120).items():
            self.assertAlmostEqual(trace["client_timings"][key], expected)
        self.assertAlmostEqual(result["ttft_ms"], 300)
        self.assertEqual(trace["retries"]["embedding"], 1)
        self.assertEqual(trace["tokens"], dict(prompt=3, completion=2, total=5))
        self.assertIsNone(trace["server_timings"]["chunk_verify_ms"])
        self.assertNotIn("trace", result)
        self.assertNotIn("interaction_id", result)

    def test_missing_identifiers_remain_compatible_and_mismatches_fail(self):
        for header, metadata in [(True, False), (False, True), (False, False)]:
            with self.subTest(header=header, metadata=metadata):
                result, trace = self.evaluate(header=header, metadata=metadata)
                self.assertFalse(result["errors"])
                self.assertEqual(trace["interaction_id"], self.interaction if header or metadata else None)
                self.assertFalse(trace["interaction_id_verified"])
                self.assertEqual(trace["trace_completeness"], "partial")
                if not header and not metadata:
                    self.assertIsNone(trace["client_timings"]["client_server_ttft_gap_ms"])
        result, trace = self.evaluate(mismatch=True)
        self.assertTrue(result["errors"])
        self.assertFalse(result["passed"])
        self.assertEqual(trace["status"], "failed")
        self.assertIn("interaction_id_mismatch", trace["error_categories"])
        self.assertFalse(trace["interaction_id_verified"])
        self.assertNotEqual(trace["trace_completeness"], "complete")
        self.assertIsNone(trace["client_timings"]["client_total_ms"])
        self.assertIsNone(trace["client_timings"]["client_server_ttft_gap_ms"])

    def test_json_has_header_timing_but_no_invented_first_token(self):
        result, trace = self.evaluate(stream=False)
        self.assertEqual(result["ttft_ms"], 0)
        self.assertAlmostEqual(trace["client_timings"]["client_headers_ms"], 100)
        self.assertAlmostEqual(trace["client_timings"]["client_total_ms"], 600)
        for key in ("client_first_metadata_ms", "client_ttft_ms", "client_server_ttft_gap_ms"):
            self.assertIsNone(trace["client_timings"][key])
        self.assertIsNone(trace["server_timings"]["model_first_text_ms"])

    def test_failed_stream_never_has_a_successful_completion(self):
        result, trace = self.evaluate(broken=True)
        self.assertEqual(result["retries"]["request"], 1)
        self.assertEqual(trace["status"], "failed")
        self.assertIsNone(trace["client_timings"]["client_total_ms"])
        self.assertNotIn("private-error", json.dumps(trace))
        self.assertEqual(trace["trace_completeness"], "partial")

    def test_401_renewal_uses_final_dispatch_for_trace_and_counts_retry(self):
        clock = [0.0]
        traces = []
        response = Mock(status_code=200)
        response.headers = {"Content-Type": "text/event-stream", "x-interaction-id": self.interaction}
        events = [dict(type="metadata", interactionId=self.interaction, citations=[dict(id="a", index=1)]),
                  dict(type="text", text="Answer [Chunk 1]"),
                  dict(type="finish", context="Evidence", metrics={"server_ttft_ms": 100})]

        def lines(**kwargs):
            for at, event in zip((1.2, 1.3, 1.4), events):
                clock[0] = at
                yield b"data: " + json.dumps(event).encode()

        response.iter_lines.side_effect = lines
        unauthorized = Mock(status_code=401)

        def post(*args, **kwargs):
            reply = unauthorized if clock[0] == 0 else response
            clock[0] += 0.1
            kwargs["hooks"]["response"](reply)
            return reply

        auth = Mock()

        def request(send, url, *, retries, **kwargs):
            self.assertIs(send(url, **kwargs), unauthorized)
            unauthorized.close()
            clock[0] = 1.0  # Simulated refresh; real refresh behavior has independent tests.
            retries["request"] += 1
            return send(url, **kwargs)

        auth.request.side_effect = request
        with patch.object(eval_runner.requests, "post", side_effect=post), \
                patch.object(eval_runner.time, "perf_counter", side_effect=lambda: clock[0]):
            result = eval_runner.evaluate_query(dict(id=1, query="Question"), "https://test.invalid",
                                                True, "strict", "", "model", auth=auth, trace_sink=traces)
        self.assertEqual(result["retries"]["request"], 1)
        self.assertAlmostEqual(result["ttft_ms"], 1300)
        self.assertAlmostEqual(traces[0]["client_timings"]["client_ttft_ms"], 300)
        self.assertAlmostEqual(traces[0]["client_timings"]["client_headers_ms"], 100)
        self.assertAlmostEqual(traces[0]["client_timings"]["client_server_ttft_gap_ms"], 200)

    def test_sanitized_json_allows_only_diagnostics_and_finite_values(self):
        secret = "private-query document JWT password answer"
        result = dict(id=1, category=secret, query=secret, errors=[secret], retries={"request": 1, secret: secret},
                      prompt_tokens=3, completion_tokens=2, total_tokens=5, citations=[secret])
        metrics = dict(model_id=secret, server_ttft_ms=float("nan"), auth_ms=True,
                       context_chars=secret, errors=[secret], query=secret, request_parse_ms=0)
        trace = eval_runner.sanitized_trace(result, True, metrics=metrics, interaction_id=secret,
                                            response_valid=False, error_categories=[secret])
        self.assertNotIn(secret, json.dumps(trace, allow_nan=False))
        self.assertIsNone(trace["interaction_id"])
        self.assertIsNone(trace["model_id"])
        self.assertIsNone(trace["server_timings"]["server_ttft_ms"])
        self.assertIsNone(trace["server_timings"]["auth_ms"])
        self.assertEqual(trace["server_timings"]["request_parse_ms"], 0)
        self.assertEqual(trace["error_categories"], ["request_failed"])
        self.assertEqual(trace["trace_completeness"], "partial")
        self.assertTrue(set(trace["missing_required_timings"]) <= set(eval_runner.SERVER_TIMINGS + eval_runner.CLIENT_TIMINGS))
        success = [eval_runner.sanitized_trace(dict(id=i, category="Fact-Based Lookups"), True,
                   metrics={"server_ttft_ms": i}, response_valid=True) for i in range(1, 21)]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trace.json"
            eval_runner.write_ttft_trace(path, success + [trace], expected_count=21, passed=False)
            artifact = json.loads(path.read_text())
            self.assertEqual(artifact["status"], "failed")
            self.assertEqual(artifact["aggregates"]["server_timings"]["server_ttft_ms"],
                             dict(count=20, p50=10.5, p95=19))
            self.assertIsNone(artifact["aggregates"]["server_timings"]["chunk_verify_ms"]["p95"])
            eval_runner.write_ttft_trace(path, [trace], expected_count=5, passed=True)
            self.assertEqual(json.loads(path.read_text())["status"], "incomplete")


    def complete_trace(self, *, stream=True, metrics_patch=None, client_patch=None, verified=True,
                       response_valid=True, errors=()):
        metrics = dict(request_parse_ms=2, auth_ms=8, embedding_ms=11, rrf_rpc_ms=7,
                       chunk_verify_ms=19, retrieval_ms=26, prompt_build_ms=1,
                       model_first_text_ms=23, server_ttft_ms=71, interaction_write_ms=31,
                       server_finish_ready_ms=110, retrieved_chunk_count=1)
        client = dict(client_headers_ms=60, client_first_metadata_ms=65, client_ttft_ms=90,
                      client_total_ms=150, client_server_ttft_gap_ms=19)
        if not stream:
            for key in ("client_first_metadata_ms", "client_ttft_ms", "client_server_ttft_gap_ms"):
                client[key] = None
        metrics.update(metrics_patch or {})
        client.update(client_patch or {})
        return eval_runner.sanitized_trace(dict(id=1, category="Fact-Based Lookups", errors=errors), stream,
            metrics=metrics, client=client, interaction_id=self.interaction,
            response_valid=response_valid, correlation_verified=verified)

    def test_complete_streaming_timings_and_correlation_are_required(self):
        trace = self.complete_trace()
        self.assertEqual(trace["trace_completeness"], "complete")
        self.assertEqual(trace["missing_required_timings"], [])
        self.assertTrue(trace["interaction_id_verified"])
        for patch_data in (dict(auth_ms=None), dict(embedding_ms=float("nan")),
                           dict(prompt_build_ms=-1), dict(interaction_write_ms=True)):
            with self.subTest(patch_data=patch_data):
                trace = self.complete_trace(metrics_patch=patch_data)
                self.assertEqual(trace["trace_completeness"], "partial")
                self.assertEqual(trace["missing_required_timings"], list(patch_data))
        trace = self.complete_trace(verified=False)
        self.assertEqual(trace["trace_completeness"], "partial")
        self.assertEqual(trace["missing_required_timings"], [])
        trace = self.complete_trace(metrics_patch=dict(auth_ms=0, prompt_build_ms=0))
        self.assertEqual(trace["trace_completeness"], "complete", "Executed zero-duration measurements are valid")

    def test_complete_observations_flow_through_stream_and_json_evaluation(self):
        metrics = self.complete_trace()["server_timings"]
        for stream in (True, False):
            with self.subTest(stream=stream):
                result, trace = self.evaluate(stream=stream, metrics_patch=metrics)
                self.assertFalse(result["errors"])
                self.assertEqual(trace["trace_completeness"], "complete")
                self.assertTrue(trace["interaction_id_verified"])
        _, trace = self.evaluate(stream=False, metadata=False, metrics_patch=metrics)
        self.assertEqual(trace["trace_completeness"], "partial")
        self.assertFalse(trace["interaction_id_verified"])

    def test_historical_fallback_without_observations_is_unobserved(self):
        trace = eval_runner.sanitized_trace(dict(id=1, format_correct=True, passed=True,
            embed_ms=10, retrieval_ms=20, ttft_ms=100, total_ms=500), True, response_valid=True)
        self.assertEqual(trace["status"], "success")
        self.assertEqual(trace["trace_completeness"], "unobserved")
        self.assertFalse(trace["interaction_id_verified"])

    def test_no_evidence_omits_model_timing_but_not_attempted_verification(self):
        trace = self.complete_trace(metrics_patch=dict(retrieved_chunk_count=0, model_first_text_ms=None))
        self.assertEqual(trace["trace_completeness"], "complete")
        self.assertEqual(trace["server_timings"]["chunk_verify_ms"], 19)
        self.assertNotIn("model_first_text_ms", trace["missing_required_timings"])
        # Without an execution-state indicator, even an actual skip is conservatively partial.
        trace = self.complete_trace(metrics_patch=dict(retrieved_chunk_count=0,
            model_first_text_ms=None, chunk_verify_ms=None))
        self.assertEqual(trace["trace_completeness"], "partial")
        self.assertEqual(trace["missing_required_timings"], ["chunk_verify_ms"])

    def test_json_completeness_excludes_sse_timings(self):
        trace = self.complete_trace(stream=False)
        self.assertEqual(trace["trace_completeness"], "complete")
        self.assertEqual(trace["missing_required_timings"], [])
        for key in ("model_first_text_ms", "server_ttft_ms", "server_finish_ready_ms"):
            self.assertIsNone(trace["server_timings"][key])
        trace = self.complete_trace(stream=False, client_patch=dict(client_headers_ms=None))
        self.assertEqual(trace["trace_completeness"], "partial")
        self.assertEqual(trace["missing_required_timings"], ["client_headers_ms"])

    def test_failed_or_incomplete_responses_cannot_be_complete(self):
        for options in (dict(response_valid=False), dict(errors=["arbitrary private failure"]),
                        dict(client_patch=dict(client_total_ms=None)),
                        dict(metrics_patch=dict(server_finish_ready_ms=None))):
            with self.subTest(options=options):
                trace = self.complete_trace(**options)
                self.assertEqual(trace["trace_completeness"], "partial")
                self.assertNotIn("arbitrary private failure", json.dumps(trace))

    def test_observability_counts_and_quality_verdict_are_independent(self):
        complete = self.complete_trace()
        partial = self.complete_trace(metrics_patch=dict(auth_ms=None))
        unobserved = eval_runner.sanitized_trace(dict(id=3), True, response_valid=True)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trace.json"
            eval_runner.write_ttft_trace(path, [complete, partial, unobserved], expected_count=3, passed=True)
            artifact = json.loads(path.read_text())
            self.assertEqual(artifact["status"], "passed")
            self.assertEqual(artifact["observability_status"], "partial")
            self.assertEqual(artifact["observability_counts"], dict(complete=1, partial=1, unobserved=1))
            self.assertEqual(artifact["timing_definitions"], eval_runner.TIMING_DEFINITIONS)
            # A quality-gate failure alone does not invalidate captured timing evidence.
            eval_runner.write_ttft_trace(path, [complete], expected_count=1, passed=False)
            artifact = json.loads(path.read_text())
            self.assertEqual(artifact["status"], "failed")
            self.assertEqual(artifact["observability_status"], "complete")
            eval_runner.write_ttft_trace(path, [complete], expected_count=2, passed=True)
            artifact = json.loads(path.read_text())
            self.assertEqual(artifact["status"], "incomplete")
            self.assertEqual(artifact["observability_status"], "partial")
            eval_runner.write_ttft_trace(path, [], expected_count=1, passed=False)
            self.assertEqual(json.loads(path.read_text())["observability_status"], "unobserved")

    def test_new_completeness_fields_cannot_carry_arbitrary_data(self):
        secret = "JWT credential private-query answer source-document exception"
        trace = self.complete_trace(metrics_patch={secret: secret, "auth_ms": secret}, verified=secret)
        self.assertFalse(trace["interaction_id_verified"])
        self.assertEqual(trace["trace_completeness"], "partial")
        self.assertEqual(trace["missing_required_timings"], ["auth_ms"])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trace.json"
            eval_runner.write_ttft_trace(path, [trace], expected_count=1, passed=True)
            self.assertNotIn(secret, path.read_text())


class EvaluationAuthenticationTest(unittest.TestCase):
    environment = {
        "NEXT_PUBLIC_SUPABASE_URL": "https://auth.example.invalid",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_fixture",
        "EVAL_TEST_EMAIL": "fixture-owner",
        "EVAL_TEST_PASSWORD": "fixture-password",
    }

    jwt = staticmethod(fixture_token)

    def session(self, nonce="first"):
        return dict(access_token=self.jwt(nonce=nonce), refresh_token="fixture-refresh-" + nonce, expires_in=3600)

    @staticmethod
    def response(payload=None, status=200):
        response = Mock(status_code=status)
        response.json.return_value = payload
        return response

    def test_password_sign_in_uses_only_the_public_key_and_keeps_tokens_in_memory(self):
        for key_name, key in [("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fixture"),
                              ("NEXT_PUBLIC_SUPABASE_ANON_KEY", self.jwt(role="anon"))]:
            environment = {k: v for k, v in self.environment.items() if "KEY" not in k}
            environment[key_name] = key
            response = self.response(self.session())
            with self.subTest(key_name=key_name), patch.dict(os.environ, environment, clear=True), \
                    patch.object(eval_runner.requests, "post", return_value=response) as request:
                before = dict(os.environ)
                auth = eval_runner.EvaluationAuth()
                self.assertEqual(auth.get_token(), self.session()["access_token"])
                self.assertEqual(dict(os.environ), before)
            request.assert_called_once_with(
                "https://auth.example.invalid/auth/v1/token", params={"grant_type": "password"},
                json={"email": "fixture-owner", "password": "fixture-password"},
                headers={"apikey": key}, timeout=15, allow_redirects=False)
            response.close.assert_called_once()

    def test_missing_credentials_and_privileged_public_keys_fail_before_network(self):
        invalid = [{}, {**self.environment, "EVAL_TEST_PASSWORD": ""},
                   {**self.environment, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": "sb_secret_fixture"},
                   {**self.environment, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": self.jwt(role="service_role")}]
        for environment in invalid:
            with self.subTest(environment_fields=sorted(environment)), patch.dict(os.environ, environment, clear=True), \
                    patch.object(eval_runner.requests, "post") as request:
                with self.assertRaises(eval_runner.EvaluationAuthError):
                    eval_runner.EvaluationAuth()
                request.assert_not_called()

    def test_login_errors_are_redacted_and_do_not_retry(self):
        cases = [self.response(status=400), self.response({"access_token": "invalid"}),
                 eval_runner.requests.Timeout("fixture-password fixture-refresh-first")]
        for response in cases:
            effect = response if isinstance(response, Exception) else lambda *args, **kwargs: response
            with self.subTest(response_type=type(response).__name__), \
                    patch.dict(os.environ, self.environment, clear=True), \
                    patch.object(eval_runner.requests, "post", side_effect=effect) as request:
                with self.assertRaises(eval_runner.EvaluationAuthError) as error:
                    eval_runner.EvaluationAuth()
                self.assertNotIn("fixture-password", str(error.exception))
                self.assertNotIn("fixture-refresh", str(error.exception))
                self.assertEqual(request.call_count, 1)

    def test_manual_token_overrides_password_login_and_has_no_refresh(self):
        with patch.dict(os.environ, {**self.environment, "EVAL_ACCESS_TOKEN": self.jwt()}, clear=True), \
                patch.object(eval_runner.requests, "post") as request:
            auth = eval_runner.EvaluationAuth()
            token = auth.get_token()
            self.assertEqual(token, self.jwt())
            send = Mock(return_value=self.response())
            auth.request(send, eval_runner.DEFAULT_ENDPOINT)
            self.assertEqual(send.call_args.kwargs["headers"]["Authorization"], "Bearer " + token)
            with self.assertRaisesRegex(eval_runner.EvaluationAuthError, "No refresh token"):
                auth.get_token(rejected=token)
            request.assert_not_called()

    def test_empty_manual_override_allows_password_sign_in(self):
        with patch.dict(os.environ, {**self.environment, "EVAL_ACCESS_TOKEN": "  "}, clear=True), \
                patch.object(eval_runner.requests, "post", return_value=self.response(self.session())) as request:
            self.assertEqual(eval_runner.EvaluationAuth().get_token(), self.jwt())
            self.assertEqual(request.call_args.kwargs["params"], {"grant_type": "password"})

    def test_expired_manual_tokens_and_api_keys_are_not_used(self):
        for token in [self.jwt(expiry=0), self.jwt(role="service_role"), self.jwt(role="anon"),
                      "sb_secret_fixture", "sb_publishable_fixture"]:
            with self.subTest(token_kind=token.split(".")[0]), \
                    patch.dict(os.environ, {**self.environment, "EVAL_ACCESS_TOKEN": token}, clear=True), \
                    patch.object(eval_runner.requests, "post") as request:
                with self.assertRaises(eval_runner.EvaluationAuthError):
                    eval_runner.EvaluationAuth().get_token()
                request.assert_not_called()

    def test_malformed_jwts_and_expiration_metadata_fail_without_secret_details(self):
        invalid = ["fixture-secret", "header.%%%%.signature", "header.bnVsbA.signature", "header.W10.signature"]
        invalid += [self.jwt(expiry=value) for value in (None, True, "fixture-secret", float("nan"), float("inf"), 10 ** 1000)]
        for index, token in enumerate(invalid):
            with self.subTest(index=index), patch.dict(os.environ, {"EVAL_ACCESS_TOKEN": token}, clear=True), \
                    patch.object(eval_runner.requests, "post") as request:
                with self.assertRaises(eval_runner.EvaluationAuthError) as error:
                    eval_runner.EvaluationAuth()
                self.assertNotIn(token, str(error.exception))
                self.assertNotIn("fixture-secret", str(error.exception))
                request.assert_not_called()

    def test_expiring_session_is_refreshed_once_for_concurrent_workers(self):
        barrier = threading.Barrier(8)
        with patch.dict(os.environ, self.environment, clear=True), \
                patch.object(eval_runner.requests, "post", side_effect=[
                    self.response(self.session()), self.response(self.session("second")),
                    self.response(self.session("third"))]) as request, \
                patch.object(eval_runner.time, "monotonic", return_value=0) as clock:
            auth = eval_runner.EvaluationAuth()
            first = auth.get_token()
            clock.return_value = 3550

            def token():
                barrier.wait(timeout=5)
                return auth.get_token()

            with ThreadPoolExecutor(max_workers=8) as workers:
                tokens = list(workers.map(lambda _: token(), range(8)))
            self.assertEqual(tokens, [self.session("second")["access_token"]] * 8)
            self.assertEqual(auth.get_token(rejected=first), tokens[0])
            self.assertEqual(request.call_count, 2)
            self.assertEqual(request.call_args.kwargs["json"], {"refresh_token": "fixture-refresh-first"})
            clock.return_value = 7100
            auth.get_token()
            self.assertEqual(request.call_args.kwargs["json"], {"refresh_token": "fixture-refresh-second"})

    def test_simultaneous_401s_share_one_refresh(self):
        barrier = threading.Barrier(8)
        with patch.dict(os.environ, self.environment, clear=True), \
                patch.object(eval_runner.requests, "post", side_effect=[
                    self.response(self.session()), self.response(self.session("second"))]) as request:
            auth = eval_runner.EvaluationAuth()
            rejected = auth.get_token()

            def renew():
                barrier.wait(timeout=5)
                return auth.get_token(rejected=rejected)

            with ThreadPoolExecutor(max_workers=8) as workers:
                tokens = list(workers.map(lambda _: renew(), range(8)))
            self.assertEqual(tokens, [self.session("second")["access_token"]] * 8)
            self.assertEqual(request.call_count, 2)

    def test_refresh_rejection_is_latched_for_all_workers(self):
        with patch.dict(os.environ, self.environment, clear=True), \
                patch.object(eval_runner.requests, "post", side_effect=[
                    self.response(self.session()), self.response(status=400)]) as request, \
                patch.object(eval_runner.time, "monotonic", return_value=0) as clock:
            auth = eval_runner.EvaluationAuth()
            clock.return_value = 3550
            for _ in range(8):
                with self.assertRaisesRegex(eval_runner.EvaluationAuthError, "expired or revoked"):
                    auth.get_token()
            self.assertEqual(request.call_count, 2)

    def test_concurrent_401s_deduplicate_refresh_even_when_access_jwt_is_unchanged(self):
        barrier = threading.Barrier(8)
        local = threading.local()
        renewed = self.session() | {"refresh_token": "fixture-rotated-refresh"}

        def send(url, **kwargs):
            if not getattr(local, "sent", False):
                local.sent = True
                barrier.wait(timeout=5)
                return self.response(status=401)
            return self.response()

        with patch.dict(os.environ, self.environment, clear=True), \
                patch.object(eval_runner.requests, "post", side_effect=[
                    self.response(self.session()), self.response(renewed)]) as exchange:
            auth = eval_runner.EvaluationAuth()
            with ThreadPoolExecutor(max_workers=8) as workers:
                responses = list(workers.map(lambda _: auth.request(send, eval_runner.DEFAULT_ENDPOINT), range(8)))
            self.assertTrue(all(response.status_code == 200 for response in responses))
            self.assertEqual(exchange.call_count, 2)
            self.assertEqual(auth._refresh_token, "fixture-rotated-refresh")

    def test_refresh_cannot_change_users_or_accept_invalid_session_metadata(self):
        invalid = [self.session("second") | {"access_token": self.jwt(user_id="different-user")},
                   self.session("second") | {"access_token": "header.W10.signature"}]
        invalid += [self.session("second") | {"expires_in": value} for value in (None, True, "fixture-secret", 0, -1, float("nan"), float("inf"), 10 ** 1000)]
        invalid += [self.session("second") | {"access_token": self.jwt(expiry=value)} for value in (None, 0, "fixture-secret", float("nan"))]
        for index, session in enumerate(invalid):
            with self.subTest(index=index), patch.dict(os.environ, self.environment, clear=True), \
                    patch.object(eval_runner.requests, "post", side_effect=[
                        self.response(self.session()), self.response(session)]) as request, \
                    patch.object(eval_runner.time, "monotonic", return_value=0) as clock:
                auth = eval_runner.EvaluationAuth()
                before = auth.get_token()
                clock.return_value = 3550
                with self.assertRaises(eval_runner.EvaluationAuthError) as error:
                    auth.get_token()
                self.assertNotIn("fixture-secret", str(error.exception))
                self.assertEqual(auth._access_token, before)
                self.assertEqual(auth._user_id, "fixture-user")
                with self.assertRaises(eval_runner.EvaluationAuthError):
                    auth.get_token()
                self.assertEqual(request.call_count, 2)

    def test_401_is_retried_once_with_new_bearer_and_counted(self):
        unauthorized, answer = self.response(status=401), self.response()
        with patch.dict(os.environ, self.environment, clear=True), \
                patch.object(eval_runner.requests, "post", side_effect=[
                    self.response(self.session()), self.response(self.session("second"))]), \
                patch.object(eval_runner.time, "monotonic", return_value=0):
            auth = eval_runner.EvaluationAuth()
            send = Mock(side_effect=[unauthorized, answer])
            retries = {"request": 0}
            self.assertIs(auth.request(send, eval_runner.DEFAULT_ENDPOINT, retries=retries), answer)
            self.assertEqual(send.call_count, 2)
            self.assertEqual(send.call_args_list[0].kwargs["headers"]["Authorization"], "Bearer " + self.jwt())
            self.assertEqual(send.call_args_list[1].kwargs["headers"]["Authorization"], "Bearer " + self.jwt(nonce="second"))
            self.assertFalse(send.call_args.kwargs["allow_redirects"])
            self.assertEqual(retries["request"], 1)
            unauthorized.close.assert_called_once()

    def test_repeated_401_or_403_stops_without_another_login(self):
        for statuses in [(401, 401), (403,)]:
            with self.subTest(statuses=statuses), patch.dict(os.environ, self.environment, clear=True), \
                    patch.object(eval_runner.requests, "post", side_effect=[
                        self.response(self.session()), self.response(self.session("second"))]) as exchange:
                auth = eval_runner.EvaluationAuth()
                send = Mock(side_effect=[self.response(status=status) for status in statuses])
                with self.assertRaises(eval_runner.EvaluationAuthError):
                    auth.request(send, eval_runner.DEFAULT_ENDPOINT)
                self.assertEqual(send.call_count, len(statuses))
                self.assertEqual(exchange.call_count, 2 if statuses[0] == 401 else 1)
                with self.assertRaises(eval_runner.EvaluationAuthError):
                    auth.get_token()

    def test_authentication_and_project_errors_never_reach_quality_scoring(self):
        for status in (401, 403, 404):
            for streaming in (False, True):
                response = self.response(status=status)
                with self.subTest(status=status, streaming=streaming), \
                        patch.dict(os.environ, {"EVAL_ACCESS_TOKEN": self.jwt()}, clear=True), \
                        patch.object(eval_runner.requests, "post", return_value=response) as request, \
                        patch.object(eval_runner, "check_answer") as score, \
                        patch.object(eval_runner, "evaluate_with_llm_judge") as judge:
                    with self.assertRaises(eval_runner.EvaluationAuthError):
                        eval_runner.evaluate_query({"id": 1, "query": "Fixture"}, eval_runner.DEFAULT_ENDPOINT,
                                                   streaming, "strict", "fixture-judge-key", "fixture-model")
                    request.assert_called_once()
                    response.close.assert_called_once()
                    response.iter_lines.assert_not_called()
                    response.json.assert_not_called()
                    score.assert_not_called()
                    judge.assert_not_called()

    def test_404_response_is_closed_before_project_error_in_both_modes(self):
        for streaming in (False, True):
            response = self.response(status=404)
            with self.subTest(streaming=streaming), \
                    patch.dict(os.environ, {"EVAL_ACCESS_TOKEN": self.jwt()}, clear=True), \
                    patch.object(eval_runner.requests, "post", return_value=response):
                auth = eval_runner.EvaluationAuth()

                def fail_after_close(message):
                    response.close.assert_called_once()
                    raise eval_runner.EvaluationAuthError(message)

                with patch.object(auth, "fail", side_effect=fail_after_close) as fail:
                    with self.assertRaises(eval_runner.EvaluationAuthError):
                        eval_runner.evaluate_query({"id": 1, "query": "Fixture"}, eval_runner.DEFAULT_ENDPOINT,
                                                   streaming, "strict", "fixture-judge-key", "fixture-model", auth=auth)
                fail.assert_called_once()
                response.close.assert_called_once()

    def test_release_still_requires_a_second_user_before_any_network_request(self):
        for missing in (None, "", "  "):
            environment = dict(self.environment)
            if missing is not None:
                environment["EVAL_OTHER_ACCESS_TOKEN"] = missing
            with self.subTest(missing=missing), patch.dict(os.environ, environment, clear=True), \
                    patch("sys.argv", ["eval_runner", "--full", "--stream", "--release"]), \
                    patch.object(eval_runner, "EvaluationAuth") as auth, \
                    patch.object(eval_runner, "get_judge_api_key", return_value="fixture-judge-key"), \
                    patch.object(eval_runner, "evaluate_query") as query, \
                    patch.object(eval_runner.requests, "get") as get, \
                    patch.object(eval_runner.requests, "post") as post, \
                    contextlib.redirect_stderr(io.StringIO()) as diagnostic:
                with self.assertRaises(SystemExit) as error:
                    eval_runner.main()
                self.assertEqual(error.exception.code, 2)
                self.assertIn("EVAL_OTHER_ACCESS_TOKEN", diagnostic.getvalue())
                auth.assert_not_called()
                query.assert_not_called()
                get.assert_not_called()
                post.assert_not_called()

    def test_release_rejects_two_tokens_for_the_same_user(self):
        with patch.dict(os.environ, {"EVAL_ACCESS_TOKEN": self.jwt(),
                                     "EVAL_OTHER_ACCESS_TOKEN": self.jwt(nonce="other-session")}, clear=True), \
                patch("sys.argv", ["eval_runner", "--full", "--stream", "--release"]), \
                patch.object(eval_runner, "get_judge_api_key", return_value="fixture-judge-key"), \
                patch.object(eval_runner, "check_isolation") as isolation, \
                patch.object(eval_runner, "evaluate_query") as query, \
                patch.object(eval_runner.requests, "post") as post, \
                contextlib.redirect_stderr(io.StringIO()) as diagnostic:
            with self.assertRaises(SystemExit) as error:
                eval_runner.main()
            self.assertEqual(error.exception.code, 2)
            self.assertIn("distinct authenticated users", diagnostic.getvalue())
            isolation.assert_not_called()
            query.assert_not_called()
            post.assert_not_called()

    def test_authentication_failure_exits_two_without_creating_artifacts(self):
        with patch.dict(os.environ, {}, clear=True), patch("sys.argv", ["eval_runner", "--smoke"]), \
                patch.object(eval_runner, "get_judge_api_key", return_value=""), \
                patch.object(eval_runner.os, "makedirs") as mkdir, \
                patch.object(eval_runner.requests, "post") as request, \
                contextlib.redirect_stderr(io.StringIO()) as diagnostic:
            with self.assertRaises(SystemExit) as error:
                eval_runner.main()
            self.assertEqual(error.exception.code, 2)
            self.assertIn("No quality verdict", diagnostic.getvalue())
            mkdir.assert_not_called()
            request.assert_not_called()

    def test_isolation_receives_memory_session_and_keeps_second_user_and_anonymous_probes(self):
        first, second = "first-project", "second-project"
        auth = Mock()
        auth.get_token.return_value = "fixture-primary-token"
        auth.request.side_effect = [self.response({"project": {"id": first}}),
                                   self.response(status=404), self.response(status=404), self.response(status=404)]
        with patch.dict(os.environ, {"EVAL_PROJECT_ID": first, "EVAL_OTHER_PROJECT_ID": second,
                                     "EVAL_OTHER_ACCESS_TOKEN": "fixture-other-token"}, clear=True), \
                patch.object(security_checks.requests, "get", side_effect=[
                    self.response({"project": {"id": second}}), self.response(status=404),
                    self.response(status=404), self.response(status=401)]) as get, \
                patch.object(security_checks.requests, "post", return_value=self.response(status=404)) as post:
            self.assertTrue(security_checks.check_isolation(eval_runner.DEFAULT_ENDPOINT, auth=auth)[0])
            self.assertEqual(auth.request.call_count, 4)
            self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer fixture-other-token")
            self.assertNotIn("headers", get.call_args.kwargs)
            self.assertFalse(get.call_args.kwargs["allow_redirects"])

    def test_isolation_rejects_missing_shared_or_foreign_project_fixtures(self):
        for second in (None, "first-project"):
            environment = {"EVAL_ACCESS_TOKEN": "fixture-primary-token", "EVAL_OTHER_ACCESS_TOKEN": "fixture-other-token",
                           "EVAL_PROJECT_ID": "first-project"}
            if second is not None:
                environment["EVAL_OTHER_PROJECT_ID"] = second
            with self.subTest(second=second), patch.dict(os.environ, environment, clear=True), \
                    patch.object(security_checks.requests, "get") as get:
                self.assertFalse(security_checks.check_isolation(eval_runner.DEFAULT_ENDPOINT)[0])
                get.assert_not_called()
        with patch.dict(os.environ, {**environment, "EVAL_OTHER_PROJECT_ID": "second-project"}, clear=True), \
                patch.object(security_checks.requests, "get", side_effect=[
                    self.response({"project": {"id": "first-project"}}), self.response(status=200)]), \
                patch.object(security_checks.requests, "post") as post:
            self.assertFalse(security_checks.check_isolation(eval_runner.DEFAULT_ENDPOINT)[0])
            post.assert_not_called()

    def test_unsafe_urls_and_cross_origin_bearer_requests_are_rejected(self):
        with patch.dict(os.environ, {**self.environment, "NEXT_PUBLIC_SUPABASE_URL": "http://remote.invalid"}, clear=True), \
                patch.object(eval_runner.requests, "post") as request:
            with self.assertRaises(eval_runner.EvaluationAuthError):
                eval_runner.EvaluationAuth()
            request.assert_not_called()
        with patch.dict(os.environ, {"EVAL_ACCESS_TOKEN": self.jwt()}, clear=True):
            auth = eval_runner.EvaluationAuth()
            send = Mock()
            with self.assertRaises(eval_runner.EvaluationAuthError):
                auth.request(send, "https://other.invalid/api/projects")
            send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
