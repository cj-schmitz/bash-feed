# bash-feed

A Claude Code mod that shows every Bash command Claude runs, with its output, in a separate Terminal window. Each session gets its own window. A short "teacher" explains each command's programs, flags and shell symbols as it runs.

- Every shell command Claude sends: Bash calls, Monitor watches, and subagents' commands (tagged `[monitor]` / `[subagent]`)
- Command in blue, output in plain text, errors in red, exit status green or red
- Explanations from Haiku: each part in yellow with a dim meaning, then one plain-English sentence in green
- Background commands and monitors stream their output (`┆`) as it arrives, until the task ends
- Output is cut at 20 screen rows (wrapped lines count); the rest is saved and linked: ⌘-click `▸ N more lines`
- The window opens behind Claude when a session starts and closes when that session's Claude process exits
- `/bash-feed-window` reopens the window; `/bash-feed` opens an in-chat pane instead

## Logs and settings

Logs and saved outputs live in `~/.claude/bash-feed/`.

- **Keep logs for (days)**: the bash-feed row in `/config`. Default 90; 0 keeps them forever. Older files are deleted when a session starts.
- `/bash-feed-clear` deletes other sessions' logs and outputs; `/bash-feed-clear all` also empties this session's.

macOS and Terminal.app only. The first time, macOS may ask to let Claude Code control Terminal.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install bash-feed --marketplace cj-schmitz/bash-feed
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install bash-feed --marketplace cj-schmitz/bash-feed
```

This repository is private: installing needs read access on GitHub and a git credential for github.com on your machine (an SSH key, or `gh auth login` then `gh auth setup-git`).
