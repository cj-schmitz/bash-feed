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

// Each session logs to its own file, followed in its own terminal window titled with the
// session's short id, so ending one session closes only its window.
let sessionId = ''
// Where the system is: found once by bin/feed.py probe (Python runs everything outside the
// mod, the same way on macOS, Linux and Windows).
const host = { python: [] as string[], platform: '', dir: '', home: '', ready: undefined as Promise<boolean> | undefined }
const logFile = () => `${host.dir}/${sessionId || 'unknown'}.log`
const windowTitle = () => `Bash feed ${sessionId.slice(0, 8)}`
// The key that opens a link in the plain window: ⌘ in macOS Terminal, Ctrl elsewhere.
const clickKey = () => (host.platform === 'darwin' ? '⌘' : 'ctrl')
const fileUrl = (path: string) => `file://${path.startsWith('/') ? '' : '/'}${encodeURI(path)}`
const linkTo = (file: string) => `${clickKey()}-click: ${fileUrl(file)}`

const PYTHONS = [['/usr/bin/python3'], ['python3'], ['py', '-3'], ['python']]

// Finds a Python 3 and the feed folder; resolves false when there is no Python.
const setup = ($: EngineInterface): Promise<boolean> =>
  (host.ready ??= (async () => {
    for (const python of PYTHONS) {
      const ran = await $.process.run([...python, '-I', `${$.plugin.root}/bin/feed.py`, 'probe']).catch(() => undefined)
      const [platform = '', dir = ''] = ran?.exitCode === 0 ? ran.stdout.trim().split(/\r?\n/) : []
      if (platform && dir) {
        Object.assign(host, { python: [...python, '-I'], platform, dir, home: dir.replace(/\/\.claude\/bash-feed$/, '') })
        return true
      }
    }
    await $.ui.toast('Bash feed needs Python 3, which was not found.')
    return false
  })())

