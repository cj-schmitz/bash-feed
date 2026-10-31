import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput, ToolCallResult } from 'claude-code'

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
const ANSI = { say: '\x1b[3;92m', cmd: '\x1b[1;36m', err: '\x1b[31m', ok: '\x1b[2;32m', bad: '\x1b[1;31m', dim: '\x1b[2m', term: '\x1b[33m', more: '\x1b[4;34m', edit: '\x1b[1;34m', add: '\x1b[32m', del: '\x1b[31m', off: '\x1b[0m' }
// Which run the log last wrote, so a finished run repeats its header only when another came between.
let lastLogged = ''
// Whether the feed runs; kept in the plugin's store, so it holds across sessions.
let enabled = true
// Each command and file change gets the next step number, written "§12": ⌘F § (⌥6) in the
// window, then ⌘G / ⇧⌘G, jumps from step to step.
let step = 0
const mark = (n: number | undefined) => (n ? `${ANSI.dim}§${n}${ANSI.off} ` : '')
// Log writes run one after another, so a slow lesson never lets a later block jump ahead.
let queue: Promise<unknown> = Promise.resolve()
const enqueue = (write: () => Promise<unknown>) => {
  queue = queue.then(write).catch(() => {})
}

const LEVELS = {
  beginner: 'Explain for a beginner: include basics such as cd, ls, pipes, && and quotes.',
  intermediate: 'The reader knows the basics (cd, ls, cat, echo, pipes, &&, ;, quotes, redirects): skip them and explain only less common programs, flags and syntax, at most 5 lines.',
}

const teacher = () => `${TEACHER}
${LEVELS[settings.teacherLevel === 'intermediate' ? 'intermediate' : 'beginner']}
Write every meaning, the RISK line and the SAY line in ${settings.language}; keep the parts, RISK and SAY themselves as written.`

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
If the command can lose or overwrite data, delete files, rewrite or push git history, use sudo,
change permissions, kill processes, install or remove software, or send or publish data
over the network, add a line: RISK :: what could go wrong, in plain words (under 15 words).
For example: RISK :: rm -rf deletes the folder for good; there is no trash can.
Leave the RISK line out when the command only reads or prints.
Then one last line, exactly as: SAY :: one plain-English sentence saying what the whole
command does, in order, for someone who has never used a terminal. Example for
"cd Bizon && cd Ag": SAY :: Move into the Bizon folder, and if that works, move into its Ag folder.
No intro, no closing, no markdown.`

// Lessons by command, so a repeated command is not explained twice.
const lessons = new Map<string, Promise<string[]>>()

const lessonFor = ($: EngineInterface, command: string): Promise<string[]> => {
  if (settings.teacherLevel === 'off') return Promise.resolve([])
  const known = lessons.get(command)
  if (known) return known
  const asked = $.model
    .complete({ model: 'haiku', system: teacher(), prompt: command, maxTokens: 400, timeoutMs: 20_000 })
    .then(reply => {
      if (!reply.isAnswered) return []
      const parts = reply.text
        .split('\n')
        .map(line => line.split('::'))
        .filter(bits => bits.length >= 2)
        .map(([part, ...meaning]) => [part!.trim(), meaning.join('::').trim()] as const)
      const terms = parts
        .filter(([part]) => part !== 'SAY' && part !== 'RISK')
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
      const risk = parts.find(([part]) => part === 'RISK')
      // The warning leads; a blank line keeps the summary apart from the output that follows.
      return [
        ...(risk && settings.showRisk ? [`  ${ANSI.bad}⚠ ${risk[1]}${ANSI.off}`] : []),
        ...terms,
        ...(say && settings.showSummary ? [`  ${ANSI.say}→ ${say[1]}${ANSI.off}`, ''] : []),
      ]
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
  // The BizonAg banner first, then the log as it grows.
  const tail = `clear; sh '${$.plugin.root}/bin/banner.sh' ${sessionId.slice(0, 8)}; tail -n 300 -F ${logFile().replace('$HOME', '~')}; exit`
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


const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

type Patch = { lines: string[] }[]

// One file change Claude made with Edit, Write or NotebookEdit: what changed, counted and shown.
const editBlock = async ($: EngineInterface, id: string, verb: string, path: string, changed: string[], detail = ''): Promise<string> => {
  const added = changed.filter(line => line.startsWith('+')).length
  const removed = changed.filter(line => line.startsWith('-')).length
  const counts = `${added ? ` ${ANSI.add}+${added}${ANSI.off}` : ''}${removed ? ` ${ANSI.del}−${removed}${ANSI.off}` : ''}`
  const out = [`${mark(++step)}${ANSI.edit}✎ ${verb} ${home(path)}${ANSI.off}${detail}${counts}`]
  const rows = changed.map(line => `  ${line.startsWith('+') ? ANSI.add : ANSI.del}${line}${ANSI.off}`)
  const { shown, hidden } = fitRows(rows, await columns($), settings.diffRows)
  out.push(...shown)
  if (hidden > 0) {
    const file = await saveOutput($, id, changed.join('\n'))
    out.push(`${ANSI.more}  ▸ ${hidden} more line${hidden === 1 ? '' : 's'} · ⌘-click: file://${encodeURI(file)}${ANSI.off}`)
  }
  return out.join('\n') + '\n\n'
}

