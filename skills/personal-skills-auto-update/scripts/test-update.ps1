[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "update.ps1"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("personal-skills-update-test-" + [guid]::NewGuid().ToString("N"))
$origin = Join-Path $testRoot "origin.git"
$seed = Join-Path $testRoot "seed"
$client = Join-Path $testRoot "client"

function Invoke-TestGit {
    param([string[]]$Arguments)
    & git @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "git failed: git $($Arguments -join ' ')"
    }
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
Invoke-TestGit @("init", "--bare", $origin)
Invoke-TestGit @("clone", $origin, $seed)
Invoke-TestGit @("-C", $seed, "config", "user.name", "test")
Invoke-TestGit @("-C", $seed, "config", "user.email", "test@example.invalid")
Invoke-TestGit @("-C", $seed, "switch", "-c", "main")
Invoke-TestGit @("-C", $seed, "commit", "--allow-empty", "-m", "initial")
Invoke-TestGit @("-C", $seed, "push", "-u", "origin", "main")
Invoke-TestGit @("--git-dir=$origin", "symbolic-ref", "HEAD", "refs/heads/main")
Invoke-TestGit @("clone", $origin, $client)

Invoke-TestGit @("-C", $seed, "commit", "--allow-empty", "-m", "upstream")
Invoke-TestGit @("-C", $seed, "push")
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Repo $client -SkipInstall
if ($LASTEXITCODE -ne 0) {
    throw "expected fast-forward success, got $LASTEXITCODE"
}

$localHead = (& git -C $client rev-parse HEAD).Trim()
$remoteHead = (& git -C $client rev-parse origin/main).Trim()
if ($localHead -ne $remoteHead) {
    throw "local HEAD does not match origin/main"
}

$dirtyFile = Join-Path $client "untracked.txt"
Set-Content -LiteralPath $dirtyFile -Value "uncommitted"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Repo $client -SkipInstall
if ($LASTEXITCODE -ne 20) {
    throw "expected dirty-worktree block status 20, got $LASTEXITCODE"
}
if ((Get-Content -LiteralPath $dirtyFile -Raw).Trim() -ne "uncommitted") {
    throw "dirty file was modified"
}
Remove-Item -LiteralPath $dirtyFile -Force

Invoke-TestGit @("-C", $client, "switch", "--detach")
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Repo $client -SkipInstall
if ($LASTEXITCODE -ne 20) {
    throw "expected detached-HEAD block status 20, got $LASTEXITCODE"
}
Invoke-TestGit @("-C", $client, "switch", "main")

Invoke-TestGit @("-C", $client, "config", "user.name", "test")
Invoke-TestGit @("-C", $client, "config", "user.email", "test@example.invalid")
Invoke-TestGit @("-C", $client, "commit", "--allow-empty", "-m", "local-only")
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Repo $client -SkipInstall
if ($LASTEXITCODE -ne 20) {
    throw "expected local-commit block status 20, got $LASTEXITCODE"
}

$commonDir = (& git -C $client rev-parse --path-format=absolute --git-common-dir).Trim()
$lockPath = Join-Path $commonDir "personal-skills-update.lock"
$lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Repo $client -SkipInstall
    if ($LASTEXITCODE -ne 10) {
        throw "expected busy status 10, got $LASTEXITCODE"
    }
} finally {
    $lock.Dispose()
}

Write-Output "test_status=passed platform=windows temp=$testRoot"
