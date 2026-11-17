begin;
set local lock_timeout = '5s';

grant create on schema wp3_private to wp3_retrieval;

create or replace function wp3_private.search_chunks(
  query_embedding extensions.vector,
  query_text text,
  target_project_id uuid,
  target_organization_id uuid
)
returns table (id uuid, content text)
language sql stable security definer
set search_path = pg_catalog, pg_temp
set row_security = on
as $$
  with raw_eligible as materialized (
    select
      c.id,
      c.document_id,
      c.content,
      c.embedding,
      c.fts,
      case
        when left(c.content, 800) ~* '(DOCUMENT CONTROL|Policy introduction and control|Classification\s*(/|:))'
        then upper((regexp_match(left(c.content, 300), '\m(D(?:0[1-9]|1[0-2]))\M', 'i'))[1])
        else null
      end as opening_policy_id
    from public.document_chunks c
    where (c.project_id = target_project_id
      or c.project_id in (select wp3_private.organization_projects(target_organization_id)))
      and (select row_security_active('public.document_chunks'))
      and extensions.vector_dims(query_embedding) = 1536
  ),
  doc_policies as (
    select distinct r.document_id, r.opening_policy_id as policy_id
    from raw_eligible r
    where r.opening_policy_id is not null
  ),
  canonical_policy_docs as (
    select distinct on (dp.policy_id) dp.policy_id, dp.document_id
    from doc_policies dp
    order by dp.policy_id, dp.document_id
  ),
  eligible as (
    select
      r.id,
      r.document_id,
      r.content,
      r.embedding,
      r.fts,
      dp.policy_id,
      (r.opening_policy_id is not null) as is_opening_chunk
    from raw_eligible r
    left join doc_policies dp on dp.document_id = r.document_id
    where dp.policy_id is null
      or exists (
        select 1 from canonical_policy_docs cpd
        where cpd.policy_id = dp.policy_id and cpd.document_id = r.document_id
      )
  ),
  requested_policies as (
    select array_agg(distinct upper(m[1])) as ids
    from regexp_matches(query_text, '\m(D(?:0[1-9]|1[0-2]))\M', 'gi') as m
  ),
  scoped_eligible as (
    select e.*
    from eligible e
    cross join requested_policies rp
    where (target_organization_id is null and not exists (select 1 from doc_policies))
      or rp.ids is null
      or e.policy_id = any(rp.ids)
  ),
  terms as (
    select plainto_tsquery('simple', query_text) as query
  ),
  dense as (
    select e.id, row_number() over (
      order by e.embedding operator(extensions.<=>) query_embedding, e.id
    ) as rank
    from scoped_eligible e
    order by rank
    limit 50
  ),
  sparse as (
    select e.id, row_number() over (order by ts_rank_cd(e.fts, t.query) desc, e.id) as rank
    from scoped_eligible e cross join terms t
    where e.fts @@ t.query
    order by rank
    limit 50
  ),
  opening as (
    select e.id, 1 as bonus
    from scoped_eligible e
    cross join requested_policies rp
    where rp.ids is not null
      and e.policy_id = any(rp.ids)
      and e.is_opening_chunk
  )
  select e.id, e.content
  from dense d
  full join sparse s on s.id = d.id
  full join opening o on o.id = coalesce(d.id, s.id)
  join scoped_eligible e on e.id = coalesce(d.id, s.id, o.id)
  order by
    coalesce(o.bonus, 0) desc,
    coalesce(1.0 / (60 + d.rank), 0) + coalesce(1.0 / (60 + s.rank), 0) desc,
    e.id
  limit 8
$$;

alter function wp3_private.search_chunks(extensions.vector, text, uuid, uuid) owner to wp3_retrieval;
revoke create on schema wp3_private from wp3_retrieval;
revoke all on function wp3_private.search_chunks(extensions.vector, text, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function wp3_private.search_chunks(extensions.vector, text, uuid, uuid) to session_user;

commit;
