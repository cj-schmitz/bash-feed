#!/bin/sh
# Starts a detached watcher that streams a background task's output into the feed log.
# Usage: tail-task.sh <session-id> <task-id> <label>
here=$(cd "$(dirname "$0")" && pwd)
log="$HOME/.claude/bash-feed/$1.log"

# The nearest ancestor named claude is the session's process; else the parent.
pid=$PPID p=$PPID
while [ "${p:-1}" -gt 1 ]; do
  case "$(ps -o comm= -p "$p")" in *claude*) pid=$p; break ;; esac
  p=$(ps -o ppid= -p "$p" | tr -d ' ')
done

nohup /usr/bin/python3 -I "$here/tail-task.py" "$2" "$log" "$3" "$pid" >/dev/null 2>&1 &
