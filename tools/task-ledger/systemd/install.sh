#!/bin/bash
# Installs the 3-minute harness timer for this user. Run from inside herdr (it records the herdr socket and
# workspace that the harness opens tabs in). Undo: systemctl --user disable --now task-ledger.timer
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${HERDR_SOCKET_PATH:?herdr の中で流してください}" "${HERDR_WORKSPACE_ID:?herdr の中で流してください}"
mkdir -p ~/.config/task-ledger ~/.config/systemd/user
cat > ~/.config/task-ledger/env <<ENV
PATH=$(dirname "$(command -v node)"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
HERDR_SOCKET_PATH=$HERDR_SOCKET_PATH
HERDR_BIN_PATH=${HERDR_BIN_PATH:-$(command -v herdr)}
TASK_HERDR_WORKSPACE=$HERDR_WORKSPACE_ID
ENV
cp "$here/task-ledger.service" "$here/task-ledger.timer" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now task-ledger.timer
systemctl --user list-timers task-ledger.timer --no-pager
