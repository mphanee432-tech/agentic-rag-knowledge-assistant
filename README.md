# RAG Knowledge Assistant

Next.js application for authenticated, project-scoped document upload and cited chat. Supabase provides Auth, Storage, PostgreSQL and vector retrieval; Gemini provides extraction, embeddings and generation.

## Setup

1. Install dependencies with `pnpm install --frozen-lockfile`.
2. Configure `.env.local` (never commit credentials):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` — server only
   - `GOOGLE_GENERATIVE_AI_API_KEY`
   - `SUPABASE_WEBHOOK_SECRET` — required, fail-closed
   - Optional `CHAT_MODEL` and `EXTRACTION_MODEL`.
3. Apply `supabase/migrations/202610280001_harden_access_and_ingestion.sql`, then follow [automatic ingestion recovery setup](docs/ingestion-recovery.md) to enable Cron/pg_net, configure Vault and apply `supabase/migrations/202611040001_automatic_ingestion_recovery.sql`. Validate in staging before deploying the application. These upgrade migrations require the existing projects, documents, document_chunks, interactions tables, documents bucket and match_chunks_hybrid_rrf function. The original schema/RPC is not in this repository; fresh-database provisioning is not yet supported.
4. Provision users through Supabase Auth and sign in at `/login`. Remove or rotate the old shared demo account before exposing the application.
5. Configure a Storage INSERT webhook to POST to `/api/webhooks/storage`, with `x-webhook-secret` set to the secret above. Supabase Cron recovers missed deliveries, transient failures and expired processing leases through the same endpoint. Do not send the secret to browsers.
6. Run `pnpm dev`.

Deploy the migration and application together: the new API depends on its reservation fields and ingestion RPCs. Review existing policies/triggers for naming conflicts before applying. The migration intentionally restricts direct browser document writes and direct execution of the legacy search RPC.

## Access and upload lifecycle

All application endpoints require a verified Supabase user and project ownership. Bearer access tokens are supported for evaluation clients; there is no privileged evaluation bypass. Project/document reads are also protected by restrictive RLS policies.

Uploads reserve a document through the authenticated upload-url endpoint, then send bytes directly to Storage using the signed token ([Supabase signed-upload contract](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl)). A database trigger serializes the ten-document quota. Pending uploads count against the quota. Recovery marks reservations without source objects failed after 2 hours 15 minutes, releasing quota without deleting files or records.

The ingestion webhook only accepts an existing reservation. It validates the actual file size, parses PDFs in 25-page windows, embeds in batches of four, and atomically replaces chunks and marks the document indexed. The Node runtime has a 300-second execution budget and a 270-second provider deadline. Ensure the hosting plan supports that duration.

Duplicate indexed events are acknowledged. Concurrent events and retries before their scheduled time receive 409. Supabase Cron checks every minute and dispatches up to five eligible documents per run. A document gets at most three execution attempts, with one-minute and five-minute backoff after transient errors; expired six-minute leases are reclaimed automatically. Invalid inputs and exhausted retries are terminal failures requiring a new upload. Existing failed records are not silently restarted. Legacy unindexed documents without a size reservation should be uploaded again. Large indivisible sections and truncated PDF extraction fail explicitly.

Document/project deletion checks ownership and removes source objects. Storage cleanup failures are reported; orphaned objects require administrator cleanup if Storage is unavailable. No durable cleanup worker is configured.

## Chat protocol

`POST /api/chat` uses SSE for interactive chat:
- metadata: interaction ID and indexed citation records
- text: answer text only
- finish: token/timing metrics; full retrieval context only when an authenticated caller sets x-eval-mode
- error: terminal failure, never a successful partial answer

Both UI entry points share the parser. Inline citations use `[Chunk 1]` or grouped `[Chunk 1, Chunk 2]` markers. Unknown citations are labeled unverified. The server validates RPC results against authoritative indexed documents, bounds history and output, and returns a fixed refusal for empty retrieval. Semantic relevance thresholds still require calibration against the deployed RPC.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test
python -m unittest discover -s scripts -p "test_*.py"
pnpm build
```

