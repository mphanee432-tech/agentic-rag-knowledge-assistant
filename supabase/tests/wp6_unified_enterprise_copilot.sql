-- Run on a disposable database after WP6. All fixtures roll back.
begin;
set local plpgsql.check_asserts = on;

-- Model the existing hosted uploader gate when replaying the repository migrations.
create or replace function public.can_upload_enterprise_policy(p_project_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1 from public.projects p
    join public.organization_employees e on e.organization_id = p.organization_id
    join auth.users u on u.id = e.user_id
    where p.id = p_project_id and e.user_id = auth.uid() and e.is_active
      and e.role in ('manager', 'cxo') and u.email = 'wp6-uploader@example.invalid'
  )
$$;

create or replace function public.reserve_enterprise_document(p_project_id uuid, p_document_id uuid,
  p_storage_path text, p_expected_size bigint, p_classification text, p_access_scope text)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  assert public.can_upload_enterprise_policy(p_project_id);
  insert into public.documents(id, project_id, storage_path, expected_size, status, classification, access_scope)
    values (p_document_id,p_project_id,p_storage_path,p_expected_size,'pending_upload',p_classification,p_access_scope);
  return p_document_id;
end
$$;

do $$
declare
  org uuid := gen_random_uuid();
  foreign_org uuid := gen_random_uuid();
  home uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  unopened uuid := gen_random_uuid();
  foreign_dept uuid := gen_random_uuid();
  employee uuid := gen_random_uuid();
  uploader uuid := gen_random_uuid();
  manager uuid := gen_random_uuid();
  first_project uuid := gen_random_uuid();
  other_project uuid := gen_random_uuid();
  d12 uuid := gen_random_uuid();
  personal uuid := gen_random_uuid();
  foreign_project uuid := gen_random_uuid();
  doc uuid := gen_random_uuid();
  first_hit uuid := gen_random_uuid();
  home_hit uuid := gen_random_uuid();
  other_hit uuid := gen_random_uuid();
  restricted_hit uuid := gen_random_uuid();
  d12_hit uuid := gen_random_uuid();
  personal_hit uuid := gen_random_uuid();
  foreign_hit uuid := gen_random_uuid();
  upload_doc uuid := gen_random_uuid();
  upload_project uuid;
  upload_path text;
  results uuid[];
  later timestamptz := statement_timestamp() + interval '1 hour';
  nearest extensions.vector := (array[1::real,0::real] || array_fill(0::real,array[1534]))::extensions.vector;
  farther extensions.vector := (array[0::real,1::real] || array_fill(0::real,array[1534]))::extensions.vector;
