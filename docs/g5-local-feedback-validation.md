# G5 local feedback HTTP integration validation

Date: 2026-11-07. **G5: PASSED.** All G5-H01 through G5-H10 cases were executed
against real local services. Fourteen feedback HTTP requests and the aggregate
persistence check passed. This report supersedes the earlier G5 Auth/HTTP blocker
and the live-integration limitation in the prior S1-P3 report. No hosted or
production sign-off is implied.

## Initial state and isolation — PASSED

Initial Git status and SHA-256 hashes of existing nonignored files, plus `.env`
and `.env.local`, were recorded before recovery. Existing uncommitted changes
were retained. The guarded `s1-p3.ps1 -Action Verify` passed before recovery,
before each integration attempt and after fixture cleanup.

| Identity/control | Verified state |
| --- | --- |
| Docker endpoint | Local named pipe `npipe:////./pipe/dockerDesktopLinuxEngine` |
| Disposable project | `rag-baseline-20261107-01a1b3be` |
| Database container | `supabase_db_rag-baseline-20261107-01a1b3be`; original container preserved |
| PostgreSQL | 17.11, database `postgres` |
| Database system identifier | `7705292890393960481`, unchanged |
| Network | `rag-baseline-20261107-01a1b3be-internal`; internal, ownership label `rag.local-baseline=20261107-01a1b3be` |
| Containers | Five dedicated running services; each on only that internal network |
| Cron / pg_net | Cron off, pg_net excluded from preload and zero workers |
| Outbound dispatch / Vault | Zero queued HTTP requests, responses, Cron runs and Vault secrets |
| CLI ledger | Zero entries, unchanged |

SQL administration used psql inside the positively identified database container,
connecting to its own loopback as `supabase_admin`. No environment-derived
database URL/password was used. No database container, schema, policy or migration
was rebuilt, reapplied or repaired. The final five-service environment differs
only in the replacement Auth container and its enabled email provider.

## Auth diagnosis and correction — PASSED

The repository-root `supabase/config.toml` already enabled email authentication.
The independent disposable baseline used its own local configuration, whose
`[auth.email] enabled = false` produced the running Auth service's
`GOTRUE_EXTERNAL_EMAIL_ENABLED=false`. The earlier genuine password request
returned 422 `email_provider_disabled`; global signup alone could not fix it.

| Local setting | Before | After |
| --- | --- | --- |
| `GOTRUE_EXTERNAL_EMAIL_ENABLED` | false | true |
| `GOTRUE_DISABLE_SIGNUP` | false | false, preserved |
| `GOTRUE_MAILER_AUTOCONFIRM` | true | true, preserved |
| Phone / anonymous authentication | disabled | disabled, preserved |
| Other Auth environment values | Existing local values | Preserved exactly, including local signing/database configuration |
| Auth image | GoTrue v2.197.0 | Same image |
| Auth network/IP/alias | Internal network, `172.18.0.4`, alias `auth` | Preserved |

Only Auth was recreated using the local Docker Engine API. The original stopped
container was retained until the replacement passed health verification, then
removed. PostgreSQL, Storage, PostgREST and Kong were not recreated or restarted.
The single provider-setting change was also preserved in
`supabase/local-baseline/config.toml` and the ignored runtime configuration.
Root Supabase/application configuration was not changed. No SMTP service,
external email credentials, OAuth or custom JWT authentication was introduced.

**Executed login evidence:** two synthetic users were created through the real
local Auth administrative interface. Both then used `signInWithPassword`, the
same mechanism as `app/login/page.tsx`. The installed `@supabase/ssr` browser
client generated genuine scoped base64url/chunked session cookies, and Auth
`getUser()` verified each user's identity. Service logs confirmed HTTP 200 for
password `/token` and session `/user` requests. No user JWT was forged. The
administrative credential was restricted to fixture administration; Next.js
received only the local anonymous key and authenticated through session cookies.

## Loopback transport diagnosis and verification — PASSED

