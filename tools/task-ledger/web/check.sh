#!/bin/bash
# The dashboard's check. A worker's copy or the harness's throwaway copy has no packages; rather than
# installing them again each time (167 packages written to the SSD per check), point at the ones already
# installed in the main checkout. The link is ignored by git (.gitignore).
set -euo pipefail
cd "$(dirname "$0")"
main=${TASK_DASHBOARD_MODULES:-$HOME/repos/personal-skills/tools/task-ledger/web/node_modules}
if [ ! -e node_modules ]; then
  if [ -d "$main" ]; then
    ln -s "$main" node_modules
  else
    echo "部品がコピーにも本体にもありません。web/package-lock.json に沿って npm ci します。" >&2
    npm ci
  fi
fi
npm run typecheck
npm run build
npm test
