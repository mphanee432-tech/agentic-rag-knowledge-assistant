// Local PostgreSQL/pgvector only. This script never loads credentials or connects to Supabase.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { PGlite } from "../node_modules/.cache/ingestion-sql-runtime/node_modules/@electric-sql/pglite/dist/index.js"
import { vector } from "../node_modules/.cache/ingestion-sql-runtime/node_modules/@electric-sql/pglite-pgvector/dist/index.js"

const db = new PGlite({ extensions: { vector } })
const migration = "supabase/migrations/20261121122157_restore_agentic_enterprise_upload_contracts.sql"
try {
  await db.exec(await readFile("supabase/tests/fixtures/agentic_enterprise_upload_schema.sql", "utf8"))
  const retrieval = await readFile("supabase/migrations/20261112034417_wp3_secure_rag_retrieval.sql", "utf8")
  const start = retrieval.indexOf("create function wp3_private.can_read_document(")
  await db.exec(retrieval.slice(start, retrieval.indexOf("$$;", start) + 3))
  await db.exec(`
    grant execute on function wp3_private.can_read_document(uuid,uuid,boolean) to authenticated;
    create policy enterprise_documents_allowed on public.documents for select to authenticated
      using(wp3_private.can_read_document(id,project_id,true));
    create policy enterprise_chunks_allowed on public.document_chunks for select to authenticated
      using(wp3_private.can_read_document(document_id,project_id,true));
  `)
  const recovery = await readFile("supabase/migrations/202611040001_automatic_ingestion_recovery.sql", "utf8")
  for (const name of ["claim_document_ingestion", "fail_document_ingestion", "finish_document_ingestion"]) {
    const start = recovery.indexOf(`create or replace function public.${name}(`)
    await db.exec(recovery.slice(start, recovery.indexOf("end $$;", start) + 7))
    const signature = name === "claim_document_ingestion" ? "uuid,uuid"
      : name === "fail_document_ingestion" ? "uuid,uuid,text,boolean" : "uuid,uuid,jsonb"
    await db.exec(`revoke all on function public.${name}(${signature}) from public,anon,authenticated;
      grant execute on function public.${name}(${signature}) to service_role;`)
  }
  const snapshot = async () => (await db.query(`select
    (select jsonb_agg(row_to_json(p) order by tablename,policyname) from pg_policies p where schemaname='public') as policies,
    (select jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(oid),'acl',proacl::text) order by proname)
      from pg_proc where proname in ('claim_document_ingestion','fail_document_ingestion','finish_document_ingestion')) as worker,
    (select jsonb_agg(jsonb_build_object('name',relname,'rls',relrowsecurity,'acl',relacl::text) order by relname)
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r') as tables
  `)).rows[0]
  const before = await snapshot()
  const sql = await readFile(migration, "utf8")
  await db.exec("grant update(role) on public.organization_employees to authenticated")
  await assert.rejects(db.exec(sql), /Authority tables must not be writable/)
  await db.exec("rollback; revoke update(role) on public.organization_employees from authenticated")
  await db.exec("alter table public.documents disable row level security")
  await assert.rejects(db.exec(sql), /Expected the reviewed Agentic Enterprise RLS baseline/)
  await db.exec("rollback; alter table public.documents enable row level security")
  const { rows: [{ definition }] } = await db.query("select pg_get_functiondef('public.enterprise_copilot_context(uuid)'::regprocedure) as definition")
  await db.exec(definition.replace("e.organization_id,false", "e.organization_id,true"))
  await assert.rejects(db.exec(sql), /Expected the reviewed clone context stub/)
  await db.exec("rollback")
  await db.exec(definition)
  await db.exec(sql)
  assert.deepEqual(await snapshot(), before, "Restoration must preserve RLS and worker definitions")
  await db.exec(await readFile("supabase/tests/enterprise_upload_contracts.sql", "utf8"))
  console.log("PASS: Enterprise authorization, validation, duplicate reservations, publication, RLS and worker compatibility SQL assertions")
  console.log("PASS: restoration leaves RLS policies and ingestion worker definitions unchanged")
  await db.exec(`
    insert into auth.users(id,email) values('23940244-8991-4d13-bc25-1c8e3a6cf5e2','phani9119@gmail.com');
    insert into public.organizations(id,name) values('c0000000-0000-4000-8000-000000000001','Local role-assignment fixture');
    insert into public.departments(organization_id,id,name) values
      ('c0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000002','Engineering');
    insert into public.organization_employees(organization_id,user_id,department_id,role,is_active) values
      ('c0000000-0000-4000-8000-000000000001','23940244-8991-4d13-bc25-1c8e3a6cf5e2','c0000000-0000-4000-8000-000000000002','employee',true);
    insert into public.projects(id,organization_id,department_id,is_d12,name) values
      ('a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000002',false,'Local fixture');
    insert into public.documents(project_id,storage_path,status,is_published,classification,access_scope) values
      ('a0000000-0000-4000-8000-000000000001','fixture/standard.txt','indexed',true,'standard','department'),
      ('a0000000-0000-4000-8000-000000000001','fixture/restricted.txt','indexed',true,'restricted','department');
  `)
  const roleAction = await readFile("supabase/ingestion/authorize_designated_enterprise_uploader.sql", "utf8")
  await assert.rejects(db.exec(roleAction), /verified designated Auth identity/)
  await db.exec("rollback; update auth.users set email_confirmed_at=now()")
  await db.exec("set role authenticated")
  await assert.rejects(db.exec(roleAction), /approved database administrator/)
  await db.exec("rollback; reset role")
  const visibility = async () => {
    await db.exec("begin; set local role authenticated; select set_config('request.jwt.claims','{\"sub\":\"23940244-8991-4d13-bc25-1c8e3a6cf5e2\"}',true)")
    const result = await db.query("select id from public.documents order by id")
    await db.exec("rollback")
    return result.rows
  }
  const visibleBefore = await visibility()
  await db.exec(roleAction)
  await db.exec(roleAction)
  await db.exec("update public.organization_employees set role='cxo'")
  await db.exec(roleAction)
  assert.deepEqual(await visibility(), visibleBefore, "Manager assignment must not widen document read access")
  const { rows: [assignment] } = await db.query(`select
    (select role from public.organization_employees) as role,
    (select count(*)::int from public.organization_employees) as memberships,
    (select count(*)::int from public.document_grants) as grants,
    (select count(*)::int from public.project_memberships) as project_memberships`)
  assert.deepEqual(assignment, { role: "manager", memberships: 1, grants: 0, project_memberships: 0 })
  console.log("PASS: reviewed administrator assignment is verified, non-self-service, idempotent and grants no document access")
} finally {
  await db.close()
}
