# Disposable local Supabase baseline

This is a local test fixture derived from the 2026-11-07 hosted catalog audit and
four unchanged upgrade migrations. It is **not exact historical DDL**, a hosted
migration, or S1-P3. All application/SQL fixtures are synthetic.

The existing initialized workspace is `supabase/local-baseline/runtime/` (ignored
by Git). Run `check.ps1` to validate it through the local Docker engine. Do not
rerun `replay.ps1` on an initialized database; its refusal guard was tested.

## Contents

- `config.toml`: independent project `rag-baseline-20261107-01a1b3be`, PostgreSQL
  17, database port 57432 and API port 57431; automatic migrations/seeding disabled.
- `prerequisite.sql`: audited retained objects, omitting additions made by the
  four upgrade migrations. The two supplied function bodies are copied verbatim.
- `expected-catalog.json`: expected columns, constraints, indexes and policies
  extracted from `docs/hosted_supabase_schema_audit_2026-11-07.md`.
- `replay.ps1`: fail-closed local target/network checks, disables scheduling and
  the HTTP worker, replays hash-verified migration copies as `supabase_admin`,
  records each successful replay, and invokes validation.
- `check.ps1` / `validate.sql`: actual PostgreSQL catalog and synthetic checks.
  The fixtures roll back, including on failure.
- `bridge.cjs`: Windows loopback-to-local-Docker transport using Node and the
  image's installed `nc`. It adds no dependency and never provides container egress.

## Fresh setup

Use a fresh runtime directory and these exact disposable project/network names.
Never copy application `.env` files, Supabase link state, or Vault secrets.
Run PowerShell from the repository root. Docker's local named pipe is explicit.

```powershell
$docker = 'C:\Users\User\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe'
$engine = 'npipe:////./pipe/dockerDesktopLinuxEngine'
$runtime = Join-Path (Get-Location) 'supabase/local-baseline/runtime'
if (Test-Path -LiteralPath $runtime) { throw 'Use check.ps1 for an existing workspace; do not overwrite it.' }
New-Item -ItemType Directory -Path (Join-Path $runtime 'supabase') | Out-Null
Copy-Item -LiteralPath 'supabase/local-baseline/config.toml' -Destination (Join-Path $runtime 'supabase/config.toml')
& $docker --host $engine network create --internal --opt 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1' --label 'rag.local-baseline=20261107-01a1b3be' rag-baseline-20261107-01a1b3be-internal
if ($LASTEXITCODE -ne 0) { throw 'Network creation failed; inspect existing state.' }
```

In a separate terminal, from the repository root:

```powershell
node supabase/local-baseline/bridge.cjs
```

The internal network prevents normal Docker Desktop port forwarding here. The
bridge listens only on `127.0.0.1:57432` and `127.0.0.1:57431`, forwarding through
Docker's local named pipe to fixed internal services. Type `quit` or press Ctrl+C
in that terminal to stop it. CLI connections remain intermittent on this Windows
transport; a successful raw authenticated PostgreSQL SELECT was verified, but
CLI readiness should not be assumed from a listening socket alone.

In the first terminal:

```powershell
$env:DOCKER_HOST = $engine
$env:PATH = (Split-Path -Parent $docker) + [IO.Path]::PathSeparator + $env:PATH
$env:SUPABASE_HOME = Join-Path $runtime 'cli-home'
$env:SUPABASE_TELEMETRY_DISABLED = '1'
$env:DO_NOT_TRACK = '1'
Remove-Item Env:SUPABASE_ACCESS_TOKEN,Env:SUPABASE_DB_PASSWORD,Env:DATABASE_URL,Env:PGPASSWORD,Env:PGHOST,Env:PGSERVICE -ErrorAction SilentlyContinue
pnpm exec supabase --workdir $runtime --network-id rag-baseline-20261107-01a1b3be-internal start --exclude realtime,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
if ($LASTEXITCODE -ne 0) { throw 'Stop before replay; inspect the disposable stack.' }
& './supabase/local-baseline/replay.ps1'
```

Only PostgreSQL, Auth, Storage, PostgREST and Kong are required. Their real managed
schemas are furnished by Supabase, not the old PostgreSQL test adapters. The
initial CLI startup must complete before the replay script restarts PostgreSQL.
The privileged administrative connection is necessary for the unchanged migration
which also changes managed Storage policies. Client grants are not broadened.

## History and security boundaries

SQL replay succeeded for all four files. Results and SHA-256 values are in the
ignored `runtime/migration-manifest.json`. Local CLI history recording was
attempted but failed at connection establishment; its ledger remains empty.
Do not run `migration up` against this initialized fixture: it would attempt
already-replayed SQL. No hosted history was read or repaired. The three recorded
local/hosted version differences remain documented in the completion report.

`cron.launch_active_jobs=off` persists in the disposable server. `pg_net` is
installed, but excluded from this server's preload list, so its HTTP worker does
not run. All five containers were verified on the single internal network. No
Vault secrets were created. Cron run history, HTTP queue and HTTP responses were
empty after validation. Do not enable workers or copy real endpoint bindings.

The broad pre-S1-P3 interaction policies intentionally remain. This baseline is
not a security-remediated deployment. Full S1-P3/T1 tests and real feedback HTTP
compatibility remain outside this task. Legacy SQL test fixtures omit required
columns/vectors and were inspected, not reused as a faithful full baseline.

## Cleanup

Synthetic validation rows already rolled back. The local schema and dedicated
stack remain available for review. Never use an all-project stop/reset command.
To stop this stack while retaining its data, with the environment above:

```powershell
pnpm exec supabase --workdir $runtime stop --project-id rag-baseline-20261107-01a1b3be
```

Stop the bridge separately with `quit`. For complete disposal, the same local-only
stop command supports `--no-backup`; it destroys this disposable project's volumes.
Remove the dedicated network only after inspecting its ownership label and
confirming it has no containers. Do not remove the repository's root Supabase
configuration, migrations, unrelated Docker resources or other workspaces.

No destructive cleanup was run after successful validation. No hosted changes,
production records, S1-P3 policies, deployment, commits, pushes or merges occurred.
