-- Run only through the isolated bootstrap runner, with baseline_expected supplied
-- from expected-catalog.json. Fixtures and all writes in this file roll back.
begin;
set local search_path = public, extensions;
set local plpgsql.check_asserts = on;
create function pg_temp.normalized(value text) returns text language sql immutable as $$
  select regexp_replace(lower(value), '\s+', '', 'g')
$$;

do $$
declare
  table_name text; spec jsonb; item jsonb; actual record; relation oid; expected_names text[];
  privilege text; column_name text; allowed boolean; rpc record;
begin
  assert current_setting('server_version_num')::integer / 10000 = 17, 'PostgreSQL major mismatch';
  assert current_setting('cron.launch_active_jobs') = 'off', 'Cron scheduling must be disabled';
  assert position('pg_net' in current_setting('shared_preload_libraries')) = 0, 'pg_net worker must remain disabled';
  assert not exists (select 1 from pg_stat_activity where backend_type like 'pg_net%'), 'pg_net worker is running';
  assert (select count(*) from pg_extension where extname in
    ('vector','pg_cron','pg_net','pgcrypto','uuid-ossp','supabase_vault')) = 6, 'Required real extension missing';
  assert not exists (select 1 from auth.users), 'Database must contain no users before fixtures';
  assert not exists (select 1 from vault.secrets), 'Vault must contain no imported bindings';
  assert not exists (select 1 from net.http_request_queue), 'HTTP queue must be empty';
  assert not exists (select 1 from net._http_response), 'Unexpected HTTP activity';

  for table_name, spec in select key, value from baseline_expected, jsonb_each(catalog) loop
    relation := to_regclass('public.' || table_name);
    assert relation is not null, format('Table %s missing', table_name);
    assert (select relrowsecurity from pg_class where oid = relation), format('RLS disabled on %s', table_name);
    execute format('select count(*) as n from public.%I', table_name) into actual;
    assert actual.n = 0, format('Unexpected data in %s', table_name);
    select array_agg(value->>'name' order by ordinality) into expected_names
      from jsonb_array_elements(spec->'columns') with ordinality;
    assert (select array_agg(attname::text order by attnum) from pg_attribute
      where attrelid=relation and attnum>0 and not attisdropped) = expected_names,
      format('Column set/order mismatch on %s', table_name);
    for item in select value from jsonb_array_elements(spec->'columns') loop
      select format_type(a.atttypid,a.atttypmod) as type, a.attnotnull as notnull,
        a.attgenerated='s' as generated, pg_get_expr(d.adbin,d.adrelid) as expression into actual
        from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid=relation and a.attname=item->>'name';
      assert actual.type=item->>'type' and actual.notnull=(item->>'notnull')::boolean
        and actual.generated=(item->>'generated')::boolean
        and pg_temp.normalized(actual.expression) is not distinct from pg_temp.normalized(item->>'expression'),
        format('Column metadata mismatch: %s.%s (%s)', table_name,item->>'name',row_to_json(actual));
    end loop;
    assert (select count(*) from pg_constraint where conrelid=relation)=jsonb_array_length(spec->'constraints'),
      format('Constraint count mismatch on %s',table_name);
    for item in select value from jsonb_array_elements(spec->'constraints') loop
      assert exists (select 1 from pg_constraint where conrelid=relation and conname=item->>'name'
        and case when contype='c' then
          pg_temp.normalized(pg_get_expr(conbin,conrelid,true))=
            pg_temp.normalized(substring(item->>'definition' from '^CHECK \((.*)\)$'))
        else pg_temp.normalized(pg_get_constraintdef(oid))=pg_temp.normalized(item->>'definition') end),
        format('Constraint mismatch: %s.%s',table_name,item->>'name');
    end loop;
    assert (select count(*) from pg_index where indrelid=relation)=jsonb_array_length(spec->'indexes'),
      format('Index count mismatch on %s',table_name);
    for item in select value from jsonb_array_elements(spec->'indexes') loop
      assert exists (select 1 from pg_index where indrelid=relation
        and pg_temp.normalized(pg_get_indexdef(indexrelid))=pg_temp.normalized(item#>>'{}')),
        format('Index mismatch: %s',item#>>'{}');
    end loop;
    assert (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=table_name)
      =jsonb_array_length(spec->'policies'), format('Policy count mismatch on %s',table_name);
    for item in select value from jsonb_array_elements(spec->'policies') loop
      assert exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=table_name
        and p.policyname=item->>'name' and p.permissive=item->>'permissive' and p.cmd=item->>'cmd'
        and to_jsonb(p.roles)=item->'roles'
        and pg_temp.normalized(p.qual) is not distinct from pg_temp.normalized(item->>'qual')
        and pg_temp.normalized(p.with_check) is not distinct from pg_temp.normalized(item->>'check')),
        format('Policy mismatch: %s.%s',table_name,item->>'name');
    end loop;
    foreach privilege in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      assert not has_table_privilege('anon',relation,privilege), format('Anonymous %s on %s',privilege,table_name);
      allowed := privilege='SELECT' or (table_name='projects' and privilege in ('INSERT','UPDATE','DELETE'))
        or (table_name='documents' and privilege='DELETE');
      assert has_table_privilege('authenticated',relation,privilege)=allowed,
        format('Authenticated %s mismatch on %s',privilege,table_name);
      if privilege in ('SELECT','INSERT','UPDATE','DELETE') then
        assert has_table_privilege('service_role',relation,privilege), 'Missing service CRUD grant';
      end if;
    end loop;
    for column_name in select attname from pg_attribute where attrelid=relation and attnum>0 and not attisdropped loop
      assert not has_column_privilege('anon',relation,column_name,'UPDATE'), 'Anonymous column UPDATE';
      assert has_column_privilege('authenticated',relation,column_name,'UPDATE')=
        (table_name='projects' or (table_name='interactions' and column_name='feedback')),
        format('Column UPDATE mismatch: %s.%s',table_name,column_name);
    end loop;
  end loop;
  assert (select count(*) from pg_constraint where conrelid in ('public.projects'::regclass,
    'public.documents'::regclass,'public.document_chunks'::regclass,'public.interactions'::regclass)
    and contype='f' and confdeltype='c')=6, 'Cascade FK mismatch';
  assert (select count(distinct proname) from pg_proc where pronamespace='public'::regnamespace
    and proname in ('check_project_document_limit','match_chunks_hybrid_rrf','enforce_document_quota',
      'claim_document_ingestion','fail_document_ingestion','finish_document_ingestion','recover_document_ingestion',
      'dispatch_document_ingestion','delete_document_children','delete_project_children'))=10, 'Required function missing';
  assert not (select prosecdef from pg_proc where oid=
    'public.match_chunks_hybrid_rrf(extensions.vector,text,uuid,integer,integer)'::regprocedure), 'Retrieval security mode mismatch';
  for rpc in select oid,proname from pg_proc where pronamespace='public'::regnamespace and proname in
    ('match_chunks_hybrid_rrf','claim_document_ingestion','fail_document_ingestion','finish_document_ingestion',
     'recover_document_ingestion','dispatch_document_ingestion','delete_document_children','delete_project_children') loop
    assert not has_function_privilege('anon',rpc.oid,'EXECUTE')
      and not has_function_privilege('authenticated',rpc.oid,'EXECUTE'), 'Privileged function exposed to clients';
    if rpc.proname in ('match_chunks_hybrid_rrf','claim_document_ingestion','fail_document_ingestion',
      'finish_document_ingestion','recover_document_ingestion') then
      assert has_function_privilege('service_role',rpc.oid,'EXECUTE'), 'Service RPC grant missing';
    end if;
  end loop;
  assert exists (select 1 from cron.job where jobname='recover-document-ingestion'
    and schedule='* * * * *' and command='select public.recover_document_ingestion();'), 'Recovery job missing';
  assert not exists (select 1 from cron.job_run_details), 'A scheduled job was executed';
  assert (select count(*) from pg_trigger where not tgisinternal and
    (tgrelid='public.documents'::regclass and tgname in
      ('delete_document_children','enforce_document_quota','trg_enforce_project_document_limit')
    or tgrelid='public.projects'::regclass and tgname='delete_project_children'
    or tgrelid='storage.objects'::regclass and tgname='storage.objects.insert'))=5, 'Application trigger mismatch';
  assert (select count(*) from pg_trigger where not tgisinternal and tgrelid='storage.objects'::regclass
    and tgname in ('protect_objects_delete','update_objects_updated_at'))=2, 'Managed Storage triggers missing';
  raise notice 'PASS: audited columns/defaults, constraints, indexes, 14 policies, grants, cascades, functions and isolation settings';
end $$;

insert into auth.users(id,email) values ('11111111-1111-4111-8111-111111111111','baseline@example.invalid');
insert into public.projects(id,user_id,name) values
  ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Synthetic baseline');
insert into public.documents(id,project_id,storage_path,status) values
  ('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','synthetic/baseline.txt','indexed');
insert into public.document_chunks(id,document_id,project_id,content,embedding) values
  ('44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333',
   '22222222-2222-4222-8222-222222222222','baseline evidence',array_fill(0.1::real,array[1536])::vector);
insert into public.interactions(id,project_id,user_id,query_text,response_markdown,latency_ms) values
  ('55555555-5555-4555-8555-555555555555','22222222-2222-4222-8222-222222222222',
   '11111111-1111-4111-8111-111111111111','baseline','Synthetic answer [Chunk 1].',1);

do $$ declare changed integer; begin
  assert (select vector_dims(embedding)=1536 and fts=to_tsvector('simple','baseline evidence')
    from public.document_chunks where id='44444444-4444-4444-8444-444444444444'), 'Vector/FTS storage failed';
  assert (select count(*) from public.match_chunks_hybrid_rrf(array_fill(0.1::real,array[1536])::vector,
    'baseline evidence','22222222-2222-4222-8222-222222222222',5,60))=1, 'Actual RRF function failed';
  perform set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
  perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
  set local role authenticated;
  update public.interactions set feedback='{"rating":"thumbs_up"}' where id='55555555-5555-4555-8555-555555555555';
  get diagnostics changed=row_count;
  assert changed=1, 'Authenticated feedback update failed';
  begin
    update public.interactions set response_markdown='forged' where id='55555555-5555-4555-8555-555555555555';
    raise exception 'Protected column UPDATE succeeded';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.interactions(project_id) values ('22222222-2222-4222-8222-222222222222');
    raise exception 'Client INSERT succeeded';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.interactions where id='55555555-5555-4555-8555-555555555555';
    raise exception 'Client DELETE succeeded';
  exception when insufficient_privilege then null; end;
  reset role;
  set local role anon;
  begin
    perform 1 from public.interactions;
    raise exception 'Anonymous SELECT succeeded';
  exception when insufficient_privilege then null; end;
  reset role;
  assert not exists (select 1 from net.http_request_queue) and not exists (select 1 from net._http_response),
    'Unexpected HTTP requests';
  raise notice 'PASS: synthetic vector/FTS/RRF, authenticated feedback, protected columns, client INSERT/DELETE and anonymous denial';
end $$;
rollback;
