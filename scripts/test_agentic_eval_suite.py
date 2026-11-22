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


if __name__ == "__main__":
    unittest.main()