For live evaluation, install Python dependencies from `scripts/requirements-eval.txt` and set:
- Either `EVAL_ACCESS_TOKEN` (a manual user-token override), or `EVAL_TEST_EMAIL` and `EVAL_TEST_PASSWORD` for the existing project-owner account.
- Password sign-in uses `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, falling back to `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Never configure a privileged key here.
- `EVAL_PROJECT_ID`: optional populated golden-corpus project override; required for release isolation fixtures.
- `EVAL_OTHER_ACCESS_TOKEN`, `EVAL_OTHER_PROJECT_ID`: a different test user and its own project
- `EVAL_API_URL`: optional chat endpoint; defaults to localhost:3000/api/chat
- Google API credentials for the semantic judge

The Python runner keeps its session in memory, refreshes automatically, and retries an authentication-related 401 once per request. A nonempty `EVAL_ACCESS_TOKEN` always takes precedence over email/password credentials and has no automatic refresh or password-login fallback. Tokens must be authenticated-user JWTs with valid expiration metadata; malformed tokens and API keys are rejected.

To switch to automated sign-in, make `EVAL_ACCESS_TOKEN` empty in the evaluator process, or remove it from the process and both `.env.local` and `.env`. Clearing only the process variable can allow dotenv to restore a stored override. Never include credential values in logs or reports. Dataset-only validation does not load dotenv files or authenticate.

The existing owner alone is sufficient for `pnpm eval:py:smoke` and `python scripts/eval_runner.py --full --stream`. These are smoke/exploratory runs. `pnpm eval:py:full` is an alias for `eval:release`: it still requires `EVAL_PROJECT_ID`, a separate second user's nonempty `EVAL_OTHER_ACCESS_TOKEN`, a distinct `EVAL_OTHER_PROJECT_ID`, and successful two-user isolation checks. The second token is checked before any sign-in request. Passing response release gates does not establish full PRD certification.

Authentication/authorization failures exit 2 without a quality verdict; any partial JSONL is incomplete. Use HTTPS endpoints, or HTTP on loopback only. Promptfoo and the existing staging workflow still use manually supplied tokens.

Initial sign-in, release preflight, and proactive refresh performed before the query timer are excluded from per-query TTFT/total latency. A 401-triggered refresh/retry occurs inside that existing timer and is included; it increments the existing request-retry count. Timing definitions, scoring, and artifact schemas are unchanged.

Activate a Python environment with those requirements installed before running the packaged commands (on Windows, `.\.venv\Scripts\Activate.ps1`; on macOS/Linux, `source .venv/bin/activate`):

- `pnpm eval:check`: validate the canonical 50-case schema/allocation offline, without credentials.
- `pnpm eval:prepare`: generate Promptfoo cases from the same golden schema; `pnpm eval` runs exploratory comparisons.
- `pnpm eval:py:smoke`: five streaming cases, one per category. Every answer must pass transport, citation and format checks, plus the judge when configured. A successful smoke run is not release certification.
- `pnpm eval:release`: the full streaming dataset with explicit release gates and two-user isolation checks. `pnpm eval:py:full` is a compatibility alias.
- `python scripts/eval_runner.py --full --stream`: exploratory evaluation. Add `--release` to enforce response release gates.

Live evaluation commands make billable generation calls (and judge calls when configured); `eval:check` and `eval:prepare` are offline. Never use a service-role key as a test user token. Outputs default to ignored `artifacts/evaluation`; use `--output-dir <directory>` to override it.

Response release evaluation requires the 23/10/7/8/2 allocation, verified isolation, no request errors, >=95% valid citation references, >=99% format conformance, >=95% combined answer passes, >=90% regression passes, faithfulness/relevance >=2.5/3, p95 TTFT <=2 seconds and p95 total latency <=8 seconds. Empty answers, unknown/malformed citations, overlong output, truncated streams and HTTP errors cannot pass through a positive judge score. Missing judges or isolation fixtures fail closed. `response_release_gates_passed` records that limited verdict; `release_certified` remains false because cost <=₹0.50 and exact dense-vector recall =100% have not been measured. See [evaluation commands and coverage](docs/evaluation-ci.md).

Promptfoo configuration is retained for exploratory comparisons, not release certification. Historical result files predate these gates and have not been regenerated.

## Continuous integration

`CI / Deterministic checks` runs type checking, lint, application tests and Python evaluation tests on pull requests and pushes to `main`, without application credentials or live model calls. The manually dispatched `Staging evaluation` workflow runs smoke or release evaluation against the deployed staging endpoint and retains that run's logs and results even when gates fail.

See [CI and staging evaluation setup](docs/evaluation-ci.md) for environment variables, secrets, branch protection and running the workflows. Workflow files do not configure GitHub repository settings or deploy the application.
