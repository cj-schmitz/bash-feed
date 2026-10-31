"""The feed window's interactive viewer: follows a session's log like `tail -F`, and lets you
move around it.

Usage: viewer.py <log-file> <short-session-id> [--pid <claude-pid>] [--title <title>] [--plain]

With --plain it only prints the log as it grows, like `tail -F`. Either way it closes when
the Claude process <claude-pid> exits, writes its own pid beside the log (<log>.window, for
/bash-feed close) and its width (<log>.cols, which the mod wraps lines to).

  ↑ / ↓          previous / next step (§n); ↓ past the last goes back to live
  click, Enter   expand or collapse a ▸ line in place (Enter: every ▸ in the current step)
  wheel, j / k   scroll a line at a time (three for the wheel)
  PgUp / PgDn    scroll a page (also b / space)
  Home / End     top / back to live (also g / G; Esc, ⇧↓ or ⌥↓ for live)

A ▸ line links a saved file. Expanding shows the `.ans` file beside it (the hidden lines,
coloured, as the mod wrote them) or, without one, the `.txt` file itself.
"""
import os, re, signal, subprocess, sys, time, unicodedata
from urllib.parse import unquote

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import WINDOWS, alive, enable_vt, restore_input  # noqa: E402


def flag(name, default=''):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv[:-1] else default


LOG = sys.argv[1] if len(sys.argv) > 1 else ''
SESSION = sys.argv[2] if len(sys.argv) > 2 else ''
CLAUDE = int(flag('--pid', '0') or 0)
TITLE = flag('--title', 'Bash feed')
PLAIN = '--plain' in sys.argv
BASE = LOG[:-4] if LOG.endswith('.log') else LOG

SGR = re.compile(r'\x1b\[[0-9;]*m')
# Escape codes other than colours (cursor moves, clears) are dropped from log lines.
OTHER_CSI = re.compile(r'\x1b\[[0-9;?]*[A-Za-ln-z]')
CLEAR = '\x1b[2J'
LINK = re.compile(r'file://(\S+?)\.txt')
# The path part of a ▸ line, hidden on screen: the viewer opens the file itself.
LINK_TAIL = re.compile(r'\s*·\s*(?:⌘|ctrl)-click:(?:\x1b\[[0-9;]*m|\s)*(?:file://\S+)?')
STEP = re.compile(r'^§\d+ ')
MOUSE = re.compile(r'\x1b\[<(\d+);(\d+);(\d+)([Mm])')
OFF = '\x1b[0m'
FOCUS_BG = '\x1b[48;2;52;40;26m'
BAR_BG, BAR_FG, BAR_KEY = '\x1b[48;2;40;32;22m', '\x1b[38;2;179;164;141m', '\x1b[38;2;220;173;119m'
MAX_EXPAND = 3000


def visible(text):
    return SGR.sub('', text)


def display(line):
    """A log line as shown: a ▸ line without its path; a line that is only a path, nothing."""
    text = visible(line).strip()
    # Older logs wrapped a long path onto the next line, sometimes mid-path.
    if text.startswith('file://') or re.fullmatch(r'[\w%.~/-]*/[\w%.~/-]*\.txt', text):
        return None
    return LINK_TAIL.sub('', line)


def char_width(ch):
    if unicodedata.combining(ch):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1


def split_rows(line, cols):
    """A line as screen rows of at most `cols` columns, colours carried onto each row."""
    rows, current, width, colour = [], '', 0, ''
    for token in re.findall(r'\x1b\[[0-9;]*m|.', line):
        if token.startswith('\x1b'):
            current += token
            colour = '' if token == OFF else colour + token
            continue
        w = char_width(token)
        if width + w > cols:
            rows.append(current + OFF)
            current, width = colour, 0
        current += token
        width += w
    rows.append(current + OFF)
    return rows


