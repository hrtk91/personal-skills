---
name: fracta
description: "Fracta CLIでgit worktree + Lima VM + docker compose環境の作成/起動/停止/削除/状態確認/ポートフォワードを行う。トリガー例: 環境作って、環境構築、worktree作成、VM起動、port forward、fracta"
---

# Fracta CLI workflow

## Quick start

```bash
fracta ls
fracta add my-worktree -b main
fracta up my-worktree
fracta ps my-worktree
fracta ports my-worktree
fracta down my-worktree
```

## Core workflow

1. Inspect: `fracta ls` or `fracta ps [NAME]`
2. Create worktree (optional): `fracta add <NAME> [-b <BASE_BRANCH>]`
3. Start services: `fracta up [NAME]`
4. Check status/ports: `fracta ps [NAME]`, `fracta ports [NAME] [--short]`
5. Stop or remove: `fracta down [NAME] [--vm]`, `fracta remove [NAME] [--force]`

**Note**: ほとんどのコマンドで NAME は省略可能。省略時は現在のディレクトリの worktree が対象になる。

## Commands

### Worktree management
```bash
fracta add <NAME> [-b [BASE_BRANCH]]  # worktree + Lima VM を作成(-b省略時はHEADから)
fracta list                            # インスタンス一覧(エイリアス: fracta ls)
fracta ps [NAME]                       # 状態表示
fracta restart [NAME]                  # worktree を再起動
fracta remove [NAME] [--force]         # worktree + Lima VM を削除
fracta remove [NAME] --vm-only         # Lima VM のみ削除(worktree は残す)
fracta remove [NAME] --worktree-only   # worktree のみ削除(VM は残す)
```

### Compose control
```bash
fracta up [NAME]                       # docker compose を起動(VM停止中なら起動)
fracta up [NAME] --no-sync-images      # 事前のイメージ同期を無効化
fracta up [NAME] --vm-build-copy       # VM内のローカルコピーでcompose実行(ビルド高速化)
fracta down [NAME]                     # docker compose を停止
fracta down [NAME] --vm               # docker compose + Lima VM を停止
```

### VM direct control
```bash
fracta vm add [NAME]      # 現在のworktreeにLima VMを追加(fracta管理外のworktreeにも対応)
fracta vm start [NAME]    # Lima VM を起動(compose は起動しない)
fracta vm stop [NAME]     # Lima VM を停止(compose は停止しない)
fracta vm shell [NAME]    # Lima VM にシェル接続(compose は触らない)
fracta vm list            # VM 一覧を表示
fracta vm template        # デフォルトの Lima テンプレートを stdout に出力
```

### Shell access
```bash
fracta shell [NAME]                              # Lima VM にシェル接続
fracta shell [NAME] -- <COMMAND>...              # VM内でコマンド実行
fracta shell [NAME] --workdir /path -- <CMD>     # 作業ディレクトリ指定
fracta shell [NAME] --shell /bin/bash            # シェル指定
```

### Ports
```bash
fracta ports [NAME]           # 公開ポート一覧
fracta ports [NAME] --short   # 短い形式で表示
```

### SOCKS proxy and browser
```bash
fracta proxy [NAME]              # SOCKS5 proxy を開始(ポート自動割当)
fracta proxy [NAME] --port 1080  # ポート指定で開始
fracta unproxy [NAME]            # SOCKS5 proxy を停止
fracta proxies                   # アクティブな proxy 一覧
fracta open [NAME]               # Playwright ブラウザを起動(SOCKS5経由)
fracta open [NAME] --browser firefox --url http://localhost:12903  # ブラウザ・URL指定
fracta close [NAME]              # Playwright ブラウザを停止
```

## Proxy + Open workflow

1. `fracta proxy [NAME]` で SOCKS5 proxy を起動
2. `fracta open [NAME]` で Playwright ブラウザを起動
3. VM 内の Docker ポートにアクセス可能になる

**重要**: `fracta open` は VM 内の Docker ポート(例: `localhost:12903`)にアクセスする。`fracta ps [NAME]` でポート番号を確認すること。

## VM Provisioning

`fracta.toml` で VM 作成時のプロビジョニングスクリプトを指定できる。

```toml
# fracta.toml
vm_provision_scripts = [
  ".fracta/provision/base.sh",
  ".fracta/provision/docker.sh",
  ".fracta/provision/node.sh",
]
vm_provision_timeout = "20m0s"  # デフォルト: 20m（provision がある場合）
```

- スクリプトは Lima の provision セクションに組み込まれ、VM 作成時に自動実行
- ハッシュベースの冪等性マーカーで同じスクリプトは2回走らない
- DNS 待ちが自動で入るのでネットワーク不安定でも安全
- `FRACTA_VM_USER` 環境変数でVM内のユーザー名を参照可能

## Custom template

Lima テンプレートをカスタマイズできる。優先順:
1. `fracta.toml` の `vm_template` で指定したパス
2. `.fracta/lima-template.yaml`（worktree → main repo の順で探索）
3. 内蔵デフォルト

```bash
# デフォルトテンプレートを出力してカスタマイズの起点にする
fracta vm template > .fracta/lima-template.yaml
```

テンプレート内で使えるプレースホルダー: `{{WORKTREE_PATH}}`, `{{USER}}`, `{{CPUS}}`, `{{MEMORY}}`, `{{DISK}}`

provision スクリプトはカスタムテンプレートにも自動注入される。

## Image cache

`fracta up` は Docker イメージを `~/.fracta/cache/` に gzip 圧縮でキャッシュする。
- 2台目以降の VM では `docker save` をスキップしてキャッシュから直接 load するため高速
- image ID ベースなのでキャッシュが古くなる問題はない
- 7日超の未使用キャッシュは `fracta up` 時に自動削除

**重要**: VM にイメージを送る際は `fracta up` を使うこと。SSH で手動転送するよりキャッシュが効いて速い。

## Troubleshooting

### Proxy がすぐ死ぬ場合

`fracta proxy` が "started successfully" と出ても、プロセスがすぐ終了することがある。

**確認方法:**
```bash
fracta proxies  # "No active SOCKS5 proxies" と出たら死んでる
```

**手動で proxy を起動する:**
```bash
# Lima VM の SSH ポートを確認
limactl list | grep <NAME>
# 例: fracta-subagent  Running  127.0.0.1:56272 ...

# 手動で SOCKS proxy を起動
ssh -D 1080 -f -C -q -N -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -i ~/.lima/_config/user -p <SSH_PORT> lima@127.0.0.1

# Playwright を手動で起動(ポートは fracta ps で確認)
npx playwright open --proxy-server=socks5://localhost:1080 http://localhost:<DOCKER_PORT>
```

### Open で接続エラーが出る場合

`ERR_SOCKS_CONNECTION_FAILED` が出る場合、URL のポートが間違っている可能性がある。

1. `fracta ps [NAME]` で Docker のポートを確認
2. 正しいポート(例: `12903`)で Playwright を起動

## Operational notes

- Confirm the target worktree name before running `down` or `remove`.
- Use `ps` or `ports` without a name to act on the current worktree.
- `fracta vm` コマンドで compose を触らずに VM だけを操作できる。
