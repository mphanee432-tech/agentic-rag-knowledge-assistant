-- Disposable-only SQL test; never run against v1 or either populated Agentic project.
begin;
set local plpgsql.check_asserts = on;
do $$ begin
  if exists(select 1 from public.documents) or exists(select 1 from auth.users) then
    raise exception 'Use an empty disposable Enterprise test database';
  end if;
end $$;

create function pg_temp.expect_sqlstate(command text, expected text)
returns void language plpgsql security invoker as $$
declare actual text;
begin
  begin execute command;
  exception when others then get stacked diagnostics actual = returned_sqlstate;
  end;
  if actual is distinct from expected then
    raise exception 'Expected SQLSTATE %, got %', expected, coalesce(actual,'success');
  end if;
end $$;

do $$
declare
  org uuid := gen_random_uuid(); foreign_org uuid := gen_random_uuid();
  eng uuid := gen_random_uuid(); finance uuid := gen_random_uuid(); unopened uuid := gen_random_uuid(); foreign_dept uuid := gen_random_uuid();
  uploader uuid := gen_random_uuid(); employee uuid := gen_random_uuid(); finance_employee uuid := gen_random_uuid(); manager uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
  home_project uuid := gen_random_uuid(); finance_project uuid := gen_random_uuid(); d12_project uuid := gen_random_uuid(); foreign_project uuid := gen_random_uuid(); personal_project uuid := gen_random_uuid();
  doc_id uuid := gen_random_uuid(); company_doc uuid := gen_random_uuid(); department_doc uuid := gen_random_uuid();
  foreign_doc uuid := gen_random_uuid(); d12_doc uuid := gen_random_uuid(); missing_doc uuid := gen_random_uuid();
  zero_doc uuid := gen_random_uuid(); mismatch_doc uuid := gen_random_uuid(); new_dept_doc uuid := gen_random_uuid();
  result_project uuid; result_path text; new_project uuid;
  lease uuid := gen_random_uuid(); value text; size bigint; signature text; r text;
  chunks jsonb := jsonb_build_array(jsonb_build_object('content','Fixture evidence','metadata','{}'::jsonb,
    'embedding',to_jsonb(array_fill(0.1::real,array[1536]))));
