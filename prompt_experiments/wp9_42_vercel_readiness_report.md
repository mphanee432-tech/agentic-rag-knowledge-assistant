# WP9.42 — Vercel Deployment Readiness Audit Report

**Date:** 2026-11-17  
**Scope:** Read-only deployment readiness audit for single-URL Vercel hosting serving both **Personal RAG** (`smhzdovflyuqznpcxype`) and **Enterprise RAG** (`cpowlkptvtnkjkulveph`)  
**Audited Baseline:** Next.js `16.4.6` (`pnpm@12.6.0`), WP9.39 (Enterprise modern keys), WP9.40 (Next.js security patch), WP9.41 (dual-project routing verified simultaneously on local server)

---

## 1. Executive Summary

- **Verdict:** **`READY AFTER SPECIFIC FIXES`**
- The application codebase, TypeScript compilation, unit tests (`274/274`), ESLint (`0` errors), and Turbopack production build (`next build` on `16.4.6`) already pass cleanly with explicit two-project Supabase client, cookie, proxy, and API routing.
- Nothing in application source code requires architectural rework for Vercel. However, deploying immediately from the current repository state is **not ready** until four deployment-blocking prerequisites are completed:
  1. **Prepare and push a clean Git deployment commit:** Remote `origin/main` (`de3fde3`, 2026-11-15) does not contain WP9.12–WP9.41 changes. Local untracked backup/eval artifacts (`*.backup.*.json`, `*.bak`) must be excluded when staging.
  2. **Populate Vercel environment variables explicitly for both projects** (do **not** install Vercel's single-project Supabase integration, which expects generic `NEXT_PUBLIC_SUPABASE_*` variables and risks colliding with dual-project routing).
  3. **Verify/update Supabase Auth URL Configuration** on both `smhzdovflyuqznpcxype` and `cpowlkptvtnkjkulveph` once the Vercel HTTPS origin is assigned (local CLI lacks org access to read live hosted `site_url` / `uri_allow_list` settings, and Personal signup uses `mailer_autoconfirm: false` without passing `emailRedirectTo`).
  4. **Verify/update Personal Storage webhook Vault bindings** (`ingestion_webhook_url` and `ingestion_webhook_secret` in Personal DB Vault) for the Vercel domain if live Personal document uploads/re-ingestion are demonstrated; confirm **Vercel Fluid Compute** / function timeout budget covers `maxDuration = 300` on ingestion routes.

---

## 2. Git and Repository Readiness

### Current Repository State (Read-Only Inspection)
- **Current branch:** `main` tracking `origin/main` (`https://github.com/mphanee432-tech/rag-knowledge-assistant.git`)
- **Latest commit (local & remote aligned):** `de3fde3` (`Updated project code 15-11-2026`)
- **Uncommitted WP9.12–WP9.41 state:** All WP9.39–WP9.41 work (and WP9.12+ features) sits uncommitted in the working tree (`44` modified tracked files, `35` untracked top-level entries in `git status --short`).
- **Vercel config (`vercel.json`):** Not present (Next.js defaults apply; `"packageManager": "pnpm@12.6.0"` in `package.json`).
- **Package manifest & lockfile consistency:** `package.json` (`34` dependencies + devDependencies) matches `pnpm-lock.yaml` (`lockfileVersion: '9.0'`, second YAML document `importers['.']`, `34` locked specifiers, `0` mismatches, `0` extras).

### Required Source Files vs. Accidental Ignore / Commit Risks
- **Ignored safety check (`.gitignore`):**
  - Correctly ignores `.env`, `.env*`, `.env.local`, `.env.test.local`, `.env.production.local`, `*.env`, `.next/`, `/node_modules`, `.venv/`, `.vercel`, `/wp9_38_d01_backup/`, `/wp9_39_backup/`, `/wp9_40_backup/`, `/wp9_41_backup/`.
  - Required source files (`lib/supabase/config.ts`, `lib/account-summary.ts`, `app/enterprise/page.tsx`, `components/workspace-tabs.tsx`, `components/account-summary.tsx`, `components/enterprise-onboard-card.tsx`, `components/jira/jira-ticket-draft.tsx`, `tests/*.test.ts`) are **not** ignored by `.gitignore`.
- **Untracked files that MUST NOT be committed to Git:**
  - `enterprise_eval_release_report.backup.20261116T061119Z.json`
  - `enterprise_eval_release_report_uiux.backup.*.json` (`3` files)
  - `enterprise_eval_results.backup.20261116T061119Z.json`
  - `enterprise_eval_results_uiux.backup.*.json` (`3` files)
  - `run_enterprise_decisions_eval.py.before_auto_report.bak`
  - *(Large eval result JSONs and `prompt_experiments/*` artifacts may also be omitted from a minimal deployment commit if desired, though they are non-secret and do not affect the Next.js build.)*

### Safe Git Preparation Checklist (For Future Approved Commit)
1. Confirm `git status --short` shows zero `.env*` or `wp9_*_backup/` entries tracked or staged.
2. Delete or exclude `*.backup.*.json` and `*.bak` local scratch backups rather than staging them (`git add -A` must **not** be run blindly).
3. Stage explicitly required application source directories and build manifests:
   - `.gitignore`, `package.json`, `pnpm-lock.yaml`, `proxy.ts`
   - `app/`, `components/`, `lib/`, `tests/`
   - Optionally `supabase/migrations/`, `scripts/`, `prompt_experiments/` (excluding any secrets)
4. Verify staged diff contains zero API keys, JWTs, passwords, or `.env*` files before committing and pushing to `origin/main`.

---

## 3. Vercel Environment-Variable Checklist (No Secret Values)

Inspected every `process.env` reference across `app/`, `components/`, `lib/`, `proxy.ts`, and `next.config.ts`. Both Supabase projects resolve cleanly from environment variables inside a single Vercel environment without relying on `.env*` files. All `NEXT_PUBLIC_*` references use static property reads in `readPublicEnvForBrowser()` ([lib/supabase/config.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/lib/supabase/config.ts#L61-L73)) and are compatible with Next.js/Turbopack browser bundle inlining.

> **Important:** Do **not** install Vercel's single-project Supabase Marketplace integration. Leave generic `NEXT_PUBLIC_SUPABASE_*` / `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` unset on Vercel (or unused) and set the explicit workspace-scoped variables below.

| Variable Name | Workspace | Exposure | Requirement | Build / Runtime | Local Source Available |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `NEXT_PUBLIC_PERSONAL_SUPABASE_URL` | Personal (`smhzdovflyuqznpcxype`) | Public (Browser + Server) | Required | Both (Build for client inline + Runtime) | Yes (`.env.local`) |
| `NEXT_PUBLIC_PERSONAL_SUPABASE_ANON_KEY` *(or `NEXT_PUBLIC_PERSONAL_SUPABASE_PUBLISHABLE_KEY`)* | Personal (`smhzdovflyuqznpcxype`) | Public (Browser + Server) | Required | Both | Yes (`.env.local`, anon key) |
| `PERSONAL_SUPABASE_SERVICE_ROLE_KEY` *(or `PERSONAL_SUPABASE_SECRET_KEY`)* | Personal (`smhzdovflyuqznpcxype`) | Server-Only | Required | Runtime | Yes (`.env.local`, service_role) |
| `NEXT_PUBLIC_ENTERPRISE_SUPABASE_URL` | Enterprise (`cpowlkptvtnkjkulveph`) | Public (Browser + Server) | Required | Both | Yes (`.env.local` / `.env.test.local`) |
| `NEXT_PUBLIC_ENTERPRISE_SUPABASE_PUBLISHABLE_KEY` *(or `_ANON_KEY`)* | Enterprise (`cpowlkptvtnkjkulveph`) | Public (Browser + Server) | Required | Both | Yes (`.env.local` / `.env.test.local`) |
| `ENTERPRISE_SUPABASE_SECRET_KEY` *(or `_SERVICE_ROLE_KEY`)* | Enterprise (`cpowlkptvtnkjkulveph`) | Server-Only | Required | Runtime | Yes (`.env.local` / `.env.test.local`) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Shared | Server-Only | Required | Runtime | Yes (`.env` / `.env.local`) |
| `SUPABASE_WEBHOOK_SECRET` | Shared (`POST /api/webhooks/storage`) | Server-Only | Required for Personal doc upload ingestion | Runtime | Yes (`.env` / `.env.local`) |
| `ACTIVEPIECES_JIRA_WEBHOOK_URL` | Enterprise (Jira demo) | Server-Only | Optional (if demonstrating Jira create) | Runtime | Yes (`.env.local`) |
| `ACTIVEPIECES_JIRA_STATUS_WEBHOOK_URL` | Enterprise (Jira demo) | Server-Only | Optional (if demonstrating Jira status) | Runtime | Yes (`.env.local`) |
| `ACTIVEPIECES_JIRA_OPTIONS_WEBHOOK_URL` | Enterprise (Jira demo) | Server-Only | Optional (if demonstrating Jira options) | Runtime | Yes (`.env.local`) |
| `CHAT_MODEL` | Shared | Server-Only | Optional (defaults to `gemini-3.5-flash-lite`) | Runtime | Default in code |
| `EXTRACTION_MODEL` | Shared | Server-Only | Optional (recommended `gemini-3.5-flash-lite`; see Section 5) | Runtime | Default in code |

**Vercel-specific note on Application URL:** No `NEXT_PUBLIC_APP_URL` / `SITE_URL` env var is required by code — [app/login/page.tsx](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/login/page.tsx#L82) uses `window.location.origin` dynamically for password recovery redirects, and `proxy.ts` preserves `request.nextUrl` origin on redirects.

---

## 4. Authentication, Session & Supabase URL Configuration Audit

### Verified Auth & Cookie Behavior (Code & Live Public GoTrue Checks)
1. **Separate client & cookie namespaces:**
   - `createBrowserClient(scope)` ([lib/supabase/client.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/lib/supabase/client.ts#L10-L28)) disables `@supabase/ssr` singleton sharing (`isSingleton: false`), caches clients per `(scope, url, key)`, and pins distinct cookie names:
     - Personal: `sb-smhzdovflyuqznpcxype-auth-token`
     - Enterprise: `sb-cpowlkptvtnkjkulveph-auth-token`
   - Both sessions coexist cleanly under one HTTPS origin (`SameSite=Lax`, `Path=/`).
   - `signOut(workspace)` ([app/actions/auth.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/actions/auth.ts#L5-L10), [components/sign-out.tsx](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/components/sign-out.tsx#L21-L72)) signs out only the targeted workspace (`{ scope: "local" }`) and scopes `BroadcastChannel("copilot-sign-out")` notifications by `{ workspace }`.
2. **Next.js Proxy (`proxy.ts`) refresh & callbacks:**
   - Refreshes Personal and Enterprise cookies sequentially only when that workspace's cookie is present, replaying `cookiesToSet` so neither workspace drops the other's `Set-Cookie` header.
   - Routes PKCE `code` / `token_hash` auth callbacks by `?workspace=` query parameter, matching `-code-verifier` cookie prefix, `?tab=enterprise`, or `/enterprise`, defaulting safely to `"personal"`.
3. **Observed GoTrue project settings (`/auth/v1/settings`, read-only):**
   - **Personal (`smhzdovflyuqznpcxype`):** Email auth enabled, `disable_signup: false`, **`mailer_autoconfirm: false`** (new signups require email confirmation). Notice `app/login/page.tsx` does **not** pass `emailRedirectTo` to `signUp()`, so confirmation emails redirect to Supabase's **Site URL**.
   - **Enterprise (`cpowlkptvtnkjkulveph`):** Email auth enabled, `disable_signup: false`, **`mailer_autoconfirm: true`** (public demo signup gets an immediate session), password recovery passes `redirectTo = ${window.location.origin}/reset-password?workspace=enterprise`.

### Required Supabase Dashboard Settings (Both Projects — Cannot Read Live Values Locally)
Local Supabase CLI (`npx supabase projects list`) is authenticated to an unrelated org (`aiosgumdbgoxfssgxssj`), so current `site_url` and `uri_allow_list` on `smhzdovflyuqznpcxype` and `cpowlkptvtnkjkulveph` could not be inspected locally. **Immediately after Vercel assigns the production URL** (e.g., `https://<your-app>.vercel.app`), update **Authentication -> URL Configuration** in **both** Supabase projects:

- **Personal (`smhzdovflyuqznpcxype`):**
  - **Site URL:** `https://<your-app>.vercel.app`
  - **Redirect URLs (keep localhost only if still needed locally):**
    - `https://<your-app>.vercel.app/**`
    - `https://<your-app>.vercel.app/reset-password`
    - `https://<your-app>.vercel.app/reset-password?workspace=personal`
    - `http://localhost:3000/**` *(retain for local dev)*
- **Enterprise (`cpowlkptvtnkjkulveph`):**
  - **Site URL:** `https://<your-app>.vercel.app`
  - **Redirect URLs:**
    - `https://<your-app>.vercel.app/**`
    - `https://<your-app>.vercel.app/reset-password`
    - `https://<your-app>.vercel.app/reset-password?workspace=enterprise`
    - `http://localhost:3000/**` *(retain for local dev)*

*(If Vercel Preview deployments also need auth redirects, add `https://<your-vercel-project>-*.vercel.app/**` explicitly after deployment.)*

---

## 5. Serverless Runtime Compatibility Assessment

Reviewed every demo path (`app/api/chat`, `app/api/documents*`, `app/api/enterprise/*`, `app/api/webhooks/storage`, `app/api/jira/*`, `app/api/projects`, `app/api/feedback`, `proxy.ts`, SSR pages):

- **Filesystem & persistent worker assumptions:**
  - **Pass:** App runtime routes perform zero filesystem reads/writes (`next.config.ts` reads `.env.test.local` only when `APP_ENV === "test"`, which is unset on Vercel). Document processing reads blobs in memory via Supabase Storage + `pdf-lib`. No local queues/daemons required in Next.js runtime.
- **Hardcoded localhost / port dependencies:**
  - **Pass:** Zero `localhost` or `127.0.0.1` URLs in `app/`, `components/`, `lib/`, or `proxy.ts`. Browser client helpers use relative paths (`/api/...`) and `window.location.origin`.
- **Proven/Likely Serverless Deployment Risks:**
  1. **Personal Document Upload Webhook URL (Proven External Binding Dependency):**
     - Personal document uploads trigger Postgres `dispatch_document_ingestion()` and Cron `recover_document_ingestion()` ([202611040001](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/supabase/migrations/202611040001_automatic_ingestion_recovery.sql#L82-L87), [202611040002](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/supabase/migrations/202611040002_align_storage_webhook.sql#L8-L21)), which call `vault.decrypted_secrets` (`ingestion_webhook_url` matching `^https://[^/]+/api/webhooks/storage$` and `ingestion_webhook_secret` matching `SUPABASE_WEBHOOK_SECRET`).
     - If Personal Supabase Vault points to a localhost tunnel or stale host, newly uploaded Personal documents will remain unindexed until Vault is updated to `https://<your-app>.vercel.app/api/webhooks/storage`. Existing indexed Personal documents work unaffected.
  2. **Function Timeouts & `maxDuration` (`app/api/enterprise/ingest`, `webhooks/storage`, `chat`):**
     - `enterprise/ingest/route.ts` (`maxDuration = 300`) and `webhooks/storage/route.ts` (`maxDuration = 300`) declare 300s Node.js functions for multi-section PDF Gemini extraction + chunk embedding (`AbortSignal.timeout(270000)`).
     - `app/api/chat/route.ts` exports `runtime = 'nodejs'` with **no** `maxDuration` export (`embedContent` 15s + retry, retrieval RPC 15s + retry, generation deadline 35s, DB write 5s — typically 2–6s live, up to ~65s worst-case).
     - **Vercel constraint (verify at deploy time):** Ensure **Vercel Fluid Compute** is enabled on the project (supports up to `300s` even on Hobby) or check plan limits if deploying without Fluid Compute (legacy Hobby caps `maxDuration` at 60s and rejects/fails builds or truncates functions configured above plan max).
  3. **Suggestion Fallback Model Mismatch (`app/api/webhooks/storage/route.ts:119`):**
     - Line 70 uses `process.env.EXTRACTION_MODEL || "gemini-3.5-flash-lite"`, while optional suggested-question generation on line 119 defaults to `process.env.EXTRACTION_MODEL || "gemini-3.8-flash"`. Wrapped in non-fatal `try/catch` (does not fail ingestion); setting `EXTRACTION_MODEL=gemini-3.5-flash-lite` on Vercel avoids failing optional suggested queries without code edits.
  4. **Telemetry `setImmediate` (`app/api/chat/route.ts:144-151`):**
     - Guarded by `if (process.env.NODE_ENV !== 'development') return;` — never executes in Vercel production builds (`NODE_ENV=production`), and interaction persistence itself is `await`ed before closing the response.

---

## 6. Dependency Security Review (`pnpm audit --json`)

Current `pnpm audit` totals: **`0` critical, `15` high, `22` moderate, `10` low** (`47` advisories across `1,335` dependencies). Next.js `16.4.6` has **`0` advisories**.

### Breakdown of All `15` High-Severity Advisories

| Category / Package | Affected Version(s) | Advisory ID(s) | Dependency Relationship | Patched Version | Actually Used by Deployed App Runtime? | Pre-Deploy Action Needed? |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `@azure/msal-node` | `6.0.1` | `GHSA-xcx6-jx8p-x3h5` | Transitive (`devDependencies`: `promptfoo`) | `>=7.1.0` | **No** (eval CLI only, not in Vercel bundle) | No |
| `basic-ftp` | `5.3.1` | `GHSA-c475-qrg2-pj4r` | Transitive (`devDependencies`: `promptfoo`) | `>=6.2.1` | **No** (eval CLI only) | No |
| `mongoose` (`2` advs) | `9.11.2` | `GHSA-gg4r-jv3p-qx3c`, `GHSA-8332-j7wj-wjw4` | Transitive (`devDependencies`: `promptfoo>natural`) | `>=9.11.4` | **No** (eval CLI only) | No |
| `node-forge` (`8` advs) | `1.4.0` | `GHSA-86w9-cpqp-85rv`, `GHSA-7wch-p9px-956x`, `GHSA-jc66-7q78-782g`, `GHSA-8hrf-8g6f-7xwp`, `GHSA-hqq3-7jhf-c5jx`, `GHSA-5x38-2vff-x55p`, `GHSA-rhr8-3pm8-cq29`, `GHSA-6qrw-m8cv-hcxf` | Transitive (`devDependencies`: `promptfoo>jks-js`) | `>=1.4.1` | **No** (eval CLI only) | No |
| `body-parser` | `2.3.0` | `GHSA-27r3-jxmh-p828` | Transitive (`dependencies`: `@google/genai>@modelcontextprotocol/sdk>express`, `shadcn>@modelcontextprotocol/sdk>express`) | `>=2.4.0` | **No** (app only invokes `GoogleGenAI` REST/SDK calls, never starts MCP Express server) | No blocker |
| `systeminformation` | `5.33.15` | `GHSA-3f7j-7jwc-fxfj` | Transitive (`dependencies`: `shadcn>@shadcn/registry>@dotenvx/dotenvx`) | `>=5.33.16` | **No** (`shadcn` is a local CLI tool never imported in `app/`/`lib/`/`components/`; advisory is also Windows-only) | No blocker (optional: move `shadcn` to `devDependencies` post-demo) |
| `zod` (`3.25.76` nested) | `3.25.76` | `GHSA-mrhx-c7xc-m3w5` | Transitive (`dependencies`: `shadcn` & `shadcn>@modelcontextprotocol/sdk`) | `>=4.6.6` | **No** (`app/`/`lib/`/`components/` do not import `zod` or `shadcn`; AI SDK uses `zod@4.6.7`) | No blocker |

**Conclusion:** None of the `15` high-severity advisories are reachable in deployed Vercel serverless or browser runtime; no forced dependency upgrades are required before deploying the portfolio demo.

---

## 7. Automated Verification & Production Build Results (Fresh WP9.42 Run)

All checks ran cleanly on the untouched current codebase (no `.ts`/`.tsx` changes made during WP9.42):
- **`npm run typecheck`** (`tsc --noEmit --incremental false`): **Passed** (`0` errors).
- **`npm run lint`** (`eslint app components lib scripts tests proxy.ts`): **Passed** (`0` errors, `9` pre-existing unused-var warnings in untouched UI components).
- **`npm test`** (`tsx --test tests/*.test.ts`): **`274 / 274` passed**, `0` failed, `0` skipped.
- **`pnpm build`** (`next build`, Next.js `16.4.6` Turbopack): **Passed** (`Compiled successfully in 49s`, TypeScript `5.3s`, `20/20` static pages generated, routes `/`, `/_not-found`, `/enterprise`, `/login`, `/project/[id]`, `/reset-password`, all `/api/*` routes, and `Proxy (Middleware)` built with zero errors).

---

## 8. Post-Deployment Smoke-Test Checklist (Execute After Approved Deployment)

Once committed, pushed, configured in Vercel + Supabase, and deployed to `https://<your-app>.vercel.app`:

1. **HTTPS Load & UI Tabs:** Open `https://<your-app>.vercel.app` over HTTPS cleanly -> redirects to `/login?workspace=personal`; verify `Personal RAG` and `Enterprise RAG` workspace tabs/toggles render with zero browser console or 5xx errors.
2. **Personal RAG Flow (`smhzdovflyuqznpcxype`):** Sign in to `Personal RAG`, verify projects list loads, open a project workspace (`/project/<id>`), ask a grounded question -> verify streamed answer and clickable citations.
3. **Enterprise Isolation Prompt on Unauthenticated Tab:** Click `Enterprise RAG` tab while signed only into Personal -> verify clean redirect to `/login?workspace=enterprise` (never reuses Personal identity).
4. **Enterprise RAG Flow & RLS (`cpowlkptvtnkjkulveph`):** Sign in as Enterprise Engineering user (`/?tab=enterprise`), query `D01` (`Who is listed as custodian and independent reviewer for D01?`) -> cited `HR Manager` / `Operations Manager`; query `D04` -> cited Engineering answer; query `D07` / `D03` (restricted UI/UX or confidential comp) -> refusal with `0` citations.
5. **Concurrent Session Coexistence:** Inspect browser cookies / DevTools Application tab -> confirm both `sb-smhzdovflyuqznpcxype-auth-token` and `sb-cpowlkptvtnkjkulveph-auth-token` exist over HTTPS; switch `Personal -> Enterprise -> Personal` without re-login.
6. **Independent Logout:** Click `Sign out` inside `Enterprise RAG` -> confirm Enterprise redirects to `/login?workspace=enterprise` while `/?tab=personal` remains active; re-login Enterprise, click `Sign out` inside `Personal RAG` -> confirm Enterprise remains active.
7. **Password Reset & Confirmation Redirects:** Trigger "Forgot password" on both `Personal RAG` and `Enterprise RAG` -> verify email reset links land on `https://<your-app>.vercel.app/reset-password?workspace=personal|enterprise` (never `localhost:3000`) and complete PKCE recovery cleanly.
8. **Optional Personal Upload Check:** Upload a small `.txt`/`.pdf` in Personal RAG -> verify storage trigger + `/api/webhooks/storage` indexes it (only if Vault webhook URL was updated to Vercel).
9. **Security & Runtime Logs Check:** Inspect served `/_next/static/chunks/*.js` responses for zero secret/service-role keys; run cross-project JWT sanity checks (`Personal JWT -> /api/enterprise/departments` returns `401`, `Enterprise JWT -> /api/projects` returns `401`); inspect Vercel Runtime Logs for zero unhandled 500s or timeout aborts.

---

## 9. Ranked Blockers & Action Items

### Critical (Must Complete Before / During First Deployment)
1. **Stage, commit, and push clean code to `origin/main`:** Remote `main` lacks WP9.12–WP9.41; exclude local `.backup.*.json` and `*.bak` files.
2. **Configure dual-project Vercel environment variables explicitly** (Section 3 table; skip single-project Vercel Supabase integration).
3. **Update Supabase Auth `Site URL` and `Redirect URLs`** on both `smhzdovflyuqznpcxype` and `cpowlkptvtnkjkulveph` once the `https://<your-app>.vercel.app` domain exists.
4. **Update Personal Supabase Vault `ingestion_webhook_url` & `ingestion_webhook_secret`** (only needed if live Personal uploads will be demonstrated on Vercel; existing indexed Personal docs already work without it).

### Important (Verify on Vercel Project Settings / Deploy)
1. **Confirm Vercel Fluid Compute / function timeout compatibility** for `maxDuration = 300` on `app/api/enterprise/ingest/route.ts` and `app/api/webhooks/storage/route.ts`, and consider whether `app/api/chat/route.ts` needs a plan-safe duration budget (`<=60s` default if Fluid Compute is off).
2. **Set `EXTRACTION_MODEL=gemini-3.5-flash-lite`** in Vercel env vars so Personal webhook optional suggested-questions don't hit the stale `"gemini-3.8-flash"` default string in `app/api/webhooks/storage/route.ts:119`.
3. **Copy `ACTIVEPIECES_JIRA_*` webhook env vars** if live Jira demo creation/status lookup will be shown on Vercel.

### Optional (Post-Demo Cleanup)
1. **Reclassify `shadcn`** from `dependencies` to `devDependencies` in `package.json` cleanly when convenient (eliminates the `3` non-executed production-flagged CLI advisories in `pnpm audit`).
2. **Clean up local unused-var ESLint warnings (`9`)** and stale untracked `.backup.*.json` / `.bak` files from working directory.

---

## 10. Final Recommendation

**`READY AFTER SPECIFIC FIXES`** — Code changes for WP9.39–WP9.41 are production-ready and verified (`typecheck`, `lint`, `274/274` tests, `next build`). Proceed only after user approval to: (1) create a clean Git commit & push (excluding `.env*`, backups, and `.bak` files), (2) configure Vercel dual-project env vars + Fluid Compute, (3) deploy, and (4) apply the Vercel domain to both Supabase projects' Auth URL configs (and Personal Storage Vault if testing new uploads).
