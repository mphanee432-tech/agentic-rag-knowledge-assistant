# Agentic RAG v2 — Live & Offline Evaluation Report (AI PM & Evaluation Evidence)

## Option B final acceptance verification — 22 November 2026

**Overall Verdict: CONDITIONAL / PARTIALLY BLOCKED — not unconditionally Development Complete for full live acceptance.** All implemented Option B behaviors verified in code, `152/152` focused TypeScript tests, `8/8` PGlite AuthZ SQL checks, `6/6` PGlite Jira signup provisioning checks, and live Personal + Enterprise browser E2E flows passed. **Two live acceptance items remain `BLOCKED` due to corpus/credential boundaries (not code failures):** (1) live first-miss → second-hit retrieval recovery where Attempt 1 actually lacks the answer and Attempt 2 finds it on the existing corpus (hybrid `gemini-embedding-2` + RRF already returns answer-bearing chunks on Attempt 1), and (2) live browser click of **Cancel** inside `JiraTicketDraftForm` (because `.env.local` has only opted-out `EVAL_ENTERPRISE_EMAIL` and no password for the two confirmed Jira-enabled accounts; blocked-account denial (`403`), source-contract confirmation gates, and prior user-confirmed real `ECD-6` creation + live `/api/jira/status` passed).

This section supersedes the earlier pre-fix scorecard below. All live verification after the Jira provisioning and keyless-follow-up fixes ran with zero changes to models, documents, database permissions, or architecture, and zero real Jira ticket mutations during verification. No Git commits or deployments were performed.

### Final acceptance PASS / FAIL / BLOCKED scorecard (22 November 2026)

| Criterion | Status | Observed Evidence |
| --- | --- | --- |
| **1. Option B tool selection & clarification** | **PASS** | Single-agent `selectAgentTool` routes deterministic replies, explicit/follow-up `jira_status`, `jira_status_clarification` (when no ticket key exists), `jira_create_draft`, and `rag_retrieval`. Verified in `152/152` TS tests and Playwright UI (`"Please share the Jira ticket ID (for example, ECD-6) so I can check its status."` without RAG fallback or refusal). |
| **2. Personal RAG grounded answer, streaming & persistence** | **PASS** | Live Playwright browser E2E (`first project`, `3c7605fb-...`) streamed `"Should we use Kafka or Kubernetes initially when building a RAG system with fewer than 10,000 chunks?"` (`HTTP 200`, `text/event-stream`), cited `[Chunk 1]`, and persisted `public.interactions` (`before: 11 → after: 13`, ID `359ec244-f127-4bca-a820-7b468ffeebf0`, `8` chunks, `2614ms`). Abstention `"What is quuxzorb flarbnox?"` returned `"I don't know."` and persisted `8973fbf7-43d3-46e3-9655-c105ceac96af` (`2668ms`). |
| **3. Enterprise RAG grounded answer, citations & streaming** | **PASS** | Live Playwright UI (`EVAL_ENTERPRISE_EMAIL`) on `"Who is the D01 document custodian?"` streamed `"The D01 document custodian is the HR Manager [Chunk 1]."` (`092b0fd8-37b6-4bfc-97ea-6912d84f2bff`) with clickable citation source and zero `interactions` persistence (`0 → 0`). |
| **4. Authorization, cross-tenant isolation & abstention** | **PASS** | Live Playwright D03 query (`"What does D03 say about executive compensation escalation?"`) ran bounded `2` retrievals / `6` steps (`retrieved_chunk_count: 0`, `evidence_sufficient: false`) and streamed `"I don't know based on the documents I can access."` with 4 accessible fallback questions and `0` citations. Live cross-tenant API checks: Personal JWT → Enterprise `/api/chat` returned `401`; Enterprise JWT → Personal project `/api/chat` returned `404`. Offline PGlite RLS suite `8/8 PASS`. |
| **5. Bounded execution & loop limits** | **PASS** | Restricted D03 trace stopped at `steps: 6/6`, `retrieval_attempts: 2/2`, `generation_ms: 0`; Personal `"What is quuxzorb flarbnox?"` abstained cleanly; unit tests verify step-limit error throw at `> 6` steps and retry cap of `1`. |
| **6. Live second retrieval recovery (first-miss → second-hit)** | **BLOCKED** | Read-only corpus probes (`search_rag_chunks` & `search_enterprise_chunks`) showed answerable queries already match `>= 1` keyword on Attempt 1, and paraphrased queries that tripped `zero_keyword_overlap` (`"How frequently should snapshots be archived?"`) already had the answer chunk (`4cd833e1-...`, daily backups) ranked `#1` on Attempt 1 (`ids1HasBackup: true`). Restricted queries (`D03`) genuinely execute two attempts (`reformulated: true`) and abstain cleanly, and mocked `/api/chat` proves recovery in `tests/agentic-eval-behavior.test.ts`, but a natural live Attempt 1 miss → Attempt 2 hit recovery could not be triggered on the unchanged corpus. |
| **7. Jira provisioning, explicit/keyless status & reload persistence** | **PASS** | Hosted migration `20261122081000_restore_demo_jira_signup_trigger.sql` and 2-account backfill (`d42e40d5-...`, `12ff1269-...`) applied & verified (`6/6` PGlite checks; `2` hosted rows). Prior user-verified live `/api/jira/create` produced real issue `ECD-6`. Playwright UI verified explicit status (`"What is the status of ECD-6?"` → `ECD-6 — In Progress`), same-session keyless follow-up (`"What is the status of my ticket?"` → `ECD-6 — In Progress`), persistence across `page.reload()` via scoped `sessionStorage`, missing-key clarification, and reset after `Clear Session`. Direct `POST /api/chat` returned `tool: "jira_status"` and `tool: "jira_status_clarification"` accurately. |
| **8. Jira authorization enforcement & cancellation safety** | **PARTIAL / BLOCKED (UI Cancel)** | **Authorization enforcement — PASS:** Live `http://localhost:3000/api/jira/options` and `/api/jira/create` returned `401` unauthenticated and `403 "Jira access is not enabled for this account."` for `EVAL_ENTERPRISE_EMAIL`; `/api/jira/status` returned `403` for `KAN-1` and foreign orgs; Playwright UI with `Jira Access: Disabled` ignored `"Create a Jira ticket..."` for drafting (`0` draft forms, `0` `/api/jira/create` calls). **Cancellation safety — BLOCKED live UI / PASS automated & source:** `JiraTicketDraftForm` binds `confirmJiraTicket` only to `Confirm` and `closeJiraDraft` to `Cancel` (verified in `152/152` TS suite), but clicking **Cancel** live in the browser could not be run because `.env.local` has no password for either Jira-enabled account (`phani9119jira*`) and DB/account modification is prohibited. |

