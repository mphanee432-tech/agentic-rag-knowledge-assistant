begin;

create schema wp4_private;
revoke all on schema wp4_private from public, anon, authenticated, service_role;
grant usage on schema wp4_private to authenticated;

create table wp4_private.security_audit (
  occurred_at timestamptz not null default statement_timestamp(),
  event text not null check (event in ('enterprise_search_hit', 'enterprise_search_empty',
    'enterprise_read_hit', 'enterprise_read_empty',
    'grant_issued', 'grant_revoked', 'employee_deactivated', 'employee_reactivated')),
  actor_id uuid,
  organization_id uuid not null,
  project_id uuid,
  document_id uuid,
  subject_id uuid
);
alter table wp4_private.security_audit enable row level security;
revoke all on wp4_private.security_audit from public, anon, authenticated, service_role;
create index security_audit_occurred_at_idx on wp4_private.security_audit (occurred_at);

create function wp4_private.audit_authority_change()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if tg_table_name = 'organization_employees' then
    insert into wp4_private.security_audit (event, actor_id, organization_id, subject_id)
    values (case when new.is_active then 'employee_reactivated' else 'employee_deactivated' end,
      auth.uid(), new.organization_id, new.user_id);
  elsif tg_op = 'INSERT' or old.revoked_at is distinct from new.revoked_at
      or old.approved_by is distinct from new.approved_by
      or old.valid_from is distinct from new.valid_from or old.expires_at is distinct from new.expires_at then
    insert into wp4_private.security_audit (event, actor_id, organization_id, project_id, document_id, subject_id)
    values (case when new.revoked_at is null and new.approved_by is not null then 'grant_issued' else 'grant_revoked' end,
      auth.uid(), new.organization_id, new.project_id, new.document_id, new.user_id);
  end if;
  return new;
end
$$;

create trigger audit_employee_activity after update of is_active on public.organization_employees
  for each row when (old.is_active is distinct from new.is_active)
  execute function wp4_private.audit_authority_change();
create trigger audit_document_grant after insert or update on public.document_grants
  for each row execute function wp4_private.audit_authority_change();

-- The existing search still runs as its non-bypass role with the caller's JWT.
create function wp4_private.search_and_audit(query_embedding extensions.vector, query_text text, target_project_id uuid)
returns table (id uuid, content text)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  organization uuid;
  matched boolean;
begin
  return query select * from wp3_private.search_chunks(query_embedding, query_text, target_project_id);
  matched := found;
  select p.organization_id into organization from public.projects p where p.id = target_project_id;
  if organization is not null and auth.uid() is not null then
    insert into wp4_private.security_audit (event, actor_id, organization_id, project_id)
    values (case when matched then 'enterprise_search_hit' else 'enterprise_search_empty' end,
      auth.uid(), organization, target_project_id);
  end if;
end
$$;

create or replace function public.search_rag_chunks(query_embedding extensions.vector, query_text text, target_project_id uuid)
returns table (id uuid, content text)
language sql volatile security invoker set search_path = pg_catalog, pg_temp as $$
  select * from wp4_private.search_and_audit(query_embedding, query_text, target_project_id)
$$;

create or replace function wp2b_private.read_enterprise_document(p_document_id uuid)
returns table (chunk_id uuid, content text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  matched boolean;
begin
  return query select c.id, c.content from public.document_chunks c
  where c.document_id = p_document_id and wp3_private.can_read_document(c.document_id, c.project_id, true);
  matched := found;
  insert into wp4_private.security_audit (event, actor_id, organization_id, project_id, document_id)
  select case when matched then 'enterprise_read_hit' else 'enterprise_read_empty' end,
    auth.uid(), p.organization_id, p.id, d.id
  from public.documents d join public.projects p on p.id = d.project_id
  where d.id = p_document_id and p.organization_id is not null and auth.uid() is not null;
end
$$;

create or replace function public.read_enterprise_document(p_document_id uuid)
returns table (chunk_id uuid, content text)
language sql volatile security invoker set search_path = pg_catalog, pg_temp as $$
  select * from wp2b_private.read_enterprise_document(p_document_id)
$$;

set local role wp3_retrieval;
revoke execute on function wp3_private.search_chunks(extensions.vector, text, uuid) from authenticated;
grant execute on function wp3_private.search_chunks(extensions.vector, text, uuid) to session_user;
reset role;
revoke all on all functions in schema wp4_private from public, anon, authenticated, service_role;
grant execute on function wp4_private.search_and_audit(extensions.vector, text, uuid) to authenticated;

create function wp4_private.prune_security_audit()
returns void language sql set search_path = pg_catalog, pg_temp as $$
  delete from wp4_private.security_audit where occurred_at <= statement_timestamp() - interval '8760 hours'
$$;
revoke all on function wp4_private.prune_security_audit() from public, anon, authenticated, service_role;
-- Idle databases still need expiry. This job performs only a local SQL delete.
create extension if not exists pg_cron;
select cron.schedule('wp4-security-audit-retention', '17 3 * * *', 'select wp4_private.prune_security_audit()');

commit;
