# Hardening validation

Implemented locally on 2026-10-28. Existing evaluation result artifacts were preserved; no live migration or benchmark was run.

## Completed checks

- TypeScript: passed.
- ESLint: no errors; 15 unused-code warnings.
- Node/TypeScript tests: 7 passed (mocked authorization, split UTF-8/SSE, incomplete/error streams, citation IDs, history/input bounds).
- Python gate tests: 8 passed (empty answers, invalid/malformed/grouped citations, transport failures, length limits, missing judge and refusals).
- Python evaluator syntax compilation: passed.
- Git whitespace check: passed.

## Build limitation

Production build failed with TurbopackInternalError while processing app/globals.css.css: the Node CSS worker exited before Turbopack connected. Reproduced with both sandbox and normal host permissions. Production compilation and browser end-to-end behavior are not certified.

## Required staging acceptance

1. Back up and inspect the deployed schema, policies and search RPC. Apply the upgrade migration transactionally in staging. It is not a bootstrap schema.
2. Verify two distinct Supabase users cannot read, change, delete, upload to, query, or submit feedback against each other's projects; verify direct anon/authenticated execution of the search and ingestion RPCs is denied.
3. Create 11 concurrent upload reservations in one empty project: exactly 10 may succeed. Delete abandoned reservations to reclaim slots.
4. Upload PDF/TXT/HTML files through the UI. Confirm actual size mismatches fail and valid files become indexed.
5. Deliver the same webhook twice concurrently: only one worker should hold the lease. Replay after indexing: no duplicate chunks.
6. Force embedding/finalization failure: no partial replacement becomes visible. Replay a failed event and reclaim an expired lease. Delete during processing and confirm the finalizer cannot recreate the record.
7. Verify citations open the correct numbered evidence, telemetry is absent from visible/copied answers and follow-up prompts, and navigation during streaming does not overwrite another workspace.
8. Run the authenticated 50-row streaming benchmark with two-user fixtures. No latency optimization or release-readiness claim should be based on historical artifacts.

The original checks above did not execute the migration and worker against a real database. Automatic ingestion recovery is now implemented in `202611040001_automatic_ingestion_recovery.sql`; see [activation and staging checks](ingestion-recovery.md). Live activation still requires applying that migration and configuring Supabase Cron/pg_net/Vault. Orphaned Storage cleanup, semantic retrieval thresholds, cost and recall gates remain separate work.

