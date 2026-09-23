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

# このテストが守る保証:
# - runtime repoはorigin/mainへfast-forwardできるときだけ更新する。
# - 未コミット変更、別branch、ローカルcommit、二重実行がある場合は既存状態を壊さず停止する。
# - Windowsの定期Taskはruntime repoを更新するheadless Actionで実行する。

# 1. Arrange: 更新可否を切り替えられる一時origin、更新元repo、runtime相当のclientを作る。
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

# 2. Act/Assert: origin/mainだけが進んでいる場合は、clientをfast-forwardする。
Invoke-TestGit @("-C", $seed, "commit", "--allow-empty", "-m", "upstream")
Invoke-TestGit @("-C", $seed, "push")
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Repo $client
if ($LASTEXITCODE -ne 0) {
    throw "expected fast-forward success, got $LASTEXITCODE"
}

$localHead = (& git -C $client rev-parse HEAD).Trim()
$remoteHead = (& git -C $client rev-parse origin/main).Trim()
if ($localHead -ne $remoteHead) {
    throw "local HEAD does not match origin/main"
}

# 3. Act/Assert: 未コミット変更がある場合は終了コード20で停止し、そのファイルを変更しない。
$dirtyFile = Join-Path $client "untracked.txt"
Set-Content -LiteralPath $dirtyFile -Value "uncommitted"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Repo $client
if ($LASTEXITCODE -ne 20) {
    throw "expected dirty-worktree block status 20, got $LASTEXITCODE"
}
if ((Get-Content -LiteralPath $dirtyFile -Raw).Trim() -ne "uncommitted") {
    throw "dirty file was modified"
}
Remove-Item -LiteralPath $dirtyFile -Force

# 4. Act/Assert: base branch以外では終了コード20で停止する。
Invoke-TestGit @("-C", $client, "switch", "--detach")
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Repo $client
if ($LASTEXITCODE -ne 20) {
    throw "expected detached-HEAD block status 20, got $LASTEXITCODE"
}
Invoke-TestGit @("-C", $client, "switch", "main")

# 5. Act/Assert: originにないローカルcommitがある場合は終了コード20で停止する。
Invoke-TestGit @("-C", $client, "config", "user.name", "test")
Invoke-TestGit @("-C", $client, "config", "user.email", "test@example.invalid")
Invoke-TestGit @("-C", $client, "commit", "--allow-empty", "-m", "local-only")
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Repo $client
if ($LASTEXITCODE -ne 20) {
    throw "expected local-commit block status 20, got $LASTEXITCODE"
}

# 6. Act/Assert: 別の更新処理がlockを保持している場合は終了コード10で停止する。
$commonDir = (& git -C $client rev-parse --path-format=absolute --git-common-dir).Trim()
$lockPath = Join-Path $commonDir "personal-skills-update.lock"
$lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Repo $client
    if ($LASTEXITCODE -ne 10) {
        throw "expected busy status 10, got $LASTEXITCODE"
    }
} finally {
    $lock.Dispose()
}

# テストの流れ:
# 1. Arrange: update.ps1内のTask更新関数を読み込み、Windows cmdletをFakeへ差し替える。
# 2. Act: 旧形式の定期Task Actionを更新する。
# 3. Assert: 新しいActionから旧引数を除き、headless形式にすることを確認する。

# 1. Arrange: update.ps1内のTask更新関数を読み込み、Windows cmdletをFakeへ差し替える。
Write-Output "test: scheduled task drops legacy update arguments"
$parseTokens = $null
$parseErrors = $null
$updateAst = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$parseTokens, [ref]$parseErrors)
$actionFunction = $updateAst.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Update-WindowsScheduledTaskAction"
    }, $true)
if ($null -eq $actionFunction) {
    throw "scheduled-task action function was not found"
}
. ([scriptblock]::Create($actionFunction.Extent.Text))

$taskName = "TestPersonalSkillsAutoUpdate"
$updateScript = Join-Path $client "skills\personal-skills-auto-update\scripts\update.ps1"
$oldArguments = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$updateScript`" -Repo `"$client`" -BaseBranch `"main`" -TaskName `"$taskName`" -AdoptRepoRoot `"$seed`""
$script:fakeTask = [pscustomobject]@{
    Actions = @([pscustomobject]@{ Execute = "old-executable"; Arguments = $oldArguments })
}
$script:capturedAction = $null

function global:Get-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath)
    return $script:fakeTask
}

function global:New-ScheduledTaskAction {
    param([string]$Execute, [string]$Argument)
    $script:capturedAction = [pscustomobject]@{ Execute = $Execute; Arguments = $Argument }
    return $script:capturedAction
}

function global:Set-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath, [object]$Action)
    $script:fakeTask = [pscustomobject]@{ Actions = @($Action) }
}

# 2. Act: 既存TaskのActionをheadless形式へ更新する。
Update-WindowsScheduledTaskAction -Repo $client -BaseBranch "main" -TaskName $taskName

# 3. Assert: headless形式になり、runtime repo更新以外の旧引数を含まないことを確認する。
if ($null -eq $script:capturedAction) {
    throw "scheduled-task action was not updated"
}
if ($script:capturedAction.Execute -ine (Join-Path $env:SystemRoot "System32\conhost.exe") -or
    $script:capturedAction.Arguments -notlike "--headless * -File `"$updateScript`" -Repo `"$client`"*" -or
    $script:capturedAction.Arguments -like "*-AdoptRepoRoot*") {
    throw "scheduled-task action does not run the runtime-only updater in headless mode"
}

Write-Output "test_status=passed platform=windows temp=$testRoot"
