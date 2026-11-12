-- Run against a disposable migrated database as postgres: psql -v ON_ERROR_STOP=1 -f this_file.
-- Real roles/RLS/grants; all fixtures and writes roll back, including on assertion failure.
begin;
set local plpgsql.check_asserts = on;
create temporary table authz_fixture (a uuid, b uuid, pa uuid, pb uuid, da uuid, db uuid, ia uuid, ib uuid);
insert into authz_fixture values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
                                 gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid());
grant select on authz_fixture to authenticated, anon;
insert into auth.users(id, email) select a, a || '@example.com' from authz_fixture
  union all select b, b || '@example.com' from authz_fixture;
insert into public.projects(id, user_id, name) select pa, a, 'A' from authz_fixture
  union all select pb, b, 'B' from authz_fixture;
insert into public.documents(id, project_id, storage_path, status)
  select da, pa, a || '/' || pa || '/' || da || '/authz.txt', 'indexed' from authz_fixture
  union all select db, pb, b || '/' || pb || '/' || db || '/authz.txt', 'indexed' from authz_fixture;
insert into public.document_chunks(document_id, project_id, content, metadata)
  select da, pa, 'A', '{}'::jsonb from authz_fixture union all select db, pb, 'B', '{}'::jsonb from authz_fixture;
insert into public.interactions(id, project_id, user_id, query_text, response_markdown, retrieved_chunk_ids, latency_ms)
  select ia, pa, a, 'A', 'A', '{}'::uuid[], 0 from authz_fixture
  union all select ib, pb, b, 'B', 'B', '{}'::uuid[], 0 from authz_fixture;
insert into storage.objects(bucket_id, name)
  select 'documents', storage_path from public.documents where id in (select da from authz_fixture union all select db from authz_fixture);

