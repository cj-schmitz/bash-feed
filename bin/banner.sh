#!/bin/sh
# The header a feed window prints when it opens, in BizonAg's colours.
# Usage: banner.sh <short-session-id>
t=$(printf '\033[38;5;173m')    # brand tan     #c08a4f
l=$(printf '\033[38;5;180m')    # light tan     #dcad77
c=$(printf '\033[38;5;230m')    # cream         #f4ede0
m=$(printf '\033[38;5;138m')    # muted         #b3a48d
b=$(printf '\033[1m')
o=$(printf '\033[0m')

printf '\n'
printf '%s            ▄▄██████▄▄                %s\n' "$t" "$o"
printf '%s      ▄▄▄▄████████████▄▄▄▄▄▄▄▄▄▄    %s  %s%sB I Z O N   A G%s\n' "$t" "$o" "$b" "$c" "$o"
printf '%s    ▄█▀ ▀███████████████████████▄   %s  %sBash feed: watch Claude work, learn the terminal%s\n' "$t" "$o" "$l" "$o"
printf '%s   ██ ● ▐██████████████████████████  %s\n' "$t" "$o"
printf '%s    ▀█▄▄█████▀▀▀▀▀▀▀▀▀▀▀▀██████▀▀    %s  %s$ command%s   %swhat Claude ran, with its reason as a # comment%s\n' "$t" "$o" "$c" "$o" "$m" "$o"
printf '%s      ▐█▌ ▐█▌            ▐█▌ ▐█▌     %s  %s→ summary%s   %swhat it does, in plain English%s\n' "$t" "$o" "$c" "$o" "$m" "$o"
printf '%s      ▀▀▀ ▀▀▀            ▀▀▀ ▀▀▀     %s  %s⚠ ✎ ┆%s       %srisky commands · file changes · background output%s\n' "$t" "$o" "$c" "$o" "$m" "$o"
printf '\n'
printf '  %sJump between steps%s  ⌘F, type § (⌥6), Enter, then ⌘G / ⇧⌘G\n' "$l" "$o"
printf '  %sMenu and settings%s   /bash-feed  ·  /config\n' "$l" "$o"
printf '  %s%s%s\n' "$m" "────────────────────────────────────────────────────────── session ${1:-} ──" "$o"
printf '\n'
