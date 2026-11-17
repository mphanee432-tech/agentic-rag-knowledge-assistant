# WP9.37 — Independent Two-User RLS Isolation Test Report

**Date:** 2026-11-16  
**Target Environment:** Enterprise Test Supabase Project `cpowlkptvtnkjkulveph` (`https://cpowlkptvtnkjkulveph.supabase.co`) & local Next.js server (`http://127.0.0.1:3000`)  
**Scope Exclusion:** Personal RAG project (`smhzdovflyuqznpcxype`) was never touched; zero Gemini/Decisions LLM calls were made; zero schema, RLS, grant, prompt, or code changes were performed.  
**Decision:** **PASS** *(for the tested `D01` / `D04` / `D07` two-employee authorization matrix; **not deployment-certified**)*

---

## 1. Test Personas & Authentication Method

All employee probes authenticated independently using real Supabase Auth user JWTs (`POST /auth/v1/token?grant_type=password`) paired with the nonprivileged publishable/anon key. The `service_role` key was never used for employee access tests; it was used only during read-only metadata discovery (`projects` and `documents` identifiers/scopes/statuses) and failed cleanly when attempting direct authority-table inspection (`document_grants`, `project_memberships` — see Section 5).

| Persona | User UUID | Department | Role | Active |
| :--- | :--- | :--- | :--- | :--- |
| `engineering` | `efbba2a0-0987-49fc-8929-0189776ce477` | `Engineering` (`c0000000-0000-4000-8000-000000000002`) | `employee` | `true` |
| `uiux` | `a23340ca-9c18-493a-b97a-78751b4925ea` | `UI/UX` (`e56ac7f0-082a-4c6f-b9c5-3cba1cce1f9a`) | `employee` | `true` |

Organization ID verified via `POST /rest/v1/rpc/enterprise_account_status`: `c0000000-0000-4000-8000-000000000001`.

---

## 2. Target Indexed Documents (Preflight Verified)

All three target documents are `status='indexed'`, `is_published=true`, and `classification='standard'`:

| Code | Document UUID | Project (`project_id`) | Department | Scope | Indexed Chunks |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `D01` | `bede95a7-63ea-49ce-9bb5-85798a2da9dc` | `HR Knowledge Base` (`a774548e-818a-43a0-851d-74badf1e1a0f`) | `HR` (`859355c7-c42c-4db8-b827-a13d0b827641`) | `company` | `12` |
| `D04` | `b14447ba-afa7-43f1-ad51-d935c6b4f303` | `Engineering Knowledge Base` (`c0000000-0000-4000-8000-000000000010`) | `Engineering` (`c0000000-0000-4000-8000-000000000002`) | `department` | `6` |
| `D07` | `ad9ecd74-0da2-4ba6-8fc5-d44dc680267c` | `UI/UX Knowledge Base` (`91c716f0-3c12-4ac0-95c6-2b04bd0d5085`) | `UI/UX` (`e56ac7f0-082a-4c6f-b9c5-3cba1cce1f9a`) | `department` | `8` |

*Note on additional company-wide Standard documents in the same organization:* `HR Knowledge Base` also hosts `D02` (`company`/`standard`), `Operations Knowledge Base` hosts `D08` (`company`/`standard`), and `Finance Knowledge Base` hosts `D10` (`company`/`standard`, alongside `D11` which is `department`/`restricted`). This explains why `enterprise_chat_projects` surfaces `HR Knowledge Base`, `Operations Knowledge Base`, and `Finance Knowledge Base` alongside each employee's own department Knowledge Base.

---

## 3. Two-User Isolation Matrix (`D01`, `D04`, `D07`)

### 3A. User-Scoped Database Paths (True Per-Employee Authorization)

These database paths distinguish **positive access for authorized users** from **denial for unauthorized users** under real employee JWTs + anon key:

