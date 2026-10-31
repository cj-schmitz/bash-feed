#!/bin/sh
# Closes one session's feed window once the Claude process that started it exits.
# Usage: close-on-exit.sh <session-id> <window-title>
id=$1 title=$2
dir="$HOME/.claude/bash-feed"
lock="$dir/$id.watch"

# The nearest ancestor named claude is the session's process; else the parent.
pid=$PPID p=$PPID
while [ "${p:-1}" -gt 1 ]; do
  case "$(ps -o comm= -p "$p")" in *claude*) pid=$p; break ;; esac
  p=$(ps -o ppid= -p "$p" | tr -d ' ')
done

# A reload runs this again: one watcher per session is enough.
if [ -f "$lock" ] && kill -0 "$(cat "$lock")" 2>/dev/null; then exit 0; fi

nohup sh -c '
  echo $$ > "$3"
  while kill -0 "$1" 2>/dev/null; do sleep 0.5; done
  pkill -f "[t]ail -n 300 -F .*bash-feed/$4.log"
  sleep 0.2
  osascript -e "tell application \"Terminal\"
  repeat with w in (get windows)
    try
      if custom title of selected tab of w is \"$2\" then close w
    end try
  end repeat
end tell"
  rm -f "$3"
' sh "$pid" "$title" "$lock" "$id" >/dev/null 2>&1 &
