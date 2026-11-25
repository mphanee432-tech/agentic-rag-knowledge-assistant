// Isolated SQL validation. Runtime packages live only in the ignored test cache.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { PGlite } from "../node_modules/.cache/ingestion-sql-runtime/node_modules/@electric-sql/pglite/dist/index.js"
import { vector } from "../node_modules/.cache/ingestion-sql-runtime/node_modules/@electric-sql/pglite-pgvector/dist/index.js"

const db = new PGlite({ extensions: { vector } })
try {
  // Only the extension services are adapters: no real scheduler or HTTP sender exists.
  await db.exec(`
    create schema extensions;
    create extension vector with schema extensions;
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean default false);
    insert into storage.buckets(id,name) values ('documents','documents');
    create table storage.objects(id uuid default gen_random_uuid(), bucket_id text references storage.buckets(id), name text);
    create table public.projects(id uuid primary key, user_id uuid references auth.users(id), name text);
    create table public.documents(
      id uuid primary key, project_id uuid references public.projects(id), storage_path text unique,
      status text, expected_size bigint, created_at timestamptz default now(),
      ingestion_lease uuid, lease_expires_at timestamptz
    );
    create table public.document_chunks(
      id uuid default gen_random_uuid(), document_id uuid references public.documents(id),
      project_id uuid references public.projects(id), content text, metadata jsonb,
      embedding extensions.vector(1536)
    );
    create schema vault;
    create table vault.secrets(id uuid primary key default gen_random_uuid(), name text unique, secret text);
    create view vault.decrypted_secrets as select id,name,secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(value text, secret_name text) returns uuid language sql as $$
      insert into vault.secrets(name,secret) values(secret_name,value) returning id
    $$;
    create function vault.update_secret(secret_id uuid, value text) returns void language sql as $$
      update vault.secrets set secret=value where id=secret_id
    $$;
    create schema cron;
    create table cron.job(jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
    create function cron.schedule(name text, expression text, sql text) returns bigint language sql as $$
      insert into cron.job(jobname,schedule,command) values(name,expression,sql)
      on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid
    $$;
    create function cron.alter_job(jobid bigint, active boolean) returns void language sql as $$
      update cron.job set active=$2 where jobid=$1
    $$;
    create schema net;
    create table net.http_request_queue(id bigserial, url text, headers jsonb, body bytea, timeout_milliseconds int);
    create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
      headers jsonb default '{}', timeout_milliseconds int default 2000)
    returns bigint language plpgsql as $$
    declare request_id bigint;
    begin
      if current_setting('test.net_queue_failure',true) = 'on' then raise exception 'Test queue unavailable'; end if;
      insert into net.http_request_queue(url,headers,body,timeout_milliseconds)
        values(url,headers,convert_to(body::text,'UTF8'),timeout_milliseconds) returning id into request_id;
      return request_id;
    end $$;
    create publication supabase_realtime;
  `)
  await db.exec(await readFile("supabase/migrations/202611040001_automatic_ingestion_recovery.sql", "utf8"))
  const configuration = await readFile("supabase/ingestion/automatic_dispatch.sql", "utf8")
  await db.exec(configuration)
  await db.exec(configuration)
  const { rows: [state] } = await db.query(`select
    (select count(*)::int from cron.job where jobname='recover-document-ingestion' and active) as jobs,
    (select count(*)::int from pg_trigger where tgrelid='storage.objects'::regclass and tgname='storage.objects.insert') as triggers,
    exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='documents') as realtime`)
  assert.deepEqual(state, { jobs: 1, triggers: 1, realtime: true })
  console.log("PASS: repeatable configuration keeps one trigger/job and enables document Realtime")

  await db.exec(await readFile("supabase/tests/ingestion_recovery.sql", "utf8"))
  console.log("PASS: automatic dispatch, duplicate claims, retries, expired/stale leases, real-vector atomic persistence and lost delivery SQL assertions")

  for (const workspace of ["personal", "enterprise"]) {
    await db.exec(`begin;
      select vault.create_secret('https://test.invalid/api/webhooks/storage?workspace=${workspace}', 'ingestion_webhook_url');
      select vault.create_secret('test-secret', 'ingestion_webhook_secret');
      do $$
      declare
        owner_id uuid := gen_random_uuid();
        project_id uuid := gen_random_uuid();
        doc_id uuid := gen_random_uuid();
        object_path text := '${workspace === "enterprise" ? "enterprise/" : "user/"}' || gen_random_uuid() || '/source.txt';
        result jsonb;
      begin
        insert into auth.users(id) values(owner_id);
        insert into public.projects(id,user_id) values(project_id,owner_id);
        insert into public.documents(id,project_id,storage_path,status,expected_size)
          values(doc_id,project_id,object_path,'pending_upload',8);
        perform set_config('test.net_queue_failure','on',true);
        insert into storage.objects(bucket_id,name) values('documents',object_path);
        assert exists(select 1 from storage.objects where name=object_path), 'Queue error rolled back upload';
        assert (select ingestion_attempts=0 from public.documents where id=doc_id), 'Delivery failure consumed an attempt';
        assert not exists(select 1 from net.http_request_queue), 'Failed queue unexpectedly sent a request';
        perform set_config('test.net_queue_failure','off',true);
        result := public.recover_document_ingestion();
        assert result->>'dispatched'='1', 'Recovery did not pick up failed initial dispatch';
        assert (select count(*)=1 and bool_and(url='https://test.invalid/api/webhooks/storage?workspace=${workspace}')
          and bool_and(headers->>'x-webhook-secret'='test-secret') and bool_and(timeout_milliseconds=300000)
          from net.http_request_queue), 'Recovery lost workspace, secret or timeout';
        result := public.recover_document_ingestion();
        assert result->>'dispatched'='0', 'Failed delivery bypassed cooldown';
        update public.documents set ingestion_dispatched_at=now()-interval '7 minutes' where id=doc_id;
        result := public.recover_document_ingestion();
        assert result->>'dispatched'='1', 'Lost HTTP delivery was not redispatched';
        assert (select ingestion_attempts=0 from public.documents where id=doc_id), 'Redispatch consumed a claim';
      end $$;
      rollback;`)
    console.log(`PASS: ${workspace} queue failure preserves upload; scoped recovery and lost delivery respect cooldown without consuming attempts`)
  }
} finally {
  await db.close()
}
