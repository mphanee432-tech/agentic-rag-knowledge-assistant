-- Run after WP3 on an isolated database. All fixtures roll back.
begin;
set local plpgsql.check_asserts = on;

create function pg_temp.as_employee(actor uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);
  assert current_user = 'authenticated' and auth.uid() = actor
    and row_security_active('public.document_chunks'), 'Authenticated RLS context is required';
end
$$;

create function pg_temp.expect_denied(command text)
returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then
    return;
  end;
  raise exception 'Unexpected access to the RAG RPC';
end
$$;

do $$
declare
  org uuid := gen_random_uuid();
  home uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  owner_user uuid := gen_random_uuid();
  reader_user uuid := gen_random_uuid();
  manager_user uuid := gen_random_uuid();
  inactive_user uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  shared uuid := gen_random_uuid();
  d12 uuid := gen_random_uuid();
  personal uuid := gen_random_uuid();
  company_doc uuid := gen_random_uuid();
  department_doc uuid := gen_random_uuid();
  restricted_doc uuid := gen_random_uuid();
  draft_doc uuid := gen_random_uuid();
  unindexed_doc uuid := gen_random_uuid();
  d12_doc uuid := gen_random_uuid();
  personal_doc uuid := gen_random_uuid();
  lexical_hit uuid := gen_random_uuid();
  dense_hit uuid := gen_random_uuid();
  department_hit uuid := gen_random_uuid();
  restricted_hit uuid := gen_random_uuid();
  d12_hit uuid := gen_random_uuid();
  personal_hit uuid := gen_random_uuid();
  result_ids uuid[];
  current_at timestamptz := statement_timestamp();
  later timestamptz := current_at + interval '1 day';
  nearest extensions.vector := (array[1::real,0::real] || array_fill(0::real,array[1534]))::extensions.vector;
  farther extensions.vector := (array[0::real,1::real] || array_fill(0::real,array[1534]))::extensions.vector;
