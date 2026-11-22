-- Targeted Enterprise RAG remediation for E25 and E18.
-- 1. E25: Restore wp3_private/public.enterprise_fallback_documents preserving RLS & scopes,
--    including the live custodian-fixed D01 filename.
-- 2. E18: Restore WP9.43 policy-ID scoping, OR-keyword FTS query, and opening control-table
--    chunk priority inside public.search_enterprise_chunks (SECURITY INVOKER, RLS preserved).

begin;
set local lock_timeout = '5s';

create or replace function wp3_private.enterprise_fallback_documents(target_organization_id uuid)
returns table (code text, own_department boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select distinct candidate.code, (p.department_id = e.department_id) as own_department
  from public.organization_employees e
  join public.projects p on p.organization_id = e.organization_id and not p.is_d12
  join public.documents d on d.project_id = p.id
  join (values
    ('D01', 'D01_Revised_Candidate_1_1.pdf'),
    ('D01', 'D01_Revised_Candidate_1_1_custodian_fixed.pdf'),
    ('D02', 'D02_Leave_and_Attendance_Policy_DeccanBridge_Software_Reconciliation_Candidate_1_1.html'),
    ('D04', 'D04_Engineering_Code_Review_Bug_Reporting_and_Incident_SOP_DeccanBridge_Software_Reconciliation_Candidate_1_1.html'),
    ('D05', 'D05_Product_Feature_Intake_and_Prioritization_DeccanBridge_Software_Reconciliation_Candidate_1_1.txt'),
    ('D06', 'D06_Project_Risk_and_Escalation_DeccanBridge_Software_Reconciliation_Candidate_1_1.pdf'),
    ('D07', 'D07_Design_Handoff_and_Accessibility_DeccanBridge_Software_Reconciliation_Candidate_1_1.html'),
    ('D08', 'D08_Equipment_and_Service_Requests_DeccanBridge_Software_Reconciliation_Candidate_1_1.txt'),
    ('D09', 'D09_Brand_and_Campaign_Approval_DeccanBridge_Software_Reconciliation_Candidate_1_1.pdf'),
    ('D10', 'D10_Travel_and_Expense_Reimbursement_DeccanBridge_Software_Reconciliation_Candidate_1_1.html')
  ) candidate(code, filename) on candidate.filename = regexp_replace(d.storage_path, '^.*/', '')
  where e.organization_id = target_organization_id
    and e.user_id = (select auth.uid())
    and e.is_active
    and (select auth.jwt()->>'is_anonymous') is distinct from 'true'
    and d.classification = 'standard'
    and (
      (candidate.code in ('D01', 'D02', 'D08', 'D10') and d.access_scope = 'company')
      or (
        candidate.code in ('D04', 'D05', 'D06', 'D07', 'D09')
        and d.access_scope = 'department'
        and p.department_id = e.department_id
      )
    )
    and wp3_private.can_read_document(d.id, p.id, true)
    and exists (
      select 1 from public.document_chunks c
      where c.document_id = d.id and c.project_id = p.id
    )
$$;

create or replace function public.enterprise_fallback_documents(target_organization_id uuid)
returns table (code text, own_department boolean)
language sql stable security invoker set search_path = pg_catalog, pg_temp as $$
  select * from wp3_private.enterprise_fallback_documents(target_organization_id)
$$;

revoke all on function wp3_private.enterprise_fallback_documents(uuid),
  public.enterprise_fallback_documents(uuid) from public, anon, authenticated, service_role;
grant execute on function wp3_private.enterprise_fallback_documents(uuid),
  public.enterprise_fallback_documents(uuid) to authenticated;

create or replace function public.search_enterprise_chunks(
  query_embedding extensions.vector,
  query_text text,
  target_organization_id uuid
)
returns table (id uuid, content text)
language sql stable security invoker set search_path = pg_catalog, pg_temp as $$
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
    join public.projects p on p.id = c.project_id
    where p.organization_id = target_organization_id
      and exists (
        select 1 from public.organization_employees e
        where e.organization_id = p.organization_id
          and e.user_id = (select auth.uid())
          and e.is_active
      )
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
    where rp.ids is null or e.policy_id = any(rp.ids)
  ),
  terms as (
    select coalesce(
      (
        select case
          when count(*) > 0
          then pg_catalog.to_tsquery('simple', pg_catalog.string_agg(pg_catalog.quote_literal(word), ' | ' order by word))
          else pg_catalog.plainto_tsquery('simple', query_text)
        end
        from (
          -- Remove English stop words while keeping unstemmed tokens matching the 'simple' fts index.
          select distinct lower(token) as word
          from regexp_split_to_table(query_text, '[^[:alnum:]_]+') as token
          where length(token) >= 3
            and pg_catalog.to_tsvector('english', token) <> ''::pg_catalog.tsvector
        ) keywords
      ),
      pg_catalog.plainto_tsquery('simple', query_text)
    ) as query
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
    select e.id, row_number() over (
      order by pg_catalog.ts_rank_cd(e.fts, t.query) desc, e.id
    ) as rank
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

revoke all on function public.search_enterprise_chunks(extensions.vector, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.search_enterprise_chunks(extensions.vector, text, uuid) to authenticated;

commit;
