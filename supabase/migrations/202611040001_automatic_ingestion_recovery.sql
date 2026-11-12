-- Requires the hardening migration, Supabase Cron, pg_net and Vault.
begin;

alter table public.documents
  add column ingestion_attempts integer not null default 0 check (ingestion_attempts >= 0),
  add column next_ingestion_attempt_at timestamptz default now(),
  add column ingestion_dispatched_at timestamptz,
  add column last_ingestion_error text;

-- Existing terminal failures need a new upload; never silently restart them.
update public.documents set next_ingestion_attempt_at = null
where status in ('indexed', 'failed');

create index documents_ingestion_recovery on public.documents(next_ingestion_attempt_at, lease_expires_at)
  where status in ('pending_upload', 'uploaded', 'processing');

create or replace function public.claim_document_ingestion(p_document_id uuid, p_lease uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare claimed_id uuid;
begin
  if p_lease is null then return false; end if;
  update public.documents d set status = 'processing', ingestion_lease = p_lease,
    lease_expires_at = now() + interval '6 minutes', ingestion_attempts = ingestion_attempts + 1,
    next_ingestion_attempt_at = null, ingestion_dispatched_at = null
  where d.id = p_document_id and ingestion_attempts < 3
    and exists (select 1 from storage.objects o where o.bucket_id = 'documents' and o.name = d.storage_path)
    and ((status in ('pending_upload', 'uploaded') and next_ingestion_attempt_at <= now())
      or (status = 'processing' and coalesce(lease_expires_at, '-infinity'::timestamptz) < now()))
  returning d.id into claimed_id;
  return claimed_id is not null;
end $$;

create or replace function public.fail_document_ingestion(
  p_document_id uuid, p_lease uuid, p_error text, p_retryable boolean
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.documents set
    status = case when p_retryable and ingestion_attempts < 3 then 'uploaded' else 'failed' end,
    next_ingestion_attempt_at = case when p_retryable and ingestion_attempts < 3
      then now() + case when ingestion_attempts = 1 then interval '1 minute' else interval '5 minutes' end
      else null end,
    last_ingestion_error = left(coalesce(p_error, 'Ingestion failed.'), 500),
    ingestion_lease = null, lease_expires_at = null, ingestion_dispatched_at = null
  where id = p_document_id and status = 'processing' and ingestion_lease = p_lease
    and lease_expires_at > now();
end $$;

create or replace function public.finish_document_ingestion(p_document_id uuid, p_lease uuid, p_chunks jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare doc public.documents%rowtype;
begin
  select * into doc from public.documents where id = p_document_id for update;
  if not found or doc.ingestion_lease is distinct from p_lease or doc.status <> 'processing'
    or doc.lease_expires_at is null or doc.lease_expires_at <= now() then
    raise exception 'Ingestion lease lost';
  end if;
  if jsonb_typeof(p_chunks) is distinct from 'array' or jsonb_array_length(p_chunks) = 0 then
    raise exception 'No chunks supplied';
  end if;
  delete from public.document_chunks where document_id = doc.id;
  insert into public.document_chunks(document_id, project_id, content, metadata, embedding)
    select doc.id, doc.project_id, c->>'content', c->'metadata', (c->>'embedding')::vector(1536)
    from jsonb_array_elements(p_chunks) c;
  update public.documents set status = 'indexed', ingestion_lease = null, lease_expires_at = null,
    next_ingestion_attempt_at = null, ingestion_dispatched_at = null, last_ingestion_error = null
  where id = doc.id;
end $$;

create or replace function public.recover_document_ingestion()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  doc public.documents%rowtype;
  webhook_url text;
  webhook_secret text;
  dispatched integer := 0;
  failed integer := 0;
begin
  -- Cron and manual runs share the same dispatcher lock; workers still use row leases.
  if not pg_try_advisory_xact_lock(hashtext('recover_document_ingestion')) then
    return jsonb_build_object('dispatched', 0, 'failed', 0);
  end if;
  select decrypted_secret into webhook_url from vault.decrypted_secrets where name = 'ingestion_webhook_url';
  select decrypted_secret into webhook_secret from vault.decrypted_secrets where name = 'ingestion_webhook_secret';
  if webhook_url is null or webhook_url !~ '^https://[^/]+/api/webhooks/storage$'
    or coalesce(webhook_secret, '') = '' then
    raise exception 'Configure ingestion_webhook_url and ingestion_webhook_secret in Supabase Vault';
  end if;

  for doc in
    select d.* from public.documents d
    where (
      (d.status = 'processing' and coalesce(d.lease_expires_at, '-infinity'::timestamptz) < now())
      or (d.status in ('pending_upload', 'uploaded') and (
        (d.next_ingestion_attempt_at <= now() and exists (
          select 1 from storage.objects o where o.bucket_id = 'documents' and o.name = d.storage_path))
        or (d.created_at < now() - interval '2 hours 15 minutes' and not exists (
          select 1 from storage.objects o where o.bucket_id = 'documents' and o.name = d.storage_path))
      ))
    ) and (d.ingestion_dispatched_at is null or d.ingestion_dispatched_at < now() - interval '6 minutes'
      or d.ingestion_attempts >= 3)
    order by coalesce(d.next_ingestion_attempt_at, d.lease_expires_at, d.created_at), d.id
    limit 25 for update skip locked
  loop
    if doc.ingestion_attempts >= 3 or not exists (
      select 1 from storage.objects o where o.bucket_id = 'documents' and o.name = doc.storage_path
    ) then
      update public.documents set status = 'failed', ingestion_lease = null, lease_expires_at = null,
        next_ingestion_attempt_at = null, ingestion_dispatched_at = null,
        last_ingestion_error = case when doc.ingestion_attempts >= 3 then 'Ingestion retry limit reached.'
          else 'Upload expired or source file is missing. Please upload again.' end
      where id = doc.id;
      failed := failed + 1;
    elsif dispatched < 5 then
      -- pg_net sends after commit. If delivery is lost, the dispatch cooldown expires.
      perform net.http_post(
        url := webhook_url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', webhook_secret),
        body := jsonb_build_object('storagePath', doc.storage_path),
        timeout_milliseconds := 300000
      );
      update public.documents set ingestion_dispatched_at = now() where id = doc.id;
      dispatched := dispatched + 1;
    end if;
  end loop;
  return jsonb_build_object('dispatched', dispatched, 'failed', failed);
end $$;

revoke all on function public.claim_document_ingestion(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_document_ingestion(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.finish_document_ingestion(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.recover_document_ingestion() from public, anon, authenticated;
grant execute on function public.claim_document_ingestion(uuid, uuid) to service_role;
grant execute on function public.fail_document_ingestion(uuid, uuid, text, boolean) to service_role;
grant execute on function public.finish_document_ingestion(uuid, uuid, jsonb) to service_role;
grant execute on function public.recover_document_ingestion() to service_role;

select cron.schedule('recover-document-ingestion', '* * * * *', 'select public.recover_document_ingestion();');
commit;
