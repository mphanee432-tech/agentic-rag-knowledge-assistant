# WP9.39 — Enterprise-Only Supabase API-Key Migration Report

**Date:** 2026-11-17  
**Final Outcome:** **`PASS`**  
**Enterprise Project Verified:** `cpowlkptvtnkjkulveph` (migrated via `.env.test.local` to `sb_publishable_...` and `sb_secret_...`; legacy keys retained only for temporary rollback and **not** disabled/rotated)  
**Personal Project Verified:** `smhzdovflyuqznpcxype` (`.env.local` and legacy keys preserved untouched; verified unchanged end-to-end)

---

## 1. Exact Files Changed

### Application & Evaluation Code
- `lib/supabase/config.ts` *(new shared helper)* — Implements `parseSupabaseProjectRef`, `parseSupabaseJwtClaims`, `resolvePublicSupabaseConfig` (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || NEXT_PUBLIC_SUPABASE_ANON_KEY`), and `resolveAdminSupabaseConfig` (`SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY`), validating URL/key project-ref matching and rejecting `sb_secret_`/`service_role` in public clients and `sb_publishable_`/`anon` in admin clients.
- `lib/supabase/client.ts` — Updated `createBrowserClient()` to pass `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY` into `resolvePublicSupabaseConfig`.
- `lib/supabase/server.ts` — Updated `createServerClient()` to pass `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY` into `resolvePublicSupabaseConfig`.
- `lib/supabase/admin.ts` — Updated `createAdminClient()` to pass `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` into `resolveAdminSupabaseConfig`.
- `proxy.ts` — Updated SSR/PKCE middleware client to resolve URL/key via `resolvePublicSupabaseConfig`.
- `lib/auth.ts` — Updated bearer-authenticated `requireUser(req)` client to resolve URL/key via `resolvePublicSupabaseConfig`.
- `run_enterprise_decisions_eval.py` — Updated `token_for`, `_supabase_client_config`, `supabase_request_json`, and `resolve_target_documents_fixture` to prefer `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`, validate URL/JWT project match, omit `Authorization: Bearer` for `sb_secret_...` fixture queries (`apikey` header only), and raise immediately if any `sb_publishable_*` / `sb_secret_*` key is supplied in `Authorization: Bearer`.

### Tests & Backup Exclusion
- `tests/supabase-config.test.ts` *(new unit test)* — Verifies publishable/secret key preference, legacy anon/service_role fallback, rejection of swapped key types (`sb_secret_` in public, `sb_publishable_` in admin), and cross-project URL/JWT mismatch detection.
- `tests/test_enterprise_decisions_eval.py` — Added `EnterpriseApiKeyMigrationTests` verifying `sb_publishable_` / `sb_secret_` preference, `apikey` header usage without `Authorization: Bearer`, and `Bearer` guard.
- `.gitignore` — Added `/wp9_39_backup/` to exclude pre-change local source backups.

*(Unchanged files confirmed intact: `.env.local`, `.env`, database schema, RLS policies, documents, embeddings, prompts, Jira integration, `.github/workflows/ping-supabase.yml`, `scripts/authz_check.py`.)*

---

## 2. Project IDs & Key Types Verified (Zero Values Exposed)

| Command / Config | Target Project ID | Active Key Types Used | Notes |
| :--- | :--- | :--- | :--- |
| **`pnpm dev:test`** (`.env.test.local`) | `cpowlkptvtnkjkulveph` | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable`, len `46`)<br>`SUPABASE_SECRET_KEY` (`sb_secret`, len `41`) | Preferred over retained legacy keys (`anon` / `service_role`, `ref=cpowlkptvtnkjkulveph`) |
| **`pnpm dev`** (`.env.local`) | `smhzdovflyuqznpcxype` | Legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` (`role=anon`)<br>Legacy `SUPABASE_SERVICE_ROLE_KEY` (`role=service_role`) | Unchanged (`PUBLISHABLE` and `SECRET` empty in `.env.local` and `.env`) |
| **`.env`** | `cpowlkptvtnkjkulveph` | Legacy `anon` and `service_role` JWTs | Left unchanged per scope (no `PUBLISHABLE`/`SECRET` added to avoid bleeding over `.env.local`) |

---

## 3. Enterprise Verification Results (`pnpm dev:test` -> `cpowlkptvtnkjkulveph`)

1. **Browser bundle & secret exposure check:** Inspected `GET /login` HTML and `20` served `/_next/static/chunks/*.js` bundles — `cpowlkptvtnkjkulveph.supabase.co` and the active `sb_publishable_...` key are present (`url_cpowlk=True`, `pub_key=True`), while `smhzdovflyuqznpcxype`, actual `sb_secret_...` value, and legacy `service_role` key are absent (`actual_secret_leaked=False`, `legacy_svc_leaked=False`, `personal_leaked=False`).
2. **Employee authentication (publishable key):** Password sign-in via `/auth/v1/token?grant_type=password` using `apikey: sb_publishable_...` succeeded (`HTTP 200`, `uid=efbba2a0-0987-49fc-8929-0189776ce477`).
3. **Enterprise SSR dashboard & API auth:** `GET /?tab=enterprise` with `@supabase/ssr` session cookie returned `HTTP 200` (`has_org=True`, `has_eng=True`, `Enterprise RAG Restricted` absent); `GET /api/enterprise/can-upload?projectId=c0000000-0000-4000-8000-000000000010` with employee bearer JWT returned `200 {"canUpload":false}`.
4. **Authorized retrieval, RLS, citations & reauthorization (`/api/chat` + `enterprise_chunks_still_visible` with `sb_publishable_` + user JWTs):**
   - `D01` (`E008`): `HTTP 200`, `1` citation, `vis_eng=True`, `vis_uiux=True` (`"Based on Document D01, the document custodian is the HR Manager, and the independent reviewer is the Operations Manager [Chunk 1]."`).
   - `D04` (Engineering SOP): `HTTP 200`, `1` citation, `vis_eng=True`, `vis_uiux=False` (`"For a validly classified critical bug, the confirmed triage target is 2 operational business hours [Chunk 1]."`).
   - `D07` (unauthorized UI/UX SOP): `HTTP 200`, `0` citations, exact refusal `"I don't know based on the documents I can access."`.
5. **Privileged `sb_secret_...` server checks (read-only, legacy `SUPABASE_SERVICE_ROLE_KEY` removed from test env):**
   - `createAdminClient()` in Node (`lib/supabase/admin.ts`) authenticated with `SUPABASE_SECRET_KEY` and cleanly read `D01` (`bede95a7-63ea-49ce-9bb5-85798a2da9dc`) and listed its Storage folder (`D01_Revised_Candidate_1_1.pdf`, `D01_Revised_Candidate_1_1_custodian_fixed.pdf`).
   - `run_enterprise_decisions_eval.resolve_target_documents_fixture()` resolved `D03`, `D11`, `D04`, and `D07` using `SUPABASE_SECRET_KEY` (`apikey` only, no `Authorization: Bearer`).

---

## 4. Personal RAG Verification Results (`pnpm dev` -> `smhzdovflyuqznpcxype`)

After stopping `pnpm dev:test` and starting `pnpm dev`:
1. **Effective project & bundle isolation:** `/login` and static JS bundles confirmed `smhzdovflyuqznpcxype.supabase.co` + Personal legacy `anon` key only; zero `cpowlkptvtnkjkulveph`, `sb_publishable_`, or `sb_secret_` exposure (`ent_url_leaked=False`, `ent_pub_leaked=False`, `ent_sec_leaked=False`).
2. **Authentication & SSR workspace:** Password login on `smhzdovflyuqznpcxype` succeeded (`uid=dbc16ad3-391f-42fb-8792-db998609a2a5`), and SSR `GET /?tab=personal` returned `HTTP 200` (`has_personal=True`).
3. **Projects, retrieval & chat flow:** `GET /api/projects` returned `HTTP 200` (`2` projects: `Project 2`, `First project`), `GET /api/documents` found `2` indexed documents on `First project`, user-RLS chunk query returned `1` chunk (`1,888` chars), and `POST /api/chat` returned `HTTP 200` with `8` citations and persisted `interactionId`.

---

## 5. Development Test Suite Results

All static and unit checks passed after the final code edit:
- `npm test` (`tsx --test tests/*.test.ts`): **`271 / 271` passed**, `0` failed, `0` skipped.
- `npm run typecheck` (`tsc --noEmit --incremental false`): **`0` errors**.
- `npm run lint` (`eslint app components lib scripts tests proxy.ts`): **`0` errors** (`9` pre-existing unused-variable warnings in unrelated components).
- `python -m unittest tests/test_enterprise_decisions_eval.py`: **`23 / 23` passed** (`OK`, plus dataset sanity check `50` cases valid).

---

## 6. Remaining Legacy-Key Dependencies & Rollback Status

### Remaining Consumers Not Migrated in This Scope
- **Personal RAG (`.env.local`):** Intentionally remains on `smhzdovflyuqznpcxype` legacy keys.
- **Enterprise CI / Auxiliary Scripts & Staging Workflows:**
  - `.github/workflows/ping-supabase.yml` still sends `-H "Authorization: Bearer ${SUPABASE_ANON_KEY}"`; cannot be migrated safely without inspecting which project its GitHub secret (`SUPABASE_URL`/`SUPABASE_ANON_KEY`) targets. Retained unchanged.
  - `.github/workflows/authorization.yml` & `scripts/authz_check.py` use `AUTHZ_SUPABASE_ANON_KEY` / `AUTHZ_SUPABASE_SERVICE_ROLE_KEY` (dedicated staging project, not tested locally) and pass `service` in `Bearer` when seeding fixtures. Retained unchanged.
  - Auxiliary admin/test scripts (`scripts/verify_enterprise_upload.ts`, `scripts/wp5_live_demo.ts`, `scripts/apply_enterprise_upload_schema.ts`, `scripts/reset_wp5_test_passwords.ts`) and `.env` still reference legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` directly; `.env.test.local` preserves legacy keys temporarily until all scripts and CI secrets are retired.

### Rollback Status
- Pre-edit snapshots of all `6` modified existing source files are preserved locally in `wp9_39_backup/` (excluded from Git via `.gitignore`).
- Legacy keys on `cpowlkptvtnkjkulveph` remain active and untouched in both Supabase and `.env.test.local`, enabling instant rollback by restoring `wp9_39_backup/` files and removing the two new lines from `.env.test.local`. Legacy keys must **not** be disabled until the remaining scripts and `.github/workflows/ping-supabase.yml` target check are completed separately.

