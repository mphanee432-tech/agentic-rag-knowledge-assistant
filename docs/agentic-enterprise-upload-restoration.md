# Agentic Enterprise upload/publication restoration

## Scope and evidence

Prepared for review on 21 November 2026; no live SQL changes were applied.
Target only `agentic-enterprise-rag`, ref `ldkxyleqfbovqpkpoyek`.

Read-only inspection of the original Enterprise v1 project `rag-wp2a-test`
(`cpowlkptvtnkjkulveph`) recovered the hosted definitions of
`can_upload_enterprise_policy`, `reserve_enterprise_policy`, its lower-level
`reserve_enterprise_document` dependency, and `publish_enterprise_document`.
The WP6 repository migration supplies the organization/department reservation
contract, but relies on hosted functions absent from the clone.

The original upload gate requires an active organization membership, a
`manager`/`cxo` role, and the original designated uploader identity. The restoration
retains all three; it does not allow arbitrary managers to upload. As in v1, that
designated uploader can choose departments within their authorized organization.
This does not grant department-level document read access or grant-approval rights.

The Agentic clone has different policies from the older WP2A replay: users have
read-only membership/department/project access, documents use
`wp3_private.can_read_document`, and grants/memberships permit no caller writes.
Expiry values may be null. The proposed migration leaves that schema, its RLS
policies, and its access-window/read predicates intact.

Two additional existing UI dependencies were also incomplete: the clone's
`enterprise_copilot_context` returned a constant false, and
`enterprise_policy_departments` was absent. They now use the same restored upload
decision, without broadening membership visibility.

## Reviewable migration

`supabase/migrations/20261121122157_restore_agentic_enterprise_upload_contracts.sql`
contains one transaction:

- Checks that Enterprise RLS is enabled and authority tables are not writable by
  `anon` or `authenticated`; an unexpected baseline aborts the transaction.
- Creates the three public RPCs as security-invoker entry points, with their
  privileged implementations in the existing `wp3_private` schema. All function
  references are schema qualified and search paths are fixed.
- Restricts execution to `authenticated`. Neither PUBLIC, `anon`, nor the worker's
  `service_role` receives execution rights to the restored functions. The worker's
  existing claim/fail/finish privileges are untouched.
- Validates filenames, UUID nulls, organization/department scope, 1-byte–25-MB
  reservations, classification and access scope. Restricted/company is rejected.
- Serializes first uploads through the department row and reuses a regular
  department project, without selecting D12 projects as upload destinations.
- Holds actor membership and identity rows against concurrent revocation and
  rechecks permission before writes.
- Creates unpublished `pending_upload` reservations with canonical
  `enterprise/<project>/<document>/<filename>` paths. Duplicate document IDs fail
  with SQLSTATE 23505; existing reservations and their attempt counts are never
  overwritten or reset. Failed reservations roll back project creation too.
- Publishes only authorized, indexed documents containing correctly scoped
  chunks. Missing/foreign documents fail closed; incomplete or empty documents
  fail with SQLSTATE 55000. Authorized publication replay is idempotent.

The missing lower-level `reserve_enterprise_document` function is not needed:
the private reservation implementation performs the validated insert itself.
No alternate public write API is introduced. Publication changes only the new
document's publication flag; it creates no document grants or memberships.

The migration contains no data backfill, employee promotion, corpus modification,
Storage trigger activation, Cron schedule, recovery invocation or deployment.
`notify pgrst` only requests an API schema-cache reload after commit.

## Tests

```powershell
pnpm exec tsx scripts/test_enterprise_upload_contracts.mjs
pnpm exec tsx scripts/test_ingestion_dispatch.mjs
pnpm exec tsx --test tests/authorization-routes.test.ts tests/ingestion.test.ts tests/automatic-ingestion.test.ts
python -m unittest discover -s scripts -p test_sync_ingestion.py -v
pnpm typecheck
pnpm lint
pnpm test
```

The isolated SQL runner uses the ignored PGlite/pgvector runtime installed for the
automatic-dispatch checks. Installation instructions are in
[automatic ingestion activation](agentic-automatic-ingestion.md#repository-checks-and-sql-validation).
Its schema fixture represents the inspected Agentic clone, not the older v1 RLS
baseline. It loads the repository's real claim/fail/finish functions and retrieval
predicate, then applies the proposed migration to the local test database.

`supabase/tests/enterprise_upload_contracts.sql` uses only synthetic identities and
fixtures, refuses populated user/document tables, and rolls everything back. It
tests permitted manager/CXO behavior, employee and non-designated-manager denial,
inactivity, cross-organization/Personal denial, forged role metadata, direct
self-promotion/self-grants, invalid inputs, duplicate IDs, project reuse/rollback,
publication failures, worker completion and publication replay. Company,
department, restricted and D12 read boundaries remain enforced. The runner also
compares RLS policies and worker definitions before/after restoration.

The publication-failure route test caught an HTTP 500 publication error being
misclassified as Gemini overload. The route now classifies Gemini failures only
during extraction/embedding, reports publication failures accurately, and leaves
indexed content available for a publication retry without another ingestion claim.

Never run either SQL integration test on a hosted Agentic/v1 project. Hosted Auth,
PostgREST cache refresh and true multi-session lock/revocation races still need
separately approved disposable staging validation.

## Exact next steps and approval boundaries

1. Review this migration and its retained v1 identity gate. **Obtain approval before
   applying any live migration.** Apply only this file, in one transaction, using
   the Agentic Supabase connection and explicit project ref
   `ldkxyleqfbovqpkpoyek`. Do not run a broad `db push`: the populated clones have
   different historical baselines. Do not apply it to Personal or v1.
2. Read-only verify the three function signatures plus department/context RPCs,
   authenticated-only grants, fixed search paths and unchanged RLS. Run
   `python scripts/sync_ingestion.py --workspace enterprise --webhook-base-url https://APPROVED-HOST`
   once a management token and chosen HTTPS origin are configured. This mode
   inspects only; it does not activate dispatch.
3. **Role approval is separate.** The current sole employee record in the Agentic
   Enterprise clone has role `employee`. It will still be denied upload after
   this migration, even though it matches the designated identity. An authorized
   administrator must separately approve any manager/CXO assignment. This change
   does not perform or assume that promotion.
4. After migration and actor approval, validate a new tiny fixture through the
   Enterprise UI or caller-authenticated RPCs. Confirm an employee cannot reserve,
   publish or self-grant; an authorized uploader can reserve, index and publish;
   and a failed publication retries without re-uploading or re-indexing. Do not
   use D01–D12 or the pending Personal PDF as test fixtures.
5. Storage triggers, recovery Cron and document recovery remain **off**. Obtain
   another explicit approval before either workspace's `sync_ingestion.py --apply`
   command, following the automatic-ingestion activation guide. Personal activation
   can consume a remaining attempt for its pending PDF; this restoration never
   retries that document.

Current live baseline: D01–D12 remains 12 published/indexed documents and 96 chunks;
the restoration makes no live changes to these rows, roles or permissions.
