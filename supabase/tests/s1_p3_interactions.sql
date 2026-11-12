-- LOCAL ONLY: invoked through s1-p3.ps1 after Docker identity/isolation checks.
-- All synthetic records and the WITH CHECK test trigger roll back on exit/error.
begin;
set local search_path=public,extensions;
set local plpgsql.check_asserts=on;
do $$ begin
  assert current_setting('s1p3.local_target',true)='rag-baseline-20261107-01a1b3be', 'Guarded local connection required';
  assert current_setting('cron.launch_active_jobs')='off', 'Cron must remain disabled';
  assert position('pg_net' in current_setting('shared_preload_libraries'))=0, 'Outbound worker must remain disabled';
  assert not exists (select 1 from auth.users) and not exists (select 1 from public.projects)
    and not exists (select 1 from public.interactions), 'Empty disposable fixture database required';
end $$;

create function pg_temp.assert_client(who uuid, expected_role text) returns void
language plpgsql security invoker as $$ begin
  assert current_user=expected_role, 'Wrong effective database role';
  assert auth.uid() is not distinct from who, 'Wrong auth.uid()';
  assert current_setting('request.jwt.claims')::jsonb->>'role'=expected_role, 'Wrong JWT role claim';
  assert (nullif(current_setting('request.jwt.claims')::jsonb->>'sub',''))::uuid is not distinct from who, 'Wrong JWT subject claim';
  assert not (select rolsuper or rolbypassrls from pg_roles where rolname=current_user), 'Client bypasses RLS';
  assert not pg_has_role(current_user,(select relowner from pg_class where oid='public.interactions'::regclass),'USAGE'), 'Client inherits table ownership';
  assert current_setting('row_security')='on', 'RLS evaluation disabled';
  assert not has_table_privilege(current_user,'public.interactions','INSERT,UPDATE,DELETE'), 'Unexpected client write privileges';
  if expected_role='authenticated' then
    assert has_table_privilege(current_user,'public.interactions','SELECT')
      and has_column_privilege(current_user,'public.interactions','feedback','UPDATE'), 'Owner feedback grants missing';
  else
    assert not has_table_privilege(current_user,'public.interactions','SELECT')
      and not has_column_privilege(current_user,'public.interactions','feedback','UPDATE'), 'Anonymous grants exposed';
  end if;
end $$;

insert into auth.users(id,email) values
  ('10000000-0000-4000-8000-000000000001','s1-a@example.invalid'),
  ('10000000-0000-4000-8000-000000000002','s1-b@example.invalid');
insert into public.projects(id,user_id,name) values
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','A1'),
  ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','A2'),
  ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','B1');
insert into public.interactions(id,project_id,user_id,query_text,response_markdown,latency_ms) values
  ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','A1','Synthetic A1',1),
  ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','A2','Synthetic A2',2),
  ('30000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','B1','Synthetic B1',3),
  ('30000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','B in A1','Synthetic mismatch',4),
  ('30000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','A in B1','Synthetic mismatch',5);
create temporary table original_interactions as select id,to_jsonb(i) as value from public.interactions i;

