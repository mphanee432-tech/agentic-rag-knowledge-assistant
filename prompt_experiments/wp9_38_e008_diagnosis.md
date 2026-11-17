# WP9.38 — E008 Answer Accuracy Diagnosis (`v0_results.json` vs. `v0_rebaseline_results.json`)

**Date:** 2026-11-16  
**Scope:** Read-only root-cause investigation of `E008` regression under active prompt `V0` (`lib/prompts/systemPrompt.ts` == `prompt_experiments/V0-enterprise-prompt.txt`). Zero code, prompt, database, document, embedding, golden-suite, or evaluator edits were made, and zero Gemini/Decisions API calls were executed.

---

## 1. E008 Question & Expected Responsibilities (`enterprise_golden_50.json`)

- **Case ID / Persona / Category / Source:** `E008` | `engineering` | `company_policy` | `D01` (`expected_behavior: "answer"`)
- **Query:** `"Who is listed as custodian and independent reviewer for D01?"`
- **Golden Criteria:** `"HR Manager is custodian and Operations Manager independent reviewer."`

---

## 2. Side-by-Side Comparison: Original V0 vs. Fresh V0 Rebaseline

Both runs targeted Enterprise test project `cpowlkptvtnkjkulveph` with active `V0` prompt and produced **byte-identical retrieved context** (`12,220` characters, `8` chunks `[Chunk 1]`–`[Chunk 8]`, all from `D01` `bede95a7-63ea-49ce-9bb5-85798a2da9dc`) and **identical citations**:

| Field | Original V0 (`prompt_experiments/v0_results.json`) | Fresh V0 Rebaseline (`prompt_experiments/v0_rebaseline_results.json`) |
| :--- | :--- | :--- |
| **HTTP Status / Validity** | `200` \| `citation_valid: true` \| `format_valid: true` | `200` \| `citation_valid: true` \| `format_valid: true` |
| **Verdict** | **`PASS`** | **`FAIL`** |
| **`correct_probability`** | `0.8207` (`0.820652...`) | **`0.5636`** (`0.563579...`) |
| **`grounded_probability`** | `0.9155` (`0.915502...`) | **`0.5586`** (`0.558593...`) |
| **Citations Returned** | `[Chunk 1]` (`0109bc3d-6a3a-4990-a916-9804c4bbd8f1`) | `[Chunk 1]` (`0109bc3d-6a3a-4990-a916-9804c4bbd8f1`) |
| **Retrieved Context** | `12,220` chars (`8` chunks) | `12,220` chars (`8` chunks) — **100% identical** |
| **Chatbot Answer** | `"Based on the document control details for D01, the custodian is the HR Manager / Operations Manager [Chunk 1]."` | `"The custodian for D01 is the HR Manager / Operations Manager, and the independent reviewer is also listed as the HR Manager / Operations Manager [Chunk 1]."` |

*(Additional observed context from earlier runs on the same `12,220`-char `D01` context: `V1` preserved the verbatim table row `* **Custodian / independent reviewer:** HR Manager / Operations Manager [Chunk 1].` -> `PASS` at `0.9312` / `0.9633`; `V2` produced the exact same sentence as Original `V0` -> `PASS` at `0.8207` / `0.9155`.)*

---

## 3. Source Evidence Inspection (`D01` PDF, Stored DB Chunks, and Policy Corpus)

### 3.1 Exact Text in Retrieved `[Chunk 1]` and `D01` Source (`D01_Revised_Candidate_1_1.pdf`)
Page 1 of `../Policies/V 1.1/D01_Revised_Candidate_1_1.pdf` (matching indexed DB chunk `0` / retrieved `[Chunk 1]`) renders the `DOCUMENT CONTROL` table verbatim as:

```markdown
DECCANBRIDGE SOFTWARE / PEOPLE & WORKPLACE
# Employee Handbook

| DOCUMENT CONTROL | APPROVED SCENARIO DETAILS |
| :--- | :--- |
| Document ID / version | D01 / Candidate 1.1 for independent review |
| Classification / audience | Company-wide / Standard \| All active employees |
| Custodian / independent reviewer | HR Manager / Operations Manager |
| Scenario effective / next review | 1 November 2026 / 1 November 2027 |
| Publication state | Synthetic candidate - not approved for upload, publication or indexing |
```

