---
name: worktree-janitor
description: Git worktreeを定期監視し、マージ済みPRに対応するクリーンで非アクティブなworktreeとローカルブランチを二段階判定で安全に削除する。長時間開いたCodexセッション、残留worktree、マージ後のブランチ掃除、systemd timerによる自動cleanupを扱うときに使う。
---

# worktree-janitor

PRマージ後も残るworktreeを、SessionEndに依存せず定期的に掃除する。

## 原則

- 判定不能時は削除しない。
- `git worktree prune`だけでマージ済みworktreeが消えるとは扱わない。
- 初回検出では削除せずcandidateを記録し、猶予後に同じ状態を再検証する。
- dirty、detached、OPEN PR、PRなし、HEAD不一致、利用中cwd、保護ブランチ、keep marker付きは保持する。
- `git worktree remove`は`--force`なしで実行する。
- ローカルブランチはPRのhead OIDと一致した場合だけ削除する。

## 実行

1. 設定例をコピーして対象リポジトリを指定する。
2. まずdry-runする。
3. 出力された分類を確認する。
4. installerでuser systemd timerを有効化する。

```bash
python3 scripts/worktree_janitor.py \
  --config ~/.config/worktree-janitor/config.json \
  --state ~/.local/state/worktree-janitor/state.json

python3 scripts/install.py \
  --repo /path/to/repo \
  --interval 15min \
  --grace-seconds 3600
```

手動で状態遷移を進める場合だけ`--execute`を付ける。初回はcandidate記録、猶予後の再実行でcleanupとなる。

詳細な状態と安全条件は[workflow-contract.md](references/workflow-contract.md)を読む。

## 検証

```bash
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/worktree_janitor.py --config <config> --state <state>
```

systemd journalは次で確認する。

```bash
journalctl --user -u worktree-janitor.service
```
