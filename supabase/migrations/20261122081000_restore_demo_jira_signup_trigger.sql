-- Restore WP9.15 demo Jira signup trigger provisioning on auth.users.
-- Restores public.handle_demo_jira_signup() and trigger on_auth_user_created_demo_jira
-- without altering existing RLS policies, table grants, authentication logic, or Jira gates.

begin;
set local lock_timeout = '5s';

create or replace function public.handle_demo_jira_signup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
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

revoke all on function public.handle_demo_jira_signup() from public, anon, authenticated, service_role;

drop trigger if exists on_auth_user_created_demo_jira on auth.users;
create trigger on_auth_user_created_demo_jira
  after insert or update of email_confirmed_at on auth.users
  for each row
  execute function public.handle_demo_jira_signup();

commit;
