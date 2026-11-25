-- REVIEW ONLY: target agentic-enterprise-rag (ldkxyleqfbovqpkpoyek), never v1 or Personal.
-- Restores RPCs without changing employees, corpus rows, RLS, worker functions or automation.
begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regnamespace('wp3_private') is null or
    (select count(*) from pg_class where oid in (
      'public.projects'::regclass, 'public.documents'::regclass, 'public.document_chunks'::regclass,
      'public.organizations'::regclass, 'public.departments'::regclass,
      'public.organization_employees'::regclass, 'public.document_grants'::regclass,
      'public.project_memberships'::regclass
    ) and relrowsecurity) <> 8 then
    raise exception 'Expected the reviewed Agentic Enterprise RLS baseline';
  end if;
  if exists (
    select 1 from unnest(array['anon','authenticated']) r
    cross join unnest(array['organization_employees','document_grants','project_memberships']) t
    where has_table_privilege(r, 'public.' || t, 'INSERT,UPDATE,DELETE,TRUNCATE')
      or has_any_column_privilege(r, 'public.' || t, 'INSERT,UPDATE')
  ) then
    raise exception 'Authority tables must not be writable by API callers';
  end if;
  if not exists (select 1 from pg_proc where oid = to_regprocedure('public.enterprise_copilot_context(uuid)')
      and not prosecdef and prosrc ~* 'select[[:space:]]+e[.]organization_id[[:space:]]*,[[:space:]]*false') then
    raise exception 'Expected the reviewed clone context stub; review any existing context implementation';
  end if;
end
$$;

create function wp3_private.can_upload_enterprise_policy(p_project_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1 from public.projects p
    join public.organization_employees e on e.organization_id = p.organization_id
      and e.user_id = (select auth.uid()) and e.is_active and e.role in ('manager','cxo')
    join auth.users u on u.id = e.user_id
    -- Retain the reviewed v1 designated-uploader gate; role alone is insufficient.
    where p.id = p_project_id and p.organization_id is not null and u.email = 'phani9119@gmail.com'
  )
$$;

create function public.can_upload_enterprise_policy(p_project_id uuid)
returns boolean language sql stable security invoker
set search_path = pg_catalog, pg_temp as $$
  select wp3_private.can_upload_enterprise_policy(p_project_id)
$$;

create function wp3_private.reserve_enterprise_policy(
  target_organization_id uuid, target_department_id uuid, p_document_id uuid,
  p_filename text, p_expected_size bigint, p_classification text, p_access_scope text
)
returns table (project_id uuid, storage_path text)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  department_name text;
  policy_project uuid;
  policy_path text;
begin
  if not exists (select 1 from public.projects p where p.organization_id = target_organization_id
      and wp3_private.can_upload_enterprise_policy(p.id)) then
    raise exception 'Enterprise upload authorization denied' using errcode = '42501';
  end if;
  if p_document_id is null or p_filename is null or length(p_filename) > 200
      or p_filename !~* '^[a-z0-9._-]+[.](pdf|html|txt)$'
      or p_expected_size is null or p_expected_size not between 1 and 26214400
      or p_classification is null or p_classification not in ('standard','restricted')
      or p_access_scope is null or p_access_scope not in ('department','company')
      or (p_classification = 'restricted' and p_access_scope <> 'department') then
    raise exception 'Invalid policy upload' using errcode = '22023';
  end if;
  select d.name into department_name from public.departments d
    where d.organization_id = target_organization_id and d.id = target_department_id for update;
  if not found then
    raise exception 'Invalid department' using errcode = '22023';
  end if;
  select p.id into policy_project from public.projects p
    where p.organization_id = target_organization_id and p.department_id = target_department_id and not p.is_d12
    order by p.created_at, p.id limit 1 for share;
  if not found then
    insert into public.projects (organization_id,department_id,is_d12,name)
      values (target_organization_id,target_department_id,false,department_name || ' Knowledge Base')
      returning id into policy_project;
  end if;
  -- Hold membership and identity facts against concurrent role/email revocation, then recheck.
  perform 1 from public.organization_employees e join auth.users u on u.id = e.user_id
    where e.organization_id = target_organization_id and e.user_id = (select auth.uid()) for share of e,u;
  if not wp3_private.can_upload_enterprise_policy(policy_project) then
    raise exception 'Enterprise upload authorization denied' using errcode = '42501';
  end if;
  policy_path := 'enterprise/' || policy_project || '/' || p_document_id || '/' || p_filename;
  insert into public.documents (id,project_id,storage_path,status,expected_size,is_published,classification,access_scope)
    values (p_document_id,policy_project,policy_path,'pending_upload',p_expected_size,false,p_classification,p_access_scope);
  return query select policy_project,policy_path;
