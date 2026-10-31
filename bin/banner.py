"""The header a feed window prints when it opens: a bison and a short intro, in BizonAg's colours.

Usage: banner.py <short-session-id>
The bison is drawn with coloured spaces (two per pixel), which fill the whole cell in
Terminal; block characters would leave gaps between rows.
"""
import sys

BISON = [
    "..........ddddd...............",
    ".......ddddddddddd............",
    ".....dddddddddddddddd.........",
    "....dddddddddddddddddbbb......",
    "..h.ddddddddddddddddbbbbbbbb..",
    "..hdddddddddddddddddbbbbbbbbbt",
    ".hddddddddddddddddddbbbbbbbbbt",
    "ddeddddddddddddddddbbbbbbbbbb.",
    "dddddddddddddddddbbbbbbbbbbbb.",
    ".ddddddddddddddddbbbbbbbbbbb..",
    "..ddd..ddddd.dd........bb.bb..",
    "...d....dd..dd.........bb.bb..",
    "........kk..kk.........kk.kk..",
]
# BizonAg: brand #c08a4f, brand-light #dcad77, brand-dark (mane), text #f4ede0, muted #b3a48d.
PIXEL = {'d': (110, 70, 34), 't': (110, 70, 34), 'b': (192, 138, 79), 'h': (244, 237, 224), 'e': (20, 16, 11), 'k': (56, 45, 32)}
BRAND, LIGHT, CREAM, MUTED = (192, 138, 79), (220, 173, 119), (244, 237, 224), (179, 164, 141)
OFF, BOLD = '\x1b[0m', '\x1b[1m'


def fg(rgb):
    return f'\x1b[38;2;{rgb[0]};{rgb[1]};{rgb[2]}m'


def bg(rgb):
    return f'\x1b[48;2;{rgb[0]};{rgb[1]};{rgb[2]}m'


session = sys.argv[1] if len(sys.argv) > 1 else ''
interactive = 'plain' not in sys.argv[2:]
MAC = sys.platform == 'darwin'
JUMP = '⌘F, type § (⌥6), Enter, then ⌘G / ⇧⌘G' if MAC else "your terminal's Find: search for §"
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
out = ['']
for row in BISON:
    out.append('  ' + ''.join(f'{bg(PIXEL[ch])}  {OFF}' if ch in PIXEL else '  ' for ch in row))
out += [
    '',
    f'  {BOLD}{fg(CREAM)}B I Z O N   A G{OFF}   {fg(BRAND)}·   B A S H   F E E D{OFF}',
    f'  {fg(LIGHT)}Watch Claude work. Learn the terminal.{OFF}',
    '',
    f'  {fg(CREAM)}$ command{OFF}   {fg(MUTED)}what Claude ran, with its # reason above{OFF}',
    f'  {fg(CREAM)}→ summary{OFF}   {fg(MUTED)}what it does, in plain English{OFF}',
    f'  {fg(CREAM)}⚠  ✎  ┆{OFF}     {fg(MUTED)}risks · file changes · background output{OFF}',
    '',
    (f'  {fg(LIGHT)}Move{OFF}        {fg(MUTED)}↑ ↓ steps · click ▸ to expand · End back to live{OFF}' if interactive else
     f'  {fg(LIGHT)}Jump{OFF}        {fg(MUTED)}{JUMP}{OFF}'),
    f'  {fg(LIGHT)}Menu{OFF}        {fg(MUTED)}/bash-feed{OFF}      {fg(LIGHT)}Settings{OFF}   {fg(MUTED)}/bash-feed settings{OFF}',
    '',
    f'  {fg(LIGHT)}Tokens{OFF}      {fg(MUTED)}Explanations use Claude Haiku: about 600–1,600 tokens{OFF}',
    f'              {fg(MUTED)}per new command (repeats are free). Turn them off in{OFF}',
    f'              {fg(MUTED)}/bash-feed settings → Explanations → Off.{OFF}',
    '',
    f'  {fg(MUTED)}© 2026 cj-schmitz · MIT License · bizonmt.com{OFF}',
    f'  {fg(BRAND)}{"─" * 40} session {session} ──{OFF}',
    '',
]
print('\n'.join(out))