Targets remained fixed IPv4 loopback: API `127.0.0.1:57431` and database bridge
`127.0.0.1:57432`. No hostname/IPv6 selection was needed and the probe process
had no HTTP/HTTPS/ALL proxy, NO_PROXY or NODE_USE_ENV_PROXY variable set.

Initial native-fetch attempts intermittently timed out while internal Auth and
PostgREST health checks succeeded. The existing bridge prepared an idle API
netcat connection before a client arrived. API transport now opens on each
incoming connection, avoiding reuse of a preconnected HTTP socket. Idle expiry
was an inference from that behavior, not a packet-capture finding. The existing
warm PostgreSQL transport was preserved; no network topology or exposure changed.

| Layer | Actual evidence | Status |
| --- | --- | --- |
| TCP | Native TCP connection to `127.0.0.1:57431` succeeded | PASSED |
| Internal Auth | `/health` 200, `/settings` 200 with `external.email: true` | PASSED |
| Internal PostgREST | Real PostgREST 16.5 OpenAPI endpoint returned 200 | PASSED |
| Native fetch after repair | Five consecutive Auth health requests returned 200 | PASSED |
| Repeated Auth/API checks | Three Auth health and three PostgREST requests per integration attempt returned 200 | PASSED |
| Supabase SDK | Real admin create, password login, getUser, logout and delete requests succeeded | PASSED |
| Next.js HTTP | Fourteen real feedback requests returned the expected observed codes below | PASSED |

Sanitized Auth logs establish that SDK and authenticated route requests reached
the actual container. Next.js logs establish that requests reached the actual
feedback route. PostgreSQL snapshots establish the resulting operations.

## Isolated Next.js process and actual session path — PASSED

The final server ran Next.js 16.4.2 with Webpack on **127.0.0.1:52687**. A native
TCP connection succeeded and `netstat` showed only loopback for that test port.
Windows CIM `Get-NetTCPConnection` did not expose that listener; its failed lookup
is not claimed as a passed check. TCP and netstat supplied independent evidence.

The runner copied the existing application into a new ignored runtime directory,
without environment files, and verified byte identity of the feedback route,
Auth helper, server Supabase client and proxy. It launched the actual Next.js
CLI/router with that mirror; it did not call the route function directly.
This kept generated Next.js/TypeScript files out of the working application.

The child received an OS-variable allowlist, the fixed local Supabase URL, local
anonymous key, development mode and disabled telemetry. No hosted URL, service
key, application `.env` value or external AI credential was supplied. The fresh
mirror had no `.env*` files or inherited application configuration to fall back
to. Only `/api/feedback` was exercised; no ingestion, embedding or generation
endpoint was invoked. The existing development server on port 3000 was preserved.

The HTTP client sent only the real SSR session cookies for authenticated cases;
no Authorization header or injected user-ID header bypassed authentication.
The unchanged `requireUser` called real Auth, followed by the existing
interaction lookup, project authorization and feedback-only update through the
authenticated Supabase client. Existing proxy matching was preserved.
PostgreSQL RLS, restrictive `owner_boundary`, role flags and column grants remained
enabled and unchanged throughout. Prior T1 cases were not repeated.

## G5-H01 through G5-H10 — PASSED

| Case | Executed request/check | Observed HTTP result | Database evidence | Status |
| --- | --- | --- | --- | --- |
| G5-H01 | A submits valid feedback on A's interaction | 200, `{ success, feedback }` | Exact returned JSONB persisted; all other fields/rows unchanged | PASSED |
| G5-H02 | B submits valid feedback on B's interaction | 200, same contract | Exact B JSONB persisted; A unchanged | PASSED |
| G5-H03 | A attempts B's interaction | 404 | Full snapshot unchanged | PASSED |
| G5-H04 | B attempts A's interaction | 404 | Full snapshot unchanged | PASSED |
| G5-H05 | No authentication cookies | 401 | Full snapshot unchanged | PASSED |
| G5-H06 | Genuine cookie structure with tampered invalid session token | 401 | Full snapshot unchanged; real Auth rejected token | PASSED |
| G5-H07 | Nonexistent valid UUID; nonstring identifier | 404; 400 | Both full snapshots unchanged | PASSED |
| G5-H08 | Invalid rating; comment 2001 chars; issue tag 101 chars; nonstring comment/tag | Five responses, all 400 | Every full snapshot unchanged | PASSED |
| G5-H09 | A replaces earlier feedback | 200 | Replacement JSONB exact; B/protected fields unchanged; two interactions retained | PASSED |
| G5-H10 | Aggregate response/persistence/denial comparison | Covers all fourteen requests | Full project/interaction snapshots matched only the permitted feedback changes | PASSED |

