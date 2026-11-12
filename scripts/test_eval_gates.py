import unittest
import json
from pathlib import Path
from eval_gates import check_answer, check_run, citation_indices, NO_EVIDENCE

class EvaluationGatesTest(unittest.TestCase):
    def test_shared_citation_fixtures(self):
        fixtures = json.loads((Path(__file__).resolve().parents[1] / "tests/fixtures/citations.json").read_text(encoding="utf-8"))
        for fixture in fixtures:
            with self.subTest(name=fixture["name"]):
                self.assertEqual(citation_indices(fixture["text"]), fixture["indices"])
                result = check_answer(fixture["text"], fixture["citations"], [], "fact", 1, True)
                self.assertEqual(result["citation_correct"], fixture["valid"])
    def gate(self, text, citations=None, errors=None, category="fact", judge_score=1, has_judge=True):
        return check_answer(text, citations or [{"id": "a", "index": 1}], errors or [], category, judge_score, has_judge)
    def test_empty_answer_fails_even_when_judge_passes(self):
        self.assertFalse(self.gate("")["passed"])
        self.assertFalse(self.gate("   \n\t")["passed"])
    def test_invalid_judge_scores_cannot_pass(self):
        for score in (True, None, "1", -1, 1.01, float("nan"), float("inf")):
            with self.subTest(score=score):
                self.assertFalse(self.gate("Answer [Chunk 1]", judge_score=score)["passed"])
    def test_unknown_citation_fails(self):
        self.assertFalse(self.gate("Answer [Chunk 99].")["passed"])
    def test_multi_citation_checks_every_index(self):
        self.assertFalse(self.gate("Answer [Chunk 1, Chunk 2].")["passed"])
        self.assertTrue(self.gate("Answer [Chunk 1, Chunk 2].", [{"id":"a","index":1},{"id":"b","index":2}])["passed"])
    def test_transport_error_fails(self):
        self.assertFalse(self.gate("Answer [Chunk 1].", errors=["HTTP 500"])["passed"])
    def test_size_limit_fails(self):
        self.assertFalse(self.gate("x" * 3000 + " [Chunk 1]")["passed"])
    def test_no_judge_cannot_pass_release_gate(self):
        self.assertFalse(self.gate("Answer [Chunk 1].", has_judge=False)["passed"])
    def test_refusal_only_passes_expected_refusal_case(self):
        self.assertTrue(self.gate(NO_EVIDENCE, category="Adversarial & Refusals")["passed"])
        self.assertFalse(self.gate(NO_EVIDENCE)["passed"])
    def test_malformed_citation_fails(self):
        self.assertFalse(self.gate("Answer [Chunk 1] [Chunk banana]")["passed"])
    def test_row_limits_refusals_and_graded_thresholds(self):
        citations = [{"id": "a", "index": 1}]
        self.assertFalse(check_answer("Answer [Chunk 1]", citations, [], "fact", 1, True, {"max_chars": 5})["passed"])
        self.assertFalse(check_answer("Answer [Chunk 1]", citations, [], "adversarial", 0, True, {"must_refuse": True})["passed"])
        self.assertTrue(check_answer("I cannot export that; the policy prohibits it [Chunk 1]", citations, [], "adversarial", 1, True, {"must_refuse": True})["passed"])
        self.assertTrue(check_answer(NO_EVIDENCE, [], [], "adversarial", 1, True, {"must_refuse": True})["passed"])
        self.assertTrue(self.gate("Answer [Chunk 1]", judge_score=2.5 / 3)["passed"])
        self.assertFalse(self.gate("Answer [Chunk 1]", judge_score=2.49 / 3)["passed"])
        self.assertFalse(self.gate("😀" * 1500 + " [Chunk 1]")["format_correct"])


class RunGatesTest(unittest.TestCase):
    def rows(self, count=50):
        return [dict(citation_correct=True, format_correct=True, passed=True, judge_score=1,
                     errors=[], ttft_ms=100, total_ms=500) for _ in range(count)]

    def gate(self, rows=None, **overrides):
        options = dict(release=True, isolation_ok=True, has_judge=True, stream=True,
                       expected_count=50, p95_ttft=100, p95_total=500)
        options.update(overrides)
        return check_run(self.rows() if rows is None else rows, **options)

    def test_smoke_passes_without_judge_or_release_latency_budget(self):
        rows = self.rows(5)
        for row in rows:
            row["passed"] = False  # No semantic verification when judge is absent.
        result = self.gate(rows, release=False, has_judge=False, isolation_ok=False,
                           expected_count=5, p95_ttft=9000, p95_total=20000)
        self.assertTrue(result["passed"])
        self.assertFalse(result["release_certified"])

    def test_smoke_still_requires_deterministic_checks_and_optional_judge(self):
        for field, value in [("citation_correct", False), ("format_correct", False),
                             ("errors", ["HTTP 500"]), ("passed", False)]:
            rows = self.rows(5)
            rows[0][field] = value
            with self.subTest(field=field):
                self.assertFalse(self.gate(rows, release=False, expected_count=5)["passed"])

    def test_release_prerequisites_and_latency_limits_fail_closed(self):
        self.assertTrue(self.gate()["response_release_gates_passed"])
        self.assertFalse(self.gate()["release_certified"])
        for overrides in [dict(has_judge=False), dict(stream=False), dict(isolation_ok=False),
                          dict(expected_count=51), dict(p95_ttft=2001), dict(p95_total=8001),
                          dict(p95_ttft=0), dict(p95_total=float("nan"))]:
            with self.subTest(overrides=overrides):
                self.assertFalse(self.gate(**overrides)["passed"])
        self.assertFalse(self.gate(self.rows(5), expected_count=5)["passed"])
        self.assertFalse(self.gate([], expected_count=0, release=False)["passed"])

    def test_release_does_not_ignore_missing_or_invalid_timing_samples(self):
        for value in [0, -1, None, float("nan"), float("inf")]:
            rows = self.rows()
            rows[0]["ttft_ms"] = value
            with self.subTest(value=value):
                self.assertFalse(self.gate(rows)["passed"])

    def test_release_quality_thresholds_are_preserved(self):
        rows = self.rows()
        for row in rows[:2]:
            row["citation_correct"] = row["passed"] = False
        self.assertTrue(self.gate(rows)["passed"])
        rows[2]["citation_correct"] = False
        self.assertFalse(self.gate(rows)["passed"])

    def test_regression_bucket_and_numeric_judge_scores_are_gated(self):
        rows = self.rows()
        rows[-1].update(category="Regression Testing", passed=False)
        self.assertTrue(any("Regression" in failure for failure in self.gate(rows)["failures"]))
        for score in (float("nan"), float("inf"), -1, 2, None):
            rows = self.rows()
            rows[0]["judge_score"] = score
            with self.subTest(score=score):
                self.assertFalse(self.gate(rows)["passed"])
        rows = self.rows()
        rows[0]["format_correct"] = False
        self.assertFalse(self.gate(rows)["passed"])
        rows = self.rows()
        rows[0]["errors"] = ["Recovered transport failure"]
        self.assertFalse(self.gate(rows)["passed"])

if __name__ == "__main__":
    unittest.main()

