#!/bin/zsh
# Builds BudgetBackupMover.app and installs the agent that runs it whenever
# Downloads changes. Run again after moving this project folder.
set -e
TOOLS="$(cd "$(dirname "$0")" && pwd)"
APP="$TOOLS/BudgetBackupMover.app"
PLIST="$HOME/Library/LaunchAgents/com.chadblincoe.budget-backup-mover.plist"

sed "s|/[^\"]*/tools/move-backups.sh|$TOOLS/move-backups.sh|" "$TOOLS/BudgetBackupMover.applescript" > "$TOOLS/.mover.applescript"
rm -rf "$APP"
osacompile -o "$APP" "$TOOLS/.mover.applescript"
rm "$TOOLS/.mover.applescript"
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$APP/Contents/Info.plist" # no Dock icon
codesign --force --sign - "$APP"

sed "s|<string>/[^<]*BudgetBackupMover.app</string>|<string>$APP</string>|" "$TOOLS/com.chadblincoe.budget-backup-mover.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/com.chadblincoe.budget-backup-mover" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed. Approve the Downloads access prompt the first time it appears."
