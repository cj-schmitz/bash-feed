"""Streams one background task's output file into a session's feed log until the task ends.

Usage: tail-task.py <task-id> <log-file> <label> <claude-pid>
The task's file ends with "[exited with code N]" or "[killed]"; the watch also stops
when the Claude process exits, or after six hours.
"""
import glob, os, re, sys, time

task, log, label, pid = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
DIM, BAR, BAD, OFF = '\x1b[2m', '\x1b[35m', '\x1b[1;31m', '\x1b[0m'
MAX_LINES = 500
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

offset, carry, pending_blank, shown = 0, b'', 0, 0
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
        if shown < MAX_LINES:
            out += [f'{BAR}  ┆{OFF}\n'] * pending_blank + [f'{BAR}  ┆{OFF} {line}\n']
        elif shown == MAX_LINES:
            out.append(f'{DIM}  ┆ … more output in {path}{OFF}\n')
        shown += 1
        pending_blank = 0
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
