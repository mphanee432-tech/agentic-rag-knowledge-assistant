# WP9.36 — V0 Evaluation Rebaseline Comparison Report

> **Experiment Integrity:** V0 remains active in `lib/prompts/systemPrompt.ts` (matching `prompt_experiments/V0-enterprise-prompt.txt`), targeting Enterprise test Supabase project `cpowlkptvtnkjkulveph` with identical evaluator rules, golden questions (`enterprise_golden_50.json`), retrieval, and personas. Historical V0, V1, and V2 artifacts were preserved untouched, and provider errors in the fresh run were kept verbatim without retries or substitutions.

---

## 1. Automated 50-Case Comparison: Original V0 vs. Fresh V0 Rebaseline

| Metric / Gate | Original V0 (`prompt_experiments/v0_results.json`) | Fresh V0 Rebaseline (`prompt_experiments/v0_rebaseline_results.json`) | Delta / Notes |
| :--- | :--- | :--- | :--- |
| **Total Cases Evaluated** | `50 / 50` | `50 / 50` | Same 32 / 8 / 6 / 2 / 2 suite |
| **PASS / REVIEW / FAIL / ERROR** | **`50 / 0 / 0 / 0`** | **`47 / 0 / 1 / 2`** | `-3 PASS`, `+1 FAIL` (`E008`), `+2 ERROR` (`E009`, `E011`) |
| **Combined Answer Pass Rate (`>=90%`)** | `100.0%` (`50/50`) | `94.0%` (`47/50`) | Core gate `PASS`, though overall benchmark `FAIL` due to `request_errors` |
| **Mean Correct Probability** *(48 non-ERROR cases in Rebaseline)* | `0.9453` | `0.9339` | `-0.0114` |
| **Mean Grounded Probability** *(48 non-ERROR cases in Rebaseline)* | `0.9506` | `0.9370` | `-0.0136` |
| **Citation Validity (`>=95%`)** | `100.0%` (`PASS`) | `96.0%` (`PASS`) | `48/48` HTTP-200 responses valid; `E009`/`E011` HTTP-500 counted invalid |
| **Format Conformance (`>=98%`)** | `100.0%` (`PASS`) | `96.0%` (**`FAIL`**) | `48/48` HTTP-200 responses valid; `E009`/`E011` HTTP-500 counted invalid |
| **Access Refusal (`6/6`)** | `6 / 6` (`100.0%`, `PASS`) | `6 / 6` (`100.0%`, `PASS`) | Unchanged |
| **Unsupported Refusal (`2/2`)** | `2 / 2` (`100.0%`, `PASS`) | `2 / 2` (`100.0%`, `PASS`) | Unchanged |
| **Prompt Injection (`2/2`)** | `2 / 2` (`100.0%`, `PASS`) | `2 / 2` (`100.0%`, `PASS`) | Unchanged |
| **Answer-Length Failures (`>4,000` chars)** | `0` | `0` | `answer_length_failed: false` on all 50 server records |
| **P95 Total Latency (`<=8000 ms`)** | `4187.14 ms` (`PASS`) | **`26570.0 ms`** (**`FAIL`**) | Upstream Gemini generation slowdown (`median gen_ms: 9394 ms`, `max: 29555 ms`) |
| **Portfolio Release-Gate Decision** | **`PORTFOLIO_PASS_NOT_DEPLOYMENT_CERTIFIED`** (`PASS`) | **`PORTFOLIO_FAIL`** (`FAIL`) | Blocked by `request_errors` (`2` chatbot HTTP 500s) |

---

## 2. Case-by-Case Verdict Changes & Observable Root Causes

Across all **48 HTTP-200 responses**, retrieved context was **100% identical** between the original V0 run and the fresh V0 rebaseline (`0` retrieved context changes). Only **3 cases** changed verdict:

| Case ID | Original V0 | Fresh V0 Rebaseline | Attribution & Supporting Evidence |
| :--- | :--- | :--- | :--- |
| **E008** | `PASS` (`0.8207` / `0.9155`) | **`FAIL`** (`0.5636` / `0.5586`, HTTP `200`) | **Possible model/evaluator variability on identical evidence (`12,220` chars):** `Chunk 1` in D01 lists `\| Custodian / independent reviewer \| HR Manager / Operations Manager \|`. Original V0 answered `"the custodian is the HR Manager / Operations Manager [Chunk 1]"`; Rebaseline V0 explicitly attributed both roles to the combined string (`"and the independent reviewer is also listed as the HR Manager / Operations Manager [Chunk 1]"`), which failed the criterion expecting `"HR Manager"` as custodian and `"Operations Manager"` as independent reviewer. |
| **E009** | `PASS` (`0.9455` / `0.9717`) | **`ERROR`** (`Chat HTTP 500`, `5.23s`) | **Observable upstream provider error:** `.next/dev/logs/next-development.log` records `retrieved_chunk_count: 6`, `retrieval_ms: 256`, `failure_category: "provider_error"`, `provider_error_status: 503`, `provider_error_code: "UNAVAILABLE"`, `provider_error_message: "This model is currently experiencing high demand. Please try again later."` (`elapsed_ms: 5115.8`). |
| **E011** | `PASS` (`0.9821` / `0.9454`) | **`ERROR`** (`Chat HTTP 500`, `36.60s`) | **Observable generation stall/timeout during upstream high-demand episode:** `.next/dev/logs/next-development.log` records successful `auth_ms: 381.7`, `embedding_ms: 837`, `retrieval_ms: 291` (`retrieved_chunk_count: 8`), followed by a hang matching the `35,000 ms` `generateText` `AbortSignal.timeout(35000)` (`elapsed_ms: 36537.9`, `generation_ms: 0`, `failure_category: "unknown_error"`). |

