# WP9.38 — One-Time `D01` Corpus Maintenance & `E008` Verification Report

**Date:** 2026-11-16  
**Final Status:** **`PASS`** *(One-time `D01` maintenance completed safely and `3 / 3` fresh `E008` queries passed with valid citations; overall Enterprise RAG remains **not deployment-certified**.)*  
**Target Supabase Project:** `cpowlkptvtnkjkulveph` (Personal RAG `smhzdovflyuqznpcxype` never touched)  
**Active System Prompt:** `V0` unchanged (`lib/prompts/systemPrompt.ts` matches `prompt_experiments/V0-enterprise-prompt.txt`)  
**Historical Artifacts Preserved:** `prompt_experiments/v0_results.json`, `prompt_experiments/v0_rebaseline_results.json`, `prompt_experiments/v1_results.json`, and `prompt_experiments/v2_results.json` remain untouched and reflect the prior `D01` (`Candidate 1.1`, `storage_path` ending in `D01_Revised_Candidate_1_1.pdf`) corpus version.

---

## 1. Preflight & Scope Verification

- Reviewed [wp9_38_e008_diagnosis.md](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/prompt_experiments/wp9_38_e008_diagnosis.md), [wp9_38_e008_fix_report.md](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/prompt_experiments/wp9_38_e008_fix_report.md) (prior automated-UI blocker notice), `app/api/enterprise/ingest/route.ts`, and `lib/chunking/splitter.ts`.
- Verified authorized maintenance connectivity:
  - Direct PostgreSQL maintenance connection (`psql` as `postgres` on `cpowlkptvtnkjkulveph`, `public.documents` triggers: `delete_document_children` on `DELETE`, `guard_document_scope` on `UPDATE OF access_scope`; `public.document_chunks` `embedding vector(1536)`, generated `fts tsvector`, foreign keys from `document_chunks` and `document_grants` preserved by in-place update without `DELETE`).
  - Authorized Storage HTTP API using privileged key (never exposed in browser code, outputs, or reports).
  - Active local Next.js server (`http://127.0.0.1:3000`) running V0 against `cpowlkptvtnkjkulveph`.
  - No `EVAL_TEST_EMAIL` workaround or fake permission edits were performed.

---

## 2. Backup & Rollback Preparation (Verified Before Any Mutation)

Stored locally in `wp9_38_d01_backup/` (excluded from Git via `.gitignore`):
- **Original Storage PDF backup:** `wp9_38_d01_backup/original_D01_from_storage.pdf` (`116,026` bytes, SHA-256 `bcb2dd6ee1b8566408e6c78b460da0cb05a970b7beedbf6785a1a42609b5dee8` — byte-for-byte match with `G:\AI Tools and Resources\RAG\Policies\V 1.1\D01_Revised_Candidate_1_1.pdf`).
- **PostgreSQL record & chunk/embedding backup:** `wp9_38_d01_backup/original_d01_document_row.json` and `wp9_38_d01_backup/original_d01_chunks.json` (all `12` chunks, `1536`-dimension vectors, JSON metadata, and original UUIDs).
- **Pre-maintenance corpus snapshot:** `wp9_38_d01_backup/pre_maintenance_corpus_hashes.json` (`17` total rows in `public.documents`, including `D01` `chunks_md5 = 98eda1415a00b1e13e0bfb27d14d7a5e` and hashes for all `D02`–`D12` records).
- **Rollback readiness verified:** Generated `wp9_38_d01_backup/rollback.sql` and `wp9_38_d01_backup/ROLLBACK_PROCEDURE.md` and dry-ran `rollback.sql` inside `BEGIN; ... ROLLBACK;` against `cpowlkptvtnkjkulveph` (`DRY_RUN_RC: 0`, `DELETE 12`, `12` inserts, `UPDATE 1`, restored `chunks_md5 = 98eda1415a00b1e13e0bfb27d14d7a5e`).

---

## 3. Source PDF Correction & Offline Replacement Preparation

