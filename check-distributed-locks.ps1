<#
.SYNOPSIS
  Verifies whether the public.distributed_locks table from migration
  20260729090000_db_fr_014_distributed_locks_schema_restoration.sql
  has actually been applied to your Supabase project.

.DESCRIPTION
  Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from your core/.env file
  (same vars the backend uses) and does a lightweight PostgREST query
  against the distributed_locks table. PostgREST returns a specific error
  code (PGRST205 / "Could not find the table") when the table doesn't
  exist, which is how we tell "migration not applied" apart from other
  failures (auth, network, etc.).

.PARAMETER EnvPath
  Path to the .env file containing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
  Defaults to .\.env (run this from the core/ directory), or pass the path
  explicitly.

.EXAMPLE
  .\check-distributed-locks.ps1
  .\check-distributed-locks.ps1 -EnvPath "D:\hirerise-new\hirerise-core\.env"
#>

param(
    [string]$EnvPath = ".\.env"
)

function Read-EnvVar {
    param([string]$Path, [string]$Name)

    if (-not (Test-Path $Path)) {
        throw "Could not find .env at '$Path'. Pass -EnvPath explicitly, e.g. -EnvPath 'D:\path\to\core\.env'."
    }

    $line = Get-Content $Path | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
    if (-not $line) {
        throw "Could not find $Name in $Path"
    }

    $value = $line -replace "^\s*$Name\s*=", ""
    $value = $value.Trim().Trim('"').Trim("'")
    return $value
}

Write-Host "Reading Supabase credentials from $EnvPath ..." -ForegroundColor Cyan

try {
    $supabaseUrl = Read-EnvVar -Path $EnvPath -Name "SUPABASE_URL"
    $serviceKey  = Read-EnvVar -Path $EnvPath -Name "SUPABASE_SERVICE_ROLE_KEY"
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$supabaseUrl = $supabaseUrl.TrimEnd('/')
$endpoint    = "$supabaseUrl/rest/v1/distributed_locks?select=resource,lock_id,acquired_at,expires_at&limit=1"

$headers = @{
    "apikey"        = $serviceKey
    "Authorization" = "Bearer $serviceKey"
}

Write-Host "Querying $endpoint ..." -ForegroundColor Cyan
Write-Host ""

try {
    $response = Invoke-RestMethod -Uri $endpoint -Headers $headers -Method Get -ErrorAction Stop

    Write-Host "[OK] distributed_locks table EXISTS and is queryable." -ForegroundColor Green
    Write-Host "     Migration 20260729090000_db_fr_014_distributed_locks_schema_restoration.sql has been applied." -ForegroundColor Green
    Write-Host ""
    Write-Host "Sample rows returned (up to 1):" -ForegroundColor Gray
    $response | ConvertTo-Json -Depth 5

}
catch {
    $httpResp = $_.Exception.Response

    if ($null -eq $httpResp) {
        Write-Host "[FAIL] Request failed before reaching the server (network / DNS / TLS issue)." -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }

    $reader = New-Object System.IO.StreamReader($httpResp.GetResponseStream())
    $body   = $reader.ReadToEnd()
    $statusCode = [int]$httpResp.StatusCode

    $parsed = $null
    try { $parsed = $body | ConvertFrom-Json } catch { }

    if ($parsed -and $parsed.code -eq "PGRST205") {
        Write-Host "[FAIL] distributed_locks table DOES NOT EXIST." -ForegroundColor Red
        Write-Host "       Migration 20260729090000_db_fr_014_distributed_locks_schema_restoration.sql" -ForegroundColor Red
        Write-Host "       has NOT been applied to this Supabase project yet." -ForegroundColor Red
        Write-Host ""
        Write-Host "       This confirms the GET /api/v1/resume-scores/me 500 is caused by" -ForegroundColor Yellow
        Write-Host "       lockService.acquire() failing on every attempt (RESOURCE_LOCKED / DB error)" -ForegroundColor Yellow
        Write-Host "       because the table it writes to doesn't exist." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "       Fix: apply the migration, e.g.:" -ForegroundColor Cyan
        Write-Host "         supabase db push" -ForegroundColor White
        Write-Host "       or, if you run migrations manually against this project," -ForegroundColor Cyan
        Write-Host "       execute the SQL in that file directly against your Supabase DB." -ForegroundColor Cyan
    }
    elseif ($statusCode -eq 401 -or $statusCode -eq 403) {
        Write-Host "[FAIL] Auth error ($statusCode) - SUPABASE_SERVICE_ROLE_KEY in $EnvPath looks invalid or expired." -ForegroundColor Red
        Write-Host $body -ForegroundColor Red
    }
    else {
        Write-Host "[FAIL] Unexpected error (HTTP $statusCode):" -ForegroundColor Red
        Write-Host $body -ForegroundColor Red
    }

    exit 1
}