"""What the feed's scripts share across macOS, Linux and Windows: is a process alive, which
process is Claude's, and turning on colour codes in a Windows console."""
import os, subprocess, sys

WINDOWS = sys.platform == 'win32'


def alive(pid):
    if pid <= 0:
        return False
    if WINDOWS:
        # os.kill(pid, 0) ends the process on Windows; ask for its exit code instead.
        import ctypes
        kernel = ctypes.windll.kernel32
        handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ok = kernel.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel.CloseHandle(handle)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def claude_pid():
    """The Claude process this script runs under: the nearest ancestor named claude, else
    the parent."""
    parent = os.getppid()
    if WINDOWS:
        return parent
    pid = parent
    for _ in range(12):
        if pid <= 1:
            break
        try:
            out = subprocess.run(['ps', '-o', 'ppid=,comm=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
        except OSError:
            break
        if not out:
            break
        ppid, _, comm = out.partition(' ')
        if 'claude' in os.path.basename(comm.strip()).lower():
            return pid
        pid = int(ppid)
    return parent


def detach(args):
    """Starts a process that outlives this one, with no window and no inherited terminal."""
    kw = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if WINDOWS:
        kw['creationflags'] = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED, NEW_GROUP, NO_WINDOW
    else:
        kw['start_new_session'] = True
    return subprocess.Popen(args, **kw)


def enable_vt():
    """Lets a Windows console draw colour codes and send mouse and arrow keys as escape
    codes; answers the console's previous input mode, to restore on exit."""
    if not WINDOWS:
        return None
    import ctypes
    kernel = ctypes.windll.kernel32
    out, inp = kernel.GetStdHandle(-11), kernel.GetStdHandle(-10)
    mode = ctypes.c_ulong()
    if kernel.GetConsoleMode(out, ctypes.byref(mode)):
        kernel.SetConsoleMode(out, mode.value | 0x0004 | 0x0001)  # VIRTUAL_TERMINAL_PROCESSING, PROCESSED_OUTPUT
    previous = ctypes.c_ulong()
    if not kernel.GetConsoleMode(inp, ctypes.byref(previous)):
        return None
    # VT input on; line input, echo, processed input and quick edit (which eats clicks) off.
    kernel.SetConsoleMode(inp, (previous.value | 0x0200 | 0x0080) & ~(0x0002 | 0x0004 | 0x0001 | 0x0040))
    return previous.value


def restore_input(previous):
    if WINDOWS and previous is not None:
        import ctypes
        kernel = ctypes.windll.kernel32
        kernel.SetConsoleMode(kernel.GetStdHandle(-10), previous)