select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$ declare changed integer; protected_column text; denied boolean; begin
  perform pg_temp.assert_client('10000000-0000-4000-8000-000000000001','authenticated');
  assert (select count(*) from public.interactions where id='30000000-0000-4000-8000-000000000001')=1, 'T01 owner SELECT denied';
  raise notice 'PASSED T01';
  assert (select count(*) from public.interactions where project_id in
    ('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002') and id in
    ('30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002'))=2, 'T02 two-project owner SELECT mismatch';
  raise notice 'PASSED T02';
  assert (select count(*) from public.interactions where id='30000000-0000-4000-8000-000000000003')=0, 'T03 foreign SELECT allowed';
  raise notice 'PASSED T03';
  assert (select count(*) from public.interactions where id='30000000-0000-4000-8000-000000000004')=0, 'T05 project ownership alone allowed SELECT';
  raise notice 'PASSED T05';
  update public.interactions set feedback='{"rating":"thumbs_up","issue_tag":null,"comment":"A feedback","updated_at":"2026-11-07T00:00:00.000Z"}'
    where id='30000000-0000-4000-8000-000000000001';
  get diagnostics changed=row_count;
  assert changed=1 and (select feedback->>'comment'='A feedback' from public.interactions where id='30000000-0000-4000-8000-000000000001'), 'T07 feedback not saved';
  raise notice 'PASSED T07';
  update public.interactions set feedback='{"rating":"thumbs_down"}' where id='30000000-0000-4000-8000-000000000003';
  get diagnostics changed=row_count;
  assert changed=0, 'T09 foreign feedback updated';
  raise notice 'PASSED T09';
  foreach protected_column in array array['30000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000005'] loop
    update public.interactions set feedback='{"rating":"thumbs_down"}' where id=protected_column::uuid;
    get diagnostics changed=row_count;
    assert changed=0, 'T10 A updated mismatched ownership';
  end loop;
  for protected_column in select attname from pg_attribute where attrelid='public.interactions'::regclass
    and attnum>0 and not attisdropped and attname<>'feedback' loop
    assert not has_column_privilege(current_user,'public.interactions',protected_column,'UPDATE'), 'T11 protected column grant';
    denied:=false;
    begin
      execute format('update public.interactions set %I=%I where id=%L',protected_column,protected_column,'30000000-0000-4000-8000-000000000001');
    exception when insufficient_privilege then denied:=true; end;
    assert denied, format('T11 protected column %s was writable',protected_column);
  end loop;
  denied:=false;
  begin
    insert into public.interactions(id,project_id,user_id,query_text,response_markdown,latency_ms) values
      ('30000000-0000-4000-8000-000000000099','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','forged','forged',0);
  exception when insufficient_privilege then denied:=true; end;
  assert denied, 'T11 client INSERT allowed';
  denied:=false;
  begin
    delete from public.interactions where id='30000000-0000-4000-8000-000000000001';
  exception when insufficient_privilege then denied:=true; end;
  assert denied, 'T11 client DELETE allowed';
  raise notice 'PASSED T11';
end $$;
reset role;

select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
set local role authenticated;
do $$ declare changed integer; target uuid; begin
  perform pg_temp.assert_client('10000000-0000-4000-8000-000000000002','authenticated');
  assert (select count(*) from public.interactions where id='30000000-0000-4000-8000-000000000001')=0, 'T04 foreign SELECT allowed';
  raise notice 'PASSED T04';
  assert (select count(*) from public.interactions where id='30000000-0000-4000-8000-000000000004')=0, 'T06 interaction ownership alone allowed SELECT';
  raise notice 'PASSED T06';
  update public.interactions set feedback='{"rating":"thumbs_down","issue_tag":"test","comment":"B feedback","updated_at":"2026-11-07T00:00:00.000Z"}'
    where id='30000000-0000-4000-8000-000000000003';
  get diagnostics changed=row_count;
  assert changed=1 and (select feedback->>'comment'='B feedback' from public.interactions where id='30000000-0000-4000-8000-000000000003'), 'T08 feedback not saved';
  raise notice 'PASSED T08';
  foreach target in array array['30000000-0000-4000-8000-000000000004'::uuid,'30000000-0000-4000-8000-000000000005'::uuid] loop
    update public.interactions set feedback='{"rating":"thumbs_down"}' where id=target;
    get diagnostics changed=row_count;
    assert changed=0, 'T10 B updated mismatched ownership';
  end loop;
  raise notice 'PASSED T10';
end $$;
reset role;

select set_config('request.jwt.claims','{"role":"anon"}',true);
select set_config('request.jwt.claim.sub','',true);
set local role anon;
do $$ declare denied boolean; begin
  perform pg_temp.assert_client(null,'anon');
  denied:=false;
  begin perform 1 from public.interactions;
  exception when insufficient_privilege then denied:=true; end;
  assert denied, 'T12 anonymous SELECT allowed';
  denied:=false;
  begin update public.interactions set feedback='{"rating":"thumbs_down"}' where id='30000000-0000-4000-8000-000000000001';
  exception when insufficient_privilege then denied:=true; end;
  assert denied, 'T12 anonymous feedback UPDATE allowed';
  raise notice 'PASSED T12';
end $$;
reset role;

