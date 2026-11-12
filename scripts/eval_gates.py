"""Deterministic evaluation gates; independent of any model judge."""
import re
import math

NO_EVIDENCE = "I don't know."
CITATION_PATTERN = re.compile(r"\[Chunk\s+([0-9]+(?:\s*,\s*(?:Chunk\s+)?[0-9]+)*)\]", re.I)

def citation_indices(text):
    matches = CITATION_PATTERN.findall(text)
    return [int(re.sub(r"Chunk\s*", "", value, flags=re.I).strip())
            for match in matches for value in match.split(",")]

def check_answer(text, citations, errors, category, judge_score, has_judge, signals=None):
    signals = signals or {}
    indices = citation_indices(text)
    allowed = {c.get("index") for c in citations if isinstance(c, dict) and type(c.get("index")) is int
               and isinstance(c.get("id"), str) and c["id"].strip()}
    refusal = text.strip() == NO_EVIDENCE
    must_refuse = signals.get("must_refuse", "adversarial" in category.lower() or "refusal" in category.lower())
    malformed = bool(re.search(r"\[Chunk\b", CITATION_PATTERN.sub("", text), flags=re.I))
    citations_valid = bool(indices) and all(i in allowed for i in indices) and not malformed
    citation_gate = citations_valid or (must_refuse and refusal and not indices)
    if refusal and not must_refuse:
        citation_gate = False
    max_chars = min(3000, signals.get("max_chars", 3000))
    format_gate = bool(text.strip()) and len(text.encode("utf-16-le", errors="surrogatepass")) // 2 <= max_chars and "rag-telemetry:" not in text
    # A missing judge is never interpreted as semantic verification.
    judge_valid = type(judge_score) in (int, float) and math.isfinite(judge_score) and 2.5 / 3 <= judge_score <= 1
    passed = format_gate and citation_gate and not errors and has_judge and judge_valid
    return {"citation_correct": citation_gate, "format_correct": format_gate, "passed": bool(passed)}


def check_run(results, *, release, isolation_ok, has_judge, stream, expected_count, p95_ttft, p95_total):
    """Smoke checks deterministic behavior; only an explicit release run can certify quality."""
    failures = []
    count = len(results)
    if not count or count != expected_count:
        failures.append("The requested dataset was not fully evaluated.")
    if any(row.get("errors") for row in results):
        failures.append("Requests reported errors.")
    citation_rate = sum(bool(row.get("citation_correct")) for row in results) / max(1, count)
    format_rate = sum(bool(row.get("format_correct")) for row in results) / max(1, count)
    quality_rate = sum(bool(row.get("passed")) for row in results) / max(1, count)
    if release:
        if count < 50:
            failures.append("Release evaluation requires at least 50 cases.")
        if not isolation_ok:
            failures.append("Two-user isolation was not verified.")
        if not has_judge:
            failures.append("Release evaluation requires a semantic judge.")
        if not stream:
            failures.append("Release evaluation requires streaming.")
        if citation_rate < 0.95 or format_rate < 0.99 or quality_rate < 0.95:
            failures.append("Release quality thresholds were not met (citations 95%, format 99%, combined quality 95%).")
        regression = [row for row in results if row.get("category") == "Regression Testing"]
        if regression and sum(bool(row.get("passed")) for row in regression) / len(regression) < 0.9:
            failures.append("Regression cases failed the 90% pass threshold.")
        scores = [row.get("judge_score", 0) for row in results]
        if any(not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1 for score in scores) or sum(scores) / max(1, count) < 2.5 / 3:
            failures.append("Faithfulness/relevance score is below 2.5/3 or invalid.")
        timings = [row.get(key, 0) for row in results for key in ("ttft_ms", "total_ms")]
        if not timings or any(not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 for value in timings):
            failures.append("Release latency measurements are missing or invalid.")
        if not (0 < p95_ttft <= 2000 and 0 < p95_total <= 8000):
            failures.append("Release latency thresholds were not met (p95 TTFT 2s, total 8s).")
    else:
        if citation_rate < 1 or format_rate < 1:
            failures.append("Every smoke/exploratory answer must pass citation and format checks.")
        if has_judge and quality_rate < 1:
            failures.append("One or more answers failed the configured judge.")
    passed = not failures
    # Cost and exact-vector recall require separate measurements; response gates alone cannot certify the PRD.
    return {"passed": passed, "response_release_gates_passed": release and passed,
            "release_certified": False, "failures": failures}

