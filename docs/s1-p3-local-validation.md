# S1-P3 local implementation and T1 security validation

Date: 2026-11-07. S1-P3 was applied only to the existing disposable PostgreSQL
instance. **All twelve real-role T1 cases passed.** Live application-to-database
feedback integration remains blocked; no complete end-to-end sign-off is claimed.

## Preflight and boundaries

**PASSED:** inspected the baseline report, operational guide, hosted metadata
artifact, active Supabase configuration, existing migrations/tests, A1 chat
persistence, F1 feedback handler and server client. Initial Git status and file
SHA-256 hashes were recorded without changing existing files.

The original four migration hashes still match the validated baseline. No
bootstrap rebuild, old migration-chain replay, networking change, container
restart, ledger repair, remote command or hosted query/write occurred.

**PASSED:** positively identified local Docker Desktop through
`npipe:////./pipe/dockerDesktopLinuxEngine`, project
`rag-baseline-20261107-01a1b3be`, container prefix `75936f11d849`, internal network
`rag-baseline-20261107-01a1b3be-internal`, and PostgreSQL 17.11 database `postgres`.
The database system identifier was `7705292890393960481`. All five containers
belong to that project and have only the verified internal network. Link-state
files were absent. SQL used psql inside this verified container as its documented
administrative role; no environment-derived database URL or password was used.

**PASSED:** all four tables, original RLS/privilege baseline, disabled Cron and
pg_net, empty CLI ledger and absence of fixture/application rows, users, Vault
secrets, queued requests, HTTP responses and Cron runs were verified. The existing
`check.ps1` passed before S1-P3, including its real PostgreSQL baseline assertions.

The existing operational restoration/disposal instructions were read, but no
rebuild/disposal was performed. Exact pre-change policy DDL was additionally
captured before policy writes. Forward migration plus that restoration SQL were
executed inside one rolled-back transaction, proving exact policy restoration
and preservation of the full baseline before S1-P3 was committed.

## Migration and policy changes

Created using the project-local CLI after `migration new --help`:

`supabase/migrations/20261107054356_s1_p3_interactions_owner_policies.sql`

SHA-256:

```text
01A702832D8845F2945E2F9342A7045C902AF5639C08989A4F898DC91489B350
```

**PASSED:** transactional application through the guarded local administrative
connection. Only this new migration was applied. Its preconditions reject an
unexpected policy inventory or broader client grants; idempotency is not assumed.

| Interaction policy | Before | After |
| --- | --- | --- |
| Interactions tenant isolation policy | PERMISSIVE ALL, PUBLIC, interaction user ownership | Removed; no permissive ALL/INSERT/DELETE remains |
| owner_read | PERMISSIVE SELECT, authenticated, TRUE | Recreated with interaction user AND project ownership |
| owner_feedback_update | PERMISSIVE UPDATE, authenticated, TRUE/TRUE | Recreated with both ownership checks in USING and WITH CHECK |
| owner_boundary | RESTRICTIVE ALL, PUBLIC, project ownership in both checks | Preserved exactly |

The new permissive predicates require `interactions.user_id = auth.uid()` AND
an existing associated project whose `user_id = auth.uid()`. The independent
restrictive policy still applies. Final inventory: three interaction policies,
two permissive operation policies and the original restrictive boundary.

**PASSED:** before/after catalog comparison proved the boundary, every other
policy, all public/Storage table and column ACLs, table/index/constraint/trigger/
function schema fingerprint, role flags, database identity and ledger count
unchanged. No other RLS policy was broadened.

## Privileges before and after

| Role | Before | After |
| --- | --- | --- |
| anon | No interaction SELECT/INSERT/UPDATE/DELETE or feedback UPDATE | Unchanged |
| authenticated | SELECT; UPDATE(feedback) only; no table-wide UPDATE, INSERT or DELETE | Unchanged; rows must satisfy the new RLS checks |
| service_role | Existing server CRUD privileges and BYPASSRLS capability | Unchanged |

No GRANT or REVOKE occurs in the new migration. Effective privileges and all
protected interaction columns were tested, not merely inferred from its text.

## T1 executed matrix