const changedLines = (patch: Patch | undefined) =>
  (patch ?? []).flatMap(hunk => hunk.lines).filter(line => /^[+-]/.test(line))

const logEdit = async ($: EngineInterface, e: Extract<ToolCallInput, { tool: 'Edit' | 'Write' | 'NotebookEdit' }>, next: (e: ToolCallInput) => Promise<ToolCallResult>) => {
  const ran = await next(e)
  if (!enabled || !settings.showFileChanges) return ran
  const id = e.tool_use_id
  const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
  const tag = e.agentId ? ` ${ANSI.dim}[subagent]${ANSI.off}` : ''
  enqueue(async () => {
    let block: string
    if (ran.deny !== undefined || ran.isError === true) {
      const why = (ran.deny ?? ran.text ?? 'failed').split('\n')[0]!.replace(/<\/?tool_use_error>/g, '')
      block = `${mark(++step)}${ANSI.edit}✎ ${home(path)}${ANSI.off}${tag}\n${ANSI.bad}  ✗ not changed: ${why}${ANSI.off}\n\n`
    } else if (e.tool === 'Edit') {
      const result = ran.result as { structuredPatch?: Patch } | undefined
      block = await editBlock($, id, 'edited', path, changedLines(result?.structuredPatch), tag)
    } else if (e.tool === 'Write') {
      const result = ran.result as { type?: 'create' | 'update'; structuredPatch?: Patch } | undefined
      const created = result?.type === 'create'
      const changed = created ? e.content.replace(/\n$/, '').split('\n').map(line => `+${line}`) : changedLines(result?.structuredPatch)
      block = await editBlock($, id, created ? 'created' : 'rewrote', path, changed, tag)
    } else {
      const cell = e.cell_id ? ` ${ANSI.dim}(cell ${e.cell_id})${ANSI.off}` : ''
      const verb = e.edit_mode === 'insert' ? 'added a cell to' : e.edit_mode === 'delete' ? 'deleted a cell from' : 'edited'
      const changed = e.edit_mode === 'delete' ? [] : e.new_source.split('\n').map(line => `+${line}`)
      block = await editBlock($, id, verb, path, changed, cell + tag)
    }
    lastLogged = id
    await appendLog($, block)
  })
  return ran
}

// Stops this session's tail and closes its window.
const closeWindow = ($: EngineInterface) =>
  $.process.run([
    '/bin/sh', '-c', `pkill -f "[t]ail -n 300 -F .*bash-feed/${sessionId}.log"; sleep 0.2; osascript -e 'tell application "Terminal"
  repeat with w in (get windows)
    try
      if custom title of selected tab of w is "${windowTitle()}" then close w
    end try
  end repeat
end tell'`,
  ])

const header = (run: BashRun) => `${mark(run.n)}${ANSI.cmd}$ ${run.command}${ANSI.off}${run.from ? ` ${ANSI.dim}[${run.from}]${ANSI.off}` : ''}`

// The person's settings (the bash-feed rows in /config), set by register from its options.
const settings = {
  teacherLevel: 'beginner' as 'beginner' | 'intermediate' | 'off',
  language: 'English',
  showWhy: true,
  showSummary: true,
  showRisk: true,
  showFileChanges: true,
  // Screen rows of output shown per command, wrapped lines counted; the rest is saved and linked.
  outputRows: 20,
  diffRows: 10,
  openOnStart: true,
}