create function pg_temp.must_deny(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'Expected insufficient_privilege: %', command;
end $$;

do $$
declare f record; fn record; n integer; changed integer; own_id uuid; other_id uuid; own_project uuid; other_project uuid;
        own_doc uuid; other_doc uuid; own_interaction uuid; other_interaction uuid; t text;
begin
  select * into f from authz_fixture;
  foreach t in array array['delete_document_children', 'delete_project_children'] loop
    assert not has_function_privilege('anon', ('public.' || t || '()')::regprocedure, 'EXECUTE'), 'Anonymous cleanup grant';
    assert not has_function_privilege('authenticated', ('public.' || t || '()')::regprocedure, 'EXECUTE'), 'Authenticated cleanup grant';
  end loop;
  -- Inspect every overload, including recovery, without invoking its global dispatcher.
  foreach t in array array['match_chunks_hybrid_rrf', 'claim_document_ingestion', 'finish_document_ingestion',
                           'fail_document_ingestion', 'recover_document_ingestion'] loop
    n := 0;
    for fn in select oid from pg_proc where pronamespace = 'public'::regnamespace and proname = t loop
      n := n + 1;
      assert not has_function_privilege('anon', fn.oid, 'EXECUTE'), 'Anonymous RPC grant';
      assert not has_function_privilege('authenticated', fn.oid, 'EXECUTE'), 'Authenticated RPC grant';
      assert has_function_privilege('service_role', fn.oid, 'EXECUTE'), 'Service RPC grant missing';
    end loop;
    assert n > 0, 'Required RPC missing';
  end loop;
  for n in 1..2 loop
    own_id := case n when 1 then f.a else f.b end;
    other_id := case n when 1 then f.b else f.a end;
    own_project := case n when 1 then f.pa else f.pb end;
    other_project := case n when 1 then f.pb else f.pa end;
    own_doc := case n when 1 then f.da else f.db end;
    other_doc := case n when 1 then f.db else f.da end;
    own_interaction := case n when 1 then f.ia else f.ib end;
    other_interaction := case n when 1 then f.ib else f.ia end;
    perform set_config('request.jwt.claim.sub', own_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', own_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
    assert current_user = 'authenticated' and auth.uid() = own_id, 'Role/session mismatch';
    assert (select count(*) from public.projects where id = own_project) = 1, 'Own project hidden';
    assert (select count(*) from public.projects where id = other_project) = 0, 'Foreign project visible';
    foreach t in array array['documents', 'document_chunks', 'interactions'] loop
      execute format('select count(*) from public.%I where project_id = $1', t) into changed using own_project;
      assert changed = 1, 'Own child row hidden';
      execute format('select count(*) from public.%I where project_id = $1', t) into changed using other_project;
      assert changed = 0, 'Foreign child row visible';
      perform pg_temp.must_deny(format('insert into public.%I(project_id) values (%L)', t, own_project));
    end loop;
    update public.projects set name = 'own edit' where id = own_project;
    get diagnostics changed = row_count;
    assert changed = 1, 'Owner update must succeed';
    update public.projects set name = 'stolen' where id = other_project;
    get diagnostics changed = row_count;
    assert changed = 0, 'Foreign update succeeded';
    delete from public.projects where id = other_project;
    get diagnostics changed = row_count;
    assert changed = 0, 'Foreign delete succeeded';
    delete from public.documents where id = other_doc;
    get diagnostics changed = row_count;
    assert changed = 0, 'Foreign document delete succeeded';
    perform pg_temp.must_deny(format('update public.projects set user_id = %L where id = %L', other_id, own_project));
    perform pg_temp.must_deny(format('insert into public.projects(user_id, name) values (%L, ''forged'')', other_id));
    update public.interactions set feedback = '{"rating":"thumbs_up"}' where id = own_interaction;
    get diagnostics changed = row_count;
    assert changed = 1, 'Owner feedback must succeed';
    update public.interactions set feedback = '{"rating":"thumbs_down"}' where id = other_interaction;
    get diagnostics changed = row_count;
    assert changed = 0, 'Foreign feedback succeeded';
    perform pg_temp.must_deny(format('update public.interactions set response_markdown = ''forged'' where id = %L', own_interaction));
    assert (select count(*) from storage.objects where bucket_id = 'documents' and name like own_id || '/%') = 1, 'Owner storage read denied';
    assert (select count(*) from storage.objects where bucket_id = 'documents' and name like other_id || '/%') = 0, 'Foreign storage read allowed';
    perform pg_temp.must_deny(format('insert into storage.objects(bucket_id, name) values (''documents'', %L)', own_id || '/forged.txt'));
    delete from storage.objects where bucket_id = 'documents' and name like own_id || '/%';
    get diagnostics changed = row_count;
    assert changed = 0, 'Direct storage delete allowed';
    reset role;
  end loop;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  foreach t in array array['projects', 'documents', 'document_chunks', 'interactions'] loop
    perform pg_temp.must_deny(format('select * from public.%I', t));
  end loop;
  assert (select count(*) from storage.objects where bucket_id = 'documents') = 0, 'Anonymous storage read allowed';
  reset role;
  assert (select count(*) from public.projects where id in (f.pa, f.pb) and name = 'own edit') = 2, 'Victim projects changed';
  assert (select count(*) from public.interactions where id in (f.ia, f.ib) and feedback->>'rating' = 'thumbs_up') = 2, 'Victim feedback changed';
  perform set_config('request.jwt.claim.sub', f.a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', f.a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.documents where id = f.da;
  get diagnostics changed = row_count;
  assert changed = 1, 'Owner document delete denied';
  assert (select count(*) from public.document_chunks where document_id = f.da) = 0, 'Document children not deleted';
  delete from public.projects where id = f.pa;
  get diagnostics changed = row_count;
  assert changed = 1, 'Owner project delete denied';
  reset role;
  assert (select count(*) from public.interactions where id = f.ia) = 0, 'Project children not deleted';
  assert (select count(*) from public.projects where id = f.pb) = 1, 'Owner delete affected foreign project';
end $$;
rollback;
