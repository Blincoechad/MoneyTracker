#!/bin/zsh
# Asks "How much did you make this week?" and sends the answer to the dashboard,
# which saves it to the current payday week (see fillPayFromLink in app.js).
# macOS runs this every Friday at 9 AM through
# ~/Library/LaunchAgents/com.chadblincoe.budget-pay-reminder.plist (copy in this folder).

BROWSER="Safari" # the browser that holds your budget
APP_URL="https://blincoechad.github.io/MoneyTracker/" # the online version, which syncs
message="How much did you make this week?"

while true; do
  # Pressing Skip exits without saving anything.
  answer=$(osascript - "$message" <<'APPLESCRIPT'
on run argv
  activate
  text returned of (display dialog (item 1 of argv) default answer "" with title "Payday" buttons {"Skip", "Save"} default button "Save" cancel button "Skip")
end run
APPLESCRIPT
  ) || exit 0

  amount=${answer//[\$, ]/}
  [[ $amount =~ '^[0-9]+(\.[0-9]{1,2})?$' ]] && break
  message="\"$answer\" isn't an amount. Type a number like 275 or 275.50."
done

# Asking the browser directly (not `open -a`) keeps the ?pay= part intact.
# macOS asks once to allow controlling the browser.
osascript - "$BROWSER" "${APP_URL}?pay=$amount" <<'APPLESCRIPT'
on run argv
  tell application (item 1 of argv)
    activate
    open location (item 2 of argv)
  end tell
end run
APPLESCRIPT
