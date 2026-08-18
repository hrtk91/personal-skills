[CmdletBinding()]
param(
    [string]$SourceRepo = (Join-Path $HOME "repos\personal-skills"),
    [string]$RuntimeRepo = (Join-Path $env:LOCALAPPDATA "personal-skills-runtime"),
    [string]$BaseBranch = "main",
    [string]$TaskName = "PersonalSkillsAutoUpdate"
)

$ErrorActionPreference = "Stop"

# 処理順:
# 1. 開発checkoutの取得元を確認する。
# 2. 自動更新専用のruntime repoを作成または検証する。
# 3. runtime repoを最新化し、skill/agentの配布まで成功させる。
# 4. 以後の更新に必要なruntime repoと開発checkoutの場所をTaskへ登録する。
# 5. 登録されたTaskの現在状態と次回実行時刻を表示する。

# 1. 開発checkoutの取得元を確認する。
$SourceRepo = (Resolve-Path -LiteralPath $SourceRepo).Path
$remoteUrl = (& git -C $SourceRepo remote get-url origin | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "cannot resolve origin URL from $SourceRepo"
}

# 2. 自動更新専用のruntime repoを作成または検証する。
# 開発checkoutではなくcleanなruntime repoだけを定期更新することで、開発中の変更を壊さない。
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeRepo ".git"))) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $RuntimeRepo) -Force | Out-Null
    & git clone --branch $BaseBranch --single-branch $remoteUrl $RuntimeRepo
    if ($LASTEXITCODE -ne 0) {
        throw "failed to clone runtime repository"
    }
}
$RuntimeRepo = (Resolve-Path -LiteralPath $RuntimeRepo).Path
$runtimeRemoteUrl = (& git -C $RuntimeRepo remote get-url origin | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or $runtimeRemoteUrl -ne $remoteUrl) {
    throw "runtime origin mismatch: expected=$remoteUrl actual=$runtimeRemoteUrl"
}
$updateScript = Join-Path $RuntimeRepo "skills\personal-skills-auto-update\scripts\update.ps1"
$bootstrapUpdateScript = Join-Path $PSScriptRoot "update.ps1"

# 3. runtime repoを最新化し、skill/agentの配布まで成功させる。
# ここで失敗した場合はTaskを登録せず、壊れた配布状態の自動再実行を防ぐ。
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $bootstrapUpdateScript -Repo $RuntimeRepo -BaseBranch $BaseBranch -AdoptRepoRoot $SourceRepo -TaskName $TaskName
if ($LASTEXITCODE -ne 0) {
    throw "initial runtime update failed with exit code $LASTEXITCODE"
}

# 4. 以後の更新に必要なruntime repoと開発checkoutの場所をTaskへ登録する。
# AdoptRepoRootは、旧agent Junctionがこの開発checkoutを指す場合だけ移行を許可するために使う。
$action = New-ScheduledTaskAction `
    -Execute (Join-Path $env:SystemRoot "System32\conhost.exe") `
    -Argument "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$updateScript`" -Repo `"$RuntimeRepo`" -BaseBranch `"$BaseBranch`" -TaskName `"$TaskName`" -AdoptRepoRoot `"$SourceRepo`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Safely fast-forward and install personal-skills" `
    -Force | Out-Null

# 5. 登録されたTaskの現在状態と次回実行時刻を表示する。
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object LastRunTime, LastTaskResult, NextRunTime
