begin;
set local lock_timeout = '5s';

create function wp3_private.organization_projects(target_organization_id uuid)
returns setof uuid
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select p.id
  from public.projects p
  join public.organization_employees e on e.organization_id = p.organization_id
  where p.organization_id = target_organization_id
    and e.user_id = (select auth.uid()) and e.is_active
$$;

-- Both entry points use the same RLS-filtered candidate set and ranking.
create function wp3_private.search_chunks(query_embedding extensions.vector, query_text text,
  target_project_id uuid, target_organization_id uuid)
returns table (id uuid, content text)
language sql stable security definer set search_path = pg_catalog, pg_temp set row_security = on as $$
  with eligible as materialized (
    select c.id, c.content, c.embedding, c.fts
    from public.document_chunks c
    where (c.project_id = target_project_id
      or c.project_id in (select wp3_private.organization_projects(target_organization_id)))
      and (select row_security_active('public.document_chunks'))
      and extensions.vector_dims(query_embedding) = 1536
  ), terms as (
    select plainto_tsquery('simple', query_text) as query
  ), dense as (
    select e.id, row_number() over (
      order by e.embedding operator(extensions.<=>) query_embedding, e.id
    ) as rank
    from eligible e
    order by rank
    limit 50
  ), sparse as (
    select e.id, row_number() over (order by ts_rank_cd(e.fts, t.query) desc, e.id) as rank
    from eligible e cross join terms t
    where e.fts @@ t.query
    order by rank
    limit 50
  )
  select e.id, e.content
  from dense d full join sparse s on s.id = d.id
  join eligible e on e.id = coalesce(d.id, s.id)
  order by coalesce(1.0 / (60 + d.rank), 0) + coalesce(1.0 / (60 + s.rank), 0) desc, e.id
  limit 8
$$;

create or replace function wp3_private.search_chunks(query_embedding extensions.vector, query_text text, target_project_id uuid)
returns table (id uuid, content text)
language sql stable security definer set search_path = pg_catalog, pg_temp set row_security = on as $$
  select * from wp3_private.search_chunks(query_embedding, query_text, target_project_id, null)
$$;

create function wp4_private.search_organization_and_audit(query_embedding extensions.vector, query_text text,
  target_organization_id uuid)
returns table (id uuid, content text)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  matched boolean;
begin
  if not exists (select 1 from public.organization_employees e
      where e.organization_id = target_organization_id and e.user_id = auth.uid() and e.is_active) then
    return;
  end if;
  return query select * from wp3_private.search_chunks(query_embedding, query_text, null, target_organization_id);
  matched := found;
  insert into wp4_private.security_audit (event, actor_id, organization_id)
  values (case when matched then 'enterprise_search_hit' else 'enterprise_search_empty' end,
    auth.uid(), target_organization_id);
end
$$;

create function public.search_enterprise_chunks(query_embedding extensions.vector, query_text text, target_organization_id uuid)
returns table (id uuid, content text)
language sql volatile security invoker set search_path = pg_catalog, pg_temp as $$
  select * from wp4_private.search_organization_and_audit(query_embedding, query_text, target_organization_id)
$$;

create function wp3_private.enterprise_chunks_still_visible(target_organization_id uuid, chunk_ids uuid[])
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp set row_security = on as $$
  select cardinality(chunk_ids) between 1 and 8
    and (select row_security_active('public.document_chunks'))
    and (select count(*) from public.document_chunks c
      where c.id = any(chunk_ids)
        and c.project_id in (select wp3_private.organization_projects(target_organization_id))) = cardinality(chunk_ids)
$$;

create function public.enterprise_chunks_still_visible(target_organization_id uuid, chunk_ids uuid[])
returns boolean language sql stable security invoker set search_path = pg_catalog, pg_temp as $$
  select wp3_private.enterprise_chunks_still_visible(target_organization_id, chunk_ids)
$$;

-- Resolve membership even when the employee has no readable policies yet.
create function wp3_private.enterprise_copilot_context(target_organization_id uuid)
returns table (organization_id uuid, can_upload_policy boolean)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  return query
    select e.organization_id, case when e.role in ('manager', 'cxo')
      and to_regprocedure('public.can_upload_enterprise_policy(uuid)') is not null then exists (
        select 1 from public.projects p where p.organization_id = e.organization_id
          and public.can_upload_enterprise_policy(p.id)
      ) else false end
    from public.organization_employees e
    where e.user_id = (select auth.uid()) and e.is_active
      and (target_organization_id is null or e.organization_id = target_organization_id)
    order by e.organization_id
    limit 1;
end
$$;

create function public.enterprise_copilot_context(target_organization_id uuid)
returns table (organization_id uuid, can_upload_policy boolean)
language sql stable security invoker set search_path = pg_catalog, pg_temp as $$
  select * from wp3_private.enterprise_copilot_context(target_organization_id)
$$;