### 3.2 Full `D01` Scan (All `5` Pages / All `12` Indexed DB Chunks)
Reading the complete 5-page `D01` PDF (`V 1.0` and `V 1.1`) and all `12` stored `D01` chunks in Supabase confirms:
- **Zero prose assignment anywhere in `D01`:** `HR Manager` and `Operations Manager` appear **only once** in the entire `D01` document—inside that single `Custodian / independent reviewer | HR Manager / Operations Manager` row on page 1.
- **Section 2 (`[Chunk 7]`, page 1):** Notes generally that functional managers and policy custodians govern procedures while an `"Operations Knowledge Administrator coordinates uploads of Standard materials"`, without naming D01's custodian or reviewer.
- **Section 17 (`[Chunk 4]`, page 5):** States the generic workflow rule (`"A departmental custodian owns the policy content and classification, and an independent editorial reviewer checks clarity and correctness"`), without naming `HR Manager` or `Operations Manager`.
- **Section 21 (`[Chunk 2]`, page 5):** Defines `Custodian` generically (`"person accountable for policy content/classification"`).

### 3.3 Does the Table Ordering Alone Establish the Mapping?
- **Positional convention suggests it, but the table formatting is genuinely ambiguous in isolation:**
  1. Rows 1 and 4 pair two fields positionally around `/` (`Document ID / version` -> `D01 / Candidate 1.1 ...`; `Scenario effective / next review` -> `1 November 2026 / 1 November 2027`).
  2. **However, Row 2 breaks 1-to-1 `/` pairing:** `Classification / audience` maps to `Company-wide / Standard | All active employees`, where the first `/` sits **inside** a single compound attribute (`Company-wide / Standard`) and a pipe `|` separates the two fields instead.
  3. Because `/` in English commonly denotes `"or"` or `"shared/joint"` (and Row 2 proves `/` is not consistently a field separator within that same 4-row table), an LLM reading `Custodian / independent reviewer | HR Manager / Operations Manager` without external context cannot rely purely on `/` splitting without ambiguity—indeed, in **both** Original `V0` and Fresh Rebaseline `V0`, the model treated `"HR Manager / Operations Manager"` as a single combined string rather than splitting it.

### 3.4 Independent Corroboration of Intended Mapping (Outside `D01` Table Cell)
Even without assuming the golden answer, three independent facts in the source repository confirm `Custodian = HR Manager` and `Independent reviewer = Operations Manager`:
1. **`D01` ownership metadata:** `D01` is issued under `DECCANBRIDGE SOFTWARE / PEOPLE & WORKPLACE` and indexed in the `HR Knowledge Base` project (`a774548e-818a-43a0-851d-74badf1e1a0f`, `HR` department `859355c7-c42c-4db8-b827-a13d0b827641`).
2. **Corpus governance pattern (`D02`–`D12`):** Across every sibling document in `../Policies/V 1.0/` and `../Policies/V 1.1/`, the custodian is the owning department's manager/representative (`HR Manager` for `D02` & `D03`; `Engineering Manager` for `D04`; `Finance Manager` for `D10` & `D11`, etc.), and the independent reviewer is a separate cross-functional role. Specifically, HR's other company-wide Standard policy (`D02_Leave_and_Attendance_Policy...html`) explicitly lists:
   - `Content custodian`: **`HR Manager`**
   - `Independent reviewer`: **`Operations Manager`**
3. **Separate-field formatting in every sibling policy (`D02`–`D12`):** Unlike `D01`, every inspected sibling policy places `Policy custodian` / `Content custodian` and `Independent [editorial] reviewer` in separate labeled rows/fields—and none of them exhibited this ambiguity failure.

---

## 4. Root-Cause Assessment

