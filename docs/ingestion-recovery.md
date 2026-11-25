# Automatic ingestion recovery

When activated, the `recover-document-ingestion` Supabase Cron job runs every minute and sends eligible documents to the existing authenticated Storage webhook. The documents table holds retry state; there is no extra queue service or app dependency.

## Activation

For the separate Agentic Personal and Enterprise clones, follow
[Agentic automatic ingestion activation](agentic-automatic-ingestion.md).
The default setup script mode is read-only and requires `--workspace personal`
or `--workspace enterprise`. Live `--apply` requires explicit approval; it can
retry existing eligible documents, including the pending Personal PDF.

Do not replay the historical hardening/recovery migrations against these populated
clones to activate delivery. Extensions and worker functions already exist.
The reviewed operational SQL configures scoped Vault URLs, Storage dispatch,
Realtime and recovery Cron without replacing authorization or worker functions.
The guide records the missing Enterprise upload/publication prerequisites and
provides both activation commands and the end-to-end validation plan.

## Recovery rules

- **Lost webhook:** a reservation with a Storage object is eligible for dispatch.
- **Worker crash:** a processing lease expires after six minutes; the next eligible worker receives a new lease.
- **Transient failure:** the worker calls a lease-fenced failure RPC. The document remains active (`uploaded`) and retries after one minute, then five minutes. Backoff applies to webhook replays too.
- **Retry limit:** at most three worker executions per document. A crash on the final attempt becomes terminal when its lease expires.
- **Invalid input:** size mismatches, unreadable PDFs, incomplete PDF sections, empty text and oversized sections stop immediately. Empty model responses and provider/storage/database errors can retry.
- **Lost scheduled HTTP request:** dispatch has its own six-minute cooldown. Delivery does not consume an execution attempt, so a hosting outage does not exhaust documents before a worker starts.
- **Abandoned upload:** after 2 hours 15 minutes without a Storage object, the reservation becomes failed and releases quota. The margin exceeds the [two-hour signed-upload lifetime](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl).
- **Successful indexing:** chunk replacement remains atomic. Stale workers cannot finalize or report failure against a newer lease. Indexed documents and terminal failures are never automatically restarted.

Each tick examines at most 25 eligible records and queues at most five requests. Dispatchers use an advisory lock; workers use atomic row leases. Work remains in the database until it succeeds or becomes terminal. Source files and document records are retained; orphaned-file deletion remains a separate operation.

## Monitoring

### Gemini operation retries

Both the Storage webhook (Personal or Enterprise workspace) and the authenticated
Enterprise ingestion route retry PDF extraction and embedding operations. The
server-only `GEMINI_INGESTION_MAX_ATTEMPTS` setting counts the initial call: default
3, supported range 1–10; invalid values fall back to 3. SDK retries are disabled so
they cannot multiply this limit. No new dependency or database migration is needed.

HTTP 429, 500, 502, 503 and 504, attempt timeouts, and recognized temporary network
error codes retry with exponential backoff and jitter (1–2 seconds, then 2–4
seconds by default). `Retry-After` seconds or HTTP dates are a minimum wait. A wait
that exceeds the remaining execution budget stops the operation instead of
retrying early. HTTP 400/401/403/404 and other permanent HTTP failures do not retry,
including at the document recovery level; correct configuration before another
upload. Generic SDK errors are not assumed to be network failures.

Each extraction attempt has at most 60 seconds; embeddings have 30 seconds. Gemini
work stops 250 seconds after route entry, within the existing 270-second processing
window, 300-second host limit, and six-minute database lease. Enterprise client
cancellation stops work; webhook sender disconnects still do not cancel a claim.
An ingestion failure cancels sibling embedding operations and their backoff.

Chunks remain in memory until all embeddings succeed. The existing
`finish_document_ingestion` RPC checks the lease and atomically replaces chunks
and sets `indexed`; this change does not retry that RPC or modify its transaction.
Indexed replays skip extraction and persistence. A transient operation exhausting
its retries uses the existing lease-fenced failure RPC and document backoff, so
operation retries do not increment `ingestion_attempts` individually.

Server logs identify the stage, HTTP status, attempt, retry delay and whether a
retry will occur. They omit provider error bodies, API keys, document text and
embedding vectors. Suggested questions remain optional and do not affect indexing.

### Retry an existing uploaded PDF without re-uploading

