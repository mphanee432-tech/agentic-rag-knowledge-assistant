begin;
set local lock_timeout = '5s';

-- Close self-service enterprise onboarding for ordinary authenticated users.
revoke all on function wp3_private.onboard_demo_employee(text),
  public.onboard_demo_employee(text)
  from public, anon, authenticated;

-- Read-only caller-scoped account status RPC for exact role, organization, and active state.
create function wp3_private.enterprise_account_status()
returns table (
  organization_id uuid,
  organization_name text,
  role text,
  is_active boolean
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select e.organization_id, o.name, e.role, e.is_active
  from public.organization_employees e
  join public.organizations o on o.id = e.organization_id
  where e.user_id = (select auth.uid())
  order by e.is_active desc, e.organization_id
  limit 1;
$$;

create function public.enterprise_account_status()
returns table (
  organization_id uuid,
  organization_name text,
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

commit;

