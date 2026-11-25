// Isolated PGlite verification for Jira signup provisioning migration & backfill.
// Never connects to hosted Supabase or reads production credentials.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { PGlite } from "../node_modules/.cache/ingestion-sql-runtime/node_modules/@electric-sql/pglite/dist/index.js"
import { vector } from "../node_modules/.cache/ingestion-sql-runtime/node_modules/@electric-sql/pglite-pgvector/dist/index.js"

const ORG_ID = "c0000000-0000-4000-8000-000000000001"
const ENG_DEPT_ID = "c0000000-0000-4000-8000-000000000002"
const HR_DEPT_ID = "859355c7-c42c-4db8-b827-a13d0b827641"

const USERS = {
  optedInNew: "10000000-0000-4000-8000-000000000001",
  optedOutNew: "10000000-0000-4000-8000-000000000002",
  omittedNew: "10000000-0000-4000-8000-000000000003",
  spoofedMetaNew: "10000000-0000-4000-8000-000000000004",
  backfillConfirmedTest1: "d42e40d5-e1f5-4261-b002-a02b10c7c4dd",
  backfillConfirmedTest2: "12ff1269-30f0-48b0-ad9b-76a93d8e90b1",
  backfillOtherConfirmed: "23940244-8991-4d13-bc25-1c8e3a6cf5e2",
  backfillUnconfirmed: "3cdc4da4-a230-4864-8c38-22a86903b6a0",
  backfillExistingDisabled: "10000000-0000-4000-8000-000000000005",
  deactivatedUser: "10000000-0000-4000-8000-000000000006",
}

const db = new PGlite({ extensions: { vector } })
const checks = []

async function runCheck(id, description, fn) {
  const start = performance.now()
  try {
    await fn()
    checks.push({ id, description, status: "PASS", duration_ms: Number((performance.now() - start).toFixed(2)) })
  } catch (err) {
    checks.push({
      id,
      description,
      status: "FAIL",
      duration_ms: Number((performance.now() - start).toFixed(2)),
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

async function asRole(role, userId, fn) {
  await db.exec("begin")
  try {
    await db.query(`select set_config('role', $1, true)`, [role])
    if (userId) {
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role }),
      ])
    } else {
      await db.query(`select set_config('request.jwt.claims', '', true)`)
    }
    const result = await fn()
    await db.exec("commit")
    return result
  } catch (err) {
    await db.exec("rollback")
    throw err
  }
}

async function setup() {
  const fixturePath = path.join(process.cwd(), "supabase", "tests", "fixtures", "agentic_enterprise_upload_schema.sql")
  const fixtureSql = await readFile(fixturePath, "utf8")
  await db.exec(fixtureSql)

  // Add WP9.13 public.demo_jira_access table, RLS, and table grants matching live schema.
  await db.exec(`
    create table if not exists public.demo_jira_access (
      user_id uuid primary key references auth.users(id) on delete cascade,
      enabled boolean not null default false,
      created_at timestamptz not null default now()
    );
    alter table public.demo_jira_access enable row level security;
    drop policy if exists enterprise_demo_jira_own on public.demo_jira_access;
    create policy enterprise_demo_jira_own
      on public.demo_jira_access
      for select
      to authenticated
      using (user_id = (select auth.uid()));
    revoke all on table public.demo_jira_access from public, anon;
    grant select on table public.demo_jira_access to authenticated;
  `)

  await db.query(`insert into public.organizations (id, name) values ($1, 'DeccanBridge Software')`, [ORG_ID])
  await db.query(
    `insert into public.departments (organization_id, id, name) values
      ($1, $2, 'Engineering'),
      ($1, $3, 'HR')`,
    [ORG_ID, ENG_DEPT_ID, HR_DEPT_ID]
  )

  // Seed historical pre-trigger accounts simulating hosted state before applying migration + backfill.
  await db.query(
    `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
      ($1, 'jira-test-1@example.invalid', now(), '{"demo_jira_access": true, "demo_department": "Engineering"}'::jsonb),
      ($2, 'jira-test-2@example.invalid', now(), '{"demo_jira_access": true, "demo_department": "Engineering"}'::jsonb),
      ($3, 'other-confirmed@example.invalid', now(), '{"demo_jira_access": true, "demo_department": "Engineering"}'::jsonb),
      ($4, 'unconfirmed-opted-in@example.invalid', null, '{"demo_jira_access": true, "demo_department": "Engineering"}'::jsonb),
      ($5, 'existing-revoked@example.invalid', now(), '{"demo_jira_access": true, "demo_department": "Engineering"}'::jsonb),
      ($6, 'deactivated-opted-in@example.invalid', now(), '{"demo_jira_access": true, "demo_department": "Engineering"}'::jsonb)`,
    [
      USERS.backfillConfirmedTest1,
      USERS.backfillConfirmedTest2,
      USERS.backfillOtherConfirmed,
      USERS.backfillUnconfirmed,
      USERS.backfillExistingDisabled,
      USERS.deactivatedUser,
    ]
  )

  await db.query(
    `insert into public.organization_employees (organization_id, user_id, department_id, role, is_active) values
      ($1, $2, $3, 'employee', true),
      ($1, $4, $3, 'employee', true),
      ($1, $5, $3, 'manager', true),
      ($1, $6, $3, 'employee', true),
      ($1, $7, $3, 'employee', false)`,
    [
      ORG_ID,
      USERS.backfillConfirmedTest1,
      ENG_DEPT_ID,
      USERS.backfillConfirmedTest2,
      USERS.backfillOtherConfirmed,
      USERS.backfillExistingDisabled,
      USERS.deactivatedUser,
    ]
  )
  await db.query(`insert into public.demo_jira_access (user_id, enabled) values ($1, false), ($2, true)`, [
    USERS.backfillExistingDisabled,
    USERS.deactivatedUser,
  ])

  const migrationPath = path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20261122081000_restore_demo_jira_signup_trigger.sql"
  )
  const migrationSql = await readFile(migrationPath, "utf8")
  await db.exec(migrationSql)

  const backfillPath = path.join(process.cwd(), "supabase", "ingestion", "backfill_demo_jira_access.sql")
  const backfillSql = await readFile(backfillPath, "utf8")
  await db.exec(backfillSql)
}

