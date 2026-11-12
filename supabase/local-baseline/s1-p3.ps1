param([Parameter(Mandatory)][ValidateSet('Preflight','Restoration','Apply','Test','Verify')][string]$Action)
$ErrorActionPreference='Stop'
$repoRoot=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$runtimeRoot=Join-Path $PSScriptRoot 'runtime'
$migration=Join-Path $repoRoot 'supabase/migrations/20261107054356_s1_p3_interactions_owner_policies.sql'
$restore=Join-Path $repoRoot 'supabase/tests/s1_p3_restore_baseline.sql'
$beforePath=Join-Path $runtimeRoot 's1-p3-before.json'
$dockerCli='C:\Users\User\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe'
$localEngine='npipe:////./pipe/dockerDesktopLinuxEngine'
$projectId='rag-baseline-20261107-01a1b3be'
$container="supabase_db_$projectId"
$networkName="$projectId-internal"

$network=& $dockerCli --host $localEngine network inspect $networkName | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !$network[0].Internal -or
    $network[0].Labels.'rag.local-baseline' -ne '20261107-01a1b3be') { throw 'Rejecting unverified/internal-network target.' }
$db=& $dockerCli --host $localEngine inspect $container | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !$db[0].State.Running -or
    $db[0].Config.Labels.'com.supabase.cli.project' -ne $projectId -or
    @($db[0].NetworkSettings.Networks.PSObject.Properties).Count -ne 1 -or
    $db[0].NetworkSettings.Networks.PSObject.Properties.Name -ne $networkName) { throw 'Rejecting unverified local database.' }
foreach ($id in $network[0].Containers.PSObject.Properties.Name) {
    $member=& $dockerCli --host $localEngine inspect $id | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $member[0].Config.Labels.'com.supabase.cli.project' -ne $projectId -or
        @($member[0].NetworkSettings.Networks.PSObject.Properties).Count -ne 1) { throw 'Unexpected network membership.' }
}
foreach ($link in @('.supabase/project.json','supabase/.temp/project-ref')) {
    if (Test-Path -LiteralPath (Join-Path $runtimeRoot $link)) { throw 'Hosted/linked workspace prohibited.' }
}
function Invoke-LocalSql([string]$Sql) {
    $guard="select set_config('s1p3.local_target','rag-baseline-20261107-01a1b3be',false);`n"
    ($guard+$Sql) | & $dockerCli --host $localEngine exec -i --user postgres $container psql -X -qAt -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) { throw 'Guarded local SQL failed; no reset, network workaround or hosted fallback.' }
}
$preflight=@'
set search_path=public,extensions;
do $$ declare t text; n bigint; begin
  if current_database()<>'postgres' or current_setting('server_version')<>'17.11'
    or current_user<>'supabase_admin' or current_setting('cron.launch_active_jobs')<>'off'
    or position('pg_net' in current_setting('shared_preload_libraries'))>0
    or exists (select 1 from pg_stat_activity where backend_type like 'pg_net%')
    or exists (select 1 from supabase_migrations.schema_migrations)
    or exists (select 1 from auth.users) or exists (select 1 from vault.secrets)
    or exists (select 1 from net.http_request_queue) or exists (select 1 from net._http_response)
    or exists (select 1 from cron.job_run_details) then raise exception 'Local baseline/isolation precondition failed'; end if;
  foreach t in array array['projects','documents','document_chunks','interactions'] loop
    if to_regclass('public.'||t) is null then raise exception 'Missing baseline table %',t; end if;
    execute format('select count(*) from public.%I',t) into n;
    if n<>0 then raise exception 'Refusing existing application records'; end if;
  end loop;