create function wp3_private.enterprise_policy_departments(target_organization_id uuid)
returns table (id uuid, name text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select d.id, d.name from public.departments d
  join wp3_private.enterprise_copilot_context(target_organization_id) c
    on c.organization_id = d.organization_id and c.can_upload_policy
  where d.organization_id = target_organization_id
  order by d.name, d.id
$$;

create function public.enterprise_policy_departments(target_organization_id uuid)
returns table (id uuid, name text)
language sql stable security invoker set search_path = pg_catalog, pg_temp as $$
  select * from wp3_private.enterprise_policy_departments(target_organization_id)
$$;

create function wp3_private.reserve_enterprise_policy(target_organization_id uuid, target_department_id uuid,
  p_document_id uuid, p_filename text, p_expected_size bigint, p_classification text, p_access_scope text)
returns table (project_id uuid, storage_path text)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  department_name text;
  policy_project uuid;
  policy_path text;
begin
  if not coalesce((select c.can_upload_policy from wp3_private.enterprise_copilot_context(target_organization_id) c
      where c.organization_id = target_organization_id), false) then
    raise exception 'Enterprise upload authorization denied' using errcode = '42501';
  end if;
  if p_document_id is null or p_filename is null or length(p_filename) > 200
      or p_filename !~* '^[a-z0-9._-]+\.(pdf|html|txt)$'
      or p_expected_size is null or p_expected_size not between 1 and 26214400
      or p_classification is null or p_classification not in ('standard', 'restricted')
      or p_access_scope is null or p_access_scope not in ('department', 'company')
      or (p_classification = 'restricted' and p_access_scope = 'company') then
    raise exception 'Invalid policy upload' using errcode = '22023';
  end if;

  -- Lock the department so concurrent first uploads reuse one backing project.
  select d.name into department_name from public.departments d
    where d.organization_id = target_organization_id and d.id = target_department_id for update;
  if not found then
    raise exception 'Invalid department' using errcode = '22023';
  end if;
  select p.id into policy_project from public.projects p
    where p.organization_id = target_organization_id and p.department_id = target_department_id and not p.is_d12
    order by p.created_at, p.id limit 1 for share;
  if not found then
    insert into public.projects (organization_id, department_id, is_d12, name)
      values (target_organization_id, target_department_id, false, department_name || ' Knowledge Base')
      returning id into policy_project;
  end if;

  policy_path := 'enterprise/' || policy_project || '/' || p_document_id || '/' || p_filename;
  perform public.reserve_enterprise_document(policy_project, p_document_id, policy_path,
    p_expected_size, p_classification, p_access_scope);
  return query select policy_project, policy_path;
end
$$;

create function public.reserve_enterprise_policy(target_organization_id uuid, target_department_id uuid,
  p_document_id uuid, p_filename text, p_expected_size bigint, p_classification text, p_access_scope text)
returns table (project_id uuid, storage_path text)
language sql volatile security invoker set search_path = pg_catalog, pg_temp as $$
  select * from wp3_private.reserve_enterprise_policy(target_organization_id, target_department_id,
    p_document_id, p_filename, p_expected_size, p_classification, p_access_scope)
$$;

revoke all on function wp3_private.organization_projects(uuid),
  wp3_private.search_chunks(extensions.vector, text, uuid, uuid),
  wp4_private.search_organization_and_audit(extensions.vector, text, uuid),
  public.search_enterprise_chunks(extensions.vector, text, uuid),
  wp3_private.enterprise_chunks_still_visible(uuid, uuid[]), public.enterprise_chunks_still_visible(uuid, uuid[]),
  wp3_private.enterprise_copilot_context(uuid), public.enterprise_copilot_context(uuid),
  wp3_private.enterprise_policy_departments(uuid), public.enterprise_policy_departments(uuid),
  wp3_private.reserve_enterprise_policy(uuid, uuid, uuid, text, bigint, text, text),
  public.reserve_enterprise_policy(uuid, uuid, uuid, text, bigint, text, text)
  from public, anon, authenticated, service_role;

grant execute on function wp3_private.organization_projects(uuid) to wp3_retrieval;
grant execute on function wp4_private.search_organization_and_audit(extensions.vector, text, uuid),
  public.search_enterprise_chunks(extensions.vector, text, uuid),
  wp3_private.enterprise_chunks_still_visible(uuid, uuid[]), public.enterprise_chunks_still_visible(uuid, uuid[]),
  wp3_private.enterprise_copilot_context(uuid), public.enterprise_copilot_context(uuid),
  wp3_private.enterprise_policy_departments(uuid), public.enterprise_policy_departments(uuid),
  wp3_private.reserve_enterprise_policy(uuid, uuid, uuid, text, bigint, text, text),
  public.reserve_enterprise_policy(uuid, uuid, uuid, text, bigint, text, text)
  to authenticated;

grant create on schema wp3_private to wp3_retrieval;
alter function wp3_private.search_chunks(extensions.vector, text, uuid, uuid) owner to wp3_retrieval;
alter function wp3_private.enterprise_chunks_still_visible(uuid, uuid[]) owner to wp3_retrieval;
revoke create on schema wp3_private from wp3_retrieval;
grant execute on function wp3_private.search_chunks(extensions.vector, text, uuid, uuid) to session_user;

commit;
