# Agentic automatic ingestion activation

## Verified state — 21 November 2026

This phase prepared configuration locally. No live triggers, jobs, Vault values,
document records, chunk data or authorization policies were changed. No HTTP
ingestion request was sent to either Agentic project or any Classic RAG project.

| Item | Agentic Personal | Agentic Enterprise |
| --- | --- | --- |
| Project | `agentic-personal-rag` | `agentic-enterprise-rag` |
| Project ref | `jdwttbkjpssrbeaoyzkc` | `ldkxyleqfbovqpkpoyek` |
| pg_net, pg_cron, Vault | Installed | Installed |
| Claim/fail/finish/recovery/dispatch functions | Present | Present |
| App Storage INSERT trigger | Missing | Missing |
| Both ingestion Vault bindings | Missing | Missing |
| Recovery Cron job | Missing | Missing |
| Documents Realtime publication | Missing | Missing |
| Documents/chunks | 1 uploaded / 0 chunks | 12 indexed / 96 chunks |

Local scoped URLs and admin credentials match the two Agentic projects. The
server webhook secret is configured. No local ngrok tunnel is running and no
`SUPABASE_ACCESS_TOKEN` is configured for the setup script.

**Enterprise prerequisite:** the connected Enterprise database lacks these
contracts used by the existing upload/publication routes:

- `public.can_upload_enterprise_policy(uuid)`
- `public.reserve_enterprise_policy(uuid,uuid,uuid,text,bigint,text,text)`
- `public.publish_enterprise_document(uuid)`

Automatic indexing must not invent these authorization decisions or publish
policies as an administrator. The activation script refuses Enterprise writes
until the approved contracts are restored through a separately reviewed change.
That reviewable change and its isolated authorization tests are now prepared in
[Enterprise upload/publication restoration](agentic-enterprise-upload-restoration.md).
It has not been applied. It also restores department/context UI dependencies;
the current `employee` role remains ineligible until a separate role assignment
is explicitly approved.
Existing D01–D12 content is retained. Automatic ingestion indexes a reservation;
Enterprise publication still requires the existing authorized uploader flow.

## Architecture retained

Signed upload → `storage.objects` INSERT → `dispatch_document_ingestion` →
`pg_net` HTTPS POST → authenticated Next.js webhook → existing claim/lease →
Gemini extraction/embedding → atomic `finish_document_ingestion`.

The recovery Cron invokes `recover_document_ingestion()` every minute. Existing
rules remain: six-minute leases; at most three claimed worker executions; one- and
five-minute document retry backoff; six-minute dispatch cooldown for lost HTTP
delivery; five dispatches per tick and 25 inspected candidates. Dispatch does not
consume an attempt. A stale worker cannot finalize another worker's lease.

The operational SQL only replaces dispatch/recovery bindings and installs the
trigger, publication membership and named Cron job. Claim/fail/finish functions,
classification, access scope, publication decisions, authentication and RLS are
not rewritten. A synchronous dispatch queue failure leaves the uploaded object
intact for recovery; downstream network/HTTP failures are recovered after the
dispatch cooldown. No user-triggered upload needs to call the webhook manually.

## Reaching a local application

Hosted Supabase cannot reach this computer through `localhost:3000`. Keep
`pnpm dev` running and use a public HTTPS tunnel to that port, or separately
approve deployment to an HTTPS host that supports the worker's 300-second limit.
Deployment is not necessary for local development.

After approval to expose the local app, the installed ngrok agent can provide
the tunnel:

```powershell
ngrok http 3000
```

Use your available development endpoint; no paid account upgrade or new paid
infrastructure is required by this implementation. Account login/token setup may
be needed. The endpoint must accept server-to-server requests without interactive
login. Do not save request headers or webhook secrets in screenshots or logs.
The tunnel forwards traffic to the app and therefore must be treated as a public
entry point; webhook authentication remains enforced.