### Historical Jira signup provisioning & initial verification log — 22 November 2026

After the initial Option B verification identified why new Enterprise signups opting into Jira remained blocked (`on_auth_user_created_demo_jira` and `public.handle_demo_jira_signup()` were missing from the hosted `agentic-enterprise-rag` schema), the following scoped database remediation was approved, tested locally in PGlite, and applied to `agentic-enterprise-rag` (`ldkxyleqfbovqpkpoyek`):

- **Migration & restricted backfill applied:**
  - `supabase/migrations/20261122081000_restore_demo_jira_signup_trigger.sql` restored `public.handle_demo_jira_signup()` (`SECURITY DEFINER`, `set search_path = pg_catalog, public, pg_temp`, `EXECUTE` revoked from `public`, `anon`, `authenticated`, and `service_role`) and `on_auth_user_created_demo_jira` (`AFTER INSERT OR UPDATE OF email_confirmed_at ON auth.users`).
  - `supabase/ingestion/backfill_demo_jira_access.sql` inserted `enabled = true` (`ON CONFLICT (user_id) DO NOTHING`) restricted strictly to the two verified, confirmed Engineering test accounts with active `organization_employees` membership: `d42e40d5-e1f5-4261-b002-a02b10c7c4dd` and `12ff1269-30f0-48b0-ad9b-76a93d8e90b1`.
  - No application code, models, documents, `organization_employees` rows, or existing RLS policies (`enterprise_demo_jira_own`) were modified.
- **Database authorization verified:** Post-apply hosted checks confirmed `on_auth_user_created_demo_jira` and `public.handle_demo_jira_signup()` exist, `public.demo_jira_access` contains only `d42e40d5-e1f5-4261-b002-a02b10c7c4dd` and `12ff1269-30f0-48b0-ad9b-76a93d8e90b1` (`enabled = true`), unbackfilled (`23940244-...`) and unconfirmed (`3cdc4da4-...`) accounts remain blocked (`403` on `/api/jira/options` and `/api/jira/create`), PGlite passed `6/6`, and `pnpm exec tsx --test` passed `152/152` across `tests/jira-ticket.test.ts`, `tests/agentic-eval-behavior.test.ts`, `tests/authorization-routes.test.ts`, `tests/chat-route.test.ts`, and `tests/chat-input.test.ts`.

### Evidence and execution boundary

- **Current focused TypeScript rerun: 178/178 PASS**, zero failures/skips. Command: `node --import tsx --test tests/agentic-eval-behavior.test.ts tests/chat-route.test.ts tests/authorization-routes.test.ts tests/jira-ticket.test.ts tests/retrieve-chunks.test.ts tests/citations.test.ts tests/chat-contract.test.ts tests/chat-input.test.ts`. This is a deliberately scoped rerun; it does not replace or claim to reproduce the previously reported 204/204 suite.
- **Current SQL rerun: 8/8 PASS**, `AUTHZ-01`–`AUTHZ-08`, disposable PGlite + pgvector, timestamp `2026-11-22T02:24:30.949Z` (07:54:30 IST). The existing SQL script was evaluated in memory with its artifact write replaced by console output and its import paths adjusted for stdin execution. Its SQL and assertions were unchanged; hosted Supabase was not used for this suite.
- **25 focused probes:** 17 invocations of the existing chat handler with real authenticated Supabase/Gemini services, 5 Personal component-level retrieval/generation probes, 2 Jira rejection-handler probes, and 1 tool-selection probe using live account availability. Across these probes, the observer recorded **24 search RPC calls, 24 embedding requests, and 11 generation requests**. No retrieval results or model outputs were mocked in the live probes.
- **Live means real upstream services, not a deployed/browser test:** handlers were imported with `node --import tsx --input-type=module` and invoked with native `Request` objects. Enterprise JSON and SSE paths ran unchanged. No Next.js server was listening initially; browser rendering, middleware, cookie authentication, and deployed-route parity were not exercised. Bearer authentication used the existing evaluation accounts.
- The in-memory harness observed actual fetch requests/responses and retained query text, returned IDs, answer/context, citations, and `metrics.agent`. It blocked application-table mutations and external Jira action endpoints. Personal probes used the existing `runBoundedRetrievalLoop`, `retrieveVerifiedChunks`, `getSystemPrompt('baseline', ...)`, and `assertValidAnswer`, with the same embedding/generation settings as the route, but omitted interaction persistence. No source files were modified to build this harness.
- **Models retained:** `gemini-embedding-2`, 1536 dimensions; `gemini-3.5-flash-lite`, 1000 output tokens, generation `maxRetries: 0`. The user explicitly approved sending existing evaluation-document excerpts to configured Google Gemini after automatic approval review initially blocked that payload. The blocked attempt did not execute; approval resolved that blocker.

