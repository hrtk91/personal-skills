[CmdletBinding()]
param(
    [string]$Repo = (Join-Path $HOME "repos\personal-skills"),
    [string]$Remote = "origin",
    [string]$BaseBranch = "main",
    [string]$AdoptRepoRoot = "",
    [string]$TaskName = "PersonalSkillsAutoUpdate",
    [switch]$SkipInstall,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$env:GIT_TERMINAL_PROMPT = "0"

function Invoke-Git {
    param([string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "SilentlyContinue"
        $output = & git -C $Repo @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
        throw ($output -join [Environment]::NewLine)
    }
    return $output
}

function Update-WindowsScheduledTaskAction {
    param(
        [string]$Repo,
        [string]$BaseBranch,
        [string]$TaskName
    )

    $updateScript = Join-Path $Repo "skills\personal-skills-auto-update\scripts\update.ps1"
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -TaskPath "\" -ErrorAction Stop
    } catch {
        if ($_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound) {
            Write-Warning "scheduled_task_status=skipped reason=query_failed task=$TaskName detail=$($_.Exception.Message)"
        }
        return
    }

    $actions = @($task.Actions)
    if ($actions.Count -ne 1) {
        Write-Warning "scheduled_task_status=skipped reason=unexpected_action_count task=$TaskName count=$($actions.Count)"
        return
    }

    $currentArguments = [string]$actions[0].Arguments
    $updateScriptArgument = "-File `"$updateScript`""
    $repoArgument = "-Repo `"$Repo`""
    if ($currentArguments.IndexOf($updateScriptArgument, [System.StringComparison]::OrdinalIgnoreCase) -lt 0 -or
        $currentArguments.IndexOf($repoArgument, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        Write-Warning "scheduled_task_status=skipped reason=target_mismatch task=$TaskName"
        return
    }

    $expectedExecute = Join-Path $env:SystemRoot "System32\conhost.exe"
    $expectedArguments = "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$updateScript`" -Repo `"$Repo`" -BaseBranch `"$BaseBranch`" -TaskName `"$TaskName`""
    if ([string]$actions[0].Execute -ieq $expectedExecute -and $currentArguments -eq $expectedArguments) {
        Write-Output "scheduled_task_status=ok task=$TaskName"
        return
    }

    try {
        $action = New-ScheduledTaskAction -Execute $expectedExecute -Argument $expectedArguments
        Set-ScheduledTask -TaskName $TaskName -TaskPath "\" -Action $action -ErrorAction Stop | Out-Null
        Write-Output "scheduled_task_status=updated task=$TaskName"
    } catch {
        Write-Warning "scheduled_task_status=skipped reason=update_failed task=$TaskName detail=$($_.Exception.Message)"
    }
}

$Repo = (Resolve-Path -LiteralPath $Repo).Path
$commonDir = (Invoke-Git @("rev-parse", "--path-format=absolute", "--git-common-dir") | Select-Object -Last 1).Trim()
$lockPath = Join-Path $commonDir "personal-skills-update.lock"
$lock = $null

try {
    try {
        $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    } catch [System.IO.IOException] {
        Write-Output "update_status=busy repo=$Repo"
        exit 10
    }

    $branchOutput = @(Invoke-Git @("branch", "--show-current"))
    $currentBranch = if ($branchOutput.Count -eq 0) { "" } else { ([string]$branchOutput[-1]).Trim() }
    if ($currentBranch -ne $BaseBranch) {
        $reportedBranch = if ([string]::IsNullOrWhiteSpace($currentBranch)) { "detached" } else { $currentBranch }
        [Console]::Error.WriteLine("update_status=blocked reason=branch current=$reportedBranch expected=$BaseBranch")
        exit 20
    }

    $statusOutput = @(Invoke-Git @("status", "--porcelain"))
    if ($statusOutput.Count -ne 0) {
        [Console]::Error.WriteLine("update_status=blocked reason=dirty_worktree")
        exit 20
    }

    Invoke-Git @("fetch", $Remote, $BaseBranch) | Out-Host
    $counts = ((Invoke-Git @("rev-list", "--left-right", "--count", "HEAD...$Remote/$BaseBranch") | Select-Object -Last 1).Trim() -split "\s+")
    $ahead = [int]$counts[0]
    $behind = [int]$counts[1]
    Write-Output "update_state repo=$Repo branch=$BaseBranch ahead=$ahead behind=$behind"

    if ($ahead -ne 0) {
        [Console]::Error.WriteLine("update_status=blocked reason=local_commits ahead=$ahead")
        exit 20
    }

    if ($DryRun) {
        Write-Output "update_status=dry_run behind=$behind"
        exit 0
    }

    if ($behind -ne 0) {
        try {
            Invoke-Git @("merge", "--ff-only", "$Remote/$BaseBranch") | Out-Host
        } catch {
            [Console]::Error.WriteLine("update_status=blocked reason=fast_forward_failed detail=$($_.Exception.Message)")
            exit 21
        }
    }

    if (-not $SkipInstall) {
        $installer = Join-Path $Repo "scripts\install-symlinks.ps1"
        $installerArguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $installer, "-RepoRoot", $Repo)
        if (-not [string]::IsNullOrWhiteSpace($AdoptRepoRoot)) {
            $installerArguments += @("-AdoptRepoRoot", $AdoptRepoRoot)
        }
        & powershell.exe @installerArguments
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine("update_status=failed reason=install")
            exit 22
        }

        Update-WindowsScheduledTaskAction -Repo $Repo -BaseBranch $BaseBranch -TaskName $TaskName
    }

    $head = (Invoke-Git @("rev-parse", "HEAD") | Select-Object -Last 1).Trim()
    Write-Output "update_status=ok head=$head"
} finally {
    if ($null -ne $lock) {
        $lock.Dispose()
    }
}
