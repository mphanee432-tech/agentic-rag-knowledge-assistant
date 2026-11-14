begin;
set local lock_timeout = '5s';

create function wp3_private.onboard_demo_employee(target_department text)
returns table (organization_id uuid, department_id uuid, role text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
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
  where o.name = 'DeccanBridge Software'
  order by o.id
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

  select e.organization_id, e.department_id, e.role, e.is_active
  into v_existing
  from public.organization_employees e
  where e.organization_id = v_org_id
    and e.user_id = v_user_id;

  if not found or not v_existing.is_active then
    raise exception 'Employee onboarding denied' using errcode = '42501';
  end if;

  if v_existing.department_id <> v_dept_id or v_existing.role <> 'employee' then
    raise exception 'Department assignment is one-time and cannot be changed' using errcode = '42501';
  end if;

  return query select v_existing.organization_id, v_existing.department_id, v_existing.role;
end
$$;

create function public.onboard_demo_employee(target_department text)
returns table (organization_id uuid, department_id uuid, role text)
language sql volatile security invoker set search_path = pg_catalog, pg_temp as $$
  select * from wp3_private.onboard_demo_employee(target_department)
$$;

revoke all on function wp3_private.onboard_demo_employee(text),
  public.onboard_demo_employee(text)
  from public, anon, authenticated, service_role;

grant execute on function wp3_private.onboard_demo_employee(text),
  public.onboard_demo_employee(text)
  to authenticated;

commit;