async function canAuthorizeJiraAsUser(userId) {
  return asRole("authenticated", userId, async () => {
    const { rows: jiraRows } = await db.query(
      `select enabled from public.demo_jira_access where user_id = $1 limit 1`,
      [userId]
    )
    const { rows: empRows } = await db.query(
      `select organization_id, is_active from public.organization_employees
       where organization_id = $1 and user_id = $2 and is_active = true limit 1`,
      [ORG_ID, userId]
    )
    const jiraEnabled = jiraRows[0]?.enabled === true
    const isActiveMember = empRows.length === 1 && empRows[0].is_active === true
    return jiraEnabled && isActiveMember
  })
}

async function main() {
  try {
    await setup()

    await runCheck("J1_BACKFILL_CONFIRMED", "Backfill enables only the two allowlisted confirmed opt-in accounts without overwriting existing rows or enabling others", async () => {
      const { rows } = await db.query(
        `select user_id, enabled from public.demo_jira_access where user_id in ($1, $2, $3, $4, $5)`,
        [
          USERS.backfillConfirmedTest1,
          USERS.backfillConfirmedTest2,
          USERS.backfillOtherConfirmed,
          USERS.backfillUnconfirmed,
          USERS.backfillExistingDisabled,
        ]
      )
      const byId = new Map(rows.map((r) => [r.user_id, r.enabled]))
      assert.equal(byId.get(USERS.backfillConfirmedTest1), true)
      assert.equal(byId.get(USERS.backfillConfirmedTest2), true)
      assert.equal(byId.has(USERS.backfillOtherConfirmed), false, "non-allowlisted account must remain untouched")
      assert.equal(byId.has(USERS.backfillUnconfirmed), false, "unconfirmed user must not be backfilled")
      assert.equal(byId.get(USERS.backfillExistingDisabled), false, "existing row must not be overwritten")
      assert.equal(await canAuthorizeJiraAsUser(USERS.backfillConfirmedTest1), true)
      assert.equal(await canAuthorizeJiraAsUser(USERS.backfillConfirmedTest2), true)
      assert.equal(await canAuthorizeJiraAsUser(USERS.backfillOtherConfirmed), false)
    })

    await runCheck("J2_SIGNUP_ENABLED", "New signup with demo_jira_access=true persists enabled=true on insert and activates membership on email confirmation", async () => {
      await db.query(
        `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
         values ($1, 'new-jira-on@example.invalid', null, '{"demo_jira_access": true, "demo_department": "Engineering"}'::jsonb)`,
        [USERS.optedInNew]
      )
      const preConfirm = await db.query(`select enabled from public.demo_jira_access where user_id = $1`, [USERS.optedInNew])
      assert.equal(preConfirm.rows[0]?.enabled, true)
      const preEmp = await db.query(`select 1 from public.organization_employees where user_id = $1`, [USERS.optedInNew])
      assert.equal(preEmp.rows.length, 0, "unconfirmed user must not receive organization membership")
      assert.equal(await canAuthorizeJiraAsUser(USERS.optedInNew), false)

      await db.query(`update auth.users set email_confirmed_at = now() where id = $1`, [USERS.optedInNew])
      const postEmp = await db.query(
        `select department_id, role, is_active from public.organization_employees where user_id = $1`,
        [USERS.optedInNew]
      )
      assert.deepEqual(postEmp.rows, [{ department_id: ENG_DEPT_ID, role: "employee", is_active: true }])
      assert.equal(await canAuthorizeJiraAsUser(USERS.optedInNew), true)
    })

    await runCheck("J3_SIGNUP_DISABLED", "New signup with demo_jira_access=false persists enabled=false and remains denied for Jira", async () => {
      await db.query(
        `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
         values ($1, 'new-jira-off@example.invalid', now(), '{"demo_jira_access": false, "demo_department": "HR"}'::jsonb)`,
        [USERS.optedOutNew]
      )
      const { rows } = await db.query(`select enabled from public.demo_jira_access where user_id = $1`, [USERS.optedOutNew])
      assert.equal(rows[0]?.enabled, false)
      assert.equal(await canAuthorizeJiraAsUser(USERS.optedOutNew), false)
    })

    await runCheck("J4_SIGNUP_OMITTED_OR_NON_TRUE", "Signup omitting demo_jira_access inserts no row and non-boolean strings do not authorize", async () => {
      await db.query(
        `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
         values
           ($1, 'omitted@example.invalid', now(), '{"demo_department": "Engineering"}'::jsonb),
           ($2, 'spoofed@example.invalid', now(), '{"demo_jira_access": "yes", "demo_department": "Engineering"}'::jsonb)`,
        [USERS.omittedNew, USERS.spoofedMetaNew]
      )
      const omitted = await db.query(`select 1 from public.demo_jira_access where user_id = $1`, [USERS.omittedNew])
      assert.equal(omitted.rows.length, 0)
      const spoofed = await db.query(`select enabled from public.demo_jira_access where user_id = $1`, [USERS.spoofedMetaNew])
      assert.equal(spoofed.rows[0]?.enabled, false)
      assert.equal(await canAuthorizeJiraAsUser(USERS.omittedNew), false)
      assert.equal(await canAuthorizeJiraAsUser(USERS.spoofedMetaNew), false)
    })

    await runCheck("J5_DEACTIVATED_BLOCKED", "Deactivated employee with demo_jira_access=true remains blocked by organization_employees check", async () => {
      assert.equal(await canAuthorizeJiraAsUser(USERS.deactivatedUser), false)
    })

    await runCheck("J6_PRIVILEGE_AND_RLS_ISOLATION", "SECURITY DEFINER trigger privilege is revoked from public/anon/authenticated/service_role and authenticated users cannot forge demo_jira_access or read others", async () => {
      const { rows: privRows } = await db.query(
        `select
           has_function_privilege('public', 'public.handle_demo_jira_signup()', 'EXECUTE') as pub_exec,
           has_function_privilege('anon', 'public.handle_demo_jira_signup()', 'EXECUTE') as anon_exec,
           has_function_privilege('authenticated', 'public.handle_demo_jira_signup()', 'EXECUTE') as auth_exec,
           has_function_privilege('service_role', 'public.handle_demo_jira_signup()', 'EXECUTE') as srv_exec`
      )
      assert.deepEqual(privRows[0], {
        pub_exec: false,
        anon_exec: false,
        auth_exec: false,
        srv_exec: false,
      })

      await assert.rejects(
        () =>
          asRole("authenticated", USERS.optedOutNew, () =>
            db.query(`update public.demo_jira_access set enabled = true where user_id = $1`, [USERS.optedOutNew])
          ),
        /permission denied/i
      )

      await assert.rejects(
        () =>
          asRole("authenticated", USERS.omittedNew, () =>
            db.query(`insert into public.demo_jira_access (user_id, enabled) values ($1, true)`, [USERS.omittedNew])
          ),
        /permission denied/i
      )

      await assert.rejects(
        () =>
          asRole("anon", null, () => db.query(`select * from public.demo_jira_access`)),
        /permission denied/i
      )

      const ownRead = await asRole("authenticated", USERS.optedOutNew, () =>
        db.query(`select user_id, enabled from public.demo_jira_access`)
      )
      assert.deepEqual(ownRead.rows, [{ user_id: USERS.optedOutNew, enabled: false }])
    })

    console.log(JSON.stringify({ summary: { total: checks.length, passed: checks.length, failed: 0 }, checks }, null, 2))
  } finally {
    await db.close()
  }
}

await main()
