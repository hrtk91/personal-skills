[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [string]$CodexRoot = (Join-Path $HOME ".codex"),
    [string]$ClaudeRoot = (Join-Path $HOME ".claude"),
    [string]$AdoptRepoRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$RepoRoot = if ([string]::IsNullOrWhiteSpace($RepoRoot)) { Join-Path $PSScriptRoot ".." } else { $RepoRoot }
$repoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$adoptRepoRootPath = if ([string]::IsNullOrWhiteSpace($AdoptRepoRoot)) { "" } else { (Resolve-Path -LiteralPath $AdoptRepoRoot).Path }
$script:InstallFailed = $false

# 用語:
# - runtime repo: 定期更新専用のcleanなpersonal-skills clone。実際の配布元になる。
# - 開発checkout: 人が編集・commitするpersonal-skills repo。自動更新はここへ書き込まない。
# - Junction: あるフォルダを別フォルダへ転送するWindowsのリンク。
# - 管理マーカー: このinstallerが配布した対象だと記録する`.personal-skills-managed`ファイル。

function Remove-LinkOnly {
    param([System.IO.FileSystemInfo]$Item)

    # Junction/SymbolicLinkそのものだけを削除する。参照先のrepoやファイルは削除しない。
    if ($Item.PSIsContainer) {
        [System.IO.Directory]::Delete($Item.FullName)
    } else {
        [System.IO.File]::Delete($Item.FullName)
    }
}

function Ensure-CodexAgentDirectory {
    param(
        [string]$Target,
        [string]$RepoRoot,
        [string]$AdoptRepoRoot
    )

    # 保証:
    # - agent配布先は通常フォルダにする。Junction越しに開発checkoutへ書き込まない。
    # - 自動更新用repoまたは明示された開発repoを指す既知Junctionだけを移行する。
    # - 所有者を確認できないリンクや再解析ポイントは、agentを書き込む前に拒否する。
    #
    # 処理順:
    # 1. agent配布先がなければ通常フォルダとして作成する。
    # 2. 既存の配布先が安全な通常フォルダか、移行対象のJunctionかを判定する。
    # 3. Junctionの参照先がこのinstallerの管理対象かを確認する。
    # 4. 既知Junctionだけを通常フォルダへ置き換える。
    # 5. 後続処理が失敗したときに復元できるよう、元の参照先を返す。

    # 1. agent配布先がなければ通常フォルダとして作成する。
    $parent = Split-Path -Parent $Target
    New-Item -ItemType Directory -Path $parent -Force | Out-Null

    if (-not (Test-Path -LiteralPath $Target)) {
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
        return
    }

    # 2. 既存の配布先が安全な通常フォルダか、移行対象のJunctionかを判定する。
    $item = Get-Item -LiteralPath $Target -Force
    if ($null -eq $item.LinkType) {
        if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw "Codex agent target is not a normal directory: $Target"
        }
        return
    }

    if ($item.LinkType -ne "Junction") {
        throw "Codex agent target uses an unsupported link: $Target -> $(@($item.Target) -join '')"
    }

    # 3. Junctionの参照先がこのinstallerの管理対象かを確認する。
    $resolvedTarget = @($item.Target) -join ""
    $knownTargets = @((Join-Path $RepoRoot "agents"))
    if (-not [string]::IsNullOrWhiteSpace($AdoptRepoRoot)) {
        $knownTargets += Join-Path $AdoptRepoRoot "agents"
    }
    $isKnownTarget = $knownTargets | Where-Object { $_ -ieq $resolvedTarget }
    if ($null -eq $isKnownTarget) {
        throw "Refusing to write through an unmanaged Codex agent junction: $Target -> $resolvedTarget"
    }

    # 4. 既知Junctionだけを通常フォルダへ置き換える。
    # Junction削除直後の作成に失敗した場合は、この関数内で元のJunctionを戻す。
    try {
        Remove-LinkOnly -Item $item
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
    } catch {
        if (-not (Test-Path -LiteralPath $Target)) {
            New-Item -ItemType Junction -Path $Target -Target $resolvedTarget | Out-Null
        }
        throw
    }

    # 5. 後続処理が失敗したときに復元できるよう、元の参照先を返す。
    return [pscustomobject]@{
        Target = $Target
        LinkTarget = $resolvedTarget
    }
}

