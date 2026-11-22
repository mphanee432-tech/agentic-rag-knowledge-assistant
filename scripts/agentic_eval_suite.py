#!/usr/bin/env python3
"""
Reusable 40-case evaluation runner for Agentic Personal RAG (v2) & Agentic Enterprise RAG (v2).

Keeps evaluation logic completely outside application runtime code.
- `--mode offline`: Deterministic validation without live Gemini/LLM calls or DB writes.
- `--mode live --confirm-live`: Live HTTP evaluation against running /api/chat (requires explicit approval).
"""
import argparse
import csv
import hashlib
import json
import math
import os
import re
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import urlsplit

import requests
from dotenv import load_dotenv

DEFAULT_PILOT_CASE_IDS = ("P01", "P05", "P08", "P10", "P12", "E01", "E05", "E07", "E10", "E16")

CITATION_RE = re.compile(r"\[Chunk\s+([0-9]+(?:\s*,\s*(?:Chunk\s+)?[0-9]+)*)\]", re.I)
PERSONAL_REFUSAL = "I don't know."
ENTERPRISE_REFUSAL = "I don't know based on the documents I can access."
REQUIRED_CASE_FIELDS = (
    "case_id",
    "workspace",
    "category",
    "question",
    "expected_behavior",
    "ground_truth_answer",
    "supporting_references",
    "required_permission_context",
    "evaluation_criteria",
)


