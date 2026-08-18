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

function Remove-LinkOnly {
    param([System.IO.FileSystemInfo]$Item)
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

    $parent = Split-Path -Parent $Target
    New-Item -ItemType Directory -Path $parent -Force | Out-Null

    if (-not (Test-Path -LiteralPath $Target)) {
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
        return
    }

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

    $resolvedTarget = @($item.Target) -join ""
    $knownTargets = @((Join-Path $RepoRoot "agents"))
    if (-not [string]::IsNullOrWhiteSpace($AdoptRepoRoot)) {
        $knownTargets += Join-Path $AdoptRepoRoot "agents"
    }
    $isKnownTarget = $knownTargets | Where-Object { $_ -ieq $resolvedTarget }
    if ($null -eq $isKnownTarget) {
        throw "Refusing to write through an unmanaged Codex agent junction: $Target -> $resolvedTarget"
    }

    try {
        Remove-LinkOnly -Item $item
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
    } catch {
        if (-not (Test-Path -LiteralPath $Target)) {
            New-Item -ItemType Junction -Path $Target -Target $resolvedTarget | Out-Null
        }
        throw
    }

    return [pscustomobject]@{
        Target = $Target
        LinkTarget = $resolvedTarget
    }
}

function Restore-CodexAgentDirectory {
    param([pscustomobject]$Migration)

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
    New-Item -ItemType Junction -Path $Migration.Target -Target $Migration.LinkTarget | Out-Null
}

function Get-ExpectedAdoptTarget {
    param([string]$Source)
    if ([string]::IsNullOrWhiteSpace($adoptRepoRootPath)) {
        return ""
    }
    $relativeSource = $Source.Substring($repoRoot.Length).TrimStart([char[]]@('\', '/'))
    return Join-Path $adoptRepoRootPath $relativeSource
}

function Test-LinkMayBeReplaced {
    param([string]$Source, [string]$ResolvedTarget, [string]$Marker)
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
try {
    $migration = Ensure-CodexAgentDirectory -Target $codexAgentsTarget -RepoRoot $repoRoot -AdoptRepoRoot $adoptRepoRootPath
    if ($null -ne $migration) {
        Write-Output "[codex-agent] migrated: $codexAgentsTarget -> normal directory"
    }

    foreach ($target in $skillTargets) {
        Get-ChildItem (Join-Path $repoRoot "skills") -Directory | ForEach-Object {
            Set-ManagedDirectoryLink -Source $_.FullName -Target (Join-Path $target.Path $_.Name) -Label $target.Label
        }
    }

    Get-ChildItem (Join-Path $repoRoot "agents") -Filter "*.toml" -File | ForEach-Object {
        Set-ManagedFileLink -Source $_.FullName -Target (Join-Path $codexAgentsTarget $_.Name) -Label "codex-agent"
    }

    if ($script:InstallFailed) {
        throw "one or more managed links could not be installed"
    }
} catch {
    if ($null -ne $migration) {
        Restore-CodexAgentDirectory -Migration $migration
        Write-Warning "[codex-agent] restored: $codexAgentsTarget -> $($migration.LinkTarget)"
    }
    throw
}