ngrok documents five-minute idle timeouts and no HTTP round-trip timeout. Keep
both processes and the computer awake. The route's 270-second processing window
and 250-second Gemini budget stay within the existing 300-second pg_net timeout.
An always-available deployment is needed only if ingestion must run while the
computer is offline. See [ngrok HTTP limits](https://ngrok.com/docs/gateway/endpoints/http#limits-and-timeouts).

## Server configuration and read-only preflight

Use the existing scoped Supabase URL/admin variables. Never point the generic
URL at a Classic project to configure Agentic ingestion. The script pins the two
Agentic refs and verifies their project names through the Management API before
any SQL write.

The script uses existing Python `requests`/`python-dotenv` tooling. Configure a
Supabase management token for the Agentic account as `SUPABASE_ACCESS_TOKEN`,
server-side only. It is not an application service-role key. Use a trusted local
environment or ignored `.env.local`; never commit or print credentials.

For separate delivery credentials, optionally set these server-only variables
and restart the app:

- `PERSONAL_SUPABASE_WEBHOOK_SECRET`
- `ENTERPRISE_SUPABASE_WEBHOOK_SECRET`

Each project's Vault receives its matching secret. If these variables are absent,
the existing `SUPABASE_WEBHOOK_SECRET` remains supported for compatibility. With
scoped secrets configured, events must include the explicit workspace URL. A
Personal credential cannot authenticate the Enterprise endpoint when distinct
scoped secrets are used. Every explicit workspace must also match the reserved
Storage path prefix, before any database access.

Run these **read-only** checks with the tunnel running:

```powershell
python scripts/sync_ingestion.py --workspace personal
python scripts/sync_ingestion.py --workspace enterprise
```

For an explicitly chosen HTTPS origin, add
`--webhook-base-url https://your-approved-host.example`. Without that option, the
script discovers exactly one local HTTPS ngrok tunnel forwarding to port 3000.
It reports readiness booleans, never Vault secret values. A nonzero exit while
bindings are missing is expected. Enterprise also reports missing prerequisites.

## Approval boundary and activation

**Stop before either `--apply` command.** Obtain explicit approval naming the
workspace, target HTTPS origin, and existing eligible document recovery. Activation
creates/enables a live Storage trigger and a live Cron schedule. It may immediately
dispatch existing eligible reservations on the next tick. In particular, Personal
activation can retry PDF `280b7f3f-89bf-48c4-8092-0d9831a6fa31` and consume a
remaining worker attempt. Do not activate Personal if that retry is not approved.
No setup flag silently changes this document's status, attempt count or due time.

After approval, and after Enterprise authorization prerequisites are reviewed and
restored, run the appropriate command separately for each project:

```powershell
python scripts/sync_ingestion.py --workspace personal --apply
python scripts/sync_ingestion.py --workspace enterprise --apply
```

One transaction updates/creates `ingestion_webhook_url` and
`ingestion_webhook_secret` in Vault, applies
`supabase/ingestion/automatic_dispatch.sql`, and commits. It configures:

| Vault name | Personal value | Enterprise value |
| --- | --- | --- |
| `ingestion_webhook_url` | `https://HOST/api/webhooks/storage?workspace=personal` | `https://HOST/api/webhooks/storage?workspace=enterprise` |
| `ingestion_webhook_secret` | Matching Personal/server shared secret | Matching Enterprise/server shared secret |

The named `storage.objects.insert` trigger is replaced rather than duplicated.
The known legacy app trigger is removed only in the selected Agentic project;
Storage internal triggers remain. The named recovery job is updated rather than
duplicated. Re-running with the same settings is supported. No historical
migrations, extension installation, data imports or broad schema repair runs.

Repeat the read-only checks after activation. If the tunnel URL changes, repeat
the approved binding update for each active project. Secret rotations require
matching app and Vault updates. The script never invokes recovery directly.

## End-to-end validation after separate approval

1. Record baseline document IDs, statuses, chunk counts and Enterprise
   classification/access-scope/publication values. Do not alter D01–D12 or the
   pending Personal PDF. Resolve Enterprise prerequisites first.
2. Upload a new tiny TXT fixture through Personal UI. Check that only Personal
   Storage receives it, the automatic event reaches `?workspace=personal`, and
   the document reaches `indexed` with chunks without a manual webhook request.
3. Replay the fixture's event while processing and after completion. Expect a
   409 or an already-indexed result, one claimed attempt, and unchanged chunk
   count. Do not replay an existing real document for this test.
4. With an authorized Enterprise uploader, reserve/upload a new fixture with a
   chosen classification and access scope. Confirm only Enterprise Storage is
   used. Storage-trigger and authenticated uploader requests may race; the lease
   prevents duplicate workers. If the uploader sees 409, wait for indexing, then
   retry its authorized publication action without re-uploading. Recovered
   indexing alone must not make an unpublished policy visible.
5. Verify an unauthorized employee cannot reserve or publish the fixture, and
   cannot retrieve restricted/out-of-department chunks. Verify a Personal token
   and Personal webhook secret cannot cross into Enterprise.
6. In a disposable staging environment, simulate a transient Gemini failure,
   exhausted operation retries, an interrupted worker and an expired lease.
   Confirm document backoff, recovery dispatch and the three-claim terminal limit.
   Do not inject failures into the live corpus or spend the pending PDF's budget.
7. In staging, stop the tunnel for a fixture upload, restart it and restore the
   approved binding. Confirm missing/failed delivery consumes no claim, then
   recovery delivers after cooldown. Repeat with an invalid webhook secret and
   repair it; inspect only status/error metadata from `net._http_response`,
   never queued request headers or Vault values.
8. Recheck Personal isolation and the D01–D12 baseline. No existing chunk,
   classification, access scope, publication flag or authorization policy should
   change during configuration. Do not delete test records without approval.

## Repository checks and SQL validation

```powershell
python -m unittest discover -s scripts -p test_sync_ingestion.py -v
pnpm exec tsx --test tests/automatic-ingestion.test.ts tests/ingestion.test.ts tests/gemini-ingestion-retry.test.ts
pnpm typecheck
pnpm lint
pnpm test
```

`supabase/tests/ingestion_recovery.sql` is an integration test for an **empty,
disposable** Supabase database with recovery migrations and the operational SQL
applied. It refuses populated documents tables. Its fixture data and queued HTTP
requests roll back, covering automatic dispatch, leases, retry limits, stale
workers, atomic replacement, lost delivery and recovery cooldown. Never run it
on either Agentic project or either Classic project. Real pg_net workers, Vault
encryption, Cron scheduling, concurrent database sessions and tunnel delivery
still require the separately approved staging validation above.

For repeatable isolated SQL checks without Docker or a Supabase connection,
install the optional test runtimes into the ignored cache (no application
dependencies or lockfiles change):

```powershell
npm install --prefix node_modules/.cache/ingestion-sql-runtime --no-save --package-lock=false --ignore-scripts @electric-sql/pglite@0.5.17 @electric-sql/pglite-pgvector@0.0.18
pnpm exec tsx scripts/test_ingestion_dispatch.mjs
```

This runs the repository recovery assertions with real PostgreSQL/pgvector and
test adapters for Vault, Cron and pg_net. It also checks repeated setup, both
workspace URLs, initial queue failure, and recovery after lost delivery. It never
loads application credentials, opens an HTTP connection, schedules a real job or
connects to a Supabase database. Do not interpret this as hosted-extension or
network-delivery validation.

References: [pg_net asynchronous HTTP](https://supabase.com/docs/guides/database/extensions/pg_net),
[Vault](https://supabase.com/docs/guides/database/vault),
[Cron](https://supabase.com/docs/guides/cron).
