-- Both initial delivery and Cron recovery resolve the same live Vault bindings.
begin;
create or replace function public.dispatch_document_ingestion()
returns trigger language plpgsql security definer set search_path = public as $$
declare webhook_url text; webhook_secret text;
begin
  if new.bucket_id <> 'documents' then return new; end if;
  select decrypted_secret into webhook_url from vault.decrypted_secrets where name = 'ingestion_webhook_url';
  select decrypted_secret into webhook_secret from vault.decrypted_secrets where name = 'ingestion_webhook_secret';
  if webhook_url is null or webhook_url !~ '^https://[^/]+/api/webhooks/storage$'
    or coalesce(webhook_secret, '') = '' then
    raise warning 'Ingestion webhook Vault bindings are missing; recovery will retain the reservation';
    return new;
  end if;
  perform net.http_post(
    url := webhook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', webhook_secret),
    body := jsonb_build_object('type', 'INSERT', 'table', 'objects', 'schema', 'storage',
                             'record', jsonb_build_object('bucket_id', new.bucket_id, 'name', new.name)),
    timeout_milliseconds := 300000
  );
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
commit;
