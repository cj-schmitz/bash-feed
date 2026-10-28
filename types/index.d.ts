export type BashRun = {
  id: string
  command: string
  isDone: boolean
  stdout: string
  stderr: string
  exitCode?: number
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'bash-feed': { runs: Shaped<BashRun[]> }
  }
}