- **Original PDF preserved:** `G:\AI Tools and Resources\RAG\Policies\V 1.1\D01_Revised_Candidate_1_1.pdf` (`116,026` bytes, SHA-256 `bcb2dd6ee1b8566408e6c78b460da0cb05a970b7beedbf6785a1a42609b5dee8`).
- **New versioned PDF saved:** `G:\AI Tools and Resources\RAG\Policies\V 1.1\D01_Revised_Candidate_1_1_custodian_fixed.pdf` (`110,453` bytes, SHA-256 `ba4c18e8415899423a8af38b1af3035e429895315c6ad6518e37b042700abab7`).
- **Exact text change on Page 1 (`DOCUMENT CONTROL` table):**
  - Replaced `Custodian / independent reviewer | HR Manager / Operations Manager`
  - With two explicit rows:
    - `Document custodian | HR Manager`
    - `Independent reviewer | Operations Manager`
  - Underlying covered table text in Page 1 PDF streams was stripped cleanly alongside the new visual table draw, and all 5 pages were visually and OCR-inspected (`Document custodian HR Manager` / `Independent reviewer Operations Manager` present; `Custodian / independent reviewer` / `HR Manager / Operations Manager` absent; Pages 2–5 and surrounding layout intact with zero clipping or overlap).
- **Offline chunk & embedding preparation:** Reused exact ingestion pipeline logic (`gemini-3.5-flash-lite` PDF extraction -> `lib/chunking/splitter.ts` `splitMarkdown(..., { minTokens: 300, maxTokens: 800 })` -> `gemini-embedding-2` `1536`d embeddings), yielding **`12` chunks** (`18,868` Markdown characters) with all `21` numbered sections (`1.`–`21.`) intact and matching heading structure (`headings_match = True` across `12 / 12` chunks).

---

## 4. Storage Staging & Transactional Database Cutover

- **Storage staging:** Uploaded corrected PDF via Storage HTTP API (`HTTP 200`) to a new versioned path without touching the original Storage object or writing `storage.objects` SQL:
  - **Original Storage path (preserved intact, verified SHA-256 match):**  
    `enterprise/a774548e-818a-43a0-851d-74badf1e1a0f/bede95a7-63ea-49ce-9bb5-85798a2da9dc/D01_Revised_Candidate_1_1.pdf`
  - **Updated Storage path (read-back verified SHA-256 `ba4c18e8415899423a8af38b1af3035e429895315c6ad6518e37b042700abab7`):**  
    `enterprise/a774548e-818a-43a0-851d-74badf1e1a0f/bede95a7-63ea-49ce-9bb5-85798a2da9dc/D01_Revised_Candidate_1_1_custodian_fixed.pdf`
- **Controlled DB transaction (`cutover.sql`, `BEGIN; ... COMMIT;`, `CUTOVER_RC: 0`):**
  - Locked `bede95a7-63ea-49ce-9bb5-85798a2da9dc` `FOR UPDATE`, verified pre-conditions (`status='indexed'`, `is_published=true`, `classification='standard'`, `access_scope='company'`, `12` existing chunks).
  - Replaced only the `12` chunks for `bede95a7-63ea-49ce-9bb5-85798a2da9dc` (`DELETE 12`, `12` inserts with `vector(1536)` + auto-computed `fts`).
  - Updated only `storage_path` and `expected_size` (`116,026` -> `110,453`) on `bede95a7-63ea-49ce-9bb5-85798a2da9dc`, preserving `id`, `project_id` (`a774548e-818a-43a0-851d-74badf1e1a0f`), `classification`, `access_scope`, `status`, and `is_published`.
  - Validated `12` chunks, `1536` dimensions, explicit wording present, stale wording absent, and `1` published `D01` out of `17` total rows before `COMMIT`.

---

## 5. Post-Update Corpus & RLS Verification

- **Corpus integrity diff (`pre_maintenance_corpus_hashes.json` vs. `post_maintenance_corpus_hashes.json`):**
  - **`CHANGED_DOCUMENTS_COUNT: 1`** — only `bede95a7-63ea-49ce-9bb5-85798a2da9dc` changed (`storage_path`, `expected_size`: `116026 -> 110453`, `chunks_md5`: `98eda1415a00b1e13e0bfb27d14d7a5e -> c75c07726732791a43cdcd75a3e9e43f`).
  - All `16` other rows in `public.documents` (including every published `D02`–`D12` record) had **zero** chunk count, hash, status, classification, scope, or publication changes.