Observed rejection bodies were exactly:

```json
{"error":"Interaction not found."}
{"error":"Sign in to continue."}
{"error":"Invalid feedback."}
```

An actual G5-H01 success response was:

```json
{
  "success": true,
  "feedback": {
    "rating": "thumbs_up",
    "issue_tag": "g5",
    "comment": "Synthetic feedback A",
    "updated_at": "2026-11-07T10:23:39.159Z"
  }
}
```

G5-H02 stored `thumbs_down`, null issue tag, `Synthetic feedback B`, timestamp
`2026-11-07T10:23:53.132Z`. G5-H09 replaced A with `thumbs_down`, issue tag
`replacement`, `Replacement feedback A`, timestamp `2026-11-07T10:26:08.006Z`.
Each returned object was compared exactly with the persisted JSONB. Every other
interaction column and both project rows were compared, not just feedback or
row counts. The endpoint selects/checks the affected ID internally; its existing
response does not return the ID, and that contract was preserved.

H07 covers nonexistent UUID and invalid identifier type; malformed UUID strings
were not separately exercised. H06 covers invalid credentials, not an independently
expired-token scenario. These limits do not substitute for unexecuted cases.

## Cleanup and final local state — PASSED

Sessions were globally signed out, synthetic interactions/projects removed by
the guarded local SQL connection, and synthetic users deleted through Auth.
Final counts: **zero users, sessions, refresh tokens, projects, documents,
chunks and interactions**. All fixture IDs/emails are confined to ignored runtime
evidence; passwords, tokens and cookie values were kept in memory rather than
written into that evidence.

Only the task-created Next.js process tree was terminated. Its temporary mirror
and node_modules junction were removed after asserting that the resolved deletion
target was directly inside the intended ignored runtime directory. A subsequent
TCP probe returned ECONNREFUSED for the temporary port, while the existing port
3000 server and local API bridge still accepted connections.

The five-service baseline remains available. Auth email/password remains enabled
for future local tests, with all other Auth settings preserved. Cron is still
off, pg_net workers/HTTP queues/responses remain zero, Vault remains empty and
the ledger remains zero. Final guarded verification confirmed unchanged database
identity, hardened interaction policies, original restrictive boundary, all other
policies, ACLs, public/Storage schema fingerprint and role flags.

## Regression commands and results

| Command/check | Actual result | Status |
| --- | --- | --- |
| `node supabase/local-baseline/g5-http.mjs` | Final run: 14 HTTP requests plus G5-H10 passed; cleanup/catalog guard passed; exit 0 | PASSED |
| `pnpm exec tsx --test tests/feedback-route.test.ts tests/authorization-routes.test.ts tests/chat-route.test.ts` | 44 passed, zero failed/cancelled/skipped | PASSED |
| `pnpm test` | 112 passed, zero failed/cancelled/skipped | PASSED |
| `pnpm run typecheck` | Exit 0 after temporary mirror cleanup | PASSED |
| Focused ESLint on G5 ESM helpers, feedback test/route, Auth helper, server client and proxy | No issues | PASSED |
| Bridge ESLint with `no-require-imports` disabled for its existing CommonJS format | No issues | PASSED |
| `node --check` on bridge and both new helpers | Exit 0 | PASSED |
| Before/after `s1-p3.ps1 -Action Verify` | Local identity, disabled workers, empty records and catalog preservation passed | PASSED |

The focused/full regression suites use their existing mocked boundaries and are
reported separately from the genuine G5 integration. No live chat pipeline,
browser UI, SSE integration or production build was tested in this recovery.