# Colours as the mod writes them (hooks/register.tsx ANSI and SYNTAX).
C = {'say': '\x1b[3;92m', 'bad': '\x1b[1;31m', 'dim': '\x1b[2m', 'term': '\x1b[33m', 'add': '\x1b[32m', 'del': '\x1b[31m',
     'program': '\x1b[1;36m', 'flag': '\x1b[38;5;117m', 'string': '\x1b[38;5;114m', 'variable': '\x1b[38;5;176m',
     'operator': '\x1b[1;38;5;215m', 'keyword': '\x1b[38;5;215m', 'comment': '\x1b[2m', 'word': '\x1b[38;5;252m'}
KEYWORDS = {'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function'}
SHELL = re.compile(r"""(?P<space>\s+)|(?P<comment>(?<!\S)#.*)|(?P<string>'[^']*'?|"(?:\\.|[^"\\])*"?)"""
                   r"""|(?P<variable>\$\{[^}]*\}?|\$\(|\$\w+|`)|(?P<operator>&&|\|\||[|;&]|>>?|<<-?|<|\(|\))|(?P<word>[^\s'"$`|;&<>()]+)""")


def colour_shell(line, start=True):
    """One line of a shell command in the mod's syntax colours; answers (text, next is a program)."""
    out = []
    for m in SHELL.finditer(line):
        kind, text = m.lastgroup, m.group()
        if kind == 'word':
            if start and text in KEYWORDS:
                kind = 'keyword'
            elif start and '=' not in text:
                kind, start = 'program', False
            elif text.startswith('-'):
                kind = 'flag'
        elif kind == 'operator':
            start = text in ('&&', '||', '|', ';', '&', '(')
        if kind == 'space':
            out.append(text)
        else:
            out.append(C[kind] + text + OFF)
    return ''.join(out), start


def format_saved(base, text, shown_before):
    """A plain saved file as the viewer shows it expanded: coloured by what it holds."""
    lines = text.rstrip('\n').split('\n')
    if base.endswith('-explained'):
        out = []
        # The command (one or more lines) comes first, then a blank line, then the parts.
        lines = lines[lines.index('') + 1:] if '' in lines else lines
        for line in lines:
            if not line.strip() or line.startswith('$ '):
                continue
            if line.startswith('⚠') or line.startswith('→'):
                continue  # already shown above the link
            part, meaning = (re.split(r'\s{2,}', line, maxsplit=1) + [''])[:2]
            out.append(f'    {C["term"]}{part.ljust(14)}{OFF} {C["dim"]}{meaning.strip()}{OFF}')
        return out
    if base.endswith('-command'):
        out, start = [f'    {C["dim"]}the whole command:{OFF}'], True
        for line in lines:
            # One step per row: split before && / || / | (quotes kept whole by the tokenizer).
            pieces, current = [], ''
            for m in SHELL.finditer(line):
                if m.lastgroup == 'operator' and m.group() in ('&&', '||', '|') and current.strip():
                    pieces.append(current.strip())
                    current = ''
                current += m.group()
            pieces.append(current.strip())
            for n, piece in enumerate(p for p in pieces if p):
                coloured, start = colour_shell(piece, start)
                out.append(('      ' if n == 0 else '        ') + coloured)
        return out
    if lines and all(l[:1] in '+-' for l in lines if l):
        return [f'  {C["add"] if l.startswith("+") else C["del"]}{l}{OFF}' for l in lines]
    # Output: the lines already on screen above the link are skipped.
    seen = {re.sub(r'\s+', ' ', l).strip()[:30] for l in shown_before}
    skip = 0
    while skip < len(lines) and re.sub(r'\s+', ' ', lines[skip]).strip()[:30] in seen:
        skip += 1
    return ['  ' + l for l in lines[skip:]]


