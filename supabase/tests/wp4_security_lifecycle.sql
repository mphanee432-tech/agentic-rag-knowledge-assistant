begin;
set local plpgsql.check_asserts = on;

do $$
declare
  org uuid := gen_random_uuid();
  dept uuid := gen_random_uuid();
  reader uuid := gen_random_uuid();
  manager uuid := gen_random_uuid();
  project uuid := gen_random_uuid();
  doc uuid := gen_random_uuid();
  chunk uuid := gen_random_uuid();
  embed extensions.vector := (array[1::real] || array_fill(0::real,array[1535]))::extensions.vector;
  cutoff timestamptz := statement_timestamp() - interval '8760 hours';
begin
  insert into auth.users(id,email) values (reader,reader || '@example.invalid'), (manager,manager || '@example.invalid');
  insert into public.organizations values(org,'Synthetic lifecycle org');
  insert into public.departments values(org,dept,'Synthetic department');
  insert into public.organization_employees(organization_id,user_id,department_id,role,is_active) values
    (org,reader,dept,'employee',true),(org,manager,dept,'manager',true);
  insert into public.projects(id,organization_id,department_id,is_d12,name) values(project,org,dept,false,'Synthetic project');
  insert into public.documents(id,project_id,storage_path,status,is_published) values(doc,project,doc::text,'indexed',true);
  insert into public.document_chunks(id,document_id,project_id,content,embedding)
    values(chunk,doc,project,'SYNTHETIC_RESTRICTED_TEXT',embed);
  insert into public.interactions(project_id,user_id,query_text,response_markdown,latency_ms)
    values(project,manager,'Private question','SYNTHETIC_SENSITIVE_ANSWER',1);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  assert current_user='authenticated' and auth.uid()=manager and row_security_active('public.document_chunks');
  perform public.issue_document_grant(doc,reader,statement_timestamp()+interval '1 hour');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',reader,'role','authenticated')::text,true);
  assert exists(select from public.search_rag_chunks(embed,'SYNTHETIC_PRIVATE_QUERY',project) where id=chunk);
  assert exists(select from public.read_enterprise_document(doc) where chunk_id=chunk);
  assert not exists(select from public.interactions where project_id=project);
  assert not has_table_privilege(current_user,'wp4_private.security_audit','SELECT,INSERT,UPDATE,DELETE');
  assert not has_function_privilege(current_user,'wp3_private.search_chunks(extensions.vector,text,uuid)','EXECUTE');
  reset role;

  perform set_config('request.jwt.claims','{}',true);
  update public.organization_employees set is_active=false where organization_id=org and user_id=reader;
  set local role authenticated;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',reader,'role','authenticated')::text,true);
  assert not exists(select from public.search_rag_chunks(embed,'SYNTHETIC_PRIVATE_QUERY',project));
  assert not exists(select from public.read_enterprise_document(doc));
  assert not exists(select from public.enterprise_chat_projects(project));
  assert not public.rag_chunks_still_visible(project,array[chunk]);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  perform public.revoke_document_grant(doc,reader);
  reset role;

  assert exists(select from public.projects where id=project and organization_id=org)
    and exists(select from public.documents where id=doc and is_published)
    and exists(select from public.document_chunks where id=chunk and embedding::text=embed::text),
    'Deactivation removed organization knowledge';
  assert (select array_agg(event order by event) from wp4_private.security_audit where organization_id=org)
    = array['employee_deactivated','enterprise_read_empty','enterprise_read_hit','enterprise_search_empty','enterprise_search_hit','grant_issued','grant_revoked'];
  assert not exists(select from wp4_private.security_audit a where organization_id=org
    and to_jsonb(a)::text ~ 'SYNTHETIC_(RESTRICTED_TEXT|SENSITIVE_ANSWER|PRIVATE_QUERY)');
  assert not has_table_privilege('anon','wp4_private.security_audit','SELECT,INSERT,UPDATE,DELETE')
    and not has_table_privilege('service_role','wp4_private.security_audit','SELECT,INSERT,UPDATE,DELETE');

  insert into wp4_private.security_audit(event,organization_id,occurred_at) values
    ('employee_deactivated',org,cutoff),('employee_deactivated',org,cutoff+interval '1 second');
  perform wp4_private.prune_security_audit();
  assert not exists(select from wp4_private.security_audit where organization_id=org and occurred_at<=cutoff)
    and exists(select from wp4_private.security_audit where organization_id=org and occurred_at=cutoff+interval '1 second');
end
$$;
rollback;