def percentile_nearest_rank(values: List[float], pct: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    idx = max(0, math.ceil((pct / 100.0) * len(ordered)) - 1)
    return round(ordered[idx], 2)


def load_eval_dataset(path: Path) -> List[Dict[str, Any]]:
    cases: List[Dict[str, Any]] = []
    seen_ids = set()
    for line_no, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        row = json.loads(line)
        for field in REQUIRED_CASE_FIELDS:
            if field not in row:
                raise ValueError(f"Line {line_no}: missing required field '{field}'.")
        cid = row["case_id"]
        if cid in seen_ids:
            raise ValueError(f"Duplicate case_id '{cid}'.")
        seen_ids.add(cid)
        if row["workspace"] not in ("personal", "enterprise"):
            raise ValueError(f"{cid}: invalid workspace '{row['workspace']}'.")
        if not isinstance(row["question"], str) or not row["question"].strip():
            raise ValueError(f"{cid}: empty question.")
        if not isinstance(row["supporting_references"], list):
            raise ValueError(f"{cid}: supporting_references must be a list.")
        if not isinstance(row["required_permission_context"], dict):
            raise ValueError(f"{cid}: required_permission_context must be an object.")
        cases.append(row)
    personal = [c for c in cases if c["workspace"] == "personal"]
    enterprise = [c for c in cases if c["workspace"] == "enterprise"]
    if len(personal) != 15 or len(enterprise) != 25 or len(cases) != 40:
        raise ValueError(
            f"Expected 15 Personal + 25 Enterprise = 40 cases; got {len(personal)} + {len(enterprise)} = {len(cases)}."
        )
    return cases


def dataset_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract_citation_indices(text: str) -> List[int]:
    matches = CITATION_RE.findall(text or "")
    return [
        int(re.sub(r"Chunk\s*", "", item, flags=re.I).strip())
        for match in matches
        for item in match.split(",")
    ]


def check_citation_contract(text: str, citations: List[Dict[str, Any]], expected_behavior: str) -> bool:
    trimmed = (text or "").strip()
    indices = extract_citation_indices(trimmed)
    malformed = bool(re.search(r"\[Chunk\b", CITATION_RE.sub("", trimmed), flags=re.I))
    if malformed:
        return False
    allowed = {
        c.get("index")
        for c in citations
        if isinstance(c, dict) and type(c.get("index")) is int and isinstance(c.get("id"), str) and c["id"].strip()
    }
    if expected_behavior in ("refuse", "refuse_with_fallback_suggestions"):
        if trimmed in (PERSONAL_REFUSAL, ENTERPRISE_REFUSAL) and not indices:
            return True
        return bool(indices) and all(i in allowed for i in indices)
    if expected_behavior in ("grounded_negative_or_refuse", "refuse_or_safe_grounding"):
        if trimmed in (PERSONAL_REFUSAL, ENTERPRISE_REFUSAL) and not indices:
            return True
        return bool(indices) and all(i in allowed for i in indices)
    if expected_behavior in ("deterministic_intent_no_retrieval", "deny_access", "tool_route_jira_status", "tool_draft_require_human_confirmation"):
        return not indices
    return bool(indices) and all(i in allowed for i in indices)


def compute_retrieval_metrics(expected_chunk_ids: List[str], retrieved_chunk_ids: List[str], k: int = 8) -> Dict[str, Optional[float]]:
    if not expected_chunk_ids:
        return {"recall_at_k": None, "precision_at_k": None, "mrr": None}
    expected = set(expected_chunk_ids)
    top_k = retrieved_chunk_ids[:k]
    if not top_k:
        return {"recall_at_k": 0.0, "precision_at_k": 0.0, "mrr": 0.0}
    hits = [cid for cid in top_k if cid in expected]
    recall = len(set(hits)) / len(expected)
    precision = len(hits) / len(top_k)
    mrr = 0.0
    for rank, cid in enumerate(top_k, start=1):
        if cid in expected:
            mrr = 1.0 / rank
            break
    return {"recall_at_k": round(recall, 4), "precision_at_k": round(precision, 4), "mrr": round(mrr, 4)}


def expected_chunks_for_case(case: Dict[str, Any]) -> List[str]:
    ids: List[str] = []
    for ref in case.get("supporting_references", []):
        ids.extend(ref.get("chunk_ids", []))
    return ids


def load_v1_comparison_baseline(v1_report_path: Optional[Path]) -> Dict[str, Any]:
    if v1_report_path and v1_report_path.exists():
        data = json.loads(v1_report_path.read_text(encoding="utf-8"))
        gates = data.get("gates", {})
        return {
            "source_path": str(v1_report_path),
            "created_at": data.get("created_at"),
            "suite_type": data.get("suite_type"),
            "case_count": data.get("case_count"),
            "combined_answer_pass_rate_pct": gates.get("combined_answer_pass_rate", {}).get("observed"),
            "citation_validity_pct": gates.get("citation_validity", {}).get("observed"),
            "format_conformance_pct": gates.get("format_conformance", {}).get("observed"),
            "p95_total_latency_ms": gates.get("p95_total_latency", {}).get("observed"),
            "p95_ttft_ms": "NOT_MEASURED",
            "cost_per_query": "NOT_MEASURED",
            "failure_rate_pct": 0.0 if gates.get("request_errors", {}).get("status") == "PASS" else None,
        }
    return {"source_path": None, "status": "NOT_MEASURED"}


def evaluate_offline(
    cases: List[Dict[str, Any]],
    dataset_path: Path,
    authz_report_path: Optional[Path],
    v1_report_path: Optional[Path],
) -> Dict[str, Any]:
    authz_data = None
    if authz_report_path and authz_report_path.exists():
        authz_data = json.loads(authz_report_path.read_text(encoding="utf-8"))

    results: List[Dict[str, Any]] = []
    for case in cases:
        exp_chunks = expected_chunks_for_case(case)
        needs_sources = case["expected_behavior"] in ("answer", "answer_with_clarification")
        grounded_fixture_ok = (len(exp_chunks) > 0) if needs_sources else True
        results.append({
            "case_id": case["case_id"],
            "workspace": case["workspace"],
            "category": case["category"],
            "expected_behavior": case["expected_behavior"],
            "dataset_grounding_valid": grounded_fixture_ok,
            "v1_comparable": bool(case.get("v1_comparable", False)),
            "live_execution_status": "NOT_RUN",
            "retrieval_recall_at_8": None,
            "retrieval_precision_at_8": None,
            "retrieval_mrr": None,
            "retrieval_metrics_status": "NOT_RUN",
            "cited_precision": None,
            "citation_accuracy": None,
            "zero_unauthorized_chunks_exposed": None,
            "access_denial_correct": None,
            "groundedness": None,
            "unsupported_claim_rate": None,
            "abstention_correct": None,
            "latency_ms": None,
            "ttft_ms": None,
            "prompt_tokens": None,
            "completion_tokens": None,
            "total_tokens": None,
            "cost_inr": None,
            "notes": "Offline validation only; live LLM/retrieval not executed without approval.",
        })

    by_workspace: Dict[str, Dict[str, Any]] = {}
    for ws in ("personal", "enterprise"):
        ws_cases = [r for r in results if r["workspace"] == ws]
        by_workspace[ws] = {
            "total_cases": len(ws_cases),
            "dataset_grounded_cases": sum(1 for r in ws_cases if r["dataset_grounding_valid"]),
            "v1_comparable_cases": sum(1 for r in ws_cases if r["v1_comparable"]),
            "non_comparable_cases": sum(1 for r in ws_cases if not r["v1_comparable"]),
            "live_executed_cases": 0,
            "rag_quality": {
                "retrieval_recall_at_8": "NOT_RUN",
                "precision_at_8": "NOT_RUN",
                "mrr": "NOT_RUN",
                "answer_groundedness": "NOT_RUN",
                "citation_accuracy": "NOT_RUN",
                "unsupported_claim_rate": "NOT_RUN",
                "appropriate_abstention_rate": "NOT_RUN",
            },
            "performance": {
                "p50_latency_ms": "NOT_RUN",
                "p95_latency_ms": "NOT_RUN",
                "ttft_ms": "NOT_RUN",
                "mean_total_tokens": "NOT_RUN",
                "api_cost_per_query": "NOT_MEASURED",
            },
        }

    summary = {
        "evaluation_mode": "offline",
        "dataset_path": str(dataset_path),
        "dataset_sha256": dataset_sha256(dataset_path),
        "total_cases": len(results),
        "personal_cases": by_workspace["personal"]["total_cases"],
        "enterprise_cases": by_workspace["enterprise"]["total_cases"],
        "all_dataset_grounding_valid": all(r["dataset_grounding_valid"] for r in results),
        "workspace_summaries": by_workspace,
        "database_authorization_eval": authz_data if authz_data else {"status": "NOT_RUN"},
        "agentic_capabilities_audit": {
            "deterministic_greeting_identity_short_circuit": "IMPLEMENTED_AND_TESTED",
            "jira_status_regex_routing_and_ecd_allowlist": "IMPLEMENTED_AND_TESTED",
            "jira_ticket_draft_and_human_confirmation_gate": "IMPLEMENTED_AND_TESTED",
            "retrieval_rpc_single_transport_retry": "IMPLEMENTED_AND_TESTED",
            "enterprise_empty_retrieval_fallback_questions": "IMPLEMENTED_AND_TESTED",
            "llm_multi_step_tool_calling_loop": "NOT_IMPLEMENTED",
            "autonomous_query_rewrite_recovery_on_empty_retrieval": "NOT_IMPLEMENTED",
            "agent_max_step_controller": "NOT_IMPLEMENTED",
            "enterprise_multi_turn_memory": "NOT_IMPLEMENTED_BY_DESIGN",
        },
        "v1_vs_v2_comparison": {
            "v1_enterprise_historical_baseline": load_v1_comparison_baseline(v1_report_path),
            "v2_live_paired_run": "NOT_RUN",
            "comparability_note": (
                "Only Enterprise D01-D12 cases (23 of 25 Enterprise cases) and Personal auth/deterministic cases "
                "(3 of 15 Personal cases) are comparable across v1 and v2; Book Exchange (E05-E06) and Personal "
                "Production_RAG_Architecture_Considerations.pdf (P01-P11, P14) exist only in v2."
            ),
        },
    }
    return {"summary": summary, "results": results}


def write_outputs(output_dir: Path, summary: Dict[str, Any], results: List[Dict[str, Any]], prefix: str) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / f"{prefix}_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (output_dir / f"{prefix}_results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    fieldnames = [
        "case_id",
        "workspace",
        "category",
        "expected_behavior",
        "dataset_grounding_valid",
        "v1_comparable",
        "live_execution_status",
        "task_check_passed",
        "failure_category",
        "retrieval_recall_at_8",
        "retrieval_precision_at_8",
        "retrieval_mrr",
        "retrieval_metrics_status",
        "cited_precision",
        "citation_accuracy",
        "zero_unauthorized_chunks_exposed",
        "access_denial_correct",
        "groundedness",
        "unsupported_claim_rate",
        "abstention_correct",
        "latency_ms",
        "ttft_ms",
        "client_ttft_ms",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "cost_inr",
        "answer_preview",
        "notes",
    ]
    with (output_dir / f"{prefix}_results.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(results)


DENIAL_OR_REFUSE_BEHAVIORS = ("refuse", "refuse_with_fallback_suggestions", "deny_access")
SECURITY_DENIAL_CATEGORIES = (
    "restricted_d03",
    "restricted_d11",
    "d12_authorization",
    "cross_dept_denial",
    "project_isolation",
    "prompt_injection",
)


def is_identity_eligible(
    case: Dict[str, Any],
    enterprise_dept: str,
    enterprise_role: str,
    enterprise_grants: Set[str],
    enterprise_projects: Set[str],
    personal_available: bool,
    enterprise_available: bool,
) -> Tuple[bool, str]:
    ws = case["workspace"]
    role = case["required_permission_context"].get("role")
    if case["expected_behavior"] in ("tool_route_jira_status", "tool_draft_require_human_confirmation"):
        return False, "Skipped: UI-level Jira action/confirmation case excluded from live HTTP runner."
    if ws == "personal":
        if role == "anonymous":
            return True, ""
        if not personal_available:
            return False, "Skipped: Personal user credential/token unavailable in local env."
        return True, ""
    if not enterprise_available:
        return False, "Skipped: Enterprise user credential/token unavailable in local env."
    ctx = case["required_permission_context"]
    req_grants = set(ctx.get("grants") or [])
    if not req_grants.issubset(enterprise_grants):
        return False, "Skipped: required Enterprise document grant not present on available test identity."
    if ctx.get("project_membership") and ctx.get("project_id") not in enterprise_projects:
        return False, "Skipped: required Enterprise project membership not present on available test identity."
    req_dept = ctx.get("department")
    if (
        case["expected_behavior"] == "answer"
        and req_dept
        and req_dept != enterprise_dept
        and case["category"] == "department_policy"
    ):
        return False, f"Skipped: requires '{req_dept}' department membership (active test identity is '{enterprise_dept}')."
    if req_role := ctx.get("role"):
        if req_role == "cxo" and enterprise_role != "cxo":
            return False, f"Skipped: requires CXO role (active test identity is '{enterprise_role}')."
    return True, ""


def parse_sse_response(resp: requests.Response, started_at: float) -> Dict[str, Any]:
    """Parse /api/chat text/event-stream using byte-safe UTF-8 frame decoding."""
    text_parts: List[str] = []
    citations: List[Dict[str, Any]] = []
    metrics: Dict[str, Any] = {}
    fallback_questions: List[str] = []
    stream_error: Optional[str] = None
    client_ttft_ms: Optional[float] = None
    finished = False
    raw_buf = bytearray()
    for chunk in resp.iter_content(chunk_size=1, decode_unicode=False):
        if not chunk:
            continue
        raw_buf.extend(chunk)
        while b"\n\n" in raw_buf:
            sep_idx = raw_buf.index(b"\n\n")
            frame_bytes = bytes(raw_buf[:sep_idx])
            del raw_buf[: sep_idx + 2]
            frame = frame_bytes.decode("utf-8", errors="replace")
            if not frame.startswith("data: "):
                continue
            event = json.loads(frame[6:])
            etype = event.get("type")
            if etype == "metadata":
                citations = event.get("citations") or []
            elif etype == "text":
                delta = event.get("text") or ""
                if delta and client_ttft_ms is None:
                    client_ttft_ms = round((time.perf_counter() - started_at) * 1000.0, 2)
                text_parts.append(delta)
            elif etype == "finish":
                finished = True
                metrics = event.get("metrics") or {}
                fallback_questions = event.get("fallbackQuestions") or []
            elif etype == "error":
                stream_error = event.get("message") or "Stream error event"
    client_total_ms = round((time.perf_counter() - started_at) * 1000.0, 2)
    return {
        "text": "".join(text_parts),
        "citations": citations,
        "metrics": metrics,
        "fallbackQuestions": fallback_questions,
        "client_ttft_ms": client_ttft_ms,
        "client_total_ms": client_total_ms,
        "finished": finished,
        "stream_error": stream_error,
    }


def compute_cited_precision(text: str, citations: List[Dict[str, Any]], expected_ids: List[str]) -> Optional[float]:
    """Compute fraction of cited chunks in the validated answer matching ground-truth chunk IDs."""
    if not citations or not expected_ids:
        return None
    expected = set(expected_ids)
    by_idx = {c.get("index"): c.get("id") for c in citations if isinstance(c, dict) and c.get("id")}
    cited_indices = extract_citation_indices(text)
    if cited_indices:
        cited_chunk_ids: List[str] = []
        seen_idx = set()
        for idx in cited_indices:
            if idx not in seen_idx and idx in by_idx:
                seen_idx.add(idx)
                cited_chunk_ids.append(by_idx[idx])
    else:
        cited_chunk_ids = list(by_idx.values())
    if not cited_chunk_ids:
        return None
    hits = sum(1 for cid in cited_chunk_ids if cid in expected)
    return round(hits / len(cited_chunk_ids), 4)


def score_live_case(
    case: Dict[str, Any],
    status_code: int,
    text: str,
    citations: List[Dict[str, Any]],
    total_tokens: int,
    stream_error: Optional[str] = None,
) -> Dict[str, Any]:
    """Evaluate RAG, citation, abstention, and security metrics for a live/merged case."""
    ws = case["workspace"]
    exp_beh = case["expected_behavior"]
    cat = case["category"]
    is_anon = case["required_permission_context"].get("role") == "anonymous"
    expected_ids = expected_chunks_for_case(case)
    retrieved_ids = [c.get("id") for c in citations if isinstance(c, dict) and c.get("id")]

    recall_at_8: Any = None
    precision_at_8: Any = None
    mrr: Any = None
    retrieval_metrics_status = "NOT_APPLICABLE"
    cited_precision: Optional[float] = None
    cit_ok: Optional[bool] = None
    abst_ok: Optional[bool] = None
    zero_unauth: Optional[bool] = None
    access_denial_ok: Optional[bool] = None
    failure_category: Optional[str] = None
    task_ok = False

    if exp_beh == "deny_access":
        expected_code = 401 if is_anon else 404
        zero_unauth = status_code in (401, 403, 404) and len(retrieved_ids) == 0
        access_denial_ok = bool(zero_unauth)
        task_ok = access_denial_ok
        if not task_ok:
            failure_category = f"unexpected_http_{status_code}_expected_{expected_code}"
        retrieval_metrics_status = "NA_ACCESS_DENIAL"
    elif status_code in (401, 403):
        failure_category = f"unexpected_auth_http_{status_code}"
        retrieval_metrics_status = "ABORTED_AUTH_ERROR"
    elif status_code in (429, 500, 502, 503, 504) or stream_error:
        failure_category = f"api_error_http_{status_code}" if status_code != 200 else "stream_error"
        retrieval_metrics_status = "ERROR"
    elif status_code == 200:
        cit_ok = check_citation_contract(text, citations, exp_beh)
        if exp_beh in ("refuse", "refuse_with_fallback_suggestions"):
            retrieval_metrics_status = "NA_DENIAL_OR_REFUSAL"
            forbidden = set(expected_ids)
            leaked_forbidden = any(cid in forbidden for cid in retrieved_ids)
            strict_access_cat = cat in SECURITY_DENIAL_CATEGORIES
            zero_unauth = (not leaked_forbidden) and (len(retrieved_ids) == 0 if strict_access_cat else True)
            abst_ok = text.strip() in (PERSONAL_REFUSAL, ENTERPRISE_REFUSAL)
            if strict_access_cat:
                access_denial_ok = bool(abst_ok and zero_unauth and cit_ok)
                task_ok = access_denial_ok
            else:
                task_ok = bool(abst_ok and cit_ok and zero_unauth)
            if not task_ok:
                failure_category = "unauthorized_chunk_or_leak" if not zero_unauth else "abstention_or_citation_mismatch"
        elif exp_beh == "deterministic_intent_no_retrieval":
            retrieval_metrics_status = "NA_DETERMINISTIC_NO_RETRIEVAL"
            task_ok = bool(cit_ok and int(total_tokens or 0) == 0 and len(retrieved_ids) == 0 and text.strip())
            if not task_ok:
                failure_category = "deterministic_short_circuit_miss"
        else:
            cited_precision = compute_cited_precision(text, citations, expected_ids)
            if exp_beh == "refuse_or_safe_grounding":
                abst_ok = text.strip() in (PERSONAL_REFUSAL, ENTERPRISE_REFUSAL)
                zero_unauth = True
                access_denial_ok = bool(cit_ok and (abst_ok or bool(text.strip())))
            elif exp_beh == "grounded_negative_or_refuse":
                abst_ok = text.strip() in (PERSONAL_REFUSAL, ENTERPRISE_REFUSAL)

            if ws == "personal":
                if expected_ids:
                    retr = compute_retrieval_metrics(expected_ids, retrieved_ids)
                    recall_at_8 = retr["recall_at_k"]
                    precision_at_8 = retr["precision_at_k"]
                    mrr = retr["mrr"]
                    retrieval_metrics_status = "MEASURED_RAW_TOP_K"
                else:
                    retrieval_metrics_status = "NA_NO_EXPECTED_CHUNKS"
                recall_ok = (recall_at_8 or 0.0) > 0.0 if expected_ids else True
                task_ok = bool(cit_ok and recall_ok and text.strip())
            else:
                # Enterprise /api/chat emits only answer-cited chunks in metadata.citations;
                # raw uncited top-8 candidate IDs and ranks are unavailable without app edits.
                recall_at_8 = "NOT_MEASURED"
                precision_at_8 = "NOT_MEASURED"
                mrr = "NOT_MEASURED"
                retrieval_metrics_status = "NOT_MEASURED_POST_FILTERED_CITATIONS"
                if exp_beh in ("grounded_negative_or_refuse", "refuse_or_safe_grounding") and abst_ok:
                    task_ok = bool(cit_ok)
                else:
                    cited_ok = (cited_precision or 0.0) > 0.0 if expected_ids else True
                    task_ok = bool(cit_ok and cited_ok and text.strip())
            if not task_ok:
                failure_category = "citation_or_refusal_mismatch" if not cit_ok else "retrieval_or_evidence_miss"
    else:
        failure_category = f"unexpected_http_{status_code}"

    return {
        "task_check_passed": task_ok,
        "failure_category": failure_category,
        "retrieval_recall_at_8": recall_at_8,
        "retrieval_precision_at_8": precision_at_8,
        "retrieval_mrr": mrr,
        "retrieval_metrics_status": retrieval_metrics_status,
        "cited_precision": cited_precision,
        "citation_accuracy": cit_ok,
        "zero_unauthorized_chunks_exposed": zero_unauth,
        "access_denial_correct": access_denial_ok,
        "abstention_correct": abst_ok,
        "groundedness": "MANUAL_REVIEW_REQUIRED" if status_code == 200 else None,
        "unsupported_claim_rate": "MANUAL_REVIEW_REQUIRED" if status_code == 200 else None,
    }


def summarize_workspace_live(rows: List[Dict[str, Any]], workspace: str, stream: bool) -> Dict[str, Any]:
    ws_rows = [r for r in rows if r["workspace"] == workspace]
    executed = [r for r in ws_rows if str(r.get("live_execution_status", "")).startswith("HTTP_")]
    recalls = [r["retrieval_recall_at_8"] for r in executed if isinstance(r.get("retrieval_recall_at_8"), (int, float))]
    precisions = [r["retrieval_precision_at_8"] for r in executed if isinstance(r.get("retrieval_precision_at_8"), (int, float))]
    mrrs = [r["retrieval_mrr"] for r in executed if isinstance(r.get("retrieval_mrr"), (int, float))]
    cited_precs = [r["cited_precision"] for r in executed if isinstance(r.get("cited_precision"), (int, float))]
    cit_checks = [r["citation_accuracy"] for r in executed if isinstance(r.get("citation_accuracy"), bool)]
    abst_checks = [r["abstention_correct"] for r in executed if isinstance(r.get("abstention_correct"), bool)]
    task_checks = [r["task_check_passed"] for r in executed if isinstance(r.get("task_check_passed"), bool)]
    denial_checks = [r["access_denial_correct"] for r in executed if isinstance(r.get("access_denial_correct"), bool)]
    zero_leak_checks = [r["zero_unauthorized_chunks_exposed"] for r in executed if isinstance(r.get("zero_unauthorized_chunks_exposed"), bool)]
    latencies = [float(r["latency_ms"]) for r in executed if isinstance(r.get("latency_ms"), (int, float))]
    ttfts = [
        float(r["ttft_ms"])
        for r in executed
        if isinstance(r.get("ttft_ms"), (int, float)) and r["expected_behavior"] not in ("deny_access",)
    ]
    client_ttfts = [
        float(r["client_ttft_ms"])
        for r in executed
        if isinstance(r.get("client_ttft_ms"), (int, float))
    ]
    tot_tokens = [int(r["total_tokens"]) for r in executed if isinstance(r.get("total_tokens"), (int, float))]
    prompt_tokens = sum(int(r.get("prompt_tokens") or 0) for r in executed)
    completion_tokens = sum(int(r.get("completion_tokens") or 0) for r in executed)
    failure_counts: Dict[str, int] = {}
    for r in ws_rows:
        fc = r.get("failure_category")
        if fc:
            failure_counts[fc] = failure_counts.get(fc, 0) + 1
    retrieval_not_measured = any(
        r.get("retrieval_metrics_status") == "NOT_MEASURED_POST_FILTERED_CITATIONS" for r in executed
    )
    return {
        "total_cases": len(ws_rows),
        "executed_cases": len(executed),
        "not_run_cases": len(ws_rows) - len(executed),
        "task_check_passed_cases": sum(1 for v in task_checks if v),
        "task_check_failed_cases": sum(1 for v in task_checks if not v),
        "rag_quality": {
            "retrieval_recall_at_8": (
                round(statistics.mean(recalls), 4)
                if recalls
                else ("NOT_MEASURED" if retrieval_not_measured else "NOT_RUN")
            ),
            "retrieval_precision_at_8": (
                round(statistics.mean(precisions), 4)
                if precisions
                else ("NOT_MEASURED" if retrieval_not_measured else "NOT_RUN")
            ),
            "retrieval_mrr": (
                round(statistics.mean(mrrs), 4)
                if mrrs
                else ("NOT_MEASURED" if retrieval_not_measured else "NOT_RUN")
            ),
            "cited_precision": round(statistics.mean(cited_precs), 4) if cited_precs else "NOT_RUN",
            "citation_accuracy_pct": round(100.0 * sum(cit_checks) / len(cit_checks), 2) if cit_checks else "NOT_RUN",
            "appropriate_abstention_pct": round(100.0 * sum(abst_checks) / len(abst_checks), 2) if abst_checks else "NOT_RUN",
            "automated_task_success_pct": round(100.0 * sum(task_checks) / len(task_checks), 2) if task_checks else "NOT_RUN",
            "answer_groundedness": "MANUAL_REVIEW_REQUIRED" if executed else "NOT_RUN",
            "unsupported_claim_rate": "MANUAL_REVIEW_REQUIRED" if executed else "NOT_RUN",
        },
        "security_and_access_control": {
            "access_denial_accuracy_pct": round(100.0 * sum(denial_checks) / len(denial_checks), 2) if denial_checks else "NOT_RUN",
            "zero_unauthorized_chunks_exposed_pct": round(100.0 * sum(zero_leak_checks) / len(zero_leak_checks), 2) if zero_leak_checks else "NOT_RUN",
            "unauthorized_exposures_count": sum(1 for v in zero_leak_checks if not v),
        },
        "performance": {
            "p50_latency_ms": percentile_nearest_rank(latencies, 50) if latencies else "NOT_RUN",
            "p95_latency_ms": percentile_nearest_rank(latencies, 95) if latencies else "NOT_RUN",
            "p50_server_ttft_ms": (percentile_nearest_rank(ttfts, 50) if (stream and ttfts) else "NOT_MEASURED"),
            "p95_server_ttft_ms": (percentile_nearest_rank(ttfts, 95) if (stream and ttfts) else "NOT_MEASURED"),
            "p50_client_ttft_ms": (percentile_nearest_rank(client_ttfts, 50) if (stream and client_ttfts) else "NOT_MEASURED"),
            "p95_client_ttft_ms": (percentile_nearest_rank(client_ttfts, 95) if (stream and client_ttfts) else "NOT_MEASURED"),
            "total_prompt_tokens": prompt_tokens,
            "total_completion_tokens": completion_tokens,
            "total_tokens": sum(tot_tokens),
            "mean_total_tokens": round(statistics.mean(tot_tokens), 2) if tot_tokens else "NOT_RUN",
            "api_cost_per_query": "NOT_MEASURED",
        },
        "failure_categories": failure_counts,
    }


def sign_in_supabase(base_url: str, public_key: str, email: str, password: str) -> str:
    resp = requests.post(
        base_url.rstrip("/") + "/auth/v1/token",
        params={"grant_type": "password"},
        json={"email": email, "password": password},
        headers={"apikey": public_key},
        timeout=15,
        allow_redirects=False,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Supabase password login failed (HTTP {resp.status_code}).")
    return resp.json()["access_token"]


def run_live(
    cases: List[Dict[str, Any]],
    endpoint: str,
    stream: bool,
    max_cases: Optional[int],
    selected_ids: Optional[Set[str]] = None,
    enterprise_dept: str = "Engineering",
    enterprise_role: str = "manager",
    enterprise_grants: Optional[Set[str]] = None,
    enterprise_projects: Optional[Set[str]] = None,
    existing_results: Optional[Dict[str, Dict[str, Any]]] = None,
    authz_report_path: Optional[Path] = None,
    v1_report_path: Optional[Path] = None,
) -> Dict[str, Any]:
    load_dotenv(".env.local")
    parsed = urlsplit(endpoint)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Invalid chat endpoint URL.")

    personal_token = os.getenv("EVAL_PERSONAL_ACCESS_TOKEN", "").strip()
    enterprise_token = os.getenv("EVAL_ENTERPRISE_ACCESS_TOKEN", "").strip()
    if not personal_token and os.getenv("EVAL_PERSONAL_EMAIL") and os.getenv("EVAL_PERSONAL_PASSWORD"):
        personal_token = sign_in_supabase(
            os.environ["NEXT_PUBLIC_PERSONAL_SUPABASE_URL"],
            os.getenv("NEXT_PUBLIC_PERSONAL_SUPABASE_PUBLISHABLE_KEY") or os.environ["NEXT_PUBLIC_PERSONAL_SUPABASE_ANON_KEY"],
            os.environ["EVAL_PERSONAL_EMAIL"],
            os.environ["EVAL_PERSONAL_PASSWORD"],
        )
    if not enterprise_token and os.getenv("EVAL_ENTERPRISE_EMAIL") and os.getenv("EVAL_ENTERPRISE_PASSWORD"):
        enterprise_token = sign_in_supabase(
            os.environ["NEXT_PUBLIC_ENTERPRISE_SUPABASE_URL"],
            os.getenv("NEXT_PUBLIC_ENTERPRISE_SUPABASE_PUBLISHABLE_KEY") or os.environ["NEXT_PUBLIC_ENTERPRISE_SUPABASE_ANON_KEY"],
            os.environ["EVAL_ENTERPRISE_EMAIL"],
            os.environ["EVAL_ENTERPRISE_PASSWORD"],
        )

    ent_grants = enterprise_grants or set()
    ent_projects = enterprise_projects or set()
    by_id: Dict[str, Dict[str, Any]] = dict(existing_results or {})
    executed_count = 0
    consecutive_api_errors = 0
    aborted_reason: Optional[str] = None

    for case in cases:
        cid = case["case_id"]
        if cid in by_id and str(by_id[cid].get("live_execution_status", "")).startswith("HTTP_"):
            prev = by_id[cid]
            prev_status = int(str(prev["live_execution_status"]).replace("HTTP_", ""))
            prev_cits = prev.get("citations_detail") or []
            rescore = score_live_case(
                case,
                status_code=prev_status,
                text=prev.get("answer_text") or prev.get("answer_preview") or "",
                citations=prev_cits,
                total_tokens=int(prev.get("total_tokens") or 0),
                stream_error=prev.get("notes") or None,
            )
            by_id[cid] = {**prev, **rescore}
            continue
        if selected_ids is not None and cid not in selected_ids:
            continue

        ws = case["workspace"]
        eligible, skip_reason = is_identity_eligible(
            case,
            enterprise_dept=enterprise_dept,
            enterprise_role=enterprise_role,
            enterprise_grants=ent_grants,
            enterprise_projects=ent_projects,
            personal_available=bool(personal_token),
            enterprise_available=bool(enterprise_token),
        )
        if not eligible:
            by_id[cid] = {
                "case_id": cid,
                "workspace": ws,
                "category": case["category"],
                "expected_behavior": case["expected_behavior"],
                "dataset_grounding_valid": True,
                "v1_comparable": bool(case.get("v1_comparable", False)),
                "live_execution_status": "NOT_RUN",
                "task_check_passed": None,
                "failure_category": None,
                "retrieval_recall_at_8": None,
                "retrieval_precision_at_8": None,
                "retrieval_mrr": None,
                "retrieval_metrics_status": "NOT_RUN",
                "cited_precision": None,
                "zero_unauthorized_chunks_exposed": None,
                "access_denial_correct": None,
                "notes": skip_reason,
            }
            continue

        if max_cases is not None and executed_count >= max_cases:
            by_id[cid] = {
                "case_id": cid,
                "workspace": ws,
                "category": case["category"],
                "expected_behavior": case["expected_behavior"],
                "dataset_grounding_valid": True,
                "v1_comparable": bool(case.get("v1_comparable", False)),
                "live_execution_status": "NOT_RUN",
                "task_check_passed": None,
                "failure_category": None,
                "retrieval_recall_at_8": None,
                "retrieval_precision_at_8": None,
                "retrieval_mrr": None,
                "retrieval_metrics_status": "NOT_RUN",
                "cited_precision": None,
                "zero_unauthorized_chunks_exposed": None,
                "access_denial_correct": None,
                "notes": f"Skipped: reached bounded max_cases={max_cases}.",
            }
            continue

        ctx = case["required_permission_context"]
        is_anon = ctx.get("role") == "anonymous"
        token = "" if is_anon else (personal_token if ws == "personal" else enterprise_token)
        payload: Dict[str, Any] = {"query": case["question"], "stream": stream}
        if ws == "personal":
            payload["projectId"] = ctx["project_id"]
        else:
            payload["organizationId"] = ctx["project_id"]
        headers: Dict[str, str] = {"Content-Type": "application/json", "x-eval-mode": "true"}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        started_at = time.perf_counter()
        resp = requests.post(
            endpoint,
            json=payload,
            headers=headers,
            timeout=50,
            stream=stream,
            allow_redirects=False,
        )
        executed_count += 1
        ctype = resp.headers.get("content-type", "")
        text = ""
        citations: List[Dict[str, Any]] = []
        metrics: Dict[str, Any] = {}
        client_ttft_ms: Optional[float] = None
        client_total_ms = round((time.perf_counter() - started_at) * 1000.0, 2)
        stream_error: Optional[str] = None
        parsed_sse: Dict[str, Any] = {}
        if resp.status_code == 200 and "text/event-stream" in ctype:
            parsed_sse = parse_sse_response(resp, started_at)
            text = parsed_sse["text"]
            citations = parsed_sse["citations"]
            metrics = parsed_sse["metrics"]
            client_ttft_ms = parsed_sse["client_ttft_ms"]
            client_total_ms = parsed_sse["client_total_ms"]
            stream_error = parsed_sse["stream_error"]
        elif "application/json" in ctype:
            body = resp.json()
            text = body.get("text", "")
            citations = body.get("citations", [])
            metrics = body.get("metrics", {})

        retrieved_ids = [c.get("id") for c in citations if isinstance(c, dict) and c.get("id")]
        tok = metrics.get("token_usage") or {}
        latency_ms = metrics.get("total_ms") if metrics.get("total_ms") is not None else client_total_ms
        ttft_ms = metrics.get("ttft_ms") if (stream and metrics.get("ttft_ms") is not None) else None

        scored = score_live_case(
            case,
            status_code=resp.status_code,
            text=text,
            citations=citations,
            total_tokens=int(tok.get("total") or 0),
            stream_error=stream_error,
        )
        if case["expected_behavior"] != "deny_access" and resp.status_code in (401, 403):
            by_id[cid] = {
                "case_id": cid,
                "workspace": ws,
                "category": case["category"],
                "expected_behavior": case["expected_behavior"],
                "dataset_grounding_valid": True,
                "v1_comparable": bool(case.get("v1_comparable", False)),
                "live_execution_status": f"HTTP_{resp.status_code}",
                **scored,
                "latency_ms": latency_ms,
                "notes": "Stopped: unexpected authentication/authorization failure on eligible case.",
            }
            aborted_reason = f"{cid}: unexpected HTTP {resp.status_code} on eligible case"
            break
        if resp.status_code in (429, 500, 502, 503, 504) or stream_error:
            consecutive_api_errors += 1
        elif resp.status_code == 200:
            consecutive_api_errors = 0

        by_id[cid] = {
            "case_id": cid,
            "workspace": ws,
            "category": case["category"],
            "expected_behavior": case["expected_behavior"],
            "dataset_grounding_valid": True,
            "v1_comparable": bool(case.get("v1_comparable", False)),
            "live_execution_status": f"HTTP_{resp.status_code}",
            **scored,
            "latency_ms": latency_ms,
            "ttft_ms": ttft_ms,
            "client_ttft_ms": client_ttft_ms,
            "prompt_tokens": tok.get("prompt"),
            "completion_tokens": tok.get("completion"),
            "total_tokens": tok.get("total"),
            "cost_inr": "NOT_MEASURED",
            "answer_preview": text[:400] if text else "",
            "answer_text": text,
            "cited_chunk_ids": retrieved_ids,
            "citations_detail": [
                {"index": c.get("index"), "id": c.get("id"), "metadata": c.get("metadata", {})}
                for c in citations
                if isinstance(c, dict)
            ],
            "fallback_questions": parsed_sse.get("fallbackQuestions", []),
            "notes": stream_error or "",
        }
        if consecutive_api_errors >= 3:
            aborted_reason = f"Stopped after {consecutive_api_errors} consecutive model/API errors ending at {cid}."
            break

    ordered_results = [by_id[c["case_id"]] for c in cases if c["case_id"] in by_id]
    authz_data = json.loads(authz_report_path.read_text(encoding="utf-8")) if (authz_report_path and authz_report_path.exists()) else {"status": "NOT_RUN"}
    summary = {
        "evaluation_mode": "live",
        "stream_enabled": stream,
        "executed_api_calls": executed_count,
        "aborted_reason": aborted_reason,
        "workspace_summaries": {
            "personal": summarize_workspace_live(ordered_results, "personal", stream),
            "enterprise": summarize_workspace_live(ordered_results, "enterprise", stream),
        },
        "database_authorization_eval": authz_data,
        "v1_vs_v2_comparison": {
            "v1_enterprise_historical_baseline": load_v1_comparison_baseline(v1_report_path),
            "comparability_note": "Historical v1 metrics are NOT directly comparable except across matched D01-D12 / auth-deterministic paired cases.",
        },
    }
    return {"summary": summary, "results": ordered_results}


def main() -> int:
    parser = argparse.ArgumentParser(description="Agentic RAG 40-case Evaluation Suite")
    parser.add_argument("--dataset", default="evals/agentic_eval_40.jsonl")
    parser.add_argument("--mode", choices=("offline", "live"), default="offline")
    parser.add_argument("--confirm-live", action="store_true", help="Required for live LLM/API evaluation calls")
    parser.add_argument("--endpoint", default="http://127.0.0.1:3000/api/chat")
    parser.add_argument("--stream", action="store_true")
    parser.add_argument("--max-cases", type=int, default=38)
    parser.add_argument("--case-ids", default="", help="Comma-separated case IDs (or 'pilot' for 10-case Phase A)")
    parser.add_argument("--merge-from", default="", help="Optional existing results JSON file to merge with")
    parser.add_argument("--enterprise-dept", default="Engineering")
    parser.add_argument("--enterprise-role", default="manager")
    parser.add_argument("--enterprise-grants", default="", help="Comma-separated document UUIDs granted to live test account")
    parser.add_argument("--enterprise-projects", default="", help="Comma-separated project UUIDs for live test account")
    parser.add_argument("--output-prefix", default="")
    parser.add_argument("--authz-report", default="artifacts/evaluation/enterprise_authz_eval.json")
    parser.add_argument("--v1-report", default="../../rag-knowledge-assistant/enterprise_eval_release_report.json")
    parser.add_argument("--output-dir", default="artifacts/evaluation")
    args = parser.parse_args()

    dataset_path = Path(args.dataset)
    cases = load_eval_dataset(dataset_path)

    if args.mode == "offline":
        out = evaluate_offline(
            cases,
            dataset_path,
            Path(args.authz_report) if args.authz_report else None,
            Path(args.v1_report) if args.v1_report else None,
        )
        prefix = args.output_prefix or "agentic_eval_40_offline"
        write_outputs(Path(args.output_dir), out["summary"], out["results"], prefix)
        print(
            f"PASS: Validated {out['summary']['total_cases']} cases "
            f"({out['summary']['personal_cases']} personal, {out['summary']['enterprise_cases']} enterprise). "
            f"SHA256={out['summary']['dataset_sha256']}"
        )
        return 0

    if not args.confirm_live:
        print("FAIL: Live mode requires --confirm-live after user approval.", file=sys.stderr)
        return 2
    selected_ids: Optional[Set[str]] = None
    if args.case_ids.strip().lower() == "pilot":
        selected_ids = set(DEFAULT_PILOT_CASE_IDS)
    elif args.case_ids.strip():
        selected_ids = {s.strip() for s in args.case_ids.split(",") if s.strip()}
    existing_map: Dict[str, Dict[str, Any]] = {}
    if args.merge_from:
        prev = json.loads(Path(args.merge_from).read_text(encoding="utf-8"))
        existing_map = {r["case_id"]: r for r in prev if isinstance(r, dict) and r.get("case_id")}
    grants = {s.strip() for s in args.enterprise_grants.split(",") if s.strip()}
    projects = {s.strip() for s in args.enterprise_projects.split(",") if s.strip()}
    out = run_live(
        cases,
        args.endpoint,
        args.stream,
        args.max_cases,
        selected_ids=selected_ids,
        enterprise_dept=args.enterprise_dept,
        enterprise_role=args.enterprise_role,
        enterprise_grants=grants,
        enterprise_projects=projects,
        existing_results=existing_map,
        authz_report_path=Path(args.authz_report) if args.authz_report else None,
        v1_report_path=Path(args.v1_report) if args.v1_report else None,
    )
    prefix = args.output_prefix or "agentic_eval_40_live"
    write_outputs(Path(args.output_dir), out["summary"], out["results"], prefix)
    if out["summary"].get("aborted_reason"):
        print(f"STOPPED: {out['summary']['aborted_reason']}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