// Runs one bin/feed.py action.
const feed = async ($: EngineInterface, args: string[], stdin?: string) => {
  if (!(await setup($))) return { exitCode: 1, stdout: '', stderr: '' }
  return $.process.run([...host.python, `${$.plugin.root}/bin/feed.py`, ...args], stdin === undefined ? undefined : { stdin })
}
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
Write every meaning, the RISK line and the SAY line in ${settings.language}; keep the parts, RISK and SAY themselves as written.
The computer runs ${{ darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[host.platform] ?? 'Unix'}.`

const TEACHER = `You explain shell commands to someone learning the terminal.
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
type Lesson = { risk?: string; terms: (readonly [string, string])[]; say?: string }

const lessons = new Map<string, Promise<Lesson>>()

const lessonFor = ($: EngineInterface, command: string): Promise<Lesson> => {
  if (settings.teacherLevel === 'off' || !(settings.showParts || settings.showSummary || settings.showRisk)) return Promise.resolve({ terms: [] })
  const known = lessons.get(command)
  if (known) return known
  const asked = $.model
    .complete({ model: 'haiku', system: teacher(), prompt: command.length > 3000 ? `${command.slice(0, 3000)}\n… (the rest of a long script)` : command, maxTokens: 400, timeoutMs: 20_000 })
    .then(reply => {
      if (!reply.isAnswered) return { terms: [] }
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
      return { terms, risk: parts.find(([part]) => part === 'RISK')?.[1], say: parts.find(([part]) => part === 'SAY')?.[1] }
    })
    .catch(() => ({ terms: [] }))
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

const appendLog = ($: EngineInterface, text: string) => feed($, ['append', logFile()], text)

// Opens the window unless this session's is already open (a reload runs session.start
// again). The window's program closes itself when this Claude process exits. With
// `keepFocus` (macOS), the window that was in front goes back in front.
const openWindow = ($: EngineInterface, keepFocus: boolean) =>
  feed($, ['open', logFile(), sessionId.slice(0, 8), windowTitle(), settings.viewer, keepFocus ? '1' : '0'])

const home = (path: string) => (host.home && path.startsWith(host.home) ? `~${path.slice(host.home.length)}` : path)

type Patch = { lines: string[] }[]

// One file change Claude made with Edit, Write or NotebookEdit: what changed, counted and shown.
const editBlock = async ($: EngineInterface, id: string, n: number, verb: string, path: string, changed: string[], detail = ''): Promise<string> => {
  const added = changed.filter(line => line.startsWith('+')).length
  const removed = changed.filter(line => line.startsWith('-')).length
  const counts = `${added ? ` ${ANSI.add}+${added}${ANSI.off}` : ''}${removed ? ` ${ANSI.del}−${removed}${ANSI.off}` : ''}`
  const out = [`${mark(n)}${ANSI.edit}✎ ${verb} ${home(path)}${ANSI.off}${detail}${counts}`]
  const rows = changed.map(line => `  ${line.startsWith('+') ? ANSI.add : ANSI.del}${line}${ANSI.off}`)
  const cols = await columns($)
  const { shown, hidden, rest } = fitRows(wrap(rows, cols), cols, settings.diffRows)
  out.push(...shown)
  if (hidden > 0) {
    const file = await saveOutput($, id, changed.join('\n'), rest)
    out.push(`${ANSI.more}  ▸ ${hidden} more line${hidden === 1 ? '' : 's'} · ${linkTo(file)}${ANSI.off}`)
  }
  return out.join('\n') + '\n\n'
}

const changedLines = (patch: Patch | undefined) =>
  (patch ?? []).flatMap(hunk => hunk.lines).filter(line => /^[+-]/.test(line))

const logEdit = async ($: EngineInterface, e: Extract<ToolCallInput, { tool: 'Edit' | 'Write' | 'NotebookEdit' }>, next: (e: ToolCallInput) => Promise<ToolCallResult>) => {
  if (!enabled || !settings.showFileChanges) return next(e)
  if (!sessionId) sessionId = await $.session.id()
  if (!(await setup($))) return next(e)
  // The step number is taken when the call starts, as a command's is, so steps log in order.
  const n = ++step
  const ran = await next(e)
  const id = e.tool_use_id
  const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
  const tag = e.agentId ? ` ${ANSI.dim}[subagent]${ANSI.off}` : ''
  enqueue(async () => {
    let block: string
    if (ran.deny !== undefined || ran.isError === true) {
      const why = (ran.deny ?? ran.text ?? 'failed').split('\n')[0]!.replace(/<\/?tool_use_error>/g, '')
      block = `${mark(n)}${ANSI.edit}✎ ${home(path)}${ANSI.off}${tag}\n${ANSI.bad}  ✗ not changed: ${why}${ANSI.off}\n\n`
    } else if (e.tool === 'Edit') {
      const result = ran.result as { structuredPatch?: Patch } | undefined
      block = await editBlock($, id, n, 'edited', path, changedLines(result?.structuredPatch), tag)
    } else if (e.tool === 'Write') {
      const result = ran.result as { type?: 'create' | 'update'; structuredPatch?: Patch } | undefined
      const created = result?.type === 'create'
      const changed = created ? e.content.replace(/\n$/, '').split('\n').map(line => `+${line}`) : changedLines(result?.structuredPatch)
      block = await editBlock($, id, n, created ? 'created' : 'rewrote', path, changed, tag)
    } else {
      const cell = e.cell_id ? ` ${ANSI.dim}(cell ${e.cell_id})${ANSI.off}` : ''
      const verb = e.edit_mode === 'insert' ? 'added a cell to' : e.edit_mode === 'delete' ? 'deleted a cell from' : 'edited'
      const changed = e.edit_mode === 'delete' ? [] : e.new_source.split('\n').map(line => `+${line}`)
      block = await editBlock($, id, n, verb, path, changed, cell + tag)
    }
    lastLogged = id
    await appendLog($, block)
  })
  return ran
}

// Stops this session's window program and closes its window.
const closeWindow = ($: EngineInterface) => feed($, ['close', logFile(), windowTitle()])

// Shell syntax colours for the command line: programs, flags, quoted text, variables and
// substitutions, operators and keywords, comments, heredoc bodies.
const SYNTAX = {
  program: '\x1b[1;36m',
  flag: '\x1b[38;5;117m',
  string: '\x1b[38;5;114m',
  variable: '\x1b[38;5;176m',
  operator: '\x1b[1;38;5;215m',
  keyword: '\x1b[38;5;215m',
  comment: '\x1b[2m',
  heredoc: '\x1b[38;5;223m',
  word: '\x1b[38;5;252m',
}

type Token = { kind: 'space' | 'newline' | 'word' | 'string' | 'variable' | 'chain' | 'redirect' | 'paren' | 'comment' | 'heredoc'; text: string }

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function', '!', 'time'])

// Splits a command into shell tokens. Quotes, $(…), ${…}, backticks and heredoc bodies stay
// whole; it only needs to be right enough to colour and lay out, never to run.
const tokenize = (command: string): Token[] => {
  const tokens: Token[] = []
  const heredocs: string[] = []
  let i = 0
  // The end of a quoted or bracketed run starting at `at`.
  const closing = (at: number, open: string, close: string): number => {
    let depth = 0
    for (let j = at; j < command.length; j++) {
      const ch = command[j]
      if (ch === '\\') j++
      else if (ch === "'" && open !== "'") j = command.indexOf("'", j + 1) === -1 ? command.length : command.indexOf("'", j + 1)
      else if (ch === open && (open !== close || j === at)) depth++
      else if (ch === close && --depth === 0) return j + 1
    }
    return command.length
  }
  while (i < command.length) {
    const rest = command.slice(i)
    const ch = command[i]!
    const previous = tokens[tokens.length - 1]
    const atWordStart = !previous || ['space', 'newline', 'chain', 'paren'].includes(previous.kind)
    let match: RegExpExecArray | null
    if (ch === '\n') {
      tokens.push({ kind: 'newline', text: '\n' })
      i++
      // A heredoc's body runs from here to the line holding only its delimiter.
      for (const end of heredocs.splice(0)) {
        const lines = command.slice(i).split('\n')
        const stop = lines.findIndex(line => line.trim() === end)
        const body = (stop === -1 ? lines : lines.slice(0, stop + 1)).join('\n')
        tokens.push({ kind: 'heredoc', text: body })
        i += body.length
      }
    } else if ((match = /^[ \t]+/.exec(rest))) {
      tokens.push({ kind: 'space', text: match[0] })
      i += match[0].length
    } else if (ch === '#' && atWordStart) {
      const end = command.indexOf('\n', i)
      tokens.push({ kind: 'comment', text: command.slice(i, end === -1 ? undefined : end) })
      i = end === -1 ? command.length : end
    } else if (ch === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end === -1 ? command.length : end + 1
      tokens.push({ kind: 'string', text: command.slice(i, stop) })
      i = stop
    } else if (ch === '"') {
      let j = i + 1
      while (j < command.length && command[j] !== '"') j += command[j] === '\\' ? 2 : 1
      tokens.push({ kind: 'string', text: command.slice(i, j + 1) })
      i = j + 1
    } else if (rest.startsWith('$(')) {
      const stop = closing(i + 1, '(', ')')
      tokens.push({ kind: 'variable', text: command.slice(i, stop) })
      i = stop
    } else if (rest.startsWith('${')) {
      const stop = closing(i + 1, '{', '}')
      tokens.push({ kind: 'variable', text: command.slice(i, stop) })
      i = stop
    } else if (ch === '`') {
      const end = command.indexOf('`', i + 1)
      const stop = end === -1 ? command.length : end + 1
      tokens.push({ kind: 'variable', text: command.slice(i, stop) })
      i = stop
    } else if ((match = /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9#?@*$!-])/.exec(rest))) {
      tokens.push({ kind: 'variable', text: match[0] })
      i += match[0].length
    } else if ((match = /^(&&|\|\||\|&|\||;;|;|&(?!>))/.exec(rest))) {
      tokens.push({ kind: 'chain', text: match[0] })
      i += match[0].length
    } else if ((match = /^[0-9]?(<<-?|<<<|>>|>&[0-9-]?|&>>?|>|<)/.exec(rest))) {
      tokens.push({ kind: 'redirect', text: match[0] })
      i += match[0].length
      if (match[1] === '<<' || match[1] === '<<-') {
        // The delimiter, quoted or not, names where the heredoc body ends.
        const delimiter = /^[ \t]*(['"]?)([A-Za-z0-9_]+)\1/.exec(command.slice(i))
        if (delimiter) heredocs.push(delimiter[2]!)
      }
    } else if (ch === '(' || ch === ')' || ch === '{' && atWordStart || ch === '}' && atWordStart) {
      tokens.push({ kind: 'paren', text: ch })
      i++
    } else {
      match = /^(\\.|[^\s|&;<>()'"`$\\])+/.exec(rest) ?? /^./.exec(rest)!
      tokens.push({ kind: 'word', text: match[0] })
      i += match[0].length
    }
  }
  return tokens
}

// The command coloured and laid out: a long chain breaks before &&, || and | and after ;,
// each part on its own line under the first. `indent` is where those lines start.
const formatCommand = (command: string, indent: string, cols: number): string => {
  const tokens = tokenize(command)
  const chains = tokens.filter(token => token.kind === 'chain' && token.text !== '&').length
  const isLong = indent.length + [...command].length > cols || chains >= 3
  let out = ''
  let expectProgram = true
  let skipSpace = false
  // How deep inside do…done, then…fi and case…esac the next line is; each level indents two.
  let depth = 0
  const lineStart = () => `\n${indent}${'  '.repeat(Math.max(0, depth))}`
  // Starts a new line, unless one was just started (a break after "do" meeting the
  // command's own newline), so no blank lines appear.
  const breakLine = (current: string) => current.replace(/\n[ \t]*$/, '').replace(/[ \t]+$/, '') + lineStart()
  const nextWord = (k: number) => tokens.slice(k + 1).find(next => next.kind !== 'space')
  const OPENS = new Set(['do', 'then', 'else', 'elif'])
  const CLOSES = new Set(['done', 'fi', 'esac', 'else', 'elif'])
  for (const [k, token] of tokens.entries()) {
    if (token.kind === 'space') {
      if (!skipSpace) out += token.text
      continue
    }
    skipSpace = false
    let colour: string = SYNTAX.word
    switch (token.kind) {
      case 'newline': {
        const next = nextWord(k)
        if (next?.kind === 'word' && CLOSES.has(next.text)) depth--
        out = breakLine(out)
        expectProgram = true
        skipSpace = true
        continue
      }
      case 'heredoc':
        out += token.text
          .split('\n')
          .map((line, k) => `${k ? `\n${indent}` : ''}${SYNTAX.heredoc}${line}${ANSI.off}`)
          .join('')
        continue
      case 'chain':
        expectProgram = true
        if (isLong && token.text !== '&' && token.text !== ';;') {
          const next = nextWord(k)
          if (token.text === ';' && next?.kind === 'word' && (next.text === 'do' || next.text === 'then')) {
            // "for …; do" and "if …; then" stay on one line; the body starts below.
            out += `${SYNTAX.operator};${ANSI.off} `
          } else if (token.text === ';') {
            if (next?.kind === 'word' && CLOSES.has(next.text)) depth--
            out = breakLine(`${out}${SYNTAX.operator};${ANSI.off}`)
          } else {
            out = `${breakLine(out)}${SYNTAX.operator}${token.text}${ANSI.off} `
          }
          skipSpace = true
          continue
        }
        colour = SYNTAX.operator
        break
      case 'redirect':
        colour = SYNTAX.operator
        break
      case 'paren':
        expectProgram = token.text === '(' || token.text === '{'
        colour = SYNTAX.operator
        break
      case 'comment':
        colour = SYNTAX.comment
        break
      case 'string':
        colour = SYNTAX.string
        expectProgram = false
        break
      case 'variable':
        colour = SYNTAX.variable
        expectProgram = false
        break
      case 'word':
        if (KEYWORDS.has(token.text) && expectProgram) {
          colour = SYNTAX.keyword
          if (isLong && OPENS.has(token.text)) {
            // The body of a loop or an if goes on the next lines, one level in.
            depth++
            out = breakLine(`${out}${colour}${token.text}${ANSI.off}`)
            skipSpace = true
            expectProgram = true
            continue
          }
          // After these a new command starts; after `for`/`case` comes a name, then `in`.
          expectProgram = ['then', 'else', 'elif', 'do', '!', 'time', 'if', 'while', 'until'].includes(token.text)
        } else if (expectProgram && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text)) {
          colour = SYNTAX.variable
        } else if (expectProgram) {
          colour = SYNTAX.program
          expectProgram = false
        } else if (/^--?[A-Za-z0-9]/.test(token.text)) {
          colour = SYNTAX.flag
        } else if (token.text === 'in' || token.text === 'done') {
          colour = SYNTAX.keyword
        }
        break
    }
    out += `${colour}${token.text}${ANSI.off}`
  }
  return out
}

// A lesson as the window shows it (its ⚠ warning goes under the output, in logBlock): the parts (or, collapsed, a link to
// them), then the plain-English line; a blank line keeps it apart from the output below.
const lessonLines = async ($: EngineInterface, run: BashRun, lesson: Lesson): Promise<string[]> => {
  const say = lesson.say && settings.showSummary ? [`  ${ANSI.say}→ ${lesson.say}${ANSI.off}`] : []
  const terms = settings.showParts ? lesson.terms : []
  if (terms.length === 0) return [...say, ...(say.length ? [''] : [])]
  const parts = terms.map(([part, meaning]) => `  ${ANSI.term}${part.padEnd(14)}${ANSI.off} ${ANSI.dim}${meaning}${ANSI.off}`)
  if (settings.explainer === 'expanded') return [...parts, ...say, '']
  const width = Math.min(24, Math.max(...terms.map(([part]) => [...part].length)) + 2)
  const text = [
    `$ ${run.command}`,
    '',
    ...(lesson.risk ? [`⚠ ${lesson.risk}`, ''] : []),
    ...terms.map(([part, meaning]) => `${part.padEnd(width)} ${meaning}`),
    ...(lesson.say ? ['', `→ ${lesson.say}`] : []),
  ].join('\n')
  const file = await saveOutput($, `${run.id}-explained`, `${text}\n`, wrap(parts, await columns($)))
  const link = `  ${ANSI.more}▸ ${terms.length} part${terms.length === 1 ? '' : 's'} explained · ${linkTo(file)}${ANSI.off}`
  return [...say, link, '']
}

// The command as the window shows it: formatted and wrapped, its first lines only when long,
// the whole command saved and linked.
const headerLines = async ($: EngineInterface, run: BashRun, cols: number): Promise<string[]> => {
  const lines = wrap([header(run, cols)], cols)
  if (lines.length <= settings.commandLines) return lines
  const hidden = lines.length - settings.commandLines
  const file = await saveOutput($, `${run.id}-command`, `${run.command}\n`, lines.slice(settings.commandLines))
  return [
    ...lines.slice(0, settings.commandLines),
    `      ${ANSI.more}▸ ${hidden} more line${hidden === 1 ? '' : 's'} of this command · ${linkTo(file)}${ANSI.off}`,
  ]
}

const header = (run: BashRun, cols = width.cols) => {
  const prefix = `${run.n ? `§${run.n} ` : ''}$ `
  return `${mark(run.n)}${ANSI.dim}$${ANSI.off} ${formatCommand(run.command, ' '.repeat(prefix.length + 2), cols)}${run.from ? ` ${ANSI.dim}[${run.from}]${ANSI.off}` : ''}`
}

// The person's settings (the bash-feed rows in /config), set by register from its options.
const settings = {
  teacherLevel: 'beginner' as 'beginner' | 'intermediate' | 'off',
  language: 'English',
  // collapsed: the part-by-part explanation sits behind a ⌘-click link.
  explainer: 'collapsed' as 'collapsed' | 'expanded',
  showWhy: true,
  showSummary: true,
  showRisk: true,
  showFileChanges: true,
  // The part-by-part explanation of each command (shown or behind a link, per explainer).
  showParts: true,
  showOutput: true,
  // The ✓ exit 0 / ✗ exit N line under each command.
  showStatus: true,
  // Output a background command or monitor writes after the call returns.
  showBackground: true,
  // Screen rows of output shown per command, wrapped lines counted; the rest is saved and linked.
  outputRows: 20,
  // Lines of a long command shown before the rest is linked.
  commandLines: 5,
  diffRows: 10,
  openOnStart: true,
  retentionDays: 90,
  // interactive: the window runs bin/viewer.py (click ▸ to expand, ↑/↓ between steps);
  // plain: tail -F, with ⌘-click links.
  viewer: 'interactive' as 'interactive' | 'plain',
}

// The feed window's width in columns: its program writes it beside the log (.cols) when it
// starts and when it is resized; read at most every 15 seconds.
let width = { cols: 100, at: -Infinity }
const columns = async ($: EngineInterface): Promise<number> => {
  const now = Date.now()
  if (now - width.at < 15_000) return width.cols
  const cols = Number(await $.fs.read(`${host.dir}/${sessionId}.cols`).catch(() => ''))
  width = { cols: cols > 20 ? cols : width.cols, at: now }
  return width.cols
}

// Word wrapping: lines the mod writes break at spaces to fit the window, continuation lines
// indented to line up. A word longer than the line (a path, a URL) is left whole.
const ESC_OR_WORD = /\x1b\[[0-9;]*m|\s+|[^\s\x1b]+/g

const wrapLine = (line: string, cols: number, indent: string): string[] => {
  if ([...visible(line)].length <= cols) return [line]
  const lines: string[] = []
  const indentWidth = [...visible(indent)].length
  let current = ''
  let width = 0
  // The colours in effect, so a continuation line starts in the same colour.
  let colour = ''
  for (const part of line.match(ESC_OR_WORD) ?? []) {
    if (part.startsWith('\x1b')) {
      current += part
      colour = part === ANSI.off ? '' : colour + part
      continue
    }
    const partWidth = [...part].length
    if (/^\s+$/.test(part)) {
      // A space that would end the line is dropped with the break.
      if (width + partWidth < cols) {
        current += part
        width += partWidth
      }
      continue
    }
    if (width + partWidth > cols && width > indentWidth) {
      lines.push(current.replace(/\s+$/, '') + ANSI.off)
      current = indent + colour
      width = indentWidth
    }
    current += part
    width += partWidth
  }
  lines.push(current)
  return lines
}

// Where a line's continuation lines start: under an explanation's meaning, after "# "
// for a why line, otherwise two columns in from the line's own indent.
const wrapIndent = (line: string): string => {
  const meaning = line.startsWith(`  ${ANSI.term}`) ? line.indexOf(ANSI.dim) : -1
  if (meaning > 0) return ' '.repeat([...visible(line.slice(0, meaning))].length)
  const plain = visible(line)
  if (plain.startsWith('# ')) return `${ANSI.dim}# `
  // A command continues under its first character, after "§12 $ ".
  const command = /^(§\d+ )?\$ /.exec(plain)
  if (command) return ' '.repeat(command[0].length)
  return ' '.repeat((/^ */.exec(plain)?.[0].length ?? 0) + 2)
}

const wrap = (lines: string[], cols: number) =>
  lines.flatMap(line => line.split('\n')).flatMap(line => wrapLine(line, cols, wrapIndent(line)))

const visible = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')
const rowsOf = (line: string, cols: number) => Math.max(1, Math.ceil([...visible(line)].length / cols))

// The lines that fit in `budget` screen rows; a line too long for what is left is cut.
const fitRows = (lines: string[], cols: number, budget: number): { shown: string[]; hidden: number; rest: string[] } => {
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
    return { shown, hidden: lines.length - i, rest: lines.slice(i) }
  }
  return { shown, hidden: 0, rest: [] }
}

const linesIn = (text: string): string[] => {
  const trimmed = text.replace(/\s+$/, '')
  return trimmed === '' ? [] : trimmed.split('\n')
}

// Saves a command's full output beside the logs and answers the file's absolute path.
// `shown`, when given, is what the window's viewer expands the link into: the hidden lines,
// coloured, saved beside it as .ans.
const saveOutput = async ($: EngineInterface, id: string, text: string, shown?: string[]): Promise<string> => {
  await setup($)
  const file = `${host.dir}/out/${sessionId.slice(0, 8)}-${id}`
  await $.fs.write(`${file}.txt`, text)
  if (shown) await $.fs.write(`${file}.ans`, `${shown.join('\n')}\n`)
  return `${file}.txt`
}

const logBlock = async ($: EngineInterface, run: BashRun, risk?: string): Promise<string> => {
  const out: string[] = []
  const cols = await columns($)
  if (lastLogged !== run.id) out.push(...(await headerLines($, run, cols)))
  const body = !settings.showOutput ? [] : [
    ...linesIn(run.stdout).map(text => `  ${text}`),
    ...linesIn(run.stderr).map(text => `${ANSI.err}  ${text}${ANSI.off}`),
  ]
  // Rows are counted after wrapping, so the link's count is of screen rows hidden.
  const { shown, hidden, rest } = fitRows(wrap(body, cols), cols, settings.outputRows)
  out.push(...shown)
  if (hidden > 0) {
    const file = await saveOutput($, run.id, [run.stdout, run.stderr].filter(text => text.trim()).join('\n'), rest)
    out.push(`${ANSI.more}  ▸ ${hidden} more line${hidden === 1 ? '' : 's'} · ${linkTo(file)}${ANSI.off}`)
  }
  if (run.note) out.push(...wrap([`${ANSI.bad}  ✗ ${run.note}${ANSI.off}`], cols))
  else if (!settings.showStatus) {
    // Nothing to add: without output or status, the command stands alone.
  } else if (run.exitCode === 0) out.push(`${ANSI.ok}  ✓ exit 0${ANSI.off}`)
  else out.push(`${ANSI.bad}  ✗ exit ${run.exitCode ?? '?'}${ANSI.off}`)
  // The teacher's warning sits last, under what the command did.
  if (risk && settings.showRisk) out.push(...wrap([`  ${ANSI.bad}⚠ ${risk}${ANSI.off}`], cols))
  return out.join('\n') + '\n\n'
}

const clearLogs = async ($: EngineInterface, all: boolean) => {
  // Other sessions' logs and outputs go; this session's log is emptied, not deleted,
  // so its open window keeps following it.
  const ran = await queue.then(() => feed($, ['delete', host.dir, sessionId, all ? 'all' : 'others']))
  const [before = '?', after = '?'] = ran.stdout.trim().split(/\s+/)
  if (all) {
    lastLogged = ''
    step = 0
  }
  return all
    ? `Deleted all Bash feed logs (${before} → ${after}).`
    : `Deleted other sessions' Bash feed logs (${before} → ${after}). This session's log stays.`
}

// Changes one of the mod's /config rows, as the menu would; answers why it did not, if it did not.
const setOption = async ($: EngineInterface, field: string, value: string | number | boolean): Promise<string | undefined> => {
  const rows = await $.config.list()
  const row = rows.find(one => one.key.startsWith('bash-feed') && one.key.endsWith(`.${field}`))
  if (!row) return `the ${field} setting was not found in /config`
  const set = await $.config.set({ key: row.key, value })
  return set.deny
}

// Asks one question; resolves to the label picked, or '' when the dialog was dismissed.
const ask = ($: EngineInterface, question: string, options: string[], multiSelect = false) =>
  $.ui.ask(question, { header: 'Bash feed', options, ...(multiSelect ? { multiSelect: true as const } : {}) }).catch(() => '')

const onOff = (on: boolean) => (on ? 'on' : 'off')

// The settings submenu: four groups, each a question or two. Answers what changed.
const settingsMenu = async ($: EngineInterface): Promise<string> => {
  const group = await ask($, 'Which settings?', ["What's shown", 'Explanations', 'Output length', 'Window and logs'])
  const done = async (field: string, value: string | number | boolean, said: string) => {
    const denied = await setOption($, field, value)
    return denied ? `Not changed: ${denied}.` : said
  }
  if (group === "What's shown") {
    const BEFORE = { showWhy: 'Why line', showParts: 'Snippet explainers', showSummary: 'Plain-English line', showRisk: 'Risk warnings' } as const
    const AFTER = { showOutput: 'Command output', showStatus: 'Exit status', showBackground: 'Background output', showFileChanges: 'File changes' } as const
    const chosen: string[] = []
    for (const [where, SHOWN] of [['with each command', BEFORE], ['after each command', AFTER]] as const) {
      const keys = Object.keys(SHOWN) as (keyof typeof SHOWN)[]
      const now = keys.map(key => `${SHOWN[key]} ${onOff(settings[key])}`).join(' · ')
      const picked = await ask($, `Shown ${where} (the command itself always is). Pick what to show; the rest is hidden. Now: ${now}.`, Object.values(SHOWN), true)
      if (!picked) return chosen.length ? `Bash feed now shows: ${chosen.join(', ')}.` : 'Bash feed settings unchanged.'
      const names = picked.split(',').map(one => one.trim())
      for (const key of keys) {
        const denied = await setOption($, key, names.includes(SHOWN[key]))
        if (denied) return `Not changed: ${denied}.`
      }
      chosen.push(...names)
    }
    return `Bash feed now shows: the command${chosen.length ? `, ${chosen.join(', ')}` : ' only'}.`
  }
  if (group === 'Explanations') {
    const toggle = settings.explainer === 'collapsed' ? 'Show every part in the window' : 'Collapse behind a link'
    const what = await ask($, `Explanations: ${settings.teacherLevel}, in ${settings.language}, ${settings.explainer}. Change:`, ['Level', 'Language', toggle])
    if (!what) return 'Bash feed settings unchanged.'
    if (what === toggle) {
      const layout = settings.explainer === 'collapsed' ? 'expanded' : 'collapsed'
      return done('explainer', layout, layout === 'collapsed' ? 'Explanations are collapsed behind a link.' : 'Explanations show every part.')
    }
    const picked = what === 'Language' ? 'Change language' : await ask($, `Explanations are ${settings.teacherLevel}. Change to:`, ['Beginner', 'Intermediate', 'Off (no Haiku calls)'])
    if (!picked) return 'Bash feed settings unchanged.'
    if (picked === 'Change language') {
      const language = (await ask($, `Explanations are in ${settings.language}. Which language? (Other: type any)`, ['English', 'Spanish', 'French', 'German'])).trim()
      return language ? done('language', language, `Explanations will be in ${language}.`) : 'Bash feed settings unchanged.'
    }
    const level = picked.startsWith('Off') ? 'off' : picked.toLowerCase()
    return done('teacherLevel', level, `Explanations: ${level}.`)
  }
  if (group === 'Output length') {
    const which = await ask($, `Lines shown before the "more lines" link. Now: commands ${settings.commandLines}, output ${settings.outputRows}, diffs ${settings.diffRows}. Change:`, ['Command lines shown', 'Output rows per command', 'Diff rows per file change'])
    if (!which) return 'Bash feed settings unchanged.'
    const field = which.startsWith('Command') ? 'commandLines' : which.startsWith('Output') ? 'outputRows' : 'diffRows'
    const answer = await ask($, `${which}? (Other: type a number)`, field === 'commandLines' ? ['3', '5', '10', '20'] : ['10', '20', '40', '80'])
    const rows = Math.floor(Number(answer))
    if (!answer || !Number.isFinite(rows) || rows < (field === 'diffRows' ? 0 : 1)) return 'Bash feed settings unchanged.'
    return done(field, rows, `${which}: ${rows}.`)
  }
  if (group === 'Window and logs') {
    const viewer = settings.viewer === 'interactive' ? 'Plain window (⌘-click links)' : 'Interactive window (click to expand)'
    const picked = await ask($, `Window: ${settings.viewer}, opens at session start: ${onOff(settings.openOnStart)}. Logs kept for: ${settings.retentionDays ? `${settings.retentionDays} days` : 'ever'}. Change:`, [
      viewer,
      settings.openOnStart ? "Don't open the window at start" : 'Open the window at start',
      'How long to keep logs',
    ])
    if (!picked) return 'Bash feed settings unchanged.'
    if (picked === viewer) {
      const next = settings.viewer === 'interactive' ? 'plain' : 'interactive'
      return done('viewer', next, `The window will be ${next}; /bash-feed close, then /bash-feed window to reopen it.`)
    }
    if (picked !== 'How long to keep logs') {
      return done('openOnStart', !settings.openOnStart, `The window will ${settings.openOnStart ? 'not open' : 'open'} when a session starts.`)
    }
    const KEEP = { '30 days': 30, '90 days': 90, '1 year': 365, Forever: 0 } as Record<string, number>
    const kept = await ask($, 'Keep logs for how long? (Other: type a number of days)', Object.keys(KEEP))
    const days = kept in KEEP ? KEEP[kept]! : Math.floor(Number(kept))
    if (!kept || !Number.isFinite(days) || days < 0) return 'Bash feed settings unchanged.'
    return done('retentionDays', days, days ? `Logs will be kept for ${days} days.` : 'Logs will be kept forever.')
  }
  return 'Bash feed settings unchanged.'
}

const MENU = {
  on: 'Turn on',
  off: 'Turn off',
  window: 'Window',
  settings: 'Settings',
  delete: 'Delete logs',
} as const

// Wipes the window's screen and scrollback: the escape codes go through the log, which the
// window prints as it grows.
const clearWindow = ($: EngineInterface) =>
  enqueue(async () => {
    lastLogged = ''
    await appendLog($, `\x1b[H\x1b[2J\x1b[3J${ANSI.dim}── cleared · ${new Date().toLocaleTimeString()} ──${ANSI.off}\n\n`)
  })

// Logs one shell command or file edit around the call itself.
const logCall = async ($: EngineInterface, e: ToolCallInput, next: (e: ToolCallInput) => Promise<ToolCallResult>): Promise<ToolCallResult> => {
  if (!enabled) return next(e)
  if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') return logEdit($, e, next)
  const command = e.tool === 'Bash' ? e.command : e.tool === 'Monitor' ? e.command : undefined
  if (!command) return next(e)
  const description = e.tool === 'Bash' || e.tool === 'Monitor' ? e.description?.trim() : undefined
  const id = e.tool_use_id
  if (!sessionId) sessionId = await $.session.id()
  if (!(await setup($))) return next(e)
  const tags = [e.tool === 'Monitor' && 'monitor', e.agentId && 'subagent'].filter(Boolean)
  const run: BashRun = { id, n: ++step, command, isDone: false, stdout: '', stderr: '', ...(tags.length ? { from: tags.join(', ') } : {}) }
  await update($, runs, list => [...list, run].slice(-MAX_RUNS))
  const lesson = lessonFor($, run.command)
  enqueue(async () => {
    const lines = await lessonLines($, run, await lesson)
    lastLogged = id
    // Claude's own one-line reason for the command, written as a shell comment.
    const why = description && settings.showWhy ? [`${ANSI.dim}# ${description}${ANSI.off}`] : []
    const cols = await columns($)
    await appendLog($, [...wrap(why, cols), ...(await headerLines($, run, cols)), ...wrap(lines, cols), ''].join('\n'))
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
    const block = await logBlock($, { ...run, ...done, isDone: true }, (await lesson).risk)
    lastLogged = id
    await appendLog($, block)
    // A background command or monitor keeps writing after the call returns: a detached
    // watcher streams its task file into the log until it ends.
    if (taskId && settings.showBackground) {
      const short = command.replace(/\s+/g, ' ')
      const label = `${short.length > 50 ? `${short.slice(0, 50)}…` : short} (task ${taskId})`
      await feed($, ['task', logFile(), taskId, label, String(await columns($))])
    }
  })

  return ran
}

export const register: Register = (on, options) => {
  const flag = (key: keyof typeof settings, fallback: boolean) => (typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback)
  const count = (key: string, fallback: number, min: number) => {
    const value = Math.floor(Number(options[key]))
    return Number.isFinite(value) ? Math.max(min, value) : fallback
  }
  const level = String(options.teacherLevel ?? 'beginner')
  Object.assign(settings, {
    teacherLevel: level === 'intermediate' || level === 'off' ? level : 'beginner',
    language: String(options.language ?? '').trim() || 'English',
    explainer: options.explainer === 'expanded' ? 'expanded' : 'collapsed',
    showWhy: flag('showWhy', true),
    showSummary: flag('showSummary', true),
    showRisk: flag('showRisk', true),
    showFileChanges: flag('showFileChanges', true),
    showParts: flag('showParts', true),
    showOutput: flag('showOutput', true),
    showStatus: flag('showStatus', true),
    showBackground: flag('showBackground', true),
    outputRows: count('outputRows', 20, 1),
    commandLines: count('commandLines', 5, 1),
    diffRows: count('diffRows', 10, 0),
    openOnStart: flag('openOnStart', true),
    retentionDays: count('retentionDays', 90, 0),
    viewer: options.viewer === 'plain' ? 'plain' : 'interactive',
  })
  const retentionDays = settings.retentionDays

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bash-feed',
      description: 'Turn the Bash feed on or off, change its settings, reopen its window, or clear its logs',
      argumentHint: '[on|off|window|clear|close|settings|delete|delete all]',
    })
    sessionId = await $.session.id()
    enabled = (await $.store.get('enabled')) !== false
    if (!(await setup($))) return next(e)
    // Step numbers carry on from the highest already in this session's log.
    step = Number((await feed($, ['last-step', logFile()])).stdout.trim()) || 0
    // Session logs and saved outputs older than the retention setting are deleted (0 keeps all).
    if (retentionDays > 0) enqueue(() => feed($, ['clean', host.dir, String(retentionDays)]))
    if (e.isInteractive && enabled && settings.openOnStart) {
      enqueue(async () => {
        // The header goes in once per session file, not again on each reload.
        await feed($, ['init', logFile()], `${ANSI.dim}── session ${sessionId.slice(0, 8)} · ${new Date().toLocaleString()} ──${ANSI.off}\n\n`)
        await openWindow($, true)
      })
    }

    return next(e)
  })

  on('command.run', { command: 'bash-feed' }, async ($, e) => {
    if (!sessionId) sessionId = await $.session.id()
    if (!(await setup($))) return { text: 'The Bash feed needs Python 3, which was not found.' }
    let choice = e.args.trim().toLowerCase()
    if (!choice) {
      // No argument: a menu, like /permissions.
      const options = enabled ? [MENU.off, MENU.window, MENU.settings, MENU.delete] : [MENU.on, MENU.settings, MENU.delete]
      const size = (await feed($, ['size', host.dir])).stdout.trim() || '0B'
      const picked = await $.ui
        .ask(`The Bash feed is ${enabled ? 'on' : 'off'} (logs use ${size}). What do you want to do?`, { header: 'Bash feed', options })
        .catch(() => '')
      choice = (Object.keys(MENU) as (keyof typeof MENU)[]).find(key => MENU[key] === picked) ?? ''
      if (choice === 'window') {
        const which = await ask($, 'The feed window:', ['Reopen it', 'Clear it', 'Close it'])
        choice = which === 'Clear it' ? 'clear' : which === 'Close it' ? 'close' : which ? 'window' : ''
      }
      if (choice === 'delete') {
        const which = await ask($, 'Delete which logs?', ["Other sessions' logs", 'All logs, this session too'])
        choice = which.startsWith('All') ? 'delete all' : which ? 'delete' : ''
      }
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
      case 'settings':
        return { text: await settingsMenu($) }
      case 'pane':
        await $.ui.open({ id: PANE, title: 'Bash feed' })
        return { text: 'Bash feed pane opened.' }
      case 'clear':
        clearWindow($)
        await queue
        return { text: 'Bash feed window cleared.' }
      case 'close':
        await queue.then(() => closeWindow($))
        return { text: 'Bash feed window closed. Reopen it with /bash-feed window.' }
      case 'delete':
        return { text: await clearLogs($, false) }
      case 'delete all':
        return { text: await clearLogs($, true) }
      default:
        return { text: 'Use /bash-feed with on, off, window, clear, close, settings, pane, delete or delete all, or with nothing for the menu.' }
    }
  })

  // Every shell command Claude sends: Bash calls and Monitor watches, from the main
  // loop and from subagents alike.
  on('tool.call', async ($, e, next) => {
    // A fault in the feed never stops Claude's command: the call runs once, logged or not.
    let ran: Promise<ToolCallResult> | undefined
    const once = (input: ToolCallInput) => (ran ??= next(input))
    return logCall($, e, once).catch(() => ran ?? next(e))
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