def wrap_rows(line, cols):
    """A line as screen rows, broken between words, rows after the first indented under it."""
    if len(visible(line)) <= cols:
        return [line]
    lead = len(visible(line)) - len(visible(line).lstrip(' '))
    indent = ' ' * min(lead + 2, cols // 2)
    rows, current, width, colour = [], '', 0, ''
    for token in re.findall(r'\x1b\[[0-9;]*m|[^\S\n]+|[^\s\x1b]+', line):
        if token.startswith('\x1b'):
            current += token
            colour = '' if token == OFF else colour + token
            continue
        w = sum(char_width(ch) for ch in token)
        if token.isspace():
            if width + w <= cols:
                current += token
                width += w
            continue
        if width + w > cols and width > len(indent):
            rows.append(current.rstrip() + OFF)
            current, width = indent + colour, len(indent)
        while width + w > cols:  # a word longer than the row
            room = cols - width
            current += token[:room]
            rows.append(current + OFF)
            token, w = token[room:], w - room
            current, width = indent + colour, len(indent)
        current += token
        width += w
    rows.append(current + OFF)
    return rows


class Feed:
    def __init__(self):
        self.lines = []          # the log's lines, colour codes kept
        self.expanded = {}       # line index -> the lines shown under it
        self.offset = 0          # bytes of the log read so far
        self.carry = ''
        self.top = 0             # first screen row shown
        self.live = True         # following the end of the log
        self.focus = None        # line index of the step ↑/↓ moved to
        self.unseen = 0          # lines added while not live
        self.cols, self.height = 80, 23
        self.rows, self.sources = [], []
        self.cache = {}          # (line index, cols) -> rows
        self.dirty = True

    # Reading the log --------------------------------------------------------------

    def banner(self):
        try:
            out = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'banner.py'), SESSION, 'plain' if PLAIN else 'interactive'],
                                 capture_output=True, text=True, timeout=5).stdout
            return out.split('\n')
        except Exception:
            return []

    def reset(self):
        self.lines, self.expanded, self.cache = self.banner(), {}, {}
        self.offset, self.carry, self.focus = 0, '', None

    def add(self, text):
        for raw in text.split('\n'):
            if CLEAR in raw:
                # /bash-feed clear: what came before is gone, as on a screen.
                self.lines, self.expanded, self.cache, self.focus = [], {}, {}, None
                raw = raw[raw.rindex(CLEAR) + len(CLEAR):]
            self.lines.append(OTHER_CSI.sub('', raw).replace('\r', ''))
            if not self.live:
                self.unseen += 1

    def poll(self):
        try:
            size = os.path.getsize(LOG)
        except OSError:
            return
        if size < self.offset:
            # The log was emptied or replaced: start again from its top.
            self.reset()
        if size == self.offset:
            return
        with open(LOG, 'rb') as f:
            f.seek(self.offset)
            chunk = f.read()
        self.offset += len(chunk)
        text = self.carry + chunk.decode('utf-8', errors='replace')
        text, _, self.carry = text.rpartition('\n')
        if text or _:
            self.add(text)
            self.dirty = True

    # Layout -----------------------------------------------------------------------

    def layout(self):
        rows, sources = [], []
        for i, line in enumerate(self.lines):
            shown = display(line)
            if shown is None:
                continue
            if i in self.expanded:
                shown = shown.replace('▸', '▾', 1)
            key = (i, self.cols, i in self.expanded, i == self.focus)
            if key not in self.cache:
                if i == self.focus:
                    shown = FOCUS_BG + shown.replace(OFF, OFF + FOCUS_BG)
                self.cache[key] = split_rows(shown, self.cols)
            for row in self.cache[key]:
                rows.append(row)
                sources.append(i)
            for extra in self.expanded.get(i, []):
                for row in wrap_rows(extra, self.cols):
                    rows.append(row)
                    sources.append(i)
        self.rows, self.sources = rows, sources
        last = max(0, len(rows) - self.height)
        if self.live:
            self.top, self.unseen = last, 0
        self.top = max(0, min(self.top, last))
        if self.top == last and self.focus is None:
            self.live, self.unseen = True, 0

    def steps(self):
        return [i for i, line in enumerate(self.lines) if STEP.match(visible(line))]

    def row_of(self, index):
        return self.sources.index(index) if index in self.sources else 0

    # Actions ----------------------------------------------------------------------

    def scroll(self, by):
        self.layout()
        self.top = max(0, self.top + by)
        self.live = False
        self.dirty = True

    def jump(self, direction):
        self.layout()
        steps = self.steps()
        if not steps:
            return
        current = self.focus
        if current is None:
            # From live, ↑ goes to the last step; ↓ stays live.
            target = steps[-1] if direction < 0 else None
        else:
            later = [s for s in steps if s > current]
            earlier = [s for s in steps if s < current]
            target = (earlier[-1] if earlier else current) if direction < 0 else (later[0] if later else None)
        if target is None:
            self.focus, self.live = None, True
        else:
            self.focus, self.live = target, False
            self.layout()
            self.top = max(0, self.row_of(target) - 1)
        self.cache = {k: v for k, v in self.cache.items() if not k[3]}
        self.dirty = True

    def link_at(self, index):
        """The ▸ line at or just above `index` and the saved file it links, or (None, None).
        A long path may have been wrapped onto the line after the ▸."""
        for anchor in (index, index - 1):
            if 0 <= anchor < len(self.lines) and '▸' in visible(self.lines[anchor]):
                joined = visible(self.lines[anchor]).rstrip()
                if anchor + 1 < len(self.lines):
                    joined += visible(self.lines[anchor + 1]).strip()
                match = LINK.search(joined)
                return (anchor, match) if match else (None, None)
        return None, None

    def toggle(self, index):
        index, match = self.link_at(index)
        if match is None:
            return False
        if index in self.expanded:
            del self.expanded[index]
        else:
            base = unquote(match.group(1))
            if re.match(r'/[A-Za-z]:', base):
                base = base[1:]  # file:///C:/… on Windows
            try:
                if os.path.exists(base + '.ans'):
                    extra = open(base + '.ans', errors='replace').read().rstrip('\n').split('\n')
                else:
                    above = [visible(l) for l in self.lines[max(0, index - 80):index]]
                    extra = format_saved(base, open(base + '.txt', errors='replace').read(), above)
            except OSError:
                extra = ['    \x1b[2m(the saved file is gone)\x1b[0m']
            if len(extra) > MAX_EXPAND:
                extra = extra[:MAX_EXPAND] + [f'    \x1b[2m… {len(extra) - MAX_EXPAND} more lines in the file\x1b[0m']
            self.expanded[index] = extra
        self.dirty = True
        return True

    def toggle_step(self):
        """Enter: every ▸ in the current step (or, live, the last step)."""
        steps = self.steps()
        start = self.focus if self.focus is not None else (steps[-1] if steps else 0)
        later = [s for s in steps if s > start]
        end = later[0] if later else len(self.lines)
        links = sorted({a for a in (self.link_at(i)[0] for i in range(start, end)) if a is not None})
        opening = any(i not in self.expanded for i in links)
        for i in links:
            if (i in self.expanded) != opening:
                self.toggle(i)

    def click(self, y):
        self.layout()
        row = self.top + y - 1
        if 0 <= row < len(self.sources):
            self.toggle(self.sources[row])

    # Drawing ----------------------------------------------------------------------

    def status(self):
        keys = [('↑↓', 'steps'), ('click ▸', 'expand'), ('wheel/PgUp/PgDn', 'scroll'), ('Esc/End', 'live'), ('⌥drag' if sys.platform == 'darwin' else '⇧drag', 'select')]
        left = '  '.join(f'{BAR_KEY}{k}{BAR_FG} {v}' for k, v in keys)
        right = 'LIVE' if self.live else (f'paused · {self.unseen} new' if self.unseen else 'paused')
        plain_left = '  '.join(f'{k} {v}' for k, v in keys)
        room = self.cols - len(right) - 3
        if len(plain_left) > room:
            left = f'{BAR_KEY}↑↓{BAR_FG} steps  {BAR_KEY}click ▸{BAR_FG} expand  {BAR_KEY}Esc{BAR_FG} live'
            plain_left = '↑↓ steps  click ▸ expand  Esc live'
        pad = max(1, self.cols - len(plain_left) - len(right) - 2)
        tone = BAR_KEY if self.live else BAR_FG
        return f'{BAR_BG}{BAR_FG} {left}{" " * pad}{tone}{right} {OFF}'

    def draw(self, out):
        self.layout()
        screen = ['\x1b[?25l']
        for y in range(self.height):
            row = self.rows[self.top + y] if self.top + y < len(self.rows) else ''
            screen.append(f'\x1b[{y + 1};1H\x1b[2K{row}')
        screen.append(f'\x1b[{self.height + 1};1H\x1b[2K{self.status()}')
        out.write(''.join(screen))
        out.flush()
        self.dirty = False


