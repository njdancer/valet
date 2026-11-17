// The session driver of an adapter that opens no pages (docs/adapter-kinds.md): an `http` adapter
// reaches the network only through ctx.http and the egress broker. There is no browser to hold to
// a run policy, no partition to log in with and no cookies to copy, so every page capability
// refuses with `tool-run/not-granted` and the run hooks do nothing.

import type { AuthPage, SessionDriver, ToolPage } from '@valet/core'
import { ValetError } from '@valet/core'

const refuse = (): Promise<never> => Promise.reject(new ValetError('tool-run', 'not-granted'))

/** What tool code's ctx.page is in an adapter with no browser. */
export const NO_PAGE: ToolPage = Object.freeze({
  goto: refuse,
  currentUrl: () => '',
  click: refuse,
  fill: refuse,
  extract: refuse,
  evaluate: refuse,
  fetch: refuse,
})

export function noBrowserDriver(): SessionDriver {
  return {
    openAuthPage: (): Promise<AuthPage> => refuse(),
    toolPage: async () => NO_PAGE,
    handoff: refuse,
    sessionSecrets: async () => [],
    cookieNames: async () => [],
    beginRun: () => {},
    unlockIrreversible: () => {},
    endRun: () => {},
    close: async () => {},
  }
}
