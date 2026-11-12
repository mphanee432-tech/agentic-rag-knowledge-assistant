begin;
set local lock_timeout = '5s';

-- Ranking can read only these columns and still runs under RLS with the caller's JWT.
create role wp3_retrieval nologin noinherit nobypassrls;
grant wp3_retrieval to current_user with set true;
create schema wp3_private;
revoke all on schema wp3_private from public, anon, authenticated, service_role;
grant usage on schema wp3_private to authenticated, wp3_retrieval;
grant usage on schema public, extensions to wp3_retrieval;
grant select (id, user_id) on public.projects to wp3_retrieval;
grant select (id, document_id, project_id, content, embedding, fts) on public.document_chunks to wp3_retrieval;

-- Authority tables stay private. Both the WP2B read and RLS use this decision.
create function wp3_private.can_read_document(p_document_id uuid, p_project_id uuid, p_enterprise_only boolean)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1
    from public.documents d
    join public.projects p on p.id = d.project_id
    left join public.organization_employees e on e.organization_id = p.organization_id
      and e.user_id = (select auth.uid()) and e.is_active
    left join public.document_grants g on g.document_id = d.id and g.user_id = e.user_id
      and g.approved_by is not null
      and public.enterprise_access_window_is_current(g.valid_from, g.expires_at, g.revoked_at)
    left join public.project_memberships m on m.project_id = p.id and m.user_id = e.user_id
      and public.enterprise_access_window_is_current(m.valid_from, m.expires_at, m.revoked_at)
    where d.id = p_document_id and p.id = p_project_id and d.status = 'indexed'
      and case
        when p.organization_id is null then not p_enterprise_only and p.user_id = (select auth.uid())
        when e.user_id is null or not d.is_published then false
        when p.is_d12 then m.user_id is not null and g.user_id is not null
        when d.classification = 'restricted' then g.user_id is not null
        when d.classification = 'standard' then
          d.access_scope = 'company' or e.department_id = p.department_id or g.user_id is not null
        else false
      end
  )
$$;

create or replace function wp2b_private.read_enterprise_document(p_document_id uuid)
returns table (chunk_id uuid, content text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select c.id, c.content
  from public.document_chunks c
  where c.document_id = p_document_id
    and wp3_private.can_read_document(c.document_id, c.project_id, true)
$$;

-- The restrictive boundary still applies even when the legacy permissive policy matches.
alter policy owner_boundary on public.document_chunks using (
  current_user = 'wp3_retrieval'
  or exists (select 1 from public.projects p where p.id = document_chunks.project_id and p.user_id = auth.uid())
);
create policy rag_retrieval_boundary on public.document_chunks as restrictive
  for select to wp3_retrieval using (wp3_private.can_read_document(document_id, project_id, false));
create policy rag_retrieval_select on public.document_chunks for select to wp3_retrieval using (true);

create function wp3_private.search_chunks(query_embedding extensions.vector, query_text text, target_project_id uuid)
returns table (id uuid, content text)
language sql stable security definer set search_path = pg_catalog, pg_temp set row_security = on as $$
  with eligible as materialized (
    select c.id, c.content, c.embedding, c.fts
    from public.document_chunks c
    where c.project_id = target_project_id
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

create function wp3_private.rag_chunks_still_visible(target_project_id uuid, chunk_ids uuid[])
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp set row_security = on as $$
  select cardinality(chunk_ids) between 1 and 8
    and (select row_security_active('public.document_chunks'))
    and (select count(*) from public.document_chunks c
         where c.project_id = target_project_id and c.id = any(chunk_ids)) = cardinality(chunk_ids)
$$;

-- Only projects with currently readable documents are discoverable.
create function wp3_private.enterprise_chat_projects(target_project_id uuid)
returns table (id uuid, name text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select p.id, p.name
  from public.organization_employees e
  join public.projects p on p.organization_id = e.organization_id
  where e.user_id = (select auth.uid()) and e.is_active
    and (target_project_id is null or p.id = target_project_id)
    and exists (select 1 from public.documents d
      where d.project_id = p.id and wp3_private.can_read_document(d.id, p.id, true))
  order by p.name, p.id
$$;

create function public.search_rag_chunks(query_embedding extensions.vector, query_text text, target_project_id uuid)
returns table (id uuid, content text)
language sql stable security invoker set search_path = pg_catalog, pg_temp as $$
  select * from wp3_private.search_chunks(query_embedding, query_text, target_project_id)
$$;

create function public.rag_chunks_still_visible(target_project_id uuid, chunk_ids uuid[])
returns boolean language sql stable security invoker set search_path = pg_catalog, pg_temp as $$
  select wp3_private.rag_chunks_still_visible(target_project_id, chunk_ids)
$$;

create function public.enterprise_chat_projects(target_project_id uuid default null)
returns table (id uuid, name text)
language sql stable security invoker set search_path = pg_catalog, pg_temp as $$
  select * from wp3_private.enterprise_chat_projects(target_project_id)
$$;

revoke all on all functions in schema wp3_private from public, anon, authenticated, service_role;
revoke all on function public.search_rag_chunks(extensions.vector, text, uuid),
  public.rag_chunks_still_visible(uuid, uuid[]), public.enterprise_chat_projects(uuid)
  from public, anon, authenticated, service_role;

grant execute on function wp3_private.can_read_document(uuid, uuid, boolean) to wp3_retrieval;
grant execute on function wp3_private.search_chunks(extensions.vector, text, uuid),
  wp3_private.rag_chunks_still_visible(uuid, uuid[]), wp3_private.enterprise_chat_projects(uuid),
  public.search_rag_chunks(extensions.vector, text, uuid),
  public.rag_chunks_still_visible(uuid, uuid[]), public.enterprise_chat_projects(uuid)
  to authenticated;

grant create on schema wp3_private to wp3_retrieval;
alter function wp3_private.search_chunks(extensions.vector, text, uuid) owner to wp3_retrieval;
alter function wp3_private.rag_chunks_still_visible(uuid, uuid[]) owner to wp3_retrieval;
revoke create on schema wp3_private from wp3_retrieval;

commit;