### PASS/FAIL scorecard

| Verification | Result | Supporting evidence / qualification |
| --- | --- | --- |
| Personal retrieval, grounded answer, abstention, clarification | **PASS, component scope** | P01 answered fewer than 10,000 chunks with valid `[Chunk 3, Chunk 5]`; P10 returned exactly `I don't know.`; P14 produced a complete cited, conditional deployment/sizing answer and asked for growth/traffic/budget/compliance details. All passed the existing answer contract. Successful answer-route persistence was not run. |
| Enterprise grounded answers and E18 fix | **PASS** | E01 cited D01 department/level evidence. E18 JSON and SSE returned HR Manager, Operations Manager, 1 November 2026, and 1 November 2027, all grounded in `[Chunk 1]`, ID `092b0fd8-37b6-4bfc-97ea-6912d84f2bff`. |
| Genuine second retrieval | **PASS** | E10/E11/E15/E21 and E-EMPTY-STOP each made two distinct live search queries and two embedding requests; no transport retry was used. Personal P-SECOND-EXACT also made two distinct searches with different ranked results. Full examples below. |
| Citation correctness | **PASS, sampled** | Manually compared E01/E18 and P01/P14 claims against their full retrieved source text, not just 300-character citation previews. All cited indices resolved to returned IDs; refusals had no inline citations. E18 SSE retained the same correct control-chunk citation. This is sampled grounding evidence, not a fresh 40-case accuracy percentage. |
| Live access control and injection defense | **PASS, available identities** | P12 foreign project returned 404; P13 invalid token returned 401; foreign Enterprise org returned 404; Personal token against Enterprise returned 401. All four stopped before embedding/retrieval/generation. E10 D03, E11 D11, E15 D09, and E21 escalation injection exposed zero restricted chunks across both retrievals and refused. E22 refused without exposing a key or system prompt. SQL 8/8 separately covers alternate-role/grant combinations. |
| Stopping limits and safe abstention | **PASS** | Enterprise two-attempt traces ended at `steps: 6`, `max_steps: 6`, `retrieval_attempts: 2`, `max_retrieval_attempts: 2`; empty evidence caused zero generation requests. E10 SSE emitted `metadata`, `text`, `finish` with no error. Personal two-attempt component trace ended at step 5 before the route's final-answer increment. No observed trace exceeded either bound. |
| E25 fallback fix and stream completion | **PASS** | E25 JSON and SSE returned exactly `I don't know based on the documents I can access.`, empty released citations, and four accessible fallback questions. E18/E10/E25 SSE each completed with a finish event and zero error events. |
| Jira authorization rejection | **PASS, denial scope** | Create probe returned 403 `Jira access is not enabled for this account.`; KAN-1 status probe returned 403 `Only ECD project Jira tickets are accessible in this demo.` No action webhook was called. The create probe proves account denial, not the later project-allowlist branch. |
| Jira enabled-user draft and explicit confirmation, live | **FAIL — BLOCKED** | Existing `demo_jira_access` lookup yielded `enabled !== true`; the live-availability tool-selection probe therefore returned `rag_retrieval`, not a draft. Existing mocked/source-contract tests pass for `requiresConfirmation: true` and the UI confirm callback, but no enabled-account browser draft/cancel/confirm flow was exercised. Account data was not changed to manufacture coverage. |

### Recorded agent traces

**Enterprise E10: real second retrieval, authorization preserved, then bounded refusal**

```text
Attempt 1 query: What is the D03 confidential compensation document-grant escalation chain and primary approver?
Attempt 1: search_enterprise_chunks HTTP 200, []
Attempt 2 query: d03 confidential compensation document grant escalation chain primary approver
Attempt 2: search_enterprise_chunks HTTP 200, []
Observed calls: embedding=2, search=2, generation=0
metrics.retries: embedding=0, retrieval=0, generation=0
agent: tool=rag_retrieval, steps=6/6, retrieval_attempts=2/2,
       reformulated=true, evidence_sufficient=false, reason=no_chunks_retrieved
Answer: I don't know based on the documents I can access.
Released citations: []
```

The SSE rerun reproduced two searches, the same refusal and bounds, four fallback questions, and `metadata -> text -> finish`, with zero error events. E11, E15, E21, and E-EMPTY-STOP independently exhibited the same two-attempt/no-generation stopping pattern. This is query reformulation and a new retrieval, distinct from the existing RPC transport retry.

**Personal P-SECOND-EXACT: distinct queries and changed evidence ranking**

