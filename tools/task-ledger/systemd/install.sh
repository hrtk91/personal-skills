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
# The dashboard has its own packages (10/29: 「専用に入れてよい」) and is served from its build.
( cd "$here/../web" && [ -d node_modules ] || npm install --no-audit --no-fund ) && ( cd "$here/../web" && npm run build )
cp "$here/task-ledger.service" "$here/task-ledger.timer" "$here/task-dashboard.service" "$here/task-ledger-retro.timer" ~/.config/systemd/user/
cp "$here/task-ledger-retro.service" ~/.config/systemd/user/task-ledger-retro.service
systemctl --user daemon-reload
systemctl --user enable --now task-ledger.timer task-dashboard.service task-ledger-retro.timer
systemctl --user list-timers task-ledger.timer task-ledger-retro.timer --no-pager
systemctl --user status task-dashboard.service --no-pager
