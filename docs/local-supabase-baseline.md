# Disposable Supabase baseline completion report

Date: 2026-11-07. **The local PostgreSQL baseline was built and validated.**
Windows CLI transport and CLI migration-ledger recording remain unresolved.
This report supersedes the earlier missing-audit inspection blocker.

Final preservation hashes found exactly the nine new local-baseline files and
this updated report; no other existing file changed or was deleted. The
pre-existing tracked diff remained 33 files, 3,026 insertions and 3,125 deletions.
Graph refresh was attempted but **BLOCKED** by graphify's stale Python executable
path; no graph outputs were changed. Runtime configuration was confirmed ignored.

## Evidence and reconstruction boundary

Source: `docs/hosted_supabase_schema_audit_2026-11-07.md`, supplied by the user.
It records current hosted metadata, not exact historical CREATE TABLE statements.
The fixture is explicitly catalog-derived: retained catalog definitions form the
prerequisite schema, while objects added by the four existing upgrade migrations
are omitted until those files replay. Unknown historical grants are not claimed;
the prerequisite uses a least-privilege local starting set, and the final grants
are checked against the audit. No hosted query or write occurred in this task.

The two supplied function bodies (`check_project_document_limit` and
`match_chunks_hybrid_rrf`) were copied verbatim. The eight other identified public
functions are supplied by the existing migrations. No fake Auth, Storage, Cron,
Vault, HTTP or vector objects were used.

## Repository state and files

The initial tree already had 33 modified tracked files and substantial untracked
application, Supabase, test and documentation files. Existing changes, the A1
persistence fix, root Supabase configuration, manifests, lockfiles and all four
production migration files were preserved.

Added under `supabase/local-baseline/`: `.gitignore`, `README.md`, `config.toml`,
`prerequisite.sql`, `expected-catalog.json`, `bridge.cjs`, `replay.ps1`, `check.ps1`
and `validate.sql`. This report was updated. Runtime state is ignored by Git.
Final file-preservation checks and Git status are reported in the chat completion.

## Workspace and object dependency map

Workspace: `G:\AI Tools and Resources\RAG\rag-knowledge-assistant\supabase\local-baseline\runtime`.
Project: `rag-baseline-20261107-01a1b3be`; API port 57431, database port 57432.
No application environment files, remote link state, real records or Vault
secrets were copied. CLI home is contained in the ignored runtime directory.

| Order | Dependencies | Objects supplied |
| --- | --- | --- |
| Real Supabase platform | Docker and PostgreSQL 17 | Real Auth/Storage schemas, roles, helper functions and platform triggers |
| Catalog-derived prerequisite | Platform schemas; audited retained definitions | Four original application tables, audited indexes/constraints/permissive policies, legacy quota function/trigger, exact RRF function, synthetic private documents bucket |
| Hardening migration | Prerequisite tables and RPC | Feedback, reservation/lease columns, ownership boundaries, operation policies/grants, quota/ingestion/cleanup functions and triggers |
| Recovery migration | Hardening; real Cron/Vault/pg_net | Four retry/recovery columns, recovery index, fenced worker functions and every-minute Cron job |
| Webhook migration | Prior objects and Storage | Actual dispatch function/trigger and conditional document Realtime publication |
| Cleanup-execution migration | Cleanup functions | Revokes direct cleanup function execution from public/anonymous/authenticated clients |

## Migration replay and history

All four files were copied byte-for-byte, SHA-256 checked and applied in original
order using psql inside the verified container as its local administrative role.
No application/client privileges were broadened to make replay work.

| Local filename/version | Recorded hosted version | SQL replay |
| --- | --- | --- |
| `202610280001_harden_access_and_ingestion.sql` | 20261104093632 | PASSED |
| `202611040001_automatic_ingestion_recovery.sql` | 20261104093711 | PASSED |
| `202611040002_align_storage_webhook.sql` | 20261104093923 | PASSED |
| `20261104094738_restrict_cleanup_trigger_execution.sql` | 20261104094738 | PASSED |

Per-file results and hashes are recorded in `runtime/migration-manifest.json`.
The prerequisite is not represented as a historical production migration.

**FAILED:** a normal local CLI `migration up` could not alter administratively
owned application/Storage objects; it applied no migration. Administrative SQL
replay then succeeded. A subsequent supported local-only CLI history-recording
attempt failed during connection establishment. The local CLI ledger remains
empty; the manifest records the four actual successful replays. No hosted history
was repaired, and no local migration was renamed. CLI `migration up` must not be
used to replay this already-initialized fixture.

## Local versus recorded hosted metadata

| Table | Columns | Constraints | Indexes | Policies | RLS |
| --- | --- | --- | --- | --- | --- |
| projects | 5 | 2 | 2 | 3 | Enabled |
| documents | 12 | 4 | 4 | 4 | Enabled |
| document_chunks | 8 | 3 | 5 | 3 | Enabled |
| interactions | 13 | 4 | 3 | 4 | Enabled |