```text
Attempt 1 query: What is quuxzorb flarbnox?
Attempt 2 query: quuxzorb flarbnox
Both search_rag_chunks responses: HTTP 200, 8 candidates
Attempt 1 included 0a77ac45-1712-4a4d-b190-afe0acc312c5
Attempt 2 included 91e32e7b-edf5-4e6e-bb1c-311635335e01 instead
Observed calls: embedding=2, search=2, generation=1
agent: steps=5/6 (component trace), retrieval_attempts=2/2,
       reformulated=true, evidence_sufficient=false, reason=zero_keyword_overlap
Answer: I don't know.
Answer contract: PASS; no interaction insert attempted
```

This case proves second retrieval and safe final abstention with nonempty irrelevant candidates. It does **not** prove a live first-miss/second-hit successful answer. That recovery-success scenario passed the existing mocked Enterprise route test only.

**Grounding anchors**

| Probe | Verified source mapping | Observed answer |
| --- | --- | --- |
| E01 | `[Chunk 2]` → `9b09d94f-7923-4361-8f2f-ce429c36ece3` | Eight departments; Employee → Manager → CXO; CEO/COO Executive affiliation, outside the eight functional departments. |
| E18 JSON + SSE | `[Chunk 1]` → `092b0fd8-37b6-4bfc-97ea-6912d84f2bff` | HR Manager custodian; Operations Manager reviewer; effective 1 November 2026; review 1 November 2027. All four values match the control table. |
| P01 | `[Chunk 3]` → `dfeb1bf9-8ef0-4899-903c-7ee0d4a48bb0`; `[Chunk 5]` → `38a01af9-01da-4e13-a7b3-2d75715422c6` | Avoid the named infrastructure/agent complexity initially for fewer than 10,000 chunks. |
| P14 | `[Chunk 1]` → `8baee136-768d-4f76-9870-9cf1d23cf257`; `[Chunk 2]` → `8fa65da0-b4fc-4f62-9d72-15b7fb065ee4`; `[Chunk 4]` → `4cd833e1-8e0e-48e5-9a70-c3ca3ba89e38`; `[Chunk 7]` → `b66a9c8c-028b-4ce3-9c79-8e721a22c919` | Conditional scale table, managed hosting/database/worker, and recovery guidance match the retrieved excerpts; requests missing sizing inputs. |

E25's four questions covered Engineering pull-request approval, general Employee Handbook responsibilities, leave requests, and equipment/service requests. No restricted-document suggestion was released.

### Data preservation and reproducibility

Caller-visible row counts before and after the initial 21 probes were identical. These are RLS-filtered counts, **not** a fresh inventory of the full Enterprise corpus; do not compare the six visible documents with the historical 13-document administrative inventory.

| Workspace | Documents | Chunks | Interactions | Document grants | Project memberships |
| --- | --- | --- | --- | --- | --- |
| Personal, before → after | 1 → 1 | 43 → 43 | 11 → 11 | N/A | N/A |
| Enterprise, before → after | 6 → 6 | 40 → 40 | 0 → 0 | 0 → 0 | 0 → 0 |

The four supplemental probes used only search/visibility/fallback RPCs, source reads, and Gemini; application-table mutations remained blocked. No service-role credentials were used by the live harness. Authentication used ordinary password sign-in, which may update Auth session/login metadata; the preservation claim concerns application data, documents, and permissions. Counts alone do not prove byte-for-byte database equality; the read-only call boundary is the additional control.

Raw traces were retained outside the repository so only this report is updated. Essential queries, bounds, IDs, answers, and coverage limitations are embedded above; temporary files are supplementary local evidence:

- `C:/Users/User/AppData/Local/Temp/option-b-final-live-20261122.json`, completed `2026-11-22T02:25:10.630Z` (07:55:10 IST), SHA256 `2410f857feec6c0447148d7550ba9be3fcd353ab9dc954d774b89b7881622efd`.
- `C:/Users/User/AppData/Local/Temp/option-b-final-extra-20261122.json`, SHA256 `346c98c1be9c4c4c47646f6e62c94592a264faa622bb1bcc52768d8481e85785`.
- Existing post-fix artifact inspected: `artifacts/evaluation/agentic_eval_post_fix_results.json`, SHA256 `824c423158030e44fee6e04644f0113444955187f65db428dbdad9d1be01be65`, eight Enterprise passes including E18/E25. It lacks `metrics.agent` traces, so it was not treated as proof of second retrieval.
- Dataset retained unchanged: `evals/agentic_eval_40.jsonl`, SHA256 `edea81651a3e1d20f973b15c9b8f0e223d01d4d9e76b5efaa4a2569bf16b8641`. Its older `NOT_IMPLEMENTED` prose and the runner's legacy capability summary are stale; neither was changed under this report-only scope. The runner also skips Jira cases and does not preserve the agent trace, which is why the focused observer was used.

Inspected implementation hashes: `lib/agent-loop.ts` = `7a0282867a523fc9f08d152117c40640cfe1097b141e61ffaa7005fe19b6f57a`; `app/api/chat/route.ts` = `9c14ad1af06ed26ba3b30e8833e031abf33eddb8e2fadbcb3d68e6d5ffe6e297`.

### Remaining blockers and limits (as of 22 November 2026 final acceptance)

