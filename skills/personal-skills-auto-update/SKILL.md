---
name: personal-skills-auto-update
description: personal-skills repositoryをWindowsとWSLの両方で安全に自動更新する。ローカルcheckoutが更新されない、Codexのskillやagent定義が古い、自動更新のsystemd user timerやWindows Task Schedulerを設定・確認したいときに使う。開発checkoutとは別のclean runtime cloneを更新し、fast-forwardできない、base branch以外、未コミット変更がある場合は更新せず診断する。
---

# Personal Skills Auto Update

開発checkoutとは別のclean runtime cloneをfast-forwardした後、既存のinstall scriptを実行してskillとagent定義を公開する。base branchへのローカル固有コミット、強制更新、stash、resetを行わない。

## One-shot更新

WSLでは次を実行する。

```bash
bash scripts/update.sh --repo /path/to/personal-skills
```

Windowsでは次を実行する。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\update.ps1 -Repo C:\path\to\personal-skills
```

更新前に、対象repo、現在のbranch、未コミット変更、`HEAD...origin/<base>`のahead/behindを確認する。base branch以外またはaheadがある場合は停止する。behindがある場合は`git merge --ff-only`を使い、未コミット変更と競合すればGitの拒否をそのまま失敗として報告する。

## 自動実行をinstallする

WSLではsystemd user timerを使う。

```bash
bash scripts/install-wsl.sh --source-repo /path/to/personal-skills
```

WindowsではTask Schedulerを使う。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -SourceRepo C:\path\to\personal-skills
```

どちらもOSごとのユーザーデータ領域へruntime cloneを作り、Codex/Claudeのskillリンクを開発checkoutからruntime cloneへ切り替える。15分間隔でone-shot更新を呼び、二重実行はlockで防ぐ。install後はtimerまたはtaskの実在、次回実行、直近結果を確認する。
WindowsのScheduled TaskはWindows標準の`conhost.exe --headless`でPowerShellを起動し、定期更新時にコンソールウィンドウを表示しない。PowerShellの終了コードはTask Schedulerへ返す。

## 結果の扱い

- `0`: 更新または最新状態の確認とinstallが成功
- `10`: 別プロセスが更新中
- `20`: base branch以外、未コミット変更、またはローカル固有コミットがあるため停止
- `21`: fast-forward失敗。未コミット変更との競合やremote状態を確認する
- `22`: install script失敗

自動更新失敗時にreset、stash、base branchへのcommitやpushを行わない。対象と状態を確認し、手動判断へ戻す。
