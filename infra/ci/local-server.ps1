$ErrorActionPreference = 'Stop'
if (!$env:SPACETIME_SERVER_BIN) { throw 'Install the pinned SpacetimeDB release first.' }
$dataDir = Join-Path $env:RUNNER_TEMP 'dibs-exp-ci-data'
$port = if ($env:DIBS_CI_PORT) { [int]$env:DIBS_CI_PORT } else { 4160 }
& node (Join-Path $PSScriptRoot 'test-keys.mjs') $dataDir
if ($LASTEXITCODE -ne 0) { throw 'Could not generate ephemeral local-test signing keys.' }
$serverArgs = @('start', '--listen-addr', "127.0.0.1:$port", '--data-dir', $dataDir, '--in-memory', '--page_pool_max_size', '268435456', '--non-interactive', '--jwt-pub-key-path', (Join-Path $dataDir 'test-jwt-public.pem'), '--jwt-priv-key-path', (Join-Path $dataDir 'test-jwt-private.pem'))
$options = @{ FilePath = $env:SPACETIME_SERVER_BIN; ArgumentList = $serverArgs; PassThru = $true; RedirectStandardOutput = (Join-Path $env:RUNNER_TEMP 'dibs-server.log'); RedirectStandardError = (Join-Path $env:RUNNER_TEMP 'dibs-server-error.log') }
if ($env:OS -eq 'Windows_NT') { $options.WindowStyle = 'Hidden' }
$process = Start-Process @options
$deadline = (Get-Date).AddSeconds(45)
do {
  if ($process.HasExited) { Get-Content -LiteralPath $options.RedirectStandardError; throw 'The isolated database server exited.' }
  try {
    $connection = [System.Net.Sockets.TcpClient]::new()
    $connection.Connect('127.0.0.1', $port)
    $connection.Dispose()
    "DIBS_TEST_URI=http://127.0.0.1:$port" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
    "DIBS_WORKER_LIVE_URI=http://127.0.0.1:$port" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
    "SPACETIME_CLI_CONFIG=$(Join-Path $env:RUNNER_TEMP 'dibs-local-cli.toml')" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
    exit 0
  } catch { Start-Sleep -Milliseconds 250 }
} while ((Get-Date) -lt $deadline)
throw 'The isolated database server did not become ready.'