1. **Live authenticated UI Cancel check for Jira ticket drafts:** Live `/api/jira/options`, `/api/jira/create` (`ECD-6` created prior to final verification), `/api/jira/status` (explicit + keyless + reload + `Clear Session`), and unauthorized-user `401`/`403` denials are all verified live. Clicking **Cancel** inside `JiraTicketDraftForm` in the browser could not be exercised live because `.env.local` provides only opted-out `EVAL_ENTERPRISE_EMAIL` (`Jira Access: Disabled`) and no credentials for the two Jira-enabled accounts; source inspection and `152/152` TS tests cover cancellation (`onCancel={closeJiraDraft}`).
2. **Live positive second-retrieval recovery (first-miss → second-hit):** Two-attempt execution and safe abstention/reformulation (`E10`, `D03`, `What is quuxzorb flarbnox?`) are proven live, and mocked `/api/chat` proves recovery in `tests/agentic-eval-behavior.test.ts`. However, on existing Personal and Enterprise documents, `gemini-embedding-2` + hybrid RRF already retrieves answer-bearing chunks on Attempt 1 (even on paraphrased probes such as `"How frequently should snapshots be archived?"`, where Attempt 1 ranked `"### Backups and recovery"` at `#1`), so a natural live first-miss → second-hit recovery remains `BLOCKED` / unobserved without modifying the corpus or retrieval rules.
3. **Sufficiency is heuristic:** E25 and `"What is quuxzorb flarbnox?"` were marked `evidence_sufficient: true` because of keyword overlap despite lacking an answer, and the model then abstained safely; nonempty evidence is passed to generation even when the heuristic flags insufficient (`zero_keyword_overlap`), and the tested model abstained appropriately.
4. **Portfolio environment scope:** Deployed production endpoints, live grant-holder/alternate-department sessions (`D03`/`D11`/`D12` live tokens), and mid-request permission revocation were not run in live HTTP/browser E2E (`8/8` PGlite SQL and mocked route suites cover those permission boundaries).

## Historical evaluation — before Option B final verification

The remainder is preserved historical evidence. Its `NOT_IMPLEMENTED` capability statements describe the earlier pipeline, and its E18/E25 open-gap statements are superseded by the post-fix evidence and current verification above. Historical rates, counts, and v1 comparisons were not recomputed or pooled with today's focused probes.

> **Execution Status:** Deterministic offline suites, isolated PGlite SQL authorization (`6/6`), **Phase A Live Pilot (`10` calls)**, and **Phase B Live Evaluation (`24` additional calls, `34` live `/api/chat` calls total)** are complete.  
> **Scope Safeguards Preserved:** Zero application code, model settings, Supabase schemas/RLS/grants, uploaded documents, or Classic RAG v1 files were modified. `0` Jira write actions were triggered. Preserved raw pilot artifacts (`agentic_eval_pilot_*`) and v1 historical baseline SHA256 hashes matched identically before and after Phase B.

---

## Executive Scorecard Summary

| Workspace | Executed / Total | Automated Runner Pass | Manual Groundedness / Task Success | Citation Accuracy | Security / Zero Unauthorized Exposure | P50 / P95 Latency | P50 / P95 Server TTFT (`--stream`) | Total Tokens | API Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Personal RAG (v2)** | `15 / 15` (`0` skipped) | `86.67%` (`13/15`) | **`93.33%`** (`14/15`, see `P10`/`P14`) | **`100.0%`** (`12/12` valid HTTP 200) | `100%` on isolation (`P12` `404`, `P13` `401`); runner flagged `P10` falsely (`1` false-positive leak) | `5144.07 ms` / `11811.0 ms` | `6310.0 ms` / `11791.0 ms` | `46,948` (`3,912.33`/q) | `NOT_MEASURED` |
| **Enterprise RAG (v2)** | `19 / 25` (`6 NOT_RUN`) | `94.74%` (`18/19`) | **`94.74%`** (`18/19`, `1` false refusal `E18`) | `94.74%` (`18/19`) | **`100.0%`** (`0` unauthorized exposures; `+ 6/6` PGlite SQL) | `5031.0 ms` / `15067.0 ms` | `4874.0 ms` / `15057.0 ms` | `97,314` (`5,121.79`/q) | `NOT_MEASURED` |

> **Why Automated vs. Manual Personal Pass Differ (`13/15` vs. `14/15`):** Case `P10` (`unanswerable` pricing question, authorized project owner) returned the exact expected refusal `"I don't know."`. The runner flagged `P10` under `unauthorized_chunk_or_leak` because `supporting_references` pointed to Personal cost-model chunk `57cacc8d-...`, which Personal `/api/chat` legitimately included in its raw top-8 `metadata.citations` list before the LLM abstained. Manual review confirms **`P10` passed cleanly**; only `P14` (`stream_error` mid-stream) failed live in Personal RAG.

---

## 1. Personal RAG (v2) Scorecard (`15` Cases)

