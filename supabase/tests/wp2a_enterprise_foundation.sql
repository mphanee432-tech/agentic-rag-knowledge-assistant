-- Run on an isolated WP2A database with either an empty or verified Stage 3 baseline.
begin;
set local plpgsql.check_asserts = on;
set local row_security = on;
set local timezone = 'America/New_York';

do $$
declare
  user_count bigint := (select count(*) from auth.users);
begin
  assert (user_count = 0 or (user_count = 2 and
      (select count(*) from auth.users where id in (
        'a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001')) = 2))
    and (select count(*) from public.projects) = user_count
    and (select count(*) from public.documents) = user_count
    and (select count(*) from public.document_chunks) = user_count
    and (select count(*) from public.interactions) = user_count
    and not exists (select 1 from public.organizations)
    and not exists (select 1 from public.departments)
    and not exists (select 1 from public.organization_employees)
    and not exists (select 1 from public.project_memberships)
    and not exists (select 1 from public.document_grants),
    'Expected an empty isolated database or the two-owner Stage 3 baseline';
end $$;

create function pg_temp.expect_failure(command text, expected_state text, expected_constraint text default null)
returns void language plpgsql as $$
declare
  actual_state text;
  actual_constraint text;
begin
  begin
    execute command;
  exception when others then
    get stacked diagnostics actual_state = returned_sqlstate, actual_constraint = constraint_name;
    assert actual_state = expected_state and
      (expected_constraint is null or actual_constraint = expected_constraint),
      format('Unexpected SQLSTATE/constraint: %s / %s for %s', actual_state, actual_constraint, command);
    return;
  end;
  raise exception 'Expected failure: %', command;
end $$;

-- Exercise the original Stage 3 records under real database roles.
do $$
declare
  owner_id uuid;
  fixture_prefix text;
  table_name text;
  visible_count bigint;
  stage3_baseline boolean := exists (select 1 from auth.users);
  rpc oid := 'public.match_chunks_hybrid_rrf(extensions.vector,text,uuid,integer,integer)'::regprocedure;
begin
  set local role authenticated;
  foreach owner_id in array array['a0000000-0000-4000-8000-000000000001'::uuid,'b0000000-0000-4000-8000-000000000001'::uuid] loop
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
    assert current_user = 'authenticated' and auth.uid() = owner_id and current_setting('row_security') = 'on',
      'Authenticated role, identity, or row_security not established';
    fixture_prefix := left(owner_id::text,1);
    foreach table_name in array array['projects','documents','document_chunks','interactions'] loop
      assert row_security_active(('public.' || table_name)::regclass), 'RLS inactive for authenticated: ' || table_name;
      if stage3_baseline then
        execute format('select count(*) from public.%I', table_name) into visible_count;
        assert visible_count = 1, 'Original owner visibility mismatch: ' || table_name;
        execute format('select count(*) from public.%I where left(id::text,1) <> $1', table_name)
          into visible_count using fixture_prefix;
        assert visible_count = 0, 'Cross-owner Stage 3 read: ' || table_name;
      end if;
    end loop;
  end loop;

  assert not has_function_privilege(current_user,rpc,'EXECUTE'), 'Authenticated gained legacy retrieval EXECUTE';
  perform pg_temp.expect_failure('select * from public.match_chunks_hybrid_rrf(NULL, NULL, NULL)', '42501');
  reset role;
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);

  set local role anon;
  assert current_user = 'anon' and auth.uid() is null and current_setting('row_security') = 'on',
    'Anonymous role, identity, or row_security not established';
  foreach table_name in array array['projects','documents','document_chunks','interactions'] loop
    assert row_security_active(('public.' || table_name)::regclass), 'RLS inactive for anon: ' || table_name;
    perform pg_temp.expect_failure(format('select 1 from public.%I',table_name), '42501');
  end loop;

  assert not has_function_privilege(current_user,rpc,'EXECUTE'), 'Anon gained legacy retrieval EXECUTE';
  perform pg_temp.expect_failure('select * from public.match_chunks_hybrid_rrf(NULL, NULL, NULL)', '42501');
  reset role;
  assert has_function_privilege('service_role',rpc,'EXECUTE'), 'Service-role legacy retrieval EXECUTE missing';
end $$;