- **Latency cause:** Server timing logs confirm embedding (`max: 2256 ms`) and Supabase hybrid retrieval (`max: 987 ms`) remained fast; latency spikes (`8s–30s`, `p95_total_latency: 26,570.0 ms`) occurred in `gemini-3.5-flash-lite` generation during an external high-demand period coinciding with the `503 UNAVAILABLE` response.
- **Safety & citation integrity:** All `6` `access_refusal`, `2` `unsupported_refusal`, `2` `prompt_injection`, and `8` `department_policy` (`E033`–`E040`) cases passed (`100%`), with `0` `answer_length_failed` and `0` `citation_validation_failed` rejections.

---

## 3. Rebaselined Completeness Metric (Reported Separately from 50-Case Benchmark)

From `prompt_experiments/wp9_36_v0_completeness_baseline.md` (manual, evidence-based scoring over the 10 complex procedural cases from `v0_results.json`, excluding out-of-scope Jira/cross-gate checklist noise):
- **Mean case-level completeness:** **73.4%** *(up from WP9.34's `67.3%`)*
- **Point-level micro-average:** **41 / 54 (75.9%)** *(up from WP9.34's `42 / 61 = 68.9%`)*
- **100% complete cases:** **1 / 10** (`E015`)
- **Lowest scores (remaining D04 multi-subsection gap):** `E035` (**2/5 = 40.0%**), `E033` (**2/4 = 50.0%**)
- **Company-policy & D07 UI/UX handoff completeness:** `66.7%`–`100.0%` across the other 8 reviewed cases (`0` incorrect statements).

*(This manual completeness score measures informational coverage on 10 complex questions and is not part of the automated 50-case release gates.)*

---

## 4. Reliability Concerns & Baseline Suitability Assessment

### Identified Reliability Concerns
1. **Upstream model availability / tail-latency sensitivity (`E009`, `E011`, P95 `26.57s`):** Because `generateText` runs with `maxRetries: 0` against `gemini-3.5-flash-lite`, transient provider `503 UNAVAILABLE` responses and >`35s` stalls fail immediately with HTTP 500 and push P95 latency well above the `8,000 ms` stretch target (`format_conformance` also drops to `96.0%` because non-200 errors count as `format_valid=false`).
2. **Boundary sensitivity on compact multi-value markdown cells (`E008`):** D01's table packs both custodian and reviewer into a single slash-delimited cell (`HR Manager / Operations Manager`), creating run-to-run phrasing variability near the `0.8` judge threshold (`0.8207` PASS vs. `0.5636` FAIL on identical retrieved context).
3. **JSON-mode `AbortSignal.timeout(35000)` telemetry classification:** On `E011`, a `35s` `generateText` timeout fell into `failure_stage: "unknown"`, `failure_category: "unknown_error"` rather than `provider_timeout` (a telemetry observability limitation, though unrelated to prompt choice).

### Suitability of V0 as Portfolio Baseline
- **Yes — V0 remains the best-available portfolio baseline**, with two operational caveats documented above:
  - Retrieval and security controls (`access_refusal 6/6`, `unsupported_refusal 2/2`, `prompt_injection 2/2`, `0` length rejections, `0` citation rejections, `48/48` valid HTTP-200 outputs) are **100% consistent** across runs.
  - Neither prompt alternative (`V1` `48/50` `FAIL` on `E040`, nor `V2` `46/50` `PORTFOLIO_FAIL` on `E017`/`E040`) outperformed V0; `V0` stays cleanly under `MAX_ANSWER_CHARS = 4000` when the provider is healthy (`4.19s` P95 in WP9.31).
  - Evaluating release readiness from a single fresh run during an upstream Gemini `503`/slowdown window highlights why transient `ERROR` runs (`E009`, `E011`) should be tracked separately from prompt regressions (e.g., via `--retry-errors` when authorized for operational release certification, while keeping raw un-retried snapshots for reliability transparency).