begin
  assert (select not rolcanlogin and not rolbypassrls from pg_roles where rolname = 'wp3_retrieval'),
    'Retrieval role can log in or bypass RLS';
  assert not has_column_privilege('wp3_retrieval','public.document_chunks','metadata','SELECT'),
    'Retrieval role can read private source metadata';
  assert not pg_has_role('authenticated','wp3_retrieval','MEMBER'), 'Client can assume the retrieval role';

  insert into auth.users(id,email)
    select id, id || '@example.invalid' from unnest(array[owner_user,reader_user,manager_user,inactive_user,outsider]) u(id);
  insert into public.organizations values (org,'Synthetic retrieval organization');
  insert into public.departments values (org,home,'Home department'),(org,other,'Other department');
  insert into public.organization_employees(organization_id,user_id,department_id,role,is_active) values
    (org,owner_user,home,'employee',true),(org,reader_user,other,'employee',true),
    (org,manager_user,home,'manager',true),(org,inactive_user,other,'employee',false);
  insert into public.projects(id,organization_id,department_id,is_d12,name) values
    (shared,org,home,false,'Synthetic shared project'),(d12,org,home,true,'Synthetic D12 project');
  insert into public.projects(id,user_id,name) values (personal,owner_user,'Synthetic personal project');
  insert into public.documents(id,project_id,storage_path,status,classification,access_scope,is_published) values
    (company_doc,shared,company_doc::text,'indexed','standard','company',true),
    (department_doc,shared,department_doc::text,'indexed','standard','department',true),
    (restricted_doc,shared,restricted_doc::text,'indexed','restricted','department',true),
    (draft_doc,shared,draft_doc::text,'indexed','standard','company',false),
    (unindexed_doc,shared,unindexed_doc::text,'uploaded','standard','company',true),
    (d12_doc,d12,d12_doc::text,'indexed','standard','company',true),
    (personal_doc,personal,personal_doc::text,'indexed','restricted','department',false);
  insert into public.document_chunks(id,document_id,project_id,content,embedding,metadata) values
    (lexical_hit,company_doc,shared,'needle',farther,'{"filename":"private-source.pdf"}'),
    (dense_hit,company_doc,shared,'semantic evidence',nearest,'{}'),
    (department_hit,department_doc,shared,'department evidence',nearest,'{}'),
    (restricted_hit,restricted_doc,shared,'restricted evidence',nearest,'{}'),
    (d12_hit,d12_doc,d12,'D12 evidence',nearest,'{}'),
    (personal_hit,personal_doc,personal,'personal needle',nearest,'{}'),
    (gen_random_uuid(),draft_doc,shared,'unpublished needle',nearest,'{}'),
    (gen_random_uuid(),unindexed_doc,shared,'unindexed needle',nearest,'{}');
  -- These would fill both top-50 pools if authorization were applied after ranking.
  insert into public.document_chunks(document_id,project_id,content,embedding)
    select restricted_doc,shared,repeat('needle ',20),nearest from generate_series(1,60);
  insert into public.interactions(project_id,user_id,query_text,response_markdown,latency_ms)
    values (shared,reader_user,'Synthetic query','Private conversation',1);

  set local role authenticated;
  perform pg_temp.as_employee(reader_user);
  select array_agg(id order by ordinality) into result_ids
    from public.search_rag_chunks(nearest,'needle',shared) with ordinality;
  assert result_ids = array[lexical_hit,dense_hit], 'Unauthorized candidates affected dense or lexical ranking';
  assert public.rag_chunks_still_visible(shared,array[lexical_hit,dense_hit])
    and not public.rag_chunks_still_visible(shared,array[restricted_hit])
    and not public.rag_chunks_still_visible(d12,array[lexical_hit]), 'Citation authorization is not project-scoped';
  assert exists (select from public.enterprise_chat_projects() where id=shared)
    and not exists (select from public.enterprise_chat_projects() where id in (d12,personal)),
    'Workspace discovery exposed an unauthorized project';
  assert not exists (select from public.document_chunks where id=lexical_hit)
    and not exists (select from public.documents where id=company_doc)
    and not exists (select from public.interactions where project_id=shared), 'Raw sources or history became visible';
  assert not exists (select from public.search_rag_chunks(nearest,'needle',personal)), 'Other personal workspace became searchable';
  perform pg_temp.expect_denied('select * from public.match_chunks_hybrid_rrf(null,null,null)');

  perform pg_temp.as_employee(owner_user);
  assert exists (select from public.search_rag_chunks(nearest,'department',shared) where id=department_hit),
    'Owning department lost Standard access';
  assert exists (select from public.search_rag_chunks(nearest,'needle',personal) where id=personal_hit)
    and exists (select from public.document_chunks where id=personal_hit),
    'Personal indexed retrieval or owner RLS regressed';

  perform pg_temp.as_employee(inactive_user);
  assert not exists (select from public.search_rag_chunks(nearest,'needle',shared)), 'Inactive employee gained access';
  perform pg_temp.as_employee(outsider);
  assert not exists (select from public.search_rag_chunks(nearest,'needle',shared))
    and not exists (select from public.enterprise_chat_projects(shared)), 'Outside user gained access';
  perform pg_temp.as_employee(manager_user);
  assert not public.rag_chunks_still_visible(shared,array[restricted_hit]), 'Manager gained automatic Restricted access';
  perform public.issue_document_grant(department_doc,reader_user,later);
  perform public.issue_document_grant(restricted_doc,reader_user,later);
  perform public.issue_document_grant(d12_doc,reader_user,later);
  perform pg_temp.as_employee(reader_user);
  assert exists (select from public.search_rag_chunks(nearest,'department',shared) where id=department_hit)
    and exists (select from public.search_rag_chunks(nearest,'restricted evidence',shared) where id=restricted_hit),
    'Approved Standard or Restricted grant was ignored';
  assert not exists (select from public.search_rag_chunks(nearest,'D12',d12)), 'D12 grant alone authorized search';
  reset role;

  insert into public.project_memberships(project_id,organization_id,project_department_id,is_d12,user_id,valid_from,expires_at) values
    (d12,org,home,true,reader_user,current_at,later),(d12,org,home,true,owner_user,current_at,later);
  set local role authenticated;
  perform pg_temp.as_employee(owner_user);
  assert not exists (select from public.search_rag_chunks(nearest,'D12',d12)), 'D12 membership alone authorized search';
  perform pg_temp.as_employee(reader_user);
  assert exists (select from public.search_rag_chunks(nearest,'D12',d12) where id=d12_hit)
    and public.rag_chunks_still_visible(d12,array[d12_hit]), 'D12 with both permissions was denied';
  reset role;

  update public.project_memberships set valid_from=current_at-interval '1 hour',expires_at=current_at
    where project_id=d12 and user_id=reader_user;
  set local role authenticated;
  perform pg_temp.as_employee(reader_user);
  assert not exists (select from public.search_rag_chunks(nearest,'D12',d12))
    and not public.rag_chunks_still_visible(d12,array[d12_hit]), 'Expired D12 membership allowed search or citation';
  reset role;

  update public.project_memberships set expires_at=later where project_id=d12 and user_id=reader_user;
  update public.document_grants set valid_from=current_at-interval '1 hour',expires_at=current_at
    where document_id in (d12_doc,department_doc) and user_id=reader_user;
  set local role authenticated;
  perform pg_temp.as_employee(reader_user);
  assert not exists (select from public.search_rag_chunks(nearest,'D12',d12))
    and not public.rag_chunks_still_visible(shared,array[department_hit]), 'Expired document grant allowed retrieval or citation';
  perform pg_temp.as_employee(manager_user);
  perform public.revoke_document_grant(restricted_doc,reader_user);
  perform pg_temp.as_employee(reader_user);
  assert not exists (select from public.search_rag_chunks(nearest,'restricted evidence',shared) where id=restricted_hit)
    and not public.rag_chunks_still_visible(shared,array[restricted_hit]), 'Revoked grant allowed retrieval or citation';
  reset role;

  update public.documents set is_published=false where id=company_doc;
  set local role authenticated;
  perform pg_temp.as_employee(reader_user);
  assert not exists (select from public.search_rag_chunks(nearest,'needle',shared))
    and not public.rag_chunks_still_visible(shared,array[lexical_hit]), 'Unpublished evidence remained available';
  reset role;

  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  set local role anon;
  assert current_user = 'anon' and auth.uid() is null and row_security_active('public.document_chunks');
  perform pg_temp.expect_denied('select * from public.search_rag_chunks(null,null,null)');
  perform pg_temp.expect_denied('select * from public.enterprise_chat_projects()');
  perform pg_temp.expect_denied('select public.rag_chunks_still_visible(null,null)');
  reset role;
  set local role service_role;
  perform pg_temp.expect_denied('select * from public.search_rag_chunks(null,null,null)');
  reset role;
end
$$;

rollback;
