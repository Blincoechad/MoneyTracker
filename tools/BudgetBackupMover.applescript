-- A tiny app wrapper around move-backups.sh. macOS only lets an app (not a plain
-- script) ask for access to Downloads, so launchd opens this app instead.
-- Rebuild after editing:  see tools/install-backup-mover.sh
on run
	do shell script "/bin/zsh " & quoted form of "/Users/chadblincoe/DesktopFolders/Programs/MyBudgetDash/tools/move-backups.sh"
end run
