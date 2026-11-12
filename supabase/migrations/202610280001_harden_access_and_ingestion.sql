-- Apply to the existing application's Supabase database before deploying these routes.
-- Existing table/RPC definitions are prerequisites; this migration is intentionally not a fresh-database bootstrap.
begin;
set local search_path = public, extensions;
alter table public.interactions add column if not exists feedback jsonb;
do $$
begin
  if (select count(*) from information_schema.columns where table_schema = 'public'
      and table_name = 'interactions' and column_name in ('rating', 'issue_tag', 'user_comment')) = 3 then
    execute 'update public.interactions set feedback = jsonb_build_object(
      ''rating'', rating, ''issue_tag'', issue_tag, ''comment'', user_comment)
      where feedback is null and (rating is not null or issue_tag is not null or user_comment is not null)';
  end if;
end $$;
alter table public.documents add column if not exists expected_size bigint;
alter table public.documents add column if not exists ingestion_lease uuid;
alter table public.documents add column if not exists lease_expires_at timestamptz;
create unique index if not exists documents_storage_path_unique on public.documents(storage_path);

-- Restrictive policies AND with any legacy permissive policies, closing demo/public access.
alter table public.projects enable row level security;
alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.interactions enable row level security;
create policy owner_boundary on public.projects as restrictive for all to public
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy owner_access on public.projects for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

do $$
declare t text;
begin
  foreach t in array array['documents', 'document_chunks', 'interactions'] loop
    execute format('create policy owner_boundary on public.%I as restrictive for all to public
      using (exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()))
      with check (exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()))', t);
    execute format('create policy owner_read on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;
create policy owner_document_delete on public.documents for delete to authenticated using (true);
create policy owner_feedback_update on public.interactions for update to authenticated using (true) with check (true);
-- Clients cannot forge chunks, reservations or telemetry, even if a legacy policy permits it.
revoke all on public.documents, public.document_chunks, public.interactions from anon, authenticated;
grant select, delete on public.documents to authenticated;
grant select on public.document_chunks, public.interactions to authenticated;
grant update(feedback) on public.interactions to authenticated;
revoke all on public.projects from anon;
grant select, insert, update, delete on public.projects to authenticated;

-- Browser writes must use server-issued signed URLs; reads are scoped by the owner path.
create policy document_storage_owner on storage.objects as restrictive for select to public
  using (bucket_id <> 'documents' or (storage.foldername(name))[1] = auth.uid()::text);
create policy document_storage_no_direct_insert on storage.objects as restrictive for insert to public
  with check (bucket_id <> 'documents');
create policy document_storage_no_direct_update on storage.objects as restrictive for update to public
  using (bucket_id <> 'documents') with check (bucket_id <> 'documents');
create policy document_storage_no_direct_delete on storage.objects as restrictive for delete to public
  using (bucket_id <> 'documents');
update storage.buckets set public = false, file_size_limit = 26214400,
  allowed_mime_types = array['application/pdf', 'text/plain', 'text/html', 'application/octet-stream']
  where id = 'documents';

-- Serialize reservations and failed->processing retries on the project row.
create or replace function public.enforce_document_quota() returns trigger
language plpgsql set search_path = public as $$
begin
  perform 1 from public.projects where id = new.project_id for update;
  if new.status <> 'failed' and
    (select count(*) from public.documents where project_id = new.project_id and status <> 'failed' and id <> new.id) >= 10
  then raise exception 'Project document limit reached'; end if;
  return new;
end $$;
create trigger enforce_document_quota before insert or update of status, project_id on public.documents
  for each row execute function public.enforce_document_quota();

create or replace function public.claim_document_ingestion(p_document_id uuid, p_lease uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare claimed_id uuid;
begin
  update public.documents set status = 'processing', ingestion_lease = p_lease,
    lease_expires_at = now() + interval '6 minutes'
  where id = p_document_id and
    (status in ('pending_upload', 'uploaded', 'failed') or
     (status = 'processing' and coalesce(lease_expires_at, '-infinity'::timestamptz) < now()))
  returning id into claimed_id;
  return claimed_id is not null;
end $$;

create or replace function public.finish_document_ingestion(p_document_id uuid, p_lease uuid, p_chunks jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare doc public.documents%rowtype;
begin
  select * into doc from public.documents where id = p_document_id for update;
  if not found or doc.ingestion_lease is distinct from p_lease or doc.status <> 'processing'
    or doc.lease_expires_at < now() then raise exception 'Ingestion lease lost'; end if;
  if jsonb_typeof(p_chunks) <> 'array' or jsonb_array_length(p_chunks) = 0 then
    raise exception 'No chunks supplied';
  end if;
  delete from public.document_chunks where document_id = doc.id;
  insert into public.document_chunks(document_id, project_id, content, metadata, embedding)
    select doc.id, doc.project_id, c->>'content', c->'metadata', (c->>'embedding')::vector(1536)
    from jsonb_array_elements(p_chunks) c;
  update public.documents set status = 'indexed', ingestion_lease = null, lease_expires_at = null where id = doc.id;
end $$;

revoke all on function public.claim_document_ingestion(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_document_ingestion(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.claim_document_ingestion(uuid, uuid) to service_role;
grant execute on function public.finish_document_ingestion(uuid, uuid, jsonb) to service_role;

-- Legacy SECURITY DEFINER search functions must not remain a public bypass.
do $$
declare f record;
begin
  for f in select oid::regprocedure as signature from pg_proc
    where pronamespace = 'public'::regnamespace and proname = 'match_chunks_hybrid_rrf'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.signature);
    execute format('grant execute on function %s to service_role', f.signature);
  end loop;
end $$;

-- Explicit cleanup also covers legacy schemas whose foreign keys lack CASCADE.
create or replace function public.delete_document_children() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.document_chunks where document_id = old.id;
  return old;
end $$;
create trigger delete_document_children before delete on public.documents
  for each row execute function public.delete_document_children();
create or replace function public.delete_project_children() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.interactions where project_id = old.id;
  delete from public.document_chunks where project_id = old.id;
  delete from public.documents where project_id = old.id;
  return old;
end $$;
create trigger delete_project_children before delete on public.projects
  for each row execute function public.delete_project_children();
commit;

