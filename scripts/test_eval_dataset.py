import copy
import unittest
from collections import Counter
from pathlib import Path

from eval_dataset import CATEGORIES, load_dataset, stratified_sample, validate_dataset

GOLDEN = Path(__file__).resolve().parents[1] / "evals/golden_dataset.json"


class GoldenDatasetTest(unittest.TestCase):
    def test_real_suite_is_balanced_and_uses_stable_source_rubrics(self):
        rows = load_dataset(GOLDEN, full=True)
        self.assertEqual(Counter(row["category"] for row in rows), Counter(CATEGORIES))
        for row in rows:
            self.assertNotRegex(row["rubric"], r"\bChunk [0-9X]+\b")
            self.assertNotIn("\ufffd", row["query"] + row["rubric"])

    def test_invalid_cases_fail_before_any_model_requests(self):
        base = load_dataset(GOLDEN)
        for field, value in [("id", True), ("query", ""), ("query", "x" * 2501),
                             ("category", "Unknown"), ("rubric", ""), ("projectId", "bad"),
                             ("expected_signals", {}), ("expected_signals", {"max_chars": 4000})]:
            rows = copy.deepcopy(base)
            rows[0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate_dataset(rows)
        rows = copy.deepcopy(base)
        rows[1]["query"] = rows[0]["query"].upper()
        with self.assertRaises(ValueError):
            validate_dataset(rows)
        rows = copy.deepcopy(base)
        rows[1]["id"] = rows[0]["id"]
        with self.assertRaises(ValueError):
            validate_dataset(rows)
        with self.assertRaises(ValueError):
            validate_dataset(base[:-1], full=True)

    def test_sample_counts_are_exact_and_reproducible(self):
        rows = load_dataset(GOLDEN)
        for size in (1, 2, 5, 7, 20, 49, 50):
            with self.subTest(size=size):
                sample = stratified_sample(rows, size)
                self.assertEqual(len(sample), size)
                self.assertEqual(len({row["id"] for row in sample}), size)
                self.assertEqual(sample, stratified_sample(rows, size))
                if size >= 5:
                    self.assertEqual(set(row["category"] for row in sample), set(CATEGORIES))
        for size in (0, 51):
            with self.assertRaises(ValueError):
                stratified_sample(rows, size)


if __name__ == "__main__":
    unittest.main()
