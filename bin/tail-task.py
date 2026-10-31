"""Streams one background task's output file into a session's feed log until the task ends.

Usage: tail-task.py <task-id> <log-file> <label> <claude-pid> <window-columns>
The task's file ends with "[exited with code N]" or "[killed]"; the watch also stops
when the Claude process exits, or after six hours.
"""
import glob, os, re, shutil, sys, time
from urllib.parse import quote

task, log, label, pid, cols = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), max(20, int(sys.argv[5]))
DIM, BAR, BAD, MORE, OFF = '\x1b[2m', '\x1b[35m', '\x1b[1;31m', '\x1b[4;34m', '\x1b[0m'
# Screen rows the window shows per task, counting wrapped lines; the whole output is
# saved beside the logs and linked.
SHOW = 20
END = re.compile(r'^\[(?:exited with code (-?\d+)|(killed))\]$')


def alive():
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


# The engine creates the file under /private/tmp/claude-<uid>/<project>/<session>/tasks/.
root = f'/private/tmp/claude-{os.getuid()}'
path, began = None, time.time()
while path is None and time.time() - began < 60:
    hits = glob.glob(f'{root}/*/*/tasks/{task}.output')
    if hits:
        path = hits[0]
    else:
        time.sleep(0.5)
if path is None:
    sys.exit()

offset, carry, pending_blank, shown, rows_used, cut = 0, b'', 0, 0, 0, False
# The log's size after this watcher's last write: if it grew since, another command wrote
# in between, so the next batch repeats the label.
our_size = -1


def write(lines):
    global our_size
    size = os.path.getsize(log) if os.path.exists(log) else 0
    if size != our_size:
        lines = [f'{DIM}  ⋯ background · {label}{OFF}\n'] + lines
    with open(log, 'a') as f:
        f.write(''.join(lines))
    our_size = os.path.getsize(log)


deadline = time.time() + 6 * 3600
while time.time() < deadline:
    with open(path, 'rb') as f:
        f.seek(offset)
        chunk = f.read()
    offset += len(chunk)
    carry += chunk
    *lines, carry = carry.split(b'\n')
    out, end = [], None
    for raw in lines:
        line = raw.decode(errors='replace').rstrip('\r')
        end = END.match(line.strip())
        if end:
            break
        # Blank lines wait for the next text, so the one before the end marker is dropped.
        if not line.strip():
            pending_blank += 1
            continue
        shown += 1
        if cut:
            continue
        rows = pending_blank + max(1, -(-(len(line) + 4) // cols))
        if rows_used + rows <= SHOW:
            out += [f'{BAR}  ┆{OFF}\n'] * pending_blank + [f'{BAR}  ┆{OFF} {line}\n']
            rows_used += rows
        else:
            left = SHOW - rows_used - pending_blank
            if left > 0:
                out += [f'{BAR}  ┆{OFF}\n'] * pending_blank + [f'{BAR}  ┆{OFF} {line[:left * cols - 5]}…\n']
            out.append(f'{DIM}  ┆ … more output; a link to all of it follows when the task ends{OFF}\n')
            cut, hidden_from = True, shown  # the line that did not fit counts as hidden
        pending_blank = 0
    if end or not alive():
        if cut:
            # The task file lives in a temp folder; a copy beside the logs outlasts it.
            saved_dir = os.path.join(os.path.dirname(log), 'out')
            os.makedirs(saved_dir, exist_ok=True)
            saved = os.path.join(saved_dir, f'{os.path.basename(log)[:8]}-{task}.txt')
            shutil.copyfile(path, saved)
            hidden = shown - hidden_from + 1
            out.append(f'{MORE}  ▸ {hidden} more line{"" if hidden == 1 else "s"} · ⌘-click: file://{quote(saved)}{OFF}\n')
    if end:
        code = end.group(1)
        if code == '0':
            out.append(f'{DIM}  ⋯ finished · exit 0{OFF}\n\n')
        elif code is not None:
            out.append(f'{BAD}  ⋯ finished · exit {code}{OFF}\n\n')
        else:
            out.append(f'{DIM}  ⋯ stopped (timed out or cancelled){OFF}\n\n')
        write(out)
        break
    if out:
        write(out)
    if not alive():
        break
    time.sleep(0.5)
