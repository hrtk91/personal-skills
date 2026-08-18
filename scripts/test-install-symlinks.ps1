[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "install-symlinks.ps1"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("personal-skills-install-test-" + [guid]::NewGuid().ToString("N"))
$runtimeRepo = Join-Path $testRoot "runtime"
$adoptRepo = Join-Path $testRoot "development"
$unmanagedRepo = Join-Path $testRoot "unmanaged"
$codexRoot = Join-Path $testRoot "codex"
$unmanagedCodexRoot = Join-Path $testRoot "codex-unmanaged"
$partialCodexRoot = Join-Path $testRoot "codex-partial"
$blockedClaudeRoot = Join-Path $testRoot "claude-blocked"
$claudeRoot = Join-Path $testRoot "claude"

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Invoke-Installer {
    param(
        [string]$TargetCodexRoot,
        [string]$TargetClaudeRoot,
        [string]$TargetRepo,
        [string]$AdoptRepo = ""
    )

    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $scriptPath,
        "-RepoRoot", $TargetRepo,
        "-CodexRoot", $TargetCodexRoot,
        "-ClaudeRoot", $TargetClaudeRoot
    )
    if (-not [string]::IsNullOrWhiteSpace($AdoptRepo)) {
        $arguments += @("-AdoptRepoRoot", $AdoptRepo)
    }

    # 失敗系テストではinstallerの標準エラーを捨て、終了コードとファイル状態を検証する。
    # 親テストのErrorActionPreferenceは必ずfinallyで元へ戻す。
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $null = & powershell.exe @arguments 2>$null
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
}

# このテストが守る保証:
# - 既知の旧Junctionは通常フォルダへ移行し、agentはruntime repoから配布する。
# - 移行後の後続処理が失敗したら、利用中だった旧Junctionを復元する。
# - 所有元を確認できないJunctionには書き込まず、参照先も変更しない。

# 共通Arrange: runtime repo、開発checkout、未知の参照先を一時領域に用意する。
New-Item -ItemType Directory -Path (Join-Path $runtimeRepo "agents") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $runtimeRepo "skills\sample") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $adoptRepo "agents") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $unmanagedRepo "agents") -Force | Out-Null
Set-Content -LiteralPath (Join-Path $runtimeRepo "agents\sample.toml") -Value "runtime-agent" -Encoding UTF8
Set-Content -LiteralPath (Join-Path $runtimeRepo "skills\sample\SKILL.md") -Value "runtime-skill" -Encoding UTF8
Set-Content -LiteralPath (Join-Path $adoptRepo "agents\legacy.toml") -Value "development-agent" -Encoding UTF8

# テストの流れ:
# 1. Arrange: Codexのagent配布先を、明示された開発checkoutへの旧Junctionにする。
# 2. Act: runtime repoを配布元としてinstallerを実行する。
# 3. Assert: 配布先だけが通常フォルダになり、開発checkoutには何も書き込まれないことを確認する。

# 1. Arrange: Codexのagent配布先を、明示された開発checkoutへの旧Junctionにする。
New-Item -ItemType Directory -Path $codexRoot -Force | Out-Null
New-Item -ItemType Junction -Path (Join-Path $codexRoot "agents") -Target (Join-Path $adoptRepo "agents") | Out-Null

# 2. Act: runtime repoを配布元としてinstallerを実行する。
Write-Output "test: migrate a known agent Junction to a normal directory"
$exitCode = Invoke-Installer -TargetCodexRoot $codexRoot -TargetClaudeRoot $claudeRoot -TargetRepo $runtimeRepo -AdoptRepo $adoptRepo