begin
  insert into auth.users(id,email) values
    (employee,'wp6-employee@example.invalid'),(uploader,'wp6-uploader@example.invalid'),(manager,'wp6-manager@example.invalid');
  insert into public.organizations values (org,'WP6 organization'),(foreign_org,'Other organization');
  insert into public.departments values (org,home,'Engineering'),(org,other,'Finance'),
    (org,unopened,'HR'),(foreign_org,foreign_dept,'Other department');
  insert into public.organization_employees(organization_id,user_id,department_id,role,is_active) values
    (org,employee,home,'employee',true),(org,uploader,home,'manager',true),(org,manager,home,'manager',true),
    (foreign_org,employee,foreign_dept,'employee',true);
  insert into public.projects(id,organization_id,department_id,is_d12,name) values
    (first_project,org,home,false,'Engineering'),(other_project,org,other,false,'Finance'),
    (d12,org,home,true,'D12'),(foreign_project,foreign_org,foreign_dept,false,'Foreign');
  insert into public.projects(id,user_id,name) values (personal,employee,'Personal');

  insert into public.documents(id,project_id,storage_path,status,classification,access_scope,is_published) values
    (first_hit,first_project,first_hit::text,'indexed','standard','company',true),
    (home_hit,first_project,home_hit::text,'indexed','standard','department',true),
    (other_hit,other_project,other_hit::text,'indexed','standard','company',true),
    (doc,other_project,doc::text,'indexed','standard','department',true),
    (restricted_hit,first_project,restricted_hit::text,'indexed','restricted','department',true),
    (d12_hit,d12,d12_hit::text,'indexed','standard','company',true),
    (personal_hit,personal,personal_hit::text,'indexed','restricted','department',false),
    (foreign_hit,foreign_project,foreign_hit::text,'indexed','standard','company',true);
  insert into public.document_chunks(id,document_id,project_id,content,embedding) values
    (first_hit,first_hit,first_project,'Engineering evidence',nearest),
    (home_hit,home_hit,first_project,'Department evidence',nearest),
    (other_hit,other_hit,other_project,'needle',farther),
    (doc,doc,other_project,'Private department evidence',nearest),
    (restricted_hit,restricted_hit,first_project,'Restricted evidence',nearest),
    (d12_hit,d12_hit,d12,'D12 evidence',nearest),
    (personal_hit,personal_hit,personal,'Personal needle',nearest),
    (foreign_hit,foreign_hit,foreign_project,'Foreign needle',nearest);
  insert into public.document_chunks(document_id,project_id,content,embedding)
    select restricted_hit,first_project,repeat('needle ',20),nearest from generate_series(1,60);

  set local role authenticated;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',employee)::text,true);
  assert auth.uid() = employee and row_security_active('public.document_chunks');
  select array_agg(id order by ordinality) into results
    from public.search_enterprise_chunks(nearest,'needle',org) with ordinality;
  assert results[1] = other_hit and results @> array[first_hit,home_hit,other_hit]
    and cardinality(results) = 3, 'Cross-department search or pre-ranking authorization failed';
  assert public.enterprise_chunks_still_visible(org,results)
    and not public.enterprise_chunks_still_visible(org,array[doc])
    and not public.enterprise_chunks_still_visible(org,array[foreign_hit])
    and not public.enterprise_chunks_still_visible(org,array[personal_hit])
    and not public.enterprise_chunks_still_visible(org,array[restricted_hit])
    and not public.enterprise_chunks_still_visible(org,array[d12_hit]), 'Organization evidence escaped its scope';
  assert exists (select from public.search_rag_chunks(nearest,'needle',personal) where id = personal_hit);
  assert not exists (select from public.enterprise_policy_departments(org));
  assert exists (select from public.enterprise_copilot_context(org) where not can_upload_policy);
  assert not has_function_privilege('anon','public.search_enterprise_chunks(extensions.vector,text,uuid)','EXECUTE')
    and not has_function_privilege('authenticated','wp3_private.search_chunks(extensions.vector,text,uuid,uuid)','EXECUTE');
  begin
    perform public.reserve_enterprise_policy(org,home,gen_random_uuid(),'policy.txt',10,'standard','company');
    raise exception 'Employee upload should have been denied';
  exception when insufficient_privilege then null;
  end;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager)::text,true);
  assert not exists (select from public.enterprise_copilot_context(org) where can_upload_policy);
  perform public.issue_document_grant(restricted_hit,employee,later);
  perform public.issue_document_grant(d12_hit,employee,later);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',employee)::text,true);
  assert public.enterprise_chunks_still_visible(org,array[restricted_hit])
    and not public.enterprise_chunks_still_visible(org,array[d12_hit]), 'Restricted or D12 grant handling changed';
  reset role;
  insert into public.project_memberships(project_id,organization_id,project_department_id,is_d12,user_id,valid_from,expires_at)
    values (d12,org,home,true,employee,statement_timestamp(),later),(d12,org,home,true,uploader,statement_timestamp(),later);
  set local role authenticated;
  assert exists (select from public.search_enterprise_chunks(nearest,'D12',org) where id=d12_hit)
    and public.enterprise_chunks_still_visible(org,array[d12_hit]);

  perform set_config('request.jwt.claims',jsonb_build_object('sub',uploader)::text,true);
  assert not public.enterprise_chunks_still_visible(org,array[d12_hit])
    and not public.enterprise_chunks_still_visible(org,array[restricted_hit])
    and not exists (select from public.search_enterprise_chunks(nearest,'D12',org) where id=d12_hit),
    'D12 membership alone or uploader status granted access';
  assert exists (select from public.enterprise_copilot_context(org) where can_upload_policy)
    and (select count(*) from public.enterprise_policy_departments(org)) = 3;
  begin
    perform public.reserve_enterprise_policy(org,foreign_dept,gen_random_uuid(),'policy.txt',10,'standard','company');
    raise exception 'Foreign department should have been denied';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.reserve_enterprise_policy(org,home,gen_random_uuid(),'policy.txt',10,'restricted','company');
    raise exception 'Restricted company-wide upload should have been denied';
  exception when invalid_parameter_value then null;
  end;
  assert (select project_id from public.reserve_enterprise_policy(org,other,gen_random_uuid(),'policy.pdf',10,'standard','company'))
    = other_project, 'Existing department project was not reused';
  select project_id,storage_path into upload_project,upload_path
    from public.reserve_enterprise_policy(org,unopened,upload_doc,'policy.html',10,'restricted','department');
  assert (select project_id from public.reserve_enterprise_policy(org,unopened,gen_random_uuid(),'policy.txt',10,'standard','department'))
    = upload_project, 'Second upload did not reuse the department project';
  reset role;
  assert exists (select from public.projects where id=upload_project and department_id=unopened and organization_id=org and not is_d12)
    and exists (select from public.documents where id=upload_doc and project_id=upload_project and storage_path=upload_path
      and classification='restricted' and access_scope='department' and status='pending_upload' and not is_published)
    and not exists (select from public.document_grants where document_id=upload_doc), 'Reservation widened policy permissions';
  assert exists (select from wp4_private.security_audit where organization_id=org and project_id is null and event='enterprise_search_hit');

  update public.organization_employees set is_active=false where organization_id=org and user_id=employee;
  set local role authenticated;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',employee)::text,true);
  assert not exists (select from public.search_enterprise_chunks(nearest,'needle',org))
    and not public.enterprise_chunks_still_visible(org,array[other_hit]), 'Deactivated employee retained access';
  reset role;
end
$$;

rollback;
