begin;
set local lock_timeout = '5s';

-- 1. Safe, authenticated, one-time demo employee enrollment RPC bound strictly to auth.uid().
drop function if exists public.onboard_demo_employee(text);
drop function if exists wp3_private.onboard_demo_employee(text);

create function wp3_private.onboard_demo_employee(target_department text)
returns table (
  organization_id uuid,
  department_id uuid,
  department_name text,
  role text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_dept_input text := btrim(coalesce(target_department, ''));
  v_org_id uuid;
  v_dept_id uuid;
  v_existing record;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select o.id into v_org_id
  from public.organizations o
  where o.id = 'c0000000-0000-4000-8000-000000000001'::uuid
    and o.name = 'DeccanBridge Software'
  limit 1;
  if v_org_id is null then
    raise exception 'Enterprise organization not found' using errcode = 'P0002';
  end if;

  select d.id into v_dept_id
  from public.departments d
  where d.organization_id = v_org_id
    and d.name in (
      'Engineering', 'HR', 'Product Management', 'Project Management',
      'UI/UX', 'Operations', 'Marketing', 'Finance'
    )
    and (d.name = v_dept_input or d.id::text = v_dept_input)
  order by d.id
  limit 1;
  if v_dept_id is null then
    raise exception 'Invalid department' using errcode = '22023';
  end if;

  insert into public.organization_employees (organization_id, user_id, department_id, role, is_active)
  values (v_org_id, v_user_id, v_dept_id, 'employee', true)
  on conflict on constraint organization_employees_pkey do nothing;

  select e.organization_id, e.department_id, d.name as department_name, e.role, e.is_active
  into v_existing
  from public.organization_employees e
  join public.departments d
    on d.id = e.department_id
   and d.organization_id = e.organization_id
  where e.organization_id = v_org_id
    and e.user_id = v_user_id;

  if not found or not v_existing.is_active then
    raise exception 'Employee onboarding denied' using errcode = '42501';
  end if;

  if v_existing.department_id <> v_dept_id or v_existing.role <> 'employee' then
    raise exception 'Department assignment is one-time and cannot be changed' using errcode = '42501';
  end if;

  return query
  select v_existing.organization_id, v_existing.department_id, v_existing.department_name, v_existing.role;
end
$$;

create function public.onboard_demo_employee(target_department text)
returns table (
  organization_id uuid,
  department_id uuid,
  department_name text,
  role text
)
language sql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select * from wp3_private.onboard_demo_employee(target_department);
$$;

revoke all on function wp3_private.onboard_demo_employee(text),
  public.onboard_demo_employee(text)
  from public, anon, authenticated, service_role;

grant execute on function wp3_private.onboard_demo_employee(text),
  public.onboard_demo_employee(text)
  to authenticated;

-- 2. Extend enterprise_account_status() to include trusted department_id and department_name.
drop function if exists public.enterprise_account_status();
drop function if exists wp3_private.enterprise_account_status();

create function wp3_private.enterprise_account_status()
returns table (
  organization_id uuid,
  organization_name text,
  department_id uuid,
  department_name text,
  role text,
  is_active boolean
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select e.organization_id, o.name, e.department_id, d.name, e.role, e.is_active
  from public.organization_employees e
  join public.organizations o
    on o.id = e.organization_id
  join public.departments d
    on d.id = e.department_id
   and d.organization_id = e.organization_id
  where e.user_id = (select auth.uid())
  order by e.is_active desc, e.organization_id
  limit 1;
$$;

create function public.enterprise_account_status()
returns table (
  organization_id uuid,
  organization_name text,
  department_id uuid,
  department_name text,
  role text,
  is_active boolean
)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select * from wp3_private.enterprise_account_status();
$$;

revoke all on function wp3_private.enterprise_account_status(),
  public.enterprise_account_status()
  from public, anon, authenticated, service_role;

grant execute on function wp3_private.enterprise_account_status(),
  public.enterprise_account_status()
  to authenticated;

-- 3. Preserve explicit checked/unchecked Jira opt-in/opt-out preference at signup
--    and atomically enroll verified users who selected a valid DeccanBridge department.
create or replace function public.handle_demo_jira_signup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dept_input text;
  v_org_id uuid := 'c0000000-0000-4000-8000-000000000001'::uuid;
  v_dept_id uuid;
begin
  if new.raw_user_meta_data is not null and (new.raw_user_meta_data ? 'demo_jira_access') then
    insert into public.demo_jira_access (user_id, enabled)
    values (new.id, coalesce((new.raw_user_meta_data ->> 'demo_jira_access') = 'true', false))
    on conflict (user_id) do nothing;
  end if;

  v_dept_input := btrim(coalesce(new.raw_user_meta_data ->> 'demo_department', ''));
  if v_dept_input <> '' and new.email_confirmed_at is not null then
    select d.id into v_dept_id
    from public.departments d
    where d.organization_id = v_org_id
      and d.name in (
        'Engineering', 'HR', 'Product Management', 'Project Management',
        'UI/UX', 'Operations', 'Marketing', 'Finance'
      )
      and (d.name = v_dept_input or d.id::text = v_dept_input)
    order by d.id
    limit 1;

    if v_dept_id is not null then
      insert into public.organization_employees (organization_id, user_id, department_id, role, is_active)
      values (v_org_id, new.id, v_dept_id, 'employee', true)
      on conflict on constraint organization_employees_pkey do nothing;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.handle_demo_jira_signup() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_demo_jira on auth.users;
create trigger on_auth_user_created_demo_jira
  after insert or update of email_confirmed_at on auth.users
  for each row
  execute function public.handle_demo_jira_signup();

commit;

