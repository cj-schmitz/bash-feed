# bash-feed

A Claude Code mod that shows every Bash command Claude runs, with its output, in a separate Terminal window. Each session gets its own window. A short "teacher" explains each command's programs, flags and shell symbols as it runs.

- Every shell command Claude sends: Bash calls, Monitor watches, and subagents' commands (tagged `[monitor]` / `[subagent]`), plus Claude's file edits with their diffs (`✎ edited … +12 −3`)
- Each command opens with Claude's reason as a `# comment`, then a red `⚠` line if it can delete, overwrite, push or send data out
- Commands in syntax colours, long chains and loops laid out one step per line; a long command shows its first 5 lines, the rest behind a ⌘-click link
- Explanations from Haiku: one plain-English sentence in green, with the part-by-part breakdown behind a ⌘-click link (or shown in full: Explanation layout = expanded)
- Background commands and monitors stream their output (`┆`) as it arrives, until the task ends
- Output is cut at 20 screen rows (wrapped lines count); the rest is saved and linked: ⌘-click `▸ N more lines`
- Every step is numbered `§12`: press ⌘F in the window, type `§` (⌥6), Enter, then ⌘G / ⇧⌘G to jump to the next / previous step
- The window opens behind Claude when a session starts and closes when that session's Claude process exits

## Commands

`/bash-feed` alone opens a menu. Or pass one of:

- `on` / `off`: turn the feed on or off in every session (remembered)
- `settings`: change the settings below in four short dialogs (what's shown, explanations, output length, window and logs)
- `window`: reopen this session's window; `clear`: wipe it; `close`: close it; `pane`: open the in-chat pane instead
- `delete`: delete other sessions' logs and saved outputs; `delete all`: also empty this session's

## Settings

`/bash-feed settings`, or the bash-feed rows in `/config`:

| Setting | Default | |
| --- | --- | --- |
| Explanations | beginner | `beginner`, `intermediate` (skips basics), or `off` (no Haiku calls) |
| Explanation language | English | any language |
| Explanation layout | collapsed | `collapsed` (parts behind a link) or `expanded` |
| Show why line / plain-English line / risk warnings / file changes | on | each can be turned off |
| Command lines shown | 5 | lines of a long command before the ⌘-click link |
| Output rows per command | 20 | rows shown before the link |
| Diff rows per file change | 10 | rows shown before the link |
| Open window at session start | on | off: open it with `/bash-feed window` |
| Keep logs for (days) | 90 | 0 keeps them forever |

Logs and saved outputs live in `~/.claude/bash-feed/`.

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
