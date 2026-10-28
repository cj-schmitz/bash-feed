# bash-feed

A Claude Code mod that shows every Bash command Claude runs, with its output, in a separate Terminal window. Each session gets its own window. A short "teacher" explains each command's programs, flags and shell symbols as it runs.

- Command in blue, output in plain text, errors in red, exit status green or red
- Explanations from Haiku, in yellow with a dim meaning beside each part
- The window opens behind Claude when a session starts and closes when that session's Claude process exits
- Logs are kept in `~/.claude/bash-feed/` and deleted after 90 days
- `/bash-feed-window` reopens the window; `/bash-feed` opens an in-chat pane instead

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
