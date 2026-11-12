$ErrorActionPreference = 'Stop'
$dockerCli = 'C:\Users\User\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe'
$localEngine = 'npipe:////./pipe/dockerDesktopLinuxEngine'
$projectId = 'rag-baseline-20261107-01a1b3be'
$container = "supabase_db_$projectId"
$networkName = "$projectId-internal"
$network = & $dockerCli --host $localEngine network inspect $networkName | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !$network[0].Internal -or
    $network[0].Labels.'rag.local-baseline' -ne '20261107-01a1b3be') { throw 'Unverified internal network.' }
$db = & $dockerCli --host $localEngine inspect $container | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !$db[0].State.Running -or
    $db[0].Config.Labels.'com.supabase.cli.project' -ne $projectId -or
    @($db[0].NetworkSettings.Networks.PSObject.Properties).Count -ne 1 -or
    $db[0].NetworkSettings.Networks.PSObject.Properties.Name -ne $networkName) { throw 'Unverified disposable database.' }

$expected = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'expected-catalog.json') -Raw).Replace("'", "''")
$validation = "CREATE TEMP TABLE baseline_expected AS SELECT '$expected'::jsonb AS catalog;`n" +
    (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'validate.sql') -Raw)
$validation | & $dockerCli --host $localEngine exec -i --user postgres $container psql -X -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At
if ($LASTEXITCODE -ne 0) { throw 'Local baseline validation failed.' }
@'
DO $$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.projects) AND NOT EXISTS (SELECT 1 FROM auth.users), 'Fixtures were not rolled back';
  ASSERT NOT EXISTS (SELECT 1 FROM net.http_request_queue) AND NOT EXISTS (SELECT 1 FROM net._http_response), 'Unexpected HTTP activity';
END $$;
SELECT extname,extversion FROM pg_extension WHERE extname IN ('vector','pg_cron','pg_net','pgcrypto','uuid-ossp','supabase_vault') ORDER BY extname;
'@ | & $dockerCli --host $localEngine exec -i --user postgres $container psql -X -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At
if ($LASTEXITCODE -ne 0) { throw 'Post-validation cleanup assertions failed.' }
Write-Output 'PASSED: baseline catalog, rolled-back synthetic fixtures, and no HTTP activity'
