# WP9.40 — Minimal Next.js Security Upgrade Report

**Date:** 2026-11-17  
**Final Decision:** **`PASS`**  
**Previous Version:** `next@16.4.2` / `eslint-config-next@16.4.2`  
**Updated Version:** `next@16.4.6` / `eslint-config-next@16.4.6` (`--save-exact`, `pnpm@12.6.0`)  
**WP9.39 Preservation:** Confirmed — all WP9.39 Supabase API-key migration edits (`lib/supabase/config.ts`, `lib/supabase/client.ts`, `lib/supabase/server.ts`, `lib/supabase/admin.ts`, `proxy.ts`, `lib/auth.ts`, `run_enterprise_decisions_eval.py`, `tests/supabase-config.test.ts`, `tests/test_enterprise_decisions_eval.py`) and all `.env`, `.env.local`, and `.env.test.local` files remain intact and verified.

---

## 1. Exact Files Changed & Lockfile Summary

- **`package.json`** (`4` lines changed):
  - `"next": "16.4.2"` -> `"next": "16.4.6"` (`dependencies`)
  - `"eslint-config-next": "16.4.2"` -> `"eslint-config-next": "16.4.6"` (`devDependencies`)
  - React (`react@19.3.0`, `react-dom@19.3.0`) and all unrelated dependencies untouched.
- **`pnpm-lock.yaml`** (`100` lines changed: `+50 / -50` via `pnpm add next@16.4.6 --save-exact` and `pnpm add -D eslint-config-next@16.4.6 --save-exact`):
  - Installed `node_modules/next/package.json` = `16.4.6`; `node_modules/eslint-config-next/package.json` = `16.4.6`; `node_modules/react/package.json` = `19.3.0`.
- **`.gitignore`:** Added `/wp9_40_backup/` (local pre-upgrade snapshots of `package.json` and `pnpm-lock.yaml`).

---

## 2. Security Audit & Warning Verification

- **Startup advisory resolved:** Both `pnpm dev:test` and `pnpm dev` on `Next.js 16.4.6 (Turbopack)` started without the `16.4.2` security vulnerability banner/exit.
- **`pnpm audit --json` before vs. after upgrade:**
  - **Before (`16.4.2`):** `info: 0 | low: 10 | moderate: 23 | high: 15 | critical: 0` (`48` total), including `GHSA-mfr8-8qww-v76h` on `next` (`>=16.3.0 <=16.4.4`, patched `>=16.4.5`).
  - **After (`16.4.6`):** `info: 0 | low: 10 | moderate: 22 | high: 15 | critical: 0` (`47` total), with `POST_NEXT_ADVS: []` (zero remaining advisories on `next`; zero new critical/high/moderate issues introduced).
- **Remaining non-Next.js transitive advisories (unchanged from baseline):** `10` low, `22` moderate, `15` high in existing dev/transitive packages (such as `promptfoo` / `basic-ftp` / `hono` / `node-forge`); not modified per minimal-scope constraint.

---

## 3. Automated Tests & Production Build (`next@16.4.6`)

- `npm test` (`tsx --test tests/*.test.ts`): **`271 / 271` passed**, `0` failed, `0` skipped.
- `npm run typecheck` (`tsc --noEmit --incremental false`): **`0` errors**.
- `npm run lint` (`eslint app components lib scripts tests proxy.ts`): **`0` errors** (`9` pre-existing unused-variable warnings in untouched UI components).
- `python -m unittest discover -s scripts -p "test_*.py"`: **`86 / 86` passed**.
- `python -m unittest tests/test_enterprise_decisions_eval.py`: **`23 / 23` passed** (`50`-case golden suite validation OK).
- `pnpm build` (`next build`, Next.js `16.4.6` Turbopack): **`PASS`** — compiled cleanly in `50s`, TypeScript check passed (`48s`), generated all `20 / 20` pages and `/`, `/login`, `/enterprise`, `/project/[id]`, `/reset-password`, `/api/*`, and `Proxy (Middleware)`.

---

## 4. Enterprise RAG Verification (`pnpm dev:test` -> `cpowlkptvtnkjkulveph`)

Verified on Next.js `16.4.6` using `.env.test.local` (`sb_publishable_...` and `sb_secret_...`):
- **Login & Browser Assets (`GET /login` + `20` JS chunks):** `HTTP 200`; `cpowlkptvtnkjkulveph.supabase.co` and `sb_publishable_` present (`url_cpowlk=True`, `pub_key=True`), while `smhzdovflyuqznpcxype`, `SUPABASE_SECRET_KEY`, and legacy `service_role` key were absent (`secret_leaked=False`, `legacy_svc_leaked=False`, `personal=False`).
- **Authenticated Dashboard (`GET /?tab=enterprise` with `@supabase/ssr` cookie):** `HTTP 200`, `has_org=True`, `has_eng=True`, `restricted=False`.
- **Policy Retrieval, Access Denial, Citations & Reauthorization (`/api/chat` + `enterprise_chunks_still_visible`):**
  - `D01` (company-wide): `HTTP 200`, `1` citation, `vis_eng=True`, `vis_uiux=True` (explicit custodian `HR Manager` and reviewer `Operations Manager`).
  - `D04` (Engineering SOP): `HTTP 200`, `1` citation, `vis_eng=True`, `vis_uiux=False` (critical bug triage target `2 operational business hours`).
  - `D07` (UI/UX SOP denied to Engineering): `HTTP 200`, `0` citations, exact refusal `"I don't know based on the documents I can access."`.
- **Secret-key fixture resolution (`resolve_target_documents_fixture` with legacy keys stripped from env):** Resolved `D03`, `D11`, `D04`, and `D07` cleanly via `SUPABASE_SECRET_KEY`.

---

## 5. Personal RAG Verification (`pnpm dev` -> `smhzdovflyuqznpcxype`)

After stopping `pnpm dev:test` and starting `pnpm dev` on Next.js `16.4.6` using untouched `.env.local`:
- **Login & Browser Isolation (`GET /login` + `20` JS chunks):** `HTTP 200`; `smhzdovflyuqznpcxype.supabase.co` and Personal legacy `anon` key only (`url_personal=True`, `personal_anon=True`); zero Enterprise URL/key leakage (`ent_url=False`, `ent_pub=False`, `ent_sec=False`).
- **Personal Auth & Workspace:** Sign-in succeeded (`uid=dbc16ad3-391f-42fb-8792-db998609a2a5`); `GET /?tab=personal` returned `HTTP 200` (`has_personal=True`).
- **Projects, Retrieval & Chat:** `GET /api/projects` returned `2` projects (`Project 2`, `First project`), `GET /api/documents` showed `2` indexed documents on `First project`, user-RLS chunk query returned `1` chunk, and `POST /api/chat` returned `HTTP 200` with `8` citations and persisted `interactionId`.

---

## 6. Remaining Warnings & Scope Confirmation

- No remaining Next.js security advisories (`POST_NEXT_ADVS: []`).
- Non-blocking repo baseline notes observed during build/install: `pnpm` noted deprecated subdependencies (`@types/dotenv@8.2.3`, `eslint@9.39.5`, `@modelcontextprotocol/server-filesystem`, `node-domexception`), Next.js noted slow filesystem warning on mapped drive `G:\`, and ESLint reported `9` pre-existing unused-variable warnings in untouched UI components.
- Zero database, RLS, `.env*`, prompt, evaluator, Jira, or deployment changes were performed; changes remain uncommitted for review.