| Classification | Role in `E008` Failure | Supporting Evidence |
| :--- | :--- | :--- |
| **Ambiguous source-document formatting** | **Primary Root Cause** | `D01` compresses two distinct governance roles into one slash-delimited cell (`Custodian / independent reviewer \| HR Manager / Operations Manager`) in a table where Row 2 already uses `/` intra-value (`Company-wide / Standard`), with no prose elsewhere in `D01` disambiguating who holds which role. |
| **Model generation variability & evaluator sensitivity** | **Trigger Between Runs** | Given **100% identical retrieved chunks** (`12,220` chars) and identical `V0` prompt, Original `V0` output `"the custodian is the HR Manager / Operations Manager"` (actually omitting independent reviewer yet passing narrowly at `0.8207`), whereas Rebaseline `V0` explicitly duplicated the combined string onto both roles (`"custodian ... HR Manager / Operations Manager, and the independent reviewer is also listed as the HR Manager / Operations Manager"`), causing the Decisions judge to penalize the explicit conflation (`0.5636` `FAIL`). |
| **Retrieval / chunk formatting problem** | **Ruled Out** | Both runs retrieved identical `8` chunks (`12,220` chars), and `[Chunk 1]` preserved `D01`'s markdown table accurately. |
| **Incorrect golden expectation** | **Ruled Out** | Cross-checking `D01` (`PEOPLE & WORKPLACE`, `HR Knowledge Base`) and sibling `D02` (`HR Manager` custodian / `Operations Manager` reviewer) independently confirms `HR Manager` = custodian and `Operations Manager` = independent reviewer. |

---

## 5. Fix Options & Recommendation (Awaiting Approval Before Implementation)

Per WP9.38 constraints, **no changes have been implemented**. Adding a new global instruction to the `V0` system prompt is explicitly **not recommended**, because the ambiguity originates in one table row of `D01` (all sibling documents `D02`–`D12` already separate these fields), and prompt edits risk regressions elsewhere (as seen in `V1`/`V2`).

### Option A — Clarify `D01` Source Wording *(Recommended Root-Cause Fix)*
- **Proposed Minimal Change:** In `D01`'s `DOCUMENT CONTROL` table (`D01_Revised_Candidate_1_1.pdf`), replace the single combined row:
  - `| Custodian / independent reviewer | HR Manager / Operations Manager |`
  with two explicit rows matching `D02`–`D12`:
  - `| Document custodian | HR Manager |`
  - `| Independent reviewer | Operations Manager |`
- **Trade-offs:**
  - Permanently eliminates the source ambiguity at the root while keeping `V0` prompt, retrieval logic, golden suite, and evaluator rules 100% intact.
  - **Caveat:** Requires updating the `D01` document asset, re-running ingestion/re-embedding on `cpowlkptvtnkjkulveph`, and noting in portfolio documentation that `D01` moved from `Candidate 1.1` to a formatted clarification (reducing strict bit-for-bit corpus identity against historical `v0`/`v1`/`v2` snapshots). Also note `D01`'s synthetic footer governance label would need to remain intentional test-corpus hygiene.

### Option B — Preserve `V0` and Frozen `D01` Corpus, Document Variability *(Zero-Change Alternative)*
- **Proposed Action:** Keep `V0` and the currently indexed `D01` chunks frozen and document `E008` (`~0.56`–`0.93` judge spread on identical retrieved context) as an isolated source-table phrasing boundary artifact rather than a prompt regression.
- **Trade-offs:** Zero engineering or API cost and preserves strict corpus comparability across `V0`/`V1`/`V2`, but leaves `E008` non-deterministic on future 50-case runs whenever the LLM expands `/` into `"both/either"` instead of echoing the table row verbatim.

---

## 6. Re-Embedding, Re-Evaluation, Complexity & API Cost Estimate

| Dimension | Option A (Clarify `D01` Source Row) | Option B (Preserve `V0` & Document Variability) |
| :--- | :--- | :--- |
| **Re-embedding needed?** | **Yes — `D01` only** (`1` document, `5` pages / `~12` chunks via `app/api/enterprise/ingest`: `1` PDF extraction call on `gemini-3.5-flash-lite` + `~12` `gemini-embedding-2` calls). | **No** |
| **Evaluation rerun needed?** | **Yes** — minimum `1` verification run on `E008` (`1` embedding + `1` chat generation + `1` `gemini-decision-1` call), plus optionally a `50`-case `V0` baseline refresh (`50` chat + `50` judge calls) if updating the portfolio benchmark after corpus change. | **No** (`$0`) |
| **Implementation complexity** | **Low** — small single-row edit in source PDF + single-document re-ingestion through existing `enterprise/ingest` route (after user approval). | **Trivial / Zero code** — documentation only. |
| **Estimated API cost** | **Minimal / Negligible** (`~1` extraction + `~12` embedding calls + `1` E008 eval check, or `+50` chat / `50` judge calls if running a full 50-case refresh). | **`$0` (Zero API calls)** |