| Access Path | `engineering` on `D01` | `engineering` on `D04` | `engineering` on `D07` | `uiux` on `D01` | `uiux` on `D04` | `uiux` on `D07` | `anon_only` (no JWT) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`POST /rest/v1/rpc/read_enterprise_document`** | **ALLOW** (`200`, `12` chunks, `all_ids_match=True`) | **ALLOW** (`200`, `6` chunks, `all_ids_match=True`) | **DENY** (`200`, `0` chunks) | **ALLOW** (`200`, `12` chunks, `all_ids_match=True`) | **DENY** (`200`, `0` chunks) | **ALLOW** (`200`, `8` chunks, `all_ids_match=True`) | **DENY** (`401`, SQLSTATE `42501`) |
| **`POST /rest/v1/rpc/search_enterprise_chunks`** *(Doc-ID query)* | **ALLOW** (`200`, `8` `D01` hits, `0` `D04`/`D07`) | **ALLOW** (`200`, `6` `D04` hits, `0` `D01`/`D07`) | **DENY** (`200`, `0` hits total) | **ALLOW** (`200`, `8` `D01` hits, `0` `D04`/`D07`) | **DENY** (`200`, `0` hits total) | **ALLOW** (`200`, `8` `D07` hits, `0` `D01`/`D04`) | **DENY** (`401`, SQLSTATE `42501`) |
| **`POST /rest/v1/rpc/search_enterprise_chunks`** *(Broad query, no doc ID)* | `1` `D01` hit | `2` `D04` hits | `0` `D07` hits (`8` total eligible hits) | `1` `D01` hit | `0` `D04` hits | `2` `D07` hits (`8` total eligible hits) | **DENY** (`401`, SQLSTATE `42501`) |
| **`POST /rest/v1/rpc/enterprise_chunks_still_visible`** *(Single-doc chunk IDs)* | **ALLOW** (`200`, `true`) | **ALLOW** (`200`, `true`) | **DENY** (`200`, `false`) | **ALLOW** (`200`, `true`) | **DENY** (`200`, `false`) | **ALLOW** (`200`, `true`) | Not tested separately |
| **`POST /rest/v1/rpc/enterprise_chunks_still_visible`** *(Mixed `[D04, D07]` IDs)* | N/A | **DENY** (`200`, `false`) | **DENY** (`200`, `false`) | N/A | **DENY** (`200`, `false`) | **DENY** (`200`, `false`) | N/A |
| **`POST /rest/v1/rpc/enterprise_chat_projects`** | HR KB listed | Engineering KB listed | UI/UX KB **absent** | HR KB listed | Engineering KB **absent** | UI/UX KB listed | N/A |

**Key takeaway:** Every active user-scoped Enterprise retrieval and reauthorization path (`read_enterprise_document`, `search_enterprise_chunks`, `enterprise_chunks_still_visible`, `enterprise_chat_projects`) enforces symmetric mutual isolation: `engineering` accesses `D01` and `D04` and is denied `D07`; `uiux` accesses `D01` and `D07` and is denied `D04`; mixed `[D04, D07]` chunk visibility checks fail closed (`false`) for both users.

---

### 3B. Uniform-Denial / Owner-Boundary Paths (NOT Per-Department Isolation)

The paths below reject **all** Enterprise employees equally regardless of department because Enterprise projects have `projects.user_id IS NULL`, whereas the restrictive `owner_boundary` RLS policies, Storage folder rule, and personal REST API routes enforce `user_id = auth.uid()`:

| Path | `engineering` Result | `uiux` Result | `anon_only` Result | Why It Denies Uniformly |
| :--- | :--- | :--- | :--- | :--- |
| `GET /rest/v1/documents` | `200`, `[]` (`0` rows) | `200`, `[]` (`0` rows) | `401` (`42501`) | Restrictive `owner_boundary` requires `projects.user_id = auth.uid()` (`202610280001_harden_access_and_ingestion.sql`). |
| `GET /rest/v1/document_chunks` | `200`, `[]` (`0` rows) | `200`, `[]` (`0` rows) | `401` (`42501`) | Restrictive `owner_boundary` (`202610280001` & `wp3`); `wp3_retrieval` bypass is internal to `SECURITY DEFINER` RPCs. |
| `GET /rest/v1/projects` | `200`, `[]` (`0` rows) | `200`, `[]` (`0` rows) | `401` (`42501`) | Restrictive `owner_boundary` requires `projects.user_id = auth.uid()`. |
| `GET /rest/v1/document_grants` | `403` (`42501`) | `403` (`42501`) | `401` (`42501`) | `REVOKE ALL` on authority tables in `wp2a` (`20261111050416`). |
| `GET /rest/v1/organization_employees` | `403` (`42501`) | `403` (`42501`) | `401` (`42501`) | `REVOKE ALL` on authority tables in `wp2a` (`20261111050416`). |
| `GET /storage/v1/object/authenticated/documents/<path>` (`D01`, `D04`, `D07`) | `400` (`404`/`NoSuchKey`) for all 3 | `400` (`404`/`NoSuchKey`) for all 3 | `400` (`InvalidRequest`, missing `authorization`) | `document_storage_owner` policy requires `(storage.foldername(name))[1] = auth.uid()::text`. |
| `GET /api/projects` (`http://127.0.0.1:3000`) | `200`, `projects=[]` (`0`) | `200`, `projects=[]` (`0`) | N/A | Filters `eq('user_id', user.id)` in `app/api/projects/route.ts`. |
| `GET /api/documents?projectId=<D01\|D04\|D07>` (`http://127.0.0.1:3000`) | `404` (`Project not found.`) for all 3 | `404` (`Project not found.`) for all 3 | N/A | `requireProject()` verifies personal `user_id = user.id` ownership (`app/api/documents/route.ts`). |