function Restore-CodexAgentDirectory {
    param([pscustomobject]$Migration)

    # 保証:
    # 移行後のskill/agent配布が失敗しても、Codexが参照していた元のagent Junctionを復元する。
    # installer以外が配布先を別種類のファイルやリンクへ変更した場合は、推測で削除せず停止する。
    #
    # 処理順:
    # 1. 移行後の通常フォルダがinstallerの想定どおりか確認して取り除く。
    # 2. 移行前に記録した参照先へJunctionを作り直す。

    # 1. 移行後の通常フォルダがinstallerの想定どおりか確認して取り除く。
    if (Test-Path -LiteralPath $Migration.Target) {
        $item = Get-Item -LiteralPath $Migration.Target -Force
        if ($item.LinkType -eq "Junction") {
            Remove-LinkOnly -Item $item
        } elseif ($null -eq $item.LinkType -and $item.PSIsContainer) {
            [System.IO.Directory]::Delete($item.FullName, $true)
        } else {
            throw "Cannot restore Codex agent junction because target changed: $($Migration.Target)"
        }
    }

    # 2. 移行前に記録した参照先へJunctionを作り直す。
    New-Item -ItemType Junction -Path $Migration.Target -Target $Migration.LinkTarget | Out-Null
}

function Get-ExpectedAdoptTarget {
    param([string]$Source)

    # runtime repo内の配布元と同じ相対位置を、移行前の開発checkout上で求める。
    # 旧リンクや管理マーカーがこの場所を指す場合だけ、runtime版への置換を許可する。
    if ([string]::IsNullOrWhiteSpace($adoptRepoRootPath)) {
        return ""
    }
    $relativeSource = $Source.Substring($repoRoot.Length).TrimStart([char[]]@('\', '/'))
    return Join-Path $adoptRepoRootPath $relativeSource
}

function Test-LinkMayBeReplaced {
    param([string]$Source, [string]$ResolvedTarget, [string]$Marker)

    # このinstaller自身が作成した印があるか、明示された開発checkoutを指す場合だけtrueを返す。
    # 所有元を説明できないリンクを勝手に置き換えないための共通判定。
    $markerSource = if (Test-Path -LiteralPath $Marker) { (Get-Content -LiteralPath $Marker -Raw).Trim() } else { "" }
    $expectedAdoptTarget = Get-ExpectedAdoptTarget -Source $Source
    if ($markerSource -ieq $Source) {
        return $true
    }
    if (-not [string]::IsNullOrWhiteSpace($expectedAdoptTarget)) {
        return $markerSource -ieq $expectedAdoptTarget -or $ResolvedTarget -ieq $expectedAdoptTarget
    }
    return $false
}

function Set-ManagedDirectoryLink {
    param([string]$Source, [string]$Target, [string]$Label)

    # skill用directory linkを公開する。
    # 通常フォルダや所有元不明のリンクが既にあれば上書きせず、install全体を失敗扱いにする。
    $parent = Split-Path -Parent $Target
    $marker = "$Target.personal-skills-managed"
    New-Item -ItemType Directory -Path $parent -Force | Out-Null

    if (Test-Path -LiteralPath $Target) {
        $item = Get-Item -LiteralPath $Target -Force
        $resolvedTarget = @($item.Target) -join ""
        if ($item.LinkType -eq "Junction" -and $resolvedTarget -ieq $Source) {
            Set-Content -LiteralPath $marker -Value $Source -Encoding UTF8
            Write-Output "[$Label] ok: $Target -> $Source"
            return
        }
        if ($null -eq $item.LinkType) {
            Write-Warning "[$Label] skip: $Target already exists and is not a link"
            $script:InstallFailed = $true
            return
        }
        if (-not (Test-LinkMayBeReplaced -Source $Source -ResolvedTarget $resolvedTarget -Marker $marker)) {
            Write-Warning "[$Label] skip: unmanaged link at $Target -> $resolvedTarget"
            $script:InstallFailed = $true
            return
        }
        Remove-LinkOnly -Item $item
    }

    New-Item -ItemType Junction -Path $Target -Target $Source | Out-Null
    Set-Content -LiteralPath $marker -Value $Source -Encoding UTF8
    Write-Output "[$Label] linked: $Target -> $Source"
}

function Set-ManagedFileLink {
    param([string]$Source, [string]$Target, [string]$Label)

    # agent用file linkを公開する。
    # SymbolicLinkを作れないWindows環境では同じ内容をコピーし、管理マーカーへ配布元を記録する。
    # 内容が異なるユーザー管理ファイルや所有元不明のリンクは上書きしない。
    $parent = Split-Path -Parent $Target
    $marker = "$Target.personal-skills-managed"
    New-Item -ItemType Directory -Path $parent -Force | Out-Null

    if (Test-Path -LiteralPath $Target) {
        $item = Get-Item -LiteralPath $Target -Force
        $resolvedTarget = @($item.Target) -join ""
        if ($item.LinkType -eq "SymbolicLink" -and $resolvedTarget -ieq $Source) {
            Set-Content -LiteralPath $marker -Value $Source -Encoding UTF8
            Write-Output "[$Label] ok: $Target -> $Source"
            return
        }
        if ($null -eq $item.LinkType) {
            $managedSource = if (Test-Path -LiteralPath $marker) { (Get-Content -LiteralPath $marker -Raw).Trim() } else { "" }
            $expectedAdoptTarget = Get-ExpectedAdoptTarget -Source $Source
            $sameContent = (Get-FileHash -LiteralPath $Source).Hash -eq (Get-FileHash -LiteralPath $Target).Hash
            $managedMarker = $managedSource -ieq $Source -or (-not [string]::IsNullOrWhiteSpace($expectedAdoptTarget) -and $managedSource -ieq $expectedAdoptTarget)
            if ($managedMarker -or $sameContent) {
                Copy-Item -LiteralPath $Source -Destination $Target -Force
                Set-Content -LiteralPath $marker -Value $Source -Encoding UTF8
                Write-Output "[$Label] copied: $Target <- $Source"
            } else {
                Write-Warning "[$Label] skip: unmanaged file differs at $Target"
                $script:InstallFailed = $true
            }
            return
        }
        if (-not (Test-LinkMayBeReplaced -Source $Source -ResolvedTarget $resolvedTarget -Marker $marker)) {
            Write-Warning "[$Label] skip: unmanaged link at $Target -> $resolvedTarget"
            $script:InstallFailed = $true
            return
        }
        Remove-LinkOnly -Item $item
    }

    try {
        New-Item -ItemType SymbolicLink -Path $Target -Target $Source | Out-Null
        Set-Content -LiteralPath $marker -Value $Source -Encoding UTF8
        Write-Output "[$Label] linked: $Target -> $Source"
    } catch [System.UnauthorizedAccessException] {
        Copy-Item -LiteralPath $Source -Destination $Target -Force
        Set-Content -LiteralPath $marker -Value $Source -Encoding UTF8
        Write-Output "[$Label] copied: $Target <- $Source"
    }
}

$skillTargets = @(
    @{ Path = (Join-Path $CodexRoot "skills"); Label = "codex" },
    @{ Path = (Join-Path $ClaudeRoot "skills"); Label = "claude" }
)

$codexAgentsTarget = Join-Path $CodexRoot "agents"
$migration = $null

# 全体の処理順:
# 1. agent配布先を検証し、既知の旧Junctionだけを通常フォルダへ移行する。
# 2. 自動更新用repoのskillをCodex/Claudeへ公開する。
# 3. 自動更新用repoのagentを、検証済みの通常フォルダへ公開する。
# 4. 競合で見送った項目があればinstall全体を失敗にする。
# 5. 1でJunctionを移行していた場合だけ、失敗時に元のJunctionへ戻す。
try {
    # 1. agent配布先を検証し、既知の旧Junctionだけを通常フォルダへ移行する。
    $migration = Ensure-CodexAgentDirectory -Target $codexAgentsTarget -RepoRoot $repoRoot -AdoptRepoRoot $adoptRepoRootPath
    if ($null -ne $migration) {
        Write-Output "[codex-agent] migrated: $codexAgentsTarget -> normal directory"
    }

    # 2. 自動更新用repoのskillをCodex/Claudeへ公開する。
    foreach ($target in $skillTargets) {
        Get-ChildItem (Join-Path $repoRoot "skills") -Directory | ForEach-Object {
            Set-ManagedDirectoryLink -Source $_.FullName -Target (Join-Path $target.Path $_.Name) -Label $target.Label
        }
    }

    # 3. 自動更新用repoのagentを、検証済みの通常フォルダへ公開する。
    Get-ChildItem (Join-Path $repoRoot "agents") -Filter "*.toml" -File | ForEach-Object {
        Set-ManagedFileLink -Source $_.FullName -Target (Join-Path $codexAgentsTarget $_.Name) -Label "codex-agent"
    }

    # 4. 競合で見送った項目があればinstall全体を失敗にする。
    if ($script:InstallFailed) {
        throw "one or more managed links could not be installed"
    }
} catch {
    # 5. 1でJunctionを移行していた場合だけ、失敗時に元のJunctionへ戻す。
    if ($null -ne $migration) {
        Restore-CodexAgentDirectory -Migration $migration
        Write-Warning "[codex-agent] restored: $codexAgentsTarget -> $($migration.LinkTarget)"
    }
    throw
}
