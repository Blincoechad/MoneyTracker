#!/bin/zsh
# Asks "How much did you make this week?" and sends the answer to the dashboard,
# which saves it to the current payday week (see fillPayFromLink in app.js).
# macOS runs this every Friday at 9 AM through
# ~/Library/LaunchAgents/com.chadblincoe.budget-pay-reminder.plist (copy in this folder).

BROWSER="Safari" # the browser that holds your budget
APP="$(cd "$(dirname "$0")/.." && pwd)/index.html"
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

# Not `open -a`: it drops the ?pay= part from file:// links. Asking the browser
# directly keeps it. macOS asks once to allow controlling the browser.
osascript - "$BROWSER" "file://${APP// /%20}?pay=$amount" <<'APPLESCRIPT'
on run argv
  tell application (item 1 of argv)
    activate
    open location (item 2 of argv)
  end tell
end run
APPLESCRIPT