*Route inspection note:* Listing `app/api/` confirmed there is no standalone citation-preview or source-download HTTP endpoint; Enterprise citations are reauthorized in-band via `enterprise_chunks_still_visible` before `/api/chat` returns a response.

---

## 4. Schema, RLS, `SECURITY DEFINER`, and View Audit

Inspection of `supabase/migrations/*.sql` and live RPC privilege probes confirmed:

1. **Non-Bypassable Retrieval Role & Row Security:**  
   - `wp3_retrieval` is `nologin noinherit nobypassrls` (`20261112034417_wp3_secure_rag_retrieval.sql`).
   - `wp3_private.search_chunks` (`wp6` & `wp9_16`) and `wp3_private.enterprise_chunks_still_visible` (`wp6`) are owned by `wp3_retrieval` with `set row_security = on` and `set search_path = pg_catalog, public, extensions, wp3_private, pg_temp`.
   - `document_chunks` enforces `rag_retrieval_boundary` (`AS RESTRICTIVE ... TO wp3_retrieval USING (wp3_private.can_read_document(document_id))`), so internal vector search evaluates per-user document authorization (`(select auth.uid())`, active org employee, `status = 'indexed'`, `is_published`, scope/department/grant/membership check) on every row.
2. **Private Helper Schemas & Ingestion Lockdown:**  
   - Authorization internals (`wp2b_private`, `wp3_private`, `wp4_private`) are kept outside `public`. Probing `/rest/v1/rpc/issue_document_grant` and `/rest/v1/rpc/revoke_document_grant` returned `HTTP 404` (`PGRST202`, not exposed on `public`).
   - Ingestion RPC `public.claim_document_ingestion` returned `HTTP 401` (`42501`) for `anon` and `HTTP 403` (`42501 permission denied for function claim_document_ingestion`) for both `engineering` and `uiux` employees (`202610280001_harden_access_and_ingestion.sql` revokes `execute` from `public, anon, authenticated` and grants only to `service_role`; likewise for `finish_document_ingestion` and `match_chunks_hybrid_rrf`).
3. **Employee-Callable Context RPCs:**  
   - `public.enterprise_copilot_context`: `401` (`42501`) for `anon`; `200` (`1` row) for each employee, returning only that user's `enterprise_account_status()` department/role context (`(select auth.uid())`).
   - `public.enterprise_policy_departments`: `401` (`42501`) for `anon`; `200` (`list_len=0`) for both `employee` accounts because `wp6` restricts rows to `department_lead` or `org_admin`.

---

## 5. Limitations, Anomalies & Unverified Paths

1. **Direct `document_grants` / `project_memberships` Table Read Blocked:** Reading `/rest/v1/document_grants` and `/rest/v1/project_memberships` with `service_role` returned `HTTP 403` (`42501 permission denied`), matching `revoke all on ... from public, anon, authenticated, service_role` in `20261111050416_wp2a_enterprise_foundation.sql`. Active cross-department non-access for `engineering` and `uiux` on `D04`/`D07` was therefore established functionally via `read_enterprise_document`, `search_enterprise_chunks`, `enterprise_chunks_still_visible`, and `enterprise_chat_projects` rather than raw table `SELECT`.
2. **`enterprise_fallback_documents` Missing from Schema Cache:** Calling `POST /rest/v1/rpc/enterprise_fallback_documents` returned `HTTP 404` (`PGRST202`) for `anon`, `engineering`, and `uiux` on `cpowlkptvtnkjkulveph` (meaning the `wp85` migration is either not exposed under that signature or not applied on the remote test project).
3. **Out-of-Scope Authorizations Not Exercised:** Because this test used the two `employee` personas (`engineering`, `uiux`) against `Standard` documents (`D01`, `D04`, `D07`), it did **not** test:
   - `restricted` (`D03`, `D11`) or `confidential` classification isolation,
   - temporary grant issuance/expiry windows (`enterprise_access_window_is_current`),
   - multi-organization isolation across separate `organization_id`s, or
   - live end-to-end `/api/chat` execution (intentionally omitted to avoid Gemini calls).

---

## 6. Conclusion

- **WP9.37 Result:** **PASS** — Two independent authenticated employees (`engineering` and `uiux`, using real user JWTs + anon key) both read company-wide `D01`, each reads their own department policy (`D04` vs `D07`), and cross-department access (`engineering -> D07`, `uiux -> D04`) is mutually denied across `read_enterprise_document`, `search_enterprise_chunks`, `enterprise_chunks_still_visible`, and `enterprise_chat_projects`, with zero cross-department chunks, titles, or metadata leaked.
- **Certification Boundary:** This test verifies two-user Enterprise RLS isolation on `cpowlkptvtnkjkulveph` for `D01`, `D04`, and `D07`. It is **not** a full deployment certification.