begin
  insert into auth.users(id,email) values (uploader,'phani9119@gmail.com'),(employee,'employee@example.invalid'),
    (finance_employee,'finance@example.invalid'),(manager,'manager@example.invalid'),(outsider,'outsider@example.invalid');
  insert into public.organizations(id,name) values(org,'Fixture organization'),(foreign_org,'Foreign fixture');
  insert into public.departments(organization_id,id,name) values(org,eng,'Engineering'),(org,finance,'Finance'),
    (org,unopened,'Unopened'),(foreign_org,foreign_dept,'Foreign');
  insert into public.organization_employees(organization_id,user_id,department_id,role,is_active) values
    (org,uploader,eng,'manager',true),(org,employee,eng,'employee',true),(org,finance_employee,finance,'employee',true),
    (org,manager,eng,'manager',true),(foreign_org,outsider,foreign_dept,'cxo',true);
  insert into public.projects(id,organization_id,department_id,is_d12,name) values
    (home_project,org,eng,false,'Engineering'),(finance_project,org,finance,false,'Finance'),
    (d12_project,org,eng,true,'D12'),(foreign_project,foreign_org,foreign_dept,false,'Foreign');
  insert into public.projects(id,user_id,name) values(personal_project,uploader,'Personal');
  insert into public.documents(id,project_id,storage_path,status,is_published,classification,access_scope) values
    (foreign_doc,foreign_project,'foreign/fixture.txt','indexed',false,'standard','company'),
    (d12_doc,d12_project,'enterprise/d12/fixture.txt','indexed',true,'standard','company'),
    (zero_doc,home_project,'enterprise/zero/fixture.txt','indexed',false,'standard','department'),
    (mismatch_doc,home_project,'enterprise/mismatch/fixture.txt','indexed',false,'standard','department');
  insert into public.document_chunks(document_id,project_id,content,embedding) values
    (d12_doc,d12_project,'D12 fixture',(chunks->0->>'embedding')::extensions.vector),
    (mismatch_doc,foreign_project,'Wrong project fixture',(chunks->0->>'embedding')::extensions.vector);

  foreach signature in array array[
    'public.can_upload_enterprise_policy(uuid)',
    'public.reserve_enterprise_policy(uuid,uuid,uuid,text,bigint,text,text)',
    'public.publish_enterprise_document(uuid)',
    'wp3_private.can_upload_enterprise_policy(uuid)',
    'wp3_private.reserve_enterprise_policy(uuid,uuid,uuid,text,bigint,text,text)',
    'wp3_private.publish_enterprise_document(uuid)',
    'public.enterprise_policy_departments(uuid)',
    'public.enterprise_copilot_context(uuid)'
  ] loop
    assert has_function_privilege('authenticated',signature,'EXECUTE');
    foreach r in array array['anon','service_role'] loop
      assert not has_function_privilege(r,signature,'EXECUTE'), 'Unexpected privileged RPC execution';
    end loop;
    assert not exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=signature::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'), 'PUBLIC execution exposed';
    assert (select proconfig @> array['search_path=pg_catalog, pg_temp'] from pg_proc where oid=signature::regprocedure);
  end loop;
  assert not (select prosecdef from pg_proc where oid='public.reserve_enterprise_policy(uuid,uuid,uuid,text,bigint,text,text)'::regprocedure);

  set local role authenticated;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',employee,'role','service_role',
    'app_metadata',jsonb_build_object('role','cxo'),'user_metadata',jsonb_build_object('role','manager'))::text,true);
  assert not public.can_upload_enterprise_policy(home_project), 'Token metadata promoted an employee';
  assert not exists(select from public.enterprise_policy_departments(org));
  assert exists(select from public.enterprise_copilot_context(org) where not can_upload_policy);
  perform pg_temp.expect_sqlstate(format('select * from public.reserve_enterprise_policy(%L,%L,%L,%L,8,%L,%L)',org,eng,doc_id,'policy.txt','standard','company'),'42501');
  perform pg_temp.expect_sqlstate(format('select public.publish_enterprise_document(%L)',d12_doc),'42501');
  perform pg_temp.expect_sqlstate(format('update public.organization_employees set role=%L where user_id=%L','manager',employee),'42501');
  perform pg_temp.expect_sqlstate(format('update auth.users set email=%L where id=%L','phani9119@gmail.com',employee),'42501');
  perform pg_temp.expect_sqlstate('insert into public.document_grants(document_id,user_id) values(gen_random_uuid(),auth.uid())','42501');
  perform pg_temp.expect_sqlstate('insert into public.project_memberships(project_id,user_id) values(gen_random_uuid(),auth.uid())','42501');
  perform pg_temp.expect_sqlstate(format('update public.documents set is_published=true where id=%L',d12_doc),'42501');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager)::text,true);
  assert not public.can_upload_enterprise_policy(home_project), 'Non-designated manager acquired upload rights';
  perform pg_temp.expect_sqlstate(format('select * from public.reserve_enterprise_policy(%L,%L,%L,%L,8,%L,%L)',org,eng,doc_id,'policy.txt','standard','company'),'42501');
  perform pg_temp.expect_sqlstate(format('select public.publish_enterprise_document(%L)',d12_doc),'42501');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',outsider)::text,true);
  assert not public.can_upload_enterprise_policy(home_project);
  perform pg_temp.expect_sqlstate(format('select public.publish_enterprise_document(%L)',d12_doc),'42501');

  perform set_config('request.jwt.claims',jsonb_build_object('sub',uploader)::text,true);
  assert public.can_upload_enterprise_policy(home_project) and public.can_upload_enterprise_policy(finance_project);
  assert not public.can_upload_enterprise_policy(personal_project) and not public.can_upload_enterprise_policy(foreign_project);
  assert not public.can_upload_enterprise_policy(null);
  assert (select count(*)=3 from public.enterprise_policy_departments(org));
  assert not exists(select from public.enterprise_policy_departments(foreign_org));
  assert exists(select from public.enterprise_copilot_context(org) where can_upload_policy);
  perform pg_temp.expect_sqlstate(format('select * from public.reserve_enterprise_policy(%L,%L,%L,%L,8,%L,%L)',foreign_org,foreign_dept,doc_id,'policy.txt','standard','company'),'42501');
  perform pg_temp.expect_sqlstate(format('select * from public.reserve_enterprise_policy(%L,%L,%L,%L,8,%L,%L)',org,foreign_dept,doc_id,'policy.txt','standard','company'),'22023');
  perform pg_temp.expect_sqlstate(format('select * from public.reserve_enterprise_policy(%L,%L,%L,%L,8,%L,%L)',org,null,doc_id,'policy.txt','standard','company'),'22023');
  foreach value in array array[null::text,'../policy.pdf','policy.exe','path/policy.txt',repeat('x',201)||'.pdf'] loop
    perform pg_temp.expect_sqlstate(format('select * from public.reserve_enterprise_policy(%L,%L,%L,%L,8,%L,%L)',org,eng,doc_id,value,'standard','company'),'22023');
  end loop;
  foreach size in array array[null::bigint,-1,0,26214401] loop
    perform pg_temp.expect_sqlstate(format('select * from public.reserve_enterprise_policy(%L,%L,%L,%L,%L::bigint,%L,%L)',org,eng,doc_id,'policy.pdf',size,'standard','company'),'22023');
  end loop;
  foreach value in array array[null::text,'invalid'] loop
    perform pg_temp.expect_sqlstate(format('select * from public.reserve_enterprise_policy(%L,%L,%L,%L,8,%L,%L)',org,eng,doc_id,'policy.pdf',value,'department'),'22023');
    perform pg_temp.expect_sqlstate(format('select * from public.reserve_enterprise_policy(%L,%L,%L,%L,8,%L,%L)',org,eng,doc_id,'policy.pdf','standard',value),'22023');
  end loop;
  perform pg_temp.expect_sqlstate(format('select * from public.reserve_enterprise_policy(%L,%L,%L,%L,8,%L,%L)',org,eng,null,'policy.pdf','standard','company'),'22023');
  perform pg_temp.expect_sqlstate(format('select * from public.reserve_enterprise_policy(%L,%L,%L,%L,8,%L,%L)',org,eng,doc_id,'policy.pdf','restricted','company'),'22023');

  select project_id,storage_path into result_project,result_path from public.reserve_enterprise_policy(org,eng,doc_id,'policy.txt',8,'restricted','department');
  assert result_project=home_project and result_path='enterprise/'||home_project||'/'||doc_id||'/policy.txt';
  perform pg_temp.expect_sqlstate(format('select * from public.reserve_enterprise_policy(%L,%L,%L,%L,9,%L,%L)',org,eng,doc_id,'replaced.txt','standard','company'),'23505');
  perform pg_temp.expect_sqlstate(format('select * from public.reserve_enterprise_policy(%L,%L,%L,%L,8,%L,%L)',org,unopened,doc_id,'duplicate.pdf','standard','department'),'23505');
  reset role;
  assert not exists(select from public.projects where department_id=unopened), 'Failed reservation left a project behind';
  set local role authenticated;
  select project_id into new_project from public.reserve_enterprise_policy(org,unopened,new_dept_doc,'policy.pdf',26214400,'standard','department');
  assert (select project_id from public.reserve_enterprise_policy(org,unopened,gen_random_uuid(),'second.html',8,'standard','company'))=new_project;
  perform pg_temp.expect_sqlstate(format('select public.publish_enterprise_document(%L)',doc_id),'55000');
  perform pg_temp.expect_sqlstate(format('select public.publish_enterprise_document(%L)',zero_doc),'55000');
  perform pg_temp.expect_sqlstate(format('select public.publish_enterprise_document(%L)',mismatch_doc),'55000');
  perform pg_temp.expect_sqlstate(format('select public.publish_enterprise_document(%L)',foreign_doc),'42501');
  perform pg_temp.expect_sqlstate(format('select public.publish_enterprise_document(%L)',missing_doc),'42501');
  perform pg_temp.expect_sqlstate('select public.publish_enterprise_document(null)','42501');
  reset role;
  assert (select bool_and(status='indexed' and not is_published) from public.documents
    where id in (zero_doc,mismatch_doc,foreign_doc)), 'Publication failure changed existing indexed documents';
  assert (select status='pending_upload' and not is_published and classification='restricted'
    and access_scope='department' and expected_size=8 and ingestion_attempts=0 from public.documents where id=doc_id);
  assert (select count(*)=1 from public.projects where department_id=unopened and not is_d12);
  assert not exists(select from public.document_grants) and not exists(select from public.project_memberships);

  update public.organization_employees set is_active=false where user_id=uploader;
  set local role authenticated;
  assert not public.can_upload_enterprise_policy(home_project);
  perform pg_temp.expect_sqlstate(format('select public.publish_enterprise_document(%L)',doc_id),'42501');
  reset role;
  update public.organization_employees set is_active=true,role='employee' where user_id=uploader;
  set local role authenticated;
  assert not public.can_upload_enterprise_policy(home_project), 'Designated identity bypassed employee role';
  perform pg_temp.expect_sqlstate(format('select * from public.reserve_enterprise_policy(%L,%L,%L,%L,8,%L,%L)',org,eng,gen_random_uuid(),'policy.txt','standard','company'),'42501');
  reset role;
  update public.organization_employees set role='cxo' where user_id=uploader;
  set local role authenticated;
  assert public.can_upload_enterprise_policy(home_project);
  reset role;

  insert into storage.objects(bucket_id,name) values('documents',result_path);
  set local role service_role;
  assert public.claim_document_ingestion(doc_id,lease);
  assert not public.claim_document_ingestion(doc_id,gen_random_uuid());
  set local role authenticated;
  perform pg_temp.expect_sqlstate(format('select public.publish_enterprise_document(%L)',doc_id),'55000');
  set local role service_role;
  perform public.finish_document_ingestion(doc_id,lease,chunks);
  reset role;
  assert (select status='indexed' and not is_published and ingestion_attempts=1 from public.documents where id=doc_id);
  set local role authenticated;
  perform public.publish_enterprise_document(doc_id);
  perform public.publish_enterprise_document(doc_id);
  assert not exists(select from public.documents where id=doc_id), 'Uploader gained restricted read access without a grant';
  reset role;
  assert (select is_published and classification='restricted' and access_scope='department' from public.documents where id=doc_id);
  assert (select count(*)=1 from public.document_chunks where document_id=doc_id);
  assert not exists(select from public.document_grants), 'Publication issued grants';

  set local role authenticated;
  select project_id into result_project from public.reserve_enterprise_policy(org,eng,company_doc,'company.txt',8,'standard','company');
  select project_id into result_project from public.reserve_enterprise_policy(org,finance,department_doc,'finance.txt',8,'standard','department');
  reset role;
  update public.documents set status='indexed' where id in (company_doc,department_doc);
  insert into public.document_chunks(document_id,project_id,content,embedding)
    select id,project_id,'Read boundary fixture',(chunks->0->>'embedding')::extensions.vector
    from public.documents where id in (company_doc,department_doc);
  set local role authenticated;
  perform public.publish_enterprise_document(company_doc);
  perform public.publish_enterprise_document(department_doc);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',employee)::text,true);
  assert exists(select from public.documents where id=company_doc);
  assert not exists(select from public.documents where id in (doc_id,department_doc,d12_doc,foreign_doc));
  perform set_config('request.jwt.claims',jsonb_build_object('sub',finance_employee)::text,true);
  assert exists(select from public.documents where id=department_doc);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',outsider)::text,true);
  assert not exists(select from public.documents where id in (company_doc,department_doc,doc_id));
  reset role;
  assert (select count(*)=5 from public.organization_employees);
  assert not exists(select from public.document_grants) and not exists(select from public.project_memberships);
  set local role anon;
  perform pg_temp.expect_sqlstate(format('select public.can_upload_enterprise_policy(%L)',home_project),'42501');
  reset role;
end
$$;
rollback;
