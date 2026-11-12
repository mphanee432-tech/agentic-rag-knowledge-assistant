-- Run on an isolated PostgreSQL database with WP2A and WP2B applied.
begin;
set local plpgsql.check_asserts = on;
set local row_security = on;

create function pg_temp.expect_failure(command text, expected_state text)
returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    assert sqlstate = expected_state, format('Expected SQLSTATE %s, got %s', expected_state, sqlstate);
    return;
  end;
  raise exception 'Expected SQLSTATE %', expected_state;
end
$$;

create function pg_temp.assume_employee(actor uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);
  assert current_user = 'authenticated' and auth.uid() = actor
    and row_security_active('public.projects') and row_security_active('public.documents')
    and row_security_active('public.document_chunks') and row_security_active('public.interactions')
    and row_security_active('public.document_grants'), 'Expected authenticated identity with active RLS';
end
$$;

create function pg_temp.expect_document(document_id uuid, allowed boolean)
returns void language plpgsql as $$
begin
  if allowed then
    assert (select count(*) = 1 and bool_and(content = 'Synthetic chunk')
      from public.read_enterprise_document(document_id)), 'Expected exactly one authorized chunk';
  else
    assert not exists (select 1 from public.read_enterprise_document(document_id)),
      'Enterprise document unexpectedly readable';
  end if;
end
$$;

do $$
declare
  org uuid := gen_random_uuid();
  second_org uuid := gen_random_uuid();
  owning_department uuid := gen_random_uuid();
  other_department uuid := gen_random_uuid();
  second_org_department uuid := gen_random_uuid();
  owner_employee uuid := gen_random_uuid();
  other_employee uuid := gen_random_uuid();
  manager uuid := gen_random_uuid();
  cxo uuid := gen_random_uuid();
  other_manager uuid := gen_random_uuid();
  other_cxo uuid := gen_random_uuid();
  inactive_manager uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  personal_project uuid := gen_random_uuid();
  org_project uuid := gen_random_uuid();
  d12_project uuid := gen_random_uuid();
  personal_doc uuid := gen_random_uuid();
  company_doc uuid := gen_random_uuid();
  department_doc uuid := gen_random_uuid();
  restricted_doc uuid := gen_random_uuid();
  unpublished_doc uuid := gen_random_uuid();
  unindexed_doc uuid := gen_random_uuid();
  d12_doc uuid := gen_random_uuid();
  current_at timestamptz := statement_timestamp();
  later timestamptz := current_at + interval '1 day';
  actor uuid;