- **Workspace & Project:** `agentic-personal-rag` (`jdwttbkjpssrbeaoyzkc`), project `3c7605fb-9ab8-4931-854c-9ccb3cc8077a`, corpus `Production_RAG_Architecture_Considerations.pdf` (`43` chunks).
- **Database Side Effect Verified:** `public.interactions` increased **`0` -> `4` (Phase A) -> `11` (Phase B)** (`1` row per completed non-deterministic Personal query; `P12` `HTTP 404`, `P13` `HTTP 401`, `P14` mid-stream error, and `P15` deterministic greeting did not insert `interactions` rows). Zero other DB writes occurred.
- **Cases (`15/15` Executed, `0` Skipped):**
  - **Retrieval Metrics (Measured on Raw Top-8 Candidates emitted in `metadata.citations`):**
    - **Retrieval Recall@8:** `0.9444` *(positive cases `P01–P09`; `P10`/`P11` `refuse` and `P12`/`P13`/`P15` excluded as `N/A`; `P14` `ERROR`)*
    - **Retrieval Precision@8:** `0.2222`
    - **Retrieval MRR:** `0.9111`
    - **Cited Precision (Cited `[Chunk N]` subset):** `0.8148`
  - **Quality & Abstention:**
    - **Citation Accuracy:** `100.0%` (`12/12` completed HTTP 200 cases, excluding errored `P14` and HTTP `401`/`404` `P12`/`P13`)
    - **Appropriate Abstention:** `100.0%` (`2/2`: `P10` and `P11` both returned `"I don't know."`)
    - **Manual Groundedness Review:** **`14/15`** verified accurate (`P01–P11` accurate and grounded, `P12` `HTTP_404`, `P13` `HTTP_401`, `P15` `"Hello! How can I help you?"`); `P14` truncated mid-stream.
  - **Access & Project Isolation:**
    - **Access Denial Accuracy:** `100.0%` (`P12` foreign project -> `HTTP 404` in `559.1 ms`; `P13` unauthenticated -> `HTTP 401` in `39.53 ms`).
  - **Performance & Usage (`--stream` single pass):**
    - **Latency (`metrics.total_ms`):** P50 = `5144.07 ms`, P95 = `11811.0 ms` (max `11811 ms` on `P02`)
    - **Server TTFT (`metrics.ttft_ms`):** P50 = `6310.0 ms`, P95 = `11791.0 ms` *(note: P50 server TTFT is higher than overall P50 latency because `P12` 404, `P13` 401, and `P14` errored stream had `ttft_ms = null`, shrinking the TTFT sample set to `11` completed streamed responses)*
    - **Client TTFT (SSE first text delta):** P50 = `6464.53 ms`, P95 = `20012.34 ms`
    - **Tokens (`12` metered cases):** `45,932` prompt + `1,016` completion = **`46,948` total** (mean `3,912.33` tokens/query; `P15` `"Hello!"` used `0` tokens)
    - **API Cost:** `NOT_MEASURED` (no verified Gemini per-token rate table in repository)

---

## 2. Enterprise RAG (v2) Scorecard (`25` Cases)

- **Workspace & Identity Context:** `agentic-enterprise-rag` (`ldkxyleqfbovqpkpoyek`), org `c0000000-0000-4000-8000-000000000001`, authenticated user `phani9119@gmail.com` (`Engineering`, `manager`, `0` document grants, `0` project memberships). Corpus: `13` published documents (`D01`–`D12` [`96` chunks] + `DeccanBridge_Synthetic_Office_Book_Exchange_Policy.pdf` [`2` chunks] = `98` chunks).
- **Database Side Effect Verified:** **`0` writes** (`interactions: 0`, `documents: 13`, `document_chunks: 98`, `document_grants: 0`, `project_memberships: 0`).
- **Cases (`19` Executed, `6 NOT_RUN`):**
  - **Eligible Executed (`19`):** `E01`–`E08`, `E10`–`E11`, `E15`–`E22`, `E25`
  - **Unavailable Identities / Grants Marked `NOT_RUN` (`4`):** `E09` (requires `UI/UX` dept), `E12` (requires `Finance` + `D11` grant), `E13` (requires Product Launch project membership), `E14` (requires project membership + `D12` grant) — **all verified in isolated PGlite SQL tests (`AUTHZ-02`, `AUTHZ-03`, `AUTHZ-04`)**
  - **Skipped Action Cases Marked `NOT_RUN` (`2`):** `E23` (Jira status), `E24` (Jira create) — **verified offline via deterministic unit & route tests**
- **Retrieval & Quality Metrics (Post-Filtered Citation Discipline):**
  - **Retrieval Recall@8 / Precision@8 / MRR:** **`NOT_MEASURED`** — `/api/chat` filters Enterprise `metadata.citations` down to only `[Chunk N]` references actually cited in the validated answer and does not expose uncited candidate chunk IDs/ranks without altering application code.
  - **Cited Precision (Cited `[Chunk N]` subset):** **`0.8182`**
  - **Citation Accuracy:** **`94.74%`** (`18/19`; only failure was `E18` false abstention)
  - **Automated Task Success & Manual Groundedness:** **`94.74%`** (`18/19` both automated and manual review — including `E04` currency handling `₹500`/`₹5,000`, `E05`–`E06` Book Exchange v2 policy, `E07`–`E08` Engineering D04 policy, `E16`–`E17` multi-doc synthesis, and `E19` D02 grounded-negative explanation)
  - **Appropriate Abstention:** Automated runner scored `87.5%` (`7/8`) because `E19` (`grounded_negative_or_refuse`) gave a cited negative explanation from D02 (`"does not establish a numeric allowance... [Chunk 3]"`) instead of the exact `"I don't know..."` string. Manually, **`6/6` (`100%`)** pure refusal cases (`E10`, `E11`, `E15`, `E20`, `E21`, `E25`) + **`1/1`** prompt-injection refusal (`E22`) returned the exact Enterprise refusal string, and **`1/1`** grounded-negative (`E19`) answered accurately.
