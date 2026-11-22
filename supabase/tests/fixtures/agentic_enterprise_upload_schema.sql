-- Disposable-only representation of the Agentic Enterprise catalog inspected 2026-11-21.
-- Auth identity is supplied by test claims; no hosted users or corpus data is copied.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create schema extensions;
create extension vector with schema extensions;
create table auth.users(id uuid primary key, email text unique, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
$$;
grant usage on schema auth,extensions to authenticated,service_role;
create schema wp3_private;
revoke all on schema wp3_private from public;
grant usage on schema wp3_private to authenticated;

create table public.organizations(id uuid primary key default gen_random_uuid(),name text not null);
create table public.departments(
  organization_id uuid references public.organizations(id),id uuid default gen_random_uuid(),name text not null,
  primary key(organization_id,id)
);
create table public.organization_employees(
  organization_id uuid,user_id uuid references auth.users(id),department_id uuid,
  role text not null check(role in ('employee','manager','cxo')),is_active boolean not null default false,
  primary key(organization_id,user_id),unique(organization_id,user_id,department_id),
  foreign key(organization_id,department_id) references public.departments(organization_id,id)
);
create table public.projects(
  id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),name text not null default 'Untitled Project',
  organization_id uuid,department_id uuid,is_d12 boolean,
  foreign key(organization_id,department_id) references public.departments(organization_id,id),
  unique(id,organization_id,department_id,is_d12),
  check((user_id is not null and organization_id is null and department_id is null and is_d12 is null)
    or (user_id is null and organization_id is not null and department_id is not null and is_d12 is not null))
);
create table public.documents(
  id uuid primary key default gen_random_uuid(),project_id uuid not null references public.projects(id),
  storage_path text not null unique,status text not null check(status in ('pending_upload','uploaded','processing','indexed','failed')),
  created_at timestamptz default now(),expected_size bigint,ingestion_lease uuid,lease_expires_at timestamptz,
  ingestion_attempts integer not null default 0 check(ingestion_attempts>=0),next_ingestion_attempt_at timestamptz default now(),
  ingestion_dispatched_at timestamptz,last_ingestion_error text,is_published boolean not null default false,
  classification text not null default 'restricted' check(classification in ('standard','restricted')),
  access_scope text not null default 'department' check(access_scope='department' or (access_scope='company' and classification='standard')),
  unique(id,project_id,classification)
);
create table public.document_chunks(
  id uuid primary key default gen_random_uuid(),document_id uuid references public.documents(id),
  project_id uuid references public.projects(id),content text,metadata jsonb,embedding extensions.vector(1536)
);
create table public.document_grants(
  document_id uuid,project_id uuid,organization_id uuid,project_department_id uuid,is_d12 boolean,classification text,
  user_id uuid,recipient_department_id uuid,approved_by uuid references auth.users(id),
  valid_from timestamptz not null,expires_at timestamptz,revoked_at timestamptz,
  primary key(document_id,user_id),check(approved_by is distinct from user_id),
  foreign key(document_id,project_id,classification) references public.documents(id,project_id,classification),
  foreign key(project_id,organization_id,project_department_id,is_d12) references public.projects(id,organization_id,department_id,is_d12),
  foreign key(organization_id,user_id,recipient_department_id) references public.organization_employees(organization_id,user_id,department_id)
);
create table public.project_memberships(
  project_id uuid,organization_id uuid,project_department_id uuid,is_d12 boolean,user_id uuid,
  valid_from timestamptz not null,expires_at timestamptz,revoked_at timestamptz,
  primary key(project_id,user_id),
  foreign key(project_id,organization_id,project_department_id,is_d12) references public.projects(id,organization_id,department_id,is_d12),
  foreign key(organization_id,user_id) references public.organization_employees(organization_id,user_id)
);
create function public.enterprise_access_window_is_current(valid_from timestamptz,expires_at timestamptz,revoked_at timestamptz)
returns boolean language sql stable set search_path=pg_catalog as $$
  select valid_from is not null and valid_from<=now() and (expires_at is null or expires_at>now()) and revoked_at is null
$$;
create schema storage;
create table storage.objects(bucket_id text,name text);

alter table public.organizations enable row level security;
alter table public.departments enable row level security;
alter table public.organization_employees enable row level security;
alter table public.projects enable row level security;
alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.document_grants enable row level security;
alter table public.project_memberships enable row level security;
grant select on public.departments,public.organization_employees,public.projects,public.documents,
  public.document_chunks,public.document_grants,public.project_memberships to authenticated;
create policy enterprise_my_membership on public.organization_employees for select to authenticated
  using(user_id=(select auth.uid()));
create policy enterprise_departments_active on public.departments for select to authenticated using(exists(
  select from public.organization_employees e where e.organization_id=departments.organization_id and e.user_id=(select auth.uid()) and e.is_active));
create policy enterprise_projects_active on public.projects for select to authenticated using(organization_id is not null and exists(
  select from public.organization_employees e where e.organization_id=projects.organization_id and e.user_id=(select auth.uid()) and e.is_active));
create policy enterprise_grants_own on public.document_grants for select to authenticated using(user_id=(select auth.uid()) and exists(
  select from public.organization_employees e where e.organization_id=document_grants.organization_id and e.user_id=(select auth.uid()) and e.is_active));
create policy enterprise_project_memberships_own on public.project_memberships for select to authenticated using(user_id=(select auth.uid()));
create function public.enterprise_copilot_context(target_organization_id uuid default null)
returns table(organization_id uuid,can_upload_policy boolean) language sql stable security invoker set search_path=pg_catalog,pg_temp as $$
  select e.organization_id,false from public.organization_employees e where e.user_id=(select auth.uid()) and e.is_active
    and (target_organization_id is null or e.organization_id=target_organization_id) order by e.organization_id limit 1
$$;
revoke all on function public.enterprise_copilot_context(uuid) from public,anon;
grant execute on function public.enterprise_copilot_context(uuid) to authenticated,service_role;