**PASSED:** all 38 column names/order/types/nullability/defaults/generation
expressions; 13 constraints; 14 indexes including HNSW cosine (m=32,
ef_construction=128) and GIN; 14 policy names/roles/commands/composition/predicates;
six cascading foreign keys; required functions and application/managed triggers.
CHECK predicates were compared using PostgreSQL's parsed expression rather than
its additional display parentheses. No schema was changed to satisfy formatting.
`interactions.user_id` is UUID NOT NULL and `feedback` is nullable JSONB.

| Table | Anonymous CRUD | Authenticated | Service-role CRUD |
| --- | --- | --- | --- |
| projects | None | SELECT, INSERT, UPDATE, DELETE | Preserved |
| documents | None | SELECT, DELETE | Preserved |
| document_chunks | None | SELECT | Preserved |
| interactions | None | SELECT, UPDATE(feedback) only | Preserved |

**PASSED:** effective table/column privileges and restricted privileged-RPC
execution. The broad interaction `owner_read` and `owner_feedback_update`
policies remain exactly as audited; this task does not harden them.

PostgreSQL is **17.11**. All six extension versions match the supplied audit:
vector 0.8.2, pg_cron 1.6.4, pg_net 0.20.4, pgcrypto 1.3, uuid-ossp 1.1,
supabase_vault 0.3.1. Platform service-version equivalence and omitted hosted
Storage policy definitions were not established by the supplied metadata.

## Isolation and executed validation

**PASSED:** five dedicated containers, each attached only to the labelled
internal network `rag-baseline-20261107-01a1b3be-internal`. That network has no
external gateway. Node's test bridge binds only Windows loopback and forwards
through the local Docker named pipe to fixed internal services.

**PASSED:** Cron scheduling persistently disabled before migration replay;
pg_net installed but its background worker disabled by the local preload list.
Final evidence: zero pg_net workers, Cron executions, queued HTTP requests, HTTP
responses, Vault secrets and Auth users. No external webhook dispatch occurred.
Docker image downloads were infrastructure setup, not runtime webhook requests.

**PASSED:** actual PostgreSQL synthetic 1536-dimensional vector storage, generated
simple-dictionary FTS, execution of the exact RRF function, authenticated owner
feedback update, protected-column UPDATE denial, ordinary client INSERT/DELETE
denial and anonymous SELECT denial. Catalog checks additionally cover every
protected interaction column's UPDATE privilege. All synthetic users/projects/
documents/chunks/interactions and feedback changes rolled back.

**PASSED:** the replay guard rejects an existing application database before
settings/schema/migration writes. PowerShell and Node syntax checks were run.
**PASSED:** `pnpm run typecheck` (exit 0), `pnpm test` (101 passed, 0 failed,
skipped or cancelled). A1, authentication and feedback application code unchanged.

**NOT TESTED:** full S1-P3/T1 inconsistent-ownership matrix, live feedback HTTP
compatibility, browser behavior and real-user use. The application tests use
mocked service boundaries; the baseline SQL checks use real PostgreSQL. Old
simplified SQL fixtures omit required ownership/vector fields and were inspected,
not silently modified or claimed compatible with the full schema.

## Resolved setup failures and remaining risks

Initial Windows CLI startup attempts timed out because internal Docker network
ports were not reachable from Windows. A loopback-only Docker-exec/nc bridge
allowed the CLI to complete initialization and start real platform services.
Raw authenticated SELECT 1 through the bridge passed, but CLI queries/history
commands remain intermittent. This limitation is not marked as a passed CLI test.

An initial local worker-disable restart failed because the preload list was
quoted as a single library; only that disposable setting and runner were
corrected. An initial administrative-ownership mismatch prevented CLI SQL replay;
only empty tables created by this task were reset before the final successful
administrative replay. Neither failure affected hosted resources or existing
repository migrations. Subsequent catalog/synthetic checks passed.

Exact historical pre-hardening DDL, unspecified hosted ownership/grants outside
the supplied metadata, and complete managed-schema parity are not claimed.
The resulting application catalog matches the recorded metadata. This database
is suitable for direct local PostgreSQL checks; reliable Windows CLI-ledger and
HTTP-client transport remain unresolved before claiming full T1 tool readiness.

## Rollback / cleanup / stopping point

Fixture data already rolled back. The isolated local schema and stack remain
available for review; Cron and the HTTP worker stay disabled. See
`supabase/local-baseline/README.md` for exact project-scoped stop/disposal commands.
Use only the dedicated project ID and verified local engine. Never stop/reset all
projects or delete the repository's original Supabase directory.

No hosted Supabase access, production data, production credentials, S1-P3 policy
changes, deployment, commits, pushes or merges occurred. Existing deployment
restrictions remain in force. Work stops at local baseline preparation.