- **Security & Access Control (Live + Isolated SQL):**
  - **Live Access Denial Accuracy:** **`100.0%`** (`5/5`: `E10` D03, `E11` D11, `E15` D09 cross-dept, `E21` escalation injection, `E22` table-override injection)
  - **Live Unauthorized Exposures:** **`0`** (`100.0%` zero unauthorized chunks exposed)
  - **Isolated PGlite + pgvector SQL Authorization Suite (`AUTHZ-01`–`AUTHZ-06`):** **`6/6 PASS`** (`100%`)
- **Performance & Usage (`--stream` single pass):**
  - **Latency (`metrics.total_ms`):** P50 = `5031.0 ms`, P95 = `15067.0 ms` (`E15` `15067 ms`, `E02` `11354 ms`, `E04` `11055 ms`, `E08` `10307 ms`)
  - **Server TTFT (`metrics.ttft_ms`):** P50 = `4874.0 ms`, P95 = `15057.0 ms` *(server records TTFT at first model token before citation+visibility buffering)*
  - **Client TTFT (SSE first text delta):** P50 = `5140.87 ms`, P95 = `15267.27 ms`
  - **Tokens (`19` metered calls):** `96,218` prompt + `1,096` completion = **`97,314` total** (mean `5,121.79` tokens/query)
  - **API Cost:** `NOT_MEASURED`

---

## 3. Live Failure & Reliability Analysis

| Item | Workspace / Case | Observation | Root Cause & PM / Engineering Impact |
| --- | --- | --- | --- |
| **Mid-stream Gemini failure** | Personal `P14` (`ambiguous_query`) | HTTP `200` stream aborted mid-sentence after `4138 ms` with SSE `error` event `"The answer could not be completed. Please retry."` (`5144 ms`, `0` persisted tokens/interactions row). | Genuine transient provider/stream interruption. App uses `maxRetries: 0` on LLM generation (`app/api/chat/route.ts`), so it fails closed safely without persisting a partial interaction rather than retrying. |
| **False refusal on accessible doc metadata** | Enterprise `E18` (`citation_correctness`, D01 custodian/dates) | Returned `"I don't know based on the documents I can access."` (`4812` prompt tokens, `13` completion tokens, `3662 ms`). | Either hybrid RRF top-8 missed the D01 control-table chunk `092b0fd8...` or `prepareEnterpriseAnswer` rejected an un-cited draft. Actionable candidate for retrieval-ranking/metadata tuning. |
| **Missing live fallback RPC** | Enterprise `E25` (`agentic_failure_recovery`, cafeteria sushi) | Safely returned `"I don't know based on the documents I can access."`, but `fallback_questions` was `[]` and query spent `5,361` tokens. | Live query `pg_proc` check confirmed `enterprise_fallback_documents` **does not exist** on `ldkxyleqfbovqpkpoyek` (`getEnterpriseFallbackQuestions` silently catches errors and returns `[]`), and loose RRF candidates still triggered Gemini. Offline mocked tests masked this DB gap. |
| **Runner false-positive leak on `P10`** | Personal `P10` (`unanswerable`) | Automated runner flagged `unauthorized_chunk_or_leak` because `supporting_references` held Personal chunk `57cacc8d-...`. | Evaluation script bug on authorized unanswerable Personal cases (fixed conceptually by scoping `forbidden` strictly to `SECURITY_DENIAL_CATEGORIES`); manually verified `P10` passed (`"I don't know."`). |
| **High P95 latency (`> 8s` PRD target)** | Personal (`11.81 s`) & Enterprise (`15.07 s`) | Both workspaces exceeded the `8.0 s` P95 latency and `2.0 s` TTFT targets in single-pass streaming. | Driven by `~4K–5.7K` prompt tokens per call + Gemini streaming initialization/response variance, plus Enterprise full-answer buffering for `enterprise_chunks_still_visible` re-check. |

---

## 4. Verification Methods & Agentic Capability Matrix

**Clear separation of evidence:**
- **Deterministic Offline Tests:** `50/50` Python unit tests (`0.212s`), `41/41` TypeScript unit/mocked route tests (`agentic-eval-behavior`, `enterprise-upload-ui`, `authorization-routes`, `automatic-ingestion`, `jira-ticket`, `retrieve-chunks`), `pnpm typecheck`, and `eslint`. *(Pre-existing untouched failure in `scripts/test_eval_runner.py::test_recovered_transport_errors_are_not_erased` remains separate and documented.)*
- **Isolated SQL Authorization Tests:** `6/6 PASS` in disposable PGlite + pgvector (`scripts/test_enterprise_authz_eval.mjs`).
- **Automated Live Runner Checks (`34` requests):** Dataset SHA256 `edea8165...`, SSE parsing, `[Chunk N]` citation contract, exact refusal matching, `0` leaked restricted chunks.
- **Manual Groundedness Review (`34` requests):** Human inspection of every `answer_text` against ground-truth references (`14/15` Personal true pass, `18/19` Enterprise true pass).

### Agentic Capability Coverage

