-- Disposable database with the repository migrations applied. All HTTP requests roll back.
begin;
set local plpgsql.check_asserts = on;
select vault.create_secret('https://webhook-test.invalid/api/webhooks/storage', 'ingestion_webhook_url');
select vault.create_secret('test-only-secret', 'ingestion_webhook_secret');
do $$
declare request record; queued bigint;
begin
  select count(*) into queued from net.http_request_queue;
  insert into storage.objects(bucket_id, name) values ('documents', 'webhook-test/doc.txt');
  assert (select count(*) from net.http_request_queue) = queued + 1, 'Storage INSERT must dispatch exactly once';
  select * into request from net.http_request_queue order by id desc limit 1;
  assert request.url = 'https://webhook-test.invalid/api/webhooks/storage', 'Wrong Vault URL';
  assert request.headers->>'x-webhook-secret' = 'test-only-secret', 'Wrong Vault secret';
  assert request.timeout_milliseconds = 300000, 'Timeout mismatch';
  assert request.body->>'type' = 'INSERT' and request.body->'record'->>'name' = 'webhook-test/doc.txt', 'Payload mismatch';
  perform vault.update_secret((select id from vault.decrypted_secrets where name='ingestion_webhook_url'), 'https://new-tunnel.invalid/api/webhooks/storage');
  insert into storage.objects(bucket_id, name) values ('documents', 'webhook-test/second.txt');
  assert (select url from net.http_request_queue order by id desc limit 1) = 'https://new-tunnel.invalid/api/webhooks/storage', 'Trigger cached old URL';
  insert into storage.buckets(id) values ('unrelated-webhook-test');
  insert into storage.objects(bucket_id, name) values ('unrelated-webhook-test', 'test.txt');
  assert (select count(*) from net.http_request_queue) = queued + 2, 'Other buckets must not dispatch';
end $$;
rollback;
