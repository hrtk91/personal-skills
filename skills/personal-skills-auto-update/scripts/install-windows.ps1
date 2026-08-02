[CmdletBinding()]
param(
    [string]$SourceRepo = (Join-Path $HOME "repos\personal-skills"),
    [string]$RuntimeRepo = (Join-Path $env:LOCALAPPDATA "personal-skills-runtime"),
    [string]$BaseBranch = "main",
    [string]$TaskName = "PersonalSkillsAutoUpdate"
)

$ErrorActionPreference = "Stop"
$SourceRepo = (Resolve-Path -LiteralPath $SourceRepo).Path
$remoteUrl = (& git -C $SourceRepo remote get-url origin | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "cannot resolve origin URL from $SourceRepo"
}

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

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $bootstrapUpdateScript -Repo $RuntimeRepo -BaseBranch $BaseBranch -AdoptRepoRoot $SourceRepo
if ($LASTEXITCODE -ne 0) {
    throw "initial runtime update failed with exit code $LASTEXITCODE"
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$updateScript`" -Repo `"$RuntimeRepo`" -BaseBranch `"$BaseBranch`""
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

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object LastRunTime, LastTaskResult, NextRunTime
