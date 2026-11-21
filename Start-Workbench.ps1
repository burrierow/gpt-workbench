$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$node = (Get-Command node.exe).Source
$codex = Get-Command codex.exe -ErrorAction SilentlyContinue
if ($codex) {
    $env:GPT_WORKBENCH_CODEX = $codex.Source
} elseif (-not (Test-Path -LiteralPath $config.codexExe)) {
    $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    $env:GPT_WORKBENCH_CODEX = Join-Path $package.InstallLocation 'app/resources/codex.exe'
}
$dataDir = if ($env:GPT_WORKBENCH_DATA) { $env:GPT_WORKBENCH_DATA }
    elseif ($config.dataDir) { $config.dataDir }
    else { Join-Path $PSScriptRoot 'data' }
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$service = Join-Path $PSScriptRoot 'workbench.mjs'
& $node $service serve >> (Join-Path $dataDir 'listener.log') 2>&1
exit $LASTEXITCODE