Synthetic users A/B, projects A1/A2 owned by A and B1 owned by B, three consistent
interactions and both mismatched ownership combinations were used. No production
data was used. Each client block verified current_user, auth.uid(), JWT subject
and role claims, row_security, absence of SUPERUSER/BYPASSRLS and inherited table
ownership, and effective SQL privileges. Client tests used actual authenticated
or anon roles, never the fixture administrator.

| ID | Executed test | Observed result | Status |
| --- | --- | --- | --- |
| T01 | A reads A's interaction | One row | PASSED |
| T02 | A reads A's interactions across A1/A2 | Two rows | PASSED |
| T03 | A reads B's interaction in B1 | Zero rows | PASSED |
| T04 | B reads A's interaction | Zero rows | PASSED |
| T05 | A reads B-owned interaction in A1 | Zero rows | PASSED |
| T06 | B reads B-owned interaction in A1 | Zero rows | PASSED |
| T07 | A updates A's feedback | One row, exact JSONB stored | PASSED |
| T08 | B updates B's feedback | One row, exact JSONB stored | PASSED |
| T09 | A updates B's feedback in B1 | Zero rows | PASSED |
| T10 | Both users update both mismatch combinations | All four attempts affect zero rows | PASSED |
| T11 | Protected-column UPDATE, client INSERT and DELETE | SQLSTATE 42501 for every operation | PASSED |
| T12 | Anonymous SELECT and feedback UPDATE | SQLSTATE 42501 for both operations | PASSED |

Before S1-P3, this same regression suite passed T01/T02/T03 and **failed T05 as
expected**, reproducing the existing disclosure. That fixture transaction rolled
back. After S1-P3 all twelve passed.

**PASSED:** administrator comparisons verified exact allowed JSONB values, every
other column unchanged, and denied targets unchanged. All twelve non-feedback
columns were individually checked for absent UPDATE privilege and attempted
same-value UPDATE denial.

**PASSED:** resulting-row WITH CHECK was exercised separately for a changed user
and a changed project. An uncommitted test trigger changed NEW during an otherwise
permitted feedback-only UPDATE. Both attempts raised 42501 and retained the
original data. No protected-column grant was added. This test trigger/function
and every fixture disappeared with transaction rollback.

**PASSED — server telemetry capability:** the effective service_role, with its
existing bypass capability and no authenticated-user claim, inserted synthetic
telemetry containing an explicit valid user_id. This proves the existing server
insertion capability remains; it is not an end-to-end chat/authentication test.
Existing A1 chat regressions also passed and application code was unchanged.

## Application regression and integration limits

| Command/check | Result |
| --- | --- |
| Focused feedback/authorization/chat suite | PASSED: 44 tests |
| pnpm run typecheck | PASSED: exit 0 |
| pnpm test | PASSED: 112 tests, zero failed/cancelled/skipped |
| Focused ESLint on new feedback test plus chat/feedback/server client | PASSED: no issues |
| Guarded execution support PowerShell syntax | PASSED |
| Real local authenticated feedback HTTP request | BLOCKED |
| Browser-level feedback integration | NOT TESTED |

The ten new mocked feedback cases cover both owners, cross-user/mismatch-hidden
interactions, unknown IDs, project ownership failure, authentication failure,
zero-row updates, database failure and invalid input. They assert caller-scoped
credentials, feedback-only PATCH data, no false success, and the existing JSONB
payload/response contract. No request reaches a real service in these tests.

The existing F1 handler selects/checks the updated interaction ID internally;
its actual JSON response remains `{ success, feedback }`. That current behavior
was preserved rather than changing it to match an imprecise prose description.

Both existing application environment files target non-local Supabase. No URL,
key or token was logged or used for a live request. The application was not
redirected, and the Windows connection/network was not modified or debugged.
Therefore real app-to-hardened-database HTTP/browser compatibility is unverified.
SQL plus mocked handler tests are not represented as end-to-end validation.

## Original G1-G7 definitions and results

Definitions were located in the earlier S1-P3/T1 task attachment, section 12;
they are retained here. No overall seven-gate or production sign-off is claimed.

