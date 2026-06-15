#!/bin/bash
# retlaude install: launchd plist生成 + load + retlaudeコマンドのPATH設定案内

set -euo pipefail

LABEL="com.user.retlaude"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
POLL_SCRIPT="$SCRIPT_DIR/poll.sh"
CLI_SCRIPT="$SCRIPT_DIR/cli.sh"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/${LABEL}.plist"
LOG_DIR="$HOME/.cache/retlaude/logs"
LAUNCHD_OUT="$LOG_DIR/launchd.out"
LAUNCHD_ERR="$LOG_DIR/launchd.err"
BIN_LINK="$HOME/.local/bin/retlaude"

mkdir -p "$PLIST_DIR" "$LOG_DIR" "$(dirname "$BIN_LINK")"

# 1. plist生成
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${POLL_SCRIPT}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${LAUNCHD_OUT}</string>
  <key>StandardErrorPath</key>
  <string>${LAUNCHD_ERR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${HOME}/.local/bin:${HOME}/.npm-global/bin:${HOME}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
</dict>
</plist>
EOF

echo "✅ plist installed: $PLIST"

# 2. retlaudeコマンドのsymlink
if [[ ! -L "$BIN_LINK" ]] || [[ "$(readlink "$BIN_LINK")" != "$CLI_SCRIPT" ]]; then
  ln -sf "$CLI_SCRIPT" "$BIN_LINK"
  echo "✅ symlink created: $BIN_LINK -> $CLI_SCRIPT"
fi

# 3. PATH案内
if ! echo ":$PATH:" | grep -q ":$HOME/.local/bin:"; then
  echo ""
  echo "⚠️  ~/.local/bin が PATH に含まれていません。以下を ~/.zshrc に追加してください:"
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# 4. unload(既存) → load
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo ""
echo "🟢 retlaude daemon loaded"
echo ""
echo "確認:"
echo "  retlaude status"
echo "  retlaude logs -f"