// The feed window's width in columns, asked of Terminal at most every 15 seconds.
let width = { cols: 100, at: -Infinity }
const columns = async ($: EngineInterface): Promise<number> => {
  const now = Date.now()
  if (now - width.at < 15_000) return width.cols
  const asked = await $.process
    .run(['osascript', '-e', `tell application "Terminal"
  repeat with w in (get windows)
    try
      if custom title of selected tab of w is "${windowTitle()}" then return number of columns of selected tab of w
    end try
  end repeat
end tell`])
    .catch(() => undefined)
  const cols = Number(asked?.stdout.trim())
  width = { cols: cols > 20 ? cols : width.cols, at: now }
  return width.cols
}

const visible = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')
const rowsOf = (line: string, cols: number) => Math.max(1, Math.ceil([...visible(line)].length / cols))

// The lines that fit in `budget` screen rows; a line too long for what is left is cut.
const fitRows = (lines: string[], cols: number, budget: number): { shown: string[]; hidden: number } => {
  const shown: string[] = []
  let left = budget
  for (const [i, line] of lines.entries()) {
    const rows = rowsOf(line, cols)
    if (rows <= left) {
      shown.push(line)
      left -= rows
      continue
    }
    if (left > 0) {
      const chars = [...visible(line)].slice(0, left * cols - 1).join('')
      shown.push(`${chars}…${ANSI.off}`)
    }
    return { shown, hidden: lines.length - i }
  }
  return { shown, hidden: 0 }
}

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
  const { shown, hidden } = fitRows(body, await columns($), settings.outputRows)
  out.push(...shown)
  if (hidden > 0) {
    const file = await saveOutput($, run.id, [run.stdout, run.stderr].filter(text => text.trim()).join('\n'))
    out.push(`${ANSI.more}  ▸ ${hidden} more line${hidden === 1 ? '' : 's'} · ⌘-click: file://${encodeURI(file)}${ANSI.off}`)
  }
  if (run.note) out.push(`${ANSI.bad}  ✗ ${run.note}${ANSI.off}`)
  else if (run.exitCode === 0) out.push(`${ANSI.ok}  ✓ exit 0${ANSI.off}`)
  else out.push(`${ANSI.bad}  ✗ exit ${run.exitCode ?? '?'}${ANSI.off}`)
  return out.join('\n') + '\n\n'
}

// Shell snippet: the feed folder's size, as du prints it (e.g. 5.1M).
const SIZE = `du -sh "$HOME/.claude/bash-feed" 2>/dev/null | cut -f1`

const clearLogs = async ($: EngineInterface, all: boolean) => {
  const keep = sessionId.slice(0, 8)
  // Other sessions' logs and outputs go; this session's log is emptied, not deleted,
  // so its open window keeps following it.
  const script = `d="$HOME/.claude/bash-feed"; [ -d "$d" ] || exit 0
before=$(${SIZE})
find "$d" -maxdepth 1 -type f -name '*.log' ! -name '${sessionId}.log' -delete
find "$d/out" -type f -name '*.txt' ! -name '${keep}-*' -delete 2>/dev/null
${all ? `: > "$d/${sessionId}.log"; rm -f "$d/out/${keep}-"*.txt` : ''}
echo "$before $(${SIZE})"`
  const ran = await queue.then(() => $.process.run(['/bin/sh', '-c', script]))
  const [before = '?', after = '?'] = ran.stdout.trim().split(/\s+/)
  if (all) {
    lastLogged = ''
    step = 0
  }
  return all
    ? `Deleted all Bash feed logs (${before} → ${after}).`
    : `Deleted other sessions' Bash feed logs (${before} → ${after}). This session's log stays.`
}

const MENU = {
  on: 'Turn on',
  off: 'Turn off',
  window: 'Reopen the window',
  clear: "Clear other sessions' logs",
  all: 'Clear all logs',
} as const

