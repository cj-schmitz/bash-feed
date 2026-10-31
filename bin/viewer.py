"""The feed window's interactive viewer: follows a session's log like `tail -F`, and lets you
move around it.

Usage: viewer.py <log-file> <short-session-id>

  ↑ / ↓          previous / next step (§n); ↓ past the last goes back to live
  click, Enter   expand or collapse a ▸ line in place (Enter: every ▸ in the current step)
  wheel, j / k   scroll a line at a time (three for the wheel)
  PgUp / PgDn    scroll a page (also b / space)
  Home / End     top / back to live (also g / G)

A ▸ line links a saved file. Expanding shows the `.ans` file beside it (the hidden lines,
coloured, as the mod wrote them) or, without one, the `.txt` file itself.
"""
import os, re, select, signal, subprocess, sys, termios, tty, unicodedata
from urllib.parse import unquote

LOG = sys.argv[1]
SESSION = sys.argv[2] if len(sys.argv) > 2 else ''
HERE = os.path.dirname(os.path.abspath(__file__))

SGR = re.compile(r'\x1b\[[0-9;]*m')
# Escape codes other than colours (cursor moves, clears) are dropped from log lines.
OTHER_CSI = re.compile(r'\x1b\[[0-9;?]*[A-Za-ln-z]')
CLEAR = '\x1b[2J'
LINK = re.compile(r'file://(\S+?)\.txt')
# The path part of a ▸ line, hidden on screen: the viewer opens the file itself.
LINK_TAIL = re.compile(r'\s*·\s*⌘-click:(?:\x1b\[[0-9;]*m|\s)*(?:file://\S+)?')
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
    if visible(line).strip().startswith('file://'):
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
            out = subprocess.run(['/usr/bin/python3', '-I', os.path.join(HERE, 'banner.py'), SESSION, 'interactive'],
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
                shown = line.replace('▸', '▾', 1)
            key = (i, self.cols, i in self.expanded, i == self.focus)
            if key not in self.cache:
                if i == self.focus:
                    shown = FOCUS_BG + shown.replace(OFF, OFF + FOCUS_BG)
                self.cache[key] = split_rows(shown, self.cols)
            for row in self.cache[key]:
                rows.append(row)
                sources.append(i)
            for extra in self.expanded.get(i, []):
                for row in split_rows(extra, self.cols):
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
                for j in (anchor, anchor + 1):
                    if j < len(self.lines):
                        match = LINK.search(visible(self.lines[j]))
                        if match:
                            return anchor, match
                return None, None
        return None, None

    def toggle(self, index):
        index, match = self.link_at(index)
        if match is None:
            return False
        if index in self.expanded:
            del self.expanded[index]
        else:
            base = unquote(match.group(1))
            try:
                if os.path.exists(base + '.ans'):
                    extra = open(base + '.ans', errors='replace').read().rstrip('\n').split('\n')
                else:
                    extra = ['    ' + l for l in open(base + '.txt', errors='replace').read().rstrip('\n').split('\n')]
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
        keys = [('↑↓', 'steps'), ('click ▸', 'expand'), ('wheel/PgUp/PgDn', 'scroll'), ('End', 'live'), ('⌥drag', 'select')]
        left = '  '.join(f'{BAR_KEY}{k}{BAR_FG} {v}' for k, v in keys)
        right = 'LIVE' if self.live else (f'paused · {self.unseen} new' if self.unseen else 'paused')
        plain_left = '  '.join(f'{k} {v}' for k, v in keys)
        room = self.cols - len(right) - 3
        if len(plain_left) > room:
            left = f'{BAR_KEY}↑↓{BAR_FG} steps  {BAR_KEY}click ▸{BAR_FG} expand  {BAR_KEY}End{BAR_FG} live'
            plain_left = '↑↓ steps  click ▸ expand  End live'
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


def main():
    feed = Feed()
    feed.reset()
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    out = sys.stdout
    state = {'resized': True}

    def restore(*_):
        out.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l')
        out.flush()
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        sys.exit(0)

    signal.signal(signal.SIGTERM, restore)
    signal.signal(signal.SIGHUP, restore)
    signal.signal(signal.SIGWINCH, lambda *_: state.update(resized=True))
    tty.setraw(fd)
    out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h')
    pending = ''
    try:
        while True:
            if state['resized']:
                size = os.get_terminal_size(out.fileno())
                feed.cols, feed.height = max(20, size.columns), max(3, size.lines - 1)
                feed.cache, feed.dirty, state['resized'] = {}, True, False
                out.write('\x1b[2J')
            feed.poll()
            if feed.dirty:
                feed.draw(out)
            ready, _, _ = select.select([fd], [], [], 0.25)
            if not ready:
                continue
            pending += os.read(fd, 4096).decode('utf-8', errors='replace')
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
                ):
                    if pending.startswith(seq):
                        pending = pending[len(seq):]
                        action()
                        break
                else:
                    if pending.startswith('\x1b') and len(pending) < 6 and not pending.endswith(('~', 'M', 'm')):
                        # The rest of an escape sequence has not arrived yet.
                        if not select.select([fd], [], [], 0.05)[0]:
                            pending = ''
                        break
                    key, pending = pending[0], pending[1:]
                    if key == '\x1b':
                        # An unknown sequence: drop it whole.
                        pending = re.sub(r'^\[[0-9;<]*[A-Za-z~]', '', pending)
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