- **Chunk counts (`D01` before / after):** `12` -> `12` (`status='indexed'`, `is_published=true`, `classification='standard'`, `access_scope='company'`).
- **Employee RLS & retrieval verification (authenticated real JWTs + anon key):**
  - `engineering`: `read_enterprise_document(D01) = 12` rows (explicit rows present, stale rows absent), `D04 = 6`, `D07 = 0` (`D01_visible = True`).
  - `uiux`: `read_enterprise_document(D01) = 12` rows (explicit rows present, stale rows absent), `D04 = 0`, `D07 = 8` (`D01_visible = True`).
  - `search_enterprise_chunks("D01 Employee Handbook")`: `8` hits (`explicit = 1`, `stale = 0`).

---

## 6. E008 3-Attempt Fresh Answer & Citation Verification (`V0` Prompt)

Query sent `3` fresh times to `http://127.0.0.1:3000/api/chat` (`x-eval-mode: true`, `organizationId: c0000000-0000-4000-8000-000000000001`, authenticated as `engineering`):  
`"Who is listed as custodian and independent reviewer for D01?"`

| Attempt | HTTP / Latency | Response Text (`V0`) | Cited Chunk UUID & `[Chunk N]` | In Updated `D01`? | Reauth (`eng` / `uiux`) | Pass? |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `200` (`4.61s`) | `"Based on the employee handbook (policy D01), the document custodian is the HR Manager, and the independent reviewer is the Operations Manager [Chunk 1]."` | `64ae9a95-cdac-49b1-8310-0a4218cd15a5` (`[Chunk 1]`) | `True` | `True` / `True` | **PASS** |
| **2** | `200` (`4.15s`) | `"For policy D01, the document custodian is the HR Manager, and the independent reviewer is the Operations Manager [Chunk 1]."` | `64ae9a95-cdac-49b1-8310-0a4218cd15a5` (`[Chunk 1]`) | `True` | `True` / `True` | **PASS** |
| **3** | `200` (`3.92s`) | `"Based on the retrieved document, the custodian and independent reviewer for D01 are:\n\n- **Document custodian:** HR Manager [Chunk 1]\n- **Independent reviewer:** Operations Manager [Chunk 1]"` | `64ae9a95-cdac-49b1-8310-0a4218cd15a5` (`[Chunk 1]`) | `True` | `True` / `True` | **PASS** |

- **All `3 / 3` attempts:**
  - Explicitly identified **HR Manager** as Document custodian and **Operations Manager** as Independent reviewer.
  - Did **not** assign either role to both managers.
  - Returned retrieved context (`12,376` chars) containing explicit rows and `0` stale rows, with valid `[Chunk 1]` citation matching updated `D01` (`64ae9a95-cdac-49b1-8310-0a4218cd15a5`) and passing live `enterprise_chunks_still_visible` reauthorization for both `engineering` and `uiux`.

---

## 7. Remaining Limitations

1. **One-time test-corpus maintenance only:** Application UI/API still lacks a built-in replace/withdraw flow for published Enterprise documents (historical unpublished drafts `8d94c6c7...` and `c7bd3372...` from prior Nov 13 runs remain untouched in `HR Knowledge Base`).
2. **Original Storage object preserved intentionally:** `enterprise/.../D01_Revised_Candidate_1_1.pdf` remains intact in the `documents` bucket alongside `D01_Revised_Candidate_1_1_custodian_fixed.pdf` for zero-risk rollback recoverability.
3. **Evaluation scope:** Verified `3 / 3` live `E008` runs directly; full 50-case benchmark and Gemini Decisions judge scoring were not re-run per WP9.38 constraints, and historical `V0`/`V1`/`V2` JSONs continue to reflect the prior `D01` version. Overall Enterprise RAG is **not** deployment-certified.
