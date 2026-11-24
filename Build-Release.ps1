[CmdletBinding()]
param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist'))

$ErrorActionPreference = 'Stop'
$version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'VERSION') -Raw).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid VERSION' }
$paths = @(
    '.gitignore', 'Build-Release.ps1', 'CHANGELOG.md', 'README.md', 'VERSION',
    'Start-Workbench.ps1', 'Start-Workbench.pyw', 'Sync-AgentSkills.ps1',
    'chat-context.mjs', 'clash-recovery.mjs', 'codex.mjs', 'config.example.json',
    'conversations.mjs', 'ima-handoff.mjs', 'network.mjs', 'qwenwork-connector.example.json',
    'qwenwork-mcp.mjs', 'workbench.mjs', 'workbuddy-recovery.mjs',
    'docs/codex-gpt.md', 'docs/conversation-relay.md', 'docs/kimi.md', 'docs/qwenwork.md', 'docs/workbuddy.md',
    'skills/gpt/gpt-workbench/SKILL.md', 'skills/kimi/kimi.plugin.json',
    'skills/kimi/skills/kimi-gpt-workbench/SKILL.md', 'skills/kimi/skills/send-chat-to-gpt/SKILL.md',
    'skills/kimi/skills/send-chat-to-gpt/scripts/extract_chat.py',
    'skills/kimi/skills/send-chat-to-gpt/scripts/extract_kimi_web.js',
    'skills/kimi/skills/send-chat-to-gpt/scripts/list_chats.py',
    'skills/kimi/skills/send-chat-to-gpt/scripts/truncate_context.py',
    'skills/qwenwork/gpt-workbench-qwenwork/SKILL.md', 'skills/workbuddy/gpt-workbench/SKILL.md',
    'tests/fake-app.mjs', 'tests/fake-services.mjs', 'tests/relay.test.mjs', 'tests/watchdog_test.py',
    '周报样例资料.txt', '周报试用.md'
)
[Array]::Sort($paths, [StringComparer]::Ordinal)
New-Item -Path $OutputDirectory -ItemType Directory -Force | Out-Null
$fileName = "GPT-Workbench-$version.zip"
$target = Join-Path $OutputDirectory $fileName
$temp = $target + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
Add-Type -AssemblyName System.IO.Compression
try {
    $stream = [IO.File]::Open($temp, [IO.FileMode]::CreateNew)
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            foreach ($path in $paths) {
                $source = Get-Item -LiteralPath (Join-Path $PSScriptRoot $path) -Force
                if ($source.PSIsContainer -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                    throw "Release source is not a regular file $path"
                }
                $entry = $zip.CreateEntry("GPT-Workbench/$path", [IO.Compression.CompressionLevel]::NoCompression)
                $entry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
                $output = $entry.Open()
                try { $output.Write([IO.File]::ReadAllBytes($source.FullName)) }
                finally { $output.Dispose() }
            }
        }
        finally { $zip.Dispose() }
    }
    finally { $stream.Dispose() }
    [IO.File]::Move($temp, $target, $true)
}
finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp }
}
$sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$target.sha256", "$sha256  $fileName`n")
[pscustomobject]@{ Archive = (Resolve-Path -LiteralPath $target).Path; SHA256 = $sha256; Entries = $paths.Count }