class Keys:
    """Raw keys and mouse codes from the terminal, on Unix or in a Windows console."""

    def __init__(self):
        if WINDOWS:
            import msvcrt
            self.msvcrt, self.saved = msvcrt, enable_vt()
        else:
            import termios, tty
            self.fd = sys.stdin.fileno()
            self.saved = termios.tcgetattr(self.fd)
            tty.setraw(self.fd)

    def read(self, timeout):
        """What was typed, waiting up to `timeout` seconds for the first of it."""
        if WINDOWS:
            end = time.time() + timeout
            while not self.msvcrt.kbhit():
                if time.time() >= end:
                    return ''
                time.sleep(0.02)
            chars = []
            while self.msvcrt.kbhit():
                chars.append(self.msvcrt.getwch())
            return ''.join(chars)
        import select
        if not select.select([self.fd], [], [], timeout)[0]:
            return ''
        return os.read(self.fd, 4096).decode('utf-8', errors='replace')

    def restore(self):
        if WINDOWS:
            restore_input(self.saved)
        else:
            import termios
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.saved)


def write_file(path, text):
    try:
        with open(path, 'w') as f:
            f.write(text)
    except OSError:
        pass


def remove_file(path):
    try:
        os.remove(path)
    except OSError:
        pass


def close_mac_window():
    """Terminal may keep a finished window open, depending on its profile: a moment after
    this exits, it is closed by its title."""
    if sys.platform != 'darwin':
        return
    script = ('on run argv\ntell application "Terminal"\nrepeat with w in (get windows)\ntry\n'
              'if custom title of selected tab of w is (item 1 of argv) then close w\nend try\n'
              'end repeat\nend tell\nend run')
    subprocess.Popen(['/bin/sh', '-c', 'sleep 0.4; osascript -e "$0" "$1"', script, TITLE],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def follow_plain(out):
    """--plain: the banner, then the log as it grows."""
    feed = Feed()
    out.write('\x1b[2J\x1b[H' + '\n'.join(feed.banner()))
    offset, checked = 0, 0
    while True:
        if time.time() - checked > 1:
            checked = time.time()
            if CLAUDE and not alive(CLAUDE):
                return
            write_file(BASE + '.cols', str(os.get_terminal_size(out.fileno()).columns))
        try:
            size = os.path.getsize(LOG)
        except OSError:
            size = 0
        if size < offset:
            offset = 0
        if size > offset:
            with open(LOG, 'rb') as f:
                f.seek(offset)
                chunk = f.read()
            offset += len(chunk)
            out.write(chunk.decode('utf-8', errors='replace'))
            out.flush()
        time.sleep(0.25)


def main():
    out = sys.stdout
    if WINDOWS:
        enable_vt()
        out.reconfigure(encoding='utf-8')
    out.write(f'\x1b]0;{TITLE}\x07')
    write_file(BASE + '.window', str(os.getpid()))

    def finish(*_):
        remove_file(BASE + '.window')
        close_mac_window()
        os._exit(0)

    for name in ('SIGTERM', 'SIGHUP'):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), finish)
    if PLAIN:
        try:
            follow_plain(out)
        except (KeyboardInterrupt, Exception):
            pass
        finish()

    feed = Feed()
    feed.reset()
    keys = Keys()
    state = {'size': None, 'checked': 0.0}

    def restore(*_):
        out.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l')
        out.flush()
        keys.restore()
        finish()

    for name in ('SIGTERM', 'SIGHUP'):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), restore)
    out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h')
    pending = ''
    try:
        while True:
            size = os.get_terminal_size(out.fileno())
            if size != state['size']:
                state['size'] = size
                feed.cols, feed.height = max(20, size.columns), max(3, size.lines - 1)
                feed.cache, feed.dirty = {}, True
                out.write('\x1b[2J')
                write_file(BASE + '.cols', str(feed.cols))
            if time.time() - state['checked'] > 1:
                state['checked'] = time.time()
                if CLAUDE and not alive(CLAUDE):
                    restore()
            feed.poll()
            if feed.dirty:
                feed.draw(out)
            got = keys.read(0.25)
            if not got:
                continue
            pending += got
            while pending:
                mouse = MOUSE.match(pending)
                if mouse:
                    button, y, kind = int(mouse.group(1)), int(mouse.group(3)), mouse.group(4)
                    pending = pending[mouse.end():]
                    if button == 64:
                        feed.scroll(-3)
                    elif button == 65:
                        feed.scroll(3)
                    elif button == 0 and kind == 'M' and y <= feed.height:
                        feed.click(y)
                    continue
                for seq, action in (
                    ('\x1b[A', lambda: feed.jump(-1)), ('\x1bOA', lambda: feed.jump(-1)),
                    ('\x1b[B', lambda: feed.jump(1)), ('\x1bOB', lambda: feed.jump(1)),
                    ('\x1b[5~', lambda: feed.scroll(-feed.height + 2)), ('\x1b[6~', lambda: feed.scroll(feed.height - 2)),
                    ('\x1b[H', lambda: feed.scroll(-10 ** 9)), ('\x1b[1~', lambda: feed.scroll(-10 ** 9)),
                    ('\x1b[F', lambda: feed.jump_live()), ('\x1b[4~', lambda: feed.jump_live()),
                    # Keyboards with no End key (Macs): ⇧↓, ⌥↓, ⌘↓ where the terminal passes it on.
                    ('\x1b[1;2B', lambda: feed.jump_live()), ('\x1b[1;3B', lambda: feed.jump_live()),
                    ('\x1b[1;9B', lambda: feed.jump_live()), ('\x1b\x1b[B', lambda: feed.jump_live()),
                ):
                    if pending.startswith(seq):
                        pending = pending[len(seq):]
                        action()
                        break
                else:
                    if pending.startswith('\x1b') and len(pending) < 6 and not pending.endswith(('~', 'M', 'm')):
                        # The rest of an escape sequence may still be on its way.
                        more = keys.read(0.05)
                        if more:
                            pending += more
                            continue
                        if pending == '\x1b':
                            feed.jump_live()  # Esc alone: back to live, for keyboards with no End key
                        pending = ''
                        break
                    key, pending = pending[0], pending[1:]
                    if key == '\x1b':
                        # An unknown sequence: drop it whole.
                        pending = re.sub(r'^\[[0-9;<]*[A-Za-z~]', '', pending)
                    elif key == '\x03':
                        restore()
                    elif key in ('\r', '\n'):
                        feed.toggle_step()
                    elif key == 'k':
                        feed.scroll(-1)
                    elif key == 'j':
                        feed.scroll(1)
                    elif key == 'b':
                        feed.scroll(-feed.height + 2)
                    elif key == ' ':
                        feed.scroll(feed.height - 2)
                    elif key == 'g':
                        feed.scroll(-10 ** 9)
                    elif key == 'G':
                        feed.jump_live()
            feed.draw(out)
    except Exception:
        restore()


def jump_live(self):
    self.focus, self.live = None, True
    self.cache = {k: v for k, v in self.cache.items() if not k[3]}
    self.dirty = True


Feed.jump_live = jump_live

if __name__ == '__main__':
    main()
