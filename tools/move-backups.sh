#!/bin/zsh
# Moves budget backups (budget-backup-….json) from Downloads into this
# project's backups/ folder. macOS runs this whenever Downloads changes, through
# BudgetBackupMover.app, opened by ~/Library/LaunchAgents/com.chadblincoe.budget-backup-mover.plist.
# Set it up with tools/install-backup-mover.sh.

DEST="$(cd "$(dirname "$0")/.." && pwd)/backups"
mkdir -p "$DEST"
setopt null_glob

sleep 2 # give Safari a moment to finish writing the file
for file in "$HOME"/Downloads/budget-backup-*.json; do
  mv -f "$file" "$DEST/"
done
