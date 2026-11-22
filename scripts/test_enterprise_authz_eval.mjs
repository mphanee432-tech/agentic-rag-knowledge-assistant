// Isolated PostgreSQL/pgvector authorization evaluation for Step 4.
// Never connects to hosted Supabase or reads production credentials.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { PGlite } from "../node_modules/.cache/ingestion-sql-runtime/node_modules/@electric-sql/pglite/dist/index.js"
import { vector } from "../node_modules/.cache/ingestion-sql-runtime/node_modules/@electric-sql/pglite-pgvector/dist/index.js"

const ORG_ID = "c0000000-0000-4000-8000-000000000001"
const FOREIGN_ORG_ID = "99999999-9999-4999-8999-999999999999"

const DEPT = {
  hr: "859355c7-c42c-4db8-b827-a13d0b827641",
  eng: "c0000000-0000-4000-8000-000000000002",
  uiux: "e56ac7f0-082a-4c6f-b9c5-3cba1cce1f9a",
  pm: "46cf12cb-7039-476a-a184-74e3803086f3",
  fin: "3934ae4e-ff1e-410b-aebc-e732976df7b9",
  mkt: "3e307cb5-632c-4f2a-ac49-b2ba18717471",
  foreign: "f1111111-1111-4111-8111-111111111111",
}

const PROJ = {
  hr: "a774548e-818a-43a0-851d-74badf1e1a0f",
  eng: "c0000000-0000-4000-8000-000000000010",
  uiux: "91c716f0-3c12-4ac0-95c6-2b04bd0d5085",
  fin: "e632dff2-997e-44d7-bcfe-bf06ac3e1552",
  mkt: "fcb08931-ee61-4f11-93d7-c88960ba1947",
  d12: "be1563f5-fa66-4e4d-985a-6b32b0acc045",
  foreign: "f2222222-2222-4222-8222-222222222222",
}

const DOC = {
  d01: "69a97694-344e-4583-89d3-41c88048e40f",
  bookExchange: "8a080ff3-3b9e-4c71-9939-b511960dfecd",
  d03: "56a33f69-64f2-47ba-b7c1-6a08c2972315",
  d04: "0f13288f-0af2-457c-b51a-cf032fec59e7",
  d07: "79d1e594-d533-4331-a667-bdf16c7bb7c5",
  d09: "14a4d882-5b94-4cf4-a79a-01e9281faa42",
  d11: "0a66446f-b6e8-41d4-98da-0bf0910a7b91",
  d12: "f6e8e6bb-9e19-4261-af1d-3c0e6d9b69ba",
  unpublishedD04: "0f13288f-0af2-457c-b51a-cf032fec5999",
}

const USER = {
  designatedManager: "23940244-8991-4d13-bc25-1c8e3a6cf5e2",
  engEmployee: "11111111-1111-4111-8111-111111111111",
  uiuxEmployee: "22222222-2222-4222-8222-222222222222",
  finGranted: "33333333-3333-4333-8333-333333333333",
  d12MemberOnly: "44444444-4444-4444-8444-444444444444",
  d12FullAccess: "55555555-5555-4555-8555-555555555555",
  cxoNoGrants: "66666666-6666-4666-8666-666666666666",
  expiredGrantUser: "77777777-7777-4777-8777-777777777777",
  outsider: "88888888-8888-4888-8888-888888888888",
  approver: "99999999-9999-4999-8999-999999999991",
}

const ZERO_VECTOR = `[${Array(1536).fill(0.05).join(",")}]`

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

async function asAuthenticated(userId, fn, extraClaims = {}) {
  await db.exec("begin")
  try {
    await db.exec("set local role authenticated")
    await db.query(
      "select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub: userId, role: "authenticated", ...extraClaims })],
    )
    return await fn()
  } finally {
    await db.exec("rollback")
  }
}

async function readableDocIds(userId, extraClaims = {}) {
  const res = await asAuthenticated(
    userId,
    () => db.query("select id from public.documents order by id"),
    extraClaims,
  )
  return new Set(res.rows.map((r) => r.id))
}

async function searchChunkDocs(userId, queryText) {
  const res = await asAuthenticated(
    userId,
    () =>
      db.query(
        `select c.document_id
         from public.search_enterprise_chunks($1::extensions.vector, $2, $3::uuid) s
         join public.document_chunks c on c.id = s.id`,
        [ZERO_VECTOR, queryText, ORG_ID],
      ),
  )
  return new Set(res.rows.map((r) => r.document_id))
}

