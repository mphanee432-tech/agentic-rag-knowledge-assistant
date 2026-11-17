# WP9.41 — Dual-Project Routing Report

**Date:** 2026-11-17  
**Next.js Version:** `16.4.6` (Turbopack)  
**Personal RAG Supabase Project:** `smhzdovflyuqznpcxype` (legacy `anon` / `service_role` keys preserved)  
**Enterprise RAG Supabase Project:** `cpowlkptvtnkjkulveph` (modern `sb_publishable_...` / `sb_secret_...` keys)

---

## 1. Summary

Personal RAG (`smhzdovflyuqznpcxype`) and Enterprise RAG (`cpowlkptvtnkjkulveph`) now operate simultaneously inside the single existing Next.js `16.4.6` application under a single `pnpm dev` process. Each workspace resolves its own Supabase URL, keys, client cache, cookie namespace, SSR session check, login/signup/password-recovery flow, and server authorization boundary without cross-project key mixing, session collisions, or database/schema modifications.

---

## 2. Environment Variables Used (Names and Project Refs Only)

All values remain stored exclusively in ignored local env files; zero keys, tokens, or passwords are included here.

### Personal RAG (`smhzdovflyuqznpcxype`)
- `NEXT_PUBLIC_PERSONAL_SUPABASE_URL` -> project `smhzdovflyuqznpcxype`
- `NEXT_PUBLIC_PERSONAL_SUPABASE_ANON_KEY` -> public legacy `anon` key for `smhzdovflyuqznpcxype`
- `PERSONAL_SUPABASE_SERVICE_ROLE_KEY` -> server-only legacy `service_role` key for `smhzdovflyuqznpcxype`
- Legacy fallback variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) in `.env.local` remain pointed to `smhzdovflyuqznpcxype`.

### Enterprise RAG (`cpowlkptvtnkjkulveph`)
- `NEXT_PUBLIC_ENTERPRISE_SUPABASE_URL` -> project `cpowlkptvtnkjkulveph`
- `NEXT_PUBLIC_ENTERPRISE_SUPABASE_PUBLISHABLE_KEY` -> public `sb_publishable_...` key for `cpowlkptvtnkjkulveph`
- `ENTERPRISE_SUPABASE_SECRET_KEY` -> server-only `sb_secret_...` key for `cpowlkptvtnkjkulveph`

Single-project test mode (`pnpm dev:test` via `.env.test.local` and isolated unit-test mocks without explicit `NEXT_PUBLIC_PERSONAL_*` / `NEXT_PUBLIC_ENTERPRISE_*` variables) continues to resolve cleanly via `resolveWorkspacePublicSupabaseConfig` and `resolveWorkspaceAdminSupabaseConfig`. When dual-project variables are present, pointing Personal and Enterprise at the same origin/ref or omitting the Enterprise URL fails closed.

---

## 3. Client & Auth Cookie Architecture

### Browser Client Cache Isolation (`lib/supabase/client.ts`)
- `@supabase/ssr` caches a single module-global browser client unless `isSingleton: false` is set.
- `createBrowserClient(scope: WorkspaceScope = "personal")` passes `{ isSingleton: false, cookieOptions: { name: cookieName } }` and maintains separate per-scope client instances in a local `Map`.
- Static `process.env.NEXT_PUBLIC_*` reads in `readPublicEnvForBrowser()` (`lib/supabase/config.ts`) ensure Next.js/Turbopack inlines both public workspace configurations into browser bundles without referencing any server secret env variables.

### Distinct Auth Cookie Namespaces (`lib/supabase/config.ts`)
- `getSupabaseAuthCookieName(url, scope)`:
  - Personal (`smhzdovflyuqznpcxype`): `sb-smhzdovflyuqznpcxype-auth-token`
  - Enterprise (`cpowlkptvtnkjkulveph`): `sb-cpowlkptvtnkjkulveph-auth-token`
  - Non-`*.supabase.co` fallback: `sb-personal-auth-token` / `sb-enterprise-auth-token`

