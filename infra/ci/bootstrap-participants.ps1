# Re-register the admin and worker identities after a publish that wiped data.
# Idempotent: participants that survived the publish are left alone. Expects the
# CLI to be logged in as the database owner, who can read the private invite table.
$ErrorActionPreference = 'Stop'

$configArgs = if ($env:SPACETIME_CLI_CONFIG) { @('--config-path', $env:SPACETIME_CLI_CONFIG) } else { @() }

function Sql([string]$query) {
  $out = & $env:SPACETIME_BIN @configArgs sql --server $env:SPACETIME_URI --yes --format json $env:SPACETIME_DB $query
  if ($LASTEXITCODE -ne 0) { throw "SpacetimeDB SQL failed: $query" }
  , @(($out | Out-String | ConvertFrom-Json)[0].rows)
}

function Claim([string]$name, [string]$code) {
  if (!$code) { throw "No invite code available for $name." }
  npm run --silent dibs -- join --uri $env:SPACETIME_URI --db $env:SPACETIME_DB --participant $name --code $code
  if ($LASTEXITCODE -ne 0) { throw "Could not re-register $name." }
}

$base = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$env:DIBS_HOME = Join-Path $base "dibs-bootstrap-$PID"
try {
  # `dibs join` reuses a saved token, so each claim binds the same identity as before.
  foreach ($entry in @(@('admin', $env:SPACETIME_ADMIN_TOKEN), @('worker', $env:SPACETIME_WORKER_TOKEN))) {
    $dir = Join-Path $env:DIBS_HOME $entry[0]
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $dir 'token'), $entry[1])
  }

  if ((Sql "SELECT name FROM participant WHERE name = 'admin'").Count -eq 0) {
    $invite = Sql "SELECT code FROM invite WHERE name = 'admin' AND used = false"
    Claim 'admin' $(if ($invite.Count) { $invite[0][0] })
  }
  if ((Sql "SELECT name FROM participant WHERE name = 'worker'").Count -eq 0) {
    $code = npm run --silent dibs -- admin invite worker claude worker | Select-Object -Last 1
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the worker invite.' }
    Claim 'worker' $code
  }
  Write-Output 'Admin and worker participants are registered.'
}
finally {
  Remove-Item -LiteralPath $env:DIBS_HOME -Recurse -Force -ErrorAction SilentlyContinue
}