begin
  insert into auth.users (id, email)
  select user_id, user_id || '@example.invalid'
  from unnest(array[owner_employee, other_employee, manager, cxo, other_manager, other_cxo, inactive_manager, outsider]) ids(user_id);

  insert into public.organizations (id, name) values (org, 'Synthetic organization'), (second_org, 'Other organization');
  insert into public.departments (organization_id, id, name) values
    (org, owning_department, 'Owning department'), (org, other_department, 'Other department'),
    (second_org, second_org_department, 'Other organization department');
  insert into public.organization_employees (organization_id, user_id, department_id, role, is_active) values
    (org, owner_employee, owning_department, 'employee', true),
    (org, other_employee, other_department, 'employee', true),
    (org, manager, owning_department, 'manager', true),
    (org, cxo, owning_department, 'cxo', true),
    (org, other_manager, other_department, 'manager', true),
    (org, other_cxo, other_department, 'cxo', true),
    (org, inactive_manager, owning_department, 'manager', false),
    (second_org, outsider, second_org_department, 'cxo', true);

  insert into public.projects (id, user_id, name) values (personal_project, manager, 'Private personal project');
  insert into public.projects (id, organization_id, department_id, is_d12, name) values
    (org_project, org, owning_department, false, 'Standard enterprise project'),
    (d12_project, org, owning_department, true, 'D12 project');
  insert into public.documents (id, project_id, storage_path, status, classification, access_scope, is_published) values
    (personal_doc, personal_project, 'synthetic/' || personal_doc, 'indexed', 'standard', 'company', true),
    (company_doc, org_project, 'synthetic/' || company_doc, 'indexed', 'standard', 'company', true),
    (department_doc, org_project, 'synthetic/' || department_doc, 'indexed', 'standard', 'department', true),
    (restricted_doc, org_project, 'synthetic/' || restricted_doc, 'indexed', 'restricted', 'department', true),
    (unpublished_doc, org_project, 'synthetic/' || unpublished_doc, 'indexed', 'standard', 'company', false),
    (unindexed_doc, org_project, 'synthetic/' || unindexed_doc, 'uploaded', 'standard', 'company', true),
    (d12_doc, d12_project, 'synthetic/' || d12_doc, 'indexed', 'standard', 'company', true);
  insert into public.document_chunks (document_id, project_id, content, metadata, embedding)
    select id, project_id, 'Synthetic chunk', '{"source":"synthetic private metadata"}',
      array_fill(0::real, array[1536])::extensions.vector(1536)
    from public.documents where id in
      (personal_doc, company_doc, department_doc, restricted_doc, unpublished_doc, unindexed_doc, d12_doc);
  insert into public.interactions (project_id, user_id, query_text, response_markdown, latency_ms)
    values (org_project, other_employee, 'Synthetic organization history', 'Private', 1),
           (personal_project, manager, 'Synthetic personal history', 'Private', 1);

  set local role authenticated;
  perform pg_temp.assume_employee(other_employee);
  assert not has_table_privilege(current_user, 'public.projects', 'TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
    'Authenticated role can bypass personal project RLS using a non-CRUD privilege';
  perform pg_temp.expect_document(company_doc, true);
  perform pg_temp.expect_document(department_doc, false);
  perform pg_temp.expect_document(unpublished_doc, false);
  perform pg_temp.expect_document(unindexed_doc, false);
  perform pg_temp.expect_document(personal_doc, false);
  assert not exists (select 1 from public.projects where id in (personal_project, org_project))
    and not exists (select storage_path from public.documents where id in (personal_doc, company_doc))
    and not exists (select metadata from public.document_chunks where document_id in (personal_doc, company_doc))
    and not exists (select 1 from public.interactions where project_id in (personal_project, org_project)),
    'Raw rows, private source metadata, or conversation history became visible';
  perform pg_temp.expect_failure(format('select public.issue_document_grant(%L, %L, %L)', restricted_doc, other_employee, later), '42501');
  perform pg_temp.expect_failure(format('select public.issue_document_grant(%L, %L, %L)', restricted_doc, owner_employee, later), '42501');
  perform pg_temp.expect_failure(format('select public.revoke_document_grant(%L, %L)', restricted_doc, other_employee), '42501');
  perform pg_temp.expect_failure('insert into public.document_grants default values', '42501');
  perform pg_temp.expect_failure('update public.document_grants set revoked_at = statement_timestamp()', '42501');
  perform pg_temp.expect_failure('delete from public.document_grants', '42501');
  perform pg_temp.expect_failure('select * from public.match_chunks_hybrid_rrf(NULL, NULL, NULL)', '42501');

  perform pg_temp.assume_employee(owner_employee);
  perform pg_temp.expect_document(department_doc, true);
  perform pg_temp.expect_document(restricted_doc, false);
  foreach actor in array array[inactive_manager, outsider] loop
    perform pg_temp.assume_employee(actor);
    perform pg_temp.expect_document(company_doc, false);
    perform pg_temp.expect_failure(format('select public.issue_document_grant(%L, %L, %L)', restricted_doc, other_employee, later), '42501');
  end loop;
  foreach actor in array array[other_manager, other_cxo] loop
    perform pg_temp.assume_employee(actor);
    perform pg_temp.expect_failure(format('select public.issue_document_grant(%L, %L, %L)', restricted_doc, other_employee, later), '42501');
    perform pg_temp.expect_failure(format('select wp2b_private.issue_document_grant(%L, %L, %L)', restricted_doc, other_employee, later), '42501');
  end loop;

  perform pg_temp.assume_employee(cxo);
  perform pg_temp.expect_document(restricted_doc, false);
  perform pg_temp.expect_document(d12_doc, false);
  perform public.issue_document_grant(d12_doc, other_employee, later);
  perform public.issue_document_grant(restricted_doc, manager, later);
  perform pg_temp.assume_employee(manager);
  perform pg_temp.expect_document(restricted_doc, true);
  perform pg_temp.expect_document(personal_doc, false);
  assert exists (select 1 from public.projects where id = personal_project)
    and exists (select 1 from public.interactions where project_id = personal_project),
    'Personal owner lost direct access';
  perform pg_temp.expect_failure(format('select public.issue_document_grant(%L, %L, %L)', restricted_doc, manager, later), '42501');
  perform pg_temp.expect_failure(format('select public.revoke_document_grant(%L, %L)', restricted_doc, manager), '42501');
  perform pg_temp.expect_failure(format('select public.issue_document_grant(%L, %L, %L)', restricted_doc, outsider, later), '42501');
  perform pg_temp.expect_failure(format('select public.issue_document_grant(%L, %L, %L)', restricted_doc, inactive_manager, later), '42501');
  perform pg_temp.expect_failure(format('select public.issue_document_grant(%L, %L, %L)',
    restricted_doc, other_employee, current_at + interval '720 hours 1 microsecond'), '23514');
  perform public.issue_document_grant(restricted_doc, other_employee, later);
  perform public.issue_document_grant(department_doc, other_employee, later);
  perform pg_temp.expect_failure(format('select public.issue_document_grant(%L, %L, %L)', restricted_doc, other_employee, later), '55000');
  reset role;

  assert exists (select 1 from public.document_grants where document_id = restricted_doc and user_id = other_employee
    and approved_by = manager and recipient_department_id = other_department)
    and exists (select 1 from public.document_grants where document_id = d12_doc and user_id = other_employee and approved_by = cxo),
    'Grant did not record the authenticated approver and recipient department';
  perform pg_temp.expect_failure(format('update public.documents set access_scope = ''company'' where id = %L', department_doc), '55000');
  perform pg_temp.expect_failure(format('update public.documents set access_scope = ''company'' where id = %L', restricted_doc), '55000');
  perform pg_temp.expect_failure(format('update public.documents set classification = ''standard'' where id = %L', restricted_doc), '23503');
  perform pg_temp.expect_failure(format('update public.projects set department_id = %L where id = %L', other_department, org_project), '23503');
  perform pg_temp.expect_failure(format('update public.projects set is_d12 = false where id = %L', d12_project), '23503');
  perform pg_temp.expect_failure(format('update public.documents set classification = ''restricted'' where id = %L', company_doc), '23514');

  set local role authenticated;
  perform pg_temp.assume_employee(other_employee);
  perform pg_temp.expect_document(department_doc, true);
  perform pg_temp.expect_document(restricted_doc, true);
  perform pg_temp.expect_document(d12_doc, false); -- grant only
  assert not exists (select 1 from public.interactions where project_id = org_project),
    'Document access exposed organization conversation history';
  perform pg_temp.assume_employee(other_manager);
  perform pg_temp.expect_failure(format('select public.revoke_document_grant(%L, %L)', restricted_doc, other_employee), '42501');
  perform pg_temp.assume_employee(cxo);
  perform public.revoke_document_grant(restricted_doc, other_employee);
  perform pg_temp.assume_employee(other_employee);
  perform pg_temp.expect_document(restricted_doc, false);
  perform pg_temp.assume_employee(manager);
  perform public.issue_document_grant(restricted_doc, other_employee, later);
  perform pg_temp.assume_employee(other_employee);
  perform pg_temp.expect_document(restricted_doc, true);
  reset role;

  update public.document_grants set approved_by = null
    where document_id = restricted_doc and user_id = other_employee;
  set local role authenticated;
  perform pg_temp.assume_employee(other_employee);
  perform pg_temp.expect_document(restricted_doc, false);
  reset role;

  update public.document_grants set valid_from = current_at - interval '1 hour', expires_at = current_at
    where document_id = department_doc and user_id = other_employee;
  insert into public.project_memberships
    (project_id, organization_id, project_department_id, is_d12, user_id, valid_from, expires_at)
  values (d12_project, org, owning_department, true, other_employee, current_at, later),
         (d12_project, org, owning_department, true, owner_employee, current_at, later);
  set local role authenticated;
  perform pg_temp.assume_employee(owner_employee);
  perform pg_temp.expect_document(d12_doc, false); -- membership only, despite owning department and company scope
  perform pg_temp.assume_employee(other_employee);
  perform pg_temp.expect_document(department_doc, false); -- exact grant expiry
  perform pg_temp.expect_document(d12_doc, true);
  reset role;

  update public.documents set is_published = false where id = d12_doc;
  set local role authenticated;
  perform pg_temp.assume_employee(other_employee);
  perform pg_temp.expect_document(d12_doc, false);
  reset role;
  update public.documents set is_published = true where id = d12_doc;
  update public.documents set access_scope = 'company' where id = department_doc;

  update public.project_memberships set valid_from = current_at - interval '1 hour', expires_at = current_at
    where project_id = d12_project and user_id = other_employee;
  set local role authenticated;
  perform pg_temp.assume_employee(other_employee);
  perform pg_temp.expect_document(d12_doc, false);
  reset role;
  update public.project_memberships set expires_at = later where project_id = d12_project and user_id = other_employee;
  update public.document_grants set valid_from = current_at - interval '1 hour', expires_at = current_at
    where document_id = d12_doc and user_id = other_employee;
  set local role authenticated;
  perform pg_temp.assume_employee(other_employee);
  perform pg_temp.expect_document(d12_doc, false);
  reset role;

  update public.document_grants set expires_at = later, revoked_at = current_at
    where document_id = d12_doc and user_id = other_employee;
  set local role authenticated;
  perform pg_temp.assume_employee(other_employee);
  perform pg_temp.expect_document(d12_doc, false);
  reset role;

  update public.document_grants set revoked_at = null where document_id = d12_doc and user_id = other_employee;
  update public.project_memberships set revoked_at = current_at where project_id = d12_project and user_id = other_employee;
  set local role authenticated;
  perform pg_temp.assume_employee(other_employee);
  perform pg_temp.expect_document(d12_doc, false);
  reset role;

  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  assert current_user = 'anon' and auth.uid() is null and row_security_active('public.documents'),
    'Expected anon role with active RLS';
  perform pg_temp.expect_failure(format('select * from public.read_enterprise_document(%L)', company_doc), '42501');
  perform pg_temp.expect_failure(format('select public.issue_document_grant(%L, %L, %L)', company_doc, other_employee, later), '42501');
  perform pg_temp.expect_failure(format('select public.revoke_document_grant(%L, %L)', company_doc, other_employee), '42501');
  perform pg_temp.expect_failure('select * from public.documents', '42501');
  perform pg_temp.expect_failure('select * from public.interactions', '42501');
  reset role;
end
$$;

rollback;
