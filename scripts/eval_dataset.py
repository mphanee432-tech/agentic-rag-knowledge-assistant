"""Canonical golden-case schema and deterministic stratified sampling."""
import hashlib
import json
from collections import Counter
from pathlib import Path
from uuid import UUID

CATEGORIES = {
    "Fact-Based Lookups": 23, "Edge Cases & Ambiguity": 10, "Multi-Hop Synthesis": 7,
    "Adversarial & Refusals": 8, "Regression Testing": 2,
}


def validate_dataset(data, full=False):
    if not isinstance(data, list) or not data:
        raise ValueError("Dataset must be a nonempty list of canonical golden cases.")
    ids, queries = set(), set()
    for row in data:
        if not isinstance(row, dict) or type(row.get("id")) is not int or row["id"] < 1:
            raise ValueError("Each case needs a positive integer id.")
        if row["id"] in ids:
            raise ValueError("Case IDs must be unique.")
        ids.add(row["id"])
        for field in ("query", "description", "rubric"):
            if not isinstance(row.get(field), str) or not row[field].strip():
                raise ValueError(f"Case {row['id']} needs {field}.")
        query = row["query"].strip().casefold()
        if query in queries or len(row["query"].encode("utf-16-le", errors="surrogatepass")) // 2 > 2500:
            raise ValueError(f"Case {row['id']} has a duplicate or oversized query.")
        queries.add(query)
        if row.get("category") not in CATEGORIES:
            raise ValueError(f"Case {row['id']} has an unknown category.")
        try:
            UUID(row.get("projectId", ""))
        except (ValueError, TypeError, AttributeError):
            raise ValueError(f"Case {row['id']} needs a valid projectId.") from None
        signals = row.get("expected_signals", {})
        if not isinstance(signals, dict) or any(type(signals.get(k)) is not bool for k in ("must_refuse", "require_citations")):
            raise ValueError(f"Case {row['id']} needs explicit refusal/citation expectations.")
        if signals["must_refuse"] != (row["category"] == "Adversarial & Refusals") or signals["require_citations"] == signals["must_refuse"]:
            raise ValueError(f"Case {row['id']} has inconsistent refusal/citation expectations.")
        if type(signals.get("max_chars")) is not int or not 1 <= signals["max_chars"] <= 3000:
            raise ValueError(f"Case {row['id']} has an invalid answer limit.")
        keywords = signals.get("ground_truth_keywords")
        if not isinstance(keywords, list) or any(not isinstance(k, str) or not k.strip() for k in keywords):
            raise ValueError(f"Case {row['id']} has invalid reference keywords.")
    if full and Counter(row["category"] for row in data) != Counter(CATEGORIES):
        raise ValueError("Golden suite requires exactly 50 cases in the 23/10/7/8/2 category split.")
    return data


def load_dataset(path, full=False):
    return validate_dataset(json.loads(Path(path).read_text(encoding="utf-8")), full=full)


def dataset_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def stratified_sample(data, size):
    if size < 1 or size > len(data):
        raise ValueError("Sample size must be between one and the dataset size.")
    groups = {name: [row for row in data if row["category"] == name] for name in CATEGORIES}
    selected = {name: 0 for name in groups}
    if size >= len(CATEGORIES):
        selected = {name: int(bool(rows)) for name, rows in groups.items()}
    while sum(selected.values()) < size:
        available = [name for name in groups if selected[name] < len(groups[name])]
        # Largest remaining proportional deficit; ties follow the documented category order.
        name = max(available, key=lambda name: size * len(groups[name]) / len(data) - selected[name])
        selected[name] += 1
    return [row for name, rows in groups.items() for row in rows[:selected[name]]]
