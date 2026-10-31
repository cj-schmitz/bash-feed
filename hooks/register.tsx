import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BashRun } from '../types'

const PANE = 'bash-feed'
const MAX_RUNS = 100
// Output lines kept per stream per command; the rest is summarised.
const MAX_LINES = 60

const runs = atom({ plugin: 'bash-feed', key: 'runs' } as const, [], {
  shape: 'runs-1',
})

// Each session logs to its own file, tailed in its own Terminal window titled with the
// session's short id, so ending one session closes only its window.
let sessionId = ''
const logFile = () => `$HOME/.claude/bash-feed/${sessionId || 'unknown'}.log`
const windowTitle = () => `Bash feed ${sessionId.slice(0, 8)}`
const ANSI = { say: '\x1b[1;37m', cmd: '\x1b[1;36m', err: '\x1b[31m', ok: '\x1b[2;32m', bad: '\x1b[1;31m', dim: '\x1b[2m', term: '\x1b[33m', more: '\x1b[4;34m', off: '\x1b[0m' }
// Which run the log last wrote, so a finished run repeats its header only when another came between.
let lastLogged = ''
// Log writes run one after another, so a slow lesson never lets a later block jump ahead.
let queue: Promise<unknown> = Promise.resolve()
const enqueue = (write: () => Promise<unknown>) => {
  queue = queue.then(write).catch(() => {})
}

const TEACHER = `You explain shell commands to someone learning the terminal on macOS.
List the parts of the command that matter: each program, important flags/options, and shell
characters such as | > >> 2>/dev/null ; && || $() quotes and globs.
One part per line: the part itself, then " :: ", then a short plain meaning (under 12 words).
For example, for "ls -la | head":
ls :: list the files in a folder
-la :: include hidden files, with details
| :: send the output into the next command
head :: keep only the first lines
At most 8 lines, in the order they appear. Skip plain file paths and arguments
whose meaning is obvious.
Then one last line, exactly as: SAY :: one plain-English sentence saying what the whole
command does, in order, for someone who has never used a terminal. Example for
"cd Bizon && cd Ag": SAY :: Move into the Bizon folder, and if that works, move into its Ag folder.
No intro, no closing, no markdown.`

// Lessons by command, so a repeated command is not explained twice.
const lessons = new Map<string, Promise<string[]>>()

const lessonFor = ($: EngineInterface, command: string): Promise<string[]> => {
  const known = lessons.get(command)
  if (known) return known
  const asked = $.model
    .complete({ model: 'haiku', system: TEACHER, prompt: command, maxTokens: 400, timeoutMs: 20_000 })
    .then(reply => {
      if (!reply.isAnswered) return []
      const parts = reply.text
        .split('\n')
        .map(line => line.split('::'))
        .filter(bits => bits.length >= 2)
        .map(([part, ...meaning]) => [part!.trim(), meaning.join('::').trim()] as const)
      const terms = parts
        .filter(([part]) => part !== 'SAY')
        .map(([part, meaning]) => {
          // A reply that echoes a placeholder name ("PART") leads its meaning with the part.
          if (/^part$/i.test(part)) {
            const [first = '', ...rest] = meaning.split(' ')
            return [first, rest.join(' ')] as const
          }
          return [part, meaning] as const
        })
        .map(([part, meaning]) => `  ${ANSI.term}${part.padEnd(14)}${ANSI.off} ${ANSI.dim}${meaning}${ANSI.off}`)
      const say = parts.find(([part]) => part === 'SAY')
      return say ? [...terms, `  ${ANSI.say}→ ${say[1]}${ANSI.off}`] : terms
    })
    .catch(() => [])
  lessons.set(command, asked)
  return asked
}

type Line = { text: string; color?: string; dim?: boolean; bold?: boolean }