### Server & Admin Clients (`lib/supabase/server.ts`, `lib/supabase/admin.ts`)
- `createServerClient(scope: WorkspaceScope = "personal")` binds cookie reads/writes and public API credentials strictly to the requested workspace's cookie namespace and project URL.
- `createAdminClient(scope: WorkspaceScope = "personal")` resolves only server-only secret/`service_role` env vars for the requested workspace and validates URL-to-key project alignment.

---

## 4. Routing & Workspace Isolation Boundaries

| Area | Scope Binding | File(s) |
| :--- | :--- | :--- |
| Middleware / Proxy | Refreshes Personal and Enterprise cookies independently without overwriting prior `Set-Cookie` headers; routes PKCE `code` / `token_hash` callbacks by `?workspace=` or `-code-verifier` cookie prefix | [proxy.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/proxy.ts) |
| Auth Helpers | `requireUser(req, scope)` enforces caller verification against the target workspace; `requireProject` is pinned to `"personal"`; `requireEnterpriseUploader` is pinned to `"enterprise"`; `requireChatProject` checks `"personal"` owned projects and, in dual-project mode, verifies `"enterprise"` JWTs against `cpowlkptvtnkjkulveph` for enterprise project IDs | [lib/auth.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/lib/auth.ts) |
| Dashboard SSR & Project Page | `/?tab=personal` validates `"personal"` session (`redirect /login?workspace=personal`); `/?tab=enterprise` validates `"enterprise"` session (`redirect /login?workspace=enterprise`); skips cross-project enterprise metadata RPCs in Personal dual-project mode | [app/page.tsx](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/page.tsx), [app/project/[id]/page.tsx](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/project/%5Bid%5D/page.tsx) |
| Login / Signup / Reset Password | Workspace selector (`Personal RAG` vs `Enterprise RAG`) pinned from `?workspace=`; Personal flows skip Enterprise department/`/api/enterprise/onboard`; forgot password appends `?workspace=<scope>`; reset-password detects matching workspace session and signs out only that workspace (`{ scope: "local" }`) | [app/login/page.tsx](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/login/page.tsx), [app/reset-password/page.tsx](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/reset-password/page.tsx) |
| Selective Sign-Out | `signOut(workspace)` clears only the target workspace session; `BroadcastChannel("copilot-sign-out")` scopes invalidation by `{ workspace }` | [app/actions/auth.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/actions/auth.ts), [components/sign-out.tsx](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/components/sign-out.tsx) |
| Personal APIs & Actions | Strictly pinned to `"personal"` (`smhzdovflyuqznpcxype`) | [app/actions/projects.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/actions/projects.ts), [app/api/projects/route.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/api/projects/route.ts), [app/api/documents/route.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/api/documents/route.ts), [app/api/feedback/route.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/api/feedback/route.ts), [components/upload/document-uploader.tsx](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/components/upload/document-uploader.tsx) |
| Enterprise & Jira APIs | Strictly pinned to `"enterprise"` (`cpowlkptvtnkjkulveph`) | [app/api/enterprise/can-upload/route.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/api/enterprise/can-upload/route.ts), [app/api/enterprise/departments/route.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/api/enterprise/departments/route.ts), [app/api/enterprise/ingest/route.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/api/enterprise/ingest/route.ts), [app/api/enterprise/onboard/route.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/api/enterprise/onboard/route.ts), [app/api/jira/status/route.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/api/jira/status/route.ts), [app/api/jira/options/route.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/api/jira/options/route.ts), [app/api/jira/create/route.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/api/jira/create/route.ts), [components/upload/enterprise-policy-dialog.tsx](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/components/upload/enterprise-policy-dialog.tsx) |
| Shared Routes | `/api/documents/upload-url` routes Personal uploads (`classification`/`organizationId`/`departmentId` omitted) to `"personal"` and policy reservations to `"enterprise"`; `/api/chat` routes `organizationId` requests strictly to `"enterprise"` and persists `interactions` with the matching workspace admin client; `/api/webhooks/storage` routes `?workspace=enterprise` or `enterprise/*` paths to `"enterprise"` and others to `"personal"` | [app/api/documents/upload-url/route.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/api/documents/upload-url/route.ts), [app/api/chat/route.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/api/chat/route.ts), [app/api/webhooks/storage/route.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/app/api/webhooks/storage/route.ts) |