| Capability | Status | Verification Basis |
| --- | --- | --- |
| Deterministic greeting/identity/capability routing | `IMPLEMENTED_AND_TESTED` | Tested live on `P15` (`620 ms`, `0` tokens) + unit tests |
| Regex Jira status routing (`ECD-*` allowlist) | `IMPLEMENTED_AND_TESTED` | Deterministic TS tests only (`E23` skipped live per write safeguard) |
| Jira ticket draft & human confirmation gate | `IMPLEMENTED_AND_TESTED` | Deterministic TS/UI tests only (`E24` skipped live per write safeguard) |
| Single retrieval RPC transport retry (`<= 1`) | `IMPLEMENTED_AND_TESTED` | Mocked unit tests (`tests/retrieve-chunks.test.ts`, `tests/agentic-eval-behavior.test.ts`) |
| Enterprise fallback questions RPC (`enterprise_fallback_documents`) | `PARTIAL_LIVE_GAP` | Mocked unit test passes, but RPC is **absent on live Enterprise DB** (`E25` `fallback_questions = []`) |
| LLM multi-step tool-calling loop (`tools` / `maxSteps`) | `NOT_IMPLEMENTED` | Static assertion in `tests/agentic-eval-behavior.test.ts` |
| Autonomous query-rewrite recovery loop | `NOT_IMPLEMENTED` | Audited in `app/api/chat/route.ts` |
| Agent maximum-step loop controller | `NOT_IMPLEMENTED` | Static assertion (`maxRetries: 0`, no loop) |
| Enterprise multi-turn memory | `NOT_IMPLEMENTED_BY_DESIGN` | Inspected in `app/api/chat/route.ts` (line 288) |

---

## 5. Comparison Against Classic RAG v1 (With Limitations)

| Dimension | Classic RAG v1 (Historical Enterprise Baseline, `2026-11-18`) | Agentic Enterprise RAG v2 (Live Paired D01–D12 Subset) | Agentic Enterprise RAG v2 (All Executed Live Cases) |
| --- | --- | --- | --- |
| **Cases Included** | `50` (`32/8/6/2/2` Enterprise) | `17` executed D01–D12 cases (`E05–E06` Book Exchange & `6 NOT_RUN` excluded) | `19` executed (`17` D01–D12 + `2` v2-only Book Exchange) |
| **Pass Rate** | `100.0%` (`50/50`) | **`94.12%`** (`16/17`; `1` miss on `E18`) | **`94.74%`** (`18/19`) |
| **Citation Validity** | `100.0%` | `94.12%` (`16/17`) | `94.74%` (`18/19`) |
| **P95 Total Latency** | `14006.49 ms` | `15067.0 ms` *(P50 `5086.0 ms` on 17 paired cases)* | `15067.0 ms` |
| **TTFT / Cost** | `NOT_MEASURED` / `NOT_MEASURED` | P50 `5017 ms`, P95 `15057 ms` / `NOT_MEASURED` | P50 `4874 ms`, P95 `15057 ms` / `NOT_MEASURED` |

**Comparison Limitations:** Historical v1 metrics come from an earlier run with a 50-case question set, non-streaming/different execution conditions, and unmeasured TTFT; only the `17` executed D01–D12 Enterprise cases share the underlying document corpus (`E05`–`E06` and all Personal blueprint cases `P01`–`P11`, `P14` exist only in v2). Structurally, `app/api/chat/route.ts` shares the same core retrieval/generation flow (`3` lines different in `logTiming`), while v2's differentiators are Enterprise upload/publish restoration, isolated multi-workspace automatic ingestion, recovery Cron, and expanded corpora.

---

## 6. Pilot Preservation, Scoring Change Log & Remaining Gaps

- **Preserved Pilot Outputs (`sha256` verified identical pre- vs. post-Phase B):**
  - `agentic_eval_pilot_results.json`: `98994E6B050B4776DB1F6704BE35FE12560C369472D7F78F8DE417DA3FD86191`
  - `agentic_eval_pilot_summary.json`: `02E717A2AFB161628F3CCB0D060CBAF02D60ED28B56B18DA6B16CCBAA58A212D`
  - Classic v1 `enterprise_eval_release_report.json`: `14A036C1E9DB9E7B229C894FE944964789D06187B7652E28BDAB2B19BAB83958`
- **Documented Scoring Changes (in [scripts/agentic_eval_suite.py](file:///g:/AI%20Tools%20and%20Resources/RAG/Agentic%20RAG/Agentic-rag-knowledge-assistant/scripts/agentic_eval_suite.py)):**
  1. Byte-buffered UTF-8 SSE frame decoding fixed `\ufffd` corruption for all 24 Phase B cases (`E04` `₹`, `E19` `—` clean; pilot rows `E01`/`E16` kept original pilot text unchanged).
  2. Restricted/denial cases exclude provenance chunks from Retrieval Recall@8 / Precision@8 / MRR denominators and explicitly track `zero_unauthorized_chunks_exposed` and `access_denial_correct`.
  3. Enterprise raw Retrieval Precision@8 / Recall@8 / MRR reported as `NOT_MEASURED` (distinct from `cited_precision = 0.8182`) because `/api/chat` emits only post-filtered cited chunks.
- **Remaining Gaps:** Deploy `enterprise_fallback_documents` RPC to live Enterprise DB (`FALLBACK_RPC: []`), add optional read-only UI/UX & grant-holder test accounts if live chat testing of `E09`/`E12`/`E13`/`E14` is desired, configure audited Gemini pricing if INR cost SLAs are required, investigate `E18` control-table retrieval miss, and reduce prompt/generation latency below the `8.0 s` P95 target.