export const register: Register = (on, options) => {
  const retentionDays = Math.max(0, Math.floor(Number(options.retentionDays ?? 90)))
  const flag = (key: keyof typeof settings, fallback: boolean) => (typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback)
  const count = (key: string, fallback: number, min: number) => {
    const value = Math.floor(Number(options[key]))
    return Number.isFinite(value) ? Math.max(min, value) : fallback
  }
  const level = String(options.teacherLevel ?? 'beginner')
  Object.assign(settings, {
    teacherLevel: level === 'intermediate' || level === 'off' ? level : 'beginner',
    language: String(options.language ?? '').trim() || 'English',
    showWhy: flag('showWhy', true),
    showSummary: flag('showSummary', true),
    showRisk: flag('showRisk', true),
    showFileChanges: flag('showFileChanges', true),
    outputRows: count('outputRows', 20, 1),
    diffRows: count('diffRows', 10, 0),
    openOnStart: flag('openOnStart', true),
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bash-feed',
      description: 'Turn the Bash feed on or off, reopen its window, or clear its logs',
      argumentHint: '[on|off|window|pane|clear|clear all]',
    })
    sessionId = await $.session.id()
    enabled = (await $.store.get('enabled')) !== false
    // Step numbers carry on from the highest already in this session's log.
    const last = await $.process.run(['/bin/sh', '-c', `grep -ao '§[0-9]*' "${logFile()}" 2>/dev/null | tr -d '§' | sort -n | tail -1`])
    step = Number(last.stdout.trim()) || 0
    // Session logs and saved outputs older than the retention setting are deleted (0 keeps all).
    if (retentionDays > 0) {
      enqueue(() =>
        $.process.run(['/bin/sh', '-c', `[ -d "$HOME/.claude/bash-feed" ] && find "$HOME/.claude/bash-feed" -type f \( -name '*.log' -o -name '*.txt' \) -mtime +${retentionDays} -delete`]),
      )
    }
    if (e.isInteractive && enabled && settings.openOnStart) {
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

  on('command.run', { command: 'bash-feed' }, async ($, e) => {
    if (!sessionId) sessionId = await $.session.id()
    let choice = e.args.trim().toLowerCase()
    if (!choice) {
      // No argument: a menu, like /permissions.
      const options = enabled ? [MENU.off, MENU.window, MENU.clear, MENU.all] : [MENU.on, MENU.clear, MENU.all]
      const size = (await $.process.run(['/bin/sh', '-c', SIZE])).stdout.trim() || '0B'
      const picked = await $.ui
        .ask(`The Bash feed is ${enabled ? 'on' : 'off'} (logs use ${size}). What do you want to do?`, { header: 'Bash feed', options })
        .catch(() => '')
      choice = (Object.keys(MENU) as (keyof typeof MENU)[]).find(key => MENU[key] === picked) ?? ''
      if (choice === 'all') choice = 'clear all'
      if (!choice) return { text: 'Bash feed unchanged.' }
    }
    switch (choice) {
      case 'on':
        enabled = true
        await $.store.set('enabled', true)
        await queue.then(() => openWindow($, false))
        return { text: 'Bash feed is on.' }
      case 'off':
        enabled = false
        await $.store.set('enabled', false)
        await queue.then(() => closeWindow($))
        return { text: 'Bash feed is off in every session until you turn it on with /bash-feed on.' }
      case 'window':
        if (!enabled) return { text: 'The Bash feed is off. Turn it on with /bash-feed on.' }
        await openWindow($, false)
        return { text: 'Bash feed window opened.' }
      case 'pane':
        await $.ui.open({ id: PANE, title: 'Bash feed' })
        return { text: 'Bash feed pane opened.' }
      case 'clear':
        return { text: await clearLogs($, false) }
      case 'clear all':
        return { text: await clearLogs($, true) }
      default:
        return { text: 'Use /bash-feed with on, off, window, pane, clear or clear all, or with nothing for the menu.' }
    }
  })

  // Every shell command Claude sends: Bash calls and Monitor watches, from the main
  // loop and from subagents alike.
  on('tool.call', async ($, e, next) => {
    if (!enabled) return next(e)
    if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') return logEdit($, e, next)
    const command = e.tool === 'Bash' ? e.command : e.tool === 'Monitor' ? e.command : undefined
    if (!command) return next(e)
    const description = e.tool === 'Bash' || e.tool === 'Monitor' ? e.description?.trim() : undefined
    const id = e.tool_use_id
    if (!sessionId) sessionId = await $.session.id()
    const tags = [e.tool === 'Monitor' && 'monitor', e.agentId && 'subagent'].filter(Boolean)
    const run: BashRun = { id, n: ++step, command, isDone: false, stdout: '', stderr: '', ...(tags.length ? { from: tags.join(', ') } : {}) }
    await update($, runs, list => [...list, run].slice(-MAX_RUNS))
    const lesson = lessonFor($, run.command)
    enqueue(async () => {
      const lines = await lesson
      lastLogged = id
      // Claude's own one-line reason for the command, written as a shell comment.
      const why = description && settings.showWhy ? [`${ANSI.dim}# ${description}${ANSI.off}`] : []
      await appendLog($, [...why, header(run), ...lines, ''].join('\n'))
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
        await $.process.run(['/bin/sh', `${$.plugin.root}/bin/tail-task.sh`, sessionId, taskId, label, String(await columns($))])
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
