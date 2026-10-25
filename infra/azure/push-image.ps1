# Pushes a new app image to ACR: the existing base (dibs-base:node24-slim, imported once with
# `az acr import`) plus the app layer from make_layer.py. Use when ACR Tasks are blocked and there's
# no Docker. Registry credentials come from `az acr credential show` and reach crane only over stdin;
# nothing secret is printed, and crane logs out at the end.
#
# usage: .\infra\azure\push-image.ps1 -Layer <app-layer.tar.gz> -Tag real-<sha12> [-Work <dir>]
#   -Work is the deployment workspace's work folder (see AGENT_HANDOFF.md): azure-deploy\az.ps1 runs
#   the signed-in, isolated Azure CLI profile, and azure-tools\crane\crane.exe is crane.
param(
    [Parameter(Mandatory)][string]$Layer,
    [Parameter(Mandatory)][string]$Tag,
    [string]$Work = $env:DIBS_AZURE_WORK,
    [string]$Registry = 'dibs2836579d9887'
)
# 'Continue': Windows PowerShell 5.1 turns any native stderr line into a terminating error under
# 'Stop', and crane and az log progress to stderr. Native steps are checked by $LASTEXITCODE.
$ErrorActionPreference = 'Continue'
if (-not $Work) { throw 'Pass -Work <deployment work folder> or set DIBS_AZURE_WORK.' }
$az = Join-Path $Work 'azure-deploy\az.ps1'
$crane = Join-Path $Work 'azure-tools\crane\crane.exe'
foreach ($tool in $az, $crane, $Layer) { if (-not (Test-Path -LiteralPath $tool)) { throw "Missing: $tool" } }
$server = "$Registry.azurecr.io"

$credentials = (& $az acr credential show --name $Registry --output json 2>$null) -join "`n" | ConvertFrom-Json
if (-not $credentials) { throw 'Could not read registry credentials (is az signed in?).' }
try {
    # Write the password with no line ending and no BOM. Piping a string in PowerShell 5.1 appends
    # CRLF (crane trims only "\n"), and process stdin uses the console input encoding, whose UTF-8
    # preamble prefixes a BOM. Either way crane stores a wrong password and every pull returns
    # "UNAUTHORIZED: authentication required".
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
    $start = New-Object System.Diagnostics.ProcessStartInfo $crane
    $start.Arguments = "auth login $server --username $($credentials.username) --password-stdin"
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $login = [System.Diagnostics.Process]::Start($start)
    $login.StandardInput.Write($credentials.passwords[0].value)
    $login.StandardInput.Close()
    $null = $login.StandardOutput.ReadToEnd(); $null = $login.StandardError.ReadToEnd()
    $login.WaitForExit()
    $credentials = $null
    if ($login.ExitCode -ne 0) { throw 'Container registry login failed.' }
    # crane auth login stores credentials without checking them; confirm with a read first.
    & $crane digest "$server/dibs-base:node24-slim" 2>&1 | ForEach-Object { "base: $_" }
    if ($LASTEXITCODE -ne 0) { throw 'Registry credentials were rejected.' }

    & $crane mutate "$server/dibs-base:node24-slim" --platform linux/amd64 --append $Layer `
        --cmd 'node,/app/apps/worker/src/index.mjs' --workdir /app --user node `
        --env NODE_ENV=production --env PORT=8080 --exposed-ports 8080 --tag "$server/dibs:$Tag" 2>&1 |
        ForEach-Object { "crane: $_" }
    if ($LASTEXITCODE -ne 0) { throw 'Image upload failed.' }
    $digest = (& $crane digest "$server/dibs:$Tag" 2>$null).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Image digest lookup failed.' }
    $config = (& $crane config "$server/dibs:$Tag" 2>$null) -join "`n" | ConvertFrom-Json
    [pscustomobject]@{ image = "$server/dibs:$Tag"; digest = $digest; os = $config.os; arch = $config.architecture;
        cmd = ($config.config.Cmd -join ' '); user = $config.config.User; workdir = $config.config.WorkingDir } | ConvertTo-Json
} finally {
    $credentials = $null
    & $crane auth logout $server 2>&1 | Out-Null
}
