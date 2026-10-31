# bash-feed

A Claude Code mod that shows every Bash command Claude runs, with its output, in a separate Terminal window. Each session gets its own window. A short "teacher" explains each command's programs, flags and shell symbols as it runs.

- Every shell command Claude sends: Bash calls, Monitor watches, and subagents' commands (tagged `[monitor]` / `[subagent]`), plus Claude's file edits with their diffs (`✎ edited … +12 −3`)
- Each command opens with Claude's reason as a `# comment`, and ends with a red `⚠` line under the output if it can delete, overwrite, push or send data out
- Commands in syntax colours, long chains and loops laid out one step per line; a long command shows its first 5 lines, the rest behind a `▸` link
- Explanations from Haiku: one plain-English sentence in green, with the part-by-part breakdown behind a `▸` link (or shown in full: Explanation layout = expanded)
- Background commands and monitors stream their output (`┆`) as it arrives, until the task ends
- Output is cut at 20 screen rows (wrapped lines count); the rest is saved behind `▸ N more lines`
- Every step is numbered `§12`
- The window is interactive: click a `▸` line (or press Enter for the whole step) to expand it in place, click again to collapse; ↑ / ↓ jump between steps; wheel, PgUp / PgDn, j / k scroll; End goes back to live. Select text with ⌥-drag
- Window style = plain swaps in a plain `tail -F` log: native scrolling and selection, ⌘-click `▸` links to open the saved file, ⌘F `§` (⌥6) then ⌘G / ⇧⌘G to jump
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
| Show why line / snippet explainers / plain-English line / risk warnings | on | each can be turned off; with all three teacher lines off, no Haiku calls |
| Show command output / exit status / background output / file changes | on | each can be turned off |
| Command lines shown | 5 | lines of a long command before the `▸` link |
| Output rows per command | 20 | rows shown before the link |
| Diff rows per file change | 10 | rows shown before the link |
| Window style | interactive | `interactive` or `plain` (see above) |
| Open window at session start | on | off: open it with `/bash-feed window` |
| Keep logs for (days) | 90 | 0 keeps them forever |

Logs and saved outputs live in `~/.claude/bash-feed/`.

## Systems

Needs Python 3 (`python3`, or `py` on Windows).

- **macOS:** opens in Terminal.app. The first time, macOS may ask to let Claude Code control Terminal. Tested.
- **Linux:** opens in `$TERMINAL` if set, else the first found of x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, kitty, alacritty, wezterm, foot, tilix, xterm. Not yet tested.
- **Windows:** opens in Windows Terminal (`wt`), else a new console window. Not yet tested.

The window opens right next to Claude's window, on the same display: on its right if there is room, else its left, narrower to fit. On Linux this needs X11 and `wmctrl` or `xdotool` (Wayland does not let programs place windows, so the desktop decides there).

The window's program closes itself when the Claude session that opened it exits.

## Tokens

Explanations are written by Claude Haiku: about 600–1,600 tokens per new command (about 400 of instructions, the command itself, cut at 3,000 characters, and a reply of at most 400). A repeated command in the same session is not explained again. Explanations → Off, or turning off the snippet explainers, plain-English line and risk warnings, stops the calls.

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
