#!/bin/zsh
# Asks "How much did you make this week?" and sends the answer to the dashboard,
# which saves it to the most recent payday week (see fillPayFromLink in app.js).
#
# macOS runs this every day at 9 AM and every time you log in, through
# ~/Library/LaunchAgents/com.chadblincoe.budget-pay-reminder.plist (copy in this folder).
# It only asks while the latest payday is still unanswered: miss it on Friday and
# it asks the next time you're on the Mac. Once the next Friday arrives, the
# question (and your answer) is about that new week instead.

BROWSER="Safari" # the browser that holds your budget
APP_URL="https://blincoechad.github.io/MoneyTracker/" # the online version, which syncs
PAYDAY_WEEKDAY=5 # 0 = Sunday … 5 = Friday; keep the same as "Payday" in the dashboard
ANSWERED_FILE="$HOME/Library/Application Support/BudgetPayReminder/answered" # the payday last dealt with

# The most recent payday, today included (like 2026-10-09).
days_since=$(( ($(date +%w) - PAYDAY_WEEKDAY + 7) % 7 ))
payday=$(date -v-${days_since}d +%Y-%m-%d)

# Already answered (or skipped) for this payday: nothing to ask.
[[ -f $ANSWERED_FILE && $(<"$ANSWERED_FILE") == "$payday" ]] && exit 0
# A payday from last month can't be saved any more; the dashboard has closed that month.
[[ ${payday:0:7} == $(date +%Y-%m) ]] || exit 0

mark_answered() {
  mkdir -p "${ANSWERED_FILE:h}"
  print -r -- "$payday" > "$ANSWERED_FILE"
}

message="How much did you make this week? (payday $(date -v-${days_since}d '+%a, %b %-d'))"

while true; do
  # "Later" asks again the next time this runs. "Skip this week" stops asking until the next payday.
  answer=$(osascript - "$message" <<'APPLESCRIPT'
on run argv
  activate
  set reply to display dialog (item 1 of argv) default answer "" with title "Payday" buttons {"Skip this week", "Later", "Save"} default button "Save" cancel button "Later"
  if button returned of reply is "Skip this week" then return "skip"
  return text returned of reply
end run
APPLESCRIPT
  ) || exit 0

  if [[ $answer == skip ]]; then
    mark_answered
    exit 0
  fi

  amount=${answer//[\$, ]/}
  [[ $amount =~ '^[0-9]+(\.[0-9]{1,2})?$' ]] && break
  message="\"$answer\" isn't an amount. Type a number like 275 or 275.50."
done

mark_answered

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
