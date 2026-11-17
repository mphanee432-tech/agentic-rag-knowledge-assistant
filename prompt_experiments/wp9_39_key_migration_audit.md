# WP9.39 — Supabase API-Key Migration Audit (Step 1 — Read-Only)

**Date:** 2026-11-17  
**Mode:** Strictly read-only audit. Zero source files, environment variables, database settings, Auth configs, RLS policies, or Supabase keys were modified, and zero paid LLM calls were executed.  
**Target Enterprise Project:** `cpowlkptvtnkjkulveph` *(verified active; has an active `default` publishable key)*  
**Preserved Personal Project:** `smhzdovflyuqznpcxype` *(do not migrate)*

---

## 1. Current Environment-Variable Mapping

Only variable names, key types, and project IDs are listed (zero key values, tokens, passwords, or connection strings):

| File | Exists | Supabase & Test Vars Found | Associated Project ID | Key Type / Status |
| :--- | :--- | :--- | :--- | :--- |
| `.env` | Yes | `NEXT_PUBLIC_SUPABASE_URL`<br>`NEXT_PUBLIC_SUPABASE_ANON_KEY`<br>`SUPABASE_SERVICE_ROLE_KEY`<br>`SUPABASE_WEBHOOK_SECRET`, `EVAL_GEMINI_API_KEY` | `cpowlkptvtnkjkulveph` | Legacy `anon` JWT<br>Legacy `service_role` JWT |
| `.env.local` | Yes | `NEXT_PUBLIC_SUPABASE_URL`<br>`NEXT_PUBLIC_SUPABASE_ANON_KEY`<br>`SUPABASE_SERVICE_ROLE_KEY`<br>`SUPABASE_WEBHOOK_SECRET`, `EVAL_GEMINI_API_KEY`, `EVAL_TEST_*` | `smhzdovflyuqznpcxype` | Legacy `anon` JWT<br>Legacy `service_role` JWT |
| `.env.test.local` | Yes | `NEXT_PUBLIC_SUPABASE_URL`<br>`NEXT_PUBLIC_SUPABASE_ANON_KEY`<br>`SUPABASE_SERVICE_ROLE_KEY`<br>`SUPABASE_WEBHOOK_SECRET`, `PGPASSWORD`, `EVAL_*` | `cpowlkptvtnkjkulveph` | Legacy `anon` JWT<br>Legacy `service_role` JWT |
| `.env.example` | No | — | — | — |
| `.env.production.local` | No | — | — | — |
| `.github/workflows/ping-supabase.yml` | Yes | `SUPABASE_URL`, `SUPABASE_ANON_KEY` | External GitHub secret | Legacy pattern (`apikey` + `Bearer`) |
| `.github/workflows/authorization.yml` | Yes | `AUTHZ_APP_URL`, `AUTHZ_SUPABASE_URL`, `AUTHZ_SUPABASE_ANON_KEY`, `AUTHZ_SUPABASE_SERVICE_ROLE_KEY` | External staging secret | Used by `scripts/authz_check.py` |
| `.github/workflows/evaluation.yml` | Yes | `EVAL_API_URL`, `EVAL_PROJECT_ID`, `EVAL_OTHER_PROJECT_ID`, `EVAL_ACCESS_TOKEN`, `EVAL_OTHER_ACCESS_TOKEN`, `EVAL_GEMINI_API_KEY` | Staging eval | User access tokens (`Bearer`) |

**Active SDK versions (`package.json`):** `@supabase/supabase-js` `^2.118.0`, `@supabase/ssr` `^0.12.7` (both support `sb_publishable_*` and `sb_secret_*` keys).

---

## 2. Enterprise vs. Personal Supabase Client Usage & Dual-Project Routing

### Does dual-project routing work at runtime?
**No.** There is no runtime dual-project client router or separate `PERSONAL_SUPABASE_*` vs. `ENTERPRISE_SUPABASE_*` env split. Both tabs (`Personal RAG` at `/?tab=personal` and `Enterprise RAG` at `/?tab=enterprise` via `app/enterprise/page.tsx`) run inside `app/page.tsx` and share **one** set of environment variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) and **one** Auth session per running server instance:

- **`pnpm run dev` (`next dev`):** Next.js loads `.env.local` over `.env` -> connects **both** tabs to **Personal RAG (`smhzdovflyuqznpcxype`)**. `getEnterpriseCopilotContext` / `getEnterpriseAccountStatus` (`lib/auth.ts`) ignore `PGRST202`/`42883` when Enterprise RPCs are absent, so the Enterprise tab displays *"Enterprise RAG Restricted"*.
- **`pnpm run dev:test` (`scripts/dev-test.js` -> `APP_ENV=test`):** `next.config.ts` (`lines 6–11`) loads `.env.test.local` with `override: true` -> connects **both** tabs to **Enterprise test (`cpowlkptvtnkjkulveph`)**.