---

## 5. Verification Results

### Static, Unit, Build, and Secret-Scan Checks
- **`npm run typecheck`:** Passed (`0` errors).
- **`npm run lint`:** Passed (`0` errors; `9` pre-existing unused-var warnings in untouched UI files).
- **`npm test`:** `274` / `274` tests passed (including `3` new tests across [tests/supabase-config.test.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/tests/supabase-config.test.ts) and [tests/dual-project-routing.test.ts](file:///g:/AI%20Tools%20and%20Resources/RAG/rag-knowledge-assistant/tests/dual-project-routing.test.ts)).
- **`python -m unittest tests/test_enterprise_decisions_eval.py`:** `23` / `23` tests passed.
- **`pnpm build`:** Next.js `16.4.6` production build compiled cleanly across all routes.
- **Secret Scan (`.next/static` & live Playwright JS bundle interception):** Scanned `40` build static files and `16,959,805` bytes of live served client JS chunks; `0` actual secret keys or `service_role` tokens appeared in browser-delivered JS.

### Live Single-Server (`pnpm dev` on `http://localhost:3000`) Verification
1. **Personal RAG (`smhzdovflyuqznpcxype`):**
   - Unauthenticated `/` redirected to `/login?workspace=personal`.
   - Signed in via UI and via Personal JWT (`/api/projects` returned `2` projects `First project` and `Project 2`; `/api/chat` returned HTTP `200` with `8` citations; opening `/project/204894b3-d41f-434a-b8d2-b5ce3c2d4645` rendered and chatted with `0` console errors).
2. **Enterprise RAG (`cpowlkptvtnkjkulveph`):**
   - Clicking `Enterprise RAG` while signed only into Personal redirected cleanly to `/login?workspace=enterprise` without reusing the Personal identity.
   - Engineering employee signed in concurrently (`org c0000000-0000-4000-8000-000000000001`).
   - Verified authorized D01 (`E008`: HTTP `200`, `1` citation, grounded `HR Manager` / `Operations Manager` answer via streaming UI & JSON API, `retrieved_chunk_count: 8`, `errors: []`) and authorized Engineering policy (`D04`: HTTP `200`, `1` citation).
   - Verified restricted cross-department refusal (`D03` Confidential Compensation Admin: HTTP `200`, `0` citations, `"I don't know based on the documents I can access."`).
3. **Concurrent Same-Browser Coexistence & Selective Logout:**
   - Verified simultaneous cookies `sb-smhzdovflyuqznpcxype-auth-token` and `sb-cpowlkptvtnkjkulveph-auth-token` in Chromium.
   - Switched `Personal -> Enterprise -> Personal -> Enterprise` without re-login.
   - Signed out of Enterprise only -> Personal session remained active. Re-authenticated Enterprise and signed out of Personal only -> Enterprise session remained active.
4. **Cross-Project & Forgery Isolation:**
   - Personal JWT -> `/api/enterprise/departments`: HTTP `401`
   - Personal JWT -> `/api/chat` (`organizationId`): HTTP `401`
   - Personal JWT -> `/api/jira/options`: HTTP `401`
   - Enterprise JWT -> `/api/projects`: HTTP `401`
   - Enterprise JWT -> `/api/documents`: HTTP `401`
   - Enterprise JWT -> `/api/documents/upload-url` (personal payload): HTTP `401`
   - Enterprise JWT -> `/api/chat` (personal `projectId`): HTTP `404`
   - Forged `GET /api/projects?workspace=enterprise` with Personal JWT ignored query param and stayed scoped to Personal (`2` projects).

---

## 6. Preservation Guarantees & Clean Working Tree
- Pre-edit code checkpoint saved locally in ignored `wp9_41_backup/wp9_41_pre_edit.zip` (no `.env*` files included).
- Zero database schema, RLS policy, document, embedding, system prompt (`V0`), Jira configuration, or evaluator changes made.
- No commits or pushes performed.
