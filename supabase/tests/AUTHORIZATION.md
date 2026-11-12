# Authorization boundaries

PR CI runs `authorization.sql` against disposable PostgreSQL with the real hardening
and ingestion migrations. It changes database roles, sets JWT claims and verifies
both owners, anonymous access, row policies, column permissions and every overload
of the restricted RPCs. `bootstrap.sql` models the missing legacy schema with
deliberately permissive policies. Its Cron, Vault and HTTP adapters do not test
hosted services. Never apply the bootstrap to an existing database.

The **Staging authorization** workflow runs real HTTP checks against a separate
staging app and its Supabase project. Configure the staging environment variables
`AUTHZ_APP_URL` and `AUTHZ_SUPABASE_URL`, plus secrets `AUTHZ_SUPABASE_ANON_KEY`
and `AUTHZ_SUPABASE_SERVICE_ROLE_KEY`. Deploy both migrations and the current app
first; configure email/password authentication and the Storage webhook secret.
The app must point to that same staging Supabase project. Missing services,
incorrect migrations and unexpected HTTP responses fail the suite.

Locally, put those four settings in ignored `.env.authz.local` and run:

```sh
python -m pip install -r scripts/requirements-eval.txt
python scripts/authz_check.py
```

`pnpm test:authz` runs the same command with Python on PATH. No application `.env`
credentials are loaded. Service credentials are used only to create/inspect/clean
fixtures; assertions use two actual password sessions or anonymous access.
Fixtures include two users, projects, signed uploads, chunks and interactions.
Denied writes are checked against persisted victim records and Storage bytes.
The suite verifies owner feedback, upload, read, rename and deletion operations,
and tries foreign and unauthenticated app requests, direct database writes,
Storage reads/writes/deletes and restricted RPC calls. It never generates chat
answers or runs ingestion; uploaded fixture documents are marked indexed first.

Cleanup runs even on failure, and cleanup failure is a test failure. A forcibly
killed process or an ambiguous failed provisioning request can leave `authz-`
users and their fixtures; remove those in the dedicated staging project. Do not
run against production. URLs, tokens, response bodies and keys are not logged.

The global recovery dispatcher is checked by SQL privileges, not called by the
HTTP suite because it can operate on unrelated staging records. These checks do
not cover browser cookie/session refresh, CSRF or Next.js server-action transport;
they exercise the bearer HTTP API, Auth, PostgREST and Storage boundaries.