end
$$;

create function public.reserve_enterprise_policy(
  target_organization_id uuid, target_department_id uuid, p_document_id uuid,
  p_filename text, p_expected_size bigint, p_classification text, p_access_scope text
)
returns table (project_id uuid, storage_path text)
language sql security invoker set search_path = pg_catalog, pg_temp as $$
  select * from wp3_private.reserve_enterprise_policy(target_organization_id,target_department_id,
    p_document_id,p_filename,p_expected_size,p_classification,p_access_scope)
$$;

create function wp3_private.publish_enterprise_document(p_document_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  doc record;
  org uuid;
begin
  select d.id,d.project_id,d.status,d.is_published into doc
    from public.documents d where d.id = p_document_id for update;
  if not found then
    raise exception 'Enterprise publish authorization denied' using errcode = '42501';
  end if;
  select p.organization_id into org from public.projects p where p.id = doc.project_id for share;
  perform 1 from public.organization_employees e join auth.users u on u.id = e.user_id
    where e.organization_id = org and e.user_id = (select auth.uid()) for share of e,u;
  if not wp3_private.can_upload_enterprise_policy(doc.project_id) then
    raise exception 'Enterprise publish authorization denied' using errcode = '42501';
  end if;
  if doc.status <> 'indexed'
      or not exists (select 1 from public.document_chunks c where c.document_id = doc.id and c.project_id = doc.project_id)
      or exists (select 1 from public.document_chunks c where c.document_id = doc.id and c.project_id <> doc.project_id) then
    raise exception 'Cannot publish incomplete or non-indexed document' using errcode = '55000';
  end if;
  if not doc.is_published then
    update public.documents set is_published = true where id = doc.id;
  end if;
end
$$;

create function public.publish_enterprise_document(p_document_id uuid)
returns void language sql security invoker set search_path = pg_catalog, pg_temp as $$
  select wp3_private.publish_enterprise_document(p_document_id)
$$;

-- The clone's context returned a constant false, and its department-options RPC was missing.
create or replace function public.enterprise_copilot_context(target_organization_id uuid default null)
returns table (organization_id uuid, can_upload_policy boolean)
language sql stable security invoker set search_path = pg_catalog, pg_temp as $$
  select e.organization_id, exists (select 1 from public.projects p
    where p.organization_id = e.organization_id and public.can_upload_enterprise_policy(p.id))
  from public.organization_employees e
  where e.user_id = (select auth.uid()) and e.is_active
    and (target_organization_id is null or e.organization_id = target_organization_id)
  order by e.organization_id limit 1
$$;

create function public.enterprise_policy_departments(target_organization_id uuid)
returns table (id uuid, name text)
language sql stable security invoker set search_path = pg_catalog, pg_temp as $$
  select d.id,d.name from public.departments d
  where d.organization_id = target_organization_id and exists (
    select 1 from public.enterprise_copilot_context(target_organization_id) c
    where c.organization_id = d.organization_id and c.can_upload_policy
  ) order by d.name,d.id
$$;

revoke all on function wp3_private.can_upload_enterprise_policy(uuid),
  wp3_private.reserve_enterprise_policy(uuid,uuid,uuid,text,bigint,text,text),
  wp3_private.publish_enterprise_document(uuid), public.can_upload_enterprise_policy(uuid),
  public.reserve_enterprise_policy(uuid,uuid,uuid,text,bigint,text,text), public.publish_enterprise_document(uuid),
  public.enterprise_copilot_context(uuid), public.enterprise_policy_departments(uuid)
  from public,anon,authenticated,service_role;
grant usage on schema wp3_private to authenticated;
grant execute on function wp3_private.can_upload_enterprise_policy(uuid),
  wp3_private.reserve_enterprise_policy(uuid,uuid,uuid,text,bigint,text,text),
  wp3_private.publish_enterprise_document(uuid), public.can_upload_enterprise_policy(uuid),
  public.reserve_enterprise_policy(uuid,uuid,uuid,text,bigint,text,text), public.publish_enterprise_document(uuid),
  public.enterprise_copilot_context(uuid), public.enterprise_policy_departments(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
