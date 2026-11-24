param([switch]$ResolveExecutables)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$node = (Get-Command node.exe).Source
$codex = Get-Command codex.exe -ErrorAction SilentlyContinue
if ($codex) {
    $env:GPT_WORKBENCH_CODEX = $codex.Source
} elseif (!$config.codexExe -or -not (Test-Path -LiteralPath $config.codexExe)) {
    $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    if (!$package) { throw '未找到 Codex。请将 codex.exe 放入 PATH 或配置 codexExe。' }
    $env:GPT_WORKBENCH_CODEX = Join-Path $package.InstallLocation 'app/resources/codex.exe'
}
if ($ResolveExecutables) {
    @{ node = $node; codex = if ($env:GPT_WORKBENCH_CODEX) { $env:GPT_WORKBENCH_CODEX } else { $config.codexExe } } | ConvertTo-Json -Compress
    exit 0
}
$dataDir = if ($env:GPT_WORKBENCH_DATA) { $env:GPT_WORKBENCH_DATA }
    elseif ($config.dataDir) { $config.dataDir }
    else { Join-Path $PSScriptRoot 'data' }
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$service = Join-Path $PSScriptRoot 'workbench.mjs'
& $node $service serve >> (Join-Path $dataDir 'listener.log') 2>&1
exit $LASTEXITCODE
