-- ADMINISTRATIVE ACTION: separate explicit approval required. Not an automatic migration.
-- Target only agentic-enterprise-rag (ldkxyleqfbovqpkpoyek); reconcile the observed employee/CXO role to manager.
begin;
set local lock_timeout = '5s';
do $$
declare
  previous_role text;
  updated integer;
begin
  if current_user <> 'postgres' then
    raise exception 'This action requires the approved database administrator' using errcode = '42501';
  end if;
  perform 1 from auth.users u
    where u.id = '23940244-8991-4d13-bc25-1c8e3a6cf5e2'::uuid
      and u.email = 'phani9119@gmail.com' and u.email_confirmed_at is not null
    for share;
  if not found then
    raise exception 'The verified designated Auth identity does not match the reviewed account';
  end if;
  select e.role into previous_role from public.organization_employees e
    join public.departments d on d.organization_id=e.organization_id and d.id=e.department_id
    where e.user_id='23940244-8991-4d13-bc25-1c8e3a6cf5e2'::uuid
      and e.organization_id='c0000000-0000-4000-8000-000000000001'::uuid
      and e.department_id='c0000000-0000-4000-8000-000000000002'::uuid
      and d.name='Engineering' and e.is_active
    for update of e;
  if not found or previous_role not in ('employee','manager','cxo') then
    raise exception 'The existing active Engineering membership does not match the reviewed assignment';
  end if;
  if previous_role='manager' then
    raise notice 'The designated membership is already manager; no changes made';
    return;
  end if;
  update public.organization_employees set role='manager'
    where user_id='23940244-8991-4d13-bc25-1c8e3a6cf5e2'::uuid
      and organization_id='c0000000-0000-4000-8000-000000000001'::uuid
      and department_id='c0000000-0000-4000-8000-000000000002'::uuid
      and is_active and role=previous_role;
  get diagnostics updated = row_count;
  if updated <> 1 then raise exception 'Expected exactly one existing membership update'; end if;
  -- PostgreSQL logs plus the post-commit verification identify this approved admin action.
  raise log '%', jsonb_build_object(
    'event','agentic_enterprise_uploader_role_assignment',
    'request','codex-designated-engineering-uploader-20261121',
    'actor',current_user,'transaction_id',txid_current(),
    'user_id','23940244-8991-4d13-bc25-1c8e3a6cf5e2',
    'organization_id','c0000000-0000-4000-8000-000000000001',
    'department_id','c0000000-0000-4000-8000-000000000002',
    'previous_role',previous_role,'new_role','manager',
    'approval','Explicit administrator action approved by the account owner in Codex'
  );
end
$$;
commit;

select e.user_id,e.organization_id,e.department_id,e.role,e.is_active
from public.organization_employees e
where e.user_id='23940244-8991-4d13-bc25-1c8e3a6cf5e2'::uuid
  and e.organization_id='c0000000-0000-4000-8000-000000000001'::uuid;