| Gate | Original definition | Status and evidence |
| --- | --- | --- |
| G1 Environment isolation | All database writes and tests occurred in a verified disposable local environment | PASSED: positively identified container/system/network; no hosted connection |
| G2 Policy integrity | Explicit owner-scoped SELECT and UPDATE policies are installed and the restrictive project boundary remains | PASSED: installed definitions, truth-table cases and exact boundary comparison |
| G3 Privileges | Anonymous access is denied; client INSERT/DELETE remain denied; authenticated UPDATE remains limited to feedback | PASSED: real-role permission failures, column checks and identical ACLs |
| G4 Cross-tenant security | Every negative authorization test passes, including deliberately inconsistent ownership records | PASSED: all T1 negatives plus resulting-row violations |
| G5 Feedback compatibility | Existing authenticated feedback behavior is preserved | BLOCKED for complete integration sign-off: SQL and mocked handler checks passed; live app-to-local-schema HTTP could not be tested safely |
| G6 Application regression | Existing applicable TypeScript, lint, and application tests pass | PASSED: typecheck, focused lint, 44 focused and 112 full tests |
| G7 Change control | Only approved files were modified; migration and rollback implications are documented | PASSED: new scoped files only, original source/migration hashes preserved, restoration rehearsed |

## Files and operational evidence

New source files only:

- `supabase/migrations/20261107054356_s1_p3_interactions_owner_policies.sql`
- `supabase/tests/s1_p3_interactions.sql`
- `supabase/tests/s1_p3_restore_baseline.sql`
- `supabase/local-baseline/s1-p3.ps1`
- `tests/feedback-route.test.ts`
- `docs/s1-p3-local-validation.md`

Ignored runtime evidence contains `s1-p3-before.json`, `s1-p3-after.json`, and
`s1-p3-applied.json` with the migration hash/result. Initial existing changes were
preserved. Final preservation hashes found exactly these six new files, no
existing file modifications and no deletions. Their Git status is untracked;
nothing was staged or committed. The pre-existing tracked diff remains 33 files,
3,026 insertions and 3,125 deletions. `git diff --check`, scoped whitespace checks
and the report-to-migration hash assertion passed. Graph refresh was attempted
but is BLOCKED by graphify's pre-existing stale Python executable path; no graph
outputs were changed or tooling repaired.

The CLI ledger was zero before and after. No migration up/reset/push/pull/repair
was attempted. Only CLI migration-new help and file creation were used. The
previous local/hosted version differences remain untouched.

Final assertions: zero Auth users, projects/documents/chunks/interactions, Vault
secrets, HTTP queue entries/responses and Cron runs; Cron remains off and no
pg_net worker runs. No synthetic records or permanent test triggers remain.

## Rollback and review boundary

The captured restoration file recreates the exact three original permissive
interaction policies without changing owner_boundary or any grants. It is
local-test-only, requires the guarded marker and expected inventory, and **would
reintroduce the known pre-S1 exposure**. Its full DDL was rehearsed inside a
rolled-back transaction before the committed migration. Actual committed rollback
was not performed; the final local database remains hardened.

If a reviewed local rollback is needed, reuse the same guarded administrative
connection and captured restoration SQL. One explicit PowerShell procedure is:

```powershell
. './supabase/local-baseline/s1-p3.ps1' -Action Verify
Invoke-LocalSql (Get-Content -LiteralPath './supabase/tests/s1_p3_restore_baseline.sql' -Raw)
```

These are documented rollback commands, not commands executed after validation.
Do not rebuild/reset the baseline, repair the ledger, run the old migration chain,
apply this restoration to hosted Supabase, or overwrite the preflight snapshot.
Before-policy baseline validators expect the old four-policy inventory and must
not be mistaken for post-S1 validators. For the hardened state, use the guarded
Test and Verify actions; the restoration rehearsal is for the original baseline.

Remaining production-review blockers: G5 live integration, hosted-history
reconciliation/review outside this task, and explicit hosted/deployment approval.
The prior Windows CLI transport limitation remains untouched. No hosted query or
write, ngrok exposure, real-user test, deployment, commit, push, merge or next
implementation phase occurred. Work stops at local S1-P3/T1 review.