try {
  await db.exec(await readFile("supabase/tests/fixtures/agentic_enterprise_upload_schema.sql", "utf8"))

  // Extend PGlite fixture with auth.jwt(), generated fts column, and wp3_retrieval role
  await db.exec(`
    create or replace function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
    $$;
    grant execute on function auth.jwt() to authenticated, anon, service_role;
    alter table public.document_chunks
      add column fts tsvector generated always as (to_tsvector('simple', coalesce(content, ''))) stored;
    create role wp3_retrieval nologin noinherit nobypassrls;
    grant wp3_retrieval to postgres;
    grant usage on schema wp3_private to wp3_retrieval;
    grant usage on schema public, extensions to wp3_retrieval;
    grant select (id, user_id) on public.projects to wp3_retrieval;
    grant select (id, document_id, project_id, content, embedding, fts) on public.document_chunks to wp3_retrieval;
    create schema wp4_private;
    create table wp4_private.security_audit (
      id uuid primary key default gen_random_uuid(),
      event text not null,
      actor_id uuid,
      organization_id uuid
    );
  `)

  const retrieval = await readFile("supabase/migrations/20261112034417_wp3_secure_rag_retrieval.sql", "utf8")
  const canReadStart = retrieval.indexOf("create function wp3_private.can_read_document(")
  await db.exec(retrieval.slice(canReadStart, retrieval.indexOf("$$;", canReadStart) + 3))

  await db.exec(`
    grant execute on function wp3_private.can_read_document(uuid,uuid,boolean) to authenticated, wp3_retrieval;
    create policy enterprise_documents_allowed on public.documents for select to authenticated
      using(wp3_private.can_read_document(id,project_id,true));
    create policy enterprise_chunks_allowed on public.document_chunks for select to authenticated
      using(wp3_private.can_read_document(document_id,project_id,true));
    create policy rag_retrieval_boundary on public.document_chunks as restrictive
      for select to wp3_retrieval using (wp3_private.can_read_document(document_id, project_id, false));
    create policy rag_retrieval_select on public.document_chunks for select to wp3_retrieval using (true);
    create function wp3_private.organization_projects(target_organization_id uuid)
    returns setof uuid language sql stable security definer set search_path = pg_catalog, pg_temp as $$
      select p.id from public.projects p
      join public.organization_employees e on e.organization_id = p.organization_id
      where p.organization_id = target_organization_id and e.user_id = (select auth.uid()) and e.is_active
    $$;
    grant execute on function wp3_private.organization_projects(uuid) to wp3_retrieval, authenticated;
  `)

  const wp943 = await readFile(
    "supabase/migrations/20261117133000_wp9_43_restore_enterprise_policy_id_and_keyword_search.sql",
    "utf8",
  )
  const scStart = wp943.indexOf("create or replace function wp3_private.search_chunks(")
  await db.exec(wp943.slice(scStart, wp943.indexOf("$$;", scStart) + 3))
  await db.exec(`
    alter function wp3_private.search_chunks(extensions.vector, text, uuid, uuid) owner to wp3_retrieval;
    grant execute on function wp3_private.search_chunks(extensions.vector, text, uuid, uuid) to authenticated, postgres;
    create function public.search_enterprise_chunks(query_embedding extensions.vector, query_text text, target_organization_id uuid)
    returns table (id uuid, content text)
    language sql stable security invoker set search_path = pg_catalog, pg_temp as $$
      select * from wp3_private.search_chunks(query_embedding, query_text, null, target_organization_id)
    $$;
    grant execute on function public.search_enterprise_chunks(extensions.vector, text, uuid) to authenticated;
  `)

  // Apply restoration + designated uploader assignment + E25/E18 fallback/search RPC restoration
  await db.exec(await readFile("supabase/migrations/20261121122157_restore_agentic_enterprise_upload_contracts.sql", "utf8"))
  await db.exec(await readFile("supabase/migrations/20261121214500_restore_enterprise_fallback_and_search_rpc.sql", "utf8"))

  // Seed synthetic identities, orgs, departments, projects, documents, and grants
  await db.exec(`
    insert into auth.users(id, email, email_confirmed_at) values
      ('${USER.designatedManager}', 'phani9119@gmail.com', now()),
      ('${USER.engEmployee}', 'eng.emp@fixture.invalid', now()),
      ('${USER.uiuxEmployee}', 'uiux.emp@fixture.invalid', now()),
      ('${USER.finGranted}', 'fin.grant@fixture.invalid', now()),
      ('${USER.d12MemberOnly}', 'd12.member@fixture.invalid', now()),
      ('${USER.d12FullAccess}', 'd12.full@fixture.invalid', now()),
      ('${USER.cxoNoGrants}', 'cxo.nogrant@fixture.invalid', now()),
      ('${USER.expiredGrantUser}', 'expired.grant@fixture.invalid', now()),
      ('${USER.outsider}', 'outsider@foreign.invalid', now()),
      ('${USER.approver}', 'approver@fixture.invalid', now());

    insert into public.organizations(id, name) values
      ('${ORG_ID}', 'DeccanBridge Software'),
      ('${FOREIGN_ORG_ID}', 'Foreign Org');

    insert into public.departments(organization_id, id, name) values
      ('${ORG_ID}', '${DEPT.hr}', 'HR'),
      ('${ORG_ID}', '${DEPT.eng}', 'Engineering'),
      ('${ORG_ID}', '${DEPT.uiux}', 'UI/UX'),
      ('${ORG_ID}', '${DEPT.pm}', 'Product Management'),
      ('${ORG_ID}', '${DEPT.fin}', 'Finance'),
      ('${ORG_ID}', '${DEPT.mkt}', 'Marketing'),
      ('${FOREIGN_ORG_ID}', '${DEPT.foreign}', 'Foreign Dept');

    insert into public.organization_employees(organization_id, user_id, department_id, role, is_active) values
      ('${ORG_ID}', '${USER.designatedManager}', '${DEPT.eng}', 'employee', true),
      ('${ORG_ID}', '${USER.engEmployee}', '${DEPT.eng}', 'employee', true),
      ('${ORG_ID}', '${USER.uiuxEmployee}', '${DEPT.uiux}', 'employee', true),
      ('${ORG_ID}', '${USER.finGranted}', '${DEPT.fin}', 'employee', true),
      ('${ORG_ID}', '${USER.d12MemberOnly}', '${DEPT.pm}', 'employee', true),
      ('${ORG_ID}', '${USER.d12FullAccess}', '${DEPT.eng}', 'employee', true),
      ('${ORG_ID}', '${USER.cxoNoGrants}', '${DEPT.hr}', 'cxo', true),
      ('${ORG_ID}', '${USER.expiredGrantUser}', '${DEPT.fin}', 'employee', true),
      ('${ORG_ID}', '${USER.approver}', '${DEPT.hr}', 'manager', true),
      ('${FOREIGN_ORG_ID}', '${USER.outsider}', '${DEPT.foreign}', 'cxo', true);

    insert into public.projects(id, organization_id, department_id, is_d12, name) values
      ('${PROJ.hr}', '${ORG_ID}', '${DEPT.hr}', false, 'HR Knowledge Base'),
      ('${PROJ.eng}', '${ORG_ID}', '${DEPT.eng}', false, 'Engineering Knowledge Base'),
      ('${PROJ.uiux}', '${ORG_ID}', '${DEPT.uiux}', false, 'UI/UX Knowledge Base'),
      ('${PROJ.fin}', '${ORG_ID}', '${DEPT.fin}', false, 'Finance Knowledge Base'),
      ('${PROJ.mkt}', '${ORG_ID}', '${DEPT.mkt}', false, 'Marketing Knowledge Base'),
      ('${PROJ.d12}', '${ORG_ID}', '${DEPT.pm}', true, 'D12 Product Launch'),
      ('${PROJ.foreign}', '${FOREIGN_ORG_ID}', '${DEPT.foreign}', false, 'Foreign KB');

    insert into public.documents(id, project_id, storage_path, status, is_published, classification, access_scope) values
      ('${DOC.d01}', '${PROJ.hr}', 'enterprise/hr/D01_Revised_Candidate_1_1_custodian_fixed.pdf', 'indexed', true, 'standard', 'company'),
      ('${DOC.bookExchange}', '${PROJ.hr}', 'enterprise/hr/book.pdf', 'indexed', true, 'standard', 'company'),
      ('${DOC.d03}', '${PROJ.hr}', 'enterprise/hr/d03.txt', 'indexed', true, 'restricted', 'department'),
      ('${DOC.d04}', '${PROJ.eng}', 'enterprise/eng/D04_Engineering_Code_Review_Bug_Reporting_and_Incident_SOP_DeccanBridge_Software_Reconciliation_Candidate_1_1.html', 'indexed', true, 'standard', 'department'),
      ('${DOC.d07}', '${PROJ.uiux}', 'enterprise/uiux/D07_Design_Handoff_and_Accessibility_DeccanBridge_Software_Reconciliation_Candidate_1_1.html', 'indexed', true, 'standard', 'department'),
      ('${DOC.d09}', '${PROJ.mkt}', 'enterprise/mkt/D09_Brand_and_Campaign_Approval_DeccanBridge_Software_Reconciliation_Candidate_1_1.pdf', 'indexed', true, 'standard', 'department'),
      ('${DOC.d11}', '${PROJ.fin}', 'enterprise/fin/d11.txt', 'indexed', true, 'restricted', 'department'),
      ('${DOC.d12}', '${PROJ.d12}', 'enterprise/d12/d12.pdf', 'indexed', true, 'standard', 'department'),
      ('${DOC.unpublishedD04}', '${PROJ.eng}', 'enterprise/eng/unpublished.txt', 'indexed', false, 'standard', 'company');

    insert into public.document_chunks(document_id, project_id, content, embedding) values
      ('${DOC.d01}', '${PROJ.hr}', 'D01 DOCUMENT CONTROL DeccanBridge Employee Handbook custodian HR Manager independent reviewer Operations Manager 1 November 2026', '${ZERO_VECTOR}'::extensions.vector),
      ('${DOC.d01}', '${PROJ.hr}', 'D01 section 2 eight functional departments Employee Manager CXO Executive affiliation', '[${[0.5, ...Array(1535).fill(0.05)].join(",")}]'::extensions.vector),
      ('${DOC.bookExchange}', '${PROJ.hr}', 'Bluebird Bookshelf Office Book Exchange Policy borrow two books 10 calendar days', '${ZERO_VECTOR}'::extensions.vector),
      ('${DOC.d03}', '${PROJ.hr}', 'D03 CONFIDENTIAL COMPENSATION ADMINISTRATION PROCEDURE secret escalation', '${ZERO_VECTOR}'::extensions.vector),
      ('${DOC.d04}', '${PROJ.eng}', 'D04 DOCUMENT CONTROL Engineering Code Review Bug Reporting critical bug triage 2 business hours', '${ZERO_VECTOR}'::extensions.vector),
      ('${DOC.d07}', '${PROJ.uiux}', 'D07 DOCUMENT CONTROL Design Handoff Accessibility WCAG unresolved', '${ZERO_VECTOR}'::extensions.vector),
      ('${DOC.d09}', '${PROJ.mkt}', 'D09 DOCUMENT CONTROL Brand Campaign Approval marketing workflow', '${ZERO_VECTOR}'::extensions.vector),
      ('${DOC.d11}', '${PROJ.fin}', 'D11 DOCUMENT CONTROL CONFIDENTIAL BUDGET APPROVAL strictly above 50000 secret threshold', '${ZERO_VECTOR}'::extensions.vector),
      ('${DOC.d12}', '${PROJ.d12}', 'D12 DOCUMENT CONTROL Cross-Functional Product Launch Playbook 3 operational business days', '${ZERO_VECTOR}'::extensions.vector),
      ('${DOC.unpublishedD04}', '${PROJ.eng}', 'Unpublished draft secret text must never be retrieved', '${ZERO_VECTOR}'::extensions.vector);

    -- Explicit grants & project memberships
    insert into public.document_grants(document_id, project_id, organization_id, project_department_id, is_d12, classification, user_id, recipient_department_id, approved_by, valid_from, expires_at) values
      ('${DOC.d11}', '${PROJ.fin}', '${ORG_ID}', '${DEPT.fin}', false, 'restricted', '${USER.finGranted}', '${DEPT.fin}', '${USER.approver}', now() - interval '1 day', now() + interval '29 days'),
      ('${DOC.d12}', '${PROJ.d12}', '${ORG_ID}', '${DEPT.pm}', true, 'standard', '${USER.d12FullAccess}', '${DEPT.eng}', '${USER.approver}', now() - interval '1 day', now() + interval '89 days'),
      ('${DOC.d11}', '${PROJ.fin}', '${ORG_ID}', '${DEPT.fin}', false, 'restricted', '${USER.expiredGrantUser}', '${DEPT.fin}', '${USER.approver}', now() - interval '35 days', now() - interval '1 day');

    insert into public.project_memberships(project_id, organization_id, project_department_id, is_d12, user_id, valid_from, expires_at) values
      ('${PROJ.d12}', '${ORG_ID}', '${DEPT.pm}', true, '${USER.d12MemberOnly}', now() - interval '1 day', now() + interval '89 days'),
      ('${PROJ.d12}', '${ORG_ID}', '${DEPT.pm}', true, '${USER.d12FullAccess}', now() - interval '1 day', now() + interval '89 days');
  `)

  await db.exec(await readFile("supabase/ingestion/authorize_designated_enterprise_uploader.sql", "utf8"))

  await runCheck("AUTHZ-01", "Company-wide Standard docs (D01, Book Exchange) accessible to all active org employees", async () => {
    for (const uid of [USER.designatedManager, USER.engEmployee, USER.uiuxEmployee, USER.finGranted]) {
      const docs = await readableDocIds(uid)
      assert.ok(docs.has(DOC.d01), `${uid} should read D01`)
      assert.ok(docs.has(DOC.bookExchange), `${uid} should read Book Exchange`)
      assert.ok(!docs.has(DOC.unpublishedD04), `${uid} must never read unpublished doc`)
    }
  })

  await runCheck("AUTHZ-02", "Department-only Standard docs enforce department boundaries", async () => {
    const engDocs = await readableDocIds(USER.engEmployee)
    assert.ok(engDocs.has(DOC.d04))
    assert.ok(!engDocs.has(DOC.d07), "Engineering employee must not read UI/UX D07")
    assert.ok(!engDocs.has(DOC.d09), "Engineering employee must not read Marketing D09")

    const uiuxDocs = await readableDocIds(USER.uiuxEmployee)
    assert.ok(uiuxDocs.has(DOC.d07))
    assert.ok(!uiuxDocs.has(DOC.d04), "UI/UX employee must not read Engineering D04")
  })

  await runCheck("AUTHZ-03", "Restricted D03 and D11 deny Manager and CXO without explicit grant; allow valid grant", async () => {
    for (const uid of [USER.designatedManager, USER.engEmployee, USER.cxoNoGrants, USER.expiredGrantUser]) {
      const docs = await readableDocIds(uid)
      assert.ok(!docs.has(DOC.d03), `${uid} must not read D03 without grant`)
      assert.ok(!docs.has(DOC.d11), `${uid} must not read D11 without active grant`)
    }
    const finDocs = await readableDocIds(USER.finGranted)
    assert.ok(finDocs.has(DOC.d11), "Finance user with active grant must read D11")
    assert.ok(!finDocs.has(DOC.d03), "D11 grant must not grant D03")
  })

  await runCheck("AUTHZ-04", "D12 requires BOTH active project membership AND valid D12 document grant", async () => {
    const memberOnlyDocs = await readableDocIds(USER.d12MemberOnly)
    assert.ok(!memberOnlyDocs.has(DOC.d12), "Membership alone must not grant D12")

    const fullAccessDocs = await readableDocIds(USER.d12FullAccess)
    assert.ok(fullAccessDocs.has(DOC.d12), "Membership + D12 grant must allow D12")
  })

  await runCheck("AUTHZ-05", "Hybrid search RPC search_enterprise_chunks enforces RLS and never leaks restricted/foreign docs", async () => {
    const unauthorizedSearch = await searchChunkDocs(USER.designatedManager, "D11 budget approval 50000 D03 compensation")
    assert.ok(!unauthorizedSearch.has(DOC.d11), "search_enterprise_chunks leaked D11")
    assert.ok(!unauthorizedSearch.has(DOC.d03), "search_enterprise_chunks leaked D03")
    assert.ok(!unauthorizedSearch.has(DOC.d12), "search_enterprise_chunks leaked D12")
    assert.ok(!unauthorizedSearch.has(DOC.unpublishedD04), "search_enterprise_chunks leaked unpublished doc")

    const grantedSearch = await searchChunkDocs(USER.finGranted, "D11 budget approval 50000")
    assert.ok(grantedSearch.has(DOC.d11), "Granted user should retrieve D11 via search_enterprise_chunks")

    const outsiderSearch = await searchChunkDocs(USER.outsider, "D01 handbook")
    assert.equal(outsiderSearch.size, 0, "Foreign org CXO must retrieve 0 chunks")
  })

  await runCheck("AUTHZ-06", "Forged JWT metadata, self-promotion, self-grants, and unauthorized uploads are blocked", async () => {
    const forgedClaims = { app_metadata: { role: "cxo" }, user_metadata: { role: "manager" }, email: "phani9119@gmail.com" }
    await asAuthenticated(
      USER.engEmployee,
      async () => {
        await assert.rejects(
          db.query("update public.organization_employees set role = 'manager' where user_id = $1", [USER.engEmployee]),
          /permission denied|42501/,
        )
      },
      forgedClaims,
    )
    await asAuthenticated(
      USER.engEmployee,
      async () => {
        await assert.rejects(
          db.query(
            `insert into public.document_grants(document_id, project_id, organization_id, project_department_id, is_d12, classification, user_id, recipient_department_id, approved_by, valid_from)
             values ($1,$2,$3,$4,false,'restricted',$5,$6,$7,now())`,
            [DOC.d11, PROJ.fin, ORG_ID, DEPT.fin, USER.engEmployee, DEPT.eng, USER.approver],
          ),
          /permission denied|42501/,
        )
      },
      forgedClaims,
    )
    await asAuthenticated(
      USER.engEmployee,
      async () => {
        await assert.rejects(
          db.query(
            "select * from public.reserve_enterprise_policy($1,$2,$3,'unauth.txt',10,'standard','company')",
            [ORG_ID, DEPT.eng, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
          ),
          /Enterprise upload authorization denied/,
        )
      },
      forgedClaims,
    )
  })

  await runCheck("AUTHZ-07", "E25 fallback RPC enterprise_fallback_documents respects department, company, and anonymous boundaries", async () => {
    const engRows = await asAuthenticated(USER.engEmployee, () =>
      db.query("select code, own_department from public.enterprise_fallback_documents($1) order by code", [ORG_ID]),
    )
    const codes = new Map(engRows.rows.map((r) => [r.code, r.own_department]))
    assert.equal(codes.get("D01"), false, "Engineering employee should receive company-wide D01_custodian_fixed")
    assert.equal(codes.get("D04"), true, "Engineering employee should receive own-department D04")
    assert.ok(!codes.has("D07") && !codes.has("D09"), "Foreign department docs must be excluded from fallback suggestions")
    assert.ok(!codes.has("D03") && !codes.has("D11") && !codes.has("D12"), "Restricted/D12 docs must never appear")

    const anonRows = await asAuthenticated(
      USER.engEmployee,
      () => db.query("select * from public.enterprise_fallback_documents($1)", [ORG_ID]),
      { is_anonymous: "true" },
    )
    assert.equal(anonRows.rows.length, 0, "Anonymous JWT sessions must receive empty fallback list")

    const outsiderRows = await asAuthenticated(USER.outsider, () =>
      db.query("select * from public.enterprise_fallback_documents($1)", [ORG_ID]),
    )
    assert.equal(outsiderRows.rows.length, 0, "Foreign organization employee must receive empty fallback list")
  })

  await runCheck("AUTHZ-08", "E18 search_enterprise_chunks prioritizes D01 opening control chunk via OR-keyword + policy scope without weakening RLS", async () => {
    const res = await asAuthenticated(USER.designatedManager, () =>
      db.query(
        "select id, content from public.search_enterprise_chunks($1::extensions.vector, $2, $3::uuid)",
        [
          `[${[0.9, ...Array(1535).fill(0.01)].join(",")}]`,
          "In D01, who is the document custodian, who is the independent reviewer, and what are the scenario effective date and next review date?",
          ORG_ID,
        ],
      ),
    )
    assert.ok(res.rows.length >= 1, "E18 query must return D01 chunks")
    assert.match(res.rows[0].content, /DOCUMENT CONTROL.*custodian HR Manager/, "D01 opening control chunk must rank #1")
    for (const row of res.rows) {
      assert.doesNotMatch(row.content, /D03 CONFIDENTIAL|D11 DOCUMENT CONTROL|D12 DOCUMENT CONTROL/, "Scoped D01 search must never leak restricted docs")
    }
  })

  await mkdir("artifacts/evaluation", { recursive: true })
  const report = {
    suite: "enterprise_authz_eval",
    runtime: "PGlite + pgvector (isolated disposable database)",
    executed_at: new Date().toISOString(),
    total_checks: checks.length,
    passed_checks: checks.filter((c) => c.status === "PASS").length,
    failed_checks: checks.filter((c) => c.status === "FAIL").length,
    checks,
  }
  await writeFile(path.join("artifacts/evaluation", "enterprise_authz_eval.json"), JSON.stringify(report, null, 2))
  console.log(`PASS: ${report.passed_checks}/${report.total_checks} Enterprise SQL authorization evaluation checks passed.`)
} finally {
  await db.close()
}
