// The command-line and environment check a packaged app runs first, before anything else in main
// (electron/guard.ts). The fuses close Node's own ways in; Chromium's and Electron's switches
// (--remote-debugging-port, --host-resolver-rules, --proxy-server, --js-flags, --user-data-dir, …)
// have no fuse, and any local process can start the signed app with them. So the app takes an
// allowlist of argv shapes, never a blocklist of switch names: Chromium also reads single-dash and
// `=value` spellings a blocklist would miss. See docs/release-and-updates.md, "Command-line
// switches".

export type ArgvClass =
  | { readonly mode: 'app' }
  | { readonly mode: 'bridge'; readonly config: string }
  | { readonly mode: 'refuse' }

/**
 * The process-serial argument older macOS added to a LaunchServices launch. Kept as one exact
 * shape, in case current macOS still passes it (not verified on macOS 27).
 */
const PROCESS_SERIAL = /^-psn_\d+_\d+$/

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * Sorts argv (process.argv: the executable first) into one of these shapes, and refuses anything
 * else:
 * - the executable alone, or with macOS's process-serial argument: a normal launch;
 * - the executable, `--mcp-bridge` and one absolute path: bridge mode;
 * - the executable and exactly `extra`, in order: the smoke build's own launch (null otherwise).
 */
export function classifyArgv(argv: readonly string[], extra: readonly string[] | null = null): ArgvClass {
  if (argv.length === 0) return { mode: 'refuse' }
  const rest = argv.slice(1)
  if (rest.length === 0) return { mode: 'app' }
  if (rest.length === 1 && PROCESS_SERIAL.test(rest[0] as string)) return { mode: 'app' }
  if (extra !== null && extra.length > 0 && sameList(rest, extra)) return { mode: 'app' }
  if (rest.length === 2 && rest[0] === '--mcp-bridge') {
    const config = rest[1] as string
    if (config.startsWith('/') && !CONTROL.test(config)) return { mode: 'bridge', config }
  }
  return { mode: 'refuse' }
}

/**
 * Environment variables Electron or Node may read at start-up that a packaged app still accepts.
 * NODE_USE_SYSTEM_CA only adds the system's trusted roots. Every other ELECTRON_* or NODE_* name is
 * refused: ELECTRON_RUN_AS_NODE and NODE_OPTIONS are fused off already (and Electron 44 removes
 * NODE_OPTIONS and NODE_EXTRA_CA_CERTS from the environment itself with the NodeOptions fuse off, as
 * the package smoke shows), and the rest (ELECTRON_ENABLE_LOGGING, ELECTRON_LOG_FILE,
 * NODE_TLS_REJECT_UNAUTHORIZED, …) log, trust or change what the app does.
 */
export const ALLOWED_ENV = ['NODE_USE_SYSTEM_CA'] as const

/** The names in `env` a packaged app refuses to start with, sorted. */
export function refusedEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((name) => /^(ELECTRON|NODE)_/i.test(name) && !(ALLOWED_ENV as readonly string[]).includes(name))
    .sort()
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}
