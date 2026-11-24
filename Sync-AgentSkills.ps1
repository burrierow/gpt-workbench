[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$manifest = Get-Content -LiteralPath (Join-Path $root 'skill-targets.json') -Raw | ConvertFrom-Json

foreach ($target in $manifest.targets) {
    if (!(Test-Path -LiteralPath $target.directory -PathType Container)) {
        throw "技能目录不存在 $($target.directory)"
    }
    foreach ($relative in $target.skills) {
        if ($relative -notmatch '^skills/(?:[a-z-]+/)+[a-z-]+$') { throw "无效技能路径 $relative" }
        $source = (Resolve-Path -LiteralPath (Join-Path $root $relative)).Path
        $destination = Join-Path $target.directory (Split-Path -Leaf $source)
        foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File) {
            $output = Join-Path $destination ([IO.Path]::GetRelativePath($source, $file.FullName))
            New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
            $next = "$output.next-$([guid]::NewGuid().ToString('N'))"
            Copy-Item -LiteralPath $file.FullName -Destination $next
            [IO.File]::Move($next, $output, $true)
            if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $output).Hash) {
                throw "技能文件校验失败 $output"
            }
        }
        [pscustomobject]@{ Agent = $target.agent; Skill = Split-Path -Leaf $source; Directory = $destination }
    }
}

$kimiBundle = Join-Path $root 'skills/kimi'
$native = $manifest.kimiNative
$node = (Get-Command node.exe).Source
$report = & $native.cli --node $node kimi-plugin install $kimiBundle --share-dir $native.share --json
if ($LASTEXITCODE) { throw 'Kimi 原生插件安装失败' }
$expected = (Get-Content -LiteralPath (Join-Path $kimiBundle 'kimi.plugin.json') -Raw | ConvertFrom-Json).version
$managed = Join-Path $native.share 'daimon/runtime/kimi-code/home/plugins/managed/gpt-workbench-kimi'
$installed = (Get-Content -LiteralPath (Join-Path $managed 'kimi.plugin.json') -Raw | ConvertFrom-Json).version
if ($installed -ne $expected) { throw 'Kimi 插件安装版本不匹配' }
[pscustomobject]@{ Agent = 'Kimi'; PluginVersion = $installed; RestartRequired = (($report -join ' ') -match 'restart-required') }