After starting the updated local application (or separately approving and deploying
it), use the **agentic-personal-rag** dashboard SQL editor for this read-only check:

```sql
select id, status, storage_path, ingestion_attempts,
       next_ingestion_attempt_at, lease_expires_at
from public.documents
where id = '280b7f3f-89bf-48c4-8092-0d9831a6fa31';
```

Only proceed if this is the intended project, status is `uploaded`, attempts are
below 3, and `next_ingestion_attempt_at` is non-null and due. Do not reset the
status, lease, attempt count or scheduled time. If it is already indexed, stop.
If another worker holds an active lease, wait for that worker instead.

In a trusted PowerShell terminal with the app's existing webhook secret loaded as
`SUPABASE_WEBHOOK_SECRET`, send **one** request using the returned storage path:

```powershell
$storagePath = Read-Host 'Exact storage_path from the read-only check'
if (-not $env:SUPABASE_WEBHOOK_SECRET) { throw 'Load the existing server webhook secret securely first.' }
Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:3000/api/webhooks/storage?workspace=personal' `
  -Headers @{ 'x-webhook-secret' = $env:SUPABASE_WEBHOOK_SECRET } `
  -ContentType 'application/json' `
  -Body (@{ storagePath = $storagePath } | ConvertTo-Json) -TimeoutSec 300
```

The local app must already point its Personal workspace at **agentic-personal-rag**.
Use the updated deployment URL instead of localhost only after deployment is
approved. This reuses the stored object and reservation; a successful claim uses
one remaining database attempt. A 409 consumes no attempt: recheck status and due
time, rather than looping requests. After a 500, inspect the document and logs
before consuming another attempt. This procedure enables no trigger or Cron job
and does not call the bulk recovery dispatcher.

```sql
select jobid, jobname, schedule, active
from cron.job where jobname = 'recover-document-ingestion';

select status, start_time, end_time, return_message
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'recover-document-ingestion')
order by start_time desc limit 20;

select id, status, ingestion_attempts, next_ingestion_attempt_at,
       lease_expires_at, ingestion_dispatched_at, last_ingestion_error
from public.documents
where status <> 'indexed'
order by created_at;
```

A successful Cron run means dispatch succeeded, not that indexing completed. Check document status and `net._http_response` for HTTP failures. Missing app credentials or a bad webhook secret must be corrected operationally; automatic delivery cannot repair configuration.

## Verification

```sh
pnpm exec tsx --test tests/ingestion.test.ts
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ingestion_recovery.sql
```

The SQL assertions require an **empty disposable Supabase database** with the original application schema and both migrations applied. They refuse a populated documents table. They test backoff, duplicate claims, expired leases, stale-worker fencing, terminal retries, abandoned uploads, redispatch and RPC permissions. All fixtures, Vault changes and queued HTTP requests roll back; `pg_net` sends only after commit.

In a staging deployment, also kill a worker after it claims a document and suppress one Storage webhook. Verify both index without manual replay. Deliver duplicate webhooks concurrently and confirm only one claim increments the attempt count. This verifies the live scheduler and hosting lifecycle beyond local mocked tests.

Local validation on 2026-11-04: 41 application tests passed, type checking passed, and focused lint had no errors (five existing uploader warnings). Both migrations and the recovery SQL assertions also passed in a temporary PGlite PostgreSQL runtime. That check used test adapters for Cron, Vault and HTTP dispatch, and a JSON column in place of the existing vector cast. Live extension behavior, concurrent database connections, actual vector storage and deployed webhook delivery still require the staging checks above. No application dependency was added for this temporary test runtime.

Live synchronization on 2026-11-04 applied hardening, recovery and Storage webhook
alignment to the app's configured Supabase project. Vault URL/secret equality,
active every-minute Cron, Realtime publication and the replacement INSERT trigger
were verified. A database-originated authenticated request through ngrok returned
HTTP 200, and recent Cron runs succeeded. A rolled-back live fixture verified
exclusive claims, stale-worker failure fencing and retry backoff. Both existing
indexed documents were retained. Full PDF extraction and model calls were not run
as part of this infrastructure check.

To pause recovery without deleting state:

```sql
select cron.alter_job(
  (select jobid from cron.job where jobname = 'recover-document-ingestion'), active := false
);
```

Set `active := true` to resume. Normal Storage webhooks still enforce the database retry rules while recovery is paused.
