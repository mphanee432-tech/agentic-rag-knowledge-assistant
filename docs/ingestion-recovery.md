# Automatic ingestion recovery

The `recover-document-ingestion` Supabase Cron job runs every minute and sends eligible documents to the existing authenticated Storage webhook. The documents table holds retry state; there is no extra queue service or app dependency.

## Activation

1. Apply the existing `202610280001_harden_access_and_ingestion.sql` migration first.
2. Enable **Supabase Cron (`pg_cron`)** and **`pg_net`** through the Supabase dashboard. Supabase Vault must also be available. See [Cron installation](https://supabase.com/docs/guides/cron/install) and [scheduled HTTP calls with Vault](https://supabase.com/docs/guides/functions/schedule-functions).
3. Add these two Vault secrets using the dashboard:
   - `ingestion_webhook_url`: the full HTTPS URL ending in `/api/webhooks/storage`, with no query string or trailing slash.
   - `ingestion_webhook_secret`: the same value as the app's server-only `SUPABASE_WEBHOOK_SECRET`.
4. Apply `supabase/migrations/202611040001_automatic_ingestion_recovery.sql` and deploy the updated application together. The migration installs the recurring job. A missing extension causes migration failure; missing Vault configuration is reported as a failed Cron run instead of silently disabling recovery.
5. Confirm the job is active and run the staging checks below. The host must support the existing 300-second webhook duration. The scheduled HTTP request uses the same timeout; expired leases recover interrupted requests.

No secrets belong in source control, frontend configuration or Cron SQL text. The job reads Vault on each run, so rotate the Vault value and app environment together.

For local Next.js plus ngrok, apply `202611040002_align_storage_webhook.sql` too.
It replaces the legacy `rag_knowledge_assistant` webhook with `storage.objects.insert`;
both initial delivery and recovery read the same Vault URL and secret on every call.
It also adds `public.documents` to the existing Realtime publication when necessary.
Keep signed binary uploads (`uploadToSignedUrl`); direct browser `.upload()` is
blocked by the ownership hardening. The browser never invokes the worker webhook.

To refresh bindings after restarting ngrok, put a Supabase management access token
in the local environment as `SUPABASE_ACCESS_TOKEN` (not the service-role key), then run:

```sh
python scripts/sync_ingestion.py --apply
python scripts/sync_ingestion.py
```

The script discovers the unique HTTPS tunnel forwarding to port 3000, applies
missing prerequisites, updates Vault, activates Cron and reports only match booleans.
Read-only mode verifies bindings without changing them. It uses `.env.local` before
`.env`. Do not print or commit the token or webhook secret. Next.js serves application
changes locally; SQL migrations go to Supabase. A later tunnel URL requires another
binding update. If the app secret changes, restart/reload the dev runtime as well.

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
