-- Run as postgres on an EMPTY, disposable Supabase database with the recovery migrations
-- and supabase/ingestion/automatic_dispatch.sql applied. Never use either Agentic project.
-- psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ingestion_recovery.sql
-- All fixtures and pg_net requests roll back; no webhook requests leave this transaction.
begin;
set local plpgsql.check_asserts = on;
do $$
declare
  owner_id uuid := gen_random_uuid();
  project_id uuid := gen_random_uuid();
  retry_doc uuid := gen_random_uuid();
  stale_doc uuid := gen_random_uuid();
  pending_doc uuid := gen_random_uuid();
  crashed_doc uuid := gen_random_uuid();
  exhausted_doc uuid := gen_random_uuid();
  abandoned_doc uuid := gen_random_uuid();
  fresh_doc uuid := gen_random_uuid();
  lease_a uuid := gen_random_uuid();
  lease_b uuid := gen_random_uuid();
  lease_c uuid := gen_random_uuid();
  secret_id uuid;
  result jsonb;
  chunks jsonb := jsonb_build_array(jsonb_build_object('content', 'Evidence', 'metadata', '{}'::jsonb,
    'embedding', to_jsonb(array_fill(0.1::real, array[1536]))));
begin
  if exists (select 1 from public.documents) then
    raise exception 'Refusing to run: use an empty disposable test database';
  end if;
  select id into secret_id from vault.decrypted_secrets where name = 'ingestion_webhook_url';
  if secret_id is null then
    perform vault.create_secret('https://ingestion-test.invalid/api/webhooks/storage?workspace=personal', 'ingestion_webhook_url');
  else
    perform vault.update_secret(secret_id, 'https://ingestion-test.invalid/api/webhooks/storage?workspace=personal');
  end if;
  select id into secret_id from vault.decrypted_secrets where name = 'ingestion_webhook_secret';
  if secret_id is null then
    perform vault.create_secret('test-only-secret', 'ingestion_webhook_secret');
  else
    perform vault.update_secret(secret_id, 'test-only-secret');
  end if;
  insert into auth.users(id, email) values(owner_id, 'ingestion-recovery-test@example.invalid');
  insert into public.projects(id, user_id, name) values(project_id, owner_id, 'Recovery test');
  insert into public.documents(id, project_id, storage_path, status, expected_size, created_at)
    select id, project_id, 'recovery-test/' || id || '.txt', 'pending_upload', 8, now()
    from unnest(array[retry_doc, stale_doc, pending_doc, crashed_doc, exhausted_doc, abandoned_doc, fresh_doc]) id;
  insert into storage.objects(bucket_id, name)
    select 'documents', storage_path from public.documents
    where id in (retry_doc, stale_doc, pending_doc, crashed_doc, exhausted_doc);

  assert (select count(*) = 5 from net.http_request_queue
    where url = 'https://ingestion-test.invalid/api/webhooks/storage?workspace=personal'
      and headers->>'x-webhook-secret' = 'test-only-secret'
      and convert_from(body, 'UTF8')::jsonb->>'type' = 'INSERT'),
    'Storage INSERT did not automatically queue authenticated workspace-specific delivery';

  assert public.claim_document_ingestion(retry_doc, lease_a), 'First claim failed';
  assert not public.claim_document_ingestion(retry_doc, lease_b), 'Duplicate delivery acquired a live lease';
  assert (select ingestion_attempts = 1 from public.documents where id = retry_doc), 'Duplicate counted as an attempt';
  perform public.fail_document_ingestion(retry_doc, lease_a, 'Temporary upstream error', true);
  assert (select status = 'uploaded' and next_ingestion_attempt_at = now() + interval '1 minute'
    from public.documents where id = retry_doc), 'First retry backoff missing';
  assert not public.claim_document_ingestion(retry_doc, lease_b), 'Replay bypassed backoff';
  update public.documents set next_ingestion_attempt_at = now() - interval '1 second' where id = retry_doc;
  assert public.claim_document_ingestion(retry_doc, lease_b), 'Second claim failed';
  perform public.fail_document_ingestion(retry_doc, lease_b, 'Temporary upstream error', true);
  assert (select next_ingestion_attempt_at = now() + interval '5 minutes'
    from public.documents where id = retry_doc), 'Second retry backoff missing';
  update public.documents set next_ingestion_attempt_at = now() - interval '1 second' where id = retry_doc;
  assert public.claim_document_ingestion(retry_doc, lease_c), 'Third claim failed';
  perform public.fail_document_ingestion(retry_doc, lease_c, 'Final upstream error', true);
  assert (select status = 'failed' and next_ingestion_attempt_at is null and ingestion_attempts = 3
    from public.documents where id = retry_doc), 'Retries did not stop after three attempts';
  assert not public.claim_document_ingestion(retry_doc, gen_random_uuid()), 'Terminal failure restarted';

  assert public.claim_document_ingestion(stale_doc, lease_a), 'Worker could not start';
  update public.documents set lease_expires_at = now() - interval '1 second' where id = stale_doc;
  assert public.claim_document_ingestion(stale_doc, lease_b), 'Expired lease was not reclaimed';
  perform public.fail_document_ingestion(stale_doc, lease_a, 'Stale failure', false);
  assert (select ingestion_lease = lease_b and status = 'processing'
    from public.documents where id = stale_doc), 'Stale failure clobbered the new lease';
  begin
    perform public.finish_document_ingestion(stale_doc, lease_a, chunks);
    raise exception 'Stale worker finalized content';
  exception when raise_exception then
    if sqlerrm <> 'Ingestion lease lost' then raise; end if;
  end;
  insert into public.document_chunks(document_id, project_id, content, metadata, embedding)
    values (stale_doc, project_id, 'Previous evidence', '{}'::jsonb,
      (chunks->0->>'embedding')::extensions.vector(1536));
  begin
    perform public.finish_document_ingestion(stale_doc, lease_b,
      chunks || jsonb_set(chunks, '{0,embedding}', '"invalid vector"'::jsonb));
    raise exception 'Finalization accepted an invalid embedding';
  exception when data_exception then
    null; -- The vector cast fails after the finalizer deletes the previous chunks.
  end;
  assert (select count(*) = 1 and min(content) = 'Previous evidence'
    from public.document_chunks where document_id = stale_doc), 'Failed replacement changed existing chunks';
  assert (select status = 'processing' and ingestion_lease = lease_b
    from public.documents where id = stale_doc), 'Failed replacement changed the document lease';
  perform public.finish_document_ingestion(stale_doc, lease_b, chunks);
  assert (select status = 'indexed' and last_ingestion_error is null
    from public.documents where id = stale_doc), 'Valid finalization failed';
  assert (select count(*) = 1 and min(content) = 'Evidence'
    from public.document_chunks where document_id = stale_doc), 'Retry did not replace the previous chunks';
  assert not public.claim_document_ingestion(stale_doc, gen_random_uuid()), 'Indexed document restarted';

  update public.documents set status = 'processing', ingestion_attempts = 1,
    ingestion_lease = lease_a, lease_expires_at = now() - interval '1 second', next_ingestion_attempt_at = null
    where id = crashed_doc;
  update public.documents set status = 'processing', ingestion_attempts = 3,
    ingestion_lease = lease_a, lease_expires_at = now() - interval '1 second', next_ingestion_attempt_at = null
    where id = exhausted_doc;
  update public.documents set created_at = now() - interval '3 hours' where id = abandoned_doc;
  result := public.recover_document_ingestion();
  assert result->>'dispatched' = '2', 'Lost webhook and expired worker were not dispatched';
  assert (select count(*) = 2 from net.http_request_queue
    where url = 'https://ingestion-test.invalid/api/webhooks/storage?workspace=personal'
      and convert_from(body, 'UTF8')::jsonb ? 'storagePath'),
    'Recovery did not reuse the scoped Vault endpoint';
  assert result->>'failed' = '2', 'Exhausted worker and abandoned upload were not finalized';
  assert (select status = 'failed' from public.documents where id = abandoned_doc), 'Abandoned upload still consumes quota';
  assert (select status = 'pending_upload' from public.documents where id = fresh_doc), 'Live upload reservation was expired';
  assert (select status = 'failed' from public.documents where id = exhausted_doc), 'Crashed final attempt was not terminal';
  assert (select ingestion_attempts = 0 from public.documents where id = pending_doc), 'Dispatch consumed an execution attempt';
  result := public.recover_document_ingestion();
  assert result->>'dispatched' = '0', 'Dispatch cooldown was bypassed';
  update public.documents set ingestion_dispatched_at = now() - interval '7 minutes'
    where id in (pending_doc, crashed_doc);
  result := public.recover_document_ingestion();
  assert result->>'dispatched' = '2', 'Lost HTTP deliveries did not recover';
  assert not public.claim_document_ingestion(fresh_doc, lease_a), 'Missing source consumed an attempt';
  assert public.claim_document_ingestion(pending_doc, lease_a), 'Dispatch cooldown incorrectly blocked a worker';
  perform public.fail_document_ingestion(pending_doc, lease_a, 'Invalid source document', false);
  assert (select status = 'failed' and ingestion_attempts = 1 and next_ingestion_attempt_at is null
    from public.documents where id = pending_doc), 'Permanent input error was retried';
  assert not public.claim_document_ingestion(pending_doc, lease_b), 'Permanent failure restarted';

  update public.documents set lease_expires_at = now() - interval '1 second'
    where id = crashed_doc;
  begin
    perform public.finish_document_ingestion(crashed_doc, lease_a, chunks);
    raise exception 'Expired worker finalized content';
  exception when raise_exception then
    if sqlerrm <> 'Ingestion lease lost' then raise; end if;
  end;

  assert not has_function_privilege('anon', 'public.recover_document_ingestion()', 'execute'), 'Anonymous recovery permitted';
  assert not has_function_privilege('authenticated', 'public.recover_document_ingestion()', 'execute'), 'User recovery permitted';
  assert not has_function_privilege('authenticated', 'public.fail_document_ingestion(uuid,uuid,text,boolean)', 'execute'), 'User failure mutation permitted';
  assert has_function_privilege('service_role', 'public.fail_document_ingestion(uuid,uuid,text,boolean)', 'execute'), 'Worker cannot record failures';
  raise notice 'Ingestion recovery assertions passed';
end $$;
rollback;
