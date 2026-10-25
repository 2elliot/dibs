$ErrorActionPreference = 'Stop'
$version = '2.13.0'
$windowsRunner = $env:OS -eq 'Windows_NT'
$assetName = if ($windowsRunner) { 'spacetime-x86_64-pc-windows-msvc.zip' } else { 'spacetime-x86_64-unknown-linux-gnu.tar.gz' }
$headers = @{ Accept = 'application/vnd.github+json' }
if ($env:GH_TOKEN) { $headers.Authorization = "Bearer $env:GH_TOKEN" }
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/clockworklabs/SpacetimeDB/releases/tags/v$version" -Headers $headers
$asset = $release.assets | Where-Object name -eq $assetName | Select-Object -First 1
if (!$asset) { throw "Pinned SpacetimeDB asset is missing: $assetName" }
$toolDir = Join-Path $env:RUNNER_TEMP 'dibs-spacetime-2.13.0'
New-Item -ItemType Directory -Path $toolDir -Force | Out-Null
$archive = Join-Path $toolDir $assetName
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive
if ($asset.digest) {
  $actual = 'sha256:' + (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $asset.digest) { throw 'SpacetimeDB release digest does not match GitHub metadata.' }
}
if ($windowsRunner) { Expand-Archive -LiteralPath $archive -DestinationPath $toolDir -Force }
else { & tar -xzf $archive -C $toolDir; if ($LASTEXITCODE -ne 0) { throw 'Could not extract SpacetimeDB.' } }
$suffix = if ($windowsRunner) { '.exe' } else { '' }
$cli = Get-ChildItem -LiteralPath $toolDir -Recurse -File | Where-Object Name -eq "spacetimedb-cli$suffix" | Select-Object -First 1
$server = Get-ChildItem -LiteralPath $toolDir -Recurse -File | Where-Object Name -eq "spacetimedb-standalone$suffix" | Select-Object -First 1
if (!$cli -or !$server) { throw 'Pinned archive does not contain the CLI and standalone server.' }
"SPACETIME_BIN=$($cli.FullName)" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
"SPACETIME_SERVER_BIN=$($server.FullName)" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
$cli.DirectoryName | Out-File -FilePath $env:GITHUB_PATH -Append -Encoding utf8
& $cli.FullName --version
if ($LASTEXITCODE -ne 0) { throw 'Pinned CLI does not start.' }