end $$;
'@
Invoke-LocalSql $preflight | Out-Null
$snapshotSql=@'
set search_path=public,extensions;
select jsonb_build_object(
  'system_identifier',(select system_identifier::text from pg_control_system()),
  'interaction_policies',(select jsonb_agg(to_jsonb(p) order by policyname) from pg_policies p where schemaname='public' and tablename='interactions'),
  'other_policies',(select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p where not (schemaname='public' and tablename='interactions')),
  'boundary',(select to_jsonb(p) from pg_policies p where schemaname='public' and tablename='interactions' and policyname='owner_boundary'),
  'acls',(select jsonb_agg(to_jsonb(t) order by nspname,relname) from (
    select n.nspname,c.relname,c.relacl::text,(select jsonb_agg(jsonb_build_array(a.attname,a.attacl::text) order by a.attnum)
      from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as column_acls
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','storage') and c.relkind in ('r','p','v','m','S')) t),
  'schema_fingerprint',md5(jsonb_build_object(
    'columns',(select jsonb_agg(to_jsonb(t) order by table_name,ordinal_position) from information_schema.columns t where table_schema='public'),
    'constraints',(select jsonb_agg(jsonb_build_array(c.conname,pg_get_constraintdef(c.oid)) order by c.conrelid,c.conname) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public'),
    'indexes',(select jsonb_agg(to_jsonb(i) order by schemaname,tablename,indexname) from pg_indexes i where schemaname in ('public','storage')),
    'triggers',(select jsonb_agg(pg_get_triggerdef(t.oid) order by t.tgrelid,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','storage') and not t.tgisinternal),
    'functions',(select jsonb_agg(pg_get_functiondef(p.oid) order by p.oid) from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind in ('f','p'))
  )::text),
  'role_flags',(select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolbypassrls) order by rolname) from pg_roles where rolname in ('anon','authenticated','service_role')),
  'ledger_count',(select count(*) from supabase_migrations.schema_migrations)
);
'@
function Read-Snapshot {
    $lines=Invoke-LocalSql $snapshotSql
    $json=@($lines | Where-Object { $_.StartsWith('{') })
    if ($json.Count -ne 1) { throw 'Invalid catalog snapshot.' }
    return $json[0] | ConvertFrom-Json
}
function Assert-Preserved($Before,$After) {
    foreach ($field in @('system_identifier','other_policies','boundary','acls','schema_fingerprint','role_flags','ledger_count')) {
        if (($Before.$field | ConvertTo-Json -Depth 100 -Compress) -cne ($After.$field | ConvertTo-Json -Depth 100 -Compress)) {
            throw "Unexpected change outside approved interaction policies: $field"
        }
    }
}
function Transaction-Body([string]$Path) {
    $text=Get-Content -LiteralPath $Path -Raw
    $match=[regex]::Match($text,'(?is)\A(?:\s*--[^\r\n]*(?:\r?\n|$))*\s*begin;\s*(.*)\s*commit;\s*\z')
    if (!$match.Success) { throw 'Expected exactly one explicit migration transaction wrapper.' }
    return $match.Groups[1].Value
}

switch ($Action) {
    'Preflight' {
        if (Test-Path -LiteralPath $beforePath) { throw 'Preserve the existing preflight snapshot; do not overwrite it.' }
        $before=Read-Snapshot
        if (@($before.interaction_policies).Count -ne 4) { throw 'Expected the original four interaction policies.' }
        $before | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $beforePath -Encoding utf8
        $ddl=Invoke-LocalSql @'
set search_path=public,extensions;
select format('create policy %I on public.interactions as %s for %s to %s%s%s;',policyname,permissive,cmd,
  (select string_agg(quote_ident(r),', ') from unnest(roles) r),
  case when qual is null then '' else ' using ('||qual||')' end,
  case when with_check is null then '' else ' with check ('||with_check||')' end)
from pg_policies where schemaname='public' and tablename='interactions' and permissive='PERMISSIVE' order by policyname;
'@
        $ddl=@($ddl | Where-Object { $_ -ne $projectId }) -join "`n"
        if (Test-Path -LiteralPath $restore) { throw 'Do not overwrite an existing restoration file.' }
        $header=@'
-- LOCAL TEST RESTORATION ONLY: restores broad pre-S1 policies; never deploy.
begin;
do $$ begin
  if current_setting('s1p3.local_target',true) is distinct from 'rag-baseline-20261107-01a1b3be' then
    raise exception 'Guarded local connection required';
  end if;
  if (select count(*) from pg_policies where schemaname='public' and tablename='interactions')<>3 then
    raise exception 'Unexpected S1-P3 policy inventory';
  end if;
end $$;
drop policy owner_read on public.interactions;
drop policy owner_feedback_update on public.interactions;
'@
        ($header+"`n"+$ddl+"`ncommit;`n") | Set-Content -LiteralPath $restore -Encoding utf8
        Write-Output 'PASSED: preflight snapshot and exact catalog-derived policy restoration captured before policy writes'
    }
    'Restoration' {
        $before=Get-Content -LiteralPath $beforePath -Raw | ConvertFrom-Json
        $policies=($before.interaction_policies | ConvertTo-Json -Depth 100 -Compress).Replace("'","''")
        $assert=@'
do $$ begin
  if (select jsonb_agg(to_jsonb(p) order by policyname) from pg_policies p where schemaname='public' and tablename='interactions')
    <> '__POLICIES__'::jsonb then raise exception 'Policy restoration did not reproduce the baseline'; end if;
end $$;
rollback;
'@
        $sql="begin;`nset local search_path=public,extensions;`n"+(Transaction-Body $migration)+"`n"+(Transaction-Body $restore)+"`n"+$assert.Replace('__POLICIES__',$policies)
        Invoke-LocalSql $sql
        $after=Read-Snapshot
        Assert-Preserved $before $after
        if (($before.interaction_policies | ConvertTo-Json -Depth 100 -Compress) -cne
            ($after.interaction_policies | ConvertTo-Json -Depth 100 -Compress)) { throw 'Restoration test changed the baseline.' }
        Write-Output 'PASSED: forward/restore DDL exercised inside a rolled-back transaction; complete baseline preserved'
    }
    'Apply' {
        if (!(Test-Path -LiteralPath $restore)) { throw 'Policy restoration artifact required before applying.' }
        $before=Get-Content -LiteralPath $beforePath -Raw | ConvertFrom-Json
        Assert-Preserved $before (Read-Snapshot)
        Invoke-LocalSql (Get-Content -LiteralPath $migration -Raw)
        @{ migration=(Split-Path -Leaf $migration); sha256=(Get-FileHash -LiteralPath $migration -Algorithm SHA256).Hash; status='PASSED' } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeRoot 's1-p3-applied.json') -Encoding utf8
        Write-Output 'PASSED: only the new S1-P3 migration applied through the verified local administrative connection'
    }
    'Test' {
        Invoke-LocalSql (Get-Content -LiteralPath (Join-Path $repoRoot 'supabase/tests/s1_p3_interactions.sql') -Raw)
        Invoke-LocalSql $preflight | Out-Null
        Write-Output 'PASSED: T1 fixture transaction rolled back; no users, records or outbound activity remain'
    }
    'Verify' {
        $before=Get-Content -LiteralPath $beforePath -Raw | ConvertFrom-Json
        $after=Read-Snapshot
        Assert-Preserved $before $after
        if (@($after.interaction_policies).Count -ne 3) { throw 'Unexpected final interaction policy count.' }
        $after | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $runtimeRoot 's1-p3-after.json') -Encoding utf8
        Write-Output 'PASSED: boundary, all other policies, grants, table/index/constraint/trigger/function schema, roles and empty ledger preserved'
    }
}