# 3. Assert: 配布先だけが通常フォルダになり、開発checkoutには何も書き込まれないことを確認する。
Assert-True ($exitCode -eq 0) "known Junction migration failed: exit=$exitCode"
$agentsDirectory = Get-Item -LiteralPath (Join-Path $codexRoot "agents") -Force
Assert-True ($null -eq $agentsDirectory.LinkType) "agent target is still a link"
Assert-True (-not ($agentsDirectory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) "agent target is still a reparse point"
$installedAgent = Join-Path $codexRoot "agents\sample.toml"
Assert-True (Test-Path -LiteralPath $installedAgent) "runtime agent was not installed"
Assert-True ((Get-Content -LiteralPath $installedAgent -Raw).Trim() -eq "runtime-agent") "runtime agent content does not match"
Assert-True (Test-Path -LiteralPath (Join-Path $adoptRepo "agents\legacy.toml")) "development agent was deleted during migration"
Assert-True ((Get-Content -LiteralPath (Join-Path $codexRoot "agents\sample.toml.personal-skills-managed") -Raw).Trim() -eq (Join-Path $runtimeRepo "agents\sample.toml")) "agent management marker does not match"
Assert-True (-not (Test-Path -LiteralPath (Join-Path $adoptRepo "agents\sample.toml"))) "runtime agent leaked into the development repository"
Assert-True (-not (Test-Path -LiteralPath (Join-Path $adoptRepo "agents\sample.toml.personal-skills-managed"))) "runtime marker leaked into the development repository"

# テストの流れ:
# 1. Arrange: 既知Junctionを再現し、agent移行後のskill配布だけが失敗する状態を作る。
# 2. Act: installerを実行して後続処理を失敗させる。
# 3. Assert: 失敗を報告し、元のJunctionと開発checkoutの内容を保つことを確認する。

# 1. Arrange: 既知Junctionを再現し、agent移行後のskill配布だけが失敗する状態を作る。
New-Item -ItemType Directory -Path $partialCodexRoot -Force | Out-Null
New-Item -ItemType Junction -Path (Join-Path $partialCodexRoot "agents") -Target (Join-Path $adoptRepo "agents") | Out-Null
Set-Content -LiteralPath $blockedClaudeRoot -Value "not-a-directory" -Encoding UTF8

# 2. Act: installerを実行して後続処理を失敗させる。
Write-Output "test: restore a known Junction after a later install failure"
$exitCode = Invoke-Installer -TargetCodexRoot $partialCodexRoot -TargetClaudeRoot $blockedClaudeRoot -TargetRepo $runtimeRepo -AdoptRepo $adoptRepo

# 3. Assert: 失敗を報告し、元のJunctionと開発checkoutの内容を保つことを確認する。
Assert-True ($exitCode -ne 0) "partial install failure was not reported"
$restoredAgentsDirectory = Get-Item -LiteralPath (Join-Path $partialCodexRoot "agents") -Force
Assert-True ($restoredAgentsDirectory.LinkType -eq "Junction") "known Junction was not restored after failure"
Assert-True ((@($restoredAgentsDirectory.Target) -join "") -ieq (Join-Path $adoptRepo "agents")) "restored Junction points to the wrong directory"
Assert-True (-not (Test-Path -LiteralPath (Join-Path $adoptRepo "agents\sample.toml.personal-skills-managed"))) "failed install leaked a marker into the development repository"

# テストの流れ:
# 1. Arrange: runtime repoにも開発checkoutにも一致しないJunctionを用意する。
# 2. Act: 所有元を指定せずinstallerを実行する。
# 3. Assert: installerが失敗し、Junctionと参照先の内容を変更しないことを確認する。

# 1. Arrange: runtime repoにも開発checkoutにも一致しないJunctionを用意する。
New-Item -ItemType Directory -Path $unmanagedCodexRoot -Force | Out-Null
New-Item -ItemType Junction -Path (Join-Path $unmanagedCodexRoot "agents") -Target (Join-Path $unmanagedRepo "agents") | Out-Null

# 2. Act: 所有元を指定せずinstallerを実行する。
Write-Output "test: refuse writes through an unknown agent Junction"
$exitCode = Invoke-Installer -TargetCodexRoot $unmanagedCodexRoot -TargetClaudeRoot (Join-Path $testRoot "claude-unmanaged") -TargetRepo $runtimeRepo

# 3. Assert: installerが失敗し、Junctionと参照先の内容を変更しないことを確認する。
Assert-True ($exitCode -ne 0) "writes through an unknown Junction were allowed"
$unmanagedAgentsDirectory = Get-Item -LiteralPath (Join-Path $unmanagedCodexRoot "agents") -Force
Assert-True ($unmanagedAgentsDirectory.LinkType -eq "Junction") "unknown Junction was changed after refusal"
$unmanagedChildren = @(Get-ChildItem -LiteralPath (Join-Path $unmanagedRepo "agents") -Force)
Assert-True ($unmanagedChildren.Count -eq 0) "unknown Junction target was changed"

Write-Output "test_status=passed platform=windows temp=$testRoot"
