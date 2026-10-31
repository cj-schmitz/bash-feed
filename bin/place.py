"""Puts the feed window right next to Claude's window on Linux (X11) and Windows. macOS does
the same in feed.py's AppleScript.

feed.py calls `active()` before it opens the window (Claude's window is then in front), then
starts this script detached: `place.py <title> <keep-focus 0|1> <json from active()>`. It
waits for a window with that title, moves it beside Claude's and gives the focus back.

Linux needs X11 and wmctrl or xdotool; under Wayland programs may not place windows, so the
desktop decides. Every failure here leaves the window wherever it opened.
"""
import json, os, re, shutil, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import WINDOWS  # noqa: E402

WIDTH, MIN_WIDTH, GAP = 720, 480, 6


def beside(window, screen, scale=1.0):
    """Where the feed goes: right of `window` if there is room, else left; narrower to fit;
    else along the screen's right edge. Rectangles are left, top, right, bottom."""
    l, t, r, b = window
    sl, st, sr, sb = screen
    width, least, gap = int(WIDTH * scale), int(MIN_WIDTH * scale), int(GAP * scale)
    right, left = sr - r - gap, l - sl - gap
    top, bottom = max(t, st), min(b, sb)
    if right >= width:
        return r + gap, top, r + gap + width, bottom
    if left >= width:
        return l - gap - width, top, l - gap, bottom
    if right >= least and right >= left:
        return r + gap, top, sr, bottom
    if left >= least:
        return sl, top, l - gap, bottom
    return sr - width, top, sr, bottom


def run(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return ''


# Linux (X11) -----------------------------------------------------------------------------

def linux_active():
    if not os.environ.get('DISPLAY'):
        return None
    if shutil.which('xdotool'):
        wid = run('xdotool', 'getactivewindow').strip()
        geo = dict(re.findall(r'(\w+)=(\d+)', run('xdotool', 'getwindowgeometry', '--shell', wid))) if wid else {}
        if {'X', 'Y', 'WIDTH', 'HEIGHT'} <= geo.keys():
            x, y, w, h = (int(geo[k]) for k in ('X', 'Y', 'WIDTH', 'HEIGHT'))
            return {'id': wid, 'rect': (x, y, x + w, y + h)}
    if shutil.which('xprop') and shutil.which('xwininfo'):
        found = re.search(r'(0x[0-9a-f]+)', run('xprop', '-root', '_NET_ACTIVE_WINDOW'))
        if found:
            info = run('xwininfo', '-id', found.group(1))
            nums = {k: int(v) for k, v in re.findall(r'(Absolute upper-left [XY]|Width|Height):\s+(-?\d+)', info)}
            if len(nums) == 4:
                x, y = nums['Absolute upper-left X'], nums['Absolute upper-left Y']
                return {'id': str(int(found.group(1), 16)), 'rect': (x, y, x + nums['Width'], y + nums['Height'])}
    return None


def linux_screen(rect):
    """The monitor holding the middle of `rect`, from xrandr; else the whole display."""
    x, y = (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2
    monitors = [tuple(int(n) for n in m) for m in
                re.findall(r'(\d+)/\d+x(\d+)/\d+\+(-?\d+)\+(-?\d+)', run('xrandr', '--listactivemonitors'))]
    for w, h, mx, my in monitors:
        if mx <= x < mx + w and my <= y < my + h:
            return mx, my, mx + w, my + h
    size = re.search(r'(\d+) (\d+)', run('xdotool', 'getdisplaygeometry'))
    return (0, 0, int(size.group(1)), int(size.group(2))) if size else (0, 0, 1920, 1080)


def linux_find(title):
    if shutil.which('xdotool'):
        ids = run('xdotool', 'search', '--name', re.escape(title)).split()
        if ids:
            return ids[-1]
    if shutil.which('wmctrl'):
        for line in run('wmctrl', '-l').splitlines():
            parts = line.split(None, 3)
            if len(parts) == 4 and title in parts[3]:
                return str(int(parts[0], 16))
    return None


def linux_place(title, keep_focus, before):
    target = beside(before['rect'], linux_screen(before['rect']))
    wid = None
    for _ in range(40):
        wid = linux_find(title)
        if wid:
            break
        time.sleep(0.2)
    if not wid:
        return
    l, t, r, b = target
    if shutil.which('wmctrl'):
        run('wmctrl', '-i', '-r', hex(int(wid)), '-b', 'remove,maximized_vert,maximized_horz')
        run('wmctrl', '-i', '-r', hex(int(wid)), '-e', f'0,{l},{t},{r - l},{b - t}')
    elif shutil.which('xdotool'):
        run('xdotool', 'windowsize', wid, str(r - l), str(b - t))
        run('xdotool', 'windowmove', wid, str(l), str(t))
    if keep_focus:
        if shutil.which('xdotool'):
            run('xdotool', 'windowactivate', before['id'])
        elif shutil.which('wmctrl'):
            run('wmctrl', '-i', '-a', hex(int(before['id'])))


# Windows ---------------------------------------------------------------------------------

def win_api():
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    try:
        user32.SetProcessDPIAware()  # real pixels, the same as the window's own
    except Exception:
        pass
    return ctypes, wintypes, user32


def windows_active():
    ctypes, wintypes, user32 = win_api()
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))

    class MONITORINFO(ctypes.Structure):
        _fields_ = [('cbSize', wintypes.DWORD), ('rcMonitor', wintypes.RECT), ('rcWork', wintypes.RECT), ('dwFlags', wintypes.DWORD)]

    info = MONITORINFO(cbSize=ctypes.sizeof(MONITORINFO))
    user32.GetMonitorInfoW(user32.MonitorFromWindow(hwnd, 2), ctypes.byref(info))
    work = info.rcWork
    try:
        scale = user32.GetDpiForWindow(hwnd) / 96
    except Exception:
        scale = 1.0
    return {'id': hwnd, 'rect': (rect.left, rect.top, rect.right, rect.bottom),
            'screen': (work.left, work.top, work.right, work.bottom), 'scale': scale or 1.0}


def windows_place(title, keep_focus, before):
    ctypes, wintypes, user32 = win_api()
    hwnd = 0
    for _ in range(40):
        hwnd = user32.FindWindowW(None, title)
        if hwnd:
            break
        time.sleep(0.2)
    if not hwnd:
        return
    l, t, r, b = beside(before['rect'], before['screen'], before.get('scale', 1.0))
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE, in case it opened maximised
    user32.SetWindowPos(hwnd, 0, l, t, r - l, b - t, 0x0004 | 0x0010)  # NOZORDER, NOACTIVATE
    if keep_focus:
        user32.SetForegroundWindow(before['id'])


# -----------------------------------------------------------------------------------------

def active():
    """Claude's window, before the feed's opens: {'id', 'rect', …}, or None."""
    try:
        if WINDOWS:
            return windows_active()
        if sys.platform.startswith('linux'):
            return linux_active()
    except Exception:
        return None
    return None


if __name__ == '__main__':
    title, keep, before = sys.argv[1], sys.argv[2] == '1', json.loads(sys.argv[3])
    try:
        (windows_place if WINDOWS else linux_place)(title, keep, before)
    except Exception:
        pass
