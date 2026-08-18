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
        [string]$TaskName,
        [string]$AdoptRepoRoot
    )

    # 保証:
    # - このruntime repoのupdate.ps1を実行する既存Taskだけを更新する。
    # - 同名でも別repoを指すTaskや、複数Actionを持つTaskには触らない。
    # - AdoptRepoRootを次回以降にも渡し、旧agent Junctionの所有元を判定できる状態を保つ。
    # ここでTaskはWindowsの定期実行設定、ActionはそのTaskが実行するコマンドを指す。
    #
    # 処理順:
    # 1. 対象Taskを取得する。存在しない場合は初回install側の登録に任せる。
    # 2. Actionが1件だけであることを確認する。
    # 3. 既存Actionがこのruntime repoを指していることを確認する。
    # 4. 現在必要な引数を含むActionを組み立て、同じなら変更しない。
    # 5. このTaskのActionだけを更新する。

    # 1. 対象Taskを取得する。存在しない場合は初回install側の登録に任せる。
    $updateScript = Join-Path $Repo "skills\personal-skills-auto-update\scripts\update.ps1"
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -TaskPath "\" -ErrorAction Stop
    } catch {
        if ($_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound) {
            Write-Warning "scheduled_task_status=skipped reason=query_failed task=$TaskName detail=$($_.Exception.Message)"
        }
        return
    }

    # 2. Actionが1件だけであることを確認する。
    $actions = @($task.Actions)
    if ($actions.Count -ne 1) {
        Write-Warning "scheduled_task_status=skipped reason=unexpected_action_count task=$TaskName count=$($actions.Count)"
        return
    }

    # 3. 既存Actionがこのruntime repoを指していることを確認する。
    $currentArguments = [string]$actions[0].Arguments
    $updateScriptArgument = "-File `"$updateScript`""
    $repoArgument = "-Repo `"$Repo`""
    if ($currentArguments.IndexOf($updateScriptArgument, [System.StringComparison]::OrdinalIgnoreCase) -lt 0 -or
        $currentArguments.IndexOf($repoArgument, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        Write-Warning "scheduled_task_status=skipped reason=target_mismatch task=$TaskName"
        return
    }

    # 4. 現在必要な引数を含むActionを組み立て、同じなら変更しない。
    # AdoptRepoRootは「どの開発checkoutなら旧Junctionとして移行してよいか」をinstallerへ伝える。
    $expectedExecute = Join-Path $env:SystemRoot "System32\conhost.exe"
    $adoptArgument = if ([string]::IsNullOrWhiteSpace($AdoptRepoRoot)) { "" } else { " -AdoptRepoRoot `"$AdoptRepoRoot`"" }
    $expectedArguments = "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$updateScript`" -Repo `"$Repo`" -BaseBranch `"$BaseBranch`" -TaskName `"$TaskName`"$adoptArgument"
    if ([string]$actions[0].Execute -ieq $expectedExecute -and $currentArguments -eq $expectedArguments) {
        Write-Output "scheduled_task_status=ok task=$TaskName"
        return
    }

    # 5. このTaskのActionだけを更新する。
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
        # 更新済みruntime repoからskill/agentを公開する。
        # AdoptRepoRootを渡すことで、開発checkoutを指す旧agent Junctionだけを安全に移行できる。
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

        # 次回の定期更新でも同じ所有元判定を行えるよう、TaskのActionにもAdoptRepoRootを残す。
        Update-WindowsScheduledTaskAction -Repo $Repo -BaseBranch $BaseBranch -TaskName $TaskName -AdoptRepoRoot $AdoptRepoRoot
    }

    $head = (Invoke-Git @("rev-parse", "HEAD") | Select-Object -Last 1).Trim()
    Write-Output "update_status=ok head=$head"
} finally {
    if ($null -ne $lock) {
        $lock.Dispose()
    }
}
