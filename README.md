# bash-feed

A Claude Code mod that shows every Bash command Claude runs, with its output, in a separate Terminal window. Each session gets its own window. A short "teacher" explains each command's programs, flags and shell symbols as it runs.

- Every shell command Claude sends: Bash calls, Monitor watches, and subagents' commands (tagged `[monitor]` / `[subagent]`), plus Claude's file edits with their diffs (`✎ edited … +12 −3`)
- Each command opens with Claude's reason as a `# comment`, and ends with a red `⚠` line under the output if it can delete, overwrite, push or send data out
- Commands in syntax colours, long chains and loops laid out one step per line; a long command shows its first 5 lines, the rest behind a `▸` link
- Explanations from Haiku: one plain-English sentence in green, with the part-by-part breakdown behind a `▸` link (or shown in full: Explanation layout = expanded)
- Background commands and monitors stream their output (`┆`) as it arrives, until the task ends
- Output is cut at 20 screen rows (wrapped lines count); the rest is saved behind `▸ N more lines`
- Every step is numbered `§12`
- The window is interactive: click a `▸` line (or press Enter for the whole step) to expand it in place, click again to collapse; ↑ / ↓ jump between steps; wheel, PgUp / PgDn, j / k scroll; Esc (or End, ⇧↓, ⌥↓, G) goes back to live. Select text with ⌥-drag
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

## What it reads, sends, runs and writes

**Reads.** Each shell command Claude runs (Bash and Monitor calls, from the main conversation and from subagents), Claude's one-line description of it, its output, and Claude's file edits (Edit, Write, NotebookEdit). It reads these to show them in the feed window.

**Sends.** Only the command's text, cut at 3,000 characters, goes out: to Claude Haiku, through Claude Code's own model call (`$.model.complete`), on the account you are already signed in with, to write the explanation. Output, file contents and the rest of the conversation are never sent anywhere. With Explanations off (or the snippet explainers, plain-English line and risk warnings all hidden) nothing is sent.

**Credentials.** The Haiku calls go through Claude Code with the sign-in it already has; the mod never reads, stores or sends a key, token or password of its own, and asks for none.

**Runs.** Python 3 (`/usr/bin/python3`, `python3`, `py -3` or `python`, whichever is found first) with the scripts in `bin/`:

- `feed.py`: writes the logs, opens and closes the window, cleans up old logs
- `viewer.py`: the program in the feed window
- `tail-task.py`: streams a background command's output into the log
- `place.py`: puts the window next to Claude's (Linux, Windows)
- `banner.py`: the header

Those scripts start these programs, each only for the reason given:

- `osascript` (macOS): open, place and close the Terminal window; read the screen's size
- a terminal program (Linux: `$TERMINAL`, x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, kitty, alacritty, wezterm, foot, tilix or xterm; Windows: `wt`): open the window
- `xdotool`, `wmctrl`, `xprop`, `xwininfo`, `xrandr` (Linux, if installed): find Claude's window and the screen, move the feed's window
- `ps` (macOS, Linux): find the Claude process, so the window closes when it exits
- `taskkill` (Windows): close the window on `/bash-feed close`

**Writes.** Only inside `~/.claude/bash-feed/`: one log per session (`<session>.log`), the window's process id and width beside it (`<session>.window`, `<session>.cols`), and saved full outputs in `out/`. It edits no build, start-up, settings or instructions file.

**Settings.** `/bash-feed settings` changes only the mod's own `/config` rows (`bash-feed.<setting>`). It sets no environment variables.

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

## License

MIT © 2026 cj-schmitz · [bizonmt.com](https://bizonmt.com). See [LICENSE](LICENSE).