do $$
declare
  org uuid := gen_random_uuid();
  owner_department uuid := gen_random_uuid();
  other_department uuid := gen_random_uuid();
  employee uuid := gen_random_uuid();
  manager uuid := gen_random_uuid();
  approver uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  personal_project uuid := gen_random_uuid();
  foreign_personal_project uuid := gen_random_uuid();
  d12_project uuid := gen_random_uuid();
  standard_project uuid := gen_random_uuid();
  personal_doc uuid := gen_random_uuid();
  restricted_doc uuid := gen_random_uuid();
  cross_department_doc uuid := gen_random_uuid();
  d12_standard_doc uuid := gen_random_uuid();
  organization_interaction uuid := gen_random_uuid();
  personal_interaction uuid := gen_random_uuid();
  personal_before jsonb;
  authority_table text;
  actor uuid;
  changed integer;
  at_time timestamptz := statement_timestamp();
  dst_start timestamptz := '2026-10-25 12:00:00-04';
begin
  insert into auth.users (id, email) values
    (employee, employee || '@example.invalid'), (manager, manager || '@example.invalid'),
    (approver, approver || '@example.invalid'), (outsider, outsider || '@example.invalid');
  insert into public.organizations (id, name) values (org, 'Fixture organization');
  insert into public.departments (organization_id, id, name) values
    (org, owner_department, 'Owner department'), (org, other_department, 'Other department');
  insert into public.organization_employees (organization_id, user_id, department_id, role, is_active) values
    (org, employee, other_department, 'employee', true),
    (org, manager, owner_department, 'manager', true),
    (org, approver, owner_department, 'cxo', true);

  -- Use the pre-WP2A application insert shape for personal projects and documents.
  insert into public.projects (id, user_id, name) values
    (personal_project, manager, 'Personal project'),
    (foreign_personal_project, outsider, 'Another personal project');
  insert into public.projects (id, organization_id, department_id, is_d12, name) values
    (d12_project, org, owner_department, true, 'D12 project'),
    (standard_project, org, owner_department, false, 'Standard project');
  select to_jsonb(p) into personal_before from public.projects p where id = foreign_personal_project;

  insert into public.documents (id, project_id, storage_path, status) values
    (personal_doc, personal_project, 'wp2a/' || personal_doc, 'indexed'),
    (restricted_doc, d12_project, 'wp2a/' || restricted_doc, 'pending_upload');
  insert into public.documents (id, project_id, storage_path, status, classification) values
    (cross_department_doc, standard_project, 'wp2a/' || cross_department_doc, 'pending_upload', 'standard'),
    (d12_standard_doc, d12_project, 'wp2a/' || d12_standard_doc, 'pending_upload', 'standard');
  assert (select not is_published from public.documents where id = restricted_doc),
    'New document was published by default';
  update public.documents set status = 'indexed' where id = restricted_doc;
  assert (select status = 'indexed' and not is_published from public.documents where id = restricted_doc),
    'Transition to indexed published the document';

  insert into public.document_chunks (document_id, project_id, content, metadata, embedding) values
    (restricted_doc, d12_project, 'Synthetic organization knowledge', '{}',
      array_fill(0::real, array[1536])::extensions.vector(1536));
  insert into public.interactions
    (id, project_id, user_id, query_text, response_markdown, latency_ms, feedback)
  values
    (organization_interaction, d12_project, employee, 'Synthetic organization query',
      'Synthetic organization answer', 1, '{"rating":"thumbs_up"}'),
    (personal_interaction, personal_project, manager, 'Synthetic personal query',
      'Synthetic personal answer', 1, null);

  insert into public.project_memberships
    (project_id, organization_id, project_department_id, is_d12, user_id, valid_from, expires_at)
  values (d12_project, org, owner_department, true, employee, dst_start, dst_start + interval '2160 hours');
  perform pg_temp.expect_failure(format(
    'update public.project_memberships set expires_at = expires_at + interval ''1 microsecond'' where project_id = %L and user_id = %L',
    d12_project, employee), '23514', 'project_memberships_d12_duration');

  insert into public.document_grants
    (document_id, project_id, organization_id, project_department_id, is_d12, classification,
      user_id, recipient_department_id, approved_by, valid_from, expires_at)
  values
    (restricted_doc, d12_project, org, owner_department, true, 'restricted',
      employee, other_department, approver, dst_start, dst_start + interval '720 hours'),
    (cross_department_doc, standard_project, org, owner_department, false, 'standard',
      employee, other_department, approver, dst_start, dst_start + interval '2160 hours'),
    (d12_standard_doc, d12_project, org, owner_department, true, 'standard',
      manager, owner_department, approver, dst_start, dst_start + interval '2160 hours');
  perform pg_temp.expect_failure(format(
    'update public.document_grants set expires_at = valid_from + interval ''30 days'' where document_id = %L',
    restricted_doc), '23514', 'document_grants_restricted_duration');
  perform pg_temp.expect_failure(format(
    'update public.document_grants set expires_at = expires_at + interval ''1 microsecond'' where document_id = %L',
    cross_department_doc), '23514', 'document_grants_standard_cross_department_duration');
  perform pg_temp.expect_failure(format(
    'update public.document_grants set expires_at = expires_at + interval ''1 microsecond'' where document_id = %L',
    d12_standard_doc), '23514', 'document_grants_d12_duration');
  perform pg_temp.expect_failure(format(
    'update public.document_grants set approved_by = user_id where document_id = %L',
    restricted_doc), '23514', 'document_grants_no_self_approval');
  perform pg_temp.expect_failure(format(
    'update public.document_grants set recipient_department_id = %L where document_id = %L',
    owner_department, cross_department_doc), '23503');
  perform pg_temp.expect_failure(format(
    'update public.document_grants set is_d12 = false where document_id = %L',
    d12_standard_doc), '23503');
  perform pg_temp.expect_failure(format(
    'update public.document_grants set classification = ''standard'' where document_id = %L',
    restricted_doc), '23503');

  -- One membership and one grant for the same employee have independent clocks.
  update public.project_memberships set valid_from = at_time - interval '2 hours', expires_at = at_time
    where project_id = d12_project and user_id = employee;
  update public.document_grants set valid_from = at_time, expires_at = at_time + interval '1 hour'
    where document_id = restricted_doc and user_id = employee;
  assert (select not public.enterprise_access_window_is_current(valid_from, expires_at, revoked_at)
    from public.project_memberships where project_id = d12_project and user_id = employee),
    'Membership was valid at its exact expiry';
  assert (select public.enterprise_access_window_is_current(valid_from, expires_at, revoked_at)
    from public.document_grants where document_id = restricted_doc and user_id = employee),
    'Grant window was not valid at its start while membership was expired';
  update public.project_memberships set expires_at = at_time + interval '1 hour'
    where project_id = d12_project and user_id = employee;
  update public.document_grants set valid_from = at_time - interval '1 hour', expires_at = at_time
    where document_id = restricted_doc and user_id = employee;
  assert (select not public.enterprise_access_window_is_current(valid_from, expires_at, revoked_at)
    from public.document_grants where document_id = restricted_doc and user_id = employee),
    'Grant remained valid at its exact expiry';
  update public.document_grants set expires_at = at_time + interval '1 hour', revoked_at = at_time
    where document_id = restricted_doc and user_id = employee;
  assert (select not public.enterprise_access_window_is_current(valid_from, expires_at, revoked_at)
    from public.document_grants where document_id = restricted_doc and user_id = employee),
    'Revoked grant window remained valid';
  assert (select public.enterprise_access_window_is_current(valid_from, expires_at, revoked_at)
    from public.project_memberships where project_id = d12_project and user_id = employee),
    'Revoking a grant changed the independent membership window';
  update public.project_memberships set revoked_at = at_time
    where project_id = d12_project and user_id = employee;
  assert (select not public.enterprise_access_window_is_current(valid_from, expires_at, revoked_at)
    from public.project_memberships where project_id = d12_project and user_id = employee),
    'Revoked membership window remained valid';

  foreach authority_table in array array[
    'organizations', 'departments', 'organization_employees', 'project_memberships', 'document_grants'
  ] loop
    assert (select relrowsecurity from pg_class where oid = ('public.' || authority_table)::regclass),
      'Enterprise authority table is missing RLS';
    assert not has_table_privilege('service_role', 'public.' || authority_table, 'SELECT,INSERT,UPDATE,DELETE'),
      'Service role received authority access';
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claims','{"role":"anon"}',true);
    set local role anon;
    assert current_user = 'anon' and auth.uid() is null
      and row_security_active(('public.' || authority_table)::regclass), 'Anonymous enterprise role/RLS context mismatch';
    perform pg_temp.expect_failure(format('select * from public.%I', authority_table), '42501');
    reset role;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',employee,'role','authenticated')::text,true);
    set local role authenticated;
    assert current_user = 'authenticated' and auth.uid() = employee
      and row_security_active(('public.' || authority_table)::regclass), 'Authenticated enterprise role/RLS context mismatch';
    perform pg_temp.expect_failure(format('select * from public.%I', authority_table), '42501');
    reset role;
  end loop;

  foreach actor in array array[employee, manager, approver, outsider] loop
    perform set_config('request.jwt.claim.sub', actor::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);
    set local role authenticated;
    assert current_user = 'authenticated' and auth.uid() = actor
      and row_security_active('public.projects') and row_security_active('public.documents')
      and row_security_active('public.document_chunks') and row_security_active('public.interactions'),
      'Test did not enter an authenticated identity with active application RLS';
    assert not exists (select 1 from public.projects where id in (d12_project, standard_project)),
      'Organization project became visible';
    assert not exists (select 1 from public.documents where id = restricted_doc)
      and not exists (select 1 from public.document_chunks where project_id = d12_project)
      and not exists (select 1 from public.interactions where id = organization_interaction),
      'Organization knowledge or history became visible';
    if actor = manager then
      assert exists (select 1 from public.projects where id = personal_project and user_id = manager
        and organization_id is null and department_id is null and is_d12 is null),
        'Legacy personal owner lost project access';
      assert exists (select 1 from public.documents where id = personal_doc and not is_published),
        'Publication gated a personal-owner document';
      assert not exists (select 1 from public.projects where id = foreign_personal_project),
        'Another personal project became visible';
      update public.interactions set feedback = '{"rating":"thumbs_up"}' where id = personal_interaction;
      get diagnostics changed = row_count;
      assert changed = 1, 'Existing personal feedback behavior changed';
      perform pg_temp.expect_failure(format(
        'update public.projects set user_id = null, organization_id = %L, department_id = %L, is_d12 = true where id = %L',
        org, owner_department, personal_project), '42501');
    elsif actor <> outsider then
      assert not exists (select 1 from public.projects where id = personal_project),
        'An employee could read another user''s personal project';
    end if;
    if actor = employee then
      perform pg_temp.expect_failure(format(
        'update public.organization_employees set role = ''cxo'' where user_id = %L',
        employee), '42501');
      perform pg_temp.expect_failure(format(
        'update public.organization_employees set department_id = %L where user_id = %L',
        owner_department, employee), '42501');
      perform pg_temp.expect_failure(format('insert into public.document_grants (user_id) values (%L)', employee), '42501');
      perform pg_temp.expect_failure(format(
        'update public.document_grants set expires_at = expires_at + interval ''1 hour'' where user_id = %L',
        employee), '42501');
      perform pg_temp.expect_failure(format(
        'update public.document_grants set approved_by = user_id where user_id = %L', employee), '42501');
      perform pg_temp.expect_failure(format(
        'update public.document_grants set revoked_at = statement_timestamp() where user_id = %L', employee), '42501');
      delete from public.projects where id = d12_project;
      get diagnostics changed = row_count;
      assert changed = 0, 'Employee could delete an organization project';
    end if;
    reset role;
  end loop;

  update public.organization_employees set is_active = false
    where organization_id = org and user_id = employee;
  assert exists (select 1 from public.interactions where id = organization_interaction and user_id = employee),
    'Employee deactivation erased history';
  delete from auth.users where id = employee;
  assert not exists (select 1 from public.organization_employees where organization_id = org and user_id = employee)
    and not exists (select 1 from public.project_memberships where user_id = employee)
    and not exists (select 1 from public.document_grants where user_id = employee),
    'Employee authority survived removal of the Auth account';
  assert exists (select 1 from public.projects where id = d12_project and organization_id = org and user_id is null)
    and exists (select 1 from public.documents where id = restricted_doc and project_id = d12_project and not is_published)
    and exists (select 1 from public.document_chunks where document_id = restricted_doc
      and project_id = d12_project and embedding is not null and content = 'Synthetic organization knowledge')
    and exists (select 1 from public.interactions where id = organization_interaction and project_id = d12_project
      and user_id is null and response_markdown = 'Synthetic organization answer' and feedback->>'rating' = 'thumbs_up'),
    'Auth deletion did not preserve organization knowledge and history';
  assert (select to_jsonb(p) from public.projects p where id = foreign_personal_project) = personal_before,
    'The unrelated personal project changed during offboarding';
end $$;

-- Pending: eligible approvers, live enterprise retrieval, Storage access,
-- and intersection of D12 membership with document access are out of WP2A.
rollback;
