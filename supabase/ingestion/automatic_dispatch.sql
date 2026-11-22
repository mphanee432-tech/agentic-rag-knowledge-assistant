-- Operational configuration, applied only by sync_ingestion.py --apply after approval.
-- Existing ingestion functions/extensions are prerequisites. No historical migrations are replayed.
-- The caller wraps this in the same transaction as the workspace-specific Vault bindings.
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
  if webhook_url is null or webhook_url !~ '^https://[^/]+/api/webhooks/storage[?]workspace=(personal|enterprise)$'
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

create or replace function public.dispatch_document_ingestion()
returns trigger language plpgsql security definer set search_path = public as $$
declare webhook_url text; webhook_secret text;
begin
  if new.bucket_id <> 'documents' then return new; end if;
  select decrypted_secret into webhook_url from vault.decrypted_secrets where name = 'ingestion_webhook_url';
  select decrypted_secret into webhook_secret from vault.decrypted_secrets where name = 'ingestion_webhook_secret';
  if webhook_url is null or webhook_url !~ '^https://[^/]+/api/webhooks/storage[?]workspace=(personal|enterprise)$'
    or coalesce(webhook_secret, '') = '' then
    raise warning 'Ingestion webhook Vault bindings are missing; recovery will retain the reservation';
    return new;
  end if;
  begin
    perform net.http_post(
      url := webhook_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', webhook_secret),
      body := jsonb_build_object('type', 'INSERT', 'table', 'objects', 'schema', 'storage',
                               'record', jsonb_build_object('bucket_id', new.bucket_id, 'name', new.name)),
      timeout_milliseconds := 300000
    );
  exception when others then
    raise warning 'Ingestion dispatch could not be queued; recovery will retain the reservation';
  end;
  return new;
end $$;
revoke all on function public.dispatch_document_ingestion() from public, anon, authenticated;
-- Replace this application's confirmed legacy webhook, preserving Storage's internal triggers.
drop trigger if exists rag_knowledge_assistant on storage.objects;
drop trigger if exists "storage.objects.insert" on storage.objects;
create trigger "storage.objects.insert" after insert on storage.objects
  for each row execute function public.dispatch_document_ingestion();

-- The client watches document transitions, with polling as a fallback.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') and not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'documents'
  ) then
    alter publication supabase_realtime add table public.documents;
  end if;
end $$;

revoke all on function public.recover_document_ingestion() from public, anon, authenticated;
grant execute on function public.recover_document_ingestion() to service_role;
select cron.schedule('recover-document-ingestion', '* * * * *', 'select public.recover_document_ingestion();');
select cron.alter_job((select jobid from cron.job where jobname='recover-document-ingestion'), active := true);
