begin;
set local lock_timeout = '5s';

alter table public.documents
  add column access_scope text not null default 'department',
  add constraint documents_access_scope_check check (
    access_scope = 'department' or (access_scope = 'company' and classification = 'standard')
  );

-- Personal CRUD remains available. REFERENCES and other non-CRUD privileges bypass row policies.
revoke truncate, references, trigger, maintain on public.projects from public, anon, authenticated;

create schema wp2b_private;
revoke all on schema wp2b_private from public, anon, authenticated, service_role;
grant usage on schema wp2b_private to authenticated;

-- Existing owner RLS still governs the raw tables, including source metadata and history.
create function wp2b_private.read_enterprise_document(p_document_id uuid)
returns table (chunk_id uuid, content text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select c.id, c.content
  from public.documents d
  join public.projects p on p.id = d.project_id
  join public.organization_employees e on e.organization_id = p.organization_id
    and e.user_id = (select auth.uid()) and e.is_active
  join public.document_chunks c on c.document_id = d.id and c.project_id = p.id
  left join public.document_grants g on g.document_id = d.id and g.user_id = e.user_id
    and g.approved_by is not null
    and public.enterprise_access_window_is_current(g.valid_from, g.expires_at, g.revoked_at)
  left join public.project_memberships m on m.project_id = p.id and m.user_id = e.user_id
    and public.enterprise_access_window_is_current(m.valid_from, m.expires_at, m.revoked_at)
  where d.id = p_document_id and d.status = 'indexed' and d.is_published
    and case
      when p.is_d12 then m.user_id is not null and g.user_id is not null
      when d.classification = 'restricted' then g.user_id is not null
      when d.classification = 'standard' then
        d.access_scope = 'company' or e.department_id = p.department_id or g.user_id is not null
      else false
    end
$$;

-- Lock the owning department and approver facts until the authorized write commits.
create function wp2b_private.lock_grant_scope(p_document_id uuid, p_recipient_id uuid)
returns table (project_id uuid, organization_id uuid, department_id uuid, is_d12 boolean, classification text)
language sql volatile security invoker set search_path = pg_catalog, pg_temp as $$
  select p.id, p.organization_id, p.department_id, p.is_d12, d.classification
  from public.documents d
  join public.projects p on p.id = d.project_id
  join public.organization_employees approver on approver.organization_id = p.organization_id
    and approver.department_id = p.department_id and approver.user_id = (select auth.uid())
    and approver.is_active and approver.role in ('manager', 'cxo')
  where d.id = p_document_id and p_recipient_id <> approver.user_id
  for share of p, d, approver
$$;

create function wp2b_private.issue_document_grant(p_document_id uuid, p_recipient_id uuid, p_expires_at timestamptz)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  scope record;
  recipient_department uuid;
  issued_at timestamptz;
begin
  select * into scope from wp2b_private.lock_grant_scope(p_document_id, p_recipient_id);
  if not found then
    raise exception 'Grant issuance denied' using errcode = '42501';
  end if;

  select e.department_id into recipient_department
  from public.organization_employees e
  where e.organization_id = scope.organization_id and e.user_id = p_recipient_id and e.is_active
  for share;
  if not found then
    raise exception 'Grant issuance denied' using errcode = '42501';
  end if;

  issued_at := statement_timestamp();
  if p_expires_at is null or not isfinite(p_expires_at) or p_expires_at <= issued_at then
    raise exception 'A finite future grant expiry is required' using errcode = '22023';
  end if;

  insert into public.document_grants as existing_grant
    (document_id, project_id, organization_id, project_department_id, is_d12, classification,
     user_id, recipient_department_id, approved_by, valid_from, expires_at)
  values
    (p_document_id, scope.project_id, scope.organization_id, scope.department_id, scope.is_d12, scope.classification,
     p_recipient_id, recipient_department, (select auth.uid()), issued_at, p_expires_at)
  on conflict (document_id, user_id) do update
    set approved_by = excluded.approved_by, valid_from = excluded.valid_from,
        expires_at = excluded.expires_at, revoked_at = null
    where existing_grant.revoked_at is not null or existing_grant.expires_at <= issued_at;
  if not found then
    raise exception 'Revoke the existing grant before issuing a replacement' using errcode = '55000';
  end if;
end
$$;

create function wp2b_private.revoke_document_grant(p_document_id uuid, p_recipient_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform 1 from wp2b_private.lock_grant_scope(p_document_id, p_recipient_id);
  if not found then
    raise exception 'Grant revocation denied' using errcode = '42501';
  end if;

  update public.document_grants
    set revoked_at = clock_timestamp()
    where document_id = p_document_id and user_id = p_recipient_id and revoked_at is null;
end
$$;

-- The scope check and issuance take conflicting locks on the same document row.
create function wp2b_private.guard_document_scope()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  -- A fresh snapshot is needed after waiting for concurrent grant issuance.
  if current_setting('transaction_isolation') not in ('read committed', 'read uncommitted') then
    raise exception 'Change document scope in a read committed transaction' using errcode = '25001';
  end if;
  -- Also serialize against the foreign key check on a direct privileged grant insert.
  perform 1 from public.documents where id = old.id for update;
  if exists (
    select 1 from public.document_grants g
    where g.document_id = old.id and g.revoked_at is null and g.expires_at > clock_timestamp()
  ) then
    raise exception 'Revoke unexpired grants before changing document scope' using errcode = '55000';
  end if;
  return new;
end
$$;

create trigger guard_document_scope before update of access_scope on public.documents
  for each row when (old.access_scope is distinct from new.access_scope)
  execute function wp2b_private.guard_document_scope();

-- Invoker entry points expose only these operations through the public API schema.
create function public.read_enterprise_document(p_document_id uuid)
returns table (chunk_id uuid, content text)
language sql stable security invoker set search_path = pg_catalog, pg_temp as $$
  select * from wp2b_private.read_enterprise_document(p_document_id)
$$;

create function public.issue_document_grant(p_document_id uuid, p_recipient_id uuid, p_expires_at timestamptz)
returns void language sql security invoker set search_path = pg_catalog, pg_temp as $$
  select wp2b_private.issue_document_grant(p_document_id, p_recipient_id, p_expires_at)
$$;

create function public.revoke_document_grant(p_document_id uuid, p_recipient_id uuid)
returns void language sql security invoker set search_path = pg_catalog, pg_temp as $$
  select wp2b_private.revoke_document_grant(p_document_id, p_recipient_id)
$$;

revoke all on all functions in schema wp2b_private from public, anon, authenticated, service_role;
revoke all on function public.read_enterprise_document(uuid),
  public.issue_document_grant(uuid, uuid, timestamptz), public.revoke_document_grant(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function wp2b_private.read_enterprise_document(uuid),
  wp2b_private.issue_document_grant(uuid, uuid, timestamptz), wp2b_private.revoke_document_grant(uuid, uuid),
  public.read_enterprise_document(uuid), public.issue_document_grant(uuid, uuid, timestamptz),
  public.revoke_document_grant(uuid, uuid) to authenticated;

commit;
