export type BashRun = {
  id: string
  command: string
  isDone: boolean
  stdout: string
  stderr: string
  exitCode?: number
  note?: string
  /** Where the command came from when not a main-loop Bash call: monitor, subagent. */
  from?: string
}

declare module 'claude-code' {
  interface PluginState {
    'bash-feed': { runs: Shaped<BashRun[]> }
  }
}
