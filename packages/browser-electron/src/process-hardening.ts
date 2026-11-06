// Process-wide Chromium switches that close side channels webRequest can't see. They must be
// appended before Electron's app is ready, so the desktop app calls this first thing.

/** Anything with Electron's app.commandLine shape, so that this module needn't import Electron. */
export interface CommandLineHost {
  readonly commandLine: { appendSwitch(name: string, value?: string): void }
}

export const CHROMIUM_SWITCHES: readonly (readonly [string, string])[] = [
  // DNS prefetch is a Blink setting with no per-session API. A prefetched hostname can carry data
  // out through DNS, which no request filter sees. The tool partition also sends
  // X-DNS-Prefetch-Control: off on every response; this covers <link rel=dns-prefetch> too.
  ['blink-settings', 'dnsPrefetchingEnabled=false'],
]

export function hardenProcess(app: CommandLineHost): void {
  for (const [name, value] of CHROMIUM_SWITCHES) app.commandLine.appendSwitch(name, value)
}