### Client Initialization Inventory

| Layer | File(s) & Function | Current Key Env Var(s) | Used For |
| :--- | :--- | :--- | :--- |
| **Browser client** | `lib/supabase/client.ts` (`createBrowserClient` / `createClient`) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Sign-in/sign-up/reset (`app/login/page.tsx`, `app/reset-password/page.tsx`), auth state/sign-out (`components/sign-out.tsx`), Personal Realtime (`components/upload/document-uploader.tsx`), Enterprise signed upload (`components/upload/enterprise-policy-dialog.tsx`). |
| **SSR / Route client** | `lib/supabase/server.ts` (`createServerClient` / `createClient`) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | SSR dashboard/auth context (`app/page.tsx`), sign-out action (`app/actions/auth.ts`), API cookie sessions (`lib/auth.ts` `requireUser`). |
| **Proxy / Middleware** | `proxy.ts` (`proxy`, calls `@supabase/ssr` `createServerClient` directly) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | PKCE exchange, OTP verify, and cookie session refresh on `/`, `/enterprise`, `/project/:path*`, `/login`, `/reset-password`. |
| **Bearer API client** | `lib/auth.ts` (`requireUser`, lines `7–18`) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` + caller's `Authorization: Bearer <user_jwt>` | API bearer auth for both Enterprise & Personal endpoints (`/api/chat`, `/api/enterprise/*`, `/api/jira/*`, `/api/documents/*`, `/api/projects`, `/api/feedback`). |
| **Admin client** | `lib/supabase/admin.ts` (`createAdminClient`) | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | See Section 5 below (upload reservation/signed URLs, ingestion worker RPCs, Storage delete cleanup, Personal interaction writes). |
| **Retrieval paths** | `lib/retrieve-chunks.ts` (`retrieveVerifiedChunks`), `app/api/chat/route.ts` | Uses `auth.supabase` (user session client, **not** `createAdminClient()`) | **Enterprise:** `search_enterprise_chunks`, `enterprise_chunks_still_visible`, `getEnterpriseFallbackQuestions`.<br>**Personal:** `search_rag_chunks` + `document_chunks` RLS select (then `createAdminClient()` inserts `interactions` only when `!enterprise`). |

---

## 3. Manual `Authorization: Bearer` Headers vs. User JWTs

Audited every HTTP/header site across `app/`, `lib/`, `components/`, `scripts/`, `.github/workflows/`, and root Python runners:

### Sites Sending Legacy Keys in `Authorization: Bearer` *(BREAKS with `sb_publishable_*` / `sb_secret_*`)*
1. **`run_enterprise_decisions_eval.py` (lines `289–293`, `422–434`, `464`):**  
   `resolve_target_documents_fixture()` calls `supabase_request_json('GET', ..., service_key, service_key)`, which sets **both** `apikey: <service_key>` and `Authorization: Bearer <service_key>`. Because `sb_secret_...` is an opaque key rather than a 3-part JWT, PostgREST rejects `Authorization: Bearer sb_secret_...`. *(User session calls in the same file on lines `283`, `491–496`, and `1341` already use `apikey` alone for `/auth/v1/token` and real user JWTs for `Authorization: Bearer`.)*
2. **`.github/workflows/ping-supabase.yml` (lines `19–21`):**  
   Sends `-H "apikey: ${SUPABASE_ANON_KEY}" -H "Authorization: Bearer ${SUPABASE_ANON_KEY}"`. Passing a `sb_publishable_...` key in `Authorization: Bearer` will fail.
3. **`scripts/authz_check.py` (lines `49–52`, used with separate `AUTHZ_*` staging secrets):**  
   `self.request(..., self.service)` sets `Authorization: Bearer {self.service}` when creating/inspecting/cleaning staging fixtures (only affects staging `AUTHZ_*` if those keys are migrated from legacy JWTs).

### Safe `Authorization: Bearer` Sites (No Key-Type Conflict)
- **User JWTs only:** `lib/auth.ts:8-11`, `scripts/eval_runner.py:146,213` (already falls back `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || NEXT_PUBLIC_SUPABASE_ANON_KEY`), `scripts/security_checks.py:19`, `scripts/wp5_live_demo.ts:59`, `scripts/verify_enterprise_upload.ts:44,115,123`, `promptfooconfig.yaml:16`.
- **Non-Supabase tokens:** `app/api/webhooks/storage/route.ts:15` (`SUPABASE_WEBHOOK_SECRET`), `scripts/sync_ingestion.py:26` (`SUPABASE_ACCESS_TOKEN`).

---

## 4. Scripts, Evaluations & Cron Jobs Referencing Legacy Key Names

- **App / test runners targeting `cpowlkptvtnkjkulveph` (via `.env.test.local` or `.env`):**
  - `run_enterprise_decisions_eval.py` (lines `280, 313` already check `NEXT_PUBLIC_SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; line `414` reads `SUPABASE_SERVICE_ROLE_KEY` only).
  - `scripts/verify_enterprise_upload.ts`, `scripts/wp5_live_demo.ts`, `scripts/apply_enterprise_upload_schema.ts`, `scripts/reset_wp5_test_passwords.ts`.
  - `tests/*.test.ts` and `tests/test_enterprise_decisions_eval.py` (mock/assert `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`).
- **Scripts targeting `.env.local` (Personal RAG `smhzdovflyuqznpcxype` — keep untouched):**
  - `scripts/eval_runner.py` (already supports `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`), `scripts/generate-eval-set.ts`, `scripts/sync-telemetry-to-eval.ts`.
- **Database `pg_cron` jobs (`supabase/migrations/202611040001`, `20261112073100`):**
  - `recover-document-ingestion` uses Vault secrets `ingestion_webhook_url` / `ingestion_webhook_secret`; `wp4-security-audit-retention` runs local SQL. Neither uses Supabase anon/service_role API keys.

---

## 5. Locations Requiring Key-Support Changes & Secret-Key Necessity

### Is a new Enterprise secret key required?
- **For user-facing Enterprise retrieval, Auth, chat, Jira gating, and onboarding:** **No.** A publishable key (`sb_publishable_...`) + authenticated user JWT is sufficient; zero `createAdminClient()` calls occur on `/?tab=enterprise` page load, `POST /api/chat` (`enterprise = true`), `/api/enterprise/onboard`, `/api/enterprise/departments`, `/api/enterprise/can-upload`, or `/api/jira/*`.
- **For Enterprise policy upload/ingestion & eval preflight:** **Yes.** A privileged key (`sb_secret_...`) is still required by:
  - `app/api/documents/upload-url/route.ts` (`createAdminClient().storage...createSignedUploadUrl`, failure `update`)
  - `app/api/enterprise/ingest/route.ts` & `app/api/webhooks/storage/route.ts` (`claim_document_ingestion`, `finish_document_ingestion`, `fail_document_ingestion`, Storage download — all revoked from `authenticated`)
  - `run_enterprise_decisions_eval.py` (`resolve_target_documents_fixture` reads `projects` / `documents` / `document_chunks` where `owner_boundary` hides Enterprise rows from employees)
  - Enterprise admin helper scripts (`scripts/apply_enterprise_upload_schema.ts`, `scripts/reset_wp5_test_passwords.ts`, `scripts/verify_enterprise_upload.ts`).

### Code Locations Requiring Publishable-Key / Secret-Key Resolution
To accept new key names without breaking `.env.local` (Personal RAG) or existing unit-test fixtures:

1. **Publishable-key resolution (`process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY`):**
   - `lib/supabase/client.ts`
   - `lib/supabase/server.ts`
   - `proxy.ts`
   - `lib/auth.ts` (`requireUser`)
   - *(Optional consistency: `scripts/verify_enterprise_upload.ts`, `scripts/wp5_live_demo.ts`, and error messages in `run_enterprise_decisions_eval.py` lines `282, 316`.)*
2. **Secret-key resolution (`process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY`):**
   - `lib/supabase/admin.ts` (`createAdminClient`)
   - `run_enterprise_decisions_eval.py` (line `414` + update `supabase_request_json` so privileged `sb_secret_...` calls send `apikey` **without** `Authorization: Bearer sb_secret_...`)
   - `.github/workflows/ping-supabase.yml` (omit `Authorization: Bearer` when pinging with publishable/anon `apikey`, or remove legacy `Bearer ${SUPABASE_ANON_KEY}` dependency)
   - *(Note: `scripts/authz_check.py` only needs updating if its separate staging `AUTHZ_SUPABASE_*` secrets are rotated to new keys.)*

---

## 6. Authentication & RLS Risks

1. **Breaking `run_enterprise_decisions_eval.py` or `ping-supabase.yml` with non-JWT Bearer headers:** Sending `sb_secret_` or `sb_publishable_` in `Authorization: Bearer` fails with HTTP 401/400. Must be fixed before removing legacy JWT keys.
2. **Cross-environment bleed between `.env` and `.env.local`:** Both `.env` and `.env.test.local` point at `cpowlkptvtnkjkulveph`, whereas `.env.local` points at `smhzdovflyuqznpcxype`. Setting `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_SECRET_KEY` in `.env` while `.env.local` only defines `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` **would cause fallback bugs** (`PUBLISHABLE_KEY` from `.env` + `URL` from `.env.local` = mismatched key/project in `pnpm run dev`!).  
   **Critical Safeguard:** Keep **neither** `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` nor `SUPABASE_SECRET_KEY` in shared `.env` unless `.env.local` also takes precedence cleanly, OR keep Enterprise key changes strictly in **`.env.test.local`** (and remove stale keys or match the active env) while keeping `.env.local` untouched! Even simpler: in `lib/supabase/*`, `proxy.ts`, `lib/auth.ts`, resolve publishable vs. anon only within the selected project config, and do **not** put `cpowlkptvtnkjkulveph`'s `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` into `.env` while `.env.local` uses `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` for `smhzdovflyuqznpcxype`!
3. **Auth session & RLS behavior:** Because both `cpowlkptvtnkjkulveph` Auth (`getUser()`, `signInWithPassword`, cookie `sb-cpowlkptvtnkjkulveph-auth-token`) and `wp3_retrieval` RLS RPCs depend on the **user access JWT** (`auth.uid()`)—not the anon key—publishable keys preserve full RLS isolation (`D01`/`D04`/`D07`) once `apikey` uses `sb_publishable_...` and `Authorization: Bearer` carries the user JWT.
4. **External hosted configs:** Vault secrets in PostgreSQL don't store API keys, and any hosted Vercel / GitHub Secrets holding `cpowlkptvtnkjkulveph` keys would need matching rotation separately from local `.env.test.local`.

---

## 7. Minimal Implementation Plan (Awaiting Approval Before Step 2)

1. **Preserve `.env.local` untouched** (`smhzdovflyuqznpcxype` Personal RAG remains 100% legacy-key isolated; do **not** set `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_SECRET_KEY` in `.env` so `pnpm run dev` never mixes `.env` keys with `.env.local` URL).
2. **Code updates (4 Next.js runtime files + `lib/supabase/admin.ts` + `run_enterprise_decisions_eval.py`):**
   - Update `lib/supabase/client.ts`, `lib/supabase/server.ts`, `proxy.ts`, and `lib/auth.ts` to prefer `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` with fallback to `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
   - Update `lib/supabase/admin.ts` to prefer `SUPABASE_SECRET_KEY` with fallback to `SUPABASE_SERVICE_ROLE_KEY`.
   - Update `run_enterprise_decisions_eval.py` to support `SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY` and stop sending `sb_secret_...` in `Authorization: Bearer` (use `apikey` header for secret-key PostgREST requests, and user JWT `Bearer` for all user requests). Fix `.github/workflows/ping-supabase.yml` similarly (`apikey` header only) if desired.
   - Add targeted unit tests confirming both publishable/secret and legacy anon/service_role paths resolve cleanly and `run_enterprise_decisions_eval.py` never puts `sb_secret_` in `Bearer`.
3. **Switch `.env.test.local` (`cpowlkptvtnkjkulveph`):** Set `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` (and clear/retire legacy keys from `.env.test.local`, and clean/align `.env` without introducing `PUBLISHABLE_KEY` mismatch for `.env.local`) while legacy keys are still enabled on Supabase during verification; only disable legacy keys on `cpowlkptvtnkjkulveph` after all verification gates pass.

---

## 8. Post-Migration Verification Plan (Both RAG Tabs, Zero Paid LLM Eval Needed)

1. **Unit & static checks:** Run `pnpm run typecheck`, `pnpm test`, and `python -m unittest discover -s scripts -p "test_*.py"`.
2. **Enterprise RAG tab (`pnpm run dev:test` -> `cpowlkptvtnkjkulveph`):**
   - Sign in as `engineering` and `uiux` employees on `/login` (`createBrowserClient` using `sb_publishable_...`), verify `/?tab=enterprise` loads (`createServerClient` + `proxy.ts` refresh), verify two-user RLS checks (`read_enterprise_document`, `search_enterprise_chunks`, `enterprise_chunks_still_visible` with `sb_publishable_...` + user JWTs) and `resolve_target_documents_fixture` with `sb_secret_...` (no `Bearer`), plus signed upload reservation test if authorized.
3. **Personal RAG tab (`pnpm run dev` -> `smhzdovflyuqznpcxype`):**
   - Start `next dev` (without `APP_ENV=test`), confirm `.env.local` connects to `smhzdovflyuqznpcxype` with zero key cross-talk, verify `/login` and `/?tab=personal` project listing (`GET /api/projects`) succeed using existing legacy `.env.local` keys.

