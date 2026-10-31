"""Everything the mod does outside itself, the same way on macOS, Linux and Windows.

Usage: feed.py <action> [args]
  probe                                    platform and feed folder, one per line
  append <log>                             stdin added to the log (folder made as needed)
  init <log>                               stdin written to the log unless it exists
  last-step <log>                          the highest §n in the log
  size <dir>                               the folder's size, e.g. 5.1M
  clean <dir> <days>                       logs and saved outputs older than <days> deleted
  delete <dir> <session-id> <all|others>   prints the folder's size before and after
  open <log> <short-id> <title> <interactive|plain> <keep-focus 0|1>
  close <log> <title>
  task <log> <task-id> <label> <cols>      streams a background task's output into the log
"""
import glob, os, re, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import WINDOWS, alive, claude_pid, detach  # noqa: E402

PY = [sys.executable or 'python3', '-I']


def human(size):
    for unit in ('B', 'K', 'M', 'G'):
        if size < 1024 or unit == 'G':
            return f'{size:.0f}{unit}' if unit == 'B' or size >= 10 else f'{size:.1f}{unit}'
        size /= 1024


def folder_size(path):
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def feed_files(path):
    """The feed's own files: session logs and saved outputs, never anything else."""
    found = [os.path.join(path, n) for n in os.listdir(path) if n.endswith('.log')] if os.path.isdir(path) else []
    out = os.path.join(path, 'out')
    if os.path.isdir(out):
        found += [os.path.join(out, n) for n in os.listdir(out) if n.endswith(('.txt', '.ans'))]
    return found


def window_pid(log):
    try:
        return int(open(log[:-4] + '.window').read().strip())
    except (OSError, ValueError):
        return 0


# Opening a window ---------------------------------------------------------------------

def apple(script, *args):
    subprocess.run(['osascript', '-e', script, *args], capture_output=True)


CLOSE_MAC = '''on run argv
tell application "Terminal"
  repeat with w in (get windows)
    try
      if custom title of selected tab of w is (item 1 of argv) then close w
    end try
  end repeat
end tell
end run'''


def quote_sh(text):
    return "'" + text.replace("'", "'\\''") + "'"


def open_mac(viewer, title, keep_focus):
    command = 'clear; ' + ' '.join(quote_sh(a) for a in viewer) + '; exit'
    apple('''on run argv
tell application "Terminal"
  set prevWin to missing value
  if (count of windows) > 0 then set prevWin to front window
  set custom title of (do script (item 1 of argv)) to (item 2 of argv)
  if (item 3 of argv) is "1" and prevWin is not missing value then
    set index of prevWin to 1
  else
    activate
  end if
end tell
end run''', command, title, '1' if keep_focus else '0')


# Terminal programs on Linux, tried in order: each as the arguments that run `viewer`
# titled `title`. $TERMINAL, when set, goes first, given `-e`.
LINUX = [
    ('x-terminal-emulator', lambda t, v: ['-T', t, '-e', *v]),
    ('gnome-terminal', lambda t, v: ['--title', t, '--', *v]),
    ('konsole', lambda t, v: ['-p', f'tabtitle={t}', '-e', *v]),
    ('xfce4-terminal', lambda t, v: ['--title', t, '-x', *v]),
    ('kitty', lambda t, v: ['--title', t, *v]),
    ('alacritty', lambda t, v: ['--title', t, '-e', *v]),
    ('wezterm', lambda t, v: ['start', '--', *v]),
    ('foot', lambda t, v: ['--title', t, *v]),
    ('tilix', lambda t, v: ['-t', t, '-e', ' '.join(quote_sh(a) for a in v)]),
    ('xterm', lambda t, v: ['-T', t, '-e', *v]),
]


def open_linux(viewer, title):
    choices = list(LINUX)
    chosen = os.environ.get('TERMINAL', '').strip()
    if chosen:
        choices.insert(0, (chosen, lambda t, v: ['-e', *v]))
    for program, args in choices:
        path = shutil.which(program)
        if path:
            detach([path, *args(title, viewer)])
            return True
    print('no terminal program found; set $TERMINAL to one', file=sys.stderr)
    return False


def open_windows(viewer, title):
    wt = shutil.which('wt') or shutil.which('wt.exe')
    if wt:
        detach([wt, '-w', 'new', 'new-tab', '--title', title, *viewer])
    else:
        subprocess.Popen(viewer, creationflags=0x00000010)  # CREATE_NEW_CONSOLE
    return True


def open_window(log, short, title, mode, keep_focus):
    # A reload or a second /bash-feed window: one window per session is enough.
    if alive(window_pid(log)):
        return
    viewer = [*PY, os.path.join(HERE, 'viewer.py'), log, short, '--pid', str(claude_pid()), '--title', title]
    if mode == 'plain':
        viewer.append('--plain')
    if sys.platform == 'darwin':
        open_mac(viewer, title, keep_focus)
    elif WINDOWS:
        open_windows(viewer, title)
    else:
        open_linux(viewer, title)


def close_window(log, title):
    pid = window_pid(log)
    if alive(pid):
        if WINDOWS:
            subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True)
        else:
            import signal
            os.kill(pid, signal.SIGTERM)
    try:
        os.remove(log[:-4] + '.window')
    except OSError:
        pass
    if sys.platform == 'darwin':
        # Terminal may keep a finished window open, depending on its profile.
        time.sleep(0.3)
        apple(CLOSE_MAC, title)


# Actions ------------------------------------------------------------------------------

def main(action, *args):
    if action == 'probe':
        print(sys.platform)
        print(os.path.join(os.path.expanduser('~'), '.claude', 'bash-feed').replace('\\', '/'))
    elif action == 'append':
        os.makedirs(os.path.dirname(args[0]), exist_ok=True)
        with open(args[0], 'a', encoding='utf-8', newline='\n') as f:
            f.write(sys.stdin.read())
    elif action == 'init':
        if not os.path.exists(args[0]):
            os.makedirs(os.path.dirname(args[0]), exist_ok=True)
            with open(args[0], 'w', encoding='utf-8', newline='\n') as f:
                f.write(sys.stdin.read())
    elif action == 'last-step':
        try:
            text = open(args[0], encoding='utf-8', errors='replace').read()
        except OSError:
            text = ''
        print(max((int(n) for n in re.findall(r'§(\d+)', text)), default=0))
    elif action == 'size':
        print(human(folder_size(args[0])))
    elif action == 'clean':
        cutoff = time.time() - int(args[1]) * 86400
        for path in feed_files(args[0]):
            try:
                if os.path.getmtime(path) < cutoff:
                    os.remove(path)
            except OSError:
                pass
    elif action == 'delete':
        folder, session, scope = args
        before = human(folder_size(folder))
        mine, short = f'{session}.log', session[:8] + '-'
        for path in feed_files(folder):
            name = os.path.basename(path)
            if name == mine:
                if scope == 'all':
                    # Emptied, not deleted, so its open window keeps following it.
                    open(path, 'w').close()
                continue
            if name.startswith(short) and scope != 'all':
                continue
            try:
                os.remove(path)
            except OSError:
                pass
        print(before, human(folder_size(folder)))
    elif action == 'open':
        log, short, title, mode, keep = args
        open_window(log, short, title, mode, keep == '1')
    elif action == 'close':
        close_window(*args)
    elif action == 'task':
        log, task, label, cols = args
        detach([*PY, os.path.join(HERE, 'tail-task.py'), task, log, label, str(claude_pid()), cols])
    else:
        sys.exit(f'unknown action {action}')


if __name__ == '__main__':
    main(*sys.argv[1:])
