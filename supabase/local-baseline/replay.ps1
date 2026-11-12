$ErrorActionPreference = 'Stop'
$baselineRoot = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $baselineRoot '../..')).Path
$runtimeRoot = Join-Path $baselineRoot 'runtime'
$projectId = 'rag-baseline-20261107-01a1b3be'
$networkName = "$projectId-internal"
$container = "supabase_db_$projectId"
$dockerCli = 'C:\Users\User\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe'
$localEngine = 'npipe:////./pipe/dockerDesktopLinuxEngine'
$migrationNames = @(
    '202610280001_harden_access_and_ingestion.sql',
    '202611040001_automatic_ingestion_recovery.sql',
    '202611040002_align_storage_webhook.sql',
    '20261104094738_restrict_cleanup_trigger_execution.sql'
)

if (!(Test-Path -LiteralPath (Join-Path $runtimeRoot 'supabase/config.toml'))) { throw 'Start the isolated workspace first.' }
foreach ($linkFile in @('.supabase/project.json', 'supabase/.temp/project-ref')) {
    if (Test-Path -LiteralPath (Join-Path $runtimeRoot $linkFile)) { throw 'Linked workspaces are prohibited.' }
}
if ((Get-FileHash -LiteralPath (Join-Path $baselineRoot 'config.toml')).Hash -ne
    (Get-FileHash -LiteralPath (Join-Path $runtimeRoot 'supabase/config.toml')).Hash) { throw 'Runtime configuration mismatch.' }
$network = & $dockerCli --host $localEngine network inspect $networkName | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !$network[0].Internal -or
    $network[0].Labels.'rag.local-baseline' -ne '20261107-01a1b3be') { throw 'Unverified network.' }
foreach ($id in @($network[0].Containers.PSObject.Properties.Name)) {
    $inspection = & $dockerCli --host $localEngine inspect $id | ConvertFrom-Json
    if ($inspection[0].Config.Labels.'com.supabase.cli.project' -ne $projectId -or
        @($inspection[0].NetworkSettings.Networks.PSObject.Properties).Count -ne 1) { throw 'Unexpected network member or external network.' }
}
$db = & $dockerCli --host $localEngine inspect $container | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !$db[0].State.Running -or
    $db[0].Config.Labels.'com.supabase.cli.project' -ne $projectId) { throw 'Unverified local database.' }

function Invoke-LocalSql([string]$Sql) {
    $Sql | & $dockerCli --host $localEngine exec -i --user postgres $container psql -X -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At
    if ($LASTEXITCODE -ne 0) { throw 'Local SQL failed; no automatic reset or retry.' }
}

Invoke-LocalSql @'
DO $$ BEGIN
  ASSERT current_setting('server_version_num')::integer / 10000 = 17, 'PostgreSQL 17 required';
  ASSERT to_regclass('public.projects') IS NULL AND to_regclass('public.interactions') IS NULL,
    'Refusing to replay into an existing application database';
  ASSERT to_regclass('storage.objects') IS NOT NULL AND to_regclass('auth.users') IS NOT NULL,
    'Real managed schemas must exist';
  ASSERT NOT EXISTS (SELECT 1 FROM auth.users) AND NOT EXISTS (SELECT 1 FROM vault.secrets),
    'Only an empty synthetic workspace is permitted';
END $$;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
ALTER SYSTEM SET cron.launch_active_jobs='off';
SELECT format('ALTER SYSTEM SET shared_preload_libraries=%s', string_agg(quote_literal(trim(library)), ', '))
FROM regexp_split_to_table(current_setting('shared_preload_libraries'), ',') library
WHERE trim(library) <> 'pg_net'
\gexec
'@
& $dockerCli --host $localEngine restart $container | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Local restart failed.' }
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    & $dockerCli --host $localEngine exec $container pg_isready -h 127.0.0.1 -U postgres -d postgres *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
}
if (!$ready) { throw 'Local PostgreSQL did not restart.' }
Invoke-LocalSql @'
DO $$ BEGIN
  ASSERT current_setting('cron.launch_active_jobs')='off', 'Cron must be disabled before migration replay';
  ASSERT position('pg_net' IN current_setting('shared_preload_libraries'))=0, 'HTTP worker must be disabled';
END $$;
'@
Invoke-LocalSql (Get-Content -LiteralPath (Join-Path $baselineRoot 'prerequisite.sql') -Raw)
Write-Output 'PASSED: catalog-derived prerequisite schema'

$migrationDirectory = Join-Path $runtimeRoot 'supabase/migrations'
if ((Test-Path -LiteralPath $migrationDirectory) -and (Get-ChildItem -LiteralPath $migrationDirectory -Force)) {
    throw 'Migration directory is not empty; inspect partial state manually.'
}
New-Item -ItemType Directory -Path $migrationDirectory -Force | Out-Null
$manifest = @()
foreach ($name in $migrationNames) {
    $source = Join-Path $repoRoot "supabase/migrations/$name"
    $copy = Join-Path $migrationDirectory $name
    Copy-Item -LiteralPath $source -Destination $copy
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    if ((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash -ne $sourceHash) { throw 'Migration copy differs from original.' }
    Invoke-LocalSql (Get-Content -LiteralPath $copy -Raw)
    $manifest += @{ name = $name; sha256 = $sourceHash; status = 'PASSED' }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeRoot 'migration-manifest.json') -Encoding utf8
    Write-Output "PASSED: $name (local administrative SQL replay)"
}

& (Join-Path $baselineRoot 'check.ps1')
