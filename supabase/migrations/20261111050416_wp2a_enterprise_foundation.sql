-- WP2A: apply after the existing hardening schema is verified. Hosted and
-- local migration versions differ; this file does not reconcile their ledgers.
begin;
set local lock_timeout = '5s';
set local search_path = pg_catalog;

do $$
begin
  if (select count(*) from pg_class where oid in (
        'public.projects'::regclass, 'public.documents'::regclass,
        'public.document_chunks'::regclass, 'public.interactions'::regclass
      ) and relrowsecurity) <> 4
    or (select count(*) from pg_policies where schemaname = 'public'
        and tablename in ('projects', 'documents', 'document_chunks', 'interactions')
        and policyname = 'owner_boundary' and permissive = 'RESTRICTIVE'
        and cmd = 'ALL' and roles = array['public']::name[]
        and qual like '%auth.uid()%' and with_check like '%auth.uid()%') <> 4 then
    raise exception 'Unexpected owner RLS baseline; review before applying WP2A';
  end if;

  if (select count(*) from pg_constraint where contype = 'f'
        and conrelid = 'public.interactions'::regclass
        and confrelid = 'auth.users'::regclass) <> 1
    or not exists (
      select 1 from pg_constraint c
      where c.conrelid = 'public.interactions'::regclass and c.contype = 'f'
        and c.conname = 'interactions_user_id_fkey' and c.confdeltype = 'c'
        and c.confrelid = 'auth.users'::regclass and c.convalidated
        and c.conkey = array[(select attnum from pg_attribute
          where attrelid = c.conrelid and attname = 'user_id' and not attisdropped)]
        and c.confkey = array[(select attnum from pg_attribute
          where attrelid = c.confrelid and attname = 'id' and not attisdropped)]
    ) then
    raise exception 'Unexpected interaction author foreign key; review before applying WP2A';
  end if;
end $$;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table public.departments (
  organization_id uuid not null references public.organizations(id),
  id uuid not null default gen_random_uuid(),
  name text not null,
  primary key (organization_id, id)
);

create table public.organization_employees (
  organization_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  department_id uuid not null,
  role text not null check (role in ('employee', 'manager', 'cxo')),
  is_active boolean not null default false,
  primary key (organization_id, user_id),
  unique (organization_id, user_id, department_id),
  foreign key (organization_id, department_id) references public.departments(organization_id, id)
);

-- Personal projects keep their original owner FK and RLS. Organization projects
-- have no employee owner, and require an explicit D12 classification.
alter table public.projects
  add column organization_id uuid,
  add column department_id uuid,
  add column is_d12 boolean,
  alter column user_id drop not null,
  add constraint projects_ownership_scope check (
    (user_id is not null and organization_id is null and department_id is null and is_d12 is null)
    or (user_id is null and organization_id is not null and department_id is not null and is_d12 is not null)
  ),
  add constraint projects_department_fkey foreign key (organization_id, department_id)
    references public.departments(organization_id, id),
  add constraint projects_enterprise_scope_key unique (id, organization_id, department_id, is_d12);

-- Preserve interaction content and feedback when an author account is removed.
-- The existing project deletion paths still remove a deleted project's history.
alter table public.interactions
  alter column user_id drop not null,
  drop constraint interactions_user_id_fkey,
  add constraint interactions_user_id_fkey foreign key (user_id)
    references auth.users(id) on delete set null;

alter table public.documents
  add column is_published boolean not null default false,
  add column classification text not null default 'restricted'
    check (classification in ('standard', 'restricted')),
  add constraint documents_enterprise_scope_key unique (id, project_id, classification);

-- The composite keys bind all inputs to the duration rules. Reclassifying a
-- referenced project, document or employee department requires explicit handling
-- of dependent authority records instead of silently widening their scope.
create table public.project_memberships (
  project_id uuid not null,
  organization_id uuid not null,
  project_department_id uuid not null,
  is_d12 boolean not null,
  user_id uuid not null,
  valid_from timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  primary key (project_id, user_id),
  foreign key (project_id, organization_id, project_department_id, is_d12)
    references public.projects(id, organization_id, department_id, is_d12) on delete cascade,
  foreign key (organization_id, user_id)
    references public.organization_employees(organization_id, user_id) on delete cascade,
  constraint project_memberships_valid_window check (
    isfinite(valid_from) and isfinite(expires_at) and valid_from < expires_at
    and (revoked_at is null or isfinite(revoked_at))
  ),
  constraint project_memberships_d12_duration check (
    not is_d12 or expires_at - valid_from <= interval '2160 hours'
  )
);

create table public.document_grants (
  document_id uuid not null,
  project_id uuid not null,
  organization_id uuid not null,
  project_department_id uuid not null,
  is_d12 boolean not null,
  classification text not null,
  user_id uuid not null,
  recipient_department_id uuid not null,
  approved_by uuid references auth.users(id) on delete set null,
  valid_from timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  primary key (document_id, user_id),
  foreign key (document_id, project_id, classification)
    references public.documents(id, project_id, classification) on delete cascade,
  foreign key (project_id, organization_id, project_department_id, is_d12)
    references public.projects(id, organization_id, department_id, is_d12) on delete cascade,
  foreign key (organization_id, user_id, recipient_department_id)
    references public.organization_employees(organization_id, user_id, department_id) on delete cascade,
  constraint document_grants_no_self_approval check (approved_by is distinct from user_id),
  constraint document_grants_valid_window check (
    isfinite(valid_from) and isfinite(expires_at) and valid_from < expires_at
    and (revoked_at is null or isfinite(revoked_at))
  ),
  constraint document_grants_restricted_duration check (
    classification <> 'restricted' or expires_at - valid_from <= interval '720 hours'
  ),
  constraint document_grants_standard_cross_department_duration check (
    classification <> 'standard' or recipient_department_id = project_department_id
    or expires_at - valid_from <= interval '2160 hours'
  ),
  constraint document_grants_d12_duration check (
    not is_d12 or expires_at - valid_from <= interval '2160 hours'
  )
);

-- This predicate evaluates time only. Approval, employee status, membership
-- requirements and publication must also be checked by the future access path.
create function public.enterprise_access_window_is_current(
  valid_from timestamptz, expires_at timestamptz, revoked_at timestamptz
) returns boolean
language sql stable security invoker set search_path = pg_catalog as $$
  select revoked_at is null
    and coalesce(statement_timestamp() >= valid_from and statement_timestamp() < expires_at, false)
$$;

-- No allow policies or API grants until the approver and access rules are defined.
alter table public.organizations enable row level security;
alter table public.departments enable row level security;
alter table public.organization_employees enable row level security;
alter table public.project_memberships enable row level security;
alter table public.document_grants enable row level security;
revoke all on public.organizations, public.departments, public.organization_employees,
  public.project_memberships, public.document_grants from public, anon, authenticated, service_role;
revoke all on function public.enterprise_access_window_is_current(timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

commit;
