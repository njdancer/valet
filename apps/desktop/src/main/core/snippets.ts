// Client setup snippets. They launch the stdio bridge, which reads the endpoint's URL and token from
// its own 0600 config file, so no snippet ever contains the token.

import type { ClientKind, ClientSnippet } from '../../shared/api'

/** The bridge as a command line: an executable and its arguments, the config path last. */
export interface BridgeCommand {
  readonly command: string
  readonly args: readonly string[]
}

/** POSIX shell quoting, for a line the person pastes into a terminal. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
}

export function clientSnippets(serverName: string, bridge: BridgeCommand): ClientSnippet[] {
  const claudeCode = ['claude', 'mcp', 'add', serverName, '--', bridge.command, ...bridge.args].map(
    shellQuote,
  )
  const desktop = { mcpServers: { [serverName]: { command: bridge.command, args: [...bridge.args] } } }
  return [
    { client: 'claude-code', text: claudeCode.join(' ') },
    { client: 'claude-desktop', text: JSON.stringify(desktop, null, 2) },
  ]
}

export function snippetFor(snippets: readonly ClientSnippet[], client: ClientKind): string | null {
  return snippets.find((s) => s.client === client)?.text ?? null
}