do $$ begin
  assert (select count(*) from public.interactions)=5, 'A denied operation inserted/deleted data';
  assert not exists (select 1 from public.interactions i join original_interactions o using(id)
    where to_jsonb(i)-'feedback' <> o.value-'feedback'), 'Protected data changed';
  assert not exists (select 1 from public.interactions i join original_interactions o using(id)
    where i.id not in ('30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000003')
    and to_jsonb(i)<>o.value), 'Denied target was modified';
  assert (select feedback='{"rating":"thumbs_up","issue_tag":null,"comment":"A feedback","updated_at":"2026-11-07T00:00:00.000Z"}'::jsonb
    from public.interactions where id='30000000-0000-4000-8000-000000000001'), 'A JSONB payload mismatch';
  assert (select feedback='{"rating":"thumbs_down","issue_tag":"test","comment":"B feedback","updated_at":"2026-11-07T00:00:00.000Z"}'::jsonb
    from public.interactions where id='30000000-0000-4000-8000-000000000003'), 'B JSONB payload mismatch';
end $$;

-- This uncommitted test trigger exercises resulting-row checks without granting
-- protected-column UPDATE to clients. It disappears with the fixture rollback.
create function pg_temp.change_resulting_owner() returns trigger language plpgsql security invoker as $$ begin
  if new.feedback->>'s1_test'='user' then new.user_id:='10000000-0000-4000-8000-000000000002';
  elsif new.feedback->>'s1_test'='project' then new.project_id:='20000000-0000-4000-8000-000000000003'; end if;
  return new;
end $$;
create trigger s1_p3_resulting_owner before update of feedback on public.interactions
  for each row execute function pg_temp.change_resulting_owner();
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$ declare scenario text; denied boolean; begin
  perform pg_temp.assert_client('10000000-0000-4000-8000-000000000001','authenticated');
  foreach scenario in array array['user','project'] loop
    denied:=false;
    begin
      update public.interactions set feedback=jsonb_build_object('s1_test',scenario)
        where id='30000000-0000-4000-8000-000000000001';
    exception when insufficient_privilege then denied:=true; end;
    assert denied, format('WITH CHECK accepted a resulting %s ownership violation',scenario);
  end loop;
  raise notice 'PASSED WITH_CHECK_USER_AND_PROJECT';
end $$;
reset role;
do $$ begin
  assert (select feedback->>'comment'='A feedback' and user_id='10000000-0000-4000-8000-000000000001'
    and project_id='20000000-0000-4000-8000-000000000001' from public.interactions
    where id='30000000-0000-4000-8000-000000000001'), 'Rejected resulting row changed persisted data';
end $$;

select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.sub','',true);
set local role service_role;
do $$ begin
  assert current_user='service_role' and auth.uid() is null, 'Wrong server role';
  assert (select rolbypassrls from pg_roles where rolname=current_user), 'Existing server bypass capability changed';
  assert has_table_privilege(current_user,'public.interactions','INSERT'), 'Server INSERT grant lost';
  insert into public.interactions(id,project_id,user_id,query_text,response_markdown,latency_ms) values
    ('30000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','server flow','Synthetic telemetry',6);
  assert (select user_id='10000000-0000-4000-8000-000000000001' from public.interactions
    where id='30000000-0000-4000-8000-000000000006'), 'Server ownership field not stored';
  raise notice 'PASSED SERVER_TELEMETRY';
end $$;
reset role;

do $$ declare p record; predicate text; begin
  assert (select count(*) from pg_policies where schemaname='public' and tablename='interactions')=3, 'Unexpected policy composition';
  assert exists (select 1 from pg_policies where schemaname='public' and tablename='interactions'
    and policyname='owner_boundary' and permissive='RESTRICTIVE' and cmd='ALL' and roles=array['public']::name[]), 'Restrictive boundary missing';
  for p in select * from pg_policies where schemaname='public' and tablename='interactions' and permissive='PERMISSIVE' loop
    assert p.roles=array['authenticated']::name[] and p.cmd in ('SELECT','UPDATE'), 'Broader permissive operation/role';
    assert p.policyname=case p.cmd when 'SELECT' then 'owner_read' else 'owner_feedback_update' end, 'Unexpected explicit policy';
    foreach predicate in array case when p.cmd='UPDATE' then array[p.qual,p.with_check] else array[p.qual] end loop
      assert position('user_id = auth.uid()' in predicate)>0
        and position('p.id = interactions.project_id' in predicate)>0
        and position('p.user_id = auth.uid()' in predicate)>0
        and predicate !~ '\mOR\M', 'Policy is missing a required ownership predicate';
    end loop;
  end loop;
  assert not exists (select 1 from net.http_request_queue) and not exists (select 1 from net._http_response), 'Unexpected outbound activity';
  raise notice 'PASSED POLICY_CONTRACT';
end $$;
rollback;
