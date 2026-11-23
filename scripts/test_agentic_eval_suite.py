import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import agentic_eval_suite as suite


class FakeStreamResponse:
    def __init__(self, frames, status_code=200):
        self.status_code = status_code
        self.headers = {"content-type": "text/event-stream"}
        self._bytes = b"".join(frames)

    def iter_content(self, chunk_size=1, decode_unicode=False):
        for b in [self._bytes[i:i + chunk_size] for i in range(0, len(self._bytes), chunk_size)]:
            yield b


class AgenticEvalSuiteTests(unittest.TestCase):
    def test_40_case_dataset_is_valid_and_grounded(self):
        dataset = Path(__file__).resolve().parents[1] / "evals/agentic_eval_40.jsonl"
        cases = suite.load_eval_dataset(dataset)
        self.assertEqual(len(cases), 40)
        self.assertEqual(sum(1 for c in cases if c["workspace"] == "personal"), 15)
        self.assertEqual(sum(1 for c in cases if c["workspace"] == "enterprise"), 25)
        for case in cases:
            if case["expected_behavior"] in ("answer", "answer_with_clarification"):
                self.assertTrue(
                    suite.expected_chunks_for_case(case),
                    f"{case['case_id']} must reference actual indexed chunk_ids",
                )

    def test_retrieval_metrics_recall_precision_mrr(self):
        m = suite.compute_retrieval_metrics(["c1", "c2"], ["c0", "c2", "c3", "c1"], k=4)
        self.assertEqual(m["recall_at_k"], 1.0)
        self.assertEqual(m["precision_at_k"], 0.5)
        self.assertEqual(m["mrr"], 0.5)

        empty = suite.compute_retrieval_metrics(["c1"], [], k=8)
        self.assertEqual(empty, {"recall_at_k": 0.0, "precision_at_k": 0.0, "mrr": 0.0})

    def test_citation_contract_handles_answers_and_refusals(self):
        self.assertTrue(suite.check_citation_contract("Rule applies [Chunk 1].", [{"id": "c1", "index": 1}], "answer"))
        self.assertFalse(suite.check_citation_contract("Rule applies [Chunk 2].", [{"id": "c1", "index": 1}], "answer"))
        self.assertTrue(suite.check_citation_contract(suite.ENTERPRISE_REFUSAL, [], "refuse"))
        self.assertFalse(suite.check_citation_contract(suite.ENTERPRISE_REFUSAL, [], "answer"))

    def test_offline_evaluation_writes_artifacts_without_live_calls(self):
        dataset = Path(__file__).resolve().parents[1] / "evals/agentic_eval_40.jsonl"
        cases = suite.load_eval_dataset(dataset)
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            out = suite.evaluate_offline(cases, dataset, None, None)
            suite.write_outputs(out_dir, out["summary"], out["results"], "test_offline")
            self.assertTrue((out_dir / "test_offline_summary.json").exists())
            self.assertTrue((out_dir / "test_offline_results.json").exists())
            self.assertTrue((out_dir / "test_offline_results.csv").exists())
            summary = json.loads((out_dir / "test_offline_summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["total_cases"], 40)
            self.assertEqual(summary["workspace_summaries"]["enterprise"]["rag_quality"]["retrieval_recall_at_8"], "NOT_RUN")
            self.assertEqual(summary["agentic_capabilities_audit"]["llm_multi_step_tool_calling_loop"], "NOT_IMPLEMENTED")

    def test_identity_eligibility_marks_unavailable_grants_and_foreign_dept_not_run(self):
        dataset = Path(__file__).resolve().parents[1] / "evals/agentic_eval_40.jsonl"
        cases = {c["case_id"]: c for c in suite.load_eval_dataset(dataset)}
        self.assertTrue(suite.is_identity_eligible(cases["E01"], "Engineering", "manager", set(), set(), True, True)[0])
        self.assertTrue(suite.is_identity_eligible(cases["E07"], "Engineering", "manager", set(), set(), True, True)[0])
        self.assertTrue(suite.is_identity_eligible(cases["E10"], "Engineering", "manager", set(), set(), True, True)[0])
        self.assertTrue(suite.is_identity_eligible(cases["E15"], "Engineering", "manager", set(), set(), True, True)[0])
        self.assertFalse(suite.is_identity_eligible(cases["E09"], "Engineering", "manager", set(), set(), True, True)[0])
        self.assertFalse(suite.is_identity_eligible(cases["E12"], "Engineering", "manager", set(), set(), True, True)[0])
        self.assertFalse(suite.is_identity_eligible(cases["E13"], "Engineering", "manager", set(), set(), True, True)[0])
        self.assertFalse(suite.is_identity_eligible(cases["E14"], "Engineering", "manager", set(), set(), True, True)[0])
        self.assertFalse(suite.is_identity_eligible(cases["E23"], "Engineering", "manager", set(), set(), True, True)[0])
        self.assertFalse(suite.is_identity_eligible(cases["E10"], "Engineering", "cxo", set(), set(), True, True)[0])
        self.assertFalse(suite.is_identity_eligible(cases["E11"], "Engineering", "cxo", set(), set(), True, True)[0])
        self.assertFalse(suite.is_identity_eligible(cases["E15"], "Engineering", "cxo", set(), set(), True, True)[0])
        self.assertFalse(suite.is_identity_eligible(cases["E21"], "Engineering", "cxo", set(), set(), True, True)[0])
        self.assertTrue(suite.is_identity_eligible(cases["E01"], "Engineering", "cxo", set(), set(), True, True)[0])
        self.assertTrue(suite.is_identity_eligible(cases["E22"], "Engineering", "cxo", set(), set(), True, True)[0])

    def test_sse_stream_parser_preserves_multibyte_utf8_across_1byte_chunks(self):
        frames = [
            b'data: {"type":"metadata","citations":[{"id":"c1","index":1}]}\n\n',
            "data: {\"type\":\"text\",\"text\":\"Employee → Manager – CXO (₹500) \"}\n\n".encode("utf-8"),
            b'data: {"type":"text","text":"[Chunk 1]."}\n\n',
            b'data: {"type":"finish","metrics":{"ttft_ms":420,"total_ms":650,"token_usage":{"prompt":100,"completion":12,"total":112}}}\n\n',
        ]
        parsed = suite.parse_sse_response(FakeStreamResponse(frames), started_at=0.0)
        self.assertEqual(parsed["text"], "Employee → Manager – CXO (₹500) [Chunk 1].")
        self.assertNotIn("\ufffd", parsed["text"])
        self.assertEqual(len(parsed["citations"]), 1)
        self.assertEqual(parsed["metrics"]["ttft_ms"], 420)
        self.assertIsNotNone(parsed["client_ttft_ms"])

    def test_restricted_denial_scoring_excludes_retrieval_denominator_and_asserts_zero_leak(self):
        dataset = Path(__file__).resolve().parents[1] / "evals/agentic_eval_40.jsonl"
        cases = {c["case_id"]: c for c in suite.load_eval_dataset(dataset)}
        clean = suite.score_live_case(cases["E10"], 200, suite.ENTERPRISE_REFUSAL, [], total_tokens=13)
        self.assertTrue(clean["task_check_passed"])
        self.assertTrue(clean["zero_unauthorized_chunks_exposed"])
        self.assertTrue(clean["access_denial_correct"])
        self.assertIsNone(clean["retrieval_recall_at_8"])
        self.assertIsNone(clean["retrieval_precision_at_8"])
        self.assertIsNone(clean["retrieval_mrr"])

        leaked = suite.score_live_case(
            cases["E10"],
            200,
            suite.ENTERPRISE_REFUSAL,
            [{"index": 1, "id": "ceeef1d0-8fc4-4baa-9123-6844a0ffd42c"}],
            total_tokens=13,
        )
        self.assertFalse(leaked["task_check_passed"])
        self.assertFalse(leaked["zero_unauthorized_chunks_exposed"])
        self.assertFalse(leaked["access_denial_correct"])

    def test_precision_at_8_not_measured_on_enterprise_but_measured_on_personal(self):
        dataset = Path(__file__).resolve().parents[1] / "evals/agentic_eval_40.jsonl"
        cases = {c["case_id"]: c for c in suite.load_eval_dataset(dataset)}
        ent = suite.score_live_case(
            cases["E01"],
            200,
            "Eight departments [Chunk 1].",
            [{"index": 1, "id": "9b09d94f-7923-4361-8f2f-ce429c36ece3"}],
            total_tokens=500,
        )
        self.assertEqual(ent["retrieval_precision_at_8"], "NOT_MEASURED")
        self.assertEqual(ent["retrieval_recall_at_8"], "NOT_MEASURED")
        self.assertEqual(ent["retrieval_mrr"], "NOT_MEASURED")
        self.assertEqual(ent["cited_precision"], 1.0)
        self.assertEqual(ent["retrieval_metrics_status"], "NOT_MEASURED_POST_FILTERED_CITATIONS")

        pers = suite.score_live_case(
            cases["P01"],
            200,
            "Fewer than 10,000 chunks [Chunk 2].",
            [
                {"index": 1, "id": "other-id"},
                {"index": 2, "id": "38a01af9-01da-4e13-a7b3-2d75715422c6"},
            ],
            total_tokens=500,
        )
        self.assertEqual(pers["retrieval_precision_at_8"], 0.5)
        self.assertEqual(pers["retrieval_recall_at_8"], 0.5)
        self.assertEqual(pers["retrieval_mrr"], 0.5)
        self.assertEqual(pers["cited_precision"], 1.0)
        self.assertEqual(pers["retrieval_metrics_status"], "MEASURED_RAW_TOP_K")

    def test_missing_evidence_and_refusal_cases_handled_consistently(self):
        dataset = Path(__file__).resolve().parents[1] / "evals/agentic_eval_40.jsonl"
        cases = {c["case_id"]: c for c in suite.load_eval_dataset(dataset)}
        missing = suite.score_live_case(cases["P01"], 200, "Answer without chunks.", [], total_tokens=100)
        self.assertFalse(missing["task_check_passed"])
        self.assertFalse(missing["citation_accuracy"])
        self.assertEqual(missing["retrieval_recall_at_8"], 0.0)
        self.assertIsNone(missing["cited_precision"])

        p11 = suite.score_live_case(cases["P11"], 200, suite.PERSONAL_REFUSAL, [], total_tokens=150)
        self.assertTrue(p11["task_check_passed"])
        self.assertTrue(p11["abstention_correct"])
        self.assertTrue(p11["zero_unauthorized_chunks_exposed"])
        self.assertIsNone(p11["retrieval_recall_at_8"])

    def test_run_live_stops_immediately_on_unexpected_auth_error(self):
        dataset = Path(__file__).resolve().parents[1] / "evals/agentic_eval_40.jsonl"
        cases = suite.load_eval_dataset(dataset)

        class Fake401:
            status_code = 401
            headers = {"content-type": "application/json"}
            def json(self):
                return {"error": "Unauthorized"}

        with patch.dict("os.environ", {"EVAL_PERSONAL_ACCESS_TOKEN": "tok", "EVAL_ENTERPRISE_ACCESS_TOKEN": "tok2"}), \
             patch.object(suite, "load_dotenv"), \
             patch.object(suite.requests, "post", return_value=Fake401()) as post:
            out = suite.run_live(cases, "http://127.0.0.1:3000/api/chat", stream=True, max_cases=10, selected_ids={"P01", "P05"})
            self.assertEqual(post.call_count, 1)
            self.assertIn("unexpected HTTP 401", out["summary"]["aborted_reason"])

    def test_authorized_unanswerable_p10_does_not_flag_false_leak_and_captures_agent_trace(self):
        dataset = Path(__file__).resolve().parents[1] / "evals/agentic_eval_40.jsonl"
        cases_list = suite.load_eval_dataset(dataset)
        cases = {c["case_id"]: c for c in cases_list}
        p10 = suite.score_live_case(
            cases["P10"],
            200,
            suite.PERSONAL_REFUSAL,
            [{"index": 1, "id": "57cacc8d-c4a2-4676-82cf-05ab8a7172f9"}],
            total_tokens=200,
        )
        self.assertTrue(p10["task_check_passed"])
        self.assertTrue(p10["zero_unauthorized_chunks_exposed"])
        self.assertTrue(p10["abstention_correct"])

        frames = [
            b'data: {"type":"metadata","citations":[]}\n\n',
            b'data: {"type":"text","text":"Hello! How can I help you?"}\n\n',
            b'data: {"type":"finish","metrics":{"ttft_ms":10,"total_ms":15,"token_usage":{"prompt":0,"completion":0,"total":0},"agent":{"tool":"deterministic_reply","steps":2,"max_steps":6,"retrieval_attempts":0,"max_retrieval_attempts":2,"reformulated":false,"evidence_sufficient":true,"evidence_reason":"deterministic_short_circuit"}}}\n\n',
        ]
        with patch.dict("os.environ", {"EVAL_PERSONAL_ACCESS_TOKEN": "tok", "EVAL_ENTERPRISE_ACCESS_TOKEN": "tok2"}), \
             patch.object(suite, "load_dotenv"), \
             patch.object(suite.requests, "post", return_value=FakeStreamResponse(frames)):
            out = suite.run_live(cases_list, "http://127.0.0.1:3000/api/chat", stream=True, max_cases=1, selected_ids={"P15"})
            row = out["results"][0]
            self.assertEqual(row["agent_tool"], "deterministic_reply")
            self.assertEqual(row["agent_steps"], 2)
            self.assertEqual(row["retrieval_attempts"], 0)
            ws_agent = out["summary"]["workspace_summaries"]["personal"]["agent_loop"]
            self.assertEqual(ws_agent["tool_counts"], {"deterministic_reply": 1})
            self.assertEqual(ws_agent["max_observed_steps"], 2)
            self.assertFalse(out["summary"]["judge_enabled"])
            self.assertEqual(row["judge_status"], "NOT_RUN")

    def test_optional_gemini_judge_live_sse_and_outputs(self):
        dataset = Path(__file__).resolve().parents[1] / "evals/agentic_eval_40.jsonl"
        cases_list = suite.load_eval_dataset(dataset)
        sse_personal = [
            b'data: {"type":"metadata","citations":[{"index":1,"id":"38a01af9-01da-4e13-a7b3-2d75715422c6"}]}\n\n',
            b'data: {"type":"text","text":"Avoid Kafka and Kubernetes below 10,000 chunks [Chunk 1]."}\n\n',
            b'data: {"type":"finish","context":"[Chunk 1]: Avoid Kafka and Kubernetes for fewer than 10,000 chunks.","metrics":{"ttft_ms":100,"total_ms":200,"token_usage":{"prompt":120,"completion":18,"total":138},"agent":{"tool":"rag_retrieval","steps":4,"max_steps":6,"retrieval_attempts":1,"max_retrieval_attempts":2,"reformulated":false,"evidence_sufficient":true,"evidence_reason":"sufficient_evidence"}}}\n\n',
        ]
        sse_enterprise = [
            b'data: {"type":"metadata","citations":[{"index":1,"id":"9b09d94f-7923-4361-8f2f-ce429c36ece3"}]}\n\n',
            b'data: {"type":"text","text":"DeccanBridge has eight departments and Employee->Manager->CXO levels; CEO/COO have Executive affiliation [Chunk 1]."}\n\n',
            b'data: {"type":"finish","context":"[Chunk 1]: Eight functional departments; levels Employee->Manager->CXO; CEO and COO hold Executive affiliation.","metrics":{"ttft_ms":110,"total_ms":220,"token_usage":{"prompt":200,"completion":25,"total":225},"agent":{"tool":"rag_retrieval","steps":4,"max_steps":6,"retrieval_attempts":1,"max_retrieval_attempts":2,"reformulated":false,"evidence_sufficient":true,"evidence_reason":"sufficient_evidence"}}}\n\n',
        ]

        class FakeGeminiResponse:
            def __init__(self, payload, status_code=200):
                self.status_code = status_code
                self._payload = payload

            def json(self):
                return self._payload

            def close(self):
                return None

        judge_calls = []

        def fake_post(url, **kwargs):
            if "generativelanguage.googleapis.com" in url:
                judge_calls.append({"url": url, "headers": kwargs.get("headers"), "json": kwargs.get("json")})
                return FakeGeminiResponse({
                    "candidates": [{
                        "finishReason": "STOP",
                        "content": {
                            "parts": [{
                                "text": json.dumps({
                                    "answer_correctness_score": 5,
                                    "faithfulness_score": 5,
                                    "unsupported_claims_score": 5,
                                    "unsupported_claims_count": 0,
                                    "passed": True,
                                    "explanation": "Accurate and fully supported by authorized context.",
                                })
                            }]
                        },
                    }],
                    "usageMetadata": {"promptTokenCount": 310, "candidatesTokenCount": 42, "totalTokenCount": 352},
                })
            body = kwargs.get("json") or {}
            if body.get("projectId"):
                return FakeStreamResponse(sse_personal)
            return FakeStreamResponse(sse_enterprise)

        secret_key = "AIzaTestJudgeSecretKey12345"
        with patch.dict("os.environ", {
            "EVAL_PERSONAL_ACCESS_TOKEN": "tok",
            "EVAL_ENTERPRISE_ACCESS_TOKEN": "tok2",
            "GOOGLE_GENERATIVE_AI_API_KEY": secret_key,
        }), patch.object(suite, "load_dotenv"), patch.object(suite.requests, "post", side_effect=fake_post):
            out = suite.run_live(
                cases_list,
                "http://127.0.0.1:3000/api/chat",
                stream=True,
                max_cases=2,
                selected_ids={"P01", "E01"},
                judge=True,
            )

        self.assertEqual(len(judge_calls), 2)
        for call in judge_calls:
            self.assertEqual(call["headers"]["x-goog-api-key"], secret_key)
            self.assertNotIn(secret_key, call["url"])
        self.assertTrue(out["summary"]["judge_enabled"])
        self.assertEqual(out["summary"]["judge_model_id"], suite.DEFAULT_JUDGE_MODEL)

        p_sum = out["summary"]["workspace_summaries"]["personal"]["llm_judge_evaluation"]
        e_sum = out["summary"]["workspace_summaries"]["enterprise"]["llm_judge_evaluation"]
        self.assertIn("LLM-judged (not human-verified)", p_sum["verification_notice"])
        self.assertEqual(p_sum["judged_cases"], 1)
        self.assertEqual(p_sum["mean_answer_correctness"], 5.0)
        self.assertEqual(p_sum["judge_total_tokens"], 352)
        self.assertEqual(e_sum["judged_cases"], 1)
        self.assertEqual(e_sum["judge_pass_rate_pct"], 100.0)
        # RAG tokens remain isolated from judge tokens.
        self.assertEqual(out["summary"]["workspace_summaries"]["personal"]["performance"]["total_tokens"], 138)

        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            suite.write_outputs(out_dir, out["summary"], out["results"], "judge_live")
            csv_text = (out_dir / "judge_live_results.csv").read_text(encoding="utf-8")
            results_text = (out_dir / "judge_live_results.json").read_text(encoding="utf-8")
            self.assertIn("judge_model_id", csv_text)
            self.assertIn("judge_answer_correctness", csv_text)
            self.assertNotIn(secret_key, csv_text)
            self.assertNotIn(secret_key, results_text)
            self.assertNotIn("Avoid Kafka and Kubernetes for fewer than 10,000 chunks.", results_text)

    def test_gemini_judge_edge_cases_no_evidence_malformed_rls_and_rate_limit(self):
        dataset = Path(__file__).resolve().parents[1] / "evals/agentic_eval_40.jsonl"
        cases = {c["case_id"]: c for c in suite.load_eval_dataset(dataset)}

        class FakeGeminiResponse:
            def __init__(self, status_code, payload=None):
                self.status_code = status_code
                self._payload = payload or {}

            def json(self):
                return self._payload

            def close(self):
                return None

        # 1. Unavailable authorized evidence -> faithfulness & unsupported claims forced NOT_MEASURED.
        prompt_capture = []

        def no_evidence_post(_url, **kwargs):
            prompt_capture.append(kwargs["json"]["contents"][0]["parts"][0]["text"])
            return FakeGeminiResponse(200, {
                "candidates": [{
                    "finishReason": "STOP",
                    "content": {
                        "parts": [{
                            "text": json.dumps({
                                "answer_correctness_score": 4,
                                "faithfulness_score": 5,
                                "unsupported_claims_score": 5,
                                "unsupported_claims_count": 0,
                                "passed": True,
                                "explanation": "Matches ground truth.",
                            })
                        }]
                    },
                }],
                "usageMetadata": {"promptTokenCount": 50, "candidatesTokenCount": 20, "totalTokenCount": 70},
            })

        with patch.object(suite.requests, "post", side_effect=no_evidence_post):
            res_no_ev = suite.evaluate_case_with_gemini_judge(
                cases["P01"],
                status_code=200,
                text="Fewer than 10,000 chunks.",
                citations=[],
                eval_context="",
                api_key="test-key",
            )
        self.assertEqual(res_no_ev["judge_status"], "JUDGED_NO_EVIDENCE")
        self.assertEqual(res_no_ev["judge_answer_correctness"], 4)
        self.assertEqual(res_no_ev["judge_faithfulness"], "NOT_MEASURED")
        self.assertEqual(res_no_ev["judge_unsupported_claims_score"], "NOT_MEASURED")
        self.assertEqual(res_no_ev["judge_unsupported_claims_count"], "NOT_MEASURED")
        self.assertNotIn('"authorized_evidence":', prompt_capture[0])

        # 2. Malformed JSON output -> JUDGE_ERROR without changing RAG outcome.
        malformed_resp = FakeGeminiResponse(200, {
            "candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "not valid json {{"}]}}],
            "usageMetadata": {"promptTokenCount": 40, "candidatesTokenCount": 5, "totalTokenCount": 45},
        })
        with patch.object(suite.requests, "post", return_value=malformed_resp):
            res_bad = suite.evaluate_case_with_gemini_judge(
                cases["P01"],
                status_code=200,
                text="Fewer than 10,000 chunks [Chunk 1].",
                citations=[{"index": 1, "id": "c1", "content": "Fewer than 10,000 chunks."}],
                eval_context="[Chunk 1]: Fewer than 10,000 chunks.",
                api_key="test-key",
            )
        self.assertEqual(res_bad["judge_status"], "JUDGE_ERROR")
        self.assertIsNone(res_bad["judge_answer_correctness"])
        self.assertEqual(res_bad["judge_total_tokens"], 45)

        # 3. RLS / security denial case -> deterministic NOT_MEASURED with 0 Gemini calls.
        with patch.object(suite.requests, "post") as post_mock:
            res_rls = suite.evaluate_case_with_gemini_judge(
                cases["E10"],
                status_code=200,
                text=suite.ENTERPRISE_REFUSAL,
                citations=[],
                eval_context="",
                api_key="test-key",
            )
            res_denied = suite.evaluate_case_with_gemini_judge(
                cases["P12"],
                status_code=404,
                text="",
                citations=[],
                eval_context="",
                api_key="test-key",
            )
            post_mock.assert_not_called()
        self.assertEqual(res_rls["judge_status"], "NOT_MEASURED")
        self.assertEqual(res_denied["judge_status"], "NOT_MEASURED")

        # 4. Rate-limit 429 retries bounded to max 2 retries (3 total attempts) -> JUDGE_ERROR.
        with patch.object(suite.requests, "post", return_value=FakeGeminiResponse(429)) as rate_post, \
             patch.object(suite.time, "sleep"):
            res_429 = suite.evaluate_case_with_gemini_judge(
                cases["P01"],
                status_code=200,
                text="Fewer than 10,000 chunks [Chunk 1].",
                citations=[{"index": 1, "id": "c1", "content": "Fewer than 10,000 chunks."}],
                eval_context="[Chunk 1]: Fewer than 10,000 chunks.",
                api_key="test-key",
            )
        self.assertEqual(rate_post.call_count, 3)
        self.assertEqual(res_429["judge_status"], "JUDGE_ERROR")
        self.assertIn("429", res_429["judge_explanation"])

    def test_offline_mode_with_judge_flag_never_calls_gemini(self):
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(suite.requests, "post") as post_mock, \
             patch.object(suite.sys, "argv", [
                 "agentic_eval_suite.py",
                 "--mode", "offline",
                 "--judge",
                 "--output-dir", tmp,
                 "--output-prefix", "offline_judge_check",
             ]):
            rc = suite.main()
            self.assertEqual(rc, 0)
            post_mock.assert_not_called()
            summary = json.loads((Path(tmp) / "offline_judge_check_summary.json").read_text(encoding="utf-8"))
            self.assertFalse(summary["workspace_summaries"]["personal"]["llm_judge_evaluation"]["judge_enabled"])
            self.assertFalse(summary["workspace_summaries"]["enterprise"]["llm_judge_evaluation"]["judge_enabled"])

    def test_gemini_judge_503_retry_exhaustion_keeps_not_measured_and_preserves_rag_scores(self):
        dataset = Path(__file__).resolve().parents[1] / "evals/agentic_eval_40.jsonl"
        cases_list = suite.load_eval_dataset(dataset)
        cases = {c["case_id"]: c for c in cases_list}

        class FakeGeminiResponse:
            def __init__(self, status_code, payload=None, headers=None):
                self.status_code = status_code
                self._payload = payload or {}
                self.headers = headers or {}

            def json(self):
                return self._payload

            def close(self):
                return None

        # 1. Transient HTTP 503 recovers on retry and respects Retry-After cap.
        attempts = []

        def recover_post(_url, **kwargs):
            attempts.append(kwargs)
            if len(attempts) == 1:
                return FakeGeminiResponse(503, headers={"Retry-After": "1"})
            return FakeGeminiResponse(200, {
                "candidates": [{
                    "finishReason": "STOP",
                    "content": {
                        "parts": [{
                            "text": json.dumps({
                                "answer_correctness_score": 5,
                                "faithfulness_score": 5,
                                "unsupported_claims_score": 5,
                                "unsupported_claims_count": 0,
                                "passed": True,
                                "explanation": "Matches D04 triage target.",
                            })
                        }]
                    },
                }],
                "usageMetadata": {"promptTokenCount": 120, "candidatesTokenCount": 25, "totalTokenCount": 145},
            })

        sleep_calls = []
        with patch.object(suite.requests, "post", side_effect=recover_post), \
             patch.object(suite.time, "sleep", side_effect=lambda s: sleep_calls.append(s)):
            recovered = suite.evaluate_case_with_gemini_judge(
                cases["E07"],
                status_code=200,
                text="Critical bug triage target is 2 operational business hours [Chunk 1].",
                citations=[{"index": 1, "id": "a445d7ec-a541-4b88-9e36-c56d2818c758", "content": "Critical bug triage target: 2 hours."}],
                eval_context="[Chunk 1]: Critical bug triage target: 2 hours.",
                api_key="test-key",
            )
        self.assertEqual(len(attempts), 2)
        self.assertEqual(recovered["judge_status"], "JUDGED")
        self.assertEqual(recovered["judge_retries"], 1)
        self.assertEqual(recovered["judge_answer_correctness"], 5)
        self.assertEqual(len(sleep_calls), 1)
        self.assertGreaterEqual(sleep_calls[0], 1.0)

        # 2. Exhausted HTTP 503 on E07 judge leaves summary judge metrics NOT_MEASURED and preserves RAG metrics.
        sse_e07 = [
            b'data: {"type":"metadata","citations":[{"index":1,"id":"a445d7ec-a541-4b88-9e36-c56d2818c758"}]}\n\n',
            b'data: {"type":"text","text":"Critical bug triage target is 2 operational business hours with no fixed resolution SLA [Chunk 1]."}\n\n',
            b'data: {"type":"finish","context":"[Chunk 1]: Critical bug triage is 2 operational business hours; no fixed resolution time.","metrics":{"ttft_ms":100,"total_ms":200,"token_usage":{"prompt":200,"completion":25,"total":225},"agent":{"tool":"rag_retrieval","steps":4,"max_steps":6,"retrieval_attempts":1,"max_retrieval_attempts":2,"reformulated":false,"evidence_sufficient":true,"evidence_reason":"sufficient_evidence"}}}\n\n',
        ]

        def fail_judge_only(url, **kwargs):
            if "generativelanguage.googleapis.com" in url:
                return FakeGeminiResponse(503)
            return FakeStreamResponse(sse_e07)

        with patch.dict("os.environ", {
            "EVAL_PERSONAL_ACCESS_TOKEN": "tok",
            "EVAL_ENTERPRISE_ACCESS_TOKEN": "tok2",
            "GOOGLE_GENERATIVE_AI_API_KEY": "test-key",
        }), patch.object(suite, "load_dotenv"), \
             patch.object(suite.requests, "post", side_effect=fail_judge_only), \
             patch.object(suite.time, "sleep"):
            out = suite.run_live(
                cases_list,
                "http://127.0.0.1:3000/api/chat",
                stream=True,
                max_cases=1,
                selected_ids={"E07"},
                judge=True,
            )

        row = out["results"][0]
        self.assertEqual(row["case_id"], "E07")
        self.assertTrue(row["task_check_passed"])
        self.assertTrue(row["citation_accuracy"])
        self.assertEqual(row["judge_status"], "JUDGE_ERROR")
        self.assertEqual(row["judge_retries"], 2)
        self.assertIsNone(row["judge_answer_correctness"])
        ent_judge_sum = out["summary"]["workspace_summaries"]["enterprise"]["llm_judge_evaluation"]
        self.assertEqual(ent_judge_sum["judge_error_cases"], 1)
        self.assertEqual(ent_judge_sum["judge_pass_rate_pct"], "NOT_MEASURED")
        self.assertEqual(ent_judge_sum["mean_answer_correctness"], "NOT_MEASURED")
        self.assertEqual(ent_judge_sum["mean_faithfulness"], "NOT_MEASURED")
        self.assertEqual(ent_judge_sum["mean_unsupported_claims_score"], "NOT_MEASURED")

        # 3. Cancellation (KeyboardInterrupt) propagates immediately without retries.
        with patch.object(suite.requests, "post", side_effect=KeyboardInterrupt) as int_mock:
            with self.assertRaises(KeyboardInterrupt):
                suite.call_gemini_judge_rest("prompt", api_key="test-key")
        self.assertEqual(int_mock.call_count, 1)

    def test_rate_aware_pacing_separates_delays_from_latency_and_respects_safety_margin(self):
        dataset = Path(__file__).resolve().parents[1] / "evals/agentic_eval_40.jsonl"
        cases_list = suite.load_eval_dataset(dataset)
        fake_now = [0.0]
        sleeps = []

        def fake_clock():
            return fake_now[0]

        def fake_sleep(seconds):
            sleeps.append(seconds)
            fake_now[0] += seconds

        # rpm=10 with 0.75 safety margin -> effective RPM = 7.
        # Each Personal RAG + judge case estimates 4 chat + 1 embed = 5 shared requests (so case 1 fits, case 2 waits for 60s window reset).
        pacer = suite.GeminiRatePacer(
            enabled=True,
            rpm=10,
            tpm=100000,
            rpd=100,
            min_case_delay_s=2.0,
            safety_margin=0.75,
            clock=fake_clock,
            sleeper=fake_sleep,
        )
        self.assertEqual(pacer.effective_rpm, 7)
        self.assertEqual(pacer.effective_tpm, 75000)
        self.assertEqual(pacer.effective_rpd, 75)

        sse_p01 = [
            b'data: {"type":"metadata","citations":[{"index":1,"id":"38a01af9-01da-4e13-a7b3-2d75715422c6"}]}\n\n',
            b'data: {"type":"text","text":"Avoid Kafka and Kubernetes below 10,000 chunks [Chunk 1]."}\n\n',
            b'data: {"type":"finish","context":"[Chunk 1]: Avoid Kafka and Kubernetes for fewer than 10,000 chunks.","metrics":{"ttft_ms":120,"total_ms":250,"token_usage":{"prompt":120,"completion":20,"total":140},"agent":{"tool":"rag_retrieval","steps":4,"max_steps":6,"retrieval_attempts":1,"max_retrieval_attempts":2,"reformulated":false,"evidence_sufficient":true,"evidence_reason":"sufficient_evidence","final_outcome":"answer"}}}\n\n',
        ]
        sse_p03 = [
            b'data: {"type":"metadata","citations":[{"index":1,"id":"99a23026-aa88-47a7-922d-db1b8922735f"}]}\n\n',
            b'data: {"type":"text","text":"Start with 300-800 tokens [Chunk 1]."}\n\n',
            b'data: {"type":"finish","context":"[Chunk 1]: Start with 300-800 tokens.","metrics":{"ttft_ms":110,"total_ms":210,"token_usage":{"prompt":110,"completion":15,"total":125},"agent":{"tool":"rag_retrieval","steps":4,"max_steps":6,"retrieval_attempts":1,"max_retrieval_attempts":2,"reformulated":false,"evidence_sufficient":true,"evidence_reason":"sufficient_evidence","final_outcome":"answer"}}}\n\n',
        ]

        class FakeGeminiOk:
            status_code = 200
            def json(self):
                return {
                    "candidates": [{
                        "finishReason": "STOP",
                        "content": {"parts": [{"text": json.dumps({
                            "answer_correctness_score": 5,
                            "faithfulness_score": 5,
                            "unsupported_claims_score": 5,
                            "unsupported_claims_count": 0,
                            "passed": True,
                            "explanation": "Accurate.",
                        })}]},
                    }],
                    "usageMetadata": {"promptTokenCount": 300, "candidatesTokenCount": 30, "totalTokenCount": 330},
                }
            def close(self):
                return None

        chat_calls = []

        def fake_post(url, **kwargs):
            if "generativelanguage.googleapis.com" in url:
                return FakeGeminiOk()
            chat_calls.append(kwargs.get("json"))
            return FakeStreamResponse(sse_p01 if len(chat_calls) == 1 else sse_p03)

        with patch.dict("os.environ", {
            "EVAL_PERSONAL_ACCESS_TOKEN": "tok",
            "EVAL_ENTERPRISE_ACCESS_TOKEN": "tok2",
            "GOOGLE_GENERATIVE_AI_API_KEY": "test-key",
            "CHAT_MODEL": "gemini-3.5-flash-lite",
        }), patch.object(suite, "load_dotenv"), patch.object(suite.requests, "post", side_effect=fake_post):
            out = suite.run_live(
                cases_list,
                "http://127.0.0.1:3000/api/chat",
                stream=True,
                max_cases=2,
                selected_ids={"P01", "P03"},
                judge=True,
                judge_model="gemini-2.5-flash",
                pacer=pacer,
            )

        self.assertEqual(len(chat_calls), 2)
        # Verify intentional min_case_delay_s + 60s window wait happened without contaminating latency/TTFT.
        self.assertTrue(len(sleeps) >= 2)
        self.assertGreater(out["summary"]["rate_aware_pacing"]["total_pacing_wait_ms"], 59000.0)
        p_perf = out["summary"]["workspace_summaries"]["personal"]["performance"]
        self.assertLess(p_perf["p95_latency_ms"], 1000.0)
        self.assertLess(p_perf["p95_server_ttft_ms"], 500.0)
        # Models tracked separately + shared project usage recorded.
        model_usage = out["summary"]["rate_aware_pacing"]["model_usage"]
        self.assertIn("gemini-3.5-flash-lite", model_usage)
        self.assertIn("gemini-embedding-2", model_usage)
        self.assertIn("gemini-2.5-flash", model_usage)
        self.assertEqual(model_usage["gemini-embedding-2"]["requests"], 2)
        self.assertEqual(model_usage["gemini-2.5-flash"]["requests"], 2)
        self.assertEqual(
            out["summary"]["rate_aware_pacing"]["shared_usage"]["requests"],
            sum(m["requests"] for m in model_usage.values()),
        )

    def test_rate_aware_daily_quota_stops_gracefully_and_preserves_completed_and_merge(self):
        dataset = Path(__file__).resolve().parents[1] / "evals/agentic_eval_40.jsonl"
        cases_list = suite.load_eval_dataset(dataset)
        # Pre-seed P01 from an existing --merge-from artifact; set effective RPD = 6 so P03 executes once (5 reqs), then P05 stops cleanly.
        existing = {
            "P01": {
                "case_id": "P01",
                "workspace": "personal",
                "category": "direct_factual",
                "expected_behavior": "answer",
                "live_execution_status": "HTTP_200",
                "answer_text": "Fewer than 10,000 chunks [Chunk 1].",
                "citations_detail": [{"index": 1, "id": "38a01af9-01da-4e13-a7b3-2d75715422c6"}],
                "total_tokens": 200,
                "latency_ms": 500,
                "judge_status": "JUDGED",
                "judge_passed": True,
                "judge_answer_correctness": 5,
            }
        }
        pacer = suite.GeminiRatePacer(
            enabled=True,
            rpm=60,
            rpd=8,
            safety_margin=0.75,  # effective_rpd = 6; P03 uses 4 reqs, leaving <4 for P05
            clock=lambda: 0.0,
            sleeper=lambda _: None,
        )
        sse_p03 = [
            b'data: {"type":"metadata","citations":[{"index":1,"id":"99a23026-aa88-47a7-922d-db1b8922735f"}]}\n\n',
            b'data: {"type":"text","text":"300-800 tokens [Chunk 1]."}\n\n',
            b'data: {"type":"finish","context":"[Chunk 1]: 300-800 tokens.","metrics":{"ttft_ms":90,"total_ms":180,"token_usage":{"prompt":100,"completion":12,"total":112},"agent":{"tool":"rag_retrieval","steps":4,"max_steps":6,"retrieval_attempts":1,"max_retrieval_attempts":2,"reformulated":false,"evidence_sufficient":true,"evidence_reason":"sufficient","final_outcome":"answer"}}}\n\n',
        ]
        chat_calls = []

        def fake_post(url, **kwargs):
            chat_calls.append(url)
            return FakeStreamResponse(sse_p03)

        with patch.dict("os.environ", {
            "EVAL_PERSONAL_ACCESS_TOKEN": "tok",
            "EVAL_ENTERPRISE_ACCESS_TOKEN": "tok2",
        }), patch.object(suite, "load_dotenv"), patch.object(suite.requests, "post", side_effect=fake_post):
            out = suite.run_live(
                cases_list,
                "http://127.0.0.1:3000/api/chat",
                stream=True,
                max_cases=5,
                selected_ids={"P01", "P03", "P05"},
                existing_results=existing,
                judge=False,
                pacer=pacer,
            )

        self.assertEqual(len(chat_calls), 1)
        self.assertTrue(pacer.daily_quota_exhausted)
        self.assertIn("daily Gemini RPD budget exhausted", out["summary"]["aborted_reason"])
        by_id = {r["case_id"]: r for r in out["results"]}
        self.assertIn("P01", by_id)
        self.assertIn("P03", by_id)
        self.assertNotIn("P05", by_id)

    def test_rate_aware_429_respects_retry_after_without_replaying_and_interruption_preserves_results(self):
        dataset = Path(__file__).resolve().parents[1] / "evals/agentic_eval_40.jsonl"
        cases_list = suite.load_eval_dataset(dataset)
        fake_now = [100.0]
        sleeps = []

        def fake_clock():
            return fake_now[0]

        def fake_sleep(seconds):
            sleeps.append(seconds)
            fake_now[0] += seconds

        pacer = suite.GeminiRatePacer(
            enabled=True,
            rpm=60,
            rpd=500,
            safety_margin=0.75,
            clock=fake_clock,
            sleeper=fake_sleep,
        )

        class Fake429:
            status_code = 429
            headers = {"content-type": "application/json", "Retry-After": "12"}
            text = "Rate limit exceeded"
            def json(self):
                return {"error": "Rate limit exceeded"}
            def close(self):
                return None

        sse_p03 = [
            b'data: {"type":"metadata","citations":[{"index":1,"id":"99a23026-aa88-47a7-922d-db1b8922735f"}]}\n\n',
            b'data: {"type":"text","text":"300-800 tokens [Chunk 1]."}\n\n',
            b'data: {"type":"finish","context":"[Chunk 1]: 300-800 tokens.","metrics":{"ttft_ms":80,"total_ms":150,"token_usage":{"prompt":90,"completion":10,"total":100},"agent":{"tool":"rag_retrieval","steps":4,"max_steps":6,"retrieval_attempts":1,"max_retrieval_attempts":2,"reformulated":false,"evidence_sufficient":true,"evidence_reason":"sufficient","final_outcome":"answer"}}}\n\n',
        ]
        calls = []

        def fake_post(url, **kwargs):
            calls.append(kwargs.get("json", {}).get("query"))
            if len(calls) == 1:
                return Fake429()
            if len(calls) == 2:
                return FakeStreamResponse(sse_p03)
            raise KeyboardInterrupt()

        with patch.dict("os.environ", {
            "EVAL_PERSONAL_ACCESS_TOKEN": "tok",
            "EVAL_ENTERPRISE_ACCESS_TOKEN": "tok2",
        }), patch.object(suite, "load_dotenv"), patch.object(suite.requests, "post", side_effect=fake_post):
            out = suite.run_live(
                cases_list,
                "http://127.0.0.1:3000/api/chat",
                stream=True,
                max_cases=3,
                selected_ids={"P01", "P03", "P05"},
                judge=False,
                pacer=pacer,
            )

        # P01 failed with 429 and was NOT replayed; P03 ran after Retry-After=12s cooldown; P05 interrupted cleanly.
        self.assertEqual(len(calls), 3)
        self.assertTrue(any(s >= 12.0 for s in sleeps))
        self.assertEqual(out["summary"]["rate_aware_pacing"]["rate_limit_429_count"], 1)
        self.assertIn("Interrupted", out["summary"]["aborted_reason"])
        by_id = {r["case_id"]: r for r in out["results"]}
        self.assertEqual(by_id["P01"]["live_execution_status"], "HTTP_429")
        self.assertEqual(by_id["P01"]["failure_category"], "api_error_http_429")
        self.assertFalse(by_id["P01"]["task_check_passed"])
        self.assertTrue(by_id["P03"]["task_check_passed"])
        self.assertNotIn("P05", by_id)


if __name__ == "__main__":
    unittest.main()
