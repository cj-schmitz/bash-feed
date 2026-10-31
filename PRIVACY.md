# Privacy

bash-feed runs on your computer, inside Claude Code. It has no server, no account and no analytics, and its author receives nothing from it.

## What leaves your computer

Only the text of each shell command Claude runs, cut at 3,000 characters, sent to Claude Haiku through Claude Code's own model call, on the Claude account you are already signed in with, so that Haiku can write the command's explanation. That request is handled under your existing agreement with Anthropic, like the rest of your Claude Code use.

Nothing is sent when explanations are off (`/bash-feed settings` → Explanations → Off), or when the snippet explainers, plain-English line and risk warnings are all hidden.

Command output, file contents, file edits and the rest of your conversation are never sent anywhere.

## What stays on your computer

- `~/.claude/bash-feed/<session>.log`: each session's feed: the commands, Claude's reason for each, their output, explanations and file edits
- `~/.claude/bash-feed/out/`: full outputs too long for the window
- `~/.claude/bash-feed/<session>.window` and `.cols`: the feed window's process id and width

These are deleted after 90 days by default (`/bash-feed settings` → Window and logs → How long to keep logs). `/bash-feed delete` deletes them now. Logs can hold anything a command printed, secrets included, so treat the folder like your shell history.

## Credentials

bash-feed reads, stores and sends no key, token or password. Haiku calls use the sign-in Claude Code already has.

## Contact

Questions or problems: https://github.com/cj-schmitz/bash-feed/issues