## Earlier failed attempts, retained evidence and limits

The initial Auth replacement health probe ran before readiness, received
connection refused and automatically restored the original Auth service.
The corrected bounded startup wait then enabled only the provider successfully.
An early SDK smoke request timed out before fixture creation; a later empty-data
guard passed. A preliminary raw netcat password probe returned 500 with Auth log
`context canceled`; subsequent genuine SDK password sessions succeeded. That raw
probe is not represented as a successful login or a persistent schema failure.

The first HTTP-runner attempt hit its 90-second Next.js readiness limit and
cleaned up without HTTP cases. The second started Next.js after about 3.3 minutes
but its first feedback request exceeded the 90-second request allowance, with no
response captured. It also cleaned all fixtures/processes. The final bounded
attempt allowed 240 seconds for startup and 300 seconds per request; the server
started in 6.9 seconds and all fourteen observed responses arrived successfully.
Those prior timeouts remain recorded, not hidden or counted as passed cases.

Ignored evidence includes `g5-recovery-before-status.txt`,
`g5-recovery-before-hashes.json`, `g5-auth-recovery.json`,
`g5-http-first-attempt.json`, `g5-http-second-attempt.json`,
`g5-next-second-attempt.log`, final `g5-http-results.json`, `g5-next.log`,
`g5-auth-http-log.json`, `g5-listener.json` and preservation results.
The previously created read-only `g5-preflight.mjs` remains a diagnostic only;
the complete executed integration runner is `g5-http.mjs`.

## Change control and protected hashes

Modified existing files only:

- `supabase/local-baseline/config.toml`: enable the local email provider.
- `supabase/local-baseline/bridge.cjs`: open API transport on demand; retain the
  original PostgreSQL path, ports and loopback binding.
- `docs/g5-local-feedback-validation.md`: this recovery evidence report.

Created only:

- `supabase/local-baseline/g5-auth-recovery.mjs`: guarded Auth-only recovery.
- `supabase/local-baseline/g5-http.mjs`: real HTTP integration and fixture cleanup.

The ignored runtime configuration received the same local email setting. No
application route, Auth/proxy/client source, existing test, manifest, lockfile,
root configuration or application environment file was edited. All five migration
files and protected application files retained their initial SHA-256 hashes. The
S1-P3 migration remains:

```text
20261107054356_s1_p3_interactions_owner_policies.sql
01A702832D8845F2945E2F9342A7045C902AF5639C08989A4F898DC91489B350
```

## G1-G7 final gate results

| Gate | Status | Evidence |
| --- | --- | --- |
| G1 Environment isolation | PASSED | Verified dedicated identities/internal network and local-only process endpoints |
| G2 Policy integrity | PASSED | Hardened operation policies and restrictive owner_boundary unchanged |
| G3 Privileges | PASSED | ACLs/role flags unchanged; prior T1 effective-privilege evidence retained |
| G4 Cross-tenant security | PASSED | Prior twelve-case T1 evidence retained; genuine bidirectional feedback HTTP denials now demonstrated |
| G5 Feedback compatibility | PASSED | Real HTTP -> Next.js -> Auth session -> authenticated PostgREST -> hardened PostgreSQL persistence/denial |
| G6 Application regression | PASSED | 44 focused and 112 full tests, typecheck and scoped lint passed |
| G7 Change control | PASSED | Only authorized local-support/report files changed; protected hashes preserved; cleanup complete |

No G5 blocker remains in the final executed local run. Earlier cold-start and
transport timeouts limit performance/reliability claims beyond these observed
checks. Graphify query/update remains BLOCKED by its pre-existing missing Python
executable; no graph/tooling repair was made.

No policy rollback is needed or performed; local S1-P3 remains applied. Its prior
rollback documentation is unchanged. **Hosted Supabase was neither queried nor
changed**, including read-only access. No reset, migration up, push, pull, repair,
config push, historical replay, external AI request, public relay, deployment,
commit, Git push, merge or subsequent phase occurred. Work stops at G5 review.