const clip = (text: string): string[] => {
  const lines = text.replace(/\s+$/, '').split('\n')
  if (lines.length === 1 && lines[0] === '') return []
  if (lines.length <= MAX_LINES) return lines
  return [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more lines`]
}

const linesOf = (run: BashRun): Line[] => {
  const out: Line[] = [{ text: `$ ${run.command}`, color: 'suggestion', bold: true }]
  for (const text of clip(run.stdout)) out.push({ text: `  ${text}` })
  for (const text of clip(run.stderr)) out.push({ text: `  ${text}`, color: 'error' })
  if (!run.isDone) out.push({ text: '  … running', color: 'warning' })
  else if (run.note) out.push({ text: `  ✗ ${run.note}`, color: 'error' })
  else if (run.exitCode === 0) out.push({ text: '  ✓ exit 0', color: 'success', dim: true })
  else out.push({ text: `  ✗ exit ${run.exitCode ?? '?'}`, color: 'error', bold: true })
  out.push({ text: ' ' })
  return out
}

const appendLog = ($: EngineInterface, text: string) =>
  $.process.run(['/bin/sh', '-c', `mkdir -p "$HOME/.claude/bash-feed" && cat >> "${logFile()}"`], { stdin: text })

// Opens the window unless this session's is already open (a reload runs session.start
// again). `exit` lets the window's shell end once the watcher stops the tail. With
// `keepFocus`, the window that was in front goes back in front.
const openWindow = ($: EngineInterface, keepFocus: boolean) => {
  const title = windowTitle()
  const tail = `clear; tail -n 300 -F ${logFile().replace('$HOME', '~')}; exit`
  return $.process.run([
    'osascript',
    '-e', `tell application "Terminal"
  repeat with w in (get windows)
    try
      if custom title of selected tab of w is "${title}" then return
    end try
  end repeat
  set prevWin to missing value
  if (count of windows) > 0 then set prevWin to front window
  set custom title of (do script "${tail}") to "${title}"
  if ${keepFocus} and prevWin is not missing value then
    set index of prevWin to 1
  else
    activate
  end if
end tell`,
  ]).then(() =>
    // A detached watcher closes the window once this Claude process exits, so a
    // reload or /clear never closes it.
    $.process.run(['/bin/sh', `${$.plugin.root}/bin/close-on-exit.sh`, sessionId, title]),
  )
}

const header = (run: BashRun) => `${ANSI.cmd}$ ${run.command}${ANSI.off}${run.from ? ` ${ANSI.dim}[${run.from}]${ANSI.off}` : ''}`

// Output lines the window shows per command; a longer output is saved whole and linked.
const SHOW = 20

const linesIn = (text: string): string[] => {
  const trimmed = text.replace(/\s+$/, '')
  return trimmed === '' ? [] : trimmed.split('\n')
}

// Saves a command's full output beside the logs and answers the file's absolute path.
const saveOutput = async ($: EngineInterface, id: string, text: string): Promise<string> => {
  const saved = await $.process.run(
    ['/bin/sh', '-c', `d="$HOME/.claude/bash-feed/out" && mkdir -p "$d" && f="$d/${sessionId.slice(0, 8)}-${id}.txt" && cat > "$f" && printf %s "$f"`],
    { stdin: text },
  )
  return saved.stdout
}

const logBlock = async ($: EngineInterface, run: BashRun): Promise<string> => {
  const out: string[] = []
  if (lastLogged !== run.id) out.push(header(run))
  const body = [
    ...linesIn(run.stdout).map(text => `  ${text}`),
    ...linesIn(run.stderr).map(text => `${ANSI.err}  ${text}${ANSI.off}`),
  ]
  if (body.length > SHOW) {
    const file = await saveOutput($, run.id, [run.stdout, run.stderr].filter(text => text.trim()).join('\n'))
    out.push(...body.slice(0, SHOW), `${ANSI.more}  ▸ ${body.length - SHOW} more lines · ⌘-click: file://${encodeURI(file)}${ANSI.off}`)
  } else {
    out.push(...body)
  }
  if (run.note) out.push(`${ANSI.bad}  ✗ ${run.note}${ANSI.off}`)
  else if (run.exitCode === 0) out.push(`${ANSI.ok}  ✓ exit 0${ANSI.off}`)
  else out.push(`${ANSI.bad}  ✗ exit ${run.exitCode ?? '?'}${ANSI.off}`)
  return out.join('\n') + '\n\n'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bash-feed',
      description: 'Open the pane that streams Bash commands and their output',
    })
    await $.command.register({
      name: 'bash-feed-window',
      description: 'Open a separate Terminal window that streams Bash commands and their output',
    })
    void $.ui.open({ id: PANE, title: 'Bash feed' })
    sessionId = await $.session.id()
    // Session logs and saved outputs last modified more than 90 days ago are deleted.
    enqueue(() =>
      $.process.run(['/bin/sh', '-c', `[ -d "$HOME/.claude/bash-feed" ] && find "$HOME/.claude/bash-feed" -type f \( -name '*.log' -o -name '*.txt' \) -mtime +90 -delete`]),
    )
    if (e.isInteractive) {
      enqueue(async () => {
        // The header goes in once per session file, not again on each reload.
        await $.process.run(['/bin/sh', '-c', `[ -e "${logFile()}" ] || { mkdir -p "$HOME/.claude/bash-feed" && cat > "${logFile()}"; }`], {
          stdin: `${ANSI.dim}── session ${sessionId.slice(0, 8)} · ${new Date().toLocaleString()} ──${ANSI.off}\n\n`,
        })
        await openWindow($, true)
      })
    }

    return next(e)
  })

  on('command.run', { command: 'bash-feed' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Bash feed' })

    return { text: 'Bash feed opened.' }
  })

  on('command.run', { command: 'bash-feed-window' }, async $ => {
    if (!sessionId) sessionId = await $.session.id()
    await openWindow($, false)

    return { text: 'Bash feed window opened.' }
  })

  // Every shell command Claude sends: Bash calls and Monitor watches, from the main
  // loop and from subagents alike.
  on('tool.call', async ($, e, next) => {
    const command = e.tool === 'Bash' ? e.command : e.tool === 'Monitor' ? e.command : undefined
    if (!command) return next(e)
    const id = e.tool_use_id
    if (!sessionId) sessionId = await $.session.id()
    const tags = [e.tool === 'Monitor' && 'monitor', e.agentId && 'subagent'].filter(Boolean)
    const run: BashRun = { id, command, isDone: false, stdout: '', stderr: '', ...(tags.length ? { from: tags.join(', ') } : {}) }
    await update($, runs, list => [...list, run].slice(-MAX_RUNS))
    const lesson = lessonFor($, run.command)
    enqueue(async () => {
      const lines = await lesson
      lastLogged = id
      await appendLog($, [header(run), ...lines, ''].join('\n'))
    })

    const ran = await next(e)

    let done: Partial<BashRun>
    let taskId: string | undefined
    if (ran.deny !== undefined) {
      done = { note: `blocked: ${ran.deny}` }
    } else if (ran.isError === true) {
      // Non-zero exits come back as errors; the model's text holds the code and output.
      const text = ran.text ?? ''
      const code = /Exit code (\d+)/.exec(text)
      done = code
        ? { exitCode: Number(code[1]), stderr: text.replace(/^Exit code \d+\n?/, '') }
        : { note: text.split('\n')[0] || 'failed', stderr: text.split('\n').slice(1).join('\n') }
    } else {
      const result = (ran.result ?? {}) as { stdout?: string; stderr?: string; interrupted?: boolean; taskId?: string; backgroundTaskId?: string }
      taskId = result.taskId ?? result.backgroundTaskId
      done = {
        // A backgrounded command's output so far is also in its task file, streamed below.
        stdout: taskId ? `running in the background (task ${taskId})` : result.stdout ?? '',
        stderr: result.stderr ?? '',
        ...(result.interrupted ? { note: 'interrupted' } : { exitCode: 0 }),
      }
    }
    await update($, runs, list =>
      list.map(one => (one.id === id ? { ...one, ...done, isDone: true } : one)),
    )
    enqueue(async () => {
      const block = await logBlock($, { ...run, ...done, isDone: true })
      lastLogged = id
      await appendLog($, block)
      // A background command or monitor keeps writing after the call returns: a detached
      // watcher streams its task file into the log until it ends.
      if (taskId) {
        const short = command.replace(/\s+/g, ' ')
        const label = `${short.length > 50 ? `${short.slice(0, 50)}…` : short} (task ${taskId})`
        await $.process.run(['/bin/sh', `${$.plugin.root}/bin/tail-task.sh`, sessionId, taskId, label])
      }
    })

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, runs)
    // Newest at the bottom: keep only the last screenful of lines.
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 4)
    const lines = list.flatMap(linesOf).slice(-room)

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No Bash commands yet.</Text>}
        {lines.map(line => (
          <Text wrap="truncate-end" color={line.color} dimColor={line.dim} bold={line.bold}>
            {line.text}
          </Text>
        ))}
      </Box>
    )
  })
}
